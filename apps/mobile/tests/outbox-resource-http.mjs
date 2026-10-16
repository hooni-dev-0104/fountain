/** Actual disposable Python HTTP -> real Chrome IDB -> SQLite proof MODEL.
 * The HTTPS origin is a model label bound to an actual HTTP login's public
 * identity. This test does NOT run native code, an Android/iOS SDK, or TLS.
 * Only the Node-side test observer receives canonical HTTP responses; renderer
 * records never install native resource proofs.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteBridge} from './outbox-fixture.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const repository=fileURLToPath(new URL('../../../',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'fountain-outbox-resource-http-'));
const modelOrigin='https://native-proof-model.invalid';
const adapter=await readFile(new URL('../web/native-outbox.js',import.meta.url));
const offline=await readFile(new URL('../../../static/offline.js',import.meta.url));
let server,browser,owner,reader,page,mock,httpOrigin,stage='startup';
let bytesDelivered=0,readCalls=0;
const pageErrors=[];

async function startServer(){
  // Explicit SQLite path and an environment without production DSN/token values.
  const environment={PATH:process.env.PATH,HOME:homedir(),PYTHONUNBUFFERED:'1',FOUNTAIN_ACCESS_TOKEN:''};
  server=spawn(python,['-m','fountain.server','--database','sqlite','--port','0','--data',join(temporary,'workspace.sqlite')],
    {cwd:repository,env:environment,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(new Error('Disposable SQLite server did not start')),15000);
    const consume=chunk=>{output+=chunk;const match=output.match(/Fountain: http:\/\/localhost:(\d+)/);if(match){clearTimeout(timeout);resolve('http://127.0.0.1:'+match[1]);}};
    server.stdout.on('data',consume);server.stderr.on('data',consume);
    server.once('error',error=>{clearTimeout(timeout);reject(error);});
    server.once('exit',()=>{clearTimeout(timeout);reject(new Error('Disposable SQLite server exited during startup'));});
  });
}
async function api(context,path,body,{method=body===undefined?'GET':'POST',status=200}={}){
  const response=await context.request.fetch(httpOrigin+path,{method,headers:{'X-Fountain-Request':'1'},...(body===undefined?{}:{data:body})});
  assert.equal(response.status(),status,path);return response.json();
}
function observe(path,response,options){
  // Test-only stand-in for the native observer. Body and revisions are actual
  // HTTP JSON, never synthesized, renumbered, or made "ready" by this test.
  return mock.observeCanonical(path,response,options);
}
function assertIdentity(response,session){
  assert.equal(response.workspace_id,session.workspace_id);
  assert.equal(response.current_member_id,session.member.id);
  assert.equal(response.session_binding,session.cache_binding);
  assert.ok(Number.isSafeInteger(response.access_revision)&&response.access_revision>=0);
  assert.ok(Number.isSafeInteger(response.data_revision)&&response.data_revision>=0);
}
async function rawIDB(){
  // Deliberately bypass the adapter only to inspect preserved bytes after its
  // gate rejects. No fixture records or proofs are written through this helper.
  return page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('fountain-offline-v1',3);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{return await new Promise((resolve,reject)=>{
      const names=Array.from(db.objectStoreNames),tx=db.transaction(names),values={};
      for(const name of names){const request=tx.objectStore(name).getAll();request.onsuccess=()=>values[name]=request.result;}
      tx.oncomplete=()=>resolve(values);tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
    });}finally{db.close();}
  });
}
async function refreshCode(){
  return page.evaluate(async()=>{try{await storage.refreshAuth();return null;}catch(error){return error.code;}});
}
async function blockedRead(){
  const calls=readCalls,bytes=bytesDelivered;
  await assert.rejects(mock.readPage({generation:1,lease:mock.lease,head:mock.head,proofEpoch:mock.proofEpoch,cursor:null,byteLimit:256*1024}),
    error=>error.code==='OUTBOX_ACCESS_REQUIRED');
  assert.equal(readCalls,calls+1);assert.equal(bytesDelivered,bytes,'A rejected native read must deliver zero record bytes');
}

try{
  httpOrigin=await startServer();
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
  owner=await browser.newContext({serviceWorkers:'block'});
  reader=await browser.newContext({serviceWorkers:'block'});
  const password='Native-resource-HTTP-fixture-password';
  const accounts=await api(owner,'/api/accounts');
  const ownerAccount=accounts.accounts.find(member=>member.role==='owner');assert.ok(ownerAccount);
  await api(owner,'/api/accounts',{member_id:ownerAccount.id,password},{status:201});
  const member=await api(owner,'/api/members',{name:'Fixture member',email:'resource-fixture@example.invalid',role:'member'},{status:201});
  await api(owner,'/api/accounts',{member_id:member.id,password},{status:201});
  await api(owner,'/api/accounts/enable',{});
  await api(owner,'/api/session',{email:ownerAccount.email,password});
  const session=await api(reader,'/api/session',{email:member.email,password});
  assert.equal(session.authenticated,true);assert.notEqual(session.member.active,false);
  assert.equal(session.mode,'accounts');assert.ok(Date.parse(session.expires_at)>Date.now());
  const database=await api(owner,'/api/databases',{id:'native-resource-http-db',name:'Assigned rows',
    permissions:{default:'private',members:{[member.id]:'edit'}},
    row_permissions:{mode:'assigned',property_id:'assignee',edit_assigned:true,allow_create:false},
    properties:[{id:'name',name:'Name',type:'title'},{id:'assignee',name:'Assignee',type:'person'}]},{status:201});
  const databasePath='/api/databases/'+encodeURIComponent(database.id);
  const first=await api(owner,databasePath+'/rows',{id:'visible-a',properties:{name:'Keep original A',assignee:member.id}},{status:201});
  const second=await api(owner,databasePath+'/rows',{id:'visible-b',properties:{name:'Keep original B',assignee:member.id}},{status:201});
  await api(owner,databasePath+'/rows',{id:'owner-only',properties:{name:'Owner only',assignee:ownerAccount.id}},{status:201});
  const document=await api(owner,'/api/pages',{id:'native-resource-http-page',title:'Proof document',
    permissions:{default:'private',members:{[member.id]:'edit'}},blocks:[{id:'text',text:'Canonical fixture body'}]},{status:201});
  const pagePath='/api/pages/'+encodeURIComponent(document.id);
  const profileId=[modelOrigin,session.workspace_id,session.member.id,session.cache_binding].map((part,index)=>index?encodeURIComponent(part):part).join('|');
  mock=new SQLiteBridge(join(temporary,'native-model.sqlite'),{origin:modelOrigin,profileId,generation:1});
  // Mirror the actual login's expiry; this is model grant setup, not a proof setter.
  mock.validUntil=Date.parse(session.expires_at);
  const read=mock.readPage.bind(mock);
  mock.readPage=async args=>{readCalls++;const response=await read(args);bytesDelivered+=response.fragments.reduce((sum,value)=>sum+Buffer.from(value.bytesBase64,'base64').length,0);return response;};

  stage='canonical lazy initialization and actual revision floors';
  const initialWorkspace=await api(reader,'/api/workspace');assertIdentity(initialWorkspace,session);
  observe('/api/workspace',initialWorkspace);
  const collaboration=await api(reader,pagePath+'/collaboration');assertIdentity(collaboration,session);
  assert.ok(collaboration.data_revision>initialWorkspace.data_revision,'Lazy CRDT seeding must raise the actual global counter');
  observe(pagePath+'/collaboration',collaboration);
  const lazyEpoch=mock.proofEpoch,lazyHead=mock.head,lazyProofs=mock.proofs;
  assert.throws(()=>observe('/api/workspace',initialWorkspace),'Earlier HTTP workspace must not lower the floor');
  assert.equal(mock.proofEpoch,lazyEpoch);assert.equal(mock.head,lazyHead);assert.deepEqual(mock.proofs,lazyProofs);
  const workspace=await api(reader,'/api/workspace');assertIdentity(workspace,session);
  assert.equal(workspace.data_revision,collaboration.data_revision);observe('/api/workspace',workspace);
  const databaseSnapshot=await api(reader,databasePath);assertIdentity(databaseSnapshot,session);observe(databasePath,databaseSnapshot);
  assert.equal(databaseSnapshot.data_revision,workspace.data_revision);
  assert.deepEqual(new Set(databaseSnapshot.rows.map(row=>row.id)),new Set([first.id,second.id]));
  assert.equal(databaseSnapshot.database.access_level,3);assert.equal(databaseSnapshot.database.can_create_row,false);
  const floorBefore=mock.control('revisionFloors')[profileId];
  assert.equal(floorBefore.dataRevision,databaseSnapshot.data_revision);assert.equal(mock.head,0,'Read-only proof observations never advance business head');

  stage='unsupported actual write responses cannot grant or revoke database read proof';
  const deniedCreate=await api(reader,databasePath+'/rows',{properties:{name:'Not permitted',assignee:member.id}},{status:403});
  const proofEpoch=mock.proofEpoch,proofs=mock.proofs;
  assert.throws(()=>observe(databasePath+'/rows',deniedCreate,{status:403}));
  const operations=await api(reader,pagePath+'/operations',{epoch:collaboration.epoch,ops:[]});
  assertIdentity(operations,session);assert.deepEqual(operations.ack,[]);
  assert.throws(()=>observe(pagePath+'/operations',operations));
  assert.equal(mock.proofEpoch,proofEpoch);assert.deepEqual(mock.proofs,proofs);
  const query='?filters='+encodeURIComponent(JSON.stringify([{property:'name',value:'Keep original A'}]));
  const filtered=await api(reader,databasePath+query);assert.equal(filtered.rows.length,1);
  assert.throws(()=>observe(databasePath+query,filtered));
  assert.equal(mock.proofEpoch,proofEpoch);

  stage='actual HTTP profile and snapshots become native-confirmed Chrome IDB';
  await reader.route(httpOrigin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><script src="/native-outbox.js"></script>'}));
  await reader.route(httpOrigin+'/native-outbox.js',route=>route.fulfill({contentType:'application/javascript',body:adapter}));
  await reader.route(httpOrigin+'/offline.js',route=>route.fulfill({contentType:'application/javascript',body:offline}));
  await reader.exposeBinding('nativeFixture',async(_,method,args)=>{try{return{value:await mock[method](args)};}catch(error){return{error:{code:error.code,message:'Fixture native proof rejected'}};}});
  page=await reader.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(httpOrigin);
  await page.evaluate(async origin=>{
    window.FountainTransport={native:true,outboxEnabled:true,origin};
    const bridge=Object.fromEntries(['outboxOpen','stageDelta','commitDelta','readPage'].map(method=>[method,async args=>{const reply=await nativeFixture(method,args);if(reply.error)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.value;} ]));
    window.storage=FountainNativeOutbox.create(bridge,{origin,generation:1});await storage.initialize();window.FountainNativeStorage=storage;
  },modelOrigin);
  await page.addScriptTag({url:httpOrigin+'/offline.js'});
  await page.evaluate(async({session,workspace,databaseSnapshot,collaboration,modelOrigin})=>{
    const profile=await FountainOffline.saveProfile({workspaceId:session.workspace_id,memberId:session.member.id,session,workspace});
    if(profile.origin!==modelOrigin)throw Error('Test-only native model origin did not bind');
    globalThis.profile=profile;globalThis.databaseKey=FountainOffline.databaseKey(profile,databaseSnapshot.database.id);
    globalThis.pageKey=FountainOffline.key(profile,collaboration.page.id);
    await FountainOffline.saveDatabase(databaseKey,databaseSnapshot);
    await FountainOffline.saveSnapshot(pageKey,collaboration);
    await FountainOffline.saveDraft(pageKey,'http-proof-draft',{epoch:collaboration.epoch,text:'원문은 권한 변경 뒤에도 삭제하면 안 됩니다😀'});
  },{session,workspace,databaseSnapshot,collaboration,modelOrigin});
  assert.equal(await page.evaluate(()=>storage.ready),true);assert.deepEqual(mock.issues(),[]);
  const baselineIDB=await rawIDB(),baselineNative=mock.records(),baselineHead=mock.head;
  assert.equal(baselineIDB.databaseSnapshots[0].snapshot.rows.length,2);
  assert.equal(baselineIDB.drafts[0].draft.text,'원문은 권한 변경 뒤에도 삭제하면 안 됩니다😀');
  assert.ok(baselineHead>0);assert.ok(baselineIDB.nativeJournal.every(record=>record.kind==='checkpoint'));

  stage='data-only assignment change then newer workspace blocks old DB/cache agreement';
  await api(owner,databasePath+'/rows/'+encodeURIComponent(first.id),{properties:{assignee:ownerAccount.id}},{method:'PATCH'});
  const newerWorkspace=await api(reader,'/api/workspace');assertIdentity(newerWorkspace,session);
  assert.equal(newerWorkspace.access_revision,workspace.access_revision,'Assignment-only narrowing changes data, not the ACL counter');
  assert.ok(newerWorkspace.data_revision>databaseSnapshot.data_revision);
  observe('/api/workspace',newerWorkspace);
  assert.equal(mock.head,baselineHead);
  assert.equal(mock.control('revisionFloors')[profileId].dataRevision,newerWorkspace.data_revision);
  assert.equal(mock.proofs['database:'+database.id].dataRevision,databaseSnapshot.data_revision,'Old database proof still agrees with old cache; only the private floor closes this gap');
  assert.ok(mock.issues().some(issue=>issue.kind==='database'&&issue.id===database.id&&issue.reason==='revision_changed'));
  await page.evaluate(()=>{const clear=IDBObjectStore.prototype.clear;window.clearCalls=0;IDBObjectStore.prototype.clear=function(...args){clearCalls++;return clear.apply(this,args);};});
  await blockedRead();
  const bytesBefore=bytesDelivered;
  assert.equal(await refreshCode(),'OUTBOX_ACCESS_REQUIRED');
  assert.equal(bytesDelivered,bytesBefore,'First-page preflight must reject before any private cache byte is delivered');
  assert.equal(await page.evaluate(()=>clearCalls),0);
  assert.deepEqual(await rawIDB(),baselineIDB);assert.deepEqual(mock.records(),baselineNative);assert.equal(mock.head,baselineHead);
  assert.equal(await page.evaluate(()=>storage.resourceAccess),'required');
  const currentEpoch=mock.proofEpoch,currentProofs=mock.proofs,currentFloors=mock.control('revisionFloors');
  assert.throws(()=>observe(databasePath,databaseSnapshot),'Late stale HTTP database response must not reinstall old row authority');
  assert.equal(mock.proofEpoch,currentEpoch);assert.deepEqual(mock.proofs,currentProofs);assert.deepEqual(mock.control('revisionFloors'),currentFloors);assert.equal(mock.head,baselineHead);
  const narrower=await api(reader,databasePath);assertIdentity(narrower,session);assert.deepEqual(narrower.rows.map(row=>row.id),[second.id]);
  observe(databasePath,narrower);
  assert.ok(mock.issues().some(issue=>issue.kind==='database'&&issue.id===database.id),'A fresh narrower proof cannot promote the old wider cache');
  await blockedRead();assert.deepEqual(await rawIDB(),baselineIDB);assert.deepEqual(mock.records(),baselineNative);assert.equal(mock.head,baselineHead);

  stage='actual locked GET and actual denied database GET remain distinct evidence';
  await api(owner,pagePath,{locked:true},{method:'PATCH'});
  const locked=await api(reader,pagePath+'/collaboration');assertIdentity(locked,session);assert.equal(locked.page.locked,true);
  observe(pagePath+'/collaboration',locked);
  await api(reader,pagePath+'/operations',{epoch:locked.epoch,ops:[]},{status:423});
  assert.ok(mock.issues().some(issue=>issue.kind==='page'&&issue.id===document.id&&issue.reason==='denied'));
  await api(owner,databasePath+'/permissions',{permissions:{default:'private',members:{}}},{method:'PATCH'});
  const notFound=await api(reader,databasePath,undefined,{status:404});
  observe(databasePath,notFound,{status:404});
  assert.ok(mock.issues().some(issue=>issue.kind==='database'&&issue.id===database.id&&issue.reason==='denied'));
  await blockedRead();assert.deepEqual(await rawIDB(),baselineIDB);assert.equal(mock.head,baselineHead);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS actual disposable SQLite HTTP -> Chrome real IDB -> SQLite native-proof MODEL: lazy-seed floors, data-only assigned-row narrowing, zero-byte gate, preserved IDB/native/head, stale/query/POST rejection, lock423 and canonical404; NOT native SDK/device/TLS evidence');
} catch(error){
  console.error('Outbox resource HTTP QA failed at: '+stage);throw error;
} finally{
  await browser?.close();mock?.close();
  if(server&&server.exitCode===null&&server.signalCode===null){
    const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');
    await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);
    if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await exited;}
  }
  await rm(temporary,{recursive:true,force:true});
}
