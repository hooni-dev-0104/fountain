// Contract-model vault + real isolated HTTP Auth fixture; no deployed provider/SQL claim.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import { createAuth as createWorkspaceAuth, parseSessionCookie as parseWorkspaceCookie, AuthError as WorkspaceAuthError } from '../functions/_shared/auth.ts';
import { createOrganizationAuth as createAuth, parseOrganizationSessionCookie as parseSessionCookie, AuthError } from '../functions/_shared/organization-auth.ts';
import { AuthError as EngineAuthError } from '../functions/_shared/session-auth.ts';
import { createOrganizationSessionVault, OrganizationVaultError } from '../functions/_shared/organization-vault.ts';

const clone = (value) => value == null ? value : structuredClone(value);
const users = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const password = 'fixture-password-never-log';
const oldKey = { id: 'old', secret: 'fixture-old-key-material-32-bytes-minimum' };
const nextKey = { id: 'next', secret: 'fixture-new-key-material-32-bytes-minimum' };
let now = Date.now(), server, origin;
const provider = { access: new Map(), refresh: new Map(), sessions: new Set(), requests: [], refreshCount: 0, logoutStatus: 204, tokenMode: null, gate: null };
function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
function issue(user, sid = crypto.randomUUID()) {
  const exp = Math.floor((now + 180_000) / 1000);
  const claims = Buffer.from(JSON.stringify({ sub: user, session_id: sid, exp, role: 'authenticated', user_metadata: { role: 'owner' } })).toString('base64url');
  const access = 'fixture.' + claims + '.' + crypto.randomUUID().replaceAll('-', '');
  const refresh = crypto.randomUUID().replaceAll('-', '').slice(0, 12); provider.access.set(access, { user, sid, exp }); provider.refresh.set(refresh, { user, sid }); provider.sessions.add(sid);
  return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 180, expires_at: exp, user: { id: user, user_metadata: { role: 'owner' } } };
}
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid');
      provider.requests.push({ method: request.method, path: url.pathname + url.search });
      assert.equal(request.headers.apikey, 'fixture-publishable-key');
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 100000) throw new Error('fixture body bound'); }
      const parsed = body ? JSON.parse(body) : {};
      if (url.pathname === '/auth/v1/token') {
        if (provider.tokenMode === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }); response.end(); return; }
        if (provider.tokenMode === 'huge') { json(response, 200, { text: 'x'.repeat(270000) }); return; }
        if (provider.tokenMode === 'invalid') { json(response, 200, { access_token: 'invalid', refresh_token: 'secret', token_type: 'bearer' }); return; }
        if (url.searchParams.get('grant_type') === 'password') {
          const index = ['a@example.invalid', 'b@example.invalid'].indexOf(parsed.email);
          if (index < 0 || parsed.password !== password) { json(response, 400, { message: password, access_token: 'not-public', refresh_token: 'not-public' }); return; }
          json(response, 200, issue(users[index])); return;
        }
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          provider.refreshCount++;
          if (provider.gate) await provider.gate;
          if (provider.tokenMode === 'refresh-fail') { json(response, 503, { message: 'private uncertain refresh response' }); return; }
          const prior = provider.refresh.get(parsed.refresh_token);
          if (!prior || !provider.sessions.has(prior.sid)) { json(response, 400, { message: 'invalid refresh secret' }); return; }
          provider.refresh.delete(parsed.refresh_token); json(response, 200, issue(prior.user, prior.sid)); return;
        }
      }
      const token = String(request.headers.authorization ?? '').replace(/^Bearer /, ''), identity = provider.access.get(token);
      if (url.pathname === '/auth/v1/user') {
        if (provider.tokenMode === 'mismatched-user') { json(response, 200, { id: users[1] }); return; }
        if (!identity || identity.exp * 1000 <= now) { json(response, 401, { message: 'expired token' }); return; }
        json(response, 200, { id: identity.user, user_metadata: { role: 'owner', workspace_id: 'forged-workspace' }, app_metadata: { role: 'owner' } }); return;
      }
      if (url.pathname === '/auth/v1/logout') {
        assert.equal(url.searchParams.get('scope'), 'local');
        if (provider.logoutStatus !== 204) { json(response, provider.logoutStatus, { secret: 'provider-private-error' }); return; }
        if (identity) provider.sessions.delete(identity.sid);
        response.writeHead(204); response.end(); return;
      }
      json(response, 404, {});
    } catch { if (!response.headersSent) json(response, 500, {}); else response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });

