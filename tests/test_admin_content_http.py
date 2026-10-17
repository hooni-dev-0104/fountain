"""HTTP boundary and incomplete CSV framing on the actual local server."""
import http.client
import json
import threading
import unittest
from unittest.mock import patch
from fountain.core import APIError
from fountain.admin_content import AdminContent
from fountain.server import create_server


class AdminContentHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server=create_server(port=0,db_path=':memory:')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.server.application.store.close();self.thread.join()
    def request(self,method,path,body=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        connection.request(method,path,body,{'X-Fountain-Request':'1','Content-Type':'application/json'})
        return connection,connection.getresponse()
    def test_exact_routes_methods_fields_and_head(self):
        for method,path,expected in [('GET','/api/admin/content?q=a&q=b',400),('GET','/api/admin/content?q=%FF',400),('POST','/api/admin/content/options',405),
            ('GET','/api/admin/content/permissions?kind=page&id=welcome&extra=1',400),('GET','/api/admin/content/unknown',404),
            ('HEAD','/api/admin/content',200),('HEAD','/api/admin/content/export',200)]:
            connection,response=self.request(method,path)
            try:
                self.assertEqual(response.status,expected,(method,path,response.read()))
                if method=='HEAD':self.assertEqual(response.read(),b'')
            finally:connection.close()
        connection,response=self.request('POST','/api/admin/content/permissions','{"kind":"page","kind":"database","id":"welcome","operation":"set_private","review_revision":"'+('a'*64)+'"}')
        try:self.assertEqual(response.status,400)
        finally:response.read();connection.close()
    def test_csv_chunk_framing_success_and_export_policy(self):
        connection,response=self.request('GET','/api/admin/content/export')
        try:
            self.assertEqual(response.status,200)
            self.assertEqual(response.getheader('Transfer-Encoding'),'chunked')
            self.assertIsNone(response.getheader('Content-Length'))
            self.assertIn(b'"shared_with"',response.read())
        finally:connection.close()
        settings=self.server.application.store.get('settings','workspace') or {'id':'workspace'};settings['disable_export']=True
        self.server.application.store.put('settings',settings)
        connection,response=self.request('GET','/api/admin/content/export')
        try:self.assertEqual(response.status,403)
        finally:response.read();connection.close()
    def test_incomplete_export_never_sends_successful_terminal_chunk(self):
        original=AdminContent.csv
        def broken(service,query):
            iterator=original(service,query)
            def generate():
                yield next(iterator)
                raise APIError(409,'Changed during transfer')
            return generate()
        with patch.object(AdminContent,'csv',broken):
            connection,response=self.request('GET','/api/admin/content/export')
            try:
                self.assertEqual(response.status,200)
                with self.assertRaises(http.client.IncompleteRead):response.read()
            finally:connection.close()

    def test_malformed_signed_cursor_json_is_400_without_internal_traceback(self):
        import base64
        signature='a'*64
        payloads=[('{"payload":{"problem":'+value+'},"signature":"'+signature+'"}').encode() for value in ('NaN','Infinity','-Infinity')]
        payloads.extend(json.dumps({'payload':{'problem':value},'signature':signature}).encode() for value in ('\ud800','\udfff'))
        for payload in payloads:
            cursor=base64.urlsafe_b64encode(payload).decode().rstrip('=')
            with self.assertNoLogs('fountain',level='ERROR'):
                connection,response=self.request('GET','/api/admin/content?cursor='+cursor)
                try:
                    self.assertEqual(response.status,400,payload)
                    self.assertNotIn(b'Traceback',response.read())
                finally:connection.close()

    def test_server_checks_revision_after_iterator_eof_before_terminal_chunk(self):
        original=AdminContent.csv
        def changed_after_eof(service,query):
            iterator=original(service,query)
            def generate():
                yield from iterator
                service.store.put('group',{'id':'changed-after-iterator-eof','members':[]})
            return generate()
        with patch.object(AdminContent,'csv',changed_after_eof):
            connection,response=self.request('GET','/api/admin/content/export')
            try:
                self.assertEqual(response.status,200)
                with self.assertRaises(http.client.IncompleteRead):response.read()
            finally:connection.close()
