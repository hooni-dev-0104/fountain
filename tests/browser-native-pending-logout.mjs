/** Production app + native transport, real Chrome/IDB and disposable account HTTP.
 * Native cookie storage/TLS/admission are modeled; this is not an SDK test. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForAsync} from './async-browser.mjs';
const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const temporary=await mkdtemp(join(tmpdir(),'fountain-pending-logout-')),configured='https://family.example',password='Disposable-marker-fixture-passphrase-2026',markerKey='fountain-logout-pending:'+encodeURIComponent(configured);
let server,browser,origin,cookie='',deletes=0,networkDown=false,corruptSession=false,holdSession=false,releaseSession,sessionHeld=false;const deleteStatuses=[];
async function actual(path,body,method){const response=await fetch(origin+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Fountain-Request':'1',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});for(const value of response.headers.getSetCookie())if(value.startsWith('fountain_session='))cookie=value.split(';')[0];return response;}
try{
  const env={...process.env};delete env.FOUNTAIN_ACCESS_TOKEN;delete env.FOUNTAIN_DATABASE_URL;
  server=spawn(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),['-m','fountain.server','--port','0','--database','sqlite','--data',join(temporary,'fixture.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
  origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),15000),accept=chunk=>{output+=chunk;const match=output.match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',accept);server.stderr.on('data',accept);server.once('error',reject);});
  const owner=(await (await actual('/accounts')).json()).accounts.find(row=>row.role==='owner');assert.ok((await actual('/accounts',{member_id:owner.id,password})).ok);assert.ok((await actual('/accounts/enable',{})).ok);
  const login=async()=>{const response=await actual('/session',{email:owner.email,password});assert.equal(response.status,200);return response.json();};
  const first=await login(),replacement=await login();assert.notEqual(first.cache_binding,replacement.cache_binding);
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({serviceWorkers:'block'}),web=await context.newPage(),errors=[];web.on('pageerror',error=>errors.push(error.message));
  await context.exposeBinding('privateWireModel',async(_,method,args)=>{
    if(method==='getConfiguration')return{origin:configured,generation:1,outboxEnabled:false};if(method==='cancel')return{cancelled:true};
    assert.equal(method,'request');if(networkDown)throw Object.assign(Error('Modeled native network unavailable'),{code:'NATIVE_NETWORK'});
    if(args.path==='/api/session'&&args.method==='DELETE')deletes++;
    const body=args.method==='GET'?undefined:JSON.parse(Buffer.from(args.bodyBase64,'base64').toString()||'{}'),response=await actual(args.path.slice(4),body,args.method);let bytes=Buffer.from(await response.arrayBuffer());
    if(args.path==='/api/session'&&args.method==='DELETE')deleteStatuses.push(response.status);
    // Explicit operator fault around the real response; not a business fixture.
    if(corruptSession&&args.path==='/api/session'&&args.method==='GET')bytes=Buffer.from(JSON.stringify(corruptSession===true?{}:corruptSession));
    if(holdSession&&args.path==='/api/session'&&args.method==='GET'){holdSession=false;sessionHeld=true;await new Promise(resolve=>releaseSession=resolve);}
    return{generation:1,status:response.status,headers:{'Content-Type':response.headers.get('content-type')||'application/json','Set-Cookie':'not-renderer-visible'},bodyBase64:bytes.toString('base64')};
  });
  const transport=await readFile(new URL('../apps/mobile/web/native-transport.js',import.meta.url),'utf8'),offline=await readFile(new URL('../static/offline.js',import.meta.url),'utf8'),app=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
  await web.route('**/transport.js',route=>route.fulfill({contentType:'application/javascript',body:transport+`\nwindow.nativeBridge=Object.fromEntries(['getConfiguration','request','cancel'].map(method=>[method,args=>privateWireModel(method,args)]));window.FountainTransport=FountainNativeTransport.create(nativeBridge);window.nativeBoot=FountainTransport.initialize();`}));
  await web.route('**/offline.js',route=>route.fulfill({contentType:'application/javascript',body:`window.offlineBoot=nativeBoot.then(()=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/qa-marker-offline.js';script.onload=resolve;script.onerror=reject;document.body.append(script);}));`}));
  await web.route('**/qa-marker-offline.js',route=>route.fulfill({contentType:'application/javascript',body:offline}));
  assert.match(app,/\nboot\(\);\s*$/);const observedApp=app.replace(/\nboot\(\);\s*$/,'\nwindow.markerBootResult=boot().finally(()=>window.markerBootSettled=true);\n');
  await web.route('**/app.js',route=>route.fulfill({contentType:'application/javascript',body:`(async()=>{await nativeBoot;await offlineBoot;const script=document.createElement('script');script.src='/qa-marker-app.js';document.body.append(script);})()`}));await web.route('**/qa-marker-app.js',route=>route.fulfill({contentType:'application/javascript',body:observedApp}));
  await web.goto(origin);await waitForAsync(web,()=>typeof state!=='undefined'&&state.loaded);
  const seed=async binding=>web.evaluate(({key,binding})=>{const value=JSON.stringify({mode:'accounts',binding,nonce:'fixture-intent'});localStorage.setItem(key,value);return value;},{key:markerKey,binding});
  await seed(first.cache_binding);const before=deletes;await web.reload();await waitForAsync(web,()=>typeof state!=='undefined'&&(state.loaded||!!document.querySelector('#login-form')));
  assert.equal(deletes,before,'an old marker must never dispatch DELETE against a replacement private HTTP session');assert.equal((await (await actual('/session')).json()).cache_binding,replacement.cache_binding);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),null);
  // A marker for the actual current session still performs a real bound DELETE.
  await seed(replacement.cache_binding);await web.reload();await waitForAsync(web,()=>!!document.querySelector('#login-form'));assert.equal(deletes,before+1);assert.equal((await (await actual('/session')).json()).authenticated,false);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),null);
  await seed(replacement.cache_binding);await web.reload();await waitForAsync(web,()=>window.markerBootSettled===true);assert.equal(deletes,before+1,'an actual anonymous session needs no redundant DELETE');assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),null);
  const offlineSession=await login();await web.reload();await waitForAsync(web,()=>typeof state!=='undefined'&&state.loaded);const offlineMarker=await seed(offlineSession.cache_binding),offlineBefore=deletes;networkDown=true;await web.reload();await waitForAsync(web,()=>!!document.querySelector('#login-form'));assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),offlineMarker);assert.equal(deletes,offlineBefore);networkDown=false;assert.equal((await (await actual('/session')).json()).cache_binding,offlineSession.cache_binding);
  corruptSession=true;await web.reload();await waitForAsync(web,()=>window.markerBootSettled===true);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),offlineMarker,'an unknown real-response shape never clears pending intent');assert.equal(deletes,offlineBefore);corruptSession=false;
  for(const invalidAnonymous of [{authenticated:false,required:true,cache_binding:'still-bound-invalid',member:{id:'invalid'}},{authenticated:false,required:'true',cache_binding:null,member:null,identity:null,expires_at:null},{authenticated:false,required:true,mode:'unknown'}]){
    corruptSession=invalidAnonymous;await web.reload();await waitForAsync(web,()=>window.markerBootSettled===true);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),offlineMarker,'contradictory or malformed anonymous metadata cannot clear pending intent');assert.equal(deletes,offlineBefore);corruptSession=false;assert.equal((await (await actual('/session')).json()).cache_binding,offlineSession.cache_binding);
  }
  // A delayed real session observation cannot clear or act on an old marker
  // after a new boot has superseded the request's UI generation.
  const raceMarker=await seed(offlineSession.cache_binding);holdSession=true;sessionHeld=false;await web.reload();const deadline=Date.now()+15000;while(!sessionHeld){assert.ok(Date.now()<deadline,'The real session observation must reach the bounded hold');await new Promise(resolve=>setTimeout(resolve,10));}
  await web.evaluate(()=>{state.bootGeneration++;});releaseSession();await waitForAsync(web,()=>window.markerBootSettled===true);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),raceMarker);assert.equal(deletes,offlineBefore);
  await seed(first.cache_binding);holdSession=true;sessionHeld=false;await web.reload();const casDeadline=Date.now()+15000;while(!sessionHeld){assert.ok(Date.now()<casDeadline);await new Promise(resolve=>setTimeout(resolve,10));}const changedMarker=await seed(offlineSession.cache_binding);releaseSession();await waitForAsync(web,()=>window.markerBootSettled===true);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),changedMarker,'a late observation clears only its exact original marker');assert.equal(deletes,offlineBefore);assert.equal((await (await actual('/session')).json()).cache_binding,offlineSession.cache_binding);
  // A replacement after preflight is still protected by the actual server's
  // original-binding 409. Native pre-effect admission is separate SDK coverage.
  holdSession=true;sessionHeld=false;await web.reload();const conflictDeadline=Date.now()+15000;while(!sessionHeld){assert.ok(Date.now()<conflictDeadline);await new Promise(resolve=>setTimeout(resolve,10));}const lastSession=await login();releaseSession();await waitForAsync(web,()=>window.markerBootSettled===true);assert.deepEqual(deleteStatuses,[200,409]);assert.equal((await (await actual('/session')).json()).cache_binding,lastSession.cache_binding);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),null);assert.equal(await web.evaluate(()=>state.loaded),true);
  // Cancel/replace the destructive matching-session intent while its real GET
  // is in flight. The old boot must finish without dispatching any DELETE.
  for(const cancel of ['replace','remove']){
    await seed(lastSession.cache_binding);holdSession=true;sessionHeld=false;await web.reload();const cancelDeadline=Date.now()+15000;while(!sessionHeld){assert.ok(Date.now()<cancelDeadline);await new Promise(resolve=>setTimeout(resolve,10));}
    const retainedMarker=cancel==='replace'?await seed(first.cache_binding):await web.evaluate(key=>{localStorage.removeItem(key);return null;},markerKey),deleteCount=deletes;
    releaseSession();await waitForAsync(web,()=>window.markerBootSettled===true);
    assert.equal(deletes,deleteCount,'a '+cancel+'d matching-session logout intent never dispatches DELETE');assert.equal((await (await actual('/session')).json()).cache_binding,lastSession.cache_binding);assert.equal(await web.evaluate(key=>localStorage.getItem(key),markerKey),retainedMarker);
  }
  assert.deepEqual(errors,[]);console.log('PASS production native transport/app pending logout: actual HTTP replacement session survives old marker with zero DELETE, current marker logs out, offline intent retained, stale session observation fenced; native TLS/vault/admission MODEL only');
}finally{releaseSession?.();await browser?.close();if(server&&server.exitCode===null){const done=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGINT');await done;}await rm(temporary,{recursive:true,force:true});}
