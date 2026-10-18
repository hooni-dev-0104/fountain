/** Organization UI primitives: account fencing, immutable retry commands, bounded untrusted codes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../static/organization.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../static/organization.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../static/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ crypto: webcrypto, atob, btoa, Uint8Array, Date, Object, Error, Number, Array, JSON, String });
vm.runInContext(source, context);
const model = context.FountainOrganizationModel;
let checks = 0;
function check(description, callback) { callback(); checks++; }
const organizationId = '380bc476-026b-43b7-ac51-f302cbefef15';
const requestId = '19e999a3-99fe-4da6-8526-2285483884c0';
const envelope = { v: 1, organizationId, requestId, revision: 7, nonce: 'a'.repeat(64), expiresAt: Date.now() + 60000, workspaceId: 'family_workspace' };
const encode = value => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
check('same-account late reads become stale after logout and login', () => {
  const fence = model.createSessionFence();
  fence.reset('account-a'); const old = fence.capture();
  assert.equal(fence.current(old), true);
  fence.reset(null); assert.equal(fence.current(old), false);
  fence.reset('account-a'); assert.equal(fence.current(old), false, 'same binding cannot revive old epoch');
  const active = fence.capture(); fence.reset('account-b'); assert.equal(fence.current(active), false);
});
check('cross-tab identity invalidation discards all captured scopes', () => {
  const fence = model.createSessionFence(); fence.reset('first');
  const read = fence.capture(), mutation = fence.capture();
  fence.reset(null);
  assert.equal(fence.current(read), false); assert.equal(fence.current(mutation), false);
});
check('retry has stable byte payload and command id regardless of later input changes', () => {
  const body = { revision: 3, name: '처음 이름', nested: { value: 'original' } };
  const command = model.createCommand('PATCH', '/api/organization/organizations/' + organizationId, body, 'account-a');
  const first = command.body;
  body.name = '변경된 이름'; body.nested.value = 'changed'; body.session_binding = 'account-b';
  assert.equal(command.body, first); assert.equal(Object.isFrozen(command), true);
  const data = JSON.parse(command.body);
  assert.equal(data.name, '처음 이름'); assert.equal(data.nested.value, 'original');
  assert.equal(data.session_binding, 'account-a'); assert.match(data.command_id, /^[0-9a-f-]{36}$/);
});
check('separate changes receive independent commands, caller binding cannot override current account', () => {
  const first = model.createCommand('POST', '/api/organization/organizations', { session_binding: 'old' }, 'current');
  const second = model.createCommand('POST', '/api/organization/organizations', {}, 'current');
  assert.notEqual(JSON.parse(first.body).command_id, JSON.parse(second.body).command_id);
  assert.equal(JSON.parse(first.body).session_binding, 'current');
});
check('transport admits organization namespace only, rejects nested encoding and redirects', () => {
  assert.equal(model.pathAllowed('/api/organization/session'), true);
  assert.equal(model.pathAllowed('/api/organization/organizations?session_binding=a'), true);
  for (const path of ['/api/session', '/api/workspace', 'https://example.com/api/organization/session', '//example.com/api/organization/session', '/api/organization/../session', '/api/organization/%252e%252e/session', '/api/organization/%2f/session', '/api/organization/x\\session', '/api/organization/session#x', '/api/organization/session\nx']) assert.equal(model.pathAllowed(path), false, path);
  assert.throws(() => model.createCommand('POST', '/api/session', {}, 'bound'));
});
check('connection code round trips without names, grants, or Auth identifiers', () => {
  const code = model.encodeConnectionCode(envelope);
  assert.deepEqual(JSON.parse(JSON.stringify(model.parseConnectionCode(code))), envelope);
  assert.equal(Object.isFrozen(model.parseConnectionCode(code)), true);
  assert.deepEqual(Object.keys(JSON.parse(atob(code.replace(/-/g, '+').replace(/_/g, '/')))).sort(), ['expiresAt','nonce','organizationId','requestId','revision','v','workspaceId']);
});
check('expired, oversized, malformed, or arbitrary-object codes fail closed', () => {
  for (const value of ['', ' '.repeat(100), 'a'.repeat(2049), encode([]), encode(null), encode({ ...envelope, expiresAt: Date.now() - 1 }), encode({ ...envelope, revision: 1.5 }), encode({ ...envelope, revision: '7' }), encode({ ...envelope, v: 2 }), encode({ ...envelope, nonce: 'x'.repeat(64) }), encode({ ...envelope, workspaceId: '../outside' }), encode({ ...envelope, requestId: 'not-a-uuid' })]) assert.throws(() => model.parseConnectionCode(value), value.slice(0, 20));
});
check('HTML and prototype-bearing extra code fields cannot enter the verified preview', () => {
  for (const extra of [{ name: '<img src=x onerror=alert(1)>' }, { organizationName: '<script>bad()</script>' }, { userId: 'fake-auth-id' }, { __proto__: null, actor: 'owner' }]) assert.throws(() => model.parseConnectionCode(encode({ ...envelope, ...extra })));
  const prototypeCode = btoa(JSON.stringify(envelope).replace('"v":1,', '"v":1,"__proto__":{"polluted":true},')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.throws(() => model.parseConnectionCode(prototypeCode));
  assert.equal({}.polluted, undefined);
});
check('private console has no HTML string injection or workspace storage/bootstrap side effects', () => {
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|localStorage\.|sessionStorage\.|indexedDB\.|serviceWorker\.|console\.(?:log|debug|info)/);
  assert.doesNotMatch(html, /app\.js|offline\.js|outbox|native-bootstrap\.js/);
  assert.match(html, /transport\.js[\s\S]*organization\.js/);
  assert.match(source, /credentials: 'same-origin', redirect: 'error', cache: 'no-store'/);
});
check('login and all settings roles can reach the same-window organization document', () => {
  const login = app.slice(app.indexOf('function renderLogin('), app.indexOf('async function boot()'));
  const settings = app.slice(app.indexOf('async function renderSettings()'), app.indexOf('async function renderScimSettings'));
  assert.match(login, /href="\$\{esc\(organizationURL\(\)\)\}"/);
  assert.match(settings, /href="\$\{esc\(organizationURL\(\)\)\}"/);
  assert.doesNotMatch(login.match(/<a href="\$\{esc\(organizationURL\(\)\)\}"[^>]*>/)[0], /target=/);
});
console.log(JSON.stringify({ passed: checks, scope: 'organization UI model and static boundary', browserVisualVerified: false }));
