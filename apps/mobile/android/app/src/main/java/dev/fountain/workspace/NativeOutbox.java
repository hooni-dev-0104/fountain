package dev.fountain.workspace;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.Iterator;
import java.util.TreeSet;
import org.json.JSONArray;
import org.json.JSONObject;

/** App-private, per-origin SQL outbox. All calls run on the plugin's single session executor.
 * DELETE journal + EXTRA deliberately avoids Android's WAL connection-pool pragma trap.
 */
final class NativeOutbox implements AutoCloseable {
    static final String[] SCHEMA = {
        "CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS records (mode TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,profile_id TEXT NOT NULL,resource_key TEXT,payload BLOB NOT NULL,PRIMARY KEY(mode,bucket,key))",
        "CREATE INDEX IF NOT EXISTS records_profile ON records(profile_id)",
        "CREATE INDEX IF NOT EXISTS records_resource ON records(resource_key)",
        "CREATE TABLE IF NOT EXISTS tx_receipts (tx_id TEXT PRIMARY KEY,digest TEXT NOT NULL,head INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS tombstones (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id))",
        "CREATE TABLE IF NOT EXISTS staging (tx_id TEXT NOT NULL,part INTEGER NOT NULL,base_head INTEGER NOT NULL,lease TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(tx_id,part))",
        "CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY,reason TEXT NOT NULL,payload BLOB)"
    };
    private static final Set<String> BUCKETS = new HashSet<>(Arrays.asList("profiles", "meta", "snapshots", "databaseSnapshots", "localPages", "transfers", "operations", "drafts", "mutations"));
    private final SQLiteDatabase db;
    final String origin;
    private boolean failed;
    private long boundary;
    private long proofGeneration, deliveryDeadline = Long.MAX_VALUE;
    static final class AccessRequired extends Exception {
        AccessRequired() { super("Native resource access must be refreshed"); }
    }
    long boundary() { return boundary; } // Memory-only guard for results waiting on the UI thread.
    long proofEpoch() { return proofGeneration; }
    long deliveryDeadline() { return deliveryDeadline; }

