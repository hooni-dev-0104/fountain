/** Execute shared settlement vectors through the production JS adapter and Chrome IDB.
 * SQLite receipt/staging is a MODEL; stop deliberately before native plan policy. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReconcileBridge} from './reconcile-fixture.mjs';
const corpus=JSON.parse(await readFile(new URL('./fixtures/native-reconcile-cases.json',import.meta.url))),cases=corpus.cases.filter(value=>value.id.startsWith('settle-')||value.id==='legacy-delete-no-before-image');
const jsTargets=corpus.executionCoverage.js;assert.equal(jsTargets.length,5);assert.deepEqual(cases.filter(value=>value.executionTargets.includes('js')).map(value=>value.id).sort(),[...jsTargets].sort());assert.ok(jsTargets.every(id=>cases.some(value=>value.id===id)));
const workspaceEpoch=process.env.FOUNTAIN_TEST_WORKSPACE_EPOCH==='1'?7:null;
const source=await readFile(new URL('../web/native-outbox.js',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'fountain-journal-vectors-'));
const require=createRequire(import.meta.url),{chromium}=require(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let server,browser;const fixtures=[];
try{
  server=createServer((_,res)=>{res.setHeader('content-type','application/javascript');res.end(source);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const vector of cases){
    const intent=vector.legacyJournal[0],origin=intent.origin,current=origin+'|workspace|member-a|'+(corpus.authorities[vector.events.find(event=>event.type==='auth_change')?.authority||vector.authority].session.cache_binding),fixture=new ReconcileBridge(join(temporary,vector.id+'.sqlite'),{origin,profileId:current,authoritative:{}});fixtures.push(fixture);fixture.db.prepare("UPDATE control SET value=3 WHERE id='head'").run();fixture.db.prepare("UPDATE control SET value=2 WHERE id='proofEpoch'").run();
    fixture.putControl('stage:'+intent.txId,{lease:fixture.lease,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch});
    if(vector.receiptLookup.accepted){fixture.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(intent.txId,createHash('sha256').update(intent.deltaJSON).digest('hex'),4);fixture.putControl('receipt:'+intent.txId,{profileId:current,proofEpoch:2,mode:'active'});fixture.db.prepare("UPDATE control SET value=4 WHERE id='head'").run();}
    if(vector.id==='settle-beforeimage-receipt-failure')fixture.failCommit=true;
    const context=await browser.newContext();await context.exposeBinding('model',async(_,method,args)=>{try{if(workspaceEpoch!==null)assert.equal(args.workspaceEpoch,workspaceEpoch);const value=await fixture[method](args);return{value:workspaceEpoch===null?value:{...value,workspaceEpoch}};}catch(error){return{error:{code:error.code,message:error.message}};}});const page=await context.newPage();await page.goto(endpoint);await page.addScriptTag({url:endpoint});
    const observed=await page.evaluate(async({origin,intent,current,workspaceEpoch})=>{
      const bridge=Object.fromEntries(['outboxOpen','outboxReconcile','readPage','stageDelta','commitDelta'].map(name=>[name,async args=>{const result=await model(name,args);if(result.error)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.value;}]));
      const initial=FountainNativeOutbox.create(bridge,{origin,generation:1,workspaceEpoch});await initial.initialize();initial.close();
      const db=await new Promise(resolve=>{const open=indexedDB.open('fountain-offline-v1',3);open.onsuccess=()=>resolve(open.result);});await new Promise(resolve=>{const tx=db.transaction('nativeJournal','readwrite');tx.objectStore('nativeJournal').put(intent);tx.oncomplete=resolve;});db.close();
      const driver={scope:()=>({scopeEpoch:1}),current:()=>true,pause(){},resume(){},session:async()=>{throw Object.assign(new Error('Bounded harness ends before collector'),{code:'OUTBOX_TEST_STOP'});}};
      const storage=FountainNativeOutbox.create(bridge,{origin,generation:1,workspaceEpoch,driver});let code;try{await storage.initialize();}catch(error){code=error.code;}
      const read=await new Promise(resolve=>{const open=indexedDB.open('fountain-offline-v1',3);open.onsuccess=()=>resolve(open.result);});const rows=await new Promise(resolve=>{const tx=read.transaction('nativeJournal'),request=tx.objectStore('nativeJournal').getAll();request.onsuccess=()=>resolve(request.result);});read.close();storage.close();return{code,journals:rows.filter(row=>row.kind!=='checkpoint')};
    },{origin,intent,current,workspaceEpoch});
    if(['settle-foreign-binding','legacy-delete-no-before-image'].includes(vector.id)){assert.equal(observed.code,'OUTBOX_RECOVERY_REQUIRED');assert.deepEqual(observed.journals,[intent]);if(vector.id==='settle-foreign-binding')assert.equal(fixture.reconcileCalls.length,0);else {assert.ok(fixture.cancelled.has(intent.txId));assert.equal(fixture.records('recovery').length,0);}}
    else if(vector.id==='settle-beforeimage-receipt-failure'){assert.equal(observed.journals.length,1);assert.equal(observed.journals[0].txId,intent.txId);assert.ok(observed.journals[0].archive);assert.equal(fixture.records('recovery').length,0);}
    else{
      assert.equal(observed.code,'OUTBOX_TEST_STOP');assert.equal(observed.journals.length,0);assert.equal(fixture.reconcileCalls.filter(call=>call.phase==='prepare').length,0);
      if(vector.receiptLookup.accepted){assert.equal(fixture.records('recovery').length,0);assert.equal(fixture.head,4);}
      else{assert.ok(fixture.cancelled.has(intent.txId));const expected=vector.expected.journalRecoveryPuts||JSON.parse(intent.deltaJSON).changes.filter(change=>change.op==='put').map(({bucket,key,value})=>({bucket,key,value}));const actual=fixture.records('recovery').map(row=>({bucket:row.bucket,key:JSON.parse(row.key),value:JSON.parse(row.value)}));const sort=rows=>rows.sort((a,b)=>JSON.stringify([a.bucket,a.key]).localeCompare(JSON.stringify([b.bucket,b.key])));assert.deepEqual(sort(actual),sort(expected));assert.equal(fixture.records().length,0);}
    }
    await context.close();
  }
  const output=join(process.cwd(),'.data/native-outbox-activation');await mkdir(output,{recursive:true});await writeFile(join(output,workspaceEpoch===null?'js-execution-coverage.json':'js-scoped-execution-coverage.json'),JSON.stringify({version:1,implementation:'production native-outbox.js',workspaceEpoch,runtime:'actual Chrome IndexedDB; SQLite staging/receipt MODEL; stop before native collector',jsRequired:jsTargets,jsPassed:jsTargets,additionalPassed:cases.map(value=>value.id).filter(id=>!jsTargets.includes(id)),nativePassed:[],bridgePassed:[],corpusSha256:createHash('sha256').update(await readFile(new URL('./fixtures/native-reconcile-cases.json',import.meta.url))).digest('hex')},null,2)+'\n');
  console.log('PASS '+(workspaceEpoch===null?'legacy':'scoped epoch7')+' production JS settlement on '+cases.length+' shared vectors: '+cases.map(value=>value.id).join(', ')+'; Chrome IDB + SQLite MODEL only, collector/native transform deliberately not exercised');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));for(const fixture of fixtures)fixture.close();await rm(temporary,{recursive:true,force:true});}
