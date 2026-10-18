package dev.fountain.workspace;
import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.*;
import java.security.KeyStore;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ExecutorService;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual Android SQLite/KeyStore; native session DTOs are fixtures, not remote GoTrue proof. */
@RunWith(AndroidJUnit4.class)
public class MultiworkspaceDeviceTest {
    static final String TOKEN="abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE", PARENT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    static JSONObject session(String ws,String child)throws Exception {return new JSONObject().put("enabled",true).put("required",true).put("authenticated",true).put("mode","accounts").put("workspace_id",ws).put("cache_binding",child).put("account_binding",PARENT).put("expires_at",Instant.now().plusSeconds(3600).toString()).put("member",new JSONObject().put("id","member-"+ws).put("role","owner").put("active",true));}
    static String key(String value){return String.format("%032d",Integer.parseInt(value));}
    static class Fixture implements AutoCloseable {
        final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String suffix=UUID.randomUUID().toString().replace("-",""), origin="https://multiworkspace-"+suffix+".invalid";
        final NativeOutbox store=new NativeOutbox(context,origin);
        final File file=new File(context.getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite");
        Fixture()throws Exception{}
        String profile(String ws,String binding)throws Exception{return OutboxPolicy.profile(origin,ws,"member-"+ws,binding);}
        JSONObject open()throws Exception{return store.open(1,TOKEN,false,"native-owner");}
        void anchor(String ws,String binding)throws Exception {JSONObject workspace=new JSONObject().put("workspace_id",ws).put("current_member_id","member-"+ws).put("session_binding",binding).put("access_revision",10).put("data_revision",10).put("pages",new JSONArray()).put("databases",new JSONArray());store.observe("GET","/api/workspace",200,workspace.toString().getBytes("UTF-8"),TOKEN,false,"native-owner");}
        public void close(){store.close();assertTrue(file.delete());}
    }
    @Test public void parkSwitchResumePreservesPendingAndRequiresCanonicalFloor()throws Exception {
        try(Fixture f=new Fixture()) {
            String a=key("1"),b=key("2"),profileA=f.profile("A",a),profileB=f.profile("B",b);
            f.store.grant(session("A",a),TOKEN);JSONObject first=f.open();f.anchor("A",a);
            f.store.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts","private-A",profileA,profileA+"|page","A pending IME 초안 🏠".getBytes("UTF-8")});
            String oldLease=f.store.get("lease");f.store.parkWorkspace();assertNotEquals(oldLease,f.store.get("lease"));assertNull(f.store.get("suspended:"+profileA));assertNotNull(f.store.get("parked:"+profileA));assertNull(f.store.verified(TOKEN,false));
            f.store.grant(session("B",b),TOKEN);assertEquals(profileB,f.open().getString("profileId"));f.anchor("B",b);assertNull(f.store.get("suspended:"+profileA));
            f.store.parkWorkspace();f.store.grant(session("A",a),TOKEN);JSONObject resumed=f.open();assertEquals(profileA,resumed.getString("profileId"));assertEquals("required",resumed.getString("resourceAccess"));assertNotEquals(first.getString("lease"),resumed.getString("lease"));assertNull(f.store.get("suspended:"+profileA));
            f.anchor("A",a);assertNotNull(f.store.verified(TOKEN,false));
            try(Cursor rows=f.store.db.rawQuery("SELECT profile_id,payload FROM records WHERE key='private-A'",null)){assertTrue(rows.moveToFirst());assertEquals(profileA,rows.getString(0));assertEquals("A pending IME 초안 🏠",new String(rows.getBlob(1),"UTF-8"));}
            assertNotNull(f.store.get("parked:"+profileB));
        }
    }
    @Test public void accountLogoutSuspendsActiveAndParkedAndCannotResumeOldChild()throws Exception {
        try(Fixture f=new Fixture()) {
            String a=key("1"),b=key("2");f.store.grant(session("A",a),TOKEN);f.open();f.store.parkWorkspace();f.store.grant(session("B",b),TOKEN);f.open();
            f.store.revokeAccountWorkspaces();assertEquals("1",f.store.get("suspended:"+f.profile("A",a)));assertEquals("1",f.store.get("suspended:"+f.profile("B",b)));assertNull(f.store.get("parked:"+f.profile("A",a)));
            try{f.store.grant(session("A",a),TOKEN);fail("Revoked parked child resumed");}catch(NativeOutbox.RecoveryRequired expected){}
            f.store.grant(session("A",key("3")),TOKEN);assertEquals(f.profile("A",key("3")),f.open().getString("profileId"));
        }
    }
    @Test public void anonymousAccount401CapabilityProbePreservesLegacyPrivateGrantAndPending()throws Exception {
        try(Fixture f=new Fixture()) {
            JSONObject legacy=session("legacy",key("1"));legacy.remove("account_binding");
            f.store.grant(legacy,TOKEN);f.open();f.anchor("legacy",key("1"));String profile=f.profile("legacy",key("1"));
            f.store.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts","legacy-pending",profile,profile+"|page","Legacy IME 초안".getBytes("UTF-8")});
            String grant=f.store.get("grant"),lease=f.store.get("lease");long boundary=f.store.boundary();FountainNativePlugin plugin=new FountainNativePlugin();
            try {
                set(plugin,"origin",f.origin);set(plugin,"activeCookie",TOKEN);set(plugin,"outbox",f.store);set(plugin,"authGeneration",7L);set(plugin,"workspaceEpoch",9L);
                Class<?> op=Class.forName(FountainNativePlugin.class.getName()+"$AccountOperation"),responseType=Class.forName(FountainNativePlugin.class.getName()+"$Response");
                Constructor<?> create=op.getDeclaredConstructors()[0];create.setAccessible(true);Object operation=create.newInstance("legacy-probe",f.origin,1L,0L,null,false,false);
                Constructor<?> responseConstructor=responseType.getDeclaredConstructor();responseConstructor.setAccessible(true);Object response=responseConstructor.newInstance();
                Field status=responseType.getDeclaredField("status");status.setAccessible(true);status.set(response,401);
                Method apply=FountainNativePlugin.class.getDeclaredMethod("applyAccountResponse",op,responseType,boolean.class,String.class);apply.setAccessible(true);
                assertTrue(NativeAccountPolicy.directoryAbsent("GET","/api/account/session",Collections.singletonMap("X-Fountain-Account-Directory",Collections.singletonList("absent"))));
                apply.invoke(plugin,operation,response,true,null);
                assertEquals(TOKEN,get(plugin,"activeCookie"));assertNull(get(plugin,"accountActive"));assertEquals(7L,get(plugin,"authGeneration"));assertEquals(9L,get(plugin,"workspaceEpoch"));
                assertEquals(grant,f.store.get("grant"));assertEquals(lease,f.store.get("lease"));assertEquals(boundary,f.store.boundary());assertNull(f.store.get("suspended:"+profile));assertNotNull(f.store.verified(TOKEN,false));
                try(Cursor rows=f.store.db.rawQuery("SELECT payload FROM records WHERE key='legacy-pending'",null)){assertTrue(rows.moveToFirst());assertEquals("Legacy IME 초안",new String(rows.getBlob(0),"UTF-8"));}
            }finally{for(String executor:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,executor)).shutdownNow();}
        }
    }
    @Test public void canonicalResumeUsesScopedPointersAndKeepsNativeAttributedFormInput()throws Exception {
        try(Fixture f=new Fixture()) {
            String binding=key("1"),profile=f.profile("A",binding);f.store.grant(session("A",binding),TOKEN);JSONObject first=f.open();f.anchor("A",binding);first=f.open();
            JSONObject form=new JSONObject().put("id","workspace-input:"+profile).put("profileId",profile).put("forms",new JSONArray().put(new JSONObject().put("value","Unsent form 🏠"))).put("updatedAt",System.currentTimeMillis());
            JSONObject delta=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("bucket","meta").put("op","put").put("key",form.getString("id")).put("value",form)));
            byte[] raw=delta.toString().getBytes("UTF-8");JSONObject input=new JSONObject().put("generation",1).put("lease",first.getString("lease")).put("txId","form-input").put("baseHead",first.getLong("head")).put("proofEpoch",first.getLong("proofEpoch")).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));
            f.store.stage(input,1);f.store.commit(input,1,TOKEN,false);
            f.store.parkWorkspace();f.store.grant(session("B",key("2")),TOKEN);f.open();f.store.parkWorkspace();f.store.grant(session("A",binding),TOKEN);JSONObject current=f.open();
            JSONObject prepare=new JSONObject().put("generation",1).put("phase","prepare").put("lease",current.getString("lease")).put("baseHead",current.getLong("head")).put("proofEpoch",current.getLong("proofEpoch")).put("mode","current");
            JSONObject collecting=f.store.reconcile(prepare,1,TOKEN,false,"native-owner",0);
            NativeReconcile.Tag tag=f.store.admitReconcile(1,"GET","/api/workspace",TOKEN,false,"native-owner");assertNotNull(tag);
            JSONObject body=new JSONObject().put("workspace_id","A").put("current_member_id","member-A").put("session_binding",binding).put("access_revision",10).put("data_revision",10).put("pages",new JSONArray()).put("databases",new JSONArray());
            f.store.beforeReconcileObservation(tag,TOKEN,false,"native-owner");byte[] observed=body.toString().getBytes("UTF-8");f.store.observe("GET","/api/workspace",200,observed,TOKEN,false,"native-owner");f.store.captureReconcile(tag,200,observed,TOKEN,false,"native-owner");
            JSONObject ready=f.store.reconcile(new JSONObject().put("generation",1).put("phase","prepare").put("lease",collecting.getString("lease")).put("planId",collecting.getString("planId")),1,TOKEN,false,"native-owner",1);assertEquals("ready",ready.getString("state"));
            JSONObject commit=new JSONObject().put("generation",1).put("phase","commit").put("lease",ready.getString("lease")).put("baseHead",ready.getLong("baseHead")).put("proofEpoch",ready.getLong("proofEpoch")).put("planId",ready.getString("planId")).put("checksum",ready.getString("checksum")).put("confirm",true);
            f.store.reconcile(commit,1,TOKEN,false,"native-owner",1);
            for(String pointer:Arrays.asList("active:"+PARENT+":A","last-profile:"+PARENT+":A","workspace-input:"+profile))try(Cursor rows=f.store.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='meta' AND key=?",new String[]{JSONObject.quote(pointer)})){assertTrue(pointer,rows.moveToFirst());JSONObject value=new JSONObject(new String(rows.getBlob(0),"UTF-8"));assertEquals(profile,value.getString("profileId"));if(pointer.startsWith("workspace-input:"))assertEquals("Unsent form 🏠",value.getJSONArray("forms").getJSONObject(0).getString("value"));}
            try(Cursor rows=f.store.db.rawQuery("SELECT payload FROM records WHERE bucket='profiles' AND profile_id=?",new String[]{profile})){assertTrue(rows.moveToFirst());assertEquals(PARENT,new JSONObject(new String(rows.getBlob(0),"UTF-8")).getString("accountBinding"));}
            try(Cursor rows=f.store.db.rawQuery("SELECT count(*) FROM records WHERE bucket='meta' AND key IN (?,?)",new String[]{JSONObject.quote("active"),JSONObject.quote("last-profile")})){assertTrue(rows.moveToFirst());assertEquals(0,rows.getInt(0));}
        }
    }
    @Test public void offlineResumeUsesExistingSQLGrantAndBlocksNetworkAndFreshBaseline()throws Exception {
        try(Fixture f=new Fixture()) {
            JSONObject original=session("A",key("1"));f.store.grant(original,TOKEN);JSONObject opened=f.open();
            JSONObject envelope=new JSONObject().put("workspace_id","A").put("current_member_id","member-A").put("session_binding",key("1")).put("access_revision",10).put("data_revision",10);
            JSONObject page=new JSONObject().put("id","page").put("title","Original title").put("access_level",4).put("locked",false).put("archived",false);
            JSONObject workspace=new JSONObject(envelope.toString()).put("pages",new JSONArray().put(page)).put("databases",new JSONArray()).put("teamspaces",new JSONArray().put(new JSONObject().put("id","general").put("access_level",3)));
            f.store.observe("GET","/api/workspace",200,workspace.toString().getBytes("UTF-8"),TOKEN,false,"native-owner");
            JSONObject canonical=new JSONObject(envelope.toString()).put("epoch","offline-epoch").put("seq",0).put("access_level",4).put("page",page).put("blocks",new JSONArray()).put("state",new JSONObject().put("version",1).put("blocks",new JSONObject()).put("seen",new JSONObject()).put("max_clock",0));
            f.store.observe("GET","/api/pages/page/collaboration",200,canonical.toString().getBytes("UTF-8"),TOKEN,false,"native-owner");
            f.store.parkWorkspace();f.store.resumeWorkspaceOffline(original,TOKEN);JSONObject offline=f.open();assertTrue(f.store.offlineWorkspace());assertEquals("1",f.store.get("needs_floor"));assertEquals("ready",offline.getString("resourceAccess"));
            try{f.store.admitSync("POST","/api/sync",new byte[0],TOKEN,false,"native-owner");fail("Offline SEND admitted");}catch(NativeOutbox.AccessRequired expected){}
            String resource=f.profile("A",key("1"))+"|page";JSONObject value=new JSONObject().put("profileId",f.profile("A",key("1"))).put("key",resource).put("clientId","offline-IME").put("draft",new JSONObject().put("text","Cold offline 초안 🏠"));
            JSONObject delta=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("bucket","drafts").put("op","put").put("key",new JSONArray().put(resource).put("offline-IME")).put("value",value)));
            JSONObject title=new JSONObject().put("id","offline-title").put("kind","page.patch").put("target_id","page").put("body",new JSONObject().put("title","Offline title 🏠")).put("depends_on",new JSONArray());
            JSONObject mutation=new JSONObject().put("profileId",f.profile("A",key("1"))).put("id","offline-title").put("resourceKey",resource).put("operation",title).put("status","pending").put("sequence",1);
            JSONObject crdt=new JSONObject().put("profileId",f.profile("A",key("1"))).put("key",resource).put("id","offline-crdt").put("operation",new JSONObject().put("id","offline-crdt").put("_epoch","offline-epoch").put("type","set").put("block_id","paragraph").put("field","text").put("value","오프라인 편집"));
            delta.getJSONArray("changes").put(new JSONObject().put("bucket","mutations").put("op","put").put("key",new JSONArray().put(f.profile("A",key("1"))).put("offline-title")).put("value",mutation)).put(new JSONObject().put("bucket","operations").put("op","put").put("key",new JSONArray().put(resource).put("offline-crdt")).put("value",crdt));
            byte[] raw=delta.toString().getBytes("UTF-8");JSONObject input=new JSONObject().put("generation",1).put("lease",offline.getString("lease")).put("txId","offline-draft").put("baseHead",offline.getLong("head")).put("proofEpoch",offline.getLong("proofEpoch")).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.store.stage(input,1);f.store.commit(input,1,TOKEN,false);assertEquals("1",f.store.get("needs_floor"));
            try(Cursor rows=f.store.db.rawQuery("SELECT count(*) FROM records WHERE profile_id=? AND bucket IN ('operations','mutations','drafts')",new String[]{f.profile("A",key("1"))})){assertTrue(rows.moveToFirst());assertEquals(3,rows.getInt(0));}
            f.store.parkWorkspace();f.store.resumeWorkspaceOffline(original,TOKEN);assertEquals("ready",f.open().getString("resourceAccess"));assertEquals("1",f.store.get("needs_floor"));
            f.store.parkWorkspace();try{f.store.resumeWorkspaceOffline(original,"other-parent-cookie");fail("Wrong parent resumed offline");}catch(IllegalArgumentException expected){}
            f.store.revokeAccountWorkspaces();try{f.store.resumeWorkspaceOffline(original,TOKEN);fail("Permanently suspended child resumed offline");}catch(NativeOutbox.AccessRequired expected){}
        }
    }
    @Test public void offlineCachedCreationAuthorityKeepsPageAndRowMutationsWithoutSending()throws Exception {
        try(Fixture f=new Fixture()) {
            String binding=key("1"),profile=f.profile("A",binding);JSONObject original=session("A",binding);f.store.grant(original,TOKEN);f.open();
            JSONObject env=new JSONObject().put("workspace_id","A").put("current_member_id","member-A").put("session_binding",binding).put("access_revision",10).put("data_revision",10);
            JSONObject workspace=new JSONObject(env.toString()).put("pages",new JSONArray()).put("databases",new JSONArray().put(new JSONObject().put("id","db").put("access_level",4))).put("teamspaces",new JSONArray().put(new JSONObject().put("id","general").put("access_level",3)));
            f.store.observe("GET","/api/workspace",200,workspace.toString().getBytes("UTF-8"),TOKEN,false,"native-owner");
            JSONObject database=new JSONObject(env.toString()).put("database",new JSONObject().put("id","db").put("access_level",4).put("can_create_row",true).put("properties",new JSONArray().put(new JSONObject().put("id","title").put("type","title")))).put("rows",new JSONArray());
            f.store.observe("GET","/api/databases/db",200,database.toString().getBytes("UTF-8"),TOKEN,false,"native-owner");f.store.parkWorkspace();f.store.resumeWorkspaceOffline(original,TOKEN);JSONObject opened=f.open();
            String resource=profile+"|new-local",epoch="11111111-1111-4111-8111-111111111111";
            JSONObject body=new JSONObject().put("id","new-local").put("title","오프라인 새 문서").put("parent_id",JSONObject.NULL).put("teamspace_id","general");
            JSONObject page=new JSONObject(body.toString()).put("access_level",4).put("locked",false).put("archived",false).put("owner_id","member-A").put("revision",0).put("blocks",new JSONArray());
            JSONObject create=new JSONObject().put("id","offline-create").put("kind","page.create").put("target_id","new-local").put("document_epoch",epoch).put("body",body).put("depends_on",new JSONArray());
            JSONObject snap=new JSONObject(env.toString()).put("epoch",epoch).put("seq",0).put("access_level",4).put("page",page).put("blocks",new JSONArray()).put("state",new JSONObject().put("version",1).put("max_clock",0).put("blocks",new JSONObject()).put("seen",new JSONObject()));
            JSONObject row=new JSONObject().put("id","offline-row").put("kind","row.create").put("target_id","local-row").put("database_id","db").put("body",new JSONObject().put("id","local-row").put("parent_row_id",JSONObject.NULL).put("properties",new JSONObject().put("title","오프라인 새 행"))).put("depends_on",new JSONArray());
            JSONArray changes=new JSONArray().put(put("snapshots",resource,new JSONObject().put("key",resource).put("profileId",profile).put("snapshot",snap)))
                .put(put("localPages",resource,new JSONObject().put("key",resource).put("resourceKey",resource).put("profileId",profile).put("metadata",new JSONObject().put("page",page).put("initial_epoch",epoch).put("create_operation_id","offline-create").put("localOnly",true))))
                .put(put("mutations",new JSONArray().put(profile).put("offline-create"),new JSONObject().put("profileId",profile).put("id","offline-create").put("resourceKey",resource).put("operation",create).put("status","pending").put("sequence",1)))
                .put(put("mutations",new JSONArray().put(profile).put("offline-row"),new JSONObject().put("profileId",profile).put("id","offline-row").put("resourceKey",profile+"|database|db").put("operation",row).put("status","pending").put("sequence",2)));
            JSONObject delta=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",changes);byte[] raw=delta.toString().getBytes("UTF-8");JSONObject input=new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("txId","offline-create-and-row").put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));f.store.stage(input,1);f.store.commit(input,1,TOKEN,false);
            assertEquals("1",f.store.get("needs_floor"));assertNull(f.store.get("resource_proofs"));f.store.parkWorkspace();f.store.resumeWorkspaceOffline(original,TOKEN);assertEquals("ready",f.open().getString("resourceAccess"));
            try(Cursor records=f.store.db.rawQuery("SELECT count(*) FROM records WHERE bucket='mutations' AND profile_id=?",new String[]{profile})){assertTrue(records.moveToFirst());assertEquals(2,records.getInt(0));}
            try{f.store.admitSync("POST","/api/sync",new byte[0],TOKEN,false,"native-owner");fail("Offline page/row SEND admitted");}catch(NativeOutbox.AccessRequired expected){}
        }
    }
    static JSONObject put(String bucket,Object key,JSONObject value)throws Exception{return new JSONObject().put("bucket",bucket).put("key",key).put("value",value).put("op","put");}
    @Test public void observedNewWorkspaceIncarnationPermanentlyRetiresOldParkedChild()throws Exception {
        try(Fixture f=new Fixture()) {
            JSONObject a=session("A",key("1"));String old=f.profile("A",key("1"));f.store.grant(a,TOKEN);f.open();f.anchor("A",key("1"));
            f.store.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts","old-incarnation-input",old,old+"|page","Original unsent input".getBytes("UTF-8")});f.store.parkWorkspace();
            JSONObject replacement=session("A",key("2"));replacement.getJSONObject("member").put("id","new-member-incarnation");f.store.grant(replacement,TOKEN);f.open();assertEquals("1",f.store.get("suspended:"+old));f.store.parkWorkspace();
            try{f.store.resumeWorkspaceOffline(a,TOKEN);fail("Old observed incarnation resurrected");}catch(NativeOutbox.RecoveryRequired expected){}
            try(Cursor rows=f.store.db.rawQuery("SELECT payload FROM records WHERE key='old-incarnation-input'",null)){assertTrue(rows.moveToFirst());assertEquals("Original unsent input",new String(rows.getBlob(0),"UTF-8"));}
        }
    }
    @Test public void lateDirectoryDenialRetiresOnlyExactCapturedChildAndLeavesCurrentBAndOrganization()throws Exception {
        try(Fixture f=new Fixture()) {
            String name="qa_denial_"+f.suffix,alias="qa.denial."+f.suffix;CookieVault vault=new CookieVault(f.context,name,alias,524288);FountainNativePlugin plugin=new FountainNativePlugin();
            try {
                JSONObject a=session("A",key("1")),b=session("B",key("2"));f.store.grant(a,TOKEN);f.open();f.anchor("A",key("1"));f.store.parkWorkspace();f.store.grant(b,TOKEN);f.open();f.anchor("B",key("2"));
                JSONObject visibleB=new JSONObject().put("workspaceId","B").put("memberId","member-B").put("binding",key("2")).put("accountBinding",PARENT).put("expiresAt",OutboxPolicy.expiry(b.getString("expires_at")));
                JSONObject visibleA=new JSONObject().put("workspaceId","A").put("memberId","member-A").put("binding",key("1")).put("accountBinding",PARENT).put("expiresAt",OutboxPolicy.expiry(a.getString("expires_at")));
                NativeCookieBoundary.install();set(plugin,"ownerBoundaryEpoch",NativeCookieBoundary.epoch());set(plugin,"origin",f.origin);set(plugin,"generation",1L);set(plugin,"accountOrigin",f.origin);set(plugin,"accountGeneration",1L);set(plugin,"accountVault",vault);set(plugin,"accountActive",TOKEN);set(plugin,"accountActiveBinding",PARENT);set(plugin,"accountExpiresAt",System.currentTimeMillis()+60000);set(plugin,"sealedWorkspaceScopes",new JSONObject().put("A",new JSONObject(visibleA.toString()).put("session",a)).put("B",new JSONObject(visibleB.toString()).put("session",b)));set(plugin,"workspaceScope",visibleB);set(plugin,"outbox",f.store);set(plugin,"workspaceEpoch",7L);set(plugin,"organizationActive","independent-org-cookie");
                Method method=FountainNativePlugin.class.getDeclaredMethod("applyAccountOpenDenial",String.class,String.class,String.class,String.class,int.class,byte[].class);method.setAccessible(true);long boundary=f.store.boundary();String lease=f.store.get("lease");
                method.invoke(plugin,"A",PARENT,key("1"),TOKEN,409,new JSONObject().put("code","WORKSPACE_SESSION_CHANGED").toString().getBytes("UTF-8"));assertNull(f.store.get("suspended:"+f.profile("A",key("1"))));
                method.invoke(plugin,"A",PARENT,key("9"),TOKEN,409,new JSONObject().put("code","WORKSPACE_GRANT_CHANGED").toString().getBytes("UTF-8"));assertNull(f.store.get("suspended:"+f.profile("A",key("1"))));
                method.invoke(plugin,"A",PARENT,key("1"),TOKEN,409,new JSONObject().put("code","WORKSPACE_GRANT_CHANGED").toString().getBytes("UTF-8"));assertEquals("1",f.store.get("suspended:"+f.profile("A",key("1"))));assertNull(f.store.get("suspended:"+f.profile("B",key("2"))));assertNotNull(f.store.verified(TOKEN,false));assertEquals(lease,f.store.get("lease"));assertEquals(boundary,f.store.boundary());assertEquals(7L,get(plugin,"workspaceEpoch"));assertEquals(visibleB.toString(),get(plugin,"workspaceScope").toString());assertEquals("independent-org-cookie",get(plugin,"organizationActive"));
            }finally{for(String executor:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,executor)).shutdownNow();f.context.getSharedPreferences(name,0).edit().clear().commit();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);}
        }
    }
    @Test public void trustedOpenSuccessRetiresChangedChildAndRoleChangeRequiresFreshCanonical()throws Exception {
        try(Fixture f=new Fixture()) {
            JSONObject a=session("A",key("1"));f.store.grant(a,TOKEN);f.open();f.anchor("A",key("1"));f.store.parkWorkspace();f.store.grant(session("B",key("2")),TOKEN);f.open();f.anchor("B",key("2"));String lease=f.store.get("lease");long boundary=f.store.boundary();
            JSONObject changed=session("A",key("3"));assertTrue(f.store.observeWorkspaceDirectorySession(changed,TOKEN));assertEquals("1",f.store.get("suspended:"+f.profile("A",key("1"))));assertEquals(lease,f.store.get("lease"));assertEquals(boundary,f.store.boundary());assertEquals(f.profile("B",key("2")),f.store.verified(TOKEN,false).getString("profileId"));
        }
        try(Fixture f=new Fixture()) {
            JSONObject a=session("A",key("1"));f.store.grant(a,TOKEN);f.open();f.anchor("A",key("1"));f.store.parkWorkspace();f.store.grant(session("B",key("2")),TOKEN);f.open();f.anchor("B",key("2"));String lease=f.store.get("lease");long boundary=f.store.boundary();
            JSONObject changed=new JSONObject(a.toString());changed.getJSONObject("member").put("role","guest");assertTrue(f.store.observeWorkspaceDirectorySession(changed,TOKEN));assertNull(f.store.get("suspended:"+f.profile("A",key("1"))));assertEquals("1",f.store.get("offline-denied:"+f.profile("A",key("1"))));assertEquals(lease,f.store.get("lease"));assertEquals(boundary,f.store.boundary());
            f.store.parkWorkspace();try{f.store.resumeWorkspaceOffline(a,TOKEN);fail("Known role change resumed old cached writable proof");}catch(NativeOutbox.RecoveryRequired expected){}
            f.store.grant(changed,TOKEN);JSONObject opened=f.open();assertEquals("verified",opened.getString("identityState"));assertEquals("required",opened.getString("resourceAccess"));assertNull(f.store.get("suspended:"+f.profile("A",key("1"))));assertEquals("1",f.store.get("offline-denied:"+f.profile("A",key("1"))));
            assertNull(f.store.admitSync("GET","/api/workspace",new byte[0],TOKEN,false,"native-owner"));
            JSONObject collecting=f.store.reconcile(new JSONObject().put("generation",1).put("phase","prepare").put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("mode","current"),1,TOKEN,false,"native-owner",0);
            NativeReconcile.Tag tag=f.store.admitReconcile(1,"GET","/api/workspace",TOKEN,false,"native-owner");JSONObject body=new JSONObject().put("workspace_id","A").put("current_member_id","member-A").put("session_binding",key("1")).put("access_revision",20).put("data_revision",20).put("pages",new JSONArray()).put("databases",new JSONArray());byte[] raw=body.toString().getBytes("UTF-8");f.store.beforeReconcileObservation(tag,TOKEN,false,"native-owner");f.store.observe("GET","/api/workspace",200,raw,TOKEN,false,"native-owner");f.store.captureReconcile(tag,200,raw,TOKEN,false,"native-owner");assertTrue(f.store.requiresWorkspaceReconcile());try{f.store.admitSync("POST","/api/sync",new byte[0],TOKEN,false,"native-owner");fail("Workspace GET bypassed canonical SEND barrier");}catch(NativeOutbox.AccessRequired expected){}
            JSONObject ready=f.store.reconcile(new JSONObject().put("generation",1).put("phase","prepare").put("lease",collecting.getString("lease")).put("planId",collecting.getString("planId")),1,TOKEN,false,"native-owner",1);assertEquals("ready",ready.getString("state"));
            f.store.reconcile(new JSONObject().put("generation",1).put("phase","commit").put("lease",ready.getString("lease")).put("baseHead",ready.getLong("baseHead")).put("proofEpoch",ready.getLong("proofEpoch")).put("planId",ready.getString("planId")).put("checksum",ready.getString("checksum")).put("confirm",true),1,TOKEN,false,"native-owner",1);
            assertNull(f.store.get("offline-denied:"+f.profile("A",key("1"))));assertEquals("guest",f.store.verified(TOKEN,false).getString("role"));assertFalse(f.store.requiresWorkspaceReconcile());
        }
    }
    @Test public void olderOpen200CannotRetireNewerPrivatelyActivatedChildOrRole()throws Exception {
        try(Fixture f=new Fixture()) {
            String name="qa_order_"+f.suffix,alias="qa.order."+f.suffix;CookieVault vault=new CookieVault(f.context,name,alias,524288);FountainNativePlugin plugin=new FountainNativePlugin();
            try {
                JSONObject fresh=session("A",key("2"));fresh.getJSONObject("member").put("role","guest");f.store.grant(fresh,TOKEN);f.open();f.anchor("A",key("2"));
                JSONObject scope=new JSONObject().put("workspaceId","A").put("memberId","member-A").put("binding",key("2")).put("accountBinding",PARENT).put("expiresAt",OutboxPolicy.expiry(fresh.getString("expires_at")));
                NativeCookieBoundary.install();set(plugin,"ownerBoundaryEpoch",NativeCookieBoundary.epoch());set(plugin,"origin",f.origin);set(plugin,"generation",1L);set(plugin,"accountOrigin",f.origin);set(plugin,"accountGeneration",1L);set(plugin,"accountVault",vault);set(plugin,"accountActive",TOKEN);set(plugin,"accountActiveBinding",PARENT);set(plugin,"accountExpiresAt",System.currentTimeMillis()+60000);set(plugin,"sealedWorkspaceScopes",new JSONObject().put("A",new JSONObject(scope.toString()).put("session",fresh)));set(plugin,"workspaceScope",scope);set(plugin,"workspaceEpoch",9L);set(plugin,"outbox",f.store);
                Method capture=FountainNativePlugin.class.getDeclaredMethod("nextWorkspaceObservation");capture.setAccessible(true);long oldOrder=(Long)capture.invoke(plugin),newOrder=(Long)capture.invoke(plugin);
                Method committed=FountainNativePlugin.class.getDeclaredMethod("commitWorkspaceObservation",String.class,long.class);committed.setAccessible(true);committed.invoke(plugin,"A",newOrder);
                JSONObject oldSession=session("A",key("1")),body=new JSONObject().put("workspace_id","A").put("account_binding",PARENT).put("session",oldSession);String lease=f.store.get("lease");long boundary=f.store.boundary();
                Method observe=FountainNativePlugin.class.getDeclaredMethod("applyAccountOpenEvidence",String.class,String.class,String.class,byte[].class,long.class);observe.setAccessible(true);observe.invoke(plugin,"A",PARENT,TOKEN,body.toString().getBytes("UTF-8"),oldOrder);
                assertNull(f.store.get("suspended:"+f.profile("A",key("2"))));assertNull(f.store.get("offline-denied:"+f.profile("A",key("2"))));assertEquals(lease,f.store.get("lease"));assertEquals(boundary,f.store.boundary());assertEquals(9L,get(plugin,"workspaceEpoch"));assertEquals(scope.toString(),get(plugin,"workspaceScope").toString());assertEquals("guest",f.store.verified(TOKEN,false).getString("role"));
                oldSession.put("cache_binding",key("2"));observe.invoke(plugin,"A",PARENT,TOKEN,body.put("session",oldSession).toString().getBytes("UTF-8"),oldOrder);assertNull(f.store.get("offline-denied:"+f.profile("A",key("2"))));assertEquals("guest",f.store.verified(TOKEN,false).getString("role"));
            }finally{for(String executor:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,executor)).shutdownNow();f.context.getSharedPreferences(name,0).edit().clear().commit();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);}
        }
    }
    @Test public void genericSessionObservationCannotOverrideNewerRoleOrBeOverriddenByOldOpen()throws Exception {
        try(Fixture f=new Fixture()) {
            String name="qa_generic_order_"+f.suffix,alias="qa.generic.order."+f.suffix;CookieVault vault=new CookieVault(f.context,name,alias,524288);FountainNativePlugin plugin=new FountainNativePlugin();
            try {
                JSONObject fresh=session("A",key("2"));fresh.getJSONObject("member").put("role","guest");f.store.grant(fresh,TOKEN);f.open();
                JSONObject scope=new JSONObject().put("workspaceId","A").put("memberId","member-A").put("binding",key("2")).put("accountBinding",PARENT).put("expiresAt",OutboxPolicy.expiry(fresh.getString("expires_at")));
                NativeCookieBoundary.install();set(plugin,"ownerBoundaryEpoch",NativeCookieBoundary.epoch());set(plugin,"origin",f.origin);set(plugin,"generation",1L);set(plugin,"accountOrigin",f.origin);set(plugin,"accountGeneration",1L);set(plugin,"accountVault",vault);set(plugin,"accountActive",TOKEN);set(plugin,"accountActiveBinding",PARENT);set(plugin,"accountExpiresAt",System.currentTimeMillis()+60000);set(plugin,"workspaceScope",scope);set(plugin,"workspaceEpoch",9L);set(plugin,"outbox",f.store);
                Method commit=FountainNativePlugin.class.getDeclaredMethod("commitWorkspaceObservation",String.class,long.class);commit.setAccessible(true);commit.invoke(plugin,"A",2L);
                Class<?> opClass=Class.forName("dev.fountain.workspace.FountainNativePlugin$Operation"),responseClass=Class.forName("dev.fountain.workspace.FountainNativePlugin$Response");Constructor<?> opConstructor=opClass.getDeclaredConstructors()[0];opConstructor.setAccessible(true);Constructor<?> responseConstructor=responseClass.getDeclaredConstructor();responseConstructor.setAccessible(true);
                Object operation=opConstructor.newInstance("generic-order",f.origin,1L,0L,null,false,true),response=responseConstructor.newInstance();
                for(Map.Entry<String,Object> item:new HashMap<String,Object>(){{put("workspaceEpoch",9L);put("workspacePrefix","/api/w/A/"+key("2"));put("observationWorkspace","A");put("observationOrder",1L);put("deadline",android.os.SystemClock.elapsedRealtime()+60000);}}.entrySet()){Field field=opClass.getDeclaredField(item.getKey());field.setAccessible(true);field.set(operation,item.getValue());}
                Field status=responseClass.getDeclaredField("status"),body=responseClass.getDeclaredField("body");status.setAccessible(true);body.setAccessible(true);status.set(response,200);JSONObject old=new JSONObject(fresh.toString());old.getJSONObject("member").put("role","owner");body.set(response,old.toString().getBytes("UTF-8"));
                Method apply=FountainNativePlugin.class.getDeclaredMethod("applySessionResponse",opClass,responseClass,boolean.class,boolean.class,String.class);apply.setAccessible(true);
                try{apply.invoke(plugin,operation,response,false,true,TOKEN);fail("Old generic session role overrode newer activation");}catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof IllegalArgumentException);}
                Field order=opClass.getDeclaredField("observationOrder");order.setAccessible(true);order.set(operation,3L);body.set(response,fresh.toString().getBytes("UTF-8"));apply.invoke(plugin,operation,response,false,true,TOKEN);
                Method observe=FountainNativePlugin.class.getDeclaredMethod("applyAccountOpenEvidence",String.class,String.class,String.class,byte[].class,long.class);observe.setAccessible(true);JSONObject payload=new JSONObject().put("workspace_id","A").put("account_binding",PARENT).put("session",old);observe.invoke(plugin,"A",PARENT,TOKEN,payload.toString().getBytes("UTF-8"),2L);
                assertEquals("guest",f.store.verified(TOKEN,false).getString("role"));assertNull(f.store.get("offline-denied:"+f.profile("A",key("2"))));
            }finally{for(String executor:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,executor)).shutdownNow();f.context.getSharedPreferences(name,0).edit().clear().commit();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);}
        }
    }
    @Test public void coldRetainedHintsArePublicBoundedAndExcludeExpiredOrSuspendedSQLScopes()throws Exception {
        try(Fixture f=new Fixture()) {
            String name="qa_hints_"+f.suffix,alias="qa.hints."+f.suffix;CookieVault vault=new CookieVault(f.context,name,alias,524288);FountainNativePlugin plugin=new FountainNativePlugin();
            try {
                JSONObject a=session("A",key("1")),b=session("B",key("2"));f.store.grant(a,TOKEN);f.open();f.anchor("A",key("1"));f.store.parkWorkspace();f.store.grant(b,TOKEN);f.open();
                JSONObject scopes=new JSONObject();for(JSONObject current:Arrays.asList(a,b)){String ws=current.getString("workspace_id");scopes.put(ws,new JSONObject().put("workspaceId",ws).put("memberId","member-"+ws).put("binding",current.getString("cache_binding")).put("accountBinding",PARENT).put("expiresAt",OutboxPolicy.expiry(current.getString("expires_at"))).put("session",current));}
                vault.write(new JSONObject().put("scopes",scopes));JSONObject sealed=new CookieVault(f.context,name,alias,524288).read();
                set(plugin,"origin",f.origin);set(plugin,"generation",1L);set(plugin,"accountVault",vault);set(plugin,"accountActive",TOKEN);set(plugin,"accountActiveBinding",PARENT);set(plugin,"accountExpiresAt",System.currentTimeMillis()+60000);set(plugin,"sealedWorkspaceScopes",sealed.getJSONObject("scopes"));set(plugin,"outbox",f.store);
                JSONObject config=(JSONObject)invoke(plugin,"configuration");JSONArray hints=config.getJSONArray("retainedWorkspaceScopes");assertEquals(2,hints.length());for(int i=0;i<2;i++){assertEquals(5,hints.getJSONObject(i).length());assertFalse(hints.getJSONObject(i).has("session"));assertFalse(hints.getJSONObject(i).has("cookie"));}
                sealed.getJSONObject("scopes").getJSONObject("A").put("expiresAt",System.currentTimeMillis()-1);assertEquals(1,((JSONObject)invoke(plugin,"configuration")).getJSONArray("retainedWorkspaceScopes").length());
                f.store.revokeAccountWorkspaces();assertEquals(0,((JSONObject)invoke(plugin,"configuration")).getJSONArray("retainedWorkspaceScopes").length());
            } finally {for(String executor:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,executor)).shutdownNow();f.context.getSharedPreferences(name,0).edit().clear().commit();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);}
        }
    }
    @Test public void sealedOfflineProofRequiresSameParentChildMemberExactExpiryAndLiveVault()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();String suffix=UUID.randomUUID().toString().replace("-", ""),name="qa_offline_"+suffix,alias="qa.offline."+suffix;
        FountainNativePlugin plugin=new FountainNativePlugin();CookieVault vault=new CookieVault(context,name,alias);long expiry=System.currentTimeMillis()+60000;
        try { NativeCookieBoundary.install();set(plugin,"ownerBoundaryEpoch",NativeCookieBoundary.epoch());set(plugin,"origin","https://offline.invalid");set(plugin,"generation",1L);set(plugin,"accountActive",TOKEN);set(plugin,"accountActiveBinding",PARENT);set(plugin,"accountExpiresAt",expiry);set(plugin,"accountVault",vault);
            JSONObject sealed=new JSONObject().put("workspaceId","A").put("memberId","member-A").put("binding",key("1")).put("accountBinding",PARENT).put("expiresAt",expiry).put("session",session("A",key("1")));set(plugin,"sealedWorkspaceScopes",new JSONObject().put("A",sealed));
            JSONObject wire=new JSONObject().put("generation",1).put("workspace_id","A").put("member_id","member-A").put("session_binding",key("1")).put("account_binding",PARENT).put("expires_at_ms",expiry);
            Method method=FountainNativePlugin.class.getDeclaredMethod("offlineWorkspaceProof",JSONObject.class);method.setAccessible(true);assertEquals(sealed.toString(),method.invoke(plugin,wire).toString());
            for(String field:Arrays.asList("workspace_id","member_id","session_binding","account_binding","expires_at_ms")){JSONObject wrong=new JSONObject(wire.toString()).put(field,field.equals("expires_at_ms")?expiry+1:field.equals("workspace_id")?"B":field.equals("member_id")?"other":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");try{method.invoke(plugin,wrong);fail("Wrong sealed proof accepted "+field);}catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof IllegalArgumentException);}}
            set(plugin,"accountExpiresAt",System.currentTimeMillis()-1);try{method.invoke(plugin,wire);fail("Expired account resumed offline");}catch(InvocationTargetException expected){}
            set(plugin,"accountExpiresAt",expiry);assertTrue(vault.markInvalidated("https://offline.invalid"));try{method.invoke(plugin,wire);fail("Quarantined account resumed offline");}catch(InvocationTargetException expected){}
        }finally{for(String executor:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,executor)).shutdownNow();context.getSharedPreferences(name,0).edit().clear().commit();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);}
    }
    @Test public void accountCiphertextAndQuarantineNeverMutateOrganizationOrLegacyVault()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();String suffix=UUID.randomUUID().toString().replace("-","");
        String[] names={"qa_account_"+suffix,"qa_org_"+suffix,"qa_legacy_"+suffix},aliases={"qa.account."+suffix,"qa.org."+suffix,"qa.legacy."+suffix};
        FountainNativePlugin plugin=new FountainNativePlugin();CookieVault[] vaults=new CookieVault[3];
        try {
            NativeCookieBoundary.install();set(plugin,"ownerBoundaryEpoch",NativeCookieBoundary.epoch());set(plugin,"origin","https://multiworkspace.invalid");set(plugin,"generation",1L);set(plugin,"accountOrigin","https://multiworkspace.invalid");set(plugin,"accountGeneration",1L);
            for(int i=0;i<3;i++){vaults[i]=new CookieVault(context,names[i],aliases[i]);vaults[i].write(new JSONObject().put("realm",i));}
            String org=context.getSharedPreferences(names[1],0).getString("sealed",null),legacy=context.getSharedPreferences(names[2],0).getString("sealed",null);
            set(plugin,"accountVault",vaults[0]);set(plugin,"accountActive",TOKEN);set(plugin,"accountActiveBinding",PARENT);invoke(plugin,"quarantineAccount");
            JSONObject persisted=vaults[0].read();assertTrue(persisted.isNull("active"));assertEquals(TOKEN,persisted.getString("revoke"));assertEquals(PARENT,persisted.getString("revoke_binding"));
            assertEquals(org,context.getSharedPreferences(names[1],0).getString("sealed",null));assertEquals(legacy,context.getSharedPreferences(names[2],0).getString("sealed",null));
            context.getSharedPreferences(names[1],0).edit().putString("sealed",context.getSharedPreferences(names[0],0).getString("sealed",null)).commit();
            try{vaults[1].read();fail("Account encrypted state opened in organization realm");}catch(java.security.GeneralSecurityException expected){}
        }finally{for(String name:Arrays.asList("workers","sessions","deadlines","organizationWorkers","accountWorkers"))((ExecutorService)get(plugin,name)).shutdownNow();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);for(int i=0;i<3;i++){context.getSharedPreferences(names[i],0).edit().clear().commit();keys.deleteEntry(aliases[i]);}}
    }
    static void set(Object object,String key,Object value)throws Exception{Field field=FountainNativePlugin.class.getDeclaredField(key);field.setAccessible(true);field.set(object,value);}
    static Object get(Object object,String key)throws Exception{Field field=FountainNativePlugin.class.getDeclaredField(key);field.setAccessible(true);return field.get(object);}
    static Object invoke(Object object,String key)throws Exception{Method method=FountainNativePlugin.class.getDeclaredMethod(key);method.setAccessible(true);return method.invoke(object);}
}
