"""Metadata-only attachment verification over real authenticated SQLite HTTP."""
import base64
import hashlib
import http.client
import json
import threading
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fountain.attachments import MAX_FILE_SIZE
from fountain.server import create_server


class AttachmentMetadataHTTPTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict('os.environ', {'FOUNTAIN_ACCESS_TOKEN': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.store = self.server.application.store
        auth = self.server.application.auth
        for identity in ('reader', 'stranger'):
            self.store.put('member', {'id': identity, 'name': identity, 'email': identity + '@metadata.test', 'role': 'member', 'active': True})
        for identity in ('local', 'reader', 'stranger'):
            auth.create_account(identity, 'metadata-fixture-password')
        auth.enable_accounts()
        self.cookies = {}
        for identity, email in [('local', 'local@fountain.local'), ('reader', 'reader@metadata.test'), ('stranger', 'stranger@metadata.test')]:
            status, _, headers = self.request('POST', '/api/session', {'email': email, 'password': 'metadata-fixture-password'}, cookie='')
            self.assertEqual(status, 200)
            self.cookies[identity] = headers['Set-Cookie'].split(';', 1)[0]
        self.content = '파일 본문은 metadata 응답에 나오면 안 됩니다😀'.encode()
        status, self.attachment, _ = self.request('POST', '/api/attachments', {
            'name': '가족 자료.txt', 'data': base64.b64encode(self.content).decode()})
        self.assertEqual(status, 201)
        status, self.page, _ = self.request('POST', '/api/pages', {'title': '첨부 접근 범위',
            'permissions': {'default': 'private', 'members': {'reader': 'view'}},
            'blocks': [{'id': 'file', 'type': 'file', 'text': self.attachment['name'], 'attachment_id': self.attachment['id']}]})
        self.assertEqual(status, 201)
        self.path = '/api/attachments/' + self.attachment['id']

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.server.application.store.close()

    def request(self, method, path, body=None, *, cookie=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/json', 'X-Fountain-Request': '1',
                   'Cookie': self.cookies.get('local', '') if cookie is None else cookie}
        try:
            connection.request(method, path, json.dumps(body).encode() if body is not None else None, headers)
            response = connection.getresponse()
            raw = response.read()
            payload = json.loads(raw) if raw and 'application/json' in response.getheader('Content-Type', '') else raw
            return response.status, payload, dict(response.getheaders())
        finally:
            connection.close()

    def test_inline_metadata_allowlist_is_identical_for_owner_and_document_reader(self):
        private = self.store.get('attachment', self.attachment['id'])
        private.update(token='private-token', uploadreceipt={'secret': 'private-receipt'}, path='/private/server/file',
                       privatefield={'nested': 'private-data'}, base64='private-base64')
        self.store.put('attachment', private)
        expected = {'id': self.attachment['id'], 'name': '가족 자료.txt', 'size': len(self.content),
                    'mime': 'application/octet-stream', 'storage': 'inline', 'status': 'complete'}
        for identity in ('local', 'reader'):
            with self.subTest(identity=identity):
                status, metadata, headers = self.request('GET', self.path + '/metadata', cookie=self.cookies[identity])
                self.assertEqual((status, metadata), (200, expected))
                self.assertIn('application/json', headers['Content-Type'])
                self.assertLess(int(headers['Content-Length']), 1024)
                self.assertNotIn('private-', json.dumps(metadata))
                self.assertFalse({'data', 'base64', 'token', 'uploadreceipt', 'path', 'privatefield', 'owner_id', 'page_id'} & metadata.keys())

    def test_existing_inline_get_and_download_shapes_remain_compatible(self):
        status, legacy, _ = self.request('GET', self.path)
        self.assertEqual(status, 200)
        self.assertEqual(legacy['data'], base64.b64encode(self.content).decode())
        status, content, _ = self.request('GET', self.path + '/download', cookie=self.cookies['reader'])
        self.assertEqual((status, content), (200, self.content))

    def test_no_access_and_current_acl_revocation_reuse_existing_guard(self):
        self.assertEqual(self.request('GET', self.path + '/metadata', cookie=self.cookies['stranger'])[0], 404)
        self.assertEqual(self.request('GET', self.path + '/metadata', cookie='')[0], 401)
        self.assertEqual(self.request('GET', self.path + '/metadata', cookie=self.cookies['reader'])[0], 200)
        self.assertEqual(self.request('PATCH', '/api/pages/' + self.page['id'] + '/permissions',
                                     {'permissions': {'default': 'private', 'members': {}}})[0], 200)
        self.assertEqual(self.request('GET', self.path + '/metadata', cookie=self.cookies['reader'])[0], 404)
        self.assertEqual(self.request('GET', self.path + '/metadata')[0], 200)

    def test_head_has_get_length_and_headers_without_a_response_body(self):
        status, metadata, headers = self.request('GET', self.path + '/metadata')
        self.assertEqual(status, 200)
        status, body, head = self.request('HEAD', self.path + '/metadata', cookie=self.cookies['reader'])
        self.assertEqual((status, body), (200, b''))
        self.assertEqual(head['Content-Length'], headers['Content-Length'])
        self.assertEqual(head['Content-Type'], headers['Content-Type'])
        self.assertGreater(int(head['Content-Length']), 0)
        self.assertEqual(self.request('HEAD', self.path + '/metadata', cookie=self.cookies['stranger'])[:2], (404, b''))

    def test_missing_or_unfinished_upload_has_no_metadata(self):
        for method in ('GET', 'HEAD'):
            self.assertEqual(self.request(method, '/api/attachments/missing/metadata')[0], 404)
        status, upload, _ = self.request('POST', '/api/uploads', {'name': '미완료 파일', 'size': 1, 'page_id': self.page['id']})
        self.assertEqual(status, 201)
        self.assertEqual(self.request('GET', '/api/attachments/' + upload['id'] + '/metadata')[0], 404)

    def test_maximum_chunked_manifest_is_bounded_and_never_reads_file_bytes(self):
        # Manifest-only fixture deliberately has no 5GB file: metadata lookup
        # must not fetch, hash, iterate or decode bytes to report its declaration.
        identity = 'maximum-file'
        self.store.put('attachment', {'id': identity, 'owner_id': 'local', 'name': '5GB.bin',
            'size': MAX_FILE_SIZE, 'mime': 'application/octet-stream', 'storage': 'chunks', 'sha256': 'a' * 64,
            'path': '/private/blob/root', 'data': 'must-not-decode', 'upload_receipt': {'private': True}})
        with ExitStack() as stack:
            for name in ('chunk_info', 'chunk_read_range', 'chunk_list'):
                stack.enter_context(patch.object(self.store, name, side_effect=AssertionError('Unexpected chunk read')))
            stack.enter_context(patch.object(self.server.application.files, 'iter_bytes', side_effect=AssertionError('Unexpected byte stream')))
            stack.enter_context(patch('fountain.server.base64.b64decode', side_effect=AssertionError('Unexpected base64 decode')))
            status, metadata, headers = self.request('GET', '/api/attachments/' + identity + '/metadata')
        self.assertEqual(status, 200)
        self.assertEqual(metadata, {'id': identity, 'name': '5GB.bin', 'size': MAX_FILE_SIZE, 'mime': 'application/octet-stream',
                                    'storage': 'chunks', 'sha256': 'a' * 64, 'status': 'complete'})
        self.assertLess(int(headers['Content-Length']), 1024)
        self.assertEqual(self.store.chunk_list(identity), [])

    def test_completed_empty_chunked_upload_metadata_has_actual_hash(self):
        status, upload, _ = self.request('POST', '/api/uploads', {'name': '빈 파일.txt', 'size': 0, 'page_id': self.page['id']})
        self.assertEqual(status, 201)
        status, attachment, _ = self.request('POST', '/api/uploads/' + upload['id'] + '/complete', {})
        self.assertEqual(status, 201)
        status, metadata, _ = self.request('GET', '/api/attachments/' + attachment['id'] + '/metadata')
        self.assertEqual(status, 200)
        self.assertEqual((metadata['size'], metadata['sha256'], metadata['storage']), (0, hashlib.sha256(b'').hexdigest(), 'chunks'))

    def test_invalid_metadata_scalar_types_do_not_expose_nested_private_values(self):
        original = self.store.get('attachment', self.attachment['id'])
        for values in ({'name': {'private': 'nested'}}, {'size': True}, {'storage': {'private': True}}, {'sha256': 'private-invalid-hash'}):
            with self.subTest(fields=tuple(values)):
                self.store.put('attachment', {**original, **values})
                status, payload, _ = self.request('GET', self.path + '/metadata')
                self.assertEqual(status, 409)
                self.assertEqual(payload['error'], 'Attachment metadata is invalid')


if __name__ == '__main__':
    unittest.main()
