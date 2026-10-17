"""Canonical facts are private, atomic, episode-bound and explicit about reads."""
import hashlib
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import uuid
from contextlib import closing,contextmanager
from pathlib import Path
from unittest.mock import patch

from fountain.access import Access
from fountain.activity import ActivityLedger,ACTIVITY_COLUMNS,ACTIVITY_RUNTIME_COLUMNS,ACTIVITY_DEFINITIONS,ACTIVITY_RUNTIME_DEFINITIONS,ACTIVITY_TRIGGER_DEFINITIONS,MAX_INT,activate_restore_connection,inspect_portable_activity
from fountain.canonical import canonical_source
from fountain.core import Store,CURRENT_ACCESS,AUDIT_ACTOR,CONTENT_ORIGIN,APIError
from fountain.retention_vault import RetentionVault
from fountain.server import Application,create_server


class ActivityTests(unittest.TestCase):
 def setUp(self):
  self.s=Store(':memory:');self.addCleanup(self.s.close);self.ledger=ActivityLedger(self.s)
  self.s.put('member',{'id':'actor','email':'actor@test.invalid','name':'Actor','role':'owner','active':True})
 def events(self):return [dict(zip(ACTIVITY_COLUMNS['activity_events'],row)) for row in self.s.db.execute('SELECT * FROM activity_events ORDER BY ledger_id,sequence')]
 def error(self,status,call):
  with self.assertRaises(APIError) as caught:call()
  self.assertEqual(caught.exception.status,status)
 @contextmanager
 def actor(self,mode='local',origin='human'):
  access=Access(self.s,self.s.get('member','actor'));access._activity_auth_kind=mode
  a=CURRENT_ACCESS.set(access);b=AUDIT_ACTOR.set('actor');c=CONTENT_ORIGIN.set(origin)
  try:yield
  finally:CONTENT_ORIGIN.reset(c);AUDIT_ACTOR.reset(b);CURRENT_ACCESS.reset(a)
 def page(self,**values):return self.s.put('page',{'id':'page','title':'Original','blocks':[],'owner_id':'actor',**values})
 def test_private_schema_indexes_and_no_fake_past_facts(self):
  self.assertEqual(self.events(),[])
  indexes=[tuple(row[2] for row in self.s.db.execute('PRAGMA index_info('+name+')')) for name in ['sqlite_autoindex_activity_events_1','sqlite_autoindex_activity_events_2','sqlite_autoindex_activity_events_3']]
  self.assertEqual(indexes,[('ledger_id','sequence'),('event_id',),('ledger_id','command_id','command_ordinal')])
  self.assertEqual(inspect_portable_activity(self.s.db)['activity_events'],0)
 def test_legacy_current_members_bootstrap_without_inventing_resource_history(self):
  with closing(Store(':memory:')) as legacy:
   stamp='2025-01-01T00:00:00Z'
   for kind,value in [('member',{'id':'old','role':'member','active':True}),('credential',{'id':'old','salt':'private','password_hash':'private'}),('page',{'id':'old-page','title':'Historical','blocks':[]})]:
    legacy.db.execute('INSERT INTO entities VALUES(?,?,?,?,?)',(kind,value['id'],json.dumps(value),stamp,stamp))
   legacy.db.commit();source=list(legacy.db.execute("SELECT * FROM entities WHERE id IN ('old','old-page') ORDER BY kind"))
   legacy.put('page',{'id':'new-page','title':'New','blocks':[]})
   self.assertEqual(list(legacy.db.execute("SELECT * FROM entities WHERE id IN ('old','old-page') ORDER BY kind")),source)
   self.assertEqual(list(legacy.db.execute('SELECT resource_id,action FROM activity_events')),[('new-page','created')])
   self.assertEqual(list(legacy.db.execute('SELECT member_id FROM activity_current_members')),[('old',)])
   self.assertEqual(list(legacy.db.execute('SELECT member_id,auth_kind FROM activity_current_accounts')),[('old','password')]);inspect_portable_activity(legacy.db)
 def test_create_edit_manage_noop_delete_and_id_reuse(self):
  with self.actor():
   original=self.page();first=self.events()[-1];self.assertEqual((first['action'],first['actor_member_id']),('created','actor'))
   self.s.put('page',original);self.assertEqual(len(self.events()),1)
   original['revision']=99;self.s.put('page',original);self.assertEqual(len(self.events()),1)
   original['parent_id']='other';self.s.put('page',original);self.assertEqual(self.events()[-1]['action'],'managed')
   original['title']='Edited';original['locked']=True;self.s.put('page',original);self.assertEqual(self.events()[-1]['action'],'edited')
   before=self.s.db.execute("SELECT data FROM entities WHERE kind='page' AND id='page'").fetchone()[0]
   self.s.delete('page','page');deleted=self.events()[-1];self.assertEqual(deleted['action'],'deleted');self.assertEqual(deleted['resource_generation'],first['resource_generation']);self.assertEqual(deleted['source_sha256'],hashlib.sha256(canonical_source(before)).hexdigest())
   self.page();self.assertNotEqual(self.events()[-1]['resource_generation'],first['resource_generation'])
  inspect_portable_activity(self.s.db)
 def test_credential_reset_role_email_continuity_and_retirement(self):
  self.s.put('credential',{'id':'actor','salt':'private-secret','password_hash':'private-hash'})
  with self.actor('password'):self.page()
  first=self.events()[-1];member=self.s.get('member','actor');member.update(role='admin',email='new@test.invalid',name='Renamed');self.s.put('member',member)
  self.s.put('credential',{'id':'actor','salt':'new-secret','password_hash':'new-hash'})
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'Second'})
  second=self.events()[-1];self.assertEqual((first['membership_id'],first['account_id']),(second['membership_id'],second['account_id']))
  self.s.delete('credential','actor');self.s.put('credential',{'id':'actor','salt':'third','password_hash':'third'})
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'Third'})
  third=self.events()[-1];self.assertEqual(first['membership_id'],third['membership_id']);self.assertNotEqual(first['account_id'],third['account_id'])
  member=self.s.get('member','actor');member['active']=False;self.s.put('member',member);member['active']=True;self.s.put('member',member)
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'Fourth'})
  fourth=self.events()[-1];self.assertNotEqual(third['membership_id'],fourth['membership_id']);self.assertNotEqual(third['account_id'],fourth['account_id'])
  self.s.delete('member','actor');self.s.put('member',member)
  self.assertEqual(self.events()[0],first);inspect_portable_activity(self.s.db)
 def test_local_and_service_do_not_infer_interactive_account(self):
  self.s.put('credential',{'id':'actor','salt':'not-portable','password_hash':'not-portable'})
  with self.actor('local'):self.page()
  self.assertIsNone(self.events()[-1]['account_id'])
  with self.actor('password','automation'):self.s.put('page',{**self.s.get('page','page'),'title':'Automated'})
  self.assertEqual(self.events()[-1]['origin'],'automation');self.assertIsNone(self.events()[-1]['account_id'])
  raw=json.dumps({table:list(self.s.db.execute('SELECT * FROM '+table)) for table in ACTIVITY_COLUMNS})
  self.assertNotIn('not-portable',raw);self.assertNotIn('salt',raw)
  with self.actor('service'),self.s.transaction():
   self.error(400,lambda:self.ledger.record('page','page',self.ledger.generation('page','page'),'viewed','{}','d'*32,actor=self.ledger.actor(),origin='human'))
  with self.actor(origin='import'):self.s.put('page',{**self.s.get('page','page'),'title':'Known import cause'})
  self.assertEqual(self.events()[-1]['origin'],'import')
  context=CONTENT_ORIGIN.set('import')
  try:self.s.put('page',{**self.s.get('page','page'),'title':'Unattributed import'})
  finally:CONTENT_ORIGIN.reset(context)
  self.assertEqual(self.events()[-1]['origin'],'import');self.assertIsNone(self.events()[-1]['actor_member_id'])
 def test_forged_json_audit_and_unattributed_operator_are_not_human(self):
  self.page(actor_member_id='actor',membership_id='fake',created_by='actor');self.assertIsNone(self.events()[-1]['actor_member_id']);self.assertEqual(self.events()[-1]['origin'],'unknown')
  count=len(self.events());self.s.put('audit',{'action':'page.viewed','user':'actor','page_id':'page'});self.s.get('page','page');self.s.list('page');self.assertEqual(len(self.events()),count)
  event=self.events()[-1]
  with self.s.transaction():self.error(403,lambda:self.ledger.record('page','page',event['resource_generation'],'viewed','{}','a'*32,actor={'member_id':'actor','auth_kind':'password'},origin='human'))
 def test_command_exact_retry_collision_and_rollback_do_not_consume_sequence(self):
  with self.actor():self.page()
  with self.actor(),self.s.transaction():
   command='a'*32;generation=self.ledger.generation('page','page');raw=self.s.db.execute("SELECT data FROM entities WHERE kind='page' AND id='page'").fetchone()[0]
   first=self.ledger.record('page','page',generation,'viewed',raw,command,actor=self.ledger.actor(),origin='human');fence=self.ledger.fence()
   self.assertEqual(self.ledger.record('page','page',generation,'viewed',raw,command,actor=self.ledger.actor(),origin='human'),first);self.assertEqual(self.ledger.fence(),fence)
   self.error(409,lambda:self.ledger.record('page','page',generation,'viewed','{"id":"page","changed":true}',command,actor=self.ledger.actor(),origin='human'))
  before=(self.events(),self.ledger.fence())
  with self.assertRaises(RuntimeError),self.actor(),self.s.transaction():self.s.put('page',{**self.s.get('page','page'),'title':'Rolled back'});raise RuntimeError('injected failure')
  self.assertEqual((self.events(),self.ledger.fence()),before);self.assertEqual(self.s.get('page','page')['title'],'Original')
 def test_private_guards_block_raw_insert_update_delete_and_generic_meta_authority(self):
  with self.actor():self.page()
  self.s.set_meta('activity_transition',True)
  for table in (*ACTIVITY_COLUMNS,*ACTIVITY_RUNTIME_COLUMNS):
   if self.s.db.execute('SELECT 1 FROM '+table).fetchone():
    for statement in ('DELETE FROM '+table,'UPDATE '+table+' SET '+(ACTIVITY_COLUMNS|ACTIVITY_RUNTIME_COLUMNS)[table][0]+'='+(ACTIVITY_COLUMNS|ACTIVITY_RUNTIME_COLUMNS)[table][0]):
     with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute(statement)
     self.s.db.rollback()
  with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute("INSERT INTO activity_ledgers VALUES(?,?,?,?)",('f'*32,'2026-10-17T00:00:00Z','installation','canonical-server-v1'))
  self.s.db.rollback();inspect_portable_activity(self.s.db)
 def test_reopening_rejects_a_shadowed_private_guard(self):
  name='fountain_activity_events_insert';self.s.db.execute('DROP TRIGGER '+name)
  self.s.db.execute('CREATE TRIGGER '+name+" BEFORE INSERT ON activity_events BEGIN SELECT 1; END");self.s.db.commit()
  self.error(503,self.ledger.initialize)
 def test_vault_private_archive_restore_preserves_generation_without_fresh_create(self):
  with self.actor():self.page(archived=True)
  before=self.events();generation=before[-1]['resource_generation'];vault=RetentionVault(self.s);record=vault.archive_page('page');vault.restore_to_trash(record['id'])
  self.assertEqual(self.events(),before);self.assertEqual(self.ledger.generation('page','page'),generation)
 def test_explicit_restore_new_epoch_closes_old_authority_and_preserves_events(self):
  with self.actor():self.page()
  before=self.events();old=self.ledger.fence()['ledger_id']
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'portable.db';db=sqlite3.connect(path);self.s.db.backup(db)
   for row in db.execute("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'fountain_activity_%'").fetchall():db.execute('DROP TRIGGER '+row[0])
   for table in reversed(tuple(ACTIVITY_RUNTIME_COLUMNS)):db.execute('DROP TABLE '+table)
   db.commit();inspect_portable_activity(db)
   db.execute('PRAGMA trusted_schema=OFF')
   self.assertTrue(activate_restore_connection(db));self.assertEqual(db.execute('PRAGMA trusted_schema').fetchone()[0],0);db.commit();inspect_portable_activity(db)
   self.assertEqual(list(db.execute('SELECT * FROM activity_events')),list(self.s.db.execute('SELECT * FROM activity_events')))
   self.assertEqual(db.execute('SELECT count(*) FROM activity_current_members').fetchone()[0],0);self.assertNotEqual(db.execute('SELECT ledger_id FROM activity_runtime').fetchone()[0],old)
   self.assertEqual(db.execute("SELECT close_reason FROM activity_memberships WHERE closed_at IS NOT NULL").fetchone()[0],'restore');db.close()
 def test_missing_runtime_history_never_silently_resets(self):
  with self.actor():self.page()
  with self.ledger._authority():self.s.db.execute('DELETE FROM activity_runtime')
  self.s.db.commit();before=self.events()
  self.error(503,lambda:self.page(title='Must not commit'))
  self.assertEqual(self.events(),before)
 def test_reopened_wrong_safe_counter_rejects_mutation_without_source_or_event_change(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'corrupt-counter.db'
   with closing(Store(path)) as source:
    source.put('page',{'id':'page','title':'Original','blocks':[]});ledger=ActivityLedger(source)
    with ledger._authority():source.db.execute('UPDATE activity_runtime SET next_sequence=next_sequence+2')
    source.db.commit()
   with closing(Store(path)) as reopened:
    before=reopened.get('page','page');events=list(reopened.db.execute('SELECT * FROM activity_events'));runtime=list(reopened.db.execute('SELECT * FROM activity_runtime'))
    self.error(503,lambda:reopened.put('page',before))
    self.error(503,lambda:reopened.put('page',{**before,'title':'Must fail closed'}))
    self.assertEqual(reopened.get('page','page'),before);self.assertEqual(list(reopened.db.execute('SELECT * FROM activity_events')),events);self.assertEqual(list(reopened.db.execute('SELECT * FROM activity_runtime')),runtime)
 def test_entity_number_unicode_digest_is_exact(self):
  with self.actor():self.page(title='Straße 😀',number=9007199254740993,negative_zero=-0.0)
  raw=self.s.db.execute("SELECT data FROM entities WHERE kind='page' AND id='page'").fetchone()[0];event=self.events()[-1];canonical=canonical_source(raw)
  self.assertEqual(event['source_bytes'],len(canonical));self.assertEqual(event['source_sha256'],hashlib.sha256(canonical).hexdigest());self.assertIn(b'9007199254740993e0',canonical)
 def test_read_routes_and_real_HTTP_HEAD_do_not_count_prefetch_as_view(self):
  app=Application(self.s);actor=self.s.get('member','actor')
  with self.actor():self.page()
  count=len(self.events());app.dispatch('GET','/api/workspace',{}, {},principal=actor);app.dispatch('GET','/api/pages/page/collaboration',{}, {},principal=actor);self.assertEqual(len(self.events()),count)
  app.dispatch('GET','/api/pages/page',{}, {},principal=actor);self.assertEqual(self.events()[-1]['action'],'viewed')
  after=len(self.events());app.dispatch('GET','/api/pages/page/collaboration',{}, {'open_command':['b'*32]},principal=actor);app.dispatch('GET','/api/pages/page/collaboration',{}, {'open_command':['b'*32]},principal=actor);self.assertEqual(len(self.events()),after+1)
  self.error(400,lambda:app.dispatch('GET','/api/pages/page/collaboration',{}, {'open_command':['bad']},principal=actor))
  server=create_server(port=0,db_path=':memory:');thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   http_events=lambda:server.application.store.db.execute('SELECT count(*) FROM activity_events').fetchone()[0]
   before=http_events();connection=http.client.HTTPConnection('127.0.0.1',server.server_address[1]);connection.request('HEAD','/api/pages/welcome',headers={'X-Fountain-Request':'1'});response=connection.getresponse();self.assertEqual(response.status,200);self.assertEqual(response.read(),b'');connection.close();self.assertEqual(http_events(),before)
   connection=http.client.HTTPConnection('127.0.0.1',server.server_address[1]);connection.request('GET','/api/pages/welcome',headers={'X-Fountain-Request':'1'});response=connection.getresponse();self.assertEqual(response.status,200);response.read();connection.close();self.assertEqual(http_events(),before+1)
  finally:server.shutdown();server.server_close();server.application.store.close();thread.join(2)

 def test_private_ids_do_not_consume_or_weaken_public_entity_allocator(self):
  with patch('fountain.core.uid',side_effect=['public-one','public-two']) as allocate:
   self.s.put('page',{'title':'One','blocks':[]});self.s.put('page',{'title':'Two','blocks':[]})
   self.assertEqual(allocate.call_count,2)
  for event in self.events():
   self.assertRegex(event['command_id'],r'^[a-f0-9]{32}$');self.assertRegex(event['event_id'],r'^[a-f0-9]{32}$')
  inspect_portable_activity(self.s.db)
 def test_nested_rollback_restores_command_ordinals_and_activity_revision(self):
  with self.actor(),self.ledger.command_scope('c'*32):
   self.page()
   try:
    with self.s.transaction():self.s.put('page',{**self.s.get('page','page'),'title':'Rollback'});raise RuntimeError('fail')
   except RuntimeError:pass
   self.s.put('page',{**self.s.get('page','page'),'title':'Accepted'})
  self.assertEqual([(e['command_id'],e['command_ordinal']) for e in self.events()],[('c'*32,0),('c'*32,1)])
  self.assertEqual([e['sequence'] for e in self.events()],[1,2]);inspect_portable_activity(self.s.db)
 def test_actual_password_session_mode_survives_member_refresh(self):
  app=Application(self.s)
  app.auth.set_password('local','local-password-123');app.auth.set_password('actor','actor-password-123');app.auth.enable_accounts()
  cookie='fountain_session='+app.auth.login({'email':'actor@test.invalid','password':'actor-password-123'})
  with self.actor():self.page()
  app.dispatch('GET','/api/pages/page',{}, {},session_cookie=cookie)
  event=self.events()[-1];self.assertIsNotNone(event['account_id']);self.assertEqual(self.s.db.execute('SELECT auth_kind FROM activity_accounts WHERE id=?',(event['account_id'],)).fetchone()[0],'password')
  app.auth.set_password('actor','different-password-123');self.error(401,lambda:app.dispatch('GET','/api/pages/page',{}, {},session_cookie=cookie))
  cookie='fountain_session='+app.auth.login({'email':'actor@test.invalid','password':'different-password-123'})
  app.dispatch('GET','/api/pages/page',{}, {},session_cookie=cookie);self.assertEqual(self.events()[-1]['account_id'],event['account_id'])
 def test_exact_classifier_distinguishes_boolean_and_fractional_numbers(self):
  self.assertEqual(ActivityLedger.classify('row',{'properties':{'x':True}},{'properties':{'x':1}}),'edited')
  from decimal import Decimal
  self.assertEqual(ActivityLedger.classify('row',{'properties':{'x':Decimal('0.123456789012345678901')}},{'properties':{'x':Decimal('0.123456789012345678902')}}),'edited')
 def test_revision_limit_rolls_back_source_event_and_lifecycle_changes(self):
  with self.actor():self.page()
  with self.ledger._authority():self.s.db.execute('UPDATE activity_runtime SET activity_revision=?',(MAX_INT,))
  self.s.db.commit();before=self.events();source=self.s.get('page','page');fence=self.ledger.fence()
  with self.actor():self.error(413,lambda:self.s.put('page',{**source,'title':'Cannot commit'}))
  self.assertEqual(self.s.get('page','page'),source);self.assertEqual(self.events(),before);self.assertEqual(self.ledger.fence(),fence)
  member=self.s.get('member','actor');self.error(413,lambda:self.s.put('member',{**member,'active':False}))
  self.assertEqual(self.s.get('member','actor'),member);self.assertEqual(self.ledger.fence(),fence);inspect_portable_activity(self.s.db)
 def test_portable_validation_rejects_partial_runtime_wrong_sequence_and_actor_fk(self):
  with sqlite3.connect(':memory:') as db:
   db.execute(ACTIVITY_RUNTIME_DEFINITIONS['activity_runtime']);self.error(400,lambda:inspect_portable_activity(db))
  with self.actor():self.page()
  for statement in ('UPDATE activity_events SET sequence=2','UPDATE activity_events SET membership_id=\''+'f'*32+'\'','UPDATE activity_memberships SET closed_at=\'2026-02-30T00:00:00Z\',close_reason=\'inactive\'','UPDATE activity_runtime SET activity_revision=0'):
   with sqlite3.connect(':memory:') as db:
    self.s.db.backup(db)
    for name in ACTIVITY_TRIGGER_DEFINITIONS:db.execute('DROP TRIGGER '+name)
    db.execute(statement);self.error(400,lambda:inspect_portable_activity(db))
 def test_password_and_supabase_accounts_coexist_without_switching_authority(self):
  self.s.put('credential',{'id':'actor','salt':'private','password_hash':'private'})
  with self.actor('password'):self.page()
  password=self.events()[-1]['account_id']
  with self.actor('supabase'):self.s.put('page',{**self.s.get('page','page'),'title':'Supabase principal'})
  supabase=self.events()[-1]['account_id'];self.assertNotEqual(password,supabase)
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'Password principal'})
  self.assertEqual(self.events()[-1]['account_id'],password)
  self.s.delete('credential','actor');self.assertEqual(list(self.s.db.execute('SELECT auth_kind,account_id FROM activity_current_accounts')),[('supabase',supabase)])
  self.assertEqual(self.s.db.execute('SELECT closed_at FROM activity_accounts WHERE id=?',(supabase,)).fetchone()[0],None);inspect_portable_activity(self.s.db)
 def test_kernel_rejects_scalar_wrong_identity_generation_and_stale_source(self):
  with self.actor():self.page()
  before=self.events();fence=self.ledger.fence()
  with self.actor(),self.s.transaction():
   generation=self.ledger.generation('page','page');raw=self.s.db.execute("SELECT data FROM entities WHERE kind='page' AND id='page'").fetchone()[0]
   record=lambda encoded,gen=generation,action='viewed':self.ledger.record('page','page',gen,action,encoded,'e'*32,actor=self.ledger.actor(),origin='human')
   self.error(400,lambda:record('42'));self.error(400,lambda:record('{"id":"other"}'));self.error(409,lambda:record(raw,'f'*32));self.error(409,lambda:record('{"id":"page","title":"Stale"}'));self.error(409,lambda:record(raw,action='deleted'))
  self.assertEqual(self.events(),before);self.assertEqual(self.ledger.fence(),fence)


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'),'Actual PostgreSQL driver requires FOUNTAIN_TEST_POSTGRES_DSN')
class ActivityPostgresTests(unittest.TestCase):
 """Provisioning is external; each exact random namespace rolls back wholly."""
 def setUp(self):
  from fountain.postgres import PostgresStore
  self.s=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id='fountain-qa-activity-'+uuid.uuid4().hex);self.addCleanup(self.s.close)
  transaction=self.s.transaction();transaction.__enter__();self.addCleanup(lambda:transaction.__exit__(RuntimeError,RuntimeError('owned fixture rollback'),None))
  provisioned=self.s._execute("SELECT to_regprocedure('fountain_private.activity_initialize(text)') IS NOT NULL",fetch='one')[0]
  self.assertTrue(provisioned,'Activity schema must be externally provisioned; tests issue no DDL')
  self.ledger=ActivityLedger(self.s);self.s.put('member',{'id':'actor','name':'Actor','email':'actor@test.invalid','role':'owner','active':True})
 @contextmanager
 def actor(self,mode='local',origin='human'):
  access=Access(self.s,self.s.get('member','actor'));access._activity_auth_kind=mode
  a=CURRENT_ACCESS.set(access);b=AUDIT_ACTOR.set('actor');c=CONTENT_ORIGIN.set(origin)
  try:yield
  finally:CONTENT_ORIGIN.reset(c);AUDIT_ACTOR.reset(b);CURRENT_ACCESS.reset(a)
 def events(self):
  rows=self.s._execute('SELECT '+','.join(ACTIVITY_COLUMNS['activity_events'])+' FROM fountain_private.activity_events WHERE workspace_id=%s ORDER BY ledger_id,sequence',(self.s.workspace_id,),fetch='all')
  return [dict(zip(ACTIVITY_COLUMNS['activity_events'],row)) for row in rows]
 def page(self,**values):return self.s.put('page',{'id':'page','title':'Original','blocks':[],'owner_id':'actor',**values})
 def error(self,status,call):
  with self.assertRaises(APIError) as caught:call()
  self.assertEqual(caught.exception.status,status)
 def validate(self):self.s._execute('SELECT fountain_private.activity_validate_workspace(%s)',(self.s.workspace_id,),fetch='one')
 def test_actual_generation_digest_classifier_delete_and_recreate(self):
  with self.actor():
   value=self.page(title='Straße 😀',number=9007199254740993);first=self.events()[-1]
   raw=self.s._execute("SELECT data::text FROM fountain_private.entities WHERE workspace_id=%s AND kind='page' AND id='page'",(self.s.workspace_id,),fetch='one')[0]
   self.assertEqual(first['source_sha256'],hashlib.sha256(canonical_source(raw)).hexdigest());self.assertEqual(first['source_bytes'],len(canonical_source(raw)))
   self.s.put('page',value);self.assertEqual(len(self.events()),1)
   value['parent_id']='moved';self.s.put('page',value);self.assertEqual(self.events()[-1]['action'],'managed')
   value['title']='Changed';self.s.put('page',value);self.assertEqual(self.events()[-1]['action'],'edited')
   generation=first['resource_generation'];self.s.delete('page','page');self.assertEqual((self.events()[-1]['action'],self.events()[-1]['resource_generation']),('deleted',generation))
   self.page();self.assertNotEqual(self.events()[-1]['resource_generation'],generation)
  self.validate()
 def test_actual_episode_reset_retirement_reactivation(self):
  self.s.put('credential',{'id':'actor','salt':'private-salt','password_hash':'private-hash'})
  with self.actor('password'):self.page()
  first=self.events()[-1];member=self.s.get('member','actor');member['email']='changed@test.invalid';self.s.put('member',member);self.s.put('credential',{'id':'actor','salt':'new','password_hash':'new'})
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'Reset continuity'})
  self.assertEqual(self.events()[-1]['account_id'],first['account_id'])
  self.s.delete('credential','actor');self.s.put('credential',{'id':'actor','salt':'third','password_hash':'third'})
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'New account'})
  second=self.events()[-1];self.assertEqual(second['membership_id'],first['membership_id']);self.assertNotEqual(second['account_id'],first['account_id'])
  self.s.put('member',{**member,'active':False});self.s.put('member',{**member,'active':True})
  with self.actor('password'):self.s.put('page',{**self.s.get('page','page'),'title':'New membership'})
  self.assertNotEqual(self.events()[-1]['membership_id'],first['membership_id']);self.validate()
 def test_actual_view_retry_collision_and_acl_revocation(self):
  with self.actor():
   self.page();before=len(self.events());self.s.get('page','page');self.s.list('page');self.assertEqual(len(self.events()),before)
   first=self.ledger.record_view('page','page','a'*32);fence=self.ledger.fence();self.assertEqual(self.ledger.record_view('page','page','a'*32),first);self.assertEqual(self.ledger.fence(),fence)
   self.s.put('page',{**self.s.get('page','page'),'title':'Changed after open'});before=len(self.events());self.error(409,lambda:self.ledger.record_view('page','page','a'*32));self.assertEqual(len(self.events()),before)
  member=self.s.get('member','actor');self.s.put('member',{**member,'active':False})
  with self.actor():self.assertIsNone(self.ledger.record_view('page','page','b'*32))
  self.assertEqual(len(self.events()),before);self.validate()
 def test_actual_raw_private_writes_and_namespace_forgery_rejected(self):
  with self.actor():self.page()
  before=self.events()
  for statement in ('DELETE FROM fountain_private.activity_events WHERE workspace_id=%s','UPDATE fountain_private.activity_runtime SET next_sequence=1 WHERE workspace_id=%s'):
   with self.assertRaises(APIError),self.s.transaction():
    self.s._execute("SELECT set_config('fountain.activity_write',%s,true)",(self.s.workspace_id,));self.s._execute(statement,(self.s.workspace_id,))
  with self.assertRaises(APIError),self.s.transaction():self.s._execute('SELECT fountain_private.activity_initialize(%s)',('different-workspace',),fetch='one')
  self.assertEqual(self.events(),before);self.validate()
 def test_actual_nested_rollback_and_vault_release_do_not_fabricate_creation(self):
  with self.actor(),self.ledger.command_scope('c'*32):
   self.page(archived=True)
   try:
    with self.s.transaction():self.s.put('page',{**self.s.get('page','page'),'title':'Rollback'});raise RuntimeError('injected failure')
   except RuntimeError:pass
   self.s.put('page',{**self.s.get('page','page'),'title':'Accepted'})
  self.assertEqual([(event['command_ordinal'],event['sequence']) for event in self.events()],[(0,1),(1,2)])
  before=self.events();generation=self.ledger.generation('page','page');vault=RetentionVault(self.s);record=vault.archive_page('page');vault.restore_to_trash(record['id'])
  self.assertEqual(self.events(),before);self.assertEqual(self.ledger.generation('page','page'),generation);self.validate()
