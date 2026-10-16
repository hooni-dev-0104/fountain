# Native direct Supabase routing — 2026-10-17

iOS and Android now add the native-owned `/functions/v1/fountain-api` prefix for
canonical HTTPS origins whose hostname is exactly 20 lowercase letters/digits
followed by `.supabase.co`, using the default port. Renderer paths remain logical
`/api/*`. JSON requests and downloads use the same URL builder. Ordinary server
origins, local TLS relays, custom ports and lookalike domains retain root routing.
Configuration, cache/cookie identity, TLS validation and redirect denial remain
unchanged. A complete function URL is still rejected as configuration input.

The actual project root `/api/session` returned 404; its prefixed route returned
200 with the anonymous account envelope. Both native SDK tests reached the latter
directly, without a presentation proxy, API key, credential or caller cookie.
Anonymous workspace, identity and cache binding deliberately remain null.

## Actual verification

- Android API 36, dedicated `FountainRecoveryQA`: offline app/test APK build,
  instrumentation `CloudDirectRouteDeviceTest` passed one test, no failures/skips.
  It invokes the production `FountainNativePlugin.open`/`HttpsURLConnection`
  through reflection on a fresh unloaded instance. The encrypted preferences
  snapshot was unchanged; response headers use the production safe allowlist.
- iOS 27 Simulator arm64, dedicated `Fountain QA`: Xcode build-for-testing passed.
  The URL policy and direct HTTPS tests passed, two tests with no failures/skips.
  A DEBUG/`FOUNTAIN_QA` nonbridge probe on a fresh unloaded plugin uses the actual
  production `network()`/`URLSession`. It never loads configuration, Keychain or
  outbox state. Eleven additional core tests passed, including the bundled bridge
  and private asset gate. The routing unit test overlaps these two suites.
- JDK policy/cookie tests: 148 checks. Portable iOS SQLite tests: 22. The mobile
  transport and Chrome/real local HTTP suites passed with their mock native
  bridge; these remain separate from actual SDK/device execution.

Each direct test performs one anonymous GET and zero POSTs/mutations. It does not
prove bridge/configure/login, private-cookie authentication, editing, live UI
propagation or OS file saving. Earlier authenticated relay-based observation is
documented separately in [native-cloud-validation.md](native-cloud-validation.md).
The desktop client still needs a frontend origin/relay or bundled UI transport;
this change does not enable desktop rendering from the API-only Supabase origin.
Windows execution and physical devices remain unverified.

## Explicit opt-in

Use the existing installed SDKs, existing QA signing key and dedicated devices.
Build app/test binaries offline as documented in the mobile README; no SDK,
dependency, license, CA or cloud account is provisioned by this exercise. Install
the app without clearing its private data before delivering input:

```sh
python3 apps/mobile/tests/prepare-cloud-direct-input.py android --device emulator-5554
python3 apps/mobile/tests/prepare-cloud-direct-input.py ios --device AA8931A4-B783-47B8-AA7D-243B8DB5A448
```

The helper guards dedicated device names and creates a 0600, non-overwriting
`fountain-cloud-direct-input.json` containing only the fixed public project origin.
Android uses private app `files/`; iOS uses `Documents/`. Tests skip without this
input, consume it before I/O and write boolean/count-only results to
`fountain-cloud-direct-result.json` in the same directory. Require fresh results
and zero skipped tests when collecting evidence.

Android selector:
`dev.fountain.workspace.CloudDirectRouteDeviceTest#anonymousSessionUsesDirectSupabaseNativeRoute`.
iOS selectors under `FountainNativeTests/FountainNativeTests/`:
`testNativeSupabaseURLRoutingPreservesOriginAndLogicalPathPolicy` and
`testActualAnonymousCloudDirectNativeRoute`.

Both private inputs and device result files were removed after safe collection.
Root stopped only the Android emulator it started and kept the pre-existing iOS
Simulator booted. No Auth user/session, Storage object, Cron or DB row was created.
Original 153 entities, six metadata rows, six collection fingerprints and the
immutable localhost:8787 preview were preserved.

[Machine-readable evidence and source hashes](native-direct-verification.json).
