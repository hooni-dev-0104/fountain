"""Export a workspace-locked PostgreSQL snapshot as a portable SQLite backup."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import uuid

from .backup import (BackupError, CHUNK_SIZE, DEFINITIONS, PROVENANCE_COLUMNS,
                     _attachments, _provenance_provisioned, create_backup)
from .content_index import INDEX_DEFINITIONS
from .retention_vault import VAULT_COLUMNS, VAULT_DEFINITIONS
from .core import APIError


def _rows(store, statement, *, batch_size=128):
    # Named cursors keep the complete workspace out of the client-side buffer.
    with store._connection.cursor(name="fountain_backup_" + uuid.uuid4().hex) as cursor:
        cursor.execute(statement, (store.workspace_id,))
        while batch := cursor.fetchmany(batch_size):
            yield from batch


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _file_chunks(store, target):
    # A root-enabled workspace may mix legacy BYTEA and file-backed chunks in
    # one attachment. The common helpers resolve both under the workspace lock.
    for identity, attachment in _attachments(target):
        if attachment.get("storage") != "chunks":
            continue
        expected = 0
        for offset, length, storage_type in store.chunk_list(identity):
            if (type(offset) is not int or offset != expected or type(length) is not int
                    or not 0 < length <= CHUNK_SIZE or storage_type != "blob"
                    or store.chunk_info(identity, offset) != (length, "blob")):
                raise BackupError("Finalized attachment has invalid chunk references")
            data = store.chunk_read_range(identity, offset, 0, length)
            if not isinstance(data, bytes) or len(data) != length:
                raise BackupError("Finalized attachment chunk is missing or truncated")
            target.execute("INSERT INTO attachment_chunks VALUES (?,?,?)", (identity, offset, data))
            expected += length


def _export(store, target):
    with store.transaction():
        # The shared workspace advisory lock fences all application writers until
        # entities, metadata and their attachment bytes have been copied together.
        for kind, identity, data, created, updated in _rows(store,
                "SELECT kind,id,data,created_at,updated_at FROM fountain_private.entities "
                "WHERE workspace_id=%s ORDER BY kind,id"):
            if kind == "attachment_chunk":
                continue
            target.execute("INSERT INTO entities VALUES (?,?,?,?,?)",
                           (kind, identity, _json(data), created, updated))
        for key, data in _rows(store,
                "SELECT key,data FROM fountain_private.meta WHERE workspace_id=%s ORDER BY key"):
            if key in ("attachment_file_root", "attachment_file_gc_cursor"):
                continue
            target.execute("INSERT INTO meta VALUES (?,?)", (key, _json(data)))
        if _provenance_provisioned(store):
            target.execute(INDEX_DEFINITIONS['content_provenance'])
            columns = ','.join(PROVENANCE_COLUMNS)
            for row in _rows(store, 'SELECT '+columns+' FROM fountain_private.content_provenance '
                             'WHERE workspace_id=%s ORDER BY kind COLLATE "C",id COLLATE "C"'):
                target.execute('INSERT INTO content_provenance VALUES ('+','.join('?' for _ in row)+')', row)
        provisioned = store._execute("SELECT to_regclass('fountain_private.retention_records') IS NOT NULL", fetch='one')[0]
        populated = provisioned and store._execute('SELECT EXISTS ('+' UNION ALL '.join('(SELECT 1 FROM fountain_private.'+table+' WHERE workspace_id=%s LIMIT 1)' for table in VAULT_COLUMNS)+')', (store.workspace_id,)*len(VAULT_COLUMNS),fetch='one')[0]
        if populated:
            # Raw TEXT is copied without JSONB reserialization. All six tables
            # belong to this same locked source transaction.
            for table, names in VAULT_COLUMNS.items():
                target.execute(VAULT_DEFINITIONS[table])
                columns = ','.join('"'+name+'"' for name in names)
                primary = [row[1] for row in sorted(target.execute('PRAGMA table_info('+table+')'),key=lambda row:row[5]) if row[5]]
                order = ','.join('"'+name+'"'+('' if name=='offset' else ' COLLATE "C"') for name in primary)
                for row in _rows(store, 'SELECT '+columns+' FROM fountain_private.'+table+
                                 ' WHERE workspace_id=%s ORDER BY '+order,batch_size=1):
                    target.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in row)+')', row)
        if store._files is not None:
            _file_chunks(store, target)
            target.commit()
            return
        # Incomplete/orphaned uploads are omitted exactly as create_backup prunes
        # them. Finalized chunks still pass its size, continuity and digest checks.
        for identity, offset, length, data in _rows(store,
                'SELECT c.attachment_id,c."offset",octet_length(c.data),'
                'substring(c.data FROM 1 FOR 4194304) FROM fountain_private.attachment_chunks c '
                "WHERE c.workspace_id=%s AND (EXISTS (SELECT 1 FROM fountain_private.entities e "
                "WHERE e.workspace_id=c.workspace_id AND e.kind='attachment' AND e.id=c.attachment_id "
                "AND e.data->>'storage'='chunks') "
                + ("OR EXISTS (SELECT 1 FROM fountain_private.retention_entities r "
                   "WHERE r.workspace_id=c.workspace_id AND r.kind='attachment' AND r.id=c.attachment_id "
                   "AND (r.data::jsonb->>'storage'='chunks' OR EXISTS (SELECT 1 FROM fountain_private.retention_entities o WHERE o.workspace_id=r.workspace_id AND o.record_id=r.record_id AND o.kind='attachment_cloud' AND o.id=r.id AND o.data::jsonb->>'storage'='chunks'))) " if provisioned else '')
                + ') ORDER BY c.attachment_id,c."offset"',
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
