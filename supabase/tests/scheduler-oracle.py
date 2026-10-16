"""Read-only calendar oracle. No server, credentials, network or persistent DB."""
import json
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from fountain.core import APIError
from fountain.scheduler import validate_schedule, next_occurrence

result = []
for case in json.load(sys.stdin):
    try:
        value = validate_schedule(case['schedule']) if case['method'] == 'validate' else next_occurrence(case['schedule'], case['after'])
        result.append({'ok': value})
    except APIError as error:
        result.append({'error': error.status})
json.dump(result, sys.stdout, ensure_ascii=False)
