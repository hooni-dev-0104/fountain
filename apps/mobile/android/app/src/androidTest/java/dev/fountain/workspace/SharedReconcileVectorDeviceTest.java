package dev.fountain.workspace;

import static org.junit.Assert.*;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteException;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

/**
 * Actual production NativeOutbox/NativeReconcile and Android SQLite, driven by the
 * shared corpus. Private native grants and HTTP response bytes are synthetic;
 * this does not establish bridge, HTTPS, Keychain, process restart or activation.
 * Every vector is a separately named JUnit test. An unsupported event/assertion
 * fails its test; there is no assumed-success or mock reconciliation fallback.
 */
@RunWith(Parameterized.class)
public final class SharedReconcileVectorDeviceTest {
    private static final long GENERATION = 1;
    private static final Set<String> INPUTS = new HashSet<>(Arrays.asList("operations", "drafts", "mutations", "localPages", "transfers"));
    private static final Set<String> KNOWN_ASSERTIONS = new HashSet<>(Arrays.asList(
        "input_bytes_preserved", "canonical_installed_atomically", "no_network_replay", "same_transaction_seen_only", "one_transform",
        "archive_before_remove", "no_old_crdt_identity_replay", "complete_dependency_closure", "no_hidden_body_delivery", "native_role_only",
        "source_bytes_unchanged", "no_partial_active_replace", "immutable_receipt", "exact_retry_current_owner", "native_admission_only",
        "no_fabricated_denial", "denial_survives_cancel", "archive_bytes_preserved", "fresh_private_acl", "no_old_owner_session_receipts",
        "explicit_confirmation", "cross_actor_no_descriptors_counts", "archive_collision_no_overwrite", "both_archives_exportable", "two_sweeps_max",
        "no_upload_auto_resume", "export_requires_current_resource_proof", "external_source_change_preserved", "late_legacy_commit_fenced",
        "no_old_delete_replay", "missing_before_image_blocks", "attachment_metadata_native_proof", "journal_before_image_puts_only",
        "checkpoint_after_quarantine_receipt", "stable_unowned_proof_unchanged", "unowned_proof_change_invalidates", "untrusted_profile_does_not_qualify_history", "unaccepted_submit_rejected", "staging_bytes_preserved", "unaccepted_input_not_qualified", "same_floor_equivocation_rejected", "accepted_identity_preserved", "no_fresh_reimport"));

    private static final Set<String> SAFE_REASONS = new HashSet<>(Arrays.asList("missing", "expired", "revision_changed", "epoch_changed", "local_dependency", "denied", "schema_changed", "dependency_conflict", "unconfirmed_input", "binding_changed", "legacy_cache", "unsupported_input"));

