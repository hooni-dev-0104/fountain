"""Run the explicitly authorized, disposable real native bridge fixture.

Never puts credentials in argv, a bundle, a generated source, or the log. Only the
fresh FountainMultiworkspaceQA AVD is accepted. The input file is consumed by the
instrumentation before activity/network; the finally block erases app data.
"""
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
ADB=Path('/opt/homebrew/share/android-commandlinetools/platform-tools/adb')
SERIAL='emulator-5584'
QA=ROOT/'.data/multiworkspace'
FIXTURE=QA/'actual/native-private-fixture.json'
INPUT='files/fountain-multiworkspace-native-input.json'
OUTPUT='files/fountain-multiworkspace-native-result.json'

def adb(*args,**kwargs):
    return subprocess.run([str(ADB),'-s',SERIAL,*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)

def main():
    name=adb('emu','avd','name').stdout.decode().replace('\r','').splitlines()[0]
    if name!='FountainMultiworkspaceQA':raise SystemExit('Refusing to touch a non-QA AVD')
    info=FIXTURE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode&0o777!=0o600 or info.st_uid!=os.getuid():raise SystemExit('Private regular opt-in file required')
    fd=os.open(FIXTURE,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as source:secret=source.read(16385)
    if not secret or len(secret)>16384:raise SystemExit('Opt-in file bound failed')
    adb('install','-r',str(ROOT/'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'))
    adb('install','-r',str(ROOT/'apps/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'))
    adb('shell','pm','clear','dev.fountain.workspace')
    try:
        adb('shell','run-as','dev.fountain.workspace','mkdir','-p','files')
        adb('shell','run-as','dev.fountain.workspace','sh','-c',f'"umask 077; cat > {INPUT}"',input=secret)
        secret=b''
        result=adb('shell','am','instrument','-w','-e','class','dev.fountain.workspace.CloudMultiworkspaceDeviceTest','dev.fountain.workspace.test/androidx.test.runner.AndroidJUnitRunner')
        log=QA/'android-cloud-device.log';log.write_bytes(result.stdout+result.stderr);os.chmod(log,0o600)
        text=log.read_text()
        if 'OK (1 test)' not in text or 'FAILURES' in text:
            print(text)
            raise SystemExit('Actual native bridge fixture failed; inspect the sanitized log')
        proof=adb('exec-out','run-as','dev.fountain.workspace','cat',OUTPUT).stdout
        target=QA/'android-cloud-result.json';target.write_bytes(proof);os.chmod(target,0o600)
        print('PASS actual production native bridge/HTTPS account login, scoped A/B/A, native SQLite pending and local parent logout')
    finally:
        secret=b''
        try:
            partial=adb('exec-out','run-as','dev.fountain.workspace','cat',OUTPUT).stdout
            path=QA/'android-cloud-result.json';path.write_bytes(partial);os.chmod(path,0o600)
        except subprocess.CalledProcessError:
            pass
        adb('shell','run-as','dev.fountain.workspace','rm','-f',INPUT,OUTPUT)
        adb('shell','am','force-stop','dev.fountain.workspace')
        adb('shell','pm','clear','dev.fountain.workspace')

if __name__=='__main__':main()
