/** Server-only PostgREST adapter. No Auth credential is returned to a renderer. */
import type { Ciphertext, Profile, SessionVault, VaultSession } from "./auth.ts";

type Config = { supabaseUrl: string; serviceKey: string; workspaceId: string; fetch?: typeof globalThis.fetch; timeoutMs?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/, BINDING = /^[a-f0-9]{32}$/, BASE64 = /^[A-Za-z0-9_-]+$/;
const TTL = 604800000, MAX_RESPONSE = 262144;
export class VaultError extends Error {
  readonly status = 503; readonly code = "SESSION_STORAGE_UNAVAILABLE";
  constructor() { super("세션 저장소에 연결할 수 없습니다."); this.name = "VaultError"; }
}
function check(value: unknown): asserts value { if (!value) throw new VaultError(); }
function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function exact(value: unknown, fields: string[]): asserts value is Record<string, any> { check(object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))); }
function ciphertext(value: unknown): asserts value is Ciphertext {
  exact(value, ["version", "keyId", "iv", "data"]);
  check(value.version === 1 && typeof value.keyId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.keyId));
  check(typeof value.iv === "string" && BASE64.test(value.iv) && value.iv.length === 16);
  check(typeof value.data === "string" && BASE64.test(value.data) && value.data.length >= 22 && value.data.length <= 240000 && value.data.length % 4 !== 1);
  // Canonical unpadded base64url: unused padding bits must be zero.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", last = alphabet.indexOf(value.data.at(-1));
  check(value.data.length % 4 === 0 || value.data.length % 4 === 2 && last % 16 === 0 || value.data.length % 4 === 3 && last % 4 === 0);
}
function session(value: unknown): asserts value is VaultSession {
  exact(value, ["hash", "userId", "authSessionId", "cacheBinding", "createdAt", "expiresAt", "version", "tokens", "revokedAt", "logoutPending"]);
  check(typeof value.hash === "string" && HASH.test(value.hash) && typeof value.userId === "string" && UUID.test(value.userId) && typeof value.authSessionId === "string" && UUID.test(value.authSessionId));
  check(typeof value.cacheBinding === "string" && BINDING.test(value.cacheBinding) && integer(value.createdAt) && integer(value.expiresAt) && value.expiresAt <= 8640000000000000 && value.expiresAt === value.createdAt + TTL && integer(value.version));
  check(value.revokedAt === null || integer(value.revokedAt) && value.revokedAt >= value.createdAt);
  check(typeof value.logoutPending === "boolean");
  if (value.tokens !== null) ciphertext(value.tokens);
  check(value.revokedAt === null ? value.tokens !== null && value.logoutPending === false : value.logoutPending === (value.tokens !== null));
}
function profile(value: unknown): asserts value is Profile {
  exact(value, ["workspaceId", "authSessionActive", "member"]);
  exact(value.member, ["id", "name", "email", "role", "active"]);
  check(text(value.workspaceId, 1000) && typeof value.authSessionActive === "boolean" && text(value.member.id, 1000) && text(value.member.name, 1000));
  check(typeof value.member.email === "string" && value.member.email.length <= 1000 && ["owner", "admin", "member", "guest"].includes(value.member.role) && typeof value.member.active === "boolean");
}

export function createSessionVault(config: Config): SessionVault {
  let origin: string, serviceKey: string, workspaceId: string, timeout: number;
  try {
    const url = new URL(config.supabaseUrl);
    check((url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) && !url.username && !url.password && !url.search && !url.hash && ["", "/"].includes(url.pathname));
    check(text(config.workspaceId, 1000) && text(config.serviceKey, 4096));
    origin = url.origin; workspaceId = config.workspaceId; serviceKey = config.serviceKey;
    timeout = config.timeoutMs ?? 8000; check(integer(timeout) && timeout > 0 && timeout <= 15000);
  } catch { throw new VaultError(); }
  const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json", Accept: "application/json" };
  if (serviceKey.startsWith("sb_secret_")) check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(serviceKey));
  else {
    // Legacy service_role keys are JWTs. Modern secret keys are not JWTs and
    // belong exclusively in apikey, never Authorization: Bearer.
    try { const parts = serviceKey.split("."); check(parts.length === 3 && parts.every(part => BASE64.test(part))); const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - parts[1].length % 4) % 4))); check(claims.role === "service_role"); }
    catch { throw new VaultError(); }
    headers.Authorization = "Bearer " + serviceKey;
  }
  const request = config.fetch ?? globalThis.fetch;
  async function rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await request(origin + "/rest/v1/rpc/fountain_cloud_" + name, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout), headers: { ...headers },
        body: JSON.stringify({ p_workspace_id: workspaceId, ...parameters }),
      });
      if (!response.ok || response.redirected) { await response.body?.cancel(); throw new VaultError(); }
      if (response.status === 204) return null;
      const reader = response.body?.getReader(); check(reader);
      const parts: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; check(size <= MAX_RESPONSE); parts.push(part.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch { await reader.cancel().catch(() => {}); throw new VaultError(); }
    } catch { throw new VaultError(); }
  }
  function key(hash: string) { check(typeof hash === "string" && HASH.test(hash)); return { p_hash: hash }; }
  function version(value: number) { check(integer(value)); return value; }
  function lease(value: string) { check(typeof value === "string" && /^[A-Za-z0-9_-]{16,160}$/.test(value)); return value; }
  async function boolean(name: string, parameters: Record<string, unknown>) { const result = await rpc(name, parameters); check(typeof result === "boolean"); return result; }
  return Object.freeze({
    async create(row: VaultSession) { session(row); check(row.version === 0 && row.revokedAt === null && row.tokens !== null && !row.logoutPending); const result = await rpc("vault_create", { p_row: structuredClone(row) }); check(result === null); },
    async read(hash: string) { const result = await rpc("vault_read", key(hash)); if (result === null) return null; session(result); check(result.hash === hash); return result; },
    async resolveProfile(userId: string, authSessionId: string) { check(UUID.test(userId) && UUID.test(authSessionId)); const result = await rpc("resolve_profile", { p_user_id: userId, p_auth_session_id: authSessionId }); if (result === null) return null; profile(result); check(result.workspaceId === workspaceId); return result; },
    async claimRefresh(hash: string, expectedVersion: number, leaseId: string, until: number, now: number) { check(integer(until) && integer(now) && until > now && until <= now + 60000); return boolean("vault_claim_refresh", { ...key(hash), p_expected_version: version(expectedVersion), p_lease_id: lease(leaseId), p_until: until, p_now: now }); },
    async finishRefresh(hash: string, expectedVersion: number, leaseId: string, tokens: Ciphertext) { ciphertext(tokens); return boolean("vault_finish_refresh", { ...key(hash), p_expected_version: version(expectedVersion), p_lease_id: lease(leaseId), p_tokens: structuredClone(tokens) }); },
    async releaseRefresh(hash: string, leaseId: string) { const result = await rpc("vault_release_refresh", { ...key(hash), p_lease_id: lease(leaseId) }); check(result === null); },
    async revoke(hash: string, now: number, expected?: { version: number; leaseId: string }) { check(integer(now)); const result = await rpc("vault_revoke", { ...key(hash), p_now: now, p_expected_version: expected === undefined ? null : version(expected.version), p_lease_id: expected === undefined ? null : lease(expected.leaseId) }); if (result === null) return null; session(result); check(result.hash === hash && result.revokedAt !== null); return result; },
    async finishLogout(hash: string, expectedVersion: number) { return boolean("vault_finish_logout", { ...key(hash), p_expected_version: version(expectedVersion) }); },
  });
}
