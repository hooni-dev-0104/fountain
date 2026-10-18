/** Organization identity is independent of any workspace membership or role. */
import {createIdentityAuth} from './identity-profile.ts';
import type {IdentityAuthConfig} from './identity-profile.ts';
import {parseRealmSessionCookie} from './session-auth.ts';
export {AuthError} from './session-auth.ts';
export type {IdentityProfile, IdentitySessionVault as OrganizationSessionVault, IdentitySessionContext as OrganizationPrivateSessionContext} from './identity-profile.ts';
type Config = Omit<IdentityAuthConfig, 'setupClaim' | 'confirmSetupEnabled'>;
export function parseOrganizationSessionCookie(header?:string|null):string|null{return parseRealmSessionCookie('fountain_organization_session',header);}
export function createOrganizationAuth(config:Config){
 const {login,session,authorize,logout,maintain}=createIdentityAuth(config,{mode:'organization',cookieName:'fountain_organization_session',keyPurpose:'fountain-organization-auth-token-vault',tokenPurpose:'fountain-organization-auth-tokens'});
 return Object.freeze({login,session,authorize,logout,maintain});
}
