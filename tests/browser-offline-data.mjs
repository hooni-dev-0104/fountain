/** Real service-worker reload, durable entity edits, merge/conflict recovery and deferred pages. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-offline-data-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin,page,context;
const errors=[],notFound=[],syncTrace=[];
async function startServer(){
  const env={...process.env};delete env.FOUNTAIN_ACCESS_TOKEN;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error(output)),15000);const receive=chunk=>{output+=chunk.toString();const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',receive);server.stderr.on('data',receive);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(new Error(`server ${code}: ${output}`));});});
}
async function api(actor,path,body,method){const response=await actor.request.fetch(origin+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});assert.ok(response.ok(),`${path}: ${response.status()} ${await response.text()}`);return response.json();}
async function action(name,extra=''){await page.locator(`[data-action="${name}"]${extra}`).first().click();}
async function rowForm(id){await action('edit-row',`[data-id="${id}"]`);await page.waitForSelector('#row-form');}
async function saveRow(){await page.locator('#row-form .solid-btn').click();await page.waitForSelector('#row-form',{state:'detached'});}
async function navigateDatabase(id){await page.evaluate(id=>navigate('database',id),id);await page.waitForSelector('#db-view');}
async function createPage(title,parent){await action('add-page',parent?`[data-parent="${parent}"]`:'');await page.locator('#page-form [name=title]').fill(title);await page.locator('#page-form .solid-btn').click();await page.waitForFunction(title=>document.querySelector('#page-title')?.textContent===title,title);return page.evaluate(()=>state.page.id);}
// The bundled browser's waitForFunction can accept an unresolved Promise as truthy.
// Resolve asynchronous checks in Node so no API assertion runs before readiness.
async function waitForAsync(predicate,argument,timeout=20000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await page.evaluate(predicate,argument))return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('브라우저 비동기 조건이 제한 시간 안에 충족되지 않았습니다: '+predicate.toString());
}
async function discardMutation(id){
  await action('sync-queue');await action('drop-mutation',`[data-id="${id}"]`);await action('confirm-drop-mutation',`[data-id="${id}"]`);await page.waitForSelector('#mutation-queue-list');await page.keyboard.press('Escape');await waitQueueEmpty();
}
async function conflictRecord(kind,target){await waitForAsync(async({kind,target})=>(await state.mutations.records()).some(record=>record.status==='conflict'&&record.operation.kind===kind&&record.operation.target_id===target),{kind,target});return page.evaluate(async({kind,target})=>(await state.mutations.records()).find(record=>record.status==='conflict'&&record.operation.kind===kind&&record.operation.target_id===target),{kind,target});}
async function waitQueueEmpty(){await waitForAsync(async()=>state.mutations&&(await state.mutations.records()).length===0);}
try{
  origin=await startServer();
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
  const owner=await browser.newContext(),remote=await browser.newContext();
  const password='Offline-family-data-password-2026';
  const ownerMember=(await api(owner,'/accounts')).accounts.find(item=>item.role==='owner');
  await api(owner,'/accounts',{member_id:ownerMember.id,password});
  const member=await api(owner,'/members',{name:'기기에서 쓰는 가족',email:'offline-data@example.local',role:'member'});
  await api(owner,'/accounts',{member_id:member.id,password});await api(owner,'/accounts/enable',{});
  await api(owner,'/session',{email:ownerMember.email,password});
  await api(remote,'/session',{email:member.email,password});
  const database=await api(owner,'/databases',{name:'가족 오프라인 프로젝트',properties:[{id:'name',name:'이름',type:'title'},{id:'status',name:'상태',type:'status',options:['시작 전','진행 중','완료']},{id:'estimate',name:'예상 시간',type:'number'},{id:'checked',name:'확인',type:'checkbox'},{id:'tags',name:'태그',type:'multi_select',options:['가족','주말']},{id:'due',name:'일정',type:'date'},{id:'double',name:'시간 두 배',type:'formula',expression:"prop('estimate') * 2"}],task_settings:{subitems:true,dependencies:true,date_property:'due',shift:'none',skip_weekends:false}});
  const db=database.id;
  const mixed=await api(owner,`/databases/${db}/rows`,{properties:{name:'독립 필드 병합',status:'시작 전',estimate:2,checked:false,tags:[],due:'2026-11-01'}});
  const baselineRow=await api(owner,`/databases/${db}/rows`,{properties:{name:'열린 폼 충돌 검증',estimate:2}});
  const conflict=await api(owner,`/databases/${db}/rows`,{properties:{name:'충돌 전 이름',status:'시작 전',estimate:1}});
  const parentRow=await api(owner,`/databases/${db}/rows`,{properties:{name:'삭제할 상위',estimate:1}});
  const childRow=await api(owner,`/databases/${db}/rows`,{properties:{name:'삭제할 하위',estimate:1},parent_row_id:parentRow.id});
  context=await browser.newContext({viewport:{width:1440,height:1000}});
  page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  page.on('response',async response=>{if(response.url().endsWith('/api/sync')){const trace={sent:response.request().postDataJSON().operations};syncTrace.push(trace);try{trace.result=await response.json();}catch{trace.responseUnavailable=true;}}if(response.status()===404&&response.url().includes('/api/pages/'))notFound.push(response.url());});
  await page.goto(origin);await page.locator('#login-form [name=email]').fill(member.email);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form .solid-btn').click();await page.waitForSelector('.recent-grid');
  await navigateDatabase(db);
  await waitForAsync(async()=>!!(await FountainOffline.getDatabase(FountainOffline.databaseKey(state.offlineProfile,state.database.id))));
  await page.evaluate(async()=>{await FountainOffline.serviceWorkerReady;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await context.setOffline(true);await page.waitForFunction(()=>state.offline);
  await rowForm(mixed.id);await page.locator('#row-form [name=estimate]').fill('7');await page.locator('#row-form [name=checked]').check();await page.locator('#row-form [name=tags]').fill('가족, 주말');await page.locator('#row-form [name=due]').fill('2026-11-02');await page.locator('#row-form [name=due__end]').fill('2026-11-05');await saveRow();
  await rowForm(conflict.id);await page.locator('#row-form [name=name]').fill('기기의 충돌 이름');await saveRow();
  await rowForm(parentRow.id);await action('delete-row',`[data-id="${parentRow.id}"]`);await action('confirm-delete-row',`[data-id="${parentRow.id}"]`);await page.waitForSelector('#row-form',{state:'detached'});
  await action('add-row');await page.locator('#row-form [name=name]').fill('연결 없이 만든 항목');await page.locator('#row-form [name=estimate]').fill('3');await page.locator('#row-form [name=checked]').check();await page.locator('#row-form [name=tags]').fill('가족');await saveRow();
  await page.waitForFunction(()=>state.rows.some(row=>row.properties.name==='연결 없이 만든 항목'));
  assert.equal(await page.evaluate(id=>state.rows.some(row=>row.id===id),childRow.id),false);
  // A server that has never seen these UUIDs must not receive premature page GETs.
  const parentPage=await createPage('기기에서 만든 상위 문서');
  await page.locator('.block-content').first().fill('상위 문서의 오프라인 본문');
  await page.locator('#page-title').fill('제목도 기기에 보관한 상위');
  await page.waitForTimeout(650);await action('favorite');await action('toggle-cover');await action('change-icon');await page.locator('#icon-form [name=icon]').fill('🌻');await page.locator('#icon-form .solid-btn').click();await page.waitForSelector('#icon-form',{state:'detached'});
  const childPage=await createPage('하위 문서도 기기에서',parentPage);
  await page.locator('.block-content').first().fill('하위 문서의 오프라인 본문');
  await page.waitForFunction(()=>state.channel.pending.size>0);
  await page.reload();await page.waitForSelector('#page-title');
  assert.equal(await page.locator('#page-title').innerText(),'하위 문서도 기기에서');
  assert.equal(await page.locator('.block-content').first().innerText(),'하위 문서의 오프라인 본문');
  assert.equal(await page.evaluate(()=>state.channel.remoteDeferred),true);
  await navigateDatabase(db);
  const cachedRows=await page.evaluate(()=>state.rows);
  const localMixed=cachedRows.find(row=>row.id===mixed.id);
  assert.equal(localMixed.properties.estimate,7);assert.equal(localMixed.properties.checked,true);assert.deepEqual(localMixed.properties.tags,['가족','주말']);assert.deepEqual(localMixed.properties.due,{start:'2026-11-02',end:'2026-11-05'});
  assert.ok(cachedRows.some(row=>row.properties.name==='연결 없이 만든 항목'));
  await mkdir('/tmp/fountain-browser',{recursive:true});
  await page.screenshot({path:'/tmp/fountain-browser/offline-data-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:'/tmp/fountain-browser/offline-data-mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1000});
  await api(remote,`/databases/${db}/rows/${mixed.id}`,{properties:{status:'진행 중'}},'PATCH');
  await api(remote,`/databases/${db}/rows/${conflict.id}`,{properties:{name:'다른 기기의 충돌 이름'}},'PATCH');
  await context.setOffline(false);await page.waitForFunction(()=>!state.offline);
  await waitForAsync(async()=>state.mutations&&(await state.mutations.records()).some(record=>record.status==='conflict'));
  await waitForAsync(async()=>{const response=await FountainTransport.request('/api/databases/'+state.database.id);const data=await response.json();return data.rows.some(row=>row.properties.name==='연결 없이 만든 항목');});
  let canonical=await api(remote,`/databases/${db}`);
  assert.equal(canonical.rows.find(row=>row.id===mixed.id).properties.estimate,7,JSON.stringify({syncTrace,records:await page.evaluate(()=>state.mutations.records())}));assert.equal(canonical.rows.find(row=>row.id===mixed.id).properties.status,'진행 중');assert.equal(canonical.rows.some(row=>[parentRow.id,childRow.id].includes(row.id)),false);
  if(process.env.FOUNTAIN_OFFLINE_DATA_FOCUS==='1'){
    const row=canonical.rows.find(row=>row.id===mixed.id);assert.equal(row.properties.checked,true);assert.deepEqual(row.properties.tags,['가족','주말']);assert.deepEqual(row.properties.due,{start:'2026-11-02',end:'2026-11-05'});assert.deepEqual(errors,[]);
    console.log('PASS focused reconnect: offline typed CRUD and restart → independent-field remote edit → estimate2to7+other fields merged, subtree deleted, new row persisted, same-field conflict preserved');
  }else{
  await action('sync-queue');await page.waitForSelector('.mutation-card[data-mutation-status=conflict]');
  const exportEvent=page.waitForEvent('download');await page.locator('.mutation-card[data-mutation-status=conflict] [data-action=export-mutation]').click();
  const exported=await exportEvent;assert.ok((await readFile(await exported.path(),'utf8')).includes('기기의 충돌 이름'));
  await page.screenshot({path:'/tmp/fountain-browser/offline-data-conflict.png',fullPage:true});
  await page.locator('.mutation-card[data-mutation-status=conflict] [data-action=reapply-mutation]').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('현재 서버 값을 기준으로 다시 적용했습니다.'));
  await waitForAsync(async()=>!(await state.mutations.records()).some(record=>record.status==='conflict'));
  await page.keyboard.press('Escape');await waitQueueEmpty();
  canonical=await api(remote,`/databases/${db}`);assert.equal(canonical.rows.find(row=>row.id===conflict.id).properties.name,'기기의 충돌 이름',JSON.stringify(syncTrace));
  await waitForAsync(async id=>{const data=await(await FountainTransport.request('/api/pages/'+id)).json();return data.blocks?.some(block=>block.text==='상위 문서의 오프라인 본문');},parentPage);
  await waitForAsync(async id=>{const data=await(await FountainTransport.request('/api/pages/'+id)).json();return data.blocks?.some(block=>block.text==='하위 문서의 오프라인 본문');},childPage);
  await page.evaluate(id=>navigate('page',id),parentPage);await page.waitForSelector('#page-title');
  await page.waitForFunction(()=>!state.channel.remoteDeferred&&state.channel.pending.size===0);
  const savedParent=await api(remote,'/pages/'+parentPage);assert.equal(savedParent.page.title,'제목도 기기에 보관한 상위');assert.equal(savedParent.page.icon,'🌻');assert.equal(savedParent.page.favorite,true);assert.ok(savedParent.page.cover);assert.ok(savedParent.blocks.some(block=>block.text==='상위 문서의 오프라인 본문'));
  await page.evaluate(id=>navigate('page',id),childPage);await page.waitForFunction(()=>!state.channel.remoteDeferred&&state.channel.pending.size===0);
  const savedChild=await api(remote,'/pages/'+childPage);assert.equal(savedChild.page.parent_id,parentPage);assert.ok(savedChild.blocks.some(block=>block.text==='하위 문서의 오프라인 본문'));
  assert.deepEqual(notFound,[],'local pages must not be fetched before their create receipt');
  // The displayed form's original values and schema remain the conflict basis.
  await navigateDatabase(db);await rowForm(baselineRow.id);
  assert.equal(await page.locator('#row-form [name=estimate]').inputValue(),'2');
  await api(remote,`/databases/${db}/rows/${baselineRow.id}`,{properties:{estimate:8}},'PATCH');
  await page.evaluate(id=>state.mutations.loadDatabase(id),db);
  assert.equal(await page.locator('#row-form [name=estimate]').inputValue(),'2');
  await page.locator('#row-form [name=estimate]').fill('7');await saveRow();
  let paused=await conflictRecord('row.patch',baselineRow.id);
  assert.equal((await api(remote,`/databases/${db}`)).rows.find(row=>row.id===baselineRow.id).properties.estimate,8);
  assert.equal(paused.operation.base.properties.estimate,2);await discardMutation(paused.id);
  await rowForm(baselineRow.id);
  const typedSchema=(await api(remote,`/databases/${db}`)).database.properties;
  const retyped=typedSchema.map(property=>property.id==='estimate'?{...property,type:'text'}:property);
  await api(owner,`/databases/${db}`,{properties:retyped},'PATCH');await page.evaluate(id=>state.mutations.loadDatabase(id),db);
  assert.equal(await page.locator('#row-form [name=estimate]').getAttribute('type'),'number');
  await page.locator('#row-form [name=estimate]').fill('9');await saveRow();
  paused=await conflictRecord('row.patch',baselineRow.id);assert.equal(paused.operation.base.schema.estimate.type,'number');
  assert.equal((await api(remote,`/databases/${db}`)).rows.find(row=>row.id===baselineRow.id).properties.estimate,8);await discardMutation(paused.id);
  await api(owner,`/databases/${db}`,{properties:typedSchema},'PATCH');await navigateDatabase(db);
  await action('add-row');await page.locator('#row-form [name=name]').fill('속성 변경 중 새 항목');
  await api(owner,`/databases/${db}`,{properties:retyped},'PATCH');await page.evaluate(id=>state.mutations.loadDatabase(id),db);
  await page.locator('#row-form [name=estimate]').fill('4');await saveRow();
  await waitForAsync(async()=>(await state.mutations.records()).some(record=>record.status==='conflict'&&record.operation.kind==='row.create'));
  paused=await page.evaluate(async()=>(await state.mutations.records()).find(record=>record.status==='conflict'&&record.operation.kind==='row.create'));
  assert.equal(paused.operation.base.schema.estimate.type,'number');assert.equal((await api(remote,`/databases/${db}`)).rows.some(row=>row.properties.name==='속성 변경 중 새 항목'),false);await discardMutation(paused.id);
  await api(owner,`/databases/${db}`,{properties:typedSchema},'PATCH');
  // A title typed before an SSE update must not silently accept that unseen value as its base.
  await page.evaluate(id=>navigate('page',id),parentPage);await page.locator('#page-title').fill('기기에서 편집 중인 제목');
  await page.evaluate(()=>clearTimeout(state.titleTimer));
  await api(remote,'/pages/'+parentPage,{title:'서버에서 먼저 고친 제목'},'PATCH');
  await page.waitForFunction(()=>state.channel.base.page.title==='서버에서 먼저 고친 제목');
  assert.equal(await page.locator('#page-title').innerText(),'기기에서 편집 중인 제목');
  await page.evaluate(()=>saveTitle());paused=await conflictRecord('page.patch',parentPage);
  assert.equal(paused.operation.base.fields.title,'제목도 기기에 보관한 상위');
  assert.equal((await api(remote,'/pages/'+parentPage)).page.title,'서버에서 먼저 고친 제목');await discardMutation(paused.id);
  // Explicit discard includes dependent local pages and their durable text queues.
  await context.setOffline(true);await page.waitForFunction(()=>state.offline);
  const discardedParent=await createPage('폐기할 기기 문서');await page.locator('.block-content').first().fill('명시적으로 폐기할 본문');
  const discardedChild=await createPage('폐기할 기기 하위 문서',discardedParent);await page.locator('.block-content').first().fill('함께 폐기할 하위 본문');await page.evaluate(()=>state.channel.persistence);
  const creation=await page.evaluate(async id=>(await state.mutations.records()).find(record=>record.operation.kind==='page.create'&&record.operation.target_id===id),discardedParent);
  await discardMutation(creation.id);
  assert.equal(await page.evaluate(()=>state.route),'home');
  for(const id of [discardedParent,discardedChild])assert.equal(await page.evaluate(id=>FountainOffline.getLocalPage(FountainOffline.key(state.offlineProfile,id)),id),null);
  await context.setOffline(false);await page.waitForFunction(()=>!state.offline);await waitQueueEmpty();
  // A canonical read denial cannot silently fall back to the previously cached table.
  await api(owner,`/databases/${db}/permissions`,{permissions:{default:'private',inherit:false,members:{[member.id]:'none'},groups:{}}},'PATCH');
  await page.evaluate(id=>navigate('database',id),db);
  await waitForAsync(async id=>!(await FountainOffline.getDatabase(FountainOffline.databaseKey(state.offlineProfile,id))),db);
  assert.equal(await page.evaluate(id=>state.route==='database'&&state.database?.id===id&&!!document.querySelector('#db-view'),db),false);
  // Explicit logout clears this binding's entity queue and cached documents.
  await context.setOffline(true);await page.waitForFunction(()=>state.offline);await action('logout');
  await page.waitForSelector('#login-form');await waitForAsync(async()=>await FountainOffline.getProfile()===null);
  await context.setOffline(false);await page.reload();await page.waitForSelector('#login-form');
  assert.deepEqual(errors,[]);
  console.log('PASS: cached DB offline typed CRUD/subitem deletion+reload, independent-field merge, conflict export/reapply, open-form value/schema/title basis, dependent draft discard, deferred parent/child page metadata+CRDT bodies, no premature404, canonical read revocation and logout isolation');
  console.log('Screenshots: /tmp/fountain-browser/offline-data-{desktop,mobile,conflict}.png');
  }
}finally{await browser?.close();server?.kill('SIGTERM');await rm(directory,{recursive:true,force:true});}
