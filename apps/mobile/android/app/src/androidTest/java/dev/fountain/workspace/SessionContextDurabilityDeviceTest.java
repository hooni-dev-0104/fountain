package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real isolated SharedPreferences/AndroidKeyStore + injected faults. No cloud/UI claim. */
@RunWith(AndroidJUnit4.class)
public class SessionContextDurabilityDeviceTest {
    private static final String PUBLIC="public_logout_v1.";
    static final class Fixture implements AutoCloseable {
        final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String origin,alias="dev.fountain.test.logout."+UUID.randomUUID(),name="fountain_logout_test_"+UUID.randomUUID();
        final SharedPreferences real=context.getSharedPreferences(name,Context.MODE_PRIVATE),preferences;
        boolean failMarkerAdd,failMarkerRemove,failGenericMark,failSealedRemoval,failCryptoWrite,failCryptoRead,failKeyDelete,overlayOnlyMarker,api24NoChangeSuccess,corruptAfterPublicCommit,backupAfterPublicCommit,ownedBackup;
        int keyDeletes,markerCommits;final Map<String,Object> overlay=new java.util.LinkedHashMap<>();
        Fixture(String origin)throws Exception{
            this.origin=origin;
            preferences=(SharedPreferences)Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{SharedPreferences.class},(proxy,method,args)->{
                if(method.getName().equals("getAll")){Map<String,Object> merged=new java.util.LinkedHashMap<>(real.getAll());merged.putAll(overlay);return merged;}
                if(args!=null&&args.length>0&&args[0] instanceof String&&overlay.containsKey(args[0])){
                    if(method.getName().equals("contains"))return true;
                    if(method.getName().equals("getString")||method.getName().equals("getBoolean"))return overlay.get(args[0]);
                }
                if(!method.getName().equals("edit"))return invoke(method,real,args);
                SharedPreferences.Editor editor=real.edit();List<String> puts=new ArrayList<>(),removes=new ArrayList<>();Map<String,Object> changes=new java.util.LinkedHashMap<>();
                return Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{SharedPreferences.Editor.class},(edit,action,values)->{
                    if(action.getName().startsWith("put")&&values!=null){puts.add((String)values[0]);changes.put((String)values[0],values[1]);}
                    if(action.getName().equals("remove"))removes.add((String)values[0]);
                    boolean publicWrite=puts.stream().anyMatch(key->key.startsWith(PUBLIC));
                    if(action.getName().equals("commit")&&publicWrite){
                        markerCommits++;
                        if(overlayOnlyMarker){
                            Map<String,Object> visible=new java.util.LinkedHashMap<>(real.getAll());visible.putAll(overlay);boolean changed=changes.entrySet().stream().anyMatch(value->!java.util.Objects.equals(visible.get(value.getKey()),value.getValue()));
                            for(Map.Entry<String,Object> value:changes.entrySet())if(value.getKey().startsWith(PUBLIC))overlay.put(value.getKey(),value.getValue());
                            // Official AOSP Android7 writeToFile: existing file +
                            // no changed cache values reports true without I/O.
                            return api24NoChangeSuccess&&!changed;
                        }
                    }
                    if(action.getName().equals("commit")&&(
                        failMarkerAdd&&puts.stream().anyMatch(key->key.startsWith(PUBLIC)&&!key.endsWith(".present"))
                        ||failMarkerRemove&&removes.stream().anyMatch(key->key.startsWith(PUBLIC))
                        ||failGenericMark&&puts.stream().anyMatch(key->key.startsWith("invalidated."))
                        ||failSealedRemoval&&removes.contains("sealed")))return false;
                    byte[] oldXml=action.getName().equals("commit")&&publicWrite&&backupAfterPublicCommit?readOwnXml():null;
                    Object result=invoke(action,editor,values);if(action.getName().equals("commit")&&Boolean.TRUE.equals(result)){
                        for(String key:puts)overlay.remove(key);for(String key:removes)overlay.remove(key);
                        if(publicWrite&&corruptAfterPublicCommit)corruptOwnXml();
                        if(oldXml!=null)writeOwnBackup(oldXml);
                    }return result instanceof SharedPreferences.Editor?edit:result;
                });
            });
        }
        private static Object invoke(java.lang.reflect.Method method,Object target,Object[] values)throws Throwable{try{return method.invoke(target,values);}catch(InvocationTargetException failure){throw failure.getCause();}}
        java.io.File backing(){return new java.io.File(context.getDataDir(),"shared_prefs/"+name+".xml");}
        java.io.File backup(){return new java.io.File(backing().getPath()+".bak");}
        byte[] readOwnXml()throws Exception{return readOwnFile(backing());}
        byte[] readOwnFile(java.io.File file)throws Exception{
            assertTrue(file.getName().startsWith("fountain_logout_test_"));
            try(java.io.FileInputStream input=new java.io.FileInputStream(file);java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream()){
                byte[] part=new byte[4096];int n;while((n=input.read(part))!=-1){assertTrue(output.size()+n<=1024*1024);output.write(part,0,n);}return output.toByteArray();
            }
        }
        void writeOwnBackup(byte[] bytes)throws Exception{
            assertTrue(name.startsWith("fountain_logout_test_"));ownedBackup=true;
            try(java.io.FileOutputStream output=new java.io.FileOutputStream(backup())){output.write(bytes);output.getFD().sync();}
        }
        CookieVault.KeyFault keyAccess(){return new CookieVault.KeyFault(){
            public void beforeKey(boolean create)throws Exception{if(create&&failCryptoWrite||!create&&failCryptoRead)throw new GeneralSecurityException("Injected isolated key-access failure");}
            public void beforeDelete()throws Exception{keyDeletes++;if(failKeyDelete)throw new GeneralSecurityException("Injected isolated delete-key failure");}
            public java.io.File backingFile(){return backing();}
        };}
        CookieVault vault(){return new CookieVault(context,preferences,alias,keyAccess());}
        void corruptOwnXml()throws Exception{
            assertTrue(name.startsWith("fountain_logout_test_"));byte[] bytes;
            try(java.io.FileInputStream input=new java.io.FileInputStream(backing());java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream()){byte[] part=new byte[4096];int n;while((n=input.read(part))!=-1){assertTrue(output.size()+n<=1024*1024);output.write(part,0,n);}bytes=output.toByteArray();}
            String xml=new String(bytes,StandardCharsets.UTF_8),changed=xml.replace("binding-B","binding-corrupted");assertFalse("Synthetic owned XML mutation actually changed its field",xml.equals(changed));
            try(java.io.FileOutputStream output=new java.io.FileOutputStream(backing())){output.write(changed.getBytes(StandardCharsets.UTF_8));output.getFD().sync();}
        }
        JSONObject record(String active,String revoke)throws Exception{return new JSONObject().put("origin",origin).put("generation",1).put("active",active==null?JSONObject.NULL:active).put("revoke",revoke==null?JSONObject.NULL:revoke).put("revoke_origin",revoke==null?JSONObject.NULL:origin);}
        NativeSessionBinding.Admission admission(String token,String binding)throws Exception{
            NativeSessionBinding observed=new NativeSessionBinding();observed.observe(origin,token,origin,token,null,false,new JSONObject().put("authenticated",true).put("cache_binding",binding));
            return observed.admit(origin,token,new JSONObject().put("cache_binding",binding).toString().getBytes(StandardCharsets.UTF_8));
        }
        NativePolicy.SessionStorage storage(CookieVault vault){return new NativePolicy.SessionStorage(){
            public boolean markInvalidated(String server){return vault.markInvalidated(server);}
            public boolean saveRevokeOnly(String server,String token){try{vault.write(record(null,token));return true;}catch(Exception failure){return false;}}
            public boolean eraseEncryptedState(){return vault.eraseEncryptedState();}
            public boolean destroyEncryptionKey(){return vault.destroyEncryptionKey();}
        };}
        void complete(CookieVault vault,NativeSessionBinding.Admission admitted)throws Exception{
            vault.finishPublicContext(admitted,()->{vault.write(record(null,null));vault.clearInvalidated(origin);});
        }
        String contextKey(){for(String key:real.getAll().keySet())if(key.startsWith(PUBLIC)&&!key.endsWith(".present"))return key;throw new AssertionError("Private native context missing");}
        public void close()throws Exception{
            assertTrue(alias.startsWith("dev.fountain.test.logout."));KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);store.deleteEntry(alias);
            // Remove only this fixture's explicitly created object before SDK
            // cleanup can consume its own .bak restoration candidate.
            if(ownedBackup)try{android.system.Os.lstat(backup().getPath());assertTrue(backup().delete());}catch(android.system.ErrnoException absent){if(absent.errno!=android.system.OsConstants.ENOENT)throw absent;}
            assertTrue(real.edit().clear().commit());
        }
    }
    @Test public void bound409ClearFailureRestoresOnlyBoundRetryAcrossTwoFreshVaults()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record("cookie-B",null));NativeSessionBinding.Admission accepted=f.admission("cookie-B","binding-B");first.preparePublicLogout(accepted);
            NativePolicy.SessionInvalidation revoked=NativePolicy.invalidateSession(f.origin,"cookie-B",null,f.storage(first));assertTrue(revoked.saved);
            f.failCryptoWrite=true;
            try{NativeSessionBinding.finishPublicLogout(accepted,f.origin,null,"cookie-B",f.origin,409,()->f.complete(first,accepted));fail("Injected secure credential cleanup unexpectedly succeeded");}catch(GeneralSecurityException expected){}
            CookieVault second=f.vault();JSONObject saved=second.read();NativePolicy.SessionRead restored=NativePolicy.restoreSession(saved.isNull("active")?null:saved.getString("active"),saved.isNull("revoke")?null:saved.getString("revoke"),second.invalidated(f.origin));
            assertNull(restored.active);assertTrue("cookie-B".equals(restored.revoke));
            NativeSessionBinding.Admission retry=second.publicRetry(f.origin,restored.revoke);
            assertNotNull("Restart turned the public binding409 into legacy bodyless revocation",retry);
            assertTrue(new JSONObject(new String(retry.body,StandardCharsets.UTF_8)).getString("cache_binding").equals("binding-B"));assertTrue("cookie-B".equals(retry.cookie));
            f.failCryptoWrite=false;NativeSessionBinding.finishPublicLogout(retry,f.origin,null,restored.revoke,f.origin,409,()->f.complete(second,retry));
            CookieVault third=f.vault();assertTrue(third.read().isNull("active")&&third.read().isNull("revoke"));assertFalse(third.hasPublicContext(f.origin));
        }
    }
    @Test public void durableContextMasksOldActiveEvenWhenGenericJournalAndKeyWritesFail()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record("cookie-B",null));first.preparePublicLogout(f.admission("cookie-B","binding-B"));
            f.failGenericMark=true;f.failCryptoWrite=true;f.failSealedRemoval=true;f.failKeyDelete=true;
            NativePolicy.SessionInvalidation failed=NativePolicy.invalidateSession(f.origin,"cookie-B",null,f.storage(first));
            assertTrue("A durable native public context is itself a negative restart fence",failed.durable&&failed.journaled);assertFalse(failed.saved);
            assertFalse(f.real.getBoolean("invalidated."+f.origin,false));assertEquals("A valid independent context must preserve the old credential/key for bounded eventual revocation",0,f.keyDeletes);
            CookieVault second=f.vault();JSONObject saved=second.read();assertTrue("cookie-B".equals(saved.opt("active")));assertTrue(second.invalidated(f.origin));
            NativePolicy.SessionRead restored=NativePolicy.restoreSession(saved.getString("active"),null,second.invalidated(f.origin));assertNull(restored.active);assertTrue("cookie-B".equals(restored.revoke));assertNotNull(second.publicRetry(f.origin,restored.revoke));
            for(Map.Entry<String,?> entry:f.real.getAll().entrySet())if(entry.getKey().startsWith(PUBLIC)&&entry.getValue() instanceof String)assertFalse("Negative metadata contains no bearer cookie",((String)entry.getValue()).contains("cookie-B"));
        }
    }
    @Test public void failedContextPreflightCannotReachAuthCancelOutboxOrHttpEffects()throws Exception{
        try(ReconcileDeviceTest.Fixture nativeStore=new ReconcileDeviceTest.Fixture();Fixture f=new Fixture(nativeStore.origin)){
            CookieVault vault=f.vault();vault.write(f.record("cookie-B",null));String sealed=f.real.getString("sealed",null),lease=nativeStore.outbox.get("lease");long head=nativeStore.outbox.head();int effects=0;f.failMarkerAdd=true;
            try{vault.preparePublicLogout(f.admission("cookie-B","binding-B"));effects++;nativeStore.outbox.revoke();fail("Failed marker persistence was accepted");}catch(java.io.IOException expected){}
            assertEquals("No auth/cancel/outbox/HTTP effect may follow a failed preflight",0,effects);assertEquals(head,nativeStore.outbox.head());assertEquals(lease,nativeStore.outbox.get("lease"));assertTrue(sealed.equals(f.real.getString("sealed",null)));
        }
    }
    @Test public void missingMalformedAndMismatchedContextsNeverBecomeLegacyUnboundRetries()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault vault=f.vault();vault.write(f.record(null,"cookie-B"));vault.preparePublicLogout(f.admission("cookie-B","binding-B"));String key=f.contextKey(),raw=f.real.getString(key,null);
            try{vault.publicRetry(f.origin,"other-cookie");fail("An unmatched cookie borrowed the public context");}catch(NativeSessionBinding.Failure expected){}
            int variant=0;
            for(String malformed:new String[]{raw+" ",raw.substring(0,raw.length()-1)+",\"version\":1}",new JSONObject(raw).put("origin","https://other.invalid").toString(),"{}"}){
                boolean changed=!raw.equals(malformed);assertTrue("Malformed fixture index "+(variant++)+" changed="+changed,changed);
                assertTrue(f.real.edit().putString(key,malformed).commit());assertTrue(vault.invalidated(f.origin));
                try{vault.publicRetry(f.origin,"cookie-B");fail("Malformed context became bodyless");}catch(NativeSessionBinding.Failure expected){}
            }
            assertTrue(f.real.edit().remove(key).commit());assertTrue(vault.invalidated(f.origin));try{vault.publicRetry(f.origin,"cookie-B");fail("Missing context became legacy unbound");}catch(NativeSessionBinding.Failure expected){}
        }
    }
    @Test public void exactLocalSentinelIsNotAWildcardAndSurvivesFreshInstances()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record(null,null));first.preparePublicLogout(f.admission(null,"local-binding"));
            NativePolicy.SessionInvalidation pending=NativePolicy.invalidateSession(f.origin,null,null,f.storage(first));assertTrue(pending.saved);
            CookieVault second=f.vault();assertFalse("Nil credentials do not acknowledge a pending local logout",second.confirmedEmptyForLogin(f.origin));NativeSessionBinding.Admission retry=second.publicRetry(f.origin,null);
            assertNotNull(retry);assertNull(retry.cookie);assertTrue(new JSONObject(new String(retry.body,StandardCharsets.UTF_8)).getString("cache_binding").equals("local-binding"));
            try{second.publicRetry(f.origin,"nonlocal-cookie");fail("No-cookie sentinel matched an unrelated bearer");}catch(NativeSessionBinding.Failure expected){}
        }
    }
    @Test public void retirementFailureRetainsNegativeMetadataWithDurablyEmptyCredentialsForExplicitLogin()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record(null,"cookie-B"));NativeSessionBinding.Admission admitted=f.admission("cookie-B","binding-B");first.preparePublicLogout(admitted);f.failMarkerRemove=true;
            try{f.complete(first,admitted);fail("Injected metadata retirement unexpectedly succeeded");}catch(java.io.IOException expected){}
            CookieVault second=f.vault();assertTrue(second.invalidated(f.origin));assertTrue(second.confirmedEmptyForLogin(f.origin));
            try{second.publicRetry(f.origin,null);fail("Empty credentials are not authority for an unbound GET retry");}catch(NativeSessionBinding.Failure expected){}
            f.failCryptoWrite=true;try{second.write(f.record(null,null));fail("Injected key fault missing");}catch(GeneralSecurityException expected){}
            assertTrue("Readability, not a failed credential read, proves empty",second.confirmedEmptyForLogin(f.origin));
            f.failCryptoRead=true;try{second.confirmedEmptyForLogin(f.origin);fail("Unreadable secure state was treated as empty");}catch(GeneralSecurityException expected){}
        }
    }
    @Test public void freshActualLoginRollbackCDoesNotOverwriteBAndOnlyItsOwnContextCanRetire()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record(null,null));NativeSessionBinding.Admission old=f.admission("cookie-B","binding-B");first.preparePublicLogout(old);
            NativeSessionBinding.Admission current=NativeSessionBinding.actualLoginCleanup(f.origin,"cookie-C",new JSONObject().put("authenticated",true).put("cache_binding","binding-C"));first.preparePublicLogout(current);f.failCryptoWrite=true;
            try{first.confirmActualLogin(current,()->first.write(f.record("cookie-C",null)));fail("Injected C key fault missing");}catch(GeneralSecurityException expected){}
            CookieVault second=f.vault();assertNotNull(second.publicRetry(f.origin,"cookie-B"));assertNotNull(second.publicRetry(f.origin,"cookie-C"));f.failCryptoWrite=false;
            f.complete(second,current);assertNotNull(second.publicRetry(f.origin,"cookie-B"));try{second.publicRetry(f.origin,"cookie-C");fail("Retired C borrowed B");}catch(NativeSessionBinding.Failure expected){}
            NativeSessionBinding.Admission next=NativeSessionBinding.actualLoginCleanup(f.origin,"cookie-D",new JSONObject().put("authenticated",true).put("cache_binding","binding-D"));second.preparePublicLogout(next);second.confirmActualLogin(next,()->second.write(f.record("cookie-D",null)));
            CookieVault third=f.vault();assertFalse(third.hasPublicContext(f.origin));assertTrue("cookie-D".equals(third.read().opt("active")));
        }
    }
    @Test public void appWideContextCapPreservesAllAcceptedEntriesAndDoesNotDowngradeToBodyless()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault vault=f.vault();for(int i=0;i<100;i++)vault.preparePublicLogout(f.admission("cookie-"+i,"binding-"+i));
            try{vault.preparePublicLogout(f.admission("cookie-over-limit","binding-over-limit"));fail("Unbounded negative contexts accepted");}catch(NativeSessionBinding.Failure expected){}
            assertNotNull(vault.publicRetry(f.origin,"cookie-0"));assertNotNull(vault.publicRetry(f.origin,"cookie-99"));
            try{vault.publicRetry(f.origin,"cookie-over-limit");fail("Rejected context became bodyless");}catch(NativeSessionBinding.Failure expected){}
        }
    }
    @Test public void visibleButUncommittedContextMustBeResealedBeforePrepareGenericFenceOrPendingBody()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record("cookie-B",null));NativeSessionBinding.Admission request=f.admission("cookie-B","binding-B");f.overlayOnlyMarker=true;f.api24NoChangeSuccess=true;
            try{first.preparePublicLogout(request);fail("Injected directory-sync failure accepted context");}catch(java.io.IOException expected){}
            assertTrue("Visible uncertain metadata is still a negative in-process fence",first.invalidated(f.origin));assertTrue("Raw persisted prefs have no context",f.real.getAll().keySet().stream().noneMatch(key->key.startsWith(PUBLIC)));
            CookieVault second=f.vault();int attempts=f.markerCommits;
            try{second.preparePublicLogout(request);fail("Equal visible metadata bypassed the required durable rewrite");}catch(java.io.IOException expected){}assertTrue(f.markerCommits>attempts);
            attempts=f.markerCommits;assertFalse("Generic invalidation may not claim a durable context from the cache",second.markInvalidated(f.origin));assertTrue(f.markerCommits>attempts);
            attempts=f.markerCommits;try{second.publicRetry(f.origin,"cookie-B");fail("Uncommitted metadata yielded a pending HTTP body");}catch(java.io.IOException expected){}assertTrue(f.markerCommits>attempts);
            f.overlayOnlyMarker=false;second.preparePublicLogout(request);CookieVault durable=new CookieVault(f.context,f.real,f.alias,f.keyAccess());
            assertTrue(durable.invalidated(f.origin));assertNotNull(durable.publicRetry(f.origin,"cookie-B"));assertTrue("cookie-B".equals(durable.read().opt("active")));
        }
    }
    @Test public void failedNewLoginRetirementKeepsCSeparateAndRestartMasksItsDurableActiveCookie()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record(null,null));first.preparePublicLogout(f.admission("cookie-B","binding-B"));
            NativeSessionBinding.Admission actualC=NativeSessionBinding.actualLoginCleanup(f.origin,"cookie-C",new JSONObject().put("authenticated",true).put("cache_binding","binding-C"));first.preparePublicLogout(actualC);f.failMarkerRemove=true;
            try{first.confirmActualLogin(actualC,()->first.write(f.record("cookie-C",null)));fail("Injected context retirement unexpectedly succeeded");}catch(java.io.IOException expected){}
            NativePolicy.SessionInvalidation fence=NativePolicy.fenceSession(f.origin,"cookie-C",f.storage(first));assertTrue(fence.durable);
            CookieVault second=f.vault();JSONObject saved=second.read();assertTrue("cookie-C".equals(saved.opt("active")));NativePolicy.SessionRead restored=NativePolicy.restoreSession(saved.getString("active"),null,second.invalidated(f.origin));assertNull(restored.active);assertTrue("cookie-C".equals(restored.revoke));
            NativeSessionBinding.Admission retry=second.publicRetry(f.origin,restored.revoke);assertTrue(new JSONObject(new String(retry.body,StandardCharsets.UTF_8)).getString("cache_binding").equals("binding-C"));assertNotNull(second.publicRetry(f.origin,"cookie-B"));
        }
    }

    @Test public void actualOwnedXmlMismatchCannotAuthorizeEffectsFromCachedCommitSuccess()throws Exception{
        try(ReconcileDeviceTest.Fixture nativeStore=new ReconcileDeviceTest.Fixture();Fixture f=new Fixture(nativeStore.origin)){
            CookieVault vault=f.vault();vault.write(f.record("cookie-B",null));String lease=nativeStore.outbox.get("lease");long head=nativeStore.outbox.head();int effects=0;f.corruptAfterPublicCommit=true;
            try{vault.preparePublicLogout(f.admission("cookie-B","binding-B"));effects++;nativeStore.outbox.revoke();fail("Cached success authorized effects despite actual owned XML mismatch");}catch(java.io.IOException expected){}
            assertEquals(0,effects);assertEquals(head,nativeStore.outbox.head());assertEquals(lease,nativeStore.outbox.get("lease"));assertTrue(vault.invalidated(f.origin));
        }
    }

    @Test public void anyPreexistingOwnedBackupBlocksPublicEffectsWithoutConsumingIt()throws Exception{
        for(int kind=0;kind<3;kind++)try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault vault=f.vault();vault.write(f.record("cookie-B",null));byte[] original=f.readOwnXml();f.ownedBackup=true;
            if(kind==0)f.writeOwnBackup(original);
            else if(kind==1)assertTrue(f.backup().mkdir());
            else android.system.Os.symlink(f.backing().getPath(),f.backup().getPath());
            android.system.StructStat before=android.system.Os.lstat(f.backup().getPath());int effects=0;
            assertTrue("Backup uncertainty must mask credentials before any context exists",vault.invalidated(f.origin));
            try{vault.preparePublicLogout(f.admission("cookie-B","binding-B"));effects++;fail("Existing backup authorized public effects, kind="+kind);}catch(java.io.IOException expected){}
            assertEquals(0,effects);android.system.StructStat after=android.system.Os.lstat(f.backup().getPath());assertEquals(before.st_ino,after.st_ino);assertEquals(before.st_mode,after.st_mode);
            if(kind!=1)assertArrayEquals("The native guard must never consume or rewrite the owned backup",original,f.readOwnFile(f.backup()));
        }
    }

    @Test public void survivingBackupAfterCachedCommitCannotAuthorizePublicEffects()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault vault=f.vault();vault.write(f.record("cookie-B",null));byte[] previous=f.readOwnXml();int effects=0;f.backupAfterPublicCommit=true;
            try{vault.preparePublicLogout(f.admission("cookie-B","binding-B"));effects++;fail("Cached success ignored a surviving rollback candidate");}catch(java.io.IOException expected){}
            assertEquals(0,effects);assertArrayEquals(previous,f.readOwnFile(f.backup()));assertTrue(f.vault().invalidated(f.origin));
            try{f.vault().publicRetry(f.origin,"cookie-B");fail("Surviving backup became a pending body");}catch(java.io.IOException expected){}
            assertArrayEquals(previous,f.readOwnFile(f.backup()));
        }
    }

    @Test public void emptyCachedRetirementWithBackupNeverFallsBackToBodylessAfterFreshInstance()throws Exception{
        try(Fixture f=new Fixture("https://context-"+UUID.randomUUID()+".invalid")){
            CookieVault first=f.vault();first.write(f.record(null,null));NativeSessionBinding.Admission request=f.admission("cookie-B","binding-B");first.preparePublicLogout(request);byte[] previous=f.readOwnXml();
            SharedPreferences.Editor editor=f.real.edit();for(String key:f.real.getAll().keySet())if(key.startsWith(PUBLIC))editor.remove(key);assertTrue(editor.commit());f.writeOwnBackup(previous);
            assertTrue("Fixture must expose an empty same-process cache",f.real.getAll().keySet().stream().noneMatch(key->key.startsWith(PUBLIC)));
            CookieVault fresh=f.vault();assertTrue("Uncertain backup must survive a fresh native instance with empty cached metadata",fresh.invalidated(f.origin));assertTrue(fresh.hasPublicContext(f.origin));
            try{fresh.publicRetry(f.origin,null);fail("Empty cache plus backup became a legacy bodyless retry");}catch(java.io.IOException expected){}
            try{fresh.confirmedEmptyForLogin(f.origin);fail("Backup uncertainty became proven empty credentials");}catch(java.io.IOException expected){}
            try{fresh.preparePublicLogout(request);fail("Preflight consumed a backup after cached retirement");}catch(java.io.IOException expected){}
            assertFalse(fresh.markInvalidated(f.origin));assertArrayEquals(previous,f.readOwnFile(f.backup()));
        }
    }

}
