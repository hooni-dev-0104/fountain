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
RECOVERY = (APP / 'FountainRecovery.swift').read_text()
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
        self.assertIn('if OUTBOX_ENABLED, !recoveryMode, value.active == nil { try outboxStore().revoke() }', plugin)
        observer = plugin.split('private func observeOutboxSession', 1)[1].split('private func validOrigin', 1)[0]
        self.assertLess(observer.index('guard OUTBOX_ENABLED, !recoveryMode else'), observer.index('try outboxStore()'))
        self.assertIn('self.auth == startingAuth', plugin)
        self.assertIn('self.outbox === store, store.boundary == boundary', plugin)
        self.assertIn('if error == .storage { self.poisonOutbox() }', plugin)
        self.assertIn('!outboxFailed', plugin)
        delivery = plugin.split('let boundary = store.boundary', 1)[1].split('} catch let error', 1)[0]
        self.assertIn('webView.evaluateJavaScript(', delivery)
        self.assertNotIn('call.resolve(', delivery)
        receipt = SOURCE.split('if let receipt = try rows("SELECT digest,head', 1)[1].split('var bytes = Data()', 1)[0]
        self.assertIn('DELETE FROM staging WHERE tx_id=?', receipt)
        self.assertTrue('if !sameIdentity { _ = try self.advance();' in SOURCE)
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

    def control(self, name):
        found = self.db.execute(sql('SELECT value FROM control'), (name,)).fetchone()
        return None if found is None else json.loads(found[0])

    def set_control(self, name, value):
        self.db.execute(CONTROL, (name, json.dumps(value, separators=(',', ':')).encode()))

    def test_private_proof_refresh_rolls_back_and_never_advances_data_head(self):
        proof = {'profileId': 'profile', 'kind': 'database', 'id': 'tasks',
                 'accessRevision': 4, 'dataRevision': 20, 'rows': {'readable': 1},
                 'observedAt': 100, 'validUntil': 200}
        for commit in (False, True):
            self.db.execute('BEGIN IMMEDIATE')
            self.set_control('proofs:profile', {'database:tasks': proof})
            self.set_control('proofEpoch', 1)
            self.db.execute('COMMIT' if commit else 'ROLLBACK')
            self.assertEqual(self.control('head'), 0)
            self.assertEqual(self.control('lease'), 'owner')
            self.assertEqual(self.control('proofEpoch'), 1 if commit else None)
            self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 0)
        with sqlite3.connect(self.path) as restarted:
            self.assertEqual(json.loads(restarted.execute(sql('SELECT value FROM control'),
                             ('proofs:profile',)).fetchone()[0])['database:tasks']['rows'], {'readable': 1})
            # Bridge read queries only records, never private control/ledger rows.
            self.assertEqual(restarted.execute(sql('SELECT rowid,bucket,key,length(value) FROM records'),
                                              ('profile', 0)).fetchall(), [])

    def test_lost_ack_receipt_proof_epoch_survives_refresh_and_restage(self):
        self.db.execute('BEGIN IMMEDIATE')
        self.record('drafts', ['profile|page', 'client'], value=b'{"draft":"kept"}')
        self.set_control('head', 1)
        self.db.execute(RECEIPT, ('accepted', 'same-digest', 1))
        self.set_control('receiptProof:accepted', 7)
        self.db.execute('COMMIT')
        self.set_control('proofEpoch', 8)
        self.set_control('stagedProof:accepted', 7)
        self.db.execute(STAGE, ('accepted', 0, 'owner', 0, b'original-exact-bytes'))
        accepted = self.db.execute(sql('SELECT digest,head FROM tx_receipts'), ('accepted',)).fetchone()
        self.assertEqual(accepted, ('same-digest', 1))
        self.assertEqual(self.control('receiptProof:accepted'), 7)
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute(sql('DELETE FROM staging WHERE tx_id='), ('accepted',))
        self.db.execute('COMMIT')
        self.assertEqual(self.control('proofEpoch'), 8)
        self.assertEqual(self.control('head'), 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 1)

    def test_failed_access_overlay_preserves_staged_input_receipts_and_records(self):
        self.record('snapshots', 'profile|page', value=b'{"snapshot":"original"}')
        self.db.execute(STAGE, ('pending', 0, 'owner', 0, b'unsent-exact-bytes'))
        self.set_control('stagedProof:pending', 2)
        before = list(self.db.iterdump())
        self.db.execute('BEGIN IMMEDIATE')
        # Model the failure boundary inside production commit's transaction,
        # before its head/receipt publication, without claiming Swift execution.
        self.record('drafts', ['profile|page', 'new'], value=b'{"draft":"uncommitted"}')
        self.set_control('head', 1)
        self.db.execute(RECEIPT, ('pending', 'digest', 1))
        self.set_control('receiptProof:pending', 2)
        self.db.execute('ROLLBACK')
        self.assertEqual(list(self.db.iterdump()), before)

    def test_resource_proof_source_and_preflight_fences(self):
        plugin = (APP / 'AppDelegate.swift').read_text()
        observer = SOURCE.split('func observeResource(', 1)[1].split('func stage(', 1)[0]
        canonical = SOURCE.split('static func canonicalResource(', 1)[1].split('private func proofs(', 1)[0]
        self.assertIn('method == "GET"', canonical)
        self.assertIn('!path.contains("?")', canonical)
        self.assertIn('removingPercentEncoding', canonical)
        self.assertIn('body["session_binding"] as? String == parts[3].removingPercentEncoding', observer)
        self.assertIn('revision >= (knownFloor["data"] ?? 0)', observer)
        self.assertIn('min(grant["validUntil"] as? Double ?? 0, now + 86_400_000)', observer)
        self.assertNotIn('self.advance()', observer)
        invalid = observer.split('catch {', 1)[1]
        self.assertNotIn('purgeResource(', invalid)
        self.assertNotIn('purgeProfile(', invalid)
        preflight = SOURCE.split('private func accessIssues(', 1)[1].split('func commit(', 1)[0]
        for required in ['value["workspace"]', '"local_dependency"', '"revision_changed"',
                         '"epoch_changed"', 'authority["rows"]', 'authority["canCreateRow"]',
                         'authority["relations"]', 'references(cached', 'operation["base_rows"]']:
            self.assertIn(required, preflight)
        read = SOURCE.split('func read(', 1)[1]
        self.assertLess(read.index('try requireAccess(profile)'), read.index('var fragments:'))
        self.assertIn('value["proofEpoch"]', read)
        self.assertIn('let deadline = try requireAccess(profile)', read)
        self.assertIn('readDeadline = deadline', read)
        deadline = SOURCE.split('func deliveryDeadline()', 1)[1].split('func open()', 1)[0]
        self.assertIn('guard let deadline = readDeadline', deadline)
        self.assertNotIn('filter', deadline)
        self.assertIn('"proofEpoch": proofEpoch', read)
        commit = SOURCE.split('func commit(', 1)[1].split('func read(', 1)[0]
        self.assertLess(commit.index('SELECT digest,head FROM tx_receipts'), commit.index('proofEpoch == (try self.proofEpoch())'))
        self.assertLess(commit.index('try self.requireAccess(profile, overlay: changes)'), commit.index('let head = try self.advance()'))
        self.assertIn('let cleanupOnly = changes.allSatisfy', commit)
        self.assertIn('setControl("receiptProof:" + txID, proofEpoch)', commit)
        stage = SOURCE.split('func stage(', 1)[1].split('private struct Change', 1)[0]
        self.assertIn('original == proofEpoch', stage)
        self.assertNotIn('self.proofEpoch()', stage)
        self.assertIn('case .access: return "OUTBOX_ACCESS_REQUIRED"', SOURCE)
        self.assertIn('Array(issues.prefix(100))', SOURCE)
        self.assertIn('"accessIssuesTruncated": issues.count > 100', SOURCE)
        self.assertIn('store.observedProofEpoch == startingProofEpoch', plugin)
        self.assertIn('guard current(job), try cookies().active == job.sentCookie', plugin)
        self.assertIn('if response.statusCode != 401 { try self.observeOutboxResource', plugin)
        terminal = observer.split('return\n        }', 1)[1].split('do {', 1)[0]
        self.assertIn('ledger[key]?["denied"]', terminal)
        self.assertIn('SELECT count(*) FROM tombstones WHERE scope=?', terminal)
        self.assertIn('throw FountainOutboxError.access', terminal)

    def test_floor_and_proof_metadata_share_rollback_and_preserve_business_receipts(self):
        self.db.execute(RECEIPT, ('already-accepted', 'digest', 0))
        self.set_control('receiptProof:already-accepted', 2)
        self.set_control('proofFloor:profile', {'access': 3, 'data': 90})
        self.set_control('proofEpoch', 2)
        for committed in (False, True):
            self.db.execute('BEGIN IMMEDIATE')
            self.set_control('proofFloor:profile', {'access': 3, 'data': 100})
            self.set_control('proofs:profile', {'workspace:workspace': {'dataRevision': 100}})
            self.set_control('proofEpoch', 3)
            self.db.execute('COMMIT' if committed else 'ROLLBACK')
            self.assertEqual(self.control('proofFloor:profile')['data'], 100 if committed else 90)
            self.assertEqual(self.control('proofEpoch'), 3 if committed else 2)
            self.assertEqual(self.control('head'), 0)
            self.assertEqual(self.control('receiptProof:already-accepted'), 2)
            self.assertEqual(self.db.execute(sql('SELECT digest,head FROM tx_receipts'),
                                            ('already-accepted',)).fetchone(), ('digest', 0))
        observer = SOURCE.split('func observeResource(', 1)[1].split('func stage(', 1)[0]
        self.assertIn('setControl("proofFloor:" + profile', observer)
        self.assertLess(observer.index('let knownFloor'), observer.index('var proposed = ledger'))
        semantic = observer.split('if var old = ledger[key]', 1)[1].split('try transaction', 1)[0]
        self.assertIn('deadline > now', semantic)
        self.assertIn('>= deadline', semantic)
        self.assertIn('"observedAt", "validUntil"', semantic)
        self.assertIn('if try json(old) == json(semantic), access == knownFloor["access"]', semantic)
        preflight = SOURCE.split('private func accessIssues(', 1)[1].split('func commit(', 1)[0]
        self.assertIn('>= (currentFloor["access"] ?? 0)', preflight)
        self.assertIn('>= (currentFloor["data"] ?? 0)', preflight)
        self.assertIn('tombstones.contains(profile +', preflight)
        workspace = preflight.split('if item.bucket == "profiles"', 1)[1].split('let pieces = item.resource', 1)[0]
        self.assertIn('if let direct = ledger[proofKey(kind, id)]', workspace)
        self.assertIn('direct["denied"]', workspace)
        self.assertIn('direct["invalid"]', workspace)
        self.assertIn('Self.hash(bytes) == authority["schemaDigest"] as? String', preflight)

    def test_resource_denial_preserves_original_operation_and_draft_bytes_in_recovery(self):
        values = [('operations', ['profile|page', 'client:1'], b'{"operation":{"text":"unsent"}}'),
                  ('drafts', ['profile|page', 'client'], b'{"draft":{"blocks":[{"text":"kept"}]}}'),
                  ('mutations', ['profile', 'edit'], b'{"operation":{"kind":"page.patch"}}')]
        for bucket, key, value in values:
            self.record(bucket, key, value=value)
        self.record('transfers', 'profile|page|upload', value=b'{"name":"metadata"}')
        self.record('drafts', ['profile|other', 'client'], 'profile|other', b'{"other":"kept"}')
        original = list(self.db.iterdump())
        for commit in (False, True):
            self.db.execute('BEGIN IMMEDIATE')
            rows = self.db.execute(sql('SELECT bucket,key,value FROM records WHERE resource_key='),
                                   ('profile|page',)).fetchall()
            for index, (bucket, key, value) in enumerate(rows):
                self.db.execute(sql('INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)'),
                                ('denial', index, bucket, key, 'profile', value))
            self.db.execute(sql('DELETE FROM records WHERE resource_key='), ('profile|page',))
            self.db.execute('COMMIT' if commit else 'ROLLBACK')
            if not commit:
                self.assertEqual(list(self.db.iterdump()), original)
        recovered = dict(self.db.execute('SELECT bucket,value FROM recovery'))
        self.assertEqual(recovered['operations'], values[0][2])
        self.assertEqual(recovered['drafts'], values[1][2])
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 1)
        self.assertEqual(self.db.execute(sql('SELECT rowid,bucket,key,length(value) FROM records'),
                                        ('profile', 0)).fetchone()[1], 'drafts')
        purge = SOURCE.split('private func purgeResource(', 1)[1].split('private func accessIssues(', 1)[0]
        self.assertIn("bucket IN ('mutations','operations','drafts')", purge)
        self.assertIn('else { payload = bytes }', purge)
        self.assertLess(purge.index('INSERT INTO recovery('), purge.index('DELETE FROM records WHERE resource_key='))

    def test_preflight_and_quarantine_stream_records_with_bounded_private_ledger(self):
        for index in range(40):
            self.record('drafts', ['profile|page', str(index)], value=b'x' * (64 * 1024))
        query = sql('SELECT bucket,key,value FROM records WHERE profile_id=')
        size = count = 0
        for bucket, key, value in self.db.execute(query, ('profile',)):
            count += 1
            size = max(size, len(value))
        self.assertEqual(count, 40)
        self.assertEqual(size, 64 * 1024)
        stream = SOURCE.split('private func eachRecord(', 1)[1].split('private func control(', 1)[0]
        self.assertIn('sqlite3_step(prepared)', stream)
        self.assertIn('size <= recordLimit', stream)
        self.assertIn('try visit(', stream)
        self.assertNotIn('result.append(', stream)
        preflight = SOURCE.split('private func accessIssues(', 1)[1].split('func commit(', 1)[0]
        self.assertIn('try eachRecord("SELECT bucket,key,value FROM records WHERE profile_id=?"', preflight)
        self.assertNotIn('var records: [String: Change]', preflight)
        self.assertIn('overlayByKey[bucket + "|" + encoded] != nil', preflight)
        self.assertIn('issues.count <= 100', preflight)
        self.assertIn('try inspect(canonical)', preflight)
        self.assertIn('if let fields = base["fields"]', preflight)
        self.assertIn('references(["properties": properties]', preflight)
        self.assertIn('if targetDB.isEmpty', preflight)
        self.assertIn('for candidate in ledger.values', preflight)
        self.assertIn('let target = database(candidateID)', preflight)
        self.assertIn('try json(proposed).count <= recordLimit', SOURCE)
        self.assertIn('SELECT coalesce(length(value),0) FROM control WHERE id=?', SOURCE)
        observer = SOURCE.split('func observeResource(', 1)[1].split('func stage(', 1)[0]
        self.assertIn('if fits { try self.setControl("proofs:" + profile, proposed) }', observer)
        self.assertIn('if !fits { throw FountainOutboxError.access }', observer)
        self.assertIn('ledger = [self.proofKey("workspace", "workspace"):', observer)

    def test_capacity_floor_only_update_preserves_canonical_data_and_old_private_evidence(self):
        ledger = {'database:tasks': {'dataRevision': 90, 'rows': {'old-scope': 1}}}
        self.set_control('proofs:profile', ledger)
        self.set_control('proofFloor:profile', {'access': 1, 'data': 90})
        self.record('drafts', ['profile|page', 'client'], value=b'{"draft":"never evicted"}')
        self.db.execute('BEGIN IMMEDIATE')
        self.set_control('proofFloor:profile', {'access': 1, 'data': 100})
        self.set_control('proofEpoch', 1)
        self.db.execute('COMMIT')
        self.assertEqual(self.control('proofs:profile'), ledger)
        self.assertEqual(self.control('proofFloor:profile')['data'], 100)
        self.assertEqual(self.control('head'), 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0], 1)

    def test_explicit_recovery_uses_existing_readonly_sql_without_changing_source(self):
        actor = 'https://fixture.invalid|workspace|member|old-binding'
        foreign = 'https://fixture.invalid|workspace|other|old-binding'
        for profile in (actor, foreign):
            key = profile + '|page'
            value = json.dumps({'key': key, 'profileId': profile, 'clientId': 'client',
                                'draft': {'blocks': [{'id': 'old', 'type': 'paragraph', 'text': '한글🙂'}]}}).encode()
            self.db.execute(RECORD, ('drafts', json.dumps([key, 'client']), profile, key, value))
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        with sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, isolation_level=None) as reader:
            reader.execute('PRAGMA query_only=ON')
            reader.execute('BEGIN')
            query = next(value for value in re.findall(r'"([^"\n]*)"', RECOVERY)
                         if value.startswith('SELECT rowid,bucket,key,profile_id,length(value) FROM records'))
            prefix = 'https://fixture.invalid|workspace|member|'
            records = reader.execute(query, (prefix, prefix, 0)).fetchall()
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0][3], actor)
            with self.assertRaises(sqlite3.OperationalError):
                reader.execute('DELETE FROM records')
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)
        absent = Path(self.temp.name) / 'absent.sqlite'
        with self.assertRaises(sqlite3.OperationalError):
            sqlite3.connect(absent.as_uri() + '?mode=ro', uri=True)
        self.assertFalse(absent.exists())
        self.assertIn('create: false', RECOVERY)
        self.assertIn('O_RDONLY | O_NOFOLLOW', RECOVERY)
        self.assertIn('SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX', RECOVERY)
        self.assertNotIn('SQLITE_OPEN_CREATE', RECOVERY)
        self.assertNotIn('O_CREAT', RECOVERY)
        self.assertNotIn('FountainOutbox(origin:', RECOVERY)

    def test_recovery_raw_and_wrapped_records_preserve_sql_identity(self):
        profile = 'https://fixture.invalid|workspace|member|old-binding'
        resource = profile + '|page'
        record = {'key': resource, 'profileId': profile, 'clientId': 'client',
                  'draft': {'blocks': [{'id': 'old', 'type': 'paragraph', 'text': '직접·래핑 복구🙂'}]}}
        wrapped = {'op': 'put', 'bucket': 'drafts', 'key': [resource, 'client'], 'value': record}
        for index, payload in enumerate((record, wrapped)):
            raw = json.dumps(payload, ensure_ascii=False).encode()
            self.db.execute(sql('INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)'),
                            ('recover', index, 'drafts', json.dumps([resource, 'client']), profile, raw))
        before = list(self.db.iterdump())
        for row in self.db.execute('SELECT bucket,key,profile_id,value FROM recovery ORDER BY position'):
            payload = json.loads(row[3])
            if 'op' in payload:
                self.assertEqual(payload['op'], 'put')
                self.assertEqual(payload['bucket'], row[0])
                self.assertEqual(payload['key'], json.loads(row[1]))
                payload = payload['value']
            self.assertEqual(payload['profileId'], row[2])
            self.assertEqual(payload, record)
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertIn('actual == expected', RECOVERY)
        self.assertIn('record["profileId"] as? String == entry.profile', RECOVERY)
        self.assertIn('value["op"] as? String == "put"', RECOVERY)
        self.assertIn('value["bucket"] as? String == entry.bucket', RECOVERY)
        self.assertIn('source.2 == entry.profile', RECOVERY)

    def test_recovery_wire_and_scope_source_invariants(self):
        plugin = (APP / 'AppDelegate.swift').read_text()
        for method in ('recoveryInventory', 'recoveryExport'):
            self.assertEqual(plugin.count('"' + method + '"].contains(method)'), int(method == 'recoveryExport'))
            self.assertIn('@objc func ' + method, plugin)
        self.assertIn('"recoveryVersion": 1, "recoveryEnabled": true', plugin)
        inventory = plugin.split('@objc func recoveryInventory', 1)[1].split('@objc func recoveryExport', 1)[0]
        self.assertLess(inventory.index('self.recoveryMode = true'), inventory.index('self.recoverySession(job)'))
        session = plugin.split('private func recoverySession(', 1)[1].split('private func recoveryResources(', 1)[0]
        self.assertIn('network(path: "/api/session", method: "GET"', session)
        self.assertNotIn('outboxStore()', session)
        self.assertNotIn('.grant(', session)
        self.assertNotIn('.revoke(', session)
        self.assertIn('job.method != "GET", !["login", "logout"].contains(job.mode)', plugin)
        self.assertIn('guard OUTBOX_ENABLED, !recoveryMode else', plugin)
        self.assertIn('reader.boundary == startingBoundary, reader.validMetadata(result["exportToken"] as? String, other: authority)', plugin)
        self.assertIn('self.recoveryFiles[job.id] ?? [file]', plugin)
        self.assertIn('"filesSaved": saved', plugin)
        self.assertIn('reader.cancelToken(token)', plugin)
        self.assertNotIn('bodyBase64', RECOVERY)
        self.assertNotIn('bytesBase64', RECOVERY)
        self.assertIn('inventoryDeadline', RECOVERY)
        self.assertIn('+ 300_000', RECOVERY)
        self.assertIn('+ 120_000', RECOVERY)
        self.assertIn('sourceHead', RECOVERY)
        self.assertIn('FountainOutbox.hash(source.3) == entry.digest', RECOVERY)
        self.assertIn('authorityDigests(responses)', RECOVERY)
        self.assertIn('handles.count <= 100', RECOVERY)
        self.assertIn('outputs.count < 1000', RECOVERY)
        self.assertIn('64 * 1024 * 1024', RECOVERY)
        self.assertIn('256 * 1024', RECOVERY)
        self.assertIn('currentDenied("database"', RECOVERY)
        self.assertIn('operation["base_rows"]', RECOVERY)
        self.assertIn('minimum: 1', RECOVERY)
        self.assertIn('case .auth: return "RECOVERY_AUTH_REQUIRED"', RECOVERY)

    def test_recovery_strict_projection_and_cancellation_source_invariants(self):
        plugin = (APP / 'AppDelegate.swift').read_text()
        projection = RECOVERY.split('private func projection(', 1)[1].split('private struct Piece', 1)[0]
        self.assertIn('draft["ops"] = try operations(supplied)', projection)
        self.assertIn('draft["blocks"] = try self.blocks(supplied)', projection)
        self.assertIn('safeInteger(seq) == nil', projection)
        self.assertIn('boolean(pending) == nil', projection)
        self.assertIn('let text = supplied as? String', projection)
        self.assertIn('block["attachment_id"] as? String', projection)
        self.assertIn('operationDependencies(operation)', projection)
        self.assertIn('value["after_operation"]', projection)
        self.assertIn('let operation = output["operation"]', RECOVERY)
        self.assertIn('validProperty(value, type: kind)', RECOVERY)
        self.assertIn('Set(range.keys).isSubset(of: ["start", "end"])', RECOVERY)
        self.assertIn('guard let values = value as? [String]', RECOVERY)
        self.assertIn('Set(source.keys).isSubset(of: fields.union(', RECOVERY)
        self.assertIn('let value = source["value"], ["type", "checked", "language", "attachment_id", "size"].contains(field)', RECOVERY)
        self.assertIn('return ["text": text, "marks": try marks(', RECOVERY)
        self.assertIn('record["id"] as? String == keys[1]', RECOVERY)
        self.assertIn('operation["id"] as? String == keys[1]', RECOVERY)
        self.assertIn('"clientId" : "id"] as? String == keys[1]', RECOVERY)
        cleanup = plugin.split('let cleanStale =', 1)[1].split('DispatchQueue.main.async', 1)[0]
        self.assertIn('Self.ownership.lock()', cleanup)
        self.assertIn('reader.boundary == startingBoundary', cleanup)
        self.assertIn('reader.cancelToken(token)', cleanup)
        self.assertIn('cleanStale(); job.call.reject', plugin)
        self.assertIn('self.recovery?.observes(job.path) == true', plugin)
        self.assertIn('prepared?.authorityDigests[path] != nil', RECOVERY)

    def test_recovery_authority_counter_only_model_preserves_real_scope_differences(self):
        # This is a portable semantic fingerprint model and source check;
        # no Swift validator execution is claimed.
        original = {'workspace_id': 'workspace', 'current_member_id': 'member', 'session_binding': 'binding',
                    'access_revision': 4, 'data_revision': 90, 'database': {'id': 'tasks', 'access_level': 3},
                    'rows': [{'id': 'readable', 'access_level': 3, 'properties': {'data_revision': 'user value'}}]}
        def digest(value):
            value = dict(value)
            value.pop('data_revision', None)
            return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        unrelated = {**original, 'data_revision': 100}
        self.assertEqual(digest(original), digest(unrelated))
        self.assertEqual(digest(original), digest(dict(reversed(list(original.items())))))
        for changed in ({**original, 'rows': []}, {**original, 'access_revision': 5},
                        {**original, 'session_binding': 'new-login'},
                        {**original, 'rows': [{'id': 'readable', 'access_level': 1}]},
                        {**original, 'rows': [{'id': 'readable', 'access_level': 3,
                                             'properties': {'data_revision': 'changed user value'}}]}):
            self.assertNotEqual(digest(original), digest(changed))
        helper = RECOVERY.split('private func authorityDigest(', 1)[1].split('private func identifier(', 1)[0]
        self.assertIn('FountainOutbox.canonicalResource(path: path, method: "GET")', helper)
        self.assertIn('authority.envelope(body)', helper)
        self.assertIn('safeInteger(body["access_revision"])', helper)
        self.assertIn('body.removeValue(forKey: "data_revision")', helper)
        self.assertNotIn('removeValue(forKey: "access_revision")', helper)
        self.assertIn('authorityDigest(path, status: response.0, data: response.1)', helper)

    def test_documented_export_shapes_are_accepted_by_actual_recovery_parser(self):
        # Portable format model, not execution of the native Swift serializer.
        envelope = {'format': 'fountain-recovery-v2', 'origin': 'https://fixture.invalid',
                    'workspace_id': 'workspace', 'member_id': 'member', 'source_binding': 'old-binding',
                    'records': [{'id': 'original-edit', 'operation': {'id': 'original-edit',
                                 'kind': 'page.patch', 'target_id': 'page', 'body': {'title': '다시 확인할 제목'},
                                 'depends_on': []}}], 'localPages': [],
                    'drafts': [{'page_id': 'page', 'draft': {'blocks': [{'id': 'old', 'type': 'paragraph',
                                      'text': '전체 본문🙂 <img src=x>'}]}}]}
        script = '''const fs=require('fs');globalThis.FountainCollaboration=require('./static/collaboration.js');
const recovery=require('./static/recovery-import.js'),value=JSON.parse(fs.readFileSync(0,'utf8'));
const parsed=recovery.parse(JSON.stringify(value),{origin:'https://fixture.invalid',workspaceId:'workspace',memberId:'member'});
process.stdout.write(JSON.stringify({records:parsed.records.length,drafts:parsed.drafts.length,text:parsed.drafts[0].draft.blocks.map(b=>b.text).join('')}));'''
        root = Path(__file__).resolve().parents[3]
        result = subprocess.run(['node', '-e', script], cwd=root, input=json.dumps(envelope, ensure_ascii=False),
                                text=True, capture_output=True, check=True)
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed['records'], 1)
        self.assertEqual(parsed['text'], '전체 본문🙂 <img src=x>')
        original = json.dumps({'ops': [{'type': 'text.insert', 'text': '한글🙂' * 20000}]}, ensure_ascii=False)
        parts = [original[index:index + 50000] for index in range(0, len(original), 50000)]
        readable = {'blocks': [{'id': 'native-part-' + str(index), 'type': 'code', 'language': 'json', 'text': part}
                               for index, part in enumerate(parts)]}
        result = subprocess.run(['node', '-e', script], cwd=root, input=json.dumps(readable, ensure_ascii=False),
                                text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)['text'], original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
