package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual SDK UI queue + installed Capacitor JS protocol; no Auth/HTTP claim. */
@RunWith(AndroidJUnit4.class)
public class NativeBridgeReplyDeviceTest {
    private static PluginCall call(String callback){return new PluginCall(null,"FountainNative",callback,"outboxOpen",new JSObject());}
    @Test public void exactInstalledProtocolRejectsPersistentOrDanglingCallbacks()throws Exception{
        JSObject value=new JSObject();value.put("generation",2);value.put("text","quoted \\\" \\ separator \u2028 한국어");JSONObject envelope=NativeBridgeReply.envelope(call("7"),value);
        Set<String> keys=new HashSet<>();Iterator<String> names=envelope.keys();while(names.hasNext())keys.add(names.next());assertEquals(new HashSet<>(Arrays.asList("save","callbackId","pluginId","methodName","success","data")),keys);assertFalse(envelope.getBoolean("save"));assertTrue(envelope.getBoolean("success"));assertEquals("7",envelope.getString("callbackId"));assertEquals(value.toString(),envelope.getJSONObject("data").toString());
        PluginCall persistent=call("8");persistent.setKeepAlive(true);try{NativeBridgeReply.envelope(persistent,value);fail("Unsupported persistent callback accepted");}catch(IllegalArgumentException expected){}
        try{NativeBridgeReply.envelope(call(PluginCall.CALLBACK_ID_DANGLING),value);fail("Dangling result leaked through restoration");}catch(IllegalArgumentException expected){}
    }
    @Test public void queuedOldScopeIsCheckedAtActualDeliveryAndNoSecondUiPostOccurs()throws Exception{
        AtomicBoolean current=new AtomicBoolean(true);AtomicInteger evaluations=new AtomicInteger(),released=new AtomicInteger();AtomicReference<Throwable> error=new AtomicReference<>();CountDownLatch done=new CountDownLatch(1);
        NativeBridgeReply.Destination target=new NativeBridgeReply.Destination(){public void evaluate(String script){assertEquals(Looper.getMainLooper(),Looper.myLooper());evaluations.incrementAndGet();}public void release(){released.incrementAndGet();}};
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            new Handler(Looper.getMainLooper()).post(()->{try{assertFalse(NativeBridgeReply.deliver(call("old"),new JSObject(),current::get,target));assertEquals(0,evaluations.get());assertEquals(0,released.get());current.set(true);assertTrue(NativeBridgeReply.deliver(call("current"),new JSObject(),current::get,target));assertEquals("Actual destination invoked in this UI turn",1,evaluations.get());assertEquals(1,released.get());}catch(Throwable problem){error.set(problem);}finally{done.countDown();}});
            current.set(false);
        });
        assertTrue(done.await(10,TimeUnit.SECONDS));if(error.get()!=null)throw new AssertionError("Final UI reply fence",error.get());
    }
    private static String evaluate(WebView view,String script)throws Exception{
        CountDownLatch ready=new CountDownLatch(1);AtomicReference<String> result=new AtomicReference<>();InstrumentationRegistry.getInstrumentation().runOnMainSync(()->view.evaluateJavascript(script,value->{result.set(value);ready.countDown();}));assertTrue(ready.await(10,TimeUnit.SECONDS));return result.get();
    }
    @Test public void installedCapacitorNativePromiseReceivesDirectEnvelopeAndDeletesCallback()throws Exception{
        AtomicReference<WebView> ref=new AtomicReference<>();CountDownLatch loaded=new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{WebView view=new WebView(InstrumentationRegistry.getInstrumentation().getTargetContext());view.getSettings().setJavaScriptEnabled(true);view.setWebViewClient(new WebViewClient(){public void onPageFinished(WebView v,String url){loaded.countDown();}});ref.set(view);view.loadDataWithBaseURL("https://bridge-reply-"+UUID.randomUUID()+".invalid","<!doctype html><meta charset=utf-8>","text/html","UTF-8",null);});
        WebView view=ref.get();try{
            assertTrue(loaded.await(15,TimeUnit.SECONDS));String nativeBridge;
            try(InputStream in=InstrumentationRegistry.getInstrumentation().getTargetContext().getAssets().open("native-bridge.js");ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] part=new byte[65536];int n;while((n=in.read(part))!=-1)out.write(part,0,n);nativeBridge=new String(out.toByteArray(),StandardCharsets.UTF_8);}
            evaluate(view,"window.androidBridge={postMessage:function(data){window.__actualCall=JSON.parse(data);}};true");evaluate(view,nativeBridge);evaluate(view,"window.__received=null;window.__receivedCount=0;Capacitor.nativePromise('FountainNative','outboxOpen',{}).then(value=>{window.__received=value;window.__receivedCount++;});true");
            JSONObject actual=new JSONObject((String)new JSONTokener(evaluate(view,"JSON.stringify(__actualCall)")).nextValue());PluginCall call=call(actual.getString("callbackId"));JSObject value=new JSObject();value.put("generation",2);value.put("text","한국어 \" quoted \u2028");AtomicReference<Throwable> error=new AtomicReference<>();AtomicInteger releases=new AtomicInteger();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{try{assertTrue(NativeBridgeReply.deliver(call,value,()->true,new NativeBridgeReply.Destination(){public void evaluate(String script){view.evaluateJavascript(script,null);}public void release(){releases.incrementAndGet();}}));}catch(Throwable problem){error.set(problem);}});if(error.get()!=null)throw new AssertionError(error.get());
            long end=android.os.SystemClock.elapsedRealtime()+10000;while(!"1".equals(evaluate(view,"__receivedCount"))&&android.os.SystemClock.elapsedRealtime()<end)Thread.sleep(50);assertEquals("1",evaluate(view,"__receivedCount"));JSONObject received=new JSONObject((String)new JSONTokener(evaluate(view,"JSON.stringify(__received)")).nextValue());assertEquals(value.toString(),received.toString());assertEquals(1,releases.get());
            evaluate(view,"Capacitor.fromNative("+NativeBridgeReply.envelope(call,value)+");true");assertEquals("Promise callback removed by save:false", "1",evaluate(view,"__receivedCount"));
        }finally{InstrumentationRegistry.getInstrumentation().runOnMainSync(view::destroy);}
    }
    @Test public void sameCookieRoleChangeFencesPostGrantSessionDtoBeforeDirectDelivery()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            String observedOwnerLease=f.open().getString("lease");JSONObject guest=new JSONObject(f.outbox.get("grant")).getJSONObject("session");guest.getJSONObject("member").put("role","guest");f.outbox.grant(guest,null);String actualGuestLease=f.open().getString("lease");assertNotEquals(observedOwnerLease,actualGuestLease);
            AtomicInteger delivered=new AtomicInteger(),released=new AtomicInteger();AtomicReference<Throwable> error=new AtomicReference<>();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{try{NativeBridgeReply.Destination target=new NativeBridgeReply.Destination(){public void evaluate(String script){delivered.incrementAndGet();}public void release(){released.incrementAndGet();}};
                assertFalse(NativeBridgeReply.deliver(call("old-session"),new JSObject(),()->f.outbox.currentLease(observedOwnerLease),target));assertEquals(0,delivered.get());assertEquals(0,released.get());assertTrue(NativeBridgeReply.deliver(call("current-session"),new JSObject(),()->f.outbox.currentLease(actualGuestLease),target));assertEquals(1,delivered.get());assertEquals(1,released.get());
            }catch(Throwable problem){error.set(problem);}});if(error.get()!=null)throw new AssertionError("Actual private lease role boundary",error.get());
        }
    }

}
