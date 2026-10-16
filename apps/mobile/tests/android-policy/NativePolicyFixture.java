package dev.fountain.workspace;
import java.net.CookieHandler;
import java.net.URI;
import java.util.*;
public final class NativePolicyFixture {
    static int checks;
    static void equal(Object actual, Object expected) {
        checks++; if (!Objects.equals(actual, expected)) throw new AssertionError("Unexpected policy result");
    }
    static void rejects(Runnable action) {
        checks++; try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Unsafe policy input accepted");
    }
    static final class FaultStorage implements NativePolicy.SessionStorage {
        final List<String> events = new ArrayList<>();
        String active = "fixture-old-session", revoke;
        boolean invalidated, keyDestroyed;
        boolean journalFailure, sealedFailure, eraseFailure, keyFailure, journalException;
        public boolean markInvalidated(String origin) {
            events.add("journal");
            if (journalException) throw new IllegalStateException("fixture fault");
            if (journalFailure) return false;
            invalidated = true; return true;
        }
        public boolean saveRevokeOnly(String origin, String token) {
            events.add("sealed");
            if (sealedFailure) return false;
            active = null; revoke = token; return true;
        }
        public boolean eraseEncryptedState() {
            events.add("erase");
            if (eraseFailure) return false;
            active = null; revoke = null; return true;
        }
        public boolean destroyEncryptionKey() {
            events.add("key");
            if (keyFailure) return false;
            keyDestroyed = true; return true;
        }
        NativePolicy.SessionRead afterRestart() {
            if (keyDestroyed) throw new IllegalStateException("fixture key unavailable");
            return NativePolicy.restoreSession(active, revoke, invalidated);
        }
    }

    static void sessionInvalidationFaults() {
        String origin = "https://example.com";
        FaultStorage normal = new FaultStorage();
        NativePolicy.SessionInvalidation result = NativePolicy.invalidateSession(origin, normal.active, null, normal);
        equal(normal.events, Arrays.asList("journal", "sealed"));
        equal(result.saved, true); equal(result.durable, true); equal(result.journaled, true);
        equal(normal.afterRestart().active, null); equal(normal.afterRestart().revoke, "fixture-old-session");

        // The original P1: sealed-write failure leaves an old active ciphertext.
        // The actual production restore helper must expose it only for DELETE.
        FaultStorage sealed = new FaultStorage(); sealed.sealedFailure = true;
        result = NativePolicy.invalidateSession(origin, sealed.active, null, sealed);
        equal(result.saved, false); equal(result.durable, true); equal(result.journaled, true);
        equal(sealed.active, "fixture-old-session");
        equal(sealed.afterRestart().active, null); equal(sealed.afterRestart().revoke, "fixture-old-session");
        equal(result.revoke, "fixture-old-session"); // Retained for a network DELETE despite write failure.

        FaultStorage erased = new FaultStorage(); erased.journalFailure = true;
        result = NativePolicy.invalidateSession(origin, erased.active, null, erased);
        equal(erased.events, Arrays.asList("journal", "erase"));
        equal(result.saved, false); equal(result.durable, true); equal(result.journaled, false);
        equal(erased.afterRestart().active, null); equal(result.revoke, "fixture-old-session");

        FaultStorage destroyed = new FaultStorage(); destroyed.journalFailure = true; destroyed.eraseFailure = true;
        result = NativePolicy.invalidateSession(origin, destroyed.active, null, destroyed);
        equal(destroyed.events, Arrays.asList("journal", "erase", "key"));
        equal(result.saved, false); equal(result.durable, true); equal(destroyed.keyDestroyed, true);
        equal(result.revoke, "fixture-old-session");

        FaultStorage unavailable = new FaultStorage(); unavailable.journalFailure = true;
        unavailable.eraseFailure = true; unavailable.keyFailure = true;
        result = NativePolicy.invalidateSession(origin, unavailable.active, null, unavailable);
        equal(unavailable.events, Arrays.asList("journal", "erase", "key"));
        equal(result.saved, false); equal(result.durable, false); equal(result.journaled, false);
        equal(result.revoke, "fixture-old-session"); // No false durable-success claim when every backend fails.

        FaultStorage thrown = new FaultStorage(); thrown.journalException = true;
        result = NativePolicy.invalidateSession(origin, thrown.active, null, thrown);
        equal(thrown.events, Arrays.asList("journal", "erase")); equal(result.durable, true);
        equal(result.revoke, "fixture-old-session");

        // A login/empty-state commit can succeed while journal-clear reports
        // failure. Production re-fences this uncertainty before returning error.
        FaultStorage cleared = new FaultStorage();
        NativePolicy.SessionInvalidation before = NativePolicy.fenceSession(origin, null, cleared);
        equal(before.journaled, true);
        cleared.active = "fixture-new-session"; cleared.invalidated = false;
        NativePolicy.SessionInvalidation after = NativePolicy.fenceSession(origin, null, cleared);
        equal(after.durable, true); equal(after.journaled, true);
        equal(cleared.afterRestart().active, null); equal(cleared.afterRestart().revoke, "fixture-new-session");
        cleared.journalFailure = true; cleared.eraseFailure = true; cleared.keyFailure = true;
        cleared.invalidated = false;
        after = NativePolicy.fenceSession(origin, null, cleared);
        equal(after.durable, false); equal(after.journaled, false);
        boolean keyReadRejected = false;
        try { destroyed.afterRestart(); } catch (IllegalStateException expected) { keyReadRejected = true; }
        equal(keyReadRejected, true);

        NativePolicy.SessionRead ordinary = NativePolicy.restoreSession("fixture-active", null, false);
        equal(ordinary.active, "fixture-active"); equal(ordinary.revoke, null);
        NativePolicy.SessionRead pending = NativePolicy.restoreSession(null, "fixture-revoke", true);
        equal(pending.active, null); equal(pending.revoke, "fixture-revoke");
        rejects(() -> NativePolicy.invalidateSession(origin, "active", "revoke", new FaultStorage()));
    }

