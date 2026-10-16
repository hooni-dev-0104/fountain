/** Actual session loss -> same-account archive preview -> explicit paused recovery. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForAsync} from './async-browser.mjs';
const root=process.env.FOUNTAIN_TEST_ROOT||fileURLToPath(new URL('..',import.meta.url));
const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-auth-retention-'));
let server,browser,origin,stage='startup';
try{
  const env={...process.env,PYTHONUNBUFFERED:'1'};delete env.FOUNTAIN_ACCESS_TOKEN;delete env.FOUNTAIN_DATABASE_URL;
  server=spawn(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),['-m','fountain.server','--port','0','--database','sqlite','--data',join(directory,'fixture.db')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  origin=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('Disposable server startup timed out')),15000);const receive=data=>{output+=data;const match=output.match(/Fountain: http:\/\/localhost:(\d+)/);if(match){clearTimeout(timeout);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',receive);server.stderr.on('data',receive);server.once('error',reject);});
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  async function api(path,body,method=body?'POST':'GET'){
    const response=await context.request.fetch(origin+'/api'+path,{method,headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});assert.ok(response.ok(),path+' '+response.status());return response.json();
  }
  const owner=(await api('/accounts')).accounts.find(value=>value.role==='owner'),password='Auth-retention-isolated-2026';
  await api('/accounts',{member_id:owner.id,password});
  const other=await api('/members',{name:'다른 가족 계정',email:'retention-other@example.local',role:'member'});await api('/accounts',{member_id:other.id,password});await api('/accounts/enable',{});
  await page.goto(origin);
  async function login(email=owner.email){await page.locator('#login-form [name=email]').fill(email);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form .solid-btn').click();await page.waitForSelector('#sidebar .brand');await waitForAsync(page,()=>!!state.mutations);}
  await login();
  const document=await api('/pages',{title:'로그인 만료 전 문서',blocks:[{id:'text',type:'paragraph',text:'서버 원문'}]});
  const row=await api('/databases/projects/rows',{properties:{name:'서버 항목'}});
  await page.evaluate(async id=>{await state.mutations.loadDatabase('projects');await navigate('page',id);},document.id);
  await page.waitForSelector('.block-content');await context.setOffline(true);
  await page.locator('.block-content').first().fill('다시 로그인해도 남아야 할 본문 🏠');
  await page.evaluate(async id=>{await state.channel.persistence;await state.mutations.patchRow('projects',id,{properties:{name:'로그인 전 기기에 보관한 항목'}});},row.id);
  const profile=await page.evaluate(()=>structuredClone(state.offlineProfile));
  async function sourceCounts(){return page.evaluate(async id=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('fountain-offline-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['operations','drafts','mutations'],'readonly'),counts={};for(const name of ['operations','drafts','mutations']){const request=tx.objectStore(name).index('profileId').count(id);request.onsuccess=()=>counts[name]=request.result;}tx.oncomplete=()=>resolve(counts);tx.onerror=()=>reject(tx.error);});}finally{db.close();}},profile.id);}
  const before=await sourceCounts();assert.ok(before.operations>0&&before.mutations>0);
  await page.locator('#page-title').fill('아직 자동 저장 전인 마지막 제목 🏠');
  await page.evaluate(()=>document.querySelector('.block-content').textContent+=' · 아직 저장 전인 마지막 글자');
  // Revoke on the server while the browser is offline, without invoking app logout.
  await api('/session',{},'DELETE');
  stage='authoritative passive 401 hides private UI but retains original unsent records';
  await context.setOffline(false);await page.waitForSelector('#login-form');
  await waitForAsync(page,async()=>await FountainOffline.getProfile()===null);
  const after=await sourceCounts();assert.ok(after.operations>=before.operations&&after.drafts>=before.drafts&&after.mutations>=before.mutations,JSON.stringify({before,after}));
  assert.equal(await page.locator('.block-content').count(),0);assert.equal(await page.locator('#sidebar').textContent(),'');
  stage='another authenticated family member cannot see the retained archive';
  await login(other.email);await page.evaluate(()=>openMutationQueue());await waitForAsync(page,()=>!!state.recoveryImport&&!state.recoveryImport.archivesBusy);
  assert.equal(await page.locator('[data-action="prepare-archived-recovery"],[data-action="prepare-memory-recovery"]').count(),0);assert.doesNotMatch(await page.locator('#main').textContent(),/다시 로그인해도 남아야|마지막 제목|마지막 글자/);
  await api('/session',{email:owner.email,password});await page.reload();await page.waitForSelector('#sidebar .brand');await waitForAsync(page,()=>!!state.mutations&&state.offlineProfile.memberId===state.session.member.id);
  stage='same account new binding does not replay and exposes an explicit archive choice';
  assert.notEqual(await page.evaluate(()=>state.offlineProfile.id),profile.id);
  assert.equal((await api('/pages/'+document.id)).page.blocks[0].text,'서버 원문');
  assert.equal((await api('/databases/projects')).rows.find(value=>value.id===row.id).properties.name,'서버 항목');
  await page.evaluate(()=>openMutationQueue());await page.waitForSelector('[data-action="prepare-archived-recovery"]');
  assert.equal(await page.locator('#recovery-import-preview').textContent(),'');
  await page.locator('[data-action="prepare-archived-recovery"]').first().click();
  await waitForAsync(page,()=>!!state.recoveryImport?.prepared&&!state.recoveryImport.busy);
  assert.match(await page.locator('#recovery-import-preview').textContent(),/再|다시 로그인해도|로그인 전/);
  assert.match(await page.locator('#recovery-import-preview').textContent(),/마지막 제목/);assert.match(await page.locator('#recovery-import-preview').textContent(),/마지막 글자/);
  assert.equal((await api('/pages/'+document.id)).page.blocks[0].text,'서버 원문');
  await page.locator('[data-action="confirm-recovery-import"]').click();
  await waitForAsync(page,()=>!!state.recoveryImport?.result&&!state.recoveryImport.staging);
  const records=await page.evaluate(()=>state.mutations.records());assert.ok(records.length&&records.every(value=>value.status==='paused'));assert.ok(records.some(value=>value.operation.body.title==='아직 자동 저장 전인 마지막 제목 🏠'));
  assert.equal((await api('/databases/projects')).rows.find(value=>value.id===row.id).properties.name,'서버 항목');
  stage='invalid oversized DOM input cannot prevent an authoritative authentication fence';
  await page.evaluate(()=>closeModal());await context.setOffline(true);await api('/session',{},'DELETE');
  const raw='정규화 범위를 넘은 마지막 입력 🏠'+ '가'.repeat(100001)+' 끝까지 보존';
  const oversizedProfile=await page.evaluate(()=>state.offlineProfile.id);
  // Fix the boundary after real server revocation so another response cannot repaint the DOM first.
  await page.evaluate(async text=>{document.querySelector('.block-content').textContent=text;await state.channel.deny(401,'세션이 만료되었습니다.');},raw);
  await page.waitForSelector('#login-form');assert.equal(await page.locator('.block-content').count(),0);assert.equal(await page.evaluate(()=>state.loaded),false);
  assert.match(await page.locator('#login-error').textContent(),/원문 조각|저장하지 못|다시 확인/);
  const preservedRaw=await page.evaluate(async id=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('fountain-offline-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{return await new Promise((resolve,reject)=>{const request=db.transaction('drafts','readonly').objectStore('drafts').index('profileId').getAll(id);request.onsuccess=()=>resolve(request.result.find(row=>row.draft.reason==='auth_suspended'&&row.draft.blocks?.[0]?.text.startsWith('정규화 범위를 넘은'))?.draft.blocks.map(block=>block.text).join(''));request.onerror=()=>reject(request.error);});}finally{db.close();}},oversizedProfile);
  assert.equal(preservedRaw,raw);await context.setOffline(false);await login();
  stage='explicit actor logout still removes all retained bindings';
  await page.evaluate(()=>closeModal());await page.evaluate(()=>doAction({dataset:{action:'logout'}}));await page.waitForSelector('#login-form');
  assert.deepEqual(await sourceCounts(),{operations:0,drafts:0,mutations:0});assert.deepEqual(errors,[]);
  console.log('PASS actual Chrome/SQLite HTTP: passive401 retains unsent input without private UI; same-account new binding exposes explicit current-proof preview/paused import, no automatic replay; explicit logout erases actor archives');
}catch(error){console.error('FAIL stage:',stage);throw error;}
finally{await browser?.close();if(server&&server.exitCode===null){const ended=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGINT');await ended;}await rm(directory,{recursive:true,force:true});}