class MemoryVault {
  rows = new Map(); leases = new Map(); profiles = new Map(); refreshClaims = 0;
  failRead = false; failRevoke = false; failCreate = false; loseRefreshACK = false;
  beforeFinish = null; finishCalls = 0; releases = 0;
  constructor() { for (const [index, user] of users.entries()) this.profiles.set(user, { authSessionActive: true, user: { id: user, name: index ? '가족' : '주인', email: index ? 'b@example.invalid' : 'a@example.invalid' } }); }
  async create(row) { if (this.failCreate) throw new Error('private database credentials'); assert(!this.rows.has(row.hash)); this.rows.set(row.hash, clone(row)); }
  async read(hash) { if (this.failRead) throw new Error('private database credentials'); return clone(this.rows.get(hash) ?? null); }
  async resolveProfile(user, sid) { const value = clone(this.profiles.get(user)); if (value) value.authSessionActive &&= provider.sessions.has(sid); return value ?? null; }
  async claimRefresh(hash, version, id, until, time) {
    const row = this.rows.get(hash), lease = this.leases.get(hash);
    if (!row || row.revokedAt !== null || row.expiresAt <= time || row.version !== version) return false;
    if (lease) {
      if (lease.until <= time) { row.revokedAt = time; row.logoutPending = true; row.version++; this.leases.delete(hash); }
      return false;
    }
    this.refreshClaims++; this.leases.set(hash, { id, until }); return true;
  }
  async finishRefresh(hash, version, lease, tokens) {
    this.finishCalls++;
    if (this.beforeFinish) await this.beforeFinish;
    const row = this.rows.get(hash);
    if (!row || row.revokedAt !== null || row.version !== version || this.leases.get(hash)?.id !== lease || this.leases.get(hash).until <= now) return false;
    row.tokens = clone(tokens); row.version++; this.leases.delete(hash);
    if (this.loseRefreshACK) throw new Error('private uncertain database response');
    return true;
  }
  async releaseRefresh(hash, id) { this.releases++; if (this.leases.get(hash)?.id === id) this.leases.delete(hash); }
  async revoke(hash, time, expected) {
    if (this.failRevoke) throw new Error('private revocation failure');
    const row = this.rows.get(hash); if (!row) return null;
    if (expected && (row.revokedAt !== null || row.version !== expected.version || this.leases.get(hash)?.id !== expected.leaseId)) return null;
    if (row.revokedAt === null) { row.revokedAt = time; row.logoutPending = true; row.version++; this.leases.delete(hash); }
    return clone(row);
  }
  async sweep(limit) { return { pending: [...this.rows.values()].filter(row => row.revokedAt !== null && row.logoutPending && row.tokens).slice(0, limit).map(clone), pruned: 0 }; }
  async finishLogout(hash, version) {
    const row = this.rows.get(hash); if (!row || row.revokedAt === null || row.version !== version) return false;
    row.tokens = null; row.logoutPending = false; return true;
  }
}
function setup(keys = [oldKey]) {
  now = Date.now(); provider.logoutStatus = 204; provider.tokenMode = null; provider.gate = null;
  const vault = new MemoryVault(), config = { supabaseUrl: origin, publishableKey: 'fixture-publishable-key', cryptoKeys: keys, vault, clock: () => now };
  return { vault, auth: createAuth(config), config };
}
const cookie = (result) => result.setCookie.split(';')[0];
const login = (auth, email = 'a@example.invalid', prior) => auth.login({ email, password }, prior);
const deny = (promise, status, code) => assert.rejects(promise, (cause) => cause instanceof AuthError && cause.status === status && cause.code === code && !cause.message.includes(password) && !cause.message.includes('private'));
async function waitForFixture(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert(Date.now() < deadline, 'isolated Auth fixture did not reach expected phase'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}


test('refresh uses a distributed CAS lease once across independent Auth instances', async () => {
  const { auth, vault, config } = setup(), other = createAuth(config), first = await login(auth);
  now += 165000; const before = provider.refreshCount;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? auth : other).session(cookie(first))));
  assert(results.every((value) => value.body.authenticated));
  assert(results.every((value) => value.body.cache_binding === first.body.cache_binding && value.body.expires_at === first.body.expires_at));
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.refreshClaims, 1); assert.equal([...vault.rows.values()][0].version, 1);
});test('revocation commits before failed remote logout; ordinary access denied and retry-only retained', async () => {
  const { auth, vault } = setup(), first = await login(auth), row = [...vault.rows.values()][0]; provider.logoutStatus = 503;
  const result = await auth.logout(cookie(first), { expectedBinding: first.body.cache_binding });
  assert.equal(result.body.authenticated, false); assert.match(result.setCookie, /Max-Age=0/);
  assert(vault.rows.get(row.hash).tokens); assert.equal(vault.rows.get(row.hash).logoutPending, true);
  const requests = provider.requests.length; assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal(provider.requests.length, requests);
  provider.logoutStatus = 204; await auth.logout(cookie(first));
  assert.equal(vault.rows.get(row.hash).tokens, null); assert.equal(vault.rows.get(row.hash).logoutPending, false);
});test('remote logout 401 still retains cleanup ciphertext instead of claiming success', async () => {
  const { auth, vault } = setup(), first = await login(auth); provider.logoutStatus = 401;
  await auth.logout(cookie(first)); assert.equal([...vault.rows.values()][0].logoutPending, true); assert([...vault.rows.values()][0].tokens);
});test('captured binding rejects stale logout without deleting current cookie/session', async () => {
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth, 'b@example.invalid');
  await deny(auth.logout(cookie(b), { expectedBinding: a.body.cache_binding }), 409, 'SESSION_CHANGED');
  assert.equal((await auth.session(cookie(b))).body.identity.email, 'b@example.invalid'); assert([...vault.rows.values()].every((row) => row.revokedAt === null));
});test('logout during in-flight refresh wins CAS; no late authenticated result', async () => {
  const { auth, vault } = setup(), first = await login(auth); now += 165000;
  let release; provider.gate = new Promise((resolve) => { release = resolve; });
  const count = provider.refreshCount, checking = auth.session(cookie(first));
  await waitForFixture(() => provider.refreshCount !== count);
  await auth.logout(cookie(first)); release();
  assert.equal((await checking).body.authenticated, false); assert.notEqual([...vault.rows.values()][0].revokedAt, null);
});test('lost refresh CAS acknowledgement reuses a proven committed winner without revoking it', async () => {
  const { auth, vault } = setup(), first = await login(auth); now += 165000; vault.loseRefreshACK = true;
  const count = provider.refreshCount;
  assert.equal((await auth.session(cookie(first))).body.authenticated, true);
  assert.equal(provider.refreshCount - count, 1); assert.equal((await auth.session(cookie(first))).body.authenticated, true);
  assert.equal([...vault.rows.values()][0].revokedAt, null); assert.equal(vault.releases, 0);
});test('old decryption key works through rotation and refresh stores newest key', async () => {
  const { auth, vault, config } = setup(), first = await login(auth), rotated = createAuth({ ...config, cryptoKeys: [nextKey, oldKey] });
  assert.equal((await rotated.session(cookie(first))).body.authenticated, true); now += 165000;
  assert.equal((await rotated.session(cookie(first))).body.authenticated, true); assert.equal([...vault.rows.values()][0].tokens.keyId, 'next');
});test('missing key and ciphertext swapped across users or sessions fail closed', async () => {
  const firstFixture = setup(), first = await login(firstFixture.auth);
  assert.equal((await createAuth({ ...firstFixture.config, cryptoKeys: [nextKey] }).session(cookie(first))).body.authenticated, false);
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth, 'b@example.invalid');
  const rows = [...vault.rows.values()]; rows[0].tokens = clone(rows[1].tokens);
  assert.equal((await auth.session(cookie(a))).body.authenticated, false); assert.equal((await auth.session(cookie(b))).body.authenticated, true);
  const c = await login(auth), d = await login(auth); const sameUser = [...vault.rows.values()].slice(-2); sameUser[0].tokens = clone(sameUser[1].tokens);
  assert.equal((await auth.session(cookie(c))).body.authenticated, false); assert.equal((await auth.session(cookie(d))).body.authenticated, true);
});test('opaque expiry stays fixed at seven days and never reaches provider after expiry', async () => {
  const { auth, vault } = setup(), first = await login(auth), requests = provider.requests.length;
  now += 7 * 86400000 + 1;
  assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal(provider.requests.length, requests); assert.notEqual([...vault.rows.values()][0].revokedAt, null);
});test('provider redirect, malformed/oversized token and mismatched user fail closed', async () => {
  const { auth, vault } = setup();
  for (const mode of ['redirect', 'invalid', 'huge', 'mismatched-user']) {
    provider.tokenMode = mode;
    await assert.rejects(login(auth), (cause) => cause instanceof AuthError && [401, 502, 503].includes(cause.status));
    assert.equal(vault.rows.size, 0);
  }
  assert(!provider.requests.some((value) => value.path === '/must-not-follow'));
});test('vault failures are sanitized and cannot pretend revocation succeeded', async () => {
  const { auth, vault } = setup(), first = await login(auth); vault.failRead = true;
  await deny(auth.session(cookie(first)), 503, 'SESSION_STORAGE_UNAVAILABLE'); vault.failRead = false; vault.failRevoke = true;
  const requests = provider.requests.length; await deny(auth.logout(cookie(first)), 503, 'SESSION_STORAGE_UNAVAILABLE'); assert.equal(provider.requests.length, requests);
});test('failed vault create cleans up the new provider session without emitting a cookie', async () => {
  const { auth, vault } = setup(), before = new Set(provider.sessions); vault.failCreate = true;
  await deny(login(auth), 503, 'SESSION_STORAGE_UNAVAILABLE'); assert.equal(vault.rows.size, 0); assert.deepEqual(provider.sessions, before);
});test('new password login revokes previous opaque binding and makes a new one', async () => {
  const { auth } = setup(), first = await login(auth), next = await login(auth, 'a@example.invalid', cookie(first));
  assert.notEqual(first.body.cache_binding, next.body.cache_binding); assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal((await auth.session(cookie(next))).body.authenticated, true);
});test('provider-consumed refresh halted before persistence cannot be reclaimed after lease expiry', async () => {
  const { auth, vault, config } = setup(), other = createAuth(config), first = await login(auth);
  now += 165000;
  let release; vault.beforeFinish = new Promise((resolve) => { release = resolve; });
  const before = provider.refreshCount, original = auth.session(cookie(first));
  await waitForFixture(() => vault.finishCalls === 1);
  assert.equal(provider.refreshCount - before, 1); assert.equal([...vault.rows.values()][0].version, 0);
  now += 31000;
  assert.equal((await other.session(cookie(first))).body.authenticated, false);
  const old = [...vault.rows.values()][0]; assert.notEqual(old.revokedAt, null); assert.equal(old.logoutPending, true); assert(old.tokens);
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.refreshClaims, 1);
  const freshLogin = await login(other), unaffected = await login(other, 'b@example.invalid');
  vault.beforeFinish = null; release();
  assert.equal((await original).body.authenticated, false);
  assert.equal((await other.authorize(cookie(freshLogin))).profile.user.id, users[0]);
  assert.equal((await other.authorize(cookie(unaffected))).profile.user.id, users[1]);
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.releases, 0);
});test('failed uncertain-refresh revocation retains its lease until atomic expiry fencing', async () => {
  const { auth, vault, config } = setup(), other = createAuth(config), first = await login(auth);
  now += 165000; provider.tokenMode = 'refresh-fail'; vault.failRevoke = true;
  const before = provider.refreshCount;
  await deny(auth.session(cookie(first)), 503, 'SESSION_STORAGE_UNAVAILABLE');
  const row = [...vault.rows.values()][0]; assert.equal(row.revokedAt, null); assert(vault.leases.has(row.hash)); assert.equal(vault.releases, 0);
  now += 31000; vault.failRevoke = false; provider.tokenMode = null;
  assert.equal((await other.session(cookie(first))).body.authenticated, false);
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.rows.get(row.hash).logoutPending, true);
});

