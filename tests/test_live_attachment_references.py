"""Ordinary attachment deletion preserves values reachable through real CRDT undo."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from fountain.access import Access
from fountain.attachments import FileStorage
from fountain.core import APIError,Store
from fountain.server import Application


class LiveAttachmentReferenceTests(unittest.TestCase):
    def setUp(self):
        self.store=Store(':memory:');self.addCleanup(self.store.close)
        self.app=Application(self.store);self.actor=self.store.get('member','local')
        self.file_id='live-file';self.raw=b'latent attachment bytes\x00\xf0\x9f\x8c\x8a'
        self.store.chunk_write(self.file_id,0,self.raw)
        self.store.put('attachment',{'id':self.file_id,'owner_id':'local','name':'live.bin','storage':'chunks','size':len(self.raw),'sha256':hashlib.sha256(self.raw).hexdigest()})
    def call(self,method,path,body=None,principal=None):
        return self.app.dispatch(method,path,body or {},{},principal=self.actor if principal is None else principal)
    def error(self,status,call):
        with self.assertRaises(APIError) as caught:call()
        self.assertEqual(caught.exception.status,status)
    def latent(self):
        _,page=self.call('POST','/api/pages',{'title':'Latent only','blocks':[{'id':'block','type':'paragraph','text':''}]})
        path='/api/pages/'+page['id'];_,base=self.call('GET',path+'/collaboration')
        operations=[{'id':'client:1','client':'client','clock':1,'type':'block.set','block_id':'block','field':'attachment_id','value':self.file_id},{'id':'client:2','client':'client','clock':2,'type':'block.set','block_id':'block','field':'attachment_id','value':None}]
        self.call('POST',path+'/operations',{'epoch':base['epoch'],'ops':operations})
        self.assertFalse(any(block.get('attachment_id') for block in self.store.get('page',page['id'])['blocks']))
        self.assertFalse(any(block.get('attachment_id') for version in self.store.list('version') for block in version.get('blocks',[])))
        document=self.store.get('collaboration',page['id'])
        self.assertNotIn('attachment_id',json.dumps(document['state']['history']['baseline']))
        self.assertEqual(document['state']['history']['ops']['client:1']['value'],self.file_id)
        return path,base['epoch']
    def test_one_batch_latent_ops_delete_denied_real_undo_bytes_and_release(self):
        path,epoch=self.latent()
        self.error(409,lambda:self.call('DELETE','/api/attachments/'+self.file_id))
        _,undo=self.call('POST',path+'/operations',{'epoch':epoch,'ops':[{'id':'client:3','client':'client','clock':3,'type':'history.cancel','targets':['client:2']}]})
        self.assertEqual(undo['blocks'][0]['attachment_id'],self.file_id)
        self.assertEqual(b''.join(self.app.files.iter_bytes(self.file_id)),self.raw)
        self.call('POST',path+'/operations',{'epoch':epoch,'ops':[{'id':'client:4','client':'client','clock':4,'type':'history.cancel','targets':['client:1']}]})
        self.assertTrue(self.app.files.referenced(self.file_id),'History values remain reachable for redo even after cancellation')
        self.call('PUT',path+'/blocks',{'blocks':[]})
        self.assertFalse(self.app.files.referenced(self.file_id))
        status,result=self.call('DELETE','/api/attachments/'+self.file_id)
        self.assertEqual(status,200);self.assertTrue(result['deleted']);self.assertIsNone(self.store.get('attachment',self.file_id));self.assertEqual(self.store.chunk_list(self.file_id),[])

    def test_each_typed_document_and_crdt_slot_is_referenced(self):
        fixtures=[('page',{'id':'typed','blocks':[{'attachment_id':self.file_id}]}),('version',{'id':'typed','page_id':'welcome','blocks':[{'attachment_id':self.file_id}]}),('collaboration',{'id':'typed','state':{'blocks':{'gone':{'deleted':True,'fields':{'attachment_id':{'value':self.file_id}}}}}}),('collaboration',{'id':'typed','state':{'blocks':{},'history':{'baseline':{'blocks':{'gone':{'fields':{'attachment_id':{'value':self.file_id}}}}},'ops':{}}}}),('collaboration',{'id':'typed','state':{'blocks':{},'history':{'ops':{'one':{'type':'block.set','field':'attachment_id','value':self.file_id}}}}})]
        for kind,body in fixtures:
            with self.subTest(kind=kind,slot=fixtures.index((kind,body))):
                self.store.put(kind,body);self.assertTrue(self.app.files.referenced(self.file_id))
                self.error(409,lambda:self.call('DELETE','/api/attachments/'+self.file_id))
                self.store.delete(kind,'typed');self.assertFalse(self.app.files.referenced(self.file_id))
    def test_row_only_current_schema_files_values_count(self):
        self.store.put('database',{'id':'typed-db','properties':[{'id':'f','type':'files'},{'id':'attachment_id','type':'text'}]})
        self.store.put('row',{'id':'typed-row','database_id':'typed-db','properties':{'f':[self.file_id],'attachment_id':self.file_id}})
        self.assertTrue(self.app.files.referenced(self.file_id))
        db=self.store.get('database','typed-db');db['properties'][0]['type']='text';self.store.put('database',db)
        self.assertFalse(self.app.files.referenced(self.file_id),'Old untyped values are not guessed to be file references')
    def test_similar_strings_unknown_json_slots_and_wrong_operation_types_are_not_references(self):
        self.store.put('page',{'id':'metadata','blocks':[{'type':'paragraph','text':self.file_id,'extension':{'attachment_id':self.file_id}}],'extension':{'attachment_id':self.file_id}})
        self.store.put('collaboration',{'id':'metadata','state':{'blocks':{},'extension':{'attachment_id':self.file_id},'history':{'ops':{'one':{'type':'block.move','field':'attachment_id','value':self.file_id},'two':{'type':'block.set','field':'text','value':self.file_id}}}}})
        self.store.put('database',{'id':'text-db','properties':[{'id':'attachment_id','type':'text'}]})
        self.store.put('row',{'id':'text-row','database_id':'text-db','properties':{'attachment_id':self.file_id,'extension':{'attachment_id':self.file_id}}})
        self.assertFalse(self.app.files.referenced(self.file_id))
        self.assertEqual(self.call('DELETE','/api/attachments/'+self.file_id)[0],200)
    def test_long_unicode_identity_uses_exact_slot_equality(self):
        identity='문'*158+'😀';self.store.chunk_write(identity,0,self.raw)
        self.store.put('attachment',{'id':identity,'owner_id':'local','storage':'chunks','name':'unicode.bin','size':len(self.raw),'sha256':hashlib.sha256(self.raw).hexdigest()})
        self.store.put('collaboration',{'id':'unicode','state':{'history':{'ops':{'one':{'type':'block.set','field':'attachment_id','value':identity}}}}})
        self.assertTrue(self.app.files.referenced(identity));self.assertFalse(self.app.files.referenced(identity[:-1]))
        self.error(409,lambda:self.call('DELETE','/api/attachments/'+identity))
        self.assertEqual(self.store.chunk_read_range(identity,0,0,len(self.raw)),self.raw)
    def test_existing_delete_permission_is_checked_before_reference_probe(self):
        reader=self.store.put('member',{'id':'reader','role':'member','active':True})
        with patch.object(self.app.files,'referenced',side_effect=AssertionError('Private reference probe preceded attachment ACL')):
            self.error(403,lambda:self.call('DELETE','/api/attachments/'+self.file_id,principal=reader))
        self.assertIsNotNone(self.store.get('attachment',self.file_id))
    def test_read_only_predicate_leaves_source_meta_history_unchanged_and_validates_id(self):
        before=(list(self.store.db.execute('SELECT * FROM entities')),list(self.store.db.execute('SELECT * FROM meta')),list(self.store.db.execute('SELECT * FROM content_provenance')))
        self.assertFalse(self.app.files.referenced(self.file_id))
        after=(list(self.store.db.execute('SELECT * FROM entities')),list(self.store.db.execute('SELECT * FROM meta')),list(self.store.db.execute('SELECT * FROM content_provenance')))
        self.assertEqual(before,after)
        for identity in ['', ' '*5,'x'*161,'bad\ud800','bad\x00']:
            self.error(400,lambda identity=identity:self.app.files.referenced(identity))
    def test_invalid_reference_source_fails_closed_before_any_delete(self):
        self.store.put('database',{'id':'bad-db','properties':[{'id':'f','type':'files'}]})
        self.store.put('row',{'id':'bad-row','database_id':'bad-db','properties':{'f':42}})
        self.error(503,lambda:self.call('DELETE','/api/attachments/'+self.file_id))
        self.assertEqual(b''.join(self.app.files.iter_bytes(self.file_id)),self.raw)
    def test_concurrent_real_operation_waits_for_delete_writer_and_cannot_reference_removed_file(self):
        import sqlite3,threading
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'workspace.db';db=sqlite3.connect(path);self.store.db.backup(db);db.close()
            first=Store(path);second=Store(path)
            try:
                app=Application(first);other=Application(second)
                page=app.workspace.create_page({'title':'Race','blocks':[{'id':'block','type':'paragraph','text':''}]})
                base=app.collaboration.snapshot(page['id'],Access(first,first.get('member','local')))
                entered=threading.Event();done=threading.Event();observed=[]
                def write():
                    entered.set()
                    try:other.dispatch('POST','/api/pages/'+page['id']+'/operations',{'epoch':base['epoch'],'ops':[{'id':'race:1','client':'race','clock':1,'type':'block.set','block_id':'block','field':'attachment_id','value':self.file_id}]},{},principal=second.get('member','local'))
                    except APIError as error:observed.append(error.status)
                    finally:done.set()
                original=app.files.referenced;thread=threading.Thread(target=write)
                def fenced(identity):
                    result=original(identity);self.assertFalse(result);thread.start();self.assertTrue(entered.wait(1));self.assertFalse(done.wait(.05),'Concurrent source mutation crossed the workspace writer');return result
                with patch.object(app.files,'referenced',side_effect=fenced):self.assertEqual(app.dispatch('DELETE','/api/attachments/'+self.file_id,{}, {},principal=first.get('member','local'))[0],200)
                thread.join(5);self.assertFalse(thread.is_alive());self.assertEqual(observed,[404]);self.assertFalse(first.get('page',page['id'])['blocks'][0].get('attachment_id'))
            finally:second.close();first.close()


    def test_legacy_single_ids_and_object_ids_are_exact_typed_references(self):
        self.store.put('database',{'id':'legacy','properties':[{'id':'files','type':'files'}]})
        for value in [self.file_id,[self.file_id],[{'id':self.file_id,'name':'Legacy attachment'}]]:
            with self.subTest(value=value):
                self.store.put('row',{'id':'legacy-row','database_id':'legacy','properties':{'files':value}})
                self.assertTrue(self.app.files.referenced(self.file_id));self.assertFalse(self.app.files.referenced(self.file_id[:-1]))
        for value in [None,'',[]]:
            self.store.put('row',{'id':'legacy-row','database_id':'legacy','properties':{'files':value}})
            self.assertFalse(self.app.files.referenced(self.file_id))
    def test_malformed_row_sources_fail_closed_without_provider_diagnostics(self):
        self.store.put('database',{'id':'legacy','properties':[{'id':'files','type':'files'}]})
        for value in [42,True,{},[{}],[' '],[self.file_id,42],['bad\x00']]:
            with self.subTest(value=value):
                self.store.put('row',{'id':'legacy-row','database_id':'legacy','properties':{'files':value}})
                self.error(503,lambda:self.app.files.referenced(self.file_id))
        self.store.delete('row','legacy-row');self.store.put('row',{'id':'missing-db','database_id':'not-present','properties':{}})
        self.error(503,lambda:self.app.files.referenced(self.file_id))
    def test_current_schema_requires_valid_id_and_string_type(self):
        self.store.put('row',{'id':'schema-row','database_id':'schema-db','properties':{}})
        for schema in [None,{},[{}],[{'id':'f'}],[{'id':'f','type':None}],[{'id':1,'type':'files'}],[{'id':' ','type':'text'}]]:
            self.store.put('database',{'id':'schema-db','properties':schema})
            self.error(503,lambda:self.app.files.referenced(self.file_id))

    def test_absent_row_properties_are_empty_present_null_is_invalid(self):
        self.store.put('database',{'id':'legacy','properties':[{'id':'files','type':'files'}]})
        self.store.put('row',{'id':'legacy-row','database_id':'legacy'})
        self.assertFalse(self.app.files.referenced(self.file_id))
        self.store.put('row',{'id':'legacy-row','database_id':'legacy','properties':None})
        self.error(503,lambda:self.app.files.referenced(self.file_id))


    def test_typed_document_containers_fail_closed_and_missing_legacy_slots_are_empty(self):
        bad=[('page',{'blocks':None}),('page',{'blocks':{}}),('page',{'blocks':[None]}),('version',{'blocks':'not-array'}),('page',{'blocks':[{'attachment_id':' '}]}),('collaboration',{'state':{'history':{'ops':{'one':{'type':'block.set','field':'attachment_id','value':' '}}}}}),('collaboration',{'state':None}),('collaboration',{'state':[]}),('collaboration',{'state':{'blocks':[]}}),('collaboration',{'state':{'blocks':{'b':None}}}),('collaboration',{'state':{'blocks':{'b':{'fields':None}}}}),('collaboration',{'state':{'blocks':{'b':{'fields':{'attachment_id':None}}}}}),('collaboration',{'state':{'blocks':{'b':{'fields':{'attachment_id':{}}}}}}),('collaboration',{'state':{'history':None}}),('collaboration',{'state':{'history':{'baseline':[]}}}),('collaboration',{'state':{'history':{'baseline':{'blocks':None}}}}),('collaboration',{'state':{'history':{'ops':[]}}}),('collaboration',{'state':{'history':{'ops':{'one':None}}}}),('collaboration',{'state':{'history':{'ops':{'one':{'type':'block.set','field':'attachment_id'}}}}})]
        for kind,value in bad:
            with self.subTest(kind=kind,value=value):
                self.store.put(kind,{'id':'bad-source',**value})
                self.error(503,lambda:self.app.files.referenced(self.file_id))
                self.store.delete(kind,'bad-source')
        for value in [{},{'state':{}},{'state':{'seen':['legacy-operation']}},{'state':{'history':{'ops':{'one':{'type':'unrelated','extension':{'attachment_id':self.file_id}}}}}}]:
            self.store.put('collaboration',{'id':'legacy-document',**value})
            self.assertFalse(self.app.files.referenced(self.file_id))
        self.store.delete('collaboration','legacy-document')

    def test_row_database_id_is_string_before_sqlite_join_coercion(self):
        self.store.put('database',{'id':'1','properties':[]})
        for value in [1,None,{},[],True,' ']:
            self.store.put('row',{'id':'typed-db-reference','database_id':value,'properties':{}})
            self.error(503,lambda:self.app.files.referenced('unknown-attachment'))
        self.store.put('row',{'id':'typed-db-reference','database_id':'1','properties':{}})
        self.assertFalse(self.app.files.referenced('unknown-attachment'))

@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'),'Actual PostgreSQL scalar requires externally applied helper and Root execution gate')
class LiveAttachmentPostgresTests(unittest.TestCase):
    def setUp(self):
        from fountain.postgres import PostgresStore
        self.store=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id='fountain-qa-live-reference-'+uuid.uuid4().hex);self.addCleanup(self.store.close)
        self.context=self.store.transaction();self.context.__enter__();self.addCleanup(lambda:self.context.__exit__(RuntimeError,RuntimeError('fixture rollback'),None))
        present=self.store._execute("SELECT to_regprocedure('fountain_private.attachment_referenced(text,text)') IS NOT NULL",fetch='one')[0]
        if not present:self.skipTest('Private scalar has not been externally applied; no runtime DDL attempted')
        self.files=FileStorage(self.store)
    def test_actual_boolean_no_body_queries_typed_latent_and_unicode(self):
        identity='문'*158+'😀'
        self.store.put('page',{'id':'large','title':'Scalar source','blocks':[{'text':'x'*4194304}]})
        self.store.put('collaboration',{'id':'large','state':{'blocks':{},'history':{'ops':{'one':{'type':'block.set','field':'attachment_id','value':identity}}}}})
        before=self.store.meta('_entity_revision');execute=self.store._execute
        with patch.object(self.store,'get',side_effect=AssertionError('Scalar read a raw entity')),patch.object(self.store,'list',side_effect=AssertionError('Scalar read raw entity lists')),patch.object(self.store,'_execute',wraps=execute) as calls:
            self.assertTrue(self.files.referenced(identity));self.assertFalse(self.files.referenced(identity[:-1]))
            self.assertEqual(len(calls.call_args_list),2)
            self.assertTrue(all(call.args[0]=='SELECT fountain_private.attachment_referenced(%s,%s)' and call.kwargs=={'fetch':'one'} for call in calls.call_args_list))
        self.assertEqual(before,self.store.meta('_entity_revision'))
    def test_actual_current_row_schema_and_nonreference_json(self):
        self.store.put('database',{'id':'db','properties':[{'id':'f','type':'files'},{'id':'attachment_id','type':'text'}]})
        self.store.put('row',{'id':'row','database_id':'db','properties':{'f':['file'],'attachment_id':'not-file'}})
        self.assertTrue(self.files.referenced('file'));self.assertFalse(self.files.referenced('not-file'))
        self.store.put('collaboration',{'id':'row','state':{'history':{'ops':{'one':{'type':'block.set','field':'text','value':'not-file'}}},'extension':{'attachment_id':'not-file'}}})
        self.assertFalse(self.files.referenced('not-file'))
