/** Production adapter over actual inbound/RPC loopback HTTP. Auth, grant rows,
 * locks and atomic SQL transitions below are a MODEL, not PostgreSQL/GoTrue QA. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createGrantAdmin,GrantAdminError} from '../functions/_shared/grant-admin.ts';
import {errorResponse} from '../functions/_shared/http.ts';
import {storeContext} from '../functions/_shared/transaction.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';

const secret='sb_secret_grant_admin_fixture_only',workspace='grant-admin-loopback',origin='https://family.fixture.invalid';
const hash=value=>createHash('sha256').update(value).digest('hex'),copy=structuredClone;
const auth=(id,char)=>({hash:char.repeat(64),userId:id==='alice'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222',authSessionId:randomUUID(),cacheBinding:char.repeat(32),expiresAt:Date.now()+86400000,profile:{workspaceId:workspace,authSessionActive:true,member:{id,name:id,email:id+'@fixture.invalid',role:'owner',active:true}}});
const precise=value=>value.replace(/(?:\.(\d+))?Z$/,(_,fraction)=>'.'+(fraction??'').padEnd(6,'0')+'Z');
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
async function fixture(t){
 const contexts=new Map([['A',auth('alice','a')],['B',auth('bob','b')]]),grants=new Map(),audits=[],calls=[];let now=Date.now(),revision=1,lostCreate=false,lostAction=null,failAudit=false,responseFault=null,afterRPC=null;
 const fail=(status=409)=>{const error=Error('PRIVATE SQL '+secret);error.status=status;throw error;};
 const stamp=()=>precise(new Date(now).toISOString());
 function owner(context){const current=[...contexts.values()].find(value=>canonicalJSON(storeContext(value))===canonicalJSON(context));if(!current||current.expiresAt<=now||!current.profile.authSessionActive||!current.profile.member.active)fail(401);if(current.profile.member.role!=='owner')fail(403);return current;}
 function metadata(g){return {id:g.id,purpose:g.purpose,version:g.version,enabled:g.enabled,issuer_member_id:g.member_id,created_at:g.created_at.replace(/\.(\d{3})\d*Z$/,'.$1Z'),expires_at:g.expires_at,pending_until:g.pending_until,token_hash:g.token_hash,creation_digest:g.creation_digest,auth_user_id:g.auth_user_id};}
 function commit(g,operation,actor){if(failAudit)fail(503);grants.set(g.id,copy(g));audits.push({kind:'scim',id:g.id,operation,actor:actor.profile.member.id});revision++;}
 function rpc(context,action,payload){
  const actor=owner(context);
  if(action==='list'){
   const cursor=payload.cursor;if(cursor&&cursor.workspaceId!==workspace)fail(400);
   const rows=[...grants.values()].filter(g=>g.purpose==='scim'&&(!cursor||precise(g.created_at)>precise(cursor.created_at)||precise(g.created_at)===precise(cursor.created_at)&&g.id>cursor.id)).sort((a,b)=>precise(a.created_at).localeCompare(precise(b.created_at))||a.id.localeCompare(b.id));
   const selected=rows.slice(0,payload.limit),last=selected.at(-1);return {tokens:selected.map(metadata),next_cursor:rows.length>payload.limit?{created_at:last.created_at,id:last.id}:null,private_debug:secret};
  }
  const old=grants.get(payload.id);
  if(action==='create'){
   const digest=hash(canonicalJSON({expires_at:payload.expires_at}));
   if(old){if(old.purpose!=='scim'||old.creation_digest!==digest||old.member_id!==actor.profile.member.id||old.auth_user_id!==actor.userId||old.expires_at!==payload.expires_at)fail();return {grant:metadata(old),created:false};}
   if(payload.expires_at!==null&&Date.parse(payload.expires_at)<=now)fail(400);
   const g={id:payload.id,purpose:'scim',version:1,enabled:false,member_id:actor.profile.member.id,auth_user_id:actor.userId,token_hash:payload.token_hash,expires_at:payload.expires_at,created_at:stamp(),creation_digest:digest,pending_until:new Date(now+900000).toISOString()};commit(g,'create',actor);return {grant:metadata(g),created:true};
  }
  if(!old||old.purpose!=='scim')fail(404);
  if(action==='activate'){
   if(old.version!==1||!old.creation_digest||!old.pending_until||old.member_id!==actor.profile.member.id||old.auth_user_id!==actor.userId||old.token_hash!==payload.token_hash)fail(403);
   if(old.expires_at&&Date.parse(old.expires_at)<=now)fail();if(old.enabled)return {grant:metadata(old)};if(Date.parse(old.pending_until)<=now)fail();const g={...old,enabled:true};commit(g,'activate',actor);return {grant:metadata(g)};
  }
  if(action==='revoke'){if(!old.enabled&&old.version>1)return {grant:metadata(old)};if(old.version>=Number.MAX_SAFE_INTEGER)fail();const g={...old,enabled:false,version:old.version+1};commit(g,'revoke',actor);return {grant:metadata(g)};}
  fail(400);
 }
 const rpcServer=http.createServer(async(req,res)=>{try{
  assert.equal(req.url,'/rest/v1/rpc/fountain_cloud_service_grant_admin');assert.equal(req.method,'POST');assert.equal(req.headers.apikey,secret);assert.equal(req.headers.authorization,undefined);
  let raw='';for await(const bytes of req)raw+=bytes;const body=JSON.parse(raw);calls.push(copy(body));const result=rpc(body.p_context,body.p_action,body.p_payload);
  if(afterRPC)await afterRPC(body);if(lostCreate&&body.p_action==='create'||lostAction===body.p_action){lostCreate=false;lostAction=null;res.destroy();return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(responseFault?responseFault(result):JSON.stringify(result));
 }catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({message:error.message,private_secret:secret}));}});
 rpcServer.listen(0,'127.0.0.1');await once(rpcServer,'listening');const rpcOrigin='http://127.0.0.1:'+rpcServer.address().port;
 const server=http.createServer(async(req,res)=>{try{
  const cookie=req.headers.cookie??'',session=contexts.get(cookie),captured=copy(session);if(!session)throw new GrantAdminError(401);
  const adapter=createGrantAdmin({supabaseUrl:rpcOrigin,serviceKey:secret,workspaceId:workspace,origins:[origin],clock:()=>now,authorize:async()=>{const current=contexts.get(cookie);if(!current)throw new GrantAdminError(401);return copy(current);}});
  const pieces=[];for await(const bytes of req)pieces.push(bytes);const url='https://api.fixture.invalid'+req.url,request=new Request(url,{method:req.method,headers:req.headers,...(pieces.length?{body:Buffer.concat(pieces)}:{})});
  const response=await adapter.handle(request,new URL(url).pathname,captured);if(!response){res.writeHead(404);res.end();return;}res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){const response=errorResponse(error);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const api='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{for(const server of [serverRef,rpcServer]){server.closeAllConnections();await new Promise(done=>server.close(done));}});const serverRef=server;
 async function request(method,path='/api/scim/tokens',body,options={}){const response=await fetch(api+path,{method,headers:{Cookie:options.cookie??'A',Origin:options.origin??origin,'X-Fountain-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'}),...options.headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:response.status,body:value,text,headers:response.headers};}
 return {request,grants,audits,calls,contexts,get revision(){return revision;},get now(){return now;},set now(value){now=value;},set lostCreate(value){lostCreate=value;},set lostAction(value){lostAction=value;},set failAudit(value){failAudit=value;},set responseFault(value){responseFault=value;},set afterRPC(value){afterRPC=value;}};
}
const metadataKeys=['id','purpose','version','enabled','issuer_member_id','created_at','expires_at','pending_until'].sort();
function safe(result){for(const value of [secret,'token_hash','creation_digest','auth_user_id','PRIVATE SQL'])assert(!result.text.includes(value));if(result.body.grant)assert.deepEqual(Object.keys(result.body.grant).sort(),metadataKeys);}
async function create(f,body={transaction_id:randomUUID()},options){const result=await f.request('POST',undefined,body,options);assert.equal(result.status,201,result.text);safe(result);assert.match(result.body.token,/^[A-Za-z0-9_-]{43}$/);return result.body;}

test('first creation is inactive; only the first response contains the cryptographic token; activation retries have one audit',async t=>{
 const f=await fixture(t),created=await create(f),id=created.grant.id,stored=f.grants.get(id);assert.equal(stored.enabled,false);assert.equal(stored.version,1);assert.equal(stored.token_hash,hash(created.token));assert(!JSON.stringify(stored).includes(created.token));assert.equal(f.revision,2);
 const retry=await f.request('POST',undefined,{transaction_id:id});assert.equal(retry.status,200);assert.equal(retry.body.token_unavailable,true);assert(!retry.body.token);safe(retry);assert.equal(f.audits.length,1);
 for(let i=0;i<2;i++){const active=await f.request('POST','/api/scim/tokens/'+id+'/activate',{token:created.token});assert.equal(active.status,200,active.text);assert.equal(active.body.grant.enabled,true);safe(active);}
 assert.deepEqual(f.audits.map(v=>v.operation),['create','activate']);assert.equal(f.revision,3);assert(!JSON.stringify(f.calls).includes(created.token));assert(!JSON.stringify(f.audits).includes(stored.token_hash));
 const list=await f.request('GET');assert.equal(list.status,200);assert.equal(list.body.tokens.length,1);safe(list);assert(!list.text.includes(created.token));assert.equal(list.headers.get('cache-control'),'no-store');
});
test('lost create ACK leaves inactive hash and exact retry cannot issue a replacement credential',async t=>{
 const f=await fixture(t),id=randomUUID();f.lostCreate=true;const failed=await f.request('POST',undefined,{transaction_id:id});assert.equal(failed.status,503);safe(failed);const saved=copy(f.grants.get(id));assert(saved&&!saved.enabled);
 const retry=await f.request('POST',undefined,{transaction_id:id});assert.equal(retry.status,200);assert.equal(retry.body.token_unavailable,true);assert(!retry.body.token);assert.deepEqual(f.grants.get(id),saved);assert.equal(f.audits.length,1);
 const hashes=f.calls.filter(c=>c.p_action==='create').map(c=>c.p_payload.token_hash);assert.equal(hashes.length,2);assert.notEqual(hashes[0],hashes[1]);assert.equal(saved.token_hash,hashes[0]);
});
test('concurrent identical creates have one winner, one hash and one audit',async t=>{
 const f=await fixture(t),id=randomUUID(),results=await Promise.all([f.request('POST',undefined,{transaction_id:id}),f.request('POST',undefined,{transaction_id:id})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results.filter(r=>r.body.token).length,1);const winner=results.find(r=>r.body.token);assert.equal(f.grants.get(id).token_hash,hash(winner.body.token));assert.equal(f.audits.length,1);
});
test('different owner cannot adopt or activate pending grant, but can permanently revoke it',async t=>{
 const f=await fixture(t),created=await create(f),id=created.grant.id;
 for(const [method,path,body]of [['POST','/api/scim/tokens',{transaction_id:id}],['POST','/api/scim/tokens/'+id+'/activate',{token:created.token}]]){const denied=await f.request(method,path,body,{cookie:'B'});assert([403,409].includes(denied.status));safe(denied);}
 const revoked=await f.request('DELETE','/api/scim/tokens/'+id,undefined,{cookie:'B'});assert.equal(revoked.status,200);assert.equal(revoked.body.grant.version,2);assert.equal(revoked.body.grant.enabled,false);
 assert.equal((await f.request('DELETE','/api/scim/tokens/'+id)).status,200);assert.equal(f.audits.length,2);assert.equal((await f.request('POST','/api/scim/tokens/'+id+'/activate',{token:created.token})).status,403);
 const retry=await f.request('POST',undefined,{transaction_id:id});assert.equal(retry.status,200);assert.equal(retry.body.token_unavailable,true);assert.equal(retry.body.grant.version,2);
});
test('creation logical conflicts, expired or incorrect activation proof, historical grants and operational collisions fail closed',async t=>{
 const f=await fixture(t),expiry=new Date(f.now+60000).toISOString(),created=await create(f,{transaction_id:randomUUID(),expires_at:expiry}),id=created.grant.id;
 assert.equal((await f.request('POST',undefined,{transaction_id:id,expires_at:null})).status,409);assert.equal((await f.request('POST','/api/scim/tokens/'+id+'/activate',{token:Buffer.alloc(32,1).toString('base64url')})).status,403);
 f.now+=60001;assert.equal((await f.request('POST','/api/scim/tokens/'+id+'/activate',{token:created.token})).status,409);const replay=await f.request('POST',undefined,{transaction_id:id,expires_at:expiry});assert.equal(replay.status,200);assert.equal(replay.body.token_unavailable,true);
 const historic=randomUUID(),other=randomUUID();f.grants.set(historic,{...copy(f.grants.get(id)),id:historic,creation_digest:null,pending_until:null,expires_at:null,enabled:true});f.grants.set(other,{...copy(f.grants.get(id)),id:other,purpose:'automation'});
 assert.equal((await f.request('POST',undefined,{transaction_id:historic})).status,409);assert.equal((await f.request('POST','/api/scim/tokens/'+historic+'/activate',{token:created.token})).status,403);assert.equal((await f.request('DELETE','/api/scim/tokens/'+historic)).status,200);
 assert.equal((await f.request('POST',undefined,{transaction_id:other})).status,409);assert.equal((await f.request('DELETE','/api/scim/tokens/'+other)).status,404);
});
test('pending deadline blocks first activation; exact active proof may acknowledge without duplicate writes',async t=>{
 const f=await fixture(t),created=await create(f),active=await create(f);await f.request('POST','/api/scim/tokens/'+active.grant.id+'/activate',{token:active.token});const before=f.revision;f.now+=900001;
 assert.equal((await f.request('POST','/api/scim/tokens/'+created.grant.id+'/activate',{token:created.token})).status,409);assert.equal((await f.request('POST','/api/scim/tokens/'+active.grant.id+'/activate',{token:active.token})).status,200);assert.equal(f.revision,before);
});
test('lost activation and revocation acknowledgements retry exact terminal state without duplicate audits',async t=>{
 const f=await fixture(t),created=await create(f),path='/api/scim/tokens/'+created.grant.id;
 f.lostAction='activate';const failed=await f.request('POST',path+'/activate',{token:created.token});assert.equal(failed.status,503);assert.equal(f.grants.get(created.grant.id).enabled,true);safe(failed);
 const active=await f.request('POST',path+'/activate',{token:created.token});assert.equal(active.status,200);assert.equal(f.audits.length,2);
 f.lostAction='revoke';assert.equal((await f.request('DELETE',path)).status,503);assert.equal(f.grants.get(created.grant.id).version,2);assert.equal((await f.request('DELETE',path)).status,200);assert.equal(f.audits.length,3);assert.equal(f.revision,4);
});
test('real HTTP origin/header gates, exact keys, body limits, paths, query and methods reject without RPC',async t=>{
 const f=await fixture(t),before=()=>f.calls.length;
 for(const [method,path,body,options,status]of [
  ['POST','/api/scim/tokens',{transaction_id:randomUUID()},{origin:'https://evil.invalid'},403],
  ['POST','/api/scim/tokens',{transaction_id:randomUUID()},{headers:{'X-Fountain-Request':'0'}},403],
  ['GET','/api/scim/tokens?limit=101',undefined,{},400],['GET','/api/scim/tokens?limit=1&limit=2',undefined,{},400],['GET','/api/scim/tokens?unexpected=1',undefined,{},400],
  ['POST','/api/scim/tokens?limit=1',{transaction_id:randomUUID()},{},400],['POST','/api/scim/tokens',{transaction_id:randomUUID(),token_hash:'a'.repeat(64)},{},400],
  ['POST','/api/scim/tokens',{transaction_id:randomUUID(),purpose:'automation'},{},400],['POST','/api/scim/tokens',{transaction_id:randomUUID(),expires_at:'2027-02-30T00:00:00Z'},{},400],
  ['POST','/api/scim/tokens',' '.repeat(4097),{},413],['POST','/api/scim/tokens','[]',{},400],['PATCH','/api/scim/tokens',{}, {},405],['HEAD','/api/scim/tokens',undefined,{},405],
  ['POST','/api/scim/tokens/'+randomUUID()+'/activate',{token:'A'.repeat(42)+'B'},{},400],['DELETE','/api/scim/tokens/'+randomUUID(),{token:'secret'},{},400],
 ]){const count=before(),result=await f.request(method,path,body,options);assert.equal(result.status,status,JSON.stringify({method,path,result}));assert.equal(f.calls.length,count);safe(result);}
});
test('keyset pagination includes equal-millisecond historical rows, any UUID and workspace-bound cursors without silent truncation',async t=>{
 const f=await fixture(t),template=(await create(f)).grant;f.grants.clear();f.audits.length=0;
 for(let i=0;i<127;i++){const id='00000000-0000-7000-8000-'+i.toString(16).padStart(12,'0');f.grants.set(id,{...template,id,member_id:'alice',auth_user_id:f.contexts.get('A').userId,created_at:'2026-10-17T00:00:00.'+String(i).padStart(6,'0')+'Z',token_hash:'a'.repeat(64),creation_digest:null,pending_until:null});}
 const seen=[];let cursor=null;do{const result=await f.request('GET','/api/scim/tokens?limit=50'+(cursor?'&cursor='+cursor:''));assert.equal(result.status,200,result.text);assert(result.body.tokens.length<=50);for(const item of result.body.tokens){assert.deepEqual(Object.keys(item).sort(),metadataKeys);seen.push(item.id);}cursor=result.body.next_cursor;}while(cursor);
 assert.equal(seen.length,127);assert.equal(new Set(seen).size,127);const page=await f.request('GET','/api/scim/tokens?limit=1'),value=JSON.parse(Buffer.from(page.body.next_cursor,'base64url'));value.workspaceId='foreign';const forged=Buffer.from(JSON.stringify(value)).toString('base64url'),before=f.calls.length;assert.equal((await f.request('GET','/api/scim/tokens?cursor='+forged)).status,400);assert.equal(f.calls.length,before);
 assert.equal((await f.request('DELETE','/api/scim/tokens/'+seen[0])).status,200);
});
test('current owner, Auth binding and expiry are checked before any SQL, even exact replay',async t=>{
 const f=await fixture(t),created=await create(f),original=copy(f.contexts.get('A'));
 for(const update of [v=>v.profile.member.role='admin',v=>v.profile.member.active=false,v=>v.profile.authSessionActive=false,v=>v.expiresAt=f.now-1]){f.contexts.set('A',copy(original));update(f.contexts.get('A'));const count=f.calls.length,result=await f.request('POST',undefined,{transaction_id:created.grant.id});assert([401,403].includes(result.status));assert.equal(f.calls.length,count);safe(result);}f.contexts.delete('A');assert.equal((await f.request('GET')).status,401);
});
test('logout, demotion or new binding while create HTTP response waits cannot publish the raw token or metadata',async t=>{
 for(const mutate of [f=>f.contexts.delete('A'),f=>f.contexts.get('A').profile.member.role='member',f=>f.contexts.get('A').cacheBinding='c'.repeat(32),f=>f.contexts.get('A').authSessionId=randomUUID(),f=>f.contexts.get('A').expiresAt=f.now,f=>f.contexts.get('A').profile.member.active=false]){
  const f=await fixture(t),entered=deferred(),release=deferred(),id=randomUUID();f.afterRPC=async body=>{if(body.p_action==='create'){entered.resolve();await release.promise;}};
  const pending=f.request('POST',undefined,{transaction_id:id});await entered.promise;assert.equal(f.grants.get(id).enabled,false);mutate(f);release.resolve();const response=await pending;assert([401,403].includes(response.status));assert(!response.body.token&&!response.body.grant);safe(response);assert.equal(f.audits.length,1);
 }
});
test('all metadata responses retain the final owner fence after list/activation/revocation RPCs',async t=>{
 for(const action of ['list','activate','revoke']){
  const f=await fixture(t),created=await create(f),entered=deferred(),release=deferred();f.afterRPC=async body=>{if(body.p_action===action){entered.resolve();await release.promise;}};
  const path='/api/scim/tokens/'+created.grant.id,pending=action==='list'?f.request('GET'):action==='activate'?f.request('POST',path+'/activate',{token:created.token}):f.request('DELETE',path);
  await entered.promise;f.contexts.get('A').profile.member.role='member';release.resolve();const response=await pending;assert.equal(response.status,403);assert(!response.body.grant&&!response.body.tokens);safe(response);
 }
});
test('audit/globalrevision failure rolls back the grant transition; provider faults and unexpected fields stay private',async t=>{
 const f=await fixture(t),id=randomUUID();f.failAudit=true;const failed=await f.request('POST',undefined,{transaction_id:id});assert.equal(failed.status,503);safe(failed);assert(!f.grants.has(id));assert.equal(f.revision,1);assert.equal(f.audits.length,0);
 f.failAudit=false;const created=await create(f,{transaction_id:id});f.failAudit=true;assert.equal((await f.request('POST','/api/scim/tokens/'+id+'/activate',{token:created.token})).status,503);assert.equal(f.grants.get(id).enabled,false);assert.equal(f.revision,2);
 f.failAudit=false;for(const malformed of ['{',JSON.stringify({grant:{id:[id]},created:true}),' '.repeat(262145)]){f.responseFault=()=>malformed;const response=await f.request('POST',undefined,{transaction_id:randomUUID()});assert.equal(response.status,503);safe(response);assert(!response.body.token);}
});
test('applied SQL exposes only owner-authenticated wrapper and preserves one-way, hash-only grant state/audit boundaries',async()=>{
 const sql=await readFile(new URL('../migrations/20261016151633_fountain_cloud_scim_grant_admin.sql',import.meta.url),'utf8');assert(sql.includes('No credentials are issued by this migration'));assert(sql.includes('#variable_conflict error'));assert(sql.indexOf('fountain_cloud.store_context(p_context)')<sql.indexOf("IF p_action='list'"));
 assert(sql.includes('fountain_cloud.store_apply_changes_locked'));assert(sql.includes('date_trunc(\'milliseconds\',v_now)'));assert(sql.includes('v_grant.version<>1'));assert(sql.includes("v_grant.pending_until<=v_now"));assert(sql.includes('v_grant.auth_user_id IS DISTINCT FROM'));assert(sql.includes("v_grant.creation_digest IS DISTINCT FROM v_digest"));
 assert(sql.includes('g.created_at,g.id')&&sql.includes('LIMIT v_limit+1')&&sql.includes('SS.US'));assert(!/ALTER TABLE[^;]+(?:DROP|DISABLE)/.test(sql));assert(!/GRANT[^;]+(?:anon|authenticated|PUBLIC)/.test(sql));assert(!/ADD COLUMN\s+(?:token|raw_token)\s/i.test(sql));
 const projection=sql.slice(sql.indexOf('CREATE FUNCTION fountain_cloud.scim_grant_metadata'),sql.indexOf('REVOKE ALL ON FUNCTION fountain_cloud.scim_grant_metadata'));for(const hidden of ['token_hash','creation_digest','auth_user_id'])assert(!projection.includes(hidden));
});
