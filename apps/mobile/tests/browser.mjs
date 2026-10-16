/** Real HTTP + Chrome exercise the bundled UI through a mock native bridge (not a device/TLS test). */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from '../scripts/build.mjs';
import {waitForAsync} from '../../../tests/async-browser.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const C=require('../../../static/collaboration.js');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),temporary=await mkdtemp(join(tmpdir(),'fountain-mobile-browser-')),output=join(temporary,'www');
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let processServer,staticServer,browser,backend,local,configuredOrigin=null,generation=1;
const jar=new Map(),active=new Map(),calls=[],exports=[],pageErrors=[];
const remote='https://family.native.test',otherRemote='https://other.native.test';
async function startBackend(){
  const environment={...process.env};delete environment.FOUNTAIN_ACCESS_TOKEN;
  processServer=spawn(python,['-m','fountain.server','--port','0','--data',join(temporary,'workspace.db')],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Mobile fixture server startup timed out')),15000);const receive=chunk=>{output+=chunk.toString();const match=output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};processServer.stdout.on('data',receive);processServer.stderr.on('data',receive);processServer.once('error',reject);processServer.once('exit',code=>{clearTimeout(timer);reject(new Error('Mobile fixture server exited: '+code));});});
}
async function backendRequest(path,body,method='GET',cookie=jar.get(configuredOrigin)){
  const response=await fetch(backend+'/api'+path,{method,headers:{'X-Fountain-Request':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,'Fixture API '+path+' '+response.status);return response.json();
}
async function until(predicate){const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw new Error('Native fixture condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
async function bridgeCall(method,args={}){
  if(method==='getConfiguration')return{origin:configuredOrigin,generation};
  if(method==='configure'){assert.ok(!jar.get(configuredOrigin),'Fixture refuses origin change before logout');configuredOrigin=args.origin;generation++;return{origin:configuredOrigin,generation};}
  if(method==='cancel'){active.get(args.id)?.abort();return{cancelled:true};}
  assert.equal(args.generation,generation);
  calls.push({method,path:args.path,bodyBytes:args.bodyBase64?Buffer.from(args.bodyBase64,'base64').length:0,headers:Object.keys(args.headers||{})});
  if(method==='saveData'){exports.push({filename:args.filename,bytes:Buffer.from(args.bodyBase64,'base64'),kind:'data'});return{saved:true,generation};}
  const abort=new AbortController();active.set(args.id,abort);
  try{
    const fixture=args.path.startsWith('/api/native-fixture/'),url=fixture?local+args.path:backend+args.path;
    const headers={...args.headers,'X-Fountain-Request':'1'},cookie=jar.get(configuredOrigin);if(cookie)headers.Cookie=cookie;
    if(args.path==='/api/session'&&args.method==='DELETE')jar.delete(configuredOrigin);
    const response=await fetch(url,{method:method==='download'?'GET':args.method,headers,redirect:'error',signal:abort.signal,...(args.bodyBase64?{body:Buffer.from(args.bodyBase64,'base64')}:{})});
    if(method==='download'){assert.ok(response.ok,'Native fixture export response');exports.push({filename:args.filename,bytes:Buffer.from(await response.arrayBuffer()),kind:'download',path:args.path});return{saved:true,generation};}
    const setCookie=response.headers.get('set-cookie');if(setCookie&&args.path==='/api/session'&&args.method==='POST'){const cookie=setCookie.match(/(?:^|,\s*)(fountain_session=[^;]+)/)?.[1];if(cookie)jar.set(configuredOrigin,cookie);}
    const safe={};for(const [key,val] of response.headers)if(['content-type','content-length','content-range','accept-ranges','etag','content-disposition'].includes(key))safe[key]=val;
    return{status:response.status,headers:safe,bodyBase64:Buffer.from(await response.arrayBuffer()).toString('base64'),generation};
  }finally{active.delete(args.id);}
}
try{
  backend=await startBackend();await build(output);
  const accounts=await backendRequest('/accounts'),owner=accounts.accounts.find(member=>member.role==='owner'),password='Native-bridge-isolated-2026';
  await backendRequest('/accounts',{member_id:owner.id,password},'POST');await backendRequest('/accounts/enable',{},'POST');
  staticServer=createServer(async(req,res)=>{
    const binarySize={'/api/native-fixture/binary4':4*1024*1024,'/api/native-fixture/binary16':16*1024*1024}[req.url];
    if(binarySize){const body=Buffer.alloc(binarySize);for(let index=0;index<binarySize;index++)body[index]=index%251;res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':binarySize});res.end(body);return;}
    if(req.url==='/api/native-fixture/redirect'){res.writeHead(302,{Location:'https://blocked.invalid/'});res.end();return;}
    if(req.url==='/api/native-fixture/slow'){const timer=setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"late":true}');},1500);res.on('close',()=>clearTimeout(timer));return;}
    try{const path=new URL(req.url,'http://localhost').pathname,name=path==='/'?'index.html':path.slice(1);if(!/^[a-z][a-z0-9.-]*\.(?:html|js|css)$/.test(name)){res.writeHead(404);res.end();return;}const bytes=await readFile(join(output,name));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}
  });await new Promise(resolve=>staticServer.listen(0,'127.0.0.1',resolve));local='http://127.0.0.1:'+staticServer.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();await context.exposeBinding('nativeFixtureCall',(_,method,args)=>bridgeCall(method,args));
  await context.addInitScript(()=>{window.CapacitorCustomPlatform={name:'mock-native'};window.Capacitor={PluginHeaders:[{name:'FountainNative',methods:['getConfiguration','configure','request','cancel','download','saveData'].map(name=>({name,rtype:'promise'}))}],nativePromise:(_,method,args)=>{const code=method==='request'?localStorage.getItem('native-fixture-error'):null;return code?Promise.reject(Object.assign(new Error('native fixture failure'),{code})):window.nativeFixtureCall(method,args);}};});
  const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(local);await page.waitForSelector('#native-configuration-form');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/fountain-native-configuration-mobile.png',fullPage:true,animations:'disabled'});
  assert.equal(await page.evaluate(()=>typeof state),'undefined','app does not boot before native server configuration');
  await page.locator('#native-configuration-form input').fill('http://untrusted.example');await page.locator('#native-configuration-form button').click();await page.waitForFunction(()=>document.querySelector('#native-configuration-form [role="status"]').textContent.length>0);assert.equal(configuredOrigin,null);
  await page.locator('#native-configuration-form input').fill(remote);await page.locator('#native-configuration-form button').click();await page.waitForSelector('#login-form');assert.equal(await page.evaluate(()=>FountainTransport.origin),remote);
  await page.locator('#login-form [name="email"]').fill(owner.email);await page.locator('#login-form [name="password"]').fill(password);await page.locator('#login-form .solid-btn').click();await page.waitForSelector('.recent-grid');
  assert.ok(jar.get(remote),'native fixture owns the server cookie');assert.equal(await page.evaluate(()=>document.cookie),'');assert.equal((await context.cookies()).length,0);
  await waitForAsync(page,async()=>!!await FountainOffline.getProfile());const profile=await page.evaluate(async()=>{const profile=await FountainOffline.getProfile();return{id:profile.id,origin:profile.origin};});assert.ok(profile.id.startsWith(remote+'|'));assert.equal(profile.origin,remote);
  assert.equal(await page.evaluate(async()=>navigator.serviceWorker?(await navigator.serviceWorker.getRegistrations()).length:0),0,'native bundle does not register a service worker');
  for(const size of [4*1024*1024,16*1024*1024]){
    const expected=Buffer.alloc(size);for(let index=0;index<size;index++)expected[index]=index%251;
    const result=await page.evaluate(async size=>{const response=await FountainTransport.request('/api/native-fixture/binary'+(size/1024/1024)),body=await response.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',body);return{size:body.byteLength,digest:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')};},size);
    assert.equal(result.size,size);assert.equal(result.digest,createHash('sha256').update(expected).digest('hex'),'native '+size+' byte response matches the actual HTTP fixture byte-for-byte');
  }
  const record=await page.evaluate(()=>api('/pages',{title:'네이티브 번들 문서',blocks:[{id:'native-text',type:'paragraph',text:'모바일'}]}));await page.evaluate(id=>navigate('page',id),record.id);await page.waitForSelector('.block[data-id="native-text"] .block-content[contenteditable="true"]');
  await page.locator('.block-content').click();await page.keyboard.press('End');await page.keyboard.insertText(' 앱🙂');await waitForAsync(page,()=>state.channel.pending.size===0&&state.channel.status==='synced');assert.equal((await backendRequest('/pages/'+record.id)).blocks[0].text,'모바일 앱🙂');
  const snapshot=await backendRequest('/pages/'+record.id+'/collaboration'),chars=C.visibleChars(snapshot.state,'native-text'),clock=snapshot.state.max_clock+1;
  await backendRequest('/pages/'+record.id+'/operations',{epoch:snapshot.epoch,ops:[{id:'native_remote:'+clock,client:'native_remote',clock,type:'text.insert',block_id:'native-text',after_id:chars.at(-1).id,text:' 원격'}]},'POST');await page.waitForFunction(()=>document.querySelector('.block-content').innerText.includes('원격'));
  assert.ok(calls.some(call=>call.path==='/api/pages/'+record.id+'/presence'),'native event facade polls authorized presence');
  const fixture=Buffer.alloc(4*1024*1024+113);for(let index=0;index<fixture.length;index++)fixture[index]=index%251;
  await page.locator('#attachment-input').setInputFiles({name:'native-chunks.bin',mimeType:'application/octet-stream',buffer:fixture});await page.waitForSelector('[data-upload-state="done"]',{timeout:30000});
  const chunks=calls.filter(call=>call.method==='request'&&/\/chunks\?offset=/.test(call.path));assert.deepEqual(chunks.map(call=>call.bodyBytes),[4*1024*1024,113]);assert.ok(await page.evaluate(()=>state.uploadManager.scopeId.startsWith(FountainTransport.origin+'|')));
  const href=await page.locator('.attachment-link').getAttribute('href');assert.ok(href.startsWith(local+'/#fountain-download/'));await page.locator('.attachment-link').click();await until(()=>exports.some(item=>item.filename==='native-chunks.bin'));assert.deepEqual(exports.find(item=>item.filename==='native-chunks.bin').bytes,fixture);
  await page.evaluate(()=>doAction({dataset:{action:'backup'}}));await until(()=>exports.some(item=>item.filename==='fountain-backup.sqlite'));assert.equal(exports.find(item=>item.filename==='fountain-backup.sqlite').bytes.subarray(0,16).toString(),'SQLite format 3\0');
  await page.evaluate(()=>download('native-export.json',JSON.stringify({문서:'가족'}),'application/json'));await until(()=>exports.some(item=>item.filename==='native-export.json'));assert.equal(exports.find(item=>item.filename==='native-export.json').bytes.toString(),JSON.stringify({문서:'가족'}));
  // Model the Error+code shape emitted by real Capacitor, rather than fetch's TypeError.
  await page.evaluate(async()=>{await state.channel.persistence;localStorage.setItem('native-fixture-error','NETWORK_ERROR');});await page.reload();
  await waitForAsync(page,()=>typeof state!=='undefined'&&state.loaded&&state.offline);await page.waitForSelector('.block[data-id="native-text"] .block-content[contenteditable="true"]');
  await page.locator('.block[data-id="native-text"] .block-content').fill('모바일 앱🙂 원격 · 오프라인 편집');await waitForAsync(page,()=>state.channel.pending.size>0);await page.evaluate(()=>state.channel.persistence);
  await page.evaluate(()=>localStorage.removeItem('native-fixture-error'));await page.reload();await waitForAsync(page,()=>typeof state!=='undefined'&&state.loaded&&!state.offline&&state.channel?.pending.size===0&&state.channel?.status==='synced');assert.ok((await backendRequest('/pages/'+record.id)).blocks[0].text.includes('오프라인 편집'));
  await page.evaluate(()=>localStorage.setItem('native-fixture-error','NATIVE_STORAGE'));await page.reload();await page.waitForSelector('#main .empty h2');assert.equal(await page.evaluate(()=>state.loaded),false,'secure storage failure must not open an existing offline profile');assert.equal(await page.locator('.block-content').count(),0);
  await page.evaluate(()=>localStorage.removeItem('native-fixture-error'));await page.reload();await waitForAsync(page,()=>typeof state!=='undefined'&&state.loaded&&state.channel?.status==='synced');
  const unsafe=['https://blocked.invalid/api/session','//blocked.invalid/api/session','/api/%252e%252e/session','/api/session#x'];assert.equal(await page.evaluate(paths=>paths.every(path=>{try{FountainTransport.request(path);return false;}catch{return true;}}),unsafe),true);
  assert.equal(await page.evaluate(async()=>{try{await FountainTransport.request('/api/native-fixture/redirect');return false;}catch{return true;}}),true,'real HTTP redirect is rejected');
  await page.evaluate(()=>{window.lateNativeResult=FountainTransport.request('/api/native-fixture/slow').then(()=>false,error=>error.name);});await until(()=>calls.some(call=>call.path==='/api/native-fixture/slow'));
  const privateCookie=jar.get(remote),storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert.ok(!storage.includes(privateCookie));assert.ok(!storage.includes(password));
  await page.screenshot({path:'/tmp/fountain-native-workspace-mobile.png',fullPage:true,animations:'disabled'});await page.evaluate(()=>doAction({dataset:{action:'logout'}}));await page.waitForSelector('#login-form');assert.equal(await page.evaluate(()=>window.lateNativeResult),'AbortError');await waitForAsync(page,async()=>await FountainOffline.getProfile()===null);assert.equal(jar.get(remote),undefined);
  await page.evaluate(origin=>FountainTransport.configure({origin}),otherRemote);await page.reload();await page.waitForSelector('#login-form');assert.equal(await page.evaluate(()=>FountainTransport.origin),otherRemote);await page.locator('#login-form [name="email"]').fill(owner.email);await page.locator('#login-form [name="password"]').fill(password);await page.locator('#login-form .solid-btn').click();await waitForAsync(page,()=>state.loaded&&state.session.authenticated);await waitForAsync(page,async()=>!!await FountainOffline.getProfile());assert.ok((await page.evaluate(async()=>(await FountainOffline.getProfile()).id)).startsWith(otherRemote+'|'));
  assert.deepEqual(pageErrors,[]);console.log('PASS Chrome mock native bridge + real HTTP: HTTPS bootstrap, private-cookie login, exact 4MiB/16MiB responses, document/presence polling, 4MiB+113 chunk upload, exact download/backup/export, URL/redirect fences, native-shaped offline reload/replay versus storage failure, logout cancellation and backend-scoped cache');
}finally{for(const controller of active.values())controller.abort();await browser?.close();if(staticServer)await new Promise(resolve=>staticServer.close(resolve));if(processServer){processServer.kill('SIGTERM');await new Promise(resolve=>processServer.exitCode!==null?resolve():processServer.once('exit',resolve));}await rm(temporary,{recursive:true,force:true});}
