"""Complete SQLite snapshots without active sessions or unfinished uploads."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from contextlib import closing, nullcontext
from datetime import datetime, timezone, timedelta
from pathlib import Path

from .content_index import INDEX_DEFINITIONS, header as content_header
from .retention_vault import VAULT_COLUMNS, VAULT_DEFINITIONS, VAULT_TRIGGER_DEFINITIONS, SNAPSHOT_KINDS, RetentionVault, _same_attachment_source


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
PROVENANCE_COLUMNS = ('kind', 'id', 'generation', 'creator_id', 'creator_cause',
                      'editor_id', 'edited_at', 'editor_cause', 'manager_id', 'manager_at')
PROVENANCE_CAUSES = {'unknown', 'human', 'automation', 'import', 'public_form', 'system'}


def _history_id(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 160 or '\0' in value:
        return False
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return True


def _history_time(value):
    if value is None:
        return True
    if not isinstance(value, str) or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', value):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return False
    return True


def _inspect_provenance(connection, tables):
    if 'content_provenance' not in tables:
        return
    columns = ','.join(PROVENANCE_COLUMNS)
    for row in connection.execute('SELECT '+columns+' FROM content_provenance ORDER BY kind,id'):
        kind, identity, generation, creator, creator_cause, editor, edited_at, editor_cause, manager, manager_at = row
        if (kind not in ('page', 'database', 'row') or not _history_id(identity)
                or not isinstance(generation, str) or re.fullmatch('[a-f0-9]{32}', generation) is None
                or any(actor is not None and not _history_id(actor) for actor in (creator, editor, manager))
                or creator_cause not in PROVENANCE_CAUSES or editor_cause not in PROVENANCE_CAUSES
                or not _history_time(edited_at) or not _history_time(manager_at)
                or (manager is None) != (manager_at is None)
                or (editor is None and edited_at is not None)):
            raise BackupError('Source contains invalid content provenance')
        if connection.execute('SELECT 1 FROM entities WHERE kind=? AND id=?', (kind, identity)).fetchone() is None:
            raise BackupError('Content provenance has no matching source resource')
        if 'content_search_documents' in tables:
            indexed = connection.execute('SELECT generation FROM content_search_documents WHERE kind=? AND id=?',
                                         (kind, identity)).fetchone()
            if indexed != (generation,):
                raise BackupError('Content provenance generation does not match its resource index')


def _provenance_digest(rows):
    digest, count = hashlib.sha256(), 0
    for row in rows:
        raw = json.dumps(list(row), ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        digest.update(len(raw).to_bytes(8, 'big'))
        digest.update(raw)
        count += 1
    return count, digest.hexdigest()


def _provenance_provisioned(store):
    return store._execute("SELECT to_regclass('fountain_private.content_provenance') IS NOT NULL "
                          "AND to_regclass('fountain_private.content_search_documents') IS NOT NULL",
                          fetch='one')[0] is True


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


def _vault_json(encoded):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise BackupError('Duplicate private retention JSON key')
            result[key] = value
        return result
    value = json.loads(encoded, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(BackupError('Nonfinite retention JSON')))
    if not isinstance(value, dict):
        raise BackupError('Private retention JSON must be an object')
    return value


def inspect_portable_vault(connection):
    """Validate private portable state without executing source-owned SQL."""
    def require(condition):
        if not condition:
            raise BackupError('Invalid private retention state')
    hex32 = lambda value: isinstance(value, str) and re.fullmatch('[a-f0-9]{32}', value) is not None
    safe = lambda value: type(value) is int and 0 <= value <= 9007199254740991
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    require(set(VAULT_COLUMNS) <= tables)
    normalize = lambda sql: re.sub(r'\s+', '', sql).casefold()
    for table, names in VAULT_COLUMNS.items():
        definition = connection.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone()[0]
        require(normalize(definition) == normalize(VAULT_DEFINITIONS[table]))
        info = connection.execute('PRAGMA table_xinfo('+table+')').fetchall()
        require(tuple(row[1] for row in info) == names and all(row[4] is None and row[6] == 0 for row in info))
    records = set()
    roots = {}
    for identity, encoded, created, updated in connection.execute('SELECT * FROM retention_records'):
        row = _vault_json(encoded)
        require(hex32(identity) and set(row) == {'version','root_kind','root_id','generation','state','deleted_at','retained_at','purge_after','retention_days','source_revision','record_revision','actor_id','cause','header','counts'})
        require(type(row['version']) is int and row['version'] == 1 and row['root_kind'] == 'page' and _history_id(row['root_id']) and hex32(row['generation']) and row['state'] == 'retained')
        require(type(row['retention_days']) is int and 1 <= row['retention_days'] <= 3650 and safe(row['source_revision']) and safe(row['record_revision']) and row['record_revision'] >= 1)
        require(row['actor_id'] is None or _history_id(row['actor_id']))
        require(row['cause'] in ('manual','policy') and isinstance(row['header'], dict))
        for stamp in (created, updated, row['deleted_at'], row['retained_at'], row['purge_after']):
            require(stamp is not None and _history_time(stamp))
        require(datetime.fromisoformat(row['purge_after'].replace('Z','+00:00')) - datetime.fromisoformat(row['retained_at'].replace('Z','+00:00')) == timedelta(days=row['retention_days']))
        require(isinstance(row['counts'], dict) and set(row['counts']) == {'entities','provenance','refs','reservations','links'})
        for key, table in (('entities','retention_entities'),('provenance','retention_provenance'),('refs','retention_attachment_refs'),('reservations','retention_identity_reservations'),('links','retention_links')):
            require(safe(row['counts'][key]) and row['counts'][key] == connection.execute('SELECT count(*) FROM '+table+' WHERE record_id=?', (identity,)).fetchone()[0])
        root = connection.execute("SELECT generation,ownership,data FROM retention_entities WHERE record_id=? AND kind='page' AND id=?", (identity,row['root_id'])).fetchone()
        require(root is not None and root[:2] == (row['generation'],'owned') and (_vault_json(root[2]).get('archived') is True or _vault_json(root[2]).get('deleted') is True))
        require(row['header'] == content_header('page', _vault_json(root[2])))
        records.add(identity)
        roots[identity] = row['root_id']
    for record, kind, identity, encoded, created, updated, generation, ownership in connection.execute('SELECT * FROM retention_entities'):
        value = _vault_json(encoded)
        require(record in records and kind in SNAPSHOT_KINDS and _history_id(identity) and value.get('id') == identity and ownership in ('owned','shared'))
        require(ownership != 'shared' or kind in ('attachment','attachment_cloud','attachment_chunk'))
        require(_history_time(created) and created is not None and _history_time(updated) and updated is not None)
        require(hex32(generation) if kind in ('page','database','row') else generation is None or hex32(generation))
        def owned(target_kind, target_id):
            return _history_id(target_id) and connection.execute("SELECT 1 FROM retention_entities WHERE record_id=? AND kind=? AND id=? AND ownership='owned'", (record,target_kind,target_id)).fetchone() is not None
        references = RetentionVault._attachment_ids(value,kind) if kind in ('page','version','collaboration','row') else set()
        if kind == 'row':
            database = connection.execute("SELECT data FROM retention_entities WHERE record_id=? AND kind='database' AND id=?", (record,value.get('database_id'))).fetchone()
            require(database is not None)
            for prop in _vault_json(database[0]).get('properties', []):
                if isinstance(prop,dict) and prop.get('type') == 'files':
                    for entry in (value.get('properties',{}).get(prop.get('id')) or []):
                        candidate = entry if isinstance(entry,str) else entry.get('id') if isinstance(entry,dict) else None
                        require(_history_id(candidate));references.add(candidate)
        for attachment in references:
            require(connection.execute("SELECT 1 FROM retention_entities WHERE record_id=? AND kind='attachment' AND id=?", (record,attachment)).fetchone() is not None)
        if kind in ('page','database','row'):
            require(connection.execute('SELECT generation FROM retention_provenance WHERE record_id=? AND kind=? AND id=?', (record,kind,identity)).fetchone() == (generation,))
        if kind == 'page' and identity != roots[record]:
            parent = value.get('parent_id')
            require(owned('page',parent))
            visited = {identity}
            while parent != roots[record]:
                require(parent not in visited)
                visited.add(parent)
                parent_data = connection.execute("SELECT data FROM retention_entities WHERE record_id=? AND kind='page' AND id=?", (record,parent)).fetchone()
                require(parent_data is not None)
                parent = _vault_json(parent_data[0]).get('parent_id')
                require(owned('page',parent))
        elif kind == 'database': require(owned('page',value.get('page_id') or value.get('parent_id')))
        elif kind == 'row': require(owned('database',value.get('database_id')))
        elif kind in ('version','comment','site','transcript'): require(owned('page',value.get('page_id')))
        elif kind in ('collaboration','wiki_page'): require(owned('page',value.get('page_id') or identity))
        elif kind == 'form': require(owned('database',value.get('database_id')))
        elif kind == 'automation': require(owned('database',value.get('database_id')) or owned('row',value.get('row_id')))
        if ownership == 'owned':
            reservation = connection.execute('SELECT record_id,generation FROM retention_identity_reservations WHERE kind=? AND id=?', (kind,identity)).fetchone()
            require(reservation is not None and reservation[0] == record and hex32(reservation[1]) and (generation is None or reservation[1] == generation))
            live = connection.execute('SELECT data,created_at,updated_at FROM entities WHERE kind=? AND id=?', (kind,identity)).fetchone()
            require(live is None or kind in ('attachment','attachment_cloud','attachment_chunk') and _same_attachment_source(kind,live,(encoded,created,updated)))
    for kind, identity, record, generation in connection.execute('SELECT * FROM retention_identity_reservations'):
        require(record in records and hex32(generation))
        require(connection.execute("SELECT 1 FROM retention_entities WHERE record_id=? AND kind=? AND id=? AND ownership='owned'", (record,kind,identity)).fetchone() is not None)
    for row in connection.execute('SELECT * FROM retention_provenance'):
        record, kind, identity, generation, creator, creator_cause, editor, edited_at, editor_cause, manager, manager_at = row
        require(record in records and kind in ('page','database','row') and hex32(generation))
        require(all(value is None or _history_id(value) for value in (creator,editor,manager)))
        require(creator_cause in PROVENANCE_CAUSES and editor_cause in PROVENANCE_CAUSES and _history_time(edited_at) and _history_time(manager_at) and (manager is None) == (manager_at is None) and (editor is not None or edited_at is None))
        require(connection.execute('SELECT generation FROM retention_entities WHERE record_id=? AND kind=? AND id=?', (record,kind,identity)).fetchone() == (generation,))
    for record, attachment, storage, physical, offset, size, digest in connection.execute('SELECT * FROM retention_attachment_refs'):
        require(record in records and _history_id(attachment) and _history_id(physical) and storage in ('blob','file','cloud') and safe(offset) and offset % CHUNK_SIZE == 0 and type(size) is int and 0 < size <= CHUNK_SIZE and isinstance(digest,str) and re.fullmatch('[a-f0-9]{64}',digest) is not None)
        require(connection.execute("SELECT 1 FROM retention_entities WHERE record_id=? AND kind='attachment' AND id=?", (record,attachment)).fetchone() is not None)
        if storage == 'file':
            require(physical == digest)
            manifests = connection.execute("SELECT data FROM retention_entities WHERE record_id=? AND kind='attachment_chunk'", (record,))
            require(any((value.get('attachment_id'),value.get('offset'),value.get('size'),value.get('sha256')) == (attachment,offset,size,digest) for (raw,) in manifests for value in [_vault_json(raw)]))
        if storage == 'cloud':
            manifest_row = connection.execute("SELECT data FROM retention_entities WHERE record_id=? AND id=? AND kind IN('attachment','attachment_cloud') ORDER BY CASE kind WHEN 'attachment_cloud' THEN 0 ELSE 1 END LIMIT 1", (record,attachment)).fetchone()
            require(manifest_row is not None)
            cloud = _vault_json(manifest_row[0]);items = cloud.get('cloud_chunks')
            require(isinstance(items,list) and any(isinstance(item,dict) and set(item) == {'version','attachmentId','offset','size','sha256'} and item.get('version') == 1 and (item.get('attachmentId'),item.get('offset'),item.get('size'),item.get('sha256')) == (physical,offset,size,digest) for item in items))
        if storage == 'blob': require(physical == attachment)
        # A portable BLOB copy can satisfy an external physical pin while its
        # original manifest remains immutable history. Actual restore validates
        # and materializes its target backend separately.
        blob = connection.execute('SELECT data FROM attachment_chunks WHERE attachment_id=? AND offset=?', (attachment,offset)).fetchone() if 'attachment_chunks' in tables else None
        if blob is not None:
            require(isinstance(blob[0],bytes) and len(blob[0]) == size and hashlib.sha256(blob[0]).hexdigest() == digest)
        else: require(False)
    for record, identity, encoded in connection.execute("SELECT record_id,id,data FROM retention_entities WHERE kind='attachment'"):
        overlay = connection.execute("SELECT data FROM retention_entities WHERE record_id=? AND kind='attachment_cloud' AND id=?", (record,identity)).fetchone()
        attachment = _vault_json(overlay[0] if overlay else encoded)
        if attachment.get('storage') == 'chunks':
            size = attachment.get('size');require(type(size) is int and 0 <= size <= MAX_ATTACHMENT_SIZE)
            for offset in range(0,size,CHUNK_SIZE):
                pins = connection.execute('SELECT size FROM retention_attachment_refs WHERE record_id=? AND attachment_id=? AND offset=?', (record,identity,offset)).fetchall()
                require(pins and all(row == (min(CHUNK_SIZE,size-offset),) for row in pins))
            require(connection.execute('SELECT count(DISTINCT offset) FROM retention_attachment_refs WHERE record_id=? AND attachment_id=?', (record,identity)).fetchone()[0] == (size+CHUNK_SIZE-1)//CHUNK_SIZE)
    for record, kind, identity, encoded in connection.execute('SELECT * FROM retention_links'):
        value = _vault_json(encoded)
        require(record in records and kind == 'row' and _history_id(identity) and set(value) == {'generation','before','after'} and hex32(value['generation']))
        require(isinstance(value['before'],list) and isinstance(value['after'],list) and all(_history_id(item) for item in value['before'] + value['after']) and len(set(value['before'])) == len(value['before']) and len(set(value['after'])) == len(value['after']))
        require(all(item in value['before'] for item in value['after']))
        for removed in set(value['before']) - set(value['after']):
            require(connection.execute("SELECT 1 FROM retention_entities WHERE record_id=? AND kind='row' AND id=? AND ownership='owned'", (record,removed)).fetchone() is not None)
    return {table: connection.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in VAULT_COLUMNS}


def _attachments(connection):
    # One immutable logical attachment may be referenced by live entities and
    # several retained records. Validate every copy, emit physical bytes once.
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    statement = "SELECT id,data FROM entities WHERE kind='attachment'"
    if 'retention_entities' in tables:
        statement += " UNION ALL SELECT id,data FROM retention_entities WHERE kind='attachment' UNION ALL SELECT id,data FROM retention_entities WHERE kind='attachment_cloud'"
    seen = {}
    for identity, data in connection.execute('SELECT id,data FROM ('+statement+") ORDER BY id,CASE WHEN json_extract(data,'$.storage')='chunks' THEN 0 ELSE 1 END"):
        try:
            attachment = _strict_json(data)
        except (ValueError, TypeError, RecursionError) as error:
            raise BackupError("Invalid attachment metadata") from error
        if not isinstance(attachment, dict) or attachment.get("id") != identity:
            raise BackupError("Invalid attachment metadata")
        checksum = attachment.get('sha256')
        if checksum is None and attachment.get('storage','inline') == 'inline' and isinstance(attachment.get('data'),str):
            try: checksum = hashlib.sha256(base64.b64decode(attachment['data'],validate=True)).hexdigest()
            except (ValueError,TypeError) as error: raise BackupError('Invalid inline retained attachment bytes') from error
        fingerprint = (attachment.get('size'), checksum)
        if identity in seen:
            if seen[identity] != fingerprint:
                raise BackupError("Retained attachment conflicts with its immutable physical source")
            continue
        seen[identity] = fingerprint
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
            if not any(current == identity and attachment.get('storage') == 'chunks'
                       for current, attachment in _attachments(connection)):
                raise BackupError("Backup contains incomplete or orphaned attachment chunks")


def _prune_chunks(connection):
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    if "attachment_chunks" not in tables:
        return
    # Retained-only attachments are first-class physical sources. Do not prune
    # their bytes just because the ordinary live entity was moved to the vault.
    keep = {identity for identity, attachment in _attachments(connection) if attachment.get('storage') == 'chunks'}
    for (identity,) in connection.execute('SELECT DISTINCT attachment_id FROM attachment_chunks'):
        if identity not in keep:
            connection.execute('DELETE FROM attachment_chunks WHERE attachment_id=?', (identity,))


def _activity_contract(tables):
    names = {'activity_ledgers','activity_memberships','activity_accounts','activity_events',
             'activity_runtime','activity_current_members','activity_current_accounts'}
    if not tables & names:
        return {}, {}, {}, None
    try:
        from .activity import (ACTIVITY_COLUMNS, ACTIVITY_RUNTIME_COLUMNS,
                               ACTIVITY_TRIGGER_DEFINITIONS, inspect_portable_activity)
    except ImportError as error:
        raise BackupError('Activity backup support is not ready; source was preserved') from error
    return ACTIVITY_COLUMNS, ACTIVITY_RUNTIME_COLUMNS, ACTIVITY_TRIGGER_DEFINITIONS, inspect_portable_activity


def _inspect(connection, *, validate_attachments=True, complete_only=False):
    objects = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema").fetchall()
    tables = {name for kind, name, _, _ in objects if kind == "table"}
    derivative = set(INDEX_DEFINITIONS)
    vault = set(VAULT_COLUMNS)
    if tables & vault not in (set(), vault):
        raise BackupError("Source contains an incomplete retention vault schema")
    activity, runtime, activity_guards, inspect_activity = _activity_contract(tables)
    if (tables & set(activity) not in (set(), set(activity))
            or tables & set(runtime) not in (set(), set(runtime))
            or tables & set(runtime) and not tables & set(activity)):
        raise BackupError('Source contains an incomplete activity schema')
    activity_tables = set(activity) | set(runtime)
    guards = {**VAULT_TRIGGER_DEFINITIONS, **activity_guards}
    ordinary = tables - derivative - vault - activity_tables
    if ordinary not in ({"entities", "meta"}, set(SCHEMA)) or tables & derivative not in (set(), {'content_provenance'}, derivative):
        raise BackupError("Source must contain exactly the Fountain tables")
    for kind, name, table, definition in objects:
        implicit_index = (kind == "index" and table in set(SCHEMA) | derivative | vault | activity_tables
                          and name in ({f"sqlite_autoindex_{table}_1",f"sqlite_autoindex_{table}_2",f"sqlite_autoindex_{table}_3"} if table=="activity_events" else {f"sqlite_autoindex_{table}_1"}) and definition is None)
        known_guard = (kind == 'trigger' and name in guards
                       and re.sub(r'\s+', '', definition or '').casefold()
                       == re.sub(r'\s+', '', guards[name]).casefold())
        if not (kind == "table" and name in set(SCHEMA) | derivative | vault | activity_tables) and not implicit_index and not known_guard:
            raise BackupError("Source contains unsupported database objects")
        if kind == "table" and (not definition or "VIRTUAL" in definition.upper()):
            raise BackupError("Virtual tables are not permitted")
    normalize = lambda sql: re.sub(r"\s+", "", sql).casefold()
    for table in tables & derivative:
        definition = next(sql for kind, name, _, sql in objects if kind == "table" and name == table)
        if normalize(definition) != normalize(INDEX_DEFINITIONS[table]):
            raise BackupError(f"Unsupported {table} table definition")
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
    _inspect_provenance(connection, tables)
    if tables & vault:
        try:
            inspect_portable_vault(connection)
        except (ValueError, TypeError, KeyError) as error:
            raise BackupError("Source contains invalid private retention state") from error
    if inspect_activity:
        try:
            inspect_activity(connection)
        except Exception as error:
            from .core import APIError
            if not isinstance(error, (APIError, ValueError, TypeError, KeyError, sqlite3.Error)):
                raise
            raise BackupError('Source contains invalid private activity history') from error
    if validate_attachments:
        _inspect_chunks(connection, tables, complete_only)
    return counts


def inspect_backup(path):
    try:
        with closing(_open_source(path)) as source:
            return _inspect(source)
    except sqlite3.Error as error:
        raise BackupError(f"Cannot read Fountain database: {error}") from error


def _copy(source_path, destination_path, *, activate_activity=False):
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
                # Guards invoke connection-private authority functions. Only
                # exact reviewed definitions passed _inspect; the portable copy
                # carries data, never executable SQL or authority callbacks.
                copied_tables = {r[0] for r in target.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
                activity, runtime, activity_guards, _ = _activity_contract(copied_tables)
                guards = {**VAULT_TRIGGER_DEFINITIONS, **activity_guards}
                for (name,) in target.execute("SELECT name FROM sqlite_schema WHERE type='trigger'").fetchall():
                    if name not in guards:
                        raise BackupError('Unsupported private mutation guard')
                    target.execute('DROP TRIGGER "' + name.replace('"', '""') + '"')
                for table in reversed(tuple(runtime)):
                    target.execute('DROP TABLE IF EXISTS '+table)
                activity_populated = bool(activity) and any(target.execute('SELECT 1 FROM '+table+' LIMIT 1').fetchone() is not None for table in activity)
                if activity and not activity_populated:
                    for table in reversed(tuple(activity)):
                        target.execute('DROP TABLE IF EXISTS '+table)
                if not activity_populated and target.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='retention_records'").fetchone() is not None and target.execute('SELECT 1 FROM retention_records LIMIT 1').fetchone() is None:
                    for table in reversed(tuple(VAULT_COLUMNS)):
                        target.execute('DROP TABLE '+table)
                if activity_populated:
                    for table, definition in VAULT_DEFINITIONS.items():
                        if table not in copied_tables:
                            target.execute(definition)
                    if 'content_provenance' not in copied_tables:
                        target.execute(INDEX_DEFINITIONS['content_provenance'])
                    if 'attachment_chunks' not in copied_tables:
                        target.execute(DEFINITIONS['attachment_chunks'])
                target.execute("PRAGMA secure_delete=ON")
                # Trusted full snapshots preserve non-derivable attribution;
                # rebuild only search data and regenerate cursor credentials.
                for table in ('content_search_chunks','content_search_documents','content_search_state'):
                    target.execute('DROP TABLE IF EXISTS '+table)
                placeholders = ",".join("?" for _ in PRIVATE_KINDS)
                target.execute(f"DELETE FROM entities WHERE kind IN ({placeholders})", PRIVATE_KINDS)
                _prune_chunks(target)
                target.execute("DELETE FROM meta WHERE key = 'local_cache_binding'")
                target.commit()
                target.execute("VACUUM")
                counts = _inspect(target, complete_only=True)
                if activate_activity and activity_populated:
                    try:
                        from .activity import activate_restore_connection
                    except ImportError as error:
                        raise BackupError('Trusted activity restore activation is not ready; destination was not published') from error
                    activate_restore_connection(target)
                    target.commit()
                    _inspect(target, complete_only=True)
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
    return _copy(source_path, destination_path, activate_activity=True)


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
