/** Local no-cookie expiry renews the server binding without reactivating old edits. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForAsync} from './async-browser.mjs';
const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-local-retention-'));let server,browser;
try{
  const env={...process.env,FOUNTAIN_ACCESS_TOKEN:'',PYTHONUNBUFFERED:'1'};delete env.FOUNTAIN_DATABASE_URL;
  server=spawn(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),['-m','fountain.server','--database','sqlite','--port','0','--data',join(directory,'fixture.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Startup timeout')),15000);const receive=data=>{output+=data;const match=output.match(/Fountain: http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',receive);server.stderr.on('data',receive);server.once('error',reject);});
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[],renewals=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/api/session/renew-local'))renewals.push(request.postDataJSON());});
  await page.goto(origin);await page.waitForSelector('#sidebar .brand');await waitForAsync(page,()=>!!state.mutations);
  assert.equal(renewals.length,0);
  await page.evaluate(()=>navigate('page','welcome'));await page.waitForSelector('.block-content');
  const before=await page.evaluate(()=>structuredClone(state.offlineProfile));
  // Simulate only the persisted 24-hour cache deadline. Real HTTP remains online.
  await page.evaluate(async id=>{
    document.querySelector('.block-content').textContent='로컬 기한이 지나도 직접 복구할 마지막 입력';
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('fountain-offline-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),read=store.get(id);read.onsuccess=()=>store.put({...read.result,validUntil:Date.now()-1});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    await state.channel.deny(401,'기기 보관 기한이 만료되었습니다.');
  },before.id);
  await waitForAsync(page,id=>!!state.mutations&&state.offlineProfile?.id!==id&&state.loaded,before.id);
  assert.equal(renewals.length,1);assert.equal(renewals[0].cache_binding,before.cacheBinding);
  const current=await page.evaluate(()=>structuredClone(state.offlineProfile));assert.equal(current.memberId,before.memberId);assert.notEqual(current.cacheBinding,before.cacheBinding);
  const session=await(await context.request.get(origin+'/api/session')).json();assert.equal(session.cache_binding,current.cacheBinding);assert.equal(session.mode,'local');
  assert.equal((await context.cookies()).some(cookie=>cookie.name==='fountain_session'),false);
  await page.evaluate(()=>openMutationQueue());await page.waitForSelector('[data-action="prepare-archived-recovery"]');
  await page.locator('[data-action="prepare-archived-recovery"]').first().click();await waitForAsync(page,()=>!!state.recoveryImport?.prepared&&!state.recoveryImport.busy);
  assert.match(await page.locator('#recovery-import-preview').textContent(),/로컬 기한이 지나도/);assert.equal((await page.evaluate(()=>state.mutations.records())).length,0);
  assert.deepEqual(errors,[]);console.log('PASS actual local HTTP/Chrome: expired cache source retained, one explicit CAS binding renewal, no cookie/new identity or old-edit replay, current-proof archive preview');
}finally{await browser?.close();if(server&&server.exitCode===null){const ended=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGINT');await ended;}await rm(directory,{recursive:true,force:true});}
