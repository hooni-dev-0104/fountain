/** Read-only current verification directory over body-free authorized headers. */
import {Access,casefold,get,require,is_object,truth} from './access.ts';
import type {Entity,StoreReader} from './access.ts';
import {DatabaseVerification} from './database-verification.ts';
import {inboxStoreReader} from './verification-index.ts';
import {awareDatetimeMicros} from './datetime.ts';

const WHITE=/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
const fold=(value:string):string=>casefold(value.normalize('NFKC')).replace(WHITE,' ').replace(/^ +| +$/g,'');
// Compare Unicode scalar values, not locale-dependent collation or UTF-16 units.
const compare=(left:string,right:string):number=>{const a=Array.from(left),b=Array.from(right);for(let i=0;i<Math.min(a.length,b.length);i++){const delta=a[i].codePointAt(0)!-b[i].codePointAt(0)!;if(delta)return delta;}return a.length-b.length;};
export function verifiedPagesQuery(query:URLSearchParams|Entity):Entity{
 require(query instanceof URLSearchParams||is_object(query),'Invalid verified pages query');
 const values:Entity={q:'',status:'all',kind:'all',limit:'50',offset:'0'},seen=new Set<string>();
 const pairs=query instanceof URLSearchParams?[...query.entries()]:Object.entries(query).map(([key,value])=>{require(Array.isArray(value)&&value.length===1,'Invalid verified pages query');return[key,value[0]];});
 for(const[key,value]of pairs){require(['q','owner','teamspace','status','kind','limit','offset'].includes(key)&&!seen.has(key)&&typeof value==='string','Invalid verified pages query');seen.add(key);values[key]=value;}
 require(Array.from(values.q).length<=200&&!values.q.includes('\0')&&!/[\uD800-\uDFFF]/u.test(values.q),'Invalid verified pages q');values.q=fold(values.q);
 for(const key of ['owner','teamspace'])if(seen.has(key))require(Access.verification_id(values[key]),'Invalid verified pages '+key);
 require(['all','verified','expired'].includes(values.status),'Invalid verified pages status');require(['all','page','row'].includes(values.kind),'Invalid verified pages kind');
 for(const[key,min,max]of [['limit',1,100],['offset',0,1000000]] as const){require(/^(0|[1-9][0-9]{0,6})$/.test(values[key]),'Invalid verified pages '+key);values[key]=Number(values[key]);require(values[key]>=min&&values[key]<=max,'Invalid verified pages '+key);}
 return values;
}
export class VerifiedPages{
 private store:StoreReader;private access:Access;private clock:()=>number;
 constructor(store:StoreReader,access:Access,clock:()=>number=Date.now){this.store=store;this.access=access;this.clock=clock;}
 candidates():Entity[]{
  if(!this.access.active)return[];
  const source=inboxStoreReader(this.store),members=new Map(source.list('member').map(member=>[member.id,member])),teamspaces=new Map(source.list('teamspace').map(space=>[space.id,space]));
  const access=new Access(source,this.access.principal),now=BigInt(Math.floor(this.clock()))*1000n,pages=source.list('page'),pageMap=new Map(pages.map(page=>[page.id,page]));
  const present=(item:Entity):boolean=>!['archived','deleted','deleted_at'].some(key=>truth(get(item,key)));
  const association=(item:Entity,database=false):Entity|null=>{
   let current=item,links=0,kind=database?'database':'page';const visited=new Set<string>();
   for(;;){const id=get(current,'id'),token=kind+'\0'+id;if(!Access.verification_id(id)||visited.has(token)||!present(current))return null;visited.add(token);
    const parent=get(current,'parent_id');if(parent===null)break;if(links>=64||!Access.verification_id(parent))return null;
    const next=pageMap.get(parent);if(!next)return null;current=next;kind='page';links++;
   }
   const id=get(current,'teamspace_id'),space=Access.verification_id(id)?teamspaces.get(id):null;
   return space&&access.can('teamspace',space)?{id,name:typeof space.name==='string'?space.name:''}:null;
  };
  const make=(item:Entity,kind:string,value:Entity,database:Entity|null=null):Entity|null=>{
   if(value.verified_at===null)return null;const expires=value.expires_at,status=expires!==null&&awareDatetimeMicros(expires,'expires_at')<=now?'expired':'verified';
   const owners=value.owners.filter((id:string)=>members.has(id)).map((id:string)=>{const member=members.get(id)!;return{id,name:typeof member.name==='string'?member.name:''};});
   const target=database??item,title=kind==='page'?get(item,'title',''):get(item.properties,database!.properties.find((p:Entity)=>p.type==='title')?.id,'');
   return{id:item.id,resource_type:kind,title:typeof title==='string'?title:'',icon:typeof target.icon==='string'?target.icon:null,owners,teamspace:association(target,kind==='row'),verification:{status,verified_at:value.verified_at,expires_at:expires},...(kind==='page'?{page_id:item.id}:{database_id:database!.id,row_id:item.id})};
  };
  const found:Entity[]=[];
  for(const page of pages)if(Access.verification_id(page.id)&&present(page)&&access.can('page',page)){const item=make(page,'page',access.project_verification(page));if(item)found.push(item);}
  const verification=new DatabaseVerification(source,access);
  for(const row of source.list('row')){if(!Access.verification_id(row.id)||!present(row)||!access.can('row',row))continue;
   const database=source.get('database',row.database_id);if(!database||!present(database)||!access.can('database',database))continue;
   const value=verification.public_verification(database,row);if(!['verified','expired'].includes(value.status))continue;const item=make(row,'row',value,database);if(item)found.push(item);
  }
  found.sort((a,b)=>compare(fold(a.title),fold(b.title))||compare(a.resource_type,b.resource_type)||compare(a.id,b.id));return found;
 }
 get(query:URLSearchParams|Entity):Entity{
  const options=verifiedPagesQuery(query),items=this.candidates(),owners=new Map<string,Entity>(),teamspaces=new Map<string,Entity>();
  for(const item of items){for(const owner of item.owners)owners.set(owner.id,owner);if(item.teamspace!==null)teamspaces.set(item.teamspace.id,item.teamspace);}
  const sorted=(values:Map<string,Entity>):Entity[]=>[...values.values()].sort((a,b)=>compare(fold(a.name),fold(b.name))||compare(a.id,b.id));
  const filtered=items.filter(item=>(!options.q||fold(item.title).includes(options.q))&&(!Object.hasOwn(options,'owner')||item.owners.some((owner:Entity)=>owner.id===options.owner))&&(!Object.hasOwn(options,'teamspace')||item.teamspace!==null&&item.teamspace.id===options.teamspace)&&(options.kind==='all'||item.resource_type===options.kind)&&(options.status==='all'||item.verification.status===options.status));
  return{items:filtered.slice(options.offset,options.offset+options.limit),total:filtered.length,has_more:options.offset+options.limit<filtered.length,limit:options.limit,offset:options.offset,filters:{owners:sorted(owners),teamspaces:sorted(teamspaces)}};
 }
}
