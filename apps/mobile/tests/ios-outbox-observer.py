"""Compile/run actual Swift observer against OS SQLite in an isolated directory.

No Swift source rewriting, simulator launch, home override or Keychain access.
This macOS execution does not prove iOS file protection or bridge delivery.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='fountain-ios-observer-') as temporary:
    binary = Path(temporary) / 'observer'
    subprocess.run([
        'xcrun', 'swiftc', '-D', 'DEBUG',
        str(ROOT / 'apps/mobile/ios/App/App/FountainOutbox.swift'),
        str(ROOT / 'apps/mobile/tests/ios-outbox-observer.swift'),
        '-lsqlite3', '-o', str(binary),
    ], check=True)
    subprocess.run([str(binary), temporary], check=True)
