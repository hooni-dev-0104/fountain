package dev.fountain.workspace;

import java.util.*;

/** Portable JVM execution of the production organization path/cookie boundary. */
public final class NativeOrganizationFixture {
    static int checks;
    static final String ROOT = "/api/organization/", BINDING = "0123456789abcdef0123456789abcdef";
    static final String UUID = "01234567-89ab-cdef-0123-456789abcdef";
    static final String TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
    static void equal(Object actual, Object expected) { checks++; if (!Objects.equals(actual, expected)) throw new AssertionError("Unexpected organization policy result"); }
    static void rejects(Runnable action) { checks++; try { action.run(); } catch (IllegalArgumentException expected) { return; } throw new AssertionError("Unsafe organization input accepted"); }
    static Map<String,List<String>> headers(String... values) { return Collections.singletonMap("Set-Cookie", Arrays.asList(values)); }
    static String seal(String value) { return NativeOrganizationPolicy.COOKIE + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800"; }
    public static void main(String[] args) {
        for (String path : Arrays.asList("/api/organization", ROOT+"session", "/api/%6frganization/session", "/api/%256frganization/session")) equal(NativeOrganizationPolicy.namespace(path), true);
        for (String path : Arrays.asList("/api/session", "/api/workspace", "/api/organization-other", "/api/organizations")) equal(NativeOrganizationPolicy.namespace(path), false);
        for (String method : Arrays.asList("GET", "POST", "DELETE")) equal(NativeOrganizationPolicy.path(ROOT+"session", method), ROOT+"session");
        for (String path : Arrays.asList("setup-eligibility", "organizations", "organizations/"+UUID)) {
            equal(NativeOrganizationPolicy.path(ROOT+path+"?session_binding="+BINDING, "GET"), ROOT+path+"?session_binding="+BINDING);
            rejects(() -> NativeOrganizationPolicy.path(ROOT+path, "GET"));
        }
        for (String path : Arrays.asList("organizations", "organizations/"+UUID+"/owners", "organizations/"+UUID+"/workspace-requests", "bootstrap", "workspace-preview", "workspace-accept")) equal(NativeOrganizationPolicy.path(ROOT+path,"POST"),ROOT+path);
        equal(NativeOrganizationPolicy.path(ROOT+"organizations/"+UUID,"PATCH"), ROOT+"organizations/"+UUID);
        for (String kind : Arrays.asList("owners", "workspaces")) equal(NativeOrganizationPolicy.path(ROOT+"organizations/"+UUID+"/"+kind+"/"+UUID,"DELETE"),ROOT+"organizations/"+UUID+"/"+kind+"/"+UUID);
        for (String path : Arrays.asList("/api/session", "/api/workspace", ROOT+"session/", ROOT+"%73ession", ROOT+"../session", ROOT+"%252e%252e/session", ROOT+"/session", "//evil.invalid/api/organization/session", "https://evil.invalid/api/organization/session", ROOT+"session#fragment", ROOT+"organizations/"+UUID+"/anything", ROOT+"session?session_binding="+BINDING)) rejects(() -> NativeOrganizationPolicy.path(path,"GET"));
        for (String query : Arrays.asList("", "session_binding=", "session_binding="+BINDING+"&x=1", "session_binding="+BINDING+"&session_binding="+BINDING, "%73ession_binding="+BINDING, "session_binding=%30"+BINDING, "session_binding="+BINDING.toUpperCase(), "session_binding="+BINDING+"#x")) rejects(() -> NativeOrganizationPolicy.path(ROOT+"organizations?"+query,"GET"));
        rejects(() -> NativeOrganizationPolicy.path(ROOT+"session","PUT"));
        rejects(() -> NativeOrganizationPolicy.path(ROOT+"organizations/"+UUID,"POST"));
        rejects(() -> NativeOrganizationPolicy.path(ROOT+"organizations?session_binding="+BINDING,"POST"));
        for (String method : Arrays.asList("POST", "PATCH", "DELETE")) equal(NativeOrganizationPolicy.workspace(ROOT+"session",method),false);
        equal(NativeOrganizationPolicy.workspace(ROOT+"setup-eligibility?session_binding="+BINDING,"GET"),true);
        for (String path : Arrays.asList("organizations", "workspace-preview", "workspace-accept")) equal(NativeOrganizationPolicy.workspace(ROOT+path,"POST"),true);
        for (String path : Arrays.asList("organizations?session_binding="+BINDING, "organizations/"+UUID+"?session_binding="+BINDING)) equal(NativeOrganizationPolicy.workspace(ROOT+path,"GET"),false);
        equal(NativeOrganizationPolicy.workspace(ROOT+"organizations/"+UUID+"/owners","POST"),false);
        String origin = "https://example.invalid";
        equal(NativeOrganizationPolicy.cookie(Collections.emptyMap(),origin),null);
        equal(NativeOrganizationPolicy.cookie(headers(seal(TOKEN)),origin),TOKEN);
        equal(NativeOrganizationPolicy.cookie(headers(NativeOrganizationPolicy.COOKIE+"=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"),origin),"");
        equal(NativeOrganizationPolicy.cookie(headers(seal(TOKEN)+"; Domain=example.invalid"),origin),TOKEN);
        rejects(() -> NativeOrganizationPolicy.cookie(headers(seal(TOKEN),seal(TOKEN)),origin));
        rejects(() -> NativeOrganizationPolicy.cookie(headers("fountain_session="+TOKEN+"; Path=/"),origin));
        rejects(() -> NativeOrganizationPolicy.cookie(headers(seal(TOKEN),"fountain_session="+TOKEN+"; Path=/"),origin));
        for (String line : Arrays.asList(seal(TOKEN).replace("; Secure",""), seal(TOKEN).replace("; HttpOnly",""), seal(TOKEN).replace("Strict","Lax"), seal(TOKEN).replace("Path=/","Path=/api"), seal(TOKEN)+"; Domain=evil.invalid", seal(TOKEN)+"; Domain=.example.invalid", seal(TOKEN)+"; Secure", seal(TOKEN).replace("604800","604801"), seal(TOKEN).replace("604800","-1"), seal(TOKEN).replace("604800","0604800"), seal(TOKEN).replace(TOKEN,TOKEN+"x"), seal(TOKEN)+"\n", seal(TOKEN).replace("="+TOKEN, "=\""+TOKEN+"\""))) rejects(() -> NativeOrganizationPolicy.cookie(headers(line),origin));
        equal(NativeOrganizationPolicy.MAX_REQUEST,65536); equal(NativeOrganizationPolicy.MAX_RESPONSE,2097152);
        System.out.println("PASS organization Android policy: "+checks+" checks; no SDK/device/HTTP claim");
    }
}
