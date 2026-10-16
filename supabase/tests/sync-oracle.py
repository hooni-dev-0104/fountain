"""Real Python SyncService + authorized Application routes, ephemeral SQLite only."""
import copy
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from fountain import core, crdt, tasks
from fountain.access import Access
from fountain.auth import Auth
from fountain.server import Application
from fountain.sync import SyncService

TIME = '2026-10-16T00:00:00.123000+00:00'
counter = 0
def uid():
    global counter
    counter += 1
    return f'oracle-{counter:04}'
core.uid = crdt.uid = tasks.uid = uid
core.now = lambda: TIME

def main():
    spec = json.load(sys.stdin)
    if 'digests' in spec:
        for value in spec['digests']:
            for path in spec.get('float_paths', []):
                target = value
                for key in path[:-1]: target = target[key]
                target[path[-1]] = float(target[path[-1]])
        json.dump([{'canonical': json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')),
                    'digest': SyncService._digest(value)} for value in spec['digests']], sys.stdout, ensure_ascii=False)
        return
    store = core.Store(':memory:')
    workspace = core.Workspace.__new__(core.Workspace); workspace.store, workspace.lock = store, store.lock
    for key, value in spec.get('meta', {}).items(): store.set_meta(key, value)
    for kind, records in spec.get('records', {}).items():
        for value in records: store.put(kind, value)
    app = Application.__new__(Application); app.store, app.workspace, app.auth, app.advanced = store, workspace, Auth(store), None
    service = SyncService(store)
    actor = spec.get('actor', 'alice')
    def context(): return {'access': Access(store, store.get('member', actor)), 'workspace_id': store.meta('workspace_id'), 'session_binding': spec.get('binding', 'binding-a')}
    def dispatch(method, path, body, current): return app.dispatch(method, path, body, {}, principal=current['access'].principal)
    results = []
    for body in spec['batches']:
        try: results.append({'ok': service.apply(copy.deepcopy(body), context, dispatch)})
        except core.APIError as error: results.append({'error': {'status': error.status, 'message': error.message}})
    kinds = [row[0] for row in store.db.execute('SELECT DISTINCT kind FROM entities ORDER BY kind')]
    records = {kind: store.list(kind) for kind in kinds}
    for audit in records.get('audit', []): del audit['id']
    if 'audit' in records: records['audit'].sort(key=lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False))
    json.dump({'results': results, 'records': records, 'revision': store.meta('_entity_revision', 0)}, sys.stdout, ensure_ascii=False)
    store.close()

if __name__ == '__main__': main()
