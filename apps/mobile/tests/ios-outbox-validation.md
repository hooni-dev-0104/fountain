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

The user completed Xcode installation/setup. Actual unsigned SDK build, installation
and launch now pass on the dedicated Fountain QA iOS Simulator; the earlier license
block is resolved. Physical-device execution remains unverified.
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
The ordinary outbox's logout policy still purges corresponding private records;
the separate explicit recovery mode described below never invokes that writer.
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
full native HTTPS/picker integration, and real device storage/auth/process-death fault tests.

## Explicit read-only recovery source

`recoveryVersion: 1, recoveryEnabled: true` advertises the two explicit bridge
methods `recoveryInventory` and `recoveryExport`. This does not activate ordinary
outbox storage. With `OUTBOX_ENABLED=false`, ordinary boot/configuration/HTTP
still opens no SQLite; only the explicit recovery action reaches the new reader.

Recovery first latches a mode that blocks ordinary business non-GET requests
(session login/logout remain available), then obtains an actual native HTTPS
session response. Its separate memory context binds origin, current workspace,
member, login binding, private cookie reference, owner/auth/generation and expiry.
It never invokes outbox `grant`/`revoke` or writes a session grant into SQLite.
Recovery-mode login/logout/401/configuration changes close capabilities/readers
and clean private outputs while preserving the source archive. Closing or saving
does not automatically resume outbox writes or sync. Existing ordinary auth
retention/purge behavior remains an activation prerequisite, not solved by this
export source.

`FountainRecovery.swift` opens only an existing private per-origin file using
read-only/no-follow checks, SQLite READONLY and query-only. Absent storage stays
absent; no CREATE, migration, grant, head, receipt or business data writes occur.
Inventory is current-actor-only metadata with random memory handles, a five-minute
cap and bounded pagination. Raw resource-denial records and old wrapped change
records are both supported, with exact SQL profile/key/inner ID checks before
unwrapping. Other actors and profiles/meta/settings/provider/session/transfers
are never exported.

Prepare rechecks source head/fingerprint/SHA and fetches current canonical page,
database, relation/previous-base and attachment metadata authorization through the
native HTTPS helper. Edit level 3 is required for source resources; reference
rows need current read access, including unspecified-database relations. Scalar
and array property types, strict numeric/boolean envelopes, known rich-text
tokens/marks, block languages and command-specific raw operation fields are
validated. Unknown nested metadata is blocked rather than copied into readable
JSON. Native never executes old RGA operations. Implicit `after_operation`
dependencies join the explicit DAG; only a complete same-binding selected graph
may become a normal typed file. Unproven local page closure stays blocked.

Normal output is sanitized `fountain-recovery-v2`: desired user edits and known
body drafts, with ACL/owner/session/provider/status/receipt/base metadata omitted.
Old bases constrain authorization but do not grant export/import authority.
Known overflow or unresolved operations become ordered readable JSON code parts
with offsets and SHA context; the entire safe projection is retained without
truncation or partial typed execution. The original SQL always stays unchanged.
Limits are 100 selected records, 16 MiB per source/file, 64 MiB total prepared
output, 1,000 files and the existing parser's depth/node/block limits. File I/O
uses at most 256 KiB writes/reads for hashing/streaming; JS receives only names,
sizes/counts/warnings and random capabilities, never file bodies or private paths.

Save requires a second explicit action, fresh native session/resource checks,
unchanged source digests, two-minute bounded authorization, and private output
SHA verification before the existing multi-URL OS export picker. Canonical
authorization fingerprints ignore only validated canonical top-level
`data_revision`; all identity, access revision, contents, rows and references
remain exact, and attachment metadata uses its raw hash. Known denials/newer
observations invalidate prepared capabilities. Owner/auth/generation/boundary
checks fence final callbacks; stale cleanup targets the matching capability so
it cannot delete a newer preparation. Picker cancellation/partial completion is
reported and private temporary files are cleaned; source records are not deleted.

