import os
import sqlite3
import tracemalloc
import unittest
from unittest.mock import patch

from fountain.access import Access
from fountain.attachments import CHUNK_SIZE, READ_SIZE, FileStorage
from fountain.auth import Auth
from fountain.collaboration import Collaboration
from fountain.core import APIError, Store, Workspace
from fountain.presence import PresenceService, RETENTION, TTL


class HelpersOnlyStore:
    """Expose the domain boundary while rejecting SQLite connection leakage."""
    def __init__(self, store):
        self.store = store

    def __getattr__(self, name):
        if name == "db": raise AssertionError("Domain services must use Store helper methods")
        return getattr(self.store, name)


class StoreChunkTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")

    def tearDown(self):
        self.store.close()

    def test_chunk_helper_contract_ranges_namespace_and_delete_count(self):
        self.assertIsNone(self.store.chunk_info("missing", 0))
        self.assertIsNone(self.store.chunk_read_range("missing", 0, 0, 0))
        self.assertEqual(self.store.chunk_delete("missing"), 0)
        self.store.chunk_write("file", CHUNK_SIZE, bytearray(b"tail"))
        self.store.chunk_write("file", 0, b"family bytes")
        self.store.chunk_write("other", 0, b"private")
        self.assertEqual(self.store.chunk_info("file", 0), (12, "blob"))
        self.assertEqual(self.store.chunk_list("file"), [(0, 12, "blob"), (CHUNK_SIZE, 4, "blob")])
        self.assertEqual(self.store.chunk_read_range("file", 0, 7, 100), b"bytes")
        self.assertEqual(self.store.chunk_read_range("file", 0, 12, 1), b"")
        self.assertEqual(self.store.chunk_read_range("file", 0, 100, 0), b"")
        self.assertEqual(self.store.chunk_read_range("file", CHUNK_SIZE, 1, 2), b"ai")
        self.assertEqual(self.store.chunk_delete("file"), 2)
        self.assertEqual(self.store.chunk_list("file"), [])
        self.assertEqual(self.store.chunk_read_range("other", 0, 0, 7), b"private")

    def test_chunk_limits_allow_one_retry_chunk_but_reject_unbounded_reads_and_writes(self):
        content = b"x" * CHUNK_SIZE
        self.store.chunk_write("full", 0, content)
        self.assertEqual(self.store.chunk_read_range("full", 0, 0, CHUNK_SIZE), content)
        for start, length in [(-1, 1), (True, 1), (0, -1), (0, True), (0, CHUNK_SIZE + 1)]:
            with self.subTest(start=start, length=length), self.assertRaises(APIError):
                self.store.chunk_read_range("full", 0, start, length)
        for offset, data in [(-1, b"x"), (True, b"x"), (0, "text"), (0, content + b"x")]:
            with self.subTest(offset=offset, data_type=type(data)), self.assertRaises(APIError):
                self.store.chunk_write("invalid", offset, data)
        self.assertEqual(self.store.chunk_list("invalid"), [])

    def test_incremental_read_does_not_load_oversized_blob_or_keep_handle_open(self):
        self.store.db.execute("INSERT INTO attachment_chunks VALUES ('oversized',0,zeroblob(?))", (32 * 1024 * 1024,))
        self.store.db.commit()
        tracemalloc.start()
        try:
            data = self.store.chunk_read_range("oversized", 0, 123, READ_SIZE)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(data, b"\0" * READ_SIZE)
        self.assertLess(peak, 1024 * 1024)
        # An open BLOB handle would prevent deleting/committing its own table.
        self.assertEqual(self.store.chunk_delete("oversized"), 1)
        self.store.db.execute("INSERT INTO attachment_chunks VALUES ('invalid',0,'text')")
        self.store.db.commit()
        self.assertEqual(self.store.chunk_info("invalid", 0), (4, "text"))
        with self.assertRaises(APIError) as error: self.store.chunk_read_range("invalid", 0, 0, 1)
        self.assertEqual(error.exception.status, 409)

    def test_nested_chunk_writes_deletes_and_entity_changes_roll_back_together(self):
        self.store.chunk_write("file", 0, b"original")
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.chunk_delete("file")
                self.store.chunk_write("file", CHUNK_SIZE, b"temporary")
                self.store.put("upload", {"id": "file", "offset": 999})
                raise RuntimeError("abort bytes and metadata")
        self.assertEqual(self.store.chunk_list("file"), [(0, 8, "blob")])
        self.assertIsNone(self.store.get("upload", "file"))
        with self.store.transaction():
            with self.assertRaises(sqlite3.IntegrityError): self.store.chunk_write("file", 0, b"duplicate")
            self.store.put("example", {"id": "outer-commit"})
        self.assertEqual(self.store.chunk_read_range("file", 0, 0, 8), b"original")
        self.assertIsNotNone(self.store.get("example", "outer-commit"))

    def test_file_service_uses_helpers_for_retries_hashing_and_bounded_streaming(self):
        service = FileStorage(HelpersOnlyStore(self.store))
        first, last = b"a" * CHUNK_SIZE, b"tail"
        upload = service.begin({"name": "family.bin", "size": len(first) + len(last)}, "local")
        service.append(upload["id"], 0, first, "local")
        with patch.object(self.store, "chunk_read_range", wraps=self.store.chunk_read_range) as reader:
            service.append(upload["id"], 0, first, "local")
            self.assertEqual(reader.call_args.args[3], CHUNK_SIZE)
        service.append(upload["id"], CHUNK_SIZE, last, "local")
        with patch.object(self.store, "chunk_read_range", wraps=self.store.chunk_read_range) as reader:
            service.complete(upload["id"], "local")
            stream = service.iter_bytes(upload["id"], CHUNK_SIZE - 2)
            self.assertEqual(b"".join(stream), b"aa" + last)
            self.assertTrue(all(call.args[3] <= READ_SIZE for call in reader.call_args_list))
        service.store.chunk_delete(upload["id"])
        with self.assertRaises(APIError): list(service.iter_bytes(upload["id"]))

    def test_presence_helpers_filter_numeric_expiry_origin_page_and_copy_results(self):
        for identity, page, origin, retained in [("a", "가족 문서", "first", 2), ("b", "가족 문서", "second", 10), ("c", "other", "first", 100.25)]:
            self.store.put("presence", {"id": identity, "page_id": page, "origin_kind": "session", "origin_id": origin,
                "retain_until": retained, "selection": {"offset": 1}})
        self.store.put("example", {"id": "unrelated", "page_id": "가족 문서", "retain_until": 0})
        self.assertEqual({row["id"] for row in self.store.presence_lookup(page="가족 문서", now=9)}, {"b"})
        self.assertEqual({row["id"] for row in self.store.presence_lookup(origin=("session", "first"), now=2)}, {"c"})
        rows = self.store.presence_lookup(page="other", origin=("session", "first"), now=100)
        rows[0]["selection"]["offset"] = 999
        self.assertEqual(self.store.get("presence", "c")["selection"]["offset"], 1)
        self.assertEqual(self.store.presence_lookup(page="other", now=100.25), [])

    def test_presence_cleanup_is_bounded_deterministic_transactional_and_advances_revision(self):
        for identity in ("c", "a", "b"): self.store.put("presence", {"id": identity, "retain_until": 1})
        self.store.put("presence", {"id": "future", "retain_until": 10})
        self.store.put("example", {"id": "keep", "retain_until": 0})
        before = self.store.meta("_entity_revision")
        self.assertEqual(self.store.presence_cleanup(1, limit=2), 2)
        self.assertEqual(self.store.meta("_entity_revision"), before + 2)
        self.assertEqual({row["id"] for row in self.store.list("presence")}, {"c", "future"})
        for limit in (0, 501, True):
            with self.subTest(limit=limit), self.assertRaises(APIError): self.store.presence_cleanup(100, limit)
        before = self.store.meta("_entity_revision")
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.assertEqual(self.store.presence_cleanup(100), 2)
                raise RuntimeError("abort cleanup")
        self.assertEqual(self.store.meta("_entity_revision"), before)
        self.assertEqual(self.store.presence_cleanup(1), 1)
        self.assertIsNotNone(self.store.get("example", "keep"))

    def test_presence_service_has_no_sqlite_connection_dependency(self):
        with patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": ""}):
            store = HelpersOnlyStore(self.store)
            workspace = Workspace(store)
            auth = Auth(store)
            principal = auth.principal("")
            document = Collaboration(store, workspace).snapshot("welcome", Access(store, principal))
            clock = [100]
            service = PresenceService(store, auth, lambda: clock[0])
            body = {"session_binding": auth.session_info("")["cache_binding"], "epoch": document["epoch"], "client_id": "tab", "seq": 1, "selection": None}
            self.assertEqual(len(service.update("welcome", body, "")["participants"]), 1)
            clock[0] += TTL + RETENTION + 1
            self.assertEqual(service.snapshot("welcome", "")["participants"], [])
            self.assertEqual(store.list("presence"), [])


if __name__ == "__main__": unittest.main()
