"""Administrator trash restoration preserves contents and separates capabilities from ACLs."""
import http.client
import json
import threading
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from urllib.parse import urlencode

from fountain.access import Access
from fountain.admin_content import AdminContent
from fountain.admin_roles import AdminAuthority, ACTIONS
from fountain.collaboration import Collaboration
from fountain.core import APIError, AUDIT_ACTOR, CURRENT_ACCESS, Store, Workspace
from fountain.crdt import public_state
from fountain.server import create_server


class AdminTrashRestoreTests(unittest.TestCase):
    def setUp(self):
        self.s=Store(':memory:')
        for identity,role in [('owner','owner'),('manager','member'),('reader','member'),('admin','admin')]:
            self.s.put('member',{'id':identity,'role':role,'active':True,'name':identity})
        self.s.set_meta('workspace_id','restore-test')
        self.private={'default':'private','inherit':False,'members':{},'groups':{}}
        self.s.put('teamspace',{'id':'space','active':True})
        self.s.put('page',{'id':'ancestor','title':'Parent','owner_id':'reader','teamspace_id':'space'})
        with self.actor('reader'):
            self.s.put('page',{'id':'trash/秘密😀','title':'Preserve','blocks':[{'id':'b','type':'paragraph','text':'private body','attachment_id':'blob'}],
                'owner_id':'reader','parent_id':'ancestor','teamspace_id':'space','permissions':self.private,'revision':7,
                'archived':True,'deleted':True,'deleted_at':'2026-01-01T00:00:00Z',
                'collaboration':{'clock':9},'arbitrary':{'untouched':True}})
        for kind in ('version','comment','attachment'):
            self.s.put(kind,{'id':kind,'page_id':'trash/秘密😀','payload':{'preserve':kind}})
        self.collaboration=Collaboration(self.s,Workspace(self.s))
        self.collaboration.snapshot('trash/秘密😀',Access(self.s,self.s.get('member','reader')))
        self.s.put('page',{'id':'child','title':'Child','parent_id':'trash/秘密😀','archived':True,'owner_id':'reader','revision':3})
        self.s.put('site',{'id':'published','page_id':'trash/秘密😀','published':True})

    def tearDown(self):self.s.close()
    def api(self,actor='owner'):return AdminContent(self.s,Access(self.s,self.s.get('member',actor)))
    def query(self):return {'kind':['page'],'id':['trash/秘密😀']}
    def review(self,actor='owner'):return self.api(actor).permissions(self.query(),restore=True)
    def body(self,mode='original',actor='owner'):return {'kind':'page','id':'trash/秘密😀','review_revision':self.review(actor)['review_revision'],'mode':mode}
    def error(self,status,call):
        with self.assertRaises(APIError) as caught:call()
        self.assertEqual(caught.exception.status,status)
    @contextmanager
    def actor(self,identity):
        access=Access(self.s,self.s.get('member',identity))
        token=CURRENT_ACCESS.set(access);actor=AUDIT_ACTOR.set(identity)
        try:yield
        finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
    def grant(self,actions,member='manager'):
        owner=AdminAuthority(self.s,Access(self.s,self.s.get('member','owner')))
        role=owner.route('POST','/api/admin/roles',{'name':'Restorer','actions':actions,'revision':owner.overview()['revision']},{})
        owner.route('PUT','/api/admin/assignments/'+member,{'role_ids':[role['created_role_id']],'revision':owner.overview()['revision']},{})
        return role['created_role_id']
    def state(self):
        return {table:list(self.s.db.execute('SELECT * FROM '+table+' ORDER BY 1,2')) for table in
                ('entities','meta','content_provenance','content_search_documents','content_search_chunks','content_search_state')}
    def history(self):return self.s.db.execute("SELECT * FROM content_provenance WHERE kind='page' AND id='trash/秘密😀'").fetchone()

    def test_original_preserves_everything_except_lifecycle_and_publications(self):
        before=self.s.get('page','trash/秘密😀');history=self.history()
        related={kind:self.s.list(kind) for kind in ('version','comment','collaboration','attachment')}
        child=self.s.get('page','child');access=self.s.meta('access_revision',0)
        with self.actor('owner'):self.assertEqual(self.api().restore(self.body()),{'applied':True})
        after=self.s.get('page','trash/秘密😀')
        self.assertFalse(after['archived']);self.assertFalse(after['deleted']);self.assertNotIn('deleted_at',after)
        self.assertEqual(after['revision'],8);self.assertNotEqual(after['updated_at'],before['updated_at'])
        for key,value in before.items():
            if key not in ('archived','deleted','deleted_at','revision','updated_at'):self.assertEqual(after[key],value,key)
        self.assertEqual(self.s.get('page','child'),child)
        for kind,values in related.items():self.assertEqual(self.s.list(kind),values)
        self.assertFalse(self.s.get('site','published')['published'])
        self.assertEqual(self.history()[:8],history[:8]);self.assertEqual(self.history()[8:10],('owner',after['updated_at']))
        self.assertEqual(self.s.meta('access_revision'),access+1)
        self.assertEqual(self.s.list('audit')[-1]['action'],'admin.content.restore_original')

    def test_private_restore_grants_only_selected_page_ownership_and_preserves_editor(self):
        self.grant(['content.search.read','content.restore.manage'])
        before=self.s.get('page','trash/秘密😀');history=self.history();child=self.s.get('page','child')
        with self.actor('manager'):self.api('manager').restore(self.body('private','manager'))
        after=self.s.get('page','trash/秘密😀')
        self.assertEqual((after['owner_id'],after['parent_id'],after['teamspace_id']),('manager',None,None))
        self.assertEqual(after['permissions'],self.private);self.assertEqual(after['blocks'],before['blocks'])
        self.assertEqual(self.history()[:8],history[:8]);self.assertEqual(self.history()[8],'manager')
        self.assertEqual(self.s.get('page','child'),child)
        self.assertTrue(Access(self.s,self.s.get('member','manager')).can('page',after,4))
        self.assertFalse(Access(self.s,self.s.get('member','reader')).can('page',after))
        self.assertTrue(Access(self.s,self.s.get('member','owner')).can('page',after,4))
        self.error(403,lambda:self.api('manager').permissions(self.query()))

    def test_private_restore_keeps_real_collaboration_epoch_but_rechecks_former_owner_acl(self):
        self.grant(['content.search.read','content.restore.manage'])
        before=self.s.get('collaboration','trash/秘密😀')
        self.api('manager').restore(self.body('private','manager'))
        self.assertEqual(self.s.get('collaboration','trash/秘密😀'),before)
        reader=Access(self.s,self.s.get('member','reader'))
        self.error(404,lambda:self.collaboration.snapshot('trash/秘密😀',reader))
        self.error(404,lambda:self.collaboration.apply('trash/秘密😀',{'epoch':before['epoch'],'ops':[]},reader))
        manager=Access(self.s,self.s.get('member','manager'))
        after=self.collaboration.snapshot('trash/秘密😀',manager)
        self.assertEqual(after['epoch'],before['epoch']);self.assertEqual(after['state'],public_state(before['state']))

    def test_restore_capability_neither_grants_body_access_nor_permission_changes(self):
        self.grant(['content.search.read','content.restore.manage'])
        page=self.s.get('page','trash/秘密😀')
        self.assertFalse(Access(self.s,self.s.get('member','manager')).can('page',page))
        review=self.review('manager');self.assertEqual(set(review),{'kind','id','permissions','source_invalid','review_revision'})
        self.assertNotIn('private body',json.dumps(review));self.assertEqual(review['permissions'],self.private)
        self.error(403,lambda:self.api('manager').change({'kind':'page','id':page['id'],'review_revision':review['review_revision'],'operation':'set_private'}))
        self.api('manager').restore(self.body('original','manager'))
        self.assertFalse(Access(self.s,self.s.get('member','manager')).can('page',self.s.get('page',page['id'])))

    def test_role_prerequisite_no_auto_upgrade_and_revocation(self):
        owner=AdminAuthority(self.s,Access(self.s,self.s.get('member','owner')))
        self.error(400,lambda:owner.route('POST','/api/admin/roles',{'name':'Bad','actions':['content.restore.manage'],'revision':owner.overview()['revision']},{}))
        self.grant(['content.search.read','content.permissions.manage','content.publish.manage'])
        self.assertNotIn('content.restore.manage',self.api('manager').authority.actions())
        self.error(403,lambda:self.review('manager'));self.error(403,lambda:self.review('admin'))
        self.grant(['content.search.read','content.restore.manage'])
        body=self.body(actor='manager');owner.route('PUT','/api/admin/assignments/manager',{'role_ids':[],'revision':owner.overview()['revision']},{})
        self.error(403,lambda:self.api('manager').restore(body))
        self.assertIn('content.restore.manage',ACTIONS)

    def test_stale_review_and_source_access_changes_have_no_effect(self):
        for change in ('page','group','teamspace','settings'):
            with self.subTest(change=change):
                body=self.body();self.s.put(change,{'id':'race-'+change,'title':'Changed'})
                before=self.state();self.error(409,lambda:self.api().restore(body));self.assertEqual(self.state(),before)
        body=self.body();self.api().restore(body)
        before=self.state();self.error(409,lambda:self.api().restore(body));self.assertEqual(self.state(),before)

    def test_locked_or_invalid_revision_reject_before_writes(self):
        for patch_value,status in [({'locked':True},423),({'revision':True},409),({'revision':-1},409),({'revision':9007199254740991},409),({'revision':1.0},409),({'revision':1.5},409),({'revision':None},409)]:
            with self.subTest(patch=patch_value):
                page=self.s.get('page','trash/秘密😀');page.update(locked=False,revision=7);page.update(patch_value);self.s.put('page',page)
                body=self.body();before=self.state();self.error(status,lambda:self.api().restore(body));self.assertEqual(self.state(),before)

    def test_trashed_leaf_metadata_exposes_original_active_parent_location(self):
        before=self.state()
        item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
        self.assertEqual(item['status'],'trash')
        self.assertEqual(item['location'],{'kind':'page','id':'ancestor','title':'Parent'})
        self.assertEqual(self.state(),before)
        filtered=self.api().search({'location_kind':['teamspace'],'location_id':['space'],'status':['trash']})
        self.assertIn('trash/秘密😀',{item['id'] for item in filtered['items']})

    def test_trashed_leaf_metadata_never_exposes_unavailable_ancestor_location(self):
        baseline=self.s.get('page','ancestor')
        for update in [{'archived':True},{'archived':0},{'deleted':True},{'deleted':None},{'deleted_at':'date'},
                       {'active':False},{'active':'true'},{'active':1},{'active':None},{'parent_id':'missing'}]:
            with self.subTest(update=update):
                self.s.put('page',{**baseline,**update})
                item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
                self.assertIsNone(item['location'])
                for kind,identity in [('page','ancestor'),('teamspace','space')]:
                    filtered=self.api().search({'location_kind':[kind],'location_id':[identity],'status':['trash']})
                    self.assertNotIn('trash/秘密😀',{item['id'] for item in filtered['items']})
        self.s.delete('page','ancestor')
        item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
        self.assertIsNone(item['location'])

    def test_trashed_leaf_metadata_and_filters_reject_unavailable_teamspace(self):
        baseline=self.s.get('teamspace','space')
        for update in [{'active':False},{'active':'true'},{'active':1},{'active':None},{'archived':True},
                       {'archived':0},{'deleted':True},{'deleted':None},{'deleted_at':'date'}]:
            with self.subTest(update=update):
                self.s.put('teamspace',{**baseline,**update})
                item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
                self.assertIsNone(item['location'])
                for kind,identity in [('page','ancestor'),('teamspace','space')]:
                    filtered=self.api().search({'location_kind':[kind],'location_id':[identity],'status':['trash']})
                    self.assertNotIn('trash/秘密😀',{item['id'] for item in filtered['items']})
        self.s.delete('teamspace','space')
        item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
        self.assertIsNone(item['location'])
        filtered=self.api().search({'location_kind':['teamspace'],'location_id':['space'],'status':['trash']})
        self.assertNotIn('trash/秘密😀',{item['id'] for item in filtered['items']})

    def test_trashed_leaf_location_rejects_missing_or_mismatched_source_behind_index(self):
        with self.s.transaction():
            self.s.db.execute("UPDATE entities SET data=json_set(data,'$.id','mismatch') WHERE kind='page' AND id='ancestor'")
        item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
        self.assertIsNone(item['location'])
        with self.s.transaction():
            self.s.db.execute("DELETE FROM entities WHERE kind='page' AND id='ancestor'")
        item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
        self.assertIsNone(item['location'])
        filtered=self.api().search({'location_kind':['page'],'location_id':['ancestor'],'status':['trash']})
        self.assertNotIn('trash/秘密😀',{item['id'] for item in filtered['items']})

    def test_trashed_leaf_location_checks_project_scalar_from_4mib_parent(self):
        parent=self.s.get('page','ancestor');parent['blocks']=[{'type':'paragraph','text':'x'*(4*1024*1024)}]
        self.s.put('page',parent)
        real_get,real_list=self.s.get,self.s.list
        statements=[]
        def get(kind,identity):
            self.assertNotEqual(kind,'page','Metadata must not transfer any page body')
            return real_get(kind,identity)
        def listing(kind):
            self.assertNotEqual(kind,'page','Metadata must not transfer the page corpus')
            return real_list(kind)
        self.s.db.set_trace_callback(statements.append)
        try:
            with patch.object(self.s,'get',side_effect=get),patch.object(self.s,'list',side_effect=listing):
                item=next(item for item in self.api().search({})['items'] if item['id']=='trash/秘密😀')
                self.assertEqual(item['location'],{'kind':'page','id':'ancestor','title':'Parent'})
                filtered=self.api().search({'location_kind':['page'],'location_id':['ancestor'],'status':['trash']})
                self.assertIn('trash/秘密😀',{item['id'] for item in filtered['items']})
        finally:self.s.db.set_trace_callback(None)
        projections=[statement for statement in statements if "json_type(data,'$.active')" in statement]
        self.assertTrue(projections)
        self.assertTrue(all("SELECT json_type(data,'$.id')='text'" in statement for statement in projections))

    def test_original_rejects_missing_malformed_deleted_and_cyclic_ancestors(self):
        cases=[{'parent_id':'missing'},{'parent_id':''},{'parent_id':False},{'parent_id':[]},{'parent_id':'trash/秘密😀'},
               {'teamspace_id':'missing'},{'teamspace_id':False},{'teamspace_id':{} }]
        baseline=self.s.get('page','trash/秘密😀')
        for update in cases:
            with self.subTest(update=update):
                self.s.put('page',{**baseline,**update});body=self.body();before=self.state()
                self.error(409,lambda:self.api().restore(body));self.assertEqual(self.state(),before)
        self.s.put('page',baseline)
        ancestor=self.s.get('page','ancestor')
        for update in [{'archived':True},{'archived':'false'},{'deleted':True},{'deleted_at':'date'},{'active':False},{'active':'true'},{'is_wiki':'true'},{'parent_id':'trash/秘密😀'},{'parent_id':'missing'},{'teamspace_id':'missing'}]:
            with self.subTest(ancestor=update):
                self.s.put('page',{**ancestor,**update});body=self.body();before=self.state()
                self.error(409,lambda:self.api().restore(body));self.assertEqual(self.state(),before)

    def test_original_rejects_inactive_or_malformed_teamspace_and_private_recovers(self):
        baseline=self.s.get('teamspace','space')
        for update in [{'active':False},{'active':'true'},{'archived':True},{'deleted':True},{'deleted_at':'date'}]:
            with self.subTest(space=update):
                self.s.put('teamspace',{**baseline,**update});body=self.body();before=self.state()
                self.error(409,lambda:self.api().restore(body));self.assertEqual(self.state(),before)
        self.api().restore(self.body('private'))
        self.assertIsNone(self.s.get('page','trash/秘密😀')['teamspace_id'])

    def test_restore_accepts_complete_long_acyclic_chain(self):
        parent=None
        for index in range(70):
            identity='ancestor-'+str(index);self.s.put('page',{'id':identity,'parent_id':parent});parent=identity
        page=self.s.get('page','trash/秘密😀');page['parent_id']=parent;self.s.put('page',page)
        self.api().restore(self.body());self.assertFalse(self.s.get('page','trash/秘密😀')['archived'])

    def test_original_wiki_root_and_malformed_target_lifecycle(self):
        baseline=self.s.get('page','trash/秘密😀')
        for update in [{'is_wiki':True},{'is_wiki':'true'},{'deleted':'true'},{'locked':'false'},{'active':'true'},{'active':False}]:
            with self.subTest(update=update):
                self.s.put('page',{**baseline,**update});body=self.body();before=self.state()
                self.error(409,lambda:self.api().restore(body));self.assertEqual(self.state(),before)
        self.s.put('page',{**baseline,'is_wiki':True,'parent_id':None})
        self.api().restore(self.body())
        self.assertTrue(self.s.get('page','trash/秘密😀')['is_wiki'])

    def test_access_revision_overflow_rolls_back_everything(self):
        self.s.set_meta('access_revision',9007199254740991)
        body=self.body();before=self.state()
        self.error(503,lambda:self.api().restore(body));self.assertEqual(self.state(),before)

    def test_all_1001_sites_unpublish_atomically_and_other_targets_unchanged(self):
        for index in range(1000):self.s.put('site',{'id':str(index),'page_id':'trash/秘密😀','published':True})
        self.s.put('site',{'id':'other','page_id':'ancestor','published':True})
        self.api().restore(self.body())
        self.assertEqual(sum(site['published'] for site in self.s.list('site')),1)
        self.assertTrue(self.s.get('site','other')['published'])

    def test_partial_write_audit_failure_rolls_back_page_sites_index_meta_and_history(self):
        body=self.body();before=self.state()
        with patch.object(self.s,'audit',side_effect=RuntimeError('audit failed')):
            with self.assertRaises(RuntimeError):self.api().restore(body)
        self.assertEqual(self.state(),before)
        real_put=self.s.put
        def fail_site(kind,value):
            if kind=='site':raise RuntimeError('site failed')
            return real_put(kind,value)
        with patch.object(self.s,'put',side_effect=fail_site):
            with self.assertRaises(RuntimeError):self.api().restore(body)
        self.assertEqual(self.state(),before)

    def test_strict_target_body_and_query_validation(self):
        body=self.body()
        for invalid in [{**body,'mode':'purge'},{**body,'kind':'row'},{**body,'extra':1},{key:value for key,value in body.items() if key!='mode'},
                        {**body,'id':[]},{**body,'review_revision':'wrong'},{**body,'mode':[]}]:
            self.error(400,lambda invalid=invalid:self.api().restore(invalid))
        for query in [{'kind':['page'],'id':['trash/秘密😀'],'extra':['1']},{'kind':['page','page'],'id':['trash/秘密😀']},{'kind':['row'],'id':['trash/秘密😀']}]:
            self.error(400,lambda query=query:self.api().permissions(query,restore=True))
        for archived in [False,1,'true',None]:
            page=self.s.get('page','trash/秘密😀');page['archived']=archived;self.s.put('page',page)
            self.error(409,lambda:self.review())


class AdminTrashRestoreHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server=create_server(port=0,db_path=':memory:')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        store=self.server.application.store
        page=store.get('page','welcome');page.update(archived=True,deleted=True,revision=4);store.put('page',page)
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.server.application.store.close()
    def request(self,method,path,body=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        connection.request(method,path,body,{'X-Fountain-Request':'1','Content-Type':'application/json'})
        response=connection.getresponse();result=(response.status,response.read());connection.close();return result
    def test_exact_http_methods_aliases_duplicates_and_bodyless_head(self):
        query=urlencode({'kind':'page','id':'welcome'});route='/api/admin/content/restore'
        for method,path,status in [('HEAD',route+'?'+query,200),('PUT',route,405),('DELETE',route,405),
             ('GET',route+'/?'+query,400),('GET',route+'/alias?'+query,400),('GET',route+'?'+query+'&kind=page',400),
             ('POST',route+'?'+query,400)]:
            actual,data=self.request(method,path,'{}' if method=='POST' else None);self.assertEqual(actual,status,(method,path,data))
            if method=='HEAD':self.assertEqual(data,b'')
        status,data=self.request('GET',route+'?'+query);self.assertEqual(status,200)
        revision=json.loads(data)['review_revision']
        duplicate='{"kind":"page","kind":"page","id":"welcome","mode":"private","review_revision":"'+revision+'"}'
        self.assertEqual(self.request('POST',route,duplicate)[0],400)
        body=json.dumps({'kind':'page','id':'welcome','mode':'private','review_revision':revision})
        status,data=self.request('POST',route,body);self.assertEqual(status,200);self.assertEqual(json.loads(data),{'applied':True})
        self.assertEqual(self.request('POST',route,body)[0],409)
