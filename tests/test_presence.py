import copy
import http.client
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fountain.access import Access
from fountain.auth import Auth
from fountain.authorization import Authorization
from fountain.core import APIError, Store
from fountain.presence import PresenceService, RETENTION, TTL
from fountain.server import Application, create_server

PASSWORD = "presence-account-password-123"


def account_setup(application):
    store, auth = application.store, application.auth
    auth.create_account("local", PASSWORD)
    store.put("member", {"id": "family", "name": "가족", "email": "family@example.com", "role": "member"})
    auth.create_account("family", PASSWORD)
    auth.enable_accounts()
    owner = "fountain_session=" + auth.login({"email": "local@fountain.local", "password": PASSWORD})
    family = "fountain_session=" + auth.login({"email": "family@example.com", "password": PASSWORD})
    return owner, family


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""})
        self.environment.start()
        self.store = Store(":memory:")
        self.app = Application(self.store)
        self.owner, self.family = account_setup(self.app)
        self.clock = 100.0
        self.service = PresenceService(self.store, self.app.auth, lambda: self.clock)
        self.page = self.app.workspace.create_page({"id": "presence-page", "title": "커서", "blocks": [{"id": "cursor", "type": "paragraph", "text": "가🙂나"}]})
        self.document = self.app.collaboration.snapshot(self.page["id"], Access(self.store, self.store.get("member", "local")))

    def tearDown(self):
        self.store.close()
        self.environment.stop()

    def body(self, client="tab", seq=1, cookie=None, selection=None):
        return {"session_binding": self.app.auth.session_info(cookie or self.family)["cache_binding"], "epoch": self.document["epoch"],
                "client_id": client, "seq": seq, "selection": selection}

    def point(self, offset):
        ids = [f"seed:cursor:{index}" for index in range(3)]
        return {"before": ids[offset - 1] if offset else None, "after": ids[offset] if offset < len(ids) else None, "offset": offset}

    def selection(self, anchor=1, focus=2):
        return {"block_id": "cursor", "anchor": self.point(anchor), "focus": self.point(focus)}

    def leave(self, body, cookie=None):
        return self.service.leave(self.page["id"], {key: value for key, value in body.items() if key != "selection"}, cookie or self.family)

    def test_readers_can_publish_codepoint_selection_without_document_or_audit_changes(self):
        page = self.store.get("page", self.page["id"])
        page["permissions"] = {"default": "private", "inherit": False, "members": {"family": "view"}, "groups": {}}
        self.store.put("page", page)
        before_page, before_document, before_audit = self.store.get("page", page["id"]), self.store.get("collaboration", page["id"]), self.store.list("audit")
        access = Access(self.store, self.store.get("member", "family"))
        Authorization(access).prepare("PUT", f"/api/pages/{page['id']}/presence", {})
        result = self.service.update(page["id"], self.body(selection=self.selection()), self.family)
        participant = result["participants"][0]
        self.assertEqual((participant["member_id"], participant["name"], participant["selection"]), ("family", "가족", self.selection()))
        self.assertEqual(len(participant["id"]), 64)
        self.assertEqual((result["ttl"], result["heartbeat"], result["ack_seq"]), (15, 5, 1))
        self.assertIsInstance(result["revision"], int)
        encoded = json.dumps(result["participants"], ensure_ascii=False)
        for private in ["family@example.com", self.family, self.app.auth._digest(self.family), self.body()["session_binding"], "credential_tag", "text"]:
            self.assertNotIn(private, encoded)
        self.assertEqual(self.store.get("page", page["id"]), before_page)
        self.assertEqual(self.store.get("collaboration", page["id"]), before_document)
        self.assertEqual(self.store.list("audit"), before_audit)

    def test_presence_never_initializes_or_replaces_a_document(self):
        page = self.app.workspace.create_page({"title": "열기 전 문서"})
        before = self.store.get("page", page["id"])
        audits = self.store.list("audit")
        result = self.service.snapshot(page["id"], self.owner)
        self.assertIsNone(result["epoch"])
        self.assertEqual(result["participants"], [])
        with self.assertRaises(APIError) as error: self.service.update(page["id"], self.body(), self.family)
        self.assertEqual(error.exception.status, 409)
        self.assertIsNone(self.store.get("collaboration", page["id"]))
        self.assertEqual(self.store.get("page", page["id"]), before)
        self.assertEqual(self.store.list("audit"), audits)

    def test_sequence_reordering_leave_before_join_and_equal_retry_cannot_revive(self):
        leave = self.body(seq=5)
        self.assertEqual(self.leave(leave)["participants"], [])
        late = self.service.update(self.page["id"], self.body(seq=4, selection=self.selection()), self.family)
        self.assertTrue(late["ignored"])
        self.assertEqual((late["ack_seq"], late["participants"]), (5, []))
        joined = self.service.update(self.page["id"], self.body(seq=6), self.family)
        self.assertEqual(len(joined["participants"]), 1)
        record = self.store.list("presence")[0]
        equal = self.service.update(self.page["id"], self.body(seq=6, selection=self.selection()), self.family)
        self.assertTrue(equal["ignored"])
        self.assertIsNone(equal["participants"][0]["selection"])
        self.assertEqual(self.store.get("presence", record["id"]), record)
        self.assertEqual(self.leave(self.body(seq=7))["participants"], [])
        self.assertEqual(self.service.update(self.page["id"], self.body(seq=6), self.family)["participants"], [])

    def test_ttl_and_retained_tombstones_expire_from_original_lease_not_read_time(self):
        initial = self.service.update(self.page["id"], self.body(), self.family)
        identity = initial["participants"][0]["id"]
        self.clock += TTL + 1
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        retained = self.store.get("presence", identity)
        self.assertEqual(retained["retain_until"], 100 + TTL + RETENTION)
        self.assertTrue(self.service.update(self.page["id"], self.body(), self.family)["ignored"])
        self.clock = retained["retain_until"] + 1
        self.service.snapshot(self.page["id"], self.owner)
        self.assertIsNone(self.store.get("presence", identity))

    def test_current_session_password_expiry_member_and_group_permissions_are_rechecked(self):
        self.service.update(self.page["id"], self.body(), self.family)
        member = self.store.get("member", "family")
        member["name"] = "새 가족 이름"
        self.store.put("member", member)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"][0]["name"], "새 가족 이름")
        self.store.put("group", {"id": "readers", "members": ["family"]})
        page = self.store.get("page", self.page["id"])
        page["permissions"] = {"default": "private", "inherit": False, "members": {}, "groups": {"readers": "view"}}
        self.store.put("page", page)
        self.assertEqual(len(self.service.snapshot(self.page["id"], self.owner)["participants"]), 1)
        self.store.put("group", {"id": "readers", "members": []})
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        with self.assertRaises(APIError): self.service.snapshot(self.page["id"], self.family)
        self.store.put("group", {"id": "readers", "members": ["family"]})
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        self.service.update(self.page["id"], self.body(seq=2), self.family)
        self.app.auth.set_password("family", "replacement-presence-password")
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])

    def test_logout_session_expiry_and_deactivation_remove_other_viewers_participants(self):
        self.service.update(self.page["id"], self.body(), self.family)
        self.app.auth.logout(self.family)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        self.family = "fountain_session=" + self.app.auth.login({"email": "family@example.com", "password": PASSWORD})
        self.service.update(self.page["id"], self.body(seq=2), self.family)
        session = self.store.get("session", self.app.auth._digest(self.family))
        session["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        self.store.put("session", session)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        self.family = "fountain_session=" + self.app.auth.login({"email": "family@example.com", "password": PASSWORD})
        self.service.update(self.page["id"], self.body(seq=3), self.family)
        member = self.store.get("member", "family")
        member["active"] = False
        self.store.put("member", member)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])

    def test_rotating_an_existing_session_binding_retires_its_prior_publication(self):
        old_body = self.body()
        self.service.update(self.page["id"], old_body, self.family)
        session = self.store.get("session", self.app.auth._digest(self.family))
        session["cache_binding"] = "new-session-generation"
        self.store.put("session", session)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        with self.assertRaises(APIError): self.service.update(self.page["id"], {**old_body, "seq": 2}, self.family)
        self.assertEqual(len(self.service.update(self.page["id"], self.body(seq=2), self.family)["participants"]), 1)

    def test_same_account_separate_sessions_and_clients_cannot_leave_each_other(self):
        another = "fountain_session=" + self.app.auth.login({"email": "family@example.com", "password": PASSWORD})
        self.service.update(self.page["id"], self.body(client="same-tab"), self.family)
        result = self.service.update(self.page["id"], self.body(client="same-tab", cookie=another), another)
        self.assertEqual(len(result["participants"]), 2)
        self.assertEqual({row["member_id"] for row in result["participants"]}, {"family"})
        self.assertEqual(len({row["id"] for row in result["participants"]}), 2)
        result = self.leave(self.body(client="same-tab", seq=2))
        self.assertEqual(len(result["participants"]), 1)
        with self.assertRaises(APIError): self.service.update(self.page["id"], self.body(cookie=another, seq=3), self.family)
        with self.assertRaises(APIError): self.service.update(self.page["id"], {**self.body(seq=4), "member_id": "local", "name": "spoof"}, self.family)

    def test_unknown_deleted_anchors_and_blocks_become_null_and_epoch_replacement_clears(self):
        unknown = self.selection()
        unknown["anchor"]["before"] = "unknown:1:0"
        result = self.service.update(self.page["id"], self.body(selection=unknown), self.family)
        self.assertIsNone(result["participants"][0]["selection"])
        self.service.update(self.page["id"], self.body(seq=2, selection=self.selection()), self.family)
        self.app.collaboration.apply(self.page["id"], {"epoch": self.document["epoch"], "ops": [
            {"id": "delete:1", "client": "delete", "clock": 1, "type": "text.delete", "block_id": "cursor", "char_ids": ["seed:cursor:1"]}]}, Access(self.store, self.store.get("member", "local")))
        self.assertIsNone(self.service.snapshot(self.page["id"], self.owner)["participants"][0]["selection"])
        missing = {**self.selection(), "block_id": "unknown-block"}
        self.assertIsNone(self.service.update(self.page["id"], self.body(seq=3, selection=missing), self.family)["participants"][0]["selection"])
        self.app.collaboration.apply(self.page["id"], {"epoch": self.document["epoch"], "ops": [
            {"id": "delete:2", "client": "delete", "clock": 2, "type": "block.delete", "block_id": "cursor"}]}, Access(self.store, self.store.get("member", "local")))
        self.assertIsNone(self.service.update(self.page["id"], self.body(seq=4, selection=self.selection()), self.family)["participants"][0]["selection"])
        self.app.workspace.save_blocks(self.page["id"], [])
        with self.assertRaises(APIError) as error: self.service.update(self.page["id"], self.body(seq=5), self.family)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        self.assertEqual(self.store.list("presence"), [])

    def test_archived_page_retires_presence_and_locked_readers_are_allowed(self):
        page = self.store.get("page", self.page["id"])
        page["locked"] = True
        self.store.put("page", page)
        self.assertEqual(len(self.service.update(self.page["id"], self.body(), self.family)["participants"]), 1)
        page["archived"] = True
        self.store.put("page", page)
        self.assertEqual(self.service.snapshot(self.page["id"], self.owner)["participants"], [])
        with self.assertRaises(APIError) as error: self.service.update(self.page["id"], self.body(seq=2), self.family)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.leave(self.body(seq=3))["participants"], [])

    def test_input_bounds_and_service_principal_are_rejected_without_spoofed_records(self):
        for change in [{"seq": True}, {"seq": 0}, {"seq": 9007199254740992}, {"client_id": "a:b"},
                       {"client_id": "x" * 81}, {"selection": {"text": "private"}}, {"session_binding": "wrong"}, {"epoch": "wrong"}]:
            with self.subTest(change=change), self.assertRaises(APIError):
                self.service.update(self.page["id"], {**self.body(), **change}, self.family)
        invalid_point = self.selection()
        invalid_point["anchor"]["offset"] = True
        with self.assertRaises(APIError): self.service.update(self.page["id"], self.body(selection=invalid_point), self.family)
        with self.assertRaises(APIError) as error: self.app.dispatch("GET", f"/api/pages/{self.page['id']}/presence", {}, {})
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.store.list("presence"), [])

    def test_active_and_retained_quotas_are_separate_and_sequential_documents_work(self):
        with patch("fountain.presence.MAX_ACTIVE_SESSION", 2), patch("fountain.presence.MAX_RETAINED_SESSION", 3):
            for client in ("one", "two"): self.service.update(self.page["id"], self.body(client=client), self.family)
            with self.assertRaises(APIError) as error: self.service.update(self.page["id"], self.body(client="three"), self.family)
            self.assertEqual(error.exception.status, 429)
            self.leave(self.body(client="one", seq=2))
            self.service.update(self.page["id"], self.body(client="three"), self.family)
            for client in ("two", "three"): self.leave(self.body(client=client, seq=2))
            with self.assertRaises(APIError): self.service.update(self.page["id"], self.body(client="four"), self.family)
        self.clock += TTL + RETENTION + 1
        owner_access = Access(self.store, self.store.get("member", "local"))
        for index in range(11):
            page = self.app.workspace.create_page({"title": str(index)})
            document = self.app.collaboration.snapshot(page["id"], owner_access)
            body = self.body(client=f"visit-{index}")
            body["epoch"] = document["epoch"]
            self.assertEqual(len(self.service.update(page["id"], body, self.family)["participants"]), 1)
            body.pop("selection")
            body["seq"] = 2
            self.service.leave(page["id"], body, self.family)

    def test_page_caps_apply_across_sessions_and_expired_retained_rows_are_cleaned(self):
        with patch("fountain.presence.MAX_ACTIVE_PAGE", 1), patch("fountain.presence.MAX_RETAINED_PAGE", 2):
            self.service.update(self.page["id"], self.body(client="family-tab"), self.family)
            owner_body = self.body(client="owner-tab", cookie=self.owner)
            with self.assertRaises(APIError) as error: self.service.update(self.page["id"], owner_body, self.owner)
            self.assertEqual(error.exception.status, 429)
            self.leave(self.body(client="family-tab", seq=2))
            self.service.update(self.page["id"], owner_body, self.owner)
            self.leave({**owner_body, "seq": 2}, self.owner)
            with self.assertRaises(APIError) as error: self.service.update(self.page["id"], self.body(client="new-tab"), self.family)
            self.assertEqual(error.exception.status, 429)
            self.clock += TTL + RETENTION + 1
            self.assertEqual(len(self.service.update(self.page["id"], self.body(client="new-tab"), self.family)["participants"]), 1)
            self.assertEqual(len(self.store.list("presence")), 1)

    def test_cleanup_backlog_cannot_bypass_retained_page_limit_with_an_expired_id(self):
        self.service.update(self.page["id"], self.body(client="expired"), self.family)
        self.clock += TTL + RETENTION + 1
        # Simulate an expired record beyond the bounded global cleanup batch.
        with patch.object(self.service, "_cleanup", lambda now: None), patch("fountain.presence.MAX_RETAINED_PAGE", 1):
            self.service.update(self.page["id"], self.body(client="current"), self.family)
            with self.assertRaises(APIError) as error:
                self.service.update(self.page["id"], self.body(client="expired", seq=2), self.family)
            self.assertEqual(error.exception.status, 429)
            self.assertEqual(len(self.service.snapshot(self.page["id"], self.owner)["participants"]), 1)

    def test_two_independent_stores_share_presence_and_highest_sequence_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "presence.db"
            first, second = Store(path), Store(path)
            try:
                app = Application(first)
                owner, family = account_setup(app)
                access = Access(first, first.get("member", "local"))
                document = app.collaboration.snapshot("welcome", access)
                services = [PresenceService(first, app.auth, lambda: 100), PresenceService(second, Auth(second), lambda: 100)]
                info = app.auth.session_info(family)
                base = {"session_binding": info["cache_binding"], "epoch": document["epoch"], "client_id": "tab", "selection": None}
                barrier, errors = threading.Barrier(2), []
                def update(index):
                    try:
                        barrier.wait()
                        services[index].update("welcome", {**base, "seq": 10 + index}, family)
                    except BaseException as error: errors.append(error)
                threads = [threading.Thread(target=update, args=(index,)) for index in range(2)]
                for thread in threads: thread.start()
                for thread in threads: thread.join(5)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(errors, [])
                self.assertEqual(services[1].snapshot("welcome", owner)["participants"][0]["seq"], 11)
                self.assertEqual(services[0].snapshot("welcome", owner)["participants"], services[1].snapshot("welcome", owner)["participants"])
            finally:
                first.close()
                second.close()

    def test_local_binding_rotation_account_enable_and_family_token_rotation(self):
        store = Store(":memory:")
        try:
            app = Application(store)
            access = Access(store, {"id": "local", "role": "owner", "active": True})
            doc = app.collaboration.snapshot("welcome", access)
            service = PresenceService(store, app.auth, lambda: 100)
            info = app.auth.session_info("")
            body = {"session_binding": info["cache_binding"], "epoch": doc["epoch"], "client_id": "local-tab", "seq": 1, "selection": None}
            self.assertEqual(service.update("welcome", body, "")["participants"][0]["member_id"], "local")
            app.auth.logout("")
            self.assertEqual(service.snapshot("welcome", "")["participants"], [])
            with self.assertRaises(APIError): service.update("welcome", {**body, "seq": 2}, "")
            body["session_binding"] = app.auth.session_info("")["cache_binding"]
            service.update("welcome", body, "")
            app.auth.create_account("local", PASSWORD)
            app.auth.enable_accounts()
            cookie = "fountain_session=" + app.auth.login({"email": "local@fountain.local", "password": PASSWORD})
            self.assertEqual(service.snapshot("welcome", cookie)["participants"], [])
        finally:
            store.close()
        with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": "shared-presence-password-at-least-32"}):
            store = Store(":memory:")
            try:
                app = Application(store)
                document = app.collaboration.snapshot("welcome", Access(store, {"id": "local", "role": "owner", "active": True}))
                cookie = "fountain_session=" + app.auth.login({"token": "shared-presence-password-at-least-32"})
                info = app.auth.session_info(cookie)
                body = {"session_binding": info["cache_binding"], "epoch": document["epoch"], "client_id": "shared", "seq": 1, "selection": None}
                self.assertEqual(app.presence.update("welcome", body, cookie)["participants"][0]["name"], "가족 공용")
                with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": "rotated-shared-presence-password-at-least-32"}):
                    rotated = Auth(store)
                    other = "fountain_session=" + rotated.login({"token": "rotated-shared-presence-password-at-least-32"})
                    self.assertEqual(PresenceService(store, rotated).snapshot("welcome", other)["participants"], [])
                    self.assertIsNone(store.get("session", app.auth._digest(cookie)))
            finally:
                store.close()


class PresenceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""})
        self.environment.start()
        self.directory = tempfile.TemporaryDirectory()
        self.server = create_server(port=0, db_path=Path(self.directory.name) / "presence.db")
        self.app, self.store = self.server.application, self.server.application.store
        account_setup(self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.owner, self.owner_info = self.login("local@fountain.local")
        self.family, self.family_info = self.login("family@example.com")
        self.document = self.request("GET", "/api/pages/welcome/collaboration", cookie=self.owner)[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.store.close()
        self.directory.cleanup()
        self.environment.stop()

    def request(self, method, path, body=None, cookie=""):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        connection.request(method, path, json.dumps(body) if body is not None else None,
            {"Content-Type": "application/json", "X-Fountain-Request": "1", "Cookie": cookie})
        response = connection.getresponse()
        raw = response.read()
        result = response.status, json.loads(raw) if raw else None, response.getheader("Set-Cookie", "")
        connection.close()
        return result

    def login(self, email):
        status, info, cookie = self.request("POST", "/api/session", {"email": email, "password": PASSWORD})
        self.assertEqual(status, 200)
        return cookie.split(";", 1)[0], info

    def body(self, seq=1, info=None, client="tab"):
        return {"session_binding": (info or self.family_info)["cache_binding"], "epoch": self.document["epoch"], "client_id": client, "seq": seq, "selection": None}

    @staticmethod
    def event(response):
        event = "message"
        for _ in range(50):
            line = response.readline()
            if not line: return None, None
            if line.startswith(b"event: "): event = line[7:].strip().decode()
            if line.startswith(b"data: "): return event, json.loads(line[6:])
        raise AssertionError("No SSE event")

    def test_presence_only_sse_events_do_not_repeat_document_or_change_sequence(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        connection.request("GET", "/api/pages/welcome/events", headers={"Cookie": self.owner})
        response = connection.getresponse()
        try:
            name, snapshot = self.event(response)
            self.assertEqual(name, "snapshot")
            self.assertEqual(self.event(response)[0], "presence")
            before_page, before_document, before_audit = self.store.get("page", "welcome"), self.store.get("collaboration", "welcome"), self.store.list("audit")
            self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(), self.family)[0], 200)
            name, presence = self.event(response)
            self.assertEqual(name, "presence")
            self.assertEqual(presence["participants"][0]["member_id"], "family")
            self.assertEqual(presence["epoch"], snapshot["epoch"])
            self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(seq=2), self.family)[0], 200)
            name, moved = self.event(response)
            self.assertEqual(name, "presence")
            self.assertGreater(moved["revision"], presence["revision"])
            self.assertEqual(moved["participants"][0]["seq"], 2)
            self.assertEqual(self.store.get("page", "welcome"), before_page)
            self.assertEqual(self.store.get("collaboration", "welcome"), before_document)
            self.assertEqual(self.store.list("audit"), before_audit)
        finally:
            response.close()
            connection.close()

    def test_read_only_http_selection_and_live_permission_revocation(self):
        permissions = {"permissions": {"default": "private", "members": {"family": "view"}, "groups": {}, "inherit": False}}
        self.assertEqual(self.request("PATCH", "/api/pages/welcome/permissions", permissions, self.owner)[0], 200)
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(), self.family)[0], 200)
        self.assertEqual(self.request("PUT", "/api/pages/welcome/blocks", {"blocks": []}, self.family)[0], 403)
        permissions["permissions"]["members"] = {}
        self.assertEqual(self.request("PATCH", "/api/pages/welcome/permissions", permissions, self.owner)[0], 200)
        self.assertEqual(self.request("GET", "/api/pages/welcome/presence", cookie=self.owner)[1]["participants"], [])
        self.assertEqual(self.request("GET", "/api/pages/welcome/presence", cookie=self.family)[0], 404)

    def test_http_session_isolation_logout_and_stale_binding(self):
        another, info = self.login("family@example.com")
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(), self.family)[0], 200)
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(info=info), another)[0], 200)
        participants = self.request("GET", "/api/pages/welcome/presence", cookie=self.owner)[1]["participants"]
        self.assertEqual(len(participants), 2)
        leave = self.body(seq=2)
        leave.pop("selection")
        self.assertEqual(len(self.request("DELETE", "/api/pages/welcome/presence", leave, self.family)[1]["participants"]), 1)
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(seq=3, info=info), self.family)[0], 403)
        self.assertEqual(self.request("DELETE", "/api/session", cookie=another)[0], 200)
        self.assertEqual(self.request("GET", "/api/pages/welcome/presence", cookie=self.owner)[1]["participants"], [])
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(seq=2, info=info), another)[0], 401)
        spoof = {**self.body(seq=4), "name": "owner", "member_id": "local"}
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", spoof, self.family)[0], 400)

    def test_http_password_reset_and_independent_store_session_expiry_revoke_publishers(self):
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(), self.family)[0], 200)
        password = "new-presence-http-password"
        self.assertEqual(self.request("PATCH", "/api/accounts/family", {"password": password}, self.owner)[0], 200)
        self.assertEqual(self.request("GET", "/api/pages/welcome/presence", cookie=self.owner)[1]["participants"], [])
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(seq=2), self.family)[0], 401)
        status, info, cookie = self.request("POST", "/api/session", {"email": "family@example.com", "password": password})
        self.assertEqual(status, 200)
        self.family, self.family_info = cookie.split(";", 1)[0], info
        self.assertEqual(self.request("PUT", "/api/pages/welcome/presence", self.body(seq=3), self.family)[0], 200)
        other = Store(Path(self.directory.name) / "presence.db")
        try:
            session = other.get("session", self.app.auth._digest(self.family))
            session["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            other.put("session", session)
            self.assertEqual(self.request("GET", "/api/pages/welcome/presence", cookie=self.owner)[1]["participants"], [])
            self.assertEqual(self.request("GET", "/api/pages/welcome/presence", cookie=self.family)[0], 401)
        finally:
            other.close()

    def test_sse_viewer_revocation_sends_denied_and_closes(self):
        permissions = {"permissions": {"default": "private", "members": {"family": "view"}, "groups": {}, "inherit": False}}
        self.request("PATCH", "/api/pages/welcome/permissions", permissions, self.owner)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        connection.request("GET", "/api/pages/welcome/events", headers={"Cookie": self.family})
        response = connection.getresponse()
        try:
            self.assertEqual(self.event(response)[0], "snapshot")
            self.assertEqual(self.event(response)[0], "presence")
            permissions["permissions"]["members"] = {}
            self.request("PATCH", "/api/pages/welcome/permissions", permissions, self.owner)
            name, denied = self.event(response)
            self.assertEqual(name, "denied")
            self.assertEqual(denied["status"], 404)
        finally:
            response.close()
            connection.close()


if __name__ == "__main__": unittest.main()
