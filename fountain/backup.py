"""Complete SQLite snapshots for a private workspace, without active sessions."""
from __future__ import annotations

import argparse
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
}
DEFINITIONS = {
    "entities": "CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id))",
    "meta": "CREATE TABLE meta (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
}
PRIVATE_KINDS = ("session", "clipboard")


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


def _inspect(connection):
    objects = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema").fetchall()
    tables = {name for kind, name, _, _ in objects if kind == "table"}
    if tables != set(SCHEMA):
        raise BackupError("Source must contain exactly the Fountain entities and meta tables")
    for kind, name, table, definition in objects:
        implicit_index = (kind == "index" and table in SCHEMA
                          and name == f"sqlite_autoindex_{table}_1" and definition is None)
        if not (kind == "table" and name in SCHEMA) and not implicit_index:
            raise BackupError("Source contains unsupported database objects")
        if kind == "table" and (not definition or "VIRTUAL" in definition.upper()):
            raise BackupError("Virtual tables are not permitted")
    for table, expected in SCHEMA.items():
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
                _inspect(target)
                target.execute("PRAGMA secure_delete=ON")
                target.execute("DELETE FROM entities WHERE kind IN (?,?)", PRIVATE_KINDS)
                target.commit()
                target.execute("VACUUM")
                counts = _inspect(target)
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
