"""Schema promotion must not manufacture attachment/relation read authority."""
import base64
import copy
import http.client
import json
import threading
import unittest
from unittest.mock import patch

from fountain.server import create_server


class SchemaReferenceHTTPTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'FOUNTAIN_ACCESS_TOKEN': ''})
        environment.start()
        self.addCleanup(environment.stop)
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.store = self.server.application.store
        auth = self.server.application.auth
        for identity in ('alice', 'bob'):
            self.store.put('member', {'id': identity, 'name': identity,
                'email': identity + '@schema.invalid', 'role': 'member', 'active': True})
        for identity in ('local', 'alice', 'bob'):
            auth.create_account(identity, 'schema-fixture-password')
        auth.enable_accounts()
        self.cookies = {}
        for identity, email in [('local', 'local@fountain.local'),
                                ('alice', 'alice@schema.invalid'), ('bob', 'bob@schema.invalid')]:
            status, _, headers = self.request('POST', '/api/session',
                {'email': email, 'password': 'schema-fixture-password'}, actor=None)
            self.assertEqual(status, 200)
            self.cookies[identity] = headers['Set-Cookie'].split(';', 1)[0]
        self.private_bytes = 'Alice private fixture bytes 한글😀'.encode()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.store.close()

    def request(self, method, path, body=None, actor='bob', raw=False, **extra):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/octet-stream' if raw else 'application/json',
                   'X-Fountain-Request': '1', 'Cookie': self.cookies.get(actor, '')}
        headers.update(extra)
        try:
            connection.request(method, path, body if raw else json.dumps(body).encode() if body is not None else None, headers)
            response = connection.getresponse()
            content = response.read()
            payload = json.loads(content) if content and 'json' in response.getheader('Content-Type', '') else content
            return response.status, payload, dict(response.getheaders())
        finally:
            connection.close()

    def database(self, kind='multi_select', actor='bob', **extra):
        status, database, _ = self.request('POST', '/api/databases', {'name': '자료',
            'properties': [{'id': 'name', 'name': '이름', 'type': 'title'},
                           {'id': 'stash', 'name': '자료 값', 'type': kind}], **extra}, actor)
        self.assertEqual(status, 201)
        return database

    def row(self, database, value=None, actor='bob', **values):
        properties = {'name': '행', **values}
        if value is not None:
            properties['stash'] = value
        status, row, _ = self.request('POST', '/api/databases/' + database['id'] + '/rows',
                                       {'properties': properties}, actor)
        self.assertEqual(status, 201)
        return row

    def file(self, actor='alice', chunks=False):
        if not chunks:
            status, attachment, _ = self.request('POST', '/api/attachments',
                {'name': 'private.txt', 'data': base64.b64encode(self.private_bytes).decode()}, actor)
            self.assertEqual(status, 201)
            return attachment
        status, page, _ = self.request('POST', '/api/pages', {'title': '개인 업로드',
            'permissions': {'default': 'private'}, 'blocks': []}, actor)
        self.assertEqual(status, 201)
        status, upload, _ = self.request('POST', '/api/uploads',
            {'name': 'private.bin', 'size': len(self.private_bytes), 'page_id': page['id']}, actor)
        self.assertEqual(status, 201)
        path = '/api/uploads/' + upload['id']
        self.assertEqual(self.request('PUT', path + '/chunks?offset=0', self.private_bytes, actor, True)[0], 200)
        status, attachment, _ = self.request('POST', path + '/complete', {}, actor)
        self.assertEqual(status, 201)
        return attachment

    def schema(self, database, kind, **fields):
        properties = copy.deepcopy(database['properties'])
        next(prop for prop in properties if prop['id'] == 'stash').update(type=kind, **fields)
        return properties

    def before(self):
        # Valid account reads do not mutate session rows. Everything below must
        # survive a rejected PATCH, including the global CAS/access counters.
        return {'entities': {kind: self.store.list(kind) for kind in
                ('database', 'row', 'page', 'version', 'attachment', 'upload', 'audit')},
                'revision': self.store.meta('_entity_revision'),
                'access_revision': self.store.meta('access_revision', 0)}

    def denied_file_promotion(self, *, chunks=False, scalar=False):
        attachment = self.file(chunks=chunks)
        owned = self.file(actor='bob')
        download = '/api/attachments/' + attachment['id'] + '/download'
        self.assertEqual(self.request('GET', download)[0], 404)
        database = self.database('text' if scalar else 'multi_select')
        self.row(database, attachment['id'] if scalar else [owned['id'], attachment['id']])
        before = self.before()
        status, _, _ = self.request('PATCH', '/api/databases/' + database['id'],
            {'name': 'MUST ROLLBACK', 'properties': self.schema(database, 'files'),
             'views': [{'id': 'changed', 'type': 'table'}]})
        # Regression RED was verified against the vulnerable actual HTTP route:
        # PATCH 200 turned the ordinary value into a GET-200 private byte grant.
        exposed, content, _ = self.request('GET', download)
        self.assertFalse(exposed == 200 and content == self.private_bytes,
                         'Schema promotion made another account private bytes readable')
        self.assertEqual(status, 400 if scalar else 404)
        self.assertEqual(self.before(), before)
        self.assertEqual(self.request('GET', download, actor='alice')[:2], (200, self.private_bytes))
        self.assertEqual(self.request('GET', '/api/attachments/' + attachment['id'] + '/metadata')[0], 404)
        self.assertEqual(self.request('GET', download, Range='bytes=0-7')[0], 404)

    def test_multiselect_to_files_cannot_expose_private_inline_bytes(self):
        self.denied_file_promotion()

    def test_multiselect_to_files_cannot_expose_private_chunked_bytes(self):
        self.denied_file_promotion(chunks=True)

    def test_scalar_text_to_files_is_rejected_without_granting_private_bytes(self):
        self.denied_file_promotion(scalar=True)

    def test_authorized_and_empty_file_promotions_are_supported(self):
        owned = self.file(actor='bob')
        for value in ([owned['id']], [], None):
            with self.subTest(value=value):
                database = self.database()
                self.row(database, value)
                status, result, _ = self.request('PATCH', '/api/databases/' + database['id'],
                                               {'properties': self.schema(database, 'files')})
                self.assertEqual(status, 200)
                self.assertEqual(result['properties'][1]['type'], 'files')
        self.assertEqual(self.request('GET', '/api/attachments/' + owned['id'] + '/download')[:2],
                         (200, self.private_bytes))
        database = self.database()
        self.row(database)
        properties = database['properties'] + [{'id': 'new', 'name': '빈 첨부', 'type': 'files'}]
        self.assertEqual(self.request('PATCH', '/api/databases/' + database['id'], {'properties': properties})[0], 200)

    def test_relation_promotion_requires_current_target_read_permission(self):
        private = self.database(actor='alice', permissions={'default': 'private'})
        target = self.row(private, actor='alice')
        database = self.database()
        self.row(database, [target['id']])
        before = self.before()
        status, _, _ = self.request('PATCH', '/api/databases/' + database['id'],
            {'properties': self.schema(database, 'relation', database_id=private['id'])})
        self.assertEqual(status, 404)
        self.assertEqual(self.before(), before)
        allowed = self.database()
        visible = self.row(allowed)
        public = self.database()
        self.row(public, [visible['id']])
        self.assertEqual(self.request('PATCH', '/api/databases/' + public['id'],
            {'properties': self.schema(public, 'relation', database_id=allowed['id'])})[0], 200)

    def test_relation_database_retarget_checks_all_current_values(self):
        first, second = self.database(), self.database()
        target = self.row(first)
        database = self.database()
        self.row(database, [target['id']])
        relation = self.schema(database, 'relation', database_id=first['id'])
        self.assertEqual(self.request('PATCH', '/api/databases/' + database['id'], {'properties': relation})[0], 200)
        current = self.store.get('database', database['id'])
        before = self.before()
        status, error, _ = self.request('PATCH', '/api/databases/' + database['id'],
            {'properties': self.schema(current, 'relation', database_id=second['id'])})
        self.assertEqual(status, 400)
        self.assertEqual(error['error'], 'Relation target row not found in target database')
        self.assertEqual(self.before(), before)
        self.assertEqual(self.request('PATCH', '/api/databases/' + database['id'],
            {'properties': self.schema(current, 'relation', database_id=None)})[0], 200)

    def test_unchanged_files_with_hidden_row_refs_allow_unrelated_schema_edits(self):
        attachment = self.file()
        database = self.database('files', actor='alice', permissions={'default': 'private', 'members': {'bob': 'full'}})
        row = self.row(database, [attachment['id']], actor='alice')
        self.store.put('row', {**self.store.get('row', row['id']), 'permissions': {'default': 'private'}})
        download = '/api/attachments/' + attachment['id'] + '/download'
        self.assertEqual(self.request('GET', download)[0], 404)
        properties = copy.deepcopy(database['properties'])
        properties[1]['name'] = '이름만 변경'
        properties.append({'id': 'note', 'name': '메모', 'type': 'text'})
        self.assertEqual(self.request('PATCH', '/api/databases/' + database['id'], {'properties': properties})[0], 200)
        self.assertEqual(self.request('GET', download)[0], 404)
        self.assertEqual(self.store.get('row', row['id'])['properties']['stash'], [attachment['id']])

    def test_readding_removed_file_property_cannot_recreate_old_read_grant(self):
        attachment = self.file()
        database = self.database('files', actor='alice', permissions={'default': 'private', 'members': {'bob': 'full'}})
        self.row(database, [attachment['id']], actor='alice')
        path = '/api/databases/' + database['id']
        download = '/api/attachments/' + attachment['id'] + '/download'
        self.assertEqual(self.request('GET', download)[0], 200)
        self.assertEqual(self.request('PATCH', path, {'properties': database['properties'][:1]})[0], 200)
        self.assertEqual(self.request('GET', download)[0], 404)
        before = self.before()
        self.assertEqual(self.request('PATCH', path, {'properties': database['properties']})[0], 404)
        self.assertEqual(self.before(), before)
        self.assertEqual(self.request('GET', download)[0], 404)

    def test_promoted_reference_values_require_bounded_string_id_lists(self):
        for invalid in ([True], [0], [{}], [''], ['x' * 161], ['x'] * 1001):
            with self.subTest(value_type=type(invalid[0]).__name__, count=len(invalid)):
                database = self.database()
                row = self.row(database)
                # Last case exceeds the ordinary row API's existing list bound;
                # exercise safe rejection of malformed legacy persisted data.
                self.store.put('row', {**self.store.get('row', row['id']),
                                       'properties': {'name': '행', 'stash': invalid}})
                before = self.before()
                status, error, _ = self.request('PATCH', '/api/databases/' + database['id'],
                                               {'properties': self.schema(database, 'files')})
                self.assertEqual(status, 400)
                self.assertEqual(error['error'], 'Promoted reference properties must contain resource ID lists')
                self.assertEqual(self.before(), before)


if __name__ == '__main__':
    unittest.main()
