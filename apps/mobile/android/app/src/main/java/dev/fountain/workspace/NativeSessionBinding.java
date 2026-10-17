package dev.fountain.workspace;

import java.util.Objects;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** RAM-only identity evidence for negative session deletion; never a cache grant. */
final class NativeSessionBinding {
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super("Native session deletion requires current binding evidence"); this.code = code; }
    }
    static final class Admission {
        final String origin, cookie;
        final byte[] body;
        Admission(String origin, String cookie, byte[] body) { this.origin = origin; this.cookie = cookie; this.body = body.clone(); }
    }
    private String origin, cookie, binding;
    void observe(String currentOrigin, String currentCookie, String requestOrigin, String sentCookie, String returnedCookie, boolean login, JSONObject actualSession) {
        clear();
        if (!Objects.equals(currentOrigin, requestOrigin) || !login && !Objects.equals(sentCookie, currentCookie)
            || returnedCookie != null && !Objects.equals(returnedCookie, currentCookie)
            || login && (returnedCookie == null || currentCookie == null)) return;
        if (currentOrigin == null || actualSession.opt("authenticated") != Boolean.TRUE) return;
        try { binding = opaque(actualSession.opt("cache_binding")); origin = currentOrigin; cookie = currentCookie; }
        catch (Failure malformed) { clear(); }
    }
    void clear() { origin = null; cookie = null; binding = null; }
    Admission admit(String currentOrigin, String currentCookie, byte[] originalBody) throws Failure {
        String expected = expectedBinding(originalBody);
        if (binding == null || !Objects.equals(origin, currentOrigin) || !Objects.equals(cookie, currentCookie)) throw new Failure("NATIVE_SESSION_REQUIRED");
        if (!binding.equals(expected)) throw new Failure("NATIVE_SESSION_CONFLICT");
        return new Admission(currentOrigin, currentCookie, originalBody);
    }
    interface PendingCleanup { void run() throws Exception; }
    static boolean finishPublicLogout(Admission admission, String currentOrigin, String activeCookie, String revokeCookie, String revokeOrigin, int status, PendingCleanup cleanup) throws Exception {
        if (!(status >= 200 && status < 300 || status == 401 || status == 403 || status == 409)) return false;
        if (!Objects.equals(currentOrigin, admission.origin) || activeCookie != null
            || revokeCookie != null && (!Objects.equals(revokeCookie, admission.cookie) || !Objects.equals(revokeOrigin, admission.origin))) throw new Failure("NATIVE_SESSION_CONFLICT");
        // A server binding conflict must never become a later unbound retry.
        // Clearing the exact private pending credential restores no cache rights.
        cleanup.run(); return true;
    }
    private static String opaque(Object value) throws Failure {
        try {
            String binding = OutboxPolicy.text(value, 1000);
            if (binding.getBytes(StandardCharsets.UTF_8).length > 1000) throw new IllegalArgumentException();
            return binding;
        } catch (IllegalArgumentException invalid) { throw new Failure("NATIVE_SESSION_INVALID"); }
    }
    private static String expectedBinding(byte[] body) throws Failure {
        if (body == null || body.length == 0 || body.length > 8192) throw new Failure("NATIVE_SESSION_INVALID");
        String json;
        try { json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString(); }
        catch (CharacterCodingException invalid) { throw new Failure("NATIVE_SESSION_INVALID"); }
        Parser parser = new Parser(json); parser.space(); parser.expect('{'); parser.space();
        if (!"cache_binding".equals(parser.string())) throw new Failure("NATIVE_SESSION_INVALID");
        parser.space(); parser.expect(':'); parser.space(); String expected = opaque(parser.string());
        // Exactly one property also rejects duplicates, including escaped key aliases.
        parser.space(); parser.expect('}'); parser.space();
        if (parser.position != json.length()) throw new Failure("NATIVE_SESSION_INVALID");
        return expected;
    }
    private static final class Parser {
        final String json; int position;
        Parser(String json) { this.json = json; }
        void space() { while (position < json.length() && " \t\r\n".indexOf(json.charAt(position)) >= 0) position++; }
        void expect(char expected) throws Failure { if (position == json.length() || json.charAt(position++) != expected) throw new Failure("NATIVE_SESSION_INVALID"); }
        String string() throws Failure {
            expect('"'); StringBuilder value = new StringBuilder();
            while (position < json.length()) {
                char next = json.charAt(position++);
                if (next == '"') return value.toString();
                if (next < 0x20) throw new Failure("NATIVE_SESSION_INVALID");
                if (next == '\\') {
                    if (position == json.length()) throw new Failure("NATIVE_SESSION_INVALID");
                    char escaped = json.charAt(position++);
                    switch (escaped) {
                        case '"': case '\\': case '/': next = escaped; break;
                        case 'b': next = '\b'; break;
                        case 'f': next = '\f'; break;
                        case 'n': next = '\n'; break;
                        case 'r': next = '\r'; break;
                        case 't': next = '\t'; break;
                        case 'u':
                            int point = 0;
                            for (int i = 0; i < 4; i++) {
                                if (position == json.length()) throw new Failure("NATIVE_SESSION_INVALID");
                                char digit = json.charAt(position++); int hex = digit >= '0' && digit <= '9' ? digit - '0' : digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 : digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : -1;
                                if (hex < 0) throw new Failure("NATIVE_SESSION_INVALID"); point = point * 16 + hex;
                            }
                            next = (char) point; break;
                        default: throw new Failure("NATIVE_SESSION_INVALID");
                    }
                }
                value.append(next);
            }
            throw new Failure("NATIVE_SESSION_INVALID");
        }
    }
}
