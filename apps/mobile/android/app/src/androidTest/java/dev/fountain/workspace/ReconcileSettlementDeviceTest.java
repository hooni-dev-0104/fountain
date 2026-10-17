package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual SQLite connection/owner recreation; OS process restart is tested separately. */
@RunWith(AndroidJUnit4.class)
public class ReconcileSettlementDeviceTest {
    private static JSONObject descriptor(JSONObject ready)throws Exception{return new JSONObject().put("planId",ready.getString("planId")).put("checksum",ready.getString("checksum")).put("lease",ready.getString("lease")).put("baseHead",ready.getLong("baseHead")).put("proofEpoch",ready.getLong("proofEpoch"));}
    private static JSONObject input(JSONObject opened,JSONObject original)throws Exception{return new JSONObject().put("generation",2).put("phase","settle").put("lease",opened.getString("lease")).put("journals",new JSONArray()).put("reconciliations",new JSONArray().put(original));}
    private static JSONObject ready(ReconcileDeviceTest.Fixture f)throws Exception{JSONObject collecting=f.call(f.prepare());f.observed("/api/workspace",f.workspace(10,false));return f.next(collecting);}
    private static String records(ReconcileDeviceTest.Fixture f)throws Exception{StringBuilder material=new StringBuilder();try(Cursor c=f.db.rawQuery("SELECT mode,bucket,key,payload FROM records ORDER BY mode,bucket,key",null)){while(c.moveToNext())material.append(c.getString(0)).append(c.getString(1)).append(c.getString(2)).append(OutboxPolicy.hash(c.getBlob(3)));}return OutboxPolicy.hash(material.toString());}
    @Test public void acceptedMetadataSettlesAfterOwnerRecreationWithoutChangingReadAuthorityOrDeadlines()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject ready=ready(f),accepted=f.call(f.commit(ready));String source=records(f);
            try(NativeOutbox next=new NativeOutbox(InstrumentationRegistry.getInstrumentation().getTargetContext(),f.origin)){
                next.grant(new JSONObject(f.outbox.get("grant")).getJSONObject("session"),null);JSONObject opened=next.open(2,null,false,"new-native-owner");
                String privateGrant=next.get("grant"),privateProof=next.get("resource_proofs");
                assertEquals("ready",opened.getString("resourceAccess"));
                JSONObject settled=next.reconcile(input(opened,descriptor(ready)),2,null,false,"new-native-owner",0),entry=settled.getJSONArray("reconciliations").getJSONObject(0);
                assertEquals(2,settled.getLong("generation"));assertEquals("accepted",entry.getString("status"));assertEquals(accepted.getLong("head"),entry.getLong("head"));assertEquals(accepted.getLong("proofEpoch"),entry.getLong("proofEpoch"));assertEquals(next.canonical(accepted.getJSONObject("receipt"),false),next.canonical(entry.getJSONObject("receipt"),false));assertEquals(source,records(f));
                JSONObject read=new JSONObject().put("generation",2).put("lease",opened.getString("lease")).put("head",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("cursor",JSONObject.NULL).put("byteLimit",1024);
                assertTrue(next.read(read,2,null,false).getJSONArray("fragments").length()>0);
                assertEquals(privateGrant,next.get("grant"));assertEquals(privateProof,next.get("resource_proofs"));
                try{f.call(f.commit(ready));fail("Old owner resumed a commit after recreation");}catch(NativeOutbox.AccessRequired expected){}
                assertEquals(source,records(f));assertEquals(next.canonical(settled,false),next.canonical(next.reconcile(input(opened,descriptor(ready)),2,null,false,"new-native-owner",0),false));
            }
        }
    }
    @Test public void unacceptedRegistryIsFencedAtomicallyAndUnknownCapsPreserveEveryOriginal()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            GrantTransitionDeviceTest.seed(f);JSONObject collecting=f.call(f.prepare());f.observed("/api/workspace",f.workspace(10,true));collecting=f.next(collecting);f.observed("/api/pages/page/collaboration",f.page(10,0));JSONObject ready=f.next(collecting);String source=records(f);
            try(NativeOutbox next=new NativeOutbox(InstrumentationRegistry.getInstrumentation().getTargetContext(),f.origin)){
                next.grant(new JSONObject(f.outbox.get("grant")).getJSONObject("session"),null);JSONObject opened=next.open(2,null,false,"new-native-owner");JSONObject settled=next.reconcile(input(opened,descriptor(ready)),2,null,false,"new-native-owner",0);
                assertEquals("unaccepted",settled.getJSONArray("reconciliations").getJSONObject(0).getString("status"));assertEquals(source,records(f));
                try{f.call(f.commit(ready));fail("Fenced original plan committed later");}catch(NativeOutbox.AccessRequired expected){}
                JSONObject wrong=descriptor(ready).put("checksum","0".repeat(64));
                try{next.reconcile(input(opened,wrong),2,null,false,"new-native-owner",0);fail("Mismatched original caps settled");}catch(NativeReconcile.Failure expected){}
                assertEquals(source,records(f));
            }
        }
    }
}
