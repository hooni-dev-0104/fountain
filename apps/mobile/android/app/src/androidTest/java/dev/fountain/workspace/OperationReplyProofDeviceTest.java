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

/** Actual Android SQLite observer tests with synthetic native session grants. */
@RunWith(AndroidJUnit4.class)
public class OperationReplyProofDeviceTest {
    interface Action { void run() throws Exception; }
    private static void denied(Action action) throws Exception {
        try { action.run(); fail("Invalid native proof was accepted"); }
        catch (NativeOutbox.AccessRequired expected) { }
    }
    private static String control(SQLiteDatabase db, String key) {
        try (Cursor cursor = db.rawQuery("SELECT value FROM control WHERE key=?", new String[]{key})) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }
    private static final class Fixture implements AutoCloseable {
        final String origin = "https://operation-proof-" + UUID.randomUUID() + ".invalid";
        final File source;
        final NativeOutbox outbox;
        final SQLiteDatabase db;
        Fixture() throws Exception {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            source = new File(context.getNoBackupFilesDir(), "durable_outbox/" + OutboxPolicy.hash(origin) + ".sqlite");
            outbox = new NativeOutbox(context, origin);
            db = SQLiteDatabase.openDatabase(source.getPath(), null, SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            outbox.grant(new JSONObject().put("authenticated", true).put("required", false).put("mode", "local")
                .put("workspace_id", "workspace").put("cache_binding", "binding")
                .put("member", new JSONObject().put("id", "member").put("role", "owner").put("active", true)), null);
            outbox.open(1, null, false, "native-owner");
            JSONObject workspace = envelope(10).put("pages", new JSONArray().put(new JSONObject()
                .put("id", "page").put("access_level", 4).put("locked", false).put("archived", false))).put("databases", new JSONArray());
            observe("GET", "/api/workspace", 200, workspace);
            observe("GET", "/api/pages/page/collaboration", 200, page(10, 0));
        }
        JSONObject envelope(int data) throws Exception {
            return new JSONObject().put("workspace_id", "workspace").put("current_member_id", "member")
                .put("session_binding", "binding").put("access_revision", 10).put("data_revision", data);
        }
        JSONObject page(int data, int seq) throws Exception {
            return envelope(data).put("epoch", "epoch").put("seq", seq).put("access_level", 4)
                .put("page", new JSONObject().put("id", "page").put("access_level", 4).put("locked", false).put("archived", false))
                .put("state", new JSONObject()).put("blocks", new JSONArray());
        }
        void observe(String method, String path, int status, JSONObject body) throws Exception {
            outbox.observe(method, path, status, body.toString().getBytes(StandardCharsets.UTF_8), null, false, "native-owner");
        }
        JSONObject proof() throws Exception {
            return new JSONObject(control(db, "resource_proofs")).getJSONObject("entries").getJSONObject("page:page");
        }
        JSONObject readIntent() throws Exception {
            JSONObject opened = outbox.open(1, null, false, "native-owner");
            return new JSONObject().put("generation", 1).put("lease", opened.getString("lease"))
                .put("head", opened.getLong("head")).put("proofEpoch", opened.getLong("proofEpoch")).put("byteLimit", 1024).put("cursor", JSONObject.NULL);
        }
        public void close() {
            db.close(); outbox.close(); assertTrue(source.delete());
        }
    }
    @Test public void successfulOperationReplyRaisesSequenceAndRejectsLateRead() throws Exception {
        try (Fixture f = new Fixture()) {
            long oldProof = f.outbox.proofEpoch();
            JSONObject accepted = f.page(11, 1).put("ack", new JSONArray().put("client:1").put("client:1"));
            f.observe("POST", "/api/pages/page/operations", 200, accepted);
            assertEquals(1, f.proof().getLong("seq"));
            assertEquals(11, f.proof().getLong("dataRevision"));
            assertTrue(f.outbox.proofEpoch() > oldProof);
            String current = control(f.db, "resource_proofs");
            denied(() -> f.observe("GET", "/api/pages/page/collaboration", 200, f.page(10, 0)));
            assertEquals(current, control(f.db, "resource_proofs"));
            denied(() -> f.observe("POST", "/api/pages/page/operations", 200, f.page(12, 0).put("ack", new JSONArray().put("client:1"))));
            assertEquals("A later global revision cannot lower the same document sequence", current, control(f.db, "resource_proofs"));
            long stable = f.outbox.proofEpoch();
            f.observe("POST", "/api/pages/page/operations", 200, accepted);
            assertEquals("Idempotent ACK must not churn native leases", stable, f.outbox.proofEpoch());
            f.observe("POST", "/api/pages/page/operations", 200, f.page(11, 1).put("ack", new JSONArray()));
            assertEquals(stable, f.outbox.proofEpoch());
            f.observe("POST", "/api/pages/page/operations", 200, f.page(12, 0).put("epoch", "replacement-epoch").put("ack", new JSONArray()));
            assertEquals("replacement-epoch", f.proof().getString("epoch"));
            assertEquals(0, f.proof().getLong("seq"));
        }
    }
    @Test public void writeFailuresNeverRevokeReadAuthorityOrDeletePendingInput() throws Exception {
        try (Fixture f = new Fixture()) {
            String profile = OutboxPolicy.profile(f.origin, "workspace", "member", "binding");
            f.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)", new Object[]{"active", "drafts", "pending", profile, profile + "|page", new byte[]{1, 2, 3}});
            String current = control(f.db, "resource_proofs"), proof = control(f.db, "proof_epoch");
            for (int status : new int[]{201, 204, 400, 401, 403, 404, 409, 423, 500}) {
                f.observe("POST", "/api/pages/page/operations", status, new JSONObject());
                assertEquals(current, control(f.db, "resource_proofs"));
                assertEquals(proof, control(f.db, "proof_epoch"));
            }
            try (Cursor cursor = f.db.rawQuery("SELECT mode,payload FROM records", null)) {
                assertTrue(cursor.moveToFirst()); assertEquals("active", cursor.getString(0));
                assertArrayEquals(new byte[]{1, 2, 3}, cursor.getBlob(1)); assertFalse(cursor.moveToNext());
            }
            assertNull(control(f.db, "revoked-resource:" + profile + "|page"));
            assertFalse(f.proof().optBoolean("denied"));
        }
    }
    @Test public void malformedAcknowledgementRequiresReadRefreshAndPreservesInput() throws Exception {
        try (Fixture f = new Fixture()) {
            JSONArray oversized = new JSONArray(); for (int i = 0; i < 1001; i++) oversized.put("client:1");
            String profile = OutboxPolicy.profile(f.origin, "workspace", "member", "binding");
            String resource = profile + "|page";
            byte[] original = new JSONObject().put("profileId", profile).put("key", resource).put("clientId", "client")
                .put("draft", new JSONObject().put("epoch", "epoch").put("text", "last unsent input 🏠")).toString().getBytes(StandardCharsets.UTF_8);
            f.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)", new Object[]{"active", "drafts", new JSONArray().put(resource).put("client").toString(), profile, resource, original});
            f.db.execSQL("INSERT INTO records VALUES(?,?,?,?,?,?)", new Object[]{"active", "snapshots", JSONObject.quote(resource), profile, resource,
                new JSONObject().put("profileId", profile).put("key", resource).put("snapshot", f.page(10, 0)).toString().getBytes(StandardCharsets.UTF_8)});
            assertEquals("ready", f.outbox.open(1, null, false, "native-owner").getString("resourceAccess"));
            for (Object ack : new Object[]{JSONObject.NULL, true, "client:1", new JSONObject(), new JSONArray().put(1), new JSONArray().put("client:01"), new JSONArray().put("client:9007199254740992"), oversized}) {
                denied(() -> f.observe("POST", "/api/pages/page/operations", 200, f.page(11, 1).put("ack", ack)));
                assertTrue(f.proof().getBoolean("denied")); assertFalse(f.proof().getBoolean("terminal"));
                assertEquals(10, f.proof().getLong("dataRevision"));
                denied(() -> f.outbox.read(f.readIntent(), 1, null, false));
                try (Cursor cursor = f.db.rawQuery("SELECT mode,payload FROM records WHERE bucket='drafts'", null)) {
                    assertTrue(cursor.moveToFirst()); assertEquals("active", cursor.getString(0)); assertArrayEquals(original, cursor.getBlob(1)); assertFalse(cursor.moveToNext());
                }
                f.observe("GET", "/api/pages/page/collaboration", 200, f.page(10, 0));
                assertFalse("Fresh canonical read repairs the nonterminal invalid proof", f.proof().optBoolean("denied"));
                assertEquals("ready", f.outbox.open(1, null, false, "native-owner").getString("resourceAccess"));
                assertTrue(f.outbox.read(f.readIntent(), 1, null, false).getJSONArray("fragments").length() > 0);
            }
            denied(() -> f.observe("POST", "/api/pages/page/operations", 200, f.page(11, 1)));
            assertTrue(f.proof().getBoolean("denied")); assertFalse(f.proof().getBoolean("terminal"));
            f.observe("GET", "/api/pages/page/collaboration", 200, f.page(10, 0));
            JSONArray maximum = new JSONArray(); for (int i = 0; i < 1000; i++) maximum.put("client:9007199254740991");
            f.observe("POST", "/api/pages/page/operations", 200, f.page(11, 1).put("ack", maximum));
            assertEquals(1, f.proof().getLong("seq"));
        }
    }
    @Test public void postReplyCannotOverrideCurrentSessionOrSnapshotIdentity() throws Exception {
        try (Fixture f = new Fixture()) {
            JSONObject reply = f.page(11, 1).put("ack", new JSONArray().put("client:1"));
            String current = control(f.db, "resource_proofs");
            denied(() -> f.outbox.observe("POST", "/api/pages/page/operations", 200, reply.toString().getBytes(StandardCharsets.UTF_8), "foreign-cookie", false, "native-owner"));
            denied(() -> f.outbox.observe("POST", "/api/pages/page/operations", 200, reply.toString().getBytes(StandardCharsets.UTF_8), null, true, "native-owner"));
            assertEquals(current, control(f.db, "resource_proofs"));
            f.observe("POST", "/api/pages/page/operations?ignored", 200, reply);
            assertEquals(current, control(f.db, "resource_proofs"));
            JSONObject foreign = new JSONObject(reply.toString()).put("current_member_id", "foreign");
            denied(() -> f.observe("POST", "/api/pages/page/operations", 200, foreign));
            assertTrue("A complete ACK cannot grant a foreign snapshot", f.proof().getBoolean("denied"));
            assertFalse(f.proof().getBoolean("terminal"));
            f.observe("GET", "/api/pages/page/collaboration", 200, f.page(10, 0));
            JSONObject foreignPage = new JSONObject(reply.toString()); foreignPage.getJSONObject("page").put("id", "foreign-page");
            denied(() -> f.observe("POST", "/api/pages/page/operations", 200, foreignPage));
            assertTrue(f.proof().getBoolean("denied")); assertFalse(f.proof().getBoolean("terminal"));
            f.observe("GET", "/api/pages/page/collaboration", 200, f.page(10, 0));
            JSONObject elevatedPage = new JSONObject(reply.toString()); elevatedPage.getJSONObject("page").put("access_level", 3);
            denied(() -> f.observe("POST", "/api/pages/page/operations", 200, elevatedPage));
            assertTrue(f.proof().getBoolean("denied")); assertFalse(f.proof().getBoolean("terminal"));
            f.observe("GET", "/api/pages/page/collaboration", 200, f.page(10, 0));
            assertFalse(f.proof().optBoolean("denied"));
        }
    }
}
