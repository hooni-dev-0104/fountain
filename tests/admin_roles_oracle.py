"""Real SQLite protocol oracle for the independent TypeScript implementation."""
import json
import sys
from unittest.mock import patch

from fountain.access import Access
from fountain.admin_roles import AdminAuthority, invalidate_member
from fountain.core import APIError, Store
from tests.test_admin_roles import fixture, STAMP


def run(cases):
    output = []
    for case in cases:
        store = Store(':memory:')
        counter = 100

        def nonce(_store, _kind):
            nonlocal counter
            counter += 1
            return f'{counter:032x}'

        with patch('fountain.core.now', return_value=STAMP), patch('fountain.admin_roles._nonce', side_effect=nonce):
            fixture(store)
            for change in case.get('changes', []):
                if change['op'] == 'put':
                    store.put(change['kind'], change['value'])
                elif change['op'] == 'delete':
                    store.delete(change['kind'], change['id'])
                elif change['op'] == 'rotate':
                    invalidate_member(store, change['id'])
                else:
                    store.set_meta(change['key'], change['value'])
            results = []
            for step in case['steps']:
                actor = step.get('actor', 'local')
                principal = step.get('principal', store.get('member', actor))
                authority = AdminAuthority(store, Access(store, principal))
                body = dict(step.get('body', {}))
                if body.get('revision') == '$current':
                    body['revision'] = AdminAuthority(store, Access(store, store.get('member', 'local'))).overview()['revision']
                try:
                    results.append({'status': 200, 'body': authority.route(step.get('method', 'GET'), step.get('path', '/api/admin/roles'), body, step.get('query', {}))})
                except APIError as error:
                    results.append({'status': error.status, 'error': str(error)})
            output.append(results)
        store.close()
    return output


if __name__ == '__main__':
    print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=True))
