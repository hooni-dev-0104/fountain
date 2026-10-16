/** Disposable root-only REAL-cloud verification handler, never production routing.
 * Deploy separately as fountain-verify, then replace with inert 404 and remove QA
 * rows/users. All business RPCs are pinned to a fountain-qa-cloud-* namespace.
 * No password, token, cookie, ciphertext or provider diagnostic is returned/logged.
 */
import {createAuth} from '../functions/_shared/auth.ts';
import type {AuthContext} from '../functions/_shared/auth.ts';
import {createSessionVault} from '../functions/_shared/vault.ts';
import {CloudStore,createStoreProvider} from '../functions/_shared/store.ts';
import type {CommitRequest,StoreContext,StoreProvider} from '../functions/_shared/store.ts';
import {Access} from '../functions/_shared/access.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
import {readBytes} from '../functions/_shared/http.ts';
import {runDomain,LiveQAError} from './live-domain.ts';
import {runFiles} from './live-files.ts';
import {runActivity,runSSE,startRealtime} from './live-activity.ts';

type Config={supabaseUrl:string;publishableKey:string;serviceKey:string;cryptoKeys:Array<{id:string;secret:string|Uint8Array}>;workspaceId:string;challengeHash:string;emails:[string,string];realtimeServerToken?:string};
class FixtureError extends Error {
  code:string;status:number;
  constructor(code:string,status=500){super('Disposable verification could not complete');this.code=code;this.status=status;}
}
const encoder=new TextEncoder(),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const check=(condition:unknown,code:string):void=>{if(!condition)throw new FixtureError(code);};
const sha=async(value:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
function response(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",'Referrer-Policy':'no-referrer'}});}
function missing():Response{return response({status:404},404);}
async function readJSON(request:Request,limit=8192):Promise<Record<string,any>>{
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw new FixtureError('BODY_INVALID',400);
 const reader=request.body?.getReader();if(!reader)throw new FixtureError('BODY_INVALID',400);
 const chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new FixtureError('BODY_INVALID',400);chunks.push(next.value);}
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 try{const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!object(result))throw Error();return result;
 }catch{throw new FixtureError('BODY_INVALID',400);}
}
function passwords(body:Record<string,any>):[string,string]{
 check(Object.keys(body).length===1&&Object.hasOwn(body,'passwords')&&Array.isArray(body.passwords)&&body.passwords.length===2&&body.passwords.every((password:unknown)=>typeof password==='string'&&password.length>=16&&password.length<=1024&&!/[\x00-\x1f\x7f]/.test(password)),'PASSWORD_INPUT_INVALID');
 return body.passwords;
}
function context(value:AuthContext):StoreContext{return {workspaceId:value.profile.workspaceId,memberId:value.profile.member.id,userId:value.userId,authSessionId:value.authSessionId,sessionHash:value.hash,cacheBinding:value.cacheBinding};}
async function denied(action:()=>Promise<unknown>,status:number,code:string):Promise<void>{
 try{await action();}catch(error){if(object(error)&&error.status===status)return;throw new FixtureError(code);}
 throw new FixtureError(code);
}

