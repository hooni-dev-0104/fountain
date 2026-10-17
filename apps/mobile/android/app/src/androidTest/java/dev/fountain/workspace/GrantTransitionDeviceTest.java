package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual Android SQLite; session descriptions/canonical callbacks are synthetic. */
@RunWith(AndroidJUnit4.class)
public class GrantTransitionDeviceTest {
    private static JSONObject scope(ReconcileDeviceTest.Fixture f)throws Exception{
        JSONObject opened=f.open();return new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("head",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("cursor",JSONObject.NULL).put("byteLimit",1024);
    }
    static void seed(ReconcileDeviceTest.Fixture f)throws Exception{
        f.outbox.observe("GET","/api/workspace",200,f.workspace(10,true).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
        f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
        String resource=f.profile()+"|page";
        JSONObject snapshot=new JSONObject().put("key",resource).put("profileId",f.profile()).put("snapshot",f.page(10,0));
        JSONObject draft=new JSONObject().put("key",resource).put("profileId",f.profile()).put("clientId","client").put("draft",new JSONObject().put("epoch","epoch").put("reason","pending").put("text","retain this exact unsent original"));
        JSONArray changes=new JSONArray().put(new JSONObject().put("op","put").put("bucket","snapshots").put("key",resource).put("value",snapshot))
            .put(new JSONObject().put("op","put").put("bucket","drafts").put("key",new JSONArray().put(resource).put("client")).put("value",draft));
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",changes).toString().getBytes(StandardCharsets.UTF_8);
        JSONObject opened=f.open(),intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("proofEpoch",opened.getLong("proofEpoch")).put("baseHead",opened.getLong("head")).put("txId","grant-transition-seed").put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));
        f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
    }
    private static String recordDigest(ReconcileDeviceTest.Fixture f)throws Exception{
        StringBuilder material=new StringBuilder();try(Cursor c=f.db.rawQuery("SELECT mode,bucket,key,payload FROM records ORDER BY mode,bucket,key",null)){while(c.moveToNext())material.append(c.getString(0)).append(c.getString(1)).append(c.getString(2)).append(OutboxPolicy.hash(c.getBlob(3)));}return OutboxPolicy.hash(material.toString());
    }
    @Test public void sameBindingRoleDropImmediatelyFencesOldOwnerProofsWithoutDeletingInput()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f);JSONObject before=scope(f);assertTrue(f.outbox.read(before,1,null,false).getJSONArray("fragments").length()>0);
            String digest=recordDigest(f);long head=f.open().getLong("head"),proof=f.outbox.proofEpoch();
            JSONObject next=new JSONObject(f.outbox.get("grant")).getJSONObject("session");next.getJSONObject("member").put("role","member");f.outbox.grant(next,null);
            assertNull(f.outbox.get("resource_proofs"));assertEquals("1",f.outbox.get("needs_floor"));assertTrue(f.outbox.proofEpoch()>proof);assertEquals(head,f.open().getLong("head"));
            assertEquals(digest,recordDigest(f));assertEquals("required",f.open().getString("resourceAccess"));
            try{f.outbox.read(scope(f),1,null,false);fail("Old owner-derived body escaped after role drop");}catch(NativeOutbox.AccessRequired expected){}
            JSONObject fresh=f.workspace(10,false).put("access_revision",11);f.outbox.observe("GET","/api/workspace",200,fresh.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            try{f.outbox.read(scope(f),1,null,false);fail("Fresh workspace without the private page reauthorized its cache");}catch(NativeOutbox.AccessRequired expected){}
            assertEquals(digest,recordDigest(f));
        }
    }
    @Test public void equivalentOrExtendedActualExpiryDoesNotRewriteLivePrivateSource()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            String cookie="synthetic-current-private-cookie";JSONObject session=new JSONObject().put("authenticated",true).put("required",true).put("mode","accounts").put("workspace_id","workspace").put("cache_binding","new-binding")
                .put("expires_at","2030-01-01T01:00:00.000Z").put("member",new JSONObject().put("id","member").put("role","member").put("active",true));
            f.outbox.grant(session,cookie);f.outbox.open(1,cookie,false,f.owner);String grant=f.outbox.get("grant"),proof=f.outbox.get("proof_epoch"),head=f.outbox.get("head");
            byte[] before;try(FileInputStream in=new FileInputStream(f.file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] part=new byte[65536];int n;while((n=in.read(part))!=-1)out.write(part,0,n);before=out.toByteArray();}
            f.outbox.grant(new JSONObject(session.toString()).put("expires_at","2030-01-01T01:00:00.000+00:00"),cookie);
            f.outbox.grant(new JSONObject(session.toString()).put("expires_at","2030-01-01T02:00:00.000Z"),cookie);
            assertEquals(grant,f.outbox.get("grant"));assertEquals(proof,f.outbox.get("proof_epoch"));assertEquals(head,f.outbox.get("head"));
            try(FileInputStream in=new FileInputStream(f.file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] part=new byte[65536];int n;while((n=in.read(part))!=-1)out.write(part,0,n);assertArrayEquals("No logical or physical SQLite mutation for unchanged live authority",before,out.toByteArray());}
        }
    }
    @Test public void actualFreshSessionRenewsOnlyCacheExpiryAndRequiresCanonicalAtRetainedFloors()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f);JSONObject oldRead=scope(f),session=new JSONObject(f.outbox.get("grant")).getJSONObject("session");String original=recordDigest(f);long head=f.outbox.head();
            f.outbox.set("grant",new JSONObject(f.outbox.get("grant")).put("validUntil",System.currentTimeMillis()-1).toString());
            try{f.outbox.read(oldRead,1,null,false);fail("Expired cache delivered input");}catch(NativeOutbox.AccessRequired expected){}
            assertEquals("expired",f.outbox.get("identity_state"));assertNull(f.outbox.get("suspended:"+f.profile()));assertNull(f.outbox.get("resource_proofs"));assertEquals(head,f.outbox.head());assertEquals(original,recordDigest(f));
            f.outbox.grant(session,null);JSONObject renewed=f.open();assertEquals("verified",renewed.getString("identityState"));assertEquals("required",renewed.getString("resourceAccess"));assertTrue(renewed.getLong("validUntil")>System.currentTimeMillis());assertTrue(renewed.getLong("validUntil")<=System.currentTimeMillis()+OutboxPolicy.LOCAL_TTL);
            try{f.outbox.read(scope(f),1,null,false);fail("Fresh identity alone resurrected old resource rights");}catch(NativeOutbox.AccessRequired expected){}
            JSONObject stale=f.workspace(9,true).put("access_revision",9);try{f.outbox.observe("GET","/api/workspace",200,stale.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);fail("Expiry reset monotonic global counter floors");}catch(NativeOutbox.AccessRequired expected){}
            f.outbox.observe("GET","/api/workspace",200,f.workspace(10,true).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);try{f.outbox.read(scope(f),1,null,false);fail("Fresh workspace alone restored old document proof");}catch(NativeOutbox.AccessRequired expected){}
            f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);assertTrue(f.outbox.read(scope(f),1,null,false).getJSONArray("fragments").length()>0);assertEquals(original,recordDigest(f));
            f.outbox.revoke();try{f.outbox.grant(session,null);fail("Explicit revocation was renewed as cache expiry");}catch(NativeOutbox.RecoveryRequired expected){}assertEquals(original,recordDigest(f));
        }
    }

    @Test public void invalidUnicodeCannotBeNormalizedIntoAnAcceptedQuarantineCopy()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            String resource=f.profile()+"|page",encoded="{\"version\":1,\"origin\":"+JSONObject.quote(f.origin)+",\"mode\":\"quarantine\",\"changes\":[{\"op\":\"put\",\"bucket\":\"drafts\",\"key\":["+JSONObject.quote(resource)+",\"unicode\"],\"value\":{\"key\":"+JSONObject.quote(resource)+",\"profileId\":"+JSONObject.quote(f.profile())+",\"clientId\":\"unicode\",\"draft\":{\"reason\":\"pending\",\"text\":\"\\ud800\"}}}]}";
            byte[] raw=encoded.getBytes(StandardCharsets.UTF_8);JSONObject opened=f.open(),intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","invalid-unicode").put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.outbox.stage(intent,1);
            try{f.outbox.commit(intent,1,null,false);fail("Malformed surrogate became a replacement character in accepted input");}catch(IllegalArgumentException expected){}
            assertEquals(opened.getLong("head"),f.outbox.head());assertEquals(0,f.count("records"));assertEquals(0,f.count("tx_receipts"));try(Cursor c=f.db.rawQuery("SELECT data FROM staging WHERE tx_id='invalid-unicode'",null)){assertTrue(c.moveToFirst());assertArrayEquals(raw,c.getBlob(0));}
        }
    }

}
