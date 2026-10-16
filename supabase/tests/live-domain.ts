/** Root-only disposable QA. This is NOT a production Edge entrypoint.
 * The caller owns nonce/origin gates, deployment, QA user setup and deletion.
 * Every network operation uses the supplied scope-guarded fetch. No secret,
 * provider response, cookie or source document is returned by either runner.
 */
import {createAuth} from '../functions/_shared/auth.ts';
import {createSessionVault} from '../functions/_shared/vault.ts';
import {createStoreProvider,canonicalJSON} from '../functions/_shared/store.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {createBackend} from '../functions/_shared/backend.ts';
import {createDomain} from '../functions/_shared/domain.ts';
import {createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {createAI} from '../functions/_shared/ai.ts';
import type {AuthContext} from '../functions/_shared/auth.ts';

export type LiveConfig={supabaseUrl?:string;url?:string;publishableKey:string;serviceKey:string;cryptoKeys:Array<{id:string;secret:string|Uint8Array}>;workspaceId:string;emails:[string,string]};
export class LiveQAError extends Error {
  code:string;status:number;
  constructor(code:string,status=500){super('Disposable cloud verification failed');this.code=code;this.status=status;}
}
export function qaCheck(condition:unknown,code:string):asserts condition {if(!condition)throw new LiveQAError(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const RPC=new Set(['vault_create','vault_read','resolve_profile','vault_claim_refresh','vault_finish_refresh','vault_release_refresh','vault_revoke','vault_finish_logout','store_snapshot','store_commit','presence_publishers']);
export function liveScope(config:LiveConfig):LiveConfig&{supabaseUrl:string}{
  try{
    const url=new URL(config.supabaseUrl??config.url??'');
    qaCheck(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','QA_CONFIG');
    qaCheck(typeof config.workspaceId==='string'&&/^fountain-qa-cloud-[a-z0-9][a-z0-9_-]{0,100}$/.test(config.workspaceId),'QA_CONFIG');
    qaCheck(Array.isArray(config.emails)&&config.emails.length===2&&new Set(config.emails.map(v=>v.toLowerCase())).size===2&&config.emails.every(v=>typeof v==='string'&&/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,190}\.invalid$/i.test(v)),'QA_CONFIG');
    qaCheck(typeof config.publishableKey==='string'&&!!config.publishableKey&&typeof config.serviceKey==='string'&&!!config.serviceKey&&Array.isArray(config.cryptoKeys)&&config.cryptoKeys.length>0,'QA_CONFIG');
    return {...config,supabaseUrl:url.origin,emails:config.emails.map(v=>v.toLowerCase()) as [string,string],cryptoKeys:config.cryptoKeys.map(k=>({id:k.id,secret:typeof k.secret==='string'?k.secret:new Uint8Array(k.secret)}))};
  }catch{throw new LiveQAError('QA_CONFIG',400);}
}
export function qaPasswords(passwords:[string,string]):void{
  qaCheck(Array.isArray(passwords)&&passwords.length===2&&passwords.every(v=>typeof v==='string'&&v.length>=16&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v)),'QA_PASSWORD_INPUT');
}
/** Reuses real Auth/Vault, SQL RPCs and backend routing. No endpoint shim/model. */
export function createLiveRuntime(config:LiveConfig,guardedFetch:typeof fetch,filesFactory?:(base:{provider:ReturnType<typeof createStoreProvider>;authorize:()=>Promise<AuthContext>;fetch:typeof fetch})=>{handle:(r:Request,p:string,c:AuthContext)=>Promise<Response|null>},activityFactory?:(base:{provider:ReturnType<typeof createStoreProvider>;authorize:()=>Promise<AuthContext>;fetch:typeof fetch})=>(r:Request,p:string,c:AuthContext)=>Promise<Response|null>){
  const scope=liveScope(config);qaCheck(typeof guardedFetch==='function','QA_FETCH_REQUIRED');
  const fetchQA:typeof fetch=async(input,init)=>{
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    qaCheck(target.origin===scope.supabaseUrl,'QA_FETCH_SCOPE');
    if(target.pathname.startsWith('/rest/v1/rpc/fountain_cloud_')){
      qaCheck(RPC.has(target.pathname.slice('/rest/v1/rpc/fountain_cloud_'.length))&&typeof init?.body==='string','QA_FETCH_SCOPE');
      let body;try{body=JSON.parse(init!.body as string);}catch{throw new LiveQAError('QA_FETCH_SCOPE');}
      qaCheck((body.p_workspace_id===scope.workspaceId||body.p_context?.workspaceId===scope.workspaceId)&&(!Object.hasOwn(body,'p_workspace_id')||body.p_workspace_id===scope.workspaceId)&&(!Object.hasOwn(body,'p_context')||body.p_context?.workspaceId===scope.workspaceId),'QA_FETCH_SCOPE');
    }else qaCheck(target.pathname.startsWith('/auth/v1/')||/^\/storage\/v1\/(bucket\/fountain-files|object\/(authenticated\/)?fountain-files(?:\/|$))/.test(target.pathname),'QA_FETCH_SCOPE');
    return guardedFetch(input,{...init,redirect:'error'});
  };
  const vault=createSessionVault({supabaseUrl:scope.supabaseUrl,serviceKey:scope.serviceKey,workspaceId:scope.workspaceId,fetch:fetchQA});
  const auth=createAuth({supabaseUrl:scope.supabaseUrl,publishableKey:scope.publishableKey,cryptoKeys:scope.cryptoKeys,vault,fetch:fetchQA});
  const provider=createStoreProvider({supabaseUrl:scope.supabaseUrl,serviceKey:scope.serviceKey,fetch:fetchQA}),cookies:string[]=[];
  const appOrigin='https://fountain-qa.example.invalid';
  async function request(cookie:string|null,method:string,path:string,body?:unknown,extra:HeadersInit={},signal?:AbortSignal):Promise<Response>{
    qaCheck(path.startsWith('/api/')&&!path.includes('://'),'QA_PATH');
    const authorize=()=>auth.authorize(cookie),extensions=[createAdvancedExtension({cloud:true,env:{}})],base={provider,authorize,fetch:fetchQA};
    const files=filesFactory?.(base),events=activityFactory?.(base),domain=createDomain({...base,extensions,ai:createAI({...base,env:{}}),...(files?{files:files.handle}:{}),...(events?{events}:{})});
    const backend=createBackend({origins:[appOrigin],auth:async()=>auth,domain});
    const headers=new Headers(extra);headers.set('Origin',appOrigin);headers.set('X-Fountain-Request','1');if(cookie)headers.set('Cookie',cookie);
    const raw=body instanceof Uint8Array;if(body!==undefined&&!raw)headers.set('Content-Type','application/json');
    return backend(new Request(appOrigin+path,{method,headers,signal,...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})}));
  }
  async function json(cookie:string|null,method:string,path:string,body?:unknown,status=200):Promise<Record<string,any>>{
    const response=await request(cookie,method,path,body);qaCheck(response.status===status,'QA_HTTP_'+status);
    let value;try{value=await response.json();}catch{throw new LiveQAError('QA_JSON');}qaCheck(object(value),'QA_JSON');return value;
  }
  async function login(index:0|1,password:string):Promise<string>{
    const response=await request(null,'POST','/api/session',{email:scope.emails[index],password});
    qaCheck(response.status===200,'QA_LOGIN');const cookie=response.headers.get('Set-Cookie')?.split(';')[0];
    // Retain even an unexpected identity's cookie for finally logout.
    if(cookie)cookies.push(cookie);const value=await response.json();
    qaCheck(cookie&&value.authenticated===true&&value.workspace_id===scope.workspaceId&&value.member?.id===(index===0?'alice':'bob'),'QA_LOGIN_IDENTITY');return cookie;
  }
  async function close():Promise<void>{await Promise.allSettled(cookies.map(cookie=>request(cookie,'DELETE','/api/session',{})));}
  const transactions=(cookie:string)=>createTransactions({provider,authorize:()=>auth.authorize(cookie)});
  return {scope,request,json,login,close,auth,provider,transactions,fetch:fetchQA};
}

