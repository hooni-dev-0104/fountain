/** Root-only disposable actual-cloud QA. Definitions only: importing this module
 * performs no network I/O. Root owns nonce gates, deployment, users and cleanup.
 * The only public results are fixed check names and Realtime boolean JSON lines.
 * No model, token/cookie/hash/workspace/body or provider diagnostic is returned.
 */
import {createLiveRuntime,liveScope,qaPasswords,qaCheck,LiveQAError} from './live-domain.ts';
import type {LiveConfig} from './live-domain.ts';
import {createActivity} from '../functions/_shared/activity.ts';
import {createRealtime} from '../functions/_shared/realtime.ts';

const privateACL={default:'private',inherit:false,members:{},groups:{}};
const point=(offset=0)=>({before:null,after:null,offset});
const selection=(block:string)=>({block_id:block,anchor:point(),focus:point(2)});
const runtimeFor=(config:LiveConfig,guardedFetch:typeof fetch)=>{
 const scope=liveScope(config);
 // Production createActivity constructs production PresenceAdapter, publisher
 // proof RPC and transactional Store; factory does not shim any endpoint.
 return createLiveRuntime(scope,guardedFetch,undefined,base=>createActivity({...base,supabaseUrl:scope.supabaseUrl,serviceKey:scope.serviceKey}));
};
export async function runActivity(config:LiveConfig,passwords:[string,string],guardedFetch:typeof fetch):Promise<string[]>{
 const scope=liveScope(config);qaPasswords(passwords);qaCheck(typeof guardedFetch==='function','QA_FETCH_REQUIRED');
 let runtime:ReturnType<typeof runtimeFor>|undefined,bCookie:string|null=null,armed=false,proofCalls=0,revoked=false,stage='LOGIN';
 const observedFetch:typeof fetch=async(input,init)=>{
  const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
  if(armed&&path==='/rest/v1/rpc/fountain_cloud_presence_publishers'){
   proofCalls++;
   if(proofCalls===2){
    // Actual production logout occurs BETWEEN before/after publisher proofs.
    // Both proof responses still come from real Supabase; none are forged.
    armed=false;qaCheck(runtime&&bCookie,'QA_PROOF_RACE_SETUP');
    const response=await runtime.request(bCookie,'DELETE','/api/session',{});qaCheck(response.status===200,'QA_RACE_LOGOUT');
    const value=await response.json();qaCheck(value.authenticated===false,'QA_RACE_LOGOUT');revoked=true;
   }
  }
  return guardedFetch(input,init);
 };
 runtime=runtimeFor(scope,observedFetch);const live=runtime,checks:string[]=[];
 try{
  const a=await live.login(0,passwords[0]),b=await live.login(1,passwords[1]);bCookie=b;
  const call=(cookie:string,method:string,path:string,body?:unknown,status=200)=>live.json(cookie,method,path,body,status);
  const denied=async(cookie:string,method:string,path:string,body:unknown,statuses:number[])=>{const response=await live.request(cookie,method,path,body);await response.body?.cancel();qaCheck(statuses.includes(response.status),'QA_PRESENCE_DENIAL');};
  const sa=await call(a,'GET','/api/session'),sb=await call(b,'GET','/api/session');
  qaCheck(sa.member.id==='alice'&&sa.member.role==='owner'&&sb.member.id==='bob'&&sb.member.role==='member'&&sa.cache_binding!==sb.cache_binding,'QA_ACTIVITY_IDENTITIES');checks.push('real_gotrue_two_current_sql_members_and_distinct_opaque_bindings');
  stage='PAGES';
  const block='qa-presence-'+crypto.randomUUID(),shared=await call(a,'POST','/api/pages',{title:'QA shared presence',permissions:{...privateACL,members:{bob:'edit'}},blocks:[{id:block,type:'paragraph',text:'shared QA'}]},201);
  const privatePage=await call(a,'POST','/api/pages',{title:'QA private presence',permissions:privateACL},201);
  const doc=await call(a,'GET',`/api/pages/${shared.id}/collaboration`);qaCheck(typeof doc.epoch==='string'&&doc.page.id===shared.id,'QA_ACTIVITY_EPOCH');
  const path=`/api/pages/${shared.id}/presence`,clientA='qa-a-'+crypto.randomUUID(),clientB='qa-b-'+crypto.randomUUID();
  const body=(binding:string,client_id:string,seq:number,chosen:unknown=selection(block))=>({session_binding:binding,epoch:doc.epoch,client_id,seq,selection:chosen});
  const leaving=(binding:string,client_id:string,seq:number)=>({session_binding:binding,epoch:doc.epoch,client_id,seq});
  stage='PUBLISH';
  const pa=await call(a,'PUT',path,body(sa.cache_binding,clientA,1));qaCheck(pa.ack_seq===1&&!pa.ignored,'QA_PRESENCE_A_ACK');
  const pb=await call(b,'PUT',path,body(sb.cache_binding,clientB,1));qaCheck(pb.ack_seq===1&&!pb.ignored,'QA_PRESENCE_B_ACK');
  const both=await call(a,'GET',path);
  qaCheck(both.workspace_id===scope.workspaceId&&both.current_member_id==='alice'&&both.session_binding===sa.cache_binding&&both.epoch===doc.epoch,'QA_PRESENCE_SCOPE');
  qaCheck(both.participants.some((p:any)=>p.member_id==='alice'&&p.client_id===clientA)&&both.participants.some((p:any)=>p.member_id==='bob'&&p.client_id===clientB&&p.selection?.block_id===block&&p.selection.focus.offset===2),'QA_TWO_PUBLISHERS');
  checks.push('actual_presence_put_two_publishers_and_current_get_selection_scope');
  stage='SELECTION_AND_SEQUENCE';
  await denied(b,'PUT',path,body(sa.cache_binding,clientB,2),[403]);
  await denied(b,'PUT',path,{...body(sb.cache_binding,clientB,2),epoch:'not-the-current-epoch'},[409]);
  const outside={block_id:block,anchor:{before:'unrelated-page-character',after:null,offset:0},focus:point()};
  const scoped=await call(b,'PUT',path,body(sb.cache_binding,clientB,2,outside));qaCheck(scoped.participants.find((p:any)=>p.member_id==='bob'&&p.client_id===clientB)?.selection===null,'QA_FOREIGN_SELECTION_REDACTED');
  const staleLeave=await call(b,'DELETE',path,leaving(sb.cache_binding,clientB,1));qaCheck(staleLeave.ignored===true&&staleLeave.ack_seq===2&&staleLeave.participants.some((p:any)=>p.member_id==='bob'&&p.client_id===clientB),'QA_STALE_LEAVE');
  const left=await call(b,'DELETE',path,leaving(sb.cache_binding,clientB,3));qaCheck(left.ack_seq===3&&!left.participants.some((p:any)=>p.member_id==='bob'&&p.client_id===clientB),'QA_CURRENT_LEAVE');
  const stalePut=await call(b,'PUT',path,body(sb.cache_binding,clientB,2));qaCheck(stalePut.ignored===true&&stalePut.ack_seq===3&&!stalePut.participants.some((p:any)=>p.member_id==='bob'&&p.client_id===clientB),'QA_STALE_PUT_AFTER_LEAVE');
  checks.push('foreign_binding_epoch_and_character_scope_fenced_stale_leave_and_retry_cannot_resurrect');
  stage='PRIVATE_DENIAL';
  await denied(b,'GET',`/api/pages/${privatePage.id}/presence`,undefined,[403,404]);
  await denied(b,'PUT',`/api/pages/${privatePage.id}/presence`,body(sb.cache_binding,clientB,4),[403,404]);
  checks.push('current_private_page_presence_get_and_put_denied_to_other_member');
  stage='FINAL_PROOF_REVOCATION';
  await call(b,'PUT',path,body(sb.cache_binding,clientB,10));await call(a,'PUT',path,body(sa.cache_binding,clientA,10));
  armed=true;proofCalls=0;const after=await call(a,'GET',path);armed=false;
  qaCheck(revoked&&proofCalls>=2&&after.participants.some((p:any)=>p.member_id==='alice'&&p.client_id===clientA)&&!after.participants.some((p:any)=>p.member_id==='bob'),'QA_FINAL_PROOF_REVOCATION');
  const anonymous=await call(b,'GET','/api/session');qaCheck(anonymous.authenticated===false,'QA_OLD_COOKIE_REVOKED');await denied(b,'GET',path,undefined,[401]);
  checks.push('real_logout_between_publisher_proofs_rejected_stale_peer_without_removing_alice');
  stage='NEW_BINDING';
  const newB=await live.login(1,passwords[1]),newSession=await call(newB,'GET','/api/session');qaCheck(newSession.cache_binding!==sb.cache_binding,'QA_NEW_BINDING');
  await call(a,'PUT',path,body(sa.cache_binding,clientA,11));
  const beforeNew=await call(newB,'GET',path);qaCheck(beforeNew.current_member_id==='bob'&&beforeNew.session_binding===newSession.cache_binding&&!beforeNew.participants.some((p:any)=>p.member_id==='bob'),'QA_NO_OLD_PARTICIPANT');
  const joined=await call(newB,'PUT',path,body(newSession.cache_binding,clientB,1));qaCheck(joined.ack_seq===1&&joined.participant_id!==pb.participant_id&&joined.participants.filter((p:any)=>p.member_id==='bob').length===1&&joined.participants.some((p:any)=>p.member_id==='alice'),'QA_REJOIN_NEW_ORIGIN');
  checks.push('new_login_binding_does_not_reuse_old_participant_or_sequence_and_preserves_alice');
  return checks;
 }catch(error){if(error instanceof LiveQAError)throw new LiveQAError('ACTIVITY_'+stage+'_'+error.code,error.status);throw new LiveQAError('ACTIVITY_'+stage,503);}
 finally{armed=false;await live.close();}
}

