/** Actual authenticated page sessions, RGA cursor anchors and ephemeral presence lifecycle. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { waitForAsync } from './async-browser.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-presence-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin,releaseSync,releasePresence;
const errors=[],sent=[];
async function startServer(){
  const env={...process.env};delete env.FOUNTAIN_ACCESS_TOKEN;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error(output)),15000);const read=chunk=>{output+=chunk.toString();const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',read);server.stderr.on('data',read);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(new Error(`server ${code}: ${output}`));});});
}
async function api(context,path,body,method){const response=await context.request.fetch(origin+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});assert.ok(response.ok(),`${path}: ${response.status()} ${await response.text()}`);return response.json();}
async function open(context,email,password,pageId){
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.stack||error.message));
  page.on('request',request=>{if(request.url().endsWith('/presence'))sent.push({url:request.url(),method:request.method(),body:request.postDataJSON()});});
  await page.goto(origin+'/#page/'+pageId);await page.locator('#login-form [name=email]').fill(email);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form .solid-btn').click();await page.waitForSelector('#page-title');return page;
}
async function select(page,anchor,focus=anchor){
  await page.evaluate(({anchor,focus})=>{
    const element=document.querySelector('.block[data-id="presence-block"] .block-content');element.focus();
    const locate=offset=>{let remaining=offset,node;const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);while((node=walker.nextNode())){const points=Array.from(node.textContent);if(remaining<=points.length)return [node,points.slice(0,remaining).join('').length];remaining-=points.length;}return [element,element.childNodes.length];};
    getSelection().setBaseAndExtent(...locate(anchor),...locate(focus));
  },{anchor,focus});
}
async function count(page,value,timeout=15000){await waitForAsync(page,expected=>state.presenceManager?.participants.length===expected,value,{timeout});}
try{
  origin=await startServer();browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
  const owner=await browser.newContext(),firstContext=await browser.newContext({viewport:{width:1440,height:1000}}),sameContext=await browser.newContext(),readerContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const password='Presence-family-password-2026',ownerMember=(await api(owner,'/accounts')).accounts.find(member=>member.role==='owner');
  await api(owner,'/accounts',{member_id:ownerMember.id,password});
  const first=await api(owner,'/members',{name:'하늘 <b>가족',email:'presence-first@example.local',role:'member'}),reader=await api(owner,'/members',{name:'별이 가족',email:'presence-reader@example.local',role:'member'});
  for(const member of [first,reader])await api(owner,'/accounts',{member_id:member.id,password});
  await api(owner,'/accounts/enable',{});await api(owner,'/session',{email:ownerMember.email,password});
  const text='가족 🙂 함께 기록해요. 오늘의 아이디어를 한곳에 모아요.';
  const document=await api(owner,'/pages',{title:'함께 쓰는 가족 노트',icon:'🌱',permissions:{default:'private',inherit:false,members:{[first.id]:'edit',[reader.id]:'view'},groups:{}},blocks:[{id:'presence-block',type:'paragraph',text,rich_text:[{text:'가족 ',marks:{bold:true}},{text:'🙂 ',marks:{italic:true}},{text:'함께 기록해요.',marks:{link:'https://example.com'}},{text:' 오늘의 아이디어를 한곳에 모아요.',marks:{}}]}]});
  const a=await open(firstContext,first.email,password,document.id),same=await open(sameContext,first.email,password,document.id),b=await open(readerContext,reader.email,password,document.id);
  await count(a,3);await count(same,3);await count(b,3);
  assert.equal(await b.locator('#page-title').getAttribute('contenteditable'),'false');
  assert.equal(await b.locator('#page-presence b').count(),0,'member names are text, never HTML');
  assert.ok((await b.locator('#page-presence').getAttribute('title')).includes(first.name));
  const firstClient=await a.evaluate(()=>state.channel.clientId),readerClient=await b.evaluate(()=>state.channel.clientId);
  const marker=await b.evaluate(client=>state.presenceManager.participants.find(person=>person.client_id===client).id,firstClient);
  const htmlBefore=await b.locator('#blocks').innerHTML();
  await select(a,4);
  await waitForAsync(b,id=>!!document.querySelector(`.remote-caret[data-presence-id="${id}"]`),marker);
  const expectedBefore=await a.evaluate(()=>state.channel.chars('presence-block')[3].id);
  assert.equal(await b.evaluate(client=>state.presenceManager.participants.find(person=>person.client_id===client).selection.anchor.before,firstClient),expectedBefore);
  assert.equal(await b.locator('#blocks').innerHTML(),htmlBefore,'presence cannot rewrite editor DOM');
  await select(a,1,8);
  await waitForAsync(b,id=>document.querySelectorAll(`.remote-selection[data-presence-id="${id}"]`).length>0,marker);
  const anchorBefore=await b.evaluate(client=>state.presenceManager.participants.find(person=>person.client_id===client).selection,firstClient);
  await select(same,0);await same.keyboard.insertText('새로운 ');
  await a.waitForFunction(()=>document.querySelector('.block-content')?.textContent.startsWith('새로운 '));
  await waitForAsync(b,({client,anchor})=>{const selection=state.presenceManager.participants.find(person=>person.client_id===client)?.selection;return selection?.anchor.before===anchor.anchor.before&&selection?.focus.before===anchor.focus.before;},{client:firstClient,anchor:anchorBefore});
  // A read-only viewer can point at text without editing it.
  await select(b,6);
  await waitForAsync(a,client=>state.presenceManager.participants.some(person=>person.client_id===client&&person.selection),readerClient);
  assert.equal(await a.locator('.remote-caret').count()>=1,true);
  await mkdir('/tmp/fountain-browser',{recursive:true});
  await b.screenshot({path:'/tmp/fountain-browser/presence-desktop.png',fullPage:true});
  await b.setViewportSize({width:390,height:844});await b.waitForTimeout(300);await b.screenshot({path:'/tmp/fountain-browser/presence-mobile.png',fullPage:true});assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await b.setViewportSize({width:1440,height:1000});
  for(const entry of sent.filter(entry=>entry.method==='PUT')){assert.equal(Object.hasOwn(entry.body,'text'),false);if(entry.body.selection)assert.deepEqual(Object.keys(entry.body.selection).sort(),['anchor','block_id','focus']);}
  // Even a deliberately reused client ID belongs to another login session.
  const sameSession=await api(sameContext,'/session');
  const sameIdSelection=await a.evaluate(()=>{const chars=state.channel.chars('presence-block'),point={before:chars[4].id,after:chars[5].id,offset:5};return {block_id:'presence-block',anchor:point,focus:point};});
  const sharedClient=await api(sameContext,'/pages/'+document.id+'/presence',{session_binding:sameSession.cache_binding,epoch:await a.evaluate(()=>state.channel.base.epoch),client_id:firstClient,seq:1,selection:sameIdSelection},'PUT');
  await waitForAsync(a,id=>!!document.querySelector(`.remote-caret[data-presence-id="${id}"]`),sharedClient.participant_id);
  assert.notEqual(sharedClient.participant_id,await a.evaluate(()=>state.presenceManager.selfId));
  await api(sameContext,'/pages/'+document.id+'/presence',{session_binding:sameSession.cache_binding,epoch:sharedClient.epoch,client_id:firstClient,seq:2},'DELETE');await count(a,3);await count(b,3);
  const beforeRevision=await b.evaluate(()=>state.presenceManager.revision);
  assert.equal(await b.evaluate(revision=>state.presenceManager.receive({epoch:state.channel.base.epoch,workspace_id:state.offlineProfile.workspaceId,current_member_id:state.offlineProfile.memberId,session_binding:state.session.cache_binding,revision:revision-1,participants:[]}),beforeRevision),false);
  const identityRejected=await b.evaluate(()=>{
    const manager=state.presenceManager,base={epoch:manager.epoch,workspace_id:state.offlineProfile.workspaceId,current_member_id:state.offlineProfile.memberId,session_binding:state.session.cache_binding,revision:manager.revision+1,participants:[]};
    return ['workspace_id','current_member_id','session_binding'].every(field=>manager.receive({...base,[field]:'another-identity'})===false);
  });assert.equal(identityRejected,true);
  await same.locator('[data-action=home]').first().click();await count(a,2);await count(b,2);
  // Exercise the visibility event branch without relying on headless window focus heuristics.
  await a.evaluate(()=>{window.__presenceHidden=true;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__presenceHidden?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await count(b,1);const hiddenStart=sent.length;await a.waitForTimeout(5400);assert.equal(sent.slice(hiddenStart).filter(entry=>entry.url.includes(document.id)&&entry.body?.client_id===firstClient&&['GET','PUT'].includes(entry.method)).length,0);
  await a.evaluate(()=>{window.__presenceHidden=false;document.dispatchEvent(new Event('visibilitychange'));});await count(a,2);await count(b,2);
  assert.equal(await b.evaluate(client=>state.presenceManager.participants.find(person=>person.client_id===client)?.selection,firstClient),null);
  await firstContext.setOffline(true);await a.waitForFunction(()=>state.offline);assert.equal(await a.locator('.remote-caret').count(),0);assert.equal(await a.locator('#page-presence .presence-avatar').count(),0);
  await count(b,1,20000); // Real 15-second server TTL, including SSE expiration delivery.
  await firstContext.setOffline(false);await count(a,2);await count(b,2);
  // Epoch changes clear stale anchors and old presence arrays.
  const previousEpoch=await a.evaluate(()=>state.channel.base.epoch),current=await api(owner,'/pages/'+document.id);
  await api(owner,'/pages/'+document.id+'/blocks',{revision:current.page.revision,blocks:[{id:'presence-block',type:'paragraph',text:'복원된 본문 🙂 새 위치'}]},'PUT');
  await a.waitForFunction(epoch=>state.channel.base.epoch!==epoch,previousEpoch);await count(a,2);
  assert.equal(await a.evaluate(()=>state.presenceManager.epoch===state.channel.base.epoch),true);
  await api(owner,'/pages/'+document.id+'/permissions',{permissions:{default:'private',inherit:false,members:{[first.id]:'edit',[reader.id]:'none'},groups:{}}},'PATCH');
  await b.waitForFunction(()=>!state.channel&&!state.presenceManager);await count(a,1);assert.equal(await b.locator('.remote-caret').count(),0);
  // Cached new pages must never announce presence before their creation receipt.
  await a.evaluate(async()=>{await FountainOffline.serviceWorkerReady;});await firstContext.setOffline(true);await a.waitForFunction(()=>state.offline);
  await a.locator('[data-action=add-page]').first().click();await a.locator('#page-form [name=title]').fill('오프라인 접속 정보 없는 문서');await a.locator('#page-form .solid-btn').click();await a.waitForFunction(()=>state.localPageOnly&&state.channel.remoteDeferred);
  const localId=await a.evaluate(()=>state.page.id);await a.locator('.block-content').first().fill('이 본문은 기기에만 있어요.');
  assert.equal(sent.filter(entry=>entry.url.includes(localId)).length,0);
  const gate=new Promise(resolve=>releaseSync=resolve);await firstContext.route('**/api/sync',async route=>{await gate;await route.continue().catch(()=>{});});
  await firstContext.setOffline(false);await a.waitForTimeout(1200);assert.equal(sent.filter(entry=>entry.url.includes(localId)).length,0);
  releaseSync();await firstContext.unroute('**/api/sync');await waitForAsync(a,()=>!state.localPageOnly&&!state.channel.remoteDeferred);await count(a,1);
  assert.ok(sent.some(entry=>entry.url.includes(localId)&&entry.method==='PUT'));
  const cached=await a.evaluate(async()=>({snapshots:await FountainOffline.listSnapshots(state.offlineProfile),cache:await Promise.all((await caches.keys()).map(async key=>(await(await caches.open(key)).keys()).map(request=>new URL(request.url).pathname)))}));
  assert.ok(cached.snapshots.every(record=>!Object.hasOwn(record.snapshot,'participants')));assert.ok(cached.cache.flat().every(path=>!path.startsWith('/api/')));
  // A delayed, already-committed presence ACK cannot redraw a logged-out page.
  let announce;const announced=new Promise(resolve=>announce=resolve),held=new Promise(resolve=>releasePresence=resolve);
  await firstContext.route('**/api/pages/'+localId+'/presence',async route=>{
    if(route.request().method()==='PUT'){try{const response=await route.fetch();announce();await held;await route.fulfill({response});}catch{announce();}}else await route.continue();
  });
  await a.evaluate(()=>state.presenceManager.update(null));
  let ackTimer;try{await Promise.race([announced,new Promise((_,reject)=>{ackTimer=setTimeout(()=>reject(new Error('Presence ACK gate did not receive a PUT')),15000);})]);}finally{clearTimeout(ackTimer);}
  await a.locator('[data-action=settings]').last().click();await a.locator('[data-action=logout]').click();await a.waitForSelector('#login-form');
  releasePresence();await a.waitForTimeout(200);assert.equal(await a.locator('.presence-overlay,.remote-caret').count(),0);assert.equal(await a.evaluate(()=>state.presenceManager),null);
  assert.equal((await api(owner,'/pages/'+localId+'/presence')).participants.length,0);
  assert.deepEqual(errors,[]);
  console.log('PASS: two identities plus same-account sessions, RGA emoji/richtext caret+selection and remote insertion, read-only pointer, revision fence, leave/visibility/offline TTL/rejoin, epoch/revocation, delayed ACK/logout isolation, no pre-creation presence and no private presence cache');
  console.log('Screenshots: /tmp/fountain-browser/presence-{desktop,mobile}.png');
}finally{releaseSync?.();releasePresence?.();await browser?.close();server?.kill('SIGTERM');await rm(directory,{recursive:true,force:true});}
