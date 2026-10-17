"""Run the same production helper and actual native SQLite effect guards."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='fountain-session-logout-') as temporary:
    binary = Path(temporary) / 'logout'
    subprocess.run(['xcrun', 'swiftc', '-D', 'DEBUG', *[str(ROOT / path) for path in [
        'apps/mobile/ios/App/App/FountainSessionLogout.swift', 'apps/mobile/ios/App/App/FountainOutbox.swift',
        'apps/mobile/ios/App/App/FountainRecovery.swift', 'apps/mobile/tests/ios-session-logout-fixture.swift',
    ]], '-lsqlite3', '-o', str(binary)], check=True)
    subprocess.run([str(binary), temporary], check=True)