/** Separate bounded SSE phase so real network/proof latency cannot consume the
 * activity runner's invocation. It verifies abort EOF, not the 125s normal EOF. */
export async function runSSE(config:LiveConfig,passwords:[string,string],guardedFetch:typeof fetch):Promise<string[]>{
 liveScope(config);qaPasswords(passwords);const live=runtimeFor(config,guardedFetch),abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,stage='LOGIN';
 const timeout=setTimeout(()=>abort.abort(),20000);
 try{
  const a=await live.login(0,passwords[0]),b=await live.login(1,passwords[1]),session=await live.json(a,'GET','/api/session');
  const page=await live.json(a,'POST','/api/pages',{title:'QA bounded SSE',permissions:privateACL,blocks:[{id:'qa-sse-'+crypto.randomUUID(),type:'paragraph',text:'QA'}]},201);
  stage='PRIVATE_DENIAL';const denial=await live.request(b,'HEAD',`/api/pages/${page.id}/events`);await denial.body?.cancel();qaCheck([403,404].includes(denial.status),'QA_SSE_PRIVATE_DENIAL');
  stage='STREAM';const response=await live.request(a,'GET',`/api/pages/${page.id}/events`,undefined,{},abort.signal);qaCheck(response.status===200&&response.headers.get('Content-Type')?.startsWith('text/event-stream')&&response.headers.get('Cache-Control')==='no-store','QA_SSE_HEADERS');
  reader=response.body?.getReader();qaCheck(reader,'QA_SSE_BODY');const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0,snapshot:Record<string,any>|null=null,presence:Record<string,any>|null=null;
  while(!snapshot||!presence){
   const next=await reader.read();qaCheck(!next.done,'QA_SSE_EARLY_EOF');size+=next.value.length;qaCheck(size<=262144,'QA_SSE_BOUND');text+=decoder.decode(next.value,{stream:true});let end;
   while((end=text.indexOf('\n\n'))>=0){const frame=text.slice(0,end);text=text.slice(end+2);if(frame.startsWith(':')||frame.startsWith('retry:'))continue;const lines=frame.split('\n');qaCheck(lines.length===2&&lines[0].startsWith('event: ')&&lines[1].startsWith('data: '),'QA_SSE_FRAME');const value=JSON.parse(lines[1].slice(6));if(lines[0]==='event: snapshot')snapshot=value;else if(lines[0]==='event: presence')presence=value;else throw new LiveQAError('QA_SSE_UNEXPECTED_EVENT');}
  }
  const identity=(value:Record<string,any>)=>value.workspace_id===live.scope.workspaceId&&value.current_member_id==='alice'&&value.session_binding===session.cache_binding;
  qaCheck(identity(snapshot)&&identity(presence)&&snapshot.epoch===presence.epoch&&snapshot.page?.id===page.id&&snapshot.page.access_level===4&&snapshot.access_level===4&&Number.isSafeInteger(snapshot.data_revision)&&Number.isSafeInteger(snapshot.access_revision)&&Array.isArray(presence.participants),'QA_SSE_CANONICAL_IDENTITY');
  stage='ABORT';abort.abort();let closeTimer:ReturnType<typeof setTimeout>|undefined;
  try{const ended=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{closeTimer=setTimeout(()=>reject(new LiveQAError('QA_SSE_ABORT_TIMEOUT')),2000);})]);qaCheck(ended.done,'QA_SSE_ABORT_EOF');}finally{clearTimeout(closeTimer);}
  return ['actual_current_private_sse_head_denial','actual_edge_sse_snapshot_presence_canonical_identity_and_abort_eof'];
 }catch(error){if(error instanceof LiveQAError)throw new LiveQAError('SSE_'+stage+'_'+error.code,error.status);throw new LiveQAError('SSE_'+stage,503);}
 finally{clearTimeout(timeout);abort.abort();try{await reader?.cancel();}catch{/* No provider diagnostics. */}reader?.releaseLock();await live.close();}
}

