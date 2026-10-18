/** Strict wire recognition. A scoped spelling is never retried as legacy. */
import {HttpError} from './http.ts';
import type {AuthContext} from './auth.ts';
export const WORKSPACE_ID=/^[A-Za-z0-9_-]{1,160}$/;
export const WORKSPACE_BINDING=/^[a-f0-9]{32}$/;
export type AccountWorkspaceContext=AuthContext&{accountBinding:string;parentHash:string};
export type WorkspaceRoute={workspaceId:string;binding:string;path:string};
export function accountNamespace(path:string):boolean{
 let decoded=path;try{for(let i=0;i<5;i++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}}catch{throw new HttpError(400,'Invalid request path');}
 if(decoded==='/api/account'||decoded.startsWith('/api/account/')){if(decoded!==path)throw new HttpError(400,'Invalid account path','INVALID_ACCOUNT_PATH');return true;}return false;
}
export function workspaceRoute(path:string):WorkspaceRoute|null{
 let decoded=path;try{for(let i=0;i<5;i++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}}catch{throw new HttpError(400,'Invalid request path');}
 if(decoded!=='/api/w'&&!decoded.startsWith('/api/w/'))return null;
 if(decoded!==path)throw new HttpError(400,'Invalid workspace path','INVALID_WORKSPACE_PATH');
 const match=/^\/api\/w\/([A-Za-z0-9_-]{1,160})\/([a-f0-9]{32})\/([^/].*)$/.exec(path);
 if(!match||match[3].endsWith('/')||match[3].split('/').some(x=>!x))throw new HttpError(400,'Invalid workspace path','INVALID_WORKSPACE_PATH');
 const rest=match[3];if(/^(?:w|account|organization)(?:\/|$)/.test(rest))throw new HttpError(400,'Invalid nested workspace path','INVALID_WORKSPACE_PATH');
 return{workspaceId:match[1],binding:match[2],path:/^(?:sites|forms)\//.test(rest)?'/'+rest:'/api/'+rest};
}
export function workspaceSession(context:AccountWorkspaceContext){
 const {id,name,email,role}=context.profile.member;
 return{enabled:true,required:true,authenticated:true,mode:'accounts',identity:name,member:{id,name,email,role,active:true},workspace_id:context.profile.workspaceId,cache_binding:context.cacheBinding,expires_at:new Date(context.expiresAt).toISOString(),account_binding:context.accountBinding};
}