    NativeOutbox(Context context, String origin) throws Exception {
        this.origin = origin;
        File directory = new File(context.getNoBackupFilesDir(), "durable_outbox");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException();
        if (!directory.setReadable(false, false) || !directory.setWritable(false, false) || !directory.setExecutable(false, false)
            || !directory.setReadable(true, true) || !directory.setWritable(true, true) || !directory.setExecutable(true, true)) throw new IllegalStateException();
        File file = new File(directory, OutboxPolicy.hash(origin) + ".sqlite");
        if (!file.getCanonicalFile().equals(file.getAbsoluteFile())) throw new IllegalStateException();
        db = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.CREATE_IF_NECESSARY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        try {
            db.disableWriteAheadLogging();
            try (Cursor c = db.rawQuery("PRAGMA journal_mode=DELETE", null)) {
                NativePolicy.require(c.moveToFirst() && "delete".equalsIgnoreCase(c.getString(0)));
            }
            db.execSQL("PRAGMA synchronous=EXTRA");
            try (Cursor c = db.rawQuery("PRAGMA synchronous", null)) { NativePolicy.require(c.moveToFirst() && c.getInt(0) == 3); }
            NativePolicy.require(!db.isWriteAheadLoggingEnabled());
            for (String sql : SCHEMA) db.execSQL(sql);
            if (!file.setReadable(false, false) || !file.setWritable(false, false)
                || !file.setReadable(true, true) || !file.setWritable(true, true)) throw new IllegalStateException();
            if (get("head") == null) set("head", "0");
            if (get("proof_epoch") == null) set("proof_epoch", "0");
            proofGeneration = Long.parseLong(get("proof_epoch"));
        } catch (Exception error) { db.close(); throw error; }
    }
    private String get(String key) {
        try (Cursor c = db.rawQuery("SELECT value FROM control WHERE key=?", new String[]{key})) { return c.moveToFirst() ? c.getString(0) : null; }
    }
    private void set(String key, String value) { db.execSQL("INSERT OR REPLACE INTO control(key,value) VALUES(?,?)", new Object[]{key, value}); }
    private long head() { return Long.parseLong(get("head")); }
    private long advance() { long next = head() + 1; NativePolicy.require(next < OutboxPolicy.SAFE); set("head", Long.toString(next)); return next; }
    private void advanceProof() {
        long next = Long.parseLong(get("proof_epoch")) + 1;
        NativePolicy.require(next < OutboxPolicy.SAFE); set("proof_epoch", Long.toString(next));
    }
    private void proofCommitted() {
        long next = Long.parseLong(get("proof_epoch"));
        if (next != proofGeneration) { proofGeneration = next; boundary++; }
    }
    private boolean tombstone(String kind, String id) {
        try (Cursor c = db.rawQuery("SELECT 1 FROM tombstones WHERE kind=? AND id=?", new String[]{kind, id})) { return c.moveToFirst(); }
    }
    private void purge(String kind, String identity) {
        db.execSQL("INSERT OR IGNORE INTO tombstones(kind,id) VALUES(?,?)", new Object[]{kind, identity});
        if (kind.equals("profile")) db.execSQL("DELETE FROM records WHERE profile_id=?", new Object[]{identity});
        else {
            db.execSQL("INSERT OR REPLACE INTO records(mode,bucket,key,profile_id,resource_key,payload) SELECT 'quarantine',bucket,key,profile_id,resource_key,payload FROM records WHERE mode='active' AND resource_key=? AND bucket IN ('mutations','operations','drafts')", new Object[]{identity});
            db.execSQL("DELETE FROM records WHERE resource_key=? AND (mode='active' OR bucket='transfers')", new Object[]{identity});
        }
    }
    void revoke() {
        db.beginTransaction();
        try {
            String grant = get("grant");
            if (grant != null) purge("profile", new JSONObject(grant).getString("profileId"));
            set("identity_state", "blocked"); db.execSQL("DELETE FROM control WHERE key='grant'");
            db.execSQL("DELETE FROM control WHERE key='resource_proofs'"); advanceProof();
            db.execSQL("DELETE FROM staging"); set("lease", UUID.randomUUID().toString()); set("owner", ""); advance(); db.setTransactionSuccessful();
        } catch (Exception error) { failed = true; throw new IllegalStateException(); }
        finally { db.endTransaction(); }
        proofCommitted(); boundary++;
    }
    void grant(JSONObject session, String cookie) throws Exception {
        // This method is called only with an actual native session HTTP response.
        NativePolicy.require(session.opt("authenticated") == Boolean.TRUE && session.getJSONObject("member").opt("active") != Boolean.FALSE);
        String mode = session.getString("mode");
        boolean local = mode.equals("local") && session.opt("required") == Boolean.FALSE && cookie == null;
        NativePolicy.require(local || (mode.equals("accounts") || mode.equals("family")) && cookie != null && !cookie.isEmpty());
        long expiry = local ? System.currentTimeMillis() + OutboxPolicy.LOCAL_TTL : OutboxPolicy.expiry(session.getString("expires_at"));
        NativePolicy.require(expiry > System.currentTimeMillis());
        String profile = OutboxPolicy.profile(origin, OutboxPolicy.text(session.opt("workspace_id"), 1000),
            OutboxPolicy.text(session.getJSONObject("member").opt("id"), 1000), OutboxPolicy.text(session.opt("cache_binding"), 1000));
        JSONObject grant = new JSONObject().put("profileId", profile).put("validUntil", expiry)
            .put("session_ref", cookie == null ? "local" : OutboxPolicy.hash(cookie));
        boolean changed = false;
        db.beginTransaction();
        try {
            String old = get("grant");
            if (old != null && !new JSONObject(old).getString("profileId").equals(profile)) { purge("profile", new JSONObject(old).getString("profileId")); set("lease", UUID.randomUUID().toString()); set("owner", ""); advance(); changed = true; }
            NativePolicy.require(!tombstone("profile", profile));
            if (old == null || !new JSONObject(old).getString("profileId").equals(profile)
                || !new JSONObject(old).getString("session_ref").equals(grant.getString("session_ref"))) {
                db.execSQL("DELETE FROM control WHERE key='resource_proofs'"); advanceProof();
            }
            else if (grant.getLong("validUntil") < new JSONObject(old).getLong("validUntil")) advanceProof();
            set("grant", grant.toString()); set("identity_state", "verified");
            // Grant refresh does not move the data head; it contains no JS records.
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted(); if (changed) boundary++;
    }
    private JSONObject verified(String cookie, boolean blocked) throws Exception {
        if (failed || blocked || !"verified".equals(get("identity_state"))) return null;
        String value = get("grant");
        if (value == null) return null;
        JSONObject grant = new JSONObject(value);
        if (grant.getLong("validUntil") <= System.currentTimeMillis() || tombstone("profile", grant.getString("profileId"))
            || !grant.getString("session_ref").equals(cookie == null ? "local" : OutboxPolicy.hash(cookie))) return null;
        return grant;
    }
    private long number(JSONObject value, String key) throws Exception { return OutboxPolicy.integer(value.opt(key), 0, OutboxPolicy.SAFE - 1); }
    private long level(JSONObject value) throws Exception { return OutboxPolicy.integer(value.opt("access_level"), 1, 4); }
    private boolean flag(JSONObject value, String key) throws Exception {
        Object result = value.opt(key); NativePolicy.require(result instanceof Boolean); return result == Boolean.TRUE;
    }
    private String identity(JSONObject value, String key) throws Exception { return OutboxPolicy.text(value.opt(key), 1000); }
    private void envelope(JSONObject value, String profile) throws Exception {
        String[] parts = profile.split("\\|", -1); NativePolicy.require(parts.length == 4 && parts[0].equals(origin)
            && OutboxPolicy.encode(identity(value, "workspace_id")).equals(parts[1])
            && OutboxPolicy.encode(identity(value, "current_member_id")).equals(parts[2])
            && OutboxPolicy.encode(identity(value, "session_binding")).equals(parts[3]));
        number(value, "access_revision"); number(value, "data_revision");
    }
    private String proofKey(String kind, String id) throws Exception { return kind + ":" + OutboxPolicy.encode(id); }
    private JSONObject ledger() throws Exception {
        String raw = get("resource_proofs"); return raw == null ? null : new JSONObject(raw);
    }
    private String semantic(Object value) throws Exception { return canonical(value, true); }
    private String canonical(Object value, boolean proofRoot) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; TreeSet<String> keys = new TreeSet<>(); Iterator<String> names = object.keys();
            while (names.hasNext()) { String name = names.next(); if (!proofRoot || !name.equals("observedAt") && !name.equals("validUntil")) keys.add(name); }
            StringBuilder result = new StringBuilder("{");
            for (String name : keys) { if (result.length() > 1) result.append(','); result.append(JSONObject.quote(name)).append(':').append(canonical(object.get(name), false)); }
            return result.append('}').toString();
        }
        if (value instanceof JSONArray) { JSONArray array = (JSONArray) value; StringBuilder result = new StringBuilder("["); for (int i = 0; i < array.length(); i++) { if (i > 0) result.append(','); result.append(canonical(array.get(i), false)); } return result.append(']').toString(); }
        return value instanceof String ? JSONObject.quote((String) value) : String.valueOf(value);
    }
    private JSONObject currentLedger(JSONObject grant) throws Exception {
        JSONObject ledger = ledger();
        if (ledger == null || !grant.getString("profileId").equals(ledger.getString("profileId"))
            || !grant.getString("session_ref").equals(ledger.getString("sessionRef"))
            || !ledger.getString("owner").equals(get("owner"))) return null;
        return ledger;
    }
    private JSONObject projection(JSONArray rows, boolean pages, String database) throws Exception {
        NativePolicy.require(rows.length() <= 100000); JSONObject result = new JSONObject();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i); String id = identity(row, "id"); NativePolicy.require(!result.has(id));
            JSONObject entry = new JSONObject().put("accessLevel", level(row));
            if (pages) entry.put("locked", flag(row, "locked")).put("archived", flag(row, "archived"));
            else if (database != null) NativePolicy.require(database.equals(identity(row, "database_id")));
            result.put(id, entry);
        }
        return result;
    }
    /** Native-only caller has already checked origin/auth/sent cookie under its owner lock. */
    void observe(String method, String path, int status, byte[] raw, String cookie, boolean blocked, String owner) throws Exception {
        String[] resource = OutboxPolicy.canonicalResource(method, path); if (resource == null) return;
        if (status != 200 && status != 403 && status != 404) return;
        JSONObject grant = verified(cookie, blocked); if (grant == null) throw new AccessRequired();
        String kind = resource[0], id = resource[1], profile = grant.getString("profileId"), key = proofKey(kind, id);
        if (status == 200 && !kind.equals("workspace") && tombstone("resource", profile + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id))) throw new AccessRequired();
        JSONObject previousLedger = ledger(), entries = new JSONObject();
        long floorAccess = 0, floorData = 0;
        if (previousLedger != null && profile.equals(previousLedger.getString("profileId")) && grant.getString("session_ref").equals(previousLedger.getString("sessionRef"))) {
            floorAccess = previousLedger.getLong("maxAccessRevision"); floorData = previousLedger.getLong("maxDataRevision");
            JSONObject workspaceDenial = previousLedger.getJSONObject("entries").optJSONObject(proofKey("workspace", "workspace"));
            if (status == 200 && workspaceDenial != null && workspaceDenial.opt("terminal") == Boolean.TRUE) throw new AccessRequired();
        }
        if (previousLedger != null && profile.equals(previousLedger.getString("profileId")) && owner.equals(previousLedger.getString("owner"))
            && grant.getString("session_ref").equals(previousLedger.getString("sessionRef"))) entries = previousLedger.getJSONObject("entries");
        JSONObject previous = entries.optJSONObject(key), proof = null; boolean malformed = false;
        long now = System.currentTimeMillis();
        if (status == 200) {
            try {
                JSONObject body = new JSONObject(OutboxPolicy.utf8(raw)); envelope(body, profile);
                long access = number(body, "access_revision"), data = number(body, "data_revision");
                if (!OutboxPolicy.freshRevisions(access, data, floorAccess, floorData)) throw new AccessRequired();
                if (previous != null && previous.has("accessRevision") && !OutboxPolicy.freshRevisions(access, data, previous.getLong("accessRevision"), previous.getLong("dataRevision"))) throw new AccessRequired();
                proof = new JSONObject().put("profileId", profile).put("kind", kind).put("id", id).put("accessRevision", access).put("dataRevision", data)
                    .put("epoch", JSONObject.NULL).put("seq", JSONObject.NULL).put("locked", false).put("archived", false)
                    .put("observedAt", now).put("validUntil", Math.min(grant.getLong("validUntil"), now + OutboxPolicy.LOCAL_TTL));
                if (kind.equals("workspace")) {
                    proof.put("accessLevel", 1).put("pages", projection(body.getJSONArray("pages"), true, null))
                        .put("databases", projection(body.getJSONArray("databases"), false, null));
                } else if (kind.equals("page")) {
                    JSONObject page = body.getJSONObject("page"); NativePolicy.require(id.equals(identity(page, "id")));
                    long accessLevel = level(body); NativePolicy.require(level(page) == accessLevel);
                    proof.put("accessLevel", accessLevel).put("locked", flag(page, "locked")).put("archived", flag(page, "archived"))
                        .put("epoch", identity(body, "epoch")).put("seq", number(body, "seq"));
                } else {
                    JSONObject database = body.getJSONObject("database"); NativePolicy.require(id.equals(identity(database, "id")));
                    JSONObject relations = new JSONObject(), schema = new JSONObject(); JSONArray properties = database.getJSONArray("properties");
                    for (int i = 0; i < properties.length(); i++) {
                        JSONObject property = properties.getJSONObject(i);
                        String propertyID = identity(property, "id"); NativePolicy.require(!schema.has(propertyID)); schema.put(propertyID, property);
                        if ("relation".equals(identity(property, "type"))) relations.put(identity(property, "id"), property.isNull("database_id") ? JSONObject.NULL : identity(property, "database_id"));
                    }
                    proof.put("accessLevel", level(database)).put("canCreateRow", flag(database, "can_create_row"))
                        .put("rows", projection(body.getJSONArray("rows"), false, id)).put("relations", relations).put("schema", schema);
                }
            } catch (AccessRequired stale) { throw stale; }
            catch (Exception invalid) { malformed = true; }
        }
        if (proof == null) {
            proof = new JSONObject().put("profileId", profile).put("kind", kind).put("id", id).put("denied", true).put("observedAt", now)
                .put("terminal", status == 403 || status == 404)
                .put("validUntil", Math.min(grant.getLong("validUntil"), now + OutboxPolicy.LOCAL_TTL));
            if (previous != null && previous.has("accessRevision")) proof.put("accessRevision", previous.getLong("accessRevision")).put("dataRevision", previous.getLong("dataRevision"));
        }
        if (!malformed && status == 200 && previous != null && previous.opt("denied") != Boolean.TRUE
            && previous.getLong("accessRevision") == proof.getLong("accessRevision") && previous.getLong("dataRevision") == proof.getLong("dataRevision")
            && !semantic(previous).equals(semantic(proof))) throw new AccessRequired();
        if (previous != null && OutboxPolicy.stableObservation(semantic(previous).equals(semantic(proof)), now, previous.getLong("validUntil"), grant.getLong("validUntil"))) {
            deliveryDeadline = previous.getLong("validUntil"); if (malformed) throw new AccessRequired(); return;
        }
        entries.put(key, proof);
        JSONObject next = new JSONObject().put("profileId", profile).put("owner", owner).put("sessionRef", grant.getString("session_ref")).put("entries", entries)
            .put("maxAccessRevision", proof.has("accessRevision") && !malformed && status == 200 ? Math.max(floorAccess, proof.getLong("accessRevision")) : floorAccess)
            .put("maxDataRevision", proof.has("dataRevision") && !malformed && status == 200 ? Math.max(floorData, proof.getLong("dataRevision")) : floorData);
        String encodedLedger = next.toString();
        boolean oversized = false;
        if (encodedLedger.getBytes(StandardCharsets.UTF_8).length > OutboxPolicy.RECORD) {
            // Retain prior evidence/input, but commit the newly observed floor.
            // A full ledger cannot revive an older row ACL after this response.
            JSONObject old = ledger(), retained = new JSONObject();
            if (old != null && profile.equals(old.getString("profileId")) && owner.equals(old.getString("owner")) && grant.getString("session_ref").equals(old.getString("sessionRef"))) retained = old.getJSONObject("entries");
            next.put("entries", retained); encodedLedger = next.toString(); oversized = true;
            if (encodedLedger.getBytes(StandardCharsets.UTF_8).length > OutboxPolicy.RECORD) {
                JSONObject invalid = new JSONObject().put("profileId", profile).put("kind", "workspace").put("id", "workspace").put("denied", true)
                    .put("terminal", kind.equals("workspace") && (status == 403 || status == 404))
                    .put("observedAt", now).put("validUntil", Math.min(grant.getLong("validUntil"), now + OutboxPolicy.LOCAL_TTL));
                next.put("entries", new JSONObject().put(proofKey("workspace", "workspace"), invalid)); encodedLedger = next.toString();
            }
            if (malformed || status == 403 || status == 404) {
                JSONObject invalid = new JSONObject().put("profileId", profile).put("kind", "workspace").put("id", "workspace").put("denied", true)
                    .put("terminal", kind.equals("workspace") && (status == 403 || status == 404))
                    .put("observedAt", now).put("validUntil", Math.min(grant.getLong("validUntil"), now + OutboxPolicy.LOCAL_TTL));
                next.put("entries", new JSONObject().put(proofKey("workspace", "workspace"), invalid)); encodedLedger = next.toString();
            }
        }
        db.beginTransaction();
        try {
            set("resource_proofs", encodedLedger);
            if ((status == 403 || status == 404) && !kind.equals("workspace")) purge("resource", profile + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id));
            advanceProof(); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted();
        deliveryDeadline = Math.min(proof.getLong("validUntil"), grant.getLong("validUntil"));
        if (malformed || oversized) throw new AccessRequired();
    }
    private static final class AccessReport {
        final JSONArray issues = new JSONArray(); final Set<String> seen = new HashSet<>();
        boolean truncated; long deadline;
        AccessReport(long expiry) { deadline = expiry; }
        void add(String kind, String id, String reason) throws Exception {
            String key = kind + ":" + id + ":" + reason; if (seen.contains(key)) return;
            if (issues.length() >= 100) { truncated = true; return; }
            seen.add(key);
            issues.put(new JSONObject().put("kind", kind).put("id", id).put("reason", reason));
        }
    }
    private JSONObject proof(JSONObject ledger, JSONObject grant, String kind, String id, AccessReport report, int needed) throws Exception {
        JSONObject entry = ledger == null ? null : ledger.getJSONObject("entries").optJSONObject(proofKey(kind, id));
        String resource = grant.getString("profileId") + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id);
        if (!kind.equals("workspace") && tombstone("resource", resource)) { report.add(kind, id, "denied"); return null; }
        JSONObject workspace = ledger == null ? null : ledger.getJSONObject("entries").optJSONObject(proofKey("workspace", "workspace"));
        if (!kind.equals("workspace") && workspace != null && workspace.opt("denied") == Boolean.TRUE) { report.add("workspace", "workspace", "denied"); return null; }
        if (entry == null && kind.equals("page") && workspace != null && workspace.opt("denied") != Boolean.TRUE) {
            JSONObject listed = workspace.getJSONObject("pages").optJSONObject(id);
            if (listed != null) entry = new JSONObject(workspace.toString()).put("kind", "page").put("id", id)
                .put("accessLevel", listed.getLong("accessLevel")).put("locked", listed.opt("locked")).put("archived", listed.opt("archived"));
        }
        if (entry == null) { report.add(kind, id, "missing"); return null; }
        if (entry.opt("denied") == Boolean.TRUE) { report.add(kind, id, "denied"); return null; }
        if (entry.getLong("accessRevision") < ledger.getLong("maxAccessRevision") || entry.getLong("dataRevision") < ledger.getLong("maxDataRevision")) { report.add(kind, id, "revision_changed"); return null; }
        if (!OutboxPolicy.live(System.currentTimeMillis(), entry.getLong("validUntil"), grant.getLong("validUntil"))) { report.add(kind, id, "expired"); return null; }
        if (!kind.equals("workspace") && workspace != null && workspace.opt("denied") != Boolean.TRUE
            && workspace.getLong("accessRevision") >= entry.getLong("accessRevision") && workspace.getLong("dataRevision") >= entry.getLong("dataRevision")) {
            JSONObject listed = workspace.getJSONObject(kind.equals("database") ? "databases" : "pages").optJSONObject(id);
            if (listed == null || listed.getLong("accessLevel") < entry.getLong("accessLevel")
                || workspace.getLong("accessRevision") > entry.getLong("accessRevision") || workspace.getLong("dataRevision") > entry.getLong("dataRevision")) { report.add(kind, id, "revision_changed"); return null; }
        }
        if (!OutboxPolicy.capability(entry.getLong("accessLevel"), needed, entry.opt("locked") == Boolean.TRUE, entry.opt("archived") == Boolean.TRUE)) {
            report.add(kind, id, "denied"); return null;
        }
        report.deadline = Math.min(report.deadline, entry.getLong("validUntil")); return entry;
    }
    private boolean sameVersion(JSONObject body, JSONObject entry, String kind, String id, AccessReport report) throws Exception {
        if (number(body, "access_revision") != entry.getLong("accessRevision") || number(body, "data_revision") != entry.getLong("dataRevision")) {
            report.add(kind, id, "revision_changed"); return false;
        }
        return true;
    }
    private void rowProof(JSONObject ledger, JSONObject grant, JSONObject database, String target, int needed, AccessReport report) throws Exception {
        JSONObject row = database.getJSONObject("rows").optJSONObject(target);
        if (row == null || row.getLong("accessLevel") < needed) report.add("database", database.getString("id"), "denied");
    }
    private void references(JSONObject ledger, JSONObject grant, JSONObject database, JSONObject body, AccessReport report) throws Exception {
        if (!body.isNull("parent_row_id")) rowProof(ledger, grant, database, identity(body, "parent_row_id"), 1, report);
        if (body.has("depends_on")) {
            JSONArray ids = body.getJSONArray("depends_on");
            for (int i = 0; i < ids.length(); i++) rowProof(ledger, grant, database, OutboxPolicy.text(ids.get(i), 1000), 1, report);
        }
        JSONObject properties = body.optJSONObject("properties"), relations = database.getJSONObject("relations");
        if (properties == null) return;
        Iterator<String> names = relations.keys();
        while (names.hasNext()) {
            String field = names.next(); if (properties.isNull(field)) continue;
            JSONArray ids = properties.getJSONArray(field);
            if (relations.isNull(field)) {
                for (int i = 0; i < ids.length(); i++) {
                    String target = OutboxPolicy.text(ids.get(i), 1000); boolean found = false;
                    JSONObject entries = ledger.getJSONObject("entries"); Iterator<String> keys = entries.keys();
                    while (keys.hasNext()) {
                        JSONObject candidate = entries.getJSONObject(keys.next());
                        if (!"database".equals(candidate.optString("kind")) || candidate.opt("denied") == Boolean.TRUE
                            || candidate.getLong("accessRevision") < ledger.getLong("maxAccessRevision") || candidate.getLong("dataRevision") < ledger.getLong("maxDataRevision")
                            || !OutboxPolicy.live(System.currentTimeMillis(), candidate.getLong("validUntil"), grant.getLong("validUntil"))
                            || candidate.getJSONObject("rows").optJSONObject(target) == null) continue;
                        JSONObject authorized = proof(ledger, grant, "database", candidate.getString("id"), report, 1);
                        if (authorized != null && authorized.getJSONObject("rows").getJSONObject(target).getLong("accessLevel") >= 1) { found = true; break; }
                    }
                    if (!found) report.add("database", database.getString("id"), "denied");
                }
            } else {
                String relatedID = relations.getString(field);
                JSONObject related = relatedID.equals(database.getString("id")) ? database : proof(ledger, grant, "database", relatedID, report, 1);
                if (related == null) continue;
                for (int i = 0; i < ids.length(); i++) rowProof(ledger, grant, related, OutboxPolicy.text(ids.get(i), 1000), 1, report);
            }
        }
    }
    private void workspaceCache(JSONObject ledger, JSONObject grant, JSONObject workspace, AccessReport report) throws Exception {
        JSONObject entry = proof(ledger, grant, "workspace", "workspace", report, 1); if (entry == null) return;
        envelope(workspace, grant.getString("profileId")); if (!sameVersion(workspace, entry, "workspace", "workspace", report)) return;
        for (String collection : Arrays.asList("pages", "databases")) {
            JSONArray rows = workspace.getJSONArray(collection); JSONObject permitted = entry.getJSONObject(collection);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i); String id = identity(row, "id"); JSONObject allowed = permitted.optJSONObject(id);
                String kind = collection.equals("pages") ? "page" : "database";
                String resource = grant.getString("profileId") + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id);
                JSONObject specific = ledger.getJSONObject("entries").optJSONObject(proofKey(kind, id));
                if (tombstone("resource", resource) || specific != null && specific.opt("denied") == Boolean.TRUE) { report.add(kind, id, "denied"); continue; }
                if (allowed == null || level(row) > allowed.getLong("accessLevel")
                    || collection.equals("pages") && (flag(row, "locked") != (allowed.opt("locked") == Boolean.TRUE) || flag(row, "archived") != (allowed.opt("archived") == Boolean.TRUE))) {
                    report.add(collection.equals("pages") ? "page" : "database", id, "revision_changed");
                }
            }
        }
    }
    private JSONObject record(long row, int size) throws Exception {
        NativePolicy.require(size > 0 && size <= OutboxPolicy.RECORD); ByteArrayOutputStream bytes = new ByteArrayOutputStream(size);
        for (int offset = 0; offset < size; offset += OutboxPolicy.PART) {
            int count = Math.min(OutboxPolicy.PART, size - offset);
            try (Cursor part = db.rawQuery("SELECT substr(payload,?,?) FROM records WHERE rowid=?", new String[]{Integer.toString(offset + 1), Integer.toString(count), Long.toString(row)})) {
                NativePolicy.require(part.moveToFirst()); byte[] value = part.getBlob(0); NativePolicy.require(value.length == count); bytes.write(value);
            }
        }
        return new JSONObject(OutboxPolicy.utf8(bytes.toByteArray()));
    }
    private void basis(JSONObject grant, String resource, String id, JSONObject entry, AccessReport report) throws Exception {
        try (Cursor cached = db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='active' AND bucket='snapshots' AND resource_key=? AND profile_id=? LIMIT 1", new String[]{resource, grant.getString("profileId")})) {
            if (!cached.moveToFirst()) { report.add("page", id, "missing"); return; }
            JSONObject snapshot = record(cached.getLong(0), cached.getInt(1)).getJSONObject("snapshot"); envelope(snapshot, grant.getString("profileId"));
            sameVersion(snapshot, entry, "page", id, report);
            if (entry.isNull("epoch") || !identity(snapshot, "epoch").equals(entry.getString("epoch")) || number(snapshot, "seq") != entry.getLong("seq")) report.add("page", id, "epoch_changed");
        }
    }
    private AccessReport preflight(JSONObject grant) throws Exception {
        AccessReport report = new AccessReport(grant.getLong("validUntil")); JSONObject ledger = currentLedger(grant);
        if (ledger != null) {
            JSONObject workspace = ledger.getJSONObject("entries").optJSONObject(proofKey("workspace", "workspace"));
            if (workspace != null && workspace.opt("denied") == Boolean.TRUE) report.add("workspace", "workspace", "denied");
        }
        try (Cursor cursor = db.rawQuery("SELECT rowid,bucket,resource_key,length(payload) FROM records WHERE mode='active' AND profile_id=?", new String[]{grant.getString("profileId")})) {
            while (cursor.moveToNext()) {
                String bucket = cursor.getString(1), resource = cursor.getString(2); JSONObject value = record(cursor.getLong(0), cursor.getInt(3));
                if (bucket.equals("profiles")) { if (value.has("workspace")) workspaceCache(ledger, grant, value.getJSONObject("workspace"), report); continue; }
                if (bucket.equals("meta")) continue;
                if (resource == null) { report.add("workspace", "workspace", "missing"); continue; }
                String[] parts = resource.split("\\|", -1); String kind = parts.length == 6 ? "database" : "page";
                String id = java.net.URLDecoder.decode(parts[parts.length - 1].replace("+", "%2B"), "UTF-8");
                if (bucket.equals("localPages") || bucket.equals("mutations") && "page.create".equals(value.getJSONObject("operation").getString("kind"))) { report.add("page", id, "local_dependency"); continue; }
                int needed = bucket.equals("operations") || bucket.equals("mutations") ? 3 : 1;
                JSONObject entry = proof(ledger, grant, kind, id, report, needed); if (entry == null) continue;
                if (bucket.equals("snapshots") || bucket.equals("databaseSnapshots")) {
                    JSONObject snapshot = value.getJSONObject("snapshot"); envelope(snapshot, grant.getString("profileId"));
                    if (!sameVersion(snapshot, entry, kind, id, report)) continue;
                    if (kind.equals("page")) {
                        if (entry.isNull("epoch") || !identity(snapshot, "epoch").equals(entry.getString("epoch")) || number(snapshot, "seq") != entry.getLong("seq")) report.add(kind, id, "epoch_changed");
                        JSONObject page = snapshot.getJSONObject("page");
                        if (!id.equals(identity(page, "id")) || level(page) > entry.getLong("accessLevel") || level(snapshot) > entry.getLong("accessLevel")
                            || flag(page, "locked") != (entry.opt("locked") == Boolean.TRUE) || flag(page, "archived") != (entry.opt("archived") == Boolean.TRUE)) report.add(kind, id, "revision_changed");
                    } else {
                        JSONObject database = snapshot.getJSONObject("database");
                        if (!id.equals(identity(database, "id")) || level(database) > entry.getLong("accessLevel")
                            || flag(database, "can_create_row") && entry.opt("canCreateRow") != Boolean.TRUE) report.add(kind, id, "revision_changed");
                        JSONArray rows = snapshot.getJSONArray("rows");
                        for (int i = 0; i < rows.length(); i++) {
                            JSONObject row = rows.getJSONObject(i); if (!id.equals(identity(row, "database_id"))) { report.add(kind, id, "revision_changed"); continue; }
                            rowProof(ledger, grant, entry, identity(row, "id"), (int) level(row), report); references(ledger, grant, entry, row, report);
                        }
                    }
                } else if (bucket.equals("operations") || bucket.equals("drafts")) {
                    JSONObject body = value.getJSONObject(bucket.equals("operations") ? "operation" : "draft");
                    String epochField = bucket.equals("operations") ? "_epoch" : "epoch";
                    if (body.has(epochField) && (entry.isNull("epoch") || !identity(body, epochField).equals(entry.getString("epoch")))) report.add(kind, id, "epoch_changed");
                    if (bucket.equals("operations") && !body.has(epochField)) report.add(kind, id, "epoch_changed");
                    if (bucket.equals("drafts") && "basis".equals(body.optString("reason")) && (entry.isNull("seq") || number(body, "seq") != entry.getLong("seq"))) report.add(kind, id, "revision_changed");
                    if (bucket.equals("drafts") && "basis".equals(body.optString("reason"))) basis(grant, resource, id, entry, report);
                } else if (bucket.equals("mutations")) {
                    JSONObject operation = value.getJSONObject("operation"), body = operation.getJSONObject("body"); String op = operation.getString("kind");
                    if (kind.equals("database")) {
                        if (!Arrays.asList("row.create", "row.patch", "row.delete").contains(op)) { report.add(kind, id, "denied"); continue; }
                        if (!id.equals(identity(operation, "database_id"))) { report.add(kind, id, "revision_changed"); continue; }
                        if (op.equals("row.create")) { if (entry.opt("canCreateRow") != Boolean.TRUE) report.add(kind, id, "denied"); }
                        else rowProof(ledger, grant, entry, identity(operation, "target_id"), 3, report);
                        if (op.equals("row.delete")) {
                            JSONObject bases = operation.getJSONObject("base_rows"); Iterator<String> ids = bases.keys();
                            while (ids.hasNext()) {
                                String rowID = ids.next(); rowProof(ledger, grant, entry, rowID, 3, report);
                                JSONObject rowBase = bases.getJSONObject(rowID); Iterator<String> fields = rowBase.keys();
                                while (fields.hasNext()) if (!Arrays.asList("updated_at", "after_operation").contains(fields.next())) report.add(kind, id, "revision_changed");
                            }
                        }
                        references(ledger, grant, entry, body, report);
                        JSONObject base = operation.optJSONObject("base");
                        if (base != null) {
                            JSONObject basis = new JSONObject().put("properties", base.optJSONObject("properties"));
                            JSONObject fields = base.optJSONObject("fields");
                            if (fields != null) { if (fields.has("parent_row_id")) basis.put("parent_row_id", fields.get("parent_row_id")); if (fields.has("depends_on")) basis.put("depends_on", fields.get("depends_on")); }
                            references(ledger, grant, entry, basis, report);
                            JSONObject schemas = base.optJSONObject("schema");
                            if (schemas != null) { Iterator<String> schemaKeys = schemas.keys(); while (schemaKeys.hasNext()) { String field = schemaKeys.next();
                                if (!entry.getJSONObject("schema").has(field) || !canonical(schemas.get(field), false).equals(canonical(entry.getJSONObject("schema").get(field), false))) report.add(kind, id, "revision_changed");
                            } }
                        }
                    } else if (!id.equals(identity(operation, "target_id")) || !op.equals("page.patch")) report.add(kind, id, "denied");
                } else if (bucket.equals("transfers")) {
                    if (!id.equals(identity(value, "pageId")) || !resource.equals(identity(value, "scopeId"))) report.add(kind, id, "denied");
                    JSONObject publication = value.optJSONObject("publication");
                    if (publication != null && publication.has("page_id") && !id.equals(identity(publication, "page_id"))) report.add(kind, id, "denied");
                }
            }
        }
        catch (org.json.JSONException | IllegalArgumentException malformed) { report.add("workspace", "workspace", "revision_changed"); }
        deliveryDeadline = report.deadline; return report;
    }
    private void scope(JSONObject input, long generation) throws Exception {
        NativePolicy.require(!failed && OutboxPolicy.integer(input.opt("generation"), 0, OutboxPolicy.SAFE - 1) == generation
            && Long.toString(generation).equals(get("generation")) && input.getString("lease").equals(get("lease")));
    }
    private long intentProof(JSONObject input) throws AccessRequired {
        try { return OutboxPolicy.integer(input.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1); }
        catch (IllegalArgumentException missing) { throw new AccessRequired(); }
    }
    JSObject open(long generation, String cookie, boolean blocked, String owner) throws Exception {
        NativePolicy.require(!failed);
        boolean changed = false;
        db.beginTransaction();
        try {
            if (!owner.equals(get("owner")) || !Long.toString(generation).equals(get("generation"))) {
                set("lease", UUID.randomUUID().toString()); set("owner", owner); set("generation", Long.toString(generation));
                db.execSQL("DELETE FROM staging"); db.execSQL("DELETE FROM control WHERE key LIKE 'staged-proof:%'"); advanceProof(); changed = true;
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted(); if (changed) boundary++;
        JSONObject grant = verified(cookie, blocked);
        JSObject out = new JSObject(); out.put("generation", generation); out.put("lease", get("lease")); out.put("head", head());
        out.put("identityState", grant != null ? "verified" : blocked || "blocked".equals(get("identity_state")) ? "blocked" : "unknown");
        out.put("profileId", grant == null ? JSONObject.NULL : grant.getString("profileId"));
        out.put("validUntil", grant == null ? JSONObject.NULL : grant.getLong("validUntil"));
        AccessReport report = grant == null ? new AccessReport(0) : preflight(grant);
        out.put("proofEpoch", proofEpoch()); out.put("resourceAccess", grant != null && report.issues.length() == 0 ? "ready" : "required");
        out.put("accessIssues", grant == null ? new JSONArray() : report.issues); out.put("accessIssuesTruncated", grant != null && report.truncated);
        deliveryDeadline = grant == null ? 0 : Math.min(deliveryDeadline, grant.getLong("validUntil")); return out;
    }
    JSObject stage(JSONObject input, long generation) throws Exception {
        scope(input, generation);
        String tx = OutboxPolicy.id(input.getString("txId"));
        long proof = intentProof(input);
        int part = (int) OutboxPolicy.integer(input.opt("part"), 0, OutboxPolicy.TRANSACTION / OutboxPolicy.PART - 1);
        long base = OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1);
        byte[] bytes = OutboxPolicy.part(input.getString("bytesBase64"));
        db.beginTransaction();
        try {
            String recorded = get("staged-proof:" + tx), accepted = get("receipt-proof:" + tx);
            if (accepted == null) try (Cursor legacy = db.rawQuery("SELECT 1 FROM tx_receipts WHERE tx_id=? LIMIT 1", new String[]{tx})) { if (legacy.moveToFirst()) throw new AccessRequired(); }
            if (accepted != null && !accepted.equals(Long.toString(proof)) || recorded != null && !recorded.equals(Long.toString(proof))) throw new AccessRequired();
            if (recorded == null) {
                try (Cursor old = db.rawQuery("SELECT 1 FROM staging WHERE tx_id=? LIMIT 1", new String[]{tx})) { if (old.moveToFirst()) throw new AccessRequired(); }
                set("staged-proof:" + tx, Long.toString(proof));
            }
            try (Cursor c = db.rawQuery("SELECT part,base_head,lease,data FROM staging WHERE tx_id=? ORDER BY part", new String[]{tx})) {
                int count = 0, size = 0; boolean retry = false;
                while (c.moveToNext()) {
                    NativePolicy.require(c.getInt(0) == count++ && c.getLong(1) == base && c.getString(2).equals(input.getString("lease")));
                    byte[] previous = c.getBlob(3); size += previous.length;
                    if (c.getInt(0) == part) { NativePolicy.require(Arrays.equals(previous, bytes)); retry = true; }
                }
                if (!retry) {
                    NativePolicy.require(part == count && size + bytes.length <= OutboxPolicy.TRANSACTION);
                    try (Cursor total = db.rawQuery("SELECT COALESCE(sum(length(data)),0) FROM staging", null)) {
                        NativePolicy.require(total.moveToFirst() && total.getLong(0) + bytes.length <= OutboxPolicy.TRANSACTION);
                    }
                    db.execSQL("INSERT INTO staging(tx_id,part,base_head,lease,data) VALUES(?,?,?,?,?)", new Object[]{tx, part, base, input.getString("lease"), bytes});
                }
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        JSObject out = new JSObject(); out.put("generation", generation); out.put("part", part); out.put("proofEpoch", proof); return out;
    }
    private String key(Object key) throws Exception {
        if (key instanceof String) { OutboxPolicy.text(key, 8192); return JSONObject.quote((String) key); }
        NativePolicy.require(key instanceof JSONArray && ((JSONArray) key).length() == 2);
        JSONArray array = (JSONArray) key;
        return new JSONArray().put(OutboxPolicy.text(array.get(0), 8192)).put(OutboxPolicy.text(array.get(1), 1000)).toString();
    }
    private boolean knownProfile(String profile) throws Exception {
        if (!profile.startsWith(origin + "|") || profile.split("\\|", -1).length != 4) return false;
        String value = get("grant");
        if (value != null && new JSONObject(value).getString("profileId").equals(profile) || tombstone("profile", profile)) return true;
        try (Cursor c = db.rawQuery("SELECT 1 FROM records WHERE profile_id=? LIMIT 1", new String[]{profile})) { return c.moveToFirst(); }
    }
    private void change(JSONObject change, String mode, JSONObject grant) throws Exception {
        String bucket = change.getString("bucket"), op = change.getString("op");
        NativePolicy.require(BUCKETS.contains(bucket) && (op.equals("put") || op.equals("delete")));
        Object originalKey = change.get("key"); String key = key(originalKey);
        String profile = grant == null ? null : grant.getString("profileId"), resource = null;
        JSONObject value = op.equals("put") ? change.getJSONObject("value") : null;
        if (bucket.equals("profiles")) {
            NativePolicy.require(originalKey instanceof String);
            profile = (String) originalKey;
            if (op.equals("delete") && mode.equals("active")) { NativePolicy.require(knownProfile(profile)); purge("profile", profile); return; }
            if (value != null) NativePolicy.require(value.getString("id").equals(profile) && origin.equals(value.getString("origin"))
                && OutboxPolicy.profile(origin, value.getString("workspaceId"), value.getString("memberId"), value.getString("cacheBinding")).equals(profile)
                && (!mode.equals("active") || grant != null && value.getDouble("validUntil") <= grant.getLong("validUntil")));
        } else if (bucket.equals("meta")) {
            NativePolicy.require(originalKey instanceof String);
            String id = (String) originalKey;
            if (id.startsWith("revoked:") || id.startsWith("revoked-resource:")) {
                NativePolicy.require(op.equals("put") && id.equals(value.getString("id")));
                String identity = id.substring(id.indexOf(':') + 1);
                boolean whole = id.startsWith("revoked:");
                String owner = whole ? identity : identity.split("\\|", -1).length >= 5 ? identity.substring(0, identity.lastIndexOf('|')) : "";
                if (!whole && owner.endsWith("|database")) owner = owner.substring(0, owner.length() - 9);
                NativePolicy.require((!mode.equals("active") || knownProfile(owner)) && (whole || OutboxPolicy.resource(owner, identity)));
                if (mode.equals("active")) purge(whole ? "profile" : "resource", identity); profile = owner;
            } else if (id.startsWith("recovery-import:")) {
                NativePolicy.require(mode.equals("active"));
                int separator = id.lastIndexOf(':');
                NativePolicy.require(separator >= "recovery-import:".length());
                profile = id.substring("recovery-import:".length(), separator);
                String digest = id.substring(separator + 1);
                NativePolicy.require(digest.matches("[0-9a-f]{64}") && profile.startsWith(origin + "|") && profile.split("\\|", -1).length == 4);
                if (op.equals("delete")) {
                    NativePolicy.require(tombstone("profile", profile));
                    db.execSQL("DELETE FROM records WHERE mode='active' AND bucket='meta' AND key=?", new Object[]{key}); return;
                }
                NativePolicy.require(op.equals("put") && value.length() == 7 && id.equals(value.getString("id")) && profile.equals(value.getString("profileId")) && digest.equals(value.getString("digest")));
                Set<String> fields = new HashSet<>(Arrays.asList("id", "profileId", "digest", "operationIds", "pageIds", "draftKeys", "createdAt"));
                java.util.Iterator<String> names = value.keys(); while (names.hasNext()) NativePolicy.require(fields.contains(names.next()));
                OutboxPolicy.integer(value.get("createdAt"), 0, OutboxPolicy.SAFE);
                for (String name : Arrays.asList("operationIds", "pageIds")) {
                    JSONArray ids = value.getJSONArray(name); NativePolicy.require(ids.length() <= 1000);
                    Set<String> seen = new HashSet<>();
                    for (int i = 0; i < ids.length(); i++) NativePolicy.require(seen.add(OutboxPolicy.text(ids.get(i), 1000)));
                }
                JSONArray drafts = value.getJSONArray("draftKeys"); NativePolicy.require(drafts.length() <= 2000);
                for (int i = 0; i < drafts.length(); i++) {
                    JSONArray pair = drafts.getJSONArray(i); NativePolicy.require(pair.length() == 2 && pair.getString(0).split("\\|", -1).length == 5 && OutboxPolicy.resource(profile, pair.getString(0)));
                    OutboxPolicy.text(pair.get(1), 1000);
                }
                try (Cursor previous = db.rawQuery("SELECT payload FROM records WHERE mode='active' AND bucket='meta' AND key=?", new String[]{key})) {
                    if (previous.moveToFirst()) NativePolicy.require(Arrays.equals(previous.getBlob(0), value.toString().getBytes(StandardCharsets.UTF_8)));
                }
            } else {
                NativePolicy.require(id.equals("active") || id.startsWith("mutation-sequence:"));
                if (op.equals("delete")) { db.execSQL("DELETE FROM records WHERE mode=? AND bucket='meta' AND key=?", new Object[]{mode, key}); return; }
                profile = id.equals("active") ? value.getString("profileId") : id.substring("mutation-sequence:".length()); NativePolicy.require(id.equals(value.getString("id")));
            }
        } else {
            String resourceKey = originalKey instanceof JSONArray ? ((JSONArray) originalKey).getString(0) : (String) originalKey;
            if (bucket.equals("mutations")) {
                NativePolicy.require(originalKey instanceof JSONArray); profile = ((JSONArray) originalKey).getString(0);
                resource = value == null ? null : value.getString("resourceKey");
            } else {
                String[] parts = resourceKey.split("\\|", -1); NativePolicy.require(parts.length >= 5);
                profile = parts[0] + "|" + parts[1] + "|" + parts[2] + "|" + parts[3];
                resource = bucket.equals("transfers") ? resourceKey.substring(0, resourceKey.lastIndexOf('|')) : resourceKey;
            }
            if (value != null) {
                NativePolicy.require(profile.equals(value.getString("profileId")) && OutboxPolicy.resource(profile, resource));
                Object expected = bucket.equals("operations") ? new JSONArray().put(value.getString("key")).put(value.getString("id"))
                    : bucket.equals("drafts") ? new JSONArray().put(value.getString("key")).put(value.getString("clientId"))
                    : bucket.equals("mutations") ? new JSONArray().put(value.getString("profileId")).put(value.getString("id")) : value.getString("key");
                NativePolicy.require(key(expected).equals(key));
                if (bucket.equals("transfers")) NativePolicy.require(resource.equals(value.getString("scopeId")));
                if (value.has("resourceKey")) NativePolicy.require(resource.equals(value.getString("resourceKey")));
                if (bucket.equals("snapshots") || bucket.equals("databaseSnapshots")) {
                    JSONObject snapshot = value.getJSONObject("snapshot");
                    String[] identity = profile.split("\\|", -1);
                    if (snapshot.has("workspace_id")) NativePolicy.require(OutboxPolicy.encode(snapshot.getString("workspace_id")).equals(identity[1]));
                    if (snapshot.has("current_member_id")) NativePolicy.require(OutboxPolicy.encode(snapshot.getString("current_member_id")).equals(identity[2]));
                    if (snapshot.has("session_binding")) NativePolicy.require(OutboxPolicy.encode(snapshot.getString("session_binding")).equals(identity[3]));
                }
            }
        }
        if (mode.equals("active") && bucket.equals("mutations") && value != null && tombstone("resource", resource)
            && "denied".equals(value.optString("status")) && value.optJSONObject("recovery") != null
            && "resource_revoked".equals(value.getJSONObject("recovery").optString("reason"))) {
            NativePolicy.require(knownProfile(profile)); mode = "quarantine"; // Recovery only; never hydrate/replay.
        }
        if (mode.equals("active")) {
            boolean cleanup = op.equals("delete") || bucket.equals("meta") && ((String) originalKey).startsWith("revoked");
            NativePolicy.require(cleanup ? knownProfile(profile) : grant != null && profile.equals(grant.getString("profileId")) && !tombstone("profile", profile)
                && (resource == null || !tombstone("resource", resource)));
        } else NativePolicy.require(profile != null && profile.startsWith(origin + "|"));
        if (value == null) db.execSQL("DELETE FROM records WHERE mode=? AND bucket=? AND key=?", new Object[]{mode, bucket, key});
        else {
            byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8); NativePolicy.require(bytes.length <= OutboxPolicy.RECORD);
            db.execSQL("INSERT OR REPLACE INTO records(mode,bucket,key,profile_id,resource_key,payload) VALUES(?,?,?,?,?,?)", new Object[]{mode, bucket, key, profile, resource, bytes});
        }
    }
    JSObject commit(JSONObject input, long generation, String cookie, boolean blocked) throws Exception {
        scope(input, generation);
        String tx = OutboxPolicy.id(input.getString("txId")), digest = input.getString("digest");
        NativePolicy.require(digest.matches("[0-9a-f]{64}"));
        long result;
        db.beginTransaction();
        try {
            try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
                if (c.moveToFirst()) {
                    NativePolicy.require(c.getString(0).equals(digest)); result = c.getLong(1);
                    String original = get("receipt-proof:" + tx); if (original == null) throw new AccessRequired();
                    db.execSQL("DELETE FROM staging WHERE tx_id=?", new Object[]{tx});
                    db.execSQL("DELETE FROM control WHERE key=?", new Object[]{"staged-proof:" + tx});
                    db.setTransactionSuccessful(); return receipt(generation, result, tx, Long.parseLong(original));
                }
            }
            long proof = intentProof(input);
            if (!Long.toString(proof).equals(get("staged-proof:" + tx))) throw new AccessRequired();
            long base = OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1); NativePolicy.require(base == head());
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (Cursor c = db.rawQuery("SELECT part,base_head,lease,data FROM staging WHERE tx_id=? ORDER BY part", new String[]{tx})) {
                int count = 0;
                while (c.moveToNext()) {
                    NativePolicy.require(c.getInt(0) == count++ && c.getLong(1) == base && c.getString(2).equals(input.getString("lease")));
                    byte[] bytes = c.getBlob(3); NativePolicy.require(buffer.size() + bytes.length <= OutboxPolicy.TRANSACTION); buffer.write(bytes);
                }
                NativePolicy.require(count > 0);
            }
            byte[] raw = buffer.toByteArray(); NativePolicy.require(OutboxPolicy.hash(raw).equals(digest));
            JSONObject delta = new JSONObject(OutboxPolicy.utf8(raw));
            NativePolicy.require(OutboxPolicy.integer(delta.opt("version"), 1, 1) == 1 && origin.equals(delta.getString("origin")));
            String mode = delta.getString("mode"); NativePolicy.require(mode.equals("active") || mode.equals("quarantine"));
            JSONObject grant = verified(cookie, blocked);
            JSONArray changes = delta.getJSONArray("changes"); NativePolicy.require(changes.length() <= 100000
                && (!mode.equals("active") || grant != null || changes.length() > 0));
            boolean cleanup = true;
            for (int i = 0; i < changes.length(); i++) {
                JSONObject item = changes.getJSONObject(i);
                if (!"delete".equals(item.getString("op")) && !("meta".equals(item.getString("bucket")) && item.get("key") instanceof String
                    && (item.getString("key").startsWith("revoked:") || item.getString("key").startsWith("revoked-resource:")))) cleanup = false;
            }
            if (mode.equals("active") && !cleanup && (grant == null || proof != proofEpoch())) throw new AccessRequired();
            for (int i = 0; i < changes.length(); i++) change(changes.getJSONObject(i), mode, grant);
            if (mode.equals("active") && !cleanup) {
                if (grant == null || preflight(grant).issues.length() > 0 || System.currentTimeMillis() >= grant.getLong("validUntil")) throw new AccessRequired();
            }
            result = advance();
            db.execSQL("INSERT INTO tx_receipts(tx_id,digest,head) VALUES(?,?,?)", new Object[]{tx, digest, result});
            set("receipt-proof:" + tx, Long.toString(proof));
            db.execSQL("DELETE FROM staging WHERE tx_id=?", new Object[]{tx});
            db.execSQL("DELETE FROM control WHERE key=?", new Object[]{"staged-proof:" + tx}); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        boundary++; // A delayed page must also be fenced by resource/profile purge deltas.
        try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
            NativePolicy.require(c.moveToFirst() && c.getString(0).equals(digest) && c.getLong(1) == result);
        }
        return receipt(generation, result, tx, Long.parseLong(get("receipt-proof:" + tx)));
    }
    private JSObject receipt(long generation, long head, String tx, long proof) {
        JSObject out = new JSObject(); out.put("generation", generation); out.put("head", head); out.put("txId", tx); out.put("proofEpoch", proof); return out;
    }
    JSObject read(JSONObject input, long generation, String cookie, boolean blocked) throws Exception {
        scope(input, generation); JSONObject grant = verified(cookie, blocked); if (grant == null) throw new AccessRequired();
        if (intentProof(input) != proofEpoch()) throw new AccessRequired();
        AccessReport report = preflight(grant); if (report.issues.length() > 0) throw new AccessRequired();
        NativePolicy.require(OutboxPolicy.integer(input.opt("head"), 0, OutboxPolicy.SAFE - 1) == head());
        int limit = (int) OutboxPolicy.integer(input.opt("byteLimit"), 1, OutboxPolicy.PART);
        long row = 0; int offset = 0;
        if (!input.isNull("cursor")) {
            JSONObject cursor = new JSONObject(input.getString("cursor"));
            NativePolicy.require(cursor.getString("lease").equals(get("lease")) && OutboxPolicy.integer(cursor.opt("head"), 0, OutboxPolicy.SAFE - 1) == head());
            if (intentProof(cursor) != proofEpoch() || number(cursor, "validUntil") <= System.currentTimeMillis()) throw new AccessRequired();
            row = OutboxPolicy.integer(cursor.opt("row"), 0, Long.MAX_VALUE); offset = (int) OutboxPolicy.integer(cursor.opt("offset"), 0, OutboxPolicy.RECORD);
        }
        JSONArray fragments = new JSONArray(); int remaining = limit; String next = null;
        try (Cursor c = db.rawQuery("SELECT rowid,bucket,key,length(payload) FROM records WHERE mode='active' AND profile_id=? AND rowid>=? ORDER BY rowid", new String[]{grant.getString("profileId"), Long.toString(row)})) {
            while (c.moveToNext()) {
                long current = c.getLong(0); int total = c.getInt(3); if (current != row) offset = 0;
                NativePolicy.require(offset < total && total <= OutboxPolicy.RECORD);
                int count = Math.min(remaining, total - offset); byte[] bytes;
                try (Cursor p = db.rawQuery("SELECT substr(payload,?,?) FROM records WHERE rowid=?", new String[]{Integer.toString(offset + 1), Integer.toString(count), Long.toString(current)})) {
                    NativePolicy.require(p.moveToFirst()); bytes = p.getBlob(0); NativePolicy.require(bytes.length == count);
                }
                Object originalKey = c.getString(2).startsWith("[") ? new JSONArray(c.getString(2)) : new JSONArray("[" + c.getString(2) + "]").get(0);
                fragments.put(new JSONObject().put("bucket", c.getString(1)).put("key", originalKey).put("offset", offset).put("total", total)
                    .put("bytesBase64", OutboxPolicy.base64(bytes)));
                remaining -= count;
                if (remaining == 0) {
                    next = new JSONObject().put("lease", get("lease")).put("head", head()).put("row", offset + count == total ? current + 1 : current)
                        .put("offset", offset + count == total ? 0 : offset + count).put("proofEpoch", proofEpoch()).put("validUntil", deliveryDeadline).toString(); break;
                }
                row = current + 1; offset = 0;
            }
        }
        JSObject out = new JSObject(); out.put("generation", generation); out.put("head", head()); out.put("proofEpoch", proofEpoch()); out.put("fragments", fragments); out.put("next", next == null ? JSONObject.NULL : next); return out;
    }
    @Override public void close() { db.close(); }
}
