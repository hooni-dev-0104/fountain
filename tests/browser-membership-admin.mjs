/** Real installed Chrome + disposable SQLite HTTP; no request interception. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForAsync} from './async-browser.mjs';

const {chromium} = createRequire(import.meta.url)(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'fountain-membership-admin-'));
const python = process.env.FOUNTAIN_PYTHON || join(root, '.data/supabase-venv/bin/python');
let browser, server, origin, stage = 'startup';
const errors = [];

async function start() {
  const env = {...process.env};
  delete env.FOUNTAIN_ACCESS_TOKEN;
  delete env.FOUNTAIN_DATABASE_URL;
  server = spawn(python, ['-m', 'fountain.server', '--port', '0', '--data', join(temporary, 'workspace.db')], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Fixture startup timeout: ' + output)), 15000);
    const read = chunk => {
      output += chunk;
      const match = output.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(Error('Fixture server exited ' + code + ': ' + output)); });
  });
}

async function api(context, path, body, method, expected = 200) {
  const response = await context.request.fetch(origin + '/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {'X-Fountain-Request': '1'},
    ...(body === undefined ? {} : {data: body})
  });
  assert.equal(response.status(), expected, `${path}: ${await response.text()}`);
  return response.json();
}

async function login(page, email, password) {
  await page.goto(origin);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await waitForAsync(page, () => state.loaded && !!state.offlineProfile);
  await page.waitForLoadState('networkidle');
}

async function settings(page) {
  await page.evaluate(() => openSettings('members'));
  await page.locator('#settings-content [data-action=add-advanced][data-kind=members]').waitFor();
}

const manage = (page, id, kind = 'members') => page.locator(`[data-action=edit-advanced][data-kind="${kind}"][data-id="${id}"]`);
const roles = page => page.locator('#advanced-form [name=role] option').evaluateAll(options => options.map(option => option.value).sort());

async function createThroughUI(page, {name, email, role}, expectedRoles) {
  await page.locator('[data-action=add-advanced][data-kind=members]').click();
  assert.deepEqual(await roles(page), [...expectedRoles].sort());
  await page.locator('#advanced-form [name=name]').fill(name);
  await page.locator('#advanced-form [name=email]').fill(email);
  await page.locator('#advanced-form [name=role]').selectOption(role);
  const saved = page.waitForResponse(response => response.url() === origin + '/api/members' && response.request().method() === 'POST');
  await page.locator('#advanced-form .solid-btn').click();
  const response = await saved;
  assert.equal(response.status(), 201, await response.text());
  const member = await response.json();
  await page.locator('#settings-content [data-action=add-advanced][data-kind=members]').waitFor();
  assert.equal(member.role, role);
  assert.equal(member.email, email);
  return member;
}

try {
  origin = await start();
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const ownerContext = await browser.newContext({viewport: {width: 1440, height: 1050}});
  const adminContext = await browser.newContext({viewport: {width: 1440, height: 1050}});
  const owner = (await api(ownerContext, '/accounts')).accounts.find(account => account.role === 'owner');
  const admin = await api(ownerContext, '/members', {name: '멤버십 관리자', email: 'membership-admin@example.local', role: 'admin'}, 'POST', 201);
  const member = await api(ownerContext, '/members', {name: '일반 멤버', email: 'membership-member@example.local', role: 'member'}, 'POST', 201);
  const guest = await api(ownerContext, '/members', {name: '가족 게스트', email: 'membership-guest@example.local', role: 'guest'}, 'POST', 201);
  const group = await api(ownerContext, '/groups', {name: '기존 관리자 그룹', members: [owner.id, admin.id]}, 'POST', 201);
  const password = 'Membership-disposable-fixture-2026';
  for (const actor of [owner, admin]) await api(ownerContext, '/accounts', {member_id: actor.id, password}, 'POST', 201);
  await api(ownerContext, '/accounts/enable', {});
  const ownerPage = await ownerContext.newPage(), adminPage = await adminContext.newPage();
  for (const page of [ownerPage, adminPage]) page.on('pageerror', error => errors.push(error.message));
  await login(ownerPage, owner.email, password);
  await login(adminPage, admin.email, password);

  stage = 'owner sees all roles and can create/manage administrators';
  await settings(ownerPage);
  for (const actor of [owner, admin, member, guest]) assert.equal(await manage(ownerPage, actor.id).count(), 1);
  await manage(ownerPage, admin.id).click();
  assert.deepEqual(await roles(ownerPage), ['admin', 'guest', 'member', 'owner']);
  await ownerPage.locator('#advanced-form [name=name]').fill('소유자가 수정한 관리자');
  const ownerUpdated = ownerPage.waitForResponse(response => response.url() === origin + '/api/members/' + admin.id && response.request().method() === 'PATCH');
  await ownerPage.locator('#advanced-form .solid-btn').click();
  assert.equal((await ownerUpdated).status(), 200);
  await ownerPage.locator('#settings-content [data-action=add-advanced][data-kind=members]').waitFor();
  assert.equal((await api(ownerContext, '/members/' + admin.id)).name, '소유자가 수정한 관리자');
  const extraAdmin = await createThroughUI(ownerPage, {name: '추가 관리자', email: 'membership-extra-admin@example.local', role: 'admin'}, ['owner', 'admin', 'member', 'guest']);

  stage = 'membership administrator has no privileged Manage actions and only member/guest roles';
  await settings(adminPage);
  for (const actor of [owner, admin, extraAdmin]) assert.equal(await manage(adminPage, actor.id).count(), 0);
  for (const actor of [member, guest]) {
    assert.equal(await manage(adminPage, actor.id).count(), 1);
    await manage(adminPage, actor.id).click();
    assert.deepEqual(await roles(adminPage), ['guest', 'member']);
    await adminPage.locator('#advanced-form [data-action=settings]').click();
    await adminPage.locator('#settings-content [data-action=add-advanced][data-kind=members]').waitFor();
  }
  for (const actor of [owner, admin, extraAdmin]) {
    await adminPage.evaluate(id => advancedForm('members', id), actor.id);
    assert.equal(await adminPage.locator('#advanced-form').count(), 0, 'Direct UI invocation must reject a protected member');
    assert.equal(await adminPage.locator('.settings-modal').count(), 1);
  }
  const newMember = await createThroughUI(adminPage, {name: '관리자가 추가한 멤버', email: 'membership-added-member@example.local', role: 'member'}, ['member', 'guest']);
  assert.equal((await api(ownerContext, '/members/' + newMember.id)).role, 'member');

  stage = 'forged HTTP privilege changes return 403 without member mutation';
  const before = await api(ownerContext, '/members');
  const denied = [
    ['POST', '/members', {name: '금지 관리자', email: 'membership-forged-admin@example.local', role: 'admin'}],
    ['POST', '/members', {name: '금지 소유자', email: 'membership-forged-owner@example.local', role: 'owner'}],
    ['PATCH', '/members/' + member.id, {role: 'admin'}],
    ['PATCH', '/members/' + guest.id, {role: 'owner'}],
    ['PATCH', '/members/' + admin.id, {name: '역할을 생략한 자기 수정'}],
    ['PATCH', '/members/' + extraAdmin.id, {name: '역할을 생략한 관리자 수정'}],
    ['PATCH', '/members/' + owner.id, {role: 'member'}],
    ['DELETE', '/members/' + admin.id, {}],
    ['DELETE', '/members/' + extraAdmin.id, {}],
    ['DELETE', '/members/' + owner.id, {}]
  ];
  for (const [method, path, body] of denied) await api(adminContext, path, body, method, 403);
  assert.deepEqual(await api(ownerContext, '/members'), before);
  await api(ownerContext, '/members/' + extraAdmin.id, {name: '소유자가 역할 없이 수정'}, 'PATCH');
  assert.equal((await api(ownerContext, '/members/' + extraAdmin.id)).name, '소유자가 역할 없이 수정');

  stage = 'membership administrator can preserve owner/admin group membership';
  await settings(adminPage);
  await manage(adminPage, group.id, 'groups').click();
  const selected = await adminPage.locator('#advanced-form [name=members]').evaluate(select => [...select.selectedOptions].map(option => option.value).sort());
  assert.deepEqual(selected, [owner.id, admin.id].sort());
  const groupMembers = [owner.id, admin.id, member.id, guest.id];
  await adminPage.locator('#advanced-form [name=members]').selectOption(groupMembers);
  await adminPage.locator('#advanced-form [name=name]').fill('구성원 관리자가 수정한 그룹');
  const groupSaved = adminPage.waitForResponse(response => response.url() === origin + '/api/groups/' + group.id && response.request().method() === 'PATCH');
  await adminPage.locator('#advanced-form .solid-btn').click();
  assert.equal((await groupSaved).status(), 200);
  const savedGroup = await api(ownerContext, '/groups/' + group.id);
  assert.deepEqual(savedGroup.members.sort(), groupMembers.sort());
  assert.equal(savedGroup.name, '구성원 관리자가 수정한 그룹');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ok: true, browser: 'installed Chrome', backend: 'disposable SQLite HTTP', ownerRoleOptions: 4, membershipAdminRoleOptions: 2, protectedManageButtons: 0, forgedHttpDenials: denied.length, deniedRequestsPreservedMembers: true, ordinaryMemberCreatedThroughUI: true, ownerAdminManagementThroughUI: true, groupRetainedOwnerAndAdmin: true, externalOrCloudDeployment: false}));
} catch (error) {
  console.error('Membership administrator browser stage:', stage);
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  await rm(temporary, {recursive: true, force: true});
}
