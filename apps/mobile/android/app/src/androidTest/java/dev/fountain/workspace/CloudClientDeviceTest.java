package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in disposable QA: real bundled UI/native transport/Keystore/platform TLS.
 * Requests reach sealed actual Supabase QA, not the production application.
 * URL's global factory cannot be uninstalled. Root must force-stop this dedicated
 * instrumentation process after testing; closing the gate denies further HTTPS.
 */
@RunWith(AndroidJUnit4.class)
public class CloudClientDeviceTest {
    private static final String ORIGIN="https://ehnovtfadpkwtubmwltl.supabase.co",PREFIX="/functions/v1/fountain-api",PAGE="qa-native-shared";
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private MainActivity activity;

    private static String logicalPath(URL url)throws IOException {
        try {
            if(!"https".equals(url.getProtocol())||!"ehnovtfadpkwtubmwltl.supabase.co".equals(url.getHost())
                ||url.getPort()!=-1&&url.getPort()!=443||url.getUserInfo()!=null||url.getRef()!=null||!url.getPath().startsWith(PREFIX+"/"))throw new IllegalArgumentException();
            String path=url.getPath().substring(PREFIX.length())+(url.getQuery()==null?"":"?"+url.getQuery());
            if(path.startsWith("/api/"))return NativePolicy.path(path,false);
            if(path.matches("/(sites|forms)/[A-Za-z0-9_-]{1,160}"))return path;
        }catch(Exception ignored) { }
        throw new IOException("Out-of-scope sealed QA request");
    }
    private static final class SealedGate {
        final AtomicReference<String> nonce;
        final AtomicInteger requests=new AtomicInteger(),blocked=new AtomicInteger();
        SealedGate(String secret){nonce=new AtomicReference<>(secret);}
        void install()throws Exception {
            // Capture the original platform HTTPS handler BEFORE factory install.
            // Reusing this URL object avoids recursive handler lookup. No TLS,
            // hostname verifier, redirect or process CookieHandler is replaced.
            final URL wire=new URL(ORIGIN+"/functions/v1/fountain-verify/wire");
            try {
                URL.setURLStreamHandlerFactory(protocol->!"https".equals(protocol)?null:new URLStreamHandler(){
                    @Override protected URLConnection openConnection(URL original)throws IOException {
                        final String path,secret=nonce.get();
                        try{if(secret==null)throw new IOException();path=logicalPath(original);}
                        catch(Exception ignored){blocked.incrementAndGet();throw new IOException("Sealed QA HTTPS scope denied");}
                        HttpsURLConnection actual=(HttpsURLConnection)wire.openConnection();
                        actual.setRequestProperty("X-Fountain-Verify",secret);actual.setRequestProperty("X-Fountain-Test-Path",path);
                        requests.incrementAndGet();
                        // Caller method/body/cookies/Range and server status/raw
                        // response remain genuine platform/native behavior.
                        return actual;
                    }
                });
            }catch(Error unavailable){throw new AssertionError("Fresh dedicated instrumentation process required");}
        }
        void close(){nonce.set(null);}
    }
    private static JSONObject consume(Context context)throws Exception {
        File input=new File(context.getFilesDir(),"fountain-cloud-client-input.json");
        Assume.assumeTrue("Explicit private native client QA input required",input.exists());byte[] raw;
        try {
            android.system.StructStat stat=Os.lstat(input.getPath());
            assertTrue("Private regular input",OsConstants.S_ISREG(stat.st_mode));assertEquals(0600,stat.st_mode&0777);
            assertEquals(android.os.Process.myUid(),stat.st_uid);assertTrue("Bounded input",stat.st_size<=16384);
            try(InputStream stream=new FileInputStream(Os.open(input.getPath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0))){
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] part=new byte[1024];int count;
                while((count=stream.read(part))!=-1){assertTrue("Bounded input",bytes.size()+count<=16384);bytes.write(part,0,count);}raw=bytes.toByteArray();
            }
        }finally{assertTrue("Input consumed immediately",input.delete());}
        JSONObject value;
        try{value=new JSONObject(new String(raw,StandardCharsets.UTF_8));}catch(Exception ignored){throw new AssertionError("Invalid private QA input");}finally{Arrays.fill(raw,(byte)0);}
        Set<String> keys=new HashSet<>(Arrays.asList("origin","workspaceId","email","password","bootstrapNonce","nonce","phase"));
        assertEquals(keys.size(),value.length());Iterator<String> names=value.keys();while(names.hasNext())assertTrue("Known input fields only",keys.contains(names.next()));
        for(String key:keys)assertTrue("String input fields only",value.opt(key) instanceof String);
        assertTrue("Fixed QA origin",ORIGIN.equals(value.getString("origin")));
        assertTrue("Fresh native QA namespace",value.getString("workspaceId").matches("fountain-qa-cloud-native-[a-f0-9]{16}"));
        assertTrue("Android phase",value.getString("phase").equals("android"));
        assertTrue("Bootstrap proof shape",value.getString("bootstrapNonce").matches("[A-Za-z0-9_-]{43}"));
        assertTrue("Sealed proof shape",value.getString("nonce").matches("[A-Za-z0-9_-]{43}"));
        assertTrue("Email shape",value.getString("email").length()<=254&&value.getString("email").matches("[^\\s@]+@[^\\s@]+"));
        assertTrue("Password bounds",value.getString("password").length()>=10&&value.getString("password").length()<=1024&&!NativePolicy.controls(value.getString("password")));
        return value;
    }
    private String evaluate(String script)throws Exception {
        AtomicReference<String> value=new AtomicReference<>();CountDownLatch ready=new CountDownLatch(1);
        instrumentation.runOnMainSync(()->activity.getBridge().getWebView().evaluateJavascript(script,result->{value.set(result);ready.countDown();}));
        assertTrue("WebView evaluation completed",ready.await(10,TimeUnit.SECONDS));return value.get();
    }
    private void until(String expression,String label,long timeout)throws Exception {
        long end=SystemClock.elapsedRealtime()+timeout;
        while(SystemClock.elapsedRealtime()<end){if("true".equals(evaluate("(()=>{try{return !!("+expression+");}catch(_){return false;}})()")))return;Thread.sleep(100);}throw new AssertionError(label);
    }
    private JSONObject promise(String body)throws Exception {
        String key="proof_"+UUID.randomUUID().toString().replace("-","");
        evaluate("globalThis.__cloudClientProof=globalThis.__cloudClientProof||{};(async()=>{"+body+"})().then(v=>__cloudClientProof['"+key+"']={ok:true,value:v},()=>__cloudClientProof['"+key+"']={ok:false});true");
        until("globalThis.__cloudClientProof&&__cloudClientProof['"+key+"']","Native UI operation completed",45000);
        String raw=evaluate("JSON.stringify(__cloudClientProof['"+key+"'])");JSONObject result=new JSONObject((String)new JSONTokener(raw).nextValue());
        evaluate("delete __cloudClientProof['"+key+"'];true");assertTrue("Actual native UI request succeeded",result.getBoolean("ok"));return result.getJSONObject("value");
    }
    private JSONObject session(String workspace)throws Exception {
        return promise("const r=await FountainTransport.request('/api/session'),s=await r.json();return {status:r.status,authenticated:s.authenticated===true,anonymous:s.authenticated===false,workspace:s.workspace_id==="+JSONObject.quote(workspace)+",owner:s.member?.id==='local'&&s.member?.role==='owner'&&s.member?.active===true,headersSafe:!r.headers.has('set-cookie')&&!r.headers.has('cookie'),cookieEmpty:document.cookie===''};");
    }
    private void reload()throws Exception {
        evaluate("globalThis.__cloudClientReloadMarker=true;true");
        instrumentation.runOnMainSync(()->activity.getBridge().getWebView().reload());
        until("!globalThis.__cloudClientReloadMarker&&globalThis.FountainTransport&&document.querySelector('#login-form,#page-title,#sidebar .nav-item')","Fresh bundled UI document reloaded",45000);
    }
    private void logout()throws Exception {
        evaluate("document.querySelector('[data-action=\"settings\"]')?.click();true");
        until("document.querySelector('[data-action=\"settings-tab\"][data-tab=\"security\"]')","Real security settings tab",15000);
        evaluate("document.querySelector('[data-action=\"settings-tab\"][data-tab=\"security\"]').click();true");
        until("document.querySelector('[data-action=\"logout\"]')","Real security logout control",15000);
        evaluate("document.querySelector('[data-action=\"logout\"]').click();true");until("document.querySelector('#login-form')","UI logout completed",45000);
    }
    private static void result(Context context,JSONObject evidence)throws Exception {
        result(context,evidence,"fountain-cloud-client-result.json");
    }
    private static void result(Context context,JSONObject evidence,String name)throws Exception {
        assertTrue("Fixed private result paths only",name.equals("fountain-cloud-client-result.json")||name.equals("fountain-cloud-client-readback-result.json"));
        File output=new File(context.getFilesDir(),name);
        try(OutputStream stream=new FileOutputStream(Os.open(output.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_TRUNC|OsConstants.O_NOFOLLOW,0600))){Os.chmod(output.getPath(),0600);stream.write(evidence.toString().getBytes(StandardCharsets.UTF_8));}
    }
    @Test public void sealedPathPolicyRejectsOtherEndpointsWithoutConnecting()throws Exception {
        assertEquals("/api/session",logicalPath(new URL(ORIGIN+PREFIX+"/api/session")));
        assertEquals("/api/pages/qa-native-shared?x=%2F",logicalPath(new URL(ORIGIN+PREFIX+"/api/pages/qa-native-shared?x=%2F")));
        for(String suffix:new String[]{"/api/../session","/api/%252e%252e/session","/api/session#x","/wire","/api/session?x=%0a"})try{logicalPath(new URL(ORIGIN+PREFIX+suffix));fail("Invalid path accepted");}catch(IOException expected){}
        for(String origin:new String[]{"https://example.com",ORIGIN+":8443","http://ehnovtfadpkwtubmwltl.supabase.co","https://user@ehnovtfadpkwtubmwltl.supabase.co"})try{logicalPath(new URL(origin+PREFIX+"/api/session"));fail("Another origin accepted");}catch(IOException expected){}
    }
    @Test public void actualMainUIBootstrapPageCreateEditReloadAndLogout()throws Exception {
        Context context=instrumentation.getTargetContext();JSONObject input=consume(context);
        assertTrue("Dedicated emulator only",Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));
        JSONObject prior=new CookieVault(context).read();
        assertTrue("Preserve existing active session",prior.isNull("active")||!prior.has("active"));assertTrue("Preserve existing pending revocation",prior.isNull("revoke")||!prior.has("revoke"));
        final String workspace=input.getString("workspaceId"),suffix=workspace.substring(workspace.length()-16),text="Android native QA "+suffix,title="Android native QA page "+suffix;
        SealedGate gate=new SealedGate(input.getString("nonce"));input.remove("nonce");
        JSONObject evidence=new JSONObject().put("passed",false).put("actualMainWebViewUI",true).put("sealedQAEndpoint",true).put("directProductionEndpoint",false)
            .put("uploadVerified",false).put("nativeDownloadVerified",false).put("workspaceSHA256",OutboxPolicy.hash(workspace)).put("editTextSHA256",OutboxPolicy.hash(text));
        boolean loginAttempted=false;Throwable failure=null;gate.install();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(value->activity=value);
            try {
                until("globalThis.FountainTransport&&globalThis.Capacitor?.nativePromise","Real bundled native transport",20000);
                boolean form="true".equals(evaluate("(()=>{const f=document.querySelector('#native-configuration-form');if(!f)return false;f.elements.origin.value="+JSONObject.quote(ORIGIN)+";f.requestSubmit();return true;})()"));evidence.put("configuredThroughUI",form);
                if(!form){promise("await FountainTransport.configure({origin:"+JSONObject.quote(ORIGIN)+"});return {configured:true};");reload();}
                until("document.querySelector('#login-form input[name=setup_nonce]')","Actual owner bootstrap login form",45000);
                assertTrue("Anonymous bootstrap request used sealed HTTPS interceptor",gate.requests.get()>0);
                JSONObject anonymous=session(workspace);assertEquals(200,anonymous.getInt("status"));assertTrue("Anonymous before credentials",anonymous.getBoolean("anonymous")&&anonymous.getBoolean("headersSafe")&&anonymous.getBoolean("cookieEmpty"));
                evidence.put("anonymousInterceptBeforeCredentials",true);loginAttempted=true;
                assertEquals("true",evaluate("(()=>{const f=document.querySelector('#login-form');f.elements.email.value="+JSONObject.quote(input.getString("email"))+";f.elements.password.value="+JSONObject.quote(input.getString("password"))+";f.elements.setup_nonce.value="+JSONObject.quote(input.getString("bootstrapNonce"))+";if(!f.elements.create_account.checked)f.elements.create_account.click();f.elements.setup_password_confirm.value="+JSONObject.quote(input.getString("password"))+";if(!f.checkValidity())return false;f.requestSubmit();return true;})()"));
                input.remove("password");input.remove("bootstrapNonce");input.remove("email");
                until("!document.querySelector('#login-form')&&document.querySelector('[data-action=\"add-page\"]')","Actual UI owner bootstrap completed",60000);
                JSONObject authenticated=session(workspace);assertEquals(200,authenticated.getInt("status"));for(String field:new String[]{"authenticated","workspace","owner","headersSafe","cookieEmpty"})assertTrue("Actual current native owner/session",authenticated.getBoolean(field));
                JSONObject saved=new CookieVault(context).read();assertTrue("Production Keystore session saved",saved.optString("active","").length()>0&&ORIGIN.equals(saved.optString("origin")));
                evidence.put("uiBootstrapLogin",true).put("nativeKeystoreSessionSaved",true).put("rendererCookieEmpty",true).put("rendererCookieHeadersAbsent",true);
                evaluate("document.querySelector('[data-action=\"add-page\"]').click();true");until("document.querySelector('#page-form')","Real page creation form",15000);
                evaluate("(()=>{const f=document.querySelector('#page-form');f.elements.title.value="+JSONObject.quote(title)+";f.requestSubmit();return true;})()");
                until("document.querySelector('#page-title')?.textContent==="+JSONObject.quote(title),"UI-created page rendered",45000);
                JSONObject created=promise("const r=await FountainTransport.request('/api/workspace'),j=await r.json(),p=(j.pages||[]).filter(p=>p.title==="+JSONObject.quote(title)+");return {status:r.status,count:p.length,id:p[0]?.id||''};");
                assertEquals(200,created.getInt("status"));assertEquals(1,created.getInt("count"));assertFalse(created.getString("id").isEmpty());evidence.put("uiCreatedPageServerCount",1).put("createdPageIdSHA256",OutboxPolicy.hash(created.getString("id")));
                evaluate("location.hash='page/"+PAGE+"';true");
                until("location.hash==='#page/"+PAGE+"'&&document.querySelector('#blocks .block-content[contenteditable=true]')?.textContent==='모바일 공통 검증 시작'","Shared QA page editable in UI",45000);
                assertEquals("true",evaluate("(()=>{const el=document.querySelector('#blocks .block-content[contenteditable=true]');if(el.textContent!=='모바일 공통 검증 시작')return false;el.focus();el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:"+JSONObject.quote(text)+"}));el.textContent="+JSONObject.quote(text)+";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:"+JSONObject.quote(text)+"}));return true;})()"));
                long until=SystemClock.elapsedRealtime()+60000;boolean persisted=false;
                while(SystemClock.elapsedRealtime()<until){JSONObject page=promise("const r=await FountainTransport.request('/api/pages/"+PAGE+"'),j=await r.json(),b=j.blocks||j.page?.blocks||[];return {status:r.status,matched:b.some(b=>b.text==="+JSONObject.quote(text)+")};");if(page.optInt("status")==200&&page.optBoolean("matched")){persisted=true;break;}Thread.sleep(400);}
                assertTrue("UI edit committed to real QA backend",persisted);reload();
                until("location.hash==='#page/"+PAGE+"'&&Array.from(document.querySelectorAll('#blocks .block-content')).some(e=>e.textContent==="+JSONObject.quote(text)+")","Fresh reload retained committed edit",60000);
                authenticated=session(workspace);assertTrue(authenticated.getBoolean("authenticated")&&authenticated.getBoolean("workspace")&&authenticated.getBoolean("owner"));
                evidence.put("uiSharedParagraphSaved",true).put("uiReloadReadVerified",true).put("nativeCookieBoundaryIntact",NativeCookieBoundary.permits(NativeCookieBoundary.epoch()));
            }catch(Throwable error){failure=error;}
            finally {
                if(loginAttempted){
                    boolean uiLogout=false;
                    try{logout();uiLogout=true;}catch(Throwable logoutFailure){
                        if(failure==null)failure=new AssertionError("Actual UI logout did not complete",logoutFailure);
                        // Failure cleanup only. A transport DELETE cannot turn a
                        // failed UI logout into a successful product UI proof.
                        try{promise("const r=await FountainTransport.request('/api/session',{method:'DELETE'});return {ok:r.ok};");evidence.put("cleanupTransportFallback",true);}catch(Throwable ignored){}
                    }
                    try{JSONObject ended=session(workspace);assertTrue("Normal native logout verified",ended.getBoolean("anonymous"));JSONObject vault=new CookieVault(context).read();assertTrue("Native session cleared",vault.isNull("active")&&vault.isNull("revoke"));evidence.put("normalLogoutVerified",true).put("logoutThroughUI",uiLogout);if(failure==null)assertTrue("Successful proof requires actual UI logout",uiLogout);}catch(Throwable error){if(failure==null)failure=error;}
                }
            }
        }catch(Throwable error){if(failure==null)failure=error;}
        finally{gate.close();input.remove("password");input.remove("bootstrapNonce");input.remove("email");}
        evidence.put("forwardedRequests",gate.requests.get()).put("blockedHttpsRequests",gate.blocked.get()).put("testFactoryDisabled",gate.nonce.get()==null).put("passed",failure==null);
        if(failure!=null)evidence.put("failureClass",failure.getClass().getSimpleName());result(context,evidence);
        if(failure!=null)throw new AssertionError("Actual native UI QA did not complete",failure);
    }

    /** Separate fresh-process phase: no bootstrap, page creation or document edit. */
    @Test public void actualMainUIReadsIOSChangesAndLogsOut()throws Exception {
        Context context=instrumentation.getTargetContext();JSONObject input=consume(context);
        input.remove("bootstrapNonce"); // Never used or passed to a renderer in this phase.
        assertTrue("Dedicated emulator only",Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));
        JSONObject prior=new CookieVault(context).read();
        assertTrue("Preserve existing active session",prior.isNull("active")||!prior.has("active"));
        assertTrue("Preserve existing pending revocation",prior.isNull("revoke")||!prior.has("revoke"));
        final String workspace=input.getString("workspaceId"),expected="iOS native QA "+workspace.substring(workspace.length()-16);
        SealedGate gate=new SealedGate(input.getString("nonce"));input.remove("nonce");
        JSONObject evidence=new JSONObject().put("passed",false).put("actualMainWebViewUI",true).put("sealedQAEndpoint",true)
            .put("directProductionEndpoint",false).put("bootstrapUsed",false).put("domainEdits",0).put("uploadVerified",false).put("nativeDownloadVerified",false)
            .put("workspaceSHA256",OutboxPolicy.hash(workspace)).put("expectedTextSHA256",OutboxPolicy.hash(expected));
        boolean loginAttempted=false;Throwable failure=null;
        try {
            gate.install();
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
                scenario.onActivity(value->activity=value);
                try {
                    until("globalThis.FountainTransport&&globalThis.Capacitor?.nativePromise","Real bundled native transport",20000);
                    boolean form="true".equals(evaluate("(()=>{const f=document.querySelector('#native-configuration-form');if(!f)return false;f.elements.origin.value="+JSONObject.quote(ORIGIN)+";f.requestSubmit();return true;})()"));
                    evidence.put("configuredThroughUI",form).put("configuredThroughNativeFallback",!form);
                    if(form)until("document.querySelector('#login-form')","UI server configuration completed",45000);
                    else promise("await FountainTransport.configure({origin:"+JSONObject.quote(ORIGIN)+"});return {configured:true};");
                    reload();until("document.querySelector('#login-form input[name=email]')","Actual normal login form",45000);
                    assertTrue("Anonymous UI request used sealed HTTPS interceptor",gate.requests.get()>0);
                    JSONObject anonymous=session(workspace);assertEquals(200,anonymous.getInt("status"));
                    assertTrue("Anonymous before credentials",anonymous.getBoolean("anonymous")&&anonymous.getBoolean("headersSafe")&&anonymous.getBoolean("cookieEmpty"));
                    evidence.put("anonymousInterceptBeforeCredentials",true);loginAttempted=true;
                    assertEquals("true",evaluate("(()=>{const f=document.querySelector('#login-form');if(f.elements.create_account?.checked)f.elements.create_account.click();if(f.elements.setup_nonce)f.elements.setup_nonce.value='';if(f.elements.setup_password_confirm)f.elements.setup_password_confirm.value='';f.elements.email.value="+JSONObject.quote(input.getString("email"))+";f.elements.password.value="+JSONObject.quote(input.getString("password"))+";if(!f.checkValidity())return false;f.requestSubmit();return true;})()"));
                    input.remove("password");input.remove("email");
                    until("!document.querySelector('#login-form')&&document.querySelector('#sidebar [data-action=\"page\"][data-id=\""+PAGE+"\"]')","Normal owner login completed",60000);
                    JSONObject authenticated=session(workspace);assertEquals(200,authenticated.getInt("status"));
                    for(String field:new String[]{"authenticated","workspace","owner","headersSafe","cookieEmpty"})assertTrue("Actual current native owner/session",authenticated.getBoolean(field));
                    JSONObject saved=new CookieVault(context).read();assertTrue("Production Keystore session saved",saved.optString("active","").length()>0&&ORIGIN.equals(saved.optString("origin")));
                    evidence.put("normalUILogin",true).put("sameAccountOwner",true).put("nativeKeystoreSessionSaved",true).put("rendererCookieEmpty",true).put("rendererCookieHeadersAbsent",true);
                    assertEquals("true",evaluate("(()=>{const page=document.querySelector('#sidebar [data-action=\"page\"][data-id=\""+PAGE+"\"]');if(!page)return false;page.click();return true;})()"));
                    until("location.hash==='#page/"+PAGE+"'&&document.querySelector('#blocks .block-content')?.textContent==="+JSONObject.quote(expected),"UI read iOS committed paragraph",60000);
                    JSONObject actual=promise("const r=await FountainTransport.request('/api/pages/"+PAGE+"'),j=await r.json(),b=j.blocks||j.page?.blocks||[];return {status:r.status,firstMatches:b[0]?.type==='paragraph'&&b[0]?.text==="+JSONObject.quote(expected)+",matchingCount:b.filter(b=>b.text==="+JSONObject.quote(expected)+").length,headersSafe:!r.headers.has('set-cookie')};");
                    assertEquals(200,actual.getInt("status"));assertTrue("Actual backend has the same first paragraph",actual.getBoolean("firstMatches"));assertEquals(1,actual.getInt("matchingCount"));assertTrue(actual.getBoolean("headersSafe"));
                    evidence.put("sidebarPageClicked",true).put("iosParagraphReadInUI",true).put("actualBackendReadMatched",true).put("matchingParagraphs",1)
                        .put("nativeCookieBoundaryIntact",NativeCookieBoundary.permits(NativeCookieBoundary.epoch()));
                }catch(Throwable error){failure=error;}
                finally {
                    if(loginAttempted){
                        boolean uiLogout=false;
                        try{logout();uiLogout=true;}catch(Throwable logoutFailure){
                            if(failure==null)failure=new AssertionError("Actual UI logout did not complete",logoutFailure);
                            try{promise("const r=await FountainTransport.request('/api/session',{method:'DELETE'});return {ok:r.ok};");evidence.put("cleanupTransportFallback",true);}catch(Throwable ignored){}
                        }
                        try{JSONObject ended=session(workspace);assertTrue("Normal native logout verified",ended.getBoolean("anonymous"));JSONObject vault=new CookieVault(context).read();assertTrue("Native session cleared",vault.isNull("active")&&vault.isNull("revoke"));evidence.put("normalLogoutVerified",true).put("logoutThroughUI",uiLogout);if(failure==null)assertTrue("Successful proof requires actual UI logout",uiLogout);}catch(Throwable error){if(failure==null)failure=error;}
                    }
                }
            }
        }catch(Throwable error){if(failure==null)failure=error;}
        finally{gate.close();input.remove("password");input.remove("email");}
        evidence.put("forwardedRequests",gate.requests.get()).put("blockedHttpsRequests",gate.blocked.get()).put("testFactoryDisabled",gate.nonce.get()==null).put("passed",failure==null);
        evidence.put("failurePresent",failure!=null);
        result(context,evidence,"fountain-cloud-client-readback-result.json");
        if(failure!=null)throw new AssertionError("Actual Android UI iOS readback did not complete",failure);
    }
}
