/** Server-only, body-free invalidation hints. NOT document data or authority.
 * Protocol: https://supabase.com/docs/guides/realtime/protocol (vsn 1.0.0).
 * The configured legacy JWT is syntax/role/expiry checked here; Supabase alone
 * verifies its signature. Modern serverKey mode authenticates at the gateway
 * upgrade; its secret URL must never be logged/exposed, including socket.url.
 * Never send this object or its socket to a renderer.
 */
import {APIError,is_object,require} from './access.ts';
type Socket=Pick<WebSocket,'addEventListener'|'removeEventListener'|'send'|'close'|'readyState'>;
type Config={url:string;workspaceId:string;socketFactory?:(url:string)=>Socket}&({publishableKey:string;serverToken:string;serverKey?:never}|{serverKey:string;publishableKey?:never;serverToken?:never});
const SCHEMA='fountain_cloud',TABLE='workspace_signals',MAX_FRAME=64*1024,JOIN_TIMEOUT=10000,HEARTBEAT=25000;
const encoder=new TextEncoder();
function object(value:unknown):value is Record<string,any>{return is_object(value);}
function abortError():Error{return new DOMException('Realtime wait aborted','AbortError');}
function configured(config:Config){
 try{
  const url=new URL(config.url),loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  require(['https:','wss:'].includes(url.protocol)||loopback&&['http:','ws:'].includes(url.protocol),'Invalid realtime configuration');
  require(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&(!url.port||loopback),'Invalid realtime configuration');
  require(typeof config.workspaceId==='string'&&Array.from(config.workspaceId).length>0&&Array.from(config.workspaceId).length<=160&&!/[\x00-\x1f\x7f\\]/.test(config.workspaceId)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(config.workspaceId),'Invalid realtime configuration');
  let apiKey:string,token:string|undefined,expires:number;
  if(Object.hasOwn(config,'serverKey')){
   require(!Object.hasOwn(config,'publishableKey')&&!Object.hasOwn(config,'serverToken')&&typeof config.serverKey==='string'&&config.serverKey.length<=4096&&/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serverKey),'Invalid realtime configuration');
   apiKey=config.serverKey;
   // Opaque keys have no locally verifiable JWT claims. The gateway translates
   // this upgrade credential to service_role; channel join inherits that token.
   expires=Number.POSITIVE_INFINITY;
  }else{
   require(typeof config.publishableKey==='string'&&/^sb_publishable_[A-Za-z0-9_-]{8,512}$/.test(config.publishableKey),'Invalid realtime configuration');
   require(typeof config.serverToken==='string'&&config.serverToken.length<=16384,'Invalid realtime configuration');
   const pieces=config.serverToken.split('.');require(pieces.length===3&&pieces.every(part=>/^[A-Za-z0-9_-]+$/.test(part))&&pieces[2].length===43,'Invalid realtime configuration');
   const decode=(part:string)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(part.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-part.length%4)%4)),c=>c.charCodeAt(0))));
   const header=decode(pieces[0]),claims=decode(pieces[1]);
   require(object(header)&&header.alg==='HS256'&&(!header.typ||header.typ==='JWT')&&object(claims)&&claims.role==='service_role'&&claims.iss==='supabase'&&Number.isSafeInteger(claims.exp)&&claims.exp>Date.now()/1000,'Invalid realtime configuration');
   const project=/^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);if(project)require(claims.ref===project[1],'Invalid realtime configuration');
   apiKey=config.publishableKey;token=config.serverToken;expires=claims.exp*1000;
  }
  const workspace=config.workspaceId,filter='workspace_id=eq.'+(/^[A-Za-z0-9_-]+$/.test(workspace)?workspace:JSON.stringify(workspace));
  url.protocol=['http:','ws:'].includes(url.protocol)?'ws:':'wss:';url.pathname='/realtime/v1/websocket';url.searchParams.set('apikey',apiKey);url.searchParams.set('vsn','1.0.0');
  let encoded='';for(const byte of encoder.encode(workspace))encoded+=String.fromCharCode(byte);
  return {url:url.href,workspace,filter,token,expires,topic:'realtime:fountain-workspace-'+btoa(encoded).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
 }catch{throw new APIError(500,'Realtime configuration is unavailable');}
}
export function createRealtime(config:Config):{ready:Promise<boolean>;wait:(signal:AbortSignal,timeoutMs:number)=>Promise<void>;close:()=>void}{
 const fixed=configured(config);let socket:Socket|null=null,stopped=false,dirty=false,joined=false,subscribed=false,readyValue=false,started=false,ref=1,pendingHeartbeat:string|null=null,lastRevision=-1,subscriptionId:number|null=null;
 let joinTimer:ReturnType<typeof setTimeout>|undefined,heartbeatTimer:ReturnType<typeof setInterval>|undefined,finishReady:(value:boolean)=>void=()=>{};
 const ready=new Promise<boolean>(resolve=>{finishReady=resolve;}),waiters=new Set<()=>void>();
 function wake(){if(waiters.size){for(const resolve of [...waiters])resolve();}else dirty=true;}
 function stop(){if(stopped)return;stopped=true;clearTimeout(joinTimer);clearInterval(heartbeatTimer);finishReady(false);if(socket){socket.removeEventListener('open',opened);socket.removeEventListener('message',message);socket.removeEventListener('error',failed);socket.removeEventListener('close',failed);try{socket.close(1000);}catch{/* never expose a provider error */}}wake();}
 function send(event:string,payload:unknown,topic=fixed.topic,reference=String(++ref),joinRef:string|null='1'):string|null{
  if(stopped||!socket||socket.readyState!==1)return null;
  try{socket.send(JSON.stringify({topic,event,payload,ref:reference,join_ref:joinRef}));return reference;}catch{stop();return null;}
 }
 function confirmed(){if(stopped||readyValue||!joined||!subscribed)return;readyValue=true;clearTimeout(joinTimer);finishReady(true);}
 function opened(){if(stopped||started)return;started=true;if(fixed.expires<=Date.now()){stop();return;}
  send('phx_join',{config:{private:true,broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[{event:'*',schema:SCHEMA,table:TABLE,filter:fixed.filter,select:['workspace_id','revision']}]},...(fixed.token===undefined?{}:{access_token:fixed.token})},fixed.topic,'1','1');
  if(stopped)return;
  heartbeatTimer=setInterval(()=>{if(stopped)return;if(fixed.expires<=Date.now()||pendingHeartbeat!==null){stop();return;}pendingHeartbeat=send('heartbeat',{},'phoenix',String(++ref),null);},HEARTBEAT);
 }
 function failed(){stop();}
 function message(event:Event){
  if(stopped)return;const text=(event as MessageEvent).data;if(typeof text!=='string'||text.length>MAX_FRAME||encoder.encode(text).length>MAX_FRAME){stop();return;}
  let frame:unknown;try{frame=JSON.parse(text);}catch{stop();return;}
  if(!object(frame)||typeof frame.event!=='string'||typeof frame.topic!=='string'||!object(frame.payload)){stop();return;}
  if(fixed.expires<=Date.now()){stop();return;}
  if(frame.topic==='phoenix'&&frame.event==='phx_reply'&&frame.ref===pendingHeartbeat){if(frame.payload.status==='ok')pendingHeartbeat=null;else stop();return;}
  if(frame.topic!==fixed.topic||frame.join_ref!=null&&frame.join_ref!=='1')return;
  if(frame.event==='phx_error'||frame.event==='phx_close'){stop();return;}
  if(frame.event==='phx_reply'&&frame.ref==='1'){
   const changes=frame.payload.response?.postgres_changes;
   if(frame.payload.status!=='ok'||!Array.isArray(changes)||changes.length!==1){stop();return;}
   const entry=changes[0];if(!object(entry)||entry.event!=='*'||entry.schema!==SCHEMA||entry.table!==TABLE||entry.filter!==fixed.filter||!Number.isSafeInteger(entry.id)||entry.id<0){stop();return;}
   subscriptionId=entry.id;joined=true;confirmed();return;
  }
  if(frame.event==='system'&&frame.payload.extension==='postgres_changes'){if(frame.payload.status==='ok'){subscribed=true;confirmed();}else stop();return;}
  if(frame.event!=='postgres_changes'||!readyValue)return;
  const data=frame.payload.data,row=data?.record;
  if(!object(data)||data.schema!==SCHEMA||data.table!==TABLE||!['INSERT','UPDATE'].includes(data.type)||data.errors!=null&&(!Array.isArray(data.errors)||data.errors.length>0)||!object(row)||Object.keys(row).length!==2||row.workspace_id!==fixed.workspace||!Array.isArray(frame.payload.ids)||!frame.payload.ids.includes(subscriptionId))return;
  const revision=typeof row.revision==='string'&&/^(0|[1-9]\d{0,15})$/.test(row.revision)?Number(row.revision):row.revision;
  if(!Number.isSafeInteger(revision)||revision<0||revision<=lastRevision)return;lastRevision=revision;wake();
 }
 // No reconnect loop: failed sockets fall back to the caller's bounded poll.
 // One stream owns one subscription; its SSE dispose calls close exactly once.
 joinTimer=setTimeout(stop,JOIN_TIMEOUT);
 try{socket=(config.socketFactory??(url=>new WebSocket(url)))(fixed.url);socket.addEventListener('open',opened);socket.addEventListener('message',message);socket.addEventListener('error',failed);socket.addEventListener('close',failed);}catch{stop();}
 async function wait(signal:AbortSignal,timeoutMs:number):Promise<void>{
  require(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000,'Invalid realtime wait timeout',500);if(signal.aborted)throw abortError();
  if(dirty){dirty=false;return;}require(waiters.size<64,'Realtime wait limit exceeded',503);
  // After close/disconnect, future waits MUST still sleep. Immediate resolution
  // would make an authorized SSE fallback hammer its snapshot RPC in a tight loop.
  return new Promise<void>((resolve,reject)=>{let timer:ReturnType<typeof setTimeout>;const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);waiters.delete(done);},done=()=>{cleanup();resolve();},cancel=()=>{cleanup();reject(abortError());};timer=setTimeout(done,timeoutMs);waiters.add(done);signal.addEventListener('abort',cancel,{once:true});});
 }
 return Object.freeze({ready,wait,close:stop});
}
