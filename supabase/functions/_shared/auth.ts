/** Server-only Auth boundary. The vault adapter must enforce the atomic contracts below. */
export type Ciphertext = { version: 1; keyId: string; iv: string; data: string };
export type VaultSession = {
  hash: string; userId: string; authSessionId: string; cacheBinding: string;
  createdAt: number; expiresAt: number; version: number; tokens: Ciphertext | null;
  revokedAt: number | null; logoutPending: boolean;
};
export type Profile = {
  workspaceId: string; authSessionActive: boolean;
  member: { id: string; name: string; email: string; role: string; active: boolean };
};
/** All timestamps are milliseconds. Only hashes/ciphertext belong in persistent rows.
 * resolveProfile consults CURRENT auth.sessions + trusted legacy identity/member mapping.
 * It must not derive permissions or links from user_metadata, email or JWT role claims.
 * CAS operations and revoke must be single database transactions, not read-then-write.
 */
export interface SessionVault {
  create(row: VaultSession): Promise<void>;
  read(hash: string): Promise<VaultSession | null>;
  resolveProfile(userId: string, authSessionId: string): Promise<Profile | null>;
  /** Only an empty lease may be claimed. Expired in-flight lease revokes/version++ atomically; never reclaim its one-use token. */
  claimRefresh(hash: string, expectedVersion: number, leaseId: string, until: number, now: number): Promise<boolean>;
  finishRefresh(hash: string, expectedVersion: number, leaseId: string, tokens: Ciphertext): Promise<boolean>;
  /** Only safe before any provider I/O; never release an uncertain consumed refresh. */
  releaseRefresh(hash: string, leaseId: string): Promise<void>;
  /** Marks revoked FIRST/version++, retains ciphertext for logout retry only.
   * expected limits refresh-failure revocation to the same unrevoked version+lease; mismatch returns null. */
  revoke(hash: string, now: number, expected?: { version: number; leaseId: string }): Promise<VaultSession | null>;
  /** CAS only the revoked version; clears ciphertext and pending flag on remote logout success. */
  finishLogout(hash: string, expectedVersion: number): Promise<boolean>;
}
export type AuthResult = { status: number; body: Record<string, unknown>; setCookie?: string };
/** Server-only per-call context. Never serialize this context as a public response. */
export type AuthContext = { hash: string; userId: string; authSessionId: string; cacheBinding: string; profile: Profile; expiresAt: number };
export class AuthError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "AuthError"; this.status = status; this.code = code; }
}
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
type Config = {
  supabaseUrl: string; publishableKey: string;
  cryptoKeys: Array<{ id: string; secret: string | Uint8Array }>;
  vault: SessionVault; fetch?: typeof globalThis.fetch; clock?: () => number;
};
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_TTL = 7 * 86400_000;
const clearCookie = "fountain_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
const error = (status: number, code: string, message: string) => new AuthError(status, code, message);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown, max = 65536): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function b64(bytes: Uint8Array): string {
  let text = ""; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(value: string, max = 131072): Uint8Array {
  if (!string(value, max) || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw error(401, "SESSION_UNAVAILABLE", "세션을 다시 연결해주세요.");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
  if (b64(bytes) !== value) throw error(401, "SESSION_UNAVAILABLE", "세션을 다시 연결해주세요.");
  return bytes;
}
function random(bytes: number): string { return b64(crypto.getRandomValues(new Uint8Array(bytes))); }
async function hash(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
/** A Cookie header, never a raw token. Reject duplicate or malformed target cookies. */
export function parseSessionCookie(header?: string | null): string | null {
  if (!header) return null;
  if (header.length > 16384 || /[\u0000-\u001f\u007f]/.test(header)) throw error(400, "INVALID_COOKIE", "잘못된 세션 쿠키입니다.");
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.split("=", 1)[0].trim() === "fountain_session");
  if (!values.length) return null;
  if (values.length !== 1 || !/^fountain_session=[A-Za-z0-9_-]{43}$/.test(values[0])) throw error(400, "INVALID_COOKIE", "잘못된 세션 쿠키입니다.");
  const value = values[0].slice(17);
  try { if (unb64(value).length !== 32) throw new Error(); }
  catch { throw error(400, "INVALID_COOKIE", "잘못된 세션 쿠키입니다."); }
  return value;
}
function anonymous(): AuthResult { return { status: 200, body: { enabled: true, required: true, authenticated: false, mode: "accounts", member: null, identity: null, workspace_id: null, cache_binding: null, expires_at: null } }; }
function jwtIdentity(accessToken: string): { userId: string; authSessionId: string; expiresAt: number } {
  try {
    const parts = accessToken.split("."); if (parts.length !== 3) throw new Error();
    const claims = JSON.parse(decoder.decode(unb64(parts[1])));
    if (!object(claims) || !string(claims.sub) || !UUID.test(claims.sub) || !string(claims.session_id) || !UUID.test(claims.session_id) || !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= 0) throw new Error();
    return { userId: claims.sub, authSessionId: claims.session_id, expiresAt: (claims.exp as number) * 1000 };
  } catch { throw error(502, "AUTH_RESPONSE_INVALID", "인증 서비스 응답을 확인할 수 없습니다."); }
}

export function createAuth(config: Config) {
  const url = new URL(config.supabaseUrl), request = config.fetch ?? globalThis.fetch, now = config.clock ?? Date.now;
  // HTTP is accepted only for isolated loopback fixtures; production requires HTTPS.
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw error(500, "AUTH_CONFIGURATION", "인증 서비스 설정이 필요합니다.");
  if (!string(config.publishableKey, 4096) || !config.cryptoKeys.length) throw error(500, "AUTH_CONFIGURATION", "인증 서비스 설정이 필요합니다.");
  const keys = new Map<string, Uint8Array>();
  for (const key of config.cryptoKeys) {
    const bytes = typeof key.secret === "string" ? encoder.encode(key.secret) : new Uint8Array(key.secret);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.id) || keys.has(key.id) || bytes.length < 32 || bytes.length > 1024) throw error(500, "AUTH_CONFIGURATION", "인증 서비스 설정이 필요합니다.");
    keys.set(key.id, bytes);
  }
  const activeKey = config.cryptoKeys[0].id, vault = config.vault;
  async function store<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch { throw error(503, "SESSION_STORAGE_UNAVAILABLE", "세션 저장소에 연결할 수 없습니다."); }
  }
  async function encryptionKey(keyId: string, row: VaultSession): Promise<CryptoKey> {
    const secret = keys.get(keyId); if (!secret) throw error(401, "SESSION_UNAVAILABLE", "세션을 다시 연결해주세요.");
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(row.hash), info: encoder.encode(JSON.stringify(["fountain-auth-token-vault", 1, keyId, row.userId])) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  function aad(row: VaultSession): Uint8Array { return encoder.encode(JSON.stringify(["fountain-auth-tokens", 1, row.hash, row.userId, row.authSessionId])); }
  async function encrypt(tokens: Tokens, row: VaultSession): Promise<Ciphertext> {
    const iv = crypto.getRandomValues(new Uint8Array(12)), key = await encryptionKey(activeKey, row);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(row) }, key, encoder.encode(JSON.stringify(tokens)));
    return { version: 1, keyId: activeKey, iv: b64(iv), data: b64(new Uint8Array(ciphertext)) };
  }
  async function decrypt(row: VaultSession): Promise<Tokens> {
    try {
      const value = row.tokens;
      if (!value || value.version !== 1 || !string(value.keyId, 64)) throw new Error();
      const iv = unb64(value.iv); if (iv.length !== 12) throw new Error();
      const key = await encryptionKey(value.keyId, row);
      const body = JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(row) }, key, unb64(value.data, 262144))));
      if (!object(body) || !string(body.accessToken) || !string(body.refreshToken) || !Number.isSafeInteger(body.expiresAt)) throw new Error();
      const claims = jwtIdentity(body.accessToken);
      if (claims.userId !== row.userId || claims.authSessionId !== row.authSessionId || claims.expiresAt !== body.expiresAt) throw new Error();
      return body as Tokens;
    } catch { throw error(401, "SESSION_UNAVAILABLE", "세션을 다시 연결해주세요."); }
  }
  async function provider(path: string, method: string, body?: unknown, accessToken?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await request(url.origin + "/auth/v1" + path, { method, redirect: "error", signal: AbortSignal.timeout(8000), headers: { apikey: config.publishableKey, ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw error(503, "AUTH_UNAVAILABLE", "인증 서비스에 연결할 수 없습니다."); }
    if (!response.ok) {
      // Provider bodies may contain user input or internal diagnostics. Never relay them.
      await response.body?.cancel();
      if ([400, 401, 403, 404].includes(response.status)) throw error(401, "AUTH_REJECTED", "인증 정보를 확인해주세요.");
      throw error(503, "AUTH_UNAVAILABLE", "인증 서비스에 연결할 수 없습니다.");
    }
    if (response.status === 204) return {};
    // Bound decoded token/user responses without reading an unbounded provider body.
    const reader = response.body?.getReader(); if (!reader) throw error(502, "AUTH_RESPONSE_INVALID", "인증 서비스 응답을 확인할 수 없습니다.");
    let total = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > 262144) throw new Error(); chunks.push(part.value); }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(decoder.decode(bytes)); if (!object(value)) throw new Error(); return value;
    } catch { await reader.cancel().catch(() => {}); throw error(502, "AUTH_RESPONSE_INVALID", "인증 서비스 응답을 확인할 수 없습니다."); }
  }
  function tokenResponse(body: Record<string, unknown>): { tokens: Tokens; userId: string; authSessionId: string } {
    if (!string(body.access_token) || !string(body.refresh_token) || body.token_type !== "bearer") throw error(502, "AUTH_RESPONSE_INVALID", "인증 서비스 응답을 확인할 수 없습니다.");
    const claims = jwtIdentity(body.access_token);
    if (claims.expiresAt <= now() || claims.expiresAt > now() + 86400_000) throw error(502, "AUTH_RESPONSE_INVALID", "인증 서비스 응답을 확인할 수 없습니다.");
    return { ...claims, tokens: { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: claims.expiresAt } };
  }
  async function verify(tokens: Tokens, userId: string, authSessionId: string): Promise<Profile> {
    // GET /user validates the signed token at Auth; decoded JWT claims only locate its session.
    const user = await provider("/user", "GET", undefined, tokens.accessToken);
    if (user.id !== userId || user.is_anonymous === true) throw error(401, "AUTH_REJECTED", "인증 정보를 확인해주세요.");
    const profile = await store(() => vault.resolveProfile(userId, authSessionId));
    if (!profile) throw error(403, "SETUP_REQUIRED", "이 계정과 연결된 가족 구성원이 없습니다.");
    if (profile.authSessionActive !== true || profile.member?.active !== true) throw error(401, "AUTH_REJECTED", "인증 정보를 확인해주세요.");
    if (!string(profile.workspaceId, 1000) || !string(profile.member.id, 1000) || !string(profile.member.name, 1000) || typeof profile.member.email !== "string" || !["owner", "admin", "member", "guest"].includes(profile.member.role)) throw error(503, "SESSION_STORAGE_UNAVAILABLE", "세션 저장소에 연결할 수 없습니다.");
    const { id, name, email, role } = profile.member;
    return { workspaceId: profile.workspaceId, authSessionActive: true, member: { id, name, email, role, active: true } };
  }
  function publicResult(row: VaultSession, profile: Profile): AuthResult {
    const { id, name, email, role } = profile.member;
    return { status: 200, body: { enabled: true, required: true, authenticated: true, mode: "accounts", identity: name, member: { id, name, email, role, active: true }, workspace_id: profile.workspaceId, cache_binding: row.cacheBinding, expires_at: new Date(row.expiresAt).toISOString() } };
  }
  async function current(hash: string): Promise<VaultSession | null> {
    const row = await store(() => vault.read(hash));
    if (!row) return null;
    if (row.hash !== hash || !UUID.test(row.userId) || !UUID.test(row.authSessionId) || !/^[a-f0-9]{32}$/.test(row.cacheBinding) || !Number.isSafeInteger(row.version) || row.version < 0 || !Number.isSafeInteger(row.expiresAt) || !Number.isSafeInteger(row.createdAt) || row.expiresAt !== row.createdAt + OPAQUE_TTL) throw error(503, "SESSION_STORAGE_UNAVAILABLE", "세션 저장소에 연결할 수 없습니다.");
    return row;
  }
  async function revoke(hash: string, expected?: { version: number; leaseId: string }): Promise<VaultSession | null> { return store(() => vault.revoke(hash, now(), expected)); }
  async function remoteLogout(row: VaultSession): Promise<void> {
    if (!row.logoutPending || !row.tokens) return;
    try {
      const tokens = await decrypt(row);
      try { await provider("/logout?scope=local", "POST", undefined, tokens.accessToken); }
      catch { return; }
      await store(() => vault.finishLogout(row.hash, row.version));
    } catch { /* Local revocation is already durable; ciphertext remains retry-only. */ }
  }
  async function fresh(row: VaultSession): Promise<{ row: VaultSession; tokens: Tokens }> {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (row.revokedAt !== null || row.expiresAt <= now()) throw error(401, "AUTH_REJECTED", "세션을 다시 연결해주세요.");
      const tokens = await decrypt(row);
      if (tokens.expiresAt > now() + 30_000) return { row, tokens };
      const leaseId = random(24), claimed = await store(() => vault.claimRefresh(row.hash, row.version, leaseId, now() + 30_000, now()));
      if (claimed) {
        try {
          const value = tokenResponse(await provider("/token?grant_type=refresh_token", "POST", { refresh_token: tokens.refreshToken }));
          if (value.userId !== row.userId || value.authSessionId !== row.authSessionId) throw error(401, "AUTH_REJECTED", "세션을 다시 연결해주세요.");
          await verify(value.tokens, row.userId, row.authSessionId);
          const encrypted = await encrypt(value.tokens, row);
          const saved = await store(() => vault.finishRefresh(row.hash, row.version, leaseId, encrypted));
          if (!saved) throw error(503, "AUTH_REFRESH_CHANGED", "세션 갱신 상태를 다시 확인해주세요.");
        } catch (cause) {
          // A database ACK may be lost after a successful commit. An authoritative
          // newer active row is safe to reuse; the late loser cannot revoke it.
          const next = await current(row.hash);
          if (next && next.version !== row.version) {
            row = next;
            continue;
          }
          // Provider I/O can consume a one-use token even when its response is
          // lost. Fence only this exact lease/version. Never release the lease
          // after I/O: failure to persist this fence must leave replay blocked.
          const revoked = await revoke(row.hash, { version: row.version, leaseId });
          if (!revoked) {
            const changed = await current(row.hash);
            if (changed && changed.version !== row.version) { row = changed; continue; }
            throw error(503, "AUTH_REFRESH_CHANGED", "세션 갱신 상태를 다시 확인해주세요.");
          }
          if (cause instanceof AuthError && [401, 403].includes(cause.status)) throw error(401, "SESSION_UNAVAILABLE", "세션을 다시 연결해주세요.");
          throw cause;
        }
      } else { await new Promise((resolve) => setTimeout(resolve, 50)); }
      const next = await current(row.hash); if (!next) throw error(401, "AUTH_REJECTED", "세션을 다시 연결해주세요."); row = next;
    }
    throw error(503, "AUTH_BUSY", "세션 갱신 중입니다. 잠시 후 다시 시도해주세요.");
  }
  async function verifiedSession(cookie?: string | null): Promise<{ row: VaultSession; profile: Profile } | null> {
    const opaque = parseSessionCookie(cookie); if (!opaque) return null;
    const id = await hash(opaque); let row = await current(id);
    if (!row || row.revokedAt !== null) return null;
    if (row.expiresAt <= now()) { await revoke(id); return null; }
    try {
      const active = await fresh(row); row = active.row;
      const profile = await verify(active.tokens, row.userId, row.authSessionId);
      // Final local gate catches logout/password/member changes during provider I/O.
      const final = await current(id);
      if (!final || final.revokedAt !== null || final.expiresAt <= now() || final.userId !== row.userId || final.authSessionId !== row.authSessionId || final.cacheBinding !== row.cacheBinding || final.createdAt !== row.createdAt) return null;
      return { row: final, profile };
    } catch (cause) {
      if (cause instanceof AuthError && [401, 403].includes(cause.status)) { await revoke(id); return null; }
      throw cause;
    }
  }
  async function session(cookie?: string | null): Promise<AuthResult> {
    const active = await verifiedSession(cookie);
    return active ? publicResult(active.row, active.profile) : { ...anonymous(), ...(parseSessionCookie(cookie) ? { setCookie: clearCookie } : {}) };
  }
  async function authorize(cookie?: string | null): Promise<AuthContext> {
    const active = await verifiedSession(cookie);
    if (!active) throw error(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
    const { hash, userId, authSessionId, cacheBinding, expiresAt } = active.row;
    return { hash, userId, authSessionId, cacheBinding, profile: active.profile, expiresAt };
  }
  async function logout(cookie?: string | null, options: { expectedBinding?: string } = {}): Promise<AuthResult> {
    const opaque = parseSessionCookie(cookie); if (!opaque) return { ...anonymous(), setCookie: clearCookie };
    const id = await hash(opaque), prior = await current(id);
    if (prior && prior.revokedAt === null && prior.expiresAt > now() && options.expectedBinding !== undefined && options.expectedBinding !== prior.cacheBinding) throw error(409, "SESSION_CHANGED", "계정이 변경되었습니다. 현재 화면을 다시 확인해주세요.");
    const row = await revoke(id); // Must commit before any provider/network call.
    if (row) await remoteLogout(row);
    return { ...anonymous(), setCookie: clearCookie };
  }
  async function login(body: unknown, cookie?: string | null): Promise<AuthResult> {
    parseSessionCookie(cookie);
    if (!object(body) || Object.keys(body).some((key) => !["email", "password"].includes(key)) || !string(body.email, 320) || !string(body.password, 4096) || /[\r\n\0]/.test(body.email)) throw error(400, "INVALID_LOGIN", "이메일과 비밀번호를 입력해주세요.");
    if (parseSessionCookie(cookie)) await logout(cookie);
    const value = tokenResponse(await provider("/token?grant_type=password", "POST", { email: body.email, password: body.password }));
    try {
      const profile = await verify(value.tokens, value.userId, value.authSessionId);
      const opaque = random(32), createdAt = now();
      const row: VaultSession = { hash: await hash(opaque), userId: value.userId, authSessionId: value.authSessionId, cacheBinding: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""), createdAt, expiresAt: createdAt + OPAQUE_TTL, version: 0, tokens: null, revokedAt: null, logoutPending: false };
      row.tokens = await encrypt(value.tokens, row);
      await store(() => vault.create(row));
      return { ...publicResult(row, profile), setCookie: "fountain_session=" + opaque + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800" };
    } catch (cause) {
      // Failed setup/storage must not deliberately leave an unlinked provider
      // session active. This best-effort cleanup never exposes its credentials.
      await provider("/logout?scope=local", "POST", undefined, value.tokens.accessToken).catch(() => {});
      throw cause;
    }
  }
  return Object.freeze({ login, session, authorize, logout });
}
