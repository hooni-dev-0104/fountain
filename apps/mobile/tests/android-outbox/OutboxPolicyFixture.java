package dev.fountain.workspace;
import java.util.Arrays;
public final class OutboxPolicyFixture {
    private static int checks;
    interface Checked { void run() throws Exception; }
    static void equal(Object a, Object b) { checks++; if (!java.util.Objects.equals(a,b)) throw new AssertionError("Outbox policy mismatch"); }
    static void reject(Checked action) throws Exception {
        checks++; try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Invalid outbox input accepted");
    }
    public static void main(String[] arguments) throws Exception {
        equal(OutboxPolicy.profile("https://fixture.invalid", "가족 | 문서", "a !'()*~", "x%#?"),
            "https://fixture.invalid|%EA%B0%80%EC%A1%B1%20%7C%20%EB%AC%B8%EC%84%9C|a%20!'()*~|x%25%23%3F");
        equal(OutboxPolicy.hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        equal(OutboxPolicy.integer(1, 0, OutboxPolicy.SAFE), 1L);
        for (Object value : new Object[]{true, "1", 1.1, Double.NaN, Double.POSITIVE_INFINITY, -1}) reject(() -> OutboxPolicy.integer(value, 0, 10));
        reject(() -> OutboxPolicy.id("bad id")); reject(() -> OutboxPolicy.text("\uD800", 100));
        reject(() -> OutboxPolicy.text("\uDC00", 100)); reject(() -> OutboxPolicy.text("bad\n", 100));
        equal(OutboxPolicy.text("가족😀", 100), "가족😀");
        for (int length : new int[]{1,2,3,4,63,64,65,65536,OutboxPolicy.PART}) {
            byte[] bytes = new byte[length]; for (int i=0;i<length;i++) bytes[i]=(byte)i;
            equal(Arrays.equals(OutboxPolicy.part(OutboxPolicy.base64(bytes)),bytes), true);
            equal(OutboxPolicy.base64(bytes), java.util.Base64.getEncoder().encodeToString(bytes));
        }
        for (String value : new String[]{"", "A", "AA A", "AA==\n", "A===", "AA=A", "AB==", "AAB=", "===="}) reject(() -> OutboxPolicy.part(value));
        reject(() -> OutboxPolicy.part(OutboxPolicy.base64(new byte[OutboxPolicy.PART+1])));
        equal(OutboxPolicy.utf8("한글😀".getBytes(java.nio.charset.StandardCharsets.UTF_8)), "한글😀");
        checks++; try { OutboxPolicy.utf8(new byte[]{(byte)0xc0,(byte)0x80}); throw new AssertionError(); } catch (java.nio.charset.CharacterCodingException expected) {}
        equal(OutboxPolicy.expiry("2026-10-16T01:02:03.123456+00:00"), 1792112523123L);
        equal(OutboxPolicy.expiry("2026-10-16T10:02:03.123+09:00"), OutboxPolicy.expiry("2026-10-16T01:02:03.123Z"));
        for (String value : new String[]{"2026-10-16", "2026-10-16T01:02:03", "2026-02-30T01:02:03Z", "garbage"}) reject(() -> OutboxPolicy.expiry(value));
        equal(OutboxPolicy.resource("o|w|m|b", "o|w|m|b|p"),true);
        equal(OutboxPolicy.resource("o|w|m|b", "o|w|m|b|database|d"),true);
        for (String key : new String[]{"o|w|m|b|", "o|w|m|b|database|", "o|w|m|b|p|x", "o|w|m|other|p"}) equal(OutboxPolicy.resource("o|w|m|b",key),false);
        equal(Arrays.equals(OutboxPolicy.canonicalResource("GET", "/api/workspace"), new String[]{"workspace", "workspace"}), true);
        equal(Arrays.equals(OutboxPolicy.canonicalResource("GET", "/api/pages/%EA%B0%80%EC%A1%B1%20%7C%20%25/collaboration"), new String[]{"page", "가족 | %"}), true);
        equal(Arrays.equals(OutboxPolicy.canonicalResource("GET", "/api/databases/%252F"), new String[]{"database", "%2F"}), true);
        for (String path : new String[]{"/api/workspace?filter=x", "/api/workspace?", "/api/databases/db?filter=assigned", "/api/pages/p/operations",
            "/api/pages/p/collaboration/", "/api/pages/collaboration", "/api/pages//collaboration", "/api/databases/", "/api/databases/a/b", "/api/databases/a%2Fb", "/api/databases/..", "/api/databases/%2e%2e"}) {
            equal(OutboxPolicy.canonicalResource("GET", path), null);
        }
        equal(OutboxPolicy.canonicalResource("POST", "/api/pages/p/collaboration"), null);
        equal(OutboxPolicy.freshRevisions(100,100,100,100), true);
        equal(OutboxPolicy.freshRevisions(99,101,100,100), false);
        equal(OutboxPolicy.freshRevisions(101,99,100,100), false);
        equal(OutboxPolicy.capability(1,1,true,true), true);
        equal(OutboxPolicy.capability(1,3,false,false), false);
        equal(OutboxPolicy.capability(4,3,true,false), false);
        equal(OutboxPolicy.capability(4,3,false,true), false);
        equal(OutboxPolicy.capability(3,3,false,false), true);
        equal(OutboxPolicy.live(10,11,12), true); equal(OutboxPolicy.live(10,10,12), false); equal(OutboxPolicy.live(10,11,10), false);
        equal(OutboxPolicy.stableObservation(true,10,20,30), true);
        equal(OutboxPolicy.stableObservation(true,10,20,20), true);
        equal(OutboxPolicy.stableObservation(true,10,20,19), false);
        equal(OutboxPolicy.stableObservation(true,20,20,30), false);
        equal(OutboxPolicy.stableObservation(false,10,20,30), false);
        equal(Arrays.equals(OutboxPolicy.recoveryProfile("https://fixture.invalid","https://fixture.invalid|w|member|old-binding","w","member"),new String[]{"w","member","old-binding"}),true);
        for(String source:new String[]{"https://other.invalid|w|member|old", "https://fixture.invalid|other|member|old", "https://fixture.invalid|w|other|old", "https://fixture.invalid|w|member|", "https://fixture.invalid|w|member|%ZZ", "https://fixture.invalid|w|member|%6Fld"})equal(OutboxPolicy.recoveryProfile("https://fixture.invalid",source,"w","member"),null);
        String unicode="abc🏠def";int end=OutboxPolicy.recoverySlice(unicode,0,4);equal(end,3);equal(unicode.substring(end),"🏠def");
        equal(OutboxPolicy.actorPrefix("https://fixture.invalid","https://fixture.invalid|w%25|member%7Cname|old-binding"),"https://fixture.invalid|w%25|member%7Cname|");
        for(String profile:new String[]{"https://other.invalid|w|m|b","https://fixture.invalid|w|m|","https://fixture.invalid|w|m|%62","https://fixture.invalid|w|m|%ZZ","https://fixture.invalid|w|m|b|page"})equal(OutboxPolicy.actorPrefix("https://fixture.invalid",profile),null);
        System.out.println("Android outbox pure JDK checks passed: " + checks + " (no Android SDK/device claim)");
    }
}
