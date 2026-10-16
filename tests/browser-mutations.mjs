/** Actual Chromium + disposable HTTP workspace: durable mutation replay and recovery. */
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
const directory = await mkdtemp(join(tmpdir(), 'fountain-controller-'));
let server, browser, origin, stage = 'startup';
async function start() {
  const env = { ...process.env }; delete env.FOUNTAIN_ACCESS_TOKEN;
  server = spawn(python, ['-m', 'fountain.server', '--port', '0', '--data', join(directory, 'workspace.db')], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(output)), 15000);
    const consume = chunk => { output += chunk; const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } };
    server.stdout.on('data', consume); server.stderr.on('data', consume); server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`server ${code}: ${output}`)); });
  });
}
async function api(context, path, body, method) {
  const response = await context.request.fetch(origin + '/api' + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'X-Fountain-Request': '1' }, ...(body === undefined ? {} : { data: body }) });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`); return response.json();
}
async function context() {
  const value = await browser.newContext({ serviceWorkers: 'block' });
  await value.route('**/app.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })); return value;
}
async function pageFor(context) {
  const page = await context.newPage(); page.setDefaultTimeout(15000); await page.goto(origin);
  for (const [global, path] of [['FountainTransport', 'transport.js'], ['FountainOffline', 'offline.js'], ['FountainCollaboration', 'collaboration.js'], ['FountainMutations', 'mutations.js']]) if (!await page.evaluate(name => !!globalThis[name], global)) await page.addScriptTag({ url: origin + '/' + path });
  await page.evaluate(async () => {
    const json = async path => (await FountainTransport.request('/api' + path)).json();
    const session = await json('/session'), workspace = await json('/workspace');
    globalThis.profile = await FountainOffline.saveProfile({ workspaceId: session.workspace_id, memberId: session.member.id, session, workspace });
    globalThis.events = []; globalThis.failures = [];
    globalThis.makeController = () => new FountainMutations.Controller({ profile, onChange: value => events.push(value.reason), onDenied: value => events.push(value), onError: value => failures.push({ message: value.message, status: value.status }) });
    globalThis.controller = makeController();
  }); return page;
}
async function poll(check, timeout = 8000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Live browser state did not reach the expected value'); }
const call = (page, method, ...args) => page.evaluate(({ method, args }) => controller[method](...args), { method, args });
async function reopen(page) { await page.evaluate(() => { controller.close(); controller = makeController(); }); }
try {
  origin = await start(); browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  const setup = await context(); const password = 'Mutations-owner-passphrase-2026';
  const owner = (await api(setup, '/accounts')).accounts.find(value => value.role === 'owner');
  await api(setup, '/accounts', { member_id: owner.id, password });
  const member = await api(setup, '/members', { name: '가족', email: 'controller-family@example.local', role: 'member' });
  await api(setup, '/accounts', { member_id: member.id, password }); await api(setup, '/accounts/enable', {}); await setup.close();
  const actor = await context(), remote = await context();
  await api(actor, '/session', { email: owner.email, password }); await api(remote, '/session', { email: owner.email, password });
  const database = await api(actor, '/databases', { id: 'controller-projects', name: '변경 큐 검증', properties: [
    { id: 'name', name: '이름', type: 'title' }, { id: 'n', name: '수량', type: 'number' }, { id: 'done', name: '확인', type: 'checkbox' }, { id: 'due', name: '일정', type: 'date' }],
    task_settings: { subitems: true, dependencies: true, shift: 'none', date_property: 'due', skip_weekends: false } });
  const db = database.id;
  const initial = await api(actor, `/databases/${db}/rows`, { properties: { name: '처음 이름', n: 2, done: false } });
  const page = await pageFor(actor), tab = await pageFor(actor);
  await call(page, 'loadDatabase', db); await call(tab, 'loadDatabase', db);
  stage = 'two tabs queue and full-form touched fields';
  await actor.setOffline(true);
  await Promise.all([
    call(page, 'patchRow', db, initial.id, { properties: { name: '기기 이름', n: 2, done: false } }),
    call(tab, 'createRow', db, { properties: { name: '둘째 탭의 새 행', n: 3, done: true } }),
  ]);
  const union = await call(page, 'records'); assert.equal(union.length, 2);
  const rename = union.find(record => record.operation.kind === 'row.patch'); assert.deepEqual(Object.keys(rename.operation.body.properties), ['name']);
  const newRow = union.find(record => record.operation.kind === 'row.create').operation.target_id;
  await api(remote, `/databases/${db}/rows/${initial.id}`, { properties: { n: 8 } }, 'PATCH');
  await actor.setOffline(false); await call(page, 'sync');
  assert.equal((await call(page, 'records')).length, 0);
  let canonical = await api(actor, `/databases/${db}`); let row = canonical.rows.find(value => value.id === initial.id);
  assert.equal(row.properties.name, '기기 이름'); assert.equal(row.properties.n, 8); assert.ok(canonical.rows.some(value => value.id === newRow));
  stage = 'opening form baseline survives a fresher cache';
  const baseline = (await call(page, 'loadDatabase', db)).rows.find(value => value.id === initial.id);
  const openingSchema = canonical.database.properties;
  await api(remote, `/databases/${db}/rows/${initial.id}`, { properties: { n: 12 } }, 'PATCH');
  await call(page, 'loadDatabase', db); await actor.setOffline(true);
  await call(page, 'patchRow', db, initial.id, { properties: { n: 7 } }, { baseline, schema: openingSchema });
  assert.equal((await call(page, 'records'))[0].operation.base.properties.n, 8);
  await actor.setOffline(false); await call(page, 'sync');
  let conflicts = (await call(page, 'records')).filter(record => record.status === 'conflict'); assert.equal(conflicts.length, 1);
  assert.equal((await api(actor, `/databases/${db}`)).rows.find(value => value.id === initial.id).properties.n, 12);
  const exported = await call(page, 'export', conflicts[0].id); assert.equal(exported.records[0].operation.body.properties.n, 7);
  await call(page, 'reapply', conflicts[0].id); await call(page, 'sync');
  assert.equal((await call(page, 'records')).length, 0); assert.equal((await api(actor, `/databases/${db}`)).rows.find(value => value.id === initial.id).properties.n, 7);
  stage = 'delete captures own queued create/patch subtree receipts';
  await actor.setOffline(true);
  const parent = await call(page, 'createRow', db, { properties: { name: '기기 상위', n: 1 } });
  const child = await call(page, 'createRow', db, { parent_row_id: parent.id, properties: { name: '기기 하위', n: 1 } });
  await call(page, 'patchRow', db, parent.id, { properties: { n: 5 } });
  const deletion = await call(page, 'deleteRow', db, parent.id); assert.deepEqual(new Set(deletion.deletedIds), new Set([parent.id, child.id]));
  assert.ok(Object.values(deletion.operation.base_rows).every(base => base.after_operation));
  assert.equal((await call(page, 'loadDatabase', db, { remote: false })).rows.some(value => value.id === child.id), false);
  await actor.setOffline(false); await call(page, 'sync');
  assert.equal((await call(page, 'records')).length, 0); canonical = await api(actor, `/databases/${db}`); assert.equal(canonical.rows.some(value => [parent.id, child.id].includes(value.id)), false);
  stage = 'lost response reuses durable server receipt once';
  await tab.evaluate(() => controller.close());
  await actor.setOffline(true); const replayed = await call(page, 'createRow', db, { properties: { name: '응답 유실 후 한 번만 생성', n: 4 } });
  const op = (await call(page, 'records'))[0].operation;
  let dropped = false;
  await actor.route('**/api/sync', async route => { if (!dropped) { dropped = true; await route.fetch(); await route.abort('connectionreset'); } else await route.continue(); });
  await actor.setOffline(false);
  await page.evaluate(async () => { try { await controller.sync(); } catch {} controller.close(); });
  assert.ok((await api(actor, `/databases/${db}`)).rows.some(value => value.id === replayed.id));
  const preserved = await page.evaluate(() => FountainOffline.listMutations(profile)); assert.ok(preserved.some(value => value.id === op.id));
  await actor.unroute('**/api/sync'); await reopen(page); await call(page, 'sync');
  assert.equal((await call(page, 'records')).length, 0);
  canonical = await api(actor, `/databases/${db}`); assert.equal(canonical.rows.filter(value => value.id === replayed.id).length, 1);
  stage = 'applied record survives canonical-fetch crash and ACKs after reload';
  await actor.setOffline(true); await call(page, 'patchRow', db, replayed.id, { properties: { n: 9 } });
  await page.route(`**/api/databases/${db}`, route => route.abort('connectionreset'));
  await actor.setOffline(false); await call(page, 'sync');
  const applied = await call(page, 'records'); assert.equal(applied.length, 1); assert.equal(applied[0].status, 'applied');
  await page.evaluate(() => controller.close()); await page.unroute(`**/api/databases/${db}`);
  await page.reload(); for (const [name, asset] of [['FountainTransport', 'transport.js'], ['FountainOffline', 'offline.js'], ['FountainCollaboration', 'collaboration.js'], ['FountainMutations', 'mutations.js']]) if (!await page.evaluate(name => !!globalThis[name], name)) await page.addScriptTag({ url: origin + '/' + asset });
  await page.evaluate(async () => { globalThis.profile = await FountainOffline.getProfile(); globalThis.events = []; globalThis.failures = []; globalThis.makeController = () => new FountainMutations.Controller({ profile, onDenied: value => events.push(value), onError: value => failures.push(value.message) }); controller = makeController(); });
  await call(page, 'sync'); assert.equal((await call(page, 'records')).length, 0); assert.equal((await api(actor, `/databases/${db}`)).rows.find(value => value.id === replayed.id).properties.n, 9);
  stage = 'create receipt keeps a new page visible before canonical GET succeeds';
  await actor.setOffline(true); const awaitingCanonical = await call(page, 'createPage', { title: '생성 확인 뒤에도 보이는 문서' });
  await page.route(`**/api/pages/${awaitingCanonical.page.id}/collaboration`, route => route.abort('connectionreset'));
  await actor.setOffline(false); await call(page, 'sync');
  assert.equal((await call(page, 'records'))[0].status, 'applied');
  assert.equal((await call(page, 'localPage', awaitingCanonical.page.id)).metadata.localOnly, false);
  assert.ok((await call(page, 'workspace')).pages.some(value => value.id === awaitingCanonical.page.id), 'applied create watermark must preserve visibility before canonical retrieval');
  await page.unroute(`**/api/pages/${awaitingCanonical.page.id}/collaboration`); await call(page, 'sync'); assert.equal((await call(page, 'records')).length, 0);
  stage = 'local document keeps epoch and RGA through creation retry';
  await actor.setOffline(true); const created = await call(page, 'createPage', { title: '기기 문서' });
  assert.equal(await call(page, 'pageReady', created.page.id), false);
  await page.evaluate(async ({ id, snapshot }) => {
    globalThis.channel = new FountainCollaboration.DocumentChannel({ pageId: id, profile, deferRemote: true }); await channel.open(snapshot, { cached: true });
    channel.submit([{ type: 'block.insert', block_id: 'local-text', fields: { block_type: 'paragraph' } }]);
    channel.replaceText('local-text', '생성 전에도 보존되는 본문'); await channel.persistence;
  }, { id: created.page.id, snapshot: created.snapshot });
  await call(page, 'patchPage', created.page.id, { title: '기기의 새 제목' }, { basePage: created.page });
  await actor.setOffline(false); await call(page, 'sync'); assert.equal(await call(page, 'pageReady', created.page.id), true);
  await page.evaluate(async () => { await channel.resumeRemote(); await channel.flush(); });
  const savedPage = await api(actor, '/pages/' + created.page.id + '/collaboration'); assert.equal(savedPage.epoch, created.operation.document_epoch);
  assert.equal(savedPage.page.title, '기기의 새 제목'); assert.equal(savedPage.blocks[0].text, '생성 전에도 보존되는 본문');
  const projectedWorkspace = await call(page, 'workspace'); assert.equal(projectedWorkspace.pages.find(value => value.id === created.page.id).title, '기기의 새 제목');
  stage = 'Unicode resource identity and opening page metadata baseline';
  const unicode = await api(actor, '/pages', { id: '가족 문서?#%', title: '옛 제목' });
  await call(page, 'canonicalPage', unicode.id); await api(remote, '/pages/' + encodeURIComponent(unicode.id), { title: '원격 제목' }, 'PATCH');
  await call(page, 'patchPage', unicode.id, { title: '내 열린 제목' }, { basePage: { ...unicode, access_level: 4 } }); await call(page, 'sync');
  conflicts = (await call(page, 'records')).filter(record => record.status === 'conflict'); assert.equal(conflicts.length, 1);
  assert.equal((await api(actor, '/pages/' + encodeURIComponent(unicode.id))).page.title, '원격 제목');
  await call(page, 'reapply', conflicts[0].id); await call(page, 'sync'); assert.equal((await api(actor, '/pages/' + encodeURIComponent(unicode.id))).page.title, '내 열린 제목');
  stage = 'applied page metadata cannot overwrite a later canonical title';
  await actor.setOffline(true); await call(page, 'patchPage', unicode.id, { title: '이전 적용 제목' });
  const appliedPageRecord = (await call(page, 'records'))[0];
  const pageEnvelope = await page.evaluate(operation => ({ workspace_id: profile.workspaceId, session_binding: profile.cacheBinding, operations: [operation] }), appliedPageRecord.operation);
  const pageApplied = await api(actor, '/sync', pageEnvelope);
  await api(remote, '/pages/' + encodeURIComponent(unicode.id), { title: '적용 뒤 원격 최신 제목' }, 'PATCH');
  const freshestPage = await api(actor, '/pages/' + encodeURIComponent(unicode.id) + '/collaboration'), freshestWorkspace = await api(actor, '/workspace');
  await page.evaluate(async ({ record, result, snapshot }) => {
    await FountainOffline.updateMutation(profile, record.id, { status: 'applied', result });
    await FountainOffline.saveSnapshot(FountainOffline.key(profile, snapshot.page.id), snapshot);
  }, { record: appliedPageRecord, result: pageApplied.results[0], snapshot: freshestPage });
  assert.equal((await call(page, 'workspace', freshestWorkspace)).pages.find(value => value.id === unicode.id).title, '적용 뒤 원격 최신 제목');
  assert.equal(await page.evaluate(async id => (await controller.pageForEdit(id, await controller.records())).title, unicode.id), '적용 뒤 원격 최신 제목');
  await actor.setOffline(false); await call(page, 'sync'); assert.equal((await call(page, 'records')).length, 0);
  stage = 'schema changes keep recovery data rather than rebasing silently';
  const schemaBasis = await call(page, 'loadDatabase', db);
  await actor.setOffline(true);
  await call(page, 'patchRow', db, initial.id, { properties: { n: 11 } }, { baseline: schemaBasis.rows.find(row => row.id === initial.id), schema: schemaBasis.database.properties });
  await api(remote, `/databases/${db}`, { properties: schemaBasis.database.properties.map(property => property.id === 'n' ? { ...property, type: 'text' } : property) }, 'PATCH');
  await actor.setOffline(false); await call(page, 'sync');
  let schemaRecord = (await call(page, 'records')).find(record => record.status === 'conflict'); assert.ok(schemaRecord);
  const cannotReapply = await page.evaluate(async id => { try { await controller.reapply(id); return false; } catch { return (await controller.export(id)).records[0].operation.body.properties.n === 11; } }, schemaRecord.id);
  assert.equal(cannotReapply, true); await call(page, 'drop', schemaRecord.id);
  await api(remote, `/databases/${db}`, { properties: schemaBasis.database.properties }, 'PATCH'); await call(page, 'loadDatabase', db);
  stage = 'initial session network failure retries while navigator stays online';
  await page.evaluate(() => controller.close()); await actor.setOffline(true); await reopen(page);
  await call(page, 'patchRow', db, initial.id, { properties: { n: 13 } });
  assert.equal((await call(page, 'records')).length, 1, 'network retry fixture must start with a durable pending operation');
  await page.evaluate(() => { clearTimeout(controller.timer); });
  let sessionAttempts = 0; const retryTrace = [];
  actor.on('request', request => { if (/\/api\/(session|sync)$/.test(request.url())) retryTrace.push({ path: new URL(request.url()).pathname, from: request.frame().page() === page ? 'main' : 'other' }); });
  await page.route('**/api/session', async route => { sessionAttempts++; if (sessionAttempts === 1) await route.abort('connectionreset'); else await route.continue(); });
  await actor.setOffline(false); await page.evaluate(async () => { try { await controller.sync(); } catch {} });
  await poll(async () => (await call(page, 'records')).length === 0);
  assert.ok(sessionAttempts >= 2, 'Network failure must trigger a later live authentication attempt'); await page.unroute('**/api/session');
  assert.equal((await api(actor, `/databases/${db}`)).rows.find(row => row.id === initial.id).properties.n, 13);
  stage = 'out-of-order canonical HTTP responses return durable newest data';
  const older = await api(actor, `/databases/${db}`); await api(remote, `/databases/${db}/rows/${initial.id}`, { properties: { n: 14 } }, 'PATCH');
  const newer = await api(actor, `/databases/${db}`); let releaseOld, reads = 0;
  const oldReleased = new Promise(resolve => { releaseOld = resolve; });
  await page.route(`**/api/databases/${db}`, async route => {
    reads++; if (reads === 1) { await oldReleased; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(older) }); }
    else { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(newer) }); releaseOld(); }
  });
  const racing = await page.evaluate(db => Promise.all([controller.loadDatabase(db), controller.loadDatabase(db)]), db);
  assert.ok(racing.every(snapshot => snapshot.rows.find(row => row.id === initial.id).properties.n === 14));
  await page.unroute(`**/api/databases/${db}`);
  stage = 'applied overlay never overwrites a later canonical edit';
  await actor.setOffline(true); await call(page, 'patchRow', db, initial.id, { properties: { n: 15 } });
  let queuedRecord = (await call(page, 'records'))[0];
  let envelope = await page.evaluate(operation => ({ workspace_id: profile.workspaceId, session_binding: profile.cacheBinding, operations: [operation] }), queuedRecord.operation);
  let appliedResponse = await api(actor, '/sync', envelope);
  await api(remote, `/databases/${db}/rows/${initial.id}`, { properties: { n: 16 } }, 'PATCH');
  const newerApplied = await api(actor, `/databases/${db}`);
  await page.evaluate(async ({ record, result, snapshot }) => {
    await FountainOffline.updateMutation(profile, record.id, { status: 'applied', result });
    await FountainOffline.saveDatabase(FountainOffline.databaseKey(profile, snapshot.database.id), snapshot);
  }, { record: queuedRecord, result: appliedResponse.results[0], snapshot: newerApplied });
  assert.equal((await call(page, 'loadDatabase', db, { remote: false })).rows.find(row => row.id === initial.id).properties.n, 16);
  assert.equal((await call(page, 'records'))[0].status, 'applied');
  await actor.setOffline(false); await call(page, 'sync'); assert.equal((await call(page, 'records')).length, 0);
  stage = 'batch cap and sync waiter include work enqueued during an active flight';
  await actor.setOffline(true);
  await call(page, 'createRow', db, { properties: { name: '첫 동기화' } });
  let releaseSync, syncCount = 0; const firstSyncHeld = new Promise(resolve => { releaseSync = resolve; });
  await page.route('**/api/sync', async route => { syncCount++; if (syncCount === 1) await firstSyncHeld; await route.continue(); });
  await actor.setOffline(false);
  const inFlight = call(page, 'sync');
  await page.waitForFunction(() => !!controller.syncing);
  const whileFlying = await call(page, 'createRow', db, { properties: { name: '비행 중 추가' } });
  const waiter = call(page, 'sync'); releaseSync(); await Promise.all([inFlight, waiter]); await page.unroute('**/api/sync');
  assert.ok((await api(actor, `/databases/${db}`)).rows.some(row => row.id === whileFlying.id)); assert.equal((await call(page, 'records')).length, 0);
  stage = 'sync waiter covers work queued after the original final batch';
  await actor.setOffline(true); await call(page, 'createRow', db, { properties: { name: '마지막 배치 전' } });
  await page.evaluate(() => {
    const changed = controller.changed.bind(controller); let held = false;
    controller.changed = async detail => { if (detail.reason === 'synced' && !held) { held = true; globalThis.tailReached = true; await new Promise(resolve => { globalThis.releaseTail = resolve; }); } return changed(detail); };
  });
  await actor.setOffline(false); const tailFlight = call(page, 'sync'); await page.waitForFunction(() => globalThis.tailReached === true);
  const afterTail = await call(page, 'createRow', db, { properties: { name: '마지막 배치 이후' } });
  const tailWaiter = call(page, 'sync'); await page.evaluate(() => globalThis.releaseTail()); await Promise.all([tailFlight, tailWaiter]);
  assert.ok((await api(actor, `/databases/${db}`)).rows.some(row => row.id === afterTail.id)); assert.equal((await call(page, 'records')).length, 0);
  stage = 'more than fifty operations are sent in bounded batches';
  await actor.setOffline(true);
  for (let index = 0; index < 51; index++) await call(page, 'createRow', db, { properties: { name: '배치 항목 ' + index } });
  const batchSizes = [];
  await page.route('**/api/sync', async route => { batchSizes.push(route.request().postDataJSON().operations.length); await route.continue(); });
  await actor.setOffline(false); await call(page, 'sync'); await page.unroute('**/api/sync');
  assert.ok(batchSizes.length >= 2 && batchSizes.every(size => size <= 50)); assert.equal(batchSizes.reduce((sum, count) => sum + count, 0), 51);
  assert.equal((await call(page, 'records')).length, 0);
  stage = 'same-account new login is never cleared by stale controller';
  const oldProfile = await page.evaluate(() => profile); await page.evaluate(() => { channel.close(); controller.close(); });
  await api(actor, '/session', {}, 'DELETE'); const replacement = await api(actor, '/session', { email: owner.email, password });
  await page.evaluate(async session => { const response = await FountainTransport.request('/api/workspace'); const workspace = await response.json(); profile = await FountainOffline.saveProfile({ workspaceId: session.workspace_id, memberId: session.member.id, session, workspace }); }, replacement);
  const nextId = await page.evaluate(() => profile.id); assert.notEqual(nextId, oldProfile.id);
  await page.evaluate(async old => { const stale = new FountainMutations.Controller({ profile: old }); try { await stale.sync(); } catch {} stale.close(); }, oldProfile);
  assert.equal(await page.evaluate(async () => (await FountainOffline.getProfile()).id), nextId);
  stage = 'per-operation denial retains readable database; GET revocation purges only canonical data';
  const family = await context(); await api(family, '/session', { email: member.email, password }); const familyPage = await pageFor(family);
  await call(familyPage, 'loadDatabase', db); await family.setOffline(true); await call(familyPage, 'patchRow', db, initial.id, { properties: { n: 10 } });
  await api(actor, `/databases/${db}/permissions`, { permissions: { default: 'private', members: { [member.id]: 'view' }, groups: {}, inherit: false } }, 'PATCH');
  await family.setOffline(false); await call(familyPage, 'sync');
  const denied = await call(familyPage, 'records'); assert.equal(denied.length, 1); assert.equal(denied[0].status, 'denied');
  assert.ok((await call(familyPage, 'loadDatabase', db)).rows.length > 0);
  assert.equal(await familyPage.evaluate(() => events.some(value => value?.kind === 'database')), false);
  await api(actor, `/databases/${db}/permissions`, { permissions: { default: 'private', members: {}, groups: {}, inherit: false } }, 'PATCH');
  const status = await familyPage.evaluate(async db => { try { await controller.loadDatabase(db); return 0; } catch (error) { return error.status; } }, db); assert.equal(status, 404);
  assert.equal(await familyPage.evaluate(async db => await FountainOffline.getDatabase(FountainOffline.databaseKey(profile, db)) === null, db), true);
  assert.equal((await call(familyPage, 'records'))[0].status, 'denied'); assert.equal((await call(familyPage, 'export')).records.length, 1);
  await call(familyPage, 'drop', denied[0].id); assert.equal((await call(familyPage, 'records')).length, 0);
  stage = 'failed page creation reuses its original RGA epoch atomically';
  const privateParent = await api(actor, '/pages', { title: '가족 편집 상위', permissions: { default: 'private', members: { [member.id]: 'edit' }, groups: {}, inherit: false } });
  await api(actor, `/pages/${privateParent.id}/permissions`, { permissions: { default: 'private', members: { [member.id]: 'edit' }, groups: {}, inherit: false } }, 'PATCH');
  await familyPage.evaluate(async () => { const response = await FountainTransport.request('/api/workspace'); await controller.workspace(await response.json()); });
  await family.setOffline(true);
  const recoverPage = await call(familyPage, 'createPage', { title: '권한 복구 문서', parent_id: privateParent.id });
  await call(familyPage, 'patchPage', recoverPage.page.id, { title: '미전송 제목 변경' }, { basePage: recoverPage.page });
  await familyPage.evaluate(async ({ id, snapshot }) => {
    globalThis.recoveryChannel = new FountainCollaboration.DocumentChannel({ pageId: id, profile, deferRemote: true }); await recoveryChannel.open(snapshot, { cached: true });
    recoveryChannel.submit([{ type: 'block.insert', block_id: 'recovered-text', fields: { block_type: 'paragraph' } }]); recoveryChannel.replaceText('recovered-text', '재적용 뒤에도 남는 내 본문'); await recoveryChannel.persistence;
  }, { id: recoverPage.page.id, snapshot: recoverPage.snapshot });
  const earlyGets = [];
  familyPage.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/pages/' + recoverPage.page.id)) earlyGets.push(request.url()); });
  await api(actor, `/pages/${privateParent.id}/permissions`, { permissions: { default: 'private', members: { [member.id]: 'view' }, groups: {}, inherit: false } }, 'PATCH');
  await family.setOffline(false); await call(familyPage, 'sync');
  const deniedCreate = (await call(familyPage, 'records')).find(record => record.id === recoverPage.operation.id); assert.equal(deniedCreate.status, 'denied');
  assert.equal(earlyGets.length, 0, 'failed creation must not attempt a GET that purges the local draft');
  const originalRecovery = await call(familyPage, 'export', deniedCreate.id); assert.equal(originalRecovery.records.length, 2);
  await api(actor, `/pages/${privateParent.id}/permissions`, { permissions: { default: 'private', members: { [member.id]: 'edit' }, groups: {}, inherit: false } }, 'PATCH');
  const reappliedCreate = await call(familyPage, 'reapply', deniedCreate.id); assert.equal(reappliedCreate.operations.length, 2);
  const kept = await call(familyPage, 'localPage', recoverPage.page.id); assert.equal(kept.metadata.initial_epoch, recoverPage.operation.document_epoch); assert.notEqual(kept.metadata.create_operation_id, recoverPage.operation.id);
  await call(familyPage, 'sync'); await familyPage.evaluate(async () => { await recoveryChannel.resumeRemote(); await recoveryChannel.flush(); });
  const recovered = await api(family, `/pages/${recoverPage.page.id}/collaboration`);
  assert.equal(recovered.epoch, recoverPage.operation.document_epoch); assert.equal(recovered.page.title, '미전송 제목 변경'); assert.equal(recovered.blocks[0].text, '재적용 뒤에도 남는 내 본문');
  stage = 'fresh workspace omits revoked pages even when private snapshots remain cached';
  await call(familyPage, 'canonicalPage', privateParent.id);
  await api(actor, `/pages/${privateParent.id}/permissions`, { permissions: { default: 'private', members: {}, groups: {}, inherit: false } }, 'PATCH');
  const revokedWorkspace = await api(family, '/workspace');
  assert.equal((await call(familyPage, 'workspace', revokedWorkspace)).pages.some(value => value.id === privateParent.id), false, 'old cached pages cannot restore an absent revoked workspace entry');
  stage = 'private ID collision preserves export and never deletes the server resource';
  await family.setOffline(true); const collision = await call(familyPage, 'createPage', { title: '내 로컬 충돌 초안' });
  await api(actor, '/pages', { id: collision.page.id, title: '서버 소유자의 비공개 문서', permissions: { default: 'private', members: {}, groups: {}, inherit: false } });
  await family.setOffline(false); await call(familyPage, 'sync');
  const collisionRecord = (await call(familyPage, 'records')).find(record => record.id === collision.operation.id); assert.equal(collisionRecord.status, 'conflict');
  assert.equal(await familyPage.evaluate(async id => { try { await controller.reapply(id); return false; } catch (error) { return error.code === 'UNSUPPORTED_RECOVERY' && (await controller.export(id)).records.length === 1; } }, collision.operation.id), true);
  await call(familyPage, 'drop', collision.operation.id);
  assert.equal((await api(actor, `/pages/${collision.page.id}`)).page.title, '서버 소유자의 비공개 문서');
  stage = 'confirmed discard removes a local document and dependent drafts atomically';
  await family.setOffline(true); const droppedRoot = await call(familyPage, 'createPage', { title: '폐기할 로컬 상위' });
  await call(familyPage, 'patchPage', droppedRoot.page.id, { title: '함께 폐기할 제목' }, { basePage: droppedRoot.page });
  const droppedChild = await call(familyPage, 'createPage', { title: '폐기할 로컬 하위', parent_id: droppedRoot.page.id });
  await familyPage.evaluate(async ({ id, snapshot }) => {
    const key = FountainOffline.key(profile, id); const op = { id: 'local-drop:1', client: 'local-drop', clock: 1, type: 'block.insert', block_id: 'drop-text', block_type: 'paragraph', _epoch: snapshot.epoch };
    await FountainOffline.putOperations(key, [op]); await FountainOffline.saveDraft(key, 'drop-tab', { epoch: snapshot.epoch, blocks: [{ text: '내보낸 뒤 폐기할 본문' }] });
  }, { id: droppedRoot.page.id, snapshot: droppedRoot.snapshot });
  const discardExport = await call(familyPage, 'export', droppedRoot.operation.id); assert.equal(discardExport.records.length, 3); assert.ok(discardExport.localPages[0].drafts.length);
  const removed = await call(familyPage, 'drop', droppedRoot.operation.id); assert.equal(removed.droppedIds.length, 3);
  for (const id of [droppedRoot.page.id, droppedChild.page.id]) {
    assert.equal(await call(familyPage, 'localPage', id), null);
    assert.equal(await familyPage.evaluate(id => FountainOffline.getSnapshot(FountainOffline.key(profile, id)), id), null);
  }
  assert.equal((await call(familyPage, 'records')).length, 0);
  stage = 'guest child creation and recovery require an actual editable parent';
  const guest=await api(actor,'/members',{name:'게스트',email:'controller-guest@example.local',role:'guest'});await api(actor,'/accounts',{member_id:guest.id,password});const guestContext=await context();await api(guestContext,'/session',{email:guest.email,password});
  const guestParent=await api(actor,'/pages',{title:'게스트 편집 상위',permissions:{default:'private',members:{[guest.id]:'edit'},groups:{},inherit:false}});await api(actor,'/pages/'+guestParent.id+'/permissions',{permissions:{default:'private',members:{[guest.id]:'edit'},groups:{},inherit:false}},'PATCH');
  const guestPage=await pageFor(guestContext);await guestContext.setOffline(true);const guestChild=await call(guestPage,'createPage',{title:'게스트의 하위 초안',parent_id:guestParent.id});assert.equal(guestChild.operation.body.parent_id,guestParent.id);
  assert.equal(await guestPage.evaluate(()=>controller.createPage({title:'권한 없는 최상위'}).then(()=>null,error=>error.status)),403);const guestExport=await call(guestPage,'export',guestChild.operation.id);await guestContext.setOffline(false);
  if(!await guestPage.evaluate(()=>!!globalThis.FountainRecovery))await guestPage.addScriptTag({url:origin+'/recovery.js'});
  const guestPreview=await call(guestPage,'prepareImport',JSON.stringify(guestExport));assert.ok(guestPreview.token,'recovery planner permits a fresh guest child under the currently editable parent');await guestPage.evaluate(token=>controller.discardPrepared(token),guestPreview.token);
  await call(guestPage,'sync');assert.equal((await api(guestContext,'/pages/'+guestChild.page.id)).page.title,'게스트의 하위 초안');await guestPage.evaluate(()=>controller.close());await guestContext.close();
  stage = 'actual guest UI child modal/form path and readonly-parent denial';
  const readonlyParent=await api(actor,'/pages',{title:'게스트 읽기 전용 상위',permissions:{default:'private',members:{[guest.id]:'view'},groups:{},inherit:false}});await api(actor,'/pages/'+readonlyParent.id+'/permissions',{permissions:{default:'private',members:{[guest.id]:'view'},groups:{},inherit:false}},'PATCH');
  const guestUIContext=await browser.newContext({serviceWorkers:'block'});await api(guestUIContext,'/session',{email:guest.email,password});const guestUI=await guestUIContext.newPage();await guestUI.goto(origin);await guestUI.waitForSelector('#sidebar .brand');await guestUI.waitForFunction(()=>!!state.mutations&&state.loaded);
  assert.equal(await guestUI.locator('[data-action="add-page"]:not([data-parent])').count(),0);assert.equal(await guestUI.locator('[data-action="add-page"][data-parent="'+readonlyParent.id+'"]').count(),0);
  await guestUI.locator('[data-action="add-page"][data-parent="'+guestParent.id+'"]').click();await guestUI.locator('#page-form [name=title]').fill('실제 게스트 UI 하위');await guestUI.locator('#page-form .solid-btn').click();await guestUI.waitForFunction(()=>state.page?.title==='실제 게스트 UI 하위'&&!!document.querySelector('#page-title'));const uiChild=await guestUI.evaluate(()=>state.page.id);assert.equal((await api(guestUIContext,'/pages/'+uiChild)).page.parent_id,guestParent.id);
  await guestUI.evaluate(id=>doAction({dataset:{action:'add-page',parent:id}}),readonlyParent.id);await guestUI.locator('#page-form [name=title]').fill('읽기 전용 상위 차단');await guestUI.locator('#page-form .solid-btn').click();await guestUI.waitForFunction(()=>document.querySelector('#toast').textContent.includes('권한'));assert.equal((await api(guestUIContext,'/workspace')).pages.some(page=>page.title==='읽기 전용 상위 차단'),false);await guestUIContext.close();
  console.log('PASS mutation controller: HTTP replay, two tabs, touched/opening bases, conflict recovery, subtree receipts, lost responses, durable applied ACK, local epochs/RGA, Unicode IDs, account/ACL isolation, guest editable-parent actual UI child creation and readonly denial');
} catch (error) { console.error('Mutation controller QA failed at: ' + stage); throw error; }
finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (server.exitCode === null) server.kill('SIGKILL'); }
  await rm(directory, { recursive: true, force: true });
}
