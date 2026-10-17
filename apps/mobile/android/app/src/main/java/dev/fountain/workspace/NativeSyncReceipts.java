package dev.fountain.workspace;

import android.database.Cursor;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Private exact-request sync receipts. These never grant edit permission. */
final class NativeSyncReceipts {
    static final String SCHEMA="CREATE TABLE IF NOT EXISTS native_sync_receipts(profile_id TEXT NOT NULL,operation_id TEXT NOT NULL,session_ref TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(profile_id,operation_id))";
    static final String META_SCHEMA="CREATE TABLE IF NOT EXISTS native_sync_ownership(profile_id TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,database_id TEXT,target_id TEXT NOT NULL,document_epoch TEXT,PRIMARY KEY(profile_id,operation_id))";
    static final class Admission {
        final String profile, owner, sessionRef, lease; final JSONArray operations;
        Admission(String profile,String owner,String sessionRef,String lease,JSONArray operations){this.profile=profile;this.owner=owner;this.sessionRef=sessionRef;this.lease=lease;this.operations=operations;}
    }
    private final NativeOutbox host;
    NativeSyncReceipts(NativeOutbox host){this.host=host;host.db.execSQL(SCHEMA);host.db.execSQL(META_SCHEMA);}
    private void fields(JSONObject value,String... allowed)throws Exception{Set<String> keys=new HashSet<>(Arrays.asList(allowed));Iterator<String> names=value.keys();while(names.hasNext())NativePolicy.require(keys.contains(names.next()));}
    Admission admit(String method,String path,byte[] raw,String cookie,boolean blocked,String owner)throws Exception{
        if(!"POST".equals(method)||!"/api/sync".equals(path))return null;
        JSONObject grant=host.verified(cookie,blocked);if(grant==null||!owner.equals(host.get("owner")))throw new NativeOutbox.AccessRequired();
        try{
            NativePolicy.require(raw!=null&&raw.length<=NativePolicy.MAX_REQUEST);JSONObject body=new JSONObject(OutboxPolicy.utf8(raw));fields(body,"workspace_id","session_binding","operations");
            JSONObject session=grant.getJSONObject("session");NativePolicy.require(session.getString("workspace_id").equals(body.getString("workspace_id"))&&session.getString("cache_binding").equals(body.getString("session_binding")));
            JSONArray operations=body.getJSONArray("operations");NativePolicy.require(operations.length()<=50);
            for(int i=0;i<operations.length();i++){
                JSONObject operation=operations.getJSONObject(i);OutboxPolicy.id(operation.getString("id"));String kind=operation.getString("kind");
                NativePolicy.require(Arrays.asList("page.create","page.patch","row.create","row.patch","row.delete").contains(kind));OutboxPolicy.text(operation.opt("target_id"),1000);
                if(kind.startsWith("row."))OutboxPolicy.text(operation.opt("database_id"),1000);
                if(kind.equals("page.create"))java.util.UUID.fromString(operation.getString("document_epoch"));operation.getJSONObject("body");
            }
            return new Admission(grant.getString("profileId"),owner,grant.getString("session_ref"),host.get("lease"),new JSONArray(operations.toString()));
        }catch(Exception invalid){throw new NativeReconcile.Failure("OUTBOX_RECONCILE_RETRY");}
    }
    void observe(Admission admission,int status,byte[] raw,String cookie,boolean blocked,String owner)throws Exception{
        if(admission==null||status!=200)return;
        JSONObject grant=host.verified(cookie,blocked);
        if(grant==null||!admission.lease.equals(host.get("lease"))||!owner.equals(admission.owner)||!owner.equals(host.get("owner"))||!grant.getString("profileId").equals(admission.profile)||!grant.getString("session_ref").equals(admission.sessionRef))throw new NativeOutbox.AccessRequired();
        JSONArray accepted=new JSONArray();
        try{
            NativePolicy.require(raw!=null&&raw.length<=OutboxPolicy.RECORD);JSONObject body=new JSONObject(OutboxPolicy.utf8(raw)),session=grant.getJSONObject("session");fields(body,"workspace_id","current_member_id","session_binding","data_revision","results");
            NativePolicy.require(session.getString("workspace_id").equals(body.getString("workspace_id"))&&session.getJSONObject("member").getString("id").equals(body.getString("current_member_id"))&&session.getString("cache_binding").equals(body.getString("session_binding")));
            long revision=OutboxPolicy.integer(body.opt("data_revision"),0,OutboxPolicy.SAFE-1);JSONArray results=body.getJSONArray("results");NativePolicy.require(results.length()==admission.operations.length()&&results.length()<=50);
            for(int i=0;i<results.length();i++){
                JSONObject operation=admission.operations.getJSONObject(i),result=results.getJSONObject(i);NativePolicy.require(operation.getString("id").equals(result.getString("id")));
                String state=result.getString("status");NativePolicy.require(Arrays.asList("applied","conflict","denied","invalid","deferred").contains(state));if(!state.equals("applied"))continue;
                fields(result,"id","status","http_status","resource_id","data_revision","updated_at","revision");
                NativePolicy.require(operation.getString("target_id").equals(result.getString("resource_id"))&&OutboxPolicy.integer(result.opt("http_status"),200,201)==(operation.getString("kind").endsWith("create")?201:200));
                NativePolicy.require(OutboxPolicy.integer(result.opt("data_revision"),0,OutboxPolicy.SAFE-1)<=revision);
                if(result.has("updated_at"))OutboxPolicy.expiry(OutboxPolicy.text(result.get("updated_at"),1000));if(result.has("revision"))OutboxPolicy.integer(result.opt("revision"),0,OutboxPolicy.SAFE-1);
                accepted.put(new JSONObject().put("id",operation.getString("id")).put("digest",OutboxPolicy.hash(host.canonical(operation,false))).put("result",result).put("operation",operation));
            }
        }catch(Exception invalid){throw new NativeReconcile.Failure("OUTBOX_RECONCILE_RETRY");}
        host.db.beginTransaction();try{
            boolean classified = false;
            for(int i=0;i<accepted.length();i++){
                JSONObject value=accepted.getJSONObject(i);
                boolean exists=false;
                try(Cursor c=host.db.rawQuery("SELECT digest,result FROM native_sync_receipts WHERE profile_id=? AND operation_id=?",new String[]{admission.profile,value.getString("id")})){
                    if(c.moveToFirst()){if(!c.getString(0).equals(value.getString("digest"))||!host.canonical(new JSONObject(c.getString(1)),false).equals(host.canonical(value.getJSONObject("result"),false)))throw new NativeReconcile.Failure("OUTBOX_RECONCILE_RETRY");exists=true;}
                }
                if(!exists)host.db.execSQL("INSERT INTO native_sync_receipts VALUES(?,?,?,?,?)",new Object[]{admission.profile,value.getString("id"),admission.sessionRef,value.getString("digest"),value.getJSONObject("result").toString()});
                JSONObject operation=value.getJSONObject("operation");
                if(operation.getString("kind").startsWith("page.")) classified |= host.markServerPage(grant.getJSONObject("session").getString("workspace_id"), operation.getString("target_id"));
                host.db.execSQL("INSERT OR IGNORE INTO native_sync_ownership VALUES(?,?,?,?,?,?)",new Object[]{admission.profile,value.getString("id"),operation.getString("kind"),operation.isNull("database_id")?null:operation.getString("database_id"),operation.getString("target_id"),operation.isNull("document_epoch")?null:operation.getString("document_epoch")});
            }
            if (classified) host.advanceProof();
            host.db.setTransactionSuccessful();
        }finally{host.db.endTransaction();}
    }
    JSONObject applied(JSONObject grant,JSONObject operation)throws Exception{
        try(Cursor c=host.db.rawQuery("SELECT session_ref,digest,result FROM native_sync_receipts WHERE profile_id=? AND operation_id=?",new String[]{grant.getString("profileId"),operation.getString("id")})){
            if(!c.moveToFirst()||!grant.getString("session_ref").equals(c.getString(0))||!OutboxPolicy.hash(host.canonical(operation,false)).equals(c.getString(1)))return null;return new JSONObject(c.getString(2));
        }
    }
    JSONObject dependency(JSONObject grant,String id)throws Exception{
        try(Cursor c=host.db.rawQuery("SELECT m.kind,m.database_id,m.target_id,m.document_epoch,r.result FROM native_sync_receipts r JOIN native_sync_ownership m ON m.profile_id=r.profile_id AND m.operation_id=r.operation_id WHERE r.profile_id=? AND r.operation_id=? AND r.session_ref=?",new String[]{grant.getString("profileId"),OutboxPolicy.id(id),grant.getString("session_ref")})){
            return c.moveToFirst()?new JSONObject().put("kind",c.getString(0)).put("database_id",c.isNull(1)?JSONObject.NULL:c.getString(1)).put("target_id",c.getString(2)).put("document_epoch",c.isNull(3)?JSONObject.NULL:c.getString(3)).put("result",new JSONObject(c.getString(4))):null;
        }
    }
}
