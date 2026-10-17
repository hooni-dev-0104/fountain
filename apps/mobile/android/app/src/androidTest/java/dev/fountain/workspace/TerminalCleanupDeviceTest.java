package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual private SQLite + the SAME production final-delivery predicate used by outboxCall.
 * Synthetic native session/canonical callbacks; no Activity, real Auth or QA source access.
 */
@RunWith(AndroidJUnit4.class)
public class TerminalCleanupDeviceTest {
    interface Action {void run()throws Exception;}
    private static void denied(Action action)throws Exception{try{action.run();fail("Blocked context acquired business authority");}catch(NativeOutbox.AccessRequired|IllegalArgumentException expected){}}
    private static void baseline(ReconcileDeviceTest.Fixture f)throws Exception{JSONObject p=f.call(f.prepare());f.observed("/api/workspace",f.workspace(10,false));JSONObject ready=f.next(p);f.call(f.commit(ready));}
    private static JSONObject intent(ReconcileDeviceTest.Fixture f)throws Exception{
        JSONObject opened=f.open();JSONArray changes=new JSONArray().put(new JSONObject().put("op","put").put("bucket","meta").put("key","revoked:"+f.profile()).put("value",new JSONObject().put("id","revoked:"+f.profile())))
            .put(new JSONObject().put("op","delete").put("bucket","profiles").put("key",f.profile()));
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",changes).toString().getBytes(StandardCharsets.UTF_8);
        JSONObject request=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","terminal-cleanup").put("digest",OutboxPolicy.hash(raw));
        f.outbox.stage(new JSONObject(request.toString()).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)),1);return request;
    }
    @Test public void terminalCleanupAdvancesDataHeadExactlyOnceAndKeepsNegativeFences()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            baseline(f);JSONObject request=intent(f),receipt=f.outbox.commit(request,1,null,false);assertEquals(request.getLong("baseHead")+1,receipt.getLong("head"));assertEquals(receipt.getLong("head"),f.outbox.head());
            assertEquals("blocked",f.outbox.get("identity_state"));assertEquals("1",f.outbox.get("suspended:"+f.profile()));assertTrue(f.outbox.proofEpoch()>request.getLong("proofEpoch"));assertEquals("",f.outbox.get("owner"));assertNotEquals(request.getString("lease"),f.outbox.get("lease"));assertEquals(3,f.count("records"));
        }
    }
    @Test public void ownImmutableTerminalAckCanCrossTheRealFinalDeliveryPredicateWithoutGrantingRead()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            baseline(f);JSONObject request=intent(f);JSObject receipt=f.outbox.commit(request,1,null,false);AtomicInteger evaluated=new AtomicInteger(),released=new AtomicInteger();
            boolean sent=NativeBridgeReply.deliver(new PluginCall(null,"FountainNative","terminal-owned","commitDelta",new JSObject(request.toString())),receipt,()->{try{return f.outbox.deliveryCurrent(request,receipt,1,null,false,f.owner);}catch(Exception rejected){return false;}},new NativeBridgeReply.Destination(){public void evaluate(String script){evaluated.incrementAndGet();}public void release(){released.incrementAndGet();}});
            assertTrue("The production final guard must deliver its own accepted cleanup ACK",sent);assertEquals(1,evaluated.get());assertEquals(1,released.get());assertNull(f.outbox.verified(null,false));assertEquals(request.getLong("proofEpoch"),receipt.getLong("proofEpoch"));
            denied(()->f.outbox.read(new JSONObject().put("generation",1).put("lease",f.outbox.get("lease")).put("head",f.outbox.head()).put("proofEpoch",f.outbox.proofEpoch()).put("cursor",JSONObject.NULL).put("byteLimit",1024),1,null,false));
        }
    }
    @Test public void knownBlockedOpenHasOnlySafeHeaderAndDoesNotClaimOwnerOrExtendAnyRights()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            baseline(f);f.outbox.commit(intent(f),1,null,false);String lease=f.outbox.get("lease"),owner=f.outbox.get("owner"),proof=f.outbox.get("proof_epoch"),grant=f.outbox.get("grant");long head=f.outbox.head();JSONObject opened=f.outbox.open(1,null,false,"different-native-owner");
            assertEquals("blocked",opened.getString("identityState"));assertTrue(opened.isNull("profileId"));assertTrue(opened.isNull("validUntil"));assertEquals("required",opened.getString("resourceAccess"));assertEquals(0,opened.getJSONArray("accessIssues").length());assertEquals(0,opened.getJSONArray("reconciliationHandles").length());assertFalse(opened.getBoolean("accessIssuesTruncated"));
            assertEquals(lease,f.outbox.get("lease"));assertEquals(owner,f.outbox.get("owner"));assertEquals(proof,f.outbox.get("proof_epoch"));assertEquals(grant,f.outbox.get("grant"));assertEquals(head,f.outbox.head());
            denied(()->f.outbox.stage(new JSONObject().put("generation",1).put("lease",lease),1));
            denied(()->f.outbox.commit(new JSONObject().put("generation",1).put("lease",lease),1,null,false));
            denied(()->f.outbox.reconcile(new JSONObject().put("generation",1).put("phase","prepare").put("lease",lease).put("baseHead",head).put("proofEpoch",Long.parseLong(proof)).put("mode","current"),1,null,false,"different-native-owner",0));assertEquals(3,f.count("records"));
        }
    }
    @Test public void lostOwnCleanupAckReplaysAndSettlesMetadataOnlyWhileWrongCapsOrCookieFail()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            baseline(f);JSONObject request=intent(f),accepted=f.outbox.commit(request,1,null,false);long head=f.outbox.head();JSONObject retry=f.outbox.commit(request,1,null,false);assertEquals(accepted.toString(),retry.toString());assertEquals(head,f.outbox.head());
            JSONObject opened=f.outbox.open(1,null,false,"recreated-native-owner"),journal=new JSONObject().put("txId",request.getString("txId")).put("digest",request.getString("digest")).put("baseHead",request.getLong("baseHead")).put("proofEpoch",request.getLong("proofEpoch"));
            JSONObject settled=f.outbox.reconcile(new JSONObject().put("generation",1).put("phase","settle").put("lease",opened.getString("lease")).put("journals",new JSONArray().put(journal)),1,null,false,"recreated-native-owner",0);JSONObject entry=settled.getJSONArray("settlements").getJSONObject(0);assertEquals("accepted",entry.getString("status"));assertEquals(accepted.getLong("head"),entry.getLong("head"));assertEquals(accepted.getLong("proofEpoch"),entry.getLong("proofEpoch"));assertEquals(head,f.outbox.head());
            assertTrue(f.outbox.terminalMetadataCurrent(new JSONObject().put("generation",1).put("phase","settle").put("lease",opened.getString("lease")).put("journals",new JSONArray().put(journal)),settled,1,null,false));
            assertFalse(f.outbox.deliveryCurrent(request,accepted,1,"unrelated-cookie",false,"recreated-native-owner"));assertFalse(f.outbox.deliveryCurrent(request,accepted,1,null,true,"recreated-native-owner"));
            for(String field:new String[]{"baseHead","proofEpoch","lease","txId"}){JSONObject altered=new JSONObject(request.toString());altered.put(field,field.equals("lease")||field.equals("txId")?"unrelated":request.getLong(field)+1);denied(()->f.outbox.commit(altered,1,null,false));}
            JSONObject currentGeneration=new JSONObject(request.toString()).put("generation",2);assertEquals(2,f.outbox.commit(currentGeneration,2,null,false).getLong("generation"));
            JSONObject wrong=new JSONObject(request.toString()).put("digest","0".repeat(64));denied(()->f.outbox.commit(wrong,1,null,false));assertEquals(head,f.outbox.head());assertEquals(3,f.count("records"));
        }
    }
}
