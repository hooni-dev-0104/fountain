package dev.fountain.workspace;

import java.net.CookieHandler;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** App-process policy only. Never temporarily swaps or restores a cookie jar. */
final class NativeCookieBoundary {
    private static final CookieHandler DENY = new CookieHandler() {
        @Override public Map<String, List<String>> get(URI uri, Map<String, List<String>> headers) {
            return Collections.emptyMap();
        }
        @Override public void put(URI uri, Map<String, List<String>> headers) {}
    };
    private static final Set<Runnable> invalidators = new HashSet<>();
    private static long epoch;
    private static boolean ready;

    static void beginInitialization() {
        List<Runnable> callbacks;
        synchronized (NativeCookieBoundary.class) {
            ready = false;
            epoch++;
            callbacks = new ArrayList<>(invalidators);
        }
        for (Runnable callback : callbacks) callback.run();
    }
    static synchronized void install() {
        CookieHandler.setDefault(DENY);
        ready = true;
    }
    static synchronized long epoch() { return epoch; }
    static synchronized boolean permits(long expectedEpoch) {
        return ready && epoch == expectedEpoch && CookieHandler.getDefault() == DENY;
    }
    static synchronized void register(Runnable callback) { invalidators.add(callback); }
    static synchronized void unregister(Runnable callback) { invalidators.remove(callback); }
    private NativeCookieBoundary() {}
}
