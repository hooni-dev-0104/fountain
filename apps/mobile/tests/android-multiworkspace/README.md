# Android account and workspace isolation

`run.sh` runs the production route, cookie, typed account path, organization cross-scope query, and network failure classification policy on the existing JDK. It does not claim Android execution.

It also composes the actual native JavaScript `publicURL` and `publicShareURL` outputs with production Java `PublicWebTrust`. Scoped external previews use the trusted public origin's `/#w/{workspace}/{form|site}/{slug}` route without a native child binding. The opt-in `PublicWebNavigationDeviceTest` checks the installed WebView's external intent boundary for those routes; its test monitor prevents launching an external browser and its anonymous HTTP replies are fixtures.

Resource tails use exact JavaScript `encodeURIComponent` spelling per segment. The workspace ID and child prefix remain literal ASCII. UTF-8, spaces and encoded `?`/`#` are preserved as ID data; encoded aliases, malformed UTF-8, slash/backslash, dots and C0/DEL/C1 controls remain denied, including nested encodings. `uri-composition.mjs` passes actual production scope-helper outputs into Java. `WorkspaceURIRequestDeviceTest` checks actual Android URI and HTTPS connection construction without connecting; the opt-in cloud journey separately checks a unique multilingual resource ID through real creation, canonical GET and resumed pending patch.

The account adapter forwards `x-fountain-account-directory: absent` only from a trusted `GET /api/account/session` response with exactly one literal `absent` value. Unmarked 401 responses, other methods/routes and unknown values cannot announce legacy capability. `PublicWebNavigationDeviceTest` also probes this real Capacitor response path using anonymous fixture 401 replies and verifies cookies and unknown headers remain hidden.

The same SDK component fixture checks account error projection: only the existing network-unreachable predicate's DNS/route/connect failures produce `NATIVE_NETWORK_UNREACHABLE`. TLS, timeout and storage failures retain denial codes; cancellation remains `CANCELLED` even if its disconnected fixture later throws a connect error. These are controlled component failures, not real TLS/provider tests.

`MultiworkspaceDeviceTest` runs production Android SQLite and AndroidKeyStore on an isolated QA emulator. Its session and canonical HTTP response objects are fixtures; it does not claim a real Supabase login or the native activation bridge's end-to-end HTTP journey.

The device checks cover parking versus permanent suspension, A → B → A source retention, canonical reconciliation with scoped pointers and original form input, account logout across active and parked children, independent encrypted realms, exact parent/member/child/absolute expiry requirements for offline resume, native retained hints after encrypted reload, offline CRDT/title/draft durability, cached native creation authority for local page and row mutations, and the inability to SEND while the canonical floor is missing.

Use only a disposable AVD. Never reset an existing user AVD, a physical device, or the user's app data. SDK/build tools and dependencies must already be installed. Example build:

```
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
apps/mobile/android/gradlew -p apps/mobile/android \
  :app:assembleDebug :app:assembleDebugAndroidTest --offline \
  -Pandroid.builder.sdkDownload=false
```

Install the two resulting APKs on the dedicated QA AVD and run `dev.fountain.workspace.MultiworkspaceDeviceTest` using `androidx.test.runner.AndroidJUnitRunner`. Android instrumentation may return shell exit 0 after failures: inspect `OK (14 tests)` and the absence of `FAILURES` explicitly.

The native account vault uses its own preferences, AES key, negative marker and bounded encrypted state. The original workspace and organization vaults retain their existing 32 KiB bound; account state allows 512 KiB to retain at most 128 prior native session proofs. Configuration publishes at most 100 token-free hints and exposes `retainedWorkspaceScopesTruncated` when bounded. Hints alone grant no admission. Explicit online activation always performs native HTTPS; explicit offline resume never creates a new grant, extends expiry, or supplies a canonical floor. Cached native resource proofs remain separate from live `resource_proofs`. Online canonical reconciliation is required before pending SEND resumes.

Native request order is captured privately per workspace. Newer successful native activation or session observations supersede older account-open results; stale results cannot retire the new child or replace its role. Trusted open denials retire only their exact captured child. Role or shorter-expiry observations disable cached offline authority until fresh native session validation and canonical reconciliation, without permanently suspending an otherwise unchanged child. Internal backup/recovery session responses participate in the same negative-observation rules. A separate account reconciliation marker blocks SEND even if a workspace GET has supplied a resource floor.


`cloud-device.py` is an explicit production HTTPS opt-in, unlike the fixture-only device class. It accepts only the fresh `FountainMultiworkspaceQA` emulator on serial `emulator-5584` and the Root-owned 0600 private input at `.data/multiworkspace/actual/native-private-fixture.json`. The instrumentation consumes that file before activity/network and verifies a frozen project/email/UID/workspace scope digest. No credential is placed in argv, Java source, BuildConfig, web assets or an APK. Input/output and app data are removed in `finally`; only the newly created native provider parent is logged out. Root remains responsible for global disposable Auth/workspace cleanup.

The real bridge journey calls production `accountRequest`, directory open, actual native `activateWorkspace` HTTPS, scoped reads, native canonical reconciliation and SQL stage/commit, A → B → A, then sends the exact persisted pending patch to its own unique Android QA page and reads the remote result. It deliberately leaves `rendererAutoSendVerified` and `finalUIAssetsVerified` false: direct Capacitor bridge authority is proven, while the complete app DOM/producer journey needs separate verification. Bounded collector retries and stable-command account-open busy retries do not bypass a canonical floor or re-login. Timestamped resource-floor observations are retained in the sanitized result.
