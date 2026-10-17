package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual private SQLite owner recreation, with synthetic native session callbacks. */
@RunWith(AndroidJUnit4.class)
public class OfflineOwnershipDeviceTest {
    private static JSONObject read(JSONObject opened)throws Exception{return new JSONObject().put("generation",2).put("lease",opened.getString("lease")).put("head",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("cursor",JSONObject.NULL).put("byteLimit",1024);}
    private static String source(ReconcileDeviceTest.Fixture f)throws Exception{StringBuilder bytes=new StringBuilder();try(Cursor c=f.db.rawQuery("SELECT mode,bucket,key,payload FROM records ORDER BY mode,bucket,key",null)){while(c.moveToNext())bytes.append(c.getString(0)).append(c.getString(1)).append(c.getString(2)).append(OutboxPolicy.hash(c.getBlob(3)));}return OutboxPolicy.hash(bytes.toString());}
    @Test public void liveSamePrivateBindingTransfersOwnerWithoutRenewingAnyRightsOrChangingInput()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            GrantTransitionDeviceTest.seed(f);JSONObject old=f.open();String before=source(f),grant=f.outbox.get("grant");JSONObject ledger=new JSONObject(f.outbox.get("resource_proofs"));
            try(NativeOutbox next=new NativeOutbox(InstrumentationRegistry.getInstrumentation().getTargetContext(),f.origin)){
                JSONObject opened=next.open(2,null,false,"recreated-native-owner");assertEquals("ready",opened.getString("resourceAccess"));assertNotEquals(old.getString("lease"),opened.getString("lease"));assertTrue(opened.getLong("proofEpoch")>old.getLong("proofEpoch"));assertFalse("Queued former-owner delivery must check private SQL owner",f.outbox.currentOwner(f.owner));assertTrue(next.currentOwner("recreated-native-owner"));
                assertEquals(grant,next.get("grant"));JSONObject transferred=new JSONObject(next.get("resource_proofs"));assertEquals("recreated-native-owner",transferred.getString("owner"));assertEquals(next.canonical(ledger.getJSONObject("entries"),false),next.canonical(transferred.getJSONObject("entries"),false));assertEquals(ledger.getLong("maxAccessRevision"),transferred.getLong("maxAccessRevision"));assertEquals(ledger.getLong("maxDataRevision"),transferred.getLong("maxDataRevision"));
                assertTrue(next.read(read(opened),2,null,false).getJSONArray("fragments").length()>0);assertEquals(before,source(f));
                String privateProof=next.get("resource_proofs");JSONObject journal;
                try(Cursor c=f.db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id='grant-transition-seed'",null)){assertTrue(c.moveToFirst());journal=new JSONObject().put("txId","grant-transition-seed").put("digest",c.getString(0)).put("baseHead",c.getLong(1)-1).put("proofEpoch",Long.parseLong(next.get("receipt-proof:grant-transition-seed")));}
                JSONObject settlement=next.reconcile(new JSONObject().put("generation",2).put("phase","settle").put("lease",opened.getString("lease")).put("journals",new JSONArray().put(journal)),2,null,false,"recreated-native-owner",0);
                assertEquals("accepted",settlement.getJSONArray("settlements").getJSONObject(0).getString("status"));assertEquals(grant,next.get("grant"));assertEquals(privateProof,next.get("resource_proofs"));assertEquals(before,source(f));
                try{f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),null,false,f.owner);fail("Late former owner changed private proof state");}catch(NativeOutbox.AccessRequired expected){}
                try{f.outbox.admitReconcile(1,"POST","/api/sync",null,false,f.owner);fail("Former owner admitted a new native write");}catch(NativeOutbox.AccessRequired expected){}
                assertEquals(privateProof,next.get("resource_proofs"));assertEquals(grant,next.get("grant"));
            }
        }
    }
    @Test public void roleDropOrUnknownCookieCannotTransferFormerOwnerAuthority()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            GrantTransitionDeviceTest.seed(f);String before=source(f);
            try(NativeOutbox next=new NativeOutbox(InstrumentationRegistry.getInstrumentation().getTargetContext(),f.origin)){
                JSONObject unknown=next.open(2,"unrelated-cookie",false,"recreated-native-owner");assertEquals("unknown",unknown.getString("identityState"));assertTrue(unknown.isNull("profileId"));
                try{next.read(read(unknown),2,"unrelated-cookie",false);fail("Unknown cookie transferred cached rights");}catch(NativeOutbox.AccessRequired expected){}
                JSONObject session=new JSONObject(next.get("grant")).getJSONObject("session");session.getJSONObject("member").put("role","guest");next.grant(session,null);JSONObject opened=next.open(2,null,false,"recreated-native-owner");assertEquals("required",opened.getString("resourceAccess"));assertNull(next.get("resource_proofs"));
                try{next.read(read(opened),2,null,false);fail("Role drop transferred cached owner rights");}catch(NativeOutbox.AccessRequired expected){}assertEquals(before,source(f));
            }
        }
    }
}
