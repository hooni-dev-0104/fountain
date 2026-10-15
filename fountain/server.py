"""Local-only HTTP application. Run: python -m fountain.server."""
from __future__ import annotations

import argparse
import json
import logging
import hmac
import os
from contextlib import nullcontext
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .core import APIError, Store, Workspace, require

LOG = logging.getLogger("fountain")
STATIC = Path(__file__).resolve().parent.parent / "static"
MAX_BODY = 10_000_000


class Application:
    def __init__(self, store, static=STATIC):
        self.store, self.workspace, self.static = store, Workspace(store), Path(static).resolve()
        from .auth import Auth
        self.auth = Auth(store)
        self.advanced = None

    def dispatch(self, method, path, body, query):
        with self.store.lock:
            if self.advanced is None:
                try:
                    from .advanced import Advanced
                except ImportError as exc:
                    if exc.name != "fountain.advanced": raise
                else:
                    self.advanced = Advanced(self.store, self.workspace)
            transaction = self.store.transaction() if method in {'POST', 'PATCH', 'PUT', 'DELETE'} else nullcontext()
            with transaction:
                return self._dispatch(method, path, body, query)

    def _dispatch(self, method, path, body, query):
        w, s = self.workspace, self.store
        parts = path.strip("/").split("/")
        if path == "/api/health" and method == "GET":
            return 200, {"ok": True}
        if path == "/api/workspace" and method == "GET":
            snapshot = w.snapshot()
            if self.advanced: snapshot['settings'].update(self.advanced.settings())
            return 200, snapshot
        if path == "/api/pages" and method == "POST":
            return 201, w.create_page(body)
        if len(parts) >= 3 and parts[:2] == ["api", "pages"]:
            page_id = parts[2]
            if len(parts) == 3:
                if method == "GET":
                    detail = w.detail(page_id)
                    s.audit('page.viewed', {'page_id': page_id})
                    return 200, detail
                if method == "PATCH": return 200, w.update_page(page_id, body)
                if method == "DELETE": return 200, w.update_page(page_id, {"archived": True})
            if len(parts) == 4:
                if parts[3] == "blocks" and method == "PUT": return 200, w.save_blocks(page_id, body.get("blocks"), body.get("revision"))
                if parts[3] == "restore" and method == "POST": return 200, w.update_page(page_id, {"archived": False})
                if parts[3] == "comments" and method == "POST": return 201, w.create_comment(page_id, body)
            if len(parts) == 6 and parts[3] == "versions" and parts[5] == "restore" and method == "POST":
                return 200, w.restore_version(page_id, parts[4])
        if len(parts) == 3 and parts[:2] == ["api", "comments"] and method == "PATCH":
            comment = s.get("comment", parts[2])
            require(comment, "Comment not found", 404)
            require(type(body.get("resolved")) is bool, "resolved must be boolean")
            comment["resolved"] = body["resolved"]
            return 200, s.put("comment", comment)
        if path == "/api/search" and method == "GET":
            result = w.search(query.get("q", [""])[0])
            s.audit('workspace.searched', {'results': len(result['results'])})
            return 200, result
        if path == "/api/databases" and method == "POST":
            return 201, w.create_database(body)
        if len(parts) >= 3 and parts[:2] == ["api", "databases"]:
            database_id = parts[2]
            if len(parts) == 3 and method == "GET":
                def parse_option(key):
                    try: return json.loads(query[key][0]) if key in query else None
                    except ValueError: raise APIError(400, f"Invalid {key} JSON")
                return 200, w.database_detail(database_id, parse_option("filters"), parse_option("sorts"))
            if len(parts) == 3 and method == "PATCH":
                database = w.database(database_id)
                if "name" in body:
                    from .core import text
                    database["name"] = text(body["name"], "name", 500, False)
                if "properties" in body:
                    database["properties"] = w.validate_properties(body["properties"])
                if "views" in body:
                    require(isinstance(body["views"], list) and len(body["views"]) <= 50, "Invalid views")
                    database["views"] = body["views"]
                return 200, s.put("database", database)
            if len(parts) == 4 and parts[3] == "rows" and method == "POST":
                row = w.create_row(database_id, body)
                if self.advanced: self.advanced.trigger("row.created", database_id, row)
                return 201, s.get("row", row["id"])
            if len(parts) == 5 and parts[3] == "rows":
                if method == "PATCH":
                    row = w.update_row(database_id, parts[4], body)
                    if self.advanced: self.advanced.trigger("row.updated", database_id, row)
                    return 200, s.get("row", row["id"])
                if method == "DELETE":
                    w.database(database_id)
                    row = s.get("row", parts[4])
                    require(row and row["database_id"] == database_id, "Row not found", 404)
                    s.delete("row", parts[4])
                    return 200, {"deleted": True}
        if path == "/api/export" and method == "GET":
            require(not self.advanced or not self.advanced.settings().get("disable_export"), "Workspace export is disabled", 403)
            return 200, w.export(query.get("format", ["json"])[0], query.get("database", [None])[0])
        if path == "/api/import" and method == "POST":
            return 201, w.import_data(body)
        if path == "/api/attachments" and method == "POST":
            attachment = w.attachment(body)
            return 201, {k: v for k, v in attachment.items() if k != "data"}
        if len(parts) == 3 and parts[:2] == ["api", "attachments"] and method == "GET":
            attachment = s.get("attachment", parts[2])
            require(attachment, "Attachment not found", 404)
            return 200, attachment
        if self.advanced:
            response = self.advanced.dispatch(method, path, body, query)
            if response is not None: return response
        raise APIError(404, "Route not found")


