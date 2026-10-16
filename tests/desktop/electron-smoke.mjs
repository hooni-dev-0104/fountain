/** Actual Electron, disposable SQLite servers and profiles; no user workspace. */
import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,stat,realpath} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {_electron,chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=fileURLToPath(new URL('../..',import.meta.url));
const desktop=join(root,'apps','desktop');
const electronPath=process.env.FOUNTAIN_ELECTRON||require(join(desktop,'node_modules','electron'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const temporary=await realpath(await mkdtemp(join(tmpdir(),'fountain-electron-')));
const proof=join(root,'.data','desktop-proof');await mkdir(proof,{recursive:true});
const token='desktop-fixture-token-for-tests-only';const servers=[];
let electron;const electronLog=[];
async function startServer(name,port=0){
 const env={HOME:homedir(),PATH:process.env.PATH,LANG:'en_US.UTF-8',FOUNTAIN_ACCESS_TOKEN:token};
 const child=spawn(python,['-m','fountain.server','--port',String(port),'--data',join(temporary,name+'.db')],{cwd:root,env,stdio:['ignore','pipe','pipe']});servers.push(child);
 const origin=await new Promise((yes,no)=>{
  let output='';const timeout=setTimeout(()=>no(new Error('Server timeout '+output)),15000);
  const read=chunk=>{output+=chunk;const match=output.match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timeout);yes('http://127.0.0.1:'+match[1]);}};
  child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',error=>{clearTimeout(timeout);no(error);});
  child.once('exit',code=>{if(!originResolved(output)){clearTimeout(timeout);no(new Error('Server exit '+code+' '+output));}});
 });return {child,origin};
}
function originResolved(value){return /http:\/\/localhost:\d+/.test(value);}
async function stopServer(child){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(yes=>child.once('exit',yes));child.kill('SIGTERM');await done;}
async function launch(){
 const env={...process.env,FOUNTAIN_DESKTOP_USER_DATA:join(temporary,'userdata')};delete env.ELECTRON_RUN_AS_NODE;
 electron=await _electron.launch({executablePath:electronPath,args:process.env.FOUNTAIN_DESKTOP_PACKAGED==='1'?[]:[process.env.FOUNTAIN_DESKTOP_APP||desktop],env,timeout:30000});
 electron.process().stderr.on('data',chunk=>electronLog.push(chunk.toString()));
 const watch=page=>{page.on('console',message=>{if(message.type()==='error')electronLog.push('renderer: '+message.text());});page.on('dialog',value=>{electronLog.push('dialog: '+value.message());value.dismiss().catch(error=>electronLog.push('dismiss: '+error.message));});};
 electron.windows().forEach(watch);electron.on('window',watch);
 await electron.evaluate(({dialog})=>{globalThis.__desktopLeavePromptCount=0;dialog.showMessageBoxSync=()=>{globalThis.__desktopLeavePromptCount++;return 1;};});
}
async function pageFor(prefix){
 for(let attempt=0;attempt<100;attempt++){const page=electron.windows().find(value=>value.url().startsWith(prefix));if(page)return page;await new Promise(yes=>setTimeout(yes,50));}
 throw new Error('Window not found '+prefix);
}
async function settings(){
 await electron.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('server-settings').click());
 return pageFor('file:');
}
async function connect(page,origin){await page.locator('#server').fill(origin);await page.locator('button[type=submit]').click();return pageFor(origin);}
async function login(page){
 await page.waitForLoadState('load');await page.waitForTimeout(100);
 await page.locator('#login-form input').fill(token);
 const response=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/api/session');
 await page.locator('#login-form button').click();const result=await response;
 assert.ok(result.ok(),'Fixture login status '+result.status()+'; exact token '+(result.request().postDataJSON().token===token));
 await page.waitForSelector('.recent-grid');
}
const checks=[];checks.push=(...values)=>{console.log('check',...values);return Array.prototype.push.apply(checks,values);};
try{
 const first=await startServer('first');console.log('fixture ready',first.origin);await launch();console.log('electron launched');
 let setup=await electron.firstWindow();await setup.waitForSelector('#server-form');
 await setup.screenshot({path:join(proof,'setup.png')});
 assert.equal(await setup.evaluate(()=>typeof require),'undefined');
 let page=await connect(setup,first.origin);console.log('connected',page.url());await login(page);console.log('logged in');checks.push('actual setup, URL selection and family login');
 assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process,typeof window.fountainSetup]),['undefined','undefined','undefined']);
 const prefs=await electron.evaluate(({BrowserWindow})=>{
  const value=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('http')).webContents.getLastWebPreferences();
  return {nodeIntegration:value.nodeIntegration,sandbox:value.sandbox,contextIsolation:value.contextIsolation,webviewTag:value.webviewTag,preload:value.preload||null};
 });assert.deepEqual(prefs,{nodeIntegration:false,sandbox:true,contextIsolation:true,webviewTag:false,preload:null});
 await page.locator('[data-action=add-page]').first().click();await page.locator('#page-form [name=title]').fill('Electron 실제 확인');await page.locator('#page-form button.solid-btn').click();
 await page.waitForSelector('#page-title');const pageID=await page.evaluate(()=>location.hash.split('/')[1]);
 await page.locator('[data-action=add-block]').first().click();await page.locator('.block-content').last().fill('데스크톱에서 쓴 가족 문서😀');
 await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent.includes('모든 변경'));
 await page.evaluate(()=>localStorage.setItem('desktop-fixture','server-one'));
 await page.reload();await page.waitForSelector('#page-title');assert.ok((await page.locator('.block-content').allInnerTexts()).includes('데스크톱에서 쓴 가족 문서😀'));
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);assert.ok((await page.evaluate(()=>indexedDB.databases())).length>0);checks.push('same-origin service worker and persistent IndexedDB active');
 await page.screenshot({path:join(proof,'document.png')});checks.push('document create/edit/CRDT save/reload');
 const published=await page.evaluate(async pageID=>{
  const post=async(path,body)=>{const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Fountain-Request':'1'},body:JSON.stringify(body)});if(!response.ok)throw Error(await response.text());return response.json();};
  const form=await post('forms',{name:'Electron 실제 폼',database_id:'projects',published:true,fields:[{id:'title',property_id:'name',label:'응답',type:'text',required:true}]});
  const site=await post('sites',{name:'Electron 실제 사이트',page_id:pageID,slug:'desktop-fixture',published:true});return {form,site};
 },pageID);
 await page.locator('[data-action=settings]').first().click();await page.locator('[data-action=settings-tab][data-tab=forms]').click();
 await page.locator('[data-action=fill-form][data-id="'+published.form.id+'"]').click();
 const formPage=await pageFor(first.origin+'/forms/');await formPage.waitForSelector('#public-form');
 assert.deepEqual(await formPage.evaluate(()=>[typeof require,typeof window.fountainSetup]),['undefined','undefined']);
 await formPage.locator('input[name=title]').fill('Electron 팝업 실제 응답');await formPage.locator('button[type=submit]').click();
 await formPage.waitForFunction(()=>document.querySelector('#form-status')?.textContent.includes('제출되었습니다'));
 const sharedSession=await electron.evaluate(({BrowserWindow})=>{const windows=BrowserWindow.getAllWindows();return windows.find(window=>window.webContents.getURL().includes('/forms/')).webContents.session===windows.find(window=>window.webContents.getURL().includes('#page/')).webContents.session;});
 assert.equal(sharedSession,true);await formPage.close();checks.push('existing form button opens isolated same-session sandbox popup and submits');
 await page.locator('[data-action=settings-tab][data-tab=sites]').click();await page.locator('[data-action=site-link][data-id="'+published.site.id+'"]').click();
 const sitePage=await pageFor(first.origin+'/sites/');await sitePage.waitForSelector('h1');assert.equal(await sitePage.locator('h1').innerText(),'Electron 실제 확인');
 const before=electron.windows().length;await sitePage.evaluate(()=>{window.open('/api/workspace','_blank');window.open('https://attacker.invalid/forms/x','_blank');});await sitePage.waitForTimeout(100);assert.equal(electron.windows().length,before);
 await sitePage.close();await page.locator('[data-action=close-modal]').first().click();checks.push('existing site button opens sandbox popup and rejects API/external popups');

 const config=JSON.parse(await readFile(join(temporary,'userdata','server.json'),'utf8'));assert.equal(config.server,first.origin+'/');
 if(process.platform!=='win32')assert.equal((await stat(join(temporary,'userdata','server.json'))).mode&0o777,0o600);
 await settings();
 const denied=await electron.evaluate(async({ipcMain,BrowserWindow})=>{
  const window=BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().startsWith('http'));
  try{await ipcMain._invokeHandlers.get('desktop:server:save')({sender:window.webContents,senderFrame:window.webContents.mainFrame},'https://attacker.invalid');return false;}catch{return true;}
 });assert.equal(denied,true);checks.push('real IPC handler rejects remote sender');
 setup=await pageFor('file:');await setup.close();
 await page.evaluate(()=>{window.open('file:///etc/passwd');location.href='https://attacker.invalid/';});
 await page.waitForTimeout(200);assert.ok(page.url().startsWith(first.origin));assert.equal(electron.windows().length,1);checks.push('external navigation/window creation blocked');
 const permission=await page.evaluate(()=>new Promise(yes=>navigator.geolocation.getCurrentPosition(()=>yes('granted'),error=>yes(error.code))));assert.equal(permission,1);checks.push('permission denied without OS prompt');
 const cookieBefore=await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({}).then(values=>values.some(cookie=>cookie.name==='fountain_session')));assert.equal(cookieBefore,true);
 const port=new URL(first.origin).port;await stopServer(first.child);const restarted=await startServer('first',Number(port));
 await page.reload();await page.waitForSelector('#page-title');assert.ok((await page.locator('.block-content').allInnerTexts()).includes('데스크톱에서 쓴 가족 문서😀'));checks.push('same-server restart preserves login/document');
 const second=await startServer('second');setup=await settings();let other=await connect(setup,second.origin);
 await other.waitForSelector('#login-form');assert.equal(await other.evaluate(()=>localStorage.getItem('desktop-fixture')),null);
 const newCookies=await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('http')).webContents.session.cookies.get({}).then(values=>values.length));assert.equal(newCookies,0);checks.push('server-origin partition separates cookies/cache/storage');
 const third=await startServer('third');setup=await settings();
 const concurrent=await setup.evaluate(([first,last])=>Promise.all([window.fountainSetup.save(first),window.fountainSetup.save(last)]),[first.origin,third.origin]);assert.ok(concurrent.every(result=>result.ok));
 let last=await pageFor(third.origin);await last.waitForSelector('#login-form');await last.waitForTimeout(200);
 assert.equal(electron.windows().length,1);assert.equal(JSON.parse(await readFile(join(temporary,'userdata','server.json'),'utf8')).server,third.origin+'/');checks.push('concurrent server requests serialize to one final window/config');
 setup=await settings();page=await connect(setup,first.origin);await page.waitForSelector('.recent-grid');assert.equal(await page.evaluate(()=>localStorage.getItem('desktop-fixture')),'server-one');
 await electron.close();electron=null;await launch();page=await pageFor(first.origin);await page.waitForSelector('.recent-grid');checks.push('app relaunch preserves selected server and its cookie');
 await page.goto(first.origin+'/#page/'+pageID);await page.waitForSelector('#page-title');
 const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scale:devicePixelRatio}));
 const chrome=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
 try{const context=await chrome.newContext({viewport:{width:size.width,height:size.height},deviceScaleFactor:size.scale});
  const cookies=await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({}));
  await context.addCookies(cookies.map(cookie=>({name:cookie.name,value:cookie.value,domain:cookie.domain,path:cookie.path,httpOnly:cookie.httpOnly,secure:cookie.secure,sameSite:cookie.sameSite==='strict'?'Strict':cookie.sameSite==='lax'?'Lax':'None'})));
  const reference=await context.newPage();await reference.goto(page.url());await reference.waitForSelector('#page-title');await reference.waitForTimeout(300);
  await page.evaluate(()=>document.activeElement?.blur());await reference.evaluate(()=>document.activeElement?.blur());
  await reference.locator('.block-content').first().fill('Chrome에서 전달한 실제 SSE 변경');
  await reference.waitForFunction(()=>document.querySelector('#save-status')?.textContent.includes('모든 변경'));
  await page.waitForFunction(()=>document.querySelector('.block-content')?.textContent.includes('Chrome에서 전달한 실제 SSE 변경'));checks.push('Chrome edit reaches native document through actual SSE');
  await reference.locator('.block-content').first().fill('데스크톱에서 쓴 가족 문서😀');await page.waitForFunction(()=>document.querySelector('.block-content')?.textContent.includes('데스크톱에서 쓴 가족 문서😀'));
  await page.evaluate(()=>document.activeElement?.blur());await reference.evaluate(()=>document.activeElement?.blur());
  await page.screenshot({path:join(proof,'document.png')});await reference.screenshot({path:join(proof,'document-web-reference.png')});checks.push('same fixture/cookie/viewport Chrome reference captured');
 }finally{await chrome.close();}
 const report={platform:process.platform,arch:process.arch,electron:await electron.evaluate(()=>process.versions.electron),checks,windowsExecution:false,app:await electron.evaluate(({app})=>({isPackaged:app.isPackaged,appPath:app.getAppPath()}))};
 await import('node:fs/promises').then(fs=>fs.writeFile(join(proof,process.env.FOUNTAIN_DESKTOP_PACKAGED==='1'?'electron-packaged-smoke.json':'electron-smoke.json'),JSON.stringify(report,null,2)));
 console.log('PASS actual Electron:',JSON.stringify(report));
}finally{
 await import('node:fs/promises').then(fs=>fs.writeFile(join(proof,'electron-runtime.log'),electronLog.join('\n')));
 if(electron)await electron.close();for(const child of servers)await stopServer(child);await rm(temporary,{recursive:true,force:true});
}
