"""Trusted v3 must preserve private closure and every retained physical byte."""
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fountain.backup import BackupError, create_backup, restore_backup, inspect_backup
from fountain.core import Store
from fountain.retention_vault import RetentionVault, VAULT_COLUMNS


class RetentionBackupV3Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=Store(self.root/'source.db');self.addCleanup(self.store.close)
        self.vault=RetentionVault(self.store)
    def archive(self):
        blob=b'\0retained-only bytes'+b'x'*65537
        self.store.chunk_write('file',0,blob)
        self.store.put('attachment',{'id':'file','size':len(blob),'storage':'chunks','sha256':hashlib.sha256(blob).hexdigest()})
        for name in ('a','b'):
            self.store.put('page',{'id':name,'archived':True,'title':'private '+name,'blocks':[{'attachment_id':'file'}]})
        records=[self.vault.archive_page(name) for name in ('a','b')]
        return records,blob
    def snapshot(self,connection):
        return {table:connection.execute('SELECT * FROM '+table+' ORDER BY 1,2').fetchall() for table in VAULT_COLUMNS}
    def test_full_roundtrip_keeps_shared_retained_bytes_and_exact_private_history(self):
        records,blob=self.archive();before=self.snapshot(self.store.db)
        backup=self.root/'backup.db';restored=self.root/'restored.db';create_backup(self.store.db,backup)
        with sqlite3.connect(backup) as c:
            self.assertEqual(self.snapshot(c),before)
            self.assertEqual(c.execute("SELECT data FROM attachment_chunks WHERE attachment_id='file'").fetchall(),[(blob,)])
            self.assertEqual(c.execute("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").fetchone()[0],0)
            self.assertEqual(c.execute("SELECT count(*) FROM entities WHERE kind IN('page','attachment')").fetchone()[0],0)
        restore_backup(backup,restored);s=Store(restored)
        try:
            self.assertEqual(self.snapshot(s.db),before)
            vault=RetentionVault(s)
            for record in reversed(records):vault.restore_to_trash(record['id'])
            self.assertEqual(s.chunk_read_range('file',0,0,len(blob)),blob)
            self.assertEqual([p['title'] for p in s.list('page')],['private a','private b'])
        finally:s.close()
    def test_backup_between_shared_restore_steps_keeps_remaining_owned_snapshot(self):
        records,blob=self.archive();self.vault.restore_to_trash(records[0]['id'])
        backup=self.root/'partial.db';create_backup(self.store.db,backup);inspect_backup(backup)
        restored=self.root/'partial-restored.db';restore_backup(backup,restored);s=Store(restored)
        try:
            RetentionVault(s).restore_to_trash(records[1]['id'])
            self.assertEqual(s.chunk_read_range('file',0,0,len(blob)),blob)
        finally:s.close()
    def test_private_injection_schema_reference_and_pins_are_rejected(self):
        self.archive();clean=self.root/'clean.db';create_backup(self.store.db,clean)
        mutations=["UPDATE retention_entities SET kind='session' WHERE kind='page'", "UPDATE retention_entities SET ownership='shared' WHERE kind='page'", "DELETE FROM retention_identity_reservations", "UPDATE retention_provenance SET generation='broken'", "UPDATE retention_attachment_refs SET sha256='"+'0'*64+"'", "UPDATE retention_records SET data=json_set(data,'$.counts.refs',999)", "DELETE FROM attachment_chunks", "CREATE TRIGGER injection AFTER INSERT ON meta BEGIN DELETE FROM entities; END"]
        for n,sql in enumerate(mutations):
            with self.subTest(sql=sql):
                path=self.root/f'bad-{n}.db';path.write_bytes(clean.read_bytes())
                with sqlite3.connect(path) as c:c.execute(sql)
                with self.assertRaises(BackupError):inspect_backup(path)
    def test_matching_counts_cannot_hide_missing_typed_attachment_closure(self):
        self.archive();backup=self.root/'lost-closure.db';create_backup(self.store.db,backup)
        with sqlite3.connect(backup) as c:
            c.execute("DELETE FROM retention_entities WHERE kind='attachment'")
            c.execute("DELETE FROM retention_attachment_refs")
            c.execute("DELETE FROM retention_identity_reservations WHERE kind='attachment'")
            for identity,encoded in c.execute('SELECT id,data FROM retention_records').fetchall():
                value=json.loads(encoded)
                for key,table in [('entities','retention_entities'),('refs','retention_attachment_refs'),('reservations','retention_identity_reservations')]:value['counts'][key]=c.execute('SELECT count(*) FROM '+table+' WHERE record_id=?',(identity,)).fetchone()[0]
                c.execute('UPDATE retention_records SET data=? WHERE id=?',(json.dumps(value),identity))
        with self.assertRaises(BackupError):inspect_backup(backup)
    def test_empty_vault_preserves_legacy_four_table_schema(self):
        self.store.put('page',{'id':'live','blocks':[]});path=self.root/'empty.db';create_backup(self.store.db,path)
        with sqlite3.connect(path) as c:
            self.assertEqual({r[0] for r in c.execute("SELECT name FROM sqlite_schema WHERE type='table'")},{'entities','meta','attachment_chunks','content_provenance'})


