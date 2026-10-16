/** Real-person manual GC proof. SQL checks backup pins and retires the physical
 * ID permanently before any Storage DELETE. No file bytes or paths return. */
import {APIError,is_object,valid_id} from './access.ts';
import type {AuthContext} from './auth.ts';
import {canonicalOrigin} from './http.ts';
import {canonicalJSON,validateContext} from './store.ts';
import {storeContext} from './transaction.ts';
import {CHUNK_SIZE} from './storage.ts';
import type {ChunkManifest} from './storage.ts';
type Config={supabaseUrl:string;serviceKey:string;authorize:()=>Promise<AuthContext>;fetch?:typeof fetch;timeoutMs?:number};
class FenceError extends APIError {constructor(status=503){super(status,'File cleanup authorization could not complete');}}
function check(value:unknown,status=503):asserts value{if(!value)throw new FenceError(status);}
export function createUploadGarbageFence(config:Config):(initial:AuthContext,id:string,items:ChunkManifest[])=>Promise<void>{
 const send=config.fetch??fetch,timeout=config.timeoutMs??8000;let origin:string,headers:Record<string,string>;
 try{origin=canonicalOrigin(config.supabaseUrl);check(typeof send==='function'&&typeof config.authorize==='function'&&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=15000);check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers={apikey:config.serviceKey,'Content-Type':'application/json'};
  if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)));check(JSON.parse(atob(parts[1].replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-parts[1].length%4)%4))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
 }catch{throw new FenceError();}
 return async(initial,id,items)=>{
  check(valid_id(id)&&Array.isArray(items)&&items.length>0&&items.length<=100,400);
  for(const item of items)check(is_object(item)&&Object.keys(item).length===5&&item.version===1&&item.attachmentId===id&&Number.isSafeInteger(item.offset)&&item.offset>=0&&item.offset%CHUNK_SIZE===0&&Number.isSafeInteger(item.size)&&item.size>=1&&item.size<=CHUNK_SIZE&&item.offset+item.size<=5_000_000_000&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256),400);
  const context=validateContext(storeContext(initial)),current=await config.authorize();check(current.expiresAt>Date.now()&&canonicalJSON(validateContext(storeContext(current)))===canonicalJSON(context),401);
  const body=JSON.stringify({p_context:context,p_id:id,p_manifests:structuredClone(items)});
  for(let attempt=0;attempt<2;attempt++){
   let response:Response;try{response=await send(origin+'/rest/v1/rpc/fountain_cloud_upload_gc_fence',{method:'POST',headers:{...headers},body,redirect:'error',signal:AbortSignal.timeout(timeout)});}catch{if(!attempt)continue;throw new FenceError();}
   if(response.redirected){await response.body?.cancel().catch(()=>{});throw new FenceError();}
   if(response.status!==200){await response.body?.cancel().catch(()=>{});if(response.status>=500&&!attempt)continue;throw new FenceError([400,401,403,404,409,413,429].includes(response.status)?response.status:503);}
   const reader=response.body?.getReader();check(reader);let length=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
   try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;check(length<=4096);text+=decoder.decode(part.value,{stream:true});}const result=JSON.parse(text+decoder.decode());check(is_object(result)&&Object.keys(result).length===1&&result.allowed===true);return;}
   catch{if(attempt)throw new FenceError();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }throw new FenceError();
 };
}
