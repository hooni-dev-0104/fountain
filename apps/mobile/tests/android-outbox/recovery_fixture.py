"""Optional production Java recovery exercise using a PREEXISTING compatibility jar.

SQLite/Os/Context are portable test adapters. This is not Android SDK or device
evidence. No dependency is downloaded, installed or added to the app manifest.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SOURCE = ROOT / 'apps/mobile/android/app/src/main/java/dev/fountain/workspace'
JAR = os.environ.get('FOUNTAIN_ANDROID_JSON_JAR')
if not JAR or not Path(JAR).is_file():
    print('SKIP optional recovery JVM exercise: set FOUNTAIN_ANDROID_JSON_JAR to an existing android-json compatibility jar; nothing is installed')
    raise SystemExit(0)
JAR = Path(JAR).resolve()
print('Preexisting optional JSON jar:', JAR.name, 'SHA256', hashlib.sha256(JAR.read_bytes()).hexdigest())
tree = ast.parse((HERE / 'compile_fixture.py').read_text())
stubs = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'STUBS' for target in node.targets))
stubs = {name: value for name, value in stubs.items() if not name.startswith('org/json/')}
stubs['android/content/Context.java'] = '''package android.content; public class Context { public java.io.File getNoBackupFilesDir(){return new java.io.File(System.getProperty("fountain.fixture.root"));} }'''
stubs['android/os/Process.java'] = '''package android.os; public class Process { public static int myUid(){return Integer.parseInt(System.getProperty("fountain.fixture.uid"));} }'''
stubs['android/system/OsConstants.java'] = '''package android.system; public class OsConstants {public static boolean S_ISDIR(int m){return (m&0170000)==0040000;}public static boolean S_ISREG(int m){return (m&0170000)==0100000;} }'''
stubs['android/system/Os.java'] = '''package android.system; import java.nio.file.*; public class Os {public static StructStat lstat(String file)throws Exception {Path p=Paths.get(file);StructStat s=new StructStat();s.st_uid=((Number)Files.getAttribute(p,"unix:uid",LinkOption.NOFOLLOW_LINKS)).intValue();s.st_mode=((Number)Files.getAttribute(p,"unix:mode",LinkOption.NOFOLLOW_LINKS)).intValue();s.st_dev=((Number)Files.getAttribute(p,"unix:dev",LinkOption.NOFOLLOW_LINKS)).longValue();s.st_ino=((Number)Files.getAttribute(p,"unix:ino",LinkOption.NOFOLLOW_LINKS)).longValue();return s;} }'''
stubs['com/getcapacitor/JSObject.java'] = '''package com.getcapacitor; public class JSObject extends org.json.JSONObject {public JSObject put(String k,Object v){try{super.put(k,v);return this;}catch(org.json.JSONException e){throw new IllegalArgumentException();}}}'''
stubs['android/database/Cursor.java'] = '''package android.database; public class Cursor implements AutoCloseable {private final org.json.JSONArray rows;private int index=-1;public Cursor(org.json.JSONArray r){rows=r;}public boolean moveToFirst(){index=0;return rows.length()>0;}public boolean moveToNext(){return ++index<rows.length();}private Object value(int n){try{return rows.getJSONArray(index).get(n);}catch(Exception e){throw new IllegalStateException(e);}}public String getString(int n){Object v=value(n);return v==org.json.JSONObject.NULL?null:v.toString();}public int getInt(int n){return ((Number)value(n)).intValue();}public long getLong(int n){return ((Number)value(n)).longValue();}public byte[] getBlob(int n){try{return java.util.Base64.getDecoder().decode(((org.json.JSONObject)value(n)).getString("$blob"));}catch(Exception e){throw new IllegalStateException(e);}}public void close(){} }'''
stubs['android/database/sqlite/SQLiteDatabase.java'] = '''package android.database.sqlite;import java.io.*;import java.util.*;import org.json.*;public class SQLiteDatabase {public static final int OPEN_READONLY=1,NO_LOCALIZED_COLLATORS=16;private String path;private boolean closed;public static SQLiteDatabase openDatabase(String p,Object f,int flags){if((flags&OPEN_READONLY)==0||!new File(p).isFile())throw new IllegalArgumentException();SQLiteDatabase d=new SQLiteDatabase();d.path=p;return d;}public boolean isReadOnly(){return true;}public void execSQL(String sql){if(!sql.equals("PRAGMA query_only=ON"))throw new AssertionError("Recovery attempted SQL mutation");}public android.database.Cursor rawQuery(String sql,String[] args){if(closed)throw new IllegalStateException();try{JSONArray values=new JSONArray();if(args!=null)for(String a:args)values.put(a);Process process=new ProcessBuilder(System.getProperty("fountain.fixture.python"),System.getProperty("fountain.fixture.sqlite"),path,sql,values.toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream input=process.getInputStream()){byte[] b=new byte[65536];int n;while((n=input.read(b))!=-1)out.write(b,0,n);}if(process.waitFor()!=0)throw new IllegalStateException("Read-only fixture query failed");return new android.database.Cursor(new JSONArray(new String(out.toByteArray(),java.nio.charset.StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}}public void close(){closed=true;} }'''

with tempfile.TemporaryDirectory(prefix='fountain-recovery-jvm-') as folder:
    scratch = Path(folder).resolve()
    # Only signatures needed by NativeRecovery are compiled, not fake native I/O.
    selected = ['android/content/Context.java', 'android/os/Process.java', 'android/system/StructStat.java', 'android/system/OsConstants.java', 'android/system/Os.java', 'android/database/Cursor.java', 'android/database/sqlite/SQLiteDatabase.java', 'com/getcapacitor/JSObject.java']
    for name in selected:
        target = scratch / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(stubs[name])
    sqlite_adapter = scratch / 'readonly_query.py'
    sqlite_adapter.write_text('''import base64,json,sqlite3,sys
from pathlib import Path
db=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
db.execute('PRAGMA query_only=ON')
def cell(value):return {'$blob':base64.b64encode(value).decode()} if isinstance(value,bytes) else value
print(json.dumps([[cell(value) for value in row] for row in db.execute(sys.argv[2],json.loads(sys.argv[3]))]))
db.close()
''')
    java_home = os.environ.get('FOUNTAIN_JAVA_HOME') or os.environ.get('JAVA_HOME')
    javac = str(Path(java_home) / 'bin/javac') if java_home else 'javac'
    java = str(Path(java_home) / 'bin/java') if java_home else 'java'
    compiled = scratch / 'compiled'
    subprocess.run([javac, '--release', '8', '-cp', str(JAR), '-d', str(compiled), *map(str, (scratch / 'android').rglob('*.java')), str(scratch / 'com/getcapacitor/JSObject.java'),
                    *[str(SOURCE / name) for name in ('NativePolicy.java', 'OutboxPolicy.java', 'NativeRecovery.java')], str(HERE / 'RecoveryFixture.java')], check=True)
    sys.path.insert(0, str(ROOT))
    os.environ['FOUNTAIN_ACCESS_TOKEN'] = ''
    from fountain.server import create_server
    server = create_server(port=0, db_path=scratch / 'authority.db')
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
    thread.start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    def api(path, body=None):
        request = Request(origin + '/api' + path, None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'X-Fountain-Request': '1'})
        with urlopen(request) as response:
            return json.load(response)
    try:
        session = api('/session')
        page = api('/pages', {'title': 'Disposable native recovery authority'})
        snapshot = api('/pages/' + page['id'] + '/collaboration')
        database = api('/databases', {'name': 'Disposable recovery DB', 'properties': [{'id': 'name', 'name': 'Name', 'type': 'title'}]})
        row = api('/databases/' + database['id'] + '/rows', {'properties': {'name': 'current'}})
        attachment = api('/attachments', {'name': 'qa-attachment.txt', 'data': 'aGVsbG8='})
        schema = re.search(r'SCHEMA = \{(.*?)\n    \};', (SOURCE / 'NativeOutbox.java').read_text(), re.S)[1]
        schema = re.findall(r'"([^"\n]+)"', schema)
        from urllib.parse import quote
        actor = session['member']['id']
        profile = origin + '|' + '|'.join(quote(value, safe="-_.!~*'()") for value in (session['workspace_id'], actor, 'old-source-binding'))
        page_key = profile + '|' + quote(page['id'], safe="-_.!~*'()")
        db_key = profile + '|database|' + quote(database['id'], safe="-_.!~*'()")
        for mode in ('absent', 'normal', 'changed', 'denied', 'attachment_denied', 'cancel', 'actor', 'lineage', 'property', 'base_fields', 'base_rows', 'profile_denied', 'body_kind', 'typed_kind', 'bad_level', 'bad_nested', 'bad_fraction', 'bad_boolean', 'bad_flags', 'bad_revision', 'overflow'):
            private = scratch / ('private-' + mode)
            private.mkdir(mode=0o700)
            source = private / 'durable_outbox' / (hashlib.sha256(origin.encode()).hexdigest() + '.sqlite')
            if mode != 'absent':
                source.parent.mkdir(mode=0o700)
                connection = sqlite3.connect(source)
                for statement in schema:
                    connection.execute(statement)
                connection.execute('INSERT INTO control VALUES(?,?)', ('head', '7'))
                def insert(bucket, resource, payload, source_profile=profile, storage='quarantine'):
                    payload = {**payload, 'profileId': source_profile}
                    key = [source_profile, payload['id']] if bucket == 'mutations' else [resource, payload['clientId' if bucket == 'drafts' else 'id']] if bucket in ('operations', 'drafts') else resource
                    connection.execute('INSERT INTO records VALUES(?,?,?,?,?,?)', (storage, bucket, json.dumps(key, ensure_ascii=False, separators=(',', ':')), source_profile, resource, json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()))
                if mode == 'overflow':
                    large = {**snapshot, 'session_binding': 'old-source-binding', 'blocks': [{'id': 'large-' + str(i), 'type': 'paragraph', 'text': 'abcdefghij' * 420 + '🏠'} for i in range(2000)]}
                    insert('snapshots', page_key, {'key': page_key, 'snapshot': large})
                else:
                    insert('mutations', db_key, {'id': 'old-row-patch', 'resourceKey': db_key, 'operation': {'id': 'old-row-patch', 'kind': 'row.patch', 'database_id': database['id'], 'target_id': row['id'], 'body': {'properties': {'name': '복구 행 🏠'}}, 'base': {'properties': {'name': 'before'}, 'fields': {'provider_key': 'DO-NOT-EXPORT-BASE'}}, 'provider_key': 'DO-NOT-EXPORT-TYPED', 'depends_on': []}, 'status': 'applied', 'result': {'api_key': 'DO-NOT-EXPORT-RECEIPT'}})
                    state = {**snapshot['state'], 'provider_key': 'DO-NOT-EXPORT-STATE'}
                    insert('snapshots', page_key, {'key': page_key, 'snapshot': {**snapshot, 'state': state, 'session_binding': 'old-source-binding'}, 'session': {'api_key': 'DO-NOT-EXPORT-SESSION'}}, storage='active')
                    insert('drafts', page_key, {'key': page_key, 'clientId': 'old-client', 'draft': {'epoch': snapshot['epoch'], 'state': state, 'history_pending': {'provider_key': 'DO-NOT-EXPORT-LINEAGE'} if mode == 'lineage' else True, 'blocks': [{'id': 'draft', 'type': 'paragraph', 'text': '미전송 원문 🏠', **({'attachment_id': attachment['id']} if mode == 'attachment_denied' else {}), 'rich_text': [{'text': '미전송 원문 🏠', 'marks': {'bold': True}, 'provider_key': 'DO-NOT-EXPORT-TOKEN'}]}], 'reason': 'pending'}})
                    insert('operations', page_key, {'key': page_key, 'id': 'old:1', 'operation': {'id': 'old:1', 'client': 'old', 'clock': 1, 'type': 'text.insert', 'block_id': 'unknown', 'after_id': None, 'text': 'unresolved exact input 🏠', 'provider_key': 'DO-NOT-EXPORT-OP', '_epoch': snapshot['epoch']}})
                    local_key = profile + '|unpublished-page'
                    insert('localPages', local_key, {'key': local_key, 'resourceKey': local_key, 'metadata': {'page': {'id': 'unpublished-page'}}})
                    foreign = origin + '|' + quote(session['workspace_id'], safe="-_.!~*'()") + '|foreign-member|old-binding'
                    foreign_key = foreign + '|' + quote(page['id'], safe="-_.!~*'()")
                    insert('drafts', foreign_key, {'key': foreign_key, 'clientId': 'foreign', 'draft': {'blocks': [{'id': 'foreign', 'type': 'paragraph', 'text': 'FOREIGN-SECRET'}]}}, foreign)
                    if mode in ('property', 'base_fields', 'base_rows', 'typed_kind'):
                        encoded = connection.execute("SELECT payload FROM records WHERE bucket='mutations'").fetchone()[0]
                        mutation = json.loads(encoded)
                        operation = mutation['operation']
                        if mode == 'property': operation['body']['properties']['name'] = {'provider_key': 'DO-NOT-EXPORT-PROPERTY'}
                        if mode == 'base_fields': operation['base']['fields']['properties'] = {'name': {'provider_key': 'DO-NOT-EXPORT-BASE'}}
                        if mode == 'base_rows': operation['base_rows'] = {row['id']: {'updated_at': {'provider_key': 'DO-NOT-EXPORT-BASE-ROW'}}}
                        if mode == 'typed_kind':
                            malformed = profile + '|database|' + quote(page['id'], safe="-_.!~*'()")
                            mutation['resourceKey'] = malformed
                            mutation['operation'] = {'id': operation['id'], 'kind': 'page.patch', 'target_id': page['id'], 'body': {'title': 'blocked wrong resource kind'}, 'depends_on': []}
                            connection.execute("UPDATE records SET resource_key=? WHERE bucket='mutations'", (malformed,))
                        connection.execute("UPDATE records SET payload=? WHERE bucket='mutations'", (json.dumps(mutation, ensure_ascii=False, separators=(',', ':')).encode(),))
                    if mode == 'body_kind':
                        malformed = profile + '|database|' + quote(page['id'], safe="-_.!~*'()")
                        for rowid, encoded, key in connection.execute("SELECT rowid,payload,key FROM records WHERE profile_id=? AND bucket IN ('drafts','operations','snapshots')", (profile,)).fetchall():
                            payload, parsed_key = json.loads(encoded), json.loads(key)
                            payload['key'] = malformed
                            if isinstance(parsed_key, list): parsed_key[0] = malformed
                            else: parsed_key = malformed
                            connection.execute('UPDATE records SET payload=?,key=?,resource_key=? WHERE rowid=?', (json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode(), json.dumps(parsed_key, ensure_ascii=False, separators=(',', ':')), malformed, rowid))
                    if mode == 'profile_denied':
                        current = origin + '|' + '|'.join(quote(value, safe="-_.!~*'()") for value in (session['workspace_id'], actor, session['cache_binding']))
                        connection.execute("INSERT INTO tombstones VALUES('profile',?)", (current,))
                connection.commit()
                connection.close()
                source.chmod(0o600)
            before = hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None
            config = {'origin': origin, 'mode': mode, 'page': page['id'], 'attachment': attachment['id'], 'source': str(source), 'saved': str(private / 'saved'), 'result': str(private / 'result.json'), 'sourceHash': before or ''}
            config_path = private / 'config.json'
            config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
            subprocess.run([java, '-Xmx512m', '-Dfountain.fixture.root=' + str(private), '-Dfountain.fixture.uid=' + str(os.getuid()), '-Dfountain.fixture.python=' + sys.executable,
                            '-Dfountain.fixture.sqlite=' + str(sqlite_adapter), '-cp', os.pathsep.join((str(compiled), str(JAR))), 'dev.fountain.workspace.RecoveryFixture', str(config_path)], check=True)
            assert (hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None) == before, mode + ': Java recovery changed source bytes'
            if (private / 'result.json').exists():
                script = '''const fs=require('node:fs');globalThis.FountainCollaboration=require(process.argv[1]+'/static/collaboration.js');const R=require(process.argv[1]+'/static/recovery-import.js'),result=JSON.parse(fs.readFileSync(process.argv[2]));let typed=0,drafts=0,raw='',checksum=null;for(const path of result.files){const text=fs.readFileSync(path,'utf8');if(Buffer.byteLength(text)>16*1024*1024)throw Error('size');const parsed=R.parse(text,result);typed+=parsed.records.length;drafts+=parsed.drafts.length;const body=JSON.parse(text);if(!body.format){const digest=body.blocks[0].text.match(/projection SHA256 ([0-9a-f]{64})/)[1];if(checksum&&checksum!==digest)throw Error('part digest changed');checksum=digest;raw+=body.blocks.slice(1).map(b=>b.text).join('');}}if(result.mode==='normal'&&(typed!==1||drafts!==3))throw Error('native v2 round trip');if(result.mode==='overflow'){if(require('node:crypto').createHash('sha256').update(raw).digest('hex')!==checksum)throw Error('projection checksum does not match exact exported bytes');const projection=JSON.parse(raw.trim());if(projection.draft.blocks.length!==2001||projection.draft.blocks[0].text!=='abcdefghij'.repeat(420)+'🏠')throw Error('readable ordered lossless projection');if(typed!==0)throw Error('partial replay');}console.log('PASS actual web recovery parser on production Java output',result.mode,typed,drafts);'''
                subprocess.run(['node', '-e', script, str(ROOT), str(private / 'result.json')], check=True)
        print('PASS optional JDK production recovery: actual temporary HTTP authority + read-only SQLite adapters + current web parser; source bytes preserved; NOT Android SDK/device/HTTPS/OS picker evidence')
    finally:
        server.shutdown(); server.server_close(); thread.join(); server.application.store.close()
