"""HTTP interoperability over two servers backed by the same real PostgreSQL DB.

Set FOUNTAIN_TEST_POSTGRES_DSN inside the test process. Every test seeds and
removes its own random namespace; no production workspace is read or changed.
"""
import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from fountain.authorization import Authorization
from fountain.backup import inspect_backup
from fountain.server import create_server


@unittest.skipUnless(os.environ.get("FOUNTAIN_TEST_POSTGRES_DSN"),
                     "Real PostgreSQL HTTP verification requires FOUNTAIN_TEST_POSTGRES_DSN")
class PostgresHTTPTests(unittest.TestCase):
    def setUp(self):
        self.namespace = uuid.uuid4().hex
        self.servers, self.threads, self.streams = [], [], []
        self.addCleanup(self.cleanup)
        for _ in range(2):
            self.servers.append(create_server(port=0,
                database_url=os.environ["FOUNTAIN_TEST_POSTGRES_DSN"], workspace_id=self.namespace))
        self.store = self.servers[0].application.store
        auth = self.servers[0].application.auth
        self.password = "postgres-http-test-password-123"
        self.store.put("member", {"id": "family", "name": "가족", "email": "family@example.org", "role": "member"})
        for member in ("local", "family"):
            auth.create_account(member, self.password)
        auth.enable_accounts()
        for server in self.servers:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
            thread.start()
            self.threads.append(thread)
        self.owner_a, self.info_a = self.login(0, "local@fountain.local")
        self.owner_b, self.info_b = self.login(1, "local@fountain.local")
        self.family, self.family_info = self.login(1, "family@example.org")
        self.assertEqual(self.info_a["workspace_id"], self.namespace)
        self.assertNotEqual(self.info_a["cache_binding"], self.info_b["cache_binding"])

    def cleanup(self):
        for connection, response in self.streams:
            if response is not None: response.close()
            connection.close()
        for server, thread in zip(self.servers, self.threads):
            if thread.is_alive(): server.shutdown()
        for server in self.servers:
            server.server_close()
        for thread in self.threads:
            thread.join(10)
        try:
            if self.servers:
                store = self.servers[0].application.store
                with store.transaction():
                    for table in ("attachment_chunks", "entities", "meta"):
                        store._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s", (self.namespace,))
        finally:
            for server in self.servers:
                server.application.store.close()

    def request(self, method, path, body=None, *, server=0, cookie=None, raw=False, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.servers[server].server_port, timeout=15)
        request_headers = {"Content-Type": "application/octet-stream" if raw else "application/json",
                           "X-Fountain-Request": "1", "Cookie": cookie if cookie is not None else getattr(self, "owner_a", "")}
        request_headers.update(headers or {})
        data = body if raw else json.dumps(body).encode() if body is not None else None
        try:
            connection.request(method, path, data, request_headers)
            response = connection.getresponse()
            content = response.read()
            result_headers = dict(response.getheaders())
            payload = json.loads(content) if content and "json" in response.getheader("Content-Type", "") else content
            return response.status, payload, result_headers
        finally:
            connection.close()

    def ok(self, method, path, body=None, *, status=200, **options):
        actual, payload, _ = self.request(method, path, body, **options)
        self.assertEqual(actual, status)
        return payload

    def login(self, server, email):
        status, info, headers = self.request("POST", "/api/session",
            {"email": email, "password": self.password}, server=server, cookie="")
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        return headers["Set-Cookie"].split(";", 1)[0], info

    def page(self):
        return self.ok("POST", "/api/pages", {"title": "서버 사이 문서", "blocks": [{"id": "text", "type": "paragraph", "text": "원본"}],
            "permissions": {"default": "private", "members": {"family": "edit"}}}, status=201)

    def stream(self, path, *, cookie, server=1):
        connection = http.client.HTTPConnection("127.0.0.1", self.servers[server].server_port, timeout=15)
        entry = [connection, None]
        self.streams.append(entry)
        connection.request("GET", path + "/events", headers={"Cookie": cookie})
        response = connection.getresponse()
        entry[1] = response
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        return response

    def event(self, response):
        event, data = None, None
        for _ in range(100):
            line = response.fp.readline()
            self.assertTrue(line, "SSE stream closed before the expected event")
            line = line.decode().strip()
            if line.startswith("event: "): event = line[7:]
            elif line.startswith("data: "): data = line[6:]
            elif not line and event is not None:
                return event, json.loads(data)
        self.fail("SSE event was not received")

    def sync(self, operations, *, server=0, cookie=None, info=None):
        info = info or self.info_a
        return self.ok("POST", "/api/sync", {"workspace_id": self.namespace,
            "session_binding": info["cache_binding"], "operations": operations}, server=server, cookie=cookie)

    def test_cross_server_page_crdt_separate_presence_sse_and_session_logout(self):
        page = self.page()
        path = "/api/pages/" + page["id"]
        self.assertEqual(self.ok("GET", path, server=1, cookie=self.owner_b)["page"]["title"], "서버 사이 문서")
        response = self.stream(path, cookie=self.owner_b)
        event, initial = self.event(response)
        self.assertEqual(event, "snapshot")
        self.assertEqual(self.event(response)[0], "presence")
        presence = {"session_binding": self.info_a["cache_binding"], "epoch": initial["epoch"],
                    "client_id": "desktop-a", "seq": 1, "selection": None}
        self.ok("PUT", path + "/presence", presence)
        event, active = self.event(response)
        differences = sorted(key for key in initial.keys() | active.keys() if initial.get(key) != active.get(key)) if event == "snapshot" else []
        self.assertEqual(event, "presence", f"Presence must not replace the document snapshot; changed fields: {differences}")
        self.assertEqual([person["client_id"] for person in active["participants"]], ["desktop-a"])
        unchanged = self.ok("GET", path + "/collaboration", server=1, cookie=self.owner_b)
        self.assertEqual(unchanged["seq"], initial["seq"])
        operation = {"id": "desktop-a:1", "client": "desktop-a", "clock": 1, "type": "text.insert",
                     "block_id": "text", "after_id": None, "text": "공동 "}
        body = {"epoch": initial["epoch"], "ops": [operation]}
        applied = self.ok("POST", path + "/operations", body)
        repeated = self.ok("POST", path + "/operations", body, server=1, cookie=self.owner_b)
        self.assertEqual(repeated["seq"], applied["seq"])
        event, edited = self.event(response)
        self.assertEqual(event, "snapshot")
        self.assertEqual(edited["blocks"][0]["text"], "공동 원본")
        self.ok("PATCH", path, {"title": "수정된 가족 문서"})
        self.assertEqual(self.event(response)[1]["page"]["title"], "수정된 가족 문서")
        self.ok("DELETE", "/api/session", cookie=self.owner_b)
        event, denied = self.event(response)
        self.assertEqual((event, denied["status"]), ("denied", 401))
        self.assertEqual(self.request("GET", path, server=1, cookie=self.owner_b)[0], 401)
        self.assertEqual(self.ok("GET", path)["page"]["title"], "수정된 가족 문서")
        self.assertTrue(self.ok("DELETE", path)["archived"])
        self.assertFalse(self.ok("POST", path + "/restore", {}, server=1)["archived"])

    def test_offline_database_receipt_replay_and_conflict_across_servers(self):
        detail = self.ok("GET", "/api/databases/projects")
        name_schema = next(prop for prop in detail["database"]["properties"] if prop["id"] == "name")
        operation = {"id": uuid.uuid4().hex, "kind": "row.create", "target_id": uuid.uuid4().hex,
                     "database_id": "projects", "body": {"properties": {"name": "오프라인 가족 일정"}},
                     "base": {"schema": {"name": name_schema}}}
        first = self.sync([operation])["results"][0]
        replay = self.sync([operation], server=1, cookie=self.owner_b, info=self.info_b)["results"][0]
        self.assertEqual(first["status"], "applied")
        self.assertEqual(replay, first)
        rows = self.ok("GET", "/api/databases/projects", server=1, cookie=self.owner_b)["rows"]
        self.assertEqual(sum(row["id"] == operation["target_id"] for row in rows), 1)
        def rename(title):
            return {"id": uuid.uuid4().hex, "kind": "row.patch", "target_id": operation["target_id"],
                    "database_id": "projects", "body": {"properties": {"name": title}},
                    "base": {"schema": {"name": name_schema}, "properties": {"name": "오프라인 가족 일정"}}}
        self.assertEqual(self.sync([rename("첫 번째 수정")])["results"][0]["status"], "applied")
        conflict = self.sync([rename("오래된 두 번째 수정")], server=1, cookie=self.owner_b, info=self.info_b)["results"][0]
        self.assertEqual((conflict["status"], conflict["http_status"]), ("conflict", 409))
        rows = self.ok("GET", "/api/databases/projects", server=1)["rows"]
        current = next(row for row in rows if row["id"] == operation["target_id"])
        self.assertEqual(current["properties"]["name"], "첫 번째 수정")
        self.ok("DELETE", "/api/databases/projects/rows/" + current["id"], server=1)

    def test_targeted_history_across_same_account_sessions_preserves_remote_writes_and_anchors(self):
        path = "/api/pages/" + self.page()["id"]
        base = self.ok("GET", path + "/collaboration")
        local = [
            {"id": "owner-a:3", "client": "owner-a", "clock": 3, "type": "block.set",
             "block_id": "text", "field": "type", "value": "heading1", "group_id": "local-action"},
            {"id": "owner-a:4", "client": "owner-a", "clock": 4, "type": "text.insert",
             "block_id": "text", "after_id": None, "text": "로컬", "group_id": "local-action"},
        ]
        remote = [
            {"id": "owner-b:2", "client": "owner-b", "clock": 2, "type": "block.set",
             "block_id": "text", "field": "type", "value": "quote", "group_id": "remote-action"},
            {"id": "owner-b:3", "client": "owner-b", "clock": 3, "type": "text.insert",
             "block_id": "text", "after_id": "owner-a:4:0", "text": "원격", "group_id": "remote-action"},
        ]
        self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": local})
        edited = self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": remote},
                         server=1, cookie=self.owner_b)
        self.assertEqual(edited["blocks"][0]["type"], "heading1")
        self.assertEqual(edited["blocks"][0]["text"], "로컬원격원본")
        undo = {"id": "owner-a:5", "client": "owner-a", "clock": 5,
                "type": "history.cancel", "targets": [item["id"] for item in local]}
        body = {"epoch": base["epoch"], "ops": [undo]}
        # A different login/server of the same member may retry the immutable
        # action. Its scope is still the original client action, not all member edits.
        undone = self.ok("POST", path + "/operations", body, server=1, cookie=self.owner_b)
        self.assertEqual(undone["seq"], edited["seq"] + 1)
        self.assertEqual(undone["blocks"][0]["type"], "quote")
        self.assertEqual(undone["blocks"][0]["text"], "원격원본")
        self.assertNotIn("로컬", json.dumps(undone, ensure_ascii=False))
        document = self.store.get("collaboration", base["page"]["id"])
        audit = self.store.list("audit")
        repeated = self.ok("POST", path + "/operations", body)
        self.assertEqual(repeated["seq"], undone["seq"])
        self.assertEqual(repeated["page"]["revision"], undone["page"]["revision"])
        self.assertEqual(repeated["ack"], [undo["id"]])
        self.assertEqual(self.store.get("collaboration", base["page"]["id"]), document)
        self.assertEqual(self.store.list("audit"), audit)
        redo = {"id": "owner-a:6", "client": "owner-a", "clock": 6,
                "type": "history.cancel", "targets": [undo["id"]]}
        redone = self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [redo]})
        self.assertEqual(redone["seq"], undone["seq"] + 1)
        self.assertEqual(redone["blocks"], edited["blocks"])
        observed = self.ok("GET", path + "/collaboration", server=1, cookie=self.owner_b)
        self.assertEqual((observed["blocks"], observed["state"], observed["seq"]),
                         (redone["blocks"], redone["state"], redone["seq"]))
        self.assertEqual(document["op_owners"], {item["id"]: "local" for item in [*local, *remote, undo]})
        self.assertNotIn("op_owners", json.dumps(observed))

    def test_cross_member_history_forgery_and_nonce_hijack_roll_back_on_both_servers(self):
        page = self.page()
        path = "/api/pages/" + page["id"]
        base = self.ok("GET", path + "/collaboration")
        owner = {"id": "owner:1", "client": "owner", "clock": 1, "type": "text.insert",
                 "block_id": "text", "after_id": None, "text": "소유자"}
        family = {"id": "family:1", "client": "family", "clock": 1, "type": "text.insert",
                  "block_id": "text", "after_id": "owner:1:0", "text": "가족"}
        self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [owner]})
        accepted = self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [family]},
                           server=1, cookie=self.family)
        before, audit = self.store.get("collaboration", page["id"]), self.store.list("audit")
        forged = {"id": "owner:2", "client": "owner", "clock": 2,
                  "type": "history.cancel", "targets": [owner["id"]]}
        # Valid same-client/lower-clock wire data cannot substitute for member ownership.
        self.assertEqual(self.request("POST", path + "/operations", {"epoch": base["epoch"], "ops": [forged]},
                                      server=1, cookie=self.family)[0], 403)
        hijack = {"id": "owner:2", "client": "owner", "clock": 2, "type": "text.insert",
                  "block_id": "text", "after_id": None, "text": "탈취"}
        self.assertEqual(self.request("POST", path + "/operations", {"epoch": base["epoch"], "ops": [hijack]},
                                      server=1, cookie=self.family)[0], 403)
        # Workspace owners have no exception for canceling another member's work.
        reverse = {"id": "family:2", "client": "family", "clock": 2,
                   "type": "history.cancel", "targets": [family["id"]]}
        self.assertEqual(self.request("POST", path + "/operations", {"epoch": base["epoch"], "ops": [reverse]})[0], 403)
        self.assertEqual(self.store.get("collaboration", page["id"]), before)
        self.assertEqual(self.store.list("audit"), audit)
        # Exact foreign replay ACKs but neither transfers ownership nor grows sequence.
        replay = self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [owner]},
                         server=1, cookie=self.family)
        self.assertEqual(replay["seq"], accepted["seq"])
        self.assertEqual(self.store.get("collaboration", page["id"]), before)
        undone = self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [forged]})
        self.assertEqual(undone["seq"], accepted["seq"] + 1)
        self.assertEqual(undone["blocks"][0]["text"], "가족원본")
        self.assertEqual(self.ok("GET", path + "/collaboration", server=1, cookie=self.family)["blocks"], undone["blocks"])

    def test_get_authorization_and_body_are_fenced_against_other_server_acl_writer(self):
        page = self.page()
        path = "/api/pages/" + page["id"]
        authorized, release, writer_entered = threading.Event(), threading.Event(), threading.Event()
        original = Authorization.prepare
        def gated(authority, method, target, body):
            if method == "PATCH" and target == path + "/permissions":
                writer_entered.set()
            result = original(authority, method, target, body)
            if method == "GET" and target == path and authority.access.member_id == "family":
                authorized.set()
                if not release.wait(10): raise TimeoutError("GET authorization test gate timed out")
            return result
        # Only the scheduling gate is instrumented. Both requests, connections,
        # authorization decisions and PostgreSQL transactions remain real.
        with patch.object(Authorization, "prepare", gated), ThreadPoolExecutor(max_workers=2) as pool:
            try:
                reading = pool.submit(self.request, "GET", path, server=1, cookie=self.family)
                self.assertTrue(authorized.wait(5))
                revoking = pool.submit(self.request, "PATCH", path + "/permissions",
                    {"permissions": {"default": "private", "members": {}}}, server=0)
                self.assertFalse(writer_entered.wait(2),
                                 "ACL writer entered its transaction between GET authorization and body projection")
                release.set()
                status, detail, _ = reading.result(timeout=15)
                self.assertEqual(status, 200)
                self.assertEqual(detail["page"]["title"], page["title"])
                self.assertEqual(revoking.result(timeout=15)[0], 200)
            finally:
                release.set()
        self.assertEqual(self.request("GET", path, server=1, cookie=self.family)[0], 404)

    def test_chunk_download_backup_and_acl_revocation_across_servers(self):
        page = self.page()
        path = "/api/pages/" + page["id"]
        content = "두 서버가 같은 첨부 파일을 읽습니다.".encode()
        upload = self.ok("POST", "/api/uploads", {"name": "가족 자료.txt", "size": len(content), "page_id": page["id"]}, status=201)
        upload_path = "/api/uploads/" + upload["id"]
        result = self.ok("PUT", upload_path + "/chunks?offset=0", content, raw=True, server=1)
        self.assertEqual(result["offset"], len(content))
        self.assertEqual(self.ok("PUT", upload_path + "/chunks?offset=0", content, raw=True)["offset"], len(content))
        attachment = self.ok("POST", upload_path + "/complete", {}, server=1, status=201)
        download = "/api/attachments/" + attachment["id"] + "/download"
        self.ok("PUT", path + "/blocks", {"blocks": [{"type": "file", "attachment_id": attachment["id"], "text": attachment["name"]}]})
        status, partial, headers = self.request("GET", download, server=1, cookie=self.family, headers={"Range": "bytes=2-12"})
        self.assertEqual((status, partial), (206, content[2:13]))
        self.assertEqual(headers["Content-Range"], f"bytes 2-12/{len(content)}")
        response = self.stream(path, cookie=self.family)
        self.assertEqual(self.event(response)[0], "snapshot")
        self.assertEqual(self.event(response)[0], "presence")
        status, snapshot, _ = self.request("GET", "/api/backup", server=1)
        self.assertEqual(status, 200)
        self.assertTrue(snapshot.startswith(b"SQLite format 3\x00"))
        with tempfile.TemporaryDirectory() as directory:
            backup_path = Path(directory) / "portable.db"
            backup_path.write_bytes(snapshot)
            counts = inspect_backup(backup_path)
            self.assertEqual(counts["attachment"], 1)
            with sqlite3.connect(backup_path) as saved:
                self.assertEqual(saved.execute("SELECT data FROM attachment_chunks WHERE attachment_id=?", (attachment["id"],)).fetchone()[0], content)
                self.assertEqual(saved.execute("SELECT count(*) FROM entities WHERE kind IN ('session','upload','presence')").fetchone()[0], 0)
        self.ok("PATCH", path + "/permissions", {"permissions": {"default": "private", "members": {}}}, server=0)
        event, denied = self.event(response)
        self.assertEqual((event, denied["status"]), ("denied", 404))
        self.assertEqual(self.request("GET", download, server=1, cookie=self.family)[0], 404)
        self.assertEqual(self.ok("GET", download, server=1), content)

    def test_saved_version_title_body_restore_revision_conflict_across_servers(self):
        page = self.page()
        path = "/api/pages/" + page["id"]
        self.ok("PUT", path + "/blocks", {"revision": 0,
            "blocks": [{"id": "text", "text": "복원 전 본문"}]})
        base = self.ok("GET", path + "/collaboration")
        operation = {"id": "restore-preview:1", "client": "restore-preview", "clock": 1,
                     "type": "text.insert", "block_id": "text", "after_id": None, "text": "추적된 "}
        self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [operation]})
        preview = self.ok("GET", path)
        version = next(item for item in preview["versions"] if item["revision"] == 0)
        restore_path = path + "/versions/" + version["id"] + "/restore"
        self.ok("PATCH", path, {"revision": preview["page"]["revision"], "title": "다른 서버의 새 제목",
            "icon": "🌙", "cover": "https://fixture.invalid/cover", "favorite": True},
            server=1, cookie=self.owner_b)
        remote = dict(operation, id="restore-preview:2", clock=2, text="원격 변경 ")
        self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [remote]},
                server=1, cookie=self.owner_b)

        def snapshot():
            with self.store.transaction():
                return ({kind: self.store.list(kind) for kind in ("page", "collaboration", "version", "audit")},
                        self.store.meta("_entity_revision"), self.store.meta("access_revision"))

        before = snapshot()
        current = self.store.get("page", page["id"])
        document = self.store.get("collaboration", page["id"])
        self.assertTrue(document["state"]["history"]["ops"])
        self.assertEqual(document["op_owners"], {operation["id"]: "local", remote["id"]: "local"})
        self.assertEqual(self.request("POST", restore_path, {"revision": preview["page"]["revision"]})[0], 409)
        self.assertEqual(snapshot(), before)

        restored = self.ok("POST", restore_path, {"revision": current["revision"]},
                           server=1, cookie=self.owner_b)
        self.assertEqual(restored["revision"], current["revision"] + 1)
        self.assertEqual(restored["page"]["title"], page["title"])
        self.assertEqual(restored["blocks"], version["blocks"])
        for field in ("icon", "cover", "favorite", "parent_id", "permissions", "owner_id"):
            self.assertEqual(restored["page"][field], current[field])
        versions = self.store.list("version")
        self.assertEqual(len(versions), len(before[0]["version"]) + 1)
        prior_current = next(item for item in versions
                             if item["page_id"] == page["id"] and item["revision"] == current["revision"])
        self.assertEqual((prior_current["title"], prior_current["blocks"]), (current["title"], current["blocks"]))
        self.assertIsNone(self.store.get("collaboration", page["id"]))
        canonical = self.ok("GET", path + "/collaboration")
        self.assertNotEqual(canonical["epoch"], base["epoch"])
        self.assertEqual((canonical["page"]["title"], canonical["page"]["revision"], canonical["blocks"]),
                         (page["title"], current["revision"] + 1, version["blocks"]))

    def test_saved_version_title_write_failure_rolls_back_real_postgres_transaction(self):
        from fountain.core import APIError

        page = self.page()
        path = "/api/pages/" + page["id"]
        self.ok("PUT", path + "/blocks", {"revision": 0,
            "blocks": [{"id": "text", "text": "현재 본문"}]})
        version = next(item for item in self.store.list("version") if item["page_id"] == page["id"])
        self.ok("PATCH", path, {"revision": 1, "title": "실패해도 유지할 현재 제목"})
        base = self.ok("GET", path + "/collaboration")
        operation = {"id": "restore-rollback:1", "client": "restore-rollback", "clock": 1,
                     "type": "text.insert", "block_id": "text", "after_id": None, "text": "보존할 추적 변경 "}
        self.ok("POST", path + "/operations", {"epoch": base["epoch"], "ops": [operation]})

        def snapshot(store):
            with store.transaction():
                return ({kind: store.list(kind) for kind in ("page", "collaboration", "version", "audit")},
                        store.meta("_entity_revision"), store.meta("access_revision"))

        target_store = self.servers[1].application.store
        before = snapshot(self.store)
        self.assertEqual(snapshot(target_store), before)
        current = self.store.get("page", page["id"])
        document = self.store.get("collaboration", page["id"])
        self.assertTrue(document["state"]["history"]["ops"])
        self.assertEqual(document["op_owners"], {operation["id"]: "local"})
        original, page_writes = target_store.put, []

        def write(kind, value):
            if kind == "page" and value["id"] == page["id"]:
                page_writes.append(value["title"])
                if len(page_writes) == 2:
                    raise APIError(409, "Injected restore title failure")
            return original(kind, value)

        restore_path = path + "/versions/" + version["id"] + "/restore"
        with patch.object(target_store, "put", side_effect=write):
            self.assertEqual(self.request("POST", restore_path, {"revision": current["revision"]},
                                          server=1, cookie=self.owner_b)[0], 409)
        self.assertEqual(page_writes, [current["title"], page["title"]])
        self.assertEqual(snapshot(self.store), before)
        self.assertEqual(snapshot(target_store), before)
        self.assertEqual(self.store.get("collaboration", page["id"]), document)


if __name__ == "__main__":
    unittest.main()
