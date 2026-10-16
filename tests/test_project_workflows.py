import http.client
import base64
import json
import threading
import unittest
from datetime import datetime, timezone

from fountain.scheduler import Scheduler
from fountain.server import create_server


class ProjectWorkflowHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(port=0, db_path=':memory:')
        self.app = self.server.application
        self.app.store.put('member', {'id': 'family', 'name': '가족', 'email': 'family@example.org', 'role': 'member'})
        for identity in ('local', 'family'):
            self.app.auth.create_account(identity, 'test-password-123')
        self.app.auth.enable_accounts()
        self.owner = 'fountain_session=' + self.app.auth.login({'email': 'local@fountain.local', 'password': 'test-password-123'})
        self.family = 'fountain_session=' + self.app.auth.login({'email': 'family@example.org', 'password': 'test-password-123'})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.store.close()
        self.thread.join()

    def request(self, method, path, body=None, cookie=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request(method, path, json.dumps(body) if body is not None else None,
                           {'Content-Type': 'application/json', 'X-Fountain-Request': '1', 'Cookie': self.owner if cookie is None else cookie})
        response = connection.getresponse()
        payload = response.read()
        status = response.status
        connection.close()
        return status, json.loads(payload) if payload else None

    def database(self, cookie=None, **extra):
        body = {'name': '일정 테스트', 'properties': [{'id': 'name', 'name': '이름', 'type': 'title'},
            {'id': 'due', 'name': '일정', 'type': 'date'}, {'id': 'assignee', 'name': '담당', 'type': 'person'}],
            'task_settings': {'subitems': True, 'dependencies': True, 'date_property': 'due', 'shift': 'maintain', 'skip_weekends': False}, **extra}
        status, database = self.request('POST', '/api/databases', body, cookie)
        self.assertEqual(status, 201)
        return '/api/databases/' + database['id']

    def row(self, prefix, name, due, **links):
        status, row = self.request('POST', prefix + '/rows', {'properties': {'name': name, 'due': due}, **links})
        self.assertEqual(status, 201)
        return row

    def test_task_graph_shifts_duplicates_cascades_and_remaps_import(self):
        prefix = self.database()
        parent = self.row(prefix, '부모', {'start': '2026-11-02', 'end': '2026-11-03'})
        child = self.row(prefix, '자식', {'start': '2026-11-05', 'end': '2026-11-06'}, parent_row_id=parent['id'], depends_on=[parent['id']])
        tail = self.row(prefix, '후속', '2026-11-08', depends_on=[child['id']])
        path = prefix + '/rows/' + parent['id']
        self.assertEqual(self.request('PATCH', path, {'properties': {'due': {'start': '2026-11-04', 'end': '2026-11-05'}}})[0], 200)
        rows = self.request('GET', prefix)[1]['rows']
        values = {row['id']: row for row in rows}
        self.assertEqual(values[child['id']]['properties']['due'], {'start': '2026-11-07', 'end': '2026-11-08'})
        self.assertEqual(values[tail['id']]['properties']['due'], '2026-11-10')
        self.assertEqual(self.request('PATCH', path, {'depends_on': [child['id']]})[0], 400)
        self.assertEqual(self.request('PATCH', path, {'parent_row_id': child['id']})[0], 400)
        status, duplicate = self.request('POST', path + '/duplicate', {})
        self.assertEqual(status, 201)
        self.assertEqual(len(duplicate['rows']), 2)
        new_parent, new_child = duplicate['rows']
        self.assertEqual(new_child['parent_row_id'], new_parent['id'])
        self.assertEqual(new_child['depends_on'], [new_parent['id']])
        self.assertEqual(new_parent['permissions']['default'], 'private')
        self.assertNotIn(parent['id'], [row['id'] for row in duplicate['rows']])
        self.assertEqual(self.request('DELETE', path)[1]['count'], 2)
        remaining = self.request('GET', prefix)[1]['rows']
        self.assertEqual(next(row for row in remaining if row['id'] == tail['id'])['depends_on'], [])

    def test_hidden_graph_links_stay_private_and_readonly_schedule_is_unchanged(self):
        prefix = self.database()
        parent = self.row(prefix, '보이는 부모', '2026-11-02')
        child = self.row(prefix, '숨긴 자식', '2026-11-04', parent_row_id=parent['id'], depends_on=[parent['id']])
        tail = self.row(prefix, '보이는 후속', '2026-11-06', depends_on=[child['id']])
        for row in (parent, tail):
            self.request('PATCH', prefix + '/rows/' + row['id'], {'properties': {'assignee': 'family'}})
        self.request('PATCH', prefix + '/rows/' + child['id'], {'properties': {'assignee': 'local'}})
        self.request('PATCH', prefix + '/permissions', {'row_permissions': {'mode': 'assigned', 'property_id': 'assignee', 'edit_assigned': True, 'allow_create': True}})
        visible = self.request('GET', prefix, cookie=self.family)[1]['rows']
        self.assertEqual(next(row for row in visible if row['id'] == tail['id'])['depends_on'], [])
        self.assertEqual(self.request('PATCH', prefix + '/rows/' + parent['id'], {'properties': {'due': '2026-11-10'}}, self.family)[0], 200)
        self.assertEqual(self.app.store.get('row', child['id'])['properties']['due'], '2026-11-04')
        self.assertEqual(self.app.store.get('row', tail['id'])['properties']['due'], '2026-11-06')
        self.assertEqual(self.request('PATCH', prefix + '/rows/' + tail['id'], {'depends_on': []}, self.family)[0], 200)
        self.assertEqual(self.app.store.get('row', tail['id'])['depends_on'], [child['id']])
        self.assertEqual(self.request('DELETE', prefix + '/rows/' + parent['id'], cookie=self.family)[0], 403)
        self.assertEqual(self.request('POST', prefix + '/rows/' + parent['id'] + '/duplicate', {}, self.family)[0], 403)
        self.assertIsNotNone(self.app.store.get('row', parent['id']))

    def test_json_import_rebuilds_task_links_and_rejects_cycles_atomically(self):
        content = {'pages': [], 'databases': [{'id': 'old-db', 'name': '가져온 일정', 'properties': [{'id': 'name', 'name': '이름', 'type': 'title'}],
            'task_settings': {'subitems': True, 'dependencies': True, 'shift': 'none'}}], 'rows': [
                {'id': 'old-a', 'database_id': 'old-db', 'properties': {'name': 'A'}},
                {'id': 'old-b', 'database_id': 'old-db', 'properties': {'name': 'B'}, 'parent_row_id': 'old-a', 'depends_on': ['old-a']} ]}
        status, imported = self.request('POST', '/api/import', {'format': 'json', 'content': json.dumps(content)})
        self.assertEqual(status, 201)
        rows = self.request('GET', '/api/databases/' + imported['databases'][0])[1]['rows']
        parent = next(row for row in rows if row['properties']['name'] == 'A')
        child = next(row for row in rows if row['properties']['name'] == 'B')
        self.assertEqual(child['parent_row_id'], parent['id'])
        self.assertEqual(child['depends_on'], [parent['id']])
        before = len(self.app.store.list('database'))
        content['rows'][0]['depends_on'] = ['old-b']
        self.assertEqual(self.request('POST', '/api/import', {'format': 'json', 'content': json.dumps(content)})[0], 400)
        self.assertEqual(len(self.app.store.list('database')), before)

    def schedule(self, prefix, actions, cookie=None):
        status, automation = self.request('POST', '/api/automations', {'name': '예약 작업', 'database_id': prefix.rsplit('/', 1)[1],
            'trigger': 'scheduled', 'schedule': {'frequency': 'minutes', 'interval': 1, 'timezone': 'Asia/Seoul', 'start_at': '2030-01-01T00:00:00+00:00'},
            'actions': actions}, cookie)
        self.assertEqual(status, 201)
        return automation

    def test_scheduler_creates_real_rows_once_and_keeps_failed_actions_atomic(self):
        prefix = self.database()
        success = self.schedule(prefix, [{'type': 'create_row', 'values': {'name': '예약으로 생성'}}])
        now = datetime(2030, 1, 1, tzinfo=timezone.utc)
        runs = self.app.scheduler.tick(now)
        self.assertEqual(runs[0]['status'], 'succeeded')
        rows = self.request('GET', prefix)[1]['rows']
        self.assertEqual([row['properties']['name'] for row in rows], ['예약으로 생성'])
        self.assertEqual(Scheduler(self.app.store, self.app.run_scheduled).tick(now), [])
        history = self.request('GET', '/api/automations/' + success['id'] + '/runs')
        self.assertEqual(history[0], 200)
        self.assertNotIn('result', history[1]['runs'][0])
        self.assertEqual(self.request('GET', '/api/automations/' + success['id'] + '/runs', cookie=self.family)[0], 403)
        failure = self.schedule(prefix, [{'type': 'create_row', 'values': {'name': '되돌릴 행'}}, {'type': 'create_row', 'values': {'unknown': '실패'}}])
        self.app.scheduler.tick(now)
        self.assertEqual(len(self.request('GET', prefix)[1]['rows']), 1)
        self.assertEqual(self.request('GET', '/api/automations/' + failure['id'] + '/runs')[1]['runs'][0]['status'], 'failed')
        self.assertTrue(self.app.store.get('automation', failure['id'])['next_run_at'] > now.isoformat())

    def test_scheduler_rechecks_author_database_permissions_and_stamps_real_actor(self):
        prefix = self.database(cookie=self.family)
        job = self.schedule(prefix, [{'type': 'create_row', 'values': {'name': '가족 작업'}}], self.family)
        self.app.scheduler.tick(datetime(2030, 1, 1, tzinfo=timezone.utc))
        row = self.request('GET', prefix, cookie=self.family)[1]['rows'][0]
        self.assertEqual(row['owner_id'], 'family')
        events = [event for event in self.app.store.list('audit') if event['action'] == 'row.created' and event['details'].get('row_id') == row['id']]
        self.assertEqual(events[0]['user'], 'family')
        # Full access can be granted and then revoked on a database owned by someone else.
        other = self.database()
        self.request('PATCH', other + '/permissions', {'permissions': {'default': 'workspace', 'members': {'family': 'full'}}})
        denied = self.schedule(other, [{'type': 'create_row', 'values': {'name': '권한 없음'}}], self.family)
        self.request('PATCH', other + '/permissions', {'permissions': {'default': 'workspace'}})
        self.app.scheduler.tick(datetime(2030, 1, 1, tzinfo=timezone.utc))
        self.assertEqual(self.request('GET', other)[1]['rows'], [])
        self.assertEqual(self.request('GET', '/api/automations/' + denied['id'] + '/runs')[1]['runs'][0]['status'], 'failed')

    def test_automation_actions_cannot_grant_access_to_an_unreadable_file(self):
        attachment = self.request('POST', '/api/attachments', {'name': 'owner-only.txt', 'data': base64.b64encode(b'owner-only').decode()})[1]
        prefix = self.database(cookie=self.family, task_settings={'shift':'none'}, properties=[{'id': 'name', 'name': '이름', 'type': 'title'}, {'id': 'files', 'name': '파일', 'type': 'files'}])
        status, automation = self.request('POST', '/api/automations', {'name': '파일 작업', 'database_id': prefix.rsplit('/', 1)[1],
            'actions': [{'type': 'create_row', 'values': {'name': '파일', 'files': [attachment['id']]}}]}, self.family)
        self.assertEqual(status, 201)
        self.assertEqual(self.request('POST', '/api/automations/' + automation['id'] + '/run', {}, self.family)[0], 404)
        self.assertEqual(self.request('GET', prefix, cookie=self.family)[1]['rows'], [])
        private = self.request('GET', '/api/attachments/' + attachment['id'] + '/download', cookie=self.family)
        missing = self.request('GET', '/api/attachments/not-present/download', cookie=self.family)
        self.assertEqual(private, missing)

    def test_date_time_shifts_keep_offsets_and_bad_ranges_leave_rows_unchanged(self):
        prefix = self.database()
        parent = self.row(prefix, '시간 A', {'start': '2026-11-02T09:00:00+09:00', 'end': '2026-11-02T10:00:00+09:00', 'time_zone': 'Asia/Seoul'})
        child = self.row(prefix, '시간 B', {'start': '2026-11-02T11:00:00+09:00', 'end': '2026-11-02T12:00:00+09:00'}, depends_on=[parent['id']])
        path = prefix + '/rows/' + parent['id']
        self.assertEqual(self.request('PATCH', path, {'properties': {'due': {'start': '2026-11-02T10:00:00+09:00', 'end': '2026-11-02T11:00:00+09:00'}}})[0], 200)
        shifted = self.app.store.get('row', child['id'])['properties']['due']
        self.assertEqual(shifted, {'start': '2026-11-02T12:00:00+09:00', 'end': '2026-11-02T13:00:00+09:00'})
        before = self.app.store.get('row', parent['id'])['properties']['due']
        self.assertEqual(self.request('PATCH', path, {'properties': {'due': {'start': '2026-11-03', 'end': '2026-11-01'}}})[0], 400)
        self.assertEqual(self.app.store.get('row', parent['id'])['properties']['due'], before)

    def test_schema_changes_cannot_break_the_active_task_date_property(self):
        prefix = self.database()
        properties = [{'id': 'name', 'name': '이름', 'type': 'title'}]
        self.assertEqual(self.request('PATCH', prefix, {'properties': properties})[0], 400)
        self.assertIn('due', [prop['id'] for prop in self.request('GET', prefix)[1]['database']['properties']])
        self.assertEqual(self.request('PATCH', prefix, {'properties': properties, 'task_settings': {'shift': 'none'}})[0], 200)


if __name__ == '__main__': unittest.main()
