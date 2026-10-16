/** Real Chrome IndexedDB recovery staging; no business HTTP or native SDK. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const sources = Object.fromEntries(await Promise.all(['offline.js', 'collaboration.js'].map(async name => ['/' + name, await readFile(new URL('../static/' + name, import.meta.url))])));
let apiRequests = 0;
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (sources[request.url]) { response.setHeader('Content-Type', 'application/javascript'); response.end(sources[request.url]); }
  else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Recovery storage</title>'); }
  else { if (request.url.startsWith('/api/')) apiRequests++; response.statusCode = 404; response.end('Missing'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser, stage = 'boot';
async function boot(page) {
  await page.goto(origin);
  await page.addScriptTag({ url: origin + '/offline.js' });
  await page.addScriptTag({ url: origin + '/collaboration.js' });
  await page.evaluate(() => {
    window.bundle = (tag, { page = true, digest = null } = {}) => {
      const target = 'import-page-' + tag, epoch = crypto.randomUUID(), resourceKey = FountainOffline.key(profile, target);
      const operation = { id: 'create-' + tag, kind: 'page.create', target_id: target, document_epoch: epoch,
        body: { id: target, title: '가족 복구 ' + tag, parent_id: null }, depends_on: [] };
      const model = { id: target, title: operation.body.title, parent_id: null, owner_id: profile.memberId,
        access_level: 4, revision: 0, locked: false, archived: false, blocks: [] };
      const snapshot = { epoch, seq: 0, state: FountainCollaboration.seedState([]), page: structuredClone(model), blocks: [], access_level: 4,
        workspace_id: profile.workspaceId, current_member_id: profile.memberId, session_binding: profile.cacheBinding };
      return { digest: digest || FountainCollaboration.sha256(tag),
        mutations: [{ resourceKey: FountainOffline.databaseKey(profile, 'family-db'), operation: {
          id: 'patch-' + tag, kind: 'row.patch', database_id: 'family-db', target_id: 'existing-row',
          body: { properties: { name: '가족 ' + tag } }, base: { properties: { name: '기존' }, schema: { name: { id: 'name', type: 'title' } } }, depends_on: [] } },
          ...(page ? [{ resourceKey, operation }] : [])],
        localPages: page ? [{ resourceKey, metadata: { page: model, initial_epoch: epoch, create_operation_id: operation.id, localOnly: true },
          snapshot, operations: [{ id: 'import_' + tag + ':1', client: 'import_' + tag, clock: 1, type: 'block.insert', block_id: 'block-' + tag,
            block_type: 'paragraph', parent_id: null, after_id: null, _epoch: epoch }], drafts: [] }] : [],
        drafts: [{ resourceKey: FountainOffline.key(profile, 'existing-page'), clientId: 'recovery-' + tag,
          draft: { reason: 'imported_recovery', blocks: [{ id: 'draft-' + tag, type: 'paragraph', text: '미전송 본문 🏠' }] } }] };
    };
    window.readAll = async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('fountain-offline-v1', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([...db.objectStoreNames], 'readonly'), result = {};
          for (const name of db.objectStoreNames) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result; }; }
          tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    };
  });
}
async function rejection(page, body, name = null) {
  return page.evaluate(async ({ body, name }) => {
    try { await (0, eval)(body)(); return false; } catch (error) { return name === null || error.name === name; }
  }, { body: String(body), name });
}
try {
  browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
  await boot(page);
  const profile = await page.evaluate(async () => {
    window.profile = await FountainOffline.saveProfile({ workspaceId: 'family|workspace', memberId: 'member|one',
      session: { authenticated: true, mode: 'accounts', workspace_id: 'family|workspace', cache_binding: 'login-one', expires_at: new Date(Date.now() + 3600000).toISOString(), member: { id: 'member|one', active: true, role: 'member' } },
      workspace: { pages: [{ id: 'existing-page', title: '현재 문서', access_level: 4 }], databases: [{ id: 'family-db' }] } });
    window.events = []; addEventListener('fountain-offline-mutations-changed', event => events.push(event.detail)); return profile;
  });
  stage = 'atomic paused mutations, empty seed, fresh body and readable draft';
  const first = await page.evaluate(async () => {
    window.firstBundle = bundle('first'); const result = await FountainOffline.stageRecoveryImport(profile, firstBundle);
    return { result, records: await FountainOffline.listMutations(profile), pending: await FountainOffline.pendingMutations(profile), all: await readAll(), events };
  });
  assert.equal(first.result.duplicate, false); assert.equal(first.result.operationIds.length, 2); assert.deepEqual(first.result.pageIds, ['import-page-first']);
  assert.ok(first.records.every(record => record.status === 'paused')); assert.equal(first.pending.length, 0);
  assert.equal(first.all.operations.length, 1); assert.equal(first.all.snapshots[0].snapshot.blocks.length, 0);
  assert.equal(first.all.drafts[0].draft.blocks[0].text, '미전송 본문 🏠'); assert.equal(first.events.length, 1); assert.equal(first.events[0].recoveryImport, true);
  stage = 'duplicate receipt wins despite newly prepared fresh IDs';
  const duplicate = await page.evaluate(async () => FountainOffline.stageRecoveryImport(profile, bundle('new-preparation', { digest: firstBundle.digest })));
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.operationIds, first.result.operationIds);
  assert.equal(await page.evaluate(() => events.length), 1);
  stage = 'two tabs racing the same digest commit exactly once';
  const second = await context.newPage(); await boot(second); await second.evaluate(profile => { window.profile = profile; }, profile);
  const digest = 'a'.repeat(64);
  const raced = await Promise.all([page.evaluate(digest => FountainOffline.stageRecoveryImport(profile, bundle('race_a', { digest })), digest),
    second.evaluate(digest => FountainOffline.stageRecoveryImport(profile, bundle('race_b', { digest })), digest)]);
  assert.equal(raced.filter(result => result.duplicate).length, 1); assert.deepEqual(raced[0].operationIds, raced[1].operationIds);
  stage = 'parent child creation identities and dependency closure';
  const tree = await page.evaluate(async () => {
    const parent = bundle('tree_parent'), child = bundle('tree_child');
    const create = child.mutations[1].operation, parentID = parent.localPages[0].metadata.page.id;
    create.body.parent_id = parentID; create.depends_on = [parent.mutations[1].operation.id];
    child.localPages[0].metadata.page.parent_id = parentID; child.localPages[0].snapshot.page.parent_id = parentID;
    return FountainOffline.stageRecoveryImport(profile, { digest: FountainCollaboration.sha256('tree'),
      mutations: [...parent.mutations, ...child.mutations], localPages: [...parent.localPages, ...child.localPages], drafts: [...parent.drafts, ...child.drafts] });
  });
  assert.deepEqual(tree.pageIds, ['import-page-tree_parent', 'import-page-tree_child']); assert.equal(tree.operationIds.length, 4); assert.equal(tree.draftKeys.length, 2);
  stage = 'collision preserves every pre-existing record';
  const baseline = await page.evaluate(() => readAll());
  assert.ok(await rejection(page, async () => { const value = bundle('collision'); value.mutations[0].operation.id = 'patch-first'; await FountainOffline.stageRecoveryImport(profile, value); }, 'ConstraintError'));
  assert.deepEqual(await page.evaluate(() => readAll()), baseline);
  stage = 'failure at the final receipt rolls back earlier successful writes';
  assert.ok(await rejection(page, async () => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(value, ...args) {
      if (this.name === 'meta' && value.id.startsWith('recovery-import:')) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return add.call(this, value, ...args);
    };
    try { await FountainOffline.stageRecoveryImport(profile, bundle('quota')); } finally { IDBObjectStore.prototype.add = add; }
  }, 'QuotaExceededError'));
  assert.deepEqual(await page.evaluate(() => readAll()), baseline);
  stage = 'UI cancellation after the first successful mutation aborts all stores';
  assert.ok(await rejection(page, async () => {
    const add = IDBObjectStore.prototype.add; let current = true;
    IDBObjectStore.prototype.add = function(...args) { const result = add.apply(this, args); if (this.name === 'mutations') current = false; return result; };
    try { await FountainOffline.stageRecoveryImport(profile, bundle('cancel'), { isCurrent: () => current }); } finally { IDBObjectStore.prototype.add = add; }
  }, 'AbortError'));
  assert.deepEqual(await page.evaluate(() => readAll()), baseline);
  stage = 'malformed seed, scope, dependency graph and forged receipt rejection';
  for (const mutation of [
    value => { value.localPages[0].snapshot.blocks = [{ id: 'old', text: 'forged canonical' }]; },
    value => { value.localPages[0].snapshot.current_member_id = 'another-member'; },
    value => { value.localPages[0].operations[0]._epoch = 'old-source-epoch'; },
    value => { value.mutations[0].operation.depends_on = ['old-source-op']; },
    value => { value.drafts[0].resourceKey = FountainOffline.key(profile, 'unknown-target'); },
    value => { value.mutations[0].resourceKey = value.mutations[0].resourceKey.replace(location.origin, 'https://other.invalid'); },
    value => { value.mutations[0].operation.body.owner_id = 'forged-owner'; },
    value => { value.mutations[0].operation.depends_on = [value.mutations[1].operation.id]; value.mutations[1].operation.depends_on = [value.mutations[0].operation.id]; },
    value => { value.receipt = { operationIds: ['forged-applied'] }; }
  ]) {
    assert.ok(await page.evaluate(async code => { const value = bundle('malformed'); (0, eval)('(' + code + ')')(value); try { await FountainOffline.stageRecoveryImport(profile, value); return false; } catch { return true; } }, String(mutation)));
  }
  assert.deepEqual(await page.evaluate(() => readAll()), baseline);
  stage = 'current resource tombstone cannot be resurrected';
  await page.evaluate(() => FountainOffline.purgeResource(FountainOffline.key(profile, 'existing-page')));
  assert.ok(await rejection(page, async () => FountainOffline.stageRecoveryImport(profile, bundle('revoked')), 'SecurityError'));
  stage = 'reload durability and exact-login logout purge';
  await page.reload(); await boot(page); await page.evaluate(profile => { window.profile = profile; }, profile);
  const afterReload = await page.evaluate(() => FountainOffline.listMutations(profile)); assert.equal(afterReload.length, 8); assert.ok(afterReload.every(record => record.status === 'paused'));
  await page.evaluate(() => FountainOffline.clearProfile(profile));
  assert.equal((await page.evaluate(() => readAll())).meta.filter(record => record.id.startsWith('recovery-import:')).length, 0);
  const other = await page.evaluate(async () => { window.oldProfile = profile; window.profile = await FountainOffline.saveProfile({ ...profile,
    session: { ...profile.session, cache_binding: 'login-two', member: { id: 'member-two', active: true, role: 'member' } }, memberId: 'member-two' }); return profile; });
  assert.notEqual(other.id, profile.id);
  assert.ok(await rejection(page, async () => FountainOffline.stageRecoveryImport(oldProfile, bundle('old-actor')), 'SecurityError'));
  assert.equal(apiRequests, 0, 'storage import must perform no business HTTP');
  console.log('PASS real Chrome recovery import: paused staging, receipt dedupe, two-tab race, collisions, rollback, cancellation, tombstones, cold reload and actor isolation');
} catch (error) { console.error('FAIL stage:', stage); throw error; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
