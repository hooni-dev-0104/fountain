"""Wiki route, ownership and preservation contracts on actual SQLite Application."""
import copy
import unittest
from fountain.core import Store, APIError, AUDIT_ACTOR
from fountain.server import Application

class WikiTests(unittest.TestCase):
    def setUp(self):
        self.store=Store(':memory:');self.app=Application(self.store)
        for identity,role in [('alice','member'),('bob','member'),('guest','guest'),('inactive','member')]:
            self.store.put('member',{'id':identity,'name':identity,'role':role,'active':identity!='inactive'})
        self.root=self.store.put('page',{'id':'wiki-root','title':'지식','parent_id':None,'owner_id':'local','revision':0,'blocks':[{'type':'paragraph','text':'원문'}],
            'permissions':{'default':'private','inherit':False,'groups':{},'members':{'alice':'edit','bob':'edit','guest':'view'}}})
        self.child=self.store.put('page',{**self.root,'id':'child','title':'문서','parent_id':'wiki-root'})
    def tearDown(self):self.store.close()
    def call(self,method,suffix,body=None,actor='local',query=None):
        return self.app.dispatch(method,'/api/pages/'+suffix,body or {},query or {},principal=self.store.get('member',actor))
    def denied(self,status,method,suffix,body=None,actor='local',query=None):
        rows=list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id'))
        with self.assertRaises(APIError) as error:self.call(method,suffix,body,actor,query)
        self.assertEqual(error.exception.status,status)
        self.assertEqual(list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id')),rows)
    def convert(self):return self.call('POST','wiki-root/wiki',{'revision':0})[1]
    def test_conversion_preserves_contents_and_undo_descendants(self):
        self.convert();root=self.store.get('page','wiki-root');self.assertTrue(root['is_wiki']);self.assertEqual(root['revision'],1)
        for key in ['blocks','owner_id','permissions']:self.assertEqual(root[key],self.root[key])
        self.assertEqual(self.store.get('page','child'),self.child)
        self.call('DELETE','wiki-root/wiki',{'revision':1});self.assertFalse(self.store.get('page','wiki-root').get('is_wiki',False));self.assertEqual(self.store.get('page','child'),self.child)

    def test_undo_preserves_private_knowledge_owner_and_verification(self):
        self.convert();self.call('PATCH','child/wiki-owner',{'owner_id':'alice','revision':0})
        self.call('POST','child/verify',{'owners':['alice']},'alice')
        child=self.store.get('page','child');owner=self.store.get('wiki_page','child')
        self.call('DELETE','wiki-root/wiki',{'revision':1})
        self.assertEqual(self.store.get('page','child'),child);self.assertEqual(self.store.get('wiki_page','child'),owner)
        self.assertFalse(self.call('GET','child/wiki-owner')[1]['in_wiki'])
        self.call('POST','wiki-root/wiki',{'revision':2})
        self.assertEqual(self.call('GET','child/wiki-owner')[1]['owner']['id'],'alice')
    def test_cas_permissions_payload_lock_and_standalone_guards(self):
        self.denied(403,'POST','wiki-root/wiki',{'revision':0},'alice')
        for body in [{},{'revision':True},{'revision':-1},{'revision':0,'is_wiki':True}]:self.denied(400,'POST','wiki-root/wiki',body)
        self.denied(409,'POST','wiki-root/wiki',{'revision':9});self.denied(409,'POST','child/wiki',{'revision':0})
        self.store.put('page',{**self.root,'locked':True});self.denied(423,'POST','wiki-root/wiki',{'revision':0})
    def test_creator_sidecar_owner_changes_and_verify_permissions(self):
        self.convert();_,page=self.app.dispatch('POST','/api/pages',{'title':'새 문서','parent_id':'wiki-root'}, {},principal=self.store.get('member','alice'))
        self.assertEqual(self.store.get('wiki_page',page['id'])['owner_id'],'alice');self.assertEqual(page['owner_id'],'alice')
        self.denied(403,'POST',page['id']+'/verify',{},'local')
        verified=self.call('POST',page['id']+'/verify',{'owners':['alice']},'alice')[1]
        self.denied(400,'POST',page['id']+'/verify',{'owners':['alice','bob']},'alice')
        raw=self.store.get('page',page['id']);before_access=self.store.meta('access_revision',0)
        changed=self.call('PATCH',page['id']+'/wiki-owner',{'owner_id':'bob','revision':raw['revision']},'alice')[1]
        self.assertEqual(changed['owner'],{'id':'bob','name':'bob'});after=self.store.get('page',page['id'])
        self.assertEqual(after['owner_id'],'alice');self.assertEqual(after['blocks'],raw['blocks']);self.assertEqual(after['permissions'],raw['permissions']);self.assertEqual(self.store.meta('access_revision',0),before_access)
        self.assertEqual(after['verification']['owners'],['bob'])
        for key in ['verified_at','expires_at','verified_by','cycle_revision']:self.assertEqual(after['verification'][key],raw['verification'][key])
        self.denied(403,'DELETE',page['id']+'/verify',{},'alice');self.call('DELETE',page['id']+'/verify',{},'bob')
    def test_view_projection_query_and_hidden_root_owner(self):
        self.convert();view=self.call('GET','wiki-root/wiki',actor='alice')[1];self.assertEqual(view['total'],1)
        item=view['items'][0];self.assertNotIn('blocks',item);self.assertEqual(item['owner'],{'id':'local','name':'나'})
        self.assertEqual(self.call('GET','wiki-root/wiki',actor='alice',query={'view':['owned']})[1]['total'],0)
        self.assertEqual(self.call('GET','wiki-root/wiki',query={'view':['owned']})[1]['total'],1)
        for query in [{'view':['bad']},{'view':['all','home']},{'limit':['']},{'unknown':['']},{'offset':['01']}]:self.denied(400,'GET','wiki-root/wiki',query=query)
        root=self.store.get('page','wiki-root');root['permissions']['members'].pop('guest');self.store.put('page',root)
        owner=self.call('GET','child/wiki-owner',actor='guest')[1];self.assertIsNone(owner['wiki']);self.assertIsNone(owner['owner']);self.assertEqual(owner['members'],[{'id':'guest','name':'guest'}])
    def test_missing_deleted_cycle_ancestry_and_move_root_guard(self):
        self.convert();self.denied(409,'PATCH','wiki-root',{'parent_id':'notes','revision':1})
        self.store.put('page',{**self.child,'parent_id':'missing'});self.denied(404,'GET','child/wiki-owner')
        self.store.put('page',{**self.child,'parent_id':'child'});self.denied(404,'GET','child/wiki-owner')
        self.store.put('page',self.child);root=self.store.get('page','wiki-root');root['deleted_at']='2026-01-01T00:00:00Z';self.store.put('page',root);self.denied(404,'GET','child/wiki-owner')

    def test_invalid_inherited_ancestry_fails_closed_before_acl_binding(self):
        self.convert()
        for parent in [['wiki-root'],{'id':'wiki-root'},'child','missing']:
            self.store.put('page',{**self.child,'parent_id':parent,'permissions':{'default':'workspace','inherit':True,'members':{},'groups':{}}})
            for suffix in ['wiki-owner','wiki']:
                self.denied(404,'GET','child/'+suffix,actor='alice')
    def test_invalid_verification_not_laundered_and_no_generic_forgery(self):
        self.convert();raw={**self.child,'verification':{'owners':['local',3],'verified_at':'2020-01-01T00:00:00Z','expires_at':False}};self.store.put('page',raw)
        self.call('PATCH','child/wiki-owner',{'owner_id':'alice','revision':0});self.assertEqual(self.store.get('page','child')['verification'],raw['verification'])
        for field in ['is_wiki','wiki_owner','knowledge_owner','wiki_page']:
            self.denied(400,'PATCH','child',{field:True})
            with self.assertRaises(APIError) as error:self.app.dispatch('POST','/api/pages',{'title':'x',field:True},{},principal=self.store.get('member','local'))
            self.assertEqual(error.exception.status,400)
    def test_first_wiki_get_without_settings_domain_writes(self):
        self.store.put('page',{**self.root,'is_wiki':True})
        rows=list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id'));revision=self.store.meta('_entity_revision')
        self.call('GET','wiki-root/wiki');self.assertEqual(list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id')),rows);self.assertEqual(self.store.meta('_entity_revision'),revision);self.assertIsNone(self.app.advanced)
        self.call('GET','child/wiki-owner');self.assertIsNone(self.store.get('settings','workspace'))

    def test_malformed_nested_parent_is_skipped_without_source_repair(self):
        for parent in [[],{},['wiki-root'],{'id':'wiki-root'},False,3]:
            with self.subTest(parent=parent):
                self.store.put('page',{**self.root,'id':'malformed-wiki','is_wiki':True,'parent_id':parent})
                source=self.store.get('page','malformed-wiki')
                self.convert()
                self.assertEqual(self.store.get('page','malformed-wiki'),source)
                self.call('DELETE','wiki-root/wiki',{'revision':1})
                self.store.put('page',self.root)

    def test_ordinary_owner_view_and_access_failure_are_distinct(self):
        value=self.call('GET','child/wiki-owner',actor='alice')[1]
        self.assertEqual(value,{'in_wiki':False,'wiki':None,'owner':None,'members':[],'revision':0,'can_manage':False,'can_verify':True})
        self.denied(404,'GET','missing/wiki-owner')
        self.denied(404,'GET','notes/wiki-owner',actor='guest')
        self.denied(404,'PATCH','child/wiki-owner',{'owner_id':'alice','revision':0})
        self.convert()
        self.assertFalse(self.call('GET','wiki-root/wiki-owner')[1]['in_wiki'])

    def test_nested_boundary_rejects_convert_and_new_membership_follows_moves(self):
        self.store.put('page',{**self.child,'id':'nested','is_wiki':True})
        self.denied(409,'POST','wiki-root/wiki',{'revision':0})
        self.store.delete('page','nested');self.convert()
        self.assertTrue(self.call('GET','child/wiki-owner')[1]['in_wiki'])
        self.call('PATCH','child',{'parent_id':None,'revision':0})
        self.assertFalse(self.call('GET','child/wiki-owner')[1]['in_wiki'])
        self.call('PATCH','child',{'parent_id':'wiki-root','revision':1})
        self.assertTrue(self.call('GET','child/wiki-owner')[1]['in_wiki'])

    def test_owner_assignment_validation_rollback_and_lock(self):
        self.convert()
        for body in [{},{'owner_id':'alice'},{'owner_id':True,'revision':0},{'owner_id':'alice','revision':True},{'owner_id':'alice','revision':0,'unknown':True}]:
            self.denied(400,'PATCH','child/wiki-owner',body)
        self.denied(409,'PATCH','child/wiki-owner',{'owner_id':'alice','revision':1})
        for owner in ['missing','inactive']:
            self.denied(404,'PATCH','child/wiki-owner',{'owner_id':owner,'revision':0})
        self.denied(403,'PATCH','child/wiki-owner',{'owner_id':'alice','revision':0},'guest')
        self.store.put('page',{**self.child,'locked':True});self.denied(423,'PATCH','child/wiki-owner',{'owner_id':'alice','revision':0})

    def test_unreadable_target_cannot_be_assigned_knowledge_ownership(self):
        self.convert();child=self.store.get('page','child');child['permissions']['members'].pop('alice');self.store.put('page',child)
        self.denied(404,'PATCH','child/wiki-owner',{'owner_id':'alice','revision':0})
        self.assertNotIn('alice',[member['id'] for member in self.call('GET','child/wiki-owner')[1]['members']])

    def test_hidden_knowledge_owner_and_valid_verification_are_preserved(self):
        self.convert()
        # A guest with explicit edit cannot see or select another family member.
        child=self.store.get('page','child');child['permissions']['members']['guest']='edit';self.store.put('page',child)
        self.call('POST','child/verify',{'owners':['local']})
        before=self.store.get('page','child');visible=self.call('GET','child/wiki-owner',actor='guest')[1]
        self.assertTrue(visible['in_wiki']);self.assertIsNone(visible['owner']);self.assertFalse(visible['can_verify']);self.assertTrue(visible['can_manage'])
        self.assertEqual(visible['members'],[{'id':'guest','name':'guest'}])
        self.denied(404,'PATCH','child/wiki-owner',{'owner_id':'alice','revision':1},'guest')
        self.denied(403,'POST','child/verify',{},'guest')
        self.call('PATCH','child/wiki-owner',{'owner_id':'guest','revision':1},'guest')
        after=self.store.get('page','child');self.assertEqual(after['verification']['owners'],['guest'])
        for key in ['verified_at','verified_by','expires_at','cycle_revision']:self.assertEqual(after['verification'][key],before['verification'][key])
        self.call('POST','child/verify',{},'guest')

    def test_invalid_private_owner_does_not_fallback_to_acl_owner(self):
        self.convert();self.store.put('wiki_page',{'id':'child','page_id':'wrong','owner_id':'alice'})
        self.assertIsNone(self.call('GET','child/wiki-owner')[1]['owner'])
        self.denied(403,'POST','child/verify',{})
        self.call('PATCH','child/wiki-owner',{'owner_id':'alice','revision':0})
        self.assertEqual(self.call('GET','child/wiki-owner')[1]['owner']['id'],'alice')

    def test_strict_query_pagination_sort_and_projection(self):
        self.convert()
        for i,title in enumerate(['ß','SS','a','A','😀','문서']):
            self.store.put('page',{**self.child,'id':'sort-'+str(i),'title':title,'private':'secret','body':'hidden'})
        result=self.call('GET','wiki-root/wiki',query={'view':['all'],'limit':['2'],'offset':['1']})[1]
        self.assertEqual([v['id'] for v in result['items']],['sort-3','sort-0']);self.assertEqual(result['total'],7);self.assertTrue(result['has_more'])
        allowed={'id','title','icon','parent_id','owner','verification','created_at','updated_at','revision','can_edit','can_verify'}
        self.assertTrue(all(set(item)==allowed for item in result['items']))
        self.assertEqual(self.call('GET','wiki-root/wiki',query={'q':['SS']})[1]['total'],2)
        for query in [{'q':['x'*201]},{'q':['😀'*201]},{'view':[]},{'view':'all'},{'limit':['101']},{'limit':['0']},{'offset':['1000001']},{'offset':['-1']},{'limit':[' 1']},{'limit':['1.0']},{'offset':['1','2']}]:
            self.denied(400,'GET','wiki-root/wiki',query=query)
        self.denied(400,'POST','wiki-root/wiki',{'revision':1},query={'q':['x']})
        self.denied(405,'PUT','wiki-root/wiki',{})
        self.denied(405,'POST','child/wiki-owner',{})

    def test_revoked_or_inactive_owner_cannot_verify_and_no_view_writes(self):
        self.convert();self.call('PATCH','child/wiki-owner',{'owner_id':'alice','revision':0})
        member=self.store.get('member','alice');member['active']=False;self.store.put('member',member)
        source=self.store.get('wiki_page','child');self.assertIsNone(self.call('GET','child/wiki-owner')[1]['owner'])
        self.assertEqual(self.store.get('wiki_page','child'),source)
        self.denied(403,'POST','child/verify',{})

    def test_wiki_flag_is_public_boolean_without_private_sidecar(self):
        self.convert()
        for path in ['/api/workspace','/api/pages/wiki-root','/api/pages/child']:
            value=self.app.dispatch('GET',path,{}, {},principal=self.store.get('member','local'))[1]
            pages=value.get('pages',[value.get('page')])
            self.assertTrue(all(type(page['is_wiki']) is bool for page in pages))
            self.assertNotIn('wiki_page',value)

if __name__=='__main__':unittest.main()
