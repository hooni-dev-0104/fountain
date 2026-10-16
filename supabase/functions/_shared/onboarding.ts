/** Explicit trusted claims. This module never infers an owner from signup order,
 * email or metadata, and never returns an Auth access/refresh token. */
import { AuthError } from './auth.ts';
import type { AuthContext,AuthResult } from './auth.ts';
type ClaimInput = { nonceHash: string; userId: string; authSessionId: string };
type ClaimResult = { workspace_id: string; member_id: string; replayed: boolean };
type Config = {
  supabaseUrl: string; publishableKey: string; serviceKey: string; workspaceId: string;
  fetch?: typeof globalThis.fetch; clock?: () => number;
  signupEnabled?: boolean; serverConfirmationTemplateVerified?: boolean; confirmationRedirects?: string[];
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const fail = (status: number, code: string, message: string): never => { throw new AuthError(status, code, message); };
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value: unknown, fields: string[], status = 400): asserts value is Record<string, any> {
  if (!object(value) || Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) fail(status, status === 400 ? 'INVALID_SETUP' : 'SETUP_UNAVAILABLE', '계정 연결 정보를 확인해주세요.');
}
function text(value: unknown, limit = 1000): value is string { return typeof value === 'string' && value.length > 0 && Array.from(value).length <= limit && !/[\x00-\x1f\x7f]/.test(value); }
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function digest(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

export function createOnboarding(config: Config) {
  let origin: string;
  try {
    const url = new URL(config.supabaseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    if (!text(config.workspaceId, 160) || !text(config.publishableKey, 4096) || !text(config.serviceKey, 4096)) throw new Error();
    origin = url.origin;
  } catch { return fail(503, 'SETUP_UNAVAILABLE', '계정 연결 설정이 아직 준비되지 않았습니다.'); }
  const request = config.fetch ?? globalThis.fetch, clock = config.clock ?? Date.now;
  const serviceHeaders: Record<string, string> = { apikey: config.serviceKey, 'Content-Type': 'application/json' };
  if (config.serviceKey.startsWith('sb_secret_')) {
    if (!/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey)) fail(503, 'SETUP_UNAVAILABLE', '계정 연결 설정이 아직 준비되지 않았습니다.');
  } else {
    try { const parts = config.serviceKey.split('.'); const value = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - parts[1].length % 4) % 4))); if (parts.length !== 3 || value.role !== 'service_role') throw new Error(); }
    catch { fail(503, 'SETUP_UNAVAILABLE', '계정 연결 설정이 아직 준비되지 않았습니다.'); }
    serviceHeaders.Authorization = 'Bearer ' + config.serviceKey;
  }
  const redirects = new Set<string>();
  for (const redirect of config.confirmationRedirects ?? []) {
    try { const value = new URL(redirect); if (value.protocol !== 'https:' || value.username || value.password || value.hash || value.href !== redirect) throw new Error(); redirects.add(redirect); }
    catch { fail(503, 'SETUP_UNAVAILABLE', '이메일 확인 주소 설정을 확인해주세요.'); }
  }
  const confirmationEnabled = config.signupEnabled === true && config.serverConfirmationTemplateVerified === true && redirects.size > 0;
  async function json(path: string, body: unknown, headers = serviceHeaders): Promise<Record<string, any>> {
    let response: Response;
    try { response = await request(origin + path, { method: 'POST', headers: { ...headers }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000) }); }
    catch { return fail(503, 'SETUP_UNAVAILABLE', '계정 연결을 완료할 수 없습니다. 다시 시도해주세요.'); }
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) fail(403, 'SETUP_REJECTED', '초대가 유효하지 않거나 계정을 연결할 수 없습니다.');
      if (response.status === 410) fail(410, 'SETUP_EXPIRED', '초대 기간이 지났습니다. 새 초대를 요청해주세요.');
      if (response.status === 409) fail(409, 'SETUP_CONFLICT', '이미 연결된 계정입니다. 현재 계정 연결을 확인해주세요.');
      if (response.status === 429) fail(429, 'SETUP_RATE_LIMIT', '요청이 많습니다. 잠시 후 다시 시도해주세요.');
      if (response.status === 400) fail(400, 'INVALID_SETUP', '계정 연결 정보를 확인해주세요.');
      if (response.status === 422 && path === '/auth/v1/admin/users') fail(400, 'INVALID_SETUP', '계정 정보와 비밀번호 조건을 확인해주세요.');
      fail(503, 'SETUP_UNAVAILABLE', '계정 연결을 완료할 수 없습니다. 다시 시도해주세요.');
    }
    const reader = response.body?.getReader(); if (!reader) return fail(503, 'SETUP_UNAVAILABLE', '계정 연결 응답을 확인할 수 없습니다.');
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw new Error(); parts.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(result)) throw new Error(); return result;
    } catch { await reader.cancel().catch(() => {}); return fail(503, 'SETUP_UNAVAILABLE', '계정 연결 응답을 확인할 수 없습니다.'); }
  }
  async function claim(input: ClaimInput): Promise<ClaimResult> {
    exact(input, ['nonceHash', 'userId', 'authSessionId']);
    if (typeof input.nonceHash !== 'string' || input.nonceHash.length !== 64 || !HASH.test(input.nonceHash) || typeof input.userId !== 'string' || input.userId.match(UUID)?.[0] !== input.userId || typeof input.authSessionId !== 'string' || input.authSessionId.match(UUID)?.[0] !== input.authSessionId) fail(400, 'INVALID_SETUP', '계정 연결 정보를 확인해주세요.');
    const result = await json('/rest/v1/rpc/fountain_cloud_onboarding_claim', { p_workspace_id: config.workspaceId, p_nonce_hash: input.nonceHash, p_user_id: input.userId, p_auth_session_id: input.authSessionId });
    exact(result, ['workspace_id', 'member_id', 'replayed'], 503);
    if (result.workspace_id !== config.workspaceId || !text(result.member_id, 160) || typeof result.replayed !== 'boolean') fail(503, 'SETUP_UNAVAILABLE', '계정 연결 응답을 확인할 수 없습니다.');
    return result as ClaimResult;
  }
  async function invite(auth: AuthContext, body: unknown): Promise<{ nonce: string; member_id: string; expires_at: string }> {
    exact(body, ['memberId']);
    if (!text(body.memberId, 160)) fail(400, 'INVALID_SETUP', '초대할 가족 구성원을 확인해주세요.');
    if (auth.profile?.workspaceId !== config.workspaceId || auth.profile?.authSessionActive !== true || auth.profile?.member?.active !== true || auth.profile.member.role !== 'owner') fail(403, 'SETUP_REJECTED', '워크스페이스 소유자만 초대할 수 있습니다.');
    const nonce = b64(crypto.getRandomValues(new Uint8Array(32))), expiresAt = clock() + 900000;
    const context = { workspaceId: config.workspaceId, memberId: auth.profile.member.id, userId: auth.userId, authSessionId: auth.authSessionId, sessionHash: auth.hash, cacheBinding: auth.cacheBinding };
    const result = await json('/rest/v1/rpc/fountain_cloud_onboarding_invite', { p_context: context, p_member_id: body.memberId, p_nonce_hash: await digest(nonce), p_expires_at_ms: expiresAt });
    exact(result, ['workspace_id', 'member_id', 'expires_at_ms'], 503);
    if (result.workspace_id !== config.workspaceId || result.member_id !== body.memberId || result.expires_at_ms !== expiresAt) fail(503, 'SETUP_UNAVAILABLE', '초대 발급 응답을 확인할 수 없습니다.');
    return { nonce, member_id: result.member_id, expires_at: new Date(expiresAt).toISOString() };
  }
  async function signup(body: unknown): Promise<{ confirmation_required: boolean }> {
    // Default disabled: root must verify the server token_hash email template.
    // Never use GoTrue's default implicit callback that puts JWTs in a fragment.
    if (!confirmationEnabled) fail(503, 'CONFIRMATION_UNAVAILABLE', '이메일 가입 설정이 아직 준비되지 않았습니다.');
    exact(body, ['email', 'password', 'redirectTo']);
    if (!text(body.email, 320) || !text(body.password, 4096) || !redirects.has(body.redirectTo)) fail(400, 'INVALID_SETUP', '이메일 가입 정보를 확인해주세요.');
    const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
    const result = await json('/auth/v1/signup?redirect_to=' + encodeURIComponent(body.redirectTo), { email: body.email, password: body.password }, headers);
    if (typeof result.access_token === 'string') {
      if (!result.access_token || !text(result.refresh_token, 65536) || result.token_type !== 'bearer' || !object(result.user) || typeof result.user.id !== 'string' || result.user.id.match(UUID)?.[0] !== result.user.id) fail(503, 'SETUP_UNAVAILABLE', '이메일 가입 응답을 확인할 수 없습니다.');
      // Auto-confirm installations may create a session. It stays private and
      // is discarded; the caller still explicitly enters the setup flow.
      try { const response = await request(origin + '/auth/v1/logout?scope=local', { method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + result.access_token }, redirect: 'error', signal: AbortSignal.timeout(8000) }); await response.body?.cancel(); } catch { /* no public credentials */ }
      return { confirmation_required: false };
    }
    if (typeof result.id !== 'string' || result.id.match(UUID)?.[0] !== result.id) fail(503, 'SETUP_UNAVAILABLE', '이메일 가입 응답을 확인할 수 없습니다.');
    return { confirmation_required: true };
  }
  async function bootstrapCreate(body:unknown,setup:(body:unknown)=>Promise<AuthResult>):Promise<AuthResult>{
    exact(body,['email','password','nonce']);
    if(!text(body.email,320)||!text(body.password,4096)||typeof body.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.nonce))fail(400,'INVALID_SETUP','이메일과 비밀번호, 연결 코드를 확인해주세요.');
    // Retry a signed existing-account setup first. This also recovers a lost
    // Admin create acknowledgement without email searches or password changes.
    try{return await setup(body);}catch(error){if(!(error instanceof AuthError)||error.status!==401||error.code!=='AUTH_REJECTED')throw error;}
    const nonceHash=await digest(body.nonce);
    if(Array.from(body.password).length<10)fail(400,'INVALID_SETUP','새 비밀번호는 10자 이상 입력해주세요.');
    const permission=await json('/rest/v1/rpc/fountain_cloud_bootstrap_begin',{p_workspace_id:config.workspaceId,p_nonce_hash:nonceHash});
    if(permission.allowed!==true)fail(503,'SETUP_UNAVAILABLE','초기 계정 연결 권한을 확인할 수 없습니다.');
    // The private, one-use operator code is the authority here. This does not
    // enable general signup or infer workspace ownership from an email address.
    const created=await json('/auth/v1/admin/users',{email:body.email,password:body.password,email_confirm:true,app_metadata:{fountain_bootstrap:nonceHash}});
    const user=object(created.user)?created.user:created;
    if(typeof user.id!=='string'||!UUID.test(user.id)||user.app_metadata?.fountain_bootstrap!==nonceHash)fail(503,'SETUP_UNAVAILABLE','계정 생성 결과를 확인할 수 없습니다. 같은 정보로 다시 연결해주세요.');
    return setup(body);
  }
  return Object.freeze({ claim, invite, signup, bootstrapCreate, capabilities: Object.freeze({ claimConfigured: true, signupEnabled: confirmationEnabled, confirmationEnabled }) });
}
