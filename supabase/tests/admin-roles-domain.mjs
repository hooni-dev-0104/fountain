/** Real HTTP/domain/CloudStore/transaction code with an atomic in-memory RPC
 * provider model. This suite does not execute PostgreSQL or contact Supabase. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createBackend} from '../functions/_shared/backend.ts';
import {createDomain} from '../functions/_shared/domain.ts';
import {createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {generationKey, GENERATION_PREFIX} from '../functions/_shared/admin-roles.ts';
import {StoreError,canonicalJSON} from '../functions/_shared/store.ts';

const stamp = '2026-10-17T08:00:00.000000+00:00';
const origin = 'https://fountain.example';
const virtualGenerations = 'admin_member_generations_v1';
const generation = '1'.repeat(32);
const copy = structuredClone;
const key = (kind, id) => JSON.stringify([kind, id]);
const hash = value => createHash('sha256').update(value).digest('hex');
const legacyActions = ['audit.read', 'analytics.read', 'members.read', 'members.manage', 'groups.read', 'groups.membership.manage'];
const contentActions = ['content.search.read', 'content.search.export', 'content.permissions.manage', 'content.publish.manage', 'content.restore.manage'];
const actions = [...legacyActions, ...contentActions];

class MemoryProviderRPC {
  records = new Map();
  meta = new Map([['access_revision', 0]]);
  receipts = new Map();
  activityViews = new Map();
  revision = 0;
  beforeCommit = null;
  stats = {snapshots: [], commits: [], conflicts: 0, successfulCommits: 0};

  put(kind, value) {
    const data = {created_at: stamp, updated_at: stamp, ...copy(value)};
    this.records.set(key(kind, data.id), {kind, id: data.id, data, createdAt: data.created_at, updatedAt: data.updated_at});
  }
  get(kind, id) { return copy(this.records.get(key(kind, id))?.data ?? null); }
  state() { return copy({records: [...this.records], meta: [...this.meta], activityViews: [...this.activityViews], revision: this.revision}); }
  resetStats() { this.stats = {snapshots: [], commits: [], conflicts: 0, successfulCommits: 0}; }
  concurrent(change) {
    change(this);
    this.meta.set('access_revision', this.meta.get('access_revision') + 1);
    this.revision++;
  }
  async snapshot(request) {
    this.stats.snapshots.push(copy(request));
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.revision) throw new StoreError(409, 'REVISION_CONFLICT', 'RPC model changed');
    const selection = request.selection;
    const all = [...this.records.values()].filter(record => selection.kinds.includes(record.kind) || selection.ids[record.kind]?.includes(record.id));
    const offset = request.cursor?.offset ?? 0;
    const metadata = selection.metaKeys.map(name => name === virtualGenerations
      ? {key: name, present: true, value: Object.fromEntries([...this.meta].filter(([metaKey]) => metaKey.startsWith(GENERATION_PREFIX)))}
      : {key: name, present: this.meta.has(name), value: copy(this.meta.get(name) ?? null)});
    return {workspaceId: request.context.workspaceId, memberId: request.context.memberId, revision: this.revision,
      accessRevision: this.meta.get('access_revision'), principal: this.get('member', request.context.memberId),
      entities: copy(all.slice(offset, offset + selection.pageSize)), meta: metadata,
      nextCursor: offset + selection.pageSize < all.length ? {offset: offset + selection.pageSize} : null};
  }
  async commit(request) {
    this.stats.commits.push(copy(request));
    const receipt = this.receipts.get(request.transactionId);
    if (receipt) { assert.equal(receipt.digest, request.digest); return {revision: receipt.revision}; }
    if (this.beforeCommit) { const hook = this.beforeCommit; this.beforeCommit = null; await hook(request, this); }
    if (request.expectedRevision !== this.revision) {
      this.stats.conflicts++;
      throw new StoreError(409, 'REVISION_CONFLICT', 'RPC model changed before commit');
    }
    // Validate before applying anything, so a rejected model commit is atomic.
    const records = copy(this.records), metadata = copy(this.meta), activityViews=copy(this.activityViews);
    for (const change of request.changes) {
      if (change.op === 'put') {
        const previous = records.get(key(change.kind, change.id));
        assert.equal(previous?.createdAt ?? null, change.previousCreatedAt);
        records.set(key(change.kind, change.id), {kind: change.kind, id: change.id, data: copy(change.data), createdAt: change.data.created_at, updatedAt: change.data.updated_at});
      } else if (change.op === 'delete') records.delete(key(change.kind, change.id));
      else if(change.op==='activity_view'){
        assert.deepEqual(Object.keys(change).sort(),['commandId','id','kind','op']);
        assert.equal(change.kind,'page');assert.match(change.commandId,/^[a-f0-9]{32}$/);
        const source=records.get(key(change.kind,change.id));assert(source);
        const fact={memberId:request.context.memberId,kind:change.kind,id:change.id,source:canonicalJSON(source.data)};
        if(activityViews.has(change.commandId))assert.deepEqual(activityViews.get(change.commandId),fact);
        else activityViews.set(change.commandId,fact);
      }else{assert.equal(change.op,'meta');metadata.set(change.key,copy(change.value));}
    }
    this.records = records; this.meta = metadata; this.activityViews=activityViews; this.revision += request.changes.length;
    this.stats.successfulCommits++;
    this.receipts.set(request.transactionId, {digest: request.digest, revision: this.revision});
    return {revision: this.revision};
  }
}

function fixture({bulk = false} = {}) {
  const provider = new MemoryProviderRPC();
  const member = (id, role = 'member') => provider.put('member', {id, name: id, email: id + '@example.invalid', role, active: true,
    arbitrary_private: 'PRIVATE-MEMBER-FIELD', password_hash: 'PRIVATE-PASSWORD-FIELD', capabilities: {'audit.read': true}});
  member('local', 'owner'); member('alice'); member('bob'); member('guest', 'guest');
  if (bulk) for (let index = 0; index < 999; index++) member('bulk-' + index.toString().padStart(4, '0'));
  else member('admin', 'admin');
  provider.put('teamspace', {id: 'general', visibility: 'open'});
  provider.put('settings', {id: 'workspace', name: 'Family', disable_guests: false});
  provider.put('group', {id: 'family', name: 'Family', members: ['local', 'alice', 'admin'], arbitrary_private: 'PRIVATE-GROUP-FIELD'});
  provider.put('page', {id: 'private', title: 'PRIVATE-CONTENT-MARKER', owner_id: 'bob', teamspace_id: 'general', revision: 0, archived: false, blocks: [], permissions: {default: 'private', inherit: false, members: {}, groups: {}}});
  provider.put('audit', {id: 'private-event', action: 'fixture.private', details: {marker: 'PRIVATE-AUDIT-MARKER'}, user: 'local'});
  for (const [id, permission] of [['audit', ['audit.read']], ['analytics', ['analytics.read']], ['people', ['members.read', 'members.manage', 'groups.read', 'groups.membership.manage']]]) {
    provider.put('admin_role', {id, name: id, description: '', version: 1, nonce: '2'.repeat(32), actions: permission});
  }
  const assign = (id, roleIds) => {
    provider.meta.set(generationKey(id), generation);
    provider.put('admin_assignment', {id, member_id: id, role_ids: roleIds, generation,
      role_nonces: Object.fromEntries(roleIds.map(roleId => [roleId, provider.get('admin_role', roleId).nonce]))});
  };
  if (bulk) for (const record of provider.records.values()) {
    if (record.kind === 'member' && record.data.role === 'member') assign(record.id, ['audit']);
  } else assign('alice', ['audit', 'analytics']);

  const authorize = id => async () => ({hash: hash(id), userId: '11111111-1111-4111-8111-111111111111',
    authSessionId: '22222222-2222-4222-8222-222222222222', cacheBinding: hash('binding:' + id).slice(0, 32),
    expiresAt: Date.now() + 60000, profile: {workspaceId: 'qa', authSessionActive: true, member: provider.get('member', id)}});
  const call = async (actor, method, path, body) => {
    const auth = authorize(actor);
    const domain = createDomain({provider, authorize: auth, clock: () => Date.parse(stamp), extensions: [createAdvancedExtension({clock: () => Date.parse(stamp), env: {}})]});
    let domainError;
    const backend = createBackend({origins: [origin], auth: async () => ({authorize: auth}),
      domain: async (...args) => { try { return await domain(...args); } catch (error) { domainError = error; throw error; } }});
    const response = await backend(new Request(origin + path, {method, headers: {Origin: origin, 'X-Fountain-Request': '1'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
    const raw = await response.text();
    if (response.status >= 500 && domainError) throw domainError;
    return {status: response.status, body: raw ? JSON.parse(raw) : null};
  };
  const overview = async () => {
    const result = await call('local', 'GET', '/api/admin/roles');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const mutate = async (method, path, body = {}) => call('local', method, path, {revision: (await overview()).revision, ...body});
  const deny = async (status, actor, method, path, body) => {
    const before = provider.state();
    const result = await call(actor, method, path, body);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(provider.state(), before, 'Denied request changed RPC model state');
    return result;
  };
  return {provider, call, overview, mutate, deny, assign};
}

test('exact admin HTTP routes, owner CAS role CRUD, assignment CAS and access revisions use real CloudStore', async () => {
  const f = fixture();
  assert.deepEqual((await f.call('alice', 'GET', '/api/admin/self')).body, {actions: ['audit.read', 'analytics.read'], can_manage_roles: false});
  assert.deepEqual((await f.call('local', 'GET', '/api/admin/self')).body, {actions, can_manage_roles: true});
  assert.deepEqual((await f.call('guest', 'GET', '/api/admin/self')).body, {actions: [], can_manage_roles: false});
  assert.equal((await f.call('alice', 'HEAD', '/api/admin/self')).status, 200);
  const initial = await f.overview();
  for (const field of ['generation', 'nonce', 'PRIVATE-MEMBER-FIELD', 'PRIVATE-PASSWORD-FIELD', 'capabilities']) assert(!JSON.stringify(initial).includes(field));
  for (const [method, path, status] of [['GET', '/api/admin/self/', 404], ['GET', '/api/admin/roles/', 404], ['GET', '/api/admin/roles/audit/extra', 404],
    ['GET', '/api/admin/roles/audit', 405], ['POST', '/api/admin/self', 405], ['GET', '/api/admin/assignments/alice', 405],
    ['POST', '/api/admin/assignments/alice', 405], ['GET', '/api/admin/roles?unexpected=1', 400], ['GET', '/api/admin/self?x=1', 400]]) {
    await f.deny(status, 'local', method, path, method === 'GET' ? undefined : {});
  }
  for (const actor of ['alice', 'bob', 'guest', 'admin']) {
    await f.deny(403, actor, 'GET', '/api/admin/roles');
    await f.deny(403, actor, 'POST', '/api/admin/roles', {revision: initial.revision, name: 'forged', actions: ['audit.read']});
    await f.deny(403, actor, 'PUT', '/api/admin/assignments/bob', {revision: initial.revision, role_ids: ['audit']});
  }
  const created = await f.mutate('POST', '/api/admin/roles', {name: 'Scoped audit', actions: ['audit.read']});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.created_role_id;
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(f.provider.meta.get('access_revision'), 1);
  await f.deny(409, 'local', 'PATCH', '/api/admin/roles/' + id, {revision: initial.revision, name: 'stale'});
  await f.deny(409, 'local', 'PUT', '/api/admin/assignments/bob', {revision: initial.revision, role_ids: [id]});
  assert.equal((await f.mutate('PATCH', '/api/admin/roles/' + id, {description: 'current CAS', actions: ['analytics.read']})).status, 200);
  assert.equal(f.provider.meta.get('access_revision'), 2);
  assert.equal((await f.mutate('PUT', '/api/admin/assignments/bob', {role_ids: [id]})).status, 200);
  assert.equal(f.provider.meta.get('access_revision'), 3);
  assert.deepEqual((await f.call('bob', 'GET', '/api/admin/self')).body.actions, ['analytics.read']);
  const assignedRevision = (await f.overview()).revision;
  assert.equal((await f.mutate('PUT', '/api/admin/assignments/bob', {role_ids: []})).status, 200);
  assert.equal(f.provider.meta.get('access_revision'), 4);
  await f.deny(409, 'local', 'PUT', '/api/admin/assignments/bob', {revision: assignedRevision, role_ids: [id]});
  assert.deepEqual((await f.call('bob', 'GET', '/api/admin/self')).body.actions, []);
  assert.equal((await f.mutate('PUT', '/api/admin/assignments/bob', {role_ids: [id]})).status, 200);
  assert.equal((await f.mutate('DELETE', '/api/admin/roles/' + id)).status, 200);
  assert.equal(f.provider.meta.get('access_revision'), 6);
  assert.deepEqual((await f.call('bob', 'GET', '/api/admin/self')).body.actions, []);
  assert.equal(f.provider.get('admin_role', id), null);
});

test('existing six-action role does not inherit newly introduced content capabilities', async () => {
  const f = fixture();
  f.provider.put('admin_role', {id: 'legacy', name: 'Legacy six actions', description: '', version: 1, nonce: '2'.repeat(32), actions: legacyActions});
  f.assign('bob', ['legacy']);
  const before = f.provider.get('admin_role', 'legacy');
  const delegated = await f.call('bob', 'GET', '/api/admin/self');
  assert.equal(delegated.status, 200);
  assert.deepEqual(delegated.body, {actions: legacyActions, can_manage_roles: false});
  for (const action of contentActions) assert(!delegated.body.actions.includes(action));
  assert.deepEqual(f.provider.get('admin_role', 'legacy'), before);
});

test('delegated actions authorize only exact audit/analytics/membership routes and preserve ordinary private ACLs', async () => {
  const f = fixture();
  assert.equal((await f.call('alice', 'GET', '/api/audit')).status, 200);
  assert.equal((await f.call('alice', 'GET', '/api/pages/private')).status, 404);
  assert.equal((await f.call('bob', 'GET', '/api/pages/private')).status, 200);
  for (const path of ['/api/audit', '/api/analytics', '/api/members', '/api/groups']) await f.deny(403, 'guest', 'GET', path);
  for (const path of ['/api/members', '/api/groups']) await f.deny(403, 'alice', 'GET', path);
  for (const path of ['/api/audit', '/api/analytics']) await f.deny(403, 'bob', 'GET', path);
  await f.deny(403, 'alice', 'POST', '/api/audit', {});
  await f.deny(403, 'alice', 'GET', '/api/accounts');
  assert.equal((await f.mutate('PUT', '/api/admin/assignments/alice', {role_ids: ['people']})).status, 200);
  for (const collection of ['members', 'groups']) {
    const id = collection === 'members' ? 'bob' : 'family';
    for (const [method, path, status] of [['GET', `/api/${collection}/${id}/extra`, 404], ['PATCH', `/api/${collection}/${id}/extra`, 404],
      ['POST', `/api/${collection}/${id}`, 405], ['PUT', `/api/${collection}/${id}`, 405], ['DELETE', `/api/${collection}`, 405]]) {
      await f.deny(status, 'alice', method, path, method === 'GET' ? undefined : {});
    }
  }
  for (const path of ['/api/audit', '/api/analytics']) await f.deny(403, 'alice', 'GET', path);
  assert.equal((await f.call('alice', 'GET', '/api/pages/private')).status, 404);
  for (const [path, collection, fields] of [['/api/members', 'members', ['id', 'name', 'email', 'role', 'active', 'created_at', 'updated_at']],
    ['/api/groups', 'groups', ['id', 'name', 'members', 'created_at', 'updated_at']]]) {
    const result = await f.call('alice', 'GET', path);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert(result.body[collection].length);
    for (const item of result.body[collection]) assert(Object.keys(item).every(field => fields.includes(field)));
    assert(!JSON.stringify(result.body).includes('PRIVATE-'));
  }
  for (const path of ['/api/members/bob', '/api/groups/family']) {
    const result = await f.call('alice', 'GET', path);
    assert.equal(result.status, 200);
    assert(!JSON.stringify(result.body).includes('PRIVATE-'));
    assert(!Object.hasOwn(result.body, 'capabilities'));
  }
  const edited = await f.call('alice', 'PATCH', '/api/members/bob', {name: 'delegated update'});
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.name, 'delegated update');
  assert(!JSON.stringify(edited.body).includes('PRIVATE-'));
  for (const [method, path, body] of [['POST', '/api/members', {name: 'forged', email: 'forged@example.invalid', role: 'admin'}],
    ['PATCH', '/api/members/bob', {role: 'owner'}], ['PATCH', '/api/members/admin', {name: 'forged'}], ['DELETE', '/api/members/admin', {}]]) {
    await f.deny(403, 'alice', method, path, body);
  }
  const members = ['local', 'admin', 'alice', 'guest'];
  const group = await f.call('alice', 'PATCH', '/api/groups/family', {members});
  assert.equal(group.status, 200, JSON.stringify(group.body));
  assert.deepEqual(group.body.members, members);
  assert(!JSON.stringify(group.body).includes('PRIVATE-'));
  for (const [method, path, body, status] of [['POST', '/api/groups', {name: 'forged', members}, 403], ['DELETE', '/api/groups/family', {}, 403],
    ['PATCH', '/api/groups/family', {name: 'forged'}, 400], ['PATCH', '/api/groups/family', {members, name: 'forged'}, 400],
    ['PATCH', '/api/groups/absent', {members}, 404], ['PATCH', '/api/groups/family', {members: ['missing']}, 400]]) {
    await f.deny(status, 'alice', method, path, body);
  }
});

test('a delegated analytics HTTP read projects count maps without treating them as resource lists', async () => {
  const f = fixture();
  const delegated = await f.call('alice', 'GET', '/api/analytics');
  assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
  assert.equal(delegated.body.members, 5);
  assert.equal(delegated.body.rows, 0);
  assert.equal(delegated.body.page_count, 1);
  assert.equal(typeof delegated.body.pages, 'object');
  const owner = await f.call('local', 'GET', '/api/analytics');
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body, delegated.body);
});

test('member/group DTO whitelists also reject arbitrary private objects hidden inside known fields', async () => {
  const f = fixture();
  f.assign('alice', ['people']);
  f.provider.put('member', {...f.provider.get('member', 'bob'), name: {private: 'PRIVATE-NESTED-MEMBER'}, email: ['PRIVATE-NESTED-EMAIL'], active: {private: 'PRIVATE-NESTED-ACTIVE'}});
  f.provider.put('group', {...f.provider.get('group', 'family'), name: {private: 'PRIVATE-NESTED-GROUP'}, members: ['local', {private: 'PRIVATE-NESTED-MEMBERSHIP'}]});
  const before = f.provider.state();
  for (const path of ['/api/members', '/api/members/bob', '/api/groups', '/api/groups/family']) {
    const result = await f.call('alice', 'GET', path);
    assert.equal(result.status, 200);
    assert(!JSON.stringify(result.body).includes('PRIVATE-'), path + ': nested private values leaked');
    const collection = path.startsWith('/api/members') ? 'members' : 'groups';
    for (const item of result.body[collection] ?? [result.body]) {
      for (const name of ['id', 'name', 'email', 'role', 'created_at', 'updated_at']) if (Object.hasOwn(item, name)) assert.equal(typeof item[name], 'string');
      if (Object.hasOwn(item, 'active')) assert.equal(typeof item.active, 'boolean');
      if (Object.hasOwn(item, 'members')) assert(Array.isArray(item.members) && item.members.every(id => typeof id === 'string'));
    }
  }
  assert.deepEqual(f.provider.state(), before);
});

for (const mutation of ['role-delete', 'role-replace', 'assignment-revoke']) {
  test('a concurrent ' + mutation + ' rejects a private audit read on a fresh provider replay', async () => {
    const f = fixture();
    let afterConcurrent;
    f.provider.beforeCommit = (request, provider) => {
      assert.equal(request.changes.length, 0, 'Audit retrieval must reach a read-only provider commit');
      provider.concurrent(state => {
        if (mutation === 'role-replace') state.put('admin_role', {...state.get('admin_role', 'audit'), nonce: '3'.repeat(32)});
        else state.records.delete(key(mutation === 'role-delete' ? 'admin_role' : 'admin_assignment', mutation === 'role-delete' ? 'audit' : 'alice'));
      });
      afterConcurrent = provider.state();
    };
    const result = await f.call('alice', 'GET', '/api/audit');
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert(!JSON.stringify(result.body).includes('PRIVATE-AUDIT-MARKER'));
    assert.equal(f.provider.stats.conflicts, 1);
    assert.equal(f.provider.stats.successfulCommits, 0);
    assert.deepEqual(f.provider.state(), afterConcurrent);
    assert(f.provider.stats.snapshots.some(request => request.expectedRevision === undefined && request.selection.kinds.includes('admin_role')));
  });
}

test('concurrent assignment revocation discards a staged delegated member edit and its audit', async () => {
  const f = fixture();
  f.assign('alice', ['people']);
  const originalMember = f.provider.get('member', 'bob');
  let afterConcurrent;
  f.provider.beforeCommit = (request, provider) => {
    assert(request.changes.some(change => change.op === 'put' && change.kind === 'member' && change.id === 'bob'));
    assert(request.changes.some(change => change.op === 'put' && change.kind === 'audit'));
    provider.concurrent(state => state.records.delete(key('admin_assignment', 'alice')));
    afterConcurrent = provider.state();
  };
  const result = await f.call('alice', 'PATCH', '/api/members/bob', {name: 'MUST-NOT-COMMIT'});
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert(!JSON.stringify(result.body).includes('PRIVATE-MEMBER-FIELD'));
  assert.equal(f.provider.stats.conflicts, 1);
  assert.equal(f.provider.stats.successfulCommits, 0);
  assert.deepEqual(f.provider.get('member', 'bob'), originalMember);
  assert.deepEqual(f.provider.state(), afterConcurrent);
});

test('1,001 assignments use one virtual generation selector in owner HTTP overview and effective actions still work', async () => {
  const f = fixture({bulk: true});
  assert.equal([...f.provider.meta.keys()].filter(name => name.startsWith(GENERATION_PREFIX)).length, 1001);
  f.provider.resetStats();
  const result = await f.overview();
  assert.equal(result.assignments.length, 1001);
  assert.equal(result.eligible_members.length, 1001);
  const overviewReads = copy(f.provider.stats.snapshots);
  const replayStarts = overviewReads.filter(request => request.cursor === undefined).length;
  assert(replayStarts < 64, `Overview needed ${replayStarts} replays`);
  assert(overviewReads.some(request => request.selection.metaKeys.includes(virtualGenerations)));
  for (const request of overviewReads) {
    const selection = request.selection;
    assert(selection.kinds.length + selection.metaKeys.length + Object.values(selection.ids).reduce((count, ids) => count + ids.length, 0) <= 1000);
    assert.equal(selection.metaKeys.filter(name => name.startsWith(GENERATION_PREFIX)).length, 0, 'Owner overview must not expand one selector per generation');
    assert(selection.metaKeys.filter(name => name === virtualGenerations).length <= 1);
  }
  f.provider.resetStats();
  assert.deepEqual((await f.call('alice', 'GET', '/api/admin/self')).body, {actions: ['audit.read'], can_manage_roles: false});
  assert.equal((await f.call('alice', 'GET', '/api/audit')).status, 200);
  assert.equal((await f.call('alice', 'GET', '/api/pages/private')).status, 404);
  assert(f.provider.stats.snapshots.filter(request => request.cursor === undefined).length < 64);
  console.log(JSON.stringify({provider: 'in-memory atomic RPC model', actualSQL: false, assignments: result.assignments.length, generationMetaEntries: 1001,
    ownerOverviewReplays: replayStarts, ownerOverviewSnapshotPages: overviewReads.length, virtualGenerationSelectors: 1, individualGenerationSelectorsInOverview: 0}));
});
