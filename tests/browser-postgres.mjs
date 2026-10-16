/** Explicitly opted-in, isolated Chrome verification over two real PostgreSQL servers. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { waitForAsync } from './async-browser.mjs';

const configuration = process.env.FOUNTAIN_TEST_POSTGRES_CONFIG;
if (!configuration) {
  console.log('SKIP: real PostgreSQL Chrome verification requires explicit FOUNTAIN_TEST_POSTGRES_CONFIG');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(configuration);
const python = process.env.FOUNTAIN_PYTHON || join(root, '.data/supabase-venv/bin/python');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const namespace = randomUUID().replaceAll('-', '');
assert.match(namespace, /^[a-f0-9]{32}$/);
const servers = [], errors = [], uploadResponses = [];
const uploadOnly = process.env.FOUNTAIN_POSTGRES_UPLOAD_ONLY === '1';
const diagnosticUpload = uploadOnly && process.env.FOUNTAIN_POSTGRES_DIAGNOSTIC === '1';
const fileRoot = process.env.FOUNTAIN_TEST_POSTGRES_FILES === '1'
  ? await mkdtemp(join(await realpath(tmpdir()), 'fountain-postgres-files-')) : null;
let browser, completed = false;

async function startServer() {
  const env = { ...process.env };
  delete env.FOUNTAIN_ACCESS_TOKEN;
  delete env.FOUNTAIN_DATABASE_URL;
  const child = spawn(python, ['-m', 'fountain.server', '--port', '0', '--database', 'postgres', '--database-config', configPath, '--workspace-id', namespace,
    ...(fileRoot ? ['--attachment-root', fileRoot] : [])], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  return new Promise((accept, reject) => {
    // Never echo connection configuration or raw driver/server stderr.
    const timer = setTimeout(() => reject(new Error('PostgreSQL test server startup timed out')), 30000);
    let output = '';
    child.stdout.on('data', bytes => {
      output = (output + bytes.toString()).slice(-2000);
      const match = output.match(/Fountain: https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (match) { clearTimeout(timer); accept('http://127.0.0.1:' + match[1]); }
    });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Unable to launch the PostgreSQL test server')); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('PostgreSQL test server exited before readiness: ' + code)); });
  });
}
async function stopServer(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  const stopped = new Promise(accept => child.once('exit', accept));
  child.kill('SIGINT');
  try { await Promise.race([stopped, new Promise(accept => { timer = setTimeout(accept, 5000); })]); }
  finally { clearTimeout(timer); }
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await stopped; }
}
async function cleanupNamespace() {
  // The helper opens no Application and cannot seed or inspect another workspace.
  // Its only mutations have an exact, generated namespace parameter.
  const program = `import json,re,sys
from fountain.postgres import PostgresStore
store=None
try:
    namespace=sys.argv[2]
    assert re.fullmatch(r"[a-f0-9]{32}",namespace)
    with open(sys.argv[1],"rb") as source:
        configuration=json.load(source)
    store=PostgresStore(configuration["database_dsn"],workspace_id=namespace,attachment_root=sys.argv[3] or None)
    with store.transaction():
        if sys.argv[3] and sys.argv[4]=="true":
            assert store._execute("SELECT COUNT(*) FROM fountain_private.attachment_chunks WHERE workspace_id=%s",(namespace,),fetch="one")[0]==0
            assert len(store.list("attachment_chunk"))>0
        for table in ("attachment_chunks","entities","meta"):
            store._execute("DELETE FROM fountain_private."+table+" WHERE workspace_id=%s",(namespace,))
        for table in ("attachment_chunks","entities","meta"):
            assert store._execute("SELECT COUNT(*) FROM fountain_private."+table+" WHERE workspace_id=%s",(namespace,),fetch="one")[0]==0
except BaseException:
    print("Unable to remove the isolated PostgreSQL browser-test namespace",file=sys.stderr)
    sys.exit(1)
finally:
    if store is not None: store.close()
`;
  const child = spawn(python, ['-c', program, configPath, namespace, fileRoot || '', String(completed)], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  const code = await new Promise((accept, reject) => {
    child.once('error', () => reject(new Error('Unable to start isolated PostgreSQL test cleanup')));
    child.once('exit', accept);
  });
  assert.equal(code, 0, 'Only the generated PostgreSQL test namespace must be removed after both servers stop');
  if (fileRoot) await rm(fileRoot, { recursive: true, force: true });
}
async function api(context, origin, path, body, method) {
  const response = await context.request.fetch(origin + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'), headers: { 'X-Fountain-Request': '1' }, ...(body ? { data: body } : {}),
  });
  assert.ok(response.ok(), `PostgreSQL HTTP ${path}: ${response.status()}`);
  return response.json();
}
async function openPage(context, origin, owner, password, pageId) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#page/' + pageId);
  await page.locator('#login-form [name=email]').fill(owner.email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('.block-content[contenteditable=true]');
  return page;
}
const wait = (page, predicate, argument) => waitForAsync(page, predicate, argument, { timeout: 30000 });
async function evaluate(page, predicate, argument) {
  let timer;
  try { return await Promise.race([page.evaluate(predicate, argument), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PostgreSQL browser evaluation did not finish within 30 seconds')), 30000); })]); }
  finally { clearTimeout(timer); }
}
async function instrumentUpload(page) {
  await evaluate(page,()=>{
    const events=[],start=performance.now(),channel=state.channel,originalApi=api,originalReconcile=channel.reconcile;
    const log=(stage,fields={})=>events.push({stage,ms:Math.round(performance.now()-start),...fields});
    globalThis.__postgresUploadTrace={events,originalApi,originalReconcile,channel};
    globalThis.api=async function(path,...arguments_){log('api-start',{path});try{const result=await originalApi(path,...arguments_);log('api-end',{path,status:'ok'});return result;}catch(error){log('api-error',{path,status:error.status||null});throw error;}};
    channel.reconcile=function(blocks){
      log('reconcile-start',{pending:this.pending.size,hasFile:blocks.some(block=>block.type==='file')});
      try{const result=originalReconcile.call(this,blocks);log('reconcile-end',{pending:this.pending.size,optimisticFile:state.blocks.some(block=>block.type==='file'),canonicalFile:this.base.blocks.some(block=>block.type==='file')});this.persistence.then(()=>log('persistence-resolved',{pending:this.pending.size}),()=>log('persistence-rejected'));return result;}
      catch(error){log('reconcile-error',{status:error.status||null});throw error;}
    };
    channel.persistence.then(()=>log('initial-persistence-resolved'),()=>log('initial-persistence-rejected'));
  });
}
async function probeAttachment(page,context,origin){
  await wait(page,()=>state.uploadManager?.view().some(job=>['attaching','done','error','denied'].includes(job.status)));
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await evaluate(page,()=>state.uploadManager?.view().some(job=>job.status==='done')))return {alreadyDone:true};await new Promise(accept=>setTimeout(accept,100));}
  const probes=await Promise.allSettled([
    (async()=>{const start=Date.now();const response=await context.request.get(origin+'/api/session',{timeout:10000,headers:{'X-Fountain-Request':'1'}});const result={status:response.status(),elapsedMs:Date.now()-start};await response.dispose();return result;})(),
    evaluate(page,async()=>{const abort=new AbortController(),start=performance.now(),timer=setTimeout(()=>abort.abort(),10000);try{const response=await FountainTransport.request('/api/session',{signal:abort.signal});await response.arrayBuffer();return {status:response.status,elapsedMs:Math.round(performance.now()-start)};}catch(error){return {failed:error.name,elapsedMs:Math.round(performance.now()-start)};}finally{clearTimeout(timer);}})
  ]);
  const result=probes.map((probe,index)=>({kind:index?'browser-fetch':'independent-request',...(probe.status==='fulfilled'?probe.value:{failed:probe.reason?.name||'Error'})}));
  console.error('PostgreSQL attaching socket probes: '+JSON.stringify(result));return result;
}
async function uploadPhase(records,startIndex,label,predicate){
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const record=records.slice(startIndex).find(value=>predicate(value)&&(value.status!==null||value.failed));
    if(record){assert.ok(!record.failed&&record.status>=200&&record.status<300,'PostgreSQL upload '+label+' failed');console.log('PostgreSQL upload phase: '+label+' '+(record.finishedMs-record.startedMs)+' ms');return record;}
    await new Promise(accept=>setTimeout(accept,25));
  }
  throw new Error('PostgreSQL upload '+label+' did not finish within its 30-second HTTP phase budget');
}
async function append(page, text) {
  const editor = page.locator('.block-content').first();
  await editor.focus();
  await editor.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.insertText(text);
}

try {
  const originA = await startServer(), originB = await startServer();
  assert.notEqual(originA, originB, 'Two independent Python processes must expose distinct origins');
  console.log('PostgreSQL Chrome: both isolated server processes are ready');
  browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  const bootstrap = await browser.newContext();
  const owner = (await api(bootstrap, originA, '/accounts')).accounts.find(member => member.role === 'owner');
  const password = 'Postgres-browser-' + randomUUID();
  await api(bootstrap, originA, '/accounts', { member_id: owner.id, password });
  await api(bootstrap, originA, '/accounts/enable', {});
  await api(bootstrap, originA, '/session', { email: owner.email, password });
  const created = await api(bootstrap, originA, '/pages', {
    title: 'PostgreSQL 두 인스턴스 검증', icon: '🌊', blocks: [{ id: 'postgres-text', type: 'paragraph', text: '처음 저장한 본문 🙂' }],
  });
  const pageId = created.id;
  const contextA = await browser.newContext(), contextB = await browser.newContext();
  const a = await openPage(contextA, originA, owner, password, pageId);
  const b = await openPage(contextB, originB, owner, password, pageId);
  const requests=new Map(),networkStart=Date.now();
  const relevant=path=>path.startsWith('/api/uploads')||path.endsWith('/operations')||path==='/api/session';
  a.on('request',request=>{const path=new URL(request.url()).pathname;if(relevant(path)){const record={path,method:request.method(),startedMs:Date.now()-networkStart,status:null};requests.set(request,record);uploadResponses.push(record);}});
  a.on('response',response=>{const record=requests.get(response.request());if(record){record.status=response.status();record.finishedMs=Date.now()-networkStart;if(uploadOnly)console.log('PostgreSQL upload HTTP: '+JSON.stringify(record));}});
  a.on('requestfailed',request=>{const record=requests.get(request);if(record){record.failed=request.failure()?.errorText;record.finishedMs=Date.now()-networkStart;}});
  for (const [context, origin] of [[contextA, originA], [contextB, originB]]) {
    const session = await api(context, origin, '/session');
    assert.equal(session.member.id, owner.id);
    assert.equal(session.workspace_id, namespace);
  }
  await wait(a, () => state.presenceManager?.participants.length === 2);
  await wait(b, () => state.presenceManager?.participants.length === 2);
  console.log('PostgreSQL Chrome: same-owner sessions and cross-instance presence are confirmed');

  await a.locator('.block-content').first().fill('첫 번째 서버에서 작성한 본문 🙂');
  await wait(b, () => document.querySelector('.block-content')?.textContent === '첫 번째 서버에서 작성한 본문 🙂');
  await wait(a, () => state.channel.pending.size === 0);
  await a.locator('.block-content').first().evaluate(element => {
    element.focus(); const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await wait(b, () => document.querySelectorAll('.remote-caret').length > 0);
  console.log('PostgreSQL Chrome: editor changes and cursor presence propagated through the other server');

  if(!uploadOnly){
  await evaluate(a, async () => {
    await FountainOffline.serviceWorkerReady;
    if (!navigator.serviceWorker.controller) await new Promise(accept => navigator.serviceWorker.addEventListener('controllerchange', accept, { once: true }));
  });
  await contextA.setOffline(true);
  await wait(a, () => state.offline);
  await append(a, ' · 기기 A 오프라인 변경');
  await evaluate(a, () => state.channel.persistence);
  await wait(a, () => !state.saveTimer && state.channel.durable !== false);
  await a.reload();
  await a.waitForSelector('.block-content');
  assert.ok((await a.locator('.block-content').first().innerText()).includes('기기 A 오프라인 변경'));
  console.log('PostgreSQL Chrome: offline edit survived a real service-worker reload');
  await append(b, ' · 서버 B 동시 변경');
  await wait(b, () => state.channel.pending.size === 0);
  await contextA.setOffline(false);
  for (const page of [a, b]) await wait(page, () => {
    const text = document.querySelector('.block-content')?.textContent || '';
    return text.includes('기기 A 오프라인 변경') && text.includes('서버 B 동시 변경');
  });
  await wait(a, () => state.channel.pending.size === 0);
  const canonical = await api(contextB, originB, '/pages/' + pageId);
  assert.ok(canonical.blocks.some(block => block.text.includes('기기 A 오프라인 변경') && block.text.includes('서버 B 동시 변경')));
  await a.reload();
  await a.waitForSelector('.block-content');
  assert.ok((await a.locator('.block-content').first().innerText()).includes('기기 A 오프라인 변경'));

  console.log('PostgreSQL Chrome: concurrent offline changes converged and survived online reload');
  await evaluate(a, () => navigate('database', 'projects'));
  await a.waitForSelector('#db-view');
  await a.locator('[data-action=add-row]').first().click();
  await a.locator('#row-form [name=name]').fill('두 번째 인스턴스에서도 읽는 새 항목');
  await a.locator('#row-form .solid-btn').click();
  await a.waitForSelector('#row-form', { state: 'detached' });
  const rows = (await api(contextB, originB, '/databases/projects')).rows;
  assert.ok(rows.some(row => row.properties.name === '두 번째 인스턴스에서도 읽는 새 항목'));
  console.log('PostgreSQL Chrome: row created in the UI is committed and readable through the other instance');

  await evaluate(a, id => navigate('page', id), pageId);
  await a.waitForSelector('#attachment-input', { state: 'attached' });
  }
  const uploadSnapshot=await api(contextA,originA,'/pages/'+pageId+'/collaboration');
  assert.ok(await evaluate(a, epoch=>!!state.channel&&!state.channel.closed&&!state.channel.remoteDeferred&&state.channel.base.epoch===epoch,uploadSnapshot.epoch),'Attachment page must have a live canonical channel before selecting a file');
  console.log('PostgreSQL Chrome upload scope: '+JSON.stringify(await evaluate(a,()=>({channelReady:!!state.channel&&!state.channel.closed&&!state.channel.remoteDeferred,pageMatches:state.page?.id===state.uploadTargetPageId,profileBound:state.offlineProfile?.session.cache_binding===state.session?.cache_binding,offline:state.offline,localOnly:state.localPageOnly}))));
  const bytes = Buffer.alloc(64 * 1024 + 113);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 37 + 11) % 251;
  if(diagnosticUpload)await instrumentUpload(a);
  const uploadIndex=uploadResponses.length;
  await a.locator('#attachment-input').setInputFiles({ name: 'postgres-cross-instance.bin', mimeType: 'application/octet-stream', buffer: bytes });
  try {
    // Real PostgreSQL has measured 10-13 seconds per HTTP request here. Keep
    // each request's original 30-second deadline instead of incorrectly applying
    // one 30-second deadline to the entire five-request upload/attachment chain.
    await uploadPhase(uploadResponses,uploadIndex,'begin',record=>record.path==='/api/uploads'&&record.method==='POST');
    await uploadPhase(uploadResponses,uploadIndex,'chunk',record=>record.path.endsWith('/chunks')&&record.method==='PUT');
    const complete=await uploadPhase(uploadResponses,uploadIndex,'complete',record=>record.path.endsWith('/complete')&&record.method==='POST');
    const probes=diagnosticUpload?probeAttachment(a,contextA,originA).catch(error=>({probeFailure:error.name})):null;
    await uploadPhase(uploadResponses,uploadIndex,'session recheck',record=>record.path==='/api/session'&&record.method==='GET'&&record.startedMs>=complete.finishedMs);
    await uploadPhase(uploadResponses,uploadIndex,'canonical operations',record=>record.path==='/api/pages/'+pageId+'/operations'&&record.method==='POST'&&record.startedMs>=complete.finishedMs);
    await a.waitForSelector('.upload-card[data-upload-state=done]',{timeout:10000});
    assert.ok(await evaluate(a,()=>state.channel.base.blocks.some(block=>block.type==='file')),'Done must have a canonical server file block');
    if(probes)await probes;
  }
  catch(error) {
    const state = await evaluate(a, () => ({
      jobs:state.uploadManager?.view().map(job=>({name:job.name,status:job.status,offset:job.offset,message:job.message})),
      toast:document.querySelector('#toast')?.textContent,
      channel:state.channel?{closed:state.channel.closed,deferred:state.channel.remoteDeferred,pending:state.channel.pending.size,status:state.channel.status,flushing:!!state.channel.flushing,receivingPresent:!!state.channel.receiving,optimisticFile:state.blocks.some(block=>block.type==='file'),canonicalFile:state.channel.base.blocks.some(block=>block.type==='file')}:null,
      profile:{present:!!state.offlineProfile,memberMatches:state.offlineProfile?.memberId===state.session?.member?.id,bindingMatches:state.offlineProfile?.session.cache_binding===state.session?.cache_binding},
      page:{current:state.page?.id===state.uploadTargetPageId,offline:state.offline,localOnly:state.localPageOnly}
    })).catch(()=>({unavailable:true}));
    const timeline=diagnosticUpload?await evaluate(a,()=>globalThis.__postgresUploadTrace?.events).catch(()=>[]):[];
    console.error('PostgreSQL upload diagnostic: '+JSON.stringify({upload:state,responses:uploadResponses.slice(-25),timeline}));throw error;
  }
  if(diagnosticUpload){console.log('PostgreSQL completed upload timeline: '+JSON.stringify(await evaluate(a,()=>globalThis.__postgresUploadTrace.events)));await evaluate(a,()=>{const trace=globalThis.__postgresUploadTrace;globalThis.api=trace.originalApi;trace.channel.reconcile=trace.originalReconcile;});}
  await b.waitForSelector('.attachment-link');
  assert.ok((await b.locator('.attachment-link').getAttribute('href')).startsWith(originB + '/api/attachments/'));
  const downloading = b.waitForEvent('download');
  await b.locator('.attachment-link').click();
  const downloaded = await downloading;
  assert.deepEqual(await readFile(await downloaded.path()), bytes);
  await b.reload();
  await b.waitForSelector('.attachment-link');
  if(!uploadOnly)assert.ok((await b.locator('.block-content').first().innerText()).includes('기기 A 오프라인 변경'));
  assert.deepEqual(errors, []);
  completed = true;
  console.log(uploadOnly?'PASS PostgreSQL isolated upload: two independent server origins, authenticated live page, actual chunk upload, canonical file block, cross-instance byte-equal download and reload':'PASS PostgreSQL Chrome: two independent server origins, same-owner account sessions, CRDT/SSE and cursor presence, offline restart+concurrent merge, reload durability, row UI cross-instance read and byte-equal attachment download');
} finally {
  // Close browser streams first, then both server/store processes, then scoped cleanup.
  await browser?.close();
  await Promise.all(servers.map(stopServer));
  await cleanupNamespace();
  console.log('PASS cleanup: only the generated PostgreSQL namespace was removed and verified empty');
  if (fileRoot && completed) console.log('PASS file storage: attachment manifests exist, BYTEA contains zero chunks, and the private test directory was removed');
}
