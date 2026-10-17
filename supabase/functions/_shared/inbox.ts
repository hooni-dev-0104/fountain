/** Current verification-expiry derivation and private per-member receipts.
 * No historical event queue, background job, email or external side effect. */
import {Access,get,is_object,require,truth} from './access.ts';
import type {Entity} from './access.ts';
import type {CoreStore} from './core.ts';
import {IncrementalSHA256} from './storage.ts';
import {scheduleDatetime} from './scheduler.ts';
import {DatabaseVerification} from './database-verification.ts';
import {inboxStoreReader} from './verification-index.ts';

const digest=(value:unknown):string=>{const hash=new IncrementalSHA256();hash.update(new TextEncoder().encode(JSON.stringify(value)));return hash.hex();};
export function inboxQuery(query:URLSearchParams|Entity):{filter:string;limit:number;offset:number}{
  const values:Record<string,string>={filter:'all',limit:'50',offset:'0'};
  require(query instanceof URLSearchParams||is_object(query),'Invalid inbox query');
  const pairs=query instanceof URLSearchParams?[...query.entries()]:Object.entries(query).map(([key,value])=>{require(Array.isArray(value)&&value.length===1,'Invalid inbox query');return[key,value[0]];});
  const seen=new Set<string>();
  for(const [key,value]of pairs){require(['filter','limit','offset'].includes(key)&&!seen.has(key)&&typeof value==='string','Invalid inbox query');seen.add(key);values[key]=value;}
  require(['all','unread','archived'].includes(values.filter),'Invalid inbox filter');
  for(const [key,min,max]of [['limit',1,100],['offset',0,1000000]] as const){require(/^(0|[1-9][0-9]{0,6})$/.test(values[key]),'Invalid inbox '+key);const value=Number(values[key]);require(value>=min&&value<=max,'Invalid inbox '+key);}
  return{filter:values.filter,limit:Number(values.limit),offset:Number(values.offset)};
}
export class Inbox{
  private store:CoreStore;private access:Access;private clock:()=>number;
  constructor(store:CoreStore,access:Access,clock:()=>number=Date.now){this.store=store;this.access=access;this.clock=clock;}
  candidates():Entity[]{
    if(!this.access.active)return[];
    const source=inboxStoreReader(this.store),access=new Access(source,this.access.principal);
    // The private index omits unrelated page, database and row bodies.
    const pages=source.list('page');this.store.list('member');
    const receipts=new Map(this.store.list('inbox_receipt').map(record=>[record.id,record])),now=BigInt(Math.floor(this.clock()))*1000n,found:Array<{expiry:bigint;item:Entity}>=[];
    for(const page of pages){
      if(!Access.verification_id(page.id)||truth(get(page,'archived'))||truth(get(page,'deleted'))||truth(get(page,'deleted_at'))||!access.can('page',page))continue;
      const value=access.project_verification(page);if(!value||!value.owners.includes(this.access.member_id)||value.expires_at===null)continue;
      const expiry=scheduleDatetime(value.expires_at,'expires_at');if(expiry>now)continue;
      const cycle=get(page.verification,'cycle_revision');if(cycle!==null&&(!Number.isSafeInteger(cycle)||cycle<0))continue;
      const id=digest([page.id,value.verified_at,value.expires_at,cycle,Access.verification_owners(page)]),receipt=receipts.get(digest([this.access.member_id,id])),valid=receipt?.member_id===this.access.member_id&&receipt?.notification_id===id;
      found.push({expiry,item:{id,type:'verification.expired',page_id:page.id,title:typeof page.title==='string'?page.title:'',icon:typeof page.icon==='string'?page.icon:null,verified_at:value.verified_at,expires_at:value.expires_at,read:!!valid&&receipt.read===true,archived:!!valid&&receipt.archived===true}});
    }
    const databaseVerification=new DatabaseVerification(source,access);
    for(const row of source.list('row')){
      if(!Access.verification_id(row.id)||['archived','deleted','deleted_at'].some(key=>truth(get(row,key)))||!access.can('row',row))continue;
      const database=source.get('database',row.database_id);
      if(!database||['archived','deleted','deleted_at'].some(key=>truth(get(database,key)))||!access.can('database',database))continue;
      const value=databaseVerification.public_verification(database,row);
      if(!value.owners.includes(access.member_id)||value.verified_at===null||value.expires_at===null)continue;
      const expiry=scheduleDatetime(value.expires_at,'expires_at');if(expiry>now)continue;
      const cycle=databaseVerification.event_cycle(database,row);
      if(!Array.isArray(cycle)||cycle.length!==2||cycle.some(number=>!Number.isSafeInteger(number)||number<0))continue;
      const id=digest(['row',database.id,row.id,value.verified_at,value.expires_at,cycle,databaseVerification.raw_owners(database,row)]),receipt=receipts.get(digest([access.member_id,id])),valid=receipt?.member_id===access.member_id&&receipt?.notification_id===id;
      const titleProperty=database.properties.find((prop:Entity)=>prop.type==='title')?.id,title=get(row.properties,titleProperty,'');
      found.push({expiry,item:{id,type:'verification.expired',resource_type:'row',database_id:database.id,row_id:row.id,title:typeof title==='string'?title:'',icon:typeof database.icon==='string'?database.icon:null,verified_at:value.verified_at,expires_at:value.expires_at,read:!!valid&&receipt.read===true,archived:!!valid&&receipt.archived===true}});
    }
    found.sort((a,b)=>a.expiry===b.expiry?(a.item.id<b.item.id?-1:a.item.id>b.item.id?1:0):a.expiry>b.expiry?-1:1);
    return found.map(entry=>entry.item);
  }
  get(query:URLSearchParams|Entity):Entity{
    const options=inboxQuery(query),items=this.candidates(),unread_count=items.filter(item=>!item.read&&!item.archived).length;
    const filtered=items.filter(item=>options.filter==='archived'?item.archived:!item.archived&&(options.filter!=='unread'||!item.read));
    return{items:filtered.slice(options.offset,options.offset+options.limit),unread_count,total:filtered.length,has_more:options.offset+options.limit<filtered.length,offset:options.offset,limit:options.limit};
  }
  patch(id:string,body:unknown):Entity{
    require(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),'Invalid inbox ID');
    require(is_object(body)&&Object.keys(body).length>0&&Object.keys(body).every(key=>['read','archived'].includes(key)&&typeof body[key]==='boolean'),'Invalid inbox fields');
    const original=this.candidates().find(item=>item.id===id);require(original,'Inbox item not found',404);const item={...original,...body};
    this.store.put('inbox_receipt',{id:digest([this.access.member_id,id]),member_id:this.access.member_id,notification_id:id,read:item.read,archived:item.archived});return item;
  }
}
