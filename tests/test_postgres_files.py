"""Real PostgreSQL integration for optional disk chunks and legacy BYTEA data."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from fountain.attachments import CHUNK_SIZE, FileStorage
from fountain.core import APIError
from fountain.postgres import PostgresStore


@unittest.skipUnless(os.environ.get("FOUNTAIN_TEST_POSTGRES_DSN"),
                     "Real PostgreSQL file verification requires FOUNTAIN_TEST_POSTGRES_DSN")
class PostgresFileTests(unittest.TestCase):
    def setUp(self):
        self.namespace = uuid.uuid4().hex
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.stores = []
        self.addCleanup(self.cleanup)
        self.legacy = self.open_store()

    def open_store(self, attachment_root=None):
        store = PostgresStore(os.environ["FOUNTAIN_TEST_POSTGRES_DSN"],
                              workspace_id=self.namespace, attachment_root=attachment_root)
        self.stores.append(store)
        return store

    def cleanup(self):
        try:
            if self.stores:
                store = next((item for item in reversed(self.stores) if item._files is not None), self.stores[0])
                with store.transaction():
                    for table in ("attachment_chunks", "entities", "meta"):
                        store._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s", (self.namespace,))
        finally:
            for store in self.stores:
                store.close()
            self.temporary.cleanup()

    def test_one_resumable_upload_combines_legacy_bytea_and_new_disk_chunks(self):
        first, tail = b"a" * CHUNK_SIZE, "가족 첨부 파일".encode()
        upload = FileStorage(self.legacy).begin({"name": "mixed.bin", "size": len(first) + len(tail)}, "local")
        FileStorage(self.legacy).append(upload["id"], 0, first, "local")
        disk = self.open_store(self.root)
        files = FileStorage(disk)
        files.append(upload["id"], CHUNK_SIZE, tail, "local")
        attachment = files.complete(upload["id"], "local")
        self.assertEqual(attachment["sha256"], hashlib.sha256(first + tail).hexdigest())
        self.assertEqual(disk.chunk_list(upload["id"]), [(0, len(first), "blob"), (CHUNK_SIZE, len(tail), "blob")])
        self.assertEqual(disk.chunk_info(upload["id"], 0), (len(first), "blob"))
        self.assertEqual(disk.chunk_info(upload["id"], CHUNK_SIZE), (len(tail), "blob"))
        self.assertEqual(b"".join(files.iter_bytes(upload["id"], CHUNK_SIZE - 3, CHUNK_SIZE + len(tail))), first[-3:] + tail)
        manifests = disk.list("attachment_chunk")
        self.assertEqual(len(manifests), 1)
        self.assertEqual(manifests[0]["sha256"], hashlib.sha256(tail).hexdigest())
        with disk.transaction():
            legacy_offsets = disk._execute('SELECT "offset" FROM fountain_private.attachment_chunks '
                                           'WHERE workspace_id=%s AND attachment_id=%s',
                                           (self.namespace, upload["id"]), fetch="all")
        self.assertEqual(legacy_offsets, [(0,)])
        reopened = self.open_store(self.root)
        self.assertEqual(reopened.chunk_read_range(upload["id"], CHUNK_SIZE, 0, len(tail)), tail)

    def test_disk_chunk_and_upload_offset_roll_back_together(self):
        disk = self.open_store(self.root)
        revision = disk.meta("_entity_revision", 0)
        with self.assertRaises(ValueError):
            with disk.transaction():
                disk.chunk_write("rolled-back", 0, b"uncommitted chunk")
                disk.put("upload", {"id": "rolled-back", "offset": 17})
                raise ValueError("rollback the manifest and metadata")
        self.assertEqual(disk.chunk_list("rolled-back"), [])
        self.assertIsNone(disk.chunk_info("rolled-back", 0))
        self.assertIsNone(disk.get("upload", "rolled-back"))
        self.assertEqual(disk.meta("_entity_revision", 0), revision)
        orphan_digest = hashlib.sha256(b"uncommitted chunk").hexdigest()
        self.assertTrue(list(self.root.rglob(orphan_digest)), "Failed transactions leave only private, unreferenced bytes")

    def test_bytearray_input_preserves_the_existing_chunk_write_contract(self):
        disk = self.open_store(self.root)
        value = bytearray(b"original bytes")
        disk.chunk_write("mutable-input", 0, value)
        value[:] = b"changed bytes!"
        self.assertEqual(disk.chunk_read_range("mutable-input", 0, 0, 14), b"original bytes")

    def test_bound_workspace_requires_the_same_attachment_root_on_reopen(self):
        disk = self.open_store(self.root)
        binding = disk.meta("attachment_file_root")
        self.assertEqual(binding["version"], 1)
        self.assertTrue(binding["id"])
        for root in (None, self.root / "wrong-root"):
            with self.subTest(root_missing=root is None):
                with self.assertRaises(APIError) as caught:
                    self.open_store(root)
                self.assertEqual(caught.exception.status, 503)
        self.assertEqual(self.open_store(self.root).meta("attachment_file_root"), binding)

    def test_even_an_invalid_existing_binding_prevents_implicit_bytea_mode(self):
        self.legacy.set_meta("attachment_file_root", None)
        try:
            with self.assertRaises(APIError) as caught:
                self.open_store()
            self.assertEqual(caught.exception.status, 503)
        finally:
            # Deliberately corrupt fixture cannot pass the normal mode guard.
            with self.legacy.lock, self.legacy._connection.transaction():
                self.legacy._execute("SELECT set_config('fountain.workspace_id',%s,true)", (self.namespace,))
                self.legacy._execute("SELECT pg_advisory_xact_lock(%s)", (self.legacy._lock_key,))
                self.legacy._execute("DELETE FROM fountain_private.meta WHERE workspace_id=%s AND key='attachment_file_root'", (self.namespace,))

    def test_existing_bytea_connection_is_rejected_after_another_connection_binds_disk(self):
        self.legacy.chunk_write("legacy", 0, b"old bytes")
        disk = self.open_store(self.root)
        self.assertEqual(disk.chunk_read_range("legacy", 0, 0, 9), b"old bytes")
        for operation in (lambda: self.legacy.get("upload", "anything"),
                          lambda: self.legacy.chunk_read_range("legacy", 0, 0, 9),
                          lambda: self.legacy.chunk_write("legacy", CHUNK_SIZE, b"new bytes")):
            with self.subTest(operation="stale connection"):
                with self.assertRaises(APIError) as caught:
                    operation()
                self.assertEqual(caught.exception.status, 503)

    def test_duplicate_backend_offsets_fail_listing_and_delete_only_references(self):
        disk = self.open_store(self.root)
        disk.chunk_write("duplicate", 0, b"disk bytes")
        digest = hashlib.sha256(b"disk bytes").hexdigest()
        disk_paths = list(self.root.rglob(digest))
        self.assertTrue(disk_paths)
        # Explicitly create an invalid imported layout inside this test's own
        # namespace; a normal stale legacy writer is rejected by the mode guard.
        with disk.transaction():
            disk._execute('INSERT INTO fountain_private.attachment_chunks(workspace_id,attachment_id,"offset",data) VALUES (%s,%s,%s,%s)',
                          (self.namespace, "duplicate", 0, b"legacy bytes"))
        with self.assertRaises(APIError) as caught:
            disk.chunk_list("duplicate")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(disk.chunk_delete("duplicate"), 2)
        self.assertEqual(disk.chunk_list("duplicate"), [])
        self.assertTrue(all(path.exists() for path in disk_paths), "Deleting references must not unlink shared bytes")
        self.assertEqual(disk.chunk_delete("duplicate"), 0)

    def test_missing_disk_bytes_never_fall_back_to_a_legacy_duplicate(self):
        disk = self.open_store(self.root)
        disk.chunk_write("missing", 0, b"disk bytes")
        with disk.transaction():
            disk._execute('INSERT INTO fountain_private.attachment_chunks(workspace_id,attachment_id,"offset",data) VALUES (%s,%s,%s,%s)',
                          (self.namespace, "missing", 0, b"legacy bytes"))
        digest = hashlib.sha256(b"disk bytes").hexdigest()
        for path in self.root.rglob(digest):
            path.unlink()
        self.assertEqual(disk.chunk_info("missing", 0), (10, "blob"))
        with self.assertRaises(APIError) as caught:
            disk.chunk_read_range("missing", 0, 0, 10)
        self.assertIn(caught.exception.status, (409, 503))

    def test_disk_writer_rejects_legacy_offset_and_garbage_collection_is_explicit(self):
        self.legacy.chunk_write("legacy", 0, b"legacy bytes")
        disk = self.open_store(self.root)
        with self.assertRaises(APIError) as caught:
            disk.chunk_write("legacy", 0, b"changed bytes")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(disk.chunk_read_range("legacy", 0, 0, 12), b"legacy bytes")
        self.assertEqual(disk.file_garbage_collect(limit=1)["removed"], 0)
        with self.assertRaises(APIError) as unavailable:
            self.legacy.file_garbage_collect()
        self.assertEqual(unavailable.exception.status, 503)

    def test_five_mebibyte_completion_uses_per_chunk_manifest_lookups(self):
        disk = self.open_store(self.root)
        files = FileStorage(disk)
        parts = [b"a" * CHUNK_SIZE, b"b" * (1024 * 1024)]
        upload = files.begin({"name": "five-mebibytes.bin", "size": sum(map(len, parts))}, "local")
        for index, data in enumerate(parts):
            files.append(upload["id"], index * CHUNK_SIZE, data, "local")
        with patch.object(disk._files, "_manifest", wraps=disk._files._manifest) as lookup:
            completed = files.complete(upload["id"], "local")
        expected = hashlib.sha256()
        for data in parts: expected.update(data)
        self.assertEqual(completed["sha256"], expected.hexdigest())
        self.assertLessEqual(lookup.call_count, len(parts) + 4,
                             "Completion must not fetch a manifest for every 64 KiB read")

    def test_same_length_file_corruption_rejects_completion_without_finalizing_upload(self):
        disk = self.open_store(self.root)
        files = FileStorage(disk)
        data = b"original bytes" * 10000
        upload = files.begin({"name": "corrupt.bin", "size": len(data)}, "local")
        files.append(upload["id"], 0, data, "local")
        digest = hashlib.sha256(data).hexdigest()
        location = next(self.root.rglob(digest))
        with location.open("r+b") as blob:
            blob.write(b"X")
            blob.flush()
            os.fsync(blob.fileno())
        self.assertEqual(location.stat().st_size, len(data))
        revision = disk.meta("_entity_revision")
        with self.assertRaises(APIError) as caught:
            files.complete(upload["id"], "local")
        self.assertEqual(caught.exception.status, 409)
        self.assertFalse(disk.get("upload", upload["id"])["completed"])
        self.assertIsNone(disk.get("attachment", upload["id"]))
        self.assertEqual(disk.meta("_entity_revision"), revision)

    def test_legacy_chunk_hashing_uses_bounded_range_reads(self):
        data = bytes(range(251)) * 1000
        self.legacy.chunk_write("legacy-hash", 0, data)
        digest = hashlib.sha256()
        with patch.object(self.legacy, "chunk_read_range", wraps=self.legacy.chunk_read_range) as reading:
            self.legacy.chunk_hash_into("legacy-hash", 0, len(data), digest)
        self.assertEqual(digest.hexdigest(), hashlib.sha256(data).hexdigest())
        self.assertGreater(reading.call_count, 1)
        self.assertTrue(all(call.args[3] <= 65536 for call in reading.call_args_list))
        with self.assertRaises(APIError) as caught:
            self.legacy.chunk_hash_into("legacy-hash", 0, len(data) + 1, hashlib.sha256())
        self.assertEqual(caught.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
