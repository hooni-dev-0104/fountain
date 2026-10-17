package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit untrusted upgrade: actual native capture, collector and SQLite transform. */
@RunWith(AndroidJUnit4.class)
public class PromotionProjectionDeviceTest {
    private static JSONObject operation(String id,String kind,String target,JSONObject body,String... edges)throws Exception{
        JSONArray dependencies=new JSONArray();for(String edge:edges)dependencies.put(edge);return new JSONObject().put("id",id).put("kind",kind).put("target_id",target).put("body",body).put("depends_on",dependencies);
    }
    private static void capture(ReconcileDeviceTest.Fixture f,JSONObject... operations)throws Exception{
        JSONArray changes=new JSONArray();for(JSONObject operation:operations){String resource=f.profile()+(operation.getString("kind").startsWith("row.")?"|database|db":"|page");String id=operation.getString("id");changes.put(new JSONObject().put("op","put").put("bucket","mutations").put("key",new JSONArray().put(f.profile()).put(id)).put("value",new JSONObject().put("profileId",f.profile()).put("resourceKey",resource).put("id",id).put("operation",operation).put("status","pending").put("sequence",changes.length()+1)));}
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",changes).toString().getBytes(StandardCharsets.UTF_8);JSONObject opened=f.open();JSONObject intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","projection-source").put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
    }
    private static JSONObject upgrade(ReconcileDeviceTest.Fixture f)throws Exception{
        JSONObject opened=f.open();JSONArray handles=opened.getJSONArray("reconciliationHandles"),selected=new JSONArray();assertTrue(handles.length()>0);for(int i=0;i<handles.length();i++){assertEquals("upgrade",handles.getJSONObject(i).getString("kind"));selected.put(handles.getJSONObject(i).getString("handle"));}return f.call(f.prepare().put("mode","upgrade").put("handles",selected));
    }
    private static JSONArray mutations(ReconcileDeviceTest.Fixture f)throws Exception{
        JSONArray result=new JSONArray();try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='mutations' ORDER BY key",null)){while(c.moveToNext())result.put(new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("operation"));}return result;
    }
    @Test public void sequentialPagePatchesUseProjectedFreshPredecessorValues()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject first=operation("first-patch","page.patch","page",new JSONObject().put("title","first")),second=operation("second-patch","page.patch","page",new JSONObject().put("title","second"),"first-patch");capture(f,first,second);
            JSONObject collecting=upgrade(f);f.observed("/api/workspace",f.workspace(10,true));collecting=f.next(collecting);JSONObject canonical=f.page(10,0);canonical.getJSONObject("page").put("title","fresh current");f.observed("/api/pages/page/collaboration",canonical);JSONObject ready=f.next(collecting);assertEquals(2,ready.getJSONObject("counts").getInt("import"));f.call(f.commit(ready));
            JSONArray imported=mutations(f);assertEquals(2,imported.length());for(int i=0;i<imported.length();i++){JSONObject operation=imported.getJSONObject(i);assertNotEquals("first-patch",operation.getString("id"));assertNotEquals("second-patch",operation.getString("id"));assertEquals(operation.getJSONObject("body").getString("title").equals("first")?"fresh current":"first",operation.getJSONObject("base").getJSONObject("fields").getString("title"));}
        }
    }
    @Test public void rowDeleteUsesWholeFreshVirtualSubtreeAndLatestPromotedReceipts()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject schema=new JSONObject().put("id","title").put("name","Name").put("type","title");
            JSONObject create=operation("create-child","row.create","old-local-child",new JSONObject().put("id","old-local-child").put("parent_row_id","root").put("properties",new JSONObject().put("title","new child"))).put("database_id","db");
            JSONObject first=operation("first-patch","row.patch","root",new JSONObject().put("properties",new JSONObject().put("title","first"))).put("database_id","db");
            JSONObject second=operation("second-patch","row.patch","root",new JSONObject().put("properties",new JSONObject().put("title","second")),"first-patch").put("database_id","db");
            JSONObject delete=operation("delete-subtree","row.delete","root",new JSONObject(),"second-patch","create-child").put("database_id","db").put("base_rows",new JSONObject().put("root",new JSONObject().put("updated_at","2000-01-01T00:00:00Z").put("after_operation","second-patch")).put("fresh-child",new JSONObject().put("updated_at","2000-01-01T00:00:00Z")).put("old-local-child",new JSONObject().put("updated_at","1970-01-01T00:00:00Z").put("after_operation","create-child")));
            capture(f,create,first,second,delete);JSONObject collecting=upgrade(f),workspace=f.workspace(10,false);workspace.getJSONArray("databases").put(new JSONObject().put("id","db").put("access_level",4));f.observed("/api/workspace",workspace);collecting=f.next(collecting);
            JSONArray rows=new JSONArray();for(String id:new String[]{"root","fresh-child"})rows.put(new JSONObject().put("id",id).put("database_id","db").put("parent_row_id",id.equals("root")?JSONObject.NULL:"root").put("depends_on",new JSONArray()).put("properties",new JSONObject().put("title",id.equals("root")?"fresh current":"fresh child")).put("access_level",4).put("updated_at","2026-10-17T00:00:00Z"));
            JSONObject database=f.envelope(10).put("database",new JSONObject().put("id","db").put("access_level",4).put("can_create_row",true).put("properties",new JSONArray().put(schema))).put("rows",rows);f.observed("/api/databases/db",database);JSONObject ready=f.next(collecting);assertEquals(4,ready.getJSONObject("counts").getInt("import"));f.call(f.commit(ready));
            JSONArray imported=mutations(f);assertEquals(4,imported.length());JSONObject deletion=null;String latestRoot=null,createdChild=null,creationID=null;
            for(int i=0;i<imported.length();i++){JSONObject op=imported.getJSONObject(i);if(op.getString("kind").equals("row.delete"))deletion=op;if(op.getString("kind").equals("row.create")){createdChild=op.getString("target_id");creationID=op.getString("id");assertNotEquals("old-local-child",createdChild);}if(op.getString("kind").equals("row.patch")){String value=op.getJSONObject("body").getJSONObject("properties").getString("title");assertEquals(value.equals("first")?"fresh current":"first",op.getJSONObject("base").getJSONObject("properties").getString("title"));if(value.equals("second"))latestRoot=op.getString("id");}}
            assertNotNull(deletion);JSONObject bases=deletion.getJSONObject("base_rows");assertEquals(3,bases.length());assertEquals(latestRoot,bases.getJSONObject("root").getString("after_operation"));assertEquals(creationID,bases.getJSONObject(createdChild).getString("after_operation"));assertFalse(bases.getJSONObject("fresh-child").has("after_operation"));assertEquals("2026-10-17T00:00:00Z",bases.getJSONObject("fresh-child").getString("updated_at"));
        }
    }
    @Test public void newlyAppearedCanonicalChildCannotBroadenOriginalDeleteSelection()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject delete=operation("delete-root-only","row.delete","root",new JSONObject()).put("database_id","db").put("base_rows",new JSONObject().put("root",new JSONObject().put("updated_at","2000-01-01T00:00:00Z")));capture(f,delete);
            byte[] original;try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='quarantine'",null)){assertTrue(c.moveToFirst());original=c.getBlob(0);}
            JSONObject collecting=upgrade(f),workspace=f.workspace(10,false);workspace.getJSONArray("databases").put(new JSONObject().put("id","db").put("access_level",4));f.observed("/api/workspace",workspace);collecting=f.next(collecting);
            JSONArray rows=new JSONArray();for(String id:new String[]{"root","unselected-new-child"})rows.put(new JSONObject().put("id",id).put("database_id","db").put("parent_row_id",id.equals("root")?JSONObject.NULL:"root").put("depends_on",new JSONArray()).put("properties",new JSONObject()).put("access_level",4).put("updated_at","2026-10-17T00:00:00Z"));
            f.observed("/api/databases/db",f.envelope(10).put("database",new JSONObject().put("id","db").put("access_level",4).put("can_create_row",true).put("properties",new JSONArray())).put("rows",rows));
            try{f.next(collecting);fail("A new current descendant silently broadened the old deletion");}catch(NativeReconcile.Failure expected){assertEquals("OUTBOX_RECONCILE_UNSUPPORTED_INPUT",expected.code);}
            assertEquals(0,mutations(f).length());try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='quarantine'",null)){assertTrue(c.moveToFirst());assertArrayEquals(original,c.getBlob(0));assertFalse(c.moveToNext());}
        }
    }
    private static void captureBody(ReconcileDeviceTest.Fixture f,String label,int... sizes)throws Exception{captureBodyAt(f,"page",label,System.currentTimeMillis(),sizes);}
    private static void captureBodyAt(ReconcileDeviceTest.Fixture f,String target,String label,long timestamp,int... sizes)throws Exception{
        JSONArray blocks=new JSONArray();for(int i=0;i<sizes.length;i++)blocks.put(new JSONObject().put("id",label+"-block-"+i).put("type","paragraph").put("parent_id",JSONObject.NULL).put("text","x".repeat(sizes[i])));
        captureBlocks(f,target,label,timestamp,blocks);
    }
    private static void captureBlocks(ReconcileDeviceTest.Fixture f,String target,String label,long timestamp,JSONArray blocks)throws Exception{
        String resource=f.profile()+"|"+target;JSONObject value=new JSONObject().put("key",resource).put("profileId",f.profile()).put("clientId",label).put("updatedAt",timestamp).put("draft",new JSONObject().put("epoch","old-epoch").put("reason","pending").put("blocks",blocks));
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",new JSONArray().put(new JSONObject().put("op","put").put("bucket","drafts").put("key",new JSONArray().put(resource).put(label)).put("value",value))).toString().getBytes(StandardCharsets.UTF_8);
        JSONObject opened=f.open(),intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","body-source-"+label).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
    }
    private static JSONObject unsupportedBody(ReconcileDeviceTest.Fixture f,JSONObject collecting)throws Exception{JSONObject ready=f.next(collecting);assertEquals("ready",ready.getString("state"));assertEquals(0,ready.getJSONObject("counts").getInt("import"));boolean reason=false;JSONArray reasons=ready.getJSONArray("reasons");for(int i=0;i<reasons.length();i++)reason|="unsupported_input".equals(reasons.getString(i));assertTrue(reason);return ready;}
    private static void backendOracle(ReconcileDeviceTest.Fixture f,String label,JSONArray expected)throws Exception{
        JSONArray operations=new JSONArray();try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='operations' ORDER BY rowid",null)){while(c.moveToNext()){JSONObject operation=new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("operation");operation.remove("_epoch");operations.put(operation);}}
        JSONObject fixture=new JSONObject().put("label",label).put("operations",operations).put("expected",expected);
        java.io.File directory=new java.io.File(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),"native-body-oracles");assertTrue(directory.isDirectory()||directory.mkdir());java.io.File output=new java.io.File(directory,label+".json");
        try(java.io.FileOutputStream stream=new java.io.FileOutputStream(output)){stream.write(fixture.toString().getBytes(StandardCharsets.UTF_8));stream.getFD().sync();}
    }
    private static JSONObject collectBody(ReconcileDeviceTest.Fixture f)throws Exception{
        JSONObject collecting=upgrade(f),workspace=f.workspace(10,true),other=f.page(10,0);other.getJSONObject("page").put("id","page-other");workspace.getJSONArray("pages").put(other.getJSONObject("page"));f.observed("/api/workspace",workspace);collecting=f.next(collecting);
        JSONArray needed=collecting.getJSONArray("needed");for(int i=0;i<needed.length();i++){String target=needed.getJSONObject(i).getString("id");JSONObject body=f.page(10,0);body.getJSONObject("page").put("id",target);f.observed("/api/pages/"+target+"/collaboration",body);}return collecting;
    }
    @Test public void exactlyFiftyThousandBodyCodepointsCanPrepareAndCommitWithoutHistoricalReplay()throws Exception{
        for(int variant=0;variant<2;variant++)try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONArray blocks=new JSONArray();for(int i=0;i<(variant==0?1:2);i++)blocks.put(new JSONObject().put("id","limit-source-"+i).put("type","paragraph").put("parent_id",JSONObject.NULL).put("text","x".repeat(variant==0?50000:25000)));
            captureBlocks(f,"page","exact-limit",1000,blocks);JSONObject ready=f.next(collectBody(f));assertEquals(variant==0?3:5,ready.getJSONObject("counts").getInt("import"));f.call(f.commit(ready));backendOracle(f,variant==0?"plain-50000":"aggregate-50000",blocks);
            try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='operations'",null)){int text=0;while(c.moveToNext()){JSONObject op=new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("operation");if(op.getString("type").equals("text.insert"))text+=op.getString("text").codePointCount(0,op.getString("text").length());}assertEquals(50000,text);}
        }
    }
    @Test public void oversizedSingleBlockMultipleBlocksAndSelectedBodiesStayArchivedWithoutPartialImport()throws Exception{
        for(int variant=0;variant<3;variant++)try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            if(variant==0)captureBody(f,"oversized",50001);else if(variant==1)captureBody(f,"aggregate-blocks",30000,20001);else{captureBody(f,"aggregate-first",30000);captureBodyAt(f,"page-other","aggregate-second",System.currentTimeMillis(),20001);}
            JSONObject collecting=collectBody(f);long head=f.outbox.head();long prior=f.count("records");
            unsupportedBody(f,collecting);
            assertEquals(head,f.outbox.head());assertEquals(prior,f.count("records"));assertEquals(0,mutations(f).length());try(Cursor c=f.db.rawQuery("SELECT count(*) FROM records WHERE mode='active'",null)){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}
        }
    }

    @Test public void markedBodyBudgetCountsFreshCharacterAndMarkRegistersOnce()throws Exception{
        for(int points:new int[]{25000,25001})try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            String text="x".repeat(points);JSONArray blocks=new JSONArray().put(new JSONObject().put("id","marked").put("type","paragraph").put("text",text).put("rich_text",new JSONArray().put(new JSONObject().put("text",text).put("marks",new JSONObject().put("bold",true)))));
            captureBlocks(f,"page","marked",1000,blocks);JSONObject collecting=collectBody(f);
            if(points==25000){JSONObject ready=f.next(collecting);f.call(f.commit(ready));backendOracle(f,"bold-25000",blocks);try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='operations'",null)){boolean marked=false;while(c.moveToNext()){JSONObject op=new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("operation");if(op.getString("type").equals("text.insert")){assertEquals(25000,op.getString("text").length());assertTrue(op.getJSONObject("marks").getBoolean("bold"));marked=true;}}assertTrue(marked);}}
            else unsupportedBody(f,collecting);
        }
    }
    @Test public void unsafeMarksAndInconsistentReadableTextStayPreservedWithoutActiveReplay()throws Exception{
        for(int variant=0;variant<2;variant++)try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            JSONObject marks=variant==0?new JSONObject().put("link","javascript:alert(1)"):new JSONObject();JSONArray blocks=new JSONArray().put(new JSONObject().put("id","safe-original").put("type","paragraph").put("text",variant==0?"x":"different").put("rich_text",new JSONArray().put(new JSONObject().put("text","x").put("marks",marks))));
            captureBlocks(f,"page","unsafe",1000,blocks);JSONObject collecting=collectBody(f);long before=f.outbox.head();unsupportedBody(f,collecting);assertEquals(before,f.outbox.head());assertEquals(1,f.count("records"));assertEquals(0,mutations(f).length());
        }
    }
    @Test public void latestTypedPendingDraftWinsButEqualTimeDifferentBodiesRequireExplicitRecovery()throws Exception{
        for(boolean tied:new boolean[]{false,true})try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            captureBodyAt(f,"page","zz-old",1000,3);captureBodyAt(f,"page","aa-new",tied?1000:2000,5);JSONObject collecting=collectBody(f);
            if(tied){unsupportedBody(f,collecting);assertEquals(2,f.count("records"));}
            else{JSONObject ready=f.next(collecting);f.call(f.commit(ready));try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='operations'",null)){boolean found=false;while(c.moveToNext()){JSONObject op=new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("operation");if(op.getString("type").equals("text.insert")){assertEquals("xxxxx",op.getString("text"));found=true;}}assertTrue(found);}}
        }
    }

    @Test public void readableDraftWithoutAllPendingOperationEvidenceCannotSilentlyDropOwnInput()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            captureBody(f,"readable",5);String resource=f.profile()+"|page";JSONObject operation=new JSONObject().put("id","uncovered:1").put("client","uncovered").put("clock",1).put("type","block.insert").put("block_id","uncovered-input").put("block_type","paragraph").put("_epoch","old-epoch");
            JSONObject value=new JSONObject().put("key",resource).put("profileId",f.profile()).put("id",operation.getString("id")).put("operation",operation);byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",new JSONArray().put(new JSONObject().put("op","put").put("bucket","operations").put("key",new JSONArray().put(resource).put(operation.getString("id"))).put("value",value))).toString().getBytes(StandardCharsets.UTF_8);
            JSONObject opened=f.open(),intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId","uncovered-operation").put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
            JSONObject collecting=collectBody(f);long head=f.outbox.head();unsupportedBody(f,collecting);assertEquals(head,f.outbox.head());assertEquals(2,f.count("records"));assertEquals(0,mutations(f).length());
        }
    }

    @Test public void latestMatchingEpochSnapshotSeenCanCoverPendingOpsWithoutHistoricUnion()throws Exception{
        for(int variant=0;variant<3;variant++)try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            captureBodyAt(f,"page","coverage-draft",3000,5);String resource=f.profile()+"|page";
            JSONObject operation=new JSONObject().put("id","covered:1").put("client","covered").put("clock",1).put("type","block.insert").put("block_id","covered-block").put("block_type","paragraph").put("_epoch","old-epoch");
            JSONArray changes=new JSONArray().put(NativeLocalRecoveryDeviceTest.put("operations",new JSONArray().put(resource).put("covered:1"),new JSONObject().put("key",resource).put("profileId",f.profile()).put("id","covered:1").put("operation",operation)));
            JSONObject snapshot=f.page(10,1).put("epoch","old-epoch");snapshot.getJSONObject("state").getJSONObject("seen").put("covered:1",true);
            changes.put(NativeLocalRecoveryDeviceTest.put("snapshots",resource,new JSONObject().put("key",resource).put("profileId",f.profile()).put("snapshot",snapshot).put("updatedAt",1000)));
            NativeLocalRecoveryDeviceTest.commit(f,changes,"quarantine");
            if(variant>0){JSONObject later=f.page(10,2).put("epoch",variant==2?"other-epoch":"old-epoch");JSONArray overwrite=new JSONArray().put(NativeLocalRecoveryDeviceTest.put("snapshots",resource,new JSONObject().put("key",resource).put("profileId",f.profile()).put("snapshot",later).put("updatedAt",2000)));NativeLocalRecoveryDeviceTest.commit(f,overwrite,"quarantine");}
            JSONObject collecting=collectBody(f);if(variant==0){JSONObject ready=f.next(collecting);f.call(f.commit(ready));backendOracle(f,"seen-coverage",new JSONArray().put(new JSONObject().put("id","source").put("type","paragraph").put("parent_id",JSONObject.NULL).put("text","xxxxx")));assertTrue(ready.getJSONObject("counts").getInt("import")>0);}else if(variant==1){unsupportedBody(f,collecting);}else{JSONObject ready=f.next(collecting);f.call(f.commit(ready));assertTrue(ready.getJSONObject("counts").getInt("import")>0);}
        }
    }

    @Test public void unicodeScalarBudgetAcceptsFiftyThousandSupplementaryCharacters()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            String text="🏠".repeat(50000);JSONArray blocks=new JSONArray().put(new JSONObject().put("id","unicode-source").put("type","paragraph").put("parent_id",JSONObject.NULL).put("text",text));captureBlocks(f,"page","unicode-scalars",1000,blocks);JSONObject ready=f.next(collectBody(f));f.call(f.commit(ready));backendOracle(f,"unicode-50000",blocks);
            try(Cursor c=f.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='operations'",null)){int points=0;while(c.moveToNext()){JSONObject op=new JSONObject(OutboxPolicy.utf8(c.getBlob(0))).getJSONObject("operation");if("text.insert".equals(op.getString("type"))){assertEquals(text,op.getString("text"));points+=op.getString("text").codePointCount(0,op.getString("text").length());}}assertEquals(50000,points);}
        }
    }

    @Test public void samePendingIdWithDifferentDeclaredContentCannotProveCompleteReadableBody()throws Exception{
        for(boolean sameTimeTie:new boolean[]{false,true})try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            String resource=f.profile()+"|page";JSONObject pending=new JSONObject().put("id","same-id:1").put("client","same-id").put("clock",1).put("type","block.insert").put("block_id","actual-block").put("block_type","paragraph").put("_epoch","old-epoch");
            JSONArray blocks=new JSONArray().put(new JSONObject().put("id","visible-body").put("type","paragraph").put("parent_id",JSONObject.NULL).put("text","complete readable body"));captureBlocks(f,"page","declared",1000,blocks);
            JSONObject altered=new JSONObject(pending.toString()).put("block_id","different-block");altered.remove("_epoch");
            JSONObject draft=new JSONObject().put("key",resource).put("profileId",f.profile()).put("clientId","declared-proof").put("updatedAt",sameTimeTie?1000:2000).put("draft",new JSONObject().put("epoch","old-epoch").put("reason","pending").put("blocks",blocks).put("ops",new JSONArray().put(altered)));
            JSONArray changes=new JSONArray().put(NativeLocalRecoveryDeviceTest.put("operations",new JSONArray().put(resource).put("same-id:1"),new JSONObject().put("key",resource).put("profileId",f.profile()).put("id","same-id:1").put("operation",pending))).put(NativeLocalRecoveryDeviceTest.put("drafts",new JSONArray().put(resource).put("declared-proof"),draft));NativeLocalRecoveryDeviceTest.commit(f,changes,"quarantine");long head=f.outbox.head(),records=f.count("records");unsupportedBody(f,collectBody(f));assertEquals(head,f.outbox.head());assertEquals(records,f.count("records"));assertEquals(0,mutations(f).length());
        }
    }

    @Test public void actualSourceStorageFailureIsNotConvertedIntoSuccessfulUnsupportedBody()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            captureBody(f,"storage-fault",5);NativeReconcile engine=new NativeReconcile(f.outbox);Class<?> rowClass=Class.forName("dev.fountain.workspace.NativeReconcile$Row");java.lang.reflect.Constructor<?> constructor=rowClass.getDeclaredConstructor(NativeReconcile.class,android.database.Cursor.class,String.class);constructor.setAccessible(true);Object row;
            try(Cursor c=f.db.rawQuery("SELECT mode,bucket,key,profile_id,resource_key,length(payload),rowid FROM records WHERE mode='quarantine' AND bucket='drafts'",null)){assertTrue(c.moveToFirst());row=constructor.newInstance(engine,c,"records");}
            java.lang.reflect.Method body=NativeReconcile.class.getDeclaredMethod("readableBody",java.util.List.class,String.class,String.class);body.setAccessible(true);f.outbox.db.close();
            try{body.invoke(engine,java.util.Collections.singletonList(row),f.profile(),"page");fail("Source storage failure became a usable body/ready result");}catch(java.lang.reflect.InvocationTargetException expected){Throwable cause=expected.getCause();assertTrue("Source storage failure was hidden behind body-unsupported classification",cause instanceof IllegalStateException||cause instanceof android.database.sqlite.SQLiteException);}
            assertEquals(1,f.count("records"));
        }
    }

 }
