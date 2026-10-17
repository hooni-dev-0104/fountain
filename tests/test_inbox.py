"""Inbox derivation and receipt tests on actual SQLite/Access, without cloud I/O."""
import copy
import unittest
from datetime import datetime, timezone
from fountain.core import Store, Workspace, APIError, AUDIT_ACTOR, CURRENT_ACCESS
from fountain.advanced import Advanced
from fountain.authorization import Authorization
from unittest.mock import patch
from fountain.access import Access
from fountain.inbox import Inbox

STAMP = '2026-10-17T00:00:00.123456Z'
NOW = datetime(2026, 10, 17, 0, 0, 0, 123456, tzinfo=timezone.utc)

class InboxTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        for identity, role in [('local','owner'), ('alice','member'), ('bob','member'), ('guest','guest'), ('inactive','member')]:
            self.store.put('member', {'id':identity, 'role':role, 'active':identity!='inactive'})
        self.page = self.store.put('page', {'id':'page', 'title':'검증 문서', 'icon':'📘', 'revision':4,
            'owner_id':'local', 'blocks':[{'text':'not-in-inbox'}],
            'permissions':{'default':'private','inherit':False,'groups':{},'members':{'alice':'edit','guest':'view'}},
            'verification':{'owners':['alice','guest'], 'owner':'alice', 'verified_by':'local',
                'verified_at':'2026-10-16T00:00:00Z','expires_at':STAMP, 'cycle_revision':4}})
    def tearDown(self): self.store.close()
    def inbox(self, actor='alice'): return Inbox(self.store, Access(self.store,self.store.get('member',actor)), clock=lambda:NOW)
    def listing(self, actor='alice', query=None): return self.inbox(actor).get(query or {})
    def test_derived_recipient_privacy_and_exact_expiry(self):
        before=self.store.get('page','page'); result=self.listing()
        self.assertEqual(result['total'],1);self.assertEqual(result['unread_count'],1)
        item=result['items'][0];self.assertRegex(item['id'],r'^[a-f0-9]{64}$')
        self.assertEqual(set(item),{'id','type','page_id','title','icon','verified_at','expires_at','read','archived'})
        self.assertEqual(item['expires_at'],STAMP);self.assertNotIn('not-in-inbox',str(result))
        self.assertEqual(self.listing('local')['total'],0) # owner is not an assignee
        self.assertEqual(self.listing('bob')['total'],0)
        self.assertEqual(self.listing('guest')['total'],1)
        self.assertEqual(self.listing('inactive')['total'],0)
        self.assertEqual(self.store.get('page','page'),before);self.assertEqual(self.store.list('inbox_receipt'),[])
        self.store.put('page',{**self.page,'verification':{**self.page['verification'],'cycle_revision':4.0}})
        self.assertEqual(self.listing()['items'][0]['id'],item['id'])
    def test_receipts_persist_per_member_and_archive_unread_filters(self):
        identity=self.listing()['items'][0]['id'];before=self.store.get('page','page')
        self.inbox().patch(identity,{'read':True})
        self.assertTrue(self.inbox().get({})['items'][0]['read'])
        self.assertEqual(self.listing(query={'filter':['unread']})['total'],0)
        self.assertFalse(self.listing('guest')['items'][0]['read'])
        self.inbox().patch(identity,{'read':False,'archived':True})
        self.assertEqual(self.listing()['total'],0);self.assertEqual(self.listing()['unread_count'],0)
        self.assertEqual(self.listing(query={'filter':['archived']})['total'],1)
        self.inbox().patch(identity,{'archived':False})
        self.assertEqual(self.listing()['unread_count'],1);self.assertEqual(len(self.store.list('inbox_receipt')),1)
        self.assertEqual(self.store.get('page','page'),before)
    def test_stale_event_and_fresh_acl_rechecks(self):
        identity=self.listing()['items'][0]['id'];original=copy.deepcopy(self.page)
        for actor in ['local','bob']:
            with self.assertRaises(APIError) as error:self.inbox(actor).patch(identity,{'read':True})
            self.assertEqual(error.exception.status,404)
        for change in [{'verification':None},{'archived':True},{'deleted_at':'2026-10-17T00:00:00Z'},{'verification':{**original['verification'],'owners':['guest']}},
                       {'permissions':{'default':'private','inherit':False,'groups':{},'members':{}}},
                       {'verification':{**original['verification'],'expires_at':'2099-01-01T00:00:00Z'}}]:
            self.store.put('page',{**original,**change})
            with self.assertRaises(APIError) as error:self.inbox().patch(identity,{'read':True})
            self.assertEqual(error.exception.status,404);self.assertEqual(self.store.list('inbox_receipt'),[])
        self.store.put('page',original);self.inbox().patch(identity,{'read':True})
        self.store.put('page',{**original,'revision':9,'title':'내용만 수정'})
        self.assertTrue(self.listing()['items'][0]['read'])
        self.store.put('page',{**original,'verification':{**original['verification'],'cycle_revision':5}})
        self.assertNotEqual(self.listing()['items'][0]['id'],identity)
        self.assertFalse(self.listing()['items'][0]['read']);self.assertEqual(len(self.store.list('inbox_receipt')),1)
    def test_strict_query_body_and_ids(self):
        for query in [{'filter':['all','unread']},{'limit':['0']},{'limit':['101']},{'limit':['01']},
                      {'offset':['-1']},{'offset':['1000001']},{'unknown':['x']},{'filter':['ALL']},{'filter':['']},{'unknown':['']},{'filter':['all','']},{'__proto__':['x']}]:
            with self.assertRaises(APIError) as error:self.listing(query=query)
            self.assertEqual(error.exception.status,400)
        identity=self.listing()['items'][0]['id']
        for body in [{},{'read':1},{'archived':None},{'read':True,'member_id':'guest'},[],None]:
            with self.assertRaises(APIError) as error:self.inbox().patch(identity,body)
            self.assertEqual(error.exception.status,400)
        for identity in ['x','A'*64,'__proto__']:
            with self.assertRaises(APIError) as error:self.inbox().patch(identity,{'read':True})
            self.assertEqual(error.exception.status,400)
    def test_invalid_original_and_future_no_notifications(self):
        for change in [{'expires_at':None},{'expires_at':False},{'expires_at':'2099-01-01T00:00:00Z'},
                       {'expires_at':'2026-10-17T00:00:00.123457Z'}, {'owners':['alice',3]},
                       {'verified_at':False},{'owners':[]},{'cycle_revision':False}]:
            self.store.put('page',{**self.page,'verification':{**self.page['verification'],**change}})
            self.assertEqual(self.listing()['total'],0,change)
    def test_stable_sort_and_pagination(self):
        for identity in ['z','a']:
            self.store.put('page',{**self.page,'id':identity,'verification':{**self.page['verification'],'expires_at':'2026-10-16T23:00:00Z'}})
        full=self.listing();first=self.listing(query={'limit':['1']})
        self.assertEqual(full['items'][0]['page_id'],'page');self.assertEqual(first['total'],3)
        self.assertEqual([item['id'] for item in full['items'][1:]],sorted(item['id'] for item in full['items'][1:]))
        self.assertTrue(first['has_more']);self.assertEqual(first['items'],full['items'][:1])
        self.assertEqual(self.listing(query={'offset':['3']})['items'],[])

    def test_route_and_same_clock_new_verification_cycle_is_private(self):
        access=Access(self.store,self.store.get('member','alice'))
        actor=AUDIT_ACTOR.set('alice');current=CURRENT_ACCESS.set(access)
        try:
            advanced=Advanced(self.store,Workspace(self.store));guard=Authorization(access)
            guard.prepare('GET','/api/inbox',{})
            self.assertEqual(advanced.dispatch('GET','/api/inbox',{}, {})[1]['total'],1)
            for query in [{'filter':['']},{'unknown':['']},{'filter':['all','']}]:
                with self.assertRaises(APIError):advanced.dispatch('GET','/api/inbox',{},query)
            with patch('fountain.advanced.now',return_value='2026-10-17T00:00:00Z'):
                advanced.dispatch('POST','/api/pages/page/verify',{'owners':['alice'],'expires_at':'2099-01-01T00:00:00Z'}, {})
                first=self.store.get('page','page')
                self.assertEqual(first['verification']['cycle_revision'],5)
                self.assertNotIn('cycle_revision',guard.project('/api/pages/page',{'page':first})['page']['verification'])
                future=lambda:datetime(2099,1,2,tzinfo=timezone.utc)
                inbox=Inbox(self.store,access,clock=future);identity=inbox.get({})['items'][0]['id'];inbox.patch(identity,{'read':True})
                advanced.dispatch('POST','/api/pages/page/verify',{'owners':['alice'],'expires_at':'2099-01-01T00:00:00Z'}, {})
                second=inbox.get({})['items'][0]
                self.assertNotEqual(second['id'],identity);self.assertFalse(second['read'])
                with self.assertRaises(APIError) as error:inbox.patch(identity,{'read':True})
                self.assertEqual(error.exception.status,404)
        finally:CURRENT_ACCESS.reset(current);AUDIT_ACTOR.reset(actor)

    def test_application_first_inbox_without_settings_has_no_get_domain_writes(self):
        from fountain.server import Application
        page={**self.page,'verification':{**self.page['verification'],
            'verified_at':'2019-01-01T00:00:00Z','expires_at':'2020-01-01T00:00:00Z'}}
        self.store.put('page',page)
        app=Application(self.store)
        self.assertIsNone(self.store.get('settings','workspace'))
        principal=self.store.get('member','alice')
        entities=list(self.store.db.execute('SELECT kind,id,data,created_at,updated_at FROM entities ORDER BY kind,id'))
        revision=self.store.meta('_entity_revision')
        status,result=app.dispatch('GET','/api/inbox',{}, {},principal=principal)
        self.assertEqual(status,200);self.assertEqual(result['total'],1)
        self.assertEqual(list(self.store.db.execute('SELECT kind,id,data,created_at,updated_at FROM entities ORDER BY kind,id')),entities)
        self.assertEqual(self.store.meta('_entity_revision'),revision)
        self.assertIsNone(app.advanced);self.assertIsNone(self.store.get('settings','workspace'))
        # PATCH is also a first Application request; only its private receipt may change.
        app=Application(self.store);identity=result['items'][0]['id']
        before_page=self.store.get('page','page');before_audit=self.store.list('audit')
        status,item=app.dispatch('PATCH','/api/inbox/'+identity,{'read':True}, {},principal=principal)
        self.assertEqual(status,200);self.assertTrue(item['read'])
        self.assertEqual(self.store.meta('_entity_revision'),revision+1)
        self.assertEqual(len(self.store.list('inbox_receipt')),1)
        self.assertEqual(self.store.get('page','page'),before_page);self.assertEqual(self.store.list('audit'),before_audit)
        self.assertIsNone(app.advanced);self.assertIsNone(self.store.get('settings','workspace'))
        # Preserve the pre-existing lazy defaults for the actual advanced route.
        status,_=app.dispatch('GET','/api/advanced',{}, {},principal=principal)
        self.assertEqual(status,200);self.assertIsNotNone(app.advanced)
        self.assertIsNotNone(self.store.get('settings','workspace'))

if __name__=='__main__':unittest.main()
