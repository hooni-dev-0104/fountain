"""Administration grants must not survive member or account reincarnation."""
import os
import unittest
import uuid
from unittest.mock import patch

from fountain.access import Access
from fountain.admin_roles import AdminAuthority, generation_key
from fountain.auth import Auth
from fountain.core import Store
from fountain.postgres import PostgresStore


class LifecycleContract:
    def member(self, **changes):
        value = self.store.get('member', 'family') or {
            'id': 'family', 'name': 'Family', 'email': 'family@example.test',
            'role': 'member', 'active': True}
        return self.store.put('member', {**value, **changes})

    def grant(self):
        generation = uuid.uuid4().hex
        self.store.set_meta(generation_key('family'), generation)
        role = self.store.put('admin_role', {'id': 'audit-role', 'version': 1, 'name': 'Audit',
            'description': '', 'actions': ['audit.read'], 'nonce': uuid.uuid4().hex})
        self.store.put('admin_assignment', {'id': 'family', 'member_id': 'family',
            'role_ids': ['audit-role'], 'role_nonces': {'audit-role': role['nonce']}, 'generation': generation})
        self.assertTrue(self.allowed())
        return generation

    def allowed(self):
        principal = self.store.get('member', 'family')
        return bool(principal and AdminAuthority(self.store, Access(self.store, principal)).allows('audit.read'))

    def generation(self):
        return self.store.meta(generation_key('family'))

    def test_ordinary_member_mutations_do_not_enroll_or_write_generation_metadata(self):
        self.member(name='Renamed')
        self.member(active=False)
        self.member(active=True, role='guest')
        self.store.delete('member', 'family')
        self.member()
        self.assertIsNone(self.generation())
        self.assertEqual(self.store.list('admin_assignment'), [])

    def test_same_clock_delete_recreate_does_not_restore_an_assignment(self):
        self.grant()
        assignment = self.store.get('admin_assignment', 'family')
        original = self.store.get('member', 'family')
        with patch('fountain.core.now', return_value=original['created_at']), patch('fountain.postgres.now', return_value=original['created_at']):
            with self.store.transaction():
                self.store.delete('member', 'family')
                self.store.put('member', original)
        self.assertEqual(self.store.get('member', 'family')['created_at'], original['created_at'])
        self.assertFalse(self.allowed())
        self.assertEqual(self.store.get('admin_assignment', 'family'), assignment)

    def test_inactive_then_active_requires_explicit_reassignment(self):
        before = self.grant()
        self.member(active=False)
        self.assertNotEqual(self.generation(), before)
        self.member(active=True)
        self.assertFalse(self.allowed())
        self.grant()
        self.assertTrue(self.allowed())

    def test_guest_owner_and_invalid_active_roundtrips_revoke(self):
        for changes in ({'role': 'guest'}, {'role': 'owner'}, {'active': None}, {'active': 1}):
            with self.subTest(changes=changes):
                before = self.grant()
                self.member(**changes)
                self.assertNotEqual(self.generation(), before)
                self.member(role='member', active=True)
                self.assertFalse(self.allowed())

    def test_member_admin_roundtrip_and_name_change_preserve_grant(self):
        before = self.grant()
        self.member(role='admin', name='Administrator')
        self.member(role='member', name='Updated name')
        self.assertEqual(self.generation(), before)
        self.assertTrue(self.allowed())

    def test_internal_email_string_changes_revoke_conservatively(self):
        for email in ('other@example.test', ' FAMILY@example.test ', 'FAMILY@example.test', None):
            with self.subTest(email=email):
                self.member(email='family@example.test')
                before = self.grant()
                self.member(email=email)
                self.assertNotEqual(self.generation(), before)
                self.member(email='family@example.test')
                self.assertFalse(self.allowed())

    def test_noop_member_update_and_missing_delete_preserve_generation(self):
        before = self.grant()
        self.member()
        self.store.delete('member', 'missing')
        self.assertEqual(self.generation(), before)
        self.assertTrue(self.allowed())

    def test_member_change_and_delete_rollback_restore_grant_and_revision(self):
        self.grant()
        before, revision = self.generation(), self.store.meta('_entity_revision')
        for change in (lambda: self.member(email='other@example.test'), lambda: self.store.delete('member', 'family')):
            with self.assertRaisesRegex(RuntimeError, 'rollback'):
                with self.store.transaction():
                    change()
                    self.assertNotEqual(self.generation(), before)
                    raise RuntimeError('rollback')
            self.assertEqual(self.generation(), before)
            self.assertEqual(self.store.meta('_entity_revision'), revision)
            self.assertTrue(self.allowed())

    def test_account_creation_and_removal_revoke_but_password_reset_preserves(self):
        auth = Auth(self.store)
        before = self.grant()
        auth.create_account('family', 'family test password')
        self.assertNotEqual(self.generation(), before)
        self.assertFalse(self.allowed())
        before = self.grant()
        auth.set_password('family', 'replacement test password')
        self.assertEqual(self.generation(), before)
        self.assertTrue(self.allowed())
        auth.remove_account('family')
        self.assertNotEqual(self.generation(), before)
        self.assertFalse(self.allowed())
        auth.create_account('family', 'recreated test password')
        self.assertFalse(self.allowed())

    def test_account_failure_and_outer_rollback_preserve_generation(self):
        auth = Auth(self.store)
        self.grant()
        before = self.generation()
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            with self.store.transaction():
                auth.create_account('family', 'family test password')
                raise RuntimeError('rollback')
        self.assertEqual(self.generation(), before)
        self.assertIsNone(self.store.get('credential', 'family'))
        self.assertTrue(self.allowed())


class SQLiteAdminLifecycleTests(LifecycleContract, unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.addCleanup(self.store.close)
        self.member()


@unittest.skipUnless(os.environ.get('FOUNTAIN_TEST_POSTGRES_DSN'), 'Requires an isolated migrated PostgreSQL test database')
class PostgresAdminLifecycleTests(LifecycleContract, unittest.TestCase):
    def setUp(self):
        self.store = PostgresStore(os.environ['FOUNTAIN_TEST_POSTGRES_DSN'], workspace_id=uuid.uuid4().hex)
        # Every test stays inside an outer driver transaction and rolls back;
        # Store.transaction uses savepoints, including account helper nesting.
        self.store._connection.execute('BEGIN')
        self.addCleanup(self.cleanup)
        self.member()

    def cleanup(self):
        try:
            self.store._connection.rollback()
        finally:
            self.store.close()
