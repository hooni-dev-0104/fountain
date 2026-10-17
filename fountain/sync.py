"""Atomic, actor-bound receipts for replaying offline resource mutations.

The caller supplies fresh authentication inside each SQLite writer transaction and
normal authorized dispatch. This service never bypasses those route checks and
never returns resource bodies or private receipt digests.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid

from .core import APIError, require

KINDS = {"page.create", "page.patch", "row.create", "row.patch", "row.delete"}
PAGE_FIELDS = {"title", "icon", "cover", "favorite"}
ROW_FIELDS = {"parent_row_id", "depends_on"}
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,160}\Z")


class BindingError(APIError):
    """A changed authentication/workspace binding invalidates the whole batch."""


class SyncService:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _id(value):
        require(isinstance(value, str) and value not in {".", ".."} and IDENTIFIER.fullmatch(value) is not None, "Invalid sync identifier")
        return value

    @staticmethod
    def _resource_id(value):
        # Entity IDs are opaque data, unlike ASCII operation identifiers. Paths
        # below are passed directly to dispatch and are never URI-parsed again.
        require(isinstance(value, str) and 0 < len(value) <= 160 and bool(value.strip())
                and value not in {".", ".."} and not any(char in "/\\" or ord(char) < 32
                    or 127 <= ord(char) <= 159 for char in value), "Invalid sync resource identifier")
        try: value.encode("utf-8")
        except UnicodeEncodeError: raise APIError(400, "Invalid Unicode resource identifier")
        return value

    @staticmethod
    def receipt_id(actor_id, operation_id):
        return hashlib.sha256(json.dumps([actor_id, operation_id], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

    def _receipt(self, actor_id, operation_id, workspace_id):
        receipt = self.store.get("sync_receipt", self.receipt_id(actor_id, operation_id))
        return receipt if receipt and receipt.get("actor_id") == actor_id and receipt.get("workspace_id") == workspace_id else None

    def _context(self, body, factory, expected_actor=None):
        context = factory()
        access = context.get("access") if isinstance(context, dict) else None
        if access is None or not access.active:
            raise BindingError(401, "Authentication required")
        if context.get("workspace_id") != body["workspace_id"]:
            raise BindingError(409, "Workspace changed; preserve your offline changes")
        if context.get("session_binding") != body["session_binding"]:
            raise BindingError(403, "Login changed; preserve changes under their original session")
        if expected_actor is not None and access.member_id != expected_actor:
            raise BindingError(403, "Offline changes belong to another member")
        return context

    def _validate(self, operation):
        require(isinstance(operation, dict), "Sync operation must be an object")
        require(set(operation) <= {"id", "kind", "target_id", "database_id", "depends_on", "body", "base", "document_epoch", "base_rows"}, "Unsupported sync operation fields")
        self._id(operation.get("id"))
        self._resource_id(operation.get("target_id"))
        kind = operation.get("kind")
        require(isinstance(kind, str) and kind in KINDS, "Unsupported sync operation kind")
        if kind.startswith("row."): self._resource_id(operation.get("database_id"))
        dependencies = operation.get("depends_on", [])
        require(isinstance(dependencies, list) and len(dependencies) <= 50, "Invalid sync dependencies")
        for identity in dependencies:
            self._id(identity)
            require(identity != operation["id"], "Operation cannot depend on itself")
        require(isinstance(operation.get("body", {}), dict), "Sync mutation body must be an object")
        require(isinstance(operation.get("base", {}), dict), "Sync base must be an object")
        return self._digest(operation)

    @staticmethod
    def _digest(operation):
        try:
            canonical = json.dumps(operation, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
            raise APIError(400, "Sync operation contains invalid JSON")
        return hashlib.sha256(canonical).hexdigest()

    @staticmethod
    def _call(dispatch, method, path, body, context):
        status, result = dispatch(method, path, copy.deepcopy(body), context)
        if not 200 <= status < 300:
            raise APIError(status, "Resource mutation was rejected")
        return result

    @staticmethod
    def _compare(touched, base, current, label):
        require(isinstance(base, dict) and all(key in base for key in touched), f"Missing {label} base values")
        for key in touched:
            require(current.get(key) == base[key], f"{label} changed while offline", 409)

    def _database(self, operation, dispatch, context):
        identity = operation["database_id"]
        detail = self._call(dispatch, "GET", f"/api/databases/{identity}", {}, context)
        require(isinstance(detail, dict) and isinstance(detail.get("database"), dict) and isinstance(detail.get("rows"), list), "Invalid database projection", 500)
        return detail

    @staticmethod
    def _schema(properties, base, database):
        schema = base.get("schema", {})
        require(isinstance(properties, dict) and isinstance(schema, dict), "Invalid property schema base")
        current = {prop["id"]: prop for prop in database.get("properties", [])}
        for key in properties:
            require(key in schema and isinstance(schema[key], dict), "Missing touched property schema")
            fields=("type","generation","limit","default","initial_default")
            equal=key in current and (all(current[key].get(field)==schema[key].get(field) for field in fields) if current[key].get("type")=="owner" else current[key]==schema[key])
            require(equal, "Property schema changed while offline", 409)
            require(current[key].get("type") not in {"formula", "rollup", "verification"}, "Computed properties cannot be assigned")

    def _execute(self, operation, context, dispatch):
        kind, target = operation["kind"], operation["target_id"]
        body, base = copy.deepcopy(operation.get("body", {})), operation.get("base", {})
        access = context["access"]
        if kind == "page.create":
            require(set(body) <= {"id", "title", "icon", "cover", "parent_id", "teamspace_id", "permissions"}, "Unsupported offline page creation fields")
            require(body.get("id", target) == target, "Page id does not match sync target")
            epoch = operation.get("document_epoch")
            try: uuid.UUID(epoch)
            except (TypeError, ValueError, AttributeError): raise APIError(400, "Page creation requires a document epoch UUID")
            require(self.store.get("page", target) is None, "Page id already exists", 409)
            self._call(dispatch, "POST", "/api/pages", {**body, "id": target}, context)
            created = self.store.get("page", target)
            require(created is not None and not created.get("blocks"), "Offline page must be created empty", 409)
            from .crdt import seed_state
            self.store.put("collaboration", {"id": target, "epoch": epoch, "seq": 0, "state": seed_state([])})
        elif kind == "page.patch":
            require(body and set(body) <= PAGE_FIELDS, "Unsupported offline page fields")
            page = access.require_resource("page", target, 3)
            require(not page.get("locked") and not page.get("archived"), "Page is locked or archived", 423)
            self._compare(body, base.get("fields"), page, "Page metadata")
            self._call(dispatch, "PATCH", f"/api/pages/{target}", body, context)
        else:
            detail = self._database(operation, dispatch, context)
            database, database_id = detail["database"], operation["database_id"]
            if kind == "row.create":
                require(set(body) <= {"id", "properties", *ROW_FIELDS}, "Unsupported offline row creation fields")
                require(body.get("id", target) == target, "Row id does not match sync target")
                require(self.store.get("row", target) is None, "Row id already exists", 409)
                self._schema(body.get("properties", {}), base, database)
                self._call(dispatch, "POST", f"/api/databases/{database_id}/rows", {**body, "id": target}, context)
                require(self.store.get("row", target) is not None, "Row creation did not preserve its client id", 409)
            else:
                raw = access.require_resource("row", target, 3)
                require(raw.get("database_id") == database_id, "Row not found", 404)
                visible = next((row for row in detail["rows"] if row.get("id") == target and row.get("access_level", 1) > 0), None)
                require(visible is not None, "Row not found", 404)
                if kind == "row.patch":
                    require(body and set(body) <= {"properties", *ROW_FIELDS}, "Unsupported offline row fields")
                    properties = body.get("properties", {})
                    self._schema(properties, base, database)
                    self._compare(properties, base.get("properties", {}), visible.get("properties", {}), "Row properties")
                    fields = {key: value for key, value in body.items() if key in ROW_FIELDS}
                    self._compare(fields, base.get("fields", {}), {"parent_row_id": visible.get("parent_row_id"), "depends_on": visible.get("depends_on", [])}, "Task links")
                    self._call(dispatch, "PATCH", f"/api/databases/{database_id}/rows/{target}", body, context)
                else:
                    require(not body, "Offline row deletion body must be empty")
                    self._delete_base(operation, access, context["workspace_id"])
                    self._call(dispatch, "DELETE", f"/api/databases/{database_id}/rows/{target}", {}, context)
        resource_kind = "page" if kind.startswith("page.") else "row"
        resource = self.store.get(resource_kind, target)
        result = {"id": operation["id"], "status": "applied", "http_status": 201 if kind.endswith("create") else 200,
                  "resource_id": target, "data_revision": self.store.meta("_entity_revision", 0)}
        if resource:
            for key in ("updated_at", "revision"):
                if key in resource: result[key] = resource[key]
        return result

    def _delete_base(self, operation, access, workspace_id):
        from .tasks import TaskGraph
        rows = TaskGraph(self.store).descendants(operation["database_id"], operation["target_id"])
        require(all(access.can("row", row, 3) for row in rows), "Cannot delete unreadable or uneditable subitems", 403)
        bases = operation.get("base_rows")
        require(isinstance(bases, dict) and bases, "Offline deletion requires the complete subtree base")
        for identity in bases: self._resource_id(identity)
        require(set(bases) == {row["id"] for row in rows}, "Task subtree changed while offline", 409)
        for row in rows:
            base = bases[row["id"]]
            require(isinstance(base, dict) and set(base) <= {"updated_at", "after_operation"} and isinstance(base.get("updated_at"), str), "Invalid subtree base")
            expected = base["updated_at"]
            if base.get("after_operation"):
                identity = self._id(base["after_operation"])
                receipt = self._receipt(access.member_id, identity, workspace_id)
                previous = receipt.get("result", {}) if receipt else {}
                require(receipt is not None and receipt.get("kind") in {"row.create", "row.patch"}
                        and receipt.get("database_id") == operation["database_id"]
                        and previous.get("status") == "applied" and previous.get("resource_id") == row["id"]
                        and isinstance(previous.get("updated_at"), str), "Own preceding operation receipt is unavailable", 409)
                expected = previous["updated_at"]
            require(row.get("updated_at") == expected, "Subitem changed while offline", 409)

    @staticmethod
    def _failure(identity, error):
        status = "conflict" if error.status in {409, 410, 423} else "denied" if error.status in {401, 403, 404} else "deferred" if error.status >= 500 else "invalid"
        return {"id": identity, "status": status, "http_status": error.status, "error": error.message}

    def apply(self, body, context_factory, dispatch_callback):
        """Call without an outer transaction, so each accepted operation commits."""
        require(isinstance(body, dict) and set(body) <= {"workspace_id", "session_binding", "operations"}, "Invalid sync request")
        require(isinstance(body.get("workspace_id"), str) and isinstance(body.get("session_binding"), str), "Sync requires workspace and session bindings")
        operations = body.get("operations")
        require(isinstance(operations, list) and len(operations) <= 50, "Send at most 50 offline mutations")
        with self.store.transaction():
            initial = self._context(body, context_factory)
        actor, workspace = initial["access"].member_id, initial["workspace_id"]
        results, processed = [], {}
        for operation in operations:
            identity = operation.get("id") if isinstance(operation, dict) and isinstance(operation.get("id"), str) else None
            try:
                with self.store.transaction():
                    context = self._context(body, context_factory, actor)
                    require(isinstance(operation, dict), "Sync operation must be an object")
                    self._id(operation.get("id"))
                    receipt = self._receipt(actor, operation["id"], workspace)
                    if receipt:
                        require(receipt.get("digest") == self._digest(operation), "Operation id was reused with different content", 409)
                        result = copy.deepcopy(receipt["result"])
                    else:
                        digest = self._validate(operation)
                        for dependency in operation.get("depends_on", []):
                            prior = processed.get(dependency)
                            if prior is None:
                                saved = self._receipt(actor, dependency, workspace)
                                prior = saved.get("result") if saved else None
                            require(prior and prior.get("status") == "applied", "A preceding offline operation has not been applied", 425)
                        result = self._execute(operation, context, dispatch_callback)
                        self.store.put("sync_receipt", {"id": self.receipt_id(actor, operation["id"]), "actor_id": actor,
                            "workspace_id": workspace, "operation_id": operation["id"], "kind": operation["kind"],
                            "database_id": operation.get("database_id"), "digest": digest, "result": result})
            except APIError as error:
                if isinstance(error, BindingError) or error.status == 401: raise
                result = self._failure(identity, error)
                if error.status == 425: result["status"] = "deferred"
            results.append(result)
            if identity is not None: processed[identity] = result
        return {"workspace_id": workspace, "current_member_id": actor, "session_binding": initial["session_binding"],
                "data_revision": self.store.meta("_entity_revision", 0), "results": results}
