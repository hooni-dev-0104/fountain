import copy
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fountain.access import Access
from fountain.core import APIError, Store
from fountain.server import Application
from fountain.sync import SyncService


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.app = Application(self.store)
        self.sync = SyncService(self.store)
        self.actor, self.binding = "local", "test-session-binding"
        self.workspace = self.store.meta("workspace_id")
        self.schema = {p["id"]: p for p in self.store.get("database", "projects")["properties"]}

    def tearDown(self):
        self.store.close()

    def context(self):
        return {"access": Access(self.store, self.store.get("member", self.actor)), "workspace_id": self.workspace, "session_binding": self.binding}

    def dispatch(self, method, path, body, context):
        return self.app.dispatch(method, path, body, {}, principal=context["access"].principal)

    def request(self, operations):
        return {"workspace_id": self.workspace, "session_binding": self.binding, "operations": operations}

    def apply(self, operations, dispatch=None):
        return self.sync.apply(self.request(operations), self.context, dispatch or self.dispatch)

    def page(self, operation="page-op", target="offline-page", **body):
        return {"id": operation, "kind": "page.create", "target_id": target, "document_epoch": str(uuid.uuid4()), "body": {"title": "오프라인 문서", **body}}

    def row(self, operation="row-op", target="offline-row", **values):
        properties = {"name": "오프라인 행", **values}
        return {"id": operation, "kind": "row.create", "target_id": target, "database_id": "projects", "body": {"properties": properties},
                "base": {"schema": {key: copy.deepcopy(self.schema[key]) for key in properties}}}

    def patch_row(self, target, values, base_values, operation="patch-op"):
        return {"id": operation, "kind": "row.patch", "target_id": target, "database_id": "projects", "body": {"properties": values},
                "base": {"properties": base_values, "schema": {key: copy.deepcopy(self.schema[key]) for key in values}}}

    def test_page_create_preserves_client_epoch_and_receipt_replays_without_reset(self):
        operation = self.page()
        result = self.apply([operation])["results"][0]
        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["resource_id"], operation["target_id"])
        document = self.store.get("collaboration", operation["target_id"])
        self.assertEqual(document["epoch"], operation["document_epoch"])
        self.assertEqual(document["seq"], 0)
        self.assertEqual(self.store.get("page", operation["target_id"])["blocks"], [])
        original_document = copy.deepcopy(document)
        self.assertEqual(self.apply([operation])["results"][0], result)
        self.assertEqual(self.store.get("collaboration", operation["target_id"]), original_document)
        collision = self.page("different-op", operation["target_id"])
        self.assertEqual(self.apply([collision])["results"][0]["status"], "conflict")
        self.assertEqual(self.store.get("collaboration", operation["target_id"]), original_document)
        receipt = self.store.list("sync_receipt")[0]
        self.assertNotIn("body", receipt)
        self.assertNotIn("title", json.dumps(receipt))
        self.assertNotIn("digest", result)
        self.assertIn("data_revision", result)

    def test_page_metadata_touched_base_merges_independent_change_and_rejects_lock(self):
        self.apply([self.page()])
        page = self.store.get("page", "offline-page")
        page["icon"] = "🏠"
        self.store.put("page", page)
        operation = {"id": "title-op", "kind": "page.patch", "target_id": "offline-page", "body": {"title": "로컬 제목"}, "base": {"fields": {"title": page["title"]}}}
        self.assertEqual(self.apply([operation])["results"][0]["status"], "applied")
        self.assertEqual(self.store.get("page", "offline-page")["icon"], "🏠")
        conflict = {**operation, "id": "stale-title", "body": {"title": "stale"}}
        self.assertEqual(self.apply([conflict])["results"][0]["status"], "conflict")
        page = self.store.get("page", "offline-page")
        page["locked"] = True
        self.store.put("page", page)
        locked = {**operation, "id": "locked-title", "base": {"fields": {"title": page["title"]}}}
        self.assertEqual(self.apply([locked])["results"][0]["http_status"], 423)
        unsupported = {**operation, "id": "bad-field", "body": {"archived": True}}
        self.assertEqual(self.apply([unsupported])["results"][0]["status"], "invalid")

    def test_dependency_order_and_previous_receipts_are_actor_scoped(self):
        parent = self.page("parent-op", "parent-page")
        child = self.page("child-op", "child-page", parent_id="parent-page")
        child["depends_on"] = ["parent-op"]
        first = self.apply([child, parent])["results"]
        self.assertEqual([result["status"] for result in first], ["deferred", "applied"])
        self.assertEqual(self.apply([child])["results"][0]["status"], "applied")
        self.store.put("member", {"id": "family", "name": "Family", "email": "family@example.com", "role": "member"})
        self.actor = "family"
        other = self.page("other-child-op", "other-child")
        other["depends_on"] = ["parent-op"]
        self.assertEqual(self.apply([other])["results"][0]["status"], "deferred")
        self.assertIsNone(self.store.get("page", "other-child"))

    def test_row_create_ids_retries_automations_and_id_reuse_conflict(self):
        self.app.dispatch("POST", "/api/automations", {"name": "우선순위", "database_id": "projects", "trigger": "row.created",
            "actions": [{"type": "set_property", "property_id": "priority", "value": "높음"}]}, {})
        operation = self.row()
        result = self.apply([operation])["results"][0]
        self.assertEqual(result["status"], "applied")
        created = self.store.get("row", "offline-row")
        self.assertEqual(created["properties"]["priority"], "높음")
        audits = len(self.store.list("audit"))
        self.assertEqual(self.apply([operation])["results"][0], result)
        self.assertEqual(len(self.store.list("audit")), audits)
        collision = copy.deepcopy(operation)
        collision["body"]["properties"]["name"] = "다른 내용"
        self.assertEqual(self.apply([collision])["results"][0]["http_status"], 409)
        self.assertEqual(self.store.get("row", "offline-row"), created)
        malformed_collision = {**operation, "kind": "unsupported"}
        self.assertEqual(self.apply([malformed_collision])["results"][0]["http_status"], 409)

    def test_row_patch_merges_independent_fields_and_conflicts_on_schema_or_touched_value(self):
        self.assertEqual(self.apply([self.row(priority="보통")])["results"][0]["status"], "applied")
        row = self.store.get("row", "offline-row")
        original_name = row["properties"]["name"]
        row["properties"]["priority"] = "높음"
        self.store.put("row", row)
        operation = self.patch_row("offline-row", {"name": "로컬 변경"}, {"name": original_name})
        self.assertEqual(self.apply([operation])["results"][0]["status"], "applied")
        self.assertEqual(self.store.get("row", "offline-row")["properties"]["priority"], "높음")
        stale = {**operation, "id": "stale-patch"}
        self.assertEqual(self.apply([stale])["results"][0]["status"], "conflict")
        schema_change = self.patch_row("offline-row", {"name": "second"}, {"name": "로컬 변경"}, "schema-patch")
        database = self.store.get("database", "projects")
        database["properties"][0]["name"] = "새 속성 이름"
        self.store.put("database", database)
        self.assertEqual(self.apply([schema_change])["results"][0]["status"], "conflict")
        missing_base = {**operation, "id": "invalid-patch", "base": {}}
        self.assertEqual(self.apply([missing_base])["results"][0]["status"], "invalid")

    def test_atomic_receipt_failure_rolls_back_mutation_and_audit(self):
        original_pages = self.store.list("page")
        original_audits = self.store.list("audit")
        real_put = self.store.put
        def failing_put(kind, data):
            if kind == "sync_receipt": raise RuntimeError("receipt disk failure")
            return real_put(kind, data)
        with patch.object(self.store, "put", side_effect=failing_put):
            with self.assertRaises(RuntimeError): self.apply([self.page()])
        self.assertEqual(self.store.list("page"), original_pages)
        self.assertEqual(self.store.list("audit"), original_audits)
        self.assertIsNone(self.store.get("collaboration", "offline-page"))

    def test_one_operation_failure_does_not_rollback_other_committed_operations(self):
        valid = self.page("valid", "valid-page")
        invalid = self.page("invalid", "invalid-page", blocks=[])
        another = self.page("another", "another-page")
        results = self.apply([valid, invalid, another])["results"]
        self.assertEqual([result["status"] for result in results], ["applied", "invalid", "applied"])
        self.assertIsNotNone(self.store.get("page", "valid-page"))
        self.assertIsNone(self.store.get("page", "invalid-page"))
        self.assertIsNotNone(self.store.get("page", "another-page"))
        self.assertEqual(len(self.store.list("sync_receipt")), 2)

    def test_row_delete_requires_exact_subtree_and_own_receipt_matches_current_version(self):
        created = self.row()
        deletion = {"id": "delete", "kind": "row.delete", "target_id": "offline-row", "database_id": "projects", "depends_on": [created["id"]],
                    "body": {}, "base_rows": {"offline-row": {"updated_at": "local-draft", "after_operation": created["id"]}}}
        results = self.apply([created, deletion])["results"]
        self.assertEqual([result["status"] for result in results], ["applied", "applied"])
        self.assertIsNone(self.store.get("row", "offline-row"))
        self.assertEqual(self.apply([deletion])["results"][0], results[1])
        again = self.row("create-again", "new-row")
        self.apply([again])
        row = self.store.get("row", "new-row")
        row["properties"]["name"] = "원격 변경"
        self.store.put("row", row)
        deletion = {"id": "stale-delete", "kind": "row.delete", "target_id": "new-row", "database_id": "projects", "body": {},
                    "base_rows": {"new-row": {"updated_at": "old", "after_operation": again["id"]}}}
        self.assertEqual(self.apply([deletion])["results"][0]["status"], "conflict")
        child = self.store.put("row", {"id": "child", "database_id": "projects", "parent_row_id": "new-row", "depends_on": [], "properties": {"name": "새 하위 항목"}})
        deletion["id"] = "incomplete-tree-delete"
        deletion["base_rows"] = {"new-row": {"updated_at": row["updated_at"]}}
        self.assertEqual(self.apply([deletion])["results"][0]["status"], "conflict")
        deletion["id"] = "complete-tree-delete"
        deletion["base_rows"] = {item["id"]: {"updated_at": item["updated_at"]} for item in self.store.list("row") if item["id"] in {"new-row", child["id"]}}
        self.assertEqual(self.apply([deletion])["results"][0]["status"], "applied")
        self.assertIsNone(self.store.get("row", "child"))

    def test_binding_actor_and_permissions_rechecked_before_each_operation(self):
        body = self.request([self.page("first", "first-page"), self.page("second", "second-page")])
        calls = 0
        def factory():
            nonlocal calls
            calls += 1
            context = self.context()
            if calls == 3: context["session_binding"] = "new-login"
            return context
        with self.assertRaises(APIError) as error: self.sync.apply(body, factory, self.dispatch)
        self.assertEqual(error.exception.status, 403)
        self.assertIsNotNone(self.store.get("page", "first-page"))
        self.assertIsNone(self.store.get("page", "second-page"))
        self.assertEqual(self.apply(body["operations"])["results"][0]["status"], "applied")
        wrong = {**self.request([]), "workspace_id": "other"}
        with self.assertRaises(APIError) as error: self.sync.apply(wrong, self.context, self.dispatch)
        self.assertEqual(error.exception.status, 409)
        self.store.put("member", {"id": "reader", "name": "Reader", "role": "guest", "email": "reader@example.com"})
        self.actor = "reader"
        operation = {"id": "denied-patch", "kind": "page.patch", "target_id": "first-page", "body": {"title": "no"}, "base": {"fields": {"title": "오프라인 문서"}}}
        self.assertEqual(self.apply([operation])["results"][0]["status"], "denied")

    def test_bounds_and_invalid_ops_have_no_receipts(self):
        with self.assertRaises(APIError): self.apply([self.page(str(index), str(index)) for index in range(51)])
        operations = [{"id": "bad/path", "kind": "page.create", "target_id": "x", "body": {}}, {"id": "bad-kind", "kind": [], "target_id": "x"}]
        self.assertEqual([result["status"] for result in self.apply(operations)["results"]], ["invalid", "invalid"])
        self.assertEqual(self.store.list("sync_receipt"), [])

    def test_unreadable_descendant_is_denied_before_subtree_conflict_details(self):
        self.store.put("member", {"id": "family", "name": "Family", "role": "member", "email": "family@example.com"})
        root = self.store.put("row", {"id": "root-row", "database_id": "projects", "owner_id": "local", "properties": {"name": "Root"}, "parent_row_id": None, "depends_on": []})
        self.store.put("row", {"id": "hidden-child", "database_id": "projects", "owner_id": "local", "properties": {"name": "SECRET CHILD CONTENT"},
            "parent_row_id": "root-row", "depends_on": [], "permissions": {"default": "private", "members": {}, "groups": {}, "inherit": False}})
        self.actor = "family"
        deletion = {"id": "denied-delete", "kind": "row.delete", "target_id": "root-row", "database_id": "projects", "body": {},
                    "base_rows": {"root-row": {"updated_at": root["updated_at"]}}}
        result = self.apply([deletion])["results"][0]
        self.assertEqual(result["status"], "denied")
        self.assertEqual(result["http_status"], 403)
        self.assertNotIn("hidden-child", json.dumps(result))
        self.assertNotIn("SECRET CHILD CONTENT", json.dumps(result))
        self.assertIsNotNone(self.store.get("row", "root-row"))
        self.assertEqual(self.store.list("sync_receipt"), [])

    def test_visible_relation_base_compares_projection_and_keeps_hidden_current_refs(self):
        self.store.put("member", {"id": "family", "name": "Family", "role": "member", "email": "family@example.com"})
        database = self.store.get("database", "projects")
        relation = {"id": "links", "name": "연결", "type": "relation", "database_id": "projects"}
        database["properties"].append(relation)
        self.store.put("database", database)
        self.schema["links"] = relation
        self.store.put("row", {"id": "hidden", "database_id": "projects", "owner_id": "local", "properties": {"name": "SECRET"}, "parent_row_id": None, "depends_on": [],
            "permissions": {"default": "private", "members": {}, "groups": {}, "inherit": False}})
        self.store.put("row", {"id": "visible", "database_id": "projects", "owner_id": "local", "properties": {"name": "Visible", "links": ["hidden"]}, "parent_row_id": None, "depends_on": []})
        self.actor = "family"
        operation = self.patch_row("visible", {"links": []}, {"links": []}, "visible-relations")
        result = self.apply([operation])["results"][0]
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.store.get("row", "visible")["properties"]["links"], ["hidden"])
        self.assertNotIn("hidden", json.dumps(result))
        self.assertNotIn("SECRET", json.dumps(result))

    def test_delete_after_operation_cannot_borrow_page_receipt_for_same_identifier(self):
        page_operation = self.page(target="same-id")
        page_result = self.apply([page_operation])["results"][0]
        self.store.put("row", {"id": "same-id", "database_id": "projects", "owner_id": "local", "properties": {}, "parent_row_id": None, "depends_on": []})
        # The row namespace is distinct from pages, even if timestamps coincide.
        raw = self.store.db.execute("SELECT data FROM entities WHERE kind='row' AND id='same-id'").fetchone()[0]
        row = json.loads(raw)
        row["updated_at"] = page_result["updated_at"]
        self.store.db.execute("UPDATE entities SET data=? WHERE kind='row' AND id='same-id'", (json.dumps(row),))
        self.store.db.commit()
        deletion = {"id": "wrong-kind-delete", "kind": "row.delete", "target_id": "same-id", "database_id": "projects", "body": {},
                    "base_rows": {"same-id": {"updated_at": page_result["updated_at"], "after_operation": page_operation["id"]}}}
        result = self.apply([deletion])["results"][0]
        self.assertEqual(result["status"], "conflict")
        self.assertIsNotNone(self.store.get("row", "same-id"))

    def test_existing_unicode_resource_ids_support_sync_metadata_row_crud_and_receipts(self):
        page_id, database_id, row_id = "가족 문서?#%", "가족 DB?#%", "가족 행 %2F?#"
        self.assertEqual(self.app.dispatch("POST", "/api/pages", {"id": page_id, "title": "기존 문서"}, {})[0], 201)
        patch_page = {"id": "custom-page-patch", "kind": "page.patch", "target_id": page_id,
            "body": {"title": "동기화 문서"}, "base": {"fields": {"title": "기존 문서"}}}
        result = self.apply([patch_page])["results"][0]
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.apply([patch_page])["results"][0], result)
        self.assertEqual(self.store.get("page", page_id)["title"], "동기화 문서")
        properties = [{"id": "name", "name": "이름", "type": "title"}]
        self.assertEqual(self.app.dispatch("POST", "/api/databases", {"id": database_id, "name": "가족", "properties": properties}, {})[0], 201)
        self.assertEqual(self.app.dispatch("POST", f"/api/databases/{database_id}/rows", {"id": row_id, "properties": {"name": "기존 행"}}, {})[0], 201)
        patch_row = {"id": "custom-row-patch", "kind": "row.patch", "target_id": row_id, "database_id": database_id,
            "body": {"properties": {"name": "동기화 행"}}, "base": {"schema": {"name": properties[0]}, "properties": {"name": "기존 행"}}}
        result = self.apply([patch_row])["results"][0]
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.apply([patch_row])["results"][0], result)
        deletion = {"id": "custom-row-delete", "kind": "row.delete", "target_id": row_id, "database_id": database_id,
            "depends_on": [patch_row["id"]], "body": {}, "base_rows": {row_id: {"updated_at": result["updated_at"], "after_operation": patch_row["id"]}}}
        deleted = self.apply([deletion])["results"][0]
        self.assertEqual(deleted["status"], "applied")
        self.assertEqual(self.apply([deletion])["results"][0], deleted)
        self.assertIsNone(self.store.get("row", row_id))
        create_row = {"id": "custom-row-create", "kind": "row.create", "target_id": "새 행?#%", "database_id": database_id,
            "body": {"id": "새 행?#%", "properties": {"name": "새 행"}}, "base": {"schema": {"name": properties[0]}}}
        self.assertEqual(self.apply([create_row])["results"][0]["status"], "applied")
        self.assertIsNotNone(self.store.get("row", "새 행?#%"))
        create_page = self.page("custom-page-create", "새 문서?#%")
        create_page["body"]["id"] = create_page["target_id"]
        self.assertEqual(self.apply([create_page])["results"][0]["status"], "applied")
        document = self.store.get("collaboration", create_page["target_id"])
        collision = self.page("custom-page-collision", create_page["target_id"])
        self.assertEqual(self.apply([collision])["results"][0]["http_status"], 409)
        self.assertEqual(self.store.get("collaboration", create_page["target_id"]), document)

    def test_resource_id_validation_keeps_operation_ids_ascii_and_blocks_path_controls(self):
        unsafe = ["", " ", ".", "..", "a/b", "a\\b", "line\nfeed", "delete\x7f", "control\x85", "x" * 161, "\ud800"]
        for index, identity in enumerate(unsafe):
            with self.subTest(identity=repr(identity)):
                operation = self.page(f"unsafe-{index}", identity)
                operation["target_id"] = identity
                result = self.apply([operation])["results"][0]
                self.assertEqual((result["status"], result["http_status"]), ("invalid", 400))
                row = self.row(f"unsafe-db-{index}", f"row-{index}")
                row["database_id"] = identity
                self.assertEqual(self.apply([row])["results"][0]["http_status"], 400)
        for field in ("id", "depends_on"):
            operation = self.page("ascii-only", "valid-target")
            operation[field] = "한글 작업" if field == "id" else ["한글 작업"]
            self.assertEqual(self.apply([operation])["results"][0]["http_status"], 400)
        row = self.store.put("row", {"id": "delete-target", "database_id": "projects", "properties": {"name": "row"}, "depends_on": [], "parent_row_id": None})
        deletion = {"id": "unsafe-base", "kind": "row.delete", "target_id": row["id"], "database_id": "projects", "body": {},
            "base_rows": {"bad/id": {"updated_at": row["updated_at"]}}}
        self.assertEqual(self.apply([deletion])["results"][0]["http_status"], 400)
        deletion["base_rows"] = {row["id"]: {"updated_at": row["updated_at"], "after_operation": "한글 작업"}}
        self.assertEqual(self.apply([deletion])["results"][0]["http_status"], 400)
        self.assertEqual(self.store.list("sync_receipt"), [])

    def test_two_independent_sqlite_connections_apply_same_operation_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.db"
            stores = [Store(path), Store(path)]
            applications = [Application(store) for store in stores]
            services = [SyncService(store) for store in stores]
            workspace = stores[0].meta("workspace_id")
            operation = self.page()
            body = {"workspace_id": workspace, "session_binding": "binding", "operations": [operation]}
            barrier, results, errors = threading.Barrier(2), [], []
            def apply(index):
                store, app = stores[index], applications[index]
                def factory():
                    return {"access": Access(store, store.get("member", "local")), "workspace_id": workspace, "session_binding": "binding"}
                def dispatch(method, target, payload, context):
                    return app.dispatch(method, target, payload, {}, principal=context["access"].principal)
                try:
                    barrier.wait()
                    results.append(services[index].apply(body, factory, dispatch)["results"][0])
                except BaseException as error: errors.append(error)
            try:
                threads = [threading.Thread(target=apply, args=(index,)) for index in range(2)]
                for thread in threads: thread.start()
                for thread in threads: thread.join(10)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(errors, [])
                self.assertEqual(len(results), 2)
                self.assertEqual(results[0], results[1])
                self.assertEqual(len(stores[0].list("sync_receipt")), 1)
                self.assertEqual(sum(event["action"] == "page.created" and event["details"]["page_id"] == "offline-page" for event in stores[0].list("audit")), 1)
            finally:
                for store in stores: store.close()


if __name__ == "__main__": unittest.main()
