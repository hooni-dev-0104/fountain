/** Focused source/bound fixtures only: no SQL parser, PostgreSQL execution,
 * row-lock proof, physical Storage deletion or real 5GB file is claimed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations/20261016171648_fountain_cloud_maintenance_upload.sql',import.meta.url),'utf8');
const functions=[...sql.matchAll(/CREATE FUNCTION (fountain_cloud\.[a-z_]+)\(([^]*?)\) RETURNS ([^]*?)\nLANGUAGE ([^]*?)AS \$\$([^]*?)\$\$;/g)];
const body=name=>{const found=functions.find(m=>m[1]==='fountain_cloud.'+name);assert(found,name);return found[5]};
const claim=body('maintenance_upload_claim'),check=body('maintenance_upload_check'),valid=body('maintenance_upload_valid'),observed=body('maintenance_upload_observed'),done=body('maintenance_upload_done');
const statements=sql.replace(/AS \$\$[^]*?\$\$;/g,'AS <body>;').replace(/--[^\n]*/g,'');

test('five private hooks/helpers do not install or manufacture authority',()=>{
 assert.equal(functions.length,5);
 for(const f of functions){assert(f[4].includes('SECURITY INVOKER SET search_path=pg_catalog'));assert(sql.includes('ALTER FUNCTION '+f[1]+'('));assert(new RegExp('REVOKE ALL ON FUNCTION[^;]*'+f[1].replaceAll('.','\\.')+'\\(').test(sql));}
 assert(!/^(?:INSERT|UPDATE|DELETE|SELECT|DO)\b/gmi.test(statements));assert(!/GRANT EXECUTE|CREATE(?: OR REPLACE)? FUNCTION public\.|auth\.users|auth\.sessions|store_context\(|service_context\(/.test(sql));
});
test('both keysets use immutable columns, fixed upper bounds and a matching partial index',()=>{
 assert(sql.includes('created_at COLLATE "C",id COLLATE "C") WHERE kind IN(\'upload\',\'upload_gc\')'));
 assert(claim.includes("'upload_expiry' ELSE 'upload_gc'"));assert(claim.includes("THEN 32 ELSE 1 END"));assert(claim.includes('LIMIT v_limit'));
 assert(claim.includes("'after',v_position,'through',v_through"));assert(claim.includes('v_seen<v_limit OR v_position=v_through'));
 assert(claim.includes('e.id COLLATE "C")<='));assert(claim.includes('e.id COLLATE "C")>'));
 assert.equal(claim.match(/e\.kind=v_kind AND e\.kind IN\('upload','upload_gc'\)/g)?.length,2,'generic plans must prove the partial-index predicate');
});
test('fairness advances even for malformed, oversized, pinned and missing-publication work',()=>{
 assert(claim.indexOf("'after',v_position")<claim.indexOf('IF v_bytes>1126400'));
 assert(claim.indexOf('SET cursors=v_cursors')<claim.indexOf('storage_gc_pinned('));
 assert(claim.includes("v_cursors->>'upload_turn'='gc'"));assert(claim.includes("ARRAY['upload_gc','upload']"));assert(claim.includes("ARRAY['upload','upload_gc']"));
 assert(claim.includes("EXCEPTION WHEN SQLSTATE 'PT409' THEN RETURN jsonb_build_object('mode','none')"));
});
test('normal processing is 1.1MiB, with at most one separate oversized logical probe before stop',()=>{
 assert(claim.includes('v_budget integer:=1126400'));assert(claim.includes('pg_column_size(e.data)>1126400'));assert(claim.includes('octet_length(e.data::text)'));assert(claim.includes('v_budget:=v_budget-v_bytes'));
 const candidates=claim.slice(claim.indexOf('FOR v_row IN'),claim.indexOf('LOOP',claim.indexOf('FOR v_row IN')));
 assert(!candidates.includes('octet_length')&&!candidates.includes('e.data'),'SPI candidate prefetch must not evaluate logical sizes');
 const oversized=claim.slice(claim.indexOf('IF v_bytes>1126400'),claim.indexOf('ELSIF v_bytes>v_budget'));
 assert(oversized.includes('SET cursors=v_cursors')&&oversized.includes("RETURN jsonb_build_object('mode','none')"));
 const deferred=claim.slice(claim.indexOf('ELSIF v_bytes>v_budget'),claim.indexOf('END IF;v_budget:=v_budget-v_bytes'));
 assert(deferred.includes('ARRAY[v_key],v_before')&&deferred.includes("RETURN jsonb_build_object('mode','none')"));
 assert(valid.includes('octet_length(p_data::text)>1126400'));assert(valid.includes('v_count>1193'));assert(valid.includes("EXCEPTION WHEN data_exception OR SQLSTATE 'PT409' THEN RETURN false"));
});

// Deliberately small keyset/budget MODEL of the branches locked above. This does
// not execute the SQL or model Auth, quota, Storage publication or row locks.
const CAP=1126400;
function scanModel(rows,state,budget=CAP,{legacyAdvance=false,limit=32}={}){
 const round=state.through??rows.at(-1)?.id??null,eligible=rows.filter(r=>(state.after===null||r.id>state.after)&&r.id<=round).slice(0,limit);
 const processed=[],probed=[];let after=state.after;
 for(const row of eligible){const before=after;after=row.id;probed.push(row.id);
  if(row.bytes>CAP)return {state:{after,through:round},processed,probed,stopped:true};
  if(row.bytes>budget){if(legacyAdvance)continue;return {state:{after:before,through:round},processed,probed,stopped:true};}
  budget-=row.bytes;processed.push(row.id);
 }
 return {state:eligible.length<limit||after===round?{after:null,through:null}:{after,through:round},processed,probed,stopped:false};
}
test('MODEL: first oversized compressed legacy row stops probing and advances to later good work',()=>{
 const rows=[{id:'a-huge',bytes:16*1024*1024},{id:'b-good',bytes:100},{id:'c-good',bytes:100}];
 const first=scanModel(rows,{after:null,through:null});assert.deepEqual(first.probed,['a-huge']);assert.equal(first.processed.length,0);assert.equal(first.state.after,'a-huge');
 const next=scanModel(rows,first.state);assert.deepEqual(next.processed,['b-good','c-good']);assert.equal(next.state.after,null);
});
test('MODEL: insufficient remaining budget defers a legal large expired upload instead of starving',()=>{
 const rows=[{id:'a-unexpired',bytes:200_000},{id:'b-expired-large',bytes:1_000_000}];
 let state={after:null,through:null};const old=[];for(let i=0;i<4;i++){const run=scanModel(rows,state,CAP,{legacyAdvance:true});old.push(...run.processed);state=run.state;}assert(!old.includes('b-expired-large'));
 const first=scanModel(rows,{after:null,through:null});assert.equal(first.state.after,'a-unexpired');const next=scanModel(rows,first.state);assert.deepEqual(next.processed,['b-expired-large']);
});
test('MODEL: expiry-first and GC-first alternation cannot trap large A behind unknown small B',()=>{
 const gc=[{id:'a-large-confirmed',bytes:1_000_000},{id:'b-small-unknown',bytes:100}];
 function turns(legacyAdvance){let state={after:null,through:null};const selected=[];for(let i=0;i<6;i++){const budget=i%2===0?CAP-200_000:CAP,run=scanModel(gc,state,budget,{legacyAdvance,limit:1});state=run.state;selected.push(...run.processed);}return selected;}
 assert(!turns(true).includes('a-large-confirmed'));assert(turns(false).includes('a-large-confirmed'));
});
test('maximum legal 5GB manifest metadata with 160-codepoint Unicode IDs fits the byte bound',()=>{
 const id='😀'.repeat(160),size=5_000_000_000,cloud_chunks=[];
 for(let offset=0;offset<size;offset+=4194304)cloud_chunks.push({version:1,attachmentId:id,offset,size:Math.min(4194304,size-offset),sha256:'a'.repeat(64)});
 assert.equal(cloud_chunks.length,1193);
 const row={id,owner_id:'가족',page_id:null,reserved_bytes:size,cloud_chunks,pending:null,reason:'upload_expired',created_at:'2026-10-17T00:00:00.000000+00:00',updated_at:'2026-10-17T00:00:00.000000+00:00'};
 // PostgreSQL jsonb::text uses separator spaces; key order does not change size.
 const pgText=value=>Array.isArray(value)?'['+value.map(pgText).join(', ')+']':value&&typeof value==='object'?'{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+pgText(v)).join(', ')+'}':JSON.stringify(value);
 const bytes=Buffer.byteLength(pgText(row));assert(bytes>900_000&&bytes<=1126400,`metadata bytes ${bytes}`);
 const frozen={mode:'delete',resourceId:id,fingerprint:'b'.repeat(64),manifests:cloud_chunks.slice(0,16)};assert(Buffer.byteLength(pgText(frozen))<32768);
 assert.equal(cloud_chunks.at(-1).offset+cloud_chunks.at(-1).size,size);
});
test('expired upload retirement preserves full reservations/pending and completed attachments',()=>{
 assert(claim.includes("v_data->'completed'='false'::jsonb AND(jsonb_array_length"));assert(claim.includes("'reserved_bytes',v_data->'size'"));assert(claim.includes("'pending',COALESCE(v_data->'pending','null'::jsonb)"));
 assert(claim.includes("'op','delete','kind','upload'"));assert(!claim.includes("'kind','attachment'"));assert(!claim.includes("'kind','attachment_cloud'"));
 assert(claim.includes("e.kind='upload_gc' AND e.id=v_row.id) THEN CONTINUE"));assert(claim.includes('store_apply_changes_locked('));
});
test('validators preserve unknown publishers and reject ill-typed/overlapping layouts',()=>{
 assert(valid.includes("jsonb_typeof(p_data->'completed') IS DISTINCT FROM 'boolean'"));assert(valid.includes('v_offset<=v_last OR v_offset<v_end'));assert(valid.includes("v_pending-ARRAY['offset','size','sha256','attempt_id']<>'{}'"));
 assert(valid.includes('storage_gc_layout(p_data,p_id,true)'));assert(valid.includes('storage_gc_manifest(v_item,p_id)'));assert(valid.includes('v_offset>=v_size OR v_offset<>trunc(v_offset)'));
});
test('observe freezes exact pending intent without retiring its physical ID',()=>{
 const observeBranch=claim.slice(claim.indexOf("v_mode:='observe'"),claim.indexOf("ELSE\n    SELECT",claim.indexOf("v_mode:='observe'")));
 assert(observeBranch.includes("'offset',(v_pending->>'offset')::numeric::bigint"));assert(!observeBranch.includes('storage_gc_fence'));
 assert(claim.includes("'pendingAttempt',v_pending->'attempt_id'"));assert(claim.includes("encode(sha256(convert_to(v_gc::text,'UTF8')),'hex')"));
 assert(check.includes("v_pending->'attempt_id'=p_claim->'pendingAttempt'"));assert(check.includes('NOT fountain_cloud.storage_gc_pinned('));
});
test('outgoing manifests normalize integer scale without changing the full original fingerprint',()=>{
 assert(claim.includes("'offset',(v_pending->>'offset')::numeric::bigint,'size',(v_pending->>'size')::numeric::bigint"));
 assert(claim.includes("'offset',(j.value->>'offset')::numeric::bigint,'size',(j.value->>'size')::numeric::bigint"));
 assert(claim.includes("convert_to(v_gc::text,'UTF8')"));assert(check.includes("p_claim->'manifests'=v_prefix"));
});
test('delete claims fence only confirmed prefix16, checks are read-only and match all-source hash',()=>{
 assert(claim.includes('WHERE j.ordinality<=16'));assert(claim.includes("storage_gc_fence(p_workspace_id,v_gc->>'id')"));assert(check.includes('storage_gc_delete_allowed('));assert(!check.includes('storage_gc_fence('));
 assert(check.includes("encode(sha256(convert_to(v_gc::text,'UTF8')),'hex') IS DISTINCT FROM p_claim->>'fingerprint'"));assert(check.includes("p_claim->'manifests'=v_prefix"));
 assert(functions.find(m=>m[1]==='fountain_cloud.maintenance_upload_check')[4].includes('VOLATILE'),'fingerprint reads after workspace-lock wait use fresh RC snapshots');
});
test('observed appends one verified chunk and clears pending without releasing reserved bytes',()=>{
 assert(observed.includes("p_claim->>'mode' IS DISTINCT FROM 'observe'"));assert(observed.includes("'cloud_chunks',(v_gc->'cloud_chunks')||(p_claim->'manifests'),'pending','null'::jsonb"));assert(!observed.includes('reserved_bytes'));assert(observed.includes("'previousCreatedAt',v_created"));
 assert(observed.indexOf('maintenance_upload_check(')<observed.indexOf('store_apply_changes_locked('));
});
test('done rechecks before exact-prefix mutation and releases quota only at confirmed final deletion',()=>{
 assert(done.includes("p_claim->>'mode' IS DISTINCT FROM 'delete'"));assert(done.includes("j.ordinality>jsonb_array_length(p_claim->'manifests')"));assert(done.includes("IF jsonb_array_length(v_remaining)=0 THEN v_change:=jsonb_build_object('op','delete','kind','upload_gc'"));
 assert(done.includes("'op','put','kind','upload_gc'"));assert(done.indexOf('maintenance_upload_check(')<done.indexOf('store_apply_changes_locked('));assert(!done.includes('_backup_storage_reserved'));assert(!done.includes('DELETE FROM fountain_private'));
});
test('resource changes use the current kernel revision, leaving exact ACK receipts to the broker',()=>{
 for(const f of [claim,observed,done])assert(f.includes("store_apply_changes_locked(p_workspace_id,fountain_cloud.store_revision(p_workspace_id,'_entity_revision')"));
 assert(!sql.includes('maintenance_receipts'));assert(!sql.includes('service_commit('));assert(!sql.includes('DELETE FROM fountain_cloud.storage_gc_tombstones'));
});
