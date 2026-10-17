import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteBackupWriter,PROVENANCE_COLUMNS} from '../functions/_shared/sqlite-backup.ts';
import {createSQLiteBackupCheckpoint,stepSQLiteBackup} from '../functions/_shared/sqlite-backup-resumable.ts';
const enc=new TextEncoder(),stamp='2026-10-17T01:02:03.123456+00:00';
const make=(kind,id,data)=>({kind,id,data:JSON.stringify({id,...data}),created_at:stamp,updated_at:stamp});
const rows=[make('database','db',{name:'DB',properties:[{id:'title',type:'title'}]}),make('page','page',{title:'한글 😀',blocks:[]}),make('row','row',{database_id:'db',properties:{title:'Row'}})];
const history=[{kind:'page',id:'page',generation:'a'.repeat(32),creator_id:'deleted actor 😀',creator_cause:'human',editor_id:'inactive actor',edited_at:stamp,editor_cause:'automation',manager_id:'historical manager',manager_at:stamp},{kind:'row',id:'row',generation:'b'.repeat(32),creator_id:null,creator_cause:'unknown',editor_id:null,edited_at:null,editor_cause:'unknown',manager_id:null,manager_at:null}];
const source=(provenance=history)=>({entities:()=>rows,meta:()=>[],chunks:()=>[],provenance:()=>provenance});
const dir=await mkdtemp(join(tmpdir(),'fountain-backup-history-'));let checks=0;
try{
 const writes=[];const summary=await new SQLiteBackupWriter().write(source(),{write(bytes){writes.push(bytes);}});assert.equal(summary.counts.content_provenance,2);const expected=Buffer.concat(writes);await writeFile(join(dir,'history.db'),expected);checks++;
 const oracle=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',`import json,sqlite3,sys
from fountain.backup import inspect_backup,restore_backup
from fountain.core import Store
from fountain.content_index import ContentIndex,INDEX_DEFINITIONS
p=sys.argv[1];info=inspect_backup(p);c=sqlite3.connect(p)
assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}=={'entities','meta','attachment_chunks','content_provenance'}
assert c.execute("SELECT sql FROM sqlite_master WHERE name='content_provenance'").fetchone()[0]==INDEX_DEFINITIONS['content_provenance']
assert c.execute('SELECT creator_id,editor_id,manager_id FROM content_provenance WHERE id="page"').fetchone()==('deleted actor 😀','inactive actor','historical manager')
before=c.execute('SELECT * FROM content_provenance ORDER BY kind,id').fetchall();c.close()
restore_backup(p,sys.argv[2]);s=Store(sys.argv[2]);ContentIndex(s).initialize();after=s.db.execute('SELECT * FROM content_provenance ORDER BY kind,id').fetchall();assert all(row in after for row in before);assert len(after)==3;(s.close())
print(json.dumps({'nativeSQLite':True,'historyRows':len(before),'trustedRestoreAndRebuild':True}))`,join(dir,'history.db'),join(dir,'restored.db')],{encoding:'utf8',cwd:new URL('../../',import.meta.url)});assert.equal(oracle.status,0,oracle.stderr);checks++;
 const maps=new Map(),pages=new Map();const io={source:{snapshotId:'history-v2',async describe(table,i){if(table==='content_provenance')return history[i]??null;if(table!=='entities')return null;const r=rows[i];return r?{...r,data:{ref:'entities:'+i,size:enc.encode(r.data).length,type:'text'}}:null;},async read(ref,offset,length){return enc.encode(rows[Number(ref.split(':')[1])].data).slice(offset,offset+length);}},plans:{async get(k){return structuredClone(maps.get(k)??null);},async put(k,v){maps.set(k,structuredClone(v));}},sink:{async write(offset,bytes){if(pages.has(offset))assert.deepEqual(bytes,pages.get(offset));pages.set(offset,bytes.slice());},async read(offset,length){const out=new Uint8Array(length);for(let at=0;at<length;){const base=Math.floor((offset+at)/4096)*4096,b=pages.get(base),local=offset+at-base;assert(b);const n=Math.min(length-at,b.length-local);out.set(b.subarray(local,local+n),at);at+=n;}return out;}}};
 let cp=createSQLiteBackupCheckpoint('history-v2',4096,true),steps=0,replayed=false;
 while(cp.phase!=='done'){const result=await stepSQLiteBackup(cp,io,{maxInputBytes:128,maxOutputBytes:4096,maxOperations:32});if(!replayed&&cp.phase==='emit-rows'){const again=await stepSQLiteBackup(cp,io,{maxInputBytes:128,maxOutputBytes:4096,maxOperations:32});assert.deepEqual(again,result);replayed=true;}cp=JSON.parse(JSON.stringify(result.checkpoint));assert(++steps<1000);}
 assert.equal(cp.version,2);assert.equal(cp.summary.counts.content_provenance,2);const actual=Buffer.concat([...pages].sort((a,b)=>a[0]-b[0]).map(x=>Buffer.from(x[1])));assert.deepEqual(actual,expected);checks++;
 const legacy=createSQLiteBackupCheckpoint('history-v2');assert.equal(legacy.version,1);await assert.rejects(stepSQLiteBackup({...legacy,table:3},io),/checkpoint layout/);checks++;
 for(const patch of [{generation:'bad'},{creator_cause:null},{editor_id:null},{manager_at:null},{creator_id:'bad\0actor'},{id:'missing'}]){let closed=false,aborted=false;await assert.rejects(new SQLiteBackupWriter().write(source([{...history[0],...patch}]),{write(){},close(){closed=true;},abort(){aborted=true;}}));assert(!closed&&aborted);checks++;}
 let calls=0,closed=false,aborted=false;await assert.rejects(new SQLiteBackupWriter().write({...source(),provenance(){return calls++?history.map(x=>({...x,creator_id:x.creator_id?'changed actor':null})):history;}},{write(){},close(){closed=true;},abort(){aborted=true;}}),/changed/);assert(!closed&&aborted);checks++;
 const tiny=await new SQLiteBackupWriter().write({...source(),provenance:()=>[]},{write(){}});assert.equal(tiny.counts.content_provenance,0);checks++;
 console.log(JSON.stringify({ok:true,checks,steps,columns:PROVENANCE_COLUMNS.length,legacyVersion:1,historyVersion:2,oracle:JSON.parse(oracle.stdout)}));
}finally{await rm(dir,{recursive:true,force:true});}
