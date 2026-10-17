/** Bounded synchronous portable backup. /tmp is invocation-local PRIVATE
 * staging, never a database or a durable backup artifact. Large/resumable jobs
 * require a separate persisted worker; this adapter refuses rather than truncates.
 * https://supabase.com/docs/guides/functions/ephemeral-storage
 */
import {APIError,clone,get,is_object} from './access.ts';
import type {Entity} from './access.ts';
import {AuthError} from './auth.ts';
import type {AuthContext} from './auth.ts';
import {canonicalJSON,validateContext} from './store.ts';
import type {StoreContext} from './store.ts';
import {storeContext} from './transaction.ts';
import {IncrementalSHA256,CHUNK_SIZE,MAX_FILE_SIZE} from './storage.ts';
import type {ChunkManifest} from './storage.ts';
import {SQLiteBackupWriter,SQLiteBackupError,validateBackupProvenance,VAULT_COLUMNS,validateBackupVaultRow,ACTIVITY_COLUMNS,ACTIVITY_KEYS,validateBackupActivityRow} from './sqlite-backup.ts';
import type {BackupEntity,BackupMeta,BackupChunk,BackupProvenance,SQLiteBackupSource,BackupVaultRow,VaultTable,ActivityTable,BackupActivityRow} from './sqlite-backup.ts';

