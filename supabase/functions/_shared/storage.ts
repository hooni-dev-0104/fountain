/** Server-only private Storage transport; never serialize credentials or object URLs.
 *
 * A domain RPC must atomically reserve quota, bind the upload to its actor/page,
 * compare offset/version, persist these manifests, and advance upload.offset.
 * Object publication happens BEFORE that RPC. A lost RPC ACK must retry the same
 * transaction; it must never delete a possibly referenced object as compensation.
 * Uncommitted objects are harmless private orphans until explicit GC claims them.
 * Verification checkpoints are PRIVATE server state, never client input or proof.
 * No bucket is created and no database is mutated by this module.
 */
import {APIError} from './access.ts';
import {AuthError} from './auth.ts';

export const CHUNK_SIZE=4*1024*1024, READ_SIZE=64*1024, MAX_FILE_SIZE=5_000_000_000;
export type AccessGate=()=>void|Promise<void>;
export type ChunkManifest={version:1;attachmentId:string;offset:number;size:number;sha256:string};
export type AttachmentManifest={id:string;name:string;size:number;sha256?:string;chunks:ChunkManifest[]};
export type HashState={words:number[];bytes:number;tail:string};
export type VerificationCheckpoint={version:1;layout:string;offset:number;hash:HashState};
export type VerificationResult={completed:boolean;verifiedOffset:number;checkpoint:VerificationCheckpoint;sha256?:string};
type Config={supabaseUrl:string;serviceKey:string;bucket:string;workspaceId:string;maxObjectBytes:number;fetch?:typeof globalThis.fetch;timeoutMs?:number};
export class StorageError extends APIError {
  code:string;
  constructor(status=503,code='STORAGE_UNAVAILABLE',message='첨부 저장소에 연결할 수 없습니다.'){super(status,message);this.name='StorageError';this.code=code;}
}
const enc=new TextEncoder(), SHA=/^[a-f0-9]{64}$/;
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function check(value:unknown,status=400,code='INVALID_STORAGE_INPUT'):asserts value {if(!value)throw new StorageError(status,code,status===400?'첨부 요청을 확인해주세요.':'첨부 바이트를 확인할 수 없습니다.');}
function identity(value:unknown):asserts value is string {check(typeof value==='string'&&value.length>0&&Array.from(value).length<=160&&!/[\x00-\x1f\x7f/\\]/.test(value)&&!['.','..'].includes(value)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));}
function exact(value:unknown,keys:string[]):asserts value is Record<string,any> {check(object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)));}
async function gate(access:AccessGate):Promise<void>{
  check(typeof access==='function');
  try{const result:unknown=await access();if(result===false)throw new StorageError(403,'STORAGE_ACCESS_DENIED','첨부 권한이 변경되었습니다.');}
  catch(error){if(error instanceof APIError||error instanceof AuthError)throw error;throw new StorageError();}
}
async function digest(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function base64(bytes:Uint8Array):string {let text='';for(const v of bytes)text+=String.fromCharCode(v);return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function unbase64(text:string):Uint8Array {check(typeof text==='string'&&text.length<=84&&/^[A-Za-z0-9_-]*$/.test(text)&&text.length%4!==1);let result:Uint8Array;try{result=Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-text.length%4)%4)),c=>c.charCodeAt(0));}catch{return check(false) as never;}check(base64(result)===text);return result;}

