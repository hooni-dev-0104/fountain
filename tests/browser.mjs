/** Browser integration smoke. Uses the bundled Playwright runtime; no npm install. */
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const origin = process.env.FOUNTAIN_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? {executablePath:process.env.FOUNTAIN_CHROME, headless:true} : {channel:'chrome', headless:true});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const suffix = Date.now();
const title = `브라우저 확인 ${suffix}`;
let createdPageId;
let createdRowId;
let createdAttachmentId;
let originalProperties;
async function clickAction(action, extra = '') {
  await page.locator(`[data-action="${action}"]${extra}`).first().click();
}
async function api(path, body, method) {
  const response = await context.request.fetch(origin + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'X-Fountain-Request': '1' },
    ...(body ? { data: body } : {}),
  });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
try {
  await page.goto(origin);
  if (process.env.FOUNTAIN_ACCESS_TOKEN) {
    await page.locator('#login-form input').fill(process.env.FOUNTAIN_ACCESS_TOKEN);
    await page.locator('#login-form button').click();
  }
  await page.waitForSelector('.recent-grid');
  await page.waitForSelector('#home-database tbody tr');
  await mkdir('/tmp/fountain-browser', { recursive: true });
  await page.screenshot({ path: '/tmp/fountain-browser/home-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/fountain-browser/home-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#sidebar').count(), 1);
  await clickAction('add-page');
  await page.locator('#page-form [name="title"]').fill(title);
  await page.locator('#page-form button.solid-btn').click();
  await page.waitForSelector('#page-title');
  createdPageId = await page.evaluate(() => location.hash.split('/')[1]);
  await page.locator('#page-title').fill(title + ' 수정됨');
  await clickAction('home');
  await page.waitForSelector('.recent-grid');
  assert.equal((await api('/pages/' + createdPageId)).page.title, title + ' 수정됨');
  await clickAction('page', `[data-id="${createdPageId}"]`);
  await page.waitForSelector('#page-title');
  await clickAction('add-block');
  await page.locator('.block-content').last().fill('브라우저에서 작성한 실제 문서');
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('모든 변경'));
  await page.reload();
  await page.waitForSelector('#page-title');
  assert.equal(await page.locator('.block-content').first().innerText(), '브라우저에서 작성한 실제 문서');
  await clickAction('add-block');
  await page.locator('.block-content').last().fill('/');
  await page.locator('.slash-menu [data-type="todo"]').click();
  await page.locator('.block-content').last().fill('완료된 작업');
  await page.locator('.block-marker input').last().check();
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('모든 변경'));
  const attachmentText = 'Fountain 첨부 파일 브라우저 확인\n내용을 그대로 보존합니다.\n';
  await page.locator('#attachment-input').setInputFiles({
    name: 'fountain-smoke.txt', mimeType: 'text/plain', buffer: Buffer.from(attachmentText),
  });
  await page.waitForSelector('.attachment-link');
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('모든 변경'));
  const attachmentBlock = (await api('/pages/' + createdPageId)).blocks.find(b => b.type === 'file');
  assert.equal(attachmentBlock.text, 'fountain-smoke.txt');
  assert.equal(attachmentBlock.size, Buffer.byteLength(attachmentText));
  createdAttachmentId = attachmentBlock.attachment_id;
  assert.equal(await page.locator('.attachment-link[contenteditable]').count(), 0);
  const attachmentDownload = page.waitForEvent('download');
  await page.locator('.attachment-link').click();
  const savedAttachment = await attachmentDownload;
  assert.equal(savedAttachment.suggestedFilename(), 'fountain-smoke.txt');
  assert.equal((await readFile(await savedAttachment.path())).toString(), attachmentText);
  await clickAction('page-menu');
  await clickAction('lock-page');
  await page.waitForFunction(() => document.querySelector('#page-title')?.getAttribute('contenteditable') === 'false');
  assert.equal(await page.locator('#attachment-input').count(), 0);
  assert.equal(await page.locator('[data-action="add-file"]').count(), 0);
  await clickAction('page-menu');
  await clickAction('lock-page');
  await page.waitForSelector('#attachment-input', { state: 'attached' });
  await page.locator('#comment-form input').fill('가족과 공유할 메모');
  await page.locator('#comment-form button').click();
  await page.waitForSelector('.comment-item');
  await clickAction('history');
  await page.waitForSelector('.history-item');
  assert.ok(await page.locator('.history-item').count() > 0);
  await clickAction('close-modal');
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').fill(title);
  await page.waitForFunction(t => document.querySelector('.search-result')?.textContent.includes(t), title);
  assert.ok((await page.locator('.search-result').first().innerText()).includes(title));
  await page.keyboard.press('Escape');
  await clickAction('database', '[data-id="projects"]');
  await page.waitForSelector('.db-full');
  await clickAction('add-row');
  await page.locator('#row-form [name="name"]').fill(title);
  await page.locator('#row-form [name="status"]').selectOption({ label: '진행 중' });
  await page.locator('#row-form button.solid-btn').click();
  await page.waitForFunction(t => [...document.querySelectorAll('.data-table td')].some(td => td.textContent.includes(t)), title);
  const db = await api('/databases/projects');
  createdRowId = db.rows.find(r => r.properties.name === title)?.id;
  assert.ok(createdRowId);
  originalProperties = db.database.properties;
  await api('/databases/projects', {
    properties: [...originalProperties,
      { id: 'smoke_done', name: '완료 확인', type: 'checkbox' },
      { id: 'smoke_labels', name: '태그 확인', type: 'multi_select', options: ['가족', '개인'] },
      { id: 'smoke_files', name: '파일 확인', type: 'files' },
    ],
  }, 'PATCH');
  await page.reload();
  await page.waitForSelector('.db-full');
  await clickAction('edit-row', `[data-id="${createdRowId}"]`);
  await page.locator('#row-form [name="smoke_done"]').check();
  await page.locator('#row-form [name="smoke_labels"]').fill('가족, 개인');
  await page.locator('#row-form [name="smoke_files"]').fill(createdAttachmentId);
  await page.locator('#row-form button.solid-btn').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  const typedRow = (await api('/databases/projects')).rows.find(r => r.id === createdRowId);
  assert.equal(typedRow.properties.smoke_done, true);
  assert.deepEqual(typedRow.properties.smoke_labels, ['가족', '개인']);
  assert.deepEqual(typedRow.properties.smoke_files, [createdAttachmentId]);
  await api('/databases/projects', { properties: originalProperties }, 'PATCH');
  originalProperties = null;
  await page.reload();
  await page.waitForSelector('.db-full');

  for (const view of ['board', 'calendar', 'gallery', 'chart', 'table']) {
    await clickAction('db-view', `[data-view="${view}"]`);
    await page.waitForSelector('#db-view');
  }
  await clickAction('filter');
  await page.locator('#db-filter-input').fill(title);
  assert.equal(await page.locator('.data-table tbody tr').count(), 1);
  await clickAction('clear-filter');
  await clickAction('settings');
  await page.waitForSelector('#settings-content');
  for (const tab of ['security', 'automations', 'forms', 'sites', 'AI', 'analytics', 'features', 'export']) {
    await clickAction('settings-tab', `[data-tab="${tab}"]`);
    await page.waitForTimeout(80);
    assert.ok((await page.locator('#settings-content').innerText()).length > 20, tab);
  }
  const backupDownload = page.waitForEvent('download');
  await clickAction('backup');
  const backup = await backupDownload;
  assert.equal((await readFile(await backup.path())).subarray(0, 16).toString(), 'SQLite format 3\0');
  await clickAction('settings-tab', '[data-tab="security"]');
  await page.locator('#security-form button.solid-btn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('설정을 저장'));
  await clickAction('close-modal');
  await clickAction('ai');
  await page.locator('#ai-form textarea').fill('내용을 요약해 주세요.');
  await page.locator('#ai-form button').click();
  await page.waitForFunction(() => document.querySelector('#ai-output').textContent.trim().length > 0 && !document.querySelector('#ai-output').textContent.includes('준비하고'));
  await clickAction('close-modal');
  await clickAction('home');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.waitForSelector('.recent-grid');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile overflow');
  await clickAction('toggle-sidebar');
  await page.waitForFunction(() => document.body.classList.contains('sidebar-open'));
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS: page CRUD, block autosave + slash + todo, attachment upload/download + locked page + full backup, comments, history, search, project CRUD + typed properties, five database views, filter, settings, AI configuration, mobile layout');
  console.log('Screenshots: /tmp/fountain-browser/home-desktop.png /tmp/fountain-browser/home-mobile.png');
} finally {
  if (originalProperties) await api('/databases/projects', { properties: originalProperties }, 'PATCH').catch(() => {});
  if (createdPageId) await api('/pages/' + createdPageId, {}, 'DELETE').catch(() => {});
  if (createdAttachmentId) await api('/attachments/' + createdAttachmentId, {}, 'DELETE').catch(() => {});
  if (createdRowId) await api('/databases/projects/rows/' + createdRowId, {}, 'DELETE').catch(() => {});
  await browser.close();
}
