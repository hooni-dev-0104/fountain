"""Portable history is preserved; live account bindings are never imported."""
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fountain.activity import (ACTIVITY_COLUMNS, ACTIVITY_DEFINITIONS,
                              ACTIVITY_RUNTIME_COLUMNS, ACTIVITY_TRIGGER_DEFINITIONS,
                              activate_restore_connection, inspect_portable_activity)
from fountain.backup import (BackupError, DEFINITIONS, INDEX_DEFINITIONS,
                             create_backup, inspect_backup, restore_backup)
from fountain.canonical import canonical_source
from fountain.retention_vault import VAULT_DEFINITIONS


class ActivityBackupV4Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.db'
        self.db = sqlite3.connect(self.source)
        for ddl in (*DEFINITIONS.values(), INDEX_DEFINITIONS['content_provenance'],
                    *VAULT_DEFINITIONS.values(), *ACTIVITY_DEFINITIONS.values()):
            self.db.execute(ddl)
        self.stamp = '2020-01-01T00:00:00.123456Z'
        self.db.execute('INSERT INTO activity_ledgers VALUES(?,?,?,?)',
                        ('1'*32, self.stamp, 'installation', 'canonical-server-v1'))
        self.db.execute('INSERT INTO activity_memberships VALUES(?,?,?,?,?,?)',
                        ('2'*32, '1'*32, '가족😀', self.stamp, None, None))
        self.db.execute('INSERT INTO activity_accounts VALUES(?,?,?,?,?,?)',
                        ('3'*32, '2'*32, 'supabase', self.stamp, None, None))
        source = canonical_source('{"id":"page","n":9007199254740993,"z":-0}')
        self.db.execute('INSERT INTO activity_events VALUES('+','.join('?'*17)+')',
                        ('1'*32, 1, '4'*32, '5'*32, 0, '가족😀', '2'*32, '3'*32,
                         'human', 'viewed', 'page', 'page', '6'*32, self.stamp,
                         'fountain-cjson-v1', len(source), hashlib.sha256(source).hexdigest()))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def tables(self, connection):
        return {r[0] for r in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}

    def test_backup_preserves_all_fourteen_tables_without_activating(self):
        before = {t: self.db.execute('SELECT * FROM '+t).fetchall() for t in ACTIVITY_COLUMNS}
        target = self.root / 'portable.db'
        create_backup(self.db, target)
        with sqlite3.connect(target) as result:
            self.assertEqual(len(self.tables(result)), 14)
            self.assertFalse(self.tables(result) & set(ACTIVITY_RUNTIME_COLUMNS))
            self.assertEqual(result.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(result.execute('PRAGMA foreign_key_check').fetchall(), [])
            for table in ACTIVITY_COLUMNS:
                self.assertEqual(result.execute('SELECT * FROM '+table).fetchall(), before[table])
        self.assertEqual(self.db.execute('SELECT closed_at FROM activity_memberships').fetchone(), (None,))

    def test_restore_closes_only_open_episodes_and_creates_fresh_runtime(self):
        snapshot, target = self.root / 'portable.db', self.root / 'restored.db'
        create_backup(self.db, snapshot)
        before = self.db.execute('SELECT * FROM activity_events').fetchall()
        restore_backup(snapshot, target)
        with sqlite3.connect(target) as result:
            inspect_portable_activity(result)
            self.assertEqual(result.execute('SELECT * FROM activity_events').fetchall(), before)
            self.assertEqual(result.execute('SELECT count(*) FROM activity_ledgers').fetchone(), (2,))
            self.assertEqual(result.execute('SELECT origin FROM activity_ledgers WHERE id<>?', ('1'*32,)).fetchone(), ('restore',))
            self.assertEqual(result.execute('SELECT close_reason FROM activity_memberships').fetchone(), ('restore',))
            self.assertEqual(result.execute('SELECT close_reason FROM activity_accounts').fetchone(), ('restore',))
            self.assertEqual(result.execute('SELECT count(*) FROM activity_current_members').fetchone(), (0,))
            self.assertEqual(result.execute('SELECT count(*) FROM activity_current_accounts').fetchone(), (0,))
            self.assertEqual(result.execute('SELECT next_sequence FROM activity_runtime').fetchone(), (1,))
            with self.assertRaises(sqlite3.Error):
                result.execute('DELETE FROM activity_events')
            result.rollback()
            create_backup(result, self.root / 'again.db')
        with sqlite3.connect(self.root / 'again.db') as result:
            self.assertEqual(len(self.tables(result)), 14)
            self.assertFalse(self.tables(result) & set(ACTIVITY_RUNTIME_COLUMNS))

    def test_known_guards_are_removed_only_in_private_portable_copy(self):
        activate_restore_connection(self.db)
        self.db.commit()
        count = self.db.execute("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").fetchone()[0]
        self.assertEqual(count, len(ACTIVITY_TRIGGER_DEFINITIONS))
        create_backup(self.db, self.root / 'guarded.db')
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").fetchone()[0], count)
        with sqlite3.connect(self.root / 'guarded.db') as result:
            self.assertEqual(result.execute("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").fetchone(), (0,))
        self.db.execute('CREATE TRIGGER injected AFTER INSERT ON meta BEGIN DELETE FROM activity_events; END')
        self.db.commit()
        with self.assertRaises(BackupError):
            create_backup(self.db, self.root / 'injected.db')
        self.assertFalse((self.root / 'injected.db').exists())

    def test_bad_shape_sequence_source_and_orphan_are_rejected_atomically(self):
        for statement in [
            "UPDATE activity_events SET sequence=2",
            "UPDATE activity_events SET source_sha256='bad'",
            "UPDATE activity_events SET occurred_at='2020-02-30T00:00:00Z'",
            "UPDATE activity_accounts SET membership_id='ffffffffffffffffffffffffffffffff'",
            "UPDATE activity_memberships SET closed_at='2020-01-02T00:00:00Z'",
        ]:
            with self.subTest(statement=statement):
                self.db.execute('SAVEPOINT invalid')
                self.db.execute(statement)
                with self.assertRaises(BackupError):
                    create_backup(self.db, self.root / 'invalid.db')
                self.assertFalse((self.root / 'invalid.db').exists())
                self.db.execute('ROLLBACK TO invalid')
                self.db.execute('RELEASE invalid')
        self.db.execute('ALTER TABLE activity_events ADD COLUMN session_token TEXT')
        self.db.commit()
        with self.assertRaises(BackupError):
            inspect_backup(self.source)

    def test_partial_runtime_and_unknown_unique_indexes_fail_closed(self):
        self.db.execute('CREATE INDEX arbitrary ON activity_events(resource_id)')
        self.db.commit()
        with self.assertRaises(BackupError):
            create_backup(self.source, self.root / 'index.db')
        self.db.execute('DROP INDEX arbitrary')
        self.db.execute('CREATE TABLE activity_runtime (singleton INTEGER PRIMARY KEY)')
        self.db.commit()
        with self.assertRaises(BackupError):
            create_backup(self.source, self.root / 'runtime.db')

    def test_new_store_canonical_write_requires_v4_with_empty_vault(self):
        from fountain.core import Store
        store = Store(self.root / 'current.db')
        try:
            store.put('page', {'id': 'captured', 'title': '새 이력', 'blocks': []})
            self.assertGreater(store.db.execute('SELECT count(*) FROM activity_events').fetchone()[0], 0)
            create_backup(store.db, self.root / 'current-backup.db')
        finally:
            store.close()
        with sqlite3.connect(self.root / 'current-backup.db') as result:
            self.assertEqual(len(self.tables(result)), 14)
            self.assertFalse(self.tables(result) & set(ACTIVITY_RUNTIME_COLUMNS))
            self.assertEqual(result.execute('SELECT count(*) FROM retention_records').fetchone(), (0,))
            self.assertGreater(result.execute('SELECT count(*) FROM activity_events').fetchone()[0], 0)

    def test_empty_activity_uses_legacy_portable_shape(self):
        for table in reversed(tuple(ACTIVITY_COLUMNS)):
            self.db.execute('DELETE FROM '+table)
        self.db.commit()
        create_backup(self.db, self.root / 'legacy.db')
        with sqlite3.connect(self.root / 'legacy.db') as result:
            self.assertEqual(self.tables(result), {'entities', 'meta', 'attachment_chunks', 'content_provenance'})


if __name__ == '__main__':
    unittest.main()
