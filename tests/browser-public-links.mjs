/** Actual Chrome + disposable Python Auth/domain, with a local presentation relay.
 * The relay transport and optional frontend metadata are fixtures. This does not
 * verify a Vercel deployment, Supabase cutover, or native OS browser launch. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicRelay,UPSTREAM} from '../apps/web/api/public-relay.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-public-links-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const primary='https://family.example.invalid';
let processServer,web,browser,backend,origin;
const errors=[],publicRequests=[],relayStatuses=[];
async function startBackend(){
 const env={...process.env};delete env.FOUNTAIN_ACCESS_TOKEN;
 processServer=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
 return new Promise((resolve,reject)=>{
  let output='';const timer=setTimeout(()=>reject(Error('Disposable backend startup timed out')),15000);
  const receive=bytes=>{output+=bytes;const match=/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(output);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};
  processServer.stdout.on('data',receive);processServer.stderr.on('data',receive);processServer.once('error',reject);processServer.once('exit',code=>{clearTimeout(timer);reject(Error('Disposable backend exited '+code));});
 });
}
async function api(context,path,body,method){
 const response=await context.request.fetch(origin+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});
 assert(response.ok(),path+': '+response.status());return response.json();
}
async function login(page,email,password){
 await page.locator('#login-form').waitFor();await page.locator('[name=email]').fill(email);await page.locator('[name=password]').fill(password);await page.locator('#login-form .solid-btn').click();
}
try{
 backend=await startBackend();
 const relay=createPublicRelay({fetch:async(url,options)=>{
  const response=await fetch(backend+url.slice(UPSTREAM.length),options);
  // The Python oracle predates Edge's explicit presentation marker. Supply
  // that fixture marker only for its successful HTML render response.
  if(response.status===200&&response.headers.get('Content-Type')?.startsWith('text/html')){
   const headers=new Headers(response.headers);headers.set('X-Fountain-Format','html');return new Response(response.body,{status:response.status,headers});
  }
  return response;
 }});
 web=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,origin),headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(key))headers.set(key,Array.isArray(value)?value.join(', '):value);
   let response;
   if(/^\/(forms|sites)\//.test(url.pathname)){
    publicRequests.push(url.pathname);response=await relay(new Request(url,{method:req.method,headers}));relayStatuses.push(response.status);
   }else{
    // The legacy oracle only accepts its own loopback Origin. Map this
    // fixture's exact origin; a deployed Supabase allowlist is tested separately.
    if(headers.has('Origin')){if(headers.get('Origin')!==origin){res.writeHead(403);res.end();return;}headers.set('Origin',backend);}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    response=await fetch(backend+url.pathname+url.search,{method:req.method,headers,redirect:'manual',...(body.length?{body}:{})});
    if(url.pathname==='/api/session'&&req.method==='GET'&&response.status===200){
     const values=await response.json();response=new Response(JSON.stringify({...values,public_web_origin:primary}),{status:response.status,headers:response.headers});
    }
   }
   res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>!['connection','transfer-encoding','content-encoding','content-length'].includes(key))));
   res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(502);res.end();}
 });await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+web.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 const setup=await browser.newContext(),owner=(await api(setup,'/accounts')).accounts.find(item=>item.role==='owner'),password='Public-links-family-2026';
 await api(setup,'/accounts',{member_id:owner.id,password});await api(setup,'/accounts/enable',{});await api(setup,'/session',{email:owner.email,password});
 const document=await api(setup,'/pages',{title:'가족 링크',blocks:[{id:'family-public-text',type:'paragraph',text:'가족에게만 보이는 내용'}]});
 const site=await api(setup,'/sites',{name:'가족 사이트',page_id:document.id,slug:'family-public-links',published:true});await setup.close();
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/sites/'+site.slug);await page.locator('#login-form').waitFor();
 assert.equal(new URL(page.url()).hash,'#home');assert.equal(relayStatuses.at(-1),303);
 await login(page,owner.email,'incorrect-fixture-password');await page.locator('#login-error').filter({hasText:/./}).waitFor();assert.equal(publicRequests.length,1);
 await login(page,owner.email,password);await page.waitForURL(origin+'/sites/'+site.slug);await page.locator('main').waitFor();assert.match(await page.locator('main').innerText(),/가족에게만 보이는 내용/);assert.equal(relayStatuses.at(-1),200);
 const cookie=(await context.cookies()).find(value=>value.name==='fountain_session');assert(cookie?.httpOnly&&cookie.sameSite==='Strict');
 // A signed-in browser also follows the return link, after real session/workspace checks.
 await page.goto(origin+'/#open-public='+encodeURIComponent('/sites/'+site.slug));await page.waitForURL(origin+'/sites/'+site.slug);await page.locator('main').waitFor();
 // Exact paths only: no host, query, fragment, nested encoding, or noncanonical encoding.
 const before=publicRequests.length;
 for(const value of ['https://outside.invalid/sites/a','//outside.invalid/sites/a','/sites/a?x=1','/sites/a#x','/sites/../secret','/sites/%2fescape','/forms/한글','/sites/a/b']){
  await page.goto(origin+'/#open-public='+encodeURIComponent(value));await page.locator('.welcome-row').waitFor();assert.equal(new URL(page.url()).hash,'#home');
 }
 for(const encoded of ['%ZZ','%2fsites%2ffamily-public-links','%252Fsites%252Ffamily-public-links']){
  await page.goto(origin+'/#open-public='+encoded);await page.locator('.welcome-row').waitFor();assert.equal(new URL(page.url()).hash,'#home');
 }
 assert.equal(publicRequests.length,before);
 // Actual permission UI uses the deployment metadata, while app navigation stays local.
 await page.goto(origin+'/#page/'+document.id);await page.locator('#page-title').waitFor();await page.locator('[data-action=share]').click();
 assert.equal(await page.locator('#share-url').inputValue(),primary+'/#page/'+document.id);
 const saved=await page.evaluate(async()=>FountainOffline.getProfile());assert.equal(saved.session.public_web_origin,primary);
 const profileId=saved.id;
 for(const value of ['https://family.example.invalid/','https://user:password@family.example.invalid','http://family.example.invalid','https://family.example.invalid:443','https://family.example.invalid?secret=x','https://family.example.invalid#x','https://family.example.invalid\n']){
  const result=await page.evaluate(async({saved,value})=>FountainOffline.saveProfile({...saved,session:{...saved.session,public_web_origin:value}}),{saved,value});assert.equal(result.id,profileId);assert.equal(Object.hasOwn(result.session,'public_web_origin'),false);
 }
 const restored=await page.evaluate(async saved=>FountainOffline.saveProfile(saved),saved);assert.equal(restored.session.public_web_origin,primary);assert.equal(restored.id,profileId);
 const stored=await page.evaluate(()=>Object.values(localStorage));assert(!stored.some(value=>value.includes(password)||value.includes('#open-public=')));
 assert.deepEqual(errors,[]);await context.close();
 console.log('PASS actual Chrome/disposable Auth: protected site login/failed retry/return, signed-in return, hostile path rejection, permission link metadata, offline metadata allowlist and unchanged identity. Local presentation transport only.');
}finally{
 await browser?.close();web?.closeAllConnections();if(web)await new Promise(resolve=>web.close(resolve));processServer?.kill('SIGTERM');await rm(directory,{recursive:true,force:true});
}
