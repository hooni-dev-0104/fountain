package dev.fountain.workspace;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Context;
import android.os.SystemClock;
import android.system.Os;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Historical flag-false cloud login/read/logout QA: explicit opt-in plus a prior disabled binary, not default-active coverage. */
@RunWith(AndroidJUnit4.class)
public class CloudSessionDeviceTest {
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
    @Test public void actualSupabaseOwnerLoginAndPrivatePage()throws Exception {
        org.junit.Assume.assumeTrue("Historical disabled-foundation fixture requires opt-in and a prior outbox-disabled binary", "1".equals(InstrumentationRegistry.getArguments().getString("legacyDisabledFoundationQA")));
        Context context=instrumentation.getTargetContext();File input=new File(context.getFilesDir(),"fountain-cloud-native-qa.json");
        org.junit.Assume.assumeTrue("Opt-in private disposable cloud input required",input.isFile());
        JSONObject config;
        try {assertEquals(0600,Os.stat(input.getPath()).st_mode&0777);try(InputStream stream=new FileInputStream(input)){ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] part=new byte[4096];int n;while((n=stream.read(part))!=-1){assertTrue(bytes.size()+n<=16384);bytes.write(part,0,n);}config=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));}}
        catch(Exception ignored){throw new AssertionError("Private disposable QA input unavailable");}
        finally {if(input.exists())assertTrue(input.delete());}
        assertEquals("https://10.0.2.2:61603",config.getString("origin"));
        assertEquals("fountain-qa-cloud-accounts-75254a74761a4888",config.getString("workspaceId"));
        boolean logged=false;
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(value->activity=value);
            long until=SystemClock.elapsedRealtime()+20000;while(SystemClock.elapsedRealtime()<until&&!"true".equals(evaluate("!!(window.Capacitor&&Capacitor.nativePromise)")))Thread.sleep(100);
            JSONObject prior=call("getConfiguration",new JSONObject());generation=prior.getLong("generation");
            if(config.getString("origin").equals(prior.optString("origin")))request("DELETE","/api/session");
            JSONObject configured=call("configure",new JSONObject().put("origin",config.getString("origin")));generation=configured.getLong("generation");assertFalse(configured.getBoolean("outboxEnabled"));
            try {
            JSONObject login=request("POST","/api/session",new JSONObject().put("email",config.getString("email")).put("password",config.getString("password")));logged=true;
            config.remove("password");
            assertTrue(login.getBoolean("authenticated"));assertEquals("accounts",login.getString("mode"));assertEquals("owner",login.getJSONObject("member").getString("role"));
            JSONObject current=request("GET","/api/session");assertTrue(current.getBoolean("authenticated"));assertTrue(current.getJSONObject("member").getBoolean("active"));assertEquals("local",current.getJSONObject("member").getString("id"));assertEquals(config.getString("workspaceId"),current.getString("workspace_id"));assertEquals(login.getString("cache_binding"),current.getString("cache_binding"));
            JSONObject page=request("GET","/api/pages/qa-accounts-private");assertEquals("qa-accounts-private",page.getJSONObject("page").getString("id"));JSONObject after=request("GET","/api/session");assertEquals(config.getString("workspaceId"),after.getString("workspace_id"));assertEquals("local",after.getJSONObject("member").getString("id"));assertEquals("owner",after.getJSONObject("member").getString("role"));assertEquals(current.getString("cache_binding"),after.getString("cache_binding"));assertEquals(4,page.getJSONObject("page").getInt("access_level"));
            JSONObject evidence=new JSONObject().put("platform","android").put("actualNativeHTTPS",true).put("actualSupabase",true).put("memberId","local").put("role","owner").put("workspaceId",config.getString("workspaceId")).put("pageId","qa-accounts-private").put("bindingSHA256",OutboxPolicy.hash(current.getString("cache_binding"))).put("titleSHA256",OutboxPolicy.hash(page.getJSONObject("page").getString("title"))).put("outboxEnabled",false);
            request("DELETE","/api/session");logged=false;assertFalse(request("GET","/api/session").getBoolean("authenticated"));evidence.put("logoutVerified",true);
            File result=new File(context.getFilesDir(),"fountain-cloud-native-result.json");try(OutputStream output=new FileOutputStream(result)){output.write(evidence.toString().getBytes(StandardCharsets.UTF_8));}Os.chmod(result.getPath(),0600);
            } finally {if(logged)try{request("DELETE","/api/session");}catch(Throwable ignored){}}
        }
    }
}
