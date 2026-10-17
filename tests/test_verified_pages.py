"""Verified directory on real SQLite, with read-only projection/ACL contracts."""
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from fountain.core import Store, APIError
from fountain.access import Access
from fountain.verified_pages import VerifiedPages, verified_pages_query

STAMP = '2026-10-17T00:00:00.123000Z'
NOW = datetime.fromisoformat(STAMP)


def fixture(store):
    for identity, role in [('local', 'owner'), ('alice', 'member'), ('bob', 'member'), ('guest', 'guest'), ('inactive', 'member')]:
        store.put('member', {'id': identity, 'name': identity, 'role': role, 'active': identity != 'inactive', 'private': 'never'})
    for identity, members, visibility in [('old', [], 'open'), ('new', ['guest'], 'open'), ('private', [], 'private')]:
        store.put('teamspace', {'id': identity, 'name': identity+' space', 'visibility': visibility, 'members': members, 'groups': [], 'owner_id': 'local'})
    permissions = {'default': 'private', 'inherit': False, 'members': {'alice': 'edit', 'bob': 'view', 'guest': 'view'}, 'groups': {}}
    stamp = {'owners': ['alice', 'bob', 'guest', 'inactive'], 'verified_by': 'local', 'verified_at': '2026-10-16T09:00:00+09:00', 'expires_at': STAMP, 'cycle_revision': 1, 'private': 'never'}
    root = {'id': 'root', 'title': 'Hidden root title', 'owner_id': 'local', 'teamspace_id': 'new', 'permissions': {'default': 'private', 'inherit': False, 'members': {}, 'groups': {}}, 'blocks': [{'text': 'never'}]}
    store.put('page', root)
    store.put('page', {'id': 'page', 'title': 'Straße　Ａ', 'icon': '📚', 'owner_id': 'local', 'parent_id': 'root', 'teamspace_id': 'old', 'permissions': permissions, 'verification': stamp, 'blocks': [{'text': 'never'}]})
    store.put('page', {'id': 'wiki', 'title': 'Wiki', 'icon': None, 'is_wiki': True, 'owner_id': 'local', 'teamspace_id': 'new', 'permissions': permissions, 'verification': {**stamp, 'expires_at': None}})
    store.put('page', {'id': 'hidden', 'title': 'Hidden title', 'owner_id': 'local', 'teamspace_id': 'private', 'permissions': root['permissions'], 'verification': stamp})
    store.put('page', {'id': 'unverified', 'title': 'Unverified', 'owner_id': 'local', 'permissions': permissions})
    store.put('database', {'id': 'db', 'name': 'Database private title', 'icon': '📘', 'owner_id': 'local', 'parent_id': 'root', 'teamspace_id': 'old', 'permissions': permissions, 'row_permissions': {}, 'properties': [
        {'id': 'name', 'name': 'Name', 'type': 'title'}, {'id': 'body', 'name': 'Body', 'type': 'text'}, {'id': 'assigned', 'name': 'Assigned', 'type': 'person'},
        {'id': 'owners', 'name': 'Owner', 'type': 'owner', 'generation': 1, 'initial_default': 'created_by', 'default': 'created_by', 'limit': 'unlimited'},
        {'id': 'proof', 'name': 'Verification', 'type': 'verification', 'generation': 2, 'owner_property_id': 'owners'}]})
    store.put('row', {'id': 'row😀', 'database_id': 'db', 'owner_id': 'local', 'properties': {'name': 'Ａ Row', 'body': 'never', 'assigned': 'alice', 'owners': ['alice', 'bob', 'guest']}, '_owner_generations': {'owners': 1}, 'verification_cycle': 1,
        'verification': {'generation': 2, 'verified_by': 'local', 'verified_at': '2026-10-16T00:00:00Z', 'expires_at': '2026-10-17T00:00:00.123001Z', 'private': 'never'}})


