"""Exercise native-local readable export through production SQLite APIs only."""
from pathlib import Path
import subprocess
import tempfile
import sys
import json

root = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='fountain-ios-native-local-') as temporary:
    binary = Path(temporary) / 'local-export'
    native = '.data/ios-provenance-wip-008' if '--wip' in sys.argv else 'apps/mobile/ios/App/App'
    sources = [native + '/FountainOutbox.swift', native + '/FountainRecovery.swift', 'apps/mobile/tests/ios-reconcile-vectors.swift', 'apps/mobile/tests/ios-reconcile-vector-driver.swift', 'apps/mobile/tests/ios-native-local-export.swift', 'apps/mobile/tests/ios-promotion-bodies.swift']
    subprocess.run(['xcrun', 'swiftc', '-D', 'DEBUG', '-D', 'FOUNTAIN_LOCAL_EXPORT_FIXTURES', *[str(root / source) for source in sources], '-lsqlite3', '-o', str(binary)], check=True)
    arguments = [argument for argument in sys.argv[1:] if argument != '--wip']
    subprocess.run([str(binary), str(root / 'apps/mobile/tests/fixtures/native-reconcile-cases.json'), temporary, *arguments], check=True)
    if '--body' in arguments:
        from ios_native_body_oracle import verify_projection
        verified = []
        for report in sorted(Path(temporary).glob('body-projection-*.json')):
            verify_projection(report.name, json.loads(report.read_text()))
            verified.append(report.stem)
        assert verified, 'No generated body was verified against actual backend CRDT'
        print(json.dumps({'actualBackendCRDTProjection': True, 'verified': verified}, ensure_ascii=False))
