/** Authorized polling SSE transport. No Realtime subscription or delivery claim.
 * resolve must reauthenticate the ORIGINAL cookie and return page-ACL-projected
 * document + presence from one pinned staged action (snapshotWithDocument).
 */
import {APIError,is_object,require} from './access.ts';
import type {Entity} from './access.ts';
import {AuthError} from './auth.ts';
import {canonicalJSON} from './store.ts';
export type EventSnapshot={snapshot:Entity;presence:Entity};
type Config={resolve:(signal:AbortSignal)=>Promise<EventSnapshot>;pollMs?:number;heartbeatMs?:number;maxDurationMs?:number;writeTimeoutMs?:number;wait?:(signal:AbortSignal,timeoutMs:number)=>Promise<void>;onClose?:()=>void};
const encoder=new TextEncoder(),MAX_EVENT_BYTES=16*1024*1024;
function abortError():Error{return new Error('Stream aborted');}
function aborted(signal:AbortSignal):never{if(signal.aborted)throw abortError();throw new Error('Unexpected stream abort');}
function wait(milliseconds:number,signal:AbortSignal):Promise<void>{
 if(signal.aborted)return Promise.reject(abortError());
 return new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);resolve();},cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(abortError());},timer=setTimeout(done,milliseconds);signal.addEventListener('abort',cancel,{once:true});});
}
async function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(abortError());let cancel:()=>void=()=>{};
 const stop=new Promise<never>((_,reject)=>{cancel=()=>reject(abortError());signal.addEventListener('abort',cancel,{once:true});});
 try{return await Promise.race([work,stop]);}finally{signal.removeEventListener('abort',cancel);}
}
function validated(value:EventSnapshot,scope?:string):{value:EventSnapshot;scope:string}{
 require(is_object(value)&&is_object(value.snapshot)&&is_object(value.presence),'Invalid document stream snapshot',503);
 const {snapshot,presence}=value;
 require(typeof snapshot.epoch==='string'&&snapshot.epoch.length>0&&presence.epoch===snapshot.epoch&&Array.isArray(presence.participants),'Invalid document stream snapshot',503);
 const fields=['workspace_id','current_member_id','session_binding'];
 require(fields.every(key=>typeof snapshot[key]==='string'&&snapshot[key].length>0&&presence[key]===snapshot[key]),'Invalid document stream identity',503);
 const current=canonicalJSON(fields.map(key=>snapshot[key]));require(scope===undefined||scope===current,'Login changed',401);
 return {value,scope:current};
}
function frame(event:string,value:Entity):Uint8Array{
 const encoded=encoder.encode('event: '+event+'\ndata: '+canonicalJSON(value)+'\n\n');require(encoded.length<=MAX_EVENT_BYTES,'Document stream event is too large',413);return encoded;
}
function safeDenied(error:unknown):Entity{
 if(error instanceof APIError||error instanceof AuthError)return {status:error.status,error:error.message};
 return {status:503,error:'Document stream is unavailable'};
}
/** Initial denial rejects before headers; later denial is one final SSE event.
 * EOF at <=125 seconds lets EventSource reconnect with its normal retry policy.
 */
export async function createPageEvents(request:Request,config:Config):Promise<Response>{
 const poll=config.pollMs??500,heartbeat=config.heartbeatMs??10000,duration=config.maxDurationMs??125000,writeTimeout=config.writeTimeoutMs??5000;
 require([poll,heartbeat,duration,writeTimeout].every(Number.isSafeInteger)&&poll>=1&&poll<=30000&&heartbeat>=1&&duration>=1&&duration<=125000&&writeTimeout>=1&&writeTimeout<=10000,'Invalid stream configuration',500);
 const lifetime=new AbortController(),disconnect=()=>lifetime.abort();request.signal.addEventListener('abort',disconnect,{once:true});if(request.signal.aborted)lifetime.abort();
 const timer=setTimeout(()=>lifetime.abort(),duration);let disposed=false;
 const dispose=()=>{if(disposed)return;disposed=true;clearTimeout(timer);request.signal.removeEventListener('abort',disconnect);lifetime.abort();try{config.onClose?.();}catch{/* cleanup must not leak adapter errors */}};
 let first:ReturnType<typeof validated>;
 try{
  if(lifetime.signal.aborted)return aborted(lifetime.signal);
  try{first=validated(await abortable(config.resolve(lifetime.signal),lifetime.signal));}catch(error){if(error instanceof APIError||error instanceof AuthError)throw error;throw new APIError(503,'Document stream is unavailable');}
  // Validate initial byte limits before returning successful response headers.
  frame('snapshot',first.value.snapshot);frame('presence',first.value.presence);
 }catch(error){dispose();throw error;}
 let wake:(()=>void)|null=null,controller:ReadableStreamDefaultController<Uint8Array>|null=null;
 const stream=new ReadableStream<Uint8Array>({
  start(current){controller=current;void pump();},
  pull(){const next=wake;wake=null;next?.();},
  cancel(){dispose();const next=wake;wake=null;next?.();}
 });
 async function enqueue(bytes:Uint8Array):Promise<void>{
  if(lifetime.signal.aborted)throw abortError();
  while(controller!.desiredSize!==null&&controller!.desiredSize!<=0){
   await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);lifetime.signal.removeEventListener('abort',cancel);if(wake===release)wake=null;};
    const release=()=>{cleanup();resolve();},cancel=()=>{cleanup();reject(abortError());};
    const timer=setTimeout(cancel,writeTimeout);wake=release;lifetime.signal.addEventListener('abort',cancel,{once:true});
   });
  }
  if(lifetime.signal.aborted)throw abortError();controller!.enqueue(bytes);
 }
 async function pump():Promise<void>{
  let current=first.value,previous:string|null=null,previousPresence:string|null=null,lastEvent=Date.now();const scope=first.scope;
  try{
   await enqueue(encoder.encode('retry: 1000\n\n'));
   while(!lifetime.signal.aborted){
    const documentKey=canonicalJSON(Object.fromEntries(Object.entries(current.snapshot).filter(([key])=>key!=='data_revision'))),presenceKey=canonicalJSON({epoch:current.presence.epoch,participants:current.presence.participants});let changed=false;
    if(documentKey!==previous){await enqueue(frame('snapshot',current.snapshot));previous=documentKey;changed=true;}
    if(presenceKey!==previousPresence){await enqueue(frame('presence',current.presence));previousPresence=presenceKey;changed=true;}
    if(changed)lastEvent=Date.now();else if(Date.now()-lastEvent>=heartbeat){await enqueue(encoder.encode(': heartbeat\n\n'));lastEvent=Date.now();}
    // Invalidation wakes only trigger revalidation. A disconnected adapter must
    // wait its timeout on subsequent idle calls, not return in a busy loop.
    if(config.wait){try{await abortable(config.wait(lifetime.signal,poll),lifetime.signal);}catch(error){if(lifetime.signal.aborted)throw error;await wait(poll,lifetime.signal);}}else await wait(poll,lifetime.signal);
    current=validated(await abortable(config.resolve(lifetime.signal),lifetime.signal),scope).value;
   }
  }catch(error){
   if(!lifetime.signal.aborted){try{await enqueue(frame('denied',safeDenied(error)));}catch{/* disconnected/backpressured */}}
  }finally{dispose();const next=wake;wake=null;next?.();try{controller?.close();}catch{/* reader already canceled */}}
 }
 return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
}