def handler_for(application):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Fountain/0.1"
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):
            LOG.info(format, *args)

        def send_payload(self, status, payload):
            data = b"" if status == 204 else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            self.send_bytes(status, data, "application/json; charset=utf-8")

        def send_bytes(self, status, data, content_type):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if getattr(self, '_cookie_header', None): self.send_header('Set-Cookie', self._cookie_header)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            if self.command != "HEAD": self.wfile.write(data)

        def handle_request(self):
            try:
                self._cookie_header = None
                # Prevent DNS rebinding against the unauthenticated local application.
                host = self.headers.get("Host", "")
                allowed = {f"localhost:{self.server.server_port}", f"127.0.0.1:{self.server.server_port}", f"[::1]:{self.server.server_port}"}
                for allowed_host in self.server.allowed_hosts:
                    allowed.add(f'{allowed_host}:{self.server.server_port}')
                if self.server.server_port == 80: allowed.update({"localhost", "127.0.0.1", "[::1]"})
                require(host in allowed, "Untrusted Host", 403)
                origin = self.headers.get("Origin")
                require(origin is None or origin == "http://" + host, "Untrusted Origin", 403)
                url = urlparse(self.path)
                require(not url.scheme and not url.netloc, "Invalid request target")
                path = unquote(url.path)
                is_scim = path.startswith('/scim/v2/')
                if is_scim:
                    token = os.environ.get('FOUNTAIN_SCIM_TOKEN')
                    require(bool(token), 'SCIM is not configured', 503)
                    supplied = self.headers.get('Authorization', '')
                    require(hmac.compare_digest(supplied.encode(), ('Bearer ' + token).encode()), 'SCIM authentication required', 401)
                body = {}
                if self.command in {"POST", "PATCH", "PUT", "DELETE"}:
                    require(is_scim or self.headers.get("X-Fountain-Request") == "1", "Missing request verification header", 403)
                    require(self.headers.get("Transfer-Encoding") is None, "Transfer encoding is unsupported")
                    try: length = int(self.headers.get("Content-Length", "0"))
                    except ValueError: raise APIError(400, "Invalid Content-Length")
                    require(0 <= length <= MAX_BODY, "Request exceeds 10 MB", 413)
                    if length:
                        require(self.headers.get_content_type() in ({"application/json", "application/scim+json"} if is_scim else {"application/json"}), "Expected application/json", 415)
                        try:
                            raw = self.rfile.read(length)
                            require(len(raw) == length, "Incomplete request")
                            body = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
                        except (ValueError, UnicodeDecodeError): raise APIError(400, "Invalid JSON")
                        require(isinstance(body, dict), "JSON body must be an object")
                method = "GET" if self.command == "HEAD" else self.command
                cookie = self.headers.get('Cookie', '')
                if path == '/api/session':
                    auth = application.auth
                    if method == 'GET':
                        self.send_payload(200, {**auth.session_info(cookie), 'required': auth.enabled})
                        return
                    if method == 'POST':
                        token = auth.login(body, self.client_address[0])
                        self._cookie_header = 'fountain_session=' + token + '; Max-Age=604800; HttpOnly; SameSite=Strict; Path=/'
                        self.send_payload(200, {'authenticated': True, 'required': True, 'mode': 'family'})
                        return
                    if method == 'DELETE':
                        auth.logout(cookie)
                        self._cookie_header = 'fountain_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'
                        self.send_payload(200, {'authenticated': not auth.enabled, 'required': auth.enabled})
                        return
                    raise APIError(405, 'Unsupported session method')
                if path.startswith(('/api/', '/sites/', '/forms/')) and path != '/api/health':
                    require(application.auth.authenticate(cookie), '가족 로그인 후 사용할 수 있습니다', 401)
                if path.startswith(("/api/", "/sites/", "/forms/", "/scim/v2/")):
                    status, payload = application.dispatch(method, path, body, parse_qs(url.query, keep_blank_values=True))
                    if path.startswith(("/sites/", "/forms/")) and isinstance(payload, dict) and "_html" in payload:
                        self.send_bytes(status, payload["_html"].encode(), "text/html; charset=utf-8")
                    else:
                        self.send_payload(status, payload)
                    return
                require(method == "GET", "Route not found", 404)
                require("\x00" not in path and "\\" not in path and ".." not in path.split("/"), "Invalid asset path", 404)
                target = (application.static / (path.lstrip("/") or "index.html")).resolve()
                require(target.is_relative_to(application.static) and target.is_file(), "Asset not found", 404)
                self.send_bytes(200, target.read_bytes(), mimetypes.guess_type(str(target))[0] or "application/octet-stream")
            except APIError as exc:
                self.close_connection = True
                self.send_payload(exc.status, {"error": exc.message, "message": exc.message})
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            except Exception:
                LOG.exception("Request failed")
                self.close_connection = True
                self.send_payload(500, {"error": "Internal server error", "message": "Internal server error"})

        do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = handle_request

    return Handler


