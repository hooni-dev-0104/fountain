package dev.fountain.workspace;

import android.content.Context;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.json.*;

/** Production NativeRecovery logic on portable test signatures, not Android. */
public final class RecoveryFixture {
    private static int checks;
    private static void require(boolean value){checks++;if(!value)throw new AssertionError("Recovery fixture check failed");}
    public static void main(String[] arguments)throws Exception {
        JSONObject config=new JSONObject(new String(Files.readAllBytes(Paths.get(arguments[0])),StandardCharsets.UTF_8));
        String origin=config.getString("origin"),mode=config.getString("mode");
        NativeRecovery recovery=new NativeRecovery(new Context());
        final boolean[] valid={true};
        NativeRecovery.Authority authority=new NativeRecovery.Authority(){
            public void check()throws Exception{if(!valid[0])throw new NativeRecovery.Failure("RECOVERY_STALE");}
            public JSONObject get(String path)throws Exception{
                check();HttpURLConnection connection=(HttpURLConnection)new URL(origin+path).openConnection();connection.setInstanceFollowRedirects(false);connection.setRequestProperty("X-Fountain-Request","1");
                try{int status=connection.getResponseCode();if(status!=200){recovery.observe("GET",path,status,new JSONObject());throw new NativeRecovery.Failure(status==401?"RECOVERY_AUTH_REQUIRED":"RECOVERY_ACCESS_REQUIRED");}
                    ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream input=connection.getInputStream()){byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1)bytes.write(buffer,0,count);}JSONObject body=new JSONObject(OutboxPolicy.utf8(bytes.toByteArray()));
                    if(mode.startsWith("bad_")&&!path.equals("/api/session")){
                        if(mode.equals("bad_revision"))body.put("data_revision","999");
                        if(path.endsWith("/collaboration")){JSONObject page=body.getJSONObject("page");
                            if(mode.equals("bad_level"))body.put("access_level","3");
                            if(mode.equals("bad_nested"))page.put("access_level","3");
                            if(mode.equals("bad_fraction"))body.put("access_level",3.5);
                            if(mode.equals("bad_boolean"))body.put("access_level",true);
                            if(mode.equals("bad_flags"))page.put("locked","false");
                        }else if(path.startsWith("/api/databases/")){JSONObject database=body.getJSONObject("database");
                            if(mode.equals("bad_level"))database.put("access_level","3");
                            if(mode.equals("bad_nested"))body.getJSONArray("rows").getJSONObject(0).put("access_level","3");
                            if(mode.equals("bad_fraction"))database.put("access_level",3.5);
                            if(mode.equals("bad_boolean"))database.put("access_level",true);
                            if(mode.equals("bad_flags"))database.put("can_create_row","true");
                        }
                    }return body;
                }finally{connection.disconnect();}
            }
        };
        JSONObject description=authority.get("/api/session");
        NativeRecovery.Session first=new NativeRecovery.Session(origin,description,null,"fixture-owner:1");recovery.refresh(first);
        Thread.sleep(10);NativeRecovery.Session refresh=new NativeRecovery.Session(origin,description,null,"fixture-owner:1");recovery.refresh(refresh);require(refresh.validUntil==first.validUntil);
        String sourceHash=config.optString("sourceHash","");
        JSONObject inventory=recovery.inventory(null,100,1,authority);JSONArray entries=inventory.getJSONArray("items");
        require(!inventory.toString().contains(config.getString("page")));require(!inventory.toString().contains("FOREIGN-SECRET"));
        if(mode.equals("absent")){require(entries.length()==0);require(!new File(System.getProperty("fountain.fixture.root"),"durable_outbox").exists());recovery.close();System.out.println("PASS absent read-only native recovery fixture "+checks);return;}
        require(entries.length()==(mode.equals("overflow")?1:3));
        JSONArray handles=new JSONArray();int count=0;for(int i=0;i<entries.length();i++){handles.put(entries.getJSONObject(i).getString("handle"));count+=entries.getJSONObject(i).getInt("recordCount");}
        if(mode.equals("changed")){
            File source=new File(config.getString("source"));long length=source.length();try(FileOutputStream output=new FileOutputStream(source,true)){output.write(0);}
            try{recovery.prepare(inventory.getString("inventoryToken"),handles,1,authority);throw new AssertionError();}catch(NativeRecovery.Failure expected){require(expected.code.equals("RECOVERY_STALE"));}
            try(RandomAccessFile file=new RandomAccessFile(source,"rw")){file.setLength(length);}recovery.close();System.out.println("PASS changed-source native recovery fixture "+checks);return;
        }
        JSONObject metadata=recovery.prepare(inventory.getString("inventoryToken"),handles,1,authority);
        require(metadata.getInt("readyCount")+metadata.getInt("blockedCount")==count);
        if(mode.startsWith("bad_")){require(metadata.getInt("readyCount")==0);require(metadata.getJSONArray("files").length()==0);recovery.close();System.out.println("PASS strict negative authority "+mode+" "+checks);return;}
        if(mode.equals("profile_denied")){require(metadata.getInt("readyCount")==0);recovery.close();System.out.println("PASS current profile tombstone blocks old-binding recovery "+checks);return;}
        if(Arrays.asList("property","base_fields","base_rows","typed_kind").contains(mode)){require(metadata.getInt("readyCount")==3);require(metadata.getInt("blockedCount")==count-3);recovery.close();System.out.println("PASS unsafe typed projection "+mode+" "+checks);return;}
        if(mode.equals("body_kind")){require(metadata.getInt("readyCount")==1);require(metadata.getInt("blockedCount")==count-1);recovery.close();System.out.println("PASS wrong body resource kind blocked "+checks);return;}
        if(mode.equals("lineage")){require(metadata.getInt("readyCount")==1);require(metadata.getInt("blockedCount")==count-1);recovery.close();System.out.println("PASS malformed lineage preserves source and blocks unsafe projection "+checks);return;}
        require(metadata.getInt("readyCount")>0);require(metadata.getInt("blockedCount")== (mode.equals("overflow")?0:1));
        require(!metadata.toString().contains("FOREIGN-SECRET"));require(!metadata.toString().contains("DO-NOT-EXPORT"));require(!metadata.toString().contains("blocks"));
        NativeRecovery.Prepared prepared=recovery.saving(inventory.getString("inventoryToken"),metadata.getString("exportToken"),handles,authority);
        if(mode.equals("denied")||mode.equals("attachment_denied")){
            recovery.observe("GET",mode.equals("attachment_denied")?"/api/attachments/"+OutboxPolicy.encode(config.getString("attachment"))+"/metadata":"/api/pages/"+OutboxPolicy.encode(config.getString("page"))+"/collaboration",403,new JSONObject());
            try{recovery.checkPrepared(prepared,authority);throw new AssertionError();}catch(NativeRecovery.Failure expected){require(expected.code.equals("RECOVERY_STALE"));}
            recovery.finished(prepared);require(prepared.files.isEmpty());recovery.close();System.out.println("PASS known-denial native recovery fixture "+checks);return;
        }
        if(mode.equals("cancel")){
            recovery.cancel(inventory.getString("inventoryToken"),metadata.getString("exportToken"));require(prepared.files.isEmpty());
            JSONObject next=recovery.prepare(inventory.getString("inventoryToken"),handles,1,authority);require(next.getInt("readyCount")>0);
            recovery.cancel(inventory.getString("inventoryToken"),null);require(new File(System.getProperty("fountain.fixture.root"),"native_exports").list().length==0);recovery.close();System.out.println("PASS exact-capability cancel native recovery fixture "+checks);return;
        }
        if(mode.equals("actor")){
            JSONObject other=new JSONObject(description.toString());other.getJSONObject("member").put("id","foreign-member");
            recovery.refresh(new NativeRecovery.Session(origin,other,null,"fixture-owner:2"));
            try{recovery.saving(inventory.getString("inventoryToken"),metadata.getString("exportToken"),handles,authority);throw new AssertionError();}catch(NativeRecovery.Failure expected){require(expected.code.equals("RECOVERY_STALE"));}
            require(prepared.files.isEmpty());recovery.close();System.out.println("PASS actor-bound native recovery fixture "+checks);return;
        }
        Path saved=Paths.get(config.getString("saved"));Files.createDirectories(saved);List<String> files=new ArrayList<>();
        for(int i=0;i<prepared.files.size();i++){
            recovery.checkSavedSource(prepared,authority);File source=prepared.files.get(i);require(source.length()>0&&source.length()<=NativeRecovery.FILE_LIMIT);
            Path destination=saved.resolve("saved-"+i+".json");Files.copy(source.toPath(),destination);files.add(destination.toString());
            String contents=new String(Files.readAllBytes(destination),StandardCharsets.UTF_8);require(!contents.contains("DO-NOT-EXPORT"));require(!contents.contains("FOREIGN-SECRET"));
        }
        if(mode.equals("overflow")){require(prepared.files.size()>1);for(String format:prepared.formats)require(format.equals("body"));}
        recovery.finished(prepared);recovery.close();require(new File(config.getString("source")).isFile());
        JSONObject result=new JSONObject().put("files",new JSONArray(files)).put("origin",origin).put("workspaceId",description.getString("workspace_id"))
            .put("memberId",description.getJSONObject("member").getString("id")).put("mode",mode).put("sourceHash",sourceHash);
        Files.write(Paths.get(config.getString("result")),result.toString().getBytes(StandardCharsets.UTF_8));
        System.out.println("PASS production Java recovery via compatibility JSON/SQLite read-only shims "+checks+"; not Android SDK/device/HTTPS/OS-picker proof");
    }
}
