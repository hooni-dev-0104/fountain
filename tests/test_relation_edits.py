"""Editing a projected relation must not delete another member's hidden links."""
import json
import unittest

from fountain.core import APIError, Store
from fountain.server import Application


class RelationEditTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.addCleanup(self.store.close)
        self.app = Application(self.store)
        self.member = self.store.put('member', {
            'id': 'family', 'name': 'Family', 'role': 'member', 'active': True})
        database = self.store.get('database', 'projects')
        database['properties'].append({
            'id': 'links', 'name': '연결', 'type': 'relation', 'database_id': 'projects'})
        self.store.put('database', database)
        for identity in ('visible-target', 'hidden-target'):
            self.store.put('row', {
                'id': identity, 'database_id': 'projects', 'owner_id': 'local',
                'properties': {'name': identity}, 'parent_row_id': None, 'depends_on': [],
                'permissions': {'default': 'private' if identity == 'hidden-target' else 'workspace',
                                'members': {}, 'groups': {}, 'inherit': False}})
        self.store.put('row', {
            'id': 'source', 'database_id': 'projects', 'owner_id': 'local',
            'properties': {'name': 'Source', 'links': ['visible-target', 'hidden-target']},
            'parent_row_id': None, 'depends_on': []})

    def patch(self, value):
        return self.app.dispatch('PATCH', '/api/databases/projects/rows/source',
                                 {'properties': {'links': value}}, {}, principal=self.member)[1]

    def test_clearing_visible_relation_preserves_hidden_existing_link(self):
        for value in ([], None):
            with self.subTest(value=value):
                result = self.patch(value)
                self.assertEqual(result['properties']['links'], [])
                self.assertNotIn('hidden-target', json.dumps(result))
                self.assertEqual(self.store.get('row', 'source')['properties']['links'], ['hidden-target'])

    def test_visible_reference_and_hidden_link_both_survive_update(self):
        result = self.patch(['visible-target'])
        self.assertEqual(result['properties']['links'], ['visible-target'])
        self.assertEqual(self.store.get('row', 'source')['properties']['links'],
                         ['visible-target', 'hidden-target'])

    def test_submitting_hidden_reference_is_rejected_before_preservation(self):
        before = self.store.get('row', 'source')
        with self.assertRaises(APIError) as error:
            self.patch(['hidden-target'])
        self.assertIn(error.exception.status, (403, 404))
        self.assertEqual(self.store.get('row', 'source'), before)
