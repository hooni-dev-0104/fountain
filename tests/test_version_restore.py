"""Real HTTP saved-version restore guards in disposable multi-server stores."""
import copy
import http.client
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fountain.core import APIError
from fountain.server import create_server


class VersionRestoreHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.environment = patch.dict('os.environ', {'FOUNTAIN_ACCESS_TOKEN': ''})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.servers, self.threads = [], []
        self.addCleanup(self.close_servers)
        self.server = self.start_server()
        self.store = self.server.application.store
        self.auth = self.server.application.auth
        owner = self.store.get('member', 'local')
        owner['email'] = 'owner@restore.test'
        self.store.put('member', owner)
        self.store.put('member', {'id': 'reader', 'name': '독자', 'email': 'reader@restore.test', 'role': 'member', 'active': True})
        self.auth.create_account('local', 'fixture-password-only')
        self.auth.create_account('reader', 'fixture-password-only')
        self.auth.enable_accounts()
        self.owner_cookie = 'fountain_session=' + self.auth.login({'email': owner['email'], 'password': 'fixture-password-only'})
        self.reader_cookie = 'fountain_session=' + self.auth.login({'email': 'reader@restore.test', 'password': 'fixture-password-only'})
        status, page = self.request('POST', '/api/pages', {'title': '원본 문서', 'blocks': [{'id': 'text', 'text': '저장된 버전😀'}]})
        self.assertEqual(status, 201)
        self.page_id = page['id']
        self.path = '/api/pages/' + self.page_id
        self.assertEqual(self.request('PUT', self.path + '/blocks', {'revision': 0, 'blocks': [{'id': 'text', 'text': '현재 문서'}]})[0], 200)
        self.version = next(value for value in self.store.list('version') if value['page_id'] == self.page_id)
        self.restore_path = self.path + '/versions/' + self.version['id'] + '/restore'
        self.before_epoch = self.request('GET', self.path + '/collaboration')[1]['epoch']

    def start_server(self):
        server = create_server(port=0, db_path=Path(self.temp.name) / 'workspace.db')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        self.servers.append(server); self.threads.append(thread); thread.start()
        return server

    def close_servers(self):
        for server in self.servers: server.shutdown(); server.server_close(); server.application.store.close()
        for thread in self.threads: thread.join()

    def request(self, method, path, body=None, *, server=None, cookie=None):
        connection = http.client.HTTPConnection('127.0.0.1', (server or self.server).server_port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, data, {'Content-Type': 'application/json', 'X-Fountain-Request': '1',
                                               'Cookie': cookie or self.owner_cookie})
        response = connection.getresponse()
        result = json.loads(response.read())
        connection.close()
        return response.status, result

    def snapshot(self):
        with self.store.transaction():
            return ({kind: copy.deepcopy(self.store.list(kind)) for kind in ('page', 'version', 'collaboration', 'audit')},
                    self.store.meta('_entity_revision'), self.store.meta('access_revision'))

    def reject_unchanged(self, status, body, *, path=None, cookie=None):
        before = self.snapshot()
        result = self.request('POST', path or self.restore_path, body, cookie=cookie)
        self.assertEqual(result[0], status, result)
        self.assertEqual(self.snapshot(), before)
        return result

    def test_stale_preview_revision_is_409_without_any_page_epoch_history_or_audit_write(self):
        self.assertEqual(self.request('PATCH', self.path, {'revision': 1, 'title': '새로운 제목'})[0], 200)
        self.reject_unchanged(409, {'revision': 1})
        self.assertEqual(self.store.get('collaboration', self.page_id)['epoch'], self.before_epoch)
        self.assertEqual(self.store.get('page', self.page_id)['blocks'][0]['text'], '현재 문서')

    def test_matching_revision_restores_original_ids_and_creates_new_epoch(self):
        parent = self.request('POST', '/api/pages', {'title': '현재 상위 문서'})[1]
        self.request('PATCH', self.path, {'revision': 1, 'title': '복원 직전 제목', 'icon': '🌙',
            'cover': 'https://current.example/cover', 'favorite': True, 'parent_id': parent['id']})
        self.request('PATCH', self.path + '/permissions', {'permissions': {'default': 'private', 'members': {'reader': 'edit'}}})
        current = self.store.get('page', self.page_id)
        before_versions = len(self.store.list('version'))
        status, restored = self.request('POST', self.restore_path, {'revision': 2})
        self.assertEqual(status, 200)
        self.assertEqual(restored['revision'], 3)
        self.assertEqual(restored['page']['title'], '원본 문서')
        self.assertEqual(restored['page']['icon'], '🌙')
        self.assertEqual(restored['page']['cover'], 'https://current.example/cover')
        for field in ('parent_id', 'favorite', 'permissions', 'owner_id'):
            self.assertEqual(restored['page'][field], current[field])
        self.assertEqual(restored['blocks'], self.version['blocks'])
        self.assertEqual(len(self.store.list('version')), before_versions + 1)
        prior_current = next(version for version in self.store.list('version')
                             if version['page_id'] == self.page_id and version['id'] != self.version['id'])
        self.assertEqual(prior_current['title'], '복원 직전 제목')
        self.assertEqual(prior_current['blocks'][0]['text'], '현재 문서')
        self.assertEqual(prior_current['revision'], 2)
        self.assertIsNone(self.store.get('collaboration', self.page_id))
        new_epoch = self.request('GET', self.path + '/collaboration')[1]['epoch']
        self.assertNotEqual(new_epoch, self.before_epoch)
        status, _ = self.request('POST', self.path + '/operations', {'epoch': self.before_epoch, 'ops': []})
        self.assertEqual(status, 409)

    def test_legacy_no_revision_and_explicit_null_keep_existing_restore_semantics(self):
        for body in ({}, {'revision': None}):
            before = self.store.get('page', self.page_id)['revision']
            status, restored = self.request('POST', self.restore_path, body)
            self.assertEqual(status, 200)
            self.assertEqual(restored['revision'], before + 1)
            self.assertEqual(restored['blocks'], self.version['blocks'])

    def test_invalid_revision_types_and_wrong_values_are_409_without_writes(self):
        for revision in (True, False, '1', 1.0, [], {}, -1, 0, 2):
            with self.subTest(revision=revision): self.reject_unchanged(409, {'revision': revision})

    def test_foreign_or_missing_version_is_404_even_with_stale_revision(self):
        other = self.request('POST', '/api/pages', {'blocks': [{'id': 'other', 'text': '다른 문서 비공개'}]})[1]
        other_path = '/api/pages/' + other['id']
        self.request('PUT', other_path + '/blocks', {'blocks': []})
        foreign = next(value for value in self.store.list('version') if value['page_id'] == other['id'])
        for identity in (foreign['id'], 'missing-version'):
            for revision in (1, 0):
                self.reject_unchanged(404, {'revision': revision}, path=self.path + '/versions/' + identity + '/restore')

    def test_lock_and_current_read_only_acl_still_gate_restore(self):
        self.request('PATCH', self.path, {'locked': True})
        self.reject_unchanged(423, {'revision': 1})
        self.request('PATCH', self.path, {'locked': False})
        self.request('PATCH', self.path + '/permissions', {'permissions': {'default': 'private', 'members': {'reader': 'view'}}})
        self.reject_unchanged(403, {'revision': self.store.get('page', self.page_id)['revision']}, cookie=self.reader_cookie)
        self.request('PATCH', self.path + '/permissions', {'permissions': {'default': 'private', 'members': {}}})
        self.reject_unchanged(404, {'revision': 1}, cookie=self.reader_cookie)

    def test_archived_page_and_missing_attachment_ref_are_rejected_without_writes(self):
        self.request('PATCH', self.path, {'archived': True})
        self.reject_unchanged(404, {'revision': 1})
        self.request('POST', self.path + '/restore', {})
        version = self.store.get('version', self.version['id'])
        version['blocks'] = [{'id': 'missing-file', 'type': 'file', 'text': '삭제된 첨부', 'attachment_id': 'absent-attachment'}]
        self.store.put('version', version)
        self.reject_unchanged(404, {'revision': self.store.get('page', self.page_id)['revision']})

    def test_edit_access_allows_preview_but_existing_full_access_restore_policy_remains(self):
        self.request('PATCH', self.path + '/permissions', {'permissions': {'default': 'private', 'members': {'reader': 'edit'}}})
        status, preview = self.request('GET', self.path, cookie=self.reader_cookie)
        self.assertEqual(status, 200)
        self.assertTrue(preview['versions'])
        self.reject_unchanged(403, {'revision': 1}, cookie=self.reader_cookie)

    def test_legacy_version_without_title_preserves_current_title(self):
        version = self.store.get('version', self.version['id'])
        version.pop('title')
        self.store.put('version', version)
        self.request('PATCH', self.path, {'revision': 1, 'title': '현재 제목 유지'})
        status, restored = self.request('POST', self.restore_path, {'revision': 2})
        self.assertEqual(status, 200)
        self.assertEqual(restored['page']['title'], '현재 제목 유지')
        self.assertEqual(restored['revision'], 3)
        self.assertEqual(restored['blocks'], self.version['blocks'])

    def test_invalid_historical_title_is_rejected_before_any_restore_write(self):
        version = self.store.get('version', self.version['id'])
        for title in (False, None, '가' * 501):
            version['title'] = title
            self.store.put('version', version)
            self.reject_unchanged(400, {'revision': 1})

    def test_title_write_failure_rolls_back_body_version_epoch_and_audit_atomically(self):
        status, _ = self.request('POST', self.path + '/operations', {'epoch': self.before_epoch, 'ops': [
            {'id': 'restore-proof:1', 'client': 'restore-proof', 'clock': 1, 'type': 'text.insert',
             'block_id': 'text', 'after_id': None, 'text': '추적된 CRDT 변경'}]})
        self.assertEqual(status, 200)
        original = self.store.put
        page_writes = []
        def write(kind, value):
            if kind == 'page':
                page_writes.append(value['id'])
                if len(page_writes) == 2: raise APIError(409, 'Injected restore title failure')
            return original(kind, value)
        with patch.object(self.store, 'put', side_effect=write):
            self.reject_unchanged(409, {'revision': 2})
        self.assertEqual(page_writes, [self.page_id, self.page_id])

    def test_second_server_edit_invalidates_the_preview_before_restore(self):
        second = self.start_server()
        status, remote = self.request('PUT', self.path + '/blocks', {'revision': 1, 'blocks': [{'id': 'text', 'text': '다른 서버에서 저장'}]}, server=second)
        self.assertEqual(status, 200)
        self.assertEqual(remote['revision'], 2)
        self.reject_unchanged(409, {'revision': 1})
        self.assertEqual(self.store.get('page', self.page_id)['blocks'][0]['text'], '다른 서버에서 저장')

    def test_two_independent_http_writers_cannot_both_accept_one_preview_revision(self):
        second = self.start_server()
        before_versions = len(self.store.list('version'))
        barrier = threading.Barrier(2)
        def restore():
            barrier.wait()
            return self.request('POST', self.restore_path, {'revision': 1})[0]
        def edit():
            barrier.wait()
            return self.request('PUT', self.path + '/blocks', {'revision': 1, 'blocks': [{'id': 'text', 'text': '경합 원격 수정'}]}, server=second)[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(restore), pool.submit(edit)]
            statuses = [job.result(timeout=10) for job in jobs]
        self.assertEqual(sorted(statuses), [200, 409])
        page = self.store.get('page', self.page_id)
        self.assertEqual(page['revision'], 2)
        self.assertIn(page['blocks'][0]['text'], {'저장된 버전😀', '경합 원격 수정'})
        self.assertEqual(len(self.store.list('version')), before_versions + 1)


if __name__ == '__main__': unittest.main()
