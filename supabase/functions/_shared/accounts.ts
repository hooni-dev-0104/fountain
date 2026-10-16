/** Owner-managed family logins. Auth Admin I/O and SQL are separate operations:
 * a durable intent plus a preallocated UUID/privileged marker permits bounded
 * exact recovery, never email search, user_metadata linking or global deletion.
 */
import {AuthError} from './auth.ts';
import type {AuthContext} from './auth.ts';
import {APIError,is_object,valid_id} from './access.ts';
import {canonicalJSON} from './store.ts';
import {storeContext} from './transaction.ts';
import {jsonResponse,readJSON} from './http.ts';
type Config={supabaseUrl:string;serviceKey:string;workspaceId:string;authorize:()=>Promise<AuthContext>;fetch?:typeof fetch;timeoutMs?:number};
type Intent={id:string;kind:'create'|'password';state:'prepared'|'attempted'|'done';userId:string;nonce:string;digest:string;member:Record<string,any>;relink:boolean;providerEmail:string;priorMarker:{account:string|null;password:string|null}};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/,enc=new TextEncoder();
const memberID=(value:unknown):value is string=>typeof value==='string'&&valid_id(value)&&!/[\/\\]/.test(value)&&!['.','..'].includes(value);
export class AccountError extends APIError {
  code:string;
  constructor(status=503,code='ACCOUNT_UNAVAILABLE',message='계정 설정을 완료하지 못했습니다. 다시 로그인하거나 관리자에게 확인해 주세요.'){super(status,message);this.name='AccountError';this.code=code;}
}
const check=(value:unknown,status=400,code='INVALID_ACCOUNT_INPUT'):void=>{if(!value)throw new AccountError(status,code,status===400?'계정 요청을 확인해 주세요.':'계정 설정을 확인할 수 없습니다.');};
function safe(value:unknown):Record<string,any>{
  check(is_object(value)&&typeof value.id==='string'&&valid_id(value.id)&&typeof value.name==='string'&&typeof value.email==='string'&&['owner','admin','member','guest'].includes(value.role)&&typeof value.active==='boolean'&&typeof value.has_account==='boolean',503,'ACCOUNT_RESPONSE_INVALID');
  return Object.fromEntries(['id','name','email','role','active','has_account'].map(key=>[key,(value as Record<string,any>)[key]]));
}
function intent(value:unknown):Intent {
  check(is_object(value)&&UUID.test(value.id)&&['create','password'].includes(value.kind)&&['prepared','attempted','done'].includes(value.state)&&UUID.test(value.userId)&&/^[a-f0-9]{32}$/.test(value.nonce)&&HASH.test(value.digest)&&typeof value.relink==='boolean'&&typeof value.providerEmail==='string'&&value.providerEmail.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.providerEmail)&&is_object(value.priorMarker)&&['account','password'].every(k=>value.priorMarker[k]===null||typeof value.priorMarker[k]==='string'),503,'ACCOUNT_RESPONSE_INVALID');
  return {...value,member:safe(value.member)} as Intent;
}
export function createAccounts(config:Config){
  let origin:string,headers:Record<string,string>;const request=config.fetch??globalThis.fetch,timeout=config.timeoutMs??10000;
  try{
    const u=new URL(config.supabaseUrl);check((u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/');
    check(valid_id(config.workspaceId)&&typeof request==='function'&&Number.isSafeInteger(timeout)&&timeout>=1&&timeout<=30000&&typeof config.authorize==='function');
    check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers={apikey:config.serviceKey,'Content-Type':'application/json'};
    if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
    else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(v=>/^[A-Za-z0-9_-]+$/.test(v)));const payload=JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-parts[1].length%4)%4)));check(payload.role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
    origin=u.origin;
  }catch{throw new AccountError(503,'ACCOUNT_CONFIGURATION','계정 관리 설정이 필요합니다.');}
  const hmacKey=crypto.subtle.importKey('raw',enc.encode(config.serviceKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  async function fingerprint(kind:string,memberId:string,password:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey,enc.encode(canonicalJSON(['fountain-account-v1',config.workspaceId,kind,memberId,password]))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
  async function bounded(response:Response):Promise<Record<string,any>>{
    const reader=response.body?.getReader();if(!reader)throw new AccountError();const parts:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>262144)throw new AccountError(503,'ACCOUNT_RESPONSE_INVALID');parts.push(next.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!is_object(value))throw Error();return value;
    }catch{await reader.cancel().catch(()=>{});throw new AccountError(503,'ACCOUNT_RESPONSE_INVALID');}finally{reader.releaseLock();}
  }
  async function call(path:string,method:string,body?:unknown,missing=false):Promise<Record<string,any>|null>{
    let response;try{response=await request(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw new AccountError();}
    if(response.redirected){await response.body?.cancel();throw new AccountError();}
    if(!response.ok){
      let lastOwner=false;
      if(response.status===409&&path.startsWith('/rest/v1/rpc/')){
        const diagnostic=await bounded(response).catch(()=>null);lastOwner=diagnostic?.code==='PT409'&&diagnostic.message==='LAST_OWNER_ACCOUNT';
      }
      await response.body?.cancel();if(missing&&response.status===404)return null;
      if(lastOwner)throw new AccountError(409,'LAST_OWNER_ACCOUNT','마지막 활성 소유자의 로그인은 해제할 수 없습니다.');
      if(path.startsWith('/auth/v1/admin/')&&[401,403].includes(response.status))throw new AccountError();
      if(path.startsWith('/auth/v1/admin/')&&[400,422].includes(response.status))throw new AccountError(400,'ACCOUNT_PROVIDER_REJECTED','비밀번호나 계정 정보가 인증 서비스의 조건을 충족하지 않습니다.');
      if(response.status===401||response.status===403)throw new AccountError(response.status,'ACCOUNT_DENIED','계정 관리 권한을 다시 확인해 주세요.');
      if(response.status===404)throw new AccountError(404,'ACCOUNT_NOT_FOUND','활성 가족 계정이나 연결을 찾을 수 없습니다.');
      if(response.status===409||response.status===422)throw new AccountError(409,'ACCOUNT_CONFLICT','계정 연결 상태가 변경되었거나 복구 확인이 필요합니다.');
      if(response.status===400)throw new AccountError(400,'INVALID_ACCOUNT_INPUT','계정 요청을 확인해 주세요.');throw new AccountError();}
    return bounded(response);
  }
  async function current(initial:AuthContext):Promise<AuthContext>{
    const active=await config.authorize();
    if(active.profile.workspaceId!==config.workspaceId||canonicalJSON(storeContext(active))!==canonicalJSON(storeContext(initial)))throw new AuthError(401,'AUTH_REQUIRED','로그인 세션이 변경되었습니다. 다시 로그인해 주세요.');
    if(!active.profile.member.active||active.profile.member.role!=='owner')throw new AccountError(403,'ACCOUNT_OWNER_REQUIRED','소유자만 가족 로그인을 관리할 수 있습니다.');return active;
  }
  async function rpc(initial:AuthContext,action:string,values:Record<string,unknown>={}):Promise<Record<string,any>>{
    await current(initial);return (await call('/rest/v1/rpc/fountain_cloud_accounts','POST',{p_context:storeContext(initial),p_action:action,...values}))!;
  }
  async function proof(initial:AuthContext,item:Intent):Promise<void>{await rpc(initial,'check',{p_member_id:item.member.id,p_intent_id:item.id,p_digest:item.digest});}
  async function revokeOnly(initial:AuthContext,item:Intent):Promise<void>{
    // Denial-only capability from a SQL-authenticated password intent. This MUST
    // work even if Auth reset ended the original actor's session. It cannot link,
    // change passwords, delete users, or affect any other workspace's vault.
    await call('/rest/v1/rpc/fountain_cloud_account_revoke_attempt','POST',{p_context:storeContext(initial),p_member_id:item.member.id,p_intent_id:item.id,p_digest:item.digest});
  }
  function marked(user:Record<string,any>|null,item:Intent):boolean{
    const data=is_object(user?.user)?user.user:user;
    return !!data&&data.id===item.userId&&typeof data.email==='string'&&data.email.toLowerCase()===item.providerEmail.toLowerCase()&&is_object(data.app_metadata)&&data.app_metadata[item.kind==='create'?'fountain_account_intent':'fountain_password_intent']===item.nonce;
  }
  async function mutate(initial:AuthContext,kind:'create'|'password',memberId:string,password:unknown):Promise<Record<string,any>>{
    check(memberID(memberId)&&typeof password==='string'&&Array.from(password).length>=10&&Array.from(password).length<=1024&&!/[\x00-\x1f\x7f]/.test(password));
    const digest=await fingerprint(kind,memberId,password as string),nonce=crypto.randomUUID().replaceAll('-','');
    const item=intent(await rpc(initial,'begin',{p_member_id:memberId,p_kind:kind,p_digest:digest,p_intent_id:crypto.randomUUID(),p_nonce:nonce,p_user_id:crypto.randomUUID()}));
    check(item.kind===kind&&item.member.id===memberId&&item.digest===digest,503,'ACCOUNT_RESPONSE_INVALID');
    if(item.state==='done')return item.member;
    const claimed=await rpc(initial,'claim',{p_member_id:memberId,p_intent_id:item.id,p_digest:digest});check(typeof claimed.claimed==='boolean',503,'ACCOUNT_RESPONSE_INVALID');
    let user:Record<string,any>|null=null,attemptedPassword=false,knownRejection=false;
    async function adminAttempt(path:string,method:string,body:unknown):Promise<Record<string,any>|null>{
      try{return await call(path,method,body);}catch(error){
        if(error instanceof AccountError&&error.code==='ACCOUNT_PROVIDER_REJECTED'){
          knownRejection=true;
          await rpc(initial,'reject',{p_member_id:memberId,p_intent_id:item.id,p_digest:digest});
          throw error;
        }
        return null; // Unknown outcome: only an exact UUID/marker read may prove it.
      }
    }
    try{
      if(claimed.claimed){
        await proof(initial,item); // SQL current target snapshot immediately before external I/O.
        if(kind==='create'&&!item.relink){
          user=await adminAttempt('/auth/v1/admin/users','POST',{id:item.userId,email:item.providerEmail,password,email_confirm:true,app_metadata:{fountain_account_intent:item.nonce}});
        }else{
          if(item.relink){
            const previous=await call('/auth/v1/admin/users/'+item.userId,'GET',undefined,true),data=is_object(previous?.user)?previous.user:previous;
            check(data&&data.id===item.userId&&typeof data.email==='string'&&data.email.toLowerCase()===item.providerEmail.toLowerCase()&&is_object(data.app_metadata)&&
              (data.app_metadata.fountain_account_intent??null)===item.priorMarker.account&&(data.app_metadata.fountain_password_intent??null)===item.priorMarker.password,409,'ACCOUNT_RELINK_CHANGED');
            await proof(initial,item);
          }
          attemptedPassword=true;
          user=await adminAttempt('/auth/v1/admin/users/'+item.userId,'PUT',{password,app_metadata:{[kind==='create'?'fountain_account_intent':'fountain_password_intent']:item.nonce}});
        }
      }
      if(!marked(user,item)){
        await proof(initial,item);
        user=await call('/auth/v1/admin/users/'+item.userId,'GET',undefined,true);
      }
      if(!marked(user,item))throw new AccountError(503,'ACCOUNT_RECOVERY_REQUIRED','설정 결과를 확정할 수 없습니다. 관리자가 연결 기록을 확인해야 합니다.');
      // SQL independently verifies protected Auth app_metadata, exact UUID,
      // target member snapshot, mapping and current owner before publication.
      const result=safe(await rpc(initial,'finish',{p_member_id:memberId,p_intent_id:item.id,p_digest:digest}));
      check(result.id===memberId&&result.has_account===true,503,'ACCOUNT_RESPONSE_INVALID');return result;
    }finally{
      if(!knownRejection&&(kind==='password'||item.relink)&&(claimed.claimed||item.state==='attempted'||attemptedPassword))await revokeOnly(initial,item);
    }
  }
  async function handle(request:Request,path:string,initial:AuthContext):Promise<Response|null>{
    let decoded;try{decoded=decodeURIComponent(path);}catch{throw new AccountError(400,'INVALID_ACCOUNT_INPUT');}
    if(decoded!=='/api/accounts'&&!decoded.startsWith('/api/accounts/'))return null;
    const method=request.method==='HEAD'?'GET':request.method,parts=decoded.split('/');
    if(decoded==='/api/accounts'&&method==='GET'){
      const result=await rpc(initial,'list');check(Array.isArray(result.accounts)&&result.accounts.length<=1000&&result.required===true,503,'ACCOUNT_RESPONSE_INVALID');
      return jsonResponse({accounts:result.accounts.map(safe),required:true});
    }
    if(decoded==='/api/accounts/enable'&&method==='POST'){const body=await readJSON(request);check(Object.keys(body).length===0);const result=await rpc(initial,'enable');check(result.required===true,503,'ACCOUNT_RESPONSE_INVALID');return jsonResponse({required:true,mode:'accounts'});}
    if(decoded==='/api/accounts'&&method==='POST'){const body=await readJSON(request);check(Object.keys(body).every(k=>['member_id','password'].includes(k)));return jsonResponse(await mutate(initial,'create',body.member_id as string,body.password),201);}
    if(parts.length===4&&memberID(parts[3])){
      const body=await readJSON(request);
      if(method==='PATCH'){check(Object.keys(body).every(k=>k==='password'));return jsonResponse(await mutate(initial,'password',parts[3],body.password));}
      if(method==='DELETE'){check(Object.keys(body).length===0);return jsonResponse(safe(await rpc(initial,'unlink',{p_member_id:parts[3]})));}
    }
    throw new AccountError(405,'ACCOUNT_METHOD_INVALID','지원하지 않는 계정 요청입니다.');
  }
  return Object.freeze({handle});
}
