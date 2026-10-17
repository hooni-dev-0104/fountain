/** Private, serializable SQLite generation. No checkpoint grants authority.
 * The caller pins a trusted normalized source snapshot and rechecks live owner
 * authorization for every I/O and external CAS. Data refs contain UTF-8 JSON
 * already validated against the authoritative entity identity/attachment manifest.
 * Plan writes are PRIVATE staged effects, approved only by the external job CAS.
 * Sink writes use absolute offsets + SHA; exact retry may reuse identical bytes,
 * never append twice or overwrite different bytes. Checkpoints are server-only.
 * Every step resumes its actual byte/page cursor; no prefix replay or full plan.
 */
import {IncrementalSHA256} from './storage.ts';
import type {HashState} from './storage.ts';
import {SQLITE_DEFINITIONS,SQLiteBackupError,validateBackupProvenance,PROVENANCE_COLUMNS} from './sqlite-backup.ts';
import type {SQLiteBackupSummary} from './sqlite-backup.ts';
import {canonicalJSON} from './store.ts';

export type BackupTable='entities'|'meta'|'attachment_chunks'|'content_provenance';
import type {BackupProvenance} from './sqlite-backup.ts';
export type BackupReference={ref:string;size:number;type:'text'|'blob'};
export type ResumeEntity={kind:string;id:string;data:BackupReference;created_at:string;updated_at:string;attachment?:{size:number;sha256:string}};
export type ResumeMeta={key:string;data:BackupReference};
export type ResumeChunk={attachment_id:string;offset:number;data:BackupReference};
export interface ResumableBackupSource{
 snapshotId:string;
 describe(table:BackupTable,index:number):Promise<ResumeEntity|ResumeMeta|ResumeChunk|BackupProvenance|null>;
 read(ref:string,offset:number,length:number):Promise<Uint8Array>;
}
/** Reads include this step's staged writes; external CAS controls visibility.
 * Values are opaque checksummed envelopes. A provider must never unwrap them.
 * Checksums detect accidental value/key corruption; the authenticated private
 * database and the job CAS remain the authority for accepted envelopes.
 */
export interface ResumableBackupPlanStore{
 get(key:string):Promise<unknown|null>;
 put(key:string,value:unknown):Promise<void>;
}
export interface ResumableBackupSink{
 write(offset:number,bytes:Uint8Array,sha256:string):Promise<void>;
 read(offset:number,length:number):Promise<Uint8Array>;
}
export type ResumableBackupIO={source:ResumableBackupSource;plans:ResumableBackupPlanStore;sink:ResumableBackupSink};
export type BackupStepBudget={maxInputBytes?:number;maxOutputBytes?:number;maxOperations?:number};
const TABLES:BackupTable[]=['entities','meta','attachment_chunks','content_provenance'],SLICE=65536,CHUNK_SIZE=4*1024*1024,HASH=/^[a-f0-9]{64}$/;
// SQLite's 32-bit page count and maximum 64KiB page size, not attachment quota.
const HASH_LIMIT=0xffffffff*65536;
const PRIVATE=new Set(['session','clipboard','upload','presence','attachment_chunk']);
const PRIVATE_META=new Set(['local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved']);
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
type Value=string|number|bigint|null|Uint8Array|BackupReference;
type RecordSource={header:Uint8Array;parts:Array<string|Uint8Array|BackupReference>;size:number};
function record(values:Value[]):RecordSource{
  const serials:Uint8Array[]=[],parts:Array<string|Uint8Array|BackupReference>=[];let size=0;
  for(const value of values){
    if(value===null){serials.push(varint(0));continue;}
    if(typeof value==='number'||typeof value==='bigint'){const item=integer(value);serials.push(varint(item.serial));parts.push(item.bytes);size+=item.bytes.length;continue;}
    if(typeof value==='string'){validText(value);const bytes=lengthUTF8(value);serials.push(varint(bytes*2+13));parts.push(value);size+=bytes;continue;}
    const bytes=value instanceof Uint8Array?value.length:value.size;check(Number.isSafeInteger(bytes)&&bytes>=0);serials.push(varint(bytes*2+(value instanceof Uint8Array||value.type==='blob'?12:13)));parts.push(value);size+=bytes;
  }
  const types=join(serials);let headerSize=types.length+1;while(varint(headerSize).length+types.length!==headerSize)headerSize=varint(headerSize).length+types.length;
  const header=join([varint(headerSize),types]);check(size+header.length<=16*1024*1024+8192,'SQLite record exceeds the bounded export limit');return {header,parts,size:size+header.length};
}
function smallRecord(value:RecordSource):Uint8Array{return join([value.header,...value.parts.map(part=>{check(typeof part==='string'||part instanceof Uint8Array);return typeof part==='string'?encoder.encode(part):part;})]);}
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

