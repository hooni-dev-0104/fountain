import unittest
from unittest.mock import patch

from fountain.access import Access
from fountain.admin_roles import AdminAuthority, ACTIONS, MEMBERSHIP_ACTIONS, generation_key, invalidate_member
from fountain.core import APIError, Store

STAMP = '2026-10-17T08:00:00.000000+00:00'
GENERATION = '1' * 32


def fixture(store):
    with patch('fountain.core.now', return_value=STAMP):
        for identity, role in [('local', 'owner'), ('alice', 'member'), ('bob', 'member'), ('admin', 'admin'),
                               ('guest', 'guest'), ('inactive', 'member'), ('__proto__', 'member'), ('成员😀', 'member')]:
            store.put('member', {'id': identity, 'name': identity, 'email': identity + '@example.test',
                                 'role': role, 'active': identity != 'inactive'})
        for identity, actions in [('audit', ['audit.read']), ('analytics', ['analytics.read']),
                                  ('people', ['members.read', 'members.manage', 'groups.read', 'groups.membership.manage'])]:
            store.put('admin_role', {'id': identity, 'version': 1, 'nonce': '2' * 32,
                                    'name': identity, 'description': '', 'actions': actions})
        store.set_meta(generation_key('alice'), GENERATION)
        store.put('admin_assignment', {'id': 'alice', 'member_id': 'alice', 'generation': GENERATION,
                                       'role_ids': ['audit', 'analytics'], 'role_nonces': {'audit': '2' * 32, 'analytics': '2' * 32}})
        store.put('page', {'id': 'private', 'owner_id': 'bob', 'permissions': {'default': 'private', 'members': {}, 'groups': {}}})


class AdminRolesTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        fixture(self.store)
        self.owner = self.authority('local')

    def tearDown(self):
        self.store.close()

    def authority(self, identity='alice', principal=None):
        return AdminAuthority(self.store, Access(self.store, principal or self.store.get('member', identity)))

    def call(self, method='GET', path='/api/admin/roles', body=None, actor='local', query=None):
        return self.authority(actor).route(method, path, {} if body is None else body, {} if query is None else query)

    def mutate(self, method, path, body=None):
        return self.call(method, path, {'revision': self.owner.overview()['revision'], **(body or {})})

    def state(self):
        return (list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id')),
                list(self.store.db.execute('SELECT key,data FROM meta ORDER BY key')))

    def error(self, status, callback):
        before = self.state()
        with self.assertRaises(APIError) as error:
            callback()
        self.assertEqual(error.exception.status, status)
        self.assertEqual(self.state(), before)

    def test_union_base_roles_and_ordinary_content_acl(self):
        self.assertEqual(set(self.owner.actions()), ACTIONS)
        self.assertEqual(set(self.authority('admin').actions()), MEMBERSHIP_ACTIONS)
        self.assertEqual(self.authority().actions(), ['audit.read', 'analytics.read'])
        for identity in ['bob', 'guest', 'inactive']:
            self.assertEqual(self.authority(identity).actions(), [])
        access = self.authority().access
        self.assertFalse(access.owner)
        self.assertFalse(access.can('page', self.store.get('page', 'private')))
        self.assertFalse(self.authority().allows('future.read'))
        self.error(403, lambda: self.authority().require_action('members.manage'))

    def test_content_actions_require_explicit_grants_and_the_read_dependency(self):
        added = {'content.search.read', 'content.search.export', 'content.permissions.manage', 'content.publish.manage'}
        for actor in ['alice', 'admin', 'bob', 'guest']:
            self.assertFalse(added.intersection(self.authority(actor).actions()))
        self.assertTrue(added <= set(self.owner.actions()))
        for action in added - {'content.search.read'}:
            self.error(400, lambda action=action: self.mutate('POST', '/api/admin/roles', {'name': 'Invalid grant', 'actions': [action]}))
        created = self.mutate('POST', '/api/admin/roles', {
            'name': 'Content export only', 'actions': ['content.search.read', 'content.search.export']})
        role = created['created_role_id']
        self.mutate('PUT', '/api/admin/assignments/alice', {'role_ids': [role, 'audit']})
        self.assertEqual(set(self.authority().actions()), {'audit.read', 'content.search.read', 'content.search.export'})
        self.assertFalse(self.authority().access.can('page', self.store.get('page', 'private')))
        self.error(400, lambda: self.mutate('PATCH', '/api/admin/roles/' + role, {'actions': ['content.search.export']}))

    def test_current_member_revalidation_and_no_synthetic_grants(self):
        authority = self.authority()
        alice = self.store.get('member', 'alice')
        alice.update(admin_actions=['members.manage'], role_ids=['people'], capabilities={'members.manage': True})
        self.store.put('member', alice)
        self.assertFalse(authority.allows('members.manage'))
        for changes in [{'active': False}, {'role': 'guest'}, {'role': 'admin'}, {'role': 'unknown'}]:
            self.store.put('member', {**alice, **changes})
            self.assertEqual(authority.actions(), [])
        self.store.delete('member', 'alice')
        self.assertEqual(authority.actions(), [])
        for principal in [{'id': 'bob', 'role': 'owner'}, {'id': 'missing', 'role': 'owner'}, {'id': 'guest', 'role': 'member'}]:
            self.assertEqual(self.authority(principal=principal).actions(), [])

    def test_read_only_owner_overview_and_self_dto(self):
        before = self.state()
        overview = self.owner.overview()
        self.assertEqual(len(overview['revision']), 64)
        self.assertEqual(overview['assignments'], [{'member_id': 'alice', 'role_ids': ['analytics', 'audit']}])
        self.assertEqual({item['id'] for item in overview['eligible_members']}, {'alice', 'bob', 'admin', '__proto__', '成员😀'})
        self.assertNotIn('generation', str(overview))
        self.assertNotIn('nonce', str(overview))
        self.assertEqual(self.call(path='/api/admin/self', actor='guest'), {'actions': [], 'can_manage_roles': False})
        self.assertEqual(self.state(), before)
        for identity in ['alice', 'admin', 'guest', 'inactive']:
            self.error(403, lambda identity=identity: self.call(actor=identity))

    def test_owner_mutations_cas_and_atomic_failure(self):
        before = self.owner.overview()['revision']
        created = self.mutate('POST', '/api/admin/roles', {'name': '감사😀', 'actions': ['audit.read']})
        identity = created['created_role_id']
        self.assertNotEqual(created['revision'], before)
        self.assertEqual(self.store.meta('access_revision'), 1)
        self.error(409, lambda: self.call('PATCH', '/api/admin/roles/' + identity, {'name': 'stale', 'revision': before}))
        self.mutate('PATCH', '/api/admin/roles/' + identity, {'description': '가족용'})
        self.mutate('PUT', '/api/admin/assignments/bob', {'role_ids': [identity]})
        self.assertTrue(self.authority('bob').allows('audit.read'))
        self.mutate('DELETE', '/api/admin/roles/' + identity)
        self.assertFalse(self.authority('bob').allows('audit.read'))
        self.assertEqual(len(self.store.list('audit')), 4)
        self.store.set_meta('access_revision', False)
        self.error(503, lambda: self.mutate('POST', '/api/admin/roles', {'name': 'rollback', 'actions': ['audit.read']}))

    def test_assignment_eligibility_revocation_unicode_and_proto(self):
        for identity in ['local', 'guest', 'inactive', 'missing']:
            self.error(400, lambda identity=identity: self.mutate('PUT', '/api/admin/assignments/' + identity, {'role_ids': ['audit']}))
        for identity in ['__proto__', '成员😀']:
            self.mutate('PUT', '/api/admin/assignments/' + identity, {'role_ids': ['audit', 'people']})
            self.assertTrue(self.authority(identity).allows('members.manage'))
            self.assertFalse(self.authority(identity).access.owner)
            self.mutate('PUT', '/api/admin/assignments/' + identity, {'role_ids': []})
            self.assertEqual(self.authority(identity).actions(), [])
        self.assertIsNone(self.store.meta(generation_key('bob')))
        self.mutate('PUT', '/api/admin/assignments/bob', {'role_ids': []})
        self.assertIsNone(self.store.meta(generation_key('bob')))

    def test_generation_rotation_ignores_old_assignments(self):
        old = self.store.get('admin_assignment', 'alice')
        authority = self.authority()
        self.assertFalse(invalidate_member(self.store, 'bob'))
        self.assertIsNone(self.store.meta(generation_key('bob')))
        self.assertTrue(invalidate_member(self.store, 'alice'))
        self.assertEqual(authority.actions(), [])
        self.store.put('admin_assignment', old)
        self.assertEqual(authority.actions(), [])
        self.mutate('PUT', '/api/admin/assignments/alice', {'role_ids': ['audit']})
        self.assertEqual(authority.actions(), ['audit.read'])

    def test_malformed_definition_and_assignment_fail_closed(self):
        role = self.store.get('admin_role', 'audit')
        for changes in [{'version': True}, {'version': 2}, {'nonce': '2' * 32 + '\n'}, {'actions': ['audit.read', 'future.read']},
                        {'actions': []}, {'actions': ['members.manage']}, {'actions': ['audit.read', 'audit.read']}, {'wildcard': True}]:
            self.store.put('admin_role', {**role, **changes})
            self.assertEqual(self.authority().actions(), ['analytics.read'])
        self.store.put('admin_role', role)
        assignment = self.store.get('admin_assignment', 'alice')
        for changes in [{'generation': GENERATION + '\n'}, {'generation': False}, {'member_id': 'bob'},
                        {'role_ids': ['audit', 'audit']}, {'role_ids': 'audit'}, {'actions': ['members.manage']},
                        {'role_nonces': {}}, {'role_nonces': {'audit': '2' * 32}},
                        {'role_nonces': {'audit': '2' * 32, 'analytics': '2' * 32, 'future': '2' * 32}}]:
            self.store.put('admin_assignment', {**assignment, **changes})
            self.assertEqual(self.authority().actions(), [])
        self.store.put('admin_assignment', assignment)
        self.mutate('DELETE', '/api/admin/roles/audit')
        self.assertEqual(self.authority().actions(), ['analytics.read'])

    def test_input_validation_and_exact_routes(self):
        revision = self.owner.overview()['revision']
        for changes in [{'name': ''}, {'name': '\u0085'}, {'name': '😀' * 101}, {'name': 'a\n'}, {'name': '\ud800'},
                        {'description': 'a' * 1001}, {'actions': []}, {'actions': ['audit.read'] * 2},
                        {'actions': ['future.read']}, {'actions': ['members.manage']}, {'actions': ['groups.membership.manage']},
                        {'__proto__': {}}, {'revision': revision + '\n'}]:
            body = {'revision': revision, 'name': 'role', 'actions': ['audit.read'], **changes}
            self.error(400, lambda body=body: self.call('POST', '/api/admin/roles', body))
        for method, path in [('GET', '/api/admin/roles/'), ('GET', '/api/admin/roles/audit/x'),
                             ('GET', '/api/admin/self/'), ('GET', '/api/admin/assignments/alice/')]:
            self.error(404, lambda method=method, path=path: self.call(method, path))
        for method, path in [('PUT', '/api/admin/roles'), ('GET', '/api/admin/roles/audit'),
                             ('POST', '/api/admin/assignments/alice'), ('HEAD', '/api/admin/self')]:
            self.error(405, lambda method=method, path=path: self.call(method, path))
        self.error(400, lambda: self.call(query={'q': ['x']}))
        self.error(400, lambda: self.call(body={'name': 'bad'}))
        self.error(400, lambda: self.mutate('PATCH', '/api/admin/roles/audit'))
        self.error(400, lambda: self.mutate('PUT', '/api/admin/assignments/alice', {'role_ids': ['audit', 'audit']}))

    def test_global_cas_detects_member_generation_and_role_aba(self):
        revision = self.owner.overview()['revision']
        member = self.store.get('member', 'bob')
        self.store.put('member', {**member, 'active': False})
        self.assertNotEqual(self.owner.overview()['revision'], revision)
        revision = self.owner.overview()['revision']
        invalidate_member(self.store, 'alice')
        self.assertNotEqual(self.owner.overview()['revision'], revision)
        role = self.store.get('admin_role', 'audit')
        revision = self.owner.overview()['revision']
        self.store.delete('admin_role', 'audit')
        with patch('fountain.core.now', return_value=STAMP):
            self.store.put('admin_role', {**role, 'nonce': '3' * 32})
        self.assertNotEqual(self.owner.overview()['revision'], revision)

    def test_role_nonce_binding_survives_edits_but_not_role_identity_reuse(self):
        role = self.store.get('admin_role', 'audit')
        self.mutate('PATCH', '/api/admin/roles/audit', {'description': 'same authority'})
        self.assertTrue(self.authority().allows('audit.read'))
        self.mutate('DELETE', '/api/admin/roles/audit')
        self.assertEqual(self.authority().actions(), ['analytics.read'])
        self.store.put('admin_role', {**role, 'nonce': '3' * 32})
        self.assertEqual(self.authority().actions(), ['analytics.read'])
        self.mutate('PUT', '/api/admin/assignments/alice', {'role_ids': ['audit', 'analytics']})
        self.assertTrue(self.authority().allows('audit.read'))

    def test_limits_and_non_owner_mutation_denial(self):
        for identity in ['alice', 'admin', 'guest']:
            for method, path, fields in [('POST', '/api/admin/roles', {'name': 'role', 'actions': ['audit.read']}),
                                         ('PATCH', '/api/admin/roles/audit', {'name': 'role'}),
                                         ('DELETE', '/api/admin/roles/audit', {}),
                                         ('PUT', '/api/admin/assignments/bob', {'role_ids': ['audit']})]:
                self.error(403, lambda identity=identity, method=method, path=path, fields=fields:
                           self.call(method, path, {'revision': self.owner.overview()['revision'], **fields}, actor=identity))
        for index in range(97):
            self.store.put('admin_role', {**self.store.get('admin_role', 'audit'), 'id': 'extra' + str(index)})
        self.error(409, lambda: self.mutate('POST', '/api/admin/roles', {'name': 'over limit', 'actions': ['audit.read']}))
        self.error(400, lambda: self.mutate('PUT', '/api/admin/assignments/bob', {'role_ids': ['extra' + str(index) for index in range(33)]}))

    def test_bulk_generation_projection_avoids_per_member_meta_reads(self):
        generations = {generation_key('alice'): GENERATION}
        for index in range(1001):
            identity = 'bulk' + str(index)
            self.store.put('member', {'id': identity, 'role': 'member'})
            self.store.put('admin_assignment', {'id': identity, 'member_id': identity,
                                               'role_ids': ['audit'], 'role_nonces': {'audit': '2' * 32}, 'generation': GENERATION})
            generations[generation_key(identity)] = GENERATION
        self.store.admin_member_generations = lambda: generations
        with patch.object(self.store, 'meta', side_effect=AssertionError('per-member metadata read')):
            overview = self.owner.overview()
        self.assertEqual(len(overview['assignments']), 1002)
        self.assertEqual(len(overview['eligible_members']), 1006)

    def test_read_only_reader_evaluates_and_rejects_mutations(self):
        class Reader:
            def get(_self, kind, identity):
                return self.store.get(kind, identity)
            def list(_self, kind):
                return self.store.list(kind)
            def meta(_self, key, fallback=None):
                return self.store.meta(key, fallback)
        reader = Reader()
        authority = AdminAuthority(reader, Access(reader, self.store.get('member', 'local')))
        self.assertEqual(authority.overview(), self.owner.overview())
        self.assertTrue(authority.route('GET', '/api/admin/self', {}, {})['can_manage_roles'])
        revision = authority.overview()['revision']
        self.error(503, lambda: authority.route('POST', '/api/admin/roles', {'revision': revision, 'name': 'role', 'actions': ['audit.read']}, {}))
        member = AdminAuthority(reader, Access(reader, self.store.get('member', 'alice')))
        self.assertEqual(member.actions(), ['audit.read', 'analytics.read'])
        self.error(403, lambda: member.route('POST', '/api/admin/roles', {'revision': revision, 'name': 'role', 'actions': ['audit.read']}, {}))


if __name__ == '__main__':
    unittest.main()
