/** Real SQLite HTTP + Chrome. Everything is disposable; no original workspace/cloud. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForAsync} from './async-browser.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const temporary=await mkdtemp(join(tmpdir(),'fountain-verification-')),python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin,stage='startup';const errors=[];
async function start(){
  const env={...process.env};delete env.FOUNTAIN_ACCESS_TOKEN;delete env.FOUNTAIN_DATABASE_URL;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(temporary,'workspace.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Disposable startup timeout')),15000),read=chunk=>{text+=chunk;const match=text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',read);server.stderr.on('data',read);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Disposable server exited '+code));});});
}
async function api(context,path,body,method){const response=await context.request.fetch(origin+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});assert.ok(response.ok(),path+': '+response.status()+' '+await response.text());return response.json();}
async function storedVerification(id,value,write=false){
  // Only this test's mkdtemp-owned SQLite file can contain legacy fixtures.
  assert.ok(temporary.startsWith(join(tmpdir(),'fountain-verification-')));
  const child=spawn(python,['-c',`import json,sys
from fountain.core import Store
store=Store(sys.argv[1])
request=json.load(sys.stdin)
with store.transaction():
    page=store.get('page',request['id'])
    assert page is not None
    if request['write']:
        page['verification']=request['value']
        store.put('page',page)
    print(json.dumps(page.get('verification'),ensure_ascii=False))
store.db.close()
`,join(temporary,'workspace.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.stdin.end(JSON.stringify({id,value,write}));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,'Disposable Store fixture failed: '+error);return JSON.parse(output);
}
async function login(page,email,password){await page.goto(origin);await page.locator('#login-form [name=email]').fill(email);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form .solid-btn').click();await page.waitForSelector('#sidebar .brand');}
async function ready(page,id){await waitForAsync(page,id=>state.route==='page'&&state.page?.id===id&&state.channel?.pageId===id&&!state.channel.closed&&!state.openingDocument&&!!document.querySelector('#page-title'),id);}
async function open(page,id){await page.evaluate(id=>navigate('page',id),id);await ready(page,id);await page.locator('#page-verification-status [data-action=verify-page]').click();await page.locator('#verification-form').waitFor();}
async function expiry(page,value){await page.locator('[name=expires]').evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},value);}
async function submit(page){await page.locator('#verification-form [type=submit]').click();}
async function closed(page){await page.locator('.verification-modal').waitFor({state:'detached'});}
async function mobileVerification(page){
  await page.setViewportSize({width:390,height:844});
  const measurements=await page.evaluate(()=>{
    const modal=document.querySelector('.verification-modal'),body=modal.querySelector('.modal-body'),status=document.querySelector('#page-verification-status');
    const height=selector=>[...modal.querySelectorAll(selector)].filter(element=>element.getClientRects().length).map(element=>element.getBoundingClientRect().height);
    const fonts=[...modal.querySelectorAll('.modal-body p,label,legend,small,input:not([type=checkbox]),select,.verification-current,#verification-error,.form-actions button')].map(element=>parseFloat(getComputedStyle(element).fontSize));
    return {heights:height('.verification-owners label,input:not([type=checkbox]),select,.form-actions button,.modal-close'),fonts,statusFont:parseFloat(getComputedStyle(status).fontSize),statusActions:[...status.querySelectorAll('button')].map(element=>element.getBoundingClientRect().height),overflow:document.documentElement.scrollWidth>innerWidth||modal.scrollWidth>modal.clientWidth||body.scrollWidth>body.clientWidth};
  });
  assert.ok(measurements.heights.length&&measurements.heights.every(height=>height>=44),'Every mobile verification touch target is at least 44px');assert.ok(measurements.fonts.every(size=>size>=14),'Mobile verification text is at least 14px');assert.ok(measurements.statusFont>=14&&measurements.statusActions.every(height=>height>=44));assert.equal(measurements.overflow,false,'No horizontal overflow at 390px');
  const footer=page.locator('#verification-form [type=submit]');await footer.scrollIntoViewIfNeeded();assert.ok(await footer.isVisible(),'Vertical scrolling reaches the footer');
  const inViewport=await footer.evaluate(element=>{const rect=element.getBoundingClientRect(),body=element.closest('.modal-body').getBoundingClientRect();return rect.top>=body.top&&rect.bottom<=body.bottom&&rect.bottom<=innerHeight;});assert.ok(inViewport,'Footer is reachable inside the viewport without cutoff');
  await page.locator('.verification-modal .modal-body').evaluate(element=>element.scrollTop=0);
}
async function hold(page,path,method='POST'){
  let seen,release,done,used=false;const arrived=new Promise(resolve=>seen=resolve),gate=new Promise(resolve=>release=resolve),finished=new Promise(resolve=>done=resolve);
  const handler=async route=>{if(used||route.request().method()!==method)return route.fallback();used=true;try{const response=await route.fetch();seen(route.request().postDataJSON());await gate;await route.fulfill({response});}finally{done();}};await page.route(origin+'/api'+path,handler);
  return {seen:()=>Promise.race([arrived,new Promise((_,reject)=>setTimeout(()=>reject(Error('Held verification did not arrive')),15000))]),release:async()=>{release();await finished;await page.unroute(origin+'/api'+path,handler);}};
}
try{
  origin=await start();browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'America/New_York'}),memberContext=await browser.newContext(),guestContext=await browser.newContext();
  const owner=(await api(context,'/accounts')).accounts.find(account=>account.role==='owner'),password='Verification-family-2026';
  const member=await api(context,'/members',{name:'가족 <img src=x onerror=alert(1)>',email:'verification@example.local',role:'member'}),guest=await api(context,'/members',{name:'방문 가족',email:'verification-guest@example.local',role:'guest'});
  for(const account of [owner,member,guest])await api(context,'/accounts',{member_id:account.id,password});await api(context,'/accounts/enable',{});
  const page=await context.newPage(),editor=await memberContext.newPage(),visitor=await guestContext.newPage();for(const tab of [page,editor,visitor])tab.on('pageerror',error=>errors.push(error.message));
  await login(page,owner.email,password);await login(editor,member.email,password);await login(visitor,guest.email,password);
  const doc=await api(context,'/pages',{title:'검증할 가족 문서',blocks:[{id:'body',type:'paragraph',text:'함께 확인한 내용'}]}),other=await api(context,'/pages',{title:'다른 페이지',blocks:[]});
  await api(context,'/pages/'+doc.id+'/permissions',{permissions:{default:'private',inherit:false,members:{[member.id]:'edit',[guest.id]:'view'},groups:{}}},'PATCH');
  stage='default and multiple owners';await page.evaluate(()=>refreshWorkspace());await open(page,doc.id);
  assert.deepEqual(await page.locator('[name=owners]:checked').evaluateAll(inputs=>inputs.map(input=>input.value)),[owner.id]);
  assert.equal(await page.locator('.verification-owners img').count(),0);assert.match(await page.locator('.verification-owners').innerText(),/<img src=x/);
  await page.locator(`[name=owners][value="${member.id}"]`).check();await submit(page);await closed(page);
  let stored=(await api(context,'/pages/'+doc.id)).page;assert.deepEqual(new Set(stored.verification.owners),new Set([owner.id,member.id]));assert.equal(stored.verification.expires_at,null);assert.notEqual(stored.owner_id,member.id);
  await page.reload();await ready(page,doc.id);assert.match(await page.locator('#page-verification-status').innerText(),/검증됨/);
  stage='finite expiry and strict local time';await open(page,doc.id);await page.locator('[name=expiry_mode]').selectOption('finite');await expiry(page,'2028-06-12T15:30:00');
  const shots=process.env.FOUNTAIN_SCREENSHOTS;if(shots){
    await mkdir(shots,{recursive:true});await page.screenshot({path:join(shots,'verification-desktop.png')});await mobileVerification(page);await page.screenshot({path:join(shots,'verification-mobile.png')});await page.setViewportSize({width:1440,height:1050});
    // Read-only reference capture of an existing Fountain modal. No ACL writes.
    await page.locator('[data-action=close-modal]').first().click();await page.locator('[data-action=share]').click();await page.locator('#permissions-form').waitFor();await page.screenshot({path:join(shots,'reference-sharing-desktop.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(shots,'reference-sharing-mobile.png')});await page.setViewportSize({width:1440,height:1050});await page.locator('[data-action=close-modal]').first().click();await open(page,doc.id);await page.locator('[name=expiry_mode]').selectOption('finite');await expiry(page,'2028-06-12T15:30:00');
  }else{await mobileVerification(page);await page.setViewportSize({width:1440,height:1050});}
  await submit(page);await closed(page);stored=(await api(context,'/pages/'+doc.id)).page;assert.equal(stored.verification.expires_at,'2028-06-12T19:30:00.000Z');
  const exact=stored.verification.expires_at;await open(page,doc.id);await submit(page);await closed(page);assert.equal((await api(context,'/pages/'+doc.id)).page.verification.expires_at,exact);
  const precise='2030-06-12T15:30:00.123456+09:00',beforePrecise=(await api(context,'/pages/'+doc.id)).page;await api(context,'/pages/'+doc.id+'/verify',{owners:[owner.id,member.id],expires_at:precise,revision:beforePrecise.revision});await open(page,doc.id);await submit(page);await closed(page);assert.equal((await api(context,'/pages/'+doc.id)).page.verification.expires_at,precise,'Unchanged local field preserves the original offset and fractional precision');
  await open(page,doc.id);await expiry(page,'2027-03-14T02:30:00');await submit(page);assert.match(await page.locator('#verification-error').innerText(),/존재하는/);
  await expiry(page,'2020-01-01T12:00:00');await submit(page);assert.match(await page.locator('#verification-error').innerText(),/현재보다/);
  await page.locator('[name=expiry_mode]').selectOption('infinite');await page.locator(`[name=owners][value="${owner.id}"]`).uncheck();await page.locator(`[name=owners][value="${member.id}"]`).uncheck();await submit(page);assert.match(await page.locator('#verification-error').innerText(),/한 명 이상/);
  await page.locator('[data-action=close-modal]').first().click();
  stage='edit3 and read-only guest';await editor.evaluate(()=>refreshWorkspace());await open(editor,doc.id);await editor.locator(`[name=owners][value="${owner.id}"]`).uncheck();await editor.locator(`[name=owners][value="${member.id}"]`).check();await submit(editor);await closed(editor);assert.deepEqual((await api(context,'/pages/'+doc.id)).page.verification.owners,[member.id]);
  await visitor.evaluate(()=>refreshWorkspace());await visitor.evaluate(id=>navigate('page',id),doc.id);await ready(visitor,doc.id);assert.match(await visitor.locator('#page-verification-status').innerText(),/검증됨/);assert.equal(await visitor.locator('[data-action=verify-page]').count(),0);assert.equal(await visitor.locator('#page-verification-status img').count(),0);
  const legitimatelyHidden=(await api(guestContext,'/pages/'+doc.id)).page.verification;assert.deepEqual(legitimatelyHidden.owners,[]);assert.ok(Number.isFinite(Date.parse(legitimatelyHidden.verified_at)),'A legitimate hidden-owner projection retains its actual valid timestamp');
  assert.deepEqual((await api(guestContext,'/pages/'+doc.id+'/collaboration')).page.verification,legitimatelyHidden);
  stage='stored malformed verification survives real projection without a verified badge';
  const originalStored=await storedVerification(doc.id),validStored={owners:[member.id],owner:member.id,verified_by:owner.id,verified_at:'2026-10-01T12:00:00Z',expires_at:null};
  for(const malformed of [{...validStored,expires_at:false},{...validStored,expires_at:'2030-01-01T12:00:00.'+'1'.repeat(100)+'Z'},{...validStored,owners:member.id},{...validStored,owners:[]},{...validStored,owners:[member.id,false]}]){
    await storedVerification(doc.id,malformed,true);
    const detail=(await api(context,'/pages/'+doc.id)).page.verification,canonical=(await api(context,'/pages/'+doc.id+'/collaboration')).page.verification;
    assert.equal(detail.verified_at,null,'Malformed persisted metadata must not become a valid hidden-owner DTO');assert.deepEqual(canonical,detail);
    await page.evaluate(id=>navigate('page',id),doc.id);await ready(page,doc.id);
    assert.match(await page.locator('#page-verification-status').innerText(),/검증 상태 확인 필요/);assert.equal(await page.locator('.verification-badge.verified').count(),0);
    assert.deepEqual(await storedVerification(doc.id),malformed,'Read projection must preserve the exact legacy verification source');
  }
  await storedVerification(doc.id,originalStored,true);
  stage='legacy malformed status never claims verification';
  await visitor.evaluate(()=>{
    const original=state.page.verification;
    const valid={owners:[],verified_at:'2026-10-01T12:00:00Z',expires_at:null};
    for(const value of [false,0,[],{}, {...valid,verified_at:'bad'},...['bad',false,0,{},'2028-02-31T12:00:00Z'].map(expires_at=>({...valid,expires_at}))]){
      state.page.verification=value;renderVerificationStatus();
      if(!document.querySelector('#page-verification-status').textContent.includes('검증 상태 확인 필요')||document.querySelector('.verification-badge.verified'))throw Error('Malformed legacy verification was displayed as verified');
    }
    state.page.verification=valid;renderVerificationStatus();if(!document.querySelector('#page-verification-status').textContent.includes('담당자 정보 비공개'))throw Error('Hidden owners were not presented generically');
    state.page.verification=original;renderVerificationStatus();
  });
  stage='guest edit uses only visible self';await api(context,'/pages/'+doc.id+'/permissions',{permissions:{default:'private',inherit:false,members:{[member.id]:'edit',[guest.id]:'edit'},groups:{}}},'PATCH');await visitor.evaluate(()=>refreshWorkspace());await open(visitor,doc.id);
  assert.deepEqual(await visitor.locator('[name=owners]').evaluateAll(inputs=>inputs.map(input=>input.value)),[guest.id]);assert.equal(await visitor.locator(`[name=owners][value="${guest.id}"]`).isChecked(),true);await submit(visitor);await closed(visitor);
  stage='real CAS conflict preserves form';await open(page,doc.id);await page.locator('[name=expiry_mode]').selectOption('finite');await expiry(page,'2029-08-09T10:20:00');
  const rev=await page.evaluate(()=>state.page.revision);await api(context,'/pages/'+doc.id,{title:'다른 가족이 수정한 문서',revision:rev},'PATCH');await waitForAsync(page,rev=>state.page.revision!==rev,rev);await submit(page);await page.locator('#verification-error:not(:empty)').waitFor();assert.match(await page.locator('#verification-error').innerText(),/변경/);assert.equal(await page.locator('[name=expires]').inputValue(),'2029-08-09T10:20');await page.locator('[data-action=close-modal]').first().click();
  for(const status of [403,409,500]){await open(page,doc.id);const handler=async route=>{if(status===409){const fresh=(await api(context,'/pages/'+doc.id)).page;await api(context,'/pages/'+doc.id,{title:'서버에서 경합한 문서',revision:fresh.revision},'PATCH');await route.continue();}else await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:'설정을 저장하지 못했습니다.'})});};await page.route(origin+'/api/pages/'+doc.id+'/verify',handler);await page.locator('[name=expiry_mode]').selectOption('finite');await expiry(page,'2029-08-09T10:20:00');await submit(page);await page.locator('#verification-error:not(:empty)').waitFor();assert.equal(await page.locator('[name=expires]').inputValue(),'2029-08-09T10:20');assert.equal(await page.locator('[type=submit]').isDisabled(),false);await page.unroute(origin+'/api/pages/'+doc.id+'/verify',handler);await page.locator('[data-action=close-modal]').first().click();}
  stage='pre-request save scope and late route/modal response';let posts=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/verify'))posts++;});await open(page,doc.id);
  await page.evaluate(()=>{const original=saveTitle;let first=true;globalThis.restoreVerificationSave=()=>saveTitle=original;saveTitle=async()=>{if(!first)return original();first=false;await new Promise(resolve=>globalThis.releaseVerificationSave=resolve);return original();};});await submit(page);await page.waitForFunction(()=>!!globalThis.releaseVerificationSave);await page.evaluate(id=>navigate('page',id),other.id);await ready(page,other.id);const before=posts;await page.evaluate(()=>{releaseVerificationSave();restoreVerificationSave();});await page.waitForTimeout(150);assert.equal(posts,before);
  await open(page,doc.id);let held=await hold(page,'/pages/'+doc.id+'/verify');await submit(page);await held.seen();assert.equal(await page.locator('[type=submit]').isDisabled(),true);const onePost=posts;await page.evaluate(()=>saveVerification(false));assert.equal(posts,onePost,'A busy modal cannot submit twice');await page.evaluate(id=>navigate('page',id),other.id);await ready(page,other.id);await page.evaluate(()=>showAI());const unrelated=await page.locator('.modal-body').innerHTML();await held.release();await page.waitForTimeout(150);assert.equal(await page.locator('.modal-body').innerHTML(),unrelated);assert.equal(await page.evaluate(()=>state.page.id),other.id);await page.locator('[data-action=close-modal]').first().click();
  await open(page,doc.id);held=await hold(page,'/pages/'+doc.id+'/verify');await submit(page);await held.seen();await page.locator('[data-action=close-modal]').first().click();await page.evaluate(()=>showAI());const samePageModal=await page.locator('.modal-body').innerHTML();await held.release();await page.waitForTimeout(150);assert.equal(await page.locator('.modal-body').innerHTML(),samePageModal,'A late reply cannot close another modal on the same page');await page.locator('[data-action=close-modal]').first().click();
  stage='held canonical GET after route change';await open(page,doc.id);held=await hold(page,'/pages/'+doc.id+'/collaboration','GET');await submit(page);await held.seen();await page.evaluate(id=>navigate('page',id),other.id);await ready(page,other.id);await held.release();await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>state.page.id),other.id);assert.equal(await page.locator('.verification-modal').count(),0);
  stage='held response after real account switch';await open(page,doc.id);held=await hold(page,'/pages/'+doc.id+'/verify');await submit(page);await held.seen();await api(context,'/session',{email:member.email,password});await page.evaluate(()=>boot());await page.waitForFunction(()=>state.loaded&&state.session.member.email==='verification@example.local');await page.evaluate(()=>showAI());const switchedModal=await page.locator('.modal-body').innerHTML();await held.release();await page.waitForTimeout(150);assert.equal(await page.locator('.modal-body').innerHTML(),switchedModal);await page.locator('[data-action=close-modal]').first().click();
  stage='remove and natural expiry without writes';await open(editor,doc.id);await editor.locator('[data-action=remove-verification]').click();await closed(editor);assert.equal((await api(memberContext,'/pages/'+doc.id)).page.verification,undefined);
  await open(editor,doc.id);await editor.locator('[name=expiry_mode]').selectOption('finite');const future=await editor.evaluate(()=>verificationLocalTime(new Date(Date.now()+6000).toISOString()));await expiry(editor,future);await submit(editor);await closed(editor);let writes=0;editor.on('request',request=>{if(request.method()!=='GET'&&request.url().includes('/api/pages/')&&!request.url().includes('/presence'))writes++;});await editor.waitForFunction(()=>document.querySelector('#page-verification-status').textContent.includes('검증 만료'),null,{timeout:10000});assert.equal(writes,0);
  await open(editor,doc.id);await editor.locator('[data-action=remove-verification]').click();await closed(editor);assert.equal((await api(memberContext,'/pages/'+doc.id)).page.verification,undefined);
  assert.deepEqual(errors,[]);console.log('PASS verification: real multi-owner/CAS/edit3/readonly, expiry/remove/reload, strict DST, busy/error retention and stale save/route/modal/account fences');
}catch(error){console.error('Verification browser stage:',stage);throw error;}
finally{if(browser)await browser.close();if(server){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}await rm(temporary,{recursive:true,force:true});}
