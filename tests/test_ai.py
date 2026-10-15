import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from fountain.advanced import Advanced, AdvancedError
from fountain.core import Store, Workspace


class AIAdapterTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        requests = self.requests
        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                requests.append({'auth': self.headers.get('Authorization'), 'body': json.loads(self.rfile.read(int(self.headers['Content-Length'])))})
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'choices': [{'message': {'content': 'TEST FIXTURE SUMMARY'}}]}).encode())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.store = Store(':memory:')
        self.advanced = Advanced(self.store, Workspace(self.store))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()

    def test_local_model_does_not_require_paid_key_and_receives_document(self):
        with patch.dict(os.environ, {'FOUNTAIN_AI_KEY': '', 'FOUNTAIN_AI_MODEL': 'test-fixture-model',
                                     'FOUNTAIN_AI_URL': f'http://127.0.0.1:{self.server.server_port}/v1/chat/completions'}):
            result = self.advanced.ai({'action': 'summarize', 'prompt': '요약', 'page_id': 'welcome'})
            self.assertTrue(self.advanced.capabilities()['ai_configured'])
        self.assertEqual(result['text'], 'TEST FIXTURE SUMMARY')
        self.assertIsNone(self.requests[0]['auth'])
        self.assertEqual(self.requests[0]['body']['model'], 'test-fixture-model')
        self.assertIn('시작하기', self.requests[0]['body']['messages'][1]['content'])
        self.assertEqual(result['citations'], [{'page_id': 'welcome'}])

    def test_remote_http_endpoint_rejected_before_any_network_request(self):
        with patch.dict(os.environ, {'FOUNTAIN_AI_KEY': 'test', 'FOUNTAIN_AI_MODEL': 'test', 'FOUNTAIN_AI_URL': 'http://remote.example/v1/chat/completions'}):
            with self.assertRaises(AdvancedError) as caught:
                self.advanced.ai({'prompt': '검증'})
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(self.requests, [])


if __name__ == '__main__': unittest.main()
