package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.webkit.WebResourceRequest;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in component proof, not real backend/TLS/Auth or browser display proof.
 * A test-APK-only URL factory supplies anonymous JSON; ActivityMonitor blocks
 * every ACTION_VIEW before any browser runs. Root must force-stop this fresh
 * dedicated process afterwards because URL factories cannot be uninstalled. */
@RunWith(AndroidJUnit4.class)
public class PublicWebNavigationDeviceTest {
    private static final String API="https://ehnovtfadpkwtubmwltl.supabase.co";
    private static final String OTHER="https://aaaaaaaaaaaaaaaaaaaa.supabase.co";
    private static final String FRONT="https://family.example.invalid";
    private static final String SESSION=API+"/functions/v1/fountain-api/api/session";
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private MainActivity activity;

    private static final class Fixture {
        final AtomicBoolean enabled=new AtomicBoolean(true);
        final AtomicReference<String> mode=new AtomicReference<>("missing");
        final AtomicInteger requests=new AtomicInteger(),denied=new AtomicInteger();
        void install() {
            try { URL.setURLStreamHandlerFactory(protocol->!"https".equals(protocol)?null:new URLStreamHandler(){
                @Override protected URLConnection openConnection(URL url)throws IOException {
                    if(!enabled.get()||!SESSION.equals(url.toExternalForm())){denied.incrementAndGet();throw new IOException("Fixture destination denied");}
                    final String current=mode.get();
                    return new HttpsURLConnection(url) {
                        final int status="failed".equals(current)?503:200;
                        final byte[] body=("failed".equals(current)?"{\"code\":\"FIXTURE_FAILURE\"}":
                            "{\"required\":true,\"authenticated\":false,\"mode\":\"accounts\",\"member\":null"+
                            ("valid".equals(current)?",\"public_web_origin\":\""+FRONT+"\"":
                             "invalid".equals(current)?",\"public_web_origin\":\""+FRONT+"/\"":"")+"}").getBytes(StandardCharsets.UTF_8);
                        void validate()throws IOException {
                            if(!enabled.get()||!"GET".equals(getRequestMethod())||getRequestProperty("Cookie")!=null
                                ||getRequestProperty("Authorization")!=null||getRequestProperty("apikey")!=null)throw new IOException("Anonymous GET fixture required");
                        }
                        @Override public int getResponseCode()throws IOException {validate();requests.incrementAndGet();return status;}
                        @Override public Map<String,List<String>> getHeaderFields(){Map<String,List<String>> h=new HashMap<>();h.put("Content-Type",Collections.singletonList("application/json"));h.put("Content-Length",Collections.singletonList(String.valueOf(body.length)));return h;}
                        @Override public long getContentLengthLong(){return body.length;}
                        @Override public InputStream getInputStream()throws IOException {validate();return new ByteArrayInputStream(body);}
                        @Override public InputStream getErrorStream(){return new ByteArrayInputStream(body);}
                        @Override public void connect()throws IOException {validate();}
                        @Override public void disconnect(){}
                        @Override public boolean usingProxy(){return false;}
                        @Override public String getCipherSuite(){return "COMPONENT_FIXTURE_NO_TLS";}
                        @Override public Certificate[] getLocalCertificates(){return null;}
                        @Override public Certificate[] getServerCertificates(){return null;}
                    };
                }
            }); } catch(Error used){throw new AssertionError("Fresh dedicated instrumentation process required");}
        }
    }

