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

    def test_framed_export_decodes_to_identical_raw_csv(self):
        import base64
        def fetch(path):
            connection,response=self.request('GET',path)
            try:return response.status,dict(response.getheaders()),response.read()
            finally:connection.close()
        status,_,raw=fetch('/api/admin/content/export?format=raw&limit=1')
        self.assertEqual(status,200)
        status,headers,data=fetch('/api/admin/content/export?format=frames&limit=1')
        self.assertEqual(status,200)
        self.assertEqual(headers['Content-Type'],'application/x-ndjson; charset=utf-8')
        self.assertEqual(headers['X-Fountain-CSV-Protocol'],'1')
        self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
        self.assertTrue(data.endswith(b'\n'))
        records=[json.loads(line) for line in data.splitlines()]
        self.assertEqual(records[-1],{'type':'complete','bytes':len(raw)})
        decoded=[]
        for line,record in zip(data.splitlines()[:-1],records[:-1]):
            self.assertLessEqual(len(line)+1,100000)
            self.assertEqual(set(record),{'type','data'});self.assertEqual(record['type'],'data')
            piece=base64.b64decode(record['data'],validate=True)
            self.assertGreater(len(piece),0);self.assertLessEqual(len(piece),65536)
            self.assertEqual(base64.b64encode(piece).decode(),record['data']);decoded.append(piece)
        self.assertEqual(b''.join(decoded),raw)

    def test_frame_format_is_exact_export_only_and_head_does_not_iterate(self):
        for path in ['/api/admin/content/export?format=unknown','/api/admin/content/export?format=',
                     '/api/admin/content/export?format=frames&format=frames','/api/admin/content?format=frames',
                     '/api/admin/content/options?kind=member&format=frames','/api/admin/content/access?kind=page&id=welcome&format=frames',
                     '/api/admin/content/permissions?kind=page&id=welcome&format=frames']:
            connection,response=self.request('GET',path)
            try:self.assertEqual(response.status,400,(path,response.read()))
            finally:response.read();connection.close()
        original=AdminContent.csv
        def cannot_iterate(service,query):
            iterator=original(service,query)
            def generate():
                raise AssertionError('HEAD must not iterate CSV')
                yield next(iterator)
            return generate()
        with patch.object(AdminContent,'csv',cannot_iterate):
            connection,response=self.request('HEAD','/api/admin/content/export?format=frames')
            try:
                self.assertEqual(response.status,200)
                self.assertEqual(response.getheader('X-Fountain-CSV-Protocol'),'1')
                self.assertEqual(response.read(),b'')
            finally:connection.close()

    def test_framed_held_stream_reports_role_or_source_change_and_normal_eof(self):
        original=AdminContent.csv
        for change,status in [('source',409),('role',403)]:
            with self.subTest(change=change):
                entered,released=threading.Event(),threading.Event()
                def held(service,query):
                    iterator=original(service,query)
                    def generate():
                        yield next(iterator)
                        entered.set()
                        if not released.wait(5):raise AssertionError('Test failed to release CSV')
                        yield from iterator
                    return generate()
                with patch.object(AdminContent,'csv',held):
                    connection,response=self.request('GET','/api/admin/content/export?format=frames')
                    try:
                        self.assertEqual(response.status,200)
                        self.assertEqual(json.loads(response.readline())['type'],'data')
                        self.assertTrue(entered.wait(2))
                        store=self.server.application.store
                        if change=='source':store.put('group',{'id':'frame-source-change','members':[]})
                        else:
                            member=store.get('member','local');member['role']='member';store.put('member',member)
                        released.set()
                        records=[json.loads(line) for line in response.read().splitlines()]
                        self.assertEqual(records,[{'type':'error','status':status}])
                    finally:released.set();connection.close()

    def test_framed_final_eof_change_is_error_record_without_complete(self):
        original=AdminContent.csv
        def changed_after_eof(service,query):
            iterator=original(service,query)
            def generate():
                yield from iterator
                service.store.put('group',{'id':'frame-after-eof','members':[]})
            return generate()
        with patch.object(AdminContent,'csv',changed_after_eof):
            connection,response=self.request('GET','/api/admin/content/export?format=frames')
            try:
                self.assertEqual(response.status,200)
                records=[json.loads(line) for line in response.read().splitlines()]
                self.assertTrue(any(record['type']=='data' for record in records))
                self.assertEqual(records[-1],{'type':'error','status':409})
                self.assertFalse(any(record['type']=='complete' for record in records))
            finally:connection.close()

    def test_framed_application_errors_are_sanitized_and_unknown_status_is_503(self):
        original=AdminContent.csv
        for error,status in [(APIError(413,'DO NOT EXPOSE SOURCE OR KEY'),413),(APIError(418,'DO NOT EXPOSE SOURCE OR KEY'),503),(APIError(403.0,'DO NOT EXPOSE SOURCE OR KEY'),503),(RuntimeError('DO NOT EXPOSE SOURCE OR KEY'),503)]:
            def broken(service,query):
                iterator=original(service,query)
                def generate():
                    yield next(iterator)
                    raise error
                return generate()
            with patch.object(AdminContent,'csv',broken):
                connection,response=self.request('GET','/api/admin/content/export?format=frames')
                try:
                    body=response.read()
                    records=[json.loads(line) for line in body.splitlines()]
                    self.assertEqual(records[-1],{'type':'error','status':status})
                    self.assertNotIn(b'DO NOT EXPOSE',body)
                    self.assertFalse(any(record['type']=='complete' for record in records))
                finally:connection.close()

    def test_framed_network_write_failure_never_emits_complete(self):
        from socketserver import _SocketWriter
        original=_SocketWriter.write
        terminals=[]
        def failed_write(writer,data):
            if b'{"type":"complete"' in data:terminals.append('complete')
            if b'{"type":"data"' in data:raise BrokenPipeError('Cancelled test transport')
            return original(writer,data)
        with patch.object(_SocketWriter,'write',failed_write):
            connection,response=self.request('GET','/api/admin/content/export?format=frames')
            try:
                self.assertEqual(response.status,200)
                with self.assertRaises(http.client.IncompleteRead):response.read()
            finally:connection.close()
        self.assertEqual(terminals,[])

    def test_framed_data_is_split_at_64k_bytes_with_bounded_canonical_records(self):
        import base64
        original=AdminContent.csv
        payload=('한글😀,"\n'*12000).encode()
        def large_piece(service,query):
            original(service,query).close() # Perform the real initial authority pin.
            def generate():yield payload
            return generate()
        with patch.object(AdminContent,'csv',large_piece):
            connection,response=self.request('GET','/api/admin/content/export?format=frames')
            try:
                lines=response.read().splitlines()
                records=[json.loads(line) for line in lines]
                chunks=[base64.b64decode(record['data'],validate=True) for record in records[:-1]]
                self.assertGreater(len(chunks),1)
                self.assertTrue(all(0<len(chunk)<=65536 for chunk in chunks))
                self.assertTrue(all(len(line)+1<=100000 for line in lines))
                self.assertEqual(b''.join(chunks),payload)
                self.assertEqual(records[-1],{'type':'complete','bytes':len(payload)})
            finally:connection.close()
