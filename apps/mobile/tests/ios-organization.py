"""Exercise the production organization transport without credentials or devices."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='fountain-ios-organization-') as temporary:
    binary = Path(temporary) / 'organization'
    sources = ['apps/mobile/ios/App/App/FountainOrganization.swift',
               'apps/mobile/ios/App/App/FountainOutbox.swift',
               'apps/mobile/ios/App/App/FountainRecovery.swift',
               'apps/mobile/tests/ios-organization.swift']
    subprocess.run(['xcrun', 'swiftc', '-D', 'DEBUG', *[str(root / source) for source in sources], '-lsqlite3', '-o', str(binary)], check=True)
    subprocess.run([str(binary), temporary], check=True)
