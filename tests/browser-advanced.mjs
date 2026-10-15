/** Family login and real form/site/automation journeys against a running test server. */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const origin = process.env.FOUNTAIN_URL || 'http://127.0.0.1:8788';
const password = process.env.FOUNTAIN_ACCESS_TOKEN;
assert.ok(password, 'Use a disposable test server with FOUNTAIN_ACCESS_TOKEN');
const browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? {executablePath:process.env.FOUNTAIN_CHROME} : {channel:'chrome'});
const context = await browser.newContext();
// A LAN HTTP origin lacks randomUUID; block creation must still work.
await context.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', {value:undefined, configurable:true}); });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const cleanup = [];
async function api(path, body, method) {
  const response = await context.request.fetch(origin + '/api' + path, {method:method || (body ? 'POST' : 'GET'), headers:{'X-Fountain-Request':'1'}, ...(body ? {data:body} : {})});
  assert.ok(response.ok(), path + ': ' + response.status() + ' ' + await response.text());
  return response.json();
}
try {
  await page.goto(origin);
  await page.locator('#login-form input').fill(password);
  await page.locator('#login-form button').click();
  await page.waitForSelector('.recent-grid');
  const cookie = (await context.cookies()).find(c => c.name === 'fountain_session');
  assert.ok(cookie?.httpOnly && cookie.sameSite === 'Strict');

  const automation = await api('/automations', {name:'테스트 자동화', database_id:'projects', trigger:'row.created', actions:[{type:'set_property',property_id:'status',value:'진행 중'}]});
  cleanup.push(['/automations/' + automation.id, 'DELETE']);
  const form = await api('/forms', {name:'가족 요청', published:true, fields:[
    {id:'name', label:'제목', required:true, property_id:'name'},
    {id:'priority', label:'중요도', type:'select', options:['높음','보통'], property_id:'priority'},
    {id:'due', label:'마감일', type:'date', required:true, property_id:'due', condition:{field:'priority',equals:'높음'}}]});
  cleanup.push(['/forms/' + form.id, 'DELETE']);
  await page.goto(origin + '/forms/' + form.id);
  assert.equal(await page.locator('label[data-condition]').isVisible(), false);
  await page.locator('[name=name]').fill('브라우저 양식 제출');
  await page.locator('[name=priority]').selectOption('높음');
  assert.equal(await page.locator('label[data-condition]').isVisible(), true);
  await page.locator('[name=due]').fill('2026-11-01');
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#form-status').textContent.includes('제출되었습니다'));
  const rows = (await api('/databases/projects')).rows;
  const row = rows.find(row => row.properties.name === '브라우저 양식 제출');
  assert.ok(row);
  assert.equal(row.properties.status, '진행 중');
  cleanup.push(['/databases/projects/rows/' + row.id, 'DELETE']);

  const doc = await api('/pages', {title:'공개 HTML 테스트',blocks:[{type:'paragraph',text:'<script>window.bad = true</script>'}]});
  cleanup.push(['/pages/' + doc.id, 'DELETE']);
  const site = await api('/sites', {name:'가족 사이트',page_id:doc.id,published:true,slug:'browser-' + Date.now()});
  cleanup.push(['/sites/' + site.id, 'DELETE']);
  await page.goto(origin + '/sites/' + site.slug);
  assert.equal(await page.locator('main p').innerText(), '<script>window.bad = true</script>');
  assert.equal(await page.evaluate(() => window.bad), undefined);

  await page.goto(origin + '/#page/' + doc.id);
  await page.waitForSelector('#page-title');
  await page.locator('[data-action=add-block]').click();
  await page.locator('.block-content').last().fill('LAN 저장');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('모든 변경'));
  assert.equal((await api('/pages/' + doc.id)).blocks.at(-1).text, 'LAN 저장');
  await page.locator('[data-action=page-menu]').click();
  await page.locator('[data-action=verify-page]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('검증했습니다'));
  assert.ok((await api('/pages/' + doc.id)).page.verification);

  await page.route('**/api/pages/' + doc.id, async route => {
    if (route.request().method() === 'PATCH') await new Promise(resolve => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.locator('#page-title').fill('전환 중 보존된 제목');
  await page.waitForTimeout(500); // title debounce starts a delayed metadata request
  await page.locator('[data-action=home]').first().click();
  await page.waitForSelector('.recent-grid');
  assert.equal((await api('/pages/' + doc.id)).page.title, '전환 중 보존된 제목');
  await page.goBack();
  await page.waitForSelector('#page-title');
  assert.equal(await page.locator('#page-title').innerText(), '전환 중 보존된 제목');
  assert.deepEqual(errors, []);
  console.log('PASS: family cookie login, conditional form, submission automation, escaped publishing, LAN UUID fallback, verification, delayed title save and browser back');
} finally {
  for (const [path, method] of cleanup.reverse()) await api(path, {}, method).catch(() => {});
  await context.request.delete(origin + '/api/session', {headers:{'X-Fountain-Request':'1'}});
  const unauthorized = await context.request.get(origin + '/api/workspace');
  assert.equal(unauthorized.status(), 401);
  await browser.close();
}
