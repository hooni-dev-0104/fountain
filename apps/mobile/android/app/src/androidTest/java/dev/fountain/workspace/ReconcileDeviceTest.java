package dev.fountain.workspace;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Production collector/SQLite tests. Native grants and HTTP replies are synthetic. */
@RunWith(AndroidJUnit4.class)
public class ReconcileDeviceTest {
    interface Action { void run() throws Exception; }
    private static void failure(Action action, String code) throws Exception {
        try { action.run(); fail("Native reconciliation boundary was bypassed"); }
        catch (NativeReconcile.Failure expected) { assertEquals(code, expected.code); }
    }
    static final class Fixture implements AutoCloseable {
        final String origin = "https://reconcile-" + UUID.randomUUID() + ".invalid", owner = "native-owner";
        final NativeOutbox outbox; final SQLiteDatabase db; final File file; long sequence;
        Fixture() throws Exception {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            outbox = new NativeOutbox(context, origin); file = new File(context.getNoBackupFilesDir(), "durable_outbox/" + OutboxPolicy.hash(origin) + ".sqlite");
            db = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            outbox.grant(new JSONObject().put("authenticated", true).put("required", false).put("mode", "local").put("workspace_id", "workspace").put("cache_binding", "binding")
                .put("member", new JSONObject().put("id", "member").put("role", "owner").put("active", true)), null);
            open();
        }
        JSONObject open() throws Exception { return outbox.open(1, null, false, owner); }
        String profile() throws Exception { return OutboxPolicy.profile(origin, "workspace", "member", "binding"); }
        JSONObject prepare() throws Exception {
            JSONObject opened = open(); return new JSONObject().put("generation", 1).put("phase", "prepare").put("lease", opened.getString("lease"))
                .put("baseHead", opened.getLong("head")).put("proofEpoch", opened.getLong("proofEpoch")).put("mode", "current");
        }
        JSONObject call(JSONObject input) throws Exception { return outbox.reconcile(input, 1, null, false, owner, sequence); }
        JSONObject next(JSONObject result) throws Exception { return call(new JSONObject().put("generation", 1).put("phase", "prepare").put("lease", result.getString("lease")).put("planId", result.getString("planId"))); }
        JSONObject envelope(int data) throws Exception { return new JSONObject().put("workspace_id", "workspace").put("current_member_id", "member").put("session_binding", "binding").put("access_revision", 10).put("data_revision", data); }
        JSONObject page(int data, int seq) throws Exception { return envelope(data).put("epoch", "epoch").put("seq", seq).put("access_level", 4)
            .put("page", new JSONObject().put("id", "page").put("access_level", 4).put("locked", false).put("archived", false)).put("blocks", new JSONArray())
            .put("state", new JSONObject().put("version", 1).put("max_clock", 0).put("blocks", new JSONObject()).put("seen", new JSONObject())); }
        JSONObject workspace(int data, boolean page) throws Exception { return envelope(data).put("pages", page ? new JSONArray().put(page(data, 0).getJSONObject("page")) : new JSONArray())
            .put("databases", new JSONArray()).put("teamspaces", new JSONArray().put(new JSONObject().put("id", "general").put("access_level", 3))); }
        void observed(String path, JSONObject body) throws Exception {
            NativeReconcile.Tag tag = outbox.admitReconcile(++sequence, "GET", path, null, false, owner);
            assertNotNull("Only a post-admission exact expected native request may fill the collector", tag);
            outbox.beforeReconcileObservation(tag, null, false, owner);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            outbox.observe("GET", path, 200, bytes, null, false, owner);
            outbox.captureReconcile(tag, 200, bytes, null, false, owner);
        }
        JSONObject commit(JSONObject ready) throws Exception { return new JSONObject().put("generation", 1).put("phase", "commit").put("lease", ready.getString("lease"))
            .put("baseHead", ready.getLong("baseHead")).put("proofEpoch", ready.getLong("proofEpoch")).put("planId", ready.getString("planId")).put("checksum", ready.getString("checksum")).put("confirm", true); }
        long count(String table) { try (Cursor c = db.rawQuery("SELECT count(*) FROM " + table, null)) { assertTrue(c.moveToFirst()); return c.getLong(0); } }
        public void close() { db.close(); outbox.close(); assertTrue(file.delete()); }
    }
    @Test public void freshCanonicalCommitAndLostCallbackRetryAreAtomic() throws Exception {
        try (Fixture f = new Fixture()) {
            JSONObject collecting = f.call(f.prepare()); assertEquals("collecting", collecting.getString("state")); assertEquals(1, collecting.getInt("sweep"));
            f.observed("/api/workspace", f.workspace(10, false)); JSONObject ready = f.next(collecting);
            assertEquals("ready", ready.getString("state")); assertEquals(3, ready.getJSONObject("counts").getInt("refresh")); assertFalse(ready.getBoolean("requiresConfirmation"));
            assertEquals(0, f.count("records")); JSONObject request = f.commit(ready), accepted = f.call(request);
            assertEquals("committed", accepted.getString("state")); assertEquals(ready.getLong("baseHead") + 1, accepted.getLong("head")); assertEquals(3, f.count("records"));
            assertEquals(accepted.toString(), f.call(request).toString()); assertEquals(1, f.count("reconcile_receipts"));
            f.call(new JSONObject().put("generation", 1).put("phase", "cancel").put("planId", ready.getString("planId")));
            assertEquals(accepted.toString(), f.call(request).toString()); assertEquals(3, f.count("records"));
        }
    }
    @Test public void lateAdmissionCannotFillAndUnrelatedSourceChangeInvalidatesPlan() throws Exception {
        try (Fixture f = new Fixture()) {
            assertNull(f.outbox.admitReconcile(++f.sequence, "GET", "/api/workspace", null, false, f.owner));
            JSONObject collecting = f.call(f.prepare()); f.outbox.beforeReconcileObservation(null, null, false, f.owner);
            byte[] late = f.page(10, 0).toString().getBytes(StandardCharsets.UTF_8);
            f.outbox.observe("GET", "/api/pages/page/collaboration", 200, late, null, false, f.owner);
            f.outbox.captureReconcile(null, 200, late, null, false, f.owner);
            failure(() -> f.next(collecting), "OUTBOX_RECONCILE_STALE");
            JSONObject next = f.call(f.prepare());
            f.db.execSQL("INSERT INTO records VALUES('active','meta',?,?,NULL,?)", new Object[]{JSONObject.quote("mutation-sequence:" + f.profile()), f.profile(), new JSONObject().put("id", "mutation-sequence:" + f.profile()).put("profileId", f.profile()).put("value", 1).toString().getBytes(StandardCharsets.UTF_8)});
            failure(() -> f.next(next), "OUTBOX_RECONCILE_STALE"); assertEquals(1, f.count("records"));
        }
    }
    @Test public void lazyCollaborationConvergesInSecondSweepWithoutBaselineWritesDuringPrepare() throws Exception {
        try (Fixture f = new Fixture()) {
            // An actual native-observed requested page is part of the closure;
            // merely visible, unopened workspace pages are not fetched eagerly.
            f.outbox.observe("GET","/api/pages/page/collaboration",200,f.page(10,0).toString().getBytes(StandardCharsets.UTF_8),null,false,f.owner);
            JSONObject collecting = f.call(f.prepare()); f.observed("/api/workspace", f.workspace(10, true)); collecting = f.next(collecting);
            f.observed("/api/pages/page/collaboration", f.page(11, 0)); collecting = f.next(collecting); assertEquals(2, collecting.getInt("sweep"));
            assertEquals(0, f.count("records")); f.observed("/api/workspace", f.workspace(11, true)); collecting = f.next(collecting);
            f.observed("/api/pages/page/collaboration", f.page(11, 0)); JSONObject ready = f.next(collecting);
            assertEquals("ready", ready.getString("state")); assertEquals(4, ready.getJSONObject("counts").getInt("refresh")); f.call(f.commit(ready)); assertEquals(4, f.count("records"));
        }
    }
    @Test public void readyCommitRejectsChangedHeadAndUnknownRendererProofFields() throws Exception {
        try (Fixture f = new Fixture()) {
            JSONObject forged = f.prepare().put("role", "owner");
            try { f.call(forged); fail("Renderer supplied authority"); } catch (IllegalArgumentException expected) { }
            JSONObject collecting = f.call(f.prepare()); f.observed("/api/workspace", f.workspace(10, false)); JSONObject ready = f.next(collecting);
            f.db.execSQL("UPDATE control SET value=CAST(value AS INTEGER)+1 WHERE key='head'");
            failure(() -> f.call(f.commit(ready)), "OUTBOX_RECONCILE_STALE"); assertEquals(0, f.count("records")); assertEquals(0, f.count("reconcile_receipts"));
        }
    }
    @Test public void coldMetadataOnlyProfileDoesNotFetchTwoHundredUnopenedPageBodies()throws Exception{
        try(Fixture f=new Fixture()){
            JSONObject collecting=f.call(f.prepare()),workspace=f.workspace(10,false);JSONArray visible=new JSONArray();
            for(int i=0;i<200;i++)visible.put(new JSONObject().put("id","unopened-"+i).put("access_level",4).put("locked",false).put("archived",false));
            workspace.put("pages",visible);f.observed("/api/workspace",workspace);JSONObject ready=f.next(collecting);
            assertEquals("ready",ready.getString("state"));assertEquals(3,ready.getJSONObject("counts").getInt("refresh"));
            try(Cursor c=f.db.rawQuery("SELECT count(*) FROM reconcile_capture WHERE kind='page'",null)){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}
            assertEquals(0,f.count("records"));f.call(f.commit(ready));assertEquals(3,f.count("records"));
        }
    }
}
