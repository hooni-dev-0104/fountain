/** Sealed, disposable REAL-cloud QA definitions. Importing performs no I/O.
 * Root owns the outer POST/nonce/origin gate, reviewed SQL, exact QA seed,
 * deployment and protected-marker cleanup. No production namespace is accepted.
 * Every route uses the real createApplication; no endpoint/provider shim exists.
 */
import {createApplication} from '../functions/_shared/application.ts';
import {createSessionVault} from '../functions/_shared/vault.ts';
import type {LiveConfig} from './live-domain.ts';
import {liveScope} from './live-domain.ts';

export type LiveAccountsConfig=LiveConfig&{nonceHash:string;expectedChildId?:string};
export type AccountsPhase='bootstrap'|'accounts'|'password'|'unlink'|'relink'|'owner-guard';
export type QAUser={id:string;email:string;memberId:'local'|'child'};
export type AccountsResult={checks:string[];users:QAUser[]};
export class LiveAccountsError extends Error {
  code:string;status:number;checks:string[];users:QAUser[];
  constructor(code:string,status=503,checks:string[]=[],users:QAUser[]=[]){super('Disposable account verification could not complete');this.code=code;this.status=status;this.checks=[...checks];this.users=users.map(user=>({...user}));}
}
const enc=new TextEncoder(),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const phases=new Set<AccountsPhase>(['bootstrap','accounts','password','unlink','relink','owner-guard']);
const RPC=new Set(['vault_create','vault_read','resolve_profile','vault_claim_refresh','vault_finish_refresh','vault_release_refresh','vault_revoke','vault_finish_logout','store_snapshot','store_commit','onboarding_claim','bootstrap_begin','accounts','account_revoke_attempt']);
const check=(condition:unknown,code:string):void=>{if(!condition)throw new LiveAccountsError(code);};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const bytes=async(v:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(v)));
const hex=(v:Uint8Array)=>[...v].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const sha=async(v:string)=>hex(await bytes(v));

/** SERVER-PRIVATE values for Root's empty-body wrapper/SQL seed only. Never
 * serialize this derivation result, place it in a URL, or include it in logs.
 */
export async function deriveAccountInputs(outerNonce:string):Promise<{passwords:[string,string,string];bootstrapNonce:string;nonceHash:string}>{
  check(typeof outerNonce==='string'&&(/^[a-f0-9]{64}$/.test(outerNonce)||/^[A-Za-z0-9_-]{43}$/.test(outerNonce)),'QA_NONCE_INPUT');
  const setup=await bytes(outerNonce+':setup');let raw='';for(const byte of setup)raw+=String.fromCharCode(byte);
  const bootstrapNonce=btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return {passwords:[await sha(outerNonce+':owner'),await sha(outerNonce+':child'),await sha(outerNonce+':child-replacement')],bootstrapNonce,nonceHash:await sha(bootstrapNonce)};
}
async function bounded(response:Response):Promise<Record<string,any>>{
  const reader=response.body?.getReader();check(reader,'QA_JSON');let size=0;const parts:Uint8Array[]=[];
  try{
    for(;;){const next=await reader!.read();if(next.done)break;size+=next.value.length;check(size<=262144,'QA_JSON_BOUND');parts.push(next.value);}
    const all=new Uint8Array(size);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));check(object(value),'QA_JSON');return value;
  }catch{await reader!.cancel().catch(()=>{});throw new LiveAccountsError('QA_JSON');}finally{reader!.releaseLock();}
}

