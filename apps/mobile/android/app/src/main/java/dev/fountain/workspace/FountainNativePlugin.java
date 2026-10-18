package dev.fountain.workspace;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.BridgeWebViewClient;
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
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
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
    private final NativePolicy.PublicWebTrust publicWeb = new NativePolicy.PublicWebTrust();
    private final NativeSessionBinding sessionBinding = new NativeSessionBinding();
    private long generation, authGeneration, ownerBoundaryEpoch;
    private final Runnable boundaryInvalidated = () -> {
        synchronized (lock) { sessionBinding.clear(); invalidateRecovery(); authGeneration++; cancelAll(null, "STALE_SESSION"); this.organizationEpoch++; cancelOrganizations(null, "STALE_SESSION"); this.accountEpoch++; cancelAccounts(null,"STALE_SESSION"); try {closeAccountWorkspaces();} catch(Exception unavailable){accountBroken=true;} }
    };
    private CookieVault vault;
    private CookieVault organizationVault;
    private final ExecutorService organizationWorkers = Executors.newSingleThreadExecutor();
    private final Map<String, OrganizationOperation> organizationOperations = new HashMap<>();
    private String organizationOrigin, organizationActive, organizationRevoke, organizationActiveBinding, organizationRevokeBinding;
    private long organizationGeneration, organizationEpoch;
    private boolean organizationBroken;
    private static final class OrganizationOperation {
        final String id, origin;
        final long generation, boundaryEpoch;
        final PluginCall call;
        final boolean login, logout;
        final AtomicBoolean closed = new AtomicBoolean();
        long epoch, deadline, workspaceEpoch;
        boolean crossWorkspace, accountWorkspace;
        volatile HttpsURLConnection connection;
        ScheduledFuture<?> timeout;
        OrganizationOperation(String id, String origin, long generation, long epoch, PluginCall call, boolean login, boolean logout) {
            this.id = id; this.origin = origin; this.generation = generation; this.epoch = epoch;
            this.call = call; this.login = login; this.logout = logout; this.boundaryEpoch = NativeCookieBoundary.epoch();
        }
    }
    private CookieVault accountVault;
    private final ExecutorService accountWorkers = Executors.newSingleThreadExecutor();
    private final Map<String, AccountOperation> accountOperations = new HashMap<>();
    private String accountOrigin, accountActive, accountRevoke, accountActiveBinding, accountRevokeBinding;
    private long accountGeneration, accountEpoch, workspaceEpoch;
    private boolean accountBroken, accountWorkspaceMode;
    private JSONObject workspaceScope, lastWorkspaceSnapshot;
    private JSONObject sealedWorkspaceScopes = new JSONObject(); private long accountExpiresAt, workspaceObservationSequence;
    private final Map<String,Long> workspaceObservationOrder=new HashMap<>();
    private static final class AccountOperation {
        final String id, origin;
        final long generation, boundaryEpoch;
        final PluginCall call;
        final boolean login, logout;
        final AtomicBoolean closed = new AtomicBoolean();
        long epoch, deadline, workspaceEpoch;
        boolean crossWorkspace;
        String targetWorkspace, expectedChild, targetParent; long observationOrder;
        volatile HttpsURLConnection connection;
        ScheduledFuture<?> timeout;
        AccountOperation(String id, String origin, long generation, long epoch, PluginCall call, boolean login, boolean logout) {
            this.id = id; this.origin = origin; this.generation = generation; this.epoch = epoch;
            this.call = call; this.login = login; this.logout = logout; this.boundaryEpoch = NativeCookieBoundary.epoch();
        }
    }
    private static final boolean OUTBOX_ENABLED = true;
    private boolean outboxEnabled() {
        return OUTBOX_ENABLED || (getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            && "1".equals(System.getProperty("dev.fountain.outbox.qa"));
    }
    private NativeOutbox outbox;
    private NativeRecovery recovery;
    private volatile boolean recoveryMode;
    private long recoveryEpoch;
    private final String outboxOwner = java.util.UUID.randomUUID().toString();
    private long outboxAdmissionSequence;
    private String origin, activeCookie, revokeCookie, revokeOrigin;
    private boolean broken, destroyed;
    private Operation picker;

    private static final class Operation {
        final String id, origin;
        final long generation, boundaryEpoch;
        final PluginCall call;
        final boolean logout;
        final boolean publicSession;
        final AtomicBoolean closed = new AtomicBoolean();
        volatile long authGeneration;
        volatile HttpsURLConnection connection;
        volatile File file;
        volatile String backupCookie, backupScope;
        volatile long backupUntil;
        volatile OutputStream exportStream;
        volatile ScheduledFuture<?> timeout;
        volatile long deadline;
        volatile long responseProofEpoch = -1, responseProofBoundary = -1, responseProofDeadline = Long.MAX_VALUE;
        volatile NativeOutbox responseProofStore, admittedOutboxStore, sessionDeliveryStore;
        volatile String admittedOutboxLease, sessionDeliveryLease;
        NativeReconcile.Tag reconciliationTag;
        NativeSyncReceipts.Admission syncAdmission;
        volatile NativeRecovery.Prepared recoveryExport;
        String undeliveredRecoveryInventory, undeliveredRecoveryExport;
        long workspaceEpoch = -1, observationOrder; String workspacePrefix, observationWorkspace; boolean sessionObservationAdmitted;
        volatile NativeRecovery.Authority recoveryAuthority;
        int recoveryFileIndex, filesSaved;
        Operation(String id, String origin, long generation, long authGeneration, PluginCall call, boolean logout, boolean publicSession) {
            this.id = id; this.origin = origin; this.generation = generation;
            this.authGeneration = authGeneration; this.call = call; this.logout = logout; this.publicSession = publicSession;
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
        loadOrganization();
        loadAccount();
        NativeCookieBoundary.register(boundaryInvalidated);
        // Capacitor's plugin URL hook omits isForMainFrame. Keep it closed to
        // external loads and authorize OS opening only at this request boundary.
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (localUrl(request.getUrl())) return super.shouldOverrideUrlLoading(view, request);
                synchronized (lock) {
                    boolean live = request.isForMainFrame() && "GET".equals(request.getMethod()) && !request.isRedirect()
                        && view == getBridge().getWebView() && bundleAllowed() && !destroyed && !broken && !recoveryMode
                        && NativeCookieBoundary.permits(ownerBoundaryEpoch);
                    // Async UI actions can lose hasGesture; the native-owned
                    // session metadata and bundled main frame remain required.
                    if (publicWeb.allows(request.getUrl().toString(), origin, generation, authGeneration, ownerBoundaryEpoch, live)) {
                        try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); }
                        catch (Exception unavailable) { /* Keep the WebView closed even without a browser. */ }
                    }
                }
                return true;
            }
        });
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
        sessionBinding.clear(); publicWeb.clear();
        if (outboxEnabled() && !recoveryMode) try { NativeOutbox storage=durableOutbox();storage.revoke();if(explicitNativeActor!=null)storage.eraseActor(explicitNativeActor); }
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

    private void retryRevocationAfterStorageFailure() { retryRevocationAfterStorageFailure(null); }
    private void retryRevocationAfterStorageFailure(NativeSessionBinding.Admission actualLoginRollback) {
        // A fresh private POST response can bind its own failed-login cleanup;
        // it cannot lower an older durable public context to a bodyless retry.
        sessions.execute(() -> { try { revokePending(actualLoginRollback,false); } catch (Exception ignored) {} });
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
        JSONArray retained=new JSONArray(); boolean truncated=false;
        try {
            if(accountActive!=null&&accountRevoke==null&&!accountBroken&&accountVault!=null&&!accountVault.invalidated(origin)&&accountExpiresAt>System.currentTimeMillis()) {
                Iterator<String> names=sealedWorkspaceScopes.keys();int examined=0;
                while(names.hasNext()&&examined++<128) { JSONObject scope=sealedWorkspaceScopes.getJSONObject(names.next());
                    if(!accountActiveBinding.equals(scope.optString("accountBinding"))||scope.optLong("expiresAt",0)<=System.currentTimeMillis()||!durableOutbox().retainedScopeAllowed(scope,accountActive))continue;
                    if(retained.length()==100){truncated=true;break;}JSONObject visible=new JSONObject(scope.toString());visible.remove("session");retained.put(visible);
                }
                if(names.hasNext())truncated=true;
            }
        } catch(Exception unavailable) { retained=new JSONArray(); }
        result.put("retainedWorkspaceScopes",retained);result.put("retainedWorkspaceScopesTruncated",truncated);
        result.put("workspaceEpoch",workspaceEpoch); result.put("workspaceVersion", 1); result.put("workspace", lastWorkspaceSnapshot == null ? JSONObject.NULL : lastWorkspaceSnapshot);
        result.put("outboxVersion", 1); result.put("outboxEnabled", outboxEnabled());
        result.put("recoveryVersion", 1); result.put("recoveryEnabled", true);
        return result;
    }

    private void loadOrganization() {
        try {
            organizationVault = new CookieVault(getContext(), "fountain_organization_native_v1", "dev.fountain.organization.native.v1");
            JSONObject saved = organizationVault.read();
            organizationOrigin = nullable(saved, "origin");
            if (organizationOrigin != null) organizationOrigin = NativePolicy.origin(organizationOrigin);
            organizationGeneration = saved.optLong("generation", 0);
            NativePolicy.require(organizationGeneration >= 0 && organizationGeneration < 9_007_199_254_740_991L);
            organizationActive = nullable(saved, "active"); organizationRevoke = nullable(saved, "revoke");
            organizationActiveBinding = nullable(saved, "active_binding"); organizationRevokeBinding = nullable(saved, "revoke_binding");
            NativePolicy.require((organizationActive == null) == (organizationActiveBinding == null)
                && (organizationRevoke == null) == (organizationRevokeBinding == null)
                && (organizationActive == null || organizationRevoke == null)
                && (organizationActive == null && organizationRevoke == null || organizationOrigin != null));
            if (organizationActive != null) { NativeOrganizationPolicy.token(organizationActive); NativeOrganizationPolicy.binding(organizationActiveBinding); }
            if (organizationRevoke != null) { NativeOrganizationPolicy.token(organizationRevoke); NativeOrganizationPolicy.binding(organizationRevokeBinding); }
            // An unreadable workspace config is not evidence that its origin was replaced.
            if (broken && origin == null) return;
            if (!Objects.equals(origin, organizationOrigin) || generation != organizationGeneration) organizationConfigurationChanged();
            else if (organizationActive != null && organizationVault.invalidated(organizationOrigin)) {
                organizationRevoke = organizationActive; organizationRevokeBinding = organizationActiveBinding;
                organizationActive = null; organizationActiveBinding = null;
                persistOrganization();
            }
        } catch (Exception unavailable) { organizationBroken = true; }
    }

    private NativePolicy.SessionStorage organizationStorage() {
        return new NativePolicy.SessionStorage() {
            public boolean markInvalidated(String server) { return organizationVault.markInvalidated(server); }
            public boolean saveRevokeOnly(String server, String token) { return false; }
            public boolean eraseEncryptedState() { return organizationVault.eraseEncryptedState(); }
            public boolean destroyEncryptionKey() { return organizationVault.destroyEncryptionKey(); }
        };
    }
    private void persistOrganization() throws Exception {
        NativePolicy.require(!destroyed && NativeCookieBoundary.permits(ownerBoundaryEpoch));
        NativePolicy.SessionInvalidation before = NativePolicy.fenceSession(organizationOrigin, organizationRevoke, organizationStorage());
        if (!before.journaled) { organizationBroken = true; throw new NativePolicy.SessionStorageFailure(before.durable); }
        try {
            JSONObject saved = record(organizationOrigin, organizationGeneration, organizationActive, organizationRevoke,
                organizationRevoke == null ? null : organizationOrigin);
            saved.put("active_binding", organizationActiveBinding == null ? JSONObject.NULL : organizationActiveBinding);
            saved.put("revoke_binding", organizationRevokeBinding == null ? JSONObject.NULL : organizationRevokeBinding);
            organizationVault.write(saved);
            organizationVault.clearInvalidated(organizationOrigin);
        } catch (Exception unavailable) {
            NativePolicy.SessionInvalidation after = NativePolicy.fenceSession(organizationOrigin, organizationRevoke, organizationStorage());
            organizationBroken = true; throw new NativePolicy.SessionStorageFailure(after.durable);
        }
    }
    private void quarantineOrganization() throws Exception {
        if (organizationActive != null) {
            organizationRevoke = organizationActive; organizationRevokeBinding = organizationActiveBinding;
            organizationActive = null; organizationActiveBinding = null;
        }
        persistOrganization();
    }
    private void organizationConfigurationChanged() {
        organizationEpoch++; cancelOrganizations(null, "CONFIGURATION_CHANGED");
        // Config changes drop previous-origin credentials, never send them to the replacement host.
        organizationOrigin = origin; organizationGeneration = generation;
        organizationActive = null; organizationActiveBinding = null; organizationRevoke = null; organizationRevokeBinding = null;
        if (organizationVault != null) try { persistOrganization(); } catch (Exception unavailable) { organizationBroken = true; }
    }
    private void organizationEntry(PluginCall call, Runnable action) {
        getActivity().runOnUiThread(() -> { synchronized (lock) {
            if (!bundleAllowed()) { call.reject("Bundled main frame required", "FORBIDDEN_FRAME"); return; }
            if (destroyed || organizationBroken || !NativeCookieBoundary.permits(ownerBoundaryEpoch)) {
                call.reject("Secure organization transport unavailable", "UNAVAILABLE"); return;
            }
            try { action.run(); } catch (Exception invalid) { call.reject("Invalid organization transport input", "NATIVE_INPUT"); }
        } });
    }

    @PluginMethod public void organizationRequest(PluginCall call) {
        organizationEntry(call, () -> {
            try {
                JSONObject wire = call.getData();
                NativePolicy.require(wire.length() == 7);
                for (String key : Arrays.asList("id", "generation", "path", "method", "headers", "bodyBase64", "timeoutMs")) NativePolicy.require(wire.has(key));
                NativePolicy.require(wire.opt("id") instanceof String && wire.opt("path") instanceof String
                    && wire.opt("method") instanceof String && wire.opt("headers") instanceof JSONObject && wire.opt("bodyBase64") instanceof String);
                String method = call.getString("method"), path = NativeOrganizationPolicy.path(call.getString("path"), method);
                String id = call.getString("id");
                NativePolicy.require(id.matches("[A-Za-z0-9_.:-]{1,160}") && !organizationOperations.containsKey(id)
                    && organizationOperations.size() < 32 && origin != null && Objects.equals(origin, organizationOrigin)
                    && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation && generation == organizationGeneration);
                byte[] body = decodeBody(call, NativeOrganizationPolicy.MAX_REQUEST);
                Map<String, String> headers = requestHeaders(call);
                Iterator<String> headerNames = ((JSONObject)wire.opt("headers")).keys();
                while (headerNames.hasNext()) NativePolicy.require(((JSONObject)wire.opt("headers")).opt(headerNames.next()) instanceof String);
                NativePolicy.require(body.length == 0 && method.equals("GET") || body.length > 0 && !method.equals("GET")
                    && "application/json".equals(headers.get("content-type")));
                JSONObject json = body.length == 0 ? null : new JSONObject(OutboxPolicy.utf8(body));
                int timeout = (int) integer(call, "timeoutMs", 1, 45000);
                boolean session = NativeOrganizationPolicy.session(path), login = session && method.equals("POST"), logout = session && method.equals("DELETE");
                if (logout) {
                    NativePolicy.require(json != null && json.length() == 1 && json.has("session_binding"));
                    Object supplied = json.opt("session_binding");
                    String expected = organizationActive != null ? organizationActiveBinding : organizationRevokeBinding;
                    NativePolicy.require(expected == null ? supplied == JSONObject.NULL : expected.equals(supplied));
                }
                if (login || logout) {
                    organizationEpoch++; cancelOrganizations(null, "SESSION_CHANGED");
                    quarantineOrganization(); // The old organization session is durably unusable before I/O.
                }
                OrganizationOperation operation = new OrganizationOperation(id, origin, generation, organizationEpoch, call, login, logout);
                operation.deadline = SystemClock.elapsedRealtime() + timeout;
                operation.crossWorkspace = NativeOrganizationPolicy.workspace(path, method);
                operation.workspaceEpoch = authGeneration;
                if(operation.crossWorkspace) {
                    String selectedWorkspace=null, selectedBinding=null;
                    if(method.equals("GET")) {
                        Map<String,String> query=NativeOrganizationPolicy.query(path);
                        selectedWorkspace=query.get("workspace_id"); selectedBinding=query.get("workspace_binding");
                    } else if(json!=null && json.has("workspace_id")) {
                        NativePolicy.require(json.opt("workspace_id") instanceof String&&json.opt("workspace_binding") instanceof String);
                        selectedWorkspace=json.getString("workspace_id");selectedBinding=json.getString("workspace_binding");
                    }
                    NativePolicy.require((selectedWorkspace==null)==(selectedBinding==null));
                    if(selectedWorkspace!=null) {
                        NativePolicy.require(workspaceScope!=null&&!workspaceBlocked()&&selectedWorkspace.equals(workspaceScope.getString("workspaceId"))&&selectedBinding.equals(workspaceScope.getString("binding")));
                        operation.accountWorkspace=true;
                    }
                }
                organizationOperations.put(id, operation);
                operation.timeout = deadlines.schedule(() -> failOrganization(operation, "Organization request timed out", "TIMEOUT"), timeout, TimeUnit.MILLISECONDS);
                organizationWorkers.execute(() -> {
                    try {
                        // One queue owns the realm, including retry-only revocation. It does not use workspace admission.
                        if (session) revokeOrganizationPending(operation);
                        String cookie, workspaceCookie;
                        synchronized (lock) {
                            checkOrganization(operation); cookie = organizationActive;
                            workspaceCookie = operation.accountWorkspace ? accountActive : operation.crossWorkspace && !broken && revokeCookie == null && !vault.invalidated(origin) ? activeCookie : null;
                        }
                        Response response;
                        if (logout) {
                            // The retry used exactly the quarantined cookie/binding; a subsequent anonymous DELETE is harmless.
                            response = exchangeOrganization(operation, path, method, headers, body, null, null);
                        } else response = exchangeOrganization(operation, path, method, headers, body, cookie, workspaceCookie);
                        synchronized (lock) {
                            checkOrganization(operation);
                            applyOrganizationResponse(operation, response, session, cookie);
                        }
                        deliverOrganization(operation, response);
                    } catch (Exception failure) {
                        failOrganization(operation, "Organization request failed or was superseded", "ORGANIZATION_REQUEST_FAILED");
                    }
                });
            } catch (Exception invalid) { call.reject("Invalid organization input or secure storage unavailable", "NATIVE_INPUT"); }
        });
    }
    @PluginMethod public void organizationCancel(PluginCall call) {
        organizationEntry(call, () -> {
            NativePolicy.require(call.getData().length() == 2 && call.getData().opt("id") instanceof String
                && call.getData().has("generation") && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation);
            OrganizationOperation operation = organizationOperations.get(call.getString("id"));
            boolean cancelled = operation != null && operation.generation == generation && !operation.closed.get();
            if (cancelled) failOrganization(operation, "Organization operation cancelled", "CANCELLED");
            JSObject result = new JSObject(); result.put("cancelled", cancelled); call.resolve(result);
        });
    }
    private void revokeOrganizationPending(OrganizationOperation operation) throws Exception {
        String token, binding;
        synchronized (lock) { checkOrganization(operation); token = organizationRevoke; binding = organizationRevokeBinding; }
        if (token == null) return;
        JSONObject body = new JSONObject(); body.put("session_binding", NativeOrganizationPolicy.binding(binding));
        Map<String, String> headers = new HashMap<>(); headers.put("content-type", "application/json");
        Response response = exchangeOrganization(operation, "/api/organization/session", "DELETE", headers,
            body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8), token, null);
        synchronized (lock) {
            checkOrganization(operation);
            NativePolicy.require(response.status == 200 && (response.cookie == null || "".equals(response.cookie)) && Objects.equals(token, organizationRevoke)
                && Objects.equals(binding, organizationRevokeBinding));
            JSONObject result = new JSONObject(OutboxPolicy.utf8(response.body));
            NativePolicy.require(Boolean.FALSE.equals(result.opt("authenticated")) && "organization".equals(result.opt("mode")));
            organizationRevoke = null; organizationRevokeBinding = null; persistOrganization();
        }
    }
    private void applyOrganizationResponse(OrganizationOperation operation, Response response, boolean session, String sentCookie) throws Exception {
        if (operation.login && response.status == 200) {
            NativePolicy.require(response.cookie != null && !response.cookie.isEmpty());
            JSONObject result = new JSONObject(OutboxPolicy.utf8(response.body));
            String binding = NativeOrganizationPolicy.binding(result.getString("cache_binding"));
            NativePolicy.require(Boolean.TRUE.equals(result.opt("authenticated")) && "organization".equals(result.opt("mode")));
            // Retain a retry-only record before attempting activation; uncertain writes never resurrect it.
            organizationRevoke = response.cookie; organizationRevokeBinding = binding; persistOrganization();
            organizationActive = response.cookie; organizationActiveBinding = binding;
            organizationRevoke = null; organizationRevokeBinding = null; persistOrganization();
        } else if (response.status == 401 || "".equals(response.cookie)) {
            if (sentCookie != null && Objects.equals(sentCookie, organizationActive)) {
                organizationEpoch++; operation.epoch = organizationEpoch; cancelOrganizations(operation, "SESSION_CHANGED");
                quarantineOrganization();
            }
        } else if (response.cookie != null) {
            NativePolicy.require(session && !operation.logout && Objects.equals(sentCookie, organizationActive)
                && response.cookie.equals(organizationActive));
        }
        if (session && !operation.login && !operation.logout && response.status == 200) {
            JSONObject result = new JSONObject(OutboxPolicy.utf8(response.body));
            NativePolicy.require("organization".equals(result.opt("mode")));
            if (Boolean.TRUE.equals(result.opt("authenticated"))) NativePolicy.require(sentCookie != null
                && Objects.equals(sentCookie, organizationActive) && organizationActiveBinding.equals(result.opt("cache_binding")));
            else {
                NativePolicy.require(Boolean.FALSE.equals(result.opt("authenticated")));
                if (sentCookie != null && Objects.equals(sentCookie, organizationActive)) {
                    organizationEpoch++; operation.epoch = organizationEpoch; cancelOrganizations(operation, "SESSION_CHANGED");
                    quarantineOrganization();
                }
            }
        }
    }
    private Response exchangeOrganization(OrganizationOperation operation, String path, String method, Map<String, String> headers,
                                         byte[] body, String cookie, String workspaceCookie) throws Exception {
        checkOrganization(operation);
        HttpsURLConnection connection = open(operation.origin, path, method, headers, body, null,
            (int)Math.max(1, operation.deadline - SystemClock.elapsedRealtime()), operation.boundaryEpoch);
        if (cookie != null || workspaceCookie != null) connection.setRequestProperty("Cookie",
            (cookie == null ? "" : NativeOrganizationPolicy.COOKIE + "=" + cookie)
                + (workspaceCookie == null ? "" : (cookie == null ? "" : "; ") + (operation.accountWorkspace ? "fountain_account_session=" : "fountain_session=") + workspaceCookie));
        try {
            synchronized (lock) { operation.connection = connection; checkOrganization(operation); }
            if (connection.getDoOutput()) try (OutputStream output = connection.getOutputStream()) { checkOrganization(operation); output.write(body); }
            checkOrganization(operation);
            Response response = new Response(); response.status = connection.getResponseCode();
            NativePolicy.require(response.status >= 200 && response.status <= 599 && (response.status < 300 || response.status >= 400));
            response.headers = safeHeaders(connection.getHeaderFields());
            response.cookie = NativeOrganizationPolicy.cookie(connection.getHeaderFields(), operation.origin);
            long expected = connection.getContentLengthLong();
            NativePolicy.require(expected <= NativeOrganizationPolicy.MAX_RESPONSE);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = response.status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                if (input != null) { byte[] buffer = new byte[16384]; int length;
                    while ((length = input.read(buffer)) != -1) { checkOrganization(operation);
                        NativePolicy.require(output.size() + length <= NativeOrganizationPolicy.MAX_RESPONSE); output.write(buffer, 0, length); }
                }
            }
            checkOrganization(operation); response.body = output.toByteArray();
            NativePolicy.require(expected < 0 || response.body.length == expected);
            return response;
        } finally { connection.disconnect(); operation.connection = null; }
    }
    private void checkOrganization(OrganizationOperation operation) throws IOException {
        synchronized (lock) {
            if (operation.closed.get() || destroyed || organizationBroken || operation.epoch != organizationEpoch
                || operation.generation != generation || operation.generation != organizationGeneration || !Objects.equals(origin, operation.origin)
                || !Objects.equals(organizationOrigin, operation.origin) || !NativeCookieBoundary.permits(operation.boundaryEpoch)
                || SystemClock.elapsedRealtime() > operation.deadline || operation.crossWorkspace && operation.workspaceEpoch != authGeneration) throw new IOException();
        }
    }
    private void deliverOrganization(OrganizationOperation operation, Response response) {
        getActivity().runOnUiThread(() -> { synchronized (lock) {
            try {
                checkOrganization(operation);
                JSObject result = new JSObject(); result.put("generation", operation.generation); result.put("status", response.status);
                result.put("headers", response.headers); result.put("bodyBase64", Base64.encodeToString(response.body, Base64.NO_WRAP));
                boolean delivered = resolveCurrent(operation.call, result, () -> {
                    try { checkOrganization(operation); return bundleAllowed(); } catch (Exception stale) { return false; }
                });
                if (!delivered) throw new IOException();
                operation.closed.set(true); organizationOperations.remove(operation.id);
                if (operation.timeout != null) operation.timeout.cancel(false);
            } catch (Exception stale) { failOrganization(operation, "Organization response scope changed", "STALE_SESSION"); }
        } });
    }
    private void failOrganization(OrganizationOperation operation, String message, String code) {
        synchronized (lock) {
            if (!operation.closed.compareAndSet(false, true)) return;
            organizationOperations.remove(operation.id);
            if (operation.timeout != null) operation.timeout.cancel(false);
            if (operation.connection != null) operation.connection.disconnect();
            operation.call.setKeepAlive(false); operation.call.reject(message, code);
        }
    }
    private void cancelOrganizations(OrganizationOperation except, String reason) {
        for (OrganizationOperation operation : new ArrayList<>(organizationOperations.values()))
            if (operation != except) failOrganization(operation, "Organization operation was superseded", reason);
    }

    private void loadAccount() {
        try {
            accountVault = new CookieVault(getContext(), "fountain_account_native_v1", "dev.fountain.account.native.v1", 524288);
            JSONObject saved = accountVault.read();
            accountOrigin = nullable(saved, "origin");
            if (accountOrigin != null) accountOrigin = NativePolicy.origin(accountOrigin);
            accountGeneration = saved.optLong("generation", 0);
            NativePolicy.require(accountGeneration >= 0 && accountGeneration < 9_007_199_254_740_991L);
            JSONObject retained=saved.optJSONObject("workspace_scopes"); if(retained!=null)sealedWorkspaceScopes=retained;
            accountExpiresAt=saved.optLong("expires_at",0);
            lastWorkspaceSnapshot = saved.optJSONObject("workspace"); // A UI hint only; workspaceScope stays null until native HTTPS activation.
            accountActive = nullable(saved, "active"); accountRevoke = nullable(saved, "revoke");
            accountActiveBinding = nullable(saved, "active_binding"); accountRevokeBinding = nullable(saved, "revoke_binding");
            NativePolicy.require((accountActive == null) == (accountActiveBinding == null)
                && (accountRevoke == null) == (accountRevokeBinding == null)
                && (accountActive == null || accountRevoke == null)
                && (accountActive == null && accountRevoke == null || accountOrigin != null));
            if (accountActive != null) { NativeAccountPolicy.token(accountActive); NativeAccountPolicy.binding(accountActiveBinding); }
            if (accountRevoke != null) { NativeAccountPolicy.token(accountRevoke); NativeAccountPolicy.binding(accountRevokeBinding); }
            // An unreadable workspace config is not evidence that its origin was replaced.
            if (broken && origin == null) return;
            if (!Objects.equals(origin, accountOrigin) || generation != accountGeneration) accountConfigurationChanged();
            else if (accountActive != null && accountVault.invalidated(accountOrigin)) {
                accountRevoke = accountActive; accountRevokeBinding = accountActiveBinding;
                accountActive = null; accountActiveBinding = null;
                persistAccount();
            }
        } catch (Exception unavailable) { accountBroken = true; }
    }

    private NativePolicy.SessionStorage accountStorage() {
        return new NativePolicy.SessionStorage() {
            public boolean markInvalidated(String server) { return accountVault.markInvalidated(server); }
            public boolean saveRevokeOnly(String server, String token) { return false; }
            public boolean eraseEncryptedState() { return accountVault.eraseEncryptedState(); }
            public boolean destroyEncryptionKey() { return accountVault.destroyEncryptionKey(); }
        };
    }
    private void persistAccount() throws Exception {
        NativePolicy.require(!destroyed && NativeCookieBoundary.permits(ownerBoundaryEpoch));
        NativePolicy.SessionInvalidation before = NativePolicy.fenceSession(accountOrigin, accountRevoke, accountStorage());
        if (!before.journaled) { accountBroken = true; throw new NativePolicy.SessionStorageFailure(before.durable); }
        try {
            JSONObject saved = record(accountOrigin, accountGeneration, accountActive, accountRevoke,
                accountRevoke == null ? null : accountOrigin);
            saved.put("active_binding", accountActiveBinding == null ? JSONObject.NULL : accountActiveBinding);
            saved.put("revoke_binding", accountRevokeBinding == null ? JSONObject.NULL : accountRevokeBinding);
            saved.put("expires_at",accountExpiresAt); saved.put("workspace_scopes",sealedWorkspaceScopes);
            saved.put("workspace", lastWorkspaceSnapshot == null ? JSONObject.NULL : lastWorkspaceSnapshot);
            accountVault.write(saved);
            accountVault.clearInvalidated(accountOrigin);
        } catch (Exception unavailable) {
            NativePolicy.SessionInvalidation after = NativePolicy.fenceSession(accountOrigin, accountRevoke, accountStorage());
            accountBroken = true; throw new NativePolicy.SessionStorageFailure(after.durable);
        }
    }
    private void quarantineAccount() throws Exception {
        if (accountActive != null) {
            accountRevoke = accountActive; accountRevokeBinding = accountActiveBinding;
            accountActive = null; accountActiveBinding = null; accountExpiresAt=0;
        }
        persistAccount();
    }
    private void accountConfigurationChanged() {
        accountEpoch++; cancelAccounts(null, "CONFIGURATION_CHANGED");
        // Config changes drop previous-origin credentials, never send them to the replacement host.
        accountOrigin = origin; accountGeneration = generation; lastWorkspaceSnapshot = null; accountWorkspaceMode=false; sealedWorkspaceScopes=new JSONObject(); accountExpiresAt=0;
        accountActive = null; accountActiveBinding = null; accountRevoke = null; accountRevokeBinding = null;
        if (accountVault != null) try { persistAccount(); } catch (Exception unavailable) { accountBroken = true; }
    }
    private void accountEntry(PluginCall call, Runnable action) {
        getActivity().runOnUiThread(() -> { synchronized (lock) {
            if (!bundleAllowed()) { call.reject("Bundled main frame required", "FORBIDDEN_FRAME"); return; }
            if (destroyed || accountBroken || !NativeCookieBoundary.permits(ownerBoundaryEpoch)) {
                call.reject("Secure account transport unavailable", "UNAVAILABLE"); return;
            }
            try { action.run(); } catch (Exception invalid) { call.reject("Invalid account transport input", "NATIVE_INPUT"); }
        } });
    }

    @PluginMethod public void accountRequest(PluginCall call) {
        accountEntry(call, () -> {
            try {
                JSONObject wire = call.getData();
                NativePolicy.require(wire.length() == 7);
                for (String key : Arrays.asList("id", "generation", "path", "method", "headers", "bodyBase64", "timeoutMs")) NativePolicy.require(wire.has(key));
                NativePolicy.require(wire.opt("id") instanceof String && wire.opt("path") instanceof String
                    && wire.opt("method") instanceof String && wire.opt("headers") instanceof JSONObject && wire.opt("bodyBase64") instanceof String);
                String method = call.getString("method"), path = NativeAccountPolicy.path(call.getString("path"), method);
                String id = call.getString("id");
                NativePolicy.require(id.matches("[A-Za-z0-9_.:-]{1,160}") && !accountOperations.containsKey(id)
                    && accountOperations.size() < 32 && origin != null && Objects.equals(origin, accountOrigin)
                    && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation && generation == accountGeneration);
                byte[] body = decodeBody(call, NativeAccountPolicy.MAX_REQUEST);
                Map<String, String> headers = requestHeaders(call);
                Iterator<String> headerNames = ((JSONObject)wire.opt("headers")).keys();
                while (headerNames.hasNext()) NativePolicy.require(((JSONObject)wire.opt("headers")).opt(headerNames.next()) instanceof String);
                NativePolicy.require(body.length == 0 && method.equals("GET") || body.length > 0 && !method.equals("GET")
                    && "application/json".equals(headers.get("content-type")));
                JSONObject json = body.length == 0 ? null : new JSONObject(OutboxPolicy.utf8(body));
                int timeout = (int) integer(call, "timeoutMs", 1, 45000);
                boolean session = NativeAccountPolicy.session(path), login = session && method.equals("POST"), logout = session && method.equals("DELETE");
                if (logout) {
                    NativePolicy.require(json != null && json.length() == 1 && json.has("session_binding"));
                    Object supplied = json.opt("session_binding");
                    String expected = accountActive != null ? accountActiveBinding : accountRevokeBinding;
                    NativePolicy.require(expected == null ? supplied == JSONObject.NULL : expected.equals(supplied));
                }
                if (login || logout) {
                    accountEpoch++; cancelAccounts(null, "SESSION_CHANGED");
                    closeAccountWorkspaces();
                    quarantineAccount(); // The old account session is durably unusable before I/O.
                }
                AccountOperation operation = new AccountOperation(id, origin, generation, accountEpoch, call, login, logout);
                operation.deadline = SystemClock.elapsedRealtime() + timeout;
                operation.crossWorkspace = false;
                operation.workspaceEpoch = authGeneration;
                if(method.equals("POST")&&path.matches("/api/account/workspaces/[A-Za-z0-9_-]{1,160}/open")&&json!=null
                    &&json.opt("session_binding") instanceof String&&Objects.equals(accountActiveBinding,json.getString("session_binding"))) {
                    operation.targetWorkspace=path.split("/")[4];operation.targetParent=json.getString("session_binding");operation.observationOrder=nextWorkspaceObservation();
                    if(json.opt("expected_binding") instanceof String&&json.getString("expected_binding").matches("[a-f0-9]{32}"))operation.expectedChild=json.getString("expected_binding");
                }
                accountOperations.put(id, operation);
                operation.timeout = deadlines.schedule(() -> failAccount(operation, "Account request timed out", "TIMEOUT"), timeout, TimeUnit.MILLISECONDS);
                accountWorkers.execute(() -> {
                    try {
                        // One queue owns the realm, including retry-only revocation. It does not use workspace admission.
                        if (session) revokeAccountPending(operation);
                        String cookie, workspaceCookie;
                        synchronized (lock) {
                            checkAccount(operation); cookie = accountActive;
                            workspaceCookie = null;
                        }
                        Response response;
                        if (logout) {
                            // The retry used exactly the quarantined cookie/binding; a subsequent anonymous DELETE is harmless.
                            response = exchangeAccount(operation, path, method, headers, body, null, null);
                        } else response = exchangeAccount(operation, path, method, headers, body, cookie, workspaceCookie);
                        synchronized (lock) {
                            checkAccount(operation);
                            applyAccountResponse(operation, response, session, cookie);
                        }
                        deliverAccount(operation, response);
                    } catch (Exception failure) {
                        failAccount(operation, "Account request failed or was superseded", "ORGANIZATION_REQUEST_FAILED");
                    }
                });
            } catch (Exception invalid) { call.reject("Invalid account input or secure storage unavailable", "NATIVE_INPUT"); }
        });
    }
    @PluginMethod public void accountCancel(PluginCall call) {
        accountEntry(call, () -> {
            NativePolicy.require(call.getData().length() == 2 && call.getData().opt("id") instanceof String
                && call.getData().has("generation") && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation);
            AccountOperation operation = accountOperations.get(call.getString("id"));
            boolean cancelled = operation != null && operation.generation == generation && !operation.closed.get();
            if (cancelled) failAccount(operation, "Account operation cancelled", "CANCELLED");
            JSObject result = new JSObject(); result.put("cancelled", cancelled); call.resolve(result);
        });
    }
    private void revokeAccountPending(AccountOperation operation) throws Exception {
        String token, binding;
        synchronized (lock) { checkAccount(operation); token = accountRevoke; binding = accountRevokeBinding; }
        if (token == null) return;
        JSONObject body = new JSONObject(); body.put("session_binding", NativeAccountPolicy.binding(binding));
        Map<String, String> headers = new HashMap<>(); headers.put("content-type", "application/json");
        Response response = exchangeAccount(operation, "/api/account/session", "DELETE", headers,
            body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8), token, null);
        synchronized (lock) {
            checkAccount(operation);
            NativePolicy.require(response.status == 200 && (response.cookie == null || "".equals(response.cookie)) && Objects.equals(token, accountRevoke)
                && Objects.equals(binding, accountRevokeBinding));
            JSONObject result = new JSONObject(OutboxPolicy.utf8(response.body));
            NativePolicy.require(Boolean.FALSE.equals(result.opt("authenticated")) && "account".equals(result.opt("mode")));
            accountRevoke = null; accountRevokeBinding = null; persistAccount();
        }
    }
    private void applyAccountResponse(AccountOperation operation, Response response, boolean session, String sentCookie) throws Exception {
        if(operation.targetWorkspace!=null) {
            if(response.status==200)applyAccountOpenEvidence(operation.targetWorkspace,operation.targetParent,sentCookie,response.body,operation.observationOrder);
            else if(operation.expectedChild!=null)applyAccountOpenDenial(operation.targetWorkspace,operation.targetParent,operation.expectedChild,sentCookie,response.status,response.body);
        }
        if (operation.login && response.status == 200) {
            NativePolicy.require(response.cookie != null && !response.cookie.isEmpty());
            JSONObject result = new JSONObject(OutboxPolicy.utf8(response.body));
            String binding = NativeAccountPolicy.binding(result.getString("cache_binding"));
            NativePolicy.require(Boolean.TRUE.equals(result.opt("authenticated")) && "account".equals(result.opt("mode")));
            // Retain a retry-only record before attempting activation; uncertain writes never resurrect it.
            accountExpiresAt=OutboxPolicy.expiry(result.getString("expires_at")); NativePolicy.require(accountExpiresAt>System.currentTimeMillis());
            accountRevoke = response.cookie; accountRevokeBinding = binding; persistAccount();
            accountActive = response.cookie; accountActiveBinding = binding;
            accountRevoke = null; accountRevokeBinding = null; persistAccount();
        } else if (response.status == 401 || "".equals(response.cookie)) {
            if (sentCookie != null && Objects.equals(sentCookie, accountActive)) {
                accountEpoch++; operation.epoch = accountEpoch; cancelAccounts(operation, "SESSION_CHANGED");
                closeAccountWorkspaces(); quarantineAccount();
            }
        } else if (response.cookie != null) {
            NativePolicy.require(session && !operation.logout && Objects.equals(sentCookie, accountActive)
                && response.cookie.equals(accountActive));
        }
        if (session && !operation.login && !operation.logout && response.status == 200) {
            JSONObject result = new JSONObject(OutboxPolicy.utf8(response.body));
            NativePolicy.require("account".equals(result.opt("mode")));
            if (Boolean.TRUE.equals(result.opt("authenticated"))) {
                NativePolicy.require(sentCookie != null && Objects.equals(sentCookie, accountActive) && accountActiveBinding.equals(result.opt("cache_binding")));
                accountExpiresAt=OutboxPolicy.expiry(result.getString("expires_at"));NativePolicy.require(accountExpiresAt>System.currentTimeMillis());persistAccount();
            }
            else {
                NativePolicy.require(Boolean.FALSE.equals(result.opt("authenticated")));
                if (sentCookie != null && Objects.equals(sentCookie, accountActive)) {
                    accountEpoch++; operation.epoch = accountEpoch; cancelAccounts(operation, "SESSION_CHANGED");
                    closeAccountWorkspaces(); quarantineAccount();
                }
            }
        }
    }
    private long nextWorkspaceObservation() {NativePolicy.require(workspaceObservationSequence<OutboxPolicy.SAFE-1);return ++workspaceObservationSequence;}
    private void commitWorkspaceObservation(String workspace,long order) {workspaceObservationOrder.put(workspace,Math.max(order,workspaceObservationOrder.getOrDefault(workspace,0L)));}
    private void applyAccountOpenEvidence(String workspace,String parent,String sentCookie,byte[] bytes,long order)throws Exception {
        if(!Objects.equals(parent,accountActiveBinding)||!Objects.equals(sentCookie,accountActive)||order<workspaceObservationOrder.getOrDefault(workspace,0L))return;
        JSONObject body=new JSONObject(OutboxPolicy.utf8(bytes));JSONObject session=body.optJSONObject("session");
        NativePolicy.require(body.length()==3&&workspace.equals(body.optString("workspace_id"))&&parent.equals(body.optString("account_binding"))&&session!=null
            &&session.opt("authenticated")==Boolean.TRUE&&"accounts".equals(session.optString("mode"))&&workspace.equals(session.optString("workspace_id"))&&parent.equals(session.optString("account_binding")));
        String child=NativeAccountPolicy.binding(session.getString("cache_binding"));JSONObject member=session.getJSONObject("member");String memberId=OutboxPolicy.text(member.opt("id"),160),role=member.getString("role");
        NativePolicy.require(member.opt("active")==Boolean.TRUE&&memberId.matches("[A-Za-z0-9_-]{1,160}")&&Arrays.asList("owner","admin","member","guest").contains(role)&&OutboxPolicy.expiry(session.getString("expires_at"))>System.currentTimeMillis());
        boolean changed=durableOutbox().observeWorkspaceDirectorySession(session,sentCookie);commitWorkspaceObservation(workspace,order);
        if(!changed)return;
        JSONObject sealed=sealedWorkspaceScopes.optJSONObject(workspace);if(sealed!=null)sealedWorkspaceScopes.remove(workspace);
        if(workspaceScope!=null&&workspace.equals(workspaceScope.optString("workspaceId"))&&parent.equals(workspaceScope.optString("accountBinding"))) {
            workspaceEpoch++;authGeneration++;cancelAll(null,"WORKSPACE_SESSION_CHANGED");cancelOrganizationCrossJobs();workspaceScope=null;
        }
        if(lastWorkspaceSnapshot!=null&&workspace.equals(lastWorkspaceSnapshot.optString("workspaceId"))&&parent.equals(lastWorkspaceSnapshot.optString("accountBinding")))lastWorkspaceSnapshot=null;
        persistAccount(); // Negative observation only: the new session is never installed as a grant or sealed proof here.
    }
    private void applyAccountOpenDenial(String workspace,String parent,String child,String sentCookie,int status,byte[] bytes)throws Exception {
        if(status!=403&&status!=409||!Objects.equals(parent,accountActiveBinding)||!Objects.equals(sentCookie,accountActive))return;
        JSONObject body=new JSONObject(OutboxPolicy.utf8(bytes));String code=body.optString("code");
        if(!(status==403&&code.equals("WORKSPACE_ACCESS_REQUIRED"))&&!code.equals("WORKSPACE_GRANT_CHANGED"))return;
        if(!durableOutbox().retireWorkspaceScope(workspace,parent,child,sentCookie))return;
        JSONObject sealed=sealedWorkspaceScopes.optJSONObject(workspace);
        if(sealed!=null&&parent.equals(sealed.optString("accountBinding"))&&child.equals(sealed.optString("binding")))sealedWorkspaceScopes.remove(workspace);
        if(workspaceScope!=null&&workspace.equals(workspaceScope.optString("workspaceId"))&&parent.equals(workspaceScope.optString("accountBinding"))&&child.equals(workspaceScope.optString("binding"))) {
            workspaceEpoch++;authGeneration++;cancelAll(null,"WORKSPACE_SESSION_CHANGED");cancelOrganizationCrossJobs();workspaceScope=null;
        }
        if(lastWorkspaceSnapshot!=null&&workspace.equals(lastWorkspaceSnapshot.optString("workspaceId"))&&parent.equals(lastWorkspaceSnapshot.optString("accountBinding"))&&child.equals(lastWorkspaceSnapshot.optString("binding")))lastWorkspaceSnapshot=null;
        persistAccount();
    }
    private Response exchangeAccount(AccountOperation operation, String path, String method, Map<String, String> headers,
                                         byte[] body, String cookie, String workspaceCookie) throws Exception {
        checkAccount(operation);
        HttpsURLConnection connection = open(operation.origin, path, method, headers, body, null,
            (int)Math.max(1, operation.deadline - SystemClock.elapsedRealtime()), operation.boundaryEpoch);
        if (cookie != null || workspaceCookie != null) connection.setRequestProperty("Cookie",
            (cookie == null ? "" : NativeAccountPolicy.COOKIE + "=" + cookie)
                + (workspaceCookie == null ? "" : (cookie == null ? "" : "; ") + "fountain_session=" + workspaceCookie));
        try {
            synchronized (lock) { operation.connection = connection; checkAccount(operation); }
            if (connection.getDoOutput()) try (OutputStream output = connection.getOutputStream()) { checkAccount(operation); output.write(body); }
            checkAccount(operation);
            Response response = new Response(); response.status = connection.getResponseCode();
            NativePolicy.require(response.status >= 200 && response.status <= 599 && (response.status < 300 || response.status >= 400));
            response.headers = safeHeaders(connection.getHeaderFields());
            response.cookie = NativeAccountPolicy.cookie(connection.getHeaderFields(), operation.origin);
            long expected = connection.getContentLengthLong();
            NativePolicy.require(expected <= NativeAccountPolicy.MAX_RESPONSE);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = response.status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                if (input != null) { byte[] buffer = new byte[16384]; int length;
                    while ((length = input.read(buffer)) != -1) { checkAccount(operation);
                        NativePolicy.require(output.size() + length <= NativeAccountPolicy.MAX_RESPONSE); output.write(buffer, 0, length); }
                }
            }
            checkAccount(operation); response.body = output.toByteArray();
            NativePolicy.require(expected < 0 || response.body.length == expected);
            return response;
        } finally { connection.disconnect(); operation.connection = null; }
    }
    private void checkAccount(AccountOperation operation) throws IOException {
        synchronized (lock) {
            if (operation.closed.get() || destroyed || accountBroken || operation.epoch != accountEpoch
                || operation.generation != generation || operation.generation != accountGeneration || !Objects.equals(origin, operation.origin)
                || !Objects.equals(accountOrigin, operation.origin) || !NativeCookieBoundary.permits(operation.boundaryEpoch)
                || SystemClock.elapsedRealtime() > operation.deadline || operation.crossWorkspace && operation.workspaceEpoch != authGeneration) throw new IOException();
        }
    }
    private void deliverAccount(AccountOperation operation, Response response) {
        getActivity().runOnUiThread(() -> { synchronized (lock) {
            try {
                checkAccount(operation);
                JSObject result = new JSObject(); result.put("generation", operation.generation); result.put("status", response.status);
                result.put("headers", response.headers); result.put("bodyBase64", Base64.encodeToString(response.body, Base64.NO_WRAP));
                boolean delivered = resolveCurrent(operation.call, result, () -> {
                    try { checkAccount(operation); return bundleAllowed(); } catch (Exception stale) { return false; }
                });
                if (!delivered) throw new IOException();
                operation.closed.set(true); accountOperations.remove(operation.id);
                if (operation.timeout != null) operation.timeout.cancel(false);
            } catch (Exception stale) { failAccount(operation, "Account response scope changed", "STALE_SESSION"); }
        } });
    }
    private void failAccount(AccountOperation operation, String message, String code) {
        synchronized (lock) {
            if (!operation.closed.compareAndSet(false, true)) return;
            accountOperations.remove(operation.id);
            if (operation.timeout != null) operation.timeout.cancel(false);
            if (operation.connection != null) operation.connection.disconnect();
            operation.call.setKeepAlive(false); operation.call.reject(message, code);
        }
    }
    private void cancelAccounts(AccountOperation except, String reason) {
        for (AccountOperation operation : new ArrayList<>(accountOperations.values()))
            if (operation != except) failAccount(operation, "Account operation was superseded", reason);
    }

    private String workspaceCookie() { return workspaceScope == null ? activeCookie : accountActive; }
    private boolean workspaceBlocked() { return workspaceScope == null ? outboxBlocked() : accountBroken || accountActive == null || accountRevoke != null || accountVault.invalidated(origin) || accountExpiresAt > 0 && System.currentTimeMillis() >= accountExpiresAt || System.currentTimeMillis() >= workspaceScope.optLong("expiresAt", 0); }
    private void closeAccountWorkspaces() throws Exception {closeAccountWorkspaces("ACCOUNT_CHANGED");}
    private void closeAccountWorkspaces(String reason) throws Exception {
        workspaceEpoch++; authGeneration++; cancelAll(null, reason);
        cancelOrganizationCrossJobs();
        workspaceScope = null; lastWorkspaceSnapshot = null; sealedWorkspaceScopes=new JSONObject();workspaceObservationOrder.clear();workspaceObservationSequence=0;
        try { if (outboxEnabled() && origin != null) durableOutbox().revokeAccountWorkspaces(); }
        catch(Exception unavailable) { accountBroken=true; try {quarantineAccount();}catch(Exception ignored){} throw unavailable; }
    }
    private void cancelOrganizationCrossJobs() {
        for (OrganizationOperation operation : new ArrayList<>(organizationOperations.values()))
            if (operation.crossWorkspace) failOrganization(operation, "Workspace changed", "STALE_SESSION");
    }
    private void parkWorkspaceNow() throws Exception {
        workspaceEpoch++; authGeneration++; cancelAll(null, "WORKSPACE_CHANGED"); cancelOrganizationCrossJobs();
        workspaceScope = null; sessionBinding.clear(); publicWeb.clear();
        try { if (outboxEnabled() && origin != null) durableOutbox().parkWorkspace(); }
        catch(Exception unavailable) { accountBroken=true; throw unavailable; }
    }
    @PluginMethod public void parkWorkspace(PluginCall call) {
        entry(call, () -> {
            try {
                NativePolicy.require(call.getData().length() == 2 && integer(call,"generation",0,OutboxPolicy.SAFE-1)==generation
                    && integer(call,"workspaceEpoch",0,OutboxPolicy.SAFE-1)==workspaceEpoch);
                parkWorkspaceNow(); JSObject reply=new JSObject(); reply.put("generation",generation); reply.put("workspaceEpoch",workspaceEpoch); call.resolve(reply);
            } catch(Exception failure) { call.reject("Workspace park failed", "STALE_WORKSPACE"); }
        });
    }
    @PluginMethod public void activateWorkspace(PluginCall call) {
        entry(call, () -> {
            try {
                JSONObject wire=call.getData(); NativePolicy.require(wire.length()==6);
                for(String key:Arrays.asList("id","generation","workspace_id","session_binding","account_binding","timeoutMs")) NativePolicy.require(wire.has(key));
                String workspace=call.getString("workspace_id"), binding=NativeAccountPolicy.binding(call.getString("session_binding"));
                String parent=NativeAccountPolicy.binding(call.getString("account_binding"));
                NativePolicy.require(workspace!=null&&workspace.matches("[A-Za-z0-9_-]{1,160}") && Objects.equals(parent,accountActiveBinding)
                    && accountActive!=null&&accountRevoke==null&&!accountBroken&&!accountVault.invalidated(origin)
                    && integer(call,"generation",0,OutboxPolicy.SAFE-1)==generation);
                int timeout=(int)integer(call,"timeoutMs",1,45000);
                final long observationOrder=nextWorkspaceObservation();
                accountWorkspaceMode=true; parkWorkspaceNow(); final long expectedEpoch=workspaceEpoch, expectedAccount=accountEpoch;
                Operation operation=begin(call,false,timeout); final String cookie=accountActive;
                operation.workspacePrefix="/api/w/"+workspace+"/"+binding; operation.workspaceEpoch=expectedEpoch;operation.observationWorkspace=workspace;operation.observationOrder=observationOrder;operation.sessionObservationAdmitted=true;
                workers.execute(() -> {
                    try {
                        Response response=exchange(operation,operation.origin,"/api/session","GET",new HashMap<>(),new byte[0],cookie,null,65536);
                        synchronized(lock) {
                            check(operation); NativePolicy.require(expectedAccount==accountEpoch&&Objects.equals(cookie,accountActive)&&response.status==200&&response.cookie==null);
                            JSONObject session=new JSONObject(OutboxPolicy.utf8(response.body)), member=session.optJSONObject("member");
                            NativePolicy.require(session.opt("authenticated")==Boolean.TRUE&&"accounts".equals(session.optString("mode"))&&member!=null&&member.opt("active")==Boolean.TRUE
                                && workspace.equals(session.optString("workspace_id"))&&binding.equals(session.optString("cache_binding"))&&parent.equals(session.optString("account_binding")));
                            String memberId=OutboxPolicy.text(member.opt("id"),1000); long expires=OutboxPolicy.expiry(session.getString("expires_at"));
                            NativePolicy.require(expires>System.currentTimeMillis()&&expires<=System.currentTimeMillis()+604800000L);
                            NativePolicy.require(observationOrder>=workspaceObservationOrder.getOrDefault(workspace,0L));
                            durableOutbox().grant(session,cookie);
                            publicWeb.observe(operation.origin,operation.generation,operation.authGeneration,operation.boundaryEpoch,session.opt("public_web_origin"));
                            workspaceScope=new JSONObject().put("workspaceId",workspace).put("memberId",memberId).put("binding",binding).put("accountBinding",parent).put("expiresAt",expires);
                            lastWorkspaceSnapshot=new JSONObject(workspaceScope.toString());
                            NativePolicy.require(sealedWorkspaceScopes.has(workspace) || sealedWorkspaceScopes.length()<128);
                            sealedWorkspaceScopes.put(workspace,new JSONObject(workspaceScope.toString()).put("session",session)); persistAccount();commitWorkspaceObservation(workspace,observationOrder);
                            JSObject scope=new JSObject(workspaceScope.toString()); scope.put("session",session);
                            JSObject reply=new JSObject(); reply.put("generation",generation);reply.put("workspaceEpoch",expectedEpoch);reply.put("workspace",scope);
                            getActivity().runOnUiThread(() -> { synchronized(lock) { try {check(operation); NativePolicy.require(bundleAllowed()&&workspaceScope!=null&&expectedAccount==accountEpoch); if(!resolveCurrent(call,reply,()->workspaceEpoch==expectedEpoch&&accountEpoch==expectedAccount&&bundleAllowed()))throw new IOException(); operation.closed.set(true); operations.remove(operation.id);if(operation.timeout!=null)operation.timeout.cancel(false);}catch(Exception stale){fail(operation,"Workspace changed","STALE_WORKSPACE");} } });
                        }
                    }catch(Exception failure){fail(operation,"Workspace activation requires current account authority",NativeWorkspacePolicy.networkUnreachable(failure)?"NATIVE_NETWORK_UNREACHABLE":"WORKSPACE_ACTIVATION_FAILED");}
                });
            } catch(Exception invalid){call.reject("Invalid workspace activation", "NATIVE_INPUT");}
        });
    }
    private JSONObject offlineWorkspaceProof(JSONObject wire) throws Exception {
        NativePolicy.require(wire.length()==6);
        for(String key:Arrays.asList("generation","workspace_id","member_id","session_binding","account_binding","expires_at_ms"))NativePolicy.require(wire.has(key));
        NativePolicy.require(wire.opt("workspace_id") instanceof String && wire.opt("member_id") instanceof String && wire.opt("session_binding") instanceof String && wire.opt("account_binding") instanceof String);
        String workspace=wire.getString("workspace_id"),member=wire.getString("member_id"),binding=NativeAccountPolicy.binding(wire.getString("session_binding")),parent=NativeAccountPolicy.binding(wire.getString("account_binding"));
        long expiry=OutboxPolicy.integer(wire.opt("expires_at_ms"),1,OutboxPolicy.SAFE-1);
        NativePolicy.require(OutboxPolicy.integer(wire.opt("generation"),0,OutboxPolicy.SAFE-1)==generation && accountActive!=null&&accountRevoke==null&&!accountBroken&&!accountVault.invalidated(origin)
            && accountExpiresAt>System.currentTimeMillis()&&Objects.equals(parent,accountActiveBinding)&&workspace.matches("[A-Za-z0-9_-]{1,160}"));
        JSONObject sealed=sealedWorkspaceScopes.optJSONObject(workspace);
        NativePolicy.require(sealed!=null&&member.equals(sealed.getString("memberId"))&&binding.equals(sealed.getString("binding"))&&parent.equals(sealed.getString("accountBinding"))&&expiry==sealed.getLong("expiresAt")&&expiry>System.currentTimeMillis());
        return new JSONObject(sealed.toString());
    }
    @PluginMethod public void resumeWorkspaceOffline(PluginCall call) {
        entry(call, () -> { try {
            JSONObject sealed=offlineWorkspaceProof(call.getData());
            accountWorkspaceMode=true;parkWorkspaceNow();durableOutbox().resumeWorkspaceOffline(sealed.getJSONObject("session"),accountActive);
            workspaceScope=new JSONObject(sealed.toString());workspaceScope.remove("session");lastWorkspaceSnapshot=new JSONObject(workspaceScope.toString());
            JSObject reply=new JSObject();reply.put("generation",generation);reply.put("workspaceEpoch",workspaceEpoch);reply.put("offline",true);reply.put("workspace",new JSONObject(workspaceScope.toString()).put("session",sealed.getJSONObject("session")));
            final long expectedWorkspace=workspaceEpoch,expectedAccount=accountEpoch;
            if(!resolveCurrent(call,reply,()->workspaceEpoch==expectedWorkspace&&accountEpoch==expectedAccount&&workspaceScope!=null&&!workspaceBlocked()&&bundleAllowed()))throw new IOException();
        } catch(Exception stale) {call.reject("Previously verified offline workspace required","OFFLINE_WORKSPACE_UNAVAILABLE");} });
    }
    private String admitWorkspacePath(PluginCall call,String path) throws Exception {
        NativePolicy.require(!NativeOrganizationPolicy.namespace(path)&&!NativeAccountPolicy.namespace(path));
        if(NativeWorkspacePolicy.namespace(path)) {
            NativeWorkspacePolicy.Route route=NativeWorkspacePolicy.route(path);
            NativePolicy.require(workspaceScope!=null&&!workspaceBlocked()&&integer(call,"workspaceEpoch",0,OutboxPolicy.SAFE-1)==workspaceEpoch
                &&route.workspace.equals(workspaceScope.getString("workspaceId"))&&route.binding.equals(workspaceScope.getString("binding")));
            NativePolicy.require(!durableOutbox().offlineWorkspace()); return route.logical;
        }
        NativePolicy.require(workspaceScope==null && !accountWorkspaceMode); return path;
    }
    private void captureSelectedWorkspace(PluginCall call,Operation operation) throws Exception {
        if(workspaceScope!=null || call.getData().has("workspaceEpoch")) {
            NativePolicy.require(workspaceScope!=null&&!workspaceBlocked()&&integer(call,"workspaceEpoch",0,OutboxPolicy.SAFE-1)==workspaceEpoch);
            operation.workspaceEpoch=workspaceEpoch;operation.workspacePrefix="/api/w/"+workspaceScope.getString("workspaceId")+"/"+workspaceScope.getString("binding");
        } else NativePolicy.require(!accountWorkspaceMode);
    }
    private void captureWorkspace(Operation operation, String wire) {
        if(NativeWorkspacePolicy.namespace(wire)) { NativeWorkspacePolicy.Route route=NativeWorkspacePolicy.route(wire);operation.workspaceEpoch=workspaceEpoch;operation.workspacePrefix="/api/w/"+route.workspace+"/"+route.binding; }
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
                    vault.resealPublicContexts(origin==null?next:origin);
                    invalidateRecovery();
                    sessionBinding.clear(); publicWeb.clear();
                    if (outboxEnabled() && !recoveryMode && origin != null) durableOutbox().revoke();
                    persist(next, generation + 1, null, null, null);
                    if (outbox != null) { outbox.close(); outbox = null; }
                    origin = next; generation++; authGeneration++; cancelAll(null, "CONFIGURATION_CHANGED");
                    closeAccountWorkspaces(); accountConfigurationChanged();
                    organizationConfigurationChanged();
                    call.resolve(configuration());
                } catch (Exception error) { broken = true; call.reject("Native configuration storage unavailable", "UNAVAILABLE"); }
            }
        }));
    }

    private void sessionWrite(Runnable action) { if (outboxEnabled() || recoveryMode) sessions.execute(action); else action.run(); }

    private NativeOutbox durableOutbox() throws Exception {
        NativePolicy.require(origin != null);
        if (outbox == null) outbox = new NativeOutbox(getContext(), origin);
        NativePolicy.require(outbox.origin.equals(origin)); return outbox;
    }
    private boolean outboxBlocked() { return broken || destroyed || revokeCookie != null || vault.invalidated(origin); }
    private interface OutboxAction { JSObject run(NativeOutbox storage) throws Exception; }
    private void outboxCall(PluginCall call, OutboxAction action) {
        outboxCall(call, false, action);
    }
    private void outboxCall(PluginCall call, boolean recoveryMetadata, OutboxAction action) {
        entry(call, () -> {
            if (!outboxEnabled()) { call.reject("Native durable outbox is not enabled", "OUTBOX_DISABLED"); return; }
            if (recoveryMode && !recoveryMetadata) { call.reject("Recovery mode preserves the device archive", "OUTBOX_ACCESS_REQUIRED"); return; }
            sessions.execute(() -> {
            synchronized (lock) {
                try {
                    if (recoveryMode && !recoveryMetadata) throw new NativeOutbox.AccessRequired();
                    NativePolicy.require(!broken && !destroyed && NativeCookieBoundary.permits(ownerBoundaryEpoch)
                        && integer(call, "generation", 0, OutboxPolicy.SAFE - 1) == generation);
                    NativePolicy.require(!accountWorkspaceMode || workspaceScope!=null);
                    final boolean scoped = workspaceScope != null; final long admittedWorkspaceEpoch = workspaceEpoch;
                    if(call.getData().has("workspaceEpoch") || scoped) { NativePolicy.require(scoped && integer(call,"workspaceEpoch",0,OutboxPolicy.SAFE-1)==workspaceEpoch); call.getData().remove("workspaceEpoch"); }
                    NativeOutbox storage = durableOutbox();
                    if(recoveryMode){JSONObject grant=storage.verified(workspaceCookie(),workspaceBlocked());if((grant==null||recovery==null||!recovery.qualifiesOutbox(origin,grant,workspaceCookie(),generation+":"+authGeneration+":"+ownerBoundaryEpoch)) && storage.knownBlockedProfile(workspaceCookie(),workspaceBlocked())==null)throw new NativeOutbox.AccessRequired();}
                    JSObject result = action.run(storage);
                    long expected = generation, expectedAuth = authGeneration, expectedBoundary = storage.boundary(), expectedProof = storage.proofEpoch();
                    long expectedDeadline = result.has("expiresAt") ? result.getLong("expiresAt") : result.has("fragments") || "verified".equals(result.optString("identityState")) ? storage.deliveryDeadline() : Long.MAX_VALUE;
                    if (Arrays.asList("committed", "settled").contains(result.optString("state"))) {
                        JSONObject current = storage.verified(workspaceCookie(), workspaceBlocked());
                        if (current == null) {
                            if (!storage.terminalMetadataCurrent(call.getData(), result, generation, workspaceCookie(), workspaceBlocked())) throw new NativeOutbox.AccessRequired();
                        } else expectedDeadline = Math.min(expectedDeadline, current.getLong("validUntil"));
                    }
                    final long deliveryUntil = expectedDeadline;
                    String expectedOrigin = origin;
                    getActivity().runOnUiThread(() -> { synchronized (lock) {
                        try {
                            JSObject delivery = new JSObject(result.toString()); if(scoped)delivery.put("workspaceEpoch",admittedWorkspaceEpoch);
                            if (!resolveCurrent(call, delivery, () -> !broken && !destroyed && generation == expected && authGeneration == expectedAuth && (!scoped || workspaceEpoch == admittedWorkspaceEpoch)
                                && Objects.equals(origin, expectedOrigin) && outbox == storage && storage.boundary() == expectedBoundary
                                && storage.proofEpoch() == expectedProof && storage.deliveryCurrent(call.getData(), result, expected, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + expectedAuth) && System.currentTimeMillis() < deliveryUntil
                                && NativeCookieBoundary.permits(ownerBoundaryEpoch) && bundleAllowed())) call.reject("Native outbox owner changed", "STALE_SESSION");
                        } catch (Exception unsupported) { call.setKeepAlive(false); call.reject("Native response could not be delivered", "NATIVE_INPUT"); }
                    } });
                } catch (NativeReconcile.Failure error) { call.reject("Native reconciliation requires refresh or retry", error.code); }
                catch (NativeOutbox.AccessRequired error) { call.reject("Native resource access must be refreshed", "OUTBOX_ACCESS_REQUIRED"); }
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
        outboxCall(call, true, storage -> storage.open(generation, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration));
    }
    @PluginMethod public void stageDelta(PluginCall call) { outboxCall(call, true, storage -> {if(storage.verified(workspaceCookie(),workspaceBlocked())==null)throw new NativeOutbox.AccessRequired();return storage.stage(call.getData(), generation);}); }
    @PluginMethod public void commitDelta(PluginCall call) {
        outboxCall(call, true, storage -> {if(storage.verified(workspaceCookie(),workspaceBlocked())==null&&!storage.acceptedTerminal(call.getData(),generation,workspaceCookie(),workspaceBlocked()))throw new NativeOutbox.AccessRequired();return storage.commit(call.getData(), generation, workspaceCookie(), workspaceBlocked(), recoveryMode);});
    }
    @PluginMethod public void readPage(PluginCall call) {
        outboxCall(call, storage -> storage.read(call.getData(), generation, workspaceCookie(), workspaceBlocked()));
    }
    @PluginMethod public void outboxReconcile(PluginCall call) {
        outboxCall(call, true, storage -> {
            boolean exitRecovery=recoveryMode&&"prepare".equals(call.getString("phase"));
            if(recoveryMode){NativePolicy.require(Arrays.asList("settle","cancel").contains(call.getString("phase"))||exitRecovery&&!call.getData().has("planId")&&Arrays.asList("current","upgrade","promote").contains(call.getString("mode")));}
            JSObject result=storage.reconcile(call.getData(),generation,workspaceCookie(),workspaceBlocked(),outboxOwner+":"+authGeneration,outboxAdmissionSequence);
            if(exitRecovery){recoveryMode=false;invalidateRecovery();}
            return result;
        });
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
        return begin(call, logout, timeoutMs, false);
    }

    private Operation begin(PluginCall call, boolean logout, int timeoutMs, boolean publicSession) {
        NativePolicy.require(origin != null && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation);
        String id = call.getString("id");
        NativePolicy.require(id != null && id.matches("[A-Za-z0-9_.:-]{1,160}") && !operations.containsKey(id));
        Operation operation = new Operation(id, origin, generation, authGeneration, call, logout, publicSession);
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
            String wirePath = NativePolicy.path(call.getString("path"), false);
            String path = admitWorkspacePath(call, wirePath);
            String method = call.getString("method");
            NativePolicy.require(NativePolicy.METHODS.contains(method));
            if(NativeWorkspacePolicy.namespace(wirePath)&&!method.equals("GET")&&durableOutbox().requiresWorkspaceReconcile()){call.reject("Fresh canonical workspace reconciliation required","OUTBOX_ACCESS_REQUIRED");return;}
            byte[] body;
            try { body = decodeBody(call, NativePolicy.MAX_REQUEST); }
            catch (IllegalArgumentException malformed) {
                if (method.equals("DELETE") && NativePolicy.sessionPath(path)) { call.reject("Native session deletion body is invalid", "NATIVE_SESSION_INVALID"); return; }
                throw malformed;
            }
            NativePolicy.require(!method.equals("GET") || body.length == 0);
            Map<String, String> headers = requestHeaders(call);
            int timeout = (int) integer(call, "timeoutMs", 1, 45000);
            boolean session = NativePolicy.sessionPath(path);
            boolean mutation = session && (method.equals("POST") || method.equals("DELETE"));
            NativePolicy.require(!NativeWorkspacePolicy.namespace(wirePath) || !mutation);
            if(recoveryMode&&!session&&!"GET".equals(method)){call.reject("Recovery mode requires an explicit return before syncing","RECOVERY_ACCESS_REQUIRED");return;}
            NativePolicy.require(!session || method.equals("GET") || mutation);
            // Validate scope/id before a malformed call can mutate auth state.
            NativePolicy.require(origin != null && integer(call, "generation", 0, 9_007_199_254_740_990L) == generation);
            String id = call.getString("id");
            NativePolicy.require(id != null && id.matches("[A-Za-z0-9_.:-]{1,160}") && !operations.containsKey(id));
            NativeSessionBinding.Admission publicLogout = null;
            if (session && method.equals("DELETE")) {
                try { publicLogout = sessionBinding.admit(origin, activeCookie, body); vault.preparePublicLogout(publicLogout); }
                catch (NativeSessionBinding.Failure denied) { call.reject("Native session deletion was not admitted", denied.code); return; }
                catch (Exception unavailable) { call.reject("Native logout context could not be stored", "SESSION_STORAGE_FAILED"); return; }
            }
            if (mutation) {
                try{vault.resealPublicContexts(origin);}catch(Exception unavailable){call.reject("Native logout context could not be confirmed","SESSION_STORAGE_FAILED");return;}
                String explicitNativeActor=null;
                if(method.equals("DELETE")&&outboxEnabled()&&!recoveryMode)try{explicitNativeActor=durableOutbox().nativeActor(activeCookie!=null?activeCookie:revokeCookie);}catch(Exception unavailable){broken=true;}
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
            final NativeSessionBinding.Admission admittedLogout = publicLogout;
            Operation operation = begin(call, session && method.equals("DELETE"), timeout, session && !method.equals("DELETE"));
            captureWorkspace(operation, wirePath);
            if(operation.workspacePrefix!=null&&session&&method.equals("GET")) {operation.observationWorkspace=NativeWorkspacePolicy.route(wirePath).workspace;operation.observationOrder=nextWorkspaceObservation();operation.sessionObservationAdmitted=true;}
            try {
                if (outboxEnabled() && !recoveryMode && !session) {
                    NativePolicy.require(outboxAdmissionSequence < OutboxPolicy.SAFE - 1);
                    NativeOutbox storage = durableOutbox();
                    operation.reconciliationTag = storage.admitReconcile(++outboxAdmissionSequence, method, path, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
                    operation.syncAdmission = storage.admitSync(method, path, body, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
                    operation.admittedOutboxStore = storage; operation.admittedOutboxLease = storage.get("lease");
                }
            } catch (NativeReconcile.Failure invalid) { fail(operation, "Native request requires reconciliation", invalid.code); return; }
            catch (NativeOutbox.AccessRequired invalid) { fail(operation, "Native resource access must be refreshed", "OUTBOX_ACCESS_REQUIRED"); return; }
            catch (Exception invalid) { fail(operation, "Native request input was rejected", "NATIVE_INPUT"); return; }
            Runnable work = () -> {
                try {
                    if (session && operation.workspacePrefix == null && !operation.logout) revokePending(null, method.equals("POST")); // Explicit login may leave a proven-empty negative context until actual success.
                    check(operation);
                    if (operation.logout) {
                        Response response = exchange(operation, admittedLogout.origin, path, "DELETE", headers, admittedLogout.body, admittedLogout.cookie, null);
                        synchronized (lock) {
                            check(operation);
                            NativeSessionBinding.finishPublicLogout(admittedLogout, origin, activeCookie, revokeCookie, revokeOrigin, response.status, () -> {
                                vault.finishPublicContext(admittedLogout, () -> persist(origin, generation, null, null, null));
                                revokeCookie = null; revokeOrigin = null;
                            });
                        }
                        deliverResponse(operation, response);
                    } else {
                        String cookie;
                        synchronized (lock) { check(operation); cookie = workspaceCookie(); }
                        Response response = exchange(operation, operation.origin, path, method, headers, body, cookie, null);
                        if (session) {
                            applySessionResponse(operation, response, method.equals("POST"), true, cookie);
                            deliverResponse(operation, response);
                        } else sessionWrite(() -> {
                            try { applySessionResponse(operation, response, false, false, cookie); observeResourceResponse(operation, response, method, path, cookie); deliverResponse(operation, response); }
                            catch (NativeReconcile.Failure error) { fail(operation, "Native reconciliation requires refresh or retry", error.code); }
                            catch (NativeOutbox.AccessRequired error) { fail(operation, "Native resource access must be refreshed", "OUTBOX_ACCESS_REQUIRED"); }
                            catch (Exception error) { fail(operation, "Native session or outbox unavailable", "STALE_SESSION"); }
                        });
                    }
                } catch (Exception error) {
                    boolean pending;
                    synchronized (lock) { pending = revokeCookie != null || broken; }
                    fail(operation, pending ? "Session revocation is pending" : "Native HTTPS request failed",
                        pending ? "SESSION_REVOCATION_PENDING" : NativeWorkspacePolicy.networkUnreachable(error)?"NATIVE_NETWORK_UNREACHABLE":"NETWORK_ERROR");
                }
            };
            (session ? sessions : workers).execute(work);
            } catch (Exception error) { call.reject("Native request input or storage unavailable", "NATIVE_INPUT"); } }
        }));
    }

    /** Revocation is serialized and is never cancel(id)'s connection. */
    private void revokePending() throws Exception { revokePending(null,false); }
    private void revokePending(NativeSessionBinding.Admission actualLoginRollback,boolean explicitLogin) throws Exception { revokePending(actualLoginRollback,explicitLogin,0); }
    private void revokePending(NativeSessionBinding.Admission actualLoginRollback,boolean explicitLogin,int depth) throws Exception {
        if(depth>2)throw new IOException("Pending public context did not converge");
        boolean completed=false;
        String token, server;long boundaryEpoch = NativeCookieBoundary.epoch();
        synchronized (lock) { token = revokeCookie; server = revokeOrigin == null ? origin : revokeOrigin; }
        if (token == null && !vault.hasPublicContext(server)) return;
        NativeSessionBinding.Admission bound;
        try {
            bound=vault.publicRetry(server,token);
            if(bound==null&&actualLoginRollback!=null&&Objects.equals(server,actualLoginRollback.origin)&&Objects.equals(token,actualLoginRollback.cookie)){
                vault.hasMatchingPublicContext(actualLoginRollback);bound=actualLoginRollback;
            }
        }
        catch(NativeSessionBinding.Failure unknown){
            if(actualLoginRollback!=null&&Objects.equals(server,actualLoginRollback.origin)&&Objects.equals(token,actualLoginRollback.cookie)){
                vault.hasMatchingPublicContext(actualLoginRollback); // Validate all applicable contexts even when this fresh-cookie entry was not stored.
                bound=actualLoginRollback;
            }else if(explicitLogin&&token==null&&vault.confirmedEmptyForLogin(server))return;
            else throw unknown;
        }
        if(token==null&&bound==null)return;
        if (!NativeCookieBoundary.permits(boundaryEpoch)) throw new IOException();
        byte[] body=bound==null?new byte[0]:bound.body;Map<String,String> headers=new HashMap<>();if(bound!=null)headers.put("Content-Type","application/json");
        HttpsURLConnection connection = open(server, "/api/session", "DELETE", headers, body, token, 45000, boundaryEpoch);
        ScheduledFuture<?> timeout = deadlines.schedule(connection::disconnect, 45, TimeUnit.SECONDS);
        final NativeSessionBinding.Admission selected=bound;
        try {
            if(body.length>0)try(OutputStream output=connection.getOutputStream()){output.write(body);}
            if(!NativeCookieBoundary.permits(boundaryEpoch))throw new IOException();
            int status = connection.getResponseCode();
            if (!NativeCookieBoundary.permits(boundaryEpoch) || !(status >= 200 && status < 300 || status == 401 || status == 403 || selected!=null&&status==409)) throw new IOException();
            synchronized (lock) {
                if (Objects.equals(token, revokeCookie) && Objects.equals(server,revokeOrigin==null?origin:revokeOrigin)
                    && !destroyed && NativeCookieBoundary.permits(ownerBoundaryEpoch)) {
                    if(selected!=null){
                        NativeSessionBinding.finishPublicLogout(selected,server,activeCookie,revokeCookie,token==null?null:server,status,()->{
                            if(vault.hasMatchingPublicContext(selected))vault.finishPublicContext(selected,()->persist(origin,generation,activeCookie,null,null));
                            else if(selected==actualLoginRollback)persist(origin,generation,activeCookie,null,null);
                            else throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
                        });
                    }else persist(origin, generation, activeCookie, null, null);
                    revokeCookie = null; revokeOrigin = null;completed=true;
                }
            }
        } finally { timeout.cancel(false); connection.disconnect(); }
        // After the one surviving bearer, a known local no-cookie intent may
        // still need its own bound ACK. Unknown residual contexts block GET;
        // only explicit login with a proven empty record may continue.
        if(completed&&vault.hasPublicContext(server))revokePending(null,explicitLogin,depth+1);
    }

    private HttpsURLConnection open(String server, String path, String method, Map<String, String> headers,
                                    byte[] body, String cookie, int timeout, long boundaryEpoch) throws Exception {
        if (!NativeCookieBoundary.permits(boundaryEpoch)) throw new IOException();
        URL url = new URL(NativePolicy.apiUrl(server, path));
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
        return exchange(operation, server, path, method, headers, body, cookie, destination, NativePolicy.MAX_RESPONSE);
    }

    private Response exchange(Operation operation, String server, String path, String method, Map<String, String> headers,
                              byte[] body, String cookie, File destination, int memoryLimit) throws Exception {
        check(operation);
        boolean internalSession=operation.workspacePrefix!=null&&"GET".equals(method)&&NativePolicy.sessionPath(path)&&!operation.sessionObservationAdmitted;
        if(internalSession)synchronized(lock){check(operation);operation.observationWorkspace=NativeWorkspacePolicy.route(operation.workspacePrefix+"/session").workspace;operation.observationOrder=nextWorkspaceObservation();}
        String target = operation.workspacePrefix == null ? path : operation.workspacePrefix + path.substring(4);
        HttpsURLConnection connection = open(server, target, method, headers, body, operation.workspacePrefix == null ? cookie : null,
            (int) Math.max(1, operation.deadline - SystemClock.elapsedRealtime()), operation.boundaryEpoch);
        if(operation.workspacePrefix != null && cookie != null) connection.setRequestProperty("Cookie", "fountain_account_session="+cookie);
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
            if(operation.workspacePrefix!=null&&response.status==401) synchronized(lock) {
                check(operation);
                if(Objects.equals(cookie,accountActive)) {accountEpoch++;quarantineAccount();closeAccountWorkspaces("ACCOUNT_AUTH_REQUIRED");}
                throw new IOException("Account authentication required");
            }
            response.headers = safeHeaders(connection.getHeaderFields());
            response.cookie = operation.workspacePrefix == null ? NativePolicy.sessionCookie(connection.getHeaderFields(), server) : NativeAccountPolicy.cookie(connection.getHeaderFields(), server);
            if (destination != null && response.status != 200) throw new IOException();
            long expected = connection.getContentLengthLong();
            if (response.status == 204 || response.status == 304) expected = 0;
            if (destination == null && expected > memoryLimit) throw new IOException();
            ByteArrayOutputStream memory = destination == null ? new ByteArrayOutputStream() : null;
            long received = 0;
            try (InputStream input = response.status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                 OutputStream output = destination == null ? memory : new FileOutputStream(destination)) {
                if (input != null) {
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        check(operation); received += count;
                        if (received < 0 || destination == null && received > memoryLimit) throw new IOException();
                        output.write(buffer, 0, count);
                    }
                }
                check(operation);
                if (expected >= 0 && received != expected) throw new IOException();
                output.flush();
            }
            response.body = memory == null ? null : memory.toByteArray();
            if(internalSession&&response.status==200) synchronized(lock) {
                check(operation);NativeWorkspacePolicy.Route route=NativeWorkspacePolicy.route(operation.workspacePrefix+"/session");JSONObject description=new JSONObject(OutboxPolicy.utf8(response.body));
                NativePolicy.require(route.binding.equals(description.optString("cache_binding")));
                JSONObject observed=new JSONObject().put("workspace_id",route.workspace).put("account_binding",accountActiveBinding).put("session",description);
                applyAccountOpenEvidence(route.workspace,accountActiveBinding,cookie,observed.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),operation.observationOrder);
                check(operation);
            }
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
            if(operation.workspacePrefix != null) {
                if(response.status==401 && Objects.equals(sentCookie,accountActive)) {
                    accountEpoch++; quarantineAccount(); closeAccountWorkspaces(); operation.authGeneration=authGeneration; operation.workspaceEpoch=workspaceEpoch;
                    operation.admittedOutboxStore=null;operation.admittedOutboxLease=null;
                } else NativePolicy.require(response.cookie==null);
                if(session && response.status==200) { JSONObject description=new JSONObject(OutboxPolicy.utf8(response.body)); NativePolicy.require(workspaceScope!=null && description.opt("authenticated")==Boolean.TRUE
                    &&"accounts".equals(description.optString("mode"))&&description.getJSONObject("member").opt("active")==Boolean.TRUE&&workspaceScope.getString("memberId").equals(description.getJSONObject("member").optString("id"))
                    && workspaceScope.getString("workspaceId").equals(description.optString("workspace_id")) && workspaceScope.getString("binding").equals(description.optString("cache_binding"))
                    && workspaceScope.getString("accountBinding").equals(description.optString("account_binding"))&&operation.observationOrder>=workspaceObservationOrder.getOrDefault(operation.observationWorkspace,0L));
                    long expiry=OutboxPolicy.expiry(description.getString("expires_at"));NativePolicy.require(expiry>System.currentTimeMillis());durableOutbox().grant(description,accountActive);
                    workspaceScope.put("expiresAt",expiry);lastWorkspaceSnapshot=new JSONObject(workspaceScope.toString());sealedWorkspaceScopes.put(operation.observationWorkspace,new JSONObject(workspaceScope.toString()).put("session",description));persistAccount();commitWorkspaceObservation(operation.observationWorkspace,operation.observationOrder);
                }
                return;
            }
            if (login && response.status >= 200 && response.status < 300) {
                NativePolicy.require(response.cookie != null && !response.cookie.isEmpty());
                NativeSessionBinding.Admission actualRollback=null;
                try {
                    if(vault.hasPublicContext(origin)){
                        NativePolicy.require(response.status==200);
                        actualRollback=NativeSessionBinding.actualLoginCleanup(operation.origin,response.cookie,new JSONObject(OutboxPolicy.utf8(response.body)));
                        vault.preparePublicLogout(actualRollback);
                        final NativeSessionBinding.Admission confirmed=actualRollback;
                        vault.confirmActualLogin(confirmed,()->persist(origin,generation,response.cookie,revokeCookie,revokeOrigin));
                    }else persist(origin, generation, response.cookie, revokeCookie, revokeOrigin);
                    activeCookie = response.cookie;
                } catch (Exception failure) {
                    // Retirement failed after an active-cookie write may otherwise
                    // look like a successful login after process restart.
                    NativePolicy.SessionInvalidation rollbackFence=NativePolicy.fenceSession(origin,response.cookie,sessionStorage());
                    activeCookie = null; revokeCookie = response.cookie; revokeOrigin = origin;
                    broken = true; authGeneration++;
                    boolean durable = rollbackFence.durable || failure instanceof NativePolicy.SessionStorageFailure
                        && ((NativePolicy.SessionStorageFailure) failure).durable;
                    fail(operation, durable ? "Secure session storage failed; local session remains invalidated"
                        : "Durable session invalidation failed; remote revocation is being attempted",
                        durable ? "SESSION_STORAGE_FAILED" : "DURABLE_INVALIDATION_FAILED");
                    cancelAll(null, "SESSION_STORAGE_FAILED");
                    retryRevocationAfterStorageFailure(actualRollback);
                    throw new IOException();
                }
            } else if (response.status == 401 && (outboxEnabled() || recoveryMode || sentCookie != null) && Objects.equals(sentCookie, activeCookie)) {
                invalidateRecovery();
                authGeneration++;
                operation.authGeneration = authGeneration;
                cancelAll(operation, "SESSION_EXPIRED");
                NativePolicy.SessionInvalidation invalidated = invalidateSession();
                // The actual unauthenticated response carries the revocation,
                // and may be delivered without borrowing expired cache rights.
                operation.admittedOutboxStore = null; operation.admittedOutboxLease = null;
                if (!invalidated.saved) {
                    fail(operation, invalidated.durable ? "Secure session storage failed; local session remains invalidated"
                        : "Durable session invalidation failed; remote revocation is being attempted",
                        invalidated.durable ? "SESSION_STORAGE_FAILED" : "DURABLE_INVALIDATION_FAILED");
                    throw new IOException();
                }
            }
            if (outboxEnabled() && session && response.status == 200) {
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
            if (session) {
                if (response.status == 200) {
                    sessionBinding.clear();
                    try { sessionBinding.observe(origin, activeCookie, operation.origin, sentCookie, response.cookie, login, new JSONObject(OutboxPolicy.utf8(response.body))); }
                    catch (org.json.JSONException | IllegalArgumentException malformed) { sessionBinding.clear(); }
                }
                if (outboxEnabled()) { operation.sessionDeliveryStore = durableOutbox(); operation.sessionDeliveryLease = operation.sessionDeliveryStore.get("lease"); }
                check(operation);
                Object primary = null;
                if (response.status >= 200 && response.status < 300) try {
                    JSONObject description = new JSONObject(OutboxPolicy.utf8(response.body));
                    if (description.opt("authenticated") instanceof Boolean) primary = description.opt("public_web_origin");
                } catch (Exception malformed) { /* Missing/invalid metadata closes public links only. */ }
                publicWeb.observe(operation.origin, operation.generation, operation.authGeneration, operation.boundaryEpoch, primary);
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
                        || !outbox.currentOwner(outboxOwner + ":" + authGeneration) || outbox.proofEpoch() != operation.responseProofEpoch || outbox.boundary() != operation.responseProofBoundary
                        || System.currentTimeMillis() >= operation.responseProofDeadline)) throw new NativeOutbox.AccessRequired();
                    JSObject result = new JSObject(); if(operation.workspacePrefix!=null)result.put("workspaceEpoch",operation.workspaceEpoch); result.put("status", response.status);
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
            if(recovery!=null&&NativeRecovery.authorityPath(method,path))synchronized(lock) { check(operation); if(!Objects.equals(sentCookie,workspaceCookie()))throw new NativeRecovery.Failure("RECOVERY_STALE");
                recovery.observe(method,path,response.status,response.status==200?new JSONObject(OutboxPolicy.utf8(response.body)):new JSONObject()); }
            return;
        }
        if (outboxEnabled() && operation.syncAdmission != null) {
            synchronized (lock) {
                check(operation); if (!Objects.equals(sentCookie, workspaceCookie())) throw new NativeOutbox.AccessRequired();
                durableOutbox().observeSync(operation.syncAdmission, response.status, response.body, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
                durableOutbox().captureReconcile(null, response.status, response.body, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
            }
            return;
        }
        if (outboxEnabled() && !"GET".equals(method) && !NativePolicy.sessionPath(path) && OutboxPolicy.canonicalResource(method,path)==null) {
            synchronized(lock){check(operation);durableOutbox().invalidateReconcile();}
        }
        if (outboxEnabled() && operation.reconciliationTag != null && (operation.reconciliationTag.kind.equals("attachment") || response.status != 200 && response.status != 403 && response.status != 404)) {
            synchronized (lock) {
                check(operation); if (!Objects.equals(sentCookie, workspaceCookie())) throw new NativeOutbox.AccessRequired();
                NativeOutbox storage = durableOutbox(); storage.beforeReconcileObservation(operation.reconciliationTag, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
                storage.captureReconcile(operation.reconciliationTag, response.status, response.body, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
            }
            return;
        }
        if (!outboxEnabled() || OutboxPolicy.observedResource(method, path, response.status) == null) return;
        synchronized (lock) {
            check(operation); if (!Objects.equals(sentCookie, workspaceCookie())) throw new NativeOutbox.AccessRequired();
            try {
                NativeOutbox storage = durableOutbox();
                storage.beforeReconcileObservation(operation.reconciliationTag, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
                storage.observe(method, path, response.status, response.body, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
                storage.captureReconcile(operation.reconciliationTag, response.status, response.body, workspaceCookie(), workspaceBlocked(), outboxOwner + ":" + authGeneration);
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
                || operation.authGeneration != authGeneration || operation.workspaceEpoch >= 0 && operation.workspaceEpoch != workspaceEpoch || !Objects.equals(operation.origin, origin)
                || !NativeCookieBoundary.permits(operation.boundaryEpoch)
                || operation.admittedOutboxStore != null && (outbox != operation.admittedOutboxStore || !operation.admittedOutboxStore.currentLease(operation.admittedOutboxLease))
                || operation.sessionDeliveryStore != null && (outbox != operation.sessionDeliveryStore || !operation.sessionDeliveryStore.currentLease(operation.sessionDeliveryLease))
                || SystemClock.elapsedRealtime() > operation.deadline
                || operation.backupScope != null && (!Objects.equals(activeCookie, operation.backupCookie) || System.currentTimeMillis() >= operation.backupUntil)) throw new IOException();
        }
    }

    private void invalidateRecovery() {
        recoveryEpoch++;
        if(!sessions.isShutdown())sessions.execute(() -> { if(recovery!=null)recovery.invalidate(); });
    }

    private NativeRecovery.Authority recoveryAuthority(Operation operation,long epoch,String cookie,String[] returnedSessionCookie) {
        return new NativeRecovery.Authority() {
            public void check() throws Exception {
                FountainNativePlugin.this.check(operation);
                synchronized(lock){if(!recoveryMode||recoveryEpoch!=epoch||!Objects.equals(cookie,workspaceCookie()))throw new NativeRecovery.Failure("RECOVERY_STALE");}
            }
            public JSONObject get(String path)throws Exception {
                check();Response response=exchange(operation,operation.origin,path,"GET",new HashMap<>(),new byte[0],cookie,null);check();
                if(response.status==401||response.status==403||response.status==404){
                    if(recovery!=null&&response.status!=401)recovery.observe("GET",path,response.status,new JSONObject());
                    throw new NativeRecovery.Failure(response.status==401?"RECOVERY_AUTH_REQUIRED":"RECOVERY_ACCESS_REQUIRED");
                }
                if(response.status!=200)throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED");
                if(NativePolicy.sessionPath(path))returnedSessionCookie[0]=response.cookie;
                return new JSONObject(OutboxPolicy.utf8(response.body));
            }
        };
    }
    interface RecoveryPublication { void run() throws Exception; }
    static void publishRecoveryAuthority(Object scopeLock, NativeRecovery.Authority authority, RecoveryPublication publication) throws Exception {
        synchronized(scopeLock) { authority.check(); publication.run(); }
    }
    private NativeRecovery.Authority refreshRecovery(Operation operation,long epoch)throws Exception {
        String cookie;synchronized(lock){check(operation);cookie=workspaceCookie();if(workspaceBlocked())throw new NativeRecovery.Failure("RECOVERY_AUTH_REQUIRED");}
        String[] returnedSessionCookie=new String[1];
        NativeRecovery.Authority authority=recoveryAuthority(operation,epoch,cookie,returnedSessionCookie);
        JSONObject description;
        try{description=authority.get("/api/session");authority.check();}
        catch(NativeRecovery.Failure failure){if("RECOVERY_AUTH_REQUIRED".equals(failure.code))publishRecoveryAuthority(lock,authority,()->{sessionBinding.clear();if(recovery!=null)recovery.invalidate();recoveryEpoch++;});throw failure;}
        NativeRecovery.Session identity;
        try {identity=new NativeRecovery.Session(operation.origin,description,cookie,operation.generation+":"+operation.authGeneration+":"+operation.boundaryEpoch);}
        catch(Exception unauthenticated){publishRecoveryAuthority(lock,authority,()->{sessionBinding.clear();if(recovery!=null)recovery.invalidate();recoveryEpoch++;});throw new NativeRecovery.Failure("RECOVERY_AUTH_REQUIRED");}
        publishRecoveryAuthority(lock,authority,()->{
            if(recovery==null)recovery=new NativeRecovery(getContext());recovery.refresh(identity);
            if(operation.workspacePrefix==null)sessionBinding.observe(origin,workspaceCookie(),operation.origin,cookie,returnedSessionCookie[0],false,description);
            if(outboxEnabled())try{durableOutbox().grant(description,cookie);}catch(NativeOutbox.AccessRequired requiresFreshBinding){/* Dedicated recovery authority still refreshes while the Outbox binding is suspended. */}
        });
        return authority;
    }
    private interface RecoveryAction { JSObject run(Operation operation,NativeRecovery.Authority authority)throws Exception; }
    private void recoveryCall(PluginCall call,boolean inventory,RecoveryAction action) {
        entry(call,()->{
            if(inventory)recoveryMode=true;
            if(!recoveryMode){call.reject("Open recovery inventory first","RECOVERY_STALE");return;}
            Operation operation;
            try {operation=begin(call,false,45000);captureSelectedWorkspace(call,operation);NativePolicy.require(operation.workspacePrefix==null||!durableOutbox().offlineWorkspace());}catch(Exception invalid){call.reject("Recovery request is stale","RECOVERY_STALE");return;}
            final long epoch=recoveryEpoch;
            sessions.execute(()->{
                try {
                    NativeRecovery.Authority authority=refreshRecovery(operation,epoch);operation.recoveryAuthority=authority;
                    if(inventory&&outboxEnabled())synchronized(lock){check(operation);durableOutbox().open(generation,workspaceCookie(),workspaceBlocked(),outboxOwner+":"+authGeneration);}
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
                Operation operation=begin(call,false,45000);try{captureSelectedWorkspace(call,operation);}catch(Exception stale){fail(operation,"Recovery scope changed","RECOVERY_STALE");return;}
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

    private boolean resolveCurrent(PluginCall call, JSObject result, NativeBridgeReply.Current current) throws Exception {
        NativePolicy.require(Looper.myLooper() == Looper.getMainLooper() && Thread.holdsLock(lock));
        return NativeBridgeReply.deliver(call, result, current, new NativeBridgeReply.Destination() {
            public void evaluate(String script) { getBridge().getWebView().evaluateJavascript(script, null); }
            public void release() { call.release(getBridge()); }
        });
    }
    private void succeed(Operation operation, JSObject result) {
        if (operation.closed.get()) return;
        if(operation.workspacePrefix!=null)result.put("workspaceEpoch",operation.workspaceEpoch);
        try {
            boolean delivered = resolveCurrent(operation.call, result, () -> {
                try {
                    check(operation); if (!bundleAllowed()) return false;
                    if (operation.responseProofStore != null && (outbox != operation.responseProofStore || !outbox.currentOwner(outboxOwner + ":" + authGeneration)
                        || outbox.proofEpoch() != operation.responseProofEpoch || outbox.boundary() != operation.responseProofBoundary || System.currentTimeMillis() >= operation.responseProofDeadline)) return false;
                    if (operation.recoveryAuthority != null && recovery != null) recovery.checkResponse(result, operation.recoveryAuthority);
                    return true;
                } catch (Exception stale) { return false; }
            });
            if (!delivered) { fail(operation, "Native response scope changed", "STALE_SESSION"); return; }
            operation.closed.set(true); operations.remove(operation.id);
            if (operation.timeout != null) operation.timeout.cancel(false);
            operation.undeliveredRecoveryExport=null;operation.undeliveredRecoveryInventory=null; cleanupFile(operation);
        } catch (Exception unsupported) { fail(operation, "Native response could not be delivered", "NATIVE_INPUT"); }
    }

    private void fail(Operation operation, String message, String code) {
        synchronized (lock) {
            if (!operation.closed.compareAndSet(false, true)) { cleanupFile(operation); return; }
            if (operation.publicSession && operation.generation == generation && operation.authGeneration == authGeneration
                && operation.boundaryEpoch == ownerBoundaryEpoch && Objects.equals(operation.origin, origin)) publicWeb.clear();
            operations.remove(operation.id);
            if (operation.timeout != null) operation.timeout.cancel(false);
            if (operation.connection != null) operation.connection.disconnect();
            if (operation.exportStream != null) try { operation.exportStream.close(); } catch (IOException ignored) {}
            cleanupFile(operation);
            operation.call.setKeepAlive(false); operation.call.reject(message, code); // Never pass native exceptions, cookies, or headers to the logger.
        }
    }

    private void cancelAll(Operation except, String reason) {
        publicWeb.clear();
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
            String raw = call.getString("path");
            String logical; try { logical=admitWorkspacePath(call,raw); } catch(Exception invalid){call.reject("Invalid workspace download","NATIVE_INPUT");return;}
            String backupId = backupJobId(logical);
            String path = NativePolicy.path(logical, backupId == null);
            String filename = NativePolicy.filename(call.getString("filename"));
            Operation operation = begin(call, false, 45000); captureWorkspace(operation,raw);
            workers.execute(() -> {
                try {
                    operation.file = temporaryFile();
                    String cookie;
                    synchronized (lock) { check(operation); cookie = workspaceCookie(); }
                    if (backupId != null) downloadBackup(operation, backupId, cookie);
                    else exchange(operation, operation.origin, path, "GET", new HashMap<>(), new byte[0], cookie, operation.file);
                    showSave(operation, filename);
                } catch (Exception error) { fail(operation, "Native download failed", "DOWNLOAD_FAILED"); }
            });
        });
    }

    // Only this canonical query enters the resumable backup path; no signed URL or arbitrary query.
    static String backupJobId(String path) {
        if (path == null || !path.startsWith("/api/backup?")) return null;
        NativePolicy.require(path.matches("/api/backup\\?job_id=[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"));
        return path.substring("/api/backup?job_id=".length());
    }

    static final class BackupPlan {
        final long size, expires; final String sha;
        BackupPlan(JSONObject value, String id) throws Exception {
            NativePolicy.require(id.equals(value.opt("id")) && "ready".equals(value.opt("phase")));
            size = OutboxPolicy.integer(value.opt("size"), 1, 9_007_199_254_740_991L);
            sha = value.getString("sha256"); NativePolicy.require(sha.matches("[a-f0-9]{64}"));
            expires = OutboxPolicy.expiry(value.getString("expires_at"));
            NativePolicy.require(expires > System.currentTimeMillis());
        }
        void piece(long offset, int length, int status, String range, String contentLength, int received) {
            NativePolicy.require(offset >= 0 && offset < size && length > 0 && length <= 262144 && received == length
                && status == 206 && ("bytes " + offset + "-" + (offset + length - 1) + "/" + size).equals(range)
                && Integer.toString(length).equals(contentLength) && expires > System.currentTimeMillis());
        }
    }

    private void backupDeadline(Operation operation) throws Exception {
        synchronized (lock) {
            check(operation);
            if (operation.timeout != null) operation.timeout.cancel(false);
            operation.deadline = SystemClock.elapsedRealtime() + 45000;
            operation.timeout = deadlines.schedule(() -> fail(operation, "Native backup timed out", "TIMEOUT"), 45, TimeUnit.SECONDS);
        }
    }

    private void backupOwner(Operation operation) throws Exception {
        backupDeadline(operation);
        synchronized (lock) { check(operation); NativePolicy.require(operation.backupCookie != null && Objects.equals(workspaceCookie(), operation.backupCookie)); }
        Response response = exchange(operation, operation.origin, "/api/session", "GET", new HashMap<>(), new byte[0], operation.backupCookie, null, 65536);
        NativePolicy.require(response.status == 200);
        JSONObject body = new JSONObject(OutboxPolicy.utf8(response.body));
        NativePolicy.require("owner".equals(body.getJSONObject("member").opt("role")));
        NativeRecovery.Session proof = new NativeRecovery.Session(operation.origin, body, operation.backupCookie, "backup");
        synchronized (lock) {
            check(operation); NativePolicy.require(Objects.equals(workspaceCookie(), operation.backupCookie));
            if (operation.backupScope == null) operation.backupScope = proof.scope;
            NativePolicy.require(operation.backupScope.equals(proof.scope));
            operation.backupUntil = proof.validUntil;
        }
    }

    private static String backupHex(byte[] bytes) { StringBuilder value = new StringBuilder(); for (byte b : bytes) value.append(String.format(Locale.ROOT, "%02x", b & 255)); return value.toString(); }

    private void downloadBackup(Operation operation, String id, String cookie) throws Exception {
        operation.backupCookie = cookie;
        backupOwner(operation);
        Response metadata = exchange(operation, operation.origin, "/api/backup/jobs/" + id, "GET", new HashMap<>(), new byte[0], cookie, null, 65536);
        NativePolicy.require(metadata.status == 200);
        BackupPlan plan = new BackupPlan(new JSONObject(OutboxPolicy.utf8(metadata.body)), id);
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (FileOutputStream output = new FileOutputStream(operation.file)) {
            for (long offset = 0; offset < plan.size;) {
                backupOwner(operation);
                int length = (int) Math.min(262144L, plan.size - offset);
                Map<String,String> headers = new HashMap<>(); headers.put("Range", "bytes=" + offset + "-" + (offset + length - 1));
                Response piece = exchange(operation, operation.origin, "/api/backup?job_id=" + id, "GET", headers, new byte[0], cookie, null, length);
                plan.piece(offset, length, piece.status, piece.headers.optString("content-range"), piece.headers.optString("content-length"), piece.body.length);
                synchronized (lock) { check(operation); NativePolicy.require(Objects.equals(workspaceCookie(), cookie)); }
                output.write(piece.body); hash.update(piece.body); offset += length;
            }
            output.getFD().sync();
        }
        NativePolicy.require(plan.sha.equals(backupHex(hash.digest())) && operation.file.length() == plan.size);
        backupOwner(operation);
    }

    @PluginMethod public void saveData(PluginCall call) {
        entry(call, () -> {
            String filename = NativePolicy.filename(call.getString("filename"));
            byte[] bytes = decodeBody(call, NativePolicy.MAX_SAVE);
            Operation operation = begin(call, false, 45000); try{captureSelectedWorkspace(call,operation);}catch(Exception stale){fail(operation,"Export scope changed","STALE_WORKSPACE");return;}
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
                    if (operation.backupScope != null) NativePolicy.require(Objects.equals(workspaceCookie(), operation.backupCookie) && operation.backupUntil > System.currentTimeMillis());
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
                if (operation.backupScope != null) backupOwner(operation);
                if(operation.recoveryExport!=null)recovery.checkSavedSource(operation.recoveryExport,operation.recoveryAuthority);
                try (InputStream input = new FileInputStream(operation.file);
                     OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new IOException();
                    synchronized (lock) { operation.exportStream = output; check(operation); }
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        check(operation);
                        if (operation.backupScope != null && operation.deadline - SystemClock.elapsedRealtime() < 30000) backupDeadline(operation);
                        if(operation.recoveryExport!=null)recovery.checkPrepared(operation.recoveryExport,operation.recoveryAuthority);
                        output.write(buffer, 0, count);
                    }
                    output.flush(); check(operation);
                    if (operation.backupScope != null) backupOwner(operation);
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

    private boolean localUrl(Uri url) {
        try {
            URI local = new URI(getBridge().getLocalUrl());
            return Objects.equals(url.getScheme(), local.getScheme()) && Objects.equals(url.getEncodedAuthority(), local.getRawAuthority());
        } catch (Exception error) { return false; }
    }

    @Override public Boolean shouldOverrideLoad(Uri url) { return !localUrl(url); }

    @Override protected void handleOnDestroy() {
        synchronized (lock) { invalidateRecovery(); destroyed = true; authGeneration++; cancelAll(null, "APP_CLOSED"); organizationEpoch++; cancelOrganizations(null, "APP_CLOSED"); accountEpoch++; cancelAccounts(null,"APP_CLOSED"); workspaceEpoch++; }
        NativeCookieBoundary.unregister(boundaryInvalidated);
        workers.shutdownNow();
        organizationWorkers.shutdownNow(); accountWorkers.shutdownNow();
        // Already-running revocation is allowed to finish; its encrypted slot
        // survives process death and is retried before the next session call.
        sessions.execute(() -> { if(recovery!=null)recovery.invalidate();if (outbox != null) { outbox.close(); outbox = null; } deadlines.shutdown(); });
        sessions.shutdown();
    }
}
