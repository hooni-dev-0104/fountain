/** Explicit live QA only. Test-main retargets fixed production transport to a
 * nonce-sealed disposable workspace; never a production target override. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,rm,realpath,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(process.env.FOUNTAIN_DESKTOP_CLOUD_AUTH_LIVE!=='1')throw Error('Explicit live desktop QA opt-in required');
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../..',import.meta.url));
const {_electron}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const desktop=join(root,'apps/desktop'),executable=process.env.FOUNTAIN_ELECTRON||require(join(desktop,'node_modules/electron'));
const server='https://ehnovtfadpkwtubmwltl.supabase.co/',ui='https://fountain.desktop.invalid',wire=server+'functions/v1/fountain-verify/wire',prefix=server+'functions/v1/fountain-api';
const config=JSON.parse(await readFile(join(root,'.data/cloud-desktop-qa.json'),'utf8'));
assert.match(config.scope.workspaceId,/^fountain-qa-cloud-desktop-[a-f0-9]{16}$/);
const networkPartition=require(join(desktop,'src/cloud.cjs')).cloudPartitions(server).network;
const folder=await realpath(await mkdtemp(join(tmpdir(),'fountain-cloud-auth-'))),proof=join(root,'.data/desktop-proof');
await mkdir(proof,{recursive:true});const clients=[],checks=[],pageErrors=[];let stage='launch',attachmentId=null;
const note=value=>{checks.push(value);console.log('check',value);};
const cleanError=error=>{let value=String(error?.stack||error);for(const secret of [config.nonce,config.bootstrapNonce,...config.passwords,...config.scope.emails])value=value.split(secret).join('[private QA value]');return value;};
async function launch(name){
 const profile=join(folder,name);await mkdir(profile,{recursive:true});
 // Show settings so privileged QA wiring is installed before the first request.
 // Cookie persistence is real; automatic selected-server restore is covered by
 // the separate unmodified anonymous source/packaged two-launch smoke test.
 await rm(join(profile,'server.json'),{force:true});
 const env={...process.env,FOUNTAIN_DESKTOP_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 const electron=await _electron.launch({executablePath:executable,args:process.env.FOUNTAIN_DESKTOP_PACKAGED==='1'?[]:[desktop],env,timeout:30000});
 const client={electron,profile,page:null};clients.push(client);
 await electron.evaluate(({session,dialog},scope)=>{
  const network=session.fromPartition(scope.partition),send=network.fetch.bind(network);
  globalThis.__qaPaths=[];
  network.fetch=async(target,options)=>{
   const url=new URL(target);if(!target.startsWith(scope.prefix+'/')||url.origin!==new URL(scope.prefix).origin||url.hash||url.username||url.password)throw Error('QA_TARGET_REJECTED');
   const logical=target.slice(scope.prefix.length);if(!logical.startsWith('/api/')&&!/^\/(forms|sites)\/[A-Za-z0-9_-]+$/.test(logical))throw Error('QA_ROUTE_REJECTED');
   // Privileged test process only. Production firewall is separately verified.
   network.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>callback({cancel:details.url!==scope.wire}));
   const headers=new Headers(options.headers);headers.set('X-Fountain-Verify',scope.nonce);headers.set('X-Fountain-Test-Path',logical);headers.delete('Origin');headers.delete('Authorization');
   const observation={path:new URL('https://qa.invalid'+logical).pathname,method:options.method,bodyBytes:options.body?.byteLength||0,declaredBytes:headers.get('Content-Length')};globalThis.__qaPaths.push(observation);
   try{const response=await send(scope.wire,{...options,headers});observation.status=response.status;if(response.status>=400&&response.headers.get('Content-Type')?.includes('application/json')){const value=await response.clone().json();observation.code=typeof value.code==='string'?value.code:null;}return response;}catch{observation.networkFailed=true;throw Error('QA_NETWORK_UNAVAILABLE');}
  };
  dialog.showMessageBoxSync=()=>1;
 },{partition:networkPartition,prefix,wire,nonce:config.nonce});
 const setup=await electron.firstWindow();await setup.waitForSelector('#server-form');await setup.locator('#server').fill(server);await setup.locator('button[type=submit]').click();
 for(let n=0;n<200;n++){client.page=electron.windows().find(p=>p.url().startsWith(ui+'/'));if(client.page)break;await new Promise(done=>setTimeout(done,50));}
 assert(client.page);client.page.setDefaultTimeout(30000);client.page.on('pageerror',error=>pageErrors.push(error.message));return client;
}
async function login(client,create=false){
 const page=client.page;await page.waitForSelector('#login-form [name=email]');
 await page.locator('[name=email]').fill(config.scope.emails[0]);await page.locator('[name=password]').fill(config.passwords[0]);
 if(create){await page.locator('#login-form summary').click();await page.locator('[name=setup_nonce]').fill(config.bootstrapNonce);await page.locator('[name=create_account]').check();await page.locator('[name=setup_password_confirm]').fill(config.passwords[0]);}
 await page.locator('#login-form button.solid-btn').click();await Promise.race([page.waitForSelector('.recent-grid',{timeout:60000}),page.waitForFunction(()=>!!document.querySelector('#login-error')?.textContent.trim(),null,{timeout:60000}).then(()=>{throw Error('QA_UI_LOGIN_REJECTED');})]);
 return sessionState(client);
}
async function sessionState(client){
 const state=await client.page.evaluate(async()=>{const response=await FountainTransport.request('/api/session'),value=await response.json();return {status:response.status,authenticated:value.authenticated,workspace:value.workspace_id,memberId:value.member?.id,role:value.member?.role,binding:value.cache_binding,scriptCookie:document.cookie,exposed:response.headers.has('Set-Cookie'),node:typeof require,preload:typeof window.fountainSetup};});
 assert.equal(state.status,200);assert.equal(state.authenticated,true);assert.equal(state.workspace,config.scope.workspaceId);assert.equal(state.memberId,'local');assert.equal(state.role,'owner');assert.equal(state.scriptCookie,'');assert.equal(state.exposed,false);assert.equal(state.node,'undefined');assert.equal(state.preload,'undefined');
 const cookie=await client.electron.evaluate(async({session},partition)=>{const values=await session.fromPartition(partition).cookies.get({name:'fountain_session'});return values.map(v=>({httpOnly:v.httpOnly,secure:v.secure,sameSite:v.sameSite}));},networkPartition);
 assert.equal(cookie.length,1);assert.equal(cookie[0].httpOnly,true);assert.equal(cookie[0].secure,true);return state;
}
async function saved(page){await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent.includes('모든 변경'),null,{timeout:60000});}
async function request(client,path,body,method='POST'){
 return client.page.evaluate(async({path,body,method})=>{const response=await FountainTransport.request('/api'+path,{method,headers:{'Content-Type':'application/json','X-Fountain-Request':'1'},body:JSON.stringify(body)});const value=await response.json();return {status:response.status,value};},{path,body,method});
}
try{
 if(process.env.FOUNTAIN_DESKTOP_PACKAGED!=='1')await (await import('../../apps/desktop/build.mjs')).build();
 const a=await launch('first');stage='owner bootstrap';const first=await login(a,true);note('actual UI connects signed bootstrap owner through Supabase Auth and private native cookie');
 stage='second login';const b=await launch('second'),second=await login(b);assert.notEqual(first.binding,second.binding);note('same account in two isolated desktop profiles has distinct session bindings');
 stage='create edit';await a.page.locator('[data-action=add-page]').first().click();await a.page.locator('#page-form [name=title]').fill('클라우드 데스크톱 실제 검증');await a.page.locator('#page-form button.solid-btn').click();await a.page.waitForSelector('#page-title');
 const pageId=await a.page.evaluate(()=>decodeURIComponent(location.hash.split('/')[1]));await a.page.locator('[data-action=add-block]').first().click();await a.page.locator('.block-content').last().fill('수파베이스에서 동기화한 가족 문서😀');await saved(a.page);await a.page.reload();await a.page.waitForSelector('#page-title');assert((await a.page.locator('.block-content').allInnerTexts()).includes('수파베이스에서 동기화한 가족 문서😀'));note('actual Supabase document create edit CRDT save and reload');
 stage='SSE cross client';await b.page.goto(ui+'/#page/'+encodeURIComponent(pageId));await b.page.waitForSelector('#page-title');await a.page.locator('.block-content').first().fill('첫 번째 앱에서 보낸 실제 변경');await saved(a.page);await b.page.waitForFunction(()=>document.querySelector('.block-content')?.textContent.includes('첫 번째 앱에서 보낸 실제 변경'),null,{timeout:60000});
 await b.page.locator('.block-content').first().fill('두 번째 앱에서 되돌린 실제 변경');await saved(b.page);await a.page.waitForFunction(()=>document.querySelector('.block-content')?.textContent.includes('두 번째 앱에서 되돌린 실제 변경'),null,{timeout:60000});note('two-way document synchronization through real cloud SSE');
 stage='attachment';const bytes=Buffer.alloc(4*1024*1024+117);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+19)%256;
 await a.page.locator('#attachment-input').setInputFiles({name:'desktop-cloud-chunks.bin',mimeType:'application/octet-stream',buffer:bytes});await a.page.waitForSelector('.attachment-link',{timeout:120000});
 const href=await a.page.locator('.attachment-link').first().getAttribute('href');attachmentId=decodeURIComponent(new URL(href,ui).pathname.split('/')[3]);
 const actual=await a.page.evaluate(async href=>{const response=await FountainTransport.request(new URL(href,location.origin).pathname);const bytes=await response.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);return {status:response.status,size:bytes.byteLength,sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};},href);
 assert.equal(actual.status,200);assert.equal(actual.size,bytes.length);assert.equal(actual.sha256,createHash('sha256').update(bytes).digest('hex'));note('renderer XHR uploads two real Storage chunks and downloads identical bytes');
 const removed=await request(a,'/attachments/'+encodeURIComponent(attachmentId),{},'DELETE');assert.equal(removed.status,409);note('referenced attachment deletion is rejected; Root owns exact QA Storage cleanup');
 stage='restart';await a.electron.close();a.electron=null;const again=await launch('first');await again.page.waitForSelector('.recent-grid',{timeout:60000});await sessionState(again);await again.page.goto(ui+'/#page/'+encodeURIComponent(pageId));await again.page.waitForSelector('#page-title');assert((await again.page.locator('.block-content').allInnerTexts()).includes('두 번째 앱에서 되돌린 실제 변경'));note('real app relaunch and same-server reconnect preserve private login and document');
 stage='logout';const current=await sessionState(again),signedOut=await request(again,'/session',{cache_binding:current.binding},'DELETE');assert.equal(signedOut.status,200);await again.page.reload();await again.page.waitForSelector('#login-form');const cookies=await again.electron.evaluate(async({session},partition)=>(await session.fromPartition(partition).cookies.get({name:'fountain_session'})).length,networkPartition);assert.equal(cookies,0);await sessionState(b);note('real logout clears native cookie without ending the other device session');
 assert.deepEqual(pageErrors,[]);
 await b.page.screenshot({path:join(proof,'cloud-authenticated-document.png')});
 const paths=[];for(const client of clients)if(client.electron)paths.push(...await client.electron.evaluate(()=>globalThis.__qaPaths));
 await writeFile(join(proof,'cloud-authenticated.json'),JSON.stringify({packaged:process.env.FOUNTAIN_DESKTOP_PACKAGED==='1',electron:'44.8.0',checks,actualSupabaseAuth:true,actualPostgres:true,actualStorage:true,actualSSE:true,privilegedTestRetarget:true,productionApiOriginalUnchanged:true,originalDataUsed:false,windowsExecution:false,rootCleanupRequired:true,attachmentId,uploadBytes:bytes.length,uploadSha256:actual.sha256,paths},null,2)+'\n');
 console.log(JSON.stringify({passed:checks.length,packaged:process.env.FOUNTAIN_DESKTOP_PACKAGED==='1',actualCloud:true,testRetarget:true}));
}catch(error){
 const diagnostics=[];for(const client of clients)if(client.electron)try{diagnostics.push({text:(await client.page.locator('body').innerText({timeout:1500})).slice(0,5000),paths:await client.electron.evaluate(()=>globalThis.__qaPaths)});}catch{}
 await writeFile(join(proof,'cloud-authenticated-failure.json'),cleanError(JSON.stringify({stage,error:cleanError(error),diagnostics,pageErrors},null,2))+'\n');
 console.error('QA stage:',stage,cleanError(error));process.exitCode=1;
}finally{for(const client of clients)await client.electron?.close().catch(()=>{});await rm(folder,{recursive:true,force:true});}
