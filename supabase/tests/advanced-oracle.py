"""Disposable SQLite behavioral oracle for staged Advanced/publishing/SCIM."""
import copy
import json
import os
import pathlib
import sys
from datetime import datetime
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from fountain import core, crdt, tasks, advanced
from fountain.access import Access
from fountain.scheduler import Scheduler

TIME = '2026-10-16T00:00:00.123000+00:00'
counter = 0
def identity():
    global counter
    counter += 1
    return f'generated-{counter:04}'

core.uid = crdt.uid = tasks.uid = identity
advanced.uuid4 = identity
core.now = lambda: TIME

def main():
    spec = json.load(sys.stdin)
    advanced.now = lambda: spec.get('clockISO', TIME)
    advanced.time.time = lambda: datetime.fromisoformat(spec.get('clockISO', TIME)).timestamp()
    os.environ.clear()
    os.environ.update(spec.get('env', {}))
    store = core.Store(':memory:')
    workspace = core.Workspace.__new__(core.Workspace)
    workspace.store, workspace.lock = store, store.lock
    for key, value in spec.get('meta', {}).items(): store.set_meta(key, value)
    for kind, values in spec.get('records', {}).items():
        for value in values: store.put(kind, value)
    actor = core.AUDIT_ACTOR.set(spec.get('actor', 'local'))
    access = Access(store, store.get('member', spec.get('actor', 'local'))) if spec.get('access') else None
    access_token = core.CURRENT_ACCESS.set(access)
    service = advanced.Advanced(store, workspace)
    refs, results = {}, []
    def resolve(value):
        if isinstance(value, dict) and set(value) == {'$ref'}:
            parts = value['$ref'].split('.'); result = refs[parts.pop(0)]
            for key in parts: result = result[int(key)] if isinstance(result, list) else result[key]
            return copy.deepcopy(result)
        if isinstance(value, list): return [resolve(item) for item in value]
        if isinstance(value, dict): return {key: resolve(item) for key, item in value.items()}
        return value
    for operation in spec['operations']:
        try:
            args = resolve(operation.get('args', []))
            with store.transaction():
                if operation['method'].startswith('workspace.'):
                    result = getattr(workspace, operation['method'].split('.')[1])(*args)
                elif operation['method'] in ('scim_patch_user','scim_patch_group','scim_delete_user'):
                    category = 'Groups' if operation['method'] == 'scim_patch_group' else 'Users'
                    method = 'DELETE' if operation['method'] == 'scim_delete_user' else 'PATCH'
                    result = service.scim(method, '/scim/v2/' + category + '/' + args[0], args[1] if len(args)>1 else {}, {})
                elif operation['method'] == 'form_public':
                    result = service.public_view('/forms/' + args[0])
                elif operation['method'] == 'scheduler.tick':
                    result = Scheduler(store, service.run_as_author).tick(*args)
                else: result = getattr(service, operation['method'])(*args)
            if operation['method'] in ('dispatch', 'public_view', 'scim', 'form_public', 'scim_patch_user', 'scim_patch_group', 'scim_delete_user') and isinstance(result, tuple):
                result = {'status': result[0], 'payload': result[1]}
            if operation.get('as'): refs[operation['as']] = copy.deepcopy(result)
            results.append({'ok': result})
        except core.APIError as error:
            results.append({'error': {'status': error.status, 'message': error.message}})
        except Exception as error:
            results.append({'unexpected': {'type': type(error).__name__, 'message': str(error)}})
    kinds = [row[0] for row in store.db.execute('SELECT DISTINCT kind FROM entities ORDER BY kind')]
    json.dump({'results': results, 'records': {kind: store.list(kind) for kind in kinds}, 'revision': store.meta('_entity_revision', 0)}, sys.stdout, ensure_ascii=False)
    core.AUDIT_ACTOR.reset(actor); core.CURRENT_ACCESS.reset(access_token);store.close()

if __name__ == '__main__': main()
