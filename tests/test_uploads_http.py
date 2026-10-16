import base64
import hashlib
import http.client
import json
import socket
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from fountain.attachments import CHUNK_SIZE, MAX_FILE_SIZE
from fountain.server import create_server


class UploadHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(port=0, db_path=':memory:')
        self.app = self.server.application
        self.app.store.put('member', {'id': 'family', 'name': '가족', 'email': 'family@example.org', 'role': 'member'})
        self.app.store.put('member', {'id': 'guest', 'name': '손님', 'email': 'guest@example.org', 'role': 'guest'})
        for member in ('local', 'family', 'guest'):
            self.app.auth.create_account(member, 'test-password-123')
        self.app.auth.enable_accounts()
        self.cookies = {member: 'fountain_session=' + self.app.auth.login({'email': email, 'password': 'test-password-123'})
                        for member, email in [('local', 'local@fountain.local'), ('family', 'family@example.org'), ('guest', 'guest@example.org')]}
        self.page = self.app.workspace.create_page({'blocks': [], 'permissions': {'default': 'private', 'members': {'family': 'edit', 'guest': 'edit'}}})
        self.prefix = '/api/pages/' + self.page['id']
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.app.store.close()

    def request(self, method, path, body=None, actor='local', raw=False, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        data = body if raw else json.dumps(body).encode() if body is not None else None
        defaults = {'Content-Type': 'application/octet-stream' if raw else 'application/json', 'X-Fountain-Request': '1',
                    'Cookie': self.cookies.get(actor, '')}
        defaults.update(headers or {})
        connection.request(method, path, data, defaults)
        response = connection.getresponse()
        content, status, result_headers = response.read(), response.status, dict(response.getheaders())
        connection.close()
        return status, json.loads(content) if content and 'json' in result_headers.get('Content-Type', '') else content, result_headers

    def begin(self, size, actor='local', **values):
        status, upload, _ = self.request('POST', '/api/uploads', {'name': '가족 영상 #1.bin', 'size': size, 'page_id': self.page['id'], **values}, actor)
        self.assertEqual(status, 201)
        return '/api/uploads/' + upload['id']

    def append(self, path, offset, content, actor='local', **headers):
        return self.request('PUT', path + '/chunks?offset=' + str(offset), content, actor, True, headers)

    def finish(self, path, actor='local'):
        status, attachment, _ = self.request('POST', path + '/complete', {}, actor)
        self.assertEqual(status, 201)
        return attachment

    def test_real_multichunk_roundtrip_retry_and_download_ranges(self):
        content = bytes(range(251)) * ((CHUNK_SIZE + 100000) // 251 + 1)
        path = self.begin(len(content))
        self.assertEqual(self.append(path, CHUNK_SIZE, content[CHUNK_SIZE:])[0], 409)
        self.assertEqual(self.append(path, 0, content[:CHUNK_SIZE])[1]['offset'], CHUNK_SIZE)
        self.assertEqual(self.append(path, 0, content[:CHUNK_SIZE])[0], 200)
        self.assertEqual(self.append(path, 0, b'!' * CHUNK_SIZE)[0], 409)
        self.assertEqual(self.append(path, CHUNK_SIZE, content[CHUNK_SIZE:])[0], 200)
        attachment = self.finish(path)
        self.assertEqual(self.finish(path)['id'], attachment['id'])
        self.assertEqual(attachment['sha256'], hashlib.sha256(content).hexdigest())
        self.assertNotIn('data', attachment)
        download = '/api/attachments/' + attachment['id'] + '/download'
        status, raw, headers = self.request('GET', download)
        self.assertEqual((status, raw), (200, content))
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        self.assertIn('filename*=UTF-8', headers['Content-Disposition'])
        for value, start, end in [('bytes=2-9', 2, 10), ('bytes=-17', len(content) - 17, len(content)),
                                  ('bytes=4194300-4194320', 4194300, 4194321), ('bytes=4194300-', 4194300, len(content))]:
            status, raw, partial = self.request('GET', download, headers={'Range': value})
            self.assertEqual((status, raw), (206, content[start:end]))
            self.assertEqual(partial['Content-Range'], f'bytes {start}-{end - 1}/{len(content)}')
        self.assertEqual(self.request('GET', download, headers={'Range': 'bytes=999999999999-'})[0], 416)
        self.assertEqual(self.request('GET', download, headers={'Range': 'bytes=0-1,4-5'})[0], 416)
        self.assertEqual(self.request('GET', download, headers={'Range': 'items=0-1'})[0], 200)
        self.assertEqual(self.request('GET', download, headers={'Range': 'bytes=0-1', 'If-Range': '"wrong"'})[0], 200)
        self.assertEqual(self.request('GET', download, headers={'Range': 'bytes=0-1', 'If-Range': headers['ETag']})[0], 206)
        status, raw, head = self.request('HEAD', download, headers={'Range': 'bytes=0-1'})
        self.assertEqual((status, raw, head['Content-Length']), (200, b'', str(len(content))))
        self.assertEqual(self.request('GET', '/api/attachments/' + attachment['id'])[1]['storage'], 'chunks')
        self.assertEqual(self.request('DELETE', path)[1]['completed'], True)
        self.assertEqual(self.request('GET', download)[1], content)

    def test_guests_owner_isolation_reference_protection_and_revoked_acl(self):
        self.assertEqual(self.request('POST', '/api/uploads', {'name': 'x', 'size': 1}, 'guest')[0], 403)
        path = self.begin(5, 'guest')
        self.assertEqual(self.request('GET', path, actor='family')[0], 404)
        self.assertEqual(self.append(path, 0, b'hello', 'family')[0], 404)
        self.assertEqual(self.append(path, 0, b'hello', 'guest')[0], 200)
        attachment = self.finish(path, 'guest')
        download = '/api/attachments/' + attachment['id'] + '/download'
        self.assertEqual(self.request('GET', download, actor='family')[0], 404)
        blocks = [{'type': 'file', 'attachment_id': attachment['id'], 'text': attachment['name']}]
        self.assertEqual(self.request('PUT', self.prefix + '/blocks', {'blocks': blocks}, 'guest')[0], 200)
        self.assertEqual(self.request('GET', download, actor='family')[1], b'hello')
        self.assertEqual(self.request('DELETE', '/api/attachments/' + attachment['id'])[0], 409)
        self.request('PATCH', self.prefix + '/permissions', {'permissions': {'default': 'private'}})
        self.assertEqual(self.request('GET', download, actor='family')[0], 404)
        self.assertEqual(self.request('POST', path + '/complete', {}, 'guest')[0], 403)

    def test_lock_cancel_partial_upload_and_oversize(self):
        self.assertEqual(self.request('POST', '/api/uploads', {'name': 'large', 'size': MAX_FILE_SIZE + 1})[0], 413)
        for name in ['../file', 'x\\y', 'a\nfile', '.', '..']:
            self.assertEqual(self.request('POST', '/api/uploads', {'name': name, 'size': 1})[0], 400)
        path = self.begin(CHUNK_SIZE + 1, 'family')
        self.assertEqual(self.append(path, 0, b'x', 'family')[0], 400)
        self.assertEqual(self.request('POST', path + '/complete', {}, 'family')[0], 409)
        self.assertEqual(self.append(path, 0, b'x' * CHUNK_SIZE, 'family')[0], 200)
        self.request('PATCH', self.prefix, {'locked': True})
        self.assertEqual(self.append(path, CHUNK_SIZE, b'x', 'family')[0], 423)
        self.assertEqual(self.request('DELETE', path, actor='family')[0], 423)
        self.assertEqual(self.request('DELETE', path, actor='local')[1]['cancelled'], True)
        self.assertEqual(self.request('GET', path, actor='family')[0], 404)
        self.assertEqual(self.app.store.db.execute('SELECT count(*) FROM attachment_chunks').fetchone()[0], 0)

    def test_empty_file_and_legacy_download(self):
        path = self.begin(0)
        attachment = self.finish(path)
        self.assertEqual(attachment['sha256'], hashlib.sha256(b'').hexdigest())
        self.assertEqual(self.request('GET', '/api/attachments/' + attachment['id'] + '/download')[1], b'')
        _, legacy, _ = self.request('POST', '/api/attachments', {'name': 'old.txt', 'data': base64.b64encode(b'legacy').decode()})
        self.assertEqual(self.request('GET', '/api/attachments/' + legacy['id'] + '/download', headers={'Range': 'bytes=1-3'})[1], b'ega')

    def test_raw_request_auth_headers_and_truncation_do_not_store_bytes(self):
        path = self.begin(3)
        target = path + '/chunks?offset=0'
        for headers, status in [({'Origin': 'https://evil.example'}, 403), ({'X-Fountain-Request': ''}, 403),
                                ({'Content-Type': 'application/json'}, 415), ({'Transfer-Encoding': 'chunked'}, 400)]:
            self.assertEqual(self.request('PUT', target, b'abc', raw=True, headers=headers)[0], status)
        self.assertEqual(self.request('PUT', target, b'abc', actor='none', raw=True)[0], 401)
        self.assertEqual(self.request('PUT', path + '/chunks?offset=0&offset=0', b'abc', raw=True)[0], 400)
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as connection:
            header = (f'PUT {target} HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n'
                      f'Cookie: {self.cookies["local"]}\r\nX-Fountain-Request: 1\r\n'
                      'Content-Type: application/octet-stream\r\nContent-Length: 3\r\n\r\nab').encode()
            connection.sendall(header)
            connection.shutdown(socket.SHUT_WR)
            self.assertIn(b'400', connection.recv(4096).split(b'\r\n')[0])
        self.assertEqual(self.request('GET', path)[1]['offset'], 0)
        self.assertEqual(self.app.store.db.execute('SELECT count(*) FROM attachment_chunks').fetchone()[0], 0)

    def test_concurrent_same_chunk_stores_once_and_finish_logs_once(self):
        path = self.begin(3)
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda _: self.append(path, 0, b'abc')[0], range(2)))
        self.assertEqual(statuses, [200, 200])
        self.assertEqual(self.app.store.db.execute('SELECT count(*) FROM attachment_chunks').fetchone()[0], 1)
        self.finish(path)
        self.finish(path)
        self.assertEqual(len([event for event in self.app.store.list('audit') if event['action'] == 'upload.completed']), 1)

    def test_session_revoked_while_body_waits_cannot_store_chunk(self):
        path = self.begin(3, 'family')
        ready = threading.Event()
        original = self.app.files.status
        def status(*args, **kwargs):
            result = original(*args, **kwargs)
            ready.set()
            return result
        with patch.object(self.app.files, 'status', status):
            with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as connection:
                connection.sendall((f'PUT {path}/chunks?offset=0 HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n'
                    f'Cookie: {self.cookies["family"]}\r\nX-Fountain-Request: 1\r\nContent-Type: application/octet-stream\r\nContent-Length: 3\r\n\r\n').encode())
                self.assertTrue(ready.wait(2))
                # A different request proceeds while this socket has no body yet.
                self.assertEqual(self.request('GET', '/api/workspace')[0], 200)
                self.app.auth.logout(self.cookies['family'])
                connection.sendall(b'abc')
                self.assertIn(b'401', connection.recv(4096).split(b'\r\n')[0])
        self.assertEqual(self.app.store.get('upload', path.rsplit('/', 1)[1])['offset'], 0)

    def test_download_stops_on_live_document_permission_revocation(self):
        path = self.begin(2 * 1024 * 1024)
        self.append(path, 0, b'x' * (2 * 1024 * 1024))
        attachment = self.finish(path)
        self.request('PUT', self.prefix + '/blocks', {'blocks': [{'type': 'file', 'text': '공유 파일', 'attachment_id': attachment['id']}]})
        paused, proceed = threading.Event(), threading.Event()
        original = self.app.files.iter_bytes
        def iterator(*args, **kwargs):
            for index, value in enumerate(original(*args, **kwargs)):
                if index == 1:
                    paused.set()
                    if not proceed.wait(3): raise AssertionError('Test reader was not released')
                yield value
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            with patch.object(self.app.files, 'iter_bytes', iterator):
                connection.request('GET', '/api/attachments/' + attachment['id'] + '/download', headers={'Cookie': self.cookies['family']})
                response = connection.getresponse()
                self.assertEqual(response.read(64 * 1024), b'x' * (64 * 1024))
                self.assertTrue(paused.wait(2))
                self.assertEqual(self.request('PATCH', self.prefix + '/permissions', {'permissions': {'default': 'private'}})[0], 200)
                proceed.set()
                with self.assertRaises(http.client.IncompleteRead) as error: response.read()
                self.assertEqual(error.exception.partial, b'')
        finally:
            proceed.set()
            connection.close()


if __name__ == '__main__': unittest.main()
