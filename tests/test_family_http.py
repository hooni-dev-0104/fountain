import http.client
import json
import os
import threading
import unittest
from unittest.mock import patch

from fountain.core import APIError
from fountain.server import create_server


class FamilyHTTPTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN': 'family-test-password-12345'})
        self.environment.start()
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.application.store.close()
        self.thread.join()
        self.environment.stop()

    def request(self, method, path, body=None, cookie=''):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, json.dumps(body) if body is not None else None,
                     {'Content-Type': 'application/json', 'X-Fountain-Request': '1', 'Cookie': cookie})
        response = conn.getresponse()
        raw = response.read()
        data = json.loads(raw) if raw and 'json' in response.getheader('Content-Type', '') else raw.decode()
        result = (response.status, data, response.getheader('Set-Cookie', ''))
        conn.close()
        return result

    def test_private_data_requires_family_session_then_logout_revokes(self):
        self.assertEqual(self.request('GET', '/api/workspace')[0], 401)
        self.assertEqual(self.request('GET', '/api/advanced')[0], 401)
        self.assertEqual(self.request('GET', '/sites/guide')[0], 401)
        status, info, _ = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        self.assertTrue(info['required'])
        self.assertFalse(info['authenticated'])
        self.assertEqual(self.request('POST', '/api/session', {'token': 'wrong'})[0], 401)
        status, data, cookie = self.request('POST', '/api/session', {'token': 'family-test-password-12345'})
        self.assertEqual(status, 200)
        self.assertNotIn('token', data)
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        cookie = cookie.split(';')[0]
        self.assertEqual(self.request('GET', '/api/workspace', cookie=cookie)[0], 200)
        self.assertEqual(self.request('POST', '/api/pages', {'title': '가족 공유'}, cookie)[0], 201)
        self.assertEqual(self.request('DELETE', '/api/session', cookie=cookie)[0], 200)
        self.assertEqual(self.request('GET', '/api/workspace', cookie=cookie)[0], 401)

    def test_lan_mode_requires_authentication_and_explicit_host(self):
        with self.assertRaises(APIError):
            create_server(host='0.0.0.0', port=0, db_path=':memory:')
        with patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN': ''}), self.assertRaises(APIError):
            create_server(host='0.0.0.0', port=0, db_path=':memory:', allowed_hosts=['192.168.1.20'])


if __name__ == '__main__':
    unittest.main()
