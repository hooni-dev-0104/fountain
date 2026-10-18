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
 const match=/^\/api\/w\/([A-Za-z0-9_-]{1,160})\/([a-f0-9]{32})\/([^/].*)$/.exec(path);
 if(!match)throw new HttpError(400,'Invalid workspace path','INVALID_WORKSPACE_PATH');
 const rest=match[3],segments=rest.split('/').map(segment=>{
  try{
   let value=decodeURIComponent(segment);
   // Only resource data may be encoded. Prefixes remain literal, and aliases
   // such as %70 or lowercase escapes cannot name a second scoped spelling.
   if(!segment||encodeURIComponent(value)!==segment)throw new Error();
   for(let count=0;count<5;count++){
    if(/[\u0000-\u001f\u007f-\u009f/\\]/.test(value)||value==='.'||value==='..')throw new Error();
    const next=decodeURIComponent(value);if(next===value)return value;value=next;
   }
  }catch{/* Invalid UTF-8, percent escapes and nested hazards fail closed. */}
  throw new HttpError(400,'Invalid workspace path','INVALID_WORKSPACE_PATH');
 });
 if(['w','account','organization'].includes(segments[0]))throw new HttpError(400,'Invalid nested workspace path','INVALID_WORKSPACE_PATH');
 // Keep encoded resource segments intact; domain handlers decode exactly once.
 return{workspaceId:match[1],binding:match[2],path:/^(?:sites|forms)\//.test(rest)?'/'+rest:'/api/'+rest};
}
export function workspaceSession(context:AccountWorkspaceContext){
 const {id,name,email,role}=context.profile.member;
 return{enabled:true,required:true,authenticated:true,mode:'accounts',identity:name,member:{id,name,email,role,active:true},workspace_id:context.profile.workspaceId,cache_binding:context.cacheBinding,expires_at:new Date(context.expiresAt).toISOString(),account_binding:context.accountBinding};
}
