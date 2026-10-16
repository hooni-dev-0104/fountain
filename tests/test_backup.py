import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.backup import BackupError, create_backup, inspect_backup, main, restore_backup
from fountain.core import Store, Workspace


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "live workspace #1.db"
        self.store = Store(self.source)
        self.workspace = Workspace(self.store)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_complete_backup_excludes_sessions_and_preserves_all_other_entities(self):
        kinds = ["comment", "version", "form", "settings", "audit", "attachment", "site", "automation", "member", 'collaboration']
        for kind in kinds:
            self.store.put(kind, {"id": "fixture-" + kind, "content": {"한글": "가족 데이터"}})
        self.store.put("session", {"id": "secret-session", "expires_at": "future"})
        self.store.put("clipboard", {"id": "temporary-clipboard", "html": "private clipboard"})
        self.store.put("upload", {"id": "temporary-upload", "name": "unfinished upload"})
        self.store.set_meta("family", {"name": "우리집", "settings": [1, 2, 3]})
        self.store.set_meta('local_cache_binding', 'old-browser-cache-binding')
        backup, restored = self.root / "snapshot.db", self.root / "restored.db"
        counts = create_backup(self.source, backup)
        self.assertNotIn("session", counts)
        self.assertNotIn("clipboard", counts)
        self.assertNotIn("upload", counts)
        self.assertNotIn(b"secret-session", backup.read_bytes())
        self.assertNotIn(b"private clipboard", backup.read_bytes())
        self.assertNotIn(b"unfinished upload", backup.read_bytes())
        self.assertNotIn(b'old-browser-cache-binding', backup.read_bytes())
        self.assertIsNotNone(self.store.get("session", "secret-session"))
        self.assertEqual(restore_backup(backup, restored), counts)
        restored_store = Store(restored)
        try:
            for kind in kinds + ["page", "row", "database", "teamspace"]:
                self.assertEqual(restored_store.list(kind), self.store.list(kind), kind)
            self.assertEqual(restored_store.meta("family"), self.store.meta("family"))
            self.assertEqual(restored_store.list("session"), [])
            self.assertEqual(restored_store.list("clipboard"), [])
            self.assertEqual(restored_store.list("upload"), [])
            self.assertIsNone(restored_store.meta('local_cache_binding'))
            self.assertEqual(restored_store.meta('workspace_id'), self.store.meta('workspace_id'))
        finally:
            restored_store.close()
        self.assertEqual(inspect_backup(backup), counts)

    def test_caller_connection_is_supported_and_kept_open(self):
        memory = Store(":memory:")
        try:
            memory.put("page", {"id": "in-memory", "title": "가족"})
            memory.put("session", {"id": "private-session"})
            backup = self.root / "memory.db"
            self.assertEqual(create_backup(memory.db, backup), {"page": 1})
            self.assertEqual(memory.get("page", "in-memory")["title"], "가족")
            self.assertIsNotNone(memory.get("session", "private-session"))
            self.assertEqual(inspect_backup(backup), {"page": 1})
        finally:
            memory.close()

    def test_live_wal_snapshot_contains_recent_uncheckpointed_commit(self):
        self.store.db.execute("PRAGMA wal_autocheckpoint=0")
        self.store.put("page", {"id": "wal-only", "title": "새 가족 기록"})
        self.assertTrue(Path(str(self.source) + "-wal").exists())
        backup = self.root / "wal-snapshot.db"
        create_backup(self.source, backup)
        with sqlite3.connect(backup) as connection:
            data = connection.execute("SELECT data FROM entities WHERE id='wal-only'").fetchone()[0]
            self.assertEqual(json.loads(data)["title"], "새 가족 기록")
        self.assertFalse(Path(str(backup) + "-wal").exists())

    def test_existing_destination_is_preserved_and_race_cannot_overwrite(self):
        destination = self.root / "existing.db"
        destination.write_bytes(b"keep this file")
        with self.assertRaises(BackupError): create_backup(self.source, destination)
        with self.assertRaises(BackupError): restore_backup(self.source, destination)
        self.assertEqual(destination.read_bytes(), b"keep this file")
        destination.unlink()
        import os
        original_link = os.link
        def racing_link(source, target):
            Path(target).write_bytes(b"created concurrently")
            return original_link(source, target)
        with patch("fountain.backup.os.link", side_effect=racing_link):
            with self.assertRaises(BackupError): create_backup(self.source, destination)
        self.assertEqual(destination.read_bytes(), b"created concurrently")
        self.assertFalse(list(self.root.glob(".fountain-backup-*")))

    def test_missing_corrupt_and_invalid_json_sources_are_rejected(self):
        missing = self.root / "missing.db"
        with self.assertRaises(BackupError): inspect_backup(missing)
        self.assertFalse(missing.exists())
        corrupt = self.root / "corrupt.db"
        corrupt.write_bytes(b"not a sqlite database")
        with self.assertRaises(BackupError): restore_backup(corrupt, self.root / "bad.db")
        self.assertFalse((self.root / "bad.db").exists())
        self.store.db.execute("UPDATE entities SET data='not-json' WHERE kind='page'")
        self.store.db.commit()
        with self.assertRaises(BackupError): create_backup(self.source, self.root / "invalid.db")
        self.assertFalse((self.root / "invalid.db").exists())

    def test_unknown_schema_objects_and_constraints_are_rejected(self):
        for sql in ["CREATE VIEW hidden AS SELECT * FROM entities",
                    "CREATE TRIGGER hidden AFTER INSERT ON meta BEGIN DELETE FROM entities; END",
                    "CREATE TABLE hidden (data TEXT)",
                    "CREATE INDEX hidden ON entities(kind)"]:
            with self.subTest(sql=sql):
                path = self.root / "unknown.db"
                create_backup(self.source, path)
                with sqlite3.connect(path) as connection: connection.execute(sql)
                with self.assertRaises(BackupError): inspect_backup(path)
                path.unlink()
        path = self.root / "wrong-columns.db"
        with sqlite3.connect(path) as connection:
            connection.executescript("CREATE TABLE entities(id TEXT); CREATE TABLE meta(key TEXT,data TEXT)")
        with self.assertRaises(BackupError): inspect_backup(path)

    def test_cli_reports_failures_without_tracebacks(self):
        output, errors = io.StringIO(), io.StringIO()
        destination = self.root / "cli.db"
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(main(["create", str(self.source), str(destination)]), 0)
            self.assertEqual(main(["restore", str(self.source), str(destination)]), 1)
        self.assertIn("entities", json.loads(output.getvalue()))
        self.assertIn("Destination already exists", errors.getvalue())
        self.assertNotIn("Traceback", errors.getvalue())


if __name__ == "__main__": unittest.main()
