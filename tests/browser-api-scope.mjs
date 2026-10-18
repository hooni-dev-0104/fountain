/** Exercise the actual app API admission function around synchronous native auth fences. */
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
const apiSource=source.slice(source.indexOf('async function api('),source.indexOf('\nfunction toast(',source.indexOf('async function api(')));
const response=(status=200,value={authenticated:true})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function setup({scoped=false,accountMode=false,transitionAdvance=1,onInvoke}={}){
 let epoch=8,origin='https://first.example.invalid',generation=4,workspace=scoped?{workspaceId:'A',binding:'a'.repeat(32)}:null;
 const calls=[],pending=[],effects=[];
 const state={accountMode,session:{cache_binding:'a'.repeat(32),member:{id:'actor'},workspace_id:'A'},bootGeneration:3,workspaceSwitching:false};
 const transport={native:true,get scopeEpoch(){return epoch;},get origin(){return origin;},get generation(){return generation;},workspaceScope:()=>workspace,
 request(path,options={}){calls.push({path,method:options.method||'GET'});if(path==='/api/session'&&['POST','DELETE'].includes(options.method))epoch+=transitionAdvance;onInvoke?.(controls);return new Promise(resolve=>pending.push(resolve));},
 capture(){return{request:(...args)=>transport.request(...args)};}};
 const controls={state,calls,pending,effects,transport,advance(){epoch++;},configure(){generation++;origin='https://second.example.invalid';epoch++;},switchWorkspace(){workspace={workspaceId:'B',binding:'b'.repeat(32)};epoch++;state.session={...state.session,workspace_id:'B',cache_binding:'b'.repeat(32)};},get epoch(){return epoch;}};
 const context=vm.createContext({FountainTransport:transport,state,closeModal:()=>effects.push('modal'),renderLogin:()=>effects.push('login')});
 vm.runInContext(apiSource+'\nglobalThis.callAPI=api;',context);controls.api=(...args)=>context.callAPI(...args);return controls;
}
let passed=0;
async function check(name,run){await run();passed++;}
for(const method of ['POST','DELETE'])await check('own synchronous legacy '+method+' survives its single intentional fence',async()=>{const model=setup(),value={authenticated:method==='POST',cache_binding:'next'};const pending=model.api('/session',{password:'fixture-only'},method);assert.equal(model.epoch,9);model.pending.shift()(response(200,value));assert.equal(JSON.stringify(await pending),JSON.stringify(value));assert.deepEqual(model.effects,[]);});
for(const [method,status] of [['POST',401],['DELETE',409]])await check('own legacy '+method+' preserves its negative HTTP result',async()=>{const model=setup(),pending=model.api('/session',{},method);model.pending.shift()(response(status,{error:'fixture authentication rejected'}));await assert.rejects(pending,error=>error.status===status&&error.code!=='STALE_REQUEST');assert.deepEqual(model.effects,[]);});
await check('another synchronous auth fence cannot be mistaken for the sole own fence',async()=>{const model=setup({onInvoke:control=>control.advance()}),pending=model.api('/session',{},'POST');model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
await check('generation change is rejected even if origin and public epoch stay unchanged',async()=>{const model=setup(),pending=model.api('/workspace');Object.defineProperty(model.transport,'generation',{value:5});model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
await check('ordinary read rejects a synchronous unrelated epoch change',async()=>{const model=setup({onInvoke:control=>control.advance()});const pending=model.api('/workspace');model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
await check('a second auth transition invalidates the earlier login',async()=>{const model=setup(),first=model.api('/session',{},'POST'),second=model.api('/session',{},'DELETE');model.pending.shift()(response());await assert.rejects(first,error=>error.code==='STALE_REQUEST');model.pending.shift()(response(200,{authenticated:false}));assert.equal((await second).authenticated,false);});
await check('own login rejects a synchronous configuration change too',async()=>{const model=setup({onInvoke:control=>control.configure()}),pending=model.api('/session',{},'POST');model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
await check('configuration change with an unchanged epoch still invalidates context',async()=>{const model=setup(),pending=model.api('/workspace');Object.defineProperty(model.transport,'origin',{value:'https://changed.example.invalid'});model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
await check('no transition exception exists for account/scoped /session POST',async()=>{const model=setup({scoped:true,accountMode:true}),pending=model.api('/session',{},'POST');model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
for(const status of [200,401])await check('old A '+status+' cannot paint or log out B',async()=>{const model=setup({scoped:true,accountMode:true}),pending=model.api('/pages/old',status===200?{title:'A'}:undefined);model.switchWorkspace();model.pending.shift()(response(status,{title:'old A'}));await assert.rejects(pending,error=>error.code==='STALE_REQUEST');assert.equal(model.state.session.workspace_id,'B');assert.deepEqual(model.effects,[]);assert.equal(model.calls.length,1);});
await check('a transition during JSON consumption remains stale',async()=>{const model=setup(),pending=model.api('/session',{},'POST');let finishJSON,enteredJSON;const reading=new Promise(resolve=>enteredJSON=resolve);model.pending.shift()({ok:true,status:200,json:()=>{enteredJSON();return new Promise(resolve=>finishJSON=resolve);}});await reading;model.advance();finishJSON({authenticated:true});await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
await check('a workspace switch after own synchronous fence rejects its login ACK',async()=>{const model=setup(),pending=model.api('/session',{},'POST');model.switchWorkspace();model.pending.shift()(response());await assert.rejects(pending,error=>error.code==='STALE_REQUEST');});
console.log(JSON.stringify({passed,scope:'actual app api admission; controlled native synchronous auth/config/workspace fences',nativeSDKVerified:false}));
