/** Server-only PostgREST adapter. No Auth credential is returned to a renderer. */
import type { Ciphertext, VaultSession } from "./session-auth.ts";
import type { IdentityProfile, IdentitySessionVault } from "./identity-profile.ts";

export type IdentityVaultConfig = { supabaseUrl: string; serviceKey: string; fetch?: typeof globalThis.fetch; timeoutMs?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/, BINDING = /^[a-f0-9]{32}$/, BASE64 = /^[A-Za-z0-9_-]+$/;
const TTL = 604800000, MAX_RESPONSE = 262144;
function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value); }
function displayName(value: unknown): value is string { return typeof value === "string" && value.length > 0 && [...value].length <= 1000 && new TextEncoder().encode(value).length <= 4000; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function createIdentitySessionVault(config: IdentityVaultConfig, rpcName: string, failure: () => Error): IdentitySessionVault {
  function check(value: unknown): asserts value { if (!value) throw failure(); }
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
  function profile(value: unknown): asserts value is IdentityProfile {
    exact(value, ["authSessionActive", "user"]); exact(value.user, ["id", "email", "name"]);
    check(typeof value.authSessionActive === "boolean" && typeof value.user.id === "string" && UUID.test(value.user.id) && text(value.user.email, 320) && displayName(value.user.name));
  }
  check(/^fountain_cloud_(?:organization|account)_session_vault$/.test(rpcName));
  let origin: string, serviceKey: string, timeout: number;
  try {
    const url = new URL(config.supabaseUrl);
    check((url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) && !url.username && !url.password && !url.search && !url.hash && ["", "/"].includes(url.pathname));
    check(text(config.serviceKey, 4096));
    origin = url.origin; serviceKey = config.serviceKey;
    timeout = config.timeoutMs ?? 8000; check(integer(timeout) && timeout > 0 && timeout <= 15000);
  } catch { throw failure(); }
  const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json", Accept: "application/json" };
  if (serviceKey.startsWith("sb_secret_")) check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(serviceKey));
  else {
    // Legacy service_role keys are JWTs. Modern secret keys are not JWTs and
    // belong exclusively in apikey, never Authorization: Bearer.
    try { const parts = serviceKey.split("."); check(parts.length === 3 && parts.every(part => BASE64.test(part))); const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - parts[1].length % 4) % 4))); check(claims.role === "service_role"); }
    catch { throw failure(); }
    headers.Authorization = "Bearer " + serviceKey;
  }
  const request = config.fetch ?? globalThis.fetch;
  async function rpc(action: string, value: Record<string, unknown>, maximum = MAX_RESPONSE): Promise<unknown> {
    try {
      const response = await request(origin + "/rest/v1/rpc/" + rpcName, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout), headers: { ...headers },
        body: JSON.stringify({ p_action: action, p_value: value }),
      });
      if (!response.ok || response.redirected) { await response.body?.cancel(); throw failure(); }
      if (response.status === 204) return null;
      const reader = response.body?.getReader(); check(reader);
      const parts: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; check(size <= maximum); parts.push(part.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch { await reader.cancel().catch(() => {}); throw failure(); }
    } catch { throw failure(); }
  }
  function key(hash: string) { check(typeof hash === "string" && HASH.test(hash)); return { hash }; }
  function version(value: number) { check(integer(value)); return value; }
  function lease(value: string) { check(typeof value === "string" && /^[A-Za-z0-9_-]{16,160}$/.test(value)); return value; }
  async function boolean(name: string, parameters: Record<string, unknown>) { const result = await rpc(name, parameters); check(typeof result === "boolean"); return result; }
  return Object.freeze({
    async create(row: VaultSession) { session(row); check(row.version === 0 && row.revokedAt === null && row.tokens !== null && !row.logoutPending); const result = await rpc("create", { row: structuredClone(row) }); check(result === null); },
    async read(hash: string) { const result = await rpc("read", key(hash)); if (result === null) return null; session(result); check(result.hash === hash); return result; },
    async resolveProfile(userId: string, authSessionId: string) { check(UUID.test(userId) && UUID.test(authSessionId)); const result = await rpc("profile", { userId: userId, authSessionId: authSessionId }); if (result === null) return null; profile(result); check(result.user.id === userId); return result; },
    async claimRefresh(hash: string, expectedVersion: number, leaseId: string, until: number, now: number) { check(integer(until) && integer(now) && until > now && until <= now + 60000); return boolean("claim_refresh", { ...key(hash), expectedVersion: version(expectedVersion), leaseId: lease(leaseId), until: until, now: now }); },
    async finishRefresh(hash: string, expectedVersion: number, leaseId: string, tokens: Ciphertext) { ciphertext(tokens); return boolean("finish_refresh", { ...key(hash), expectedVersion: version(expectedVersion), leaseId: lease(leaseId), tokens: structuredClone(tokens) }); },
    async releaseRefresh(hash: string, leaseId: string) { const result = await rpc("release_refresh", { ...key(hash), leaseId: lease(leaseId) }); check(result === null); },
    async revoke(hash: string, now: number, expected?: { version: number; leaseId: string }) { check(integer(now)); const result = await rpc("revoke", { ...key(hash), now: now, expectedVersion: expected === undefined ? null : version(expected.version), leaseId: expected === undefined ? null : lease(expected.leaseId) }); if (result === null) return null; session(result); check(result.hash === hash && result.revokedAt !== null); return result; },
    async finishLogout(hash: string, expectedVersion: number) { return boolean("finish_logout", { ...key(hash), expectedVersion: version(expectedVersion) }); },
    async sweep(limit: number) {
      check(integer(limit) && limit > 0 && limit <= 128);
      // Each individually bounded ciphertext may reach 240 kB; keep the batch bounded too.
      const result = await rpc("sweep", { limit }, (limit + 1) * MAX_RESPONSE);
      exact(result, ["pending", "pruned"]); check(Array.isArray(result.pending) && result.pending.length <= limit && integer(result.pruned) && result.pruned <= limit);
      const seen = new Set<string>();
      for (const row of result.pending) { session(row); check(row.revokedAt !== null && row.logoutPending && row.tokens !== null && !seen.has(row.hash)); seen.add(row.hash); }
      return result as { pending: VaultSession[]; pruned: number };
    },
  });
}
