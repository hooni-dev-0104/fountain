# Android organization transport checks

`FOUNTAIN_JAVA_HOME=<existing JDK> ./run.sh` executes production typed route,
query binding, cookie realm and cookie attribute validation on a JVM. It does
not compile Android classes, contact Auth, or prove device behavior.

`OrganizationRealmDeviceTest` is an Android instrumentation fixture. It uses
uniquely named test preferences and AndroidKeyStore keys, invokes the production
organization persistence/response methods, and checks:

- organization quarantine retains its own cookie and binding for logout retry;
- workspace ciphertext, auth epoch, and actual SQLite outbox grant/lease/head remain unchanged;
- organization ciphertext cannot be opened with the workspace test key;
- organization 401 quarantines only organization state, while a workspace
  authorization 403 does not change organization state;
- backend configuration changes remove prior-origin organization credentials.

The fixture does not claim real HTTP/Auth or full UI bridge coverage. Build and
run it with the repository's existing Android SDK/device workflow, without
installing another SDK or starting a new emulator implicitly.

The public bridge methods are `organizationRequest` and `organizationCancel`.
Cancel input is exactly `{id,generation}` and cannot cancel workspace requests.
Request input is exactly `{id,generation,path,method,headers,bodyBase64,timeoutMs}`;
response is `{generation,status,headers,bodyBase64}`. Organization requests are
bounded to 64 KiB JSON input, 2 MiB response, and 45 seconds. Cookies remain
native-only. Workspace requests reject the organization namespace, including
encoded aliases, before workspace admission or authentication state changes.