    static void cloudRouting() {
        String project="https://ehnovtfadpkwtubmwltl.supabase.co",prefix=project+"/functions/v1/fountain-api";
        equal(NativePolicy.apiUrl(project,"/api/session"),prefix+"/api/session");
        equal(NativePolicy.apiUrl(project+"/","/api/session"),prefix+"/api/session");
        equal(NativePolicy.apiUrl(project+":443/","/api/session"),prefix+"/api/session");
        equal(NativePolicy.apiUrl("HTTPS://EHNOVTFADPKWTUBMWLTL.SUPABASE.CO:443/","/api/session"),prefix+"/api/session");
        for(String path:Arrays.asList("/api/search?q=%ED%95%9C%EA%B8%80+%25","/api/pages/가족?title=한글","/api/pages/%ED%95%9C%EA%B8%80","/api/backup?job_id=00000000-0000-0000-0000-000000000001"))equal(NativePolicy.apiUrl(project,path),prefix+path);
        for(String path:Arrays.asList("/api/backup","/api/attachments/attachment_1/download"))equal(NativePolicy.apiUrl(project,NativePolicy.path(path,true)),prefix+path);
        for(String server:Arrays.asList(project+":8443","https://example.com","https://example.com:443","https://10.0.2.2:61603","https://localhost:8443","https://[::1]:8443","https://ehnovtfadpkwtubmwltl.supabase.co.evil.invalid","https://ehnovtfadpkwtubmwltl.supabase.co.","https://ehnovtfadpkwtubmwlt.supabase.co","https://ehnovtfadpkwtubmwltlx.supabase.co","https://ehnovtfadpkwtubmwltl.functions.supabase.co"))equal(NativePolicy.apiUrl(server,"/api/session"),NativePolicy.origin(server)+"/api/session");
        for(String path:Arrays.asList("/functions/v1/fountain-api/api/session","https://evil.invalid/api/session","//evil.invalid/api/session","/api/../session","/api/%252e%252e/session","/api/session#secret","/api/session?x=%250a","/api/x%255csecret"))rejects(()->NativePolicy.apiUrl(project,path));
        for(String server:Arrays.asList(project+"/functions/v1/fountain-api",project+"?path=x",project+"#x","https://user:password@ehnovtfadpkwtubmwltl.supabase.co","http://ehnovtfadpkwtubmwltl.supabase.co"))rejects(()->NativePolicy.apiUrl(server,"/api/session"));
    }