import os
import uuid
from fountain.postgres import PostgresStore
from fountain.postgres_backup import create_postgres_backup
from fountain.migrate import MigrationError, migrate_sqlite
from fountain.file_chunks import FileChunkStorage


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'),'Actual PostgreSQL driver requires FOUNTAIN_TEST_POSTGRES_DSN')
class RetentionBackupPostgresV3Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.s=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id='fountain-qa-backup-v3-'+uuid.uuid4().hex);self.addCleanup(self.s.close)
        self.v=RetentionVault(self.s)
        if not self.query("SELECT to_regclass('fountain_private.retention_records') IS NOT NULL AND to_regprocedure('fountain_cloud.retention_import_row(text,text,jsonb)') IS NOT NULL",fetch='one')[0]:self.skipTest('Reviewed retention/import migrations have not been externally provisioned')
        self.addCleanup(self.clear_source)
    def query(self,statement,parameters=(),*,fetch=None):
        with self.s.transaction():return self.s._execute(statement,parameters,fetch=fetch)
    def snapshot(self):
        return {table:self.query('SELECT '+','.join('"'+k+'"' for k in names)+' FROM fountain_private.'+table+' WHERE workspace_id=%s ORDER BY '+','.join(str(i+1) for i in range(len(names))),(self.s.workspace_id,),fetch='all') for table,names in VAULT_COLUMNS.items()}
    def clear_source(self):
        for record in self.v.records():
            cloud=self.query("SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=%s AND record_id=%s AND storage_kind='cloud' LIMIT 1",(self.s.workspace_id,record['id']),fetch='one')
            self.v.restore_to_trash(record['id'],target_storage='blob' if cloud else 'native')
        with self.s.transaction():
            for table in ('attachment_chunks','entities','meta','content_search_chunks','content_provenance','content_search_documents','content_search_state'):
                self.query('DELETE FROM fountain_private.'+table+' WHERE workspace_id=%s',(self.s.workspace_id,))
    def test_pg_file_export_sqlite_and_fresh_filesystem_migrate_preserve_private_history(self):
        self.s._files=FileChunkStorage(self.s,self.root/'old-files')
        self.s.set_meta('workspace_id',self.s.workspace_id);raw=b'\0private native file'+b'x'*65537
        self.s.chunk_write('file',0,raw);self.s.put('attachment',{'id':'file','name':'family.bin','size':len(raw),'storage':'chunks','sha256':hashlib.sha256(raw).hexdigest()})
        for name in ('a','b'):self.s.put('page',{'id':name,'archived':True,'title':'private '+name,'blocks':[{'attachment_id':'file'}]})
        self.query("UPDATE fountain_private.content_provenance SET creator_id='historical creator',creator_cause='human' WHERE workspace_id=%s",(self.s.workspace_id,))
        records=[self.v.archive_page(name) for name in ('a','b')];before=self.snapshot();path=self.root/'portable.db';create_postgres_backup(self.s,path);inspect_backup(path)
        with sqlite3.connect(path) as c:
            for table,names in VAULT_COLUMNS.items():self.assertEqual(c.execute('SELECT * FROM '+table+' ORDER BY '+','.join(str(i+1) for i in range(len(names)))).fetchall(),before[table],table)
            self.assertEqual(c.execute("SELECT data FROM attachment_chunks WHERE attachment_id='file'").fetchall(),[(raw,)])
        restored=self.root/'sqlite.db';restore_backup(path,restored);local=Store(restored)
        try:
            local_v=RetentionVault(local)
            for record in reversed(records):local_v.restore_to_trash(record['id'],target_storage='blob')
            self.assertEqual(local.chunk_read_range('file',0,0,len(raw)),raw)
        finally:local.close()
        self.clear_source();self.s._files.close();self.s._files=None;self.s._files=FileChunkStorage(self.s,self.root/'new-files')
        result=migrate_sqlite(path,self.s);self.assertEqual(result['retention_vault']['retention_records']['count'],2);self.assertEqual(self.snapshot(),before)
        self.assertEqual(self.s.list('attachment_chunk'),[]);self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw)
        self.v.restore_to_trash(records[0]['id']);partial=self.root/'between-restores.db';create_postgres_backup(self.s,partial);inspect_backup(partial)
        self.v.restore_to_trash(records[1]['id']);self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw);self.assertEqual(self.v.records(),[])

    def test_sqlite_origin_blob_vault_migrates_without_changing_microsecond_history(self):
        local=Store(self.root/'sqlite-source.db')
        try:
            local.set_meta('workspace_id',self.s.workspace_id);raw=b'SQLite retained source'
            local.chunk_write('blob',0,raw);local.put('attachment',{'id':'blob','name':'blob.bin','storage':'chunks','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
            local.put('page',{'id':'root','archived':True,'blocks':[{'attachment_id':'blob'}]})
            record=RetentionVault(local).archive_page('root',at='2026-10-17T12:00:00.123456Z')
            path=self.root/'sqlite-origin.db';create_backup(local.db,path)
        finally:local.close()
        self.s._files=FileChunkStorage(self.s,self.root/'sqlite-target-files')
        with self.s.transaction():
            with self.assertRaisesRegex(MigrationError,'top-level'):migrate_sqlite(path,self.s)
        result=migrate_sqlite(path,self.s);self.assertEqual(result['retention_vault']['retention_records']['count'],1)
        self.assertEqual(self.v.records()[0]['retained_at'],record['retained_at']);self.v.restore_to_trash(record['id'])
        self.assertEqual(self.s.chunk_read_range('blob',0,0,len(raw)),raw)

    def test_mixed_blob_and_file_offsets_keep_each_original_physical_pin(self):
        self.s._files=FileChunkStorage(self.s,self.root/'mixed-old');self.s.set_meta('workspace_id',self.s.workspace_id)
        first=b'a'*(4*1024*1024);last=b'end';raw=first+last
        with self.s.transaction():self.query('INSERT INTO fountain_private.attachment_chunks(workspace_id,attachment_id,"offset",data) VALUES (%s,%s,0,%s)',(self.s.workspace_id,'mixed',first))
        self.s.chunk_write('mixed',len(first),last);self.s.put('attachment',{'id':'mixed','name':'mixed.bin','storage':'chunks','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        self.s.put('page',{'id':'root','archived':True,'blocks':[{'attachment_id':'mixed'}]});record=self.v.archive_page('root')
        pins=self.query('SELECT storage_kind,"offset",size,sha256 FROM fountain_private.retention_attachment_refs WHERE workspace_id=%s ORDER BY "offset"',(self.s.workspace_id,),fetch='all');self.assertEqual([(r[0],r[1]) for r in pins],[('blob',0),('file',len(first))])
        path=self.root/'mixed.db';create_postgres_backup(self.s,path);inspect_backup(path);self.clear_source();self.s._files.close();self.s._files=None;self.s._files=FileChunkStorage(self.s,self.root/'mixed-new')
        migrate_sqlite(path,self.s);self.assertEqual(self.query('SELECT storage_kind,"offset",size,sha256 FROM fountain_private.retention_attachment_refs WHERE workspace_id=%s ORDER BY "offset"',(self.s.workspace_id,),fetch='all'),pins)
        self.assertEqual(self.s.chunk_list('mixed'),[(0,len(first),'blob'),(len(first),len(last),'blob')])
        second=self.root/'mixed-reexport.db';create_postgres_backup(self.s,second);inspect_backup(second);self.v.restore_to_trash(record['id']);self.assertEqual(self.s.chunk_read_range('mixed',0,0,len(first)),first);self.assertEqual(self.s.chunk_read_range('mixed',len(first),0,len(last)),last)

    def test_partial_shared_restore_migrate_rearchive_keeps_prior_record(self):
        self.s._files=FileChunkStorage(self.s,self.root/'shared-old');self.s.set_meta('workspace_id',self.s.workspace_id);raw=b'shared retained transport'
        self.s.chunk_write('file',0,raw);self.s.put('attachment',{'id':'file','name':'shared.bin','size':len(raw),'storage':'chunks','sha256':hashlib.sha256(raw).hexdigest()})
        for name in ('a','b'):self.s.put('page',{'id':name,'archived':True,'blocks':[{'attachment_id':'file'}]})
        first,second=[self.v.archive_page(name) for name in ('a','b')];self.v.restore_to_trash(first['id'])
        path=self.root/'partial-shared.db';create_postgres_backup(self.s,path);inspect_backup(path);self.clear_source();self.s._files.close();self.s._files=None;self.s._files=FileChunkStorage(self.s,self.root/'shared-new')
        migrate_sqlite(path,self.s);third=self.v.archive_page('a');self.assertEqual(len(self.v.records()),2)
        self.v.restore_to_trash(second['id']);self.v.restore_to_trash(third['id']);self.assertEqual(self.s.chunk_read_range('file',0,0,len(raw)),raw);self.assertEqual(self.v.records(),[])

    def test_inline_original_cloud_overlay_exports_raw_history_and_complete_portable_bytes(self):
        raw=b'abc';stamp='2026-10-17T12:00:00.123456+00:00';checksum=hashlib.sha256(raw).hexdigest()
        original={'id':'inline','name':'inline.bin','mime':'application/octet-stream','size':3,'storage':'inline','data':'YWJj','sha256':checksum,'created_at':stamp,'updated_at':stamp}
        fields=['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at']
        overlay={key:original[key] for key in fields if key in original};overlay.update(storage='chunks',storage_id='historical-cloud',cloud_chunks=[{'version':1,'attachmentId':'historical-cloud','offset':0,'size':3,'sha256':checksum}],source_fingerprint=json.dumps({key:original.get(key) for key in fields},sort_keys=True,separators=(',',':')))
        self.s.put('page',{'id':'root','archived':True,'blocks':[{'attachment_id':'inline'}]});self.s.put('attachment',original)
        # put assigns current server timestamps, so bind the finalized overlay to
        # the actual immutable source fields rather than the fixture clock.
        original=self.s.get('attachment','inline');overlay.update({key:original[key] for key in fields if key in original});overlay.update(storage='chunks',storage_id='historical-cloud',cloud_chunks=[{'version':1,'attachmentId':'historical-cloud','offset':0,'size':3,'sha256':checksum}],source_fingerprint=json.dumps({key:original.get(key) for key in fields},sort_keys=True,separators=(',',':')))
        self.s.put('attachment_cloud',overlay);self.s.chunk_write('inline',0,raw);record=self.v.archive_page('root');before=self.snapshot();path=self.root/'inline-overlay.db';create_postgres_backup(self.s,path);inspect_backup(path)
        with sqlite3.connect(path) as c:
            for table,names in VAULT_COLUMNS.items():self.assertEqual(c.execute('SELECT * FROM '+table+' ORDER BY '+','.join(str(i+1) for i in range(len(names)))).fetchall(),before[table],table)
            self.assertEqual(c.execute("SELECT data FROM attachment_chunks WHERE attachment_id='inline'").fetchone()[0],raw)
        restored=self.root/'inline-restored.db';restore_backup(path,restored);local=Store(restored)
        try:
            RetentionVault(local).restore_to_trash(record['id'],target_storage='blob');self.assertEqual(local.get('attachment','inline')['data'],'YWJj');self.assertEqual(local.list('attachment_cloud'),[])
        finally:local.close()
