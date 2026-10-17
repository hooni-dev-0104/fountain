"""Actual SQLite Inbox rows, source preservation and current authority."""
import copy
import unittest
from datetime import datetime, timezone
from fountain.core import Store, APIError
from fountain.access import Access
from fountain.inbox import Inbox

EXPIRY = '2026-10-17T00:00:00.123456Z'
NOW = datetime(2026, 10, 17, 0, 0, 0, 123456, tzinfo=timezone.utc)

class DatabaseVerificationInboxTests(unittest.TestCase):
    def setUp(self):
        self.s=Store(':memory:')
        for identity,role in [('local','owner'),('alice','member'),('bob','member'),('guest','guest'),('inactive','member')]:
            self.s.put('member',{'id':identity,'name':identity,'role':role,'active':identity!='inactive'})
        self.s.put('teamspace',{'id':'general','visibility':'open','members':['alice','bob'],'groups':[]})
        self.db=self.s.put('database',{'id':'db','name':'Knowledge','icon':'📚','owner_id':'local','teamspace_id':'general',
            'permissions':{'default':'private','inherit':False,'members':{'alice':'edit','bob':'edit','guest':'view'},'groups':{}},
            'row_permissions':{},'properties':[{'id':'name','name':'Name','type':'title'},
             {'id':'notes','name':'Notes','type':'text'},{'id':'assigned','name':'Assigned','type':'person'},
             {'id':'owners','name':'Owner','type':'owner','generation':1,'initial_default':'created_by','default':'created_by','limit':'unlimited'},
             {'id':'verified','name':'Verification','type':'verification','generation':2,'owner_property_id':'owners'}]})
        self.row=self.s.put('row',{'id':'row😀','database_id':'db','owner_id':'alice','properties':{'name':'Current knowledge','notes':'PRIVATE BODY NEVER IN INBOX','assigned':'alice','owners':['alice','guest']},
            '_owner_generations':{'owners':1},'verification':{'generation':2,'verified_by':'local','verified_at':'2026-10-16T00:00:00Z','expires_at':EXPIRY,'private_extra':'never'},'verification_cycle':3,'unknown':'preserve'})
    def tearDown(self):self.s.close()
    def inbox(self,actor='alice'):return Inbox(self.s,Access(self.s,self.s.get('member',actor)),clock=lambda:NOW)
    def listing(self,actor='alice',query=None):return self.inbox(actor).get(query or {})
    def test_exact_expiry_current_recipients_source_and_private_fields(self):
        before=copy.deepcopy((self.s.list('database'),self.s.list('row')))
        v=self.listing();self.assertEqual(v['total'],1);item=v['items'][0]
        self.assertEqual(set(item),{'id','type','resource_type','database_id','row_id','title','icon','verified_at','expires_at','read','archived'})
        self.assertEqual(item['resource_type'],'row');self.assertEqual(item['row_id'],'row😀');self.assertEqual(item['database_id'],'db')
        self.assertEqual(item['title'],'Current knowledge');self.assertEqual(item['expires_at'],EXPIRY)
        self.assertNotIn('PRIVATE BODY',str(v));self.assertNotIn('private_extra',str(v));self.assertNotIn('generation',str(v))
        self.assertEqual(self.listing('guest')['total'],1)
        for actor in ['local','bob','inactive']:self.assertEqual(self.listing(actor)['total'],0)
        self.assertEqual(before,(self.s.list('database'),self.s.list('row')))
    def test_receipts_are_per_member_and_row_unchanged(self):
        identity=self.listing()['items'][0]['id'];before=self.s.get('row','row😀')
        self.inbox().patch(identity,{'read':True});self.assertTrue(self.listing()['items'][0]['read'])
        self.assertFalse(self.listing('guest')['items'][0]['read'])
        self.inbox().patch(identity,{'archived':True});self.assertEqual(self.listing()['total'],0)
        self.assertEqual(self.listing(query={'filter':['archived']})['total'],1)
        self.assertEqual(self.s.get('row','row😀'),before)
        with self.assertRaises(APIError) as e:self.inbox('bob').patch(identity,{'read':True})
        self.assertEqual(e.exception.status,404)
    def test_stale_cycle_generation_acl_assignment_and_deleted_owner(self):
        identity=self.listing()['items'][0]['id']
        changed=copy.deepcopy(self.row);changed['verification_cycle']=4;self.s.put('row',changed)
        self.assertNotEqual(self.listing()['items'][0]['id'],identity)
        with self.assertRaises(APIError) as e:self.inbox().patch(identity,{'read':True})
        self.assertEqual(e.exception.status,404)
        db=copy.deepcopy(self.db);db['properties'][-1]['generation']=3;self.s.put('database',db)
        self.assertEqual(self.listing()['total'],0)
        self.s.put('database',self.db);row=copy.deepcopy(self.row);row['permissions']={'default':'private','members':{},'groups':{}};self.s.put('row',row)
        self.assertEqual(self.listing()['total'],0)
        self.s.put('row',self.row);db=copy.deepcopy(self.db);db['row_permissions']={'mode':'assigned','property_id':'assigned','edit_assigned':True};self.s.put('database',db)
        self.assertEqual(self.listing()['total'],1);self.assertEqual(self.listing('guest')['total'],0)
        self.s.put('database',self.db);member=self.s.get('member','alice');member['active']=False;self.s.put('member',member)
        self.assertEqual(self.listing()['total'],0)
    def test_private_ancestry_uses_current_header_acl_and_no_creator_bypass(self):
        self.s.put('page',{'id':'parent','owner_id':'local','permissions':{'default':'private','inherit':False,'members':{'alice':'edit'},'groups':{}},'blocks':[{'text':'HIDDEN PARENT BODY'}]})
        db=copy.deepcopy(self.db);db['parent_id']='parent';db['permissions']={'default':'private','inherit':True,'members':{},'groups':{}};self.s.put('database',db)
        self.assertEqual(self.listing()['total'],1);self.assertEqual(self.listing('guest')['total'],0)
        parent=self.s.get('page','parent');parent['permissions']['members']={};self.s.put('page',parent)
        self.assertEqual(self.listing()['total'],0)  # row.owner_id does not bypass DB ACL
    def test_nonexpired_indefinite_invalid_and_schema_removal_do_not_notify(self):
        for change in [{'expires_at':None},{'expires_at':'2099-01-01T00:00:00Z'},{'verified_at':False},{'expires_at':False},{'generation':99}]:
            row=copy.deepcopy(self.row);row['verification'].update(change);self.s.put('row',row)
            self.assertEqual(self.listing()['total'],0,change)
        self.s.put('row',self.row)
        for cycle in [False,-1,9007199254740992]:
            self.s.put('row',{**self.row,'verification_cycle':cycle});self.assertEqual(self.listing()['total'],0)
        self.s.put('row',self.row);db=copy.deepcopy(self.db);db['properties']=db['properties'][:3];self.s.put('database',db)
        self.assertEqual(self.listing()['total'],0)
    def test_page_notifications_keep_original_shape_and_mix_pagination(self):
        self.s.put('page',{'id':'page','title':'Page','owner_id':'local','permissions':{'default':'private','inherit':False,'members':{'alice':'view'},'groups':{}},'verification':{'owners':['alice'],'verified_by':'local','verified_at':'2026-10-16T00:00:00Z','expires_at':EXPIRY,'cycle_revision':1}})
        all_items=self.listing()['items'];self.assertEqual(len(all_items),2)
        page=next(x for x in all_items if 'page_id' in x);self.assertNotIn('resource_type',page);self.assertNotIn('row_id',page)
        self.assertEqual(self.listing(query={'limit':['1'],'offset':['1']})['items'],all_items[1:])