/** Root reads the ready line, then performs its separately authorized QA-only
 * revision write. A real socket (never a mock) observes only invalidation data.
 * The wrapper must authenticate its private nonce BEFORE invoking this function. */
export function startRealtime(config:LiveConfig,serverTokenFromEnv:string,request:Request):Response{
 const scope=liveScope(config);qaCheck(!request.signal.aborted,'QA_REALTIME_ABORTED');const abort=new AbortController(),encoder=new TextEncoder();let socket:WebSocket|undefined,failed=false,disposed=false,controller:ReadableStreamDefaultController<Uint8Array>|undefined;
 const unhealthy=()=>{failed=true;};
 let subscriber:ReturnType<typeof createRealtime>;
 try{subscriber=createRealtime({url:scope.supabaseUrl,workspaceId:scope.workspaceId,...(serverTokenFromEnv.startsWith('sb_secret_')?{serverKey:serverTokenFromEnv}:{publishableKey:scope.publishableKey,serverToken:serverTokenFromEnv}),socketFactory:url=>{socket=new WebSocket(url);socket.addEventListener('error',unhealthy);socket.addEventListener('close',unhealthy);return socket;}});}catch{throw new LiveQAError('QA_REALTIME_CONFIGURATION',503);}
 const disconnect=()=>{abort.abort();dispose();},timer=setTimeout(disconnect,28000);
 function dispose(){if(disposed)return;disposed=true;clearTimeout(timer);request.signal.removeEventListener('abort',disconnect);abort.abort();socket?.removeEventListener('error',unhealthy);socket?.removeEventListener('close',unhealthy);subscriber.close();}
 const write=(value:{ready:boolean}|{woke:boolean})=>{if(!disposed&&!request.signal.aborted)controller?.enqueue(encoder.encode(JSON.stringify(value)+'\n'));};
 const stream=new ReadableStream<Uint8Array>({start(current){controller=current;void(async()=>{let ready=false;try{
  ready=await subscriber.ready;if(abort.signal.aborted)return;write({ready});if(!ready)return;
  const started=performance.now();await subscriber.wait(abort.signal,15000);if(abort.signal.aborted)return;
  // close() also releases the active waiter; do not mistake a disconnect for
  // a valid database invalidation merely because it happened before timeout.
  write({woke:performance.now()-started<14000&&!failed&&socket?.readyState===WebSocket.OPEN});
 }catch{if(!abort.signal.aborted)write(ready?{woke:false}:{ready:false});}finally{dispose();try{current.close();}catch{/* reader canceled */}}})();},cancel(){dispose();}});
 request.signal.addEventListener('abort',disconnect,{once:true});if(request.signal.aborted)disconnect();
 return new Response(stream,{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no','Content-Security-Policy':"default-src 'none'",'Referrer-Policy':'no-referrer'}});
}
