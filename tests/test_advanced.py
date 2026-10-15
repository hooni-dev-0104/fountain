import os
import unittest
from unittest.mock import patch

from fountain.advanced import Advanced, AdvancedError
from fountain.core import Store, Workspace, APIError


class AdvancedTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.workspace = Workspace(self.store)
        self.advanced = Advanced(self.store, self.workspace)

    def tearDown(self):
        self.store.close()

    def test_forms_required_and_conditional_fields_create_real_rows(self):
        form = self.advanced.save('forms', {'name': '요청', 'database_id': 'projects', 'published': True, 'fields': [
            {'id': 'name', 'label': '이름', 'required': True, 'property_id': 'name'},
            {'id': 'status', 'type': 'select', 'options': ['진행 중', '완료'], 'property_id': 'status'},
            {'id': 'note', 'required': True, 'property_id': 'priority', 'condition': {'field': 'status', 'equals': '진행 중'}}]})
        with self.assertRaises(AdvancedError):
            self.advanced.submit_form(form['id'], {'answers': {}})
        with self.assertRaises(AdvancedError):
            self.advanced.submit_form(form['id'], {'answers': {'name': '요청', 'status': '진행 중'}})
        result = self.advanced.submit_form(form['id'], {'answers': {'name': '요청', 'status': '완료', 'note': '숨긴 값'}})
        row = self.store.get('row', result['row']['id'])
        self.assertEqual(row['properties'], {'name': '요청', 'status': '완료'})

    def test_automation_conditions_and_target_isolation(self):
        row = self.workspace.create_row('projects', {'values': {'name': '검증', 'status': '시작 전'}})
        automation = self.advanced.save('automations', {'name': '시작', 'trigger': 'row.updated', 'database_id': 'projects',
            'conditions': {'status': '시작 전'}, 'actions': [{'type': 'set_property', 'property_id': 'status', 'value': '진행 중'}]})
        self.advanced.trigger('row.updated', 'projects', row)
        self.assertEqual(self.store.get('row', row['id'])['properties']['status'], '진행 중')
        self.assertTrue(self.advanced.run_automation(automation['id'], {'row_id': row['id']})['skipped'])
        other = self.workspace.create_database({'name': '다른 DB'})
        outsider = self.workspace.create_row(other['id'], {'values': {'name': '외부'}})
        with self.assertRaises(AdvancedError):
            self.advanced.run_automation(automation['id'], {'row_id': outsider['id']})

    def test_security_settings_apply_to_guests_and_publication(self):
        self.advanced.update_settings({'disable_guests': True, 'disable_public_sharing': True})
        with self.assertRaises(AdvancedError):
            self.advanced.save('members', {'email': 'guest@example.org', 'role': 'guest'})
        with self.assertRaises(AdvancedError):
            self.advanced.save('sites', {'name': '사이트', 'page_id': 'welcome', 'published': True})
        with self.assertRaises(AdvancedError):
            self.advanced.update_settings({'trash_retention_days': -1})
        with self.assertRaises(AdvancedError):
            self.advanced.update_settings({'disable_guests': 'false'})

    def test_clipboard_escapes_html_and_restores_structured_blocks(self):
        result = self.advanced.clipboard({'blocks': [{'type': 'heading1', 'text': '<script>alert(1)</script>'}]})
        self.assertNotIn('<script>', result['html'])
        self.assertIn('&lt;script&gt;', result['html'])
        self.assertEqual(self.store.get('clipboard', result['id'])['blocks'][0]['type'], 'heading1')

    def test_ai_without_key_never_fakes_success(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(AdvancedError) as caught:
            self.advanced.ai({'action': 'summarize', 'prompt': '문서'})
        self.assertEqual(caught.exception.status, 503)

    def test_scim_users_groups_lifecycle_and_pagination(self):
        status, user = self.advanced.scim('POST', '/scim/v2/Users', {'userName': 'alice@example.org', 'displayName': 'Alice'}, {})
        self.assertEqual(status, 201)
        status, group = self.advanced.scim('POST', '/scim/v2/Groups', {'displayName': '디자인', 'members': [{'value': user['id']}]}, {})
        self.assertEqual(group['members'], [{'value': user['id']}])
        _, updated = self.advanced.scim('PATCH', '/scim/v2/Users/' + user['id'], {'Operations': [{'op': 'replace', 'path': 'active', 'value': False}]}, {})
        self.assertFalse(updated['active'])
        _, result = self.advanced.scim('GET', '/scim/v2/Users', {}, {'count': ['1']})
        self.assertEqual(len(result['Resources']), 1)
        self.assertEqual(result['totalResults'], 2)
        self.assertEqual(self.advanced.scim('DELETE', '/scim/v2/Users/' + user['id'], {}, {})[0], 204)
        with self.assertRaises(AdvancedError):
            self.advanced.scim('GET', '/scim/v2/Users/' + user['id'], {}, {})

    def test_public_site_escapes_content_and_stops_when_archived(self):
        page = self.workspace.create_page({'title': '<img onerror=alert(1)>', 'blocks': [{'text': '<script>bad</script>'}]})
        site = self.advanced.save('sites', {'name': '게시', 'page_id': page['id'], 'slug': 'safe', 'published': True})
        status, payload = self.advanced.public_view('/sites/safe')
        self.assertEqual(status, 200)
        self.assertNotIn('<script>bad', payload['_html'])
        self.assertIn('&lt;script&gt;', payload['_html'])
        self.workspace.update_page(page['id'], {'archived': True})
        with self.assertRaises(AdvancedError):
            self.advanced.public_view('/sites/safe')

    def test_form_schema_rejects_forward_condition(self):
        with self.assertRaises(AdvancedError):
            self.advanced.save('forms', {'name': '순환', 'fields': [{'id': 'a', 'condition': {'field': 'b', 'equals': 'x'}}]})

    def test_overview_uses_core_members_and_database(self):
        overview = self.advanced.overview()
        self.assertEqual(overview['members'][0]['id'], 'local')
        self.assertEqual(overview['teamspaces'][0]['id'], 'general')
        self.assertGreater(len(overview['features']), 20)
        self.assertEqual(self.advanced.capabilities()['mode'], 'local-single-user')

    def test_automation_rejects_invalid_typed_property(self):
        row = self.workspace.create_row('projects', {'values': {'name': '원래 값'}})
        automation = self.advanced.save('automations', {'name': '오류 작업', 'actions': [
            {'type': 'set_property', 'property_id': 'name', 'value': {'broken': True}}]})
        with self.assertRaises(APIError):
            self.advanced.run_automation(automation['id'], {'row_id': row['id']})
        self.assertEqual(self.store.get('row', row['id'])['properties']['name'], '원래 값')

    def test_scim_add_members_preserves_existing_members(self):
        users = [self.advanced.save('members', {'email': email}) for email in ['a@example.org', 'b@example.org']]
        _, group = self.advanced.scim('POST', '/scim/v2/Groups', {'displayName': '팀', 'members': [{'value': users[0]['id']}]}, {})
        _, updated = self.advanced.scim('PATCH', '/scim/v2/Groups/' + group['id'], {'Operations': [
            {'op': 'add', 'path': 'members', 'value': [{'value': users[1]['id']}, {'value': users[0]['id']}]}]}, {})
        self.assertEqual({m['value'] for m in updated['members']}, {u['id'] for u in users})

    def test_form_sharing_restriction_applies_to_existing_forms(self):
        form = self.advanced.save('forms', {'name': '공개 양식', 'published': True, 'fields': []})
        self.advanced.update_settings({'disable_public_sharing': True})
        with self.assertRaises(AdvancedError):
            self.advanced.public_view('/forms/' + form['id'])
        with self.assertRaises(AdvancedError):
            self.advanced.submit_form(form['id'], {'answers': {}})
        with self.assertRaises(AdvancedError):
            self.advanced.save('forms', {'name': '새 양식', 'published': True})

    def test_expired_archived_page_removed_with_versions(self):
        page = self.workspace.create_page({'title': '보존 검사'})
        self.workspace.save_blocks(page['id'], [{'text': '버전'}])
        self.workspace.update_page(page['id'], {'archived': True})
        archived = self.store.get('page', page['id'])
        archived['deleted_at'] = '2020-01-01T00:00:00+00:00'
        # Preserve audit timestamp in the record and exercise only retention policy.
        self.store.put('page', archived)
        result = self.advanced.cleanup()
        self.assertEqual(result['pages'], 1)
        self.assertIsNone(self.store.get('page', page['id']))
        self.assertFalse([v for v in self.store.list('version') if v['page_id'] == page['id']])

    def test_page_verification_has_real_owner_and_can_be_revoked(self):
        status, page = self.advanced.dispatch('POST', '/api/pages/welcome/verify', {'owner': 'local'}, {})
        self.assertEqual(status, 200)
        self.assertEqual(page['verification']['owner'], 'local')
        with self.assertRaises(AdvancedError):
            self.advanced.dispatch('POST', '/api/pages/welcome/verify', {'owner': 'missing'}, {})
        with self.assertRaises(AdvancedError):
            self.advanced.dispatch('POST', '/api/pages/welcome/verify', {'expires_at': '2020-01-01T00:00:00+00:00'}, {})
        self.advanced.dispatch('DELETE', '/api/pages/welcome/verify', {}, {})
        self.assertNotIn('verification', self.store.get('page', 'welcome'))

    def test_failed_automatic_trigger_preserves_original_row_and_logs_failure(self):
        row = self.workspace.create_row('projects', {'values': {'name': '유지', 'status': '시작 전'}})
        self.advanced.save('automations', {'name': '실패', 'trigger': 'row.created', 'actions': [
            {'type': 'set_property', 'property_id': 'status', 'value': '완료'},
            {'type': 'create_row', 'values': {'unknown_property': 'invalid'}}]})
        self.advanced.trigger('row.created', 'projects', row)
        self.assertEqual(self.store.get('row', row['id'])['properties']['status'], '시작 전')
        self.assertTrue([event for event in self.store.list('audit') if event['action'] == 'automation.failed'])

    def test_scim_pathless_add_members_preserves_existing_members(self):
        users = [self.advanced.save('members', {'email': email}) for email in ['c@example.org', 'd@example.org']]
        _, group = self.advanced.scim('POST', '/scim/v2/Groups', {'displayName': '팀', 'members': [{'value': users[0]['id']}]}, {})
        _, updated = self.advanced.scim('PATCH', '/scim/v2/Groups/' + group['id'], {'Operations': [
            {'op': 'add', 'value': {'members': [{'value': users[1]['id']}]}}]}, {})
        self.assertEqual({m['value'] for m in updated['members']}, {u['id'] for u in users})


if __name__ == '__main__':
    unittest.main()
