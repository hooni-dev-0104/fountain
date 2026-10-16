package dev.fountain.workspace;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import android.system.Os;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Fresh QA AVD only: actual WebView bridge, TLS, Android SQLite and DocumentsUI. */
@RunWith(AndroidJUnit4.class)
public class BackupDeviceTest {
    private MainActivity activity;
    private long generation;
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();

    private String evaluate(String script)throws Exception {
        AtomicReference<String> result=new AtomicReference<>();CountDownLatch ready=new CountDownLatch(1);
        instrumentation.runOnMainSync(()->activity.getBridge().getWebView().evaluateJavascript(script,value->{result.set(value);ready.countDown();}));
        assertTrue("WebView evaluation",ready.await(10,TimeUnit.SECONDS));return result.get();
    }
    private String start(String method,JSONObject options)throws Exception {
        String key="qa_"+UUID.randomUUID().toString().replace("-","");
        evaluate("window.__fountainQA=window.__fountainQA||{};Capacitor.nativePromise('FountainNative',"+JSONObject.quote(method)+","+options+").then(value=>window.__fountainQA['"+key+"']={ok:true,value},error=>window.__fountainQA['"+key+"']={ok:false,code:error.code});'started'");return key;
    }
    private JSONObject await(String key)throws Exception {
        long deadline=SystemClock.elapsedRealtime()+45000;
        while(SystemClock.elapsedRealtime()<deadline){String result=evaluate("JSON.stringify(window.__fountainQA&&window.__fountainQA['"+key+"']||null)");
            if(result!=null&&!result.equals("null")){Object decoded=new JSONTokener(result).nextValue();if(decoded instanceof String&&!decoded.equals("null")){JSONObject answer=new JSONObject((String)decoded);if(!answer.optBoolean("ok"))throw new AssertionError("Native call rejected: "+answer.optString("code"));return answer.getJSONObject("value");}}
            Thread.sleep(50);
        }throw new AssertionError("Native bridge response timed out");
    }
    private JSONObject call(String method,JSONObject options)throws Exception{return await(start(method,options));}
    private JSONObject options()throws Exception{return new JSONObject().put("id",UUID.randomUUID().toString()).put("generation",generation);}
    private JSONObject request(String method,String path)throws Exception {
        return request(method,path,null);
    }
    private JSONObject request(String method,String path,JSONObject body)throws Exception {
        JSONObject response=call("request",options().put("method",method).put("path",path).put("headers",body==null?new JSONObject():new JSONObject().put("Content-Type","application/json")).put("bodyBase64",body==null?"":android.util.Base64.encodeToString(body.toString().getBytes(StandardCharsets.UTF_8),android.util.Base64.NO_WRAP)).put("timeoutMs",30000));
        assertEquals("HTTPS actual response",200,response.getInt("status"));
        java.util.Iterator<String> headers=response.getJSONObject("headers").keys();while(headers.hasNext())assertNotEquals("set-cookie",headers.next().toLowerCase(java.util.Locale.ROOT));
        return new JSONObject(new String(android.util.Base64.decode(response.getString("bodyBase64"),android.util.Base64.NO_WRAP),StandardCharsets.UTF_8));
    }
    private static String sha(File file)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1)digest.update(bytes,0,n);}
        StringBuilder value=new StringBuilder();for(byte b:digest.digest())value.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return value.toString();
    }
    private boolean clickText(AccessibilityNodeInfo root,String expected){
        if(root==null)return false;CharSequence text=root.getText(),description=root.getContentDescription();
        if((text!=null&&text.toString().equalsIgnoreCase(expected))||(description!=null&&description.toString().equalsIgnoreCase(expected))) {
            AccessibilityNodeInfo current=root;while(current!=null){if(current.isClickable())return current.performAction(AccessibilityNodeInfo.ACTION_CLICK);current=current.getParent();}
        }
        for(int i=0;i<root.getChildCount();i++)if(clickText(root.getChild(i),expected))return true;return false;
    }
    private boolean pickerVisible(){AccessibilityNodeInfo root=instrumentation.getUiAutomation().getRootInActiveWindow();return root!=null&&"com.google.android.documentsui".contentEquals(root.getPackageName())||root!=null&&"com.android.documentsui".contentEquals(root.getPackageName());}
    private void waitPicker()throws Exception {long until=SystemClock.elapsedRealtime()+15000;while(!pickerVisible()&&SystemClock.elapsedRealtime()<until)Thread.sleep(100);assertTrue("Actual Android system picker",pickerVisible());}
    private void waitBridge()throws Exception {long until=SystemClock.elapsedRealtime()+20000;while(SystemClock.elapsedRealtime()<until&&!"true".equals(evaluate("!!(window.Capacitor&&Capacitor.nativePromise)")))Thread.sleep(100);}

    private JSONObject outcome(String key)throws Exception {
        long deadline=SystemClock.elapsedRealtime()+30000;
        while(SystemClock.elapsedRealtime()<deadline){String result=evaluate("JSON.stringify(window.__fountainQA&&window.__fountainQA['"+key+"']||null)");
            if(result!=null&&!result.equals("null")){Object decoded=new JSONTokener(result).nextValue();if(decoded instanceof String&&!decoded.equals("null"))return new JSONObject((String)decoded);}
            Thread.sleep(50);
        }throw new AssertionError("Native backup response timed out");
    }
    private void login(String mode)throws Exception {request("POST","/api/session",new JSONObject().put("mode",mode));}
    private String beginBackup()throws Exception {return start("download",options().put("path","/api/backup?job_id=00000000-0000-0000-0000-000000000001").put("filename","fountain-backup-qa.sqlite"));}
    private File exportFile(){File directory=new File(instrumentation.getTargetContext().getNoBackupFilesDir(),"native_exports");File[] values=directory.listFiles();return values!=null&&values.length==1?values[0]:null;}
    private void noExport()throws Exception {for(int i=0;i<50&&exportFile()!=null;i++)Thread.sleep(50);assertNull("Only derived private backup temporary is removed",exportFile());}
    @Test public void exactJobQueryAndInt64RangeMetadata()throws Exception {
        String id="00000000-0000-0000-0000-000000000001",path="/api/backup?job_id="+id;
        assertEquals(id,FountainNativePlugin.backupJobId(path));assertNull(FountainNativePlugin.backupJobId("/api/backup"));
        for(String bad:new String[]{path+"&extra=1",path+"#fragment",path+"&job_id="+id,"/api/backup?job_id=%30"+id.substring(1),"/api/backup?job_id="+id+"\n"})try{FountainNativePlugin.backupJobId(bad);fail("Unexpected backup query accepted");}catch(IllegalArgumentException expected){}
        JSONObject value=new JSONObject().put("id",id).put("phase","ready").put("size",6_000_000_123L).put("sha256",new String(new char[64]).replace('\0','a')).put("expires_at","2099-01-01T00:00:00Z");
        FountainNativePlugin.BackupPlan plan=new FountainNativePlugin.BackupPlan(value,id);assertEquals(6_000_000_123L,plan.size);
        plan.piece(6_000_000_000L,123,206,"bytes 6000000000-6000000122/6000000123","123",123);
        for(int status:new int[]{200,302,416})try{plan.piece(0,262144,status,"bytes 0-262143/6000000123","262144",262144);fail();}catch(IllegalArgumentException expected){}
    }
    @Test public void actualHTTPSRangeHashCancellationAndOwnerFence()throws Exception {
        String origin=InstrumentationRegistry.getArguments().getString("qaBackupOrigin");assertNotNull(origin);assertTrue(origin.startsWith("https://10.0.2.2:"));
        Context context=instrumentation.getTargetContext();File original=new File(context.getNoBackupFilesDir(),"backup-qa-original.tmp");assertFalse(original.exists());
        try(FileOutputStream output=new FileOutputStream(original)){output.write("last original offline input 🏠".getBytes(StandardCharsets.UTF_8));}String before=sha(original);
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(value->activity=value);waitBridge();generation=call("configure",new JSONObject().put("origin",origin)).getLong("generation");login("normal");
            String pending=beginBackup();waitPicker();File file=exportFile();assertNotNull(file);assertEquals(786555L,file.length());
            byte[] expected=new byte[786555];for(int i=0;i<expected.length;i++)expected[i]=(byte)((i*31+i/65536*17)&255);
            assertEquals(OutboxPolicy.hash(expected),sha(file));
            instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            assertFalse(await(pending).getBoolean("saved"));noExport();assertEquals(before,sha(original));
            login("normal");pending=beginBackup();waitPicker();
            boolean saved=false;long saveUntil=SystemClock.elapsedRealtime()+15000;
            while(!saved&&SystemClock.elapsedRealtime()<saveUntil){saved=clickText(instrumentation.getUiAutomation().getRootInActiveWindow(),"Save");if(!saved)Thread.sleep(100);}
            assertTrue("Actual Android OS destination save",saved);assertTrue(await(pending).getBoolean("saved"));noExport();assertEquals(before,sha(original));
            for(String mode:new String[]{"hash","range","denied"}){login(mode);JSONObject answer=outcome(beginBackup());assertFalse(mode,answer.getBoolean("ok"));noExport();assertEquals(before,sha(original));}
            login("cancel");JSONObject args=options().put("path","/api/backup?job_id=00000000-0000-0000-0000-000000000001").put("filename","fountain-backup-qa.sqlite");
            pending=start("download",args);Thread.sleep(250);assertTrue(call("cancel",new JSONObject().put("id",args.getString("id"))).getBoolean("cancelled"));assertFalse(outcome(pending).getBoolean("ok"));noExport();assertEquals(before,sha(original));
            login("cancel");pending=beginBackup();Thread.sleep(250);request("DELETE","/api/session");
            assertFalse("Logout fences the in-flight backup",outcome(pending).getBoolean("ok"));noExport();assertEquals(before,sha(original));
        }finally{assertTrue(original.delete());}
    }
}
