package dev.fountain.workspace;

import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;


/** Pure byte/identity rules; no cookie is ever returned to JavaScript. */
final class OutboxPolicy {
    static final int PART = 256 * 1024, RECORD = 16 * 1024 * 1024, TRANSACTION = 64 * 1024 * 1024;
    static final long SAFE = 9_007_199_254_740_991L, LOCAL_TTL = 86_400_000L;
    static long integer(Object value, long min, long max) {
        NativePolicy.require(value instanceof Number);
        double number = ((Number) value).doubleValue();
        long result = ((Number) value).longValue();
        NativePolicy.require(Double.isFinite(number) && number == result && result >= min && result <= max);
        return result;
    }
    static String id(String value) {
        NativePolicy.require(value != null && value.matches("[A-Za-z0-9_.:-]{1,160}"));
        return value;
    }
    static String text(Object value, int maximum) {
        NativePolicy.require(value instanceof String);
        String result = (String) value;
        NativePolicy.require(!result.isEmpty() && result.length() <= maximum && !NativePolicy.controls(result));
        for (int i = 0; i < result.length(); i++) {
            char c = result.charAt(i);
            if (Character.isHighSurrogate(c)) NativePolicy.require(++i < result.length() && Character.isLowSurrogate(result.charAt(i)));
            else NativePolicy.require(!Character.isLowSurrogate(c));
        }
        return result;
    }
    static String utf8(byte[] value) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(value)).toString();
    }
    static String hash(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    static String hash(String value) throws Exception { return hash(value.getBytes(StandardCharsets.UTF_8)); }
    static String encode(String value) throws Exception {
        return URLEncoder.encode(text(value, 1000), "UTF-8").replace("+", "%20").replace("%21", "!")
            .replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~");
    }
    static String profile(String origin, String workspace, String member, String binding) throws Exception {
        return origin + "|" + encode(workspace) + "|" + encode(member) + "|" + encode(binding);
    }
    static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    static String base64(byte[] bytes) {
        StringBuilder out = new StringBuilder(((bytes.length + 2) / 3) * 4);
        for (int i = 0; i < bytes.length; i += 3) {
            int a = bytes[i] & 255, b = i + 1 < bytes.length ? bytes[i + 1] & 255 : 0, c = i + 2 < bytes.length ? bytes[i + 2] & 255 : 0;
            out.append(ALPHABET.charAt(a >> 2)).append(ALPHABET.charAt((a & 3) << 4 | b >> 4));
            out.append(i + 1 < bytes.length ? ALPHABET.charAt((b & 15) << 2 | c >> 6) : '=');
            out.append(i + 2 < bytes.length ? ALPHABET.charAt(c & 63) : '=');
        }
        return out.toString();
    }
    static byte[] part(String encoded) {
        NativePolicy.require(encoded != null && encoded.length() > 0 && encoded.length() <= ((PART + 2) / 3) * 4 && encoded.length() % 4 == 0);
        int padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        byte[] bytes = new byte[encoded.length() / 4 * 3 - padding];
        NativePolicy.require(bytes.length <= PART);
        int target = 0;
        for (int i = 0; i < encoded.length(); i += 4) {
            int n = 0;
            for (int j = 0; j < 4; j++) {
                char c = encoded.charAt(i + j); int value = ALPHABET.indexOf(c);
                NativePolicy.require(value >= 0 || c == '=' && i + j >= encoded.length() - padding);
                n = n << 6 | Math.max(0, value);
            }
            for (int j = 16; j >= 0 && target < bytes.length; j -= 8) bytes[target++] = (byte) (n >> j);
        }
        NativePolicy.require(base64(bytes).equals(encoded)); return bytes;
    }
    static long expiry(String input) throws Exception {
        // java.time and java.util.Base64 require API26; this app also supports API24.
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})$").matcher(input);
        NativePolicy.require(match.matches());
        String fraction = match.group(2) == null ? "000" : (match.group(2) + "000").substring(0, 3);
        String zone = match.group(3).equals("Z") ? "+0000" : match.group(3).replace(":", "");
        java.text.SimpleDateFormat parser = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", java.util.Locale.ROOT);
        parser.setLenient(false); String canonical = match.group(1) + "." + fraction + zone;
        java.text.ParsePosition position = new java.text.ParsePosition(0); java.util.Date result = parser.parse(canonical, position);
        NativePolicy.require(result != null && position.getIndex() == canonical.length()); return result.getTime();
    }
    static boolean resource(String profile, String key) {
        if (key == null || !key.startsWith(profile + "|")) return false;
        String rest = key.substring(profile.length() + 1);
        return !rest.isEmpty() && (!rest.contains("|") || rest.startsWith("database|") && rest.length() > 9 && rest.indexOf('|', 9) < 0);
    }
    static String[] canonicalResource(String method, String path) throws Exception {
        if (!"GET".equals(method) || path == null || path.contains("?") || path.contains("#")) return null;
        if (path.equals("/api/workspace")) return new String[]{"workspace", "workspace"};
        String kind, encoded;
        if (path.startsWith("/api/pages/") && path.endsWith("/collaboration")) {
            if (path.length() <= 25) return null;
            kind = "page"; encoded = path.substring(11, path.length() - 14);
        } else if (path.startsWith("/api/databases/")) { kind = "database"; encoded = path.substring(15); }
        else return null;
        if (encoded.isEmpty() || encoded.contains("/")) return null;
        // Exactly one decode. Percent-containing resource IDs stay literal.
        String identity = java.net.URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8");
        text(identity, 1000);
        if (identity.contains("/") || identity.contains("\\") || identity.equals(".") || identity.equals("..") || !encode(identity).equals(encoded)) return null;
        return new String[]{kind, identity};
    }
    static boolean freshRevisions(long access, long data, long previousAccess, long previousData) {
        return access >= previousAccess && data >= previousData;
    }
    static boolean capability(long level, int needed, boolean locked, boolean archived) {
        return level >= needed && (needed < 3 || !locked && !archived);
    }
    static boolean live(long now, long validUntil, long grantUntil) { return now < validUntil && now < grantUntil; }
    static boolean stableObservation(boolean same, long now, long previousUntil, long grantUntil) {
        return same && previousUntil > now && grantUntil >= previousUntil;
    }
    static String[] recoveryProfile(String origin, String source, String workspace, String member) throws Exception {
        if (source == null) return null; String[] parts = source.split("\\|", -1);
        if (parts.length != 4 || !origin.equals(parts[0])) return null;
        String[] decoded = new String[3];
        try { for (int i = 1; i < parts.length; i++) {
            decoded[i - 1] = java.net.URLDecoder.decode(parts[i].replace("+", "%2B"), "UTF-8");
            if (!encode(decoded[i - 1]).equals(parts[i])) return null;
        } } catch (IllegalArgumentException malformed) { return null; }
        return workspace.equals(decoded[0]) && member.equals(decoded[1]) ? decoded : null;
    }
    static int recoverySlice(String text, int offset, int maximum) {
        int end = Math.min(text.length(), offset + maximum);
        if (end < text.length() && end > offset && Character.isHighSurrogate(text.charAt(end - 1))) end--;
        return end;
    }
}
