package dev.fountain.workspace;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;
import org.json.JSONArray;

/** Native-only session ownership and bounded HTTPS for the packaged main frame. */
@CapacitorPlugin(name = "FountainNative")
public class FountainNativePlugin extends Plugin {
    private final Object lock = new Object();
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final ExecutorService sessions = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Operation> operations = new HashMap<>();
    private long generation, authGeneration, ownerBoundaryEpoch;
    private final Runnable boundaryInvalidated = () -> {
        synchronized (lock) { invalidateRecovery(); authGeneration++; cancelAll(null, "STALE_SESSION"); }
    };
    private CookieVault vault;
    private static final boolean OUTBOX_ENABLED = false; // Enable only after SDK/device and recovery-UI verification.
    private NativeOutbox outbox;
    private NativeRecovery recovery;
    private volatile boolean recoveryMode;
    private long recoveryEpoch;
    private final String outboxOwner = java.util.UUID.randomUUID().toString();
    private String origin, activeCookie, revokeCookie, revokeOrigin;
    private boolean broken, destroyed;
    private Operation picker;

    private static final class Operation {
        final String id, origin;
        final long generation, boundaryEpoch;
        final PluginCall call;
        final boolean logout;
        final AtomicBoolean closed = new AtomicBoolean();
        volatile long authGeneration;
        volatile HttpsURLConnection connection;
        volatile File file;
        volatile OutputStream exportStream;
        volatile ScheduledFuture<?> timeout;
        volatile long deadline;
        volatile long responseProofEpoch = -1, responseProofBoundary = -1, responseProofDeadline = Long.MAX_VALUE;
        volatile NativeOutbox responseProofStore;
        volatile NativeRecovery.Prepared recoveryExport;
        String undeliveredRecoveryInventory, undeliveredRecoveryExport;
        volatile NativeRecovery.Authority recoveryAuthority;
        int recoveryFileIndex, filesSaved;
        Operation(String id, String origin, long generation, long authGeneration, PluginCall call, boolean logout) {
            this.id = id; this.origin = origin; this.generation = generation;
            this.authGeneration = authGeneration; this.call = call; this.logout = logout;
            this.boundaryEpoch = NativeCookieBoundary.epoch();
        }
    }

    private static final class Response {
        int status;
        JSObject headers;
        byte[] body;
        String cookie;
    }

    @Override public void load() {
        ownerBoundaryEpoch = NativeCookieBoundary.epoch();
        try {
            vault = new CookieVault(getContext());
            JSONObject state = vault.read();
            origin = state.isNull("origin") ? null : state.optString("origin", null);
            if (origin != null) origin = NativePolicy.origin(origin);
            generation = state.optLong("generation", 0);
            NativePolicy.require(generation >= 0 && generation < 9_007_199_254_740_991L);
            activeCookie = nullable(state, "active");
            revokeCookie = nullable(state, "revoke");
            revokeOrigin = nullable(state, "revoke_origin");
            NativePolicy.require((activeCookie == null || origin != null)
                && (revokeCookie == null) == (revokeOrigin == null)
                && (activeCookie == null || revokeCookie == null));
            if (revokeOrigin != null) revokeOrigin = NativePolicy.origin(revokeOrigin);
            NativePolicy.SessionRead restored = NativePolicy.restoreSession(activeCookie, revokeCookie, vault.invalidated(origin));
            if (activeCookie != null && restored.active == null) revokeOrigin = origin;
            activeCookie = restored.active; revokeCookie = restored.revoke;
            cleanAbandonedExports();
        } catch (Exception error) { broken = true; }
        NativeCookieBoundary.register(boundaryInvalidated);
    }

    private static String nullable(JSONObject state, String key) {
        return state.isNull(key) ? null : state.optString(key, null);
    }

    private JSONObject record(String nextOrigin, long nextGeneration, String active, String revoke, String pendingOrigin) throws Exception {
        JSONObject state = new JSONObject();
        state.put("origin", nextOrigin == null ? JSONObject.NULL : nextOrigin);
        state.put("generation", nextGeneration);
        state.put("active", active == null ? JSONObject.NULL : active);
        state.put("revoke", revoke == null ? JSONObject.NULL : revoke);
        state.put("revoke_origin", pendingOrigin == null ? JSONObject.NULL : pendingOrigin);
        return state;
    }

    private NativePolicy.SessionStorage sessionStorage() {
        return new NativePolicy.SessionStorage() {
            public boolean markInvalidated(String server) { return vault.markInvalidated(server); }
            public boolean saveRevokeOnly(String server, String token) {
                try { vault.write(record(origin, generation, null, token, token == null ? null : server)); return true; }
                catch (Exception failure) { return false; }
            }
            public boolean eraseEncryptedState() { return vault.eraseEncryptedState(); }
            public boolean destroyEncryptionKey() { return vault.destroyEncryptionKey(); }
        };
    }

    private void persist(String nextOrigin, long nextGeneration, String active, String revoke, String pendingOrigin) throws Exception {
        if (destroyed || !NativeCookieBoundary.permits(ownerBoundaryEpoch)) throw new IOException();
        // Journal before every credential-state write. Clear only after its
        // sealed replacement is durable; an interrupted active write is revoke-only.
        NativePolicy.SessionInvalidation before = NativePolicy.fenceSession(nextOrigin, null, sessionStorage());
        if (!before.journaled) {
            broken = true;
            throw new NativePolicy.SessionStorageFailure(before.durable);
        }
        try {
            vault.write(record(nextOrigin, nextGeneration, active, revoke, pendingOrigin));
            if (active != null || revoke == null) vault.clearInvalidated(nextOrigin);
        } catch (Exception failure) {
            // Even a failed journal-clear is uncertain. Re-establish the fence
            // or quarantine the record/key before classifying restart safety.
            NativePolicy.SessionInvalidation after = NativePolicy.fenceSession(nextOrigin, null, sessionStorage());
            broken = true;
            throw new NativePolicy.SessionStorageFailure(after.durable);
        }
    }

