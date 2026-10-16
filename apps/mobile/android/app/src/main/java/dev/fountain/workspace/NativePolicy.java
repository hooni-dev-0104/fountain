package dev.fountain.workspace;

import java.net.HttpCookie;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Pure validation shared by every native network entry point. */
final class NativePolicy {
    static final int MAX_REQUEST = 10_000_000;
    static final int MAX_RESPONSE = 16 * 1024 * 1024;
    static final int MAX_SAVE = 8 * 1024 * 1024;
    static final Set<String> METHODS = new HashSet<>(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE"));
    static final Set<String> REQUEST_HEADERS = new HashSet<>(Arrays.asList("content-type", "accept", "range", "if-none-match"));
    static final Set<String> RESPONSE_HEADERS = new HashSet<>(Arrays.asList("content-type", "content-length", "content-range", "accept-ranges", "etag", "content-disposition"));

    static String origin(String value) {
        try {
            require(value != null && value.length() <= 2048);
            URI uri = new URI(value);
            require("https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                && (uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))
                && uri.getPort() >= -1 && uri.getPort() != 0 && uri.getPort() <= 65535);
            require(!controls(value) && !value.contains("\\"));
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
            return "https://" + host + (uri.getPort() == -1 || uri.getPort() == 443 ? "" : ":" + uri.getPort());
        } catch (Exception error) { throw new IllegalArgumentException("Invalid HTTPS server origin"); }
    }

    static String path(String value, boolean download) {
        try {
            require(value != null && value.length() <= 8192 && value.startsWith("/api/")
                && !controls(value) && !value.contains("\\"));
            URI uri = new URI(value);
            require(!uri.isAbsolute() && uri.getRawAuthority() == null && uri.getRawFragment() == null);
            String decodedPath = uri.getRawPath();
            for (int pass = 0; pass < 12; pass++) {
                require(decodedPath.startsWith("/api/") && !controls(decodedPath) && !decodedPath.contains("\\")
                    && !decodedPath.contains("?") && !decodedPath.contains("#"));
                for (String segment : decodedPath.split("/", -1)) require(!segment.equals(".") && !segment.equals(".."));
                String next = decode(decodedPath);
                if (next.equals(decodedPath)) break;
                require(pass < 11); decodedPath = next;
            }
            String query = uri.getRawQuery();
            if (query != null) for (int pass = 0; pass < 12; pass++) {
                require(!controls(query) && !query.contains("\\"));
                String next = decode(query);
                if (next.equals(query)) break;
                require(pass < 11); query = next;
            }
            if (download) {
                require(uri.getRawQuery() == null);
                require(value.equals("/api/backup") || value.matches("/api/attachments/[A-Za-z0-9_-]{1,160}/download"));
            }
            return value;
        } catch (Exception error) { throw new IllegalArgumentException("Invalid API path"); }
    }

    static String decode(String value) throws Exception {
        return URLDecoder.decode(value.replaceAll("%(?![0-9A-Fa-f]{2})", "%25").replace("+", "%2B"), StandardCharsets.UTF_8.name());
    }

    static boolean sessionPath(String value) {
        try {
            String result = value.split("\\?", 2)[0];
            for (int pass = 0; pass < 12; pass++) {
                String next = decode(result);
                if (next.equals(result)) break;
                result = next;
            }
            return result.equals("/api/session");
        } catch (Exception error) { throw new IllegalArgumentException("Invalid API path"); }
    }

    static void header(String name, String value) {
        require(name != null && REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT))
            && value != null && value.length() <= 8192 && !controls(value));
    }

    static boolean controls(String value) {
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 32 || value.charAt(i) == 127) return true;
        return false;
    }

    /** Null means no session cookie; an empty string means an explicit removal. */
    static String sessionCookie(Map<String, List<String>> headers, String origin) {
        String result = null;
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() == null || !entry.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            for (String line : entry.getValue()) {
                require(line != null && line.length() <= 8192 && !controls(line));
                for (HttpCookie cookie : HttpCookie.parse(line)) {
                    if (!cookie.getName().equals("fountain_session")) continue;
                    String host = URI.create(origin).getHost();
                    String domain = cookie.getDomain();
                    require(domain == null || domain.equalsIgnoreCase(host));
                    require(cookie.getPath() == null || cookie.getPath().equals("/"));
                    String token = cookie.getValue();
                    require(token != null && token.length() <= 4096 && !controls(token)
                        && !token.contains(";") && !token.contains(",") && !token.contains(" ") && !token.contains("\""));
                    result = cookie.getMaxAge() == 0 ? "" : token;
                }
            }
        }
        return result;
    }

    static String filename(String name) {
        require(name != null && !name.isEmpty() && name.length() <= 200 && !controls(name)
            && !name.contains("/") && !name.contains("\\") && !name.equals(".") && !name.equals(".."));
        return name;
    }

    static void require(boolean valid) {
        if (!valid) throw new IllegalArgumentException("Invalid native transport input");
    }

    /** Actual write ordering, extracted so persistence faults can run on a JVM. */
    interface SessionStorage {
        boolean markInvalidated(String origin);
        boolean saveRevokeOnly(String origin, String token);
        boolean eraseEncryptedState();
        boolean destroyEncryptionKey();
    }

    static final class SessionInvalidation {
        final String revoke;
        final boolean journaled, saved, durable;
        SessionInvalidation(String revoke, boolean journaled, boolean saved, boolean durable) {
            this.revoke = revoke; this.journaled = journaled; this.saved = saved; this.durable = durable;
        }
    }

    static final class SessionRead {
        final String active, revoke;
        SessionRead(String active, String revoke) { this.active = active; this.revoke = revoke; }
    }

    static SessionRead restoreSession(String active, String revoke, boolean invalidated) {
        require(active == null || revoke == null);
        return invalidated ? new SessionRead(null, revoke == null ? active : revoke) : new SessionRead(active, revoke);
    }

    static SessionInvalidation invalidateSession(String origin, String active, String revoke, SessionStorage storage) {
        require(origin != null && (active == null || revoke == null));
        String token = revoke == null ? active : revoke;
        SessionInvalidation fence = fenceSession(origin, token, storage);
        if (!fence.journaled) return fence;
        boolean saved = attempt(() -> storage.saveRevokeOnly(origin, token));
        return new SessionInvalidation(token, true, saved, true);
    }

    static SessionInvalidation fenceSession(String origin, String token, SessionStorage storage) {
        // A failed journal is never treated as durable. Independently destroy
        // the local ciphertext or its app-owned key before reporting that fact.
        boolean marked = attempt(() -> storage.markInvalidated(origin));
        if (marked) return new SessionInvalidation(token, true, false, true);
        boolean erased = attempt(storage::eraseEncryptedState);
        boolean destroyed = !erased && attempt(storage::destroyEncryptionKey);
        return new SessionInvalidation(token, false, false, erased || destroyed);
    }

    static final class SessionStorageFailure extends Exception {
        final boolean durable;
        SessionStorageFailure(boolean durable) {
            super("Secure session storage unavailable");
            this.durable = durable;
        }
    }

    private interface StorageAction { boolean run(); }
    private static boolean attempt(StorageAction action) {
        try { return action.run(); } catch (Exception failure) { return false; }
    }

    private NativePolicy() {}
}
