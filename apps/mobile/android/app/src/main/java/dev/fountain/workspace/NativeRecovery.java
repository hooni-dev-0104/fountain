package dev.fountain.workspace;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import com.getcapacitor.JSObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Explicit read-only recovery. No NativeOutbox constructor/grant/purge is used. */
final class NativeRecovery implements AutoCloseable {
    static final int FILE_LIMIT = 16 * 1024 * 1024, TOTAL_LIMIT = 64 * 1024 * 1024;
    static final long INVENTORY_TTL = 300000, AUTHORITY_TTL = 120000;
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super("Native recovery could not complete this action"); this.code = code; }
    }
    interface Authority { JSONObject get(String path) throws Exception; void check() throws Exception; }
    static final class Session {
        final String origin, workspace, member, binding, scope, role;
        long validUntil;
        Session(String origin, JSONObject body, String cookie, String ownerScope) throws Exception {
            if (body.opt("authenticated") != Boolean.TRUE || body.getJSONObject("member").opt("active") != Boolean.TRUE) throw new Failure("RECOVERY_AUTH_REQUIRED");
            if(!Arrays.asList("owner","admin","member","guest").contains(body.getJSONObject("member").opt("role")))throw new Failure("RECOVERY_AUTH_REQUIRED");
            role = body.getJSONObject("member").getString("role");
            this.origin = origin; workspace = text(body.opt("workspace_id")); member = text(body.getJSONObject("member").opt("id")); binding = text(body.opt("cache_binding"));
            String mode = text(body.opt("mode")); long now = System.currentTimeMillis();
            if (mode.equals("local") && body.opt("required") == Boolean.FALSE && cookie == null) validUntil = now + OutboxPolicy.LOCAL_TTL;
            else if ((mode.equals("accounts") || mode.equals("family")) && cookie != null) validUntil = OutboxPolicy.expiry(text(body.opt("expires_at")));
            else throw new Failure("RECOVERY_AUTH_REQUIRED");
            if (validUntil <= now) throw new Failure("RECOVERY_AUTH_REQUIRED");
            scope = ownerScope + ":" + OutboxPolicy.hash(origin + "|" + workspace + "|" + member + "|" + binding + "|" + body.getJSONObject("member").getString("role") + "|" + (cookie == null ? "local" : OutboxPolicy.hash(cookie)));
        }
    }
    private static final class Row {
        final long id; final String profile, resource, bucket, key, sha, rawSha, storage; final int size;final long metadataBytes;
        Row(long id, String profile, String resource, String bucket, String key, String sha, String rawSha, String storage, int size) { this.storage=storage;this.rawSha=rawSha;this.id=id;this.profile=profile;this.resource=resource;this.bucket=bucket;this.key=key;this.sha=sha;this.size=size;metadataBytes=256L+profile.getBytes(StandardCharsets.UTF_8).length+resource.getBytes(StandardCharsets.UTF_8).length+bucket.getBytes(StandardCharsets.UTF_8).length+key.getBytes(StandardCharsets.UTF_8).length; }
    }
    private static final class Item {
        final String handle=UUID.randomUUID().toString(), profile, resource, category;
        final List<Row> rows=new ArrayList<>(); long bytes; boolean readableOnly;
        Item(String profile,String resource,String category) { this.profile=profile;this.resource=resource;this.category=category; }
    }
    static final class Prepared {
        final String token=UUID.randomUUID().toString(), inventory, selection, scope, fingerprint;
        final long deadline, authorityVersion; final List<File> files=new ArrayList<>(); final List<String> formats=new ArrayList<>();
        final int ready, blocked; final JSONArray warnings;
        long written;
        Prepared(String inventory,String selection,String scope,String fingerprint,long deadline,long version,int ready,int blocked,JSONArray warnings) {
            this.inventory=inventory;this.selection=selection;this.scope=scope;this.fingerprint=fingerprint;this.deadline=deadline;authorityVersion=version;this.ready=ready;this.blocked=blocked;this.warnings=warnings;
        }
        void delete() { for(File file:files) file.delete(); files.clear();written=0; }
    }
    private final Context context;
    private volatile Session session;
    private SQLiteDatabase database;
    private File source;
    private volatile String inventoryToken, fingerprint;
    private long inventoryUntil, maxAccess, maxData;
    private volatile long authorityVersion;
    private final Map<String,Item> items=new LinkedHashMap<>();
    private final Map<String,Item> groupsByKey=new HashMap<>();
    private final Map<String,Long> cursors=new HashMap<>();
    private final Map<String,JSONObject> proofs=new HashMap<>();
    private final Set<String> denied=new HashSet<>();
    private final Set<String> attachments=new HashSet<>();
    private volatile Prepared prepared;
    private int indexedRows;
    private long indexedBytes;
    private boolean archiveTable;
    private boolean ownersTable, localVersionsTable;
    private final Map<String,Long> localChecks = new HashMap<>();
    private long localChecksVersion = -1;

    NativeRecovery(Context context) { this.context=context; }
    private static String text(Object value) { return OutboxPolicy.text(value,1000); }
    private static String id(Object value) {String result=OutboxPolicy.text(value,160);NativePolicy.require(!result.equals(".")&&!result.equals("..")&&!result.contains("/")&&!result.contains("\\"));return result;}
    static void jsonSafe(Object value) throws Exception { jsonSafe(value, 0); }
    private static void jsonSafe(Object value, int depth) throws Exception {
        if (depth > 32) throw new Failure("RECOVERY_ACCESS_REQUIRED");
        if(value instanceof String){String text=(String)value;for(int i=0;i<text.length();i++){char point=text.charAt(i);if(Character.isHighSurrogate(point)){if(++i>=text.length()||!Character.isLowSurrogate(text.charAt(i)))throw new Failure("RECOVERY_ACCESS_REQUIRED");}else if(Character.isLowSurrogate(point))throw new Failure("RECOVERY_ACCESS_REQUIRED");}}
        else if(value instanceof JSONObject){JSONObject object=(JSONObject)value;Iterator<String> names=object.keys();while(names.hasNext()){String name=names.next();if(Arrays.asList("__proto__","constructor","prototype").contains(name))throw new Failure("RECOVERY_ACCESS_REQUIRED");jsonSafe(name,depth+1);jsonSafe(object.get(name),depth+1);}}
        else if(value instanceof JSONArray){JSONArray array=(JSONArray)value;for(int i=0;i<array.length();i++)jsonSafe(array.get(i),depth+1);}
    }
    private static JSONObject exportValue(JSONObject value) throws Exception {jsonSafe(value);return value;}
    static String content(Object value,int maximum)throws Exception {if(!(value instanceof String)||((String)value).length()>maximum)throw new Failure("RECOVERY_ACCESS_REQUIRED");jsonSafe(value);return (String)value;}
    private static long number(JSONObject value,String field) throws Exception { return OutboxPolicy.integer(value.opt(field),0,OutboxPolicy.SAFE-1); }
    private static boolean flag(JSONObject value,String field) { NativePolicy.require(value.opt(field) instanceof Boolean); return value.opt(field)==Boolean.TRUE; }
    private void current(Authority authority) throws Exception {
        authority.check();Session current=session;if(current==null||System.currentTimeMillis()>=current.validUntil) throw new Failure("RECOVERY_AUTH_REQUIRED");
    }
    void refresh(Session next) throws Exception {
        if(session!=null&&!session.scope.equals(next.scope)) { close(); }
        else if(session!=null){
            if(next.validUntil<session.validUntil){if(prepared!=null){prepared.delete();prepared=null;}inventoryUntil=Math.min(inventoryUntil,next.validUntil);authorityVersion++;}
            else if(session.validUntil>System.currentTimeMillis())next.validUntil=Math.min(next.validUntil,session.validUntil);
        }
        session=next;
    }
    void invalidate() { close(); session=null; }
    boolean qualifiesOutbox(String origin, JSONObject grant, String cookie, String ownerScope) throws Exception {
        Session current=session;
        if(current==null||System.currentTimeMillis()>=current.validUntil||!current.origin.equals(origin)
            ||!OutboxPolicy.profile(origin,current.workspace,current.member,current.binding).equals(grant.getString("profileId")))return false;
        JSONObject description=grant.getJSONObject("session");
        String expected=ownerScope+":"+OutboxPolicy.hash(origin+"|"+current.workspace+"|"+current.member+"|"+current.binding+"|"+description.getJSONObject("member").getString("role")+"|"+(cookie==null?"local":OutboxPolicy.hash(cookie)));
        return expected.equals(current.scope);
    }
    void cancel(String inventory,String export) throws Exception {
        if(export!=null) { if(prepared!=null&&prepared.token.equals(export)&&prepared.inventory.equals(inventory)) { prepared.delete();prepared=null; } return; }
        if(inventoryToken!=null&&!inventoryToken.equals(inventory)) throw new Failure("RECOVERY_STALE");
        closeReaderCaps();
    }
    private static void protectedFile(File file,boolean directory) throws Exception {
        StructStat info=Os.lstat(file.getPath());
        if(info.st_uid!=android.os.Process.myUid() || (info.st_mode&0777)!=(directory?0700:0600)
            || !(directory?OsConstants.S_ISDIR(info.st_mode):OsConstants.S_ISREG(info.st_mode))) throw new Failure("RECOVERY_STORAGE");
    }
    private void reader(Authority authority) throws Exception {
        current(authority); if(database!=null) return;
        File root=context.getNoBackupFilesDir().getCanonicalFile(), directory=new File(root,"durable_outbox");
        if(!directory.exists()) return;
        protectedFile(directory,true);
        File file=new File(directory,OutboxPolicy.hash(session.origin)+".sqlite");
        if(!file.exists()) return;
        if(!file.getCanonicalFile().equals(file.getAbsoluteFile())) throw new Failure("RECOVERY_STORAGE");
        protectedFile(file,false);
        SQLiteDatabase opened=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        try {
            if(!opened.isReadOnly()) throw new Failure("RECOVERY_STORAGE");
            opened.execSQL("PRAGMA query_only=ON");
            try(Cursor check=opened.rawQuery("PRAGMA query_only",null)) { if(!check.moveToFirst()||check.getInt(0)!=1) throw new Failure("RECOVERY_STORAGE"); }
            try(Cursor schema=opened.rawQuery("SELECT mode,bucket,key,profile_id,resource_key,length(payload),rowid FROM records LIMIT 0",null)) { schema.moveToFirst(); }
            try(Cursor journal=opened.rawQuery("PRAGMA journal_mode",null)) { if(!journal.moveToFirst()||!"delete".equalsIgnoreCase(journal.getString(0)))throw new Failure("RECOVERY_STORAGE"); }
            source=file;database=opened;
            try(Cursor schema=database.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_recovery_records'",null)){archiveTable=schema.moveToFirst();}
            if(archiveTable){Set<String> columns=new HashSet<>();try(Cursor schema=database.rawQuery("PRAGMA table_info(native_recovery_records)",null)){while(schema.moveToNext())columns.add(schema.getString(1));}archiveTable=columns.containsAll(Arrays.asList("id","version","profile_id","resource_key","bucket","key","digest","actor","trust"));}
            try(Cursor schema=database.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_record_owners'",null)){ownersTable=schema.moveToFirst();}
            try(Cursor schema=database.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_local_versions_v1'",null)){localVersionsTable=schema.moveToFirst();}
        } catch(Exception error) { opened.close();throw error; }
    }
    private String fingerprint(Authority authority) throws Exception {
        current(authority); if(source==null) return "absent";
        protectedFile(source,false); MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream input=new FileInputStream(source)) { byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1) { current(authority);digest.update(buffer,0,count); } }
        StringBuilder sha=new StringBuilder();for(byte value:digest.digest()) sha.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
        String head="";try(Cursor cursor=database.rawQuery("SELECT value FROM control WHERE key='head'",null)) { if(cursor.moveToFirst()) head=cursor.getString(0); }
        StructStat info=Os.lstat(source.getPath());return info.st_dev+":"+info.st_ino+":"+source.length()+":"+source.lastModified()+":"+head+":"+sha;
    }
    private void unchanged(Authority authority) throws Exception {
        current(authority);if(inventoryToken==null||System.currentTimeMillis()>=inventoryUntil||!fingerprint.equals(fingerprint(authority))) throw new Failure("RECOVERY_STALE");
    }
    private JSONObject read(long row,int size,Authority authority) throws Exception {
        if(size<=0||size>FILE_LIMIT) throw new Failure("RECOVERY_ACCESS_REQUIRED");
        ByteArrayOutputStream bytes=new ByteArrayOutputStream(size);
        for(int offset=0;offset<size;offset+=OutboxPolicy.PART) {
            current(authority);int count=Math.min(OutboxPolicy.PART,size-offset);
            try(Cursor chunk=database.rawQuery("SELECT substr(payload,?,?) FROM "+(row<0?"recovery":"records")+" WHERE rowid=?",new String[]{Integer.toString(offset+1),Integer.toString(count),Long.toString(row<0?-row:row)})) {
                if(!chunk.moveToFirst()||chunk.getBlob(0).length!=count) throw new Failure("RECOVERY_STALE");bytes.write(chunk.getBlob(0));
            }
        }
        String raw=OutboxPolicy.utf8(bytes.toByteArray());bounded(raw);return new JSONObject(raw);
    }
    private String payloadHash(long row,int size,Authority authority)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        for(int offset=0;offset<size;offset+=OutboxPolicy.PART){current(authority);int count=Math.min(OutboxPolicy.PART,size-offset);
            try(Cursor part=database.rawQuery("SELECT substr(payload,?,?) FROM "+(row<0?"recovery":"records")+" WHERE rowid=?",new String[]{Integer.toString(offset+1),Integer.toString(count),Long.toString(row<0?-row:row)})){
                if(!part.moveToFirst()||part.getBlob(0).length!=count)throw new Failure("RECOVERY_STALE");digest.update(part.getBlob(0));
            }
        }
        StringBuilder result=new StringBuilder();for(byte value:digest.digest())result.append(String.format(java.util.Locale.ROOT,"%02x",value&255));return result.toString();
    }
    private boolean sourceIdentity(JSONObject value,String profile,String resource,String bucket,String encodedKey) throws Exception {
        if(!profile.equals(value.opt("profileId"))) return false;
        Object key=encodedKey.startsWith("[")?new JSONArray(encodedKey):new JSONArray("["+encodedKey+"]").get(0);
        if(Arrays.asList("mutations","operations","drafts").contains(bucket)) {
            if(!(key instanceof JSONArray))return false;JSONArray parts=(JSONArray)key;if(parts.length()!=2)return false;
            if(!(bucket.equals("mutations")?profile:resource).equals(parts.opt(0))||!Objects.equals(value.opt(bucket.equals("drafts")?"clientId":"id"),parts.opt(1)))return false;
        }else if(!resource.equals(key))return false;
        if(bucket.equals("mutations")) return resource.equals(value.opt("resourceKey"))&&value.optJSONObject("operation")!=null&&Objects.equals(value.opt("id"),value.getJSONObject("operation").opt("id"));
        if(bucket.equals("operations")&&(!value.has("operation")||!Objects.equals(value.opt("id"),value.getJSONObject("operation").opt("id"))))return false;
        return resource.equals(value.opt("key"))&&(!value.has("resourceKey")||resource.equals(value.opt("resourceKey")));
    }
    private List<Row> rows(Item item,Authority authority) throws Exception {
        List<Row> result=new ArrayList<>();long metadataBytes=0;
        String buckets=item.category.equals("typed")?"'mutations'":item.category.equals("local_page")?"'localPages'":"'snapshots','operations','drafts','databaseSnapshots','transfers'";
        String actor=session.origin+"|"+OutboxPolicy.encode(session.workspace)+"|"+OutboxPolicy.encode(session.member)+"|";
        if(ownersTable)try(Cursor cursor=database.rawQuery("SELECT r.rowid,r.bucket,length(r.payload),r.key,n.digest,r.mode FROM records r JOIN native_record_owners n ON n.mode=r.mode AND n.bucket=r.bucket AND n.key=r.key AND n.profile_id=r.profile_id WHERE r.profile_id=? AND r.resource_key=? AND r.mode IN ('active','quarantine') AND r.bucket IN ("+buckets+") AND n.actor=? AND n.trust IN ('native','untrusted') ORDER BY r.rowid",new String[]{item.profile,item.resource,actor})) {
            while(cursor.moveToNext()) {
                current(authority); if(result.size()>=100000) throw new Failure("RECOVERY_STORAGE");
                long id=cursor.getLong(0);String bucket=cursor.getString(1);int size=cursor.getInt(2);
                if(size<=0||size>FILE_LIMIT) continue;
                String key=cursor.getString(3),digest=cursor.getString(4);if(!payloadHash(id,size,authority).equals(digest))continue;
                String sha;try { JSONObject value=read(id,size,authority);sha=sourceIdentity(value,item.profile,item.resource,bucket,key)?OutboxPolicy.hash(value.toString()):"blocked:"+digest; }
                catch(org.json.JSONException|IllegalArgumentException invalid) { sha="blocked:"+digest; }
                catch(Failure unsupported){if(!"RECOVERY_ACCESS_REQUIRED".equals(unsupported.code))throw unsupported;sha="blocked:"+digest;}
                Row row=new Row(id,item.profile,item.resource,bucket,key,sha,digest,cursor.getString(5),size);metadataBytes+=row.metadataBytes;
                if(indexedBytes+metadataBytes>FILE_LIMIT)throw new Failure("RECOVERY_LIMIT");result.add(row);
            }
        }
        if(archiveTable){
            Set<String> copies=new HashSet<>();for(Row row:result)copies.add(row.bucket+"\n"+row.key+"\n"+row.sha+"\n"+(rowLocalContext(row,authority)!=null));
            try(Cursor cursor=database.rawQuery("SELECT r.rowid,a.bucket,length(r.payload),a.key,a.digest,a.version,a.id FROM native_recovery_records a JOIN recovery r ON r.id=a.id WHERE a.profile_id=? AND a.resource_key=? AND a.bucket IN ("+buckets+") AND a.actor=? AND a.trust IN ('native','untrusted') ORDER BY r.rowid",new String[]{item.profile,item.resource,actor})){
                while(cursor.moveToNext()){
                    current(authority);if(result.size()>=100000)throw new Failure("RECOVERY_STORAGE");
                    long id=-cursor.getLong(0);String bucket=cursor.getString(1),key=cursor.getString(3),digest=cursor.getString(4);int size=cursor.getInt(2);
                    if(cursor.getInt(5)!=1||size<=0||size>FILE_LIMIT||!digest.matches("[0-9a-f]{64}"))throw new Failure("RECOVERY_ACCESS_REQUIRED");
                    try(Cursor owner=database.rawQuery("SELECT value FROM control WHERE key=?",new String[]{"recovery-owner:"+cursor.getString(6)})){if(!owner.moveToFirst()||!item.profile.equals(owner.getString(0)))throw new Failure("RECOVERY_ACCESS_REQUIRED");}
                    if(!payloadHash(id,size,authority).equals(digest))throw new Failure("RECOVERY_STALE");
                    String sha;
                    try{JSONObject value=read(id,size,authority);sha=OutboxPolicy.hash(value.toString());if(!sourceIdentity(value,item.profile,item.resource,bucket,key))sha="blocked:"+digest;}
                    catch(org.json.JSONException|IllegalArgumentException invalid){sha="blocked:"+digest;}
                    catch(Failure invalid){if(!invalid.code.equals("RECOVERY_ACCESS_REQUIRED"))throw invalid;sha="blocked:"+digest;}
                    Row row=new Row(id,item.profile,item.resource,bucket,key,sha,digest,"archive:"+cursor.getString(6),size);
                    if(!copies.add(bucket+"\n"+key+"\n"+sha+"\n"+(rowLocalContext(row,authority)!=null)))continue;
                    metadataBytes+=row.metadataBytes;if(indexedBytes+metadataBytes>FILE_LIMIT)throw new Failure("RECOVERY_LIMIT");result.add(row);
                }
            }
        }
        return result;
    }
    JSObject inventory(String cursor,int limit,long generation,Authority authority) throws Exception {
        current(authority);
        if(cursor==null) {
            closeInventory();if(database!=null)database.close();database=null;source=null;reader(authority);
            inventoryToken=UUID.randomUUID().toString();inventoryUntil=Math.min(session.validUntil,System.currentTimeMillis()+INVENTORY_TTL);fingerprint=fingerprint(authority);
        } else {reader(authority);unchanged(authority);}
        long after=0;if(cursor!=null) { Long value=cursors.get(cursor);if(value==null)throw new Failure("RECOVERY_STALE");after=value; }
        JSONArray output=new JSONArray();String next=null;
        if(database!=null) {
            String prefix=session.origin+"|"+OutboxPolicy.encode(session.workspace)+"|"+OutboxPolicy.encode(session.member)+"|";
            String sourceRows=ownersTable?"SELECT r.profile_id,r.resource_key,r.bucket,r.rowid*2 AS position,n.actor,n.trust FROM records r JOIN native_record_owners n ON n.mode=r.mode AND n.bucket=r.bucket AND n.key=r.key AND n.profile_id=r.profile_id WHERE r.mode IN ('active','quarantine') AND r.bucket IN ('mutations','localPages','snapshots','operations','drafts','databaseSnapshots','transfers')":"SELECT profile_id,resource_key,bucket,rowid*2 AS position,'' AS actor,'opaque' AS trust FROM records WHERE 0";
            if(archiveTable)sourceRows+=" UNION ALL SELECT a.profile_id,a.resource_key,a.bucket,r.rowid*2+1 AS position,a.actor,a.trust FROM native_recovery_records a JOIN recovery r ON r.id=a.id WHERE a.version=1 AND a.bucket IN ('mutations','localPages','snapshots','operations','drafts','databaseSnapshots','transfers')";
            try(Cursor groups=database.rawQuery("SELECT profile_id,resource_key,CASE WHEN bucket='mutations' THEN 'typed' WHEN bucket='localPages' THEN 'local_page' ELSE 'body' END AS category,min(position) FROM ("+sourceRows+") WHERE substr(profile_id,1,?)=? AND actor=? AND trust IN ('native','untrusted') GROUP BY profile_id,resource_key,category HAVING min(position)>CAST(? AS INTEGER) ORDER BY min(position)",new String[]{Integer.toString(prefix.length()),prefix,prefix,Long.toString(after)})) {
                while(groups.moveToNext()) {
                    current(authority);String profile=groups.getString(0),resource=groups.getString(1),category=groups.getString(2);after=groups.getLong(3);
                    if(OutboxPolicy.recoveryProfile(session.origin,profile,session.workspace,session.member)==null||!OutboxPolicy.resource(profile,resource))continue;
                    if(items.size()>=10000) throw new Failure("RECOVERY_STORAGE");
                    String groupKey=profile+"\n"+resource+"\n"+category;Item item=groupsByKey.get(groupKey);
                    if(item==null) { item=new Item(profile,resource,category);item.rows.addAll(rows(item,authority));if(item.rows.isEmpty())continue;
                        indexedRows+=item.rows.size();if(indexedRows>100000)throw new Failure("RECOVERY_STORAGE");for(Row row:item.rows){item.bytes+=row.size;indexedBytes+=row.metadataBytes;}if(indexedBytes>FILE_LIMIT)throw new Failure("RECOVERY_LIMIT");groupsByKey.put(groupKey,item); }
                    items.put(item.handle,item);output.put(new JSONObject().put("handle",item.handle).put("category",category).put("recordCount",item.rows.size()).put("byteLength",item.bytes).put("state","needs_check"));
                    if(output.length()==limit) { next=UUID.randomUUID().toString();cursors.put(next,after);break; }
                }
            }
        }
        unchanged(authority);
        JSObject result=new JSObject();result.put("generation",generation);result.put("inventoryToken",inventoryToken);result.put("items",output);result.put("next",next==null?JSONObject.NULL:next);return result;
    }
    private void closeInventory() {
        if(prepared!=null)prepared.delete();prepared=null;items.clear();groupsByKey.clear();indexedRows=0;indexedBytes=0;cursors.clear();inventoryToken=null;fingerprint=null;
    }
    private void closeReaderCaps(){closeInventory();proofs.clear();attachments.clear();localChecks.clear();authorityVersion++;if(database!=null)database.close();database=null;source=null;}
    @Override public void close() { closeReaderCaps();denied.clear();maxAccess=0;maxData=0; }

    private static String privateControl(SQLiteDatabase db, String key) {
        try (Cursor c = db.rawQuery("SELECT value,length(CAST(value AS BLOB)) FROM control WHERE key=?", new String[]{key})) {
            if (!c.moveToFirst()) return null; NativePolicy.require(c.getInt(1) <= 16384); return c.getString(0);
        }
    }
    private boolean persistObservedPages(Set<String> pages) throws Exception {
        if (pages.isEmpty()) return false;
        File file = source;
        if (file == null) file = new File(new File(context.getNoBackupFilesDir().getCanonicalFile(), "durable_outbox"), OutboxPolicy.hash(session.origin) + ".sqlite");
        if (!file.exists()) return false; // No old cache/context can exist yet.
        protectedFile(file.getParentFile(), true); protectedFile(file, false);
        NativePolicy.require(file.getCanonicalFile().equals(file.getAbsoluteFile()));
        SQLiteDatabase inspection = database; boolean temporary = inspection == null; Set<String> missing = new HashSet<>();
        if (temporary) inspection = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        try { for (String page : pages) if (!"1".equals(privateControl(inspection, NativeOutbox.serverPageKey(session.workspace, page)))) missing.add(page); }
        finally { if (temporary) inspection.close(); }
        if (missing.isEmpty()) return false; // Idempotent observation makes no write.
        closeReaderCaps(); // Preserve the current private Session and recovery latch.
        try (SQLiteDatabase writer = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS)) {
            writer.disableWriteAheadLogging();
            try (Cursor journal = writer.rawQuery("PRAGMA journal_mode=DELETE", null)) { NativePolicy.require(journal.moveToFirst() && "delete".equalsIgnoreCase(journal.getString(0))); }
            writer.execSQL("PRAGMA synchronous=EXTRA");
            writer.beginTransaction(); try {
                boolean changed = false;
                for (String page : missing) { String key = NativeOutbox.serverPageKey(session.workspace, page);
                    if (!"1".equals(privateControl(writer, key))) { writer.execSQL("INSERT OR REPLACE INTO control VALUES(?,?)", new Object[]{key, "1"}); changed = true; }
                }
                if (changed) { long next = Long.parseLong(privateControl(writer, "proof_epoch")) + 1; NativePolicy.require(next < OutboxPolicy.SAFE); writer.execSQL("UPDATE control SET value=? WHERE key='proof_epoch'", new Object[]{Long.toString(next)}); }
                writer.setTransactionSuccessful();
            } finally { writer.endTransaction(); }
        }
        return true;
    }
    private JSONObject rowLocalContext(Row row, Authority authority) throws Exception {
        current(authority); if (!localVersionsTable || database == null) return null;
        String actor = session.origin + "|" + OutboxPolicy.encode(session.workspace) + "|" + OutboxPolicy.encode(session.member) + "|";
        try (Cursor c = database.rawQuery("SELECT actor,context FROM native_local_versions_v1 WHERE mode=? AND profile_id=? AND bucket=? AND key=? AND digest=?", new String[]{row.storage, row.profile, row.bucket, row.key, row.rawSha})) {
            if (!c.moveToFirst() || !actor.equals(c.getString(0))) return null;
            String raw = c.getString(1); if (raw.getBytes(StandardCharsets.UTF_8).length > 16384) return null;
            JSONObject context = new JSONObject(raw); String page = text(context.opt("page"));
            if (context.optInt("version") != 1 || !actor.equals(context.opt("actor")) || !row.profile.equals(context.opt("profile"))
                || !row.resource.equals(row.profile + "|" + OutboxPolicy.encode(page)) || OutboxPolicy.recoveryProfile(session.origin, row.profile, session.workspace, session.member) == null
                || !raw.equals(privateControl(database, NativeOutbox.localContextKey(row.profile, page)))
                || "1".equals(privateControl(database, NativeOutbox.serverPageKey(session.workspace, page)))) return null;
            return context;
        }
    }
    private boolean hasLocalVersion(JSONObject context, String bucket, String key, Authority authority) throws Exception {
        String profile = context.getString("profile"), actor = context.getString("actor"), expected = context.toString();
        String query = "SELECT r.rowid,length(r.payload),n.digest,v.context FROM records r JOIN native_record_owners n ON n.mode=r.mode AND n.bucket=r.bucket AND n.key=r.key AND n.profile_id=r.profile_id JOIN native_local_versions_v1 v ON v.mode=n.mode AND v.profile_id=n.profile_id AND v.bucket=n.bucket AND v.key=n.key AND v.digest=n.digest AND v.actor=n.actor WHERE r.profile_id=? AND r.bucket=? AND r.key=? AND n.actor=? AND n.trust='native'";
        try (Cursor c = database.rawQuery(query, new String[]{profile, bucket, key, actor})) {
            while (c.moveToNext()) if (expected.equals(c.getString(3)) && payloadHash(c.getLong(0), c.getInt(1), authority).equals(c.getString(2))) return true;
        }
        if (archiveTable) try (Cursor c = database.rawQuery("SELECT r.rowid,length(r.payload),a.digest,v.context FROM native_recovery_records a JOIN recovery r ON r.id=a.id JOIN native_local_versions_v1 v ON v.mode='archive:'||a.id AND v.profile_id=a.profile_id AND v.bucket=a.bucket AND v.key=a.key AND v.digest=a.digest AND v.actor=a.actor WHERE a.profile_id=? AND a.bucket=? AND a.key=? AND a.actor=? AND a.trust='native' AND a.version=1", new String[]{profile, bucket, key, actor})) {
            while (c.moveToNext()) if (expected.equals(c.getString(3)) && payloadHash(-c.getLong(0), c.getInt(1), authority).equals(c.getString(2))) return true;
        }
        return false;
    }
    private boolean localPermission(Row row, Authority authority) throws Exception {
        JSONObject context = rowLocalContext(row, authority); if (context == null) return false;
        String cacheKey = OutboxPolicy.hash(context.toString());
        if (localChecksVersion != authorityVersion) { localChecks.clear(); localChecksVersion = authorityVersion; }
        Long until = localChecks.get(cacheKey); if (until != null && until > System.currentTimeMillis()) return true;
        Set<String> visited = new HashSet<>(); JSONObject current = context;
        while (true) {
            String profile = text(current.opt("profile")), page = text(current.opt("page")), actor = session.origin + "|" + OutboxPolicy.encode(session.workspace) + "|" + OutboxPolicy.encode(session.member) + "|";
            if (!visited.add(page) || visited.size() > 100000 || current.optInt("version") != 1 || !actor.equals(current.opt("actor"))
                || !row.profile.equals(profile) || !current.toString().equals(privateControl(database, NativeOutbox.localContextKey(profile, page)))
                || "1".equals(privateControl(database, NativeOutbox.serverPageKey(session.workspace, page)))
                || !hasLocalVersion(current, "localPages", JSONObject.quote(profile + "|" + OutboxPolicy.encode(page)), authority)
                || !hasLocalVersion(current, "mutations", new JSONArray().put(profile).put(text(current.opt("creation"))).toString(), authority)) throw new Failure("RECOVERY_ACCESS_REQUIRED");
            String teamspace = text(current.opt("teamspace"));
            if (current.isNull("parent")) {
                if (!Arrays.asList("owner", "admin", "member").contains(session.role)) throw new Failure("RECOVERY_ACCESS_REQUIRED");
                JSONObject workspace = proof("workspace", "workspace", 1, authority);
                if (workspace.getJSONObject("teamspaces").optLong(teamspace) < 3) throw new Failure("RECOVERY_ACCESS_REQUIRED"); break;
            }
            String parent = text(current.opt("parent")), raw = privateControl(database, NativeOutbox.localContextKey(profile, parent));
            if (raw != null && !"1".equals(privateControl(database, NativeOutbox.serverPageKey(session.workspace, parent)))) {
                JSONObject next = new JSONObject(raw); if (!teamspace.equals(next.opt("teamspace"))) throw new Failure("RECOVERY_ACCESS_REQUIRED"); current = next;
            } else {
                JSONObject external = proof("page", parent, 3, authority);
                String parentSpace = external.isNull("teamspace") ? "general" : text(external.opt("teamspace"));
                if (!teamspace.equals(parentSpace)) throw new Failure("RECOVERY_ACCESS_REQUIRED"); break;
            }
        }
        long deadline = Math.min(session.validUntil, System.currentTimeMillis() + AUTHORITY_TTL); for (JSONObject proof : proofs.values()) deadline = Math.min(deadline, proof.getLong("until"));
        if (localChecksVersion != authorityVersion) { localChecks.clear(); localChecksVersion = authorityVersion; } localChecks.put(cacheKey, deadline); return true;
    }
    private void envelope(JSONObject body) throws Exception {
        if(!session.workspace.equals(text(body.opt("workspace_id")))||!session.member.equals(text(body.opt("current_member_id")))||!session.binding.equals(text(body.opt("session_binding"))))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        long access=number(body,"access_revision"),data=number(body,"data_revision");
        if(!OutboxPolicy.freshRevisions(access,data,maxAccess,maxData))throw new Failure("RECOVERY_ACCESS_REQUIRED");
    }
    private static String resource(String kind,String id) { return kind+":"+id; }
    private static String attachmentPath(String method,String path)throws Exception {
        if(!"GET".equals(method)||path==null||path.contains("?")||!path.startsWith("/api/attachments/")||!path.endsWith("/metadata"))return null;
        String encoded=path.substring(17,path.length()-9);if(encoded.isEmpty()||encoded.contains("/"))return null;
        String decoded=java.net.URLDecoder.decode(encoded.replace("+","%2B"),"UTF-8");return OutboxPolicy.encode(decoded).equals(encoded)?id(decoded):null;
    }
    static boolean authorityPath(String method,String path)throws Exception{return OutboxPolicy.canonicalResource(method,path)!=null||attachmentPath(method,path)!=null;}
    void observe(String method,String path,int status,JSONObject body) throws Exception {
        Session current=session;if(current==null)return;if(current.validUntil<=System.currentTimeMillis())throw new Failure("RECOVERY_AUTH_REQUIRED");String[] target=OutboxPolicy.canonicalResource(method,path);if(target==null){String file=attachmentPath(method,path);if(file==null)return;if(status==403||status==404){if(denied.size()>=1000){denied.clear();denied.add("workspace:workspace");}else denied.add("attachment:"+file);attachments.remove(file);authorityVersion++;}else if(status==200&&denied.contains("attachment:"+file))throw new Failure("RECOVERY_ACCESS_REQUIRED");return;}
        String key=resource(target[0],target[1]);
        if(status==403||status==404) { if(denied.size()>=1000){denied.clear();denied.add("workspace:workspace");proofs.clear();}else denied.add(key);proofs.remove(key);authorityVersion++;if(target[0].equals("workspace"))discardPreparedExport();return; }
        if(status!=200)return;
        try {
            envelope(body);long access=number(body,"access_revision"),data=number(body,"data_revision");
            if(denied.contains(key)||denied.contains("workspace:workspace"))throw new Failure("RECOVERY_ACCESS_REQUIRED");
            JSONObject next=new JSONObject().put("kind",target[0]).put("id",target[1]).put("access",access).put("data",data)
                .put("until",Math.min(session.validUntil,System.currentTimeMillis()+AUTHORITY_TTL));
            if(target[0].equals("page")) {
                JSONObject page=body.getJSONObject("page");if(!target[1].equals(text(page.opt("id"))))throw new Failure("RECOVERY_ACCESS_REQUIRED");
                long level=OutboxPolicy.integer(body.opt("access_level"),1,4);if(OutboxPolicy.integer(page.opt("access_level"),1,4)!=level)throw new Failure("RECOVERY_ACCESS_REQUIRED");
                next.put("level",level).put("locked",flag(page,"locked")).put("archived",flag(page,"archived")).put("teamspace",page.isNull("teamspace_id")?JSONObject.NULL:text(page.opt("teamspace_id")));
            }else if(target[0].equals("database")) {
                JSONObject database=body.getJSONObject("database");if(!target[1].equals(text(database.opt("id"))))throw new Failure("RECOVERY_ACCESS_REQUIRED");
                JSONObject rows=new JSONObject(),schema=new JSONObject();JSONArray projected=body.getJSONArray("rows"),properties=database.getJSONArray("properties");
                for(int i=0;i<projected.length();i++){JSONObject row=projected.getJSONObject(i);String id=text(row.opt("id"));if(rows.has(id)||!target[1].equals(text(row.opt("database_id"))))throw new Failure("RECOVERY_ACCESS_REQUIRED");rows.put(id,OutboxPolicy.integer(row.opt("access_level"),1,4));}
                for(int i=0;i<properties.length();i++){JSONObject property=properties.getJSONObject(i);String id=id(property.opt("id"));if(schema.has(id)||!Arrays.asList("title","text","number","select","multi_select","date","checkbox","person","url","email","status","relation","rollup","formula","files","created_time","last_edited_time").contains(property.opt("type")))throw new Failure("RECOVERY_ACCESS_REQUIRED");schema.put(id,property);}
                next.put("level",OutboxPolicy.integer(database.opt("access_level"),1,4)).put("canCreate",flag(database,"can_create_row")).put("rows",rows).put("schema",schema);
            }else {
                JSONObject settings = body.optJSONObject("settings");
                if (body.has("settings") && settings == null || settings != null && settings.has("disable_export") && !(settings.opt("disable_export") instanceof Boolean)) { discardPreparedExport(); throw new Failure("RECOVERY_ACCESS_REQUIRED"); }
                next.put("exportAllowed", settings == null || settings.opt("disable_export") != Boolean.TRUE);
                JSONObject spaces = new JSONObject(); JSONArray list = body.optJSONArray("teamspaces");
                if (list != null) for (int i = 0; i < list.length(); i++) { JSONObject space = list.getJSONObject(i); String id = text(space.opt("id")); NativePolicy.require(!spaces.has(id)); spaces.put(id, OutboxPolicy.integer(space.opt("access_level"), 1, 4)); }
                next.put("level",1).put("teamspaces",spaces);
            }
            Set<String> observed = new HashSet<>();
            if (target[0].equals("page")) observed.add(target[1]);
            if (target[0].equals("workspace")) { JSONArray pages = body.getJSONArray("pages"); NativePolicy.require(pages.length() <= 100000); for (int i = 0; i < pages.length(); i++) observed.add(text(pages.getJSONObject(i).opt("id"))); }
            if (persistObservedPages(observed)) throw new Failure("RECOVERY_STALE");
            JSONObject previous=proofs.get(key);next.put("until",previous!=null&&previous.getLong("until")>System.currentTimeMillis()?Math.min(previous.getLong("until"),next.getLong("until")):next.getLong("until"));
            boolean changed=access>maxAccess||data>maxData||previous==null||!withoutUntil(previous).equals(withoutUntil(next));
            if (target[0].equals("workspace") && (next.opt("exportAllowed") != Boolean.TRUE || previous != null && !Objects.equals(previous.opt("exportAllowed"), next.opt("exportAllowed")))) discardPreparedExport();
            maxAccess=Math.max(maxAccess,access);maxData=Math.max(maxData,data);proofs.put(key,next);if(changed)authorityVersion++;
            long bytes=0;for(JSONObject proof:proofs.values())bytes+=proof.toString().getBytes(StandardCharsets.UTF_8).length;
            if(proofs.size()>1000||bytes>FILE_LIMIT){proofs.clear();authorityVersion++;throw new Failure("RECOVERY_ACCESS_REQUIRED");}
        }catch(Exception invalid){if(invalid instanceof Failure && "RECOVERY_STALE".equals(((Failure)invalid).code))throw invalid;proofs.remove(key);authorityVersion++;Failure rejected=new Failure("RECOVERY_ACCESS_REQUIRED");rejected.initCause(invalid);throw rejected;}
    }
    private void discardPreparedExport() { if (prepared != null) { prepared.delete(); prepared = null; } }
    private void exportPolicy(Authority authority, boolean force) throws Exception {
        current(authority);
        if (force) { JSONObject workspace = authority.get("/api/workspace"); current(authority); observe("GET", "/api/workspace", 200, workspace); }
        JSONObject workspace = proof("workspace", "workspace", 1, authority);
        if (workspace.opt("exportAllowed") != Boolean.TRUE) { discardPreparedExport(); throw new Failure("RECOVERY_ACCESS_REQUIRED"); }
    }
    private static String withoutUntil(JSONObject object) throws Exception {
        TreeSet<String> keys=new TreeSet<>();Iterator<String> names=object.keys();while(names.hasNext()){String key=names.next();if(!key.equals("until"))keys.add(key);}
        StringBuilder value=new StringBuilder();for(String key:keys)value.append(key).append('=').append(object.get(key).toString()).append(';');return value.toString();
    }
    private JSONObject proof(String kind,String id,Authority authority) throws Exception { return proof(kind,id,3,authority); }
    private JSONObject proof(String kind,String id,int needed,Authority authority) throws Exception {
        current(authority);String key=resource(kind,id);JSONObject proof=proofs.get(key);
        if(proof==null||proof.getLong("access")<maxAccess||proof.getLong("data")<maxData||proof.getLong("until")<=System.currentTimeMillis()) {
            String path=kind.equals("workspace")?"/api/workspace":kind.equals("page")?"/api/pages/"+OutboxPolicy.encode(id)+"/collaboration":"/api/databases/"+OutboxPolicy.encode(id);
            JSONObject body=authority.get(path);current(authority);observe("GET",path,200,body);proof=proofs.get(key);
        }
        if(proof==null||proof.getLong("access")<maxAccess||proof.getLong("data")<maxData||proof.getLong("until")<=System.currentTimeMillis()||denied.contains(key)||denied.contains("workspace:workspace")
            ||proof.getLong("level")<needed||needed>=3&&(proof.opt("locked")==Boolean.TRUE||proof.opt("archived")==Boolean.TRUE))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        // Native source tombstones are negative evidence, never a positive grant.
        String profile=OutboxPolicy.profile(session.origin,session.workspace,session.member,session.binding);
        if(database!=null)try(Cursor denied=database.rawQuery("SELECT 1 FROM tombstones WHERE (kind='resource' AND id=?) OR (kind='profile' AND id=?)",new String[]{profile+(kind.equals("database")?"|database|":"|")+OutboxPolicy.encode(id),profile})){if(denied.moveToFirst())throw new Failure("RECOVERY_ACCESS_REQUIRED");}
        return proof;
    }
    private void row(JSONObject db,String id,int level) throws Exception { if(!db.getJSONObject("rows").has(id)||db.getJSONObject("rows").getLong(id)<level)throw new Failure("RECOVERY_ACCESS_REQUIRED"); }
    private long dateValue(Object value)throws Exception {
        String date=content(value,100);
        if(date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))return OutboxPolicy.expiry(date+"T00:00:00Z");
        if(!date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?"))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        if(date.length()==16)date+=":00";if(!date.matches(".*(?:Z|[+-][0-9]{2}:[0-9]{2})$"))date+="Z";return OutboxPolicy.expiry(date);
    }
    private void propertyValue(Object value,String type)throws Exception {
        if(Arrays.asList("formula","rollup").contains(type))throw new Failure("RECOVERY_ACCESS_REQUIRED");if(value==JSONObject.NULL)return;
        if(type.equals("number")){if(!(value instanceof Number)||!Double.isFinite(((Number)value).doubleValue())||Math.abs(((Number)value).doubleValue())>=1e15)throw new Failure("RECOVERY_ACCESS_REQUIRED");return;}
        if(type.equals("checkbox")){if(!(value instanceof Boolean))throw new Failure("RECOVERY_ACCESS_REQUIRED");return;}
        if(type.equals("date")){if(value instanceof String){dateValue(value);return;}if(!(value instanceof JSONObject))throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONObject range=(JSONObject)value;Iterator<String> names=range.keys();while(names.hasNext())if(!Arrays.asList("start","end").contains(names.next()))throw new Failure("RECOVERY_ACCESS_REQUIRED");long start=dateValue(range.opt("start"));if(!range.isNull("end")){String end=content(range.opt("end"),100),first=content(range.opt("start"),100);if((end.length()==10)!=(first.length()==10)||dateValue(end)<start)throw new Failure("RECOVERY_ACCESS_REQUIRED");}return;}
        if(Arrays.asList("multi_select","relation","files").contains(type)){if(!(value instanceof JSONArray)||((JSONArray)value).length()>1000)throw new Failure("RECOVERY_ACCESS_REQUIRED");Set<String> seen=new HashSet<>();JSONArray values=(JSONArray)value;for(int i=0;i<values.length();i++){String item=content(values.get(i),100000);if(type.equals("relation")&&!seen.add(item))throw new Failure("RECOVERY_ACCESS_REQUIRED");}return;}
        if(!Arrays.asList("title","text","select","status","person","url","email","created_time","last_edited_time").contains(type))throw new Failure("RECOVERY_ACCESS_REQUIRED");content(value,100000);
    }
    private void basisReferences(JSONObject db,JSONObject base,Authority authority)throws Exception {
        references(db,base,authority);if(base.has("fields")){JSONObject fields=base.getJSONObject("fields");references(db,fields,authority);}
    }
    private void references(JSONObject db,JSONObject body,Authority authority) throws Exception {
        if(!body.isNull("parent_row_id"))row(db,text(body.opt("parent_row_id")),1);
        if(body.has("depends_on")){JSONArray refs=body.getJSONArray("depends_on");for(int i=0;i<refs.length();i++)row(db,text(refs.get(i)),1);}
        JSONObject values=body.optJSONObject("properties");if(body.has("properties")&&values==null)throw new Failure("RECOVERY_ACCESS_REQUIRED");if(values==null)return;
        JSONObject schema=db.getJSONObject("schema");Iterator<String> supplied=values.keys();while(supplied.hasNext()){String field=supplied.next();if(!schema.has(field))throw new Failure("RECOVERY_ACCESS_REQUIRED");propertyValue(values.get(field),schema.getJSONObject(field).getString("type"));}Iterator<String> names=schema.keys();
        while(names.hasNext()){String field=names.next();JSONObject property=schema.getJSONObject(field);if(!"relation".equals(property.optString("type"))||values.isNull(field))continue;
            JSONArray refs=values.getJSONArray(field);
            for(int i=0;i<refs.length();i++){String id=text(refs.get(i));
                if(property.isNull("database_id")){boolean found=false;
                    JSONObject workspace=authority.get("/api/workspace");current(authority);observe("GET","/api/workspace",200,workspace);
                    JSONArray databases=workspace.getJSONArray("databases");
                    for(int index=0;index<databases.length();index++){JSONObject visible=databases.getJSONObject(index);String candidate=text(visible.opt("id"));JSONObject live=proof("database",candidate,1,authority);
                        if(live.getJSONObject("rows").has(id)){row(live,id,1);found=true;break;}}
                    if(!found)throw new Failure("RECOVERY_ACCESS_REQUIRED");}
                else row(proof("database",text(property.opt("database_id")),1,authority),id,1);
            }
        }
        Iterator<String> files=schema.keys();while(files.hasNext()){String field=files.next();if("files".equals(schema.getJSONObject(field).optString("type"))&&!values.isNull(field)){JSONArray ids=values.getJSONArray(field);for(int i=0;i<ids.length();i++)attachment(id(ids.get(i)),authority);}}
    }
    private JSONObject safeOperation(JSONObject source,Item item,Authority authority) throws Exception {
        String kind=text(source.opt("kind")),target=id(source.opt("target_id"));
        if(!Arrays.asList("page.patch","row.patch","row.delete").contains(kind))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        JSONObject body=source.getJSONObject("body"),copy=new JSONObject().put("id",id(source.opt("id"))).put("kind",kind).put("target_id",target).put("depends_on",source.has("depends_on")?source.getJSONArray("depends_on"):new JSONArray());
        JSONObject output=new JSONObject();
        String encoded=item.resource.substring(item.resource.lastIndexOf('|')+1),id=java.net.URLDecoder.decode(encoded.replace("+","%2B"),"UTF-8");
        if(kind.equals("page.patch")){if(!target.equals(id)||!item.resource.equals(item.profile+"|"+OutboxPolicy.encode(id)))throw new Failure("RECOVERY_ACCESS_REQUIRED");proof("page",id,authority);for(String field:Arrays.asList("title","icon","cover","favorite"))if(body.has(field)){Object value=body.get(field);if(field.equals("favorite"))NativePolicy.require(value instanceof Boolean);else NativePolicy.require(value instanceof String&&((String)value).length()<=(field.equals("title")?500:10000));output.put(field,value);}}
        else {
            if(!id.equals(id(source.opt("database_id")))||!item.resource.equals(item.profile+"|database|"+OutboxPolicy.encode(id)))throw new Failure("RECOVERY_ACCESS_REQUIRED");if(body.has("properties")&&body.optJSONObject("properties")==null)throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONObject db=proof("database",id,authority);row(db,target,3);references(db,body,authority);
            JSONObject base=source.optJSONObject("base");if(base!=null){basisReferences(db,base,authority);
                JSONObject oldSchema=base.optJSONObject("schema");if(oldSchema!=null){Iterator<String> keys=oldSchema.keys();while(keys.hasNext()){String field=keys.next();JSONObject old=oldSchema.getJSONObject(field),now=db.getJSONObject("schema").optJSONObject(field);if(now==null||!Objects.equals(old.opt("type"),now.opt("type"))||!Objects.equals(old.opt("database_id"),now.opt("database_id")))throw new Failure("RECOVERY_ACCESS_REQUIRED");}}}
            if(source.has("base_rows")){JSONObject bases=source.getJSONObject("base_rows"),safe=new JSONObject();Iterator<String> ids=bases.keys();while(ids.hasNext()){String rowID=id(ids.next());row(db,rowID,3);JSONObject original=bases.getJSONObject(rowID),entry=new JSONObject();basisReferences(db,original,authority);if(original.has("updated_at")){String updated=text(original.opt("updated_at"));OutboxPolicy.expiry(updated);entry.put("updated_at",updated);}if(!original.isNull("after_operation"))entry.put("after_operation",id(original.opt("after_operation")));safe.put(rowID,entry);}copy.put("base_rows",safe);}
            copy.put("database_id",id);for(String field:Arrays.asList("properties","parent_row_id","depends_on"))if(body.has(field))output.put(field,body.get(field));
        }
        copy.put("body",output);
        return copy;
    }
    private void attachment(String id,Authority authority) throws Exception {
        if(denied.contains("attachment:"+id)||denied.contains("workspace:workspace"))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        if(attachments.contains(id))return;JSONObject metadata=authority.get("/api/attachments/"+OutboxPolicy.encode(id)+"/metadata");current(authority);
        if(!id.equals(text(metadata.opt("id")))||!"complete".equals(metadata.opt("status"))||!Arrays.asList("inline","chunks").contains(metadata.opt("storage"))||attachments.size()>=1000)throw new Failure("RECOVERY_ACCESS_REQUIRED");OutboxPolicy.text(metadata.opt("name"),255);OutboxPolicy.text(metadata.opt("mime"),255);OutboxPolicy.integer(metadata.opt("size"),0,5_000_000_000L);attachments.add(id);
    }
    private static JSONObject allow(JSONObject source,String...fields) throws Exception {JSONObject result=new JSONObject();for(String field:fields)if(source.has(field))result.put(field,source.get(field));return result;}
    private JSONObject operation(JSONObject source,Authority authority) throws Exception {
        String type=text(source.opt("type"));if(!Arrays.asList("block.insert","block.move","block.set","block.delete","text.insert","text.delete","text.format","history.cancel").contains(type))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        String client=text(source.opt("client"));long clock=OutboxPolicy.integer(source.opt("clock"),1,OutboxPolicy.SAFE-1);
        if(!client.matches("[A-Za-z0-9_-]{1,80}")||!(client+":"+clock).equals(source.opt("id")))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        JSONObject result=allow(source,"id","client","clock","type","group_id","_epoch");
        if(source.has("_epoch"))content(source.opt("_epoch"),160);
        if(source.has("group_id")&&!text(source.opt("group_id")).matches("[A-Za-z0-9_-]{1,80}"))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        if(type.equals("history.cancel")){JSONArray targets=source.getJSONArray("targets");if(targets.length()==0||targets.length()>1000)throw new Failure("RECOVERY_ACCESS_REQUIRED");for(int i=0;i<targets.length();i++)OutboxPolicy.text(targets.get(i),300);result.put("targets",targets);return result;}
        result.put("block_id",id(source.opt("block_id")));
        if(type.equals("block.insert")||type.equals("block.move")){for(String field:Arrays.asList("parent_id","after_id"))result.put(field,source.isNull(field)?JSONObject.NULL:id(source.opt(field)));}
        if(type.equals("block.insert")){String value=source.has("block_type")?text(source.opt("block_type")):"paragraph";blockType(value);result.put("block_type",value);}
        if(type.equals("block.set")){String field=text(source.opt("field"));result.put("field",field).put("value",blockField(field,source.get("value"),authority));}
        if(type.equals("text.insert")){result.put("after_id",source.isNull("after_id")?JSONObject.NULL:OutboxPolicy.text(source.opt("after_id"),300));result.put("text",content(source.opt("text"),100000)).put("marks",source.has("marks")?marks(source.getJSONObject("marks")):new JSONObject());}
        if(type.equals("text.delete")||type.equals("text.format")){JSONArray ids=source.getJSONArray("char_ids");if(ids.length()>100000)throw new Failure("RECOVERY_ACCESS_REQUIRED");for(int i=0;i<ids.length();i++)OutboxPolicy.text(ids.get(i),300);result.put("char_ids",ids);}
        if(type.equals("text.format"))result.put("marks",marks(source.getJSONObject("marks")));
        return result;
    }
    private static void blockType(String type)throws Exception{if(!Arrays.asList("paragraph","heading1","heading2","heading3","heading_1","heading_2","heading_3","bullet","numbered","bulleted_list_item","numbered_list_item","todo","to_do","quote","code","callout","divider","toggle","image","bookmark","file").contains(type))throw new Failure("RECOVERY_ACCESS_REQUIRED");}
    private Object blockField(String field,Object value,Authority authority)throws Exception{
        if(field.equals("type")){String type=text(value);blockType(type);return type;}
        if(field.equals("checked")){if(!(value instanceof Boolean))throw new Failure("RECOVERY_ACCESS_REQUIRED");return value;}
        if(field.equals("language"))return content(value,100);
        if(field.equals("size"))return OutboxPolicy.integer(value,0,OutboxPolicy.SAFE-1);
        if(field.equals("attachment_id")){if(value==JSONObject.NULL)return value;String identity=id(value);attachment(identity,authority);return identity;}
        throw new Failure("RECOVERY_ACCESS_REQUIRED");
    }
    static JSONObject marks(JSONObject source)throws Exception {
        JSONObject result=new JSONObject();Iterator<String> names=source.keys();
        while(names.hasNext()){String name=names.next();Object value=source.get(name);
            if(Arrays.asList("bold","italic","underline","strike","code").contains(name)){if(!(value instanceof Boolean))throw new Failure("RECOVERY_ACCESS_REQUIRED");}
            else if(name.equals("color")||name.equals("background")){if(!Arrays.asList("default","gray","brown","orange","yellow","green","blue","purple","pink","red").contains(value))throw new Failure("RECOVERY_ACCESS_REQUIRED");}
            else if(name.equals("link")){if(value!=JSONObject.NULL){String link=content(value,2048);if(link.isEmpty()||link.matches("(?s).*[\\x00-\\x20\\\\].*"))throw new Failure("RECOVERY_ACCESS_REQUIRED");if(link.startsWith("/")||link.startsWith("#")){if(link.startsWith("//"))throw new Failure("RECOVERY_ACCESS_REQUIRED");}else{java.net.URI uri=new java.net.URI(link);if(!Arrays.asList("http","https","mailto").contains(uri.getScheme())||("http".equals(uri.getScheme())||"https".equals(uri.getScheme()))&&uri.getHost()==null||"mailto".equals(uri.getScheme())&&(uri.getSchemeSpecificPart()==null||uri.getSchemeSpecificPart().isEmpty()))throw new Failure("RECOVERY_ACCESS_REQUIRED");}}}
            else throw new Failure("RECOVERY_ACCESS_REQUIRED");result.put(name,value);
        }return result;
    }
    private JSONArray blocks(JSONArray source,Authority authority) throws Exception {
        if(source.length()>2000)throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONArray result=new JSONArray();
        Set<String> ids=new HashSet<>();for(int i=0;i<source.length();i++){JSONObject block=source.getJSONObject(i);String identity=id(block.opt("id"));if(!ids.add(identity))throw new Failure("RECOVERY_ACCESS_REQUIRED");String type=block.has("type")?text(block.opt("type")):"paragraph";
            blockType(type);
            JSONObject safe=new JSONObject().put("id",identity).put("type",type).put("parent_id",block.isNull("parent_id")?JSONObject.NULL:id(block.opt("parent_id")));StringBuilder joined=new StringBuilder();
            if(block.has("rich_text")){JSONArray tokens=block.getJSONArray("rich_text"),rich=new JSONArray();if(tokens.length()>10000)throw new Failure("RECOVERY_ACCESS_REQUIRED");for(int index=0;index<tokens.length();index++){JSONObject token=tokens.getJSONObject(index);String text=content(token.opt("text"),100000);joined.append(text);if(joined.length()>100000)throw new Failure("RECOVERY_ACCESS_REQUIRED");rich.put(new JSONObject().put("text",text).put("marks",token.has("marks")?marks(token.getJSONObject("marks")):new JSONObject()));}safe.put("rich_text",rich);}
            String text=block.isNull("text")?joined.toString():content(block.opt("text"),100000);if(block.has("rich_text")&&block.getJSONArray("rich_text").length()>0&&!text.equals(joined.toString()))throw new Failure("RECOVERY_ACCESS_REQUIRED");safe.put("text",text);
            if(block.has("checked"))safe.put("checked",flag(block,"checked"));if(block.has("language"))safe.put("language",content(block.opt("language"),100));
            if(block.has("size"))safe.put("size",number(block,"size"));if(!block.isNull("attachment_id")){String file=id(block.opt("attachment_id"));attachment(file,authority);safe.put("attachment_id",file);}result.put(safe);}
        return result;
    }
    private Object stamp(Object value)throws Exception{if(value==JSONObject.NULL)return value;if(!(value instanceof JSONArray)||((JSONArray)value).length()!=3)throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONArray stamp=(JSONArray)value;OutboxPolicy.integer(stamp.get(0),0,OutboxPolicy.SAFE-1);OutboxPolicy.text(stamp.get(1),80);OutboxPolicy.text(stamp.get(2),300);return stamp;}
    private JSONObject stateBlocks(JSONObject source,Authority authority)throws Exception{
        JSONObject result=new JSONObject();Iterator<String> ids=source.keys();int count=0;
        while(ids.hasNext()){String key=ids.next();id(key);if(++count>2000)throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONObject node=source.getJSONObject(key),copy=new JSONObject();
            if(node.has("id"))copy.put("id",id(node.opt("id")));for(String field:Arrays.asList("insert","move"))if(node.has(field))copy.put(field,stamp(node.get(field)));
            if(node.has("deleted"))copy.put("deleted",flag(node,"deleted"));for(String field:Arrays.asList("parent_id","after_id"))if(node.has(field))copy.put(field,node.isNull(field)?JSONObject.NULL:id(node.opt(field)));
            JSONObject fields=new JSONObject(),registers=node.getJSONObject("fields");Iterator<String> names=registers.keys();while(names.hasNext()){String name=names.next();if(!Arrays.asList("type","checked","language","attachment_id","size").contains(name))throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONObject original=registers.getJSONObject(name),register=new JSONObject().put("stamp",stamp(original.get("stamp")));if(original.has("value"))register.put("value",blockField(name,original.get("value"),authority));fields.put(name,register);}copy.put("fields",fields);
            JSONObject chars=new JSONObject(),originalChars=node.getJSONObject("chars");Iterator<String> charsIDs=originalChars.keys();while(charsIDs.hasNext()){String charID=charsIDs.next();OutboxPolicy.text(charID,300);JSONObject original=originalChars.getJSONObject(charID),character=new JSONObject();
                if(original.has("id"))character.put("id",OutboxPolicy.text(original.opt("id"),300));if(original.has("after_id"))character.put("after_id",original.isNull("after_id")?JSONObject.NULL:OutboxPolicy.text(original.opt("after_id"),300));if(original.has("stamp"))character.put("stamp",stamp(original.get("stamp")));if(original.has("deleted"))character.put("deleted",flag(original,"deleted"));if(original.has("text"))character.put("text",content(original.opt("text"),100000));
                JSONObject marks=new JSONObject(),oldMarks=original.getJSONObject("marks");Iterator<String> markNames=oldMarks.keys();while(markNames.hasNext()){String name=markNames.next();JSONObject old=oldMarks.getJSONObject(name),register=new JSONObject().put("stamp",stamp(old.get("stamp")));if(old.has("value"))register.put("value",marks(new JSONObject().put(name,old.get("value"))).get(name));marks.put(name,register);}character.put("marks",marks);chars.put(charID,character);
            }copy.put("chars",chars);result.put(key,copy);
        }return result;
    }
    private JSONObject state(JSONObject source,Authority authority)throws Exception{
        if(OutboxPolicy.integer(source.opt("version"),1,1)!=1)throw new Failure("RECOVERY_ACCESS_REQUIRED");JSONObject result=new JSONObject().put("version",1).put("max_clock",number(source,"max_clock")).put("blocks",stateBlocks(source.getJSONObject("blocks"),authority));
        JSONObject seen=new JSONObject(),oldSeen=source.getJSONObject("seen");Iterator<String> ids=oldSeen.keys();while(ids.hasNext()){String key=ids.next();OutboxPolicy.text(key,300);Object value=oldSeen.get(key);if(value!=Boolean.TRUE&&(!(value instanceof String)||!((String)value).matches("[0-9a-f]{64}")))throw new Failure("RECOVERY_ACCESS_REQUIRED");seen.put(key,value);}result.put("seen",seen);
        if(source.has("history")){JSONObject old=source.getJSONObject("history"),history=new JSONObject().put("version",OutboxPolicy.integer(old.opt("version"),1,1));if(old.has("public"))history.put("public",flag(old,"public"));history.put("baseline",new JSONObject().put("blocks",stateBlocks(old.getJSONObject("baseline").getJSONObject("blocks"),authority)));
            JSONObject ops=new JSONObject(),oldOps=old.getJSONObject("ops");Iterator<String> keys=oldOps.keys();while(keys.hasNext()){String key=keys.next();JSONObject original=oldOps.getJSONObject(key),op;
                if(!old.has("public")||old.opt("public")!=Boolean.TRUE)op=operation(original,authority);
                else {String type=text(original.opt("type")),client=text(original.opt("client"));long clock=OutboxPolicy.integer(original.opt("clock"),1,OutboxPolicy.SAFE-1);if(!client.matches("[A-Za-z0-9_-]{1,80}")||!(client+":"+clock).equals(original.opt("id"))||!Arrays.asList("block.insert","block.move","block.set","block.delete","text.insert","text.delete","text.format","history.cancel").contains(type))throw new Failure("RECOVERY_ACCESS_REQUIRED");op=allow(original,"id","client","clock","type","block_id","group_id","field","char_ids","targets","after_id","character_count","mark_keys");
                    if(op.has("block_id"))id(op.opt("block_id"));if(op.has("group_id")&&!text(op.opt("group_id")).matches("[A-Za-z0-9_-]{1,80}"))throw new Failure("RECOVERY_ACCESS_REQUIRED");if(op.has("field")&&!Arrays.asList("type","checked","language","attachment_id","size").contains(op.opt("field")))throw new Failure("RECOVERY_ACCESS_REQUIRED");if(op.has("after_id")&&!op.isNull("after_id"))OutboxPolicy.text(op.opt("after_id"),300);if(op.has("character_count"))number(op,"character_count");
                    for(String field:Arrays.asList("char_ids","targets"))if(op.has(field)){JSONArray values=op.getJSONArray(field);for(int i=0;i<values.length();i++)OutboxPolicy.text(values.get(i),300);}if(op.has("mark_keys")){JSONArray names=op.getJSONArray("mark_keys");for(int i=0;i<names.length();i++)if(!Arrays.asList("bold","italic","underline","strike","code","color","background","link").contains(names.get(i)))throw new Failure("RECOVERY_ACCESS_REQUIRED");}}
                ops.put(key,op);
            }history.put("ops",ops);result.put("history",history);
        }
        if(source.has("unresolved_slots")){JSONArray slots=source.getJSONArray("unresolved_slots"),safe=new JSONArray();for(int i=0;i<slots.length();i++){JSONObject slot=slots.getJSONObject(i),copy=new JSONObject().put("block_id",id(slot.opt("block_id"))).put("kind",text(slot.opt("kind"))).put("source",stamp(slot.get("source")));if(!Arrays.asList("position","field","text","mark").contains(copy.opt("kind")))throw new Failure("RECOVERY_ACCESS_REQUIRED");if(slot.has("field")){String field=text(slot.opt("field"));if(!Arrays.asList("type","checked","language","attachment_id","size").contains(field))throw new Failure("RECOVERY_ACCESS_REQUIRED");copy.put("field",field);}if(slot.has("char_id"))copy.put("char_id",OutboxPolicy.text(slot.opt("char_id"),300));if(slot.has("mark")){String mark=text(slot.opt("mark"));if(!Arrays.asList("bold","italic","underline","strike","code","color","background","link").contains(mark))throw new Failure("RECOVERY_ACCESS_REQUIRED");copy.put("mark",mark);}safe.put(copy);}result.put("unresolved_slots",safe);}return result;
    }
    private void code(JSONArray blocks,String raw) throws Exception {
        String digest=OutboxPolicy.hash(raw);
        for(int offset=0;offset<raw.length();){int end=OutboxPolicy.recoverySlice(raw,offset,90000);String text=raw.substring(offset,end);blocks.put(new JSONObject().put("id","native-code-"+digest+"-"+offset).put("type","code").put("language","json").put("parent_id",JSONObject.NULL).put("text",text));offset=end;}
    }
    private JSONObject projection(Row row,Item item,Authority authority) throws Exception {
        if(row.sha.startsWith("blocked:"))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        current(authority);JSONObject original=read(row.id,row.size,authority);
        if(!OutboxPolicy.hash(original.toString()).equals(row.sha)||!sourceIdentity(original,item.profile,item.resource,row.bucket,row.key))throw new Failure("RECOVERY_STALE");
        boolean local = localPermission(row, authority);
        if (item.category.equals("local_page") || item.category.equals("typed") && local) {
            String page = java.net.URLDecoder.decode(item.resource.substring(item.resource.lastIndexOf('|') + 1).replace("+", "%2B"), "UTF-8");
            if (!local) proof("page", page, authority);
            JSONObject safe;
            if (item.category.equals("local_page")) safe = allow(original.getJSONObject("metadata").getJSONObject("page"), "id", "title", "icon", "cover", "parent_id", "teamspace_id");
            else { JSONObject operation = original.getJSONObject("operation"); if (!Arrays.asList("page.create", "page.patch").contains(operation.opt("kind"))) throw new Failure("RECOVERY_ACCESS_REQUIRED"); safe = new JSONObject().put("kind", operation.getString("kind")).put("body", allow(operation.getJSONObject("body"), "id", "title", "icon", "cover", "parent_id", "teamspace_id", "favorite")); }
            JSONArray visible = new JSONArray(); code(visible, safe.toString()); item.readableOnly = true;
            return exportValue(new JSONObject().put("page_id", page).put("draft", new JSONObject().put("blocks", visible).put("reason", "imported_native_recovery")));
        }
        if(item.category.equals("typed")){JSONObject operation=safeOperation(original.getJSONObject("operation"),item,authority);return exportValue(new JSONObject().put("profileId",item.profile).put("resourceKey",item.resource).put("status","paused").put("operation",operation));}
        String id=java.net.URLDecoder.decode(item.resource.substring(item.resource.lastIndexOf('|')+1).replace("+","%2B"),"UTF-8");if(!local)proof("page",id,authority);else item.readableOnly=true;
        if(!item.resource.equals(item.profile+"|"+OutboxPolicy.encode(id)))throw new Failure("RECOVERY_ACCESS_REQUIRED");
        JSONObject draft=new JSONObject();JSONArray visible=new JSONArray();
        if(row.bucket.equals("drafts")){JSONObject source=original.getJSONObject("draft");if(source.has("blocks"))visible=blocks(source.getJSONArray("blocks"),authority);
            JSONObject lineage=new JSONObject();
            if(source.has("epoch"))lineage.put("epoch",content(source.opt("epoch"),160));if(source.has("seq"))lineage.put("seq",number(source,"seq"));
            for(String field:Arrays.asList("history_pending","imported"))if(source.has(field))lineage.put(field,flag(source,field));
            if(source.has("createdAt")){String created=text(source.opt("createdAt"));OutboxPolicy.expiry(created);lineage.put("createdAt",created);}
            if(source.has("reason"))lineage.put("reason",content(source.opt("reason"),100));
            if(source.has("source_digest")){String digest=text(source.opt("source_digest"));if(!digest.matches("[0-9a-f]{64}"))throw new Failure("RECOVERY_ACCESS_REQUIRED");lineage.put("source_digest",digest);}
            if(source.has("state"))lineage.put("state",state(source.getJSONObject("state"),authority));
            if(source.has("ops")){JSONArray ops=source.getJSONArray("ops"),safe=new JSONArray();for(int i=0;i<ops.length();i++)safe.put(operation(ops.getJSONObject(i),authority));lineage.put("ops",safe);}
            if(lineage.length()>0)code(visible,lineage.toString());
        }else if(row.bucket.equals("snapshots")){JSONObject snapshot=original.getJSONObject("snapshot");String[] source=OutboxPolicy.recoveryProfile(session.origin,item.profile,session.workspace,session.member);
            if(snapshot.optJSONObject("page")==null||!id.equals(text(snapshot.getJSONObject("page").opt("id"))))throw new Failure("RECOVERY_ACCESS_REQUIRED");
            for(String field:Arrays.asList("workspace_id","current_member_id","session_binding"))if(snapshot.has(field)&&!Objects.equals(snapshot.opt(field),field.equals("workspace_id")?session.workspace:field.equals("current_member_id")?session.member:source[2]))throw new Failure("RECOVERY_ACCESS_REQUIRED");
            if(snapshot.has("blocks"))visible=blocks(snapshot.getJSONArray("blocks"),authority);
            // Never run historical RGA. Preserve the known document-state field
            // as quoted JSON, excluding the page ACL/owner/session envelope.
            JSONObject lineage=new JSONObject().put("epoch",content(snapshot.opt("epoch"),160)).put("seq",number(snapshot,"seq"));if(snapshot.has("state"))lineage.put("state",state(snapshot.getJSONObject("state"),authority));if(lineage.length()>0)code(visible,lineage.toString());
        }else if(row.bucket.equals("operations")){JSONArray ops=new JSONArray().put(operation(original.getJSONObject("operation"),authority));code(visible,new JSONObject().put("ops",ops).toString());}
        else throw new Failure("RECOVERY_ACCESS_REQUIRED");
        if(visible.length()==0)throw new Failure("RECOVERY_ACCESS_REQUIRED");draft.put("blocks",visible).put("reason","imported_native_recovery");return exportValue(new JSONObject().put("page_id",id).put("draft",draft));
    }
    private static String selection(JSONArray handles) throws Exception {
        if(handles.length()==0||handles.length()>100)throw new Failure("RECOVERY_STALE");TreeSet<String> values=new TreeSet<>();for(int i=0;i<handles.length();i++)if(!values.add(text(handles.get(i))))throw new Failure("RECOVERY_STALE");return values.toString();
    }
    private File temporary() throws Exception {
        File directory=new File(context.getNoBackupFilesDir(),"native_exports");if(!directory.isDirectory()&&!directory.mkdirs())throw new Failure("RECOVERY_STORAGE");
        if(!directory.setReadable(false,false)||!directory.setWritable(false,false)||!directory.setExecutable(false,false)||!directory.setReadable(true,true)||!directory.setWritable(true,true)||!directory.setExecutable(true,true))throw new Failure("RECOVERY_STORAGE");protectedFile(directory,true);
        File file=File.createTempFile("fountain-export-",".json",directory);try{if(!file.setReadable(false,false)||!file.setWritable(false,false)||!file.setReadable(true,true)||!file.setWritable(true,true))throw new Failure("RECOVERY_STORAGE");protectedFile(file,false);return file;}catch(Exception failure){file.delete();throw failure;}
    }
    private static final class SplitRequired extends Exception {}
    private static final class Output implements AutoCloseable {
        final File file;final FileOutputStream stream;final Prepared budget;long bytes;int count;
        Output(File file,Prepared budget)throws Exception{this.file=file;this.budget=budget;stream=new FileOutputStream(file);}
        void write(String text)throws Exception{byte[] value=text.getBytes(StandardCharsets.UTF_8);if(bytes+value.length>FILE_LIMIT)throw new SplitRequired();if(budget.written+value.length>TOTAL_LIMIT)throw new Failure("RECOVERY_STORAGE");for(int i=0;i<value.length;i+=OutboxPolicy.PART)stream.write(value,i,Math.min(OutboxPolicy.PART,value.length-i));bytes+=value.length;budget.written+=value.length;}
        void finish()throws Exception{stream.flush();stream.getFD().sync();stream.close();}
        public void close()throws IOException{stream.close();}
    }
    private JSONObject header(String profile) throws Exception {
        String[] source=OutboxPolicy.recoveryProfile(session.origin,profile,session.workspace,session.member);if(source==null)throw new Failure("RECOVERY_AUTH_REQUIRED");
        return new JSONObject().put("format","fountain-recovery-v2").put("origin",session.origin).put("workspace_id",session.workspace).put("member_id",session.member).put("source_binding",source[2]);
    }
    private boolean normal(List<Item> group,Prepared result,Authority authority)throws Exception {
        for (Item item : group) if (item.readableOnly) return false;
        File file=temporary();boolean complete=false;
        try(Output output=new Output(file,result)) {
            String profile=group.get(0).profile,prefix=header(profile).toString();output.write(prefix.substring(0,prefix.length()-1)+",\"localPages\":[],\"records\":[");int records=0,drafts=0,blocks=0;
            for(Item item:group)if(item.category.equals("typed"))for(Row row:item.rows){current(authority);if(++records>1000)return false;if(records>1)output.write(",");output.write(projection(row,item,authority).toString());}
            output.write("],\"drafts\":[");
            for(Item item:group)if(item.category.equals("body"))for(Row row:item.rows){current(authority);JSONObject draft=projection(row,item,authority);blocks+=draft.getJSONObject("draft").getJSONArray("blocks").length();if(++drafts>1000||blocks>2000)return false;if(drafts>1)output.write(",");output.write(draft.toString());}
            output.write("]}");output.finish();result.files.add(file);result.formats.add("fountain-recovery-v2");complete=true;return true;
        }catch(SplitRequired tooLarge){return false;}
        finally{if(!complete){result.written-=file.length();file.delete();}}
    }
    private void readable(List<Item> group,Prepared result,Authority authority)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");for(Item item:group)for(Row row:item.rows){current(authority);digest.update(projection(row,item,authority).toString().getBytes(StandardCharsets.UTF_8));digest.update((byte)'\n');}
        StringBuilder checksum=new StringBuilder();for(byte value:digest.digest())checksum.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
        Output output=null;int part=0;boolean complete=false;
        try {
            for(Item item:group)for(Row row:item.rows){String raw=projection(row,item,authority).toString()+"\n";
                for(int offset=0;offset<raw.length();){current(authority);int end=OutboxPolicy.recoverySlice(raw,offset,90000);
                    JSONObject block=new JSONObject().put("id","native-part-"+UUID.randomUUID()).put("type","code").put("language","json").put("text",raw.substring(offset,end));String encoded=block.toString();
                    if(output==null||output.bytes+encoded.getBytes(StandardCharsets.UTF_8).length+4>8*1024*1024||output.count>=1000){
                        if(output!=null){output.write("]}");output.finish();output=null;}
                        File file=temporary();result.files.add(file);result.formats.add("body");output=new Output(file,result);output.write("{\"blocks\":[");
                        output.write(new JSONObject().put("id","native-context-"+UUID.randomUUID()).put("type","code").put("language","text").put("text","Fountain readable recovery; ordered part "+(++part)+"; projection SHA256 "+checksum+". Manual-read JSON only; old operations are not replayed.").toString());output.count=1;
                    }
                    output.write(","+encoded);output.count++;offset=end;
                    long total=0;for(File file:result.files)total+=file.length();if(total>TOTAL_LIMIT)throw new Failure("RECOVERY_STORAGE");
                }
            }
            if(output!=null){output.write("]}");output.finish();output=null;}complete=true;
        }finally{if(output!=null)output.close();if(!complete)result.delete();}
    }
    JSObject prepare(String token,JSONArray handles,long generation,Authority authority)throws Exception {
        unchanged(authority);if(!inventoryToken.equals(token))throw new Failure("RECOVERY_STALE");String selected=selection(handles);
        if(prepared!=null){prepared.delete();prepared=null;}proofs.clear();attachments.clear();authorityVersion++;exportPolicy(authority,true);List<Item> ready=new ArrayList<>();int blocked=0;
        Map<String,Set<String>> edges=new HashMap<>();Map<String,Item> owners=new HashMap<>();
        for(int i=0;i<handles.length();i++) {
            Item item=items.get(handles.getString(i));if(item==null)throw new Failure("RECOVERY_STALE");
            try {for(Row row:item.rows){JSONObject value=projection(row,item,authority);if(item.category.equals("typed")&&!item.readableOnly){JSONObject operation=value.getJSONObject("operation");String id=text(operation.opt("id"));if(owners.containsKey(id))throw new Failure("RECOVERY_ACCESS_REQUIRED");Set<String> dependencies=new HashSet<>();JSONArray source=operation.getJSONArray("depends_on");for(int j=0;j<source.length();j++)dependencies.add(text(source.get(j)));if(operation.has("base_rows")){JSONObject bases=operation.getJSONObject("base_rows");Iterator<String> ids=bases.keys();while(ids.hasNext()){JSONObject base=bases.getJSONObject(ids.next());if(!base.isNull("after_operation"))dependencies.add(text(base.opt("after_operation")));}}edges.put(id,dependencies);owners.put(id,item);}}ready.add(item);}
            catch(Failure failure){if(!failure.code.equals("RECOVERY_ACCESS_REQUIRED"))throw failure;blocked++;}
            catch(org.json.JSONException|IllegalArgumentException unsupported){blocked++;}
        }
        boolean changed=true;while(changed){changed=false;for(Item item:new ArrayList<>(ready))if(item.category.equals("typed")){boolean missing=false;for(Map.Entry<String,Item> operation:owners.entrySet())if(operation.getValue()==item)for(String dependency:edges.get(operation.getKey()))if(!owners.containsKey(dependency)||!ready.contains(owners.get(dependency))||!item.profile.equals(owners.get(dependency).profile))missing=true;if(missing){ready.remove(item);blocked++;changed=true;}}}
        Set<String> complete=new HashSet<>();boolean progress=true;while(progress){progress=false;for(String id:owners.keySet())if(ready.contains(owners.get(id))&&!complete.contains(id)&&complete.containsAll(edges.get(id))){complete.add(id);progress=true;}}
        for(Item item:new ArrayList<>(ready))if(item.category.equals("typed")){boolean cycle=false;for(String id:owners.keySet())if(owners.get(id)==item&&!complete.contains(id))cycle=true;if(cycle){ready.remove(item);blocked++;}}
        JSONArray warnings=new JSONArray().put("가져오기 전 현재 권한을 다시 확인합니다. 원본 기기 자료는 변경하거나 삭제하지 않습니다.").put("본문 상태·작업 위치를 확정할 수 없는 내용은 읽을 수 있는 코드로 함께 보존합니다.");
        boolean stable=false;for(int attempt=0;attempt<3&&!stable;attempt++){long before=authorityVersion;for(Item item:ready)for(Row row:item.rows)projection(row,item,authority);stable=before==authorityVersion;}if(!stable)throw new Failure("RECOVERY_STALE");
        exportPolicy(authority,false);
        long until=Math.min(session.validUntil,System.currentTimeMillis()+AUTHORITY_TTL);for(JSONObject proof:proofs.values())until=Math.min(until,proof.getLong("until"));
        int readyRows=0,totalRows=0;for(Item item:ready)readyRows+=item.rows.size();for(int i=0;i<handles.length();i++)totalRows+=items.get(handles.getString(i)).rows.size();
        Prepared result=new Prepared(token,selected,session.scope,fingerprint,until,authorityVersion,readyRows,totalRows-readyRows,warnings);
        try {
            Map<String,List<Item>> bindings=new LinkedHashMap<>();for(Item item:ready){if(!bindings.containsKey(item.profile))bindings.put(item.profile,new ArrayList<>());bindings.get(item.profile).add(item);}
            for(List<Item> group:bindings.values())if(!normal(group,result,authority)){warnings.put("일반 복구 파일의 범위를 넘어 원문 JSON을 순서가 있는 읽기 전용 본문 파일로 나눴습니다. 자동 변경 재실행은 포함하지 않습니다.");readable(group,result,authority);}
            long size=0;for(File file:result.files){size+=file.length();if(size>TOTAL_LIMIT)throw new Failure("RECOVERY_STORAGE");}
            unchanged(authority);if(result.authorityVersion!=authorityVersion)throw new Failure("RECOVERY_STALE");prepared=result;return metadata(result,generation);
        }catch(Exception failure){result.delete();throw failure;}
    }
    private JSObject metadata(Prepared result,long generation)throws Exception {
        JSONArray files=new JSONArray();for(int i=0;i<result.files.size();i++)files.put(new JSONObject().put("name","fountain-recovery-"+(i+1)+".json").put("byteLength",result.files.get(i).length()).put("format",result.formats.get(i)));
        JSObject answer=new JSObject();answer.put("generation",generation);answer.put("exportToken",result.token);answer.put("readyCount",result.ready);answer.put("blockedCount",result.blocked);answer.put("files",files);answer.put("warnings",result.warnings);return answer;
    }
    Prepared saving(String inventory,String token,JSONArray handles,Authority authority)throws Exception {
        unchanged(authority);if(prepared==null||!prepared.inventory.equals(inventory)||!prepared.token.equals(token)||!prepared.selection.equals(selection(handles)))throw new Failure("RECOVERY_STALE");checkPrepared(prepared,authority);exportPolicy(authority,true);checkPrepared(prepared,authority);return prepared;
    }
    void checkPrepared(Prepared value,Authority authority)throws Exception {
        current(authority);JSONObject policy=proofs.get("workspace:workspace");
        if(policy==null||policy.opt("exportAllowed")!=Boolean.TRUE||policy.getLong("until")<=System.currentTimeMillis()||policy.getLong("access")<maxAccess||policy.getLong("data")<maxData){discardPreparedExport();throw new Failure("RECOVERY_ACCESS_REQUIRED");}
        Session current=session;if(current==null||value!=prepared||!value.scope.equals(current.scope)||value.authorityVersion!=authorityVersion||System.currentTimeMillis()>=value.deadline)throw new Failure("RECOVERY_STALE");
    }
    void checkResponse(JSObject result,Authority authority)throws Exception {current(authority);if(result.has("inventoryToken")&&!Objects.equals(inventoryToken,result.opt("inventoryToken")))throw new Failure("RECOVERY_STALE");if(result.has("exportToken")){Prepared value=prepared;if(value==null||!value.token.equals(result.opt("exportToken")))throw new Failure("RECOVERY_STALE");checkPrepared(value,authority);}}
    void checkSavedSource(Prepared value,Authority authority)throws Exception {checkPrepared(value,authority);exportPolicy(authority,true);checkPrepared(value,authority);unchanged(authority);}
    void finished(Prepared value){if(prepared==value){value.delete();prepared=null;}}

    // Structural bounds precede the platform JSON parser; quoted document text
    // is never interpreted as a bridge command or replayed as an old operation.
    private static void bounded(String text) throws Exception {
        int depth=0,nodes=0;boolean quoted=false,escaped=false,start=true;
        for(int i=0;i<text.length();i++) { char point=text.charAt(i);if(quoted) {if(escaped)escaped=false;else if(point=='\\')escaped=true;else if(point=='"')quoted=false;continue;}
            if(point=='"'){quoted=true;start=false;nodes++;}else if(point=='{'||point=='['){depth++;nodes++;start=true;}else if(point=='}'||point==']'){depth--;start=false;}else if(point==','||point==':')start=true;else if(!Character.isWhitespace(point)&&start){nodes++;start=false;}
            if(depth>32||depth<0||nodes>150000)throw new Failure("RECOVERY_ACCESS_REQUIRED");
        }
    }
}
