"""Complete snapshots keep finalized files and discard resumable upload bytes."""
import base64
import hashlib
import json
import sqlite3
import tempfile
import tracemalloc
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.backup import BackupError, CHUNK_SIZE, DEFINITIONS, create_backup, inspect_backup, restore_backup
from fountain.core import Store


class AttachmentBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "live.db"
        self.store = Store(self.source)
        self.store.db.execute(DEFINITIONS["attachment_chunks"].replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1))
        self.store.db.commit()

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def attachment(self, identity="finished", size=CHUNK_SIZE + 2 * 1024 * 1024 + 17):
        hasher = hashlib.sha256()
        with self.store.transaction():
            for offset in range(0, size, CHUNK_SIZE):
                block = bytes([(offset // CHUNK_SIZE + 23) % 251]) * min(CHUNK_SIZE, size - offset)
                hasher.update(block)
                self.store.db.execute("INSERT INTO attachment_chunks VALUES (?,?,?)", (identity, offset, block))
            self.store.put("attachment", {"id": identity, "name": "가족 영상.bin", "owner_id": "local",
                                          "size": size, "storage": "chunks", "sha256": hasher.hexdigest(),
                                          "mime": "application/octet-stream"})
        return hasher.hexdigest()

    def test_real_multichunk_file_over_five_megabytes_roundtrips_bytes_and_hash(self):
        size = CHUNK_SIZE + 2 * 1024 * 1024 + 17
        expected_hash = self.attachment(size=size)
        self.store.put("upload", {"id": "finished", "completed": True, "offset": size, "size": size})
        backup, restored = self.root / "snapshot.db", self.root / "restored.db"
        counts = create_backup(self.source, backup)
        self.assertEqual(counts, {"attachment": 1})
        self.assertEqual(restore_backup(backup, restored), counts)
        with sqlite3.connect(restored) as connection:
            attachment = json.loads(connection.execute("SELECT data FROM entities WHERE kind='attachment'").fetchone()[0])
            self.assertEqual(attachment["sha256"], expected_hash)
            self.assertEqual(attachment["size"], size)
            self.assertNotIn("data", attachment)
            digest, actual_size = hashlib.sha256(), 0
            for offset, blob in connection.execute("SELECT offset,data FROM attachment_chunks ORDER BY offset"):
                expected = bytes([(offset // CHUNK_SIZE + 23) % 251]) * min(CHUNK_SIZE, size - offset)
                self.assertEqual(blob, expected)
                digest.update(blob)
                actual_size += len(blob)
            self.assertEqual(actual_size, size)
            self.assertEqual(digest.hexdigest(), expected_hash)
            self.assertEqual(connection.execute("SELECT count(*) FROM entities WHERE kind='upload'").fetchone()[0], 0)
        self.assertIsNotNone(self.store.get("upload", "finished"), "completed upload receipts remain in the live workspace")
        self.assertEqual(inspect_backup(backup), counts)

    def test_incomplete_orphan_and_legacy_inline_chunks_are_excluded_without_mutating_source(self):
        self.attachment()
        self.store.put("upload", {"id": "unfinished", "owner_id": "local", "size": CHUNK_SIZE * 3,
                                  "offset": CHUNK_SIZE, "chunk_size": CHUNK_SIZE, "completed": False})
        self.store.put("attachment", {"id": "inline", "name": "old.txt", "size": 3, "data": base64.b64encode(b"old").decode()})
        with self.store.transaction():
            for identity, blob in (("unfinished", b"UNFINISHED-PRIVATE-BYTES"), ("orphan", b"ORPHAN-BYTES"), ("inline", b"WRONG-INLINE-CHUNK")):
                self.store.db.execute("INSERT INTO attachment_chunks VALUES (?,?,?)", (identity, 0, blob))
        self.assertIn("upload", inspect_backup(self.source), "a valid live source may contain partial upload bytes")
        backup = self.root / "clean.db"
        counts = create_backup(self.source, backup)
        self.assertNotIn("upload", counts)
        with sqlite3.connect(backup) as connection:
            self.assertEqual(connection.execute("SELECT DISTINCT attachment_id FROM attachment_chunks").fetchall(), [("finished",)])
            inline = json.loads(connection.execute("SELECT data FROM entities WHERE kind='attachment' AND id='inline'").fetchone()[0])
            self.assertEqual(base64.b64decode(inline["data"]), b"old")
        self.assertIsNotNone(self.store.get("upload", "unfinished"))
        self.assertEqual(self.store.db.execute("SELECT count(DISTINCT attachment_id) FROM attachment_chunks").fetchone()[0], 4)
        self.assertNotIn(b"UNFINISHED-PRIVATE-BYTES", backup.read_bytes())
        self.assertNotIn(b"ORPHAN-BYTES", backup.read_bytes())

    def test_missing_chunk_and_wrong_offsets_are_rejected_before_publication(self):
        self.attachment()
        self.store.db.execute("DELETE FROM attachment_chunks WHERE offset=?", (CHUNK_SIZE,))
        self.store.db.commit()
        with self.assertRaises(BackupError):
            create_backup(self.source, self.root / "missing.db")
        self.assertFalse((self.root / "missing.db").exists())
        self.assertFalse(list(self.root.glob(".fountain-backup-*")))
        self.store.db.execute("UPDATE attachment_chunks SET offset=1")
        self.store.db.commit()
        with self.assertRaises(BackupError):
            inspect_backup(self.source)

    def test_corrupted_chunk_digest_and_manifest_size_are_rejected(self):
        self.attachment()
        rowid = self.store.db.execute("SELECT rowid FROM attachment_chunks WHERE offset=0").fetchone()[0]
        with self.store.db.blobopen("attachment_chunks", "data", rowid) as blob:
            blob.write(b"!")
        with self.assertRaisesRegex(BackupError, "SHA-256"):
            restore_backup(self.source, self.root / "bad-hash.db")
        self.assertFalse((self.root / "bad-hash.db").exists())
        attachment = self.store.get("attachment", "finished")
        attachment["size"] += 1
        self.store.put("attachment", attachment)
        with self.assertRaises(BackupError):
            inspect_backup(self.source)

    def test_short_extra_nonblob_and_malformed_manifests_are_rejected(self):
        for mode in ("short", "extra", "text", "bad-size", "bool-size", "bad-hash"):
            with self.subTest(mode=mode):
                identity = mode
                self.attachment(identity, 3)
                if mode == "short":
                    self.store.db.execute("UPDATE attachment_chunks SET data=? WHERE attachment_id=?", (b"x", identity))
                elif mode == "extra":
                    self.store.db.execute("INSERT INTO attachment_chunks VALUES (?,?,?)", (identity, CHUNK_SIZE, b"x"))
                elif mode == "text":
                    self.store.db.execute("UPDATE attachment_chunks SET data='abc' WHERE attachment_id=?", (identity,))
                else:
                    attachment = self.store.get("attachment", identity)
                    attachment["size" if mode != "bad-hash" else "sha256"] = {"bad-size": 5_000_000_001, "bool-size": True, "bad-hash": "X" * 64}[mode]
                    self.store.put("attachment", attachment)
                self.store.db.commit()
                with self.assertRaises(BackupError):
                    inspect_backup(self.source)
                self.store.db.execute("DELETE FROM attachment_chunks WHERE attachment_id=?", (identity,))
                self.store.db.commit()
                self.store.delete("attachment", identity)

    def test_empty_file_needs_no_chunks_and_preserves_empty_digest(self):
        digest = self.attachment(size=0)
        self.assertEqual(digest, hashlib.sha256(b"").hexdigest())
        destination = self.root / "empty.db"
        self.assertEqual(create_backup(self.source, destination), {"attachment": 1})
        with sqlite3.connect(destination) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM attachment_chunks").fetchone()[0], 0)

    def test_legacy_exact_two_table_backup_still_restores(self):
        legacy = self.root / "legacy.db"
        with sqlite3.connect(legacy) as connection:
            connection.execute(DEFINITIONS["entities"])
            connection.execute(DEFINITIONS["meta"])
            connection.execute("INSERT INTO entities VALUES (?,?,?,?,?)", (
                "attachment", "old", json.dumps({"id": "old", "name": "old.txt", "size": 3, "data": "b2xk"}), "past", "past"))
            connection.execute("INSERT INTO meta VALUES (?,?)", ("workspace_id", json.dumps("legacy-workspace")))
        destination = self.root / "old-restored.db"
        self.assertEqual(inspect_backup(legacy), {"attachment": 1})
        self.assertEqual(restore_backup(legacy, destination), {"attachment": 1})
        with sqlite3.connect(destination) as connection:
            self.assertEqual({row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}, {"entities", "meta"})
            self.assertEqual(json.loads(connection.execute("SELECT data FROM entities").fetchone()[0])["data"], "b2xk")
        store = Store(destination)
        try:
            self.assertEqual(store.get("attachment", "old")["size"], 3)
        finally:
            store.close()

    def test_missing_chunk_table_and_unknown_new_schema_objects_are_rejected(self):
        legacy = self.root / "invalid-legacy.db"
        with sqlite3.connect(legacy) as connection:
            connection.execute(DEFINITIONS["entities"])
            connection.execute(DEFINITIONS["meta"])
            connection.execute("INSERT INTO entities VALUES (?,?,?,?,?)", (
                "attachment", "missing", json.dumps({"id": "missing", "storage": "chunks", "size": 0, "sha256": hashlib.sha256(b"").hexdigest()}), "past", "past"))
        with self.assertRaises(BackupError):
            inspect_backup(legacy)
        for statement in ("CREATE INDEX hidden_chunks ON attachment_chunks(offset)",
                          "CREATE TRIGGER hidden_chunks AFTER INSERT ON attachment_chunks BEGIN DELETE FROM entities; END",
                          "CREATE VIEW hidden_chunks AS SELECT * FROM attachment_chunks"):
            with self.subTest(statement=statement):
                destination = self.root / "unexpected.db"
                create_backup(self.source, destination)
                with sqlite3.connect(destination) as connection:
                    connection.execute(statement)
                with self.assertRaises(BackupError):
                    inspect_backup(destination)
                destination.unlink()

    def test_bounded_sql_slice_reader_supports_connections_without_blobopen(self):
        self.attachment()
        with patch("fountain.backup.hasattr", return_value=False, create=True):
            self.assertEqual(inspect_backup(self.source), {"attachment": 1})

    def test_oversized_corrupt_blob_is_rejected_without_reading_the_whole_blob(self):
        self.attachment(size=3)
        self.store.db.execute("UPDATE attachment_chunks SET data=?", (b"x" * (CHUNK_SIZE + 1),))
        self.store.db.commit()
        tracemalloc.start()
        try:
            with self.assertRaises(BackupError):
                inspect_backup(self.source)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 2 * 1024 * 1024)

    def test_hash_validation_python_memory_is_bounded_by_read_slice_not_file_size(self):
        self.attachment(size=CHUNK_SIZE * 3 + 17)
        tracemalloc.start()
        try:
            inspect_backup(self.source)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 2 * 1024 * 1024, "manifest hashing must not materialize a whole 12 MiB attachment")


if __name__ == "__main__":
    unittest.main()
