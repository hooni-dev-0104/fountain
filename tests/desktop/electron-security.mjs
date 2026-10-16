/** Installed Electron security behavior: TLS rejection and popup method/options. */
import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir,writeFile,realpath} from 'node:fs/promises';import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';import {fileURLToPath} from 'node:url';import https from 'node:https';import http from 'node:http';import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=fileURLToPath(new URL('../..',import.meta.url)),desktop=join(root,'apps','desktop');
const temp=await realpath(await mkdtemp(join(tmpdir(),'fountain-electron-security-'))),proof=join(root,'.data','desktop-proof');await mkdir(proof,{recursive:true});
let app,postCount=0,apiCount=0,tlsRequests=0;
const html='<!doctype html><title>Native security fixture</title><h1>Native security fixture</h1>';
const fixture=http.createServer((request,response)=>{if(request.method==='POST')postCount++;if(request.url.startsWith('/api/'))apiCount++;if(request.url==='/download'){response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Disposition','attachment; filename=fixture.txt');response.end('Fountain desktop download fixture');return;}response.setHeader('Content-Type','text/html');response.end(html);});
let tls;
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 tls=https.createServer({key:await readFile(join(temp,'key.pem')),cert:await readFile(join(temp,'cert.pem'))},(_request,response)=>{tlsRequests++;response.end(html);});
 await new Promise(yes=>fixture.listen(0,'127.0.0.1',yes));await new Promise(yes=>tls.listen(0,'127.0.0.1',yes));
 const origin='http://127.0.0.1:'+fixture.address().port,untrusted='https://127.0.0.1:'+tls.address().port;
 const env={...process.env,FOUNTAIN_DESKTOP_USER_DATA:join(temp,'userdata')};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath:require(join(desktop,'node_modules','electron')),args:[desktop],env});
 let setup=await app.firstWindow();await setup.waitForSelector('#server');await setup.locator('#server').fill(untrusted);await setup.locator('button').click();
 await app.waitForEvent('window',{predicate:page=>page.url().startsWith('file:')});
 setup=app.windows().find(page=>page.url().startsWith('file:'));await setup.waitForSelector('#error');
 await setup.waitForFunction(()=>document.querySelector('#error').textContent.includes('서버에 연결할 수 없습니다'));
 assert.equal(tlsRequests,0,'Invalid certificate must fail before any HTTPS document request');
 await setup.locator('#server').fill(origin);await setup.locator('button').click();
 let page;for(let i=0;i<100;i++){page=app.windows().find(value=>value.url().startsWith(origin));if(page)break;await new Promise(yes=>setTimeout(yes,30));}
 await page.waitForSelector('h1');
 await page.evaluate(()=>{const form=document.createElement('form');form.method='POST';form.action='/forms/test';form.target='_blank';document.body.append(form);form.submit();window.open('/api/workspace','_blank');});
 await page.waitForTimeout(150);assert.equal(postCount,0);assert.equal(apiCount,0);assert.equal(app.windows().length,1);
 const popupEvent=app.waitForEvent('window');
 await page.evaluate(()=>window.open('/forms/test','_blank','nodeIntegration=yes,contextIsolation=no,sandbox=no,preload=/tmp/forbidden.cjs'));
 const popup=await popupEvent;await popup.waitForSelector('h1');
 assert.deepEqual(await popup.evaluate(()=>[typeof require,typeof process,typeof window.fountainSetup]),['undefined','undefined','undefined']);
 const preferences=await app.evaluate(({BrowserWindow})=>{
  const value=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/forms/')).webContents.getLastWebPreferences();
  return {node:value.nodeIntegration,sandbox:value.sandbox,isolation:value.contextIsolation,preload:value.preload||null};
 });assert.deepEqual(preferences,{node:false,sandbox:true,isolation:true,preload:null});
 await popup.evaluate(()=>{location.href='file:///etc/passwd';});await popup.waitForTimeout(100);assert.ok(popup.url().startsWith(origin));
 const saved=join(temp,'selected-download.txt');
 await app.evaluate(({BrowserWindow},destination)=>{const window=BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().includes('/forms/'));window.webContents.session.once('will-download',(_event,item)=>{item.setSavePath(destination);item.once('done',(_done,state)=>{globalThis.__fixtureDownloadState=state;});});},saved);
 await popup.evaluate(()=>{const link=document.createElement('a');link.href='/download';link.download='fixture.txt';document.body.append(link);link.click();});
 let downloaded=false;for(let i=0;i<100;i++){if(await app.evaluate(()=>globalThis.__fixtureDownloadState==='completed')){downloaded=true;break;}await new Promise(yes=>setTimeout(yes,30));}
 assert.ok(downloaded);assert.equal(await readFile(saved,'utf8'),'Fountain desktop download fixture');

 const report={platform:process.platform,electron:await app.evaluate(()=>process.versions.electron),checks:['untrusted self-signed TLS rejected before HTTP','POST and API popup requests denied before server access','popup feature injection cannot enable Node/preload or disable sandbox','popup external file navigation denied','same-origin popup download completes to explicitly selected fixture path']};
 await writeFile(join(proof,'electron-security.json'),JSON.stringify(report,null,2));console.log('PASS native security',JSON.stringify(report));
}finally{if(app)await app.close();fixture.closeAllConnections();await new Promise(yes=>fixture.close(yes));if(tls){tls.closeAllConnections();await new Promise(yes=>tls.close(yes));}await rm(temp,{recursive:true,force:true});}
