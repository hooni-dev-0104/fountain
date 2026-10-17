/** Dependency-free SQLite 3 bulk writer for the exact portable Fountain schema.
 * Format authority: https://sqlite.org/fileformat.html (B-trees/records/overflow).
 * Two passes over a stable snapshot; append-only output in bounded page writes.
 * The sink is PRIVATE STAGING: publish only after close succeeds. abort discards
 * partial output if the second pass differs, fails, or loses authorization.
 */
import {IncrementalSHA256} from './storage.ts';
import {canonicalJSON} from './store.ts';

export const VAULT_COLUMNS={"retention_records":["id","data","created_at","updated_at"],"retention_entities":["record_id","kind","id","data","created_at","updated_at","generation","ownership"],"retention_provenance":["record_id","kind","id","generation","creator_id","creator_cause","editor_id","edited_at","editor_cause","manager_id","manager_at"],"retention_attachment_refs":["record_id","attachment_id","storage_kind","physical_id","offset","size","sha256"],"retention_identity_reservations":["kind","id","record_id","generation"],"retention_links":["record_id","kind","id","data"]} as const;
export type VaultTable=keyof typeof VAULT_COLUMNS;
export type BackupVaultRow=Record<string,string|number|null>;
export const VAULT_DEFINITIONS={"retention_records":"CREATE TABLE retention_records (id TEXT NOT NULL PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)","retention_entities":"CREATE TABLE retention_entities (record_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,generation TEXT,ownership TEXT NOT NULL,PRIMARY KEY(record_id,kind,id))","retention_provenance":"CREATE TABLE retention_provenance (record_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,creator_id TEXT,creator_cause TEXT NOT NULL,editor_id TEXT,edited_at TEXT,editor_cause TEXT NOT NULL,manager_id TEXT,manager_at TEXT,PRIMARY KEY(record_id,kind,id))","retention_attachment_refs":"CREATE TABLE retention_attachment_refs (record_id TEXT NOT NULL,attachment_id TEXT NOT NULL,storage_kind TEXT NOT NULL,physical_id TEXT NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(record_id,attachment_id,storage_kind,physical_id,offset))","retention_identity_reservations":"CREATE TABLE retention_identity_reservations (kind TEXT NOT NULL,id TEXT NOT NULL,record_id TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(kind,id))","retention_links":"CREATE TABLE retention_links (record_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(record_id,kind,id))"} as const;
export const SQLITE_DEFINITIONS={
  ...VAULT_DEFINITIONS,
  entities:'CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id))',
  meta:'CREATE TABLE meta (key TEXT PRIMARY KEY, data TEXT NOT NULL)',
  attachment_chunks:'CREATE TABLE attachment_chunks (attachment_id TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(attachment_id,offset))',
  content_provenance:"CREATE TABLE content_provenance (kind TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,creator_id TEXT,creator_cause TEXT,\n            editor_id TEXT,edited_at TEXT,editor_cause TEXT,manager_id TEXT,manager_at TEXT,PRIMARY KEY(kind,id))",
} as const;
export const SQLITE_PRIVATE_KINDS=new Set(['session','clipboard','upload','presence']);
const OMIT_META=new Set(['local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved']);
const CHUNK_SIZE=4*1024*1024,MAX_ATTACHMENT=5_000_000_000,SLICE=65536;
type Rows<T>=()=>AsyncIterable<T>|Iterable<T>;
export type BackupBlob={size:number;open:()=>AsyncIterable<Uint8Array>|Iterable<Uint8Array>};
export type BackupEntity={kind:string;id:string;data:string|Record<string,unknown>;created_at:string;updated_at:string};
export type BackupMeta={key:string;data:string|unknown};
export type BackupChunk={attachment_id:string;offset:number;data:Uint8Array|BackupBlob};
export const PROVENANCE_COLUMNS=['kind','id','generation','creator_id','creator_cause','editor_id','edited_at','editor_cause','manager_id','manager_at'] as const;
export type BackupProvenance={kind:string;id:string;generation:string;creator_id:string|null;creator_cause:string;editor_id:string|null;edited_at:string|null;editor_cause:string;manager_id:string|null;manager_at:string|null};
export function validateBackupProvenance(value:unknown):asserts value is BackupProvenance{
  check(value!==null&&typeof value==='object'&&!Array.isArray(value));const row=value as Record<string,unknown>;
  check(Object.keys(row).length===10&&PROVENANCE_COLUMNS.every(key=>Object.hasOwn(row,key)));
  check(['page','database','row'].includes(row.kind as string));
  for(const key of ['id','creator_id','editor_id','manager_id']){const item=row[key];if(item===null&&key!=='id')continue;validText(item);check(Array.from(item).length>0&&Array.from(item).length<=160);}
  check(typeof row.generation==='string'&&/^[a-f0-9]{32}$/.test(row.generation));
  for(const key of ['creator_cause','editor_cause'])check(['human','automation','import','public_form','system','unknown'].includes(row[key] as string));
  const date=(item:unknown)=>{if(item===null)return true;if(typeof item!=='string')return false;const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(item);if(!m)return false;const [y,mo,d,h,mi,se]=m.slice(1,7).map(Number),v=new Date(0);v.setUTCFullYear(y,mo-1,d);v.setUTCHours(h,mi,se,0);if(y<1||mo<1||mo>12||d<1||v.getUTCFullYear()!==y||v.getUTCMonth()+1!==mo||v.getUTCDate()!==d||h>23||mi>59||se>59||Number(m[10]??0)>23||Number(m[11]??0)>59)return false;const offset=(Number(m[10]??0)*60+Number(m[11]??0))*60000*(m[9]==='-'?-1:1);const year=new Date(v.getTime()-offset).getUTCFullYear();return year>=1&&year<=9999;};
  check(date(row.edited_at)&&date(row.manager_at)&&(row.editor_id!==null||row.edited_at===null)&&((row.manager_id===null)===(row.manager_at===null)));
}
export type SQLiteBackupSource={entities:Rows<BackupEntity>;meta:Rows<BackupMeta>;chunks:Rows<BackupChunk>;provenance?:Rows<BackupProvenance>;vault?:Record<VaultTable,Rows<BackupVaultRow>>};
export type SQLiteBackupSummary={pageSize:number;pages:number;byteLength:number;sourceSHA256:string;counts:{entities:number;meta:number;attachment_chunks:number;content_provenance?:number;retention_records?:number;retention_entities?:number;retention_provenance?:number;retention_attachment_refs?:number;retention_identity_reservations?:number;retention_links?:number};entityKinds:Record<string,number>};
export type SQLiteBackupSink={write(bytes:Uint8Array):void|Promise<void>;close?(summary:SQLiteBackupSummary):void|Promise<void>;abort?(error:SQLiteBackupError):void|Promise<void>};
export type SQLiteBackupOptions={pageSize?:4096|65536;maxPlanBytes?:number};
export class SQLiteBackupError extends Error{constructor(message:string){super(message);this.name='SQLiteBackupError';}}
function check(condition:unknown,message='Invalid portable backup source'):asserts condition{if(!condition)throw new SQLiteBackupError(message);}
const encoder=new TextEncoder();
function validText(value:unknown):asserts value is string{
  check(typeof value==='string'&&!value.includes('\u0000')&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
}
function lengthUTF8(value:string):number{let count=0;for(const char of value){const cp=char.codePointAt(0)!;count+=cp<128?1:cp<2048?2:cp<65536?3:4;}return count;}
function* textBytes(value:string):Generator<Uint8Array>{for(let start=0;start<value.length;){let end=Math.min(start+16384,value.length);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;yield encoder.encode(value.slice(start,end));start=end;}}
function compareText(a:string,b:string):number{const x=a[Symbol.iterator](),y=b[Symbol.iterator]();for(;;){const p=x.next(),q=y.next();if(p.done||q.done)return p.done?(q.done?0:-1):1;const delta=p.value.codePointAt(0)!-q.value.codePointAt(0)!;if(delta)return delta;}}
type Key=Array<string|number>;
function compareKey(a:Key,b:Key):number{for(let i=0;i<a.length;i++){const difference=typeof a[i]==='number'?(a[i] as number)-(b[i] as number):compareText(a[i] as string,b[i] as string);if(difference)return difference;}return 0;}
function varint(value:number|bigint):Uint8Array{
  let number=BigInt(value);check(number>=0n&&number<=0xffffffffffffffffn,'SQLite integer limit exceeded');
  if(number>0x00ffffffffffffffn){const bytes=new Uint8Array(9);bytes[8]=Number(number&255n);number>>=8n;for(let i=7;i>=0;i--){bytes[i]=128|Number(number&127n);number>>=7n;}return bytes;}
  const bytes=[Number(number&127n)];while((number>>=7n)>0n)bytes.push(128|Number(number&127n));return Uint8Array.from(bytes.reverse());
}
function join(parts:Uint8Array[]):Uint8Array{const value=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){value.set(part,offset);offset+=part.length;}return value;}
function integer(value:number|bigint):{serial:number;bytes:Uint8Array}{
  check(typeof value==='bigint'||Number.isSafeInteger(value));const n=BigInt(value);check(n>=-0x8000000000000000n&&n<=0x7fffffffffffffffn,'SQLite integer limit exceeded');
  if(n===0n||n===1n)return {serial:n===0n?8:9,bytes:new Uint8Array()};
  const lengths=[1,2,3,4,6,8],index=lengths.findIndex(size=>n>=-(1n<<BigInt(size*8-1))&&n<(1n<<BigInt(size*8-1))),size=lengths[index],bytes=new Uint8Array(size);let unsigned=BigInt.asUintN(size*8,n);for(let i=size-1;i>=0;i--){bytes[i]=Number(unsigned&255n);unsigned>>=8n;}return {serial:index+1,bytes};
}
type Value=string|number|bigint|null|Uint8Array|BackupBlob;
type RecordSource={header:Uint8Array;parts:Array<string|Uint8Array|BackupBlob>;size:number};
function record(values:Value[]):RecordSource{
  const serials:Uint8Array[]=[],parts:Array<string|Uint8Array|BackupBlob>=[];let size=0;
  for(const value of values){
    if(value===null){serials.push(varint(0));continue;}
    if(typeof value==='number'||typeof value==='bigint'){const item=integer(value);serials.push(varint(item.serial));parts.push(item.bytes);size+=item.bytes.length;continue;}
    if(typeof value==='string'){validText(value);const bytes=lengthUTF8(value);serials.push(varint(bytes*2+13));parts.push(value);size+=bytes;continue;}
    const bytes=value instanceof Uint8Array?value.length:value.size;check(Number.isSafeInteger(bytes)&&bytes>=0);serials.push(varint(bytes*2+12));parts.push(value);size+=bytes;
  }
  const types=join(serials);let headerSize=types.length+1;while(varint(headerSize).length+types.length!==headerSize)headerSize=varint(headerSize).length+types.length;
  const header=join([varint(headerSize),types]);check(size+header.length<=16*1024*1024+8192,'SQLite record exceeds the bounded export limit');return {header,parts,size:size+header.length};
}
async function* recordBytes(value:RecordSource,onBlob?:(bytes:Uint8Array)=>void):AsyncGenerator<Uint8Array>{
  yield value.header;
  for(let index=0;index<value.parts.length;index++){const part=value.parts[index],observe=index===value.parts.length-1?onBlob:undefined;if(typeof part==='string'){yield* textBytes(part);continue;}if(part instanceof Uint8Array){for(let i=0;i<part.length;i+=SLICE){const slice=part.subarray(i,i+SLICE);observe?.(slice);yield slice;}continue;}
    check(part&&typeof part.open==='function');let length=0;for await(const bytes of part.open()){check(bytes instanceof Uint8Array&&bytes.length<=CHUNK_SIZE,'Invalid bounded BLOB stream');length+=bytes.length;check(length<=part.size,'BLOB size changed');for(let i=0;i<bytes.length;i+=SLICE){const slice=bytes.subarray(i,i+SLICE);observe?.(slice);yield slice;}}check(length===part.size,'BLOB is missing or truncated');
  }
}
function smallRecord(value:RecordSource):Uint8Array{return join([value.header,...value.parts.map(part=>{check(typeof part==='string'||part instanceof Uint8Array);return typeof part==='string'?encoder.encode(part):part;})]);}
function jsonText(value:unknown):string{
  if(typeof value==='string'){validText(value);try{JSON.parse(value);}catch{throw new SQLiteBackupError('Invalid JSON in portable backup');}return value;}
  let result:string;try{result=JSON.stringify(value,(_,item)=>{check(typeof item!=='undefined'&&typeof item!=='function'&&typeof item!=='symbol'&&typeof item!=='bigint'&&(typeof item!=='number'||Number.isFinite(item)),'Invalid JSON in portable backup');return item;});}catch{throw new SQLiteBackupError('Invalid JSON in portable backup');}validText(result);return result;
}
type Manifest={size:number;sha256:string;offset:number;hash:IncrementalSHA256};
type NormalizedRow={key:Key;record:RecordSource;attachment?:Manifest;kind?:string};
type NormalizedSnapshot={manifests:Map<string,Manifest>;kinds:Record<string,number>;resources:Set<string>;live:Set<string>;liveAttachments:Map<string,string>;vault:VaultValidationState};
async function* entities(source:SQLiteBackupSource,state:NormalizedSnapshot):AsyncGenerator<NormalizedRow>{
  for await(const row of source.entities()){
    check(row&&typeof row==='object'&&Object.keys(row).length===5&&['kind','id','data','created_at','updated_at'].every(key=>Object.hasOwn(row,key)));validText(row.kind);if(SQLITE_PRIVATE_KINDS.has(row.kind)||row.kind==='attachment_chunk')continue;
    check(/^[a-z][a-z0-9_]{0,63}$/.test(row.kind));validText(row.id);check(Array.from(row.id).length>0&&Array.from(row.id).length<=160);validText(row.created_at);validText(row.updated_at);
    const data=jsonText(row.data);let parsed:any;try{parsed=JSON.parse(data);}catch{throw new SQLiteBackupError('Invalid JSON entity');}check(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&parsed.id===row.id,'Entity identity mismatch');
    if(row.kind==='attachment'&&parsed.storage==='chunks'){check(Number.isSafeInteger(parsed.size)&&parsed.size>=0&&parsed.size<=MAX_ATTACHMENT&&typeof parsed.sha256==='string'&&/^[a-f0-9]{64}$/.test(parsed.sha256),'Invalid finalized attachment manifest');check(!state.manifests.has(row.id),'Duplicate attachment');state.manifests.set(row.id,{size:parsed.size,sha256:parsed.sha256,offset:0,hash:new IncrementalSHA256()});}
    state.live.add(JSON.stringify([row.kind,row.id]));if(['attachment','attachment_cloud','attachment_chunk'].includes(row.kind))state.liveAttachments.set(JSON.stringify([row.kind,row.id]),attachmentFingerprint(row.kind,parsed,row.created_at,row.updated_at));
    if(['page','database','row'].includes(row.kind))state.resources.add(JSON.stringify([row.kind,row.id]));
    Object.defineProperty(state.kinds,row.kind,{value:(Object.hasOwn(state.kinds,row.kind)?state.kinds[row.kind]:0)+1,writable:true,enumerable:true,configurable:true});yield {key:[row.kind,row.id],record:record([row.kind,row.id,data,row.created_at,row.updated_at]),kind:row.kind};
  }
}
async function* metadata(source:SQLiteBackupSource):AsyncGenerator<NormalizedRow>{for await(const row of source.meta()){check(row&&typeof row==='object'&&Object.keys(row).length===2&&['key','data'].every(key=>Object.hasOwn(row,key)));validText(row.key);if(OMIT_META.has(row.key))continue;check(Array.from(row.key).length>0&&Array.from(row.key).length<=160);yield {key:[row.key],record:record([row.key,jsonText(row.data)])};}}
async function* chunks(source:SQLiteBackupSource,state:NormalizedSnapshot):AsyncGenerator<NormalizedRow>{
  for await(const row of source.chunks()){
    check(row&&typeof row==='object'&&Object.keys(row).length===3&&['attachment_id','offset','data'].every(key=>Object.hasOwn(row,key)));validText(row.attachment_id);const manifest=state.manifests.get(row.attachment_id);if(!manifest)continue;
    check(Number.isSafeInteger(row.offset)&&row.offset===manifest.offset&&row.offset<manifest.size,'Attachment chunks are noncontiguous');const size=row.data instanceof Uint8Array?row.data.length:row.data?.size;
    check(size===Math.min(CHUNK_SIZE,manifest.size-row.offset),'Attachment chunk has incorrect size');manifest.offset+=size;
    const pin=state.vault.pins.get(JSON.stringify([row.attachment_id,row.offset]));let data=row.data;
    if(pin){check(pin.size===size,'Retained chunk pin size mismatch');if(data instanceof Uint8Array){const hash=new IncrementalSHA256();hash.update(data);check(hash.hex()===pin.sha256,'Retained chunk pin hash mismatch');}else{const original=data;data={size:original.size,async *open(){const hash=new IncrementalSHA256();for await(const bytes of original.open()){hash.update(bytes);yield bytes;}check(hash.hex()===pin.sha256,'Retained chunk pin hash mismatch');}};}}
    yield {key:[row.attachment_id,row.offset],record:record([row.attachment_id,row.offset,data]),attachment:manifest};
  }
  for(const manifest of state.manifests.values())check(manifest.offset===manifest.size&&manifest.hash.hex()===manifest.sha256,'Finalized attachment size or SHA-256 does not match its chunks');
}
type Overflow={first:number;count:number};
async function* provenance(source:SQLiteBackupSource,state:NormalizedSnapshot):AsyncGenerator<NormalizedRow>{
  for await(const row of source.provenance?.()??[]){validateBackupProvenance(row);check(state.resources.has(JSON.stringify([row.kind,row.id])),'Provenance resource is missing');yield {key:[row.kind,row.id],record:record(PROVENANCE_COLUMNS.map(key=>row[key]))};}
}
function typedAttachmentIds(kind:string,value:any,files:string[]):string[]{const ids=new Set<string>(),add=(item:any)=>{if(item===null||item===undefined)return;check(typeof item==='string'&&Array.from(item).length>0&&Array.from(item).length<=160&&!item.includes('\0'));ids.add(item);};if(['page','version'].includes(kind)&&Array.isArray(value.blocks)){for(const block of value.blocks)if(block&&typeof block==='object'&&!Array.isArray(block))add(block.attachment_id);}else if(kind==='collaboration'){const state=value.state;if(state&&typeof state==='object'&&!Array.isArray(state)){for(const document of [state,state.history?.baseline])if(document&&document.blocks&&typeof document.blocks==='object'&&!Array.isArray(document.blocks))for(const block of Object.values(document.blocks) as any[])if(block&&typeof block==='object')add(block.fields?.attachment_id?.value);const ops=state.history?.ops;if(ops&&typeof ops==='object'&&!Array.isArray(ops))for(const operation of Object.values(ops) as any[])if(operation&&operation.type==='block.set'&&operation.field==='attachment_id')add(operation.value);}}else if(kind==='row'){for(const key of files)for(const item of value.properties?.[key]??[])add(typeof item==='string'?item:item?.id);}return [...ids];}
function attachmentFingerprint(kind:string,value:any,created:string,updated:string):string{const keys=Object.keys(value).filter(key=>kind!=='attachment'||!['cloud_chunks','storage_id'].includes(key)).sort();const hash=new IncrementalSHA256();hash.update(new TextEncoder().encode(JSON.stringify([created,updated,keys.map(key=>[key,value[key]])])));return hash.hex();}
type VaultValidationState={records:Map<string,{root:string;generation:string;header:unknown;counts:Record<string,number>}>;counts:Map<string,Record<string,number>>;entities:Map<string,{generation:string|null;ownership:string;kind:string;id:string;parent:string|null;database:string|null;row:string|null;files:string[];attachments:string[]}>;reservations:Map<string,{record:string;generation:string}>;history:Map<string,string>;pins:Map<string,{size:number;sha256:string}>;roots:Map<string,{generation:string|null;archived:boolean;header:unknown}>;links:Array<{record:string;removed:string[]}>;refs:Array<{record:string;attachment:string;storage:string;physical:string;offset:number;size:number;sha256:string}>;fileManifests:Set<string>;cloudManifests:Set<string>;recordManifests:Map<string,{size:number;sha256:string}>};
function newSnapshot():NormalizedSnapshot{return {manifests:new Map(),kinds:{},resources:new Set(),live:new Set(),liveAttachments:new Map(),vault:{records:new Map(),counts:new Map(),entities:new Map(),reservations:new Map(),history:new Map(),pins:new Map(),roots:new Map(),links:[],refs:[],fileManifests:new Set(),cloudManifests:new Set(),recordManifests:new Map()}};}
function rememberVault(table:VaultTable,row:BackupVaultRow,state:NormalizedSnapshot){
 const v=state.vault,record=String(table==='retention_records'?row.id:row.record_id),countKey=({retention_entities:'entities',retention_provenance:'provenance',retention_attachment_refs:'refs',retention_identity_reservations:'reservations',retention_links:'links'} as Partial<Record<VaultTable,string>>)[table];
 if(table==='retention_records'){const data=privateJSON(row.data as string);check(!v.records.has(record));v.records.set(record,{root:data.root_id,generation:data.generation,header:data.header,counts:data.counts});return;}
 check(v.records.has(record)&&countKey!==undefined,'Orphan private retention row');const counts=v.counts.get(record)??{entities:0,provenance:0,refs:0,reservations:0,links:0};counts[countKey]++;v.counts.set(record,counts);
 const key=JSON.stringify([record,row.kind,row.id]);
 if(table==='retention_entities'){
  check(!v.entities.has(key));const payload=privateJSON(row.data as string);v.entities.set(key,{generation:row.generation as string|null,ownership:String(row.ownership),kind:String(row.kind),id:String(row.id),parent:payload.page_id??payload.parent_id??null,database:payload.database_id??null,row:payload.row_id??null,files:row.kind==='database'&&Array.isArray(payload.properties)?payload.properties.filter((p:any)=>p&&p.type==='files'&&typeof p.id==='string').map((p:any)=>p.id):[],attachments:typedAttachmentIds(String(row.kind),payload,row.kind==='row'?v.entities.get(JSON.stringify([record,'database',payload.database_id]))?.files??[]:[])});if(state.live.has(JSON.stringify([row.kind,row.id]))){check(['attachment','attachment_cloud','attachment_chunk'].includes(String(row.kind))&&state.liveAttachments.get(JSON.stringify([row.kind,row.id]))===attachmentFingerprint(String(row.kind),privateJSON(row.data as string),String(row.created_at),String(row.updated_at)),'Retained identity conflicts with live source');}
  if(row.kind==='attachment_chunk')v.fileManifests.add(JSON.stringify([record,payload.attachment_id,payload.offset,payload.size,payload.sha256]));
  if(['attachment','attachment_cloud'].includes(String(row.kind))&&payload.storage==='chunks'){
   const mk=JSON.stringify([record,row.id]),old=v.recordManifests.get(mk);check(!old||old.size===payload.size&&old.sha256===payload.sha256,'Retained attachment manifest conflict');v.recordManifests.set(mk,{size:payload.size,sha256:payload.sha256});
   if(Object.hasOwn(payload,'cloud_chunks')){check(Array.isArray(payload.cloud_chunks));let offset=0;for(const item of payload.cloud_chunks){check(item&&Object.keys(item).sort().join(',')==='attachmentId,offset,sha256,size,version'&&item.version===1&&item.attachmentId===(payload.storage_id??payload.id)&&item.offset===offset&&item.size===Math.min(CHUNK_SIZE,payload.size-offset)&&item.size>0&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid retained cloud manifest');v.cloudManifests.add(JSON.stringify([record,row.id,item.attachmentId,item.offset,item.size,item.sha256]));offset+=item.size;}check(offset===payload.size);}
  }
  if(row.kind==='page'){const data=privateJSON(row.data as string);v.roots.set(key,{generation:row.generation as string|null,archived:data.archived===true||data.deleted===true,header:Object.fromEntries(['id','owner_id','parent_id','teamspace_id','permissions','archived','deleted','deleted_at','locked','revision'].filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]))});}
 }else if(table==='retention_provenance'){check(!v.history.has(key));v.history.set(key,String(row.generation));}
 else if(table==='retention_identity_reservations'){const identity=JSON.stringify([row.kind,row.id]);check(!v.reservations.has(identity));v.reservations.set(identity,{record,generation:String(row.generation)});}
 else if(table==='retention_attachment_refs'){
  v.refs.push({record,attachment:String(row.attachment_id),storage:String(row.storage_kind),physical:String(row.physical_id),offset:Number(row.offset),size:Number(row.size),sha256:String(row.sha256)});
  const pinKey=JSON.stringify([row.attachment_id,row.offset]),previous=v.pins.get(pinKey);check(!previous||previous.size===row.size&&previous.sha256===row.sha256,'Conflicting retained physical pin');v.pins.set(pinKey,{size:Number(row.size),sha256:String(row.sha256)});
  check(v.entities.has(JSON.stringify([record,'attachment',row.attachment_id])),'Retained pin has no attachment');if(row.storage_kind==='blob')check(row.physical_id===row.attachment_id);
 }else if(table==='retention_links'){const data=privateJSON(row.data as string);v.links.push({record,removed:data.before.filter((id:string)=>!data.after.includes(id))});}
}
function verifyVault(state:NormalizedSnapshot){
 const v=state.vault;
 for(const [record,r]of v.records){const counts=v.counts.get(record)??{entities:0,provenance:0,refs:0,reservations:0,links:0};for(const key of Object.keys(counts))check(r.counts[key]===counts[key],'Retained row count mismatch');const root=v.roots.get(JSON.stringify([record,'page',r.root]));check(root&&root.archived&&root.generation===r.generation&&canonicalJSON(root.header)===canonicalJSON(r.header),'Retained root mismatch');}
 for(const [key,value]of v.entities){const [record,kind,id]=JSON.parse(key);if(value.ownership==='owned'){const r=v.reservations.get(JSON.stringify([kind,id]));check(r&&r.record===record&&(value.generation===null||r.generation===value.generation),'Owned retained reservation mismatch');}if(['page','database','row'].includes(kind))check(v.history.get(key)===value.generation,'Retained provenance missing');const owned=(kind:string,id:string|null)=>id!==null&&v.entities.get(JSON.stringify([record,kind,id]))?.ownership==='owned';for(const attachment of value.attachments)check(v.entities.has(JSON.stringify([record,'attachment',attachment])),'Typed retained attachment reference is missing');
 if(kind==='page'&&id!==v.records.get(record)!.root){let parent=value.parent;const seen=new Set([id]);while(parent!==v.records.get(record)!.root){check(parent!==null&&!seen.has(parent)&&owned('page',parent),'Retained page ownership cycle or gap');seen.add(parent);parent=v.entities.get(JSON.stringify([record,'page',parent]))!.parent;}check(owned('page',parent),'Retained page parent missing');}
 else if(kind==='database')check(owned('page',value.parent),'Retained database parent missing');else if(kind==='row')check(owned('database',value.database),'Retained row database missing');else if(['version','comment','site','transcript'].includes(kind))check(owned('page',value.parent),'Retained page owner missing');else if(['collaboration','wiki_page'].includes(kind))check(owned('page',value.parent??id),'Retained collaboration owner missing');else if(kind==='form')check(owned('database',value.database),'Retained form database missing');else if(kind==='automation')check(owned('database',value.database)||owned('row',value.row),'Retained automation owner missing');}
 for(const [key,r]of v.reservations){const [kind,id]=JSON.parse(key),e=v.entities.get(JSON.stringify([r.record,kind,id]));check(e&&e.ownership==='owned','Orphan reservation');}
 for(const [key,generation]of v.history)check(v.entities.get(key)?.generation===generation,'Retained provenance mismatch');
 for(const ref of v.refs){if(ref.storage==='file')check(v.fileManifests.has(JSON.stringify([ref.record,ref.attachment,ref.offset,ref.size,ref.sha256])),'Retained file pin has no immutable manifest');if(ref.storage==='cloud')check(v.cloudManifests.has(JSON.stringify([ref.record,ref.attachment,ref.physical,ref.offset,ref.size,ref.sha256])),'Retained cloud pin has no immutable manifest');}
 for(const [key,manifest]of v.recordManifests){const [record,attachment]=JSON.parse(key),refs=v.refs.filter(ref=>ref.record===record&&ref.attachment===attachment);for(let offset=0;offset<manifest.size;offset+=CHUNK_SIZE)check(refs.some(ref=>ref.offset===offset&&ref.size===Math.min(CHUNK_SIZE,manifest.size-offset)),'Retained physical pin coverage is incomplete');check(new Set(refs.map(ref=>ref.offset)).size===Math.ceil(manifest.size/CHUNK_SIZE),'Retained physical pin coverage is invalid');}
 for(const link of v.links)for(const id of link.removed)check(v.entities.get(JSON.stringify([link.record,'row',id]))?.ownership==='owned','Invalid retained dependency link');
}
function privateJSON(source:string):any{let result:any;try{result=JSON.parse(source);}catch{throw new SQLiteBackupError('Invalid private retention JSON');}const stack:Array<{object:boolean;keys:Set<string>}>=[];for(let at=0;at<source.length;at++){const char=source[at];if(char==='{'||char==='['){stack.push({object:char==='{',keys:new Set()});continue;}if(char==='}'||char===']'){stack.pop();continue;}if(char!=='"')continue;const start=at;for(at++;at<source.length;at++){if(source[at]==='\\'){at++;continue;}if(source[at]==='"')break;}let next=at+1;while(/[\t\n\r ]/.test(source[next]??'!'))next++;if(source[next]===':'){const key=JSON.parse(source.slice(start,at+1)),frame=stack.at(-1);check(frame?.object&&!frame.keys.has(key),'Duplicate private retention JSON key');frame.keys.add(key);}}return result;}
export function backupDate(value:unknown):boolean{if(typeof value!=='string')return false;const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);if(!match)return false;const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,0);if(year<1||year>9999||month<1||month>12||day<1||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day||hour>23||minute>59||second>59||Number(match[10]??0)>23||Number(match[11]??0)>59)return false;const offset=(Number(match[10]??0)*60+Number(match[11]??0))*60000*(match[9]==='-'?-1:1),adjusted=new Date(date.getTime()-offset);return adjusted.getUTCFullYear()>=1&&adjusted.getUTCFullYear()<=9999;}
export function validateBackupVaultRow(table:VaultTable,row:unknown):asserts row is BackupVaultRow{
  check(row!==null&&typeof row==='object'&&!Array.isArray(row));const value=row as Record<string,unknown>,columns=VAULT_COLUMNS[table];
  check(Object.keys(value).length===columns.length&&columns.every(key=>Object.hasOwn(value,key)));
  const identity=(item:unknown)=>{validText(item);check(Array.from(item).length>0&&Array.from(item).length<=160);};
  const generation=(item:unknown)=>check(typeof item==='string'&&/^[a-f0-9]{32}$/.test(item));
  for(const [key,item]of Object.entries(value)){
    if(['offset','size'].includes(key)){check(Number.isSafeInteger(item)&&(item as number)>=0);continue;}
    if(item===null){check(['generation','creator_id','editor_id','edited_at','manager_id','manager_at'].includes(key));continue;}validText(item);
    if(['created_at','updated_at','edited_at','manager_at'].includes(key))check(backupDate(item));
    if(['id','record_id','attachment_id','physical_id','creator_id','editor_id','manager_id'].includes(key))identity(item);
  }
  if('record_id'in value)generation(value.record_id);
  if(table==='retention_records'){
    generation(value.id);let data:any;try{data=privateJSON(value.data as string);}catch{check(false);}
    check(data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).sort().join(',')==='actor_id,cause,counts,deleted_at,generation,header,purge_after,record_revision,retained_at,retention_days,root_id,root_kind,source_revision,state,version');
    for(const key of ['deleted_at','retained_at','purge_after'])check(backupDate(data[key]));check(new Date(data.purge_after).getTime()>=new Date(data.retained_at).getTime());
    check(data.version===1&&data.root_kind==='page'&&data.state==='retained'&&['manual','policy'].includes(data.cause));identity(data.root_id);generation(data.generation);if(data.actor_id!==null)identity(data.actor_id);
    check(Number.isSafeInteger(data.retention_days)&&data.retention_days>=1&&data.retention_days<=3650&&new Date(data.purge_after).getTime()-new Date(data.retained_at).getTime()===data.retention_days*86400000&&Number.isSafeInteger(data.source_revision)&&data.source_revision>=0&&Number.isSafeInteger(data.record_revision)&&data.record_revision>=1);
    check(data.counts&&Object.keys(data.counts).sort().join(',')==='entities,links,provenance,refs,reservations'&&Object.values(data.counts).every(v=>Number.isSafeInteger(v)&&(v as number)>=0)&&data.header&&typeof data.header==='object'&&!Array.isArray(data.header));
  }else if(table==='retention_entities'){
    check(['page','database','row','version','comment','collaboration','wiki_page','site','form','automation','transcript','attachment','attachment_cloud','attachment_chunk'].includes(value.kind as string)&&['owned','shared'].includes(value.ownership as string));
    check(value.ownership!=='shared'||['attachment','attachment_cloud','attachment_chunk'].includes(value.kind as string));
    if(value.generation!==null)generation(value.generation);if(['page','database','row'].includes(value.kind as string))generation(value.generation);
    let data:any;try{data=privateJSON(value.data as string);}catch{check(false);}check(data&&typeof data==='object'&&!Array.isArray(data)&&data.id===value.id);
  }else if(table==='retention_provenance'){
    const {record_id,...history}=value;validateBackupProvenance(history);
  }else if(table==='retention_attachment_refs'){
    check(['blob','file','cloud'].includes(value.storage_kind as string)&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&Number(value.offset)%CHUNK_SIZE===0&&Number(value.size)>0&&Number(value.size)<=CHUNK_SIZE);if(value.storage_kind==='file')check(value.physical_id===value.sha256);
  }else if(table==='retention_identity_reservations'){generation(value.generation);check(['page','database','row','version','comment','collaboration','wiki_page','site','form','automation','transcript','attachment','attachment_cloud','attachment_chunk'].includes(value.kind as string));}
  else {check(value.kind==='row');let data:any;try{data=privateJSON(value.data as string);}catch{check(false);}check(data&&Object.keys(data).sort().join(',')==='after,before,generation');generation(data.generation);for(const key of ['before','after']){check(Array.isArray(data[key])&&new Set(data[key]).size===data[key].length);for(const id of data[key])identity(id);}check(data.after.every((id:string)=>data.before.includes(id)));}
}
export const VAULT_KEYS:Record<VaultTable,string[]>={retention_records:['id'],retention_entities:['record_id','kind','id'],retention_provenance:['record_id','kind','id'],retention_attachment_refs:['record_id','attachment_id','storage_kind','physical_id','offset'],retention_identity_reservations:['kind','id'],retention_links:['record_id','kind','id']};
async function* vaultRows(table:VaultTable,source:SQLiteBackupSource,state:NormalizedSnapshot):AsyncGenerator<NormalizedRow>{
  for await(const row of source.vault?.[table]()??[]){validateBackupVaultRow(table,row);rememberVault(table,row,state);
    if(table==='retention_entities'&&['attachment','attachment_cloud'].includes(row.kind as string)){
      const item=privateJSON(row.data as string);if(item.storage==='chunks'){
        check(Number.isSafeInteger(item.size)&&item.size>=0&&item.size<=MAX_ATTACHMENT&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256));
        const old=state.manifests.get(row.id as string);check(!old||old.size===item.size&&old.sha256===item.sha256,'Retained attachment bytes conflict');if(!old)state.manifests.set(row.id as string,{size:item.size,sha256:item.sha256,offset:0,hash:new IncrementalSHA256()});
      }
    }
    yield {key:VAULT_KEYS[table].map(key=>row[key] as string|number),record:record(VAULT_COLUMNS[table].map(key=>row[key]))};
  }
}

