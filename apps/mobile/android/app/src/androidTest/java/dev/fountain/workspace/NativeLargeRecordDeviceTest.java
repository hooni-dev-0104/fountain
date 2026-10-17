package dev.fountain.workspace;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** A real >2MiB record crosses Android CursorWindow size through bounded native parts. */
@RunWith(AndroidJUnit4.class)
public class NativeLargeRecordDeviceTest {
    private static void capture(ReconcileDeviceTest.Fixture f,String version)throws Exception{
        JSONArray blocks=new JSONArray();for(int i=0;i<24;i++)blocks.put(new JSONObject().put("id","large-"+i).put("type","paragraph").put("parent_id",JSONObject.NULL).put("text",version+"x".repeat(100000-version.length())));
        String resource=f.profile()+"|page";JSONObject value=new JSONObject().put("key",resource).put("profileId",f.profile()).put("clientId","large-client").put("draft",new JSONObject().put("epoch","epoch").put("reason","pending").put("blocks",blocks));
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",new JSONArray().put(new JSONObject().put("op","put").put("bucket","drafts").put("key",new JSONArray().put(resource).put("large-client")).put("value",value))).toString().getBytes(StandardCharsets.UTF_8);assertTrue(raw.length>2*1024*1024);assertTrue(raw.length<OutboxPolicy.RECORD);
        JSONObject opened=f.open(),intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","large-"+version).put("digest",OutboxPolicy.hash(raw));
        for(int offset=0,part=0;offset<raw.length;offset+=OutboxPolicy.PART,part++)f.outbox.stage(new JSONObject(intent.toString()).put("part",part).put("bytesBase64",OutboxPolicy.base64(Arrays.copyOfRange(raw,offset,Math.min(raw.length,offset+OutboxPolicy.PART)))),1);
        f.outbox.commit(intent,1,null,false);
    }
    @Test public void boundedPartsKeepLargeCollisionVersionsReadableForFreshPermissionExport()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            capture(f,"first");assertEquals(1,f.open().getJSONArray("reconciliationHandles").length());capture(f,"second");assertEquals(2,f.open().getJSONArray("reconciliationHandles").length());
            f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{if(path.equals("/api/workspace"))return f.workspace(10,false);assertEquals("/api/pages/page/collaboration",path);return f.page(10,0);}};
            try(NativeRecovery recovery=new NativeRecovery(InstrumentationRegistry.getInstrumentation().getTargetContext())){
                recovery.refresh(new NativeRecovery.Session(f.origin,new JSONObject(f.outbox.get("grant")).getJSONObject("session"),null,"large-record-test"));JSONObject inventory=recovery.inventory(null,100,1,authority);assertEquals(1,inventory.getJSONArray("items").length());assertEquals(2,inventory.getJSONArray("items").getJSONObject(0).getInt("recordCount"));
                JSONArray handles=new JSONArray().put(inventory.getJSONArray("items").getJSONObject(0).getString("handle"));JSONObject prepared=recovery.prepare(inventory.getString("inventoryToken"),handles,1,authority);assertEquals(2,prepared.getInt("readyCount"));assertEquals(0,prepared.getInt("blockedCount"));
                NativeRecovery.Prepared result=recovery.saving(inventory.getString("inventoryToken"),prepared.getString("exportToken"),handles,authority);assertEquals(1,result.files.size());assertTrue(result.files.get(0).length()>4*1024*1024);JSONObject exported;
                try(InputStream input=new FileInputStream(result.files.get(0));ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] part=new byte[65536];int n;while((n=input.read(part))!=-1)output.write(part,0,n);exported=new JSONObject(OutboxPolicy.utf8(output.toByteArray()));}
                JSONArray drafts=exported.getJSONArray("drafts");assertEquals(2,drafts.length());boolean first=false,second=false;for(int i=0;i<drafts.length();i++){String text=drafts.getJSONObject(i).getJSONObject("draft").getJSONArray("blocks").getJSONObject(0).getString("text");first|=text.startsWith("first");second|=text.startsWith("second");}assertTrue(first&&second);recovery.finished(result);
            }
        }
    }
}
