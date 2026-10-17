"""Portable backup checks against a disposable real PostgreSQL namespace."""
import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

from fountain.backup import BackupError, CHUNK_SIZE, PROVENANCE_COLUMNS, inspect_backup, restore_backup, _provenance_provisioned
from fountain.core import Store
from fountain.postgres import PostgresStore
from fountain.postgres_backup import create_postgres_backup


class BackupDestinationTests(unittest.TestCase):
    def test_existing_file_and_symlink_are_rejected_without_database_access(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "existing.db"
            existing.write_bytes(b"keep existing bytes")
            link = Path(directory) / "link.db"
            link.symlink_to(existing)
            for destination in (existing, link):
                with self.assertRaises(BackupError):
                    create_postgres_backup(None, destination)
            self.assertEqual(existing.read_bytes(), b"keep existing bytes")
            with self.assertRaises(BackupError):
                create_postgres_backup(None, Path(directory) / "missing" / "snapshot.db")


@unittest.skipUnless(os.environ.get("FOUNTAIN_TEST_POSTGRES_DSN"),
                     "Real PostgreSQL backup verification requires FOUNTAIN_TEST_POSTGRES_DSN")
class PostgresBackupTests(unittest.TestCase):
    def setUp(self):
        self.namespace = uuid.uuid4().hex
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.stores = []
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.cleanup_workspace)
        self.store = self.open_store()

    def open_store(self, namespace=None):
        store = PostgresStore(os.environ["FOUNTAIN_TEST_POSTGRES_DSN"],
                              workspace_id=namespace or self.namespace,
                              attachment_root=getattr(self, "attachment_root", None))
        self.stores.append(store)
        return store

    def cleanup_workspace(self):
        try:
            for namespace, store in {s.workspace_id: s for s in self.stores}.items():
                with store.transaction():
                    for table in ("attachment_chunks", "entities", "meta"):
                        store._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s", (namespace,))
                    if _provenance_provisioned(store):
                        # Source deletion triggers invalidate private state;
                        # remove that state only after every source/cache row.
                        for table in ('content_search_chunks', 'content_provenance',
                                      'content_search_documents', 'content_search_state'):
                            store._execute('DELETE FROM fountain_private.'+table+' WHERE workspace_id=%s', (namespace,))
        finally:
            for store in self.stores:
                store.close()

    def fixture(self):
        payloads = [b"\x00\xff" * (CHUNK_SIZE // 2), "가족 파일😀".encode() * 7000]
        digest = hashlib.sha256(b"".join(payloads)).hexdigest()
        self.store.put("page", {"id": "page", "title": "가족 문서"})
        self.store.put("member", {"id": "member", "name": "가족"})
        self.store.put("credential", {"id": "member", "salt": "restore-salt", "password_hash": "restore-hash"})
        self.store.put("attachment", {"id": "file", "storage": "chunks", "size": sum(map(len, payloads)), "sha256": digest})
        offset = 0
        for data in payloads:
            self.store.chunk_write("file", offset, data)
            offset += len(data)
        self.store.chunk_write("unfinished", 0, b"unfinished-byte-marker")
        for kind in ("session", "clipboard", "upload", "presence"):
            self.store.put(kind, {"id": "private-" + kind, "secret": "private-byte-marker-" + kind})
        self.store.set_meta("local_cache_binding", "private-browser-binding")
        self.store.set_meta("workspace_id", self.namespace)
        self.store.set_meta("settings", {"family": [1, True, None, "우리집"]})
        return payloads

    def test_real_export_restore_bytes_timestamps_revision_and_private_absence(self):
        payloads = self.fixture()
        other = self.open_store(uuid.uuid4().hex)
        other.put("page", {"id": "other-workspace", "title": "not part of this backup"})
        revision = self.store.meta("_entity_revision")
        backup, restored = self.root / "snapshot.db", self.root / "restored.db"
        counts = create_postgres_backup(self.store, backup)
        self.assertEqual(counts, {"attachment": 1, "credential": 1, "member": 1, "page": 1})
        self.assertEqual(inspect_backup(backup), counts)
        self.assertEqual(restore_backup(backup, restored), counts)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.meta("_entity_revision"), revision)
        target = Store(restored)
        try:
            for kind in counts:
                self.assertEqual(target.list(kind), self.store.list(kind))
            self.assertEqual(target.meta("_entity_revision"), revision)
            self.assertEqual(target.meta("workspace_id"), self.namespace)
            self.assertEqual(target.meta("settings"), self.store.meta("settings"))
            self.assertIsNone(target.meta("local_cache_binding"))
            self.assertIsNone(target.get("page", "other-workspace"))
            rows = target.db.execute("SELECT data FROM attachment_chunks WHERE attachment_id='file' ORDER BY offset").fetchall()
            self.assertEqual([row[0] for row in rows], payloads)
            self.assertEqual(target.db.execute("SELECT count(*) FROM attachment_chunks WHERE attachment_id='unfinished'").fetchone()[0], 0)
        finally:
            target.close()
        contents = backup.read_bytes()
        for kind in ("session", "clipboard", "upload", "presence"):
            self.assertNotIn(("private-byte-marker-" + kind).encode(), contents)
            self.assertIsNotNone(self.store.get(kind, "private-" + kind))
        self.assertNotIn(b"private-browser-binding", contents)
        self.assertNotIn(b"unfinished-byte-marker", contents)
        self.assertFalse(list(self.root.glob(".fountain-*")))

    def test_independent_writer_waits_for_complete_snapshot(self):
        self.fixture()
        writer = self.open_store()
        attempted, complete = threading.Event(), threading.Event()
        errors, threads = [], []
        import fountain.postgres_backup as module
        original = module._rows
        def change():
            attempted.set()
            try:
                with writer.transaction():
                    writer.put("page", {"id": "page", "title": "after snapshot"})
                    writer.set_meta("settings", {"after": True})
            except BaseException as error:
                errors.append(error)
            finally:
                complete.set()
        def rows(store, statement, **options):
            yield from original(store, statement, **options)
            if "FROM fountain_private.entities " in statement:
                thread = threading.Thread(target=change, daemon=True)
                threads.append(thread)
                thread.start()
                self.assertTrue(attempted.wait(5))
                self.assertFalse(complete.wait(0.25), "Writer entered a locked backup snapshot")
        backup = self.root / "consistent.db"
        before_revision = self.store.meta("_entity_revision")
        try:
            with patch.object(module, "_rows", side_effect=rows):
                create_postgres_backup(self.store, backup)
        finally:
            for thread in threads:
                thread.join(15)
        self.assertTrue(complete.is_set())
        if errors: raise errors[0]
        restored = self.root / (backup.stem + "-restored.db")
        restore_backup(backup, restored)
        target = Store(restored)
        try:
            self.assertEqual(target.get("page", "page")["title"], "가족 문서")
            self.assertEqual(target.meta("settings"), {"family": [1, True, None, "우리집"]})
            self.assertEqual(target.meta("_entity_revision"), before_revision)
        finally:
            target.close()
        self.assertEqual(self.store.get("page", "page")["title"], "after snapshot")

    def test_failed_export_and_validation_remove_all_temporary_files(self):
        self.fixture()
        destination = self.root / "failed.db"
        import fountain.postgres_backup as module
        with patch.object(module, "_export", side_effect=sqlite3.OperationalError("private-driver-details")):
            with self.assertRaises(BackupError) as caught:
                create_postgres_backup(self.store, destination)
        self.assertNotIn("private-driver-details", str(caught.exception))
        self.assertFalse(destination.exists())
        self.assertFalse(list(self.root.iterdir()))
        attachment = self.store.get("attachment", "file")
        attachment["sha256"] = "0" * 64
        self.store.put("attachment", attachment)
        with self.assertRaises(BackupError):
            create_postgres_backup(self.store, destination)
        self.assertFalse(list(self.root.iterdir()))
        self.assertIsNotNone(self.store.get("page", "page"))

    def test_publication_race_never_overwrites_another_file(self):
        self.store.put("page", {"id": "page"})
        destination = self.root / "racing.db"
        original = os.link
        def racing_link(source, target):
            Path(target).write_bytes(b"created concurrently")
            return original(source, target)
        with patch("fountain.backup.os.link", side_effect=racing_link):
            with self.assertRaises(BackupError):
                create_postgres_backup(self.store, destination)
        self.assertEqual(destination.read_bytes(), b"created concurrently")
        self.assertEqual(list(self.root.iterdir()), [destination])

    def test_corrupt_oversized_finalized_chunk_is_bounded_and_rejected(self):
        data = b"x" * (CHUNK_SIZE + 1)
        self.store.put("attachment", {"id": "oversized", "storage": "chunks", "size": len(data),
                                      "sha256": hashlib.sha256(data).hexdigest()})
        # Bypass the adapter's normal write limit to exercise corrupt-source
        # defense. The exporter must never fetch the oversized BYTEA in full.
        with self.store.transaction():
            self.store._execute('INSERT INTO fountain_private.attachment_chunks '
                                '(workspace_id,attachment_id,"offset",data) VALUES (%s,%s,0,%s)',
                                (self.namespace, "oversized", data))
        import fountain.postgres_backup as module
        original = module._rows
        observed = []
        def rows(store, statement, **options):
            for row in original(store, statement, **options):
                if "substring(c.data" in statement:
                    observed.append((row[-2], len(row[-1])))
                yield row
        with patch.object(module, "_rows", side_effect=rows):
            with self.assertRaises(BackupError):
                create_postgres_backup(self.store, self.root / "oversized.db")
        self.assertEqual(observed, [(CHUNK_SIZE + 1, CHUNK_SIZE)])
        self.assertFalse(list(self.root.iterdir()))

    def test_server_cursors_bound_batches_and_protect_snapshot_files(self):
        self.fixture()
        import fountain.postgres_backup as module
        original = module._rows
        batches = []
        def rows(store, statement, **options):
            directories = list(self.root.glob(".fountain-postgres-backup-*"))
            self.assertEqual(len(directories), 1)
            self.assertEqual(directories[0].stat().st_mode & 0o777, 0o700)
            self.assertEqual((directories[0] / "workspace.db").stat().st_mode & 0o777, 0o600)
            batches.append(options.get("batch_size", 128))
            for row in original(store, statement, **options):
                if "substring(c.data" in statement:
                    self.assertLessEqual(len(row[-1]), CHUNK_SIZE)
                yield row
        with patch.object(module, "_rows", side_effect=rows):
            create_postgres_backup(self.store, self.root / "bounded.db")
        with sqlite3.connect(self.root / 'bounded.db') as portable:
            has_activity=portable.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='activity_ledgers'").fetchone() is not None
        activity_batches=[128]*4 if has_activity else []
        self.assertIn(batches, ([128,128]+activity_batches+[1], [128,128,128]+activity_batches+[1]))

    def test_private_provenance_exports_without_active_members_or_cursor_secret(self):
        with self.store.transaction():
            if not _provenance_provisioned(self.store):
                self.skipTest('Content provenance migration is not provisioned')
        self.store.put('page', {'id': 'history/가족😀', 'title': '작성 이력'})
        columns = ','.join(PROVENANCE_COLUMNS)
        with self.store.transaction():
            self.store._execute("UPDATE fountain_private.content_provenance SET creator_id='deleted-author',creator_cause='human',"
                                "editor_id='inactive-editor',editor_cause='automation',edited_at='2026-10-17T01:02:03.123456Z',"
                                "manager_id='deleted-manager',manager_at='2026-10-17T04:05:06+09:00' WHERE workspace_id=%s",
                                (self.namespace,))
            history = self.store._execute('SELECT '+columns+' FROM fountain_private.content_provenance WHERE workspace_id=%s',
                                          (self.namespace,), fetch='all')
            secret = self.store._execute('SELECT cursor_secret FROM fountain_private.content_search_state WHERE workspace_id=%s',
                                         (self.namespace,), fetch='one')[0]
        destination = self.root / 'history.db'
        create_postgres_backup(self.store, destination)
        with sqlite3.connect(destination) as connection:
            self.assertEqual(connection.execute('SELECT '+columns+' FROM content_provenance').fetchall(), history)
        self.assertNotIn(secret.encode(), destination.read_bytes())
        restored_path = self.root / "history-restored.db"
        restore_backup(destination, restored_path)
        restored = Store(restored_path)
        try:
            self.assertEqual(restored.db.execute('SELECT '+columns+' FROM content_provenance').fetchall(), history)
        finally:
            restored.close()

    def enable_file_chunks(self):
        self.attachment_root = self.root / "chunks"
        self.store = self.open_store()

    def test_file_chunks_materialize_bytes_deduplicate_and_strip_internal_bindings(self):
        self.enable_file_chunks()
        payloads = self.fixture()
        original = self.store.get("attachment", "file")
        self.store.put("attachment", {**original, "id": "duplicate"})
        offset = 0
        for data in payloads:
            self.store.chunk_write("duplicate", offset, data)
            offset += len(data)
        gc_cursor = {"version": 1, "prefix": "ab", "name": "ab" + "0" * 62}
        self.store.set_meta("attachment_file_gc_cursor", gc_cursor)
        root_binding = self.store.meta("attachment_file_root")
        source_manifests = self.store.list("attachment_chunk")
        revision = self.store.meta("_entity_revision")
        backup = self.root / "files.db"
        with patch.object(self.store, "chunk_read_range", wraps=self.store.chunk_read_range) as read:
            counts = create_postgres_backup(self.store, backup)
        self.assertEqual(read.call_count, 4)
        self.assertEqual([call.args[3] for call in read.call_args_list],
                         [len(data) for data in payloads] * 2)
        self.assertEqual(counts, {"attachment": 2, "credential": 1, "member": 1, "page": 1})
        self.assertEqual(self.store.meta("_entity_revision"), revision)
        self.assertEqual(self.store.list("attachment_chunk"), source_manifests)
        self.assertEqual(self.store.meta("attachment_file_gc_cursor"), gc_cursor)
        restored = self.root / "restored-files.db"
        restore_backup(backup, restored)
        target = Store(restored)
        try:
            self.assertIsNone(target.meta("attachment_file_root"))
            self.assertIsNone(target.meta("attachment_file_gc_cursor"))
            self.assertEqual(target.list("attachment_chunk"), [])
            self.assertEqual(target.meta("_entity_revision"), revision)
            for identity in ("file", "duplicate"):
                actual = target.db.execute("SELECT data FROM attachment_chunks WHERE attachment_id=? ORDER BY offset", (identity,)).fetchall()
                self.assertEqual([row[0] for row in actual], payloads)
                self.assertEqual(target.get("attachment", identity), self.store.get("attachment", identity))
        finally:
            target.close()
        # Two attachments sharing bytes retain independent manifests while the
        # disk contains exactly one immutable blob for each content digest.
        for data in payloads:
            digest = hashlib.sha256(data).hexdigest()
            self.assertEqual(len(list(self.attachment_root.rglob(digest))), 1)
        contents = backup.read_bytes()
        for manifest in source_manifests:
            self.assertNotIn(manifest["id"].encode(), contents)
        self.assertNotIn(b"attachment_file_root", contents)
        self.assertNotIn(b"attachment_file_gc_cursor", contents)
        self.assertNotIn(root_binding["id"].encode(), contents)
        self.assertNotIn(str(self.attachment_root).encode(), contents)

    def test_one_attachment_combines_legacy_bytea_with_file_chunks(self):
        first, tail = b"legacy" * (CHUNK_SIZE // 6) + b"xy" * 2, b"file-backed-tail"
        self.assertEqual(len(first), CHUNK_SIZE)
        self.store.chunk_write("mixed", 0, first)
        self.enable_file_chunks()
        self.store.chunk_write("mixed", CHUNK_SIZE, tail)
        self.store.put("attachment", {"id": "mixed", "storage": "chunks", "size": len(first) + len(tail),
                                      "sha256": hashlib.sha256(first + tail).hexdigest()})
        backup = self.root / "mixed.db"
        self.assertEqual(create_postgres_backup(self.store, backup), {"attachment": 1})
        restored = self.root / (backup.stem + "-restored.db")
        restore_backup(backup, restored)
        target = Store(restored)
        try:
            rows = target.db.execute("SELECT data FROM attachment_chunks ORDER BY offset").fetchall()
            self.assertEqual([row[0] for row in rows], [first, tail])
        finally:
            target.close()

    def test_missing_and_same_length_corrupt_file_abort_backup_without_leftovers(self):
        self.enable_file_chunks()
        payloads = self.fixture()
        path = next(self.attachment_root.rglob(hashlib.sha256(payloads[0]).hexdigest()))
        destination = self.root / "corrupt-file.db"
        source_manifests = self.store.list("attachment_chunk")
        revision = self.store.meta("_entity_revision")
        saved = path.read_bytes()
        path.unlink()
        with self.assertRaises(BackupError):
            create_postgres_backup(self.store, destination)
        self.assertFalse(destination.exists())
        self.assertFalse(list(self.root.glob(".fountain-*")))
        path.write_bytes(b"x" * len(saved))
        path.chmod(0o600)
        with self.assertRaises(BackupError):
            create_postgres_backup(self.store, destination)
        self.assertFalse(destination.exists())
        self.assertFalse(list(self.root.glob(".fountain-*")))
        self.assertEqual(self.store.list("attachment_chunk"), source_manifests)
        self.assertEqual(self.store.meta("_entity_revision"), revision)

    def test_file_backup_rejects_wrong_type_and_truncated_helper_results(self):
        self.enable_file_chunks()
        self.fixture()
        destination = self.root / "invalid-helper.db"
        with patch.object(self.store, "chunk_info", return_value=(CHUNK_SIZE, "text")):
            with self.assertRaises(BackupError):
                create_postgres_backup(self.store, destination)
        with patch.object(self.store, "chunk_read_range", return_value=b"truncated"):
            with self.assertRaises(BackupError):
                create_postgres_backup(self.store, destination)
        self.assertFalse(destination.exists())
        self.assertFalse(list(self.root.glob(".fountain-*")))

    def test_file_backup_fences_independent_writer_for_entire_snapshot(self):
        self.enable_file_chunks()
        self.test_independent_writer_waits_for_complete_snapshot()


if __name__ == "__main__":
    unittest.main()
