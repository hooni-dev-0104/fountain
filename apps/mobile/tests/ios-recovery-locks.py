"""A separate process probes the real SQLite reserved lock; no simulated ledger."""
from pathlib import Path
import subprocess
import tempfile
import sys
import re

root = Path(__file__).resolve().parents[3]
source = (root / 'apps/mobile/ios/App/App/FountainRecovery.swift').read_text()
assert not re.search(r'Darwin\.open\((?:candidate|path)\.path', source), 'Database descriptors must belong to SQLite'
assert source.count('SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW') == 2
with tempfile.TemporaryDirectory(prefix='fountain-recovery-locks-') as temporary:
    binary = Path(temporary) / 'locks'
    subprocess.run(['xcrun', 'swiftc', '-D', 'DEBUG', str(root / 'apps/mobile/ios/App/App/FountainOutbox.swift'), str(root / 'apps/mobile/ios/App/App/FountainRecovery.swift'), str(root / 'apps/mobile/tests/ios-recovery-locks.swift'), '-lsqlite3', '-o', str(binary)], check=True)
    subprocess.run([str(binary), temporary, sys.executable] + sys.argv[1:], check=True)
