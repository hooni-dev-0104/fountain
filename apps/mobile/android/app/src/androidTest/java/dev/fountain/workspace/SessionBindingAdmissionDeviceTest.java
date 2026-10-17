package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

/** Production admission seam + actual isolated SQLite; no live auth/cloud claim. */
@RunWith(AndroidJUnit4.class)
public class SessionBindingAdmissionDeviceTest {
    private static byte[] body(String binding) throws Exception { return new JSONObject().put("cache_binding", binding).toString().getBytes(StandardCharsets.UTF_8); }
    private static JSONObject session(String binding) throws Exception { return new JSONObject().put("authenticated", true).put("cache_binding", binding); }
    private static void observed(NativeSessionBinding target,String origin,String cookie,JSONObject actualSession) { target.observe(origin,cookie,origin,cookie,null,false,actualSession); }
    private static String privateState(ReconcileDeviceTest.Fixture f) throws Exception {
        JSONArray state = new JSONArray();
        try (Cursor c = f.db.rawQuery("SELECT key,value FROM control ORDER BY key", null)) { while(c.moveToNext()) state.put(new JSONArray().put(c.getString(0)).put(c.getString(1))); }
        try (Cursor c = f.db.rawQuery("SELECT mode,bucket,key,hex(payload) FROM records ORDER BY mode,bucket,key", null)) { while(c.moveToNext()) state.put(new JSONArray().put(c.getString(0)).put(c.getString(1)).put(c.getString(2)).put(c.getString(3))); }
        try (Cursor c = f.db.rawQuery("SELECT tx_id,part,hex(data) FROM staging ORDER BY tx_id,part", null)) { while(c.moveToNext()) state.put(new JSONArray().put(c.getString(0)).put(c.getLong(1)).put(c.getString(2))); }
        return OutboxPolicy.hash(state.toString());
    }
    private static void baselineAndPending(ReconcileDeviceTest.Fixture f) throws Exception {
        JSONObject collecting=f.call(f.prepare()); f.observed("/api/workspace",f.workspace(10,false)); f.call(f.commit(f.next(collecting)));
        JSONObject opened=f.open(); byte[] delta=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("op","put").put("bucket","meta").put("key","revoked:"+f.profile()).put("value",new JSONObject().put("id","revoked:"+f.profile())))).toString().getBytes(StandardCharsets.UTF_8);
        f.outbox.stage(new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","untouched-pending").put("digest",OutboxPolicy.hash(delta)).put("part",0).put("bytesBase64",OutboxPolicy.base64(delta)),1);
        assertEquals(3,f.count("records")); assertEquals(1,f.count("staging"));
    }
    @Test public void staleBindingCannotReachCurrentActorRevocationAndMatchingCurrentBindingStillWorks() throws Exception {
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()) {
            baselineAndPending(f); NativeSessionBinding binding=new NativeSessionBinding(); observed(binding,f.origin,"cookie-B",session("binding-B"));
            String before=privateState(f),cookie="cookie-B"; int authGeneration=7,deleteCalls=0; NativeSessionBinding.Failure rejected=null;
            try {
                binding.admit(f.origin,cookie,body("binding-A"));
                // The real Plugin calls admission BEFORE these negative effects.
                authGeneration++; cookie=null; f.outbox.revoke(); deleteCalls++;
            } catch(NativeSessionBinding.Failure denied) { rejected=denied; }
            assertEquals("Stale public logout changed current native auth generation before binding admission",7,authGeneration);
            assertEquals("cookie-B",cookie); assertEquals("Stale public logout must cause zero DELETE calls",0,deleteCalls);
            assertEquals("Current private head/lease/proof/source/staging must remain exact",before,privateState(f));
            assertNotNull(rejected); assertEquals("NATIVE_SESSION_CONFLICT",rejected.code);
            NativeSessionBinding.Admission current=binding.admit(f.origin,"cookie-B",body("binding-B"));
            assertEquals("A failed old binding cannot discard the actual current observation","cookie-B",current.cookie);
        }
    }
    @Test public void exactMatchingBodyAndSelectedCookieReachNegativeLogoutWithoutPositiveCacheGrant() throws Exception {
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()) {
            baselineAndPending(f); NativeSessionBinding binding=new NativeSessionBinding(); observed(binding,f.origin,"cookie-B",session("binding-B"));
            byte[] original=body("binding-B");NativeSessionBinding.Admission selected=binding.admit(f.origin,"cookie-B",original);
            assertEquals(f.origin,selected.origin);assertEquals("cookie-B",selected.cookie);assertArrayEquals(original,selected.body);
            original[0]='x';assertEquals('{',selected.body[0]);f.outbox.revoke();assertNull(f.outbox.verified(null,false));
            assertEquals("Blocked positive storage does not remove native negative session identity","cookie-B",binding.admit(f.origin,"cookie-B",body("binding-B")).cookie);
            assertEquals(3,f.count("records"));assertEquals(1,f.count("staging"));
        }
    }
    @Test public void missingObservationRejectsWithoutReadingAnyOutboxGrantOrChangingInput() throws Exception {
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()) {
            baselineAndPending(f);String before=privateState(f);NativeSessionBinding binding=new NativeSessionBinding();
            try { binding.admit(f.origin,"cookie-B",body("binding-B"));fail("Cached Outbox data is not actual HTTP session evidence"); }
            catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_REQUIRED",expected.code);}
            assertEquals(before,privateState(f));
        }
    }
    @Test public void malformedMissingDuplicateAndUnknownBodyFieldsRejectBeforeBindingLookup() throws Exception {
        List<byte[]> invalid=new ArrayList<>();
        for(String value:Arrays.asList("", "{}", "null", "[]", "{\"cache_binding\":null}", "{\"cache_binding\":1}", "{\"cache_binding\":\"\"}", "{\"cache_binding\":\"B\",\"cache_binding\":\"B\"}", "{\"cache_binding\":\"B\",\"extra\":true}", "{\"cache_binding\":\"B\"}{}", "{'cache_binding':'B'}", "{cache_binding:\"B\"}", "{\"cache_binding\":\"\\q\"}", "{\"cache_binding\":\"\\ud800\"}", "{\"cache_binding\":\"B\",}", "{\"cache_binding\":\"B\",\"cache_\\u0062inding\":\"B\"}")) invalid.add(value.getBytes(StandardCharsets.UTF_8));
        invalid.add(body("x".repeat(1001)));invalid.add(body("é".repeat(501)));invalid.add(body("😀".repeat(251)));invalid.add(body("B\n"));invalid.add(new byte[]{(byte)0xc3,0x28});invalid.add(new byte[8193]);
        NativeSessionBinding binding=new NativeSessionBinding();
        for(int i=0;i<invalid.size();i++)try{binding.admit("https://binding.invalid","cookie",invalid.get(i));fail("Invalid body was admitted at case "+i);}
        catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_INVALID",expected.code);}
    }
    @Test public void changedCookieOrOriginRequiresAnActualNewSessionObservation() throws Exception {
        NativeSessionBinding binding=new NativeSessionBinding();observed(binding,"https://one.invalid","cookie-B",session("binding-B"));
        for(String[] scope:new String[][]{{"https://one.invalid","cookie-C"},{"https://two.invalid","cookie-B"},{"https://one.invalid",null}})try{binding.admit(scope[0],scope[1],body("binding-B"));fail("An old private tuple crossed its native cookie/origin");}
        catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_REQUIRED",expected.code);}
        assertEquals("cookie-B",binding.admit("https://one.invalid","cookie-B",body("binding-B")).cookie);
    }
    @Test public void actualAnonymousOrMalformedSessionCannotRetainPreviousBinding() throws Exception {
        NativeSessionBinding binding=new NativeSessionBinding();
        for(JSONObject value:Arrays.asList(new JSONObject().put("authenticated",false),new JSONObject().put("authenticated",true),new JSONObject().put("authenticated",true).put("cache_binding",17))){
            observed(binding,"https://binding.invalid","cookie-B",session("binding-B"));observed(binding,"https://binding.invalid","cookie-B",value);
            try{binding.admit("https://binding.invalid","cookie-B",body("binding-B"));fail("Actual invalid session retained an old binding");}
            catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_REQUIRED",expected.code);}
        }
    }
    @Test public void outboxDisabledAndExpiredPositiveProofHaveTheSameNativeBindingAdmission() throws Exception {
        // No Outbox instance/configuration is available to this production helper.
        NativeSessionBinding binding=new NativeSessionBinding();JSONObject description=session("binding-B").put("expires_at","2000-01-01T00:00:00Z");
        observed(binding,"https://binding.invalid","cookie-B",description);
        assertEquals("cookie-B",binding.admit("https://binding.invalid","cookie-B",body("binding-B")).cookie);
        binding.clear();try{binding.admit("https://binding.invalid","cookie-B",body("binding-B"));fail("Cleared negative identity evidence was reused");}
        catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_REQUIRED",expected.code);}
    }
    @Test public void boundedEscapesAndExactlyOneThousandBindingCharactersRemainValid() throws Exception {
        NativeSessionBinding binding=new NativeSessionBinding();String current="x".repeat(1000);observed(binding,"https://binding.invalid","cookie-B",session(current));
        assertArrayEquals(body(current),binding.admit("https://binding.invalid","cookie-B",body(current)).body);
        for(String unicode:Arrays.asList("é".repeat(500),"😀".repeat(250))){observed(binding,"https://binding.invalid","cookie-B",session(unicode));assertArrayEquals(body(unicode),binding.admit("https://binding.invalid","cookie-B",body(unicode)).body);}
        observed(binding,"https://binding.invalid","cookie-B",session("B"));byte[] escaped=" \r\n{\"cache_\\u0062inding\":\"\\u0042\"}\t".getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(escaped,binding.admit("https://binding.invalid","cookie-B",escaped).body);
    }
    @Test public void actualGetPublicationRejectsMismatchedOriginSentCookieAndReturnedCookieAcrossAllFlags() throws Exception {
        for(String[] context:new String[][]{{"https://other.invalid","cookie-B",null},{"https://binding.invalid","cookie-A",null},{"https://binding.invalid","cookie-B","cookie-C"}}){
            NativeSessionBinding binding=new NativeSessionBinding();binding.observe("https://binding.invalid","cookie-B",context[0],context[1],context[2],false,session("binding-B"));
            try{binding.admit("https://binding.invalid","cookie-B",body("binding-B"));fail("A body without matching actual HTTP cookie context filled the private tuple");}
            catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_REQUIRED",expected.code);}
        }
        NativeSessionBinding binding=new NativeSessionBinding();binding.observe("https://binding.invalid","cookie-B","https://binding.invalid","cookie-B","cookie-B",false,session("binding-B"));
        assertEquals("cookie-B",binding.admit("https://binding.invalid","cookie-B",body("binding-B")).cookie);
    }
    @Test public void actualPostPublicationRequiresItsAdoptedReturnedCookieAndCannotUseOnlyTheBody() throws Exception {
        NativeSessionBinding binding=new NativeSessionBinding();
        for(String returned:new String[]{null,"cookie-C"}){
            binding.observe("https://binding.invalid","cookie-B","https://binding.invalid",null,returned,true,session("binding-B"));
            try{binding.admit("https://binding.invalid","cookie-B",body("binding-B"));fail("Login without the matching native adopted cookie filled the private tuple");}
            catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_REQUIRED",expected.code);}
        }
        binding.observe("https://binding.invalid","cookie-B","https://binding.invalid",null,"cookie-B",true,session("binding-B"));
        assertEquals("A real login adopts its response cookie, unlike its pre-login sent cookie","cookie-B",binding.admit("https://binding.invalid","cookie-B",body("binding-B")).cookie);
    }
    @Test public void serverConflictClearsOnlyTheExactOwnedPendingCredentialWithoutRevivingStorageOrRetry() throws Exception {
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            baselineAndPending(f);f.outbox.revoke();String before=privateState(f);NativeSessionBinding binding=new NativeSessionBinding();observed(binding,f.origin,"cookie-B",session("binding-B"));
            NativeSessionBinding.Admission admitted=binding.admit(f.origin,"cookie-B",body("binding-B"));java.util.concurrent.atomic.AtomicReference<String> pending=new java.util.concurrent.atomic.AtomicReference<>("cookie-B");
            assertTrue(NativeSessionBinding.finishPublicLogout(admitted,f.origin,null,pending.get(),f.origin,409,()->pending.set(null)));
            assertNull("Server409 cannot be followed by a bodyless retry of this cookie",pending.get());assertEquals(before,privateState(f));assertNull(f.outbox.verified(null,false));
            for(String[] changed:new String[][]{{f.origin,"new-active","cookie-B",f.origin},{f.origin,null,"other-pending",f.origin},{"https://other.invalid",null,"cookie-B",f.origin},{f.origin,null,"cookie-B","https://other.invalid"}}){
                pending.set(changed[2]);try{NativeSessionBinding.finishPublicLogout(admitted,changed[0],changed[1],pending.get(),changed[3],409,()->pending.set(null));fail("An unrelated active or pending cookie was cleared");}
                catch(NativeSessionBinding.Failure expected){assertEquals("NATIVE_SESSION_CONFLICT",expected.code);assertEquals(changed[2],pending.get());}
            }
            pending.set("cookie-B");assertFalse(NativeSessionBinding.finishPublicLogout(admitted,f.origin,null,pending.get(),f.origin,503,()->pending.set(null)));assertEquals("Native-owned uncertain revocation remains pending","cookie-B",pending.get());assertEquals(before,privateState(f));
        }
    }

}