test('identity login succeeds with no workspace membership or owned organization, exposing no authority fields', async () => {
  const { auth, vault } = setup(), result = await login(auth), context = await auth.authorize(cookie(result));
  assert.equal(AuthError, WorkspaceAuthError); assert.equal(AuthError, EngineAuthError);
  assert.deepEqual(Object.keys(auth).sort(), ['login', 'session', 'authorize', 'logout', 'maintain'].sort());
  assert.deepEqual(Object.keys(createWorkspaceAuth({ supabaseUrl: origin, publishableKey: 'fixture-publishable-key', cryptoKeys: [oldKey], vault })).sort(), ['login', 'setup', 'confirmSetup', 'session', 'authorize', 'logout'].sort());
  assert.deepEqual(Object.keys(result.body).sort(), ['enabled', 'authenticated', 'mode', 'identity', 'cache_binding', 'expires_at'].sort());
  assert.deepEqual(result.body.identity, { name: '주인', email: 'a@example.invalid' }); assert.equal(result.body.mode, 'organization');
  assert.deepEqual(Object.keys(context).sort(), ['hash', 'userId', 'authSessionId', 'cacheBinding', 'profile', 'expiresAt'].sort());
  assert.deepEqual(context.profile, { authSessionActive: true, user: { id: users[0], name: '주인', email: 'a@example.invalid' } });
  assert.match(cookie(result), /^fountain_organization_session=[\w-]{43}$/); assert.match(result.setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(Date.parse(result.body.expires_at) - now, 604800000);
  const publicText = JSON.stringify(result.body);
  for (const key of ['workspace', 'member', 'role', 'userId', 'authSessionId']) assert(!publicText.includes(key));
  for (const value of [users[0], context.authSessionId, context.hash, password, ...provider.access.keys(), ...provider.refresh.keys()]) assert(!publicText.includes(value));
  assert([...provider.refresh.keys()].some(value => value.length === 12), 'short opaque refresh credentials are accepted without invented minimum');
});
function workspaceFixture() {
  const vault = new MemoryVault();
  for (const [index, user] of users.entries()) vault.profiles.set(user, { workspaceId: 'legacy-family', authSessionActive: true, member: { id: 'legacy-' + index, name: index ? '가족' : '주인', email: index ? 'b@example.invalid' : 'a@example.invalid', role: index ? 'guest' : 'member', active: true } });
  const config = { supabaseUrl: origin, publishableKey: 'fixture-publishable-key', cryptoKeys: [oldKey], vault, clock: () => now };
  return { vault, auth: createWorkspaceAuth(config), config };
}
test('two cookie names are parsed independently and malformed target cookies never reach provider', async () => {
  const { auth } = setup(), organization = await login(auth), workspace = workspaceFixture(), first = await login(workspace.auth);
  const both = cookie(first) + '; ' + cookie(organization), requests = provider.requests.length;
  assert.equal(parseSessionCookie(cookie(first)), null); assert.equal(parseWorkspaceCookie(cookie(organization)), null);
  assert.equal(parseSessionCookie(both), parseSessionCookie(cookie(organization))); assert.equal(parseWorkspaceCookie(both), parseWorkspaceCookie(cookie(first)));
  assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal((await workspace.auth.session(cookie(organization))).body.authenticated, false);
  for (const header of ['fountain_organization_session=x', cookie(organization) + '; ' + cookie(organization), 'fountain_organization_session =' + 'A'.repeat(43), 'fountain_organization_session=' + 'A'.repeat(42) + 'B', 'fountain_organization_session=%00']) await deny(auth.session(header), 400, 'INVALID_COOKIE');
  assert.equal(provider.requests.length, requests);
});
test('same Auth user uses two provider sessions and logout or failed login never mutates the other realm', async () => {
  const { auth, vault } = setup(), organization = await login(auth), workspace = workspaceFixture(), first = await login(workspace.auth);
  const orgRow = [...vault.rows.values()][0], workRow = [...workspace.vault.rows.values()][0];
  assert.equal(orgRow.userId, workRow.userId); assert.notEqual(orgRow.authSessionId, workRow.authSessionId);
  const workspaceBefore = clone([...workspace.vault.rows.values()]);
  await auth.logout(cookie(organization)); assert.deepEqual([...workspace.vault.rows.values()], workspaceBefore);
  assert.equal((await workspace.auth.session(cookie(first))).body.authenticated, true); assert(provider.sessions.has(workRow.authSessionId));
  const second = await login(auth), orgBefore = clone([...vault.rows.values()]);
  await workspace.auth.logout(cookie(first)); assert.deepEqual([...vault.rows.values()], orgBefore); assert.equal((await auth.session(cookie(second))).body.authenticated, true);
  await deny(auth.login({ email: 'a@example.invalid', password: 'wrong' }), 401, 'AUTH_REJECTED'); assert.equal((await auth.session(cookie(second))).body.authenticated, true);
});
test('ciphertext cannot cross realm even when hash/user/session/binding/key and timestamp are identical', async () => {
  const { auth, vault } = setup(), organization = await login(auth), workspace = workspaceFixture(), first = await login(workspace.auth);
  const orgRow = clone([...vault.rows.values()][0]), workRow = clone([...workspace.vault.rows.values()][0]);
  // Same complete AAD inputs and master key: only the independent realm purpose differs.
  vault.rows.set(workRow.hash, clone(workRow));
  const forgedOrgCookie = 'fountain_organization_session=' + parseWorkspaceCookie(cookie(first));
  assert.equal((await auth.session(forgedOrgCookie)).body.authenticated, false); assert(vault.rows.get(workRow.hash).tokens);
  workspace.vault.rows.set(orgRow.hash, clone(orgRow));
  const forgedWorkspaceCookie = 'fountain_session=' + parseSessionCookie(cookie(organization));
  assert.equal((await workspace.auth.session(forgedWorkspaceCookie)).body.authenticated, false); assert(workspace.vault.rows.get(orgRow.hash).tokens);
  assert.equal((await auth.session(cookie(organization))).body.authenticated, true); assert.equal((await workspace.auth.session(cookie(first))).body.authenticated, true);
});
test('workspace-shaped or mismatched identity profiles cannot fabricate organization identity', async () => {
  const { auth, vault } = setup();
  for (const profile of [workspaceFixture().vault.profiles.get(users[0]), { authSessionActive: true, user: { id: users[1], name: 'Wrong', email: 'a@example.invalid' } }, { authSessionActive: true, user: { id: users[0], name: 'User', email: 'a@example.invalid', role: 'owner' } }]) {
    vault.profiles.set(users[0], profile); await deny(login(auth), 503, 'SESSION_STORAGE_UNAVAILABLE'); assert.equal(vault.rows.size, 0);
  }
  vault.profiles.delete(users[0]); await deny(login(auth), 401, 'AUTH_REJECTED');
});
test('current identity and provider session are checked without consulting workspace permissions', async () => {
  const { auth, vault } = setup(), first = await login(auth), row = [...vault.rows.values()][0];
  vault.profiles.get(users[0]).user.name = 'Renamed'; assert.equal((await auth.session(cookie(first))).body.identity.name, 'Renamed');
  vault.profiles.get(users[0]).authSessionActive = false; assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.notEqual(vault.rows.get(row.hash).revokedAt, null);
  vault.profiles.get(users[0]).authSessionActive = true; const second = await login(auth), next = [...vault.rows.values()].at(-1); provider.sessions.delete(next.authSessionId);
  assert.equal((await auth.session(cookie(second))).body.authenticated, false);
});
test('bounded server maintenance retries only revoked organization rows and preserves live-session failures', async () => {
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth), c = await login(auth);
  provider.logoutStatus = 503; await auth.logout(cookie(a)); await auth.logout(cookie(b));
  const requests = provider.requests.length; assert.deepEqual(await auth.maintain(1), { pruned: 0, attempted: 1 }); assert.equal(provider.requests.length, requests + 1);
  assert.equal([...vault.rows.values()].filter(row => row.logoutPending).length, 2); assert.equal((await auth.session(cookie(c))).body.authenticated, true);
  provider.logoutStatus = 204; assert.deepEqual(await auth.maintain(), { pruned: 0, attempted: 2 }); assert.equal([...vault.rows.values()].filter(row => row.logoutPending).length, 0);
  for (const limit of [0, -1, 129, 1.5, '2']) await deny(auth.maintain(limit), 400, 'INVALID_LIMIT');
});

