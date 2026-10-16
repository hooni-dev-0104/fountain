import copy
import unittest

from fountain.access import Access
from fountain.authorization import Authorization
from fountain.core import Store


class NativeWorkspaceAuthorityTests(unittest.TestCase):
    def test_visible_teamspace_level_is_calculated_for_the_current_member(self):
        store = Store(':memory:')
        self.addCleanup(store.close)
        for identity, role in [('local', 'owner'), ('alice', 'member'), ('guest', 'guest')]:
            store.put('member', {'id': identity, 'role': role, 'active': True})
        store.put('teamspace', {'id': 'general', 'visibility': 'open', 'access_level': 99})
        store.put('teamspace', {'id': 'private', 'visibility': 'private', 'members': ['local']})
        payload = {'pages': [], 'databases': [], 'teamspaces': store.list('teamspace')}
        before = copy.deepcopy(payload)
        for identity, expected in [('local', {'general': 4, 'private': 4}),
                                   ('alice', {'general': 3}), ('guest', {})]:
            access = Access(store, store.get('member', identity))
            result = Authorization(access).project('/api/workspace', payload)
            self.assertEqual({item['id']: item['access_level'] for item in result['teamspaces']}, expected)
        self.assertEqual(payload, before)
        self.assertEqual(store.get('teamspace', 'general')['access_level'], 99)

    def test_guest_child_creation_does_not_require_top_level_teamspace_authority(self):
        store = Store(':memory:')
        self.addCleanup(store.close)
        guest = store.put('member', {'id': 'guest', 'role': 'guest', 'active': True})
        store.put('page', {'id': 'parent', 'owner_id': 'local', 'teamspace_id': 'general',
                          'permissions': {'default': 'private', 'members': {'guest': 'edit'}}})
        body = {'parent_id': 'parent', 'title': 'Child'}
        Authorization(Access(store, guest)).prepare('POST', '/api/pages', body)
        self.assertEqual(body['owner_id'], 'guest')
        self.assertEqual(body['teamspace_id'], 'general')


if __name__ == '__main__':
    unittest.main()
