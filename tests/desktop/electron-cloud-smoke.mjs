/** Actual bundled Electron + anonymous Supabase only; no real account or writes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,rm,realpath,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.env.FOUNTAIN_DESKTOP_CLOUD_LIVE!=='1')throw Error('Set FOUNTAIN_DESKTOP_CLOUD_LIVE=1 for anonymous requests to the configured Fountain project.');
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../..',import.meta.url));
const {_electron}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const desktop=join(root,'apps/desktop'),executable=process.env.FOUNTAIN_ELECTRON||require(join(desktop,'node_modules/electron'));
const server='https://ehnovtfadpkwtubmwltl.supabase.co/',ui='https://fountain.desktop.invalid';
const networkPartition=require(join(desktop,'src/cloud.cjs')).cloudPartitions(server).network;
const folder=await realpath(await mkdtemp(join(tmpdir(),'fountain-desktop-cloud-'))),proof=join(root,'.data/desktop-proof');
await mkdir(proof,{recursive:true});let electron;
const observed=[],pageErrors=[];
async function launch(){
 const env={...process.env,FOUNTAIN_DESKTOP_USER_DATA:join(folder,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 electron=await _electron.launch({executablePath:executable,args:process.env.FOUNTAIN_DESKTOP_PACKAGED==='1'?[]:[desktop],env,timeout:30000});
 electron.on('window',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
 for(const page of electron.windows())page.on('pageerror',error=>pageErrors.push(error.message));
 await electron.evaluate(({session,dialog},partition)=>{
  const network=session.fromPartition(partition);
  globalThis.__cloudObserved=[];
  network.webRequest.onCompleted({urls:['<all_urls>']},details=>{
   const url=new URL(details.url);globalThis.__cloudObserved.push({path:url.pathname,status:details.statusCode});
  });
  dialog.showMessageBoxSync=()=>1;
 },networkPartition);
}
async function uiPage(){
 for(let n=0;n<200;n++){
  const page=electron.windows().find(value=>value.url().startsWith(ui+'/'));
  if(page)return page;await new Promise(done=>setTimeout(done,50));
 }
 throw Error('Bundled desktop window did not open');
}
async function check(page,round){
 page.setDefaultTimeout(20000);await page.waitForSelector('#login-form [name=email]');
 assert.equal(new URL(page.url()).origin,ui);
 assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process,typeof window.fountainSetup]),['undefined','undefined','undefined']);
 const actual=await page.evaluate(async()=>{
  const response=await FountainTransport.request('/api/session'),value=await response.json();
  return {status:response.status,anonymous:value.authenticated===false,required:value.required===true,identityNull:value.identity===null,workspaceNull:value.workspace_id===null,bindingNull:value.cache_binding===null,
   cookieHeadersExposed:response.headers.has('Set-Cookie'),scriptCookie:document.cookie,secure:isSecureContext,
   sameOrigin:FountainTransport.apiURL('/api/session')===location.origin+'/api/session',shareURL:FountainTransport.shareURL('page/example'),localNavigation:FountainTransport.appURL('page/example')===location.origin+'/#page/example'};
 });
 assert.equal(actual.status,200);for(const key of ['anonymous','required','identityNull','workspaceNull','bindingNull','secure','sameOrigin','localNavigation'])assert.equal(actual[key],true,key);
 assert.equal(actual.cookieHeadersExposed,false);assert.equal(actual.scriptCookie,'');assert.equal(actual.shareURL,null);
 const worker=await page.evaluate(async()=>!!(await FountainOffline.serviceWorkerReady));assert.equal(worker,true);
 const prefs=await electron.evaluate(({BrowserWindow},prefix)=>{
  const window=BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().startsWith(prefix));
  const p=window.webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity,preload:p.preload||null};
 },ui);
 assert.deepEqual(prefs,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,preload:null});
 const outsideDenied=await page.evaluate(async()=>{try{await fetch('https://outside.invalid/');return false;}catch{return true;}});assert.equal(outsideDenied,true);
 const cookieCount=await electron.evaluate(async({session},partition)=>{
  return (await session.fromPartition(partition).cookies.get({name:'fountain_session'})).length;
 },networkPartition);assert.equal(cookieCount,0);
 const requests=await electron.evaluate(()=>globalThis.__cloudObserved);
 assert(requests.some(value=>value.path==='/functions/v1/fountain-api/api/session'&&value.status===200));
 assert(requests.every(value=>value.path.startsWith('/functions/v1/fountain-api/')));
 await page.screenshot({path:join(proof,'cloud-anonymous-'+round+'.png')});
 observed.push({round,actualAnonymousSupabase:true,bundledUIOrigin:true,workerReady:worker,workspacePreload:false,rendererNode:false,privateNetworkAuthCookies:cookieCount,publicShareAddress:null,requests});
}
try{
 if(process.env.FOUNTAIN_DESKTOP_PACKAGED!=='1')await (await import('../../apps/desktop/build.mjs')).build();
 await launch();const setup=await electron.firstWindow();await setup.waitForSelector('#server-form');
 await setup.locator('#server').fill(server);await setup.locator('button[type=submit]').click();
 await check(await uiPage(),1);
 const config=JSON.parse(await readFile(join(folder,'profile/server.json'),'utf8'));assert.deepEqual(config,{version:1,server});
 await electron.close();electron=null;await launch();await check(await uiPage(),2);
 assert.deepEqual(pageErrors,[]);
 const result={actualElectron:true,packaged:process.env.FOUNTAIN_DESKTOP_PACKAGED==='1',observed,sourceBootAndRestart:true,anonymousOnly:true,loginOrEditingVerified:false,remoteAuthUsersCreated:0,cloudWrites:0};
 const output=join(proof,process.env.FOUNTAIN_DESKTOP_PACKAGED==='1'?'cloud-packaged-anonymous.json':'cloud-source-anonymous.json');
 await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({rounds:observed.length,anonymousOnly:true,packaged:result.packaged}));
}catch(error){
 if(electron){
  const pages=[];
  for(const page of electron.windows())try{
   const paths=page.url().startsWith(ui+'/')?await page.evaluate(async()=>{
    const values=[];for(const path of ['/','/#home']){const r=await fetch(path,{signal:AbortSignal.timeout(2000)});values.push({path,status:r.status});await r.body?.cancel();}return values;
   }).catch(()=>[]):[];
   pages.push({url:page.url(),paths,text:(await page.locator('body').innerText({timeout:1000})).slice(0,5000)});
  }catch{}
  const network=await electron.evaluate(()=>globalThis.__cloudObserved||[]).catch(()=>[]);
  await writeFile(join(proof,'cloud-anonymous-failure.json'),JSON.stringify({pages,pageErrors,network},null,2)+'\n');
 }
 throw error;
}finally{await electron?.close();await rm(folder,{recursive:true,force:true});}
