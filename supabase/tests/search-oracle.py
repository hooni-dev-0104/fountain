"""Disposable SQLite oracle for the public advanced-search result contract."""
import json
import pathlib
import sys
from urllib.parse import parse_qs

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from fountain.core import APIError, Store
from fountain.access import Access
from fountain.search import advanced_search


def main():
    spec = json.load(sys.stdin)
    store = Store(':memory:')
    store.set_meta('workspace_id', 'advanced-search-fixture')
    for kind, values in spec['records'].items():
        for value in values:
            store.db.execute('INSERT INTO entities VALUES (?,?,?,?,?)',
                             (kind, value['id'], json.dumps(value, ensure_ascii=False),
                              value.get('created_at') or '', value.get('updated_at') or ''))
    store.db.commit()
    results = []
    for case in spec['cases']:
        access = Access(store, store.get('member', case['member']))
        try:
            query = parse_qs(case['query'], keep_blank_values=True)
            results.append({'ok': advanced_search(store, access, query)})
        except APIError as error:
            results.append({'status': error.status})
    json.dump(results, sys.stdout, ensure_ascii=False, allow_nan=False)
    store.close()


if __name__ == '__main__':
    main()
