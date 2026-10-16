/** Native contract tests use an untrusted mock bridge, never real credentials. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../scripts/build.mjs';
const source=await readFile(new URL('../web/native-transport.js',import.meta.url),'utf8');
const encoded=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64');
const response=(value,status=200,generation=1)=>({status,generation,headers:{'Content-Type':'application/json'},bodyBase64:encoded(value)});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+3000;while(!await predicate()){if(Date.now()>deadline)throw new Error('Native fixture condition timed out');await sleep(5);}}
function fixture(){
  const events=new EventTarget(),document=new EventTarget();document.visibilityState='visible';const calls=[],cancellations=[];
  let generation=1,origin='https://family.example',handler=async()=>response({ok:true},200,generation);
  const bridge={getConfiguration:async()=>({origin,generation}),configure:async value=>({origin:origin=value.origin,generation:++generation}),request:async value=>{calls.push(value);return handler(value);},cancel:async value=>{cancellations.push(value.id);return{cancelled:true};},download:async value=>({saved:true,generation:value.generation}),saveData:async value=>({saved:true,generation:value.generation})};
  const context=vm.createContext({URL,URLSearchParams,Headers,Response,Blob,ArrayBuffer,Uint8Array,TextEncoder,DOMException,EventTarget,Event,MessageEvent,CustomEvent,AbortController,structuredClone,setTimeout,clearTimeout,queueMicrotask,btoa,atob,document,navigator:{onLine:true},location:{origin:'https://localhost',pathname:'/',href:'https://localhost/'},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
  vm.runInContext(source,context);const transport=context.FountainNativeTransport.create(bridge,{pollInterval:250});
  return{transport,bridge,calls,cancellations,document,events,context,setHandler:fn=>handler=fn};
}
const f=fixture(),T=f.transport;await T.initialize();assert.equal(T.native,true);assert.equal(T.origin,'https://family.example');
assert.equal(T.recoveryVersion,0);assert.equal(T.recoveryEnabled,false);const scopeNotices=[];f.events.addEventListener('fountain-native-scope-changed',event=>scopeNotices.push(event.detail));
for(const value of ['http://family.example','https://user:password@family.example','https://family.example/path','https://family.example/?q=1','https://family.example/#a','https://family.example\\x','https://family.example/.','https://family.example/%2e','https://family.example/..','https://family.example?','https://family.example/?','https://family.example#','https://family.example/#'])assert.throws(()=>f.context.FountainNativeTransport.validateOrigin(value));
for(const value of ['https://evil.example/api/x','//evil.example/api/x','/api/../private','/api/%2e%2e/private','/api/%252e%252e/private','/api/%255cprivate','/api/x#fragment','/api/x\n','/api//x','/public','/api/%00','/api/%'])assert.throws(()=>T.request(value));
assert.equal(T.apiURL('/api/search?q='+encodeURIComponent('가족 / 메모 #1')),'https://family.example/api/search?q='+encodeURIComponent('가족 / 메모 #1'));
for(const name of ['Cookie','Set-Cookie','Origin','Authorization','Host','X-Fountain-Request'])assert.throws(()=>T.request('/api/probe',{headers:{[name]:'blocked'}}));
assert.throws(()=>T.request('/api/probe',{redirect:'follow'}));
f.setHandler(async value=>({...response({method:value.method,body:Buffer.from(value.bodyBase64,'base64').toString()}),headers:{'Content-Type':'application/json','Set-Cookie':'private-native-only','Authorization':'hidden','ETag':'safe'}}));
const real=await T.request('/api/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"한글":true}'});assert.ok(real instanceof Response);assert.equal(real.headers.get('set-cookie'),null);assert.equal(real.headers.get('authorization'),null);assert.equal(real.headers.get('etag'),'safe');assert.equal((await real.json()).body,'{"한글":true}');
// Capacitor rejects with Error+code, rather than browser fetch's TypeError.
for(const code of ['NETWORK_ERROR','NATIVE_NETWORK']){f.setHandler(async()=>{throw Object.assign(new Error('private native detail'),{code});});await assert.rejects(T.request('/api/session'),error=>error.name==='TypeError'&&error.status===undefined&&!error.message.includes('private'));}
for(const code of ['SESSION_STORAGE_FAILED','DURABLE_INVALIDATION_FAILED','NATIVE_STORAGE','BRIDGE_DENIED']){f.setHandler(async()=>{throw Object.assign(new Error('private native detail'),{code});});await assert.rejects(T.request('/api/session'),error=>error.status===503&&error.name!=='TypeError'&&!error.message.includes('private'));}
f.setHandler(async()=>{throw Object.assign(new Error('pending'),{code:'SESSION_REVOCATION_PENDING'});});await assert.rejects(T.request('/api/session'),error=>error.status===401);
f.setHandler(async()=>{throw Object.assign(new Error('stale'),{code:'NATIVE_STALE'});});await assert.rejects(T.request('/api/probe'),error=>error.name==='AbortError');
f.setHandler(async()=>response('',302));await assert.rejects(T.request('/api/probe'),/리디렉션/);
for(const malformed of ['%%%','A','AAA','====','AA=A','A===']){f.setHandler(async()=>({...response({}),bodyBase64:malformed}));await assert.rejects(T.request('/api/probe'));}
for(const size of [4*1024*1024,16*1024*1024]){
  const expected=Buffer.alloc(size);for(let index=0;index<size;index++)expected[index]=index%251;
  f.setHandler(async()=>({...response({}),headers:{'Content-Type':'application/octet-stream'},bodyBase64:expected.toString('base64')}));
  const decoded=Buffer.from(await(await T.request('/api/binary-boundary')).arrayBuffer());assert.ok(decoded.equals(expected),'allowed '+size+' byte response decodes exactly');
}
f.setHandler(async()=>({...response({}),bodyBase64:Buffer.alloc(16*1024*1024+1).toString('base64')}));await assert.rejects(T.request('/api/probe'));
// Native storage is opt-in; a verified session result waits for its auth barrier.
const storageFixture=fixture(),S=storageFixture.transport;
storageFixture.bridge.getConfiguration=async()=>({origin:'https://family.example',generation:1,outboxVersion:1,outboxEnabled:false});
await S.initialize();assert.equal(S.outboxVersion,1);assert.equal(S.outboxEnabled,false);
assert.equal(S.recoveryEnabled,false);
storageFixture.bridge.getConfiguration=async()=>({origin:'https://family.example',generation:1,outboxVersion:1,outboxEnabled:false,recoveryVersion:1,recoveryEnabled:true});
const beforeCapability=S.scopeEpoch;await S.initialize();assert.equal(S.recoveryVersion,1);assert.equal(S.recoveryEnabled,true);assert.ok(S.scopeEpoch>beforeCapability,'recovery capability changes invalidate a view even when the server generation is unchanged');
const initialScope=S.scopeEpoch;storageFixture.setHandler(async value=>response({error:'Authentication required'},401,value.generation));
assert.equal((await S.request('/api/session')).status,401);assert.ok(S.scopeEpoch>initialScope,'expired authentication invalidates pending recovery UI');
const failedLoginScope=S.scopeEpoch;assert.equal((await S.request('/api/session',{method:'POST',body:'{}'})).status,401);assert.equal(S.scopeEpoch,failedLoginScope+1,'wrong-password response does not emit a second unrelated scope transition');
storageFixture.setHandler(async value=>response({ok:true},200,value.generation));
let barrierCalls=0,releaseBarrier;
storageFixture.context.FountainNativeStorage={refreshAuth:()=>{barrierCalls++;return new Promise(resolve=>releaseBarrier=resolve);}};
let sessionReturned=false;const sessionResult=S.request('/api/session').then(value=>{sessionReturned=true;return value;});
await until(()=>!!releaseBarrier);assert.equal(sessionReturned,false,'session must not reach application before lease/head reconciliation');
releaseBarrier();await sessionResult;assert.equal(barrierCalls,1);
await S.request('/api/probe');assert.equal(barrierCalls,1,'ordinary data requests do not trigger an auth transition');
const recoveryNotices=[];storageFixture.events.addEventListener('fountain-native-error',event=>recoveryNotices.push(event.detail.message));
storageFixture.context.FountainNativeStorage={refreshAuth:async()=>{throw Object.assign(new Error('private outbox issue'),{code:'OUTBOX_ACCESS_REQUIRED',status:503});}};
for(const method of ['GET','POST','DELETE']){const restored=await S.request('/api/session',{method,...(method==='POST'?{body:'{}'}:{})});assert.equal(restored.status,200,'resource recovery never replaces the actual session response');}
assert.equal(recoveryNotices.length,3);assert.ok(recoveryNotices.every(message=>!message.includes('private')));
assert.equal((await S.request('/api/probe')).status,200,'resource gate does not poison native HTTP');
storageFixture.setHandler(async()=>{throw Object.assign(new Error('private canonical issue'),{code:'OUTBOX_ACCESS_REQUIRED'});});
await assert.rejects(S.request('/api/workspace'),error=>error.code==='OUTBOX_ACCESS_REQUIRED'&&error.status===503&&!error.message.includes('private'));
storageFixture.setHandler(async()=>response({ok:true}));
storageFixture.context.FountainNativeStorage={refreshAuth:async()=>{throw Object.assign(new Error('storage fault'),{status:503});}};
await assert.rejects(S.request('/api/session'),error=>error.status===503);
for(const accessFailure of [false,true]){
  storageFixture.setHandler(async value=>response({ok:true},200,value.generation));
  let releaseStale;storageFixture.context.FountainNativeStorage={refreshAuth:()=>new Promise((resolve,reject)=>releaseStale=()=>accessFailure?reject(Object.assign(new Error('stale access'),{code:'OUTBOX_ACCESS_REQUIRED'})):resolve())};
  const staleNotices=recoveryNotices.length,staleBarrier=S.request('/api/session').then(()=>false,error=>error.name);await until(()=>!!releaseStale);
  await S.configure({origin:'https://another.example'});releaseStale();assert.equal(await staleBarrier,'AbortError','old auth barrier completion cannot escape configuration fence');
  assert.equal(recoveryNotices.length,staleNotices,'obsolete resource errors never reach the new account');
}
const count=f.calls.length;await assert.rejects(T.request('/api/probe',{method:'POST',body:new Blob([new Uint8Array(10_000_001)])}),error=>error.name==='RangeError');assert.equal(f.calls.length,count);
let release;f.setHandler(value=>value.path==='/api/slow'?new Promise(resolve=>release=resolve):Promise.resolve(response({ok:true})));
const old=T.request('/api/slow').then(()=>false,error=>error.name);await until(()=>!!release);await T.request('/api/session',{method:'POST',body:'{}'});assert.equal(await old,'AbortError');release(response({stale:true}));assert.ok(f.cancellations.length);
let resolveAbort;f.setHandler(()=>new Promise(resolve=>resolveAbort=resolve));const controller=new AbortController();const aborted=T.request('/api/slow',{signal:controller.signal}).then(()=>false,error=>error.name);await until(()=>!!resolveAbort);controller.abort();assert.equal(await aborted,'AbortError');resolveAbort(response({stale:true}));
let resolveTimeout;f.setHandler(()=>new Promise(resolve=>resolveTimeout=resolve));assert.equal(await T.request('/api/slow',{timeoutMs:10}).then(()=>false,error=>error.name),'TimeoutError');resolveTimeout(response({}));
// Configuration and authentication fences reject late native success even if cancel is ignored.
let resolveConfig;f.setHandler(()=>new Promise(resolve=>resolveConfig=resolve));const obsolete=T.request('/api/slow').then(()=>false,error=>error.name);await until(()=>!!resolveConfig);await T.configure({origin:'https://another.example'});assert.equal(await obsolete,'AbortError');resolveConfig(response({},200,1));assert.equal(T.origin,'https://another.example');
f.setHandler(async()=>response({},200,T.generation));assert.equal(T.publicURL('/forms/family'),'https://another.example/forms/family');assert.equal(T.appURL('page/family'),'https://another.example/#page/family');assert.ok(T.downloadURL('/api/backup').startsWith('https://localhost/#fountain-download/'));await T.download('/api/backup','backup.sqlite');await T.saveData('가족.txt','가족과 함께','text/plain');await assert.rejects(T.saveData('large.txt',new Blob([new Uint8Array(8*1024*1024+1)])),error=>error.name==='RangeError');assert.throws(()=>T.downloadURL('/api/session'));assert.throws(()=>T.downloadURL('/api/backup?secret=x'));
// Foreground polling is serial and stops both queued and late events after close.
let active=0,maxActive=0,polls=0;f.setHandler(async value=>{active++;maxActive=Math.max(active,maxActive);await sleep(20);active--;polls++;return response({epoch:'epoch',participants:[]},200,value.generation);});
let snapshots=0,presences=0;const sourceEvents=T.events('/api/pages/document/events');sourceEvents.addEventListener('snapshot',()=>snapshots++);sourceEvents.addEventListener('presence',()=>presences++);await until(()=>snapshots&&presences);sourceEvents.close();const settledPolls=polls;await sleep(300);assert.equal(polls,settledPolls);assert.equal(maxActive,1);
f.document.visibilityState='hidden';const hiddenSource=T.events('/api/pages/document/events'),beforeHidden=f.calls.length;await sleep(300);assert.equal(f.calls.length,beforeHidden);hiddenSource.close();f.document.visibilityState='visible';
let resolvePoll;f.setHandler(value=>new Promise(resolve=>resolvePoll=()=>resolve(response({epoch:'late'},200,value.generation))));const lateSource=T.events('/api/pages/document/events');let emitted=0;lateSource.addEventListener('snapshot',()=>emitted++);await until(()=>!!resolvePoll);lateSource.close();resolvePoll();await sleep(25);assert.equal(emitted,0);
f.setHandler(async value=>response({error:'권한 없음'},403,value.generation));const deniedSource=T.events('/api/pages/document/events');let denied;deniedSource.addEventListener('denied',event=>denied=JSON.parse(event.data));await until(()=>denied);assert.equal(denied.status,403);assert.equal(deniedSource.readyState,2);
// Upload facade emits acknowledged chunk completion, never fabricated socket progress.
let chunkResolve;f.setHandler(value=>new Promise(resolve=>chunkResolve=()=>resolve(response({offset:4*1024*1024},200,value.generation))));let progress=[],loaded=false,ended=0;const xhr=T.xhr('PUT','/api/uploads/file/chunks?offset=0');xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.upload.onprogress=event=>progress.push([event.loaded,event.acknowledged]);xhr.onload=()=>loaded=true;xhr.onloadend=()=>ended++;xhr.send(new Blob([new Uint8Array(4*1024*1024)]));await until(()=>!!chunkResolve);assert.equal(progress.length,0);chunkResolve();await until(()=>ended);assert.equal(loaded,true);assert.deepEqual(progress,[[4*1024*1024,true]]);assert.equal(xhr.status,200);
let lateChunk;f.setHandler(value=>new Promise(resolve=>lateChunk=()=>resolve(response({},200,value.generation))));const cancelled=T.xhr('PUT','/api/uploads/file/chunks?offset=0');cancelled.setRequestHeader('Content-Type','application/octet-stream');let callbacks=0;cancelled.onload=()=>callbacks++;cancelled.upload.onprogress=()=>callbacks++;cancelled.send(new Blob(['tiny']));await until(()=>!!lateChunk);cancelled.abort();lateChunk();await sleep(20);assert.equal(callbacks,0);
assert.ok(scopeNotices.some(event=>event.reason==='authentication'));assert.ok(scopeNotices.some(event=>event.reason==='configuration'));assert.ok(scopeNotices.every(event=>Number.isSafeInteger(event.scopeEpoch)&&Object.keys(event).every(key=>['scopeEpoch','reason'].includes(key))));
const temporary=await mkdtemp(join(tmpdir(),'fountain-mobile-build-'));try{const output=join(temporary,'www'),result=await build(output),files=await readdir(output),html=await readFile(join(output,'index.html'),'utf8');assert.ok(files.includes('capacitor.js'));assert.ok(files.includes('native-transport.js'));assert.ok(!files.includes('transport.js'));assert.match(html,/Content-Security-Policy/);assert.match(html,/connect-src 'self'/);assert.ok(!html.includes('src="/app.js"'));assert.ok(!files.some(name=>/\.db$|\.json$|\.env|node_modules|supabase/i.test(name)));assert.ok(result.assets.length>5);}finally{await rm(temporary,{recursive:true,force:true});}

// A Supabase API origin is not a public frontend for cross-device document links.
const shareFixture=fixture(),share=shareFixture.transport;await share.initialize();
assert.equal(share.shareURL('page/family'),'https://family.example/#page/family');
for(const origin of ['https://ehnovtfadpkwtubmwltl.supabase.co','https://ehnovtfadpkwtubmwltl.supabase.co:443']){
 await share.configure({origin});assert.equal(share.shareURL('page/family'),null);
 for(const route of ['page/%2fescape','api/session','page/id#fragment'])assert.throws(()=>share.shareURL(route));
}
for(const origin of ['https://ehnovtfadpkwtubmwltl.supabase.co:8443','https://ehnovtfadpkwtubmwltl.supabase.co.example']){
 await share.configure({origin});assert.equal(share.shareURL('page/family'),origin+'/#page/family');
}
// Primary frontend addresses are strict, explicit link data; no native authority changes.
for(const origin of ['https://family.example','https://ehnovtfadpkwtubmwltl.supabase.co','https://ehnovtfadpkwtubmwltl.supabase.co:443','https://ehnovtfadpkwtubmwltl.supabase.co:8443','https://ehnovtfadpkwtubmwltl.supabase.co.example']){
 await share.configure({origin});const canonical=share.origin,api=share.apiURL('/api/session'),generation=share.generation,calls=shareFixture.calls.length;
 const cloud=new URL(canonical).hostname==='ehnovtfadpkwtubmwltl.supabase.co'&&!new URL(canonical).port;
 for(const primary of ['https://share.example','https://share.example:8443','https://xn--bcher-kva.example','https://[::1]']){
  assert.equal(share.shareURL('page/한글',primary),primary+'/#page/한글');
  assert.equal(share.publicShareURL('/forms/family?view=%2F',primary),primary+'/forms/family?view=%2F');
  assert.equal(share.publicURL('/sites/family',primary),primary+'/sites/family');
 }
 for(const unset of [null,undefined]){
  assert.equal(share.shareURL('home',unset),cloud?null:canonical+'/#home');
  for(const method of ['publicURL','publicShareURL'])assert.equal(share[method]('/forms/family',unset),cloud?null:canonical+'/forms/family');
 }
 for(const primary of ['',false,0,{},new URL('https://share.example'),'http://share.example','HTTPS://share.example','https://SHARE.example','https://share.example:443','https://share.example:08443','https://share.example/','https://share.example/.','https://share.example/%2e','https://user:secret@share.example','https://share.example?','https://share.example#','https://share.example?q=1','https://share.example#fragment','https://%73hare.example','https://bücher.example','https://[0:0:0:0:0:0:0:1]','https://share.example\\path',' https://share.example','https://share.example\n']){
  assert.throws(()=>share.shareURL('home',primary));assert.throws(()=>share.publicShareURL('/forms/family',primary));assert.throws(()=>share.publicURL('/forms/family',primary));
 }
 for(const primary of [null,'https://share.example']){
  for(const method of ['publicURL','publicShareURL'])for(const path of ['/api/session','/forms/../private','/sites/%252e%252e','/sites/a%252f%252fb','/forms/id#fragment','//outside.invalid/forms/id'])assert.throws(()=>share[method](path,primary));
  for(const route of ['page/%2fescape','api/session','page/id#fragment'])assert.throws(()=>share.shareURL(route,primary));
 }
 assert.equal(share.origin,canonical);assert.equal(share.generation,generation);assert.equal(share.apiURL('/api/session'),api);assert.equal(share.appURL('page/family'),canonical+'/#page/family');assert.equal(shareFixture.calls.length,calls);
}
console.log('PASS native transport: strict paths/headers/bytes, real Response, redirects, cancel/auth/config fences, serial foreground polls, acknowledged chunks and public-only bundle');