def create_server(host="127.0.0.1", port=8787, db_path=".data/fountain.db", static=STATIC, allowed_hosts=None):
    allowed_hosts = allowed_hosts or []
    require(all(isinstance(h, str) and h and not any(c in h for c in '/:@ \t\r\n') for h in allowed_hosts), 'Invalid allowed host')
    if host not in {'127.0.0.1', 'localhost'}:
        require(host == '0.0.0.0', 'Use 0.0.0.0 for family network access')
        require(bool(os.environ.get('FOUNTAIN_ACCESS_TOKEN')) and allowed_hosts, 'Family network access requires FOUNTAIN_ACCESS_TOKEN and --allowed-host')
    if str(db_path) != ":memory:": Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    store = Store(db_path)
    application = Application(store, static)
    server = ThreadingHTTPServer((host, port), handler_for(application))
    server.application = application
    server.allowed_hosts = allowed_hosts
    return server


def main():
    parser = argparse.ArgumentParser(description="Run Fountain locally")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--allowed-host", action="append", default=[], help="LAN hostname or IP allowed by Host validation")
    parser.add_argument("--data", default=".data/fountain.db")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = create_server(args.host, args.port, args.data, allowed_hosts=args.allowed_host)
    print(f"Fountain: http://localhost:{server.server_port}", flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        server.server_close()
        server.application.store.close()


if __name__ == "__main__":
    main()
