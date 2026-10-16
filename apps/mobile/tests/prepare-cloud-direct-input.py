"""Opt in to one anonymous native HTTPS routing check on dedicated QA devices.

Input contains a public project origin only. It grants no login authority and
does not enable a verifier, create users, or change any cloud data.
"""
import argparse
import json
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('platform', choices=['android', 'ios'])
parser.add_argument('--device', required=True)
parser.add_argument('--adb', default='/opt/homebrew/share/android-commandlinetools/platform-tools/adb')
options = parser.parse_args()
payload = json.dumps({'origin': 'https://ehnovtfadpkwtubmwltl.supabase.co'}).encode()
filename = 'fountain-cloud-direct-input.json'

if options.platform == 'android':
    name = subprocess.check_output(
        [options.adb, '-s', options.device, 'emu', 'avd', 'name'], text=True
    ).replace('\r', '').splitlines()[0]
    if name != 'FountainRecoveryQA':
        raise SystemExit('Only the dedicated FountainRecoveryQA AVD is permitted')
    booted = subprocess.check_output(
        [options.adb, '-s', options.device, 'shell', 'getprop', 'sys.boot_completed'], text=True
    ).strip()
    if booted != '1':
        raise SystemExit('The dedicated QA AVD must finish booting first')
    subprocess.run([options.adb, '-s', options.device, 'shell', 'run-as',
                    'dev.fountain.workspace', 'mkdir', '-p', 'files'], check=True, capture_output=True)
    command = "run-as dev.fountain.workspace sh -c 'umask 077; set -C; cat > files/" + filename + "'"
    subprocess.run([options.adb, '-s', options.device, 'shell', command], input=payload,
                   check=True, capture_output=True)
else:
    devices = json.loads(subprocess.check_output(
        ['xcrun', 'simctl', 'list', 'devices', '--json'], text=True
    ))['devices']
    selected = [d for group in devices.values() for d in group if d['udid'] == options.device]
    if len(selected) != 1 or not selected[0]['name'].startswith('Fountain QA') or selected[0]['state'] != 'Booted':
        raise SystemExit('Only a booted dedicated Fountain QA Simulator is permitted')
    container = Path(subprocess.check_output(
        ['xcrun', 'simctl', 'get_app_container', options.device, 'dev.fountain.workspace', 'data'], text=True
    ).strip())
    target = container / 'Documents' / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(payload)

print(json.dumps({'prepared': True, 'platform': options.platform,
                  'anonymousGETOnly': True, 'credentialsIncluded': False}))
