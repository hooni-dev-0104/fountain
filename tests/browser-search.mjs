/** Actual disposable Python/Chrome search UI; race responses explicitly mocked. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-search-')),proof=fileURLToPath(new URL('../.data/search-proof/',import.meta.url));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin;const errors=[];
async function start(){
 const env={...process.env};delete env.FOUNTAIN_ACCESS_TOKEN;
 server=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
 return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Temporary search server did not start')),15000);const receive=chunk=>{output+=chunk;const m=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}};server.stdout.on('data',receive);server.stderr.on('data',receive);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Temporary search server exited '+code));});});
}
async function api(context,path,body,method){const r=await context.request.fetch(origin+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'X-Fountain-Request':'1'},...(body?{data:body}:{})});assert(r.ok(),path+' '+r.status()+' '+await r.text());return r.json();}
async function search(page){await page.locator('[data-action=search]').first().click();await page.waitForSelector('#search-input');}
async function until(check){for(let n=0;n<200;n++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Search fixture condition timed out');}
async function verifySearch(context,page,owner,password){
 await page.keyboard.press('Escape');
 const parent=await api(context,'/pages',{title:'검색 범위 상위',blocks:[]});
 const doc=await api(context,'/pages',{title:'벚꽃검색 <img src=x onerror=globalThis.searchXSS=1>',parent_id:parent.id,blocks:[{id:'search-text',type:'paragraph',text:'오전 회의 본문전용토큰'}]});
 const database=await api(context,'/databases',{name:'벚꽃검색 데이터베이스',page_id:parent.id,properties:[{id:'name',name:'이름',type:'title'},{id:'note',name:'메모',type:'text'}]});
 const row=await api(context,`/databases/${database.id}/rows`,{properties:{name:'벚꽃검색 행 상세',note:'본문전용토큰'}});
 for(let i=0;i<25;i++)await api(context,'/pages',{title:'쪽나눔검색 '+String(i).padStart(2,'0'),blocks:[]});
 const member=await api(context,'/members',{name:'검색 가족',email:'search-family@example.invalid',role:'member'});await api(context,'/accounts',{member_id:member.id,password:'Search-family-fixture-2026'});
 await page.reload();await page.waitForSelector('.recent-grid');await search(page);
 await page.waitForFunction(()=>document.querySelector('#search-mode')?.textContent.includes('항목 검색'));
 const fill=async value=>{await page.locator('#search-input').fill(value);await page.waitForFunction(()=>{const text=document.querySelector('#search-status')?.textContent||'';return text&&!text.includes('검색을 준비')&&!text.includes('검색하고');});};
 await fill('벚꽃검색');assert.equal(await page.locator('.search-result').count(),3);assert.equal(await page.locator('.search-result img').count(),0);assert.equal(await page.evaluate(()=>globalThis.searchXSS),undefined);
 assert((await page.locator('.search-results').innerText()).includes('항목 · 벚꽃검색 데이터베이스'));
 await page.locator('.search-result').filter({hasText:'행 상세'}).click();await page.waitForSelector('#row-form');assert.equal(await page.locator('#row-form [name=name]').inputValue(),'벚꽃검색 행 상세');await page.keyboard.press('Escape');
 await search(page);await fill('본문전용토큰');assert.equal(await page.locator('.search-result').count(),2);
 await page.locator('#search-filter-toggle').click();await page.locator('#search-filters [name=title_only]').check();await page.waitForFunction(()=>document.querySelector('#search-status')?.textContent.startsWith('0개'));assert.equal(await page.locator('.search-result').count(),0);
 await page.locator('#search-reset').click();await fill('벚꽃검색');
 await page.locator('#search-filters [name=types][value=page]').uncheck();await page.locator('#search-filters [name=types][value=database]').uncheck();await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===1&&document.querySelector('.search-result')?.textContent.includes('행 상세'));
 assert.equal(await page.locator('#search-filters [name=sort] option').count(),6);
 const dateRequest=page.waitForRequest(r=>r.url().includes('/api/search/advanced?')&&new URL(r.url()).searchParams.has('before'));
 await page.locator('#search-filters [name=owner]').selectOption(owner.id);await page.locator('#search-filters [name=in]').selectOption(parent.id);await page.locator('#search-filters [name=date_field]').selectOption('created');await page.locator('#search-filters [name=after]').fill('2026-03-08');await page.locator('#search-filters [name=before]').fill('2026-03-08');
 const params=new URL((await dateRequest).url()).searchParams;assert.equal(params.get('owner'),owner.id);assert.equal(params.get('in'),parent.id);assert.equal(params.get('date_field'),'created');assert.equal(params.get('after'),'2026-03-08T05:00:00.000Z');assert.equal(params.get('before'),'2026-03-09T04:00:00.000Z');
 await page.locator('#search-reset').click();await page.locator('#search-filter-toggle').click();await fill('쪽나눔검색');await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===20);
 await page.locator('#search-more').click();await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===25);
 await fill('벚꽃검색');await fill('쪽나눔검색');await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===20);
 await api(context,'/pages',{title:'쪽나눔검색 새 항목',blocks:[]});await page.locator('#search-more').click();await page.waitForSelector('#search-retry:visible');assert.equal(await page.locator('.search-result').count(),0);await page.locator('#search-retry').click();await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===20);
 // Explicit fresh container/authorization denial on a subsequent page. These
 // mocked statuses prove UI invalidation only, not Python authorization rules.
 let unexpectedLegacy=0;const countLegacy=r=>{if(new URL(r.url()).pathname==='/api/search')unexpectedLegacy++;};context.on('request',countLegacy);
 for(const status of [403,404]){
  await fill('벚꽃검색');await fill('쪽나눔검색');await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===20);
  const denyMore=async route=>{if(new URL(route.request().url()).searchParams.get('offset')==='20')await route.fulfill({status,json:{error:'Fresh search scope denied'}});else await route.continue();};
  await context.route('**/api/search/advanced?*',denyMore);await page.locator('#search-more').click();await page.waitForFunction(()=>document.querySelectorAll('.search-result').length===0&&searchView?.marker===null&&searchView?.next===null&&searchView.items.length===0);assert(await page.locator('#search-more').isHidden());assert.equal(unexpectedLegacy,0);await context.unroute('**/api/search/advanced?*',denyMore);
 }
 context.off('request',countLegacy);
 await fill('벚꽃검색');await page.screenshot({path:join(proof,'actual-1280.png')});await page.locator('#search-filter-toggle').click();await page.screenshot({path:join(proof,'actual-filters-1280.png')});await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);await page.screenshot({path:join(proof,'actual-filters-390.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#search-filter-toggle').click();await page.screenshot({path:join(proof,'actual-390.png')});await page.setViewportSize({width:1280,height:900});
 await api(context,`/databases/${database.id}/rows/${row.id}`,{},'DELETE');await page.locator('.search-result').filter({hasText:'행 상세'}).click();await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('항목이 삭제'));assert.equal(await page.locator('#row-form').count(),0);assert.equal((await api(context,`/databases/${database.id}`)).rows.length,0);
 // Already-rendered DB rows must not authorize a search open after fresh denial.
 await api(context,`/databases/${database.id}/rows`,{properties:{name:'권한검색 행'}});await search(page);await fill('권한검색');await page.locator('.search-result').click();await page.waitForSelector('#row-form');await page.keyboard.press('Escape');
 await search(page);await fill('권한검색');await context.route('**/api/databases/'+database.id,route=>route.fulfill({status:403,json:{error:'Fresh database access denied'}}));
 await page.locator('.search-result').click();await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='Fresh database access denied');assert.equal(await page.locator('#row-form').count(),0);await context.unroute('**/api/databases/'+database.id);
 console.log('PASS actual Python retrieval: page/database/row, body/title/types/owner/container/date filters, pagination409, escaping, existing-row-only navigation and responsive screenshots');

 // Explicit HTTP/transport fault injection below; not backend semantics proof.
 const held=[];let legacyCalls=0;
 context.on('request',r=>{if(new URL(r.url()).pathname==='/api/search')legacyCalls++;});
 await context.route('**/api/search/advanced?*',async route=>{const q=new URL(route.request().url()).searchParams.get('q');if(q?.startsWith('느린')){await new Promise(resolve=>held.push({route,resolve}));return;}if(q==='범위거부'){await route.fulfill({status:404,json:{error:'Unavailable container'}});return;}if(q==='권한거부'){await route.fulfill({status:403,json:{error:'Forbidden'}});return;}await route.continue();});
 await page.evaluate(()=>{const original=FountainTransport;window.__searchOriginal=original;window.FountainTransport=Object.freeze({...original,request:(path,options)=>original.request(path,path.startsWith('/api/search/advanced')?{...options,signal:undefined}:options)});});
 const release=async(status=200)=>{const value=held.shift();await value.route.fulfill({status,json:status===401?{error:'Expired old query'}:{results:[{type:'page',id:doc.id,title:'늦은 비공개 결과',snippet:'이 결과는 표시되면 안 됩니다.'}],total:1,has_more:false,next_offset:null,result_set:'b'.repeat(64)}}).catch(()=>{});value.resolve();await page.waitForTimeout(200);assert(!(await page.locator('body').innerText()).includes('늦은 비공개 결과'));};
 await search(page);await page.locator('#search-input').fill('느린이전쿼리');await until(()=>held.length===1);await fill('벚꽃검색');await release();
 await page.locator('#search-input').fill('느린이전모달');await until(()=>held.length===1);await page.keyboard.press('Escape');await search(page);await page.waitForSelector('.search-result');await release(401);assert.equal(await page.locator('#search-input').count(),1);
 await page.locator('#search-input').fill('느린전송세대');await until(()=>held.length===1);await page.evaluate(()=>{window.FountainTransport=Object.freeze({...FountainTransport,scopeEpoch:1});});await release();await page.keyboard.press('Escape');await search(page);await page.waitForSelector('.search-result');
 const before=legacyCalls;await fill('범위거부');await page.waitForFunction(()=>document.querySelector('#search-status')?.textContent.includes('범위를 찾을'));assert.equal(legacyCalls,before);await fill('권한거부');await page.waitForFunction(()=>document.querySelector('#search-status')?.textContent.includes('권한이 없습니다'));assert.equal(await page.locator('.search-result').count(),0);assert.equal(await page.evaluate(()=>state.offline),false);
 await page.locator('#search-input').fill('느린이전계정');await until(()=>held.length===1);
 await page.evaluate(async()=>{await api('/session',{},'DELETE');history.replaceState(null,'','#home');await boot();});await page.waitForSelector('#login-form');await page.locator('#login-form [name=email]').fill(member.email);await page.locator('#login-form [name=password]').fill('Search-family-fixture-2026');await page.locator('#login-form .solid-btn').click();await page.waitForFunction(id=>state.loaded&&state.session?.member?.id===id,member.id);await page.waitForSelector('.recent-grid');await search(page);await page.waitForSelector('.search-result');await release();
 await page.keyboard.press('Escape');await context.route('**/api/capabilities',route=>route.fulfill({json:{legacy:true}}));await search(page);await page.waitForFunction(()=>document.querySelector('#search-mode')?.textContent.includes('페이지 검색만'));assert(await page.locator('#search-filters [name=owner]').isDisabled());await page.waitForSelector('.search-result');assert(legacyCalls>before);await page.keyboard.press('Escape');await context.unroute('**/api/capabilities');await context.route('**/api/capabilities',route=>route.fulfill({status:404,json:{error:'Old endpoint'}}));await search(page);await page.waitForFunction(()=>document.querySelector('#search-mode')?.textContent.includes('기존 서버'));await page.keyboard.press('Escape');await context.unroute('**/api/capabilities');
 await page.evaluate(()=>navigate('page','welcome'));await page.waitForSelector('#page-title');await context.setOffline(true);await page.waitForFunction(()=>state.offline===true);await search(page);await page.waitForFunction(()=>document.querySelector('#search-mode')?.textContent.includes('보관된 제목만'));assert(await page.locator('#search-filters [name=owner]').isDisabled());assert((await page.locator('.search-results').innerText()).includes('기기에 보관된 제목'));await page.keyboard.press('Escape');await context.setOffline(false);
 console.log('PASS injected race/old-server cases: aborted late query/new modal/new real account, scoped404/403 no fallback, missing capability/404 legacy and real network-offline title label');
}
try{
 await mkdir(proof,{recursive:true});origin=await start();browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
 const setup=await browser.newContext(),owner=(await api(setup,'/accounts')).accounts.find(x=>x.role==='owner'),password='Search-owner-fixture-2026';
 await api(setup,'/accounts',{member_id:owner.id,password});await api(setup,'/accounts/enable',{});await setup.close();
 const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'America/New_York'}),page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForSelector('#login-form');await page.keyboard.press('Control+k');assert.equal(await page.locator('#search-input').count(),0);await page.locator('#login-form [name=email]').fill(owner.email);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form .solid-btn').click();await page.waitForSelector('.recent-grid');
 await search(page);
 if(process.env.FOUNTAIN_SEARCH_CAPTURE_REFERENCE==='1'){
  await page.waitForSelector('.search-result');await page.screenshot({path:join(proof,'reference-1280.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(proof,'reference-390.png')});console.log('PASS original search reference captured (1280/390)');
 }else{
  await page.keyboard.press('Escape');
  if(process.env.FOUNTAIN_SEARCH_VISUAL==='1'){
   // Visual layout fixture only. Real retrieval checks run without this opt-in.
   await context.route('**/api/capabilities',route=>route.fulfill({json:{search_advanced:true}}));
   await context.route('**/api/search/advanced?*',route=>route.fulfill({json:{results:[{type:'page',id:'welcome',title:'가족의 주말 계획',icon:'🌿',snippet:'함께할 일을 정리하고 새로운 아이디어를 모아 보세요.'},{type:'database',id:'projects',title:'우리 팀 프로젝트',snippet:'생각을 실행으로 옮기는 작은 프로젝트'},{type:'row',id:'visual-row',title:'주말 여행지 알아보기',snippet:'교통편과 일정을 함께 확인해요.',database_id:'projects',database_title:'우리 팀 프로젝트'}],total:3,offset:0,limit:20,has_more:false,next_offset:null,result_set:'a'.repeat(64)}}));
   await search(page);await page.waitForSelector('.search-result');await page.screenshot({path:join(proof,'advanced-1280.png')});await page.locator('#search-filter-toggle').click();await page.screenshot({path:join(proof,'advanced-filters-1280.png')});await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);await page.screenshot({path:join(proof,'advanced-filters-390.png')});await page.locator('#search-filter-toggle').click();await page.screenshot({path:join(proof,'advanced-390.png')});console.log('PASS advanced visual fixture captured (not backend retrieval proof)');
  }else await verifySearch(context,page,owner,password);
 }
 assert.deepEqual(errors,[]);
}finally{await browser?.close();server?.kill('SIGTERM');await rm(directory,{recursive:true,force:true});}
