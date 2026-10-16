// Contract-model vault + real isolated HTTP Auth fixture; no deployed provider/SQL claim.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import { createAuth, parseSessionCookie, AuthError } from '../functions/_shared/auth.ts';

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
  const refresh = crypto.randomUUID(); provider.access.set(access, { user, sid, exp }); provider.refresh.set(refresh, { user, sid }); provider.sessions.add(sid);
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
  constructor() { for (const [index, user] of users.entries()) this.profiles.set(user, { workspaceId: 'legacy-family', authSessionActive: true, member: { id: 'legacy-' + index, name: index ? '가족' : '주인', email: index ? 'b@example.invalid' : 'a@example.invalid', role: index ? 'guest' : 'member', active: true } }); }
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

test('real HTTP password + GET user, two trusted legacy roles, opaque-only public envelope', async () => {
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth, 'b@example.invalid');
  assert.equal(a.body.member.id, 'legacy-0'); assert.equal(a.body.member.role, 'member'); assert.equal(b.body.member.role, 'guest');
  assert.equal(a.body.workspace_id, 'legacy-family'); assert.notEqual(a.body.cache_binding, b.body.cache_binding);
  assert.match(cookie(a), /^fountain_session=[\w-]{43}$/); assert.match(a.setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(Date.parse(a.body.expires_at) - now, 7 * 86400000);
  assert.equal((await auth.session(cookie(a))).body.member.id, 'legacy-0');
  assert.equal((await auth.session(cookie(b))).body.member.id, 'legacy-1');
  const stored = JSON.stringify([...vault.rows.values()]);
  for (const row of vault.rows.values()) { assert.match(row.hash, /^[a-f0-9]{64}$/); assert.equal(row.tokens.keyId, 'old'); }
  for (const secret of [password, parseSessionCookie(cookie(a)), ...provider.access.keys(), ...provider.refresh.keys()]) {
    assert(!stored.includes(secret)); assert(!JSON.stringify(a.body).includes(secret));
  }
});
test('missing, duplicate, malformed and noncanonical cookies never reach provider', async () => {
  const { auth } = setup(), requests = provider.requests.length;
  assert.equal((await auth.session()).body.authenticated, false);
  for (const header of ['fountain_session=x', 'fountain_session=' + 'A'.repeat(43) + '; fountain_session=' + 'A'.repeat(43), 'fountain_session =' + 'A'.repeat(43), 'fountain_session=' + 'A'.repeat(42) + 'B', 'fountain_session=%00', 'fountain_session=\r\nsecret']) await deny(auth.session(header), 400, 'INVALID_COOKIE');
  assert.equal(provider.requests.length, requests);
});
test('invalid password provider diagnostics never leave the boundary', async () => {
  const { auth } = setup(); await deny(auth.login({ email: 'a@example.invalid', password: 'wrong' }), 401, 'AUTH_REJECTED');
  await deny(auth.login({ email: 'a@example.invalid', password, role: 'owner' }), 400, 'INVALID_LOGIN');
});
test('unlinked users cannot self-assign owner through provider metadata', async () => {
  const { auth, vault } = setup(); vault.profiles.delete(users[0]);
  const before = new Set(provider.sessions);
  await deny(login(auth), 403, 'SETUP_REQUIRED'); assert.equal(vault.rows.size, 0); assert.deepEqual(provider.sessions, before);
});
test('current Auth session and active member are checked on every session', async () => {
  const { auth, vault } = setup(), first = await login(auth), row = [...vault.rows.values()][0];
  provider.sessions.delete(row.authSessionId);
  assert.equal((await auth.session(cookie(first))).body.authenticated, false);
  assert.notEqual(vault.rows.get(row.hash).revokedAt, null);
  const second = await login(auth); vault.profiles.get(users[0]).member.active = false;
  assert.equal((await auth.session(cookie(second))).body.authenticated, false);
});
test('refresh uses a distributed CAS lease once across independent Auth instances', async () => {
  const { auth, vault, config } = setup(), other = createAuth(config), first = await login(auth);
  now += 165000; const before = provider.refreshCount;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? auth : other).session(cookie(first))));
  assert(results.every((value) => value.body.authenticated));
  assert(results.every((value) => value.body.cache_binding === first.body.cache_binding && value.body.expires_at === first.body.expires_at));
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.refreshClaims, 1); assert.equal([...vault.rows.values()][0].version, 1);
});
test('revocation commits before failed remote logout; ordinary access denied and retry-only retained', async () => {
  const { auth, vault } = setup(), first = await login(auth), row = [...vault.rows.values()][0]; provider.logoutStatus = 503;
  const result = await auth.logout(cookie(first), { expectedBinding: first.body.cache_binding });
  assert.equal(result.body.authenticated, false); assert.match(result.setCookie, /Max-Age=0/);
  assert(vault.rows.get(row.hash).tokens); assert.equal(vault.rows.get(row.hash).logoutPending, true);
  const requests = provider.requests.length; assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal(provider.requests.length, requests);
  provider.logoutStatus = 204; await auth.logout(cookie(first));
  assert.equal(vault.rows.get(row.hash).tokens, null); assert.equal(vault.rows.get(row.hash).logoutPending, false);
});
test('remote logout 401 still retains cleanup ciphertext instead of claiming success', async () => {
  const { auth, vault } = setup(), first = await login(auth); provider.logoutStatus = 401;
  await auth.logout(cookie(first)); assert.equal([...vault.rows.values()][0].logoutPending, true); assert([...vault.rows.values()][0].tokens);
});
test('captured binding rejects stale logout without deleting current cookie/session', async () => {
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth, 'b@example.invalid');
  await deny(auth.logout(cookie(b), { expectedBinding: a.body.cache_binding }), 409, 'SESSION_CHANGED');
  assert.equal((await auth.session(cookie(b))).body.member.id, 'legacy-1'); assert([...vault.rows.values()].every((row) => row.revokedAt === null));
});
test('logout during in-flight refresh wins CAS; no late authenticated result', async () => {
  const { auth, vault } = setup(), first = await login(auth); now += 165000;
  let release; provider.gate = new Promise((resolve) => { release = resolve; });
  const count = provider.refreshCount, checking = auth.session(cookie(first));
  await waitForFixture(() => provider.refreshCount !== count);
  await auth.logout(cookie(first)); release();
  assert.equal((await checking).body.authenticated, false); assert.notEqual([...vault.rows.values()][0].revokedAt, null);
});
test('lost refresh CAS acknowledgement reuses a proven committed winner without revoking it', async () => {
  const { auth, vault } = setup(), first = await login(auth); now += 165000; vault.loseRefreshACK = true;
  const count = provider.refreshCount;
  assert.equal((await auth.session(cookie(first))).body.authenticated, true);
  assert.equal(provider.refreshCount - count, 1); assert.equal((await auth.session(cookie(first))).body.authenticated, true);
  assert.equal([...vault.rows.values()][0].revokedAt, null); assert.equal(vault.releases, 0);
});
test('old decryption key works through rotation and refresh stores newest key', async () => {
  const { auth, vault, config } = setup(), first = await login(auth), rotated = createAuth({ ...config, cryptoKeys: [nextKey, oldKey] });
  assert.equal((await rotated.session(cookie(first))).body.authenticated, true); now += 165000;
  assert.equal((await rotated.session(cookie(first))).body.authenticated, true); assert.equal([...vault.rows.values()][0].tokens.keyId, 'next');
});
test('missing key and ciphertext swapped across users or sessions fail closed', async () => {
  const firstFixture = setup(), first = await login(firstFixture.auth);
  assert.equal((await createAuth({ ...firstFixture.config, cryptoKeys: [nextKey] }).session(cookie(first))).body.authenticated, false);
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth, 'b@example.invalid');
  const rows = [...vault.rows.values()]; rows[0].tokens = clone(rows[1].tokens);
  assert.equal((await auth.session(cookie(a))).body.authenticated, false); assert.equal((await auth.session(cookie(b))).body.authenticated, true);
  const c = await login(auth), d = await login(auth); const sameUser = [...vault.rows.values()].slice(-2); sameUser[0].tokens = clone(sameUser[1].tokens);
  assert.equal((await auth.session(cookie(c))).body.authenticated, false); assert.equal((await auth.session(cookie(d))).body.authenticated, true);
});
test('opaque expiry stays fixed at seven days and never reaches provider after expiry', async () => {
  const { auth, vault } = setup(), first = await login(auth), requests = provider.requests.length;
  now += 7 * 86400000 + 1;
  assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal(provider.requests.length, requests); assert.notEqual([...vault.rows.values()][0].revokedAt, null);
});
test('provider redirect, malformed/oversized token and mismatched user fail closed', async () => {
  const { auth, vault } = setup();
  for (const mode of ['redirect', 'invalid', 'huge', 'mismatched-user']) {
    provider.tokenMode = mode;
    await assert.rejects(login(auth), (cause) => cause instanceof AuthError && [401, 502, 503].includes(cause.status));
    assert.equal(vault.rows.size, 0);
  }
  assert(!provider.requests.some((value) => value.path === '/must-not-follow'));
});
test('vault failures are sanitized and cannot pretend revocation succeeded', async () => {
  const { auth, vault } = setup(), first = await login(auth); vault.failRead = true;
  await deny(auth.session(cookie(first)), 503, 'SESSION_STORAGE_UNAVAILABLE'); vault.failRead = false; vault.failRevoke = true;
  const requests = provider.requests.length; await deny(auth.logout(cookie(first)), 503, 'SESSION_STORAGE_UNAVAILABLE'); assert.equal(provider.requests.length, requests);
});
test('failed vault create cleans up the new provider session without emitting a cookie', async () => {
  const { auth, vault } = setup(), before = new Set(provider.sessions); vault.failCreate = true;
  await deny(login(auth), 503, 'SESSION_STORAGE_UNAVAILABLE'); assert.equal(vault.rows.size, 0); assert.deepEqual(provider.sessions, before);
});
test('new password login revokes previous opaque binding and makes a new one', async () => {
  const { auth } = setup(), first = await login(auth), next = await login(auth, 'a@example.invalid', cookie(first));
  assert.notEqual(first.body.cache_binding, next.body.cache_binding); assert.equal((await auth.session(cookie(first))).body.authenticated, false); assert.equal((await auth.session(cookie(next))).body.authenticated, true);
});
test('server-only authorize returns per-call trusted context without credentials', async () => {
  const { auth, vault } = setup(), a = await login(auth), b = await login(auth, 'b@example.invalid');
  const [first, second] = await Promise.all([auth.authorize(cookie(a)), auth.authorize(cookie(b))]);
  assert.deepEqual(Object.keys(first).sort(), ['hash', 'userId', 'authSessionId', 'cacheBinding', 'profile', 'expiresAt'].sort());
  assert.equal(first.userId, users[0]); assert.equal(second.userId, users[1]);
  assert.equal(first.profile.member.id, 'legacy-0'); assert.equal(second.profile.member.id, 'legacy-1');
  assert.equal(first.cacheBinding, a.body.cache_binding); assert.equal(first.expiresAt, Date.parse(a.body.expires_at));
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  for (const secret of [parseSessionCookie(cookie(a)), ...provider.access.keys(), ...provider.refresh.keys(), oldKey.secret]) assert(!JSON.stringify(first).includes(secret));
  vault.profiles.get(users[0]).member.role = 'guest';
  assert.equal((await auth.authorize(cookie(a))).profile.member.role, 'guest');
  assert.equal(first.profile.member.role, 'member');
});
test('authorize rejects missing/revoked/current inactive identities without public session drift', async () => {
  const { auth, vault } = setup(); await deny(auth.authorize(), 401, 'AUTH_REQUIRED');
  const first = await login(auth); await auth.logout(cookie(first));
  const requests = provider.requests.length; await deny(auth.authorize(cookie(first)), 401, 'AUTH_REQUIRED'); assert.equal(provider.requests.length, requests);
  const second = await login(auth); vault.profiles.get(users[0]).member.active = false;
  await deny(auth.authorize(cookie(second)), 401, 'AUTH_REQUIRED'); assert.equal((await auth.session(cookie(second))).body.authenticated, false);
});
test('provider-consumed refresh halted before persistence cannot be reclaimed after lease expiry', async () => {
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
  assert.equal((await other.authorize(cookie(freshLogin))).profile.member.id, 'legacy-0');
  assert.equal((await other.authorize(cookie(unaffected))).profile.member.id, 'legacy-1');
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.releases, 0);
});
test('failed uncertain-refresh revocation retains its lease until atomic expiry fencing', async () => {
  const { auth, vault, config } = setup(), other = createAuth(config), first = await login(auth);
  now += 165000; provider.tokenMode = 'refresh-fail'; vault.failRevoke = true;
  const before = provider.refreshCount;
  await deny(auth.session(cookie(first)), 503, 'SESSION_STORAGE_UNAVAILABLE');
  const row = [...vault.rows.values()][0]; assert.equal(row.revokedAt, null); assert(vault.leases.has(row.hash)); assert.equal(vault.releases, 0);
  now += 31000; vault.failRevoke = false; provider.tokenMode = null;
  assert.equal((await other.session(cookie(first))).body.authenticated, false);
  assert.equal(provider.refreshCount - before, 1); assert.equal(vault.rows.get(row.hash).logoutPending, true);
});
