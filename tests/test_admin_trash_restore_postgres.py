"""Real private-store restore parity in disposable, independently cleaned namespaces."""
import os
import unittest
import uuid

from fountain.access import Access
from fountain.admin_content import AdminContent
from fountain.core import APIError, AUDIT_ACTOR, CURRENT_ACCESS
from fountain.postgres import PostgresStore


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'), 'Actual PostgreSQL DSN required')
class PostgresTrashRestoreTests(unittest.TestCase):
    def setUp(self):
        self.namespace='restore-test-'+uuid.uuid4().hex
        self.s=PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'],workspace_id=self.namespace)
        self.addCleanup(self.cleanup)
        for identity,role in [('owner','owner'),('author','member')]:
            self.s.put('member',{'id':identity,'role':role,'active':True})
        self.s.set_meta('workspace_id',self.namespace)
        self.access=Access(self.s,self.s.get('member','owner'))
        self.actor_token=AUDIT_ACTOR.set('owner');self.access_token=CURRENT_ACCESS.set(self.access)
        self.addCleanup(CURRENT_ACCESS.reset,self.access_token);self.addCleanup(AUDIT_ACTOR.reset,self.actor_token)
        self.s.put('page',{'id':'parent','title':'Parent','owner_id':'author'})
        self.s.put('page',{'id':'trash/가족😀','title':'Archived','owner_id':'author','parent_id':'parent',
                          'permissions':{'default':'private','inherit':False,'members':{},'groups':{}},
                          'archived':True,'deleted':True,'deleted_at':'2026-10-16T00:00:00Z','revision':3,
                          'blocks':[{'id':'b','type':'paragraph','text':'Unchanged body','attachment_id':'file'}]})
        for kind in ['version','comment','collaboration','attachment']:
            self.s.put(kind,{'id':kind,'page_id':'trash/가족😀','preserve':{'kind':kind}})
        self.s.put('site',{'id':'site','page_id':'trash/가족😀','published':True})

    def cleanup(self):
        try:
            with self.s.transaction():
                for table in ['attachment_chunks','entities','meta','content_search_chunks','content_search_documents','content_provenance','content_search_state']:
                    self.s._execute('DELETE FROM fountain_private.'+table+' WHERE workspace_id=%s',(self.namespace,))
        finally:self.s.close()

    def service(self):return AdminContent(self.s,self.access)
    def request(self,mode):
        review=self.service().permissions({'kind':['page'],'id':['trash/가족😀']},restore=True)
        return {'kind':'page','id':'trash/가족😀','mode':mode,'review_revision':review['review_revision']}
    def history(self):
        with self.s.transaction():
            return self.s._execute('SELECT generation,creator_id,creator_cause,editor_id,edited_at,editor_cause,manager_id,manager_at FROM fountain_private.content_provenance WHERE workspace_id=%s AND kind=%s AND id=%s',(self.namespace,'page','trash/가족😀'),fetch='one')
    def snapshot(self):
        with self.s.transaction():
            return {table:self.s._execute('SELECT row_to_json(t)::text FROM fountain_private.'+table+' t WHERE workspace_id=%s ORDER BY row_to_json(t)::text',(self.namespace,),fetch='all') for table in ['entities','meta','content_search_documents','content_search_chunks','content_provenance','content_search_state']}

    def test_private_and_original_preserve_real_postgres_authorship_and_related_entities(self):
        for mode in ['original','private']:
            with self.subTest(mode=mode):
                page=self.s.get('page','trash/가족😀');page.update(archived=True,deleted=True);self.s.put('page',page)
                site=self.s.get('site','site');site['published']=True;self.s.put('site',site)
                before=self.s.get('page',page['id']);history=self.history()
                related={kind:self.s.list(kind) for kind in ['version','comment','collaboration','attachment']}
                self.assertEqual(self.service().restore(self.request(mode)),{'applied':True})
                after=self.s.get('page',page['id']);current=self.history()
                self.assertEqual(after['blocks'],before['blocks']);self.assertEqual(after['created_at'],before['created_at'])
                self.assertEqual(after['revision'],before['revision']+1);self.assertFalse(after['archived']);self.assertFalse(after['deleted'])
                self.assertEqual(current[:6],history[:6]);self.assertEqual(current[6],'owner');self.assertEqual(current[7],after['updated_at'])
                for kind,data in related.items():self.assertEqual(self.s.list(kind),data)
                self.assertFalse(self.s.get('site','site')['published'])
                self.assertEqual(after['owner_id'],'owner' if mode=='private' else 'author')
                if mode=='private':self.assertIsNone(after['parent_id']);self.assertIsNone(after['teamspace_id'])

    def test_invalid_parent_and_late_failure_roll_back_all_private_state(self):
        parent=self.s.get('page','parent');parent['archived']=True;self.s.put('page',parent)
        body=self.request('original');before=self.snapshot()
        with self.assertRaises(APIError) as caught:self.service().restore(body)
        self.assertEqual(caught.exception.status,409);self.assertEqual(self.snapshot(),before)
        self.s.set_meta('access_revision',9007199254740991)
        body=self.request('private');before=self.snapshot()
        with self.assertRaises(APIError) as caught:self.service().restore(body)
        self.assertEqual(caught.exception.status,503);self.assertEqual(self.snapshot(),before)


if __name__=='__main__':unittest.main()
