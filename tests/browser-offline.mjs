import { waitForAsync } from './async-browser.mjs';
/** Durable IndexedDB queues plus real service-worker reload and concurrent offline edits. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const python = process.env.FOUNTAIN_PYTHON || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const temporary = await mkdtemp(join(tmpdir(), 'fountain-offline-browser-'));
let server, browser;
let stage = 'startup';
async function startServer() {
  const env = { ...process.env };
  delete env.FOUNTAIN_ACCESS_TOKEN;
  server = spawn(python, ['-m', 'fountain.server', '--port', '0', '--data', join(temporary, 'workspace.db')], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Disposable server startup timed out: ' + output)), 15000);
    const consume = chunk => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (match) { clearTimeout(timeout); resolve('http://127.0.0.1:' + match[1]); }
    };
    server.stdout.on('data', consume);
    server.stderr.on('data', consume);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
}
async function json(context, origin, path, body, method) {
  const response = await context.request.fetch(origin + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'), headers: { 'X-Fountain-Request': '1' }, ...(body ? { data: body } : {}),
  });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function loadOfflineScript(page, origin) {
  if (!await page.evaluate(() => !!globalThis.FountainOffline)) await page.addScriptTag({ url: origin + '/offline.js' });
}
async function queued(page, pageId) {
  return page.evaluate(async id => {
    const profile = await FountainOffline.getProfile();
    return profile ? FountainOffline.pendingOperations(FountainOffline.key(profile, id)) : [];
  }, pageId);
}
try {
  const origin = await startServer();
  browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  let context = await browser.newContext({ serviceWorkers: 'block' });
  let page = await context.newPage();
  await page.route('**/app.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto(origin);
  await loadOfflineScript(page, origin);
  stage = 'isolated IndexedDB';
  const actor = { workspaceId: 'storage|workspace', memberId: 'actor|one', session: {
    authenticated: true, mode: 'accounts', expires_at: new Date(Date.now() + 3600000).toISOString(), cache_binding: 'storage-login-a',
    member: { id: 'actor|one', name: '내 가족', role: 'member', active: true }, token: 'never-persist-this-token',
  }, workspace: { pages: [{ id: 'private|page', title: '비공개 테스트' }] } };
  const stored = await page.evaluate(input => FountainOffline.saveProfile(input), actor);
  assert.ok(!JSON.stringify(stored).includes('never-persist-this-token'));
  const resourceKey = await page.evaluate(profile => FountainOffline.key(profile, 'private|page'), stored);
  assert.equal(resourceKey.split('|').length, 5);
  const second = await context.newPage();
  await second.route('**/app.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await second.goto(origin);
  await loadOfflineScript(second, origin);
  // Loading a real app can refresh its own authenticated profile. Set the test actor last.
  await page.evaluate(input => FountainOffline.saveProfile(input), actor);
  await Promise.all([
    page.evaluate(key => FountainOffline.putOperations(key, [{ id: 'tab-a:1', clock: 1, text: '가' }, { id: '__proto__', clock: 2, text: '안전' }]), resourceKey),
    second.evaluate(key => FountainOffline.putOperations(key, [{ id: 'tab-b:1', clock: 1, text: '족' }]), resourceKey),
  ]);
  assert.deepEqual((await page.evaluate(key => FountainOffline.pendingOperations(key), resourceKey)).map(op => op.id).sort(), ['__proto__', 'tab-a:1', 'tab-b:1']);
  await page.evaluate(async key => {
    await FountainOffline.saveSnapshot(key, { epoch: 'original', blocks: [{ text: '원본' }] });
    await FountainOffline.saveDraft(key, 'client-a', { epoch: 'old', ops: [{ id: 'draft:1' }], blocks: [{ text: '내 복구 초안' }], reason: 'epoch' });
    await FountainOffline.saveDraft(key, 'client-b', { epoch: 'old', blocks: [{ text: '다른 탭 초안' }] });
    await FountainOffline.saveSnapshot(key, { epoch: 'new', blocks: [{ text: '원격 원본' }] });
    await FountainOffline.putOperations(key, [{ id: 'tab-a:1', clock: 1, text: 'cannot replace immutable op' }]);
    await FountainOffline.acknowledge(key, ['tab-a:1']);
  }, resourceKey);
  assert.equal((await page.evaluate(key => FountainOffline.getDrafts(key), resourceKey)).length, 2);
  assert.equal((await page.evaluate(key => FountainOffline.getSnapshot(key), resourceKey)).epoch, 'new');
  await page.evaluate(async key => {
    await FountainOffline.saveSnapshot(key, { epoch: 'current', seq: 4, page: { revision: 8 }, access_revision: 4, access_level: 1 });
    await FountainOffline.saveSnapshot(key, { epoch: 'current', seq: 3, page: { revision: 7 }, access_revision: 4 });
    await FountainOffline.saveSnapshot(key, { epoch: 'current', seq: 4, page: { revision: 8 }, access_revision: 3, access_level: 3 });
    await FountainOffline.saveSnapshot(key, { epoch: 'old-epoch', seq: 100, page: { revision: 6 } });
  }, resourceKey);
  assert.equal((await page.evaluate(key => FountainOffline.getSnapshot(key), resourceKey)).seq, 4, 'late snapshots cannot roll back cached canonical state');
  assert.equal((await page.evaluate(key => FountainOffline.getSnapshot(key), resourceKey)).access_level, 1, 'old ACK cannot restore editing access after a newer ACL snapshot');
  assert.equal((await page.evaluate(profile => FountainOffline.listSnapshots(profile), stored)).length, 1);
  assert.deepEqual((await page.evaluate(key => FountainOffline.pendingOperations(key), resourceKey)).map(op => op.id).sort(), ['__proto__', 'tab-b:1']);
  assert.equal(await page.evaluate(async key => {
    try { await FountainOffline.putOperations(key, [{ id: 'must-rollback' }, {}]); return false; }
    catch { return !(await FountainOffline.pendingOperations(key)).some(op => op.id === 'must-rollback'); }
  }, resourceKey), true, 'invalid operation batches must roll back atomically');
  await Promise.all([
    page.evaluate(key => FountainOffline.acknowledge(key, ['tab-b:1']), resourceKey),
    second.evaluate(key => FountainOffline.putOperations(key, [{ id: 'tab-b:2', clock: 3 }]), resourceKey),
  ]);
  assert.deepEqual((await page.evaluate(key => FountainOffline.pendingOperations(key), resourceKey)).map(op => op.id).sort(), ['__proto__', 'tab-b:2']);
  const anotherKey = await page.evaluate(profile => FountainOffline.key(profile, 'another-page'), stored);
  await page.evaluate(async key => {
    await FountainOffline.saveSnapshot(key, { page: { id: 'another-page' } });
    await FountainOffline.putOperations(key, [{ id: 'another:1' }]);
    await FountainOffline.saveDraft(key, 'another-client', { blocks: [] });
  }, anotherKey);
  await second.evaluate(() => { globalThis.offlinePurgeObserved = false; addEventListener('fountain-offline-resource-purged', () => { globalThis.offlinePurgeObserved = true; }); });
  await page.evaluate(key => FountainOffline.purgeResource(key), resourceKey);
  await second.waitForFunction(() => globalThis.offlinePurgeObserved === true);
  assert.equal(await page.evaluate(key => FountainOffline.getSnapshot(key), resourceKey), null);
  assert.deepEqual(await page.evaluate(key => FountainOffline.pendingOperations(key), resourceKey), []);
  assert.deepEqual(await page.evaluate(key => FountainOffline.getDrafts(key), resourceKey), []);
  assert.equal((await page.evaluate(key => FountainOffline.pendingOperations(key), anotherKey)).length, 1);
  assert.ok(await page.evaluate(() => FountainOffline.getProfile()), 'resource revocation must not revoke the whole session');
  // A durable tombstone fences late writes before another tab hears the broadcast.
  for (const method of ['saveSnapshot', 'putOperations', 'saveDraft']) {
    assert.equal(await second.evaluate(async ({ key, method }) => {
      try {
        if (method === 'saveSnapshot') await FountainOffline.saveSnapshot(key, { epoch: 'late-old-response' });
        else if (method === 'putOperations') await FountainOffline.putOperations(key, [{ id: 'late-write' }]);
        else await FountainOffline.saveDraft(key, 'late-client', { blocks: [{ text: 'late-private-draft' }] });
        return false;
      } catch (error) { return error.name === 'SecurityError'; }
    }, { key: resourceKey, method }), true);
  }
  const lateProfile = await second.evaluate(input => FountainOffline.saveProfile(input), actor);
  assert.equal(lateProfile.workspace.pages.some(page => page.id === 'private|page'), false, 'late workspace metadata must respect the page tombstone');
  assert.equal(await page.evaluate(key => FountainOffline.getSnapshot(key), resourceKey), null);
  const reauthenticated = structuredClone(actor);
  reauthenticated.session.cache_binding = 'storage-same-actor-new-login';
  const currentLogin = await page.evaluate(input => FountainOffline.saveProfile(input), reauthenticated);
  const currentLoginKey = await page.evaluate(profile => FountainOffline.key(profile, 'new-login-page'), currentLogin);
  await page.evaluate(key => FountainOffline.putOperations(key, [{ id: 'new-login-unsent' }]), currentLoginKey);
  await second.evaluate(profile => FountainOffline.clearProfile(profile), stored);
  assert.equal((await page.evaluate(() => FountainOffline.getProfile())).id, currentLogin.id, 'stale old-login 401 must not clear a fresh login of the same actor');
  assert.equal((await page.evaluate(key => FountainOffline.pendingOperations(key), currentLoginKey)).length, 1);
  assert.equal(await second.evaluate(async input => {
    try { await FountainOffline.saveProfile(input); return false; }
    catch (error) { return error.name === 'SecurityError'; }
  }, actor), true, 'late old profile cannot roll the active pointer back');
  // Switching actor or login binding never exposes the previous actor's private cache.
  const other = structuredClone(actor);
  other.memberId = other.session.member.id = 'actor-two';
  other.session.cache_binding = 'storage-login-b';
  await page.evaluate(input => FountainOffline.saveProfile(input), other);
  assert.equal(await page.evaluate(key => FountainOffline.getSnapshot(key), anotherKey), null);
  assert.deepEqual(await page.evaluate(key => FountainOffline.pendingOperations(key), anotherKey), []);
  assert.deepEqual(await page.evaluate(profile => FountainOffline.listSnapshots(profile), stored), []);
  assert.equal(await page.evaluate(async key => {
    try { await FountainOffline.putOperations(key, [{ id: 'wrong-actor' }]); return false; }
    catch (error) { return error.name === 'SecurityError'; }
  }, anotherKey), true);
  await second.evaluate(() => { globalThis.offlineLogoutObserved = false; addEventListener('fountain-offline-profile-cleared', () => { globalThis.offlineLogoutObserved = true; }); });
  await page.evaluate(() => FountainOffline.clearActiveProfile());
  await second.waitForFunction(() => globalThis.offlineLogoutObserved === true);
  assert.equal(await page.evaluate(() => FountainOffline.getProfile()), null);
  assert.equal(await second.evaluate(async input => {
    try { await FountainOffline.saveProfile(input); return false; }
    catch (error) { return error.name === 'SecurityError'; }
  }, other), true, 'late pre-logout profile writes must be fenced in every tab');
  await page.evaluate(profile => FountainOffline.clearProfile(profile), stored);
  assert.equal(await page.evaluate(async input => {
    try { await FountainOffline.saveProfile(input); return false; }
    catch (error) { return error.name === 'SecurityError'; }
  }, actor), true);
  const fresh = structuredClone(actor);
  fresh.session.cache_binding = 'storage-login-new';
  await page.evaluate(input => FountainOffline.saveProfile(input), fresh);
  assert.equal(await page.evaluate(async () => {
    const profile = await FountainOffline.getProfile();
    return FountainOffline.getSnapshot(FountainOffline.key(profile, 'private|page'));
  }), null);
  await page.evaluate(async () => {
    const profile = await FountainOffline.getProfile();
    await FountainOffline.saveSnapshot(FountainOffline.key(profile, 'private|page'), { epoch: 'new-login-authorized' });
  });
  // Expired profiles cannot authorize even a read, including an already-known key.
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const opening = indexedDB.open('fountain-offline-v1'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['meta', 'profiles'], 'readwrite');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      const pointer = tx.objectStore('meta').get('active');
      pointer.onsuccess = () => {
        const row = tx.objectStore('profiles').get(pointer.result.profileId);
        row.onsuccess = () => tx.objectStore('profiles').put({ ...row.result, validUntil: Date.now() - 1 });
      };
    });
    database.close();
  });
  assert.equal(await page.evaluate(() => FountainOffline.getProfile()), null);
  await page.evaluate(() => FountainOffline.clearActiveProfile());
  await second.close();
  console.log('PASS IndexedDB: multi-tab queue union, immutable IDs, ACK isolation, draft recovery, actor/login isolation, logout fence, expiry');
  if (!process.argv.includes('--storage-only')) {
    stage = 'online document and service-worker cache';
    await context.close();
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('.recent-grid');
    const document = await json(context, origin, '/pages', { title: '오프라인 공동 편집 검증', blocks: [{ type: 'paragraph', text: '공통 문장' }] });
    const pageId = document.id || document.page?.id;
    assert.ok(pageId);
    await page.goto(origin + '/#page/' + pageId);
    await page.waitForSelector('.block-content[contenteditable="true"]');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => FountainOffline.serviceWorkerReady);
    await waitForAsync(page,async id => {
      const profile = await FountainOffline.getProfile();
      return profile && await FountainOffline.getSnapshot(FountainOffline.key(profile, id));
    }, pageId);
    const tab = await context.newPage();
    await tab.goto(origin + '/#page/' + pageId);
    await tab.waitForSelector('.block-content[contenteditable="true"]');
    const remoteContext = await browser.newContext();
    const remote = await remoteContext.newPage();
    await remote.goto(origin + '/#page/' + pageId);
    await remote.waitForSelector('.block-content[contenteditable="true"]');
    stage = 'two-tab offline edits';
    await context.setOffline(true);
    await page.locator('.block-content').first().press('End');
    await page.keyboard.insertText(' · 오프라인첫탭');
    await tab.locator('.block-content').first().press('End');
    await tab.keyboard.insertText(' · 오프라인둘째탭');
    await waitForAsync(page,async id => {
      const profile = await FountainOffline.getProfile();
      return profile && (await FountainOffline.pendingOperations(FountainOffline.key(profile, id))).length >= 2;
    }, pageId);
    const beforeReload = await queued(page, pageId);
    assert.ok(new Set(beforeReload.map(op => op.client)).size >= 2, 'both tabs must persist independent operations');
    stage = 'actual service-worker offline reload';
    // This navigation is a genuine network-offline document reload, served by SW.
    await page.reload();
    await page.waitForSelector('.block-content[contenteditable="true"]');
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    await page.waitForFunction(() => document.querySelector('.block-content')?.textContent.includes('오프라인첫탭')
      && document.querySelector('.block-content')?.textContent.includes('오프라인둘째탭'));
    assert.ok((await queued(page, pageId)).length >= beforeReload.length, 'reload must preserve unsent operations');
    stage = 'remote concurrent edit';
    await remote.locator('.block-content').first().fill('공통 문장 · 원격변경');
    await remote.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('모든 변경'));
    stage = 'reconnect and convergence';
    await context.setOffline(false);
    await page.waitForFunction(() => ['오프라인첫탭', '오프라인둘째탭', '원격변경']
      .every(marker => document.querySelector('.block-content')?.textContent.includes(marker)), null, { timeout: 20000 });
    await remote.waitForFunction(() => ['오프라인첫탭', '오프라인둘째탭', '원격변경']
      .every(marker => document.querySelector('.block-content')?.textContent.includes(marker)), null, { timeout: 20000 });
    await waitForAsync(page,async id => {
      const profile = await FountainOffline.getProfile();
      return profile && (await FountainOffline.pendingOperations(FountainOffline.key(profile, id))).length === 0;
    }, pageId);
    const saved = await json(context, origin, '/pages/' + pageId);
    for (const marker of ['오프라인첫탭', '오프라인둘째탭', '원격변경']) assert.ok(saved.blocks[0].text.includes(marker));
    const urls = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name =>
      (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat());
    assert.ok(urls.includes('/') && urls.includes('/offline.js') && urls.includes('/collaboration.js'));
    assert.ok(urls.every(path => ['/', '/index.html', '/app.js', '/backup.js', '/style.css', '/collaboration.js', '/offline.js', '/uploads.js', '/transport.js', '/mutations.js', '/presence.js', '/version-diff.js', '/recovery-import.js', '/account.js', '/workspaces.js', '/workspace-scope.js'].includes(path)), 'SW must never cache private responses');
    assert.ok(urls.includes('/version-diff.js'), 'version comparison must be part of the offline public shell');
    assert.ok(urls.includes('/recovery-import.js'), 'recovery import must be bundled in the offline public shell');
    stage = 'fresh boot after authoritative online 401';
    // Close every old live channel before the policy change: a fresh boot must
    // purge its existing cache without relying on another tab's SSE denial.
    await tab.close();
    await page.goto('about:blank');
    // A real authentication-policy change makes cached documents unavailable online.
    await json(context, origin, '/accounts/local', { password: 'Offline-test-owner-passphrase-2026' }, 'PATCH');
    await json(context, origin, '/accounts/enable', {});
    assert.equal((await context.request.get(origin + '/api/pages/' + pageId)).status(), 401);
    await page.goto(origin + '/#page/' + pageId);
    await page.waitForSelector('#login-form');
    assert.equal(await page.locator('.block-content').count(), 0, 'online 401 must not fall back to cached private page');
    await waitForAsync(page,async () => await FountainOffline.getProfile() === null, null, { timeout: 5000 });
    assert.equal(await page.evaluate(async () => !!await FountainOffline.getProfile()), false);
    await remoteContext.close();
    console.log('PASS offline E2E: real SW reload, durable two-tab edits, reconnect plus remote merge, private cache allowlist, online 401 denial');
  }
} catch (error) {
  console.error('Offline browser QA failed at: ' + stage);
  throw error;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(temporary, { recursive: true, force: true });
}
