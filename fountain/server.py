"""Local-only HTTP application. Run: python -m fountain.server."""
from __future__ import annotations

import argparse
import copy
import base64
import io
import shutil
import tempfile
from dataclasses import dataclass
import json
import logging
import hmac
import os
from contextlib import nullcontext
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse, quote

from .core import APIError, Store, Workspace, require, AUDIT_ACTOR, CURRENT_ACCESS
from .access import Access
from .authorization import Authorization

LOG = logging.getLogger("fountain")
STATIC = Path(__file__).resolve().parent.parent / "static"
MAX_BODY = 10_000_000
_INTERNAL_PRINCIPAL = object()


@dataclass
class Download:
    filename: str
    data: bytes | Path
    cleanup_dir: str | None = None


class Application:
    def __init__(self, store, static=STATIC):
        self.store, self.workspace, self.static = store, Workspace(store), Path(static).resolve()
        from .auth import Auth
        self.auth = Auth(store)
        self.advanced = None
        from .scheduler import Scheduler
        self.scheduler = Scheduler(store, self.run_scheduled)

    def run_scheduled(self, automation_id, body):
        if self.advanced is None:
            from .advanced import Advanced
            self.advanced = Advanced(self.store, self.workspace)
        return self.advanced.run_as_author(automation_id, body)

    def dispatch(self, method, path, body, query, principal=_INTERNAL_PRINCIPAL):
        body = copy.deepcopy(body)
        with self.store.lock:
            if principal is _INTERNAL_PRINCIPAL:
                principal = {'id': 'local', 'role': 'owner', 'active': True, '_service': True}
            else:
                require(isinstance(principal, dict), 'Authentication required', 401)
            if self.auth.accounts_required and not principal.get('_service'):
                principal = self.auth._member(principal.get('id'))
                require(principal is not None, 'Authentication required', 401)
            access = Access(self.store, principal)
            authority = Authorization(access)
            if self.advanced is None:
                from .advanced import Advanced
                self.advanced = Advanced(self.store, self.workspace)
            authority.prepare(method, path, body)
            if not (method == 'POST' and path == '/api/ai'):
                transaction = self.store.transaction() if method in {'POST', 'PATCH', 'PUT', 'DELETE'} else nullcontext()
                token = AUDIT_ACTOR.set(access.member_id)
                access_token = CURRENT_ACCESS.set(access)
                try:
                    with transaction:
                        status, payload = self._dispatch(method, path, body, query, access)
                        if method in {'POST', 'PATCH', 'PUT', 'DELETE'} and (path.startswith('/api/members') or path.startswith('/scim/v2/Users') or path.startswith('/api/accounts')):
                            require(not self.auth.accounts_required or self.auth._owners(), 'Cannot remove the last active owner account', 409)
                        return status, authority.project(path, payload)
                finally:
                    AUDIT_ACTOR.reset(token)
                    CURRENT_ACCESS.reset(access_token)
        # Inference has no write transaction or workspace-wide lock across the network.
        token = AUDIT_ACTOR.set(access.member_id)
        access_token = CURRENT_ACCESS.set(access)
        try:
            status, payload = self.advanced.dispatch(method, path, body, query)
            return status, authority.project(path, payload)
        finally:
            AUDIT_ACTOR.reset(token)
            CURRENT_ACCESS.reset(access_token)

    def remove_access_references(self, kind, identity):
        field = 'members' if kind == 'member' else 'groups'
        for entity_kind in ('page', 'database', 'row', 'teamspace', 'group'):
            for item in self.store.list(entity_kind):
                changed = False
                grants = (item.get('permissions') or {}).get(field, {})
                if identity in grants:
                    del grants[identity]
                    changed = True
                if entity_kind in {'teamspace', 'group'} and isinstance(item.get(field), list) and identity in item[field]:
                    item[field].remove(identity)
                    changed = True
                if changed: self.store.put(entity_kind, item)

    @staticmethod
    def row_policy(body, database):
        require(isinstance(body, dict) and set(body) <= {'mode', 'property_id', 'edit_assigned', 'allow_create'}, 'Invalid row permissions')
        require(body.get('mode', 'all') in {'all', 'assigned'}, 'Invalid row permission mode')
        for key in ('edit_assigned', 'allow_create'):
            if key in body: require(type(body[key]) is bool, 'Row permission flags must be boolean')
        if body.get('mode') == 'assigned':
            require(any(p.get('id') == body.get('property_id') and p.get('type') in {'person', 'text', 'email', 'multi_select'} for p in database['properties']), 'Choose an assignment property')
        return copy.deepcopy(body)

    def _dispatch(self, method, path, body, query, access):
        w, s = self.workspace, self.store
        parts = path.strip("/").split("/")
        if path == '/api/accounts' and method == 'GET':
            return 200, {'accounts': self.auth.list_accounts(), 'required': self.auth.accounts_required}
        if path == '/api/accounts' and method == 'POST':
            result = self.auth.create_account(body.get('member_id'), body.get('password'))
            s.audit('account.created', {'member_id': result['id']})
            return 201, result
        if path == '/api/accounts/enable' and method == 'POST':
            result = self.auth.enable_accounts()
            s.audit('account.login.required', {})
            return 200, result
        if len(parts) == 3 and parts[:2] == ['api', 'accounts']:
            if method == 'PATCH':
                result = self.auth.set_password(parts[2], body.get('password'))
                s.audit('account.password.changed', {'member_id': parts[2]})
                return 200, result
            if method == 'DELETE':
                result = self.auth.remove_account(parts[2])
                s.audit('account.removed', {'member_id': parts[2]})
                return 200, result
        if len(parts) == 4 and parts[0] == 'api' and parts[1] in {'pages', 'databases'} and parts[3] == 'permissions':
            kind = 'page' if parts[1] == 'pages' else 'database'
            item = access.require_resource(kind, parts[2], 4 if method == 'PATCH' else 1)
            if method == 'PATCH':
                if 'permissions' in body: item['permissions'] = access.validate_permissions(body['permissions'])
                if 'row_permissions' in body and kind == 'database': item['row_permissions'] = self.row_policy(body['row_permissions'], item)
                s.put(kind, item)
                s.audit(kind + '.permissions.changed', {'id': item['id']})
            require(method in {'GET', 'PATCH'}, 'Unsupported permissions method', 405)
            safe_members = access.filter_workspace({'members': s.list('member')})['members']
            return 200, {'permissions': item.get('permissions') or {'default': 'workspace', 'members': {}, 'groups': {}, 'inherit': bool(item.get('parent_id'))},
                         'row_permissions': item.get('row_permissions', {}), 'owner_id': item.get('owner_id', 'local'),
                         'can_manage': access.can(kind, item, 4), 'members': safe_members,
                         'groups': s.list('group') if access.can(kind, item, 4) else []}
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
            s.audit("comment.resolved", {"page_id": comment["page_id"], "id": comment["id"]})
            return 200, s.put("comment", comment)
        if path == "/api/search" and method == "GET":
            result = w.search(query.get("q", [""])[0])
            s.audit('workspace.searched', {'results': len(result['results'])})
            return 200, result
        if path == "/api/databases" and method == "POST":
            if "row_permissions" in body: body["row_permissions"] = self.row_policy(body["row_permissions"], {"properties": w.validate_properties(body.get("properties", []))})
            return 201, w.create_database(body)
        if len(parts) >= 3 and parts[:2] == ["api", "databases"]:
            database_id = parts[2]
            if len(parts) == 3 and method == "GET":
                def parse_option(key):
                    try: return json.loads(query[key][0]) if key in query else None
                    except ValueError: raise APIError(400, f"Invalid {key} JSON")
                return 200, w.database_detail(database_id, parse_option("filters"), parse_option("sorts"), lambda row: access.can("row", row))
            if len(parts) == 3 and method == "PATCH":
                database = w.database(database_id)
                if "name" in body:
                    from .core import text
                    database["name"] = text(body["name"], "name", 500, False)
                if "properties" in body:
                    database["properties"] = w.validate_properties(body["properties"])
                if "task_settings" in body or "properties" in body:
                    from .tasks import validate_settings
                    database["task_settings"] = validate_settings(body.get("task_settings", {}), database)
                if "views" in body:
                    require(isinstance(body["views"], list) and len(body["views"]) <= 50, "Invalid views")
                    database["views"] = body["views"]
                return 200, s.put("database", database)
            if len(parts) == 4 and parts[3] == "rows" and method == "POST":
                row = w.create_row(database_id, body)
                if self.advanced:
                    self.advanced.trigger("row.created", database_id, row)
                    row = s.get("row", row["id"])
                return 201, s.get("row", row["id"])
            if len(parts) == 6 and parts[3] == 'rows' and parts[5] == 'duplicate' and method == 'POST':
                result = w.duplicate_row(database_id, parts[4], lambda row: access.can('row', row))
                if self.advanced:
                    for row in result['rows']: self.advanced.trigger('row.created', database_id, row)
                    result['rows'] = [s.get('row', row['id']) for row in result['rows']]
                return 201, result
            if len(parts) == 5 and parts[3] == "rows":
                if method == "PATCH":
                    row = w.update_row(database_id, parts[4], body)
                    if self.advanced:
                        self.advanced.trigger("row.updated", database_id, row)
                        row = s.get("row", row["id"])
                    return 200, s.get("row", row["id"])
                if method == "DELETE":
                    return 200, w.delete_row(database_id, parts[4], lambda row: access.can("row", row, 3))
        if path == "/api/export" and method == "GET":
            require(not self.advanced or not self.advanced.settings().get("disable_export"), "Workspace export is disabled", 403)
            return 200, w.export(query.get("format", ["json"])[0], query.get("database", [None])[0])
        if path == '/api/backup' and method == 'GET':
            from .backup import create_backup, BackupError
            require(not self.advanced or not self.advanced.settings().get('disable_export'), 'Workspace export is disabled', 403)
            directory = tempfile.mkdtemp(prefix='fountain-download-')
            target = Path(directory) / 'fountain-backup.db'
            try:
                create_backup(s.db, target)
            except (BackupError, OSError) as error:
                shutil.rmtree(directory)
                raise APIError(503, '전체 백업을 생성하지 못했습니다') from error
            s.audit('workspace.backup.created', {})
            return 200, Download('fountain-backup.db', target, directory)
        if path == "/api/import" and method == "POST":
            return 201, w.import_data(body)
        if path == "/api/attachments" and method == "POST":
            attachment = w.attachment(body)
            return 201, {k: v for k, v in attachment.items() if k != "data"}
        if len(parts) == 3 and parts[:2] == ["api", "attachments"] and method == "GET":
            attachment = s.get("attachment", parts[2])
            require(attachment, "Attachment not found", 404)
            return 200, attachment
        if len(parts) == 4 and parts[:2] == ['api', 'attachments'] and parts[3] == 'download' and method == 'GET':
            attachment = s.get('attachment', parts[2])
            require(attachment, 'Attachment not found', 404)
            return 200, Download(attachment['name'], base64.b64decode(attachment['data']))
        if len(parts) == 3 and parts[:2] == ['api', 'attachments'] and method == 'DELETE':
            require(s.get('attachment', parts[2]), 'Attachment not found', 404)
            require(not any(block.get('attachment_id') == parts[2] for page in s.list('page') + s.list('version') for block in page.get('blocks', [])), 'Attachment is still referenced by a document', 409)
            for row in s.list('row'):
                database = s.get('database', row.get('database_id')) or {}
                file_fields = [prop['id'] for prop in database.get('properties', []) if prop.get('type') == 'files']
                require(not any(parts[2] in (row.get('properties', {}).get(key) or []) for key in file_fields), 'Attachment is still referenced by a database row', 409)
            s.delete('attachment', parts[2])
            return 200, {'deleted': True}
        if self.advanced:
            response = self.advanced.dispatch(method, path, body, query)
            if response is not None:
                member_change = len(parts) == 3 and parts[:2] == ['api', 'members']
                scim_change = len(parts) == 4 and parts[:3] == ['scim', 'v2', 'Users']
                if method in {'DELETE', 'PATCH', 'PUT'} and (member_change or scim_change):
                    member_id = parts[-1]
                    member = s.get('member', member_id)
                    if method == 'DELETE' or (member and member.get('active', True) is not True):
                        self.auth._revoke(member_id)
                    if method == 'DELETE':
                        s.delete('credential', member_id)
                        self.remove_access_references('member', member_id)
                group_deleted = method == 'DELETE' and ((len(parts) == 3 and parts[:2] == ['api', 'groups']) or (len(parts) == 4 and parts[:3] == ['scim', 'v2', 'Groups']))
                if group_deleted: self.remove_access_references('group', parts[-1])
                return response
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

        def send_download(self, download):
            try:
                size = download.data.stat().st_size if isinstance(download.data, Path) else len(download.data)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Disposition', "attachment; filename=download; filename*=UTF-8''" + quote(download.filename, safe=''))
                self.send_header('Content-Length', str(size))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                if self.command != 'HEAD':
                    source = download.data.open('rb') if isinstance(download.data, Path) else io.BytesIO(download.data)
                    with source:
                        shutil.copyfileobj(source, self.wfile, length=64 * 1024)
            finally:
                if download.cleanup_dir:
                    shutil.rmtree(download.cleanup_dir)

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
                        self.send_payload(200, auth.session_info('fountain_session=' + token))
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
                    principal = {'id': 'scim', 'role': 'owner', 'active': True, '_service': True} if is_scim else application.auth.principal(cookie)
                    if principal is None and path == '/api/health': principal = {'id': 'health', 'role': 'guest', 'active': True, '_service': True}
                    require(principal is not None, 'Authentication required', 401)
                    status, payload = application.dispatch(method, path, body, parse_qs(url.query, keep_blank_values=True), principal=principal)
                    if isinstance(payload, Download):
                        self.send_download(payload)
                    elif path.startswith(("/sites/", "/forms/")) and isinstance(payload, dict) and "_html" in payload:
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


