"""Portable tests of the SQL literals in FountainOutbox.swift.

These execute the production schema and bound statements on temporary SQLite
files. They do not execute Swift, Keychain, Capacitor, file protection or iOS.
"""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1] / 'ios/App/App'
SOURCE = (APP / 'FountainOutbox.swift').read_text()
SCHEMA = re.search(r'static let schema = """\n(.*?)\n    """', SOURCE, re.S)[1]
LITERALS = re.findall(r'"([^"\n]*)"', SOURCE)


def sql(prefix):
    matches = [value for value in LITERALS if value.startswith(prefix)]
    if not matches:
        raise AssertionError(f'Production SQL missing: {prefix}')
    return matches[0]


CONTROL = sql('INSERT INTO control(')
RECORD = sql('INSERT INTO records(')
RECEIPT = sql('INSERT INTO tx_receipts(')
STAGE = sql('INSERT INTO staging(')


class IOSOutboxSQLTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'fixture.sqlite'
        self.db = sqlite3.connect(self.path, isolation_level=None)
        self.addCleanup(self.db.close)
        self.assertEqual(self.db.execute('PRAGMA journal_mode=DELETE').fetchone()[0], 'delete')
        self.db.execute('PRAGMA synchronous=EXTRA')
        self.assertEqual(self.db.execute('PRAGMA synchronous').fetchone()[0], 3)
        self.db.executescript(SCHEMA)
        self.db.execute(CONTROL, ('head', b'0'))
        self.db.execute(CONTROL, ('lease', b'"owner"'))

    def record(self, bucket, key, resource='profile|page', value=b'{}'):
        self.db.execute(RECORD, (bucket, json.dumps(key), 'profile', resource, value))

    def test_canonical_record_head_and_receipt_commit_atomically(self):
        for commit in (False, True):
            self.db.execute('BEGIN IMMEDIATE')
            self.record('drafts', ['profile|page', 'client'], value=b'{"text":"unsent"}')
            self.db.execute(CONTROL, ('head', b'1'))
            self.db.execute(RECEIPT, ('tx', 'digest', 1))
            self.db.execute('COMMIT' if commit else 'ROLLBACK')
            with sqlite3.connect(self.path) as independent:
                self.assertEqual(independent.execute('SELECT count(*) FROM records').fetchone()[0], int(commit))
                self.assertEqual(independent.execute('SELECT count(*) FROM tx_receipts').fetchone()[0], int(commit))
                self.assertEqual(independent.execute(sql('SELECT value FROM control'), ('head',)).fetchone()[0], b'1' if commit else b'0')

    def test_killed_writer_before_and_after_commit_cold_readback(self):
        code = '''import json,os,sqlite3,sys
db=sqlite3.connect(sys.argv[1],isolation_level=None)
db.execute('PRAGMA synchronous=EXTRA')
queries=json.loads(sys.argv[3])
db.execute('BEGIN IMMEDIATE')
db.execute(queries[0],('head',b'1'))
db.execute(queries[1],('crash','digest',1))
if sys.argv[2]=='commit':db.execute('COMMIT')
os._exit(9)
'''
        for mode in ('rollback', 'commit'):
            child = subprocess.run([sys.executable, '-c', code, str(self.path), mode,
                                    json.dumps([CONTROL, RECEIPT])], capture_output=True)
            self.assertEqual(child.returncode, 9, child.stderr)
            with sqlite3.connect(self.path) as restarted:
                self.assertEqual(restarted.execute('SELECT count(*) FROM tx_receipts').fetchone()[0], int(mode == 'commit'))
                self.assertEqual(restarted.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_resource_and_profile_tombstones_purge_transfers_atomically(self):
        self.record('snapshots', 'profile|page')
        self.record('transfers', 'profile|page|upload')
        self.record('transfers', 'profile|other|upload', 'profile|other')
        tombstone = sql('INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,\'resource\'')
        purge = sql('DELETE FROM records WHERE resource_key=')
        for commit in (False, True):
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute(tombstone, ('profile|page', 'profile'))
            self.db.execute(purge, ('profile|page',))
            self.db.execute('COMMIT' if commit else 'ROLLBACK')
            self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 1 if commit else 3)
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute(sql('INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,\'profile\''), ('profile', 'profile'))
        self.db.execute(sql('DELETE FROM records WHERE profile_id='), ('profile',))
        self.db.execute(sql('DELETE FROM recovery WHERE profile_id='), ('profile',))
        self.db.execute('COMMIT')
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM tombstones').fetchone()[0], 2)

    def test_staging_bytes_and_receipt_retry_cleanup_are_durable(self):
        raw = json.dumps({'version': 1, 'mode': 'quarantine', 'changes': []}).encode()
        for part, chunk in enumerate((raw[:11], raw[11:])):
            self.db.execute(STAGE, ('tx', part, 'owner', 0, chunk))
        parts = self.db.execute(sql('SELECT part,lease,base_head,data FROM staging'), ('tx',)).fetchall()
        self.assertEqual(b''.join(row[3] for row in parts), raw)
        self.assertEqual([row[0] for row in parts], [0, 1])
        digest = hashlib.sha256(raw).hexdigest()
        self.db.execute(RECEIPT, ('tx', digest, 9))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(RECEIPT, ('tx', 'different', 10))
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute(sql('DELETE FROM staging WHERE tx_id='), ('tx',))
        self.db.execute('COMMIT')
        with sqlite3.connect(self.path) as restarted:
            self.assertEqual(restarted.execute('SELECT count(*) FROM staging').fetchone()[0], 0)
            self.assertEqual(restarted.execute(sql('SELECT digest,head FROM tx_receipts'), ('tx',)).fetchone(), (digest, 9))

    def test_paginated_blob_substrings_do_not_read_recovery(self):
        raw = json.dumps({'text': '가족' * 200000}, ensure_ascii=False).encode()
        self.record('drafts', ['profile|page', 'client'], value=raw)
        self.db.execute(sql('INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)'),
                        ('quarantine', 0, 'drafts', '"secret"', 'profile', b'{"quarantined":true}'))
        header = self.db.execute(sql('SELECT rowid,bucket,key,length(value) FROM records'), ('profile', 0)).fetchone()
        actual = bytearray()
        while len(actual) < header[3]:
            chunk = self.db.execute(sql('SELECT substr(value,?,?) FROM records'),
                                    (len(actual) + 1, min(256 * 1024, header[3] - len(actual)), header[0], 'profile')).fetchone()[0]
            self.assertLessEqual(len(chunk), 256 * 1024)
            actual.extend(chunk)
        self.assertEqual(actual, raw)
        self.assertEqual(self.db.execute(sql('SELECT rowid,bucket,key,length(value) FROM records'), ('other-profile', 0)).fetchall(), [])

    def test_source_disabled_gate_final_delivery_and_failclosed_contract(self):
        plugin = (APP / 'AppDelegate.swift').read_text()
        self.assertIn('private let OUTBOX_ENABLED = false', plugin)
        self.assertIn('"outboxEnabled": OUTBOX_ENABLED', plugin)
        self.assertIn('guard OUTBOX_ENABLED else { call.reject(', plugin)
        self.assertIn('if OUTBOX_ENABLED, value.active == nil { try outboxStore().revoke() }', plugin)
        observer = plugin.split('private func observeOutboxSession', 1)[1].split('private func validOrigin', 1)[0]
        self.assertLess(observer.index('guard OUTBOX_ENABLED else'), observer.index('try outboxStore()'))
        self.assertIn('self.auth == startingAuth', plugin)
        self.assertIn('self.outbox === store, store.boundary == boundary', plugin)
        self.assertIn('if error == .storage { self.poisonOutbox() }', plugin)
        self.assertIn('!outboxFailed', plugin)
        delivery = plugin.split('let boundary = store.boundary', 1)[1].split('} catch let error', 1)[0]
        self.assertIn('webView.evaluateJavaScript(', delivery)
        self.assertNotIn('call.resolve(', delivery)
        receipt = SOURCE.split('if let receipt = try rows("SELECT digest,head', 1)[1].split('var bytes = Data()', 1)[0]
        self.assertIn('DELETE FROM staging WHERE tx_id=?', receipt)
        self.assertIn('if !sameIdentity { _ = try self.advance() }', SOURCE)
        self.assertIn('if item.bucket == "profiles" { try self.purgeProfile(item.profile) }', SOURCE)
        profile_lookup = SOURCE.split('private func availableProfile()', 1)[1].split('func ensureOwner', 1)[0]
        self.assertIn('do { return try verifiedProfile() }', profile_lookup)
        self.assertIn('catch FountainOutboxError.blocked { return nil }', profile_lookup)
        self.assertNotIn('catch {', profile_lookup)
        self.assertNotIn('try? verifiedProfile()', SOURCE)
        self.assertNotIn('try? self.verifiedProfile()', SOURCE)
        self.assertIn('let current = try availableProfile()', SOURCE)
        self.assertIn('let active = try self.availableProfile()', SOURCE)

    def test_recovery_import_receipt_is_private_immutable_and_purged(self):
        profile = 'https://fixture.invalid:8443|workspace|member|binding'
        digest = 'a' * 64
        receipt = {'id': 'recovery-import:' + profile + ':' + digest, 'profileId': profile,
                   'digest': digest, 'operationIds': ['fresh-op'], 'pageIds': [], 'draftKeys': [], 'createdAt': 1}
        encoded_key = json.dumps(receipt['id'], separators=(',', ':'))
        payload = json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode()
        self.db.execute(RECORD, ('meta', encoded_key, profile, None, payload))
        found = self.db.execute(sql("SELECT value FROM records WHERE bucket='meta' AND key="), (encoded_key,)).fetchone()[0]
        self.assertEqual(found, payload)
        self.assertNotEqual(found, json.dumps({**receipt, 'operationIds': ['forged']}).encode())
        self.assertEqual(self.db.execute(sql('SELECT rowid,bucket,key,length(value) FROM records'), ('other-profile', 0)).fetchall(), [])
        self.db.execute(sql('DELETE FROM records WHERE profile_id='), (profile,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 0)
        parser = SOURCE.split('private func importReceiptProfile(', 1)[1].split('private func purgeProfile(', 1)[0]
        self.assertIn('key.lastIndex(of: ":")', parser)
        self.assertIn('value["profileId"] as? String == profile', parser)
        self.assertIn('value["digest"] as? String == digest', parser)
        self.assertIn('guard mode == "active" else', SOURCE)
        self.assertIn('previous != item.payload', SOURCE)
        self.assertIn('if op == "delete" { return profile }', parser)
        self.assertIn('SELECT count(*) FROM tombstones WHERE scope=?", [item.profile]', SOURCE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
