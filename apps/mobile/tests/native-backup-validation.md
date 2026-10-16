# Native cloud backup Range validation

The Android and iOS bridges accept exactly `/api/backup?job_id=<ASCII UUID>` for cloud backup jobs. The existing `/api/backup` and attachment downloads retain their existing paths. No signed URL or arbitrary query is accepted.

A job download captures the private native cookie, actual owner profile and bridge generation. It obtains ready metadata from `/api/backup/jobs/<UUID>`, then fetches sequential slices of at most 262,144 bytes. Every slice requires a current owner session with the same workspace, member, binding and cookie. HTTP 206, exact Content-Range, Content-Length, received size and job expiry are checked before a slice enters the private temporary file. An incremental SHA-256 and total size must match metadata before the OS picker is presented. Cancellation and native auth changes remove the derived temporary file; original offline archives are not opened or rewritten. Android additionally checks current owner permission before and after copying to the OS destination and renews its timeout only while copying makes progress.

Counters use Java long / Swift Int64 with a safe JSON integer maximum of 9,007,199,254,740,991. They do not inherit the attachment response limit. Only one bounded slice is held in memory, never the entire backup.

## Actual SDK evidence, 2026-10-16

- Android API 36, dedicated `FountainRecoveryQA` AVD: `BackupDeviceTest` plus the five `AuthRetentionDeviceTest` tests passed (7 total, no skips). The WebView called the real native bridge over loopback HTTPS trusted only by the debug QA CA. A 786,555 byte fixture was assembled in four slices, displayed in DocumentsUI, cancelled, and separately saved through the real Save button. The pulled OS destination SHA-256 was `809a697b184f5afe2e38e27d6c8ec94758bc4df991bb61e5f9b83717ffc6292b`, equal to the source. Wrong full digest, wrong range, owner demotion, explicit cancellation and in-flight logout failed and retained the original canary. Private temporary files were removed.
- iOS 27 Simulator, dedicated `Fountain QA` device and existing `FountainQA` scheme: all 11 XCTest tests passed, including the two new backup tests and nine existing native recovery/retention/bridge tests. The same actual HTTPS fixture was assembled and matched byte for byte before the real document picker appeared. Native cancellation while the picker was open, wrong digest/range, owner demotion and in-flight logout failed without changing the original canary. The test does not claim a successful iOS Files destination save.
- Both actual SDK test suites accepted size 6,000,000,123 and validated the last slice starting at 6,000,000,000 without overflow. This is metadata/arithmetic evidence, **not an actual 6 GB transfer**. Physical devices, exhausted device disk space, and provider-specific save limits remain unverified.
- iOS transfers file ownership to `UIDocumentPickerViewController`. The app checks actual owner permission immediately before presentation and rejects local auth changes while it is open; the OS controls the subsequent copy. A remote permission change during the OS copy is not an atomic transaction with that copy.
- Android `lintDebug --offline` could not run its Capacitor dependency unit-test model: the existing cache lacks `org.json:json:20250517` and `org.mockito:mockito-core:5.20.0`. No package was downloaded. Real SDK compilation and the seven actual device tests passed. The available generic LSP helper invokes TypeScript, so its empty results are not Java/Swift analysis evidence.
- Ordinary native outbox activation remains disabled.

## Repeat with existing runtimes only

Start `native-backup-fixture.py` with the existing debug QA certificate/key (no dependency installation). It binds only to `127.0.0.1:61602` and uses disposable synthetic accounts and bytes. Never use its certificate as a production trust root.

```sh
"$FOUNTAIN_PYTHON" apps/mobile/tests/native-backup-fixture.py \
  --certificate apps/mobile/android/app/src/debug/res/raw/fountain_qa_ca.pem \
  --key .data/android-qa/qa-ca.key
```

For Android, build offline with the already installed API 36 SDK/JDK 21 and QA signing key using the existing `android-outbox/device-run.sh` signing arguments; install only on `FountainRecoveryQA`. Run the two classes with `qaBackupOrigin=https://10.0.2.2:61602`. Before repeating, remove only the specifically named synthetic `/sdcard/Download/fountain-backup-qa.sqlite` on that dedicated QA AVD to avoid an overwrite-confirmation dialog. Pull the same file after the test to verify its digest. The test writes that synthetic file through the OS picker.

For iOS, add that certificate only to the dedicated QA Simulator using `simctl keychain <QA UUID> add-root-cert`, then run the existing `FountainQA` test scheme with `-disableAutomaticPackageResolution`. The existing test guard requires `FOUNTAIN_QA=1` and a simulator name beginning with `Fountain QA`. The HTTPS test waits for the real bridge and retries only its existing `NATIVE_BUSY` response while a previous session operation drains; it does not weaken native session checks.

Local logs are ignored under `.data/android-qa/backup-native-final.log` and `.data/ios-backup-native-final2.log`. No cloud deployment or paid service is used by these tests.
