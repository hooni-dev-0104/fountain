import json
import os
import unittest
from unittest.mock import patch

from fountain.auth import Auth, SESSION_COOKIE
from fountain.core import APIError, Store, Workspace


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""})
        self.environment.start()
        self.store = Store(":memory:")
        Workspace(self.store)
        self.auth = Auth(self.store)
        self.store.put("member", {"id": "family", "name": "가족", "email": "family@example.com", "role": "member"})
        self.password = "우리 가족의 안전한 비밀번호 123"

    def tearDown(self):
        self.store.close()
        self.environment.stop()

    def login(self, email="local@fountain.local", password=None):
        token = self.auth.login({"email": email, "password": password or self.password})
        return f"{SESSION_COOKIE}={token}"

    def enable(self):
        self.auth.create_account("local", self.password)
        self.auth.enable_accounts()

    def test_salted_scrypt_and_safe_account_descriptors(self):
        descriptor = self.auth.create_account("local", self.password)
        self.auth.create_account("family", self.password)
        owner = self.store.get("credential", "local")
        family = self.store.get("credential", "family")
        self.assertEqual(owner["algorithm"], "scrypt")
        self.assertNotEqual(owner["salt"], family["salt"])
        self.assertNotEqual(owner["password_hash"], family["password_hash"])
        self.assertNotIn(self.password, json.dumps(self.store.list("credential")))
        self.assertEqual(descriptor["role"], "owner")
        self.assertTrue(descriptor["has_account"])
        for item in self.auth.list_accounts():
            self.assertNotIn("password_hash", item)
            self.assertNotIn("salt", item)
        with self.assertRaises(APIError): self.auth.create_account("local", self.password)

    def test_enabling_requires_owner_and_removes_legacy_sessions(self):
        with self.assertRaises(APIError): self.auth.enable_accounts()
        self.auth.create_account("family", self.password)
        with self.assertRaises(APIError): self.auth.enable_accounts()
        self.auth.create_account("local", self.password)
        self.store.put("session", {"id": "legacy", "credential_tag": "unused"})
        self.auth.enable_accounts()
        self.assertTrue(self.auth.enabled)
        self.assertTrue(self.auth.accounts_required)
        self.assertEqual(self.store.list("session"), [])
        self.assertFalse(self.auth.authenticate(None))
        self.assertIsNone(self.auth.principal(None))
        self.assertEqual(self.auth.session_info(None)["mode"], "accounts")
        self.assertTrue(self.auth.session_info(None)["required"])

    def test_login_principal_has_realtime_member_role_and_shared_token_is_disabled(self):
        self.enable()
        self.auth.create_account("family", self.password)
        cookie = self.login("  FAMILY@example.com  ")
        self.assertTrue(self.auth.authenticate(cookie))
        principal = self.auth.principal(cookie)
        self.assertEqual(principal["id"], "family")
        self.assertEqual(principal["role"], "member")
        member = self.store.get("member", "family")
        member["role"] = "guest"
        self.store.put("member", member)
        self.assertEqual(self.auth.principal(cookie)["role"], "guest")
        self.assertEqual(self.auth.session_info(cookie)["member"]["role"], "guest")
        with self.assertRaises(APIError) as error: self.auth.login({"token": "unused-legacy-token"})
        self.assertEqual(error.exception.status, 401)

    def test_password_change_deactivation_and_deletion_revoke_sessions(self):
        self.enable()
        self.auth.create_account("family", self.password)
        old = self.login("family@example.com")
        self.auth.set_password("family", "replacement password 123")
        self.assertFalse(self.auth.authenticate(old))
        current = self.login("family@example.com", "replacement password 123")
        self.assertTrue(self.auth.authenticate(current))
        member = self.store.get("member", "family")
        member["active"] = False
        self.store.put("member", member)
        self.assertFalse(self.auth.authenticate(current))
        member["active"] = True
        self.store.put("member", member)
        self.assertFalse(self.auth.authenticate(current))
        cookie = self.login("family@example.com", "replacement password 123")
        self.store.delete("member", "family")
        self.assertFalse(self.auth.authenticate(cookie))

    def test_owner_password_reset_does_not_lock_out_and_last_owner_cannot_be_removed(self):
        self.enable()
        original = self.login()
        self.auth.set_password("local", "new owner password 123")
        self.assertFalse(self.auth.authenticate(original))
        self.assertTrue(self.auth.authenticate(self.login(password="new owner password 123")))
        with self.assertRaises(APIError) as error: self.auth.remove_account("local")
        self.assertEqual(error.exception.status, 409)
        family = self.store.get("member", "family")
        family["role"] = "owner"
        self.store.put("member", family)
        self.auth.create_account("family", self.password)
        self.auth.remove_account("local")
        self.assertIsNone(self.store.get("credential", "local"))
        self.assertTrue(self.auth.authenticate(self.login("family@example.com")))

    def test_invalid_account_logins_have_uniform_errors_and_execute_scrypt(self):
        self.enable()
        attempts = [{"email": "absent@example.com", "password": "wrong"},
                    {"email": "local@fountain.local", "password": "wrong"},
                    {"email": "local@fountain.local", "password": None}, {}]
        with patch.object(self.auth, "_password_hash", wraps=self.auth._password_hash) as hashing:
            for body in attempts:
                with self.assertRaises(APIError) as error: self.auth.login(body)
                self.assertEqual(error.exception.status, 401)
                self.assertEqual(error.exception.message, "Email or password is incorrect")
            self.assertEqual(hashing.call_count, len(attempts))

    def test_password_bounds_account_email_uniqueness_and_rate_limit(self):
        for password in ["short", "x" * 1025, None]:
            with self.assertRaises(APIError): self.auth.create_account("local", password)
        self.enable()
        family = self.store.get("member", "family")
        family["email"] = "LOCAL@fountain.local"
        self.store.put("member", family)
        with self.assertRaises(APIError): self.auth.create_account("family", self.password)
        with patch("fountain.auth.time.monotonic", return_value=100):
            with patch.object(self.auth, "_password_hash", return_value="0" * 64):
                for _ in range(10):
                    with self.assertRaises(APIError): self.auth.login({"email": "absent", "password": "wrong"}, "ip")
                with self.assertRaises(APIError) as error: self.auth.login({"email": "absent", "password": "wrong"}, "ip")
                self.assertEqual(error.exception.status, 429)

    def test_offline_password_reset_uses_hidden_input_and_never_creates_missing_database(self):
        import contextlib
        import io
        import tempfile
        from pathlib import Path
        from fountain.auth import main
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.db"
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(["reset", "local", "--data", str(path)]), 1)
            self.assertFalse(path.exists())
            store = Store(path)
            Workspace(store)
            store.close()
            output = io.StringIO()
            with patch("getpass.getpass", side_effect=[self.password, self.password]), contextlib.redirect_stdout(output):
                self.assertEqual(main(["reset", "local", "--data", str(path)]), 0)
            self.assertNotIn(self.password, output.getvalue())
            store = Store(path)
            try:
                auth = Auth(store)
                auth.enable_accounts()
                self.assertTrue(auth.login({"email": "local@fountain.local", "password": self.password}))
            finally:
                store.close()

    def test_local_bootstrap_and_existing_shared_mode_remain_compatible(self):
        self.assertEqual(self.auth.principal(None)["role"], "owner")
        self.assertEqual(self.auth.session_info(None)["mode"], "local")
        self.assertFalse(self.auth.accounts_required)
        with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": "shared-family-secret-32-characters"}):
            shared = Auth(self.store)
            token = shared.login({"token": "shared-family-secret-32-characters"})
            cookie = f"{SESSION_COOKIE}={token}"
            self.assertEqual(shared.principal(cookie)["role"], "owner")
            self.assertEqual(shared.session_info(cookie)["mode"], "family")
            self.auth.create_account("local", self.password)
            shared.enable_accounts()
            self.assertFalse(shared.authenticate(cookie))
            with self.assertRaises(APIError): shared.login({"token": "shared-family-secret-32-characters"})


if __name__ == "__main__": unittest.main()
