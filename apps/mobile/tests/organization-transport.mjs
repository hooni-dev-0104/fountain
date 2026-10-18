/** Untrusted organization bridge: no workspace network, storage, profile or outbox initialization. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../scripts/build.mjs';
const source=await readFile(new URL('../web/organization-native.js',import.meta.url),'utf8');
const encoded=value=>Buffer.from(value).toString('base64');
const response=(value='{}',generation=1,status=200)=>({generation,status,headers:{'Content-Type':'application/json'},bodyBase64:encoded(value)});
const until=async predicate=>{const stop=Date.now()+2000;while(!predicate()){if(Date.now()>stop)throw Error('Organization fixture timeout');await new Promise(resolve=>setTimeout(resolve,1));}};
function fixture(){
  const calls=[],cancelled=[],workspace=[],events=new EventTarget();let configuration={origin:'https://family.example',generation:1},handler=async value=>response('{}',value.generation);
  const bridge={getConfiguration:async()=>({...configuration}),organizationRequest:async value=>{for(const name of Object.keys(value.headers))assert.equal(name,'content-type','OS request policies reject renderer-owned request markers');calls.push(value);return handler(value);},organizationCancel:async value=>{cancelled.push(value);assert.deepEqual(Object.keys(value).sort(),['generation','id']);assert.ok(Number.isSafeInteger(value.generation));assert.equal(value.generation,calls.find(call=>call.id===value.id)?.generation,'OS cancellation is bound to its admitted generation');}};
  for(const name of ['request','cancel','configure','profile','initialize','outboxInitialize','admission','reconcile'])bridge[name]=()=>{workspace.push(name);throw Error('Workspace bridge forbidden');};
  const context=vm.createContext({URL,Headers,Response,Blob,ArrayBuffer,Uint8Array,TextEncoder,DOMException,AbortController,setTimeout,clearTimeout,btoa,atob,Capacitor:{registerPlugin:name=>{assert.equal(name,'FountainNative');return bridge;}},dispatchEvent:events.dispatchEvent.bind(events)});
  for(const name of ['FountainNativeOutbox','FountainNativeStorage','FountainNativeRecovery','FountainTransport','FountainNativeTransport'])Object.defineProperty(context,name,{get(){throw Error('Workspace global forbidden: '+name);}});
  vm.runInContext(source,context);return {T:context.FountainOrganizationTransport,context,calls,cancelled,workspace,events,setHandler:value=>handler=value,setConfiguration:value=>configuration=value};
}
const f=fixture(),T=f.T;let notices=0;f.events.addEventListener('fountain-native-scope-changed',()=>notices++);
for(const path of ['/api/session','/api/workspace','https://family.example/api/organization/session','//evil/api/organization/session','/api/organization//x','/api/organization/../session','/api/organization/%252e%252e/session','/api/organization/%252fworkspace','/api/organization/%255cprivate','/api/organization/session#fragment','/api/organization/%','/api/organization/session?q=%250a','/api/organization/session?q=%255c'])assert.throws(()=>T.request(path),error=>error.name==='TypeError');
for(const name of ['Cookie','Set-Cookie','Origin','Authorization','Host','Accept'])assert.throws(()=>T.request('/api/organization/session',{headers:{[name]:'secret'}}));
assert.throws(()=>T.request('/api/organization/session',{headers:{'X-Fountain-Request':'2'}}));assert.throws(()=>T.request('/api/organization/session',{method:'GET',body:'{}'}));assert.throws(()=>T.request('/api/organization/session',{redirect:'follow'}));assert.throws(()=>T.request('/api/organization/session',{timeoutMs:45001}));
f.setHandler(async value=>({...response(JSON.stringify({method:value.method,body:Buffer.from(value.bodyBase64,'base64').toString()}),value.generation),headers:{'Content-Type':'application/json','Set-Cookie':'private','Authorization':'private','X-Session':'private'}}));
const valid=await T.request('/api/organization/session',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Fountain-Request':'1'},body:'{"한글":true}'});assert.ok(valid instanceof Response);assert.equal(valid.headers.get('set-cookie'),null);assert.equal(valid.headers.get('authorization'),null);assert.equal(valid.headers.get('x-session'),null);assert.equal((await valid.json()).body,'{"한글":true}');
assert.equal(f.calls[0].headers['x-fountain-request'],undefined);assert.deepEqual(Object.keys(f.calls[0]).sort(),['id','generation','path','method','headers','bodyBase64','timeoutMs'].sort());assert.equal(f.workspace.length,0);
const before=f.calls.length;await assert.rejects(T.request('/api/organization/bootstrap',{method:'POST',body:new Blob([new Uint8Array(65537)])}),error=>error.name==='RangeError');assert.equal(f.calls.length,before);
f.setHandler(async value=>response('{}',value.generation,401));assert.equal((await T.request('/api/organization/organizations')).status,401);assert.equal(notices,0);assert.equal(f.workspace.length,0);
for(const code of ['NATIVE_STORAGE','BRIDGE_DENIED','NATIVE_SESSION_CONFLICT','NETWORK_ERROR','NATIVE_STALE','TIMEOUT']){f.setHandler(async()=>{throw Object.assign(Error('PRIVATE token=never expose'),{code});});await assert.rejects(T.request('/api/organization/session'),error=>!error.message.includes('PRIVATE'));}
f.setHandler(async()=>{throw Error('PRIVATE no code');});await assert.rejects(T.request('/api/organization/session'),error=>!error.message.includes('PRIVATE'));
for(const malformed of ['A','AAA','====','AA=A','A===','AB==']){f.setHandler(async value=>({...response('{}',value.generation),bodyBase64:malformed}));await assert.rejects(T.request('/api/organization/session'));}
for(const status of [199,302,304,600]){f.setHandler(async value=>response('{}',value.generation,status));await assert.rejects(T.request('/api/organization/session'));}
f.setHandler(async value=>({...response('{}',value.generation),headers:{'Content-Length':'3'}}));await assert.rejects(T.request('/api/organization/session'));
f.setHandler(async value=>response('x'.repeat(2*1024*1024),value.generation));assert.equal((await(await T.request('/api/organization/session')).arrayBuffer()).byteLength,2*1024*1024);
f.setHandler(async value=>response('x'.repeat(2*1024*1024+1),value.generation));await assert.rejects(T.request('/api/organization/session'));
let release;f.setHandler(value=>value.path.endsWith('/slow')?new Promise(resolve=>release=()=>resolve(response('{}',value.generation))):Promise.resolve(response('{}',value.generation)));
const old=T.request('/api/organization/slow').then(()=>false,e=>e.name);await until(()=>!!release);await T.request('/api/organization/session',{method:'DELETE',body:'{}'});assert.equal(await old,'AbortError');release();assert.ok(f.cancelled.length);
let timeoutRelease;f.setHandler(value=>new Promise(resolve=>timeoutRelease=()=>resolve(response('{}',value.generation))));assert.equal(await T.request('/api/organization/slow',{timeoutMs:5}).then(()=>false,e=>e.name),'TimeoutError');timeoutRelease();
let abortRelease;const controller=new AbortController();f.setHandler(value=>new Promise(resolve=>abortRelease=()=>resolve(response('{}',value.generation))));const pending=T.request('/api/organization/slow',{signal:controller.signal}).then(()=>false,e=>e.name);await until(()=>!!abortRelease);controller.abort();assert.equal(await pending,'AbortError');abortRelease();
let staleRelease;f.setHandler(value=>new Promise(resolve=>staleRelease=()=>resolve(response('{}',value.generation))));const stale=T.request('/api/organization/slow').then(()=>false,e=>e.name);await until(()=>!!staleRelease);f.setConfiguration({origin:'https://next.example',generation:2});await T.initialize();assert.equal(await stale,'AbortError');staleRelease();
f.setHandler(async value=>response('{}',1));await assert.rejects(T.request('/api/organization/session'),e=>e.name==='AbortError');
f.setConfiguration({origin:'https://other.example',generation:2});await assert.rejects(T.initialize(),e=>e.name==='AbortError');
const missing=fixture();missing.setConfiguration({origin:null,generation:1});await assert.rejects(missing.T.request('/api/organization/session'),/서버 주소/);assert.equal(missing.calls.length,0);
for(const origin of ['http://family.example','https://user:password@family.example','https://family.example/path','https://family.example/?q=1','https://family.example/#x','https://family.example\\x']){const bad=fixture();bad.setConfiguration({origin,generation:1});await assert.rejects(bad.T.initialize());}
assert.equal(f.workspace.length,0);assert.equal(notices,0);
for(const value of f.cancelled){assert.deepEqual(Object.keys(value).sort(),['generation','id']);assert.equal(value.generation,f.calls.find(call=>call.id===value.id)?.generation);}
// Requests pending configuration cannot cross a later organization login invocation.
const race=fixture();let configRelease;race.context.Capacitor.registerPlugin=()=>{}; // The already registered bridge remains the only bridge.
const raceFactory=race.context.FountainOrganizationNative.create({getConfiguration:()=>new Promise(resolve=>configRelease=()=>resolve({origin:'https://family.example',generation:1})),organizationRequest:async args=>response('{}',args.generation),organizationCancel:async()=>{}});
const early=raceFactory.request('/api/organization/organizations').then(()=>false,e=>e.name);await until(()=>!!configRelease);const login=raceFactory.request('/api/organization/session',{method:'POST',body:'{}'});configRelease();assert.equal(await early,'AbortError');assert.equal((await login).status,200);

const stalled=fixture();let delayedConfiguration;
const awaiting=stalled.context.FountainOrganizationNative.create({getConfiguration:()=>new Promise(resolve=>delayedConfiguration=()=>resolve({origin:'https://family.example',generation:1})),organizationRequest:()=>{throw Error('Never enter the wire after preflight cancellation');},organizationCancel:async()=>{}});
const preflightController=new AbortController(),preflight=awaiting.request('/api/organization/session',{signal:preflightController.signal}).then(()=>false,e=>e.name);await until(()=>!!delayedConfiguration);preflightController.abort();assert.equal(await preflight,'AbortError');delayedConfiguration();
const timed=stalled.context.FountainOrganizationNative.create({getConfiguration:()=>new Promise(()=>{}),organizationRequest:()=>{throw Error('Unexpected wire');},organizationCancel:async()=>{}});assert.equal(await timed.request('/api/organization/session',{timeoutMs:5}).then(()=>false,e=>e.name),'TimeoutError');

const temporary=await mkdtemp(join(tmpdir(),'fountain-mobile-organization-'));try{
 const output=join(temporary,'www'),result=await build(output),files=await readdir(output),html=await readFile(join(output,'organization.html'),'utf8');
 assert.ok(files.includes('organization-native.js'));assert.ok(files.includes('organization.js'));assert.ok(result.assets.includes('organization.html'));
 assert.match(html,/Content-Security-Policy/);assert.match(html,/capacitor\.js.*organization-native\.js/s);assert.ok(!/src=["'][^"']*(?:\/transport|\/native-transport|\/native-outbox|\/native-recovery|\/bootstrap|\/app)\.js/.test(html));assert.match(html,/href="\.\/index.html"/);
 assert.deepEqual([...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(m=>m[1]),['./capacitor.js','./account-native.js','./organization-native.js','./organization.js']);
 assert.ok(!files.some(name=>/\.db$|\.json$|\.env|node_modules|supabase/i.test(name)));
}finally{await rm(temporary,{recursive:true,force:true});}
console.log('Organization native transport: realm isolation, strict wire, cancellation/configuration races, and isolated bundle entry passed');
