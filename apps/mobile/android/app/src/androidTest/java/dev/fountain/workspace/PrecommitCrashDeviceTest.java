package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Process;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Root kills the owned QA PID after durable staging, BEFORE active COMMIT.
 * Synthetic native authority; actual SDK SQLite; no HTTP or production hooks. */
@RunWith(AndroidJUnit4.class)
public class PrecommitCrashDeviceTest {
    private static final String NAME="fountain-precommit-crash-";
    private static byte[] bytes(String value){return value.getBytes(StandardCharsets.UTF_8);}
    private static void owned(File file,boolean directory)throws Exception{
        StructStat s=Os.lstat(file.getPath());
        assertEquals(Process.myUid(),s.st_uid);assertEquals(directory?0700:0600,s.st_mode&0777);
        assertTrue(directory?OsConstants.S_ISDIR(s.st_mode):OsConstants.S_ISREG(s.st_mode));
        assertEquals(file.getAbsoluteFile(),file.getCanonicalFile());
    }
    private static byte[] read(File file,boolean consume)throws Exception{
        owned(file,false);FileDescriptor descriptor=Os.open(file.getPath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW|OsConstants.O_NONBLOCK,0);
        try(FileInputStream input=new FileInputStream(descriptor)){
            StructStat s=Os.fstat(descriptor);assertEquals(Process.myUid(),s.st_uid);assertEquals(0600,s.st_mode&0777);assertTrue(OsConstants.S_ISREG(s.st_mode));assertTrue(s.st_size>0&&s.st_size<=32768);
            byte[] raw=new byte[(int)s.st_size];int offset=0,count;
            while(offset<raw.length&&(count=input.read(raw,offset,raw.length-offset))>0)offset+=count;
            assertEquals(raw.length,offset);assertEquals(-1,input.read());if(consume)assertTrue(file.delete());return raw;
        }
    }
    private static void seal(File file,JSONObject value)throws Exception{
        byte[] raw=bytes(value.toString());FileDescriptor descriptor=Os.open(file.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_EXCL|OsConstants.O_NOFOLLOW,0600);
        try(FileOutputStream output=new FileOutputStream(descriptor)){output.write(raw);output.getFD().sync();}
        FileDescriptor parent=Os.open(file.getParent(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
        try{StructStat directory=Os.fstat(parent);assertTrue(OsConstants.S_ISDIR(directory.st_mode));assertEquals(Process.myUid(),directory.st_uid);Os.fsync(parent);}finally{Os.close(parent);}assertArrayEquals(raw,read(file,false));
    }
    private static long number(SQLiteDatabase db,String sql,String... args){try(Cursor c=db.rawQuery(sql,args)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private static String text(SQLiteDatabase db,String sql,String... args){try(Cursor c=db.rawQuery(sql,args)){assertTrue(c.moveToFirst());return c.getString(0);}}
    private static byte[] staged(SQLiteDatabase db,String tx)throws Exception{
        try(Cursor c=db.rawQuery("SELECT data FROM staging WHERE tx_id=? ORDER BY part",new String[]{tx})){assertTrue(c.moveToFirst());byte[] raw=c.getBlob(0);assertFalse(c.moveToNext());return raw;}
    }
    private static String source(SQLiteDatabase db)throws Exception{
        JSONArray tables=new JSONArray();
        for(String table:new String[]{"records","native_record_owners","native_local_versions_v1","recovery","tx_receipts","tombstones"}){
            JSONArray rows=new JSONArray();try(Cursor c=db.rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){
                while(c.moveToNext()){JSONArray row=new JSONArray();for(int i=0;i<c.getColumnCount();i++){
                    int type=c.getType(i);row.put(new JSONArray().put(type).put(type==Cursor.FIELD_TYPE_NULL?JSONObject.NULL:type==Cursor.FIELD_TYPE_BLOB?OutboxPolicy.base64(c.getBlob(i)):c.getString(i)));
                }rows.put(row);}
            }tables.put(new JSONArray().put(table).put(rows));
        }return OutboxPolicy.hash(bytes(tables.toString()));
    }
    private static JSONObject put(String bucket,Object key,JSONObject value)throws Exception{return new JSONObject().put("op","put").put("bucket",bucket).put("key",key).put("value",value);}
    private static byte[] delta(String origin,JSONArray changes)throws Exception{return bytes(new JSONObject().put("version",1).put("origin",origin).put("mode","active").put("changes",changes).toString());}
    private static JSONObject draft(String profile,String value)throws Exception{
        String resource=profile+"|page";return put("drafts",new JSONArray().put(resource).put("crash-client"),new JSONObject().put("key",resource).put("profileId",profile).put("clientId","crash-client")
            .put("draft",new JSONObject().put("epoch","epoch").put("reason","pending").put("blocks",new JSONArray().put(new JSONObject().put("id","paragraph").put("type","paragraph").put("text",value)))).put("updatedAt",1));
    }
    private static JSONObject intent(JSONObject opened,String tx,byte[] raw)throws Exception{return new JSONObject().put("generation",1).put("lease",opened.getString("lease")).put("baseHead",opened.getLong("head"))
        .put("proofEpoch",opened.getLong("proofEpoch")).put("txId",tx).put("part",0).put("bytesBase64",OutboxPolicy.base64(raw)).put("digest",OutboxPolicy.hash(raw));}
    private static void seed(NativeOutbox outbox,String origin)throws Exception{
        JSONObject session=new JSONObject().put("authenticated",true).put("required",false).put("mode","local").put("workspace_id","workspace").put("cache_binding","binding")
            .put("member",new JSONObject().put("id","member").put("role","owner").put("active",true));outbox.grant(session,null);JSONObject opened=outbox.open(1,null,false,"precommit-owner");
        JSONObject page=new JSONObject().put("id","page").put("access_level",4).put("locked",false).put("archived",false).put("revision",1);
        JSONObject envelope=new JSONObject().put("workspace_id","workspace").put("current_member_id","member").put("session_binding","binding").put("access_revision",1).put("data_revision",1);
        JSONObject workspace=new JSONObject(envelope.toString()).put("pages",new JSONArray().put(page)).put("databases",new JSONArray()).put("teamspaces",new JSONArray().put(new JSONObject().put("id","general").put("access_level",3)));
        JSONObject snapshot=new JSONObject(envelope.toString()).put("page",page).put("access_level",4).put("epoch","epoch").put("seq",0).put("blocks",new JSONArray())
            .put("state",new JSONObject().put("version",1).put("max_clock",0).put("blocks",new JSONObject()).put("seen",new JSONObject()));
        outbox.observe("GET","/api/workspace",200,bytes(workspace.toString()),null,false,"precommit-owner");
        outbox.observe("GET","/api/pages/page/collaboration",200,bytes(snapshot.toString()),null,false,"precommit-owner");
        opened=outbox.open(1,null,false,"precommit-owner");String profile=opened.getString("profileId"),resource=profile+"|page";
        JSONArray changes=new JSONArray().put(put("snapshots",resource,new JSONObject().put("key",resource).put("profileId",profile).put("snapshot",snapshot))).put(draft(profile,"Committed baseline"));
        byte[] raw=delta(origin,changes);JSONObject request=intent(opened,"baseline",raw);outbox.stage(request,1);outbox.commit(request,1,null,false);
    }
    @Test public void rootManagedKillAfterStageBeforeActiveCommit()throws Exception{
        Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
        // Resolve trusted Android /data/user/0 <-> /data/data aliases once;
        // every untrusted child still passes the existing no-symlink check.
        File filesRoot=base.getFilesDir().getCanonicalFile(),backupRoot=base.getNoBackupFilesDir().getCanonicalFile();
        File input=new File(filesRoot,NAME+"input.json");
        Assume.assumeTrue("Root-owned explicit pre-COMMIT input required",input.exists());
        assertEquals("1",InstrumentationRegistry.getArguments().getString("fountainPrecommitCrashQA"));
        byte[] raw=read(input,false);JSONObject request=new JSONObject(new String(raw,StandardCharsets.UTF_8));String phase=request.getString("phase"),nonce=request.getString("nonce");
        assertTrue(nonce.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));assertTrue(phase.equals("prepare")||phase.equals("verify"));
        assertArrayEquals(bytes("{\"nonce\":\""+nonce+"\",\"phase\":\""+phase+"\"}"),raw);read(input,true);
        File root=new File(backupRoot,NAME+nonce);String origin="https://precommit-"+nonce+".invalid",tx="pending-"+nonce;
        if(phase.equals("prepare")){assertFalse(root.exists());Os.mkdir(root.getPath(),0700);}owned(root,true);
        Context isolated=new ContextWrapper(base){@Override public File getNoBackupFilesDir(){return root;}};
        File database=new File(root,"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite"),stateFile=new File(root,"state.json");
        File ready=new File(filesRoot,NAME+"ready.json"),result=new File(filesRoot,NAME+"result.json");
        if(phase.equals("prepare")){
            try(NativeOutbox outbox=new NativeOutbox(isolated,origin)){
                seed(outbox,origin);JSONObject opened=outbox.open(1,null,false,"precommit-owner");String before=source(outbox.db);
                byte[] pending=delta(origin,new JSONArray().put(draft(opened.getString("profileId"),"Uncommitted exact input "+nonce)));
                JSONObject pendingIntent=intent(opened,tx,pending);outbox.stage(pendingIntent,1);assertArrayEquals(pending,staged(outbox.db,tx));assertEquals(before,source(outbox.db));
                JSONObject state=new JSONObject().put("nonce",nonce).put("pid",Process.myPid()).put("sourceSHA256",before).put("digest",OutboxPolicy.hash(pending))
                    .put("baseHead",opened.getLong("head")).put("proofEpoch",opened.getLong("proofEpoch")).put("profile",opened.getString("profileId")).put("lease",opened.getString("lease"));
                seal(stateFile,state);seal(ready,new JSONObject().put("nonce",nonce).put("pid",Process.myPid()).put("staged",true).put("beforeActiveCommit",true).put("digest",OutboxPolicy.hash(pending)).put("sourceSHA256",before).put("head",opened.getLong("head")));
                // Root verifies the ready nonce/PID, then kills ONLY this QA process.
                // There is deliberately NO pending delta COMMIT call on this path.
                while(true)Thread.sleep(1000);
            }
        }
        JSONObject state=new JSONObject(new String(read(stateFile,false),StandardCharsets.UTF_8));assertEquals(nonce,state.getString("nonce"));assertNotEquals(state.getInt("pid"),Process.myPid());
        owned(new File(root,"durable_outbox"),true);owned(database,false);byte[] pending=delta(origin,new JSONArray().put(draft(state.getString("profile"),"Uncommitted exact input "+nonce)));
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(database.getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
            assertEquals("ok",text(db,"PRAGMA integrity_check"));assertEquals(state.getString("sourceSHA256"),source(db));assertArrayEquals(pending,staged(db,tx));
            try(Cursor row=db.rawQuery("SELECT part,base_head,lease FROM staging WHERE tx_id=?",new String[]{tx})){
                assertTrue(row.moveToFirst());assertEquals(0,row.getInt(0));assertEquals(state.getLong("baseHead"),row.getLong(1));assertEquals(state.getString("lease"),row.getString(2));assertFalse(row.moveToNext());
            }
            assertEquals(state.getString("digest"),OutboxPolicy.hash(pending));assertEquals(state.getLong("baseHead"),number(db,"SELECT value FROM control WHERE key='head'"));
            assertEquals(state.getLong("proofEpoch"),number(db,"SELECT value FROM control WHERE key='proof_epoch'"));assertEquals(0,number(db,"SELECT count(*) FROM tx_receipts WHERE tx_id=?",tx));
            assertEquals(2,number(db,"SELECT count(*) FROM records WHERE mode='active'"));assertEquals(1,number(db,"SELECT count(*) FROM tx_receipts"));
        }
        try(NativeOutbox outbox=new NativeOutbox(isolated,origin)){
            JSONObject opened=outbox.open(1,null,false,"precommit-owner"),journal=new JSONObject().put("txId",tx).put("digest",state.getString("digest")).put("baseHead",state.getLong("baseHead")).put("proofEpoch",state.getLong("proofEpoch"));
            JSONObject settled=outbox.reconcile(new JSONObject().put("generation",1).put("phase","settle").put("lease",opened.getString("lease")).put("journals",new JSONArray().put(journal)),1,null,false,"precommit-owner",0);
            assertEquals("unaccepted",settled.getJSONArray("settlements").getJSONObject(0).getString("status"));assertArrayEquals(pending,staged(outbox.db,tx));assertEquals(state.getString("sourceSHA256"),source(outbox.db));
            seal(result,new JSONObject().put("nonce",nonce).put("pid",Process.myPid()).put("priorPID",state.getInt("pid")).put("actualSDKSQLite",true).put("syntheticAuthority",true)
                .put("integrity",true).put("stagingExact",true).put("sourceUnchanged",true).put("pendingReceiptAbsent",true).put("settlement","unaccepted").put("digest",state.getString("digest")).put("sourceSHA256",state.getString("sourceSHA256")));
        }
        // Keep the isolated evidence directory; Root removes ONLY this nonce path
        // after independently reading the successful result and source hashes.
    }
}
