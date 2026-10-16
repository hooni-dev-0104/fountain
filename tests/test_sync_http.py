import copy
import http.client
import json
import os
import tempfile
import threading
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fountain.auth import Auth
from fountain.authorization import Authorization
from fountain.core import Store
from fountain.server import create_server


class SyncHTTPTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""})
        self.environment.start()
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "workspace.db"
        self.server = create_server(port=0, db_path=self.path)
        self.app, self.store = self.server.application, self.server.application.store
        self.password = "same-account-password-123"
        self.app.auth.create_account("local", self.password)
        self.app.auth.enable_accounts()
        self.store.put("member", {"id": "family", "name": "Family", "email": "family@example.com", "role": "member"})
        self.app.auth.create_account("family", self.password)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.cookie_a, self.info_a = self.login("local@fountain.local")
        self.cookie_b, self.info_b = self.login("local@fountain.local")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()
        self.directory.cleanup()
        self.environment.stop()

    def request(self, method, path, body=None, cookie=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Content-Type": "application/json", "X-Fountain-Request": "1", "Cookie": self.cookie_a if cookie is None and hasattr(self, "cookie_a") else cookie or ""}
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        payload = json.loads(raw) if raw else None
        result = response.status, payload, response.getheader("Set-Cookie", "")
        connection.close()
        return result

    def login(self, email):
        status, info, cookie = self.request("POST", "/api/session", {"email": email, "password": self.password}, "")
        self.assertEqual(status, 200)
        return cookie.split(";", 1)[0], info

    def envelope(self, operations, info=None):
        info = info or self.info_a
        return {"workspace_id": info["workspace_id"], "session_binding": info["cache_binding"], "operations": operations}

    def sync(self, operations, cookie=None, info=None):
        return self.request("POST", "/api/sync", self.envelope(operations, info), cookie)

    def page_operation(self, target=None, **body):
        return {"id": uuid.uuid4().hex, "kind": "page.create", "target_id": target or uuid.uuid4().hex,
                "document_epoch": str(uuid.uuid4()), "body": {"title": "기기 사이 문서", **body}}

    def row_operation(self, target=None, **properties):
        detail = self.request("GET", "/api/databases/projects")[1]
        schema = {prop["id"]: prop for prop in detail["database"]["properties"]}
        values = {"name": "기기 사이 행", **properties}
        return {"id": uuid.uuid4().hex, "kind": "row.create", "target_id": target or uuid.uuid4().hex,
                "database_id": "projects", "body": {"properties": values}, "base": {"schema": {key: schema[key] for key in values}}}

    def test_same_account_separate_sessions_share_data_and_receipt_without_reexecution(self):
        self.assertNotEqual(self.info_a["cache_binding"], self.info_b["cache_binding"])
        operation = self.row_operation()
        status, first, _ = self.sync([operation])
        self.assertEqual(status, 200)
        self.assertEqual(first["results"][0]["status"], "applied")
        status, replay, _ = self.sync([operation], self.cookie_b, self.info_b)
        self.assertEqual(status, 200)
        self.assertEqual(replay["results"], first["results"])
        self.assertEqual(replay["session_binding"], self.info_b["cache_binding"])
        snapshot = self.request("GET", "/api/databases/projects", cookie=self.cookie_b)[1]
        rows = [row for row in snapshot["rows"] if row["id"] == operation["target_id"]]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["properties"]["name"], "기기 사이 행")
        self.assertEqual(snapshot["current_member_id"], "local")
        self.assertGreaterEqual(snapshot["data_revision"], first["results"][0]["data_revision"])
        events = [event for event in self.store.list("audit") if event["action"] == "row.created" and event["details"]["row_id"] == operation["target_id"]]
        self.assertEqual(len(events), 1)
        self.assertNotIn("properties", json.dumps(first["results"]))
        self.assertNotIn("digest", json.dumps(first))

    def test_two_devices_conflict_on_same_field_but_merge_other_fields(self):
        operation = self.row_operation()
        self.assertEqual(self.sync([operation])[1]["results"][0]["status"], "applied")
        schema = operation["base"]["schema"]
        def rename(name):
            return {"id": uuid.uuid4().hex, "kind": "row.patch", "target_id": operation["target_id"], "database_id": "projects",
                    "body": {"properties": {"name": name}}, "base": {"schema": schema, "properties": {"name": "기기 사이 행"}}}
        self.assertEqual(self.sync([rename("맥 변경")])[1]["results"][0]["status"], "applied")
        conflict = self.sync([rename("윈도우 변경")], self.cookie_b, self.info_b)[1]["results"][0]
        self.assertEqual((conflict["status"], conflict["http_status"]), ("conflict", 409))
        snapshot = self.request("GET", "/api/databases/projects", cookie=self.cookie_b)[1]
        priority = next(prop for prop in snapshot["database"]["properties"] if prop["id"] == "priority")
        independent = {"id": uuid.uuid4().hex, "kind": "row.patch", "target_id": operation["target_id"], "database_id": "projects",
            "body": {"properties": {"priority": "높음"}}, "base": {"schema": {"priority": priority}, "properties": {"priority": None}}}
        self.assertEqual(self.sync([independent], self.cookie_b, self.info_b)[1]["results"][0]["status"], "applied")
        row = self.store.get("row", operation["target_id"])
        self.assertEqual(row["properties"], {"name": "맥 변경", "priority": "높음"})

    def test_page_creation_uses_client_epoch_and_retry_keeps_collaborative_changes(self):
        operation = self.page_operation()
        self.assertEqual(self.sync([operation])[1]["results"][0]["status"], "applied")
        path = "/api/pages/" + operation["target_id"]
        snapshot = self.request("GET", path + "/collaboration", cookie=self.cookie_b)[1]
        self.assertEqual(snapshot["epoch"], operation["document_epoch"])
        self.assertEqual(snapshot["blocks"], [])
        operations = [{"id": "device-b:1", "client": "device-b", "clock": 1, "type": "block.insert", "block_id": "new-block", "block_type": "paragraph"},
                      {"id": "device-b:2", "client": "device-b", "clock": 2, "type": "text.insert", "block_id": "new-block", "after_id": None, "text": "다른 기기의 편집"}]
        self.assertEqual(self.request("POST", path + "/operations", {"epoch": snapshot["epoch"], "ops": operations}, self.cookie_b)[0], 200)
        self.assertEqual(self.sync([operation])[1]["results"][0]["status"], "applied")
        current = self.request("GET", path + "/collaboration")[1]
        self.assertEqual(current["epoch"], snapshot["epoch"])
        self.assertEqual(current["blocks"][0]["text"], "다른 기기의 편집")

    def test_logout_old_binding_and_other_workspace_are_rejected_without_mutation(self):
        operation = self.page_operation()
        self.assertEqual(self.request("DELETE", "/api/session", cookie=self.cookie_a)[0], 200)
        self.assertEqual(self.sync([operation])[0], 401)
        replacement, replacement_info = self.login("local@fountain.local")
        self.assertNotEqual(replacement_info["cache_binding"], self.info_a["cache_binding"])
        self.assertEqual(self.sync([operation], replacement, self.info_a)[0], 403)
        wrong_workspace = self.envelope([operation], replacement_info)
        wrong_workspace["workspace_id"] = "another-workspace"
        self.assertEqual(self.request("POST", "/api/sync", wrong_workspace, replacement)[0], 409)
        self.assertIsNone(self.store.get("page", operation["target_id"]))
        self.assertEqual(self.sync([operation], replacement, replacement_info)[1]["results"][0]["status"], "applied")

    def test_permission_denial_is_per_operation_and_does_not_hide_readable_database(self):
        family_cookie, family_info = self.login("family@example.com")
        operation = self.row_operation()
        permission = {"permissions": {"default": "private", "members": {"family": "view"}, "groups": {}, "inherit": False}}
        self.assertEqual(self.request("PATCH", "/api/databases/projects/permissions", permission)[0], 200)
        page = self.page_operation()
        status, result, _ = self.sync([operation, page], family_cookie, family_info)
        self.assertEqual(status, 200)
        self.assertEqual([entry["status"] for entry in result["results"]], ["denied", "applied"])
        self.assertEqual(result["results"][0]["http_status"], 403)
        self.assertIsNone(self.store.get("row", operation["target_id"]))
        self.assertEqual(self.request("GET", "/api/databases/projects", cookie=family_cookie)[0], 200)
        permission["permissions"]["members"] = {}
        self.assertEqual(self.request("PATCH", "/api/databases/projects/permissions", permission)[0], 200)
        self.assertEqual(self.request("GET", "/api/databases/projects", cookie=family_cookie)[0], 404)
        self.assertEqual(self.sync([operation], family_cookie, family_info)[1]["results"][0]["status"], "denied")

    def test_actor_receipts_are_not_shared_with_another_account(self):
        operation = self.page_operation()
        first = self.sync([operation])[1]["results"][0]
        self.assertEqual(first["status"], "applied")
        cookie, info = self.login("family@example.com")
        result = self.sync([operation], cookie, info)[1]["results"][0]
        self.assertEqual((result["status"], result["http_status"]), ("conflict", 409))
        self.assertNotIn("updated_at", result)
        own = self.page_operation()
        own["id"] = operation["id"]
        self.assertEqual(self.sync([own], cookie, info)[1]["results"][0]["status"], "applied")
        self.assertEqual(len(self.store.list("sync_receipt")), 2)

    def test_revocation_between_operations_preserves_prior_commit_and_reauthenticates_original_cookie(self):
        first, second = self.page_operation(), self.page_operation()
        other_store = Store(self.path)
        original_transaction = self.store.transaction
        revoked = False
        @contextmanager
        def transaction():
            nonlocal revoked
            outer = self.store.transaction_depth == 0
            with original_transaction():
                yield
            if outer and not revoked and self.store.get("page", first["target_id"]):
                revoked = True
                Auth(other_store).logout(self.cookie_a)
        try:
            with patch.object(self.store, "transaction", transaction):
                status, _, _ = self.sync([first, second])
            self.assertEqual(status, 401)
            self.assertTrue(revoked)
            self.assertIsNotNone(self.store.get("page", first["target_id"]))
            self.assertIsNone(self.store.get("page", second["target_id"]))
            self.assertEqual(len(self.store.list("sync_receipt")), 1)
            status, retried, _ = self.sync([first, second], self.cookie_b, self.info_b)
            self.assertEqual(status, 200)
            self.assertEqual([result["status"] for result in retried["results"]], ["applied", "applied"])
            self.assertEqual(len(self.store.list("sync_receipt")), 2)
        finally:
            other_store.close()

    def test_canonical_snapshot_envelopes_and_counter_are_consistent_with_independent_sqlite_writer(self):
        created = self.request("POST", "/api/databases/projects/rows", {"properties": {"name": "before"}})[1]
        other = Store(self.path)
        started, trying, finished = threading.Event(), threading.Event(), threading.Event()
        errors, armed = [], True
        original_project = Authorization.project
        revision_before = self.store.meta("_entity_revision")
        def writer():
            try:
                if not started.wait(3): raise AssertionError("snapshot did not start")
                trying.set()
                with other.transaction():
                    row = other.get("row", created["id"])
                    row["properties"]["name"] = "after"
                    other.put("row", row)
                finished.set()
            except BaseException as error: errors.append(error)
        def project(authority, path, payload):
            nonlocal armed
            if path == "/api/databases/projects" and armed:
                armed = False
                self.assertGreater(self.store.transaction_depth, 0)
                started.set()
                self.assertTrue(trying.wait(3))
                self.assertFalse(finished.wait(0.05), "another writer committed during a canonical snapshot")
            return original_project(authority, path, payload)
        thread = threading.Thread(target=writer)
        thread.start()
        try:
            with patch.object(Authorization, "project", project):
                status, before, _ = self.request("GET", "/api/databases/projects")
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(status, 200)
            self.assertEqual(next(row for row in before["rows"] if row["id"] == created["id"])["properties"]["name"], "before")
            self.assertEqual(before["data_revision"], revision_before)
            after = self.request("GET", "/api/databases/projects")[1]
            self.assertGreater(after["data_revision"], before["data_revision"])
            self.assertEqual(next(row for row in after["rows"] if row["id"] == created["id"])["properties"]["name"], "after")
            workspace = self.request("GET", "/api/workspace")[1]
            for snapshot in (before, after, workspace):
                self.assertEqual(snapshot["workspace_id"], self.info_a["workspace_id"])
                self.assertEqual(snapshot["current_member_id"], "local")
                self.assertEqual(snapshot["session_binding"], self.info_a["cache_binding"])
                self.assertIsInstance(snapshot["access_revision"], int)
                self.assertIsInstance(snapshot["data_revision"], int)
        finally:
            started.set()
            thread.join(5)
            other.close()

    def test_trusted_direct_dispatch_and_partial_batch_have_no_outer_transaction(self):
        principal = {"id": "maintenance", "role": "owner", "active": True, "_service": True}
        status, snapshot = self.app.dispatch("GET", "/api/workspace", {}, {}, principal=principal)
        self.assertEqual(status, 200)
        self.assertEqual(snapshot["current_member_id"], "maintenance")
        self.assertEqual(snapshot["session_binding"], "service:maintenance")
        first, bad, second = self.page_operation(), self.page_operation(blocks=[]), self.page_operation()
        body = {"workspace_id": snapshot["workspace_id"], "session_binding": snapshot["session_binding"], "operations": [first, bad, second]}
        status, result = self.app.dispatch("POST", "/api/sync", body, {}, principal=principal)
        self.assertEqual(status, 200)
        self.assertEqual([entry["status"] for entry in result["results"]], ["applied", "invalid", "applied"])
        self.assertEqual(self.store.get("page", first["target_id"])["owner_id"], "maintenance")
        self.assertIsNone(self.store.get("page", bad["target_id"]))
        self.assertEqual(self.store.transaction_depth, 0)
        status, local = self.app.dispatch("GET", "/api/workspace", {}, {})
        self.assertEqual((status, local["current_member_id"], local["session_binding"]), (200, "local", "service:local"))
        direct = self.page_operation()
        self.assertEqual(self.app.dispatch("POST", "/api/sync", {"workspace_id": local["workspace_id"], "session_binding": local["session_binding"], "operations": [direct]}, {})[1]["results"][0]["status"], "applied")


if __name__ == "__main__": unittest.main()
