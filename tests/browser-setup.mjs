/** Local HTTP UI fixture. No external accounts, emails or cloud requests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const nonce='A'.repeat(43),password='fixture-password-long',requests=[];let authenticated=false,setupSupported=true;
const member={id:'local',name:'나',email:'owner@example.invalid',role:'owner',active:true},binding='1'.repeat(32),workspace='setup-ui-fixture';
const session=()=>({enabled:true,required:true,mode:'accounts',authenticated,setup_supported:setupSupported,member:authenticated?member:null,identity:authenticated?member.name:null,workspace_id:authenticated?workspace:null,cache_binding:authenticated?binding:null,expires_at:authenticated?new Date(Date.now()+86400000).toISOString():null});
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')){
   res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
   if(path==='/api/session'){
    if(req.method==='POST'){let text='';for await(const bytes of req)text+=bytes;const body=JSON.parse(text);requests.push(body);authenticated=true;}
    res.end(JSON.stringify(session()));return;
   }
   if(path==='/api/workspace'){res.end(JSON.stringify({workspace_id:workspace,current_member_id:member.id,session_binding:binding,access_revision:0,data_revision:0,pages:[],databases:[],teamspaces:[{id:'general',name:'가족',visibility:'open'}],members:[member],settings:{name:'가족'}}));return;}
   if(path==='/api/advanced'){res.end(JSON.stringify({audit:[],settings:{},features:[]}));return;}
   res.statusCode=404;res.end('{}');return;
  }
  const name=path==='/'?'index.html':path.slice(1);if(!/^[a-z][a-z0-9.-]*\.(html|js|css)$/.test(name)){res.statusCode=404;res.end();return;}
  const data=await readFile(new URL('../static/'+name,import.meta.url));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(data);
 }catch{res.statusCode=404;res.end();}
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/#setup='+nonce);await page.locator('#login-form').waitFor();
 assert.equal(new URL(page.url()).hash,'#home');assert.equal(await page.locator('[name=setup_nonce]').inputValue(),nonce);assert.equal(await page.locator('[name=setup_nonce]').getAttribute('type'),'password');
 assert.equal(await page.locator('#setup-confirm').isVisible(),false);
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('A'.repeat(43)))),false);
 await page.screenshot({path:'/tmp/fountain-setup-desktop.png'});await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/fountain-setup-mobile.png'});
 await page.locator('[name=email]').fill(member.email);await page.locator('[name=password]').fill(password);await page.locator('[name=create_account]').check();await page.locator('[name=setup_password_confirm]').fill('different-long-password');
 await page.locator('#login-form .solid-btn').click();await page.locator('#login-error').filter({hasText:'일치하지 않습니다'}).waitFor();assert.equal(requests.length,0);
 await page.locator('[name=setup_password_confirm]').fill(password);await page.locator('#login-form .solid-btn').click();await page.locator('.welcome-row').waitFor();
 assert.deepEqual(requests[0],{email:member.email,password,setup_nonce:nonce,create_account:true});assert.equal(await page.locator('[name=setup_nonce]').count(),0);
 const stored=await page.evaluate(async()=>{
  const out=[...Object.values(localStorage)];for(const info of await indexedDB.databases()){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});for(const name of db.objectStoreNames){const rows=await new Promise((resolve,reject)=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});out.push(JSON.stringify(rows));}db.close();}return out;
 });assert(!stored.some(value=>value.includes(nonce)||value.includes(password)));assert.deepEqual(errors,[]);await context.close();
 authenticated=false;const regular=await browser.newContext(),login=await regular.newPage();await login.goto(origin);await login.locator('#login-form').waitFor();await login.locator('[name=email]').fill(member.email);await login.locator('[name=password]').fill(password);await login.locator('#login-form .solid-btn').click();await login.locator('.welcome-row').waitFor();assert.deepEqual(requests[1],{email:member.email,password});await regular.close();
 authenticated=false;setupSupported=false;const legacy=await browser.newContext(),old=await legacy.newPage();await old.goto(origin);await old.locator('#login-form').waitFor();assert.equal(await old.locator('[name=setup_nonce]').count(),0);await legacy.close();
 console.log('PASS Chrome setup UI: masked tab-only code, URL removal, no persistent credentials, explicit new-account choice, normal/legacy login preserved; local HTTP fixture only');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
