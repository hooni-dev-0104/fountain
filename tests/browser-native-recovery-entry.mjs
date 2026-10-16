/** Real web application lifecycle at the explicit native recovery entry; mock native UI only. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForAsync} from './async-browser.mjs';
const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const temporary=await mkdtemp(join(tmpdir(),'fountain-native-entry-'));
let server,browser,origin,stage='startup';
try{
  const environment={...process.env};delete environment.FOUNTAIN_ACCESS_TOKEN;delete environment.FOUNTAIN_DATABASE_URL;
  server=spawn(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),['-m','fountain.server','--port','0','--database','sqlite','--data',join(temporary,'fixture.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:environment,stdio:['ignore','pipe','pipe']});
  origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Fixture startup timed out')),15000);const accept=chunk=>{output+=chunk;const match=output.match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',accept);server.stderr.on('data',accept);server.once('error',reject);});
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  async function api(path,body){const response=await context.request.fetch(origin+'/api'+path,{method:body?'POST':'GET',headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});assert.ok(response.ok());return response.json();}
  const document=await api('/pages',{title:'복구 전 편집 문서',blocks:[{id:'text',type:'paragraph',text:'서버에 남은 원문'}]});
  await page.goto(origin);await page.waitForSelector('#sidebar .brand');await waitForAsync(page,()=>!!state.mutations);
  await page.evaluate(()=>openMutationQueue());assert.equal(await page.locator('[data-action="native-recovery"]').count(),0,'ordinary web never exposes a native recovery capability');await page.evaluate(()=>closeModal());
  await page.evaluate(id=>navigate('page',id),document.id);await waitForAsync(page,id=>state.channel?.pageId===id&&!state.channel.closed,document.id);
  const recoverySource=await readFile(new URL('../apps/mobile/web/native-recovery.js',import.meta.url),'utf8'),recoveryStyles=await readFile(new URL('../apps/mobile/web/native-configuration.css',import.meta.url),'utf8');
  async function installNative(web){
  await web.route(origin+'/native-recovery.js',route=>route.fulfill({contentType:'application/javascript',body:recoverySource}));
  await web.route(origin+'/native-configuration.css',route=>route.fulfill({contentType:'text/css',body:recoveryStyles}));
  await web.addScriptTag({url:origin+'/native-recovery.js'});await web.addStyleTag({url:origin+'/native-configuration.css'});
  await web.evaluate(()=>{const web=FountainTransport;window.FountainTransport={...web,native:true,generation:1,recoveryVersion:1,recoveryEnabled:true,scopeEpoch:1};window.nativeOpenCalls=0;const bridge={cancel:async()=>({cancelled:true}),recoveryInventory:async()=>{nativeOpenCalls++;return{generation:1,inventoryToken:'native-entry-fixture',items:[],next:null};},recoveryExport:async()=>({generation:1,saved:false,filesSaved:0})};window.FountainNativeRecovery=FountainNativeRecoveryPanel.create({bridge,transport:FountainTransport});});
  }
  await installNative(page);
  await context.setOffline(true);await page.evaluate(()=>{clearTimeout(state.channel.flushTimer);state.channel.flushTimer=null;});
  const before=await page.evaluate(()=>({profileId:state.offlineProfile.id,channel:state.channel.pageId}));
  stage='IME and failed local persistence preserve current editor and do not arm native recovery';
  assert.equal(await page.evaluate(async()=>{state.composition={};try{await prepareNativeRecovery();return false;}catch(error){return error.message;}finally{state.composition=null;}}),'입력 중인 글자를 마무리한 뒤 다시 열어 주세요.');
  await page.evaluate(()=>{window.savedPersistence=state.channel.persistence;state.channel.persistence=Promise.reject(new Error('Intentional local write failure'));state.channel.persistence.catch(()=>{});});
  assert.equal(await page.evaluate(async()=>{try{await prepareNativeRecovery();return false;}catch(error){return error.message;}}),'Intentional local write failure');
  assert.equal(await page.evaluate(()=>!!state.nativeRecoveryPaused),false);assert.equal(await page.evaluate(()=>state.channel.closed),false);assert.equal(await page.evaluate(()=>nativeOpenCalls),0);
  await page.evaluate(()=>{state.channel.persistence=savedPersistence;});
  stage='account boundary during local persistence never pauses the new account';
  await page.evaluate(()=>{window.releasePersistence=null;state.channel.persistence=new Promise(resolve=>releasePersistence=resolve);window.stalePrepare=prepareNativeRecovery().then(()=>false,error=>error.message);});
  await page.evaluate(()=>{FountainTransport.scopeEpoch++;releasePersistence();});assert.equal(await page.evaluate(()=>stalePrepare),'문서나 로그인 상태가 바뀌었습니다. 다시 확인해 주세요.');assert.equal(await page.evaluate(()=>!!state.nativeRecoveryPaused),false);
  stage='unflushed DOM body and pending title are durably queued before all controllers pause';
  await page.evaluate(()=>{document.querySelector('.block-content').textContent='아직 전송하지 않은 본문 😀';state.titlePending={id:state.page.id,title:'아직 전송하지 않은 제목',basePage:structuredClone(state.pageViewBasis||state.page)};document.querySelector('#page-title').textContent=state.titlePending.title;});
  await page.evaluate(()=>openMutationQueue());assert.equal(await page.locator('[data-action="native-recovery"]').count(),1);await page.locator('[data-action="native-recovery"]').click();
  try{await waitForAsync(page,()=>state.nativeRecoveryPaused&&nativeOpenCalls===1,undefined,{timeout:5000});}catch(error){console.error(await page.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,paused:state.nativeRecoveryPaused,calls:nativeOpenCalls,hasChannel:!!state.channel,hasController:!!state.mutations,titlePending:!!state.titlePending,dirty:state.dirty})));throw error;}
  const stored=await page.evaluate(async()=>{const profile=state.offlineProfile,key=FountainOffline.key(profile,state.page.id);return{drafts:await FountainOffline.getDrafts(key),operations:await FountainOffline.pendingOperations(key),mutations:await FountainOffline.listMutations(profile),channel:state.channel,controller:state.mutations,titlePending:state.titlePending,editable:document.querySelector('.block-content')?.contentEditable??null,oldBodyVisible:document.querySelector('#main').textContent.includes('아직 전송하지 않은 본문'),notice:document.querySelector('#native-recovery-paused').textContent};});
  assert.equal(stored.channel,null);assert.equal(stored.controller,null);assert.equal(stored.titlePending,null);assert.equal(stored.editable,null);assert.equal(stored.oldBodyVisible,false,'a later recovery account switch cannot reveal the previous document behind the dialog');assert.equal(await page.locator('#sidebar').isVisible(),false);assert.equal(await page.locator('#topbar').isVisible(),false);assert.ok(stored.operations.some(operation=>operation.text?.includes('아직 전송하지 않은 본문')));assert.ok(stored.drafts.some(record=>record.draft.blocks?.some(block=>block.text==='아직 전송하지 않은 본문 😀')));assert.ok(stored.mutations.some(record=>record.operation.kind==='page.patch'&&record.operation.body.title==='아직 전송하지 않은 제목'));assert.match(stored.notice,/앱을 다시 열어/);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/fountain-native-recovery-entry-mobile.png'});
  await page.evaluate(()=>FountainNativeRecovery.close());assert.equal(await page.locator('.native-recovery-dialog').count(),0);
  await page.screenshot({path:'/tmp/fountain-native-recovery-paused-mobile.png'});
  const pausedRoute=await page.evaluate(()=>state.route);await page.evaluate(()=>navigate('home'));assert.equal(await page.evaluate(()=>state.route),pausedRoute);await page.evaluate(()=>boot());assert.equal(await page.evaluate(()=>state.channel),null,'closing recovery never silently restarts controllers');
  assert.equal(await page.evaluate(()=>state.offlineProfile.id),before.profileId);await context.setOffline(false);assert.equal((await api('/pages/'+document.id)).page.blocks[0].text,'서버에 남은 원문');assert.equal((await api('/pages/'+document.id)).page.title,document.title);
  stage='title timer cannot start a server write after the recovery pause';
  const raceContext=await browser.newContext({serviceWorkers:'block'}),racePage=await raceContext.newPage();
  await racePage.goto(origin);await racePage.waitForSelector('#sidebar .brand');await waitForAsync(racePage,()=>!!state.mutations);await racePage.evaluate(id=>navigate('page',id),document.id);await installNative(racePage);await raceContext.setOffline(true);
  await racePage.evaluate(()=>{
    const controller=state.mutations,patch=controller.patchPage.bind(controller);let first=true;
    controller.patchPage=async(...args)=>{if(first){first=false;await new Promise(resolve=>window.releaseLocalPatch=resolve);}return patch(...args);};
    state.channel.flush=()=>new Promise(resolve=>window.releaseTitleFlush=resolve);
    state.titlePending={id:state.page.id,title:'TIMER AFTER PAUSE',basePage:structuredClone(state.pageViewBasis||state.page)};
    state.titleTimer=setTimeout(()=>{window.timerTask=saveTitle().catch(error=>window.timerError=error.message);},10);
    window.helperTask=prepareNativeRecovery().then(()=>true,error=>error.message);
  });
  await racePage.waitForFunction(()=>!!window.releaseLocalPatch);await racePage.waitForTimeout(30);await racePage.evaluate(()=>releaseLocalPatch());assert.equal(await racePage.evaluate(()=>helperTask),true);
  const lateWrites=[];racePage.on('request',request=>{if(request.method()==='PATCH'&&request.url().includes('/api/pages/'))lateWrites.push(request.url());});await raceContext.setOffline(false);
  await racePage.evaluate(async()=>{if(window.releaseTitleFlush)releaseTitleFlush();if(window.timerTask)await timerTask;});assert.deepEqual(lateWrites,[]);assert.equal((await api('/pages/'+document.id)).page.title,document.title);await raceContext.close();
  stage='network and profile events cannot replace the paused home notice with old private content';
  const homeContext=await browser.newContext({serviceWorkers:'block'}),homePage=await homeContext.newPage();await homePage.goto(origin);await homePage.waitForSelector('#sidebar .brand');await waitForAsync(homePage,()=>!!state.mutations);await installNative(homePage);
  await homePage.evaluate(async id=>{const response=await FountainTransport.request('/api/pages/'+encodeURIComponent(id)+'/collaboration');await FountainOffline.saveSnapshot(FountainOffline.key(state.offlineProfile,id),await response.json());state.offline=true;const offline=FountainOffline;window.originalHomeOffline=offline;window.FountainOffline={...offline,getSnapshot:key=>new Promise(resolve=>window.releaseCachedSnapshot=()=>offline.getSnapshot(key).then(resolve)),getProfile:()=>new Promise(resolve=>window.releaseBootProfile=()=>offline.getProfile().then(resolve))};window.lateNavigation=navigate('page',id);},document.id);
  await homePage.waitForFunction(()=>!!window.releaseCachedSnapshot);await homePage.evaluate(()=>{window.lateBoot=boot();});
  await homePage.evaluate(()=>prepareNativeRecovery());await homePage.evaluate(async()=>{releaseCachedSnapshot();releaseBootProfile();await Promise.all([lateNavigation,lateBoot]);window.FountainOffline=originalHomeOffline;state.route='home';});assert.equal(await homePage.evaluate(()=>state.channel),null);assert.equal(await homePage.locator('#sidebar').isVisible(),false);await homeContext.setOffline(true);
  await homePage.evaluate(()=>new Promise(resolve=>setTimeout(resolve,80)));assert.equal(await homePage.locator('#native-recovery-paused').count(),1);assert.equal(await homePage.locator('#main').textContent().then(value=>value.includes('복구 전 편집 문서')),false);
  await homePage.evaluate(()=>{dispatchEvent(new CustomEvent('fountain-offline-profile-changed'));dispatchEvent(new CustomEvent('fountain-offline-profile-cleared',{detail:{profileId:state.offlineProfile.id}}));renderHome();renderPage();renderDatabase();});assert.equal(await homePage.locator('#native-recovery-paused').count(),1);await homeContext.setOffline(false);assert.equal(await homePage.locator('#native-recovery-paused').count(),1);await homeContext.close();
  assert.deepEqual(errors,[]);console.log('PASS real Chrome native recovery entry: hidden on web, IME/storage/stale guards, local body+title persisted before pause, controllers closed without purge, readonly/no-auto-resume, title timer/cached navigation/late boot/network fences and server unchanged; real recovery UI with metadata-only native bridge model');
}catch(error){console.error('FAIL stage:',stage);throw error;}finally{await browser?.close();if(server&&server.exitCode===null){const ended=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGINT');await ended;}await rm(temporary,{recursive:true,force:true});}
