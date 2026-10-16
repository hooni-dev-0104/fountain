/** Real HTTPS cookies, two login sessions, SSE, offline reload and chunked files. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory = await mkdtemp(join(tmpdir(), 'fountain-https-browser-'));
const python = process.env.FOUNTAIN_PYTHON || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const password = 'HTTPS-family-test-password-2026';
let server, browser, origin, stage = 'certificate';
const errors = [], chunks = [];
function openssl(args, input) {
  return execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function startServer() {
  server = spawn(python, ['-m', 'fountain.server', '--port', '0', '--data', join(directory, 'workspace.db'),
    '--tls-cert', join(directory, 'cert.pem'), '--tls-key', join(directory, 'key.pem')], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, FOUNTAIN_ACCESS_TOKEN: password },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('HTTPS startup timeout: ' + output)), 15000);
    const accept = data => {
      output += data.toString();
      const match = output.match(/https:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve('https://localhost:' + match[1]); }
    };
    server.stdout.on('data', accept); server.stderr.on('data', accept);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('HTTPS server exited ' + code + ': ' + output)); });
  });
}
async function login(page) {
  await page.goto('about:blank');
  await page.goto(origin + '/#home');
  await page.waitForSelector('#login-form');
  if (await page.locator('#login-form [name="email"]').count()) {
    await page.locator('#login-form [name="email"]').fill('local@fountain.local');
    await page.locator('#login-form [name="password"]').fill(password);
  } else await page.locator('#login-form [name="token"]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('.recent-grid');
}
async function saved(page) {
  await page.waitForFunction(() => state.channel?.pending.size === 0 && state.channel.status === 'synced');
}
async function contains(page, value) {
  await page.waitForFunction(value => document.querySelector('.block-content')?.innerText.includes(value), value);
}
try {
  await writeFile(join(directory, 'cert.conf'), '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(directory, 'cert.conf'),
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
  const publicKey = openssl(['x509', '-in', join(directory, 'cert.pem'), '-pubkey', '-noout']);
  const der = openssl(['pkey', '-pubin', '-outform', 'DER'], publicKey);
  // Trust only this disposable fixture's public key. No blanket certificate bypass.
  const pin = createHash('sha256').update(der).digest('base64');
  origin = await startServer();
  browser = await chromium.launch({ ...(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME } : { channel: 'chrome' }),
    headless: true, args: ['--ignore-certificate-errors-spki-list=' + pin] });
  const firstContext = await browser.newContext(), secondContext = await browser.newContext();
  const first = await firstContext.newPage(), second = await secondContext.newPage();
  for (const page of [first, second]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
  }
  first.on('request', request => {
    if (request.method() === 'PUT' && request.url().includes('/chunks?offset=')) chunks.push(request.url());
  });
  stage = 'secure session cookies';
  await login(first);
  await first.evaluate(async password => {
    for (const [path, body] of [['/api/accounts', { member_id: 'local', password }], ['/api/accounts/enable', {}]]) {
      const response = await FountainTransport.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Account bootstrap failed: ' + response.status);
    }
  }, password);
  await login(first); await login(second);
  for (const context of [firstContext, secondContext]) {
    const cookie = (await context.cookies(origin)).find(value => value.name === 'fountain_session');
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
  }
  const firstInfo = await first.evaluate(() => ({ member: state.session.member.id, binding: state.session.cache_binding }));
  const secondInfo = await second.evaluate(() => ({ member: state.session.member.id, binding: state.session.cache_binding }));
  assert.equal(firstInfo.member, secondInfo.member);
  assert.notEqual(firstInfo.binding, secondInfo.binding);
  assert.equal(await first.evaluate(() => isSecureContext), true);
  stage = 'two-session document and SSE';
  await first.locator('[data-action="add-page"]').first().click();
  await first.locator('#page-form [name="title"]').fill('HTTPS 가족 문서');
  await first.locator('#page-form .solid-btn').click();
  await first.waitForSelector('#page-title');
  const pageId = await first.evaluate(() => state.page.id);
  await first.locator('[data-action="add-block"]').first().click();
  await first.locator('.block-content').first().fill('첫 기기의 HTTPS 편집');
  await saved(first);
  await second.goto(origin + '/#page/' + pageId);
  await contains(second, '첫 기기의 HTTPS 편집');
  await first.locator('.block-content').first().fill('실시간으로 다른 기기에 전달');
  await saved(first); await contains(second, '실시간으로 다른 기기에 전달');
  stage = 'HTTPS service worker and offline reload';
  await first.evaluate(async () => { await FountainOffline.serviceWorkerReady; });
  await first.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await firstContext.setOffline(true);
  await first.waitForFunction(() => state.offline);
  await first.locator('.block-content').first().fill('연결 없이 저장한 HTTPS 초안');
  await first.evaluate(() => state.channel.persistence);
  assert.ok(await first.evaluate(() => state.channel.pending.size > 0));
  await first.reload();
  await contains(first, '연결 없이 저장한 HTTPS 초안');
  await firstContext.setOffline(false);
  await saved(first); await contains(second, '연결 없이 저장한 HTTPS 초안');
  stage = 'bounded file upload and download';
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 113);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 19 + 3) % 251;
  await first.locator('#attachment-input').setInputFiles({ name: 'https-family.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await first.waitForSelector('.attachment-link');
  await first.waitForFunction(() => [...state.uploadManager.jobs.values()].some(job => job.status === 'done'));
  await saved(first);
  assert.equal(new Set(chunks).size, 2);
  await second.waitForSelector('.attachment-link');
  const pendingDownload = second.waitForEvent('download');
  await second.locator('.attachment-link').click();
  const download = await pendingDownload;
  assert.deepEqual(await readFile(await download.path()), bytes);
  assert.deepEqual(errors, []);
  console.log('PASS HTTPS browser: fixture-pinned TLS, Secure/HttpOnly/Strict cookies, same account separate sessions, SSE, trusted-context SW offline reload and reconnect, two raw chunks and exact download');
} catch (error) {
  console.error('HTTPS verification stage:', stage);
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGINT');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
  }
  await rm(directory, { recursive: true, force: true });
}
