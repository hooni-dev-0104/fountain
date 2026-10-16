"""Explicit, transactional server move from an existing SQLite workspace.

Unlike a portable backup, this operation preserves live sessions, account salts,
cache bindings and sync receipts. It never seeds an Application or opens a source
with create semantics. The operator must stop the old API before cutover.
"""
from __future__ import annotations

from contextlib import closing
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid

from .backup import BackupError, CHUNK_SIZE, _inspect, _strict_json
from .core import APIError
from .file_chunks import FileChunkStorage, ROOT_KEY
from .postgres import PostgresStore

GC_KEY = "attachment_file_gc_cursor"
FILE_METADATA = (ROOT_KEY, GC_KEY)


class MigrationError(ValueError):
    """The source is not ready, target is nonempty, or verification failed."""


def _require(condition, message):
    if not condition:
        raise MigrationError(message)


def _canonical_json(encoded):
    """Compare JSONB numerics without rounding through Python binary floats."""
    def invalid(_):
        raise MigrationError("Source contains a nonfinite JSON number")
    value = json.loads(encoded, parse_int=Decimal, parse_float=Decimal, parse_constant=invalid)
    def encode(item):
        if item is None: return "null"
        if item is True: return "true"
        if item is False: return "false"
        if isinstance(item, Decimal):
            if item.is_zero(): return "0"
            sign, digits, exponent = item.as_tuple()
            digits = list(digits)
            while digits[-1] == 0:
                digits.pop()
                exponent += 1
            return ("-" if sign else "") + "".join(map(str, digits)) + "e" + str(exponent)
        if isinstance(item, str): return json.dumps(item, ensure_ascii=False)
        if isinstance(item, list): return "[" + ",".join(encode(child) for child in item) + "]"
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + encode(item[key]) for key in sorted(item)) + "}"
    return encode(value).encode("utf-8")


def _digest(rows):
    digest, count = hashlib.sha256(), 0
    for row in rows:
        # The final column is JSON text. Length framing avoids field ambiguity.
        for value in (*row[:-1], _canonical_json(row[-1])):
            value = value if isinstance(value, bytes) else value.encode("utf-8")
            digest.update(len(value).to_bytes(8, "big"))
            digest.update(value)
        count += 1
    return count, digest.hexdigest()


def _target_rows(store, statement):
    with store._connection.cursor(name="fountain_migrate_" + uuid.uuid4().hex) as cursor:
        cursor.execute(statement, (store.workspace_id,))
        while rows := cursor.fetchmany(64):
            yield from rows


def _source_meta(source):
    return {key: encoded for key, encoded in source.execute("SELECT key,data FROM meta")}


