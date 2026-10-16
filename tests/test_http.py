import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from fountain.server import create_server


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        static = Path(cls.temp.name)
        (static / "index.html").write_text("<h1>Fountain</h1>")
        cls.server = create_server(port=0, db_path=":memory:", static=static)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server.application.store.close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        data = json.dumps(body).encode() if body is not None else None
        defaults = {"Content-Type": "application/json", "X-Fountain-Request": "1"}
        defaults.update(headers or {})
        connection.request(method, path, data, defaults)
        response = connection.getresponse()
        raw = response.read()
        content_type = response.getheader("Content-Type", "")
        result = json.loads(raw) if "json" in content_type else raw.decode()
        status = response.status
        connection.close()
        return status, result

    def test_page_edit_conflict_comment_trash_and_restore(self):
        status, page = self.request("POST", "/api/pages", {"title": "HTTP 저장"})
        self.assertEqual(status, 201)
        path = "/api/pages/" + page["id"]
        status, saved = self.request("PUT", path + "/blocks", {"blocks": [{"type": "paragraph", "text": "내용"}], "revision": 0})
        self.assertEqual(status, 200)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(self.request("PUT", path + "/blocks", {"blocks": [], "revision": 0})[0], 409)
        self.assertEqual(self.request("POST", path + "/comments", {"text": "확인"})[0], 201)
        self.assertEqual(self.request("DELETE", path)[1]["archived"], True)
        self.assertFalse(self.request("POST", path + "/restore")[1]["archived"])
        detail = self.request("GET", path)[1]
        self.assertEqual(detail["comments"][0]["text"], "확인")

    def test_concurrent_edits_cannot_silently_overwrite(self):
        from concurrent.futures import ThreadPoolExecutor
        page = self.request("POST", "/api/pages", {"title": "경합"})[1]
        path = "/api/pages/" + page["id"] + "/blocks"
        def edit(value):
            return self.request("PUT", path, {"blocks": [{"type": "paragraph", "text": value}], "revision": 0})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(edit, ["첫째", "둘째"]))
        self.assertEqual(sorted(statuses), [200, 409])

    def test_origin_header_and_host_protection(self):
        for origin in ["null", "https://evil.example", "http://localhost:1"]:
            self.assertEqual(self.request("POST", "/api/pages", {"title": "bad"}, {"Origin": origin})[0], 403)
        self.assertEqual(self.request("POST", "/api/pages", {}, {"X-Fountain-Request": ""})[0], 403)
        self.assertEqual(self.request("GET", "/api/workspace", headers={"Host": "evil.example"})[0], 403)
        origin = f"http://127.0.0.1:{self.server.server_port}"
        self.assertEqual(self.request("GET", "/api/workspace", headers={"Origin": origin})[0], 200)

    def test_path_traversal_and_static_security_headers(self):
        for path in ["/../fountain/core.py", "/%2e%2e/fountain/core.py", "/%2fetc/passwd", "/%00"]:
            self.assertEqual(self.request("GET", path)[0], 404)
        self.assertIn("Fountain", self.request("GET", "/")[1])
        self.assertEqual(self.request("GET", "/api/missing")[0], 404)

    def test_invalid_json_and_method_bounds(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request("POST", "/api/pages", "{", {"Content-Type": "application/json", "X-Fountain-Request": "1"})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        connection.close()
        self.assertEqual(self.request("POST", "/api/pages", [1, 2])[0], 400)
        self.assertEqual(self.request("POST", "/api/pages", {}, {"Content-Length": "10000001"})[0], 413)
        self.assertEqual(self.request("GET", "/api/databases/projects?filters=not-json")[0], 400)

    def test_rows_roundtrip_and_cross_database_delete(self):
        status, row = self.request("POST", "/api/databases/projects/rows", {"properties": {"name": "HTTP 프로젝트", "status": "시작 전"}})
        self.assertEqual(status, 201)
        path = "/api/databases/projects/rows/" + row["id"]
        self.assertEqual(self.request("PATCH", path, {"properties": {"status": "완료"}})[1]["properties"]["status"], "완료")
        self.assertEqual(self.request("DELETE", "/api/databases/missing/rows/" + row["id"])[0], 404)
        self.assertEqual(self.request("DELETE", path)[0], 200)
        self.assertNotIn(row["id"], [r["id"] for r in self.request("GET", "/api/databases/projects")[1]["rows"]])

    def test_analytics_counts_are_not_projected_as_row_records(self):
        status, result = self.request('GET', '/api/analytics')
        self.assertEqual(status, 200)
        self.assertIs(type(result['rows']), int)
        self.assertGreaterEqual(result['rows'], 3)


if __name__ == "__main__": unittest.main()
