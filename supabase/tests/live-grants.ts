/** Definition-only REAL-cloud grant QA. Root owns the sealed gate, users, SQL,
 * deployment and cleanup. No import-time I/O, provider/business model or bearer
 * HTTP SCIM entry is supplied here. Raw grants/cookies/hashes remain RAM-only. */
import {valid_id} from '../functions/_shared/access.ts';
import {createApplication} from '../functions/_shared/application.ts';
import {createSessionVault} from '../functions/_shared/vault.ts';
import {createServiceProvider,normalizeSelection,StoreError} from '../functions/_shared/store.ts';
import type {ScimContext} from '../functions/_shared/store.ts';
import {liveScope} from './live-domain.ts';
import type {LiveConfig} from './live-domain.ts';

export type LiveGrantsConfig=LiveConfig&{expectedPaginationIds?:readonly string[]};
export type GrantsPhase='lifecycle'|'authority'|'response-fence'|'pagination';
export type GrantsCounts={logins:number;grantRPCs:number;acceptedGrantRPCs:number;operatorDroppedACKs:number;responseFences:number;deniedBeforeGrantRPC:number;serviceSnapshots:number;metadataPages:number;paginationPages:number;paginationRows:number;expectedHistoricalRows:number};
export type GrantsResult={phase:GrantsPhase;checks:string[];grantIds:string[];counts:GrantsCounts;allIssuedRevoked:true};
export class LiveGrantsError extends Error {
  code:string;status:number;checks:string[];grantIds:string[];counts:GrantsCounts;
  constructor(code:string,checks:string[],grantIds:string[],counts:GrantsCounts,status=503){super('Disposable grant verification could not complete');this.code=code;this.status=status;this.checks=[...checks];this.grantIds=[...grantIds];this.counts={...counts};}
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,TOKEN=/^[A-Za-z0-9_-]{43}$/,enc=new TextEncoder();
const RPC=new Set(['vault_create','vault_read','resolve_profile','vault_claim_refresh','vault_finish_refresh','vault_release_refresh','vault_revoke','vault_finish_logout','store_snapshot','store_commit','service_grant_admin','service_snapshot']);
const grantKeys=['id','purpose','version','enabled','issuer_member_id','created_at','expires_at','pending_until'];
const forbidden=new Set(['token_hash','creation_digest','auth_user_id','access_token','refresh_token','serviceKey','password','context','sessionHash','authSessionId','cookie','nonce']);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
function bearer():string{let raw='';for(const byte of crypto.getRandomValues(new Uint8Array(32)))raw+=String.fromCharCode(byte);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}

export async function runGrants(config:LiveGrantsConfig,passwords:readonly string[],phase:GrantsPhase,guardedFetch:typeof fetch):Promise<GrantsResult>{
  const checks:string[]=[],owned=new Set<string>(),allocated=new Set<string>(),cookies:string[]=[],tokens=new Map<string,string>(),latest=new Map<0|1,string>();
  const counts:GrantsCounts={logins:0,grantRPCs:0,acceptedGrantRPCs:0,operatorDroppedACKs:0,responseFences:0,deniedBeforeGrantRPC:0,serviceSnapshots:0,metadataPages:0,paginationPages:0,paginationRows:0,expectedHistoricalRows:0};
  const fail=(code:string,status=503):never=>{throw new LiveGrantsError(code,checks,[...owned],counts,status);};
  const check=(v:unknown,code:string):void=>{if(!v)fail(code);};
  let scope:ReturnType<typeof liveScope>;try{scope=liveScope(config);}catch{return fail('QA_CONFIGURATION',400);}
  check(/^fountain-qa-cloud-grants-[a-z0-9][a-z0-9_-]{0,100}$/.test(scope.workspaceId),'QA_GRANTS_NAMESPACE');
  check(['lifecycle','authority','response-fence','pagination'].includes(phase)&&typeof guardedFetch==='function'&&Array.isArray(passwords)&&[2,3].includes(passwords.length)&&passwords.every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)),'QA_ARGUMENTS');
  const appOrigin='https://fountain-qa.example.invalid',deadline=Date.now()+110000;
  let app:ReturnType<typeof createApplication>,stage='INITIALIZE',cleaning=false,rolesChanged=false;
  let fault:{mode:'drop-ack'|'logout';action:string;cookie:string;id?:string}|null=null;
  function privateFree(value:any,allowToken=false):void{
    if(Array.isArray(value)){for(const child of value)privateFree(child,allowToken);return;}
    if(!object(value))return;
    for(const [key,child]of Object.entries(value)){check(!forbidden.has(key)&&(allowToken||key!=='token'),'QA_PUBLIC_SECRET');privateFree(child,allowToken);}
  }
  async function bounded(response:Response):Promise<Record<string,any>>{
    const reader=response.body?.getReader();check(reader,'QA_JSON');let size=0;const parts:Uint8Array[]=[];
    try{for(;;){const next=await reader!.read();if(next.done)break;size+=next.value.length;check(size<=262144,'QA_JSON_LIMIT');parts.push(next.value);}const all=new Uint8Array(size);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));check(object(value),'QA_JSON');return value;}
    catch{return fail('QA_JSON');}finally{await reader!.cancel().catch(()=>{});reader!.releaseLock();}
  }
  function metadata(value:any,id?:string):Record<string,any>{
    check(object(value)&&Object.keys(value).length===grantKeys.length&&grantKeys.every(key=>Object.hasOwn(value,key))&&UUID.test(value.id)&&(!id||value.id===id)&&value.purpose==='scim'&&Number.isSafeInteger(value.version)&&value.version>=1&&typeof value.enabled==='boolean'&&valid_id(value.issuer_member_id),'QA_GRANT_METADATA');
    for(const key of ['created_at','expires_at','pending_until'])check(value[key]===null&&key!=='created_at'||typeof value[key]==='string'&&value[key].length<=40&&Number.isFinite(Date.parse(value[key])),'QA_GRANT_TIMESTAMPS');
    privateFree(value);return value;
  }
  const fetchQA:typeof fetch=async(input,init)=>{
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    check(target.origin===scope.supabaseUrl&&!target.username&&!target.password&&!target.hash,'QA_FETCH_SCOPE');
    let grantCall:Record<string,any>|null=null;
    if(target.pathname.startsWith('/rest/v1/rpc/fountain_cloud_')){
      const name=target.pathname.slice('/rest/v1/rpc/fountain_cloud_'.length);check(RPC.has(name)&&init?.method==='POST'&&typeof init.body==='string'&&!target.search,'QA_RPC_SCOPE');let body;
      try{body=JSON.parse(init!.body as string);}catch{return fail('QA_RPC_SCOPE');}
      check(object(body)&&(body.p_workspace_id===scope.workspaceId||body.p_context?.workspaceId===scope.workspaceId)&&(!Object.hasOwn(body,'p_workspace_id')||body.p_workspace_id===scope.workspaceId)&&(!Object.hasOwn(body,'p_context')||body.p_context.workspaceId===scope.workspaceId),'QA_RPC_WORKSPACE');
      if(name==='service_grant_admin'){grantCall=body;counts.grantRPCs++;check(['create','list','activate','revoke'].includes(body.p_action),'QA_GRANT_ACTION');}
      if(name==='service_snapshot'){counts.serviceSnapshots++;check(body.p_context.kind==='scim'&&body.p_context.memberId==='local'&&owned.has(body.p_context.grantId),'QA_ISSUED_SERVICE_SCOPE');}
    }else{
      check(['/auth/v1/token','/auth/v1/user','/auth/v1/logout'].includes(target.pathname),'QA_AUTH_SCOPE');
      if(target.pathname==='/auth/v1/token'&&target.searchParams.get('grant_type')==='password'){let body;try{body=JSON.parse(init!.body as string);}catch{return fail('QA_AUTH_SCOPE');}const index=scope.emails.indexOf(body.email);check(index>=0&&body.password===passwords[index],'QA_DISPOSABLE_LOGIN');}
    }
    const response=await guardedFetch(input,{...init,redirect:'error'});
    if(grantCall&&response.status===200){
      counts.acceptedGrantRPCs++;const value=await bounded(response.clone());
      if(grantCall.p_action==='create'&&value.created===true){const id=grantCall.p_payload?.id;check(allocated.has(id)&&value.grant?.id===id,'QA_CREATED_ID');owned.add(id);}
      const active=fault;
      if(active&&active.action===grantCall.p_action&&(!active.id||active.id===grantCall.p_payload?.id)){
        fault=null;
        if(active.mode==='drop-ack'){counts.operatorDroppedACKs++;await response.body?.cancel();throw Error('QA_OPERATOR_DISCARDED_REAL_GRANT_RPC_ACK');}
        const logout=await raw(active.cookie,'DELETE','/api/session',{});check(logout.status===200,'QA_REAL_FENCE_LOGOUT');await logout.body?.cancel();counts.responseFences++;
      }
    }
    return response;
  };
  try{app=createApplication({...scope,origins:[appOrigin],fetch:fetchQA,setupEnabled:false,env:{}});}catch{return fail('QA_APPLICATION_CONFIGURATION');}
  const vault=createSessionVault({...scope,fetch:fetchQA}),services=createServiceProvider({...scope,fetch:fetchQA});
  async function raw(cookie:string|null,method:string,path:string,body?:unknown):Promise<Response>{
    check(cleaning||Date.now()<deadline,'QA_PHASE_BUDGET');check(path.startsWith('/api/')&&!/[#\\]/.test(path),'QA_APP_ROUTE');
    return app(new Request(appOrigin+path,{method,headers:{Origin:appOrigin,'X-Fountain-Request':'1',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  }
  async function call(cookie:string|null,method:string,path:string,body:unknown=undefined,status=200,allowToken=false):Promise<Record<string,any>>{
    const response=await raw(cookie,method,path,body);check(response.status===status,'QA_HTTP_'+status);const value=await bounded(response);privateFree(value,allowToken);return value;
  }
  async function reject(cookie:string,method:string,path:string,body:unknown,statuses:number[]):Promise<void>{
    const response=await raw(cookie,method,path,body);check(statuses.includes(response.status),'QA_EXPECTED_DENIAL');const value=await bounded(response);privateFree(value);check(!Object.hasOwn(value,'grant')&&!Object.hasOwn(value,'tokens'),'QA_DENIED_PUBLICATION');
  }
  async function signIn(index:0|1,role?:string):Promise<string>{
    const response=await raw(null,'POST','/api/session',{email:scope.emails[index],password:passwords[index]});const cookie=response.headers.get('Set-Cookie')?.split(';')[0];if(cookie)cookies.push(cookie);
    check(response.status===200&&cookie&&/^fountain_session=[A-Za-z0-9_-]{43}$/.test(cookie),'QA_REAL_LOGIN');const value=await bounded(response);privateFree(value);
    check(value.authenticated===true&&value.workspace_id===scope.workspaceId&&value.member?.id===(index===0?'local':'child')&&value.member.active===true&&(!role||value.member.role===role),'QA_LOGIN_IDENTITY');
    const row=await vault.read(await sha(cookie!.slice('fountain_session='.length)));check(row&&row.revokedAt===null&&row.cacheBinding===value.cache_binding&&UUID.test(row.userId)&&UUID.test(row.authSessionId),'QA_REAL_VAULT_IDENTITY');
    latest.set(index,cookie!);counts.logins++;return cookie!;
  }
  async function session(cookie:string):Promise<Record<string,any>>{return call(cookie,'GET','/api/session');}
  async function owner():Promise<string>{const prior=latest.get(0);if(prior){const value=await session(prior);if(value.authenticated===true&&value.member?.role==='owner')return prior;}return signIn(0,'owner');}
  function allocate():string{const id=crypto.randomUUID();allocated.add(id);return id;}
  async function create(cookie:string):Promise<{id:string;token:string}>{
    const id=allocate(),value=await call(cookie,'POST','/api/scim/tokens',{transaction_id:id},201,true),grant=metadata(value.grant,id);
    check(grant.issuer_member_id==='local'&&!grant.enabled&&grant.version===1&&typeof value.token==='string'&&TOKEN.test(value.token)&&atob(value.token.replace(/-/g,'+').replace(/_/g,'/')+'=').length===32&&!Object.hasOwn(value,'token_unavailable'),'QA_FIRST_INACTIVE_TOKEN');
    tokens.set(id,value.token);return {id,token:value.token};
  }
  async function list(cookie:string,limit=100):Promise<Record<string,any>[]>{
    const rows:Record<string,any>[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<16;page++){
      const value=await call(cookie,'GET','/api/scim/tokens?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):''));counts.metadataPages++;
      check(Array.isArray(value.tokens)&&value.tokens.length<=limit&&(value.next_cursor===null||typeof value.next_cursor==='string'&&value.next_cursor.length<=2048),'QA_BOUNDED_LIST');
      for(const item of value.tokens){const grant=metadata(item);check(!ids.has(grant.id),'QA_DUPLICATE_LIST_ID');ids.add(grant.id);rows.push(grant);}
      if(value.next_cursor===null)return rows;check(!cursors.has(value.next_cursor),'QA_REPEATED_LIST_CURSOR');cursors.add(value.next_cursor);cursor=value.next_cursor;
    }
    return fail('QA_LIST_PAGE_LIMIT');
  }
  async function revoke(cookie:string,id:string):Promise<Record<string,any>>{const value=await call(cookie,'DELETE','/api/scim/tokens/'+id,{}),grant=metadata(value.grant,id);check(grant.enabled===false&&grant.version>=2,'QA_REVOKED_METADATA');return grant;}
  async function serviceSnapshot(context:ScimContext,denied=false):Promise<void>{
    try{const value=await services.snapshot({context,selection:normalizeSelection({ids:{member:['local']},pageSize:2})});check(!denied&&value.workspaceId===scope.workspaceId&&value.memberId==='local'&&value.principal?.id==='local'&&value.principal.role==='owner'&&value.principal.active===true&&value.entities.some(row=>row.kind==='member'&&row.id==='local'),'QA_ISSUED_SERVICE_PRINCIPAL');}
    catch(error){check(denied&&error instanceof StoreError&&error.status===401&&error.code==='AUTH_REQUIRED','QA_ISSUED_SERVICE_DENIAL');return;}
    check(!denied,'QA_INACTIVE_SERVICE_ACCEPTED');
  }
  async function restoreRoles():Promise<void>{
    if(!rolesChanged)return;let local=latest.get(0)??await signIn(0),child=latest.get(1)??await signIn(1),a=await session(local),b=await session(child);
    if(!a.authenticated){local=await signIn(0);a=await session(local);}if(!b.authenticated){child=await signIn(1);b=await session(child);}
    if(a.member.role!=='owner'){check(b.member.role==='owner','QA_ROLE_RESTORE_OWNER_REQUIRED');await call(child,'PATCH','/api/members/local',{role:'owner'});}
    if(b.member.role!=='member')await call(local,'PATCH','/api/members/child',{role:'member'});
    check((await session(local)).member?.role==='owner'&&(await session(child)).member?.role==='member','QA_ROLE_RESTORE');rolesChanged=false;checks.push('actual_owner_and_child_roles_restored');
  }
  let failure:LiveGrantsError|null=null,allIssuedRevoked=false;
  try{
    if(phase==='lifecycle'){
      stage='FIRST_CREATION';const a=await signIn(0,'owner'),first=await create(a),path='/api/scim/tokens/'+first.id;
      const retry=await call(a,'POST','/api/scim/tokens',{transaction_id:first.id});check(retry.token_unavailable===true&&!Object.hasOwn(retry,'token')&&metadata(retry.grant,first.id).enabled===false,'QA_CREATE_RETRY_NO_RAW');checks.push('first_real_creation_inactive_32_byte_token_exact_retry_metadata_only');
      const context:ScimContext={kind:'scim',workspaceId:scope.workspaceId,memberId:'local',grantId:first.id,grantVersion:1,tokenHash:await sha(first.token)};await serviceSnapshot(context,true);checks.push('issued_inactive_grant_real_service_snapshot_denied');
      stage='ACTIVATION_PROOF';let wrong=bearer();while(wrong===first.token)wrong=bearer();await reject(a,'POST',path+'/activate',{token:wrong},[403]);
      fault={mode:'drop-ack',action:'activate',cookie:a,id:first.id};await reject(a,'POST',path+'/activate',{token:first.token},[503]);
      for(let i=0;i<2;i++){const value=await call(a,'POST',path+'/activate',{token:first.token});const grant=metadata(value.grant,first.id);check(grant.enabled===true&&grant.version===1,'QA_ACTIVATION_RETRY');}
      await serviceSnapshot(context);checks.push('real_activation_rpc_ack_operator_drop_exact_retry_and_active_service_principal');
      stage='REVOCATION_REPLAY';fault={mode:'drop-ack',action:'revoke',cookie:a,id:first.id};await reject(a,'DELETE',path,{},[503]);const revoked=await revoke(a,first.id),again=await revoke(a,first.id);check(revoked.version===2&&again.version===2,'QA_REVOKE_EXACT_VERSION');await serviceSnapshot(context,true);checks.push('real_revoke_rpc_ack_operator_drop_exact_terminal_retry_and_old_service_context_denied');
      stage='LOST_CREATION_ACK';const lost=allocate();fault={mode:'drop-ack',action:'create',cookie:a,id:lost};await reject(a,'POST','/api/scim/tokens',{transaction_id:lost},[503]);const unavailable=await call(a,'POST','/api/scim/tokens',{transaction_id:lost});check(unavailable.token_unavailable===true&&!Object.hasOwn(unavailable,'token')&&metadata(unavailable.grant,lost).enabled===false&&unavailable.grant.version===1,'QA_LOST_CREATE_STAYS_INACTIVE');check((await list(a)).some(grant=>grant.id===lost&&!grant.enabled&&grant.version===1),'QA_LOST_CREATE_CURRENT_STATE');checks.push('real_create_rpc_ack_operator_drop_retry_cannot_recover_or_replace_raw_token');
      stage='CONCURRENT_EXACT_CREATE';const concurrent=allocate(),request={transaction_id:concurrent};
      const responses=await Promise.all([raw(a,'POST','/api/scim/tokens',request),raw(a,'POST','/api/scim/tokens',request)]);
      check(responses.map(value=>value.status).sort().join(',')==='200,201','QA_CONCURRENT_CREATE_STATUSES');
      let winningToken:string|null=null,rawCount=0,unavailableCount=0;
      for(const response of responses){const value=await bounded(response);privateFree(value,response.status===201);const grant=metadata(value.grant,concurrent);check(!grant.enabled&&grant.version===1&&grant.issuer_member_id==='local','QA_CONCURRENT_CREATE_METADATA');
        if(response.status===201){check(typeof value.token==='string'&&TOKEN.test(value.token)&&atob(value.token.replace(/-/g,'+').replace(/_/g,'/')+'=').length===32,'QA_CONCURRENT_WINNER_TOKEN');winningToken=value.token;tokens.set(concurrent,value.token);rawCount++;}
        else{check(value.token_unavailable===true&&!Object.hasOwn(value,'token'),'QA_CONCURRENT_LOSER_NO_RAW');unavailableCount++;}}
      check(rawCount===1&&unavailableCount===1&&winningToken,'QA_CONCURRENT_SINGLE_RAW_TOKEN');
      const activated=await call(a,'POST','/api/scim/tokens/'+concurrent+'/activate',{token:winningToken});check(metadata(activated.grant,concurrent).enabled===true,'QA_CONCURRENT_WINNER_PROOF');
      await serviceSnapshot({kind:'scim',workspaceId:scope.workspaceId,memberId:'local',grantId:concurrent,grantVersion:1,tokenHash:await sha(winningToken!)});checks.push('real_concurrent_exact_create_one_201_raw_one_200_unavailable_and_winner_service_proof');
    }else if(phase==='authority'){
      stage='CHILD_MEMBER_DENIED';const a=await signIn(0,'owner'),b=await signIn(1,'member'),before=counts.grantRPCs;
      await reject(b,'GET','/api/scim/tokens',undefined,[403]);await reject(b,'POST','/api/scim/tokens',{transaction_id:crypto.randomUUID()},[403]);check(counts.grantRPCs===before,'QA_CHILD_REACHED_GRANT_RPC');counts.deniedBeforeGrantRPC+=2;checks.push('real_child_member_list_create_forbidden_before_grant_rpc');
      stage='OTHER_OWNER_AUTHORITY';const first=await create(a);rolesChanged=true;await call(a,'PATCH','/api/members/child',{role:'owner'});check((await session(b)).member?.role==='owner','QA_REAL_CHILD_PROMOTION');
      await reject(b,'POST','/api/scim/tokens',{transaction_id:first.id},[409]);await reject(b,'POST','/api/scim/tokens/'+first.id+'/activate',{token:first.token},[403]);await revoke(b,first.id);checks.push('other_real_owner_cannot_adopt_or_activate_issuer_grant_but_can_revoke');
      stage='CURRENT_ISSUER_DEMOTION';const active=await create(a);await call(a,'POST','/api/scim/tokens/'+active.id+'/activate',{token:active.token});await call(b,'PATCH','/api/members/local',{role:'admin'});check((await session(a)).member?.role==='admin','QA_REAL_LOCAL_DEMOTION');
      const deniedAt=counts.grantRPCs;for(const [method,path,body]of [['GET','/api/scim/tokens',undefined],['POST','/api/scim/tokens',{transaction_id:crypto.randomUUID()}],['POST','/api/scim/tokens/'+active.id+'/activate',{token:active.token}],['DELETE','/api/scim/tokens/'+active.id,{}]] as const)await reject(a,method,path,body,[403]);check(counts.grantRPCs===deniedAt,'QA_DEMOTED_OWNER_REACHED_RPC');counts.deniedBeforeGrantRPC+=4;
      await serviceSnapshot({kind:'scim',workspaceId:scope.workspaceId,memberId:'local',grantId:active.id,grantVersion:1,tokenHash:await sha(active.token)},true);checks.push('actual_issuer_demotion_denies_cookie_management_and_issued_service_context_no_bearer_http_claim');await restoreRoles();
    }else if(phase==='pagination'){
      stage='PAGINATION_SEED';const expected=config.expectedPaginationIds;check(Array.isArray(expected)&&expected.length===127&&new Set(expected).size===127&&expected.every(id=>typeof id==='string'&&UUID.test(id)&&id[14]==='7'),'QA_HISTORICAL_UUID7_IDS_REQUIRED');
      const a=await signIn(0,'owner'),beforePages=counts.metadataPages,rows=await list(a,50);counts.paginationPages=counts.metadataPages-beforePages;counts.paginationRows=rows.length;counts.expectedHistoricalRows=expected!.length;
      check(counts.paginationPages>=3&&expected!.every(id=>rows.some(grant=>grant.id===id)),'QA_HISTORICAL_PAGINATION_COMPLETE');checks.push('actual_limit_50_keyset_pages_include_all_127_uuid7_submillisecond_historical_rows_without_duplicates_or_private_hashes');
      stage='CURSOR_WORKSPACE_DENIAL';const first=await call(a,'GET','/api/scim/tokens?limit=50');check(typeof first.next_cursor==='string'&&first.next_cursor.length<=2048,'QA_PAGINATION_CURSOR_REQUIRED');
      let cursor;try{const raw=atob(first.next_cursor.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-first.next_cursor.length%4)%4));cursor=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(raw,value=>value.charCodeAt(0))));}catch{return fail('QA_CURSOR_JSON');}
      check(object(cursor)&&cursor.workspaceId===scope.workspaceId,'QA_CURSOR_WORKSPACE');cursor.workspaceId=scope.workspaceId+'-foreign';let encoded='';for(const byte of enc.encode(JSON.stringify(cursor)))encoded+=String.fromCharCode(byte);const forged=btoa(encoded).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const before=counts.grantRPCs;await reject(a,'GET','/api/scim/tokens?limit=50&cursor='+encodeURIComponent(forged),undefined,[400]);check(counts.grantRPCs===before,'QA_FOREIGN_CURSOR_REACHED_RPC');counts.deniedBeforeGrantRPC++;checks.push('actual_workspace_forged_cursor_rejected_before_grant_rpc');
    }else{
      let activeId:string|null=null;
      for(const action of ['create','list','activate','revoke']){
        stage='RESPONSE_FENCE_'+action.toUpperCase();const a=await signIn(0,'owner');let path='/api/scim/tokens',method='GET',body:unknown=undefined,id:string|undefined;
        if(action==='create'){id=allocate();method='POST';body={transaction_id:id};}
        else if(action==='list')check((await list(a)).some(grant=>owned.has(grant.id)&&!grant.enabled),'QA_FENCED_CREATE_COMMITTED_INACTIVE');
        else if(action==='activate'){const fresh=await create(a);id=fresh.id;activeId=id;path+='/'+id+'/activate';method='POST';body={token:fresh.token};}
        else{check(activeId,'QA_FENCE_ACTIVE_ID');id=activeId!;check((await list(a)).some(grant=>grant.id===id&&grant.enabled&&grant.version===1),'QA_FENCED_ACTIVATION_COMMITTED');path+='/'+id;method='DELETE';body={};}
        fault={mode:'logout',action,cookie:a,...(id?{id}:{})};await reject(a,method,path,body,[401]);check(fault===null,'QA_REAL_RESPONSE_FENCE_NOT_TRIGGERED');check((await session(a)).authenticated===false,'QA_ORIGINAL_COOKIE_REVOKED');checks.push('real_'+action+'_rpc_completed_original_cookie_logout_blocks_response_publication');
      }
      check(counts.responseFences===4,'QA_FOUR_RESPONSE_FENCES');
    }
  }catch(error){failure=new LiveGrantsError('LIVE_GRANTS_'+phase.toUpperCase().replaceAll('-','_')+'_'+stage+'_'+(error instanceof LiveGrantsError?error.code:'FAILED'),checks,[...owned],counts);}
  finally{
    fault=null;cleaning=true;let cleanupFailed=false;
    try{await restoreRoles();const a=await owner();for(const id of owned)await revoke(a,id);const current=await list(a);check([...owned].every(id=>current.some(grant=>grant.id===id&&!grant.enabled&&grant.version>=2)),'QA_FINAL_REVOKED');allIssuedRevoked=true;checks.push('all_phase_issued_grants_really_revoked_before_logout');}catch{cleanupFailed=true;}
    const ended=await Promise.allSettled(cookies.map(async cookie=>{const response=await raw(cookie,'DELETE','/api/session',{});check(response.status===200,'QA_FINAL_LOGOUT');await response.body?.cancel();}));tokens.clear();latest.clear();
    if(ended.some(value=>value.status==='rejected'))cleanupFailed=true;
    if(cleanupFailed)failure=new LiveGrantsError('LIVE_GRANTS_'+phase.toUpperCase().replaceAll('-','_')+'_CLEANUP_PENDING',checks,[...owned],counts);
  }
  if(failure)throw failure;check(allIssuedRevoked,'QA_FINAL_STATE');return {phase,checks:[...checks],grantIds:[...owned],counts:{...counts},allIssuedRevoked:true};
}
