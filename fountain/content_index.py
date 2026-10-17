"""Private derivative content index and trusted provenance, independent of entity revisions."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import secrets
from .core import APIError, CURRENT_ACCESS, AUDIT_ACTOR, CONTENT_ORIGIN
from .search import _display, _fold, _id, _scalar, TEXT_BLOCKS

KINDS = ('page', 'database', 'row')
INVALIDATES = frozenset((*KINDS, 'member', 'group', 'teamspace', 'site', 'form', 'settings', 'admin_role', 'admin_assignment'))
HEADER_KEYS = ('id','owner_id','parent_id','teamspace_id','permissions','archived','deleted','deleted_at','locked','revision')
CHUNK_SIZE, CHUNK_OVERLAP = 4096, 512


INDEX_DEFINITIONS = {'content_search_documents': 'CREATE TABLE content_search_documents (kind TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,title TEXT NOT NULL,title_fold TEXT NOT NULL,\n            id_fold TEXT NOT NULL,icon TEXT,header TEXT NOT NULL,created_at TEXT,updated_at TEXT,text_revision TEXT NOT NULL,\n            validity INTEGER NOT NULL,error TEXT,PRIMARY KEY(kind,id))', 'content_search_chunks': 'CREATE TABLE content_search_chunks (kind TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,text_value TEXT NOT NULL,folded_value TEXT NOT NULL,\n            PRIMARY KEY(kind,id,ordinal),FOREIGN KEY(kind,id) REFERENCES content_search_documents(kind,id) ON DELETE CASCADE)', 'content_provenance': 'CREATE TABLE content_provenance (kind TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,creator_id TEXT,creator_cause TEXT,\n            editor_id TEXT,edited_at TEXT,editor_cause TEXT,manager_id TEXT,manager_at TEXT,PRIMARY KEY(kind,id))', 'content_search_state': 'CREATE TABLE content_search_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),index_version INTEGER NOT NULL,content_revision INTEGER NOT NULL,\n            ready INTEGER NOT NULL,cursor_secret TEXT NOT NULL)'}



def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def header(kind, value, database=None):
    result = {key: copy.deepcopy(value[key]) for key in HEADER_KEYS if key in value}
    if kind == 'database':
        if 'row_permissions' in value: result['row_permissions'] = copy.deepcopy(value['row_permissions'])
        result['properties'] = [{key: copy.deepcopy(prop[key]) for key in ('id','type') if key in prop}
                                    if isinstance(prop,dict) else None for prop in value['properties']] if isinstance(value.get('properties'),list) else None
    if kind == 'row':
        if 'database_id' in value: result['database_id'] = copy.deepcopy(value['database_id'])
        policy = database.get('row_permissions') if isinstance(database,dict) else None
        key = policy.get('property_id') if isinstance(policy,dict) and policy.get('mode') == 'assigned' else None
        props = value.get('properties')
        assignment=props.get(key) if isinstance(props,dict) and isinstance(key,str) else None
        result['assignment_values']=[assignment] if isinstance(assignment,str) else [v for v in assignment if isinstance(v,str)] if isinstance(assignment,list) else []
    return result


def extract(kind, value, database=None):
    title, parts = '', []
    if kind == 'page':
        title = value.get('title')
        blocks = value.get('blocks', [])
        if isinstance(blocks,list):
            parts = [block.get('text','') for block in blocks if isinstance(block,dict)
                     and isinstance(block.get('type','paragraph'),str) and block.get('type','paragraph') in TEXT_BLOCKS and not block.get('attachment_id')
                     and isinstance(block.get('text',''),str) and _valid_text(block.get('text',''))]
    elif kind == 'database':
        title = value.get('name') if isinstance(value.get('name'),str) else value.get('title')
        if isinstance(value.get('description'),str) and _valid_text(value['description']): parts = [value['description']]
    elif isinstance(database,dict):
        schema, props = database.get('properties'), value.get('properties')
        if isinstance(schema,list) and isinstance(props,dict):
            for prop in schema:
                if not isinstance(prop,dict) or not isinstance(prop.get('id'),str): continue
                kind_ = prop.get('type')
                if kind_ == 'title' and title == '': title = props.get(prop['id'])
                if kind_ in ('owner','verification','formula','rollup','relation','files','created_time','last_edited_time','person'): continue
                scalar = _scalar(kind_,props.get(prop['id']))
                if scalar: parts.append(scalar)
    title = title if isinstance(title,str) and _valid_text(title) else ''
    return title, _display(' '.join(parts))


def _valid_text(value):
    return '\0' not in value and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)


def trusted_actor(store):
    if CONTENT_ORIGIN.get() not in ('human','automation','import','public_form'): return None
    access = CURRENT_ACCESS.get()
    if access is None or not access.active or access.principal.get('_service') or AUDIT_ACTOR.get() != access.member_id:
        return None
    member = store.get('member',access.member_id)
    if not isinstance(member,dict) or member.get('active',True) is not True or member.get('role') != access.principal.get('role'):
        return None
    return member['id']


class ContentIndex:
    """SQLite owns derivative writes; PostgreSQL uses provisioning-owned triggers."""
    def __init__(self,store): self.store = store
    @property
    def postgres(self): return getattr(self.store,'backend',None) == 'postgres'

    def initialize(self):
        if self.postgres: return
        self.store.db.executescript(';'.join(sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ', 1) for sql in INDEX_DEFINITIONS.values())+';')
        if self.store.db.execute('SELECT 1 FROM content_search_state').fetchone() is None:
            self.store.db.execute('INSERT INTO content_search_state VALUES(1,1,0,0,?)',(secrets.token_hex(32),))
            for kind in KINDS:
                for value in self.store.list(kind): self.refresh(kind,value['id'],backfill=True)
            self.store.db.execute('UPDATE content_search_state SET ready=1')
        self.store.db.commit()

    def state(self):
        if self.postgres:
            row = self.store._execute("SELECT index_version,content_revision,ready,cursor_secret FROM fountain_private.content_search_state WHERE workspace_id=%s",(self.store.workspace_id,),fetch='one')
        else: row = self.store.db.execute('SELECT index_version,content_revision,ready,cursor_secret FROM content_search_state WHERE singleton=1').fetchone()
        if row is None or row[0] != 1 or row[2] not in (True,1) or type(row[1]) is not int or not 0<=row[1]<=9007199254740991 or not isinstance(row[3],str) or re.fullmatch(r'[a-f0-9]{64}',row[3]) is None: raise APIError(503,'Content index is not ready')
        return {'version':row[0],'revision':row[1],'secret':row[3]}

    def touch(self):
        if not self.postgres:
            cursor=self.store.db.execute('UPDATE content_search_state SET content_revision=content_revision+1 WHERE singleton=1 AND content_revision<9007199254740991')
            if cursor.rowcount!=1:raise APIError(413,'Content revision limit exceeded')

    def refresh(self,kind,identity,*,backfill=False,reproject=False,source_previous=None):
        if self.postgres: return
        value = self.store.get(kind,identity)
        if value is None:
            self.store.db.execute('DELETE FROM content_search_documents WHERE kind=? AND id=?',(kind,identity))
            self.store.db.execute('DELETE FROM content_provenance WHERE kind=? AND id=?',(kind,identity))
            return
        previous = self.store.db.execute('SELECT generation,text_revision FROM content_search_documents WHERE kind=? AND id=?',(kind,identity)).fetchone()
        database = self.store.get('database',value.get('database_id')) if kind == 'row' and isinstance(value.get('database_id'),str) else None
        title, body = extract(kind,value,database)
        digest=hashlib.sha256(json.dumps([title],ensure_ascii=False).encode()).hexdigest()
        for start in range(0,len(body),CHUNK_SIZE-CHUNK_OVERLAP):
            digest=hashlib.sha256((digest+body[start:start+CHUNK_SIZE]).encode()).hexdigest()
        digest=hashlib.sha256((digest+':'+str(len(body))).encode()).hexdigest()
        retained = self.store.db.execute('SELECT generation FROM content_provenance WHERE kind=? AND id=?',(kind,identity)).fetchone() if backfill and previous is None else None
        if retained is not None and (not isinstance(retained[0],str) or re.fullmatch(r'[a-f0-9]{32}',retained[0]) is None):
            raise APIError(503,'Content history is invalid')
        generation = previous[0] if previous else retained[0] if retained else secrets.token_hex(16)
        valid,error=True,None
        if kind=='page' and 'blocks' in value and not isinstance(value['blocks'],list):valid,error=False,'malformed_blocks'
        schema=value.get('properties') if kind=='database' else database.get('properties') if isinstance(database,dict) else None
        if kind in ('database','row'):
            if not isinstance(schema,list) or any(not isinstance(p,dict) or not _id(p.get('id')) or not isinstance(p.get('type'),str) for p in schema) or len({p['id'] for p in schema})!=len(schema):valid,error=False,'malformed_schema'
            if kind=='row' and not isinstance(value.get('properties'),dict):valid,error=False,'malformed_row_values'
            if kind=='row' and database is None:valid,error=False,'missing_database'
        fields = (kind,identity,generation,title,_fold(title),_fold(identity),value.get('icon') if isinstance(value.get('icon'),str) else None,
                  canonical(header(kind,value,database)),value.get('created_at'),value.get('updated_at'),digest,int(valid),error)
        self.store.db.execute('INSERT INTO content_search_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET title=excluded.title,title_fold=excluded.title_fold,id_fold=excluded.id_fold,icon=excluded.icon,header=excluded.header,created_at=excluded.created_at,updated_at=excluded.updated_at,text_revision=excluded.text_revision,validity=excluded.validity,error=excluded.error',fields)
        if previous is None or previous[1] != digest:
            self.store.db.execute('DELETE FROM content_search_chunks WHERE kind=? AND id=?',(kind,identity))
            for ordinal,start in enumerate(range(0,len(body),CHUNK_SIZE-CHUNK_OVERLAP)):
                chunk = body[start:start+CHUNK_SIZE]
                self.store.db.execute('INSERT INTO content_search_chunks VALUES(?,?,?,?,?)',(kind,identity,ordinal,chunk,chunk.casefold()))
        actor = None if backfill or reproject else trusted_actor(self.store)
        cause=CONTENT_ORIGIN.get() if actor is not None else 'unknown'
        raw_keys=('title','blocks') if kind=='page' else ('name','title','description','properties') if kind=='database' else ('properties','database_id')
        absent=object()
        raw_changed=isinstance(source_previous,dict) and any(source_previous.get(key,absent)!=value.get(key,absent) for key in (*raw_keys,'icon','parent_id','teamspace_id'))
        if previous is None and retained is None:
            self.store.db.execute('DELETE FROM content_provenance WHERE kind=? AND id=?',(kind,identity))
            self.store.db.execute('INSERT INTO content_provenance VALUES(?,?,?,?,?,?,?,?,?,?)',(kind,identity,generation,actor,cause,actor,value.get('updated_at') if actor else None,cause,None,None))
        elif previous is not None and not backfill and not reproject:
            if previous[1] != digest or raw_changed:
                self.store.db.execute('UPDATE content_provenance SET editor_id=?,edited_at=?,editor_cause=? WHERE kind=? AND id=?',(actor,value.get('updated_at') if actor else None,cause,kind,identity))
            else:
                self.store.db.execute('UPDATE content_provenance SET manager_id=?,manager_at=? WHERE kind=? AND id=?',(actor,value.get('updated_at') if actor else None,kind,identity))

    def manage_target(self,kind,identity):
        if self.postgres or kind not in ('page','database') or not isinstance(identity,str):return
        from .core import now
        actor=trusted_actor(self.store)
        cursor=self.store.db.execute('UPDATE content_provenance SET manager_id=?,manager_at=? WHERE kind=? AND id=?',
                                     (actor,now() if actor is not None else None,kind,identity))
        if cursor.rowcount:self.touch()

    def changed(self,kind,identity,previous=None):
        if self.postgres or kind not in INVALIDATES: return
        if kind in KINDS: self.refresh(kind,identity,source_previous=previous)
        if kind in ('site','form'):
            field,target_kind=('page_id','page') if kind=='site' else ('database_id','database')
            current=self.store.get(kind,identity)
            old_id=previous.get(field) if isinstance(previous,dict) else None
            new_id=current.get(field) if isinstance(current,dict) else None
            if old_id is not None and old_id!=new_id:self.manage_target(target_kind,old_id)
            if current is not None:self.manage_target(target_kind,new_id)
        if kind == 'database':
            def projection(database):
                if not isinstance(database,dict):return None
                policy=database.get('row_permissions');field=policy.get('property_id') if isinstance(policy,dict) else None
                schema=database.get('properties')
                return [policy,[{key:prop.get(key) for key in ('id','type')} for prop in schema
                    if isinstance(prop,dict) and (prop.get('type') not in ('owner','verification','formula','rollup','relation','files','created_time','last_edited_time','person') or prop.get('id')==field)]] if isinstance(schema,list) else [policy,None]
            if previous is None or projection(previous)!=projection(self.store.get('database',identity)):
                # Read one matching row at a time, never load the whole corpus.
                ids=self.store.db.execute("SELECT id FROM entities WHERE kind='row' AND json_extract(data,'$.database_id')=?",(identity,))
                for row_id, in ids:self.refresh('row',row_id,reproject=True)
        self.touch()

    def documents(self):
        columns = 'd.kind,d.id,d.generation,d.title,d.title_fold,d.id_fold,d.icon,d.header,d.created_at,d.updated_at,d.text_revision,d.validity,d.error,p.creator_id,p.creator_cause,p.editor_id,p.edited_at,p.editor_cause'
        names = ('kind','id','generation','title','title_fold','id_fold','icon','header','created_at','updated_at','text_revision','validity','error','creator_id','creator_cause','editor_id','edited_at','editor_cause')
        if self.postgres:
            rows = self.store._execute('SELECT '+columns+' FROM fountain_private.content_search_documents d LEFT JOIN fountain_private.content_provenance p USING(workspace_id,kind,id) WHERE d.workspace_id=%s',(self.store.workspace_id,),fetch='all')
        else: rows = self.store.db.execute('SELECT '+columns+' FROM content_search_documents d LEFT JOIN content_provenance p USING(kind,id)').fetchall()
        result=[]
        for row in rows:
            doc=dict(zip(names,row));doc['header']=json.loads(doc['header']) if isinstance(doc['header'],str) else copy.deepcopy(doc['header']);result.append(doc)
        return result

    def chunks(self,kind,identity):
        if self.postgres:
            try:
                with self.store._connection.cursor(name='fountain_content_'+secrets.token_hex(8)) as cursor:
                    cursor.execute('SELECT text_value,folded_value FROM fountain_private.content_search_chunks WHERE workspace_id=%s AND kind=%s AND id=%s ORDER BY ordinal',(self.store.workspace_id,kind,identity))
                    while batch := cursor.fetchmany(64):
                        yield from batch
            except self.store._driver.Error:
                raise APIError(503,'Content index could not be read') from None
        else:
            yield from self.store.db.execute('SELECT text_value,folded_value FROM content_search_chunks WHERE kind=? AND id=? ORDER BY ordinal',(kind,identity))


class IndexHeaderReader:
    """Detached header-only Access oracle; never reads cloud document bodies."""
    def __init__(self,store,documents):
        self.store=store
        self.by_kind={kind:{} for kind in KINDS}
        databases={d['id']:d['header'] for d in documents if d['kind']=='database'}
        for doc in documents:
            value=copy.deepcopy(doc['header'])
            if doc['kind']=='row':
                db=databases.get(value.get('database_id'))
                policy=db.get('row_permissions') if isinstance(db,dict) else None
                key=policy.get('property_id') if isinstance(policy,dict) else None
                value['properties']={key:copy.deepcopy(value['assignment_values'])} if isinstance(key,str) and 'assignment_values' in value else {}
            self.by_kind[doc['kind']][doc['id']]=value
    def get(self,kind,identity):
        if kind in self.by_kind:return copy.deepcopy(self.by_kind[kind].get(identity)) if isinstance(identity,str) else None
        return self.store.get(kind,identity)
    def list(self,kind):
        return copy.deepcopy(list(self.by_kind[kind].values())) if kind in self.by_kind else self.store.list(kind)
    def meta(self,key,default=None):return self.store.meta(key,default)
