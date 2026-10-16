import http.client
import json
import os
import threading
import unittest
from unittest.mock import patch

from fountain.server import create_server


class EnterpriseHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.application.store.close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, json.dumps(body) if body is not None else None,
                     {'Content-Type': 'application/json', **(headers or {})})
        response = conn.getresponse()
        data = response.read()
        result = json.loads(data) if data and 'json' in response.getheader('Content-Type', '') else data.decode()
        status = response.status
        conn.close()
        return status, result

    def test_scim_requires_configured_bearer_and_supports_scim_clients(self):
        with patch.dict(os.environ, {'FOUNTAIN_SCIM_TOKEN': ''}):
            self.assertEqual(self.request('GET', '/scim/v2/Users')[0], 503)
        with patch.dict(os.environ, {'FOUNTAIN_SCIM_TOKEN': 'test-only-secret'}):
            self.assertEqual(self.request('GET', '/scim/v2/Users')[0], 401)
            auth = {'Authorization': 'Bearer test-only-secret', 'Content-Type': 'application/scim+json'}
            status, user = self.request('POST', '/scim/v2/Users', {'userName': 'test@example.org'}, auth)
            self.assertEqual(status, 201)
            self.assertEqual(self.request('GET', '/scim/v2/Users/' + user['id'], headers=auth)[0], 200)
            status, raw = self.request('DELETE', '/scim/v2/Users/' + user['id'], headers=auth)
            self.assertEqual(status, 204)
            self.assertEqual(raw, '')

    def test_failed_multi_action_automation_rolls_back_all_writes(self):
        app = self.server.application
        row = app.workspace.create_row('projects', {'values': {'name': '원래'}})
        _, automation = app.dispatch('POST', '/api/automations', {'name': '트랜잭션', 'actions': [
            {'type': 'set_property', 'property_id': 'name', 'value': '변경'},
            {'type': 'set_property', 'property_id': 'name', 'value': {'invalid': True}}]}, {})
        status, _ = self.request('POST', '/api/automations/' + automation['id'] + '/run', {'row_id': row['id']}, {'X-Fountain-Request': '1'})
        self.assertEqual(status, 400)
        self.assertEqual(app.store.get('row', row['id'])['properties']['name'], '원래')

    def test_export_policy_and_public_html(self):
        headers = {'X-Fountain-Request': '1'}
        status, site = self.request('POST', '/api/sites', {'name': '가이드', 'page_id': 'welcome', 'slug': 'guide', 'published': True}, headers)
        self.assertEqual(status, 201)
        status, content = self.request('GET', '/sites/guide')
        self.assertEqual(status, 200)
        self.assertIn('<!doctype html>', content)
        self.assertEqual(self.request('PATCH', '/api/settings', {'disable_export': True, 'disable_public_sharing': True}, headers)[0], 200)
        self.assertEqual(self.request('GET', '/api/export')[0], 403)
        self.assertEqual(self.request('GET', '/sites/guide')[0], 404)

    def test_ai_provider_wait_does_not_block_family_document_reads(self):
        from concurrent.futures import ThreadPoolExecutor
        entered, release = threading.Event(), threading.Event()
        # Initialize workflows before replacing only the external inference boundary.
        self.server.application.dispatch('GET', '/api/capabilities', {}, {})
        def slow_provider(body):
            entered.set()
            if not release.wait(5):
                raise AssertionError('test provider was not released')
            return {'text': 'TEST FIXTURE', 'provider': 'fixture', 'model': body['model'], 'citations': []}
        with patch.dict(os.environ, {'FOUNTAIN_AI_MODEL': 'fixture', 'FOUNTAIN_AI_KEY': '',
                                     'FOUNTAIN_AI_URL': 'http://127.0.0.1:1/v1/chat/completions'}), \
                patch.object(self.server.application.advanced, 'infer_ai', slow_provider):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.request, 'POST', '/api/ai', {'prompt': '검증'}, {'X-Fountain-Request': '1'})
                try:
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(self.request('GET', '/api/workspace')[0], 200)
                finally:
                    release.set()
                self.assertEqual(pending.result(timeout=2)[0], 200)


if __name__ == '__main__':
    unittest.main()
