# Fountain native transport contract

Only the bundled main frame can call `FountainNative`. No remote `server.url`,
`allowNavigation`, global HTTP patch, cookie bridge, CORS relaxation, bearer
endpoint, certificate exception, or server secret in the bundle is used.

## Bridge

- `getConfiguration()` -> `{origin: string|null, generation: integer}`.
- `configure({origin})` -> same result. Accept only HTTPS origin/root, no
  credentials/path/query/hash. Change only after active session and revoke-only
  session are cleared; abort in-flight calls and increment configuration generation.
- `request({id,path,method,headers,bodyBase64,timeoutMs,generation})` ->
  `{status,headers,bodyBase64,generation}`. Paths are relative `/api/` only;
  reject absolute/protocol-relative/backslash/control/dot segments, including
  repeatedly percent-encoded traversal. Independently validate in native code.
  Methods GET/POST/PUT/PATCH/DELETE. Request body <=10,000,000 bytes; response
  <=16MiB; timeout 1..45s. No redirects; native standard TLS validation.
- `cancel({id})` -> `{cancelled: boolean}`; cancellation cannot cancel session
  revocation. A closed request never returns success later.
- `download({id,path,filename,generation})` -> `{saved:boolean,generation}`.
  Only `/api/backup` or exact `/api/attachments/<id>/download` paths. Stream
  to protected temporary file, verify complete received length, check generation,
  use native OS export/save UI, remove temporary/incomplete file. Do not send
  entire large file/base64 to JS. Reject if native implementation unavailable.

Native request headers accept only Content-Type, Accept, Range, If-None-Match.
Reject Cookie/Set-Cookie/Origin/Authorization/Host and all other caller headers.
Native adds X-Fountain-Request:1 and its private Cookie, omits Origin. Return
only safe response headers (Content-Type, Content-Length, Content-Range,
Accept-Ranges, ETag, Content-Disposition); never return Set-Cookie/Set-Cookie2.
Use a private cookie jar, never shared WebView/browser/system account caches.

- `saveData({id,filename,bodyBase64,generation})` -> `{saved,generation}`.
  Decode at most 8MiB for local JSON/CSV/Markdown/recovery exports; use the same
  protected temporary-file OS export flow and generation fences as download.
  Larger exports fail explicitly, never navigate or silently truncate.

## Sessions and races

Reuse existing `POST /api/session`, `DELETE /api/session`; no server auth change.
The cookie name is `fountain_session`. Persist only the dedicated Fountain
cookie per backend origin: iOS app-scoped Keychain, Android app-scoped
Keystore AES-GCM + private encrypted preferences. Never plaintext fallback.
No tokens/cookies in logs, JS results, URLs, localStorage or IndexedDB.

Serialize login/logout mutations. On login/logout start increment internal auth
generation, cancel/fence old operations including downloads. Successful login
accepts only native-parsed session cookie. On logout remove active cookie
immediately, but send DELETE using captured OLD cookie. Offline/failed revoke
retains encrypted **revoke-only** cookie and retries DELETE before next session
check/login. Do not send it to ordinary API requests. Do not let cancel(id)
stop revocation. Generation check prevents late Set-Cookie, 401, reads or
completion from replacing the new session. `generation` exposed in the bridge
identifies server configuration; auth generation remains native internal.

## JavaScript adapter

Retain `FountainTransport` request/events/xhr/downloadURL/appURL/publicURL API.
No monkey-patching global fetch/XHR. request returns a real Response from safe
native bytes; AbortSignal cancels id. events facade polls authorized collaboration
and presence snapshots in foreground with no overlap, emits snapshot/presence/
denied; close fences late callbacks. xhr facade implements only UploadManager's
4MiB blob/status/responseText/upload.onprogress/timeout/abort/load/end contract.
Native upload progress may report acknowledged chunk completion only.

Use backend origin for offline/upload namespace and share links, not local
capacitor origin. Skip SW in native app; bundled shell opens without network.
IndexedDB remains an initial cache, not a guarantee of native durable outbox.
A disabled SQLite foundation now implements bounded delta staging and receipts;
it is not activated and does not yet establish crash/eviction-safe mobile support.
See [the rollout boundary](../../docs/NATIVE_OUTBOX.md). Blob exports and native background transfer are separate
capabilities and must not silently navigate unauthenticated remote downloads.

## Native failures

Only genuine `NETWORK_ERROR`/`NATIVE_NETWORK` becomes a JS TypeError for the
existing offline-cache flow. Timeout becomes TimeoutError, stale/cancel becomes
AbortError. Secure-storage/durable-invalidation/unknown native failures carry
status 503, and pending revocation carries 401; they must never open cached
content as a network fallback. Native and JS must preserve this distinction.

In-memory invalidation is not a durable logout journal. Commit an invalidation
marker before changing the encrypted record; on restart treat an old active
cookie as revoke-only while the marker exists. If marker, secure-record erasure
and key/entry deletion all fail, return a distinct durable-invalidation error
and attempt remote DELETE using the RAM-only revoke token. Do not promise
next-process invalidation or report successful logout under total storage failure.


## Disabled SQLite foundation

Both native configurations advertise `outboxVersion:1, outboxEnabled:false`.
A native compile-time gate rejects `outboxOpen`, `stageDelta`, `commitDelta` and
`readPage` with `OUTBOX_DISABLED`. Ordinary request/session/configuration paths
must not open or mutate SQLite while disabled. Bootstrap does not initialize,
quarantine, clear or migrate the existing IDB databases. The prototype adapter
is exercised only by explicit capability-enabled fixtures.

The planned enabled protocol is bounded: 256KiB staged/read fragments, 16MiB
records, 64MiB logical transactions; fixed nine business buckets; SHA256 exact
UTF8 delta bytes; current owner/auth lease, expected data head and tx receipts.
Same txId+digest returns its receipt after lease verification and before head
comparison. Different digests may not reuse txId. No raw SQL or session secrets
cross the bridge. Same owner/auth epoch reopens the same lease; authentication,
identity or native owner changes fence old callbacks.

Activation requires native-observed fresh resource proofs, explicit quarantine
promotion and recovery UI, local-page dependency validation, auth refresh
barriers, and real SDK/device tests. No automatic promotion exists. Do not turn
this gate on for existing users or switch a migrated DB back to the legacy
schema without an explicit, tested migration.
