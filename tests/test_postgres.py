"""Real PostgreSQL contract tests; configure FOUNTAIN_TEST_POSTGRES_DSN.

Each test creates a random workspace namespace, then deletes only that namespace.
The schema and dedicated server role must already have been migrated.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
import uuid

from fountain.auth import Auth
from fountain.core import APIError, Workspace
from fountain.postgres import PostgresStore


class PostgresConfigurationTests(unittest.TestCase):
    def test_module_does_not_load_the_optional_driver_at_import_time(self):
        result = subprocess.run([sys.executable, "-S", "-c",
            "import sys; import fountain.postgres; from fountain.core import Store; "
            "assert 'psycopg' not in sys.modules; store=Store(':memory:'); "
            "store.put('example', {'id':'sqlite-still-works'}); "
            "assert store.get('example','sqlite-still-works'); store.close()"],
            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_connection_and_workspace_fail_before_network_access(self):
        with self.assertRaises(APIError) as caught:
            PostgresStore("", workspace_id="configuration-test")
        self.assertEqual(caught.exception.status, 503)
        with self.assertRaises(APIError):
            PostgresStore("", workspace_id="")

    @unittest.skipUnless(importlib.util.find_spec("psycopg"), "Optional PostgreSQL driver is not installed")
    def test_insecure_and_invalid_connection_options_never_echo_secrets(self):
        secret = "test-password-must-not-appear"
        for dsn in (f"host=localhost password={secret} sslmode=disable", f"password='{secret}"):
            with self.subTest(case="invalid configuration"):
                with self.assertRaises(APIError) as caught:
                    PostgresStore(dsn, workspace_id="configuration-test")
                self.assertEqual(caught.exception.status, 503)
                self.assertNotIn(secret, str(caught.exception))


@unittest.skipUnless(os.environ.get("FOUNTAIN_TEST_POSTGRES_DSN"),
                     "Real PostgreSQL verification requires FOUNTAIN_TEST_POSTGRES_DSN")
class PostgresIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.namespace = uuid.uuid4().hex
        self.stores = []
        self.addCleanup(self.cleanup_workspace)
        self.first = self.open_store()
        self.second = self.open_store()

    def open_store(self, namespace=None):
        store = PostgresStore(os.environ["FOUNTAIN_TEST_POSTGRES_DSN"],
                              workspace_id=namespace or self.namespace)
        self.stores.append(store)
        return store

    def cleanup_workspace(self):
        # Bound every cleanup query to namespaces created by this test only.
        try:
            by_namespace = {store.workspace_id: store for store in self.stores}
            for namespace, store in by_namespace.items():
                with store.transaction():
                    for table in ("attachment_chunks", "entities", "meta"):
                        store._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s", (namespace,))
        finally:
            for store in self.stores:
                store.close()

    def run_thread(self, callback):
        errors = []
        def run():
            try:
                callback()
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, errors

    def finish_thread(self, thread, errors):
        thread.join(15)
        self.assertFalse(thread.is_alive(), "PostgreSQL worker did not finish")
        if errors: raise errors[0]

    def test_independent_connections_revision_namespaces_and_json_round_trip(self):
        self.assertEqual(self.first.meta("_entity_revision", 0), 0)
        value = self.first.put("example", {"id": "one", "title": "가족 문서", "nested": [True, None, 3]})
        self.assertEqual(self.second.get("example", "one"), value)
        value["nested"].append("caller mutation")
        self.assertEqual(self.second.get("example", "one")["nested"], [True, None, 3])
        previous = self.first.get("example", "one")
        updated = self.second.put("example", {"id": "one", "changed": True})
        self.assertEqual(updated["created_at"], previous["created_at"])
        self.second.set_meta("setting", {"enabled": True})
        self.first.delete("example", "missing")
        self.assertEqual(self.first.meta("_entity_revision"), 3)
        self.assertEqual(self.second.meta("_entity_revision"), 3)
        other = self.open_store(uuid.uuid4().hex)
        self.assertIsNone(other.get("example", "one"))
        self.assertIsNone(other.meta("setting"))

    def test_savepoint_and_outer_rollback_restore_entities_and_counter(self):
        with self.first.transaction():
            self.first.put("example", {"id": "kept"})
            with self.assertRaises(ValueError):
                with self.first.transaction():
                    self.first.put("example", {"id": "discarded"})
                    self.first.set_meta("discarded", True)
                    raise ValueError("rollback nested writes")
            self.assertEqual(self.first.transaction_depth, 1)
            self.assertEqual(self.first.meta("_entity_revision"), 1)
            self.first.commit()
        self.assertEqual(self.first.transaction_depth, 0)
        with self.assertRaises(ValueError):
            with self.first.transaction():
                self.first.delete("example", "kept")
                raise ValueError("rollback outer writes")
        self.assertIsNotNone(self.second.get("example", "kept"))
        self.assertIsNone(self.second.get("example", "discarded"))
        self.assertIsNone(self.second.meta("discarded"))
        self.assertEqual(self.second.meta("_entity_revision"), 1)

    def test_canonical_client_row_identifier_cannot_replace_existing_row(self):
        workspace = Workspace(self.first)
        self.assertEqual(self.first.meta("workspace_id"), self.namespace)
        database = workspace.create_database({"name": "가족 계획"})
        row = workspace.create_row(database["id"], {"id": "device-row-one"})
        revision = self.first.meta("_entity_revision")
        with self.assertRaises(APIError) as caught:
            workspace.create_row(database["id"], {"id": row["id"]})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.second.meta("_entity_revision"), revision)
        self.assertEqual(self.second.get("row", row["id"]), row)

    def test_other_connection_observes_atomic_commit_after_workspace_lock(self):
        attempted, entered = threading.Event(), threading.Event()
        observed = []
        def reader():
            attempted.set()
            with self.second.transaction():
                entered.set()
                observed.extend(self.second.list("example"))
        with self.first.transaction():
            self.first.put("example", {"id": "first"})
            thread, errors = self.run_thread(reader)
            self.assertTrue(attempted.wait(5))
            self.assertFalse(entered.wait(0.2), "Workspace lock was not shared across connections")
            self.first.put("example", {"id": "second"})
        self.finish_thread(thread, errors)
        self.assertEqual({row["id"] for row in observed}, {"first", "second"})
        self.assertEqual(self.second.meta("_entity_revision"), 2)

    def test_simultaneous_connections_do_not_lose_revision_increments(self):
        barrier = threading.Barrier(2)
        def write_batch(store, prefix):
            barrier.wait(5)
            for index in range(4):
                store.put("example", {"id": f"{prefix}-{index}"})
        first_thread, first_errors = self.run_thread(lambda: write_batch(self.first, "first"))
        second_thread, second_errors = self.run_thread(lambda: write_batch(self.second, "second"))
        self.finish_thread(first_thread, first_errors)
        self.finish_thread(second_thread, second_errors)
        self.assertEqual(self.first.meta("_entity_revision"), 8)
        self.assertEqual(self.second.meta("_entity_revision"), 8)
        self.assertEqual(len(self.second.list("example")), 8)

    def test_workspace_lock_fences_logout_before_authentication(self):
        first_auth, second_auth = Auth(self.first), Auth(self.second)
        first_auth._secret = second_auth._secret = "fountain-test-shared-secret"
        token = first_auth.login({"token": first_auth._secret})
        cookie = "fountain_session=" + token
        attempted, entered = threading.Event(), threading.Event()
        result = []
        def mutation():
            attempted.set()
            with self.second.transaction():
                entered.set()
                authenticated = second_auth.authenticate(cookie)
                result.append(authenticated)
                if authenticated: self.second.put("example", {"id": "forbidden"})
        with self.first.transaction():
            first_auth.logout(cookie)
            thread, errors = self.run_thread(mutation)
            self.assertTrue(attempted.wait(5))
            self.assertFalse(entered.wait(0.2))
        self.finish_thread(thread, errors)
        self.assertEqual(result, [False])
        self.assertIsNone(self.second.get("example", "forbidden"))

    def test_python_lock_prevents_same_connection_thread_interleaving(self):
        attempted, finished = threading.Event(), threading.Event()
        def writer():
            attempted.set()
            self.first.put("example", {"id": "thread"})
            finished.set()
        with self.first.lock:
            with self.first.lock:
                thread, errors = self.run_thread(writer)
                self.assertTrue(attempted.wait(5))
                self.assertFalse(finished.wait(0.2))
        self.finish_thread(thread, errors)
        self.assertTrue(finished.is_set())

    def test_chunks_range_reads_and_metadata_rollback_share_a_transaction(self):
        payload = b"family attachment bytes"
        with self.first.transaction():
            self.first.chunk_write("file", 0, payload)
            self.first.put("upload", {"id": "file", "offset": len(payload)})
        self.assertEqual(self.second.chunk_info("file", 0), (len(payload), "blob"))
        self.assertEqual(self.second.chunk_read_range("file", 0, 7, 10), payload[7:17])
        self.assertEqual(self.second.chunk_list("file"), [(0, len(payload), "blob")])
        with self.assertRaises(ValueError):
            with self.first.transaction():
                self.first.chunk_write("file", 4 * 1024 * 1024, b"discarded")
                self.first.put("upload", {"id": "file", "offset": 999})
                raise ValueError("rollback bytes and metadata")
        self.assertIsNone(self.second.chunk_info("file", 4 * 1024 * 1024))
        self.assertEqual(self.second.get("upload", "file")["offset"], len(payload))
        self.first.chunk_delete("file")
        self.assertEqual(self.second.chunk_list("file"), [])

    def test_database_error_rolls_back_savepoint_and_keeps_outer_transaction_usable(self):
        with self.first.transaction():
            self.first.chunk_write("file", 0, b"original")
            with self.assertRaises(APIError) as caught:
                self.first.chunk_write("file", 0, b"duplicate")
            self.assertEqual(caught.exception.status, 503)
            self.assertNotIn("duplicate", str(caught.exception))
            self.first.put("example", {"id": "after-error"})
        self.assertEqual(self.second.chunk_read_range("file", 0, 0, 8), b"original")
        self.assertIsNotNone(self.second.get("example", "after-error"))

    def test_presence_queries_and_bounded_cleanup(self):
        for identity, page, retain in (("first", "a", 40), ("second", "a", 60), ("third", "b", 70)):
            self.first.put("presence", {"id": identity, "page_id": page, "origin_kind": "session",
                                        "origin_id": "session-a", "retain_until": retain})
        self.assertEqual([row["id"] for row in self.second.presence_lookup(page="a", origin=("session", "session-a"), now=50)], ["second"])
        self.assertEqual(self.first.presence_cleanup(50), 1)
        self.assertIsNone(self.second.get("presence", "first"))
        self.assertEqual(len(self.second.presence_lookup()), 2)

    def test_actual_role_cannot_read_or_insert_without_workspace_context(self):
        self.first.put("example", {"id": "private"})
        self.first.set_meta("private-setting", True)
        self.first.chunk_write("private-file", 0, b"private bytes")
        context = self.first._execute("SELECT current_setting('fountain.workspace_id',true)", fetch="one")[0]
        self.assertIn(context, (None, ""), "Transaction-local workspace setting leaked after commit")
        for table in ("entities", "meta", "attachment_chunks"):
            with self.subTest(table=table):
                rows = self.first._execute(f"SELECT workspace_id FROM fountain_private.{table} WHERE workspace_id=%s",
                                           (self.namespace,), fetch="all")
                self.assertEqual(rows, [])
        with self.assertRaises(APIError):
            self.first._execute("INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES (%s,%s,%s)",
                                (self.namespace, "unscoped-write", self.first._json(True)))
        self.assertIsNone(self.first.meta("unscoped-write"))

    def test_actual_rls_denies_cross_namespace_reads_updates_deletes_and_insert(self):
        other = self.open_store(uuid.uuid4().hex)
        other.put("example", {"id": "private"})
        other.set_meta("private-setting", True)
        other.chunk_write("private-file", 0, b"private bytes")
        with self.first.transaction():
            for table in ("entities", "meta", "attachment_chunks"):
                with self.subTest(table=table):
                    rows = self.first._execute(f"SELECT workspace_id FROM fountain_private.{table} WHERE workspace_id=%s",
                                               (other.workspace_id,), fetch="all")
                    self.assertEqual(rows, [])
                    removed = self.first._execute(f"DELETE FROM fountain_private.{table} WHERE workspace_id=%s",
                                                  (other.workspace_id,))
                    self.assertEqual(removed, 0)
            changed = self.first._execute("UPDATE fountain_private.entities SET data=%s WHERE workspace_id=%s",
                                          (self.first._json({"id": "tampered"}), other.workspace_id))
            self.assertEqual(changed, 0)
            with self.assertRaises(APIError):
                with self.first.transaction():
                    self.first._execute("INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES (%s,%s,%s)",
                                        (other.workspace_id, "cross-write", self.first._json(True)))
        self.assertEqual(other.get("example", "private")["id"], "private")
        self.assertTrue(other.meta("private-setting"))
        self.assertIsNone(other.meta("cross-write"))
        self.assertEqual(other.chunk_read_range("private-file", 0, 0, 13), b"private bytes")

    def test_actual_role_has_no_schema_or_role_escalation_privileges(self):
        role = self.first._execute("SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user",
                                   fetch="one")
        self.assertEqual(role, (False, False, False, False))
        privileges = self.first._execute("SELECT has_schema_privilege(current_user,'fountain_private','CREATE'),"
                                         "has_schema_privilege(current_user,'public','CREATE'),"
                                         "pg_has_role(current_user,'postgres','MEMBER'),"
                                         "pg_has_role(current_user,'supabase_admin','MEMBER')", fetch="one")
        self.assertEqual(privileges, (False, False, False, False))
        tables = self.first._execute("SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace "
                                     "WHERE n.nspname='fountain_private' AND relname IN ('entities','meta','attachment_chunks')",
                                     fetch="all")
        self.assertEqual(dict(tables), {"entities": True, "meta": True, "attachment_chunks": True})


if __name__ == "__main__":
    unittest.main()