export async function runDomain(config:LiveConfig,passwords:[string,string],guardedFetch:typeof fetch):Promise<string[]>{
  liveScope(config);qaPasswords(passwords);const runtime=createLiveRuntime(config,guardedFetch),checks:string[]=[];let stage='LOGIN';
  try{
    const a=await runtime.login(0,passwords[0]),b=await runtime.login(1,passwords[1]);
    const call=(cookie:string,method:string,path:string,body?:unknown,status=200)=>runtime.json(cookie,method,path,body,status);
    const status=async(cookie:string,method:string,path:string,body?:unknown,allowed=[403,404])=>{const r=await runtime.request(cookie,method,path,body);await r.body?.cancel();qaCheck(allowed.includes(r.status),'QA_DENIAL');};
    const sa=await call(a,'GET','/api/session'),sb=await call(b,'GET','/api/session');
    qaCheck(sa.member.id==='alice'&&sb.member.id==='bob'&&sa.cache_binding!==sb.cache_binding,'QA_SEPARATE_SESSIONS');checks.push('real_gotrue_login_opaque_vault_and_backend_session');
    stage='PRIVATE_PROJECTION';
    const privateACL={default:'private',inherit:false,members:{},groups:{}};
    const page=await call(a,'POST','/api/pages',{title:'QA private document',permissions:privateACL},201),id=page.id;
    qaCheck(typeof id==='string'&&page.owner_id==='alice','QA_PAGE_OWNER');
    const wa=await call(a,'GET','/api/workspace'),wb=await call(b,'GET','/api/workspace');
    qaCheck(wa.pages.some((p:any)=>p.id===id)&&!wb.pages.some((p:any)=>p.id===id)&&wa.workspace_id===runtime.scope.workspaceId,'QA_PRIVATE_PROJECTION');
    await status(b,'GET','/api/pages/'+id);await status(b,'PATCH','/api/pages/'+id,{title:'forbidden'});checks.push('real_sql_private_projection_and_read_write_denial');
    stage='VERSIONS';
    const saved=await call(a,'PUT',`/api/pages/${id}/blocks`,{revision:page.revision,blocks:[{id:'qa-text',type:'paragraph',text:'QA source'}]});
    qaCheck(saved.revision===page.revision+1,'QA_PAGE_REVISION');
    const detail=await call(a,'GET','/api/pages/'+id);qaCheck(Array.isArray(detail.versions)&&detail.versions.length>=1,'QA_VERSION');
    const version=detail.versions[0].id;
    await status(a,'POST',`/api/pages/${id}/versions/${version}/restore`,{revision:page.revision},[409]);
    const restored=await call(a,'POST',`/api/pages/${id}/versions/${version}/restore`,{revision:saved.revision});qaCheck(restored.revision>saved.revision&&restored.blocks.length===0,'QA_RESTORE');
    const comment=await call(a,'POST',`/api/pages/${id}/comments`,{text:'QA comment',author:'bob'},201);qaCheck(comment.author==='alice','QA_COMMENT_AUTHOR');
    checks.push('page_edits_verified_comment_author_stale_409_current_version_restore');
    stage='DATABASE';
    const db=await call(a,'POST','/api/databases',{name:'QA typed table',permissions:privateACL,properties:[{id:'name',name:'Name',type:'title'},{id:'n',name:'Number',type:'number'},{id:'twice',name:'Twice',type:'formula',expression:'prop("n") * 2'}]},201);
    const row=await call(a,'POST',`/api/databases/${db.id}/rows`,{properties:{name:'QA row',n:3}},201);qaCheck(typeof row.id==='string','QA_ROW');
    let table=await call(a,'GET',`/api/databases/${db.id}`);qaCheck(table.rows.some((r:any)=>r.id===row.id&&r.properties.twice===6),'QA_FORMULA');
    await status(a,'PATCH',`/api/databases/${db.id}/rows/${row.id}`,{properties:{n:'invalid'}},[400]);
    await call(a,'PATCH',`/api/databases/${db.id}/rows/${row.id}`,{properties:{n:7}});table=await call(a,'GET',`/api/databases/${db.id}`);qaCheck(table.rows.find((r:any)=>r.id===row.id)?.properties.twice===14,'QA_TYPED_EDIT');
    await status(b,'GET',`/api/databases/${db.id}`);
    await call(a,'PATCH',`/api/databases/${db.id}/permissions`,{permissions:{...privateACL,members:{bob:'view'}}});
    qaCheck((await call(b,'GET',`/api/databases/${db.id}`)).rows.some((r:any)=>r.id===row.id),'QA_CURRENT_ACL');
    await status(b,'PATCH',`/api/databases/${db.id}/rows/${row.id}`,{properties:{n:99}});checks.push('typed_rows_formula_projection_and_current_database_acl');
    stage='COLLABORATION';
    await call(a,'PATCH',`/api/pages/${id}/permissions`,{permissions:{...privateACL,members:{bob:'edit'}}});
    await call(a,'PUT',`/api/pages/${id}/blocks`,{revision:restored.revision,blocks:[{id:'qa-text',type:'paragraph',text:'base'}]});
    const snapshot=await call(a,'GET',`/api/pages/${id}/collaboration`),clientA='qa-a-'+crypto.randomUUID(),clientB='qa-b-'+crypto.randomUUID();
    const opA={id:clientA+':1',client:clientA,clock:1,type:'text.insert',block_id:'qa-text',text:'A',after_id:null};
    const opB={id:clientB+':1',client:clientB,clock:1,type:'text.insert',block_id:'qa-text',text:'B',after_id:null};
    await call(a,'POST',`/api/pages/${id}/operations`,{epoch:snapshot.epoch,ops:[opA]});
    const both=await call(b,'POST',`/api/pages/${id}/operations`,{epoch:snapshot.epoch,ops:[opB]});
    const replay=await call(a,'POST',`/api/pages/${id}/operations`,{epoch:snapshot.epoch,ops:[opA]});qaCheck(replay.seq===both.seq,'QA_OP_REPLAY');
    await status(a,'POST',`/api/pages/${id}/operations`,{epoch:snapshot.epoch,ops:[{id:clientB+':2',client:clientB,clock:2,type:'history.cancel',targets:[opB.id]}]},[403]);
    const undo=await call(a,'POST',`/api/pages/${id}/operations`,{epoch:snapshot.epoch,ops:[{id:clientA+':2',client:clientA,clock:2,type:'history.cancel',targets:[opA.id]}]});
    qaCheck(undo.blocks[0].text.includes('B')&&!undo.blocks[0].text.includes('A'),'QA_FOREIGN_PRESERVED');checks.push('collaboration_exact_replay_targeted_undo_and_foreign_member_denial');
    stage='SYNC';
    const operation={id:'qa-sync-'+crypto.randomUUID(),kind:'page.patch',target_id:id,body:{title:'QA synchronized'},base:{fields:{title:'QA private document'}}},batch={workspace_id:runtime.scope.workspaceId,session_binding:sa.cache_binding,operations:[operation]};
    const first=await call(a,'POST','/api/sync',batch),again=await call(a,'POST','/api/sync',batch);
    qaCheck(first.results?.[0]?.status==='applied'&&again.results?.[0]?.status==='applied'&&canonicalJSON(first.results[0])===canonicalJSON(again.results[0]),'QA_SYNC_RECEIPT');checks.push('sync_operation_real_sql_receipt_repeat');
    stage='AI_UNCONFIGURED';await status(a,'POST','/api/ai',{page_id:id,prompt:'QA'},[503]);checks.push('real_ai_boundary_unconfigured_without_paid_provider_request');
    stage='OWNER_ACCOUNT';
    const initial=await runtime.auth.authorize(a);
    await runtime.transactions(a)(initial,s=>{
      const alice=s.get('member','alice');qaCheck(alice&&alice.role==='member','QA_OWNER_SEED');s.put('member',{...alice,role:'owner'});
      const legacy=s.allocate_id('member');s.put('member',{id:legacy,name:'QA unlinked legacy owner',email:'unlinked-'+crypto.randomUUID()+'@qa.invalid',role:'owner',active:true});
    },{kinds:['member']});
    const deniedLast=await call(a,'DELETE','/api/members/alice',{},409);
    qaCheck(deniedLast.error==='Cannot remove or deactivate the last active owner account','QA_SQL_OWNER_GUARD');
    const still=await call(a,'GET','/api/session');qaCheck(still.authenticated===true&&still.member.role==='owner','QA_LAST_OWNER_PRESERVED');
    const extra=await runtime.login(0,passwords[0]);qaCheck((await call(extra,'GET','/api/session')).member.role==='owner','QA_OWNER_LOGIN_SURVIVES');
    await call(a,'PATCH','/api/members/bob',{role:'owner'});
    await call(a,'PATCH','/api/members/alice',{role:'member'});
    qaCheck((await call(a,'GET','/api/session')).member.role==='member'&&(await call(b,'GET','/api/session')).member.role==='owner','QA_MAPPED_SUCCESSOR');checks.push('actual_sql_last_mapped_auth_owner_rejected_despite_unlinked_owner','actual_sql_mapped_successor_allows_owner_demotion');
    // Leave a repeatable A-owner/B-member fixture for private attachment QA.
    await call(b,'PATCH','/api/members/alice',{role:'owner'});
    await call(b,'PATCH','/api/members/bob',{role:'member'});
    const deniedAgain=await call(a,'PATCH','/api/members/alice',{role:'member'},409);
    qaCheck(deniedAgain.error==='Cannot remove or deactivate the last active owner account','QA_SQL_OWNER_GUARD');
    qaCheck((await call(a,'GET','/api/session')).member.role==='owner'&&(await call(b,'GET','/api/session')).member.role==='member','QA_FINAL_ROLES');checks.push('last_mapped_owner_guard_rechecked_and_file_qa_roles_restored');
    return checks;
  }catch(error){if(error instanceof LiveQAError)throw new LiveQAError(stage+'_'+error.code,error.status);throw new LiveQAError('DOMAIN_'+stage,503);}
  finally{await runtime.close();}
}