class VerifiedPagesTests(unittest.TestCase):
    def setUp(self):
        self.s = Store(':memory:')
        fixture(self.s)
    def tearDown(self): self.s.close()
    def listing(self, actor='alice', query=None, clock=None):
        return VerifiedPages(self.s, Access(self.s, self.s.get('member', actor)), clock=clock or (lambda: NOW)).get(query or {})
    def test_current_all_readable_resources_projection_and_no_writes(self):
        before = list(self.s.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id'))
        value = self.listing()
        self.assertEqual([x['id'] for x in value['items']], ['row😀', 'page', 'wiki'])
        row, page, wiki = value['items']
        self.assertEqual(row['verification']['status'], 'verified')
        self.assertEqual(page['verification']['status'], 'expired')
        self.assertEqual(wiki['verification']['status'], 'verified')
        self.assertEqual(set(page), {'id','resource_type','title','icon','owners','teamspace','verification','page_id'})
        self.assertEqual(set(row), {'id','resource_type','title','icon','owners','teamspace','verification','database_id','row_id'})
        self.assertEqual(set(row['verification']), {'status','verified_at','expires_at'})
        for secret in ['never', 'generation', 'revision', 'Hidden', 'Database private title', 'permissions', 'inactive']:
            self.assertNotIn(secret, str(value))
        self.assertEqual(before, list(self.s.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id')))
        self.assertEqual(self.listing('inactive')['total'], 0)
    def test_guest_filters_counts_and_options_only_projected(self):
        guest = self.listing('guest')
        self.assertEqual(guest['total'], 3)
        self.assertEqual(guest['filters']['owners'], [{'id':'guest','name':'guest'}])
        self.assertEqual(guest['filters']['teamspaces'], [{'id':'new','name':'new space'}])
        for key, identity in [('owner','alice'), ('owner','inactive'), ('owner','absent'), ('teamspace','private'), ('teamspace','old'), ('teamspace','absent')]:
            value = self.listing('guest', {key:[identity]})
            self.assertEqual(value['total'], 0)
            self.assertEqual(value['filters'], guest['filters'])
        page = self.s.get('page', 'page');page['verification']['owners'] = ['alice'];self.s.put('page', page)
        item = next(item for item in self.listing('guest')['items'] if item['id'] == 'page')
        self.assertEqual(item['owners'], [])
        self.assertEqual(item['verification']['status'], 'expired')
    def test_literal_normalization_filters_and_pagination(self):
        self.assertEqual(self.listing(query={'q':['  STRASSE\u00a0a ']})['items'][0]['id'], 'page')
        self.assertEqual(self.listing(query={'q':['.*']})['total'], 0)
        self.assertEqual(self.listing(query={'status':['expired']})['total'], 1)
        self.assertEqual(self.listing(query={'kind':['row'], 'owner':['bob']})['total'], 1)
        whole = self.listing(); page = self.listing(query={'limit':['1'], 'offset':['1']})
        self.assertEqual(page['items'], whole['items'][1:2]);self.assertTrue(page['has_more']);self.assertEqual(page['total'],3)
        self.assertEqual(self.listing(query={'offset':['999']})['items'], [])
        self.assertEqual(self.listing(query={'q':['nothing']})['filters'], whole['filters'])
    def test_strict_query(self):
        for query in [None, [], {'q':['a','b']}, {'q':'a'}, {'unknown':['x']}, {'__proto__':['x']}, {'status':['Verified']}, {'kind':['database']}, {'owner':['']}, {'teamspace':['x\n']}, {'q':['\0']}, {'q':['\ud800']}, {'q':['😀'*201]}, {'limit':['01']}, {'limit':['0']}, {'limit':['101']}, {'offset':['-1']}, {'offset':['1000001']}, {'offset':['1.0']}, {'offset':['1\n']}]:
            with self.assertRaises(APIError) as error: verified_pages_query(query)
            self.assertEqual(error.exception.status,400,repr(query))
        self.assertEqual(verified_pages_query({'q':['😀'*200]})['q'], '😀'*200)
    def test_structural_move_and_unknown_ancestry_no_stale_fallback(self):
        for item in self.listing()['items']: self.assertEqual(item['teamspace'], {'id':'new','name':'new space'})
        root=self.s.get('page','root');root['teamspace_id']='private';self.s.put('page',root)
        by_id={x['id']:x for x in self.listing()['items']}
        self.assertIsNone(by_id['page']['teamspace']);self.assertIsNone(by_id['row😀']['teamspace'])
        for parent in ['', 'missing', 12, 'page']:
            page=self.s.get('page','page');page['parent_id']=parent;self.s.put('page',page)
            self.assertIsNone(next(x for x in self.listing()['items'] if x['id']=='page')['teamspace'])
        self.s.put('page',{**root,'parent_id':'root'})
        self.assertIsNone(next(x for x in self.listing()['items'] if x['id']=='row😀')['teamspace'])
    def test_depth_exact_limit_and_cross_kind_same_ids(self):
        for number in range(65): self.s.put('page',{'id':str(number),'owner_id':'local','teamspace_id':'new','parent_id':str(number+1) if number<64 else None})
        page=self.s.get('page','page');page['parent_id']='1';self.s.put('page',page)
        self.assertEqual(next(x for x in self.listing()['items'] if x['id']=='page')['teamspace']['id'],'new')
        page['parent_id']='0';self.s.put('page',page)
        self.assertIsNone(next(x for x in self.listing()['items'] if x['id']=='page')['teamspace'])
        self.s.put('page',{'id':'db','owner_id':'local','teamspace_id':'new'})
        db=self.s.get('database','db');db['parent_id']='db';self.s.put('database',db)
        self.assertEqual(next(x for x in self.listing()['items'] if x['resource_type']=='row')['teamspace']['id'],'new')
    def test_current_acl_assignment_archive_invalid_and_stale_generation(self):
        row=self.s.get('row','row😀');db=self.s.get('database','db')
        db['row_permissions']={'mode':'assigned','property_id':'assigned','edit_assigned':True};self.s.put('database',db)
        self.assertEqual(self.listing('guest',{'kind':['row']})['total'],0)
        self.assertEqual(self.listing(query={'kind':['row']})['total'],1)
        self.s.put('database',{**db,'row_permissions':{}})
        for change in [{'archived':True}, {'deleted':True}, {'deleted_at':STAMP}, {'verification':{**row['verification'],'generation':99}}, {'verification':{**row['verification'],'verified_at':False}}, {'verification_cycle':False}, {'properties':{**row['properties'],'owners':['inactive']}}]:
            self.s.put('row',{**row,**change});self.assertEqual(self.listing(query={'kind':['row']})['total'],0)
        self.s.put('row',row);db['properties'][-1]['generation']=3;self.s.put('database',db)
        self.assertEqual(self.listing(query={'kind':['row']})['total'],0)
        db['properties'][-1]['generation']=False;self.s.put('database',db)
        with self.assertRaises(APIError) as error:self.listing()
        self.assertEqual(error.exception.status,503)
    def test_request_clock_equality_and_timezone_microseconds(self):
        value=self.listing(clock=lambda:NOW+timedelta(microseconds=1))
        self.assertEqual(next(x for x in value['items'] if x['resource_type']=='row')['verification']['status'],'expired')
        value=self.listing(clock=lambda:NOW-timedelta(microseconds=1))
        self.assertEqual(next(x for x in value['items'] if x['id']=='page')['verification']['status'],'verified')
    def test_exact_route_bypasses_advanced_and_preserves_parent_access_store(self):
        from fountain.server import Application
        app=Application(self.s)
        before=list(self.s.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id'))
        with patch('fountain.advanced.Advanced', side_effect=AssertionError('stateful Advanced constructed')):
            status,value=app.dispatch('GET','/api/verified-pages',{}, {},principal=self.s.get('member','guest'))
        self.assertEqual(status,200);self.assertEqual(value['total'],3);self.assertIsNone(app.advanced)
        self.assertEqual(before,list(self.s.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id')))
        for path in ['/api/verified-pages/','/api/verified-pages/x']:
            with self.assertRaises(APIError):app.dispatch('GET',path,{}, {},principal=self.s.get('member','guest'))
        for method in ['POST','PUT','PATCH','DELETE','OPTIONS']:
            with self.assertRaises(APIError):app.dispatch(method,'/api/verified-pages',{}, {},principal=self.s.get('member','guest'))