test('HKDF purpose and AES-GCM AAD purpose independently separate organization ciphertext', async () => {
  const { auth, vault } = setup(); await login(auth); const row = [...vault.rows.values()][0], enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(oldKey.secret), 'HKDF', false, ['deriveKey']);
  async function decrypt(keyPurpose, tokenPurpose) {
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(row.hash), info: enc.encode(JSON.stringify([keyPurpose, 1, oldKey.id, row.userId])) }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.tokens.iv, 'base64url'), additionalData: enc.encode(JSON.stringify([tokenPurpose, 1, row.hash, row.userId, row.authSessionId])) }, key, Buffer.from(row.tokens.data, 'base64url'));
  }
  const plain = await decrypt('fountain-organization-auth-token-vault', 'fountain-organization-auth-tokens'); assert(JSON.parse(new TextDecoder().decode(plain)).refreshToken.length === 12);
  await assert.rejects(decrypt('fountain-auth-token-vault', 'fountain-organization-auth-tokens'));
  await assert.rejects(decrypt('fountain-organization-auth-token-vault', 'fountain-auth-tokens'));
});
test('organization identity preserves SQL-bounded Unicode display metadata without granting authority', async () => {
  const {auth,vault}=setup();
  for(const name of ['😀'.repeat(1000),'이름\n표시']){
    vault.profiles.get(users[0]).user.name=name;
    const result=await login(auth);
    assert.equal(result.body.identity.name,name);
    assert.equal((await auth.session(cookie(result))).body.identity.name,name);
    await auth.logout(cookie(result));
  }
  vault.profiles.get(users[0]).user.name='😀'.repeat(1001);
  await deny(login(auth),503,'SESSION_STORAGE_UNAVAILABLE');
});
test('organization vault transports exact private RPC envelopes and rejects malformed or unbounded responses', async () => {
  const key = 'sb_secret_isolated_fixture_not_a_real_key', hash = 'a'.repeat(64), leaseId = 'lease_'.repeat(6), createdAt = Date.now();
  const tokens = { version: 1, keyId: 'fixture-key', iv: 'AAAAAAAAAAAAAAAA', data: 'AAAAAAAAAAAAAAAAAAAAAA' };
  const row = { hash, userId: users[0], authSessionId: users[1], cacheBinding: 'b'.repeat(32), createdAt, expiresAt: createdAt + 604800000, version: 0, tokens, revokedAt: null, logoutPending: false };
  const revoked = { ...row, version: 1, revokedAt: createdAt, logoutPending: true }, profile = { authSessionActive: true, user: { id: users[0], email: 'user@example.invalid', name: 'User' } };
  let answer = null, mode = null, calls = [];
  const transport = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, method: request.method, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (mode === 'redirect') { response.writeHead(302, { location: '/must-never-follow' }); response.end(); return; }
    if (mode === 'error') { response.writeHead(503); response.end('PRIVATE_DIAGNOSTIC'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(mode === 'huge' ? ' '.repeat(262145) : JSON.stringify(answer));
  });
  transport.listen(0, '127.0.0.1'); await once(transport, 'listening');
  const config = { supabaseUrl: 'http://127.0.0.1:' + transport.address().port, serviceKey: key }, vault = createOrganizationSessionVault(config);
  const last = () => calls.at(-1), denied = action => assert.rejects(action, cause => cause instanceof OrganizationVaultError && cause.status === 503 && !cause.message.includes(key) && !cause.message.includes('PRIVATE_DIAGNOSTIC'));
  const wire = (action, value) => { assert.equal(last().path, '/rest/v1/rpc/fountain_cloud_organization_session_vault'); assert.equal(last().method, 'POST'); assert.deepEqual(last().body, { p_action: action, p_value: value }); assert.equal(last().headers.apikey, key); assert.equal(last().headers.authorization, undefined); };
  try {
    await vault.create(row); wire('create', { row });
    answer = row; assert.deepEqual(await vault.read(hash), row); wire('read', { hash });
    answer = profile; assert.deepEqual(await vault.resolveProfile(users[0], users[1]), profile); wire('profile', { userId: users[0], authSessionId: users[1] });
    for(const name of ['😀'.repeat(1000),'이름\n표시']){answer={...profile,user:{...profile.user,name}};assert.equal((await vault.resolveProfile(users[0],users[1])).user.name,name);}
    answer={...profile,user:{...profile.user,name:'😀'.repeat(1001)}};await denied(vault.resolveProfile(users[0],users[1]));
    answer = true; assert.equal(await vault.claimRefresh(hash, 0, leaseId, createdAt + 30000, createdAt), true); wire('claim_refresh', { hash, expectedVersion: 0, leaseId, until: createdAt + 30000, now: createdAt });
    assert.equal(await vault.finishRefresh(hash, 0, leaseId, tokens), true); wire('finish_refresh', { hash, expectedVersion: 0, leaseId, tokens });
    answer = null; await vault.releaseRefresh(hash, leaseId); wire('release_refresh', { hash, leaseId });
    answer = revoked; assert.deepEqual(await vault.revoke(hash, createdAt), revoked); wire('revoke', { hash, now: createdAt, expectedVersion: null, leaseId: null });
    assert.deepEqual(await vault.revoke(hash, createdAt, { version: 0, leaseId }), revoked); wire('revoke', { hash, now: createdAt, expectedVersion: 0, leaseId });
    answer = false; assert.equal(await vault.finishLogout(hash, 1), false); wire('finish_logout', { hash, expectedVersion: 1 });
    answer = { pending: [revoked], pruned: 0 }; assert.deepEqual(await vault.sweep(2), answer); wire('sweep', { limit: 2 });
    for (const malformed of [{ ...row, extra: true }, { ...row, hash: 'c'.repeat(64) }, { ...row, tokens: null }, { ...row, logoutPending: true }, { ...row, expiresAt: row.expiresAt + 1 }]) { answer = malformed; await denied(vault.read(hash)); }
    for (const malformed of [{ ...profile, member: {} }, { ...profile, user: { ...profile.user, id: users[1] } }, { ...profile, user: { ...profile.user, role: 'owner' } }]) { answer = malformed; await denied(vault.resolveProfile(users[0], users[1])); }
    for (const malformed of [{ pending: [row], pruned: 0 }, { pending: [revoked, revoked], pruned: 0 }, { pending: [revoked], pruned: -1 }, { pending: [], pruned: 3 }, { pending: [revoked], pruned: 0, extra: true }]) { answer = malformed; await denied(vault.sweep(2)); }
    for (const value of [0, 129, 1.5, '2']) await denied(vault.sweep(value));
    const before = calls.length; await denied(vault.read('bad')); await denied(vault.claimRefresh(hash, 0, leaseId, createdAt + 60001, createdAt)); assert.equal(calls.length, before);
    for (const value of ['redirect', 'error', 'huge']) { mode = value; await denied(vault.read(hash)); } assert(!calls.some(call => call.path === '/must-never-follow'));
    for (const patch of [{ supabaseUrl: 'http://example.invalid' }, { supabaseUrl: config.supabaseUrl + '/path' }, { serviceKey: 'publishable-key' }, { timeoutMs: 15001 }]) assert.throws(() => createOrganizationSessionVault({ ...config, ...patch }), OrganizationVaultError);
    mode = null; answer = null;
    const claims = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), legacy = 'fixture.' + claims + '.signature';
    await createOrganizationSessionVault({ ...config, serviceKey: legacy }).read(hash); assert.equal(last().headers.authorization, 'Bearer ' + legacy); assert.equal(last().headers.apikey, legacy);
  } finally { transport.closeAllConnections(); transport.close(); await once(transport, 'close'); }
});

test('maintenance rejects malformed sweep results before any provider retry', async () => {
  const { auth, vault } = setup(), first = await login(auth); provider.logoutStatus = 503; await auth.logout(cookie(first));
  const row = clone([...vault.rows.values()][0]), requests = provider.requests.length;
  for (const answer of [{ pending: [row, row], pruned: 0 }, { pending: [], pruned: 3 }, { pending: [row], pruned: 0, extra: true }, { pending: [{ ...row, revokedAt: null }], pruned: 0 }]) {
    vault.sweep = async () => answer; await deny(auth.maintain(2), 503, 'SESSION_STORAGE_UNAVAILABLE');
  }
  assert.equal(provider.requests.length, requests);
});
