# Actual native HTTPS sessions against the sealed Supabase QA application

This opt-in exercise uses the real Android/iOS native bridge, native HTTPS client and private cookie vault. A loopback TLS presentation proxy forwards the original login/page/session requests to the sealed Supabase `createApplication` handler. It supplies only the outer verification header server-side; authentication responses and page data are not simulated.

The proxy is restricted to one disposable workspace, `fountain-qa-cloud-accounts-75254a74761a4888`, and these routes: POST/GET/DELETE `/api/session` and GET `/api/pages/qa-accounts-private`. It preserves Secure cookies and checks that login input belongs to the configured disposable owner. It cannot create/edit pages, attachments or backup jobs. The private outer nonce is never delivered to a native application.

## Verified on 2026-10-16

- Android API 36, dedicated `FountainRecoveryQA` emulator: `CloudSessionDeviceTest` passed, 1 test, 0 failures/skips. Existing SDK offline build passed.
- iOS 27 Simulator, dedicated `Fountain QA` device and `FountainQA` scheme: `testActualSupabaseOwnerSessionAndPrivatePage` passed, 1 test, 0 failures/skips. Existing SDK build-for-testing passed.
- Both platforms performed actual cloud password login, observed an authenticated active owner (`member.id=local`) in the fixed QA workspace, and read the same private page with access level 4. Session identity/binding was checked before and after that read. The private page API retains its existing page response shape; the tests do not invent a top-level session envelope for it.
- The two platform session-binding SHA-256 values differed; private-page title SHA-256 values matched. Both performed real logout and observed `authenticated:false` afterward. Opaque Set-Cookie headers were not exposed through the renderer response headers. Native outbox activation was observed as disabled.
- Page mutations, attachment/job requests and production-namespace operations: zero. No title needed restoring. Only disposable session-vault/Auth session records were created/revoked by login/logout.
- The tests prove native authentication and shared page observation. They do not prove native edit propagation, a complete product UI flow, production public hosting, physical-device behavior, OS file saving, or the large-backup transfer tested elsewhere.

Safe local result: `.data/native-cloud-results.json` (0600), with separate platform result JSONs and `.data/android-qa/cloud-session-device-final.log` / `.data/ios-cloud-native-session-final.log`. Proxy logs contain method/path/status and a Secure-cookie boolean only. Password input files in both private app containers and the temporary ignored host copies were checked absent after the run. The local proxy was stopped. The shared cloud QA config was not modified or deleted by this exercise.

## Repeat only while an explicitly prepared sealed QA fixture is live

Root's sealed verifier/config is deliberately retired after cloud verification. These tests must not provision a project, recreate users, relax TLS, use a production workspace, or silently replace the absent fixture. Without private input, the platform tests skip this opt-in case.

Use only the preinstalled SDKs, existing debug QA certificate/key and dedicated QA devices. The Android certificate trust is debug-only; the iOS certificate belongs only to the dedicated Simulator trust store. No release TLS configuration is changed.

```sh
node apps/mobile/tests/native-cloud-proxy.mjs
```

The proxy reads `.data/cloud-account-qa.json` only if its mode is 0600. Do not print that file. After installing the existing QA builds, deliver input privately using the helper; its device arguments contain no credentials:

```sh
python3 apps/mobile/tests/prepare-native-cloud-input.py android --device emulator-5554
python3 apps/mobile/tests/prepare-native-cloud-input.py ios --device YOUR_DEDICATED_QA_SIMULATOR_UUID
```

The helper refuses other AVDs/Simulators and uses private 0600 app files without overwriting an existing input. Only email/password and the fixed local HTTPS origin/workspace are transferred. The test removes its input immediately after reading it. No credential appears in a command argument or tracked resource.

Run Android's `dev.fountain.workspace.CloudSessionDeviceTest` via the existing instrumentation runner. Run iOS's `FountainNativeTests/FountainNativeTests/testActualSupabaseOwnerSessionAndPrivatePage` with `xcodebuild test-without-building`, the existing `FountainQA` scheme and dedicated destination. Build offline using the existing QA signing/SDK setup; do not download a new SDK or accept licenses automatically.

Collect only the safe `fountain-cloud-native-result.json` from each private app container. Compare workspace/member/role, require distinct binding digests and equal title digests, and require verified logout. Stop the local proxy and verify input-file removal. Leave shared QA attachments, backup jobs, users and the shared config for Root's coordinated cleanup.
