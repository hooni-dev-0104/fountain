"""Private, transactional retained page storage. No public purge or policy activation."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from .core import APIError, require, uid

VAULT_COLUMNS = {
    'retention_records': ('id','data','created_at','updated_at'),
    'retention_entities': ('record_id','kind','id','data','created_at','updated_at','generation','ownership'),
    'retention_provenance': ('record_id','kind','id','generation','creator_id','creator_cause','editor_id','edited_at','editor_cause','manager_id','manager_at'),
    'retention_attachment_refs': ('record_id','attachment_id','storage_kind','physical_id','offset','size','sha256'),
    'retention_identity_reservations': ('kind','id','record_id','generation'),
    'retention_links': ('record_id','kind','id','data'),
}
VAULT_DEFINITIONS = {
    'retention_records': 'CREATE TABLE retention_records (id TEXT NOT NULL PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
    'retention_entities': 'CREATE TABLE retention_entities (record_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,generation TEXT,ownership TEXT NOT NULL,PRIMARY KEY(record_id,kind,id))',
    'retention_provenance': 'CREATE TABLE retention_provenance (record_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,creator_id TEXT,creator_cause TEXT NOT NULL,editor_id TEXT,edited_at TEXT,editor_cause TEXT NOT NULL,manager_id TEXT,manager_at TEXT,PRIMARY KEY(record_id,kind,id))',
    'retention_attachment_refs': 'CREATE TABLE retention_attachment_refs (record_id TEXT NOT NULL,attachment_id TEXT NOT NULL,storage_kind TEXT NOT NULL,physical_id TEXT NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(record_id,attachment_id,storage_kind,physical_id,offset))',
    'retention_identity_reservations': 'CREATE TABLE retention_identity_reservations (kind TEXT NOT NULL,id TEXT NOT NULL,record_id TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(kind,id))',
    'retention_links': 'CREATE TABLE retention_links (record_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(record_id,kind,id))',
}
SNAPSHOT_KINDS = ('page','database','row','version','comment','collaboration','wiki_page','site','form','automation','transcript','attachment','attachment_cloud','attachment_chunk')
SHARED = ('attachment','attachment_cloud','attachment_chunk')
MAX_INT = 9007199254740991
HEX = re.compile(r'^[a-f0-9]{32}$')
HASH = re.compile(r'^[a-f0-9]{64}$')
PROVENANCE_COLUMNS = VAULT_COLUMNS['retention_provenance'][1:]

# The only bypass is a Python connection closure. Entity JSON and SQL metadata
# cannot turn it on; raw SQL connections without the UDF fail closed.
VAULT_TRIGGER_DEFINITIONS = {}
for _table in VAULT_COLUMNS:
    for _op in ('INSERT','UPDATE','DELETE'):
        _name = 'fountain_vault_' + _table + '_' + _op.lower()
        VAULT_TRIGGER_DEFINITIONS[_name] = f"CREATE TRIGGER {_name} BEFORE {_op} ON {_table} WHEN fountain_retention_transition()=0 BEGIN SELECT RAISE(ABORT,'Private retention state'); END"
_reserved = "EXISTS(SELECT 1 FROM retention_identity_reservations r WHERE r.kind=NEW.kind AND r.id=NEW.id)"
_parent = "EXISTS(SELECT 1 FROM retention_identity_reservations r WHERE (r.kind='page' AND (r.id=json_extract(NEW.data,'$.parent_id') OR r.id=json_extract(NEW.data,'$.page_id') OR (NEW.kind IN ('collaboration','wiki_page') AND r.id=NEW.id))) OR (r.kind='database' AND r.id=json_extract(NEW.data,'$.database_id')) OR (r.kind='row' AND (r.id=json_extract(NEW.data,'$.row_id') OR r.id=json_extract(NEW.data,'$.parent_row_id'))))"
def _metadata_pin(row):
    identity="CASE WHEN "+row+".kind='attachment_chunk' THEN json_extract("+row+".data,'$.attachment_id') ELSE "+row+".id END"
    return row+".kind IN ('attachment','attachment_cloud','attachment_chunk') AND (EXISTS(SELECT 1 FROM retention_attachment_refs r WHERE r.attachment_id="+identity+") OR EXISTS(SELECT 1 FROM retention_entities e WHERE e.kind='attachment' AND e.id="+identity+"))"
_pinned_new = _metadata_pin('NEW')
_pinned_old = _metadata_pin('OLD')
for _op in ('INSERT','UPDATE'):
    _name = 'fountain_vault_entities_' + _op.lower()
    _condition = f'({_reserved}) OR ({_parent}) OR ({_pinned_new})' + (f' OR ({_pinned_old})' if _op == 'UPDATE' else '')
    VAULT_TRIGGER_DEFINITIONS[_name] = f"CREATE TRIGGER {_name} BEFORE {_op} ON entities WHEN fountain_retention_transition()=0 AND ({_condition}) BEGIN SELECT RAISE(ABORT,'Retained identity or attachment is reserved'); END"
VAULT_TRIGGER_DEFINITIONS['fountain_vault_entities_delete'] = f"CREATE TRIGGER fountain_vault_entities_delete BEFORE DELETE ON entities WHEN fountain_retention_transition()=0 AND ({_pinned_old}) BEGIN SELECT RAISE(ABORT,'Retained attachment is pinned'); END"
for _op in ('INSERT','UPDATE','DELETE'):
    _name = 'fountain_vault_chunks_' + _op.lower()
    _row='NEW' if _op=='INSERT' else 'OLD'
    def _chunk_pin(row):
        return "(EXISTS(SELECT 1 FROM retention_attachment_refs r WHERE r.attachment_id="+row+".attachment_id OR (r.storage_kind='blob' AND r.physical_id="+row+".attachment_id)) OR EXISTS(SELECT 1 FROM retention_entities e WHERE e.kind='attachment' AND e.id="+row+".attachment_id))"
    _refs = _chunk_pin(_row)
    if _op=='UPDATE':_refs="("+_refs+" OR "+_chunk_pin('NEW')+")"
    VAULT_TRIGGER_DEFINITIONS[_name] = f"CREATE TRIGGER {_name} BEFORE {_op} ON attachment_chunks WHEN fountain_retention_transition()=0 AND {_refs} BEGIN SELECT RAISE(ABORT,'Retained attachment bytes are pinned'); END"
for _name,_definition in tuple(VAULT_TRIGGER_DEFINITIONS.items()):
    # Generic Store historically permits opaque/malformed raw fixture rows; the
    # retention fence checks identities without broadening JSON validation.
    for _row in ('NEW','OLD'):
        _definition=_definition.replace('json_extract('+_row+'.data,',"json_extract(CASE WHEN json_valid("+_row+".data) THEN "+_row+".data ELSE '{}' END,")
    VAULT_TRIGGER_DEFINITIONS[_name]=_definition


def _id(value):
    return isinstance(value,str) and 0 < len(value) <= 160 and '\0' not in value and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)


def _instant(value):
    if value is None: return datetime.now(timezone.utc)
    if isinstance(value,datetime): parsed=value
    else:
        require(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})',value), 'Invalid retention time')
        require(value.endswith('Z') or int(value[-5:-3])<=23 and int(value[-2:])<=59,'Invalid retention time')
        try: parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        except ValueError: raise APIError(400,'Invalid retention time') from None
    require(parsed.tzinfo is not None and parsed.utcoffset() is not None,'Retention time requires timezone')
    try:return parsed.astimezone(timezone.utc)
    except (ValueError,OverflowError):raise APIError(400,'Invalid retention time') from None


def _stamp(value): return value.isoformat(timespec='microseconds').replace('+00:00','Z')
def _encode(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)


def _same_attachment_source(kind,left,right):
    if left==right:return True
    if kind!='attachment' or left is None or right is None or left[1:]!=right[1:]:return False
    first,second=json.loads(left[0]),json.loads(right[0])
    for value in (first,second):
        value.pop('cloud_chunks',None);value.pop('storage_id',None)
    return first==second


class RetentionVault:
    def __init__(self,store):self.store=store
    @property
    def postgres(self):return getattr(self.store,'backend',None)=='postgres'

    def initialize(self):
        if self.postgres:
            with self.store.transaction():
                for name,columns in VAULT_COLUMNS.items():
                    self.store._execute('SELECT '+','.join('"'+key+'"' for key in columns)+' FROM fountain_private.'+name+' WHERE false')
            return
        with self.store.lock:
            if not hasattr(self.store,'_retention_transition_depth'):
                self.store._retention_transition_depth=0
                self.store.db.create_function('fountain_retention_transition',0,lambda: int(self.store._retention_transition_depth>0))
            for definition in VAULT_DEFINITIONS.values():self.store.db.execute(definition.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ',1))
            for definition in VAULT_TRIGGER_DEFINITIONS.values():self.store.db.execute(definition.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS ',1))
            self.store.commit()

    @contextmanager
    def _transition(self):
        self.store._retention_transition_depth+=1
        try:yield
        finally:self.store._retention_transition_depth-=1

    def identity_reserved(self,kind,identity):
        if not isinstance(kind,str) or not isinstance(identity,str):return False
        if self.postgres:
            with self.store.transaction():
                # Optional before migration; to_regclass avoids undefined-table errors.
                present=self.store._execute("SELECT to_regclass('fountain_private.retention_identity_reservations') IS NOT NULL",fetch='one')[0]
                if not present:return False
                return bool(self.store._execute('SELECT 1 FROM fountain_private.retention_identity_reservations WHERE workspace_id=%s AND kind=%s AND id=%s',(self.store.workspace_id,kind,identity),fetch='one'))
        return self.store.db.execute('SELECT 1 FROM retention_identity_reservations WHERE kind=? AND id=?',(kind,identity)).fetchone() is not None

    def guard_entity(self,kind,identity,value=None):
        if not self.postgres and self.store._retention_transition_depth:return
        require(not self.identity_reserved(kind,identity),'Retained identity is reserved',409)
        if kind in SHARED:
            prior=self.store.get(kind,identity)
            attachment=(value or prior or {}).get('attachment_id') if kind=='attachment_chunk' else identity
            require(not attachment or not self.attachment_pinned(attachment),'Retained attachment is pinned',409)
        if value is not None:
            parents=[('page',value.get('parent_id')),('page',value.get('page_id')),('database',value.get('database_id')),('row',value.get('row_id')),('row',value.get('parent_row_id'))]
            if kind in ('collaboration','wiki_page'):parents.append(('page',identity))
            require(not any(target is not None and self.identity_reserved(parent,target) for parent,target in parents),'Retained parent identity is reserved',409)

    def attachment_pinned(self,attachment_id=None,*,storage_kind=None,physical_id=None,offset=None):
        clauses=[];values=[]
        for key,value in (('attachment_id',attachment_id),('storage_kind',storage_kind),('physical_id',physical_id),('offset',offset)):
            if value is not None:clauses.append('"'+key+'"=?');values.append(value)
        require(bool(clauses),'Attachment pin selector required')
        if self.postgres:
            with self.store.transaction():
                if not self.store._execute("SELECT to_regclass('fountain_private.retention_attachment_refs') IS NOT NULL",fetch='one')[0]:return False
                found=bool(self.store._execute('SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=%s AND '+' AND '.join(c.replace('?','%s') for c in clauses)+' LIMIT 1',(self.store.workspace_id,*values),fetch='one'))
                if not found and attachment_id is not None and storage_kind is physical_id is offset is None:
                    found=bool(self.store._execute("SELECT 1 FROM fountain_private.retention_entities WHERE workspace_id=%s AND kind='attachment' AND id=%s LIMIT 1",(self.store.workspace_id,attachment_id),fetch='one'))
                return found
        found=bool(self.store.db.execute('SELECT 1 FROM retention_attachment_refs WHERE '+' AND '.join(clauses)+' LIMIT 1',values).fetchone())
        if not found and attachment_id is not None and storage_kind is physical_id is offset is None:
            found=bool(self.store.db.execute("SELECT 1 FROM retention_entities WHERE kind='attachment' AND id=? LIMIT 1",(attachment_id,)).fetchone())
        return found

    def records(self):
        self.initialize()
        if self.postgres:
            with self.store.transaction():return [{'id':r[0],**(json.loads(r[1]) if isinstance(r[1],str) else r[1])} for r in self.store._execute('SELECT id,data FROM fountain_private.retention_records WHERE workspace_id=%s ORDER BY created_at,id',(self.store.workspace_id,),fetch='all')]
        with self.store.lock:return [{'id':r[0],**json.loads(r[1])} for r in self.store.db.execute('SELECT id,data FROM retention_records ORDER BY created_at,id')]

    def _source(self,kind,identity):
        row=self.store.db.execute('SELECT data,created_at,updated_at FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone()
        if row is None and kind in SHARED:
            row=self.store.db.execute('SELECT data,created_at,updated_at FROM retention_entities WHERE kind=? AND id=? ORDER BY record_id LIMIT 1',(kind,identity)).fetchone()
        require(row is not None,'Retained source is missing',409)
        try:value=json.loads(row[0])
        except (ValueError,TypeError):raise APIError(409,'Retained source is invalid') from None
        require(isinstance(value,dict) and value.get('id')==identity and _id(identity),'Retained source identity is invalid',409)
        return row,value

    def _closure(self,page_id):
        db=self.store.db
        # IDs and graph edges only. Bodies are fetched one source at a time later.
        pages={r[0]:r[1] for r in db.execute("SELECT id,json_extract(data,'$.parent_id') FROM entities WHERE kind='page'")}
        selected={page_id};front=[page_id]
        while front:
            parent=front.pop()
            for identity,parent_id in pages.items():
                if parent_id==parent:
                    require(identity not in selected,'Page ownership cycle',409)
                    require(_id(identity),'Invalid child page identity',409)
                    selected.add(identity);front.append(identity)
        root_parent=pages.get(page_id)
        require(root_parent not in selected,'Page ownership cycle',409)
        databases={r[0] for r in db.execute("SELECT id FROM entities WHERE kind='database' AND (json_extract(data,'$.parent_id') IN (SELECT value FROM json_each(?)) OR json_extract(data,'$.page_id') IN (SELECT value FROM json_each(?)))",(_encode(sorted(selected)),_encode(sorted(selected))))}
        rows={r[0] for r in db.execute("SELECT id FROM entities WHERE kind='row' AND json_extract(data,'$.database_id') IN (SELECT value FROM json_each(?))",(_encode(sorted(databases)),))}
        keys={('page',v) for v in selected}|{('database',v) for v in databases}|{('row',v) for v in rows}
        for kind in ('version','comment','collaboration','wiki_page','site','form','automation','transcript'):
            for identity,page,database,row in db.execute("SELECT id,json_extract(data,'$.page_id'),json_extract(data,'$.database_id'),json_extract(data,'$.row_id') FROM entities WHERE kind=?",(kind,)):
                owned=(page in selected if kind in ('version','comment','site','transcript') else
                       page in selected or identity in selected if kind in ('collaboration','wiki_page') else
                       database in databases or kind=='automation' and row in rows)
                if owned:keys.add((kind,identity))
        for identity,page,completed,target in db.execute("SELECT id,json_extract(data,'$.page_id'),json_extract(data,'$.completed'),json_extract(data,'$.migration_target') FROM entities WHERE kind='upload'"):
            require(not (page in selected and completed!=1),'Pending upload prevents retention',409)
        return keys,selected,databases,rows

    @staticmethod
    def _attachment_ids(value,kind):
        """Only persisted attachment slots count; arbitrary JSON is authored text."""
        result=set()
        def add(identity):
            if identity is not None:
                require(_id(identity),'Invalid attachment reference',409);result.add(identity)
        if kind in ('page','version'):
            blocks=value.get('blocks',[])
            if isinstance(blocks,list):
                for block in blocks:
                    if isinstance(block,dict):add(block.get('attachment_id'))
        elif kind=='collaboration':
            state=value.get('state')
            if not isinstance(state,dict):return result
            history=state.get('history')
            baseline=history.get('baseline') if isinstance(history,dict) else None
            for document in (state,baseline):
                blocks=document.get('blocks') if isinstance(document,dict) else None
                if isinstance(blocks,dict):
                    for block in blocks.values():
                        fields=block.get('fields') if isinstance(block,dict) else None
                        register=fields.get('attachment_id') if isinstance(fields,dict) else None
                        if isinstance(register,dict):add(register.get('value'))
            operations=history.get('ops') if isinstance(history,dict) else None
            if isinstance(operations,dict):
                for operation in operations.values():
                    if isinstance(operation,dict) and operation.get('type')=='block.set' and operation.get('field')=='attachment_id':add(operation.get('value'))
        return result

    def _attachments(self,keys,pages):
        ids=set()
        for kind,identity in sorted(keys):
            _,value=self._source(kind,identity);ids.update(self._attachment_ids(value,kind))
            if kind=='row':
                database=self.store.get('database',value.get('database_id')) or {}
                for prop in database.get('properties',[]):
                    if isinstance(prop,dict) and prop.get('type')=='files':
                        for entry in (value.get('properties',{}).get(prop.get('id')) or []):
                            candidate=entry if isinstance(entry,str) else entry.get('id') if isinstance(entry,dict) else None
                            require(_id(candidate),'Invalid files attachment reference',409);ids.add(candidate)
        for identity,page in self.store.db.execute("SELECT id,json_extract(data,'$.page_id') FROM entities WHERE kind='attachment'"):
            if page in pages:ids.add(identity)
        shared=set()
        for identity in ids:
            _,metadata=self._source('attachment',identity)
            owner_page=metadata.get('page_id')
            if _id(owner_page) and owner_page not in pages and self.store.db.execute("SELECT 1 FROM entities WHERE kind='page' AND id=?",(owner_page,)).fetchone():shared.add(identity)
        for kind,identity in self.store.db.execute("SELECT kind,id FROM entities WHERE kind IN ('page','version','row','transcript','collaboration')"):
            if (kind,identity) in keys:continue
            _,value=self._source(kind,identity);shared.update(ids & self._attachment_ids(value,kind))
            if kind=='row':
                database=self.store.get('database',value.get('database_id')) or {}
                for prop in database.get('properties',[]):
                    if isinstance(prop,dict) and prop.get('type')=='files':
                        for item in value.get('properties',{}).get(prop.get('id'),[]) or []:
                            target=item if isinstance(item,str) else item.get('id') if isinstance(item,dict) else None
                            if target in ids:shared.add(target)
        return ids,shared

    def _copy(self,record,kind,identity,ownership='owned'):
        raw,value=self._source(kind,identity)
        provenance=self.store.db.execute('SELECT '+','.join(PROVENANCE_COLUMNS)+' FROM content_provenance WHERE kind=? AND id=?',(kind,identity)).fetchone() if kind in ('page','database','row') else None
        generation=provenance[2] if provenance else None
        reservation=self.store.db.execute('SELECT record_id FROM retention_identity_reservations WHERE kind=? AND id=?',(kind,identity)).fetchone()
        if reservation and kind in SHARED:
            retained=self.store.db.execute('SELECT data,created_at,updated_at FROM retention_entities WHERE record_id=? AND kind=? AND id=?',(reservation[0],kind,identity)).fetchone()
            require(_same_attachment_source(kind,retained,raw),'Shared retained attachment manifest conflicts',409)
            ownership='shared'
        require(kind not in ('page','database','row') or isinstance(generation,str) and HEX.fullmatch(generation),'Content generation is missing',409)
        self.store.db.execute('INSERT INTO retention_entities VALUES(?,?,?,?,?,?,?,?)',(record,kind,identity,*raw,generation,ownership))
        if provenance:self.store.db.execute('INSERT INTO retention_provenance VALUES('+','.join('?' for _ in range(11))+')',(record,*provenance))
        if ownership=='owned':self.store.db.execute('INSERT INTO retention_identity_reservations VALUES(?,?,?,?)',(kind,identity,record,generation or uid()))
        return value

    def _pin_attachment(self,record,identity):
        _,file=self._source('attachment',identity)
        require(type(file.get('size')) is int and 0<=file['size']<=MAX_INT,'Invalid attachment size',409)
        size=file['size'];digest=hashlib.sha256();position=0
        overlay=self.store.db.execute("SELECT 1 FROM entities WHERE kind='attachment_cloud' AND id=?",(identity,)).fetchone() or self.store.db.execute("SELECT 1 FROM retention_entities WHERE kind='attachment_cloud' AND id=?",(identity,)).fetchone()
        cloud=self._source('attachment_cloud',identity)[1] if overlay else file
        if isinstance(cloud.get('cloud_chunks'),list):
            for chunk in cloud['cloud_chunks']:
                require(isinstance(chunk,dict) and chunk.get('offset')==position and type(chunk.get('size')) is int and 0<chunk['size']<=4194304 and isinstance(chunk.get('sha256'),str) and HASH.fullmatch(chunk['sha256']),'Invalid cloud attachment manifest',409)
                physical=chunk.get('attachmentId',cloud.get('storage_id',identity));require(_id(physical),'Invalid cloud physical identity',409)
                self.store.db.execute('INSERT INTO retention_attachment_refs VALUES(?,?,?,?,?,?,?)',(record,identity,'cloud',physical,position,chunk['size'],chunk['sha256']));position+=chunk['size']
            require(position==size,'Incomplete cloud attachment manifest',409)
        elif file.get('storage')=='chunks':
            for offset,length,kind in self.store.chunk_list(identity):
                require(type(offset) is int and offset==position and type(length) is int and 0<length<=4194304 and kind=='blob','Invalid attachment chunk layout',409)
                part=hashlib.sha256()
                for start in range(0,length,65536):
                    piece=self.store.chunk_read_range(identity,offset,start,min(65536,length-start));require(piece is not None and len(piece)==min(65536,length-start),'Incomplete attachment bytes',409);part.update(piece);digest.update(piece)
                manifest=self.store.db.execute("SELECT id FROM entities WHERE kind='attachment_chunk' AND json_extract(data,'$.attachment_id')=? AND json_extract(data,'$.offset')=?",(identity,offset)).fetchone()
                storage='file' if manifest else 'blob';physical=part.hexdigest() if manifest else identity
                self.store.db.execute('INSERT INTO retention_attachment_refs VALUES(?,?,?,?,?,?,?)',(record,identity,storage,physical,offset,length,part.hexdigest()));position+=length
            require(position==size,'Incomplete attachment bytes',409)
            require(file.get('sha256')==digest.hexdigest(),'Attachment checksum differs',409)
        else:
            try:raw=base64.b64decode(file.get('data',''),validate=True)
            except (ValueError,TypeError):raise APIError(409,'Invalid inline attachment') from None
            require(len(raw)==size and (file.get('sha256') is None or file['sha256']==hashlib.sha256(raw).hexdigest()),'Inline attachment differs',409)

    def archive_page(self,page_id,at=None,retention_days=30,expected_revision=None,record_id=None):
        require(_id(page_id),'Invalid page identity');require(type(retention_days) is int and 1<=retention_days<=3650,'Invalid retention days')
        require(expected_revision is None or type(expected_revision) is int and 0<=expected_revision<=MAX_INT,'Invalid source revision')
        require(record_id is None or isinstance(record_id,str) and HEX.fullmatch(record_id),'Invalid retention record identity')
        instant=_instant(at)
        try:purge=_stamp(instant+timedelta(days=retention_days))
        except OverflowError:raise APIError(400,'Retention date exceeds supported range') from None
        self.initialize()
        from .content_index import ContentIndex, header, trusted_actor
        if self.postgres:
            with self.store.transaction():return self.store._execute('SELECT fountain_cloud.retention_archive_page(%s,%s,%s,%s,%s,%s,%s,%s)',(self.store.workspace_id,page_id,_stamp(instant),retention_days,expected_revision,record_id,trusted_actor(self.store),'manual'),fetch='one')[0]
        with self.store.transaction(),self._transition():
            actor=trusted_actor(self.store)
            record_id=record_id or uid();previous=self.store.db.execute('SELECT data FROM retention_records WHERE id=?',(record_id,)).fetchone()
            if previous:
                value=json.loads(previous[0]);require(value['root_id']==page_id and value['retention_days']==retention_days and (expected_revision is None or value['source_revision']==expected_revision) and (at is None or value['retained_at']==_stamp(instant)),'Retention retry differs',409);return {'id':record_id,**value}
            revision=self.store.meta('_entity_revision',0);require(type(revision) is int and 0<=revision<MAX_INT,'Source revision is invalid',413)
            require(expected_revision is None or expected_revision==revision,'Workspace changed before retention',409)
            raw,root=self._source('page',page_id);require(root.get('archived') is True,'Only trash pages can be retained',409)
            require(root.get('parent_id') is None or _id(root['parent_id']),'Invalid root parent identity',409)
            keys,pages,databases,rows=self._closure(page_id)
            for identity in rows:
                require(self.store.db.execute("SELECT 1 FROM retention_links WHERE kind='row' AND id=? LIMIT 1",(identity,)).fetchone() is None,'A retained dependency journal still references this row',409)
            attachments,shared=self._attachments(keys,pages)
            for completed,target in self.store.db.execute("SELECT json_extract(data,'$.completed'),json_extract(data,'$.migration_target') FROM entities WHERE kind='upload'"):
                require(not (completed!=1 and target in attachments),'Pending attachment migration prevents retention',409)
            for attachment in sorted(attachments):
                self._pin_attachment(record_id,attachment)
                for kind in SHARED:
                    targets=[attachment] if kind!='attachment_chunk' else [r[0] for r in self.store.db.execute("SELECT id FROM entities WHERE kind='attachment_chunk' AND json_extract(data,'$.attachment_id')=? UNION SELECT id FROM retention_entities WHERE kind='attachment_chunk' AND json_extract(data,'$.attachment_id')=?",(attachment,attachment))]
                    for identity in targets:
                        exists=self.store.db.execute('SELECT 1 FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone()
                        retained=self.store.db.execute('SELECT 1 FROM retention_entities WHERE kind=? AND id=?',(kind,identity)).fetchone()
                        if exists or retained:
                            ownership='shared' if attachment in shared or not exists else 'owned'
                            self._copy(record_id,kind,identity,ownership)
            for kind,identity in sorted(keys):self._copy(record_id,kind,identity)
            generation=self.store.db.execute("SELECT generation FROM retention_entities WHERE record_id=? AND kind='page' AND id=?",(record_id,page_id)).fetchone()[0]
            for identity,rawrow in self.store.db.execute("SELECT id,data FROM entities WHERE kind='row'"):
                if identity in rows:continue
                row=json.loads(rawrow);before=row.get('depends_on',[])
                require(isinstance(before,list) and all(_id(item) for item in before) and len(set(before))==len(before),'Invalid task dependencies',409)
                if rows.intersection(before):
                    require(self.store.db.execute("SELECT 1 FROM retention_links WHERE kind='row' AND id=? LIMIT 1",(identity,)).fetchone() is None,'A retained dependency journal already manages this row',409)
                    after=[item for item in before if item not in rows]
                    provenance=self.store.db.execute("SELECT generation FROM content_provenance WHERE kind='row' AND id=?",(identity,)).fetchone();require(provenance is not None,'Dependency generation is missing',409)
                    self.store.db.execute('INSERT INTO retention_links VALUES(?,?,?,?)',(record_id,'row',identity,_encode({'generation':provenance[0],'before':before,'after':after})))
                    row['depends_on']=after;self.store.put('row',row)
            for kind,identity in self.store.db.execute("SELECT kind,id FROM retention_entities WHERE record_id=? AND ownership='owned'",(record_id,)).fetchall():self.store.delete(kind,identity)
            # A different retained record can own the identity reservation. Its
            # reservation remains untouched, while exclusive current metadata
            # must still leave the public/live entity namespace.
            for kind,identity,raw in self.store.db.execute("SELECT kind,id,data FROM retention_entities WHERE record_id=? AND ownership='shared'",(record_id,)):
                attachment=json.loads(raw).get('attachment_id') if kind=='attachment_chunk' else identity
                if attachment not in shared:self.store.delete(kind,identity)
            counts={name: self.store.db.execute('SELECT count(*) FROM '+table+' WHERE '+('record_id' if table!='retention_records' else 'id')+'=?',(record_id,)).fetchone()[0] for name,table in (('entities','retention_entities'),('provenance','retention_provenance'),('refs','retention_attachment_refs'),('reservations','retention_identity_reservations'),('links','retention_links'))}
            deleted=root.get('deleted_at')
            if deleted is None:
                try:deleted=_instant(root.get('updated_at')) if root.get('updated_at') is not None else instant
                except APIError:deleted=instant
            else:deleted=_instant(deleted)
            data={'version':1,'root_kind':'page','root_id':page_id,'generation':generation,'state':'retained','deleted_at':_stamp(deleted),'retained_at':_stamp(instant),'purge_after':purge,'retention_days':retention_days,'source_revision':revision,'record_revision':1,'actor_id':actor,'cause':'manual','header':header('page',root),'counts':counts}
            self.store.db.execute('INSERT INTO retention_records VALUES(?,?,?,?)',(record_id,_encode(data),_stamp(instant),_stamp(instant)))
            self._touch();self.store.put('audit',{'action':'content.retained','details':{'record_id':record_id,'root_kind':'page','root_id':page_id,'entities':counts['entities']},'user':actor})
            self._check_entity_revision()
            return {'id':record_id,**data}

    def _check_entity_revision(self):
        revision=self.store.meta('_entity_revision',0)
        require(type(revision) is int and 0<=revision<=MAX_INT,'Entity revision limit exceeded',413)

    def _touch(self):
        current=self.store.meta('access_revision',0);require(type(current) is int and 0<=current<MAX_INT,'Access revision limit exceeded',413)
        self.store.set_meta('access_revision',current+1)
        from .content_index import ContentIndex
        ContentIndex(self.store).touch()

    def _verify_restore_bytes(self,record_id,target_storage):
        if target_storage=='blob':
            for identity,raw in self.store.db.execute("SELECT id,data FROM retention_entities WHERE record_id=? AND kind='attachment'",(record_id,)):
                value=json.loads(raw)
                if value.get('storage')!='chunks':continue
                digest=hashlib.sha256();position=0
                for offset,length in self.store.db.execute('SELECT offset,length(data) FROM attachment_chunks WHERE attachment_id=? ORDER BY offset',(identity,)):
                    require(offset==position and 0<length<=4194304,'Portable attachment bytes are incomplete',409)
                    for start in range(0,length,65536):
                        piece=self.store.db.execute('SELECT substr(data,?,?) FROM attachment_chunks WHERE attachment_id=? AND offset=?',(start+1,min(65536,length-start),identity,offset)).fetchone()[0]
                        require(isinstance(piece,bytes) and len(piece)==min(65536,length-start),'Portable attachment bytes are incomplete',409);digest.update(piece)
                    position+=length
                require(position==value.get('size') and digest.hexdigest()==value.get('sha256'),'Portable attachment checksum differs',409)
            return
        for attachment,storage,physical,offset,size,checksum in self.store.db.execute('SELECT attachment_id,storage_kind,physical_id,offset,size,sha256 FROM retention_attachment_refs WHERE record_id=?',(record_id,)):
            require(storage!='cloud','MIGRATION_REQUIRED: cloud bytes require their native backend or a verified portable BLOB restore',503)
            digest=hashlib.sha256()
            for start in range(0,size,65536):
                piece=self.store.chunk_read_range(attachment,offset,start,min(65536,size-start));require(piece is not None and len(piece)==min(65536,size-start),'Retained attachment bytes are missing',409);digest.update(piece)
            require(digest.hexdigest()==checksum,'Retained attachment checksum differs',409)

    def restore_to_trash(self,record_id,expected_record_revision=1,*,target_storage='native'):
        require(isinstance(record_id,str) and HEX.fullmatch(record_id),'Invalid retention record identity');require(type(expected_record_revision) is int and 1<=expected_record_revision<=MAX_INT,'Invalid record revision')
        require(target_storage in ('native','blob'),'Invalid retention storage target')
        self.initialize()
        if self.postgres:
            with self.store.transaction():
                current=self.store._execute('SELECT data FROM fountain_private.retention_records WHERE workspace_id=%s AND id=%s',(self.store.workspace_id,record_id),fetch='one')
                require(current is not None,'Retained record not found',404)
                metadata=json.loads(current[0]) if isinstance(current[0],str) else current[0]
                require(metadata.get('record_revision')==expected_record_revision,'Retained record changed',409)
                if target_storage=='native' and self.store._files is not None:
                    for attachment,offset,size,checksum in self.store._execute('SELECT attachment_id,"offset",size,sha256 FROM fountain_private.retention_attachment_refs WHERE workspace_id=%s AND record_id=%s AND storage_kind=\'file\' ORDER BY attachment_id,"offset"',(self.store.workspace_id,record_id),fetch='all'):
                        require(type(size) is int and 0<size<=4194304,'Invalid retained file length',409)
                        content=self.store._files.read_range(attachment,offset,0,size)
                        require(content is not None and len(content)==size,'Retained file bytes are missing',409)
                        require(hashlib.sha256(content).hexdigest()==checksum,'Retained file checksum differs',409)
                        self.store._execute('SELECT fountain_cloud.retention_stage_blob(%s,%s,%s,%s,%s)',(self.store.workspace_id,record_id,attachment,offset,content),fetch='one')
                return self.store._execute('SELECT fountain_cloud.retention_restore_to_trash(%s,%s,%s,%s)',(self.store.workspace_id,record_id,expected_record_revision,target_storage),fetch='one')[0]
        with self.store.transaction(),self._transition():
            record=self.store.db.execute('SELECT data FROM retention_records WHERE id=?',(record_id,)).fetchone();require(record is not None,'Retained record not found',404)
            metadata=json.loads(record[0]);require(metadata['record_revision']==expected_record_revision,'Retained record changed',409)
            self._check_entity_revision()
            self._verify_restore_bytes(record_id,target_storage)
            # Check every conflict before any live restoration.
            for kind,identity,raw,created,updated,generation,ownership in self.store.db.execute('SELECT kind,id,data,created_at,updated_at,generation,ownership FROM retention_entities WHERE record_id=?',(record_id,)):
                live=self.store.db.execute('SELECT data,created_at,updated_at FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone()
                require(live is None or kind in SHARED and _same_attachment_source(kind,live,(raw,created,updated)),'Retained identity conflicts with live content',409)
            for kind,identity,data in self.store.db.execute('SELECT kind,id,data FROM retention_links WHERE record_id=?',(record_id,)):
                link=json.loads(data);live=self.store.get(kind,identity);prov=self.store.db.execute('SELECT generation FROM content_provenance WHERE kind=? AND id=?',(kind,identity)).fetchone()
                require(live is not None and prov is not None and prov[0]==link['generation'] and live.get('depends_on',[])==link['after'],'Task dependencies changed after retention',409)
            restored=0
            for kind,identity,raw,created,updated in self.store.db.execute('SELECT kind,id,data,created_at,updated_at FROM retention_entities WHERE record_id=? ORDER BY CASE kind WHEN \'page\' THEN 0 WHEN \'database\' THEN 1 ELSE 2 END,id',(record_id,)):
                if target_storage=='blob' and kind in ('attachment_cloud','attachment_chunk'):continue
                if self.store.db.execute('SELECT 1 FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone():continue
                if target_storage=='blob' and kind=='attachment':
                    value=json.loads(raw)
                    if value.get('storage')=='chunks' and ('cloud_chunks' in value or 'storage_id' in value):value.pop('cloud_chunks',None);value.pop('storage_id',None);raw=_encode(value)
                if kind in ('site','form','automation'):
                    value=json.loads(raw);value['enabled' if kind=='automation' else 'published']=False;raw=_encode(value)
                self.store.db.execute('INSERT INTO entities VALUES(?,?,?,?,?)',(kind,identity,raw,created,updated));restored+=1
            columns=','.join(PROVENANCE_COLUMNS)
            self.store.db.execute('INSERT INTO content_provenance('+columns+') SELECT '+columns+' FROM retention_provenance WHERE record_id=?',(record_id,))
            from .content_index import ContentIndex
            index=ContentIndex(self.store)
            for kind,identity in self.store.db.execute("SELECT kind,id FROM retention_entities WHERE record_id=? AND kind IN ('page','database','row') ORDER BY CASE kind WHEN 'page' THEN 0 WHEN 'database' THEN 1 ELSE 2 END,id",(record_id,)):
                index.refresh(kind,identity,backfill=True)
            for kind,identity,data in self.store.db.execute('SELECT kind,id,data FROM retention_links WHERE record_id=?',(record_id,)):
                link=json.loads(data);row=self.store.get(kind,identity);row['depends_on']=link['before'];self.store.put(kind,row)
            for table in VAULT_COLUMNS:
                self.store.db.execute('DELETE FROM '+table+' WHERE '+('id' if table=='retention_records' else 'record_id')+'=?',(record_id,))
            from .content_index import trusted_actor
            self.store._advance_revision();self._touch();self.store.put('audit',{'action':'content.retention.restored','details':{'record_id':record_id,'root_id':metadata['root_id'],'entities':restored},'user':trusted_actor(self.store)})
            self._check_entity_revision()
            return {'id':record_id,**metadata,'restored':restored}