export async function runAccounts(config:LiveAccountsConfig,passwords:[string,string,string],bootstrapNonce:string,phase:AccountsPhase,guardedFetch:typeof fetch):Promise<AccountsResult>{
  let scope:ReturnType<typeof liveScope>;
  try{scope=liveScope(config);}catch{throw new LiveAccountsError('QA_CONFIGURATION',400);}
  check(typeof config.nonceHash==='string'&&/^[a-f0-9]{64}$/.test(config.nonceHash)&&typeof bootstrapNonce==='string'&&/^[A-Za-z0-9_-]{43}$/.test(bootstrapNonce)&&await sha(bootstrapNonce)===config.nonceHash,'QA_SETUP_SCOPE');
  check(phases.has(phase)&&typeof guardedFetch==='function'&&Array.isArray(passwords)&&passwords.length===3&&new Set(passwords).size===3&&passwords.every(p=>typeof p==='string'&&/^[a-f0-9]{64}$/.test(p)),'QA_ARGUMENTS');
  check(config.expectedChildId===undefined||UUID.test(config.expectedChildId),'QA_EXPECTED_CHILD');
  if(phase==='relink')check(typeof config.expectedChildId==='string'&&UUID.test(config.expectedChildId),'QA_RELINK_EXPECTED_CHILD');
  const checks:string[]=[],users:QAUser[]=[],cookies:string[]=[],knownUsers=new Set<string>(),adminCreates=[0,0],appOrigin='https://fountain-qa.example.invalid';
  if(config.expectedChildId)knownUsers.add(config.expectedChildId);
  let step='INITIALIZE';
  const fetchQA:typeof fetch=async(input,init)=>{
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    check(target.origin===scope.supabaseUrl&&!target.username&&!target.password&&!target.hash,'QA_FETCH_SCOPE');
    if(target.pathname.startsWith('/rest/v1/rpc/fountain_cloud_')){
      check(RPC.has(target.pathname.slice('/rest/v1/rpc/fountain_cloud_'.length))&&typeof init?.body==='string'&&!target.search,'QA_RPC_SCOPE');
      let body;try{body=JSON.parse(init!.body as string);}catch{throw new LiveAccountsError('QA_RPC_SCOPE');}
      check((body.p_workspace_id===scope.workspaceId||body.p_context?.workspaceId===scope.workspaceId)&&(!Object.hasOwn(body,'p_workspace_id')||body.p_workspace_id===scope.workspaceId)&&(!Object.hasOwn(body,'p_context')||body.p_context.workspaceId===scope.workspaceId),'QA_RPC_SCOPE');
    }else if(target.pathname==='/auth/v1/admin/users'){
      check(init?.method==='POST'&&typeof init.body==='string'&&!target.search,'QA_ADMIN_SCOPE');let body;try{body=JSON.parse(init!.body as string);}catch{throw new LiveAccountsError('QA_ADMIN_SCOPE');}
      const index=scope.emails.indexOf(body.email);check(index>=0&&body.email_confirm===true&&passwords.includes(body.password)&&object(body.app_metadata),'QA_ADMIN_SCOPE');
      check(Object.keys(body).every(k=>['id','email','password','email_confirm','app_metadata'].includes(k))&&Object.keys(body.app_metadata).length===1&&body.password===passwords[index],'QA_ADMIN_SCOPE');
      if(index===0)check(body.app_metadata.fountain_bootstrap===config.nonceHash&&!body.id,'QA_ADMIN_SCOPE');
      else check(UUID.test(body.id)&&/^[a-f0-9]{32}$/.test(body.app_metadata.fountain_account_intent),'QA_ADMIN_SCOPE');
      adminCreates[index]++;
    }else if(target.pathname.startsWith('/auth/v1/admin/users/')){
      const id=target.pathname.slice('/auth/v1/admin/users/'.length);check(UUID.test(id)&&!target.search&&['GET','PUT'].includes(init?.method??'GET'),'QA_ADMIN_SCOPE');
      // Password/relink writes may only use an already verified QA child UUID.
      if(init?.method==='PUT'){
        check(knownUsers.has(id)&&typeof init.body==='string','QA_ADMIN_SCOPE');let body;try{body=JSON.parse(init.body as string);}catch{throw new LiveAccountsError('QA_ADMIN_SCOPE');}
        check(object(body)&&Object.keys(body).length===2&&Object.hasOwn(body,'password')&&body.password===passwords[2]&&object(body.app_metadata)&&Object.keys(body.app_metadata).length===1&&
          /^[a-f0-9]{32}$/.test(body.app_metadata.fountain_password_intent??body.app_metadata.fountain_account_intent),'QA_ADMIN_SCOPE');
      }
    }else{
      check(['/auth/v1/token','/auth/v1/user','/auth/v1/logout'].includes(target.pathname),'QA_AUTH_SCOPE');
      if(target.pathname==='/auth/v1/token'&&target.searchParams.get('grant_type')==='password'){
        let body;try{body=JSON.parse(init!.body as string);}catch{throw new LiveAccountsError('QA_AUTH_SCOPE');}
        check(scope.emails.includes(body.email)&&passwords.includes(body.password),'QA_AUTH_SCOPE');
      }
    }
    return guardedFetch(input,{...init,redirect:'error'});
  };
  let app:ReturnType<typeof createApplication>;
  try{app=createApplication({...scope,origins:[appOrigin],fetch:fetchQA,setupEnabled:true,env:{}});}catch{throw new LiveAccountsError('QA_APPLICATION_CONFIGURATION');}
  const vault=createSessionVault({...scope,fetch:fetchQA});
  async function raw(cookie:string|null,method:string,path:string,body?:unknown):Promise<Response>{
    check(/^\/api\//.test(path)&&!/[?#]/.test(path),'QA_ROUTE');
    return app(new Request(appOrigin+path,{method,headers:{Origin:appOrigin,'X-Fountain-Request':'1',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  }
  async function json(cookie:string|null,method:string,path:string,body?:unknown,status=200):Promise<Record<string,any>>{
    const response=await raw(cookie,method,path,body);check(response.status===status,'QA_HTTP_'+status);return bounded(response);
  }
  async function signIn(index:0|1,password:string,setup=false):Promise<string>{
    const response=await raw(null,'POST','/api/session',{email:scope.emails[index],password,...(setup?{setup_nonce:bootstrapNonce,create_account:true}:{})});
    const cookie=response.headers.get('Set-Cookie')?.split(';')[0];if(cookie)cookies.push(cookie);
    check(response.status===200&&cookie&&/^fountain_session=[A-Za-z0-9_-]{43}$/.test(cookie),'QA_LOGIN');const value=await bounded(response);
    check(value.authenticated===true&&value.workspace_id===scope.workspaceId&&value.member?.id===(index===0?'local':'child')&&value.member.role===(index===0?'owner':'member')&&value.member.active===true&&value.setup_supported===true,'QA_LOGIN_IDENTITY');
    for(const forbidden of ['access_token','refresh_token','tokens','password','serviceKey'])check(!Object.hasOwn(value,forbidden),'QA_PUBLIC_SECRET');return cookie!;
  }
  async function identity(cookie:string,index:0|1):Promise<QAUser>{
    const session=await json(cookie,'GET','/api/session'),row=await vault.read(await sha(cookie.slice('fountain_session='.length)));
    check(row&&row.revokedAt===null&&row.cacheBinding===session.cache_binding&&session.workspace_id===scope.workspaceId&&session.member?.id===(index===0?'local':'child')&&UUID.test(row.userId),'QA_PRIVATE_IDENTITY');
    if(index===1)knownUsers.add(row!.userId);
    const response=await fetchQA(scope.supabaseUrl+'/auth/v1/admin/users/'+row!.userId,{method:'GET',headers:{apikey:scope.serviceKey,...(!scope.serviceKey.startsWith('sb_secret_')?{Authorization:'Bearer '+scope.serviceKey}:{})},redirect:'error',signal:AbortSignal.timeout(10000)});
    check(response.status===200,'QA_ADMIN_IDENTITY');const result=await bounded(response),user=object(result.user)?result.user:result;
    check(user.id===row!.userId&&user.email===scope.emails[index]&&object(user.app_metadata),'QA_ADMIN_IDENTITY');
    check(index===0?user.app_metadata.fountain_bootstrap===config.nonceHash:/^[a-f0-9]{32}$/.test(user.app_metadata.fountain_account_intent),'QA_PROTECTED_MARKER');
    const safe:QAUser={id:row!.userId,email:scope.emails[index],memberId:index===0?'local':'child'};
    if(!users.some(value=>value.id===safe.id))users.push(safe);return safe;
  }
  async function rejected(cookie:string|null,method:string,path:string,body:unknown,statuses:number[]):Promise<void>{const response=await raw(cookie,method,path,body);check(statuses.includes(response.status),'QA_EXPECTED_DENIAL');await response.body?.cancel();}
  async function noDomain(cookie:string):Promise<void>{await rejected(cookie,'GET','/api/workspace',undefined,[401]);const session=await json(cookie,'GET','/api/session');check(session.authenticated===false,'QA_OPAQUE_REVOKED');}
  try{
    if(phase==='bootstrap'){
      step='EXPLICIT_SETUP';const first=await signIn(0,passwords[0],true),firstUser=await identity(first,0),firstCreates=adminCreates[0];check(firstCreates<=1,'QA_BOOTSTRAP_SINGLE_CREATE');checks.push(firstCreates===1?'real_application_explicit_bootstrap_creates_signed_local_owner_and_opaque_session':'real_application_exact_signed_bootstrap_resume_preserves_local_owner');
      step='REPEATED_SETUP';const second=await signIn(0,passwords[0],true),secondUser=await identity(second,0);
      check(firstUser.id===secondUser.id&&first!==second&&adminCreates[0]===firstCreates,'QA_BOOTSTRAP_REPLAY');checks.push('same_signed_setup_after_discarded_ack_reuses_auth_uuid_no_second_admin_create');
      step='CLIENT_AUTHORITY_DENIED';await rejected(null,'POST','/api/session',{email:scope.emails[0],password:passwords[0],setup_nonce:bootstrapNonce,create_account:true,user_metadata:{role:'owner'}},[400]);
      check(adminCreates[0]===firstCreates,'QA_BOOTSTRAP_FORGED_METADATA');checks.push('explicit_setup_envelope_rejects_client_metadata_no_implicit_owner_signup');
    }else{
      step='OWNER_LOGIN';const owner=await signIn(0,passwords[0]);await identity(owner,0);
      if(phase==='accounts'){
        step='CREATE_CHILD';const member=await json(owner,'POST','/api/accounts',{member_id:'child',password:passwords[1]},201);check(member.id==='child'&&member.role==='member'&&member.has_account===true,'QA_CHILD_ACCOUNT');
        const child=await signIn(1,passwords[1]);await identity(child,1);check(adminCreates[1]<=1,'QA_CHILD_SINGLE_CREATE');checks.push(adminCreates[1]===1?'real_application_owner_creates_existing_child_member_no_provider_role_authority':'real_application_exact_account_creation_receipt_resumed_without_admin_create');
        step='PRIVATE_PROJECTION';const pageId='qa-accounts-private',privateACL={default:'private',inherit:false,members:{},groups:{}};
        const previous=await raw(owner,'GET','/api/pages/'+pageId);let page;
        if(previous.status===404){await previous.body?.cancel();page=await json(owner,'POST','/api/pages',{id:pageId,title:'QA accounts private',permissions:privateACL},201);}
        else{check(previous.status===200,'QA_PRIVATE_FIXTURE');page=(await bounded(previous)).page;check(page?.title==='QA accounts private','QA_PRIVATE_FIXTURE');await json(owner,'PATCH',`/api/pages/${pageId}/permissions`,{permissions:privateACL});}
        check(page.id===pageId&&page.owner_id==='local','QA_PRIVATE_OWNER');
        const before=await json(child,'GET','/api/workspace');check(before.current_member_id==='child'&&!before.pages.some((p:any)=>p.id===pageId),'QA_PRIVATE_PROJECTION');
        await rejected(child,'GET','/api/pages/'+pageId,undefined,[403,404]);await json(owner,'PATCH',`/api/pages/${pageId}/permissions`,{permissions:{...privateACL,members:{child:'view'}}});
        const allowed=await json(child,'GET','/api/pages/'+pageId);check(allowed.page?.id===pageId,'QA_CURRENT_ACL');
        await rejected(child,'PATCH','/api/pages/'+pageId,{title:'not authorized'},[403]);await json(owner,'PATCH',`/api/pages/${pageId}/permissions`,{permissions:privateACL});await rejected(child,'GET','/api/pages/'+pageId,undefined,[403,404]);checks.push('real_child_workspace_private_projection_denial_and_current_view_acl');
        step='INVALID_REQUEST';await rejected(owner,'POST','/api/accounts',{member_id:'child',password:passwords[1],role:'owner'},[400]);await rejected(child,'GET','/api/accounts',undefined,[403]);checks.push('malformed_account_fields_and_nonowner_management_rejected');
      }else if(phase==='password'){
        step='OLD_CHILD_SESSION';const child=await signIn(1,passwords[1]),before=await identity(child,1);
        step='PASSWORD_CHANGE';const changed=await json(owner,'PATCH','/api/accounts/child',{password:passwords[2]});check(changed.id==='child'&&changed.has_account===true,'QA_PASSWORD_RESULT');await noDomain(child);
        await rejected(null,'POST','/api/session',{email:scope.emails[1],password:passwords[1]},[401]);const renewed=await signIn(1,passwords[2]),after=await identity(renewed,1);check(after.id===before.id,'QA_PASSWORD_UUID');checks.push('owner_password_change_revokes_old_opaque_rejects_old_password_preserves_auth_uuid');
      }else if(phase==='unlink'){
        step='CHILD_SESSION';const child=await signIn(1,passwords[2]),before=await identity(child,1);
        step='UNLINK';const unlinked=await json(owner,'DELETE','/api/accounts/child',{});check(unlinked.id==='child'&&unlinked.has_account===false,'QA_UNLINK_RESULT');await noDomain(child);
        // The successful protected GET proves the Auth user was not globally
        // deleted. It does not authorize this unlinked UUID to access the app.
        const response=await fetchQA(scope.supabaseUrl+'/auth/v1/admin/users/'+before.id,{method:'GET',headers:{apikey:scope.serviceKey,...(!scope.serviceKey.startsWith('sb_secret_')?{Authorization:'Bearer '+scope.serviceKey}:{})},redirect:'error'});
        check(response.status===200,'QA_NO_GLOBAL_DELETE');const value=await bounded(response),user=object(value.user)?value.user:value;check(user.id===before.id&&user.email===scope.emails[1],'QA_NO_GLOBAL_DELETE');checks.push('scoped_login_unlink_revokes_old_opaque_and_preserves_real_auth_user');
      }else if(phase==='relink'){
        step='RELINK';const linked=await json(owner,'POST','/api/accounts',{member_id:'child',password:passwords[2]},201);check(linked.id==='child'&&linked.has_account===true,'QA_RELINK_RESULT');
        const child=await signIn(1,passwords[2]),after=await identity(child,1);check(adminCreates[1]===0&&after.id===config.expectedChildId,'QA_RELINK_NO_CREATE');
        // Private UUID continuity is enforced by the reviewed unlink-record RPC;
        // Root additionally compares this ID with the earlier phase's result.
        check(UUID.test(after.id),'QA_RELINK_UUID');checks.push('real_relink_uses_prior_verified_uuid_and_protected_marker_no_admin_create');
      }else{
        step='LAST_OWNER_GUARD';const list=await json(owner,'GET','/api/accounts');check(list.required===true&&list.accounts.some((m:any)=>m.id==='local'&&m.role==='owner'&&m.has_account)&&list.accounts.some((m:any)=>m.id!=='local'&&m.role==='owner'&&m.active!==false&&!m.has_account),'QA_UNLINKED_LEGACY_OWNER_SEED');
        const response=await raw(owner,'DELETE','/api/accounts/local',{});check(response.status===409,'QA_LAST_OWNER_409');const denial=await bounded(response);check(denial.error==='마지막 활성 소유자의 로그인은 해제할 수 없습니다.','QA_SQL_LAST_OWNER_GUARD');
        const current=await json(owner,'GET','/api/session');check(current.authenticated===true&&current.member.id==='local'&&current.member.role==='owner','QA_OWNER_PRESERVED');const again=await signIn(0,passwords[0]);await identity(again,0);checks.push('actual_sql_last_mapped_owner_unlink_refused_despite_unlinked_owner_and_login_survives');
      }
    }
    return {checks:[...checks],users:users.map(user=>({...user}))};
  }catch(error){const suffix=error instanceof LiveAccountsError?error.code:'FAILED';throw new LiveAccountsError('LIVE_ACCOUNTS_'+phase.toUpperCase()+'_'+step+'_'+suffix,503,checks,users);}
  finally{
    const cleanup=await Promise.allSettled(cookies.map(async cookie=>{const response=await raw(cookie,'DELETE','/api/session',{});await response.body?.cancel();return response.status;}));
    if(cleanup.some(result=>result.status==='rejected'||result.value!==200))throw new LiveAccountsError('LIVE_ACCOUNTS_'+phase.toUpperCase()+'_LOGOUT_PENDING',503,checks,users);
  }
}
