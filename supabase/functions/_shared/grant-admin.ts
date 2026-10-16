/** Owner-cookie SCIM credential administration. Raw credentials exist only in
 * this request's memory and the first acknowledged creation response. */
import {APIError,is_object,valid_id} from './access.ts';
import type {AuthContext} from './auth.ts';
import {canonicalJSON} from './store.ts';
import {storeContext} from './transaction.ts';
import {canonicalOrigin,checkRequest,jsonResponse,readBytes} from './http.ts';

type Config={supabaseUrl:string;serviceKey:string;workspaceId:string;authorize:()=>Promise<AuthContext>;fetch?:typeof fetch;timeoutMs?:number;origins?:readonly string[];clock?:()=>number};
type Grant={id:string;purpose:'scim';version:number;enabled:boolean;issuer_member_id:string;created_at:string;expires_at:string|null;pending_until:string|null};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/,enc=new TextEncoder(),KEYS=['id','purpose','version','enabled','issuer_member_id','created_at','expires_at','pending_until'];
export class GrantAdminError extends APIError {
  code:string;
  constructor(status=503,code='SCIM_GRANT_UNAVAILABLE'){super(status,status===401?'로그인 세션을 다시 확인해 주세요.':status===403?'소유자만 SCIM 토큰을 관리할 수 있습니다.':'SCIM 토큰 요청을 처리하지 못했습니다. 요청과 현재 상태를 확인해 주세요.');this.name='GrantAdminError';this.code=code;}
}
function check(value:unknown,status=400,code='INVALID_SCIM_GRANT'):asserts value {if(!value)throw new GrantAdminError(status,code);}
function exact(value:Record<string,unknown>,required:string[],optional:string[]=[]):void {check(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
function base64(bytes:Uint8Array):string {let value='';for(const b of bytes)value+=String.fromCharCode(b);return btoa(value).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function decode(value:string):Uint8Array {try{check(/^[A-Za-z0-9_-]+$/.test(value));const text=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));check(base64(bytes)===value);return bytes;}catch{throw new GrantAdminError(400);}}
async function hash(value:string):Promise<string> {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function timestamp(value:unknown):value is string {return typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)&&Number.isFinite(Date.parse(value));}
function metadata(value:unknown):Grant {
  check(is_object(value)&&typeof value.id==='string'&&UUID.test(value.id)&&value.purpose==='scim'&&Number.isSafeInteger(value.version)&&value.version>=1&&typeof value.enabled==='boolean'&&valid_id(value.issuer_member_id)&&timestamp(value.created_at)&&(value.expires_at===null||timestamp(value.expires_at))&&(value.pending_until===null||timestamp(value.pending_until)),503,'SCIM_GRANT_RESPONSE_INVALID');
  return Object.fromEntries(KEYS.map(k=>[k,value[k]])) as Grant;
}
function expiry(value:unknown):string|null {
  if(value===undefined||value===null)return null;
  check(typeof value==='string'&&value.length<=40);
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  check(m);const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
  check(year>=1&&month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate()&&hour<=23&&minute<=59&&second<=59&&(!m[7]||Number(m[7])<=23&&Number(m[8])<=59));
  const ms=Date.parse(value);check(Number.isFinite(ms));return new Date(ms).toISOString();
}

export function createGrantAdmin(config:Config){
  const request=config.fetch??fetch,timeout=config.timeoutMs??10000,clock=config.clock??Date.now;let origin:string,origins:ReadonlySet<string>,headers:Record<string,string>;
  try{
    origin=canonicalOrigin(config.supabaseUrl);check(valid_id(config.workspaceId)&&typeof config.authorize==='function'&&typeof request==='function'&&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=30000);
    origins=new Set((config.origins??[]).map(canonicalOrigin));check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers={'Content-Type':'application/json',apikey:config.serviceKey};
    if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
    else {const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(v=>/^[A-Za-z0-9_-]+$/.test(v)));check(JSON.parse(new TextDecoder().decode(decode(parts[1]))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
  }catch{throw new GrantAdminError(503,'SCIM_GRANT_CONFIGURATION');}
  async function current(initial:AuthContext):Promise<void>{
    const active=await config.authorize();
    check(active.expiresAt>clock()&&active.profile.workspaceId===config.workspaceId&&canonicalJSON(storeContext(active))===canonicalJSON(storeContext(initial)),401,'AUTH_REQUIRED');
    check(active.profile.authSessionActive===true&&active.profile.member.active===true&&active.profile.member.role==='owner',403,'SCIM_GRANT_OWNER_REQUIRED');
  }
  async function rpc(initial:AuthContext,action:string,payload:Record<string,unknown>):Promise<Record<string,any>>{
    await current(initial);let response:Response;
    try{response=await request(origin+'/rest/v1/rpc/fountain_cloud_service_grant_admin',{method:'POST',headers:{...headers},body:JSON.stringify({p_context:storeContext(initial),p_action:action,p_payload:payload}),redirect:'error',signal:AbortSignal.timeout(timeout)});}catch{throw new GrantAdminError();}
    if(response.status!==200||response.redirected){await response.body?.cancel().catch(()=>{});throw new GrantAdminError([400,401,403,404,409,413,429].includes(response.status)?response.status:503);}
    const reader=response.body?.getReader();check(reader,503);const parts:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;check(size<=262144,503);parts.push(next.value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(is_object(result),503);return result;}
    catch{throw new GrantAdminError();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async function body(request:Request):Promise<Record<string,unknown>> {const bytes=await readBytes(request,4096);if(!bytes.length)return {};try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(is_object(value));return value;}catch{throw new GrantAdminError(400);}}
  function cursor(value:string|null):Record<string,string>|null {
    if(value===null)return null;check(value.length>0&&value.length<=2048);let result;
    try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(value)));}catch{throw new GrantAdminError(400);}
    check(is_object(result));exact(result,['workspaceId','created_at','id']);check(result.workspaceId===config.workspaceId&&timestamp(result.created_at)&&typeof result.id==='string'&&UUID.test(result.id));return result;
  }
  async function handle(request:Request,path:string,initial:AuthContext):Promise<Response|null>{
    if(path!=='/api/scim/tokens'&&!path.startsWith('/api/scim/tokens/'))return null;
    checkRequest(request,origins);const match=/^\/api\/scim\/tokens(?:\/([a-f0-9-]+)(\/activate)?)?$/i.exec(path);check(match);const id=match[1];if(id)check(UUID.test(id));
    const method=request.method,url=new URL(request.url);await current(initial);
    if(method==='GET'&&!id){
      check([...url.searchParams.keys()].every(k=>['cursor','limit'].includes(k))&&url.searchParams.getAll('cursor').length<=1&&url.searchParams.getAll('limit').length<=1);
      const raw=url.searchParams.get('limit')??'50';check(/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw));const limit=Number(raw),result=await rpc(initial,'list',{limit,cursor:cursor(url.searchParams.get('cursor'))});
      check(Array.isArray(result.tokens)&&result.tokens.length<=limit&&(result.next_cursor===null||is_object(result.next_cursor)),503);
      const tokens=result.tokens.map(metadata);let next:string|null=null;if(result.next_cursor!==null){const v=result.next_cursor;check(Object.keys(v).length===2&&timestamp(v.created_at)&&typeof v.id==='string'&&UUID.test(v.id),503);next=base64(enc.encode(JSON.stringify({workspaceId:config.workspaceId,created_at:v.created_at,id:v.id})));}
      await current(initial);return jsonResponse({tokens,next_cursor:next});
    }
    check(!url.search,400);let result:Record<string,any>,token:string|undefined;
    if(method==='POST'&&!id){
      const value=await body(request);exact(value,['transaction_id'],['expires_at']);check(typeof value.transaction_id==='string'&&UUID.test(value.transaction_id));
      const expires_at=expiry(value.expires_at);token=base64(crypto.getRandomValues(new Uint8Array(32)));result=await rpc(initial,'create',{id:value.transaction_id.toLowerCase(),expires_at,token_hash:await hash(token)});
      check(typeof result.created==='boolean',503);const grant=metadata(result.grant);check(grant.id===value.transaction_id.toLowerCase()&&grant.issuer_member_id===initial.profile.member.id,503);if(result.created)check(grant.version===1&&!grant.enabled,503);
      await current(initial);return jsonResponse(result.created?{grant,token}:{grant,token_unavailable:true},result.created?201:200);
    }
    if(method==='POST'&&id&&match[2]){const value=await body(request);exact(value,['token']);check(typeof value.token==='string'&&TOKEN.test(value.token)&&decode(value.token).length===32);result=await rpc(initial,'activate',{id:id.toLowerCase(),token_hash:await hash(value.token)});}
    else if(method==='DELETE'&&id&&!match[2]){const value=await body(request);exact(value,[]);result=await rpc(initial,'revoke',{id:id.toLowerCase()});}
    else throw new GrantAdminError(405,'SCIM_GRANT_METHOD_INVALID');
    const grant=metadata(result.grant);check(grant.id===id!.toLowerCase(),503);await current(initial);return jsonResponse({grant});
  }
  return Object.freeze({handle});
}
