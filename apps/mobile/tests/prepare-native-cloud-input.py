"""Deliver disposable login input privately to dedicated native QA apps only.

No secret is placed in a command argument, tracked file or diagnostic output.
The outer sealed-function nonce is never delivered to either native application.
"""
import argparse, json, os, subprocess
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('platform',choices=['android','ios'])
parser.add_argument('--device',required=True)
parser.add_argument('--config',type=Path,default=Path('.data/cloud-account-qa.json'))
parser.add_argument('--adb',default='/opt/homebrew/share/android-commandlinetools/platform-tools/adb')
options=parser.parse_args()
assert options.config.stat().st_mode&0o777==0o600, 'Disposable input must be private'
config=json.loads(options.config.read_text())
assert config['workspaceId']=='fountain-qa-cloud-accounts-75254a74761a4888'
value={'origin':'https://10.0.2.2:61603' if options.platform=='android' else 'https://127.0.0.1:61603',
       'workspaceId':config['workspaceId'],'email':config['emails'][0],'password':config['passwords'][0]}
encoded=json.dumps(value).encode()
if options.platform=='android':
    name=subprocess.check_output([options.adb,'-s',options.device,'emu','avd','name'],text=True).replace('\r','').splitlines()[0]
    assert name=='FountainRecoveryQA', 'Only the dedicated QA AVD is permitted'
    command="run-as dev.fountain.workspace sh -c 'umask 077; set -C; cat > files/fountain-cloud-native-qa.json'"
    subprocess.run([options.adb,'-s',options.device,'shell',command],input=encoded,check=True,capture_output=True)
else:
    devices=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','--json'],text=True))['devices']
    selected=[device for group in devices.values() for device in group if device['udid']==options.device]
    assert len(selected)==1 and selected[0]['name'].startswith('Fountain QA') and selected[0]['state']=='Booted', 'Only a booted dedicated QA Simulator is permitted'
    container=Path(subprocess.check_output(['xcrun','simctl','get_app_container',options.device,'dev.fountain.workspace','data'],text=True).strip())
    target=container/'Library/Caches/fountain-cloud-native-qa.json';target.parent.mkdir(parents=True,exist_ok=True)
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'wb') as output:output.write(encoded)
print(json.dumps({'prepared':True,'platform':options.platform,'fixedDisposableWorkspace':True}))
