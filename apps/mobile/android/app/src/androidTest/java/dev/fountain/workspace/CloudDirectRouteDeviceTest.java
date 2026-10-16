package dev.fountain.workspace;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.SharedPreferences;
import android.system.Os;
import android.system.OsConstants;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in QA only: production native HTTPS route, NOT bridge/login/edit proof.
 * No Activity/configuration/vault load, credential, POST, or domain write occurs.
 */
@RunWith(AndroidJUnit4.class)
public class CloudDirectRouteDeviceTest {
    private static final String ORIGIN="https://ehnovtfadpkwtubmwltl.supabase.co";
    private static final String INPUT="fountain-cloud-direct-input.json";
    private static final String OUTPUT="fountain-cloud-direct-result.json";

    private static JSONObject consumeInput(Context context)throws Exception {
        File input=new File(context.getFilesDir(),INPUT);
        Assume.assumeTrue("Explicit private direct-route QA input required",input.exists());
        try {
            int mode=Os.lstat(input.getPath()).st_mode;
            assertTrue("Regular private input required",OsConstants.S_ISREG(mode));
            assertEquals("Private input mode",0600,mode&0777);
            try(InputStream stream=new FileInputStream(Os.open(input.getPath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0))){
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] part=new byte[256];int count;
                while((count=stream.read(part))!=-1){assertTrue("Bounded opt-in input",bytes.size()+count<=1024);bytes.write(part,0,count);}
                JSONObject value=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
                assertEquals("Origin-only opt-in",1,value.length());
                assertTrue("Fixed known project only",value.opt("origin") instanceof String&&ORIGIN.equals(value.getString("origin")));
                return value;
            }
        } finally {assertTrue("Consume opt-in input immediately",input.delete());}
    }

    private static long cookieBoundary()throws Exception {
        long epoch=NativeCookieBoundary.epoch();
        if(!NativeCookieBoundary.permits(epoch)){
            // Do not re-enable a foreign cookie jar for any loaded app owner.
            // A fresh instrumentation process may establish the normal deny jar.
            Field field=NativeCookieBoundary.class.getDeclaredField("invalidators");field.setAccessible(true);
            synchronized(NativeCookieBoundary.class){
                Assume.assumeTrue("Idle disposable QA process required",((Set<?>)field.get(null)).isEmpty());
                NativeCookieBoundary.beginInitialization();NativeCookieBoundary.install();
            }
            epoch=NativeCookieBoundary.epoch();
        }
        assertTrue("Native cookie isolation",NativeCookieBoundary.permits(epoch));return epoch;
    }

    @Test public void anonymousSessionUsesDirectSupabaseNativeRoute()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        consumeInput(context); // No app launch or network before explicit input.
        SharedPreferences preferences=context.getSharedPreferences("fountain_native_v1",Context.MODE_PRIVATE);
        Map<String,?> prior=new HashMap<>(preferences.getAll()); // Ciphertext only, never decoded/logged.
        long boundary=cookieBoundary();
        FountainNativePlugin transport=new FountainNativePlugin(); // Deliberately never load() or bind a renderer.
        HttpsURLConnection connection=null;boolean passed=false;
        try {
            Method open=FountainNativePlugin.class.getDeclaredMethod("open",String.class,String.class,String.class,Map.class,byte[].class,String.class,int.class,long.class);open.setAccessible(true);
            connection=(HttpsURLConnection)open.invoke(transport,ORIGIN,"/api/session","GET",new HashMap<String,String>(),new byte[0],null,30000,boundary);
            assertTrue("Production native prefix",connection.getURL().toExternalForm().equals(ORIGIN+"/functions/v1/fountain-api/api/session"));
            assertFalse("No redirect following",connection.getInstanceFollowRedirects());
            assertNull("No caller cookie",connection.getRequestProperty("Cookie"));
            assertNull("No provider credential",connection.getRequestProperty("Authorization"));
            assertNull("No provider key",connection.getRequestProperty("apikey"));
            assertEquals("Direct native HTTPS response",200,connection.getResponseCode());
            Method safeHeaders=FountainNativePlugin.class.getDeclaredMethod("safeHeaders",Map.class);safeHeaders.setAccessible(true);
            JSONObject visible=(JSONObject)safeHeaders.invoke(null,connection.getHeaderFields());
            Iterator<String> names=visible.keys();while(names.hasNext()){
                String name=names.next().toLowerCase(Locale.ROOT);
                assertFalse("Cookie headers never reach renderer DTO",name.equals("cookie")||name.equals("set-cookie"));
                assertTrue("Only public response headers",NativePolicy.RESPONSE_HEADERS.contains(name));
            }
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            try(InputStream stream=connection.getInputStream()){
                byte[] part=new byte[4096];int count;while((count=stream.read(part))!=-1){assertTrue("Bounded anonymous response",bytes.size()+count<=65536);bytes.write(part,0,count);}
            }
            JSONObject body=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
            assertTrue("Anonymous only",Boolean.FALSE.equals(body.opt("authenticated")));
            assertTrue("Cloud account boundary",Boolean.TRUE.equals(body.opt("required"))&&Boolean.TRUE.equals(body.opt("enabled"))&&"accounts".equals(body.opt("mode")));
            for(String field:new String[]{"member","identity","workspace_id","cache_binding","expires_at"})assertTrue("Anonymous identity fields are null",body.has(field)&&body.isNull(field));
            assertTrue("Cookie boundary unchanged during I/O",NativeCookieBoundary.permits(boundary));
            passed=true;
        } finally {
            if(connection!=null)connection.disconnect();
            transport.handleOnDestroy();
            for(String name:new String[]{"workers","sessions","deadlines"}){
                Field field=FountainNativePlugin.class.getDeclaredField(name);field.setAccessible(true);
                assertTrue("QA transport executor stopped",((ExecutorService)field.get(transport)).awaitTermination(5,TimeUnit.SECONDS));
            }
            assertTrue("Existing private configuration unchanged",prior.equals(preferences.getAll()));
        }
        assertTrue(passed);
        JSONObject result=new JSONObject().put("actualNativeHTTPS",true).put("directSupabaseRoute",true).put("anonymous",true)
            .put("httpStatus",200).put("requests",1).put("postRequests",0).put("identityFieldsNull",true)
            .put("cookieHeadersExposed",false).put("privateConfigurationPreserved",true).put("bridgeLoginEditsVerified",false);
        File output=new File(context.getFilesDir(),OUTPUT);
        try(OutputStream stream=new FileOutputStream(Os.open(output.getPath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_TRUNC|OsConstants.O_NOFOLLOW,0600))){
            Os.chmod(output.getPath(),0600);stream.write(result.toString().getBytes(StandardCharsets.UTF_8));
        }
    }
}
