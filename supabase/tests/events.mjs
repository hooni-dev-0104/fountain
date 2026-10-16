/** Standard Request/ReadableStream polling protocol fixture, not deployed SSE or Realtime. */
import assert from 'node:assert/strict';
import {createPageEvents} from '../functions/_shared/events.ts';
import {APIError} from '../functions/_shared/access.ts';
const realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout,timers=new Set();
globalThis.setTimeout=(action,delay,...args)=>{const id=realSetTimeout(()=>{timers.delete(id);action(...args);},delay);timers.add(id);return id;};
globalThis.clearTimeout=id=>{timers.delete(id);return realClearTimeout(id);};
const sleep=ms=>new Promise(resolve=>realSetTimeout(resolve,ms));
const base=()=>({snapshot:{epoch:'e',seq:1,page:{id:'p',revision:1,title:'문서'},blocks:[],state:{version:1},access_level:3,access_revision:0,data_revision:1,workspace_id:'ws',current_member_id:'alice',session_binding:'binding'},presence:{epoch:'e',participants:[],revision:1,workspace_id:'ws',current_member_id:'alice',session_binding:'binding'}});
const request=signal=>new Request('https://fixture.invalid/api/pages/p/events',{...(signal?{signal}:{})});
async function consume(response,onEvent){
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',all='';
 try{for(;;){const next=await reader.read();if(next.done)break;const text=decoder.decode(next.value,{stream:true});buffer+=text;all+=text;let end;
  while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith('event: ')){const lines=frame.split('\n'),event={type:lines[0].slice(7),value:JSON.parse(lines[1].slice(6))};if(await onEvent(event)){await reader.cancel();return all;}}}
 }}finally{reader.releaseLock();}return all;
}
let checks=0;
try{
 // Unrelated global/presence revisions do not repeatedly publish the document.
 const kinds=[];let polls=0;
 const response=await createPageEvents(request(),{pollMs:2,heartbeatMs:20,maxDurationMs:1000,resolve:async()=>{const value=base();polls++;value.snapshot.data_revision=polls;value.presence.revision=polls;if(polls>=4)value.presence.participants=[{id:'opaque',member_id:'bob',name:'가족',seq:1,selection:null}];return value;}});
 assert.match(response.headers.get('Content-Type'),/^text\/event-stream/);assert.equal(response.headers.get('Cache-Control'),'no-store');
 await consume(response,event=>{kinds.push(event.type);return kinds.length===3;});assert.deepEqual(kinds,['snapshot','presence','presence']);assert(polls>=4);checks++;
 let turn=0;const edits=[];
 await consume(await createPageEvents(request(),{pollMs:2,maxDurationMs:1000,resolve:async()=>{const value=base();if(turn++>=1){value.snapshot.seq=2;value.snapshot.page.revision=2;value.snapshot.page.title='한글\n<script>literal</script>';value.snapshot.data_revision=2;}return value;}}),event=>{edits.push(event);return edits.length===3;});
 assert.deepEqual(edits.map(event=>event.type),['snapshot','presence','snapshot']);assert.equal(edits[2].value.page.title,'한글\n<script>literal</script>');checks++;
 let reads=0;const denied=[];
 await consume(await createPageEvents(request(),{pollMs:2,maxDurationMs:1000,resolve:async()=>{reads++;if(reads===3)throw new APIError(404,'Resource not found');const value=base();if(reads===2)value.snapshot.access_level=1;return value;}}),event=>{denied.push(event);return false;});
 assert.deepEqual(denied.map(event=>event.type),['snapshot','presence','snapshot','denied']);assert.equal(denied.at(-1).value.status,404);checks++;
 for(const field of ['session_binding','current_member_id','workspace_id']){
  let count=0;const received=[];
  const text=await consume(await createPageEvents(request(),{pollMs:2,maxDurationMs:1000,resolve:async()=>{const value=base();if(count++>0){value.snapshot[field]='new';value.presence[field]='new';value.snapshot.page.title='MUST_NOT_TRANSFER';}return value;}}),event=>{received.push(event);return false;});
  assert.equal(received.at(-1).type,'denied');assert.equal(received.at(-1).value.status,401);assert(!text.includes('MUST_NOT_TRANSFER'));checks++;
 }
 await assert.rejects(createPageEvents(request(),{resolve:async()=>{throw new APIError(403,'Permission denied');}}),error=>error instanceof APIError&&error.status===403);checks++;
 let errors=0;const sanitized=[];
 const safe=await consume(await createPageEvents(request(),{pollMs:2,maxDurationMs:1000,resolve:async()=>{if(errors++>0)throw new Error('SECRET_APIKEY_SQL_PASSWORD');return base();}}),event=>{sanitized.push(event);return false;});
 assert.equal(sanitized.at(-1).value.status,503);assert(!safe.includes('SECRET'));checks++;
 const controller=new AbortController();let complete,signal;
 const disconnected=[];
 const active=await createPageEvents(request(controller.signal),{pollMs:2,maxDurationMs:1000,resolve:async current=>{signal=current;if(complete===undefined){complete=null;return base();}return new Promise(resolve=>{complete=resolve;});}});
 const consuming=consume(active,event=>{disconnected.push(event);return false;});
 while(typeof complete!=='function')await sleep(1);controller.abort();const delivered=await consuming;assert.equal(signal.aborted,true);const late=base();late.snapshot.page.title='LATE_PRIVATE';complete(late);await sleep(2);assert(!delivered.includes('LATE_PRIVATE'));assert.equal(disconnected.length,2);checks++;
 const text=await consume(await createPageEvents(request(),{pollMs:2,heartbeatMs:3,maxDurationMs:15,resolve:async()=>base()}),()=>false);assert(text.includes('retry: 1000'));assert(text.includes(': heartbeat'));checks++;
 await assert.rejects(createPageEvents(request(),{maxDurationMs:125001,resolve:async()=>base()}),error=>error.status===500);checks++;
 let initialSignal;
 await assert.rejects(createPageEvents(request(),{maxDurationMs:5,resolve:signal=>{initialSignal=signal;return new Promise(()=>{});}}),error=>error.status===503);assert.equal(initialSignal.aborted,true);checks++;
 const blocked=await createPageEvents(request(),{pollMs:1,maxDurationMs:1000,writeTimeoutMs:2,resolve:async()=>{const value=base();value.snapshot.page.title='UNREAD_PRIVATE';return value;}});
 await sleep(15);const unwritten=await blocked.text();assert(!unwritten.includes('UNREAD_PRIVATE'));checks++;
 let wakeInvalidation,changed=false,closed=0,resolutions=0;
 const invalidated=await createPageEvents(request(),{pollMs:1000,maxDurationMs:1000,onClose:()=>closed++,wait:(signal)=>new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('aborted'));};wakeInvalidation=()=>{signal.removeEventListener('abort',abort);resolve();};signal.addEventListener('abort',abort,{once:true});
 }),resolve:async()=>{resolutions++;const value=base();if(changed)value.snapshot.seq=2;return value;}});
 const invalidationEvents=[],readInvalidated=consume(invalidated,event=>{invalidationEvents.push(event);return invalidationEvents.length===3;});
 while(typeof wakeInvalidation!=='function')await sleep(1);changed=true;wakeInvalidation({forged:'FORGED_REALTIME_PAYLOAD'});const fresh=await readInvalidated;
 assert.equal(invalidationEvents.at(-1).value.seq,2);assert.equal(resolutions,2);assert.equal(closed,1);assert(!fresh.includes('FORGED_REALTIME_PAYLOAD'));checks++;
 let fallbackReads=0;
 const fallbackEvents=[];await consume(await createPageEvents(request(),{pollMs:2,maxDurationMs:1000,wait:async()=>{throw Error('temporary socket unavailable');},resolve:async()=>{const value=base();if(fallbackReads++>0)value.snapshot.seq=2;return value;}}),event=>{fallbackEvents.push(event);return fallbackEvents.length===3;});
 assert.deepEqual(fallbackEvents.map(event=>event.type),['snapshot','presence','snapshot']);checks++;
 const mismatched=base();mismatched.presence.epoch='other';await assert.rejects(createPageEvents(request(),{resolve:async()=>mismatched}),error=>error.status===503);checks++;
 await sleep(2);assert.equal(timers.size,0,'SSE timers remained after abort/cancel/timeout/denial');
 console.log(JSON.stringify({ok:true,checks,events:'snapshot/presence/denied',bodyRevisionDiffSeparated:true,abortAndTimerCleanup:true,boundedEOFReconnect:true,actualEdgeOrRealtime:false}));
}finally{for(const timer of timers)realClearTimeout(timer);globalThis.setTimeout=realSetTimeout;globalThis.clearTimeout=realClearTimeout;}