type RowPlan={rowid:number;size:number;local:number;overflow:Overflow|null;cellSize:number};
type Leaf={page:number;start:number;end:number;maxRowid:number};
type TableNode={page:number;children:TableTree[];maxRowid:number};
type TableTree=Leaf|TableNode;
type IndexNode={page:number;entries:Uint8Array[];children:IndexNode[]};
type TablePlan={rows:RowPlan[];leaves:Leaf[];parents:TableNode[];root:number;keys:Uint8Array[];index:IndexNode};
class Allocator{
  next=2;readonly lockPage:number;readonly size:number;
  constructor(size:number){this.size=size;this.lockPage=Math.floor(0x40000000/size)+1;}
  reserve(count=1):number{check(Number.isSafeInteger(count)&&count>=1);if(this.next===this.lockPage)this.next++;const first=this.next;let following=first+count;if(first<this.lockPage&&following>this.lockPage)following++;check(following<=0xffffffff,'SQLite page limit exceeded');this.next=following;return first;}
  number(first:number,index:number):number{const n=first+index;return first<this.lockPage&&n>=this.lockPage?n+1:n;}
}
function localPayload(size:number,pageSize:number,index=false):number{
  const maximum=index?Math.floor((pageSize-12)*64/255)-23:pageSize-35;if(size<=maximum)return size;
  const minimum=Math.floor((pageSize-12)*32/255)-23,candidate=minimum+(size-minimum)%(pageSize-4);return candidate<=maximum?candidate:minimum;
}
function indexTree(keys:Uint8Array[],allocate:Allocator):IndexNode{
  let maxSize=1;for(const key of keys)maxSize=Math.max(maxSize,key.length+varint(key.length).length);const capacity=Math.floor((allocate.size-12)/(maxSize+6)),minimum=Math.floor(capacity/2);check(capacity>=3,'SQLite index keys exceed the supported schema bounds');
  const max=(height:number)=>Math.pow(capacity+1,height+1)-1,min=(height:number)=>Math.pow(minimum+1,height+1)-1;let height=0;while(keys.length>max(height))height++;let cursor=0;
  function build(count:number,depth:number,root=false):IndexNode{
    if(depth===0){const entries=keys.slice(cursor,cursor+count);cursor+=count;return {page:allocate.reserve(),entries,children:[]};}
    let childrenCount=root?2:minimum+1;while(childrenCount<=capacity+1&&(count-(childrenCount-1)>childrenCount*max(depth-1)||count-(childrenCount-1)<childrenCount*min(depth-1)))childrenCount++;
    check(childrenCount<=capacity+1,'Cannot balance SQLite index');const remaining=count-(childrenCount-1),each=Math.floor(remaining/childrenCount),extra=remaining%childrenCount,children:IndexNode[]=[],entries:Uint8Array[]=[];
    for(let i=0;i<childrenCount;i++){children.push(build(each+(i<extra?1:0),depth-1));if(i<childrenCount-1)entries.push(keys[cursor++]);}return {page:allocate.reserve(),entries,children};
  }
  const result=build(keys.length,height,true);check(cursor===keys.length);return result;
}
function tableParents(leaves:Leaf[],allocate:Allocator):{root:number;parents:TableNode[]}{
  let level:TableTree[]=leaves;const parents:TableNode[]=[],capacity=Math.floor((allocate.size-12)/15)+1;
  while(level.length>1){const groups=Math.ceil(level.length/capacity),each=Math.floor(level.length/groups),extra=level.length%groups,next:TableNode[]=[];let cursor=0;for(let i=0;i<groups;i++){const children=level.slice(cursor,cursor+each+(i<extra?1:0));cursor+=children.length;const node={page:allocate.reserve(),children,maxRowid:children.at(-1)!.maxRowid};parents.push(node);next.push(node);}level=next;}return {root:level[0].page,parents};
}
function put32(value:Uint8Array,offset:number,n:number){new DataView(value.buffer,value.byteOffset,value.byteLength).setUint32(offset,n);}
function page(type:number,size:number,cells:Uint8Array[],rightmost?:number,offset=0):Uint8Array{
  const output=new Uint8Array(size),view=new DataView(output.buffer),header=type===2||type===5?12:8;output[offset]=type;view.setUint16(offset+3,cells.length);let end=size;
  for(let i=0;i<cells.length;i++){end-=cells[i].length;check(end>=offset+header+cells.length*2,'SQLite B-tree page overflow');output.set(cells[i],end);view.setUint16(offset+header+i*2,end);}
  view.setUint16(offset+5,end===65536?0:end);if(rightmost!==undefined)view.setUint32(offset+8,rightmost);return output;
}
function headerPage(size:number,pages:number,roots:Array<[string,number,number]>):Uint8Array{
  const cells:Uint8Array[]=[];let rowid=0;
  for(const [name,tableRoot,indexRoot]of roots){for(const values of [['table',name,name,tableRoot,SQLITE_DEFINITIONS[name as keyof typeof SQLITE_DEFINITIONS]],['index','sqlite_autoindex_'+name+'_1',name,indexRoot,null]]){const data=smallRecord(record(values as Value[]));cells.push(join([varint(data.length),varint(++rowid),data]));}}
  const output=page(13,size,cells,undefined,100),view=new DataView(output.buffer);output.set(encoder.encode('SQLite format 3\u0000'));view.setUint16(16,size===65536?1:size);output[18]=output[19]=1;output[21]=64;output[22]=output[23]=32;view.setUint32(24,1);view.setUint32(28,pages);view.setUint32(40,1);view.setUint32(44,4);view.setUint32(56,1);view.setUint32(92,1);
  // Offset 96 stays zero: this generator is not a SQLite library version.
  return output;
}
async function hashRecord(row:NormalizedRow,rowid:number,hash:IncrementalSHA256):Promise<void>{
  hash.update(varint(row.record.size));hash.update(varint(rowid));for await(const bytes of recordBytes(row.record,row.attachment?bytes=>row.attachment!.hash.update(bytes):undefined))hash.update(bytes);
}