export function createLiveFixture(config:Config):(request:Request)=>Promise<Response>{
 // Copy immutable scope: neither a request nor later config mutation may choose
 // a production workspace or email. Wrong configuration produces an inert handler.
 let origin:string,workspaceId:string,challengeHash:string,emails:[string,string],publishableKey:string,serviceKey:string,cryptoKeys:Config['cryptoKeys'];
 try{
  const url=new URL(config.supabaseUrl);
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','CONFIGURATION_INVALID');
  check(typeof config.workspaceId==='string'&&/^fountain-qa-cloud-[a-z0-9][a-z0-9_-]{0,100}$/.test(config.workspaceId),'CONFIGURATION_INVALID');
  check(typeof config.challengeHash==='string'&&/^[a-f0-9]{64}$/.test(config.challengeHash),'CONFIGURATION_INVALID');
  check(Array.isArray(config.emails)&&config.emails.length===2&&new Set(config.emails.map(email=>email.toLowerCase())).size===2&&config.emails.every(email=>typeof email==='string'&&/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,190}\.invalid$/i.test(email)),'CONFIGURATION_INVALID');
  check(typeof config.publishableKey==='string'&&!!config.publishableKey&&typeof config.serviceKey==='string'&&!!config.serviceKey&&Array.isArray(config.cryptoKeys)&&config.cryptoKeys.length>0,'CONFIGURATION_INVALID');
  origin=url.origin;workspaceId=config.workspaceId;challengeHash=config.challengeHash;emails=config.emails.map(email=>email.toLowerCase()) as [string,string];publishableKey=config.publishableKey;serviceKey=config.serviceKey;cryptoKeys=config.cryptoKeys.map(key=>({id:key.id,secret:typeof key.secret==='string'?key.secret:new Uint8Array(key.secret)}));
 }catch{return async()=>missing();}
 const adminHeaders:Record<string,string>={apikey:serviceKey,'Content-Type':'application/json'};
 if(!serviceKey.startsWith('sb_secret_'))adminHeaders.Authorization='Bearer '+serviceKey;
 const rpcNames=new Set(['vault_create','vault_read','resolve_profile','vault_claim_refresh','vault_finish_refresh','vault_release_refresh','vault_revoke','vault_finish_logout','store_snapshot','store_commit','presence_publishers']);
 let busy=false;
 return async(request:Request):Promise<Response>=>{
  // Only server-to-server POST. No Origin, browser cookie, query or alternative
  // path can turn this into a second application API, even with a guessed key.
  const url=new URL(request.url);let path=url.pathname;
  for(const prefix of ['/functions/v1/fountain-verify','/fountain-verify'])if(path.startsWith(prefix+'/')){path=path.slice(prefix.length);break;}
  const nonce=request.headers.get('X-Fountain-Verify')||'';
  if(request.method!=='POST'||request.headers.has('Origin')||request.headers.has('Cookie')||request.headers.get('X-Fountain-Request')!=='1'||url.search||!['/create','/verify','/cleanup','/domain','/activity','/sse','/realtime','/files/begin','/files/chunk','/files/complete','/files/check','/files/cleanup'].includes(path)||!(/^[a-f0-9]{64}$/.test(nonce)||/^[A-Za-z0-9_-]{43}$/.test(nonce)))return missing();
  const supplied=await sha(nonce);let difference=0;for(let index=0;index<64;index++)difference|=supplied.charCodeAt(index)^challengeHash.charCodeAt(index);
  if(difference!==0)return missing();
  if(busy)return response({stage:'busy',errorCode:'FIXTURE_BUSY',status:409},409);
  busy=true;let stage=path.slice(1);const checks:string[]=[],created:Array<{id:string;email:string}>=[];
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),120000);
  const guardedFetch:typeof globalThis.fetch=async(input,init)=>{
   const destination=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
   check(destination.origin===origin,'FIXTURE_SCOPE');
   if(destination.pathname.startsWith('/rest/v1/rpc/fountain_cloud_')){
    check(rpcNames.has(destination.pathname.slice('/rest/v1/rpc/fountain_cloud_'.length))&&typeof init?.body==='string','FIXTURE_SCOPE');
    let body;try{body=JSON.parse(init.body as string);}catch{throw new FixtureError('FIXTURE_SCOPE');}
    check((body.p_workspace_id===workspaceId||body.p_context?.workspaceId===workspaceId)&&(!Object.hasOwn(body,'p_workspace_id')||body.p_workspace_id===workspaceId)&&(!Object.hasOwn(body,'p_context')||body.p_context?.workspaceId===workspaceId),'FIXTURE_SCOPE');
   }else if(destination.pathname.startsWith('/storage/v1/')){
    const prefix='v1/'+await sha(workspaceId)+'/',name=destination.pathname,base='/storage/v1/';
    if(name===base+'bucket/fountain-files')check(init?.method==='GET','FIXTURE_SCOPE');
    else if(name===base+'object/fountain-files'){
      check(init?.method==='DELETE'&&typeof init.body==='string','FIXTURE_SCOPE');
      let body;try{body=JSON.parse(init!.body as string);}catch{throw new FixtureError('FIXTURE_SCOPE');}
      check(Array.isArray(body.prefixes)&&body.prefixes.length<=100&&body.prefixes.every((path:unknown)=>typeof path==='string'&&path.startsWith(prefix)&&!path.includes('..')),'FIXTURE_SCOPE');
    }else{
      const match=/^\/storage\/v1\/object\/(authenticated\/)?fountain-files\/(.*)$/.exec(name);
      check(match&&match[2].startsWith(prefix)&&!match[2].includes('..')&&(match[1]?init?.method==='GET':init?.method==='POST'),'FIXTURE_SCOPE');
    }
   }else check(destination.pathname.startsWith('/auth/v1/'),'FIXTURE_SCOPE');
   return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([deadline.signal,...(init?.signal?[init.signal]:[])])});
  };
  async function admin(method:string,path:string,body?:unknown):Promise<Record<string,any>>{
   const result=await guardedFetch(origin+'/auth/v1/admin/users'+path,{method,headers:{...adminHeaders},signal:AbortSignal.timeout(10000),...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(!result.ok||result.redirected){await result.body?.cancel();throw new FixtureError('ADMIN_REQUEST_REJECTED',502);}
   if(result.status===204)return {};
   const reader=result.body?.getReader();check(reader,'ADMIN_RESPONSE_INVALID');let size=0;const parts:Uint8Array[]=[];
   try{for(;;){const next=await reader!.read();if(next.done)break;size+=next.value.length;if(size>131072)throw new FixtureError('ADMIN_RESPONSE_INVALID');parts.push(next.value);}}
   catch(error){await reader!.cancel().catch(()=>{});throw error;}finally{reader!.releaseLock();}
   try{const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(object(value),'ADMIN_RESPONSE_INVALID');return object(value.user)?value.user:value;}
   catch{throw new FixtureError('ADMIN_RESPONSE_INVALID',502);}
  }
  function verifiedUser(value:Record<string,any>,expectedEmail?:string):void{
   check(typeof value.id==='string'&&UUID.test(value.id)&&typeof value.email==='string'&&emails.includes(value.email)&&(!expectedEmail||value.email===expectedEmail)&&value.app_metadata?.fountain_fixture===challengeHash,'ADMIN_SCOPE_MISMATCH');
  }
  try{
   if(['/activity','/sse','/realtime'].includes(path)){
    check(Object.keys(await readJSON(request)).length===0,'ACTIVITY_INPUT');
    const scope={supabaseUrl:origin,publishableKey,serviceKey,cryptoKeys,workspaceId,emails};
    if(path==='/realtime'){
      return startRealtime(scope,config.realtimeServerToken||serviceKey,request);
    }
    const secrets=await Promise.all([0,1].map(index=>sha(nonce+':fountain-qa-password:'+index))) as [string,string];
    return response({stage:path,checks:await (path==='/activity'?runActivity:runSSE)(scope,secrets,guardedFetch),status:200});
   }
   if(path.startsWith('/files/')){
    const action=path.slice('/files/'.length) as 'begin'|'chunk'|'complete'|'check'|'cleanup';
    const secrets=await Promise.all([0,1].map(index=>sha(nonce+':fountain-qa-password:'+index))) as [string,string];
    let input={};
    if(action==='chunk'){
      const value=request.headers.get('X-Fountain-Test-Offset')||'';
      check(/^\d{1,20}$/.test(value)&&Number.isSafeInteger(Number(value)),'FILE_OFFSET');
      input={offset:Number(value),data:await readBytes(request,4194304)};
    }else check(Object.keys(await readJSON(request)).length===0,'FILE_INPUT');
    return response({stage:path,...await runFiles({supabaseUrl:origin,publishableKey,serviceKey,cryptoKeys,workspaceId,emails},secrets,action,input,guardedFetch),status:200});
   }
   const body=await readJSON(request);
   if(path==='/domain')return response({checks:await runDomain({supabaseUrl:origin,publishableKey,serviceKey,cryptoKeys,workspaceId,emails},passwords(body),guardedFetch),stage:'domain_verified',status:200});
   if(path==='/create'){
    const secrets=passwords(body);
    for(let index=0;index<2;index++){
     const user=await admin('POST','',{email:emails[index],password:secrets[index],email_confirm:true,app_metadata:{fountain_fixture:challengeHash},user_metadata:index===1?{role:'owner'}:{}});
     verifiedUser(user,emails[index]);created.push({id:user.id,email:user.email});
    }
    return response({users:created});
   }
   if(path==='/cleanup'){
    check(Object.keys(body).length===1&&Object.hasOwn(body,'userIds')&&Array.isArray(body.userIds)&&body.userIds.length>=1&&body.userIds.length<=2&&new Set(body.userIds).size===body.userIds.length&&body.userIds.every((id:unknown)=>typeof id==='string'&&UUID.test(id)),'CLEANUP_INPUT_INVALID');
    const users=[];
    for(const id of body.userIds){const user=await admin('GET','/'+id);verifiedUser(user);check(user.id===id,'ADMIN_SCOPE_MISMATCH');users.push(user);}
    // Validate ALL ids before deleting any: caller must remove QA SQL rows first.
    for(const user of users)await admin('DELETE','/'+user.id,{should_soft_delete:false});
    return response({checks:['configured_emails_and_protected_marker_verified','qa_users_deleted'],stage:'cleanup',status:200});
   }
   const secrets=passwords(body),vault=createSessionVault({supabaseUrl:origin,serviceKey,workspaceId,fetch:guardedFetch}),auth=createAuth({supabaseUrl:origin,publishableKey,cryptoKeys,vault,fetch:guardedFetch}),provider=createStoreProvider({supabaseUrl:origin,serviceKey,fetch:guardedFetch});
   const cookies:string[]=[];
   try{
    stage='login';
    for(let index=0;index<2;index++){
     const login=await auth.login({email:emails[index],password:secrets[index]});
     check(login.status===200&&login.body.authenticated===true&&login.body.member&&object(login.body.member)&&login.body.member.role==='member'&&login.body.member.id===(index===0?'alice':'bob')&&login.body.workspace_id===workspaceId&&typeof login.setCookie==='string','LOGIN_IDENTITY');
     cookies.push(login.setCookie!.split(';')[0]);
    }
    const a=await auth.authorize(cookies[0]),b=await auth.authorize(cookies[1]),ctxA=context(a),ctxB=context(b);
    check(ctxA.workspaceId===workspaceId&&ctxB.workspaceId===workspaceId&&ctxA.memberId==='alice'&&ctxB.memberId==='bob'&&ctxA.userId!==ctxB.userId&&ctxA.sessionHash!==ctxB.sessionHash,'CURRENT_IDENTITIES');checks.push('real_password_login_and_verified_legacy_roles','separate_opaque_aes_vault_sessions');
    const actualB=await admin('GET','/'+ctxB.userId);verifiedUser(actualB,emails[1]);check(actualB.user_metadata?.role==='owner'&&b.profile.member.role==='member','UNTRUSTED_METADATA');checks.push('user_metadata_owner_never_grants_owner');
    stage='identity_guards';
    const mismatch=await vault.resolveProfile(ctxA.userId,ctxB.authSessionId),unknown=await vault.resolveProfile(crypto.randomUUID(),ctxA.authSessionId);
    check(mismatch?.authSessionActive===false&&unknown===null,'IDENTITY_RESOLUTION');checks.push('auth_session_user_mismatch_and_unknown_mapping_denied');
    const selected={kinds:['group','teamspace'],ids:{page:['public-page','private-page','counter-page']},metaKeys:['seeded'],pageSize:2};
    await denied(()=>CloudStore.open(provider,{...ctxA,userId:ctxB.userId},selected),401,'MISMATCHED_CONTEXT_ACCEPTED');checks.push('sql_rechecks_opaque_user_session_binding');
    stage='projection';
    const storeA=await CloudStore.open(provider,ctxA,selected),storeB=await CloudStore.open(provider,ctxB,selected);
    const project=(store:CloudStore)=>new Authorization(new Access(store,store.principal)).project('/api/workspace',{pages:['public-page','private-page','counter-page'].map(id=>store.get('page',id)),databases:[],teamspaces:[],members:[]});
    const projectionA=project(storeA),projectionB=project(storeB);
    check(projectionA.pages.some((page:Record<string,any>)=>page.id==='private-page'&&page.access_level===4)&&!projectionB.pages.some((page:Record<string,any>)=>page.id==='private-page')&&projectionB.pages.some((page:Record<string,any>)=>page.id==='public-page'&&page.access_level>=1),'PRIVATE_PROJECTION');checks.push('selected_paged_snapshot_and_private_projection');
    stage='cas';
    const oldA=storeA.get('page','counter-page')!,oldB=storeB.get('page','counter-page')!;
    check(typeof oldA.counter==='undefined'||Number.isSafeInteger(oldA.counter),'COUNTER_FIXTURE');
    const start=Number(oldA.counter||0);
    new Authorization(new Access(storeA,storeA.principal)).prepare('PATCH','/api/pages/counter-page',{title:'QA A winner'});
    new Authorization(new Access(storeB,storeB.principal)).prepare('PATCH','/api/pages/counter-page',{title:'QA B stale'});
    storeA.put('page',{...oldA,title:'QA A winner',counter:start+1});storeB.put('page',{...oldB,title:'QA B stale',counter:start+1});
    const winning=await storeA.commit();await denied(()=>storeB.commit(),409,'STALE_CAS_ACCEPTED');checks.push('real_postgres_cas_one_winner_stale_409');
    stage='lost_ack';let lose=true,lastRequest:CommitRequest|null=null;
    const loseOnce:StoreProvider={snapshot:request=>provider.snapshot(request),commit:async request=>{lastRequest=structuredClone(request);const result=await provider.commit(request);if(lose){lose=false;throw new Error('Simulated lost acknowledgement');}return result;}};
    const retry=await CloudStore.open(loseOnce,ctxA,selected),current=retry.get('page','counter-page')!;
    retry.put('page',{...current,counter:start+2,title:'QA accepted once'});await denied(()=>retry.commit(),503,'LOST_ACK_NOT_UNCERTAIN');
    check(retry.state==='uncertain','LOST_ACK_STATE');let blocked=false;try{retry.get('page','counter-page');}catch{blocked=true;}check(blocked,'UNRESOLVED_READ_ALLOWED');
    const exact=await retry.commit(),after=await CloudStore.open(provider,ctxB,selected);
    check(exact.revision===winning.revision+1&&after.revision===exact.revision&&after.get('page','counter-page')!.counter===start+2,'LOST_ACK_DUPLICATED');checks.push('real_commit_receipt_exact_retry_once','unresolved_ack_blocks_local_reads');
    stage='vault_cas';const row=await vault.read(ctxA.sessionHash);check(row&&row.revokedAt===null&&row.tokens,'VAULT_SESSION_MISSING');
    const firstLease=crypto.randomUUID().replaceAll('-',''),secondLease=crypto.randomUUID().replaceAll('-',''),now=Date.now();
    const claims=await Promise.all([vault.claimRefresh(row!.hash,row!.version,firstLease,now+30000,now),vault.claimRefresh(row!.hash,row!.version,secondLease,now+30000,now)]);
    check(claims.filter(Boolean).length===1,'MULTIPLE_LEASE_OWNERS');const winnerLease=claims[0]?firstLease:secondLease;checks.push('real_vault_concurrent_claim_single_winner');
    // Exercise SQL lease/version/ciphertext CAS ONLY; no provider refresh is claimed.
    check(await vault.finishRefresh(row!.hash,row!.version,winnerLease,row!.tokens!), 'LEASE_FINISH_CAS');
    check(await vault.revoke(row!.hash,Date.now(),{version:row!.version,leaseId:winnerLease})===null,'LATE_OWNER_REVOKED_WINNER');
    const newer=await vault.read(row!.hash);check(newer&&newer.revokedAt===null&&newer.version===row!.version+1,'WINNER_NOT_PRESERVED');checks.push('late_old_owner_conditional_revoke_fenced');
    stage='lease_expiry';const expiryLease=crypto.randomUUID().replaceAll('-',''),issued=Date.now(),until=issued+4000;
    check(await vault.claimRefresh(row!.hash,newer!.version,expiryLease,until,issued),'EXPIRY_LEASE_CLAIM');
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,until-Date.now()+100)));
    const attempted=Date.now();check(await vault.claimRefresh(row!.hash,newer!.version,crypto.randomUUID().replaceAll('-',''),attempted+30000,attempted)===false,'EXPIRED_LEASE_RECLAIMED');
    const expired=await vault.read(row!.hash);check(expired&&expired.revokedAt!==null&&expired.version===newer!.version+1,'EXPIRED_LEASE_NOT_REVOKED');
    check(await vault.finishRefresh(row!.hash,newer!.version,expiryLease,row!.tokens!)===false,'EXPIRED_OWNER_FINISHED');checks.push('actual_elapsed_lease_expiry_revokes_without_token_reclaim');
    stage='revocation';
    await denied(()=>auth.authorize(cookies[0]),401,'REVOKED_AUTH_ACCEPTED');await denied(()=>CloudStore.open(provider,ctxA,selected),401,'REVOKED_SNAPSHOT_ACCEPTED');
    check(lastRequest,'RECEIPT_FIXTURE_MISSING');await denied(()=>provider.commit(lastRequest!),401,'REVOKED_RECEIPT_ACCEPTED');checks.push('revoked_opaque_session_denies_auth_snapshot_and_receipt_ack');
    const stillB=await auth.authorize(cookies[1]),lastB=await CloudStore.open(provider,context(stillB),selected);
    check(stillB.profile.member.id==='bob'&&lastB.get('page','counter-page')!.counter===start+2,'OTHER_ACTOR_DISRUPTED');checks.push('other_actor_session_and_accepted_data_preserved');
    return response({checks,stage:'verified',status:200});
   }finally{
    // Disposable-session cleanup; no secrets escape if a provider is unavailable.
    await Promise.allSettled(cookies.map(cookie=>auth.logout(cookie)));
   }
  }catch(error){
   const allowed=new Set(['AUTH_REQUIRED','AUTH_REJECTED','SETUP_REQUIRED','SESSION_STORAGE_UNAVAILABLE','STORAGE_UNAVAILABLE','STORAGE_RESPONSE_INVALID','REVISION_CONFLICT','COMMIT_UNCERTAIN','STORAGE_LIMIT']);
   const code=error instanceof FixtureError?error.code:error instanceof LiveQAError&&/^[A-Z0-9_]{1,160}$/.test(error.code)?error.code:object(error)&&typeof error.code==='string'&&allowed.has(error.code)?error.code:'FIXTURE_FAILED';
   const status=error instanceof FixtureError?error.status:object(error)&&Number.isSafeInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503;
   // A partial create can be cleaned up with exact ids and protected markers.
   return response({...(path==='/create'&&created.length?{users:created}:{}),checks,stage,errorCode:code,status},status);
  }finally{clearTimeout(timer);busy=false;}
 };
}
