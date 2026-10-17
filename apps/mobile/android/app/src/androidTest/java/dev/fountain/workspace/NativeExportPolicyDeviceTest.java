package dev.fountain.workspace;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Existing server disable_export policy, fresh private workspace authority only. */
@RunWith(AndroidJUnit4.class)
public class NativeExportPolicyDeviceTest {
    interface Action {void run()throws Exception;}
    private static void access(Action action)throws Exception{try{action.run();fail("Workspace export policy was bypassed");}catch(NativeRecovery.Failure expected){assertEquals("RECOVERY_ACCESS_REQUIRED",expected.code);}}
    private static Set<String> exports(){File directory=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir(),"native_exports");String[] names=directory.list();return names==null?new HashSet<>():new HashSet<>(Arrays.asList(names));}
    @Test public void actualFalseOrLegacyOmittedFlagAllowsReadableExportAndChecksAgainBeforeBytes()throws Exception{
        for(boolean omitted:new boolean[]{false,true})try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            NativeLocalRecoveryDeviceTest.seed(f,"local-parent",null);final int[] requests={0};NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{assertEquals("/api/workspace",path);requests[0]++;JSONObject body=f.workspace(10,false);if(!omitted)body.put("settings",new JSONObject().put("disable_export",false));return body;}};
            try(NativeRecovery recovery=NativeLocalRecoveryDeviceTest.recovery(f)){JSONObject inventory=recovery.inventory(null,100,1,authority);JSONArray handles=NativeLocalRecoveryDeviceTest.handles(inventory);JSONObject ready=recovery.prepare(inventory.getString("inventoryToken"),handles,1,authority);assertEquals(4,ready.getInt("readyCount"));assertEquals(0,ready.getInt("blockedCount"));NativeRecovery.Prepared files=recovery.saving(inventory.getString("inventoryToken"),ready.getString("exportToken"),handles,authority);int prior=requests[0];recovery.checkSavedSource(files,authority);assertTrue(requests[0]>prior);recovery.finished(files);}
        }
    }
    @Test public void disabledEvenForOwnerAndMalformedPresentPolicyCannotCreateExportFiles()throws Exception{
        for(int variant=0;variant<3;variant++)try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            NativeLocalRecoveryDeviceTest.seed(f,"local-parent",null);final int kind=variant;NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{assertEquals("/api/workspace",path);JSONObject body=f.workspace(10,false);return body.put("settings",kind==2?"invalid":new JSONObject().put("disable_export",kind==0?Boolean.TRUE:"false"));}};Set<String> before=exports();long head=f.outbox.head();
            try(NativeRecovery recovery=NativeLocalRecoveryDeviceTest.recovery(f)){JSONObject inventory=recovery.inventory(null,100,1,authority);access(()->recovery.prepare(inventory.getString("inventoryToken"),NativeLocalRecoveryDeviceTest.handles(inventory),1,authority));assertEquals(before,exports());assertEquals(head,f.outbox.head());assertEquals(4,f.count("records"));}
        }
    }
    @Test public void policyToggleInvalidatesOldPreparedCapabilityAndDeletesOnlyItsTemporaryFiles()throws Exception{
        try(ReconcileDeviceTest.Fixture f=new ReconcileDeviceTest.Fixture()){
            NativeLocalRecoveryDeviceTest.seed(f,"local-parent",null);final boolean[] disabled={false};final int[] revision={10};NativeRecovery.Authority authority=new NativeRecovery.Authority(){public void check(){}public JSONObject get(String path)throws Exception{assertEquals("/api/workspace",path);return f.workspace(revision[0],false).put("settings",new JSONObject().put("disable_export",disabled[0]));}};
            try(NativeRecovery recovery=NativeLocalRecoveryDeviceTest.recovery(f)){JSONObject inventory=recovery.inventory(null,100,1,authority);JSONArray handles=NativeLocalRecoveryDeviceTest.handles(inventory);JSONObject ready=recovery.prepare(inventory.getString("inventoryToken"),handles,1,authority);NativeRecovery.Prepared prepared=recovery.saving(inventory.getString("inventoryToken"),ready.getString("exportToken"),handles,authority);File[] ownFiles=prepared.files.toArray(new File[0]);assertTrue(ownFiles.length>0);long head=f.outbox.head();disabled[0]=true;revision[0]=11;access(()->recovery.checkSavedSource(prepared,authority));for(File file:ownFiles)assertFalse(file.exists());assertEquals(head,f.outbox.head());assertEquals(4,f.count("records"));disabled[0]=false;revision[0]=12;recovery.observe("GET","/api/workspace",200,authority.get("/api/workspace"));try{recovery.checkPrepared(prepared,authority);fail("Toggle-back revived old export capability");}catch(NativeRecovery.Failure expected){assertEquals("RECOVERY_STALE",expected.code);}}
        }
    }
}
