/** Actual boot error boundary: a failed legacy native handshake cannot authorize a retry. */
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function boot(){');
const bootSource=source.slice(start,source.indexOf("\nwindow.addEventListener('fountain-workspace-auth-required'",start));
function setup({cached=false,handshakeFailure,native=true,observeFailure,online=!cached}={}){
 const values=new Map(cached?[['absence','1']]:[]),effects={handshakes:0,legacy:0,offline:0},main={innerHTML:''},state={loaded:false};
 const absence=()=>observeFailure||Object.assign(new Error(cached?'unreachable account endpoint':'explicitly absent account directory'),cached?{code:'NATIVE_NETWORK_UNREACHABLE'}:{status:404,code:'ACCOUNT_DIRECTORY_ABSENT'});
 const transport={native,isNetworkUnavailable:error=>error?.code==='NATIVE_NETWORK_UNREACHABLE',useLegacyWorkspace:async()=>{effects.handshakes++;if(handshakeFailure)throw handshakeFailure;}};
 const context=vm.createContext({globalThis:null,state,FountainAccount:{Account:class{async observe(){throw absence();}}},FountainTransport:transport,TypeError,navigator:{onLine:online},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},absentDirectoryKey:()=> 'absence',bootLegacy:()=>{effects.legacy++;},workspaceRoute:()=>({workspaceId:'existing'}),openOfflineWorkspace:async()=>{effects.offline++;return true;},$:()=>main,esc:value=>String(value).replace(/</g,'&lt;')});
 context.globalThis=context;vm.runInContext(bootSource+'\nglobalThis.runBoot=boot;',context);return{state,effects,main,values,boot:()=>context.runBoot()};
}
let passed=0;
for(const cached of [false,true])for(const [name,properties] of [['storage',{code:'NATIVE_STORAGE'}],['TLS',{code:'NATIVE_TLS'}],['timeout',{code:'NATIVE_TIMEOUT'}],['HTTP denial',{status:403}]]){
 const model=setup({cached,handshakeFailure:Object.assign(new Error(name+' handshake denied'),properties)});
 await model.boot();assert.match(model.main.innerHTML,/<h2>계정에 연결하지 못했습니다\.<\/h2>/);assert.equal(model.state.accountMode,undefined);assert.equal(model.state.loaded,false);assert.equal(model.effects.legacy,0);assert.equal(model.effects.offline,0);
 await model.boot();assert.equal(model.effects.handshakes,2,'retry must repeat the native barrier');assert.equal(model.effects.legacy,0);assert.equal(model.state.accountMode,undefined);passed++;
}
for(const cached of [false,true]){const model=setup({cached});await model.boot();assert.equal(model.effects.handshakes,1);assert.equal(model.effects.legacy,1);assert.equal(model.state.accountMode,false);assert.equal(model.values.get('absence'),'1');assert.equal(model.main.innerHTML,'');passed++;}
// The caught account failure must be tested independently of a successful
// legacy handshake: cached platform metadata cannot override a current denial.
for(const native of [true,false])for(const problem of [
 Object.assign(new Error('HTTP account denied'),{status:401}),
 Object.assign(new Error('HTTP workspace denied'),{status:403}),
 Object.assign(new Error('HTTP service unavailable'),{status:503}),
 Object.assign(new Error('secure storage denied'),{code:'NATIVE_STORAGE'}),
 Object.assign(new Error('certificate rejected'),{code:'NATIVE_TLS'}),
 Object.assign(new Error('request timed out'),{code:'NATIVE_TIMEOUT'}),
 Object.assign(new TypeError('TLS failure is not offline'),{code:'NATIVE_TLS'}),
 Object.assign(new TypeError('broad native network code is not confirmed unreachable'),{code:'NETWORK_ERROR'}),
 Object.assign(new Error('expired request'),{name:'TimeoutError'}),
 new TypeError('The encoded data was not valid for encoding utf-8'),
 Object.assign(new TypeError('Failed to fetch'),{name:'TimeoutError'}),
 Object.assign(new TypeError('network status is not absent'),{code:'NATIVE_NETWORK_UNREACHABLE',status:503})
]){const model=setup({cached:true,native,observeFailure:problem});await model.boot();assert.equal(model.effects.handshakes,0,'current denial must not attempt legacy even if handshake would succeed');assert.equal(model.effects.legacy,0);assert.equal(model.effects.offline,0);assert.equal(model.state.accountMode,undefined);assert.match(model.main.innerHTML,/<h2>계정에 연결하지 못했습니다\.<\/h2>/);passed++;}
for(const native of [true,false])for(const status of [404,405,501]){const model=setup({cached:true,native,observeFailure:Object.assign(new Error('legacy capability'),{status})});await model.boot();assert.equal(model.effects.legacy,1);passed++;}
for(const online of [false,true]){const model=setup({cached:true,online,native:true,observeFailure:Object.assign(new TypeError('confirmed OS reachability failure'),{code:'NATIVE_NETWORK_UNREACHABLE'})});await model.boot();assert.equal(model.effects.handshakes,1);assert.equal(model.effects.legacy,1);passed++;}
for(const message of ['Failed to fetch','Load failed','NetworkError when attempting to fetch resource.']){const model=setup({cached:true,native:false,observeFailure:new TypeError(message)});await model.boot();assert.equal(model.effects.handshakes,1);assert.equal(model.effects.legacy,1);passed++;}
console.log(JSON.stringify({passed,scope:'actual app boot native legacy handshake success/failure and retry boundary',nativeSDKVerified:false}));
