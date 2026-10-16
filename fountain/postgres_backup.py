"""Export a workspace-locked PostgreSQL snapshot as a portable SQLite backup."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import uuid

from .backup import BackupError, CHUNK_SIZE, DEFINITIONS, create_backup
from .core import APIError


def _rows(store, statement, *, batch_size=128):
    # Named cursors keep the complete workspace out of the client-side buffer.
    with store._connection.cursor(name="fountain_backup_" + uuid.uuid4().hex) as cursor:
        cursor.execute(statement, (store.workspace_id,))
        while batch := cursor.fetchmany(batch_size):
            yield from batch


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _export(store, target):
    with store.transaction():
        # The shared workspace advisory lock fences all application writers until
        # entities, metadata and their attachment bytes have been copied together.
        for kind, identity, data, created, updated in _rows(store,
                "SELECT kind,id,data,created_at,updated_at FROM fountain_private.entities "
                "WHERE workspace_id=%s ORDER BY kind,id"):
            target.execute("INSERT INTO entities VALUES (?,?,?,?,?)",
                           (kind, identity, _json(data), created, updated))
        for key, data in _rows(store,
                "SELECT key,data FROM fountain_private.meta WHERE workspace_id=%s ORDER BY key"):
            target.execute("INSERT INTO meta VALUES (?,?)", (key, _json(data)))
        # Incomplete/orphaned uploads are omitted exactly as create_backup prunes
        # them. Finalized chunks still pass its size, continuity and digest checks.
        for identity, offset, length, data in _rows(store,
                'SELECT c.attachment_id,c."offset",octet_length(c.data),'
                'substring(c.data FROM 1 FOR 4194304) FROM fountain_private.attachment_chunks c '
                "WHERE c.workspace_id=%s AND EXISTS (SELECT 1 FROM fountain_private.entities e "
                "WHERE e.workspace_id=c.workspace_id AND e.kind='attachment' AND e.id=c.attachment_id "
                "AND e.data->>'storage'='chunks') ORDER BY c.attachment_id,c.\"offset\"",
                batch_size=1):
            if length > CHUNK_SIZE:
                raise BackupError("Finalized attachment chunk exceeds the supported size")
            target.execute("INSERT INTO attachment_chunks VALUES (?,?,?)", (identity, offset, bytes(data)))
        target.commit()


def create_postgres_backup(store, destination):
    """Copy one namespace without changing its entities, revision or credentials.

    Identity mappings to external Supabase Auth users intentionally stay outside
    the portable workspace. Existing app-account credentials remain restorable;
    the shared SQLite backup path strips sessions, presence and cache bindings.
    """
    destination = Path(destination).expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise BackupError("Destination already exists; choose a new filename")
    if not destination.parent.is_dir():
        raise BackupError("Destination directory does not exist")
    try:
        # The directory protects SQLite rollback files as well as the 0600 main
        # snapshot; all temporary bytes disappear on validation/export failure.
        with tempfile.TemporaryDirectory(prefix=".fountain-postgres-backup-", dir=destination.parent) as directory:
            snapshot = Path(directory) / "workspace.db"
            descriptor = os.open(snapshot, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            os.close(descriptor)
            with closing(sqlite3.connect(snapshot)) as target:
                for definition in DEFINITIONS.values():
                    target.execute(definition)
                _export(store, target)
                # Reuse the established validation, private-record pruning,
                # bounded digest verification and no-overwrite publication.
                return create_backup(target, destination)
    except BackupError:
        raise
    except (APIError, store._driver.Error, sqlite3.Error, OSError, ValueError, TypeError):
        raise BackupError("Cannot create PostgreSQL workspace snapshot") from None
