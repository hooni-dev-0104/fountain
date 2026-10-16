"""Migration proves real PG/file behavior using only generated namespaces/data."""
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from fountain.access import Access
from fountain.attachments import CHUNK_SIZE, FileStorage
from fountain.auth import Auth, SESSION_COOKIE
from fountain.core import APIError, Store
from fountain.crdt import seed_state
from fountain.migrate import MigrationError, migrate_sqlite
from fountain.postgres import PostgresStore


class MigrationSourceTests(unittest.TestCase):
    def test_missing_source_is_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.db"
            with self.assertRaisesRegex(MigrationError, "does not exist"):
                migrate_sqlite(path, None)
            self.assertFalse(path.exists())

    def test_corrupt_source_and_non_filesystem_target_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "corrupt.db"
            path.write_bytes(b"not SQLite")
            with self.assertRaises(MigrationError):
                migrate_sqlite(path, None)
            source = Store(Path(directory) / "valid.db")
            try:
                source.set_meta("workspace_id", uuid.uuid4().hex)
                with self.assertRaisesRegex(MigrationError, "filesystem"):
                    migrate_sqlite(Path(directory) / "valid.db", source)
            finally:
                source.close()


@unittest.skipUnless(os.environ.get("FOUNTAIN_TEST_POSTGRES_DSN"),
                     "Real migration verification requires FOUNTAIN_TEST_POSTGRES_DSN")
class MigrationIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.source_path = self.root / "generated-sqlite.db"
        self.source = Store(self.source_path)
        self.namespace = uuid.uuid4().hex
        self.stores = []
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""})
        self.environment.start()
        self.source.set_meta("workspace_id", self.namespace)
        self.source.set_meta("local_cache_binding", uuid.uuid4().hex)
        self.source.set_meta("seeded", True)
        self.source.set_meta("access_revision", 19)
        self.source.set_meta("typed", {"한글": [None, False, True, 3, -2, 0.125, {"nested": "값"}]})
        self.source.put("member", {"id": "local", "name": "소유자", "email": "owner@example.local", "role": "owner", "active": True})
        self.source.put("member", {"id": "family", "name": "가족", "email": "family@example.local", "role": "member", "active": True})
        self.source.put("member", {"id": "disabled", "email": "disabled@example.local", "role": "guest", "active": False})
        self.source.put("page", {"id": "private", "title": "가족 전용 문서", "owner_id": "local", "archived": False, "locked": True,
                                 "revision": 7, "permissions": {"default": "private", "members": {"family": "view"}, "groups": {}, "inherit": False},
                                 "blocks": [{"id": "paragraph", "type": "paragraph", "text": "원본을 보존합니다 👪"}]})
        self.source.put("collaboration", {"id": "private", "epoch": str(uuid.uuid4()), "seq": 8,
                                          "state": seed_state(self.source.get("page", "private")["blocks"])})
        self.source.put("database", {"id": "data", "name": "가족 DB", "owner_id": "local", "properties": [{"id": "name", "type": "title", "name": "이름"}]})
        self.source.put("row", {"id": "row", "database_id": "data", "properties": {"name": "기존 항목"}, "depends_on": [], "parent_row_id": None})
        self.source.put("sync_receipt", {"id": "receipt", "actor_id": "family", "workspace_id": self.namespace,
                                         "operation_id": "device:1", "digest": "a" * 64, "result": {"id": "device:1", "status": "applied", "resource_id": "row", "data_revision": 6}})
        self.source.put("clipboard", {"id": "live-clipboard", "html": "운영 이동에는 임시 상태도 보존"})
        self.source.put("presence", {"id": "live-presence", "page_id": "private", "member_id": "family", "retain_until": 1900000060.0})
        auth = Auth(self.source)
        auth.create_account("local", "Generated-owner-password-2026")
        auth.create_account("family", "Generated-family-password-2026")
        auth.enable_accounts()
        self.cookie = SESSION_COOKIE + "=" + auth.login({"email": "family@example.local", "password": "Generated-family-password-2026"})
        self.target = self.open_store(self.namespace, self.root / "attachment-files")
        self.addCleanup(self.cleanup)

    def open_store(self, namespace, attachment_root=None):
        store = PostgresStore(os.environ["FOUNTAIN_TEST_POSTGRES_DSN"], workspace_id=namespace, attachment_root=attachment_root)
        self.stores.append(store)
        return store

    def cleanup(self):
        try:
            for store in {store.workspace_id: store for store in self.stores}.values():
                with store.transaction():
                    for table in ("identity_mapping", "attachment_chunks", "entities", "meta"):
                        store._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s", (store.workspace_id,))
        finally:
            for store in self.stores:
                store.close()
            self.source.close()
            self.environment.stop()
            self.temporary.cleanup()

    def add_attachment(self):
        identity = "finished"
        parts = [b"a" * CHUNK_SIZE, b"tail-data" * (128 * 1024) + b"!"]
        digest = hashlib.sha256()
        with self.source.transaction():
            offset = 0
            for part in parts:
                self.source.chunk_write(identity, offset, part)
                digest.update(part)
                offset += len(part)
            self.source.put("attachment", {"id": identity, "name": "가족 첨부.bin", "owner_id": "local", "storage": "chunks", "size": offset,
                                           "sha256": digest.hexdigest(), "mime": "application/octet-stream"})
            self.source.put("upload", {"id": identity, "owner_id": "local", "completed": True, "offset": offset, "size": offset, "expires_at": "2099-01-01T00:00:00+00:00"})
        return parts, digest.hexdigest()

    def source_fingerprint(self):
        self.source.db.execute("PRAGMA wal_checkpoint(FULL)")
        return hashlib.sha256(self.source_path.read_bytes()).hexdigest(), {
            kind: self.source.list(kind) for (kind,) in self.source.db.execute("SELECT DISTINCT kind FROM entities")
        }, self.source.db.execute("SELECT key,data FROM meta ORDER BY key").fetchall()

    def target_is_empty(self):
        with self.target.transaction():
            return self.target._execute("SELECT count(*) FROM fountain_private.entities WHERE workspace_id=%s", (self.namespace,), fetch="one")[0] == 0

    def test_live_move_preserves_credentials_sessions_acl_crdt_receipts_flags_and_file_bytes(self):
        parts, digest = self.add_attachment()
        before = self.source_fingerprint()
        revision = self.source.meta("_entity_revision")
        source_session = Auth(self.source).session_info(self.cookie)
        root_binding = self.target.meta("attachment_file_root")
        result = migrate_sqlite(self.source_path, self.target)
        self.assertEqual(result["workspace_id"], self.namespace)
        self.assertEqual(result["entity_revision"], revision)
        self.assertEqual(result["chunks"], 2)
        self.assertEqual(result["bytes"], sum(map(len, parts)))
        self.assertEqual(self.target.meta("_entity_revision"), revision)
        self.assertEqual(self.target.meta("attachment_file_root"), root_binding)
        self.assertEqual(self.source_fingerprint(), before)
        for kind, values in before[1].items():
            self.assertEqual(self.target.list(kind), values, kind)
        for key, encoded in before[2]:
            self.assertEqual(self.target.meta(key), json.loads(encoded), key)
        self.assertEqual(Auth(self.target).session_info(self.cookie), source_session)
        access = Access(self.target, Auth(self.target).principal(self.cookie))
        self.assertEqual(access.level("page", self.target.get("page", "private")), 1)
        checksum, total = hashlib.sha256(), 0
        for piece in FileStorage(self.target).iter_bytes("finished"):
            self.assertLessEqual(len(piece), 65536)
            checksum.update(piece)
            total += len(piece)
        self.assertEqual((checksum.hexdigest(), total), (digest, sum(map(len, parts))))
        with self.target.transaction():
            self.assertEqual(self.target._execute("SELECT count(*) FROM fountain_private.attachment_chunks WHERE workspace_id=%s", (self.namespace,), fetch="one")[0], 0)
        self.assertEqual(len(self.target.list("attachment_chunk")), 2)

    def test_json_numbers_are_copied_without_binary_float_rounding(self):
        encoded = '{"id":"precise","decimal":1.23456789012345678901234567890,"big":9007199254740993}'
        with self.source.transaction():
            self.source.db.execute("INSERT INTO entities VALUES (?,?,?,?,?)", ("example", "precise", encoded, "2020-created", "2021-updated"))
        migrate_sqlite(self.source_path, self.target)
        with self.target.transaction():
            row = self.target._execute("SELECT data::text,created_at,updated_at FROM fountain_private.entities WHERE workspace_id=%s AND kind='example' AND id='precise'", (self.namespace,), fetch="one")
        data = json.loads(row[0], parse_float=Decimal)
        self.assertEqual(data["decimal"], Decimal("1.23456789012345678901234567890"))
        self.assertEqual(data["big"], 9007199254740993)
        self.assertEqual(row[1:], ("2020-created", "2021-updated"))

    def test_legacy_two_table_source_without_revision_stays_without_revision(self):
        with self.source.transaction():
            self.source.db.execute("DROP TABLE attachment_chunks")
            self.source.db.execute("DELETE FROM meta WHERE key='_entity_revision'")
        before = self.source_fingerprint()
        result = migrate_sqlite(self.source_path, self.target)
        self.assertIsNone(result["entity_revision"])
        self.assertEqual(result["chunks"], 0)
        self.assertEqual(self.target.meta("_entity_revision", "absent"), "absent")
        self.assertEqual(self.source_fingerprint(), before)

    def test_nonempty_target_and_existing_metadata_are_never_deleted(self):
        self.target.put("page", {"id": "keep", "title": "Existing target data"})
        original = self.target.get("page", "keep")
        with self.assertRaisesRegex(MigrationError, "empty"):
            migrate_sqlite(self.source_path, self.target)
        self.assertEqual(self.target.get("page", "keep"), original)
        self.target.delete("page", "keep")
        self.target.set_meta("keep-setting", {"private": True})
        with self.assertRaisesRegex(MigrationError, "metadata"):
            migrate_sqlite(self.source_path, self.target)
        self.assertEqual(self.target.meta("keep-setting"), {"private": True})

    def test_existing_identity_mapping_refuses_migration_without_writes(self):
        original = self.target._execute
        def mapped(statement, parameters=(), **options):
            if statement.startswith("SELECT 1 FROM fountain_private.identity_mapping"):
                return (1,)
            return original(statement, parameters, **options)
        with patch.object(self.target, "_execute", side_effect=mapped):
            with self.assertRaisesRegex(MigrationError, "empty"):
                migrate_sqlite(self.source_path, self.target)
        self.assertTrue(self.target_is_empty())

    def test_wrong_namespace_and_bytea_only_target_are_rejected(self):
        wrong = self.open_store(uuid.uuid4().hex, self.root / "another-root")
        with self.assertRaisesRegex(MigrationError, "namespaces"):
            migrate_sqlite(self.source_path, wrong)
        bytea = self.open_store(uuid.uuid4().hex)
        with self.assertRaisesRegex(MigrationError, "filesystem"):
            migrate_sqlite(self.source_path, bytea)
        self.assertTrue(self.target_is_empty())

    def test_incomplete_upload_and_orphan_chunks_require_operator_resolution(self):
        self.source.put("upload", {"id": "unfinished", "completed": False, "offset": 0, "size": 100})
        with self.assertRaisesRegex(MigrationError, "incomplete"):
            migrate_sqlite(self.source_path, self.target)
        self.source.delete("upload", "unfinished")
        self.source.chunk_write("orphan", 0, b"unfinished orphan")
        with self.assertRaisesRegex(MigrationError, "orphaned"):
            migrate_sqlite(self.source_path, self.target)
        self.assertTrue(self.target_is_empty())

    def test_external_filesystem_references_are_not_blindly_cloned(self):
        self.source.put("attachment_chunk", {"id": "foreign-reference", "sha256": "a" * 64})
        with self.assertRaisesRegex(MigrationError, "external filesystem"):
            migrate_sqlite(self.source_path, self.target)
        self.source.delete("attachment_chunk", "foreign-reference")
        self.source.set_meta("attachment_file_root", {"version": 1, "id": str(uuid.uuid4())})
        with self.assertRaisesRegex(MigrationError, "root binding"):
            migrate_sqlite(self.source_path, self.target)
        with self.source.transaction():
            self.source.db.execute("DELETE FROM meta WHERE key='attachment_file_root'")
        self.source.set_meta("attachment_file_gc_cursor", {"version": 1, "prefix": "ab", "name": "a" * 64})
        with self.assertRaisesRegex(MigrationError, "garbage collection"):
            migrate_sqlite(self.source_path, self.target)
        self.assertTrue(self.target_is_empty())

    def test_midcopy_failure_rolls_back_every_pg_write_and_reuses_only_private_orphans(self):
        parts, _ = self.add_attachment()
        before = self.source_fingerprint()
        cursor = {"version": 1, "prefix": "ab", "name": "a" * 64}
        self.target.set_meta("attachment_file_gc_cursor", cursor)
        binding, revision = self.target.meta("attachment_file_root"), self.target.meta("_entity_revision")
        original = self.target.chunk_write
        def fail(identity, offset, data):
            if offset:
                raise APIError(503, "Injected copy failure")
            return original(identity, offset, data)
        with patch.object(self.target, "chunk_write", side_effect=fail):
            with self.assertRaises(MigrationError):
                migrate_sqlite(self.source_path, self.target)
        self.assertEqual(self.source_fingerprint(), before)
        self.assertTrue(self.target_is_empty())
        self.assertEqual(self.target.chunk_list("finished"), [])
        self.assertEqual(self.target.meta("attachment_file_root"), binding)
        self.assertEqual(self.target.meta("_entity_revision"), revision)
        self.assertEqual(self.target.meta("attachment_file_gc_cursor"), cursor)
        self.assertTrue(list((self.root / "attachment-files").rglob(hashlib.sha256(parts[0]).hexdigest())))
        result = migrate_sqlite(self.source_path, self.target)
        self.assertEqual(result["chunks"], 2)
        self.assertEqual(self.target.meta("attachment_file_root"), binding)
        self.assertEqual(self.target.meta("_entity_revision"), self.source.meta("_entity_revision"))
        self.assertEqual(self.target.meta("attachment_file_gc_cursor"), cursor)
        self.assertEqual(self.source_fingerprint(), before)

    def test_corrupt_finalized_bytes_are_rejected_before_target_visibility(self):
        self.add_attachment()
        with self.source.transaction():
            rowid = self.source.db.execute("SELECT rowid FROM attachment_chunks WHERE offset=0").fetchone()[0]
            with self.source.db.blobopen("attachment_chunks", "data", rowid) as blob:
                blob.write(b"!")
        with self.assertRaises(MigrationError):
            migrate_sqlite(self.source_path, self.target)
        self.assertTrue(self.target_is_empty())


if __name__ == "__main__":
    unittest.main()
