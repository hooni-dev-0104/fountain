"""Authoritative member ownership for collaborative history operations."""
import copy
import json
import unittest

from fountain import crdt
from fountain.core import APIError, Store
from fountain.server import Application


def operation(client, clock, kind='text.insert', **values):
    result = {'id': f'{client}:{clock}', 'client': client, 'clock': clock, 'type': kind}
    if kind != 'history.cancel':
        result['block_id'] = 'text'
    return {**result, **values}


class HistoryAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.app = Application(self.store)
        self.owner = self.store.get('member', 'local')
        self.family = self.store.put('member', {'id': 'family', 'role': 'member', 'active': True, 'name': '가족'})
        self.page = self.app.workspace.create_page({'blocks': [{'id': 'text', 'text': '원본'}],
            'permissions': {'default': 'private', 'members': {'family': 'edit'}}})
        self.path = '/api/pages/' + self.page['id']
        self.epoch = self.call('GET', '/collaboration')['epoch']

    def tearDown(self):
        self.store.close()

    def call(self, method, suffix, body=None, member=None):
        return self.app.dispatch(method, self.path + suffix, body or {}, {}, principal=member or self.owner)[1]

    def send(self, operations, member=None, **body):
        return self.call('POST', '/operations', {'epoch': self.epoch, 'ops': operations, **body}, member)

    def document(self):
        return self.store.get('collaboration', self.page['id'])

    def before(self):
        return {kind: copy.deepcopy(self.store.list(kind)) for kind in ('page', 'collaboration', 'version', 'audit')}, self.store.meta('_entity_revision')

    def rejected(self, operations, status, member=None, **body):
        before = self.before()
        with self.assertRaises(APIError) as error:
            self.send(operations, member, **body)
        self.assertEqual(error.exception.status, status)
        self.assertEqual(self.before(), before)

    def test_new_operations_are_owned_by_authenticated_member_and_owners_stay_private(self):
        result = self.send([operation('family-tab', 1, text='가족', after_id=None)], self.family)
        self.assertEqual(self.document()['op_owners'], {'family-tab:1': 'family'})
        encoded = json.dumps(result, ensure_ascii=False)
        self.assertNotIn('op_owners', encoded)
        self.assertNotIn('baseline', json.dumps(result['page']))

    def test_undo_redo_binds_cancel_operations_and_retry_has_no_write(self):
        edit = operation('tab', 1, text='추가', after_id=None)
        self.send([edit])
        undo = operation('tab', 2, 'history.cancel', targets=['tab:1'])
        result = self.send([undo])
        self.assertEqual(result['blocks'][0]['text'], '원본')
        before = self.before()
        retry = self.send([undo])
        self.assertEqual(self.before(), before)
        self.assertEqual(retry['ack'], ['tab:2'])
        redo = operation('tab', 3, 'history.cancel', targets=['tab:2'])
        self.assertIn('추가', self.send([redo])['blocks'][0]['text'])
        self.assertEqual(self.document()['op_owners'], {f'tab:{clock}': 'local' for clock in (1, 2, 3)})

    def test_missing_target_rolls_back_new_operations_and_owner_claims(self):
        self.rejected([operation('tab', 1, text='유실 금지', after_id=None),
                       operation('tab', 3, 'history.cancel', targets=['tab:2'])], 409)
        self.assertEqual(self.document()['op_owners'], {})

    def test_same_batch_target_ownership_is_independent_of_request_order(self):
        undo = operation('tab', 2, 'history.cancel', targets=['tab:1'])
        edit = operation('tab', 1, text='추가', after_id=None)
        result = self.send([undo, edit], self.family)
        self.assertEqual(result['blocks'][0]['text'], '원본')
        self.assertEqual(self.document()['op_owners'], {'tab:1': 'family', 'tab:2': 'family'})

    def test_foreign_member_cannot_cancel_or_reuse_bound_client_for_new_operations(self):
        self.send([operation('owner-tab', 1, text='소유자', after_id=None)])
        self.rejected([operation('owner-tab', 2, 'history.cancel', targets=['owner-tab:1'])], 403, self.family)
        self.rejected([operation('owner-tab', 2, text='탈취', after_id=None)], 403, self.family)
        self.rejected([operation('owner-tab', 2, 'block.set', field='type', value='quote')], 403, self.family)
        self.send([operation('family-tab', 1, text='가족 작업', after_id=None)], self.family)
        self.rejected([operation('family-tab', 2, 'history.cancel', targets=['family-tab:1'])], 403)

    def test_exact_foreign_replay_does_not_change_owner_or_bind_another_client(self):
        edit = operation('tab', 1, text='원본 작업', after_id=None)
        self.send([edit])
        before = self.before()
        self.assertEqual(self.send([edit], self.family)['ack'], ['tab:1'])
        self.assertEqual(self.before(), before)
        self.rejected([operation('tab', 2, text='탈취', after_id=None)], 403, self.family)

    def test_missing_tracked_owner_cannot_be_acquired_by_replay_or_workspace_owner(self):
        edit = operation('tab', 1, text='작업', after_id=None)
        self.send([edit])
        document = self.document()
        document['op_owners'] = {}
        self.store.put('collaboration', document)
        before = self.before()
        self.send([edit])
        self.assertEqual(self.before(), before)
        self.rejected([operation('tab', 2, text='새 주장', after_id=None)], 403)
        self.rejected([operation('tab', 2, 'history.cancel', targets=['tab:1'])], 403)

    def test_missing_role_and_inactive_actor_cannot_establish_operation_ownership(self):
        for member in ({'id': 'family'}, {**self.family, 'active': False}):
            with self.subTest(member=member):
                self.rejected([operation('unclaimed', 1, text='권한 없음', after_id=None)], 401, member)
        self.assertEqual(self.document()['op_owners'], {})

    def test_legacy_seen_replay_cannot_acquire_old_id_but_new_id_can_bind_client(self):
        edit = operation('legacy', 1, text='이전', after_id=None)
        legacy = crdt.apply_operations(self.document()['state'], [edit])
        # Reproduce a pre-upgrade document: materialized content and digest-only
        # seen IDs remain; there is no private ledger or authenticated ownership.
        legacy.pop('history', None)
        document = self.document()
        document['state'] = legacy
        document.pop('op_owners', None)
        self.store.put('collaboration', document)
        page = self.store.get('page', self.page['id'])
        page['blocks'] = crdt.project(legacy)
        self.store.put('page', page)
        before = self.before()
        self.send([edit], self.family)
        self.assertEqual(self.before(), before)
        self.assertNotIn('legacy:1', self.document().get('op_owners', {}))
        self.rejected([edit, operation('legacy', 2, 'history.cancel', targets=['legacy:1'])], 409, self.family)
        self.send([operation('legacy', 2, text='새 작업', after_id=None)], self.family)
        self.assertEqual(self.document()['op_owners'], {'legacy:2': 'family'})
        self.rejected([operation('legacy', 3, 'history.cancel', targets=['legacy:1'])], 409, self.family)
        self.rejected([operation('legacy', 3, text='탈취', after_id=None)], 403)

    def test_malformed_mixed_batch_precedes_ownership_and_never_partially_applies(self):
        self.send([operation('owned', 1, text='소유', after_id=None)])
        self.rejected([operation('owned', 2, text='탈취', after_id=None),
                       operation('new', 1, 'text.format', char_ids=['seed:text:0'], marks={'link': 'javascript:alert(1)'})], 400, self.family)

    def test_reused_payload_or_changed_group_is_rejected_before_owner_claim(self):
        edit = operation('tab', 1, text='원본', after_id=None, group_id='immutable-group')
        self.send([edit])
        self.rejected([operation('fresh', 1, text='신규', after_id=None), {**edit, 'group_id': 'changed-group'}], 409, self.family)

    def test_cancel_wire_rejects_other_client_nonlower_clock_duplicates_and_block_id(self):
        self.send([operation('tab', 1, text='작업', after_id=None)])
        invalid = [operation('other', 2, 'history.cancel', targets=['tab:1']),
                   operation('tab', 2, 'history.cancel', targets=['tab:2']),
                   operation('tab', 2, 'history.cancel', targets=['tab:1', 'tab:1']),
                   operation('tab', 2, 'history.cancel', targets=['tab:1'], block_id='text')]
        for item in invalid:
            with self.subTest(item=item):
                self.rejected([item], 400)

    def test_creation_group_can_span_batches_and_client_binding_protects_late_members(self):
        first = operation('tab', 1, 'block.set', block_id='new', field='language', value='python', group_id='creation')
        self.assertFalse(any(block['id'] == 'new' for block in self.send([first])['blocks']))
        self.rejected([operation('tab', 2, 'text.insert', block_id='new', text='늦은 탈취', after_id=None, group_id='creation')], 403, self.family)
        inserted = operation('tab', 2, 'block.insert', block_id='new', parent_id=None, after_id='text', group_id='creation')
        result = self.send([inserted])
        self.assertEqual(next(block for block in result['blocks'] if block['id'] == 'new')['language'], 'python')
        before = self.before()
        self.send([first, inserted])
        self.assertEqual(self.before(), before)

    def test_epoch_replacement_drops_all_ownership_and_old_cancel_cannot_cross_epochs(self):
        self.send([operation('tab', 1, text='작업', after_id=None)])
        self.call('PUT', '/blocks', {'blocks': [{'id': 'text', 'text': '교체'}]})
        self.rejected([operation('tab', 2, 'history.cancel', targets=['tab:1'])], 409)
        self.epoch = self.call('GET', '/collaboration')['epoch']
        self.assertEqual(self.document()['op_owners'], {})
        self.rejected([operation('tab', 2, 'history.cancel', targets=['tab:1'])], 409)
        self.send([operation('tab', 1, text='새 epoch', after_id=None)], self.family)
        self.assertEqual(self.document()['op_owners'], {'tab:1': 'family'})

    def test_acl_lock_and_archive_still_gate_history(self):
        self.send([operation('family-tab', 1, text='가족', after_id=None)], self.family)
        undo = operation('family-tab', 2, 'history.cancel', targets=['family-tab:1'])
        self.call('PATCH', '/permissions', {'permissions': {'default': 'private', 'members': {'family': 'view'}}})
        self.rejected([undo], 403, self.family)
        self.call('PATCH', '/permissions', {'permissions': {'default': 'private', 'members': {'family': 'none'}}})
        self.rejected([undo], 404, self.family)
        self.call('PATCH', '/permissions', {'permissions': {'default': 'private', 'members': {'family': 'edit'}}})
        self.call('PATCH', '', {'locked': True})
        self.rejected([undo], 423, self.family)
        self.call('PATCH', '', {'locked': False, 'archived': True})
        self.rejected([undo], 409, self.family)

    def test_cancel_revealing_forbidden_attachment_rolls_back_everything(self):
        self.store.put('attachment', {'id': 'secret', 'owner_id': 'local', 'data': '', 'name': '비공개'})
        self.send([operation('owner-tab', 1, 'block.set', field='attachment_id', value='secret')])
        self.send([operation('family-tab', 2, 'block.set', field='attachment_id', value=None)], self.family)
        self.rejected([operation('family-tab', 3, 'history.cancel', targets=['family-tab:2'])], 404, self.family)
        self.assertNotIn('family-tab:3', self.document()['op_owners'])

    def test_server_never_uses_client_hints_to_restore_attachment_or_text(self):
        self.send([operation('tab', 1, text='추가', after_id=None)])
        result = self.send([operation('tab', 2, 'history.cancel', targets=['tab:1'])], hints={'text': '위조', 'attachment_id': 'secret'})
        self.assertEqual(result['blocks'][0]['text'], '원본')
        self.assertNotIn('위조', json.dumps(self.document(), ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()
