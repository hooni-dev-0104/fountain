import hashlib
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fountain.auth import Auth, COOKIE_ATTRIBUTES, SESSION_COOKIE
from fountain.core import APIError, Store

SECRET = "shared-family-secret-at-least-32-characters"


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": SECRET})
        self.environment.start()
        self.auth = Auth(self.store)

    def tearDown(self):
        self.environment.stop()
        self.store.close()

    def cookie(self, token):
        return f"{SESSION_COOKIE}={token}"

    def test_login_stores_only_hashed_session_and_shared_identity(self):
        raw = self.auth.login({"token": SECRET})
        session = self.store.list("session")[0]
        self.assertEqual(session["id"], hashlib.sha256(raw.encode()).hexdigest())
        stored = json.dumps(session)
        self.assertNotIn(raw, stored)
        self.assertNotIn(SECRET, stored)
        self.assertTrue(self.auth.authenticate(self.cookie(raw)))
        info = self.auth.session_info(self.cookie(raw))
        self.assertTrue(info["authenticated"])
        self.assertEqual(info["mode"], "family")
        self.assertEqual(info["identity"], "가족 공용")
        expiry = datetime.fromisoformat(session["expires_at"])
        self.assertGreater(expiry, datetime.now(timezone.utc) + timedelta(days=6))
        self.assertIn("HttpOnly", COOKIE_ATTRIBUTES)
        self.assertIn("SameSite=Strict", COOKIE_ATTRIBUTES)

    def test_invalid_credentials_and_untrusted_cookie_do_not_authenticate(self):
        for body, expected in [({}, 400), ({"token": None}, 400), ({"token": "bad"}, 401), ({"token": "잘못된 암호"}, 401)]:
            with self.subTest(body=body), self.assertRaises(APIError) as error:
                self.auth.login(body)
            self.assertEqual(error.exception.status, expected)
        for cookie in [None, "", "malformed", "fountain_session=bad", "fountain_session=" + "A" * 43,
                       "fountain_session=" + "A" * 9000]:
            self.assertFalse(self.auth.authenticate(cookie))
        self.assertFalse(self.auth.session_info("")["authenticated"])

    def test_cookie_parsing_logout_and_rotation(self):
        raw = self.auth.login({"token": SECRET})
        cookie = f'other=value; {SESSION_COOKIE}="{raw}"'
        self.assertTrue(self.auth.authenticate(cookie))
        self.assertFalse(self.auth.authenticate(self.cookie(raw) + "; " + self.cookie(raw)))
        with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": "new-shared-family-secret-32-characters"}):
            self.assertFalse(Auth(self.store).authenticate(cookie))
        raw = self.auth.login({"token": SECRET})
        self.auth.logout(self.cookie(raw))
        self.assertFalse(self.auth.authenticate(self.cookie(raw)))
        self.auth.logout("invalid")

    def test_expired_sessions_are_rejected_and_removed(self):
        raw = self.auth.login({"token": SECRET})
        session = self.store.list("session")[0]
        session["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        self.store.put("session", session)
        self.assertFalse(self.auth.authenticate(self.cookie(raw)))
        self.assertEqual(self.store.list("session"), [])
        raw = self.auth.login({"token": SECRET})
        session = self.store.list("session")[0]
        session["expires_at"] = "invalid"
        self.store.put("session", session)
        self.assertFalse(self.auth.authenticate(self.cookie(raw)))

    def test_ten_attempts_per_minute_per_client_with_no_sleep(self):
        with patch("fountain.auth.time.monotonic", return_value=100):
            for _ in range(10):
                with self.assertRaises(APIError) as error: self.auth.login({"token": "bad"}, "one")
                self.assertEqual(error.exception.status, 401)
            with self.assertRaises(APIError) as error: self.auth.login({"token": SECRET}, "one")
            self.assertEqual(error.exception.status, 429)
            self.assertTrue(self.auth.login({"token": SECRET}, "two"))
        with patch("fountain.auth.time.monotonic", return_value=161):
            self.assertTrue(self.auth.login({"token": SECRET}, "one"))

    def test_local_mode_and_invalid_configuration(self):
        with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""}):
            local = Auth(self.store)
            self.assertFalse(local.enabled)
            self.assertTrue(local.authenticate(None))
            self.assertEqual(local.session_info(None)["mode"], "local")
            with self.assertRaises(APIError) as error: local.login({"token": "unused"})
            self.assertEqual(error.exception.status, 409)
        with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": "too-short"}):
            with self.assertRaises(APIError) as error: Auth(self.store)
            self.assertEqual(error.exception.status, 503)


if __name__ == "__main__": unittest.main()
