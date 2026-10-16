import hashlib
import http.client
import json
import os
import secrets
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fountain.auth import Auth, COOKIE_ATTRIBUTES, SESSION_COOKIE
from fountain.core import APIError, Store, Workspace
from fountain.server import create_server

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

    def test_logout_binding_rejects_another_login_without_deleting_either(self):
        first = self.auth.login({"token": SECRET})
        first_binding = self.auth.session_info(self.cookie(first))["cache_binding"]
        second = self.auth.login({"token": SECRET})
        with self.assertRaises(APIError) as error:
            self.auth.logout(self.cookie(second), first_binding)
        self.assertEqual(error.exception.status, 409)
        self.assertTrue(self.auth.authenticate(self.cookie(first)))
        self.assertTrue(self.auth.authenticate(self.cookie(second)))
        self.auth.logout(self.cookie(first), first_binding)
        self.assertFalse(self.auth.authenticate(self.cookie(first)))
        self.assertTrue(self.auth.authenticate(self.cookie(second)))

    def test_expired_logout_binding_retry_is_idempotent_and_validated(self):
        token = self.auth.login({"token": SECRET})
        binding = self.auth.session_info(self.cookie(token))["cache_binding"]
        self.auth.logout(self.cookie(token), binding)
        self.auth.logout(self.cookie(token), binding)
        self.assertFalse(self.auth.authenticate(self.cookie(token)))
        for invalid in (False, 1, {}, "", "x" * 1001):
            with self.subTest(binding=invalid), self.assertRaises(APIError) as error:
                self.auth.logout("", invalid)
            self.assertEqual(error.exception.status, 400)

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


class LocalSessionRenewalTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN': ''})
        self.environment.start()
        self.store = Store(':memory:')
        Workspace(self.store)
        self.auth = Auth(self.store)
        self.info = self.auth.session_info('')

    def tearDown(self):
        self.store.close()
        self.environment.stop()

    def test_only_explicit_renewal_changes_the_local_binding(self):
        original = self.info['cache_binding']
        for _ in range(2):
            self.assertEqual(self.auth.session_info('')['cache_binding'], original)
            with self.assertRaises(APIError) as error:
                self.auth.login({})
            self.assertEqual(error.exception.status, 409)
        result = self.auth.renew_local({'cache_binding': original}, '')
        self.assertNotEqual(result['cache_binding'], original)
        self.assertEqual(result, {**self.info, 'cache_binding': result['cache_binding']})
        self.assertEqual(self.store.list('session'), [])
        self.assertEqual(self.auth.session_info(''), result)
        self.assertEqual(self.auth.renew_local({'cache_binding': original}, ''), result)

    def test_concurrent_and_stale_retries_share_one_replacement(self):
        body = {'cache_binding': self.info['cache_binding']}
        with patch('fountain.auth.secrets.token_hex', wraps=secrets.token_hex) as nonce:
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: self.auth.renew_local(body, ''), range(16)))
            self.assertEqual(nonce.call_count, 1)
        self.assertEqual(len({result['cache_binding'] for result in results}), 1)
        self.assertNotEqual(results[0]['cache_binding'], body['cache_binding'])
        self.assertEqual(self.auth.renew_local({'cache_binding': '0' * 32}, ''), results[0])

    def test_malformed_requests_preserve_the_binding(self):
        binding = self.info['cache_binding']
        for body in (None, [], {}, {'cache_binding': None}, {'cache_binding': True},
                     {'cache_binding': ''}, {'cache_binding': 'x' * 257},
                     {'cache_binding': binding.upper()}, {'cache_binding': '가' * 32},
                     {'cache_binding': binding, 'member_id': 'local'}):
            with self.subTest(body=body), self.assertRaises(APIError) as error:
                self.auth.renew_local(body, '')
            self.assertEqual(error.exception.status, 400)
            self.assertEqual(self.auth.session_info('')['cache_binding'], binding)

    def test_account_cookie_and_required_account_mode_cannot_renew_local(self):
        self.auth.create_account('local', 'test-password-123')
        raw = self.auth.login({'email': 'local@fountain.local', 'password': 'test-password-123'})
        cookie = SESSION_COOKIE + '=' + raw
        self.assertFalse(self.auth.enabled)
        self.assertEqual(self.auth.session_info(cookie)['mode'], 'accounts')
        with self.assertRaises(APIError) as error:
            self.auth.renew_local({'cache_binding': self.info['cache_binding']}, cookie)
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.auth.session_info('')['cache_binding'], self.info['cache_binding'])
        self.auth.enable_accounts()
        with self.assertRaises(APIError) as error:
            self.auth.renew_local({'cache_binding': self.info['cache_binding']}, '')
        self.assertEqual(error.exception.status, 403)

    def test_family_mode_cannot_renew_with_or_without_a_cookie(self):
        with patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN': SECRET}):
            shared = Auth(self.store)
            cookie = SESSION_COOKIE + '=' + shared.login({'token': SECRET})
            for supplied in ('', cookie):
                with self.assertRaises(APIError) as error:
                    shared.renew_local({'cache_binding': self.info['cache_binding']}, supplied)
                self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.auth.session_info('')['cache_binding'], self.info['cache_binding'])


class LocalSessionRenewalHTTPTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN': ''})
        self.environment.start()
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.server.application.store.close()
        self.environment.stop()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        defaults = {'Content-Type': 'application/json', 'X-Fountain-Request': '1'}
        defaults.update(headers or {})
        connection.request(method, path, json.dumps(body) if body is not None else None, defaults)
        response = connection.getresponse()
        payload = json.loads(response.read())
        result = response.status, payload, response.getheader('Set-Cookie')
        connection.close()
        return result

    def test_explicit_renewal_has_no_cookie_and_preserves_other_session_routes(self):
        before = self.request('GET', '/api/session')[1]
        self.assertEqual(self.request('POST', '/api/session', {})[0], 409)
        result = self.request('POST', '/api/session/renew-local', {'cache_binding': before['cache_binding']})
        self.assertEqual(result[0], 200)
        self.assertIsNone(result[2])
        self.assertNotEqual(result[1]['cache_binding'], before['cache_binding'])
        for method in ('GET', 'HEAD', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'):
            if method == 'HEAD':
                connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
                connection.request(method, '/api/session/renew-local')
                response = connection.getresponse()
                self.assertEqual(response.status, 405)
                response.read()
                connection.close()
            else:
                self.assertEqual(self.request(method, '/api/session/renew-local', {})[0], 405)
        self.assertEqual(self.request('GET', '/api/session')[1], result[1])

    def test_logout_binding_mismatch_does_not_clear_cookie_or_rotate_local_session(self):
        before = self.request('GET', '/api/session')[1]
        status, _, cookie = self.request('DELETE', '/api/session', {'cache_binding': 'stale-binding'})
        self.assertEqual(status, 409)
        self.assertIsNone(cookie)
        self.assertEqual(self.request('GET', '/api/session')[1], before)
        status, _, cookie = self.request('DELETE', '/api/session', {'cache_binding': before['cache_binding']})
        self.assertEqual(status, 200)
        self.assertIn('Max-Age=0', cookie)
        self.assertNotEqual(self.request('GET', '/api/session')[1]['cache_binding'], before['cache_binding'])

    def test_origin_host_header_and_json_validation_apply_before_renewal(self):
        before = self.request('GET', '/api/session')[1]
        body = {'cache_binding': before['cache_binding']}
        for headers in ({'Origin': 'https://evil.example'}, {'Origin': 'null'},
                        {'Host': 'evil.example'}, {'X-Fountain-Request': ''}):
            self.assertEqual(self.request('POST', '/api/session/renew-local', body, headers)[0], 403)
        for malformed in ({}, {'cache_binding': None}, {'cache_binding': body['cache_binding'], 'extra': 1}, []):
            self.assertEqual(self.request('POST', '/api/session/renew-local', malformed)[0], 400)
        self.assertEqual(self.request('GET', '/api/session')[1], before)

    def test_existing_local_sse_is_fenced_by_the_new_binding(self):
        app = self.server.application
        app.workspace.create_page({'id': 'local-renewal-stream', 'title': 'Local stream'})
        before = self.request('GET', '/api/session')[1]
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        self.addCleanup(connection.close)
        connection.request('GET', '/api/pages/local-renewal-stream/events')
        response = connection.getresponse()
        self.addCleanup(response.close)
        self.assertEqual(response.status, 200)

        def event():
            name = None
            for _ in range(30):
                line = response.fp.readline().decode().strip()
                if line.startswith('event: '): name = line[7:]
                if line.startswith('data: ') and name != 'presence':
                    return name, json.loads(line[6:])
            self.fail('No document SSE event received')

        self.assertEqual(event()[1]['session_binding'], before['cache_binding'])
        renewed = self.request('POST', '/api/session/renew-local', {'cache_binding': before['cache_binding']})
        self.assertEqual(renewed[0], 200)
        name, payload = event()
        self.assertEqual((name, payload['status']), ('denied', 401))
        snapshot = self.request('GET', '/api/pages/local-renewal-stream/collaboration')[1]
        self.assertEqual(snapshot['session_binding'], renewed[1]['cache_binding'])


if __name__ == "__main__": unittest.main()