    private NativePolicy.SessionInvalidation invalidateSession() {
        return invalidateSession(null);
    }
    private NativePolicy.SessionInvalidation invalidateSession(String explicitNativeActor) {
        if (OUTBOX_ENABLED && !recoveryMode) try { NativeOutbox storage=durableOutbox();storage.revoke();if(explicitNativeActor!=null)storage.eraseActor(explicitNativeActor); }
        catch (Exception failure) { broken = true; }
        NativePolicy.SessionInvalidation result = NativePolicy.invalidateSession(origin, activeCookie, revokeCookie, sessionStorage());
        activeCookie = null;
        revokeCookie = result.revoke;
        revokeOrigin = result.revoke == null ? null : origin;
        if (broken) retryRevocationAfterStorageFailure();
        if (!result.saved) {
            broken = true;
            retryRevocationAfterStorageFailure();
        }
        return result;
    }

    private void retryRevocationAfterStorageFailure() {
        // Storage faults never suppress the old-cookie DELETE attempt. This is
        // independent of caller cancellation and cannot re-enable ordinary API I/O.
        sessions.execute(() -> { try { revokePending(); } catch (Exception ignored) {} });
    }

    /** UI-thread frame/configuration check; MessageHandler authenticates main-frame origin. */
    private boolean bundleAllowed() {
        try {
            if (!(getActivity() instanceof MainActivity) || !((MainActivity) getActivity()).permitsNativeBridge()) return false;
            URI current = new URI(getBridge().getWebView().getUrl());
            URI local = new URI(getBridge().getLocalUrl());
            return Objects.equals(current.getScheme(), local.getScheme())
                && Objects.equals(current.getRawAuthority(), local.getRawAuthority());
        } catch (Exception error) { return false; }
    }

    private void entry(PluginCall call, Runnable action) {
        getActivity().runOnUiThread(() -> {
            if (!bundleAllowed()) { call.reject("Bundled main frame required", "FORBIDDEN_FRAME"); return; }
            synchronized (lock) {
                if (destroyed || broken || !NativeCookieBoundary.permits(ownerBoundaryEpoch)) { call.reject("Secure native transport unavailable", "UNAVAILABLE"); return; }
                try { action.run(); }
                catch (Exception error) { call.reject("Invalid native transport input or secure storage unavailable", "NATIVE_INPUT"); }
            }
        });
    }

    private JSObject configuration() {
        JSObject result = new JSObject();
        result.put("origin", origin == null ? JSONObject.NULL : origin);
        result.put("generation", generation);
        result.put("outboxVersion", 1); result.put("outboxEnabled", OUTBOX_ENABLED);
        result.put("recoveryVersion", 1); result.put("recoveryEnabled", true);
        return result;
    }

    @PluginMethod public void getConfiguration(PluginCall call) { entry(call, () -> call.resolve(configuration())); }

    @PluginMethod public void configure(PluginCall call) {
        entry(call, () -> sessionWrite(() -> {
            synchronized (lock) {
                String next;
                try {
                    next = NativePolicy.origin(call.getString("origin"));
                    NativePolicy.require(!destroyed && !broken && NativeCookieBoundary.permits(ownerBoundaryEpoch)
                        && activeCookie == null && revokeCookie == null);
                } catch (IllegalArgumentException invalid) {
                    call.reject("Invalid configuration or session is still active", "NATIVE_INPUT"); return;
                }
                try {
                    invalidateRecovery();
                    if (OUTBOX_ENABLED && !recoveryMode && origin != null) durableOutbox().revoke();
                    persist(next, generation + 1, null, null, null);
                    if (outbox != null) { outbox.close(); outbox = null; }
                    origin = next; generation++; authGeneration++; cancelAll(null, "CONFIGURATION_CHANGED");
                    call.resolve(configuration());
                } catch (Exception error) { broken = true; call.reject("Native configuration storage unavailable", "UNAVAILABLE"); }
            }
        }));
    }

    private void sessionWrite(Runnable action) { if (OUTBOX_ENABLED || recoveryMode) sessions.execute(action); else action.run(); }