// Incremental SHA-256, required because WebCrypto.digest buffers its whole input.
// Compression constants/bit operations follow FIPS 180-4; tests compare binary
// vectors, block boundaries and resumed states against Node's independent hash.
const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate=(v:number,n:number)=>(v>>>n)|(v<<(32-n));
export class IncrementalSHA256 {
  private words=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  private bytes=0;private tail=new Uint8Array(0);private readonly maxBytes:number;
  constructor(state?:HashState,maxBytes=MAX_FILE_SIZE){this.maxBytes=maxBytes;check(integer(maxBytes)&&maxBytes<=Math.floor(Number.MAX_SAFE_INTEGER/8)-128);if(state){exact(state,['words','bytes','tail']);check(Array.isArray(state.words)&&state.words.length===8&&state.words.every(v=>integer(v)&&v<=0xffffffff)&&integer(state.bytes)&&state.bytes<=maxBytes);const tail=unbase64(state.tail);check(tail.length===state.bytes%64);this.words=[...state.words];this.bytes=state.bytes;this.tail=tail;}}
  update(bytes:Uint8Array):void {
    check(bytes instanceof Uint8Array&&this.bytes+bytes.length<=this.maxBytes+128);this.bytes+=bytes.length;
    const pending=new Uint8Array(this.tail.length+bytes.length);pending.set(this.tail);pending.set(bytes,this.tail.length);
    const work=new Uint32Array(64);let offset=0;
    for(;offset+64<=pending.length;offset+=64){
      const view=new DataView(pending.buffer,pending.byteOffset+offset,64);for(let i=0;i<16;i++)work[i]=view.getUint32(i*4);
      for(let i=16;i<64;i++){const a=work[i-15],b=work[i-2];work[i]=(work[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+work[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
      let [a,b,c,d,e,f,g,h]=this.words;
      for(let i=0;i<64;i++){const t=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+work[i])>>>0,u=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;}
      [a,b,c,d,e,f,g,h].forEach((v,i)=>this.words[i]=(this.words[i]+v)>>>0);
    }this.tail=pending.slice(offset);
  }
  state():HashState{return {words:[...this.words],bytes:this.bytes,tail:base64(this.tail)};}
  hex():string {const copy=new IncrementalSHA256(this.state(),this.maxBytes),bits=this.bytes*8,pad=new Uint8Array(1+(56-(this.bytes+1)%64+64)%64+8);pad[0]=128;const view=new DataView(pad.buffer);view.setUint32(pad.length-8,Math.floor(bits/4294967296));view.setUint32(pad.length-4,bits>>>0);copy.update(pad);return copy.words.map(v=>v.toString(16).padStart(8,'0')).join('');}
}

/** A quota snapshot is only a preflight. The domain RPC must reserve atomically. */
export function checkQuota(size:number,quota:{limitBytes:number;usedBytes:number;reservedBytes:number}):void {
  check(integer(size)&&size<=MAX_FILE_SIZE&&object(quota)&&[quota.limitBytes,quota.usedBytes,quota.reservedBytes].every(integer));
  if(size>quota.limitBytes-quota.usedBytes-quota.reservedBytes)throw new StorageError(507,'STORAGE_CAPACITY','첨부 저장 용량이 부족합니다. 원본 파일은 유지됩니다.');
}
export function byteRange(header:string|null|undefined,size:number):{start:number;end:number;partial:boolean}{
  check(integer(size)&&size<=MAX_FILE_SIZE);if(!header)return {start:0,end:size,partial:false};
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||!size||!match[1]&&!match[2])throw new StorageError(416,'INVALID_RANGE','요청한 파일 범위를 확인해주세요.');
  const number=(value:string)=>{const n=Number(value);if(!integer(n))throw new StorageError(416,'INVALID_RANGE','요청한 파일 범위를 확인해주세요.');return n;};
  let start:number,end:number;if(!match[1]){const suffix=number(match[2]);if(!suffix)throw new StorageError(416,'INVALID_RANGE');start=Math.max(0,size-suffix);end=size;}else{start=number(match[1]);end=match[2]?Math.min(size,number(match[2])+1):size;}
  if(start>=size||end<=start)throw new StorageError(416,'INVALID_RANGE','요청한 파일 범위를 확인해주세요.');return {start,end,partial:true};
}
function chunk(value:unknown):asserts value is ChunkManifest {exact(value,['version','attachmentId','offset','size','sha256']);identity(value.attachmentId);check(value.version===1&&integer(value.offset)&&value.offset<MAX_FILE_SIZE&&value.offset%CHUNK_SIZE===0&&integer(value.size)&&value.size>0&&value.size<=CHUNK_SIZE&&value.offset+value.size<=MAX_FILE_SIZE&&typeof value.sha256==='string'&&SHA.test(value.sha256));}
function layout(value:AttachmentManifest):void {
  identity(value.id);check(typeof value.name==='string'&&value.name.length>0&&Array.from(value.name).length<=255&&!/[\x00-\x1f\x7f/\\]/.test(value.name)&&!['.','..'].includes(value.name)&&integer(value.size)&&value.size<=MAX_FILE_SIZE&&Array.isArray(value.chunks)&&value.chunks.length<=Math.ceil(MAX_FILE_SIZE/CHUNK_SIZE));
  if(value.sha256!==undefined)check(SHA.test(value.sha256));let offset=0;
  for(const item of value.chunks){chunk(item);check(item.attachmentId===value.id&&item.offset===offset&&item.size===Math.min(CHUNK_SIZE,value.size-offset),409,'STORAGE_LAYOUT');offset+=item.size;}
  check(offset===value.size,409,'STORAGE_LAYOUT');
}

export function createStorage(config:Config){
  let origin:string,headers:Record<string,string>;const request=config.fetch??globalThis.fetch,timeout=config.timeoutMs??15000;
  try{const u=new URL(config.supabaseUrl);check((u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/');origin=u.origin;
    identity(config.workspaceId);check(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.bucket)&&integer(config.maxObjectBytes)&&config.maxObjectBytes>0&&integer(timeout)&&timeout>0&&timeout<=30000&&typeof config.serviceKey==='string'&&config.serviceKey.length<=4096);
    headers={apikey:config.serviceKey,'Accept-Encoding':'identity'};
    if(config.serviceKey.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
    else{const parts=config.serviceKey.split('.');check(parts.length===3&&parts.every(v=>/^[A-Za-z0-9_-]+$/.test(v)));const claims=JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-parts[1].length%4)%4)));check(claims.role==='service_role');headers.Authorization='Bearer '+config.serviceKey;}
  }catch{throw new StorageError(503,'STORAGE_CONFIGURATION','첨부 저장소 설정을 확인해주세요.');}
  const bucket=config.bucket,workspaceId=config.workspaceId,maxObjectBytes=config.maxObjectBytes;
  async function fetchStorage(path:string,method:string,access:AccessGate,body?:BodyInit,extra:Record<string,string>={},signal?:AbortSignal):Promise<Response>{
    await gate(access);let response:Response;
    try{response=await request(origin+'/storage/v1/'+path,{method,headers:{...headers,...extra},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),...(body===undefined?{}:{body})});}
    catch{throw new StorageError();}if(response.redirected){await response.body?.cancel().catch(()=>{});throw new StorageError();}
    try{await gate(access);}catch(error){await response.body?.cancel().catch(()=>{});throw error;}return response;
  }
  async function bytes(response:Response,maximum:number,access:AccessGate):Promise<Uint8Array>{
    const length=response.headers.get('Content-Length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum)){await response.body?.cancel().catch(()=>{});throw new StorageError(409,'STORAGE_BYTES_INVALID');}
    const reader=response.body?.getReader();if(!reader)throw new StorageError(409,'STORAGE_BYTES_MISSING');const parts:Uint8Array[]=[];let size=0;
    // Provider bytes stay private until the whole bounded object is checked.
    // Public download pieces have their own fresh gate immediately before yield.
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum)throw new StorageError(409,'STORAGE_BYTES_INVALID');parts.push(part.value);}await gate(access);if(length!==null&&size!==Number(length))throw new StorageError(409,'STORAGE_BYTES_INVALID');const data=new Uint8Array(size);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}return data;}
    catch(error){await reader.cancel().catch(()=>{});if(error instanceof APIError||error instanceof AuthError)throw error;throw new StorageError(409,'STORAGE_BYTES_INVALID');}finally{reader.releaseLock();}
  }
  async function privateBucket(access:AccessGate,signal?:AbortSignal):Promise<number>{
    const response=await fetchStorage('bucket/'+bucket,'GET',access,undefined,{},signal);if(!response.ok){await response.body?.cancel().catch(()=>{});throw new StorageError(503,'STORAGE_CONFIGURATION');}
    const data=await bytes(response,65536,access);let value:Record<string,any>;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new StorageError(503,'STORAGE_CONFIGURATION');}
    if(!object(value)||value.id!==bucket||value.public!==false)throw new StorageError(503,'STORAGE_BUCKET_NOT_PRIVATE','비공개 첨부 저장소 설정이 필요합니다.');
    if(value.allowed_mime_types!=null)check(Array.isArray(value.allowed_mime_types)&&value.allowed_mime_types.some((v:string)=>v==='application/octet-stream'||v==='application/*'||v==='*/*'),413,'STORAGE_OBJECT_LIMIT');
    if(value.file_size_limit!=null)check(integer(value.file_size_limit),503,'STORAGE_CONFIGURATION');return Math.min(maxObjectBytes,value.file_size_limit??maxObjectBytes);
  }
  async function objectPath(item:ChunkManifest):Promise<string>{chunk(item);return 'v1/'+await digest(enc.encode(workspaceId))+'/'+await digest(enc.encode(item.attachmentId))+'/'+item.offset+'-'+item.sha256;}
  async function readChunk(item:ChunkManifest,access:AccessGate,signal?:AbortSignal):Promise<Uint8Array>{
    chunk(item);item=structuredClone(item);await privateBucket(access,signal);const path=await objectPath(item),response=await fetchStorage('object/authenticated/'+bucket+'/'+path,'GET',access,undefined,{},signal);
    if(response.status!==200){await response.body?.cancel().catch(()=>{});throw new StorageError(response.status===404?409:503,response.status===404?'STORAGE_BYTES_MISSING':'STORAGE_UNAVAILABLE');}
    const data=await bytes(response,item.size,access);if(data.length!==item.size||await digest(data)!==item.sha256)throw new StorageError(409,'STORAGE_HASH_MISMATCH','첨부 바이트 무결성을 확인할 수 없습니다.');await gate(access);return data;
  }
  async function writeChunk(attachmentId:string,offset:number,data:Uint8Array,access:AccessGate,signal?:AbortSignal):Promise<ChunkManifest>{
    identity(attachmentId);check(data instanceof Uint8Array&&data.length>0&&data.length<=CHUNK_SIZE&&integer(offset)&&offset%CHUNK_SIZE===0&&offset+data.length<=MAX_FILE_SIZE);data=new Uint8Array(data);await gate(access);
    const maximum=await privateBucket(access,signal);if(data.length>maximum)throw new StorageError(413,'STORAGE_OBJECT_LIMIT','첨부 청크가 저장소 파일 제한을 초과합니다.');
    const item:ChunkManifest={version:1,attachmentId,offset,size:data.length,sha256:await digest(data)},path=await objectPath(item);let failure:StorageError|undefined;
    try{const response=await fetchStorage('object/'+bucket+'/'+path,'POST',access,data,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','x-upsert':'false'},signal);
      if(![200,201].includes(response.status)){const status=response.status;await response.body?.cancel().catch(()=>{});failure=new StorageError(status===413?413:[402,507].includes(status)?507:503,status===413?'STORAGE_OBJECT_LIMIT':[402,507].includes(status)?'STORAGE_CAPACITY':'STORAGE_UNAVAILABLE');}
      else await response.body?.cancel().catch(()=>{});
    }catch(error){if(!(error instanceof StorageError))throw error;failure=error;}
    // Covers duplicate objects and a published object whose response was lost.
    // Existing bytes must verify: an error is never treated as successful upload.
    try{const existing=await readChunk(item,access,signal);check(existing.length===data.length,409,'STORAGE_BYTES_INVALID');return item;}
    catch(error){if(error instanceof StorageError&&error.code==='STORAGE_BYTES_MISSING'&&failure)throw failure;throw error;}
  }
  async function verify(attachment:AttachmentManifest,access:AccessGate,options:{checkpoint?:VerificationCheckpoint;maxChunks?:number;signal?:AbortSignal}={}):Promise<VerificationResult>{
    layout(attachment);attachment=structuredClone(attachment);await gate(access);const maximum=options.maxChunks??8;check(integer(maximum)&&maximum>0&&maximum<=16);
    const marker=await digest(enc.encode(JSON.stringify([attachment.id,attachment.size,attachment.chunks.map(item=>[item.version,item.attachmentId,item.offset,item.size,item.sha256])]))),checkpoint=options.checkpoint?structuredClone(options.checkpoint):undefined;let state=new IncrementalSHA256(),offset=0;
    if(checkpoint){exact(checkpoint,['version','layout','offset','hash']);check(checkpoint.version===1&&checkpoint.layout===marker&&integer(checkpoint.offset)&&checkpoint.offset<=attachment.size&&(checkpoint.offset===attachment.size||checkpoint.offset%CHUNK_SIZE===0));state=new IncrementalSHA256(checkpoint.hash);check(checkpoint.hash.bytes===checkpoint.offset);offset=checkpoint.offset;}
    let count=0;for(const item of attachment.chunks){if(item.offset<offset)continue;if(count++===maximum)break;const data=await readChunk(item,access,options.signal);for(let i=0;i<data.length;i+=READ_SIZE)state.update(data.subarray(i,i+READ_SIZE));offset+=data.length;}
    await gate(access);const result:VerificationResult={completed:offset===attachment.size,verifiedOffset:offset,checkpoint:{version:1,layout:marker,offset,hash:state.state()}};
    if(result.completed){const sha=state.hex();if(attachment.sha256!==undefined&&sha!==attachment.sha256)throw new StorageError(409,'STORAGE_HASH_MISMATCH');result.sha256=sha;}return result;
  }
  async function download(attachment:AttachmentManifest,access:AccessGate,options:{method?:'GET'|'HEAD';range?:string|null;ifRange?:string|null;signal?:AbortSignal}={}):Promise<Response>{
    layout(attachment);attachment=structuredClone(attachment);await gate(access);await privateBucket(access,options.signal);const etag=attachment.sha256?'"'+attachment.sha256+'"':null,method=options.method??'GET';check(method==='GET'||method==='HEAD');
    let range:{start:number;end:number;partial:boolean};try{range=byteRange(method==='HEAD'||options.ifRange&&options.ifRange!==etag?null:options.range,attachment.size);}catch(error){if(!(error instanceof StorageError)||error.status!==416)throw error;return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+attachment.size,'Content-Length':'0','Accept-Ranges':'bytes','Cache-Control':'no-store'}});}
    const headers=new Headers({'Content-Type':'application/octet-stream','Content-Length':String(range.end-range.start),'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Disposition':"attachment; filename=download; filename*=UTF-8''"+encodeURIComponent(attachment.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())});
    if(etag)headers.set('ETag',etag);if(range.partial)headers.set('Content-Range','bytes '+range.start+'-'+(range.end-1)+'/'+attachment.size);
    if(method==='HEAD')return new Response(null,{status:200,headers});
    const abort=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal;
    async function* slices(){for(const item of attachment.chunks){if(item.offset+item.size<=range.start||item.offset>=range.end)continue;const data=await readChunk(item,access,signal);for(let first=Math.max(0,range.start-item.offset),end=Math.min(item.size,range.end-item.offset);first<end;first+=READ_SIZE){await gate(access);yield data.slice(first,Math.min(end,first+READ_SIZE));}}}
    const iterator=slices(),body=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){controller.error(error);}},async cancel(){abort.abort();await iterator.return(undefined).catch(()=>{});}}, {highWaterMark:0});
    return new Response(body,{status:range.partial?206:200,headers});
  }
  /** Explicit GC only: the caller must permanently fence re-linking while its
   * authoritative SQL GC claim says these objects are unreferenced. */
  async function removeChunks(items:ChunkManifest[],access:AccessGate,unreferenced:(items:ChunkManifest[])=>Promise<boolean>):Promise<void>{
    check(Array.isArray(items)&&items.length>0&&items.length<=100);items.forEach(chunk);items=structuredClone(items);await gate(access);check(typeof unreferenced==='function');if(await unreferenced(structuredClone(items))!==true)throw new StorageError(409,'STORAGE_STILL_REFERENCED');
    await privateBucket(access);const paths=await Promise.all(items.map(objectPath)),response=await fetchStorage('object/'+bucket,'DELETE',access,JSON.stringify({prefixes:paths}),{'Content-Type':'application/json'});if(!response.ok){await response.body?.cancel().catch(()=>{});throw new StorageError();}await response.body?.cancel().catch(()=>{});
  }
  return Object.freeze({writeChunk,readChunk,verify,download,removeChunks});
}
