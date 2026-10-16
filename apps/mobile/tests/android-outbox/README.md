# Android durable outbox foundation

`OUTBOX_ENABLED=false` is a production boundary. Configuration advertises
`outboxVersion:1,outboxEnabled:false`; the four outbox methods reject with
`OUTBOX_DISABLED`, and ordinary transport/session/configuration paths never
open SQLite. The anonymous local logout bug is fixed independently: it sends
an actual native DELETE before clearing the invalidation marker.

The inactive implementation uses per-origin SQLite under `noBackupFilesDir`,
DELETE journal / EXTRA synchronous readback, one session executor, native-only
session response grants, generation/owner leases, staged delta SHA256, immutable
receipts before head checks, and profile/resource tombstones including transfer
records. A grant requires an actual native session GET/POST response; a renderer
profile cannot grant access. Only the cookie's private SHA256 is stored in SQL.
Local grants require authenticated local mode with required=false, no cookie,
and expire within 24 hours. Tombstones cannot be reversed by a fresh grant.
Quarantine has no hydration or automatic promotion. Denied mutation recovery
for a revoked resource is retained in quarantine, never in active read results.

Commands (supply an existing JDK; no SDK/dependency installation):

```
FOUNTAIN_JAVA_HOME=/path/to/jdk sh apps/mobile/tests/android-outbox/run.sh
python3 apps/mobile/tests/android-outbox/test_sql.py
FOUNTAIN_JAVA_HOME=/path/to/jdk python3 apps/mobile/tests/android-outbox/compile_fixture.py
FOUNTAIN_JAVA_HOME=/path/to/jdk sh apps/mobile/tests/android-policy/run.sh
node apps/mobile/tests/transport.mjs
```

Evidence is deliberately limited:

- `run.sh` executes the production pure Java identity/encoding/size/UTF8/date rules.
- `test_sql.py` runs production DDL and SQL transaction patterns against desktop
  SQLite, including process exit before/after COMMIT. Source assertions check
  rollout, anonymous DELETE, receipt order and cleanup. It does not execute the
  Android `SQLiteDatabase` class or simulate a real WebView bridge.
- `compile_fixture.py` checks Java syntax and checked exceptions against small
  test signatures. It is neither Android SDK compilation nor runtime validation.
- Existing native transport tests use JavaScript fixtures, not device HTTPS.

Activation requires Android SDK compilation and device tests of SQLite's actual
connection/pragmas, filesystem protection, session grant/expiry/revocation,
owner callback races, staged retry/commit failures, process death, and transport
logout. Common JS recovery/resource proofs and a user-visible quarantine recovery
flow also must be completed before this flag can change. No claim of Android
crash persistence or end-to-end native outbox operation is made by these tests.

## Private resource access foundation

Only native query-free canonical GET responses for workspace, page collaboration
and databases can populate private evidence. Identity is checked against the
native grant and sent cookie; path resource IDs are decoded once. A separate
proof epoch and per-session global access/data revision floor fence stale
responses and callbacks without advancing the business head or lease. Identical
unexpired observations keep their original deadline and epoch; shortened grants
and changed or expired evidence fence prior delivery. The evidence ledger is
bounded to 16 MiB; overflow retains the newest floor and recoverable records.

Before returning any active record, the whole profile is checked, including
embedded workspace page bodies/DB metadata, negative evidence, page epochs and
sequences, exact database versions, projected row levels and relation targets.
Mutation status or an old receipt supplies no permission. Mutation bases and
delete-subtree row IDs also intersect native evidence. Basis drafts require an
independently valid cached canonical snapshot. Records are scanned with bounded
SQL substrings instead of loading every payload into an aggregate JSON object.

Fresh active commits validate the final overlay in the same SQLite transaction.
Missing, expired, stale or local-dependency evidence returns
`OUTBOX_ACCESS_REQUIRED` while preserving input, staging, journal, head and
receipts. This checked exception does not poison authentication/storage. Exact
accepted transaction retries return their original immutable proof epoch before
current resource checks, and clean restaged bytes. Every staged part fixes its
original epoch; uncommitted intents are never silently retagged. Quarantine and
exclusive cleanup remain possible without resource evidence.

Actual resource 403/404 tombstones block late 200 responses and move pending
input to unreadable quarantine. Workspace denial is terminal for the same login
binding but does not create an authentication logout tombstone; malformed
response invalidation may be repaired by a fresh valid response. This phase does
not implement local page creation dependency closure: it preserves those records
with `local_dependency`. SDK/device verification, explicit repair/promotion UI
and a fresh fetch/reconciliation path remain required before activation.

The added JDK tests execute production endpoint, version, capability and expiry
rules. Portable SQL tests execute production DDL/statements for rejected-overlay
rollback, proof control isolation, resource denial quarantine and lost-ACK
receipt cleanup. Source assertions pin observer/UI callback and negative-evidence
paths. None of these execute Android `SQLiteDatabase` or WebView on a device.

## Explicit read-only recovery

The two recovery methods are independent of the disabled outbox. Explicit
inventory arms recovery mode before authentication, reads only an existing
per-origin SQLite file, and does not create a grant, migrate, purge, or resume
ordinary synchronization. Current native session and resource HTTP responses
authorize export of the same actor's older bindings. Other actors, unpublished
creation closures, unsafe projections and incomplete dependencies remain in the
original file. Authentication, source SHA, permission and expiry changes fence
prepared output. Output stays in private native files until the OS picker;
JavaScript receives metadata and opaque capabilities only.

An optional JVM exercise runs the production `NativeRecovery` class with a
preexisting compatibility JSON jar and test-only Android API adapters:

