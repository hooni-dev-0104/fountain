/** Session-only cloud presence. Domain writes are staged, never committed here.
 * Legacy local/shared-cookie modes intentionally have no cloud equivalent.
 * Peer identity proofs are obtained OUTSIDE pure CloudStore transactions; current
 * member/group/page ACLs are always evaluated inside the pinned snapshot.
 */
import {APIError,Access,clone,get,has,is_object,require,truth,valid_id} from './access.ts';
import type {Entity} from './access.ts';
import type {CoreStore} from './core.ts';
import type {AuthContext} from './auth.ts';
import {canonicalJSON,StoreError,validateContext} from './store.ts';
import type {CloudStore,Selection,StoreContext} from './store.ts';
import {sha256,visible_chars} from './crdt.ts';
export const TTL=15,HEARTBEAT=5,RETENTION=60,MAX_ACTIVE_SESSION=10,MAX_ACTIVE_PAGE=100,MAX_RETAINED_SESSION=200,MAX_RETAINED_PAGE=500;
export const COLORS=['#2563eb','#7c3aed','#db2777','#dc2626','#ea580c','#16a34a','#0891b2','#4f46e5'];
export type PublisherProof={hash:string;cacheBinding:string;member:{id:string;name:string;email:string;role:string;active:boolean}};
export type ProofBundle={requested:ReadonlySet<string>;values:ReadonlyMap<string,PublisherProof>};
type Query={page?:string;origin?:[string,string];now?:number};
export interface PresenceStore extends CoreStore {
 context:StoreContext;principal:Entity;
 presence_lookup?:(query:Query)=>Entity[];presence_cleanup?:(now:number,limit?:number)=>number;
}
type Context={info:Entity;access:Access;page:Entity;document:Entity|null;origin:[string,string]};
export class MissingPublisherProof extends StoreError{
 hashes:string[];
 constructor(hashes:string[]){super(409,'PRESENCE_PROOF_REQUIRED','Presence publisher proof changed');this.hashes=hashes;}
}
export class PresenceService{
 store:PresenceStore;clock:()=>number;proofs:ProofBundle;
 constructor(store:PresenceStore,options:{proofs?:ProofBundle;clock?:()=>number}={}){this.store=store;this.clock=options.clock??(()=>Date.now()/1000);this.proofs=options.proofs??{requested:new Set(),values:new Map()};}
 _now():number{const value=this.clock();require(typeof value==='number'&&Number.isFinite(value),'Invalid presence clock',500);return value;}
 _records(query:Query={}):Entity[]{
  if(this.store.presence_lookup)return this.store.presence_lookup(query);
  return this.store.list('presence').filter(row=>(query.page===undefined||get(row,'page_id')===query.page)&&(query.origin===undefined||get(row,'origin_kind')===query.origin[0]&&get(row,'origin_id')===query.origin[1])&&(query.now===undefined||get(row,'retain_until')>query.now));
 }
 _cleanup(now:number):number{
  if(this.store.presence_cleanup)return this.store.presence_cleanup(now,500);
  const expired=this.store.list('presence').filter(row=>get(row,'retain_until')<=now).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,500);
  for(const row of expired)this.store.delete('presence',row.id);return expired.length;
 }
 _context(page_id:unknown):Context{
  const own=this.store.context,member=this.store.principal;
  require(is_object(own)&&typeof own.sessionHash==='string'&&/^[a-f0-9]{64}$/.test(own.sessionHash)&&typeof own.cacheBinding==='string'&&/^[a-f0-9]{32}$/.test(own.cacheBinding)&&is_object(member)&&member.id===own.memberId,'Authentication required',401);
  const access=new Access(this.store,member);require(access.active,'Authentication required',401);
  const page=access.require_resource('page',page_id,1),document=this.store.get('collaboration',page_id);
  return {info:{workspace_id:own.workspaceId,cache_binding:own.cacheBinding,member},access,page,document,origin:['session',own.sessionHash]};
 }
 static _identity(page_id:string,epoch:string,origin:[string,string],client_id:string,workspace_id:string):string{return sha256(canonicalJSON([workspace_id,page_id,epoch,...origin,client_id]));}
 _publisher(record:Entity):Entity|null{
  if(record.origin_kind!=='session'||typeof record.origin_id!=='string'||!/^[a-f0-9]{64}$/.test(record.origin_id))return null;
  if(record.origin_id===this.store.context.sessionHash)return record.session_binding===this.store.context.cacheBinding?clone(this.store.principal):null;
  if(!this.proofs.requested.has(record.origin_id))throw new MissingPublisherProof([record.origin_id]);
  const proof=this.proofs.values.get(record.origin_id);if(!proof||record.session_binding!==proof.cacheBinding)return null;
  // Do not grant the role recorded by an earlier external RPC. This snapshot's
  // current member and group records remain the authority for page ACLs.
  const member=this.store.get('member',proof.member.id);return member&&get(member,'active',true)===true?member:null;
 }
 static _selection_shape(selection:unknown):void{
  if(selection===null)return;
  require(is_object(selection)&&Object.keys(selection).length===3&&['block_id','anchor','focus'].every(key=>has(selection,key)),'Invalid presence selection');
  require(valid_id(selection.block_id),'Invalid presence block');
  for(const key of ['anchor','focus']){
   const point=selection[key];require(is_object(point)&&Object.keys(point).length===3&&['before','after','offset'].every(field=>has(point,field)),'Invalid presence point');
   require(Number.isSafeInteger(point.offset)&&point.offset>=0,'Invalid presence offset');
   for(const side of ['before','after']){const value=point[side];require(value===null||typeof value==='string'&&Array.from(value).length>0&&Array.from(value).length<=300,'Invalid presence character anchor');}
  }
 }
 static _selection(selection:Entity|null,state:Entity):Entity|null{
  if(selection===null)return null;
  const identity=selection.block_id,block=get(get(state,'blocks',{}),identity);
  if(!truth(block)||truth(get(block,'deleted'))||get(block,'insert')===null)return null;
  const ids=visible_chars(state,identity).map((character:Entity)=>character.id),positions=new Map<string,number>(ids.map((value:string,index:number)=>[value,index])),result:Entity={block_id:identity};
  for(const key of ['anchor','focus']){
   const point=selection[key],before=point.before,after=point.after;
   if([before,after].some(value=>value!==null&&!positions.has(value)))return null;
   const position=before!==null?positions.get(before)!+1:after!==null?positions.get(after)!:point.offset;
   if(position>ids.length||after!==null&&positions.get(after)!<position)return null;
   result[key]={before:position?ids[position-1]:null,after:position<ids.length?ids[position]:null,offset:position};
  }
  return result;
 }
 static _live(record:Entity,now:number):boolean{return !truth(get(record,'left'))&&record.expires_at>now;}
 _retire(record:Entity,now:number):void{if(!truth(get(record,'left'))){record.left=true;record.expires_at=Math.min(record.expires_at,now);record.retain_until=record.expires_at+RETENTION;this.store.put('presence',record);}}
 _snapshot(context:Context,now:number):Entity{
  const {info,access,page,document}=context,epoch=document?document.epoch:null,participants:Entity[]=[];
  for(const record of this._records({page:page.id,now})){
   if(get(record,'epoch')!==epoch){this.store.delete('presence',record.id);continue;}
   if(truth(get(page,'archived'))){this._retire(record,now);continue;}
   if(!PresenceService._live(record,now))continue;
   const publisher=this._publisher(record);
   if(publisher===null||get(publisher,'id')!==record.member_id||!new Access(this.store,publisher).can('page',page)){this._retire(record,now);continue;}
   const name=get(publisher,'name');participants.push({id:record.id,member_id:publisher.id,name:typeof name==='string'?Array.from(name).slice(0,100).join(''):'참여자',color:COLORS[parseInt(record.id.slice(0,8),16)%COLORS.length],client_id:record.client_id,seq:record.seq,selection:PresenceService._selection(get(record,'selection'),document!.state)});
  }
  participants.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return {epoch,workspace_id:info.workspace_id,current_member_id:access.member_id,session_binding:info.cache_binding,participants,ttl:TTL,heartbeat:HEARTBEAT,revision:this.store.meta('_entity_revision',0)};
 }
 snapshot(page_id:unknown):Entity{return this.store.transaction(()=>{const now=this._now(),context=this._context(page_id);this._cleanup(now);return this._snapshot(context,now);});}
 _mutate(page_id:unknown,body:Entity,leaving:boolean):Entity{
  const fields=['session_binding','epoch','client_id','seq',...leaving?[]:['selection']];
  require(is_object(body)&&Object.keys(body).length===fields.length&&fields.every(field=>has(body,field)),'Invalid presence fields');
  require(typeof body.client_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(body.client_id),'Invalid presence client');
  require(Number.isSafeInteger(body.seq)&&body.seq>0,'Invalid presence sequence');
  require(valid_id(body.epoch),'Invalid presence epoch');if(!leaving)PresenceService._selection_shape(body.selection);
  return this.store.transaction(()=>{
   const now=this._now(),context=this._context(page_id),{info,access,page,document,origin}=context;
   require(body.session_binding===info.cache_binding,'Presence belongs to another login',403);require(document!==null&&body.epoch===document.epoch,'Document epoch changed',409);
   require(leaving||!truth(get(page,'archived')),'Restore the page before publishing presence',409);this._cleanup(now);this._snapshot(context,now);
   const identity=PresenceService._identity(page.id,document!.epoch,origin,body.client_id,info.workspace_id);let previous=this.store.get('presence',identity);
   if(previous!==null&&previous.retain_until<=now)previous=null;const ignored=previous!==null&&body.seq<=previous.seq;
   if(!ignored){
    const retained_page=this._records({page:page.id,now}),retained_session=this._records({origin,now});
    if(previous===null)require(retained_page.length<MAX_RETAINED_PAGE&&retained_session.length<MAX_RETAINED_SESSION,'Presence retention capacity reached',429);
    if(!leaving&&!(previous&&PresenceService._live(previous,now)))require(retained_page.filter(row=>PresenceService._live(row,now)).length<MAX_ACTIVE_PAGE&&retained_session.filter(row=>PresenceService._live(row,now)).length<MAX_ACTIVE_SESSION,'Too many active presence clients',429);
    const expires_at=leaving?now:now+TTL;
    previous=this.store.put('presence',{id:identity,page_id:page.id,epoch:document!.epoch,member_id:access.member_id,origin_kind:origin[0],origin_id:origin[1],session_binding:info.cache_binding,client_id:body.client_id,seq:body.seq,left:leaving,expires_at,retain_until:expires_at+RETENTION,selection:leaving?null:PresenceService._selection(body.selection,document!.state)});
   }
   return {...this._snapshot(context,now),ack_seq:previous!.seq,participant_id:identity,ignored};
  });
 }
 update(page_id:unknown,body:Entity):Entity{return this._mutate(page_id,body,false);}
 leave(page_id:unknown,body:Entity):Entity{return this._mutate(page_id,body,true);}
 /** Server-only preparation. Never return these hashes/member IDs to a renderer. */
 prepare(page_id:unknown):{hashes:string[];members:string[];nextExpiry:number|null}{
  const now=this._now(),context=this._context(page_id),hashes=new Set<string>([this.store.context.sessionHash]),members=new Set<string>();let nextExpiry:number|null=null;
  for(const record of this._records({page:context.page.id,now}))if(record.origin_kind==='session'&&record.epoch===context.document?.epoch&&PresenceService._live(record,now)&&typeof record.origin_id==='string'&&/^[a-f0-9]{64}$/.test(record.origin_id)){
   hashes.add(record.origin_id);if(valid_id(record.member_id))members.add(record.member_id);nextExpiry=nextExpiry===null?record.expires_at:Math.min(nextExpiry,record.expires_at);
  }
  require(hashes.size<=500,'Presence proof capacity reached',429);return {hashes:Array.from(hashes).sort(),members:Array.from(members),nextExpiry};
 }
}

