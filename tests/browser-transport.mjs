/** Same-origin transport exercised through the actual app and disposable HTTP server. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory = await mkdtemp(join(tmpdir(), 'fountain-transport-'));
const python = process.env.FOUNTAIN_PYTHON || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server, browser, origin;
const errors = [], requests = [];
async function startServer() {
  const env = { ...process.env };
  delete env.FOUNTAIN_ACCESS_TOKEN;
  server = spawn(python, ['-m', 'fountain.server', '--port', '0', '--data', join(directory, 'workspace.db')], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(output)), 15000);
    const receive = chunk => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    };
    server.stdout.on('data', receive); server.stderr.on('data', receive);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`server ${code}: ${output}`)); });
  });
}
async function api(context, path, body, method) {
  const response = await context.request.fetch(origin + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'), headers: { 'X-Fountain-Request': '1' }, ...(body ? { data: body } : {}),
  });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function action(page, name, extra = '') { await page.locator(`[data-action="${name}"]${extra}`).first().click(); }
try {
  origin = await startServer();
  browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  const bootstrap = await browser.newContext();
  const owner = (await api(bootstrap, '/accounts')).accounts.find(item => item.role === 'owner');
  const password = 'Transport-family-owner-2026';
  await api(bootstrap, '/accounts', { member_id: owner.id, password });
  await api(bootstrap, '/accounts/enable', {});
  await bootstrap.close();
  const context = await browser.newContext();
  // Observe calls without mocking network behavior or replacing the concrete adapter.
  await context.addInitScript(() => {
    let transport;
    window.__transportCalls = [];
    Object.defineProperty(window, 'FountainTransport', {
      configurable: true,
      get: () => transport,
      set(value) {
        transport = Object.freeze(Object.fromEntries(Object.entries(value).map(([name, method]) => [name, (...args) => {
          window.__transportCalls.push({ name, path: args[0] });
          return method(...args);
        }])));
      },
    });
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.stack || error.message)));
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), headers: request.headers() }));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await page.locator('#login-form [name="email"]').fill(owner.email);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('.recent-grid');
  const cookie = (await context.cookies()).find(value => value.name === 'fountain_session');
  assert.ok(cookie?.httpOnly && cookie.sameSite === 'Strict');
  const document = await api(context, '/pages', { title: '연결 경계 검증', favorite: true, blocks: [{ id: 'transport-text', type: 'paragraph', text: '처음 내용' }] });
  const form = await api(context, '/forms', { name: '연결 양식', database_id: 'projects', published: true, fields: [{ id: 'name', label: '제목', property_id: 'name', required: true }] });
  const site = await api(context, '/sites', { name: '연결 사이트', page_id: document.id, published: true, slug: 'transport-site' });
  await page.goto(origin + '/#page/' + document.id);
  await page.waitForSelector('.block-content[contenteditable=true]');
  await page.waitForFunction(() => window.__transportCalls.some(call => call.name === 'events'));
  // A separate context has no local BroadcastChannel/IDB shortcut: propagation needs server SSE.
  const remoteContext = await browser.newContext();
  await remoteContext.addCookies(await context.cookies());
  const remote = await remoteContext.newPage();
  remote.on('pageerror', error => errors.push(error.stack || error.message));
  await remote.goto(origin + '/#page/' + document.id);
  await remote.locator('.block-content').first().fill('서버 SSE로 전달된 편집');
  await page.waitForFunction(() => document.querySelector('.block-content')?.textContent === '서버 SSE로 전달된 편집');
  assert.ok((await api(context, '/pages/' + document.id)).blocks.some(block => block.text === '서버 SSE로 전달된 편집'));
  await remoteContext.close();
  await action(page, 'share');
  assert.equal(await page.locator('#share-url').inputValue(), origin + '/#page/' + document.id);
  await page.keyboard.press('Escape');
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 117, 43);
  bytes[bytes.length - 1] = 7;
  await page.locator('#attachment-input').setInputFiles({ name: 'transport-chunks.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await page.waitForSelector('.upload-card[data-upload-state="done"]');
  await page.waitForSelector('.attachment-link');
  const uploaded = (await api(context, '/pages/' + document.id)).blocks.filter(block => block.type === 'file');
  assert.equal(uploaded.length, 1);
  assert.equal(await page.locator('.attachment-link').getAttribute('href'), origin + '/api/attachments/' + uploaded[0].attachment_id + '/download');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('.attachment-link').click();
  const download = await downloadEvent;
  assert.deepEqual(await readFile(await download.path()), bytes);
  const chunkRequests = requests.filter(request => request.method === 'PUT' && request.url.includes('/chunks?offset='));
  assert.equal(chunkRequests.length, 2);
  assert.ok(chunkRequests.every(request => request.headers['content-type'] === 'application/octet-stream' && request.headers['x-fountain-request'] === '1'));
  const search = await page.evaluate(async () => {
    const response = await FountainTransport.request('/api/search?q=' + encodeURIComponent('한글 / .. ? # + https://example.com'));
    return response.status;
  });
  assert.equal(search, 200);
  // Existing API identifiers may contain encoded spaces and punctuation. They
  // remain path data, while unencoded fragment/query delimiters stay invalid.
  const encodedResource = await page.evaluate(async () => {
    const id = '가족 문서?#%';
    const created = await FountainTransport.request('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title: '인코딩 식별자' }) });
    if (!created.ok) throw new Error('Encoded page fixture failed');
    const path = '/api/pages/' + encodeURIComponent(id);
    const result = await FountainTransport.request(path);
    const detail = await result.json();
    return { status: result.status, id: detail.page.id, link: FountainTransport.appURL('page/' + encodeURIComponent(id)) };
  });
  assert.equal(encodedResource.status, 200);
  assert.equal(encodedResource.id, '가족 문서?#%');
  assert.equal(encodedResource.link, origin + '/#page/' + encodeURIComponent(encodedResource.id));
  // Malformed paths must throw before any request/SSE/XHR can leave the browser.
  const beforeInvalid = requests.length;
  const invalid = await page.evaluate(async () => {
    const paths = ['https://outside.invalid/api/session', '//outside.invalid/api/session', '/api/../session', '/api/%2e%2e/session', '/api/%252e%252e/session', '/api/x/./session', '/api\\session', '/api/%5c/session', '/api/%255c/session', '/api/session#secret', '/api/session\n', '/api/%00/session', '/sites/page', '/api//session'];
    let rejected = 0;
    for (const path of paths) for (const method of ['apiURL', 'request', 'events', 'downloadURL']) {
      try { await FountainTransport[method](path); } catch (error) { if (error instanceof TypeError) rejected++; }
    }
    for (const path of paths) { try { FountainTransport.xhr('PUT', path); } catch (error) { if (error instanceof TypeError) rejected++; } }
    for (const path of ['//outside.invalid/forms/x', '/forms/../sites/x', '/forms/%252e%252e', '/api/session']) {
      try { FountainTransport.publicURL(path); } catch (error) { if (error instanceof TypeError) rejected++; }
    }
    for (const route of ['//outside.invalid', 'page/../session', 'page/%252e%252e', 'page/x#secret']) {
      try { FountainTransport.appURL(route); } catch (error) { if (error instanceof TypeError) rejected++; }
    }
    return { rejected, expected: paths.length * 5 + 8 };
  });
  assert.equal(invalid.rejected, invalid.expected);
  assert.equal(requests.length, beforeInvalid);
  // Caller options cannot remove cookie credentials or permit redirect-following.
  const policy = await page.evaluate(async () => {
    let captured;
    const original = window.fetch;
    window.fetch = (url, options) => { captured = { url, credentials: options.credentials, redirect: options.redirect, header: options.headers.get('X-Fountain-Request') }; return original(url, options); };
    try { await FountainTransport.request('/api/session', { credentials: 'omit', redirect: 'follow' }); } finally { window.fetch = original; }
    return captured;
  });
  assert.equal(policy.credentials, 'same-origin'); assert.equal(policy.redirect, 'error'); assert.equal(policy.header, '1');
  // A real redirected HTTP response is rejected, rather than silently following it.
  await page.route('**/api/transport-redirect', route => route.fulfill({ status: 302, headers: { Location: '/api/session' } }));
  assert.equal(await page.evaluate(async () => { try { await FountainTransport.request('/api/transport-redirect'); return false; } catch { return true; } }), true);
  await page.unroute('**/api/transport-redirect');
  await action(page, 'settings');
  await action(page, 'settings-tab', '[data-tab="forms"]');
  let opened = context.waitForEvent('page');
  await action(page, 'fill-form', `[data-id="${form.id}"]`);
  const publicForm = await opened;
  await publicForm.waitForSelector('#public-form');
  assert.equal(publicForm.url(), origin + '/forms/' + form.id);
  await publicForm.locator('[name=name]').fill('실제 공개 링크 응답');
  await publicForm.locator('button[type=submit]').click();
  await publicForm.waitForFunction(() => document.querySelector('#form-status')?.textContent.includes('제출되었습니다'));
  await publicForm.close();
  await action(page, 'settings-tab', '[data-tab="sites"]');
  opened = context.waitForEvent('page');
  await action(page, 'site-link', `[data-id="${site.id}"]`);
  const publicSite = await opened;
  await publicSite.waitForSelector('main');
  assert.equal(publicSite.url(), origin + '/sites/' + site.slug);
  await publicSite.close();
  await action(page, 'settings-tab', '[data-tab="export"]');
  const backupEvent = page.waitForEvent('download');
  await action(page, 'backup');
  const backup = await backupEvent;
  assert.equal((await readFile(await backup.path())).subarray(0, 16).toString(), 'SQLite format 3\0');
  const calls = await page.evaluate(() => window.__transportCalls.map(call => call.name));
  for (const name of ['request', 'events', 'xhr', 'downloadURL', 'publicURL', 'appURL']) assert.ok(calls.includes(name), name + ' used by actual UI');
  assert.ok(requests.filter(request => request.url.includes('/api/') && !request.url.includes('transport-redirect')).every(request => new URL(request.url).origin === origin));
  assert.deepEqual(errors, []);
  console.log('PASS: real account login, independent-context SSE, 4 MiB raw chunks and byte-equal download, backup SQLite, public form/site/share links, path rejection before network, forced same-origin credentials and redirect error');
} finally {
  await browser?.close(); server?.kill('SIGTERM');
  await rm(directory, { recursive: true, force: true });
}