const READ=65536,PAGE_LIMIT=8*1024*1024,ROW_LIMIT=16*1024*1024,HASH=/^[a-f0-9]{64}$/;
const PRIVATE=new Set(['session','clipboard','upload','presence','attachment_chunk','cloud_chunk','upload_gc','upload_migration']);
const PRIVATE_META=new Set(['local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved']);
const FINGERPRINT=['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at'];
const enc=new TextEncoder();
export class BackupError extends APIError{
  code:string;
  constructor(status=503,code='BACKUP_UNAVAILABLE'){
    const message=status===413?'현재 동기 백업 용량 제한을 초과합니다. 원본은 유지됩니다.':status===401?'로그인 세션을 다시 확인해 주세요.':status===403?'백업 권한이 변경되었거나 내보내기가 비활성화되었습니다.':status===409?'백업 원본이 변경되었습니다. 다시 시도해 주세요.':code==='BACKUP_MIGRATION_REQUIRED'?'첨부 원본의 검증된 이전이 필요합니다. 원본은 유지됩니다.':'전체 백업을 생성하지 못했습니다. 원본은 유지됩니다.';
    super(status,message);this.name='BackupError';this.code=code;
  }
}
function check(value:unknown,status=503,code='BACKUP_SOURCE_INVALID'):asserts value{if(!value)throw new BackupError(status,code);}
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
function exact(value:unknown,fields:string[]):asserts value is Entity{check(is_object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key)));}
function id(value:unknown,max=160):asserts value is string{check(typeof value==='string'&&Array.from(value).length>0&&Array.from(value).length<=max&&!/[\x00-\x1f\x7f]/.test(value));}
function safe(error:unknown):BackupError{if(error instanceof BackupError)return error;if(error instanceof APIError||error instanceof AuthError)return new BackupError([401,403,409,413].includes(error.status)?error.status:503);if(error instanceof SQLiteBackupError&&/limit|exceeds/.test(error.message))return new BackupError(413);return new BackupError();}
async function sha(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
export type BackupAuthority={context:StoreContext;revision:number};
export type BackupPage=BackupAuthority&{contentRevision?:number;portableFormat?:4;activityFence?:{version:1;sha256:string};items:unknown[];nextCursor:unknown|null};
export interface BackupProvider{
  gate(context:StoreContext,signal?:AbortSignal):Promise<BackupAuthority>;
  exportPage(context:StoreContext,expectedRevision?:number,cursor?:unknown,signal?:AbortSignal):Promise<BackupPage>;
}
/** No caller-selected path or download nonce crosses this interface. */
export interface TemporaryBackupFile{
  append(bytes:Uint8Array):Promise<void>;
  finish():Promise<number>;
  read(offset:number,length:number):Promise<Uint8Array>;
  dispose():Promise<void>;
}
export interface TemporaryBackupStore{create():Promise<TemporaryBackupFile>;}
type RuntimeFile={write(bytes:Uint8Array):Promise<number>;read(bytes:Uint8Array):Promise<number|null>;seek(offset:number,whence:number):Promise<number>;sync():Promise<void>;stat():Promise<{size:number}>;close():void};
type Runtime={makeTempDir(options:{dir:string;prefix:string}):Promise<string>;open(path:string,options:{read:boolean;write:boolean;createNew:boolean;mode:number}):Promise<RuntimeFile>;remove(path:string,options:{recursive:boolean}):Promise<void>};
export function createDenoTemporaryStore(runtime:Runtime=(globalThis as any).Deno):TemporaryBackupStore{
  return {async create(){
    check(runtime&&typeof runtime.makeTempDir==='function'&&typeof runtime.open==='function'&&typeof runtime.remove==='function');
    const directory=await runtime.makeTempDir({dir:'/tmp',prefix:'fountain-backup-'});let file:RuntimeFile;
    try{file=await runtime.open(directory+'/backup.db',{read:true,write:true,createNew:true,mode:0o600});}catch{await runtime.remove(directory,{recursive:true}).catch(()=>{});throw new BackupError();}
    let finished=false,disposed=false,closed=false;
    return {
      async append(bytes){check(!finished&&!disposed&&bytes instanceof Uint8Array&&bytes.length<=READ);let offset=0;while(offset<bytes.length){const written=await file.write(bytes.subarray(offset));check(Number.isInteger(written)&&written>0&&written<=bytes.length-offset);offset+=written;}},
      async finish(){check(!finished&&!disposed);await file.sync();const stat=await file.stat();check(integer(stat.size));finished=true;return stat.size;},
      async read(offset,length){check(finished&&!disposed&&integer(offset)&&integer(length)&&length<=READ);await file.seek(offset,0);const bytes=new Uint8Array(length);let used=0;while(used<length){const size=await file.read(bytes.subarray(used));check(size!==null&&Number.isInteger(size)&&size>0&&size<=length-used);used+=size;}return bytes;},
      async dispose(){if(disposed)return;if(!closed){closed=true;file.close();}await runtime.remove(directory,{recursive:true});disposed=true;},
    };
  }};
}
function activityFence(value:unknown):asserts value is {version:1;sha256:string}{exact(value,['version','sha256']);check(value.version===1&&typeof value.sha256==='string'&&HASH.test(value.sha256));}
function pageFields(value:Entity):string[]{const fields=['context','revision',...(Object.hasOwn(value,'contentRevision')?['contentRevision']:[]),'items','nextCursor'];if(Object.hasOwn(value,'portableFormat')||Object.hasOwn(value,'activityFence')){check(value.portableFormat===4&&Object.hasOwn(value,'contentRevision'));activityFence(value.activityFence);fields.push('portableFormat','activityFence');}return fields;}
function cursor(value:unknown):void{
  check(is_object(value));exact(value,[...(Object.hasOwn(value,'contentRevision')?['phase','kind','id','offset','part','scope','contentRevision']:['phase','kind','id','offset','part','scope']),...(Object.hasOwn(value,'portableFormat')||Object.hasOwn(value,'activityFence')?['portableFormat','activityFence']:[])]);if(Object.hasOwn(value,'portableFormat')){check(value.portableFormat===4&&Object.hasOwn(value,'contentRevision'));activityFence(value.activityFence);}if(Object.hasOwn(value,'contentRevision'))check(integer(value.contentRevision));check(integer(value.phase)&&value.phase<=(value.portableFormat===4?13:9)&&typeof value.kind==='string'&&value.kind.length<=64&&integer(value.offset)&&value.offset<=MAX_FILE_SIZE&&integer(value.part)&&value.part<=(value.phase>=4?256:128)&&typeof value.scope==='string'&&HASH.test(value.scope));id(value.id,value.phase>=4?2048:160);
  check(value.phase>=4?value.kind===''&&value.offset===0:(value.phase===0||value.phase===3)?/^[a-z][a-z0-9_]{0,63}$/.test(value.kind)&&value.offset===0:value.kind===''&&(value.phase===1?value.offset===0:value.part===0));
}
function authority(value:unknown,expected:StoreContext):asserts value is BackupAuthority{exact(value,['context','revision']);check(integer(value.revision)&&canonicalJSON(validateContext(value.context))===canonicalJSON(expected));}

export function createBackupProvider(config:{supabaseUrl:string;serviceKey:string;fetch?:typeof fetch;timeoutMs?:number}):BackupProvider{
  let origin:string;const headers:Record<string,string>={'Content-Type':'application/json'};
  try{const url=new URL(config.supabaseUrl);check((url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/');origin=url.origin;check(typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);headers.apikey=config.serviceKey;
    if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
    else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)));check(JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-parts[1].length%4)%4))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
  }catch{throw new BackupError();}
  const request=config.fetch??fetch,timeout=config.timeoutMs??15000;check(integer(timeout)&&timeout>0&&timeout<=30000);
  async function rpc(name:string,parameters:Entity,signal?:AbortSignal):Promise<any>{
    try{
      const response=await request(origin+'/rest/v1/rpc/fountain_cloud_backup_'+name,{method:'POST',headers:{...headers},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),body:JSON.stringify(parameters)});
      if(response.status!==200||response.redirected){await response.body?.cancel().catch(()=>{});throw new BackupError([401,403,409,413].includes(response.status)?response.status:503);}
      const reader=response.body?.getReader();check(reader!==undefined);let size=0;const parts:Uint8Array[]=[];
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=PAGE_LIMIT,413);parts.push(part.value);}const bytes=new Uint8Array(size);let position=0;for(const part of parts){bytes.set(part,position);position+=part.length;}return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    }catch(error){throw safe(error);}
  }
  return {
    async gate(context,signal){context=validateContext(context);const value=await rpc('authorize',{p_context:context},signal);authority(value,context);return value;},
    async exportPage(context,expectedRevision,c,signal){context=validateContext(context);check(expectedRevision===undefined||integer(expectedRevision));if(c!==undefined&&c!==null)cursor(c);const value=await rpc('export',{p_context:context,p_expected_revision:expectedRevision??null,p_cursor:c??null},signal);exact(value,pageFields(value));if(Object.hasOwn(value,'contentRevision'))check(integer(value.contentRevision));authority({context:value.context,revision:value.revision},context);check(Array.isArray(value.items)&&value.items.length<=256);if(value.nextCursor!==null)cursor(value.nextCursor);return value;},
  };
}
function decodeBase64(value:unknown,size:number,maximum=CHUNK_SIZE):Uint8Array{
  check(typeof value==='string'&&value.length%4===0&&integer(size)&&size<=maximum);const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,end=value.length-padding;check(value.length/4*3-padding===size);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';for(let i=0;i<end;i++)check(alphabet.includes(value[i]));for(let i=end;i<value.length;i++)check(value[i]==='=');if(padding)check(alphabet.indexOf(value[end-1])%(padding===2?16:4)===0);
  let raw:string;try{raw=atob(value);}catch{throw new BackupError();}check(raw.length===size);const bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=raw.charCodeAt(i);return bytes;
}
type Collected={entities:BackupEntity[];meta:BackupMeta[];chunks:Map<string,Uint8Array>;provenance?:BackupProvenance[];vault?:Record<VaultTable,BackupVaultRow[]>;activity?:Record<ActivityTable,BackupActivityRow[]>;revision:number};
async function collect(provider:BackupProvider,context:StoreContext,gate:()=>Promise<void>,maximum:number,signal:AbortSignal):Promise<Collected>{
  const entities:BackupEntity[]=[],meta:BackupMeta[]=[],chunks=new Map<string,Uint8Array>(),seen=new Set<string>(),cursors=new Set<string>();let revision:number|undefined,contentRevision:number|undefined,provenance:BackupProvenance[]|undefined,vault:Record<VaultTable,BackupVaultRow[]>|undefined,activity:Record<ActivityTable,BackupActivityRow[]>|undefined,fence:string|undefined,activityMode:boolean|undefined,c:unknown=undefined,size=0,assembly:{header:Entity;parts:string[];bytes:number;next:number}|null=null,previous:string|null=null;
  for(let pages=0;pages<4096;pages++){
    await gate();const page=await provider.exportPage(context,revision,c,signal);exact(page,pageFields(page));const nextActivityMode=page.portableFormat===4;check(activityMode===undefined||activityMode===nextActivityMode,409);activityMode=nextActivityMode;if(Object.hasOwn(page,'contentRevision')){check(integer(page.contentRevision));check(contentRevision===undefined||contentRevision===page.contentRevision,409);contentRevision=page.contentRevision;provenance??=[];}else check(contentRevision===undefined,409);if(page.portableFormat===4){activityFence(page.activityFence);const next=canonicalJSON(page.activityFence);check(fence===undefined||fence===next,409);fence=next;activity??=Object.fromEntries(Object.keys(ACTIVITY_COLUMNS).map(name=>[name,[]])) as Record<ActivityTable,BackupActivityRow[]>;}else check(fence===undefined,409);authority({context:page.context,revision:page.revision},context);check(revision===undefined||page.revision===revision,409);revision=page.revision;check(Array.isArray(page.items)&&page.items.length<=256&&enc.encode(JSON.stringify(page)).length<=PAGE_LIMIT,413);
    for(const item of page.items){
      check(is_object(item));size+=enc.encode(JSON.stringify(item)).length;check(size<=maximum,413);
      if(item.type==='activity'){check(assembly===null&&activity!==undefined&&page.portableFormat===4);exact(item,['type','table','value']);check(typeof item.table==='string'&&Object.hasOwn(ACTIVITY_COLUMNS,item.table)&&enc.encode(JSON.stringify(item)).length<=4096);validateBackupActivityRow(item.table as ActivityTable,item.value);const key=canonicalJSON(['activity',item.table,...ACTIVITY_KEYS[item.table as ActivityTable].map(key=>item.value[key])]);check(!seen.has(key));seen.add(key);activity[item.table as ActivityTable].push(clone(item.value));continue;}
      if(item.type==='provenance'){check(assembly===null&&provenance!==undefined);exact(item,['type','value']);validateBackupProvenance(item.value);const key=canonicalJSON(['provenance',item.value.kind,item.value.id]);check(!seen.has(key));seen.add(key);provenance.push(clone(item.value));continue;}
      if(item.type==='chunk'){
        check(assembly===null);exact(item,['type','attachmentId','offset','size','base64']);id(item.attachmentId);check(integer(item.offset)&&item.offset<MAX_FILE_SIZE&&item.offset%CHUNK_SIZE===0&&integer(item.size)&&item.size>0&&item.size<=CHUNK_SIZE);const key=canonicalJSON([item.attachmentId,item.offset]);check(!chunks.has(key));chunks.set(key,decodeBase64(item.base64,item.size));continue;
      }
      const retained=item.type==='vault';
      if(retained){check(contentRevision!==undefined);exact(item,['type','table','key','value','part','parts','dataPart']);check(typeof item.table==='string'&&Object.hasOwn(VAULT_COLUMNS,item.table)&&Array.isArray(item.key)&&item.key.length>=1&&item.key.length<=5&&is_object(item.value)&&!Object.hasOwn(item.value,'data')&&enc.encode(JSON.stringify(item.value)).length<=8192);vault??=Object.fromEntries(Object.keys(VAULT_COLUMNS).map(name=>[name,[]])) as Record<VaultTable,BackupVaultRow[]>;}
      const entity=item.type==='entity';check(entity||retained||item.type==='meta');if(!retained)exact(item,entity?['type','kind','id','createdAt','updatedAt','part','parts','dataPart']:['type','key','part','parts','dataPart']);
      if(entity){check(typeof item.kind==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(item.kind));id(item.id);check(typeof item.createdAt==='string'&&item.createdAt.length>0&&item.createdAt.length<=64&&typeof item.updatedAt==='string'&&item.updatedAt.length>0&&item.updatedAt.length<=64);}else if(!retained)id(item.key);
      check(integer(item.part)&&integer(item.parts)&&item.parts>=1&&item.parts<=(retained?256:128)&&item.part<item.parts&&typeof item.dataPart==='string'&&enc.encode(item.dataPart).length<=1048576);
      const header=Object.fromEntries(Object.entries(item).filter(([key])=>!['part','dataPart'].includes(key))),key=canonicalJSON(retained?['vault',item.table,item.key]:entity?['entity',item.kind,item.id]:['meta',item.key]);
      if(item.part===0){check(assembly===null&&!seen.has(key));assembly={header,parts:[],bytes:0,next:0};previous=key;}
      check(assembly!==null&&previous===key&&canonicalJSON(assembly.header)===canonicalJSON(header)&&item.part===assembly.next);assembly.parts.push(item.dataPart);assembly.bytes+=enc.encode(item.dataPart).length;assembly.next++;check(assembly.bytes<=ROW_LIMIT,413);
      if(assembly.next===item.parts){const data=assembly.parts.join('');let parsed:any;try{parsed=retained?VAULT_COLUMNS[item.table as VaultTable].includes('data' as never)?{...item.value,data}:item.value:JSON.parse(data);}catch{throw new BackupError();}if(retained){check(VAULT_COLUMNS[item.table as VaultTable].includes('data' as never)||data==='');validateBackupVaultRow(item.table,parsed);if(typeof parsed.data==='string')check(enc.encode(parsed.data).length<=ROW_LIMIT,413);vault![item.table as VaultTable].push(parsed);}else if(entity){check(is_object(parsed)&&parsed.id===item.id);if(!PRIVATE.has(item.kind))entities.push({kind:item.kind,id:item.id,data,created_at:item.createdAt,updated_at:item.updatedAt});}else if(!PRIVATE_META.has(item.key))meta.push({key:item.key,data});seen.add(key);assembly=null;}
    }
    if(page.nextCursor===null){check(assembly===null);return {entities,meta,chunks,provenance,vault,activity,revision};}
    check(page.items.length>0);cursor(page.nextCursor);if(fence!==undefined){check(is_object(page.nextCursor)&&page.nextCursor.portableFormat===4&&canonicalJSON(page.nextCursor.activityFence)===fence,409);}const next=canonicalJSON(page.nextCursor);check(!cursors.has(next));cursors.add(next);c=clone(page.nextCursor);
  }
  throw new BackupError(413);
}
function sourceFingerprint(item:Entity):string{return canonicalJSON(Object.fromEntries(FINGERPRINT.map(key=>[key,item[key]??null])));}
/** Patch only top-level transport fields, preserving raw JSON number lexemes
 * and every unrelated field (JSON.parse/stringify would round large integers). */