    private static final class BrowserMonitor extends Instrumentation.ActivityMonitor {
        final List<String> targets=Collections.synchronizedList(new ArrayList<>());
        @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
            if(!Intent.ACTION_VIEW.equals(intent.getAction()))return null;
            targets.add(intent.getDataString());
            return new Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null);
        }
    }
    private String evaluate(String script)throws Exception {
        AtomicReference<String> value=new AtomicReference<>();CountDownLatch done=new CountDownLatch(1);
        instrumentation.runOnMainSync(()->activity.getBridge().getWebView().evaluateJavascript(script,result->{value.set(result);done.countDown();}));
        assertTrue("WebView evaluation finished",done.await(10,TimeUnit.SECONDS));return value.get();
    }
    private void until(String expression)throws Exception {
        long end=SystemClock.elapsedRealtime()+20000;
        while(SystemClock.elapsedRealtime()<end){if("true".equals(evaluate("(()=>{try{return !!("+expression+");}catch(_){return false;}})()")))return;Thread.sleep(50);}
        fail("Bundled component operation did not finish");
    }
    private JSONObject promise(String body)throws Exception {
        evaluate("globalThis.__publicLinkProof=null;(async()=>{"+body+"})().then(v=>__publicLinkProof={ok:true,value:v},()=>__publicLinkProof={ok:false});true");
        until("globalThis.__publicLinkProof!==null");
        String raw=evaluate("JSON.stringify(__publicLinkProof)");JSONObject value=new JSONObject((String)new JSONTokener(raw).nextValue());
        evaluate("delete globalThis.__publicLinkProof;true");assertTrue("Real native adapter call succeeded",value.getBoolean("ok"));return value.getJSONObject("value");
    }
    private void configure(String origin)throws Exception {
        promise("await FountainTransport.configure({origin:"+JSONObject.quote(origin)+"});return {configured:true};");
    }
    private JSONObject session()throws Exception {
        return promise("const r=await FountainTransport.request('/api/session'),s=await r.json();return {status:r.status,anonymous:s.authenticated===false,cookieEmpty:document.cookie==='',hidden:!r.headers.has('set-cookie')};");
    }
    private void navigation(BrowserMonitor monitor,String target,boolean accepted)throws Exception {
        int before=monitor.targets.size();
        evaluate("window.open("+JSONObject.quote(target)+",'_blank','noopener');true");
        long end=SystemClock.elapsedRealtime()+(accepted?10000:500);
        while(SystemClock.elapsedRealtime()<end&&monitor.targets.size()==before)Thread.sleep(25);
        assertEquals("Only trusted public navigation reaches ACTION_VIEW",before+(accepted?1:0),monitor.targets.size());
        if(accepted)assertEquals(target,monitor.targets.get(before));
        assertEquals("External content never replaces the bundled document","true",evaluate("globalThis.__publicLinkDocument===true"));
    }
    private void subframeBoundary() {
        // CSP already disallows real iframe loads. Inject only this request DTO
        // into the actual installed native client to isolate its main-frame gate.
        instrumentation.runOnMainSync(()->assertTrue(activity.getBridge().getWebViewClient().shouldOverrideUrlLoading(activity.getBridge().getWebView(),new WebResourceRequest(){
            public Uri getUrl(){return Uri.parse(FRONT+"/forms/subframe");}
            public boolean isForMainFrame(){return false;}
            public boolean isRedirect(){return false;}
            public boolean hasGesture(){return true;}
            public String getMethod(){return "GET";}
            public Map<String,String> getRequestHeaders(){return Collections.emptyMap();}
        })));
    }
    @Test public void bundledPublicLinksUseOnlyObservedNativeSessionMetadata()throws Exception {
        Assume.assumeTrue("Explicit dedicated public-link QA opt-in required","1".equals(InstrumentationRegistry.getArguments().getString("publicLinkQA")));
        assertTrue("Dedicated emulator required",Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));
        JSONObject prior=new CookieVault(instrumentation.getTargetContext()).read();
        assertTrue("Preserve existing login and revocation",prior.isNull("active")&&prior.isNull("revoke"));
        String priorOrigin=prior.isNull("origin")?null:prior.getString("origin");
        Fixture fixture=new Fixture();BrowserMonitor monitor=new BrowserMonitor();
        fixture.install();instrumentation.addMonitor(monitor);
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(value->activity=value);
            try {
                until("globalThis.FountainTransport&&globalThis.Capacitor?.nativePromise");
                configure(API);JSONObject response=session();assertEquals(200,response.getInt("status"));assertTrue(response.getBoolean("anonymous")&&response.getBoolean("cookieEmpty")&&response.getBoolean("hidden"));
                evaluate("globalThis.__publicLinkDocument=true;true");
                navigation(monitor,FRONT+"/forms/no-fresh-metadata",false);
                fixture.mode.set("valid");assertEquals(200,session().getInt("status"));
                navigation(monitor,FRONT+"/forms/allowed_1",true);
                navigation(monitor,FRONT+"/sites/allowed-2",true);
                for(String target:Arrays.asList("https://foreign.example.invalid/forms/x",FRONT+"/forms/x?query=1",FRONT+"/forms/%78",FRONT+"/sites/x#fragment",FRONT+"/api/session"))navigation(monitor,target,false);
                int before=monitor.targets.size();subframeBoundary();assertEquals("Subframe has no OS navigation",before,monitor.targets.size());
                // A forged renderer property cannot update native authority.
                evaluate("globalThis.public_web_origin='https://foreign.example.invalid';true");
                navigation(monitor,"https://foreign.example.invalid/forms/x",false);
                for(String mode:Arrays.asList("missing","invalid","failed")){
                    fixture.mode.set("valid");session();navigation(monitor,FRONT+"/forms/rearmed",true);
                    fixture.mode.set(mode);assertEquals("failed".equals(mode)?503:200,session().getInt("status"));
                    navigation(monitor,FRONT+"/forms/cleared",false);
                }
                fixture.mode.set("valid");session();configure(OTHER);
                navigation(monitor,FRONT+"/forms/old-configuration",false);
                // Exercise factory scope without connecting to another server.
                for(String target:Arrays.asList(API+"/api/session",API+"/functions/v1/fountain-api/api/pages",OTHER+"/functions/v1/fountain-api/api/session"))try{new URL(target).openConnection();fail("Fixture must reject other API routes/origins");}catch(IOException expected){}
                assertTrue(fixture.requests.get()>0);assertTrue(fixture.denied.get()>=3);
            } finally {
                // No Auth/session is created. Restore a prior selected origin
                // when present; this is a dedicated disposable profile otherwise.
                if(priorOrigin!=null&&!priorOrigin.isEmpty())configure(priorOrigin);
            }
        } finally {fixture.enabled.set(false);instrumentation.removeMonitor(monitor);}
        assertFalse("Fixture disabled after scope",fixture.enabled.get());
    }
}
