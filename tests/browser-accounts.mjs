/** Starts a disposable workspace and verifies member login and enforced sharing. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const temporary = await mkdtemp(join(tmpdir(), 'fountain-accounts-browser-'));
const python = process.env.FOUNTAIN_PYTHON || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server;
let browser;
const errors = [];
async function startServer() {
  // Never enable account requirements in the user's existing workspace.
  const environment = { ...process.env };
  delete environment.FOUNTAIN_ACCESS_TOKEN;
  server = spawn(python, ['-m', 'fountain.server', '--port', '0', '--data', join(temporary, 'workspace.db')], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Disposable server startup timed out: ' + output)), 15000);
    const accept = chunk => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    };
    server.stdout.on('data', accept);
    server.stderr.on('data', accept);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
}
async function action(page, name, suffix = '') {
  await page.locator(`[data-action="${name}"]${suffix}`).first().click();
}
async function request(context, origin, path, body, method) {
  return context.request.fetch(origin + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'), headers: { 'X-Fountain-Request': '1' }, ...(body ? { data: body } : {}),
  });
}
async function json(context, origin, path, body, method) {
  const response = await request(context, origin, path, body, method);
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function login(page, email, password) {
  await page.waitForSelector('#login-form [name="email"]');
  await page.locator('#login-form [name="email"]').fill(email);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form button.solid-btn').click();
  await page.waitForSelector('#sidebar .brand');
}
async function password(page, id, value) {
  await action(page, 'account-password', `[data-id="${id}"]`);
  await page.locator('#account-password-form [name="password"]').fill(value);
  await page.locator('#account-password-form [name="password_confirm"]').fill(value);
  await page.locator('#account-password-form .solid-btn').click();
  await page.waitForSelector('[data-action="account-password"]');
}
async function share(page, memberId, level) {
  await action(page, 'share');
  await page.locator('#permissions-form [name="default"]').selectOption('private');
  await page.locator('#permissions-form [name="inherit"]').uncheck();
  await page.locator(`#permissions-form [data-acl-kind="members"][data-acl-id="${memberId}"]`).selectOption(level);
  await page.locator('#permissions-form .solid-btn').click();
  await page.waitForSelector('#permissions-form', { state: 'detached' });
  await page.waitForSelector('#page-title');
}
try {
  const origin = await startServer();
  browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const owner = await ownerContext.newPage();
  owner.on('pageerror', error => errors.push(error.message));
  await owner.goto(origin);
  await owner.waitForSelector('.recent-grid');
  const bootstrap = await json(ownerContext, origin, '/session');
  assert.equal(bootstrap.mode, 'local');
  assert.equal(bootstrap.member.role, 'owner');
  await action(owner, 'settings');
  await action(owner, 'settings-tab', '[data-tab="accounts"]');
  const initialAccounts = await json(ownerContext, origin, '/accounts');
  assert.equal(initialAccounts.required, false);
  assert.ok(initialAccounts.accounts.every(account => !account.has_account));
  const ownerAccount = initialAccounts.accounts.find(account => account.role === 'owner');
  const ownerPassword = 'Owner-browser-passphrase-2026';
  const memberPassword = 'Family-browser-passphrase-2026';
  await password(owner, ownerAccount.id, ownerPassword);
  await action(owner, 'account-add-member');
  await owner.locator('#advanced-form [name="name"]').fill('가족 멤버');
  await owner.locator('#advanced-form [name="email"]').fill('family@example.local');
  await owner.locator('#advanced-form [name="role"]').selectOption('member');
  await owner.locator('#advanced-form .solid-btn').click();
  await owner.waitForSelector('#settings-tabs');
  await action(owner, 'settings-tab', '[data-tab="accounts"]');
  const accounts = await json(ownerContext, origin, '/accounts');
  const memberAccount = accounts.accounts.find(account => account.email === 'family@example.local');
  assert.ok(memberAccount);
  await password(owner, memberAccount.id, memberPassword);
  const safeAccounts = await json(ownerContext, origin, '/accounts');
  assert.ok(safeAccounts.accounts.every(account => !('password' in account) && !('password_hash' in account) && !('salt' in account)));
  await action(owner, 'enable-accounts');
  await action(owner, 'confirm-enable-accounts');
  await owner.waitForSelector('#login-form [name="email"]');
  assert.equal((await request(ownerContext, origin, '/workspace')).status(), 401);
  await mkdir('/tmp/fountain-browser', { recursive: true });
  await owner.screenshot({ path: '/tmp/fountain-browser/accounts-login.png', fullPage: true });
  await login(owner, ownerAccount.email, ownerPassword);
  assert.equal((await json(ownerContext, origin, '/session')).member.id, ownerAccount.id);
  await action(owner, 'add-page');
  await owner.locator('#page-form [name="title"]').fill('가족과 나누는 비공개 기록');
  await owner.locator('#page-form .solid-btn').click();
  await owner.waitForSelector('#page-title');
  const pageId = await owner.evaluate(() => location.hash.split('/')[1]);
  await action(owner, 'add-block');
  await owner.locator('.block-content').last().fill('소유자가 작성한 비공개 문서입니다.');
  await owner.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('모든 변경'));
  await share(owner, memberAccount.id, 'view');
  const permissions = await json(ownerContext, origin, '/pages/' + pageId + '/permissions');
  assert.equal(permissions.permissions.default, 'private');
  assert.equal(permissions.permissions.inherit, false);
  assert.equal(permissions.permissions.members[memberAccount.id], 'view');
  const memberContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const member = await memberContext.newPage();
  member.on('pageerror', error => errors.push(error.message));
  await member.goto(origin + '/#page/' + pageId);
  await login(member, memberAccount.email, memberPassword);
  await member.waitForSelector('#page-title');
  assert.equal(await member.locator('#page-title').getAttribute('contenteditable'), 'false');
  assert.equal(await member.locator('.block-content').first().innerText(), '소유자가 작성한 비공개 문서입니다.');
  assert.equal(await member.locator('[data-action="add-block"]').count(), 0);
  assert.equal(await member.locator('#comment-form').count(), 0);
  const memberDetail = await json(memberContext, origin, '/pages/' + pageId);
  assert.equal(memberDetail.page.access_level, 1);
  for (const [path, body, method] of [
    ['/pages/' + pageId + '/blocks', { blocks: [], revision: memberDetail.page.revision }, 'PUT'],
    ['/pages/' + pageId, { title: '권한 없는 편집' }, 'PATCH'],
    ['/pages/' + pageId + '/comments', { text: '권한 없는 댓글' }, 'POST'],
    ['/accounts', undefined, 'GET'],
    ['/settings', { name: '권한 없는 변경' }, 'PATCH'],
  ]) assert.equal((await request(memberContext, origin, path, body, method)).status(), 403, path);
  const sanitized = await json(memberContext, origin, '/advanced');
  assert.deepEqual(sanitized.audit, []);
  assert.deepEqual(sanitized.integrations, []);
  await action(member, 'settings');
  assert.equal(await member.locator('#settings-tabs').count(), 0);
  assert.equal(await member.locator('[data-action="account-password"]').count(), 0);
  await action(member, 'close-modal');
  await action(member, 'share');
  assert.equal(await member.locator('#permissions-form .solid-btn').count(), 0);
  assert.equal(await member.locator('#permissions-form [name="default"]').isDisabled(), true);
  await member.screenshot({ path: '/tmp/fountain-browser/accounts-member-readonly.png', fullPage: true });
  await action(member, 'close-modal');
  await share(owner, memberAccount.id, 'comment');
  await member.reload();
  await member.waitForSelector('#comment-form');
  assert.equal(await member.locator('#page-title').getAttribute('contenteditable'), 'false');
  await member.locator('#comment-form input').fill('허용된 가족 댓글입니다.');
  await member.locator('#comment-form button').click();
  await member.waitForSelector('.comment-item');
  await share(owner, memberAccount.id, 'edit');
  await member.reload();
  await member.waitForSelector('#page-title[contenteditable="true"]');
  await member.locator('.block-content').first().fill('가족이 함께 편집한 문서입니다.');
  await member.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('모든 변경'));
  assert.equal((await json(ownerContext, origin, '/pages/' + pageId)).blocks[0].text, '가족이 함께 편집한 문서입니다.');
  await share(owner, memberAccount.id, 'none');
  assert.equal((await json(memberContext, origin, '/workspace')).pages.some(page => page.id === pageId), false);
  assert.equal((await json(memberContext, origin, '/search?q=비공개')).results.some(page => page.id === pageId), false);
  const deniedRead = await request(memberContext, origin, '/pages/' + pageId);
  assert.ok([403, 404].includes(deniedRead.status()));
  await owner.reload();
  await owner.waitForSelector('#page-title');
  await action(owner, 'share');
  await owner.screenshot({ path: '/tmp/fountain-browser/accounts-owner-permissions.png', fullPage: true });
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.waitForTimeout(300);
  assert.ok(await owner.evaluate(() => document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth), 'permissions modal mobile overflow');
  await owner.screenshot({ path: '/tmp/fountain-browser/accounts-owner-permissions-mobile.png', fullPage: true });
  await owner.setViewportSize({ width: 1440, height: 1000 });
  await owner.waitForTimeout(300);
  await action(owner, 'close-modal');
  // Real assigned-row policy: other people's rows are neither listed nor editable.
  const ownRow = await json(ownerContext, origin, '/databases/projects/rows', { properties: { name: '내 담당 항목', assignee: memberAccount.id } });
  const otherRow = await json(ownerContext, origin, '/databases/projects/rows', { properties: { name: '다른 가족 항목', assignee: ownerAccount.id } });
  await action(owner, 'database', '[data-id="projects"]');
  await owner.waitForSelector('.db-full');
  await action(owner, 'db-share');
  await owner.locator('#permissions-form [name="row_mode"]').selectOption('assigned');
  await owner.locator('#permissions-form [name="property_id"]').selectOption('assignee');
  await owner.locator('#permissions-form [name="allow_create"]').uncheck();
  await owner.locator('#permissions-form .solid-btn').click();
  await owner.waitForSelector('#permissions-form', { state: 'detached' });
  await member.goto(origin + '/#database/projects');
  await member.waitForSelector('.db-full');
  const visibleRows = (await json(memberContext, origin, '/databases/projects')).rows;
  assert.ok(visibleRows.some(row => row.id === ownRow.id));
  assert.ok(!visibleRows.some(row => row.id === otherRow.id));
  assert.equal(await member.locator('[data-action="add-row"]').count(), 0);
  await action(member, 'edit-row', `[data-id="${ownRow.id}"]`);
  assert.equal(await member.locator('#row-form [name="assignee"]').inputValue(), memberAccount.id);
  await member.locator('#row-form [name="name"]').fill('직접 수정한 담당 항목');
  await member.locator('#row-form .solid-btn').click();
  await member.waitForSelector('#row-form', { state: 'detached' });
  assert.ok((await json(memberContext, origin, '/databases/projects')).rows.some(row => row.id === ownRow.id));
  await action(owner, 'db-share');
  await owner.locator('#permissions-form [name="edit_assigned"]').uncheck();
  await owner.locator('#permissions-form .solid-btn').click();
  await owner.waitForSelector('#permissions-form', { state: 'detached' });
  await member.reload();
  await member.waitForSelector('.db-full');
  await action(member, 'edit-row', `[data-id="${ownRow.id}"]`);
  assert.equal(await member.locator('#row-form [name="name"]').isDisabled(), true);
  assert.equal(await member.locator('#row-form .solid-btn').count(), 0);
  await action(member, 'close-modal');

  assert.ok([403, 404].includes((await request(memberContext, origin, '/databases/projects/rows/' + otherRow.id, { properties: { name: '권한 없는 변경' } }, 'PATCH')).status()));
  assert.equal((await request(memberContext, origin, '/databases/projects/rows', { properties: { name: '권한 없는 생성' } })).status(), 403);
  // Changing the signed-in owner's password revokes only that account's sessions.
  await action(owner, 'settings');
  await action(owner, 'settings-tab', '[data-tab="accounts"]');
  await action(owner, 'account-password', `[data-id="${ownerAccount.id}"]`);
  const changedPassword = ownerPassword + '-changed';
  await owner.locator('#account-password-form [name="password"]').fill(changedPassword);
  await owner.locator('#account-password-form [name="password_confirm"]').fill(changedPassword);
  await owner.locator('#account-password-form .solid-btn').click();
  await owner.waitForSelector('#login-form [name="email"]');
  assert.equal((await request(ownerContext, origin, '/workspace')).status(), 401);
  assert.equal((await json(memberContext, origin, '/session')).member.id, memberAccount.id);
  await login(owner, ownerAccount.email, changedPassword);
  await action(member, 'settings');
  await action(member, 'logout');
  await member.waitForSelector('#login-form');
  assert.equal((await request(memberContext, origin, '/workspace')).status(), 401);
  assert.equal((await json(ownerContext, origin, '/session')).member.id, ownerAccount.id);
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS: disposable owner bootstrap, member account UI, mode activation/session revocation, separate identity logins, private page ACL view/comment/edit/deny, administrative 403, read-only UI, assigned row edit/readonly, self-password reset/session revocation, logout isolation');
  console.log('Screenshots: /tmp/fountain-browser/accounts-{login,member-readonly,owner-permissions}.png');
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 3000); });
  }
  await rm(temporary, { recursive: true, force: true });
}
