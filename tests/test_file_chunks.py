"""POSIX durability/security tests using isolated real PostgreSQL workspaces."""
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from fountain.core import APIError
from fountain.file_chunks import CHUNK_SIZE, FileChunkStorage, MARKER
from fountain.postgres import PostgresStore


@unittest.skipUnless(os.environ.get("FOUNTAIN_TEST_POSTGRES_DSN"),
                     "Real PostgreSQL file verification requires FOUNTAIN_TEST_POSTGRES_DSN")
class FileChunkTests(unittest.TestCase):
    def setUp(self):
        self.namespace = uuid.uuid4().hex
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "files"
        self.stores = []
        self.addCleanup(self.cleanup)
        self.store = self.open()

    def open(self, *, root=None, namespace=None):
        store = PostgresStore(os.environ["FOUNTAIN_TEST_POSTGRES_DSN"],
                              workspace_id=namespace or self.namespace,
                              attachment_root=self.root if root is None else root)
        self.stores.append(store)
        return store

    def cleanup(self):
        try:
            for namespace, store in {s.workspace_id: s for s in self.stores}.items():
                with store.transaction():
                    for table in ("attachment_chunks", "entities", "meta"):
                        store._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s", (namespace,))
        finally:
            for store in self.stores: store.close()
            self.temp.cleanup()

    def blob(self, data):
        digest = hashlib.sha256(data).hexdigest()
        return self.root / hashlib.sha256(self.namespace.encode()).hexdigest() / digest[:2] / digest

    def age(self, path):
        old = time.time() - 90000
        os.utime(path, (old, old))

    def test_immutable_manifest_dedup_bounded_range_and_permissions(self):
        data = b"sample chunk" * 5000
        self.store.chunk_write("first", 0, data)
        self.store.chunk_write("second", CHUNK_SIZE, data)
        self.assertEqual(self.store.chunk_info("first", 0), (len(data), "blob"))
        self.assertEqual(self.store.chunk_read_range("first", 0, 5, 65536), data[5:5 + 65536])
        self.assertEqual(self.store.chunk_read_range("first", 0, len(data) + 2, 10), b"")
        self.assertEqual(len(list(self.root.rglob(hashlib.sha256(data).hexdigest()))), 1)
        self.assertEqual(self.blob(data).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.blob(data).parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(APIError) as caught: self.store.chunk_write("first", 0, data)
        self.assertEqual(caught.exception.status, 409)
        with self.assertRaises(APIError): self.store.chunk_read_range("first", 0, 0, CHUNK_SIZE + 1)
        with self.assertRaises(APIError): self.store.chunk_write("first", 1, b"unaligned")
        with self.assertRaises(APIError): self.store.chunk_write("first", 0, b"x" * (CHUNK_SIZE + 1))

    def test_hash_into_reads_full_chunk_and_tail_bounded_with_one_manifest_each(self):
        first, tail = bytes(range(256)) * (CHUNK_SIZE // 256), "가족 첨부😀".encode()
        self.store.chunk_write("file", 0, first)
        self.store.chunk_write("file", CHUNK_SIZE, tail)
        files, digest = self.store._files, hashlib.sha256(b"prefix")
        read = os.read
        requested = []
        def bounded_read(descriptor, length):
            requested.append(length)
            self.assertLessEqual(length, 65536)
            return read(descriptor, length)
        with patch.object(files, "_manifest", wraps=files._manifest) as manifests:
            with patch("fountain.file_chunks.os.read", side_effect=bounded_read):
                with self.store.transaction():
                    self.assertTrue(files.hash_into("file", 0, len(first), digest))
                    self.assertTrue(files.hash_into("file", CHUNK_SIZE, len(tail), digest))
            self.assertEqual(manifests.call_count, 2)
        self.assertEqual(digest.hexdigest(), hashlib.sha256(b"prefix" + first + tail).hexdigest())
        self.assertIn(65536, requested)

    def test_hash_into_only_returns_false_for_absent_manifest_and_rejects_corruption(self):
        files, digest = self.store._files, hashlib.sha256()
        self.assertFalse(files.hash_into("absent", 0, 10, digest))
        self.assertEqual(digest.hexdigest(), hashlib.sha256().hexdigest())
        data = b"checksum protected file bytes"
        self.store.chunk_write("file", 0, data)
        with self.assertRaises(APIError) as caught: files.hash_into("file", 0, len(data) - 1, hashlib.sha256())
        self.assertEqual(caught.exception.status, 409)
        blob = self.blob(data)
        blob.write_bytes(b"!" * len(data))
        with self.assertRaises(APIError) as caught: files.hash_into("file", 0, len(data), hashlib.sha256())
        self.assertEqual(caught.exception.status, 409)
        blob.write_bytes(b"truncated")
        with self.assertRaises(APIError) as caught: files.hash_into("file", 0, len(data), hashlib.sha256())
        self.assertEqual(caught.exception.status, 409)
        blob.unlink()
        with self.assertRaises(APIError): files.hash_into("file", 0, len(data), hashlib.sha256())
        self.assertIsNotNone(files.info("file", 0))

    def test_rollback_only_leaves_unreferenced_bytes_and_gc_waits_one_day(self):
        data = b"rollback bytes"
        before = self.store.meta("_entity_revision", 0)
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.chunk_write("rollback", 0, data)
                raise RuntimeError("abort")
        self.assertIsNone(self.store.chunk_info("rollback", 0))
        self.assertIsNone(self.store.chunk_read_range("rollback", 0, 0, 10))
        self.assertEqual(self.store.meta("_entity_revision", 0), before)
        self.assertTrue(self.blob(data).exists())
        self.assertEqual(self.store.file_garbage_collect()["removed"], 0)
        self.age(self.blob(data))
        self.assertEqual(self.store.file_garbage_collect()["removed"], 1)
        self.assertFalse(self.blob(data).exists())

    def test_reference_delete_never_unlinks_and_gc_preserves_shared_content(self):
        data = b"shared bytes"
        self.store.chunk_write("first", 0, data)
        self.store.chunk_write("second", 0, data)
        self.age(self.blob(data))
        self.assertEqual(self.store.chunk_delete("first"), 1)
        self.assertTrue(self.blob(data).exists())
        self.assertEqual(self.store.file_garbage_collect()["removed"], 0)
        self.assertEqual(self.store.chunk_delete("second"), 1)
        self.assertTrue(self.blob(data).exists())
        self.assertEqual(self.store.file_garbage_collect()["removed"], 1)
        self.assertEqual(self.store.chunk_delete("second"), 0)

    def test_gc_cannot_unlink_reference_deleted_inside_a_rollbackable_transaction(self):
        data = b"reference restored by rollback"
        self.store.chunk_write("retained", 0, data)
        self.age(self.blob(data))
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.chunk_delete("retained")
                with self.assertRaises(APIError) as caught: self.store.file_garbage_collect()
                self.assertEqual(caught.exception.status, 409)
                raise RuntimeError("restore the reference")
        self.assertEqual(self.store.chunk_read_range("retained", 0, 0, len(data)), data)

    def test_fsync_failure_cannot_publish_manifest_or_expose_missing_file(self):
        data = b"must be durable first"
        with patch("fountain.file_chunks.os.fsync", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(APIError): self.store.chunk_write("failure", 0, data)
        self.assertIsNone(self.store.chunk_info("failure", 0))
        self.assertEqual(self.store.list("attachment_chunk"), [])
        self.store.chunk_write("failure", 0, data)
        self.assertEqual(self.store.chunk_read_range("failure", 0, 0, len(data)), data)

    def test_database_insert_failure_leaves_only_private_orphan(self):
        data = b"manifest insert rejected"
        execute = self.store._execute
        def failing(statement, parameters=(), **options):
            if statement.startswith("INSERT INTO fountain_private.entities"):
                raise APIError(503, "simulated SQL failure")
            return execute(statement, parameters, **options)
        with patch.object(self.store, "_execute", side_effect=failing):
            with self.assertRaises(APIError): self.store.chunk_write("failure", 0, data)
        self.assertTrue(self.blob(data).is_file())
        self.assertIsNone(self.store.chunk_info("failure", 0))
        self.store.chunk_write("retry", 0, data)
        self.assertEqual(self.store.chunk_read_range("retry", 0, 0, len(data)), data)

    def test_failed_publish_directory_fsync_is_repeated_before_orphan_reuse(self):
        data = b"directory durability retry"
        fsync = os.fsync
        calls = []
        def fail_after_publish(descriptor):
            calls.append(descriptor)
            if len(calls) == 3: raise OSError("directory fsync failed after link")
            return fsync(descriptor)
        with patch("fountain.file_chunks.os.fsync", side_effect=fail_after_publish):
            with self.assertRaises(APIError): self.store.chunk_write("failed", 0, data)
        self.assertTrue(self.blob(data).exists())
        self.assertIsNone(self.store.chunk_info("failed", 0))
        with patch("fountain.file_chunks.os.fsync", wraps=fsync) as durability:
            self.store.chunk_write("retry", 0, data)
            self.assertEqual(durability.call_count, 2, "Existing bytes and parent directory must both be durable")

    def test_missing_truncated_and_symlink_files_fail_without_bytea_fallback(self):
        data = b"original bytes"
        self.store.chunk_write("file", 0, data)
        blob = self.blob(data)
        blob.write_bytes(b"short")
        with self.assertRaises(APIError): self.store.chunk_read_range("file", 0, 0, len(data))
        blob.unlink()
        self.assertEqual(self.store.chunk_info("file", 0), (len(data), "blob"))
        with self.assertRaises(APIError): self.store.chunk_read_range("file", 0, 0, len(data))
        os.mkfifo(blob, 0o600)
        with self.assertRaises(APIError): self.store.chunk_read_range("file", 0, 0, len(data))
        blob.unlink()
        outside = Path(self.temp.name).resolve() / "outside"
        outside.write_bytes(data)
        outside.chmod(0o600)
        blob.symlink_to(outside)
        with self.assertRaises(APIError): self.store.chunk_read_range("file", 0, 0, len(data))
        with self.assertRaises(APIError): self.store.chunk_write("other", 0, data)
        self.assertEqual(outside.read_bytes(), data)

    def test_existing_hash_must_have_same_length_and_checksum(self):
        data = b"digest protected bytes"
        self.store.chunk_write("first", 0, data)
        self.blob(data).write_bytes(b"!" * len(data))
        with self.assertRaises(APIError) as caught: self.store.chunk_write("second", 0, data)
        self.assertEqual(caught.exception.status, 409)
        self.assertIsNone(self.store.chunk_info("second", 0))

    def test_wrong_root_marker_and_symlink_ancestors_are_rejected(self):
        reopened = self.open()
        self.assertEqual(reopened._files.root_id, self.store._files.root_id)
        with self.assertRaises(APIError): self.open(root=Path(self.temp.name).resolve() / "empty")
        alias = Path(self.temp.name).resolve() / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(APIError): self.open(root=alias)
        parent_alias = Path(self.temp.name).resolve() / "parent-alias"
        parent_alias.symlink_to(self.root.parent, target_is_directory=True)
        with self.assertRaises(APIError): self.open(root=parent_alias / "files")
        marker = self.root / MARKER
        original = marker.read_bytes()
        marker.write_bytes(b'{"version":1,"id":"invalid"}')
        try:
            with self.assertRaises(APIError): self.open()
            with self.assertRaises(APIError): self.store.chunk_write("changed", 0, b"bytes")
        finally: marker.write_bytes(original)

    def test_shared_root_is_namespaced_and_gc_never_removes_other_workspace(self):
        data = b"same bytes different workspace"
        other = self.open(namespace=uuid.uuid4().hex)
        self.store.chunk_write("first", 0, data)
        other.chunk_write("first", 0, data)
        other_blob = self.root / hashlib.sha256(other.workspace_id.encode()).hexdigest() / hashlib.sha256(data).hexdigest()[:2] / hashlib.sha256(data).hexdigest()
        self.store.chunk_delete("first")
        self.age(self.blob(data))
        self.age(other_blob)
        self.assertEqual(self.store.file_garbage_collect()["removed"], 1)
        self.assertTrue(other_blob.exists())
        self.assertEqual(other.chunk_read_range("first", 0, 0, len(data)), data)

    def test_gc_waits_for_other_writer_and_rechecks_its_committed_reference(self):
        data = b"old orphan reused while GC waits"
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.chunk_write("rollback", 0, data)
                raise RuntimeError("orphan")
        self.age(self.blob(data))
        other = self.open()
        begun, done, errors = threading.Event(), threading.Event(), []
        def collect():
            begun.set()
            try: other.file_garbage_collect()
            except BaseException as error: errors.append(error)
            finally: done.set()
        with self.store.transaction():
            self.store.chunk_write("retained", 0, data)
            thread = threading.Thread(target=collect)
            thread.start()
            self.assertTrue(begun.wait(2))
            self.assertFalse(done.wait(0.2), "Collector must wait for the workspace writer")
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(self.blob(data).exists())
        self.assertEqual(other.chunk_read_range("retained", 0, 0, len(data)), data)

    def test_gc_limit_and_old_temporary_files(self):
        for index in range(3):
            data = f"orphan {index}".encode()
            with self.assertRaises(RuntimeError):
                with self.store.transaction():
                    self.store.chunk_write(str(index), 0, data)
                    raise RuntimeError("rollback")
            self.age(self.blob(data))
        result = self.store.file_garbage_collect(limit=2)
        self.assertEqual(result, {"removed": 2, "scanned": 2})
        self.assertEqual(sum(self.store.file_garbage_collect()["removed"] for _ in range(2)), 1)
        prefix = self.blob(b"orphan 0").parent
        old = prefix / (".tmp-" + uuid.uuid4().hex)
        young = prefix / (".tmp-" + uuid.uuid4().hex)
        old.write_bytes(b"abandoned publication")
        young.write_bytes(b"new publication")
        self.age(old)
        self.assertEqual(sum(self.store.file_garbage_collect()["removed"] for _ in range(2)), 1)
        self.assertFalse(old.exists())
        self.assertTrue(young.exists())

    def test_bounded_gc_continues_past_live_references_on_repeated_calls(self):
        for index in range(4):
            data = f"retained or orphan {index}".encode()
            self.store.chunk_write(str(index), 0, data)
            self.age(self.blob(data))
        self.store.chunk_delete("3")
        removed = sum(self.store.file_garbage_collect(limit=1)["removed"] for _ in range(10))
        self.assertEqual(removed, 1)
        for index in range(3): self.assertIsNotNone(self.store.chunk_info(str(index), 0))

    def test_gc_cursor_survives_new_connections_with_live_hash_before_orphan(self):
        values = [f"ordered content {index}".encode() for index in range(2)]
        values.sort(key=lambda value: hashlib.sha256(value).hexdigest())
        for identity, data in zip(("retained", "orphan"), values):
            self.store.chunk_write(identity, 0, data)
            self.age(self.blob(data))
        self.store.chunk_delete("orphan")
        self.assertEqual(self.store.file_garbage_collect(limit=1), {"removed": 0, "scanned": 1})
        self.assertIsInstance(self.store.meta("attachment_file_gc_cursor"), dict)
        reopened = self.open()
        self.assertEqual(reopened.file_garbage_collect(limit=1), {"removed": 1, "scanned": 1})
        self.assertTrue(self.blob(values[0]).exists())
        self.assertFalse(self.blob(values[1]).exists())
