/** Source extraction + memory transition checks ONLY. No PostgreSQL, Storage,
 * deployed worker, grant authorization or Cron execution is claimed here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const old=readFileSync(new URL('../migrations/20261016140754_fountain_cloud_backup_manifest_batches.sql',import.meta.url),'utf8');
const sql=readFileSync(new URL('../migrations/20261016171214_fountain_cloud_maintenance_backup.sql',import.meta.url),'utf8');
const first=old.indexOf(" IF p_action IN('gc_claim','gc_check','gc_done','gc_observed') THEN"),last=old.indexOf(" IF p_action='artifact' THEN",first),branch=old.slice(first,last);
const legacyCheck=branch.match(/^   RETURN jsonb_build_object\('allowed'.*\n/m)[0];
const section=(name)=>sql.slice(sql.indexOf('CREATE FUNCTION fountain_cloud.'+name+'('),sql.indexOf('REVOKE ALL ON FUNCTION fountain_cloud.'+name+'('));
test('entire current owner RPC is byte-identical except delegation of its GC branch',()=>{
 const expected=old.slice(old.indexOf('CREATE OR REPLACE FUNCTION fountain_cloud.backup_jobs_rpc')).replace(branch," IF p_action IN('gc_claim','gc_check','gc_done','gc_observed') THEN\n  RETURN fountain_cloud.backup_gc_locked(v_ws,v_identity,p_action,p_payload,v_now_ms);\n END IF;\n");
 assert.equal(sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION fountain_cloud.backup_jobs_rpc')),expected);
 assert(expected.indexOf('fountain_cloud.store_context(p_context)')<expected.indexOf('fountain_cloud.backup_gc_locked'));
 assert(expected.includes("ELSE v_authz:=fountain_cloud.backup_authorize(p_context);END IF;"));
});
test('shared cleanup body preserves ALL legacy phase/pending/quota/source guards plus explicit fence deltas',()=>{
 let extracted=sql.slice(sql.indexOf(' -- BEGIN EXTRACTED_GC_BRANCH\n')+' -- BEGIN EXTRACTED_GC_BRANCH\n'.length,sql.indexOf(' -- END EXTRACTED_GC_BRANCH'));
 extracted=extracted.replace(/   -- BEGIN BACKUP_FENCE_CLAIM_DELTA\n[\s\S]*?   -- END BACKUP_FENCE_CLAIM_DELTA\n/,'').replace(/   -- BEGIN BACKUP_FENCE_CHECK_DELTA\n[\s\S]*?   -- END BACKUP_FENCE_CHECK_DELTA\n/,legacyCheck).replace(/   -- BEGIN BACKUP_FENCE_DONE_DELTA\n[\s\S]*?   -- END BACKUP_FENCE_DONE_DELTA\n/,'');
 assert.equal(extracted,branch);
 const claim=section('backup_gc_locked');assert(claim.indexOf("IF FOUND THEN RETURN jsonb_build_object('pending'")<claim.indexOf('backup_job_reserve'));
 assert(claim.indexOf('DELETE FROM fountain_cloud.backup_job_source')<claim.indexOf('-- BEGIN BACKUP_FENCE_CLAIM_DELTA'));
 assert(claim.includes("EXCEPTION WHEN SQLSTATE 'PT409' THEN\n    RETURN jsonb_build_object('parts','[]'::jsonb,'lease',NULL)"));
 for(const table of ['source','plan','receipts'])assert(claim.includes('DELETE FROM fountain_cloud.backup_job_'+table)&&claim.includes('LIMIT 256'));
});
test('DELETE creates one common retirement; observe and current check never create tombstones',()=>{
 assert(section('backup_gc_fences').includes('fountain_cloud.storage_gc_fence('));
 assert(section('backup_gc_delete_allowed').includes('fountain_cloud.storage_gc_delete_allowed('));
 for(const name of ['maintenance_backup_check','maintenance_backup_observed','maintenance_backup_done','backup_gc_delete_allowed'])assert(!section(name).includes('fountain_cloud.storage_gc_fence('),name);
 assert(section('maintenance_backup_observed').includes("'gc_observed'"));assert(section('maintenance_backup_done').includes("'gc_done'"));
 assert(section('maintenance_backup_check').includes('fountain_cloud.backup_gc_delete_allowed('));
});
test('claims are bounded fair SQL-only resources, without a manufactured human or grant',()=>{
 const hooks=sql.slice(0,sql.indexOf('CREATE OR REPLACE FUNCTION fountain_cloud.backup_jobs_rpc'));
 assert(!/INSERT INTO\s+(?:auth\.|fountain_cloud\.service_|fountain_private\.identity_mapping)/i.test(hooks));assert(!/cron\.schedule|net\.http_post|p_context|authSessionId|cacheBinding/.test(hooks));
 assert(section('maintenance_backup_claim').indexOf('SET gc_sequence=v_sequence')<section('maintenance_backup_claim').indexOf('fountain_cloud.backup_gc_locked'));
 assert(section('maintenance_backup_claim').includes("jsonb_build_object('mode','none')"));assert(section('maintenance_backup_claim').includes('32768'));
 assert(section('maintenance_backup_fingerprint').includes('NOT BETWEEN 1 AND 16'));assert(section('maintenance_backup_fingerprint').includes('count(DISTINCT i.value)'));
 assert(section('backup_gc_fences').includes('LIMIT 17'));assert(section('backup_gc_delete_allowed').includes('LIMIT 17'));
 assert(section('maintenance_backup_check').includes("p.state='pending'"));assert(section('maintenance_backup_check').includes("p.gc_lease=p_claim->>'lease'"));
 for(const name of ['backup_gc_fences','backup_gc_delete_allowed','backup_gc_locked','maintenance_backup_fingerprint','maintenance_backup_claim','maintenance_backup_check','maintenance_backup_observed','maintenance_backup_done'])assert(new RegExp('REVOKE ALL ON FUNCTION fountain_cloud\\.'+name+'\\([^;]+FROM PUBLIC,anon,authenticated,service_role;').test(sql));
});

const clone=structuredClone,hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
class Model {
 constructor(){this.jobs=[];this.retired=new Set();this.live=new Set();this.objects=new Set();}
 add(id,{pending=false,sources=0,size=256}={}){const job={id,seq:0,version:1,phase:'cancelled',reserved:size,outputs:pending?size:0,sources,plans:300,receipts:300,part:{id:id+'-part',storage:id+'-object',state:pending?'pending':'published',size,lease:null}};this.jobs.push(job);return job;}
 fp(job){return hash({id:job.id,version:job.version,phase:job.phase,reserved:job.reserved,part:job.part});}
 pinned(job){return this.live.has(job.part.storage)||job.sources>0;}
 claim(){const job=[...this.jobs].filter(j=>j.part.state!=='removed'||j.sources||j.plans||j.receipts).sort((a,b)=>a.seq-b.seq||a.id.localeCompare(b.id))[0];if(!job)return {mode:'none'};job.seq=Math.max(0,...this.jobs.map(j=>j.seq))+1;
  if(job.part.state==='pending')return {mode:'observe',job:job.id,fp:this.fp(job)};
  job.reserved-=job.outputs;job.outputs=0;job.sources=Math.max(0,job.sources-256);job.plans=Math.max(0,job.plans-256);job.receipts=Math.max(0,job.receipts-256);
  if(job.part.state==='removed')return {mode:'none'};job.part.state='gc';job.part.lease??='stable-'+job.id;
  if(this.pinned(job))return {mode:'none'};this.retired.add(job.part.storage);return {mode:'delete',job:job.id,fp:this.fp(job),lease:job.part.lease};
 }
 check(claim){const job=this.jobs.find(j=>j.id===claim.job);return !!job&&this.fp(job)===claim.fp&&(claim.mode==='observe'?job.part.state==='pending':job.part.state==='gc'&&job.part.lease===claim.lease&&this.retired.has(job.part.storage)&&!this.pinned(job));}
 observe(claim){assert(this.check(claim));const job=this.jobs.find(j=>j.id===claim.job);assert(this.objects.has(job.part.storage),'Missing object is unknown, not absent-proof');job.part.state='published';job.outputs=0;}
 done(claim){assert(this.check(claim));const job=this.jobs.find(j=>j.id===claim.job);job.part.state='removed';job.reserved-=job.part.size;}
 relink(storage){if(this.retired.has(storage))throw Error('permanently retired');this.live.add(storage);}
}
test('MODEL: missing publisher stays quarantined; one verified observation precedes DELETE and quota release',()=>{
 const model=new Model(),job=model.add('a',{pending:true});let claim=model.claim();assert.equal(claim.mode,'observe');assert.equal(model.retired.size,0);assert.equal(job.reserved,256);assert.equal(job.sources,0);assert.throws(()=>model.observe(claim));assert.equal(job.part.state,'pending');assert.equal(job.reserved,256);
 model.objects.add(job.part.storage);model.observe(claim);assert.equal(job.reserved,256);assert.equal(job.part.state,'published');assert.equal(model.retired.size,0);claim=model.claim();assert.equal(claim.mode,'delete');model.done(claim);assert.equal(job.reserved,0);assert.throws(()=>model.done(claim));assert.equal(job.reserved,0);
});
test('MODEL: blocked own source pins retain progress and rotate rather than roll back forever',()=>{
 const model=new Model(),blocked=model.add('a',{sources:300}),other=model.add('b');assert.equal(model.claim().mode,'none');assert.equal(blocked.sources,44);assert.equal(blocked.reserved,256);assert.equal(model.retired.size,0);
 const second=model.claim();assert.equal(second.job,'b');model.done(second);const next=model.claim();assert.equal(next.job,'a');assert.equal(blocked.sources,0);assert.equal(next.mode,'delete');model.done(next);assert.equal(blocked.reserved,0);assert.equal(other.reserved,0);
});
test('MODEL: frozen job/part lease changes and new pins deny work; retirement prevents later relink',()=>{
 for(const mutate of [job=>job.version++,job=>job.phase='ready',job=>job.part.lease='foreign',job=>job.part.size++]){const model=new Model(),job=model.add('a'),claim=model.claim();assert(model.check(claim));mutate(job);assert(!model.check(claim));}
 const model=new Model(),job=model.add('a'),claim=model.claim();assert.throws(()=>model.relink(job.part.storage),/retired/);model.live.add(job.part.storage);assert(!model.check(claim));assert.equal(job.reserved,256);
});
