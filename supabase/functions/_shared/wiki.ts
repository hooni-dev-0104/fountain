/** Wiki membership and knowledge ownership are private domain state, never ACL grants. */
import {Access,casefold,get,has,is_object,require,truth} from './access.ts';
import type {Entity} from './access.ts';
import type {CoreStore} from './core.ts';
import {compareText} from './crdt.ts';
const PROTECTED=new Set(['is_wiki','wiki_owner','knowledge_owner','wiki_page']);
export function protectFields(body:Entity):void{require(!Object.keys(body).some(key=>PROTECTED.has(key)),'Use the wiki endpoint');}
const active=(page:Entity|null):page is Entity=>!!page&&!['archived','deleted','deleted_at'].some(key=>truth(get(page,key)));
export function ancestry(store:CoreStore,page:Entity):{valid:boolean;root:Entity|null}{
 if(!active(page))return{valid:false,root:null};
 if(page.is_wiki===true)return{valid:get(page,'parent_id')===null,root:null};
 const visited=new Set([page.id]);let parent=get(page,'parent_id');
 while(parent!==null){
  if(!Access.verification_id(parent)||visited.has(parent))return{valid:false,root:null};visited.add(parent);const ancestor=store.get('page',parent);
  if(!active(ancestor))return{valid:false,root:null};
  if(ancestor.is_wiki===true)return get(ancestor,'parent_id')===null?{valid:true,root:ancestor}:{valid:false,root:null};parent=get(ancestor,'parent_id');
 }
 return{valid:true,root:null};
}
export function stampCreated(store:CoreStore,page:Entity,actor:string):void{
 if(ancestry(store,page).root){require(Access.verification_id(actor),'Wiki creator is unavailable',409);store.put('wiki_page',{id:page.id,page_id:page.id,owner_id:actor});}
}
export function guardMove(page:Entity,parent:unknown):void{require(!(page.is_wiki===true&&parent!==null),'Wiki roots must remain standalone',409);}
const integer=(value:unknown):boolean=>Number.isSafeInteger(value)&&Number(value)>=0;
const scalar=(value:unknown,fallback:any=null):any=>typeof value==='string'?value:fallback;
export class Wiki{
 store:CoreStore;access:Access;constructor(store:CoreStore,access:Access){this.store=store;this.access=access;}
 batch():void{this.store.list('page');this.store.list('member');this.store.list('wiki_page');}
 page(id:string,level=1):Entity{const page=this.access.require_resource('page',id,level);require(active(page),'Wiki page not found',404);return page;}
 ownerId(page:Entity):string|null{const record=this.store.get('wiki_page',page.id),id=record===null?get(page,'owner_id'):record.page_id===page.id?get(record,'owner_id'):null;return this.access.verification_member(id,page,false)?id:null;}
 publicMember(id:unknown,page:Entity):Entity|null{if(!this.access.verification_member(id,page))return null;return{id,name:scalar(this.store.get('member',id)!.name,'')};}
 current(page:Entity):Entity|null{const value=ancestry(this.store,page);require(value.valid,'Wiki page not found',404);return value.root;}
 revision(page:Entity,body:Entity):number{require(integer(body.revision),'A page revision is required');const revision=get(page,'revision',0);require(integer(revision)&&revision<Number.MAX_SAFE_INTEGER&&body.revision===revision,'Page changed. Reload before saving.',409);require(!truth(get(page,'locked')),'Page is locked',423);return revision;}
 ownerView(id:string):Entity{
  this.batch();const page=this.page(id),root=this.current(page),editable=this.access.can('page',page,3);
  if(root===null)return{in_wiki:false,wiki:null,owner:null,members:[],revision:get(page,'revision',0),can_manage:false,can_verify:editable};
  const owner=this.ownerId(page),members=this.store.list('member').map(member=>this.publicMember(member.id,page)).filter((value):value is Entity=>value!==null);members.sort((a,b)=>compareText(casefold(a.name),casefold(b.name))||compareText(a.id,b.id));
  return{in_wiki:true,wiki:this.access.can('page',root)?{id:root.id,title:scalar(root.title,'')}:null,owner:this.publicMember(owner,page),members,revision:get(page,'revision',0),can_manage:editable,can_verify:editable&&owner===this.access.member_id};
 }
 changeOwner(id:string,body:Entity):Entity{
  require(is_object(body)&&Object.keys(body).length===2&&has(body,'owner_id')&&has(body,'revision')&&Access.verification_id(body.owner_id),'Invalid wiki owner fields');
  this.batch();const page=this.page(id,3);require(this.current(page)!==null,'Wiki page not found',404);const revision=this.revision(page,body);require(this.access.verification_member(body.owner_id,page),'Wiki owner not found',404);
  const valid=this.access.project_verification(page);if(valid&&valid.verified_at!==null)page.verification={...page.verification,owners:[body.owner_id],owner:body.owner_id};
  page.revision=revision+1;this.store.put('page',page);this.store.put('wiki_page',{id,page_id:id,owner_id:body.owner_id});this.store.audit('wiki.owner.updated',{page_id:id});return this.ownerView(id);
 }
 convert(method:string,id:string,body:Entity):Entity{
  require(is_object(body)&&Object.keys(body).length===1&&has(body,'revision'),'Invalid wiki fields');this.batch();const page=this.page(id,4),revision=this.revision(page,body);
  if(method==='POST'){
   require(get(page,'parent_id')===null,'Wiki roots must be standalone',409);require(page.is_wiki!==true,'Page is already a wiki',409);
   for(const candidate of this.store.list('page')){
    if(candidate.is_wiki!==true||candidate.id===id)continue;const seen=new Set();let parent=get(candidate,'parent_id');
    while(Access.verification_id(parent)&&!seen.has(parent)){require(parent!==id,'Nested wikis are not allowed',409);seen.add(parent);const ancestor=this.store.get('page',parent);if(!ancestor)break;parent=get(ancestor,'parent_id');}
   }page.is_wiki=true;page.parent_id=null;
  }else{require(page.is_wiki===true,'Wiki page not found',404);page.is_wiki=false;}
  page.revision=revision+1;this.store.put('page',page);this.store.audit('wiki.updated',{page_id:id});return{wiki:{id,title:scalar(page.title,''),revision:page.revision},is_wiki:page.is_wiki};
 }
 view(id:string,query:URLSearchParams|Entity):Entity{
  require(query instanceof URLSearchParams||is_object(query),'Invalid wiki query');
  const values:Entity={view:'home',q:'',limit:'50',offset:'0'},seen=new Set<string>(),pairs=query instanceof URLSearchParams?[...query.entries()]:Object.entries(query).map(([key,value])=>{require(Array.isArray(value)&&value.length===1,'Invalid wiki query');return[key,value[0]];});
  for(const [key,value]of pairs){require(['view','q','limit','offset'].includes(key)&&!seen.has(key)&&typeof value==='string','Invalid wiki query');seen.add(key);values[key]=value;}
  require(['home','all','owned'].includes(values.view)&&Array.from(values.q).length<=200,'Invalid wiki query');for(const [key,low,high]of [['limit',1,100],['offset',0,1000000]] as const){require(/^(0|[1-9][0-9]{0,6})$/.test(values[key])&&Number(values[key])>=low&&Number(values[key])<=high,'Invalid wiki '+key);values[key]=Number(values[key]);}
  this.batch();const root=this.page(id);require(root.is_wiki===true&&get(root,'parent_id')===null,'Wiki page not found',404);const items:Entity[]=[];
  for(const page of this.store.list('page')){
   const current=ancestry(this.store,page);if(!current.valid||!current.root||current.root.id!==id||!this.access.can('page',page))continue;const owner=this.ownerId(page);if(values.view==='owned'&&owner!==this.access.member_id)continue;
   const title=scalar(page.title,'');if(!casefold(title).includes(casefold(values.q)))continue;const parent=get(page,'parent_id'),parentPage=Access.verification_id(parent)?this.store.get('page',parent):null,editable=this.access.can('page',page,3);
   items.push({id:page.id,title,icon:scalar(page.icon),parent_id:parentPage&&this.access.can('page',parentPage)?parent:null,owner:this.publicMember(owner,page),verification:has(page,'verification')?this.access.project_verification(page):null,created_at:scalar(page.created_at),updated_at:scalar(page.updated_at),revision:get(page,'revision',0),can_edit:editable,can_verify:editable&&owner===this.access.member_id});
  }
  items.sort((a,b)=>compareText(casefold(a.title),casefold(b.title))||compareText(a.id,b.id));const offset=values.offset,limit=values.limit;
  return{wiki:{id,title:scalar(root.title,''),revision:get(root,'revision',0)},view:values.view,items:items.slice(offset,offset+limit),total:items.length,has_more:offset+limit<items.length,offset,limit,can_manage:this.access.can('page',root,4)};
 }
 guardVerify(page:Entity,owners:string[]|null=null):boolean{this.batch();if(this.current(page)===null)return false;const owner=this.ownerId(page);require(owner===this.access.member_id,'Only the wiki page owner can verify',403);if(owners!==null)require(owners.length===1&&owners[0]===owner,'Wiki verification requires its knowledge owner');return true;}
 route(method:string,id:string,kind:string,body:Entity,query:URLSearchParams|Entity):Entity{
  const empty=query instanceof URLSearchParams?!query.toString():!Object.keys(query).length;
  if(kind==='wiki'){require(['GET','POST','DELETE'].includes(method),'Unsupported wiki method',405);if(method==='GET')return this.view(id,query);require(empty,'Invalid wiki query');return this.convert(method,id,body);}
  require(['GET','PATCH'].includes(method),'Unsupported wiki owner method',405);require(empty,'Invalid wiki query');return method==='GET'?this.ownerView(id):this.changeOwner(id,body);
 }
}
