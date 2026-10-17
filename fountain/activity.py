"""Private canonical activity facts; entity digests are not held source snapshots."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from decimal import Decimal
from contextlib import contextmanager
from datetime import datetime, timezone

from .core import APIError, CONTENT_ORIGIN, CURRENT_ACCESS, require
from .canonical import canonical_source

MAX_INT=9007199254740991
KINDS=('page','database','row')
AUTHORED={'page':('title','blocks','icon','cover'),'database':('name','title','description','properties','icon','cover'),'row':('properties','icon','cover')}
IGNORED={'id','created_at','updated_at','revision'}
ACTIVITY_COLUMNS={
 'activity_ledgers':('id','started_at','origin','capture_scope'),
 'activity_memberships':('id','ledger_id','member_id','opened_at','closed_at','close_reason'),
 'activity_accounts':('id','membership_id','auth_kind','opened_at','closed_at','close_reason'),
 'activity_events':('ledger_id','sequence','event_id','command_id','command_ordinal','actor_member_id','membership_id','account_id','origin','action','resource_kind','resource_id','resource_generation','occurred_at','source_encoding','source_bytes','source_sha256'),
}
ACTIVITY_RUNTIME_COLUMNS={'activity_runtime':('singleton','ledger_id','next_sequence','activity_revision'),'activity_current_members':('member_id','membership_id'),'activity_current_accounts':('member_id','auth_kind','account_id')}
ACTIVITY_DEFINITIONS={
 'activity_ledgers':'CREATE TABLE activity_ledgers (id TEXT NOT NULL PRIMARY KEY,started_at TEXT NOT NULL,origin TEXT NOT NULL,capture_scope TEXT NOT NULL)',
 'activity_memberships':'CREATE TABLE activity_memberships (id TEXT NOT NULL PRIMARY KEY,ledger_id TEXT NOT NULL,member_id TEXT NOT NULL,opened_at TEXT NOT NULL,closed_at TEXT,close_reason TEXT,FOREIGN KEY(ledger_id) REFERENCES activity_ledgers(id))',
 'activity_accounts':'CREATE TABLE activity_accounts (id TEXT NOT NULL PRIMARY KEY,membership_id TEXT NOT NULL,auth_kind TEXT NOT NULL,opened_at TEXT NOT NULL,closed_at TEXT,close_reason TEXT,FOREIGN KEY(membership_id) REFERENCES activity_memberships(id))',
 'activity_events':'CREATE TABLE activity_events (ledger_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,command_id TEXT NOT NULL,command_ordinal INTEGER NOT NULL,actor_member_id TEXT,membership_id TEXT,account_id TEXT,origin TEXT NOT NULL,action TEXT NOT NULL,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,resource_generation TEXT NOT NULL,occurred_at TEXT NOT NULL,source_encoding TEXT NOT NULL,source_bytes INTEGER NOT NULL,source_sha256 TEXT NOT NULL,PRIMARY KEY(ledger_id,sequence),UNIQUE(event_id),UNIQUE(ledger_id,command_id,command_ordinal),FOREIGN KEY(ledger_id) REFERENCES activity_ledgers(id),FOREIGN KEY(membership_id) REFERENCES activity_memberships(id),FOREIGN KEY(account_id) REFERENCES activity_accounts(id))',
}
ACTIVITY_RUNTIME_DEFINITIONS={
 'activity_runtime':'CREATE TABLE activity_runtime (singleton INTEGER PRIMARY KEY CHECK(singleton=1),ledger_id TEXT NOT NULL,next_sequence INTEGER NOT NULL,activity_revision INTEGER NOT NULL,FOREIGN KEY(ledger_id) REFERENCES activity_ledgers(id))',
 'activity_current_members':'CREATE TABLE activity_current_members (member_id TEXT NOT NULL PRIMARY KEY,membership_id TEXT NOT NULL,FOREIGN KEY(membership_id) REFERENCES activity_memberships(id))',
 'activity_current_accounts':'CREATE TABLE activity_current_accounts (member_id TEXT NOT NULL,auth_kind TEXT NOT NULL,account_id TEXT NOT NULL,PRIMARY KEY(member_id,auth_kind),FOREIGN KEY(account_id) REFERENCES activity_accounts(id))',
}
RUNTIME_DEFINITIONS=ACTIVITY_RUNTIME_DEFINITIONS
ACTIVITY_TRIGGER_DEFINITIONS={}
for _table in (*ACTIVITY_COLUMNS,*ACTIVITY_RUNTIME_COLUMNS):
 for _operation in ('INSERT','UPDATE','DELETE'):
  _name='fountain_'+_table+'_'+_operation.lower()
  _when='fountain_activity_transition()=0'
  if _table in ('activity_events','activity_ledgers') and _operation!='INSERT':_when='1'
  if _table in ('activity_memberships','activity_accounts'):
   if _operation=='DELETE':_when='1'
   elif _operation=='UPDATE':
    _columns=ACTIVITY_COLUMNS[_table]
    _same=' AND '.join('NEW.'+c+' IS OLD.'+c for c in _columns if c not in ('closed_at','close_reason'))
    _when+=' OR NOT(OLD.closed_at IS NULL AND OLD.close_reason IS NULL AND NEW.closed_at IS NOT NULL AND NEW.close_reason IS NOT NULL AND '+_same+')'
  ACTIVITY_TRIGGER_DEFINITIONS[_name]=f"CREATE TRIGGER {_name} BEFORE {_operation} ON {_table} WHEN {_when} BEGIN SELECT RAISE(ABORT,'Private activity mutation rejected'); END"
HEX32=re.compile(r'^[a-f0-9]{32}$');HEX64=re.compile(r'^[a-f0-9]{64}$')
DATE=re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$')


def activity_id():return uuid.uuid4().hex

def _id(value):return isinstance(value,str) and 0<len(value)<=160 and bool(value.strip()) and '\0' not in value and not any(0xD800<=ord(c)<=0xDFFF for c in value)
def _uuid(value):return isinstance(value,str) and HEX32.fullmatch(value) is not None
def _safe(value,minimum=0):return type(value) is int and minimum<=value<=MAX_INT
def _time(value):
 if not isinstance(value,str) or not DATE.fullmatch(value):return None
 try:return datetime.fromisoformat(value.replace('Z','+00:00'))
 except ValueError:return None
def _now():return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
def _active(value):return isinstance(value,dict) and value.get('active',True) is True and value.get('role') in ('owner','admin','member','guest')
def _same(left,right):
 if type(left) is not type(right):return False
 if isinstance(left,dict):return left.keys()==right.keys() and all(_same(left[key],right[key]) for key in left)
 if isinstance(left,list):return len(left)==len(right) and all(_same(a,b) for a,b in zip(left,right))
 return left==right


def inspect_portable_activity(connection, *, allow_unactivated=False):
 """Read-only trust validator; portable history does not imply live authority."""
 tables={row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
 present=set(ACTIVITY_COLUMNS)&tables
 runtime=set(ACTIVITY_RUNTIME_COLUMNS)&tables
 require(not present or present==set(ACTIVITY_COLUMNS),'Incomplete activity schema',400)
 require(not runtime or runtime==set(ACTIVITY_RUNTIME_COLUMNS),'Incomplete activity runtime schema',400)
 require(not runtime or present==set(ACTIVITY_COLUMNS),'Activity runtime has no portable ledger schema',400)
 if not present:return {name:0 for name in ACTIVITY_COLUMNS}
 for table,columns in {**ACTIVITY_COLUMNS,**(ACTIVITY_RUNTIME_COLUMNS if runtime else {})}.items():
  require(tuple(row[1] for row in connection.execute('PRAGMA table_info('+table+')'))==columns,'Invalid activity columns',400)
  expected={**ACTIVITY_DEFINITIONS,**ACTIVITY_RUNTIME_DEFINITIONS}[table]
  actual=connection.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",(table,)).fetchone()[0]
  require(' '.join(actual.split())==' '.join(expected.split()),'Invalid activity schema',400)
 counts={name:connection.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in ACTIVITY_COLUMNS}
 ledgers={};members={};accounts={}
 for identity,started,origin,scope in connection.execute('SELECT * FROM activity_ledgers'):
  require(_uuid(identity) and _time(started) and origin in ('installation','restore') and scope=='canonical-server-v1','Invalid activity ledger',400);ledgers[identity]=started
 for identity,ledger,member,opened,closed,reason in connection.execute('SELECT * FROM activity_memberships'):
  require(_uuid(identity) and ledger in ledgers and _id(member) and _time(opened) and _time(opened)>=_time(ledgers[ledger]),'Invalid activity membership',400)
  require((closed is None and reason is None) or _time(closed) and _time(closed)>=_time(opened) and reason in ('inactive','deleted','restore'),'Invalid membership closure',400)
  members[identity]=(ledger,member,opened,closed)
 for identity,membership,kind,opened,closed,reason in connection.execute('SELECT * FROM activity_accounts'):
  require(_uuid(identity) and membership in members and kind in ('password','supabase') and _time(opened) and _time(opened)>=_time(members[membership][2]),'Invalid activity account',400)
  require((closed is None and reason is None) or _time(closed) and _time(closed)>=_time(opened) and reason in ('credential_removed','identity_changed','membership_closed','restore'),'Invalid account closure',400)
  require(members[membership][3] is None or closed is not None and _time(closed)<=_time(members[membership][3]),'Account exceeds membership episode',400)
  accounts[identity]=(membership,kind,opened,closed)
 previous={};events=set();commands=set()
 for row in connection.execute('SELECT * FROM activity_events ORDER BY ledger_id,sequence'):
  e=dict(zip(ACTIVITY_COLUMNS['activity_events'],row));ledger=e['ledger_id'];sequence=e['sequence'];member=e['actor_member_id'];membership=e['membership_id'];account=e['account_id'];occurred=e['occurred_at']
  require(ledger in ledgers and _safe(sequence,1) and sequence==previous.get(ledger,0)+1,'Invalid activity sequence',400);previous[ledger]=sequence
  require(_uuid(e['event_id']) and e['event_id'] not in events and _uuid(e['command_id']) and _safe(e['command_ordinal']) and (ledger,e['command_id'],e['command_ordinal']) not in commands,'Invalid activity identity',400);events.add(e['event_id']);commands.add((ledger,e['command_id'],e['command_ordinal']))
  require(e['origin'] in ('human','automation','import','public_form','system','unknown') and e['action'] in ('created','edited','viewed','managed','deleted') and e['resource_kind'] in KINDS and _id(e['resource_id']) and _uuid(e['resource_generation']),'Invalid activity event',400)
  require(_time(occurred) and _time(occurred)>=_time(ledgers[ledger]) and e['source_encoding']=='fountain-cjson-v1' and _safe(e['source_bytes']) and isinstance(e['source_sha256'],str) and HEX64.fullmatch(e['source_sha256']),'Invalid activity source',400)
  require((member is None and membership is None and account is None) or _id(member) and membership in members and members[membership][:2]==(ledger,member),'Invalid activity actor',400)
  if membership is not None:
   episode=members[membership];require(_time(occurred)>=_time(episode[2]) and (episode[3] is None or _time(occurred)<=_time(episode[3])),'Event outside membership episode',400)
  if account is not None:
   require(account in accounts and accounts[account][0]==membership,'Invalid activity actor account',400);episode=accounts[account];require(_time(occurred)>=_time(episode[2]) and (episode[3] is None or _time(occurred)<=_time(episode[3])),'Event outside account episode',400)
 if runtime:
  rows=connection.execute('SELECT * FROM activity_runtime').fetchall();require(len(rows)<=1,'Invalid activity runtime',400)
  if rows:
   singleton,ledger,sequence,revision=rows[0];require(singleton==1 and ledger in ledgers and _safe(sequence,1) and sequence==previous.get(ledger,0)+1 and _safe(revision,1),'Invalid activity runtime',400)
   current_members={}
   for member,membership in connection.execute('SELECT * FROM activity_current_members'):
    require(_id(member) and membership in members and members[membership][:2]==(ledger,member) and members[membership][3] is None,'Invalid current membership',400);current_members[member]=membership
   require({v for v in current_members.values()}=={identity for identity,episode in members.items() if episode[3] is None},'Unbound activity membership',400)
   current_accounts=set()
   for member,kind,account in connection.execute('SELECT * FROM activity_current_accounts'):
    require(member in current_members and account in accounts and accounts[account][:2]==(current_members[member],kind) and accounts[account][3] is None,'Invalid current account',400);current_accounts.add(account)
   require(current_accounts=={identity for identity,episode in accounts.items() if episode[3] is None},'Unbound activity account',400)
  else:require((allow_unactivated or not any(counts.values())) and not connection.execute('SELECT 1 FROM activity_current_members').fetchone() and not connection.execute('SELECT 1 FROM activity_current_accounts').fetchone(),'Activity runtime requires trusted restore activation',400)
 return counts


class ActivityLedger:
 def __init__(self,store):self.store=store
 @property
 def postgres(self):return getattr(self.store,'backend',None)=='postgres'
 def initialize(self):
  if self.postgres:return
  with self.store.lock:
   names={row[0] for row in self.store.db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
   portable=names&set(ACTIVITY_COLUMNS);runtime=names&set(ACTIVITY_RUNTIME_COLUMNS)
   require(not portable or portable==set(ACTIVITY_COLUMNS),'Activity schema is incomplete',503)
   require(not runtime or runtime==set(ACTIVITY_RUNTIME_COLUMNS),'Activity runtime schema is incomplete',503)
   require(not runtime or portable==set(ACTIVITY_COLUMNS),'Activity runtime has no portable ledger schema',503)
   for table in portable|runtime:
    actual=self.store.db.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",(table,)).fetchone()[0]
    require(' '.join(actual.split())==' '.join(({**ACTIVITY_DEFINITIONS,**ACTIVITY_RUNTIME_DEFINITIONS}[table]).split()),'Activity schema is invalid',503)
   for name,expected in ACTIVITY_TRIGGER_DEFINITIONS.items():
    actual=self.store.db.execute("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",(name,)).fetchone()
    require(actual is None or ' '.join(actual[0].split())==' '.join(expected.split()),'Activity mutation guard is invalid',503)
   if not hasattr(self.store,'_activity_transition_depth'):
    self.store._activity_transition_depth=0
    self.store.db.create_function('fountain_activity_transition',0,lambda:int(self.store._activity_transition_depth>0))
   for ddl in {**ACTIVITY_DEFINITIONS,**ACTIVITY_RUNTIME_DEFINITIONS}.values():self.store.db.execute(ddl.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ',1))
   for ddl in ACTIVITY_TRIGGER_DEFINITIONS.values():self.store.db.execute(ddl.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS ',1))
   self.store.commit()
 @contextmanager
 def _authority(self):
  self.store._activity_transition_depth+=1
  try:yield
  finally:self.store._activity_transition_depth-=1
 def _bump(self):
  require(self.store.db.execute('UPDATE activity_runtime SET activity_revision=activity_revision+1 WHERE singleton=1 AND activity_revision<?',(MAX_INT,)).rowcount==1,'Activity revision limit exceeded',413)
 def _runtime(self):
  if self.postgres:return self.store._execute('SELECT fountain_private.activity_initialize(%s)',(self.store.workspace_id,),fetch='one')[0]
  row=self.store.db.execute('SELECT ledger_id,next_sequence,activity_revision FROM activity_runtime WHERE singleton=1').fetchone()
  if row:
   require(_uuid(row[0]) and _safe(row[1],1) and _safe(row[2],1) and self.store.db.execute('SELECT 1 FROM activity_ledgers WHERE id=?',(row[0],)).fetchone(),'Activity runtime is corrupt',503)
   expected=self.store.db.execute('SELECT COALESCE(MAX(sequence),0)+1 FROM activity_events WHERE ledger_id=?',(row[0],)).fetchone()[0]
   require(row[1]==expected,'Activity sequence high-water is corrupt',503);return row[0]
  require(not any(self.store.db.execute('SELECT 1 FROM '+table+' LIMIT 1').fetchone() for table in ACTIVITY_COLUMNS),'Activity history requires explicit trusted restore activation',503)
  ledger=activity_id();stamp=_now()
  with self._authority():
   self.store.db.execute('INSERT INTO activity_ledgers VALUES(?,?,?,?)',(ledger,stamp,'installation','canonical-server-v1'))
   self.store.db.execute('INSERT INTO activity_runtime VALUES(1,?,1,1)',(ledger,))
   for member in self.store.list('member'):
    if _active(member):
     require(_id(member.get('id')),'Current activity member is invalid',503)
     self._membership(member['id'],stamp)
     if self.store.get('credential',member['id']) is not None:self._account(member['id'],'password',stamp)
  return ledger
 def fence(self):
  if self.postgres:
   with self.store.transaction():
    row=self.store._execute('SELECT ledger_id,next_sequence,activity_revision FROM fountain_private.activity_runtime WHERE workspace_id=%s',(self.store.workspace_id,),fetch='one')
  else:
   with self.store.lock:row=self.store.db.execute('SELECT ledger_id,next_sequence,activity_revision FROM activity_runtime WHERE singleton=1').fetchone()
  return {'ledger_id':row[0],'next_sequence':row[1],'activity_revision':row[2]} if row else {'ledger_id':None,'next_sequence':1,'activity_revision':0}
 def _membership(self,member,stamp):
  ledger=self._runtime();row=self.store.db.execute('SELECT membership_id FROM activity_current_members WHERE member_id=?',(member,)).fetchone()
  if row:
   valid=self.store.db.execute('SELECT 1 FROM activity_memberships WHERE id=? AND ledger_id=? AND member_id=? AND closed_at IS NULL',(row[0],ledger,member)).fetchone();require(valid,'Activity membership binding is corrupt',503);return row[0]
  identity=activity_id();self.store.db.execute('INSERT INTO activity_memberships VALUES(?,?,?,?,NULL,NULL)',(identity,ledger,member,stamp));self._bump();self.store.db.execute('INSERT INTO activity_current_members VALUES(?,?)',(member,identity));return identity
 def _account(self,member,kind,stamp):
  membership=self._membership(member,stamp);row=self.store.db.execute('SELECT account_id FROM activity_current_accounts WHERE member_id=? AND auth_kind=?',(member,kind)).fetchone()
  if row:
   require(self.store.db.execute('SELECT 1 FROM activity_accounts WHERE id=? AND membership_id=? AND auth_kind=? AND closed_at IS NULL',(row[0],membership,kind)).fetchone(),'Activity account binding is corrupt',503);return row[0]
  identity=activity_id();self.store.db.execute('INSERT INTO activity_accounts VALUES(?,?,?,?,NULL,NULL)',(identity,membership,kind,stamp));self._bump();self.store.db.execute('INSERT INTO activity_current_accounts VALUES(?,?,?)',(member,kind,identity));return identity
 def _close_account(self,member,kind,reason,stamp):
  row=self.store.db.execute('SELECT account_id FROM activity_current_accounts WHERE member_id=? AND auth_kind=?',(member,kind)).fetchone()
  if row:
   require(self.store.db.execute('UPDATE activity_accounts SET closed_at=?,close_reason=? WHERE id=? AND closed_at IS NULL',(stamp,reason,row[0])).rowcount==1,'Activity account closure is corrupt',503);self._bump();self.store.db.execute('DELETE FROM activity_current_accounts WHERE member_id=? AND auth_kind=?',(member,kind))
 def lifecycle(self,kind,identity,before,after):
  if kind not in ('member','credential') or getattr(self.store,'_retention_transition_depth',0):return
  if self.postgres:return # Provisioned lifecycle triggers observe actual private bindings.
  self._runtime();stamp=_now()
  with self._authority():
   if kind=='member':
    if _active(after):
     self._membership(identity,stamp)
     if self.store.get('credential',identity) is not None:self._account(identity,'password',stamp)
    else:
     row=self.store.db.execute('SELECT membership_id FROM activity_current_members WHERE member_id=?',(identity,)).fetchone()
     if row:
      for auth_kind, in self.store.db.execute('SELECT auth_kind FROM activity_current_accounts WHERE member_id=?',(identity,)).fetchall():self._close_account(identity,auth_kind,'membership_closed',stamp)
      self.store.db.execute('UPDATE activity_memberships SET closed_at=?,close_reason=? WHERE id=? AND closed_at IS NULL',(stamp,'deleted' if after is None else 'inactive',row[0]));self._bump();self.store.db.execute('DELETE FROM activity_current_members WHERE member_id=?',(identity,))
   elif after is None:self._close_account(identity,'password','credential_removed',stamp)
   elif _active(self.store.get('member',identity)):self._account(identity,'password',stamp)
 def actor(self):
  from .content_index import trusted_actor
  member=trusted_actor(self.store)
  if member is None:return None
  access=CURRENT_ACCESS.get();kind=getattr(access,'_activity_auth_kind','local')
  if CONTENT_ORIGIN.get() in ('automation','system','public_form'):kind='service'
  require(kind in ('local','password','supabase','service'),'Invalid trusted activity authentication',503)
  return {'member_id':member,'auth_kind':kind}
 def command(self):
  value=getattr(self.store,'_activity_command',None)
  if value is None:value={'id':activity_id(),'ordinal':0};self.store._activity_command=value
  ordinal=value['ordinal'];require(_uuid(value['id']) and _safe(ordinal),'Activity command limit exceeded',413);value['ordinal']+=1;return value['id'],ordinal
 @contextmanager
 def command_scope(self,command_id):
  require(_uuid(command_id),'Invalid activity command')
  with self.store.transaction():
   previous=getattr(self.store,'_activity_command',None);self.store._activity_command={'id':command_id,'ordinal':0}
   try:yield command_id
   finally:self.store._activity_command=previous
 def generation(self,kind,identity):
  if kind not in KINDS:return None
  if self.postgres:
   row=self.store._execute('SELECT p.generation FROM fountain_private.content_provenance p JOIN fountain_private.content_search_documents d USING(workspace_id,kind,id) WHERE p.workspace_id=%s AND p.kind=%s AND p.id=%s AND p.generation=d.generation',(self.store.workspace_id,kind,identity),fetch='one')
  else:row=self.store.db.execute('SELECT p.generation FROM content_provenance p JOIN content_search_documents d USING(kind,id) WHERE p.kind=? AND p.id=? AND p.generation=d.generation',(kind,identity)).fetchone()
  require(row is not None and _uuid(row[0]),'Final activity resource generation is unavailable',503);return row[0]
 @staticmethod
 def classify(kind,before,after):
  if before is None:return 'created' if after is not None else None
  if after is None:return 'deleted'
  absent=object()
  if any(not _same(before.get(k,absent),after.get(k,absent)) for k in AUTHORED[kind]):return 'edited'
  if not _same({k:v for k,v in before.items() if k not in IGNORED},{k:v for k,v in after.items() if k not in IGNORED}):return 'managed'
  return None
 def mutation(self,kind,identity,before_encoded,after_encoded,generation):
  if kind not in KINDS or getattr(self.store,'_retention_transition_depth',0):return None
  before=json.loads(before_encoded,parse_float=Decimal,parse_int=Decimal) if before_encoded is not None else None;after=json.loads(after_encoded,parse_float=Decimal,parse_int=Decimal) if after_encoded is not None else None
  action=self.classify(kind,before,after)
  if action is None:return None
  command,ordinal=self.command();actor=self.actor();origin=CONTENT_ORIGIN.get()
  if origin not in ('human','automation','import','public_form','system'):origin='unknown'
  if actor is None and origin=='human':origin='unknown'
  if self.postgres:
   return self.store._execute('SELECT fountain_private.activity_capture(%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s::jsonb,%s)',(self.store.workspace_id,kind,identity,before_encoded,after_encoded,generation,command,ordinal,json.dumps(actor) if actor else None,origin),fetch='one')[0]
  return self.record(kind,identity,generation,action,after_encoded if after_encoded is not None else before_encoded,command,ordinal,actor=actor,origin=origin)
 def record(self,kind,identity,generation,action,encoded,command_id,ordinal=0,*,actor=None,origin='unknown'):
  require(self.store.transaction_depth>0,'Activity capture requires the workspace writer',503)
  require(kind in KINDS and _id(identity) and _uuid(generation) and action in ('created','edited','managed','deleted','viewed') and _uuid(command_id) and _safe(ordinal),'Invalid activity fact')
  require(actor is None or actor==self.actor(),'Activity actor requires the current trusted principal',403)
  require(origin in ('human','automation','import','public_form','system','unknown'),'Invalid activity origin')
  require(actor is None or actor.get('auth_kind')!='service' or origin in ('automation','system','public_form'),'Service activity requires an explicit service origin')
  if actor is None and origin=='human':origin='unknown'
  try:
   body=canonical_source(encoded)
   source=json.loads(encoded,parse_float=Decimal,parse_int=Decimal)
  except (ValueError,TypeError,UnicodeError):raise APIError(400,'Invalid activity source encoding') from None
  require(isinstance(source,dict) and source.get('id')==identity,'Activity source identity differs')
  actual=self.store.db.execute('SELECT data FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone()
  if action=='deleted':require(actual is None,'Deleted activity source still exists',409)
  else:require(actual is not None and canonical_source(actual[0])==body and self.generation(kind,identity)==generation,'Activity source or final generation changed',409)
  ledger=self._runtime()
  with self._authority():
   stamp=_now();member=membership=account=None
   if actor is not None:
    require(set(actor)=={'member_id','auth_kind'} and _id(actor['member_id']) and actor['auth_kind'] in ('local','password','supabase','service'),'Invalid activity actor',503)
    member=actor['member_id'];require(_active(self.store.get('member',member)),'Activity actor is inactive',403)
    membership=self._membership(member,stamp)
    if actor['auth_kind'] in ('password','supabase'):account=self._account(member,actor['auth_kind'],stamp)
   digest=hashlib.sha256(body).hexdigest();candidate=(member,membership,account,origin,action,kind,identity,generation,'fountain-cjson-v1',len(body),digest)
   previous=self.store.db.execute('SELECT * FROM activity_events WHERE ledger_id=? AND command_id=? AND command_ordinal=?',(ledger,command_id,ordinal)).fetchone()
   if previous:
    require(tuple(previous[5:13])+tuple(previous[14:])==candidate,'Activity command payload differs',409);return dict(zip(ACTIVITY_COLUMNS['activity_events'],previous))
   row=self.store.db.execute('SELECT next_sequence FROM activity_runtime WHERE singleton=1').fetchone();sequence=row[0];require(_safe(sequence,1) and sequence<MAX_INT,'Activity sequence limit exceeded',413)
   event=(ledger,sequence,activity_id(),command_id,ordinal,member,membership,account,origin,action,kind,identity,generation,stamp,'fountain-cjson-v1',len(body),digest)
   self.store.db.execute('INSERT INTO activity_events VALUES('+','.join('?' for _ in event)+')',event);self._bump();self.store.db.execute('UPDATE activity_runtime SET next_sequence=next_sequence+1 WHERE singleton=1');return dict(zip(ACTIVITY_COLUMNS['activity_events'],event))
 def record_view(self,kind,identity,command_id=None):
  require(command_id is None or _uuid(command_id),'Invalid document open command')
  with self.store.transaction():
   if getattr(CURRENT_ACCESS.get(),'_activity_capture_reads',True) is False:return None
   actor=self.actor()
   if actor is None or actor['auth_kind']=='service':return None
   access=CURRENT_ACCESS.get();access.require_resource(kind,identity)
   command_id=command_id or activity_id();self._runtime();generation=self.generation(kind,identity)
   if self.postgres:return self.store._execute('SELECT fountain_private.activity_view(%s,%s,%s,%s,%s::jsonb,%s)',(self.store.workspace_id,kind,identity,command_id,json.dumps(actor),'human'),fetch='one')[0]
   raw=self.store.db.execute('SELECT data FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone();require(raw is not None,'Viewed resource is unavailable',404)
   return self.record(kind,identity,generation,'viewed',raw[0],command_id,actor=actor,origin='human')


def activate_restore_connection(connection):
 """Explicit trusted full-restore activation, never called by ordinary startup."""
 counts=inspect_portable_activity(connection,allow_unactivated=True)
 if not any(counts.values()):return False
 existing=connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name='activity_runtime'").fetchone()
 require(not existing or connection.execute('SELECT count(*) FROM activity_runtime').fetchone()[0]==0,'Activity restore target already has runtime authority',409)
 import threading
 class Target:
  db=connection;lock=threading.RLock();transaction_depth=1
  def commit(self):pass
 target=Target();ledger=ActivityLedger(target)
 trusted=connection.execute('PRAGMA trusted_schema').fetchone()[0]
 connection.execute('PRAGMA trusted_schema=ON')
 connection.execute('SAVEPOINT fountain_activity_restore')
 try:
  ledger.initialize();stamp=_now();identity=activity_id()
  with ledger._authority():
   connection.execute('INSERT INTO activity_ledgers VALUES(?,?,?,?)',(identity,stamp,'restore','canonical-server-v1'))
   connection.execute('INSERT INTO activity_runtime VALUES(1,?,1,1)',(identity,))
   for table in ('activity_accounts','activity_memberships'):
    for episode,opened in connection.execute('SELECT id,opened_at FROM '+table+' WHERE closed_at IS NULL').fetchall():
     require(_time(opened)<=_time(stamp),'Restored activity episode is in the future',400)
     connection.execute('UPDATE '+table+" SET closed_at=?,close_reason='restore' WHERE id=? AND closed_at IS NULL",(stamp,episode));ledger._bump()
  inspect_portable_activity(connection)
  connection.execute('RELEASE SAVEPOINT fountain_activity_restore')
 except BaseException:
  connection.execute('ROLLBACK TO SAVEPOINT fountain_activity_restore');connection.execute('RELEASE SAVEPOINT fountain_activity_restore');raise
 finally:connection.execute('PRAGMA trusted_schema='+str(int(trusted)))
 return True
