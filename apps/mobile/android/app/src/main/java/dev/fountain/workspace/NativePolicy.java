package dev.fountain.workspace;

import java.net.HttpCookie;
import java.net.URI;
import java.net.URLDecoder;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
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
                // Encoded ?/# are ID data only in canonical, safe segments;
                // raw URL delimiters were already separated by URI above.
                require(decodedPath.startsWith("/api/") && !controls(decodedPath) && !decodedPath.contains("\\")
                    && ((!decodedPath.contains("?") && !decodedPath.contains("#")) || canonicalDataPath(uri.getRawPath())));
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

    static String apiUrl(String server, String logicalPath) {
        String canonical = origin(server), validated = path(logicalPath, false);
        URI uri = URI.create(canonical);
        // The renderer still supplies an origin and a logical /api path only.
        // This fixed transport prefix is never configurable or caller supplied.
        boolean cloud = uri.getPort() == -1 && uri.getHost().matches("[a-z0-9]{20}\\.supabase\\.co");
        return canonical + (cloud ? "/functions/v1/fountain-api" : "") + validated;
    }

    static String publicWebOrigin(String value) {
        require(value != null && value.equals(origin(value)));
        return value;
    }

    /** RAM-only authority observed from the native session response, never JS input. */
    static final class PublicWebTrust {
        private String primary, backend;
        private long generation, auth, boundary;
        void clear() { primary = null; backend = null; }
        void observe(String server, long currentGeneration, long currentAuth, long currentBoundary, Object raw) {
            clear();
            if (!(raw instanceof String)) return;
            try { primary = publicWebOrigin((String) raw); }
            catch (IllegalArgumentException invalid) { return; }
            backend = server; generation = currentGeneration; auth = currentAuth; boundary = currentBoundary;
        }
        boolean allows(String target, String server, long currentGeneration, long currentAuth, long currentBoundary, boolean live) {
            if (!live || server == null || target == null) return false;
            String trusted = null;
            if (primary != null && Objects.equals(backend, server) && generation == currentGeneration && auth == currentAuth && boundary == currentBoundary) trusted = primary;
            else try {
                String canonical = origin(server);
                URI uri = URI.create(canonical);
                if (!canonical.equals(server) || uri.getPort() == -1 && uri.getHost().matches("[a-z0-9]{20}\\.supabase\\.co")) return false;
                trusted = canonical;
            } catch (IllegalArgumentException invalid) { return false; }
            if(!target.startsWith(trusted+"/"))return false;
            if(target.substring(trusted.length()).matches("/(forms|sites)/[A-Za-z0-9_-]{1,160}"))return true;
            try {
                URI url=new URI(target);if(!"/".equals(url.getRawPath())||url.getRawQuery()!=null||url.getRawFragment()==null)return false;
                String[] parts=url.getRawFragment().split("/",-1);
                if(parts.length!=4||!parts[0].equals("w")||!parts[1].matches("[A-Za-z0-9_-]{1,160}")||!(parts[2].equals("form")||parts[2].equals("site")))return false;
                return parts[3].matches("[A-Za-z0-9_-]{1,160}");
            } catch(Exception invalid) {return false;}
        }
    }

    static String decode(String value) throws Exception {
        return URLDecoder.decode(value.replaceAll("%(?![0-9A-Fa-f]{2})", "%25").replace("+", "%2B"), StandardCharsets.UTF_8.name());
    }

    /** decodeURIComponent/encodeURIComponent spelling, without form '+' semantics. */
    static String canonicalSegment(String raw) throws Exception {
        String decoded = strictDecode(raw);
        require(raw.equals(encodeComponent(decoded)));
        String current = decoded;
        for (int pass = 0; pass < 12; pass++) {
            require(!current.isEmpty() && !current.equals(".") && !current.equals("..")
                && !current.contains("/") && !current.contains("\\"));
            for (int i = 0; i < current.length(); i++) require(current.charAt(i) >= 32
                && !(current.charAt(i) >= 127 && current.charAt(i) <= 159));
            String next = strictDecode(current);
            if (next.equals(current)) return decoded;
            require(pass < 11); current = next;
        }
        throw new IllegalArgumentException("Invalid URI segment");
    }
    private static boolean canonicalDataPath(String raw) throws Exception {
        String[] segments = raw.split("/", -1);
        for (int i = 1; i < segments.length; i++) canonicalSegment(segments[i]);
        return true;
    }
    private static String strictDecode(String value) throws Exception {
        byte[] source = value.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream decoded = new ByteArrayOutputStream(source.length);
        for (int i = 0; i < source.length; i++) {
            if (source[i] == '%') {
                require(i + 2 < source.length);
                int a = Character.digit((char) source[++i], 16), b = Character.digit((char) source[++i], 16);
                require(a >= 0 && b >= 0); decoded.write(a * 16 + b);
            } else decoded.write(source[i]);
        }
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(decoded.toByteArray())).toString();
    }
    private static String encodeComponent(String value) {
        StringBuilder encoded = new StringBuilder();
        for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
            int c = raw & 255;
            if (c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || "-_.!~*'()".indexOf(c) >= 0) encoded.append((char)c);
            else encoded.append('%').append("0123456789ABCDEF".charAt(c >>> 4)).append("0123456789ABCDEF".charAt(c & 15));
        }
        return encoded.toString();
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
