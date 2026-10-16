"""Bounded, in-memory Python oracle. No server, database, account or network I/O."""
import copy
from datetime import datetime, date
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fountain.core import APIError, formula_tree, evaluate_formula
from fountain import tasks

class Memory:
    def __init__(self, entities):
        self.entities = copy.deepcopy(entities)
    def list(self, kind):
        return copy.deepcopy(self.entities.get(kind, []))
    def get(self, kind, identity):
        return next((row for row in self.list(kind) if row['id'] == identity), None)

def point(value):
    if isinstance(value, datetime):
        offset = value.utcoffset()
        micro = offset.days * 86400000000 + offset.seconds * 1000000 + offset.microseconds
        clock = (value.hour * 3600 + value.minute * 60 + value.second) * 1000000 + value.microsecond
        return {'kind': 'datetime', 'value': str((value.toordinal() - 719163) * 86400000000 + clock - micro), 'offset': str(micro)}
    return {'kind': 'date', 'value': str((value.toordinal() - 719163) * 86400000000), 'offset': '0'}

def run(case):
    operation = case['operation']
    if operation == 'formula':
        def get(key):
            if key not in case.get('values', {}):
                raise ValueError('Unknown property: ' + key)
            return case['values'][key]
        return evaluate_formula(formula_tree(case['source']), get)
    if operation == 'date': return tasks.validate_date_value(case['value'])
    if operation == 'parse_date':
        span = tasks.parse_date_value(case['value'])
        return None if span is None else [point(value) for value in span]
    if operation == 'settings': return tasks.validate_settings(case['body'], case['database'])
    store = Memory(case.get('entities', {}))
    original = copy.deepcopy(store.entities)
    counter = iter(range(10001))
    tasks.uid = lambda: 'copy-' + str(next(counter))
    graph = tasks.TaskGraph(store)
    denied = set(case.get('denied', []))
    can = lambda row: row['id'] not in denied
    if operation == 'prepare': result = graph.prepare_row(case['database'], case['id'], case['body'], case.get('existing'), case.get('rows'))
    elif operation == 'descendants': result = graph.descendants(case['databaseId'], case['id'])
    elif operation == 'duplicate': result = graph.duplicate_plan(case['databaseId'], case['id'], case.get('owner', 'copier'), can)
    elif operation == 'shift': result = graph.plan_shift(case['database'], case['old'], case['candidate'], can)
    else: raise ValueError('Unknown fixture action')
    assert store.entities == original, 'Task planning unexpectedly wrote its source'
    return result

raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
if len(raw) > 8 * 1024 * 1024: raise ValueError('Oracle input too large')
cases = json.loads(raw)
if not isinstance(cases, list) or len(cases) > 2000: raise ValueError('Oracle case bound exceeded')
results = []
for case in cases:
    try: results.append({'value': run(case)})
    except Exception as error:
        results.append({'error': {'status': error.status if isinstance(error, APIError) else None, 'message': str(error)}})
print(json.dumps(results, ensure_ascii=True, allow_nan=False))
