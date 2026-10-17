"""Replay synthetic native-generated bodies through the actual backend CRDT."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from fountain import crdt


def verify_projection(name, result):
    operations = [{key: value for key, value in operation.items() if key != '_epoch'} for operation in result['operations']]
    state = crdt.seed_state([])
    for offset in range(0, len(operations), 1000):
        state = crdt.apply_operations(state, operations[offset:offset + 1000])
    actual, expected = crdt.project(state), crdt.normalize_blocks(result['expected'])

    def normalized(blocks):
        positions = {block['id']: index for index, block in enumerate(blocks)}
        return [{**{key: value for key, value in block.items() if key not in {'id', 'parent_id'}}, 'parent_index': positions.get(block.get('parent_id'))} for block in blocks]

    assert normalized(actual) == normalized(expected), name + ': backend projection differs from complete readable body'
    assert normalized(result['draft']['blocks']) == normalized(expected), name + ': native draft mirror differs'


if __name__ == '__main__':
    report = json.loads(Path(sys.argv[1]).read_text())
    assert report['platform'] == 'iOS' and report['actualProductionSwiftSQLite'] is True
    assert len(report['bodies']['passed']) == 18 and report['bodies']['skipped'] == 0
    expected = {'body-projection-' + name for name in [
        'complete-body-format-and-unicode', 'same-body-tied-drafts-each-cover-pending',
        'latest-matching-snapshot-seen-covers-unseen-draft', 'complete-snapshot-fallback-all-pending-seen',
        'plain-50000-boundary', 'bold-25000-boundary',
    ]}
    entries = report['syntheticBackendProjections']
    assert len(entries) == len(expected) and {entry['case'] for entry in entries} == expected
    for entry in entries:
        verify_projection(entry['case'], entry['projection'])
    print(json.dumps({'actualBackendCRDTProjection': True, 'sourcePlatform': 'iOS', 'verified': sorted(expected)}))