export class SQLiteBackupWriter{
  readonly pageSize:4096|65536;readonly maxPlanBytes:number;
  constructor(options:SQLiteBackupOptions={}){this.pageSize=options.pageSize??4096;this.maxPlanBytes=options.maxPlanBytes??64*1024*1024;check([4096,65536].includes(this.pageSize)&&Number.isSafeInteger(this.maxPlanBytes)&&this.maxPlanBytes>=1024*1024&&this.maxPlanBytes<=128*1024*1024,'Invalid SQLite backup limits');}
  async write(source:SQLiteBackupSource,sink:SQLiteBackupSink):Promise<SQLiteBackupSummary>{
    let closed=false;
    try{
      const allocate=new Allocator(this.pageSize),firstHash=new IncrementalSHA256(),firstState:NormalizedSnapshot=newSnapshot(),plans:TablePlan[]=[];let planBytes=0;
      const vaultNames=Object.keys(VAULT_COLUMNS) as VaultTable[];
      if(source.vault)check(vaultNames.every(name=>typeof source.vault![name]==='function'),'Incomplete retention vault source');
      const names=source.vault?['entities','meta','content_provenance',...vaultNames,'attachment_chunks']:source.provenance?['entities','meta','attachment_chunks','content_provenance']:['entities','meta','attachment_chunks'];
      const readers=source.vault?[entities,metadata,provenance,...vaultNames.map(name=>(s:SQLiteBackupSource,v:NormalizedSnapshot)=>vaultRows(name,s,v)),chunks]:source.provenance?[entities,metadata,chunks,provenance]:[entities,metadata,chunks];
      for(let table=0;table<readers.length;table++){
        firstHash.update(Uint8Array.of(table));const rows:RowPlan[]=[],leaves:Leaf[]=[],keys:Uint8Array[]=[];let previous:Key|null=null,start=0,used=8;
        for await(const row of readers[table](source,firstState)){
          check(previous===null||compareKey(previous,row.key)<0,'Portable rows must have unique sorted primary keys');previous=row.key;const rowid=rows.length+1,local=localPayload(row.record.size,this.pageSize),overflowBytes=row.record.size-local,overflowCount=Math.ceil(overflowBytes/(this.pageSize-4)),cellSize=varint(row.record.size).length+varint(rowid).length+local+(overflowCount?4:0);
          if(used+cellSize+2>this.pageSize){check(rows.length>start);leaves.push({page:allocate.reserve(),start,end:rows.length,maxRowid:rows.length});start=rows.length;used=8;}
          const overflow=overflowCount?{first:allocate.reserve(overflowCount),count:overflowCount}:null;rows.push({rowid,size:row.record.size,local,overflow,cellSize});used+=cellSize+2;
          const key=smallRecord(record([...row.key,rowid]));check(localPayload(key.length,this.pageSize,true)===key.length,'Index key exceeds portable schema bounds');keys.push(key);planBytes+=192+key.length;check(planBytes<=this.maxPlanBytes,'SQLite backup plan exceeds the bounded memory limit');
          await hashRecord(row,rowid,firstHash);
        }
        leaves.push({page:allocate.reserve(),start,end:rows.length,maxRowid:rows.length});const tree=tableParents(leaves,allocate),index=indexTree(keys,allocate);plans.push({rows,leaves,parents:tree.parents,root:tree.root,keys,index});
      }
      if(source.vault)verifyVault(firstState);
      const pages=allocate.next-1,summary:SQLiteBackupSummary={pageSize:this.pageSize,pages,byteLength:pages*this.pageSize,sourceSHA256:firstHash.hex(),counts:{entities:plans[0].rows.length,meta:plans[1].rows.length,attachment_chunks:plans[source.vault?9:2].rows.length,...(source.vault?{content_provenance:plans[2].rows.length,...Object.fromEntries(vaultNames.map((name,i)=>[name,plans[3+i].rows.length]))}:source.provenance?{content_provenance:plans[3].rows.length}:{})},entityKinds:firstState.kinds};
      let emitted=1;const write=async(number:number,bytes:Uint8Array)=>{if(emitted===allocate.lockPage&&number===emitted+1){await sink.write(new Uint8Array(this.pageSize));emitted++;}check(number===emitted&&bytes.length===this.pageSize,'SQLite page plan changed');await sink.write(bytes);emitted++;};
      await write(1,headerPage(this.pageSize,pages,names.map((name,index)=>[name,plans[index].root,plans[index].index.page])));
      const secondHash=new IncrementalSHA256(),secondState:NormalizedSnapshot=newSnapshot();
      for(let table=0;table<readers.length;table++){
        const plan=plans[table];secondHash.update(Uint8Array.of(table));let index=0,leafIndex=0,cells:Uint8Array[]=[],previous:Key|null=null;
        for await(const row of readers[table](source,secondState)){
          check(previous===null||compareKey(previous,row.key)<0,'Portable rows changed during export');previous=row.key;const planned=plan.rows[index++];check(planned&&planned.size===row.record.size,'Snapshot changed during export');
          const expectedKey=smallRecord(record([...row.key,planned.rowid]));check(expectedKey.length===plan.keys[index-1].length&&expectedKey.every((value,i)=>value===plan.keys[index-1][i]),'Snapshot primary key changed');
          secondHash.update(varint(row.record.size));secondHash.update(varint(planned.rowid));const local=new Uint8Array(planned.local);let copied=0,overflowIndex=0,overflowPage:Uint8Array|null=null,overflowUsed=4;
          for await(const bytes of recordBytes(row.record,row.attachment?bytes=>row.attachment!.hash.update(bytes):undefined)){
            secondHash.update(bytes);let offset=0;if(copied<local.length){const take=Math.min(bytes.length,local.length-copied);local.set(bytes.subarray(0,take),copied);copied+=take;offset=take;}
            while(offset<bytes.length){if(!overflowPage){check(planned.overflow);overflowPage=new Uint8Array(this.pageSize);const next=overflowIndex+1<planned.overflow.count?allocate.number(planned.overflow.first,overflowIndex+1):0;put32(overflowPage,0,next);overflowUsed=4;}const take=Math.min(this.pageSize-overflowUsed,bytes.length-offset);overflowPage.set(bytes.subarray(offset,offset+take),overflowUsed);overflowUsed+=take;offset+=take;if(overflowUsed===this.pageSize){await write(allocate.number(planned.overflow!.first,overflowIndex++),overflowPage);overflowPage=null;}}
          }
          if(overflowPage)await write(allocate.number(planned.overflow!.first,overflowIndex++),overflowPage);check(copied===planned.local&&overflowIndex===(planned.overflow?.count??0),'BLOB size changed');
          const pointer=planned.overflow?new Uint8Array(4):new Uint8Array();if(planned.overflow)put32(pointer,0,planned.overflow.first);const cell=join([varint(planned.size),varint(planned.rowid),local,pointer]);check(cell.length===planned.cellSize);cells.push(cell);
          const leaf=plan.leaves[leafIndex];if(index===leaf.end){await write(leaf.page,page(13,this.pageSize,cells));cells=[];leafIndex++;}
        }
        check(index===plan.rows.length,'Snapshot rows disappeared');if(!plan.rows.length){const leaf=plan.leaves[0];await write(leaf.page,page(13,this.pageSize,[]));}
        for(const node of plan.parents){const childCells=node.children.slice(0,-1).map(child=>{const pointer=new Uint8Array(4);put32(pointer,0,child.page);return join([pointer,varint(child.maxRowid)]);});await write(node.page,page(5,this.pageSize,childCells,node.children.at(-1)!.page));}
        const outputIndex=async(node:IndexNode):Promise<void>=>{for(const child of node.children)await outputIndex(child);const encoded=node.entries.map((entry,i)=>{const content=join([varint(entry.length),entry]);if(!node.children.length)return content;const pointer=new Uint8Array(4);put32(pointer,0,node.children[i].page);return join([pointer,content]);});await write(node.page,page(node.children.length?2:10,this.pageSize,encoded,node.children.at(-1)?.page));};await outputIndex(plan.index);
      }
      if(source.vault)verifyVault(secondState);
      check(emitted===pages+1&&secondHash.hex()===summary.sourceSHA256,'Snapshot content changed during export');await sink.close?.(summary);closed=true;return summary;
    }catch(error){const safe=error instanceof SQLiteBackupError?error:new SQLiteBackupError('Portable SQLite backup could not complete');if(!closed)try{await sink.abort?.(safe);}catch{}throw safe;}
  }
}
export const writeSQLiteBackup=(source:SQLiteBackupSource,sink:SQLiteBackupSink,options:SQLiteBackupOptions={})=>new SQLiteBackupWriter(options).write(source,sink);
