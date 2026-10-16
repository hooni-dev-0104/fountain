/** Source/behavior contracts only. NO PostgreSQL parser, trigger/lock execution,
 * hosted data, physical Storage or real Auth proof is claimed by this suite. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations/20261016171044_fountain_cloud_storage_gc_fences.sql',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../migrations/20261016171211_fountain_cloud_storage_gc_fresh_reads.sql',import.meta.url),'utf8');
const prior=readFileSync(new URL('../migrations/20261016100057_fountain_cloud_atomic_store.sql',import.meta.url),'utf8');
const currentBackup=readFileSync(new URL('../migrations/20261016140754_fountain_cloud_backup_manifest_batches.sql',import.meta.url),'utf8');
const functions=[...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION ((?:fountain_cloud|public)\.[a-z_]+)\(([^]*?)\) RETURNS ([^]*?)\nLANGUAGE ([^]*?)AS \$\$([^]*?)\$\$;/g)];
function body(name){const value=functions.findLast(match=>match[1]==='fountain_cloud.'+name);assert(value,name);return value[5].replace(/--[^\n]*/g,'');}
const CHUNK=4194304,MAX=5000000000,copy=structuredClone,hash='a'.repeat(64);
const chunk=(id,offset=0,size=CHUNK)=>({version:1,attachmentId:id,offset,size,sha256:hash});
function denied(status=409){throw Object.assign(Error('Model typed denial'),{status});}
function validateManifest(m,id,offset=null,size=null,max=CHUNK){if(!m||Array.isArray(m)||Object.keys(m).sort().join(',')!=='attachmentId,offset,sha256,size,version'||m.version!==1||typeof m.attachmentId!=='string'||m.attachmentId!==id||!Number.isSafeInteger(m.offset)||m.offset<0||m.offset>=MAX||m.offset%CHUNK||!Number.isSafeInteger(m.size)||m.size<=0||m.size>max||m.offset+m.size>MAX||!/^\w{64}$/.test(m.sha256)||!/^[a-f0-9]{64}$/.test(m.sha256)||(offset!==null&&m.offset!==offset)||(size!==null&&m.size!==size))denied();}
function validateLayout(data,id,partial=false){if(!data||typeof data!=='object'||data.id!==id||!Number.isSafeInteger(data.size)||data.size<0||data.size>MAX||!Array.isArray(data.cloud_chunks)||data.cloud_chunks.length>1193||Buffer.byteLength(JSON.stringify(data))>16777216)denied();const physical=data.storage_id??id;if(typeof physical!=='string'||!physical.length||partial&&physical!==id||data.cloud_chunks.length>Math.ceil(data.size/CHUNK)||!partial&&data.cloud_chunks.length!==Math.ceil(data.size/CHUNK))denied();let end=0;for(const [index,m]of data.cloud_chunks.entries()){validateManifest(m,physical,index*CHUNK,Math.min(CHUNK,data.size-index*CHUNK));end=Math.min(data.size,(index+1)*CHUNK);}if(partial&&data.offset!==end)denied();return physical;}
class FenceModel {
 constructor(){this.rows=[];this.retired=new Set();this.locks=new Map();this.gc=new Map();this.quota=0;this.isolation='read committed';}
 rc(){if(this.isolation!=='read committed')denied();}
 key(ws,id){return JSON.stringify([ws,id]);}
 begin(ws,owner){if(this.locks.has(ws)&&this.locks.get(ws)!==owner)denied();this.locks.set(ws,owner);}
 end(ws,owner){if(this.locks.get(ws)===owner)this.locks.delete(ws);}
 pinned(ws,id){this.rc();return this.rows.some(row=>row.ws===ws&&row.id===id&&(row.kind==='upload'||row.kind==='overlay'||row.kind==='cloud-attachment'||row.kind==='source-extra'||row.kind==='source-cloud'||row.kind==='part'&&['pending','published'].includes(row.state)));}
 reference(row,owner=Symbol('reference')){this.rc();this.begin(row.ws,owner);try{if(this.retired.has(this.key(row.ws,row.id)))denied();this.rows.push(copy(row));}finally{this.end(row.ws,owner);}}
 fence(ws,id,owner=Symbol('gc')){this.rc();this.begin(ws,owner);try{if(this.pinned(ws,id))denied();this.retired.add(this.key(ws,id));return true;}finally{this.end(ws,owner);}}
 allowed(ws,id){this.rc();return this.retired.has(this.key(ws,id))&&!this.pinned(ws,id);}
 manual(actor,ws,id,batch){if(!actor.current)denied(401);const gc=this.gc.get(this.key(ws,id));if(!gc||!actor.owner&&gc.owner_id!==actor.id)denied(404);if(gc.pending!==null&&gc.pending!==undefined)denied();if(!Array.isArray(gc.cloud_chunks)||!gc.cloud_chunks.length||gc.cloud_chunks.length>1193||batch.length!==Math.min(100,gc.cloud_chunks.length)||JSON.stringify(batch)!==JSON.stringify(gc.cloud_chunks.slice(0,100)))denied();for(const m of batch)validateManifest(m,id);return {allowed:this.fence(ws,id)};}
}

