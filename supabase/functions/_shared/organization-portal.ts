/** Independent organization BFF. Workspace credentials are consulted only for explicit cross-realm consent. */
import {HttpError,canonicalOrigin,jsonResponse,readBytes} from './http.ts';
import {parseOrganizationSessionCookie} from './organization-auth.ts';
import type {OrganizationPrivateSessionContext} from './organization-auth.ts';
import type {AuthContext,AuthResult} from './auth.ts';
import {storeContext} from './transaction.ts';
type OrganizationAuth={login(body:unknown,cookie?:string|null):Promise<AuthResult>;session(cookie?:string|null):Promise<AuthResult>;authorize(cookie?:string|null):Promise<OrganizationPrivateSessionContext>;logout(cookie?:string|null,options?:{expectedBinding?:string}):Promise<AuthResult>};
type Config={supabaseUrl:string;serviceKey:string;workspaceId:string;auth:OrganizationAuth;workspaceAuthorize:(cookie?:string|null)=>Promise<AuthContext>;fetch?:typeof fetch;timeoutMs?:number;clock?:()=>number};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,BINDING=/^[a-f0-9]{32}$/,CODE=/^[a-f0-9]{64}$/,enc=new TextEncoder();
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const string=(v:unknown,max=1000):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const organizationName=(v:unknown):v is string=>typeof v==='string'&&Array.from(v).length>=1&&Array.from(v).length<=200&&enc.encode(v).length<=800;
const displayName=(v:unknown):v is string=>typeof v==='string'&&Array.from(v).length<=1000&&enc.encode(v).length<=4000;
function check(v:unknown,status=400,code='INVALID_ORGANIZATION_REQUEST'):asserts v{if(!v)throw new HttpError(status,status===503?'조직 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.':'조직 요청 정보를 확인해주세요.',code);}
function exact(v:Record<string,unknown>,required:string[],optional:string[]=[]){check(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));}
function uuid(v:unknown):string{check(typeof v==='string'&&UUID.test(v));return v.toLowerCase();}
function time(v:unknown):string{check(string(v,40)&&/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(v)&&Number.isFinite(Date.parse(v)),503,'ORGANIZATION_RESPONSE_INVALID');return v;}
function binding(v:unknown):string{check(typeof v==='string'&&BINDING.test(v));return v;}
function responseBinding(v:unknown):string{check(typeof v==='string'&&BINDING.test(v),503,'ORGANIZATION_RESPONSE_INVALID');return v;}
function sessionContext(c:OrganizationPrivateSessionContext){return{sessionHash:c.hash,cacheBinding:c.cacheBinding,userId:c.userId,authSessionId:c.authSessionId};}
async function read(response:Response,maximum:number):Promise<unknown>{
 const reader=response.body?.getReader();check(reader,503,'ORGANIZATION_UNAVAILABLE');const parts:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=maximum,503,'ORGANIZATION_UNAVAILABLE');parts.push(part.value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{throw new HttpError(503,'조직 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.','ORGANIZATION_UNAVAILABLE');}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function body(request:Request){const bytes=await readBytes(request,8192);if(!bytes.length)return{};try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(object(value));return value;}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'올바른 JSON 정보를 보내주세요.');}}