type Part={literal:string;size:number;type:'bytes'}|BackupReference;
type RowPlan={rowid:number;size:number;local:number;overflow:{first:number;count:number}|null;cellSize:number};
type RefNode={page:number;maxRowid:number};
type LeafPlan=RefNode&{start:number;end:number};
type TablePlan={rows:number;leaves:number;parents:number;indices:number;root:number;indexRoot:number;maxKeySize:number;sourceCount:number};
type Manifest={size:number;sha256:string;offset:number;hash:HashState};
type UTF8State={need:number;point:number;minimum:number};
type RowWork={key:Key;parts:Part[];part:number;offset:number;utf8:UTF8State;plan:RowPlan;local:string;overflow:string;overflowIndex:number;manifestId?:string;manifest?:Manifest};
type IndexFrame={count:number;depth:number;root:boolean;childCount:number;each:number;extra:number;next:number;entries:string[];children:number[]};
type Phase='plan-rows'|'plan-parents'|'plan-index'|'check-manifests'|'header'|'emit-rows'|'emit-parents'|'emit-index'|'check-manifests2'|'verify'|'done';
export type ResumableBackupSummary=Omit<SQLiteBackupSummary,'entityKinds'>&{entityKindCount:number};
export type SQLiteBackupCheckpoint={
 version:1|2;snapshotId:string;pageSize:4096|65536;sequence:number;phase:Phase;table:number;nextPage:number;outputPage:number;
 sourceIndex:number;rowIndex:number;previous:Key|null;leafIndex:number;cells:string[];row:RowWork|null;
 tablePlan:TablePlan;leafStart:number;leafUsed:number;leafMax:number;
 parent:{level:number;count:number;cursor:number;groups:number;each:number;extra:number;group:number;children:RefNode[]}|null;
 index:{cursor:number;ordinal:number;frames:IndexFrame[]}|null;
 manifestCount:number;manifestIndex:number;roots:Array<[string,number,number]>;counts:number[];
 sourceHash:HashState;secondHash:HashState;outputHash:HashState;verifyHash:HashState;verifyOffset:number;
 writes:Array<{page:number;data:string}>;kindCount:number;kind:{name:string;count:number}|null;summary:ResumableBackupSummary|null;sha256:string|null;
};
export type BackupStepResult={checkpoint:SQLiteBackupCheckpoint;completed:boolean;summary:ResumableBackupSummary|null;sha256:string|null;work:{inputBytes:number;outputBytes:number;operations:number}};
const emptyPlan=():TablePlan=>({rows:0,leaves:0,parents:0,indices:0,root:0,indexRoot:0,maxKeySize:1,sourceCount:0});
const newHash=()=>new IncrementalSHA256(undefined,HASH_LIMIT);
const hashFrom=(value:HashState)=>new IncrementalSHA256(value,HASH_LIMIT);
function pack(bytes:Uint8Array):string{const parts:string[]=[];for(let i=0;i<bytes.length;i+=16384)parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));return btoa(parts.join(''));}
function unpack(value:string):Uint8Array{return Uint8Array.from(atob(value),char=>char.charCodeAt(0));}
async function sha(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function add(hash:HashState,bytes:Uint8Array):HashState{const value=hashFrom(hash);value.update(bytes);return value.state();}
function text(value:unknown,max=640):asserts value is string{validText(value);check(encoder.encode(value).length<=max);}
function reference(value:unknown,type:'text'|'blob'):asserts value is BackupReference{const v=value as BackupReference;check(v&&typeof v==='object'&&Object.keys(v).length===3&&v.type===type&&typeof v.ref==='string'&&v.ref.length>0&&v.ref.length<=512&&Number.isSafeInteger(v.size)&&v.size>=0&&v.size<=16*1024*1024);}
function utf8(state:UTF8State,bytes:Uint8Array,complete=false){
 for(const byte of bytes){check(byte!==0,'Invalid NUL in portable text');if(!state.need){if(byte<128)continue;if(byte>=0xc2&&byte<=0xdf){state.need=1;state.point=byte&31;state.minimum=0x80;}else if(byte>=0xe0&&byte<=0xef){state.need=2;state.point=byte&15;state.minimum=0x800;}else if(byte>=0xf0&&byte<=0xf4){state.need=3;state.point=byte&7;state.minimum=0x10000;}else check(false,'Invalid portable UTF-8');}else {check(byte>=128&&byte<=191,'Invalid portable UTF-8');state.point=state.point*64+(byte&63);if(!--state.need)check(state.point>=state.minimum&&state.point<=0x10ffff&&(state.point<0xd800||state.point>0xdfff),'Invalid portable UTF-8');}}
 if(complete)check(state.need===0,'Truncated portable UTF-8');
}
function parts(value:RecordSource):Part[]{return [value.header,...value.parts].map(part=>typeof part==='string'?{literal:pack(encoder.encode(part)),size:lengthUTF8(part),type:'bytes'}:part instanceof Uint8Array?{literal:pack(part),size:part.length,type:'bytes'}:part);}
function indexFrame(count:number,depth:number,root:boolean,capacity:number):IndexFrame{
 if(!depth)return {count,depth,root,childCount:0,each:0,extra:0,next:0,entries:[],children:[]};
 const minimum=Math.floor(capacity/2),max=(h:number)=>Math.pow(capacity+1,h+1)-1,min=(h:number)=>Math.pow(minimum+1,h+1)-1;let childCount=root?2:minimum+1;
 while(childCount<=capacity+1&&(count-childCount+1>childCount*max(depth-1)||count-childCount+1<childCount*min(depth-1)))childCount++;
 check(childCount<=capacity+1,'Cannot balance SQLite index');const remaining=count-childCount+1;
 return {count,depth,root,childCount,each:Math.floor(remaining/childCount),extra:remaining%childCount,next:0,entries:[],children:[]};
}
function queue(c:SQLiteBackupCheckpoint,number:number,bytes:Uint8Array){
 const lock=Math.floor(0x40000000/c.pageSize)+1;
 if(c.outputPage===lock&&number===lock+1){c.writes.push({page:lock,data:pack(new Uint8Array(c.pageSize))});c.outputPage++;}
 check(number===c.outputPage&&bytes.length===c.pageSize,'SQLite page plan changed');c.writes.push({page:number,data:pack(bytes)});c.outputPage++;
}
function initial(snapshotId:string,pageSize:4096|65536,includeHistory=false):SQLiteBackupCheckpoint{
 check(typeof snapshotId==='string'&&snapshotId.length>0&&snapshotId.length<=512&&[4096,65536].includes(pageSize));const hash=newHash().state();
 return {version:includeHistory?2:1,snapshotId,pageSize,sequence:0,phase:'plan-rows',table:0,nextPage:2,outputPage:1,sourceIndex:0,rowIndex:0,previous:null,leafIndex:0,cells:[],row:null,tablePlan:emptyPlan(),leafStart:0,leafUsed:8,leafMax:0,parent:null,index:null,manifestCount:0,manifestIndex:0,roots:[],counts:[],sourceHash:add(hash,Uint8Array.of(0)),secondHash:hash,outputHash:hash,verifyHash:hash,verifyOffset:0,writes:[],kindCount:0,kind:null,summary:null,sha256:null};
}
export function createSQLiteBackupCheckpoint(snapshotId:string,pageSize:4096|65536=4096,includeHistory=false):SQLiteBackupCheckpoint{return initial(snapshotId,pageSize,includeHistory);}

/** I/O side effects belong to the caller's private job revision. A returned
 * checkpoint is not accepted until the external lease/CAS/receipt commits it.
 * Replay the same accepted sequence only with exact-offset, digest-checked sink
 * reuse and identical staged plan writes; never trust client-provided state.
 */
export async function stepSQLiteBackup(previous:SQLiteBackupCheckpoint,io:ResumableBackupIO,budget:BackupStepBudget={}):Promise<BackupStepResult>{
 let inputBytes=0,outputBytes=0,operations=0;
 const maxInput=budget.maxInputBytes??262144,maxOutput=budget.maxOutputBytes??262144,maxOperations=budget.maxOperations??128;
 check(Number.isSafeInteger(maxInput)&&maxInput>=128&&maxInput<=262144&&Number.isSafeInteger(maxOutput)&&maxOutput>=previous.pageSize&&maxOutput<=262144&&Number.isSafeInteger(maxOperations)&&maxOperations>=32&&maxOperations<=4096,'Invalid SQLite step budget');
 // Checkpoints come only from private authenticated storage. Fail closed on
 // cross-snapshot/version use; source/plans/authority are not embedded here.
 check((previous.version===1||previous.version===2)&&previous.snapshotId===io.source.snapshotId&&[4096,65536].includes(previous.pageSize)&&Number.isSafeInteger(previous.sequence)&&previous.sequence>=0,'Invalid private SQLite checkpoint');
 check(Number.isInteger(previous.table)&&previous.table>=0&&previous.table<(previous.version===2?4:3)&&Array.isArray(previous.roots)&&previous.roots.length<=(previous.version===2?4:3)&&Array.isArray(previous.counts)&&previous.counts.length<=(previous.version===2?4:3),'Invalid private SQLite checkpoint layout');
 check(!['check-manifests','header','emit-rows','emit-parents','emit-index','check-manifests2','verify','done'].includes(previous.phase)||(previous.roots.length===(previous.version===2?4:3)&&previous.counts.length===(previous.version===2?4:3)),'Invalid private SQLite checkpoint layout');
 const c=structuredClone(previous),allocate=new Allocator(c.pageSize);allocate.next=c.nextPage;
 const checksum=(key:string,value:unknown)=>sha(encoder.encode(key+'\u0000'+canonicalJSON(value)));
 const get=async(key:string):Promise<any>=>{
  operations++;const envelope:any=await io.plans.get(key);if(envelope===null)return null;
  check(envelope&&typeof envelope==='object'&&Object.keys(envelope).length===3&&envelope.version===1&&Object.hasOwn(envelope,'data')&&typeof envelope.sha256==='string'&&HASH.test(envelope.sha256)&&await checksum(key,envelope.data)===envelope.sha256,'Private SQLite plan checksum changed');return envelope.data;
 },put=async(key:string,value:unknown)=>{operations++;await io.plans.put(key,{version:1,data:value,sha256:await checksum(key,value)});};
 const reserve=(count=1)=>{const value=allocate.reserve(count);c.nextPage=allocate.next;return value;};
 const tableKey=(kind:string,index:number)=>kind+'/'+c.table+'/'+index;
 const manifestKey=(id:string)=>'manifest/'+(c.phase.startsWith('plan')||c.phase==='check-manifests'?1:2)+'/'+id;
 const leaf=async()=>{const value:LeafPlan={page:reserve(),start:c.leafStart,end:c.rowIndex,maxRowid:c.rowIndex};await put(tableKey('leaf',c.tablePlan.leaves),value);await put('level/'+c.table+'/0/'+c.tablePlan.leaves,value);c.tablePlan.leaves++;c.leafStart=c.rowIndex;c.leafUsed=8;c.leafMax=value.page;};
 const finishKind=async()=>{if(!c.kind)return;await put('kind-count/'+c.kind.name,{count:c.kind.count});await put('kind-id/'+c.kindCount,c.kind.name);c.kindCount++;c.kind=null;};
 async function describeRow():Promise<{key:Key;value:RecordSource;manifestId?:string;manifest?:Manifest}|'skip'|null>{
  operations++;const row:any=structuredClone(await io.source.describe(TABLES[c.table],c.sourceIndex));if(row===null)return null;c.sourceIndex++;
  check(row&&typeof row==='object'&&JSON.stringify(row).length<=8192,'Invalid bounded portable descriptor');
  if(c.table===0){
   text(row.kind,64);text(row.id);if(PRIVATE.has(row.kind))return 'skip';check(/^[a-z][a-z0-9_]{0,63}$/.test(row.kind)&&Array.from(row.id).length>0&&Array.from(row.id).length<=160);text(row.created_at,256);text(row.updated_at,256);reference(row.data,'text');
   if(row.attachment!==undefined){check(row.kind==='attachment'&&row.attachment&&Number.isSafeInteger(row.attachment.size)&&row.attachment.size>=0&&row.attachment.size<=5_000_000_000&&HASH.test(row.attachment.sha256));
    const key=manifestKey(row.id);check(await get(key)===null,'Duplicate attachment');await put(key,{size:row.attachment.size,sha256:row.attachment.sha256,offset:0,hash:newHash().state()});if(c.phase==='plan-rows'){await put('manifest-id/'+c.manifestCount,row.id);c.manifestCount++;}}
   if(c.version===2&&['page','database','row'].includes(row.kind)&&c.phase==='plan-rows')await put('provenance-source/'+row.kind+'/'+row.id,true);
   return {key:[row.kind,row.id],value:record([row.kind,row.id,row.data,row.created_at,row.updated_at])};
  }
  if(c.table===1){text(row.key);if(PRIVATE_META.has(row.key))return 'skip';check(Array.from(row.key).length>0&&Array.from(row.key).length<=160);reference(row.data,'text');return {key:[row.key],value:record([row.key,row.data])};}
  if(c.table===3){validateBackupProvenance(row);check(await get('provenance-source/'+row.kind+'/'+row.id)===true,'Provenance resource is missing');return {key:[row.kind,row.id],value:record(PROVENANCE_COLUMNS.map(key=>row[key]))};}
  text(row.attachment_id);const manifest:Manifest|null=await get(manifestKey(row.attachment_id));if(!manifest)return 'skip';reference(row.data,'blob');check(Number.isSafeInteger(row.offset)&&row.offset===manifest.offset&&row.offset<manifest.size&&row.data.size===Math.min(CHUNK_SIZE,manifest.size-row.offset),'Attachment chunks changed or are noncontiguous');manifest.offset+=row.data.size;
  return {key:[row.attachment_id,row.offset],value:record([row.attachment_id,row.offset,row.data]),manifestId:row.attachment_id,manifest};
 }
 async function beginRow(planning:boolean):Promise<boolean>{
  const described=await describeRow();if(described==='skip')return true;
  if(described===null){
   if(planning){if(c.table===0)await finishKind();await leaf();c.tablePlan.rows=c.rowIndex;c.tablePlan.sourceCount=c.sourceIndex;c.phase='plan-parents';c.parent={level:0,count:c.tablePlan.leaves,cursor:0,groups:0,each:0,extra:0,group:0,children:[]};}
   else {check(c.rowIndex===c.tablePlan.rows&&c.sourceIndex===c.tablePlan.sourceCount,'Snapshot rows disappeared');if(!c.rowIndex){const first=await get(tableKey('leaf',0));queue(c,first.page,page(13,c.pageSize,[]));}c.phase='emit-parents';c.leafIndex=0;}
   return true;
  }
  check(c.previous===null||compareKey(c.previous,described.key)<0,'Portable rows changed or have duplicate primary keys');c.previous=described.key;
  const rowid=c.rowIndex+1,key=smallRecord(record([...described.key,rowid]));let planned:RowPlan;
  if(planning){
   const local=localPayload(described.value.size,c.pageSize),overflowCount=Math.ceil((described.value.size-local)/(c.pageSize-4)),cellSize=varint(described.value.size).length+varint(rowid).length+local+(overflowCount?4:0);
   if(c.leafUsed+cellSize+2>c.pageSize){check(c.rowIndex>c.leafStart);await leaf();}
   const overflow=overflowCount?{first:reserve(overflowCount),count:overflowCount}:null;planned={rowid,size:described.value.size,local,overflow,cellSize};c.leafUsed+=cellSize+2;
   check(localPayload(key.length,c.pageSize,true)===key.length,'Index key exceeds portable schema bounds');await put(tableKey('row',c.rowIndex),planned);await put(tableKey('key',c.rowIndex),pack(key));c.tablePlan.maxKeySize=Math.max(c.tablePlan.maxKeySize,key.length+varint(key.length).length);
   if(c.table===0){const kind=String(described.key[0]);if(c.kind?.name!==kind){await finishKind();c.kind={name:kind,count:0};}c.kind!.count++;}
  }else {planned=await get(tableKey('row',c.rowIndex));check(planned&&planned.rowid===rowid&&planned.size===described.value.size,'Snapshot record changed');check(pack(key)===await get(tableKey('key',c.rowIndex)),'Snapshot primary key changed');}
  const field=planning?'sourceHash':'secondHash';c[field]=add(add(c[field],varint(planned.size)),varint(rowid));c.row={key:described.key,parts:parts(described.value),part:0,offset:0,utf8:{need:0,point:0,minimum:0},plan:planned,local:'',overflow:'',overflowIndex:0,...(described.manifestId?{manifestId:described.manifestId,manifest:described.manifest}:{})};return true;
 }
 async function finishRow(planning:boolean){
  const row=c.row!;if(row.manifestId)await put(manifestKey(row.manifestId),row.manifest);
  c.rowIndex++;
  if(!planning){
   const planned=row.plan,local=unpack(row.local);check(local.length===planned.local&&row.overflowIndex===(planned.overflow?.count??0),'BLOB size changed');const pointer=planned.overflow?new Uint8Array(4):new Uint8Array();if(planned.overflow)put32(pointer,0,planned.overflow.first);const cell=join([varint(planned.size),varint(planned.rowid),local,pointer]);check(cell.length===planned.cellSize);c.cells.push(pack(cell));
   const target:LeafPlan=await get(tableKey('leaf',c.leafIndex));if(c.rowIndex===target.end){queue(c,target.page,page(13,c.pageSize,c.cells.map(unpack)));c.cells=[];c.leafIndex++;}
  }
  c.row=null;
 }
 async function readRow(planning:boolean):Promise<boolean>{
  const row=c.row!;
  if(row.part===row.parts.length){if(!planning&&row.overflow){const bytes=new Uint8Array(c.pageSize);bytes.set(unpack(row.overflow));queue(c,allocate.number(row.plan.overflow!.first,row.overflowIndex++),bytes);row.overflow='';return true;}await finishRow(planning);return true;}
  const part=row.parts[row.part];if(row.offset===part.size){if(part.type==='text')utf8(row.utf8,new Uint8Array(),true);row.part++;row.offset=0;row.utf8={need:0,point:0,minimum:0};return true;}
  if(inputBytes===maxInput)return false;
  let length=Math.min(SLICE,maxInput-inputBytes,part.size-row.offset);
  if(!planning){const local=unpack(row.local).length;if(local<row.plan.local)length=Math.min(length,row.plan.local-local);else length=Math.min(length,c.pageSize-(row.overflow?unpack(row.overflow).length:4));}
  let bytes:Uint8Array;if(part.type==='bytes')bytes=unpack(part.literal).slice(row.offset,row.offset+length);else {operations++;bytes=await io.source.read(part.ref,row.offset,length);check(bytes instanceof Uint8Array&&bytes.length===length,'Portable source is missing or truncated');if(part.type==='text')utf8(row.utf8,bytes);}
  inputBytes+=bytes.length;row.offset+=bytes.length;const field=planning?'sourceHash':'secondHash';c[field]=add(c[field],bytes);if(row.manifest&&row.part===row.parts.length-1)row.manifest.hash=add(row.manifest.hash,bytes);
  if(!planning){const local=unpack(row.local);if(local.length<row.plan.local)row.local=pack(join([local,bytes]));else {check(row.plan.overflow);let overflow=row.overflow?unpack(row.overflow):new Uint8Array(4);if(!row.overflow){const next=row.overflowIndex+1<row.plan.overflow.count?allocate.number(row.plan.overflow.first,row.overflowIndex+1):0;put32(overflow,0,next);}overflow=join([overflow,bytes]);if(overflow.length===c.pageSize){queue(c,allocate.number(row.plan.overflow.first,row.overflowIndex++),overflow);row.overflow='';}else row.overflow=pack(overflow);}}
  return true;
 }
 try{
  while(operations<=maxOperations-12){
   // All planned pages, including the pending-byte lock page, are emitted once
   // at their absolute file offset. A retry only reuses the same private bytes.
   if(c.writes.length){if(outputBytes+c.pageSize>maxOutput)break;const value=c.writes.shift()!,bytes=unpack(value.data);operations++;await io.sink.write((value.page-1)*c.pageSize,bytes,await sha(bytes));c.outputHash=add(c.outputHash,bytes);outputBytes+=bytes.length;continue;}
   if(c.phase==='done')break;
   if(c.phase==='plan-rows'||c.phase==='emit-rows'){if(c.row){if(!await readRow(c.phase==='plan-rows'))break;}else await beginRow(c.phase==='plan-rows');continue;}
   if(c.phase==='plan-parents'){
    const parent=c.parent!;
    if(parent.count===1){const root=await get('level/'+c.table+'/'+parent.level+'/0');c.tablePlan.root=root.page;c.parent=null;c.phase='plan-index';const capacity=Math.floor((c.pageSize-12)/(c.tablePlan.maxKeySize+6));check(capacity>=3);let height=0;while(c.tablePlan.rows>Math.pow(capacity+1,height+1)-1)height++;c.index={cursor:0,ordinal:0,frames:[indexFrame(c.tablePlan.rows,height,true,capacity)]};continue;}
    if(!parent.groups){const capacity=Math.floor((c.pageSize-12)/15)+1;parent.groups=Math.ceil(parent.count/capacity);parent.each=Math.floor(parent.count/parent.groups);parent.extra=parent.count%parent.groups;}
    const count=parent.each+(parent.group<parent.extra?1:0);
    if(parent.children.length<count){const child=await get('level/'+c.table+'/'+parent.level+'/'+parent.cursor++);parent.children.push({page:child.page,maxRowid:child.maxRowid});continue;}
    const node={page:reserve(),children:parent.children,maxRowid:parent.children.at(-1)!.maxRowid};await put(tableKey('parent',c.tablePlan.parents++),node);await put('level/'+c.table+'/'+(parent.level+1)+'/'+parent.group,node);parent.group++;parent.children=[];
    if(parent.group===parent.groups)c.parent={level:parent.level+1,count:parent.groups,cursor:0,groups:0,each:0,extra:0,group:0,children:[]};continue;
   }
   if(c.phase==='plan-index'){
    const index=c.index!,frame=index.frames.at(-1)!,capacity=Math.floor((c.pageSize-12)/(c.tablePlan.maxKeySize+6));
    if(!frame.depth&&frame.entries.length<frame.count){frame.entries.push(await get(tableKey('key',index.cursor++)));continue;}
    if(frame.depth&&frame.children.length<frame.childCount){
     if(frame.children.length>frame.entries.length){frame.entries.push(await get(tableKey('key',index.cursor++)));continue;}
     const child=frame.next++;index.frames.push(indexFrame(frame.each+(child<frame.extra?1:0),frame.depth-1,false,capacity));continue;
    }
    const number=reserve(),node={page:number,entries:frame.entries,children:frame.children};await put(tableKey('index',index.ordinal++),node);index.frames.pop();
    if(index.frames.length){index.frames.at(-1)!.children.push(number);continue;}
    check(index.cursor===c.tablePlan.rows,'SQLite index cursor changed');c.tablePlan.indexRoot=number;c.tablePlan.indices=index.ordinal;await put('table/'+c.table,c.tablePlan);c.roots.push([TABLES[c.table],c.tablePlan.root,number]);c.counts.push(c.tablePlan.rows);c.index=null;
    if(c.table<(c.version===2?3:2)){c.table++;c.tablePlan=emptyPlan();c.sourceIndex=0;c.rowIndex=0;c.previous=null;c.leafStart=0;c.leafUsed=8;c.sourceHash=add(c.sourceHash,Uint8Array.of(c.table));c.phase='plan-rows';}else {c.phase='check-manifests';c.manifestIndex=0;}continue;
   }
   if(c.phase==='check-manifests'||c.phase==='check-manifests2'){
    if(c.manifestIndex<c.manifestCount){const id=await get('manifest-id/'+c.manifestIndex++),manifest:Manifest=await get(manifestKey(id));check(manifest&&manifest.offset===manifest.size&&hashFrom(manifest.hash).hex()===manifest.sha256,'Finalized attachment size or SHA-256 does not match its chunks');continue;}
    if(c.phase==='check-manifests'){c.summary={pageSize:c.pageSize,pages:c.nextPage-1,byteLength:(c.nextPage-1)*c.pageSize,sourceSHA256:hashFrom(c.sourceHash).hex(),counts:{entities:c.counts[0],meta:c.counts[1],attachment_chunks:c.counts[2],...(c.version===2?{content_provenance:c.counts[3]}:{})},entityKindCount:c.kindCount};c.phase='header';}
    // A separate accepted step must publish private artifact parts before readback.
    else {check(c.outputPage===c.summary!.pages+1&&hashFrom(c.secondHash).hex()===c.summary!.sourceSHA256,'Snapshot content changed during export');c.phase='verify';break;}continue;
   }
   if(c.phase==='header'){queue(c,1,headerPage(c.pageSize,c.summary!.pages,c.roots));c.phase='emit-rows';c.table=0;c.sourceIndex=0;c.rowIndex=0;c.previous=null;c.leafIndex=0;c.cells=[];c.tablePlan=await get('table/0');c.secondHash=add(c.secondHash,Uint8Array.of(0));continue;}
   if(c.phase==='emit-parents'){
    if(c.leafIndex<c.tablePlan.parents){const node=await get(tableKey('parent',c.leafIndex++)),cells=node.children.slice(0,-1).map((child:RefNode)=>{const bytes=new Uint8Array(4);put32(bytes,0,child.page);return join([bytes,varint(child.maxRowid)]);});queue(c,node.page,page(5,c.pageSize,cells,node.children.at(-1).page));continue;}c.phase='emit-index';c.leafIndex=0;continue;
   }
   if(c.phase==='emit-index'){
    if(c.leafIndex<c.tablePlan.indices){const node=await get(tableKey('index',c.leafIndex++)),cells=node.entries.map((entry:string,i:number)=>{const bytes=unpack(entry),content=join([varint(bytes.length),bytes]);if(!node.children.length)return content;const pointer=new Uint8Array(4);put32(pointer,0,node.children[i]);return join([pointer,content]);});queue(c,node.page,page(node.children.length?2:10,c.pageSize,cells,node.children.at(-1)));continue;}
    if(c.table<(c.version===2?3:2)){c.table++;c.sourceIndex=0;c.rowIndex=0;c.previous=null;c.leafIndex=0;c.cells=[];c.tablePlan=await get('table/'+c.table);c.secondHash=add(c.secondHash,Uint8Array.of(c.table));c.phase='emit-rows';}else {c.phase='check-manifests2';c.manifestIndex=0;}continue;
   }
   if(c.phase==='verify'){
    if(c.verifyOffset===c.summary!.byteLength){check(hashFrom(c.verifyHash).hex()===hashFrom(c.outputHash).hex(),'Private SQLite output changed');c.sha256=hashFrom(c.outputHash).hex();c.phase='done';continue;}
    if(inputBytes===maxInput)break;const length=Math.min(SLICE,maxInput-inputBytes,c.summary!.byteLength-c.verifyOffset);operations++;const bytes=await io.sink.read(c.verifyOffset,length);check(bytes instanceof Uint8Array&&bytes.length===length,'Private SQLite output is truncated');
    if(!c.verifyOffset){check(length>=100&&new TextDecoder().decode(bytes.subarray(0,16))==='SQLite format 3\u0000','Invalid private SQLite header');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);check(view.getUint32(28)===c.summary!.pages&&view.getUint16(16)===(c.pageSize===65536?1:c.pageSize),'Invalid private SQLite size');}
    c.verifyHash=add(c.verifyHash,bytes);await put('verified/'+c.verifyOffset,{size:length,sha256:await sha(bytes)});c.verifyOffset+=length;inputBytes+=length;continue;
   }
   check(false,'Invalid SQLite phase');
  }
  c.nextPage=allocate.next;c.sequence++;
  check(inputBytes<=maxInput&&outputBytes<=maxOutput&&operations<=maxOperations,'SQLite step exceeded its work budget');
  return {checkpoint:c,completed:c.phase==='done',summary:c.phase==='done'?c.summary:null,sha256:c.phase==='done'?c.sha256:null,work:{inputBytes,outputBytes,operations}};
 }catch(error){throw error instanceof SQLiteBackupError?error:new SQLiteBackupError('Private resumable SQLite backup could not complete');}
}
