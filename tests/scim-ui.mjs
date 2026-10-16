import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const model=source.split('// BEGIN SCIM VIEW MODEL')[1].split('\n').slice(1).join('\n').split('// END SCIM VIEW MODEL')[0];
const {createScimView,scimGrantStatus}=vm.runInNewContext(model+';({createScimView,scimGrantStatus})',{Date,encodeURIComponent});
const token='A'.repeat(43),now=Date.parse('2026-10-17T01:00:00Z');
const grant=(extra={})=>({id:'23199380-2d12-4ebc-bc14-5c1f51e8fffb',purpose:'scim',version:1,enabled:false,issuer_member_id:'owner',created_at:'2026-10-17T01:00:00Z',expires_at:null,pending_until:'2026-10-17T01:15:00Z',...extra});
const json=value=>JSON.parse(JSON.stringify(value));
function setup(handler){let live=true,changes=0,disposed=0;const calls=[];const view=createScimView({request:async(...args)=>{calls.push(json(args));return handler(...args);},current:()=>live,changed:()=>changes++,disposed:()=>disposed++,newId:()=>grant().id,now:()=>now});return {view,calls,stale:()=>{live=false;},changes:()=>changes,disposed:()=>disposed};}
const listing={tokens:[],next_cursor:null};
test('distinguishes never-activated, enabled, expired and permanently revoked grants',()=>{
  assert.equal(scimGrantStatus(grant(),now),'활성화 대기');
  assert.equal(scimGrantStatus(grant({enabled:true}),now),'활성');
  assert.equal(scimGrantStatus(grant({pending_until:'2026-10-17T00:59:59Z'}),now),'활성화 기한 만료');
  assert.equal(scimGrantStatus(grant({enabled:true,expires_at:'2026-10-17T00:59:59Z'}),now),'만료됨');
  assert.equal(scimGrantStatus(grant({version:2,expires_at:'2026-10-17T00:59:59Z'}),now),'철회됨');
});
test('shows first credential only in private closure; metadata snapshot strips unknown secrets',async()=>{
  const {view}=setup(async path=>path.includes('?')?listing:{grant:{...grant(),token},token});
  await view.load();await view.issue();assert.equal(view.secret(),token);assert.equal(view.snapshot().hasSecret,true);
  assert.equal(JSON.stringify(view.snapshot()).includes(token),false);view.close();assert.equal(view.secret(),null);assert.equal(view.snapshot().selected,null);
});
test('lost creation acknowledgement retries exact UUID and expiry, never a new issuance',async()=>{
  let attempts=0;const s=setup(async(path)=>path.includes('?')?listing:++attempts===1?Promise.reject(new TypeError('lost')):{grant:grant(),token_unavailable:true});
  await s.view.load();await s.view.issue('2026-10-18T00:00:00.000Z');assert.ok(s.view.snapshot().creation);
  await s.view.issue(null);assert.deepEqual(s.calls[1],s.calls[2]);assert.equal(s.view.secret(),null);
  assert.match(s.view.snapshot().error,/철회/);await s.view.issue();assert.equal(s.calls.length,3);
});
test('requires explicit acknowledgement and holds same token for activation retry after lost ACK',async()=>{
  let activate=0;const s=setup(async(path,body)=>path.includes('?')?listing:path.endsWith('/activate')?++activate===1?Promise.reject(new TypeError('lost')):{grant:grant({enabled:true})}:{grant:grant(),token});
  await s.view.load();await s.view.issue();await s.view.activate('',false);assert.equal(s.calls.length,2);
  await s.view.activate('',true);assert.equal(s.view.secret(),token);await s.view.activate('',true);
  assert.deepEqual(s.calls[2],s.calls[3]);assert.equal(s.view.secret(),null);assert.equal(s.view.snapshot().selected.enabled,true);
});
test('manual proof is transient and not exposed as newly issued token',async()=>{
  const s=setup(async path=>path.includes('?')?{tokens:[grant()],next_cursor:null}:{grant:grant({enabled:true})});await s.view.load();s.view.select(grant().id);
  await s.view.activate('wrong',true);assert.equal(s.calls.length,1);await s.view.activate(token,true);
  assert.equal(s.calls[1][1].token,token);assert.equal(s.view.secret(),null);assert.equal(JSON.stringify(s.view.snapshot()).includes(token),false);
});
test('permanent revocation needs second explicit click and new creation waits for revoked result',async()=>{
  const s=setup(async(path,body,method)=>path.includes('?')?listing:method==='DELETE'?{grant:grant({version:2})}:{grant:grant(),token});
  await s.view.load();await s.view.issue();s.view.restart();assert.ok(s.view.snapshot().selected);
  await s.view.revoke(grant().id);assert.equal(s.calls.length,2);await s.view.revoke(grant().id);
  assert.equal(s.calls[2][2],'DELETE');assert.equal(s.view.secret(),null);s.view.restart();assert.equal(s.view.snapshot().selected,null);
});
test('close during issuance prevents late token publication and clears transaction memory',async()=>{
  let resolve;const s=setup(async path=>path.includes('?')?listing:new Promise(done=>{resolve=done;}));await s.view.load();const pending=s.view.issue();s.view.close();const changes=s.changes();resolve({grant:grant(),token});await pending;
  assert.equal(s.view.secret(),null);assert.equal(s.changes(),changes);assert.equal(s.view.snapshot().selected,null);assert.equal(s.disposed(),1);
});
test('identity change during acknowledgement disposes view and never publishes response',async()=>{
  let resolve;const s=setup(async path=>path.includes('?')?listing:new Promise(done=>{resolve=done;}));await s.view.load();const pending=s.view.issue();s.stale();resolve({grant:grant(),token});await pending;
  assert.equal(s.view.secret(),null);assert.equal(s.disposed(),1);assert.equal(s.view.snapshot().tokens.length,0);
});
test('same view serializes repeated issuance clicks',async()=>{
  let resolve;const s=setup(async path=>path.includes('?')?listing:new Promise(done=>{resolve=done;}));await s.view.load();const a=s.view.issue(),b=s.view.issue();assert.equal(s.calls.length,2);resolve({grant:grant(),token});await Promise.all([a,b]);assert.equal(s.view.secret(),token);
});
test('opaque pagination encodes cursor and avoids duplicate rows',async()=>{
  const second=grant({id:'00000000-0000-4000-8000-000000000002'});let page=0;const s=setup(async()=>++page===1?{tokens:[grant()],next_cursor:'opaque/+='}:{tokens:[grant(),second],next_cursor:null});await s.view.load();await s.view.load(true);
  assert.equal(s.calls[1][0],'/scim/tokens?limit=50&cursor=opaque%2F%2B%3D');assert.equal(s.view.snapshot().tokens.length,2);assert.equal(s.view.snapshot().cursor,null);
});
test('legacy endpoint unavailable disables only SCIM creation and explains server support',async()=>{
  const s=setup(async()=>{throw Object.assign(new Error('notfound'),{status:404});});await s.view.load();assert.equal(s.view.snapshot().available,false);assert.match(s.view.snapshot().error,/현재 서버/);await s.view.issue();assert.equal(s.calls.length,1);
});
test('past expiry is rejected before issuing a credential',async()=>{
  const s=setup(async()=>listing);await s.view.load();await s.view.issue('2026-10-17T00:59:59Z');assert.equal(s.calls.length,1);assert.equal(s.view.snapshot().creation,null);
});
test('lifecycle integration clears credentials at modal, settings, logout, boot and pagehide boundaries',()=>{
  for(const pattern of [/function openModal[^]*?clearScimPanel\(\)/,/function closeModal[^]*?clearScimPanel\(\)/,/async function openSettings[^]*?clearScimPanel\(\)/,/async function renderSettings[^]*?clearScimPanel\(\)/,/case'logout':\{\s*clearScimPanel\(\)/,/async function boot\(\) \{\s*clearScimPanel\(\)/,/function renderLogin[^]*?clearScimPanel\(\)/,/addEventListener\('pagehide',clearScimPanel\)/])assert.match(source,pattern);
  assert.doesNotMatch(model,/localStorage|indexedDB|console\.|state\./);
});
