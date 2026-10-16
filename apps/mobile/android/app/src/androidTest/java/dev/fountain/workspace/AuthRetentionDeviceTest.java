package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual Android SQLite policy test; synthetic native grants, no renderer bypass. */
@RunWith(AndroidJUnit4.class)
public class AuthRetentionDeviceTest {
    interface Action {void run()throws Exception;}
    private static void recovery(Action action)throws Exception {try{action.run();fail("Suspended native binding was reactivated");}catch(NativeOutbox.RecoveryRequired expected){}}
    private static void access(Action action)throws Exception {try{action.run();fail("Missing native authority was accepted");}catch(NativeOutbox.AccessRequired expected){}}
    private static String control(SQLiteDatabase db,String key){try(Cursor c=db.rawQuery("SELECT value FROM control WHERE key=?",new String[]{key})){return c.moveToFirst()?c.getString(0):null;}}
    private static void set(SQLiteDatabase db,String key,String value){db.execSQL("INSERT OR REPLACE INTO control VALUES(?,?)",new Object[]{key,value});}
    private static void seed(SQLiteDatabase db,String profile,String key){db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts",key,profile,profile+"|page",("private "+key+" 🏠").getBytes(StandardCharsets.UTF_8)});}
    private static JSONObject scope(JSONObject opened)throws Exception{return new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("head",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("byteLimit",1024);}
    private static JSONObject stage(JSONObject opened,String tx,JSONObject delta)throws Exception {byte[] bytes=delta.toString().getBytes(StandardCharsets.UTF_8);return scope(opened).put("txId",tx).put("part",0).put("baseHead",opened.getLong("head")).put("bytesBase64",OutboxPolicy.base64(bytes)).put("digest",OutboxPolicy.hash(bytes));}
    private static JSONObject workspace(String binding)throws Exception{return new JSONObject().put("workspace_id","retention-workspace").put("current_member_id","retention-member").put("session_binding",binding).put("access_revision",10).put("data_revision",10).put("pages",new JSONArray()).put("databases",new JSONArray());}
    private static final class Fixture implements AutoCloseable {
        final String origin="https://retention-"+UUID.randomUUID()+".invalid";final File source;final NativeOutbox outbox;final SQLiteDatabase db;
        Fixture()throws Exception {Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();source=new File(context.getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite");outbox=new NativeOutbox(context,origin);db=SQLiteDatabase.openDatabase(source.getPath(),null,SQLiteDatabase.OPEN_READWRITE|SQLiteDatabase.NO_LOCALIZED_COLLATORS);}
        String profile(String binding)throws Exception{return OutboxPolicy.profile(origin,"retention-workspace","retention-member",binding);}
        JSONObject open()throws Exception{return outbox.open(1,null,false,"fixture-owner");}
        void anchor(String binding)throws Exception {outbox.observe("GET","/api/workspace",200,workspace(binding).toString().getBytes(StandardCharsets.UTF_8),null,false,"fixture-owner");}
        public void close(){db.close();outbox.close();assertTrue(source.delete());}
    }
    private static int count(SQLiteDatabase db,String table){try(Cursor c=db.rawQuery("SELECT count(*) FROM "+table,null)){assertTrue(c.moveToFirst());return c.getInt(0);}}
    private static JSONObject session(String binding)throws Exception{return new JSONObject().put("authenticated",true).put("required",false).put("mode","local").put("workspace_id","retention-workspace").put("cache_binding",binding).put("member",new JSONObject().put("id","retention-member").put("role","owner").put("active",true));}
    @Test public void passiveSuspensionPreservesEverySourceRow()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();String origin="https://retention-"+UUID.randomUUID()+".invalid";
        File source=new File(context.getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite");
        NativeOutbox outbox=new NativeOutbox(context,origin);
        try(SQLiteDatabase inspector=SQLiteDatabase.openDatabase(source.getPath(),null,SQLiteDatabase.OPEN_READWRITE|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
            String profile=OutboxPolicy.profile(origin,"retention-workspace","retention-member","binding-a");outbox.grant(session("binding-a"),null);
            inspector.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts","fixture",profile,profile+"|page","last unsent input 🏠".getBytes(StandardCharsets.UTF_8)});
            inspector.execSQL("INSERT INTO recovery VALUES('private-original','unknown',?)",new Object[]{new byte[]{0,1,2,3}});
            inspector.execSQL("INSERT INTO tx_receipts VALUES('accepted','digest',1)");
            inspector.execSQL("INSERT INTO staging VALUES('uncertain',0,0,'old-lease',?)",new Object[]{new byte[]{5,6,7}});
            outbox.revoke();
            assertEquals("Passive auth invalidation must keep the last source copy",1,count(inspector,"records"));
            assertEquals(1,count(inspector,"recovery"));assertEquals(1,count(inspector,"tx_receipts"));assertEquals(1,count(inspector,"staging"));
        } finally {outbox.close();assertTrue(source.delete());}
    }
    @Test public void suspendedAndExpiredBindingsNeverReactivateButFreshBindingDoes()throws Exception {
        try(Fixture f=new Fixture()){
            f.outbox.grant(session("a"),null);JSONObject initial=f.open();long until=initial.getLong("validUntil");
            f.outbox.grant(session("a"),null);JSONObject stable=f.open();assertEquals(initial.getString("lease"),stable.getString("lease"));assertEquals(initial.getLong("head"),stable.getLong("head"));assertEquals(initial.getLong("proofEpoch"),stable.getLong("proofEpoch"));assertEquals(until,stable.getLong("validUntil"));
            access(()->f.outbox.read(scope(stable),1,null,false));f.anchor("a");assertEquals(0,f.outbox.read(scope(f.open()),1,null,false).getJSONArray("fragments").length());
            seed(f.db,f.profile("a"),"old-a");String oldHead=control(f.db,"head"),oldProof=control(f.db,"proof_epoch"),oldLease=control(f.db,"lease");
            f.outbox.revoke();assertEquals(1,count(f.db,"records"));assertNotEquals(oldHead,control(f.db,"head"));assertNotEquals(oldProof,control(f.db,"proof_epoch"));assertNotEquals(oldLease,control(f.db,"lease"));
            assertEquals("1",control(f.db,"suspended:"+f.profile("a")));recovery(()->f.open());recovery(()->f.outbox.grant(session("a"),null));recovery(()->f.outbox.read(scope(stable),1,null,false));recovery(()->f.outbox.stage(scope(stable),1));recovery(()->f.outbox.commit(scope(stable),1,null,false));
            f.outbox.grant(session("b"),null);JSONObject fresh=f.open();assertEquals(f.profile("b"),fresh.getString("profileId"));assertEquals("required",fresh.getString("resourceAccess"));access(()->f.outbox.read(scope(fresh),1,null,false));f.anchor("b");assertEquals(0,f.outbox.read(scope(f.open()),1,null,false).getJSONArray("fragments").length());assertEquals(1,count(f.db,"records"));
            JSONObject expired=new JSONObject(control(f.db,"grant")).put("validUntil",System.currentTimeMillis()-1);set(f.db,"grant",expired.toString());recovery(()->f.outbox.grant(session("b"),null));assertEquals("1",control(f.db,"suspended:"+f.profile("b")));assertEquals("blocked",control(f.db,"identity_state"));recovery(()->f.open());assertEquals(1,count(f.db,"records"));
        }
    }
    @Test public void jsProfileCleanupPreservesArchiveAndUnknownParts()throws Exception {
        try(Fixture f=new Fixture()){
            f.outbox.grant(session("a"),null);f.open();f.anchor("a");seed(f.db,f.profile("a"),new JSONArray().put(f.profile("a")+"|page").put("unknown").toString());
            JSONObject delta=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("bucket","profiles").put("op","delete").put("key",f.profile("a"))));JSONObject intent=stage(f.open(),"cleanup",delta);
            f.outbox.stage(intent,1);assertEquals(f.profile("a"),control(f.db,"staging-owner:cleanup"));f.outbox.commit(intent,1,null,false);assertEquals(1,count(f.db,"records"));assertEquals("1",control(f.db,"suspended:"+f.profile("a")));assertEquals(f.profile("a"),control(f.db,"receipt-owner:cleanup"));
            recovery(()->f.outbox.grant(session("a"),null));f.outbox.grant(session("b"),null);f.open();f.anchor("b");
            recovery(()->f.outbox.stage(intent.put("lease",f.open().getString("lease")),1));
            JSONObject quarantine=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",new JSONArray().put(new JSONObject().put("bucket","drafts").put("op","delete").put("key",new JSONArray().put(f.profile("a")+"|page").put("unknown"))));JSONObject delete=stage(f.open(),"quarantine-delete",quarantine);f.outbox.stage(delete,1);f.outbox.commit(delete,1,null,false);assertEquals(1,count(f.db,"records"));
            f.db.execSQL("INSERT INTO staging VALUES('legacy',0,0,'old-lease',?)",new Object[]{new byte[]{8,9}});set(f.db,"staging-owner:legacy",f.profile("a"));f.outbox.open(1,null,false,"restarted-owner");assertEquals(1,count(f.db,"staging"));
            String digest=OutboxPolicy.hash(new byte[]{8,9});f.db.execSQL("INSERT INTO tx_receipts VALUES('legacy',?,1)",new Object[]{digest});set(f.db,"receipt-proof:legacy","1");
            f.outbox.commit(scope(f.outbox.open(1,null,false,"restarted-owner")).put("txId","legacy").put("digest",digest),1,null,false);assertEquals("Legacy receipt cannot delete another profile's uncertain parts",1,count(f.db,"staging"));
        }
    }
    @Test public void rendererRevocationAndArchiveOverwriteNeverDeleteLastCopy()throws Exception {
        try(Fixture f=new Fixture()){
            f.outbox.grant(session("a"),null);f.open();f.anchor("a");seed(f.db,f.profile("a"),"last-old-copy");
            String oldResource=f.profile("a")+"|page";JSONArray oldKey=new JSONArray().put(oldResource).put("old-client");byte[] oldInput="old active unsent last copy".getBytes(StandardCharsets.UTF_8);
            f.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"active","drafts",oldKey.toString(),f.profile("a"),oldResource,oldInput});
            JSONObject revoke=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("bucket","meta").put("op","put").put("key","revoked:"+f.profile("a")).put("value",new JSONObject().put("id","revoked:"+f.profile("a")))));
            JSONObject invalidation=stage(f.open(),"renderer-revoked",revoke);f.outbox.stage(invalidation,1);f.outbox.commit(invalidation,1,null,false);assertEquals(2,count(f.db,"records"));recovery(()->f.open());
            f.outbox.grant(session("b"),null);f.open();f.anchor("b");String resource=f.profile("b")+"|page";JSONArray key=new JSONArray().put(resource).put("client");
            JSONObject oldDelete=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("bucket","drafts").put("op","delete").put("key",oldKey)));JSONObject removal=stage(f.open(),"old-active-delete",oldDelete);f.outbox.stage(removal,1);f.outbox.commit(removal,1,null,false);assertEquals("Renderer DELETE cannot erase suspended active records",2,count(f.db,"records"));
            JSONObject oldRevoke=new JSONObject().put("version",1).put("origin",f.origin).put("mode","active").put("changes",new JSONArray().put(new JSONObject().put("bucket","meta").put("op","put").put("key","revoked-resource:"+oldResource).put("value",new JSONObject().put("id","revoked-resource:"+oldResource))));JSONObject resourceCleanup=stage(f.open(),"old-resource-revoke",oldRevoke);f.outbox.stage(resourceCleanup,1);recovery(()->f.outbox.commit(resourceCleanup,1,null,false));assertEquals(2,count(f.db,"records"));
            JSONObject original=new JSONObject().put("profileId",f.profile("b")).put("key",resource).put("clientId","client").put("draft",new JSONObject().put("blocks",new JSONArray().put(new JSONObject().put("id","p").put("type","paragraph").put("text","last exact input"))));
            f.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts",key.toString(),f.profile("b"),resource,original.toString().getBytes(StandardCharsets.UTF_8)});
            JSONObject edited=new JSONObject(original.toString());edited.getJSONObject("draft").getJSONArray("blocks").getJSONObject(0).put("text","must not overwrite original");
            JSONObject overwrite=new JSONObject().put("version",1).put("origin",f.origin).put("mode","quarantine").put("changes",new JSONArray().put(new JSONObject().put("bucket","drafts").put("op","put").put("key",key).put("value",edited)));JSONObject intent=stage(f.open(),"archive-overwrite",overwrite);f.outbox.stage(intent,1);String head=control(f.db,"head");int receipts=count(f.db,"tx_receipts");recovery(()->f.outbox.commit(intent,1,null,false));
            assertEquals(head,control(f.db,"head"));assertEquals(receipts,count(f.db,"tx_receipts"));assertEquals(2,count(f.db,"staging"));
            try(Cursor row=f.db.rawQuery("SELECT payload FROM records WHERE profile_id=?",new String[]{f.profile("b")})){assertTrue(row.moveToFirst());assertArrayEquals(original.toString().getBytes(StandardCharsets.UTF_8),row.getBlob(0));}
        }
    }
    @Test public void explicitActorEraseIsExactAndPreservesForeignAndUnattributedRows()throws Exception {
        try(Fixture f=new Fixture()){
            f.outbox.grant(session("a"),null);String a=f.profile("a"),b=f.profile("b"),foreign=OutboxPolicy.profile(f.origin,"retention-workspace","foreign-member","a"),otherWorkspace=OutboxPolicy.profile(f.origin,"other-workspace","retention-member","a");
            for(String profile:new String[]{a,b,foreign,otherWorkspace})seed(f.db,profile,profile);
            f.db.execSQL("INSERT INTO recovery VALUES('owned','fixture',?)",new Object[]{new byte[]{1,2}});f.db.execSQL("INSERT INTO recovery VALUES('legacy','unknown',?)",new Object[]{new byte[]{3,4}});set(f.db,"recovery-owner:owned",b);
            f.db.execSQL("INSERT INTO staging VALUES('owned-stage',0,0,'lease',?)",new Object[]{new byte[]{5,6}});set(f.db,"staging-owner:owned-stage",a);f.db.execSQL("INSERT INTO staging VALUES('unknown-stage',0,0,'lease',?)",new Object[]{new byte[]{7,8}});
            f.db.execSQL("INSERT INTO tx_receipts VALUES('owned-receipt','digest',1)");set(f.db,"receipt-owner:owned-receipt",b);f.db.execSQL("INSERT INTO tx_receipts VALUES('foreign-receipt','digest',1)");set(f.db,"receipt-owner:foreign-receipt",foreign);
            assertNull(f.outbox.nativeActor("unrelated-cookie"));try{f.outbox.eraseActor(foreign);fail("Unknown actor erased archives");}catch(IllegalArgumentException expected){}assertEquals(4,count(f.db,"records"));
            String actor=f.outbox.nativeActor(null);f.outbox.revoke();assertEquals(actor,f.outbox.nativeActor(null));f.outbox.eraseActor(actor);
            assertEquals(2,count(f.db,"records"));assertEquals(1,count(f.db,"recovery"));assertEquals(1,count(f.db,"staging"));assertEquals(1,count(f.db,"tx_receipts"));
            recovery(()->f.outbox.grant(session("b"),null));f.outbox.grant(session("fresh-c"),null);assertEquals(f.profile("fresh-c"),f.open().getString("profileId"));assertEquals(2,count(f.db,"records"));
        }
    }
}
