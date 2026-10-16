/** Dependency-free SQLite 3 bulk writer for the exact portable Fountain schema.
 * Format authority: https://sqlite.org/fileformat.html (B-trees/records/overflow).
 * Two passes over a stable snapshot; append-only output in bounded page writes.
 * The sink is PRIVATE STAGING: publish only after close succeeds. abort discards
 * partial output if the second pass differs, fails, or loses authorization.
 */
import {IncrementalSHA256} from './storage.ts';

export const SQLITE_DEFINITIONS={
  entities:'CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id))',
  meta:'CREATE TABLE meta (key TEXT PRIMARY KEY, data TEXT NOT NULL)',
  attachment_chunks:'CREATE TABLE attachment_chunks (attachment_id TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(attachment_id,offset))',
} as const;
export const SQLITE_PRIVATE_KINDS=new Set(['session','clipboard','upload','presence']);
const OMIT_META=new Set(['local_cache_binding','attachment_file_root','attachment_file_gc_cursor']);
const CHUNK_SIZE=4*1024*1024,MAX_ATTACHMENT=5_000_000_000,SLICE=65536;
type Rows<T>=()=>AsyncIterable<T>|Iterable<T>;
export type BackupBlob={size:number;open:()=>AsyncIterable<Uint8Array>|Iterable<Uint8Array>};
export type BackupEntity={kind:string;id:string;data:string|Record<string,unknown>;created_at:string;updated_at:string};
export type BackupMeta={key:string;data:string|unknown};
export type BackupChunk={attachment_id:string;offset:number;data:Uint8Array|BackupBlob};
export type SQLiteBackupSource={entities:Rows<BackupEntity>;meta:Rows<BackupMeta>;chunks:Rows<BackupChunk>};
export type SQLiteBackupSummary={pageSize:number;pages:number;byteLength:number;sourceSHA256:string;counts:{entities:number;meta:number;attachment_chunks:number};entityKinds:Record<string,number>};
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
type NormalizedSnapshot={manifests:Map<string,Manifest>;kinds:Record<string,number>};
async function* entities(source:SQLiteBackupSource,state:NormalizedSnapshot):AsyncGenerator<NormalizedRow>{
  for await(const row of source.entities()){
    check(row&&typeof row==='object'&&Object.keys(row).length===5&&['kind','id','data','created_at','updated_at'].every(key=>Object.hasOwn(row,key)));validText(row.kind);if(SQLITE_PRIVATE_KINDS.has(row.kind)||row.kind==='attachment_chunk')continue;
    check(/^[a-z][a-z0-9_]{0,63}$/.test(row.kind));validText(row.id);check(Array.from(row.id).length>0&&Array.from(row.id).length<=160);validText(row.created_at);validText(row.updated_at);
    const data=jsonText(row.data);let parsed:any;try{parsed=JSON.parse(data);}catch{throw new SQLiteBackupError('Invalid JSON entity');}check(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&parsed.id===row.id,'Entity identity mismatch');
    if(row.kind==='attachment'&&parsed.storage==='chunks'){check(Number.isSafeInteger(parsed.size)&&parsed.size>=0&&parsed.size<=MAX_ATTACHMENT&&typeof parsed.sha256==='string'&&/^[a-f0-9]{64}$/.test(parsed.sha256),'Invalid finalized attachment manifest');check(!state.manifests.has(row.id),'Duplicate attachment');state.manifests.set(row.id,{size:parsed.size,sha256:parsed.sha256,offset:0,hash:new IncrementalSHA256()});}
    Object.defineProperty(state.kinds,row.kind,{value:(Object.hasOwn(state.kinds,row.kind)?state.kinds[row.kind]:0)+1,writable:true,enumerable:true,configurable:true});yield {key:[row.kind,row.id],record:record([row.kind,row.id,data,row.created_at,row.updated_at]),kind:row.kind};
  }
}
async function* metadata(source:SQLiteBackupSource):AsyncGenerator<NormalizedRow>{for await(const row of source.meta()){check(row&&typeof row==='object'&&Object.keys(row).length===2&&['key','data'].every(key=>Object.hasOwn(row,key)));validText(row.key);if(OMIT_META.has(row.key))continue;check(Array.from(row.key).length>0&&Array.from(row.key).length<=160);yield {key:[row.key],record:record([row.key,jsonText(row.data)])};}}
async function* chunks(source:SQLiteBackupSource,state:NormalizedSnapshot):AsyncGenerator<NormalizedRow>{
  for await(const row of source.chunks()){
    check(row&&typeof row==='object'&&Object.keys(row).length===3&&['attachment_id','offset','data'].every(key=>Object.hasOwn(row,key)));validText(row.attachment_id);const manifest=state.manifests.get(row.attachment_id);if(!manifest)continue;
    check(Number.isSafeInteger(row.offset)&&row.offset===manifest.offset&&row.offset<manifest.size,'Attachment chunks are noncontiguous');const size=row.data instanceof Uint8Array?row.data.length:row.data?.size;
    check(size===Math.min(CHUNK_SIZE,manifest.size-row.offset),'Attachment chunk has incorrect size');manifest.offset+=size;
    yield {key:[row.attachment_id,row.offset],record:record([row.attachment_id,row.offset,row.data]),attachment:manifest};
  }
  for(const manifest of state.manifests.values())check(manifest.offset===manifest.size&&manifest.hash.hex()===manifest.sha256,'Finalized attachment size or SHA-256 does not match its chunks');
}
type Overflow={first:number;count:number};
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
      const allocate=new Allocator(this.pageSize),firstHash=new IncrementalSHA256(),firstState:NormalizedSnapshot={manifests:new Map(),kinds:{}},plans:TablePlan[]=[];let planBytes=0;
      const readers=[entities,metadata,chunks] as const;
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
      const pages=allocate.next-1,summary:SQLiteBackupSummary={pageSize:this.pageSize,pages,byteLength:pages*this.pageSize,sourceSHA256:firstHash.hex(),counts:{entities:plans[0].rows.length,meta:plans[1].rows.length,attachment_chunks:plans[2].rows.length},entityKinds:firstState.kinds};
      let emitted=1;const write=async(number:number,bytes:Uint8Array)=>{if(emitted===allocate.lockPage&&number===emitted+1){await sink.write(new Uint8Array(this.pageSize));emitted++;}check(number===emitted&&bytes.length===this.pageSize,'SQLite page plan changed');await sink.write(bytes);emitted++;};
      await write(1,headerPage(this.pageSize,pages,['entities','meta','attachment_chunks'].map((name,index)=>[name,plans[index].root,plans[index].index.page])));
      const secondHash=new IncrementalSHA256(),secondState:NormalizedSnapshot={manifests:new Map(),kinds:{}};
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
      check(emitted===pages+1&&secondHash.hex()===summary.sourceSHA256,'Snapshot content changed during export');await sink.close?.(summary);closed=true;return summary;
    }catch(error){const safe=error instanceof SQLiteBackupError?error:new SQLiteBackupError('Portable SQLite backup could not complete');if(!closed)try{await sink.abort?.(safe);}catch{}throw safe;}
  }
}
export const writeSQLiteBackup=(source:SQLiteBackupSource,sink:SQLiteBackupSink,options:SQLiteBackupOptions={})=>new SQLiteBackupWriter(options).write(source,sink);
