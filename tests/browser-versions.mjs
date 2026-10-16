import { waitForAsync } from './async-browser.mjs';
/** Saved-version previews and guarded restores run against a disposable real HTTP workspace. */
import {
  createRequire
}
from 'node:module';
import {
  spawn
}
from 'node:child_process';
import {
  mkdtemp,rm,mkdir,readFile,writeFile
}
from 'node:fs/promises';
import {
  homedir,tmpdir
}
from 'node:os';
import {
  join
}
from 'node:path';
import {
  fileURLToPath
}
from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url), {
  chromium
}
=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-versions-browser-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin,owner,member,viewer;
const errors=[];
async function startServer() {
  const environment= {
    ...process.env
  };
  delete environment.FOUNTAIN_ACCESS_TOKEN;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')], {
    cwd:fileURLToPath(new URL('..',import.meta.url)),env:environment,stdio:['ignore','pipe','pipe']
  });
  return new Promise((resolve,reject)=> {
    let output=''; const timer=setTimeout(()=>reject(new Error(output)),15000); const accept=chunk=> {
      output+=chunk.toString(); const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/); if(match) {
        clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]);
      }
    }; server.stdout.on('data',accept); server.stderr.on('data',accept); server.once('error',error=> {
      clearTimeout(timer); reject(error);
    }); server.once('exit',code=> {
      clearTimeout(timer); reject(new Error(`server ${code}: ${output}`));
    });
  });
}
async function response(context,path,body,method) {
  return context.request.fetch(origin+'/api'+path, {
    method:method||(body?'POST':'GET'),headers: {
      'X-Fountain-Request':'1'
    },...(body? {
      data:body
    }
    : {
    })
  });
}
async function api(context,path,body,method) {
  const result=await response(context,path,body,method);
  assert.ok(result.ok(),`${path}: ${result.status()} ${await result.text()}`);
  return result.json();
}
async function login(page,email,password) {
  await page.waitForSelector('#login-form [name="email"]');
  await page.locator('#login-form [name="email"]').fill(email);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('#sidebar .brand');
}
async function action(page,name,suffix='') {
  await page.locator(`[data-action="${name}"]${suffix}`).first().click();
}
async function ready(page,id){await waitForAsync(page,id=>state.channel?.pageId===id&&!state.channel.closed&&state.page?.id===id&&!!document.querySelector('#page-title'),id);}
async function history(page,id){await page.evaluate(id=>navigate('page',id),id);await ready(page,id);await action(page,'history');await page.waitForSelector('.version-choice');}
async function holdNext(page,path,method='GET'){
  let captured,release,done,routeError,used=false;const seen=new Promise(resolve=>captured=resolve),gate=new Promise(resolve=>release=resolve),finished=new Promise(resolve=>done=resolve);
  const handler=async route=>{if(used||route.request().method()!==method){await route.fallback();return;}used=true;try{const original=await route.fetch();captured(route.request().postDataJSON?.());await gate;await route.fulfill({response:original});}catch(error){routeError=error;}finally{done();}};
  await page.route(origin+'/api'+path,handler);
  return{seen:async()=>{let timer;try{return await Promise.race([seen,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Held version request did not arrive')),15000))]);}finally{clearTimeout(timer);}},release:async()=>{release();await finished;await page.unroute(origin+'/api'+path,handler);if(routeError)throw routeError;}};
}
async function counters(page){await page.evaluate(()=>{const original=api;window.versionGETs=0;window.versionRestores=0;api=async(...args)=>{try{return await original(...args);}finally{if(/^\/pages\/[^/]+$/.test(args[0])&&args[1]===undefined)window.versionGETs++;if(args[0].endsWith('/restore'))window.versionRestores++;}};});}
async function releaseDetail(page,held){const count=await page.evaluate(()=>window.versionGETs);await held.release();await waitForAsync(page,count=>window.versionGETs>count,count);}
try {
  origin=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}}),editorContext=await browser.newContext();
  const account=(await api(context,'/accounts')).accounts.find(account=>account.role==='owner'),password='Version-preview-family-2026';await api(context,'/accounts',{member_id:account.id,password});const editor=await api(context,'/members',{name:'기록을 읽는 가족',email:'versions@example.local',role:'member'});await api(context,'/accounts',{member_id:editor.id,password});await api(context,'/accounts/enable',{});
  owner=await context.newPage();member=await editorContext.newPage();for(const page of [owner,member]){page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);}
  await login(owner,account.email,password);await login(member,editor.email,password);await counters(owner);await counters(member);
  const attachment=await api(context,'/attachments',{name:'여행 <img src=x onerror=alert(1)>.txt',data:Buffer.from('preview never downloads').toString('base64')});
  const oldBlocks=[{id:'text',type:'paragraph',text:'함께 서울에 가요 🙂 <img src=x onerror=alert(1)>'},{id:'removed',type:'bullet',text:'이전 준비물'},{id:'format',type:'paragraph',text:'가족 일정',rich_text:[{text:'가족 일정',marks:{bold:true,link:'https://example.com'}}]},{id:'move',type:'paragraph',text:'함께 챙길 일'},{id:'file',type:'file',text:attachment.name,attachment_id:attachment.id,size:attachment.size}];
  const record=await api(context,'/pages',{title:'가족 여행 초안',blocks:oldBlocks}),other=await api(context,'/pages',{title:'다른 문서',blocks:[{id:'other',type:'paragraph',text:'이 문서를 덮지 않아요.'}]});
  const newBlocks=[oldBlocks[3],{id:'text',type:'paragraph',text:'함께 부산에 가요 🙂 <script>invalid</script>'},{id:'format',type:'paragraph',text:'가족 일정',rich_text:[{text:'가족 일정',marks:{italic:true}}]},oldBlocks[4],{id:'added',type:'todo',text:'새 준비물',checked:true}];
  await api(context,'/pages/'+record.id+'/blocks',{blocks:newBlocks},'PUT');await api(context,'/pages/'+record.id,{title:'가족의 가을 여행'},'PATCH');await api(context,'/pages/'+record.id+'/blocks',{blocks:newBlocks},'PUT');
  await owner.evaluate(id=>navigate('page',id),record.id);await ready(owner,record.id);await waitForAsync(owner,()=>state.channel.pending.size===0);
  const before=await api(context,'/pages/'+record.id),version=before.versions.find(version=>version.blocks.some(block=>block.id==='removed'));
  const writes=[],downloads=[];owner.on('request',request=>{if(request.url().startsWith(origin+'/api/')&&!['GET','HEAD'].includes(request.method())&&!request.url().endsWith('/presence'))writes.push({path:new URL(request.url()).pathname,method:request.method()});});owner.on('download',download=>downloads.push(download));
  await action(owner,'history');await owner.waitForSelector('.version-choice');await owner.locator('[data-action="select-version"][data-id="'+version.id+'"]').click();
  assert.match(await owner.locator('[data-action="select-version"][data-id="'+version.id+'"]').innerText(),/버전 0/);await owner.locator('[data-action="select-version"][data-id="'+before.versions[0].id+'"]').click();assert.equal(await owner.locator('.version-title-pair h3').first().innerText(),before.page.title);await owner.locator('[data-action="select-version"][data-id="'+version.id+'"]').click();
  assert.equal(await owner.locator('.version-modal [contenteditable="true"],.version-modal img,.version-modal script,.version-modal a').count(),0,'previews have no editable HTML, remote media or navigation/download links');
  assert.match(await owner.locator('.version-modal').innerText(),/서식·속성/);assert.match(await owner.locator('.version-modal').innerText(),/이동/);assert.match(await owner.locator('.version-modal').innerText(),/블록 추가 1/);assert.match(await owner.locator('.version-modal').innerText(),/블록 삭제 1/);assert.ok(await owner.locator('.version-modal del').count());assert.ok(await owner.locator('.version-modal ins').count());assert.equal(await owner.locator('.version-file').count(),2);assert.match(await owner.locator('.version-file').first().innerText(),/<img src=x/);
  assert.deepEqual(writes,[]);assert.deepEqual(downloads,[]);assert.equal(await owner.evaluate(()=>state.channel.pending.size),0);const afterPreview=await api(context,'/pages/'+record.id);assert.equal(afterPreview.page.revision,before.page.revision);assert.deepEqual(afterPreview.blocks,before.blocks);assert.equal(afterPreview.versions.length,before.versions.length);
  assert.equal(await owner.evaluate(async()=>{const snapshot=await FountainOffline.getSnapshot(state.channel.key);return Object.hasOwn(snapshot,'versions')||Object.hasOwn(snapshot.page,'versions');}),false,'saved history bodies never enter offline snapshots');
  await owner.screenshot({path:'/tmp/fountain-versions-desktop.png',fullPage:false,animations:'disabled'});await owner.setViewportSize({width:390,height:844});await owner.screenshot({path:'/tmp/fountain-versions-mobile.png',fullPage:false,animations:'disabled'});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await owner.setViewportSize({width:1440,height:1050});
  await action(owner,'restore-version');await owner.waitForSelector('.version-confirm');assert.deepEqual(writes,[],'requesting confirmation does not restore');await action(owner,'cancel-version-restore');assert.equal(await owner.locator('.version-confirm').count(),0);
  await api(context,'/pages/'+record.id,{locked:true},'PATCH');await owner.waitForFunction(()=>state.page.locked);assert.equal(await owner.locator('[data-action="restore-version"]').isDisabled(),true);assert.match(await owner.locator('.version-permission-note').innerText(),/잠긴 페이지/);await api(context,'/pages/'+record.id,{locked:false},'PATCH');await owner.waitForFunction(()=>!state.page.locked);assert.equal(await owner.locator('[data-action="restore-version"]').isDisabled(),false);
  // A newer edit after the frozen comparison receives409 without replacing its current content.
  await api(context,'/pages/'+record.id,{title:'다른 기기의 최신 제목'},'PATCH');await owner.waitForFunction(()=>state.page.title==='다른 기기의 최신 제목');const staleBefore=await api(context,'/pages/'+record.id),staleEpoch=await owner.evaluate(()=>state.channel.base.epoch);
  await action(owner,'restore-version');await action(owner,'confirm-version-restore');await owner.waitForSelector('#version-status .info-box');assert.match(await owner.locator('#version-status').innerText(),/문서가 기록을 연 뒤 변경/);assert.equal(await owner.locator('[data-action="restore-version"]').isDisabled(),true);
  const staleAfter=await api(context,'/pages/'+record.id);assert.equal(staleAfter.page.revision,staleBefore.page.revision);assert.equal(staleAfter.page.title,staleBefore.page.title);assert.deepEqual(staleAfter.blocks,staleBefore.blocks);assert.equal(staleAfter.versions.length,staleBefore.versions.length);assert.equal(await owner.evaluate(()=>state.channel.base.epoch),staleEpoch);
  await owner.locator('#version-status [data-action="history"]').click();await owner.waitForSelector('.version-choice');await owner.locator('[data-action="select-version"][data-id="'+version.id+'"]').click();
  // Restore commits on the real server; SSE can precede the intentionally held HTTP response.
  console.log('PASS preview and stale409; testing held restore response');
  const restorePath='/pages/'+record.id+'/versions/'+version.id+'/restore',heldRestore=await holdNext(owner,restorePath,'POST');await action(owner,'restore-version');await action(owner,'confirm-version-restore');const payload=await heldRestore.seen();assert.equal(payload.revision,staleAfter.page.revision);
  await owner.waitForSelector('.version-modal',{state:'detached'});await owner.waitForFunction(()=>state.page.title==='가족 여행 초안');assert.equal((await api(context,'/pages/'+record.id)).blocks.some(block=>block.id==='removed'),true);
  await owner.evaluate(id=>navigate('page',id),other.id);await ready(owner,other.id);await owner.evaluate(()=>showAI());const unrelated=await owner.locator('.modal-body').innerHTML(),restoreCount=await owner.evaluate(()=>window.versionRestores);await heldRestore.release();await waitForAsync(owner,count=>window.versionRestores>count,restoreCount);assert.equal(await owner.locator('.modal-body').innerHTML(),unrelated);assert.equal(await owner.evaluate(()=>state.page.id),other.id);
  console.log('PASS read-only diff/XSS/no-write, confirmation, real stale409 and restore SSE-before-HTTP scope');
  // Late detail responses cannot open another modal/page or survive a new epoch.
  await owner.evaluate(id=>navigate('page',id),record.id);await ready(owner,record.id);
  let held=await holdNext(owner,'/pages/'+record.id);await action(owner,'history');await held.seen();await action(owner,'close-modal');await owner.evaluate(()=>showAI());const modal=await owner.locator('.modal-body').innerHTML();await releaseDetail(owner,held);assert.equal(await owner.locator('.modal-body').innerHTML(),modal);
  await action(owner,'close-modal');held=await holdNext(owner,'/pages/'+record.id);await action(owner,'history');await held.seen();await owner.evaluate(id=>navigate('page',id),other.id);await ready(owner,other.id);await releaseDetail(owner,held);assert.equal(await owner.locator('.version-modal').count(),0);assert.equal(await owner.evaluate(()=>state.page.id),other.id);
  await owner.evaluate(id=>navigate('page',id),record.id);await ready(owner,record.id);held=await holdNext(owner,'/pages/'+record.id);await action(owner,'history');await held.seen();const oldEpoch=await owner.evaluate(()=>state.channel.base.epoch);await api(context,'/pages/'+record.id+'/blocks',{blocks:newBlocks},'PUT');await waitForAsync(owner,epoch=>state.channel.base.epoch!==epoch,oldEpoch);await releaseDetail(owner,held);assert.equal(await owner.locator('.version-modal').count(),0);
  // A slow pre-history save cannot trigger the old page GET after navigation.
  await owner.evaluate(()=>{window.versionOriginalSave=savePage;window.versionSaveHeld=false;window.versionSaveDone=false;let first=true;savePage=async()=>{if(!first)return window.versionOriginalSave();first=false;window.versionSaveHeld=true;await new Promise(resolve=>window.releaseVersionSave=resolve);const result=await window.versionOriginalSave();window.versionSaveDone=true;return result;};});
  let getRequests=0;const track=request=>{if(request.method()==='GET'&&request.url()===origin+'/api/pages/'+record.id)getRequests++;};owner.on('request',track);await action(owner,'history');await owner.waitForFunction(()=>window.versionSaveHeld);await owner.evaluate(id=>navigate('page',id),other.id);await ready(owner,other.id);await owner.evaluate(()=>window.releaseVersionSave());await owner.waitForFunction(()=>window.versionSaveDone);await owner.evaluate(()=>savePage=window.versionOriginalSave);owner.off('request',track);assert.equal(getRequests,0);assert.equal(await owner.locator('.version-modal').count(),0);
  await api(context,'/pages/'+record.id+'/permissions',{permissions:{default:'private',inherit:false,members:{[editor.id]:'full'},groups:{}}},'PATCH');await history(member,record.id);assert.equal(await member.locator('[data-action="restore-version"]').isDisabled(),false);await api(context,'/pages/'+record.id+'/permissions',{permissions:{default:'private',inherit:false,members:{[editor.id]:'edit'},groups:{}}},'PATCH');await member.waitForFunction(()=>resourceLevel(state.page)===3&&document.querySelector('[data-action="restore-version"]').disabled);assert.equal(await member.locator('.version-modal').count(),1,'full-to-edit downgrade retains readonly preview but disables restore');
  // edit3 can inspect bodies but cannot restore; a later downgrade clears an open/held preview.
  await history(member,record.id);assert.equal(await member.locator('[data-action="restore-version"]').isDisabled(),true);assert.match(await member.locator('.version-permission-note').innerText(),/전체 권한/);await action(member,'close-modal');held=await holdNext(member,'/pages/'+record.id);await action(member,'history');await held.seen();await api(context,'/pages/'+record.id+'/permissions',{permissions:{default:'private',inherit:false,members:{[editor.id]:'view'},groups:{}}},'PATCH');await member.waitForFunction(()=>resourceLevel(state.page)<3);await releaseDetail(member,held);assert.equal(await member.locator('.version-modal').count(),0);assert.deepEqual((await api(editorContext,'/pages/'+record.id)).versions,[]);
  await api(context,'/pages/'+record.id+'/permissions',{permissions:{default:'workspace',inherit:false,members:{},groups:{}}},'PATCH');
  // Real account replacement cannot receive a prior account's history body.
  await owner.evaluate(id=>navigate('page',id),record.id);await ready(owner,record.id);held=await holdNext(owner,'/pages/'+record.id);await action(owner,'history');await held.seen();await owner.evaluate(()=>doAction({dataset:{action:'logout'}}));await login(owner,editor.email,password);await owner.evaluate(id=>navigate('page',id),record.id);await ready(owner,record.id);await action(owner,'history');await owner.waitForSelector('.version-choice');const fresh=await owner.locator('.modal-body').innerHTML();await releaseDetail(owner,held);assert.equal(await owner.locator('.modal-body').innerHTML(),fresh);assert.equal(await owner.evaluate(()=>state.versionView.scope.memberId),editor.id);
  // Long changes use the comparator's explicit coarse indicator and still show the complete text.
  const large=await api(context,'/pages',{title:'긴 기록',blocks:[{id:'long',type:'paragraph',text:'a'.repeat(5000)}]});await api(context,'/pages/'+large.id+'/blocks',{blocks:[{id:'long',type:'paragraph',text:'b'.repeat(5000)}]},'PUT');await history(owner,large.id);assert.match(await owner.locator('.version-coarse').innerText(),/구간을 묶어서/);assert.equal((await owner.locator('[data-preview-id="long"][data-preview-side="before"] .version-block-text').innerText()).length,5000);
  // Real401 headers arrive under the old login; only its JSON body is delayed.
  await owner.evaluate(id=>{const original=FountainTransport;window.versionOriginalTransport=original;window.version401JSONStarted=false;window.version401Finished=false;let used=false;window.FountainTransport={...original,request:async(path,options)=>{if(!used&&path==='/api/pages/'+id){used=true;const response=await fetch(path,{credentials:'omit'});if(response.status!==401)throw new Error('Expected actual anonymous401 fixture');return{ok:response.ok,status:response.status,json:async()=>{window.version401JSONStarted=true;await new Promise(resolve=>window.releaseVersion401=resolve);return response.json();}};}return original.request(path,options);}};window.version401Task=historyModal().finally(()=>window.version401Finished=true);},large.id);
  await owner.waitForFunction(()=>window.version401JSONStarted);await owner.evaluate(()=>doAction({dataset:{action:'logout'}}));await login(owner,account.email,password);await waitForAsync(owner,id=>state.loaded&&state.session.member.id===id&&!!state.offlineProfile,account.id);await waitForAsync(owner,async()=>!!await FountainOffline.getProfile());await owner.waitForSelector('#login-form',{state:'detached'});
  await owner.evaluate(()=>window.releaseVersion401());await owner.waitForFunction(()=>window.version401Finished);assert.equal(await owner.locator('#login-form').count(),0,'an old401 body must not log out the newly authenticated account');assert.equal(await owner.evaluate(async()=>!!await FountainOffline.getProfile()),true,'an old401 must preserve the new account cache');assert.equal((await api(context,'/session')).member.id,account.id);await owner.evaluate(()=>window.FountainTransport=window.versionOriginalTransport);
  // The401 session-revalidation body is a second asynchronous authentication boundary.
  await owner.evaluate(id=>{const original=FountainTransport;window.versionOriginalTransport=original;window.versionSessionJSONStarted=false;window.version401Finished=false;let forced=false,held=false;window.FountainTransport={...original,request:async(path,options)=>{if(!forced&&path==='/api/pages/'+id){forced=true;return fetch(path,{credentials:'omit'});}if(forced&&!held&&path==='/api/session'&&(!options?.method||options.method==='GET')){held=true;const response=await original.request(path,options);return{ok:response.ok,status:response.status,json:async()=>{window.versionSessionJSONStarted=true;await new Promise(resolve=>window.releaseVersionSession=resolve);return response.json();}};}return original.request(path,options);}};window.version401Task=historyModal().finally(()=>window.version401Finished=true);},large.id);
  await owner.waitForFunction(()=>window.versionSessionJSONStarted);await owner.evaluate(()=>doAction({dataset:{action:'logout'}}));await login(owner,editor.email,password);await waitForAsync(owner,id=>state.loaded&&state.session.member.id===id&&!!state.offlineProfile,editor.id);await waitForAsync(owner,async()=>!!await FountainOffline.getProfile());await owner.waitForSelector('#login-form',{state:'detached'});
  await owner.evaluate(()=>window.releaseVersionSession());await owner.waitForFunction(()=>window.version401Finished);assert.equal(await owner.locator('#login-form').count(),0,'late revalidation must not log out the new account');assert.equal(await owner.evaluate(async()=>!!await FountainOffline.getProfile()),true);assert.equal(await owner.evaluate(()=>state.session.member.id),editor.id);await owner.evaluate(()=>window.FountainTransport=window.versionOriginalTransport);
  // A fresh authenticated session also prevents an isolated stale401 from purging any current cache.
  await owner.evaluate(async id=>{const original=FountainTransport;let used=false;window.FountainTransport={...original,request:(path,options)=>{if(!used&&path==='/api/pages/'+id){used=true;return fetch(path,{credentials:'omit'});}return original.request(path,options);}};try{await historyModal();}finally{window.FountainTransport=original;}},large.id);assert.equal(await owner.locator('#login-form').count(),0);assert.equal(await owner.evaluate(async()=>!!await FountainOffline.getProfile()),true);assert.equal((await api(context,'/session')).member.id,editor.id);
  assert.deepEqual(errors,[]);console.log('PASS late modal/page/save/account/ACL/epoch isolation, edit-only preview and bounded long-text notice');
}finally{await browser?.close();if(server){server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
