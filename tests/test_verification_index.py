"""Local Store projection and actual SQLite rollback safety; no cloud claim."""
import copy
import unittest
from fountain.core import Store,APIError
from fountain.access import Access
from fountain.database_verification import DatabaseVerification
from fountain.verification_index import (inbox_store_reader,project_verification_database,project_verification_row,project_verification_index,VERIFICATION_INDEX_META_KEY)


def database():
    return {'id':'db','name':'가족 지식','owner_id':'bob','properties':[
        {'id':'title','type':'title','name':'문서'},
        {'id':'owner','type':'owner','generation':1,'initial_default':'created_by','default':'created_by','limit':'unlimited'},
        {'id':'verification','type':'verification','generation':2,'owner_property_id':'owner'},
        {'id':'body','type':'text'}]}

def row():
    return {'id':'row','database_id':'db','owner_id':'alice','properties':{'title':'문서','owner':['alice'],'body':'secret ordinary body'},'_owner_generations':{'owner':1},'verification':{'generation':2,'verified_by':'alice','verified_at':'2026-10-16T00:00:00Z','expires_at':'2026-10-17T00:00:00Z'},'verification_cycle':3}

class VerificationIndexTests(unittest.TestCase):
    def setUp(self):
        self.store=Store(':memory:');self.store.put('database',database());self.store.put('row',row());self.reader=inbox_store_reader(self.store)
    def tearDown(self):self.store.close()
    def invalid(self,action):
        with self.assertRaises(APIError) as result:action()
        self.assertEqual(result.exception.status,503)
    def test_only_required_fields_are_copied_and_readers_are_detached(self):
        db=database();db['body']='unselected';db['properties'].append({'id':'second-title','type':'title'});r=row();r['properties']['second-title']='not first title';r['verification']['private']='unselected';r['_owner_generations']['private']=7
        value=project_verification_index([db],[r]);self.assertNotIn('body',value['databases'][0]);self.assertNotIn('body',value['rows'][0]['properties']);self.assertNotIn('second-title',value['rows'][0]['properties']);self.assertEqual(value['rows'][0]['_owner_generations'],{'owner':1});self.assertNotIn('private',value['rows'][0]['verification'])
        view=self.reader.get('row','row');view['properties']['owner'].append('forged');self.assertEqual(self.reader.get('row','row')['properties']['owner'],['alice'])
        for method in ('put','delete','set_meta','transaction','commit'):self.assertFalse(hasattr(self.reader,method))
        self.assertIs(inbox_store_reader(self.reader),self.reader)
    def test_null_absent_invalid_trust_values_and_prototype_looking_ids(self):
        db=database();db['properties'][1]['id']='__proto__';db['properties'][2]['owner_property_id']='__proto__';r=row();r['id']='__proto__';r['properties']={'__proto__':['alice'],'title':None};r['_owner_generations']={'__proto__':1,'private':2};r['verification']={'generation':None,'expires_at':None,'verified_by':[]}
        value=project_verification_row(r,project_verification_database(db));self.assertEqual(value['_owner_generations'],{'__proto__':1});self.assertEqual(value['properties'],{'__proto__':['alice'],'title':None});self.assertNotIn('verified_at',value['verification'])
        for malformed in (None,False,7,[],['bad']):
            r['verification']=malformed;r['_owner_generations']=malformed;value=project_verification_row(r,project_verification_database(db));self.assertEqual(value['verification'],malformed);self.assertEqual(value['_owner_generations'],malformed)
        del r['_owner_generations'];self.assertNotIn('_owner_generations',project_verification_row(r,project_verification_database(db)))
        del r['verification'];self.assertIsNone(project_verification_row(r,project_verification_database(db)))
    def test_malformed_pairings_and_ambiguous_descriptors_fail_closed(self):
        for key,value in [('generation',None),('generation',True),('initial_default','unknown'),('default','invalid'),('limit',None)]:
            db=database();db['properties'][1][key]=value;self.invalid(lambda:project_verification_database(db))
        db=database();db['properties'][2]['owner_property_id']='another';self.invalid(lambda:project_verification_database(db))
        db=database();db['properties'].append({'id':'another-owner','type':'owner'});self.invalid(lambda:project_verification_database(db))
        db=database();db['properties'].append({'id':'title','type':'text'});self.invalid(lambda:project_verification_database(db))
        db=database();db['properties']=None;self.invalid(lambda:project_verification_database(db))
        db=database();db['properties']=[p for p in db['properties'] if p['type']!='verification'];self.assertIsNone(project_verification_database(db))
        self.invalid(lambda:project_verification_index([database(),database()],[row()]))
        self.invalid(lambda:project_verification_index([database()],[row(),row()]))
    def test_actual_sqlite_staging_rollback_alternate_branch_and_delete(self):
        self.assertEqual(self.reader.get('row','row')['verification_cycle'],3)
        with self.assertRaisesRegex(RuntimeError,'rollback'):
            with self.store.transaction():
                self.store.put('row',{**self.store.get('row','row'),'verification_cycle':4});self.assertEqual(self.reader.get('row','row')['verification_cycle'],4);raise RuntimeError('rollback')
        self.store.put('row',{**self.store.get('row','row'),'verification_cycle':5});self.assertEqual(self.reader.get('row','row')['verification_cycle'],5)
        with self.assertRaisesRegex(RuntimeError,'rollback'):
            with self.store.transaction():
                self.store.delete('row','row');self.assertEqual(self.reader.list('row'),[]);raise RuntimeError('rollback')
        self.assertEqual(self.reader.get('row','row')['verification_cycle'],5);self.store.delete('row','row');self.assertEqual(self.reader.list('row'),[])
    def test_local_reserved_metadata_ignores_persisted_fake_and_schema_changes_read_through(self):
        self.store.set_meta(VERIFICATION_INDEX_META_KEY,{'databases':[],'rows':[]});self.assertEqual(len(self.reader.meta(VERIFICATION_INDEX_META_KEY)['rows']),1)
        db=self.store.get('database','db');db['name']='새 이름';self.store.put('database',db);self.assertEqual(self.reader.get('database','db')['name'],'새 이름')
        db['properties']=[p for p in db['properties'] if p['type']!='verification'];self.store.put('database',db);self.assertEqual(self.reader.list('row'),[])
    def test_stable_sqlite_generation_builds_one_index_and_metadata_is_detached(self):
        original=self.store.list;calls=[]
        def listing(kind):
            calls.append(kind);return original(kind)
        self.store.list=listing
        for _ in range(1000):self.reader.get('row','row')
        self.assertEqual(calls,['database','row'])
        copy=self.reader.meta(VERIFICATION_INDEX_META_KEY);copy['rows'][0]['properties']['owner'].append('forged');self.assertEqual(self.reader.get('row','row')['properties']['owner'],['alice'])
        with self.assertRaisesRegex(RuntimeError,'rollback'):
            with self.store.transaction():raise RuntimeError('rollback')
        self.reader.get('row','row')
        # No-write rollback keeps the same source; a write rollback is covered
        # separately and total_changes prevents alternate-revision cache reuse.

    def test_assignment_inheritance_and_member_eligibility_share_reader(self):
        alice={'id':'alice','role':'member','active':True};self.store.put('member',alice);self.store.put('member',{'id':'bob','role':'member','active':True})
        self.store.put('page',{'id':'parent','owner_id':'bob','permissions':{'default':'private','members':{'alice':'edit'}}})
        db=database();db['parent_id']='parent';db['permissions']={'default':'private','inherit':True};db['row_permissions']={'mode':'assigned','property_id':'assignee','edit_assigned':True};db['properties'].append({'id':'assignee','type':'person'});self.store.put('database',db)
        r=row();r['properties']['assignee']=['alice'];self.store.put('row',r)
        projected=self.reader.get('row','row');access=Access(self.reader,alice);self.assertTrue(access.can('row',projected,3));self.assertEqual(DatabaseVerification(self.reader,access).owners(self.reader.get('database','db'),projected),['alice'])
        r['properties']['assignee']=['bob'];self.store.put('row',r);self.assertFalse(access.can('row',self.reader.get('row','row')))

if __name__=='__main__':unittest.main()
