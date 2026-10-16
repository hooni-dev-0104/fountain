/** Actual isolated HTTP Auth/RPC fixture + atomic in-memory claim model.
 * SQL source assertions read the applied migration; this suite is not PostgreSQL/provider evidence. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAuth, AuthError } from '../functions/_shared/auth.ts';
import { createOnboarding } from '../functions/_shared/onboarding.ts';
import { CloudStore, StoreError } from '../functions/_shared/store.ts';

const copy=structuredClone, hash=value=>createHash('sha256').update(value).digest('hex');
const userA='11111111-1111-4111-8111-111111111111',userB='22222222-2222-4222-8222-222222222222';
const rawNonce=Buffer.alloc(32,7).toString('base64url');
const password='fixture-password-only',secretKey='sb_secret_fixture_private_key_value';
let checks=0;
async function fixture(options={}){
 let now=Date.now(),dropClaimACK=false,rpcFailure=null,signupCount=0,malformedRPC=false,accessRevision=0,entityRevision=0;
 const users=new Map([[userA,{email:'a@example.invalid',confirmed:true,banned:false}],[userB,{email:'b@example.invalid',confirmed:true,banned:false}]]),sessions=new Map(),tokens=new Map(),claims=new Map(),links=new Map(),rows=new Map(),requests=[];
 const members=new Map([['local',{id:'local',name:'나',email:'legacy@fountain.local',role:'owner',active:true}],['child',{id:'child',name:'가족',email:'child@example.invalid',role:'member',active:true}],['other',{id:'other',name:'다른 구성원',email:'other@example.invalid',role:'guest',active:true}]]);
 function issue(userId){const sid=crypto.randomUUID(),expires=Math.floor((now+3600000)/1000),access='fixture.'+Buffer.from(JSON.stringify({sub:userId,session_id:sid,exp:expires})).toString('base64url')+'.signature';sessions.set(sid,userId);tokens.set(access,{userId,sid});return {access_token:access,refresh_token:crypto.randomUUID(),token_type:'bearer',user:{id:userId}};}
 function seed(nonce=rawNonce,member='local',purpose='bootstrap',extra={}){claims.set(hash(nonce),{workspace:'family',member,purpose,expires:now+900000,used:null,...extra});}
 function profile(userId,sid){const memberId=links.get(userId),user=users.get(userId);return memberId?{workspaceId:'family',authSessionActive:sessions.get(sid)===userId&&!user.banned,member:copy(members.get(memberId))}:null;}
 const reply=(response,status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
 const server=createServer(async(request,response)=>{try{
  let raw='';for await(const part of request)raw+=part;const body=raw?JSON.parse(raw):{},url=new URL(request.url,'http://fixture.invalid');
  requests.push({path:url.pathname,body:copy(body),apikey:request.headers.apikey,authorization:request.headers.authorization});
  if(url.pathname==='/auth/v1/token'){
   const userId=[...users].find(([,user])=>user.email===body.email)?.[0];if(!userId||body.password!==password){reply(response,400,{private:password});return;}reply(response,200,issue(userId));return;
  }
  if(url.pathname==='/auth/v1/verify'){if(body.token_hash!=='fixture-email-hash'||body.type!=='signup'){reply(response,403,{});return;}users.get(userA).confirmed=true;reply(response,200,issue(userA));return;}
  const token=tokens.get(String(request.headers.authorization??'').replace(/^Bearer /,''));
  if(url.pathname==='/auth/v1/user'){if(!token){reply(response,401,{});return;}reply(response,200,{id:token.userId,email_confirmed_at:users.get(token.userId).confirmed?'2026-01-01T00:00:00Z':null,user_metadata:{role:'owner',member_id:'local'}});return;}
  if(url.pathname==='/auth/v1/logout'){if(token)sessions.delete(token.sid);response.writeHead(204);response.end();return;}
  if(url.pathname==='/auth/v1/signup'){signupCount++;assert.equal(url.searchParams.get('redirect_to'),'https://app.example/confirm');reply(response,200,options.autoConfirm?issue(userA):{id:userA});return;}
  assert.equal(request.headers.apikey,secretKey);assert.equal(request.headers.authorization,undefined);
  if(rpcFailure){reply(response,rpcFailure,{private:secretKey});return;}
  if(malformedRPC){reply(response,200,{workspace_id:'foreign',member_id:'local',replayed:false,private:secretKey});return;}
  if(url.pathname==='/rest/v1/rpc/fountain_cloud_onboarding_claim'){
   assert.deepEqual(Object.keys(body).sort(),['p_workspace_id','p_nonce_hash','p_user_id','p_auth_session_id'].sort());assert(!raw.includes(rawNonce));
   const claim=claims.get(body.p_nonce_hash),user=users.get(body.p_user_id),member=claim&&members.get(claim.member);
   if(body.p_workspace_id!=='family'||!claim||claim.workspace!==body.p_workspace_id||!user?.confirmed||user.banned||sessions.get(body.p_auth_session_id)!==body.p_user_id||!member?.active){reply(response,403,{});return;}
   if(claim.expires<=now){reply(response,410,{});return;}
   const issuerMember=members.get(links.get(claim.issuer)),issuerUser=users.get(claim.issuer);
   if(claim.purpose==='bootstrap'&&(member.id!=='local'||member.role!=='owner')||claim.purpose==='invite'&&(member.role==='owner'||issuerMember?.id!==claim.issuerMember||issuerMember?.role!=='owner'||issuerMember?.active!==true||issuerUser?.banned||!issuerUser?.confirmed)){reply(response,403,{});return;}
   if(claim.used){if(claim.used!==body.p_user_id||links.get(body.p_user_id)!==claim.member){reply(response,403,{});return;}reply(response,200,{workspace_id:'family',member_id:claim.member,replayed:true});return;}
   if(links.has(body.p_user_id)||[...links.values()].includes(claim.member)||claim.purpose==='bootstrap'&&links.size){reply(response,409,{});return;}
   // Model only: actual SQL row-lock scheduling is verified separately.
   if(accessRevision>=Number.MAX_SAFE_INTEGER||entityRevision>=Number.MAX_SAFE_INTEGER){reply(response,413,{});return;}
   // Atomic section: no awaits between one-use test and identity link/claim CAS.
   links.set(body.p_user_id,claim.member);claim.used=body.p_user_id;accessRevision++;entityRevision++;
   if(dropClaimACK){dropClaimACK=false;response.destroy();return;}
   reply(response,200,{workspace_id:'family',member_id:claim.member,replayed:false});return;
  }
  if(url.pathname==='/rest/v1/rpc/fountain_cloud_onboarding_invite'){
   const context=body.p_context,vaultRow=rows.get(context.sessionHash),caller=members.get(links.get(context.userId));
   if(context.workspaceId!=='family'||caller?.id!==context.memberId||caller?.role!=='owner'||!caller.active||!vaultRow||vaultRow.revokedAt!==null||vaultRow.userId!==context.userId||vaultRow.authSessionId!==context.authSessionId||vaultRow.cacheBinding!==context.cacheBinding||sessions.get(context.authSessionId)!==context.userId){reply(response,403,{});return;}
   const target=members.get(body.p_member_id);if(!target?.active||target.role==='owner'){reply(response,403,{});return;}if([...links.values()].includes(body.p_member_id)){reply(response,409,{});return;}
   claims.set(body.p_nonce_hash,{workspace:'family',member:body.p_member_id,purpose:'invite',issuer:context.userId,issuerMember:context.memberId,expires:body.p_expires_at_ms,used:null});reply(response,200,{workspace_id:'family',member_id:body.p_member_id,expires_at_ms:body.p_expires_at_ms});return;
  }
  reply(response,404,{});
 }catch{if(!response.headersSent)reply(response,500,{});else response.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 const onboarding=createOnboarding({supabaseUrl:origin,publishableKey:'publishable-fixture',serviceKey:secretKey,workspaceId:'family',clock:()=>now,...options});
 const vault={create:async row=>{assert(!rows.has(row.hash));rows.set(row.hash,copy(row));},read:async id=>copy(rows.get(id)??null),resolveProfile:async(user,sid)=>profile(user,sid),revoke:async(id,time)=>{const row=rows.get(id);if(row&&row.revokedAt===null){row.revokedAt=time;row.logoutPending=true;row.version++;}return copy(row??null);},finishLogout:async(id,version)=>{const row=rows.get(id);if(row?.version!==version)return false;row.tokens=null;row.logoutPending=false;return true;},claimRefresh:async()=>{throw new Error('Refresh is outside this onboarding fixture');},finishRefresh:async()=>{throw new Error('Refresh is outside this onboarding fixture');},releaseRefresh:async()=>{throw new Error('Refresh is outside this onboarding fixture');}};
 const config={supabaseUrl:origin,publishableKey:'publishable-fixture',cryptoKeys:[{id:'fixture',secret:'fixture-private-key-at-least-32bytes'}],vault,clock:()=>now};
 const auth=createAuth({...config,setupClaim:onboarding.claim,confirmSetupEnabled:options.confirmSetupEnabled});
 return {auth,onboarding,config,users,members,sessions,claims,links,rows,requests,seed,get accessRevision(){return accessRevision;},set accessRevision(value){accessRevision=value;},get entityRevision(){return entityRevision;},set entityRevision(value){entityRevision=value;},get signupCount(){return signupCount;},set now(value){now=value;},get now(){return now;},set dropClaimACK(value){dropClaimACK=value;},set rpcFailure(value){rpcFailure=value;},set malformedRPC(value){malformedRPC=value;},close:async()=>{server.closeAllConnections();server.close();await once(server,'close');}};
}
const cookie=result=>result.setCookie.split(';')[0],credentials=(nonce=rawNonce,email='a@example.invalid')=>({email,password,nonce});
const rejects=(promise,status,code)=>assert.rejects(promise,error=>error instanceof AuthError&&error.status===status&&(!code||error.code===code)&&!error.message.includes(secretKey)&&!error.message.includes(password));
async function run(action,options){const f=await fixture(options);try{await action(f);}finally{await f.close();}}

await run(async f=>{
 f.seed();await rejects(f.auth.login({email:'a@example.invalid',password}),403,'SETUP_REQUIRED');assert.equal(f.links.size,0);assert(!f.requests.some(request=>request.path.includes('onboarding_claim')));checks+=2;
 const result=await f.auth.setup(credentials());assert.equal(result.body.member.id,'local');assert.equal(result.body.member.role,'owner');assert.equal(f.links.get(userA),'local');assert.equal(f.claims.get(hash(rawNonce)).used,userA);assert.match(result.setCookie,/HttpOnly; Secure; SameSite=Strict/);checks+=5;
 const rpcIndex=f.requests.findIndex(request=>request.path.includes('onboarding_claim'));assert(f.requests.slice(0,rpcIndex).some(request=>request.path==='/auth/v1/user'));assert.deepEqual(Object.keys(f.requests[rpcIndex].body).sort(),['p_workspace_id','p_nonce_hash','p_user_id','p_auth_session_id'].sort());checks+=2;
 for(const privateValue of [rawNonce,password,secretKey,...f.requests.filter(request=>request.path==='/auth/v1/user').map(request=>request.authorization?.slice(7)).filter(Boolean)])assert(!JSON.stringify(result.body).includes(privateValue));checks++;
 const replay=await f.auth.setup(credentials());assert.equal(replay.body.member.id,'local');assert.notEqual(replay.body.cache_binding,result.body.cache_binding);assert.equal(f.links.size,1);checks+=3;
 await rejects(f.auth.setup(credentials(rawNonce,'b@example.invalid')),403);assert.equal(f.links.has(userB),false);checks+=2;
 const owner=await f.auth.authorize(cookie(replay)),invite=await f.onboarding.invite(owner,{memberId:'child'});assert.match(invite.nonce,/^[\w-]{43}$/);assert(f.claims.has(hash(invite.nonce)));assert(!JSON.stringify([...f.claims]).includes(invite.nonce));checks+=3;
 const child=await f.auth.setup(credentials(invite.nonce,'b@example.invalid'));assert.equal(child.body.member.id,'child');assert.equal(child.body.member.role,'member');checks+=2;
 await rejects(f.onboarding.invite(await f.auth.authorize(cookie(child)),{memberId:'other'}),403);await rejects(f.onboarding.invite(owner,{memberId:'local'}),403);checks+=2;
 const forged=await f.auth.authorize(cookie(child));forged.profile.member.role='owner';await rejects(f.onboarding.invite(forged,{memberId:'other'}),403);checks++;
 f.members.get('local').role='member';await rejects(f.onboarding.invite(owner,{memberId:'other'}),403);f.members.get('local').role='owner';checks++;
 await f.auth.logout(cookie(replay));await rejects(f.onboarding.invite(owner,{memberId:'other'}),403);checks++;
});
await run(async f=>{f.seed();const results=await Promise.allSettled([f.auth.setup(credentials()),f.auth.setup(credentials(rawNonce,'b@example.invalid'))]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(f.links.size,1);checks+=2;});
await run(async f=>{f.seed();f.dropClaimACK=true;await rejects(f.auth.setup(credentials()),503);assert.equal(f.links.get(userA),'local');const recovered=await f.auth.setup(credentials());assert.equal(recovered.body.member.id,'local');assert.equal(f.links.size,1);checks+=4;});
await run(async f=>{f.seed();f.now+=900001;await rejects(f.auth.setup(credentials()),410,'SETUP_EXPIRED');assert.equal(f.links.size,0);checks+=2;});
await run(async f=>{f.seed();f.users.get(userA).confirmed=false;await rejects(f.auth.setup(credentials()),403);assert.equal(f.links.size,0);f.users.get(userA).confirmed=true;f.users.get(userA).banned=true;await rejects(f.auth.setup(credentials()),403);assert.equal(f.links.size,0);checks+=4;});
await run(async f=>{f.seed();f.links.set(userA,'child');await rejects(f.auth.setup(credentials()),409);assert.equal(f.links.get(userA),'child');checks+=2;});
await run(async f=>{f.seed();await f.auth.setup(credentials());f.claims.get(hash(rawNonce)).member='other';await rejects(f.auth.setup(credentials()),403);assert.equal(f.links.get(userA),'local');checks+=2;});
await run(async f=>{
 f.seed();const before=f.requests.length;await rejects(f.auth.setup({...credentials(),memberId:'local'}),400);await rejects(f.auth.setup(credentials('short')),400);assert.equal(f.requests.length,before);checks+=3;
 const ordinary=createAuth(f.config);await rejects(ordinary.setup(credentials()),503,'SETUP_UNAVAILABLE');assert.equal(f.requests.length,before);checks+=2;
 await rejects(f.auth.confirmSetup({token_hash:'fixture-email-hash',type:'signup',nonce:rawNonce}),503,'CONFIRMATION_UNAVAILABLE');await rejects(f.onboarding.signup({email:'a@example.invalid',password,redirectTo:'https://app.example/confirm'}),503);assert.equal(f.signupCount,0);checks+=3;
});
await run(async f=>{
 f.seed();assert.equal((await f.onboarding.signup({email:'a@example.invalid',password,redirectTo:'https://app.example/confirm'})).confirmation_required,true);assert.equal(f.signupCount,1);checks+=2;
 for(const redirectTo of ['https://evil.example/confirm','https://app.example/confirm?evil=1','https://app.example/confirm#token','http://app.example/confirm'])await rejects(f.onboarding.signup({email:'a@example.invalid',password,redirectTo}),400);assert.equal(f.signupCount,1);checks+=5;
 const result=await f.auth.confirmSetup({token_hash:'fixture-email-hash',type:'signup',nonce:rawNonce});assert.equal(result.body.member.id,'local');assert(!JSON.stringify(result.body).includes('fixture-email-hash'));checks+=2;
},{signupEnabled:true,serverConfirmationTemplateVerified:true,confirmationRedirects:['https://app.example/confirm'],confirmSetupEnabled:true});
await run(async f=>{f.seed();for(const status of [403,409,410,503]){f.rpcFailure=status;await rejects(f.auth.setup(credentials()),status);assert.equal(f.rows.size,0);checks+=2;}});
await run(async f=>{f.seed();f.malformedRPC=true;await rejects(f.auth.setup(credentials()),503);assert.equal(f.rows.size,0);assert.equal(f.links.size,0);checks+=3;});
await run(async f=>{f.seed();const revoked=createAuth({...f.config,setupClaim:async input=>{f.sessions.delete(input.authSessionId);return f.onboarding.claim(input);}});await rejects(revoked.setup(credentials()),403);assert.equal(f.links.size,0);assert.equal(f.claims.get(hash(rawNonce)).used,null);checks+=3;});
await run(async f=>{const result=await f.onboarding.signup({email:'a@example.invalid',password,redirectTo:'https://app.example/confirm'});assert.deepEqual(result,{confirmation_required:false});assert.equal(f.links.size,0);assert.equal(f.sessions.size,0);assert(!JSON.stringify(result).includes('access_token'));checks+=4;},{signupEnabled:true,serverConfirmationTemplateVerified:true,confirmationRedirects:['https://app.example/confirm'],autoConfirm:true});
// Current global revision must invalidate an already pinned transaction. This
// exercises CloudStore against the HTTP claim MODEL, not the SQL's actual locks.
await run(async f=>{
 f.seed();const ownerResult=await f.auth.setup(credentials()),owner=await f.auth.authorize(cookie(ownerResult));
 assert.equal(f.accessRevision,1);assert.equal(f.entityRevision,1);checks+=2;
 const provider={snapshot:async()=>({workspaceId:'family',memberId:'local',revision:f.entityRevision,accessRevision:f.accessRevision,principal:copy(f.members.get('local')),entities:[],meta:[],nextCursor:null}),commit:async request=>{if(request.expectedRevision!==f.entityRevision)throw new StoreError(409,'REVISION_CONFLICT','Changed');return {revision:f.entityRevision};}};
 const context={workspaceId:'family',memberId:'local',userId:owner.userId,authSessionId:owner.authSessionId,sessionHash:owner.hash,cacheBinding:owner.cacheBinding},pending=await CloudStore.open(provider,context,{});
 const invite=await f.onboarding.invite(owner,{memberId:'child'});await f.auth.setup(credentials(invite.nonce,'b@example.invalid'));
 assert.equal(f.entityRevision,2);assert.equal(f.accessRevision,2);await assert.rejects(pending.commit(),error=>error.code==='REVISION_CONFLICT');checks+=3;
 await f.auth.setup(credentials(invite.nonce,'b@example.invalid'));assert.equal(f.entityRevision,2);assert.equal(f.accessRevision,2);checks+=2;
});
for(const field of ['entityRevision','accessRevision'])await run(async f=>{
 f.seed();f[field]=Number.MAX_SAFE_INTEGER;await rejects(f.auth.setup(credentials()),503);
 assert.equal(f.links.size,0);assert.equal(f.claims.get(hash(rawNonce)).used,null);assert.equal(f[field],Number.MAX_SAFE_INTEGER);checks+=4;
});
await run(async f=>{
 f.seed();const owner=await f.auth.setup(credentials()),invite=await f.onboarding.invite(await f.auth.authorize(cookie(owner)),{memberId:'child'});
 f.users.get(userA).banned=true;await rejects(f.auth.setup(credentials(invite.nonce,'b@example.invalid')),403);assert.equal(f.links.has(userB),false);assert.equal(f.entityRevision,1);checks+=3;
});
// A claim may have committed before the FINAL opaque-vault write fails. Keep the
// one-use mapping, emit no cookie, clean the temporary provider session, and let
// the same verified account recover through normal login / exact claim replay.
for(const lostACK of [false,true])await run(async f=>{
 f.seed();const original=f.config.vault.create;
 const broken=createAuth({...f.config,setupClaim:f.onboarding.claim,vault:{...f.config.vault,create:async row=>{if(lostACK)await original(row);throw Error('PRIVATE_VAULT_FAILURE');}}});
 await rejects(broken.setup(credentials()),503,'SESSION_STORAGE_UNAVAILABLE');assert.equal(f.links.get(userA),'local');assert.equal(f.claims.get(hash(rawNonce)).used,userA);assert.equal(f.entityRevision,1);assert.equal(f.sessions.size,0);assert.equal(f.rows.size,lostACK?1:0);checks+=6;
 const recovered=lostACK?await f.auth.setup(credentials()):await f.auth.login({email:'a@example.invalid',password});assert.equal(recovered.body.member.id,'local');assert.equal(f.entityRevision,1);assert.equal(f.links.size,1);checks+=3;
});
const sql=readFileSync(new URL('../migrations/20261016104546_fountain_cloud_onboarding_claims.sql',import.meta.url),'utf8');
assert(sql.includes("store_revision(p_workspace_id,'_entity_revision')"),'Claim must advance the pinned global revision');checks++;
assert(sql.includes('FOR SHARE OF m,e,u'),'Invitation issuer Auth ban must serialize with claim');checks++;
assert(sql.includes('OR global_revision>=9007199254740991'));assert(sql.includes("'_entity_revision',to_jsonb(global_revision+1)"));checks+=2;
for(const invariant of ['store_lock(p_workspace_id)','FOR UPDATE','u.email_confirmed_at IS NOT NULL','claim.used_auth_user_id<>p_user_id','linked IS DISTINCT FROM claim.member_id',"claim.member_id,'replayed',true",'SECURITY INVOKER','FROM PUBLIC,anon,authenticated','TO service_role',"member.id<>'local'",'fountain_cloud.store_context(p_context)']){assert(sql.includes(invariant));checks++;}
assert(!sql.includes('raw_user_meta_data'));assert(!sql.includes('ON CONFLICT(workspace_id,auth_user_id) DO UPDATE'));checks+=2;
console.log(`PASS onboarding: ${checks} HTTP/Auth/claim-model and applied-migration source checks; no real account, email, nonce issuance or remote DDL performed`);
