/** Real IndexedDB isolation for different API servers in one bundled WebView origin. */
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const scripts=new Map(await Promise.all(['offline.js','uploads.js'].map(async name=>['/'+name,await readFile(new URL('../static/'+name,import.meta.url))])));
const server=createServer((request,response)=>{response.setHeader('Cache-Control','no-store');if(scripts.has(request.url)){response.setHeader('Content-Type','application/javascript; charset=utf-8');response.end(scripts.get(request.url));}else{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><meta charset="utf-8"><title>Native cache verification</title>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;const errors=[];
async function load(page,backend,native=true,storage=true,outboxEnabled=native){
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(({backend,native,storage,outboxEnabled})=>{
    // Namespace-only fixture. Native durability has separate fault/SQLite tests.
    if(storage)globalThis.FountainNativeStorage={profileId:backend+'|same-workspace|same-member|same-binding',validUntil:Date.now()+3600000,run:(db,names,mode,callback)=>new Promise((resolve,reject)=>{
      const tx=db.transaction(names,mode);let value;tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error);
      Promise.resolve().then(()=>callback(tx)).then(result=>{value=result;}).catch(error=>{try{tx.abort();}catch{}reject(error);});
    })};
    globalThis.FountainTransport=Object.freeze({origin:backend,native,outboxEnabled});globalThis.registrations=0;navigator.serviceWorker.register=()=>{globalThis.registrations++;return Promise.reject(new Error('fixture only'));};},{backend,native,storage,outboxEnabled});
  await page.addScriptTag({url:origin+'/offline.js'});await page.addScriptTag({url:origin+'/uploads.js'});
}
async function profile(page){return page.evaluate(()=>FountainOffline.saveProfile({workspaceId:'same-workspace',memberId:'same-member',workspace:{pages:[],databases:[]},session:{mode:'accounts',authenticated:true,cache_binding:'same-binding',expires_at:new Date(Date.now()+3600000).toISOString(),member:{id:'same-member',active:true}}}));}
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();const a=await context.newPage(),b=await context.newPage();
  await load(a,'https://family-a.example',true,false);
  assert.equal(await a.evaluate(async()=>{try{await FountainOffline.getProfile();return false;}catch(error){return error.status===503;}}),true,'native reads must fail closed without durable adapter');
  assert.equal(await a.evaluate(async()=>{try{await FountainOffline.saveProfile({workspaceId:'same-workspace',memberId:'same-member',session:{authenticated:true,mode:'local',cache_binding:'missing-storage',member:{id:'same-member'}}});return false;}catch(error){return error.status===503;}}),true,'native writes must not silently use IndexedDB without adapter');
  await load(a,'https://family-a.example');const first=await profile(a);
  const firstKey=await a.evaluate(p=>FountainOffline.key(p,'same-page'),first);
  await a.evaluate(key=>FountainOffline.saveDraft(key,'client-a',{reason:'fixture',blocks:[{id:'block-a',text:'A private draft'}]}),firstKey);
  assert.equal((await a.evaluate(key=>FountainOffline.getDrafts(key),firstKey)).length,1);
  const uploadA=await a.evaluate(()=>{const manager=new FountainUploads.UploadManager({scope:{workspaceId:'same-workspace',memberId:'same-member',binding:'same-binding',pageId:'same-page'},isCurrent:()=>true});const id=manager.scopeId;manager.dispose();return id;});
  assert.ok(first.id.startsWith('https://family-a.example|'));
  assert.equal(await a.evaluate(()=>registrations),0);assert.equal(await a.evaluate(()=>FountainOffline.serviceWorkerReady),null);
  await load(b,'https://family-b.example');
  assert.equal(await b.evaluate(()=>FountainOffline.getProfile()),null,'same local origin cannot expose other backend profile');
  assert.deepEqual(await b.evaluate(key=>FountainOffline.getDrafts(key),firstKey),[]);
  const second=await profile(b);assert.notEqual(second.id,first.id);
  const uploadB=await b.evaluate(()=>{const manager=new FountainUploads.UploadManager({scope:{workspaceId:'same-workspace',memberId:'same-member',binding:'same-binding',pageId:'same-page'},isCurrent:()=>true});const id=manager.scopeId;manager.dispose();return id;});assert.notEqual(uploadA,uploadB);
  assert.equal(await a.evaluate(()=>FountainOffline.getProfile()),null,'old backend tab is fenced after active backend changes');
  assert.equal(await a.evaluate(async key=>{try{await FountainOffline.saveDraft(key,'late-a',{blocks:[{id:'late',text:'late write'}]});return false;}catch(e){return e.name==='SecurityError';}},firstKey),true);
  const browserContext=await browser.newContext();const browserPage=await browserContext.newPage();await load(browserPage,origin,false);const normal=await profile(browserPage);assert.ok(normal.id.startsWith(origin+'|'));assert.equal(await browserPage.evaluate(()=>registrations),1,'browser SW registration stays enabled');
  const disabledContext=await browser.newContext(),disabledPage=await disabledContext.newPage();
  await load(disabledPage,'https://disabled.example',true,false,false);
  const disabledProfile=await profile(disabledPage);assert.ok(disabledProfile.id.startsWith('https://disabled.example|'));
  assert.equal(await disabledPage.evaluate(()=>typeof FountainNativeStorage),'undefined');
  assert.deepEqual(await disabledPage.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('fountain-offline-v1');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;resolve({version:db.version,journal:db.objectStoreNames.contains('nativeJournal')});db.close();};})),{version:2,journal:false},'disabled native foundation preserves the original cache schema');
  assert.deepEqual(errors,[]);
  console.log('PASS native storage absence fails closed; namespace fixture backend cache/upload isolation, stale writes, native SW skip and browser SW preservation');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
