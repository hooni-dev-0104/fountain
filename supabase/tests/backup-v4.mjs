/** Real SQLite V4 bytes, independent unique-index sources, trusted restore. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteBackupWriter,ACTIVITY_COLUMNS,ACTIVITY_KEYS,VAULT_COLUMNS} from '../functions/_shared/sqlite-backup.ts';
import {createBackup} from '../functions/_shared/backup.ts';
import {createSQLiteBackupCheckpoint,stepSQLiteBackup} from '../functions/_shared/sqlite-backup-resumable.ts';
const dir=await mkdtemp(join(tmpdir(),'fountain-activity-v4-')),python=process.env.FOUNTAIN_PYTHON||'python3';let checks=0;
const py=(code,...args)=>{const r=spawnSync(python,['-c',code,...args],{cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
try{
 py(`import json,sys,sqlite3,hashlib
from fountain.backup import DEFINITIONS,create_backup,inspect_backup
from fountain.backup import INDEX_DEFINITIONS
from fountain.retention_vault import VAULT_DEFINITIONS
from fountain.activity import ACTIVITY_COLUMNS,ACTIVITY_DEFINITIONS
from fountain.canonical import canonical_source
c=sqlite3.connect(sys.argv[1])
for ddl in (*DEFINITIONS.values(),INDEX_DEFINITIONS['content_provenance'],*VAULT_DEFINITIONS.values(),*ACTIVITY_DEFINITIONS.values()):c.execute(ddl)
u=lambda n:format(n,'032x');member='한😀'*80;stamp='2020-01-01T00:00:00.123456Z';closed='2020-02-01T00:00:00+00:00'
for n in (1,2):
 c.execute('INSERT INTO activity_ledgers VALUES(?,?,?,?)',(u(n),stamp,'installation' if n==1 else 'restore','canonical-server-v1'))
 c.execute('INSERT INTO activity_memberships VALUES(?,?,?,?,?,?)',(u(10+n),u(n),member,stamp,closed if n==1 else None,'restore' if n==1 else None))
 c.execute('INSERT INTO activity_accounts VALUES(?,?,?,?,?,?)',(u(20+n),u(10+n),'supabase',stamp,closed if n==1 else None,'restore' if n==1 else None))
raw='{"큰수":9007199254740993,"fraction":1.2300,"zero":-0,"😀":"é"}';canonical=canonical_source(raw);sha=hashlib.sha256(canonical).hexdigest()
for i in range(521):
 n=1 if i<7 else 2;seq=i+1 if n==1 else i-6
 c.execute('INSERT INTO activity_events VALUES('+','.join('?'*17)+')',(u(n),seq,u(2000-i),u(3000+(i*37)%521),i%3,member,u(10+n),u(20+n),'human',('created','edited','viewed','managed','deleted')[i%5],'page','😀'*160,u(9000),stamp,'fountain-cjson-v1',len(canonical),sha))
c.commit();inspect_backup(sys.argv[1]);create_backup(sys.argv[1],sys.argv[2]);tables={}
for table in ('entities','meta','content_provenance',*VAULT_DEFINITIONS,'attachment_chunks',*ACTIVITY_COLUMNS):
 cols=[r[1] for r in c.execute('PRAGMA table_info('+table+')')];pk=[r[1] for r in sorted(c.execute('PRAGMA table_info('+table+')'),key=lambda r:r[5]) if r[5]]
 tables[table]=[dict(zip(cols,r)) for r in c.execute('SELECT * FROM '+table+' ORDER BY '+','.join(pk))]
json.dump(tables,open(sys.argv[3],'w'),ensure_ascii=False);c.close()`,join(dir,'source.db'),join(dir,'python.db'),join(dir,'fixture.json'));checks++;
 const tables=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8')),activity=Object.fromEntries(Object.keys(ACTIVITY_COLUMNS).map(t=>[t,()=>tables[t]])),source={entities:()=>tables.entities,meta:()=>tables.meta,chunks:()=>[],provenance:()=>tables.content_provenance,activity};
 const bytes=[];const summary=await new SQLiteBackupWriter().write(source,{write(b){bytes.push(b.slice());}}),expected=Buffer.concat(bytes);assert.equal(Object.keys(summary.counts).length,14);assert.equal(summary.counts.activity_events,521);await writeFile(join(dir,'sync.db'),expected);checks++;
 const oracle=py(`import sys,sqlite3,json
from fountain.backup import inspect_backup,restore_backup,create_backup,BackupError
from fountain.activity import ACTIVITY_COLUMNS,ACTIVITY_RUNTIME_COLUMNS,inspect_portable_activity
c=sqlite3.connect(sys.argv[1]);inspect_backup(sys.argv[1]);tables={r[0] for r in c.execute("SELECT name FROM sqlite_schema WHERE type='table'")};assert len(tables)==14 and not tables&set(ACTIVITY_RUNTIME_COLUMNS)
assert c.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not c.execute('PRAGMA foreign_key_check').fetchall()
assert len(c.execute("PRAGMA index_list('activity_events')").fetchall())==3
fixture=json.load(open(sys.argv[2]))
for table,cols in ACTIVITY_COLUMNS.items():
 expected=fixture[table];actual=[dict(zip(cols,r)) for r in c.execute('SELECT * FROM '+table+' ORDER BY '+('ledger_id,sequence' if table=='activity_events' else 'id'))];assert actual==expected,(table,len(actual))
for sql in ("UPDATE activity_events SET event_id=(SELECT event_id FROM activity_events WHERE sequence=1 AND ledger_id='00000000000000000000000000000001') WHERE sequence=2 AND ledger_id='00000000000000000000000000000001'", "UPDATE activity_events SET command_id=(SELECT command_id FROM activity_events WHERE sequence=1 AND ledger_id='00000000000000000000000000000001'),command_ordinal=0 WHERE sequence=2 AND ledger_id='00000000000000000000000000000001'"):
 try:c.execute(sql)
 except sqlite3.IntegrityError:c.rollback()
 else:raise AssertionError('Unique constraint absent')
restore_backup(sys.argv[1],sys.argv[3]);r=sqlite3.connect(sys.argv[3]);inspect_portable_activity(r);assert r.execute('SELECT count(*) FROM activity_ledgers').fetchone()[0]==3
assert r.execute('SELECT count(*) FROM activity_current_members').fetchone()[0]==r.execute('SELECT count(*) FROM activity_current_accounts').fetchone()[0]==0
assert r.execute('SELECT count(*) FROM activity_memberships WHERE closed_at IS NULL').fetchone()[0]==0
assert r.execute('SELECT * FROM activity_events ORDER BY ledger_id,sequence').fetchall()==c.execute('SELECT * FROM activity_events ORDER BY ledger_id,sequence').fetchall()
assert r.execute('SELECT * FROM activity_memberships WHERE id=?',('0000000000000000000000000000000b',)).fetchone()==c.execute('SELECT * FROM activity_memberships WHERE id=?',('0000000000000000000000000000000b',)).fetchone()
create_backup(r,sys.argv[4]);p=sqlite3.connect(sys.argv[4]);assert not {x[0] for x in p.execute("SELECT name FROM sqlite_schema WHERE type='table'")}&set(ACTIVITY_RUNTIME_COLUMNS)
print('14 tables, PK+two UNIQUE, 521 immutable events, new restore epoch, no authority')`,join(dir,'sync.db'),join(dir,'fixture.json'),join(dir,'restored.db'),join(dir,'rebackup.db'));checks++;
 const descriptors=Object.fromEntries(Object.entries(tables).map(([t,rows])=>[t,rows.map(row=>t in ACTIVITY_COLUMNS?{key:ACTIVITY_KEYS[t].map(k=>row[k]),values:row}:row)]));
 for(const [name,keys]of [['activity_events_event_id_index',['event_id']],['activity_events_command_index',['ledger_id','command_id','command_ordinal']]])descriptors[name]=tables.activity_events.map((r,i)=>({key:keys.map(k=>r[k]),rowid:i+1})).sort((a,b)=>{for(let i=0;i<a.key.length;i++){const d=typeof a.key[i]==='number'?a.key[i]-b.key[i]:a.key[i]<b.key[i]?-1:a.key[i]>b.key[i]?1:0;if(d)return d;}return 0;});
 const run=async(modify=(t,i,v)=>v,limit=128)=>{const plans=new Map(),pages=new Map();let calls=0,maxCheckpoint=0,maxOperations=0;const io={source:{snapshotId:'activity-v4',async describe(t,i){calls++;return modify(t,i,structuredClone(descriptors[t][i]??null));},async read(){throw Error('No external source body');}},plans:{async get(k){return structuredClone(plans.get(k)??null);},async put(k,v){plans.set(k,structuredClone(v));}},sink:{async write(offset,b){if(pages.has(offset))assert.deepEqual(pages.get(offset),b);pages.set(offset,b.slice());},async read(offset,length){const out=new Uint8Array(length);for(let n=0;n<length;){const base=Math.floor((offset+n)/4096)*4096,part=pages.get(base),local=offset+n-base,take=Math.min(length-n,part.length-local);out.set(part.subarray(local,local+take),n);n+=take;}return out;}}};
 let cp=createSQLiteBackupCheckpoint('activity-v4',4096,true,true,true),steps=0;while(cp.phase!=='done'){const result=await stepSQLiteBackup(cp,io,{maxInputBytes:4096,maxOutputBytes:4096,maxOperations:limit});maxOperations=Math.max(maxOperations,result.work.operations);assert(result.work.operations<=limit,'operation budget exceeded');cp=JSON.parse(JSON.stringify(result.checkpoint));maxCheckpoint=Math.max(maxCheckpoint,JSON.stringify(cp).length);assert(++steps<20000);}
 return {cp,steps,maxCheckpoint,maxOperations,calls,bytes:Buffer.concat([...pages].sort((a,b)=>a[0]-b[0]).map(p=>Buffer.from(p[1])))};};
 const resumed=await run();assert.deepEqual(resumed.bytes,expected);assert.deepEqual(resumed.cp.summary.counts,summary.counts);assert(resumed.maxCheckpoint<32768);checks++;
 const small=await run((t,i,v)=>v,32);assert.deepEqual(small.bytes,expected);checks++;
 for(const mutation of [
  (t,i,v)=>t==='activity_events_event_id_index'&&i===0?{...v,rowid:v.rowid===1?2:1}:v,
  (t,i,v)=>t==='activity_events_command_index'&&i===521?{key:['extra'],rowid:1}:v,
  (t,i,v)=>t==='activity_events'&&i===1?{...v,values:{...v.values,sequence:3},key:[v.key[0],3]}:v,
  (t,i,v)=>t==='activity_accounts'&&i===0?{...v,values:{...v.values,membership_id:'f'.repeat(32)}}:v,
  (t,i,v)=>t==='activity_events'&&i===0?{...v,key:['f'.repeat(32),1]}:v,
 ]){await assert.rejects(run(mutation));checks++;}
 for(const mutate of [
  r=>{r.activity_events[0].source_sha256='invalid';},r=>{r.activity_events[0].occurred_at='2020-02-30T00:00:00Z';},r=>{r.activity_events[1].event_id=r.activity_events[0].event_id;},r=>{r.activity_accounts[0].membership_id='f'.repeat(32);},r=>{r.activity_events[1].sequence=3;},r=>{r.activity_memberships[0].closed_at=null;r.activity_memberships[0].close_reason='restore';},
 ]){const bad=structuredClone(tables);mutate(bad);let published=false;await assert.rejects(new SQLiteBackupWriter().write({...source,activity:Object.fromEntries(Object.keys(ACTIVITY_COLUMNS).map(t=>[t,()=>bad[t]]))},{write(){},close(){published=true;}}));assert(!published);checks++;}
 let reads=0,published=false;await assert.rejects(new SQLiteBackupWriter().write({...source,activity:{...activity,activity_events(){return reads++?tables.activity_events.map(r=>({...r,source_bytes:r.source_bytes+1})):tables.activity_events;}}},{write(){},close(){published=true;}}),/changed/);assert(!published);checks++;
 const context={workspaceId:'activity-v4-fixture',memberId:'owner',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)},initial={hash:context.sessionHash,userId:context.userId,authSessionId:context.authSessionId,cacheBinding:context.cacheBinding,expiresAt:Date.now()+3600000,profile:{workspaceId:context.workspaceId,authSessionActive:true,member:{id:'owner',role:'owner',active:true}}};
 const items=Object.keys(ACTIVITY_COLUMNS).flatMap(table=>tables[table].map(value=>({type:'activity',table,value}))),fence={version:1,sha256:'d'.repeat(64)},cursorMap=new Map();let mode='valid',gates=0,disposed=0;
 const provider={async gate(){gates++;return {context,revision:1};},async exportPage(_context,_revision,c){const start=c?cursorMap.get(JSON.stringify(c)):0;assert(Number.isInteger(start));const selected=items.slice(start,start+7),next=start+7>=items.length?null:{phase:13,kind:'',id:JSON.stringify([String(start+7)]),offset:0,part:0,scope:'f'.repeat(64),contentRevision:4,portableFormat:4,activityFence:fence};if(next)cursorMap.set(JSON.stringify(next),start+7);const page={context,revision:1,contentRevision:4,portableFormat:4,activityFence:fence,items:selected,nextCursor:next};if(start&&mode==='changed')page.activityFence={version:1,sha256:'e'.repeat(64)};if(start&&mode==='downgrade'){delete page.portableFormat;delete page.activityFence;}if(!start&&mode==='upgrade'){delete page.portableFormat;delete page.activityFence;page.items=[];page.items=[{type:'meta',key:'fixture',part:0,parts:1,dataPart:'{}'}];}if(mode==='missing-content')delete page.contentRevision;if(mode==='runtime-field'&&start===0)page.items=selected.map((item,i)=>i?item:{...item,value:{...item.value,session_token:'neverportable'}});return page;}};
 const temporary={async create(){let pieces=[],raw;return {async append(b){pieces.push(b.slice());},async finish(){raw=Buffer.concat(pieces);return raw.length;},async read(offset,length){return raw.slice(offset,offset+length);},async dispose(){disposed++;pieces=[];raw=null;}};}};
 const api=createBackup({provider,storage:{async readChunk(){throw Error('No cloud bodies');}},authorize:async()=>initial,temporary});const request=()=>api.handle(new Request('https://fixture.invalid/api/backup'),'/api/backup',initial);
 const response=await request();assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);assert(gates>100&&disposed===1);checks++;
 for(const [failure,status]of [['changed',409],['downgrade',409],['upgrade',409],['missing-content',503],['runtime-field',503]]){mode=failure;cursorMap.clear();await assert.rejects(request(),error=>error.status===status&&!error.message.includes('neverportable'),failure);checks++;}
 console.log(JSON.stringify({ok:true,checks,bytes:expected.length,steps:resumed.steps,maxCheckpoint:resumed.maxCheckpoint,maxOperations:resumed.maxOperations,smallBudgetSteps:small.steps,oracle:oracle.trim(),cloudDeployment:false}));
}finally{await rm(dir,{recursive:true,force:true});}
