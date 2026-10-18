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
    private static final String ACCOUNT_SESSION=API+"/functions/v1/fountain-api/api/account/session";
    private static final String ACCOUNT_LIST=API+"/functions/v1/fountain-api/api/account/workspaces?session_binding=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private MainActivity activity;

    private static final class Fixture {
        final AtomicBoolean enabled=new AtomicBoolean(true);
        final AtomicReference<String> mode=new AtomicReference<>("missing");
        final AtomicReference<List<String>> accountMarker=new AtomicReference<>(Collections.singletonList("absent"));
        final AtomicReference<String> accountFailure=new AtomicReference<>();
        final CountDownLatch accountCancelStarted=new CountDownLatch(1),accountCancelRelease=new CountDownLatch(1);
        final AtomicInteger requests=new AtomicInteger(),denied=new AtomicInteger();
        void install() {
            try { URL.setURLStreamHandlerFactory(protocol->!"https".equals(protocol)?null:new URLStreamHandler(){
                @Override protected URLConnection openConnection(URL url)throws IOException {
                    final boolean account=ACCOUNT_SESSION.equals(url.toExternalForm())||ACCOUNT_LIST.equals(url.toExternalForm());
                    if(!enabled.get()||!SESSION.equals(url.toExternalForm())&&!account){denied.incrementAndGet();throw new IOException("Fixture destination denied");}
                    if(account) {
                        String failure=accountFailure.get();
                        if("unknown-host".equals(failure))throw new UnknownHostException("Fixture DNS unavailable");
                        if("no-route".equals(failure))throw new NoRouteToHostException("Fixture route unavailable");
                        if("connect".equals(failure))throw new ConnectException("Fixture connection unavailable");
                        if("tls".equals(failure))throw new javax.net.ssl.SSLHandshakeException("Fixture TLS failure");
                        if("timeout".equals(failure))throw new SocketTimeoutException("Fixture timeout");
                        if("storage".equals(failure))throw new IllegalStateException("Fixture storage unavailable");
                    }
                    final String current=mode.get();
                    return new HttpsURLConnection(url) {
                        final int status=account?401:"failed".equals(current)?503:200;
                        final byte[] body=(account?"{\"authenticated\":false,\"mode\":\"account\"}":"failed".equals(current)?"{\"code\":\"FIXTURE_FAILURE\"}":
                            "{\"required\":true,\"authenticated\":false,\"mode\":\"accounts\",\"member\":null"+
                            ("valid".equals(current)?",\"public_web_origin\":\""+FRONT+"\"":
                             "invalid".equals(current)?",\"public_web_origin\":\""+FRONT+"/\"":"")+"}").getBytes(StandardCharsets.UTF_8);
                        void validate()throws IOException {
                            if(!enabled.get()||!("GET".equals(getRequestMethod())||account&&ACCOUNT_SESSION.equals(url.toExternalForm())&&"POST".equals(getRequestMethod()))||getRequestProperty("Cookie")!=null
                                ||getRequestProperty("Authorization")!=null||getRequestProperty("apikey")!=null)throw new IOException("Anonymous GET fixture required");
                        }
                        @Override public int getResponseCode()throws IOException {validate();requests.incrementAndGet();if(account&&"cancel".equals(accountFailure.get())){accountCancelStarted.countDown();try{if(!accountCancelRelease.await(10,TimeUnit.SECONDS))throw new SocketTimeoutException("Fixture cancellation wait");}catch(InterruptedException interrupted){throw new InterruptedIOException();}throw new ConnectException("Fixture cancelled connection");}return status;}
                        @Override public Map<String,List<String>> getHeaderFields(){Map<String,List<String>> h=new HashMap<>();h.put("Content-Type",Collections.singletonList("application/json"));h.put("Content-Length",Collections.singletonList(String.valueOf(body.length)));if(account){if(accountMarker.get()!=null)h.put("X-Fountain-Account-Directory",accountMarker.get());h.put("X-Private-Fixture",Collections.singletonList("hidden"));h.put("Set-Cookie",Collections.singletonList("fixture_ignored=hidden; Path=/; Secure; HttpOnly"));}return h;}
                        @Override public long getContentLengthLong(){return body.length;}
                        @Override public InputStream getInputStream()throws IOException {validate();return new ByteArrayInputStream(body);}
                        @Override public InputStream getErrorStream(){return new ByteArrayInputStream(body);}
                        @Override public OutputStream getOutputStream()throws IOException {validate();return new ByteArrayOutputStream();}
                        @Override public void connect()throws IOException {validate();}
                        @Override public void disconnect(){if(account&&"cancel".equals(accountFailure.get()))accountCancelRelease.countDown();}
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
        // This component fixture observes the anonymous legacy session directly;
        // account-directory startup intentionally has no selected JS workspace.
        return promise("const r=await Capacitor.nativePromise('FountainNative','request',{id:'public-session-'+Date.now(),generation:FountainTransport.generation,path:'/api/session',method:'GET',headers:{},bodyBase64:'',timeoutMs:45000}),s=JSON.parse(atob(r.bodyBase64));return {status:r.status,anonymous:s.authenticated===false,cookieEmpty:document.cookie==='',hidden:!Object.keys(r.headers).some(k=>k.toLowerCase()==='set-cookie')};");
    }
    private void accountMarker(String method,String path,boolean expected)throws Exception {
        JSONObject result=promise("const r=await Capacitor.nativePromise('FountainNative','accountRequest',{id:"+JSONObject.quote(UUID.randomUUID().toString())+",generation:FountainTransport.generation,path:"+JSONObject.quote(path)+",method:"+JSONObject.quote(method)+",headers:"+(method.equals("GET")?"{}":"{'content-type':'application/json'}")+",bodyBase64:"+(method.equals("GET")?"''":"btoa('{}')")+",timeoutMs:45000});return {status:r.status,marker:r.headers['x-fountain-account-directory']??null,hidden:!Object.keys(r.headers).some(k=>['set-cookie','cookie','x-private-fixture'].includes(k.toLowerCase()))};");
        assertEquals(401,result.getInt("status"));assertTrue(result.getBoolean("hidden"));
        if(expected)assertEquals("absent",result.getString("marker"));else assertTrue(result.isNull("marker"));
    }
    private String accountWire(String id) {
        return "{id:"+JSONObject.quote(id)+",generation:FountainTransport.generation,path:'/api/account/session',method:'GET',headers:{},bodyBase64:'',timeoutMs:45000}";
    }
    private void accountFailure(String expected)throws Exception {
        JSONObject reply=promise("return await Capacitor.nativePromise('FountainNative','accountRequest',"+accountWire(UUID.randomUUID().toString())+").then(()=>({code:'UNEXPECTED_SUCCESS'}),e=>({code:e.code}));");
        assertEquals("Actual native bridge failure classification",expected,reply.getString("code"));
    }
    private void accountCancellation(Fixture fixture)throws Exception {
        String id=UUID.randomUUID().toString();fixture.accountFailure.set("cancel");
        evaluate("globalThis.__accountCancelCode='pending';Capacitor.nativePromise('FountainNative','accountRequest',"+accountWire(id)+").then(()=>__accountCancelCode='UNEXPECTED_SUCCESS',e=>__accountCancelCode=e.code);true");
        assertTrue("Account HTTP operation reached cancellable fixture",fixture.accountCancelStarted.await(10,TimeUnit.SECONDS));
        JSONObject cancelled=promise("return await Capacitor.nativePromise('FountainNative','accountCancel',{id:"+JSONObject.quote(id)+",generation:FountainTransport.generation});");assertTrue(cancelled.getBoolean("cancelled"));
        until("globalThis.__accountCancelCode!=='pending'");assertEquals("\"CANCELLED\"",evaluate("globalThis.__accountCancelCode"));fixture.accountFailure.set(null);evaluate("delete globalThis.__accountCancelCode;true");
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
                configure(API);accountMarker("GET","/api/account/session",true);
                for(List<String> marker:Arrays.asList(Collections.singletonList("present"),Collections.singletonList("Absent"),Arrays.asList("absent","absent"))){fixture.accountMarker.set(marker);accountMarker("GET","/api/account/session",false);}
                fixture.accountMarker.set(null);accountMarker("GET","/api/account/session",false);fixture.accountMarker.set(Collections.singletonList("absent"));
                accountMarker("GET","/api/account/workspaces?session_binding=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",false);accountMarker("POST","/api/account/session",false);
                for(String failure:Arrays.asList("unknown-host","no-route","connect")){fixture.accountFailure.set(failure);accountFailure("NATIVE_NETWORK_UNREACHABLE");}
                for(String failure:Arrays.asList("tls","timeout","storage")){fixture.accountFailure.set(failure);accountFailure("ORGANIZATION_REQUEST_FAILED");}
                accountCancellation(fixture);
                JSONObject response=session();assertEquals(200,response.getInt("status"));assertTrue(response.getBoolean("anonymous")&&response.getBoolean("cookieEmpty")&&response.getBoolean("hidden"));
                evaluate("globalThis.__publicLinkDocument=true;true");
                navigation(monitor,FRONT+"/forms/no-fresh-metadata",false);
                fixture.mode.set("valid");assertEquals(200,session().getInt("status"));
                navigation(monitor,FRONT+"/forms/allowed_1",true);
                navigation(monitor,FRONT+"/sites/allowed-2",true);
                navigation(monitor,FRONT+"/#w/family-1/form/allowed_1",true);
                navigation(monitor,FRONT+"/#w/family-1/site/allowed-2",true);
                for(String target:Arrays.asList("https://foreign.example.invalid/forms/x",FRONT+"/forms/x?query=1",FRONT+"/forms/%78",FRONT+"/sites/x#fragment",FRONT+"/api/session",
                    FRONT+"/?query=1#w/family-1/site/x",FRONT+"/#w/family-1/site/%78",FRONT+"/#w/family-1/page/x",FRONT+"/api/w/family-1/native-child/sites/x"))navigation(monitor,target,false);
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
