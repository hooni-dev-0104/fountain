package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android SQLite with synthetic native admission/HTTP callbacks. */
@RunWith(AndroidJUnit4.class)
public class SyncReceiptDeviceTest {
    private static JSONObject operation()throws Exception{return new JSONObject().put("id","create-receipt").put("kind","page.create").put("target_id","new-page")
        .put("document_epoch","11111111-1111-4111-8111-111111111111").put("body",new JSONObject().put("id","new-page").put("title","Local page").put("parent_id",JSONObject.NULL).put("teamspace_id","general")).put("depends_on",new JSONArray());}
    private static byte[] request(JSONObject... operations)throws Exception{JSONArray list=new JSONArray();for(JSONObject op:operations)list.put(op);return new JSONObject().put("workspace_id","workspace").put("session_binding","binding").put("operations",list).toString().getBytes(StandardCharsets.UTF_8);}
    private static JSONObject result(JSONObject operation)throws Exception{return new JSONObject().put("id",operation.getString("id")).put("status","applied").put("http_status",201).put("resource_id",operation.getString("target_id")).put("data_revision",18);}
    private static byte[] response(JSONObject... results)throws Exception{JSONArray list=new JSONArray();for(JSONObject result:results)list.put(result);return new JSONObject().put("workspace_id","workspace").put("current_member_id","member").put("session_binding","binding").put("data_revision",20).put("results",list).toString().getBytes(StandardCharsets.UTF_8);}
    private static long count(ReconcileDeviceTest.Fixture f)throws Exception{try(Cursor c=f.db.rawQuery("SELECT count(*) FROM native_sync_receipts",null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private static void seed(ReconcileDeviceTest.Fixture f,JSONObject operation)throws Exception{
        f.outbox.observe("GET","/api/workspace",200,f.workspace(10,true).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
        f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
        String resource=f.profile()+"|new-page",epoch=operation.getString("document_epoch");JSONObject page=new JSONObject(operation.getJSONObject("body").toString()).put("access_level",4).put("locked",false).put("archived",false).put("owner_id","member").put("revision",0).put("blocks",new JSONArray());
        JSONObject snapshot=f.envelope(0).put("epoch",epoch).put("seq",0).put("access_level",4).put("page",page).put("blocks",new JSONArray()).put("state",new JSONObject().put("version",1).put("max_clock",0).put("blocks",new JSONObject()).put("seen",new JSONObject()));
        JSONArray changes=new JSONArray().put(new JSONObject().put("op","put").put("bucket","snapshots").put("key",resource).put("value",new JSONObject().put("key",resource).put("profileId",f.profile()).put("snapshot",snapshot)))
            .put(new JSONObject().put("op","put").put("bucket","localPages").put("key",resource).put("value",new JSONObject().put("key",resource).put("resourceKey",resource).put("profileId",f.profile()).put("metadata",new JSONObject().put("page",page).put("initial_epoch",epoch).put("create_operation_id",operation.getString("id")).put("localOnly",true))))
            .put(new JSONObject().put("op","put").put("bucket","mutations").put("key",new JSONArray().put(f.profile()).put(operation.getString("id"))).put("value",new JSONObject().put("profileId",f.profile()).put("id",operation.getString("id")).put("resourceKey",resource).put("operation",operation).put("status","pending").put("sequence",1)));
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",changes).toString().getBytes(StandardCharsets.UTF_8);JSONObject opened=f.open();
        JSONObject intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId",UUID.randomUUID().toString()).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
    }
    @Test public void exactAdmittedDuplicatesAndReorderedServerJSONRemainOneImmutableReceipt()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject op=operation(),accepted=result(op);String proof=f.outbox.get("resource_proofs");
            NativeSyncReceipts.Admission tag=f.outbox.admitSync("POST","/api/sync",request(op,op),null,false,f.owner);f.outbox.observeSync(tag,200,response(accepted,accepted),null,false,f.owner);assertEquals(1,count(f));
            JSONObject reordered=new JSONObject().put("data_revision",18).put("resource_id","new-page").put("http_status",201).put("status","applied").put("id","create-receipt");
            f.outbox.observeSync(tag,200,response(reordered,reordered),null,false,f.owner);assertEquals(1,count(f));assertEquals(proof,f.outbox.get("resource_proofs"));
            JSONObject grant=f.outbox.verified(null,false);assertNotNull(f.outbox.appliedSync(grant,op));JSONObject changed=new JSONObject(op.toString());changed.getJSONObject("body").put("title","different payload");assertNull(f.outbox.appliedSync(grant,changed));
        }
    }
    @Test public void absentAdmissionFailuresAndForeignScopeCannotMintSyncEvidence()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject op=operation();assertNull(f.outbox.admitSync("POST","/api/sync?",request(op),null,false,f.owner));f.outbox.observeSync(null,200,response(result(op)),null,false,f.owner);
            NativeSyncReceipts.Admission tag=f.outbox.admitSync("POST","/api/sync",request(op),null,false,f.owner);for(int status:new int[]{201,400,401,403,404,409,500})f.outbox.observeSync(tag,status,new byte[0],null,false,f.owner);assertEquals(0,count(f));
            JSONObject foreign=new JSONObject(OutboxPolicy.utf8(response(result(op)))).put("session_binding","foreign");try{f.outbox.observeSync(tag,200,foreign.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);fail("Foreign binding minted an applied marker");}catch(NativeReconcile.Failure expected){}
            try{f.outbox.observeSync(tag,200,response(result(op)),"other-private-cookie",false,f.owner);fail("Another cookie minted an applied marker");}catch(NativeOutbox.AccessRequired expected){}assertEquals(0,count(f));assertNull(f.outbox.get("resource_proofs"));
        }
    }
    @Test public void malformedSecondResultCannotPartiallyPersistFirstReceipt()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject first=operation(),second=new JSONObject(operation().toString()).put("id","second-create");NativeSyncReceipts.Admission tag=f.outbox.admitSync("POST","/api/sync",request(first,second),null,false,f.owner);
            try{f.outbox.observeSync(tag,200,response(result(first),result(second).put("resource_id","wrong-resource")),null,false,f.owner);fail("Partially validated batch persisted");}catch(NativeReconcile.Failure expected){}assertEquals(0,count(f));
        }
    }
    @Test public void lostRendererCreateAckUsesRealCanonicalBodyAndPrivateMarkerBeforeClearingLocalOnly()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject op=operation();seed(f,op);NativeSyncReceipts.Admission tag=f.outbox.admitSync("POST","/api/sync",request(op),null,false,f.owner);f.outbox.observeSync(tag,200,response(result(op)),null,false,f.owner);
            assertNull("Sync receipt cannot become a general page proof",new JSONObject(f.outbox.get("resource_proofs")).getJSONObject("entries").optJSONObject("page:new-page"));
            JSONObject collecting=f.call(f.prepare()),workspace=f.workspace(20,true),canonical=f.page(20,0).put("epoch",op.getString("document_epoch"));canonical.getJSONObject("page").put("id","new-page").put("title","Actual server canonical");
            workspace.getJSONArray("pages").put(canonical.getJSONObject("page"));f.observed("/api/workspace",workspace);collecting=f.next(collecting);f.observed("/api/pages/page/collaboration",f.page(20,0));f.observed("/api/pages/new-page/collaboration",canonical);JSONObject ready=f.next(collecting);assertEquals("ready",ready.getString("state"));f.call(f.commit(ready));
            try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='localPages' AND profile_id=?",new String[]{f.profile()})){assertTrue(c.moveToFirst());JSONObject metadata=new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("metadata");assertFalse(metadata.getBoolean("localOnly"));assertEquals("Actual server canonical",metadata.getJSONObject("page").getString("title"));assertEquals(op.getString("id"),metadata.getJSONObject("creation_result").getString("id"));}
            try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='mutations' AND profile_id=?",new String[]{f.profile()})){assertTrue(c.moveToFirst());JSONObject retained=new JSONObject(OutboxPolicy.utf8(c.getBlob(0)));assertEquals("pending",retained.getString("status"));assertEquals(f.outbox.canonical(op,false),f.outbox.canonical(retained.getJSONObject("operation"),false));}
        }
    }
    @Test public void roleChangeCannotReuseOldAdmissionAfterTheSameNativeOwnerReopens()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject op=operation();NativeSyncReceipts.Admission admitted=f.outbox.admitSync("POST","/api/sync",request(op),null,false,f.owner);String old=f.open().getString("lease");
            JSONObject actual=new JSONObject(f.outbox.get("grant")).getJSONObject("session");actual.getJSONObject("member").put("role","guest");f.outbox.grant(actual,null);assertNotEquals(old,f.open().getString("lease"));
            try{f.outbox.observeSync(admitted,200,response(result(op)),null,false,f.owner);fail("Old private admission survived a role/lease boundary");}catch(NativeOutbox.AccessRequired expected){}assertEquals(0,count(f));assertNull(f.outbox.get("resource_proofs"));
        }
    }

}
