"""Deliver a private, one-use real-cloud client fixture to dedicated QA devices.

This does not provision accounts, deploy functions or print credentials. Root
must first prepare a fresh scoped backend and clean it up after device tests.
"""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('platform',choices=['android','ios'])
parser.add_argument('--device',required=True)
parser.add_argument('--input',default='.data/cloud-native-client-qa.json')
parser.add_argument('--adb',default='/opt/homebrew/share/android-commandlinetools/platform-tools/adb')
args=parser.parse_args()
source=Path(args.input)
try:
    info=source.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>16384:
        raise ValueError()
    with os.fdopen(os.open(source,os.O_RDONLY|os.O_NOFOLLOW),'rb') as handle:
        opened=os.fstat(handle.fileno())
        if (opened.st_ino,opened.st_dev)!=(info.st_ino,info.st_dev):raise ValueError()
        private=json.loads(handle.read(16385))
    scope=private['scope'];workspace=scope['workspaceId']
    if not re.fullmatch(r'fountain-qa-cloud-native-[a-f0-9]{16}',workspace):raise ValueError()
    for key in ['nonce','bootstrapNonce']:
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}',private[key]):raise ValueError()
    digest=lambda value:hashlib.sha256(value.encode()).hexdigest()
    if digest(private['nonce'])!=scope['challengeHash'] or digest(private['bootstrapNonce'])!=scope['nonceHash']:raise ValueError()
    suffix=workspace.rsplit('-',1)[1]
    if scope['emails']!=[suffix+'-owner@fountain.invalid',suffix+'-child@fountain.invalid']:raise ValueError()
    if not re.fullmatch(r'[a-f0-9]{64}',private['passwords'][0]):raise ValueError()
    payload=json.dumps({'origin':'https://ehnovtfadpkwtubmwltl.supabase.co','workspaceId':workspace,
        'email':scope['emails'][0],'password':private['passwords'][0],
        'bootstrapNonce':private['bootstrapNonce'],'nonce':private['nonce'],'phase':args.platform}).encode()
except (OSError,KeyError,ValueError,TypeError,IndexError):
    raise SystemExit('A valid private disposable native QA configuration is required') from None

filename='fountain-cloud-client-input.json'
if args.platform=='android':
    name=subprocess.check_output([args.adb,'-s',args.device,'emu','avd','name'],text=True).replace('\r','').splitlines()[0]
    if name!='FountainRecoveryQA':raise SystemExit('Only FountainRecoveryQA is permitted')
    boot=subprocess.check_output([args.adb,'-s',args.device,'shell','getprop','sys.boot_completed'],text=True).strip()
    if boot!='1':raise SystemExit('The dedicated QA AVD must finish booting first')
    subprocess.run([args.adb,'-s',args.device,'shell','run-as','dev.fountain.workspace','mkdir','-p','files'],check=True,capture_output=True)
    command="run-as dev.fountain.workspace sh -c 'umask 077; set -C; cat > files/"+filename+"'"
    subprocess.run([args.adb,'-s',args.device,'shell',command],input=payload,check=True,capture_output=True)
else:
    devices=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','--json'],text=True))['devices']
    selected=[value for group in devices.values() for value in group if value['udid']==args.device]
    if len(selected)!=1 or selected[0]['name']!='Fountain QA' or selected[0]['state']!='Booted':raise SystemExit('Only the booted Fountain QA Simulator is permitted')
    container=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,'dev.fountain.workspace','data'],text=True).strip())
    target=container/'Documents'/filename;target.parent.mkdir(parents=True,exist_ok=True)
    with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as output:output.write(payload)
print(json.dumps({'prepared':True,'platform':args.platform,'actualCloudQA':True,'privateValuesPrinted':False}))
