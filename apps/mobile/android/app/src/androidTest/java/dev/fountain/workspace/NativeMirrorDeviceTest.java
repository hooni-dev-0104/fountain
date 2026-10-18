package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual production registry/SQLite fixtures. No Activity, provider or held app state. */
@RunWith(AndroidJUnit4.class)
public class NativeMirrorDeviceTest {
    private static final String COOKIE="abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE",PARENT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",OWNER="mirror-owner";
    private static JSONObject session(String ws,String member,String child,String parent)throws Exception {
        JSONObject value=MultiworkspaceDeviceTest.session(ws,child);value.getJSONObject("member").put("id",member);value.put("account_binding",parent);return value;
    }
    private static class Fixture implements AutoCloseable {
        final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String origin="https://mirror-"+UUID.randomUUID().toString().replace("-","")+".invalid";
        final File file=new File(context.getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite");
        NativeOutbox store=new NativeOutbox(context,origin);long sequence;String cookie=COOKIE;JSONObject current;
        Fixture()throws Exception{}
        JSONObject activate(String ws,String member,int child,String parent)throws Exception {current=session(ws,member,String.format("%032d",child),parent);store.grant(current,cookie);return open();}
        JSONObject open()throws Exception{return store.open(1,cookie,false,OWNER);}
        JSONObject input(String action)throws Exception {JSONObject identity=open();return new JSONObject().put("version",1).put("generation",1).put("action",action).put("expectedProfileId",identity.getString("profileId")).put("expectedEpoch",identity.getLong("proofEpoch"));}
        JSONObject mirror(String action)throws Exception{return store.mirror(input(action),1,cookie,false,OWNER);}
        JSONObject mirror(JSONObject input)throws Exception{return store.mirror(input,1,cookie,false,OWNER);}
        void canonical()throws Exception {
            JSONObject identity=open(),input=new JSONObject().put("generation",1).put("phase","prepare").put("lease",identity.getString("lease")).put("baseHead",identity.getLong("head")).put("proofEpoch",identity.getLong("proofEpoch")).put("mode","current");
            JSONObject result=store.reconcile(input,1,cookie,false,OWNER,sequence);
            for(int pass=0;result.optString("state").equals("collecting");pass++){
                assertTrue("Bounded empty-workspace canonical fixture",pass<4);JSONArray needed=result.getJSONArray("needed");
                for(int i=0;i<needed.length();i++){assertEquals("workspace",needed.getJSONObject(i).getString("kind"));NativeReconcile.Tag tag=store.admitReconcile(++sequence,"GET","/api/workspace",cookie,false,OWNER);
                    JSONObject body=new JSONObject().put("workspace_id",current.getString("workspace_id")).put("current_member_id",current.getJSONObject("member").getString("id")).put("session_binding",current.getString("cache_binding")).put("access_revision",10).put("data_revision",10).put("pages",new JSONArray()).put("databases",new JSONArray());byte[] raw=body.toString().getBytes("UTF-8");store.beforeReconcileObservation(tag,cookie,false,OWNER);store.observe("GET","/api/workspace",200,raw,cookie,false,OWNER);store.captureReconcile(tag,200,raw,cookie,false,OWNER);}
                result=store.reconcile(new JSONObject().put("generation",1).put("phase","prepare").put("lease",result.getString("lease")).put("planId",result.getString("planId")),1,cookie,false,OWNER,sequence);
            }
            assertEquals("ready",result.getString("state"));store.reconcile(new JSONObject().put("generation",1).put("phase","commit").put("lease",result.getString("lease")).put("baseHead",result.getLong("baseHead")).put("proofEpoch",result.getLong("proofEpoch")).put("planId",result.getString("planId")).put("checksum",result.getString("checksum")).put("confirm",result.getBoolean("requiresConfirmation")),1,cookie,false,OWNER,sequence);assertFalse(store.requiresWorkspaceReconcile());
        }
        void reopen()throws Exception{store.close();store=new NativeOutbox(context,origin);open();}
        public void close(){store.close();assertTrue(file.delete());}
    }
    private interface Attempt {void run()throws Exception;}
    private static void rejected(Attempt action)throws Exception{try{action.run();fail("Invalid mirror admission accepted");}catch(NativeOutbox.AccessRequired|IllegalArgumentException|NativeMirrorRegistry.Conflict expected){}}
    private static String ref(JSONObject value)throws Exception{return value.getJSONObject("pair").getString("ref");}
    private static Set<String> keys(JSONObject value){Set<String> names=new HashSet<>();Iterator<String> iterator=value.keys();while(iterator.hasNext())names.add(iterator.next());return names;}
    private static long rows(Fixture f,String table)throws Exception{try(Cursor c=f.store.db.rawQuery("SELECT count(*) FROM "+table,null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private static void envelope(JSONObject value)throws Exception {
        Set<String> names=new HashSet<>();Iterator<String> it=value.keys();while(it.hasNext())names.add(it.next());assertEquals(new HashSet<>(Arrays.asList("generation","version","profileId","epoch","pair","baseDisposition")),names);
        assertEquals(1,value.getInt("version"));NativeMirrorPolicy.pair(value.getJSONObject("pair").getString("kind"),ref(value));
    }
    @Test public void baseCandidatePinsOnlyAfterCanonicalAndStaleEpochNeverBecomesIdempotent()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("A","member-A",1,PARENT);JSONObject first=f.mirror("resolve"),stale=f.input("confirm-base");envelope(first);assertEquals("candidate",first.getString("baseDisposition"));assertEquals("base",ref(first));assertEquals(0,rows(f,"native_profile_mirrors_v1"));rejected(()->f.mirror("confirm-base"));
            f.store.parkWorkspace();f.activate("B","member-B",2,PARENT);assertEquals("candidate",f.mirror("resolve").getString("baseDisposition"));assertEquals(0,rows(f,"native_profile_mirrors_v1"));f.store.parkWorkspace();f.activate("A","member-A",1,PARENT);
            f.canonical();rejected(()->f.mirror(stale));long head=f.store.head(),epoch=f.store.proofEpoch();String lease=f.store.get("lease"),floor=f.store.get("needs_floor"),deadline=f.store.get("grant");
            JSONObject pinned=f.mirror("confirm-base");envelope(pinned);assertEquals("current",pinned.getString("baseDisposition"));assertEquals(1,rows(f,"native_profile_mirrors_v1"));assertEquals(ref(pinned),ref(f.mirror("confirm-base")));assertEquals(head,f.store.head());assertEquals(epoch,f.store.proofEpoch());assertEquals(lease,f.store.get("lease"));assertEquals(floor,f.store.get("needs_floor"));assertEquals(deadline,f.store.get("grant"));
            JSONObject bad=f.input("resolve").put("expectedEpoch",epoch-1);rejected(()->f.mirror(bad));
        }
    }
    @Test public void privateBLocationPrecedesHydrationAndWarmColdABARetainsBaseAndSources()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("A","member-A",1,PARENT);f.canonical();String a=f.open().getString("profileId");f.mirror("confirm-base");byte[] original="A original ops/mutation/IME/forms/upload bytes".getBytes("UTF-8");f.store.db.execSQL("INSERT INTO recovery VALUES('mirror-original','fixture',?)",new Object[]{original});
            f.store.parkWorkspace();f.activate("B","member-B",2,PARENT);JSONObject b=f.mirror("resolve");assertTrue(ref(b).matches("v1-[a-f0-9]{64}"));assertEquals("preserved",b.getString("baseDisposition"));assertEquals("1",f.store.get("needs_floor"));assertEquals("B",f.store.verified(COOKIE,false).getJSONObject("session").getString("workspace_id"));
            JSONObject catalog=f.mirror("catalog");assertEquals(2,catalog.getJSONArray("entries").length());assertTrue(catalog.getJSONArray("entries").getJSONObject(1).getBoolean("unresolved"));assertFalse(catalog.getJSONArray("entries").getJSONObject(0).getBoolean("unresolved"));f.canonical();rejected(()->f.mirror("confirm-base"));
            String bRef=ref(b);f.reopen();assertEquals(bRef,ref(f.mirror("resolve")));f.store.parkWorkspace();f.activate("A","member-A",1,PARENT);assertEquals(a,f.open().getString("profileId"));assertEquals("base",ref(f.mirror("resolve")));f.store.parkWorkspace();f.activate("B","member-B",2,PARENT);assertEquals(bRef,ref(f.mirror("resolve")));
            try(Cursor c=f.store.db.rawQuery("SELECT payload FROM recovery WHERE id='mirror-original'",null)){assertTrue(c.moveToFirst());assertArrayEquals(original,c.getBlob(0));}
        }
    }
    @Test public void explicitSeparatePreservesUnassignedBaseAndLostReplyUsesPrivateLookup()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("A","member-A",1,PARENT);assertEquals("candidate",f.mirror("resolve").getString("baseDisposition"));JSONObject separate=f.mirror("separate");assertEquals("unresolved",separate.getString("baseDisposition"));String opaque=ref(separate);assertEquals(opaque,ref(f.mirror("separate")));f.reopen();assertEquals(opaque,ref(f.mirror("resolve")));f.canonical();rejected(()->f.mirror("confirm-base"));
            f.store.parkWorkspace();f.activate("B","member-B",2,PARENT);assertEquals("base",ref(f.mirror("resolve")));f.canonical();f.mirror("confirm-base");f.store.parkWorkspace();f.activate("A","member-A",1,PARENT);assertEquals(opaque,ref(f.mirror("resolve")));assertEquals("preserved",f.mirror("resolve").getString("baseDisposition"));
        }
    }
    @Test public void exactFieldsPrivateOwnerRealmAndEpochRejectForgedRegistryClaims()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("A","member-A",1,PARENT);JSONObject original=f.input("resolve");
            for(String field:Arrays.asList("ref","pair","owner","actor","hash","digest","workspaceEpoch","sourceProfile")){JSONObject forged=new JSONObject(original.toString()).put(field,"forged");rejected(()->f.mirror(forged));}
            rejected(()->f.mirror(new JSONObject(original.toString()).put("expectedProfileId","another-profile")));rejected(()->f.mirror(new JSONObject(original.toString()).put("generation",2)));rejected(()->f.store.mirror(original,1,COOKIE,false,"wrong-owner"));rejected(()->f.store.mirror(original,1,"different-cookie",false,OWNER));rejected(()->f.store.mirror(original,1,COOKIE,true,OWNER));
            String persisted=f.store.get("proof_epoch");f.store.set("proof_epoch",Long.toString(Long.parseLong(persisted)+1));rejected(()->f.mirror(original));f.store.set("proof_epoch",persisted);
            JSONObject legacy=new JSONObject(f.current.toString());legacy.remove("account_binding");f.store.parkWorkspace();f.store.grant(legacy,COOKIE);f.open();rejected(()->f.mirror("resolve"));assertEquals(0,rows(f,"native_profile_mirrors_v1"));
        }
    }
    @Test public void catalogOnlyNativeSameActorMetadataAndOpaqueCursorRejectsStaleForeignTokens()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("other","other-member",1,PARENT);f.canonical();f.mirror("confirm-base");f.store.parkWorkspace();f.activate("other","other-member",2,PARENT);String foreign=ref(f.mirror("resolve"));
            List<String> older=new ArrayList<>();for(int i=1;i<=4;i++){f.store.parkWorkspace();f.activate("A","member-A",10+i,PARENT);older.add(ref(f.mirror("resolve")));}
            JSONObject request=f.input("catalog").put("limit",1),first=f.mirror(request);String next=first.getString("next"),current=ref(first);Set<String> refs=new LinkedHashSet<>();refs.add(ref(first.getJSONArray("entries").getJSONObject(0)));
            for(int pages=0;next!=null;pages++){assertTrue(pages<10);JSONObject page=f.mirror(new JSONObject(request.toString()).put("cursor",next));assertEquals(1,page.getJSONArray("entries").length());JSONObject entry=page.getJSONArray("entries").getJSONObject(0);refs.add(ref(entry));assertEquals(new HashSet<>(Arrays.asList("pair","relation","unresolved")),keys(entry));next=page.isNull("next")?null:page.getString("next");}
            assertEquals(5,refs.size());assertFalse(refs.contains(foreign));assertTrue(refs.contains("base"));assertTrue(refs.containsAll(older));String raw=f.mirror("catalog").toString();assertFalse(raw.contains("other-member"));assertFalse(raw.contains("session_ref"));assertFalse(raw.contains("incarnation"));assertFalse(raw.contains(foreign));
            rejected(()->f.mirror(new JSONObject(request.toString()).put("cursor","v1-"+String.join("",Collections.nCopies(64,"0")))));rejected(()->f.mirror(new JSONObject(request.toString()).put("limit",101)));rejected(()->f.mirror(new JSONObject(request.toString()).put("limit",0)));
            JSONObject freshPage=f.mirror(f.input("catalog").put("limit",1));String stale=freshPage.getString("next");long beforeEpoch=f.store.proofEpoch();f.store.open(1,f.cookie,false,"cold-owner");assertTrue(f.store.proofEpoch()>beforeEpoch);f.open();rejected(()->f.mirror(f.input("catalog").put("cursor",stale)));assertEquals(current,ref(f.mirror("resolve")));
            try(Cursor plan=f.store.db.rawQuery("EXPLAIN QUERY PLAN SELECT sequence,ref FROM native_profile_mirrors_v1 WHERE actor=? AND kind='profile' AND ref<>? AND sequence>? ORDER BY sequence LIMIT ?",new String[]{OutboxPolicy.actorPrefix(f.origin,f.open().getString("profileId")),current,"0","20"})){boolean indexed=false;while(plan.moveToNext())indexed|=plan.getString(3).contains("native_profile_mirrors_actor_v1");assertTrue(indexed);}
        }
    }
    @Test public void samePublicProfileWithDifferentPrivateParentOrSessionGetsAnotherLocation()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("other","other-member",1,PARENT);f.canonical();f.mirror("confirm-base");f.store.parkWorkspace();f.activate("A","member-A",2,PARENT);String old=ref(f.mirror("resolve")),publicProfile=f.open().getString("profileId");
            JSONObject forced=new JSONObject(f.store.get("grant"));forced.getJSONObject("session").put("account_binding","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");forced.put("session_ref",OutboxPolicy.hash("different-private-session"));f.store.set("grant",forced.toString());f.cookie="different-private-session";f.open();
            JSONObject fresh=f.mirror("resolve");assertEquals(publicProfile,fresh.getString("profileId"));assertNotEquals(old,ref(fresh));boolean recovered=false;JSONArray entries=f.mirror("catalog").getJSONArray("entries");for(int i=0;i<entries.length();i++){JSONObject entry=entries.getJSONObject(i);if(ref(entry).equals(old)){recovered=true;assertEquals("recovery",entry.getString("relation"));assertTrue(entry.getBoolean("unresolved"));}}assertTrue(recovered);
        }
    }
    @Test public void sealedCachedOfflineBaseConfirmationNeverClearsSendFloorOrExtendsTTL()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("A","member-A",1,PARENT);f.canonical();JSONObject sealed=new JSONObject(f.current.toString());f.store.parkWorkspace();f.store.resumeWorkspaceOffline(sealed,COOKIE);f.open();String grant=f.store.get("grant"),needs=f.store.get("needs_floor"),reconcile=f.store.get("account_reconcile_required");long head=f.store.head(),epoch=f.store.proofEpoch();
            assertEquals("ready",f.open().getString("resourceAccess"));assertEquals("base",ref(f.mirror("confirm-base")));assertEquals(grant,f.store.get("grant"));assertEquals(needs,f.store.get("needs_floor"));assertEquals(reconcile,f.store.get("account_reconcile_required"));assertEquals(head,f.store.head());assertEquals(epoch,f.store.proofEpoch());rejected(()->f.store.admitSync("POST","/api/sync",new byte[0],COOKIE,false,OWNER));
            f.store.revokeAccountWorkspaces();rejected(()->f.mirror("resolve"));
        }
    }
    @Test public void partialMetadataCommitFailureRollsBackWithoutChangingBusinessOrCandidate()throws Exception {
        try(Fixture f=new Fixture()){
            f.activate("A","member-A",1,PARENT);String original=f.store.get("grant");long head=f.store.head(),epoch=f.store.proofEpoch();
            f.store.db.execSQL("CREATE TEMP TRIGGER mirror_failure BEFORE UPDATE ON native_mirror_state_v1 BEGIN SELECT RAISE(ABORT,'fixture quota'); END");
            try{f.mirror("separate");fail("Registry metadata fault accepted");}catch(android.database.sqlite.SQLiteException expected){}
            assertEquals(0,rows(f,"native_profile_mirrors_v1"));assertEquals(original,f.store.get("grant"));assertEquals(head,f.store.head());assertEquals(epoch,f.store.proofEpoch());f.store.db.execSQL("DROP TRIGGER mirror_failure");assertEquals("candidate",f.mirror("resolve").getString("baseDisposition"));
        }
    }
}
