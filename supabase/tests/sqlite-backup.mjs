/** Generated SQLite is opened/modified/restored by the independent native engine.
 * Node filesystem access is test-only; production writer imports no Node runtime. */
import assert from 'node:assert/strict';
import {mkdtemp,open,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SQLiteBackupWriter,SQLiteBackupError} from '../functions/_shared/sqlite-backup.ts';

const root=fileURLToPath(new URL('../../',import.meta.url)),python=process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',time='2026-10-16T00:00:00.123000+00:00';
const directory=await mkdtemp(join(tmpdir(),'fountain-sqlite-writer-'));
const binarySize=9*1024*1024,chunkSize=4*1024*1024;
function block(offset,size){const result=new Uint8Array(size);for(let i=0;i<size;i++){const n=offset+i;result[i]=(n*31+(n>>>8))&255;}return result;}
const hash=createHash('sha256');for(let offset=0;offset<binarySize;offset+=65536)hash.update(block(offset,Math.min(65536,binarySize-offset)));const digest=hash.digest('hex');
const entity=(kind,id,data)=>({kind,id,data:JSON.stringify({...data,id}),created_at:time,updated_at:time});
let checks=0;
async function verify(name,source,pageSize,attachments=[]){
 const filename=join(directory,name+'.db'),file=await open(filename,'wx',0o600);let writes=0,maxWrite=0,closed=false,aborted=false;
 try{
  const summary=await new SQLiteBackupWriter({pageSize}).write(source,{async write(bytes){assert(bytes instanceof Uint8Array);maxWrite=Math.max(maxWrite,bytes.length);let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset);assert(result.bytesWritten>0);offset+=result.bytesWritten;}writes++;},async close(){await file.sync();closed=true;},abort(){aborted=true;}});
  assert(closed&&!aborted&&maxWrite<=65536);assert.equal(writes,summary.pages);await file.close();
  const result=spawnSync(python,[root+'supabase/tests/sqlite-backup-oracle.py',filename,JSON.stringify({...summary,attachments})],{encoding:'utf8',maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);checks++;
  return summary;
 }finally{await file.close().catch(()=>{});}
}
function arraySource(entities=[],meta=[],chunks=[]){return {entities:()=>entities,meta:()=>meta,chunks:()=>chunks};}
try{
 for(const pageSize of [4096,65536])await verify('empty-'+pageSize,arraySource(),pageSize);
 const ids=['__proto__','constructor','a','a\u007f','a😀','a\ue000','한글','😀'.repeat(160)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),small=ids.map(id=>entity('page',id,{title:'한글 😀',text:'x'.repeat(id==='a'?14000:20)}));
 small.unshift(entity('credential','legacy',{salt:'legacy-only',password_hash:'hash-retained-for-offline-restore'}));small.push(entity('session','private',{raw:'must never reach output'}),entity('upload','pending',{raw:'must never reach output'}));
 for(const pageSize of [4096,65536]){await verify('unicode-'+pageSize,arraySource(small,[{key:'local_cache_binding',data:'"private"'},{key:'settings',data:{name:'가족'}},{key:'workspace_id',data:'"fixture"'}]),pageSize);assert(!(await readFile(join(directory,'unicode-'+pageSize+'.db'))).includes(Buffer.from('must never reach output')));checks++;}
 const shortBytes=new Uint8Array([1,2,3]),shortHash=createHash('sha256').update(shortBytes).digest('hex'),attachment=entity('attachment','small',{storage:'chunks',name:'small.dat',mime:'application/octet-stream',size:3,sha256:shortHash});
 await verify('small-blob',arraySource([attachment],[],[{attachment_id:'small',offset:0,data:shortBytes}]),4096,[['small',3,shortHash]]);
 const overflowBytes=700000,overflowDigest=createHash('sha256');for(let n=0;n<overflowBytes;n+=65536)overflowDigest.update(block(n,Math.min(65536,overflowBytes-n)));const overflowSHA=overflowDigest.digest('hex');
 await verify('64k-overflow',arraySource([entity('attachment','wide',{storage:'chunks',name:'wide.bin',mime:'application/octet-stream',size:overflowBytes,sha256:overflowSHA})],[],[{attachment_id:'wide',offset:0,data:{size:overflowBytes,*open(){for(let n=0;n<overflowBytes;n+=65536)yield block(n,Math.min(65536,overflowBytes-n));}}}]),65536,[['wide',overflowBytes,overflowSHA]]);
 let blobReads=0,entityPasses=0;
 const large={
  async *entities(){entityPasses++;yield entity('attachment','binary',{storage:'chunks',name:'binary.dat',mime:'application/octet-stream',size:binarySize,sha256:digest});yield entity('credential','legacy',{salt:'legacy',password_hash:'offline-only'});for(let i=0;i<100000;i++)yield entity('page','row'+String(i).padStart(6,'0'),{title:'행 '+i+' 😀',blocks:[{id:'b',type:'paragraph',text:'본문 '+i}]});yield entity('session','private',{token:'not-exported'});},
  *meta(){yield {key:'attachment_file_root',data:{id:'never-exported'}};yield {key:'settings',data:{name:'가족'}};yield {key:'workspace_id',data:'"fixture"'};},
  *chunks(){for(let offset=0;offset<binarySize;offset+=chunkSize){const start=offset,size=Math.min(chunkSize,binarySize-offset);yield {attachment_id:'binary',offset,data:{size,async *open(){blobReads++;for(let i=0;i<size;i+=65536)yield block(start+i,Math.min(65536,size-i));}}};}yield {attachment_id:'orphan',offset:0,data:new Uint8Array([1,2,3])};},
 };
 const largeSummary=await verify('large-100k-9m',large,4096,[['binary',binarySize,digest]]);assert.equal(entityPasses,2);assert.equal(blobReads,6);assert.equal(largeSummary.counts.entities,100002);assert.equal(largeSummary.counts.attachment_chunks,3);checks++;
 // First-pass validation never starts output. Second-pass drift aborts PRIVATE
 // staging and must never call close/publish, including same-size content edits.
 for(const source of [arraySource([entity('page','b',{}),entity('page','a',{})]),arraySource([entity('page','a',{}),entity('page','a',{})]),arraySource([{...entity('page','a',{}),data:'{"id":"other"}'}])]){
  let writes=0,abort=0;await assert.rejects(new SQLiteBackupWriter().write(source,{write(){writes++;},abort(){abort++;}}),SQLiteBackupError);assert.equal(writes,0);assert.equal(abort,1);checks++;
 }
 for(const source of [arraySource([attachment]),arraySource([attachment],[],[{attachment_id:'small',offset:1,data:shortBytes}]),arraySource([attachment],[],[{attachment_id:'small',offset:0,data:new Uint8Array([1,2])}]),arraySource([attachment],[],[{attachment_id:'small',offset:0,data:new Uint8Array([3,2,1])}]),arraySource([attachment],[],[{attachment_id:'small',offset:0,data:{size:3,*open(){yield new Uint8Array([1,2]);}}}])]){
  let writes=0,abort=0;await assert.rejects(new SQLiteBackupWriter().write(source,{write(){writes++;},abort(){abort++;}}),SQLiteBackupError);assert.equal(writes,0);assert.equal(abort,1);checks++;
 }
 let reads=0,binaryClose=0,binaryAbort=0;
 const changedBlob=arraySource([attachment],[],[{attachment_id:'small',offset:0,data:{size:3,*open(){reads++;yield reads===1?shortBytes:new Uint8Array([3,2,1]);}}}]);await assert.rejects(new SQLiteBackupWriter().write(changedBlob,{write(){},close(){binaryClose++;},abort(){binaryAbort++;}}),SQLiteBackupError);assert.equal(reads,2);assert.equal(binaryClose,0);assert.equal(binaryAbort,1);checks++;
 let passes=0,writes=0,closes=0,aborts=0;
 const changed={entities(){passes++;return [entity('page','a',{title:passes===1?'first':'other'})];},meta:()=>[],chunks:()=>[]};
 await assert.rejects(new SQLiteBackupWriter().write(changed,{write(){writes++;},close(){closes++;},abort(){aborts++;}}),error=>error instanceof SQLiteBackupError&&/changed/.test(error.message));assert(writes>0);assert.equal(closes,0);assert.equal(aborts,1);checks++;
 let aborted=false;await assert.rejects(new SQLiteBackupWriter().write(arraySource([entity('page','a',{})]),{write(){throw Error('PRIVATE_SOURCE_TOKEN');},abort(){aborted=true;}}),error=>error instanceof SQLiteBackupError&&!error.message.includes('PRIVATE_SOURCE_TOKEN'));assert(aborted);checks++;
 let output=0;await assert.rejects(new SQLiteBackupWriter({maxPlanBytes:1024*1024}).write({...large,chunks:()=>[]},{write(){output++;}}),/bounded memory/);assert.equal(output,0);checks++;
 console.log(JSON.stringify({ok:true,checks,sqlite:'native Python sqlite3 integrity/restore/ON CONFLICT',rows:largeSummary.counts.entities,binaryBytes:binarySize,binaryReads:6,pageSizes:[4096,65536],maxSinkWriteBytes:65536,cloudDeployment:false}));
}finally{await rm(directory,{recursive:true,force:true});}