    private NativeOutbox durableOutbox() throws Exception {
        NativePolicy.require(origin != null);
        if (outbox == null) outbox = new NativeOutbox(getContext(), origin);
        NativePolicy.require(outbox.origin.equals(origin)); return outbox;
    }
    private boolean outboxBlocked() { return broken || destroyed || revokeCookie != null || vault.invalidated(origin); }
    private interface OutboxAction { JSObject run(NativeOutbox storage) throws Exception; }
    private void outboxCall(PluginCall call, OutboxAction action) {
        entry(call, () -> {
            if (!OUTBOX_ENABLED) { call.reject("Native durable outbox is not enabled", "OUTBOX_DISABLED"); return; }
            if (recoveryMode) { call.reject("Recovery mode preserves the device archive", "OUTBOX_ACCESS_REQUIRED"); return; }
            sessions.execute(() -> {
            synchronized (lock) {
                try {
                    if (recoveryMode) throw new NativeOutbox.AccessRequired();
                    NativePolicy.require(!broken && !destroyed && NativeCookieBoundary.permits(ownerBoundaryEpoch)
                        && integer(call, "generation", 0, OutboxPolicy.SAFE - 1) == generation);
                    NativeOutbox storage = durableOutbox();
                    JSObject result = action.run(storage);
                    long expected = generation, expectedAuth = authGeneration, expectedBoundary = storage.boundary(), expectedProof = storage.proofEpoch();
                    long expectedDeadline = result.has("fragments") || "verified".equals(result.optString("identityState")) ? storage.deliveryDeadline() : Long.MAX_VALUE;
                    String expectedOrigin = origin;
                    getActivity().runOnUiThread(() -> { synchronized (lock) {
                        if (!broken && !destroyed && generation == expected && authGeneration == expectedAuth
                            && Objects.equals(origin, expectedOrigin) && outbox == storage && storage.boundary() == expectedBoundary
                            && storage.proofEpoch() == expectedProof && System.currentTimeMillis() < expectedDeadline
                            && NativeCookieBoundary.permits(ownerBoundaryEpoch) && bundleAllowed()) call.resolve(result);
                        else call.reject("Native outbox owner changed", "STALE_SESSION");
                    } });
                } catch (NativeOutbox.AccessRequired error) { call.reject("Native resource access must be refreshed", "OUTBOX_ACCESS_REQUIRED"); }
                catch (IllegalArgumentException error) { call.reject("Native outbox scope or input rejected", "OUTBOX_REJECTED"); }
                catch (Exception error) {
                    // Any uncertain SQLite outcome fences this owner, including subsequent reads.
                    broken = true; authGeneration++; cancelAll(null, "OUTBOX_STORAGE_FAILED");
                    vault.markInvalidated(origin);
                    call.reject("Native outbox storage unavailable", "OUTBOX_STORAGE_FAILED");
                }
            }
        }); });
    }
    @PluginMethod public void outboxOpen(PluginCall call) {
        outboxCall(call, storage -> storage.open(generation, activeCookie, outboxBlocked(), outboxOwner + ":" + authGeneration));
    }
    @PluginMethod public void stageDelta(PluginCall call) { outboxCall(call, storage -> storage.stage(call.getData(), generation)); }
    @PluginMethod public void commitDelta(PluginCall call) {
        outboxCall(call, storage -> storage.commit(call.getData(), generation, activeCookie, outboxBlocked()));
    }
    @PluginMethod public void readPage(PluginCall call) {
        outboxCall(call, storage -> storage.read(call.getData(), generation, activeCookie, outboxBlocked()));
    }

    private static long integer(PluginCall call, String key, long minimum, long maximum) {
        Object value = call.getData().opt(key);
        NativePolicy.require(value instanceof Number);
        double number = ((Number) value).doubleValue();
        long result = ((Number) value).longValue();
        NativePolicy.require(Double.isFinite(number) && number == result && result >= minimum && result <= maximum);
        return result;
    }

    private Operation begin(PluginCall call, boolean logout, int timeoutMs) {
        NativePolicy.require(origin != null && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation);
        String id = call.getString("id");
        NativePolicy.require(id != null && id.matches("[A-Za-z0-9_.:-]{1,160}") && !operations.containsKey(id));
        Operation operation = new Operation(id, origin, generation, authGeneration, call, logout);
        operation.deadline = SystemClock.elapsedRealtime() + timeoutMs;
        operations.put(id, operation);
        operation.timeout = deadlines.schedule(() -> fail(operation, "Native operation timed out", "TIMEOUT"), timeoutMs, TimeUnit.MILLISECONDS);
        return operation;
    }

    private static byte[] decodeBody(PluginCall call, int limit) {
        String encoded = call.getString("bodyBase64", "");
        NativePolicy.require(encoded.length() <= ((limit + 2L) / 3L) * 4L && encoded.length() % 4 == 0);
        int padding = 0;
        for (int i = 0; i < encoded.length(); i++) {
            char point = encoded.charAt(i);
            if (point == '=') { padding++; NativePolicy.require(i >= encoded.length() - 2 && padding <= 2); }
            else NativePolicy.require(padding == 0 && (point >= 'A' && point <= 'Z' || point >= 'a' && point <= 'z'
                || point >= '0' && point <= '9' || point == '+' || point == '/'));
        }
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
        NativePolicy.require(bytes.length <= limit);
        return bytes;
    }

    private static Map<String, String> requestHeaders(PluginCall call) {
        JSObject source = call.getObject("headers", new JSObject());
        Map<String, String> headers = new HashMap<>();
        Iterator<String> keys = source.keys();
        int count = 0;
        while (keys.hasNext()) {
            NativePolicy.require(++count <= 4);
            String key = keys.next(), value = source.getString(key);
            NativePolicy.header(key, value);
            key = key.toLowerCase(Locale.ROOT);
            NativePolicy.require(!headers.containsKey(key));
            headers.put(key, value);
        }
        return headers;
    }