export interface PublisherProofProvider{publishers(context:StoreContext,hashes:string[]):Promise<PublisherProof[]>;}
function proofs(hashes:string[],values:PublisherProof[]):ProofBundle{
 const requested=new Set(hashes),map=new Map<string,PublisherProof>();
 require(Array.isArray(values)&&values.length<=hashes.length,'Invalid presence publisher response',503);
 for(const value of values){
  require(is_object(value)&&Object.keys(value).length===3&&['hash','cacheBinding','member'].every(key=>has(value,key))&&requested.has(value.hash)&&!map.has(value.hash)&&typeof value.cacheBinding==='string'&&/^[a-f0-9]{32}$/.test(value.cacheBinding),'Invalid presence publisher response',503);
  const member=value.member;require(is_object(member)&&Object.keys(member).length===5&&['id','name','email','role','active'].every(key=>has(member,key))&&valid_id(member.id)&&typeof member.name==='string'&&typeof member.email==='string'&&['owner','admin','member','guest'].includes(member.role)&&member.active===true,'Invalid presence publisher response',503);map.set(value.hash,clone(value));
 }
 return {requested,values:map};
}
type Executor=<T>(initial:AuthContext,action:(store:CloudStore)=>T,selection?:Selection)=>Promise<{value:T;revision:number}>;
/** The session proof RPC is never called from a pure staged action. A missing
 * new peer or changed final proof retries from fresh authorization, boundedly. */
