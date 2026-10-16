import { waitForAsync } from './async-browser.mjs';
/** Recovery JSON import stages paused data only after a guarded, explicit UI preview. */
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
const directory=await mkdtemp(join(tmpdir(),'fountain-recovery-import-browser-'));
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
async function queue(page){await page.evaluate(()=>openMutationQueue());await page.waitForSelector('#recovery-import-file');}
async function choose(page,value,name='family-recovery.json'){
  await page.locator('#recovery-import-file').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(typeof value==='string'?value:JSON.stringify(value))});
  await waitForAsync(page,()=>!!state.recoveryImport&&!state.recoveryImport.busy&&!!(state.recoveryImport.prepared||state.recoveryImport.error||state.recoveryImport.result));
}
async function confirm(page){await action(page,'confirm-recovery-import');await waitForAsync(page,()=>!!state.recoveryImport&&!state.recoveryImport.staging&&!!(state.recoveryImport.result||state.recoveryImport.error));}
async function counts(page){return page.evaluate(async()=>({records:(await state.mutations.records()).length,localPages:(await FountainOffline.listLocalPages(state.offlineProfile)).length,drafts:state.channel?(await FountainOffline.getDrafts(state.channel.key)).filter(record=>!['pending','basis'].includes(record.draft?.reason)).length:0}));}
try{
  origin=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}});const account=(await api(context,'/accounts')).accounts.find(account=>account.role==='owner'),password='Recovery-import-isolated-2026';await api(context,'/accounts',{member_id:account.id,password});const editor=await api(context,'/members',{name:'다른 가족',email:'recovery-ui@example.local',role:'member'});await api(context,'/accounts',{member_id:editor.id,password});await api(context,'/accounts/enable',{});owner=await context.newPage();owner.on('pageerror',error=>errors.push(error.message));await owner.goto(origin);await login(owner,account.email,password);await owner.waitForSelector('.recent-grid');await waitForAsync(owner,()=>!!state.mutations);
  const page=await api(context,'/pages',{title:'복구 내용을 모으는 문서',blocks:[{id:'original',type:'paragraph',text:'현재 본문을 유지합니다.'}]}),attachment=await api(context,'/attachments',{name:'가족 <img src=x>.txt',data:Buffer.from('metadata only').toString('base64')});
  await owner.evaluate(id=>navigate('page',id),page.id);await ready(owner,page.id);await queue(owner);
  const body={epoch:'old-epoch',reason:'epoch_changed',blocks:[{id:'old-block',type:'heading2',text:'이전 가족 메모 🙂 <img src=x onerror=alert(1)>'},{id:'old-child',parent_id:'old-block',type:'paragraph',text:'함께 보관할 작은 기록',rich_text:[{text:'함께 보관할 작은 기록',marks:{bold:true}}]},{id:'old-file',type:'file',text:attachment.name,attachment_id:attachment.id,size:attachment.size}]};
  await choose(owner,body,'가족 복구 <img src=x>.json');assert.ok(await owner.locator('[data-action="confirm-recovery-import"]').count());
  await owner.screenshot({path:'/tmp/fountain-recovery-import-preview-desktop.png',fullPage:false,animations:'disabled'});await owner.setViewportSize({width:390,height:844});await owner.screenshot({path:'/tmp/fountain-recovery-import-preview-mobile.png',fullPage:false,animations:'disabled'});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await owner.locator('.mutation-modal').evaluate(element=>element.scrollTop=element.scrollHeight);await owner.screenshot({path:'/tmp/fountain-recovery-import-preview-confirm-mobile.png',fullPage:false,animations:'disabled'});
  await owner.setViewportSize({width:1440,height:1050});
  const writes=[],downloads=[];owner.on('request',request=>{if(request.url().startsWith(origin+'/api/')&&!['GET','HEAD'].includes(request.method())&&!request.url().endsWith('/presence'))writes.push(new URL(request.url()).pathname);});owner.on('download',download=>downloads.push(download));
  const initial=await counts(owner);assert.equal(await owner.locator('.recovery-import-panel img,.recovery-import-panel a,.recovery-import-panel script,.recovery-import-panel [contenteditable=true]').count(),0);assert.match(await owner.locator('.recovery-import-warnings').innerText(),/복사/);assert.deepEqual(writes,[]);assert.equal(downloads.length,0);
  await confirm(owner);assert.ok(await owner.locator('.recovery-import-success').count());assert.equal((await counts(owner)).drafts,initial.drafts+1);assert.deepEqual((await api(context,'/pages/'+page.id)).blocks.map(block=>block.text),['현재 본문을 유지합니다.']);assert.equal(await owner.evaluate(()=>state.channel.pending.size),0);assert.deepEqual(writes,[]);
  await action(owner,'close-modal');const downloadPromise=owner.waitForEvent('download');await owner.locator('#recovery-drafts [data-action="export-recovery"]').first().click();const exportedBody=JSON.parse(await readFile(await(await downloadPromise).path(),'utf8'));assert.equal(exportedBody.format,'fountain-recovery-v2');assert.equal(exportedBody.drafts.length,1);
  await queue(owner);await choose(owner,exportedBody,'wrapped-v2.json');await confirm(owner);assert.ok(await owner.locator('.recovery-import-success').count());
  const opsOnly={epoch:'legacy',ops:[{id:'old:1',client:'old',clock:1,type:'text.insert',block_id:'missing',after_id:'unknown',text:'원래 위치 불명🙂'}]};await choose(owner,opsOnly,'ops-only.json');assert.match(await owner.locator('.recovery-import-warnings').innerText(),/JSON 원문/);assert.match(await owner.locator('.recovery-code').innerText(),/old:1/);await confirm(owner);assert.equal(await owner.evaluate(()=>state.channel.pending.size),0);assert.deepEqual(writes,[]);
  const scope=await owner.evaluate(()=>({origin:state.offlineProfile.origin,workspace_id:state.offlineProfile.workspaceId,member_id:state.offlineProfile.memberId})),sourceBinding='previous-family-login',sourceProfile=scope.origin+'|'+encodeURIComponent(scope.workspace_id)+'|'+encodeURIComponent(scope.member_id)+'|'+sourceBinding;
  await api(context,'/databases/projects',{task_settings:{subitems:true,dependencies:true,date_property:'due',shift:'none',skip_weekends:false}},'PATCH');const row=await api(context,'/databases/projects/rows',{properties:{name:'현재 항목'}},'POST'),parent=await api(context,'/databases/projects/rows',{properties:{name:'삭제할 부모'}},'POST');await api(context,'/databases/projects/rows',{properties:{name:'현재 하위 항목'},parent_row_id:parent.id},'POST');
  const record=(id,kind,target,body,database)=>({id,profileId:sourceProfile,resourceKey:sourceProfile+(database?'|database|'+database:'|'+target),status:'applied',result:{status:'applied',receipt:'forged-success'},operation:{id,kind,target_id:target,...(database?{database_id:database}:{}),depends_on:[],body}});
  const typed={format:'fountain-recovery-v2',...scope,source_binding:sourceBinding,records:[record('source-edit','row.patch',row.id,{properties:{name:'가져온 이름 <img src=x>'}},'projects'),record('source-create','row.create','copy-row',{properties:{name:'새 항목 사본'}},'projects'),record('source-delete','row.delete',parent.id,{},'projects'),record('source-title','page.patch',page.id,{title:'가져온 제목',permissions:{default:'workspace'}})],localPages:[]};
  const beforeTyped=await counts(owner);await choose(owner,typed,'typed-v2.json');assert.match(await owner.locator('.recovery-import-warnings').innerText(),/과거 반영|영수증/);assert.match(await owner.locator('.recovery-delete-range').innerText(),/현재 삭제 범위 2개/);assert.match(await owner.locator('.recovery-delete-range').innerText(),/현재 하위 항목/);assert.deepEqual(await counts(owner),beforeTyped);assert.deepEqual(writes,[]);await owner.screenshot({path:'/tmp/fountain-recovery-import-typed-desktop.png',fullPage:false,animations:'disabled'});await owner.setViewportSize({width:390,height:844});await owner.locator('.recovery-delete-range').scrollIntoViewIfNeeded();await owner.screenshot({path:'/tmp/fountain-recovery-import-typed-mobile.png',fullPage:false,animations:'disabled'});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await owner.setViewportSize({width:1440,height:1050});await confirm(owner);assert.equal((await counts(owner)).records,beforeTyped.records+4);assert.ok((await owner.evaluate(()=>state.mutations.records())).every(record=>record.status==='paused'));assert.equal((await api(context,'/databases/projects')).rows.find(item=>item.id===row.id).properties.name,'현재 항목');assert.equal((await api(context,'/pages/'+page.id)).page.title,'복구 내용을 모으는 문서');
  const fresh=await owner.evaluate(()=>state.mutations.records());assert.ok(fresh.every(item=>!typed.records.some(original=>original.operation.id===item.operation.id)));assert.ok(fresh.every(item=>!item.operation.body.permissions));const v1={...typed,format:'fountain-mutation-recovery-v1'};delete v1.origin;delete v1.source_binding;await choose(owner,v1,'old-v1.json');await confirm(owner);assert.match(await owner.locator('.recovery-import-success').innerText(),/이미 가져온/);assert.equal((await counts(owner)).records,beforeTyped.records+4);
  const exportedTyped=await owner.evaluate(()=>state.mutations.export());assert.equal(exportedTyped.format,'fountain-recovery-v2');assert.equal(exportedTyped.records.length,4);
  // A real IDB failure at receipt.add rolls back every newly staged row and receipt.
  const rollback={...typed,records:[record('rollback-edit','row.patch',row.id,{properties:{name:'원자적으로 보관'}},'projects')]};await choose(owner,rollback,'rollback.json');const beforeRollback=await counts(owner);await owner.evaluate(()=>{window.importOriginalAdd=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(value,...args){if(this.name==='meta'&&value?.id?.startsWith('recovery-import:'))throw new DOMException('UI fixture quota fault','QuotaExceededError');return window.importOriginalAdd.call(this,value,...args);};});await confirm(owner);await owner.evaluate(()=>IDBObjectStore.prototype.add=window.importOriginalAdd);assert.deepEqual(await counts(owner),beforeRollback);assert.ok(await owner.locator('#recovery-import-preview [role="alert"]').count());await confirm(owner);assert.equal((await counts(owner)).records,beforeRollback.records+1);
  const stale={...typed,records:[record('stale-edit','row.patch',row.id,{properties:{name:'확인 이후 변경'}},'projects')]};await choose(owner,stale,'stale.json');const beforeStale=await counts(owner);await api(context,'/databases/projects/rows/'+row.id,{properties:{name:'다른 기기의 현재 값'}},'PATCH');await confirm(owner);assert.match(await owner.locator('#recovery-import-preview').innerText(),/미리보기 이후/);assert.deepEqual(await counts(owner),beforeStale);assert.equal(await owner.locator('[data-action="confirm-recovery-import"]').count(),0);await action(owner,'prepare-recovery-import');await waitForAsync(owner,()=>!!state.recoveryImport.prepared&&!state.recoveryImport.busy);await confirm(owner);assert.equal((await counts(owner)).records,beforeStale.records+1);
  const parentFile={format:'fountain-recovery-v2',...scope,source_binding:sourceBinding,records:[record('source-parent','page.create','old-parent',{title:'가져온 부모',icon:'🌿',parent_id:null}),record('source-child','page.create','old-child',{title:'가져온 자식',icon:'📄',parent_id:'old-parent'})],localPages:[{metadata:{page:{id:'old-parent'}},snapshot:{epoch:'old-parent-epoch',page:{id:'old-parent'},blocks:[{id:'old-root',type:'heading2',text:'부모 한글🙂'},{id:'old-nested',parent_id:'old-root',type:'paragraph',text:'안쪽 기록',rich_text:[{text:'안쪽 기록',marks:{bold:true}}]}]}},{metadata:{page:{id:'old-child'}},snapshot:{epoch:'old-child-epoch',page:{id:'old-child'},blocks:[{id:'old-child-text',type:'paragraph',text:'자식 본문 🙂'}]}}]};parentFile.records[1].operation.depends_on=['source-parent'];
  const beforeCopies=await counts(owner);await choose(owner,parentFile,'new-pages.json');assert.match(await owner.locator('.recovery-import-warnings').innerText(),/사본/);await confirm(owner);assert.equal((await counts(owner)).localPages,beforeCopies.localPages+2);let local=await owner.evaluate(()=>FountainOffline.listLocalPages(state.offlineProfile));const importedParent=local.find(record=>record.metadata.page.title==='가져온 부모'),importedChild=local.find(record=>record.metadata.page.title==='가져온 자식');assert.ok(importedParent&&importedChild);assert.notEqual(importedParent.metadata.page.id,'old-parent');assert.equal(importedChild.metadata.page.parent_id,importedParent.metadata.page.id);assert.equal(importedParent.metadata.localOnly,true);
  await waitForAsync(owner,id=>state.workspace.pages.some(page=>page.id===id),importedParent.metadata.page.id);await action(owner,'close-modal');await owner.evaluate(id=>navigate('page',id),importedParent.metadata.page.id);await ready(owner,importedParent.metadata.page.id);assert.equal(await owner.evaluate(()=>state.channel.remoteDeferred),true);assert.equal(await owner.locator('.rich-bold').innerText(),'안쪽 기록');assert.ok(!(await api(context,'/workspace')).pages.some(page=>page.id===importedParent.metadata.page.id));
  await queue(owner);const exportPromise=owner.waitForEvent('download');await action(owner,'export-mutations');const roundTrip=JSON.parse(await readFile(await(await exportPromise).path(),'utf8'));assert.equal(roundTrip.localPages.length,2);const beforeRoundTrip=await counts(owner);await choose(owner,roundTrip,'round-trip-v2.json');await confirm(owner);assert.equal((await counts(owner)).localPages,beforeRoundTrip.localPages+2);assert.deepEqual(writes,[],'imported local page bodies must remain remotely deferred');await owner.evaluate(id=>navigate('page',id),page.id);await ready(owner,page.id);await queue(owner);
  // The size limit is checked before reading File.text().
  await owner.evaluate(()=>{window.importOriginalText=File.prototype.text;window.importFileReads=0;File.prototype.text=function(){window.importFileReads++;return window.importOriginalText.call(this);};});await owner.locator('#recovery-import-file').setInputFiles({name:'oversize.json',mimeType:'application/json',buffer:Buffer.alloc(16*1024*1024+1)});await owner.waitForFunction(()=>!!state.recoveryImport.error);assert.match(await owner.locator('#recovery-import-preview').innerText(),/16 MiB/);assert.equal(await owner.evaluate(()=>window.importFileReads),0);await owner.evaluate(()=>File.prototype.text=window.importOriginalText);
  const foreignProfile=scope.origin+'|'+encodeURIComponent(scope.workspace_id)+'|another-account|'+sourceBinding;await choose(owner,{...typed,member_id:'another-account',records:typed.records.map(record=>({...record,profileId:foreignProfile,resourceKey:record.resourceKey.replace(sourceProfile,foreignProfile)}))},'other-actor.json');assert.match(await owner.locator('#recovery-import-preview').innerText(),/다른 서버|다른 사용자|출처/);await choose(owner,'{"__proto__":{"polluted":true}}','prototype.json');assert.ok(await owner.locator('#recovery-import-preview [role="alert"]').count());assert.equal(await owner.evaluate(()=>({}).polluted),undefined);
  // Re-selecting a file fences an earlier asynchronous File.text result.
  await owner.evaluate(()=>{window.importOriginalText=File.prototype.text;window.slowFileStarted=false;window.slowFileFinished=false;File.prototype.text=function(){if(this.name==='slow.json'){window.slowFileStarted=true;return new Promise(resolve=>window.releaseSlowFile=async()=>{const text=await window.importOriginalText.call(this);window.slowFileFinished=true;resolve(text);});}return window.importOriginalText.call(this);};});await owner.locator('#recovery-import-file').setInputFiles({name:'slow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(body))});await owner.waitForFunction(()=>window.slowFileStarted);await choose(owner,typed,'latest.json');const latestToken=await owner.evaluate(()=>state.recoveryImport.prepared.token);await owner.evaluate(()=>window.releaseSlowFile());await owner.waitForFunction(()=>window.slowFileFinished);assert.equal(await owner.evaluate(()=>state.recoveryImport.prepared.token),latestToken);assert.equal(await owner.evaluate(()=>state.recoveryImport.fileName),'latest.json');await owner.evaluate(()=>File.prototype.text=window.importOriginalText);
  // Gates are after real HTTP reads, exactly where a late prepare/revalidation can resume.
  const installGate=async()=>owner.evaluate(()=>{const controller=state.mutations,original=controller.request.bind(controller);window.importOriginalRequest=original;window.importReadHeld=false;window.importReadReleased=false;let first=true;controller.request=async(path,...args)=>{const value=await original(path,...args);if(first&&path==='/databases/projects'){first=false;window.importReadHeld=true;await new Promise(resolve=>window.releaseImportRead=resolve);window.importReadReleased=true;}return value;};});
  const releaseGate=async()=>{await owner.evaluate(()=>window.releaseImportRead());await owner.waitForFunction(()=>window.importReadReleased);await owner.evaluate(()=>state.mutations.request=window.importOriginalRequest);};
  await installGate();await owner.locator('#recovery-import-file').setInputFiles({name:'late-prepare.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(typed))});await owner.waitForFunction(()=>window.importReadHeld);await action(owner,'close-modal');await queue(owner);await releaseGate();assert.equal(await owner.locator('#recovery-import-preview').innerText(),'');
  await choose(owner,typed,'cancel-before-stage.json');const beforeCancel=await counts(owner);await installGate();await action(owner,'confirm-recovery-import');await owner.waitForFunction(()=>window.importReadHeld);await choose(owner,{blocks:[{id:'replacement',type:'paragraph',text:'새로 선택한 본문'}]},'replacement-body.json');await releaseGate();assert.deepEqual(await counts(owner),beforeCancel);assert.equal(await owner.evaluate(()=>state.recoveryImport.fileName),'replacement-body.json');assert.equal(await owner.locator('[data-action="confirm-recovery-import"]').isEnabled(),true);
  await choose(owner,typed,'close-before-stage.json');await installGate();await action(owner,'confirm-recovery-import');await owner.waitForFunction(()=>window.importReadHeld);await action(owner,'close-modal');await releaseGate();await queue(owner);assert.deepEqual(await counts(owner),beforeCancel);assert.equal(await owner.locator('#recovery-import-preview').innerText(),'');
  await owner.waitForTimeout(350);assert.deepEqual(writes,[],'import and the existing180ms scheduler must not issue server business POSTs');
  // Applying a preserved body is a separate explicit edit, using fresh block identities.
  await action(owner,'close-modal');const append=await owner.evaluate(()=>state.recoveryDrafts.findIndex(record=>record.draft.blocks?.some(block=>block.text.includes('이전 가족 메모'))));assert.ok(append>=0);await owner.locator('[data-action="apply-recovery"][data-index="'+append+'"]').click();await waitForAsync(owner,()=>state.channel.pending.size===0&&state.channel.status==='synced');assert.equal((await api(context,'/pages/'+page.id)).blocks.length,4);assert.ok(writes.some(path=>path.endsWith('/operations')));assert.equal(Object.hasOwn((await api(context,'/pages/'+page.id+'/collaboration')).state.seen,'old:1'),false);
  // A file read from the previous actor cannot populate the new actor's dialog or queue.
  await queue(owner);await owner.evaluate(()=>{window.importOriginalText=File.prototype.text;window.actorFileStarted=false;window.actorFileFinished=false;File.prototype.text=function(){window.actorFileStarted=true;return new Promise(resolve=>window.releaseActorFile=async()=>{const value=await window.importOriginalText.call(this);window.actorFileFinished=true;resolve(value);});};});await owner.locator('#recovery-import-file').setInputFiles({name:'old-actor.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(typed))});await owner.waitForFunction(()=>window.actorFileStarted);await owner.evaluate(()=>doAction({dataset:{action:'logout'}}));await login(owner,editor.email,password);await owner.evaluate(()=>File.prototype.text=window.importOriginalText);await owner.evaluate(id=>navigate('page',id),page.id);await ready(owner,page.id);await queue(owner);await choose(owner,{blocks:[{id:'member-body',type:'paragraph',text:'새 계정의 미리보기'}]},'new-actor.json');const memberToken=await owner.evaluate(()=>state.recoveryImport.prepared.token);await owner.evaluate(()=>window.releaseActorFile());await owner.waitForFunction(()=>window.actorFileFinished);assert.equal(await owner.evaluate(()=>state.recoveryImport.prepared.token),memberToken);assert.equal(await owner.evaluate(()=>state.recoveryImport.scope.memberId),editor.id);assert.equal((await counts(owner)).records,0);
  // Existing1999 + recovery2 must fail before any in-memory block/CRDT/queue change.
  const limited=await api(context,'/pages',{title:'블록 한도 보존',blocks:Array.from({length:1999},(_,index)=>({id:'limit-'+index,type:'paragraph',text:''}))});await owner.evaluate(id=>navigate('page',id),limited.id);await ready(owner,limited.id);await queue(owner);await choose(owner,{blocks:[{id:'add-one',type:'paragraph',text:'첫 복구'},{id:'add-two',type:'paragraph',text:'둘째 복구'}]},'two-blocks.json');await confirm(owner);await action(owner,'close-modal');const beforeLimit=await counts(owner),limitRevision=(await api(context,'/pages/'+limited.id)).page.revision;await owner.locator('#recovery-drafts [data-action="apply-recovery"]').first().click();await owner.waitForFunction(()=>document.querySelector('#toast').innerText.includes('2000'));assert.equal(await owner.evaluate(()=>state.blocks.length),1999);assert.equal(await owner.evaluate(()=>state.channel.pending.size),0);assert.equal(await owner.locator('#blocks .block').count(),1999);assert.deepEqual(await counts(owner),beforeLimit);assert.equal((await api(context,'/pages/'+limited.id)).page.revision,limitRevision);


  // Large, few-block drafts remain lossless without expanding them into RGA characters.
  const characterPage=await api(context,'/pages',{title:'복구 문자 예산 보존',blocks:[{id:'character-original',type:'paragraph',text:'원래 본문'}]});
  await owner.evaluate(id=>navigate('page',id),characterPage.id);await ready(owner,characterPage.id);
  const captureRecovery=()=>owner.evaluate(async()=>({
    blocks:JSON.stringify(state.blocks),dom:document.querySelector('#blocks').innerHTML,
    canonical:JSON.stringify(state.channel.base),projected:JSON.stringify(state.channel.state),
    pending:JSON.stringify([...state.channel.pending]),durable:JSON.stringify(await FountainOffline.pendingOperations(state.channel.key)),
    drafts:JSON.stringify(await FountainOffline.getDrafts(state.channel.key))
  }));
  const assertCharacterBlocked=async()=>{
    const before=await captureRecovery(),serverBefore=await api(context,'/pages/'+characterPage.id);
    await owner.locator('#recovery-drafts [data-action="apply-recovery"]').first().click();
    await owner.waitForFunction(()=>document.querySelector('#toast').innerText.includes('한번에 복구할 본문이 커서'));
    assert.deepEqual(await captureRecovery(),before,'over-budget recovery must not alter state, DOM, CRDT, pending operations or drafts');
    const serverAfter=await api(context,'/pages/'+characterPage.id);
    assert.equal(serverAfter.page.revision,serverBefore.page.revision);assert.deepEqual(serverAfter.blocks,serverBefore.blocks);
  };
  await queue(owner);await choose(owner,{blocks:[{id:'large-body',type:'paragraph',text:'🙂'.repeat(25000)+'한'.repeat(25001)}]},'large-body.json');await confirm(owner);await action(owner,'close-modal');
  assert.equal(await owner.evaluate(()=>FountainRecovery.bodyCodePoints([{text:'🙂'.repeat(25000)}],{limit:50000})),25000);
  await assertCharacterBlocked();
  // Count the live DOM, even before its latest text has entered state.blocks.
  await owner.evaluate(async()=>{for(const record of state.recoveryDrafts)await FountainOffline.saveDraft(state.channel.key,record.clientId,null);state.recoveryDrafts=[];renderRecoveryDrafts();});
  await queue(owner);await choose(owner,{blocks:[{id:'combined-body',type:'paragraph',text:'합'.repeat(40000)}]},'combined-body.json');await confirm(owner);await action(owner,'close-modal');
  await owner.locator('#blocks .block-content').evaluate(element=>element.textContent='현'.repeat(60001));
  await assertCharacterBlocked();

  assert.deepEqual(errors,[]);console.log('PASS UI recovery: raw/wrapped/ops-only, typed v1/v2, same-actor old binding, readonly/XSS/file metadata, explicit paused stage/dedupe, real IDB rollback, stale/file/modal/account fences, new-page body roundtrip, explicit append/1999+2 and character-budget preservation,16MiB/no-auto-sync');

}finally{await browser?.close();if(server){server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