The portable suite now has 21 tests. It executes production SQL read-only and
transaction statements on isolated temporary files, checks raw/wrapped source
and actor filtering, verifies no source creation/hash changes, checks native
source invariants, and runs representative normal/readable format models through
the actual JavaScript recovery parser. This is **not execution of the Swift
serializer/validators, native HTTPS stack or OS picker**. Actual SDK verification is recorded separately below; portable tests alone do
not prove these platform behaviors. No SDK/license acceptance or bypass was performed.


## Actual Xcode / Simulator evidence — 2026-10-16

Xcode 27.0 (27A266a), iOS Simulator 27.0 arm64, dedicated `Fountain QA`
UDID `AA8931A4-B783-47B8-AA7D-243B8DB5A448`. Existing user simulators and data
were not reused. Unsigned build/install/launch passed. Actual launch exposed a
duplicate `capacitor` scheme handler registration; a fresh public
WKWebViewConfiguration preserving Capacitor settings fixes it while retaining the
confined asset gate. No private API, vendored patch, CA or TLS bypass was added.

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme FountainQA \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=AA8931A4-B783-47B8-AA7D-243B8DB5A448' \
  -derivedDataPath .data/ios-build CODE_SIGNING_ALLOWED=NO test
```

The separate XCTest target executes six tests: absent DB/no creation; actual
Swift/SQLite raw and wrapped records/current actor isolation/output; malformed
metadata and counter-only authority change; oversized Unicode readable projection
byte determinism/reassembly; both previous-properties locations and strict typed
values with a valid positive case; and the actual bundled bridge/disabled outbox
plus asset-path/proxy gates. All six passed with zero failures/skips. Test code
is not compiled into the app target. `.data/ios-qa.json` records source SHA256 and
xcresult/log paths. Reviewers independently inspected the result bundle and hashes.

These tests do not prove remote HTTPS login, Keychain storage failures, OS picker
completion/partial save, physical-device file protection, process-death faults,
WebView eviction recovery or ordinary outbox activation. Those remain separate.

## Authentication retention checkpoint — 2026-10-16

The disabled native outbox prototype now separates passive suspension from native
explicit actor deletion. Expiry, passive 401, login transitions and new bindings
fence the old exact profile without deleting records, recovery, receipt or staged
input. A suspended binding cannot reactivate. A fresh binding requires an actual
native, query-free workspace GET to establish its revision floor before active
read or commit. Successful session HTTP responses remain HTTP responses even when
the separate outbox gate requires recovery. Renderer profile/revocation deltas
cannot authorize archive erasure, and active deletion cannot target another profile.

Explicit DELETE captures a native-private actor before invalidation and removes
that origin/workspace/member's bindings only. Tagged staging and receipts may be
removed with that actor; unattributed legacy staging remains opaque and preserved.
Recovery mode's original read-only exception is unchanged. `OUTBOX_ENABLED=false`
and the ordinary disabled path's zero SQLite access remain in force.

The portable SQL/source suite has 22 passing checks. Three additional actual Swift
XCTest cases extend the dedicated Fountain QA Simulator suite to nine: source
byte preservation across passive invalidation/new binding, same-binding fences,
workspace-floor anchoring, unrelated-cookie rejection, actor-scoped deletion with
other-actor and unattributed staging preserved, and atomic rollback under a real
SQLite abort trigger, plus exact native receipt-owner positive/foreign-negative
checks and legacy metadata-only receipt acknowledgement without deleting staging.
Existing six recovery/bridge/asset tests also pass. These
tests call actual Swift/SQLite methods; passive HTTP/Keychain callback integration
and physical-device behavior are not claimed by these tests. No UI layout changed.

Final retention evidence is in `.data/ios-retention-owner-tests.log` and
`.data/ios-retention-owner-results`, using the same isolated QA Simulator command
above. No existing user simulator or production database was used.
