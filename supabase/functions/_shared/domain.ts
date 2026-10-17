/** Legacy HTTP contract on Supabase transactions; no Python process or disk. */
import {Access,APIError,clone,get,has,is_object,require,truth} from './access.ts';
import type {Entity} from './access.ts';
import {Authorization} from './authorization.ts';
import type {AuthContext} from './auth.ts';
import {Workspace,text} from './core.ts';
import {Collaboration} from './collaboration.ts';
import {jsonResponse,readJSON} from './http.ts';
import {createTransactions} from './transaction.ts';
import type {CloudStore,StoreProvider} from './store.ts';
import {validate_settings} from './tasks.ts';
import {createSync} from './sync.ts';
import {advancedSearch,validateAdvancedSearchQuery} from './search.ts';

export type DomainResult={status:number;payload:any};
export type DomainRequest={method:string;path:string;parts:string[];body:Entity;query:URLSearchParams;store:CloudStore;access:Access;authority:Authorization;workspace:Workspace};
export type DomainExtension=(request:DomainRequest)=>DomainResult|null;
type Config={provider:StoreProvider;authorize:()=>Promise<AuthContext>;extensions?:DomainExtension[];clock?:()=>number;ai?:(body:Entity,context:AuthContext)=>Promise<Entity>;files?:(request:Request,path:string,context:AuthContext)=>Promise<Response|null>;events?:(request:Request,path:string,context:AuthContext)=>Promise<Response|null>};
const response=(payload:any,status=200):DomainResult=>({status,payload});
function rowPolicy(body:unknown,database:Entity):Entity{
  require(is_object(body)&&Object.keys(body).every(key=>['mode','property_id','edit_assigned','allow_create'].includes(key)),'Invalid row permissions');
  require(['all','assigned'].includes(get(body,'mode','all')),'Invalid row permission mode');
  for(const key of ['edit_assigned','allow_create'])if(has(body,key))require(typeof body[key]==='boolean','Row permission flags must be boolean');
  if(body.mode==='assigned')require(database.properties.some((prop:Entity)=>prop.id===body.property_id&&['person','text','email','multi_select'].includes(prop.type)),'Choose an assignment property');
  return clone(body);
}
function jsonOption(query:URLSearchParams,key:string):any{
  if(!query.has(key))return null;
  try{return JSON.parse(query.get(key)!);}catch{throw new APIError(400,'Invalid '+key+' JSON');}
}
function coreRoute(r:DomainRequest):DomainResult|null{
  const {method,path,parts,body,query,store:s,access:a,authority,workspace:w}=r;
  if(parts.length===4&&parts[0]==='api'&&['pages','databases'].includes(parts[1])&&parts[3]==='permissions'){
    const kind=parts[1]==='pages'?'page':'database',item=a.require_resource(kind,parts[2],method==='PATCH'?4:1);
    require(['GET','PATCH'].includes(method),'Unsupported permissions method',405);
    if(method==='PATCH'){
      if(has(body,'permissions'))item.permissions=a.validate_permissions(body.permissions);
      if(has(body,'row_permissions')&&kind==='database')item.row_permissions=rowPolicy(body.row_permissions,item);
      s.put(kind,item);s.audit(kind+'.permissions.changed',{id:item.id});
    }
    return response({permissions:get(item,'permissions')||{default:'workspace',members:{},groups:{},inherit:truth(get(item,'parent_id'))},row_permissions:get(item,'row_permissions',{}),owner_id:get(item,'owner_id','local'),can_manage:a.can(kind,item,4),members:a.filter_workspace({members:s.list('member')}).members,groups:a.can(kind,item,4)?s.list('group'):[]});
  }
  if(method==='GET'&&path==='/api/health')return response({ok:true});
  if(method==='GET'&&path==='/api/workspace'){
    const snapshot=w.snapshot();snapshot.settings={...snapshot.settings,...s.get('settings','workspace')||{}};return response(snapshot);
  }
  if(method==='POST'&&path==='/api/pages')return response(w.create_page(body),201);
  if(parts.length>=3&&parts[0]==='api'&&parts[1]==='pages'){
    const pageId=parts[2];
    if(parts.length===3){
      if(method==='GET'){const detail=w.detail(pageId);s.audit('page.viewed',{page_id:pageId});return response(detail);}
      if(method==='PATCH')return response(w.update_page(pageId,body));
      if(method==='DELETE')return response(w.update_page(pageId,{archived:true}));
    }
    if(parts.length===4){
      if(parts[3]==='collaboration'&&method==='GET')return response(new Collaboration(s,w).snapshot(pageId,a));
      if(parts[3]==='operations'&&method==='POST')return response(new Collaboration(s,w).apply(pageId,body,a));
      if(parts[3]==='blocks'&&method==='PUT')return response(w.save_blocks(pageId,get(body,'blocks'),get(body,'revision')));
      if(parts[3]==='restore'&&method==='POST')return response(w.update_page(pageId,{archived:false}));
      if(parts[3]==='comments'&&method==='POST')return response(w.create_comment(pageId,body),201);
    }
    if(parts.length===6&&parts[3]==='versions'&&parts[5]==='restore'&&method==='POST'){
      const version=s.get('version',parts[4]);require(version&&version.page_id===pageId,'Version not found',404);
      const page=w.page(pageId);require(!truth(get(page,'archived')),'Page not found',404);require(!truth(get(page,'locked')),'Page is locked',423);w.check_revision(page,get(body,'revision'));
      for(const block of Array.isArray(version.blocks)?version.blocks:[])if(is_object(block)&&truth(get(block,'attachment_id')))authority.attachment(block.attachment_id);
      return response(w.restore_version(pageId,parts[4]));
    }
  }
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='comments'&&method==='PATCH')return response(w.resolve_comment(parts[2],body));
  if(path==='/api/search/advanced'&&method==='GET'){const result=advancedSearch(s,a,query);s.audit('workspace.searched',{mode:'advanced',results:result.results.length,total:result.total});return response(result);}
  if(path==='/api/search'&&method==='GET'){const result=w.search(query.get('q')||'');s.audit('workspace.searched',{results:result.results.length});return response(result);}
  if(path==='/api/databases'&&method==='POST'){
    if(has(body,'row_permissions'))body.row_permissions=rowPolicy(body.row_permissions,{properties:w.validate_properties(get(body,'properties',[]))});
    return response(w.create_database(body),201);
  }
  if(parts.length>=3&&parts[0]==='api'&&parts[1]==='databases'){
    const id=parts[2];
    if(parts.length===3&&method==='GET')return response(w.database_detail(id,jsonOption(query,'filters'),jsonOption(query,'sorts'),row=>a.can('row',row)));
    if(parts.length===3&&method==='PATCH'){
      const database=w.database(id);
      if(has(body,'name'))database.name=text(body.name,'name',500,false);
      if(has(body,'properties')){const properties=w.validate_properties(body.properties);authority.schema_references(database,properties);database.properties=properties;}
      if(has(body,'task_settings')||has(body,'properties'))database.task_settings=validate_settings(get(body,'task_settings',{}),database);
      if(has(body,'views')){require(Array.isArray(body.views)&&body.views.length<=50,'Invalid views');database.views=body.views;}
      return response(s.put('database',database));
    }
    // Automations wrap these three mutations through an extension before this
    // primitive is installed; a configured extension can call this core route.
    if(parts.length===4&&parts[3]==='rows'&&method==='POST')return response(w.create_row(id,body),201);
    if(parts.length===6&&parts[3]==='rows'&&parts[5]==='duplicate'&&method==='POST')return response(w.duplicate_row(id,parts[4],row=>a.can('row',row)),201);
    if(parts.length===5&&parts[3]==='rows'){
      if(method==='PATCH')return response(w.update_row(id,parts[4],body,row=>a.can('row',row,3)));
      if(method==='DELETE')return response(w.delete_row(id,parts[4],row=>a.can('row',row,3)));
    }
  }
  if(path==='/api/export'&&method==='GET'){
    require(!truth(get(s.get('settings','workspace'),'disable_export')),'Workspace export is disabled',403);
    return response(w.export(query.get('format')||'json',query.get('database')||undefined));
  }
  if(path==='/api/import'&&method==='POST')return response(w.import_data(body),201);
  return null;
}
export {coreRoute};
/** The caller owns the staged transaction. Sync operations use this same route
 * authorization and projection rather than invoking an unguarded primitive. */
