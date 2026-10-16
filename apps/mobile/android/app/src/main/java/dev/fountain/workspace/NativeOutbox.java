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
    long boundary() { return boundary; } // Memory-only guard for results waiting on the UI thread.

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
        } catch (Exception error) { db.close(); throw error; }
    }
    private String get(String key) {
        try (Cursor c = db.rawQuery("SELECT value FROM control WHERE key=?", new String[]{key})) { return c.moveToFirst() ? c.getString(0) : null; }
    }
    private void set(String key, String value) { db.execSQL("INSERT OR REPLACE INTO control(key,value) VALUES(?,?)", new Object[]{key, value}); }
    private long head() { return Long.parseLong(get("head")); }
    private long advance() { long next = head() + 1; NativePolicy.require(next < OutboxPolicy.SAFE); set("head", Long.toString(next)); return next; }
    private boolean tombstone(String kind, String id) {
        try (Cursor c = db.rawQuery("SELECT 1 FROM tombstones WHERE kind=? AND id=?", new String[]{kind, id})) { return c.moveToFirst(); }
    }
    private void purge(String kind, String identity) {
        db.execSQL("INSERT OR IGNORE INTO tombstones(kind,id) VALUES(?,?)", new Object[]{kind, identity});
        db.execSQL("DELETE FROM records WHERE " + (kind.equals("profile") ? "profile_id" : "resource_key") + "=?", new Object[]{identity});
    }
    void revoke() {
        db.beginTransaction();
        try {
            String grant = get("grant");
            if (grant != null) purge("profile", new JSONObject(grant).getString("profileId"));
            set("identity_state", "blocked"); db.execSQL("DELETE FROM control WHERE key='grant'");
            db.execSQL("DELETE FROM staging"); set("lease", UUID.randomUUID().toString()); set("owner", ""); advance(); db.setTransactionSuccessful();
        } catch (Exception error) { failed = true; throw new IllegalStateException(); }
        finally { db.endTransaction(); }
        boundary++;
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
            set("grant", grant.toString()); set("identity_state", "verified");
            // Grant refresh does not move the data head; it contains no JS records.
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        if (changed) boundary++;
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
    private void scope(JSONObject input, long generation) throws Exception {
        NativePolicy.require(!failed && OutboxPolicy.integer(input.opt("generation"), 0, OutboxPolicy.SAFE - 1) == generation
            && Long.toString(generation).equals(get("generation")) && input.getString("lease").equals(get("lease")));
    }
    JSObject open(long generation, String cookie, boolean blocked, String owner) throws Exception {
        NativePolicy.require(!failed);
        boolean changed = false;
        db.beginTransaction();
        try {
            if (!owner.equals(get("owner")) || !Long.toString(generation).equals(get("generation"))) {
                set("lease", UUID.randomUUID().toString()); set("owner", owner); set("generation", Long.toString(generation));
                db.execSQL("DELETE FROM staging"); changed = true;
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        if (changed) boundary++;
        JSONObject grant = verified(cookie, blocked);
        JSObject out = new JSObject(); out.put("generation", generation); out.put("lease", get("lease")); out.put("head", head());
        out.put("identityState", grant != null ? "verified" : blocked || "blocked".equals(get("identity_state")) ? "blocked" : "unknown");
        out.put("profileId", grant == null ? JSONObject.NULL : grant.getString("profileId"));
        out.put("validUntil", grant == null ? JSONObject.NULL : grant.getLong("validUntil")); return out;
    }
    JSObject stage(JSONObject input, long generation) throws Exception {
        scope(input, generation);
        String tx = OutboxPolicy.id(input.getString("txId"));
        int part = (int) OutboxPolicy.integer(input.opt("part"), 0, OutboxPolicy.TRANSACTION / OutboxPolicy.PART);
        long base = OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1);
        byte[] bytes = OutboxPolicy.part(input.getString("bytesBase64"));
        db.beginTransaction();
        try {
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
        JSObject out = new JSObject(); out.put("generation", generation); out.put("part", part); return out;
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
                    db.execSQL("DELETE FROM staging WHERE tx_id=?", new Object[]{tx});
                    db.setTransactionSuccessful(); return receipt(generation, result, tx);
                }
            }
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
            for (int i = 0; i < changes.length(); i++) change(changes.getJSONObject(i), mode, grant);
            result = advance();
            db.execSQL("INSERT INTO tx_receipts(tx_id,digest,head) VALUES(?,?,?)", new Object[]{tx, digest, result});
            db.execSQL("DELETE FROM staging WHERE tx_id=?", new Object[]{tx}); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        boundary++; // A delayed page must also be fenced by resource/profile purge deltas.
        try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
            NativePolicy.require(c.moveToFirst() && c.getString(0).equals(digest) && c.getLong(1) == result);
        }
        return receipt(generation, result, tx);
    }
    private JSObject receipt(long generation, long head, String tx) {
        JSObject out = new JSObject(); out.put("generation", generation); out.put("head", head); out.put("txId", tx); return out;
    }
    JSObject read(JSONObject input, long generation, String cookie, boolean blocked) throws Exception {
        scope(input, generation); JSONObject grant = verified(cookie, blocked); NativePolicy.require(grant != null);
        NativePolicy.require(OutboxPolicy.integer(input.opt("head"), 0, OutboxPolicy.SAFE - 1) == head());
        int limit = (int) OutboxPolicy.integer(input.opt("byteLimit"), 1, OutboxPolicy.PART);
        long row = 0; int offset = 0;
        if (!input.isNull("cursor")) {
            JSONObject cursor = new JSONObject(input.getString("cursor"));
            NativePolicy.require(cursor.getString("lease").equals(get("lease")) && OutboxPolicy.integer(cursor.opt("head"), 0, OutboxPolicy.SAFE - 1) == head());
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
                        .put("offset", offset + count == total ? 0 : offset + count).toString(); break;
                }
                row = current + 1; offset = 0;
            }
        }
        JSObject out = new JSObject(); out.put("generation", generation); out.put("head", head()); out.put("fragments", fragments); out.put("next", next == null ? JSONObject.NULL : next); return out;
    }
    @Override public void close() { db.close(); }
}
