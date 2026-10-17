package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual accepted native local creation and read-only recovery; synthetic private HTTP only. */
@RunWith(AndroidJUnit4.class)
public class NativeLocalRecoveryDeviceTest {
    static JSONObject put(String bucket,Object key,JSONObject value)throws Exception{return new JSONObject().put("op","put").put("bucket",bucket).put("key",key).put("value",value);}
    static void commit(ReconcileDeviceTest.Fixture f,JSONArray changes,String mode)throws Exception{
        byte[] raw=new JSONObject().put("version",1).put("origin",f.origin).put("mode",mode).put("changes",changes).toString().getBytes(StandardCharsets.UTF_8);
        JSONObject opened=f.open(),intent=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("txId",UUID.randomUUID().toString()).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));
        f.outbox.stage(intent,1);f.outbox.commit(intent,1,null,false);
    }
    static String seed(ReconcileDeviceTest.Fixture f,String pageID,String parent)throws Exception{return seed(f,pageID,parent,false);}
    static String seed(ReconcileDeviceTest.Fixture f,String pageID,String parent,boolean priorUntrustedArchive)throws Exception{
        f.outbox.observe("GET","/api/workspace",200,f.workspace(10,false).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
        String epoch=UUID.randomUUID().toString(),resource=f.profile()+"|"+OutboxPolicy.encode(pageID),creation="create-"+pageID;
        JSONObject body=new JSONObject().put("id",pageID).put("title","Unsent local page").put("parent_id",parent==null?JSONObject.NULL:parent).put("teamspace_id","general");
        JSONObject op=new JSONObject().put("id",creation).put("kind","page.create").put("target_id",pageID).put("document_epoch",epoch).put("body",body).put("depends_on",parent==null||parent.equals("page")?new JSONArray():new JSONArray().put("create-"+parent));
        JSONObject page=new JSONObject(body.toString()).put("access_level",4).put("locked",false).put("archived",false).put("owner_id","member").put("revision",0).put("blocks",new JSONArray());
        JSONObject snapshot=f.envelope(0).put("epoch",epoch).put("seq",0).put("access_level",4).put("page",page).put("blocks",new JSONArray()).put("state",new JSONObject().put("version",1).put("max_clock",0).put("blocks",new JSONObject()).put("seen",new JSONObject()));
        JSONObject local=new JSONObject().put("key",resource).put("resourceKey",resource).put("profileId",f.profile()).put("metadata",new JSONObject().put("page",page).put("initial_epoch",epoch).put("create_operation_id",creation).put("localOnly",true));
        JSONArray blocks=new JSONArray().put(new JSONObject().put("id","readable-"+pageID).put("type","paragraph").put("parent_id",JSONObject.NULL).put("text","Exact unsent readable body "+pageID));
        JSONArray changes=new JSONArray().put(put("snapshots",resource,new JSONObject().put("key",resource).put("profileId",f.profile()).put("snapshot",snapshot)))
            .put(put("localPages",resource,local)).put(put("mutations",new JSONArray().put(f.profile()).put(creation),new JSONObject().put("profileId",f.profile()).put("id",creation).put("resourceKey",resource).put("operation",op).put("status","pending").put("sequence",1)))
            .put(put("drafts",new JSONArray().put(resource).put("local-body"),new JSONObject().put("key",resource).put("profileId",f.profile()).put("clientId","local-body").put("draft",new JSONObject().put("epoch",epoch).put("reason","pending").put("blocks",blocks)).put("updatedAt",1000)));
        if(priorUntrustedArchive){JSONObject target=changes.getJSONObject(3).getJSONObject("value"),old=new JSONObject(target.toString());old.getJSONObject("draft").getJSONArray("blocks").getJSONObject(0).put("text","earlier untrusted version");Object key=changes.getJSONObject(3).get("key");commit(f,new JSONArray().put(put("drafts",key,old)),"quarantine");commit(f,new JSONArray().put(put("drafts",key,target)),"quarantine");}
        commit(f,changes,"active");return resource;
    }
    static NativeRecovery recovery(ReconcileDeviceTest.Fixture f)throws Exception{NativeRecovery recovery=new NativeRecovery(InstrumentationRegistry.getInstrumentation().getTargetContext());recovery.refresh(new NativeRecovery.Session(f.origin,new JSONObject(f.outbox.get("grant")).getJSONObject("session"),null,"local-export-component"));return recovery;}
    static NativeRecovery.Authority authority(ReconcileDeviceTest.Fixture f){return new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{if(path.equals("/api/workspace"))return f.workspace(10,false).put("session_binding",new JSONObject(f.outbox.get("grant")).getJSONObject("session").getString("cache_binding"));throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED");}};}
    static JSONArray handles(JSONObject inventory)throws Exception{JSONArray result=new JSONArray(),items=inventory.getJSONArray("items");for(int i=0;i<items.length();i++)result.put(items.getJSONObject(i).getString("handle"));return result;}
    @Test public void acceptedNeverServerLocalDagExportsOnlyReadableBodyWithoutDirectPageGrant()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);seed(f,"local-child","local-parent");long sourceHead=f.outbox.head();
            try(NativeRecovery recovery=recovery(f)){NativeRecovery.Authority authority=authority(f);JSONObject inventory=recovery.inventory(null,100,1,authority);JSONObject prepared=recovery.prepare(inventory.getString("inventoryToken"),handles(inventory),1,authority);assertTrue("Accepted never-server native local DAG must have readable export",prepared.getInt("readyCount")>0);assertEquals(0,prepared.getInt("blockedCount"));NativeRecovery.Prepared files=recovery.saving(inventory.getString("inventoryToken"),prepared.getString("exportToken"),handles(inventory),authority);for(String format:files.formats)assertEquals("body",format);recovery.finished(files);}assertEquals(sourceHead,f.outbox.head());
        }
    }
    @Test public void unqualifiedOrModifiedLocalBytesDoNotAcquireParentFallback()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);f.db.execSQL("DELETE FROM native_record_owners");
            try(NativeRecovery recovery=recovery(f)){assertEquals(0,recovery.inventory(null,100,1,authority(f)).getJSONArray("items").length());}
        }
    }
    @Test public void actualCanonicalObservationPermanentlyClosesEveryOldLocalVersionFallback()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);JSONObject canonical=f.page(10,0);canonical.getJSONObject("page").put("id","local-parent");f.outbox.observe("GET","/api/pages/local-parent/collaboration",200,canonical.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            try(NativeRecovery recovery=recovery(f)){NativeRecovery.Authority authority=authority(f);JSONObject inventory=recovery.inventory(null,100,1,authority);JSONObject prepared=recovery.prepare(inventory.getString("inventoryToken"),handles(inventory),1,authority);assertEquals(0,prepared.getInt("readyCount"));assertTrue(prepared.getInt("blockedCount")>0);}
        }
    }
    @Test public void recoveryObservationClosesReaderCapsBeforeMarkerAndCannotReuseOldLocalHandle()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);long head=f.outbox.head(),proof=Long.parseLong(f.outbox.get("proof_epoch"));NativeRecovery.Authority authority=authority(f);
            try(NativeRecovery recovery=recovery(f)){
                JSONObject old=recovery.inventory(null,100,1,authority),canonical=f.page(10,0);canonical.getJSONObject("page").put("id","local-parent");
                try{recovery.observe("GET","/api/pages/local-parent/collaboration",200,canonical);fail("New server evidence reused old local inventory");}catch(NativeRecovery.Failure expected){assertEquals("Marker handoff cause class: "+(expected.getCause()==null?"none":expected.getCause().getClass().getSimpleName()+":"+(expected.getCause().getStackTrace().length>1?expected.getCause().getStackTrace()[1].getMethodName()+":"+expected.getCause().getStackTrace()[1].getLineNumber():"unknown")),"RECOVERY_STALE",expected.code);}
                assertEquals("1",f.outbox.get(NativeOutbox.serverPageKey("workspace","local-parent")));assertEquals(head,f.outbox.head());assertEquals(proof+1,Long.parseLong(f.outbox.get("proof_epoch")));assertFalse(f.outbox.currentOwner(f.owner));
                try{recovery.prepare(old.getString("inventoryToken"),handles(old),1,authority);fail("An old handle survived classification change");}catch(NativeRecovery.Failure expected){assertEquals("RECOVERY_STALE",expected.code);}
                JSONObject fresh=recovery.inventory(null,100,1,authority);assertEquals(old.getJSONArray("items").length(),fresh.getJSONArray("items").length());String before=f.outbox.get("proof_epoch");recovery.observe("GET","/api/pages/local-parent/collaboration",200,canonical);assertEquals(before,f.outbox.get("proof_epoch"));JSONObject blocked=recovery.prepare(fresh.getString("inventoryToken"),handles(fresh),1,authority);assertEquals(0,blocked.getInt("readyCount"));assertTrue(blocked.getInt("blockedCount")>0);
            }
        }
    }
    @Test public void workspaceInventoryClassificationSurvivesOmissionAndNewBindingWithoutRenewingLocalRights()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);JSONObject visible=f.workspace(11,false);visible.getJSONArray("pages").put(new JSONObject().put("id","local-parent").put("access_level",4).put("locked",false).put("archived",false));
            f.outbox.observe("GET","/api/workspace",200,visible.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);long proof=Long.parseLong(f.outbox.get("proof_epoch"));
            f.outbox.observe("GET","/api/workspace",200,visible.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);assertEquals(proof,Long.parseLong(f.outbox.get("proof_epoch")));
            JSONObject session=new JSONObject(f.outbox.get("grant")).getJSONObject("session").put("cache_binding","new-binding");f.outbox.grant(session,null);f.open();f.outbox.observe("GET","/api/workspace",200,f.workspace(12,false).put("session_binding","new-binding").toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            assertEquals("1",f.outbox.get(NativeOutbox.serverPageKey("workspace","local-parent")));
            try(NativeRecovery recovery=recovery(f)){NativeRecovery.Authority authority=authority(f);JSONObject inventory=recovery.inventory(null,100,1,authority),blocked=recovery.prepare(inventory.getString("inventoryToken"),handles(inventory),1,authority);assertEquals(0,blocked.getInt("readyCount"));assertTrue(blocked.getInt("blockedCount")>0);}
        }
    }
    @Test public void identicalOlderUntrustedArchiveCannotInheritLaterAcceptedNativeCreationStamp()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null,true);String key=new JSONArray().put(f.profile()+"|local-parent").put("local-body").toString();
            try(Cursor c=f.db.rawQuery("SELECT count(*) FROM native_local_versions_v1 WHERE mode='active' AND bucket='drafts' AND key=?",new String[]{key})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));}
            try(Cursor c=f.db.rawQuery("SELECT count(*) FROM native_recovery_records a JOIN native_local_versions_v1 v ON v.mode='archive:'||a.id WHERE a.bucket='drafts' AND a.key=?",new String[]{key})){assertTrue(c.moveToFirst());assertEquals("An earlier archive was retroactively qualified",0,c.getInt(0));}
            try(Cursor c=f.db.rawQuery("SELECT count(*) FROM native_recovery_records WHERE bucket='drafts' AND key=? AND trust='untrusted'",new String[]{key})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));}
        }
    }

    @Test public void freshGuestMayReadOwnNeverServerChildOnlyThroughCurrentlyEditableExternalParent()throws Exception{
        for(boolean editable:new boolean[]{true,false})try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            f.outbox.observe("GET","/api/workspace",200,f.workspace(10,false).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            JSONObject parent=f.page(10,0);parent.getJSONObject("page").put("teamspace_id","general");f.outbox.observe("GET","/api/pages/page/collaboration",200,parent.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);seed(f,"local-child","page");
            JSONObject session=new JSONObject(f.outbox.get("grant")).getJSONObject("session");session.getJSONObject("member").put("role","guest");f.outbox.grant(session,null);f.open();
            NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{if(path.equals("/api/workspace"))return f.workspace(10,false);assertEquals("/api/pages/page/collaboration",path);JSONObject reply=f.page(10,0).put("access_level",editable?3:2);reply.getJSONObject("page").put("access_level",editable?3:2).put("teamspace_id","general");return reply;}};
            try(NativeRecovery recovery=recovery(f)){JSONObject inventory=recovery.inventory(null,100,1,authority),prepared=recovery.prepare(inventory.getString("inventoryToken"),handles(inventory),1,authority);if(editable){assertEquals(4,prepared.getInt("readyCount"));assertEquals(0,prepared.getInt("blockedCount"));}else{assertEquals(0,prepared.getInt("readyCount"));assertEquals(4,prepared.getInt("blockedCount"));}}
        }
    }
    @Test public void explicitPromotionStampsOnlyNewAcceptedIdsAndRetainsOriginalVersionContexts()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);String oldContext=f.outbox.get(NativeOutbox.localContextKey(f.profile(),"local-parent"));JSONObject session=new JSONObject(f.outbox.get("grant")).getJSONObject("session").put("cache_binding","next-binding");f.outbox.grant(session,null);JSONObject opened=f.open();JSONArray options=opened.getJSONArray("reconciliationHandles"),selected=new JSONArray();for(int i=0;i<options.length();i++)if(options.getJSONObject(i).getString("kind").equals("recovery"))selected.put(options.getJSONObject(i).getString("handle"));assertEquals(1,selected.length());
            JSONObject collecting=f.call(new JSONObject().put("generation",1).put("phase","prepare").put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("mode","promote").put("handles",selected));
            f.observed("/api/workspace",f.workspace(10,false).put("session_binding","next-binding"));JSONObject ready=f.next(collecting);assertEquals("ready",ready.getString("state"));f.call(f.commit(ready));String target=opened.getString("profileId");
            try(Cursor c=f.db.rawQuery("SELECT resource_key FROM records WHERE mode='active' AND profile_id=? AND bucket='localPages'",new String[]{target})){assertTrue(c.moveToFirst());String resource=c.getString(0),page=resource.substring(resource.lastIndexOf('|')+1);assertNotEquals("local-parent",page);assertNotNull(f.outbox.get(NativeOutbox.localContextKey(target,page)));assertFalse(c.moveToNext());}
            assertEquals(oldContext,f.outbox.get(NativeOutbox.localContextKey(f.profile(),"local-parent")));try(Cursor c=f.db.rawQuery("SELECT count(*) FROM native_local_versions_v1 WHERE profile_id=? AND mode='active'",new String[]{target})){assertTrue(c.moveToFirst());assertTrue(c.getInt(0)>=4);}
        }
    }

    @Test public void previouslyServerObservedHistoricalPageCannotBePromotedThroughEditableParentWhenOriginalIsHidden()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            f.outbox.observe("GET","/api/workspace",200,f.workspace(10,false).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);JSONObject parent=f.page(10,0);parent.getJSONObject("page").put("teamspace_id","general");f.outbox.observe("GET","/api/pages/page/collaboration",200,parent.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);seed(f,"local-child","page");
            JSONObject original=f.page(10,0);original.getJSONObject("page").put("id","local-child");f.outbox.observe("GET","/api/pages/local-child/collaboration",200,original.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            JSONObject session=new JSONObject(f.outbox.get("grant")).getJSONObject("session").put("cache_binding","hidden-binding");f.outbox.grant(session,null);JSONObject opened=f.open();JSONArray choices=opened.getJSONArray("reconciliationHandles"),handles=new JSONArray();for(int i=0;i<choices.length();i++)handles.put(choices.getJSONObject(i).getString("handle"));
            JSONObject result=f.call(new JSONObject().put("generation",1).put("phase","prepare").put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("mode","promote").put("handles",handles));
            JSONObject workspace=f.workspace(11,true).put("session_binding","hidden-binding");workspace.getJSONArray("pages").getJSONObject(0).put("teamspace_id","general");f.observed("/api/workspace",workspace);
            try{for(int turn=0;turn<4;turn++){result=f.next(result);if(result.getString("state").equals("ready"))break;JSONArray needed=result.getJSONArray("needed");for(int i=0;i<needed.length();i++){String id=needed.getJSONObject(i).getString("id"),path="/api/pages/"+OutboxPolicy.encode(id)+"/collaboration";if(id.equals("local-child")){NativeReconcile.Tag tag=f.outbox.admitReconcile(++f.sequence,"GET",path,null,false,f.owner);assertNotNull(tag);f.outbox.beforeReconcileObservation(tag,null,false,f.owner);byte[] denied="{}".getBytes(StandardCharsets.UTF_8);f.outbox.observe("GET",path,403,denied,null,false,f.owner);f.outbox.captureReconcile(tag,403,denied,null,false,f.owner);}else{assertEquals("page",id);JSONObject live=f.page(11,0).put("session_binding","hidden-binding");live.getJSONObject("page").put("teamspace_id","general");f.observed(path,live);}}}
                assertEquals("ready",result.getString("state"));assertEquals("Hidden original was cloned via only its editable parent",0,result.getJSONObject("counts").getInt("import"));
            }catch(NativeReconcile.Failure denied){assertEquals("OUTBOX_ACCESS_REQUIRED",denied.code);}
            try(Cursor c=f.db.rawQuery("SELECT count(*) FROM records WHERE mode='active' AND profile_id=?",new String[]{f.profile()})){assertTrue(c.moveToFirst());assertEquals(4,c.getInt(0));}
        }
    }

    @Test public void validCanonicalExistenceIsPermanentEvenWhenPositiveLedgerCapacityIsExceeded()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            seed(f,"local-parent",null);assertFalse(f.outbox.serverObserved("workspace","local-parent"));
            // Capacity-only fixture pressure on an EXISTING real workspace proof;
            // no identity, owner, ACL, floor, source attribution or stamp is forged.
            JSONObject ledger=new JSONObject(f.outbox.get("resource_proofs"));JSONObject workspace=ledger.getJSONObject("entries").getJSONObject("workspace:workspace");workspace.put("capacity_fixture","");int size=ledger.toString().getBytes(StandardCharsets.UTF_8).length;workspace.put("capacity_fixture","x".repeat(OutboxPolicy.RECORD-size-32));String pressure=ledger.toString();assertTrue(pressure.getBytes(StandardCharsets.UTF_8).length<=OutboxPolicy.RECORD);f.outbox.set("resource_proofs",pressure);
            JSONObject canonical=f.page(11,0);canonical.getJSONObject("page").put("id","local-parent");long head=f.outbox.head();try{f.outbox.observe("GET","/api/pages/local-parent/collaboration",200,canonical.toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);fail("Oversized positive ledger was accepted");}catch(NativeOutbox.AccessRequired expected){}
            assertTrue("Valid server existence was dropped with oversized positive authority",f.outbox.serverObserved("workspace","local-parent"));assertEquals(head,f.outbox.head());assertEquals(4,f.count("records"));
            f.outbox.observe("GET","/api/workspace",200,f.workspace(12,false).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);assertTrue(f.outbox.serverObserved("workspace","local-parent"));
            try(NativeRecovery recovery=recovery(f)){NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{if(path.equals("/api/workspace"))return f.workspace(12,false);throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED");}};JSONObject inventory=recovery.inventory(null,100,1,authority),blocked=recovery.prepare(inventory.getString("inventoryToken"),handles(inventory),1,authority);assertEquals(0,blocked.getInt("readyCount"));assertEquals(4,blocked.getInt("blockedCount"));}
        }
    }

}
