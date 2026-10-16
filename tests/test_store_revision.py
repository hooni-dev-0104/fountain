"""A snapshot watermark must cover committed writes from every server process."""
import tempfile
import unittest
from pathlib import Path

from fountain.core import APIError, Store, Workspace


class StoreRevisionTests(unittest.TestCase):
    def test_mutations_advance_and_missing_delete_does_not(self):
        store = Store(':memory:')
        self.addCleanup(store.close)
        self.assertEqual(store.meta('_entity_revision', 0), 0)
        store.put('example', {'id': 'one'})
        self.assertEqual(store.meta('_entity_revision'), 1)
        store.set_meta('example_setting', True)
        self.assertEqual(store.meta('_entity_revision'), 2)
        store.delete('example', 'missing')
        self.assertEqual(store.meta('_entity_revision'), 2)
        store.delete('example', 'one')
        self.assertEqual(store.meta('_entity_revision'), 3)

    def test_counter_and_entities_roll_back_together(self):
        store = Store(':memory:')
        self.addCleanup(store.close)
        with store.transaction():
            store.put('example', {'id': 'committed'})
            with self.assertRaises(ValueError):
                with store.transaction():
                    store.put('example', {'id': 'nested'})
                    store.set_meta('discarded', True)
                    raise ValueError('rollback savepoint')
            self.assertEqual(store.meta('_entity_revision'), 1)
        with self.assertRaises(ValueError):
            with store.transaction():
                store.delete('example', 'committed')
                raise ValueError('rollback outer transaction')
        self.assertEqual(store.meta('_entity_revision'), 1)
        self.assertIsNotNone(store.get('example', 'committed'))
        self.assertIsNone(store.get('example', 'nested'))
        self.assertIsNone(store.meta('discarded'))

    def test_independent_connections_share_durable_counter(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.db'
            first, second = Store(path), Store(path)
            try:
                first.put('example', {'id': 'first'})
                second.put('example', {'id': 'second'})
                first.set_meta('setting', 'value')
                self.assertEqual(first.meta('_entity_revision'), 3)
                self.assertEqual(second.meta('_entity_revision'), 3)
            finally:
                first.close()
                second.close()
            reopened = Store(path)
            try:
                self.assertEqual(reopened.meta('_entity_revision'), 3)
            finally:
                reopened.close()

    def test_client_row_identifier_cannot_replace_existing_row(self):
        store = Store(':memory:')
        self.addCleanup(store.close)
        workspace = Workspace(store)
        database = workspace.create_database({'name': '오프라인 항목'})
        row = workspace.create_row(database['id'], {'id': 'device-row-one'})
        self.assertEqual(row['id'], 'device-row-one')
        before = store.meta('_entity_revision')
        with self.assertRaises(APIError) as error:
            workspace.create_row(database['id'], {'id': row['id']})
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(store.meta('_entity_revision'), before)
        self.assertEqual(store.get('row', row['id']), row)
