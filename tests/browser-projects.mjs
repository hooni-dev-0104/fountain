import { waitForAsync } from './async-browser.mjs';
/** Disposable end-to-end project graph, timeline and real scheduler verification. */
import {
  createRequire
}
from 'node:module';
import {
  spawn
}
from 'node:child_process';
import {
  mkdtemp, rm, mkdir
}
from 'node:fs/promises';
import {
  homedir, tmpdir
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
const require=createRequire(import.meta.url);
const {
  chromium
}
=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const temporary=await mkdtemp(join(tmpdir(),'fountain-project-browser-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin,context,page;
const errors=[];
async function startServer() {
  const environment= {
    ...process.env
  };
  delete environment.FOUNTAIN_ACCESS_TOKEN;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(temporary,'workspace.db')], {
    cwd:fileURLToPath(new URL('..',import.meta.url)),env:environment,stdio:['ignore','pipe','pipe']
  });
  return new Promise((resolve,reject)=> {
    let output=''; const timer=setTimeout(()=>reject(new Error('Server startup timed out: '+output)),15000); const accept=chunk=> {
      output+=chunk.toString(); const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/); if(match) {
        clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]);
      }
    }; server.stdout.on('data',accept); server.stderr.on('data',accept); server.once('error',error=> {
      clearTimeout(timer); reject(error);
    }); server.once('exit',code=> {
      clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`));
    });
  });
}
async function api(path,body,method) {
  const response=await context.request.fetch(origin+'/api'+path, {
    method:method||(body?'POST':'GET'),headers: {
      'X-Fountain-Request':'1'
    },...(body? {
      data:body
    }
    : {
    })
  });
  assert.ok(response.ok(),`${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function action(name,suffix='') {
  await page.locator(`[data-action="${name}"]${suffix}`).first().click();
}
async function saveRow() {
  await page.locator('#row-form .solid-btn').click();
  await page.waitForSelector('#row-form', {
    state:'detached'
  });
}
async function createRow(name,start='',end='',parent='',dependencies=[]) {
  await action('add-row');
  await page.locator('#row-form [name="name"]').fill(name);
  if(start)await page.locator('#row-form [name="due"]').fill(start);
  if(end)await page.locator('#row-form [name="due__end"]').fill(end);
  if(parent)await page.locator('#row-form [name="parent_row_id"]').selectOption(parent);
  if(dependencies.length)await page.locator('#row-form [name="depends_on"]').selectOption(dependencies);
  await saveRow();
  return (await api('/databases/'+databaseId)).rows.find(row=>row.properties.name===name);
}
const today=Math.floor(Date.now()/86_400_000);
const monday=today+((8-new Date(today*86_400_000).getUTCDay())%7||7);
const day=offset=>new Date((monday+offset)*86_400_000).toISOString().slice(0,10);
function localInput(instant,timezone) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date(instant)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${parts.second==='00'?'':':'+parts.second}`;
}
assert.equal(localInput(Date.UTC(2026,0,2,3,4,0),'Asia/Seoul'),'2026-01-02T12:04','datetime-local uses its canonical minute form for zero seconds');
assert.equal(localInput(Date.UTC(2026,0,2,3,4,5),'Asia/Seoul'),'2026-01-02T12:04:05','nonzero schedule seconds keep their exact precision');
let databaseId;
try {
  origin=await startServer();
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME? {
    executablePath:process.env.FOUNTAIN_CHROME,headless:true
  }
  : {
    channel:'chrome',headless:true
  });
  context=await browser.newContext( {
    viewport: {
      width:1440,height:1100
    }
  });
  page=await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.waitForSelector('.recent-grid');
  await action('new-database');
  await page.locator('#database-form [name="name"]').fill('함께 만드는 가을 프로젝트');
  await page.locator('#database-form .solid-btn').click();
  await page.waitForSelector('.db-full');
  databaseId=await page.evaluate(()=>location.hash.split('/')[1]);
  await action('task-settings');
  await page.locator('#task-settings-form [name="subitems"]').check();
  await page.locator('#task-settings-form [name="dependencies"]').check();
  await page.locator('#task-settings-form [name="shift"]').selectOption('maintain');
  await page.locator('#task-settings-form .solid-btn').click();
  await page.waitForSelector('#task-settings-form', {
    state:'detached'
  });
  assert.equal((await api('/databases/'+databaseId)).database.task_settings.shift,'maintain');
  const parent=await createRow('출시 준비',day(0),day(2));
  const child=await createRow('콘텐츠 제작',day(3),day(4),parent.id,[parent.id]);
  const successor=await createRow('검수 및 배포',day(7),day(8),'',[child.id]);
  await createRow('아직 날짜가 없는 아이디어');
  await action('edit-row',`[data-id="${parent.id}"]`);
  await page.locator('#row-form [name="due"]').fill(day(2));
  await page.locator('#row-form [name="due__end"]').fill(day(4));
  await saveRow();
  let detail=await api('/databases/'+databaseId);
  assert.deepEqual(detail.rows.find(row=>row.id===child.id).properties.due, {
    start:day(5),end:day(6)
  });
  assert.deepEqual(detail.rows.find(row=>row.id===successor.id).properties.due, {
    start:day(9),end:day(10)
  });
  // Editing a different property must not truncate an existing aware datetime.
  const awareDate= {
    start:day(11)+'T09:30:00+09:00',end:day(12)+'T14:45:00+09:00'
  };
  const aware=await api('/databases/'+databaseId+'/rows', {
    properties: {
      name:'시간이 있는 일정',due:awareDate
    }
  });
  await page.reload();
  await page.waitForSelector('.db-full');
  await action('edit-row',`[data-id="${aware.id}"]`);
  await page.locator('#row-form [name="name"]').fill('시간이 보존된 일정');
  await saveRow();
  assert.deepEqual((await api('/databases/'+databaseId)).rows.find(row=>row.id===aware.id).properties.due,awareDate);
  // Hierarchy folding affects real rows in both table and list.
  await action('toggle-subitems',`[data-id="${parent.id}"]`);
  assert.equal(await page.locator(`tr[data-id="${child.id}"]`).count(),0);
  await action('toggle-subitems',`[data-id="${parent.id}"]`);
  assert.equal(await page.locator(`tr[data-id="${child.id}"]`).count(),1);
  await action('db-view','[data-view="list"]');
  await page.waitForSelector('.task-list');
  assert.equal(await page.locator('.task-list-row').count(),5);
  await action('toggle-subitems',`[data-id="${parent.id}"]`);
  assert.equal(await page.locator(`.task-list-row[data-id="${child.id}"]`).count(),0);
  await action('toggle-subitems',`[data-id="${parent.id}"]`);
  await page.locator(`.task-list-row[data-id="${child.id}"]`).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#row-form [name="parent_row_id"]').inputValue(),parent.id);
  assert.deepEqual(await page.locator('#row-form [name="depends_on"]').evaluate(select=>[...select.selectedOptions].map(option=>option.value)),[parent.id]);
  await action('close-modal');
  // A graph cycle is rejected by the actual backend and retained for recovery.
  await action('edit-row',`[data-id="${parent.id}"]`);
  await page.locator('#row-form [name="depends_on"]').selectOption(child.id);
  const cycleResponse=page.waitForResponse(async response=>{
    if(!response.url().endsWith('/api/sync')||response.request().method()!=='POST')return false;
    const operation=response.request().postDataJSON()?.operations?.find(operation=>operation.kind==='row.patch'&&operation.target_id===parent.id);
    if(!operation)return false;
    const payload=await response.json();
    return payload.results?.some(result=>result.id===operation.id&&result.status==='invalid'&&result.http_status===400);
  });
  await page.locator('#row-form .solid-btn').click();
  const rejected=await cycleResponse;
  assert.equal(rejected.status(),200);
  await waitForAsync(page,async id=>(await state.mutations.records()).some(record=>record.status==='invalid'&&record.operation.target_id===id),parent.id);
  assert.equal(await page.locator('#row-form').count(),1,'online validation errors must keep the editing form open');
  const recovery=await page.evaluate(async id=>(await state.mutations.records()).find(record=>record.status==='invalid'&&record.operation.target_id===id),parent.id);
  assert.ok(recovery,'invalid graph intent must remain in durable recovery');
  assert.deepEqual(recovery.operation.body.depends_on,[child.id]);
  assert.deepEqual((await api('/databases/'+databaseId)).rows.find(row=>row.id===parent.id).depends_on,[],'rejected cycle must not change the canonical graph');
  await action('close-modal');
  await action('db-view','[data-view="timeline"]');
  await page.waitForSelector('.timeline-bar');
  assert.equal(await page.locator('.timeline-bar').count(),4);
  assert.equal(await page.locator('.timeline-unscheduled .task-list-row').count(),1);
  assert.ok(await page.locator('.timeline-today').count()>0);
  const parentBar=page.locator(`.timeline-bar[data-id="${parent.id}"]`);
  assert.ok((await parentBar.getAttribute('aria-label')).includes(day(2)));
  assert.equal(await parentBar.evaluate(element=>parseFloat(element.style.width)),102);
  await page.locator('#timeline-zoom').selectOption('week');
  assert.ok(await page.locator('.timeline-tick').count()>1);
  await action('timeline-today');
  await action('timeline-fit');
  await page.locator('#timeline-zoom').selectOption('day');
  await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('visible'));
  await mkdir('/tmp/fountain-browser', {
    recursive:true
  });
  await page.screenshot( {
    path:'/tmp/fountain-browser/projects-timeline-desktop.png',fullPage:true
  });
  await page.setViewportSize( {
    width:390,height:844
  });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'timeline body overflow');
  assert.ok(await page.locator('.timeline-scroll').evaluate(element=>element.scrollWidth>element.clientWidth));
  await page.screenshot( {
    path:'/tmp/fountain-browser/projects-timeline-mobile.png',fullPage:true
  });
  await page.setViewportSize( {
    width:1440,height:1100
  });
  await page.waitForTimeout(300);
  // The timeline date-property selector uses actual values from another property.
  await action('new-property');
  await page.locator('#property-form [name="name"]').fill('공개일');
  await page.locator('#property-form [name="type"]').selectOption('date');
  await page.locator('#property-form .solid-btn').click();
  await page.waitForSelector('#property-form', {
    state:'detached'
  });
  const alternate=(await api('/databases/'+databaseId)).database.properties.find(property=>property.name==='공개일');
  await api('/databases/'+databaseId+'/rows/'+parent.id, {
    properties: {
      [alternate.id]:day(14)
    }
  },'PATCH');
  await page.reload();
  await page.waitForSelector('.db-full');
  await action('db-view','[data-view="timeline"]');
  await page.locator('#timeline-property').selectOption(alternate.id);
  assert.equal(await page.locator('.timeline-bar').count(),1);
  assert.equal(await page.locator('.timeline-unscheduled .task-list-row').count(),4);
  // Duplicate a real subtree, remap internal links, then remove only those copies.
  await action('db-view','[data-view="table"]');
  await action('edit-row',`[data-id="${parent.id}"]`);
  const duplicateResponse=page.waitForResponse(response=>response.url().endsWith('/rows/'+parent.id+'/duplicate')&&response.request().method()==='POST');
  await action('duplicate-row');
  const duplicated=await duplicateResponse;
  assert.equal(duplicated.status(),201);
  const copies=await duplicated.json();
  assert.equal(copies.rows.length,2);
  await page.waitForFunction(id=>document.querySelector('#row-form')?.dataset.id===id,copies.root_id);
  const copiedChild=copies.rows.find(row=>row.parent_row_id===copies.root_id);
  assert.ok(copiedChild);
  assert.deepEqual(copiedChild.depends_on,[copies.root_id]);
  assert.equal((await api('/databases/'+databaseId)).rows.length,7);
  await action('close-modal');
  await api('/databases/'+databaseId+'/rows/'+copies.root_id, {
  },'DELETE');
  assert.ok(!(await api('/databases/'+databaseId)).rows.some(row=>copies.rows.some(copy=>copy.id===row.id)));
  await page.reload();
  await page.waitForSelector('.db-full');
  // Deleting a parent displays a concrete cascade notice and deletes its child.
  await action('db-view','[data-view="table"]');
  const disposableParent=await createRow('삭제할 상위 항목');
  const disposableChild=await createRow('함께 삭제할 하위 항목','','',disposableParent.id);
  await action('edit-row',`[data-id="${disposableParent.id}"]`);
  await action('delete-row');
  await page.waitForSelector('[data-action="confirm-delete-row"]');
  await action('confirm-delete-row');
  await page.waitForSelector('.modal', {
    state:'detached'
  });
  detail=await api('/databases/'+databaseId);
  assert.ok(!detail.rows.some(row=>[disposableParent.id,disposableChild.id].includes(row.id)));
  // The real server scheduler runs a minute-frequency automation at a near-future first time.
  await action('settings');
  await action('settings-tab','[data-tab="automations"]');
  await action('add-advanced','[data-kind="automations"]');
  await page.locator('#advanced-form [name="name"]').fill('가족 프로젝트 예약 확인');
  await page.locator('#advanced-form [name="database_id"]').selectOption(databaseId);
  await page.locator('#advanced-form [name="trigger"]').selectOption('scheduled');
  await page.waitForSelector('#automation-schedule-fields', {
    state:'visible'
  });
  await page.locator('#advanced-form [name="schedule_frequency"]').selectOption('minutes');
  await page.locator('#advanced-form [name="schedule_interval"]').fill('1');
  await page.locator('#advanced-form [name="schedule_timezone"]').fill('Asia/Seoul');
  await page.locator('#advanced-form [name="actions"]').fill(JSON.stringify([ {
    type:'create_row',values: {
      name:'예약으로 생성한 항목',status:'완료'
    }
  }]));
  await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('visible'));
  await page.screenshot( {
    path:'/tmp/fountain-browser/projects-schedule-desktop.png',fullPage:true
  });
  await page.setViewportSize( {
    width:390,height:844
  });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>document.querySelector('.modal').scrollWidth<=document.querySelector('.modal').clientWidth),'schedule modal overflow');
  await page.screenshot( {
    path:'/tmp/fountain-browser/projects-schedule-mobile.png',fullPage:true
  });
  await page.setViewportSize( {
    width:1440,height:1100
  });
  await page.waitForTimeout(300);
  const firstRun=Math.floor((Date.now()+3500)/1000)*1000;
  await page.locator('#advanced-form [name="schedule_start_at"]').fill(localInput(firstRun,'Asia/Seoul'));
  await page.locator('#advanced-form .solid-btn').click();
  await page.waitForSelector('#settings-content');
  let automation=(await api('/advanced')).automations.find(item=>item.name==='가족 프로젝트 예약 확인');
  assert.ok(automation);
  assert.equal(Date.parse(automation.schedule.start_at),firstRun);
  const deadline=Date.now()+10_000;
  let runs=[];
  while(Date.now()<deadline) {
    runs=(await api('/automations/'+automation.id+'/runs')).runs;
    if(runs.some(run=>run.status==='succeeded'||run.status==='failed'))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(runs.some(run=>run.status==='succeeded'),JSON.stringify(runs));
  assert.equal((await api('/databases/'+databaseId)).rows.filter(row=>row.properties.name==='예약으로 생성한 항목').length,1);
  await action('automation-runs',`[data-id="${automation.id}"]`);
  await page.waitForSelector('.automation-run');
  assert.ok((await page.locator('#automation-runs').innerText()).includes('성공'));
  await action('automation-settings');
  await action('toggle-automation',`[data-id="${automation.id}"]`);
  automation=(await api('/advanced')).automations.find(item=>item.id===automation.id);
  assert.equal(automation.enabled,false);
  await page.waitForFunction(id=>document.querySelector(`[data-action="run-automation"][data-id="${id}"]`)?.disabled,automation.id);
  assert.equal(await page.locator(`[data-action="run-automation"][data-id="${automation.id}"]`).isDisabled(),true);
  await action('toggle-automation',`[data-id="${automation.id}"]`);
  await page.waitForFunction(()=>document.querySelector('[data-action="run-automation"]:not([disabled])'));
  await action('run-automation',`[data-id="${automation.id}"]`);
  await page.locator('#run-automation-form .solid-btn').click();
  await page.waitForSelector('#settings-content');
  assert.equal((await api('/databases/'+databaseId)).rows.filter(row=>row.properties.name==='예약으로 생성한 항목').length,2);
  // Calendar-year recurrence and a finite end are sent through the same real settings form.
  await action('edit-advanced',`[data-kind="automations"][data-id="${automation.id}"]`);
  await page.locator('#advanced-form [name="schedule_frequency"]').selectOption('years');
  const endAt=Math.floor((firstRun+370*24*60*60*1000)/1000)*1000;
  await page.locator('#advanced-form [name="schedule_end_at"]').fill(localInput(endAt,'Asia/Seoul'));
  await page.locator('#advanced-form .solid-btn').click();
  await page.waitForSelector('#settings-content');
  const yearly=(await api('/advanced')).automations.find(item=>item.id===automation.id);
  assert.equal(yearly.schedule.frequency,'years');
  assert.equal(Date.parse(yearly.schedule.end_at),endAt);
  assert.deepEqual(errors,[],'browser runtime errors');
  console.log('PASS: task hierarchy/dependencies, real date shifting, datetime preservation, cycle validation, table/list folding, real timeline bars/field/mobile scroll, subtree duplication/cascade deletion, timezone schedule UI, automatic execution + run history + pause + manual execution');
  console.log('Screenshots: /tmp/fountain-browser/projects-{timeline,schedule}-{desktop,mobile}.png');
}
catch(error) {
  if(page)await page.screenshot( {
    path:'/tmp/fountain-browser/projects-failure.png',fullPage:true
  }).catch(()=> {
  });
  throw error;
}
finally {
  if(browser)await browser.close();
  if(server&&server.exitCode===null) {
    server.kill('SIGTERM');
    await new Promise(resolve=> {
      server.once('exit',resolve); setTimeout(resolve,3000);
    });
  }
  await rm(temporary, {
    recursive:true,force:true
  });
}
