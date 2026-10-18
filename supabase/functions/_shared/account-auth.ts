/** Account identity carries no workspace membership; every child is revalidated. */
import {createIdentityAuth} from './identity-profile.ts';
import type {IdentityAuthConfig} from './identity-profile.ts';
import {parseRealmSessionCookie} from './session-auth.ts';
export {AuthError} from './session-auth.ts';
export type {IdentityProfile, IdentitySessionVault as AccountSessionVault, IdentitySessionContext as AccountPrivateSessionContext} from './identity-profile.ts';
export function parseAccountSessionCookie(header?:string|null):string|null{return parseRealmSessionCookie('fountain_account_session',header);}
export function createAccountAuth(config:IdentityAuthConfig){return createIdentityAuth(config,{mode:'account',cookieName:'fountain_account_session',keyPurpose:'fountain-account-auth-token-vault',tokenPurpose:'fountain-account-auth-tokens'});}
