package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual dedicated publication helper + private Recovery caps + final reply protocol.
 * Synthetic actual-session/canonical fixtures; no Activity/cloud/user-store mutation.
 */
@RunWith(AndroidJUnit4.class)
public class RecoveryPublicationDeviceTest {
    private static final String SCOPE="publication-native-owner";
    private static NativeRecovery.Session identity(ReconcileDeviceTest.Fixture f,String role)throws Exception{JSONObject body=new JSONObject(f.outbox.get("grant")).getJSONObject("session");body.getJSONObject("member").put("role",role);return new NativeRecovery.Session(f.origin,body,null,SCOPE);}
    private static JSONObject prepared(NativeRecovery recovery,NativeRecovery.Authority authority)throws Exception{JSONObject inventory=recovery.inventory(null,100,1,authority);return recovery.prepare(inventory.getString("inventoryToken"),NativeLocalRecoveryDeviceTest.handles(inventory),1,authority);}
    private static boolean current(NativeRecovery recovery,JSONObject metadata,NativeRecovery.Authority authority){try{recovery.checkResponse(new JSObject(metadata.toString()),authority);return true;}catch(Exception stale){return false;}}
    private static void await(CountDownLatch latch)throws Exception{assertTrue("Native publication fixture timed out",latch.await(5,TimeUnit.SECONDS));}
    @Test public void concurrentRolePublicationOwnsSameFinalUiLockAndOldRoleMetadataDiesAfterPublication()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            NativeLocalRecoveryDeviceTest.seed(f,"local-parent",null);NativeRecovery.Session owner=identity(f,"owner"),guest=identity(f,"guest");f.outbox.revoke();assertNull(f.outbox.verified(null,false));
            try(NativeRecovery recovery=NativeLocalRecoveryDeviceTest.recovery(f)){
                recovery.refresh(owner);NativeRecovery.Authority base=NativeLocalRecoveryDeviceTest.authority(f);JSONObject old=prepared(recovery,base);Object finalUiLock=new Object();
                CountDownLatch checked=new CountDownLatch(1),permitPublication=new CountDownLatch(1),published=new CountDownLatch(1),uiChecked=new CountDownLatch(1),uiFinished=new CountDownLatch(1);AtomicReference<Throwable> error=new AtomicReference<>();AtomicReference<Thread> publishingThread=new AtomicReference<>();AtomicBoolean publicationOwnsOuterLock=new AtomicBoolean(),staleEvaluated=new AtomicBoolean();AtomicInteger evaluations=new AtomicInteger();
                // Model the real Authority.check's own brief native-lock check.
                // The latch AFTER that check forces the exact pre-publication gap.
                NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check()throws Exception{synchronized(finalUiLock){base.check();}if(Thread.currentThread()==publishingThread.get()){publicationOwnsOuterLock.set(Thread.holdsLock(finalUiLock));checked.countDown();await(permitPublication);}}public JSONObject get(String path)throws Exception{return base.get(path);}};
                Thread publisher=new Thread(()->{try{FountainNativePlugin.publishRecoveryAuthority(finalUiLock,authority,()->{recovery.refresh(guest);JSONObject body=new JSONObject(f.outbox.get("grant")).getJSONObject("session");body.getJSONObject("member").put("role","guest");try{f.outbox.grant(body,null);fail("Suspended Outbox binding revived");}catch(NativeOutbox.AccessRequired expected){}});}catch(Throwable failure){error.compareAndSet(null,failure);}finally{published.countDown();}},"native-recovery-publication");publishingThread.set(publisher);publisher.start();await(checked);
                Thread ui=new Thread(()->{try{synchronized(finalUiLock){NativeBridgeReply.deliver(new PluginCall(null,"FountainNative","queued-role-metadata","recoveryExport",new JSObject().put("generation",1)),new JSObject(old.toString()),()->{boolean before=current(recovery,old,base);uiChecked.countDown();if(before&&!publicationOwnsOuterLock.get())try{await(published);}catch(Exception failure){throw new IllegalStateException(failure);}return before;},new NativeBridgeReply.Destination(){public void evaluate(String script){staleEvaluated.set(!current(recovery,old,base));evaluations.incrementAndGet();}public void release(){}});}}catch(Throwable failure){error.compareAndSet(null,failure);}finally{uiFinished.countDown();}},"native-final-ui-reply");ui.start();
                if(!publicationOwnsOuterLock.get())await(uiChecked); // Prior helper: close role AFTER checked, BEFORE evaluate.
                permitPublication.countDown();await(published);await(uiFinished);publisher.join(1000);ui.join(1000);if(error.get()!=null)throw new AssertionError("Native publication fixture failed",error.get());
                assertFalse("Actual publisher changed role between locked final check and evaluate",staleEvaluated.get());assertTrue("Actual dedicated publisher did not own the same final UI lock",publicationOwnsOuterLock.get());assertEquals(0,evaluations.get());assertFalse(current(recovery,old,base));assertNull(f.outbox.verified(null,false));assertEquals(4,f.count("records"));
            }
        }
    }
    @Test public void liveExpiryCannotExtendAndShorterCurrentDeadlineFencesOldMetadataWhileOutboxBlocked()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            NativeLocalRecoveryDeviceTest.seed(f,"local-parent",null);NativeRecovery.Session owner=identity(f,"owner");f.outbox.revoke();
            try(NativeRecovery recovery=NativeLocalRecoveryDeviceTest.recovery(f)){
                recovery.refresh(owner);NativeRecovery.Authority authority=NativeLocalRecoveryDeviceTest.authority(f);JSONObject old=prepared(recovery,authority);long deadline=owner.validUntil;Object lock=new Object();NativeRecovery.Session longer=identity(f,"owner");longer.validUntil=deadline+100000;
                FountainNativePlugin.publishRecoveryAuthority(lock,authority,()->recovery.refresh(longer));assertEquals(deadline,longer.validUntil);assertTrue(current(recovery,old,authority));
                NativeRecovery.Session elapsed=identity(f,"owner");elapsed.validUntil=System.currentTimeMillis()-1;FountainNativePlugin.publishRecoveryAuthority(lock,authority,()->recovery.refresh(elapsed));
                try{recovery.checkResponse(new JSObject(old.toString()),authority);fail("Final response borrowed the old private deadline");}catch(NativeRecovery.Failure expected){assertEquals("RECOVERY_AUTH_REQUIRED",expected.code);}assertNull(f.outbox.verified(null,false));assertEquals(4,f.count("records"));
            }
        }
    }
    @Test public void stalePrivateAuthorityCannotPublishOrInvalidateTheNewReader()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            NativeLocalRecoveryDeviceTest.seed(f,"local-parent",null);try(NativeRecovery recovery=NativeLocalRecoveryDeviceTest.recovery(f)){
                NativeRecovery.Authority authority=NativeLocalRecoveryDeviceTest.authority(f);JSONObject metadata=prepared(recovery,authority);AtomicBoolean mutation=new AtomicBoolean();NativeRecovery.Authority stale=new NativeRecovery.Authority(){public void check()throws Exception{throw new NativeRecovery.Failure("RECOVERY_STALE");}public JSONObject get(String path){throw new AssertionError("Unexpected HTTP");}};
                try{FountainNativePlugin.publishRecoveryAuthority(new Object(),stale,()->{mutation.set(true);recovery.invalidate();});fail("Stale private scope published");}catch(NativeRecovery.Failure expected){assertEquals("RECOVERY_STALE",expected.code);}assertFalse(mutation.get());assertTrue(current(recovery,metadata,authority));assertEquals(4,f.count("records"));
            }
        }
    }
}
