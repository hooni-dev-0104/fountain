"""Real HTTP/provider races across independent connections to generated SQLite."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

from fountain.auth import Auth
from fountain.server import create_server


class AIAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.servers, self.threads = [], []
        self.requests = []
        self.provider_entered, self.provider_reply = threading.Event(), threading.Event()
        self.provider_reply.set()
        self.addCleanup(self.cleanup)
        fixture = self
        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                fixture.requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                fixture.provider_entered.set()
                if not fixture.provider_reply.wait(8):
                    raise AssertionError('Fixture provider was not released')
                payload = json.dumps({'choices': [{'message': {'content': 'EXTERNAL PRIVATE ANSWER'}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        self.provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        self.provider_thread = threading.Thread(target=self.provider.serve_forever, daemon=True)
        self.provider_thread.start()
        self.environment = patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN': '', 'FOUNTAIN_AI_KEY': '',
            'FOUNTAIN_AI_MODEL': 'authorization-fixture',
            'FOUNTAIN_AI_URL': f'http://127.0.0.1:{self.provider.server_port}/v1/chat/completions'})
        self.environment.start()
        for _ in range(2):
            self.servers.append(create_server(port=0, db_path=Path(self.folder.name) / 'generated.db'))
        self.apps = [server.application for server in self.servers]
        self.store = self.apps[0].store
        self.store.put('member', {'id': 'family', 'role': 'member', 'name': '가족', 'email': 'family@example.local'})
        password = 'Generated-AI-fixture-password-2026'
        for member in ('local', 'family'):
            self.apps[0].auth.create_account(member, password)
        self.apps[0].auth.enable_accounts()
        self.owner = 'fountain_session=' + self.apps[0].auth.login({'email': 'local@fountain.local', 'password': password})
        self.family = 'fountain_session=' + self.apps[1].auth.login({'email': 'family@example.local', 'password': password})
        page = self.apps[0].workspace.create_page({'title': 'AUTHORIZED TITLE',
            'blocks': [{'id': 'text', 'text': 'AUTHORIZED ORIGINAL CONTEXT'}],
            'permissions': {'default': 'private', 'members': {'family': 'view'}}})
        self.page_id, self.path = page['id'], '/api/pages/' + page['id']
        for app in self.apps:
            app.dispatch('GET', '/api/capabilities', {}, {})
        for server in self.servers:
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
            thread.start()
            self.threads.append(thread)

    def cleanup(self):
        self.provider_reply.set()
        for server, thread in zip(self.servers, self.threads):
            if thread.is_alive(): server.shutdown()
        for server in self.servers: server.server_close()
        for thread in self.threads: thread.join()
        for server in self.servers: server.application.store.close()
        self.provider.shutdown()
        self.provider.server_close()
        self.provider_thread.join()
        if hasattr(self, 'environment'): self.environment.stop()
        self.folder.cleanup()

    def request(self, method, path, body=None, *, server=0, cookie=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.servers[server].server_port, timeout=8)
        try:
            connection.request(method, path, json.dumps(body).encode() if body is not None else None,
                {'Content-Type': 'application/json', 'X-Fountain-Request': '1',
                 'Cookie': self.family if cookie is None else cookie})
            response = connection.getresponse()
            content = response.read()
            return response.status, json.loads(content) if content else None
        finally:
            connection.close()

    def ai(self):
        return self.request('POST', '/api/ai', {'action': 'summarize', 'prompt': '요약', 'page_id': self.page_id})

    def ai_audits(self):
        return [item for item in self.store.list('audit') if item['action'] == 'ai.executed']

    @contextmanager
    def before_inference(self):
        """Gate the external boundary, also reproducing the original unsplit API."""
        entered, release = threading.Event(), threading.Event()
        advanced = self.apps[0].advanced
        original = getattr(advanced, 'infer_ai', advanced.ai)
        def gated(prepared):
            entered.set()
            if not release.wait(8): raise AssertionError('Inference gate was not released')
            return original(prepared)
        with patch.object(advanced, 'ai', gated), patch.object(advanced, 'infer_ai', gated, create=True):
            try: yield entered, release
            finally: release.set()

    def during_provider(self, change, status):
        self.provider_reply.clear()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.ai)
            try:
                self.assertTrue(self.provider_entered.wait(3))
                change()
            finally:
                self.provider_reply.set()
            response_status, result = pending.result(timeout=4)
        self.assertEqual(response_status, status)
        if status != 200:
            self.assertNotIn('EXTERNAL PRIVATE ANSWER', json.dumps(result))
            self.assertEqual(self.ai_audits(), [])
        return result

    def test_revocation_and_later_private_edit_cannot_change_captured_provider_context(self):
        with self.before_inference() as (entered, release), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.ai)
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(self.request('PATCH', self.path + '/permissions',
                    {'permissions': {'default': 'private', 'members': {}}}, server=1, cookie=self.owner)[0], 200)
                self.assertEqual(self.request('PUT', self.path + '/blocks',
                    {'blocks': [{'id': 'text', 'text': 'NEW PRIVATE SECRET AFTER REVOCATION'}]}, server=1, cookie=self.owner)[0], 200)
            finally:
                release.set()
            status, result = pending.result(timeout=4)
        self.assertEqual(len(self.requests), 1)
        sent = json.dumps(self.requests[0], ensure_ascii=False)
        self.assertIn('AUTHORIZED ORIGINAL CONTEXT', sent)
        self.assertNotIn('NEW PRIVATE SECRET', sent)
        self.assertEqual(status, 404)
        self.assertNotIn('EXTERNAL PRIVATE ANSWER', json.dumps(result))
        self.assertEqual(self.ai_audits(), [])

    def test_other_server_logout_before_provider_reply_blocks_result_and_audit(self):
        def logout():
            self.assertEqual(self.request('DELETE', '/api/session', server=1)[0], 200)
        self.during_provider(logout, 401)

    def test_archiving_page_before_provider_reply_blocks_result_and_audit(self):
        def archive():
            self.assertEqual(self.request('PATCH', self.path, {'archived': True}, server=1, cookie=self.owner)[0], 200)
        self.during_provider(archive, 404)

    def test_login_binding_change_blocks_result_even_when_cookie_still_authenticates(self):
        def rotate():
            other = self.apps[1].store
            with other.transaction():
                session = other.get('session', Auth._digest(self.family))
                session['cache_binding'] = uuid.uuid4().hex
                other.put('session', session)
            self.assertTrue(self.apps[1].auth.session_info(self.family)['authenticated'])
        self.during_provider(rotate, 401)

    def test_workspace_change_blocks_result_and_audit(self):
        self.during_provider(lambda: self.apps[1].store.set_meta('workspace_id', uuid.uuid4().hex), 401)

    def test_authenticated_member_change_blocks_result_even_with_same_binding(self):
        def change_member():
            other, auth = self.apps[1].store, self.apps[1].auth
            with other.transaction():
                session = other.get('session', Auth._digest(self.family))
                session['member_id'] = 'local'
                session['credential_tag'] = auth._account_tag(session['id'], other.get('credential', 'local'))
                other.put('session', session)
            self.assertEqual(auth.session_info(self.family)['member']['id'], 'local')
        self.during_provider(change_member, 401)

    def test_account_deactivation_before_provider_reply_blocks_result_and_audit(self):
        def deactivate():
            other = self.apps[1].store
            member = other.get('member', 'family')
            other.put('member', {**member, 'active': False})
        self.during_provider(deactivate, 401)

    def test_guest_downgrade_before_provider_reply_blocks_result_and_audit(self):
        def downgrade():
            other = self.apps[1].store
            member = other.get('member', 'family')
            other.put('member', {**member, 'role': 'guest'})
        self.during_provider(downgrade, 403)

    def test_provider_wait_releases_writer_and_preserves_snapshot_on_allowed_later_edit(self):
        def read_and_edit():
            self.assertEqual(self.request('GET', '/api/workspace')[0], 200)
            self.assertEqual(self.request('GET', self.path, server=1)[0], 200)
            self.assertEqual(self.request('PUT', self.path + '/blocks', {'blocks': [
                {'id': 'text', 'text': 'LATER AUTHORIZED EDIT'}]}, server=1, cookie=self.owner)[0], 200)
        result = self.during_provider(read_and_edit, 200)
        self.assertEqual(result['text'], 'EXTERNAL PRIVATE ANSWER')
        self.assertEqual(result['citations'], [{'page_id': self.page_id}])
        sent = json.dumps(self.requests[0])
        self.assertIn('AUTHORIZED ORIGINAL CONTEXT', sent)
        self.assertNotIn('LATER AUTHORIZED EDIT', sent)
        self.assertEqual(self.ai_audits()[0]['user'], 'family')

    def test_preexisting_revocation_or_archive_never_calls_provider(self):
        self.assertEqual(self.request('PATCH', self.path + '/permissions',
            {'permissions': {'default': 'private', 'members': {}}}, server=1, cookie=self.owner)[0], 200)
        self.assertEqual(self.ai()[0], 404)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.request('PATCH', self.path + '/permissions',
            {'permissions': {'default': 'private', 'members': {'family': 'view'}}}, server=1, cookie=self.owner)[0], 200)
        self.assertEqual(self.request('PATCH', self.path, {'archived': True}, server=1, cookie=self.owner)[0], 200)
        self.assertEqual(self.ai()[0], 404)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.ai_audits(), [])


if __name__ == '__main__':
    unittest.main()
