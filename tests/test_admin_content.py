"""Administrator search is a separate capability, never an ordinary ACL grant."""
import csv
import io
import json
import tempfile
import unittest
from unittest.mock import patch
from fountain.core import Store, APIError, CURRENT_ACCESS, AUDIT_ACTOR
from fountain.access import Access
from fountain.admin_content import AdminContent, content_query
from fountain.content_index import ContentIndex


class AdminContentTests(unittest.TestCase):
    def setUp(self):
        self.s = Store(':memory:')
        for identity, role in [('owner','owner'),('manager','member'),('reader','member'),('guest','guest')]:
            self.s.put('member', {'id':identity,'name':identity,'email':identity+'@test.invalid','role':role,'active':True})
        self.s.set_meta('workspace_id','workspace')
        self.private={'default':'private','inherit':False,'members':{},'groups':{}}
        self.s.put('page', {'id':'秘密/😀','title':'Straße Ａ','owner_id':'reader','permissions':self.private,
            'blocks':[{'type':'paragraph','text':'a'*3580+' boundary phrase '+ 'b'*6000+' tailneedle'}],
            'hidden':'notindexedsecret','verification':{'private':'proofsecret'}})
    def tearDown(self): self.s.close()
    def api(self, actor='owner'):
        return AdminContent(self.s,Access(self.s,self.s.get('member',actor)))
    def query(self, **values): return {k:[str(v)] for k,v in values.items()}
    def error(self,status,call):
        with self.assertRaises(APIError) as caught:call()
        self.assertEqual(caught.exception.status,status)
    def test_private_body_search_full_chunks_and_no_raw_dto(self):
        api=self.api()
        for q in ['tailneedle','"boundary phrase"','boundary tailneedle','STRASSE a']:
            result=api.search(self.query(q=q))
            self.assertEqual(len(result['items']),1,q)
            self.assertLessEqual(len(result['items'][0]['snippet']),180)
        for q in ['notindexedsecret','proofsecret']:
            self.assertEqual(api.search(self.query(q=q))['items'],[])
        item=api.search({})['items'][0]
        self.assertIsNone(item['creator']['id']);self.assertIsNone(item['last_editor']['id'])
        self.assertNotIn('permissions',item);self.assertNotIn('blocks',item)
        self.assertFalse(Access(self.s,self.s.get('member','manager')).can('page',self.s.get('page','秘密/😀')))
        self.error(403,lambda:self.api('manager').search({}))
    def test_read_only_revision_and_cursor_scope(self):
        self.s.put('page',{'id':'second','title':'Z','owner_id':'owner'})
        before=(list(self.s.db.execute('SELECT * FROM entities')),list(self.s.db.execute('SELECT * FROM meta')),self.s.db.total_changes)
        first=self.api().search(self.query(limit=1))
        self.assertTrue(first['next_cursor'])
        last=self.api().search(self.query(limit=1,cursor=first['next_cursor']))
        self.assertEqual(len(last['items']),1)
        self.assertEqual(before,(list(self.s.db.execute('SELECT * FROM entities')),list(self.s.db.execute('SELECT * FROM meta')),self.s.db.total_changes))
        self.error(400,lambda:self.api().search(self.query(limit=1,cursor=first['next_cursor'][:-1]+'!')))
        self.error(409,lambda:self.api().search(self.query(limit=1,q='x',cursor=first['next_cursor'])))
        self.s.audit('irrelevant',{})
        self.assertEqual(self.api().search(self.query(limit=1,cursor=first['next_cursor'])),last)
        self.s.put('group',{'id':'changed','members':[]})
        self.error(409,lambda:self.api().search(self.query(limit=1,cursor=first['next_cursor'])))
    def test_strict_queries(self):
        for query in [{'q':['a','b']},{'limit':['01']},{'limit':['101']},{'q':['"bad']},{'q':['a"b']},
                      {'creator_id':['x'],'creator_unknown':['1']},{'location_id':['x']},{'location_kind':['page']},
                      {'created_after':['2026-02-30T00:00:00Z']},{'q':['\ud800']},{'terms':['x']}, {'cursor':['x']}]:
            self.error(400,lambda query=query:self.api().search(query))
        self.assertEqual(content_query(self.query(created_after='2026-10-17T09:00:00+09:00'))[0]['created_after'],'2026-10-17T00:00:00.000000Z')
    def test_access_audience_and_conditional_mutation(self):
        item=self.api().search({})['items'][0]
        self.assertEqual(item['audience'],'private');self.assertEqual(item['access_summary']['internal_count'],0)
        result=self.api().access(self.query(kind='page',id='秘密/😀'))
        self.assertEqual({x['id'] for x in result['items']},{'owner','reader'})
        self.assertTrue(all(not x['can_revoke'] for x in result['items']))
        self.error(409,lambda:self.api().change({'kind':'page','id':'秘密/😀','review_revision':item['review_revision'],'operation':'revoke_member','member_id':'reader'}))
        self.api().change({'kind':'page','id':'秘密/😀','review_revision':item['review_revision'],'operation':'replace_permissions','permissions':{'default':'private','members':{'guest':'view'}}})
        self.error(409,lambda:self.api().change({'kind':'page','id':'秘密/😀','review_revision':item['review_revision'],'operation':'set_private'}))
        item=self.api().search({})['items'][0]
        self.assertEqual(item['audience'],'external')
        self.api().change({'kind':'page','id':'秘密/😀','review_revision':item['review_revision'],'operation':'revoke_member','member_id':'guest'})
        self.assertEqual(self.api().search({})['items'][0]['audience'],'private')
    def test_trusted_actor_and_management_not_content_editor(self):
        access=Access(self.s,self.s.get('member','reader'))
        token=CURRENT_ACCESS.set(access); actor=AUDIT_ACTOR.set('reader')
        try:
            self.s.put('page',{'id':'new','title':'New','owner_id':'owner','actor':'owner'})
            item=next(x for x in self.api().search({})['items'] if x['id']=='new')
            self.assertEqual(item['creator']['id'],'reader')
            page=self.s.get('page','new');page['permissions']=self.private;self.s.put('page',page)
            again=next(x for x in self.api().search({})['items'] if x['id']=='new')
            self.assertEqual(again['edited_at'],item['edited_at'])
        finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
        self.s.delete('page','new');self.s.put('page',{'id':'new','title':'new'})
        self.assertIsNone(next(x for x in self.api().search({})['items'] if x['id']=='new')['creator']['id'])
    def test_database_reprojection_derived_exclusion_and_row_policy(self):
        self.s.put('database',{'id':'db','name':'DB','owner_id':'reader','properties':[{'id':'title','type':'title'},{'id':'memo','type':'text'},{'id':'owner','type':'owner'}]})
        self.s.put('row',{'id':'row','database_id':'db','owner_id':'guest','properties':{'title':'Row','memo':'authored','owner':['computedsecret']}})
        self.assertEqual(len(self.api().search(self.query(q='authored'))['items']),1)
        self.assertEqual(self.api().search(self.query(q='computedsecret'))['items'],[])
        db=self.s.get('database','db');db['properties'][1]['type']='formula';self.s.put('database',db)
        self.assertEqual(self.api().search(self.query(q='authored'))['items'],[])
        access=self.api().access(self.query(kind='row',id='row'))
        self.assertFalse(next(x for x in access['items'] if x['id']=='reader')['can_revoke'])
    def test_csv_all_viewers_safe_cells_and_midstream_change(self):
        for i in range(105):self.s.put('member',{'id':f'u{i:03}','role':'member','name':'=formula','active':True})
        self.s.put('page',{'id':'csv','title':'=danger','owner_id':'reader'})
        chunks=self.api().csv(self.query(q='=danger'))
        data=b''.join(chunks).decode()
        rows=list(csv.DictReader(io.StringIO(data)))
        self.assertTrue(rows[0]['title'].startswith("'="))
        viewers=json.loads(rows[0]['shared_with'][1:])
        self.assertEqual(len(viewers),108)
        self.assertNotIn('guest',{viewer['id'] for viewer in viewers})
        iterator=iter(self.api().csv({}));next(iterator)
        self.s.put('group',{'id':'race','members':[]})
        self.error(409,lambda:next(iterator))
    def test_backfill_unknown_and_delete_rollback(self):
        with tempfile.NamedTemporaryFile() as file:
            store=Store(file.name);store.put('page',{'id':'old','title':'Old','owner_id':'owner'});store.close()
            store=Store(file.name);self.assertIsNone(ContentIndex(store).documents()[0]['creator_id']);store.close()
        before=self.api().search({})
        with self.assertRaises(RuntimeError):
            with self.s.transaction():
                self.s.delete('page','秘密/😀');raise RuntimeError()
        self.assertEqual(self.api().search({}),before)

    def test_named_options_pagination_and_permissions_source(self):
        first=self.api().options(self.query(kind='member',limit=2))
        second=self.api().options(self.query(kind='member',limit=2,cursor=first['next_cursor']))
        self.assertEqual(len(first['items'])+len(second['items']),4)
        self.assertEqual(self.api().options(self.query(kind='page',q='strasse'))['items'][0]['label'],'Straße Ａ')
        current=self.api().permissions(self.query(kind='page',id='秘密/😀'))
        self.assertEqual(current['permissions'],self.private)
        self.assertFalse(current['source_invalid'])
        page=self.s.get('page','秘密/😀');page['permissions']={'unknown':'privateproof'};self.s.put('page',page)
        current=self.api().permissions(self.query(kind='page',id='秘密/😀'))
        self.assertTrue(current['source_invalid']);self.assertIsNone(current['permissions'])
        self.assertNotIn('privateproof',str(current))
        self.error(400,lambda:self.api().permissions(self.query(kind='page',id='秘密/😀',limit=2)))

    def test_ancestor_location_filters_and_malformed_audience(self):
        self.s.put('teamspace',{'id':'rootspace','name':'Rootspace','visibility':'private'})
        self.s.put('page',{'id':'ancestor','title':'Ancestor','teamspace_id':'rootspace'})
        self.s.put('page',{'id':'parent','title':'Parent','parent_id':'ancestor'})
        page=self.s.get('page','秘密/😀');page.update(parent_id='parent',teamspace_id='stale');self.s.put('page',page)
        item=self.api().search(self.query(location_kind='teamspace',location_id='rootspace',q='strasse'))['items'][0]
        self.assertEqual(item['location'],{'kind':'page','id':'parent','title':'Parent'})
        self.assertEqual(len(self.api().search(self.query(location_kind='page',location_id='ancestor',q='strasse'))['items']),1)
        page['parent_id']='missing';self.s.put('page',page)
        item=self.api().search(self.query(q='strasse'))['items'][0]
        self.assertEqual(item['audience'],'unknown');self.assertIsNone(item['location'])

    def test_cursor_has_bounded_query_hash_for_maximum_utf8(self):
        q='😀'*512
        for identity in ('emoji1','emoji2'):
            self.s.put('page',{'id':identity,'title':q})
        first=self.api().search(self.query(q=q,limit=1))
        self.assertLess(len(first['next_cursor']),4096)
        second=self.api().search(self.query(q=q,limit=1,cursor=first['next_cursor']))
        self.assertNotEqual(first['items'][0]['id'],second['items'][0]['id'])

    def test_backup_preserves_trusted_history_and_regenerates_private_search_state(self):
        import sqlite3
        from pathlib import Path
        from fountain.backup import create_backup
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.db';target=Path(directory)/'backup.db'
            store=Store(source)
            store.put('member',{'id':'author','role':'member','active':True})
            store.put('member',{'id':'editor','role':'owner','active':True})
            token=CURRENT_ACCESS.set(Access(store,store.get('member','author')));actor=AUDIT_ACTOR.set('author')
            try:store.put('page',{'id':'known','title':'Known','owner_id':'other'})
            finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
            token=CURRENT_ACCESS.set(Access(store,store.get('member','editor')));actor=AUDIT_ACTOR.set('editor')
            try:
                page=store.get('page','known');page['blocks']=[{'type':'paragraph','text':'Edited'}];store.put('page',page)
                store.put('site',{'id':'site','page_id':'known','published':True})
            finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
            store.delete('member','author') # A historical actor does not need current membership.
            history=store.db.execute("SELECT * FROM content_provenance WHERE kind='page' AND id='known'").fetchone()
            original_secret=ContentIndex(store).state()['secret']
            self.assertEqual(history[3],'author');self.assertEqual(history[5],'editor');self.assertEqual(history[8],'editor')
            create_backup(source,target)
            with sqlite3.connect(target) as connection:
                self.assertEqual({row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")},{'entities','meta','attachment_chunks','content_provenance'})
                self.assertEqual(connection.execute("SELECT * FROM content_provenance").fetchone(),history)
            self.assertNotIn(original_secret.encode(),target.read_bytes())
            restored=Store(target)
            try:
                self.assertEqual(restored.db.execute("SELECT * FROM content_provenance WHERE kind='page' AND id='known'").fetchone(),history)
                document=ContentIndex(restored).documents()[0]
                self.assertEqual(document['generation'],history[2]);self.assertEqual(document['creator_id'],'author');self.assertEqual(document['editor_id'],'editor')
                self.assertNotEqual(ContentIndex(restored).state()['secret'],original_secret)
                restored.delete('page','known');restored.put('page',{'id':'known','title':'Recreated'})
                recreated=ContentIndex(restored).documents()[0]
                self.assertNotEqual(recreated['generation'],history[2]);self.assertIsNone(recreated['creator_id'])
            finally:restored.close();store.close()

    def test_unpublish_all_records_and_read_role_revocation(self):
        for identity in ('one','two'):self.s.put('site',{'id':identity,'page_id':'秘密/😀','published':True})
        item=self.api().search({})['items'][0]
        self.assertEqual(item['publication'],{'state':'authenticated','site_count':2,'form_count':0})
        self.assertNotEqual(item['audience'],'web')
        self.api().change({'kind':'page','id':'秘密/😀','review_revision':item['review_revision']},unpublish=True)
        self.assertTrue(all(site['published'] is False for site in self.s.list('site')))
        owner=self.api().authority
        role=owner.route('POST','/api/admin/roles',{'name':'Search','actions':['content.search.read'],'revision':owner.overview()['revision']},{})
        owner.route('PUT','/api/admin/assignments/manager',{'role_ids':[role['created_role_id']],'revision':owner.overview()['revision']},{})
        delegated=self.api('manager')
        self.assertEqual(len(delegated.search({})['items']),1)
        self.error(403,lambda:delegated.csv({}))
        self.error(403,lambda:delegated.options(self.query(kind='group')))
        owner.route('PUT','/api/admin/assignments/manager',{'role_ids':[],'revision':owner.overview()['revision']},{})
        self.error(403,lambda:delegated.search({}))

    def test_raw_authored_edits_are_attributed_even_with_same_normalized_index(self):
        access=Access(self.s,self.s.get('member','reader'))
        token=CURRENT_ACCESS.set(access);actor=AUDIT_ACTOR.set('reader')
        try:
            with patch('fountain.core.now',return_value='2026-10-17T01:00:00.000001+00:00'):
                self.s.put('page',{'id':'raw','title':'Ａ','blocks':[{'type':'paragraph','text':'same'}]})
            first=next(d for d in ContentIndex(self.s).documents() if d['id']=='raw')
            with patch('fountain.core.now',return_value='2026-10-17T01:00:00.000002+00:00'):
                page=self.s.get('page','raw');page['title']='A';self.s.put('page',page)
            second=next(d for d in ContentIndex(self.s).documents() if d['id']=='raw')
            self.assertNotEqual(first['text_revision'],second['text_revision']) # exact raw title participates
            self.assertEqual(second['edited_at'],'2026-10-17T01:00:00.000002+00:00')
            with patch('fountain.core.now',return_value='2026-10-17T01:00:00.000003+00:00'):
                page['blocks'][0]['text']='ｓａｍｅ';self.s.put('page',page)
            third=next(d for d in ContentIndex(self.s).documents() if d['id']=='raw')
            self.assertEqual(second['text_revision'],third['text_revision'])
            self.assertEqual(third['edited_at'],'2026-10-17T01:00:00.000003+00:00')
            page['permissions']=self.private;self.s.put('page',page)
            last=next(d for d in ContentIndex(self.s).documents() if d['id']=='raw')
            self.assertEqual(last['edited_at'],third['edited_at'])
        finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)

    def test_search_get_does_not_select_raw_document_entities_or_write_index(self):
        original_get,original_list=self.s.get,self.s.list
        before=(list(self.s.db.execute('SELECT * FROM entities ORDER BY kind,id')),list(self.s.db.execute('SELECT * FROM content_search_state')),self.s.db.total_changes)
        def get(kind,identity):
            self.assertNotIn(kind,('page','database','row'),'Search must use derivative headers')
            return original_get(kind,identity)
        def listing(kind):
            self.assertNotIn(kind,('page','database','row'),'Search must use derivative headers')
            return original_list(kind)
        self.s.get,self.s.list=get,listing
        try:self.assertEqual(self.api().search(self.query(q='tailneedle'))['items'][0]['id'],'秘密/😀')
        finally:self.s.get,self.s.list=original_get,original_list
        self.assertEqual(before,(list(self.s.db.execute('SELECT * FROM entities ORDER BY kind,id')),list(self.s.db.execute('SELECT * FROM content_search_state')),self.s.db.total_changes))

    def test_trusted_causes_and_forged_body_actor_never_supply_provenance(self):
        from fountain.core import CONTENT_ORIGIN
        access=Access(self.s,self.s.get('member','reader'))
        for cause in ('human','automation','import','public_form'):
            token=CURRENT_ACCESS.set(access);actor=AUDIT_ACTOR.set('reader');origin=CONTENT_ORIGIN.set(cause)
            try:self.s.put('page',{'id':cause,'title':cause,'creator_id':'owner','last_editor_id':'owner','owner_id':'owner'})
            finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor);CONTENT_ORIGIN.reset(origin)
            item=next(x for x in self.api().search({})['items'] if x['id']==cause)
            self.assertEqual(item['creator'],{'id':'reader','name':'reader','cause':cause})
        token=CURRENT_ACCESS.set(Access(self.s,{'id':'reader','role':'owner','active':True}));actor=AUDIT_ACTOR.set('reader')
        try:self.s.put('page',{'id':'spoof','title':'Spoof','creator_id':'reader'})
        finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
        self.assertIsNone(next(x for x in self.api().search({})['items'] if x['id']=='spoof')['creator']['id'])

    def test_invalid_timezone_offsets_reject_queries_and_do_not_rewrite_history(self):
        for offset in ('+00:60','-00:60','+01:99','-00:99','+24:00'):
            invalid='2026-10-17T00:00:00'+offset
            self.error(400,lambda invalid=invalid:self.api().search(self.query(created_after=invalid)))
        token=CURRENT_ACCESS.set(Access(self.s,self.s.get('member','reader')));actor=AUDIT_ACTOR.set('reader')
        try:
            with patch('fountain.core.now',return_value='2026-10-17T00:00:00+01:99'):
                self.s.put('page',{'id':'historical','title':'Historical'})
        finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
        item=next(x for x in self.api().search({})['items'] if x['id']=='historical')
        self.assertIsNone(item['created_at']);self.assertIsNone(item['edited_at'])
        self.assertEqual(item['creator']['id'],'reader')

    def test_revoke_from_absent_or_null_acl_preserves_other_inherited_access(self):
        self.s.put('member',{'id':'bob','name':'Bob','role':'member','active':True})
        grants={'default':'private','inherit':False,'members':{'manager':'edit','reader':'view','bob':'none'},'groups':{}}
        self.s.put('page',{'id':'restricted-parent','title':'Parent','owner_id':'owner','permissions':grants})
        self.s.put('database',{'id':'restricted-db','name':'DB','owner_id':'owner','permissions':grants,'properties':[{'id':'title','type':'title'}]})
        for kind in ('page','row'):
            for explicit_null in (False,True):
                identity=f'inherited-{kind}-{explicit_null}'
                source={'id':identity,'owner_id':'owner','title':identity,'parent_id':'restricted-parent'} if kind=='page' else {'id':identity,'database_id':'restricted-db','owner_id':'guest','properties':{'title':identity}}
                if explicit_null:source['permissions']=None
                self.s.put(kind,source)
                def levels():
                    value=self.s.get(kind,identity)
                    return {member:Access(self.s,self.s.get('member',member)).level(kind,value) for member in ('manager','reader','bob')}
                self.assertEqual(levels(),{'manager':3,'reader':1,'bob':0})
                item=next(item for item in self.api().search(self.query(q=identity))['items'] if item['id']==identity)
                self.api().change({'kind':kind,'id':identity,'operation':'revoke_member','member_id':'manager','review_revision':item['review_revision']})
                self.assertEqual(levels(),{'manager':0,'reader':1,'bob':0})
                self.assertTrue(self.s.get(kind,identity)['permissions']['inherit'])
        self.assertEqual(self.s.get('page','restricted-parent')['permissions'],grants)
        self.assertEqual(self.s.get('database','restricted-db')['permissions'],grants)

    def test_publication_management_provenance_on_both_targets_preserves_authorship(self):
        from contextlib import contextmanager
        @contextmanager
        def as_actor(identity):
            token=CURRENT_ACCESS.set(Access(self.s,self.s.get('member',identity)));actor=AUDIT_ACTOR.set(identity)
            try:yield
            finally:CURRENT_ACCESS.reset(token);AUDIT_ACTOR.reset(actor)
        def provenance(kind,identity):
            return self.s.db.execute('SELECT creator_id,creator_cause,editor_id,edited_at,editor_cause,manager_id,manager_at FROM content_provenance WHERE kind=? AND id=?',(kind,identity)).fetchone()
        for publication_kind,target_kind,field in [('site','page','page_id'),('form','database','database_id')]:
            a,b=publication_kind+'-a',publication_kind+'-b'
            with as_actor('reader'):
                for identity in (a,b):
                    self.s.put(target_kind,{'id':identity,'title':identity,'name':identity,'properties':[],'owner_id':'reader'})
            original_a,original_b=provenance(target_kind,a),provenance(target_kind,b)
            def stamp(second):return f'2026-10-17T12:00:{second:02}.000123+00:00'
            with as_actor('owner'),patch('fountain.core.now',return_value=stamp(1)):
                self.s.put(publication_kind,{'id':publication_kind,'published':True,field:a})
            self.assertEqual(provenance(target_kind,a)[-2:],('owner',stamp(1)))
            self.assertEqual(provenance(target_kind,b),original_b)
            before=ContentIndex(self.s).state()['revision']
            with as_actor('reader'),patch('fountain.core.now',return_value=stamp(2)):
                self.s.put(publication_kind,{**self.s.get(publication_kind,publication_kind),'name':'Changed'})
            self.assertEqual(provenance(target_kind,a)[-2:],('reader',stamp(2)))
            self.assertEqual(ContentIndex(self.s).state()['revision']-before,2,'Same-target update is attributed only once')
            with as_actor('owner'),patch('fountain.core.now',return_value=stamp(3)):
                self.s.put(publication_kind,{**self.s.get(publication_kind,publication_kind),field:b})
            self.assertEqual(provenance(target_kind,a)[-2:],('owner',stamp(3)))
            self.assertEqual(provenance(target_kind,b)[-2:],('owner',stamp(3)))
            with as_actor('reader'),patch('fountain.core.now',return_value=stamp(4)):
                self.s.delete(publication_kind,publication_kind)
            self.assertEqual(provenance(target_kind,b)[-2:],('reader',stamp(4)))
            self.assertEqual(provenance(target_kind,a)[-2:],('owner',stamp(3)))
            self.s.put(publication_kind,{'id':publication_kind,'published':True,field:a})
            self.assertEqual(provenance(target_kind,a)[-2:],(None,None),'Unknown management clears any stale actor claim')
            self.s.delete(publication_kind,publication_kind)
            self.assertEqual(provenance(target_kind,a)[-2:],(None,None))
            self.assertEqual(provenance(target_kind,a)[:5],original_a[:5])
            self.assertEqual(provenance(target_kind,b)[:5],original_b[:5])
            before=provenance(target_kind,b)
            with self.assertRaises(RuntimeError):
                with self.s.transaction(),as_actor('owner'):
                    self.s.put(publication_kind,{'id':'rollback-'+publication_kind,'published':True,field:b})
                    raise RuntimeError('Rollback')
            self.assertEqual(provenance(target_kind,b),before)

    def test_csv_rechecks_revision_after_the_last_data_piece_before_eof(self):
        count=len(list(self.api().csv({})))
        iterator=iter(self.api().csv({}))
        for _ in range(count):next(iterator)
        self.s.put('group',{'id':'changed-after-last-piece','members':[]})
        self.error(409,lambda:next(iterator))
