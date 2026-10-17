"""Real PostgreSQL transfer of generated history, inside an outer rollback."""
import json
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from fountain.activity import ACTIVITY_COLUMNS
from fountain.auth import Auth, SESSION_COOKIE
from fountain.core import Store
from fountain.migrate import MigrationError, migrate_sqlite
from fountain.backup import DEFINITIONS
from fountain.postgres import PostgresStore
from fountain.server import Application


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'), 'Actual PostgreSQL activity schema required')
class ActivityMigrationTests(unittest.TestCase):
    def test_legacy_source_cannot_merge_into_an_existing_private_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();path=root/'legacy.db';namespace='activity-legacy-target-'+uuid.uuid4().hex
            with sqlite3.connect(path) as source:
                for ddl in DEFINITIONS.values():source.execute(ddl)
                source.execute('INSERT INTO meta VALUES(?,?)',('workspace_id',json.dumps(namespace)))
            before=hashlib.sha256(path.read_bytes()).hexdigest()
            target=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id=namespace,attachment_root=root/'files')
            try:
                target._connection.execute('BEGIN')
                with target.transaction():
                    ledger=target._execute('SELECT fountain_private.activity_initialize(%s)',(namespace,),fetch='one')[0]
                    private_before={name:target._execute('SELECT * FROM fountain_private.'+name+' WHERE workspace_id=%s',(namespace,),fetch='all') for name in ('activity_ledgers','activity_runtime')}
                with self.assertRaisesRegex(MigrationError,'Target activity ledger must be empty'):
                    migrate_sqlite(path,target)
                with target.transaction():
                    for name,rows in private_before.items():
                        self.assertEqual(target._execute('SELECT * FROM fountain_private.'+name+' WHERE workspace_id=%s',(namespace,),fetch='all'),rows)
                    self.assertEqual(target._execute('SELECT count(*) FROM fountain_private.entities WHERE workspace_id=%s',(namespace,),fetch='one')[0],0)
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),before)
            finally:
                target._connection.rollback()
                with target.transaction():
                    for name in ('attachment_chunks','entities','meta'):
                        target._execute('DELETE FROM fountain_private.'+name+' WHERE workspace_id=%s',(namespace,))
                target.close()

    def test_trusted_transfer_preserves_historical_facts_and_starts_a_new_capture_epoch(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'FOUNTAIN_ACCESS_TOKEN':''}):
            root=Path(directory).resolve();source=Store(root/'source.db');target=None
            namespace='activity-transfer-'+uuid.uuid4().hex
            try:
                source.set_meta('workspace_id',namespace);source.set_meta('seeded',True)
                source.put('member',{'id':'local','name':'Owner','email':'owner@example.invalid','role':'owner','active':True})
                source.put('teamspace',{'id':'general','name':'General','visibility':'open','members':['local']})
                auth=Auth(source);auth.create_account('local','Generated-activity-transfer-password');auth.enable_accounts()
                cookie=SESSION_COOKIE+'='+auth.login({'email':'owner@example.invalid','password':'Generated-activity-transfer-password'})
                app=Application(source)
                status,page=app.dispatch('POST','/api/pages',{'id':'page','title':'Original 한글','blocks':[]},{},session_cookie=cookie)
                self.assertEqual(status,201)
                app.dispatch('PATCH','/api/pages/page',{'title':'Edited 한글'},{},session_cookie=cookie)
                app.dispatch('GET','/api/pages/page',{}, {},session_cookie=cookie)
                historical={name:list(source.db.execute('SELECT * FROM '+name+(' ORDER BY ledger_id,sequence' if name=='activity_events' else ' ORDER BY id'))) for name in ACTIVITY_COLUMNS}
                self.assertTrue(any(row[9]=='viewed' for row in historical['activity_events']))
                self.assertTrue(any(row[9]=='edited' for row in historical['activity_events']))
                target=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id=namespace,attachment_root=root/'files')
                observed={}
                def before_rollback():
                    epoch=target._execute('SELECT ledger_id FROM fountain_private.activity_runtime WHERE workspace_id=%s',(namespace,),fetch='one')[0]
                    observed['epoch']=epoch
                    self.assertNotIn(epoch,[row[0] for row in historical['activity_ledgers']])
                    with target.transaction():
                        for name,columns in ACTIVITY_COLUMNS.items():
                            if name=='activity_events':
                                rows=target._execute('SELECT '+','.join(columns)+' FROM fountain_private.'+name+' WHERE workspace_id=%s ORDER BY ledger_id COLLATE "C",sequence',(namespace,),fetch='all')
                                self.assertEqual(rows,historical[name])
                        closed=target._execute('SELECT closed_at,close_reason FROM fountain_private.activity_memberships WHERE workspace_id=%s AND ledger_id<>%s',(namespace,epoch),fetch='all')
                        self.assertTrue(closed);self.assertTrue(all(row[0] and row[1]=='restore' for row in closed))
                        count=target._execute('SELECT count(*) FROM fountain_private.activity_events WHERE workspace_id=%s AND ledger_id=%s',(namespace,epoch),fetch='one')[0]
                        self.assertEqual(count,0,'Trusted transfer must not fabricate new creation/edit/view facts')
                    # The original local session remains valid under the existing
                    # explicit server-move contract; it is not imported by portable
                    # backup and is not a real GoTrue login assertion.
                    status,detail=Application(target).dispatch('GET','/api/pages/page',{}, {},session_cookie=cookie)
                    self.assertEqual(status,200);self.assertEqual(detail['page']['title'],'Edited 한글')
                    with target.transaction():
                        new=target._execute('SELECT action,origin,resource_generation,source_sha256 FROM fountain_private.activity_events WHERE workspace_id=%s AND ledger_id=%s ORDER BY sequence',(namespace,epoch),fetch='all')
                        self.assertEqual([row[0] for row in new],['viewed'])
                        self.assertEqual(new[0][1],'human');self.assertEqual(new[0][2],historical['activity_events'][-1][12])
                        self.assertEqual(new[0][3],historical['activity_events'][-1][16])
                # force_rollback uses the real normal root transaction, not a
                # manual outer BEGIN/SAVEPOINT that would change xmin trust.
                driver_transaction=target._connection.transaction
                depth=0
                @contextmanager
                def rollback_transaction(*args,**kwargs):
                    nonlocal depth
                    outer=depth==0;depth+=1
                    try:
                        if outer:kwargs['force_rollback']=True
                        with driver_transaction(*args,**kwargs) as transaction:
                            yield transaction
                            if outer:before_rollback()
                    finally:depth-=1
                with patch.object(target._connection,'transaction',rollback_transaction):
                    result=migrate_sqlite(root/'source.db',target)
                self.assertEqual(result['activity_history']['restore_ledger_id'],observed['epoch'])
                for name,rows in historical.items():
                    self.assertEqual(result['activity_history']['tables'][name]['rows'],len(rows))
            finally:
                if target is not None:
                    target._connection.rollback()
                    with target.transaction():
                        for name in ('attachment_chunks','entities','meta'):
                            target._execute('DELETE FROM fountain_private.'+name+' WHERE workspace_id=%s',(namespace,))
                    target.close()
                source.close()


if __name__=='__main__':unittest.main()
