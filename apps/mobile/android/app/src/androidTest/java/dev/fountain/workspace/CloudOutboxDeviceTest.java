package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Root-managed disposable QA only. Each phase runs in a fresh OS process. */
@RunWith(AndroidJUnit4.class)
public class CloudOutboxDeviceTest {
    private static final String ORIGIN="https://ehnovtfadpkwtubmwltl.supabase.co", PREFIX="/functions/v1/fountain-api";
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private MainActivity activity;
    private String diagnosticPage;
    private static final class Gate {
        final AtomicReference<String> nonce;final AtomicBoolean offline=new AtomicBoolean(),sessionOnly=new AtomicBoolean();final AtomicInteger forwarded=new AtomicInteger(),blocked=new AtomicInteger();
        final List<HttpsURLConnection> sessionConnections=Collections.synchronizedList(new ArrayList<>());
        Gate(String nonce,boolean offline){this.nonce=new AtomicReference<>(nonce);this.offline.set(offline);}
        void install()throws Exception{
            final URL wire=new URL(ORIGIN+"/functions/v1/fountain-verify/wire");
            try{URL.setURLStreamHandlerFactory(protocol->!"https".equals(protocol)?null:new URLStreamHandler(){
                protected URLConnection openConnection(URL original)throws IOException{
                    String secret=nonce.get(),path;
                    try{if(secret==null||offline.get()||!"https".equals(original.getProtocol())||!"ehnovtfadpkwtubmwltl.supabase.co".equals(original.getHost())||original.getUserInfo()!=null||original.getRef()!=null||original.getPort()!=-1&&original.getPort()!=443||!original.getPath().startsWith(PREFIX+"/api/"))throw new IOException();
                        path=NativePolicy.path(original.getPath().substring(PREFIX.length())+(original.getQuery()==null?"":"?"+original.getQuery()),false);
                        if(sessionOnly.get()&&!path.equals("/api/session"))throw new IOException();
                    }catch(Exception denied){blocked.incrementAndGet();throw new IOException("Disposable QA private transport denied");}
                    HttpsURLConnection connection=(HttpsURLConnection)wire.openConnection();connection.setRequestProperty("X-Fountain-Verify",secret);connection.setRequestProperty("X-Fountain-Test-Path",path);if(path.equals("/api/session")){synchronized(sessionConnections){if(sessionConnections.size()>=256)throw new IOException("Disposable QA session bound exceeded");sessionConnections.add(connection);}}forwarded.incrementAndGet();return connection;
                }
            });}catch(Error priorFactory){throw new AssertionError("Fresh Root-owned instrumentation process required");}
        }
        int sessionDeleteConnections(){synchronized(sessionConnections){int count=0;for(HttpsURLConnection connection:sessionConnections)if("DELETE".equals(connection.getRequestMethod()))count++;return count;}}
        void close(){nonce.set(null);offline.set(true);}
    }
    private static JSONObject consume(Context context)throws Exception{
        File input=new File(context.getFilesDir(),"fountain-cloud-outbox-input.json");Assume.assumeTrue("Explicit disposable native outbox QA input required",input.exists());byte[] raw;
        try{
            android.system.StructStat stat=Os.lstat(input.getPath());assertTrue("Private regular input",OsConstants.S_ISREG(stat.st_mode));assertEquals(0600,stat.st_mode&0777);assertEquals(android.os.Process.myUid(),stat.st_uid);assertTrue(stat.st_size<=16384);
            try(InputStream in=new FileInputStream(Os.open(input.getPath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0));ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] part=new byte[1024];int n;while((n=in.read(part))!=-1){assertTrue(out.size()+n<=16384);out.write(part,0,n);}raw=out.toByteArray();
            }
        }finally{assertTrue("Consume private input immediately",input.delete());}
        JSONObject value;try{value=new JSONObject(OutboxPolicy.utf8(raw));}finally{Arrays.fill(raw,(byte)0);}
        Set<String> fields=new HashSet<>(Arrays.asList("origin","workspaceId","email","password","nonce","phase","pageId","expectedText","editedText"));assertEquals(fields.size(),value.length());
        Iterator<String> names=value.keys();while(names.hasNext()){String key=names.next();assertTrue(fields.contains(key)&&value.opt(key) instanceof String);}
        assertTrue(ORIGIN.equals(value.getString("origin")));assertTrue(value.getString("workspaceId").matches("fountain-qa-cloud-native-[a-f0-9]{16}"));
        assertTrue(value.getString("nonce").matches("[A-Za-z0-9_-]{43}"));assertTrue(value.getString("pageId").matches("[A-Za-z0-9_-]{1,160}"));
        assertTrue(Arrays.asList("login-edit","queue-offline","restart-read","evict-read","logout").contains(value.getString("phase")));
        assertTrue(value.getString("email").matches("[^\\s@]+@[^\\s@]+")&&value.getString("email").length()<=254);assertTrue(value.getString("password").length()>=10&&value.getString("password").length()<=1024);
        for(String key:Arrays.asList("expectedText","editedText"))assertTrue(value.getString(key).codePointCount(0,value.getString(key).length())<=100000);
        return value;
    }
    private String evaluate(String script)throws Exception{
        AtomicReference<String> result=new AtomicReference<>();CountDownLatch done=new CountDownLatch(1);instrumentation.runOnMainSync(()->activity.getBridge().getWebView().evaluateJavascript(script,value->{result.set(value);done.countDown();}));assertTrue("Bundled UI evaluated",done.await(10,TimeUnit.SECONDS));return result.get();
    }
    private void until(String expression,String message,long timeout)throws Exception{
        long end=SystemClock.elapsedRealtime()+timeout;while(SystemClock.elapsedRealtime()<end){if("true".equals(evaluate("(()=>{try{return !!("+expression+");}catch(_){return false;}})()")))return;Thread.sleep(100);}throw new AssertionError(message);
    }
    private JSONObject promise(String body)throws Exception{
        String key="qa_"+UUID.randomUUID().toString().replace("-","");evaluate("globalThis.__outboxQA=globalThis.__outboxQA||{};(async()=>{"+body+"})().then(value=>__outboxQA['"+key+"']={ok:true,value},()=>__outboxQA['"+key+"']={ok:false});true");
        until("globalThis.__outboxQA?.['"+key+"']","Native UI operation settled",90000);JSONObject result=new JSONObject((String)new JSONTokener(evaluate("JSON.stringify(__outboxQA['"+key+"'])")).nextValue());evaluate("delete __outboxQA['"+key+"'];true");assertTrue("Actual native UI operation succeeded",result.getBoolean("ok"));return result.getJSONObject("value");
    }
    private static File database(Context context)throws Exception{return new File(context.getNoBackupFilesDir(),"durable_outbox/"+OutboxPolicy.hash(ORIGIN)+".sqlite");}
    private static JSONObject nativeState(Context context,String workspace,String page,String text)throws Exception{
        File file=database(context);assertTrue("Native SQLite exists",file.isFile());
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
            String profile;long head;
            try(Cursor c=db.rawQuery("SELECT value FROM control WHERE key='grant'",null)){assertTrue(c.moveToFirst());JSONObject grant=new JSONObject(c.getString(0));assertTrue("Actual native account scope",workspace.equals(grant.getJSONObject("session").getString("workspace_id")));profile=grant.getString("profileId");}
            try(Cursor c=db.rawQuery("SELECT value FROM control WHERE key='head'",null)){assertTrue(c.moveToFirst());head=Long.parseLong(c.getString(0));}
            String resource=profile+"|"+OutboxPolicy.encode(page);int operations=0;boolean draft=false,snapshot=false,qualified=true;
            try(Cursor c=db.rawQuery("SELECT bucket,key,payload FROM records WHERE mode='active' AND profile_id=? AND resource_key=?",new String[]{profile,resource})){
                while(c.moveToNext()){
                    String bucket=c.getString(0);byte[] raw=c.getBlob(2);JSONObject value=new JSONObject(OutboxPolicy.utf8(raw));
                    if(bucket.equals("operations"))operations++;
                    if(bucket.equals("drafts")&&!value.getJSONObject("draft").optString("reason").equals("basis")){JSONArray blocks=value.getJSONObject("draft").optJSONArray("blocks");if(blocks!=null)for(int i=0;i<blocks.length();i++)if(text.equals(blocks.getJSONObject(i).opt("text")))draft=true;}
                    if(bucket.equals("snapshots")){JSONArray blocks=value.getJSONObject("snapshot").getJSONArray("blocks");for(int i=0;i<blocks.length();i++)if(text.equals(blocks.getJSONObject(i).opt("text")))snapshot=true;}
                    try(Cursor owner=db.rawQuery("SELECT digest,trust FROM native_record_owners WHERE mode='active' AND bucket=? AND key=? AND profile_id=?",new String[]{bucket,c.getString(1),profile})){qualified&=owner.moveToFirst()&&OutboxPolicy.hash(raw).equals(owner.getString(0))&&"native".equals(owner.getString(1));}
                }
            }
            JSONObject result=new JSONObject().put("head",head).put("operations",operations).put("draft",draft).put("snapshot",snapshot).put("qualified",qualified).put("profileSHA256",OutboxPolicy.hash(profile));
            try(Cursor c=db.rawQuery("SELECT key,value FROM control WHERE key IN ('identity_state','needs_floor','owner')",null)){while(c.moveToNext()){String key=c.getString(0),value=c.getString(1);if(key.equals("identity_state"))result.put("identityVerified",value.equals("verified")).put("identityBlocked",value.equals("blocked")).put("identityExpired",value.equals("expired"));if(key.equals("needs_floor"))result.put("needsFloor",value.equals("1"));if(key.equals("owner"))result.put("ownerEmpty",value.isEmpty());}}
            return result;
        }
    }
    private static void deleteTree(File file,String root)throws Exception{
        assertTrue("Only the dedicated WebView origin IDB tree",file.getCanonicalPath().startsWith(root+File.separator));android.system.StructStat stat=Os.lstat(file.getPath());assertEquals(android.os.Process.myUid(),stat.st_uid);assertFalse(OsConstants.S_ISLNK(stat.st_mode));
        if(file.isDirectory()){File[] children=file.listFiles();assertNotNull(children);for(File child:children)deleteTree(child,root);}assertTrue(file.delete());
    }
    private static int evictOnlyIDB(Context context)throws Exception{
        File directory=new File(context.getDataDir(),"app_webview/Default/IndexedDB");assertTrue("Existing WebView IDB required",directory.isDirectory());String root=directory.getCanonicalPath();int removed=0;
        for(String name:Arrays.asList("https_localhost_0.indexeddb.leveldb","https_localhost_0.indexeddb.blob")){File origin=new File(directory,name);if(origin.exists()){deleteTree(origin,root);removed++;}}
        assertTrue("Only exact bundled localhost IDB directories removed",removed>0);return removed;
    }
    private void loginIfNeeded(JSONObject input)throws Exception{
        until("document.querySelector('#login-form,.native-recovery-entry,.native-recovery-dialog,#sidebar [data-action=page]')","Login, recovery or restored workspace appeared",90000);
        evaluate("globalThis.__outboxLoginQA={forms:new WeakSet(),buttons:new WeakSet(),submitted:0,continued:0,confirmed:0,accountSwitchClicks:0};true");
        if("true".equals(evaluate("!!document.querySelector('.native-recovery-entry')")))evaluate("document.querySelector('.native-recovery-entry').click();true");
        long end=SystemClock.elapsedRealtime()+90000;
        while(SystemClock.elapsedRealtime()<end){
            if("true".equals(evaluate("!!document.querySelector('#sidebar [data-action=page]')&&state.loaded===true&&state.session?.authenticated===true&&FountainNativeStorage?.ready===true")))return;
            String email=input.getString("email"),password=input.getString("password");
            evaluate("(()=>{const q=__outboxLoginQA,dialog=document.querySelector('.native-recovery-dialog[open]'),f=dialog?dialog.querySelector('.native-recovery-login'):document.querySelector('#login-form');const switcher=dialog&&!f&&FountainNativeStorage?.identityState==='blocked'&&dialog.getAttribute('aria-busy')!=='true'&&q.accountSwitchClicks<2&&(!q.lastAccountSwitch||Date.now()-q.lastAccountSwitch>1000)&&[...dialog.querySelectorAll('button')].find(b=>b.textContent==='다른 계정으로 로그인'&&!b.disabled);if(switcher){q.lastAccountSwitch=Date.now();q.accountSwitchClicks++;switcher.click();return true;}if(f&&f.elements.email&&f.elements.password&&!q.forms.has(f)&&!f.elements.password.disabled){q.forms.add(f);if(f.elements.create_account?.checked)f.elements.create_account.click();f.elements.email.value="+JSONObject.quote(email)+";f.elements.password.value="+JSONObject.quote(password)+";if(f.elements.setup_nonce)f.elements.setup_nonce.value='';if(f.elements.setup_password_confirm)f.elements.setup_password_confirm.value='';q.submitted++;f.requestSubmit();}for(const b of document.querySelectorAll('.native-recovery-dialog button')){if(b.disabled||q.buttons.has(b))continue;if(b.textContent==='원본 보관하고 최신 상태로 계속'){q.buttons.add(b);q.continued++;b.click();}else if(b.textContent==='확인하고 계속'){q.buttons.add(b);q.confirmed++;b.click();}}return true;})()");
            Thread.sleep(150);
        }
        throw new AssertionError("Verified account did not complete the native storage barrier");
    }
    private void installDiagnostics()throws Exception{
        evaluate("(()=>{if(globalThis.__outboxDiagnostics)return true;const d={events:[],sequence:0,wrapped:new WeakSet()},original=globalThis.dispatchEvent;globalThis.__outboxDiagnostics=d;const stateNow=()=>{try{return typeof state==='object'?state:null;}catch(_){return null;}},push=e=>{e.sequence=++d.sequence;d.events.push(e);if(d.events.length>40)d.events.shift();};globalThis.dispatchEvent=function(event){const type=event?.type;if(['fountain-native-outbox-pause','fountain-native-outbox-resume','fountain-native-outbox-ready','fountain-native-scope-changed'].includes(type)){const detail=event.detail||{},s=stateNow(),item={type:type.endsWith('-pause')?'pause':type.endsWith('-resume')?'resume':type.endsWith('-ready')?'ready':'scope',reconciled:detail.reconciled===true,preservedInput:detail.preservedInput===true,blocked:detail.blocked===true,loaded:!!s?.loaded,pagePresent:!!s?.page,channelPresent:!!s?.channel?.base,routePage:s?.route==='page',storageReady:globalThis.FountainNativeStorage?.ready===true};const counts=detail.summary?.counts;if(counts){item.counts={};for(const key of ['refresh','keep','acknowledge','quarantine','import'])if(Number.isInteger(counts[key])&&counts[key]>=0&&counts[key]<=100000)item.counts[key]=counts[key];}push(item);if(type==='fountain-native-outbox-resume'&&typeof detail.readCurrent==='function'&&!d.wrapped.has(detail)){d.wrapped.add(detail);const read=detail.readCurrent,before=s?.bootGeneration;detail.readCurrent=async function(...args){try{const result=await read.apply(this,args),active=stateNow(),paused=active?.nativeOutboxPause,snapshot=result?.snapshot;item.readObserved=true;item.sameProfile=result?.profile?.id===paused?.profile?.id;item.sameRole=result?.profile?.session?.member?.role===paused?.profile?.session?.member?.role;item.snapshotPresent=!!snapshot;item.epochMatches=!!snapshot&&snapshot.epoch===paused?.channel?.base?.epoch;item.accessEditable=typeof snapshot?.access_level==='number'&&snapshot.access_level>=3;item.locked=snapshot?.page?.locked===true;item.archived=snapshot?.page?.archived===true;item.channelPresent=!!paused?.channel?.base;item.openingNavigationCurrent=!!(paused?.navigation&&active?.nativeNavigation===paused.navigation&&paused.navigation.binding===active?.session?.cache_binding&&paused.navigation.generation===active?.bootGeneration);item.afterLoaded=!!active?.loaded;item.afterPagePresent=!!active?.page;item.bootGenerationChanged=active?.bootGeneration!==before;return result;}catch(error){item.readFailed=true;throw error;}};}}return original.call(this,event);};return true;})()");
    }
    private void installMethodDiagnostics()throws Exception{
        evaluate("(()=>{const d=globalThis.__outboxDiagnostics;if(!d||d.nativeWrapped)return true;d.nativeWrapped=true;d.calls={};d.logout={started:0,succeeded:0,failed:0};d.code=error=>{const allowed=['OUTBOX_ACCESS_REQUIRED','OUTBOX_REJECTED','OUTBOX_UNAVAILABLE','OUTBOX_STORAGE_FAILED','OUTBOX_RECOVERY_REQUIRED','OUTBOX_IDENTITY_REQUIRED','OUTBOX_CLOSED','NATIVE_INPUT','NATIVE_NETWORK','STALE_SESSION','SESSION_CHANGED','STALE_REQUEST','PROFILE_SUSPENDED','RECOVERY_STALE'];return allowed.includes(error?.code)?error.code:allowed.includes(error?.cause?.code)?error.cause.code:'unclassified';};const original=Capacitor.nativePromise;Capacitor.nativePromise=function(plugin,method,options){let key=null;if(plugin==='FountainNative'){if(['commitDelta','stageDelta','outboxOpen','outboxReconcile'].includes(method))key=method;if(method==='request'&&options?.path==='/api/session')key=options.method==='DELETE'?'sessionDelete':options.method==='POST'?'sessionPost':'sessionGet';}let item;if(key){item=d.calls[key]||(d.calls[key]={started:0,succeeded:0,failed:0});item.started++;}const result=original.apply(this,arguments);if(item&&result?.then)result.then(value=>{item.succeeded++;if(Number.isInteger(value?.status)&&value.status>=100&&value.status<=599)item.lastStatus=value.status;},error=>{item.failed++;item.lastError=d.code(error);});return result;};return true;})()");
    }
    private void installLogoutDiagnostics()throws Exception{
        evaluate("(()=>{const d=globalThis.__outboxDiagnostics;if(!d||d.logoutWrapped||typeof doAction!=='function')return true;d.logoutWrapped=true;d.logout.accepted=0;const original=doAction;doAction=function(target){const observed=target?.dataset?.action==='logout';if(observed){d.logout.started++;if(!state.nativeOutboxPause&&!state.nativeOutboxResuming)d.logout.accepted++;}const result=original.apply(this,arguments);if(observed&&result?.then)result.then(()=>d.logout.succeeded++,error=>{d.logout.failed++;d.logout.lastError=d.code(error);});return result;};return true;})()");
    }
    private static JSONObject privateCredentialState(Context context)throws Exception{
        CookieVault vault=new CookieVault(context);JSONObject value=vault.read();return new JSONObject().put("activePresent",!value.isNull("active")).put("revokePresent",!value.isNull("revoke")).put("originMatches",ORIGIN.equals(value.optString("origin"))).put("invalidated",vault.invalidated(ORIGIN));
    }
    private JSONObject safeUI()throws Exception{
        String encoded=evaluate("JSON.stringify((()=>{const q=globalThis.__outboxLoginQA||{};let s=null;try{s=typeof state==='object'?state:null;}catch(_){}return {loginForms:document.querySelectorAll('#login-form').length,recoveryLoginForms:document.querySelectorAll('.native-recovery-login').length,recoveryDialogs:document.querySelectorAll('.native-recovery-dialog').length,busyDialogs:document.querySelectorAll('.native-recovery-dialog[aria-busy=true]').length,sidebarPages:document.querySelectorAll('#sidebar [data-action=page]').length,editableBlocks:document.querySelectorAll('#blocks .block-content[contenteditable=true]').length,submitted:q.submitted||0,continued:q.continued||0,confirmed:q.confirmed||0,storagePresent:!!globalThis.FountainNativeStorage,storageReady:globalThis.FountainNativeStorage?.ready===true,storageResourceReady:globalThis.FountainNativeStorage?.resourceAccess==='ready',transportPresent:!!globalThis.FountainTransport,loaded:!!s?.loaded,routePage:s?.route==='page',routeHome:s?.route==='home',routeDatabase:s?.route==='database',pagePresent:!!s?.page,pageMatches:!!s?.page&&s.page.id==="+JSONObject.quote(diagnosticPage)+",channelPresent:!!s?.channel,channelReady:!!s?.channel?.base,channelClosed:s?.channel?.closed===true,nativePaused:!!s?.nativeOutboxPause,nativeResuming:!!s?.nativeOutboxResuming,recoveryPaused:!!s?.nativeRecoveryPaused,savedIndication:document.querySelector('#save-status')?.textContent==='모든 변경 사항 저장됨',events:globalThis.__outboxDiagnostics?.events||[],nativeCalls:globalThis.__outboxDiagnostics?.calls||{},logout:globalThis.__outboxDiagnostics?.logout||{}};})())");
        return new JSONObject((String)new JSONTokener(encoded).nextValue());
    }
    private void edit(String expected,String text)throws Exception{
        assertEquals("true",evaluate("(()=>{const e=document.querySelector('#blocks .block-content[contenteditable=true]');if(!e||e.textContent!=="+JSONObject.quote(expected)+")return false;e.focus();e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:"+JSONObject.quote(text)+"}));e.textContent="+JSONObject.quote(text)+";e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:"+JSONObject.quote(text)+"}));return true;})()"));
    }
    private void logoutUI()throws Exception{
        installLogoutDiagnostics();
        until("(()=>{const trace=globalThis.__outboxDiagnostics.logout;if(trace.accepted>0)return true;if(state.nativeOutboxPause||state.nativeOutboxResuming||state.nativeRecoveryPreparing||state.nativeRecoveryPaused||!state.loaded||!FountainNativeStorage.ready){trace.readyAt=0;return false;}if(!trace.readyAt){trace.readyAt=Date.now();return false;}if(Date.now()-trace.readyAt<250)return false;const usable=b=>b&&!b.disabled&&!b.closest('[inert]')&&b.getClientRects().length>0;const logout=document.querySelector('[data-action=logout]');if(usable(logout)&&(trace.clicks||0)<3&&(!trace.lastClick||Date.now()-trace.lastClick>1000)){trace.clicks=(trace.clicks||0)+1;trace.lastClick=Date.now();logout.click();return trace.accepted>0;}const security=document.querySelector('[data-action=settings-tab][data-tab=security]');if(usable(security))security.click();else if(!logout){const settings=document.querySelector('[data-action=settings]');if(usable(settings))settings.click();}return false;})()","UI accepted logout after the native barrier",90000);
        until("document.querySelector('#login-form,.native-recovery-login')","UI logout completed",90000);
    }
    @Test public void actualDurableOutboxAcrossRootManagedProcessPhases()throws Exception{
        Context context=instrumentation.getTargetContext();JSONObject input=consume(context);diagnosticPage=input.getString("pageId");String phase=input.getString("phase"),workspace=input.getString("workspaceId"),page=input.getString("pageId"),expected=input.getString("expectedText"),edited=input.getString("editedText");
        assertTrue(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));boolean offline=phase.equals("restart-read")||phase.equals("evict-read");Gate gate=new Gate(input.getString("nonce"),offline);input.remove("nonce");
        JSONObject evidence=new JSONObject().put("passed",false).put("phase",phase).put("pid",android.os.Process.myPid()).put("workspaceSHA256",OutboxPolicy.hash(workspace)).put("pageSHA256",OutboxPolicy.hash(page)).put("textSHA256",OutboxPolicy.hash(phase.equals("login-edit")||phase.equals("queue-offline")?edited:expected)).put("actualPrivateHTTPS",true).put("directProductionEndpoint",false).put("bootstrapUsed",false);
        Throwable failure=null;assertNull("Fresh process private QA opt-in only",System.getProperty("dev.fountain.outbox.qa"));System.setProperty("dev.fountain.outbox.qa","1");
        try{
            if(phase.equals("logout"))evidence.put("beforeBootNative",nativeState(context,workspace,page,expected)).put("beforeBootCredentials",privateCredentialState(context));
            if(phase.equals("evict-read")){JSONObject before=nativeState(context,workspace,page,expected);evidence.put("evictedIDBDirectories",evictOnlyIDB(context));JSONObject after=nativeState(context,workspace,page,expected);assertEquals(before.toString(),after.toString());evidence.put("nativeUnchangedByIDBEviction",true);}
            gate.install();
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
              try {
                scenario.onActivity(value->activity=value);until("globalThis.FountainTransport&&globalThis.Capacitor?.nativePromise","Real bundled native transport appeared",30000);installDiagnostics();installMethodDiagnostics();
                if("true".equals(evaluate("!!document.querySelector('#native-configuration-form')"))){evaluate("(()=>{const f=document.querySelector('#native-configuration-form');f.elements.origin.value="+JSONObject.quote(ORIGIN)+";f.requestSubmit();return true;})()");}
                until("FountainTransport.outboxEnabled===true","Actual debug-only native capability enabled",30000);
                if(!offline)loginIfNeeded(input);
                input.remove("email");input.remove("password");
                until("globalThis.FountainNativeStorage?.ready===true&&state.loaded===true&&state.session?.authenticated===true&&document.querySelector('#sidebar [data-action=page]')","Native canonical/receipt barrier completed before application",90000);
                evaluate("location.hash='page/'+"+JSONObject.quote(page)+";true");
                until("document.querySelector('#blocks .block-content')?.textContent==="+JSONObject.quote(expected),"Expected document restored in actual UI",90000);
                JSONObject before=nativeState(context,workspace,page,expected);evidence.put("beforeNative",before).put("beforeEditUI",safeUI());
                if(phase.equals("queue-offline")){gate.offline.set(true);evaluate("dispatchEvent(new Event('offline'));true");}
                if(phase.equals("login-edit")||phase.equals("queue-offline")){
                    edit(expected,edited);long end=SystemClock.elapsedRealtime()+90000;JSONObject state=null;
                    while(SystemClock.elapsedRealtime()<end){state=nativeState(context,workspace,page,edited);if(state.getBoolean("qualified")&&state.getLong("head")>before.getLong("head")&&(phase.equals("queue-offline")?state.getInt("operations")>0&&state.getBoolean("draft"):state.getBoolean("snapshot")&&state.getInt("operations")==0))break;Thread.sleep(100);}
                    assertNotNull(state);evidence.put("afterNative",state).put("afterCommitUI",safeUI());assertTrue("Native SQL COMMIT advanced after actual UI edit",state.getLong("head")>before.getLong("head"));assertTrue("Native exact source attribution",state.getBoolean("qualified"));
                    if(phase.equals("queue-offline")){assertTrue(state.getInt("operations")>0&&state.getBoolean("draft"));evidence.put("nativePendingInputCommitted",true);}
                    else{assertTrue(state.getBoolean("snapshot")&&state.getInt("operations")==0);evidence.put("nativeSnapshotAndAckCommitted",true).put("head",state.getLong("head"));until("document.querySelector('#save-status')?.textContent==='모든 변경 사항 저장됨'","Saved indication followed real native ACK COMMIT",30000);
                        JSONObject actual=promise("const r=await FountainTransport.request('/api/pages/'+encodeURIComponent("+JSONObject.quote(page)+")+'/collaboration'),j=await r.json();return {ok:r.ok,matched:(Array.isArray(j.blocks)?j.blocks:j.page?.blocks||[]).some(b=>b.text==="+JSONObject.quote(edited)+"),safe:!r.headers.has('set-cookie')&&!r.headers.has('cookie')};");assertTrue("Actual sealed backend independently returned the edited text",actual.getBoolean("ok")&&actual.getBoolean("matched")&&actual.getBoolean("safe"));
                        evidence.put("canonicalPOSTAndNativeACKCommitted",true).put("actualBackendReadMatched",true);}
                    evidence.put("head",state.getLong("head"));
                }else if(offline){assertTrue("No HTTPS forwarded before offline hydration",gate.forwarded.get()==0);assertTrue("Pending input restored from native SQL",before.getInt("operations")>0&&before.getBoolean("draft")&&before.getBoolean("qualified"));evidence.put("offlineNativePendingRestored",true).put("head",before.getLong("head"));}
                else{
                    long end=SystemClock.elapsedRealtime()+90000;JSONObject state=before;while(state.getInt("operations")>0&&SystemClock.elapsedRealtime()<end){Thread.sleep(200);state=nativeState(context,workspace,page,expected);}assertEquals("Pending edits synchronized before logout",0,state.getInt("operations"));assertTrue(state.getBoolean("snapshot"));
                    JSONObject actual=promise("const r=await FountainTransport.request('/api/pages/'+encodeURIComponent("+JSONObject.quote(page)+")+'/collaboration'),j=await r.json();return {ok:r.ok,matched:(Array.isArray(j.blocks)?j.blocks:j.page?.blocks||[]).some(b=>b.text==="+JSONObject.quote(expected)+")};");assertTrue("Actual server canonical matched before logout",actual.getBoolean("ok")&&actual.getBoolean("matched"));
                    evidence.put("beforeLogoutNative",state).put("beforeLogoutCredentials",privateCredentialState(context)).put("beforeLogoutUI",safeUI());logoutUI();
                    JSONObject loggedOut=promise("const r=await FountainTransport.request('/api/session'),j=await r.json();const deletion=globalThis.__outboxDiagnostics.calls.sessionDelete;return {anonymous:r.status===200&&j.authenticated===false,deleteSucceeded:deletion?.succeeded>0&&deletion.lastStatus>=200&&deletion.lastStatus<300};");assertTrue("Actual session DELETE completed and subsequent server session is anonymous",loggedOut.getBoolean("anonymous")&&loggedOut.getBoolean("deleteSucceeded"));assertTrue("Actual sealed HTTPS DELETE connection exists",gate.sessionDeleteConnections()>0);
                    JSONObject vault=new CookieVault(context).read();assertTrue("Actual private logout cleared current credentials",vault.isNull("active")&&vault.isNull("revoke"));evidence.put("pendingFlushedAndLogoutVerified",true).put("head",state.getLong("head"));
                }
                assertEquals("true",evaluate("document.cookie===''") );evidence.put("rendererCookieEmpty",true).put("actualMainWebView",true);
              } catch(Throwable problem) { try{evidence.put("ui",safeUI());}catch(Exception unavailable){evidence.put("uiUnavailable",true);}try{evidence.put("failureNative",nativeState(context,workspace,page,expected));}catch(Exception unavailable){evidence.put("nativeUnavailable",true);}try{evidence.put("failureCredentials",privateCredentialState(context));}catch(Exception unavailable){evidence.put("credentialsUnavailable",true);} throw problem; }
            }
        }catch(Throwable problem){failure=problem;evidence.put("failureClass",problem.getClass().getSimpleName());}
        finally{gate.close();System.clearProperty("dev.fountain.outbox.qa");input.remove("password");input.remove("email");evidence.put("forwardedHTTPS",gate.forwarded.get()).put("blockedHTTPS",gate.blocked.get()).put("sessionDELETEConnections",gate.sessionDeleteConnections()).put("privateQAOptInCleared",System.getProperty("dev.fountain.outbox.qa")==null).put("passed",failure==null);
            File output=new File(context.getFilesDir(),"fountain-cloud-outbox-result.json");try(OutputStream out=new FileOutputStream(Os.open(output.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_TRUNC|OsConstants.O_NOFOLLOW,0600))){Os.chmod(output.getPath(),0600);out.write(evidence.toString().getBytes(StandardCharsets.UTF_8));}}
        if(failure!=null)throw new AssertionError("Actual native durability phase did not complete",failure);
    }
    @Test public void readOnlyPendingJournalScopeDiagnostics()throws Exception{
        Context context=instrumentation.getTargetContext();JSONObject input=consume(context);diagnosticPage=input.getString("pageId");
        Gate gate=new Gate(input.getString("nonce"),true);input.remove("password");input.remove("email");input.remove("nonce");
        JSONObject result=new JSONObject().put("diagnosticOnly",true).put("pid",android.os.Process.myPid()).put("noHTTPS",true);
        assertTrue(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));assertNull(System.getProperty("dev.fountain.outbox.qa"));System.setProperty("dev.fountain.outbox.qa","1");
        try{
            JSONObject shape=nativeState(context,input.getString("workspaceId"),diagnosticPage,input.getString("expectedText"));result.put("native",shape);
            String privateBindingHash;
            try(SQLiteDatabase db=SQLiteDatabase.openDatabase(database(context).getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS);
                Cursor cursor=db.rawQuery("SELECT value FROM control WHERE key='grant'",null)){
                assertTrue(cursor.moveToFirst());JSONObject session=new JSONObject(cursor.getString(0)).getJSONObject("session");
                privateBindingHash=OutboxPolicy.hash(session.getString("cache_binding"));
            }
            gate.install();
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
                scenario.onActivity(value->activity=value);until("globalThis.FountainTransport&&globalThis.Capacitor?.nativePromise","Bundled diagnostic view appeared",30000);
                result.put("journals",promise("""
                    const names=['fountain-offline-v1','fountain-upload-metadata-v1'],existing=await indexedDB.databases(),databases=[];
                    const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
                    for(const name of names){if(!existing.some(item=>item.name===name)){databases.push({name,present:false});continue;}const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onupgradeneeded=()=>r.transaction.abort();r.onerror=()=>reject(new Error('QA_IDB_OPEN'));r.onsuccess=()=>resolve(r.result);});
                    try{if(!db.objectStoreNames.contains('nativeJournal')){databases.push({name,present:true,journalPresent:false});continue;}
                    const rows=await new Promise((resolve,reject)=>{const tx=db.transaction(['nativeJournal'],'readonly'),store=tx.objectStore('nativeJournal'),r=store.getAll(null,100),c=store.count();tx.oncomplete=()=>resolve({values:r.result,total:c.result});tx.onabort=()=>reject(new Error('QA_IDB_READ'));});
                    const counts={checkpoint:0,quarantined:0,quarantine:0,reconcile:0,other:0,currentProfile:0,otherProfile:0,missingProfile:0,originMatches:0,headAhead:0};
                    for(const row of rows.values){counts[['checkpoint','quarantined','quarantine','reconcile'].includes(row.kind)?row.kind:'other']++;if(typeof row.profileId==='string'){counts[(await hash(row.profileId))===PROFILE_HASH?'currentProfile':'otherProfile']++;}else counts.missingProfile++;if(row.origin===ORIGIN)counts.originMatches++;if(Number.isSafeInteger(row.head)&&row.head>NATIVE_HEAD)counts.headAhead++;}
                    databases.push({name,present:true,journalPresent:true,total:rows.total,capped:rows.total>rows.values.length,counts});}finally{db.close();}}
                    const raw=localStorage.getItem('fountain-logout-pending:'+encodeURIComponent(ORIGIN));
                    const logoutMarker={markerPresent:raw!==null,exactAllowedKeys:false,hasNonemptyBinding:false,bindingSHAEqualsCurrentPrivateGrantBinding:false};
                    if(raw!==null)try{const marker=JSON.parse(raw);if(marker&&typeof marker==='object'&&!Array.isArray(marker)){
                      const keys=Object.keys(marker);logoutMarker.exactAllowedKeys=keys.length===3&&['mode','binding','nonce'].every(key=>Object.hasOwn(marker,key));
                      logoutMarker.hasNonemptyBinding=typeof marker.binding==='string'&&marker.binding.length>0;
                      if(logoutMarker.hasNonemptyBinding)logoutMarker.bindingSHAEqualsCurrentPrivateGrantBinding=(await hash(marker.binding))===PRIVATE_BINDING_HASH;
                    }}catch{/* Report only malformed shape; never return original bytes. */}
                    return {databases,logoutMarker};
                    """.replace("PROFILE_HASH",JSONObject.quote(shape.getString("profileSHA256"))).replace("PRIVATE_BINDING_HASH",JSONObject.quote(privateBindingHash)).replace("NATIVE_HEAD",Long.toString(shape.getLong("head"))).replace("ORIGIN",JSONObject.quote(ORIGIN))));
            }
            assertEquals("Diagnostic performs no remote request",0,gate.forwarded.get());result.put("passed",true);
        }finally{gate.close();System.clearProperty("dev.fountain.outbox.qa");result.put("forwardedHTTPS",gate.forwarded.get());File output=new File(context.getFilesDir(),"fountain-cloud-outbox-journal-diagnostic.json");try(OutputStream out=new FileOutputStream(Os.open(output.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_TRUNC|OsConstants.O_NOFOLLOW,0600))){Os.chmod(output.getPath(),0600);out.write(result.toString().getBytes(StandardCharsets.UTF_8));}}
    }
    @Test public void readOnlyLogoutFenceDiagnostics()throws Exception{
        Context context=instrumentation.getTargetContext();JSONObject input=consume(context),result=new JSONObject().put("diagnosticOnly",true).put("logoutPassed",false).put("noActivityLaunched",true).put("noHTTPS",true);
        try{
            String workspace=input.getString("workspaceId"),page=input.getString("pageId");result.put("native",nativeState(context,workspace,page,input.getString("expectedText"))).put("credentials",privateCredentialState(context));
            try(SQLiteDatabase db=SQLiteDatabase.openDatabase(database(context).getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
                JSONObject grant;long head;try(Cursor c=db.rawQuery("SELECT value FROM control WHERE key='grant'",null)){assertTrue(c.moveToFirst());grant=new JSONObject(c.getString(0));}String profile=grant.getString("profileId");
                assertTrue("Exact native current test actor",input.getString("email").equalsIgnoreCase(grant.getJSONObject("session").getJSONObject("member").optString("email")));try(Cursor c=db.rawQuery("SELECT value FROM control WHERE key='head'",null)){assertTrue(c.moveToFirst());head=Long.parseLong(c.getString(0));}
                try(Cursor c=db.rawQuery("SELECT count(*) FROM control WHERE key=?",new String[]{"suspended:"+profile})){assertTrue(c.moveToFirst());result.put("permanentBindingMarker",c.getLong(0)>0);}
                try(Cursor c=db.rawQuery("SELECT count(*) FROM tx_receipts r JOIN control o ON o.key='receipt-owner:'||r.tx_id WHERE o.value=? AND r.head=?",new String[]{profile,Long.toString(head)})){assertTrue(c.moveToFirst());result.put("ownedAcceptedReceiptsAtCurrentHead",c.getLong(0));}
                try(Cursor c=db.rawQuery("SELECT count(*) FROM staging s JOIN control o ON o.key='staging-owner:'||s.tx_id WHERE o.value=?",new String[]{profile})){assertTrue(c.moveToFirst());result.put("ownUncertainStagedParts",c.getLong(0));}
                try(Cursor c=db.rawQuery("SELECT count(*) FROM control WHERE key=?",new String[]{"cache-expired:"+profile})){assertTrue(c.moveToFirst());result.put("cacheExpiryMarker",c.getLong(0)>0);}
            }
            result.put("diagnosticCompleted",true);
        }finally{
            input.remove("password");input.remove("email");input.remove("nonce");File output=new File(context.getFilesDir(),"fountain-cloud-outbox-probe.json");try(OutputStream out=new FileOutputStream(Os.open(output.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_TRUNC|OsConstants.O_NOFOLLOW,0600))){Os.chmod(output.getPath(),0600);out.write(result.toString().getBytes(StandardCharsets.UTF_8));}
        }
    }

    private String rawSessionBoundaryFingerprint(Context context)throws Exception{
        Object plugin=activity.getBridge().getPlugin("FountainNative").getInstance();java.lang.reflect.Field field=FountainNativePlugin.class.getDeclaredField("lock");field.setAccessible(true);Object scopeLock=field.get(plugin);
        synchronized(scopeLock){
            JSONArray state=new JSONArray();
            for(String name:Arrays.asList("origin","activeCookie","revokeCookie","revokeOrigin","generation","authGeneration","recoveryEpoch","recoveryMode","broken")){
                field=FountainNativePlugin.class.getDeclaredField(name);field.setAccessible(true);state.put(new JSONArray().put(name).put(field.get(plugin)));
            }
            state.put(new CookieVault(context).read());
            try(SQLiteDatabase db=SQLiteDatabase.openDatabase(database(context).getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
                List<String> tables=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",null)){while(c.moveToNext()){String table=c.getString(0);assertTrue(table.matches("[a-z_][a-z_0-9]*"));tables.add(table);}}
                for(String table:tables){List<String> rows=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT * FROM "+table,null)){while(c.moveToNext()){JSONArray row=new JSONArray();for(int i=0;i<c.getColumnCount();i++)row.put(c.getType(i)==Cursor.FIELD_TYPE_BLOB?OutboxPolicy.hash(c.getBlob(i)):c.getString(i));rows.add(row.toString());assertTrue("Bounded private test snapshot",rows.size()<=100000);}}Collections.sort(rows);state.put(new JSONArray().put(table).put(new JSONArray(rows)));}
            }
            return OutboxPolicy.hash(state.toString());
        }
    }
    private int rawNativeOperationCount()throws Exception{
        Object plugin=activity.getBridge().getPlugin("FountainNative").getInstance();java.lang.reflect.Field field=FountainNativePlugin.class.getDeclaredField("lock");field.setAccessible(true);Object scopeLock=field.get(plugin);
        synchronized(scopeLock){field=FountainNativePlugin.class.getDeclaredField("operations");field.setAccessible(true);return ((Map<?,?>)field.get(plugin)).size();}
    }
    @Test public void actualRawSessionBindingPreventsOldLogoutFromRevokingNewLogin()throws Exception{
        Context context=instrumentation.getTargetContext();JSONObject input=consume(context),evidence=new JSONObject().put("passed",false).put("actualPrivateHTTPS",true).put("directProductionEndpoint",false).put("uiLifecycleClaim",false).put("pid",android.os.Process.myPid());
        Gate gate=new Gate(input.getString("nonce"),true);gate.sessionOnly.set(true);input.remove("nonce");Throwable failure=null;
        assertTrue(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));assertNull(System.getProperty("dev.fountain.outbox.qa"));System.setProperty("dev.fountain.outbox.qa","1");
        try{
            gate.install();
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
                scenario.onActivity(value->activity=value);until("globalThis.Capacitor?.nativePromise&&globalThis.FountainTransport","Installed private native bridge appeared",30000);
                evidence.put("businessUiPaused",Boolean.parseBoolean(evaluate("(()=>{if(typeof state==='object'){state.nativeRecoveryPaused=true;return true;}return false;})()")));
                long deadline=SystemClock.elapsedRealtime()+10000;int quiet=0;while(quiet<5&&SystemClock.elapsedRealtime()<deadline){quiet=rawNativeOperationCount()==0?quiet+1:0;Thread.sleep(100);}assertEquals("Initial offline calls settled before real raw session requests",5,quiet);
                JSONObject setup=promise("""
                    const configuration=await Capacitor.nativePromise('FountainNative','getConfiguration',{});
                    globalThis.__rawSessionBindingQA={generation:configuration.generation,sequence:0};const q=__rawSessionBindingQA;
                    q.request=async(method,payload)=>{const bytes=payload===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(payload));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
                      try{const result=await Capacitor.nativePromise('FountainNative','request',{generation:q.generation,id:'raw-session-'+(++q.sequence),path:'/api/session',method,headers:{'Content-Type':'application/json'},bodyBase64:btoa(binary),timeoutMs:45000});
                        return {status:result.status,body:JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.bodyBase64),c=>c.charCodeAt(0))))};
                      }catch(error){return {status:null,code:error?.code||'unknown'};}};
                    return {originMatches:configuration.origin===EXPECTED_ORIGIN};
                    """.replace("EXPECTED_ORIGIN",JSONObject.quote(ORIGIN)));
                assertTrue("Existing configured origin remains fixed",setup.getBoolean("originMatches"));gate.offline.set(false);
                String credentials=new JSONObject().put("email",input.getString("email")).put("password",input.getString("password")).toString();
                JSONObject first=promise("const q=__rawSessionBindingQA,p=await q.request('POST',"+credentials+"),s=await q.request('GET');q.a=s.body?.cache_binding;return {login:p.status===200,observed:s.status===200&&s.body?.authenticated===true&&typeof q.a==='string'&&q.a.length>0,workspace:s.body?.workspace_id==="+JSONObject.quote(input.getString("workspaceId"))+"};");evidence.put("first",first);assertTrue(first.getBoolean("login")&&first.getBoolean("observed")&&first.getBoolean("workspace"));
                JSONObject second=promise("const q=__rawSessionBindingQA,p=await q.request('POST',"+credentials+"),s=await q.request('GET');q.b=s.body?.cache_binding;q.member=s.body?.member?.id;return {login:p.status===200,observed:s.status===200&&s.body?.authenticated===true&&typeof q.b==='string'&&q.b.length>0,newBinding:q.b!==q.a,workspace:s.body?.workspace_id==="+JSONObject.quote(input.getString("workspaceId"))+"};");credentials=null;input.remove("email");input.remove("password");evidence.put("second",second);assertTrue(second.getBoolean("login")&&second.getBoolean("observed")&&second.getBoolean("newBinding")&&second.getBoolean("workspace"));
                String before=rawSessionBoundaryFingerprint(context);int deletes=gate.sessionDeleteConnections();
                JSONObject attempt=promise("const q=__rawSessionBindingQA,r=await q.request('DELETE',{cache_binding:q.a});return {nativeRejected:r.status===null,conflict:r.code==='NATIVE_SESSION_CONFLICT',httpReply:r.status!==null};");
                boolean unchanged=before.equals(rawSessionBoundaryFingerprint(context));int extraDeletes=gate.sessionDeleteConnections()-deletes;
                JSONObject current=promise("const q=__rawSessionBindingQA,s=await q.request('GET');return {authenticated:s.status===200&&s.body?.authenticated===true,sameBinding:s.body?.cache_binding===q.b,sameMember:s.body?.member?.id===q.member};");
                evidence.put("staleAttempt",attempt).put("staleDeleteConnections",extraDeletes).put("privateCookieAuthVaultLedgerSourceUnchanged",unchanged).put("currentAfterStale",current);
                assertTrue("Stale public binding must be rejected by actual native admission",attempt.getBoolean("nativeRejected")&&attempt.getBoolean("conflict"));assertEquals("Rejected stale binding must start zero DELETE connections",0,extraDeletes);assertTrue("Actual private auth/vault/SQLite state remains exact",unchanged);assertTrue("Actual current server session remains authenticated and identical",current.getBoolean("authenticated")&&current.getBoolean("sameBinding")&&current.getBoolean("sameMember"));
                deletes=gate.sessionDeleteConnections();JSONObject matching=promise("const q=__rawSessionBindingQA,r=await q.request('DELETE',{cache_binding:q.b}),s=await q.request('GET');return {deleted:r.status===200,anonymous:s.status===200&&s.body?.authenticated===false};");
                evidence.put("matching",matching).put("matchingDeleteConnections",gate.sessionDeleteConnections()-deletes);assertTrue(matching.getBoolean("deleted")&&matching.getBoolean("anonymous"));assertEquals("Public matching DELETE carries its selected cookie and original binding exactly once",1,gate.sessionDeleteConnections()-deletes);
                evaluate("delete globalThis.__rawSessionBindingQA;true");
            }
        }catch(Throwable problem){failure=problem;evidence.put("failureClass",problem.getClass().getSimpleName());}
        finally{gate.close();System.clearProperty("dev.fountain.outbox.qa");input.remove("password");input.remove("email");evidence.put("passed",failure==null).put("forwardedHTTPS",gate.forwarded.get()).put("blockedHTTPS",gate.blocked.get()).put("sessionDELETEConnections",gate.sessionDeleteConnections()).put("privateQAOptInCleared",System.getProperty("dev.fountain.outbox.qa")==null);File output=new File(context.getFilesDir(),"fountain-cloud-session-binding-result.json");try(OutputStream out=new FileOutputStream(Os.open(output.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_TRUNC|OsConstants.O_NOFOLLOW,0600))){Os.chmod(output.getPath(),0600);out.write(evidence.toString().getBytes(StandardCharsets.UTF_8));}}
        if(failure!=null)throw new AssertionError("Raw private session binding admission did not complete",failure);
    }

}
