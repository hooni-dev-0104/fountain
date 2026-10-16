#!/bin/sh
# Opt-in destructive reset applies ONLY to the dedicated fresh QA AVD/app.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)
: "${ANDROID_HOME:?Set ANDROID_HOME to the preinstalled Android SDK}"
: "${JAVA_HOME:?Set JAVA_HOME to the existing JDK21}"
: "${FOUNTAIN_PYTHON:?Set FOUNTAIN_PYTHON to the existing Python runtime}"
: "${FOUNTAIN_ANDROID_QA_SERIAL:?Set FOUNTAIN_ANDROID_QA_SERIAL to the dedicated QA emulator serial}"
ADB="$ANDROID_HOME/platform-tools/adb"
AVD=$($ADB -s "$FOUNTAIN_ANDROID_QA_SERIAL" emu avd name | tr -d '\r' | head -n 1)
test "$AVD" = FountainRecoveryQA || { echo 'Refusing to alter any AVD except FountainRecoveryQA'; exit 1; }
test -f "$ANDROID_HOME/platforms/android-36/android.jar"
test -d "$ANDROID_HOME/build-tools/36.0.0"
cd "$ROOT"
QA="$ROOT/.data/android-qa"
mkdir -p "$QA"
chmod 700 "$QA"
# A public debug-only certificate is regenerated; its private key stays ignored.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$QA/qa-ca.key" \
  -out apps/mobile/android/app/src/debug/res/raw/fountain_qa_ca.pem -days 30 \
  -subj '/CN=Fountain isolated Android QA only' \
  -addext 'subjectAltName=IP:10.0.2.2,IP:127.0.0.1,DNS:localhost' > "$QA/cert-generation.log" 2>&1
chmod 600 "$QA/qa-ca.key"
if test ! -f "$QA/qa-debug.jks"; then
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$QA/qa-debug.jks" -storepass android \
    -keypass android -alias fountain-qa -keyalg RSA -validity 3650 \
    -dname 'CN=Fountain isolated QA only' > "$QA/signing-generation.log" 2>&1
fi
chmod 600 "$QA/qa-debug.jks"
"$FOUNTAIN_PYTHON" apps/mobile/tests/android-outbox/device_fixture.py \
  --certificate apps/mobile/android/app/src/debug/res/raw/fountain_qa_ca.pem \
  --key "$QA/qa-ca.key" > "$QA/https-fixture.log" 2>&1 &
FIXTURE_PID=$!
trap 'kill -TERM "$FIXTURE_PID" 2>/dev/null || true; wait "$FIXTURE_PID" 2>/dev/null || true' EXIT INT TERM
cd apps/mobile/android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --console=plain \
  -Pandroid.builder.sdkDownload=false -Pandroid.injected.signing.store.file="$QA/qa-debug.jks" \
  -Pandroid.injected.signing.store.password=android -Pandroid.injected.signing.key.alias=fountain-qa \
  -Pandroid.injected.signing.key.password=android > "$QA/gradle-app-test.log" 2>&1
cd "$ROOT"
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" uninstall dev.fountain.workspace.test >/dev/null 2>&1 || true
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" uninstall dev.fountain.workspace >/dev/null 2>&1 || true
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" install -r apps/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" shell pm clear dev.fountain.workspace
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" shell rm -f /sdcard/Download/fountain-recovery-1.json
run_test() {
  NAME=$1
  "$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" shell am instrument -w \
    -e qaOrigin https://10.0.2.2:61595 -e qaFamilyOrigin https://10.0.2.2:61596 \
    -e class "dev.fountain.workspace.RecoveryDeviceTest#$NAME" \
    dev.fountain.workspace.test/androidx.test.runner.AndroidJUnitRunner > "$QA/$NAME.log" 2>&1
  # Android am instrument may exit zero even if JUnit fails.
  if ! rg -q 'OK \(1 test\)' "$QA/$NAME.log"; then cat "$QA/$NAME.log"; exit 1; fi
}
run_test nativeReadOnlyRecoveryAndSystemSave
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" exec-out run-as dev.fountain.workspace cat files/qa-recovery-result.json > "$QA/device-result.json"
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" pull /sdcard/Download/fountain-recovery-1.json "$QA/saved-recovery.json"
run_test privateFamilyLoginPersists
"$ADB" -s "$FOUNTAIN_ANDROID_QA_SERIAL" shell am force-stop dev.fountain.workspace
run_test privateFamilyRestoresAndLogsOut
node - "$ROOT" <<'JS'
const fs=require('node:fs'),root=process.argv[2];globalThis.FountainCollaboration=require(root+'/static/collaboration.js');
const R=require(root+'/static/recovery-import.js'),text=fs.readFileSync(root+'/.data/android-qa/saved-recovery.json','utf8'),raw=JSON.parse(text);
const parsed=R.parse(text,{origin:raw.origin,workspaceId:raw.workspace_id,memberId:raw.member_id});
if(parsed.records.length||parsed.drafts.length!==1||!parsed.drafts[0].draft.blocks.some(block=>block.text==='Android 실제 미전송 원문 🏠'))throw Error('Actual Android OS export failed the web parser round trip');
console.log('PASS actual Android SDK/API36 WebView bridge, native HTTPS, SQLite readonly/source SHA, OS picker cancel/save, Unicode web parser, private family cookie process restart/logout');
JS
