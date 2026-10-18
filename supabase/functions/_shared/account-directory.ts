/** Account directory BFF. No provider token or private child identity reaches clients. */
import {HttpError,canonicalOrigin,jsonResponse,readBytes} from './http.ts';
import {parseAccountSessionCookie} from './account-auth.ts';
import type {AccountPrivateSessionContext} from './account-auth.ts';
import type {AuthResult} from './auth.ts';
import {accountNamespace,WORKSPACE_ID,WORKSPACE_BINDING,workspaceSession} from './workspace-account.ts';
import type {AccountWorkspaceContext} from './workspace-account.ts';
type AccountAuth={login(body:unknown,cookie?:string|null):Promise<AuthResult>;setup?(body:unknown,cookie?:string|null):Promise<AuthResult>;session(cookie?:string|null):Promise<AuthResult>;authorize(cookie?:string|null):Promise<AccountPrivateSessionContext>;logout(cookie?:string|null,options?:{expectedBinding?:string}):Promise<AuthResult>};
type Config={supabaseUrl:string;serviceKey:string;auth:AccountAuth;fetch?:typeof fetch;timeoutMs?:number;clock?:()=>number;publicWebOrigin?:string|null;setupEnabled?:boolean;setup?:(body:Record<string,unknown>,cookie:string|null,workspaceId?:string)=>Promise<AuthResult>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/,CODE=HASH,enc=new TextEncoder();
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=1000):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
function check(v:unknown,status=400,code='INVALID_ACCOUNT_REQUEST'):asserts v{if(!v)throw new HttpError(status,status===503?'계정 요청을 처리하지 못했습니다.':'계정 요청 정보를 확인해주세요.',code);}
function exact(v:Record<string,unknown>,required:string[],optional:string[]=[]){check(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));}
function workspace(v:unknown):string{check(typeof v==='string'&&WORKSPACE_ID.test(v));return v;}
function binding(v:unknown):string{check(typeof v==='string'&&WORKSPACE_BINDING.test(v));return v;}
function uuid(v:unknown):string{check(typeof v==='string'&&UUID.test(v));return v.toLowerCase();}
function label(v:unknown):v is string{return typeof v==='string'&&[...v].length<=1000&&enc.encode(v).length<=4000;}
function display(v:unknown,max=1000):v is string{return typeof v==='string'&&[...v].length>0&&[...v].length<=max&&enc.encode(v).length<=max*4;}
async function body(request:Request){const bytes=await readBytes(request,8192);if(!bytes.length)return{};try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(object(value));return value;}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'올바른 JSON 정보를 보내주세요.');}}
async function read(response:Response,maximum:number){const reader=response.body?.getReader();check(reader,503,'ACCOUNT_UNAVAILABLE');let size=0;const parts:Uint8Array[]=[];try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;check(size<=maximum,503,'ACCOUNT_UNAVAILABLE');parts.push(p.value);}const all=new Uint8Array(size);let offset=0;for(const p of parts){all.set(p,offset);offset+=p.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new HttpError(503,'계정 요청을 처리하지 못했습니다.','ACCOUNT_UNAVAILABLE');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
function sessionResult(result:AuthResult,config:Config){
 const v=result.body;check(v.mode==='account'&&typeof v.authenticated==='boolean'&&typeof v.enabled==='boolean',503,'ACCOUNT_RESPONSE_INVALID');
 let identity:{name:string;email:string}|null=null;
 if(v.authenticated){
  check(object(v.identity)&&display(v.identity.name)&&text(v.identity.email,320)&&typeof v.cache_binding==='string'&&WORKSPACE_BINDING.test(v.cache_binding)&&text(v.expires_at,40)&&Number.isFinite(Date.parse(v.expires_at)),503,'ACCOUNT_RESPONSE_INVALID');
  identity={name:v.identity.name,email:v.identity.email};
 }
 return jsonResponse({enabled:v.enabled,authenticated:v.authenticated,mode:'account',identity,cache_binding:v.authenticated?v.cache_binding:null,expires_at:v.authenticated?v.expires_at:null,...(config.setupEnabled?{setup_supported:true}:{}),...(config.publicWebOrigin?{public_web_origin:config.publicWebOrigin}:{})},result.status,v.authenticated&&result.setCookie?{'Set-Cookie':result.setCookie}:{});
}
export function createAccountDirectory(config:Config){
 const origin=canonicalOrigin(config.supabaseUrl),request=config.fetch??fetch,clock=config.clock??Date.now,timeout=config.timeoutMs??15000;check(text(config.serviceKey,4096)&&integer(timeout)&&timeout>0&&timeout<=15000,503,'ACCOUNT_CONFIGURATION');
 const headers:Record<string,string>={apikey:config.serviceKey,'Content-Type':'application/json',Accept:'application/json'};
 if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey),503,'ACCOUNT_CONFIGURATION');else{try{const p=config.serviceKey.split('.');check(p.length===3);const claims=JSON.parse(atob(p[1].replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-p[1].length%4)%4)));check(claims.role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}catch{throw new HttpError(503,'계정 서비스 설정을 확인해주세요.','ACCOUNT_CONFIGURATION');}}
 function parent(c:AccountPrivateSessionContext){return{sessionHash:c.hash,cacheBinding:c.cacheBinding,userId:c.userId,authSessionId:c.authSessionId};}
 async function fresh(initial:AccountPrivateSessionContext,cookie:string|null){const current=await config.auth.authorize(cookie);if(current.hash!==initial.hash||current.userId!==initial.userId||current.authSessionId!==initial.authSessionId||current.cacheBinding!==initial.cacheBinding||current.expiresAt<=clock())throw new HttpError(409,'계정 로그인이 변경되었습니다.','ACCOUNT_SESSION_CHANGED');return current;}
 async function directoryRequest(initial:AccountPrivateSessionContext,operation:string,workspaceId:string|null,workspaceBinding:string|null,commandId:string|null,value:Record<string,unknown>){
  let response:Response;try{response=await request(origin+'/rest/v1/rpc/fountain_cloud_account_directory',{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),headers:{...headers},body:JSON.stringify({p_session:parent(initial),p_operation:operation,p_workspace_id:workspaceId,p_workspace_binding:workspaceBinding,p_command_id:commandId,p_value:value})});}catch{throw new HttpError(503,'계정 요청을 처리하지 못했습니다.','ACCOUNT_UNAVAILABLE');}
  if(response.redirected){await response.body?.cancel();throw new HttpError(503,'계정 요청을 처리하지 못했습니다.','ACCOUNT_UNAVAILABLE');}
  return{response,result:await read(response,response.ok?2097152:8192)};
 }
 function directoryResult({response,result}:{response:Response;result:unknown}){
  if(!response.ok){const code=object(result)?result.code:undefined,status=typeof code==='string'&&/^PT(?:401|403|404|409|413)$/.test(code)?Number(code.slice(2)):code==='22023'?400:503;
   // Only this fixed database diagnostic proves that a previously selected
   // incarnation ended. Busy transitions and receipt conflicts remain retryable.
   const grantChanged=(code==='PT403'||code==='PT409')&&object(result)&&result.message==='Workspace grant changed';
   throw new HttpError(status,status===401?'계정 로그인이 필요합니다.':status===403?'작업공간 권한을 확인해주세요.':status===409?'작업공간 상태가 변경되었습니다.':'계정 요청을 처리하지 못했습니다.',grantChanged?'WORKSPACE_GRANT_CHANGED':status===401?'AUTH_REQUIRED':status===409?'WORKSPACE_SESSION_CHANGED':status===403?'WORKSPACE_ACCESS_REQUIRED':'ACCOUNT_REQUEST_FAILED');}
  check(object(result),503,'ACCOUNT_RESPONSE_INVALID');return result;
 }
 async function call(initial:AccountPrivateSessionContext,cookie:string|null,operation:string,workspaceId:string|null,workspaceBinding:string|null,commandId:string|null,value:Record<string,unknown>){
  await fresh(initial,cookie);const result=await directoryRequest(initial,operation,workspaceId,workspaceBinding,commandId,value);await fresh(initial,cookie);return directoryResult(result);
 }
 function responseCheck(v:unknown):asserts v{check(v,503,'ACCOUNT_RESPONSE_INVALID');}
 function publicWorkspace(value:Record<string,any>,initial:AccountPrivateSessionContext,expectedId:string){
  responseCheck(value.workspaceId===expectedId&&value.accountBinding===initial.cacheBinding&&object(value.session));const s=value.session;responseCheck(s.enabled===true&&s.authenticated===true&&s.mode==='accounts'&&s.workspace_id===expectedId&&s.account_binding===initial.cacheBinding&&typeof s.cache_binding==='string'&&WORKSPACE_BINDING.test(s.cache_binding)&&typeof s.expires_at==='string'&&Number.isFinite(Date.parse(s.expires_at))&&Date.parse(s.expires_at)>clock()&&Date.parse(s.expires_at)<=initial.expiresAt&&object(s.member));const m=s.member;responseCheck(text(m.id)&&display(m.name)&&typeof m.email==='string'&&m.email.length<=1000&&['owner','admin','member','guest'].includes(m.role)&&m.active===true);
  return{workspace_id:expectedId,account_binding:initial.cacheBinding,session:{enabled:true,required:true,authenticated:true,mode:'accounts',identity:m.name,member:{id:m.id,name:m.name,email:m.email,role:m.role,active:true},workspace_id:expectedId,cache_binding:s.cache_binding,expires_at:s.expires_at,account_binding:initial.cacheBinding}};
 }
 function workspaceContext(v:Record<string,any>,initial:AccountPrivateSessionContext,workspaceId:string,workspaceBinding:string):AccountWorkspaceContext{
  responseCheck(Object.keys(v).length===8&&HASH.test(v.hash)&&v.parentHash===initial.hash&&v.userId===initial.userId&&v.authSessionId===initial.authSessionId&&v.cacheBinding===workspaceBinding&&v.accountBinding===initial.cacheBinding&&integer(v.expiresAt)&&v.expiresAt>clock()&&v.expiresAt<=initial.expiresAt&&object(v.profile));
  const p=v.profile;responseCheck(Object.keys(p).length===3&&p.workspaceId===workspaceId&&p.authSessionActive===true&&object(p.member));const m=p.member;responseCheck(Object.keys(m).length===5&&text(m.id)&&display(m.name)&&typeof m.email==='string'&&m.email.length<=1000&&['owner','admin','member','guest'].includes(m.role)&&m.active===true);
  return{hash:v.hash,userId:v.userId,authSessionId:v.authSessionId,cacheBinding:v.cacheBinding,expiresAt:v.expiresAt,profile:{workspaceId,authSessionActive:true,member:{id:m.id,name:m.name,email:m.email,role:m.role,active:true}},accountBinding:v.accountBinding,parentHash:v.parentHash};
 }
 async function authorizeWorkspace(cookie:string|null,workspaceId:string,workspaceBinding:string):Promise<AccountWorkspaceContext>{
  workspace(workspaceId);binding(workspaceBinding);const initial=await config.auth.authorize(cookie);return workspaceContext(await call(initial,cookie,'context',workspaceId,workspaceBinding,null,{}),initial,workspaceId,workspaceBinding);
 }
 /** Create only at one scoped HTTP entry. SQL rechecks live parent/SID and child
  * authority on every use, including SSE polls; no context result is cached.
  * Provider-only policy changes are checked again at the next HTTP entry (SSE
  * already has a maximum 125-second lifetime). Never retain this across requests.
  */
 async function makeWorkspaceAuthorizer(cookie:string|null,workspaceId:string,workspaceBinding:string):Promise<()=>Promise<AccountWorkspaceContext>>{
  workspace(workspaceId);binding(workspaceBinding);const initial={...await config.auth.authorize(cookie)};
  return async()=>workspaceContext(directoryResult(await directoryRequest(initial,'context',workspaceId,workspaceBinding,null,{})),initial,workspaceId,workspaceBinding);
 }
 async function handle(request:Request,path:string):Promise<Response|null>{
  if(!accountNamespace(path))return null;const route=path.slice('/api/account'.length),url=new URL(request.url),method=request.method,cookie=request.headers.get('Cookie');
  if(route==='/session'){check(!url.search);if(['GET','HEAD'].includes(method))return sessionResult(await config.auth.session(cookie),config);
   if(method==='POST'){const v=await body(request);if(Object.hasOwn(v,'setup_nonce')||Object.hasOwn(v,'create_account')){exact(v,['email','password','setup_nonce'],['create_account','workspace_id']);check(v.create_account===undefined||typeof v.create_account==='boolean');if(v.workspace_id!==undefined)workspace(v.workspace_id);check(config.setupEnabled&&config.setup,503,'SETUP_UNAVAILABLE');return sessionResult(await config.setup(v,cookie,v.workspace_id as string|undefined),config);}exact(v,['email','password']);return sessionResult(await config.auth.login(v,cookie),config);}
   if(method==='DELETE'){const v=await body(request);exact(v,[],['session_binding']);if(v.session_binding!==undefined)binding(v.session_binding);else check(!parseAccountSessionCookie(cookie));return sessionResult(await config.auth.logout(cookie,v.session_binding?{expectedBinding:v.session_binding}:undefined),config);}throw new HttpError(405,'지원하지 않는 계정 요청입니다.');}
  const initial=await config.auth.authorize(cookie);check(initial.expiresAt>clock(),401,'AUTH_REQUIRED');let v:Record<string,any>,operation='',workspaceId:string|null=null,childBinding:string|null=null,commandId:string|null=null,value:Record<string,unknown>={};
  if(['GET','HEAD'].includes(method)){check([...url.searchParams.keys()].every(k=>['session_binding','cursor'].includes(k))&&url.searchParams.getAll('session_binding').length===1&&url.searchParams.getAll('cursor').length<=1);v={session_binding:url.searchParams.get('session_binding'),...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}: {})};}else{check(!url.search);v=await body(request);}
  binding(v.session_binding);if(v.session_binding!==initial.cacheBinding)throw new HttpError(409,'계정 로그인이 변경되었습니다.','ACCOUNT_SESSION_CHANGED');
  if(route==='/workspaces'&&['GET','HEAD'].includes(method)){operation='list';if(v.cursor!==undefined)workspace(v.cursor);value={after:v.cursor??null,limit:100};}
  else if(route==='/workspaces'&&method==='POST'){exact(v,['session_binding','command_id','workspace_id','name']);workspaceId=workspace(v.workspace_id);check(display(v.name,200)&&text(v.name,800)&&v.name.trim().length>0);operation='create';value={name:v.name};}
  else if(/^\/workspaces\/[^/]+\/open$/.test(route)&&method==='POST'){exact(v,['session_binding','command_id','expected_binding']);workspaceId=workspace(route.split('/')[2]);check(v.expected_binding===null||typeof v.expected_binding==='string'&&WORKSPACE_BINDING.test(v.expected_binding));operation='open';value={expectedBinding:v.expected_binding};}
  else if(/^\/workspaces\/[^/]+\/invitations$/.test(route)&&method==='POST'){exact(v,['session_binding','workspace_binding','command_id','email','role','code','expires_at_ms']);workspaceId=workspace(route.split('/')[2]);childBinding=binding(v.workspace_binding);check(text(v.email,320)&&/^[^\s@]+@[^\s@]+$/.test(v.email)&&['admin','member','guest'].includes(v.role)&&typeof v.code==='string'&&CODE.test(v.code)&&integer(v.expires_at_ms));operation='invite';value={email:v.email,role:v.role,nonceHash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(v.code)))].map(b=>b.toString(16).padStart(2,'0')).join(''),expiresAtMs:v.expires_at_ms};}
  else if((route==='/invitation-preview'||route==='/invitation-accept')&&method==='POST'){const accept=route==='/invitation-accept';exact(v,['session_binding','workspace_id','invitation_id','code',...(accept?['command_id']:[])]);workspaceId=workspace(v.workspace_id);check(typeof v.code==='string'&&CODE.test(v.code));operation=accept?'invitation_accept':'invitation_preview';value={invitationId:uuid(v.invitation_id),code:v.code};}
  if(!operation)throw new HttpError(404,'계정 요청 경로를 찾을 수 없습니다.','ACCOUNT_ROUTE_NOT_FOUND');if(!['list','invitation_preview'].includes(operation))commandId=uuid(v.command_id);
  const result=await call(initial,cookie,operation,workspaceId,childBinding,commandId,value);
  if(operation==='list'){responseCheck(result.accountBinding===initial.cacheBinding&&Array.isArray(result.workspaces)&&result.workspaces.length<=100&&(result.nextCursor===null||typeof result.nextCursor==='string'&&WORKSPACE_ID.test(result.nextCursor)));const seen=new Set<string>();let previous=v.cursor??'';const rows=result.workspaces.map((w:any)=>{responseCheck(object(w)&&typeof w.workspaceId==='string'&&WORKSPACE_ID.test(w.workspaceId)&&w.workspaceId>previous&&!seen.has(w.workspaceId)&&label(w.name)&&text(w.memberId)&&['owner','admin','member','guest'].includes(w.role));previous=w.workspaceId;seen.add(w.workspaceId);return{workspace_id:w.workspaceId,name:w.name,member_id:w.memberId,role:w.role};});responseCheck(result.nextCursor===null||rows.length>0&&result.nextCursor===previous);return jsonResponse({workspaces:rows,next_cursor:result.nextCursor,account_binding:initial.cacheBinding});}
  if(['create','open','invitation_accept'].includes(operation))return jsonResponse(publicWorkspace(result,initial,workspaceId!),operation==='create'?201:200);
  responseCheck(result.workspaceId===workspaceId&&result.accountBinding===initial.cacheBinding);const output:Record<string,unknown>={workspace_id:workspaceId,account_binding:initial.cacheBinding};if(operation==='invitation_preview'){responseCheck(label(result.name)&&['admin','member','guest'].includes(result.role));output.workspace_name=result.name;output.role=result.role;}
  responseCheck(typeof result.expiresAt==='string'&&Number.isFinite(Date.parse(result.expiresAt)));output.expires_at=result.expiresAt;if(operation==='invite'){responseCheck(typeof result.invitationId==='string'&&UUID.test(result.invitationId)&&['admin','member','guest'].includes(result.role));output.invitation_id=result.invitationId.toLowerCase();output.role=result.role;}return jsonResponse(output);
 }
 return Object.freeze({handle,authorizeWorkspace,makeWorkspaceAuthorizer});
}
