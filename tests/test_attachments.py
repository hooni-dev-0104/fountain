import base64
import hashlib
import sqlite3
import tempfile
import threading
import tracemalloc
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fountain.access import Access
from fountain.attachments import CHUNK_SIZE, MAX_FILE_SIZE, READ_SIZE, FileStorage
from fountain.core import APIError, Store, Workspace


class FileStorageTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        Workspace(self.store)
        self.storage = FileStorage(self.store)
        self.access = Access(self.store, self.store.get("member", "local"))

    def tearDown(self):
        self.store.close()

    def begin(self, size, **values):
        return self.storage.begin({"name": "가족 사진.bin", "size": size, **values}, "local", self.access)

    def test_fixed_chunk_upload_complete_retry_and_bounded_range_reads(self):
        first, tail = b"a" * CHUNK_SIZE, b"last chunk!"
        upload = self.begin(len(first) + len(tail))
        identity = upload["id"]
        self.assertEqual(upload["chunk_size"], CHUNK_SIZE)
        self.assertIsNone(self.store.get("attachment", identity))
        self.storage.append(identity, 0, first, "local", self.access)
        self.storage.append(identity, CHUNK_SIZE, tail, "local", self.access)
        self.assertIsNone(self.store.get("attachment", identity))
        metadata = self.storage.complete(identity, "local", self.access)
        self.assertEqual(metadata["id"], identity)
        self.assertEqual(metadata["sha256"], hashlib.sha256(first + tail).hexdigest())
        self.assertEqual(metadata["storage"], "chunks")
        self.assertNotIn("data", metadata)
        self.assertEqual(self.storage.complete(identity, "local", self.access), metadata)
        self.assertEqual(self.storage.status(identity, "local", self.access)["attachment"], metadata)
        pieces = list(self.storage.iter_bytes(identity))
        self.assertTrue(all(0 < len(piece) <= READ_SIZE for piece in pieces))
        self.assertEqual(b"".join(pieces), first + tail)
        self.assertEqual(b"".join(self.storage.iter_bytes(identity, CHUNK_SIZE - 3, CHUNK_SIZE + 4)), b"aaalast")
        self.assertEqual(b"".join(self.storage.iter_bytes(identity, 10, 10)), b"")

    def test_corrupted_oversized_retry_is_rejected_without_loading_the_blob(self):
        upload = self.begin(CHUNK_SIZE)
        content = b'x' * CHUNK_SIZE
        self.storage.append(upload['id'], 0, content, 'local', self.access)
        self.store.db.execute('UPDATE attachment_chunks SET data=zeroblob(?) WHERE attachment_id=?', (32 * 1024 * 1024, upload['id']))
        self.store.db.commit()
        tracemalloc.start()
        try:
            with self.assertRaises(APIError) as error:
                self.storage.append(upload['id'], 0, content, 'local', self.access)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(error.exception.status, 409)
        self.assertLess(peak, 2 * 1024 * 1024)

    def test_store_close_waits_for_active_blob_read(self):
        upload = self.begin(5)
        self.storage.append(upload['id'], 0, b'hello', 'local', self.access)
        rowid = self.store.db.execute('SELECT rowid FROM attachment_chunks').fetchone()[0]
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        failures = []
        def read():
            try:
                with self.store.lock, self.store.db.blobopen('attachment_chunks', 'data', rowid, readonly=True) as blob:
                    self.assertEqual(blob.read(1), b'h')
                    entered.set()
                    self.assertTrue(release.wait(3))
                    self.assertEqual(blob.read(), b'ello')
            except BaseException as error: failures.append(error)
        reader = threading.Thread(target=read)
        reader.start()
        self.assertTrue(entered.wait(2))
        closer = threading.Thread(target=lambda: (self.store.close(), closed.set()))
        closer.start()
        try:
            self.assertFalse(closed.wait(0.05), 'Closing must not invalidate an active BLOB handle')
        finally:
            release.set()
            reader.join(3)
            closer.join(3)
        self.assertEqual(failures, [])
        self.assertTrue(closed.is_set())

    def test_empty_files_and_size_limits(self):
        upload = self.begin(0)
        metadata = self.storage.complete(upload["id"], "local", self.access)
        self.assertEqual(metadata["sha256"], hashlib.sha256(b"").hexdigest())
        self.assertEqual(list(self.storage.iter_bytes(upload["id"])), [])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM attachment_chunks").fetchone()[0], 0)
        self.assertEqual(self.begin(MAX_FILE_SIZE)["size"], MAX_FILE_SIZE)
        for size, status in [(MAX_FILE_SIZE + 1, 413), (-1, 400), (True, 400), (1.5, 400)]:
            with self.subTest(size=size), self.assertRaises(APIError) as error: self.begin(size)
            self.assertEqual(error.exception.status, status)
        self.assertEqual(len(self.store.list("upload")), 2)

    def test_retries_must_match_bytes_and_invalid_gaps_lengths_are_atomic(self):
        upload = self.begin(CHUNK_SIZE + 2)
        identity = upload["id"]
        for offset, data, status in [(CHUNK_SIZE, b"xx", 409), (0, b"short", 400), (1, b"bad", 409)]:
            with self.subTest(offset=offset), self.assertRaises(APIError) as error:
                self.storage.append(identity, offset, data, "local", self.access)
            self.assertEqual(error.exception.status, status)
        first = b"a" * CHUNK_SIZE
        accepted = self.storage.append(identity, 0, first, "local", self.access)
        self.assertEqual(self.storage.append(identity, 0, first, "local", self.access), accepted)
        with self.assertRaises(APIError) as error: self.storage.append(identity, 0, b"b" * CHUNK_SIZE, "local", self.access)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.storage.status(identity, "local", self.access)["offset"], CHUNK_SIZE)
        with self.assertRaises(APIError) as error: self.storage.complete(identity, "local", self.access)
        self.assertEqual(error.exception.status, 409)
        self.assertIsNone(self.store.get("attachment", identity))

    def test_rollback_rolls_back_both_blob_and_upload_offset_and_finalize_metadata(self):
        identity = self.begin(4)["id"]
        real_put = self.store.put
        def fail_upload(kind, data):
            if kind == "upload": raise RuntimeError("simulated metadata failure")
            return real_put(kind, data)
        with patch.object(self.store, "put", side_effect=fail_upload):
            with self.assertRaises(RuntimeError): self.storage.append(identity, 0, b"data", "local", self.access)
        self.assertEqual(self.storage.status(identity, "local", self.access)["offset"], 0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM attachment_chunks").fetchone()[0], 0)
        self.storage.append(identity, 0, b"data", "local", self.access)
        with patch.object(self.store, "put", side_effect=fail_upload):
            with self.assertRaises(RuntimeError): self.storage.complete(identity, "local", self.access)
        self.assertIsNone(self.store.get("attachment", identity))
        self.assertFalse(self.storage.status(identity, "local", self.access)["completed"])
        self.assertEqual(self.storage.complete(identity, "local", self.access)["size"], 4)

    def test_expiry_cancel_and_cleanup_never_delete_finalized_chunks(self):
        incomplete = self.begin(CHUNK_SIZE + 1)
        self.storage.append(incomplete["id"], 0, b"x" * CHUNK_SIZE, "local", self.access)
        completed = self.begin(1)
        self.storage.append(completed["id"], 0, b"y", "local", self.access)
        self.storage.complete(completed["id"], "local", self.access)
        self.assertFalse(self.storage.cancel(completed["id"], "local", self.access)["cancelled"])
        self.assertEqual(b"".join(self.storage.iter_bytes(completed["id"])), b"y")
        for upload in self.store.list("upload"):
            upload["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            self.store.put("upload", upload)
        with self.assertRaises(APIError) as error: self.storage.status(incomplete["id"], "local", self.access)
        self.assertEqual(error.exception.status, 410)
        with self.assertRaises(APIError): self.storage.cleanup(datetime.now())
        self.assertEqual(len(self.store.list("upload")), 2)
        self.assertEqual(self.storage.cleanup()["removed"], 2)
        self.assertEqual(b"".join(self.storage.iter_bytes(completed["id"])), b"y")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM attachment_chunks WHERE attachment_id=?", (incomplete["id"],)).fetchone()[0], 0)
        fresh = self.begin(1)
        self.storage.append(fresh["id"], 0, b"z", "local", self.access)
        self.assertTrue(self.storage.cancel(fresh["id"], "local", self.access)["cancelled"])
        self.assertIsNone(self.store.get("upload", fresh["id"]))

    def test_members_and_original_page_are_rechecked_on_every_mutation_and_receipt_retry(self):
        self.store.put("member", {"id": "family", "name": "Family", "email": "family@example.com", "role": "member"})
        family = Access(self.store, self.store.get("member", "family"))
        upload = self.storage.begin({"name": "note.txt", "size": 1, "page_id": "welcome"}, "family", family)
        with self.assertRaises(APIError) as error: self.storage.status(upload["id"], "local", self.access)
        self.assertEqual(error.exception.status, 404)
        page = self.store.get("page", "welcome")
        page["locked"] = True
        self.store.put("page", page)
        with self.assertRaises(APIError) as error: self.storage.append(upload["id"], 0, b"x", "family", family)
        self.assertEqual(error.exception.status, 423)
        page["locked"] = False
        self.store.put("page", page)
        self.storage.append(upload["id"], 0, b"x", "family", family)
        self.storage.complete(upload["id"], "family", family)
        page["permissions"] = {"default": "private", "members": {}, "groups": {}, "inherit": False}
        self.store.put("page", page)
        with self.assertRaises(APIError): self.storage.complete(upload["id"], "family", family)
        member = self.store.get("member", "family")
        member["active"] = False
        self.store.put("member", member)
        with self.assertRaises(APIError): self.storage.status(upload["id"], "family", family)

    def test_guests_need_editable_page_and_owner_can_clean_other_incomplete_upload(self):
        self.store.put("member", {"id": "guest", "name": "Guest", "email": "guest@example.com", "role": "guest"})
        guest = Access(self.store, self.store.get("member", "guest"))
        with self.assertRaises(APIError): self.storage.begin({"name": "x", "size": 1}, "guest", guest)
        page = self.store.get("page", "welcome")
        page["permissions"] = {"default": "private", "members": {"guest": "edit"}, "groups": {}, "inherit": False}
        self.store.put("page", page)
        upload = self.storage.begin({"name": "x", "size": 1, "page_id": "welcome"}, "guest", guest)
        self.assertTrue(self.storage.cancel(upload["id"], "local", self.access)["cancelled"])

    def test_legacy_base64_range_compatibility_and_missing_chunks_fail_loudly(self):
        data = bytes(range(256)) * 500
        legacy = self.store.put("attachment", {"id": "legacy", "name": "old.bin", "size": len(data), "data": base64.b64encode(data).decode()})
        for start, end in [(0, len(data)), (1, 100), (2, 67000), (65535, 65539)]:
            self.assertEqual(b"".join(self.storage.iter_bytes(legacy["id"], start, end)), data[start:end])
        upload = self.begin(CHUNK_SIZE + 1)
        self.storage.append(upload["id"], 0, b"a" * CHUNK_SIZE, "local", self.access)
        self.storage.append(upload["id"], CHUNK_SIZE, b"z", "local", self.access)
        self.storage.complete(upload["id"], "local", self.access)
        reader = self.storage.iter_bytes(upload["id"])
        self.assertEqual(len(next(reader)), READ_SIZE)
        with self.store.transaction():
            self.store.db.execute("DELETE FROM attachment_chunks WHERE attachment_id=?", (upload["id"],))
        with self.assertRaises(APIError): next(reader)
        self.store.delete("attachment", upload["id"])
        with self.assertRaises(APIError): list(self.storage.iter_bytes(upload["id"]))

    def test_independent_connections_serialize_identical_retries_without_duplicate_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "uploads.db"
            first = Store(path)
            second = Store(path)
            try:
                storage = FileStorage(first)
                upload = storage.begin({"name": "race.bin", "size": 100}, "local")
                barrier, errors, results = threading.Barrier(2), [], []
                def append(store):
                    try:
                        barrier.wait()
                        results.append(FileStorage(store).append(upload["id"], 0, b"x" * 100, "local"))
                    except BaseException as error: errors.append(error)
                threads = [threading.Thread(target=append, args=(store,)) for store in (first, second)]
                for thread in threads: thread.start()
                for thread in threads: thread.join(timeout=10)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(errors, [])
                self.assertEqual([result["offset"] for result in results], [100, 100])
                self.assertEqual(first.db.execute("SELECT count(*) FROM attachment_chunks").fetchone()[0], 1)
                self.assertEqual(storage.complete(upload["id"], "local")["sha256"], hashlib.sha256(b"x" * 100).hexdigest())
            finally:
                first.close()
                second.close()


if __name__ == "__main__": unittest.main()
