package dev.fountain.workspace;

import java.net.URI;

/** Capture the immutable wire target before logical resource policy is evaluated. */
final class NativeWorkspacePolicy {
    static final class Route {
        final String wire, logical, workspace, binding;
        Route(String wire, String logical, String workspace, String binding) {
            this.wire = wire; this.logical = logical; this.workspace = workspace; this.binding = binding;
        }
    }
    static boolean namespace(String value) {
        String path = URI.create(value).getRawPath();
        try { for (int i = 0; i < 12; i++) { String next = NativePolicy.decode(path); if (next.equals(path)) break; path = next; } }
        catch(Exception invalid) { throw new IllegalArgumentException("Invalid workspace route"); }
        return path.equals("/api/w") || path.startsWith("/api/w/");
    }
    static Route route(String value) {
        NativePolicy.path(value, false);
        URI uri = URI.create(value);
        NativePolicy.require(!uri.getRawPath().contains("//")&&!uri.getRawPath().endsWith("/"));
        String[] parts = uri.getRawPath().split("/", 6);
        NativePolicy.require(parts.length == 6 && parts[1].equals("api") && parts[2].equals("w")
            && parts[3].matches("[A-Za-z0-9_-]{1,160}") && parts[4].matches("[a-f0-9]{32}") && !parts[5].isEmpty());
        try { for (String segment : parts[5].split("/", -1)) NativePolicy.canonicalSegment(segment); }
        catch (Exception invalid) { throw new IllegalArgumentException("Invalid workspace route"); }
        String logical = "/api/" + parts[5] + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        NativePolicy.path(logical, false);
        NativePolicy.require(!NativeAccountPolicy.namespace(logical) && !NativeOrganizationPolicy.namespace(logical) && !namespace(logical));
        return new Route(value, logical, parts[3], parts[4]);
    }
    static boolean networkUnreachable(Throwable failure) {
        boolean unreachable=false;
        for(Throwable cause=failure;cause!=null;cause=cause.getCause()) {
            if(cause instanceof javax.net.ssl.SSLException || cause instanceof java.net.SocketTimeoutException || cause instanceof java.io.InterruptedIOException)return false;
            if(cause instanceof java.net.UnknownHostException || cause instanceof java.net.NoRouteToHostException || cause instanceof java.net.ConnectException)unreachable=true;
        }return unreachable;
    }
    private NativeWorkspacePolicy() {}
}
