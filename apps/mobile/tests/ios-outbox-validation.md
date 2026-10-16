# iOS outbox foundation verification

The native plugin advertises `outboxVersion: 1, outboxEnabled: false`.
All four outbox methods reject `OUTBOX_DISABLED` before opening SQLite.
Normal configuration, HTTP requests, login, logout and 401 processing keep the
existing Keychain/IndexedDB path and do not initialize the outbox.

`FountainOutbox.swift` uses only the OS SQLite library (`-lsqlite3`), one native
executor, DELETE journal and EXTRA synchronous readback. Session grants come
from native session response bodies; the private cookie hash never crosses
the bridge. Stable owner/auth/identity leases, staging SHA256 and receipts,
tombstones, bounded record fragments and isolated quarantine are implemented
as source foundation. Ordinary expiry refresh does not rotate head or lease.

Outbox result delivery checks owner, auth epoch, origin, generation, store
identity and its memory boundary on the main thread immediately before
submitting the Capacitor JSON envelope to the bundled WebView. Private read
fragments also require an unexpired native grant. SQLite errors poison this
outbox for the process; constructor recreation cannot bypass that fence.

Run the portable SQL tests with Python 3:

```
python3 apps/mobile/tests/ios-outbox-sql.py
```

These tests extract and execute the production SQL schema/statements against
temporary SQLite files. They cover transaction rollback, receipt uniqueness
and restaged retry cleanup, process exit before/after commit, profile/resource
purge including transfer metadata, and bounded BLOB substring reconstruction.
Source assertions check the disabled gate and final callback fence. They do
not execute the Swift validators, Keychain, Capacitor or iOS file protection.

Swift parse/build/device execution remains **unverified**: the installed Xcode
requires its license agreement, and this task neither accepts nor bypasses it.
The resource-access layer now has a **source implementation**, still behind
the disabled gate. Only actual native, exact query-free canonical GET responses
for workspace, collaboration and database can update a private SQLite control
ledger. Identity/cookie matching, bounded TTL, componentwise access/data revision
floors, row ID/access projections and schema digests constrain stored content.
Unexpired identical observations keep their original TTL and proof epoch;
changed evidence updates a separate proof epoch without advancing the business
data head or changing its lease. Actual resource 403/404 follows the existing
resource purge/tombstone policy; unsent operations/drafts and mutation input are
first preserved in the private recovery table, which cannot hydrate or replay.
Explicit profile logout still purges all corresponding private records/recovery.
Malformed 200 invalidates only evidence and
retains input. Workspace denial fences the whole profile without logging it out.
Terminal resource/workspace denial also rejects an older in-flight canonical
200 instead of installing or delivering it. Embedded workspace resources and
relation targets intersect individual native tombstones/denied/invalid evidence;
malformed-success markers may be refreshed, actual login-scoped denial may not.

Reads perform whole-profile preflight before the first fragment, including the
embedded workspace in profile records. Fresh active commits validate the final
record overlay inside their SQL transaction. Snapshots need exact identity and
revisions, page epoch/sequence and projected row scope. Pending edits need
current capabilities and references. Missing/expired/stale evidence, local page
dependency closure and other unresolved scope fail with `OUTBOX_ACCESS_REQUIRED`
while retaining input. Quarantine and delete/revocation-only cleanup remain
possible. Staging fixes the original proof epoch per transaction; exact accepted
receipts return their immutable original epoch even after evidence refresh.
Read cursors and final outbox callback delivery also fence the proof epoch.
The exact deadline collected from proofs actually used by preflight is retained
through fragment construction and the final main-thread delivery, including if
it expires during that work; unrelated proof deadlines do not authorize or
unnecessarily block the fragment.
Preflight and resource quarantine iterate one SQLite record at a time, with a
16 MiB per-record bound and the already bounded 64 MiB delta overlay; they do not
materialize the entire cache. The aggregate private proof ledger is bounded to
16 MiB before reading/decoding or committing a replacement. Exceeding that bound
preserves existing input and requires recovery rather than evicting records.
For an oversized newly validated proof, its revision floor/proof epoch still
advance durably while the old ledger stays unchanged, preventing older evidence
from authorizing stale cache. If a denial/invalid marker itself cannot fit, only
the private evidence is replaced by a small workspace-invalid marker; business
records and recoverable input are not evicted by this capacity fallback.
Legacy basis drafts never grant access: they additionally require an independent
fresh canonical snapshot with matching epoch/sequence. Relation references in
both intended edits and previous bases intersect fresh projected row scopes;
an unspecified relation database is not guessed to mean the current database.

Portable coverage additionally executes production SQL for private proof/floor
transaction rollback, immutable lost-ACK receipt metadata and preserved staging.
Source assertions check canonical response gating, semantic-poll no-op, revision
floor/schema/row/epoch preflight, receipt-before-current-access ordering and final
delivery fences. These assertions are **not execution of the Swift validators**;
the Python transaction fault model does not prove Swift API or OS behavior.

Activation still requires explicit quarantine promotion/recovery UI, complete
local-create dependency closure, a reconciliation/fresh-fetch path, actual
Swift/SDK execution, and real device storage/auth/process-death fault tests.