export function dispatchStaged(s:CloudStore,method:string,path:string,input:Entity,query=new URLSearchParams(),extensions:DomainExtension[]=[]):DomainResult {
  const body=clone(input),access=new Access(s,s.principal),authority=new Authorization(access,{ownerAccounts:'cloud-commit'}),workspace=new Workspace(s,{access});
  authority.prepare(method,path,body);
  const r={method,path,parts:path.replace(/^\/+|\/+$/g,'').split('/'),body,query,store:s,access,authority,workspace};
  let routed:DomainResult|null=null;
  for(const extension of extensions){routed=extension(r);if(routed)break;}
  routed??=coreRoute(r);
  if(!routed)throw new APIError(404,'Route not found');
  const writing=['POST','PATCH','PUT','DELETE'].includes(method);
  if(writing&&(path.endsWith('/permissions')||path.startsWith('/api/members')||path.startsWith('/api/groups')||path.startsWith('/api/teamspaces')||path.startsWith('/api/accounts')||path.startsWith('/scim/v2/')||method==='PATCH'&&path.startsWith('/api/pages/')&&!path.endsWith('/wiki-owner')))s.set_meta('access_revision',s.meta('access_revision',0)+1);
  const payload=authority.project(path,routed.payload),canonical=method==='GET'&&(path==='/api/workspace'||/^\/api\/databases\/[^/]+$/.test(path));
  if(is_object(payload)&&(canonical||path.endsWith('/collaboration')||path.endsWith('/operations')))Object.assign(payload,{workspace_id:s.context.workspaceId,current_member_id:access.member_id,session_binding:s.context.cacheBinding,access_revision:s.meta('access_revision',0),data_revision:s.meta('_entity_revision',0)});
  return {status:routed.status,payload};
}
export function createDomain(config:Config){
  const execute=createTransactions(config);
  return async(request:Request,encodedPath:string,context:AuthContext):Promise<Response>=>{
    const method=request.method==='HEAD'?'GET':request.method,path=decodeURIComponent(encodedPath),query=new URL(request.url).searchParams;
    if(config.files){const response=await config.files(request,encodedPath,context);if(response)return response;}
    if(config.events){const response=await config.events(request,encodedPath,context);if(response)return response;}
    // Reject malformed retrieval filters before opening a database snapshot.
    if(method==='GET'&&path==='/api/search/advanced')validateAdvancedSearchQuery(query);
    const original=['POST','PUT','PATCH','DELETE'].includes(method)?await readJSON(request):{};
    if(method==='POST'&&path==='/api/sync')return jsonResponse(await createSync({...config,dispatch:(s,verb,target,body)=>dispatchStaged(s,verb,target,body,new URLSearchParams(),config.extensions)})(original,context));
    if(method==='POST'&&path==='/api/ai'&&config.ai)return jsonResponse(await config.ai(original,context));
    const result=await execute(context,s=>dispatchStaged(s,method,path,original,query,config.extensions));
    if(method==='GET'&&/^\/(sites|forms)\/[^/]+$/.test(path)&&typeof result.value.payload?._html==='string')return new Response(result.value.payload._html,{status:result.value.status,headers:{'Content-Type':'text/html; charset=utf-8','X-Fountain-Format':'html','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}});
    return jsonResponse(result.value.payload,result.value.status);
  };
}
