"""Delegated actions use the real SQLite router, writer lock and original ACL."""
import copy
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.core import APIError, Store
from fountain.server import Application


class AdminAuthorizationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / 'workspace.db'
        self.stores = [Store(path), Store(path)]
        for store in self.stores:
            self.addCleanup(store.close)
        self.app, self.other = [Application(store) for store in self.stores]
        self.store = self.stores[0]
        for identity, role in [('reader', 'member'), ('admin', 'admin'), ('guest', 'guest')]:
            self.store.put('member', {'id': identity, 'name': identity, 'role': role,
                'email': identity + '@example.test', 'active': True, 'private': 'DO-NOT-EXPOSE'})
        self.store.put('group', {'id': 'family', 'name': 'Family', 'members': ['local'], 'private': 'DO-NOT-EXPOSE'})
        self.page = self.app.workspace.create_page({'title': 'Private owner document',
            'permissions': {'default': 'private'}, 'blocks': [{'text': 'SECRET-DOCUMENT-BODY'}]})

    def call(self, method, path, body=None, actor='local', app=None):
        app = app or self.app
        principal = app.store.get('member', actor)
        return app.dispatch(method, path, body or {}, {}, principal=principal)[1]

    def grant(self, actions):
        overview = self.call('GET', '/api/admin/roles')
        result = self.call('POST', '/api/admin/roles', {
            'name': 'Limited administration', 'actions': actions, 'revision': overview['revision']})
        return self.call('PUT', '/api/admin/assignments/reader', {
            'role_ids': [result['created_role_id']], 'revision': result['revision']})

    def assert_status(self, status, method, path, body=None, actor='reader'):
        with self.assertRaises(APIError) as caught:
            self.call(method, path, body, actor)
        self.assertEqual(caught.exception.status, status)

    def test_delegation_is_an_explicit_action_boundary_not_document_ownership(self):
        self.assert_status(403, 'GET', '/api/audit')
        self.grant(['audit.read', 'analytics.read'])
        self.assertEqual(self.call('GET', '/api/admin/self', actor='reader'), {
            'actions': ['audit.read', 'analytics.read'], 'can_manage_roles': False})
        self.assertIn('events', self.call('GET', '/api/audit', actor='reader'))
        self.assertIsInstance(self.call('GET', '/api/analytics', actor='reader'), dict)
        self.assert_status(404, 'GET', '/api/pages/' + self.page['id'])
        for path in ['/api/members', '/api/groups', '/api/settings', '/api/accounts',
                     '/api/backup', '/api/export', '/api/admin/roles']:
            self.assert_status(403, 'GET', path)
        advanced = self.call('GET', '/api/advanced', actor='reader')
        self.assertEqual(advanced['audit'], [])
        self.assertEqual(advanced['integrations'], [])
        self.assertNotIn('SECRET-DOCUMENT-BODY', str(advanced))

    def test_member_and_group_reads_are_projected_and_membership_edit_is_narrow(self):
        self.grant(['members.read', 'groups.read', 'groups.membership.manage'])
        for path in ['/api/members', '/api/members/reader', '/api/groups', '/api/groups/family']:
            self.assertNotIn('DO-NOT-EXPOSE', str(self.call('GET', path, actor='reader')))
        guest = self.store.get('member', 'guest')
        self.store.put('member', {**guest, 'name': {'private': 'PRIVATE-NESTED'},
            'email': ['PRIVATE-NESTED'], 'active': {'private': 'PRIVATE-NESTED'}})
        group = self.store.get('group', 'family')
        self.store.put('group', {**group, 'name': {'private': 'PRIVATE-NESTED'},
            'members': ['local', {'private': 'PRIVATE-NESTED'}]})
        before = self.store.meta('_entity_revision')
        for path in ['/api/members', '/api/members/guest', '/api/groups', '/api/groups/family']:
            self.assertNotIn('PRIVATE-NESTED', str(self.call('GET', path, actor='reader')))
        self.assertEqual(self.store.meta('_entity_revision'), before)
        self.store.put('member', guest)
        self.store.put('group', group)
        self.call('PATCH', '/api/groups/family', {'members': ['local', 'admin', 'reader']}, 'reader')
        self.assertEqual(self.store.get('group', 'family')['members'], ['local', 'admin', 'reader'])
        self.assert_status(400, 'PATCH', '/api/groups/family', {'name': 'Renamed'})
        self.assert_status(403, 'POST', '/api/groups', {'name': 'New group'})
        self.assert_status(403, 'DELETE', '/api/groups/family')
        self.assert_status(403, 'PATCH', '/api/members/guest', {'name': 'Changed'})

    def test_legacy_and_delegated_membership_guards_reject_aliases_and_privilege_changes(self):
        self.grant(['members.read', 'members.manage'])
        for actor in ['admin', 'reader']:
            for identity in ['local', 'admin', 'guest']:
                for method in ['PATCH', 'DELETE']:
                    self.assert_status(404, method, '/api/members/' + identity + '/extra', {'role': 'owner'}, actor)
            self.assert_status(403, 'POST', '/api/members', {'role': 'admin'}, actor)
            self.assert_status(403, 'PATCH', '/api/members/guest', {'role': 'owner'}, actor)
            self.assert_status(403, 'PATCH', '/api/members/admin', {'name': 'Changed'}, actor)
            self.assert_status(403, 'DELETE', '/api/members/local', actor=actor)
        self.assertEqual(self.store.get('member', 'local')['role'], 'owner')
        self.assertEqual(self.store.get('member', 'guest')['role'], 'guest')

    def test_generation_changes_invalidate_open_role_editor(self):
        previous = self.grant(['audit.read'])
        self.call('PATCH', '/api/members/reader', {'active': False})
        self.call('PATCH', '/api/members/reader', {'active': True})
        self.assert_status(403, 'GET', '/api/audit')
        before = self.store.meta('_entity_revision')
        self.assert_status(409, 'PUT', '/api/admin/assignments/reader', {
            'role_ids': previous['assignments'][0]['role_ids'], 'revision': previous['revision']}, 'local')
        self.assertEqual(self.store.meta('_entity_revision'), before)

    def test_revoked_reader_waits_for_writer_and_cannot_publish_old_audit(self):
        self.grant(['audit.read'])
        attempted, finished = threading.Event(), threading.Event()
        result = {}

        def read():
            attempted.set()
            try:
                result['value'] = self.call('GET', '/api/audit', actor='reader', app=self.other)
            except BaseException as error:
                result['error'] = error
            finally:
                finished.set()

        principal = copy.deepcopy(self.store.get('member', 'reader'))
        checked = threading.Event()
        original = self.other._request_context

        def context(*args, **kwargs):
            checked.set()
            return original(*args, **kwargs)

        with patch.object(self.other, '_request_context', context):
            with self.store.transaction():
                overview = self.call('GET', '/api/admin/roles')
                self.call('PUT', '/api/admin/assignments/reader', {'role_ids': [], 'revision': overview['revision']})
                thread = threading.Thread(target=read, daemon=True)
                thread.start()
                self.assertTrue(attempted.wait(2))
                blocked = not checked.wait(0.15)
            self.assertTrue(finished.wait(5))
            thread.join(1)
        self.assertTrue(blocked, 'Delegated read checked authority before prior writer committed')
        self.assertNotIn('value', result)
        self.assertIsInstance(result.get('error'), APIError)
        self.assertEqual(result['error'].status, 403)
        self.assertEqual(self.store.get('member', 'reader')['role'], principal['role'])


if __name__ == '__main__':
    unittest.main()