export function createPresenceAdapter(config:{execute:Executor;proofProvider:PublisherProofProvider;clock?:()=>number;maxRestarts?:number}){
 const clock=config.clock??(()=>Date.now()/1000),rounds=config.maxRestarts??3;require(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=5,'Invalid presence retry limit',500);
 async function run(initial:AuthContext,page_id:string,method:'snapshot'|'update'|'leave',body?:Entity,projector?:(store:CloudStore)=>Entity):Promise<{presence:Entity;snapshot?:Entity}>{
  const selection:Selection={kinds:['presence','group'],ids:{page:[page_id],collaboration:[page_id]}};
  for(let round=0;round<rounds;round++){
   const prepared=await config.execute(initial,store=>new PresenceService(store,{clock}).prepare(page_id),selection);
   const hashes=prepared.value.hashes,scope=validateContext({workspaceId:initial.profile.workspaceId,memberId:initial.profile.member.id,userId:initial.userId,authSessionId:initial.authSessionId,sessionHash:initial.hash,cacheBinding:initial.cacheBinding});
   const before=proofs(hashes,await config.proofProvider.publishers(scope,hashes));
   let applied;
   try{applied=await config.execute(initial,store=>{
    const snapshot=projector?projector(store):undefined,service=new PresenceService(store,{clock,proofs:before});
    const presence=method==='snapshot'?service.snapshot(page_id):method==='update'?service.update(page_id,body!):service.leave(page_id,body!);
    if(snapshot)Object.assign(snapshot,{workspace_id:store.context.workspaceId,current_member_id:store.context.memberId,session_binding:store.context.cacheBinding,access_revision:store.meta('access_revision',0),data_revision:store.meta('_entity_revision',0)});
    return {presence,...snapshot?{snapshot}:{},prepared:service.prepare(page_id)};
   },{...selection,ids:{...selection.ids,member:prepared.value.members}});}
   catch(error){if(error instanceof MissingPublisherProof)continue;throw error;}
   const after=proofs(hashes,await config.proofProvider.publishers(scope,hashes));
   const encode=(bundle:ProofBundle)=>canonicalJSON(Array.from(bundle.values).sort(([a],[b])=>a<b?-1:a>b?1:0));
   if(encode(before)!==encode(after)||applied.value.prepared.nextExpiry!==null&&clock()>=applied.value.prepared.nextExpiry)continue;
   const presence=applied.value.presence;presence.revision=applied.revision;
   return {presence,...applied.value.snapshot?{snapshot:applied.value.snapshot}:{}};
  }
  throw new StoreError(503,'PRESENCE_CHANGED','Presence changed while verifying current sessions');
 }
 return Object.freeze({snapshot:async(initial:AuthContext,page_id:string)=>(await run(initial,page_id,'snapshot')).presence,update:async(initial:AuthContext,page_id:string,body:Entity)=>(await run(initial,page_id,'update',body)).presence,leave:async(initial:AuthContext,page_id:string,body:Entity)=>(await run(initial,page_id,'leave',body)).presence,snapshotWithDocument:async(initial:AuthContext,page_id:string,projector:(store:CloudStore)=>Entity)=>run(initial,page_id,'snapshot',undefined,projector)});
}

