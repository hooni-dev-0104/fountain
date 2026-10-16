import copy
import http.client
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fountain.core import APIError, Store
from fountain.server import Application, create_server


def operation(client, clock, kind='text.insert', **values):
    return {'id': f'{client}:{clock}', 'client': client, 'clock': clock,
            'type': kind, 'block_id': 'text', **values}


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.app = Application(self.store)
        self.page = self.app.workspace.create_page({'blocks': [{'id': 'text', 'text': '가🙂'}]})
        self.path = '/api/pages/' + self.page['id']

    def tearDown(self):
        self.store.close()

    def call(self, method, suffix, body=None, principal=None):
        args = {} if principal is None else {'principal': principal}
        return self.app.dispatch(method, self.path + suffix, body or {}, {}, **args)[1]

    def test_concurrent_insertions_retry_and_marks_materialize_without_lost_text(self):
        base = self.call('GET', '/collaboration')
        operations = [operation(client, 1, after_id='seed:text:0', text=text)
                      for client, text in [('one', '첫째'), ('two', '둘째')]]
        def send(op):
            return self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': [op]})
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(send, operations))
        result = self.call('GET', '/collaboration')
        self.assertEqual(result['blocks'][0]['text'], '가둘째첫째🙂')
        self.assertEqual(result['seq'], 2)
        retry = send(operations[0])
        self.assertEqual(retry['seq'], 2)
        self.assertEqual(retry['ack'], ['one:1'])
        self.assertEqual(len(self.app.workspace.detail(self.page['id'])['versions']), 1)
        formatting = operation('one', 2, 'text.format', char_ids=['two:1:0'], marks={'bold': True, 'link': 'https://example.org'})
        result = send(formatting)
        self.assertIn({'text': '둘', 'marks': {'bold': True, 'link': 'https://example.org'}}, result['blocks'][0]['rich_text'])
        self.assertEqual(self.call('GET', '')['blocks'], result['blocks'])
        self.assertEqual(self.app.workspace.search('둘째')['results'][0]['id'], self.page['id'])

    def test_metadata_preserves_epoch_legacy_save_and_restore_replace_it(self):
        base = self.call('GET', '/collaboration')
        self.call('PATCH', '', {'title': '새 제목'})
        metadata = self.call('GET', '/collaboration')
        self.assertEqual(metadata['epoch'], base['epoch'])
        self.assertGreater(metadata['access_revision'], base['access_revision'])
        self.call('PUT', '/blocks', {'blocks': [{'id': 'text', 'text': '교체'}]})
        newer = self.call('GET', '/collaboration')
        self.assertNotEqual(newer['epoch'], base['epoch'])
        with self.assertRaises(APIError) as error:
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': []})
        self.assertEqual(error.exception.status, 409)
        version = self.call('GET', '')['versions'][0]
        self.call('POST', '/versions/' + version['id'] + '/restore')
        restored = self.call('GET', '/collaboration')
        self.assertNotEqual(restored['epoch'], newer['epoch'])
        self.assertEqual(restored['blocks'][0]['text'], '가🙂')

    def test_batch_invalid_or_reused_id_rolls_back_every_write(self):
        base = self.call('GET', '/collaboration')
        valid = operation('one', 1, after_id=None, text='앞')
        invalid = operation('one', 2, 'text.format', char_ids=['seed:text:0'], marks={'link': 'javascript:alert(1)'})
        before = copy.deepcopy(self.store.list('audit'))
        with self.assertRaises(APIError):
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': [valid, invalid]})
        self.assertEqual(self.call('GET', '/collaboration'), base)
        self.assertEqual(self.store.list('audit'), before)
        self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': [valid]})
        with self.assertRaises(APIError) as error:
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': [{**valid, 'text': '변조'}]})
        self.assertEqual(error.exception.status, 409)

    def test_read_only_lock_archive_and_attachment_gate(self):
        self.store.put('member', {'id': 'reader', 'role': 'member', 'name': '독자'})
        reader = self.store.get('member', 'reader')
        page = self.store.get('page', self.page['id'])
        page['permissions'] = {'default': 'private', 'members': {'reader': 'view'}}
        self.store.put('page', page)
        base = self.call('GET', '/collaboration', principal=reader)
        self.assertEqual(base['access_level'], 1)
        with self.assertRaises(APIError) as error:
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': []}, reader)
        self.assertEqual(error.exception.status, 403)
        page['permissions']['members']['reader'] = 'edit'
        self.store.put('page', page)
        self.store.put('attachment', {'id': 'secret', 'owner_id': 'local', 'data': '', 'name': '비공개'})
        with self.assertRaises(APIError) as error:
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': [operation('r', 1, 'block.set', field='attachment_id', value='secret')]}, reader)
        self.assertEqual(error.exception.status, 404)
        self.call('PATCH', '', {'locked': True})
        with self.assertRaises(APIError) as error:
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': []})
        self.assertEqual(error.exception.status, 423)
        self.call('PATCH', '', {'locked': False, 'archived': True})
        with self.assertRaises(APIError) as error:
            self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': []})
        self.assertEqual(error.exception.status, 409)

    def test_permission_generation_advances_without_changing_document_sequence(self):
        self.store.put('member', {'id': 'reader', 'role': 'member', 'name': '독자'})
        base = self.call('GET', '/collaboration')
        self.call('PATCH', '/permissions', {'permissions': {'default': 'private', 'members': {'reader': 'view'}}})
        snapshot = self.call('GET', '/collaboration')
        self.assertEqual(snapshot['seq'], base['seq'])
        self.assertEqual(snapshot['page']['revision'], base['page']['revision'])
        self.assertGreater(snapshot['access_revision'], base['access_revision'])
        self.assertEqual(self.call('GET', '/collaboration', principal=self.store.get('member', 'reader'))['access_level'], 1)

    def test_deleted_text_redacted_and_workspace_namespace_persistent(self):
        base = self.call('GET', '/collaboration')
        result = self.call('POST', '/operations', {'epoch': base['epoch'], 'ops': [operation('d', 1, 'text.delete', char_ids=['seed:text:0'])]})
        self.assertNotIn('가', json.dumps(result, ensure_ascii=False))
        self.assertTrue(result['state']['blocks']['text']['chars']['seed:text:0']['deleted'])
        self.assertIs(result['state']['seen']['d:1'], True)
        self.assertIsInstance(self.store.get('collaboration', self.page['id'])['state']['seen']['d:1'], str)
        self.assertEqual(base['workspace_id'], self.app.workspace.snapshot()['workspace_id'])
        self.assertEqual(len(base['workspace_id']), 32)

    def test_viewers_cannot_recover_removed_content_through_history(self):
        self.store.put('member', {'id': 'reader', 'role': 'member', 'name': '독자'})
        page = self.store.get('page', self.page['id'])
        page['permissions'] = {'default': 'private', 'members': {'reader': 'view'}}
        self.store.put('page', page)
        self.call('PUT', '/blocks', {'blocks': [{'id': 'text', 'text': '현재'}]})
        viewer = self.call('GET', '', principal=self.store.get('member', 'reader'))
        self.assertEqual(viewer['versions'], [])
        self.assertNotIn('가🙂', json.dumps(viewer, ensure_ascii=False))
        self.assertTrue(self.call('GET', '')['versions'])

    def test_retention_removes_collaboration_state_with_page(self):
        self.call('GET', '/collaboration')
        page = self.app.workspace.page(self.page['id'])
        page.update(archived=True, deleted_at='2000-01-01T00:00:00+00:00')
        self.store.put('page', page)
        self.app.advanced.cleanup()
        self.assertIsNone(self.store.get('page', page['id']))
        self.assertIsNone(self.store.get('collaboration', page['id']))

    def test_independent_connections_preserve_one_epoch_and_all_operations(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'workspace.db'
            stores = [Store(path), Store(path)]
            try:
                apps = [Application(store) for store in stores]
                page = apps[0].workspace.create_page({'blocks': [{'id': 'text', 'text': ''}]})
                path = '/api/pages/' + page['id']
                with ThreadPoolExecutor(max_workers=2) as pool:
                    snapshots = list(pool.map(lambda app: app.dispatch('GET', path + '/collaboration', {}, {})[1], apps))
                self.assertEqual(snapshots[0]['epoch'], snapshots[1]['epoch'])
                def edit(index):
                    return apps[index].dispatch('POST', path + '/operations', {'epoch': snapshots[index]['epoch'],
                        'ops': [operation('client' + str(index), 1, after_id=None, text=str(index))]}, {})
                with ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(edit, range(2)))
                self.assertEqual(apps[0].workspace.page(page['id'])['blocks'][0]['text'], '10')
            finally:
                for store in stores: store.close()

    def test_cross_connection_logout_wins_before_writer_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            stores = [Store(Path(folder) / 'workspace.db') for _ in range(2)]
            try:
                apps = [Application(store) for store in stores]
                apps[0].auth.create_account('local', 'test-password-123')
                apps[0].auth.enable_accounts()
                cookie = 'fountain_session=' + apps[0].auth.login({'email': 'local@fountain.local', 'password': 'test-password-123'})
                page = apps[0].workspace.create_page({'blocks': [{'id': 'text', 'text': '원본'}]})
                path = '/api/pages/' + page['id']
                snapshot = apps[0].dispatch('GET', path + '/collaboration', {}, {}, session_cookie=cookie)[1]
                original = stores[0].transaction
                revoked = False
                @contextmanager
                def interleaved():
                    nonlocal revoked
                    if not revoked:
                        revoked = True
                        apps[1].auth.logout(cookie)
                    with original(): yield
                with patch.object(stores[0], 'transaction', interleaved):
                    with self.assertRaises(APIError) as error:
                        apps[0].dispatch('POST', path + '/operations', {'epoch': snapshot['epoch'],
                            'ops': [operation('late', 1, after_id=None, text='유출')]}, {}, session_cookie=cookie)
                self.assertEqual(error.exception.status, 401)
                self.assertEqual(apps[0].workspace.page(page['id'])['blocks'][0]['text'], '원본')
            finally:
                for store in stores: store.close()


class CollaborationStreamTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(port=0, db_path=':memory:')
        self.app = self.server.application
        self.app.store.put('member', {'id': 'family', 'name': '가족', 'email': 'family@example.org', 'role': 'member'})
        for member in ('local', 'family'):
            self.app.auth.create_account(member, 'test-password-123')
        self.app.auth.enable_accounts()
        self.cookie = 'fountain_session=' + self.app.auth.login({'email': 'family@example.org', 'password': 'test-password-123'})
        self.app.workspace.create_page({'id': 'stream', 'blocks': [{'id': 'text', 'text': '내용'}],
            'permissions': {'default': 'private', 'members': {'family': 'edit'}}})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = None

    def tearDown(self):
        if self.connection: self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.app.store.close()

    def stream(self):
        self.connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        self.connection.request('GET', '/api/pages/stream/events', headers={'Cookie': self.cookie})
        response = self.connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
        return response

    def event(self, response):
        event, data = '', ''
        for _ in range(10):
            line = response.fp.readline().decode().strip()
            if line.startswith('event: '): event = line[7:]
            if line.startswith('data: '): data = line[6:]
            if not line and event: return event, json.loads(data)
        self.fail('No SSE event received')

    def test_live_metadata_permission_downgrade_and_revocation(self):
        response = self.stream()
        initial = self.event(response)[1]
        self.assertEqual(initial['access_level'], 3)
        self.assertEqual(initial['current_member_id'], 'family')
        self.assertEqual(initial['session_binding'], self.app.auth.session_info(self.cookie)['cache_binding'])
        page = self.app.workspace.page('stream')
        page['permissions']['members']['family'] = 'view'
        page['title'] = '권한 변경'
        self.app.store.put('page', page)
        event, payload = self.event(response)
        self.assertEqual(event, 'snapshot')
        self.assertEqual(payload['access_level'], 1)
        self.assertEqual(payload['page']['title'], '권한 변경')
        page['permissions']['members'] = {}
        self.app.store.put('page', page)
        event, payload = self.event(response)
        self.assertEqual(event, 'denied')
        self.assertEqual(payload['status'], 404)

    def test_existing_stream_stops_after_session_logout(self):
        response = self.stream()
        self.event(response)
        self.app.auth.logout(self.cookie)
        event, payload = self.event(response)
        self.assertEqual((event, payload['status']), ('denied', 401))

    def test_login_cache_binding_changes_without_exposing_session_secret(self):
        info = self.app.auth.session_info(self.cookie)
        again = self.app.auth.session_info(self.cookie)
        self.assertEqual(info['cache_binding'], again['cache_binding'])
        self.assertEqual(info['workspace_id'], self.app.workspace.snapshot()['workspace_id'])
        self.assertNotIn(self.cookie.split('=')[1], json.dumps(info))
        self.app.auth.logout(self.cookie)
        cookie = 'fountain_session=' + self.app.auth.login({'email': 'family@example.org', 'password': 'test-password-123'})
        self.assertNotEqual(self.app.auth.session_info(cookie)['cache_binding'], info['cache_binding'])

    def test_mutation_revalidates_cookie_after_principal_was_resolved(self):
        principal = self.app.auth.principal(self.cookie)
        snapshot = self.app.dispatch('GET', '/api/pages/stream/collaboration', {}, {}, principal=principal)[1]
        self.app.auth.logout(self.cookie)
        with self.assertRaises(APIError) as error:
            self.app.dispatch('POST', '/api/pages/stream/operations', {'epoch': snapshot['epoch'],
                'ops': [operation('late', 1, after_id=None, text='차단')]}, {},
                principal=principal, session_cookie=self.cookie)
        self.assertEqual(error.exception.status, 401)
        self.assertEqual(self.app.workspace.page('stream')['blocks'][0]['text'], '내용')

    def test_stream_receives_actual_character_edit_and_fresh_group_membership(self):
        page = self.app.workspace.page('stream')
        page['permissions'] = {'default': 'private', 'groups': {'editors': 'edit'}}
        self.app.store.put('page', page)
        self.app.store.put('group', {'id': 'editors', 'name': '편집자', 'members': ['family']})
        response = self.stream()
        snapshot = self.event(response)[1]
        self.app.dispatch('POST', '/api/pages/stream/operations', {'epoch': snapshot['epoch'],
            'ops': [operation('remote', 1, after_id=None, text='공동 ')]}, {})
        event, payload = self.event(response)
        self.assertEqual(event, 'snapshot')
        self.assertEqual(payload['seq'], 1)
        self.assertEqual(payload['blocks'][0]['text'], '공동 내용')
        self.app.store.put('group', {'id': 'editors', 'members': []})
        self.assertEqual(self.event(response)[1]['status'], 404)


if __name__ == '__main__': unittest.main()