test('applied base and fresh-read delta preserve the backup RPC and add no namespace activation',()=>{
 assert(currentBackup.includes('source_file_count'));assert(currentBackup.includes('file_ordinal'));assert(!/CREATE OR REPLACE FUNCTION fountain_cloud\.backup_jobs_rpc|CREATE EXTENSION|cron\.|net\.|INSERT INTO fountain_cloud\.(?:scheduler|maintenance)_registry/.test(sql));assert(sql.includes('ENABLE ROW LEVEL SECURITY'));assert(sql.includes('FORCE ROW LEVEL SECURITY'));assert(sql.includes('PRIMARY KEY(workspace_id,storage_id)'));assert(!/DELETE FROM fountain_cloud\.storage_gc_tombstones|ON DELETE CASCADE/.test(sql));
});
test('all helper execution is private and only the real-person wrapper is service-role callable',()=>{
 assert(functions.length>=12);for(const f of functions.filter(f=>f[1].startsWith('fountain_cloud.'))){assert(f[4].includes('search_path=pg_catalog'));assert(new RegExp('REVOKE ALL ON FUNCTION '+f[1].replaceAll('.','\\.')+'\\([^;]+FROM PUBLIC,anon,authenticated,service_role;').test(sql),f[1]);}
 assert(sql.includes('public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb) TO service_role'));assert(sql.includes('public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated'));assert(!/GRANT[^;]*fountain_private|GRANT[^;]*(?:SELECT|INSERT|DELETE|UPDATE)/.test(sql));
});
test('reference guards use exactly the existing workspace key with NOWAIT, never blocking row-to-workspace or changing caller RLS scope',()=>{
 const guard=body('storage_gc_reference');assert(prior.includes("convert_to('fountain:workspace:'||p_workspace_id,'UTF8')"));assert(guard.includes("pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||p_workspace_id,'UTF8')),'hex'),1,16))::bit(64)::bigint)"));assert(!guard.includes('store_lock('));assert(!guard.includes('set_config('));assert(guard.includes("ERRCODE='PT409'"));assert(guard.includes('t.workspace_id=p_workspace_id AND t.storage_id=p_storage_id'));
 for(const name of ['entity','source','part'])assert(sql.includes('BEFORE INSERT OR UPDATE ON '+(name==='entity'?'fountain_private.entities':name==='source'?'fountain_cloud.backup_job_source':'fountain_cloud.backup_job_parts')));
});
test('six scalar pin lookups include both backup-source phases regardless of job expiry and match partial indexes',()=>{
 const pins=body('storage_gc_pinned');assert.equal((pins.match(/EXISTS\(SELECT/g)||[]).length,6);assert(!/jsonb_array_elements|jsonb_each|unnest|backup_jobs|expires_at|phase/.test(pins));for(const expected of ["e.kind='upload' AND e.id=p_storage_id","e.kind='attachment' AND e.data ? 'cloud_chunks'","e.kind='attachment_cloud'","s.extra ? 'cloud_chunks'","s.cloud->>'attachmentId'=p_storage_id","p.state IN('pending','published')"])assert(pins.includes(expected),expected);
 for(const expression of ["COALESCE(data->>'storage_id',id)","COALESCE(extra->>'storage_id',extra->>'id',descriptor->>'id')","cloud->>'attachmentId'","manifest->>'attachmentId'"])assert(sql.includes(expression));assert.equal((sql.match(/CREATE INDEX storage_pin_/g)||[]).length,5);
});
test('retirement always rechecks current pins, is idempotent, and authoritative rechecks never mint another tombstone',()=>{
 const fence=body('storage_gc_fence'),check=body('storage_gc_delete_allowed');assert(fence.indexOf('store_lock(')<fence.indexOf('storage_gc_pinned('));assert(fence.indexOf('storage_gc_pinned(')<fence.indexOf('INSERT INTO'));assert(fence.includes('ON CONFLICT(workspace_id,storage_id) DO NOTHING'));assert(check.includes('EXISTS')&&check.includes('AND NOT fountain_cloud.storage_gc_pinned'));assert(!/INSERT|UPDATE|DELETE|store_lock|set_config/.test(check));
 const m=new FenceModel();assert.equal(m.allowed('w','file'),false);assert(m.fence('w','file'));assert(m.fence('w','file'));assert.equal(m.retired.size,1);assert.equal(m.allowed('w','file'),true);m.rows.push({ws:'w',id:'file',kind:'source-extra'});assert.equal(m.allowed('w','file'),false);assert.throws(()=>m.fence('w','file'),e=>e.status===409);
});
test('repeatable-read/serializable snapshots fail closed before references, pin proofs or permanent retirement',()=>{
 for(const name of ['storage_gc_reference','storage_gc_pinned','storage_gc_delete_allowed','storage_gc_fence','upload_gc_fence']){const source=body(name);assert(source.includes("current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'"),name);assert(source.indexOf("current_setting('transaction_isolation')")<Math.min(...['SELECT 1 FROM','SELECT e.data','INSERT INTO','pg_try_advisory'].map(key=>source.indexOf(key)).filter(index=>index>=0)),name);}
 for(const isolation of ['repeatable read','serializable','read uncommitted']){const m=new FenceModel();m.isolation=isolation;for(const action of [()=>m.reference({ws:'w',id:'f',kind:'upload'}),()=>m.pinned('w','f'),()=>m.allowed('w','f'),()=>m.fence('w','f')])assert.throws(action,e=>e.status===409);assert.equal(m.retired.size,0);assert.equal(m.rows.length,0);}
 for(const name of ['storage_gc_pinned','storage_gc_delete_allowed'])assert(functions.findLast(f=>f[1]==='fountain_cloud.'+name)[4].includes('VOLATILE SECURITY INVOKER'));
});
test('all materialized source rows keep bytes pinned through cancellation/expiry until actual row cleanup',()=>{
 for(const kind of ['upload','overlay','cloud-attachment','source-extra','source-cloud'])for(const state of ['active','expired','cancelled']){const m=new FenceModel();m.reference({ws:'w',id:'f',kind,state});assert.throws(()=>m.fence('w','f'),e=>e.status===409);assert.equal(m.retired.size,0);m.rows=[];assert(m.fence('w','f'));}
});
test('artifact pending/publication are pins; gc/removed and SQL BYTEA-only attachments are not',()=>{
 for(const state of ['pending','published','gc','removed']){const m=new FenceModel();m.rows.push({ws:'w',id:'f',kind:'part',state});assert.equal(m.pinned('w','f'),['pending','published'].includes(state));}
 const m=new FenceModel();m.rows.push({ws:'w',id:'f',kind:'legacy-sql-bytearray'});assert(m.fence('w','f'));const event=body('storage_gc_entity_event');assert(event.includes("NEW.kind='attachment' AND NEW.data ? 'cloud_chunks'"));assert(event.includes('ELSE RETURN NEW'));assert(body('storage_gc_part_event').includes("IF NEW.state NOT IN('pending','published') THEN RETURN NEW"));
});
test('NOWAIT model rejects late relink while GC owns a workspace and permanently after its last delete authorization',()=>{
 const m=new FenceModel();m.begin('w','collector');assert.throws(()=>m.reference({ws:'w',id:'f',kind:'source-cloud'}),e=>e.status===409);m.end('w','collector');m.fence('w','f');assert(m.allowed('w','f'));assert.throws(()=>m.reference({ws:'w',id:'f',kind:'upload'}),e=>e.status===409);assert(m.allowed('w','f'));assert.equal(m.rows.length,0);
 const writer=new FenceModel();writer.reference({ws:'w',id:'f',kind:'source-extra'});assert.throws(()=>writer.fence('w','f'),e=>e.status===409);assert.equal(writer.retired.size,0);
});
test('retirement is workspace-specific and pure metadata/ref-release transitions remain possible',()=>{
 const m=new FenceModel();m.fence('a','f');m.reference({ws:'b',id:'f',kind:'upload'});assert(m.pinned('b','f'));assert.equal(m.allowed('a','f'),true);const gc={cloud_chunks:[chunk('f')],pending:null};gc.cloud_chunks=[];assert.deepEqual(gc,{cloud_chunks:[],pending:null});assert(!body('storage_gc_entity_event').includes("NEW.kind='upload_gc'"));assert(!body('storage_gc_source_event').includes('NEW.cloud IS NULL THEN RAISE'));
});
test('write-time layout validation binds physical IDs, 4MiB boundaries/5GB/1193 counts and logical 16MiB byte bounds',()=>{
 const layout=body('storage_gc_layout'),manifest=body('storage_gc_manifest');for(const expected of ['v_count>1193','v_total>5000000000','octet_length(p_data::text)>16777216','v_index::bigint*4194304','v_offset<>v_end'])assert(layout.includes(expected));for(const expected of ["p_manifest-ARRAY['version','attachmentId','offset','size','sha256']","p_manifest->>'attachmentId' IS DISTINCT FROM p_id",'mod(v_offset,4194304)<>0','v_size<>trunc(v_size)','v_offset+v_size>5000000000'])assert(manifest.includes(expected));
 const chunks=Array.from({length:Math.ceil(MAX/CHUNK)},(_,i)=>chunk('physical',i*CHUNK,Math.min(CHUNK,MAX-i*CHUNK))),data={id:'logical',storage_id:'physical',size:MAX,cloud_chunks:chunks};assert.equal(chunks.length,1193);assert.equal(validateLayout(data,'logical'),'physical');assert.equal(validateLayout({id:'empty',size:0,cloud_chunks:[]},'empty'),'empty');
 for(const patch of [{size:MAX+1},{cloud_chunks:[...chunks,chunk('physical')]},{cloud_chunks:[chunk('wrong')]},{cloud_chunks:[chunk('physical',1)]},{cloud_chunks:[{...chunk('physical'),size:1.5}]},{cloud_chunks:[{...chunk('physical'),credential:'x'}]}])assert.throws(()=>validateLayout({...data,...patch},'logical'));
 assert.throws(()=>validateLayout({id:'x',size:0,cloud_chunks:[],irrelevant:'x'.repeat(16777217)},'x'));assert.equal(validateLayout({id:'u',size:CHUNK*2,offset:CHUNK,cloud_chunks:[chunk('u')]},'u',true),'u');assert.throws(()=>validateLayout({id:'u',storage_id:'other',size:CHUNK,offset:CHUNK,cloud_chunks:[chunk('other')]},'u',true));
});
test('backup guards bind materialized cloud ranges and unique artifact IDs, preserving legacy SQL source rows',()=>{
 const source=body('storage_gc_source_event'),part=body('storage_gc_part_event');assert(source.includes("IF NEW.extra ? 'cloud_chunks'"));assert(source.includes("NEW.table_name<>'entities'"));assert(source.includes("NEW.table_name<>'attachment_chunks'"));assert(source.includes('NEW.descriptor->\'data\'->>\'size\''));assert(source.includes('v_id,v_offset,v_size'));assert(part.includes("'backup-'||NEW.job_id||'-'||NEW.id"));assert(part.includes('v_id,0,NULL,262144'));assert(part.includes('4096'));assert(!source.includes('raw IS NOT NULL'));
});
test('owner cleanup checks actual human auth first, exact prefix/owner/pending/null and never publishes an alternate capability',()=>{
 const manual=body('upload_gc_fence');assert(manual.indexOf('store_context(p_context)')<manual.indexOf('SELECT e.data'));assert(manual.includes("v_actor->>'role' IS DISTINCT FROM 'owner'"));assert(manual.includes("v_gc->'owner_id' IS DISTINCT FROM to_jsonb(v_actor->>'id')"));assert(manual.includes("COALESCE(v_gc->'pending','null'::jsonb)<>'null'::jsonb"));assert(manual.includes('v_count<>least(100,v_total)'));assert(manual.includes("p_manifests->v_index IS DISTINCT FROM v_gc->'cloud_chunks'->v_index"));assert(manual.includes("RETURN jsonb_build_object('allowed',true)"));assert(!/DELETE FROM|reserved_bytes.*SET|service_context|MaintenanceContext/.test(manual));
 const m=new FenceModel(),gc={owner_id:'alice',pending:null,cloud_chunks:[chunk('f')]};m.gc.set(m.key('w','f'),gc);assert.throws(()=>m.manual({current:false,owner:true},'w','f',gc.cloud_chunks),e=>e.status===401);assert.throws(()=>m.manual({current:true,owner:false,id:'bob'},'w','f',gc.cloud_chunks),e=>e.status===404);assert.deepEqual(m.manual({current:true,owner:false,id:'alice'},'w','f',gc.cloud_chunks),{allowed:true});
});
test('an unresolved late POST or active backup pin cannot release quota or authorize a physical delete',()=>{
 const m=new FenceModel(),gc={owner_id:'alice',pending:{attempt_id:'single-post',offset:0},cloud_chunks:[chunk('f')]};m.gc.set(m.key('w','f'),gc);m.quota=CHUNK*2;const before=copy(gc);assert.throws(()=>m.manual({current:true,owner:true},'w','f',gc.cloud_chunks));assert.deepEqual(gc,before);assert.equal(m.retired.size,0);assert.equal(m.quota,CHUNK*2);
 gc.pending=null;m.reference({ws:'w',id:'f',kind:'source-extra',job:'expired'});assert.throws(()=>m.manual({current:true,owner:true},'w','f',gc.cloud_chunks));assert.equal(m.retired.size,0);m.rows=[];assert.deepEqual(m.manual({current:true,owner:true},'w','f',gc.cloud_chunks),{allowed:true});assert.equal(m.quota,CHUNK*2);assert.throws(()=>m.reference({ws:'w',id:'f',kind:'cloud-attachment'}));
});
test('manual batches are exactly first100 confirmed manifests, cannot substitute IDs, trim proof or resurrect a retired ref',()=>{
 const m=new FenceModel(),chunks=Array.from({length:101},(_,i)=>chunk('f',i*CHUNK)),gc={owner_id:'alice',pending:null,cloud_chunks:chunks};m.gc.set(m.key('w','f'),gc);const actor={current:true,owner:true};assert.throws(()=>m.manual(actor,'w','f',chunks.slice(0,16)));assert.throws(()=>m.manual(actor,'w','f',[{...chunks[0],attachmentId:'other'},...chunks.slice(1,100)]));assert(m.manual(actor,'w','f',chunks.slice(0,100)).allowed);gc.cloud_chunks=chunks.slice(100);assert(m.manual(actor,'w','f',gc.cloud_chunks).allowed);assert.equal(m.retired.size,1);assert.throws(()=>m.reference({ws:'w',id:'f',kind:'source-cloud'}));
});
test('operator negative SQL remains credential-free and makes no positive retirement or fixture writes',()=>{
 const script=readFileSync(new URL('./cloud-storage-gc-fences-negative.sql',import.meta.url),'utf8');assert(script.includes('negative QA only'));assert(script.includes('has_function_privilege'));assert(script.includes('relforcerowsecurity'));assert(!/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/gmi.test(script));assert(script.includes("storage_gc_fence(v_ws,NULL)"));assert(script.includes("public.fountain_cloud_upload_gc_fence('{}'::jsonb"));
});
