/** Identity-only facade policy shared by independent cookie realms. */
import { AuthError, createSessionAuth } from "./session-auth.ts";
import type { AuthResult, SessionAuthConfig, SessionContext, SessionVault, VaultSession } from "./session-auth.ts";
export { AuthError } from "./session-auth.ts";
export type IdentityProfile = { authSessionActive: boolean; user: { id: string; email: string; name: string } };
export interface IdentitySessionVault extends SessionVault<IdentityProfile> {
  sweep(limit: number): Promise<{ pending: VaultSession[]; pruned: number }>;
}
export type IdentitySessionContext = SessionContext<IdentityProfile>;
export type IdentityAuthConfig = Omit<SessionAuthConfig<IdentityProfile>, "vault"> & { vault: IdentitySessionVault };
const fail = (status: number, code: string, message: string) => new AuthError(status, code, message);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const displayName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && [...value].length <= 1000 && new TextEncoder().encode(value).length <= 4000;
function anonymous(mode: string): AuthResult { return { status: 200, body: { enabled: true, authenticated: false, mode, identity: null, cache_binding: null, expires_at: null } }; }
function validateProfile(profile: IdentityProfile | null, userId: string): IdentityProfile {
  if (!profile || profile.authSessionActive !== true) throw fail(401, "AUTH_REJECTED", "인증 정보를 확인해주세요.");
  if (!object(profile) || Object.keys(profile).length !== 2 || !object(profile.user) || Object.keys(profile.user).length !== 3 || profile.user.id !== userId || !text(profile.user.email, 320) || !displayName(profile.user.name)) throw fail(503, "SESSION_STORAGE_UNAVAILABLE", "세션 저장소에 연결할 수 없습니다.");
  const { id, email, name } = profile.user;
  return { authSessionActive: true, user: { id, email, name } };
}
function publicResult(mode: string, row: VaultSession, profile: IdentityProfile): AuthResult {
  const { name, email } = profile.user;
  return { status: 200, body: { enabled: true, authenticated: true, mode, identity: { name, email }, cache_binding: row.cacheBinding, expires_at: new Date(row.expiresAt).toISOString() } };
}
export function createIdentityAuth(config: IdentityAuthConfig, realm: {mode: string; cookieName: string; keyPurpose: string; tokenPurpose: string}) {
  const engine = createSessionAuth(config, { ...realm, anonymous: () => anonymous(realm.mode), validateProfile, publicResult: (row, profile) => publicResult(realm.mode, row, profile) });
  async function maintain(limit = 2): Promise<{ pruned: number; attempted: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw fail(400, "INVALID_LIMIT", "정리 범위를 확인해주세요.");
    let result: Awaited<ReturnType<IdentitySessionVault["sweep"]>>;
    try { result = await config.vault.sweep(limit); }
    catch { throw fail(503, "SESSION_STORAGE_UNAVAILABLE", "세션 저장소에 연결할 수 없습니다."); }
    // Sweep only selects revoked retry-only rows. The engine rereads before I/O.
    if (!object(result) || Object.keys(result).length !== 2 || !Number.isSafeInteger(result.pruned) || result.pruned < 0 || result.pruned > limit || !Array.isArray(result.pending) || result.pending.length > limit || new Set(result.pending.map(row => row?.hash)).size !== result.pending.length || result.pending.some(row => !row || !/^[a-f0-9]{64}$/.test(row.hash) || row.revokedAt === null || !row.logoutPending || !row.tokens)) throw fail(503, "SESSION_STORAGE_UNAVAILABLE", "세션 저장소에 연결할 수 없습니다.");
    for (const row of result.pending) await engine.retryLogoutByHash(row.hash);
    return { pruned: result.pruned, attempted: result.pending.length };
  }
  const { login, setup, session, authorize, logout } = engine;
  return Object.freeze({ login, setup, session, authorize, logout, maintain });
}
