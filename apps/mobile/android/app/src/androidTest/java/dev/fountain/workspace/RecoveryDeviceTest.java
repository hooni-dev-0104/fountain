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
public class RecoveryDeviceTest {
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

    @Test public void privateFamilyLoginPersists()throws Exception {
        String origin=InstrumentationRegistry.getArguments().getString("qaFamilyOrigin");assertNotNull(origin);assertTrue(origin.startsWith("https://10.0.2.2:"));
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(value->activity=value);waitBridge();generation=call("configure",new JSONObject().put("origin",origin)).getLong("generation");
            JSONObject logged=request("POST","/api/session",new JSONObject().put("token","isolated-android-qa-token"));assertTrue(logged.getBoolean("authenticated"));assertEquals("family",logged.getString("mode"));
            JSONObject current=request("GET","/api/session");assertTrue(current.getBoolean("authenticated"));assertEquals(logged.getString("cache_binding"),current.getString("cache_binding"));
            assertFalse(new File(instrumentation.getTargetContext().getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite").exists());
        }
    }

    /** Run in a separate instrumentation invocation after force-stop. */
    @Test public void privateFamilyRestoresAndLogsOut()throws Exception {
        String origin=InstrumentationRegistry.getArguments().getString("qaFamilyOrigin");assertNotNull(origin);
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(value->activity=value);waitBridge();JSONObject config=call("getConfiguration",new JSONObject());assertEquals(origin,config.getString("origin"));generation=config.getLong("generation");
            JSONObject current=request("GET","/api/session");assertTrue("Private Keystore-backed session survives process restart",current.getBoolean("authenticated"));assertEquals("family",current.getString("mode"));
            assertFalse(new File(instrumentation.getTargetContext().getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(origin)+".sqlite").exists());
            request("DELETE","/api/session");JSONObject loggedOut=request("GET","/api/session");assertFalse(loggedOut.getBoolean("authenticated"));
        }
    }

    @Test public void nativeReadOnlyRecoveryAndSystemSave()throws Exception {
        Context context=instrumentation.getTargetContext();String origin=InstrumentationRegistry.getArguments().getString("qaOrigin");
        assertNotNull("Explicit isolated QA HTTPS origin required",origin);assertTrue(origin.startsWith("https://10.0.2.2:"));
        File directory=new File(context.getNoBackupFilesDir(),"durable_outbox");assertFalse("Fresh QA app only",directory.exists());
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(value->activity=value);
            long until=SystemClock.elapsedRealtime()+20000;while(SystemClock.elapsedRealtime()<until&&!"true".equals(evaluate("!!(window.Capacitor&&Capacitor.nativePromise)")))Thread.sleep(100);
            JSONObject config=call("getConfiguration",new JSONObject());assertFalse(config.getBoolean("outboxEnabled"));assertTrue(config.getBoolean("recoveryEnabled"));
            generation=call("configure",new JSONObject().put("origin",origin)).getLong("generation");
            JSONObject session=request("GET","/api/session");assertTrue(session.getBoolean("authenticated"));assertFalse(directory.exists());
            JSONObject empty=call("recoveryInventory",options().put("cursor",JSONObject.NULL).put("limit",100));assertEquals(0,empty.getJSONArray("items").length());assertFalse(directory.exists());
            call("recoveryExport",options().put("phase","cancel").put("inventoryToken",empty.getString("inventoryToken")).put("handles",new JSONArray()));

            JSONObject workspace=request("GET","/api/workspace");String page=workspace.getJSONArray("pages").getJSONObject(0).getString("id");
            String profile=OutboxPolicy.profile(origin,session.getString("workspace_id"),session.getJSONObject("member").getString("id"),"qa-old-binding");
            String resource=profile+"|"+OutboxPolicy.encode(page);
            assertTrue(directory.mkdir());Os.chmod(directory.getPath(),0700);File source=new File(directory,OutboxPolicy.hash(origin)+".sqlite");
            SQLiteDatabase db=SQLiteDatabase.openDatabase(source.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY|SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            try(android.database.Cursor pragma=db.rawQuery("PRAGMA journal_mode=DELETE",null)){assertTrue(pragma.moveToFirst());assertEquals("delete",pragma.getString(0));}db.execSQL("PRAGMA synchronous=EXTRA");for(String sql:NativeOutbox.SCHEMA)db.execSQL(sql);db.execSQL("INSERT INTO control VALUES('head','7')");
            JSONObject block=new JSONObject().put("id","qa-draft").put("type","paragraph").put("text","Android 실제 미전송 원문 🏠");
            JSONObject record=new JSONObject().put("key",resource).put("clientId","qa-client").put("profileId",profile).put("draft",new JSONObject().put("blocks",new JSONArray().put(block)).put("reason","pending"));
            db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)",new Object[]{"quarantine","drafts",new JSONArray().put(resource).put("qa-client").toString(),profile,resource,record.toString().getBytes(StandardCharsets.UTF_8)});db.close();Os.chmod(source.getPath(),0600);String original=sha(source);
            JSONObject inventory=call("recoveryInventory",options().put("cursor",JSONObject.NULL).put("limit",100));assertEquals(1,inventory.getJSONArray("items").length());assertFalse(inventory.toString().contains(page));assertFalse(inventory.toString().contains("미전송"));
            JSONArray handles=new JSONArray().put(inventory.getJSONArray("items").getJSONObject(0).getString("handle"));
            JSONObject prepared=call("recoveryExport",options().put("phase","prepare").put("inventoryToken",inventory.getString("inventoryToken")).put("handles",handles));
            assertEquals(1,prepared.getInt("readyCount"));assertEquals(0,prepared.getInt("blockedCount"));assertEquals(1,prepared.getJSONArray("files").length());assertFalse(prepared.toString().contains("미전송"));assertEquals(original,sha(source));
            // Actual system cancellation must preserve source and report no saved files.
            String pending=start("recoveryExport",options().put("phase","save").put("inventoryToken",inventory.getString("inventoryToken")).put("exportToken",prepared.getString("exportToken")).put("handles",handles));waitPicker();
            instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            JSONObject cancelled=await(pending);assertFalse(cancelled.getBoolean("saved"));assertEquals(0,cancelled.getInt("filesSaved"));assertEquals(original,sha(source));
            prepared=call("recoveryExport",options().put("phase","prepare").put("inventoryToken",inventory.getString("inventoryToken")).put("handles",handles));
            pending=start("recoveryExport",options().put("phase","save").put("inventoryToken",inventory.getString("inventoryToken")).put("exportToken",prepared.getString("exportToken")).put("handles",handles));waitPicker();
            boolean saved=false;long saveUntil=SystemClock.elapsedRealtime()+15000;while(!saved&&SystemClock.elapsedRealtime()<saveUntil){saved=clickText(instrumentation.getUiAutomation().getRootInActiveWindow(),"Save");if(!saved)Thread.sleep(200);}assertTrue("Click Android provider Save",saved);
            JSONObject answer=await(pending);assertTrue(answer.getBoolean("saved"));assertEquals(1,answer.getInt("filesSaved"));assertEquals(original,sha(source));
            // Recovery-mode explicit logout must not purge, grant or rewrite the archive.
            request("DELETE","/api/session");assertEquals(original,sha(source));
            File result=new File(context.getFilesDir(),"qa-recovery-result.json");try(OutputStream output=new FileOutputStream(result)){output.write(new JSONObject().put("sourceSha256",original).put("sourceUnchanged",true).put("https",true).put("sqliteDriver",true).put("systemPickerSaved",true).put("generation",generation).toString().getBytes(StandardCharsets.UTF_8));}
        }
    }
}
