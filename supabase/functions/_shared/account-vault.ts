/** Independent account credential storage; never use a workspace or organization RPC. */
import {createIdentitySessionVault} from './identity-vault.ts';
import type {IdentityVaultConfig} from './identity-vault.ts';
export class AccountVaultError extends Error {
 readonly status=503; readonly code='SESSION_STORAGE_UNAVAILABLE';
 constructor(){super('세션 저장소에 연결할 수 없습니다.');this.name='AccountVaultError';}
}
export function createAccountSessionVault(config:IdentityVaultConfig){return createIdentitySessionVault(config,'fountain_cloud_account_session_vault',()=>new AccountVaultError());}