function resultSession(result:AuthResult):Response{
 const v=result.body;check(v.mode==='organization'&&typeof v.enabled==='boolean'&&typeof v.authenticated==='boolean',503,'ORGANIZATION_RESPONSE_INVALID');
 const identity=v.authenticated?(check(object(v.identity)&&displayName(v.identity.name)&&string(v.identity.email,320),503,'ORGANIZATION_RESPONSE_INVALID'),{name:v.identity.name,email:v.identity.email}):null;
 if(v.authenticated){responseBinding(v.cache_binding);time(v.expires_at);}
 // Revocation is authoritative in the vault. A delayed anonymous response must
 // never clear a newer HttpOnly login issued by another tab in the meantime.
 return jsonResponse({enabled:v.enabled,authenticated:v.authenticated,mode:'organization',identity,cache_binding:v.authenticated?v.cache_binding:null,expires_at:v.authenticated?v.expires_at:null},result.status,v.authenticated&&result.setCookie?{'Set-Cookie':result.setCookie}:{});
}
function projection(operation:string,value:unknown,sessionBinding:string):Record<string,unknown>{
 check(object(value),503,'ORGANIZATION_RESPONSE_INVALID');const out:Record<string,unknown>={session_binding:sessionBinding};
 const id=(v:unknown)=>{check(typeof v==='string'&&UUID.test(v),503,'ORGANIZATION_RESPONSE_INVALID');return v.toLowerCase();};
 const revision=(v:unknown)=>{check(integer(v),503,'ORGANIZATION_RESPONSE_INVALID');return v;};
 const text=(v:unknown,max=1000)=>{check(string(v,max),503,'ORGANIZATION_RESPONSE_INVALID');return v;};
 const name=(v:unknown)=>{check(organizationName(v),503,'ORGANIZATION_RESPONSE_INVALID');return v;};
 if(operation==='list'){check(Array.isArray(value.organizations)&&value.organizations.length<=100,503,'ORGANIZATION_RESPONSE_INVALID');out.organizations=value.organizations.map(v=>{check(object(v),503);return{organization_id:id(v.organizationId),name:name(v.name),revision:revision(v.revision),grant_id:id(v.grantId)};});return out;}
 if(operation==='setup_eligibility'){
  check(typeof value.eligible==='boolean',503);out.eligible=value.eligible;out.workspace_id=text(value.workspaceId);
  if(value.eligible){check(displayName(value.workspaceName),503,'ORGANIZATION_RESPONSE_INVALID');out.workspace_name=value.workspaceName;out.workspace_binding=responseBinding(value.workspaceBinding);}
  else if(value.reason==='workspace_already_linked')out.reason=value.reason;return out;
 }
 out.organization_id=id(value.organizationId);out.revision=revision(value.revision);
 if(operation==='link_preview'){out.organization_name=name(value.name);out.workspace_id=text(value.workspaceId);check(displayName(value.workspaceName),503);out.workspace_name=value.workspaceName;out.workspace_binding=responseBinding(value.workspaceBinding);out.expires_at=time(value.expiresAt);return out;}
 if(operation==='read'){
  out.name=name(value.name);check(Array.isArray(value.owners)&&value.owners.length<=100&&Array.isArray(value.workspaces)&&value.workspaces.length<=128&&Array.isArray(value.events)&&value.events.length<=100,503);
  out.owners=value.owners.map(v=>{check(object(v)&&typeof v.self==='boolean'&&typeof v.usable==='boolean'&&displayName(v.name)&&typeof v.email==='string'&&v.email.length<=320,503);return{grant_id:id(v.grantId),name:v.name,email:v.email,self:v.self,usable:v.usable};});
  out.workspaces=value.workspaces.map(v=>{check(object(v)&&displayName(v.name),503);return{link_id:id(v.linkId),workspace_id:text(v.workspaceId),name:v.name,linked_at:time(v.linkedAt)};});
  out.events=value.events.map(v=>{check(object(v)&&object(v.details),503);const details:Record<string,unknown>={};for(const key of ['name','source','grantId','linkId','requestId','workspaceId','initiatorGrantId'])if(Object.hasOwn(v.details,key)){const entry=v.details[key];check(key==='name'?organizationName(entry):string(entry),503);details[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())]=entry;}return{id:id(v.id),revision:revision(v.revision),action:text(v.action,100),actor_kind:text(v.actorKind,100),actor_grant_id:v.actorGrantId===null?null:id(v.actorGrantId),occurred_at:time(v.occurredAt),details};});return out;
 }
 check(typeof value.changed==='boolean',503);out.changed=value.changed;
 for(const [source,target] of [['grantId','grant_id'],['linkId','link_id'],['requestId','request_id']] as const)if(Object.hasOwn(value,source))out[target]=id(value[source]);
 if(Object.hasOwn(value,'workspaceId'))out.workspace_id=text(value.workspaceId);
 if(Object.hasOwn(value,'expiresAt'))out.expires_at=time(value.expiresAt);return out;
}
export function createOrganizationPortal(config:Config){
 let origin:string,headers:Record<string,string>;const request=config.fetch??fetch,timeout=config.timeoutMs??15000,clock=config.clock??Date.now;
 try{origin=canonicalOrigin(config.supabaseUrl);check(string(config.workspaceId)&&typeof config.workspaceAuthorize==='function'&&integer(timeout)&&timeout>0&&timeout<=15000);check(string(config.serviceKey,4096));headers={apikey:config.serviceKey,'Content-Type':'application/json',Accept:'application/json'};
  if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
  else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)));const claims=JSON.parse(atob(parts[1].replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-parts[1].length%4)%4)));check(claims.role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
 }catch{throw new HttpError(503,'조직 서비스 설정을 확인해주세요.','ORGANIZATION_CONFIGURATION');}
 async function fresh(initial:OrganizationPrivateSessionContext,cookie:string|null){const current=await config.auth.authorize(cookie);if(current.hash!==initial.hash||current.cacheBinding!==initial.cacheBinding||current.userId!==initial.userId||current.authSessionId!==initial.authSessionId||current.expiresAt<=clock())throw new HttpError(409,'조직 로그인 계정이 변경되었습니다. 다시 시도해주세요.','ORGANIZATION_SESSION_CHANGED');return current;}
 async function workspace(cookie:string|null):Promise<AuthContext>{try{const context=await config.workspaceAuthorize(cookie);check(context.expiresAt>clock()&&context.profile.workspaceId===config.workspaceId&&context.profile.authSessionActive===true&&context.profile.member.active===true&&context.profile.member.role==='owner',403);return context;}catch{throw new HttpError(403,'같은 계정의 작업공간 소유자로 로그인해주세요.','WORKSPACE_AUTH_REQUIRED');}}
 async function rpc(initial:OrganizationPrivateSessionContext,cookie:string|null,operation:string,orgId:string|null,revision:number|null,commandId:string|null,value:Record<string,unknown>,ws:AuthContext|null){
  await fresh(initial,cookie);let response:Response;try{response=await request(origin+'/rest/v1/rpc/fountain_cloud_organization_portal',{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),headers:{...headers},body:JSON.stringify({p_session:sessionContext(initial),p_operation:operation,p_organization_id:orgId,p_expected_revision:revision,p_command_id:commandId,p_value:value,p_workspace_context:ws?storeContext(ws):null})});}catch{throw new HttpError(503,'조직 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.','ORGANIZATION_UNAVAILABLE');}
  if(response.redirected){await response.body?.cancel().catch(()=>{});throw new HttpError(503,'조직 요청을 처리하지 못했습니다.','ORGANIZATION_UNAVAILABLE');}
  if(response.status!==200){const error=await read(response,8192);await fresh(initial,cookie);const code=object(error)?error.code:undefined,message=object(error)?error.message:undefined;
   if(code==='PT409'&&message==='Last usable organization owner')throw new HttpError(409,'사용 가능한 마지막 조직 소유자는 해제할 수 없습니다.','ORGANIZATION_LAST_OWNER');
   if(ws&&code==='PT403'&&['Workspace authentication required','Workspace owner required','Workspace account differs'].includes(message))throw new HttpError(403,'같은 계정의 작업공간 소유자로 로그인해주세요.','WORKSPACE_AUTH_REQUIRED');
   if(ws&&code==='PT409'&&message==='Workspace session changed')throw new HttpError(409,'작업공간 로그인 계정이 변경되었습니다. 다시 확인해주세요.','WORKSPACE_SESSION_CHANGED');
   const status=typeof code==='string'&&/^PT(?:401|403|404|409|413)$/.test(code)?Number(code.slice(2)):code==='22023'?400:503;
   throw new HttpError(status,status===401?'조직 로그인이 필요합니다.':status===403?'조직 작업 권한을 확인해주세요.':status===404?'조직 정보를 찾을 수 없습니다.':status===409?'조직 상태가 변경되었습니다. 새로고침 후 다시 시도해주세요.':'조직 요청을 처리하지 못했습니다.',status===401?'AUTH_REQUIRED':status===409?'ORGANIZATION_CONFLICT':'ORGANIZATION_REQUEST_FAILED');
  }
  const result=await read(response,2097152);await fresh(initial,cookie);return projection(operation,result,initial.cacheBinding);
 }
 async function handle(request:Request,path:string):Promise<Response|null>{
  if(path!=='/api/organization'&&!path.startsWith('/api/organization/'))return null;
  const route=path.slice('/api/organization'.length),method=request.method,url=new URL(request.url),cookie=request.headers.get('Cookie');
  if(route==='/session'){
   check(!url.search);
   if(method==='GET'||method==='HEAD')return resultSession(await config.auth.session(cookie));
   if(method==='POST'){const v=await body(request);exact(v,['email','password']);return resultSession(await config.auth.login(v,cookie));}
   if(method==='DELETE'){const v=await body(request);exact(v,[],['session_binding']);if(v.session_binding!==undefined)binding(v.session_binding);else check(!parseOrganizationSessionCookie(cookie));try{return resultSession(await config.auth.logout(cookie,v.session_binding?{expectedBinding:v.session_binding}:undefined));}catch(error){if(object(error)&&error.status===409&&error.code==='SESSION_CHANGED')throw new HttpError(409,'조직 로그인 계정이 변경되었습니다. 다시 시도해주세요.','ORGANIZATION_SESSION_CHANGED');throw error;}}
   throw new HttpError(405,'지원하지 않는 조직 로그인 요청입니다.');
  }
  const initial=await config.auth.authorize(cookie);check(initial.expiresAt>clock(),401,'AUTH_REQUIRED');
  let value:Record<string,unknown>={},operation='',orgId:string|null=null,revision:number|null=null,commandId:string|null=null,ws:AuthContext|null=null;
  const readMethod=method==='GET'||method==='HEAD';let v:Record<string,any>;
  if(readMethod){check([...url.searchParams.keys()].every(k=>k==='session_binding')&&url.searchParams.getAll('session_binding').length===1);v={session_binding:url.searchParams.get('session_binding')};}
  else{check(!url.search);v=await body(request);}
  binding(v.session_binding);if(v.session_binding!==initial.cacheBinding)throw new HttpError(409,'조직 로그인 계정이 변경되었습니다. 다시 시도해주세요.','ORGANIZATION_SESSION_CHANGED');
  const common=['session_binding','command_id','revision'];
  const match=/^\/organizations\/([a-f0-9-]+)(?:\/(owners|workspace-requests|workspaces)(?:\/([a-f0-9-]+))?)?$/i.exec(route);
  const ineligible=()=>jsonResponse({eligible:false,reason:'workspace_auth_required',workspace_id:config.workspaceId,session_binding:initial.cacheBinding});
  if(route==='/setup-eligibility'&&readMethod){operation='setup_eligibility';try{ws=await workspace(cookie);if(ws.userId!==initial.userId){await fresh(initial,cookie);return ineligible();}}catch(error){if(error instanceof HttpError&&error.code==='WORKSPACE_AUTH_REQUIRED'){await fresh(initial,cookie);return ineligible();}throw error;}}
  else if(route==='/organizations'&&readMethod)operation='list';
  else if(route==='/organizations'&&method==='POST'){exact(v,['session_binding','command_id','organization_id','name','confirm_owner','attach_workspace','workspace_binding']);check(v.confirm_owner===true&&v.attach_workspace===true&&organizationName(v.name)&&string(v.name)&&v.name.trim().length>0);orgId=uuid(v.organization_id);operation='create_from_workspace';ws=await workspace(cookie);check(binding(v.workspace_binding)===ws.cacheBinding,409,'WORKSPACE_SESSION_CHANGED');value={name:v.name,confirm_owner:true,attach_workspace:true,workspace_binding:v.workspace_binding};}
  else if(route==='/bootstrap'&&method==='POST'){exact(v,['session_binding','command_id','organization_id','code']);orgId=uuid(v.organization_id);check(typeof v.code==='string'&&CODE.test(v.code));operation='bootstrap_accept';value={code:v.code};}
  else if((route==='/workspace-preview'||route==='/workspace-accept')&&method==='POST'){
   const accept=route==='/workspace-accept';exact(v,['session_binding','organization_id','request_id','revision','code',...(accept?['command_id','workspace_binding']:[])],accept?[]:['workspace_binding']);orgId=uuid(v.organization_id);check(typeof v.code==='string'&&CODE.test(v.code));ws=await workspace(cookie);if(v.workspace_binding!==undefined)check(binding(v.workspace_binding)===ws.cacheBinding,409,'WORKSPACE_SESSION_CHANGED');operation=accept?'link_accept':'link_preview';value={requestId:uuid(v.request_id),code:v.code,workspace_binding:ws.cacheBinding};
  }
  else if(match){orgId=uuid(match[1]);const section=match[2],item=match[3];
   if(!section&&readMethod)operation='read';
   else if(!section&&method==='PATCH'){exact(v,[...common,'name']);check(organizationName(v.name)&&string(v.name)&&v.name.trim().length>0);operation='rename';value={name:v.name};}
   else if(section==='owners'&&!item&&method==='POST'){exact(v,[...common,'email']);check(string(v.email,320)&&/^[^\s@]+@[^\s@]+$/.test(v.email));operation='owner_grant_email';value={email:v.email};}
   else if(section==='owners'&&item&&method==='DELETE'){exact(v,common);operation='owner_revoke';value={grantId:uuid(item)};}
   else if(section==='workspace-requests'&&!item&&method==='POST'){exact(v,[...common,'workspace_id','code','expires_at_ms']);check(string(v.workspace_id,160)&&typeof v.code==='string'&&CODE.test(v.code)&&integer(v.expires_at_ms));operation='link_request';value={workspaceId:v.workspace_id,nonceHash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(v.code)))].map(b=>b.toString(16).padStart(2,'0')).join(''),expiresAtMs:v.expires_at_ms};}
   else if(section==='workspaces'&&item&&method==='DELETE'){exact(v,common);operation='link_detach';value={linkId:uuid(item)};}
  }
  if(!operation)throw new HttpError(404,'조직 요청 경로를 찾을 수 없습니다.','ORGANIZATION_ROUTE_NOT_FOUND');
  if(!readMethod&&!['link_preview'].includes(operation))commandId=uuid(v.command_id);
  if(!readMethod&&!['create_from_workspace','bootstrap_accept'].includes(operation)){check(integer(v.revision));revision=v.revision;}
  if(ws&&ws.userId!==initial.userId)throw new HttpError(403,'같은 계정의 작업공간 소유자로 로그인해주세요.','WORKSPACE_AUTH_REQUIRED');
  try{const result=await rpc(initial,cookie,operation,orgId,revision,commandId,value,ws);return jsonResponse(result);}
  catch(error){if(operation==='setup_eligibility'&&error instanceof HttpError&&error.status===403){await fresh(initial,cookie);return ineligible();}throw error;}
 }
 return Object.freeze({handle});
}
