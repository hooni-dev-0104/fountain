"""Execute every shared vector; unimplemented events are reported as failures."""
from pathlib import Path
import subprocess
import tempfile
import sys
from contextlib import nullcontext

root = Path(__file__).resolve().parents[3]
keep = '--keep' in sys.argv
arguments = [argument for argument in sys.argv[1:] if argument not in {'--keep', '--wip'}]
native = root / ('.data/ios-provenance-wip-008' if '--wip' in sys.argv else 'apps/mobile/ios/App/App')
workspace = nullcontext(tempfile.mkdtemp(prefix='fountain-ios-reconcile-vectors-')) if keep else tempfile.TemporaryDirectory(prefix='fountain-ios-reconcile-vectors-')
with workspace as temporary:
    if keep: print('Isolated synthetic fixture directory: ' + temporary, flush=True)
    binary = Path(temporary) / 'vectors'
    subprocess.run(['xcrun', 'swiftc', '-D', 'DEBUG', str(native / 'FountainOutbox.swift'),
                    str(native / 'FountainRecovery.swift'),
                    str(root / 'apps/mobile/tests/ios-reconcile-vectors.swift'),
                    str(root / 'apps/mobile/tests/ios-reconcile-vector-driver.swift'), '-lsqlite3', '-o', str(binary)], check=True)
    result = subprocess.run([str(binary), str(root / 'apps/mobile/tests/fixtures/native-reconcile-cases.json'), temporary, *arguments])
    raise SystemExit(result.returncode)
