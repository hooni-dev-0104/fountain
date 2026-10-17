"""Focused parent-only header reads without replacing the raw Access store."""
import copy
import unittest
from fountain.core import Store
from fountain.access import Access

class VerificationHeaderTests(unittest.TestCase):
    def setUp(self):
        self.store=Store(':memory:')
        for identity,role,active in [('local','owner',True),('bob','member',True),('guest','guest',True),('inactive','member',False)]:
            self.store.put('member',{'id':identity,'role':role,'name':identity,'active':active})
        self.store.put('page',{'id':'parent','owner_id':'local','parent_id':None,'permissions':{'default':'private','inherit':False,'members':{'bob':'edit'},'groups':{}},'blocks':[{'type':'paragraph','text':'private parent body'}]})
        self.page=self.store.put('page',{'id':'leaf','owner_id':'local','parent_id':'parent','revision':0,'blocks':[{'type':'paragraph','text':'target full body'}],
            'permissions':{'default':'private','inherit':True,'members':{'guest':'view'},'groups':{}},
            'verification':{'owners':['bob'],'owner':'bob','verified_by':'bob','verified_at':'2026-10-16T00:00:00Z','expires_at':None}})
        self.store.put('database',{'id':'db','owner_id':'local','parent_id':'leaf','permissions':{'default':'private','inherit':True,'members':{},'groups':{}},
            'row_permissions':{'mode':'assigned','property_id':'who','edit_assigned':True}})
        self.store.put('row',{'id':'row','database_id':'db','properties':{'who':'bob'}})
    def tearDown(self):self.store.close()
    def access(self,identity='local'):return Access(self.store,self.store.get('member',identity))
    def test_actor_and_verification_acl_parents_use_headers_raw_store_unchanged(self):
        parent_gets=[];original=self.store.get
        def tracked(kind,identity):
            if kind=='page' and identity=='parent':parent_gets.append(identity)
            return original(kind,identity)
        self.store.get=tracked
        owner=self.access();self.assertEqual(owner.project_verification(self.page)['owners'],['bob'])
        member=self.access('bob');self.assertEqual(member.level('page',self.page),3)
        self.assertEqual(member.level('database',self.store.get('database','db')),3);self.assertEqual(member.level('row',self.store.get('row','row')),3)
        self.assertEqual(parent_gets,[]);self.assertIs(owner.store,self.store);self.assertIs(member.store,self.store)
        self.assertEqual(self.store.get('page','leaf'),self.page)
    def test_hidden_guest_inactive_and_unreadable_verifier(self):
        guest=self.access('guest');projected=guest.project_verification(self.page)
        self.assertEqual(projected,{'owners':[],'owner':None,'verified_by':None,'verified_at':'2026-10-16T00:00:00Z','expires_at':None})
        owner=self.access();self.assertFalse(owner.verification_member('inactive',self.page));self.assertFalse(owner.verification_member('missing',self.page))
        member=self.store.get('member','bob');member['active']=False;self.store.put('member',member)
        self.assertIsNone(owner.project_verification(self.page)['verified_at']);self.assertEqual(self.store.get('page','leaf'),self.page)
    def test_same_reader_current_acl_parent_and_rollback_alternate_branch(self):
        owner=self.access();member=self.access('bob');root=self.store.get('page','parent')
        self.assertEqual(owner.project_verification(self.page)['owners'],['bob'])
        with self.assertRaises(ValueError):
            with self.store.transaction():
                denied=copy.deepcopy(root);denied['permissions']['members']['bob']='none';self.store.put('page',denied)
                revision=self.store.meta('_entity_revision');self.assertIsNone(owner.project_verification(self.page)['verified_at']);self.assertEqual(member.level('row',self.store.get('row','row')),0)
                raise ValueError('rollback')
        self.assertEqual(owner.project_verification(self.page)['owners'],['bob'])
        view=copy.deepcopy(root);view['permissions']['members']['bob']='view';self.store.put('page',view)
        self.assertEqual(self.store.meta('_entity_revision'),revision);self.assertEqual(member.level('row',self.store.get('row','row')),1)
        self.assertEqual(owner.project_verification(self.page)['owners'],['bob'])
        moved={**view,'parent_id':'missing','permissions':{'default':'private','inherit':True,'members':{},'groups':{}}};self.store.put('page',moved)
        self.assertIsNone(owner.project_verification(self.page)['verified_at']);self.assertEqual(member.level('page',self.page),0)
        self.store.put('page',root);self.assertEqual(member.level('page',self.page),3)

if __name__=='__main__':unittest.main()
