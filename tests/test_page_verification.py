"""Real SQLite verification authorization/CAS/projection regressions, no external services."""
import copy
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fountain.access import Access
from fountain.authorization import Authorization
from fountain.advanced import Advanced
from fountain.core import Store, Workspace, APIError, AUDIT_ACTOR, CURRENT_ACCESS


class PageVerificationTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.workspace = Workspace(self.store)
        self.advanced = Advanced(self.store, self.workspace)
        for identity, role in [('local', 'owner'), ('editor', 'member'), ('reader', 'member'),
                               ('viewer', 'member'), ('commenter', 'member'), ('guest', 'guest'),
                               ('no-read', 'member'), ('inactive', 'member')]:
            self.store.put('member', {'id': identity, 'name': identity, 'email': identity+'@example.invalid',
                                      'role': role, 'active': identity != 'inactive', 'private': 'never-return'})
        self.page = self.store.put('page', {'id': 'verification-page', 'title': '원문', 'revision': 7,
            'owner_id': 'local', 'blocks': [{'id': 'b', 'type': 'paragraph', 'text': '그대로'}],
            'permissions': {'default': 'private', 'inherit': False, 'groups': {},
                            'members': {'editor': 'edit', 'reader': 'view', 'viewer': 'view',
                                        'commenter': 'comment', 'guest': 'edit'}}})
        self.path = '/api/pages/'+self.page['id']+'/verify'

    def tearDown(self):
        self.store.close()

    @contextmanager
    def actor(self, identity):
        access = Access(self.store, self.store.get('member', identity))
        actor = AUDIT_ACTOR.set(identity)
        current = CURRENT_ACCESS.set(access)
        try:
            yield Authorization(access)
        finally:
            CURRENT_ACCESS.reset(current)
            AUDIT_ACTOR.reset(actor)

    def call(self, method, body=None, actor='editor'):
        with self.actor(actor) as guard, self.store.transaction():
            body = copy.deepcopy(body or {})
            guard.prepare(method, self.path, body)
            status, result = self.advanced.dispatch(method, self.path, body, {})
            return status, guard.project(self.path, result)

    def denied(self, status, method='POST', body=None, actor='editor'):
        before = self.store.get('page', self.page['id'])
        audits = self.store.list('audit')
        with self.assertRaises(APIError) as error:
            self.call(method, body, actor)
        self.assertEqual(error.exception.status, status)
        self.assertEqual(self.store.get('page', self.page['id']), before)
        self.assertEqual(self.store.list('audit'), audits)

    def test_edit_level_can_assign_multiple_and_remove_without_changing_content_acl(self):
        _, page = self.call('POST', {'owners': ['editor', 'reader', 'editor'], 'revision': 7})
        self.assertEqual(page['verification']['owners'], ['editor', 'reader'])
        self.assertEqual(page['verification']['owner'], 'editor')
        self.assertEqual(page['verification']['verified_by'], 'editor')
        self.assertEqual(page['revision'], 8)
        _, page = self.call('DELETE', {'revision': 8})
        self.assertEqual(page['revision'], 9)
        self.assertNotIn('verification', page)
        for key in ['owner_id', 'blocks', 'permissions']:
            self.assertEqual(page[key], self.page[key])

    def test_actor_default_and_legacy_owner_are_supported(self):
        self.assertEqual(self.call('POST')[1]['verification']['owners'], ['editor'])
        self.assertEqual(self.call('POST', {'owner': 'reader'})[1]['verification']['owners'], ['reader'])

    def test_view_and_comment_cannot_assign_or_remove(self):
        for actor in ['viewer', 'commenter']:
            for method in ['POST', 'DELETE']:
                self.denied(403, method, actor=actor)

    def test_active_visible_and_readable_members_only(self):
        for identity in ['inactive', 'no-read', 'missing']:
            self.denied(404, body={'owners': [identity]})
        self.denied(404, body={'owners': ['reader']}, actor='guest')
        self.assertEqual(self.call('POST', {'owners': ['guest']}, actor='guest')[1]['verification']['owners'], ['guest'])

    def test_malformed_owners_and_unknown_fields_are_rejected(self):
        for body in [{'owners': []}, {'owners': 'reader'}, {'owners': ['reader', 3]}, {'owner': ''},
                     {'owners': ['x'*161]}, {'owners': ['reader'], 'owner': 'reader'},
                     {'owner_id': 'reader'}, {'owners': ['\0']}, {'owners': [str(i) for i in range(1001)]}]:
            self.denied(400, body=body)
        self.denied(400, 'DELETE', {'owner': 'editor'})

    def test_deduplicated_limit_and_validation_before_member_lookup(self):
        self.assertEqual(self.call('POST', {'owners': ['reader']*1001})[1]['verification']['owners'], ['reader'])
        original = self.store.get
        reads = []
        def get(kind, identity):
            if kind == 'member': reads.append(identity)
            return original(kind, identity)
        with self.actor('editor'), patch.object(self.store, 'get', side_effect=get):
            with self.assertRaises(APIError):
                self.advanced.dispatch('POST', self.path, {'owners': ['reader', 0]}, {})
        self.assertEqual(reads, [])

    def test_expiry_is_null_or_strict_future_timestamp(self):
        for expiry in [False, 0, [], {}, '', '2099-02-30T00:00:00Z', '2099-01-01',
                       '2099-01-01T00:00:00', '2099-01-01 00:00:00Z', '2099-01-01T00:00:00+24:00']:
            self.denied(400, body={'expires_at': expiry})
        self.denied(400, body={'expires_at': '2020-01-01T00:00:00Z'})
        self.assertEqual(self.call('POST', {'expires_at': None})[1]['verification']['expires_at'], None)
        value = '2099-01-01T09:00:00.123456+09:00'
        self.assertEqual(self.call('POST', {'expires_at': value})[1]['verification']['expires_at'], value)

    def test_revision_conflicts_and_overflow_preserve_original(self):
        for method in ['POST', 'DELETE']:
            self.denied(409, method, {'revision': 6})
            for revision in [True, -1, '7', 7.5, 9007199254740992]:
                self.denied(400, method, {'revision': revision})
        page = self.store.get('page', self.page['id']);page['revision'] = 9007199254740991
        self.store.put('page', page)
        self.denied(409)

    def test_guest_projection_hides_assignees_and_preserves_hidden_active_readers(self):
        self.call('POST', {'owners': ['local', 'reader']}, actor='local')
        with self.actor('guest') as guard:
            projected = guard.project('/api/pages/'+self.page['id'], {'page': self.store.get('page', self.page['id'])})['page']
            self.assertEqual(projected['verification']['owners'], [])
            self.assertIsNone(projected['verification']['owner'])
            self.assertIsNone(projected['verification']['verified_by'])
        _, visible = self.call('POST', {'owners': ['guest']}, actor='guest')
        self.assertEqual(visible['verification']['owners'], ['guest'])
        self.assertEqual(self.store.get('page', self.page['id'])['verification']['owners'], ['guest', 'local', 'reader'])
        self.call('DELETE', actor='guest')
        self.assertNotIn('verification', self.store.get('page', self.page['id']))

    def test_projection_whitelists_ids_and_does_not_mutate_stored_verification(self):
        page = self.store.get('page', self.page['id'])
        page['verification'] = {'owners': ['reader', 'inactive', 'no-read'], 'owner': {'private': 'never-return'},
            'verified_by': {'private': 'never-return'}, 'verified_at': {}, 'expires_at': False, 'unknown': 'never-return'}
        self.store.put('page', page)
        with self.actor('editor') as guard:
            for path, payload, read in [('/api/workspace', {'pages': [page]}, lambda result: result['pages'][0]),
                                        ('/api/search', {'results': [page]}, lambda result: result['results'][0]),
                                        ('/api/pages/'+page['id'], {'page': page}, lambda result: result['page']),
                                        (self.path, page, lambda result: result)]:
                self.assertEqual(read(guard.project(path, payload))['verification'],
                    {'owners': [], 'owner': None, 'verified_by': None, 'verified_at': None, 'expires_at': None})
        self.assertEqual(self.store.get('page', page['id'])['verification'], page['verification'])

    def test_original_verification_validity_precedes_visibility_projection(self):
        neutral = {'owners': [], 'owner': None, 'verified_by': None, 'verified_at': None, 'expires_at': None}
        valid = {'owners': ['local'], 'owner': 'local', 'verified_by': 'local',
                 'verified_at': '2026-10-17T00:00:00Z', 'expires_at': None}
        invalid = [{'expires_at': value} for value in [False, 0, [], {}, '', 'x'*101,
                   '2099-02-30T00:00:00Z', '2099-01-01T00:00:00', '2099-01-01T00:00:00+24:00']]
        invalid += [{'verified_at': value} for value in [None, False, '', {}, 'x'*101, '2026-02-30T00:00:00Z']]
        invalid += [{'owners': value} for value in ['local', [], ['local', 123], [None], ['inactive'], ['no-read'], ['missing']]]
        with self.actor('guest') as guard:
            for override in invalid:
                page = {**self.page, 'verification': {**valid, **override}}
                before = copy.deepcopy(page)
                for route, payload, read in [('/api/pages/'+page['id'], {'page': page}, lambda v: v['page']),
                                             ('/api/workspace', {'pages': [page]}, lambda v: v['pages'][0])]:
                    self.assertEqual(read(guard.project(route, payload))['verification'], neutral, override)
                self.assertEqual(page, before)
            for source in [None, False, [], {}]:
                page = {**self.page, 'verification': source}
                self.assertEqual(guard.project('/api/pages/'+page['id'], {'page': page})['page']['verification'], neutral)
            for expiry in [None, '2020-01-01T09:00:00.123456+09:00']:
                page = {**self.page, 'verification': {**valid, 'expires_at': expiry}}
                for route, payload, read in [('/api/pages/'+page['id'], {'page': page}, lambda v: v['page']),
                                             ('/api/workspace', {'pages': [page]}, lambda v: v['pages'][0])]:
                    result = read(guard.project(route, payload))['verification']
                    self.assertEqual(result, {**neutral, 'verified_at': valid['verified_at'], 'expires_at': expiry})
            legacy = {key: value for key, value in valid.items() if key != 'owners'}
            self.assertEqual(guard.project('/api/pages/'+self.page['id'], {'page': {**self.page, 'verification': legacy}})['page']['verification']['verified_at'], valid['verified_at'])


if __name__ == '__main__':
    unittest.main()
