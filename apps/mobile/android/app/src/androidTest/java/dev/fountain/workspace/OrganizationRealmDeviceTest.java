package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.*;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.ExecutorService;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real AndroidKeyStore tests of production realm persistence; no remote Auth/HTTP claim. */
@RunWith(AndroidJUnit4.class)
public class OrganizationRealmDeviceTest {
    static final String TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
    static final String BINDING = "0123456789abcdef0123456789abcdef";
    static Object get(Object object, String name) throws Exception { Field field=FountainNativePlugin.class.getDeclaredField(name);field.setAccessible(true);return field.get(object); }
    static void set(Object object,String name,Object value)throws Exception { Field field=FountainNativePlugin.class.getDeclaredField(name);field.setAccessible(true);field.set(object,value); }
    static Object invoke(Object object,String name,Class<?>[] types,Object... values)throws Exception {
        Method method=FountainNativePlugin.class.getDeclaredMethod(name,types);method.setAccessible(true);
        try{return method.invoke(object,values);}catch(InvocationTargetException failure){throw new Exception(failure.getCause());}
    }
    static class Fixture implements AutoCloseable {
        final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String suffix=UUID.randomUUID().toString().replace("-", ""), origin="https://organization-test-"+suffix+".invalid";
        final String orgName="fountain_org_test_"+suffix, workspaceName="fountain_ws_test_"+suffix;
        final String orgAlias="dev.fountain.test.organization."+suffix, workspaceAlias="dev.fountain.test.workspace."+suffix;
        final SharedPreferences organization=context.getSharedPreferences(orgName,Context.MODE_PRIVATE),workspace=context.getSharedPreferences(workspaceName,Context.MODE_PRIVATE);
        final CookieVault orgVault=new CookieVault(context,orgName,orgAlias),workspaceVault=new CookieVault(context,workspaceName,workspaceAlias);
        final FountainNativePlugin plugin=new FountainNativePlugin();
        Fixture()throws Exception {
            NativeCookieBoundary.install();
            set(plugin,"ownerBoundaryEpoch",NativeCookieBoundary.epoch());set(plugin,"origin",origin);set(plugin,"generation",3L);
            set(plugin,"organizationOrigin",origin);set(plugin,"organizationGeneration",3L);set(plugin,"organizationVault",orgVault);
            set(plugin,"organizationActive",TOKEN);set(plugin,"organizationActiveBinding",BINDING);
            set(plugin,"vault",workspaceVault);set(plugin,"activeCookie","workspace-independent");set(plugin,"authGeneration",17L);
            workspaceVault.write(new JSONObject().put("origin",origin).put("generation",3).put("active","workspace-independent").put("revoke",JSONObject.NULL).put("revoke_origin",JSONObject.NULL));
            invoke(plugin,"persistOrganization",new Class<?>[0]);
        }
        public void close()throws Exception {
            for(String name:Arrays.asList("workers","sessions","deadlines","organizationWorkers"))((ExecutorService)get(plugin,name)).shutdownNow();
            assertTrue(organization.edit().clear().commit());assertTrue(workspace.edit().clear().commit());
            KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(orgAlias);keys.deleteEntry(workspaceAlias);
        }
    }
    @Test public void actualAndroidCookieParserEnforcesRealmAndTypedRoutes()throws Exception {
        String origin="https://organization-policy.invalid", prefix=NativeOrganizationPolicy.COOKIE+"=", suffix="; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800";
        assertEquals(TOKEN,NativeOrganizationPolicy.cookie(Collections.singletonMap("Set-Cookie",Collections.singletonList(prefix+TOKEN+suffix)),origin));
        assertEquals("",NativeOrganizationPolicy.cookie(Collections.singletonMap("Set-Cookie",Collections.singletonList(prefix+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0")),origin));
        for(String line:Arrays.asList(prefix+TOKEN+suffix.replace("; Secure", ""),prefix+TOKEN+suffix.replace("Strict","Lax"),"fountain_session="+TOKEN+suffix,prefix+TOKEN+suffix+"; Domain=elsewhere.invalid")) {
            try {NativeOrganizationPolicy.cookie(Collections.singletonMap("Set-Cookie",Collections.singletonList(line)),origin);fail("Android accepted unsafe realm cookie");}catch(IllegalArgumentException expected){}
        }
        assertTrue(NativeOrganizationPolicy.namespace("/api/%256frganization/session"));assertFalse(NativeOrganizationPolicy.namespace("/api/session"));
        assertEquals("/api/organization/organizations?session_binding="+BINDING,NativeOrganizationPolicy.path("/api/organization/organizations?session_binding="+BINDING,"GET"));
        try {NativeOrganizationPolicy.path("/api/organization/organizations?session_binding="+BINDING+"&session_binding="+BINDING,"GET");fail("Duplicate query accepted");}catch(IllegalArgumentException expected){}
    }
    @Test public void quarantineKeepsOnlyOrganizationRetryAndWorkspaceSealedRecordUnchanged()throws Exception {
        try(Fixture f=new Fixture()) {
            String workspaceBefore=f.workspace.getString("sealed",null);
            invoke(f.plugin,"quarantineOrganization",new Class<?>[0]);
            assertNull(get(f.plugin,"organizationActive"));assertEquals(TOKEN,get(f.plugin,"organizationRevoke"));
            assertEquals("workspace-independent",get(f.plugin,"activeCookie"));assertEquals(17L,get(f.plugin,"authGeneration"));
            assertEquals(workspaceBefore,f.workspace.getString("sealed",null));
            JSONObject restarted=new CookieVault(f.context,f.orgName,f.orgAlias).read();
            assertTrue(restarted.isNull("active"));assertTrue(restarted.isNull("active_binding"));
            assertEquals(TOKEN,restarted.getString("revoke"));assertEquals(BINDING,restarted.getString("revoke_binding"));
            assertEquals(f.origin,restarted.getString("revoke_origin"));
            assertEquals("workspace-independent",new CookieVault(f.context,f.workspaceName,f.workspaceAlias).read().getString("active"));
        }
    }
    @Test public void encryptedOrganizationStateCannotBeOpenedWithWorkspaceKey()throws Exception {
        try(Fixture f=new Fixture()) {
            String workspaceBefore=f.workspace.getString("sealed",null);
            assertTrue(f.workspace.edit().putString("sealed",f.organization.getString("sealed",null)).commit());
            try {new CookieVault(f.context,f.workspaceName,f.workspaceAlias).read();fail("Organization ciphertext opened in workspace realm");} catch(java.security.GeneralSecurityException expected) {}
            assertTrue(f.workspace.edit().putString("sealed",workspaceBefore).commit());
            assertEquals("workspace-independent",f.workspaceVault.read().getString("active"));
        }
    }
    @Test public void organization401QuarantinesOnlyItsRealmAndWorkspace403KeepsOrganization()throws Exception {
        try(Fixture f=new Fixture()) {
            String workspaceBefore=f.workspace.getString("sealed",null), organizationBefore=f.organization.getString("sealed",null);
            Class<?> responseType=Class.forName("dev.fountain.workspace.FountainNativePlugin$Response");
            Constructor<?> responseConstructor=responseType.getDeclaredConstructor();responseConstructor.setAccessible(true);Object response=responseConstructor.newInstance();
            Field status=responseType.getDeclaredField("status");status.setAccessible(true);status.set(response,403);
            Class<?> operationType=Class.forName("dev.fountain.workspace.FountainNativePlugin$OrganizationOperation");
            Constructor<?> operationConstructor=operationType.getDeclaredConstructor(String.class,String.class,long.class,long.class,com.getcapacitor.PluginCall.class,boolean.class,boolean.class);operationConstructor.setAccessible(true);
            Object operation=operationConstructor.newInstance("owned-test",f.origin,3L,0L,null,false,false);
            invoke(f.plugin,"applyOrganizationResponse",new Class<?>[]{operationType,responseType,boolean.class,String.class},operation,response,false,TOKEN);
            assertEquals("A workspace authorization 403 does not clear organization",organizationBefore,f.organization.getString("sealed",null));
            assertEquals(TOKEN,get(f.plugin,"organizationActive"));assertEquals(0L,get(f.plugin,"organizationEpoch"));
            status.set(response,401);
            invoke(f.plugin,"applyOrganizationResponse",new Class<?>[]{operationType,responseType,boolean.class,String.class},operation,response,false,TOKEN);
            assertNull(get(f.plugin,"organizationActive"));assertEquals(TOKEN,get(f.plugin,"organizationRevoke"));assertEquals(1L,get(f.plugin,"organizationEpoch"));
            assertEquals(17L,get(f.plugin,"authGeneration"));assertEquals("workspace-independent",get(f.plugin,"activeCookie"));assertEquals(workspaceBefore,f.workspace.getString("sealed",null));
            assertEquals(BINDING,new CookieVault(f.context,f.orgName,f.orgAlias).read().getString("revoke_binding"));
        }
    }
    @Test public void anonymousSessionBodyQuarantinesOrganizationWithoutClearCookieHeader()throws Exception {
        try(Fixture f=new Fixture()) {
            String workspaceBefore=f.workspace.getString("sealed",null);
            Class<?> responseType=Class.forName("dev.fountain.workspace.FountainNativePlugin$Response");
            Constructor<?> responseConstructor=responseType.getDeclaredConstructor();responseConstructor.setAccessible(true);Object response=responseConstructor.newInstance();
            Field status=responseType.getDeclaredField("status");status.setAccessible(true);status.set(response,200);
            Field body=responseType.getDeclaredField("body");body.setAccessible(true);body.set(response,new JSONObject().put("mode","organization").put("authenticated",false).put("cache_binding",JSONObject.NULL).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            Class<?> operationType=Class.forName("dev.fountain.workspace.FountainNativePlugin$OrganizationOperation");
            Constructor<?> operationConstructor=operationType.getDeclaredConstructor(String.class,String.class,long.class,long.class,com.getcapacitor.PluginCall.class,boolean.class,boolean.class);operationConstructor.setAccessible(true);
            Object operation=operationConstructor.newInstance("owned-anonymous-test",f.origin,3L,0L,null,false,false);
            invoke(f.plugin,"applyOrganizationResponse",new Class<?>[]{operationType,responseType,boolean.class,String.class},operation,response,true,TOKEN);
            assertNull(get(f.plugin,"organizationActive"));assertEquals(TOKEN,get(f.plugin,"organizationRevoke"));assertEquals(BINDING,get(f.plugin,"organizationRevokeBinding"));
            assertEquals(1L,get(f.plugin,"organizationEpoch"));assertEquals(17L,get(f.plugin,"authGeneration"));assertEquals(workspaceBefore,f.workspace.getString("sealed",null));
        }
    }
    @Test public void organizationQuarantinePreservesActualWorkspaceOutboxGrantLeaseAndHead()throws Exception {
        try(Fixture f=new Fixture(); ReconcileDeviceTest.Fixture workspace=new ReconcileDeviceTest.Fixture()) {
            set(f.plugin,"outbox",workspace.outbox);
            String lease=workspace.outbox.get("lease"),grant=workspace.outbox.get("grant");long head=workspace.outbox.head(),records=workspace.count("records");
            invoke(f.plugin,"quarantineOrganization",new Class<?>[0]);
            assertSame(workspace.outbox,get(f.plugin,"outbox"));assertEquals(lease,workspace.outbox.get("lease"));assertEquals(grant,workspace.outbox.get("grant"));
            assertEquals(head,workspace.outbox.head());assertEquals(records,workspace.count("records"));
        }
    }
    @Test public void configurationChangeDropsForeignOrganizationCredentialsWithoutWorkspaceMutation()throws Exception {
        try(Fixture f=new Fixture()) {
            String workspaceBefore=f.workspace.getString("sealed",null);
            set(f.plugin,"origin","https://replacement-"+f.suffix+".invalid");set(f.plugin,"generation",4L);
            invoke(f.plugin,"organizationConfigurationChanged",new Class<?>[0]);
            assertNull(get(f.plugin,"organizationActive"));assertNull(get(f.plugin,"organizationRevoke"));
            JSONObject restarted=new CookieVault(f.context,f.orgName,f.orgAlias).read();assertEquals(4,restarted.getInt("generation"));
            assertEquals("https://replacement-"+f.suffix+".invalid",restarted.getString("origin"));assertTrue(restarted.isNull("active"));assertTrue(restarted.isNull("revoke"));
            assertEquals(workspaceBefore,f.workspace.getString("sealed",null));assertEquals(17L,get(f.plugin,"authGeneration"));
        }
    }
}