class FountainServer(ThreadingHTTPServer):
    def serve_forever(self, poll_interval=0.5):
        self.application.scheduler.start()
        try:
            super().serve_forever(poll_interval)
        finally:
            self.application.scheduler.stop()

    def server_close(self):
        if hasattr(self, 'application'):
            self.application.scheduler.stop()
        super().server_close()


def create_server(host="127.0.0.1", port=8787, db_path=".data/fountain.db", static=STATIC, allowed_hosts=None):
    allowed_hosts = allowed_hosts or []
    require(all(isinstance(h, str) and h and not any(c in h for c in '/:@ \t\r\n') for h in allowed_hosts), 'Invalid allowed host')
    if host not in {'127.0.0.1', 'localhost'}:
        require(host == '0.0.0.0', 'Use 0.0.0.0 for family network access')
        require(allowed_hosts, 'Family network access requires --allowed-host')
    if str(db_path) != ':memory:':
        database_path = Path(db_path)
        database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            descriptor = os.open(database_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(descriptor)
    store = Store(db_path)
    try:
        application = Application(store, static)
        if host not in {'127.0.0.1', 'localhost'}:
            require(application.auth.enabled, 'Family network access requires FOUNTAIN_ACCESS_TOKEN or individual accounts')
    except Exception:
        store.close()
        raise
    server = FountainServer((host, port), handler_for(application))
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
