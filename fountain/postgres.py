"""Optional PostgreSQL persistence for a pre-migrated private Fountain schema.

The driver is loaded only when this store is selected. The shared workspace lock
is acquired before transactional reads, including authentication and ACL checks.
"""
from __future__ import annotations

import copy
import hashlib
import json
import threading
from contextlib import contextmanager

from .core import APIError, AUDIT_ACTOR, _admin_membership_changed, now, require, text, uid


class PostgresStore:
    backend = "postgres"

    def __init__(self, dsn, *, workspace_id, attachment_root=None):
        text(workspace_id, "workspace namespace", 160, False)
        require(isinstance(dsn, str) and bool(dsn.strip()), "PostgreSQL connection configuration is required", 503)
        try:
            import psycopg
            from psycopg.conninfo import conninfo_to_dict
            from psycopg.types.json import Jsonb
        except ImportError:
            raise APIError(503, "PostgreSQL mode requires the optional psycopg[binary] dependency") from None
        try:
            options = conninfo_to_dict(dsn)
        except psycopg.Error:
            raise APIError(503, "Invalid PostgreSQL connection configuration") from None
        require(options.get("sslmode", "verify-full") == "verify-full",
                "PostgreSQL requires TLS certificate and hostname verification", 503)
        require(bool(options.get("host")) and not options["host"].startswith("/"),
                "PostgreSQL requires a TLS hostname", 503)
        self.workspace_id = workspace_id
        self._files = None
        self._initializing = True
        self.lock = threading.RLock()
        self.transaction_depth = 0
        self._driver, self._jsonb = psycopg, Jsonb
        self._lock_key = int.from_bytes(hashlib.sha256(
            ("fountain:workspace:" + workspace_id).encode()).digest()[:8], "big", signed=True)
        try:
            self._connection = psycopg.connect(
                dsn, autocommit=True, sslmode="verify-full",
                sslrootcert=options.get("sslrootcert", "system"),
                connect_timeout=10, prepare_threshold=None)
        except psycopg.Error:
            raise APIError(503, "Unable to establish the verified PostgreSQL connection") from None
        try:
            # No CREATE/ALTER is issued here. Provisioning owns schema changes.
            self._execute("SELECT workspace_id,kind,id,data,created_at,updated_at FROM fountain_private.entities WHERE false")
            self._execute("SELECT workspace_id,key,data FROM fountain_private.meta WHERE false")
            self._execute('SELECT workspace_id,attachment_id,"offset",data FROM fountain_private.attachment_chunks WHERE false')
            if attachment_root is not None:
                from .file_chunks import FileChunkStorage
                self._files = FileChunkStorage(self, attachment_root)
            else:
                absent = object()
                require(self.meta("attachment_file_root", absent) is absent,
                        "This workspace requires its configured attachment directory", 503)
            self._initializing = False
        except BaseException:
            try:
                if self._files is not None: self._files.close()
            finally:
                self._connection.close()
            raise

    def _execute(self, statement, parameters=(), *, fetch=None):
        try:
            with self._connection.cursor() as cursor:
                cursor.execute(statement, parameters)
                if fetch == "one": return cursor.fetchone()
                if fetch == "all": return cursor.fetchall()
                return cursor.rowcount
        except self._driver.Error:
            # Driver messages can contain SQL values or connection credentials.
            raise APIError(503, "PostgreSQL persistence operation failed") from None

    @contextmanager
    def transaction(self):
        with self.lock:
            outer = self.transaction_depth == 0
            try:
                # Psycopg nests transaction contexts using real SAVEPOINTs.
                with self._connection.transaction():
                    if outer:
                        self._execute("SELECT set_config('fountain.workspace_id',%s,true)", (self.workspace_id,))
                        self._execute("SELECT pg_advisory_xact_lock(%s)", (self._lock_key,))
                        if not self._initializing:
                            self._check_attachment_mode()
                    self.transaction_depth += 1
                    try:
                        yield self
                    finally:
                        self.transaction_depth -= 1
            except self._driver.Error:
                raise APIError(503, "PostgreSQL transaction could not complete") from None

    def _check_attachment_mode(self):
        # This query runs exactly once per outer transaction, with the workspace
        # lock held. Calling meta() here would recursively start another read.
        row = self._execute("SELECT data FROM fountain_private.meta WHERE workspace_id=%s AND key='attachment_file_root'",
                            (self.workspace_id,), fetch="one")
        if self._files is None:
            require(row is None, "This workspace requires its configured attachment directory", 503)
        else:
            binding = row[0] if row is not None else None
            require(isinstance(binding, dict) and type(binding.get("version")) is int
                    and binding == {"version": 1, "id": self._files.root_id},
                    "Attachment directory no longer matches this workspace", 503)

    @contextmanager
    def _read(self):
        with self.lock:
            if self.transaction_depth:
                yield
            else:
                with self.transaction():
                    yield

    def commit(self):
        # Individual mutations own their transaction; an outer caller owns its
        # commit. Committing here would prematurely release that caller's lock.
        with self.lock:
            if not self.transaction_depth:
                try:
                    self._connection.commit()
                except self._driver.Error:
                    raise APIError(503, "PostgreSQL commit could not complete") from None

    def _json(self, value):
        try:
            serialized = json.dumps(value, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, OverflowError):
            raise APIError(400, "Persistence values must contain valid JSON") from None
        return self._jsonb(json.loads(serialized))

    def _advance_revision(self):
        self._execute(
            "INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES (%s,'_entity_revision','1'::jsonb) "
            "ON CONFLICT(workspace_id,key) DO UPDATE SET "
            "data=to_jsonb((fountain_private.meta.data #>> '{}')::bigint + 1)", (self.workspace_id,))

    def get(self, kind, entity_id):
        with self._read():
            row = self._execute("SELECT data FROM fountain_private.entities WHERE workspace_id=%s AND kind=%s AND id=%s",
                                (self.workspace_id, kind, entity_id), fetch="one")
            return copy.deepcopy(row[0]) if row else None

    def list(self, kind):
        with self._read():
            rows = self._execute("SELECT data FROM fountain_private.entities WHERE workspace_id=%s AND kind=%s ORDER BY created_at,id",
                                 (self.workspace_id, kind), fetch="all")
            return [copy.deepcopy(row[0]) for row in rows]

    def put(self, kind, data):
        require(isinstance(data, dict), "Entity must be an object")
        value = copy.deepcopy(data)
        entity_id = value.get("id") or uid()
        text(entity_id, "id", 160, False)
        with self.transaction():
            previous = self.get(kind, entity_id)
            value.update(id=entity_id, created_at=(previous or {}).get("created_at", now()), updated_at=now())
            self._execute(
                "INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES (%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at",
                (self.workspace_id, kind, entity_id, self._json(value), value["created_at"], value["updated_at"]))
            if kind == "member" and _admin_membership_changed(previous, value):
                from .admin_roles import invalidate_member
                invalidate_member(self, entity_id)
            self._advance_revision()
        return value

    def delete(self, kind, entity_id):
        with self.transaction():
            removed = self._execute("DELETE FROM fountain_private.entities WHERE workspace_id=%s AND kind=%s AND id=%s",
                                    (self.workspace_id, kind, entity_id))
            if kind == "member" and removed:
                from .admin_roles import invalidate_member
                invalidate_member(self, entity_id)
            if removed: self._advance_revision()

    def meta(self, key, default=None):
        with self._read():
            row = self._execute("SELECT data FROM fountain_private.meta WHERE workspace_id=%s AND key=%s",
                                (self.workspace_id, key), fetch="one")
            return copy.deepcopy(row[0]) if row else default

    def set_meta(self, key, value):
        with self.transaction():
            self._execute("INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES (%s,%s,%s) "
                          "ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data",
                          (self.workspace_id, key, self._json(value)))
            if key != "_entity_revision": self._advance_revision()
        return value

    def audit(self, action, details, user=None):
        return self.put("audit", {"action": action, "details": details,
                                 "user": user if user is not None else AUDIT_ACTOR.get()})

    def chunk_info(self, identity, offset):
        with self._read():
            if self._files is not None:
                info = self._files.info(identity, offset)
                if info is not None: return info
            row = self._execute('SELECT octet_length(data) FROM fountain_private.attachment_chunks '
                                'WHERE workspace_id=%s AND attachment_id=%s AND "offset"=%s',
                                (self.workspace_id, identity, offset), fetch="one")
            return (row[0], "blob") if row else None

    def chunk_read_range(self, identity, offset, start, length):
        require(type(start) is int and start >= 0 and type(length) is int and 0 <= length <= 4 * 1024 * 1024,
                "Invalid attachment read range")
        with self._read():
            if self._files is not None and self._files.info(identity, offset) is not None:
                return self._files.read_range(identity, offset, start, length)
            row = self._execute('SELECT substring(data FROM %s FOR %s) FROM fountain_private.attachment_chunks '
                                'WHERE workspace_id=%s AND attachment_id=%s AND "offset"=%s',
                                (start + 1, length, self.workspace_id, identity, offset), fetch="one")
            return bytes(row[0]) if row else None

    def chunk_hash_into(self, identity, offset, length, digest):
        require(type(length) is int and 0 <= length <= 4 * 1024 * 1024,
                "Invalid attachment chunk length")
        with self._read():
            if self._files is not None and self._files.hash_into(identity, offset, length, digest):
                return
            row = self._execute('SELECT octet_length(data),pg_typeof(data)::text FROM fountain_private.attachment_chunks '
                                'WHERE workspace_id=%s AND attachment_id=%s AND "offset"=%s',
                                (self.workspace_id, identity, offset), fetch="one")
            require(row is not None and row[0] == length and row[1] == "bytea",
                    "Attachment chunk is missing or has an invalid length", 409)
            position = 0
            while position < length:
                size = min(65536, length - position)
                piece = self.chunk_read_range(identity, offset, position, size)
                require(piece is not None and len(piece) == size, "Attachment chunk is incomplete", 409)
                digest.update(piece)
                position += size

    def chunk_write(self, identity, offset, data):
        require(type(offset) is int and offset >= 0 and isinstance(data, (bytes, bytearray))
                and len(data) <= 4 * 1024 * 1024, "Invalid attachment chunk")
        with self.transaction():
            if self._files is not None:
                return self._files.write(identity, offset, bytes(data))
            self._execute('INSERT INTO fountain_private.attachment_chunks(workspace_id,attachment_id,"offset",data) '
                          'VALUES (%s,%s,%s,%s)', (self.workspace_id, identity, offset, bytes(data)))

    def chunk_list(self, identity):
        with self._read():
            rows = self._execute('SELECT "offset",octet_length(data) FROM fountain_private.attachment_chunks '
                                 'WHERE workspace_id=%s AND attachment_id=%s ORDER BY "offset"',
                                 (self.workspace_id, identity), fetch="all")
            merged = [(offset, length, "blob") for offset, length in rows]
            if self._files is not None: merged.extend(self._files.list(identity))
            require(len({row[0] for row in merged}) == len(merged), "Attachment has conflicting chunk references", 409)
            return sorted(merged, key=lambda row: row[0])

    def chunk_delete(self, identity):
        with self.transaction():
            removed = self._files.delete(identity) if self._files is not None else 0
            return removed + self._execute("DELETE FROM fountain_private.attachment_chunks WHERE workspace_id=%s AND attachment_id=%s",
                                           (self.workspace_id, identity))

    def file_garbage_collect(self, now=None, limit=500):
        require(self._files is not None, "Attachment directory is not configured", 503)
        return self._files.garbage_collect(now=now, limit=limit)

    def presence_lookup(self, *, page=None, origin=None, now=None):
        clauses, parameters = ["workspace_id=%s", "kind='presence'"], [self.workspace_id]
        if page is not None:
            clauses.append("data->>'page_id'=%s")
            parameters.append(page)
        if origin is not None:
            clauses.extend(["data->>'origin_kind'=%s", "data->>'origin_id'=%s"])
            parameters.extend(origin)
        if now is not None:
            clauses.append("(data->>'retain_until')::double precision>%s")
            parameters.append(now)
        with self._read():
            rows = self._execute("SELECT data FROM fountain_private.entities WHERE " + " AND ".join(clauses),
                                 parameters, fetch="all")
            return [copy.deepcopy(row[0]) for row in rows]

    def presence_cleanup(self, now, limit=500):
        require(type(limit) is int and 0 < limit <= 500, "Invalid presence cleanup limit")
        with self.transaction():
            rows = self._execute("SELECT id FROM fountain_private.entities WHERE workspace_id=%s AND kind='presence' "
                                 "AND (data->>'retain_until')::double precision<=%s ORDER BY id LIMIT %s",
                                 (self.workspace_id, now, limit), fetch="all")
            for (identity,) in rows: self.delete("presence", identity)
            return len(rows)

    def close(self):
        with self.lock:
            try:
                if self._files is not None: self._files.close()
            finally:
                self._connection.close()
