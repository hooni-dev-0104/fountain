"""Private retention is a complete move with storage-boundary fences."""
import base64
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.core import APIError, Store
from fountain.retention_vault import RetentionVault, VAULT_COLUMNS, VAULT_DEFINITIONS, VAULT_TRIGGER_DEFINITIONS


class RetentionVaultTests(unittest.TestCase):
    def setUp(self):
        self.s=Store(':memory:');self.addCleanup(self.s.close);self.v=RetentionVault(self.s)
        self.page('root',archived=True)
    def page(self,identity,**values):return self.s.put('page',{'id':identity,'title':identity,'blocks':[],**values})
    def error(self,status,call):
        with self.assertRaises(APIError) as caught:call()
        self.assertEqual(caught.exception.status,status)
    def archive(self,**kwargs):return self.v.archive_page('root',at='2026-10-17T01:00:00Z',**kwargs)
    def state(self):return tuple((table,tuple(self.s.db.execute('SELECT * FROM '+table+' ORDER BY 1,2'))) for table in ('entities','meta','content_provenance',*VAULT_COLUMNS))
    def file(self,identity='file',pages=('root',)):
        data=b'a'*65537+b'\x00tail';self.s.chunk_write(identity,0,data)
        self.s.put('attachment',{'id':identity,'size':len(data),'storage':'chunks','sha256':hashlib.sha256(data).hexdigest(),'page_id':pages[0]})
        for page in pages:
            value=self.s.get('page',page);value['blocks']=[{'id':'block','type':'file','attachment_id':identity}];self.s.put('page',value)
        return data
    def test_initialization_does_not_change_entities_or_meta(self):
        before=self.state();self.v.initialize();self.assertEqual(before,self.state())
        for name,columns in VAULT_COLUMNS.items():self.assertEqual(tuple(r[1] for r in self.s.db.execute('PRAGMA table_info('+name+')')),columns)
        self.assertEqual(set(VAULT_TRIGGER_DEFINITIONS),{r[0] for r in self.s.db.execute("SELECT name FROM sqlite_schema WHERE type='trigger'")})
    def test_whole_nested_closure_is_private_and_raw_history_is_exact(self):
        self.page('child',parent_id='root');self.page('grand',parent_id='child')
        self.s.put('database',{'id':'db','parent_id':'child','properties':[{'id':'files','type':'files'}]})
        self.s.put('row',{'id':'r','database_id':'db','properties':{}})
        for kind,body in [('comment',{'id':'c','page_id':'child','body':'private'}),('version',{'id':'v','page_id':'root','blocks':[{'type':'paragraph','text':'old'}]}),('collaboration',{'id':'root','epoch':'unchanged','state':{'seen':['original'],'body':'private'}}),('wiki_page',{'id':'child','page_id':'child'}),('site',{'id':'site','page_id':'grand','published':True}),('form',{'id':'form','database_id':'db','published':True}),('automation',{'id':'auto','database_id':'db','enabled':True}),('transcript',{'id':'owned','page_id':'root','body':'full'})]:self.s.put(kind,body)
        self.s.put('transcript',{'id':'external','database_id':'db','body':'external'})
        before={tuple(r[:2]):tuple(r[2:]) for r in self.s.db.execute("SELECT kind,id,data,created_at,updated_at FROM entities WHERE kind!='transcript' OR id!='external'")}
        provenance=list(self.s.db.execute('SELECT * FROM content_provenance ORDER BY kind,id'))
        record=self.archive();self.assertEqual(record['counts']['entities'],13)
        self.assertEqual({r[0] for r in self.s.db.execute('SELECT kind FROM entities')},{'audit','transcript'})
        self.assertEqual(self.s.list('page'),[]);self.assertNotIn('private',json.dumps(self.v.records()))
        self.v.restore_to_trash(record['id']);self.assertTrue(self.s.get('page','root')['archived'])
        for (kind,identity),raw in before.items():
            actual=self.s.db.execute('SELECT data,created_at,updated_at FROM entities WHERE kind=? AND id=?',(kind,identity)).fetchone()
            if kind not in ('site','form','automation'):self.assertEqual(actual,raw)
        self.assertEqual(list(self.s.db.execute('SELECT * FROM content_provenance ORDER BY kind,id')),provenance)
        for kind,key in [('site','published'),('form','published'),('automation','enabled')]:self.assertFalse(self.s.list(kind)[0][key])
        self.assertTrue(all(not self.s.db.execute('SELECT 1 FROM '+table).fetchone() for table in VAULT_COLUMNS))
    def test_reserved_identity_and_child_bypass_guards(self):
        record=self.archive();before=self.state()
        for kind,data in [('page',{'id':'root'}),('page',{'id':'new','parent_id':'root'}),('comment',{'id':'c','page_id':'root'}),('collaboration',{'id':'root'}),('wiki_page',{'id':'root'})]:
            self.error(409,lambda kind=kind,data=data:self.s.put(kind,data))
        with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute("INSERT INTO entities VALUES('page','direct',?, 'x','x')",(json.dumps({'id':'direct','parent_id':'root','_retention_transition':True}),))
        self.s.db.rollback()
        self.s.set_meta('retention_transition',True)
        self.error(409,lambda:self.s.put('page',{'id':'root','retention_transition':True}))
        self.assertEqual(self.v.records()[0]['id'],record['id'])
    def test_private_table_raw_mutations_are_rejected(self):
        record=self.archive()
        for table in VAULT_COLUMNS:
            if self.s.db.execute('SELECT 1 FROM '+table).fetchone():
                with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute('DELETE FROM '+table)
                self.s.db.rollback()
        self.assertEqual(len(self.v.records()),1)
    def test_raw_chunk_update_delete_and_metadata_pins(self):
        data=self.file();record=self.archive();self.assertIsNone(self.s.get('attachment','file'))
        self.assertTrue(self.v.attachment_pinned('file'))
        for statement in ["DELETE FROM attachment_chunks", "UPDATE attachment_chunks SET data=X'00'", "INSERT OR REPLACE INTO attachment_chunks VALUES('file',0,X'01')"]:
            with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute(statement)
            self.s.db.rollback()
        self.s.chunk_write('unrelated',0,b'other')
        with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute("UPDATE attachment_chunks SET attachment_id='file', offset=100000 WHERE attachment_id='unrelated'")
        self.s.db.rollback()
        self.error(409,lambda:self.s.chunk_delete('file'));self.error(409,lambda:self.s.chunk_write('file',100000,b'new'))
        self.error(409,lambda:self.s.put('attachment',{'id':'file','size':1}))
        self.v.restore_to_trash(record['id']);self.assertEqual(self.s.chunk_read_range('file',0,0,len(data)),data)
        self.s.chunk_delete('file');self.assertEqual(self.s.chunk_list('file'),[])
    def test_shared_attachment_restore_both_orders(self):
        for reverse in (False,True):
            with self.subTest(reverse=reverse):
                s=Store(':memory:');v=RetentionVault(s)
                try:
                    for name in ('a','b'):s.put('page',{'id':name,'archived':True,'blocks':[{'attachment_id':'f'}]})
                    blob=b'shared';s.chunk_write('f',0,blob);s.put('attachment',{'id':'f','size':len(blob),'storage':'chunks','sha256':hashlib.sha256(blob).hexdigest()})
                    records=[v.archive_page(name) for name in ('a','b')]
                    self.assertIsNone(s.get('attachment','f'))
                    if reverse:records.reverse()
                    v.restore_to_trash(records[0]['id']);self.assertTrue(v.attachment_pinned('f'))
                    self.error(409,lambda:s.chunk_delete('f'))
                    v.restore_to_trash(records[1]['id']);self.assertFalse(v.attachment_pinned('f'))
                    self.assertEqual(s.chunk_read_range('f',0,0,20),blob)
                finally:s.close()
    def test_retry_record_id_is_exact_and_revision_conflict_reads_no_source(self):
        identity='a'*32;source=self.s.meta('_entity_revision')
        record=self.archive(record_id=identity,expected_revision=source);before=self.state()
        self.assertEqual(record,self.archive(record_id=identity,expected_revision=source));self.assertEqual(before,self.state())
        self.error(409,lambda:self.archive(record_id=identity,retention_days=31))
        with patch.object(self.v,'_source',side_effect=AssertionError('body read before revision fence')):
            self.error(409,lambda:self.v.archive_page('other',expected_revision=source))
    def test_failed_copy_and_revision_overflow_roll_back_all_tables(self):
        self.file();before=self.state()
        original=self.v._copy
        def fail(*args,**kwargs):original(*args,**kwargs);raise RuntimeError('injected copy failure')
        with patch.object(self.v,'_copy',side_effect=fail),self.assertRaises(RuntimeError):self.archive()
        self.assertEqual(before,self.state())
        self.s.set_meta('access_revision',9007199254740991);before=self.state()
        self.error(413,self.archive);self.assertEqual(before,self.state())
    def test_pending_upload_and_corrupt_manifest_are_atomic_conflicts(self):
        self.s.put('upload',{'id':'pending','page_id':'root','completed':False});before=self.state()
        self.error(409,self.archive);self.assertEqual(before,self.state());self.s.delete('upload','pending')
        self.file();self.s.db.execute("UPDATE attachment_chunks SET data=X'01'");self.s.db.commit();before=self.state()
        self.error(409,self.archive);self.assertEqual(before,self.state())
    def test_cycle_is_conflict_no_truncated_closure(self):
        self.page('child',parent_id='root');root=self.s.get('page','root');root['parent_id']='child';self.s.put('page',root)
        before=self.state();self.error(409,self.archive);self.assertEqual(before,self.state())
    def test_dependency_journal_restores_and_concurrent_change_is_conflict(self):
        self.s.put('database',{'id':'owned','parent_id':'root','properties':[]});self.s.put('row',{'id':'gone','database_id':'owned','properties':{}})
        self.s.put('database',{'id':'external','properties':[]});self.s.put('row',{'id':'live','database_id':'external','properties':{},'depends_on':['gone','keep']})
        generation=self.s.db.execute("SELECT generation FROM content_provenance WHERE kind='row' AND id='live'").fetchone()[0]
        record=self.archive();self.assertEqual(self.s.get('row','live')['depends_on'],['keep'])
        value=self.s.get('row','live');value['depends_on']=['concurrent'];self.s.put('row',value);before=self.state()
        self.error(409,lambda:self.v.restore_to_trash(record['id']));self.assertEqual(before,self.state())
        value['depends_on']=['keep'];self.s.put('row',value);self.v.restore_to_trash(record['id'])
        self.assertEqual(self.s.get('row','live')['depends_on'],['gone','keep'])
        self.assertEqual(self.s.db.execute("SELECT generation FROM content_provenance WHERE kind='row' AND id='live'").fetchone()[0],generation)
    def test_large_body_never_forms_whole_closure_frame(self):
        for i in range(8):self.page('p'+str(i),parent_id='root',blocks=[{'type':'paragraph','text':'x'*600000}])
        with patch('fountain.retention_vault._encode',wraps=__import__('fountain.retention_vault',fromlist=['_encode'])._encode) as encode:
            record=self.archive()
            self.assertEqual(record['counts']['entities'],9)
            self.assertTrue(all(len(str(call.args[0]))<10000 for call in encode.call_args_list))
    def test_strict_inputs_and_active_root(self):
        for kwargs in ({'retention_days':True},{'retention_days':0},{'retention_days':3651},{'record_id':'fake'},{'expected_revision':True},{'at':'2026-10-17'},{'at':'9999-12-31T23:59:59Z'}):
            self.error(400,lambda kwargs=kwargs:self.v.archive_page('root',**kwargs))
        self.page('active');self.error(409,lambda:self.v.archive_page('active'))
        self.error(400,lambda:self.v.archive_page('bad\ud800'))
        self.error(404,lambda:self.v.restore_to_trash('a'*32))

    def test_latent_crdt_attachment_refs_survive_undo_history(self):
        raw=b'undo';self.s.chunk_write('latent',0,raw);self.s.put('attachment',{'id':'latent','storage':'chunks','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        state={'blocks':{'old':{'fields':{'attachment_id':{'value':'latent'}}}},'history':{'baseline':{'blocks':{}},'ops':{'op':{'type':'block.set','field':'attachment_id','value':'latent'}}}}
        self.s.put('collaboration',{'id':'root','state':state,'epoch':'same','seq':2})
        record=self.archive();self.assertTrue(self.v.attachment_pinned('latent'))
        self.v.restore_to_trash(record['id']);self.assertEqual(self.s.get('collaboration','root')['state'],state)
    def test_shared_rearchive_keeps_other_record_reservation(self):
        self.page('b',archived=True);self.file(pages=('root','b'))
        a=self.archive();b=self.v.archive_page('b');self.v.restore_to_trash(a['id'])
        reservation=self.s.db.execute("SELECT record_id,generation FROM retention_identity_reservations WHERE kind='attachment' AND id='file'").fetchone()
        c=self.archive();self.assertIsNone(self.s.get('attachment','file'));self.assertEqual(self.s.db.execute("SELECT record_id,generation FROM retention_identity_reservations WHERE kind='attachment' AND id='file'").fetchone(),reservation)
        self.assertEqual(reservation[0],b['id'])
        self.v.restore_to_trash(b['id']);self.assertTrue(self.v.attachment_pinned('file'));self.v.restore_to_trash(c['id']);self.assertFalse(self.v.attachment_pinned('file'))
    def test_portable_cloud_restore_requires_full_verified_blob_explicit_target(self):
        raw=b'cloud';digest=hashlib.sha256(raw).hexdigest()
        self.s.put('attachment',{'id':'cloud','page_id':'root','size':len(raw),'sha256':digest,'storage':'chunks','cloud_chunks':[{'attachmentId':'physical','offset':0,'size':len(raw),'sha256':digest}]})
        record=self.archive();before=self.state();self.error(503,lambda:self.v.restore_to_trash(record['id']));self.assertEqual(before,self.state())
        self.error(409,lambda:self.v.restore_to_trash(record['id'],target_storage='blob'))
        # The trusted portable backup loader inserts bytes before installing guards.
        with self.v._transition():self.s.db.execute('INSERT INTO attachment_chunks VALUES(?,?,?)',('cloud',0,raw))
        self.s.db.commit()
        self.v.restore_to_trash(record['id'],target_storage='blob')
        self.assertNotIn('cloud_chunks',self.s.get('attachment','cloud'));self.assertEqual(self.s.chunk_read_range('cloud',0,0,20),raw)
    def test_complete_database_clone_keeps_private_rows_and_reinstalls_guards(self):
        self.file();record=self.archive()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'clone.db';connection=sqlite3.connect(path);self.s.db.backup(connection);connection.close()
            clone=Store(path)
            try:
                vault=RetentionVault(clone);self.assertEqual(vault.records(),self.v.records())
                self.error(409,lambda:clone.chunk_delete('file'))
                vault.restore_to_trash(record['id']);self.assertEqual(clone.get('page','root'),json.loads(self.s.db.execute("SELECT data FROM retention_entities WHERE kind='page'").fetchone()[0]))
                self.assertTrue(self.v.records())
            finally:clone.close()
    def test_child_visibility_after_internal_release_follows_own_acl(self):
        self.s.put('member',{'id':'member','role':'member','active':True})
        self.page('child',parent_id='root',owner_id='member',permissions={'default':'private','inherit':False,'members':{},'groups':{}})
        record=self.archive();self.assertIsNone(self.s.get('page','child'))
        self.v.restore_to_trash(record['id'])
        from fountain.access import Access
        access=Access(self.s,self.s.get('member','member'))
        self.assertTrue(access.can('page',self.s.get('page','child')))
        self.assertTrue(self.s.get('page','root')['archived'])
        self.assertNotIn('archived',self.s.get('page','child'))
    def test_retry_rejects_changed_time_and_invalid_offset(self):
        record=self.archive(record_id='b'*32)
        self.error(409,lambda:self.v.archive_page('root',record_id=record['id'],at='2026-10-17T01:00:01Z'))
        self.error(400,lambda:self.v.archive_page('root',at='2026-10-17T01:00:00+01:60'))
        self.assertIsNone(self.s.list('audit')[0]['user'])

    def test_shared_empty_attachment_metadata_is_pinned_without_physical_rows(self):
        self.page('other',blocks=[{'attachment_id':'empty'}])
        root=self.s.get('page','root');root['blocks']=[{'attachment_id':'empty'}];self.s.put('page',root)
        self.s.put('attachment',{'id':'empty','size':0,'data':''})
        record=self.archive();self.assertEqual(record['counts']['refs'],0);self.assertTrue(self.v.attachment_pinned('empty'))
        self.error(409,lambda:self.s.put('attachment',{'id':'empty','size':1,'data':'YQ=='}))
        with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute("UPDATE entities SET data=? WHERE kind='attachment' AND id='empty'",(json.dumps({'id':'empty','size':1,'data':'YQ=='}),))
        self.s.db.rollback();self.v.restore_to_trash(record['id']);self.assertFalse(self.v.attachment_pinned('empty'))

    def test_overlapping_dependency_journals_and_owned_journal_row_conflict_atomically(self):
        self.page('second',archived=True)
        for name,parent in [('a','root'),('b','second'),('live','external')]:
            if parent=='external':self.page('external',archived=True)
            self.s.put('database',{'id':'db-'+name,'parent_id':parent,'properties':[]})
            self.s.put('row',{'id':name,'database_id':'db-'+name,'properties':{},'depends_on':['a','b'] if name=='live' else []})
        first=self.archive();before=self.state()
        self.error(409,lambda:self.v.archive_page('second'));self.assertEqual(before,self.state())
        self.error(409,lambda:self.v.archive_page('external'));self.assertEqual(before,self.state())
        self.v.restore_to_trash(first['id']);second=self.v.archive_page('second');self.v.restore_to_trash(second['id'])
        self.assertEqual(self.s.get('row','live')['depends_on'],['a','b'])

    def test_live_latent_crdt_only_reference_is_shared_and_real_undo_recovers_bytes(self):
        from fountain import crdt
        from fountain.core import Workspace
        from fountain.collaboration import Collaboration
        from fountain.access import Access
        self.s.set_meta('seeded',True);self.s.set_meta('workspace_id','synthetic-retention-test')
        self.s.put('member',{'id':'human','role':'owner','active':True})
        self.page('live',owner_id='human',revision=1)
        raw=self.file();file=self.s.get('attachment','file');file['owner_id']='human';self.s.put('attachment',file)
        state=crdt.seed_state([{'id':'block','type':'file','text':''}])
        operations=[{'id':'client:1','client':'client','clock':1,'type':'block.set','block_id':'block','field':'attachment_id','value':'file'}, {'id':'client:2','client':'client','clock':2,'type':'block.set','block_id':'block','field':'attachment_id','value':None}]
        state=crdt.apply_operations(state,operations)
        self.assertNotIn('attachment_id',json.dumps(state['history']['baseline']))
        page=self.s.get('page','live');page['blocks']=crdt.project(state);self.s.put('page',page)
        self.s.put('collaboration',{'id':'live','epoch':'stable','seq':2,'state':state,'op_owners':{'client:1':'human','client:2':'human'}})
        record=self.archive();self.assertIsNotNone(self.s.get('attachment','file'))
        with tempfile.TemporaryDirectory() as directory:
            from fountain.backup import create_backup, restore_backup
            source=Path(directory)/'source.db';connection=sqlite3.connect(source);self.s.db.backup(connection);connection.close()
            backup=Path(directory)/'backup.db';path=Path(directory)/'restored.db'
            create_backup(source,backup);restore_backup(backup,path);clone=Store(path)
            try:
                RetentionVault(clone).restore_to_trash(record['id'])
                access=Access(clone,clone.get('member','human'))
                result=Collaboration(clone,Workspace(clone)).apply('live',{'epoch':'stable','ops':[{'id':'client:3','client':'client','clock':3,'type':'history.cancel','targets':['client:2']}]},access)
                self.assertEqual(result['blocks'][0]['attachment_id'],'file')
                self.assertEqual(clone.chunk_read_range('file',0,0,len(raw)),raw)
            finally:clone.close()

    def test_deleted_actual_creator_history_survives_without_inventing_restore_actor(self):
        from fountain.core import CURRENT_ACCESS,AUDIT_ACTOR
        from fountain.access import Access
        self.s.put('member',{'id':'creator','role':'member','active':True})
        access=CURRENT_ACCESS.set(Access(self.s,self.s.get('member','creator')));actor=AUDIT_ACTOR.set('creator')
        try:self.page('created',archived=True,owner_id='creator')
        finally:CURRENT_ACCESS.reset(access);AUDIT_ACTOR.reset(actor)
        before=self.s.db.execute("SELECT * FROM content_provenance WHERE kind='page' AND id='created'").fetchone();self.assertEqual(before[3],'creator')
        self.s.delete('member','creator');record=self.v.archive_page('created');self.v.restore_to_trash(record['id'])
        self.assertEqual(self.s.db.execute("SELECT * FROM content_provenance WHERE kind='page' AND id='created'").fetchone(),before)
        self.assertTrue(all(item['user'] is None for item in self.s.list('audit')))
    def test_other_connection_and_unregistered_raw_connection_cannot_recreate_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'workspace.db';connection=sqlite3.connect(path);self.s.db.backup(connection);connection.close()
            first=Store(path);second=Store(path)
            try:
                record=RetentionVault(first).archive_page('root')
                self.error(409,lambda:second.put('page',{'id':'root'}))
                raw=sqlite3.connect(path)
                try:
                    with self.assertRaises(sqlite3.OperationalError):raw.execute("INSERT INTO entities VALUES('page','root',?, 'x','x')",(json.dumps({'id':'root'}),))
                    raw.rollback()
                finally:raw.close()
                self.assertEqual(RetentionVault(second).records()[0]['id'],record['id'])
            finally:second.close();first.close()

    def test_entity_revision_overflow_during_multiwrite_transition_rolls_back(self):
        self.s.set_meta('_entity_revision',9007199254740990);before=self.state()
        self.error(413,self.archive);self.assertEqual(before,self.state())
        self.s.set_meta('_entity_revision',10);record=self.archive()
        self.s.set_meta('_entity_revision',9007199254740990);before=self.state()
        self.error(413,lambda:self.v.restore_to_trash(record['id']));self.assertEqual(before,self.state())

    def test_external_live_attachment_owner_page_preserves_finalize_before_block_insert(self):
        self.page('owner-page')
        raw=self.file();file=self.s.get('attachment','file');file['page_id']='owner-page';self.s.put('attachment',file)
        self.assertEqual(self.s.get('page','owner-page')['blocks'],[])
        record=self.archive();self.assertIsNotNone(self.s.get('attachment','file'))
        self.assertEqual(self.s.db.execute("SELECT ownership FROM retention_entities WHERE record_id=? AND kind='attachment'",(record['id'],)).fetchone()[0],'shared')
        self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw)
    def test_arbitrary_attachment_named_text_and_nested_metadata_are_not_references(self):
        root=self.s.get('page','root');root['custom']={'attachment_id':'not-an-attachment'};root['blocks']=[{'type':'paragraph','text':'authored','metadata':{'attachment_id':'also-not-an-attachment'}}];self.s.put('page',root)
        self.s.put('database',{'id':'db','parent_id':'root','properties':[{'id':'attachment_id','type':'text'},{'id':'nested','type':'text'}]})
        self.s.put('row',{'id':'r','database_id':'db','properties':{'attachment_id':'human text','nested':{'attachment_id':'nested human text'}}})
        record=self.archive();self.assertEqual(record['counts']['refs'],0)
        self.v.restore_to_trash(record['id']);self.assertEqual(self.s.get('row','r')['properties']['attachment_id'],'human text')