    @PluginMethod public void request(PluginCall call) {
        entry(call, () -> sessionWrite(() -> {
            synchronized (lock) { try {
            String path = NativePolicy.path(call.getString("path"), false);
            String method = call.getString("method");
            NativePolicy.require(NativePolicy.METHODS.contains(method));
            byte[] body = decodeBody(call, NativePolicy.MAX_REQUEST);
            NativePolicy.require(!method.equals("GET") || body.length == 0);
            Map<String, String> headers = requestHeaders(call);
            int timeout = (int) integer(call, "timeoutMs", 1, 45000);
            boolean session = NativePolicy.sessionPath(path);
            boolean mutation = session && (method.equals("POST") || method.equals("DELETE"));
            if(recoveryMode&&!session&&!"GET".equals(method)){call.reject("Recovery mode requires an explicit return before syncing","RECOVERY_ACCESS_REQUIRED");return;}
            NativePolicy.require(!session || method.equals("GET") || mutation);
            // Validate scope/id before a malformed call can mutate auth state.
            NativePolicy.require(origin != null && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation);
            String id = call.getString("id");
            NativePolicy.require(id != null && id.matches("[A-Za-z0-9_.:-]{1,160}") && !operations.containsKey(id));
            if (mutation) {
                String explicitNativeActor=null;
                if(method.equals("DELETE")&&OUTBOX_ENABLED&&!recoveryMode)try{explicitNativeActor=durableOutbox().nativeActor(activeCookie!=null?activeCookie:revokeCookie);}catch(Exception unavailable){broken=true;}
                invalidateRecovery();
                authGeneration++;
                cancelAll(null, "SESSION_CHANGED");
                NativePolicy.SessionInvalidation invalidated = invalidateSession(explicitNativeActor);
                if (!invalidated.saved) {
                    call.reject(invalidated.durable ? "Secure session storage failed; local session remains invalidated"
                        : "Durable session invalidation failed; remote revocation is being attempted",
                        invalidated.durable ? "SESSION_STORAGE_FAILED" : "DURABLE_INVALIDATION_FAILED");
                    return;
                }
            }
            Operation operation = begin(call, session && method.equals("DELETE"), timeout);
            Runnable work = () -> {
                try {
                    if (session) revokePending(); // Never attaches the caller's cancellable connection.
                    check(operation);
                    if (operation.logout) {
                        Response response = exchange(operation, operation.origin, path, "DELETE", headers, body, null, null);
                        if (response.status >= 200 && response.status < 300 || response.status == 401 || response.status == 403) {
                            synchronized (lock) { check(operation); persist(origin, generation, null, null, null); }
                        }
                        deliverResponse(operation, response);
                    } else {
                        String cookie;
                        synchronized (lock) { check(operation); cookie = activeCookie; }
                        Response response = exchange(operation, operation.origin, path, method, headers, body, cookie, null);
                        if (session) {
                            applySessionResponse(operation, response, method.equals("POST"), true, cookie);
                            deliverResponse(operation, response);
                        } else sessionWrite(() -> {
                            try { applySessionResponse(operation, response, false, false, cookie); observeResourceResponse(operation, response, method, path, cookie); deliverResponse(operation, response); }
                            catch (NativeOutbox.AccessRequired error) { fail(operation, "Native resource access must be refreshed", "OUTBOX_ACCESS_REQUIRED"); }
                            catch (Exception error) { fail(operation, "Native session or outbox unavailable", "STALE_SESSION"); }
                        });
                    }
                } catch (Exception error) {
                    boolean pending;
                    synchronized (lock) { pending = revokeCookie != null || broken; }
                    fail(operation, pending ? "Session revocation is pending" : "Native HTTPS request failed",
                        pending ? "SESSION_REVOCATION_PENDING" : "NETWORK_ERROR");
                }
            };
            (session ? sessions : workers).execute(work);
            } catch (Exception error) { call.reject("Native request input or storage unavailable", "NATIVE_INPUT"); } }
        }));
    }

    /** Revocation is serialized and is never cancel(id)'s connection. */
    private void revokePending() throws Exception {
        String token, server;
        long boundaryEpoch = NativeCookieBoundary.epoch();
        synchronized (lock) { token = revokeCookie; server = revokeOrigin; }
        if (token == null) return;
        if (!NativeCookieBoundary.permits(boundaryEpoch)) throw new IOException();
        HttpsURLConnection connection = open(server, "/api/session", "DELETE", new HashMap<>(), new byte[0], token, 45000, boundaryEpoch);
        ScheduledFuture<?> timeout = deadlines.schedule(connection::disconnect, 45, TimeUnit.SECONDS);
        try {
            int status = connection.getResponseCode();
            if (!NativeCookieBoundary.permits(boundaryEpoch) || !(status >= 200 && status < 300 || status == 401 || status == 403)) throw new IOException();
            synchronized (lock) {
                if (Objects.equals(token, revokeCookie) && Objects.equals(server, revokeOrigin)
                    && !destroyed && NativeCookieBoundary.permits(ownerBoundaryEpoch)) {
                    persist(origin, generation, activeCookie, null, null);
                    revokeCookie = null; revokeOrigin = null;
                }
            }
        } finally { timeout.cancel(false); connection.disconnect(); }
    }

