"""A login snapshot cannot combine data from before and after revocation."""
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

from fountain.auth import Auth
from fountain.core import Store, Workspace


class SessionSnapshotTests(unittest.TestCase):
    def race(self, reset_password):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.db'
            first, second = Store(path), Store(path)
            release = threading.Event()
            try:
                Workspace(first)
                auth, revoker = Auth(first), Auth(second)
                password = 'session-snapshot-password-2026'
                auth.create_account('local', password)
                auth.enable_accounts()
                token = auth.login({'email': 'local@fountain.local', 'password': password}, '127.0.0.1')
                cookie = 'fountain_session=' + token
                expected = auth.session_info(cookie)
                resolved_session, attempting_write, entered_writer = (threading.Event() for _ in range(3))
                principal, transaction = auth.principal, second.transaction

                def paused_principal(value):
                    # _session_info has already loaded this session's binding.
                    resolved_session.set()
                    if not release.wait(5): raise TimeoutError('Session snapshot gate timed out')
                    return principal(value)

                @contextmanager
                def observed_writer():
                    attempting_write.set()
                    with transaction():
                        entered_writer.set()
                        yield second

                auth.principal, second.transaction = paused_principal, observed_writer
                def revoke():
                    with second.transaction():
                        if reset_password:
                            revoker.set_password('local', password + '-changed')
                        else:
                            revoker.logout(cookie)

                with ThreadPoolExecutor(max_workers=2) as pool:
                    reading = pool.submit(auth.session_info, cookie)
                    try:
                        self.assertTrue(resolved_session.wait(3))
                        writing = pool.submit(revoke)
                        self.assertTrue(attempting_write.wait(3))
                        self.assertFalse(entered_writer.wait(0.2), 'Revocation entered between session and member reads')
                    finally:
                        release.set()
                    self.assertEqual(reading.result(timeout=5), expected)
                    writing.result(timeout=5)
                rejected = auth.session_info(cookie)
                self.assertFalse(rejected['authenticated'])
                self.assertIsNone(rejected['cache_binding'])
                self.assertIsNone(rejected['expires_at'])
            finally:
                release.set()
                first.close()
                second.close()

    def test_logout_waits_for_a_consistent_login_snapshot(self):
        self.race(False)

    def test_password_reset_waits_for_a_consistent_login_snapshot(self):
        self.race(True)


if __name__ == '__main__':
    unittest.main()
