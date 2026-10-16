"""Complete SQLite snapshots without active sessions or unfinished uploads."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from contextlib import closing, nullcontext
from pathlib import Path


class BackupError(ValueError):
    """An invalid source or an unsafe backup destination."""


SCHEMA = {
    "entities": [("kind", "TEXT", 1, 1), ("id", "TEXT", 1, 2), ("data", "TEXT", 1, 0),
                 ("created_at", "TEXT", 1, 0), ("updated_at", "TEXT", 1, 0)],
    "meta": [("key", "TEXT", 0, 1), ("data", "TEXT", 1, 0)],
    "attachment_chunks": [("attachment_id", "TEXT", 1, 1), ("offset", "INTEGER", 1, 2), ("data", "BLOB", 1, 0)],
}
DEFINITIONS = {
    "entities": "CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id))",
    "meta": "CREATE TABLE meta (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
    "attachment_chunks": "CREATE TABLE attachment_chunks (attachment_id TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(attachment_id,offset))",
}
PRIVATE_KINDS = ("session", "clipboard", "upload", "presence")
CHUNK_SIZE = 4 * 1024 * 1024
HASH_READ_SIZE = 64 * 1024
MAX_ATTACHMENT_SIZE = 5_000_000_000


def _open_source(path):
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise BackupError("Source database does not exist")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    connection.execute("PRAGMA trusted_schema=OFF")
    connection.execute("PRAGMA query_only=ON")
    return connection


def _strict_json(value):
    def invalid_constant(_):
        raise ValueError("Nonfinite number")
    return json.loads(value, parse_constant=invalid_constant)


def _attachments(connection):
    for identity, data in connection.execute("SELECT id,data FROM entities WHERE kind='attachment'"):
        try:
            attachment = _strict_json(data)
        except (ValueError, TypeError, RecursionError) as error:
            raise BackupError("Invalid attachment metadata") from error
        if not isinstance(attachment, dict) or attachment.get("id") != identity:
            raise BackupError("Invalid attachment metadata")
        yield identity, attachment


def _inspect_chunks(connection, tables, complete_only):
    for identity, attachment in _attachments(connection):
        if attachment.get("storage") != "chunks":
            continue
        if "attachment_chunks" not in tables:
            raise BackupError("Chunk attachment has no attachment_chunks table")
        size, digest = attachment.get("size"), attachment.get("sha256")
        if (type(size) is not int or not 0 <= size <= MAX_ATTACHMENT_SIZE
                or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            raise BackupError("Invalid finalized attachment manifest")
        expected, hasher = 0, hashlib.sha256()
        rows = connection.execute("SELECT rowid,offset,length(data),typeof(data) FROM attachment_chunks "
                                  "WHERE attachment_id=? ORDER BY offset", (identity,))
        for rowid, offset, length, storage_type in rows:
            if (type(offset) is not int or offset != expected or storage_type != "blob"
                    or expected >= size or length != min(CHUNK_SIZE, size - expected)):
                raise BackupError("Attachment chunks are missing, noncontiguous, or incorrectly sized")
            # Read only a bounded slice, including when an attachment spans gigabytes.
            if hasattr(connection, "blobopen"):
                with connection.blobopen("attachment_chunks", "data", rowid, readonly=True) as blob:
                    while block := blob.read(HASH_READ_SIZE):
                        hasher.update(block)
            else:
                for start in range(0, length, HASH_READ_SIZE):
                    block = connection.execute("SELECT substr(data,?,?) FROM attachment_chunks "
                                               "WHERE attachment_id=? AND offset=?",
                                               (start + 1, min(HASH_READ_SIZE, length - start), identity, offset)).fetchone()[0]
                    hasher.update(block)
            expected += length
        if expected != size or hasher.hexdigest() != digest:
            raise BackupError("Finalized attachment size or SHA-256 does not match its chunks")
    if complete_only and "attachment_chunks" in tables:
        for (identity,) in connection.execute("SELECT DISTINCT attachment_id FROM attachment_chunks"):
            row = connection.execute("SELECT data FROM entities WHERE kind='attachment' AND id=?", (identity,)).fetchone()
            if not row or _strict_json(row[0]).get("storage") != "chunks":
                raise BackupError("Backup contains incomplete or orphaned attachment chunks")


def _prune_chunks(connection):
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    if "attachment_chunks" not in tables:
        return
    connection.execute("DELETE FROM attachment_chunks WHERE NOT EXISTS "
                       "(SELECT 1 FROM entities WHERE kind='attachment' AND id=attachment_chunks.attachment_id)")
    for identity, attachment in _attachments(connection):
        if attachment.get("storage") != "chunks":
            connection.execute("DELETE FROM attachment_chunks WHERE attachment_id=?", (identity,))


def _inspect(connection, *, validate_attachments=True, complete_only=False):
    objects = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema").fetchall()
    tables = {name for kind, name, _, _ in objects if kind == "table"}
    if tables not in ({"entities", "meta"}, set(SCHEMA)):
        raise BackupError("Source must contain exactly the Fountain tables")
    for kind, name, table, definition in objects:
        implicit_index = (kind == "index" and table in SCHEMA
                          and name == f"sqlite_autoindex_{table}_1" and definition is None)
        if not (kind == "table" and name in SCHEMA) and not implicit_index:
            raise BackupError("Source contains unsupported database objects")
        if kind == "table" and (not definition or "VIRTUAL" in definition.upper()):
            raise BackupError("Virtual tables are not permitted")
    for table, expected in SCHEMA.items():
        if table not in tables:
            continue
        info = connection.execute(f"PRAGMA table_xinfo({table})").fetchall()
        actual = [(row[1], row[2].upper(), row[3], row[5]) for row in info]
        if actual != expected or any(row[4] is not None or row[6] for row in info):
            raise BackupError(f"Unexpected {table} table schema")
        definition = next(sql for kind, name, _, sql in objects if kind == "table" and name == table)
        normalize = lambda sql: re.sub(r"\s+", "", sql).casefold()
        if normalize(definition) != normalize(DEFINITIONS[table]):
            raise BackupError(f"Unsupported {table} table definition")
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise BackupError("Database integrity check failed")
    counts = {}
    try:
        for kind, identity, data in connection.execute("SELECT kind,id,data FROM entities"):
            value = _strict_json(data)
            if not isinstance(value, dict) or value.get("id") != identity or not isinstance(kind, str):
                raise ValueError("Invalid entity")
            counts[kind] = counts.get(kind, 0) + 1
        for (data,) in connection.execute("SELECT data FROM meta"):
            _strict_json(data)
    except (ValueError, TypeError, RecursionError) as error:
        raise BackupError("Source contains invalid JSON entity or metadata records") from error
    if validate_attachments:
        _inspect_chunks(connection, tables, complete_only)
    return counts


def inspect_backup(path):
    try:
        with closing(_open_source(path)) as source:
            return _inspect(source)
    except sqlite3.Error as error:
        raise BackupError(f"Cannot read Fountain database: {error}") from error


def _copy(source_path, destination_path):
    destination = Path(destination_path).expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise BackupError("Destination already exists; choose a new filename")
    if not destination.parent.is_dir():
        raise BackupError("Destination directory does not exist")
    temporary = None
    try:
        source_context = (nullcontext(source_path) if isinstance(source_path, sqlite3.Connection)
                          else closing(_open_source(source_path)))
        with source_context as source:
            _inspect(source)
            descriptor, temporary = tempfile.mkstemp(prefix=".fountain-backup-", suffix=".db", dir=destination.parent)
            os.close(descriptor)
            with closing(sqlite3.connect(temporary)) as target:
                source.backup(target)
                target.execute("PRAGMA trusted_schema=OFF")
                # Recheck SQL objects before any mutation; validate final bytes after pruning.
                _inspect(target, validate_attachments=False)
                target.execute("PRAGMA secure_delete=ON")
                placeholders = ",".join("?" for _ in PRIVATE_KINDS)
                target.execute(f"DELETE FROM entities WHERE kind IN ({placeholders})", PRIVATE_KINDS)
                _prune_chunks(target)
                target.execute("DELETE FROM meta WHERE key = 'local_cache_binding'")
                target.commit()
                target.execute("VACUUM")
                counts = _inspect(target, complete_only=True)
                target.execute("PRAGMA journal_mode=DELETE")
            with open(temporary, "rb") as file:
                os.fsync(file.fileno())
            # Hard-link publication cannot replace a path created during this copy.
            os.link(temporary, destination)
            return counts
    except (sqlite3.Error, OSError) as error:
        raise BackupError(f"Cannot create workspace snapshot: {error}") from error
    finally:
        if temporary is not None:
            for suffix in ("", "-wal", "-shm", "-journal"):
                try: os.unlink(temporary + suffix)
                except FileNotFoundError: pass


def create_backup(source_path, destination_path):
    return _copy(source_path, destination_path)


def restore_backup(source_path, destination_path):
    return _copy(source_path, destination_path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Back up or restore a complete Fountain workspace")
    parser.add_argument("action", choices=("create", "restore"))
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args(argv)
    try:
        operation = create_backup if args.action == "create" else restore_backup
        counts = operation(args.source, args.destination)
    except (BackupError, OSError) as error:
        print(f"Fountain backup: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"destination": str(Path(args.destination).absolute()), "entities": counts}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
