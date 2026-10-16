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
import threading
import re
import sqlite3
import ssl
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
    attachment_id: str | None = None


@dataclass
class AttachmentDownload:
    filename: str
    attachment_id: str
    size: int
    sha256: str | None = None


def byte_range(value, size):
    """One inclusive HTTP byte range, returned as Python's exclusive end."""
    if not value:
        return 0, size, False
    if value.split('=', 1)[0].lower() != 'bytes':
        return 0, size, False
    match = re.fullmatch(r'bytes=([0-9]*)-([0-9]*)', value)
    require(match is not None and any(match.groups()) and size > 0, 'Unsatisfiable byte range', 416)
    first, last = match.groups()
    # Bound decimal parsing even when the header is deliberately enormous.
    require(len(first) <= 20 and len(last) <= 20, 'Unsatisfiable byte range', 416)
    if not first:
        suffix = int(last)
        require(suffix > 0, 'Unsatisfiable byte range', 416)
        return max(0, size - suffix), size, True
    start = int(first)
    end = min(size, int(last) + 1) if last else size
    require(start < size and end > start, 'Unsatisfiable byte range', 416)
    return start, end, True


class Application:
    def __init__(self, store, static=STATIC):
        self.store, self.workspace, self.static = store, Workspace(store), Path(static).resolve()
        from .auth import Auth
        self.auth = Auth(store)
        from .attachments import FileStorage
        self.files = FileStorage(store)
        self.files.cleanup()
        from .collaboration import Collaboration
        self.collaboration = Collaboration(store, self.workspace)
        from .presence import PresenceService
        self.presence = PresenceService(store, self.auth)
        self.advanced = None
        from .scheduler import Scheduler
        self.scheduler = Scheduler(store, self.run_scheduled)

    def run_scheduled(self, automation_id, body):
        if self.advanced is None:
            from .advanced import Advanced
            self.advanced = Advanced(self.store, self.workspace)
        return self.advanced.run_as_author(automation_id, body)

    def _request_context(self, principal, session_cookie):
        """Resolve the original login while the caller holds the SQLite writer."""
        if session_cookie is not _INTERNAL_PRINCIPAL:
            info = self.auth.session_info(session_cookie)
            require(info.get('authenticated') and isinstance(info.get('member'), dict), 'Authentication required', 401)
            principal = info['member']
            binding = info['cache_binding']
        else:
            if principal is _INTERNAL_PRINCIPAL:
                principal = {'id': 'local', 'role': 'owner', 'active': True, '_service': True}
            require(isinstance(principal, dict), 'Authentication required', 401)
            binding = 'service:' + str(principal.get('id', ''))
        if self.auth.accounts_required and not principal.get('_service'):
            principal = self.auth._member(principal.get('id'))
            require(principal is not None, 'Authentication required', 401)
        return {'access': Access(self.store, principal), 'workspace_id': self.store.meta('workspace_id'),
                'session_binding': binding}

    def dispatch(self, method, path, body, query, principal=_INTERNAL_PRINCIPAL, session_cookie=_INTERNAL_PRINCIPAL):
        body = copy.deepcopy(body)
        parts = path.strip('/').split('/')
        if len(parts) == 4 and parts[:2] == ['api', 'pages'] and parts[3] == 'presence':
            require(method in {'GET', 'PUT', 'DELETE'}, 'Unsupported presence method', 405)
            # Presence has no service-principal impersonation: it always belongs
            # to a live browser login or the current no-login local binding.
            require(session_cookie is not _INTERNAL_PRINCIPAL, 'Presence requires an original session cookie context', 403)
            if method == 'GET': return 200, self.presence.snapshot(parts[2], session_cookie)
            action = self.presence.update if method == 'PUT' else self.presence.leave
            return 200, action(parts[2], body, session_cookie)
        if method == 'POST' and path == '/api/sync':
            # Each operation owns its commit and its fresh login/ACL check. Do
            # not surround the complete batch with this dispatch's transaction.
            from .sync import SyncService
            def context_factory():
                return self._request_context(principal, session_cookie)
            def dispatch_callback(verb, target, payload, context):
                return self.dispatch(verb, target, payload, {}, principal=context['access'].principal,
                                     session_cookie=session_cookie)
            return 200, SyncService(self.store).apply(body, context_factory, dispatch_callback)
        if method == 'POST' and path == '/api/ai':
            return self._ai(body, principal, session_cookie)
        canonical_snapshot = method == 'GET' and (path == '/api/workspace'
            or re.fullmatch(r'/api/databases/[^/]+', path) is not None)
        with self.store.lock:
            # Claim the workspace writer before authentication and ACL reads. A
            # process-local lock alone cannot fence logout in another server.
            claiming = (method in {'POST', 'PATCH', 'PUT', 'DELETE'}
                        or method == 'GET' and path != '/api/backup')
            # SQLite's backup API cannot copy its own open write transaction.
            # Backup downloads recheck owner/session before headers and each
            # bounded piece; generation itself does not expose private bytes.
            with self.store.transaction() if claiming else nullcontext():
                context = self._request_context(principal, session_cookie)
                access = context['access']
                authority = Authorization(access)
                if self.advanced is None:
                    from .advanced import Advanced
                    self.advanced = Advanced(self.store, self.workspace)
                authority.prepare(method, path, body)
                token = AUDIT_ACTOR.set(access.member_id)
                access_token = CURRENT_ACCESS.set(access)
                try:
                    status, payload = self._dispatch(method, path, body, query, access)
                    if method in {'POST', 'PATCH', 'PUT', 'DELETE'} and (path.startswith('/api/members') or path.startswith('/scim/v2/Users') or path.startswith('/api/accounts')):
                        require(not self.auth.accounts_required or self.auth._owners(), 'Cannot remove the last active owner account', 409)
                    if method in {'POST', 'PATCH', 'PUT', 'DELETE'} and (
                            path.endswith('/permissions') or path.startswith(('/api/members', '/api/groups', '/api/teamspaces', '/api/accounts', '/scim/v2/'))
                            or method == 'PATCH' and path.startswith('/api/pages/')):
                        self.store.set_meta('access_revision', self.store.meta('access_revision', 0) + 1)
                    payload = authority.project(path, payload)
                    if isinstance(payload, dict) and (canonical_snapshot or path.endswith(('/collaboration', '/operations'))):
                        payload.update(workspace_id=context['workspace_id'], current_member_id=access.member_id,
                            session_binding=context['session_binding'], access_revision=self.store.meta('access_revision', 0),
                            data_revision=self.store.meta('_entity_revision', 0))
                    return status, payload
                finally:
                    AUDIT_ACTOR.reset(token)
                    CURRENT_ACCESS.reset(access_token)

    def _ai(self, body, principal, session_cookie):
        with self.store.transaction():
            context = self._request_context(principal, session_cookie)
            access = context['access']
            Authorization(access).prepare('POST', '/api/ai', body)
            if self.advanced is None:
                from .advanced import Advanced
                self.advanced = Advanced(self.store, self.workspace)
            token = AUDIT_ACTOR.set(access.member_id)
            access_token = CURRENT_ACCESS.set(access)
            try:
                prepared = self.advanced.prepare_ai(body)
            finally:
                AUDIT_ACTOR.reset(token)
                CURRENT_ACCESS.reset(access_token)
            scope = (context['workspace_id'], access.member_id, context['session_binding'])
        # Neither a workspace lock, writer nor stale request access survives the
        # provider wait. Inference consumes only the already-authorized snapshot.
        result = self.advanced.infer_ai(prepared)
        with self.store.transaction():
            current = self._request_context(principal, session_cookie)
            access = current['access']
            require((current['workspace_id'], access.member_id, current['session_binding']) == scope,
                    'AI request session changed; start a new request', 401)
            authority = Authorization(access)
            authority.prepare('POST', '/api/ai', {'page_id': prepared['page_id']})
            token = AUDIT_ACTOR.set(access.member_id)
            access_token = CURRENT_ACCESS.set(access)
            try:
                return 200, authority.project('/api/ai', self.advanced.finish_ai(prepared, result))
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
                if parts[3] == 'collaboration' and method == 'GET':
                    return 200, self.collaboration.snapshot(page_id, access)
                if parts[3] == 'operations' and method == 'POST':
                    return 200, self.collaboration.apply(page_id, body, access)
                if parts[3] == "blocks" and method == "PUT": return 200, w.save_blocks(page_id, body.get("blocks"), body.get("revision"))
                if parts[3] == "restore" and method == "POST": return 200, w.update_page(page_id, {"archived": False})
                if parts[3] == "comments" and method == "POST": return 201, w.create_comment(page_id, body)
            if len(parts) == 6 and parts[3] == "versions" and parts[5] == "restore" and method == "POST":
                version = s.get('version', parts[4])
                require(version and version['page_id'] == page_id, 'Version not found', 404)
                page = w.page(page_id)
                require(not page.get('archived'), 'Page not found', 404)
                require(not page.get('locked'), 'Page is locked', 423)
                # dispatch already owns the workspace writer: compare the preview
                # revision before restoring blocks or replacing their CRDT epoch.
                w.check_revision(page, body.get('revision'))
                for block in version.get('blocks', []) if isinstance(version.get('blocks'), list) else []:
                    if isinstance(block, dict) and block.get('attachment_id'):
                        Authorization(access).attachment(block['attachment_id'])
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
                if getattr(s, 'backend', 'sqlite') == 'postgres':
                    from .postgres_backup import create_postgres_backup
                    create_postgres_backup(s, target)
                else:
                    create_backup(s.db, target)
            except BaseException as error:
                shutil.rmtree(directory)
                if isinstance(error, (BackupError, OSError, APIError)):
                    raise APIError(503, '전체 백업을 생성하지 못했습니다') from error
                raise
            s.audit('workspace.backup.created', {})
            return 200, Download('fountain-backup.db', target, directory)
        if path == "/api/import" and method == "POST":
            return 201, w.import_data(body)
        if path == '/api/uploads' and method == 'POST':
            self.files.cleanup()
            result = self.files.begin(body, access.member_id, access)
            s.audit('upload.started', {'upload_id': result['id'], 'size': result['size']})
            return 201, result
        if path == '/api/uploads/cleanup' and method == 'POST':
            return 200, self.files.cleanup()
        if len(parts) >= 3 and parts[:2] == ['api', 'uploads']:
            if len(parts) == 3 and method == 'GET':
                return 200, self.files.status(parts[2], access.member_id, access)
            if len(parts) == 3 and method == 'DELETE':
                result = self.files.cancel(parts[2], access.member_id, access)
                if result.get('cancelled'):
                    s.audit('upload.cancelled', {'upload_id': parts[2]})
                return 200, result
            if len(parts) == 4 and parts[3] == 'chunks' and method == 'PUT':
                return 200, self.files.append(parts[2], body.get('offset'), body.get('data'), access.member_id, access)
            if len(parts) == 4 and parts[3] == 'complete' and method == 'POST':
                previous = self.files.status(parts[2], access.member_id, access)
                result = self.files.complete(parts[2], access.member_id, access)
                if not previous['completed']:
                    s.audit('upload.completed', {'attachment_id': result['id'], 'size': result['size']})
                return 201, result
        if path == "/api/attachments" and method == "POST":
            attachment = w.attachment(body)
            return 201, {k: v for k, v in attachment.items() if k != "data"}
        if len(parts) == 3 and parts[:2] == ["api", "attachments"] and method == "GET":
            attachment = s.get("attachment", parts[2])
            require(attachment, "Attachment not found", 404)
            return 200, attachment
        if len(parts) == 4 and parts[:2] == ['api', 'attachments'] and parts[3] == 'metadata' and method == 'GET':
            from .attachments import MAX_FILE_SIZE
            attachment = s.get('attachment', parts[2])
            require(attachment, 'Attachment not found', 404)
            name, size = attachment.get('name'), attachment.get('size')
            mime, storage = attachment.get('mime', 'application/octet-stream'), attachment.get('storage', 'inline')
            require(isinstance(name, str) and 0 < len(name) <= 255 and type(size) is int and 0 <= size <= MAX_FILE_SIZE
                    and isinstance(mime, str) and 0 < len(mime) <= 255 and isinstance(storage, str) and storage in {'inline', 'chunks'},
                    'Attachment metadata is invalid', 409)
            metadata = {'id': attachment['id'], 'name': name, 'size': size, 'mime': mime, 'storage': storage, 'status': 'complete'}
            if 'sha256' in attachment:
                require(isinstance(attachment['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', attachment['sha256']) is not None,
                        'Attachment metadata is invalid', 409)
                metadata['sha256'] = attachment['sha256']
            return 200, metadata
        if len(parts) == 4 and parts[:2] == ['api', 'attachments'] and parts[3] == 'download' and method == 'GET':
            attachment = s.get('attachment', parts[2])
            require(attachment, 'Attachment not found', 404)
            if attachment.get('storage') == 'chunks':
                return 200, AttachmentDownload(attachment['name'], attachment['id'], attachment['size'], attachment.get('sha256'))
            return 200, Download(attachment['name'], base64.b64decode(attachment['data']), attachment_id=attachment['id'])
        if len(parts) == 3 and parts[:2] == ['api', 'attachments'] and method == 'DELETE':
            require(s.get('attachment', parts[2]), 'Attachment not found', 404)
            require(not any(block.get('attachment_id') == parts[2] for page in s.list('page') + s.list('version') for block in page.get('blocks', [])), 'Attachment is still referenced by a document', 409)
            for row in s.list('row'):
                database = s.get('database', row.get('database_id')) or {}
                file_fields = [prop['id'] for prop in database.get('properties', []) if prop.get('type') == 'files']
                require(not any(parts[2] in (row.get('properties', {}).get(key) or []) for key in file_fields), 'Attachment is still referenced by a database row', 409)
            s.chunk_delete(parts[2])
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
            if self.close_connection: self.send_header('Connection', 'close')
            if getattr(self, '_cookie_header', None): self.send_header('Set-Cookie', self._cookie_header)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            if self.command != "HEAD": self.wfile.write(data)

        def send_download(self, download):
            try:
                chunked = isinstance(download, AttachmentDownload)
                size = download.size if chunked else download.data.stat().st_size if isinstance(download.data, Path) else len(download.data)
                etag = '"' + download.sha256 + '"' if chunked and re.fullmatch('[0-9a-f]{64}', download.sha256 or '') else None
                requested = self.headers.get('Range') if self.command == 'GET' else None
                if self.headers.get('If-Range') and self.headers['If-Range'] != etag:
                    requested = None
                try:
                    start, end, partial = byte_range(requested, size)
                except APIError:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.end_headers()
                    return
                cookie = self.headers.get('Cookie', '')
                def authorize():
                    with application.store.transaction():
                        principal = application.auth.principal(cookie)
                        require(principal is not None, 'Authentication required', 401)
                        access = Access(application.store, principal)
                        if download.attachment_id:
                            Authorization(access).attachment(download.attachment_id)
                        elif download.cleanup_dir:
                            access.require_admin(owner_only=True)
                authorize()
                self.send_response(206 if partial else 200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Disposition', "attachment; filename=download; filename*=UTF-8''" + quote(download.filename, safe=''))
                self.send_header('Content-Length', str(end - start))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Accept-Ranges', 'bytes')
                if etag: self.send_header('ETag', etag)
                if partial: self.send_header('Content-Range', f'bytes {start}-{end - 1}/{size}')
                self.end_headers()
                if self.command != 'HEAD':
                    try:
                        if chunked:
                            for piece in application.files.iter_bytes(download.attachment_id, start, end):
                                authorize()
                                self.wfile.write(piece)
                        else:
                            source = download.data.open('rb') if isinstance(download.data, Path) else io.BytesIO(download.data)
                            with source:
                                source.seek(start)
                                remaining = end - start
                                while remaining:
                                    piece = source.read(min(remaining, 64 * 1024))
                                    if not piece: raise OSError('Download ended before its declared length')
                                    authorize()
                                    self.wfile.write(piece)
                                    remaining -= len(piece)
                    except (APIError, OSError, sqlite3.Error):
                        # Headers have already been sent. A revoked or broken
                        # transfer closes rather than appending a JSON response.
                        self.close_connection = True
                        return
            finally:
                if getattr(download, 'cleanup_dir', None):
                    shutil.rmtree(download.cleanup_dir)

        def stream_page(self, page_id, cookie):
            stream_binding = None
            def snapshot():
                nonlocal stream_binding
                # Recheck both the viewer and each publisher under the writer;
                # presence never enters the document snapshot comparison.
                with application.store.transaction():
                    context = application._request_context(_INTERNAL_PRINCIPAL, cookie)
                    if stream_binding is None: stream_binding = context['session_binding']
                    require(context['session_binding'] == stream_binding, 'Login changed', 401)
                    access = context['access']
                    current = application.collaboration.snapshot(page_id, access)
                    current = Authorization(access).project('/api/pages/' + page_id + '/collaboration', current)
                    presence = application.presence.snapshot(page_id, cookie)
                    current.update(workspace_id=context['workspace_id'], current_member_id=access.member_id,
                        session_binding=stream_binding, access_revision=application.store.meta('access_revision', 0),
                        data_revision=application.store.meta('_entity_revision', 0))
                    return current, presence

            current, presence = snapshot()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.close_connection = True
            self.connection.settimeout(5)
            previous, previous_presence, heartbeat = None, None, 0
            try:
                while not self.server.stream_stop.is_set():
                    # PostgreSQL JSONB may reorder keys after the initial write.
                    # Compare canonical JSON so a cursor does not resend a body.
                    # A global revision keeps an emitted cache canonical, but unrelated
                    # row/presence writes must not publish the document body again.
                    document_key = json.dumps({key: value for key, value in current.items() if key != 'data_revision'},
                                              ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                    presence_key = json.dumps({'epoch': presence['epoch'], 'participants': presence['participants']},
                                              ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                    changed = False
                    if document_key != previous:
                        encoded = json.dumps(current, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                        self.wfile.write(('event: snapshot\ndata: ' + encoded + '\n\n').encode())
                        previous, changed = document_key, True
                    if presence_key != previous_presence:
                        self.wfile.write(('event: presence\ndata: ' + json.dumps(presence, ensure_ascii=False, separators=(',', ':')) + '\n\n').encode())
                        previous_presence, changed = presence_key, True
                    if changed:
                        heartbeat = 0
                    elif heartbeat >= 20:
                        self.wfile.write(b': heartbeat\n\n')
                        heartbeat = 0
                    self.wfile.flush()
                    if self.server.stream_stop.wait(0.5):
                        break
                    heartbeat += 1
                    try:
                        current, presence = snapshot()
                    except APIError as error:
                        self.wfile.write(('event: denied\ndata: ' + json.dumps({'status': error.status, 'error': error.message}) + '\n\n').encode())
                        self.wfile.flush()
                        break
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass

        def handle_request(self):
            try:
                self._cookie_header = None
                # Prevent DNS rebinding against the unauthenticated local application.
                host = self.headers.get("Host", "")
                allowed = {f"localhost:{self.server.server_port}", f"127.0.0.1:{self.server.server_port}", f"[::1]:{self.server.server_port}"}
                for allowed_host in self.server.allowed_hosts:
                    allowed.add(f'{allowed_host}:{self.server.server_port}')
                if self.server.server_port == (443 if self.server.scheme == 'https' else 80):
                    allowed.update({"localhost", "127.0.0.1", "[::1]", *self.server.allowed_hosts})
                require(host in allowed, "Untrusted Host", 403)
                origin = self.headers.get("Origin")
                require(origin is None or origin == self.server.scheme + "://" + host, "Untrusted Origin", 403)
                url = urlparse(self.path)
                require(not url.scheme and not url.netloc, "Invalid request target")
                path = unquote(url.path)
                parts = path.strip('/').split('/')
                raw_upload = self.command == 'PUT' and len(parts) == 4 and parts[:2] == ['api', 'uploads'] and parts[3] == 'chunks'
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
                    if raw_upload:
                        from .attachments import CHUNK_SIZE
                        require(len(self.headers.get_all('Content-Length', [])) == 1, 'A single Content-Length is required', 411)
                    try: length = int(self.headers.get("Content-Length", "0"))
                    except ValueError: raise APIError(400, "Invalid Content-Length")
                    require(0 <= length <= MAX_BODY, "Request exceeds 10 MB", 413)
                    if raw_upload:
                        require(0 < length <= CHUNK_SIZE, 'Invalid upload chunk length', 413)
                        require(self.headers.get_content_type() == 'application/octet-stream', 'Expected application/octet-stream', 415)
                        options = parse_qs(url.query, keep_blank_values=True)
                        require(set(options) == {'offset'} and len(options['offset']) == 1
                                and re.fullmatch('[0-9]{1,20}', options['offset'][0]) is not None, 'A single byte offset is required')
                        cookie = self.headers.get('Cookie', '')
                        # Reject unauthorized uploads before reading the network;
                        # dispatch revalidates this cookie after obtaining writer.
                        _, upload = application.dispatch('GET', '/api/uploads/' + parts[2], {}, {}, session_cookie=cookie)
                        offset = int(options['offset'][0])
                        require(not upload['completed'], 'Upload is already complete', 409)
                        require(offset <= upload['offset'], 'Chunk would create a gap', 409)
                        require(offset % CHUNK_SIZE == 0 and offset < upload['size']
                                and length == min(CHUNK_SIZE, upload['size'] - offset), 'Incorrect chunk boundary or length')
                        self.connection.settimeout(30)
                        self.close_connection = True
                        try:
                            data = self.rfile.read(length)
                        except TimeoutError:
                            raise APIError(408, 'Upload chunk timed out')
                        require(len(data) == length, 'Incomplete upload chunk')
                        body = {'offset': offset, 'data': data}
                    elif length:
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
                        self.send_payload(200, auth.session_info(cookie))
                        return
                    if method == 'POST':
                        token = auth.login(body, self.client_address[0])
                        self._cookie_header = 'fountain_session=' + token + '; Max-Age=604800; HttpOnly; SameSite=Strict; Path=/' + ('; Secure' if self.server.scheme == 'https' else '')
                        self.send_payload(200, auth.session_info('fountain_session=' + token))
                        return
                    if method == 'DELETE':
                        auth.logout(cookie)
                        self._cookie_header = 'fountain_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/' + ('; Secure' if self.server.scheme == 'https' else '')
                        self.send_payload(200, {'authenticated': not auth.enabled, 'required': auth.enabled})
                        return
                    raise APIError(405, 'Unsupported session method')
                if path.startswith(("/api/", "/sites/", "/forms/", "/scim/v2/")):
                    # Dispatch and SSE resolve this original cookie under their
                    # workspace writer. Repeating fragmented authentication here
                    # adds lock contention without protecting the later read.
                    principal = _INTERNAL_PRINCIPAL
                    if is_scim:
                        principal = {'id': 'scim', 'role': 'owner', 'active': True, '_service': True}
                    elif path == '/api/health':
                        principal = {'id': 'health', 'role': 'guest', 'active': True, '_service': True}
                    parts = path.strip('/').split('/')
                    if self.command == 'GET' and len(parts) == 4 and parts[:2] == ['api', 'pages'] and parts[3] == 'events':
                        self.stream_page(parts[2], cookie)
                        return
                    status, payload = application.dispatch(method, path, body, parse_qs(url.query, keep_blank_values=True), principal=principal,
                        session_cookie=cookie if not is_scim and path != '/api/health' else _INTERNAL_PRINCIPAL)
                    if isinstance(payload, (Download, AttachmentDownload)):
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
    def __init__(self, *args, tls_context=None, **kwargs):
        self.stream_stop = threading.Event()
        self.tls_context = tls_context
        self.scheme = 'https' if tls_context is not None else 'http'
        self.tls_handshake_timeout = 5
        super().__init__(*args, **kwargs)

    def process_request_thread(self, request, client_address):
        if self.tls_context is not None:
            secured = None
            try:
                request.settimeout(self.tls_handshake_timeout)
                secured = self.tls_context.wrap_socket(request, server_side=True, do_handshake_on_connect=False)
                secured.do_handshake()
                if self.stream_stop.is_set():
                    self.shutdown_request(secured)
                    return
                secured.settimeout(30)
            except (OSError, ValueError):
                self.shutdown_request(secured if secured is not None else request)
                return
            request = secured
        super().process_request_thread(request, client_address)

    def shutdown(self):
        self.stream_stop.set()
        super().shutdown()

    def serve_forever(self, poll_interval=0.5):
        self.stream_stop.clear()
        self.application.scheduler.start()
        try:
            super().serve_forever(poll_interval)
        finally:
            self.application.scheduler.stop()

    def server_close(self):
        self.stream_stop.set()
        if hasattr(self, 'application'):
            self.application.scheduler.stop()
        super().server_close()


def create_server(host="127.0.0.1", port=8787, db_path=".data/fountain.db", static=STATIC, allowed_hosts=None,
                  tls_cert=None, tls_key=None, database_url=None, workspace_id=None, attachment_root=None):
    require((tls_cert is None) == (tls_key is None), 'TLS requires both a certificate and a private key')
    require(database_url is None or isinstance(database_url, str) and bool(database_url.strip()),
            'PostgreSQL requires a database connection', 503)
    require(database_url is not None or workspace_id is None, 'Workspace namespace requires PostgreSQL mode')
    require(database_url is not None or attachment_root is None, 'Attachment directory requires PostgreSQL mode')
    tls_context = None
    if tls_cert is not None:
        # Validate TLS before creating the user's database or data directory.
        try:
            tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls_context.minimum_version = ssl.TLSVersion.TLSv1_2
            tls_context.set_alpn_protocols(['http/1.1'])
            tls_context.load_cert_chain(tls_cert, tls_key, password=lambda: '')
        except (OSError, ValueError, TypeError) as error:
            raise APIError(400, 'Unable to load the TLS certificate and private key') from error
    allowed_hosts = allowed_hosts or []
    require(all(isinstance(h, str) and h and not any(c in h for c in '/:@ \t\r\n') for h in allowed_hosts), 'Invalid allowed host')
    if host not in {'127.0.0.1', 'localhost'}:
        require(host == '0.0.0.0', 'Use 0.0.0.0 for family network access')
        require(allowed_hosts, 'Family network access requires --allowed-host')
    if database_url is None and str(db_path) != ':memory:':
        database_path = Path(db_path)
        database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            descriptor = os.open(database_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(descriptor)
    if database_url is not None:
        from .postgres import PostgresStore
        store = PostgresStore(database_url, workspace_id=workspace_id, attachment_root=attachment_root)
    else:
        store = Store(db_path)
    server = None
    try:
        # Two server processes must not interleave first-run seed or cleanup.
        with store.transaction():
            application = Application(store, static)
        if host not in {'127.0.0.1', 'localhost'}:
            require(application.auth.enabled, 'Family network access requires FOUNTAIN_ACCESS_TOKEN or individual accounts')
        server = FountainServer((host, port), handler_for(application), tls_context=tls_context)
        server.application = application
        server.allowed_hosts = allowed_hosts
        return server
    except BaseException:
        if server is not None: server.server_close()
        store.close()
        raise


def main():
    parser = argparse.ArgumentParser(description="Run Fountain locally")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--allowed-host", action="append", default=[], help="LAN hostname or IP allowed by Host validation")
    parser.add_argument("--data", default=".data/fountain.db")
    parser.add_argument("--database", choices=('sqlite', 'postgres'), default='sqlite')
    parser.add_argument("--database-config", help="Private JSON file containing database_dsn (PostgreSQL only)")
    parser.add_argument("--workspace-id", help="Stable PostgreSQL workspace namespace")
    parser.add_argument("--attachment-root", help="Shared private file directory for PostgreSQL attachment bytes")
    parser.add_argument("--collect-files", action='store_true', help="Collect one bounded batch of file orphans older than 24 hours, then exit")
    parser.add_argument("--gc-limit", type=int, default=500, help="Maximum file entries in a collection batch")
    parser.add_argument("--tls-cert", help="PEM certificate chain for direct HTTPS")
    parser.add_argument("--tls-key", help="Matching unencrypted PEM private key")
    args = parser.parse_args()
    if bool(args.tls_cert) != bool(args.tls_key): parser.error('--tls-cert and --tls-key must be supplied together')
    if args.collect_files and (args.database != 'postgres' or not args.attachment_root):
        parser.error('--collect-files requires --database postgres and --attachment-root')
    if not 1 <= args.gc_limit <= 10000: parser.error('--gc-limit must be between 1 and 10000')
    database_url = None
    if args.database == 'postgres':
        if args.data != '.data/fountain.db': parser.error('--data is for SQLite mode')
        database_url = os.environ.get('FOUNTAIN_DATABASE_URL', '')
        if args.database_config:
            try:
                with open(args.database_config, 'rb') as source:
                    require(os.fstat(source.fileno()).st_mode & 0o077 == 0,
                            'Database configuration must be readable only by its owner')
                    content = source.read(65537)
                    require(len(content) <= 65536, 'Database configuration is too large')
                    config = json.loads(content)
                    require(isinstance(config, dict), 'Database configuration must be an object')
                    database_url = config.get('database_dsn')
                    if not args.workspace_id:
                        args.workspace_id = config.get('workspace_id')
            except (OSError, ValueError, APIError) as error:
                parser.error('Unable to read the private database configuration')
        if not args.workspace_id: parser.error('--workspace-id is required for PostgreSQL (or workspace_id in the private configuration)')
        if not isinstance(database_url, str) or not database_url.strip():
            parser.error('Set FOUNTAIN_DATABASE_URL or --database-config for PostgreSQL')
    elif args.database_config or args.workspace_id or args.attachment_root:
        parser.error('--database-config, --workspace-id and --attachment-root require --database postgres')
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        if args.collect_files:
            from .postgres import PostgresStore
            store = PostgresStore(database_url, workspace_id=args.workspace_id, attachment_root=args.attachment_root)
            try:
                result = store.file_garbage_collect(limit=args.gc_limit)
            finally:
                store.close()
            print(json.dumps(result), flush=True)
            return
        server = create_server(args.host, args.port, args.data, allowed_hosts=args.allowed_host,
                               tls_cert=args.tls_cert, tls_key=args.tls_key,
                               database_url=database_url, workspace_id=args.workspace_id,
                               attachment_root=args.attachment_root)
    except (APIError, OSError) as error:
        parser.error(str(error))
    print(f"Fountain: {server.scheme}://localhost:{server.server_port}", flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        server.server_close()
        server.application.store.close()


if __name__ == "__main__":
    main()