/** Service key stays in this closure. No JWT/ciphertext/raw provider error output. */
export function createPublisherProofProvider(config:{supabaseUrl:string;serviceKey:string;fetch?:typeof globalThis.fetch}):PublisherProofProvider{
 let origin:string;try{const url=new URL(config.supabaseUrl);require((url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&typeof config.serviceKey==='string'&&config.serviceKey.length>0&&config.serviceKey.length<=4096&&!/[\r\n\x00]/.test(config.serviceKey),'Presence storage unavailable',503);origin=url.origin;}catch{throw new StoreError(503,'PRESENCE_STORAGE_UNAVAILABLE','Presence storage unavailable');}
 const headers:Record<string,string>={apikey:config.serviceKey,'Content-Type':'application/json'};
 if(config.serviceKey.startsWith('sb_secret_'))require(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey),'Presence storage unavailable',503);
 else{try{const parts=config.serviceKey.split('.');require(parts.length===3&&parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)),'Presence storage unavailable',503);require(JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-parts[1].length%4)%4))).role==='service_role','Presence storage unavailable',503);headers.Authorization='Bearer '+config.serviceKey;}catch{throw new StoreError(503,'PRESENCE_STORAGE_UNAVAILABLE','Presence storage unavailable');}}
 return Object.freeze({async publishers(context:StoreContext,hashes:string[]):Promise<PublisherProof[]>{
  validateContext(context);require(Array.isArray(hashes)&&hashes.length<=500&&new Set(hashes).size===hashes.length&&hashes.every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)),'Invalid presence publisher hashes');
  try{
   const response=await(config.fetch??fetch)(origin+'/rest/v1/rpc/fountain_cloud_presence_publishers',{method:'POST',redirect:'error',headers:{...headers},signal:AbortSignal.timeout(8000),body:JSON.stringify({p_context:context,p_hashes:hashes})});
   if(!response.ok||response.redirected){await response.body?.cancel();if([401,403].includes(response.status))throw new APIError(401,'Authentication required');throw new Error();}
   const reader=response.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let total=0;
   try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>1024*1024)throw new Error();chunks.push(next.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return Array.from(proofs(hashes,result).values.values());
  }catch(error){if(error instanceof APIError&&error.status===401)throw error;throw new StoreError(503,'PRESENCE_STORAGE_UNAVAILABLE','Presence storage unavailable');}
 }});
}
