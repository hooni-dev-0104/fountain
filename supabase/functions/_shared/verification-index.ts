/** Private body-free Inbox source. Never pass projected records to a writer. */
import {APIError,clone,has,is_object,valid_id,type Entity,type StoreReader} from './access.ts';
import {pageHeaderReader} from './page-headers.ts';
export const VERIFICATION_INDEX_META_KEY='database_verification_rows_v1';
export const DATABASE_INDEX_FIELDS=Object.freeze(['id','name','title','icon','parent_id','owner_id','teamspace_id','permissions','row_permissions','archived','deleted','deleted_at','created_at','updated_at']);
export const ROW_INDEX_FIELDS=Object.freeze(['id','database_id','owner_id','permissions','archived','deleted','deleted_at','created_at','updated_at','verification_cycle']);
export const DESCRIPTOR_INDEX_FIELDS=Object.freeze(['id','name','type','generation','initial_default','limit','default','owner_property_id']);
export const STAMP_INDEX_FIELDS=Object.freeze(['generation','verified_by','verified_at','expires_at']);
export type VerificationIndex={databases:Entity[];rows:Entity[]};
const invalid=():never=>{throw new APIError(503,'Workspace database verification index is unavailable');};
const pick=(source:Entity,fields:readonly string[]):Entity=>Object.fromEntries(fields.filter(key=>has(source,key)).map(key=>[key,clone(source[key])]));
const keysOnly=(source:Entity,fields:readonly string[]):boolean=>Object.keys(source).every(key=>fields.includes(key));
const positive=(value:unknown):boolean=>Number.isSafeInteger(value)&&(value as number)>0;
/** A malformed pairing is unavailable, never guessed by property name/order. */
export function projectVerificationDatabase(database:Entity):Entity|null{
 if(!is_object(database)||!valid_id(database.id)||!Array.isArray(database.properties))return invalid();
 const properties=database.properties;if(properties.some(p=>!is_object(p)||!valid_id(p.id)||typeof p.type!=='string'))return invalid();
 if(new Set(properties.map(p=>p.id)).size!==properties.length)return invalid();
 const owners=properties.filter(p=>p.type==='owner'),verifications=properties.filter(p=>p.type==='verification');
 if(owners.length>1||verifications.length>1)return invalid();
 if(!owners.length||!verifications.length)return null;
 const owner=owners[0],verification=verifications[0];
 if(!positive(owner.generation)||!['created_by','none'].includes(owner.initial_default)||!['created_by','none'].includes(owner.default)||!['one','unlimited'].includes(owner.limit)||!positive(verification.generation)||verification.owner_property_id!==owner.id)return invalid();
 const title=properties.find(p=>p.type==='title'),assignment=is_object(database.row_permissions)&&database.row_permissions.mode==='assigned'?database.row_permissions.property_id:null;
 const selected=properties.filter(p=>p===owner||p===verification||p===title||p.id===assignment);
 return {...pick(database,DATABASE_INDEX_FIELDS),properties:selected.map(p=>pick(p,DESCRIPTOR_INDEX_FIELDS))};
}
export function verificationPropertyKeys(database:Entity):string[]{
 const owner=database.properties.find((p:Entity)=>p.type==='owner'),title=database.properties.find((p:Entity)=>p.type==='title');
 const assignment=is_object(database.row_permissions)&&database.row_permissions.mode==='assigned'?database.row_permissions.property_id:null;
 return [...new Set([owner?.id,title?.id,assignment].filter(valid_id))];
}
export function projectVerificationRow(row:Entity,database:Entity):Entity|null{
 if(!is_object(row)||!valid_id(row.id)||row.database_id!==database.id)return invalid();
 if(!has(row,'verification'))return null;
 if(!is_object(row.properties))return invalid();
 const result=pick(row,ROW_INDEX_FIELDS),owner=database.properties.find((p:Entity)=>p.type==='owner');
 result.properties=pick(row.properties,verificationPropertyKeys(database));
 if(has(row,'_owner_generations'))result._owner_generations=is_object(row._owner_generations)?pick(row._owner_generations,[owner.id]):clone(row._owner_generations);
 result.verification=is_object(row.verification)?pick(row.verification,STAMP_INDEX_FIELDS):clone(row.verification);
 return result;
}
/** Local/model projection; the cloud kernel never falls back to raw records. */
export function projectVerificationIndex(databases:Entity[],rows:Entity[]):VerificationIndex{
 const selected=databases.map(projectVerificationDatabase).filter((db):db is Entity=>db!==null),byId=new Map(selected.map(db=>[db.id,db]));
 if(byId.size!==selected.length)return invalid();
 const result:Entity[]=[];const ids=new Set<string>();
 for(const row of rows){const db=byId.get(row.database_id);if(!db||!has(row,'verification'))continue;const projected=projectVerificationRow(row,db)!;if(ids.has(projected.id))return invalid();ids.add(projected.id);result.push(projected);}
 return {databases:selected,rows:result};
}
export function validateVerificationIndex(value:unknown):VerificationIndex{
 if(!is_object(value)||!keysOnly(value,['databases','rows'])||!Array.isArray(value.databases)||!Array.isArray(value.rows))return invalid();
 const databases:Entity[]=[],byId=new Map<string,Entity>();
 for(const db of value.databases){
  if(!is_object(db)||!keysOnly(db,[...DATABASE_INDEX_FIELDS,'properties'])||byId.has(db.id)||!Array.isArray(db.properties)||db.properties.some((p:unknown)=>!is_object(p)||!keysOnly(p,DESCRIPTOR_INDEX_FIELDS)))return invalid();
  const projected=projectVerificationDatabase(db);if(!projected||projected.properties.length!==db.properties.length)return invalid();databases.push(projected);byId.set(projected.id,projected);
 }
 const rows:Entity[]=[],ids=new Set<string>();
 for(const row of value.rows){
  if(!is_object(row)||!keysOnly(row,[...ROW_INDEX_FIELDS,'properties','_owner_generations','verification'])||ids.has(row.id)||!has(row,'verification'))return invalid();
  const db=byId.get(row.database_id);if(!db||!is_object(row.properties)||!keysOnly(row.properties,verificationPropertyKeys(db)))return invalid();
  const owner=db.properties.find((p:Entity)=>p.type==='owner');
  if(is_object(row._owner_generations)&&!keysOnly(row._owner_generations,[owner.id])||is_object(row.verification)&&!keysOnly(row.verification,STAMP_INDEX_FIELDS))return invalid();
  const projected=projectVerificationRow(row,db);if(!projected)return invalid();rows.push(projected);ids.add(projected.id);
 }
 return {databases,rows};
}
/** Refuse schema projection changes that need property values omitted by SQL. */
export function verificationProjectionSignature(database:Entity):string{
 return JSON.stringify([verificationPropertyKeys(database).sort(),database.properties.map((p:Entity)=>[p.id,p.type]).sort((a:any,b:any)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)]);
}
const adapted=Symbol('inboxStoreReader');
export function inboxStoreReader(store:StoreReader):StoreReader{
 if((store as any)[adapted]===true)return store;
 const source=store as StoreReader&{database_verification_rows?:()=>VerificationIndex;readonly database_verification_generation?:number;requestTime?:string};
 const pages=pageHeaderReader(store);let generation:number|undefined,cached:{databases:Map<string,Entity>;rows:Map<string,Entity>}|null=null;
 const index=()=>{
  const before=source.database_verification_generation,stable=Number.isSafeInteger(before)&&typeof source.database_verification_rows==='function';
  if(stable&&cached&&generation===before)return cached;
  const value=typeof source.database_verification_rows==='function'?validateVerificationIndex(source.database_verification_rows()):projectVerificationIndex(store.list('database'),store.list('row'));
  const result={databases:new Map(value.databases.map(db=>[db.id,db])),rows:new Map(value.rows.map(row=>[row.id,row]))};
  if(stable&&source.database_verification_generation===before){generation=before;cached=result;}return result;
 };
 return Object.freeze({[adapted]:true,
  get requestTime(){void source.database_verification_generation;return source.requestTime;},
  get(kind:string,id:unknown):Entity|null{if(kind!=='database'&&kind!=='row')return pages.get(kind,id);if(!valid_id(id)){void source.database_verification_generation;return null;}const values=index();return clone((kind==='database'?values.databases:values.rows).get(id)??null);},
  list(kind:string):Entity[]{if(kind!=='database'&&kind!=='row')return pages.list(kind);const values=index();return Array.from((kind==='database'?values.databases:values.rows).values(),clone);},
  meta(key:string,fallback:unknown=null):any{return store.meta(key,fallback);}
 });
}
