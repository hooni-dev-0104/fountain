"""Run production account URLSession and actual SQLite workspace switching."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='fountain-ios-multiworkspace-') as temporary:
    binary = Path(temporary) / 'multiworkspace'
    sources = ['FountainCookieHeaders.swift', 'FountainAccount.swift', 'FountainWorkspace.swift', 'FountainOutbox.swift', 'FountainRecovery.swift']
    subprocess.run(['xcrun', 'swiftc', '-D', 'DEBUG', *[str(root / 'apps/mobile/ios/App/App' / source) for source in sources], str(root / 'apps/mobile/tests/ios-multiworkspace.swift'), '-lsqlite3', '-o', str(binary)], check=True)
    subprocess.run([str(binary), temporary], check=True)
