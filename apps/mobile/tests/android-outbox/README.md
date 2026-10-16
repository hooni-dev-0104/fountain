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
