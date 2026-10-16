"""Sensitive reads authorize and project one snapshot across independent writers."""
import copy
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.core import APIError, Store
from fountain.server import Application


class ReadAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        database = Path(self.directory.name) / "workspace.db"
        self.stores = [Store(database), Store(database)]
        for store in self.stores:
            self.addCleanup(store.close)
        self.reader, self.writer = [Application(store) for store in self.stores]
        self.member = self.stores[1].put("member", {
            "id": "reader", "name": "Reader", "role": "member", "active": True})
        self.page = self.writer.workspace.create_page({
            "id": "private-page", "title": "Private page",
            "permissions": {"default": "private", "members": {"reader": "view"}},
            "blocks": [{"id": "text", "text": "Previously visible"}],
        })
        self.path = "/api/pages/" + self.page["id"]

    def read(self):
        return self.reader.dispatch("GET", self.path, {}, {},
                                    principal=copy.deepcopy(self.member))[1]

    def revoke_and_replace(self):
        self.writer.dispatch("PATCH", self.path + "/permissions", {
            "permissions": {"default": "private", "members": {}}}, {})
        self.writer.dispatch("PUT", self.path + "/blocks", {
            "blocks": [{"id": "text", "text": "Written after revocation"}]}, {})

    def start(self, callback):
        attempted, finished = threading.Event(), threading.Event()
        outcome = {}

        def run():
            attempted.set()
            try:
                outcome["value"] = callback()
            except BaseException as error:
                outcome["error"] = error
            finally:
                finished.set()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(attempted.wait(1), "Request thread did not start")
        return thread, finished, outcome

    def finish(self, work):
        thread, finished, outcome = work
        self.assertTrue(finished.wait(3), "Request did not finish after releasing its gate")
        thread.join(1)
        self.assertFalse(thread.is_alive(), "Request thread remained live")
        return outcome

    def test_read_waits_for_writer_then_authorizes_committed_revocation(self):
        authenticating = threading.Event()
        original = self.reader._request_context

        def context(*args, **kwargs):
            authenticating.set()
            return original(*args, **kwargs)

        with patch.object(self.reader, "_request_context", context):
            with self.stores[1].transaction():
                self.revoke_and_replace()
                work = self.start(self.read)
                blocked = not authenticating.wait(0.15)
            outcome = self.finish(work)

        self.assertTrue(blocked, "Read checked authentication before the writer committed")
        self.assertNotIn("value", outcome, "Revoked reader received a private response")
        self.assertIsInstance(outcome.get("error"), APIError)
        self.assertEqual(outcome["error"].status, 404)
        self.assertEqual(self.writer.workspace.page(self.page["id"])["blocks"][0]["text"],
                         "Written after revocation")

    def test_admitted_read_serializes_later_writer_and_returns_only_old_contents(self):
        reading, release, writing = threading.Event(), threading.Event(), threading.Event()
        original = self.reader.workspace.detail

        def detail(identity):
            reading.set()
            if not release.wait(1):
                raise TimeoutError("Read gate was not released")
            return original(identity)

        def write():
            with self.stores[1].transaction():
                writing.set()
                self.revoke_and_replace()

        with patch.object(self.reader.workspace, "detail", detail):
            read_work = self.start(self.read)
            try:
                self.assertTrue(reading.wait(1), "Authorized read did not reach page loading")
                write_work = self.start(write)
                blocked = not writing.wait(0.15)
            finally:
                release.set()
            read_outcome = self.finish(read_work)
            write_outcome = self.finish(write_work)

        self.assertTrue(blocked, "Later writer changed content during an admitted read")
        if "error" in read_outcome:
            raise read_outcome["error"]
        if "error" in write_outcome:
            raise write_outcome["error"]
        response = read_outcome["value"]
        self.assertEqual(response["page"]["access_level"], 1)
        self.assertEqual(response["blocks"][0]["text"], "Previously visible")
        with self.assertRaises(APIError) as caught:
            self.read()
        self.assertEqual(caught.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
