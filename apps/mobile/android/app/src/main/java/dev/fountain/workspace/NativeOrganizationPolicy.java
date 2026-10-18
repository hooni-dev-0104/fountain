package dev.fountain.workspace;

import java.net.HttpCookie;
import java.net.URI;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Strict organization-only wire policy; it never interprets a workspace session. */
final class NativeOrganizationPolicy {
    static final String COOKIE = "fountain_organization_session";
    static final int MAX_REQUEST = 64 * 1024, MAX_RESPONSE = 2 * 1024 * 1024;
    private static final String UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

    static boolean namespace(String value) {
        String path = URI.create(value).getRawPath();
        try {
            for (int pass = 0; pass < 12; pass++) {
                String next = NativePolicy.decode(path); if (next.equals(path)) break; path = next;
            }
        } catch (Exception invalid) { throw new IllegalArgumentException("Invalid organization path"); }
        return path.equals("/api/organization") || path.startsWith("/api/organization/");
    }
    static String path(String value, String method) {
        NativePolicy.path(value, false);
        NativePolicy.require(NativePolicy.METHODS.contains(method));
        URI uri = URI.create(value);
        String path = uri.getRawPath();
        // Literal typed routes avoid encoded aliases, path traversal and prefix smuggling.
        boolean allowed = path.equals("/api/organization/session") && (method.equals("GET") || method.equals("POST") || method.equals("DELETE"))
            || path.equals("/api/organization/setup-eligibility") && method.equals("GET")
            || path.equals("/api/organization/organizations") && (method.equals("GET") || method.equals("POST"))
            || path.matches("/api/organization/organizations/" + UUID) && (method.equals("GET") || method.equals("PATCH"))
            || path.matches("/api/organization/organizations/" + UUID + "/owners") && method.equals("POST")
            || path.matches("/api/organization/organizations/" + UUID + "/owners/" + UUID) && method.equals("DELETE")
            || path.matches("/api/organization/organizations/" + UUID + "/workspace-requests") && method.equals("POST")
            || path.matches("/api/organization/organizations/" + UUID + "/workspaces/" + UUID) && method.equals("DELETE")
            || (path.equals("/api/organization/bootstrap") || path.equals("/api/organization/workspace-preview") || path.equals("/api/organization/workspace-accept")) && method.equals("POST");
        NativePolicy.require(allowed);
        String query = uri.getRawQuery();
        if (method.equals("GET") && !session(value)) NativePolicy.require(query != null && query.matches("session_binding=[a-f0-9]{32}"));
        else NativePolicy.require(query == null);
        return value;
    }
    static boolean session(String value) { return URI.create(value).getRawPath().equals("/api/organization/session"); }
    static boolean workspace(String value, String method) {
        String path = URI.create(value).getRawPath();
        return method.equals("GET") && path.equals("/api/organization/setup-eligibility")
            || method.equals("POST") && (path.equals("/api/organization/organizations") || path.equals("/api/organization/workspace-preview") || path.equals("/api/organization/workspace-accept"));
    }
    static String binding(String value) { NativePolicy.require(value != null && value.matches("[a-f0-9]{32}")); return value; }
    static String token(String value) { NativePolicy.require(value != null && value.matches("[A-Za-z0-9_-]{43}")); return value; }

    /** Null means absent; empty means explicit expiry. Cookie attributes are mandatory. */
    static String cookie(Map<String, List<String>> headers, String origin) {
        String result = null;
        boolean seen = false;
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() == null || !entry.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            NativePolicy.require(entry.getValue() != null);
            for (String line : entry.getValue()) {
                NativePolicy.require(line != null && line.length() <= 8192 && !NativePolicy.controls(line));
                List<HttpCookie> cookies = HttpCookie.parse(line);
                for (HttpCookie cookie : cookies) {
                    NativePolicy.require(!cookie.getName().equals("fountain_session"));
                    if (!cookie.getName().equals(COOKIE)) continue;
                    NativePolicy.require(!seen && cookies.size() == 1); seen = true;
                    String[] parts = line.split(";", -1);
                    NativePolicy.require(parts[0].trim().startsWith(COOKIE + "="));
                    Map<String, String> attributes = new HashMap<>();
                    for (int i = 1; i < parts.length; i++) {
                        String part = parts[i].trim(); int equal = part.indexOf('=');
                        String key = (equal < 0 ? part : part.substring(0, equal)).trim().toLowerCase(Locale.ROOT);
                        String value = equal < 0 ? "" : part.substring(equal + 1).trim();
                        NativePolicy.require(!key.isEmpty() && !attributes.containsKey(key)); attributes.put(key, value);
                    }
                    NativePolicy.require("".equals(attributes.get("secure")) && "".equals(attributes.get("httponly"))
                        && "strict".equalsIgnoreCase(attributes.get("samesite")) && "/".equals(attributes.get("path")));
                    String domain = attributes.get("domain"), host = URI.create(NativePolicy.origin(origin)).getHost();
                    NativePolicy.require(domain == null || domain.equalsIgnoreCase(host));
                    String age = attributes.get("max-age");
                    NativePolicy.require(age != null && age.matches("0|[1-9][0-9]{0,6}"));
                    long seconds = Long.parseLong(age); NativePolicy.require(seconds <= 604800);
                    String value = cookie.getValue();
                    NativePolicy.require(parts[0].trim().equals(COOKIE + "=" + value));
                    if (seconds == 0) { NativePolicy.require(value.isEmpty()); result = ""; }
                    else result = token(value);
                }
            }
        }
        return result;
    }
    private NativeOrganizationPolicy() {}
}
