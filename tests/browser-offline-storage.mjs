/** Real IndexedDB v1→v2 migration, typed database caches and durable mutation fences. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FOUNTAIN_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source = await readFile(new URL('../static/offline.js', import.meta.url));
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/offline.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(source); }
  else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Offline storage verification</title><main>Offline storage verification</main>'); }
  else { response.statusCode = 404; response.end('Missing'); }
});
let browser, stage = 'startup';
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
async function script(page) { await page.addScriptTag({ url: origin + '/offline.js' }); }
async function rejected(page, callback, input, name = 'SecurityError') {
  return page.evaluate(async ({ callback, input, name }) => {
    try { await (0, eval)(callback)(input); return false; }
    catch (error) { return error.name === name; }
  }, { callback: String(callback), input, name });
}
try {
  browser = await chromium.launch(process.env.FOUNTAIN_CHROME ? { executablePath: process.env.FOUNTAIN_CHROME, headless: true } : { channel: 'chrome', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(origin);
  stage = 'real version-1 fixture and migration';
  const fixture = await page.evaluate(async () => {
    const profile = { origin: location.origin, workspaceId: 'workspace|family', memberId: 'member|one', cacheBinding: 'login-one',
      session: { authenticated: true, mode: 'accounts', cache_binding: 'login-one', expires_at: new Date(Date.now() + 3600000).toISOString(), member: { id: 'member|one', role: 'member', active: true } },
      workspace: { pages: [{ id: 'migration-page', title: '이전 문서' }], databases: [{ id: 'migration-page', name: '이전 데이터베이스' }, { id: 'other-db', name: '다른 DB' }] },
      validUntil: Date.now() + 3600000, updatedAt: Date.now() };
    profile.id = [location.origin, profile.workspaceId, profile.memberId, profile.cacheBinding].map((value, index) => index ? encodeURIComponent(value) : value).join('|');
    const key = profile.id + '|migration-page';
    const database = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('fountain-offline-v1', 1);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore('profiles', { keyPath: 'id' }); db.createObjectStore('meta', { keyPath: 'id' });
        for (const [name, keyPath] of [['snapshots', 'key'], ['operations', ['key', 'id']], ['drafts', ['key', 'clientId']]]) {
          const store = db.createObjectStore(name, { keyPath }); store.createIndex('profileId', 'profileId');
          if (name !== 'snapshots') store.createIndex('key', 'key');
        }
      };
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['profiles', 'meta', 'snapshots', 'operations', 'drafts'], 'readwrite');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      tx.objectStore('profiles').put(profile); tx.objectStore('meta').put({ id: 'active', profileId: profile.id });
      tx.objectStore('meta').put({ id: 'revoked-resource:' + profile.id + '|previously-revoked', revokedAt: Date.now() });
      tx.objectStore('snapshots').put({ key, profileId: profile.id, snapshot: { epoch: 'old-epoch', seq: 2, page: { id: 'migration-page', revision: 2 }, blocks: [{ text: '보존할 문서' }] }, updatedAt: Date.now() });
      tx.objectStore('operations').put({ key, id: 'legacy:1', profileId: profile.id, operation: { id: 'legacy:1', text: '이전 미전송 편집' } });
      tx.objectStore('drafts').put({ key, clientId: 'legacy-tab', profileId: profile.id, draft: { epoch: 'old-epoch', blocks: [{ text: '복구 초안' }] }, updatedAt: Date.now() });
    });
    database.close(); return { profile, key };
  });
  await script(page);
  assert.equal((await page.evaluate(() => FountainOffline.getProfile())).id, fixture.profile.id);
  assert.equal((await page.evaluate(key => FountainOffline.getSnapshot(key), fixture.key)).blocks[0].text, '보존할 문서');
  assert.equal((await page.evaluate(key => FountainOffline.pendingOperations(key), fixture.key)).length, 1);
  assert.equal((await page.evaluate(key => FountainOffline.getDrafts(key), fixture.key)).length, 1);
  assert.equal(await page.evaluate(async () => new Promise((resolve, reject) => {
    const opening = indexedDB.open('fountain-offline-v1'); opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { const db = opening.result; const version = db.version; db.close(); resolve(version); };
  })), 2);
  assert.equal(await rejected(page, key => FountainOffline.saveSnapshot(key, {}), fixture.profile.id + '|previously-revoked'), true);
  stage = 'typed database snapshots and revision guards';
  const databaseKey = await page.evaluate(profile => FountainOffline.databaseKey(profile, 'migration-page'), fixture.profile);
  assert.equal(databaseKey.split('|').length, 6);
  assert.notEqual(databaseKey, fixture.key);
  const snapshot = { database: { id: 'migration-page', name: '가족 프로젝트', access_level: 1 }, rows: [{ id: 'row-a', properties: { name: '기존 행' } }],
    workspace_id: fixture.profile.workspaceId, current_member_id: fixture.profile.memberId, session_binding: fixture.profile.cacheBinding, access_revision: 4, data_revision: 8 };
  await page.evaluate(({ key, value }) => FountainOffline.saveDatabase(key, value), { key: databaseKey, value: snapshot });
  await page.evaluate(async ({ key, value }) => {
    await FountainOffline.saveDatabase(key, { ...value, data_revision: 7, database: { ...value.database, name: '오래된 데이터' } });
    await FountainOffline.saveDatabase(key, { ...value, access_revision: 3, database: { ...value.database, access_level: 3 } });
  }, { key: databaseKey, value: snapshot });
  assert.equal((await page.evaluate(key => FountainOffline.getDatabase(key), databaseKey)).database.name, '가족 프로젝트');
  assert.equal((await page.evaluate(key => FountainOffline.getDatabase(key), databaseKey)).database.access_level, 1);
  assert.equal((await page.evaluate(profile => FountainOffline.listDatabases(profile), fixture.profile)).length, 1);
  assert.equal(await page.evaluate(key => FountainOffline.getSnapshot(key), databaseKey), null);
  assert.equal(await page.evaluate(key => FountainOffline.getDatabase(key), fixture.key), null);
  assert.equal(await rejected(page, key => FountainOffline.saveSnapshot(key, {}), databaseKey), true);
  assert.equal(await rejected(page, ({ key, value }) => FountainOffline.saveDatabase(key, value), { key: databaseKey, value: { ...snapshot, current_member_id: 'other-member' } }), true);
  const second = await context.newPage(); await second.goto(origin); await script(second);
  stage = 'two-tab immutable queue union and paused conflicts';
  const operation = (id, name) => ({ id, kind: 'row.patch', target_id: 'row-a', database_id: 'migration-page', depends_on: [], body: { properties: { name } }, base: { properties: { name: '기존 행' } } });
  const firstOp = operation('tab-a:1', '첫 탭');
  const secondOp = operation('tab-b:1', '둘째 탭');
  await Promise.all([
    page.evaluate(({ profile, key, op }) => FountainOffline.putMutations(profile, key, [op]), { profile: fixture.profile, key: databaseKey, op: firstOp }),
    second.evaluate(({ profile, key, op }) => FountainOffline.putMutations(profile, key, [op]), { profile: fixture.profile, key: databaseKey, op: secondOp }),
  ]);
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), fixture.profile)).length, 2);
  await page.evaluate(({ profile, key, op }) => FountainOffline.putMutations(profile, key, [{ base: op.base, body: op.body, depends_on: op.depends_on, database_id: op.database_id, target_id: op.target_id, kind: op.kind, id: op.id }]), { profile: fixture.profile, key: databaseKey, op: firstOp });
  assert.equal(await rejected(page, ({ profile, key, op }) => FountainOffline.putMutations(profile, key, [op]), { profile: fixture.profile, key: databaseKey, op: operation('tab-a:1', '불변 ID 덮기') }, 'ConstraintError'), true);
  assert.equal(await rejected(page, ({ profile, key }) => FountainOffline.putMutations(profile, key, [{ id: 'must-rollback' }, {}]), { profile: fixture.profile, key: databaseKey }, 'TypeError'), true);
  assert.equal((await page.evaluate(profile => FountainOffline.listMutations(profile), fixture.profile)).some(record => record.id === 'must-rollback'), false);
  await page.evaluate(profile => FountainOffline.updateMutation(profile, 'tab-a:1', { status: 'conflict', result: { http_status: 409, error: '같은 필드 변경' } }), fixture.profile);
  await page.reload(); await script(page);
  assert.equal((await page.evaluate(profile => FountainOffline.listMutations(profile, { status: 'conflict' }), fixture.profile)).length, 1);
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), fixture.profile)).length, 1);
  assert.equal(await rejected(page, profile => FountainOffline.updateMutation(profile, 'tab-a:1', { status: 'pending' }), fixture.profile, 'InvalidStateError'), true);
  const freshOp = operation('reapply:new-id', '새 기준으로 재적용'); freshOp.base.properties.name = '원격 최신값';
  await page.evaluate(({ profile, key, op }) => FountainOffline.putMutation(profile, key, op), { profile: fixture.profile, key: databaseKey, op: freshOp });
  assert.equal(await rejected(page, profile => FountainOffline.acknowledgeMutations(profile, ['tab-b:1']), fixture.profile, 'InvalidStateError'), true);
  await page.evaluate(profile => FountainOffline.updateMutation(profile, 'tab-b:1', { status: 'applied',
    result: { id: 'tab-b:1', status: 'applied', resource_id: 'row-a', data_revision: 9 } }), fixture.profile);
  assert.equal(await rejected(page, profile => FountainOffline.acknowledgeMutations(profile, ['tab-b:1']), fixture.profile, 'InvalidStateError'), true, 'a stale canonical snapshot must not erase applied recovery data');
  assert.equal((await page.evaluate(profile => FountainOffline.listMutations(profile), fixture.profile)).find(record => record.id === 'tab-b:1').status, 'applied');
  await page.evaluate(({ key, value }) => FountainOffline.saveDatabase(key, { ...value, data_revision: 9,
    rows: [{ id: 'row-a', properties: { name: '둘째 탭' } }] }), { key: databaseKey, value: snapshot });
  await Promise.all([
    page.evaluate(profile => FountainOffline.acknowledgeMutations(profile, ['tab-b:1']), fixture.profile),
    second.evaluate(({ profile, key, op }) => FountainOffline.putMutation(profile, key, op), { profile: fixture.profile, key: databaseKey, op: operation('tab-b:2', 'ACK와 동시에 새 편집') }),
  ]);
  const queued = await page.evaluate(profile => FountainOffline.listMutations(profile), fixture.profile);
  assert.equal(queued.some(record => record.id === 'tab-b:1'), false);
  assert.equal(queued.some(record => record.id === 'tab-b:2'), true);
  assert.equal(queued.find(record => record.id === 'tab-a:1').operation.body.properties.name, '첫 탭');
  stage = 'denied operations preserve readable canonical data and explicit cancellation';
  await page.evaluate(profile => FountainOffline.updateMutation(profile, 'tab-b:2', { status: 'denied', result: { http_status: 403, error: '이 행의 편집 권한이 없습니다.' } }), fixture.profile);
  assert.ok(await page.evaluate(key => FountainOffline.getDatabase(key), databaseKey), 'one denied row edit must not purge a still-readable database');
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), fixture.profile)).some(record => record.id === 'tab-b:2'), false);
  const denied = await page.evaluate(profile => FountainOffline.listMutations(profile, { status: 'denied' }), fixture.profile);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].operation.body.properties.name, 'ACK와 동시에 새 편집');
  await page.evaluate(profile => FountainOffline.removeMutation(profile, 'tab-b:2'), fixture.profile);
  assert.equal((await page.evaluate(profile => FountainOffline.listMutations(profile), fixture.profile)).some(record => record.id === 'tab-b:2'), false);
  assert.equal((await page.evaluate(profile => FountainOffline.listMutations(profile, { status: 'conflict' }), fixture.profile)).length, 1, 'discarding one denied record must keep independent conflicts');
  stage = 'atomic local page staging and create acknowledgement';
  const failedKey = await page.evaluate(profile => FountainOffline.key(profile, 'rollback-page'), fixture.profile);
  assert.equal(await rejected(page, ({ profile, key }) => FountainOffline.stageLocalPage(profile, key, {
    metadata: { id: 'rollback-page', initial_epoch: 'rollback-epoch', create_operation_id: 'tab-a:1', localOnly: true },
    snapshot: { epoch: 'rollback-epoch', page: { id: 'rollback-page' } },
    operation: { id: 'tab-a:1', kind: 'page.create', target_id: 'rollback-page', body: {} },
  }), { profile: fixture.profile, key: failedKey }, 'ConstraintError'), true);
  assert.equal(await page.evaluate(key => FountainOffline.getLocalPage(key), failedKey), null, 'failed staging must roll back its initial metadata');
  assert.equal(await page.evaluate(key => FountainOffline.getSnapshot(key), failedKey), null);
  const localKey = await page.evaluate(profile => FountainOffline.key(profile, 'local-page'), fixture.profile);
  const local = { metadata: { id: 'local-page', title: '기기 문서', initial_epoch: 'local-epoch', create_operation_id: 'page-create:1', localOnly: true },
    snapshot: { epoch: 'local-epoch', seq: 0, page: { id: 'local-page', title: '기기 문서', revision: 0 }, state: { v: 1, max_clock: 0, seen: {}, blocks: {} }, blocks: [], access_level: 4, access_revision: 4 },
    operation: { id: 'page-create:1', kind: 'page.create', target_id: 'local-page', depends_on: [], body: { title: '기기 문서', document_epoch: 'local-epoch' } } };
  await page.evaluate(({ profile, key, local }) => FountainOffline.stageLocalPage(profile, key, local), { profile: fixture.profile, key: localKey, local });
  assert.equal((await page.evaluate(key => FountainOffline.getLocalPage(key), localKey)).initial_epoch, 'local-epoch');
  assert.equal((await page.evaluate(key => FountainOffline.getSnapshot(key), localKey)).epoch, 'local-epoch');
  assert.equal((await page.evaluate(profile => FountainOffline.listLocalPages(profile), fixture.profile)).length, 1);
  await page.evaluate(({ key, metadata }) => FountainOffline.saveLocalPage(key, { ...metadata, localOnly: false }), { key: localKey, metadata: local.metadata });
  assert.equal((await page.evaluate(key => FountainOffline.getLocalPage(key), localKey)).localOnly, true, 'plain metadata writes cannot bypass pending page creation');
  assert.equal(await rejected(page, profile => FountainOffline.updateMutation(profile, 'page-create:1', { status: 'applied',
    result: { id: 'wrong-operation', status: 'applied', resource_id: 'local-page', data_revision: 10 } }), fixture.profile, 'TypeError'), true);
  await page.evaluate(async ({ profile, key, metadata }) => {
    await FountainOffline.updateMutation(profile, 'page-create:1', { status: 'applied', result: { id: 'page-create:1', status: 'applied', resource_id: 'local-page', revision: 0, data_revision: 10 } });
    if ((await FountainOffline.getLocalPage(key)).localOnly !== false) throw new Error('applied status and local-page confirmation must be atomic');
  }, { profile: fixture.profile, key: localKey, metadata: local.metadata });
  assert.equal(await rejected(page, profile => FountainOffline.acknowledgeMutations(profile, ['page-create:1']), fixture.profile, 'InvalidStateError'), true);
  assert.equal(await rejected(page, ({ key, snapshot }) => FountainOffline.saveSnapshot(key, { ...snapshot, current_member_id: 'wrong-member' }), { key: localKey, snapshot: local.snapshot }), true);
  await page.evaluate(async ({ profile, key, metadata, snapshot }) => {
    await FountainOffline.saveSnapshot(key, { ...snapshot, workspace_id: profile.workspaceId, current_member_id: profile.memberId, session_binding: profile.cacheBinding, data_revision: 10 });
    await FountainOffline.acknowledgeMutations(profile, ['page-create:1']);
    await FountainOffline.saveLocalPage(key, { ...metadata, localOnly: true, title: '늦은 탭 메타데이터' });
  }, { profile: fixture.profile, key: localKey, metadata: local.metadata, snapshot: local.snapshot });
  assert.equal((await page.evaluate(key => FountainOffline.getLocalPage(key), localKey)).localOnly, false, 'late tab cannot restore local-only state after create ACK');
  await page.evaluate(async ({ profile, key, local }) => {
    await FountainOffline.saveSnapshot(key, { ...local.snapshot, seq: 5, page: { ...local.snapshot.page, revision: 5 } });
    await FountainOffline.stageLocalPage(profile, key, local);
  }, { profile: fixture.profile, key: localKey, local });
  assert.equal((await page.evaluate(key => FountainOffline.getSnapshot(key), localKey)).seq, 5, 'repeated staging cannot replace a newer document snapshot');
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), fixture.profile)).some(record => record.id === 'page-create:1'), false, 'confirmed page creation must not be requeued');
  await page.evaluate(key => FountainOffline.deleteLocalPage(key), localKey);
  assert.equal(await page.evaluate(key => FountainOffline.getLocalPage(key), localKey), null);
  assert.ok(await page.evaluate(key => FountainOffline.getSnapshot(key), localKey), 'removing staging metadata must preserve synced document state');
  stage = 'atomic reapply keeps document identity and discard fences every tab';
  const retryKey = await page.evaluate(profile => FountainOffline.key(profile, 'retry-page'), fixture.profile);
  const retry = structuredClone(local);
  retry.metadata = { ...retry.metadata, id: 'retry-page', initial_epoch: 'retry-epoch', create_operation_id: 'retry-create:1' };
  retry.snapshot = { ...retry.snapshot, epoch: 'retry-epoch', page: { ...retry.snapshot.page, id: 'retry-page' } };
  retry.operation = { ...retry.operation, id: 'retry-create:1', target_id: 'retry-page', document_epoch: 'retry-epoch' };
  const followup = { id: 'retry-title:1', kind: 'page.patch', target_id: 'retry-page', depends_on: ['retry-create:1'],
    body: { title: '보관한 제목' }, base: { fields: { title: '기기 문서' } } };
  await page.evaluate(async ({ profile, key, retry, followup }) => {
    await FountainOffline.stageLocalPage(profile, key, retry);
    await FountainOffline.putMutation(profile, key, followup);
    await FountainOffline.putOperations(key, [{ id: 'document:1', text: '재시도에도 보존할 본문', _epoch: 'retry-epoch' }]);
    await FountainOffline.saveDraft(key, 'tab', { reason: 'pending', blocks: [{ text: '재시도에도 보존할 본문' }] });
    await FountainOffline.updateMutation(profile, retry.operation.id, { status: 'denied' });
    await FountainOffline.updateMutation(profile, followup.id, { status: 'deferred' });
  }, { profile: fixture.profile, key: retryKey, retry, followup });
  const replacements = [{ previousId: retry.operation.id, operation: { ...retry.operation, id: 'retry-create:2' } },
    { previousId: followup.id, operation: { ...followup, id: 'retry-title:2', depends_on: ['retry-create:2'] } }];
  assert.equal(await rejected(page, ({ profile, replacements }) => FountainOffline.replaceMutations(profile, replacements.slice(0, 1)), { profile: fixture.profile, replacements }, 'ConstraintError'), true);
  const invalidReplacements = structuredClone(replacements); invalidReplacements[1].operation.depends_on = ['retry-create:1'];
  assert.equal(await rejected(page, ({ profile, replacements }) => FountainOffline.replaceMutations(profile, replacements), { profile: fixture.profile, replacements: invalidReplacements }, 'InvalidStateError'), true);
  assert.equal((await page.evaluate(key => FountainOffline.getLocalPage(key), retryKey)).create_operation_id, 'retry-create:1', 'partial replacement failure must roll back the creation marker');
  assert.equal((await page.evaluate(profile => FountainOffline.listMutations(profile), fixture.profile)).some(record => record.id === 'retry-create:2'), false);
  await page.evaluate(({ profile, replacements }) => FountainOffline.replaceMutations(profile, replacements), { profile: fixture.profile, replacements });
  const retriedMetadata = await page.evaluate(key => FountainOffline.getLocalPage(key), retryKey);
  assert.equal(retriedMetadata.create_operation_id, 'retry-create:2');
  assert.equal(retriedMetadata.initial_epoch, 'retry-epoch');
  assert.equal(retriedMetadata.localOnly, true);
  assert.equal((await page.evaluate(key => FountainOffline.pendingOperations(key), retryKey))[0].text, '재시도에도 보존할 본문');
  assert.equal((await page.evaluate(key => FountainOffline.getDrafts(key), retryKey)).length, 1);
  assert.equal(await rejected(page, profile => FountainOffline.discardMutations(profile, ['retry-create:2']), fixture.profile, 'ConstraintError'), true);
  await page.evaluate(profile => FountainOffline.discardMutations(profile, ['retry-create:2', 'retry-title:2']), fixture.profile);
  assert.equal(await page.evaluate(key => FountainOffline.getLocalPage(key), retryKey), null);
  assert.equal(await rejected(second, ({ key, snapshot }) => FountainOffline.saveSnapshot(key, snapshot), { key: retryKey, snapshot: retry.snapshot }), true, 'another tab cannot recreate an explicitly discarded page');
  assert.deepEqual(await page.evaluate(async key => {
    const db = await new Promise(resolve => { const opening = indexedDB.open('fountain-offline-v1'); opening.onsuccess = () => resolve(opening.result); });
    try {
      const tx = db.transaction(['operations', 'drafts'], 'readonly');
      return await Promise.all(['operations', 'drafts'].map(name => new Promise(resolve => { const result = tx.objectStore(name).index('key').count(key); result.onsuccess = () => resolve(result.result); })));
    } finally { db.close(); }
  }, retryKey), [0, 0], 'discard must remove actual document records as well as hiding reads');
  const receiptSource = operation('after-source:1', '삭제보다 먼저 적용할 변경');
  const receiptDelete = { id: 'after-delete:1', kind: 'row.delete', target_id: 'row-a', database_id: 'migration-page',
    body: {}, depends_on: [], base_rows: { 'row-a': { updated_at: 'before', after_operation: receiptSource.id } } };
  await page.evaluate(({ profile, key, operations }) => FountainOffline.putMutations(profile, key, operations), {
    profile: fixture.profile, key: databaseKey, operations: [receiptSource, receiptDelete] });
  assert.equal(await rejected(page, profile => FountainOffline.discardMutations(profile, ['after-source:1']), fixture.profile, 'ConstraintError'), true, 'receipt references are dependencies even when not repeated in depends_on');
  await page.evaluate(profile => FountainOffline.discardMutations(profile, ['after-source:1', 'after-delete:1']), fixture.profile);
  stage = 'typed database purge and late-write fence';
  const otherKey = await page.evaluate(profile => FountainOffline.databaseKey(profile, 'other-db'), fixture.profile);
  const otherSnapshot = { ...snapshot, database: { id: 'other-db', name: '다른 DB' } };
  await page.evaluate(({ profile, key, snapshot }) => FountainOffline.saveDatabase(key, snapshot).then(() => FountainOffline.putMutation(profile, key, { id: 'other-db:1', kind: 'row.create', target_id: 'other-row', database_id: 'other-db', body: {} })), { profile: fixture.profile, key: otherKey, snapshot: otherSnapshot });
  await second.evaluate(() => { globalThis.lastPurge = null; addEventListener('fountain-offline-resource-purged', event => { globalThis.lastPurge = event.detail; }); });
  await page.evaluate(key => FountainOffline.purgeResource(key), databaseKey);
  await second.waitForFunction(() => globalThis.lastPurge?.kind === 'database');
  assert.equal(await page.evaluate(key => FountainOffline.getDatabase(key), databaseKey), null);
  const retained = await page.evaluate(profile => FountainOffline.listMutations(profile), fixture.profile);
  assert.ok(retained.filter(record => record.resourceKey === databaseKey).length >= 2, 'resource denial must preserve own edits as recovery records');
  assert.ok(retained.filter(record => record.resourceKey === databaseKey).every(record => record.status === 'denied' && record.recovery.reason === 'resource_revoked'));
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), fixture.profile)).some(record => record.resourceKey === databaseKey), false);
  assert.ok(await page.evaluate(key => FountainOffline.getSnapshot(key), fixture.key), 'database purge must not purge a page with the same ID');
  assert.equal(await rejected(second, ({ key, value }) => FountainOffline.saveDatabase(key, value), { key: databaseKey, value: snapshot }), true);
  assert.equal(await rejected(second, ({ profile, key, op }) => FountainOffline.putMutation(profile, key, op), { profile: fixture.profile, key: databaseKey, op: operation('late-denied', '금지된 늦은 응답') }), true);
  const lateProfile = await second.evaluate(profile => FountainOffline.saveProfile(profile), fixture.profile);
  assert.equal(lateProfile.workspace.databases.some(database => database.id === 'migration-page'), false);
  assert.ok(await page.evaluate(key => FountainOffline.getDatabase(key), otherKey));
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), fixture.profile)).filter(record => record.resourceKey === otherKey).length, 1);
  const raceKey = await page.evaluate(profile => FountainOffline.databaseKey(profile, 'race-db'), fixture.profile);
  const raceSnapshot = { ...snapshot, database: { id: 'race-db', name: '경쟁 DB' } };
  await page.evaluate(({ key, snapshot }) => FountainOffline.saveDatabase(key, snapshot), { key: raceKey, snapshot: raceSnapshot });
  await Promise.all([
    page.evaluate(key => FountainOffline.purgeResource(key), raceKey),
    second.evaluate(async ({ key, snapshot }) => {
      try { await FountainOffline.saveDatabase(key, { ...snapshot, data_revision: 9 }); }
      catch (error) { if (error.name !== 'SecurityError') throw error; }
    }, { key: raceKey, snapshot: raceSnapshot }),
  ]);
  assert.equal(await page.evaluate(key => FountainOffline.getDatabase(key), raceKey), null, 'purge must win over a concurrent late database response');
  stage = 'logout purges every v2 store and fences other-tab writes';
  await page.evaluate(() => FountainOffline.clearActiveProfile());
  assert.equal(await page.evaluate(async () => !!await FountainOffline.getProfile()), false);
  assert.equal(await rejected(second, ({ profile, key, op }) => FountainOffline.putMutation(profile, key, op), { profile: fixture.profile, key: otherKey, op: operation('late-logout', '늦은 로그아웃 응답') }), true);
  assert.equal(await rejected(second, profile => FountainOffline.saveProfile(profile), fixture.profile), true);
  assert.equal(await page.evaluate(async profileId => {
    const database = await new Promise(resolve => { const opening = indexedDB.open('fountain-offline-v1'); opening.onsuccess = () => resolve(opening.result); });
    try {
      const names = ['databaseSnapshots', 'mutations', 'localPages', 'snapshots', 'operations', 'drafts'];
      const tx = database.transaction(names, 'readonly');
      const counts = await Promise.all(names.map(name => new Promise(resolve => { const get = tx.objectStore(name).index('profileId').count(profileId); get.onsuccess = () => resolve(get.result); })));
      return counts.reduce((sum, count) => sum + count, 0);
    } finally { database.close(); }
  }, fixture.profile.id), 0);
  stage = 'new-login and different-member v2 isolation';
  const fresh = structuredClone(fixture.profile);
  fresh.cacheBinding = fresh.session.cache_binding = 'login-two';
  const freshProfile = await page.evaluate(profile => FountainOffline.saveProfile(profile), fresh);
  const freshKey = await page.evaluate(profile => FountainOffline.databaseKey(profile, 'other-db'), freshProfile);
  await page.evaluate(async ({ profile, key, snapshot }) => {
    await FountainOffline.saveDatabase(key, { ...snapshot, database: { id: 'other-db' }, session_binding: profile.cacheBinding });
    await FountainOffline.putMutation(profile, key, { id: 'fresh-unsent', kind: 'row.create', target_id: 'fresh-row', body: {} });
  }, { profile: freshProfile, key: freshKey, snapshot });
  await second.evaluate(profile => FountainOffline.clearProfile(profile), fixture.profile);
  assert.equal((await page.evaluate(() => FountainOffline.getProfile())).id, freshProfile.id, 'stale old-binding denial must preserve fresh actor login');
  assert.equal((await page.evaluate(profile => FountainOffline.pendingMutations(profile), freshProfile)).length, 1);
  assert.ok(await page.evaluate(key => FountainOffline.getDatabase(key), freshKey));
  assert.equal(await page.evaluate(key => FountainOffline.getDatabase(key), otherKey), null);
  const otherMember = structuredClone(fresh);
  otherMember.memberId = otherMember.session.member.id = 'other-member';
  otherMember.cacheBinding = otherMember.session.cache_binding = 'other-member-login';
  const otherProfile = await second.evaluate(profile => FountainOffline.saveProfile(profile), otherMember);
  assert.equal(await page.evaluate(key => FountainOffline.getDatabase(key), freshKey), null);
  assert.deepEqual(await page.evaluate(profile => FountainOffline.listMutations(profile), freshProfile), []);
  assert.deepEqual(await page.evaluate(profile => FountainOffline.listLocalPages(profile), freshProfile), []);
  assert.equal(await rejected(page, ({ profile, key }) => FountainOffline.putMutation(profile, key, { id: 'wrong-member', body: {} }), { profile: freshProfile, key: freshKey }), true);
  const otherMemberKey = await page.evaluate(profile => FountainOffline.databaseKey(profile, 'other-db'), otherProfile);
  await second.evaluate(async ({ profile, key, snapshot }) => {
    await FountainOffline.saveDatabase(key, { ...snapshot, database: { id: 'other-db' }, current_member_id: profile.memberId, session_binding: profile.cacheBinding });
    await FountainOffline.putMutation(profile, key, { id: 'fresh-unsent', kind: 'row.create', target_id: 'other-row', body: {} });
  }, { profile: otherProfile, key: otherMemberKey, snapshot });
  assert.equal((await second.evaluate(profile => FountainOffline.pendingMutations(profile), otherProfile)).length, 1);
  await second.evaluate(() => FountainOffline.clearActiveProfile());
  assert.equal(await rejected(page, profile => FountainOffline.saveProfile(profile), freshProfile), true);
  console.log('PASS offline storage v2: real v1 migration, typed snapshots, revision guards, two-tab immutable queues, durable conflicts, atomic local pages, typed purge and logout fences');
} catch (error) {
  console.error('Offline storage browser QA failed at: ' + stage); throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
