# Android recovery SDK verification — 2026-10-16

The final `device-run.sh` invocation passed all three separate instrumented
tests on the isolated `FountainRecoveryQA` emulator, API36 arm64 Google APIs,
emulator36.6.11, JDK21.0.10 and existing Android SDK. No personal AVD, account or
production data was opened. `OUTBOX_ENABLED=false` remains unchanged.

| Actual instrumented test | Result |
| --- | --- |
| WebView main-frame bridge, native HTTPS, Android read-only SQLite, absent storage, metadata-only inventory/prepare, DocumentsUI cancel/save, unchanged source, recovery-mode DELETE | PASS, 24.962s |
| Disposable family-token POST login, private native cookie GET, no family outbox creation | PASS, 9.215s |
| Separate invocation after `adb am force-stop`: Keystore-backed cookie restoration, authenticated GET, actual DELETE and unauthenticated GET | PASS, 10.161s |

The actual OS-saved 563-byte recovery JSON was pulled from the QA emulator and
passed the current web `FountainRecovery.parse`: zero typed mutations, one body
draft, exact `Android 실제 미전송 원문 🏠` text. The native source SQLite SHA256
before/after inventory, prepare, cancel, save and recovery-mode logout was
`38b48e53517fefe0d4e5166a5bedf3dba7bd6effa30c6627dae2ad520957bfc3`.
The saved file SHA256 was
`cdd86f90a0500b2221d0866f64796df4dbdcd66c1dbdacad9c6c9aaad95e9c46`.

SDK compilation used `:app:assembleDebug :app:assembleDebugAndroidTest` with
`android.builder.sdkDownload=false`. App/test APK SHA256:

```
13d9eee10bb6e81aaf6bcadf81cf0d2f7586a14b261c98390413040b89194add  app-debug.apk
df8680d9bbb50eac46151e5fc78aca152d8a647326688ee1b66f70754e43de3e  app-debug-androidTest.apk
```

APK signing was verified as the separate ignored QA key, certificate SHA256
`d650939ea3e7e404b38447e938e475dd518292b44b5d042702ca6b5c8a8938c0`.
The debug TLS public CA SHA256 was
`35b1605c0494bb2df55c078658751a2c54d3ff3604e138a742afdf8aed17eace`;
its private key stays ignored under `.data/android-qa` with mode0600. Trust was
added only to the debug application, with no system CA installation or TLS
verification bypass. Actual APK `native-recovery.js` and `native-transport.js`
bytes equal their current source bytes.

`:app:processReleaseManifest --offline` also passed. Its merged manifest has
cleartext disabled, no debug QA `networkSecurityConfig`, and no `debuggable`
flag. The debug CA/manifest/resources live exclusively in `src/debug`.

Source/portable checks also passed: pure JDK97, SQL14, signature compilation,
existing native transport, and production Java recovery with the explicitly
provided preexisting compatibility jar. The latter covered actual temporary
HTTP authorities, strict malformed authority/property/base/reference/kind
negatives, current-profile tombstones, known attachment denial, source/actor
changes, exact cancellation, stripped unknown metadata and lossless two-file
overflow with exact projection checksum and the real web parser. These
portable results remain distinct from the instrumented cases above.

Reproduce with the explicit SDK/JDK/isolated-AVD commands in `README.md` and
`device-run.sh`. It generates a new debug TLS certificate, so artifact hashes
and disposable source identities will change. The first exploratory Gradle
invocation unintentionally auto-installed Build Tools35 using a preexisting
license before the explicit Build Tools36/download-disabled settings were
added. No license-acceptance command was run; this side effect is not omitted
from the record. Later commands used the download-disabled setting.

This is emulator evidence for explicit recovery and existing secure transport,
not physical-device testing, ordinary outbox activation/crash durability,
automatic recovery promotion or unproven local creation dependency recovery.
