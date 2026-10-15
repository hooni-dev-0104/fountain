import base64
import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from fountain.server import create_server


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.application.store.close()
        self.thread.join()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, json.dumps(body) if body is not None else None,
                     {'Content-Type': 'application/json', 'X-Fountain-Request': '1'})
        response = conn.getresponse()
        raw, headers, status = response.read(), dict(response.getheaders()), response.status
        conn.close()
        return status, raw, headers

    def test_complete_backup_download_preserves_history_not_sessions(self):
        store = self.server.application.store
        store.put('session', {'id': 'secret-session', 'secret': 'must not ship'})
        store.put('clipboard', {'id': 'private-copy', 'text': 'must not ship'})
        self.server.application.workspace.create_comment('welcome', {'text': '백업할 댓글'})
        status, raw, headers = self.request('GET', '/api/backup')
        self.assertEqual(status, 200)
        self.assertTrue(raw.startswith(b'SQLite format 3\x00'))
        self.assertIn('attachment;', headers['Content-Disposition'])
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'backup.db'
            database.write_bytes(raw)
            connection = sqlite3.connect(database)
            try:
                self.assertEqual(connection.execute("SELECT count(*) FROM entities WHERE kind IN ('session','clipboard')").fetchone()[0], 0)
                self.assertGreater(connection.execute("SELECT count(*) FROM entities WHERE kind='comment'").fetchone()[0], 0)
                self.assertGreater(connection.execute("SELECT count(*) FROM entities WHERE kind='version'").fetchone()[0], 0)
            finally:
                connection.close()
        self.assertNotIn(b'must not ship', raw)
        self.server.application.dispatch('PATCH', '/api/settings', {'disable_export': True}, {})
        self.assertEqual(self.request('GET', '/api/backup')[0], 403)

    def test_attachment_download_does_not_execute_uploaded_html(self):
        content = b'<script>alert("file")</script>'
        status, raw, _ = self.request('POST', '/api/attachments', {'name': '가족 기록.html', 'data': base64.b64encode(content).decode()})
        self.assertEqual(status, 201)
        attachment = json.loads(raw)
        status, raw, headers = self.request('GET', '/api/attachments/' + attachment['id'] + '/download')
        self.assertEqual(status, 200)
        self.assertEqual(raw, content)
        self.assertEqual(headers['Content-Type'], 'application/octet-stream')
        self.assertIn("filename*=UTF-8''", headers['Content-Disposition'])
        self.assertNotIn('가족', headers['Content-Disposition'])
        page = self.server.application.workspace.create_page({'title': '파일', 'blocks': [{'type': 'file', 'text': attachment['name'], 'attachment_id': attachment['id']}]})
        self.assertEqual(self.request('DELETE', '/api/attachments/' + attachment['id'])[0], 409)
        self.server.application.workspace.save_blocks(page['id'], [])
        self.assertEqual(self.request('DELETE', '/api/attachments/' + attachment['id'])[0], 409)  # history still references the file
        _, orphan, _ = self.request('POST', '/api/attachments', {'name': 'orphan.txt', 'data': base64.b64encode(b'orphan').decode()})
        orphan_id = json.loads(orphan)['id']
        self.assertEqual(self.request('DELETE', '/api/attachments/' + orphan_id)[0], 200)
        self.assertEqual(self.request('GET', '/api/attachments/' + orphan_id + '/download')[0], 404)


if __name__ == '__main__': unittest.main()
