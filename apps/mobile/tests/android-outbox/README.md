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
