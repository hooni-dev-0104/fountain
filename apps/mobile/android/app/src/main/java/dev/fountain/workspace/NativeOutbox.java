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
        "CREATE TABLE IF NOT EXISTS native_local_versions_v1(mode TEXT NOT NULL,profile_id TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,actor TEXT NOT NULL,context TEXT NOT NULL,PRIMARY KEY(mode,profile_id,bucket,key))",
        "CREATE INDEX IF NOT EXISTS records_profile ON records(profile_id)",
        "CREATE INDEX IF NOT EXISTS records_resource ON records(resource_key)",
        "CREATE TABLE IF NOT EXISTS tx_receipts (tx_id TEXT PRIMARY KEY,digest TEXT NOT NULL,head INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS tombstones (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id))",
        "CREATE TABLE IF NOT EXISTS staging (tx_id TEXT NOT NULL,part INTEGER NOT NULL,base_head INTEGER NOT NULL,lease TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(tx_id,part))",
        "CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY,reason TEXT NOT NULL,payload BLOB)",
        "CREATE TABLE IF NOT EXISTS native_record_owners(mode TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,profile_id TEXT NOT NULL,actor TEXT NOT NULL,digest TEXT NOT NULL,trust TEXT NOT NULL,PRIMARY KEY(mode,bucket,key))",
        "CREATE TABLE IF NOT EXISTS native_observed_resources(profile_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,session_ref TEXT NOT NULL,access_revision INTEGER NOT NULL,data_revision INTEGER NOT NULL,PRIMARY KEY(profile_id,kind,id))"
        ,"CREATE TABLE IF NOT EXISTS native_profile_mirrors_v1(sequence INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL,incarnation TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('base','profile')),ref TEXT NOT NULL UNIQUE,UNIQUE(profile_id,incarnation))"
        ,"CREATE INDEX IF NOT EXISTS native_profile_mirrors_actor_v1 ON native_profile_mirrors_v1(actor,sequence)"
        ,"CREATE TABLE IF NOT EXISTS native_mirror_state_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL)"
        ,"INSERT OR IGNORE INTO native_mirror_state_v1 VALUES(1,0)"
        ,"CREATE TABLE IF NOT EXISTS native_mirror_cursors_v1(profile_id TEXT NOT NULL,incarnation TEXT NOT NULL,token TEXT NOT NULL UNIQUE,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,prefix_position INTEGER NOT NULL,after_sequence INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(profile_id,incarnation))"
    };
    private static final Set<String> BUCKETS = new HashSet<>(Arrays.asList("profiles", "meta", "snapshots", "databaseSnapshots", "localPages", "transfers", "operations", "drafts", "mutations"));
    final SQLiteDatabase db;
    private NativeReconcile reconciliation;
    private NativeLocalGraph validatedGraph;
    private NativeSyncReceipts syncReceipts;
    final String origin;
    private boolean failed, applyingDelta;
    private long boundary;
    private long proofGeneration, deliveryDeadline = Long.MAX_VALUE;
    static class AccessRequired extends Exception {
        AccessRequired() { super("Native resource access must be refreshed"); }
    }
    static final class RecoveryRequired extends AccessRequired {}
    long boundary() { return boundary; } // Memory-only guard for results waiting on the UI thread.
    long proofEpoch() { return proofGeneration; }
    long deliveryDeadline() { return deliveryDeadline; }
    void reconciled() { boundary++; }
    private NativeSyncReceipts syncReceipts(){if(syncReceipts==null)syncReceipts=new NativeSyncReceipts(this);return syncReceipts;}
    NativeSyncReceipts.Admission admitSync(String method,String path,byte[] raw,String cookie,boolean blocked,String owner)throws Exception{requireOwner(owner);if("POST".equals(method)&&"/api/sync".equals(path)&&(offlineWorkspace()||requiresWorkspaceReconcile()))throw new AccessRequired();return syncReceipts().admit(method,path,raw,cookie,blocked,owner);}
    void observeSync(NativeSyncReceipts.Admission admission,int status,byte[] raw,String cookie,boolean blocked,String owner)throws Exception{requireOwner(owner);syncReceipts().observe(admission,status,raw,cookie,blocked,owner);proofCommitted();}
    JSONObject appliedSync(JSONObject grant,JSONObject operation)throws Exception{return syncReceipts().applied(grant,operation);}
    JSONObject appliedDependency(JSONObject grant,String id)throws Exception{return syncReceipts().dependency(grant,id);}
    String sourceTrust(String mode, String bucket, String key, String profile, byte[] raw, String actor) throws Exception {
        try (Cursor c = db.rawQuery("SELECT trust,digest,actor,profile_id FROM native_record_owners WHERE mode=? AND bucket=? AND key=?", new String[]{mode, bucket, key})) {
            return c.moveToFirst() && profile.equals(c.getString(3)) && actor.equals(c.getString(2)) && OutboxPolicy.hash(raw).equals(c.getString(1)) ? c.getString(0) : null;
        }
    }
    void qualify(String mode, String bucket, String key, String profile, byte[] raw, JSONObject grant, boolean nativeBaseline) throws Exception {
        String actor = grant == null ? "" : OutboxPolicy.actorPrefix(origin, grant.getString("profileId"));
        String claimed = OutboxPolicy.actorPrefix(origin, profile), trust = "opaque";
        if (actor != null && actor.equals(claimed)) {
            trust = nativeBaseline || mode.equals("active") && profile.equals(grant.getString("profileId")) ? "native" : "untrusted";
            for (String sourceMode : Arrays.asList("active", "quarantine")) if ("native".equals(sourceTrust(sourceMode, bucket, key, profile, raw, actor))) trust = "native";
        }
        String local = nativeLocalVersion(profile, bucket, key, raw, actor);
        if (mode.equals("quarantine")) {
            local = null; // A renderer quarantine capture never gains new local authority.
            try (Cursor existing = db.rawQuery("SELECT context FROM native_local_versions_v1 WHERE mode='quarantine' AND profile_id=? AND bucket=? AND key=? AND digest=? AND actor=?", new String[]{profile,bucket,key,OutboxPolicy.hash(raw),actor == null ? "" : actor})) { if (existing.moveToFirst()) local = existing.getString(0); }
        }
        db.execSQL("INSERT OR REPLACE INTO native_record_owners VALUES(?,?,?,?,?,?,?)", new Object[]{mode, bucket, key, profile, actor == null ? "" : actor, OutboxPolicy.hash(raw), trust});
        if (local != null && "native".equals(trust)) db.execSQL("INSERT OR REPLACE INTO native_local_versions_v1 VALUES(?,?,?,?,?,?,?)", new Object[]{mode, profile, bucket, key, OutboxPolicy.hash(raw), actor, local});
        else db.execSQL("DELETE FROM native_local_versions_v1 WHERE mode=? AND profile_id=? AND bucket=? AND key=?", new Object[]{mode, profile, bucket, key});
    }
    String nativeLocalVersion(String profile, String bucket, String key, byte[] raw, String actor) throws Exception {
        if (actor == null) return null; String digest = OutboxPolicy.hash(raw);
        try (Cursor c = db.rawQuery("SELECT v.context FROM native_local_versions_v1 v JOIN native_record_owners n ON n.mode=v.mode AND n.profile_id=v.profile_id AND n.bucket=v.bucket AND n.key=v.key AND n.actor=v.actor AND n.digest=v.digest WHERE v.mode IN ('active','quarantine') AND v.profile_id=? AND v.bucket=? AND v.key=? AND v.digest=? AND v.actor=? AND n.trust='native'", new String[]{profile, bucket, key, digest, actor})) { return c.moveToFirst() ? c.getString(0) : null; }
    }
    static String serverPageKey(String workspace, String page) throws Exception {
        return "server-observed:" + OutboxPolicy.hash(OutboxPolicy.text(workspace, 1000)) + ":" + OutboxPolicy.encode(OutboxPolicy.text(page, 1000));
    }
    boolean serverObserved(String workspace, String page) throws Exception { return "1".equals(get(serverPageKey(workspace, page))); }
    boolean markServerPage(String workspace, String page) throws Exception {
        String key = serverPageKey(workspace, page); if ("1".equals(get(key))) return false;
        set(key, "1"); return true; // Permanent negative classification; never a permission grant.
    }
    static String localContextKey(String profile, String page) throws Exception { return "native-local:" + OutboxPolicy.hash(profile) + ":" + OutboxPolicy.encode(page); }
    private JSONObject creationContext(JSONObject grant, String page) throws Exception {
        if (validatedGraph == null || !validatedGraph.newlyLocal(page)) return null;
        JSONObject metadata = validatedGraph.pages.get(page).getJSONObject("metadata");
        String creation = metadata.getString("create_operation_id"); JSONObject operation = validatedGraph.mutations.get(creation).getJSONObject("operation"), body = operation.getJSONObject("body");
        if (serverObserved(grant.getJSONObject("session").getString("workspace_id"), page)) return null;
        return new JSONObject().put("version", 1).put("actor", OutboxPolicy.actorPrefix(origin, grant.getString("profileId")))
            .put("profile", grant.getString("profileId")).put("page", page).put("creation", creation).put("epoch", metadata.getString("initial_epoch"))
            .put("operationDigest", OutboxPolicy.hash(canonical(operation, false))).put("parent", body.isNull("parent_id") ? JSONObject.NULL : body.getString("parent_id"))
            .put("teamspace", body.isNull("teamspace_id") ? "general" : body.getString("teamspace_id"));
    }
    // Only a newly accepted create may establish a context. Record attribution
    // is versioned by exact raw bytes, so old archives cannot inherit it later.
    void stampLocalVersions(JSONObject grant, Set<String> newPages, JSONArray changes) throws Exception {
        if (validatedGraph == null) return;
        for (String page : newPages) {
            JSONObject context = creationContext(grant, page); if (context == null) continue;
            String key = localContextKey(grant.getString("profileId"), page), old = get(key);
            if (old == null) set(key, context.toString());
            else NativePolicy.require(canonical(new JSONObject(old), false).equals(canonical(context, false)));
        }
        Set<String> refs = new HashSet<>();
        if (changes != null) for (int i = 0; i < changes.length(); i++) { JSONObject change = changes.getJSONObject(i);
            if ("put".equals(change.getString("op"))) refs.add(change.getString("bucket") + "\n" + key(change.get("key")));
        }
        try (Cursor rows = db.rawQuery("SELECT bucket,key,resource_key,rowid,length(payload) FROM records WHERE mode='active' AND profile_id=? AND bucket IN ('mutations','localPages','snapshots','operations','drafts')", new String[]{grant.getString("profileId")})) {
            while (rows.moveToNext()) {
                String bucket = rows.getString(0), encoded = rows.getString(1), resource = rows.getString(2);
                if (resource == null || resource.split("\\|", -1).length != 5 || changes != null && !refs.contains(bucket + "\n" + encoded)) continue;
                String page = java.net.URLDecoder.decode(resource.substring(resource.lastIndexOf('|') + 1).replace("+", "%2B"), "UTF-8");
                if (changes == null && !newPages.contains(page)) continue;
                String stored = get(localContextKey(grant.getString("profileId"), page)); JSONObject current = creationContext(grant, page);
                if (stored == null || current == null || !canonical(new JSONObject(stored), false).equals(canonical(current, false))) continue;
                byte[] bytes = payload("records", rows.getLong(3), rows.getInt(4)); String actor = OutboxPolicy.actorPrefix(origin, grant.getString("profileId"));
                if (!"native".equals(sourceTrust("active", bucket, encoded, grant.getString("profileId"), bytes, actor))) continue;
                db.execSQL("INSERT OR REPLACE INTO native_local_versions_v1 VALUES('active',?,?,?,?,?,?)", new Object[]{grant.getString("profileId"), bucket, encoded, OutboxPolicy.hash(bytes), actor, stored});
            }
        }
    }
    private NativeReconcile reconciler() throws Exception {
        if (reconciliation == null) reconciliation = new NativeReconcile(this);
        return reconciliation;
    }
    private void requireOwner(String owner) throws AccessRequired {
        if (owner == null || owner.isEmpty() || !owner.equals(get("owner"))) throw new AccessRequired();
    }
    NativeReconcile.Tag admitReconcile(long sequence, String method, String path, String cookie, boolean blocked, String owner) throws Exception {
        requireOwner(owner); if(offlineWorkspace())throw new AccessRequired(); return reconciler().admit(sequence, method, path, cookie, blocked, owner);
    }
    void beforeReconcileObservation(NativeReconcile.Tag tag, String cookie, boolean blocked, String owner) throws Exception {
        requireOwner(owner); reconciler().beforeObservation(tag, cookie, blocked, owner);
    }
    void captureReconcile(NativeReconcile.Tag tag, int status, byte[] raw, String cookie, boolean blocked, String owner) throws Exception {
        requireOwner(owner); reconciler().capture(tag, status, raw, cookie, blocked, owner);
    }
    void invalidateReconcile()throws Exception{reconciler().invalidate();}
    JSObject reconcile(JSONObject input, long generation, String cookie, boolean blocked, String owner, long watermark) throws Exception {
        return reconciler().call(input, generation, cookie, blocked, owner, watermark);
    }
    JSObject mirror(JSONObject input,long generation,String cookie,boolean blocked,String owner)throws Exception {
        NativePolicy.require(input.length()>=5&&input.length()<=7);
        Set<String> fields=new HashSet<>();Iterator<String> names=input.keys();while(names.hasNext())fields.add(names.next());
        Object action=input.opt("action");NativePolicy.require(action instanceof String);NativeMirrorPolicy.fields(fields,(String)action);
        NativePolicy.require(OutboxPolicy.integer(input.opt("version"),1,1)==1);
        requireOwner(owner);if(!currentOwner(owner))throw new AccessRequired();JSONObject grant=verified(cookie,blocked);
        if(grant==null||cookie==null||!Long.toString(generation).equals(get("generation"))||OutboxPolicy.integer(input.opt("generation"),0,OutboxPolicy.SAFE-1)!=generation
            ||!(input.opt("expectedProfileId") instanceof String)||!grant.getString("profileId").equals(input.opt("expectedProfileId"))
            ||OutboxPolicy.integer(input.opt("expectedEpoch"),0,OutboxPolicy.SAFE-1)!=proofEpoch()
            ||!grant.getJSONObject("session").optString("account_binding").matches("[a-f0-9]{32}")||get("suspended:"+grant.getString("profileId"))!=null)throw new AccessRequired();
        JSONObject session=grant.getJSONObject("session");
        if(!grant.getString("profileId").equals(OutboxPolicy.profile(origin,session.getString("workspace_id"),session.getJSONObject("member").getString("id"),session.getString("cache_binding"))))throw new AccessRequired();
        boolean ready=false;
        if(action.equals("confirm-base"))ready=(offlineWorkspace()?offlineReadable(grant):!"1".equals(get("needs_floor"))&&!requiresWorkspaceReconcile())&&preflight(grant).issues.length()==0;
        deliveryDeadline=Math.min(deliveryDeadline,grant.getLong("validUntil"));
        return new NativeMirrorRegistry(this).call(input,generation,grant,proofEpoch(),ready);
    }

    NativeOutbox(Context context, String origin) throws Exception {
        this.origin = origin;
        File directory = new File(context.getNoBackupFilesDir().getCanonicalFile(), "durable_outbox");
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
    String get(String key) {
        try (Cursor c = db.rawQuery("SELECT rowid,length(CAST(value AS BLOB)) FROM control WHERE key=?", new String[]{key})) {
            return c.moveToFirst() ? OutboxPolicy.utf8(columnBytes("control", "value", c.getLong(0), c.getInt(1))) : null;
        } catch (Exception unavailable) { throw new IllegalStateException("Private control storage unavailable", unavailable); }
    }
    byte[] columnBytes(String table, String column, long row, int size) throws Exception {
        NativePolicy.require(Arrays.asList("control", "records", "recovery", "reconcile_rows", "reconcile_plans").contains(table)
            && (table.equals("control") ? column.equals("value") : table.equals("reconcile_plans") ? column.equals("metadata") : column.equals("payload")) && size >= 0 && size <= OutboxPolicy.RECORD);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(size);
        for (int offset = 0; offset < size; offset += OutboxPolicy.PART) {
            int count = Math.min(OutboxPolicy.PART, size - offset);
            try (Cursor part = db.rawQuery("SELECT substr(CAST(" + column + " AS BLOB),?,?) FROM " + table + " WHERE rowid=?", new String[]{Integer.toString(offset + 1), Integer.toString(count), Long.toString(row)})) {
                NativePolicy.require(part.moveToFirst()); byte[] value = part.getBlob(0); NativePolicy.require(value.length == count); bytes.write(value);
            }
        }
        return bytes.toByteArray();
    }
    byte[] payload(String table, long row, int size) throws Exception {
        NativePolicy.require(size > 0); return columnBytes(table, "payload", row, size);
    }
    boolean currentLease(String expected) {
        try { return !failed && expected != null && expected.equals(get("lease")); } catch (RuntimeException unavailable) { return false; }
    }
    // These exceptions deliver only private immutable cleanup metadata. They
    // cannot restore the positive grant, owner, lease, or resource proof.
    boolean deliveryCurrent(JSONObject request, JSONObject response, long generation, String cookie, boolean blocked, String owner) {
        return currentOwner(owner) || terminalMetadataCurrent(request, response, generation, cookie, blocked);
    }
    boolean terminalMetadataCurrent(JSONObject request, JSONObject response, long generation, String cookie, boolean blocked) {
        try {
            if (OutboxPolicy.integer(request.opt("generation"), 0, OutboxPolicy.SAFE - 1) != generation
                || response.getLong("generation") != generation || knownBlockedProfile(cookie, blocked) == null) return false;
            if (request.has("txId")) return terminalReceipt(request, generation, cookie, blocked, true).toString().equals(response.toString());
            if ("settle".equals(request.optString("phase"))) return terminalSettlement(request, generation, cookie, blocked).toString().equals(response.toString());
            return request.length() == 1 && blockedHeader(generation).toString().equals(response.toString());
        } catch (Exception rejected) { return false; }
    }
    String knownBlockedProfile(String cookie, boolean blocked) throws Exception {
        if (failed || blocked || !"blocked".equals(get("identity_state"))) return null;
        String raw = get("grant"); if (raw == null) return null;
        JSONObject grant = new JSONObject(raw); String profile = grant.getString("profileId"), ref = grant.getString("session_ref");
        if (OutboxPolicy.actorPrefix(origin, profile) == null || get("suspended:" + profile) == null
            || !(cookie == null ? "local".equals(ref) : OutboxPolicy.hash(cookie).equals(ref))) return null;
        return profile;
    }
    private JSObject blockedHeader(long generation) {
        JSObject out = new JSObject(); out.put("generation", generation); out.put("lease", get("lease")); out.put("head", head());
        out.put("identityState", "blocked"); out.put("profileId", JSONObject.NULL); out.put("validUntil", JSONObject.NULL);
        out.put("proofEpoch", proofEpoch()); out.put("resourceAccess", "required"); out.put("accessIssues", new JSONArray());
        out.put("accessIssuesTruncated", false); out.put("reconciliationHandles", new JSONArray()); return out;
    }
    private JSObject terminalReceipt(JSONObject input, long generation, String cookie, boolean blocked, boolean originalLease) throws Exception {
        String profile = knownBlockedProfile(cookie, blocked); if (profile == null) throw new AccessRequired();
        NativePolicy.require(OutboxPolicy.integer(input.opt("generation"), 0, OutboxPolicy.SAFE - 1) == generation);
        // A malformed retry is an invalid capability, not a storage failure.
        String tx = OutboxPolicy.id(OutboxPolicy.text(input.opt("txId"), 1000));
        String digest = OutboxPolicy.text(input.opt("digest"), 64);
        NativePolicy.require(digest.matches("[0-9a-f]{64}"));
        long base = OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1);
        long proof = OutboxPolicy.integer(input.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1);
        String lease = originalLease ? OutboxPolicy.text(input.opt("lease"), 1000) : null;
        String raw = get("terminal-receipt:" + tx); if (raw == null) throw new AccessRequired();
        JSONObject saved = new JSONObject(raw), grant = new JSONObject(get("grant"));
        NativePolicy.require(saved.getInt("version") == 1 && profile.equals(saved.getString("profileId"))
            && grant.getString("session_ref").equals(saved.getString("sessionRef"))
            && saved.getString("digest").equals(digest) && saved.getLong("baseHead") == base
            && saved.getLong("proofEpoch") == proof
            && (!originalLease || saved.getString("lease").equals(lease))
            && saved.getLong("head") == saved.getLong("baseHead") + 1 && saved.getLong("head") == head()
            && saved.getString("postLease").equals(get("lease")) && saved.getLong("postProof") == proofEpoch()
            && "".equals(get("owner")) && profile.equals(get("receipt-owner:" + tx))
            && Long.toString(saved.getLong("proofEpoch")).equals(get("receipt-proof:" + tx)));
        try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
            NativePolicy.require(c.moveToFirst() && saved.getString("digest").equals(c.getString(0)) && saved.getLong("head") == c.getLong(1));
        }
        return receipt(generation, saved.getLong("head"), tx, saved.getLong("proofEpoch"));
    }
    boolean acceptedTerminal(JSONObject input, long generation, String cookie, boolean blocked) {
        try { terminalReceipt(input, generation, cookie, blocked, true); return true; } catch (Exception rejected) { return false; }
    }
    JSObject terminalSettlement(JSONObject input, long generation, String cookie, boolean blocked) throws Exception {
        NativePolicy.require(knownBlockedProfile(cookie, blocked) != null
            && OutboxPolicy.integer(input.opt("generation"), 0, OutboxPolicy.SAFE - 1) == generation
            && OutboxPolicy.text(input.opt("lease"), 1000).equals(get("lease"))
            && input.opt("journals") instanceof JSONArray
            && (!input.has("reconciliations") || input.opt("reconciliations") instanceof JSONArray && input.getJSONArray("reconciliations").length() == 0));
        JSONArray journals = input.getJSONArray("journals"), entries = new JSONArray(); NativePolicy.require(journals.length() > 0 && journals.length() <= 100);
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < journals.length(); i++) {
            JSONObject journal = journals.optJSONObject(i); NativePolicy.require(journal != null && journal.length() == 4
                && ids.add(OutboxPolicy.text(journal.opt("txId"), 1000)));
            JSONObject descriptor = new JSONObject(journal.toString()).put("generation", generation);
            JSONObject accepted = terminalReceipt(descriptor, generation, cookie, blocked, false);
            entries.put(new JSONObject().put("txId", journal.getString("txId")).put("digest", journal.getString("digest"))
                .put("status", "accepted").put("head", accepted.getLong("head")).put("proofEpoch", accepted.getLong("proofEpoch")));
        }
        JSObject result = new JSObject(); result.put("generation", generation); result.put("state", "settled"); result.put("lease", input.getString("lease")); result.put("settlements", entries);
        if (input.has("reconciliations")) result.put("reconciliations", new JSONArray()); return result;
    }
    boolean currentOwner(String owner) {
        try { return !failed && owner != null && owner.equals(get("owner")) && Long.toString(proofGeneration).equals(get("proof_epoch")); }
        catch (RuntimeException unavailable) { return false; }
    }
    void set(String key, String value) { db.execSQL("INSERT OR REPLACE INTO control(key,value) VALUES(?,?)", new Object[]{key, value}); }
    long head() { return Long.parseLong(get("head")); }
    long advance() { long next = head() + 1; NativePolicy.require(next < OutboxPolicy.SAFE); set("head", Long.toString(next)); return next; }
    void advanceProof() {
        long next = Long.parseLong(get("proof_epoch")) + 1;
        NativePolicy.require(next < OutboxPolicy.SAFE); set("proof_epoch", Long.toString(next));
    }
    void proofCommitted() {
        long next = Long.parseLong(get("proof_epoch"));
        if (next != proofGeneration) { proofGeneration = next; boundary++; }
    }
    private boolean tombstone(String kind, String id) {
        try (Cursor c = db.rawQuery("SELECT 1 FROM tombstones WHERE kind=? AND id=?", new String[]{kind, id})) { return c.moveToFirst(); }
    }
    private void observedResource(JSONObject grant,String kind,String id,JSONObject proof)throws Exception{
        if(kind.equals("workspace"))return;
        try(Cursor c=db.rawQuery("SELECT count(*) FROM native_observed_resources WHERE profile_id=?",new String[]{grant.getString("profileId")})){if(!c.moveToFirst()||c.getLong(0)>=1000){try(Cursor known=db.rawQuery("SELECT 1 FROM native_observed_resources WHERE profile_id=? AND kind=? AND id=?",new String[]{grant.getString("profileId"),kind,id})){if(!known.moveToFirst())throw new NativeReconcile.Failure("OUTBOX_RECONCILE_LIMIT");}}}
        db.execSQL("INSERT OR REPLACE INTO native_observed_resources VALUES(?,?,?,?,?,?)",new Object[]{grant.getString("profileId"),kind,id,grant.getString("session_ref"),proof.getLong("accessRevision"),proof.getLong("dataRevision")});
    }
    private void purge(String kind, String identity) throws Exception {
        db.execSQL("INSERT OR IGNORE INTO tombstones(kind,id) VALUES(?,?)", new Object[]{kind, identity});
        if (kind.equals("profile")) db.execSQL("DELETE FROM records WHERE profile_id=?", new Object[]{identity});
        else {
            try(Cursor source=db.rawQuery("SELECT bucket,key,profile_id,rowid,length(payload) FROM records WHERE mode='active' AND resource_key=? AND bucket IN ('mutations','operations','drafts')",new String[]{identity})){
                while(source.moveToNext()){
                    String bucket=source.getString(0),key=source.getString(1),profile=source.getString(2);byte[] raw=payload("records",source.getLong(3),source.getInt(4));boolean collision=false;
                    try(Cursor old=db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='quarantine' AND bucket=? AND key=?",new String[]{bucket,key})){collision=old.moveToFirst()&&!Arrays.equals(payload("records",old.getLong(0),old.getInt(1)),raw);}
                    if(collision){reconciler().archiveVersion(profile,identity,bucket,key,raw,"native_denial_collision");continue;}
                    db.execSQL("INSERT OR IGNORE INTO records VALUES('quarantine',?,?,?,?,?)",new Object[]{bucket,key,profile,identity,raw});
                    // Only exact previously native-attributed versions retain history.
                    db.execSQL("INSERT OR REPLACE INTO native_record_owners SELECT 'quarantine',bucket,key,profile_id,actor,digest,trust FROM native_record_owners WHERE mode='active' AND bucket=? AND key=?",new Object[]{bucket,key});
                }
            }
            db.execSQL("DELETE FROM records WHERE resource_key=? AND (mode='active' OR bucket='transfers')", new Object[]{identity});
        }
    }
    private String floorKey(JSONObject grant) throws Exception { return "resource-floor:" + OutboxPolicy.hash(grant.getString("profileId") + "|" + grant.getString("session_ref")); }
    private void clearProofs() throws Exception {
        String raw = get("resource_proofs"), authority = get("grant");
        if (raw != null && authority != null) { JSONObject ledger = new JSONObject(raw), grant = new JSONObject(authority);
            if (grant.getString("profileId").equals(ledger.opt("profileId")) && grant.getString("session_ref").equals(ledger.opt("sessionRef")))
                set(floorKey(grant), new JSONObject().put("maxAccessRevision", ledger.getLong("maxAccessRevision")).put("maxDataRevision", ledger.getLong("maxDataRevision")).toString());
        }
        db.execSQL("DELETE FROM control WHERE key='resource_proofs'");
    }
    private void expireCachedGrant(JSONObject grant) throws Exception {
        String profile = grant.getString("profileId");
        if (get("suspended:" + profile) != null || tombstone("profile", profile)) throw new RecoveryRequired();
        if ("expired".equals(get("identity_state")) && grant.getString("session_ref").equals(get("cache-expired:" + profile))) return;
        db.beginTransaction(); try {
            clearProofs(); set("needs_floor", "1"); set("identity_state", "expired"); set("cache-expired:" + profile, grant.getString("session_ref"));
            set("lease", UUID.randomUUID().toString()); set("owner", ""); advanceProof(); reconciler().invalidate(); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted(); boundary++;
    }
    private void suspendProfile(String profile)throws Exception {
        NativePolicy.require(OutboxPolicy.actorPrefix(origin,profile)!=null);set("suspended:"+profile,"1");
        String raw=get("grant");if(raw==null||!profile.equals(new JSONObject(raw).getString("profileId")))return;
        set("identity_state","blocked");clearProofs();set("needs_floor","1");advanceProof();
        set("lease",UUID.randomUUID().toString());set("owner","");if (!applyingDelta) advance();
    }
    // Native auth invalidation preserves every source/uncertain transaction.
    void revoke() {
        db.beginTransaction();
        try {
            String grant = get("grant");
            if(grant!=null)suspendProfile(new JSONObject(grant).getString("profileId"));
            else{set("identity_state","blocked");clearProofs();set("needs_floor","1");advanceProof();set("lease",UUID.randomUUID().toString());set("owner","");advance();}
            db.setTransactionSuccessful();
        } catch (Exception error) { failed = true; throw new IllegalStateException(); }
        finally { db.endTransaction(); }
        proofCommitted(); boundary++;
    }
    // A navigation park closes admission without claiming that server authority was revoked.
    void parkWorkspace() throws Exception {
        db.beginTransaction(); try {
            String raw = get("grant");
            if (raw != null) {
                JSONObject grant = new JSONObject(raw);
                if (grant.getJSONObject("session").has("account_binding")) {
                    set("parked:" + grant.getString("profileId"), raw);
                    JSONObject cached=currentLedger(grant);if(cached!=null)set("parked-proofs:"+grant.getString("profileId"),cached.toString());
                }
                else suspendProfile(grant.getString("profileId"));
            }
            db.execSQL("DELETE FROM control WHERE key='grant'");
            set("identity_state", "parked"); clearProofs(); set("needs_floor", "1"); advanceProof();
            set("lease", UUID.randomUUID().toString()); set("owner", ""); advance(); reconciler().invalidate();
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted(); boundary++;
    }
    boolean observeWorkspaceDirectorySession(JSONObject fresh,String cookie)throws Exception {
        String workspace=fresh.getString("workspace_id"),parent=fresh.getString("account_binding"),child=fresh.getString("cache_binding"),member=fresh.getJSONObject("member").getString("id"),role=fresh.getJSONObject("member").getString("role");
        String current=get("grant"),active=current==null?null:new JSONObject(current).getString("profileId");boolean changed=false,activeChanged=false;
        db.beginTransaction();try {
            try(Cursor rows=db.rawQuery("SELECT value FROM control WHERE key='grant' OR key LIKE 'parked:%'",null)) {
                while(rows.moveToNext()){JSONObject grant=new JSONObject(rows.getString(0)),old=grant.getJSONObject("session");String profile=grant.getString("profileId");
                    if(!workspace.equals(old.optString("workspace_id"))||!parent.equals(old.optString("account_binding"))||!OutboxPolicy.hash(cookie).equals(grant.optString("session_ref")))continue;
                    if(!child.equals(old.optString("cache_binding"))||!member.equals(old.getJSONObject("member").optString("id"))) {suspendProfile(profile);changed=true;activeChanged|=profile.equals(active);}
                    else if(!role.equals(grant.optString("role"))||OutboxPolicy.expiry(fresh.getString("expires_at"))<OutboxPolicy.expiry(old.getString("expires_at"))) {
                        set("offline-denied:"+profile,"1");db.execSQL("DELETE FROM control WHERE key=?",new Object[]{"parked-proofs:"+profile});changed=true;
                        if(profile.equals(active)){clearProofs();set("needs_floor","1");set("owner","");set("lease",UUID.randomUUID().toString());advanceProof();activeChanged=true;}
                    }
                }
            }db.setTransactionSuccessful();
        }finally{db.endTransaction();}if(activeChanged){proofCommitted();boundary++;}return changed;
    }
    boolean retireWorkspaceScope(String workspace,String parent,String child,String cookie)throws Exception {
        String current=get("grant");String active=current==null?null:new JSONObject(current).getString("profileId");boolean matched=false,activeChanged=false;
        db.beginTransaction();try {
            try(Cursor rows=db.rawQuery("SELECT value FROM control WHERE key='grant' OR key LIKE 'parked:%'",null)) {
                while(rows.moveToNext()){JSONObject grant=new JSONObject(rows.getString(0)),session=grant.getJSONObject("session");String profile=grant.getString("profileId");
                    if(workspace.equals(session.optString("workspace_id"))&&parent.equals(session.optString("account_binding"))&&child.equals(session.optString("cache_binding"))&&OutboxPolicy.hash(cookie).equals(grant.optString("session_ref"))){suspendProfile(profile);matched=true;activeChanged|=profile.equals(active);}
                }
            }db.setTransactionSuccessful();
        }finally{db.endTransaction();}if(activeChanged){proofCommitted();boundary++;}return matched;
    }
    boolean retainedScopeAllowed(JSONObject scope,String cookie)throws Exception {
        String profile=OutboxPolicy.profile(origin,scope.getString("workspaceId"),scope.getString("memberId"),scope.getString("binding"));
        if(get("suspended:"+profile)!=null||get("offline-denied:"+profile)!=null||tombstone("profile",profile))return false;
        String raw=get("parked:"+profile);if(raw==null)raw=get("grant");if(raw==null)return false;JSONObject grant=new JSONObject(raw);
        return profile.equals(grant.optString("profileId"))&&OutboxPolicy.hash(cookie).equals(grant.optString("session_ref"))&&grant.getLong("validUntil")>System.currentTimeMillis()
            &&scope.getString("accountBinding").equals(grant.getJSONObject("session").optString("account_binding"))
            &&scope.getLong("expiresAt")==OutboxPolicy.expiry(grant.getJSONObject("session").getString("expires_at"));
    }
    boolean requiresWorkspaceReconcile() throws Exception {
        if(!"1".equals(get("account_reconcile_required")))return false;String raw=get("grant");return raw!=null&&new JSONObject(raw).getJSONObject("session").has("account_binding");
    }
    boolean offlineWorkspace() { return "1".equals(get("offline_workspace")); }
    void resumeWorkspaceOffline(JSONObject session,String cookie)throws Exception {
        String profile=OutboxPolicy.profile(origin,session.getString("workspace_id"),session.getJSONObject("member").getString("id"),session.getString("cache_binding"));
        String raw=get("parked:"+profile); if(raw==null)throw new AccessRequired(); JSONObject grant=new JSONObject(raw);
        NativePolicy.require(grant.getString("session_ref").equals(OutboxPolicy.hash(cookie))&&grant.getLong("validUntil")>System.currentTimeMillis()
            &&grant.getJSONObject("session").getString("account_binding").equals(session.getString("account_binding"))
            &&grant.getJSONObject("session").getString("expires_at").equals(session.getString("expires_at")));
        if(get("suspended:"+profile)!=null||get("offline-denied:"+profile)!=null||tombstone("profile",profile))throw new RecoveryRequired();
        String cached=get("parked-proofs:"+profile);NativePolicy.require(cached!=null);
        JSONObject ledger=new JSONObject(cached);NativePolicy.require(profile.equals(ledger.optString("profileId"))&&grant.getString("session_ref").equals(ledger.optString("sessionRef")));
        db.beginTransaction();try {set("grant",raw);set("identity_state","verified");set("offline_cached_proofs",cached);set("offline_workspace","1");set("account_reconcile_required","1");set("needs_floor","1");clearProofs();advanceProof();
            set("owner","");set("lease",UUID.randomUUID().toString());db.execSQL("DELETE FROM control WHERE key=?",new Object[]{"parked:"+profile});db.setTransactionSuccessful();
        }finally{db.endTransaction();}proofCommitted();boundary++;
    }
    private boolean offlineReadable(JSONObject grant)throws Exception {
        if(!offlineWorkspace()||grant==null)return false;String profile=grant.getString("profileId"),actor=OutboxPolicy.actorPrefix(origin,profile);
        try(Cursor rows=db.rawQuery("SELECT bucket,key,rowid,length(payload) FROM records WHERE mode='active' AND profile_id=?",new String[]{profile})) {
            while(rows.moveToNext()) if(!"native".equals(sourceTrust("active",rows.getString(0),rows.getString(1),profile,payload("records",rows.getLong(2),rows.getInt(3)),actor)))return false;
        }return true;
    }
    private boolean offlineAppend(JSONArray changes,JSONObject grant)throws Exception {
        if(!offlineReadable(grant)||changes.length()==0)return false;String profile=grant.getString("profileId");
        String parent=grant.getJSONObject("session").getString("account_binding"),workspace=grant.getJSONObject("session").getString("workspace_id");
        for(int i=0;i<changes.length();i++){
            JSONObject item=changes.getJSONObject(i),value=item.optJSONObject("value");String bucket=item.getString("bucket"),op=item.optString("op");
            if(!"put".equals(op)||value==null)return false;
            if(bucket.equals("profiles")){if(!profile.equals(value.optString("id")))return false;continue;}
            if(!profile.equals(value.optString("profileId")))return false;
            if(Arrays.asList("operations","mutations","drafts","localPages").contains(bucket))continue;
            if(bucket.equals("snapshots")) {
                String resource=value.optString("key"),page=resource.substring(resource.lastIndexOf('|')+1);
                // Existing canonical bytes cannot be replaced offline. A new local page remains subject to the complete creation graph below.
                if(value.getJSONObject("snapshot").optJSONObject("page")==null)return false;
                try(Cursor old=db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='active' AND bucket='snapshots' AND key=? AND profile_id=?",new String[]{key(item.get("key")),profile})) {
                    if(old.moveToFirst()){if(!Arrays.equals(payload("records",old.getLong(0),old.getInt(1)),value.toString().getBytes(StandardCharsets.UTF_8)))return false;}
                    else {boolean creation=false;for(int j=0;j<changes.length();j++){JSONObject other=changes.getJSONObject(j),v=other.optJSONObject("value");if("localPages".equals(other.optString("bucket"))&&v!=null&&resource.equals(v.optString("key"))&&v.getJSONObject("metadata").opt("localOnly")==Boolean.TRUE)creation=true;}if(!creation)return false;}
                }continue;
            }
            if(bucket.equals("meta")) {
                String id=item.optString("key");if(id.equals("workspace-input:"+profile)||id.equals("parked:"+profile)||id.equals("mutation-sequence:"+profile)||id.equals("active:"+parent+":"+workspace)||id.equals("last-profile:"+parent+":"+workspace))continue;
            }return false;
        }return true;
    }
    void revokeAccountWorkspaces() throws Exception {
        db.beginTransaction(); try {
            try (Cursor rows = db.rawQuery("SELECT key,value FROM control WHERE key LIKE 'parked:%'", null)) {
                while (rows.moveToNext()) {
                    JSONObject old = new JSONObject(rows.getString(1));
                    set("suspended:" + old.getString("profileId"), "1");
                }
            }
            db.execSQL("DELETE FROM control WHERE key LIKE 'parked:%'");
            String raw = get("grant");
            if (raw != null && new JSONObject(raw).getJSONObject("session").has("account_binding")) suspendProfile(new JSONObject(raw).getString("profileId"));
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted(); boundary++;
    }
    String nativeActor(String cookie)throws Exception {
        String raw=get("grant");if(raw==null)return null;JSONObject grant=new JSONObject(raw);String profile=grant.getString("profileId");
        if(OutboxPolicy.actorPrefix(origin,profile)==null)return null;
        if(cookie!=null&&!OutboxPolicy.hash(cookie).equals(grant.getString("session_ref")))return null;
        if(cookie==null&&!"local".equals(grant.getString("session_ref"))&&!"blocked".equals(get("identity_state")))return null;
        return profile;
    }
    void eraseActor(String nativeProfile)throws Exception {
        String raw=get("grant");String prefix=OutboxPolicy.actorPrefix(origin,nativeProfile);
        NativePolicy.require(prefix!=null&&raw!=null&&nativeProfile.equals(new JSONObject(raw).getString("profileId")));
        db.beginTransaction();
        try{
            // Attribution comes only from private native grants, never JS deltas.
            Object[] actor=new Object[]{prefix.length(),prefix};
            db.execSQL("INSERT OR IGNORE INTO tombstones(kind,id) SELECT 'profile',profile_id FROM records WHERE substr(profile_id,1,?)=?",actor);
            try(Cursor owned=db.rawQuery("SELECT mode,bucket,key,profile_id,rowid,length(payload) FROM records WHERE substr(profile_id,1,?)=?",new String[]{Integer.toString(prefix.length()),prefix})){
                while(owned.moveToNext()){
                    String mode=owned.getString(0),bucket=owned.getString(1),key=owned.getString(2),profile=owned.getString(3),trust=sourceTrust(mode,bucket,key,profile,payload("records",owned.getLong(4),owned.getInt(5)),prefix);
                    if(!Arrays.asList("native","untrusted").contains(trust))continue;
                    db.execSQL("DELETE FROM records WHERE mode=? AND bucket=? AND key=?",new Object[]{mode,bucket,key});
                    db.execSQL("DELETE FROM native_record_owners WHERE mode=? AND bucket=? AND key=?",new Object[]{mode,bucket,key});
                }
            }
            // Unaccepted parts have no validated complete source shape. Preserve
            // them even when a claimed profile resembles the erased actor.
            db.execSQL("DELETE FROM tx_receipts WHERE tx_id IN (SELECT substr(key,15) FROM control WHERE key LIKE 'receipt-owner:%' AND substr(value,1,?)=?)",actor);
            db.execSQL("DELETE FROM control WHERE key IN (SELECT 'receipt-proof:' || substr(key,15) FROM control WHERE key LIKE 'receipt-owner:%' AND substr(value,1,?)=?)",actor);
            db.execSQL("DELETE FROM control WHERE key LIKE 'receipt-owner:%' AND substr(value,1,?)=?",actor);
            db.execSQL("DELETE FROM native_local_versions_v1 WHERE actor=?", new Object[]{prefix});
            try (Cursor contexts = db.rawQuery("SELECT key,value FROM control WHERE key LIKE 'native-local:%'", null)) {
                while (contexts.moveToNext()) if (prefix.equals(new JSONObject(contexts.getString(1)).opt("actor"))) db.execSQL("DELETE FROM control WHERE key=?", new Object[]{contexts.getString(0)});
            }
            reconciler().eraseActor(prefix);
            db.execSQL("INSERT OR IGNORE INTO tombstones VALUES('profile',?)",new Object[]{nativeProfile});suspendProfile(nativeProfile);db.setTransactionSuccessful();
        }finally{db.endTransaction();}proofCommitted();boundary++;
    }
    private void retentionGate()throws Exception {
        String raw=get("grant");if(raw==null)return;JSONObject grant=new JSONObject(raw);
        if(get("suspended:"+grant.getString("profileId"))!=null)throw new RecoveryRequired();
        if(grant.getLong("validUntil")<=System.currentTimeMillis()){expireCachedGrant(grant);throw new AccessRequired();}
    }
    void grant(JSONObject session, String cookie) throws Exception {
        // This method is called only with an actual native session HTTP response.
        if(offlineWorkspace())set("offline_workspace","0");
        if(session.opt("authenticated")!=Boolean.TRUE||session.optJSONObject("member")==null||session.getJSONObject("member").opt("active")!=Boolean.TRUE){revoke();throw new AccessRequired();}
        String mode = session.getString("mode");
        boolean local = mode.equals("local") && session.opt("required") == Boolean.FALSE && cookie == null;
        NativePolicy.require(local || (mode.equals("accounts") || mode.equals("family")) && cookie != null && !cookie.isEmpty());
        long expiry = local ? System.currentTimeMillis() + OutboxPolicy.LOCAL_TTL : Math.min(OutboxPolicy.expiry(session.getString("expires_at")), System.currentTimeMillis() + OutboxPolicy.LOCAL_TTL);
        NativePolicy.require(expiry > System.currentTimeMillis());
        String profile = OutboxPolicy.profile(origin, OutboxPolicy.text(session.opt("workspace_id"), 1000),
            OutboxPolicy.text(session.getJSONObject("member").opt("id"), 1000), OutboxPolicy.text(session.opt("cache_binding"), 1000));
        JSONObject grant = new JSONObject().put("profileId", profile).put("validUntil", expiry)
            .put("session_ref", cookie == null ? "local" : OutboxPolicy.hash(cookie));
        String role = session.getJSONObject("member").getString("role");
        NativePolicy.require(Arrays.asList("owner", "admin", "member", "guest").contains(role));
        JSONObject observed = new JSONObject(), member = new JSONObject();
        for (String name : Arrays.asList("enabled", "required", "authenticated", "mode", "identity", "expires_at", "workspace_id", "cache_binding", "account_binding", "public_web_origin")) if (session.has(name)) observed.put(name, session.get(name));
        for (String name : Arrays.asList("id", "name", "email", "role", "active")) if (session.getJSONObject("member").has(name)) member.put(name, session.getJSONObject("member").get(name));
        observed.put("member", member); grant.put("role", role).put("session", observed);
        if(session.has("account_binding")) {
            // A freshly observed child/member replacement retires every older incarnation of this workspace under this parent.
            try(Cursor rows=db.rawQuery("SELECT value FROM control WHERE key LIKE 'parked:%'",null)) {
                while(rows.moveToNext()) {JSONObject previous=new JSONObject(rows.getString(0)),identity=previous.getJSONObject("session");String oldProfile=previous.getString("profileId");
                    if(!profile.equals(oldProfile)&&session.getString("workspace_id").equals(identity.optString("workspace_id"))
                        &&session.getString("account_binding").equals(identity.optString("account_binding"))&&grant.getString("session_ref").equals(previous.optString("session_ref")))set("suspended:"+oldProfile,"1");
                }
            }
        }
        String parked = get("parked:" + profile);
        String priorAuthority=parked==null?get("grant"):parked;
        if(priorAuthority!=null) {JSONObject prior=new JSONObject(priorAuthority);
            if(profile.equals(prior.optString("profileId")) && (!role.equals(prior.optString("role")) || !grant.getString("session_ref").equals(prior.optString("session_ref"))))
                db.execSQL("DELETE FROM control WHERE key IN (?,?)",new Object[]{"parked-proofs:"+profile,"offline_cached_proofs"});
        }
        if (parked != null && session.has("account_binding")) {
            JSONObject prior = new JSONObject(parked);
            NativePolicy.require(prior.getString("session_ref").equals(grant.getString("session_ref"))
                && prior.getLong("validUntil") > System.currentTimeMillis()
                && prior.getJSONObject("session").getString("account_binding").equals(session.getString("account_binding")));
            if (get("suspended:" + profile) != null || tombstone("profile", profile)) throw new RecoveryRequired();
            // Fresh native GET re-established the same incarnation; canonical reads must still rebuild all resource proofs.
            set("grant", parked); set("identity_state", "parked");
            db.execSQL("DELETE FROM control WHERE key=?", new Object[]{"parked:" + profile});
        }
        String existing=get("grant");
        if (existing != null && "verified".equals(get("identity_state"))) {
            JSONObject prior = new JSONObject(existing);
            if (profile.equals(prior.getString("profileId")) && grant.getString("session_ref").equals(prior.getString("session_ref")) && prior.getLong("validUntil") <= System.currentTimeMillis()) expireCachedGrant(prior);
        }
        if(existing!=null&&"verified".equals(get("identity_state"))&&get("suspended:"+profile)==null&&!tombstone("profile",profile)){
            JSONObject prior=new JSONObject(existing);
            if(profile.equals(prior.getString("profileId"))&&grant.getString("session_ref").equals(prior.getString("session_ref"))&&prior.getLong("validUntil")>System.currentTimeMillis()&&grant.getLong("validUntil")>=prior.getLong("validUntil")
                &&prior.optJSONObject("session")!=null&&prior.getJSONObject("session").has("expires_at")&&observed.has("expires_at"))observed.put("expires_at",prior.getJSONObject("session").get("expires_at"));
            if(profile.equals(prior.getString("profileId"))&&grant.getString("session_ref").equals(prior.getString("session_ref"))&&prior.getLong("validUntil")>System.currentTimeMillis()
                &&grant.getLong("validUntil")>=prior.getLong("validUntil")&&role.equals(prior.optString("role"))&&prior.optJSONObject("session")!=null&&canonical(prior.getJSONObject("session"),false).equals(canonical(observed,false)))return;
        }
        if(session.has("account_binding"))set("account_reconcile_required","1");
        boolean changed = false,recoveryRequired=false;
        db.beginTransaction();
        try {
            String old = get("grant");
            JSONObject prior=old==null?null:new JSONObject(old);boolean same=prior!=null&&profile.equals(prior.getString("profileId"))&&grant.getString("session_ref").equals(prior.getString("session_ref"));
            boolean renewedCache = same && "expired".equals(get("identity_state")) && prior.getString("session_ref").equals(get("cache-expired:" + profile));
            if(get("suspended:"+profile)!=null||tombstone("profile",profile)||prior!=null&&profile.equals(prior.getString("profileId"))&&(!same||prior.getLong("validUntil")<=System.currentTimeMillis()&&!renewedCache)){
                if(!(same&&"blocked".equals(get("identity_state"))&&get("suspended:"+profile)!=null)){
                    if(prior!=null&&!profile.equals(prior.getString("profileId")))suspendProfile(prior.getString("profileId"));
                    set("grant",grant.toString());suspendProfile(profile);
                }recoveryRequired=true;
            }else{
                if(prior!=null&&!same)suspendProfile(prior.getString("profileId"));
                if(!same){clearProofs();set("needs_floor","1");advanceProof();set("lease",UUID.randomUUID().toString());set("owner","");advance();changed=true;}
                else if (renewedCache) {
                    clearProofs(); set("needs_floor", "1"); advanceProof(); changed = true;
                    db.execSQL("DELETE FROM control WHERE key=?", new Object[]{"cache-expired:" + profile});
                }
                else{grant.put("validUntil",Math.min(grant.getLong("validUntil"),prior.getLong("validUntil")));if(grant.getLong("validUntil")<prior.getLong("validUntil"))advanceProof();
                    if(!role.equals(prior.optString("role"))){clearProofs();set("needs_floor","1");set("lease",UUID.randomUUID().toString());set("owner","");advanceProof();changed=true;}}
                set("grant",grant.toString());set("identity_state","verified");
            }
            // Grant refresh does not move the data head; it contains no JS records.
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted(); if (changed) boundary++;if(recoveryRequired)throw new RecoveryRequired();
    }
    JSONObject verified(String cookie, boolean blocked) throws Exception {
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
    void envelope(JSONObject value, String profile) throws Exception {
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
    String canonical(Object value, boolean proofRoot) throws Exception {
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
    JSONObject currentLedger(JSONObject grant) throws Exception {
        JSONObject ledger = ledger();
        if(offlineWorkspace()) {String cached=get("offline_cached_proofs");ledger=cached==null?null:new JSONObject(cached);if(ledger!=null)ledger.put("owner",get("owner"));}
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
        String[] resource = OutboxPolicy.observedResource(method, path, status); if (resource == null) return;
        requireOwner(owner);
        retentionGate();
        // A write denial does not establish a loss of read permission.
        boolean operationReply = "POST".equals(method);
        JSONObject grant = verified(cookie, blocked); if (grant == null) throw new AccessRequired();
        String kind = resource[0], id = resource[1], profile = grant.getString("profileId"), key = proofKey(kind, id);
        if (status == 200 && !kind.equals("workspace") && tombstone("resource", profile + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id))) throw new AccessRequired();
        JSONObject previousLedger = ledger(), entries = new JSONObject();
        long floorAccess = 0, floorData = 0;
        String savedFloor = get(floorKey(grant)); if (savedFloor != null) { JSONObject floor = new JSONObject(savedFloor); floorAccess = number(floor, "maxAccessRevision"); floorData = number(floor, "maxDataRevision"); }
        if (previousLedger != null && profile.equals(previousLedger.getString("profileId")) && grant.getString("session_ref").equals(previousLedger.getString("sessionRef"))) {
            floorAccess = Math.max(floorAccess, previousLedger.getLong("maxAccessRevision")); floorData = Math.max(floorData, previousLedger.getLong("maxDataRevision"));
            JSONObject workspaceDenial = previousLedger.getJSONObject("entries").optJSONObject(proofKey("workspace", "workspace"));
            if (status == 200 && workspaceDenial != null && workspaceDenial.opt("terminal") == Boolean.TRUE) throw new AccessRequired();
        }
        if (previousLedger != null && profile.equals(previousLedger.getString("profileId")) && owner.equals(previousLedger.getString("owner"))
            && grant.getString("session_ref").equals(previousLedger.getString("sessionRef"))) entries = previousLedger.getJSONObject("entries");
        JSONObject previous = entries.optJSONObject(key), proof = null; boolean malformed = false;
        long now = System.currentTimeMillis();
        if (status == 200) {
            try {
                if (operationReply) NativePolicy.require(raw != null && raw.length <= OutboxPolicy.RECORD);
                JSONObject body = new JSONObject(OutboxPolicy.utf8(raw));
                if (operationReply) {
                    JSONArray acknowledgement = body.getJSONArray("ack"); NativePolicy.require(acknowledgement.length() <= 1000);
                    // Repeated IDs are legitimate ACKs, never identity authority.
                    for (int i = 0; i < acknowledgement.length(); i++) OutboxPolicy.acknowledgement(acknowledgement.get(i));
                }
                envelope(body, profile);
                long access = number(body, "access_revision"), data = number(body, "data_revision");
                if (!OutboxPolicy.freshRevisions(access, data, floorAccess, floorData)) throw new AccessRequired();
                if (previous != null && previous.has("accessRevision") && !OutboxPolicy.freshRevisions(access, data, previous.getLong("accessRevision"), previous.getLong("dataRevision"))) throw new AccessRequired();
                proof = new JSONObject().put("profileId", profile).put("kind", kind).put("id", id).put("accessRevision", access).put("dataRevision", data)
                    .put("epoch", JSONObject.NULL).put("seq", JSONObject.NULL).put("locked", false).put("archived", false)
                    .put("observedAt", now).put("validUntil", Math.min(grant.getLong("validUntil"), now + OutboxPolicy.LOCAL_TTL));
                if (kind.equals("workspace")) {
                    proof.put("accessLevel", 1).put("pages", projection(body.getJSONArray("pages"), true, null))
                        .put("databases", projection(body.getJSONArray("databases"), false, null));
                    JSONObject spaces = new JSONObject(); JSONArray teamspaces = body.optJSONArray("teamspaces");
                    if (teamspaces != null) { NativePolicy.require(teamspaces.length() <= 100000); for (int i = 0; i < teamspaces.length(); i++) { JSONObject item = teamspaces.getJSONObject(i); String space = identity(item, "id"); NativePolicy.require(!spaces.has(space)); spaces.put(space, level(item)); } }
                    proof.put("teamspaces", spaces);
                } else if (kind.equals("page")) {
                    JSONObject page = body.getJSONObject("page"); NativePolicy.require(id.equals(identity(page, "id")));
                    long accessLevel = level(body); NativePolicy.require(level(page) == accessLevel);
                    if (operationReply && previous != null && previous.opt("denied") != Boolean.TRUE
                        && identity(body, "epoch").equals(previous.opt("epoch")) && number(body, "seq") < previous.getLong("seq")) throw new AccessRequired();
                    proof.put("accessLevel", accessLevel).put("locked", flag(page, "locked")).put("archived", flag(page, "archived"))
                        .put("epoch", identity(body, "epoch")).put("seq", number(body, "seq"))
                        .put("teamspaceId", page.isNull("teamspace_id") ? JSONObject.NULL : identity(page, "teamspace_id"));
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
        // A malformed successful write requires a fresh canonical read. Keep all
        // input and revision floors, but never retain a partially built proof.
        if (operationReply && malformed) proof = null;
        if (proof == null) {
            proof = new JSONObject().put("profileId", profile).put("kind", kind).put("id", id).put("denied", true).put("observedAt", now)
                .put("terminal", status == 403 || status == 404)
                .put("validUntil", Math.min(grant.getLong("validUntil"), now + OutboxPolicy.LOCAL_TTL));
            if (previous != null && previous.has("accessRevision")) proof.put("accessRevision", previous.getLong("accessRevision")).put("dataRevision", previous.getLong("dataRevision"));
        }
        if (!malformed && status == 200 && previous != null && previous.opt("denied") != Boolean.TRUE
            && previous.getLong("accessRevision") == proof.getLong("accessRevision") && previous.getLong("dataRevision") == proof.getLong("dataRevision")
            && !semantic(previous).equals(semantic(proof))) throw new AccessRequired();
        Set<String> serverPages = new HashSet<>(); String observedWorkspace = grant.getJSONObject("session").getString("workspace_id");
        if (!malformed && status == 200) {
            if (kind.equals("page")) serverPages.add(id);
            if (kind.equals("workspace")) { Iterator<String> ids = proof.getJSONObject("pages").keys(); while (ids.hasNext()) serverPages.add(ids.next()); }
        }
        boolean newlyServer = false; for (String page : serverPages) newlyServer |= !serverObserved(observedWorkspace, page);
        if (previous != null && OutboxPolicy.stableObservation(semantic(previous).equals(semantic(proof)), now, previous.getLong("validUntil"), grant.getLong("validUntil"))) {
            if (newlyServer) {
                db.beginTransaction(); try { for (String page : serverPages) markServerPage(observedWorkspace, page); advanceProof(); db.setTransactionSuccessful(); } finally { db.endTransaction(); }
                proofCommitted();
            }
            if(!malformed&&status==200)observedResource(grant,kind,id,proof);
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
            for (String page : serverPages) markServerPage(observedWorkspace, page);
            set("resource_proofs", encodedLedger);
            set(floorKey(grant), new JSONObject().put("maxAccessRevision", next.getLong("maxAccessRevision")).put("maxDataRevision", next.getLong("maxDataRevision")).toString());
            if(!malformed&&!oversized&&status==200)observedResource(grant,kind,id,proof);
            if(kind.equals("workspace")&&status==200&&!malformed&&!oversized)set("needs_floor","0");
            if ((status == 403 || status == 404) && !kind.equals("workspace")) purge("resource", profile + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id));
            advanceProof(); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted();
        deliveryDeadline = Math.min(proof.getLong("validUntil"), grant.getLong("validUntil"));
        if (malformed || oversized) throw new AccessRequired();
    }
    static final class AccessReport {
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
        if (kind.equals("page") && validatedGraph != null && validatedGraph.local(id)) return validatedGraph.page(id);
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
        if (row == null && validatedGraph != null && validatedGraph.row(database.getString("id"), target)) return;
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
            if(ids.length()==0)continue;
            if (relations.isNull(field)) {
                for (int i = 0; i < ids.length(); i++) {
                    String target = OutboxPolicy.text(ids.get(i), 1000); boolean found = validatedGraph!=null&&validatedGraph.anyLocalRow(target);
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
    private JSONObject record(long row, int size) throws Exception { return new JSONObject(OutboxPolicy.utf8(payload("records", row, size))); }
    private void basis(JSONObject grant, String resource, String id, JSONObject entry, AccessReport report) throws Exception {
        try (Cursor cached = db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='active' AND bucket='snapshots' AND resource_key=? AND profile_id=? LIMIT 1", new String[]{resource, grant.getString("profileId")})) {
            if (!cached.moveToFirst()) { report.add("page", id, "missing"); return; }
            JSONObject snapshot = record(cached.getLong(0), cached.getInt(1)).getJSONObject("snapshot"); envelope(snapshot, grant.getString("profileId"));
            sameVersion(snapshot, entry, "page", id, report);
            if (entry.isNull("epoch") || !identity(snapshot, "epoch").equals(entry.getString("epoch")) || number(snapshot, "seq") != entry.getLong("seq")) report.add("page", id, "epoch_changed");
        }
    }
    AccessReport preflight(JSONObject grant) throws Exception {
        AccessReport report = new AccessReport(grant.getLong("validUntil")); JSONObject ledger = currentLedger(grant);
        String profile = grant.getString("profileId"), actor = OutboxPolicy.actorPrefix(origin, profile);
        try (Cursor qualified = db.rawQuery("SELECT bucket,key,rowid,length(payload) FROM records WHERE mode='active' AND profile_id=?", new String[]{profile})) {
            while (qualified.moveToNext()) if (!"native".equals(sourceTrust("active", qualified.getString(0), qualified.getString(1), profile, payload("records",qualified.getLong(2),qualified.getInt(3)), actor))) {
                report.add("workspace", "workspace", "unconfirmed_input"); deliveryDeadline = grant.getLong("validUntil"); return report;
            }
        }
        validatedGraph = null;
        try { validatedGraph = new NativeLocalGraph(this, grant); }
        catch (org.json.JSONException | IllegalArgumentException invalid) { report.add("workspace", "workspace", "local_dependency"); deliveryDeadline = grant.getLong("validUntil"); return report; }
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
                if (bucket.equals("localPages") && value.getJSONObject("metadata").opt("localOnly") == Boolean.TRUE) {
                    if (validatedGraph == null || !validatedGraph.local(id)) report.add("page", id, "local_dependency");
                    continue;
                }
                int needed = bucket.equals("operations") || bucket.equals("mutations") || bucket.equals("transfers") ? 3 : 1;
                JSONObject entry = proof(ledger, grant, kind, id, report, needed); if (entry == null) continue;
                if (bucket.equals("snapshots") || bucket.equals("databaseSnapshots")) {
                    JSONObject snapshot = value.getJSONObject("snapshot"); envelope(snapshot, grant.getString("profileId"));
                    if (kind.equals("page") && validatedGraph != null && validatedGraph.newlyLocal(id)) continue;
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
                    } else {
                        boolean creation = op.equals("page.create") && validatedGraph != null && (validatedGraph.local(id)
                            || appliedSync(grant, operation) != null && !entry.isNull("epoch") && identity(operation, "document_epoch").equals(entry.getString("epoch")));
                        if (!id.equals(identity(operation, "target_id")) || !(op.equals("page.patch") || creation)) report.add(kind, id, "denied");
                    }
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
        retentionGate();
    }
    private long intentProof(JSONObject input) throws AccessRequired {
        try { return OutboxPolicy.integer(input.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1); }
        catch (IllegalArgumentException missing) { throw new AccessRequired(); }
    }
    JSObject open(long generation, String cookie, boolean blocked, String owner) throws Exception {
        NativePolicy.require(!failed);
        if (knownBlockedProfile(cookie, blocked) != null) return blockedHeader(generation);
        retentionGate();
        boolean changed = false;
        db.beginTransaction();
        try {
            if (!owner.equals(get("owner")) || !Long.toString(generation).equals(get("generation"))) {
                String priorOwner = get("owner"), priorLedger = get("resource_proofs");
                JSONObject grant = verified(cookie, blocked), ledger = priorLedger == null ? null : new JSONObject(priorLedger);
                boolean transferable = priorOwner != null && !priorOwner.isEmpty() && grant != null && ledger != null
                    && priorOwner.equals(ledger.optString("owner")) && grant.getString("profileId").equals(ledger.optString("profileId"))
                    && grant.getString("session_ref").equals(ledger.optString("sessionRef")) && grant.has("role")
                    && grant.optJSONObject("session") != null && grant.getJSONObject("session").getJSONObject("member").opt("active") == Boolean.TRUE
                    && grant.getString("role").equals(grant.getJSONObject("session").getJSONObject("member").optString("role"))
                    && !"1".equals(get("needs_floor"));
                set("lease", UUID.randomUUID().toString()); set("owner", owner); set("generation", Long.toString(generation));
                if (transferable) {
                    // Recreate only the process owner. Absolute deadlines, floors,
                    // and privately attributed record bytes remain unchanged.
                    ledger.put("owner", owner); set("resource_proofs", ledger.toString());
                    if (preflight(grant).issues.length() != 0 || verified(cookie, blocked) == null) set("resource_proofs", priorLedger);
                }
                advanceProof(); changed = true;
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
        out.put("proofEpoch", proofEpoch()); out.put("resourceAccess", grant != null && (offlineReadable(grant) || !"1".equals(get("needs_floor"))) && report.issues.length() == 0 ? "ready" : "required");
        out.put("accessIssues", grant == null ? new JSONArray() : report.issues); out.put("accessIssuesTruncated", grant != null && report.truncated);
        out.put("reconciliationHandles", grant == null ? new JSONArray() : reconciler().handles(grant, owner));
        deliveryDeadline = grant == null ? 0 : Math.min(deliveryDeadline, grant.getLong("validUntil")); return out;
    }
    JSObject stage(JSONObject input, long generation) throws Exception {
        scope(input, generation);
        String tx = OutboxPolicy.id(input.getString("txId"));
        String currentGrant = get("grant");
        if(currentGrant==null||!"verified".equals(get("identity_state"))||new JSONObject(currentGrant).getLong("validUntil")<=System.currentTimeMillis())throw new AccessRequired();
        if (currentGrant != null && get(NativeReconcile.cancelKey(new JSONObject(currentGrant).getString("profileId"), tx)) != null) throw new NativeReconcile.Failure("OUTBOX_RECONCILE_CANCELLED");
        long proof = intentProof(input);
        int part = (int) OutboxPolicy.integer(input.opt("part"), 0, OutboxPolicy.TRANSACTION / OutboxPolicy.PART - 1);
        long base = OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1);
        byte[] bytes = OutboxPolicy.part(input.getString("bytesBase64"));
        db.beginTransaction();
        try {
            String recorded = get("staged-proof:" + tx), accepted = get("receipt-proof:" + tx);
            String nativeGrant=get("grant"),receiptOwner=get("receipt-owner:"+tx);
            if(accepted!=null&&receiptOwner!=null&&(nativeGrant==null||!receiptOwner.equals(new JSONObject(nativeGrant).getString("profileId"))))throw new RecoveryRequired();
            if (accepted == null) try (Cursor legacy = db.rawQuery("SELECT 1 FROM tx_receipts WHERE tx_id=? LIMIT 1", new String[]{tx})) { if (legacy.moveToFirst()) throw new AccessRequired(); }
            if (accepted != null && !accepted.equals(Long.toString(proof)) || recorded != null && !recorded.equals(Long.toString(proof))) throw new AccessRequired();
            if (recorded == null) {
                try (Cursor old = db.rawQuery("SELECT 1 FROM staging WHERE tx_id=? LIMIT 1", new String[]{tx})) { if (old.moveToFirst()) throw new AccessRequired(); }
                set("staged-proof:" + tx, Long.toString(proof));
                if(nativeGrant!=null&&"verified".equals(get("identity_state")))set("staging-owner:"+tx,new JSONObject(nativeGrant).getString("profileId"));
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
    String key(Object key) throws Exception {
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
            if (op.equals("delete")) { NativePolicy.require(knownProfile(profile)); suspendProfile(profile); return; }
            if (value != null) NativePolicy.require(value.getString("id").equals(profile) && origin.equals(value.getString("origin"))
                && OutboxPolicy.profile(origin, value.getString("workspaceId"), value.getString("memberId"), value.getString("cacheBinding")).equals(profile)
                && (!mode.equals("active") || grant != null && value.getDouble("validUntil") <= grant.getLong("validUntil")));
            if(value!=null && mode.equals("active") && grant!=null && grant.getJSONObject("session").has("account_binding")) NativePolicy.require(grant.getJSONObject("session").getString("account_binding").equals(value.optString("accountBinding")));
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
                if(whole){suspendProfile(owner);return;}if(mode.equals("active")){if(get("suspended:"+owner)!=null||grant==null||!owner.equals(grant.getString("profileId")))throw new RecoveryRequired();purge("resource",identity);}profile=owner;
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
                try (Cursor previous = db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='active' AND bucket='meta' AND key=?", new String[]{key})) {
                    if (previous.moveToFirst()) NativePolicy.require(Arrays.equals(payload("records",previous.getLong(0),previous.getInt(1)), value.toString().getBytes(StandardCharsets.UTF_8)));
                }
            } else {
                String parent=grant==null?null:grant.getJSONObject("session").optString("account_binding",null);
                String workspace=grant==null?null:grant.getJSONObject("session").getString("workspace_id");
                String actual=grant==null?null:grant.getString("profileId");
                boolean scopedPointer=parent!=null && (id.equals("active:"+parent+":"+workspace)||id.equals("last-profile:"+parent+":"+workspace));
                boolean scopedData=parent!=null && (id.equals("parked:"+actual)||id.equals("workspace-input:"+actual)||id.equals("ended-account:"+parent+":"+actual));
                NativePolicy.require((parent==null || !mode.equals("active")) && (id.equals("active") || id.equals("last-profile")) || id.startsWith("mutation-sequence:") || scopedPointer || scopedData);
                if(value!=null && (scopedPointer||scopedData)) NativePolicy.require(actual.equals(value.optString("profileId")) && (!id.startsWith("parked:")||parent.equals(value.optString("accountBinding"))));
                if (op.equals("delete")) {try(Cursor original=db.rawQuery("SELECT profile_id FROM records WHERE mode=? AND bucket='meta' AND key=?",new String[]{mode,key})){if(original.moveToFirst()){String owner=original.getString(0);if(get("suspended:"+owner)!=null||grant==null||!owner.equals(grant.getString("profileId")))return;}}if(!mode.equals("quarantine"))db.execSQL("DELETE FROM records WHERE mode=? AND bucket='meta' AND key=?", new Object[]{mode, key}); return; }
                profile = id.equals("active") || id.equals("last-profile") || scopedPointer || scopedData ? value.getString("profileId") : id.substring("mutation-sequence:".length()); NativePolicy.require(id.equals(value.getString("id")));
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
        if(value==null&&(get("suspended:"+profile)!=null||grant==null||!profile.equals(grant.getString("profileId"))))return;
        if(value!=null&&get("suspended:"+profile)!=null)throw new RecoveryRequired();
        if (mode.equals("active")) {
            boolean cleanup = op.equals("delete") || bucket.equals("meta") && ((String) originalKey).startsWith("revoked");
            NativePolicy.require(cleanup ? knownProfile(profile) : grant != null && profile.equals(grant.getString("profileId")) && !tombstone("profile", profile)
                && (resource == null || !tombstone("resource", resource)));
        } else NativePolicy.require(profile != null && profile.startsWith(origin + "|"));
        if (value == null) {if(!mode.equals("quarantine"))db.execSQL("DELETE FROM records WHERE mode=? AND bucket=? AND key=?", new Object[]{mode, bucket, key});}
        else {
            byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8); NativePolicy.require(bytes.length <= OutboxPolicy.RECORD);
            if(mode.equals("quarantine"))try(Cursor original=db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='quarantine' AND bucket=? AND key=?",new String[]{bucket,key})){if(original.moveToFirst()&&!Arrays.equals(payload("records",original.getLong(0),original.getInt(1)),bytes)){reconciler().archiveVersion(profile, resource, bucket, key, bytes, "quarantine_collision");return;}}
            db.execSQL("INSERT OR REPLACE INTO records(mode,bucket,key,profile_id,resource_key,payload) VALUES(?,?,?,?,?,?)", new Object[]{mode, bucket, key, profile, resource, bytes});
            qualify(mode, bucket, key, profile, bytes, grant, false);
        }
    }
    JSObject commit(JSONObject input, long generation, String cookie, boolean blocked) throws Exception {
        return commit(input, generation, cookie, blocked, false);
    }
    JSObject commit(JSONObject input, long generation, String cookie, boolean blocked, boolean quarantineOnly) throws Exception {
        if (knownBlockedProfile(cookie, blocked) != null) return terminalReceipt(input, generation, cookie, blocked, true);
        scope(input, generation);
        String tx = OutboxPolicy.id(input.getString("txId")), digest = input.getString("digest");
        String currentGrant = get("grant");
        if (currentGrant != null && get(NativeReconcile.cancelKey(new JSONObject(currentGrant).getString("profileId"), tx)) != null) throw new NativeReconcile.Failure("OUTBOX_RECONCILE_CANCELLED");
        NativePolicy.require(digest.matches("[0-9a-f]{64}"));
        long result;
        db.beginTransaction();
        try {
            try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
                if (c.moveToFirst()) {
                    NativePolicy.require(c.getString(0).equals(digest)); result = c.getLong(1);
                    String receiptOwner=get("receipt-owner:"+tx),nativeGrant=get("grant");if(receiptOwner!=null&&(nativeGrant==null||!receiptOwner.equals(new JSONObject(nativeGrant).getString("profileId"))))throw new RecoveryRequired();
                    String original = get("receipt-proof:" + tx); if (original == null) throw new AccessRequired();
                    String stageOwner=get("staging-owner:"+tx);
                    if(stageOwner!=null&&nativeGrant!=null&&stageOwner.equals(new JSONObject(nativeGrant).getString("profileId"))){db.execSQL("DELETE FROM staging WHERE tx_id=?", new Object[]{tx});db.execSQL("DELETE FROM control WHERE key=?", new Object[]{"staged-proof:" + tx});}
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
            try { NativeRecovery.jsonSafe(delta); } catch (Exception malformed) { throw new IllegalArgumentException("Malformed native input"); }
            NativePolicy.require(OutboxPolicy.integer(delta.opt("version"), 1, 1) == 1 && origin.equals(delta.getString("origin")));
            String mode = delta.getString("mode"); NativePolicy.require(mode.equals("active") || mode.equals("quarantine"));
            NativePolicy.require(!quarantineOnly || mode.equals("quarantine"));
            JSONObject grant = verified(cookie, blocked);
            JSONArray changes = delta.getJSONArray("changes"); NativePolicy.require(changes.length() <= 100000
                && (!mode.equals("active") || grant != null || changes.length() > 0));
            boolean cleanup = true;
            for (int i = 0; i < changes.length(); i++) {
                JSONObject item = changes.getJSONObject(i);
                if (!"delete".equals(item.getString("op")) && !("meta".equals(item.getString("bucket")) && item.get("key") instanceof String
                    && (item.getString("key").startsWith("revoked:") || item.getString("key").startsWith("revoked-resource:")))) cleanup = false;
            }
            boolean offlineAppend=offlineAppend(changes,grant);
            if (mode.equals("active") && !cleanup && (grant == null || "1".equals(get("needs_floor"))&&!offlineAppend || proof != proofEpoch())) throw new AccessRequired();
            Set<String> newLocalPages = new HashSet<>();
            if (mode.equals("active") && !cleanup && grant != null) for (int i = 0; i < changes.length(); i++) {
                JSONObject change = changes.getJSONObject(i), value = change.optJSONObject("value"), operation = value == null ? null : value.optJSONObject("operation");
                if ("put".equals(change.opt("op")) && "mutations".equals(change.opt("bucket")) && operation != null && "page.create".equals(operation.opt("kind"))) {
                    try (Cursor old = db.rawQuery("SELECT 1 FROM records WHERE mode='active' AND bucket='mutations' AND key=?", new String[]{key(change.get("key"))})) {
                        if (!old.moveToFirst()) newLocalPages.add(operation.getString("target_id"));
                    }
                }
            }
            boolean terminal = false;
            if (mode.equals("active") && cleanup && grant != null) for (int i = 0; i < changes.length(); i++) {
                JSONObject item = changes.getJSONObject(i); String profile = grant.getString("profileId");
                terminal |= "profiles".equals(item.getString("bucket")) && "delete".equals(item.getString("op")) && profile.equals(item.opt("key"))
                    || "meta".equals(item.getString("bucket")) && "put".equals(item.getString("op")) && ("revoked:" + profile).equals(item.opt("key"));
            }
            applyingDelta = true;
            try { for (int i = 0; i < changes.length(); i++) change(changes.getJSONObject(i), mode, grant); }
            finally { applyingDelta = false; }
            if (mode.equals("active") && !cleanup) {
                if (grant == null || preflight(grant).issues.length() > 0 || System.currentTimeMillis() >= grant.getLong("validUntil")) throw new AccessRequired();
                stampLocalVersions(grant, newLocalPages, changes);
            }
            result = advance();
            db.execSQL("INSERT INTO tx_receipts(tx_id,digest,head) VALUES(?,?,?)", new Object[]{tx, digest, result});
            set("receipt-proof:" + tx, Long.toString(proof));
            if(grant!=null)set("receipt-owner:"+tx,grant.getString("profileId"));
            if (terminal && grant.getString("profileId").equals(knownBlockedProfile(cookie, blocked))) {
                set("terminal-receipt:" + tx, new JSONObject().put("version", 1).put("profileId", grant.getString("profileId"))
                    .put("sessionRef", grant.getString("session_ref")).put("lease", input.getString("lease")).put("baseHead", base)
                    .put("proofEpoch", proof).put("digest", digest).put("head", result).put("postLease", get("lease"))
                    .put("postProof", Long.parseLong(get("proof_epoch"))).toString());
            }
            db.execSQL("DELETE FROM staging WHERE tx_id=?", new Object[]{tx});
            db.execSQL("DELETE FROM control WHERE key=?", new Object[]{"staged-proof:" + tx}); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        proofCommitted();boundary++; // A delayed page must also be fenced by resource/profile purge deltas.
        try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
            NativePolicy.require(c.moveToFirst() && c.getString(0).equals(digest) && c.getLong(1) == result);
        }
        return receipt(generation, result, tx, Long.parseLong(get("receipt-proof:" + tx)));
    }
    private JSObject receipt(long generation, long head, String tx, long proof) {
        JSObject out = new JSObject(); out.put("generation", generation); out.put("head", head); out.put("txId", tx); out.put("proofEpoch", proof); return out;
    }
    JSObject read(JSONObject input, long generation, String cookie, boolean blocked) throws Exception {
        scope(input, generation); JSONObject grant = verified(cookie, blocked); if (grant == null||"1".equals(get("needs_floor"))&&!offlineReadable(grant)) throw new AccessRequired();
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
