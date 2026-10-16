/** Actual loopback Admin/RPC HTTP and production accounts adapter.
 * The private SQL/Auth data in this fixture is a MODEL, not deployed SQL proof.
 * No Supabase account, email, database or credential is contacted/modified.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createAccounts} from '../functions/_shared/accounts.ts';
import {AuthError} from '../functions/_shared/auth.ts';
const key='sb_secret_fixture_accounts_only',workspace='fountain-qa-cloud-model',copy=structuredClone;
const ids={alice:'11111111-1111-4111-8111-111111111111',bob:'22222222-2222-4222-8222-222222222222'};
const initial={hash:'a'.repeat(64),userId:ids.alice,authSessionId:'33333333-3333-4333-8333-333333333333',cacheBinding:'b'.repeat(32),expiresAt:Date.now()+3600000,profile:{workspaceId:workspace,authSessionActive:true,member:{id:'alice',name:'Alice',email:'alice@fixture.invalid',role:'owner',active:true}}};
const pw='fixture password never returned';
async function fixture(t){
 const members=new Map([['alice',copy(initial.profile.member)],['bob',{id:'bob',name:'Bob',email:'bob@fixture.invalid',role:'member',active:true}],['child',{id:'child',name:'Child',email:'child@fixture.invalid',role:'member',active:true}],['legacy',{id:'legacy',name:'Legacy',email:'legacy@fixture.invalid',role:'owner',active:true}]]);
 for(const member of members.values())member.created_at='2026-10-16T00:00:00Z';
 const mappings=new Map([['alice',ids.alice],['bob',ids.bob]]),users=new Map([...mappings].map(([id,uuid])=>[uuid,{id:uuid,email:members.get(id).email,app_metadata:{provider:'email'},email_confirmed_at:new Date().toISOString()}])),intents=new Map(),unlinks=new Map(),foreign=new Set(),calls=[],vault=[{ws:workspace,user:ids.alice,active:true},{ws:workspace,user:ids.bob,active:true},{ws:'other-workspace',user:ids.alice,active:true},{ws:'other-workspace',user:ids.bob,active:true}];
 let active=copy(initial),actualOwner=true,authEnded=false,shared=false,loseCreate=false,losePassword=false,ignoreID=false,forgeMetadata=false,adminReject=0,onAdmin=null,onCheck=null,beforeAdmin=null,beforeClaim=null;
 const fail=(code,status=409)=>{const error=Error('private SQL '+code+' '+key);error.status=status;throw error;};
 function owner(ctx){if(!actualOwner||ctx.workspaceId!==workspace||ctx.memberId!=='alice'||ctx.userId!==ids.alice||ctx.sessionHash!==initial.hash||ctx.cacheBinding!==initial.cacheBinding)fail('OWNER',403);}
 const revoke=user=>{for(const row of vault)if(row.ws===workspace&&row.user===user)row.active=false;};
 const safe=id=>({...copy(members.get(id)),has_account:mappings.has(id)});
 const marker=user=>({account:user.app_metadata.fountain_account_intent??null,password:user.app_metadata.fountain_password_intent??null});
 function checked(body){owner(body.p_context);const entry=intents.get(body.p_member_id);if(!entry||entry.id!==body.p_intent_id||entry.digest!==body.p_digest||JSON.stringify(entry.snapshot)!==JSON.stringify(members.get(body.p_member_id)))fail('STALE');if((entry.kind==='password'||entry.relink)&&(shared||foreign.has(entry.userId)||entry.kind==='password'&&mappings.get(body.p_member_id)!==entry.userId||users.get(entry.userId)?.email!==entry.providerEmail))fail('MAPPING');return entry;}
 function addForeign(user){if([...intents.values()].some(item=>item.userId===user&&(item.kind==='password'||item.relink)&&['prepared','attempted'].includes(item.state)))fail('ACCOUNT_OPERATION_PENDING');foreign.add(user);}
 function rpc(body){
  owner(body.p_context);const id=body.p_member_id,member=members.get(id),action=body.p_action;
  if(action==='list')return {accounts:[...members.keys()].map(safe),required:true};if(action==='enable')return {required:true,mode:'accounts'};
  if(!member)fail('NOT_FOUND',404);
  if(action==='unlink'){
   const pending=intents.get(id);if(pending&&(pending.kind==='password'||pending.relink)&&['prepared','attempted'].includes(pending.state))fail('ACCOUNT_OPERATION_PENDING');
   if(!mappings.has(id))fail('NOT_FOUND',404);
   if(member.role==='owner'&&![...members.values()].some(v=>v.id!==id&&v.active&&v.role==='owner'&&mappings.has(v.id)&&users.has(mappings.get(v.id))))fail('LAST_OWNER_ACCOUNT');
   const user=mappings.get(id);unlinks.set(id,{userId:user,createdAt:member.created_at,email:member.email,providerEmail:users.get(user).email,priorMarker:marker(users.get(user))});mappings.delete(id);revoke(user);if(intents.has(id)&&!['prepared','attempted'].includes(intents.get(id).state))intents.get(id).state='cancelled';return safe(id);
  }
  if(!member.active)fail('INACTIVE',404);
  if(action==='begin'){
   const old=intents.get(id);
   if(old&&['prepared','attempted'].includes(old.state)){
    if(old.digest!==body.p_digest||old.kind!==body.p_kind||JSON.stringify(old.snapshot)!==JSON.stringify(member))fail('RECOVERY');return copy({...old,member:safe(id)});
   }
   if(old?.state==='done'&&old.digest===body.p_digest&&old.kind===body.p_kind)return copy({...old,member:safe(id)});
   if(body.p_kind==='create'&&mappings.has(id))fail('EXISTS');if(body.p_kind==='password'&&(!mappings.has(id)||shared||foreign.has(mappings.get(id))))fail('SHARED');
   const prior=body.p_kind==='create'?unlinks.get(id):null,relink=!!prior,userId=prior?.userId??(body.p_kind==='create'?body.p_user_id:mappings.get(id));
   if(prior&&(prior.createdAt!==member.created_at||prior.email!==member.email||foreign.has(userId)||shared||users.get(userId)?.email!==prior.providerEmail||JSON.stringify(marker(users.get(userId)))!==JSON.stringify(prior.priorMarker)))fail('RELINK');
   const item={id:body.p_intent_id,kind:body.p_kind,state:'prepared',digest:body.p_digest,nonce:body.p_nonce,userId,snapshot:copy(member),relink,providerEmail:prior?.providerEmail??(body.p_kind==='create'?member.email:users.get(userId).email),priorMarker:prior?.priorMarker??(body.p_kind==='password'?marker(users.get(userId)):{account:null,password:null})};intents.set(id,item);return copy({...item,member:safe(id)});
  }
  const item=checked(body);
  if(action==='claim'){const claimed=item.state==='prepared';if(claimed)item.state='attempted';return {claimed};}
  if(action==='check'){if(onCheck)onCheck();checked(body);return {valid:true};}
  if(action==='reject'){item.state='rejected';return {rejected:true};}
  if(action==='finish'){
   if(item.state==='done')return safe(id);if(item.state!=='attempted')fail('STATE');
   const user=users.get(item.userId),field=item.kind==='create'?'fountain_account_intent':'fountain_password_intent';
   if(!user||user.email!==item.providerEmail||user.app_metadata[field]!==item.nonce)fail('MARKER');
   if(item.kind==='create')mappings.set(id,item.userId);if(item.kind==='password'||item.relink)revoke(item.userId);item.state='done';unlinks.delete(id);return safe(id);
  }
  fail('ACTION',400);
 }
 const server=createServer(async(req,res)=>{
  try{
   assert.equal(req.headers.apikey,key);assert.equal(req.headers.authorization,undefined);let text='';for await(const bytes of req)text+=bytes;const body=text?JSON.parse(text):null,path=new URL(req.url,'http://fixture').pathname;calls.push({method:req.method,path,body:copy(body)});
   const send=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
   if(path==='/rest/v1/rpc/fountain_cloud_accounts'){assert(!text.includes(pw));if(body.p_action==='claim'&&beforeClaim)await beforeClaim();return send(rpc(body));}
   if(path==='/rest/v1/rpc/fountain_cloud_account_revoke_attempt'){
    const item=intents.get(body.p_member_id);if(!item||item.kind!=='password'&&!item.relink||item.id!==body.p_intent_id||item.digest!==body.p_digest||!['attempted','done'].includes(item.state)||body.p_context.workspaceId!==workspace)fail('REVOKE',403);revoke(item.userId);return send({revoked:true});
   }
   if(path==='/auth/v1/admin/users'&&req.method==='POST'){
    if(adminReject>0){adminReject--;fail('password policy and private secret '+key,422);}
    assert.equal(body.email_confirm,true);assert.equal(typeof body.password,'string');assert(!body.user_metadata);const id=ignoreID?randomUUID():body.id;
    const user={id,email:body.email,app_metadata:forgeMetadata?{}:body.app_metadata,user_metadata:forgeMetadata?body.app_metadata:{},email_confirmed_at:new Date().toISOString()};users.set(id,user);if(onAdmin)onAdmin();if(loseCreate){loseCreate=false;res.destroy();return;}return send(user);
   }
   const match=/^\/auth\/v1\/admin\/users\/([a-f0-9-]+)$/.exec(path);
   if(match&&req.method==='GET'){if(!users.has(match[1]))fail('MISSING',404);return send(users.get(match[1]));}
   if(match&&req.method==='PUT'){
    if(adminReject>0){adminReject--;fail('password policy and private secret '+key,400);}
    if(beforeAdmin)await beforeAdmin();
    const user=users.get(match[1]);if(!user)fail('MISSING',404);assert.equal(body.password,pw);user.app_metadata={...user.app_metadata,...body.app_metadata};if(onAdmin)onAdmin();if(losePassword){losePassword=false;res.destroy();return;}return send(user);
   }
   fail('UNEXPECTED',500);
  }catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'PT409',message:error.message}));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();});
 const authorize=async()=>{if(authEnded)throw new AuthError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');return copy(active);};
 const accounts=createAccounts({supabaseUrl:'http://127.0.0.1:'+server.address().port,serviceKey:key,workspaceId:workspace,authorize});
 const request=async(method,path,body,context=initial)=>{
  try{const result=await accounts.handle(new Request('https://app.fixture.invalid'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),path,copy(context));if(!result)return null;return {status:result.status,body:await result.json()};}
  catch(error){return {status:error.status??500,code:error.code??'UNKNOWN',message:error.message};}
 };
 return {request,members,mappings,users,intents,unlinks,foreign,addForeign,calls,vault,active,set active(v){active=copy(v);},set actualOwner(v){actualOwner=v;},set authEnded(v){authEnded=v;},set shared(v){shared=v;},set loseCreate(v){loseCreate=v;},set losePassword(v){losePassword=v;},set ignoreID(v){ignoreID=v;},set forgeMetadata(v){forgeMetadata=v;},set adminReject(v){adminReject=v;},set onAdmin(v){onAdmin=v;},set onCheck(v){onCheck=v;},set beforeAdmin(v){beforeAdmin=v;},set beforeClaim(v){beforeClaim=v;}};
}
function privateResult(result){const serialized=JSON.stringify(result);for(const forbidden of [pw,key,'app_metadata','user_metadata','target_snapshot','nonce','digest',ids.bob])assert(!serialized.includes(forbidden),forbidden);}

test('account UI DTO and already-required enable are exact, owner-only, and never load legacy credentials',async t=>{
 const f=await fixture(t),list=await f.request('GET','/api/accounts');assert.equal(list.status,200);assert.equal(list.body.required,true);assert.equal(list.body.accounts.find(v=>v.id==='bob').has_account,true);assert.equal(list.body.accounts.find(v=>v.id==='child').has_account,false);privateResult(list);
 assert.deepEqual(await f.request('POST','/api/accounts/enable',{}),{status:200,body:{required:true,mode:'accounts'}});
 assert(f.calls.every(v=>v.path==='/rest/v1/rpc/fountain_cloud_accounts'));assert(!JSON.stringify(f.calls).includes('credential'));
 f.active={...initial,profile:{...initial.profile,member:{...initial.profile.member,role:'member'}}};assert.equal((await f.request('GET','/api/accounts')).status,403);
});
test('explicit existing member creation uses one preallocated UUID/protected marker, no email or metadata authority',async t=>{
 const f=await fixture(t),result=await f.request('POST','/api/accounts',{member_id:'child',password:pw});assert.equal(result.status,201);assert.equal(result.body.id,'child');assert.equal(result.body.has_account,true);privateResult(result);
 const entry=f.intents.get('child');assert.equal(f.mappings.get('child'),entry.userId);assert.equal(f.users.get(entry.userId).app_metadata.fountain_account_intent,entry.nonce);
 assert.equal(f.calls.filter(v=>v.path==='/auth/v1/admin/users'&&v.method==='POST').length,1);
 assert.deepEqual(await f.request('POST','/api/accounts',{member_id:'child',password:pw}),result);assert.equal(f.calls.filter(v=>v.method==='POST'&&v.path==='/auth/v1/admin/users').length,1);
 assert(!f.calls.some(v=>v.path.includes('users?')||v.method==='DELETE'));
});
test('unknown create acknowledgement recovers only exact UUID+app_metadata, never re-creates or deletes an orphan',async t=>{
 const f=await fixture(t);f.loseCreate=true;assert.equal((await f.request('POST','/api/accounts',{member_id:'child',password:pw})).status,201);assert.equal(f.calls.filter(v=>v.path==='/auth/v1/admin/users').length,1);
 const g=await fixture(t);g.ignoreID=true;assert.equal((await g.request('POST','/api/accounts',{member_id:'child',password:pw})).code,'ACCOUNT_RECOVERY_REQUIRED');assert(!g.mappings.has('child'));assert.equal(g.users.size,3);
 assert.equal((await g.request('POST','/api/accounts',{member_id:'child',password:pw})).status,503);assert.equal(g.calls.filter(v=>v.path==='/auth/v1/admin/users').length,1);assert(!g.calls.some(v=>v.method==='DELETE'));
});
test('concurrent exact create requests issue one Admin POST and preserve its durable intent',async t=>{
 const f=await fixture(t),results=await Promise.all([f.request('POST','/api/accounts',{member_id:'child',password:pw}),f.request('POST','/api/accounts',{member_id:'child',password:pw})]);
 assert(results.some(v=>v.status===201));assert(results.every(v=>[201,503].includes(v.status)));assert.equal(f.calls.filter(v=>v.path==='/auth/v1/admin/users').length,1);assert.equal(f.mappings.get('child'),f.intents.get('child').userId);
});
test('user-editable marker, changed target or lost owner authority never publish an account mapping',async t=>{
 const f=await fixture(t);f.forgeMetadata=true;assert.equal((await f.request('POST','/api/accounts',{member_id:'child',password:pw})).status,503);assert(!f.mappings.has('child'));
 const g=await fixture(t);g.onCheck=()=>{g.members.get('child').email='changed@fixture.invalid';};assert.equal((await g.request('POST','/api/accounts',{member_id:'child',password:pw})).status,409);assert.equal(g.users.size,2);
 const h=await fixture(t);h.onAdmin=()=>{h.actualOwner=false;};assert.equal((await h.request('POST','/api/accounts',{member_id:'child',password:pw})).status,403);assert(!h.mappings.has('child'));assert.equal(h.users.size,3);
});
test('forged initial identity and forged role cannot bypass current authorization or SQL owner proof',async t=>{
 const f=await fixture(t);assert.equal((await f.request('POST','/api/accounts',{member_id:'child',password:pw},{...initial,userId:ids.bob})).status,401);assert.equal(f.calls.length,0);
 f.actualOwner=false;assert.equal((await f.request('POST','/api/accounts',{member_id:'child',password:pw})).status,403);assert(!f.calls.some(v=>v.path.startsWith('/auth/')));
 const g=await fixture(t);g.active={...initial,cacheBinding:'c'.repeat(32)};assert.equal((await g.request('PATCH','/api/accounts/bob',{password:pw})).status,401);assert.equal(g.calls.length,0);
});
test('password reset touches only exact mapped UUID, recovers its lost ACK and revokes workspace vaults only',async t=>{
 const f=await fixture(t);f.losePassword=true;const result=await f.request('PATCH','/api/accounts/bob',{password:pw});assert.equal(result.status,200);privateResult(result);
 assert.equal(f.calls.filter(v=>v.method==='PUT').length,1);assert.equal(f.calls.find(v=>v.method==='PUT').path,'/auth/v1/admin/users/'+ids.bob);
 assert.equal(f.vault.find(v=>v.ws===workspace&&v.user===ids.bob).active,false);assert.equal(f.vault.find(v=>v.ws==='other-workspace'&&v.user===ids.bob).active,true);
 assert.deepEqual(await f.request('PATCH','/api/accounts/bob',{password:pw}),result);assert.equal(f.calls.filter(v=>v.method==='PUT').length,1);
});
test('an unproven password outcome never resends Admin PUT and retains the recovery intent',async t=>{
 const f=await fixture(t);f.onAdmin=()=>{delete f.users.get(ids.bob).app_metadata.fountain_password_intent;};
 for(let i=0;i<2;i++){const result=await f.request('PATCH','/api/accounts/bob',{password:pw});assert.equal(result.status,503);privateResult(result);}
 assert.equal(f.calls.filter(v=>v.method==='PUT').length,1);assert.equal(f.intents.get('bob').state,'attempted');assert(f.mappings.has('bob'));assert.equal(f.vault.find(v=>v.ws===workspace&&v.user===ids.bob).active,false);
});
test('shared Auth password reset is refused before Admin I/O and late owner/session loss still revokes only target workspace',async t=>{
 const f=await fixture(t);f.shared=true;assert.equal((await f.request('PATCH','/api/accounts/bob',{password:pw})).status,409);assert(!f.calls.some(v=>v.path.startsWith('/auth/')));
 const g=await fixture(t);g.onAdmin=()=>{g.actualOwner=false;};assert.equal((await g.request('PATCH','/api/accounts/bob',{password:pw})).status,403);assert.equal(g.intents.get('bob').state,'attempted');assert.equal(g.vault.find(v=>v.ws===workspace&&v.user===ids.bob).active,false);assert(g.vault.find(v=>v.ws==='other-workspace'&&v.user===ids.bob).active);
 const h=await fixture(t);h.onAdmin=()=>{h.authEnded=true;};const self=await h.request('PATCH','/api/accounts/alice',{password:pw});assert.equal(self.status,401);assert.equal(h.vault.find(v=>v.ws===workspace&&v.user===ids.alice).active,false);assert(h.vault.find(v=>v.ws==='other-workspace'&&v.user===ids.alice).active);privateResult(self);
});
test('provider email is private mapped identity evidence; a change during Admin preparation is blocked',async t=>{
 const f=await fixture(t);f.users.get(ids.bob).email='real-provider@fixture.invalid';const result=await f.request('PATCH','/api/accounts/bob',{password:pw});assert.equal(result.status,200);assert.equal(result.body.email,'bob@fixture.invalid');assert(!JSON.stringify(result).includes('real-provider'));
 const g=await fixture(t);g.onCheck=()=>{g.users.get(ids.bob).email='changed@fixture.invalid';};assert.equal((await g.request('PATCH','/api/accounts/bob',{password:pw})).status,409);assert(!g.calls.some(v=>v.method==='PUT'));
});
test('last mapped owner survives despite an unlinked legacy owner; unlink never globally deletes shared Auth users',async t=>{
 const f=await fixture(t);assert.equal((await f.request('DELETE','/api/accounts/alice',{})).status,409);assert(f.mappings.has('alice'));assert(f.vault.find(v=>v.ws===workspace&&v.user===ids.alice).active);
 f.members.get('bob').role='owner';const result=await f.request('DELETE','/api/accounts/alice',{});assert.equal(result.status,200);assert.equal(result.body.has_account,false);assert(!f.mappings.has('alice'));assert(f.users.has(ids.alice));assert(f.vault.find(v=>v.ws==='other-workspace'&&v.user===ids.alice).active);assert.equal(f.vault.find(v=>v.ws===workspace&&v.user===ids.alice).active,false);assert(!f.calls.some(v=>v.path.startsWith('/auth/')));privateResult(result);
});
test('unlink then re-enable uses only private prior UUID/provider evidence; rename and legacy/provider email mismatch are preserved',async t=>{
 const f=await fixture(t);f.users.get(ids.bob).email='real-provider@fixture.invalid';assert.equal((await f.request('DELETE','/api/accounts/bob',{})).status,200);
 f.members.get('bob').name='Renamed Bob';const result=await f.request('POST','/api/accounts',{member_id:'bob',password:pw});assert.equal(result.status,201);assert.equal(result.body.name,'Renamed Bob');assert.equal(result.body.email,'bob@fixture.invalid');assert.equal(f.mappings.get('bob'),ids.bob);assert.equal(f.users.size,2);assert.equal(f.calls.filter(v=>v.path==='/auth/v1/admin/users').length,0);assert.equal(f.calls.filter(v=>v.method==='PUT').length,1);assert.equal(f.unlinks.size,0);assert(!JSON.stringify(result).includes('real-provider'));privateResult(result);
});
test('changed member identity, provider email or privileged prior marker refuses relink without guessing another account',async t=>{
 for(const change of [f=>{f.members.get('bob').created_at='2027-01-01';},f=>{f.members.get('bob').email='other@fixture.invalid';},f=>{f.users.get(ids.bob).email='other@fixture.invalid';},f=>{f.users.get(ids.bob).app_metadata.fountain_password_intent='forged';}]){
  const f=await fixture(t);await f.request('DELETE','/api/accounts/bob',{});change(f);const result=await f.request('POST','/api/accounts',{member_id:'bob',password:pw});assert.equal(result.status,409);assert(!f.mappings.has('bob'));assert(f.unlinks.has('bob'));assert(!f.calls.some(v=>v.method==='PUT'||v.path==='/auth/v1/admin/users'));privateResult(result);
 }
});
test('relink lost Admin ACK rechecks the exact UUID, issues no second PUT and keeps stale sessions revoked',async t=>{
 const f=await fixture(t);await f.request('DELETE','/api/accounts/bob',{});f.losePassword=true;const result=await f.request('POST','/api/accounts',{member_id:'bob',password:pw});assert.equal(result.status,201);assert.equal(f.calls.filter(v=>v.method==='PUT').length,1);assert.deepEqual(await f.request('POST','/api/accounts',{member_id:'bob',password:pw}),result);assert.equal(f.calls.filter(v=>v.method==='PUT').length,1);assert.equal(f.vault.find(v=>v.ws===workspace&&v.user===ids.bob).active,false);assert(f.vault.find(v=>v.ws==='other-workspace'&&v.user===ids.bob).active);
});
test('the intent model blocks foreign mappings throughout Admin I/O and uncertain recovery, including relink',async t=>{
 for(const relink of [false,true]){
  const f=await fixture(t);if(relink)await f.request('DELETE','/api/accounts/bob',{});f.onAdmin=()=>assert.throws(()=>f.addForeign(ids.bob),/ACCOUNT_OPERATION_PENDING/);
  assert.equal((await f.request(relink?'POST':'PATCH',relink?'/api/accounts':'/api/accounts/bob',relink?{member_id:'bob',password:pw}:{password:pw})).status,relink?201:200);f.addForeign(ids.bob);assert(f.foreign.has(ids.bob));
 }
 const f=await fixture(t);f.onAdmin=()=>{delete f.users.get(ids.bob).app_metadata.fountain_password_intent;};assert.equal((await f.request('PATCH','/api/accounts/bob',{password:pw})).status,503);assert.throws(()=>f.addForeign(ids.bob),/ACCOUNT_OPERATION_PENDING/);assert.equal(f.intents.get('bob').state,'attempted');
 const g=await fixture(t);await g.request('DELETE','/api/accounts/bob',{});g.addForeign(ids.bob);assert.equal((await g.request('POST','/api/accounts',{member_id:'bob',password:pw})).status,409);assert(!g.calls.some(v=>v.method==='PUT'));
});
test('unlink cannot release the UUID fence while Admin PUT is in flight; settlement is required before unlink',async t=>{
 for(const phase of ['prepared','attempted'])for(const relink of [false,true]){
  const f=await fixture(t);if(relink)await f.request('DELETE','/api/accounts/bob',{});
  let enter,release;const ready=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});const gate=async()=>{enter();await held;};if(phase==='prepared')f.beforeClaim=gate;else f.beforeAdmin=gate;
  const pending=f.request(relink?'POST':'PATCH',relink?'/api/accounts':'/api/accounts/bob',relink?{member_id:'bob',password:pw}:{password:pw});await ready;
  try{
   const original=copy({intent:f.intents.get('bob'),mapping:f.mappings.get('bob'),unlinks:[...f.unlinks],vault:f.vault});assert.equal(original.intent.state,phase);
   assert.equal((await f.request('DELETE','/api/accounts/bob',{})).status,409);
   assert.deepEqual({intent:f.intents.get('bob'),mapping:f.mappings.get('bob'),unlinks:[...f.unlinks],vault:f.vault},original);
   assert.throws(()=>f.addForeign(ids.bob),/ACCOUNT_OPERATION_PENDING/);
  }finally{release();}
  assert.equal((await pending).status,relink?201:200);assert.equal(f.intents.get('bob').state,'done');assert.equal(f.mappings.get('bob'),ids.bob);
  assert.equal((await f.request('DELETE','/api/accounts/bob',{})).status,200);f.addForeign(ids.bob);assert(f.foreign.has(ids.bob));
 }
 const unknown=await fixture(t);unknown.onAdmin=()=>{delete unknown.users.get(ids.bob).app_metadata.fountain_password_intent;};assert.equal((await unknown.request('PATCH','/api/accounts/bob',{password:pw})).status,503);
 const before=copy(unknown.intents.get('bob'));assert.equal((await unknown.request('DELETE','/api/accounts/bob',{})).status,409);assert.deepEqual(unknown.intents.get('bob'),before);assert.equal(unknown.mappings.get('bob'),ids.bob);assert.throws(()=>unknown.addForeign(ids.bob),/ACCOUNT_OPERATION_PENDING/);
});
test('known Admin policy rejection is terminal, preserves sessions and permits a corrected password attempt',async t=>{
 for(const kind of ['create','password']){
  const f=await fixture(t);f.adminReject=1;const path=kind==='create'?'/api/accounts':'/api/accounts/bob',body=kind==='create'?{member_id:'child',password:pw}:{password:pw},method=kind==='create'?'POST':'PATCH';
  const rejected=await f.request(method,path,body);assert.equal(rejected.status,400);assert.equal(rejected.code,'ACCOUNT_PROVIDER_REJECTED');privateResult(rejected);assert.equal(f.intents.get(kind==='create'?'child':'bob').state,'rejected');assert(f.vault.every(v=>v.active));
  const done=await f.request(method,path,body);assert.equal(done.status,kind==='create'?201:200);assert.equal(done.body.has_account,true);privateResult(done);
 }
});
test('strict input and sanitized diagnostics expose no password, key, UUID or raw provider errors',async t=>{
 const f=await fixture(t);for(const body of [{member_id:'child',password:'short'},{member_id:'child',password:pw,role:'owner'},{member_id:'../child',password:pw}]){const result=await f.request('POST','/api/accounts',body);assert.equal(result.status,400);privateResult(result);}
 assert.equal(f.calls.length,0);f.members.get('child').active=false;const result=await f.request('POST','/api/accounts',{member_id:'child',password:pw});assert.equal(result.status,404);privateResult(result);
 assert.equal(await f.request('GET','/api/unrelated'),null);
});
