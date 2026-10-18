/** Workspace policy facade over the shared, server-only session protocol. */
import { createSessionAuth, parseRealmSessionCookie, AuthError } from "./session-auth.ts";
import type { SessionVault as SharedSessionVault, SessionContext } from "./session-auth.ts";
export { AuthError } from "./session-auth.ts";
export type { Ciphertext, VaultSession, AuthResult } from "./session-auth.ts";
import type { AuthResult, VaultSession } from "./session-auth.ts";
export type Profile = {
  workspaceId: string; authSessionActive: boolean;
  member: { id: string; name: string; email: string; role: string; active: boolean };
};
export type SessionVault = SharedSessionVault<Profile>;
export type AuthContext = SessionContext<Profile>;
type Config = {
  supabaseUrl: string; publishableKey: string;
  cryptoKeys: Array<{ id: string; secret: string | Uint8Array }>;
  vault: SessionVault; fetch?: typeof globalThis.fetch; clock?: () => number;
  /** Explicit setup only. SQL independently proves the live Auth session and fixed legacy target. */
  setupClaim?: (input: { nonceHash: string; userId: string; authSessionId: string }) => Promise<unknown>;
  confirmSetupEnabled?: boolean;
};
const string = (value: unknown, max = 65536): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const error = (status: number, code: string, message: string) => new AuthError(status, code, message);
export function parseSessionCookie(header?: string | null): string | null { return parseRealmSessionCookie("fountain_session", header); }
function anonymous(): AuthResult { return { status: 200, body: { enabled: true, required: true, authenticated: false, mode: "accounts", member: null, identity: null, workspace_id: null, cache_binding: null, expires_at: null } }; }
function validateProfile(profile: Profile | null): Profile {
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
export function createAuth(config: Config) {
  const { login, setup, confirmSetup, session, authorize, logout } = createSessionAuth(config, {
    cookieName: "fountain_session", keyPurpose: "fountain-auth-token-vault", tokenPurpose: "fountain-auth-tokens",
    anonymous, validateProfile, publicResult,
  });
  return Object.freeze({ login, setup, confirmSetup, session, authorize, logout });
}
