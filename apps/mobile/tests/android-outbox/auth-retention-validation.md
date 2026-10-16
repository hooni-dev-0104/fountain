# Android authentication retention checkpoint — 2026-10-16

`OUTBOX_ENABLED=false` remains unchanged. No new API, schema, dependency,
server route, SDK installation or trust override was added in this checkpoint.
The separate Supabase backend transition is outside this change.

Native auth expiry, passive401, login replacement and new bindings preserve
records, recovery payloads, original receipts and uncertain staged bytes.
Private suspension markers prevent old bindings from reactivating; proof,
head, owner and lease fences rotate. An unexpired identical native grant keeps
its original deadline and scope. A fresh binding needs a native workspace GET
before active hydration. Existing session HTTP200 responses remain HTTP200 when
the storage requires recovery; the public error stays `OUTBOX_ACCESS_REQUIRED`.

Only explicit native DELETE uses a privately captured actor to erase all of
that origin/workspace/member's bindings. Active or pending-revocation cookies
must match the native grant; unknown actors cannot erase. The recovery-mode
read-only logout override remains. Renderer cleanup cannot erase suspended or
foreign records, resource revocation cannot purge those archives, quarantine
overwrites cannot replace the last copy, and a legacy receipt cannot clean
another actor's uncertain staging. Legacy unattributed sources stay opaque;
their ownership or promotion is not inferred.

The actual API36 arm64 QA emulator first reproduced two independent review
findings: suspended active DELETE changed2 records to1; a legacy receipt
changed foreign staging1 to0. After the minimum boundary fixes, the same five
actual Android SQLite tests passed in1.032s. The tests use synthetic native
grants and call the inactive class directly; they do not enable the production
plugin or claim an enabled-plugin auth round trip. The earlier first direct
test also exposed Android's legitimate `/data/user/0` alias rejecting the
constructor path guard; canonicalizing the app-owned base fixed that without
relaxing child path checks.

Final evidence, retained under ignored `.data/android-qa`:

- `retention-delete-red.log`: the two concrete SDK failures before the fixes.
- `retention-final.log`: five actual Android SQLite cases, all passed.
- `retention-gradle-final.log`: final app and test APK SDK compilation passed.
- `auth-retention-manifest.json`: SHA256 of the three production Java files,
  instrumented test, actual app APK and test APK after that final run.
- `retention-sql-final.log`:16 portable SQLite cases passed, including exact
  actor deletion, transaction rollback and preservation of unknown originals.
- Pure JDK103, Java signature compilation, existing native transport and diff
  checks passed. Independent review checked the same source and SDK logs.

`device-run.sh` reproduces the existing WebView/native HTTPS/SQLite read-only/
OS picker/export-parser/private cookie restart and logout flows plus the five
retention tests on the dedicated `FountainRecoveryQA` emulator. The full
runner passed before the final inactive-storage boundary fixes; the final SDK
suite specifically reran those affected storage branches. No personal AVD,
account or production database was used. The QA emulator and temporary HTTPS
authority are stopped after verification; the ignored QA artifacts remain.

This checkpoint does not activate native replay, implement native archive
promotion, recover ownership of legacy opaque staging, prove crash durability
of an enabled outbox, or verify physical devices. Those limits remain explicit.
