"""Portable SQLite durability tests for production DDL, not Android SDK tests."""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'android/app/src/main/java/dev/fountain/workspace'
SCHEMA = re.search(r'SCHEMA = \{(.*?)\n    \};', (SOURCE / 'NativeOutbox.java').read_text(), re.S)[1]
SCHEMA = re.findall(r'"([^"\n]+)"', SCHEMA)


class DurableSQLTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'outbox.sqlite'
        self.db = sqlite3.connect(self.path, isolation_level=None)
        self.addCleanup(self.db.close)
        self.assertEqual(self.db.execute('PRAGMA journal_mode=DELETE').fetchone()[0], 'delete')
        self.db.execute('PRAGMA synchronous=EXTRA')
        self.assertEqual(self.db.execute('PRAGMA synchronous').fetchone()[0], 3)
        for sql in SCHEMA:
            self.db.execute(sql)
        self.db.execute("INSERT INTO control VALUES('head','0')")
        self.db.execute("INSERT INTO control VALUES('lease','owner-a')")

    def test_receipt_record_and_head_rollback_then_durable_commit(self):
        for commit in (False, True):
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?)',
                            ('active', 'drafts', '["profile|page","client"]', 'profile', 'profile|page', b'{"draft":"typed"}'))
            self.db.execute("INSERT INTO tx_receipts VALUES('tx','digest',1)")
            self.db.execute("UPDATE control SET value='1' WHERE key='head'")
            self.db.execute('COMMIT' if commit else 'ROLLBACK')
            with sqlite3.connect(self.path) as independent:
                self.assertEqual(independent.execute('SELECT count(*) FROM records').fetchone()[0], int(commit))
                self.assertEqual(independent.execute('SELECT count(*) FROM tx_receipts').fetchone()[0], int(commit))
                self.assertEqual(independent.execute("SELECT value FROM control WHERE key='head'").fetchone()[0], str(int(commit)))

    def test_process_exit_before_and_after_commit(self):
        code = '''import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1],isolation_level=None)
c.execute('PRAGMA synchronous=EXTRA')
c.execute('BEGIN IMMEDIATE')
c.execute("INSERT INTO tx_receipts VALUES('crash','digest',1)")
c.execute("UPDATE control SET value='1' WHERE key='head'")
if sys.argv[2]=='commit':c.execute('COMMIT')
os._exit(9)
'''
        for state in ('rollback', 'commit'):
            child = subprocess.run([sys.executable, '-c', code, str(self.path), state], capture_output=True)
            self.assertEqual(child.returncode, 9)
            with sqlite3.connect(self.path) as restarted:
                expected = int(state == 'commit')
                self.assertEqual(restarted.execute('SELECT count(*) FROM tx_receipts').fetchone()[0], expected)
                self.assertEqual(restarted.execute("SELECT value FROM control WHERE key='head'").fetchone()[0], str(expected))
                self.assertEqual(restarted.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_profile_and_resource_tombstone_transaction_removes_transfers(self):
        for bucket, resource in [('snapshots', 'profile|page'), ('transfers', 'profile|page'), ('transfers', 'profile|other')]:
            self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?)', ('active', bucket, json.dumps([bucket, resource]), 'profile', resource, b'{}'))
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute('INSERT OR IGNORE INTO tombstones VALUES(?,?)', ('resource', 'profile|page'))
        self.db.execute('DELETE FROM records WHERE resource_key=?', ('profile|page',))
        self.db.execute('COMMIT')
        self.assertEqual(self.db.execute('SELECT resource_key FROM records').fetchall(), [('profile|other',)])
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute('INSERT OR IGNORE INTO tombstones VALUES(?,?)', ('profile', 'profile'))
        self.db.execute('DELETE FROM records WHERE profile_id=?', ('profile',))
        self.db.execute('COMMIT')
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM tombstones').fetchone()[0], 2)

    def test_staging_is_private_ordered_and_receipts_cannot_upsert(self):
        raw = json.dumps({'version': 1, 'origin': 'https://fixture.invalid', 'mode': 'quarantine', 'changes': []}).encode()
        for part, value in enumerate((raw[:20], raw[20:])):
            self.db.execute('INSERT INTO staging VALUES(?,?,?,?,?)', ('tx', part, 0, 'owner-a', value))
        actual = b''.join(row[0] for row in self.db.execute('SELECT data FROM staging WHERE tx_id=? ORDER BY part', ('tx',)))
        self.assertEqual(hashlib.sha256(actual).digest(), hashlib.sha256(raw).digest())
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 0)
        self.db.execute('INSERT INTO tx_receipts VALUES(?,?,?)', ('tx', hashlib.sha256(raw).hexdigest(), 1))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO tx_receipts VALUES(?,?,?)', ('tx', 'other-digest', 2))

    def test_default_disabled_native_hooks_and_anonymous_logout_are_real(self):
        plugin = (SOURCE / 'FountainNativePlugin.java').read_text()
        self.assertIn('private static final boolean OUTBOX_ENABLED = false;', plugin)
        self.assertIn('result.put("outboxEnabled", OUTBOX_ENABLED)', plugin)
        self.assertIn('if (!OUTBOX_ENABLED)', plugin)
        self.assertIn('if (OUTBOX_ENABLED) try { durableOutbox().revoke(); }', plugin)
        self.assertIn('if (OUTBOX_ENABLED && session && response.status == 200)', plugin)
        logout = plugin.split('if (operation.logout) {', 1)[1].split('} else {', 1)[0]
        self.assertIn('exchange(operation, operation.origin, path, "DELETE", headers, body, null, null)', logout)
        self.assertNotIn('response.status = 200', logout)
        configuration = plugin.split('@PluginMethod public void configure', 1)[1].split('private void sessionWrite', 1)[0]
        invalid = configuration.split('catch (IllegalArgumentException invalid)', 1)[1].split('try {', 1)[0]
        self.assertNotIn('broken = true', invalid)
        self.assertIn('NATIVE_INPUT', invalid)
        self.assertIn('authGeneration == expectedAuth', plugin)
        self.assertIn('storage.boundary() == expectedBoundary', plugin)
        self.assertIn('outbox == storage', plugin)
        self.assertLess(plugin.index('durableOutbox().revoke();'), plugin.index('NativePolicy.invalidateSession(origin,'))
        source = (SOURCE / 'NativeOutbox.java').read_text()
        self.assertLess(source.index('SELECT digest,head FROM tx_receipts'), source.index('base == head()'))
        receipt = source.split('SELECT digest,head FROM tx_receipts', 1)[1].split('long base =', 1)[0]
        self.assertIn('DELETE FROM staging WHERE tx_id=?', receipt)
        self.assertIn('db.disableWriteAheadLogging()', source)
        self.assertNotIn('java.time', source)
        self.assertNotIn('java.util.Base64', source)

    def test_recovery_import_receipt_is_private_immutable_and_purged(self):
        source = (SOURCE / 'NativeOutbox.java').read_text()
        profile = 'https://fixture.invalid:8443|workspace|member|binding'
        digest = 'a' * 64
        receipt = {'id': 'recovery-import:' + profile + ':' + digest, 'profileId': profile,
                   'digest': digest, 'operationIds': ['fresh-op'], 'pageIds': [], 'draftKeys': [], 'createdAt': 1}
        key = json.dumps(receipt['id'], separators=(',', ':'))
        payload = json.dumps(receipt, separators=(',', ':')).encode()
        self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?)', ('active', 'meta', key, profile, None, payload))
        query = re.search(r'"(SELECT payload FROM records WHERE mode=\'active\' AND bucket=\'meta\' AND key=\?)"', source)[1]
        self.assertEqual(self.db.execute(query, (key,)).fetchone()[0], payload)
        self.db.execute('DELETE FROM records WHERE profile_id=?', (profile,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 0)
        parser = source.split('id.startsWith("recovery-import:")', 1)[1].split('} else {', 1)[0]
        self.assertIn("id.lastIndexOf(':')", parser)
        self.assertIn('mode.equals("active")', parser)
        self.assertIn('profile.equals(value.getString("profileId"))', parser)
        self.assertIn('Arrays.equals(previous.getBlob(0)', parser)
        self.assertIn('NativePolicy.require(tombstone("profile", profile))', parser)


if __name__ == '__main__':
    unittest.main(verbosity=2)
