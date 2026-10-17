"""Real driver checks; provisioning is external and no runtime DDL is allowed."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import MagicMock,patch

from fountain.core import APIError
from fountain.postgres import PostgresStore
from fountain.retention_vault import RetentionVault, VAULT_COLUMNS


class RetentionPostgresProvisioningTests(unittest.TestCase):
    def test_initialization_only_probes_exact_private_columns(self):
        store=MagicMock();store.backend='postgres';vault=RetentionVault(store);vault.initialize()
        sql=[call.args[0] for call in store._execute.call_args_list]
        self.assertEqual(len(sql),6)
        self.assertTrue(all(statement.startswith('SELECT ') and statement.endswith(' WHERE false') for statement in sql))
        self.assertFalse(any(word in ' '.join(sql).upper() for word in ('CREATE ','ALTER ','DROP ','INSERT ','DELETE ','UPDATE ')))
        for statement,(table,columns) in zip(sql,VAULT_COLUMNS.items()):
            self.assertIn('fountain_private.'+table,statement)
            for column in columns:self.assertIn('"'+column+'"',statement)
    def test_unprovisioned_archive_never_writes(self):
        store=MagicMock();store.backend='postgres';store._execute.side_effect=APIError(503,'not provisioned')
        with self.assertRaises(APIError) as caught:RetentionVault(store).archive_page('root')
        self.assertEqual(caught.exception.status,503)
        self.assertEqual(store._execute.call_count,1)
        self.assertIn(' WHERE false',store._execute.call_args.args[0])


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'),'Actual PostgreSQL driver requires FOUNTAIN_TEST_POSTGRES_DSN')
class RetentionPostgresIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.s=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id='fountain-qa-vault-'+uuid.uuid4().hex)
        self.addCleanup(self.s.close)
        # Every fixture, DML operation and derivative write rolls back, even if an
        # assertion fails. No provisioning is attempted from the application.
        self.context=self.s.transaction();self.context.__enter__()
        self.addCleanup(lambda:self.context.__exit__(RuntimeError,RuntimeError('fixture rollback'),None))
        self.v=RetentionVault(self.s)
        self.provisioned=bool(self.s._execute("SELECT to_regclass('fountain_private.retention_records') IS NOT NULL",fetch='one')[0])
    def require_provisioned(self):
        if not self.provisioned:self.skipTest('Retention migration has not been externally provisioned; no runtime DDL attempted')
    def page(self,identity,**values):return self.s.put('page',{'id':identity,'title':identity,'blocks':[],**values})
    def error(self,status,call):
        with self.assertRaises(APIError) as caught:call()
        self.assertEqual(caught.exception.status,status)
    def test_ordinary_store_remains_usable_and_unprovisioned_vault_fails_closed(self):
        self.s.put('example',{'id':'ordinary','value':True});self.assertTrue(self.s.get('example','ordinary')['value'])
        if self.provisioned:self.assertEqual(self.v.records(),[])
        else:
            revision=self.s.meta('_entity_revision');self.error(503,lambda:self.v.archive_page('missing'))
            self.assertEqual(self.s.meta('_entity_revision'),revision)
    def test_full_nested_roundtrip_exact_provenance_and_crdt(self):
        self.require_provisioned();self.page('root',archived=True);self.page('child',parent_id='root')
        self.s.put('database',{'id':'db','parent_id':'child','properties':[]});self.s.put('row',{'id':'row','database_id':'db','properties':{}})
        self.s.put('collaboration',{'id':'child','epoch':'original','state':{'seen':['a']}})
        history=self.s._execute('SELECT kind,id,generation,creator_id,creator_cause,editor_id,edited_at,editor_cause,manager_id,manager_at FROM fountain_private.content_provenance WHERE workspace_id=%s ORDER BY kind,id',(self.s.workspace_id,),fetch='all')
        record=self.v.archive_page('root');self.assertIsNone(self.s.get('page','root'));self.assertIsNone(self.s.get('row','row'))
        self.v.restore_to_trash(record['id']);self.assertTrue(self.s.get('page','root')['archived']);self.assertEqual(self.s.get('collaboration','child')['epoch'],'original')
        self.assertEqual(history,self.s._execute('SELECT kind,id,generation,creator_id,creator_cause,editor_id,edited_at,editor_cause,manager_id,manager_at FROM fountain_private.content_provenance WHERE workspace_id=%s ORDER BY kind,id',(self.s.workspace_id,),fetch='all'))
        self.assertEqual(self.v.records(),[])
    def test_reserved_identity_child_and_blob_boundary_guards(self):
        self.require_provisioned();self.page('root',archived=True,blocks=[{'attachment_id':'file'}]);raw=b'postgres retained bytes'
        self.s.chunk_write('file',0,raw);self.s.put('attachment',{'id':'file','storage':'chunks','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        record=self.v.archive_page('root')
        for callback in (lambda:self.s.put('page',{'id':'root'}),lambda:self.s.put('comment',{'id':'new','page_id':'root'}),lambda:self.s.chunk_delete('file'),lambda:self.s.chunk_write('file',1,b'x')):self.error(409,callback)
        self.assertTrue(self.v.attachment_pinned('file'));self.assertTrue(self.v.identity_reserved('page','root'))
        self.assertTrue(self.v.attachment_pinned('file',storage_kind='blob',offset=0))
        self.assertFalse(self.v.attachment_pinned('file',storage_kind='blob',offset=1))
        self.v.restore_to_trash(record['id']);self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw)
    def test_shared_both_restore_orders_preserve_other_pins(self):
        self.require_provisioned()
        for reverse in (False,True):
            suffix=str(int(reverse));file='file'+suffix;raw=b'shared'
            for name in ('a'+suffix,'b'+suffix):self.page(name,archived=True,blocks=[{'attachment_id':file}])
            self.s.chunk_write(file,0,raw);self.s.put('attachment',{'id':file,'storage':'chunks','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
            records=[self.v.archive_page(name) for name in ('a'+suffix,'b'+suffix)]
            if reverse:records.reverse()
            self.v.restore_to_trash(records[0]['id']);self.assertTrue(self.v.attachment_pinned(file));self.v.restore_to_trash(records[1]['id']);self.assertFalse(self.v.attachment_pinned(file))

    def test_native_file_restore_hashes_physical_bytes_and_atomically_materializes_blob(self):
        self.require_provisioned()
        from fountain.file_chunks import FileChunkStorage
        with tempfile.TemporaryDirectory() as directory:
            storage=FileChunkStorage(self.s,Path(directory).resolve());self.s._files=storage
            try:
                raw=b'n'*4194304
                self.page('root',archived=True,blocks=[{'attachment_id':'file'}])
                self.s.chunk_write('file',0,raw)
                self.s.put('attachment',{'id':'file','storage':'chunks','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
                record=self.v.archive_page('root')
                self.assertEqual(self.s.list('attachment_chunk'),[])
                self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw)
                with patch.object(storage,'_manifest',wraps=storage._manifest) as lookup:
                    for start in range(0,len(raw),65536):self.s.chunk_read_range('file',0,start,min(65536,len(raw)-start))
                    old_lookups=lookup.call_count;self.assertEqual(old_lookups,128,'Previous per-slice Store dispatch resolves info+read manifests')
                with patch.object(storage,'_manifest',wraps=storage._manifest) as lookup:
                    self.v.restore_to_trash(record['id'])
                    new_lookups=lookup.call_count;self.assertEqual(new_lookups,1,'One bounded file chunk read resolves its retained manifest once')
                self.assertEqual(self.s.list('attachment_chunk'),[])
                self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw)
                stored=self.s._execute('SELECT octet_length(data) FROM fountain_private.attachment_chunks WHERE workspace_id=%s AND attachment_id=%s AND "offset"=0',(self.s.workspace_id,'file'),fetch='one')
                self.assertEqual(stored[0],len(raw))
                self.assertEqual(self.v.records(),[])
                if os.environ.get('FOUNTAIN_RETENTION_FILE_PROOF'):
                    path=Path(os.environ['FOUNTAIN_RETENTION_FILE_PROOF']);path.write_text(__import__('json').dumps({'actualPostgres':True,'chunkBytes':len(raw),'oldManifestLookups':old_lookups,'newManifestLookups':new_lookups,'sha256':hashlib.sha256(raw).hexdigest(),'byteExactAfterRestore':True},indent=2)+'\n');path.chmod(0o600)
            finally:storage.close();self.s._files=None


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'),'Actual committed PostgreSQL import requires FOUNTAIN_TEST_POSTGRES_DSN')
class RetentionCommittedImportTests(unittest.TestCase):
    def test_committed_import_parent_cannot_accept_child_in_next_top_transaction(self):
        stores=[];proof={'committedParent':False,'sameConnection':True,'differentTopTransaction':False,'childRejected409':False,'cleanupRows':None}
        try:
            for _ in range(2):stores.append(PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id='fountain-qa-vault-import-'+uuid.uuid4().hex))
            source,target=stores
            with source.transaction():
                source.put('page',{'id':'root','title':'Committed import source','blocks':[],'archived':True})
                record=RetentionVault(source).archive_page('root')
            with target.transaction():
                for table,columns in VAULT_COLUMNS.items():
                    with source._read():rows=source._execute('SELECT '+','.join('"'+name+'"' for name in columns)+' FROM fountain_private.'+table+' WHERE workspace_id=%s',(source.workspace_id,),fetch='all')
                    for row in rows:target._execute('SELECT fountain_cloud.retention_import_row(%s,%s,%s::jsonb)',(target.workspace_id,table,__import__('json').dumps(dict(zip(columns,row)))),fetch='one')
                target._execute('SELECT fountain_cloud.retention_import_finish(%s,%s,true)',(target.workspace_id,record['id']),fetch='one')
                parent_xid=target._execute('SELECT pg_current_xact_id()::text',fetch='one')[0]
            proof['committedParent']=True
            with self.assertRaises(APIError) as caught:
                with target.transaction():
                    child_xid=target._execute('SELECT pg_current_xact_id()::text',fetch='one')[0]
                    self.assertNotEqual(parent_xid,child_xid);proof['differentTopTransaction']=True
                    child={'record_id':record['id'],'kind':'comment','id':'late-child','data':'{"id":"late-child","page_id":"root"}','created_at':'2026-10-17T00:00:00Z','updated_at':'2026-10-17T00:00:00Z','generation':None,'ownership':'owned'}
                    target._execute('SELECT fountain_cloud.retention_import_row(%s,%s,%s::jsonb)',(target.workspace_id,'retention_entities',__import__('json').dumps(child)),fetch='one')
            self.assertEqual(caught.exception.status,409);proof['childRejected409']=True
            with target.transaction():self.assertEqual(target._execute("SELECT count(*) FROM fountain_private.retention_entities WHERE workspace_id=%s AND id='late-child'",(target.workspace_id,),fetch='one')[0],0)
        finally:
            leftovers=0
            for store in stores:
                try:
                    with store.transaction():
                        for record in RetentionVault(store).records():RetentionVault(store).restore_to_trash(record['id'])
                        for table in ('attachment_chunks','entities','meta','content_search_chunks','content_provenance','content_search_documents','content_search_state'):
                            store._execute('DELETE FROM fountain_private.'+table+' WHERE workspace_id=%s',(store.workspace_id,))
                        for table in (*VAULT_COLUMNS,'attachment_chunks','entities','meta','content_search_chunks','content_provenance','content_search_documents','content_search_state'):
                            leftovers+=store._execute('SELECT count(*) FROM fountain_private.'+table+' WHERE workspace_id=%s',(store.workspace_id,),fetch='one')[0]
                finally:store.close()
            proof['cleanupRows']=leftovers
            if os.environ.get('FOUNTAIN_RETENTION_IMPORT_PROOF'):
                path=Path(os.environ['FOUNTAIN_RETENTION_IMPORT_PROOF']);path.write_text(__import__('json').dumps(proof,indent=2)+'\n');path.chmod(0o600)
            self.assertEqual(leftovers,0)
