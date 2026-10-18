/** Organization vault keeps its established RPC and error class. */
import {createIdentitySessionVault} from './identity-vault.ts';
import type {IdentityVaultConfig} from './identity-vault.ts';
export class OrganizationVaultError extends Error {
 readonly status=503; readonly code='SESSION_STORAGE_UNAVAILABLE';
 constructor(){super('세션 저장소에 연결할 수 없습니다.');this.name='OrganizationVaultError';}
}
export function createOrganizationSessionVault(config:IdentityVaultConfig){return createIdentitySessionVault(config,'fountain_cloud_organization_session_vault',()=>new OrganizationVaultError());}
