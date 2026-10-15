import base64
import http.client
import json
import threading
import os
import tempfile
from pathlib import Path
from fountain.auth import Auth
from fountain.core import Store
import unittest
from urllib.parse import quote
from unittest.mock import patch

from fountain.server import create_server


class PermissionsHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(port=0, db_path=':memory:')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.app = self.server.application
        self.member = self.call('POST', '/api/members', {'name': '가족', 'email': 'family@example.org', 'role': 'member'})[1]
        self.guest = self.call('POST', '/api/members', {'name': '손님', 'email': 'guest@example.org', 'role': 'guest'})[1]
        self.admin = self.call('POST', '/api/members', {'name': '관리자', 'email': 'admin@example.org', 'role': 'admin'})[1]
        for identity in ('local', self.member['id'], self.guest['id'], self.admin['id']):
            self.assertEqual(self.call('POST', '/api/accounts', {'member_id': identity, 'password': 'test-password-123'})[0], 201)
        self.assertEqual(self.call('POST', '/api/accounts/enable', {})[0], 200)
        self.owner_cookie = self.login('local@fountain.local')
        self.member_cookie = self.login('family@example.org')
        self.guest_cookie = self.login('guest@example.org')
        self.admin_cookie = self.login('admin@example.org')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.store.close()
        self.thread.join()

    def call(self, method, path, body=None, cookie=''):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, json.dumps(body) if body is not None else None,
                     {'Content-Type': 'application/json', 'X-Fountain-Request': '1', 'Cookie': cookie})
        response = conn.getresponse()
        raw = response.read()
        payload = json.loads(raw) if raw and 'json' in response.getheader('Content-Type', '') else raw
        result = response.status, payload, response.getheader('Set-Cookie', '')
        conn.close()
        return result

    def login(self, email):
        status, result, cookie = self.call('POST', '/api/session', {'email': email, 'password': 'test-password-123'})
        self.assertEqual(status, 200)
        self.assertEqual(result['mode'], 'accounts')
        self.assertEqual(result['member']['email'], email)
        return cookie.split(';')[0]

    def page(self, title='개인 기록', **kwargs):
        status, page, _ = self.call('POST', '/api/pages', {'title': title, **kwargs}, self.owner_cookie)
        self.assertEqual(status, 201)
        return page

    def acl(self, page, permissions):
        return self.call('PATCH', '/api/pages/' + page['id'] + '/permissions', {'permissions': permissions}, self.owner_cookie)

    def test_private_pages_hidden_from_snapshot_search_direct_and_admin(self):
        page = self.page('숨긴 고유어')
        self.assertEqual(self.acl(page, {'default': 'private'})[0], 200)
        for cookie in (self.member_cookie, self.guest_cookie, self.admin_cookie):
            self.assertEqual(self.call('GET', '/api/pages/' + page['id'], cookie=cookie)[0], 404)
            workspace = self.call('GET', '/api/workspace', cookie=cookie)[1]
            self.assertNotIn(page['id'], [p['id'] for p in workspace['pages']])
            result = self.call('GET', '/api/search?q=' + quote('숨긴 고유어'), cookie=cookie)[1]
            self.assertEqual(result['results'], [])
        self.assertEqual(self.call('GET', '/api/pages/' + page['id'], cookie=self.owner_cookie)[0], 200)

    def test_view_comment_edit_and_full_cannot_escalate_or_spoof(self):
        page = self.page()
        path = '/api/pages/' + page['id']
        self.acl(page, {'default': 'private', 'members': {self.member['id']: 'view'}})
        self.assertEqual(self.call('GET', path, cookie=self.member_cookie)[1]['page']['access_level'], 1)
        self.assertEqual(self.call('PUT', path + '/blocks', {'blocks': []}, self.member_cookie)[0], 403)
        self.assertEqual(self.call('POST', path + '/comments', {'text': '안 됨'}, self.member_cookie)[0], 403)
        self.assertEqual(self.call('PATCH', path + '/permissions', {'permissions': {'default': 'workspace'}}, self.member_cookie)[0], 403)
        self.acl(page, {'default': 'private', 'members': {self.member['id']: 'comment'}})
        status, comment, _ = self.call('POST', path + '/comments', {'text': '댓글', 'author': 'local'}, self.member_cookie)
        self.assertEqual(status, 201)
        self.assertEqual(comment['author'], self.member['id'])
        self.acl(page, {'default': 'private', 'members': {self.member['id']: 'edit'}})
        self.assertEqual(self.call('PUT', path + '/blocks', {'blocks': [{'text': '수정'}]}, self.member_cookie)[0], 200)
        for body in ({'archived': True}, {'parent_id': None}):
            self.assertEqual(self.call('PATCH', path, body, self.member_cookie)[0], 403)
        self.assertEqual(self.call('DELETE', path, cookie=self.member_cookie)[0], 403)
        self.acl(page, {'default': 'private', 'members': {self.member['id']: 'full'}})
        self.assertEqual(self.call('PATCH', path + '/permissions', {'permissions': {'default': 'workspace'}}, self.member_cookie)[0], 200)

    def test_accounts_management_role_and_deactivation_session_revocation(self):
        for path in ('/api/accounts', '/api/audit', '/api/analytics', '/api/backup', '/api/export'):
            self.assertEqual(self.call('GET', path, cookie=self.member_cookie)[0], 403, path)
        self.assertEqual(self.call('PATCH', '/api/settings', {'disable_export': True}, self.admin_cookie)[0], 403)
        self.assertEqual(self.call('PATCH', '/api/members/' + self.admin['id'], {'role': 'owner'}, self.admin_cookie)[0], 403)
        self.assertEqual(self.call('PATCH', '/api/members/local', {'active': False}, self.owner_cookie)[0], 409)
        self.assertEqual(self.call('DELETE', '/api/accounts/local', cookie=self.owner_cookie)[0], 409)
        path = '/api/members/' + self.member['id']
        self.assertEqual(self.call('PATCH', path, {'active': False}, self.owner_cookie)[0], 200)
        self.assertEqual(self.call('PATCH', path, {'active': True}, self.owner_cookie)[0], 200)
        self.assertEqual(self.call('GET', '/api/workspace', cookie=self.member_cookie)[0], 401)
        self.member_cookie = self.login('family@example.org')
        self.assertEqual(self.call('GET', '/api/workspace', cookie=self.member_cookie)[0], 200)

    def test_private_teamspace_and_inheritance_are_enforced(self):
        _, teamspace, _ = self.call('POST', '/api/teamspaces', {'name': '비공개 공간', 'visibility': 'private', 'members': []}, self.owner_cookie)
        parent = self.page(teamspace_id=teamspace['id'])
        child = self.page('자식', parent_id=parent['id'])
        for path in ('/api/workspace', '/api/teamspaces', '/api/advanced'):
            result = self.call('GET', path, cookie=self.member_cookie)[1]
            self.assertNotIn(teamspace['id'], [t['id'] for t in result['teamspaces']])
        self.assertEqual(self.call('GET', '/api/pages/' + child['id'], cookie=self.member_cookie)[0], 404)
        self.acl(parent, {'default': 'private', 'members': {self.guest['id']: 'view'}})
        snapshot = self.call('GET', '/api/workspace', cookie=self.guest_cookie)[1]
        self.assertIn(child['id'], [p['id'] for p in snapshot['pages']])
        self.assertEqual(snapshot['teamspaces'], [])
        self.assertEqual([m['id'] for m in snapshot['members']], [self.guest['id']])

    def test_assigned_rows_relations_rollups_and_guest_filtering(self):
        _, database, _ = self.call('POST', '/api/databases', {'name': '가족 업무', 'properties': [
            {'id': 'name', 'name': '제목', 'type': 'title'}, {'id': 'assignee', 'name': '담당', 'type': 'person'},
            {'id': 'cost', 'name': '비용', 'type': 'number'}, {'id': 'related', 'name': '관계', 'type': 'relation'},
            {'id': 'total', 'name': '합계', 'type': 'rollup', 'relation_property': 'related', 'target_property': 'cost', 'aggregation': 'sum'}]}, self.owner_cookie)
        prefix = '/api/databases/' + database['id']
        hidden = self.call('POST', prefix + '/rows', {'properties': {'name': '비공개 비용', 'assignee': 'local', 'cost': 999}}, self.owner_cookie)[1]
        visible = self.call('POST', prefix + '/rows', {'properties': {'name': '내 업무', 'assignee': self.member['id'], 'cost': 2, 'related': [hidden['id']]}}, self.owner_cookie)[1]
        policy = {'row_permissions': {'mode': 'assigned', 'property_id': 'assignee', 'edit_assigned': True, 'allow_create': False}}
        self.assertEqual(self.call('PATCH', prefix + '/permissions', policy, self.owner_cookie)[0], 200)
        detail = self.call('GET', prefix, cookie=self.member_cookie)[1]
        self.assertEqual([r['id'] for r in detail['rows']], [visible['id']])
        self.assertEqual(detail['rows'][0]['properties']['related'], [])
        self.assertEqual(detail['rows'][0]['properties']['total'], 0)
        self.assertFalse(detail['database']['can_create_row'])
        edited = self.call('PATCH', prefix + '/rows/' + visible['id'], {'properties': {'name': '내 업무 수정'}}, self.member_cookie)
        self.assertEqual(edited[0], 200)
        self.assertEqual(edited[1]['properties']['related'], [])
        self.assertEqual(self.call('PATCH', prefix + '/rows/' + hidden['id'], {'properties': {'cost': 0}}, self.member_cookie)[0], 404)
        self.assertEqual(self.call('POST', prefix + '/rows', {'properties': {'name': '금지'}}, self.member_cookie)[0], 403)
        self.assertEqual(self.call('PATCH', prefix + '/rows/' + visible['id'], {'properties': {'related': [hidden['id']]}}, self.member_cookie)[0], 404)
        owner_rows = self.call('GET', prefix, cookie=self.owner_cookie)[1]['rows']
        self.assertEqual(next(r for r in owner_rows if r['id'] == visible['id'])['properties']['total'], 999)
        self.assertEqual(self.call('GET', prefix, cookie=self.guest_cookie)[0], 404)

    def test_private_attachment_cannot_be_laundered_through_new_page(self):
        attachment = self.call('POST', '/api/attachments', {'name': 'private.txt', 'data': base64.b64encode(b'private content').decode()}, self.owner_cookie)[1]
        self.assertEqual(self.call('GET', '/api/attachments/' + attachment['id'] + '/download', cookie=self.member_cookie)[0], 404)
        forged = {'title': '파일 경로 우회', 'blocks': [{'type': 'file', 'text': '파일', 'attachment_id': attachment['id']}]}
        self.assertEqual(self.call('POST', '/api/pages', forged, self.member_cookie)[0], 404)
        page = self.page(**{'blocks': forged['blocks']})
        self.acl(page, {'default': 'private', 'members': {self.member['id']: 'view'}})
        self.assertEqual(self.call('GET', '/api/attachments/' + attachment['id'] + '/download', cookie=self.member_cookie)[1], b'private content')
        self.acl(page, {'default': 'private'})
        self.assertEqual(self.call('GET', '/api/attachments/' + attachment['id'] + '/download', cookie=self.member_cookie)[0], 404)

    def test_resource_ownership_cannot_be_overwritten_and_audit_records_actor(self):
        self.assertEqual(self.call('POST', '/api/databases', {'id': 'projects', 'name': '덮어쓰기'}, self.member_cookie)[0], 409)
        status, page, _ = self.call('POST', '/api/pages', {'title': '내 기록', 'owner_id': 'local', 'permissions': {'default': 'private'}}, self.member_cookie)
        self.assertEqual(status, 201)
        self.assertEqual(page['owner_id'], self.member['id'])
        self.assertEqual(self.call('PATCH', '/api/pages/' + page['id'], {'owner_id': 'local', 'title': '유지'}, self.member_cookie)[1]['owner_id'], self.member['id'])
        self.assertEqual(self.app.store.get('database', 'projects')['owner_id'], 'local')
        audit = [e for e in self.app.store.list('audit') if e['action'] == 'page.created' and e['details'].get('page_id') == page['id']]
        self.assertEqual(audit[0]['user'], self.member['id'])

    def test_revoked_identity_never_falls_back_to_internal_owner(self):
        with patch.object(self.app.auth, 'authenticate', return_value=True), patch.object(self.app.auth, 'principal', return_value=None):
            self.assertEqual(self.call('GET', '/api/accounts', cookie=self.member_cookie)[0], 401)
        with self.assertRaises(Exception) as caught:
            self.app.dispatch('GET', '/api/accounts', {}, {}, principal=None)
        self.assertEqual(caught.exception.status, 401)

    def test_unicode_email_alias_cannot_lock_out_owner(self):
        self.assertEqual(self.call('PATCH', '/api/members/local', {'email': 'boss@example.org'}, self.owner_cookie)[0], 200)
        self.assertEqual(self.call('POST', '/api/members', {'email': 'boſſ@example.org', 'name': '별칭'}, self.admin_cookie)[0], 409)
        # Old metadata without credentials must not interfere with an existing login.
        self.app.store.put('member', {'id': 'legacy-alias', 'email': 'boſſ@example.org', 'name': '예전 별칭', 'role': 'member'})
        self.assertTrue(self.login('boss@example.org'))

    def test_scim_operations_preserve_an_active_owner(self):
        body = {'Operations': [{'op': 'replace', 'path': 'active', 'value': False},
                               {'op': 'replace', 'path': 'members', 'value': {'active': True}}]}
        # Invoke the HTTP endpoint with its independent provisioning credential.
        with patch.dict(os.environ, {'FOUNTAIN_SCIM_TOKEN': 'test-only-provisioning'}):
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
            conn.request('PATCH', '/scim/v2/Users/local', json.dumps(body), {'Content-Type': 'application/scim+json', 'Authorization': 'Bearer test-only-provisioning'})
            response = conn.getresponse()
            self.assertIn(response.status, (400, 409))
            response.read()
            conn.close()
        self.assertTrue(self.app.auth._owners())
        self.assertTrue(self.login('local@fountain.local'))

    def test_member_and_group_removal_keeps_permissions_editable(self):
        group = self.call('POST', '/api/groups', {'name': '가족 그룹', 'members': [self.guest['id']]}, self.owner_cookie)[1]
        page = self.page()
        self.acl(page, {'default': 'private', 'members': {self.guest['id']: 'view'}, 'groups': {group['id']: 'comment'}})
        self.assertEqual(self.call('DELETE', '/api/groups/' + group['id'], cookie=self.owner_cookie)[0], 200)
        self.assertEqual(self.call('DELETE', '/api/members/' + self.guest['id'], cookie=self.owner_cookie)[0], 200)
        permissions = self.call('GET', '/api/pages/' + page['id'] + '/permissions', cookie=self.owner_cookie)[1]['permissions']
        self.assertEqual(permissions['groups'], {})
        self.assertEqual(permissions['members'], {})
        self.assertEqual(self.acl(page, permissions)[0], 200)

    def test_database_file_access_tracks_row_permissions_and_protects_references(self):
        attachment = self.call('POST', '/api/attachments', {'name': 'db-file.txt', 'data': base64.b64encode(b'database file').decode()}, self.owner_cookie)[1]
        database = self.call('POST', '/api/databases', {'name': '파일 DB', 'properties': [{'id': 'name', 'name': '이름', 'type': 'title'}, {'id': 'files', 'name': '파일', 'type': 'files'}]}, self.owner_cookie)[1]
        path = '/api/databases/' + database['id']
        self.call('POST', path + '/rows', {'properties': {'name': '파일', 'files': [attachment['id']]}}, self.owner_cookie)
        download = '/api/attachments/' + attachment['id'] + '/download'
        self.assertEqual(self.call('GET', download, cookie=self.member_cookie)[1], b'database file')
        self.call('PATCH', path + '/permissions', {'permissions': {'default': 'private'}}, self.owner_cookie)
        self.assertEqual(self.call('GET', download, cookie=self.member_cookie)[0], 404)
        self.assertEqual(self.call('DELETE', '/api/attachments/' + attachment['id'], cookie=self.owner_cookie)[0], 409)

    def test_full_backup_preserves_account_passwords_without_live_sessions(self):
        status, content, _ = self.call('GET', '/api/backup', cookie=self.owner_cookie)
        self.assertEqual(status, 200)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'restored.db'
            path.write_bytes(content)
            store = Store(path)
            try:
                auth = Auth(store)
                self.assertTrue(auth.accounts_required)
                self.assertFalse(auth.authenticate(self.member_cookie))
                token = auth.login({'email': 'family@example.org', 'password': 'test-password-123'})
                self.assertEqual(auth.principal('fountain_session=' + token)['id'], self.member['id'])
            finally:
                store.close()

    def test_import_does_not_publish_documents_or_trust_foreign_owners(self):
        content = {'pages': [{'id': 'old-page', 'title': '가져온 비공개'}], 'databases': [
            {'id': 'old-db', 'name': '가져온 DB', 'owner_id': self.member['id'], 'permissions': {'default': 'workspace'},
             'properties': [{'id': 'name', 'name': '이름', 'type': 'title'}]}]}
        status, imported, _ = self.call('POST', '/api/import', {'format': 'json', 'content': json.dumps(content)}, self.owner_cookie)
        self.assertEqual(status, 201)
        page = imported['pages'][0]
        self.assertEqual(self.call('GET', '/api/pages/' + page['id'], cookie=self.member_cookie)[0], 404)
        database = self.app.store.get('database', imported['databases'][0])
        self.assertEqual(database['owner_id'], 'local')
        self.assertEqual(self.call('GET', '/api/databases/' + database['id'], cookie=self.member_cookie)[0], 404)

    def test_invalid_teamspace_membership_cannot_break_other_members_snapshot(self):
        self.assertEqual(self.call('POST', '/api/teamspaces', {'name': '잘못된 그룹', 'groups': 42}, self.member_cookie)[0], 400)
        self.assertEqual(self.call('POST', '/api/pages', {'title': '잘못된 부모', 'parent_id': []}, self.member_cookie)[0], 400)
        self.assertEqual(self.call('GET', '/api/workspace', cookie=self.guest_cookie)[0], 200)


if __name__ == '__main__': unittest.main()
