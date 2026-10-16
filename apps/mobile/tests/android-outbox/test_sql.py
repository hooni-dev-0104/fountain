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


def production_sql(prefix):
    queries = re.findall(r'"([^"\n]+)"', (SOURCE / 'NativeOutbox.java').read_text())
    return next(query for query in queries if query.startswith(prefix))


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
        self.assertIn('if (OUTBOX_ENABLED && !recoveryMode) try { durableOutbox().revoke(); }', plugin)
        self.assertIn('if (OUTBOX_ENABLED && !recoveryMode && session && response.status == 200)', plugin)
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

    def test_recovery_existing_only_read_only_and_text_bound_pagination(self):
        source = (SOURCE / 'NativeRecovery.java').read_text()
        self.assertIn('SQLiteDatabase.OPEN_READONLY', source)
        self.assertIn('PRAGMA query_only=ON', source)
        self.assertNotIn('CREATE TABLE', source)
        self.assertNotIn('db.delete(', source)
        self.assertNotIn('db.insert(', source)
        self.assertIn('HAVING min(rowid)>CAST(? AS INTEGER)', source)
        before = hashlib.sha256(self.path.read_bytes()).digest()
        reader = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True)
        self.addCleanup(reader.close)
        reader.execute('PRAGMA query_only=ON')
        with self.assertRaises(sqlite3.OperationalError):
            reader.execute("DELETE FROM control")
        self.assertEqual(reader.execute("SELECT min(rowid) FROM control GROUP BY key HAVING min(rowid)>CAST(? AS INTEGER)", ('0',)).fetchall(), [(1,), (2,)])
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).digest(), before)
        absent = self.path.parent / 'never-created.sqlite'
        with self.assertRaises(sqlite3.OperationalError):
            sqlite3.connect(absent.resolve().as_uri() + '?mode=ro', uri=True)
        self.assertFalse(absent.exists())

    def test_recovery_mode_arms_before_auth_and_preserves_source_on_logout(self):
        plugin = (SOURCE / 'FountainNativePlugin.java').read_text()
        self.assertIn('recoveryEnabled', plugin)
        caller = plugin.split('private void recoveryCall(', 1)[1].split('@PluginMethod public void recoveryInventory', 1)[0]
        self.assertLess(caller.index('if(inventory)recoveryMode=true;'), caller.index('refreshRecovery(operation,epoch)'))
        self.assertIn('if (OUTBOX_ENABLED && !recoveryMode && origin != null) durableOutbox().revoke();', plugin)
        observer = plugin.split('private void observeCanonical', 1)[1] if 'private void observeCanonical' in plugin else plugin
        self.assertIn('recovery.observe', observer)

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

    def test_failed_overlay_preserves_records_staging_receipts_head_and_lease(self):
        raw = b'{"version":1,"changes":["unconfirmed"]}'
        self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?)', ('active', 'drafts', '"page"', 'profile', 'profile|page', b'{"input":"preserve"}'))
        self.db.execute(production_sql('INSERT INTO staging('), ('tx', 0, 0, 'owner-a', raw))
        self.db.execute(production_sql('INSERT OR REPLACE INTO control('), ('staged-proof:tx', '3'))
        self.db.execute(production_sql('INSERT OR REPLACE INTO control('), ('proof_epoch', '4'))
        before = list(self.db.iterdump())
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute(production_sql('INSERT OR REPLACE INTO records(mode,bucket,key,profile_id,resource_key,payload) VALUES'),
                        ('active', 'drafts', '"page"', 'profile', 'profile|page', b'{"input":"would replace"}'))
        # A rejected Java preflight exits without setTransactionSuccessful.
        self.db.execute('ROLLBACK')
        self.assertEqual(list(self.db.iterdump()), before)
        source = (SOURCE / 'NativeOutbox.java').read_text()
        commit = source.split('JSObject commit(', 1)[1].split('private JSObject receipt(', 1)[0]
        self.assertLess(commit.index('preflight(grant)'), commit.index('result = advance()'))
        self.assertLess(commit.index('proof != proofEpoch()'), commit.index('change(changes.getJSONObject'))

    def test_lost_ack_receipt_keeps_original_epoch_after_observation(self):
        set_control = production_sql('INSERT OR REPLACE INTO control(')
        self.db.execute(production_sql('INSERT INTO tx_receipts('), ('accepted', 'digest', 1))
        self.db.execute(set_control, ('receipt-proof:accepted', '3'))
        self.db.execute(set_control, ('proof_epoch', '9'))
        self.db.execute(set_control, ('head', '8'))
        self.db.execute(production_sql('INSERT INTO staging('), ('accepted', 0, 0, 'owner-a', b'exact retry'))
        self.db.execute(set_control, ('staged-proof:accepted', '3'))
        self.db.execute('BEGIN IMMEDIATE')
        receipt = self.db.execute(production_sql('SELECT digest,head FROM tx_receipts'), ('accepted',)).fetchone()
        original = self.db.execute(production_sql('SELECT value FROM control'), ('receipt-proof:accepted',)).fetchone()[0]
        self.db.execute(production_sql('DELETE FROM staging WHERE tx_id='), ('accepted',))
        self.db.execute(production_sql('DELETE FROM control WHERE key=?'), ('staged-proof:accepted',))
        self.db.execute('COMMIT')
        self.assertEqual((receipt, original), (('digest', 1), '3'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM staging').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT value FROM control WHERE key=?', ('proof_epoch',)).fetchone()[0], '9')
        self.assertEqual(self.db.execute('SELECT value FROM control WHERE key=?', ('head',)).fetchone()[0], '8')
        source = (SOURCE / 'NativeOutbox.java').read_text().split('JSObject commit(', 1)[1]
        self.assertLess(source.index('receipt(generation, result, tx, Long.parseLong(original))'), source.index('long proof = intentProof(input)'))

    def test_native_resource_denial_quarantines_input_and_removes_transfers(self):
        for bucket in ('snapshots', 'drafts', 'operations', 'mutations', 'transfers'):
            self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?)', ('active', bucket, json.dumps(bucket), 'profile', 'profile|page', b'{"input":"keep private"}'))
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute(production_sql('INSERT OR IGNORE INTO tombstones('), ('resource', 'profile|page'))
        self.db.execute(production_sql("INSERT OR REPLACE INTO records(mode,bucket,key,profile_id,resource_key,payload) SELECT 'quarantine'"), ('profile|page',))
        self.db.execute(production_sql("DELETE FROM records WHERE resource_key=? AND"), ('profile|page',))
        self.db.execute('COMMIT')
        self.assertEqual(self.db.execute('SELECT count(*) FROM records WHERE mode=\'active\'').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT bucket FROM records ORDER BY bucket').fetchall(), [('drafts',), ('mutations',), ('operations',)])
        self.assertTrue(all(row[0] == b'{"input":"keep private"}' for row in self.db.execute('SELECT payload FROM records')))

    def test_observed_floor_changes_only_private_control_not_business_head(self):
        setter = production_sql('INSERT OR REPLACE INTO control(')
        self.db.execute(setter, ('proof_epoch', '1'))
        self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?)', ('active', 'databaseSnapshots', '"db"', 'profile', 'profile|database|db', b'{"old_row":"preserve"}'))
        record = self.db.execute('SELECT * FROM records').fetchall()
        ledger = {'profileId': 'profile', 'owner': 'owner-a', 'sessionRef': 'fixture-private-digest',
                  'maxAccessRevision': 5, 'maxDataRevision': 100, 'entries': {}}
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute(setter, ('resource_proofs', json.dumps(ledger)))
        self.db.execute(setter, ('proof_epoch', '2'))
        self.db.execute('COMMIT')
        self.assertEqual(self.db.execute('SELECT * FROM records').fetchall(), record)
        self.assertEqual(self.db.execute('SELECT value FROM control WHERE key=\'head\'').fetchone()[0], '0')
        self.assertEqual(self.db.execute('SELECT value FROM control WHERE key=\'lease\'').fetchone()[0], 'owner-a')
        self.assertEqual(self.db.execute('SELECT count(*) FROM tx_receipts').fetchone()[0], 0)

    def test_no_workspace_record_can_mask_negative_relation_target(self):
        # Deliberately no profiles.workspace record: only DBb evidence and its
        # native tombstone. Source checks below pin the actual reference path.
        self.db.execute('INSERT INTO tombstones VALUES(?,?)', ('resource', 'profile|database|db-b'))
        negative = self.db.execute(production_sql('SELECT 1 FROM tombstones'), ('resource', 'profile|database|db-b')).fetchone()
        self.assertIsNotNone(negative)
        source = (SOURCE / 'NativeOutbox.java').read_text()
        refs = source.split('private void references(', 1)[1].split('private void workspaceCache(', 1)[0]
        self.assertIn('proof(ledger, grant, "database", relatedID, report, 1)', refs)
        self.assertIn('proof(ledger, grant, "database", candidate.getString("id"), report, 1)', refs)
        proof = source.split('private JSONObject proof(', 1)[1].split('private boolean sameVersion(', 1)[0]
        self.assertLess(proof.index('tombstone("resource", resource)'), proof.index('return entry'))
        self.assertIn('entry.opt("denied") == Boolean.TRUE', proof)

    def test_observer_and_final_callback_source_fences(self):
        source = (SOURCE / 'NativeOutbox.java').read_text()
        plugin = (SOURCE / 'FountainNativePlugin.java').read_text()
        observer = source.split('void observe(', 1)[1].split('private static final class AccessReport', 1)[0]
        self.assertIn('OutboxPolicy.freshRevisions(access, data, floorAccess, floorData)', observer)
        self.assertIn('encodedLedger.getBytes(StandardCharsets.UTF_8).length > OutboxPolicy.RECORD', observer)
        self.assertLess(observer.index('OutboxPolicy.stableObservation('), observer.index('advanceProof();'))
        self.assertIn('if (malformed) throw new AccessRequired(); return;', observer)
        self.assertIn('workspaceDenial.opt("terminal") == Boolean.TRUE', observer)
        self.assertIn('status == 200 && !kind.equals("workspace") && tombstone(', observer)
        self.assertNotIn('advance();', observer)
        self.assertNotIn('set("lease"', observer)
        report = source.split('private static final class AccessReport', 1)[1].split('private JSONObject proof(', 1)[0]
        self.assertLess(report.index('issues.length() >= 100'), report.index('seen.add(key)'))
        preflight = source.split('private AccessReport preflight(', 1)[1].split('private void scope(', 1)[0]
        self.assertIn('workspaceCache(ledger, grant', preflight)
        self.assertIn('references(ledger, grant, entry, basis, report)', preflight)
        self.assertNotIn('value.getString("status")', preflight)
        embedded = source.split('private void workspaceCache(', 1)[1].split('private JSONObject record(', 1)[0]
        self.assertIn('tombstone("resource", resource) || specific != null', embedded)
        action = plugin.split('private void observeResourceResponse(', 1)[1].split('private void check(', 1)[0]
        self.assertLess(action.index('!OUTBOX_ENABLED'), action.index('durableOutbox()'))
        self.assertLess(action.index('check(operation)'), action.index('storage.observe('))
        self.assertIn('Objects.equals(sentCookie, activeCookie)', action)
        self.assertIn('outbox.proofEpoch() != operation.responseProofEpoch', plugin)
        self.assertIn('System.currentTimeMillis() >= operation.responseProofDeadline', plugin)
        required = plugin.split('catch (NativeOutbox.AccessRequired error)', 1)[1].split('catch (IllegalArgumentException', 1)[0]
        self.assertIn('OUTBOX_ACCESS_REQUIRED', required)
        self.assertNotIn('broken =', required)


if __name__ == '__main__':
    unittest.main(verbosity=2)
