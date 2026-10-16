/** Ticket-only scheduled entry. SQL owns the durable job, invocation, generation
 * and current authority. This transport never accepts an actor, URL or clock. */
import {is_object} from './access.ts';
import {canonicalOrigin,jsonResponse} from './http.ts';
import {StoreError,canonicalJSON,createServiceProvider,validateServiceContext} from './store.ts';
import type {AutomationContext} from './store.ts';
import {createSchedulePlan,executeScheduledClaim,validateBoundClaim,validatePlanningImage} from './scheduler-worker.ts';
import type {BoundClaim,PlanningImage} from './scheduler-worker.ts';

type Config={supabaseUrl:string;serviceKey:string;fetch?:typeof fetch;timeoutMs?:number;budgetMs?:number;maxRevisionConflicts?:number};
const enc=new TextEncoder(),TOKEN=/^[A-Za-z0-9_-]{43}$/,paths=new Set(['/','/fountain-worker','/functions/v1/fountain-worker']);
const sha=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
class TransportError extends Error {
  status:number;revisionConflict:boolean;
  constructor(status=503,revisionConflict=false){super('Scheduled request could not complete');this.status=status;this.revisionConflict=revisionConflict;}
}
function check(value:unknown,status=503):asserts value {if(!value)throw new TransportError(status);}
function exact(value:unknown,keys:string[]):asserts value is Record<string,any>{check(is_object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)));}
function decode(value:string):Uint8Array {
  const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  check(btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')===value,400);return bytes;
}
/** Errors intentionally exclude SQL messages, source values and worker results. */
export function schedulerErrorResponse(error:unknown):Response {
  const status=error instanceof TransportError?error.status:error instanceof StoreError&&[401,403,409,410,413,429].includes(error.status)?error.status:503;
  return jsonResponse({error:'Scheduled request could not complete.',code:status===401?'SCHEDULER_AUTH_REQUIRED':status===409?'SCHEDULER_CONFLICT':status>=500?'SCHEDULER_UNAVAILABLE':'INVALID_SCHEDULER_REQUEST'},status);
}
async function readTicket(request:Request,signal:AbortSignal):Promise<string>{
  const length=request.headers.get('Content-Length');
  check(length===null||/^\d+$/.test(length)&&Number.isSafeInteger(Number(length)),400);check(length===null||Number(length)<=256,413);
  const reader=request.body?.getReader();check(reader,400);let size=0;const chunks:Uint8Array[]=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
    check(!signal.aborted);for(;;){const next=await reader.read();check(!signal.aborted);if(next.done)break;size+=next.value.length;check(size<=256,413);chunks.push(next.value);}
    check(length===null||Number(length)===size,400);const all=new Uint8Array(size);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new TransportError(400);}
    check(is_object(value)&&Object.keys(value).length===1&&Object.hasOwn(value,'ticket')&&typeof value.ticket==='string'&&TOKEN.test(value.ticket),400);
    try{check(decode(value.ticket).length===32,400);}catch{throw new TransportError(400);}return value.ticket;
  }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function bounded(response:Response):Promise<Record<string,any>>{
  const reader=response.body?.getReader();check(reader);const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;check(size<=32768);chunks.push(next.value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(is_object(value));return value;}
  catch{throw new TransportError();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
type Reply={state:'done'}|{state:'planning';image:PlanningImage}|{state:'ready';context:AutomationContext;claim:BoundClaim};
function reply(value:Record<string,any>,planning:boolean):Reply {
  if(value.state==='done'){exact(value,['state']);return {state:'done'};}
  if(value.state==='planning'&&planning){exact(value,['state','image']);return {state:'planning',image:validatePlanningImage(value.image)};}
  exact(value,['state','context','claim']);check(value.state==='ready');const context=validateServiceContext(value.context);check(context.kind==='automation');const claim=validateBoundClaim(value.claim);
  check(context.workspaceId===claim.workspaceId&&context.resourceId===claim.automationId&&context.runId===claim.runId);return {state:'ready',context,claim};
}
function affinity(image:PlanningImage|BoundClaim):string {
  const {jobId,workspaceId,automationId,definitionVersion,definitionHash,dueHash,fixedNow}=image;return canonicalJSON({jobId,workspaceId,automationId,definitionVersion,definitionHash,dueHash,fixedNow});
}
export function createSchedulerTransport(config:Config):(request:Request)=>Promise<Response>{
  let origin:string,headers:Record<string,string>;const send=config.fetch??fetch,timeout=config.timeoutMs??10000,budget=config.budgetMs??110000,conflicts=config.maxRevisionConflicts??3;
  try{
    origin=canonicalOrigin(config.supabaseUrl);check(typeof send==='function'&&Number.isSafeInteger(timeout)&&timeout>=1&&timeout<=30000&&Number.isSafeInteger(budget)&&budget>=1&&budget<=125000&&Number.isSafeInteger(conflicts)&&conflicts>=1&&conflicts<=5);
    check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers={apikey:config.serviceKey,'Content-Type':'application/json'};
    if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
    else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)));check(JSON.parse(new TextDecoder().decode(decode(parts[1]))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
  }catch{throw new TransportError();}
  return async request=>{
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,request.signal]),timer=setTimeout(()=>controller.abort(),budget);
    const scopedFetch:typeof fetch=(input,init)=>send(input,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
    try{
      const url=new URL(request.url);check(paths.has(url.pathname)&&!url.search&&!url.hash,404);check(request.method==='POST',405);
      check(!request.headers.has('Cookie')&&!request.headers.has('Origin')&&!request.headers.has('Authorization'),403);
      check(/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''),415);check(!request.headers.has('Content-Encoding')||request.headers.get('Content-Encoding')==='identity',415);
      const ticket=await readTicket(request,signal),ticketHash=await sha(ticket),invocationId=crypto.randomUUID();
      async function rpc(name:string,payload:Record<string,unknown>):Promise<Record<string,any>>{
        // A missing acknowledgement may have claimed/bound work. Retry exactly
        // the same body once, retaining invocation and prepare transaction IDs.
        const body=JSON.stringify(payload);
        for(let attempt=0;attempt<2;attempt++){
          check(!signal.aborted);let response:Response;
          try{response=await scopedFetch(origin+'/rest/v1/rpc/fountain_cloud_scheduler_'+name,{method:'POST',headers:{...headers},body,signal:AbortSignal.timeout(timeout)});}
          catch{if(!attempt&&!signal.aborted)continue;throw new TransportError();}
          if(response.redirected){await response.body?.cancel().catch(()=>{});throw new TransportError();}
          if(response.status!==200){
            let data:Record<string,any>={};try{data=await bounded(response);}catch{}
            if(response.status===409&&data.code==='PT409'&&data.message==='REVISION_CONFLICT')throw new TransportError(409,true);
            if(response.status>=500&&!attempt&&!signal.aborted)continue;
            throw new TransportError([400,401,403,404,409,410,413,429].includes(response.status)?response.status:503);
          }
          try{return await bounded(response);}catch{if(!attempt&&!signal.aborted)continue;throw new TransportError();}
        }
        throw new TransportError();
      }
      let opened=reply(await rpc('open',{p_ticket_hash:ticketHash,p_invocation_id:invocationId}),true),pinned:string|undefined;
      for(let count=0;count<conflicts;count++){
        if(opened.state==='done')return jsonResponse({state:'done'});
        const current=affinity(opened.state==='planning'?opened.image:opened.claim);check(pinned===undefined||pinned===current);pinned=current;
        if(opened.state==='ready'){
          await executeScheduledClaim(opened.context,opened.claim,createServiceProvider({supabaseUrl:origin,serviceKey:config.serviceKey,fetch:scopedFetch}));
          return jsonResponse({state:'done'});
        }
        const image=opened.image,plan=createSchedulePlan(image),canonical=canonicalJSON({ticketHash,invocationId,expectedRevision:image.revision,plan});
        const payload={p_ticket_hash:ticketHash,p_invocation_id:invocationId,p_expected_revision:image.revision,p_transaction_id:crypto.randomUUID(),p_digest:await sha(canonical),p_canonical:canonical,p_plan:plan};
        try{opened=reply(await rpc('prepare',payload),false);}
        catch(error){if(!(error instanceof TransportError&&error.revisionConflict)||count+1>=conflicts)throw error;opened=reply(await rpc('open',{p_ticket_hash:ticketHash,p_invocation_id:invocationId}),true);continue;}
        if(opened.state==='done')return jsonResponse({state:'done'});
        check(opened.state==='ready'&&affinity(opened.claim)===pinned);
        await executeScheduledClaim(opened.context,opened.claim,createServiceProvider({supabaseUrl:origin,serviceKey:config.serviceKey,fetch:scopedFetch}));
        return jsonResponse({state:'done'});
      }
      throw new TransportError(409);
    }catch(error){return schedulerErrorResponse(error);}
    finally{clearTimeout(timer);controller.abort();}
  };
}
