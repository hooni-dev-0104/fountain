import base64
import http.client
import json
import os
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.core import APIError, Store
from fountain.server import FountainServer, create_server


class TLSTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.certificates = tempfile.TemporaryDirectory()
        root = Path(cls.certificates.name)
        cls.cert, cls.key = root / "localhost.crt", root / "localhost.key"
        openssl = shutil.which("openssl")
        if not openssl: raise RuntimeError("OpenSSL is required to generate temporary TLS test certificates")
        config = root / "openssl.cnf"
        config.write_text("""[req]
prompt = no
distinguished_name = dn
x509_extensions = v3
[dn]
CN = localhost
[v3]
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
""")
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
                        "-keyout", str(cls.key), "-out", str(cls.cert), "-config", str(config)],
                       check=True, capture_output=True, timeout=15)
        cls.context = ssl.create_default_context(cafile=str(cls.cert))

    @classmethod
    def tearDownClass(cls):
        cls.certificates.cleanup()

    def setUp(self):
        self.environment = patch.dict(os.environ, {"FOUNTAIN_ACCESS_TOKEN": "temporary-family-tls-test-password"})
        self.environment.start()
        self.directory = tempfile.TemporaryDirectory()
        self.servers = []
        self.server = self.start_server(tls=True)
        self.cookie = ""

    def tearDown(self):
        for server, thread in reversed(self.servers):
            server.shutdown()
            server.server_close()
            thread.join(3)
            server.application.store.close()
        self.directory.cleanup()
        self.environment.stop()

    def start_server(self, tls):
        options = {"tls_cert": self.cert, "tls_key": self.key} if tls else {}
        server = create_server(port=0, db_path=Path(self.directory.name) / f"workspace-{len(self.servers)}.db", **options)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server

    def connection(self, server=None, context=None, hostname="127.0.0.1"):
        server = server or self.server
        port = server.server_address[1]
        if server.scheme == "https":
            return http.client.HTTPSConnection(hostname, port, timeout=3, context=context or self.context)
        return http.client.HTTPConnection(hostname, port, timeout=3)

    def request(self, method, path, body=None, headers=None, server=None, raw=False, context=None):
        server = server or self.server
        values = {"X-Fountain-Request": "1", "Cookie": self.cookie, "Content-Type": "application/octet-stream" if raw else "application/json"}
        values.update(headers or {})
        connection = self.connection(server, context)
        connection.request(method, path, body if raw else json.dumps(body) if body is not None else None, values)
        response = connection.getresponse()
        data, response_headers = response.read(), dict(response.getheaders())
        result = json.loads(data) if data and "json" in response.getheader("Content-Type", "") else data
        status = response.status
        connection.close()
        return status, result, response_headers

    def login(self, headers=None, server=None):
        status, info, response_headers = self.request("POST", "/api/session", {"token": "temporary-family-tls-test-password"}, headers, server)
        self.assertEqual(status, 200)
        self.assertTrue(info["authenticated"])
        cookie = response_headers["Set-Cookie"]
        self.cookie = cookie.split(";", 1)[0]
        return cookie

    def test_verified_https_tls12_login_post_and_secure_logout(self):
        self.assertEqual(self.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(self.context.check_hostname)
        self.assertEqual(self.server.tls_context.minimum_version, ssl.TLSVersion.TLSv1_2)
        tls12 = ssl.create_default_context(cafile=str(self.cert))
        tls12.maximum_version = ssl.TLSVersion.TLSv1_2
        connection = self.connection(context=tls12, hostname="localhost")
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(connection.sock.version(), "TLSv1.2")
        response.read()
        connection.close()
        host = f"127.0.0.1:{self.server.server_address[1]}"
        cookie = self.login({"Origin": "https://" + host, "X-Forwarded-Proto": "http"})
        self.assertIn("; Secure", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertEqual(self.request("GET", "/api/workspace")[0], 200)
        self.assertEqual(self.request("POST", "/api/pages", {"title": "HTTPS 문서"}, {"Origin": "https://" + host})[0], 201)
        status, _, headers = self.request("DELETE", "/api/session")
        self.assertEqual(status, 200)
        self.assertIn("; Secure", headers["Set-Cookie"])
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.request("GET", "/api/workspace")[0], 401)

    def test_tls_origin_host_and_request_header_checks_do_not_trust_forwarded_scheme(self):
        host = f"127.0.0.1:{self.server.server_address[1]}"
        for origin in ["http://" + host, "https://evil.example", "null"]:
            status, _, headers = self.request("POST", "/api/session", {"token": "temporary-family-tls-test-password"}, {"Origin": origin, "X-Forwarded-Proto": "https"})
            self.assertEqual(status, 403)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.request("POST", "/api/session", {"token": "temporary-family-tls-test-password"}, {"X-Fountain-Request": ""})[0], 403)
        self.assertEqual(self.request("GET", "/api/health", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/health", headers={"Origin": "https://localhost"})[0], 403)
        self.assertIn("; Secure", self.login({"X-Forwarded-Proto": "http"}))

    def test_http_default_is_unchanged_and_proxy_header_never_adds_secure_cookie(self):
        server = self.start_server(tls=False)
        host = f"127.0.0.1:{server.server_address[1]}"
        self.assertIsNone(server.tls_context)
        self.assertEqual(self.request("POST", "/api/session", {"token": "temporary-family-tls-test-password"},
            {"Origin": "https://" + host, "X-Forwarded-Proto": "https"}, server)[0], 403)
        cookie = self.login({"Origin": "http://" + host, "X-Forwarded-Proto": "https"}, server)
        self.assertNotIn("Secure", cookie)
        status, _, headers = self.request("DELETE", "/api/session", headers={"X-Forwarded-Proto": "https"}, server=server)
        self.assertEqual(status, 200)
        self.assertNotIn("Secure", headers["Set-Cookie"])

    def test_sse_snapshot_and_new_event_work_over_verified_https(self):
        self.login()
        connection = self.connection()
        connection.request("GET", "/api/pages/welcome/events", headers={"Cookie": self.cookie})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        def snapshot():
            event = None
            for _ in range(40):
                line = response.readline()
                if line.startswith(b"event: "): event = line[7:].strip()
                if line.startswith(b"data: ") and event == b"snapshot": return json.loads(line[6:])
                if not line.strip(): event = None
            self.fail("No SSE snapshot arrived")
        try:
            initial = snapshot()
            status, _, _ = self.request("PUT", "/api/pages/welcome/blocks", {"revision": initial["page"]["revision"], "blocks": [{"type": "paragraph", "text": "TLS 실시간 변경"}]})
            self.assertEqual(status, 200)
            current = snapshot()
            self.assertEqual(current["blocks"][0]["text"], "TLS 실시간 변경")
            self.assertGreater(current["page"]["revision"], initial["page"]["revision"])
        finally:
            response.close()
            connection.close()

    def test_chunked_and_legacy_attachment_range_and_head_over_https(self):
        self.login()
        content = bytes(range(256)) * 40
        status, upload, _ = self.request("POST", "/api/uploads", {"name": "가족 사진.bin", "size": len(content)})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("PUT", f"/api/uploads/{upload['id']}/chunks?offset=0", content, raw=True)[0], 200)
        status, attachment, _ = self.request("POST", f"/api/uploads/{upload['id']}/complete", {})
        self.assertEqual(status, 201)
        path = f"/api/attachments/{attachment['id']}/download"
        status, data, headers = self.request("GET", path, headers={"Range": "bytes=7-22"})
        self.assertEqual((status, data), (206, content[7:23]))
        self.assertEqual(headers["Content-Range"], f"bytes 7-22/{len(content)}")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, data, headers = self.request("HEAD", path, headers={"Range": "bytes=-3"})
        self.assertEqual((status, data, headers["Content-Length"]), (200, b"", str(len(content))))
        legacy = self.request("POST", "/api/attachments", {"name": "old.bin", "data": base64.b64encode(content).decode()})[1]
        self.assertEqual(self.request("GET", f"/api/attachments/{legacy['id']}/download", headers={"Range": "bytes=1-4"})[:2], (206, content[1:5]))

    def test_plaintext_and_untrusted_cert_are_rejected_without_stalling_accept_loop(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=2)
        try:
            with self.assertRaises((OSError, http.client.HTTPException)):
                connection.request("GET", "/api/health")
                connection.getresponse()
        finally:
            connection.close()
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.request("GET", "/api/health", context=ssl.create_default_context())
        self.assertEqual(self.request("GET", "/api/health")[0], 200)
        entered, thread_ids = threading.Event(), []
        original_wrap = self.server.tls_context.wrap_socket
        def wrap(*args, **kwargs):
            thread_ids.append(threading.get_ident())
            entered.set()
            return original_wrap(*args, **kwargs)
        self.server.tls_handshake_timeout = 1
        with patch.object(self.server.tls_context, "wrap_socket", wrap):
            idle = socket.create_connection(("127.0.0.1", self.server.server_address[1]), timeout=2)
            try:
                self.assertTrue(entered.wait(1))
                started = time.monotonic()
                self.assertEqual(self.request("GET", "/api/health")[0], 200)
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertNotIn(self.servers[0][1].ident, thread_ids)
                idle.settimeout(2)
                self.assertEqual(idle.recv(1), b"")
            finally:
                idle.close()

    def test_default_host_ports_match_actual_scheme_and_ipv6_allowlist_stays_narrow(self):
        # Exercise header policy with simulated privileged ports; the real TLS
        # connection still uses the temporary listener's unprivileged socket.
        for port, host, origin, expected in [(443, "localhost", "https://localhost", 200),
                (443, "[::1]", "https://[::1]", 200), (443, "[2001:db8::1]", "https://[2001:db8::1]", 403),
                (80, "localhost", "https://localhost", 403), (80, "localhost:80", "https://localhost:80", 200)]:
            with self.subTest(port=port, host=host), patch.object(self.server, "server_port", port):
                self.assertEqual(self.request("GET", "/api/health", headers={"Host": host, "Origin": origin})[0], expected)
        with patch.object(self.server, "server_port", 443), patch.object(self.server, "allowed_hosts", ["family.local"]):
            self.assertEqual(self.request("GET", "/api/health", headers={"Host": "family.local", "Origin": "https://family.local"})[0], 200)
        http = self.start_server(tls=False)
        for port, host, expected in [(80, "localhost", 200), (443, "localhost", 403), (443, "localhost:443", 200)]:
            with self.subTest(http_port=port, host=host), patch.object(http, "server_port", port):
                self.assertEqual(self.request("GET", "/api/health", headers={"Host": host, "Origin": "http://" + host}, server=http)[0], expected)

    def test_bad_tls_configuration_fails_before_creating_any_user_data(self):
        invalid = Path(self.directory.name) / "invalid.pem"
        invalid.write_text("this is not a certificate or private key")
        for index, (cert, key) in enumerate([(self.cert, None), (None, self.key), (invalid, self.key), (self.cert, invalid),
                                            (Path(self.directory.name) / "missing.crt", self.key), ("", "")]):
            data = Path(self.directory.name) / f"untouched-{index}" / "workspace.db"
            with self.subTest(cert=cert, key=key), self.assertRaises(APIError):
                create_server(port=0, db_path=data, tls_cert=cert, tls_key=key)
            self.assertFalse(data.parent.exists())
        data = Path(self.directory.name) / "cli-untouched" / "workspace.db"
        result = subprocess.run([sys.executable, "-m", "fountain.server", "--data", str(data), "--tls-cert", str(self.cert)],
                                capture_output=True, text=True, timeout=5, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(result.returncode, 2)
        self.assertIn("--tls-cert and --tls-key", result.stderr)
        self.assertFalse(data.parent.exists())
        self.assertNotIn("Traceback", result.stderr)
        result = subprocess.run([sys.executable, "-m", "fountain.server", "--data", str(data),
            "--tls-cert", str(invalid), "--tls-key", str(self.key)], capture_output=True, text=True,
            timeout=5, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unable to load the TLS certificate", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(data.parent.exists())

    def test_startup_and_bind_failures_close_store_and_failed_listening_socket(self):
        closed, socket_closed = [], []
        original_close = Store.close
        original_server_close = FountainServer.server_close
        def close(store):
            closed.append(store)
            return original_close(store)
        def server_close(server):
            result = original_server_close(server)
            socket_closed.append(server.socket.fileno())
            return result
        occupied = socket.socket()
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        try:
            with patch.object(Store, "close", close), patch.object(FountainServer, "server_close", server_close):
                with self.assertRaises(OSError):
                    create_server(port=occupied.getsockname()[1], db_path=Path(self.directory.name) / "bind-failure.db",
                                  tls_cert=self.cert, tls_key=self.key)
            self.assertEqual(len(closed), 1)
            self.assertIn(-1, socket_closed)
            with self.assertRaises(sqlite3.ProgrammingError): closed[0].db.execute("SELECT 1")
            with patch.object(Store, "close", close), patch("fountain.server.Application", side_effect=RuntimeError("startup failed")):
                with self.assertRaises(RuntimeError):
                    create_server(port=0, db_path=Path(self.directory.name) / "startup-failure.db", tls_cert=self.cert, tls_key=self.key)
            self.assertEqual(len(closed), 2)
            with self.assertRaises(sqlite3.ProgrammingError): closed[1].db.execute("SELECT 1")
        finally:
            occupied.close()


if __name__ == "__main__": unittest.main()