function patchJSON(raw:string,remove:string[],replace:Entity={}):string{
  raw=raw.trim();check(raw.startsWith('{')&&raw.endsWith('}'));const values:string[]=[],replaced=new Set<string>();let index=1;
  const spaces=()=>{while(/\s/.test(raw[index]??''))index++;};
  spaces();while(raw[index]!=='}'){
    check(raw[index]==='"');const start=index++;let escaped=false;for(;index<raw.length;index++){const char=raw[index];if(!escaped&&char==='"'){index++;break;}if(!escaped&&char==='\\')escaped=true;else escaped=false;}
    const key=JSON.parse(raw.slice(start,index));spaces();check(raw[index++]===':');spaces();const first=index;let depth=0,quoted=false;escaped=false;
    for(;index<raw.length;index++){const char=raw[index];if(quoted){if(!escaped&&char==='"')quoted=false;if(!escaped&&char==='\\')escaped=true;else escaped=false;continue;}if(char==='"'){quoted=true;continue;}if(char==='['||char==='{')depth++;else if(char===']'||char==='}'){if(depth)depth--;else break;}else if(char===','&&!depth)break;}
    check(index<raw.length);if(Object.hasOwn(replace,key)){if(!replaced.has(key))values.push(JSON.stringify(key)+':'+JSON.stringify(replace[key]));replaced.add(key);}else if(!remove.includes(key))values.push(JSON.stringify(key)+':'+raw.slice(first,index).trim());if(raw[index]===','){index++;spaces();}else break;
  }
  for(const [key,value]of Object.entries(replace))if(!replaced.has(key))values.push(JSON.stringify(key)+':'+JSON.stringify(value));return '{'+values.join(',')+'}';
}
function manifests(file:Entity,physical:string):ChunkManifest[]{
  check(Array.isArray(file.cloud_chunks)&&file.cloud_chunks.length<=Math.ceil(MAX_FILE_SIZE/CHUNK_SIZE));let offset=0;
  const result=file.cloud_chunks.map((item:unknown)=>{exact(item,['version','attachmentId','offset','size','sha256']);check(item.version===1&&item.attachmentId===physical&&integer(item.offset)&&item.offset===offset&&item.offset%CHUNK_SIZE===0&&integer(item.size)&&item.size===Math.min(CHUNK_SIZE,file.size-offset)&&item.size>0&&typeof item.sha256==='string'&&HASH.test(item.sha256));offset+=item.size;return clone(item) as ChunkManifest;});check(offset===file.size);return result;
}
function compare(a:string,b:string){const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const delta=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(delta)return delta;}return x.length-y.length;}
async function portable(snapshot:Collected,storage:{readChunk(item:ChunkManifest,gate:()=>Promise<void>,signal?:AbortSignal):Promise<Uint8Array>},gate:()=>Promise<void>,maximum:number,signal:AbortSignal):Promise<SQLiteBackupSource>{
  const overlays=new Map<string,Entity>(),originals=new Map<string,BackupEntity>(),rows:BackupEntity[]=[],meta=[...snapshot.meta],chunks:BackupChunk[]=[];let minimum=0;
  for(const row of snapshot.entities){if(row.kind==='attachment_cloud'){const value=JSON.parse(row.data as string);check(!overlays.has(row.id));overlays.set(row.id,value);}else {rows.push({...row});if(row.kind==='attachment')originals.set(row.id,row);}}
  for(const [identity]of overlays)check(originals.has(identity));
  for(const row of rows){
    if(row.kind!=='attachment'){minimum+=enc.encode(row.data as string).length;continue;}
    const original=JSON.parse(row.data as string);check(is_object(original)&&integer(original.size)&&original.size<=MAX_FILE_SIZE);id(original.name,255);check(original.mime===undefined||typeof original.mime==='string'&&original.mime.length>0&&original.mime.length<=255);if(original.sha256!==undefined)check(typeof original.sha256==='string'&&HASH.test(original.sha256));
    let file=original;const overlay=overlays.get(row.id);
    if(overlay){
      const allowed=new Set([...FINGERPRINT,'storage_id','cloud_chunks','source_fingerprint']);check(Object.keys(overlay).every(key=>allowed.has(key))&&overlay.id===row.id&&typeof overlay.source_fingerprint==='string'&&overlay.source_fingerprint.length<=8192);
      let fingerprint:unknown;try{fingerprint=JSON.parse(overlay.source_fingerprint);}catch{throw new BackupError();}exact(fingerprint,FINGERPRINT);check(canonicalJSON(fingerprint)===overlay.source_fingerprint&&overlay.source_fingerprint===sourceFingerprint(original),409);
      for(const key of ['id','owner_id','page_id','name','size','mime'])check(canonicalJSON(overlay[key]??null)===canonicalJSON(original[key]??null));check(overlay.storage==='chunks'&&typeof overlay.sha256==='string'&&HASH.test(overlay.sha256));if(original.sha256!==undefined)check(original.sha256===overlay.sha256,409);file=overlay;
      if((original.storage??'inline')==='inline'&&typeof original.data==='string')check(await sha(decodeBase64(original.data,original.size,5_000_000))===overlay.sha256,409);
    }
    check(!Object.hasOwn(file,'cloud_chunks')||Array.isArray(file.cloud_chunks));
    if(Array.isArray(file.cloud_chunks)){
      check(file.storage==='chunks'&&typeof file.sha256==='string'&&HASH.test(file.sha256));const physical=file.storage_id??file.id;id(physical);const items=manifests(file,physical);row.data=patchJSON(row.data as string,['cloud_chunks','storage_id','source_fingerprint','data'],{storage:'chunks',sha256:file.sha256,size:file.size});minimum+=file.size+enc.encode(row.data).length;
      for(const item of items){const portableBytes=snapshot.chunks.get(canonicalJSON([row.id,item.offset]));if(portableBytes!==undefined)check(portableBytes.length===item.size&&await sha(portableBytes)===item.sha256);chunks.push({attachment_id:row.id,offset:item.offset,data:{size:item.size,async *open(){await gate();const bytes=portableBytes??await storage.readChunk(clone(item),gate,signal);check(bytes instanceof Uint8Array&&bytes.length===item.size&&await sha(bytes)===item.sha256);for(let offset=0;offset<bytes.length;offset+=READ)yield bytes.subarray(offset,Math.min(offset+READ,bytes.length));}}});}
    }else if((original.storage??'inline')==='inline'){
      check(overlay===undefined&&typeof original.data==='string',503,'BACKUP_MIGRATION_REQUIRED');const bytes=decodeBase64(original.data,original.size,5_000_000);if(original.sha256!==undefined)check(await sha(bytes)===original.sha256);minimum+=enc.encode(row.data as string).length;
    }else{
      check(original.storage==='chunks'&&typeof original.sha256==='string'&&HASH.test(original.sha256));let offset=0;while(offset<original.size){const data=snapshot.chunks.get(canonicalJSON([row.id,offset]));check(data!==undefined&&data.length===Math.min(CHUNK_SIZE,original.size-offset),503,'BACKUP_MIGRATION_REQUIRED');chunks.push({attachment_id:row.id,offset,data});offset+=data.length;}minimum+=original.size+enc.encode(row.data as string).length;
    }
    if(!Array.isArray(file.cloud_chunks)&&['storage_id','source_fingerprint'].some(key=>Object.hasOwn(original,key)))row.data=patchJSON(row.data as string,['cloud_chunks','storage_id','source_fingerprint']);
  }
  if(snapshot.activity)for(const rows of Object.values(snapshot.activity))for(const row of rows)minimum+=enc.encode(JSON.stringify(row)).length;
  for(const item of snapshot.provenance??[])minimum+=enc.encode(JSON.stringify(item)).length;
  for(const item of meta)minimum+=enc.encode(item.data as string).length;check(minimum<=maximum,413);
  if(snapshot.vault){
    const recordIds=new Set(snapshot.vault.retention_entities.filter(row=>['attachment','attachment_cloud'].includes(row.kind as string)).map(row=>row.record_id));
    const known=new Set(chunks.map(row=>canonicalJSON([row.attachment_id,row.offset])));
    for(const recordId of recordIds){
      const archived=snapshot.vault.retention_entities.filter(row=>row.record_id===recordId&&['attachment','attachment_cloud'].includes(row.kind as string)).map(row=>({kind:row.kind as string,id:row.id as string,data:row.data as string,created_at:row.created_at as string,updated_at:row.updated_at as string}));
      const child=await portable({entities:archived,meta:[],chunks:snapshot.chunks,revision:snapshot.revision},storage,gate,maximum,signal);
      for await(const row of child.chunks()){const key=canonicalJSON([row.attachment_id,row.offset]);if(!known.has(key)){known.add(key);chunks.push(row);minimum+=row.data instanceof Uint8Array?row.data.length:row.data.size;}}
    }
    for(const values of Object.values(snapshot.vault))for(const row of values)minimum+=enc.encode(JSON.stringify(row)).length;
    check(minimum<=maximum,413);
  }
  rows.sort((a,b)=>compare(a.kind,b.kind)||compare(a.id,b.id));meta.sort((a,b)=>compare(a.key,b.key));chunks.sort((a,b)=>compare(a.attachment_id,b.attachment_id)||a.offset-b.offset);
  return {entities:()=>rows,meta:()=>meta,chunks:()=>chunks,...(snapshot.activity?{activity:Object.fromEntries(Object.entries(snapshot.activity).map(([name,values])=>[name,()=>values])) as Record<ActivityTable,()=>BackupActivityRow[]>}:{}),...(snapshot.vault?{vault:Object.fromEntries(Object.entries(snapshot.vault).map(([name,values])=>[name,()=>values])) as Record<VaultTable,()=>BackupVaultRow[]>}:{}),...(snapshot.provenance?{provenance:()=>snapshot.provenance!.toSorted((a,b)=>compare(a.kind,b.kind)||compare(a.id,b.id))}:{})};
}
function range(value:string|null,size:number):{start:number;end:number;partial:boolean}{
  if(!value||value.split('=',1)[0].toLowerCase()!=='bytes')return {start:0,end:size,partial:false};const parts=/^bytes=(\d*)-(\d*)$/.exec(value);if(!parts||!parts[1]&&!parts[2]||!size||parts[1].length>20||parts[2].length>20)throw new BackupError(416);
  const total=BigInt(size);let start:bigint,end:bigint;if(!parts[1]){const length=BigInt(parts[2]);if(!length)throw new BackupError(416);start=length>=total?0n:total-length;end=total;}else{start=BigInt(parts[1]);const last=parts[2]?BigInt(parts[2])+1n:total;end=last>total?total:last;}if(start>=total||end<=start)throw new BackupError(416);return {start:Number(start),end:Number(end),partial:true};
}
type Config={provider:BackupProvider;storage:{readChunk(item:ChunkManifest,gate:()=>Promise<void>,signal?:AbortSignal):Promise<Uint8Array>};authorize:()=>Promise<AuthContext>;temporary?:TemporaryBackupStore;clock?:()=>number;maxSnapshotBytes?:number;maxFileBytes?:number};
export function createBackup(config:Config){
  const snapshotLimit=config.maxSnapshotBytes??32*1024*1024,fileLimit=config.maxFileBytes??64*1024*1024,clock=config.clock??Date.now;
  check(integer(snapshotLimit)&&snapshotLimit>0&&snapshotLimit<=32*1024*1024&&integer(fileLimit)&&fileLimit>=28672&&fileLimit<=64*1024*1024);
  return {async handle(request:Request,path:string,initial:AuthContext):Promise<Response|null>{
    if(path!=='/api/backup')return null;check(['GET','HEAD'].includes(request.method),405);
    let file:TemporaryBackupFile|undefined,cleaning:Promise<void>|undefined,cancelled=false,settled=false,streamController:ReadableStreamDefaultController<Uint8Array>|undefined,abort:()=>void=()=>{},generationFailure:unknown;
    const detach=()=>request.signal.removeEventListener('abort',abort);
    const cleanup=()=>cleaning??=(async()=>{if(file){try{await file.dispose();}catch{await file.dispose();}}})();
    // Error the stream before awaiting private I/O cleanup, so pending reads settle on abort.
    const failStream=(error:unknown)=>{cancelled=true;if(!settled){settled=true;detach();try{streamController?.error(safe(error));}catch{}}return cleanup();};
    try{
      const context=validateContext(storeContext(initial)),expected=canonicalJSON(context),expiresAt=initial.expiresAt;
      const gate=async()=>{try{check(!cancelled&&!request.signal.aborted,503,'BACKUP_CANCELLED');check(integer(expiresAt)&&expiresAt>clock(),401);const value=await config.provider.gate(context,request.signal);check(!cancelled&&!request.signal.aborted,503,'BACKUP_CANCELLED');authority(value,context);}catch(error){generationFailure=error;throw error;}};
      const fresh=async()=>{const current=await config.authorize();check(current&&canonicalJSON(validateContext(storeContext(current)))===expected&&current.expiresAt>clock(),401);check(current.profile.member.active===true&&current.profile.member.role==='owner',403);await gate();};
      await fresh();const snapshot=await collect(config.provider,context,gate,snapshotLimit,request.signal),source=await portable(snapshot,config.storage,gate,fileLimit,request.signal);await gate();
      file=await (config.temporary??createDenoTemporaryStore()).create();abort=()=>{void failStream(new BackupError(503,'BACKUP_CANCELLED')).catch(()=>{});};request.signal.addEventListener('abort',abort,{once:true});check(!request.signal.aborted,503,'BACKUP_CANCELLED');
      let written=0,finishedSize=-1;const outputHash=new IncrementalSHA256();
      const summary=await new SQLiteBackupWriter().write(source,{async write(bytes){try{check(bytes.length<=READ&&written+bytes.length<=fileLimit,413);if(written%READ===0)await gate();await file!.append(bytes);outputHash.update(bytes);written+=bytes.length;}catch(error){generationFailure=error;throw error;}},async close(value){try{check(value.byteLength===written);finishedSize=await file!.finish();check(finishedSize===written);}catch(error){generationFailure=error;throw error;}}}).catch(error=>{throw generationFailure??error;});
      check(summary.byteLength===written&&finishedSize===written);await fresh();
      const digest=outputHash.hex(),readback=new IncrementalSHA256(),pieces:string[]=[];
      for(let offset=0;offset<written;offset+=READ){await gate();const bytes=await file.read(offset,Math.min(READ,written-offset));check(bytes instanceof Uint8Array&&bytes.length===Math.min(READ,written-offset));if(!offset){check(new TextDecoder().decode(bytes.subarray(0,16))==='SQLite format 3\u0000');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),pageSize=view.getUint16(16)===1?65536:view.getUint16(16);check(pageSize===summary.pageSize&&view.getUint32(28)*pageSize===written);}readback.update(bytes);pieces.push(await sha(bytes));}
      check(readback.hex()===digest);await fresh();const etag='"'+digest+'"';let selected:{start:number;end:number;partial:boolean};
      try{selected=range(request.method==='HEAD'||request.headers.get('If-Range')&&request.headers.get('If-Range')!==etag?null:request.headers.get('Range'),written);}catch(error){if(!(error instanceof BackupError)||error.status!==416)throw error;await cleanup();await fresh();detach();return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+written,'Content-Length':'0','Accept-Ranges':'bytes','Cache-Control':'no-store'}});}
      const headers=new Headers({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fountain-backup.db"','Content-Length':String(selected.end-selected.start),'Accept-Ranges':'bytes','ETag':etag,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});if(selected.partial)headers.set('Content-Range','bytes '+selected.start+'-'+(selected.end-1)+'/'+written);
      if(request.method==='HEAD'){await cleanup();await fresh();detach();return new Response(null,{status:200,headers});}
      let position=selected.start;
      const body=new ReadableStream<Uint8Array>({start(controller){streamController=controller;if(cancelled||request.signal.aborted)abort();},async pull(controller){try{
        if(settled)return;await gate();if(settled)return;const start=Math.floor(position/READ)*READ,length=Math.min(READ,written-start),bytes=await file!.read(start,length);if(settled)return;check(bytes instanceof Uint8Array&&bytes.length===length&&await sha(bytes)===pieces[Math.floor(start/READ)]);const end=Math.min(selected.end,start+length),out=bytes.slice(position-start,end-start);position=end;
        if(position===selected.end)await cleanup();if(settled)return;await gate();if(settled)return;controller.enqueue(out);if(position===selected.end){settled=true;detach();controller.close();}
      }catch(error){await cleanup().catch(()=>{});await failStream(error).catch(()=>{});}},async cancel(){cancelled=true;settled=true;detach();await cleanup();}},{highWaterMark:0});
      return new Response(body,{status:selected.partial?206:200,headers});
    }catch(error){detach();await cleanup().catch(()=>{});throw safe(error);}
  }};
}
