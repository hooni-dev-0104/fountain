package dev.fountain.workspace;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native-only canonical collector. Network bytes enter only through admission tags. */
final class NativeReconcile {
    static final int MAX_ITEMS = 1000, PAGE = 32;
    static final long TTL = 120000;
    private final NativeOutbox host;
    private final SQLiteDatabase db;
    static final class Failure extends NativeOutbox.AccessRequired {
        final String code;
        Failure(String code) { this.code = code; }
    }
    private static final class UnsupportedBody extends Exception {}
    static final class Tag {
        final String plan, kind, id;
        final int sweep;
        final long sequence;
        Tag(String plan, int sweep, String kind, String id, long sequence) {
            this.plan = plan; this.sweep = sweep; this.kind = kind; this.id = id; this.sequence = sequence;
        }
    }
    NativeReconcile(NativeOutbox host) {
        this.host = host; db = host.db;
        db.execSQL(NativeSyncReceipts.SCHEMA);
        db.execSQL(NativeSyncReceipts.META_SCHEMA);
        db.execSQL("CREATE TABLE IF NOT EXISTS reconcile_plans(id TEXT PRIMARY KEY,metadata TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS reconcile_rows(plan_id TEXT NOT NULL,phase TEXT NOT NULL,mode TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,profile_id TEXT NOT NULL,resource_key TEXT,payload BLOB NOT NULL,PRIMARY KEY(plan_id,phase,mode,bucket,key))");
        db.execSQL("CREATE TABLE IF NOT EXISTS reconcile_capture(plan_id TEXT NOT NULL,sweep INTEGER NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,status INTEGER NOT NULL,part INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(plan_id,sweep,kind,id,part))");
        db.execSQL("CREATE TABLE IF NOT EXISTS reconcile_receipts(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,owner TEXT NOT NULL,session_ref TEXT NOT NULL,lease TEXT NOT NULL,checksum TEXT NOT NULL,payload TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS native_reconcile_ready(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,session_ref TEXT NOT NULL,lease TEXT NOT NULL,source_head INTEGER NOT NULL,proof_epoch INTEGER NOT NULL,checksum TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS native_reconcile_cancelled(profile_id TEXT NOT NULL,id TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(profile_id,id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS reconcile_handles(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,owner TEXT NOT NULL,session_ref TEXT NOT NULL,source_profile TEXT NOT NULL,source_mode TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS native_recovery_records(id TEXT PRIMARY KEY,version INTEGER NOT NULL,profile_id TEXT NOT NULL,resource_key TEXT,bucket TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL)");
        Set<String> archiveColumns = new HashSet<>(); try (Cursor c = db.rawQuery("PRAGMA table_info(native_recovery_records)", null)) { while (c.moveToNext()) archiveColumns.add(c.getString(1)); }
        if (!archiveColumns.contains("actor")) db.execSQL("ALTER TABLE native_recovery_records ADD COLUMN actor TEXT NOT NULL DEFAULT ''");
        if (!archiveColumns.contains("trust")) db.execSQL("ALTER TABLE native_recovery_records ADD COLUMN trust TEXT NOT NULL DEFAULT 'opaque'");
    }
    private static void fields(JSONObject input, String... names) throws Exception {
        Set<String> allowed = new HashSet<>(Arrays.asList(names)); Iterator<String> keys = input.keys();
        while (keys.hasNext()) NativePolicy.require(allowed.contains(keys.next()));
        for (String name : names) if (!name.equals("handles") && !name.equals("reconciliations")) NativePolicy.require(input.has(name));
    }
    private JSONObject plan() throws Exception {
        try (Cursor c = db.rawQuery("SELECT rowid,length(CAST(metadata AS BLOB)) FROM reconcile_plans LIMIT 1", null)) { return c.moveToFirst() ? new JSONObject(OutboxPolicy.utf8(host.columnBytes("reconcile_plans", "metadata", c.getLong(0), c.getInt(1)))) : null; }
    }
    private void save(JSONObject plan) throws Exception {
        String encoded = plan.toString(); long size = encoded.getBytes(StandardCharsets.UTF_8).length;
        if (size > OutboxPolicy.RECORD) throw new Failure("OUTBOX_RECONCILE_LIMIT");
        try (Cursor total = db.rawQuery("SELECT (SELECT COALESCE(sum(length(payload)),0) FROM reconcile_rows WHERE plan_id=?)+(SELECT COALESCE(sum(length(payload)),0) FROM reconcile_capture WHERE plan_id=?)", new String[]{plan.getString("id"), plan.getString("id")})) {
            if (!total.moveToFirst() || total.getLong(0) + size > OutboxPolicy.TRANSACTION) throw new Failure("OUTBOX_RECONCILE_LIMIT");
        }
        db.execSQL("INSERT OR REPLACE INTO reconcile_plans VALUES(?,?)", new Object[]{plan.getString("id"), encoded});
    }
    private void discard(String id) {
        db.execSQL("DELETE FROM reconcile_capture WHERE plan_id=?", new Object[]{id});
        db.execSQL("DELETE FROM reconcile_rows WHERE plan_id=?", new Object[]{id});
        db.execSQL("DELETE FROM reconcile_plans WHERE id=?", new Object[]{id});
    }
    void invalidate()throws Exception{JSONObject current=plan();if(current!=null)discard(current.getString("id"));}
    private String inventory(String profile, String mode) throws Exception {
        StringBuilder digest = new StringBuilder(); long bytes = 0; int count = 0;
        String sql = mode.equals("archive") ? "SELECT a.bucket,a.key,a.resource_key,length(r.payload),r.rowid FROM native_recovery_records a JOIN recovery r ON r.id=a.id WHERE a.profile_id=? ORDER BY a.id" : "SELECT bucket,key,resource_key,length(payload),rowid FROM records WHERE profile_id=? AND mode=? ORDER BY bucket,key";
        try (Cursor c = db.rawQuery(sql, mode.equals("archive") ? new String[]{profile} : new String[]{profile, mode})) {
            while (c.moveToNext()) {
                byte[] raw = host.payload(mode.equals("archive") ? "recovery" : "records", c.getLong(4), c.getInt(3)); bytes += raw.length;
                if (++count > 100000 || raw.length > OutboxPolicy.RECORD || bytes > OutboxPolicy.TRANSACTION) throw new Failure("OUTBOX_RECONCILE_LIMIT");
                digest.append(host.canonical(new JSONArray().put(c.getString(0)).put(c.getString(1)).put(c.isNull(2) ? JSONObject.NULL : c.getString(2)).put(OutboxPolicy.hash(raw)), false));
            }
        }
        return OutboxPolicy.hash(digest.toString());
    }
    private String sourceDigest(JSONObject p) throws Exception {
        JSONArray parts = new JSONArray().put(inventory(p.getString("profile"), "active"));
        JSONArray selected = p.getJSONArray("selected");
        for (int i = 0; i < selected.length(); i++) {
            JSONObject group = selected.getJSONObject(i);
            parts.put(new JSONArray().put(group.getString("profile")).put(group.getString("mode")).put(inventory(group.getString("profile"), group.getString("mode"))));
        }
        // Uncertain staged writes also fence collection, even before data-head commit.
        try (Cursor c = db.rawQuery("SELECT tx_id,part,base_head,lease,data FROM staging ORDER BY tx_id,part", null)) {
            while (c.moveToNext()) parts.put(new JSONArray().put(c.getString(0)).put(c.getLong(1)).put(c.getLong(2)).put(c.getString(3)).put(OutboxPolicy.hash(c.getBlob(4))));
        }
        Set<String> profiles=new TreeSet<>();profiles.add(p.getString("profile"));for(int i=0;i<selected.length();i++)profiles.add(selected.getJSONObject(i).getString("profile"));
        int metadataCount=0;
        for(String profile:profiles){
            try(Cursor c=db.rawQuery("SELECT mode,bucket,key,actor,digest,trust FROM native_record_owners WHERE profile_id=? ORDER BY mode,bucket,key",new String[]{profile})){
                while(c.moveToNext()){if(++metadataCount>100000)throw new Failure("OUTBOX_RECONCILE_LIMIT");parts.put(new JSONArray().put(profile).put(c.getString(0)).put(c.getString(1)).put(c.getString(2)).put(c.getString(3)).put(c.getString(4)).put(c.getString(5)));}
            }
        }
        for (String profile : profiles) {
            try (Cursor c = db.rawQuery("SELECT bucket,key,digest,actor,context,mode FROM native_local_versions_v1 WHERE profile_id=? ORDER BY mode,bucket,key", new String[]{profile})) {
                while (c.moveToNext()) { if (++metadataCount > 100000) throw new Failure("OUTBOX_RECONCILE_LIMIT"); parts.put(new JSONArray().put("local-version").put(c.getString(5)).put(profile).put(c.getString(0)).put(c.getString(1)).put(c.getString(2)).put(c.getString(3)).put(OutboxPolicy.hash(c.getString(4)))); }
            }
            try (Cursor c = db.rawQuery("SELECT key,value FROM control WHERE key LIKE ? ORDER BY key", new String[]{"native-local:" + OutboxPolicy.hash(profile) + ":%"})) {
                while (c.moveToNext()) parts.put(new JSONArray().put("local-context").put(c.getString(0)).put(OutboxPolicy.hash(c.getString(1))));
            }
        }
        String workspaceID = java.net.URLDecoder.decode(p.getString("profile").split("\\|", -1)[1].replace("+", "%2B"), "UTF-8");
        try (Cursor c = db.rawQuery("SELECT key,value FROM control WHERE key LIKE ? ORDER BY key", new String[]{"server-observed:" + OutboxPolicy.hash(workspaceID) + ":%"})) {
            while (c.moveToNext()) { if (++metadataCount > 100000) throw new Failure("OUTBOX_RECONCILE_LIMIT"); parts.put(new JSONArray().put("server-observed").put(c.getString(0)).put(c.getString(1))); }
        }
        for (String profile : profiles) try (Cursor c = db.rawQuery("SELECT id,version,bucket,key,digest,actor,trust FROM native_recovery_records WHERE profile_id=? ORDER BY id", new String[]{profile})) {
            while (c.moveToNext()) { if (++metadataCount > 100000) throw new Failure("OUTBOX_RECONCILE_LIMIT"); parts.put(new JSONArray().put("archive-owner").put(c.getString(0)).put(c.getLong(1)).put(c.getString(2)).put(c.getString(3)).put(c.getString(4)).put(c.getString(5)).put(c.getString(6)).put(host.get("recovery-owner:" + c.getString(0)))); }
        }
        try(Cursor c=db.rawQuery("SELECT operation_id,session_ref,digest,result FROM native_sync_receipts WHERE profile_id=? ORDER BY operation_id",new String[]{p.getString("profile")})){
            while(c.moveToNext()){if(++metadataCount>100000)throw new Failure("OUTBOX_RECONCILE_LIMIT");parts.put(new JSONArray().put("sync").put(c.getString(0)).put(c.getString(1)).put(c.getString(2)).put(OutboxPolicy.hash(c.getString(3))));}
        }
        try(Cursor c=db.rawQuery("SELECT operation_id,kind,database_id,target_id,document_epoch FROM native_sync_ownership WHERE profile_id=? ORDER BY operation_id",new String[]{p.getString("profile")})){
            while(c.moveToNext())parts.put(new JSONArray().put("sync-owner").put(c.getString(0)).put(c.getString(1)).put(c.isNull(2)?JSONObject.NULL:c.getString(2)).put(c.getString(3)).put(c.isNull(4)?JSONObject.NULL:c.getString(4)));
        }
        try(Cursor c=db.rawQuery("SELECT kind,id,session_ref,access_revision,data_revision FROM native_observed_resources WHERE profile_id=? ORDER BY kind,id",new String[]{p.getString("profile")})){
            while(c.moveToNext())parts.put(new JSONArray().put("observed").put(c.getString(0)).put(c.getString(1)).put(c.getString(2)).put(c.getLong(3)).put(c.getLong(4)));
        }
        try(Cursor c=db.rawQuery("SELECT id,checksum FROM native_reconcile_cancelled WHERE profile_id=? ORDER BY id",new String[]{p.getString("profile")})){
            while(c.moveToNext())parts.put(new JSONArray().put("cancelled").put(c.getString(0)).put(c.getString(1)));
        }
        try(Cursor c=db.rawQuery("SELECT key,value FROM control WHERE key LIKE ? OR key LIKE 'staging-owner:%' OR key LIKE 'staged-proof:%' ORDER BY key",new String[]{"reconcile-cancelled:"+OutboxPolicy.hash(p.getString("profile"))+":%"})){
            while(c.moveToNext())parts.put(new JSONArray().put("control").put(c.getString(0)).put(c.getString(1)));
        }
        if(host.canonical(parts,false).getBytes(StandardCharsets.UTF_8).length>OutboxPolicy.TRANSACTION)throw new Failure("OUTBOX_RECONCILE_LIMIT");
        return OutboxPolicy.hash(host.canonical(parts, false));
    }
    private Cursor sourceRows(String profile, String mode) {
        if (mode.equals("archive")) return db.rawQuery("SELECT 'archive:'||a.id,a.bucket,a.key,a.profile_id,a.resource_key,length(r.payload),r.rowid FROM native_recovery_records a JOIN recovery r ON r.id=a.id WHERE a.profile_id=? ORDER BY a.id", new String[]{profile});
        return db.rawQuery("SELECT mode,bucket,key,profile_id,resource_key,length(payload),rowid FROM records WHERE profile_id=? AND mode=? ORDER BY bucket,key", new String[]{profile, mode});
    }
    private boolean qualifiedSource(Row row, String targetProfile) throws Exception {
        String actor = OutboxPolicy.actorPrefix(host.origin, targetProfile);
        if (actor == null || !actor.equals(OutboxPolicy.actorPrefix(host.origin, row.profile))) return false;
        if (!row.mode.startsWith("archive:")) return Arrays.asList("native", "untrusted").contains(host.sourceTrust(row.mode, row.bucket, row.key, row.profile, row.raw(), actor));
        String id = row.mode.substring("archive:".length());
        try (Cursor proof = db.rawQuery("SELECT version,profile_id,bucket,key,digest,actor,trust FROM native_recovery_records WHERE id=?", new String[]{id})) {
            return proof.moveToFirst() && proof.getInt(0) == 1 && row.profile.equals(proof.getString(1)) && row.bucket.equals(proof.getString(2)) && row.key.equals(proof.getString(3))
                && OutboxPolicy.hash(row.raw()).equals(proof.getString(4)) && actor.equals(proof.getString(5)) && Arrays.asList("native", "untrusted").contains(proof.getString(6))
                && row.profile.equals(host.get("recovery-owner:" + id));
        }
    }
    private int qualifiedCount(String profile, String mode, String targetProfile) throws Exception {
        int count = 0, scanned = 0; long bytes = 0;
        try (Cursor source = sourceRows(profile, mode)) { while (source.moveToNext()) {
            Row row = new Row(source, mode.equals("archive") ? "recovery" : "records"); bytes += row.size;
            if (++scanned > 100000 || row.size > OutboxPolicy.RECORD || bytes > OutboxPolicy.TRANSACTION) throw new Failure("OUTBOX_RECONCILE_LIMIT");
            if (qualifiedSource(row, targetProfile)) count++;
        } }
        return count;
    }
    JSONArray handles(JSONObject grant, String owner) throws Exception {
        JSONArray result = new JSONArray(); long now = System.currentTimeMillis();
        String profile = grant.getString("profileId"), prefix = OutboxPolicy.actorPrefix(host.origin, profile);
        if (prefix == null) return result;
        db.execSQL("DELETE FROM reconcile_handles WHERE profile_id=? AND expires_at<=?", new Object[]{profile,now});
        try (Cursor groups = db.rawQuery("SELECT profile_id,mode,count(*) FROM (SELECT r.profile_id,r.mode FROM records r JOIN native_record_owners n ON n.mode=r.mode AND n.bucket=r.bucket AND n.key=r.key AND n.profile_id=r.profile_id WHERE n.actor=? AND n.trust IN ('native','untrusted') AND substr(r.profile_id,1,?)=? AND (r.mode='quarantine' OR (r.mode='active' AND r.profile_id<>?)) UNION ALL SELECT profile_id,'archive' AS mode FROM native_recovery_records WHERE actor=? AND trust IN ('native','untrusted') AND substr(profile_id,1,?)=?) GROUP BY profile_id,mode ORDER BY profile_id,mode", new String[]{prefix, Integer.toString(prefix.length()), prefix, profile, prefix, Integer.toString(prefix.length()), prefix})) {
            while (groups.moveToNext()) {
                if (result.length() >= 100) throw new Failure("OUTBOX_RECONCILE_LIMIT");
                String source = groups.getString(0), mode = groups.getString(1); int count = qualifiedCount(source, mode, profile); if (count == 0) continue;
                String digest = inventory(source, mode), handle = null; long expiry = 0;
                try (Cursor c = db.rawQuery("SELECT id,expires_at FROM reconcile_handles WHERE profile_id=? AND owner=? AND session_ref=? AND source_profile=? AND source_mode=? AND digest=? AND expires_at>? LIMIT 1", new String[]{profile, owner, grant.getString("session_ref"), source, mode, digest, Long.toString(now)})) {
                    if (c.moveToFirst()) { handle = c.getString(0); expiry = c.getLong(1); }
                }
                if (handle == null) {
                    handle = UUID.randomUUID().toString(); expiry = Math.min(grant.getLong("validUntil"), now + TTL);
                    db.execSQL("INSERT INTO reconcile_handles VALUES(?,?,?,?,?,?,?,?)", new Object[]{handle, profile, owner, grant.getString("session_ref"), source, mode, digest, expiry});
                }
                result.put(new JSONObject().put("handle", handle).put("kind", source.equals(profile) ? "upgrade" : "recovery").put("count", count).put("expiresAt", expiry));
            }
        }
        return result;
    }
    private JSONObject checked(JSONObject p, String cookie, boolean blocked, String owner) throws Exception {
        JSONObject grant = host.verified(cookie, blocked);
        if (grant == null || !grant.getString("profileId").equals(p.getString("profile")) || !grant.getString("session_ref").equals(p.getString("sessionRef"))
            || !owner.equals(p.getString("owner")) || !owner.equals(host.get("owner")) || !p.getString("lease").equals(host.get("lease"))
            || System.currentTimeMillis() >= p.getLong("expiresAt") || host.head() != p.getLong("expectedHead") || host.proofEpoch() != p.getLong("expectedProof")
            || !OutboxPolicy.hash(host.canonical(grant.getJSONObject("session"), false)).equals(p.getString("authorityDigest"))
            || !sourceDigest(p).equals(p.getString("sourceDigest"))) throw new Failure("OUTBOX_RECONCILE_STALE");
        return grant;
    }
    Tag admit(long sequence, String method, String path, String cookie, boolean blocked, String owner) throws Exception {
        JSONObject p = plan(); if (p == null) return null;
        try { checked(p, cookie, blocked, owner); } catch (Failure stale) { discard(p.getString("id")); return null; }
        if (!"GET".equals(method) && !NativePolicy.sessionPath(path)) { discard(p.getString("id")); return null; }
        if (!"collecting".equals(p.getString("state")) || sequence <= p.getLong("watermark")) return null;
        String[] resource = OutboxPolicy.collectionResource(method, path); if (resource == null) return null;
        JSONArray expected = p.getJSONArray("expected");
        for (int i = 0; i < expected.length(); i++) {
            JSONObject descriptor = expected.getJSONObject(i);
            if (resource[0].equals(descriptor.getString("kind")) && resource[1].equals(descriptor.getString("id")) && !captured(p, resource[0], resource[1]))
                return new Tag(p.getString("id"), p.getInt("sweep"), resource[0], resource[1], sequence);
        }
        return null;
    }
    void beforeObservation(Tag tag, String cookie, boolean blocked, String owner) throws Exception {
        JSONObject p = plan(); if (p == null) return;
        if (tag == null) {
            if (!p.getString("state").equals("collecting")) { discard(p.getString("id")); return; }
            checked(p, cookie, blocked, owner); return;
        }
        if (!tag.plan.equals(p.getString("id")) || tag.sweep != p.getInt("sweep")) { discard(p.getString("id")); return; }
        checked(p, cookie, blocked, owner);
    }
    private boolean captured(JSONObject p, String kind, String id) throws Exception {
        try (Cursor c = db.rawQuery("SELECT 1 FROM reconcile_capture WHERE plan_id=? AND sweep=? AND kind=? AND id=? LIMIT 1", new String[]{p.getString("id"), Integer.toString(p.getInt("sweep")), kind, id})) { return c.moveToFirst(); }
    }
    void capture(Tag tag, int status, byte[] raw, String cookie, boolean blocked, String owner) throws Exception {
        if (tag == null) {
            JSONObject current = plan(); if (current != null) try { checked(current, cookie, blocked, owner); } catch (Failure changed) { discard(current.getString("id")); }
            return;
        }
        JSONObject p = plan();
        if (p == null || !tag.plan.equals(p.getString("id")) || tag.sweep != p.getInt("sweep")) throw new Failure("OUTBOX_RECONCILE_STALE");
        JSONObject grant = host.verified(cookie, blocked);
        if (grant == null || !grant.getString("profileId").equals(p.getString("profile")) || !owner.equals(p.getString("owner")) || !grant.getString("session_ref").equals(p.getString("sessionRef"))
            || !p.getString("lease").equals(host.get("lease")) || tag.sequence <= p.getLong("watermark") || System.currentTimeMillis() >= p.getLong("expiresAt")) throw new Failure("OUTBOX_RECONCILE_STALE");
        if (status != 200 && status != 403 && status != 404) { discard(tag.plan); throw new Failure("OUTBOX_RECONCILE_RETRY"); }
        if (raw == null || raw.length > OutboxPolicy.RECORD || captured(p, tag.kind, tag.id)) throw new Failure("OUTBOX_RECONCILE_LIMIT");
        if (status == 200) {
            try {
                JSONObject body = new JSONObject(OutboxPolicy.utf8(raw));
                if (tag.kind.equals("attachment")) metadata(body, tag.id); else {
                    host.envelope(body, p.getString("profile"));
                    if (tag.kind.equals("page")) {
                        JSONObject state = body.getJSONObject("state"); NativePolicy.require(OutboxPolicy.integer(state.opt("version"), 1, 1) == 1);
                        OutboxPolicy.integer(state.opt("max_clock"), 0, OutboxPolicy.SAFE); state.getJSONObject("blocks"); state.getJSONObject("seen");
                        NativePolicy.require(body.getJSONArray("blocks").length() <= 2000 && tag.id.equals(body.getJSONObject("page").getString("id")));
                    }
                }
            } catch (Exception malformed) { discard(tag.plan); throw new Failure("OUTBOX_RECONCILE_RETRY"); }
        }
        db.beginTransaction();
        try {
            for (int offset = 0; offset < Math.max(1, raw.length); offset += OutboxPolicy.PART) {
                byte[] piece = Arrays.copyOfRange(raw, offset, Math.min(raw.length, offset + OutboxPolicy.PART));
                db.execSQL("INSERT INTO reconcile_capture VALUES(?,?,?,?,?,?,?)", new Object[]{tag.plan, tag.sweep, tag.kind, tag.id, status, offset / OutboxPolicy.PART, piece});
            }
            budget(tag.plan); p.put("expectedHead", host.head()).put("expectedProof", host.proofEpoch()).put("sourceDigest", sourceDigest(p)); save(p); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    private void budget(String id) throws Exception {
        try (Cursor c = db.rawQuery("SELECT (SELECT COALESCE(sum(length(payload)),0) FROM reconcile_capture WHERE plan_id=?)+(SELECT COALESCE(sum(length(payload)),0) FROM reconcile_rows WHERE plan_id=?)", new String[]{id, id})) {
            if (!c.moveToFirst() || c.getLong(0) > OutboxPolicy.TRANSACTION) throw new Failure("OUTBOX_RECONCILE_LIMIT");
        }
    }
    private JSONObject response(JSONObject p, String kind, String id) throws Exception {
        ByteArrayOutputStream raw = new ByteArrayOutputStream(); int next = 0;
        try (Cursor c = db.rawQuery("SELECT status,part,payload FROM reconcile_capture WHERE plan_id=? AND sweep=? AND kind=? AND id=? ORDER BY part", new String[]{p.getString("id"), Integer.toString(p.getInt("sweep")), kind, id})) {
            while (c.moveToNext()) {
                if (c.getInt(0) != 200) return null;
                NativePolicy.require(c.getInt(1) == next++); byte[] piece = c.getBlob(2);
                NativePolicy.require(piece.length <= OutboxPolicy.PART && raw.size() + piece.length <= OutboxPolicy.RECORD); raw.write(piece);
            }
        }
        if (next == 0) throw new Failure("OUTBOX_RECONCILE_RETRY");
        return new JSONObject(OutboxPolicy.utf8(raw.toByteArray()));
    }
    JSObject call(JSONObject input, long generation, String cookie, boolean blocked, String owner, long watermark) throws Exception {
        NativePolicy.require(OutboxPolicy.integer(input.opt("generation"), 0, OutboxPolicy.SAFE - 1) == generation);
        String phase = input.getString("phase");
        if (phase.equals("settle")) return settle(input, generation, cookie, blocked, owner);
        if (phase.equals("cancel")) {
            fields(input, "generation", "phase", "planId"); String id = OutboxPolicy.id(input.getString("planId"));
            JSONObject p = plan(); if (p != null && p.getString("id").equals(id)) { checked(p, cookie, blocked, owner); discard(id); }
            JSObject result = new JSObject(); result.put("generation", generation); result.put("state", "cancelled"); result.put("planId", id); return result;
        }
        if (phase.equals("commit")) return commit(input, generation, cookie, blocked, owner);
        NativePolicy.require(phase.equals("prepare"));
        JSONObject p;
        if (!input.has("planId")) {
            fields(input, "generation", "phase", "lease", "baseHead", "proofEpoch", "mode", "handles");
            JSONObject grant = host.verified(cookie, blocked); if (grant == null) throw new Failure("OUTBOX_ACCESS_REQUIRED");
            if (!input.getString("lease").equals(host.get("lease")) || OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1) != host.head()
                || OutboxPolicy.integer(input.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1) != host.proofEpoch() || !owner.equals(host.get("owner"))) throw new Failure("OUTBOX_RECONCILE_STALE");
            String mode = input.getString("mode"); NativePolicy.require(Arrays.asList("current", "upgrade", "promote").contains(mode));
            JSONArray selected = new JSONArray();
            if (mode.equals("current")) NativePolicy.require(!input.has("handles"));
            else {
                JSONArray handles = input.getJSONArray("handles"); NativePolicy.require(handles.length() > 0 && handles.length() <= 100); Set<String> ids = new HashSet<>();
                for (int i = 0; i < handles.length(); i++) {
                    String id = OutboxPolicy.id(OutboxPolicy.text(handles.get(i), 160)); NativePolicy.require(ids.add(id));
                    try (Cursor c = db.rawQuery("SELECT source_profile,source_mode,digest,expires_at FROM reconcile_handles WHERE id=? AND profile_id=? AND owner=? AND session_ref=?", new String[]{id, grant.getString("profileId"), owner, grant.getString("session_ref")})) {
                        if (!c.moveToFirst() || c.getLong(3) <= System.currentTimeMillis() || !inventory(c.getString(0), c.getString(1)).equals(c.getString(2))) throw new Failure("OUTBOX_RECONCILE_STALE");
                        NativePolicy.require(mode.equals("upgrade") ? c.getString(0).equals(grant.getString("profileId")) && Arrays.asList("quarantine", "archive").contains(c.getString(1)) : Objects.equals(OutboxPolicy.actorPrefix(host.origin, c.getString(0)), OutboxPolicy.actorPrefix(host.origin, grant.getString("profileId"))));
                        selected.put(new JSONObject().put("profile", c.getString(0)).put("mode", c.getString(1)));
                    }
                }
            }
            JSONObject old = plan(); if (old != null) discard(old.getString("id"));
            p = new JSONObject().put("id", UUID.randomUUID().toString()).put("profile", grant.getString("profileId")).put("owner", owner)
                .put("sessionRef", grant.getString("session_ref")).put("lease", input.getString("lease")).put("generation", generation)
                .put("mode", mode).put("selected", selected).put("expectedHead", host.head()).put("expectedProof", host.proofEpoch())
                .put("authorityDigest", OutboxPolicy.hash(host.canonical(grant.getJSONObject("session"), false)))
                .put("watermark", watermark).put("expiresAt", Math.min(grant.getLong("validUntil"), System.currentTimeMillis() + TTL))
                .put("sweep", 1).put("state", "collecting").put("expanded", false)
                .put("expected", new JSONArray().put(new JSONObject().put("kind", "workspace").put("id", "workspace")));
            p.put("sourceDigest", sourceDigest(p));
            db.beginTransaction(); try {
                copySource(p, grant.getString("profileId"), "active");
                for (int i = 0; i < selected.length(); i++) copySource(p, selected.getJSONObject(i).getString("profile"), selected.getJSONObject(i).getString("mode"));
                budget(p.getString("id")); save(p); db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        } else {
            fields(input, "generation", "phase", "lease", "planId"); p = plan();
            if (p == null || !input.getString("planId").equals(p.getString("id")) || !input.getString("lease").equals(p.getString("lease"))) throw new Failure("OUTBOX_RECONCILE_STALE");
            checked(p, cookie, blocked, owner);
        }
        if (p.getString("state").equals("ready")) return ready(p, generation);
        if (captured(p, "workspace", "workspace") && !p.getBoolean("expanded")) {
            JSONObject workspace = response(p, "workspace", "workspace"); if (workspace == null) throw new Failure("OUTBOX_RECONCILE_RETRY");
            JSONArray expected = p.getJSONArray("expected");expandSources(p,workspace);
            p.put("expanded", true); save(p);
            Set<String> attachments = new TreeSet<>();
            for (Row row : rows(p.getString("id"), "source")) {
                if (row.mode.equals("active") && row.profile.equals(p.getString("profile")) && !"native".equals(host.sourceTrust(row.mode, row.bucket, row.key, row.profile, row.raw(), OutboxPolicy.actorPrefix(host.origin, row.profile)))) continue;
                JSONObject value=row.value();
                if(row.bucket.equals("operations"))attachmentIDs(value.getJSONObject("operation"),attachments,0);
                if(row.bucket.equals("drafts")&&!value.getJSONObject("draft").optString("reason").equals("basis")){
                    JSONObject draft=value.getJSONObject("draft");if(draft.has("blocks"))attachmentIDs(draft.get("blocks"),attachments,0);if(draft.has("ops"))attachmentIDs(draft.get("ops"),attachments,0);
                }
                if(!p.getString("mode").equals("current")&&row.bucket.equals("snapshots"))attachmentIDs(value.getJSONObject("snapshot").getJSONArray("blocks"),attachments,0);
            }
            for (String id : attachments) { if (expected.length() >= MAX_ITEMS) throw new Failure("OUTBOX_RECONCILE_LIMIT"); expected.put(new JSONObject().put("kind", "attachment").put("id", id)); }
            save(p);
        }
        JSONArray needed = needed(p);
        if(needed.length()==0&&p.getBoolean("expanded")){
            if(expandRelations(p)) {save(p);needed=needed(p);}
        }
        if (needed.length() == 0) {
            if (!stable(p)) {
                if (p.getInt("sweep") >= 2) { discard(p.getString("id")); throw new Failure("OUTBOX_RECONCILE_RETRY"); }
                db.execSQL("DELETE FROM reconcile_capture WHERE plan_id=?", new Object[]{p.getString("id")});
                p.put("sweep", 2).put("expanded", false).put("expected", new JSONArray().put(new JSONObject().put("kind", "workspace").put("id", "workspace"))); save(p); needed = needed(p);
            } else {
                build(p, checked(p, cookie, blocked, owner)); p.put("state", "ready");
                JSONObject summary = new JSONObject().put("planId", p.getString("id")).put("lease", p.getString("lease")).put("baseHead", p.getLong("expectedHead"))
                    .put("proofEpoch", p.getLong("expectedProof")).put("expiresAt", p.getLong("expiresAt")).put("counts", p.getJSONObject("counts"))
                    .put("reasons", p.getJSONArray("reasons")).put("requiresConfirmation", p.getBoolean("requiresConfirmation"));
                p.put("checksum", OutboxPolicy.hash(host.canonical(summary, false)));
                db.beginTransaction();try{
                    checked(p,cookie,blocked,owner);save(p);
                    db.execSQL("INSERT INTO native_reconcile_ready VALUES(?,?,?,?,?,?,?)",new Object[]{p.getString("id"),p.getString("profile"),p.getString("sessionRef"),p.getString("lease"),p.getLong("expectedHead"),p.getLong("expectedProof"),p.getString("checksum")});
                    db.setTransactionSuccessful();
                }finally{db.endTransaction();}
                return ready(p, generation);
            }
        }
        JSObject result = new JSObject(); result.put("generation", generation); result.put("state", "collecting"); result.put("planId", p.getString("id")); result.put("lease", p.getString("lease")); result.put("expiresAt", p.getLong("expiresAt")); result.put("sweep", p.getInt("sweep")); result.put("needed", needed); return result;
    }
    private JSObject settle(JSONObject input, long generation, String cookie, boolean blocked, String owner) throws Exception {
        fields(input, "generation", "phase", "lease", "journals", "reconciliations");
        if (host.knownBlockedProfile(cookie, blocked) != null) return host.terminalSettlement(input, generation, cookie, blocked);
        JSONObject grant = host.verified(cookie, blocked);
        if (grant == null || !owner.equals(host.get("owner")) || !input.getString("lease").equals(host.get("lease"))) throw new Failure("OUTBOX_RECONCILE_STALE");
        JSONArray journals = input.getJSONArray("journals"), settlements = new JSONArray(), reconciliations=input.has("reconciliations")?input.getJSONArray("reconciliations"):new JSONArray(), reconcileSettlements=new JSONArray();
        NativePolicy.require(journals.length() <= 100 && reconciliations.length()<=100 && journals.length()+reconciliations.length()<=100);
        Set<String> ids = new HashSet<>();
        boolean unacceptedDelta=false;
        db.beginTransaction(); try {
            for (int i = 0; i < journals.length(); i++) {
                JSONObject journal = journals.getJSONObject(i); fields(journal, "txId", "digest", "baseHead", "proofEpoch");
                String tx = OutboxPolicy.id(journal.getString("txId")), digest = journal.getString("digest"); NativePolicy.require(ids.add(tx) && digest.matches("[0-9a-f]{64}"));
                long base = OutboxPolicy.integer(journal.opt("baseHead"), 0, OutboxPolicy.SAFE - 1), proof = OutboxPolicy.integer(journal.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1);
                JSONObject result = new JSONObject().put("txId", tx).put("digest", digest);
                try (Cursor c = db.rawQuery("SELECT digest,head FROM tx_receipts WHERE tx_id=?", new String[]{tx})) {
                    if (c.moveToFirst()) {
                        if (!digest.equals(c.getString(0)) || c.getLong(1) != base + 1 || !grant.getString("profileId").equals(host.get("receipt-owner:" + tx)) || !Long.toString(proof).equals(host.get("receipt-proof:" + tx))) throw new Failure("OUTBOX_RECONCILE_STALE");
                        result.put("status", "accepted").put("head", c.getLong(1)).put("proofEpoch", proof); settlements.put(result); continue;
                    }
                }
                if (!grant.getString("profileId").equals(host.get("staging-owner:" + tx)) || !Long.toString(proof).equals(host.get("staged-proof:" + tx))) throw new Failure("OUTBOX_RECONCILE_STALE");
                try (Cursor c = db.rawQuery("SELECT base_head FROM staging WHERE tx_id=?", new String[]{tx})) { boolean found = false; while (c.moveToNext()) { found = true; if (c.getLong(0) != base) throw new Failure("OUTBOX_RECONCILE_STALE"); } if (!found) throw new Failure("OUTBOX_RECONCILE_STALE"); }
                host.set(cancelKey(grant.getString("profileId"), tx), digest); unacceptedDelta=true; result.put("status", "unaccepted"); settlements.put(result);
            }
            Set<String> plans=new HashSet<>();
            for(int i=0;i<reconciliations.length();i++){
                JSONObject descriptor=reconciliations.getJSONObject(i);fields(descriptor,"planId","checksum","lease","baseHead","proofEpoch");
                String id=OutboxPolicy.id(descriptor.getString("planId")),checksum=descriptor.getString("checksum"),lease=OutboxPolicy.text(descriptor.opt("lease"),1000);
                NativePolicy.require(plans.add(id)&&checksum.matches("[0-9a-f]{64}"));long base=OutboxPolicy.integer(descriptor.opt("baseHead"),0,OutboxPolicy.SAFE-1),proof=OutboxPolicy.integer(descriptor.opt("proofEpoch"),0,OutboxPolicy.SAFE-1);
                try(Cursor registry=db.rawQuery("SELECT profile_id,session_ref,lease,source_head,proof_epoch,checksum FROM native_reconcile_ready WHERE id=?",new String[]{id})){
                    if(!registry.moveToFirst()||!registry.getString(0).equals(grant.getString("profileId"))||!registry.getString(1).equals(grant.getString("session_ref"))||!registry.getString(2).equals(lease)||registry.getLong(3)!=base||registry.getLong(4)!=proof||!registry.getString(5).equals(checksum))throw new Failure("OUTBOX_RECONCILE_STALE");
                }
                JSONObject result=new JSONObject().put("planId",id).put("checksum",checksum);boolean accepted=false;
                try(Cursor receipt=db.rawQuery("SELECT profile_id,session_ref,lease,checksum,payload FROM reconcile_receipts WHERE id=?",new String[]{id})){
                    if(receipt.moveToFirst()){
                        if(!receipt.getString(0).equals(grant.getString("profileId"))||!receipt.getString(1).equals(grant.getString("session_ref"))||!receipt.getString(2).equals(lease)||!receipt.getString(3).equals(checksum))throw new Failure("OUTBOX_RECONCILE_STALE");
                        JSONObject stored=new JSONObject(receipt.getString(4)),immutable=stored.getJSONObject("receipt");if(immutable.getLong("sourceHead")!=base||stored.getLong("proofEpoch")!=proof)throw new Failure("OUTBOX_RECONCILE_STALE");
                        result.put("status","accepted").put("head",stored.getLong("head")).put("proofEpoch",stored.getLong("proofEpoch")).put("receipt",immutable);accepted=true;
                    }
                }
                if(!accepted){db.execSQL("INSERT OR IGNORE INTO native_reconcile_cancelled VALUES(?,?,?)",new Object[]{grant.getString("profileId"),id,checksum});JSONObject prepared=plan();if(prepared!=null&&prepared.getString("id").equals(id))discard(id);result.put("status","unaccepted");}
                reconcileSettlements.put(result);
            }
            JSONObject p = plan(); if (unacceptedDelta && p != null) discard(p.getString("id")); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        JSObject result = new JSObject(); result.put("generation", generation); result.put("state", "settled"); result.put("lease", input.getString("lease")); result.put("settlements", settlements);if(input.has("reconciliations"))result.put("reconciliations",reconcileSettlements);return result;
    }
    static String cancelKey(String profile, String tx) throws Exception { return "reconcile-cancelled:" + OutboxPolicy.hash(profile) + ":" + tx; }
    void eraseActor(String prefix) throws Exception {
        JSONObject p = plan(); if (p != null && p.getString("profile").startsWith(prefix)) discard(p.getString("id"));
        db.execSQL("DELETE FROM reconcile_receipts WHERE substr(profile_id,1,?)=?", new Object[]{prefix.length(), prefix});
        db.execSQL("DELETE FROM reconcile_handles WHERE substr(profile_id,1,?)=?", new Object[]{prefix.length(), prefix});
        db.execSQL("DELETE FROM native_reconcile_ready WHERE substr(profile_id,1,?)=?",new Object[]{prefix.length(),prefix});
        try(Cursor owned=db.rawQuery("SELECT a.id,a.digest,r.rowid,length(r.payload) FROM native_recovery_records a JOIN recovery r ON r.id=a.id WHERE substr(a.profile_id,1,?)=? AND a.actor=? AND a.trust IN ('native','untrusted')",new String[]{Integer.toString(prefix.length()),prefix,prefix})){
            while(owned.moveToNext())if(OutboxPolicy.hash(host.payload("recovery",owned.getLong(2),owned.getInt(3))).equals(owned.getString(1))){String id=owned.getString(0);db.execSQL("DELETE FROM recovery WHERE id=?",new Object[]{id});db.execSQL("DELETE FROM native_recovery_records WHERE id=?",new Object[]{id});db.execSQL("DELETE FROM control WHERE key=?",new Object[]{"recovery-owner:"+id});}
        }
    }
    private JSONArray needed(JSONObject p) throws Exception {
        JSONArray result = new JSONArray(), expected = p.getJSONArray("expected");
        for (int i = 0; i < expected.length() && result.length() < PAGE; i++) { JSONObject d = expected.getJSONObject(i); if (!captured(p, d.getString("kind"), d.getString("id"))) result.put(d); }
        return result;
    }
    private boolean stable(JSONObject p) throws Exception {
        JSONObject workspace = response(p, "workspace", "workspace"); if (workspace == null) return false;
        long access = OutboxPolicy.integer(workspace.opt("access_revision"), 0, OutboxPolicy.SAFE - 1), data = OutboxPolicy.integer(workspace.opt("data_revision"), 0, OutboxPolicy.SAFE - 1);
        JSONArray expected = p.getJSONArray("expected");
        for (int i = 0; i < expected.length(); i++) { JSONObject d = expected.getJSONObject(i); if (d.getString("kind").equals("attachment")) continue; JSONObject body = response(p, d.getString("kind"), d.getString("id")); if (body != null && (OutboxPolicy.integer(body.opt("access_revision"), 0, OutboxPolicy.SAFE - 1) != access || OutboxPolicy.integer(body.opt("data_revision"), 0, OutboxPolicy.SAFE - 1) != data)) return false; }
        JSONObject ledger = new JSONObject(host.get("resource_proofs")); return access == ledger.getLong("maxAccessRevision") && data == ledger.getLong("maxDataRevision");
    }
    private void copySource(JSONObject p, String profile, String mode) throws Exception {
        boolean current = mode.equals("active") && profile.equals(p.getString("profile"));
        try (Cursor source = sourceRows(profile, mode)) { while (source.moveToNext()) {
            Row row = new Row(source, mode.equals("archive") ? "recovery" : "records");
            if (current || qualifiedSource(row, p.getString("profile"))) db.execSQL("INSERT OR IGNORE INTO reconcile_rows VALUES(?,'source',?,?,?,?,?,?)", new Object[]{p.getString("id"),row.mode,row.bucket,row.key,row.profile,row.resource,row.raw()});
        } }
    }
    private JSObject ready(JSONObject p, long generation) throws Exception {
        JSObject result = new JSObject(); result.put("generation", generation); result.put("state", "ready"); result.put("planId", p.getString("id"));
        for (String name : Arrays.asList("lease", "expiresAt", "checksum", "counts", "reasons", "requiresConfirmation")) result.put(name, p.get(name));
        result.put("baseHead", p.getLong("expectedHead")); result.put("proofEpoch", p.getLong("expectedProof")); return result;
    }
    // Canonical transforms and final validation are kept beside the collector so
    // no renderer record can become a baseline or permission proof.
    private void build(JSONObject p, JSONObject grant) throws Exception {
        String plan = p.getString("id"), profile = p.getString("profile");
        JSONObject workspace = response(p, "workspace", "workspace");
        if (workspace == null) throw new Failure("OUTBOX_RECONCILE_RETRY");
        Map<String, JSONObject> pages = new HashMap<>(), databases = new HashMap<>();
        TreeSet<String> reasons = new TreeSet<>();
        JSONObject counts = new JSONObject().put("refresh", 3).put("keep", 0).put("acknowledge", 0).put("quarantine", 0).put("import", 0);
        JSONObject actions = new JSONObject(); long now = System.currentTimeMillis();
        db.execSQL("DELETE FROM reconcile_rows WHERE plan_id=? AND phase='output'", new Object[]{plan});
        String[] identity = profile.split("\\|", -1);
        JSONObject freshProfile = new JSONObject().put("id", profile).put("origin", host.origin)
            .put("workspaceId", workspace.getString("workspace_id")).put("memberId", workspace.getString("current_member_id"))
            .put("cacheBinding", workspace.getString("session_binding")).put("session", grant.getJSONObject("session"))
            .put("workspace", workspace).put("validUntil", grant.getLong("validUntil")).put("updatedAt", now);
        output(p, "profiles", profile, null, freshProfile);
        for (String name : Arrays.asList("active", "last-profile")) output(p, "meta", name, null, new JSONObject().put("id", name).put("profileId", profile));
        JSONArray expected = p.getJSONArray("expected");
        for (int i = 0; i < expected.length(); i++) {
            JSONObject descriptor = expected.getJSONObject(i); String kind = descriptor.getString("kind"), id = descriptor.getString("id");
            if (kind.equals("workspace") || kind.equals("attachment")) continue;
            JSONObject body = response(p, kind, id); if (body == null) continue;
            String resource = profile + (kind.equals("database") ? "|database|" : "|") + OutboxPolicy.encode(id);
            JSONObject value = new JSONObject().put("key", resource).put("profileId", profile).put("snapshot", body).put("updatedAt", now);
            if (kind.equals("database")) { value.put("resourceKey", resource); databases.put(id, body); } else pages.put(id, body);
            output(p, kind.equals("page") ? "snapshots" : "databaseSnapshots", resource, resource, value); increment(counts, "refresh");
        }
        List<Row> original = rows(plan, "source"); Map<String, Row> input = new LinkedHashMap<>();
        for (Row row : original) {
            if (!row.profile.equals(profile) || !row.mode.equals("active") || !INPUT.contains(row.bucket)) continue;
            if (!"native".equals(host.sourceTrust(row.mode, row.bucket, row.key, row.profile, row.raw(), OutboxPolicy.actorPrefix(host.origin, profile)))) { actions.put(row.ref(), "opaque"); continue; }
            if (!isInput(row)) continue;
            input.put(row.ref(), row);
            String reason = compatible(p,row, pages, databases);
            if (reason != null) { actions.put(row.ref(), "quarantine"); reasons.add(reason); continue; }
            if (row.bucket.equals("operations")) {
                JSONObject canonical = pages.get(resourceID(row.resource)); JSONObject seen = canonical == null ? null : canonical.getJSONObject("state").optJSONObject("seen");
                if (seen != null && seen.has(row.value().getString("id"))) { actions.put(row.ref(), "acknowledge"); continue; }
            }
            actions.put(row.ref(), "keep"); outputRaw(p, row);
        }
        // A basis is canonical cache, not unsent user input. Preserve its old
        // bytes at commit; the installed server snapshot becomes the new basis.
        for (Row row : original) if (row.profile.equals(profile) && row.mode.equals("active") && row.bucket.equals("drafts") && !actions.optString(row.ref()).equals("opaque") && row.value().getJSONObject("draft").optString("reason").equals("basis")) {
            actions.put(row.ref(), "baseline"); JSONObject body = pages.get(resourceID(row.resource));
            if (body != null) {
                String oldClient = row.value().getString("clientId"), oldEpoch = row.value().getJSONObject("draft").getString("epoch"), suffix = ":basis:" + oldEpoch;
                String client = oldClient.endsWith(suffix) ? oldClient.substring(0, oldClient.length() - suffix.length()) + ":basis:" + body.getString("epoch") : UUID.randomUUID().toString() + ":basis:" + body.getString("epoch");
                JSONArray key = new JSONArray().put(row.resource).put(client); boolean exists;
                try (Cursor c = db.rawQuery("SELECT 1 FROM reconcile_rows WHERE plan_id=? AND phase='output' AND bucket='drafts' AND key=?", new String[]{plan, host.key(key)})) { exists = c.moveToFirst(); }
                JSONObject basis = new JSONObject().put("reason", "basis").put("epoch", body.getString("epoch")).put("seq", body.getLong("seq")).put("state", body.getJSONObject("state")).put("blocks", body.getJSONArray("blocks"));
                output(p, "drafts", key, row.resource, new JSONObject().put("key", row.resource).put("profileId", profile).put("clientId", client).put("draft", basis).put("updatedAt", now));
                if (!exists) increment(counts, "refresh");
            }
        }
        for (Row row : input.values()) if (row.bucket.equals("localPages") && actions.optString(row.ref()).equals("keep") && row.value().getJSONObject("metadata").opt("localOnly") == Boolean.TRUE) {
            if (!pages.containsKey(resourceID(row.resource))) {
                for (Row baseline : original) if (baseline.profile.equals(profile) && baseline.mode.equals("active") && baseline.bucket.equals("snapshots") && Objects.equals(baseline.resource, row.resource)) outputRaw(p, baseline);
            }
            else {
                JSONObject canonical=pages.get(resourceID(row.resource)),metadata=row.value().getJSONObject("metadata"),create=null;
                for(Row candidate:input.values())if(candidate.bucket.equals("mutations")&&candidate.value().getString("id").equals(metadata.getString("create_operation_id")))create=candidate.value().getJSONObject("operation");
                JSONObject applied=create==null?null:host.appliedSync(grant,create);
                if(applied!=null&&create.getString("document_epoch").equals(canonical.getString("epoch"))&&canonical.getLong("access_level")>=3){
                    JSONObject refreshed=row.value();JSONObject next=new JSONObject(metadata.toString()).put("page",canonical.getJSONObject("page")).put("localOnly",false).put("creation_result",applied)
                        .put("canonical_data_revision",canonical.getLong("data_revision")).put("canonical_access_revision",canonical.getLong("access_revision"));
                    refreshed.put("metadata",next).put("updatedAt",now);output(p,"localPages",refreshed.getString("key"),row.resource,refreshed);actions.put(row.ref(),"canonical");increment(counts,"refresh");
                }
            }
        }
        JSONArray localGroups=new JSONArray();for(Row row:input.values())if(row.bucket.equals("localPages")&&row.value().getJSONObject("metadata").opt("localOnly")==Boolean.TRUE&&!pages.containsKey(resourceID(row.resource)))localGroups.put(row.resource);p.put("localGroups",localGroups);
        cascade(p, input, actions, reasons);
        for (int attempt = 0; attempt <= input.size(); attempt++) {
            try { new NativeLocalGraph(host, grant, plan); break; }
            catch (NativeLocalGraph.InvalidResource invalid) {
                Row bad = null;
                if (invalid.operation != null) for (Row row : input.values()) if (row.bucket.equals("mutations") && row.value().getString("id").equals(invalid.operation)) bad = row;
                boolean changed = bad == null ? quarantineResource(p, input, actions, invalid.resource) : quarantineMutation(p, input, actions, bad);
                if (!changed) throw new Failure("OUTBOX_RECONCILE_RETRY");
                reasons.add("dependency_conflict"); cascade(p, input, actions, reasons);
            }
        }
        for (Row row : input.values()) if(Arrays.asList("keep","acknowledge","quarantine").contains(actions.optString(row.ref())))increment(counts, actions.getString(row.ref()));
        if (!p.getString("mode").equals("current")) {
            promote(p, grant, original, workspace, pages, databases, counts, reasons);
            new NativeLocalGraph(host, grant, plan);
        }
        JSONArray list = new JSONArray(); for (String reason : reasons) list.put(reason);
        p.put("counts", counts).put("reasons", list).put("actions", actions).put("requiresConfirmation", !p.getString("mode").equals("current") || counts.getLong("quarantine") > 0);
        budget(plan);
    }
    private JSObject commit(JSONObject input, long generation, String cookie, boolean blocked, String owner) throws Exception {
        fields(input, "generation", "phase", "lease", "baseHead", "proofEpoch", "planId", "checksum", "confirm");
        String id = OutboxPolicy.id(input.getString("planId")), checksum = input.getString("checksum"); NativePolicy.require(checksum.matches("[0-9a-f]{64}") && input.opt("confirm") instanceof Boolean);
        JSONObject grant = host.verified(cookie, blocked); if (grant == null || !owner.equals(host.get("owner")) || !input.getString("lease").equals(host.get("lease"))) throw new Failure("OUTBOX_RECONCILE_STALE");
        try(Cursor cancelled=db.rawQuery("SELECT 1 FROM native_reconcile_cancelled WHERE profile_id=? AND id=?",new String[]{grant.getString("profileId"),id})){if(cancelled.moveToFirst())throw new Failure("OUTBOX_RECONCILE_CANCELLED");}
        try (Cursor c = db.rawQuery("SELECT profile_id,owner,session_ref,lease,checksum,payload FROM reconcile_receipts WHERE id=?", new String[]{id})) {
            if (c.moveToFirst()) {
                if (!c.getString(0).equals(grant.getString("profileId")) || !c.getString(1).equals(owner) || !c.getString(2).equals(grant.getString("session_ref")) || !c.getString(3).equals(input.getString("lease")) || !c.getString(4).equals(checksum)) throw new Failure("OUTBOX_RECONCILE_STALE");
                JSONObject receipt = new JSONObject(c.getString(5));
                if (receipt.getJSONObject("receipt").getLong("sourceHead") != OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1) || receipt.getLong("proofEpoch") != OutboxPolicy.integer(input.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1)) throw new Failure("OUTBOX_RECONCILE_STALE");
                return new JSObject(c.getString(5));
            }
        }
        JSONObject p = plan(); if (p == null || !p.getString("id").equals(id) || !p.getString("state").equals("ready") || !p.getString("checksum").equals(checksum)) throw new Failure("OUTBOX_RECONCILE_STALE");
        checked(p, cookie, blocked, owner);
        if (OutboxPolicy.integer(input.opt("baseHead"), 0, OutboxPolicy.SAFE - 1) != p.getLong("expectedHead") || OutboxPolicy.integer(input.opt("proofEpoch"), 0, OutboxPolicy.SAFE - 1) != p.getLong("expectedProof") || p.getBoolean("requiresConfirmation") && input.opt("confirm") != Boolean.TRUE) throw new Failure("OUTBOX_RECONCILE_CONFIRMATION_REQUIRED");
        JSObject result = new JSObject();
        db.beginTransaction(); try {
            checked(p, cookie, blocked, owner); long source = host.head();
            Set<String> freshLocalPages = new HashSet<>(), oldPageIDs = new HashSet<>();
            if (!p.getString("mode").equals("current")) {
                for (Row row : rows(id, "source")) if (row.resource != null && row.resource.split("\\|", -1).length == 5) oldPageIDs.add(resourceID(row.resource));
                for (Row row : rows(id, "output")) if (row.bucket.equals("localPages") && !oldPageIDs.contains(resourceID(row.resource))) freshLocalPages.add(resourceID(row.resource));
            }
            for (Row row : rows(id, "source")) {
                if (!row.profile.equals(p.getString("profile")) || !row.mode.equals("active")) continue;
                String action = p.getJSONObject("actions").optString(row.ref(), "baseline");
                if (!action.equals("keep")) archive(p, row, action.equals("quarantine") ? "reconcile_conflict" : "reconcile_baseline");
            }
            for(String pointer:Arrays.asList("active","last-profile")){
                try(Cursor old=db.rawQuery("SELECT profile_id,rowid,length(payload) FROM records WHERE mode='active' AND bucket='meta' AND key=?",new String[]{host.key(pointer)})){
                    if(old.moveToFirst()&&!old.getString(0).equals(p.getString("profile"))){
                        archiveVersion(old.getString(0),null,"meta",host.key(pointer),host.payload("records",old.getLong(1),old.getInt(2)),"native_pointer_replacement");
                        db.execSQL("DELETE FROM records WHERE mode='active' AND bucket='meta' AND key=?",new Object[]{host.key(pointer)});
                        db.execSQL("DELETE FROM native_record_owners WHERE mode='active' AND bucket='meta' AND key=?",new Object[]{host.key(pointer)});
                    }
                }
            }
            db.execSQL("DELETE FROM records WHERE mode='active' AND profile_id=?", new Object[]{p.getString("profile")});
            db.execSQL("INSERT INTO records SELECT mode,bucket,key,profile_id,resource_key,payload FROM reconcile_rows WHERE plan_id=? AND phase='output'", new Object[]{id});
            for (Row row : rows(id, "output")) host.qualify("active", row.bucket, row.key, row.profile, row.raw(), grant, true);
            db.execSQL("DELETE FROM native_observed_resources WHERE profile_id=?",new Object[]{p.getString("profile")});
            if (host.preflight(grant).issues.length() != 0 || host.verified(cookie, blocked) == null || System.currentTimeMillis() >= p.getLong("expiresAt")) throw new Failure("OUTBOX_RECONCILE_RETRY");
            host.stampLocalVersions(grant, freshLocalPages, null);
            long head = host.advance();
            JSONObject receipt = new JSONObject().put("version", 1).put("planId", id).put("checksum", checksum).put("sourceHead", source).put("targetHead", head).put("mode", p.getString("mode")).put("counts", p.getJSONObject("counts"));
            result.put("generation", generation); result.put("state", "committed"); result.put("planId", id); result.put("lease", p.getString("lease")); result.put("head", head); result.put("proofEpoch", host.proofEpoch()); result.put("checksum", checksum); result.put("receipt", receipt);
            db.execSQL("INSERT INTO reconcile_receipts VALUES(?,?,?,?,?,?,?)", new Object[]{id, p.getString("profile"), owner, grant.getString("session_ref"), p.getString("lease"), checksum, result.toString()});
            discard(id); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        host.reconciled(); return result;
    }
    private static final Set<String> INPUT = new HashSet<>(Arrays.asList("operations", "drafts", "mutations", "localPages", "transfers"));
    private Set<String> visible(JSONObject workspace,String kind)throws Exception{
        Set<String> ids=new HashSet<>();JSONArray values=workspace.getJSONArray(kind.equals("page")?"pages":"databases");for(int i=0;i<values.length();i++)ids.add(OutboxPolicy.text(values.getJSONObject(i).opt("id"),1000));return ids;
    }
    private boolean descriptor(JSONObject p,String kind,String id)throws Exception{
        JSONArray expected=p.getJSONArray("expected");for(int i=0;i<expected.length();i++)if(expected.getJSONObject(i).getString("kind").equals(kind)&&expected.getJSONObject(i).getString("id").equals(id))return false;
        if(expected.length()>=MAX_ITEMS)throw new Failure("OUTBOX_RECONCILE_LIMIT");expected.put(new JSONObject().put("kind",kind).put("id",id));return true;
    }
    private void expandSources(JSONObject p,JSONObject workspace)throws Exception{
        Set<String> pages=visible(workspace,"page"),databases=visible(workspace,"database");
        for(Row row:rows(p.getString("id"),"source")){
            if(row.mode.equals("active")&&row.profile.equals(p.getString("profile"))&&!"native".equals(host.sourceTrust(row.mode,row.bucket,row.key,row.profile,row.raw(),OutboxPolicy.actorPrefix(host.origin,row.profile))))continue;
            if(row.resource!=null&&OutboxPolicy.resource(row.profile,row.resource)){
                String kind=row.resource.split("\\|",-1).length==6?"database":"page",id=resourceID(row.resource);if((kind.equals("page")?pages:databases).contains(id) || kind.equals("page") && host.serverObserved(workspace.getString("workspace_id"),id))descriptor(p,kind,id);
            }
            if(row.bucket.equals("mutations")){
                JSONObject operation=row.value().getJSONObject("operation"),body=operation.getJSONObject("body");
                if(operation.getString("kind").equals("page.create")&&!body.isNull("parent_id")&&pages.contains(body.getString("parent_id")))descriptor(p,"page",body.getString("parent_id"));
                JSONObject base=operation.optJSONObject("base"),schema=base==null?null:base.optJSONObject("schema");
                if(schema!=null){Iterator<String> keys=schema.keys();while(keys.hasNext()){JSONObject field=schema.getJSONObject(keys.next());if("relation".equals(field.opt("type"))&&!field.isNull("database_id")&&databases.contains(field.getString("database_id")))descriptor(p,"database",field.getString("database_id"));}}
            }
        }
        try(Cursor c=db.rawQuery("SELECT kind,id FROM native_observed_resources WHERE profile_id=? AND session_ref=? ORDER BY kind,id",new String[]{p.getString("profile"),p.getString("sessionRef")})){
            while(c.moveToNext())if((c.getString(0).equals("page")?pages:databases).contains(c.getString(1)))descriptor(p,c.getString(0),c.getString(1));
        }
    }
    private boolean expandRelations(JSONObject p)throws Exception{
        JSONObject workspace=response(p,"workspace","workspace");if(workspace==null)return false;Set<String> visible=visible(workspace,"database");boolean changed=false;
        JSONArray expected=p.getJSONArray("expected");int existing=expected.length();
        for(int i=0;i<existing;i++){
            JSONObject d=expected.getJSONObject(i);if(!d.getString("kind").equals("database"))continue;JSONObject body=response(p,"database",d.getString("id"));if(body==null)continue;
            JSONArray schema=body.getJSONObject("database").getJSONArray("properties"),rows=body.getJSONArray("rows");
            for(int j=0;j<schema.length();j++){JSONObject field=schema.getJSONObject(j);String type=field.getString("type");if(!Arrays.asList("relation","files").contains(type))continue;
                boolean used=false;if(type.equals("relation"))for(int k=0;k<rows.length();k++){JSONArray links=rows.getJSONObject(k).getJSONObject("properties").optJSONArray(field.getString("id"));if(links!=null&&links.length()>0)used=true;}
                for(Row source:rows(p.getString("id"),"source")){
                    if(!source.bucket.equals("mutations"))continue;
                    if(source.mode.equals("active")&&source.profile.equals(p.getString("profile"))&&!"native".equals(host.sourceTrust(source.mode,source.bucket,source.key,source.profile,source.raw(),OutboxPolicy.actorPrefix(host.origin,source.profile))))continue;
                    JSONObject operation=source.value().getJSONObject("operation");if(!d.getString("id").equals(operation.opt("database_id")))continue;
                    List<JSONObject> values=new ArrayList<>();JSONObject properties=operation.getJSONObject("body").optJSONObject("properties"),base=operation.optJSONObject("base");if(properties!=null)values.add(properties);if(base!=null&&base.optJSONObject("properties")!=null)values.add(base.getJSONObject("properties"));
                    for(JSONObject input:values){JSONArray links=input.optJSONArray(field.getString("id"));if(links!=null&&links.length()>0){used=true;if(type.equals("files"))for(int k=0;k<links.length();k++)changed|=descriptor(p,"attachment",OutboxPolicy.text(links.get(k),1000));}}
                }
                if(used&&type.equals("relation")){if(field.isNull("database_id")){for(String candidate:new TreeSet<>(visible))changed|=descriptor(p,"database",candidate);}else if(visible.contains(field.getString("database_id")))changed|=descriptor(p,"database",field.getString("database_id"));}
            }
        }
        return changed;
    }
    private void metadata(JSONObject value, String id) throws Exception {
        Set<String> fields = new HashSet<>(Arrays.asList("id", "name", "size", "mime", "storage", "status", "sha256")); Iterator<String> keys = value.keys();
        while (keys.hasNext()) NativePolicy.require(fields.contains(keys.next()));
        NativePolicy.require(id.equals(OutboxPolicy.text(value.opt("id"), 1000)) && "complete".equals(value.opt("status")) && Arrays.asList("inline", "chunks").contains(value.opt("storage")));
        String name = OutboxPolicy.text(value.opt("name"), 510); NativePolicy.require(!name.trim().isEmpty() && name.codePointCount(0, name.length()) <= 255 && !name.contains("/") && !name.contains("\\") && !name.equals(".") && !name.equals(".."));
        OutboxPolicy.text(value.opt("mime"), 255); OutboxPolicy.integer(value.opt("size"), 0, 5_000_000_000L);
        if (value.has("sha256")) NativePolicy.require(value.opt("sha256") instanceof String && value.getString("sha256").matches("[0-9a-f]{64}"));
    }
    private void attachmentIDs(Object value, Set<String> result, int depth) throws Exception {
        NativePolicy.require(depth <= 64);
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            if (object.opt("attachment_id") instanceof String) result.add(OutboxPolicy.text(object.get("attachment_id"), 1000));
            if ("block.set".equals(object.opt("type")) && "attachment_id".equals(object.opt("field")) && !object.isNull("value")) result.add(OutboxPolicy.text(object.get("value"), 1000));
            Iterator<String> keys = object.keys(); while (keys.hasNext()) attachmentIDs(object.get(keys.next()), result, depth + 1);
        } else if (value instanceof JSONArray) { JSONArray array = (JSONArray) value; for (int i = 0; i < array.length(); i++) attachmentIDs(array.get(i), result, depth + 1); }
        if (result.size() > MAX_ITEMS) throw new Failure("OUTBOX_RECONCILE_LIMIT");
    }
    private final class Row {
        final String mode, bucket, key, profile, resource, table; final int size; final long rowid;
        Row(Cursor c, String table) { mode = c.getString(0); bucket = c.getString(1); key = c.getString(2); profile = c.getString(3); resource = c.isNull(4) ? null : c.getString(4); size = c.getInt(5); rowid = c.getLong(6); this.table = table; }
        byte[] raw() throws Exception { return host.payload(table, rowid, size); }
        JSONObject value() throws Exception { return new JSONObject(OutboxPolicy.utf8(raw())); }
        String ref() { return bucket + "\u0000" + key; }
    }
    private List<Row> rows(String plan, String phase) throws Exception {
        List<Row> result = new ArrayList<>(); long bytes = 0;
        try (Cursor c = db.rawQuery("SELECT mode,bucket,key,profile_id,resource_key,length(payload),rowid FROM reconcile_rows WHERE plan_id=? AND phase=? ORDER BY mode,bucket,key", new String[]{plan, phase})) {
            while (c.moveToNext()) { Row row = new Row(c, "reconcile_rows"); bytes += row.size; if (row.size > OutboxPolicy.RECORD || bytes > OutboxPolicy.TRANSACTION || result.size() >= 100000) throw new Failure("OUTBOX_RECONCILE_LIMIT"); result.add(row); }
        }
        return result;
    }
    private boolean isInput(Row row) throws Exception { return INPUT.contains(row.bucket) && !(row.bucket.equals("drafts") && row.value().getJSONObject("draft").optString("reason").equals("basis")); }
    private static void increment(JSONObject counts, String key) throws Exception { counts.put(key, counts.getLong(key) + 1); NativePolicy.require(counts.getLong(key) <= 100000); }
    private String resourceID(String resource) throws Exception {
        NativePolicy.require(resource != null); String encoded = resource.substring(resource.lastIndexOf('|') + 1), id = java.net.URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8");
        NativePolicy.require(OutboxPolicy.encode(id).equals(encoded)); return id;
    }
    private void output(JSONObject p, String bucket, Object key, String resource, JSONObject value) throws Exception {
        byte[] raw = value.toString().getBytes(StandardCharsets.UTF_8); NativePolicy.require(raw.length <= OutboxPolicy.RECORD);
        db.execSQL("INSERT OR REPLACE INTO reconcile_rows VALUES(?,'output','active',?,?,?,?,?)", new Object[]{p.getString("id"), bucket, host.key(key), p.getString("profile"), resource, raw});
    }
    private void outputRaw(JSONObject p, Row row) throws Exception { db.execSQL("INSERT OR REPLACE INTO reconcile_rows VALUES(?,'output','active',?,?,?,?,?)", new Object[]{p.getString("id"), row.bucket, row.key, p.getString("profile"), row.resource, row.raw()}); }
    private String compatible(JSONObject p,Row row, Map<String, JSONObject> pages, Map<String, JSONObject> databases) throws Exception {
        JSONObject value = row.value(); if (!row.profile.equals(value.getString("profileId")) || !OutboxPolicy.resource(row.profile, row.resource)) return "unsupported_input";
        Set<String> attachmentRefs=new HashSet<>();
        if(row.bucket.equals("operations"))attachmentIDs(value.getJSONObject("operation"),attachmentRefs,0);
        if(row.bucket.equals("drafts")){JSONObject draft=value.getJSONObject("draft");if(draft.has("blocks"))attachmentIDs(draft.get("blocks"),attachmentRefs,0);if(draft.has("ops"))attachmentIDs(draft.get("ops"),attachmentRefs,0);}
        for(String attachment:attachmentRefs){if(!captured(p,"attachment",attachment))throw new Failure("OUTBOX_RECONCILE_RETRY");if(response(p,"attachment",attachment)==null)return "denied";}
        String id = resourceID(row.resource), kind = row.resource.split("\\|", -1).length == 6 ? "database" : "page";
        if (row.bucket.equals("localPages") && value.getJSONObject("metadata").opt("localOnly") == Boolean.TRUE) return null;
        JSONObject canonical = kind.equals("page") ? pages.get(id) : databases.get(id);
        if (canonical == null) {
            if (kind.equals("page") && hasLocalPage(row.profile, id)) return null;
            return "denied";
        }
        JSONObject resource = canonical.getJSONObject(kind.equals("page") ? "page" : "database");
        long access = OutboxPolicy.integer(resource.opt("access_level"), 1, 4);
        if ((row.bucket.equals("operations") || row.bucket.equals("mutations") || row.bucket.equals("transfers")) && (!OutboxPolicy.capability(access, 3, resource.opt("locked") == Boolean.TRUE, resource.opt("archived") == Boolean.TRUE) && !kind.equals("database"))) return "denied";
        if (row.bucket.equals("operations") || row.bucket.equals("drafts")) {
            JSONObject body = value.getJSONObject(row.bucket.equals("operations") ? "operation" : "draft"); String field = row.bucket.equals("operations") ? "_epoch" : "epoch";
            if (!canonical.getString("epoch").equals(body.opt(field))) return "epoch_changed";
        }
        if (row.bucket.equals("mutations")) {
            if (!Arrays.asList("pending", "deferred", "applied").contains(value.optString("status"))) return "unsupported_input";
            JSONObject operation = value.getJSONObject("operation"); JSONObject base = operation.optJSONObject("base");
            if (kind.equals("database") && base != null && base.optJSONObject("schema") != null) {
                Map<String, JSONObject> properties = new HashMap<>(); JSONArray schema = resource.getJSONArray("properties"); for (int i = 0; i < schema.length(); i++) properties.put(schema.getJSONObject(i).getString("id"), schema.getJSONObject(i));
                Iterator<String> keys = base.getJSONObject("schema").keys(); while (keys.hasNext()) { String property = keys.next(); if (!properties.containsKey(property) || !host.canonical(properties.get(property), false).equals(host.canonical(base.getJSONObject("schema").get(property), false))) return "schema_changed"; }
            }
        }
        return null;
    }
    private boolean hasLocalPage(String profile, String id) throws Exception {
        JSONObject p = plan(); if (p == null) return false;
        String resource = profile + "|" + OutboxPolicy.encode(id);
        try (Cursor c = db.rawQuery("SELECT rowid,length(payload) FROM reconcile_rows WHERE plan_id=? AND phase='source' AND mode='active' AND profile_id=? AND bucket='localPages' AND resource_key=?", new String[]{p.getString("id"), profile, resource})) {
            return c.moveToFirst() && new JSONObject(OutboxPolicy.utf8(host.payload("reconcile_rows",c.getLong(0),c.getInt(1)))).getJSONObject("metadata").opt("localOnly") == Boolean.TRUE;
        }
    }
    private boolean quarantineResource(JSONObject p, Map<String, Row> input, JSONObject actions, String resource) throws Exception {
        boolean changed = false;
        for (Row row : input.values()) if (Objects.equals(row.resource, resource) && actions.optString(row.ref()).equals("keep")) { actions.put(row.ref(), "quarantine"); changed = true; }
        for (Row output : rows(p.getString("id"), "output")) if (Objects.equals(output.resource, resource) && isInput(output))
            db.execSQL("DELETE FROM reconcile_rows WHERE plan_id=? AND phase='output' AND bucket=? AND key=?", new Object[]{p.getString("id"), output.bucket, output.key});
        String id = resourceID(resource);
        if (!captured(p, "page", id)) db.execSQL("DELETE FROM reconcile_rows WHERE plan_id=? AND phase='output' AND bucket='snapshots' AND resource_key=?", new Object[]{p.getString("id"), resource});
        return changed;
    }
    private boolean quarantineMutation(JSONObject p, Map<String, Row> input, JSONObject actions, Row row) throws Exception {
        if (row.value().getJSONObject("operation").getString("kind").equals("page.create")) return quarantineResource(p, input, actions, row.resource);
        if (!actions.optString(row.ref()).equals("keep")) return false;
        actions.put(row.ref(), "quarantine");
        db.execSQL("DELETE FROM reconcile_rows WHERE plan_id=? AND phase='output' AND bucket=? AND key=?", new Object[]{p.getString("id"), row.bucket, row.key}); return true;
    }
    private void cascade(JSONObject p, Map<String, Row> input, JSONObject actions, TreeSet<String> reasons) throws Exception {
        boolean changed;
        do {
            changed = false; Set<String> rejected = new HashSet<>();
            Set<String> localGroups=new HashSet<>();JSONArray groups=p.optJSONArray("localGroups");if(groups!=null)for(int i=0;i<groups.length();i++)localGroups.add(groups.getString(i));
            for(Row row:input.values())if(actions.optString(row.ref()).equals("quarantine")&&localGroups.contains(row.resource)){changed|=quarantineResource(p,input,actions,row.resource);reasons.add("dependency_conflict");}
            for (Row row : input.values()) if (row.bucket.equals("mutations") && actions.optString(row.ref()).equals("quarantine")) rejected.add(row.value().getString("id"));
            for (Row row : input.values()) {
                if (!row.bucket.equals("mutations") || !actions.optString(row.ref()).equals("keep")) continue;
                JSONObject operation = row.value().getJSONObject("operation"); JSONArray dependencies = operation.optJSONArray("depends_on"); boolean blocked = false;
                if (dependencies != null) for (int i = 0; i < dependencies.length(); i++) if (rejected.contains(dependencies.getString(i))) blocked = true;
                JSONObject bases = operation.optJSONObject("base_rows"); if (bases != null) { Iterator<String> keys = bases.keys(); while (keys.hasNext()) if (rejected.contains(bases.getJSONObject(keys.next()).optString("after_operation"))) blocked = true; }
                if (blocked) { changed |= quarantineMutation(p, input, actions, row); reasons.add("dependency_conflict"); }
            }
        } while (changed);
    }
    private void archive(JSONObject p, Row row, String reason) throws Exception {
        archiveVersion(row.profile, row.resource, row.bucket, row.key, row.raw(), reason);
        if (INPUT.contains(row.bucket)) {
            try (Cursor existing = db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='quarantine' AND bucket=? AND key=?", new String[]{row.bucket, row.key})) { if (existing.moveToFirst() && !Arrays.equals(host.payload("records",existing.getLong(0),existing.getInt(1)), row.raw())) return; }
            boolean newQuarantine; try (Cursor old = db.rawQuery("SELECT 1 FROM records WHERE mode='quarantine' AND bucket=? AND key=?", new String[]{row.bucket,row.key})) { newQuarantine = !old.moveToFirst(); }
            String localContext = host.nativeLocalVersion(row.profile, row.bucket, row.key, row.raw(), OutboxPolicy.actorPrefix(host.origin,row.profile));
            db.execSQL("INSERT OR IGNORE INTO records(mode,bucket,key,profile_id,resource_key,payload) VALUES('quarantine',?,?,?,?,?)", new Object[]{row.bucket, row.key, row.profile, row.resource, row.raw()});
            if (newQuarantine && localContext != null) db.execSQL("INSERT INTO native_local_versions_v1 VALUES('quarantine',?,?,?,?,?,?)", new Object[]{row.profile,row.bucket,row.key,OutboxPolicy.hash(row.raw()),OutboxPolicy.actorPrefix(host.origin,row.profile),localContext});
            db.execSQL("INSERT OR REPLACE INTO native_record_owners SELECT 'quarantine',bucket,key,profile_id,actor,digest,trust FROM native_record_owners WHERE mode=? AND bucket=? AND key=? AND profile_id=?", new Object[]{row.mode, row.bucket, row.key, row.profile});
        }
    }
    void archiveVersion(String profile, String resource, String bucket, String key, byte[] raw, String reason) throws Exception {
        NativePolicy.require(raw.length > 0 && raw.length <= OutboxPolicy.RECORD && OutboxPolicy.actorPrefix(host.origin, profile) != null);
        String digest = OutboxPolicy.hash(raw), id = "native-archive:" + OutboxPolicy.hash(new JSONArray().put(profile).put(bucket).put(key).put(digest).toString());
        boolean freshArchive; try (Cursor existing = db.rawQuery("SELECT 1 FROM recovery WHERE id=?", new String[]{id})) { freshArchive = !existing.moveToFirst(); }
        db.execSQL("INSERT OR IGNORE INTO recovery VALUES(?,?,?)", new Object[]{id, reason, raw});
        host.set("recovery-owner:" + id, profile);
        String actor = "", trust = "opaque", current = host.get("grant");
        if(Arrays.asList("native_pointer_replacement","native_denial_collision","reconcile_baseline","reconcile_conflict").contains(reason)){
            try(Cursor source=db.rawQuery("SELECT actor,trust,digest FROM native_record_owners WHERE bucket=? AND key=? AND profile_id=? ORDER BY mode",new String[]{bucket,key,profile})){
                while(source.moveToNext())if(digest.equals(source.getString(2))&&source.getString(0).equals(OutboxPolicy.actorPrefix(host.origin,profile))&&Arrays.asList("native","untrusted").contains(source.getString(1))){actor=source.getString(0);trust=source.getString(1);break;}
            }
        }
        if (current != null && "verified".equals(host.get("identity_state"))) {
            JSONObject nativeGrant = new JSONObject(current); String actual = OutboxPolicy.actorPrefix(host.origin, nativeGrant.getString("profileId"));
            for (String mode : Arrays.asList("active", "quarantine")) { String qualified = host.sourceTrust(mode, bucket, key, profile, raw, actual); if (qualified != null && !qualified.equals("opaque")) { actor = actual; trust = qualified; break; } }
            if (reason.equals("quarantine_collision") && actual != null && actual.equals(OutboxPolicy.actorPrefix(host.origin, profile))) { actor = actual; if (trust.equals("opaque")) trust = "untrusted"; }
        }
        db.execSQL("INSERT OR IGNORE INTO native_recovery_records(id,version,profile_id,resource_key,bucket,key,digest,actor,trust) VALUES(?,1,?,?,?,?,?,?,?)", new Object[]{id, profile, resource, bucket, key, digest, actor, trust});
        if (freshArchive && "native".equals(trust)) {
            String context = host.nativeLocalVersion(profile, bucket, key, raw, actor);
            if (context != null) db.execSQL("INSERT INTO native_local_versions_v1 VALUES(?,?,?,?,?,?,?)", new Object[]{"archive:" + id, profile, bucket, key, digest, actor, context});
        }
    }
    private void promote(JSONObject p, JSONObject grant, List<Row> original, JSONObject workspace, Map<String, JSONObject> pages, Map<String, JSONObject> databases, JSONObject counts, TreeSet<String> reasons) throws Exception {
        String profile = p.getString("profile"), plan = p.getString("id"); long now = System.currentTimeMillis();
        List<Row> selected = new ArrayList<>(); Set<String> groups = new HashSet<>();
        for (int i = 0; i < p.getJSONArray("selected").length(); i++) { JSONObject group = p.getJSONArray("selected").getJSONObject(i); groups.add(group.getString("profile") + "\u0000" + group.getString("mode")); }
        Set<String> versions = new HashSet<>();
        for (Row row : original) if (groups.contains(row.profile + "\u0000" + (row.mode.startsWith("archive:") ? "archive" : row.mode)) && versions.add(row.profile + "\u0000" + row.ref() + "\u0000" + OutboxPolicy.hash(row.raw()))) {
            boolean mirror=false;
            if(row.profile.equals(profile))try(Cursor active=db.rawQuery("SELECT rowid,length(payload) FROM records WHERE mode='active' AND bucket=? AND key=? AND profile_id=?",new String[]{row.bucket,row.key,profile})){
                if(active.moveToFirst()&&Arrays.equals(host.payload("records",active.getLong(0),active.getInt(1)),row.raw())&&"native".equals(host.sourceTrust("active",row.bucket,row.key,profile,row.raw(),OutboxPolicy.actorPrefix(host.origin,profile))))mirror=true;
            }
            if(!mirror)selected.add(row);
        }
        if(selected.isEmpty())return;
        // Permanent existence evidence overrides every historical local flag.
        // Source IDs come from private captured row scope, never renamed bodies.
        Set<String> sourceAttachments = new TreeSet<>();
        for (Row row : selected) {
            if (row.resource != null && row.resource.split("\\|", -1).length == 5 && host.serverObserved(workspace.getString("workspace_id"), resourceID(row.resource))) {
                JSONObject direct = response(p, "page", resourceID(row.resource));
                if (direct == null || !OutboxPolicy.capability(direct.getLong("access_level"), 3, direct.getJSONObject("page").opt("locked") == Boolean.TRUE, direct.getJSONObject("page").opt("archived") == Boolean.TRUE)) throw new Failure("OUTBOX_ACCESS_REQUIRED");
            }
            attachmentIDs(row.value(), sourceAttachments, 0);
        }
        for (String attachment : sourceAttachments) if (response(p,"attachment",attachment)==null) throw new Failure("OUTBOX_ACCESS_REQUIRED");
        JSONObject previousCounts = new JSONObject(counts.toString());
        db.beginTransaction(); try {
        Map<String, JSONArray> bodyTargets = new LinkedHashMap<>();
        Map<String, JSONArray> readable = new LinkedHashMap<>(); Set<String> bodyGroups = new TreeSet<>();
        for (Row row : selected) {
            if (row.resource == null || row.resource.split("\\|", -1).length != 5) continue;
            if (row.bucket.equals("operations") || row.bucket.equals("drafts") && !row.value().getJSONObject("draft").optString("reason").equals("basis")
                || row.bucket.equals("mutations") && row.value().getJSONObject("operation").getString("kind").equals("page.create")) bodyGroups.add(row.profile + "\u0000" + resourceID(row.resource));
        }
        Map<String, String> mutationIDs = new HashMap<>(), pageIDs = new HashMap<>(), rowIDs = new HashMap<>();
        Map<String, Row> mutations = new LinkedHashMap<>();
        for (Row row : selected) if (row.bucket.equals("mutations")) {
            JSONObject value = row.value(), operation = value.getJSONObject("operation"); String key = row.profile + "\u0000" + value.getString("id");
            NativePolicy.require(value.getString("id").equals(operation.getString("id")) && !mutations.containsKey(key));
            mutations.put(key, row); mutationIDs.put(key, UUID.randomUUID().toString());
            if (operation.getString("kind").equals("page.create")) NativePolicy.require(pageIDs.put(row.profile + "\u0000" + operation.getString("target_id"), UUID.randomUUID().toString()) == null);
            if (operation.getString("kind").equals("row.create")) NativePolicy.require(rowIDs.put(row.profile + "\u0000" + operation.getString("database_id") + "\u0000" + operation.getString("target_id"), UUID.randomUUID().toString()) == null);
        }
        List<String> ordered = promotionOrder(mutations);
        Map<String, JSONObject> virtualPages = new HashMap<>(), virtualRows = new HashMap<>();
        Map<String, String> lastRowOperation = new HashMap<>(); Set<String> loadedDatabases = new HashSet<>();
        for (String key : ordered) {
            Row source = mutations.get(key); JSONObject old = source.value().getJSONObject("operation"), body = new JSONObject(old.getJSONObject("body").toString());
            String kind = old.getString("kind"), oldTarget = old.getString("target_id"), database = old.optString("database_id", null);
            String target = kind.startsWith("page.") ? pageIDs.getOrDefault(source.profile + "\u0000" + oldTarget, oldTarget) : rowIDs.getOrDefault(source.profile + "\u0000" + database + "\u0000" + oldTarget, oldTarget);
            String id = mutationIDs.get(key), resource = profile + (kind.startsWith("row.") ? "|database|" + OutboxPolicy.encode(database) : "|" + OutboxPolicy.encode(target));
            JSONObject fresh = new JSONObject().put("id", id).put("kind", kind).put("target_id", target).put("body", body); JSONArray dependencies = new JSONArray();
            for (String edge : promotionEdges(old)) { String mapped = mutationIDs.get(source.profile + "\u0000" + edge); if (mapped == null) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT"); dependencies.put(mapped); }
            fresh.put("depends_on", dependencies);
            if (kind.equals("page.create")) {
                Iterator<String> sourceFields = body.keys(); while (sourceFields.hasNext()) if (!Arrays.asList("id", "title", "icon", "cover", "parent_id", "teamspace_id", "permissions").contains(sourceFields.next())) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                String parent = body.isNull("parent_id") ? null : body.getString("parent_id");
                if (parent != null) parent = pageIDs.getOrDefault(source.profile + "\u0000" + parent, parent);
                JSONObject parentPage = parent == null ? null : virtualPages.get(parent);
                if (parent != null && parentPage == null && pages.containsKey(parent)) parentPage = pages.get(parent).getJSONObject("page");
                if (parent != null && (parentPage == null || !OutboxPolicy.capability(parentPage.getLong("access_level"), 3, parentPage.opt("locked") == Boolean.TRUE, parentPage.opt("archived") == Boolean.TRUE))) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                if (parent == null && "guest".equals(grant.getString("role"))) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                body.put("id", target).put("parent_id", parent == null ? JSONObject.NULL : parent);
                if (parentPage != null) body.put("teamspace_id", parentPage.opt("teamspace_id") == null ? JSONObject.NULL : parentPage.opt("teamspace_id"));
                body.put("permissions", new JSONObject().put("default", "private").put("inherit", false).put("members", new JSONObject()).put("groups", new JSONObject()));
                String epoch = UUID.randomUUID().toString(); fresh.put("document_epoch", epoch);
                JSONObject page = new JSONObject(body.toString()).put("owner_id", workspace.getString("current_member_id")).put("access_level", 4).put("revision", 0).put("locked", false).put("archived", false).put("favorite", false).put("blocks", new JSONArray());
                virtualPages.put(target, page);
                JSONObject snapshot = new JSONObject().put("workspace_id", workspace.getString("workspace_id")).put("current_member_id", workspace.getString("current_member_id")).put("session_binding", workspace.getString("session_binding"))
                    .put("access_revision", workspace.getLong("access_revision")).put("data_revision", 0).put("access_level", 4).put("epoch", epoch).put("seq", 0).put("page", page).put("blocks", new JSONArray())
                    .put("state", new JSONObject().put("version", 1).put("max_clock", 0).put("blocks", new JSONObject()).put("seen", new JSONObject()));
                output(p, "snapshots", resource, resource, new JSONObject().put("key", resource).put("profileId", profile).put("snapshot", snapshot).put("updatedAt", now)); increment(counts, "refresh");
                output(p, "localPages", resource, resource, new JSONObject().put("key", resource).put("resourceKey", resource).put("profileId", profile).put("metadata", new JSONObject().put("page", page).put("initial_epoch", epoch).put("create_operation_id", id).put("localOnly", true)).put("updatedAt", now)); increment(counts, "import");
                bodyTargets.put(source.profile + "\u0000" + oldTarget, new JSONArray().put(resource).put(epoch));
            } else if (kind.equals("page.patch")) {
                JSONObject page = virtualPages.get(target); if (page == null && pages.containsKey(target)) page = new JSONObject(pages.get(target).getJSONObject("page").toString());
                if (page == null || !OutboxPolicy.capability(page.getLong("access_level"), 3, page.opt("locked") == Boolean.TRUE, page.opt("archived") == Boolean.TRUE)) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                JSONObject fields = new JSONObject(); Iterator<String> keys = body.keys(); while (keys.hasNext()) { String field = keys.next(); NativePolicy.require(Arrays.asList("title", "icon", "cover", "favorite").contains(field)); fields.put(field, page.has(field) ? page.get(field) : JSONObject.NULL); }
                fresh.put("base", new JSONObject().put("fields", fields));
                keys = body.keys(); while (keys.hasNext()) { String field = keys.next(); page.put(field, body.get(field)); } virtualPages.put(target, page);
            } else if (kind.startsWith("row.")) {
                JSONObject canonical = databases.get(database); if (canonical == null) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                if (loadedDatabases.add(database)) {
                    JSONArray currentRows = canonical.getJSONArray("rows");
                    for (int i = 0; i < currentRows.length(); i++) { JSONObject row = currentRows.getJSONObject(i); NativePolicy.require(!virtualRows.containsKey(database + "\u0000" + row.getString("id"))); virtualRows.put(database + "\u0000" + row.getString("id"), new JSONObject(row.toString())); }
                }
                fresh.put("database_id", database); Map<String, JSONObject> schema = new HashMap<>(); JSONArray definitions = canonical.getJSONObject("database").getJSONArray("properties");
                for (int i = 0; i < definitions.length(); i++) schema.put(definitions.getJSONObject(i).getString("id"), definitions.getJSONObject(i));
                if (kind.equals("row.create")) body.put("id", target);
                if (!body.isNull("parent_row_id")) body.put("parent_row_id", rowIDs.getOrDefault(source.profile + "\u0000" + database + "\u0000" + body.getString("parent_row_id"), body.getString("parent_row_id")));
                if (body.optJSONArray("depends_on") != null) { JSONArray ids = body.getJSONArray("depends_on"); for (int i = 0; i < ids.length(); i++) ids.put(i, rowIDs.getOrDefault(source.profile + "\u0000" + database + "\u0000" + ids.getString(i), ids.getString(i))); }
                JSONObject properties = body.optJSONObject("properties"); if (properties != null) { Iterator<String> keys = properties.keys(); while (keys.hasNext()) {
                    String property = keys.next(); JSONObject definition = schema.get(property); NativePolicy.require(definition != null && !Arrays.asList("formula", "rollup").contains(definition.getString("type")));
                    if (definition.getString("type").equals("relation") && !properties.isNull(property)) { JSONArray ids = properties.getJSONArray(property); for (int i = 0; i < ids.length(); i++) ids.put(i, rowIDs.getOrDefault(source.profile + "\u0000" + (definition.isNull("database_id") ? database : definition.getString("database_id")) + "\u0000" + ids.getString(i), ids.getString(i))); }
                    if (definition.getString("type").equals("files") && !properties.isNull(property)) { JSONArray ids = properties.getJSONArray(property); for (int i = 0; i < ids.length(); i++) if (response(p, "attachment", ids.getString(i)) == null) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT"); }
                } }
                JSONObject before = virtualRows.get(database + "\u0000" + target);
                if (kind.equals("row.create")) {
                    NativePolicy.require(canonical.getJSONObject("database").opt("can_create_row") == Boolean.TRUE && before == null);
                    before = new JSONObject().put("id", target).put("database_id", database).put("properties", properties == null ? new JSONObject() : properties).put("parent_row_id", body.opt("parent_row_id") == null ? JSONObject.NULL : body.opt("parent_row_id")).put("depends_on", body.optJSONArray("depends_on") == null ? new JSONArray() : body.getJSONArray("depends_on")).put("access_level", 3);
                    virtualRows.put(database + "\u0000" + target, before);
                } else if (before == null || before.getLong("access_level") < 3) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                JSONObject base = new JSONObject(), baseSchema = new JSONObject();
                if (properties != null) { Iterator<String> keys = properties.keys(); while (keys.hasNext()) { String property = keys.next(); baseSchema.put(property, schema.get(property)); } }
                base.put("schema", baseSchema);
                if (kind.equals("row.patch")) {
                    JSONObject oldValues = new JSONObject(), oldFields = new JSONObject(); if (properties != null) { Iterator<String> keys = properties.keys(); while (keys.hasNext()) { String property = keys.next(); oldValues.put(property, before.getJSONObject("properties").has(property) ? before.getJSONObject("properties").get(property) : JSONObject.NULL); } }
                    for (String field : Arrays.asList("parent_row_id", "depends_on")) if (body.has(field)) oldFields.put(field, before.has(field) ? before.get(field) : field.equals("depends_on") ? new JSONArray() : JSONObject.NULL);
                    base.put("properties", oldValues).put("fields", oldFields);
                }
                if (kind.equals("row.delete")) {
                    JSONObject bases = new JSONObject(); Set<String> subtree = new TreeSet<>(); subtree.add(target);
                    boolean expanded;
                    do { expanded = false; for (Map.Entry<String, JSONObject> entry : virtualRows.entrySet()) if (entry.getKey().startsWith(database + "\u0000")) {
                        JSONObject row = entry.getValue(); if (!row.isNull("parent_row_id") && subtree.contains(row.getString("parent_row_id")) && subtree.add(row.getString("id"))) expanded = true;
                    } } while (expanded);
                    JSONObject originalBases = old.optJSONObject("base_rows"); Set<String> selectedRows = new TreeSet<>();
                    if (originalBases != null) { Iterator<String> selectedKeys = originalBases.keys(); while (selectedKeys.hasNext()) { String selectedID = selectedKeys.next(); selectedRows.add(rowIDs.getOrDefault(source.profile + "\u0000" + database + "\u0000" + selectedID, selectedID)); } }
                    if (!subtree.equals(selectedRows)) throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
                    Set<String> predecessors = new TreeSet<>(); for (int i = 0; i < dependencies.length(); i++) predecessors.add(dependencies.getString(i));
                    for (String rowID : subtree) {
                        String rowKey = database + "\u0000" + rowID; JSONObject row = virtualRows.get(rowKey); NativePolicy.require(row != null && row.getLong("access_level") >= 3);
                        JSONObject rowBase = new JSONObject().put("updated_at", row.isNull("updated_at") ? "1970-01-01T00:00:00.000Z" : row.getString("updated_at"));
                        String preceding = lastRowOperation.get(rowKey); if (preceding != null) { rowBase.put("after_operation", preceding); predecessors.add(preceding); }
                        bases.put(rowID, rowBase);
                    }
                    NativePolicy.require(predecessors.size() <= 50); JSONArray completeDependencies = new JSONArray(); for (String predecessor : predecessors) completeDependencies.put(predecessor);
                    fresh.put("depends_on", completeDependencies).put("base_rows", bases);
                    for (String rowID : subtree) { virtualRows.remove(database + "\u0000" + rowID); lastRowOperation.remove(database + "\u0000" + rowID); }
                } else {
                    fresh.put("base", base);
                    if (kind.equals("row.patch")) {
                        if (properties != null) { Iterator<String> keys = properties.keys(); while (keys.hasNext()) { String property = keys.next(); before.getJSONObject("properties").put(property, properties.get(property)); } }
                        for (String field : Arrays.asList("parent_row_id", "depends_on")) if (body.has(field)) before.put(field, body.get(field));
                    }
                    virtualRows.put(database + "\u0000" + target, before); lastRowOperation.put(database + "\u0000" + target, id);
                }
            } else throw new Failure("OUTBOX_RECONCILE_UNSUPPORTED_INPUT");
            JSONObject record = new JSONObject().put("profileId", profile).put("id", id).put("resourceKey", resource).put("operation", fresh).put("status", "pending").put("sequence", now + ordered.indexOf(key)).put("createdAt", now).put("updatedAt", now);
            output(p, "mutations", new JSONArray().put(profile).put(id), resource, record); increment(counts, "import");
        }
        for (String group : bodyGroups) if (!bodyTargets.containsKey(group)) {
            String target = group.substring(group.indexOf('\u0000') + 1); JSONObject canonical = pages.get(target);
            if (canonical == null || !OutboxPolicy.capability(canonical.getLong("access_level"), 3, canonical.getJSONObject("page").opt("locked") == Boolean.TRUE, canonical.getJSONObject("page").opt("archived") == Boolean.TRUE)) throw new Failure("OUTBOX_ACCESS_REQUIRED");
            bodyTargets.put(group, new JSONArray().put(profile + "|" + OutboxPolicy.encode(target)).put(canonical.getString("epoch")));
        }
        // Validate permission/dependency-only output BEFORE interpreting body
        // support. A body limit cannot disguise a denied parent/row/attachment.
        new NativeLocalGraph(host, grant, plan);
        long expandedPoints = 0;
        for (String group : bodyGroups) {
            int split = group.indexOf('\u0000'); JSONArray blocks = readableBody(selected, group.substring(0, split), group.substring(split + 1));
            expandedPoints += bodyPoints(blocks); if (expandedPoints > 50000) throw new UnsupportedBody(); readable.put(group, blocks);
        }
        for (Map.Entry<String, JSONArray> entry : readable.entrySet()) {
            JSONArray target = bodyTargets.get(entry.getKey()); importBody(p, target.getString(0), target.getString(1), entry.getValue(), counts);
        }
        db.setTransactionSuccessful();
        } catch (UnsupportedBody unsupported) {
            for (String name : Arrays.asList("refresh","keep","acknowledge","quarantine","import")) counts.put(name, previousCounts.get(name));
            reasons.add("unsupported_input");
        } finally { db.endTransaction(); }
    }
    private Set<String> promotionEdges(JSONObject operation) throws Exception {
        Set<String> edges = new TreeSet<>(); JSONArray explicit = operation.optJSONArray("depends_on"); if (explicit != null) { NativePolicy.require(explicit.length() <= 50); for (int i = 0; i < explicit.length(); i++) edges.add(explicit.getString(i)); }
        JSONObject bases = operation.optJSONObject("base_rows"); if (bases != null) { Iterator<String> keys = bases.keys(); while (keys.hasNext()) { JSONObject base = bases.getJSONObject(keys.next()); if (base.has("after_operation")) edges.add(base.getString("after_operation")); } } return edges;
    }
    private List<String> promotionOrder(Map<String, Row> mutations) throws Exception {
        Map<String, Integer> pending = new LinkedHashMap<>(); Map<String, List<String>> successors = new HashMap<>(); ArrayDeque<String> ready = new ArrayDeque<>();
        for (Map.Entry<String, Row> entry : mutations.entrySet()) {
            Set<String> edges = promotionEdges(entry.getValue().value().getJSONObject("operation")); pending.put(entry.getKey(), edges.size());
            for (String edge : edges) { String predecessor = entry.getValue().profile + "\u0000" + edge; NativePolicy.require(mutations.containsKey(predecessor) && !predecessor.equals(entry.getKey())); successors.computeIfAbsent(predecessor, key -> new ArrayList<>()).add(entry.getKey()); }
            if (edges.isEmpty()) ready.add(entry.getKey());
        }
        List<String> ordered = new ArrayList<>(); while (!ready.isEmpty()) {
            String id = ready.removeFirst(); ordered.add(id);
            for (String successor : successors.getOrDefault(id, java.util.Collections.emptyList())) { int left = pending.get(successor) - 1; pending.put(successor, left); if (left == 0) ready.add(successor); }
        }
        NativePolicy.require(ordered.size() == mutations.size()); return ordered;
    }
    private long bodyTimestamp(JSONObject value, JSONObject draft) throws Exception {
        if (value.has("updatedAt")) return OutboxPolicy.integer(value.opt("updatedAt"), 0, OutboxPolicy.SAFE - 1);
        if (draft != null && draft.has("createdAt")) return OutboxPolicy.expiry(OutboxPolicy.text(draft.opt("createdAt"), 1000));
        throw new UnsupportedBody();
    }
    private JSONArray readableBody(List<Row> rows, String profile, String page) throws Exception {
        JSONObject chosen = null, snapshot = null; long latest = -1, snapshotTime = -1; List<JSONObject> pending = new ArrayList<>(), snapshots = new ArrayList<>(), tiedDrafts = new ArrayList<>();
        String requiredEpoch = null;
        try {
            for (Row row : rows) if (row.profile.equals(profile) && row.resource != null && resourceID(row.resource).equals(page)) {
                JSONObject value = row.value();
                if (row.bucket.equals("operations")) pending.add(value.getJSONObject("operation"));
                if (row.bucket.equals("snapshots")) snapshots.add(value);
                if (row.bucket.equals("mutations") && "page.create".equals(value.getJSONObject("operation").opt("kind"))) {
                    String epoch = OutboxPolicy.text(value.getJSONObject("operation").opt("document_epoch"), 1000);
                    if (requiredEpoch != null && !requiredEpoch.equals(epoch)) throw new UnsupportedBody(); requiredEpoch = epoch;
                }
                if (row.bucket.equals("drafts") && !value.getJSONObject("draft").optString("reason").equals("basis")) {
                    JSONObject candidate = value.getJSONObject("draft"); if (!"pending".equals(candidate.opt("reason")) || candidate.optJSONArray("blocks") == null) throw new UnsupportedBody();
                    OutboxPolicy.text(candidate.opt("epoch"), 1000); long stamp = bodyTimestamp(value, candidate);
                    if (chosen == null || stamp > latest) { chosen = candidate; latest = stamp; tiedDrafts.clear(); tiedDrafts.add(candidate); }
                    else if (stamp == latest) {
                        if (!chosen.getString("epoch").equals(candidate.getString("epoch")) || !host.canonical(chosen.getJSONArray("blocks"), false).equals(host.canonical(candidate.getJSONArray("blocks"), false))) throw new UnsupportedBody();
                        tiedDrafts.add(candidate);
                    }
                }
            }
            if (chosen != null) { String epoch = chosen.getString("epoch"); if (requiredEpoch != null && !requiredEpoch.equals(epoch)) throw new UnsupportedBody(); requiredEpoch = epoch; }
            if (requiredEpoch == null && !pending.isEmpty()) requiredEpoch = OutboxPolicy.text(pending.get(0).opt("_epoch"), 1000);
            // Select one latest matching-epoch baseline BEFORE consulting seen.
            // Never union old versions, other epochs, or ambiguous equal-time states.
            for (JSONObject value : snapshots) {
                JSONObject candidate = value.getJSONObject("snapshot"); String epoch = OutboxPolicy.text(candidate.opt("epoch"), 1000);
                if (requiredEpoch != null && !requiredEpoch.equals(epoch)) continue;
                long stamp = value.has("updatedAt") ? bodyTimestamp(value, null) : 0;
                if (snapshot == null || stamp > snapshotTime) { snapshot = candidate; snapshotTime = stamp; }
                else if (stamp == snapshotTime && !host.canonical(snapshot, false).equals(host.canonical(candidate, false))) throw new UnsupportedBody();
            }
            if (requiredEpoch == null && snapshot != null) requiredEpoch = snapshot.getString("epoch");
            JSONObject seen = snapshot == null ? new JSONObject() : snapshot.getJSONObject("state").getJSONObject("seen");
            Iterator<String> seenIDs = seen.keys(); while (seenIDs.hasNext()) { Object value = seen.get(seenIDs.next()); if (value != Boolean.TRUE && (!(value instanceof String) || !((String) value).matches("[0-9a-f]{64}"))) throw new UnsupportedBody(); }
            if (tiedDrafts.isEmpty()) tiedDrafts.add(null);
            for (JSONObject candidate : tiedDrafts) {
                Map<String, String> covered = new HashMap<>(); JSONArray declared = candidate == null ? null : candidate.optJSONArray("ops");
                if (candidate != null && candidate.has("ops") && declared == null) throw new UnsupportedBody();
                if (declared != null) for (int i = 0; i < declared.length(); i++) { JSONObject op = new JSONObject(declared.getJSONObject(i).toString()); String id = op.getString("id"); if (op.has("_epoch") && !requiredEpoch.equals(op.opt("_epoch"))) throw new UnsupportedBody(); op.remove("_epoch"); if (covered.put(id, host.canonical(op, false)) != null) throw new UnsupportedBody(); }
                for (JSONObject operation : pending) {
                    if (requiredEpoch == null || !requiredEpoch.equals(operation.opt("_epoch"))) throw new UnsupportedBody();
                    if (seen.has(operation.getString("id"))) continue;
                    JSONObject clean = new JSONObject(operation.toString()); clean.remove("_epoch");
                    if (!host.canonical(clean, false).equals(covered.get(operation.getString("id")))) throw new UnsupportedBody();
                }
            }
            if (chosen != null) return chosen.getJSONArray("blocks");
            if (snapshot == null) throw new UnsupportedBody(); return snapshot.getJSONArray("blocks");
        } catch (UnsupportedBody unsupported) { throw unsupported; }
        catch (org.json.JSONException | IllegalArgumentException malformed) { throw new UnsupportedBody(); }
    }
    private String bodyText(Object value) throws Exception {
        try { return NativeRecovery.content(value, 200000); }
        catch (Exception malformed) { throw new UnsupportedBody(); }
    }
    private JSONArray bodyTokens(JSONObject block) throws Exception {
        if (block.has("rich_text") && block.optJSONArray("rich_text") == null) throw new UnsupportedBody();
        JSONArray tokens = block.optJSONArray("rich_text");
        return tokens == null ? new JSONArray().put(new JSONObject().put("text", block.has("text") ? bodyText(block.get("text")) : "").put("marks", new JSONObject())) : tokens;
    }
    private long bodyPoints(JSONArray blocks) throws Exception {
        try {
        Set<String> ids = new HashSet<>(); Map<String,String> parents = new HashMap<>();
        for (int i=0;i<blocks.length();i++) {
            JSONObject block=blocks.getJSONObject(i);String id=OutboxPolicy.text(block.opt("id"),160);if(!ids.add(id)||!Arrays.asList("paragraph","heading1","heading2","heading3","bullet","numbered","todo","quote","code","callout","divider","toggle","image","bookmark","file").contains(block.opt("type")))throw new UnsupportedBody();
            parents.put(id,block.isNull("parent_id")?null:OutboxPolicy.text(block.opt("parent_id"),160));
            if(block.has("checked")&&!(block.opt("checked") instanceof Boolean))throw new UnsupportedBody();
            if(block.has("language"))NativeRecovery.content(block.opt("language"),1000);
            if(block.has("attachment_id")&&!block.isNull("attachment_id"))OutboxPolicy.text(block.opt("attachment_id"),160);
            if(block.has("size"))OutboxPolicy.integer(block.opt("size"),0,5_000_000_000L);
        }
        for(String id:ids){Set<String> chain=new HashSet<>();String node=id;while(node!=null){if(!ids.contains(node)||!chain.add(node))throw new UnsupportedBody();node=parents.get(node);}}
        if (blocks.length() > 2000) throw new UnsupportedBody(); long points = 0;
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.getJSONObject(i); JSONArray tokens = bodyTokens(block); StringBuilder joined = new StringBuilder();
            for (int j = 0; j < tokens.length(); j++) { JSONObject token = tokens.getJSONObject(j); String text = bodyText(token.opt("text")); JSONObject marks = token.has("marks") ? token.getJSONObject("marks") : new JSONObject(); validateMarks(marks);
                long count = text.codePointCount(0, text.length()); points += count * (1L + marks.length()); if (points > 50000) throw new UnsupportedBody(); joined.append(text);
            }
            if (block.has("text") && !bodyText(block.get("text")).equals(joined.toString())) throw new UnsupportedBody();
        }
        return points;
        } catch (UnsupportedBody unsupported) { throw unsupported; }
        catch (Exception malformed) { throw new UnsupportedBody(); }
    }
    private void importBody(JSONObject p, String resource, String epoch, JSONArray original, JSONObject counts) throws Exception {
        NativePolicy.require(original.length() <= 2000); String client = "recovery_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> ids = new HashMap<>(), previous = new HashMap<>(); JSONArray blocks = new JSONArray(), operations = new JSONArray(); long clock = 0;
        for (int i = 0; i < original.length(); i++) NativePolicy.require(ids.put(original.getJSONObject(i).getString("id"), UUID.randomUUID().toString()) == null);
        for (int i = 0; i < original.length(); i++) {
            JSONObject old = original.getJSONObject(i), block = new JSONObject(); String id = ids.get(old.getString("id")), parent = old.isNull("parent_id") ? null : ids.get(old.getString("parent_id"));
            String type = old.getString("type"); NativePolicy.require(Arrays.asList("paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "code", "callout", "divider", "toggle", "image", "bookmark", "file").contains(type));
            block.put("id", id).put("type", type).put("parent_id", parent == null ? JSONObject.NULL : parent);
            JSONObject insert = bodyOperation(client, ++clock, epoch, "block.insert", id).put("block_type", type).put("parent_id", parent == null ? JSONObject.NULL : parent).put("after_id", previous.containsKey(parent) ? previous.get(parent) : JSONObject.NULL); operations.put(insert); previous.put(parent, id);
            for (String field : Arrays.asList("checked", "language", "attachment_id", "size")) if (old.has(field)) {
                if (field.equals("attachment_id") && !old.isNull(field) && response(p, "attachment", old.getString(field)) == null) throw new Failure("OUTBOX_ACCESS_REQUIRED");
                block.put(field, old.get(field)); operations.put(bodyOperation(client, ++clock, epoch, "block.set", id).put("field", field).put("value", old.get(field)));
            }
            JSONArray tokens = bodyTokens(old);
            StringBuilder text = new StringBuilder(); String after = null; JSONArray safeTokens = new JSONArray();
            for (int j = 0; j < tokens.length(); j++) {
                JSONObject token = tokens.getJSONObject(j); String content = bodyText(token.opt("text"));
                NativePolicy.require(content.codePointCount(0, content.length()) <= 100000); JSONObject marks = token.optJSONObject("marks"); if (marks == null) marks = new JSONObject(); validateMarks(marks);
                text.append(content); NativePolicy.require(text.codePointCount(0, text.length()) <= 100000);
                if (!content.isEmpty()) { JSONObject op = bodyOperation(client, ++clock, epoch, "text.insert", id).put("after_id", after == null ? JSONObject.NULL : after).put("text", content).put("marks", marks); operations.put(op); after = op.getString("id") + ":" + (content.codePointCount(0, content.length()) - 1); safeTokens.put(new JSONObject().put("text", content).put("marks", marks)); }
            }
            block.put("text", text.toString()).put("rich_text", safeTokens); blocks.put(block);
        }
        long now = System.currentTimeMillis(); String profile = p.getString("profile"), draftClient = UUID.randomUUID().toString();
        for (int i = 0; i < operations.length(); i++) { JSONObject operation = operations.getJSONObject(i); output(p, "operations", new JSONArray().put(resource).put(operation.getString("id")), resource, new JSONObject().put("key", resource).put("profileId", profile).put("id", operation.getString("id")).put("operation", operation).put("createdAt", now)); increment(counts, "import"); }
        JSONArray clean = new JSONArray(); for (int i = 0; i < operations.length(); i++) { JSONObject op = new JSONObject(operations.getJSONObject(i).toString()); op.remove("_epoch"); clean.put(op); }
        java.text.SimpleDateFormat timestamp = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.ROOT); timestamp.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        JSONObject draft = new JSONObject().put("epoch", epoch).put("ops", clean).put("blocks", blocks).put("reason", "pending").put("createdAt", timestamp.format(new java.util.Date(now)));
        output(p, "drafts", new JSONArray().put(resource).put(draftClient), resource, new JSONObject().put("key", resource).put("profileId", profile).put("clientId", draftClient).put("draft", draft).put("updatedAt", now)); increment(counts, "import");
    }
    private JSONObject bodyOperation(String client, long clock, String epoch, String type, String block) throws Exception { return new JSONObject().put("id", client + ":" + clock).put("client", client).put("clock", clock).put("type", type).put("block_id", block).put("group_id", "imported_body").put("_epoch", epoch); }
    private void validateMarks(JSONObject marks) throws Exception {
        try { NativeRecovery.marks(marks); } catch (Exception unsafe) { throw new UnsupportedBody(); }
    }
}
