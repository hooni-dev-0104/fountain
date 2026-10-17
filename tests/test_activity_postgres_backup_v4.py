"""Real PostgreSQL activity+retained bytes exported under one locked cut.

All newly captured private facts stay inside an explicit driver rollback. This
component does not create Auth users or write an existing workspace.
"""
import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from fountain.activity import ACTIVITY_COLUMNS, ACTIVITY_RUNTIME_COLUMNS
from fountain.backup import CHUNK_SIZE, inspect_backup, restore_backup
from fountain.core import Store
from fountain.postgres import PostgresStore
from fountain.postgres_backup import create_postgres_backup
from fountain.retention_vault import RetentionVault


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'), 'Actual PostgreSQL activity schema required')
class ActivityPostgresBackupTests(unittest.TestCase):
    def test_all_history_and_retained_blob_file_union_roundtrip_without_authority(self):
        for physical in ('blob', 'mixed'):
            with self.subTest(physical=physical), tempfile.TemporaryDirectory() as directory:
                root=Path(directory).resolve();namespace='activity-backup-'+uuid.uuid4().hex
                source=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id=namespace,
                                     attachment_root=root/'files' if physical=='mixed' else None)
                try:
                    source._connection.execute('BEGIN')
                    prefix=b'\0'+b'x'*(CHUNK_SIZE-1);tail='가족😀'.encode();whole=prefix+tail
                    with source.transaction():
                        source._execute('INSERT INTO fountain_private.attachment_chunks(workspace_id,attachment_id,"offset",data) VALUES(%s,%s,0,%s)',(namespace,'file',prefix))
                    source.chunk_write('file',CHUNK_SIZE,tail)
                    source.put('attachment',{'id':'file','name':'retained.bin','storage':'chunks','size':len(whole),'sha256':hashlib.sha256(whole).hexdigest()})
                    source.put('page',{'id':'page','title':'원본😀','blocks':[{'attachment_id':'file'}],'archived':True})
                    record=RetentionVault(source).archive_page('page')
                    with source.transaction():
                        historical={}
                        for table,columns in ACTIVITY_COLUMNS.items():
                            order='ledger_id COLLATE "C",sequence' if table=='activity_events' else 'id COLLATE "C"'
                            historical[table]=source._execute('SELECT '+','.join(columns)+' FROM fountain_private.'+table+' WHERE workspace_id=%s ORDER BY '+order,(namespace,),fetch='all')
                        self.assertTrue(historical['activity_events'])
                        before=source._execute('SELECT fountain_private.activity_backup_fence(%s)',(namespace,),fetch='one')[0]
                    path=root/'portable.db';create_postgres_backup(source,path);inspect_backup(path)
                    with sqlite3.connect(path) as portable:
                        tables={r[0] for r in portable.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
                        self.assertEqual(len(tables),14);self.assertFalse(tables&set(ACTIVITY_RUNTIME_COLUMNS))
                        for table in ACTIVITY_COLUMNS:
                            order='ledger_id,sequence' if table=='activity_events' else 'id'
                            self.assertEqual(portable.execute('SELECT * FROM '+table+' ORDER BY '+order).fetchall(),historical[table])
                        self.assertEqual(portable.execute('SELECT data FROM attachment_chunks ORDER BY "offset"').fetchall(),[(prefix,),(tail,)])
                        kinds={r[0] for r in portable.execute('SELECT storage_kind FROM retention_attachment_refs')}
                        self.assertEqual(kinds,{'blob','file'} if physical=='mixed' else {'blob'})
                    with source.transaction():
                        self.assertEqual(source._execute('SELECT fountain_private.activity_backup_fence(%s)',(namespace,),fetch='one')[0],before)
                    restored=root/'restored.db';restore_backup(path,restored);target=Store(restored)
                    try:
                        self.assertEqual(target.db.execute('SELECT * FROM activity_events ORDER BY ledger_id,sequence').fetchall(),historical['activity_events'])
                        self.assertEqual(target.db.execute('SELECT count(*) FROM activity_current_accounts').fetchone(),(0,))
                        RetentionVault(target).restore_to_trash(record['id'],target_storage='blob')
                        self.assertEqual(target.chunk_read_range('file',0,0,len(prefix)),prefix)
                        self.assertEqual(target.chunk_read_range('file',CHUNK_SIZE,0,len(tail)),tail)
                        self.assertEqual(target.get('page','page')['title'],'원본😀')
                    finally:target.close()
                finally:
                    source._connection.rollback()
                    # Root binding is the only constructor write before BEGIN.
                    # No activity epochs/events were committed by this fixture.
                    with source.transaction():
                        for table in ('attachment_chunks','entities','meta'):
                            source._execute('DELETE FROM fountain_private.'+table+' WHERE workspace_id=%s',(namespace,))
                    source.close()


if __name__=='__main__':unittest.main()
