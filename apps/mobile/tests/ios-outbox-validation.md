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
Activation additionally requires fresh resource proofs, explicit quarantine
promotion, dependency closure checks, recovery UI and real device fault tests.