    public static void main(String[] args) throws Exception {
        equal(NativePolicy.origin("https://Example.COM:443/"), "https://example.com");
        equal(NativePolicy.origin("https://127.0.0.1:8443"), "https://127.0.0.1:8443");
        equal(NativePolicy.origin("https://[::1]:8443/"), "https://[::1]:8443");
        for (String origin : Arrays.asList("http://example.com", "https://user:pass@example.com", "https://example.com/x", "https://example.com?x", "https://example.com#x", "https://example.com:0", "https://example.com:65536", "https://example.com\\evil", "https://example.com\n")) rejects(() -> NativePolicy.origin(origin));
        for (String path : Arrays.asList("/api/session", "/api/pages/a?title=hello+world", "/api/pages?q=100%25", "/api/pages?q=%23tag", "/api/pages/%ED%95%9C")) equal(NativePolicy.path(path, false), path);
        for (String path : Arrays.asList("https://evil/api/x", "//evil/api/x", "/other", "/api/../x", "/api/./x", "/api/%2e%2e/x", "/api/%252e%252e/x", "/api/%25252e%25252e/x", "/api/x\\..\\y", "/api/x%255c..%255cy", "/api/x%250a", "/api/x#fragment", "/api/x%3f/%252e%252e/y", "/api/x?y=%250d%250a", "/api/x?y=%255c")) rejects(() -> NativePolicy.path(path, false));
        equal(NativePolicy.path("/api/backup", true), "/api/backup");
        equal(NativePolicy.path("/api/attachments/attachment_1/download", true), "/api/attachments/attachment_1/download");
        for (String path : Arrays.asList("/api/backup?x=1", "/api/attachments/x/download/extra", "/api/attachments/x%2fy/download", "/api/session")) rejects(() -> NativePolicy.path(path, true));
        equal(NativePolicy.sessionPath("/api/session?check=1"), true);
        equal(NativePolicy.sessionPath("/api/%2573ession"), true);
        equal(NativePolicy.sessionPath("/api/session/other"), false);
        NativePolicy.header("Content-Type", "application/json"); checks++;
        for (String header : Arrays.asList("Cookie", "Set-Cookie", "Origin", "Authorization", "Host", "X-Fountain-Request", "Content-Length")) rejects(() -> NativePolicy.header(header, "secret"));
        rejects(() -> NativePolicy.header("Accept", "text/plain\r\nCookie: leaked"));
        Map<String,List<String>> headers = new HashMap<>();
        headers.put("Set-Cookie", Arrays.asList("other_cookie=ignored; Secure; Path=/", "fountain_session=private-token; HttpOnly; Secure; Path=/"));
        equal(NativePolicy.sessionCookie(headers,"https://example.com"), "private-token");
        headers.put("Set-Cookie", Arrays.asList("fountain_session=; Max-Age=0; Path=/"));
        equal(NativePolicy.sessionCookie(headers,"https://example.com"), "");
        headers.put("Set-Cookie", Arrays.asList("fountain_session=private-token; Domain=evil.example; Path=/"));
        rejects(() -> NativePolicy.sessionCookie(headers,"https://example.com"));
        for(String filename : Arrays.asList("../file", "path/file", "path\\file", "\r\nsecret", "", ".", "..")) rejects(() -> NativePolicy.filename(filename));
        equal(NativePolicy.filename("Fountain 한글.json"), "Fountain 한글.json");
        int[] invalidations = {0}; Runnable callback = () -> invalidations[0]++;
        NativeCookieBoundary.register(callback); NativeCookieBoundary.beginInitialization();
        long first = NativeCookieBoundary.epoch(); equal(NativeCookieBoundary.permits(first), false);
        NativeCookieBoundary.install(); equal(NativeCookieBoundary.permits(first), true);
        equal(CookieHandler.getDefault().get(new URI("https://example.com"), headers).size(), 0);
        CookieHandler.getDefault().put(new URI("https://example.com"), headers);
        NativeCookieBoundary.beginInitialization(); equal(NativeCookieBoundary.permits(first), false);
        NativeCookieBoundary.install(); equal(NativeCookieBoundary.permits(first), false);
        equal(NativeCookieBoundary.permits(NativeCookieBoundary.epoch()), true);
        equal(invalidations[0], 2); NativeCookieBoundary.unregister(callback);
        CookieHandler.setDefault(new java.net.CookieManager());
        equal(NativeCookieBoundary.permits(NativeCookieBoundary.epoch()), false);
        sessionInvalidationFaults(); cloudRouting();
        System.out.println("PASS: " + checks + " independent Android policy/cookie-boundary checks (JDK only; not an Android build)");
    }
}
