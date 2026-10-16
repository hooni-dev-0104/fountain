/** Ticket-only control worker. No human principal or document Store is opened.
 * SQL selects/fences immutable manifests; Storage I/O stays outside SQL. */
import {APIError,is_object} from './access.ts';
import {canonicalOrigin,jsonResponse} from './http.ts';
import {canonicalJSON,validateServiceContext} from './store.ts';
import type {MaintenanceContext} from './store.ts';
import {CHUNK_SIZE,StorageError,createStorage} from './storage.ts';
import type {ChunkManifest} from './storage.ts';
type Config={supabaseUrl:string;serviceKey:string;fetch?:typeof fetch;timeoutMs?:number;budgetMs?:number};
class MaintenanceError extends APIError {constructor(status=503){super(status,'Maintenance request could not complete');}}
const enc=new TextEncoder(),paths=new Set(['/','/fountain-maintenance','/functions/v1/fountain-maintenance']);
function check(value:unknown,status=503):asserts value {if(!value)throw new MaintenanceError(status);}
const sha=async(value:string|Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?enc.encode(value):value))].map(n=>n.toString(16).padStart(2,'0')).join('');
function exact(value:unknown,keys:string[]):asserts value is Record<string,any>{check(is_object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)));}
function decode(value:string):Uint8Array{const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));check(btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')===value,400);return Uint8Array.from(raw,c=>c.charCodeAt(0));}
async function bytes(body:ReadableStream<Uint8Array>|null,signal:AbortSignal,limit:number,status=503):Promise<Uint8Array>{
 const reader=body?.getReader();check(reader,status);const parts:Uint8Array[]=[];let length=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{check(!signal.aborted);for(;;){const part=await reader.read();check(!signal.aborted);if(part.done)break;length+=part.value.length;check(length<=limit,status);parts.push(part.value);}const out=new Uint8Array(length);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function manifests(value:unknown,mode:string):ChunkManifest[]{
 check(Array.isArray(value)&&value.length>0&&value.length<=(mode==='observe'?1:16));const seen=new Set<string>();
 for(const item of value){exact(item,['version','attachmentId','offset','size','sha256']);check(item.version===1&&typeof item.attachmentId==='string'&&Array.from(item.attachmentId).length>0&&Array.from(item.attachmentId).length<=160&&!/[\x00-\x1f\x7f/\\]/.test(item.attachmentId)&&!['.','..'].includes(item.attachmentId)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item.attachmentId));check(Number.isSafeInteger(item.offset)&&item.offset>=0&&item.offset%CHUNK_SIZE===0&&Number.isSafeInteger(item.size)&&item.size>=1&&item.size<=CHUNK_SIZE&&item.offset+item.size<=5_000_000_000&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256));const id=canonicalJSON([item.attachmentId,item.offset]);check(!seen.has(id));seen.add(id);}
 return structuredClone(value);
}
export function maintenanceErrorResponse(error:unknown):Response{
 const status=error instanceof MaintenanceError?error.status:error instanceof StorageError&&[401,403,409,413,429].includes(error.status)?error.status:503;
 return jsonResponse({error:'Maintenance request could not complete.',code:status===401?'MAINTENANCE_AUTH_REQUIRED':status===409?'MAINTENANCE_CONFLICT':status>=500?'MAINTENANCE_UNAVAILABLE':'INVALID_MAINTENANCE_REQUEST'},status);
}
export function createMaintenanceTransport(config:Config):(request:Request)=>Promise<Response>{
 const send=config.fetch??fetch,timeout=config.timeoutMs??10000,budget=config.budgetMs??110000;let origin:string,headers:Record<string,string>;
 try{origin=canonicalOrigin(config.supabaseUrl);check(typeof send==='function'&&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=15000&&Number.isSafeInteger(budget)&&budget>0&&budget<=125000);check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers={apikey:config.serviceKey,'Content-Type':'application/json'};
  if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)));check(JSON.parse(new TextDecoder().decode(decode(parts[1]))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
 }catch{throw new MaintenanceError();}
 return async request=>{
  const controller=new AbortController(),signal=AbortSignal.any([request.signal,controller.signal]),timer=setTimeout(()=>controller.abort(),budget);
  const scopedFetch:typeof fetch=(input,init)=>send(input,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
  try{
   const url=new URL(request.url);check(paths.has(url.pathname)&&!url.search&&!url.hash,404);check(request.method==='POST',405);check(!request.headers.has('Cookie')&&!request.headers.has('Origin')&&!request.headers.has('Authorization'),403);check(/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''),415);check(!request.headers.has('Content-Encoding')||request.headers.get('Content-Encoding')==='identity',415);
   const length=request.headers.get('Content-Length');check(length===null||/^\d+$/.test(length)&&Number.isSafeInteger(Number(length)),400);check(length===null||Number(length)<=256,413);
   const raw=await bytes(request.body,signal,256,413);check(length===null||Number(length)===raw.length,400);let input:unknown;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new MaintenanceError(400);}
   check(is_object(input)&&Object.keys(input).length===1&&typeof input.ticket==='string'&&/^[A-Za-z0-9_-]{43}$/.test(input.ticket),400);try{check(decode(input.ticket).length===32,400);}catch{throw new MaintenanceError(400);}
   const ticketHash=await sha(input.ticket),invocationId=crypto.randomUUID();
   async function rpc(name:string,payload:Record<string,unknown>):Promise<Record<string,any>>{
    const body=JSON.stringify(payload);
    for(let attempt=0;attempt<2;attempt++){
     check(!signal.aborted);let result:Response;try{result=await scopedFetch(origin+'/rest/v1/rpc/fountain_cloud_maintenance_'+name,{method:'POST',headers:{...headers},body,signal:AbortSignal.timeout(timeout)});}catch{if(!attempt&&!signal.aborted)continue;throw new MaintenanceError();}
     if(result.redirected){await result.body?.cancel().catch(()=>{});throw new MaintenanceError();}
     if(result.status!==200){await result.body?.cancel().catch(()=>{});if(result.status>=500&&!attempt&&!signal.aborted)continue;throw new MaintenanceError([400,401,403,404,409,410,413,429].includes(result.status)?result.status:503);}
     try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(result.body,signal,32768)));check(is_object(value));return value;}catch{if(!attempt&&!signal.aborted)continue;throw new MaintenanceError();}
    }throw new MaintenanceError();
   }
   const opened=await rpc('open',{p_ticket_hash:ticketHash,p_invocation_id:invocationId});if(opened.state==='done'){exact(opened,['state']);return jsonResponse({state:'done'});}
   exact(opened,['state','context']);check(opened.state==='ready');let context:MaintenanceContext;
   try{const checked=validateServiceContext(opened.context);check(checked.kind==='maintenance'&&checked.ticketHash===ticketHash);context=checked;}catch{throw new MaintenanceError();}
   const calls=new Map<string,Record<string,unknown>>();
   async function step(action:string){let payload=calls.get(action);if(!payload){const canonical=canonicalJSON({context,invocationId,action,payload:{}});payload={p_context:context,p_invocation_id:invocationId,p_transaction_id:crypto.randomUUID(),p_digest:await sha(canonical),p_canonical:canonical,p_action:action,p_payload:{}};calls.set(action,payload);}return rpc('step',payload);}
   const claim=await step('claim');if(claim.state==='done'){exact(claim,['state']);return jsonResponse({state:'done'});}
   exact(claim,['state','manifests']);check(['observe','delete'].includes(claim.state));const items=manifests(claim.manifests,claim.state),pinned=canonicalJSON(items);
   const gate=async()=>{const allowed=await step('check');exact(allowed,['allowed']);check(allowed.allowed===true,409);};
   const storage=createStorage({supabaseUrl:origin,serviceKey:config.serviceKey,bucket:'fountain-files',workspaceId:context.workspaceId,maxObjectBytes:CHUNK_SIZE,fetch:scopedFetch,timeoutMs:timeout});
   if(claim.state==='observe'){const value=await storage.readChunk(items[0],gate,signal);check(value.length===items[0].size&&await sha(value)===items[0].sha256);await gate();const accepted=await step('observed');exact(accepted,['state']);check(accepted.state==='done');}
   else{await storage.removeChunks(items,gate,async candidates=>{check(canonicalJSON(candidates)===pinned);await gate();return true;});const accepted=await step('done');exact(accepted,['state']);check(accepted.state==='done');}
   return jsonResponse({state:'done'});
  }catch(error){return maintenanceErrorResponse(error);}
  finally{clearTimeout(timer);controller.abort();}
 };
}
