/** Administration capabilities never widen ordinary page/database ACLs. */
import {Access,ROLES,get,is_object,require} from './access.ts';
import type {Entity,StoreReader} from './access.ts';
import {canonical,sha256,compareText} from './crdt.ts';

export const CATALOG = [
 ['audit.read','감사 로그 조회'],['analytics.read','워크스페이스 분석 조회'],
 ['members.read','멤버 조회'],['members.manage','멤버 관리'],
 ['groups.read','그룹 조회'],['groups.membership.manage','기존 그룹 멤버 관리'],
 ['content.search.read','관리자 콘텐츠 검색'],['content.search.export','관리자 검색 CSV 내보내기'],
 ['content.permissions.manage','콘텐츠 공유 권한 관리'],['content.publish.manage','콘텐츠 게시 해제'],
] as const;
export const ACTIONS = new Set<string>(CATALOG.map(([action])=>action));
const MEMBERSHIP_ACTIONS=new Set(['members.read','members.manage','groups.read','groups.membership.manage']);
export const GENERATION_PREFIX='_admin_member_generation_v1:';
const UUID=/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\s\S])/;
type AdminReader=StoreReader&{admin_member_generations?:()=>Entity};
type AdminStore=AdminReader&{put(kind:string,value:Entity):Entity;delete(kind:string,id:string):void;set_meta(key:string,value:any):any;transaction<T>(action:()=>T):T;allocate_id?:(kind:string)=>string;audit?:(action:string,details:Entity,user?:string)=>Entity};
function writable(reader:AdminReader):AdminStore{const store=reader as Partial<AdminStore>,methods=['put','delete','set_meta','transaction'] as const;require(methods.every(key=>typeof store[key]==='function'),'Administrative storage is read-only',503);return reader as AdminStore;}
export function generationKey(memberId:unknown):string{require(Access.verification_id(memberId),'Invalid admin member id');return GENERATION_PREFIX+sha256(memberId);}
function nonce(store:AdminStore,kind:string):string{return store.allocate_id?store.allocate_id(kind):crypto.randomUUID().replaceAll('-','');}
export function invalidateMember(store:AdminStore,memberId:unknown):boolean{const key=generationKey(memberId);if(store.meta(key)===null)return false;store.set_meta(key,nonce(store,'admin_generation'));return true;}
export {generationKey as generation_key,invalidateMember as invalidate_member};
const plain=(value:unknown,limit:number,empty=true):value is string=>typeof value==='string'&&Array.from(value).length<=limit&&(empty||/[^ \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(value))&&!/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
function actionsValid(value:unknown):value is string[]{return Array.isArray(value)&&value.length>=1&&value.length<=ACTIONS.size&&value.every(action=>typeof action==='string'&&ACTIONS.has(action))&&new Set(value).size===value.length&&(!value.includes('members.manage')||value.includes('members.read'))&&(!value.includes('groups.membership.manage')||value.includes('groups.read'))&&(!['content.search.export','content.permissions.manage','content.publish.manage'].some(action=>value.includes(action))||value.includes('content.search.read'));}
const eligible=(member:unknown):member is Entity=>is_object(member)&&Access.verification_id(get(member,'id'))&&get(member,'active',true)===true&&['member','admin'].includes(get(member,'role'));
function validRole(role:unknown):role is Entity{return is_object(role)&&Access.verification_id(get(role,'id'))&&get(role,'version')===1&&plain(get(role,'name'),100,false)&&plain(get(role,'description'),1000)&&actionsValid(get(role,'actions'))&&typeof get(role,'nonce')==='string'&&UUID.test(role.nonce)&&Object.keys(role).every(key=>['id','version','name','description','actions','nonce','created_at','updated_at'].includes(key));}

export class AdminAuthority{
 readonly store:AdminReader;
 readonly access:Access;
 constructor(store:AdminReader,access:Access){this.store=store;this.access=access;}
 private current():Entity|null{
  if(!this.access.active||!Access.verification_id(this.access.member_id))return null;
  const member=this.store.get('member',this.access.member_id);
  return member&&get(member,'id')===this.access.member_id&&get(member,'active',true)===true&&ROLES.has(get(member,'role'))&&get(member,'role')===get(this.access.principal,'role')?member:null;
 }
 private owner():boolean{return this.current()?.role==='owner';}
 private roles():Map<string,Entity>{return new Map(this.store.list('admin_role').filter(validRole).map(role=>[role.id,role]));}
 private assignment(memberId:string,roles=this.roles(),generations:Entity|null=null):string[]{
  const value=this.store.get('admin_assignment',memberId);
  if(!value||get(value,'id')!==memberId||get(value,'member_id')!==memberId||Object.keys(value).some(key=>!['id','member_id','role_ids','role_nonces','generation','created_at','updated_at'].includes(key))||typeof get(value,'generation')!=='string'||!UUID.test(value.generation)||value.generation!==(generations?get(generations,generationKey(memberId)):this.store.meta(generationKey(memberId))))return [];
  const ids=get(value,'role_ids');if(!Array.isArray(ids)||ids.length>32||!ids.every(Access.verification_id)||new Set(ids).size!==ids.length)return [];
  const nonces=get(value,'role_nonces');if(!is_object(nonces)||Object.keys(nonces).length!==ids.length||!ids.every(id=>Object.hasOwn(nonces,id))||!Object.values(nonces).every(nonce=>typeof nonce==='string'&&UUID.test(nonce)))return [];
  return ids.filter(id=>roles.has(id)&&get(nonces,id)===roles.get(id)!.nonce);
 }
 actions():string[]{
  const member=this.current();if(!member)return [];if(member.role==='owner')return CATALOG.map(([action])=>action);if(!eligible(member))return [];
  const actions=new Set<string>(member.role==='admin'?MEMBERSHIP_ACTIONS:[]),roles=this.roles();
  for(const id of this.assignment(member.id,roles))for(const action of roles.get(id)!.actions)actions.add(action);
  return CATALOG.map(([action])=>action).filter(action=>actions.has(action));
 }
 allows(action:unknown):boolean{return typeof action==='string'&&ACTIONS.has(action)&&this.actions().includes(action);}
 require_action(action:unknown):void{require(this.allows(action),'Administrative action permission required',403);}
 private generations():Entity|null{if(!this.store.admin_member_generations)return null;const value=this.store.admin_member_generations();require(is_object(value),'Invalid administrative state',503);return value;}
 private revision(generations:Entity|null=this.generations()):string{
  const members=this.store.list('member').map(member=>({...Object.fromEntries(['id','name','email','role','created_at','updated_at'].map(key=>[key,typeof get(member,key)==='string'?member[key]:''])),active:get(member,'active',true)===true})),assignments=this.store.list('admin_assignment'),ids=new Set<string>();
  for(const assignment of assignments)if(Access.verification_id(get(assignment,'member_id')))ids.add(assignment.member_id);
  const byId=(a:Entity,b:Entity)=>compareText(a.id,b.id);
  const state={roles:this.store.list('admin_role').sort(byId),assignments:assignments.sort(byId),members:members.sort(byId),generations:[...ids].sort(compareText).map(id=>[id,generations?get(generations,generationKey(id)):this.store.meta(generationKey(id))])};
  const numbers=(value:any):void=>{if(typeof value==='number')require(Number.isSafeInteger(value),'Invalid administrative state',503);else if(Array.isArray(value))value.forEach(numbers);else if(is_object(value))Object.values(value).forEach(numbers);};numbers(state);return sha256(canonical(state));
 }
 overview():Entity{
  require(this.owner(),'Workspace owner permission required',403);
  const roles=this.roles(),generations=this.generations();this.store.list('admin_assignment');const members=this.store.list('member').filter(eligible).sort((a,b)=>compareText(a.id,b.id)),assignments=[];
  for(const member of members){const ids=this.assignment(member.id,roles,generations);if(ids.length)assignments.push({member_id:member.id,role_ids:ids.toSorted(compareText)});}
  return {catalog:CATALOG.map(([id,label])=>({id,label})),roles:[...roles].sort(([a],[b])=>compareText(a,b)).map(([,role])=>({id:role.id,name:role.name,description:role.description,actions:role.actions})),assignments,eligible_members:members.map(member=>Object.fromEntries(['id','name','email','role'].map(key=>[key,typeof get(member,key)==='string'?member[key]:'']))),revision:this.revision(generations)};
 }
 private checkRevision(body:Entity):void{const value=get(body,'revision');require(typeof value==='string'&&value.length===64&&/^[0-9a-f]{64}$/.test(value),'Invalid admin revision');require(value===this.revision(),'Administrative state changed; reload and retry',409);}
 private changed(store:AdminStore,action:string,details:Entity):void{const revision=store.meta('access_revision',0);require(Number.isSafeInteger(revision)&&revision>=0&&revision<Number.MAX_SAFE_INTEGER,'Invalid access revision',503);store.set_meta('access_revision',revision+1);store.audit?.(action,details,this.access.member_id);}
 route(method:string,path:string,body:unknown,query:URLSearchParams|Entity):Entity{
  require(query instanceof URLSearchParams?!query.toString():is_object(query)&&!Object.keys(query).length,'Invalid admin query');require(is_object(body),'Invalid admin body');
  if(path==='/api/admin/self'){require(method==='GET','Unsupported admin method',405);require(!Object.keys(body).length,'Invalid admin body');require(this.current()!==null,'Active member required',403);return {actions:this.actions(),can_manage_roles:this.owner()};}
  const rolesRoute=path==='/api/admin/roles',roleMatch=/^\/api\/admin\/roles\/([^/]+)$/.exec(path),assignmentMatch=/^\/api\/admin\/assignments\/([^/]+)$/.exec(path);
  require(rolesRoute||roleMatch||assignmentMatch,'Admin route not found',404);const allowed=rolesRoute?['GET','POST']:roleMatch?['PATCH','DELETE']:['PUT'];require(allowed.includes(method),'Unsupported admin method',405);require(this.owner(),'Workspace owner permission required',403);
  if(method==='GET'){require(!Object.keys(body).length,'Invalid admin body');return this.overview();}
  const fields=['POST','PATCH'].includes(method)?['revision','name','description','actions']:assignmentMatch?['revision','role_ids']:['revision'];require(Object.keys(body).every(key=>fields.includes(key))&&Object.hasOwn(body,'revision'),'Invalid admin fields');
  const store=writable(this.store);
  return store.transaction(()=>{
   this.checkRevision(body);let createdId:string|null=null;
   if(rolesRoute||roleMatch){
    let identity=roleMatch?roleMatch[1]:null,previous:Entity|null=null;
    if(identity!==null){require(Access.verification_id(identity),'Invalid admin role id');previous=this.store.get('admin_role',identity);require(previous!==null,'Admin role not found',404);}
    if(method==='DELETE'){
     store.delete('admin_role',identity!);
     this.changed(store,'admin.role.delete',{role_id:identity});
    }else{
     require(method!=='PATCH'||Object.keys(body).some(key=>key!=='revision'),'Provide admin role fields');if(previous)require(validRole(previous),'Invalid admin role state',409);
     const role:Entity={...(previous??{})};for(const key of ['name','description','actions'])if(Object.hasOwn(body,key))role[key]=body[key];if(!Object.hasOwn(role,'description'))role.description='';
     require(plain(get(role,'name'),100,false),'Invalid admin role name');require(plain(get(role,'description'),1000),'Invalid admin role description');require(actionsValid(get(role,'actions')),'Invalid admin role actions');role.actions=CATALOG.map(([action])=>action).filter(action=>role.actions.includes(action));
     if(!previous){require(this.store.list('admin_role').length<100,'Admin role limit reached',409);identity=nonce(store,'admin_role');require(this.store.get('admin_role',identity)===null,'Admin role id collision',409);Object.assign(role,{id:identity,version:1,nonce:nonce(store,'admin_role_nonce')});createdId=identity;}
     store.put('admin_role',role);this.changed(store,previous?'admin.role.update':'admin.role.create',{role_id:identity});
    }
   }else{
    const identity=assignmentMatch![1];require(Access.verification_id(identity),'Invalid admin member id');require(eligible(this.store.get('member',identity)),'Admin role member is not eligible');const ids=get(body,'role_ids');require(Array.isArray(ids)&&ids.length<=32&&ids.every(Access.verification_id)&&new Set(ids).size===ids.length,'Invalid admin role ids');const roles=this.roles();require(ids.every(value=>roles.has(value)),'Admin role not found');const previous=this.store.get('admin_assignment',identity);
    if(ids.length){const key=generationKey(identity);let generation=this.store.meta(key);if(typeof generation!=='string'||!UUID.test(generation)){generation=nonce(store,'admin_generation');store.set_meta(key,generation);}store.put('admin_assignment',{id:identity,member_id:identity,role_ids:ids.toSorted(compareText),role_nonces:Object.fromEntries(ids.map(id=>[id,roles.get(id)!.nonce])),generation});}else if(previous)store.delete('admin_assignment',identity);
    if(ids.length||previous)this.changed(store,'admin.assignment.update',{member_id:identity,role_ids:ids.toSorted(compareText)});
   }
   const result=this.overview();if(createdId!==null)result.created_role_id=createdId;return result;
  });
 }
}