    private HttpsURLConnection open(String server, String path, String method, Map<String, String> headers,
                                    byte[] body, String cookie, int timeout, long boundaryEpoch) throws Exception {
        if (!NativeCookieBoundary.permits(boundaryEpoch)) throw new IOException();
        URL url = new URL(server + path);
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        // Construction may capture the process CookieHandler. An epoch change
        // between both checks fences activity reinitialization before any I/O.
        if (!NativeCookieBoundary.permits(boundaryEpoch)) { connection.disconnect(); throw new IOException(); }
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout);
        connection.setRequestMethod(method);
        connection.setRequestProperty("X-Fountain-Request", "1");
        connection.setRequestProperty("Accept-Encoding", "identity");
        for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
        if (cookie != null) connection.setRequestProperty("Cookie", "fountain_session=" + cookie);
        if (body.length > 0 || method.equals("POST") || method.equals("PUT") || method.equals("PATCH")) {
            connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length);
        }
        return connection;
    }

    private Response exchange(Operation operation, String server, String path, String method, Map<String, String> headers,
                              byte[] body, String cookie, File destination) throws Exception {
        check(operation);
        HttpsURLConnection connection = open(server, path, method, headers, body, cookie,
            (int) Math.max(1, operation.deadline - SystemClock.elapsedRealtime()), operation.boundaryEpoch);
        try {
            synchronized (lock) { operation.connection = connection; check(operation); }
            if (connection.getDoOutput()) try (OutputStream stream = connection.getOutputStream()) {
                for (int offset = 0; offset < body.length; offset += 65536) {
                    check(operation); stream.write(body, offset, Math.min(65536, body.length - offset));
                }
            }
            check(operation);
            Response response = new Response(); response.status = connection.getResponseCode();
            NativePolicy.require(response.status >= 100 && response.status <= 599);
            response.headers = safeHeaders(connection.getHeaderFields());
            response.cookie = NativePolicy.sessionCookie(connection.getHeaderFields(), server);
            if (destination != null && response.status != 200) throw new IOException();
            long expected = connection.getContentLengthLong();
            if (response.status == 204 || response.status == 304) expected = 0;
            if (destination == null && expected > NativePolicy.MAX_RESPONSE) throw new IOException();
            ByteArrayOutputStream memory = destination == null ? new ByteArrayOutputStream() : null;
            long received = 0;
            try (InputStream input = response.status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                 OutputStream output = destination == null ? memory : new FileOutputStream(destination)) {
                if (input != null) {
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        check(operation); received += count;
                        if (received < 0 || destination == null && received > NativePolicy.MAX_RESPONSE) throw new IOException();
                        output.write(buffer, 0, count);
                    }
                }
                check(operation);
                if (expected >= 0 && received != expected) throw new IOException();
                output.flush();
            }
            response.body = memory == null ? null : memory.toByteArray();
            return response;
        } finally { connection.disconnect(); operation.connection = null; }
    }

    private static JSObject safeHeaders(Map<String, List<String>> source) {
        JSObject result = new JSObject();
        for (Map.Entry<String, List<String>> header : source.entrySet()) {
            if (header.getKey() == null) continue;
            String key = header.getKey().toLowerCase(Locale.ROOT);
            if (!NativePolicy.RESPONSE_HEADERS.contains(key)) continue;
            StringBuilder joined = new StringBuilder();
            for (String item : header.getValue()) { if (joined.length() > 0) joined.append(", "); joined.append(item); }
            String value = joined.toString();
            NativePolicy.require(value.length() <= 8192 && !NativePolicy.controls(value));
            result.put(key, value);
        }
        return result;
    }

    private void applySessionResponse(Operation operation, Response response, boolean login, boolean session, String sentCookie) throws Exception {
        synchronized (lock) {
            check(operation);
            if (login && response.status >= 200 && response.status < 300) {
                NativePolicy.require(response.cookie != null && !response.cookie.isEmpty());
                try {
                    persist(origin, generation, response.cookie, revokeCookie, revokeOrigin);
                    activeCookie = response.cookie;
                } catch (Exception failure) {
                    activeCookie = null; revokeCookie = response.cookie; revokeOrigin = origin;
                    broken = true; authGeneration++;
                    boolean durable = failure instanceof NativePolicy.SessionStorageFailure
                        && ((NativePolicy.SessionStorageFailure) failure).durable;
                    fail(operation, durable ? "Secure session storage failed; local session remains invalidated"
                        : "Durable session invalidation failed; remote revocation is being attempted",
                        durable ? "SESSION_STORAGE_FAILED" : "DURABLE_INVALIDATION_FAILED");
                    cancelAll(null, "SESSION_STORAGE_FAILED");
                    retryRevocationAfterStorageFailure();
                    throw new IOException();
                }
            } else if (response.status == 401 && (OUTBOX_ENABLED || recoveryMode || sentCookie != null) && Objects.equals(sentCookie, activeCookie)) {
                invalidateRecovery();
                authGeneration++;
                operation.authGeneration = authGeneration;
                cancelAll(operation, "SESSION_EXPIRED");
                NativePolicy.SessionInvalidation invalidated = invalidateSession();
                if (!invalidated.saved) {
                    fail(operation, invalidated.durable ? "Secure session storage failed; local session remains invalidated"
                        : "Durable session invalidation failed; remote revocation is being attempted",
                        invalidated.durable ? "SESSION_STORAGE_FAILED" : "DURABLE_INVALIDATION_FAILED");
                    throw new IOException();
                }
            }
            if (OUTBOX_ENABLED && !recoveryMode && session && response.status == 200) {
                JSONObject description;
                try { description = new JSONObject(OutboxPolicy.utf8(response.body)); }
                catch (Exception malformed) { durableOutbox().revoke(); throw new IOException(); }
                if (description.opt("authenticated") == Boolean.FALSE) durableOutbox().revoke();
                else if (description.opt("authenticated") == Boolean.TRUE) {
                    NativePolicy.require(!outboxBlocked() && (response.cookie == null || response.cookie.equals(activeCookie)));
                    try { durableOutbox().grant(description, activeCookie); }
                    catch(NativeOutbox.AccessRequired recoveryRequired) { /* Actual session HTTP remains authoritative; hydration requires explicit recovery. */ }
                    catch (Exception invalid) { durableOutbox().revoke(); throw new IOException(); }
                } else { durableOutbox().revoke(); throw new IOException(); }
            }
            if(recoveryMode&&session&&response.status==200&&recovery!=null){
                try{NativeRecovery.Session identity=new NativeRecovery.Session(operation.origin,new JSONObject(OutboxPolicy.utf8(response.body)),activeCookie,
                    operation.generation+":"+operation.authGeneration+":"+operation.boundaryEpoch);recovery.refresh(identity);}
                catch(Exception unauthenticated){invalidateRecovery();}
            }
        }
    }

    private void deliverResponse(Operation operation, Response response) {
        getActivity().runOnUiThread(() -> {
            synchronized (lock) {
                try {
                    check(operation);
                    if (!bundleAllowed()) throw new IOException();
                    if (operation.responseProofStore != null && (outbox != operation.responseProofStore
                        || outbox.proofEpoch() != operation.responseProofEpoch || outbox.boundary() != operation.responseProofBoundary
                        || System.currentTimeMillis() >= operation.responseProofDeadline)) throw new NativeOutbox.AccessRequired();
                    JSObject result = new JSObject(); result.put("status", response.status);
                    result.put("headers", response.headers); result.put("bodyBase64", Base64.encodeToString(response.body, Base64.NO_WRAP));
                    result.put("generation", operation.generation);
                    succeed(operation, result);
                } catch (NativeOutbox.AccessRequired error) { fail(operation, "Native resource access must be refreshed", "OUTBOX_ACCESS_REQUIRED"); }
                catch (Exception error) { fail(operation, "Native request was superseded or secure session storage failed", "STALE_SESSION"); }
            }
        });
    }

    private void observeResourceResponse(Operation operation, Response response, String method, String path, String sentCookie) throws Exception {
        if (recoveryMode) {
            if(recovery!=null&&NativeRecovery.authorityPath(method,path))synchronized(lock) { check(operation); if(!Objects.equals(sentCookie,activeCookie))throw new NativeRecovery.Failure("RECOVERY_STALE");
                recovery.observe(method,path,response.status,response.status==200?new JSONObject(OutboxPolicy.utf8(response.body)):new JSONObject()); }
            return;
        }
        if (!OUTBOX_ENABLED || OutboxPolicy.canonicalResource(method, path) == null || !(response.status == 200 || response.status == 403 || response.status == 404)) return;
        synchronized (lock) {
            check(operation); if (!Objects.equals(sentCookie, activeCookie)) throw new NativeOutbox.AccessRequired();
            try {
                NativeOutbox storage = durableOutbox();
                storage.observe(method, path, response.status, response.body, activeCookie, outboxBlocked(), outboxOwner + ":" + authGeneration);
                operation.responseProofStore = storage; operation.responseProofEpoch = storage.proofEpoch();
                operation.responseProofBoundary = storage.boundary(); operation.responseProofDeadline = storage.deliveryDeadline();
            } catch (NativeOutbox.AccessRequired required) { throw required; }
            catch (Exception failure) {
                broken = true; authGeneration++; cancelAll(null, "OUTBOX_STORAGE_FAILED"); vault.markInvalidated(origin);
                throw failure;
            }
        }
    }

    private void check(Operation operation) throws IOException {
        synchronized (lock) {
            if (operation.closed.get() || broken || destroyed || operation.generation != generation
                || operation.authGeneration != authGeneration || !Objects.equals(operation.origin, origin)
                || !NativeCookieBoundary.permits(operation.boundaryEpoch)
                || SystemClock.elapsedRealtime() > operation.deadline) throw new IOException();
        }
    }

    private void invalidateRecovery() {
        recoveryEpoch++;
        if(!sessions.isShutdown())sessions.execute(() -> { if(recovery!=null)recovery.invalidate(); });
    }

    private NativeRecovery.Authority recoveryAuthority(Operation operation,long epoch,String cookie) {
        return new NativeRecovery.Authority() {
            public void check() throws Exception {
                FountainNativePlugin.this.check(operation);
                synchronized(lock){if(!recoveryMode||recoveryEpoch!=epoch||!Objects.equals(cookie,activeCookie))throw new NativeRecovery.Failure("RECOVERY_STALE");}
            }
            public JSONObject get(String path)throws Exception {
                check();Response response=exchange(operation,operation.origin,path,"GET",new HashMap<>(),new byte[0],cookie,null);check();
                if(response.status==401||response.status==403||response.status==404){
                    if(recovery!=null&&response.status!=401)recovery.observe("GET",path,response.status,new JSONObject());
                    throw new NativeRecovery.Failure(response.status==401?"RECOVERY_AUTH_REQUIRED":"RECOVERY_ACCESS_REQUIRED");
                }
                if(response.status!=200)throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED");
                return new JSONObject(OutboxPolicy.utf8(response.body));
            }
        };
    }
    private NativeRecovery.Authority refreshRecovery(Operation operation,long epoch)throws Exception {
        String cookie;synchronized(lock){check(operation);cookie=activeCookie;if(revokeCookie!=null||vault.invalidated(origin))throw new NativeRecovery.Failure("RECOVERY_AUTH_REQUIRED");}
        NativeRecovery.Authority authority=recoveryAuthority(operation,epoch,cookie);
        JSONObject description;
        try{description=authority.get("/api/session");authority.check();}
        catch(NativeRecovery.Failure failure){if("RECOVERY_AUTH_REQUIRED".equals(failure.code)){if(recovery!=null)recovery.invalidate();synchronized(lock){recoveryEpoch++;}}throw failure;}
        NativeRecovery.Session identity;
        try {identity=new NativeRecovery.Session(operation.origin,description,cookie,operation.generation+":"+operation.authGeneration+":"+operation.boundaryEpoch);}
        catch(Exception unauthenticated){if(recovery!=null)recovery.invalidate();synchronized(lock){recoveryEpoch++;}throw new NativeRecovery.Failure("RECOVERY_AUTH_REQUIRED");}
        if(recovery==null)recovery=new NativeRecovery(getContext());recovery.refresh(identity);return authority;
    }
    private interface RecoveryAction { JSObject run(Operation operation,NativeRecovery.Authority authority)throws Exception; }
    private void recoveryCall(PluginCall call,boolean inventory,RecoveryAction action) {
        entry(call,()->{
            if(inventory)recoveryMode=true;
            if(!recoveryMode){call.reject("Open recovery inventory first","RECOVERY_STALE");return;}
            Operation operation;
            try {operation=begin(call,false,45000);}catch(Exception invalid){call.reject("Recovery request is stale","RECOVERY_STALE");return;}
            final long epoch=recoveryEpoch;
            sessions.execute(()->{
                try {
                    NativeRecovery.Authority authority=refreshRecovery(operation,epoch);operation.recoveryAuthority=authority;
                    JSObject result=action.run(operation,authority);if(result==null)return;
                    synchronized(lock){if(result.has("exportToken")){operation.undeliveredRecoveryInventory=call.getString("inventoryToken");operation.undeliveredRecoveryExport=result.getString("exportToken");}if(operation.closed.get()){cleanupFile(operation);return;}}
                    getActivity().runOnUiThread(()->{synchronized(lock){try{authority.check();recovery.checkResponse(result,authority);if(!bundleAllowed())throw new NativeRecovery.Failure("RECOVERY_STALE");succeed(operation,result);}catch(Exception stale){fail(operation,"Recovery request was superseded","RECOVERY_STALE");}}});
                }catch(NativeRecovery.Failure failure){fail(operation,failure.getMessage(),failure.code);}
                catch(Exception failure){fail(operation,"Recovery storage or authority is unavailable","RECOVERY_STORAGE");}
            });
        });
    }
    @PluginMethod public void recoveryInventory(PluginCall call) {
        recoveryCall(call,true,(operation,authority)->{
            int limit=(int)integer(call,"limit",1,100);return recovery.inventory(call.getString("cursor"),limit,operation.generation,authority);
        });
    }
    @PluginMethod public void recoveryExport(PluginCall call) {
        if("cancel".equals(call.getString("phase"))){
            entry(call,()->{long requested=integer(call,"generation",0,OutboxPolicy.SAFE-1);if(requested!=generation){call.reject("Recovery request is stale","RECOVERY_STALE");return;}
                Operation operation=begin(call,false,45000);
                sessions.execute(()->{try{check(operation);if(recovery!=null)recovery.cancel(call.getString("inventoryToken"),call.getString("exportToken"));JSObject result=new JSObject();result.put("generation",generation);result.put("cancelled",true);
                    getActivity().runOnUiThread(()->{synchronized(lock){try{check(operation);succeed(operation,result);}catch(Exception stale){fail(operation,"Recovery request is stale","RECOVERY_STALE");}}});
                }catch(Exception stale){fail(operation,"Recovery request is stale","RECOVERY_STALE");}});
            });return;
        }
        recoveryCall(call,false,(operation,authority)->{
            JSONArray handles=call.getData().getJSONArray("handles");String token=call.getString("inventoryToken"),phase=call.getString("phase");
            if("prepare".equals(phase))return recovery.prepare(token,handles,operation.generation,authority);
            if(!"save".equals(phase))throw new NativeRecovery.Failure("RECOVERY_STALE");
            NativeRecovery.Prepared prepared=recovery.saving(token,call.getString("exportToken"),handles,authority);
            operation.recoveryExport=prepared;
            if(prepared.files.isEmpty()){JSObject empty=new JSObject();empty.put("generation",operation.generation);empty.put("saved",false);empty.put("filesSaved",0);return empty;}
            operation.file=prepared.files.get(0);showSave(operation,"fountain-recovery-1.json");return null;
        });
    }

    private void succeed(Operation operation, JSObject result) {
        if (!operation.closed.compareAndSet(false, true)) return;
        operations.remove(operation.id);
        if (operation.timeout != null) operation.timeout.cancel(false);
        operation.undeliveredRecoveryExport=null;operation.undeliveredRecoveryInventory=null;
        cleanupFile(operation);
        operation.call.resolve(result);
    }

    private void fail(Operation operation, String message, String code) {
        synchronized (lock) {
            if (!operation.closed.compareAndSet(false, true)) { cleanupFile(operation); return; }
            operations.remove(operation.id);
            if (operation.timeout != null) operation.timeout.cancel(false);
            if (operation.connection != null) operation.connection.disconnect();
            if (operation.exportStream != null) try { operation.exportStream.close(); } catch (IOException ignored) {}
            cleanupFile(operation);
            operation.call.reject(message, code); // Never pass native exceptions, cookies, or headers to the logger.
        }
    }

    private void cancelAll(Operation except, String reason) {
        for (Operation operation : new ArrayList<>(operations.values())) if (operation != except)
            fail(operation, "Native operation was superseded", reason);
    }

    @PluginMethod public void cancel(PluginCall call) {
        entry(call, () -> {
            Operation operation = operations.get(call.getString("id"));
            boolean cancelled = operation != null && !operation.logout && !operation.closed.get();
            if (cancelled) fail(operation, "Native operation cancelled", "CANCELLED");
            JSObject result = new JSObject(); result.put("cancelled", cancelled); call.resolve(result);
        });
    }

    @PluginMethod public void download(PluginCall call) {
        entry(call, () -> {
            String path = NativePolicy.path(call.getString("path"), true);
            String filename = NativePolicy.filename(call.getString("filename"));
            Operation operation = begin(call, false, 45000);
            workers.execute(() -> {
                try {
                    operation.file = temporaryFile();
                    String cookie;
                    synchronized (lock) { check(operation); cookie = activeCookie; }
                    exchange(operation, operation.origin, path, "GET", new HashMap<>(), new byte[0], cookie, operation.file);
                    showSave(operation, filename);
                } catch (Exception error) { fail(operation, "Native download failed", "DOWNLOAD_FAILED"); }
            });
        });
    }

    @PluginMethod public void saveData(PluginCall call) {
        entry(call, () -> {
            String filename = NativePolicy.filename(call.getString("filename"));
            byte[] bytes = decodeBody(call, NativePolicy.MAX_SAVE);
            Operation operation = begin(call, false, 45000);
            workers.execute(() -> {
                try {
                    operation.file = temporaryFile();
                    try (OutputStream stream = new FileOutputStream(operation.file)) {
                        for (int offset = 0; offset < bytes.length; offset += 65536) {
                            check(operation); stream.write(bytes, offset, Math.min(65536, bytes.length - offset));
                        }
                    }
                    check(operation); showSave(operation, filename);
                } catch (Exception error) { fail(operation, "Native export failed", "SAVE_FAILED"); }
            });
        });
    }

    private File temporaryFile() throws Exception {
        File directory = new File(getContext().getNoBackupFilesDir(), "native_exports");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException();
        File file = File.createTempFile("fountain-export-", ".tmp", directory);
        if (!file.setReadable(false, false) || !file.setWritable(false, false)
            || !file.setReadable(true, true) || !file.setWritable(true, true)) {
            file.delete(); throw new IOException();
        }
        return file;
    }

    private void cleanAbandonedExports() {
        File directory = new File(getContext().getNoBackupFilesDir(), "native_exports");
        File[] files = directory.listFiles();
        if (files != null) for (File file : files) if (file.getName().startsWith("fountain-export-")) file.delete();
    }

    private void cleanupFile(Operation operation) {
        if(operation.undeliveredRecoveryExport!=null&&recovery!=null){try{recovery.cancel(operation.undeliveredRecoveryInventory,operation.undeliveredRecoveryExport);}catch(Exception ignored){}operation.undeliveredRecoveryExport=null;operation.undeliveredRecoveryInventory=null;}
        File file = operation.file;
        if (file != null) { file.delete(); operation.file = null; }
        if(operation.recoveryExport!=null&&recovery!=null) { recovery.finished(operation.recoveryExport);operation.recoveryExport=null; }
    }

    private void saveFailure(Operation operation, Exception failure, String fallback) {
        String code = operation.recoveryExport == null ? fallback
            : failure instanceof NativeRecovery.Failure ? ((NativeRecovery.Failure) failure).code : "RECOVERY_STORAGE";
        fail(operation, "Native save could not complete", code);
    }

    private void showSave(Operation operation, String filename) {
        getActivity().runOnUiThread(() -> {
            synchronized (lock) {
                try {
                    check(operation);
                    if(operation.recoveryExport!=null)recovery.checkPrepared(operation.recoveryExport,operation.recoveryAuthority);
                    if (!bundleAllowed() || picker != null) throw new IOException();
                    picker = operation;
                    // Network deadline ends here. The OS picker may stay open;
                    // cancellation/auth/config changes continue to fence it.
                    if (operation.timeout != null) operation.timeout.cancel(false);
                    operation.deadline = Long.MAX_VALUE;
                    if(operation.recoveryExport!=null){long remaining=operation.recoveryExport.deadline-System.currentTimeMillis();if(remaining<=0)throw new NativeRecovery.Failure("RECOVERY_STALE");
                        operation.timeout=deadlines.schedule(()->fail(operation,"Recovery permission check expired","RECOVERY_STALE"),remaining,TimeUnit.MILLISECONDS);}
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("application/octet-stream");
                    intent.putExtra(Intent.EXTRA_TITLE, filename);
                    startActivityForResult(operation.call, intent, "documentChosen");
                } catch (Exception error) {
                    if (picker == operation) picker = null;
                    saveFailure(operation, error, "SAVE_UNAVAILABLE");
                }
            }
        });
    }

    @ActivityCallback private void documentChosen(PluginCall call, ActivityResult result) {
        Operation operation;
        synchronized (lock) { operation = picker; picker = null; }
        if (operation == null) { if (call != null) call.reject("Export interrupted", "SAVE_INTERRUPTED"); return; }
        if (operation.closed.get()) return;
        Uri destination = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || destination == null) {
            synchronized (lock) {
                try { check(operation); JSObject answer = new JSObject(); answer.put("saved", false); answer.put("generation", operation.generation);if(operation.recoveryExport!=null)answer.put("filesSaved",operation.filesSaved);succeed(operation, answer); }
                catch (Exception error) { saveFailure(operation, error, "STALE_SESSION"); }
            }
            return;
        }
        if (!"content".equals(destination.getScheme())) { saveFailure(operation, new IOException(), "SAVE_FAILED"); return; }
        operation.deadline = SystemClock.elapsedRealtime() + 45000;
        operation.timeout = deadlines.schedule(() -> fail(operation, "Native save timed out", "TIMEOUT"), 45, TimeUnit.SECONDS);
        workers.execute(() -> {
            boolean complete = false;
            try {
                check(operation);
                if(operation.recoveryExport!=null)recovery.checkSavedSource(operation.recoveryExport,operation.recoveryAuthority);
                try (InputStream input = new FileInputStream(operation.file);
                     OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new IOException();
                    synchronized (lock) { operation.exportStream = output; check(operation); }
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) { check(operation);if(operation.recoveryExport!=null)recovery.checkPrepared(operation.recoveryExport,operation.recoveryAuthority);output.write(buffer, 0, count); }
                    output.flush(); check(operation);
                    if(operation.recoveryExport!=null)recovery.checkSavedSource(operation.recoveryExport,operation.recoveryAuthority);
                }
                complete = true;
                getActivity().runOnUiThread(() -> {
                    synchronized (lock) {
                        try {
                            check(operation); if (!bundleAllowed()) throw new IOException();
                            if(operation.recoveryExport!=null){recovery.checkPrepared(operation.recoveryExport,operation.recoveryAuthority);operation.filesSaved++;operation.recoveryFileIndex++;
                                if(operation.recoveryFileIndex<operation.recoveryExport.files.size()){operation.file=operation.recoveryExport.files.get(operation.recoveryFileIndex);showSave(operation,"fountain-recovery-"+(operation.recoveryFileIndex+1)+".json");return;}}
                            JSObject answer = new JSObject(); answer.put("saved", true); answer.put("generation", operation.generation);if(operation.recoveryExport!=null)answer.put("filesSaved",operation.filesSaved);succeed(operation, answer);
                        } catch (Exception error) { removePartialDestination(destination); saveFailure(operation, error, "STALE_SESSION"); }
                    }
                });
            } catch (Exception error) { saveFailure(operation, error, "SAVE_FAILED"); }
            finally { operation.exportStream = null; if (!complete) removePartialDestination(destination); }
        });
    }

    private void removePartialDestination(Uri destination) {
        try { getContext().getContentResolver().delete(destination, null, null); }
        catch (Exception ignored) { /* The OS provider may refuse deletion; never report success. */ }
    }

    @Override public Boolean shouldOverrideLoad(Uri url) {
        try {
            URI local = new URI(getBridge().getLocalUrl());
            return !Objects.equals(url.getScheme(), local.getScheme()) || !Objects.equals(url.getEncodedAuthority(), local.getRawAuthority());
        } catch (Exception error) { return true; }
    }

    @Override protected void handleOnDestroy() {
        synchronized (lock) { invalidateRecovery(); destroyed = true; authGeneration++; cancelAll(null, "APP_CLOSED"); }
        NativeCookieBoundary.unregister(boundaryInvalidated);
        workers.shutdownNow();
        // Already-running revocation is allowed to finish; its encrypted slot
        // survives process death and is retried before the next session call.
        sessions.execute(() -> { if(recovery!=null)recovery.invalidate();if (outbox != null) { outbox.close(); outbox = null; } deadlines.shutdown(); });
        sessions.shutdown();
    }
}
