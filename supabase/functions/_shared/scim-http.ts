/** Bearer-only SCIM entry. The real issuer grant is resolved and revalidated by
 * SQL; a browser login is never substituted for service authority. */
import {Access,APIError,is_object,valid_id} from './access.ts';
import type {Entity} from './access.ts';
import {Authorization} from './authorization.ts';
import {Workspace} from './core.ts';
import {Advanced} from './advanced.ts';
import {HttpError,canonicalOrigin,requestPath} from './http.ts';
import {MissingSelection,ServiceStore,StoreError,canonicalJSON,createServiceProvider,mergeSelection,normalizeSelection,validateServiceContext} from './store.ts';
import type {ScimContext,Selection} from './store.ts';

type Config={supabaseUrl:string;serviceKey:string;workspaceId:string;fetch?:typeof fetch;timeoutMs?:number;budgetMs?:number;clock?:()=>number};
const enc=new TextEncoder(),TOKEN=/^[A-Za-z0-9_-]{43}$/,BASE='urn:ietf:params:scim:api:messages:2.0:Error';
class ScimError extends APIError {constructor(status:number){super(status,'SCIM request could not complete');}}
function check(value:unknown,status=503):asserts value {if(!value)throw new ScimError(status);}
function decode(value:string):Uint8Array {
  const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));
  check(btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')===value,401);return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
const sha=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
function response(value:unknown,status:number,head=false):Response {
  return new Response(status===204||head?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/scim+json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(status===401?{'WWW-Authenticate':'Bearer'}:{})}});
}
function errorResponse(error:unknown,head:boolean):Response {
  const status=(error instanceof APIError||error instanceof HttpError)&&[400,401,403,404,405,409,413,415,429].includes(error.status)?error.status:503;
  const detail=status===401?'SCIM authentication required':status===403?'SCIM access denied':status===404?'SCIM resource not found':status===409?'SCIM resource changed or conflicts with workspace policy':status>=500?'SCIM service is unavailable':'Invalid SCIM request';
  return response({schemas:[BASE],status:String(status),detail},status,head);
}
async function bytes(body:ReadableStream<Uint8Array>|null,signal:AbortSignal,limit:number):Promise<Uint8Array> {
  if(!body)return new Uint8Array();const reader=body.getReader(),parts:Uint8Array[]=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{check(!signal.aborted);for(;;){const part=await reader.read();check(!signal.aborted);if(part.done)break;size+=part.value.length;check(size<=limit,413);parts.push(part.value);}const all=new Uint8Array(size);let at=0;for(const part of parts){all.set(part,at);at+=part.length;}return all;}
  finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function input(request:Request,signal:AbortSignal):Promise<Entity> {
  check(!request.headers.has('Content-Encoding')||request.headers.get('Content-Encoding')==='identity',415);
  const length=request.headers.get('Content-Length');check(length===null||/^\d+$/.test(length)&&Number.isSafeInteger(Number(length)),400);check(length===null||Number(length)<=10_000_000,413);
  const raw=await bytes(request.body,signal,10_000_000);check(length===null||raw.length===Number(length),400);
  if(!raw.length)return {};
  check(/^application\/(?:json|scim\+json)(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''),415);
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new ScimError(400);}check(is_object(value),400);return value;
}
export function createScimHTTP(config:Config):(request:Request)=>Promise<Response>{
  const send=config.fetch??fetch,timeout=config.timeoutMs??8000,budget=config.budgetMs??110000,clock=config.clock??Date.now;
  let origin:string,headers:Record<string,string>;
  try{
    origin=canonicalOrigin(config.supabaseUrl);check(valid_id(config.workspaceId)&&typeof send==='function'&&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=15000&&Number.isSafeInteger(budget)&&budget>0&&budget<=125000);
    check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers={apikey:config.serviceKey,'Content-Type':'application/json'};
    if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
    else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)));check(JSON.parse(new TextDecoder().decode(decode(parts[1]))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
  }catch{throw new ScimError(503);}
  return async request=>{
    const head=request.method==='HEAD',controller=new AbortController(),signal=AbortSignal.any([controller.signal,request.signal]),timer=setTimeout(()=>controller.abort(),budget);
    const scopedFetch:typeof fetch=(url,init)=>send(url,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
    try{
      const encoded=requestPath(request),path=decodeURIComponent(encoded);check(path.startsWith('/scim/v2/'),404);
      check([...new URL(request.url).searchParams.keys()].every(key=>['filter','startIndex','count'].includes(key)),400);
      check(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(request.method),405);
      check(!request.headers.has('Origin')&&!request.headers.has('Cookie'),403);
      const supplied=request.headers.get('Authorization')??'';check(/^Bearer [A-Za-z0-9_-]{43}$/.test(supplied),401);
      const token=supplied.slice(7);check(TOKEN.test(token)&&decode(token).length===32,401);const tokenHash=await sha(token);
      async function authorize():Promise<ScimContext>{
        check(!signal.aborted);let result:Response;
        try{result=await scopedFetch(origin+'/rest/v1/rpc/fountain_cloud_scim_authorize',{method:'POST',headers:{...headers},body:JSON.stringify({p_workspace_id:config.workspaceId,p_token_hash:tokenHash}),signal:AbortSignal.timeout(timeout)});}catch{throw new ScimError(503);}
        if(result.redirected||result.status!==200){await result.body?.cancel().catch(()=>{});throw new ScimError([401,403,429].includes(result.status)?result.status:503);}
        let context:unknown;try{context=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(result.body,signal,4096)));}catch{throw new ScimError(503);}
        try{const checked=validateServiceContext(context as ScimContext);check(checked.kind==='scim'&&checked.workspaceId===config.workspaceId&&checked.tokenHash===tokenHash);return checked;}
        catch{throw new ScimError(503);}
      }
      const context=await authorize(),pinned=canonicalJSON(context),method=head?'GET':request.method;
      // Intentional cloud correction: discovery is read-only. The legacy pure
      // helper accepts every method here before checking its resource methods.
      if(path==='/scim/v2/ServiceProviderConfig')check(['GET','HEAD'].includes(request.method),405);
      const body=['POST','PUT','PATCH','DELETE'].includes(method)?await input(request,signal):{};
      const provider=createServiceProvider({...config,supabaseUrl:origin,fetch:scopedFetch,timeoutMs:timeout}),time=clock();
      let selected:Selection={kinds:['group'],ids:{settings:['workspace']}},collisions=0;
      for(let round=0;round<64;round++){
        check(!signal.aborted);let store:ServiceStore;
        try{store=await ServiceStore.open(provider,context,selected,{clock:()=>time});}
        catch(error){if(error instanceof StoreError&&error.code==='REVISION_CONFLICT'&&++collisions<3)continue;throw error;}
        let result:{status:number;payload:any};
        try{result=store.transaction(()=>{
          check(store.get('settings','workspace')!==null);const access=new Access(store,store.principal),authority=new Authorization(access,{ownerAccounts:'cloud-commit'}),workspace=new Workspace(store,{actor:context.memberId,access}),advanced=new Advanced(store,workspace,{actor:context.memberId,access,cloud:true});
          const staged=structuredClone(body);authority.prepare(method,path,staged);const value=advanced.scim(method,path,staged,new URL(request.url).searchParams);
          const parts=path.split('/');if(method==='DELETE'&&parts.length===5&&['Users','Groups'].includes(parts[3]))advanced.remove_access_references(parts[3]==='Users'?'member':'group',parts[4]);
          if(['POST','PUT','PATCH','DELETE'].includes(method))store.set_meta('access_revision',store.meta('access_revision',0)+1);
          return {status:value.status,payload:authority.project(path,value.payload)};
        });}catch(error){
          if(!(error instanceof MissingSelection))throw error;const expanded=mergeSelection(selected,error.selection);check(canonicalJSON(expanded)!==canonicalJSON(normalizeSelection(selected)));selected=expanded;continue;
        }
        try{try{await store.commit();}catch(error){if(store.state!=='uncertain')throw error;await store.commit();}}
        catch(error){if(error instanceof StoreError&&error.code==='REVISION_CONFLICT'&&++collisions<3)continue;throw error;}
        // A revoked/demoted/relinked issuer must not publish a staged result.
        check(canonicalJSON(await authorize())===pinned,401);return response(result.payload,result.status,head);
      }
      throw new ScimError(503);
    }catch(error){return errorResponse(error,head);}
    finally{clearTimeout(timer);controller.abort();}
  };
}