def _preflight(source):
    counts = _inspect(source)
    _require(not counts.get("attachment_chunk"), "Source contains external filesystem chunk references; use a verified portable SQLite snapshot")
    for (encoded,) in source.execute("SELECT data FROM entities WHERE kind='upload'"):
        _require(_strict_json(encoded).get("completed") is True, "Finish or cancel every incomplete upload before migration")
    metadata = _source_meta(source)
    _require(ROOT_KEY not in metadata, "Source contains an external attachment root binding")
    _require(GC_KEY not in metadata, "Source contains external filesystem garbage collection state")
    namespace = _strict_json(metadata.get("workspace_id", "null"))
    _require(isinstance(namespace, str) and bool(namespace.strip()), "Source has no workspace namespace")
    if "_entity_revision" in metadata:
        revision = _strict_json(metadata["_entity_revision"])
        _require(type(revision) is int and 0 <= revision <= 9223372036854775807, "Source has an invalid entity revision")
    tables = {row[0] for row in source.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    expected = 0
    for (encoded,) in source.execute("SELECT data FROM entities WHERE kind='attachment'"):
        attachment = _strict_json(encoded)
        if attachment.get("storage") == "chunks":
            expected += (attachment["size"] + CHUNK_SIZE - 1) // CHUNK_SIZE
    actual = source.execute("SELECT count(*) FROM attachment_chunks").fetchone()[0] if "attachment_chunks" in tables else 0
    _require(actual == expected, "Source contains incomplete or orphaned attachment chunks")
    return counts, metadata, namespace, expected


def _empty_target(store):
    for table in ("entities", "attachment_chunks", "identity_mapping"):
        row = store._execute(f"SELECT 1 FROM fountain_private.{table} WHERE workspace_id=%s LIMIT 1", (store.workspace_id,), fetch="one")
        _require(row is None, "Target workspace must be empty; existing data was preserved")
    rows = store._execute("SELECT key,data FROM fountain_private.meta WHERE workspace_id=%s", (store.workspace_id,), fetch="all")
    _require(all(key in {*FILE_METADATA, "_entity_revision"} for key, _ in rows), "Target workspace contains existing metadata")
    binding = dict(rows).get(ROOT_KEY)
    _require(binding == {"version": 1, "id": store._files.root_id}, "Target attachment root binding is not initialized")
    return {key: value for key, value in rows if key in FILE_METADATA}


def _copy_attachments(source, target):
    files, chunks, total = 0, 0, 0
    for identity, encoded in source.execute("SELECT id,data FROM entities WHERE kind='attachment' ORDER BY id"):
        attachment = _strict_json(encoded)
        if attachment.get("storage") != "chunks":
            continue
        digest, position, expected = hashlib.sha256(), 0, []
        for offset, data in source.execute("SELECT offset,data FROM attachment_chunks WHERE attachment_id=? ORDER BY offset", (identity,)):
            _require(offset == position and isinstance(data, bytes) and len(data) == min(CHUNK_SIZE, attachment["size"] - position), "Source attachment layout changed")
            target.chunk_write(identity, offset, data)
            digest.update(data)
            position += len(data)
            expected.append((offset, len(data), "blob"))
        _require(position == attachment["size"] and digest.hexdigest() == attachment["sha256"], "Source attachment checksum changed")
        _require(target.chunk_list(identity) == expected, "Target attachment manifest verification failed")
        digest = hashlib.sha256()
        for offset, length, _ in expected:
            start = 0
            while start < length:
                piece = target.chunk_read_range(identity, offset, start, min(65536, length - start))
                _require(isinstance(piece, bytes) and len(piece) == min(65536, length - start), "Target attachment bytes are incomplete")
                digest.update(piece)
                start += len(piece)
        _require(digest.hexdigest() == attachment["sha256"], "Target attachment checksum verification failed")
        files += 1
        chunks += len(expected)
        total += position
    return files, chunks, total


def migrate_sqlite(source_path, targetStore):
    """Move one namespace into an empty file-backed PostgresStore atomically.

    Returns counts and canonical digests only, never session/account contents or
    connection configuration. Failure rolls PostgreSQL back; unpublished private
    disk orphans can be safely reused on retry or collected by the existing GC.
    """
    source_path = Path(source_path).expanduser().resolve()
    _require(source_path.is_file(), "Source SQLite database does not exist")
    try:
        with closing(sqlite3.connect(source_path.as_uri() + "?mode=rw", uri=True, timeout=5)) as source:
            source.execute("PRAGMA trusted_schema=OFF")
            source.execute("BEGIN IMMEDIATE")
            try:
                counts, metadata, namespace, expected_chunks = _preflight(source)
                _require(isinstance(targetStore, PostgresStore) and isinstance(targetStore._files, FileChunkStorage),
                         "Migration requires a PostgreSQL target with filesystem attachment storage")
                _require(targetStore.workspace_id == namespace, "Source and target workspace namespaces do not match")
                expected_entities = _digest(source.execute("SELECT kind,id,created_at,updated_at,data FROM entities ORDER BY kind,id"))
                expected_metadata = _digest(source.execute("SELECT key,data FROM meta ORDER BY key"))
                with targetStore.transaction():
                    file_metadata = _empty_target(targetStore)
                    for kind, identity, data, created, updated in source.execute("SELECT kind,id,data,created_at,updated_at FROM entities ORDER BY kind,id"):
                        targetStore._execute("INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES (%s,%s,%s,%s::jsonb,%s,%s)",
                                             (namespace, kind, identity, data, created, updated))
                    for key, encoded in metadata.items():
                        if key != "_entity_revision":
                            targetStore._execute("INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES (%s,%s,%s::jsonb)", (namespace, key, encoded))
                    files, chunks, byte_count = _copy_attachments(source, targetStore)
                    _require(chunks == expected_chunks, "Target attachment count verification failed")
                    # Reset the transport counter after all internal manifest writes;
                    # no later operation in this transaction modifies persisted data.
                    if "_entity_revision" in metadata:
                        targetStore._execute("INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES (%s,'_entity_revision',%s::jsonb) "
                                             "ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data", (namespace, metadata["_entity_revision"]))
                    else:
                        targetStore._execute("DELETE FROM fountain_private.meta WHERE workspace_id=%s AND key='_entity_revision'", (namespace,))
                    actual_entities = _digest(_target_rows(targetStore, "SELECT kind,id,created_at,updated_at,data::text FROM fountain_private.entities "
                        "WHERE workspace_id=%s AND kind<>'attachment_chunk' ORDER BY kind COLLATE \"C\",id COLLATE \"C\""))
                    actual_metadata = _digest(_target_rows(targetStore, "SELECT key,data::text FROM fountain_private.meta "
                        "WHERE workspace_id=%s AND key NOT IN ('attachment_file_root','attachment_file_gc_cursor') ORDER BY key COLLATE \"C\""))
                    _require(actual_entities == expected_entities, "Target entity count or canonical JSON verification failed")
                    _require(actual_metadata == expected_metadata, "Target metadata count or canonical JSON verification failed")
                    manifests = targetStore._execute("SELECT count(*) FROM fountain_private.entities WHERE workspace_id=%s AND kind='attachment_chunk'", (namespace,), fetch="one")[0]
                    current_file_metadata = dict(targetStore._execute("SELECT key,data FROM fountain_private.meta WHERE workspace_id=%s "
                        "AND key IN ('attachment_file_root','attachment_file_gc_cursor')", (namespace,), fetch="all"))
                    _require(manifests == chunks and current_file_metadata == file_metadata, "Target filesystem references or root binding changed")
                return {"workspace_id": namespace, "entities": counts, "entity_count": expected_entities[0], "metadata_count": expected_metadata[0],
                        "entity_sha256": expected_entities[1], "metadata_sha256": expected_metadata[1], "attachments": files, "chunks": chunks, "bytes": byte_count,
                        "entity_revision": _strict_json(metadata["_entity_revision"]) if "_entity_revision" in metadata else None}
            finally:
                source.rollback()
    except MigrationError:
        raise
    except (BackupError, APIError, sqlite3.Error, OSError, ValueError, TypeError, RecursionError, UnicodeError):
        raise MigrationError("SQLite migration failed; source was preserved and target transaction was rolled back") from None