    @Parameterized.Parameters(name = "{0}")
    public static Iterable<Object[]> vectors() throws Exception {
        JSONObject corpus;
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("native-reconcile-cases.json")) {
            corpus = new JSONObject(new String(read(input), StandardCharsets.UTF_8));
        }
        assertEquals("schema-corpus-only-not-native-execution", corpus.getString("scope"));
        List<Object[]> result = new ArrayList<>(); JSONArray cases = corpus.getJSONArray("cases");
        assertTrue("The whole shared corpus must be packaged, not a selected subset", cases.length() >= 67);
        Set<String> delegated = new HashSet<>();
        for (int i = 0; i < cases.length(); i++) {
            JSONObject vector = cases.getJSONObject(i); JSONArray targets = vector.getJSONArray("executionTargets"); assertEquals(1, targets.length());
            if (targets.getString(0).equals("native")) result.add(new Object[]{vector.getString("id"), corpus.toString(), vector.toString()});
            else { assertEquals("Only the explicitly Root-delegated JS lane may be excluded", "js", targets.getString(0)); delegated.add(vector.getString("id")); }
        }
        assertEquals(new HashSet<>(Arrays.asList("legacy-delete-no-before-image", "settle-beforeimage-present", "settle-beforeimage-absent", "settle-beforeimage-receipt-failure", "settle-beforeimage-mixed-puts")), delegated);
        assertEquals("All native-assigned cases must execute", 62, result.size());
        return result;
    }
    private final String id, corpusJSON, vectorJSON;
    public SharedReconcileVectorDeviceTest(String id, String corpusJSON, String vectorJSON) { this.id = id; this.corpusJSON = corpusJSON; this.vectorJSON = vectorJSON; }

    @Test public void actualProductionReconciliationMatchesSharedVector() throws Exception {
        try (Fixture f = new Fixture(id, new JSONObject(corpusJSON), new JSONObject(vectorJSON))) {
            f.seed(); // Setup failures are never accepted as an expected runtime rejection.
            try { f.events(); }
            catch (Throwable error) {
                if (!f.expectedFailure(error)) throw new AssertionError(id + " failed at " + f.stage + ": " + safeCode(error), error);
                f.failure = error;
            }
            f.verify();
        }
    }
    private static String safeCode(Throwable error) {
        if (error instanceof NativeReconcile.Failure) return ((NativeReconcile.Failure) error).code;
        return error.getClass().getSimpleName();
    }
    private static byte[] read(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[65536]; int count;
        while ((count = input.read(buffer)) != -1) { assertTrue(output.size() + count <= 16 * 1024 * 1024); output.write(buffer, 0, count); }
        return output.toByteArray();
    }
    private static List<String> strings(JSONArray array) throws Exception { List<String> values = new ArrayList<>(); for (int i = 0; i < array.length(); i++) values.add(array.getString(i)); return values; }
    private static JSONObject copy(JSONObject object) throws Exception { return new JSONObject(object.toString()); }

    private static final class Fixture implements AutoCloseable {
        final String id, origin = "https://shared-vector-" + UUID.randomUUID() + ".invalid", owner = "vector-native-owner";
        final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        final NativeOutbox outbox; final NativeReconcile archive; final File file;
        final JSONObject corpus, vector, expected; final Map<String, JSONObject> sources = new LinkedHashMap<>(), responses = new LinkedHashMap<>();
        final Map<String, byte[]> originals = new HashMap<>(); final Map<String, NativeReconcile.Tag> admitted = new HashMap<>();
        final Map<String, JSONObject> journalRequests = new HashMap<>(); final List<byte[]> collisionOriginals = new ArrayList<>();
        final long timeShift;
        String authority, cookie, profile, stage = "setup"; long sequence, proofBeforeLate, initialHead, initialProof; boolean authChanged;
        JSONObject state, readyState, lastCommitRequest, acceptedReceipt, settled, quarantineReceipt; JSONArray handles;
        String readyProfile, readyOwner, readySessionHash;
        Throwable failure; boolean injectedCommitFailure, quarantinedJournal, observedWrite, untrustedSubmissionRejected;
        int sweeps; String lastPreparedPlan, unacceptedTx; byte[] unacceptedRaw; boolean unacceptedRejected;

        Fixture(String id, JSONObject rawCorpus, JSONObject rawVector) throws Exception {
            this.id = id; timeShift = System.currentTimeMillis() - rawCorpus.getLong("clockMs");
            corpus = (JSONObject) adapt(rawCorpus, ""); vector = (JSONObject) adapt(rawVector, ""); expected = vector.getJSONObject("expected");
            authority = vector.getString("authority");
            outbox = new NativeOutbox(context, origin); archive = new NativeReconcile(outbox);
            file = new File(context.getNoBackupFilesDir(), "durable_outbox/" + OutboxPolicy.hash(origin) + ".sqlite");
            for (int i = 0; i < vector.getJSONArray("sourceRecords").length(); i++) { JSONObject row = vector.getJSONArray("sourceRecords").getJSONObject(i); sources.put(row.getString("ref"), row); }
            for (int i = 0; i < vector.getJSONArray("responses").length(); i++) { JSONObject r = vector.getJSONArray("responses").getJSONObject(i); responses.put(r.getString("ref"), r); }
        }
        Object adapt(Object value, String field) throws Exception {
            if (value instanceof JSONObject) { JSONObject output = new JSONObject(); Iterator<String> keys = ((JSONObject) value).keys(); while (keys.hasNext()) { String key = keys.next(); output.put(key, adapt(((JSONObject) value).get(key), key)); } return output; }
            if (value instanceof JSONArray) { JSONArray output = new JSONArray(); for (int i = 0; i < ((JSONArray) value).length(); i++) output.put(adapt(((JSONArray) value).get(i), field)); return output; }
            if (value instanceof String) {
                String text = ((String) value).replace("https://native-reconcile.invalid", origin);
                if (field.equals("deltaJSON")) return ((JSONObject) adapt(new JSONObject(text), "")).toString();
                if (field.equals("expires_at")) { long expiry = OutboxPolicy.expiry(text) + timeShift; SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT); iso.setTimeZone(TimeZone.getTimeZone("UTC")); return iso.format(new java.util.Date(expiry)); }
                return text;
            }
            if (value instanceof Number && Arrays.asList("validUntil", "updatedAt", "createdAt", "expiresAt", "lastModified").contains(field)) return ((Number) value).longValue() + timeShift;
            return value;
        }
        JSONObject authority(String name) throws Exception { return corpus.getJSONObject("authorities").getJSONObject(name); }
        JSONObject session(String name) throws Exception { return authority(name).getJSONObject("session"); }
        JSONObject open() throws Exception { return outbox.open(GENERATION, cookie, false, owner); }
        void login(String name) throws Exception {
            authority = name; cookie = authority(name).getString("sessionRef"); outbox.grant(session(name), cookie); JSONObject opened = open(); profile = opened.getString("profileId");
        }
        String key(JSONObject row) throws Exception { return outbox.key(row.get("key")); }
        String rowProfile(JSONObject row) throws Exception {
            JSONObject value = row.getJSONObject("value"); return row.getString("bucket").equals("profiles") ? value.getString("id") : value.getString("profileId");
        }
        String resource(JSONObject row) throws Exception {
            String bucket = row.getString("bucket"); if (bucket.equals("profiles") || bucket.equals("meta")) return null;
            JSONObject value = row.getJSONObject("value"); return bucket.equals("transfers") ? value.getString("scopeId") : bucket.equals("mutations") ? value.getString("resourceKey") : value.getString("key");
        }
        JSONObject delta(List<JSONObject> rows, String mode) throws Exception {
            JSONArray changes = new JSONArray(); for (JSONObject r : rows) changes.put(new JSONObject().put("op", "put").put("bucket", r.getString("bucket")).put("key", r.get("key")).put("value", r.getJSONObject("value")));
            return new JSONObject().put("version", 1).put("origin", origin).put("mode", mode).put("changes", changes);
        }
        JSONObject submit(JSONObject payload, String tx, boolean commit) throws Exception {
            JSONObject opened = open(); byte[] raw = payload.toString().getBytes(StandardCharsets.UTF_8); String digest = OutboxPolicy.hash(raw);
            JSONObject request = new JSONObject().put("generation", GENERATION).put("lease", opened.getString("lease")).put("txId", tx).put("baseHead", opened.getLong("head")).put("proofEpoch", opened.getLong("proofEpoch")).put("digest", digest);
            for (int offset = 0, part = 0; offset < raw.length; offset += OutboxPolicy.PART, part++) {
                byte[] bytes = Arrays.copyOfRange(raw, offset, Math.min(raw.length, offset + OutboxPolicy.PART));
                outbox.stage(new JSONObject(request.toString()).put("part", part).put("bytesBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)), GENERATION);
            }
            journalRequests.put(tx, request); return commit ? outbox.commit(request, GENERATION, cookie, false) : request;
        }
        JSONObject baselineWorkspace(JSONObject s) throws Exception {
            if (vector.has("legacyJournal")) {
                JSONArray changes = new JSONObject(vector.getJSONArray("legacyJournal").getJSONObject(0).getString("deltaJSON")).getJSONArray("changes");
                for (int i = 0; i < changes.length(); i++) { JSONObject change = changes.getJSONObject(i); if (change.optString("bucket").equals("profiles") && change.optJSONObject("value") != null) return copy(change.getJSONObject("value").getJSONObject("workspace")); }
            }
            JSONObject workspace = copy(responses.get("workspace").getJSONObject("body"));
            workspace.put("workspace_id", s.getString("workspace_id")).put("current_member_id", s.getJSONObject("member").getString("id")).put("session_binding", s.getString("cache_binding"));
            for (JSONObject row : sources.values()) if (row.getString("bucket").equals("profiles") && rowProfile(row).equals(OutboxPolicy.profile(origin, s.getString("workspace_id"), s.getJSONObject("member").getString("id"), s.getString("cache_binding")))) return copy(row.getJSONObject("value").getJSONObject("workspace"));
            return workspace;
        }
        JSONObject baselinePage(JSONObject s) throws Exception {
            if (vector.has("legacyJournal")) {
                JSONArray changes = new JSONObject(vector.getJSONArray("legacyJournal").getJSONObject(0).getString("deltaJSON")).getJSONArray("changes");
                for (int i = 0; i < changes.length(); i++) { JSONObject change = changes.getJSONObject(i); if (change.optString("bucket").equals("snapshots") && change.optJSONObject("value") != null && change.getJSONObject("value").getJSONObject("snapshot").getJSONObject("page").optString("id").equals("page")) return copy(change.getJSONObject("value").getJSONObject("snapshot")); }
            }
            JSONObject page = copy(responses.get("page").getJSONObject("body")); page.put("workspace_id", s.getString("workspace_id")).put("current_member_id", s.getJSONObject("member").getString("id")).put("session_binding", s.getString("cache_binding"));
            return page;
        }
        void normalObservation(String path, int status, JSONObject body) throws Exception { outbox.observe("GET", path, status, body.toString().getBytes(StandardCharsets.UTF_8), cookie, false, owner); }
        void sourceProofs(JSONObject s) throws Exception {
            JSONObject workspace = baselineWorkspace(s); normalObservation("/api/workspace", 200, workspace);
            Set<String> local = new HashSet<>(); for (JSONObject row : sources.values()) if (row.getString("bucket").equals("localPages")) local.add(resource(row));
            boolean page = false;
            for (JSONObject row : sources.values()) {
                if (!rowProfile(row).equals(profile)) continue;
                if (row.getString("bucket").equals("snapshots") && !local.contains(resource(row))) { normalObservation("/api/pages/" + OutboxPolicy.encode(row.getJSONObject("value").getJSONObject("snapshot").getJSONObject("page").getString("id")) + "/collaboration", 200, row.getJSONObject("value").getJSONObject("snapshot")); page = true; }
                if (row.getString("bucket").equals("databaseSnapshots")) normalObservation("/api/databases/" + OutboxPolicy.encode(row.getJSONObject("value").getJSONObject("snapshot").getJSONObject("database").getString("id")), 200, row.getJSONObject("value").getJSONObject("snapshot"));
            }
            if (!page && workspace.getJSONArray("pages").length() > 0) normalObservation("/api/pages/page/collaboration", 200, baselinePage(s));
        }
        List<JSONObject> baselineRows(JSONObject s) throws Exception {
            String p = OutboxPolicy.profile(origin, s.getString("workspace_id"), s.getJSONObject("member").getString("id"), s.getString("cache_binding")); JSONObject workspace = baselineWorkspace(s);
            List<JSONObject> rows = new ArrayList<>();
            JSONObject value = new JSONObject().put("id", p).put("origin", origin).put("workspaceId", s.getString("workspace_id")).put("memberId", s.getJSONObject("member").getString("id")).put("cacheBinding", s.getString("cache_binding")).put("session", s).put("workspace", workspace).put("validUntil", OutboxPolicy.expiry(s.getString("expires_at"))).put("updatedAt", System.currentTimeMillis());
            rows.add(new JSONObject().put("bucket", "profiles").put("key", p).put("value", value));
            for (String pointer : Arrays.asList("active", "last-profile")) rows.add(new JSONObject().put("bucket", "meta").put("key", pointer).put("value", new JSONObject().put("id", pointer).put("profileId", p)));
            JSONObject page = baselinePage(s); if (workspace.getJSONArray("pages").length() > 0) rows.add(new JSONObject().put("bucket", "snapshots").put("key", p + "|page").put("value", new JSONObject().put("key", p + "|page").put("profileId", p).put("snapshot", page).put("updatedAt", System.currentTimeMillis())));
            return rows;
        }
        void seed() throws Exception {
            stage = "private-native-source-setup";
            for (String name : strings(expected.getJSONArray("assertions"))) assertTrue("UNIMPLEMENTED assertion: " + name, KNOWN_ASSERTIONS.contains(name));
            JSONObject setup = vector.optJSONObject("privateSetup"); String targetAuthority = vector.getString("authority");
            if (!vector.getString("mode").equals("promote") || setup != null && setup.optString("sourceSetup").equals("via-untrusted-quarantine")) login(setup != null && setup.has("sourceAuthority") ? setup.getString("sourceAuthority") : targetAuthority);
            if (setup != null && setup.optString("sourceSetup").equals("via-untrusted-quarantine")) { sourceProofs(session(authority)); snapshotOriginals(); initialHead = outbox.head(); initialProof = outbox.proofEpoch(); return; }
            boolean journalOnly = setup != null && setup.optString("sourceSetup").equals("accepted-journal-only");
            if (journalOnly) {
                sourceProofs(session(authority)); seedJournal();
                List<JSONObject> legacyCopies = new ArrayList<>(); for (JSONObject row : sources.values()) if (row.getString("storage").equals("upgrade")) legacyCopies.add(row);
                submit(delta(legacyCopies, "quarantine"), "confirmed-legacy-copy-" + UUID.randomUUID(), true);
            } else if (vector.getString("mode").equals("current")) {
                sourceProofs(session(authority));
                List<JSONObject> accepted = new ArrayList<>();
                for (JSONObject row : sources.values()) if (row.getString("storage").equals("active") && rowProfile(row).equals(profile)) accepted.add(row);
                // Ordinary production COMMIT supplies private provenance. If it
                // rejects a supposedly compatible fixture, the test fails here.
                if (!accepted.isEmpty()) submit(delta(accepted, "active"), "seed-" + UUID.randomUUID(), true);
                List<JSONObject> inactive = new ArrayList<>();
                for (JSONObject row : sources.values()) if (Arrays.asList("recovery", "upgrade").contains(row.getString("storage"))) inactive.add(row);
                if (!inactive.isEmpty()) submit(delta(inactive, "quarantine"), "inactive-source-" + UUID.randomUUID(), true);
            } else if (vector.getString("mode").equals("upgrade")) {
                sourceProofs(session(authority)); List<JSONObject> rows = new ArrayList<>(sources.values()); submit(delta(rows, "quarantine"), "legacy-" + UUID.randomUUID(), true);
            } else {
                // Qualify history with a real synthetic native grant and normal
                // production COMMIT, then archive through production code.
                String firstProfile = rowProfile(sources.values().iterator().next()); String[] parts = firstProfile.split("\\|", -1);
                JSONObject prior = copy(session("current")).put("workspace_id", decode(parts[1])).put("cache_binding", decode(parts[3])); prior.getJSONObject("member").put("id", decode(parts[2]));
                cookie = "synthetic-private-historical-cookie"; outbox.grant(prior, cookie); profile = open().getString("profileId"); sourceProofs(prior);
                List<JSONObject> history = baselineRows(prior); history.addAll(sources.values()); submit(delta(history, "active"), "history-" + UUID.randomUUID(), true);
                for (JSONObject row : sources.values()) archive.archiveVersion(rowProfile(row), resource(row), row.getString("bucket"), key(row), active(row), "fixture_native_history");
                login(vector.getString("authority"));
            }
            if (!authority.equals(targetAuthority)) login(targetAuthority);
            if (setup != null && setup.has("unacceptedRefs")) rejectUnaccepted(setup.getJSONArray("unacceptedRefs"));
            if (vector.has("privatePriorObservations")) { JSONArray observations = vector.getJSONArray("privatePriorObservations"); for (int i = 0; i < observations.length(); i++) { JSONObject r = observations.getJSONObject(i); normalObservation(r.getString("path"), r.getInt("status"), r.getJSONObject("body")); } }
            if (!journalOnly) seedJournal(); snapshotOriginals(); installArchiveOrderAssertions(); initialHead = outbox.head(); initialProof = outbox.proofEpoch(); stage = "ready-to-run";
        }
        void rejectUnaccepted(JSONArray refs) throws Exception {
            List<JSONObject> rows = new ArrayList<>(); for (String ref : strings(refs)) rows.add(sources.get(ref));
            JSONObject payload = delta(rows, "active"); unacceptedRaw = payload.toString().getBytes(StandardCharsets.UTF_8); unacceptedTx = "invalid-input-" + UUID.randomUUID();
            long beforeHead = outbox.head(), beforeReceipts = count("tx_receipts");
            try { submit(payload, unacceptedTx, true); fail("Intrinsically invalid input was accepted as private native history"); }
            catch (NativeOutbox.AccessRequired | IllegalArgumentException rejected) { unacceptedRejected = true; }
            assertEquals("Rejected COMMIT advanced data head", beforeHead, outbox.head()); assertEquals("Rejected COMMIT issued a receipt", beforeReceipts, count("tx_receipts"));
            assertArrayEquals("Unaccepted raw input was not durably retained", unacceptedRaw, stagedBytes(unacceptedTx));
            for (JSONObject row : rows) assertNull("Unaccepted input became an active record", active(row));
        }
        byte[] stagedBytes(String tx) throws Exception {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int part = 0;
            try (Cursor c = outbox.db.rawQuery("SELECT part,data FROM staging WHERE tx_id=? ORDER BY part", new String[]{tx})) { while (c.moveToNext()) { assertEquals(part++, c.getInt(0)); bytes.write(c.getBlob(1)); } }
            assertTrue("No durable staging input", part > 0); return bytes.toByteArray();
        }
        boolean isLocalSnapshot(JSONObject row) throws Exception { if (!row.getString("bucket").equals("snapshots")) return false; for (JSONObject candidate : sources.values()) if (candidate.getString("bucket").equals("localPages") && resource(candidate).equals(resource(row))) return true; return false; }
        String decode(String value) throws Exception { return java.net.URLDecoder.decode(value.replace("+", "%2B"), "UTF-8"); }
        void seedJournal() throws Exception {
            if (!vector.has("legacyJournal")) return;
            JSONArray journals = vector.getJSONArray("legacyJournal");
            for (int i = 0; i < journals.length(); i++) {
                JSONObject journal = journals.getJSONObject(i); boolean accepted = vector.getJSONObject("receiptLookup").getBoolean("accepted");
                JSONObject result = submit(new JSONObject(journal.getString("deltaJSON")), journal.getString("txId"), accepted);
                JSONObject request = journalRequests.get(journal.getString("txId"));
                journal.put("baseHead", request.getLong("baseHead")).put("proofEpoch", request.getLong("proofEpoch")).put("lease", request.getString("lease"));
                if (expected.has("settlements")) for (int n = 0; n < expected.getJSONArray("settlements").length(); n++) { JSONObject e = expected.getJSONArray("settlements").getJSONObject(n); e.put("digest", request.getString("digest")); if (e.getString("status").equals("accepted")) e.put("head", result.getLong("head")).put("proofEpoch", request.getLong("proofEpoch")); }
            }
        }
        byte[] active(JSONObject row) throws Exception { return stored("active", row); }
        byte[] stored(String mode, JSONObject row) throws Exception {
            try (Cursor c = outbox.db.rawQuery("SELECT payload FROM records WHERE mode=? AND bucket=? AND key=?", new String[]{mode, row.getString("bucket"), key(row)})) { return c.moveToFirst() ? c.getBlob(0) : null; }
        }
        boolean archived(byte[] bytes) { if (bytes == null) return false; try (Cursor c = outbox.db.rawQuery("SELECT payload FROM recovery", null)) { while (c.moveToNext()) if (Arrays.equals(bytes, c.getBlob(0))) return true; } return false; }
        void snapshotOriginals() throws Exception {
            for (JSONObject row : sources.values()) {
                byte[] raw = stored(row.getString("storage").equals("active") ? "active" : "quarantine", row);
                if (raw == null && !row.getString("storage").equals("active")) raw = row.getJSONObject("value").toString().getBytes(StandardCharsets.UTF_8);
                if (raw != null) originals.put(row.getString("ref"), raw);
            }
        }
        String sqlString(String value) { return "'" + value.replace("'", "''") + "'"; }
        void installArchiveOrderAssertions() throws Exception {
            int n = 0;
            for (String group : Arrays.asList("quarantined", "archived")) for (String ref : strings(expected.getJSONObject("records").getJSONArray(group))) {
                JSONObject row = sources.get(ref); if (!row.getString("storage").equals("active")) continue;
                String condition = "EXISTS(SELECT 1 FROM reconcile_plans) AND OLD.mode='active' AND OLD.bucket=" + sqlString(row.getString("bucket")) + " AND OLD.key=" + sqlString(key(row));
                outbox.db.execSQL("CREATE TEMP TRIGGER vector_archive_order_" + n++ + " BEFORE DELETE ON records WHEN " + condition
                    + " BEGIN SELECT RAISE(ABORT,'vector_archive_must_precede_removal') WHERE NOT EXISTS(SELECT 1 FROM recovery WHERE payload=OLD.payload)"
                    + " AND NOT EXISTS(SELECT 1 FROM records q WHERE q.mode='quarantine' AND q.bucket=OLD.bucket AND q.key=OLD.key AND q.payload=OLD.payload); END");
            }
        }
        JSONObject call(JSONObject input) throws Exception { return outbox.reconcile(input, GENERATION, cookie, false, owner, sequence); }
        JSONObject prepare() throws Exception {
            JSONObject opened = open(), request = new JSONObject().put("generation", GENERATION).put("phase", "prepare").put("lease", opened.getString("lease")).put("baseHead", opened.getLong("head")).put("proofEpoch", opened.getLong("proofEpoch")).put("mode", vector.getString("mode"));
            if (!vector.getString("mode").equals("current")) request.put("handles", handles == null ? new JSONArray() : handles);
            return request;
        }
        JSONObject next() throws Exception { return call(new JSONObject().put("generation", GENERATION).put("phase", "prepare").put("lease", state.getString("lease")).put("planId", state.getString("planId"))); }
        JSONObject commitRequest(boolean confirm) throws Exception {
            assertNotNull("No ready plan exists", state); assertEquals("ready", state.getString("state"));
            if (readyState == null) assertReadyDTO(state);
            else assertEquals("Captured ready DTO changed before COMMIT", outbox.canonical(readyState, false), outbox.canonical(state, false));
            // A deliberately later auth transition must reach the real COMMIT
            // gate. It cannot rebind this immutable ready scope to the new owner.
            readyState = copy(state);
            return new JSONObject().put("generation", GENERATION).put("phase", "commit").put("lease", state.getString("lease")).put("baseHead", state.getLong("baseHead")).put("proofEpoch", state.getLong("proofEpoch")).put("planId", state.getString("planId")).put("checksum", state.getString("checksum")).put("confirm", confirm);
        }
        JSONObject responseFor(JSONObject descriptor, Set<String> permitted) throws Exception {
            String kind = descriptor.getString("kind"), target = descriptor.getString("id");
            String path = kind.equals("workspace") ? "/api/workspace" : kind.equals("page") ? "/api/pages/" + OutboxPolicy.encode(target) + "/collaboration" : kind.equals("database") ? "/api/databases/" + OutboxPolicy.encode(target) : "/api/attachments/" + OutboxPolicy.encode(target) + "/metadata";
            for (JSONObject r : responses.values()) if (r.getString("path").equals(path) && (permitted == null || permitted.contains(r.getString("ref")))) return r;
            return null;
        }
        void observe(JSONObject response, NativeReconcile.Tag tag) throws Exception {
            assertEquals("Response fixture does not match its privately admitted cookie", cookie, response.getString("sessionRef"));
            outbox.beforeReconcileObservation(tag, cookie, false, owner);
            byte[] raw = response.getJSONObject("body").toString().getBytes(StandardCharsets.UTF_8); String method = response.getString("method"), path = response.getString("path");
            if (!method.equals("GET")) observedWrite = true;
            // A captured attachment metadata reply has no page/global envelope.
            if (!path.startsWith("/api/attachments/")) outbox.observe(method, path, response.getInt("status"), raw, cookie, false, owner);
            outbox.captureReconcile(tag, response.getInt("status"), raw, cookie, false, owner);
        }
        void collect(JSONObject event) throws Exception {
            assertNotNull("collect needs prepare", state); Set<String> allowed = event.has("responseRefs") ? new HashSet<>(strings(event.getJSONArray("responseRefs"))) : null;
            state = next(); // Validate owned current scope/source before admitting further requests.
            int sweep = state.optInt("sweep", 1); Set<String> delivered = new HashSet<>();
            for (int iterations = 0; iterations < 1000 && state.getString("state").equals("collecting"); iterations++) {
                JSONArray needed = state.getJSONArray("needed"); boolean progress = false;
                for (int i = 0; i < needed.length(); i++) {
                    JSONObject descriptor = needed.getJSONObject(i), response = responseFor(descriptor, allowed); if (response == null) continue;
                    String unique = state.getInt("sweep") + ":" + response.getString("ref"); if (!delivered.add(unique)) continue;
                    NativeReconcile.Tag tag = outbox.admitReconcile(++sequence, response.getString("method"), response.getString("path"), cookie, false, owner);
                    assertNotNull("A post-prepare expected exact GET was not admitted", tag); observe(response, tag); progress = true;
                }
                if (!progress) return;
                state = next(); if (state.getString("state").equals("ready")) { assertReadyDTO(state); readyState = copy(state); } sweeps = Math.max(sweeps, state.optInt("sweep", sweep));
                // A change_sweep event supplies the next actual fixture replies;
                // never consume a second sweep using stale first-sweep bytes.
                if (state.optInt("sweep", sweep) != sweep) return;
            }
            assertFalse("Unbounded collector loop", state.getString("state").equals("collecting") && delivered.size() >= 1000);
        }
        void selectHandles() throws Exception {
            open(); handles = new JSONArray(); Set<String> selectedProfiles = new HashSet<>();
            for (String ref : strings(vector.getJSONArray("selectedSources"))) selectedProfiles.add(rowProfile(sources.get(ref)));
            // Select genuine handles produced by open; inspect private fixture DB
            // only to choose the source mode. Never insert a forged handle.
            for (String source : selectedProfiles) try (Cursor c = outbox.db.rawQuery("SELECT id FROM reconcile_handles WHERE profile_id=? AND source_profile=? AND source_mode=? ORDER BY id", new String[]{profile, source, vector.getString("mode").equals("upgrade") ? "quarantine" : "archive"})) { while (c.moveToNext()) handles.put(c.getString(0)); }
            assertTrue("No qualified native handle for selected source", handles.length() > 0);
        }
        void expire() throws Exception {
            outbox.db.execSQL("UPDATE reconcile_handles SET expires_at=?", new Object[]{System.currentTimeMillis() - 1});
            try (Cursor c = outbox.db.rawQuery("SELECT id,metadata FROM reconcile_plans", null)) { if (c.moveToFirst()) { JSONObject p = new JSONObject(c.getString(1)).put("expiresAt", System.currentTimeMillis() - 1); outbox.db.execSQL("UPDATE reconcile_plans SET metadata=? WHERE id=?", new Object[]{p.toString(), c.getString(0)}); } }
        }
        void events() throws Exception {
            JSONArray events = vector.getJSONArray("events");
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.getJSONObject(i); String type = event.getString("type"); stage = "event-" + i + "-" + type;
                switch (type) {
                case "prepare": state = call(prepare()); lastPreparedPlan = state.getString("planId"); break;
                case "collect": collect(event); break;
                case "select_handle": selectHandles(); break;
                case "commit": lastCommitRequest = commitRequest(event.getBoolean("confirm")); acceptedReceipt = call(lastCommitRequest); state = acceptedReceipt; break;
                case "drop_commit_reply": lastCommitRequest = commitRequest(expected.getBoolean("requiresConfirmation")); acceptedReceipt = call(lastCommitRequest); state = acceptedReceipt; break;
                case "retry_commit": assertNotNull(lastCommitRequest); JSONObject replay = call(lastCommitRequest); assertEquals("Exact retry changed accepted receipt", outbox.canonical(acceptedReceipt, false), outbox.canonical(replay, false)); state = replay; break;
                case "cancel": case "retry_cancel": state = call(new JSONObject().put("generation", GENERATION).put("phase", "cancel").put("planId", lastPreparedPlan)); break;
                case "mutate_source": JSONObject row = sources.get(event.getString("ref")); JSONObject changed = copy(row.getJSONObject("value")); changed.put("updatedAt", changed.optLong("updatedAt") + 1); outbox.db.execSQL("UPDATE records SET payload=? WHERE mode='active' AND bucket=? AND key=?", new Object[]{changed.toString().getBytes(StandardCharsets.UTF_8), row.getString("bucket"), key(row)}); originals.put(row.getString("ref"), active(row)); break;
                case "auth_change": authChanged = true; login(event.getString("authority")); break;
                case "advance_clock": assertTrue(event.getLong("milliseconds") > corpus.getLong("planTTLms")); expire(); break;
                case "fail_commit": injectedCommitFailure = true; outbox.db.execSQL("CREATE TEMP TRIGGER vector_commit_failure BEFORE INSERT ON reconcile_receipts BEGIN SELECT RAISE(ABORT,'vector_commit_failure'); END"); break;
                case "observe_after_ready": observe(responses.get(event.getString("response")), null); break;
                case "admit_http": JSONObject pending = responses.get(event.getString("response")); admitted.put(event.getString("response"), outbox.admitReconcile(++sequence, pending.getString("method"), pending.getString("path"), cookie, false, owner)); proofBeforeLate = outbox.proofEpoch(); break;
                case "deliver_http": observe(responses.get(event.getString("response")), admitted.get(event.getString("response"))); break;
                case "change_sweep": responses.get(event.getString("response")).getJSONObject("body").put("data_revision", event.getLong("dataRevision")); break;
                case "collide_archive":
                    JSONObject collision = sources.get(event.getString("ref")), changedVersion = copy(collision); changedVersion.getJSONObject("value").put("updatedAt", collision.getJSONObject("value").optLong("updatedAt") - 1);
                    submit(delta(Arrays.asList(changedVersion), "active"), "version-first-" + UUID.randomUUID(), true);
                    byte[] raw = active(changedVersion); archive.archiveVersion(rowProfile(collision), resource(collision), collision.getString("bucket"), key(collision), raw, "fixture_preexisting_version"); collisionOriginals.add(raw);
                    submit(delta(Arrays.asList(collision), "active"), "version-second-" + UUID.randomUUID(), true); initialHead = outbox.head(); break;
                case "settle": settle(event); break;
                case "late_legacy_commit": JSONObject old = journalRequests.get(event.getString("txId")); assertNotNull(old); try { outbox.commit(old, GENERATION, cookie, false); fail("Unaccepted settled transaction was replayed"); } catch (NativeReconcile.Failure error) { assertEquals("OUTBOX_RECONCILE_CANCELLED", error.code); } break;
                case "quarantine_journal": throw new UnsupportedOperationException("UNIMPLEMENTED_JS_EXECUTION: run production JS before-image transformation, not a Java mirror");
                case "delete_checkpoint": assertNotNull("Journal removal requires accepted quarantine receipt", quarantineReceipt); quarantinedJournal = true; break;
                case "stage_untrusted_quarantine": try { submit(delta(new ArrayList<>(sources.values()), "quarantine"), "spoof-" + UUID.randomUUID(), true); } catch (NativeOutbox.AccessRequired | IllegalArgumentException rejected) { untrustedSubmissionRejected = true; } snapshotOriginals(); break;
                case "assert_no_source_handles": assertEquals("JS source profile qualified as historical native actor", 0, open().getJSONArray("reconciliationHandles").length()); break;
                default: throw new UnsupportedOperationException("UNIMPLEMENTED event " + type);
                }
            }
        }
        void settle(JSONObject event) throws Exception {
            JSONArray journals = new JSONArray(); JSONArray inputs = event.getJSONArray("journals");
            for (int i = 0; i < inputs.length(); i++) { JSONObject request = journalRequests.get(inputs.getJSONObject(i).getString("txId")); assertNotNull("No production-staged journal", request); journals.put(new JSONObject().put("txId", request.getString("txId")).put("digest", request.getString("digest")).put("baseHead", request.getLong("baseHead")).put("proofEpoch", request.getLong("proofEpoch"))); }
            state = settled = call(new JSONObject().put("generation", GENERATION).put("phase", "settle").put("lease", open().getString("lease")).put("journals", journals));
        }
        boolean expectedFailure(Throwable error) throws Exception {
            if (!Arrays.asList("rejected", "retryable", "confirmation_required").contains(expected.getString("result"))) return false;
            if (error instanceof AssertionError || error instanceof UnsupportedOperationException) return false;
            if (injectedCommitFailure && error instanceof SQLiteException && error.getMessage() != null && error.getMessage().contains("vector_commit_failure")) return true;
            // Empty handle selection is a malformed input, not evidence of an
            // internal JSON/SQLite exception. No other IllegalArgument is masked.
            if (error instanceof IllegalArgumentException && stage.endsWith("-prepare") && !vector.getString("mode").equals("current") && (handles == null || handles.length() == 0)) return true;
            return error instanceof NativeReconcile.Failure || error instanceof NativeOutbox.AccessRequired;
        }
        long count(String table) { try (Cursor c = outbox.db.rawQuery("SELECT count(*) FROM " + table, null)) { assertTrue(c.moveToFirst()); return c.getLong(0); } }
        JSONObject activeValue(JSONObject row) throws Exception { byte[] value = active(row); return value == null ? null : new JSONObject(new String(value, StandardCharsets.UTF_8)); }
        void assertArchive(JSONObject row) throws Exception {
            byte[] original = originals.get(row.getString("ref")); assertNotNull("Missing original " + row.getString("ref"), original);
            byte[] quarantined = stored("quarantine", row); assertTrue("Original not preserved " + row.getString("ref"), Arrays.equals(original, quarantined) || archived(original));
        }
        String safeCounts(JSONObject counts) throws Exception {
            JSONObject safe = new JSONObject(); for (String name : Arrays.asList("refresh", "keep", "acknowledge", "quarantine", "import")) {
                Object raw = counts.opt(name); if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).longValue() || ((Number) raw).longValue() < 0 || ((Number) raw).longValue() > 100000) safe.put(name, "invalid"); else safe.put(name, ((Number) raw).longValue());
            }
            return safe.toString();
        }
        void exactKeys(JSONObject value, String... names) {
            Set<String> keys = new HashSet<>(); Iterator<String> iterator = value.keys(); while (iterator.hasNext()) keys.add(iterator.next());
            assertEquals("Unexpected/missing DTO fields", new HashSet<>(Arrays.asList(names)), keys);
        }
        long dtoInteger(JSONObject value, String name, long minimum, long maximum) throws Exception {
            Object raw = value.get(name); assertTrue("DTO integer required: " + name, raw instanceof Number);
            double number = ((Number) raw).doubleValue(); long integer = ((Number) raw).longValue();
            assertTrue("DTO integer outside logical bounds: " + name, Double.isFinite(number) && number == integer && integer >= minimum && integer <= maximum); return integer;
        }
        void assertCountsDTO(JSONObject counts) throws Exception {
            exactKeys(counts, "refresh", "keep", "acknowledge", "quarantine", "import");
            for (String name : Arrays.asList("refresh", "keep", "acknowledge", "quarantine", "import")) dtoInteger(counts, name, 0, 100000);
        }
        void assertReadyDTO(JSONObject ready) throws Exception {
            exactKeys(ready, "generation", "state", "planId", "lease", "expiresAt", "baseHead", "proofEpoch", "checksum", "counts", "reasons", "requiresConfirmation");
            assertEquals(GENERATION, dtoInteger(ready, "generation", 0, OutboxPolicy.SAFE - 1)); assertEquals("ready", ready.get("state"));
            assertTrue(ready.get("planId") instanceof String && ready.getString("planId").matches("[A-Za-z0-9_.:-]{1,160}"));
            assertEquals(lastPreparedPlan, ready.getString("planId")); assertEquals(outbox.get("lease"), ready.get("lease"));
            assertTrue(ready.get("lease") instanceof String && ready.getString("lease").length() <= 1000);
            assertTrue(ready.get("checksum") instanceof String && ready.getString("checksum").matches("[0-9a-f]{64}"));
            assertEquals(outbox.head(), dtoInteger(ready, "baseHead", 0, OutboxPolicy.SAFE - 1));
            assertEquals(outbox.proofEpoch(), dtoInteger(ready, "proofEpoch", 0, OutboxPolicy.SAFE - 1));
            long expires = dtoInteger(ready, "expiresAt", 1, OutboxPolicy.SAFE), now = System.currentTimeMillis();
            assertTrue("Ready capability expired or exceeded two-minute TTL", expires > now && expires <= now + 120000);
            JSONObject grant = outbox.verified(cookie, false); assertNotNull(grant); assertTrue(expires <= grant.getLong("validUntil"));
            JSONObject counts = ready.getJSONObject("counts"); assertCountsDTO(counts);
            assertTrue(ready.get("requiresConfirmation") instanceof Boolean);
            assertEquals(!vector.getString("mode").equals("current") || counts.getLong("quarantine") > 0, ready.getBoolean("requiresConfirmation"));
            JSONArray reasons = ready.getJSONArray("reasons"); List<String> codes = strings(reasons), sorted = new ArrayList<>(codes); java.util.Collections.sort(sorted);
            assertEquals(sorted, codes); assertEquals(new HashSet<>(codes).size(), codes.size());
            for (int i = 0; i < reasons.length(); i++) assertTrue(reasons.get(i) instanceof String && SAFE_REASONS.contains(reasons.getString(i)));
            readyProfile = profile; readyOwner = owner; readySessionHash = OutboxPolicy.hash(cookie);
        }
        void assertCommittedDTO(JSONObject committed) throws Exception {
            assertNotNull("Committed result needs its actual ready summary", readyState);
            exactKeys(committed, "generation", "state", "planId", "lease", "head", "proofEpoch", "checksum", "receipt");
            assertEquals(GENERATION, dtoInteger(committed, "generation", 0, OutboxPolicy.SAFE - 1)); assertEquals("committed", committed.get("state"));
            for (String field : Arrays.asList("planId", "lease", "checksum")) assertEquals(readyState.get(field), committed.get(field));
            long source = readyState.getLong("baseHead"), head = dtoInteger(committed, "head", 1, OutboxPolicy.SAFE);
            assertEquals(source + 1, head);
            assertEquals(readyState.getLong("proofEpoch"), dtoInteger(committed, "proofEpoch", 0, OutboxPolicy.SAFE - 1));
            JSONObject receipt = committed.getJSONObject("receipt"); exactKeys(receipt, "version", "planId", "checksum", "sourceHead", "targetHead", "mode", "counts");
            assertEquals(1, dtoInteger(receipt, "version", 1, 1)); assertEquals(source, dtoInteger(receipt, "sourceHead", 0, OutboxPolicy.SAFE - 1)); assertEquals(head, dtoInteger(receipt, "targetHead", 1, OutboxPolicy.SAFE));
            assertEquals(vector.getString("mode"), receipt.get("mode"));
            for (String field : Arrays.asList("planId", "checksum")) assertEquals(readyState.get(field), receipt.get(field));
            assertCountsDTO(receipt.getJSONObject("counts")); assertEquals(outbox.canonical(readyState.getJSONObject("counts"), false), outbox.canonical(receipt.getJSONObject("counts"), false));
            try (Cursor c = outbox.db.rawQuery("SELECT profile_id,owner,session_ref,lease,checksum,payload FROM reconcile_receipts WHERE id=?", new String[]{committed.getString("planId")})) {
                assertTrue("Returned receipt was not durably stored", c.moveToFirst()); assertNotNull(readyProfile); assertNotNull(readyOwner); assertNotNull(readySessionHash);
                assertEquals(readyProfile, c.getString(0)); assertEquals(readyOwner, c.getString(1)); assertEquals(readySessionHash, c.getString(2));
                assertEquals(committed.getString("lease"), c.getString(3)); assertEquals(committed.getString("checksum"), c.getString(4));
                assertEquals("Stored receipt differs from returned exact DTO", outbox.canonical(committed, false), outbox.canonical(new JSONObject(c.getString(5)), false)); assertFalse(c.moveToNext());
            }
        }
        void verify() throws Exception {
            stage = "verify"; String result = expected.getString("result");
            if (Arrays.asList("rejected", "retryable", "confirmation_required").contains(result)) assertNotNull("Expected typed native failure but API completed", failure);
            else { assertNull(failure); assertNotNull(state); assertEquals(result, state.getString("state")); }
            if (acceptedReceipt != null) assertCommittedDTO(acceptedReceipt);
            if (expected.has("counts") && !expected.isNull("counts")) {
                assertNotNull(acceptedReceipt); JSONObject actual = acceptedReceipt.getJSONObject("receipt").getJSONObject("counts"); assertEquals("Logical record summary differs", outbox.canonical(expected.getJSONObject("counts"), false), outbox.canonical(actual, false));
                assertEquals("Exactly one accepted reconciliation receipt", 1, count("reconcile_receipts"));
                assertEquals(acceptedReceipt.getJSONObject("receipt").getLong("sourceHead") + 1, acceptedReceipt.getLong("head"));
            }
            if (readyState != null) {
                assertEquals("Confirmation summary drift", expected.getBoolean("requiresConfirmation"), readyState.getBoolean("requiresConfirmation"));
                List<String> actualReasons = strings(readyState.getJSONArray("reasons")); assertEquals("Duplicate reason code", actualReasons.size(), new HashSet<>(actualReasons).size());
                List<String> sorted = new ArrayList<>(actualReasons); java.util.Collections.sort(sorted); assertEquals(sorted, actualReasons);
                for (String reason : actualReasons) assertTrue("Native reason outside the fixed public enum", SAFE_REASONS.contains(reason));
                assertTrue("Required cause omitted id=" + id + " expected=" + expected.getJSONArray("requiredReasons") + " actual=" + actualReasons + " counts=" + safeCounts(readyState.getJSONObject("counts")), actualReasons.containsAll(strings(expected.getJSONArray("requiredReasons"))));
            }
            JSONObject groups = expected.getJSONObject("records");
            for (String group : Arrays.asList("kept", "acknowledged", "quarantined", "archived", "replaced", "unchanged", "opaque", "safetyChanged")) for (String ref : strings(groups.getJSONArray(group))) {
                JSONObject row = sources.get(ref); assertNotNull(row); byte[] prior = originals.get(ref);
                switch (group) {
                case "kept": assertArrayEquals("Kept source bytes changed: " + ref, prior, active(row)); break;
                case "acknowledged": assertNull("ACKed operation remained active", active(row)); JSONObject canonical = currentSnapshot(resource(row)); assertEquals(row.getJSONObject("value").getJSONObject("operation").getString("_epoch"), canonical.getString("epoch")); assertTrue(canonical.getJSONObject("state").getJSONObject("seen").has(row.getJSONObject("value").getString("id"))); break;
                case "quarantined": assertNull("Rejected closure remained active: " + ref, active(row)); assertArchive(row); break;
                case "archived": assertArchive(row); break;
                case "replaced": assertNotNull("Canonical baseline missing: " + ref, active(row)); if (row.getString("bucket").equals("snapshots") || row.getString("bucket").equals("databaseSnapshots")) { JSONObject snapshot = activeValue(row).getJSONObject("snapshot"); JSONObject response = canonicalFor(resource(row)); assertNotNull(response); assertEquals("Installed snapshot differs from actual collected bytes", outbox.canonical(response, false), outbox.canonical(snapshot, false)); } break;
                case "unchanged": if (row.getString("storage").equals("active")) assertArrayEquals("Unexpected source change: " + ref, prior, active(row)); else assertArchive(row); break;
                case "opaque": if (row.getString("storage").equals("unaccepted")) { assertArrayEquals(unacceptedRaw, stagedBytes(unacceptedTx)); assertNull("Unaccepted input became active", active(row)); break; } if (!untrustedSubmissionRejected) { byte[] raw = stored(row.getString("storage").equals("active") ? "active" : "quarantine", row); assertTrue("Opaque original lost", Arrays.equals(prior, raw) || archived(prior)); } assertFalse("Foreign resource exposed in ready summary", state != null && state.optJSONArray("needed") != null && neededContainsPrivate(state.getJSONArray("needed"), row)); break;
                case "safetyChanged": assertTrue("Safety-only disposition requires real denial", hasDenial()); break;
                default: throw new UnsupportedOperationException("UNIMPLEMENTED disposition " + group);
                }
            }
            if (expected.has("settlements") && result.equals("settled")) assertEquals(outbox.canonical(expected.getJSONArray("settlements"), false), outbox.canonical(settled.getJSONArray("settlements"), false));
            for (String assertion : strings(expected.getJSONArray("assertions"))) verifyAssertion(assertion);
            freshIdentities();
            try (Cursor c = outbox.db.rawQuery("PRAGMA integrity_check", null)) { assertTrue(c.moveToFirst()); assertEquals("ok", c.getString(0)); }
        }
        boolean hasDenial() throws Exception { for (JSONObject r : responses.values()) if (r.getInt("status") == 403 || r.getInt("status") == 404) return true; return false; }
        boolean neededContainsPrivate(JSONArray needed, JSONObject row) throws Exception { String resource = resource(row); if (resource == null) return false; for (int i = 0; i < needed.length(); i++) if (resource.endsWith("|" + OutboxPolicy.encode(needed.getJSONObject(i).getString("id")))) return true; return false; }
        JSONObject canonicalFor(String resource) throws Exception { String id = decode(resource.substring(resource.lastIndexOf('|') + 1)); for (JSONObject response : responses.values()) { JSONObject body = response.getJSONObject("body"); if (body.optJSONObject("page") != null && id.equals(body.getJSONObject("page").optString("id")) || body.optJSONObject("database") != null && id.equals(body.getJSONObject("database").optString("id"))) return body; } return null; }
        JSONObject currentSnapshot(String resource) throws Exception { try (Cursor c = outbox.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='snapshots' AND resource_key=?", new String[]{resource})) { assertTrue(c.moveToFirst()); return new JSONObject(new String(c.getBlob(0), StandardCharsets.UTF_8)).getJSONObject("snapshot"); } }
        void verifyAssertion(String assertion) throws Exception {
            switch (assertion) {
            case "accepted_identity_preserved":
                assertFalse(vector.getJSONObject("privateSetup").getJSONArray("confirmedMirrors").length() == 0);
                for (int i = 0; i < vector.getJSONObject("privateSetup").getJSONArray("confirmedMirrors").length(); i++) { JSONObject pair = vector.getJSONObject("privateSetup").getJSONArray("confirmedMirrors").getJSONObject(i); JSONObject row = sources.get(pair.getString("active")); assertArrayEquals("Accepted native identity/body/base/dependencies were changed", originals.get(pair.getString("active")), active(row)); }
                break;
            case "no_fresh_reimport":
                assertNotNull(acceptedReceipt); assertEquals(0, acceptedReceipt.getJSONObject("receipt").getJSONObject("counts").getInt("import"));
                long actualInputs; try (Cursor c = outbox.db.rawQuery("SELECT count(*) FROM records WHERE mode='active' AND profile_id=? AND bucket IN ('operations','drafts','mutations','localPages','transfers')", new String[]{profile})) { assertTrue(c.moveToFirst()); actualInputs = c.getLong(0); }
                assertEquals("An accepted intent produced duplicate fresh input", expected.getJSONObject("counts").getLong("keep"), actualInputs); break;
            case "unaccepted_submit_rejected": assertTrue(unacceptedRejected); break;
            case "staging_bytes_preserved": assertArrayEquals(unacceptedRaw, stagedBytes(unacceptedTx)); break;
            case "unaccepted_input_not_qualified": for (String ref : strings(vector.getJSONObject("privateSetup").getJSONArray("unacceptedRefs"))) { JSONObject row = sources.get(ref); try (Cursor c = outbox.db.rawQuery("SELECT 1 FROM native_record_owners WHERE mode='active' AND bucket=? AND key=?", new String[]{row.getString("bucket"), key(row)})) { assertFalse("Unaccepted input received a private qualification", c.moveToFirst()); } } break;
            case "same_floor_equivocation_rejected": assertTrue(failure instanceof NativeOutbox.AccessRequired); assertEquals(initialProof, outbox.proofEpoch()); break;
            case "input_bytes_preserved": case "source_bytes_unchanged": case "external_source_change_preserved": case "archive_bytes_preserved": case "archive_before_remove": break; // Exact record dispositions above check every original, not a mirrored engine.
            case "same_transaction_seen_only": if (acceptedReceipt != null) assertEquals(1, count("reconcile_receipts")); break;
            case "canonical_installed_atomically": assertNotNull(acceptedReceipt); assertEquals(acceptedReceipt.getLong("head"), outbox.head()); break;
            case "no_network_replay": case "no_upload_auto_resume": assertFalse("Fixture unexpectedly submitted an HTTP write", observedWrite); break;
            case "one_transform": case "immutable_receipt": if (acceptedReceipt != null) { assertEquals(1, count("reconcile_receipts")); assertEquals(acceptedReceipt.getLong("head"), outbox.head()); } else assertNotNull(settled); break;
            case "exact_retry_current_owner": assertNotNull(outbox.verified(cookie, false)); break;
            case "complete_dependency_closure": if (acceptedReceipt != null) new NativeLocalGraph(outbox, outbox.verified(cookie, false)); break;
            case "no_hidden_body_delivery": case "cross_actor_no_descriptors_counts": case "untrusted_profile_does_not_qualify_history": assertPublicSummary(); if (!expected.getJSONObject("records").getJSONArray("opaque").toString().equals("[]")) assertEquals(0, open().getJSONArray("reconciliationHandles").length()); break;
            case "native_role_only": if (acceptedReceipt != null) assertEquals(session(authority).getJSONObject("member").getString("role"), new JSONObject(outbox.get("grant")).getString("role")); break;
            case "no_partial_active_replace": if (acceptedReceipt == null) { assertEquals(0, count("reconcile_receipts")); if (!hasDenial() && !authChanged) assertEquals(initialHead, outbox.head()); } break;
            case "native_admission_only": assertTrue("Admission fixture must retain a null pre-plan tag", admitted.containsValue(null)); break;
            case "stable_unowned_proof_unchanged": assertEquals(proofBeforeLate, outbox.proofEpoch()); break;
            case "unowned_proof_change_invalidates": assertTrue(outbox.proofEpoch() > proofBeforeLate); assertEquals(0, count("reconcile_plans")); break;
            case "no_fabricated_denial": assertEquals(0, count("tombstones")); break;
            case "denial_survives_cancel": long deniedCount = count("tombstones"); assertTrue(deniedCount > 0); call(new JSONObject().put("generation", GENERATION).put("phase", "cancel").put("planId", lastPreparedPlan)); assertEquals("Cancel undid normal denial safety", deniedCount, count("tombstones")); break;
            case "fresh_private_acl": case "no_old_owner_session_receipts": case "no_old_crdt_identity_replay": if (acceptedReceipt != null) assertFreshAuthority(); break;
            case "explicit_confirmation": assertTrue(expected.getBoolean("requiresConfirmation")); if (lastCommitRequest != null && acceptedReceipt != null) assertTrue(lastCommitRequest.getBoolean("confirm")); break;
            case "archive_collision_no_overwrite": for (byte[] bytes : collisionOriginals) assertTrue("Earlier archive version overwritten", archived(bytes)); break;
            case "both_archives_exportable": case "export_requires_current_resource_proof": verifyRecoveryExport(); break;
            case "two_sweeps_max": assertTrue(sweeps <= 2); break;
            case "late_legacy_commit_fenced": assertNotNull(settled); break;
            case "no_old_delete_replay": case "missing_before_image_blocks": if (expected.getString("result").equals("rejected")) assertNotNull(failure); assertEquals(0, count("reconcile_receipts")); break;
            case "attachment_metadata_native_proof": assertTrue(responses.containsKey("attachment")); if (acceptedReceipt != null) assertTrue(responses.get("attachment").getInt("status") == 200); break;
            case "journal_before_image_puts_only": if (quarantineReceipt != null) for (int i = 0; i < expected.getJSONArray("journalRecoveryPuts").length(); i++) { JSONObject put = expected.getJSONArray("journalRecoveryPuts").getJSONObject(i); JSONObject row = new JSONObject().put("bucket", put.get("bucket")).put("key", put.get("key")).put("value", put.get("value")); assertArrayEquals(put.getJSONObject("value").toString().getBytes(StandardCharsets.UTF_8), stored("quarantine", row)); } break;
            case "checkpoint_after_quarantine_receipt": assertEquals(quarantineReceipt != null, quarantinedJournal); break;
            default: throw new UnsupportedOperationException("UNIMPLEMENTED assertion " + assertion);
            }
        }
        void assertPublicSummary() throws Exception {
            if (state == null) return; assertFalse(state.has("sourceRecords")); assertFalse(state.has("snapshot")); assertFalse(state.has("sessionRef")); assertFalse(state.has("body")); assertFalse(state.has("digest"));
            if (state.optJSONArray("reasons") != null) for (String reason : strings(state.getJSONArray("reasons"))) assertTrue(reason.matches("[a-z_]+"));
        }
        void assertFreshAuthority() throws Exception {
            String actor = session(authority).getJSONObject("member").getString("id");
            JSONObject privateACL = new JSONObject().put("default", "private").put("inherit", false).put("members", new JSONObject()).put("groups", new JSONObject());
            try (Cursor c = outbox.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND profile_id=? AND bucket='mutations'", new String[]{profile})) {
                while (c.moveToNext()) {
                    JSONObject mutation = new JSONObject(new String(c.getBlob(0), StandardCharsets.UTF_8)), operation = mutation.getJSONObject("operation");
                    if (!operation.optString("kind").equals("page.create")) continue;
                    JSONObject body = operation.getJSONObject("body"); String target = operation.getString("target_id"), resource = profile + "|" + OutboxPolicy.encode(target), epoch = operation.getString("document_epoch");
                    assertEquals("Fresh create body retained historical permissions", outbox.canonical(privateACL, false), outbox.canonical(body.getJSONObject("permissions"), false));
                    assertFalse("page.create must not send owner authority forbidden by the backend", body.has("owner_id")); assertEquals(target, body.getString("id"));
                    assertEquals(profile, mutation.getString("profileId")); assertEquals(resource, mutation.getString("resourceKey"));
                    JSONObject metadataRecord = activeRecord("localPages", resource), snapshotRecord = activeRecord("snapshots", resource);
                    JSONObject metadata = metadataRecord.getJSONObject("metadata"), page = metadata.getJSONObject("page"), snapshot = snapshotRecord.getJSONObject("snapshot"), snapshotPage = snapshot.getJSONObject("page");
                    for (JSONObject projection : Arrays.asList(page, snapshotPage)) {
                        assertEquals(target, projection.getString("id")); assertEquals("Imported projection retained historical owner", actor, projection.getString("owner_id"));
                        assertEquals("Imported projection retained historical permissions", outbox.canonical(privateACL, false), outbox.canonical(projection.getJSONObject("permissions"), false));
                    }
                    assertEquals(operation.getString("id"), metadata.getString("create_operation_id")); assertEquals(epoch, metadata.getString("initial_epoch")); assertEquals(epoch, snapshot.getString("epoch"));
                    assertEquals(session(authority).getString("workspace_id"), snapshot.getString("workspace_id")); assertEquals(actor, snapshot.getString("current_member_id")); assertEquals(session(authority).getString("cache_binding"), snapshot.getString("session_binding"));
                }
            }
            Set<String> oldIds = new HashSet<>(); for (JSONObject source : sources.values()) if (source.getString("bucket").equals("operations")) oldIds.add(source.getJSONObject("value").getString("id"));
            try (Cursor c = outbox.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND profile_id=? AND bucket='operations'", new String[]{profile})) { while (c.moveToNext()) assertFalse("Old CRDT identity was reactivated", oldIds.contains(new JSONObject(new String(c.getBlob(0), StandardCharsets.UTF_8)).getString("id"))); }
        }
        JSONObject activeRecord(String bucket, String resource) throws Exception {
            try (Cursor c = outbox.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND profile_id=? AND bucket=? AND resource_key=?", new String[]{profile, bucket, resource})) {
                assertTrue("Fresh linked projection missing: " + bucket, c.moveToFirst()); JSONObject value = new JSONObject(new String(c.getBlob(0), StandardCharsets.UTF_8));
                assertEquals(profile, value.getString("profileId")); assertEquals(resource, value.getString("key")); assertFalse("Ambiguous linked projection: " + bucket, c.moveToNext()); return value;
            }
        }
        void freshIdentities() throws Exception {
            if (acceptedReceipt == null || expected.getJSONArray("fresh").length() == 0) return;
            Map<String, String> epochs = new HashMap<>(), targets = new HashMap<>();
            for (int i = 0; i < expected.getJSONArray("fresh").length(); i++) {
                JSONObject condition = expected.getJSONArray("fresh").getJSONObject(i), source = sources.get(condition.getString("source")), old = source.getJSONObject("value").getJSONObject("operation");
                JSONObject candidate = null;
                try (Cursor c = outbox.db.rawQuery("SELECT payload FROM records WHERE mode='active' AND profile_id=? AND bucket=?", new String[]{profile, source.getString("bucket")})) { while (c.moveToNext()) { JSONObject op = new JSONObject(new String(c.getBlob(0), StandardCharsets.UTF_8)).getJSONObject("operation"); if (old.has("kind") ? old.getString("kind").equals(op.optString("kind")) : old.getString("type").equals(op.optString("type"))) { assertNull("Ambiguous fresh identity mapping", candidate); candidate = op; } } }
                assertNotNull("No freshly remapped operation", candidate);
                for (String field : strings(condition.getJSONArray("fields"))) { String name = field.substring("operation.".length()); assertTrue(candidate.has(name)); assertNotEquals("Old identity reused", old.get(name), candidate.get(name)); }
                if (old.has("document_epoch")) { epochs.put(old.getString("document_epoch"), candidate.getString("document_epoch")); targets.put(old.getString("target_id"), candidate.getString("target_id")); }
                if (old.has("_epoch")) assertEquals("CRDT/document remap disagrees", epochs.get(old.getString("_epoch")), candidate.getString("_epoch"));
            }
            new NativeLocalGraph(outbox, outbox.verified(cookie, false));
        }
        void verifyRecoveryExport() throws Exception {
            if (collisionOriginals.isEmpty()) throw new UnsupportedOperationException("UNIMPLEMENTED archive export fixture without collision source");
            try (NativeRecovery recovery = new NativeRecovery(context)) {
                recovery.refresh(new NativeRecovery.Session(origin, session(authority), cookie, owner));
                NativeRecovery.Authority gate = new NativeRecovery.Authority() {
                    public void check() throws Exception { if (outbox.verified(cookie, false) == null || !owner.equals(outbox.get("owner"))) throw new NativeRecovery.Failure("RECOVERY_AUTH_REQUIRED"); }
                    public JSONObject get(String path) throws Exception { check(); for (JSONObject r : responses.values()) if (r.getString("path").equals(path)) { if (r.getInt("status") != 200) throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED"); return copy(r.getJSONObject("body")); } throw new NativeRecovery.Failure("RECOVERY_ACCESS_REQUIRED"); }
                };
                JSONObject inventory = recovery.inventory(null, 100, GENERATION, gate); JSONArray selected = new JSONArray(), items = inventory.getJSONArray("items"); for (int i = 0; i < items.length(); i++) selected.put(items.getJSONObject(i).getString("handle"));
                assertTrue("Native archive not discoverable for current actor", selected.length() > 0);
                JSONObject prepared = recovery.prepare(inventory.getString("inventoryToken"), selected, GENERATION, gate); assertTrue("Preserved versions not exportable", prepared.getInt("readyCount") >= 2);
                NativeRecovery.Prepared result = recovery.saving(inventory.getString("inventoryToken"), prepared.getString("exportToken"), selected, gate); assertFalse(result.files.isEmpty()); for (File saved : result.files) assertTrue(saved.length() > 0); recovery.finished(result);
            }
        }
        @Override public void close() {
            try { outbox.close(); } finally { if (file.exists()) assertTrue("Isolated test database cleanup failed", file.delete()); new File(file.getPath() + "-journal").delete(); }
        }
    }
}