```
FOUNTAIN_ANDROID_JSON_JAR=/absolute/path/to/preexisting/android-json-0.0.20131108.vaadin1.jar \
  python3 apps/mobile/tests/android-outbox/recovery_fixture.py
```

No jar is downloaded or installed. Without that explicit path this optional
exercise skips. The existing local artifact used for verification was
`com.vaadin.external.google:android-json:0.0.20131108.vaadin1`, SHA256
`dfb7bae2f404cfe0b72b4d23944698cb716b7665171812a0a4d0f5926c0fac79`.
It is not an application dependency. The exercise uses actual temporary Python
HTTP authorities, desktop SQLite read-only queries and the current web recovery
parser. It checks source-byte preservation, absent storage, old bindings,
strict malformed authority negatives, cancellation, source/auth/denial changes,
stripped unknown secrets and lossless Unicode overflow parts. Compatibility
JSON and SQLite/Os/Context adapters are not Android SDK, TLS, driver, device,
bridge or OS-picker evidence.

## Opt-in Android SDK and isolated emulator test

`RecoveryDeviceTest` exercises the actual production plugin through Capacitor's
packaged main-frame WebView bridge. The dedicated API36 arm64 QA emulator uses
native HTTPS with a debug-only test CA, Android SQLite in read-only/query-only
mode, real DocumentsUI cancellation/save and an exact source-file SHA check.
The saved file is pulled from that fresh emulator and parsed by the current web
importer. Two further, separately invoked tests log in to a disposable family
server, force-stop the app, prove the private Keystore-backed cookie restores
authentication, and perform an actual logout. They use a public fixture token;
no personal account or production database is involved.

The runner refuses every emulator name except `FountainRecoveryQA`. It resets
only that QA app, uses a separate ignored QA signing key, and never enables the
outbox. Start a fresh dedicated AVD using the **already installed** SDK image:

```
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home
export ANDROID_AVD_HOME="$PWD/.data/android-qa/avd"
export ANDROID_USER_HOME="$PWD/.data/android-qa/user"
export ANDROID_EMULATOR_HOME="$PWD/.data/android-qa/emulator-home"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$ANDROID_EMULATOR_HOME"
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name FountainRecoveryQA --device pixel_7 \
  --package 'system-images;android-36;google_apis;arm64-v8a' \
  --path "$ANDROID_AVD_HOME/FountainRecoveryQA.avd"
"$ANDROID_HOME/emulator/emulator" -avd FountainRecoveryQA -port 5580 \
  -no-snapshot -no-boot-anim -no-audio -gpu swiftshader -memory 2048
```

In another terminal, with the same SDK/JDK environment and an existing Python:

```
FOUNTAIN_PYTHON=/absolute/path/to/python3 \
FOUNTAIN_ANDROID_QA_SERIAL=emulator-5580 \
  sh apps/mobile/tests/android-outbox/device-run.sh
```

Do not use an existing personal AVD. No SDK download, license acceptance,
trust-all TLS, cleartext network or release trust override is part of this
runner. It regenerates a public debug CA in `app/src/debug/res/raw`; the private
key and test APK signing key remain protected under ignored `.data/android-qa`.
The debug manifest/trust anchors are excluded from release. Ports61595/61596
must be free. Logs and saved QA files stay under `.data/android-qa`.

Initial SDK verification did reveal two build gaps: the app needed its existing
Capacitor WebKit transitive version on the app compilation classpath, and the
unqualified Gradle test task also built an unrelated Cordova library test APK
with conflicting old Kotlin modules. App-qualified targets avoid that unrelated
task; no Kotlin dependency was added. Before the SDK auto-download guard and
explicit app Build Tools36 setting were added, the first Gradle invocation
automatically installed Build Tools35 using a preexisting license. This was an
unintended SDK side effect and is recorded explicitly; no license acceptance
command was run. Later verification disables SDK auto-download.

These tests verify explicit recovery and the existing secure transport on an
emulator. They do not activate or prove ordinary native outbox replay, mobile
crash durability, unproven local creation closure, arbitrary physical devices,
or automatic recovery promotion. `OUTBOX_ENABLED=false` remains unchanged.

## Authentication retention checkpoint

Native auth invalidation now suspends the exact private profile instead of
purging its source. Private control markers block the old binding and rotate
its proofs/head/owner lease while preserving records, recovery, original
receipts and uncertain staged parts. An actual session response cannot resume
an expired or suspended binding. A fresh binding needs a new native workspace
GET before active reads/commits. Unexpired identical grants preserve the
original deadline and lease. The public recovery error remains
`OUTBOX_ACCESS_REQUIRED`; no bridge method was added.

Only explicit native DELETE can erase all bindings of the privately verified
origin/workspace/member. Actor capture precedes auth invalidation and checks
the private active/revoke cookie hash; unknown actors cannot trigger an erase.
Recovery-mode DELETE retains its existing read-only override. Renderer profile
deletes/revocations suspend rather than erase the archive; quarantine deletes
do not remove originals, and conflicting quarantine overwrites abort atomically.
Native owner tags attribute new staged parts/receipts to an actor. Legacy
unattributed parts/recovery remain opaque and preserved even on actor logout;
their ownership or automatic promotion is not inferred.

The existing device runner now additionally executes
`AuthRetentionDeviceTest` (five tests) against the actual Android SQLite driver.
These tests invoke the inactive storage class directly with synthetic native
grants; they do **not** turn on the production gate or claim an enabled-plugin
HTTP auth flow. Existing real WebView/HTTPS/Keystore/picker cases run separately
in the same fresh QA environment. The constructor also canonicalizes the
app-owned `noBackupFilesDir` before checking children, so Android's legitimate
`/data/user/0` alias does not fail the private-file guard.
