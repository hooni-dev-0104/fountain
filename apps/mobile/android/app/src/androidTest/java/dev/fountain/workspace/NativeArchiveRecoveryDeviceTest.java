package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Production commit/archive/read-only export with actual SQLite and synthetic HTTP authority. */
@RunWith(AndroidJUnit4.class)
public class NativeArchiveRecoveryDeviceTest {
    private static JSONObject draft(String profile,String label,String text)throws Exception{
        return new JSONObject().put("key",profile+"|page").put("profileId",profile).put("clientId",label).put("draft",new JSONObject().put("epoch","epoch").put("reason","pending").put("blocks",new JSONArray().put(new JSONObject().put("id","paragraph").put("type","paragraph").put("parent_id",JSONObject.NULL).put("text",text))));
    }
    private static void capture(ReconcileDeviceTest.Fixture f,JSONObject value)throws Exception{
        JSONArray key=new JSONArray().put(value.getString("key")).put(value.getString("clientId"));
        JSONObject delta=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",new JSONArray().put(new JSONObject().put("op","put").put("bucket","drafts").put("key",key).put("value",value)));
        byte[] raw=delta.toString().getBytes(StandardCharsets.UTF_8);JSONObject opened=f.open();JSONObject intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId",UUID.randomUUID().toString()).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));
        f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
    }
    private static String bytes(File file)throws Exception{
        try(InputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] part=new byte[65536];int n;while((n=in.read(part))!=-1)out.write(part,0,n);return OutboxPolicy.hash(out.toByteArray());}
    }
    private static JSONObject read(File file)throws Exception{
        try(InputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] part=new byte[65536];int n;while((n=in.read(part))!=-1)out.write(part,0,n);return new JSONObject(OutboxPolicy.utf8(out.toByteArray()));}
    }
    private static void observed(ReconcileDeviceTest.Fixture f)throws Exception{f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);}
    private static NativeRecovery.Authority authority(ReconcileDeviceTest.Fixture f,boolean allowed){return new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{if(path.equals("/api/workspace"))return f.workspace(10,false);if(!allowed)throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED");assertEquals("/api/pages/page/collaboration",path);return f.page(10,0);}};}
    private static NativeRecovery recovery(ReconcileDeviceTest.Fixture f)throws Exception{
        NativeRecovery result=new NativeRecovery(InstrumentationRegistry.getInstrumentation().getTargetContext());result.refresh(new NativeRecovery.Session(f.origin,new JSONObject(f.outbox.get("grant")).getJSONObject("session"),null,"component-owner"));return result;
    }
    private static JSONArray selection(JSONObject inventory)throws Exception{assertEquals(1,inventory.getJSONArray("items").length());return new JSONArray().put(inventory.getJSONArray("items").getJSONObject(0).getString("handle"));}
    @Test public void collisionPreservesAndExportsBothPrivatelyCapturedVersionsWithoutExposingUnknownSources()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject first=draft(f.profile(),"same-client","first exact family draft 🏠"),second=draft(f.profile(),"same-client","second exact family draft 🐈");capture(f,first);capture(f,second);
            String foreign=OutboxPolicy.profile(f.origin,"workspace","another-member","binding");capture(f,draft(foreign,"foreign-claim","opaque claimed foreign content"));
            JSONObject unknown=draft(f.profile(),"unknown","unknown same-claimed-actor bytes");f.db.execSQL("INSERT INTO records VALUES('quarantine','drafts',?,?,?,?)",new Object[]{new JSONArray().put(unknown.getString("key")).put("unknown").toString(),f.profile(),unknown.getString("key"),unknown.toString().getBytes(StandardCharsets.UTF_8)});
            observed(f);String before=bytes(f.file);NativeRecovery.Authority authority=authority(f,true);
            try(NativeRecovery recovery=recovery(f)){
                JSONObject inventory=recovery.inventory(null,100,1,authority);JSONArray selected=selection(inventory);assertEquals(2,inventory.getJSONArray("items").getJSONObject(0).getInt("recordCount"));assertFalse(inventory.toString().contains("draft"));
                JSONObject prepared=recovery.prepare(inventory.getString("inventoryToken"),selected,1,authority);assertEquals(2,prepared.getInt("readyCount"));assertEquals(0,prepared.getInt("blockedCount"));assertEquals(1,prepared.getJSONArray("files").length());
                NativeRecovery.Prepared saved=recovery.saving(inventory.getString("inventoryToken"),prepared.getString("exportToken"),selected,authority);JSONObject output=read(saved.files.get(0));assertEquals("fountain-recovery-v2",output.getString("format"));assertEquals(2,output.getJSONArray("drafts").length());
                String exported=output.toString();assertTrue(exported.contains("first exact family draft"));assertTrue(exported.contains("second exact family draft"));assertFalse(exported.contains("opaque claimed foreign"));assertFalse(exported.contains("unknown same-claimed"));assertEquals(before,bytes(f.file));recovery.finished(saved);
                try(Cursor archive=f.db.rawQuery("SELECT r.payload FROM recovery r JOIN native_recovery_records a ON a.id=r.id",null)){assertTrue(archive.moveToFirst());assertArrayEquals(second.toString().getBytes(StandardCharsets.UTF_8),archive.getBlob(0));assertFalse(archive.moveToNext());}
            }
        }
    }
    @Test public void changedUnattributedBytesStayOpaqueAndPreservedInsteadOfInheritingHistoricalCapture()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject original=draft(f.profile(),"same-client","actual captured version");capture(f,original);JSONObject changed=draft(f.profile(),"same-client","unattributed replacement bytes");byte[] raw=changed.toString().getBytes(StandardCharsets.UTF_8);
            f.db.execSQL("UPDATE records SET payload=? WHERE mode='quarantine'",new Object[]{raw});String before=bytes(f.file);assertEquals(0,f.open().getJSONArray("reconciliationHandles").length());
            try(NativeRecovery recovery=recovery(f)){assertEquals(0,recovery.inventory(null,100,1,authority(f,true)).getJSONArray("items").length());}
            try(Cursor source=f.db.rawQuery("SELECT payload FROM records WHERE mode='quarantine'",null)){assertTrue(source.moveToFirst());assertArrayEquals(raw,source.getBlob(0));}assertEquals(before,bytes(f.file));
        }
    }
    @Test public void deniedFreshResourceAuthorityBlocksExportAndPreservesAllOriginalBytes()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            capture(f,draft(f.profile(),"same-client","first retained version"));capture(f,draft(f.profile(),"same-client","second retained version"));String before=bytes(f.file);
            try(NativeRecovery recovery=recovery(f)){
                NativeRecovery.Authority denied=authority(f,false);JSONObject inventory=recovery.inventory(null,100,1,denied);JSONObject prepared=recovery.prepare(inventory.getString("inventoryToken"),selection(inventory),1,denied);
                assertEquals(0,prepared.getInt("readyCount"));assertEquals(2,prepared.getInt("blockedCount"));assertEquals(0,prepared.getJSONArray("files").length());assertEquals(before,bytes(f.file));
            }
        }
    }
}
