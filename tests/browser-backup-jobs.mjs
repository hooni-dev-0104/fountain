/** Real Chrome, the actual app/Service Worker and a disposable Python workspace.
 * Job endpoints are a bounded HTTP protocol fixture; no cloud/SQL-job claim.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {waitForAsync} from './async-browser.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-backup-browser-')),root=fileURLToPath(new URL('../',import.meta.url)),CHUNK=256*1024;
const data=Buffer.alloc(CHUNK*5+173);for(let i=0;i<data.length;i++)data[i]=(i*31+Math.floor(i/65536)*7)&255;data.write('SQLite format 3\0');const digest=createHash('sha256').update(data).digest('hex');
const protocolErrors=[];
let python,browser,server,page,origin,upstream,stage='startup',mode='success',sessionMode='same',job=null,createCalls=[],stepCalls=[],ranges=[],legacyCalls=0,deletes=0,createReceipts=new Map(),stepReceipts=new Map(),lost=false,rangeEntered,rangeReady,rangeClosed=false,releaseRange;
const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
function reset(next){mode=next;sessionMode='same';job=null;createCalls=[];stepCalls=[];ranges=[];legacyCalls=0;deletes=0;createReceipts=new Map();stepReceipts=new Map();lost=false;rangeClosed=false;rangeReady=new Promise(resolve=>{rangeEntered=resolve;});}
function value(){return {...job,progress:{source_rows:job.version?10:0,output_bytes:job.phase==='ready'?data.length:0,writer_phase:job.phase==='ready'?'done':null},...(job.phase==='ready'?{size:data.length,sha256:digest}:{})};}
async function startPython(){
 const executable=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
 python=spawn(executable,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')],{cwd:root,env:{PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});
 return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Python fixture startup timeout')),15000);const receive=chunk=>{output+=chunk;const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};python.stdout.on('data',receive);python.stderr.on('data',receive);python.once('error',reject);python.once('exit',code=>{clearTimeout(timer);if(!upstream)reject(Error('Fixture exited '+code));});});
}
async function proxy(request,response){
 const chunks=[];for await(const bytes of request)chunks.push(bytes);
 const headers=new Headers();for(const [key,value]of Object.entries(request.headers))if(!['host','connection','content-length'].includes(key)&&typeof value==='string')headers.set(key,value);
 const result=await fetch(upstream+request.url,{method:request.method,headers,redirect:'manual',...(chunks.length?{body:Buffer.concat(chunks)}:{})});
 const out=Object.fromEntries([...result.headers].filter(([key])=>!['content-encoding','transfer-encoding','content-length','connection'].includes(key)));response.writeHead(result.status,out);response.end(Buffer.from(await result.arrayBuffer()));
}
async function handle(request,response){
 try{
  const url=new URL(request.url,'http://fixture');
  assert(!request.url.includes('__fountain_backup_stream')&&!request.url.includes('fountain%255fbackup'),'a worker-only handoff must never reach the HTTP backend');assert(!String(request.headers.referer||'').includes('/__fountain_backup_stream/'),'a handoff capability must not become an HTTP referrer');
  if(url.pathname==='/sw.js'&&url.searchParams.has('fixture-new-issuer')){response.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});response.end('// New isolated issuer fixture\n'+await readFile(join(root,'static/sw.js'),'utf8'));return;}
  if(url.pathname==='/api/session'&&request.method==='GET'&&sessionMode!=='same'){
   const session=await (await fetch(upstream+'/api/session')).json();if(sessionMode==='deny')Object.assign(session,{required:true,authenticated:false,member:null});else session.cache_binding='changed-binding';return json(response,200,session);
  }
  if(url.pathname==='/api/backup/jobs'&&request.method==='POST'){
   if(mode==='legacy'||mode==='legacy-405')return json(response,mode==='legacy'?404:405,{});if(mode==='deny-create')return json(response,401,{});if(mode==='network-create'){response.destroy();return;}
   let text='';for await(const bytes of request)text+=bytes;const body=JSON.parse(text);assert.match(body.transaction_id,/^[a-f0-9-]{36}$/);createCalls.push(body.transaction_id);
   if(!createReceipts.has(body.transaction_id)){job={id:randomUUID(),phase:'snapshot',revision:1,version:0,expires_at:new Date(Date.now()+(mode==='expired-create'?-1000:600000)).toISOString()};createReceipts.set(body.transaction_id,value());}
   return json(response,201,createReceipts.get(body.transaction_id));
  }
  const matched=/^\/api\/backup\/jobs\/([a-f0-9-]+)(\/step)?$/.exec(url.pathname);
  if(matched){
   if(!job||matched[1]!==job.id)return json(response,404,{});
   if(request.method==='DELETE'){deletes++;job.phase='cancelled';job.version++;return json(response,200,{...value(),cleanup_pending:true});}
   if(sessionMode==='deny')return json(response,401,{});
   if(request.method==='GET')return json(response,mode==='early-denied'?401:mode==='expired-download'?410:200,['early-denied','expired-download'].includes(mode)?{}:value());
   if(request.method==='POST'&&matched[2]){
    if(mode==='expired-step')return json(response,410,{});
    let text='';for await(const bytes of request)text+=bytes;const body=JSON.parse(text);stepCalls.push(body.transaction_id);
    if(!stepReceipts.has(body.transaction_id)){job.version++;job.phase=job.version===1?'building':'ready';stepReceipts.set(body.transaction_id,value());}
    return json(response,job.phase==='ready'?200:202,stepReceipts.get(body.transaction_id));
   }
  }
  if(url.pathname==='/api/backup'&&url.searchParams.has('job_id')){
   assert(job&&url.searchParams.get('job_id')===job.id);assert.equal(request.method,'GET');const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers.range||'');assert(range,'worker must never forward an unbounded job download');const first=Number(range[1]),end=Number(range[2]);assert(end-first+1<=CHUNK);assert(end<data.length);ranges.push([first,end]);rangeEntered();
   if(sessionMode==='deny')return json(response,401,{});
   const output=Buffer.from(data.subarray(first,end+1));if(mode==='corrupt'&&end===data.length-1)output[0]^=1;
   response.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':output.length,'Content-Range':`bytes ${mode==='bad-range'?first+1:first}-${end}/${data.length}`,'Cache-Control':'no-store'});
   response.on('close',()=>{rangeClosed=true;});
   if(mode==='cancel'||mode==='live-proof'){response.write(output.subarray(0,65536));releaseRange=()=>response.end(output.subarray(65536));return;}
   response.end(output);
   if(mode==='switch-binding'&&ranges.length===1)sessionMode='changed';
   return;
  }
  if(url.pathname==='/api/backup'&&!url.search)legacyCalls++;
  return proxy(request,response);
 }catch(error){if(!response.headersSent)json(response,500,{error:'Fixture rejected an unexpected protocol request'});else response.destroy();throw error;}
}
async function open(){await page.evaluate(()=>openSettings('export'));await page.locator('[data-action="backup"]').waitFor();await page.locator('[data-action="backup"]').click();}
async function managerState(expected){try{await waitForAsync(page,async value=>state.backupManager?.state===value,expected,{timeout:20000});}catch(error){console.error('backup manager condition',expected,await page.evaluate(()=>({state:state.backupManager?.state,closed:state.backupManager?.closed,text:document.querySelector('#backup-status')?.textContent})),{createCalls,stepCalls,ranges});throw error;}}
async function navigationStatus(tab,url){try{return (await tab.goto(url)).status();}catch{throw Error('Fixture capability navigation did not settle');}}
async function holdHandoff(tab){await tab.evaluate(()=>{const original=document.body.append;globalThis.fixtureAppend=original;document.body.append=function(...nodes){const frame=nodes.find(node=>node instanceof HTMLIFrameElement&&node.src.includes('/__fountain_backup_stream/'));if(frame){globalThis.fixtureFrame=frame;return;}return original.apply(this,nodes);};});}
async function releaseHandoff(tab){await tab.evaluate(()=>{document.body.append=fixtureAppend;fixtureAppend.call(document.body,fixtureFrame);delete globalThis.fixtureAppend;delete globalThis.fixtureFrame;});}
const progress=process.env.FOUNTAIN_BACKUP_TEST_TRACE?setInterval(()=>console.error('Backup test phase:',stage),10000):null;
try{
 stage='native exact route and cancellation contract';
 const events=new EventTarget(),document=new EventTarget(),cancelled=[];document.visibilityState='visible';let heldDownload=false;
 const nativeContext=vm.createContext({URL,URLSearchParams,Headers,Response,Blob,ArrayBuffer,Uint8Array,TextEncoder,DOMException,EventTarget,Event,MessageEvent,CustomEvent,AbortController,structuredClone,setTimeout,clearTimeout,queueMicrotask,btoa,atob,document,navigator:{onLine:true},location:{origin:'https://localhost',pathname:'/',href:'https://localhost/'},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
 vm.runInContext(await readFile(new URL('../apps/mobile/web/native-transport.js',import.meta.url),'utf8'),nativeContext);
 const native=nativeContext.FountainNativeTransport.create({getConfiguration:async()=>({origin:'https://fixture.invalid',generation:1}),cancel:async value=>{cancelled.push(value.id);return{};},download:async value=>{heldDownload=true;return new Promise(()=>{});}});await native.initialize();
 const jobPath='/api/backup?job_id='+randomUUID();assert(native.downloadURL(jobPath));for(const path of ['/api/backup?x=1',jobPath+'&x=1',jobPath+'&job_id=x','/api/backup?job_id=../x','/api/attachments/id/download?job_id='+randomUUID()])assert.throws(()=>native.downloadURL(path));
 const signal=new AbortController(),nativePending=native.download(jobPath,'backup.sqlite',{signal:signal.signal});await Promise.resolve();await Promise.resolve();assert(heldDownload);signal.abort();await assert.rejects(nativePending,e=>e.name==='AbortError');assert.equal(cancelled.length,1);
 upstream=await startPython();server=createServer((req,res)=>{void handle(req,res).catch(error=>{protocolErrors.push(error.message);});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});const context=await browser.newContext({acceptDownloads:true}),errors=[];page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.waitForSelector('[data-action="settings"]',{timeout:20000});
 await page.evaluate(async()=>{await FountainOffline.serviceWorkerReady;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
 stage='incremental SHA vectors';assert.equal(await page.evaluate(()=>{const hash=new FountainBackup.SHA256();hash.update(new TextEncoder().encode('abc'));return hash.hex();}),createHash('sha256').update('abc').digest('hex'));
 stage='actual SW streaming download';reset('success');let event=page.waitForEvent('download');await open();let download=await event;assert.equal(await download.failure(),null);const saved=await readFile(await download.path());assert.equal(saved.length,data.length);assert.equal(createHash('sha256').update(saved).digest('hex'),digest);await managerState('complete');assert.equal(ranges.length,6);assert.equal(legacyCalls,0);
 stage='one-use handoff and continuing original-window proof';await page.evaluate(()=>closeModal());reset('success');await holdHandoff(page);await open();await managerState('downloading');
 const capability=await page.evaluate(()=>({jobId:state.backupManager.job.id,token:state.backupManager.transferId,scope:{workspaceId:state.backupManager.scope.workspaceId,memberId:state.backupManager.scope.memberId,binding:state.backupManager.scope.binding}}));
 const foreign=await context.newPage();assert.equal(await navigationStatus(foreign,origin+'/api/backup?job_id='+capability.jobId),409);assert.equal(await navigationStatus(foreign,origin+'/__fountain_backup_stream/'+'0'.repeat(64)),409);assert.equal(ranges.length,0);await foreign.goto(origin);await foreign.waitForSelector('[data-action="settings"]');
 for(const jobId of [capability.jobId,capability.jobId.toUpperCase(),randomUUID()]){const registration=await foreign.evaluate(value=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=event=>{channel.port1.close();resolve(event.data.ok);};navigator.serviceWorker.controller.postMessage({type:'fountain-backup-register',jobId:value.jobId,transferId:value.token,scope:value.scope},[channel.port2]);}),{...capability,jobId});assert.equal(registration,false);}
 assert.match(capability.token,/^[A-Za-z0-9_-]{43}$/);
 const reserved='/__fountain_backup_stream/'+capability.token;
 for(const [method,path]of [['HEAD',reserved],['GET',reserved+'?extra=1'],['POST',reserved],['GET','/__fountain_backup_stream%2f'+capability.token],['GET','/%5f%5ffountain_backup_stream/'+capability.token],['GET','/%255f%255ffountain_backup_stream/'+capability.token],['GET','/x/%252e%252e/__fountain_backup_stream/'+capability.token],['GET','/__fountain_backup_stream/'+capability.token+'/extra'],['GET','//__fountain_backup_stream/'+capability.token]]){
  assert.equal(await foreign.evaluate(async value=>(await fetch(location.origin+value.path,{method:value.method})).status,{method,path}),409);
 }
 assert.deepEqual(protocolErrors,[]);
 assert.equal(await foreign.evaluate(async path=>(await fetch(path)).status,'/__fountain_backup_stream/'+capability.token),409);assert.equal(ranges.length,0);
 event=page.waitForEvent('download');await releaseHandoff(page);download=await event;assert.equal(await download.failure(),null);await managerState('complete');const rangeCount=ranges.length;assert.equal(await navigationStatus(foreign,origin+'/__fountain_backup_stream/'+capability.token),409);assert.equal(ranges.length,rangeCount);await foreign.close();
 stage='expired unused capabilities cannot be registered by another source or a new worker';await page.evaluate(()=>closeModal());reset('success');await holdHandoff(page);await open();await managerState('downloading');
 const expired=await page.evaluate(()=>({jobId:state.backupManager.job.id,token:state.backupManager.transferId,scope:{workspaceId:state.backupManager.scope.workspaceId,memberId:state.backupManager.scope.memberId,binding:state.backupManager.scope.binding}}));
 const stranger=await context.newPage();await stranger.goto(origin);await stranger.waitForSelector('[data-action="settings"]');
 const registerChosen=async tab=>tab.evaluate(value=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=event=>{channel.port1.close();resolve(event.data.ok);};navigator.serviceWorker.controller.postMessage({type:'fountain-backup-register',jobId:value.jobId,transferId:value.token,scope:value.scope},[channel.port2]);}),expired);
 const worker=context.serviceWorkers().find(value=>value.url().includes('/sw.js'));await worker.evaluate(()=>{globalThis.fixtureNow=Date.now;Date.now=()=>fixtureNow()+61001;});
 assert.equal(await registerChosen(stranger),false);assert.equal(await navigationStatus(stranger,origin+'/__fountain_backup_stream/'+expired.token),409);await worker.evaluate(()=>{Date.now=fixtureNow;delete globalThis.fixtureNow;});await page.evaluate(()=>{document.body.append=fixtureAppend;delete globalThis.fixtureAppend;delete globalThis.fixtureFrame;closeModal();});
 await page.evaluate(async()=>{const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));await navigator.serviceWorker.register('/sw.js?fixture-new-issuer=1',{scope:'/'});await Promise.race([changed,new Promise((_,reject)=>setTimeout(()=>reject(Error('New worker issuer timeout')),10000))]);});
 await stranger.goto(origin);await stranger.waitForSelector('[data-action="settings"]');assert.equal(await registerChosen(stranger),false);assert.equal(await navigationStatus(stranger,origin+'/__fountain_backup_stream/'+expired.token),409);assert.equal(ranges.length,0);await stranger.close();
 const cached=await page.evaluate(async()=>{const urls=[];for(const name of await caches.keys())for(const request of await (await caches.open(name)).keys())urls.push(new URL(request.url).pathname);return urls;});assert(!cached.some(path=>path.startsWith('/api/')||path.startsWith('/__fountain_backup_stream/')));
 for(const kind of ['create','step']){
  stage='exact '+kind+' retry after lost ACK';await page.evaluate(()=>closeModal());reset('success');
  await page.evaluate(kind=>{const original=FountainTransport;globalThis.fixtureTransport=original;let lost=false;globalThis.FountainTransport=Object.freeze({...original,request:async(path,options)=>{const response=await original.request(path,options);if(!lost&&(kind==='create'?path==='/api/backup/jobs':path.endsWith('/step'))){lost=true;await response.body?.cancel();throw new TypeError('Fixture discarded an already committed acknowledgement');}return response;}});},kind);
  await open();await managerState('error');assert.equal(kind==='create'?createCalls.length:stepCalls.length,1);
  event=page.waitForEvent('download');await page.locator('[data-action="backup-retry"]').click();download=await event;assert.equal(await download.failure(),null);await managerState('complete');const receipts=kind==='create'?createCalls:stepCalls;assert.equal(receipts[0],receipts[1]);assert.equal(new Set(stepCalls).size,2);assert.equal(job.version,2);
  await page.evaluate(()=>{globalThis.FountainTransport=fixtureTransport;delete globalThis.fixtureTransport;});
 }
 stage='cancel aborts in-flight private range';await page.evaluate(()=>closeModal());reset('cancel');event=page.waitForEvent('download');await open();download=await event;await rangeReady;await page.locator('[data-action="backup-cancel"]').click();assert.notEqual(await download.failure(),null);await waitForAsync(page,async()=>!state.backupManager,null,{timeout:5000});await new Promise(resolve=>setTimeout(resolve,50));assert(rangeClosed);assert.equal(ranges.length,1);assert.equal(deletes,1);
 stage='live scope proof blocks bytes even when timer-based cancellation has not run';reset('live-proof');event=page.waitForEvent('download');await open();download=await event;await rangeReady;await page.evaluate(()=>{clearInterval(state.backupManager.watch);state.backupManager.isCurrent=()=>false;});releaseRange();assert.notEqual(await download.failure(),null);assert.equal(ranges.length,1);assert.notEqual(await page.evaluate(()=>state.backupManager.state),'complete');await page.evaluate(()=>closeModal());
 for(const changed of ['auth-generation','document-epoch']){
  stage='client scope fence '+changed;reset('cancel');event=page.waitForEvent('download');
  await page.evaluate(changed=>{openSettings('export');if(changed==='document-epoch'){globalThis.fixtureChannel=state.channel;state.channel={base:{epoch:'before-backup'},breakHistory(){},close(){}};}},changed);await page.locator('[data-action="backup"]').click();download=await event;await rangeReady;
  await page.evaluate(changed=>{if(changed==='auth-generation')state.bootGeneration=(state.bootGeneration||0)+1;else state.channel.base.epoch='changed-after-backup';},changed);
  assert.notEqual(await download.failure(),null);await waitForAsync(page,async()=>state.backupManager?.closed===true,null,{timeout:5000});assert.equal(ranges.length,1);
  await page.evaluate(changed=>{closeModal();if(changed==='document-epoch'){state.channel=fixtureChannel;delete globalThis.fixtureChannel;}},changed);
 }
 for(const scenario of ['corrupt','bad-range','switch-binding']){
  stage='stream failure '+scenario;reset(scenario);event=page.waitForEvent('download');await open();download=await event;assert.notEqual(await download.failure(),null,scenario);await managerState('error');assert.equal(legacyCalls,0);if(scenario==='switch-binding')assert.equal(ranges.length,1);await page.evaluate(()=>closeModal());
 }
 stage='early stream authorization denial preserves the application';reset('early-denied');await open();await managerState('error');assert.equal(new URL(page.url()).origin,origin);assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('.backup-modal').count(),1);assert.match(await page.locator('#backup-status').textContent(),/다시 로그인/);assert.equal(ranges.length,0);assert.equal(legacyCalls,0);await page.evaluate(()=>closeModal());
 for(const scenario of ['expired-create','expired-step','expired-download']){
  stage='expired job starts a fresh job '+scenario;reset(scenario);await open();await managerState('error');assert.equal(await page.evaluate(()=>state.backupManager.restartRequired),true);assert.equal(await page.locator('[data-action="backup-retry"]').textContent(),'새 백업 시작');const old=createCalls[0];mode='success';event=page.waitForEvent('download');await page.locator('[data-action="backup-retry"]').click();download=await event;assert.equal(await download.failure(),null);await managerState('complete');assert.notEqual(createCalls.at(-1),old);await page.evaluate(()=>closeModal());
 }
 stage='closed registered source cannot authorize a copied capability';reset('success');const source=await context.newPage();await source.goto(origin);await source.waitForSelector('[data-action="settings"]');await holdHandoff(source);await source.evaluate(()=>openSettings('export'));await source.locator('[data-action="backup"]').click();await waitForAsync(source,async()=>state.backupManager?.state==='downloading',null,{timeout:10000});const closedToken=await source.evaluate(()=>state.backupManager.transferId);await source.close();const other=await context.newPage();assert.equal(await navigationStatus(other,origin+'/__fountain_backup_stream/'+closedToken),401);assert.equal(ranges.length,0);await other.close();
 for(const scenario of ['legacy','legacy-405']){stage='confirmed legacy fallback '+scenario;reset(scenario);event=page.waitForEvent('download');await open();download=await event;assert.equal(await download.failure(),null);assert.equal(legacyCalls,1);assert.equal((await readFile(await download.path())).subarray(0,16).toString(),'SQLite format 3\0');await managerState('legacy');await page.evaluate(()=>closeModal());}
 for(const scenario of ['deny-create','network-create']){stage='no unsafe fallback '+scenario;reset(scenario);await open();await managerState('error');assert.equal(legacyCalls,0);await page.evaluate(()=>closeModal());}
 assert.deepEqual(errors,[]);assert.deepEqual(protocolErrors,[]);console.log(JSON.stringify({ok:true,actualChrome:true,actualAppUI:true,actualServiceWorkerDownload:true,rangeLimit:CHUNK,sha256:true,exactRetry:true,cancel:true,authBinding:true,clientEpochFence:true,oneUseHandoff:true,workerIssuedCapabilities:true,reservedPrefixNeverUpstream:true,expiredAndRestartedIssuer:true,liveSourceProof:true,expiredRestarts:true,nativeQueryAndSignal:true,legacy404405Only:true,privateCacheEntries:0,realCloudJobs:false}));
}catch(error){console.error('Backup browser stage:',stage);throw error;}
finally{if(progress)clearInterval(progress);if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(python&&python.exitCode===null){python.kill('SIGTERM');await new Promise(resolve=>{python.once('exit',resolve);setTimeout(resolve,3000);});}await rm(directory,{recursive:true,force:true});}
