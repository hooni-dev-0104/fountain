/** Server-only legacy attachment bytes. Never import into generic Store snapshots. */
import {is_object,valid_id} from './access.ts';
import type {Entity} from './access.ts';
import {StoreError,canonicalJSON,validateContext} from './store.ts';
import type {StoreContext} from './store.ts';

export interface InlineAttachmentSource {
  read(input:{context:StoreContext;attachmentId:string;metadata:Entity;offset:number;length:number;sourceDigest:string|null;signal?:AbortSignal}):Promise<{offset:number;size:number;sha256:string;sourceDigest:string;bytes:Uint8Array}>;
}
type Config={supabaseUrl:string;serviceKey:string;workspaceId:string;fetch?:typeof fetch;timeoutMs?:number};
const enc=new TextEncoder(),RANGE=65536,MAX_FILE=5_000_000,MAX_RESPONSE=96*1024,HASH=/^[a-f0-9]{64}$/;
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
function failure(status=503):StoreError {
  const messages:Record<number,[string,string]>={400:['INLINE_ATTACHMENT_INPUT_INVALID','Invalid attachment source input'],401:['AUTH_REQUIRED','Authentication required'],403:['ACCESS_DENIED','Attachment access is not allowed'],404:['ATTACHMENT_NOT_FOUND','Attachment is unavailable'],409:['INLINE_ATTACHMENT_CHANGED','Attachment changed; restart the download'],413:['INLINE_ATTACHMENT_LIMIT','Attachment source exceeds the supported limit'],429:['INLINE_ATTACHMENT_BUSY','Attachment source is busy'],503:['INLINE_ATTACHMENT_UNAVAILABLE','Attachment source is unavailable']};
  const [code,message]=messages[status]??messages[503];return new StoreError(Object.hasOwn(messages,status)?status:503,code,message);
}
function check(value:unknown,status=503):asserts value {if(!value)throw failure(status);}
function safe(error:unknown):StoreError{return failure(error instanceof StoreError?error.status:503);}
function cancel(body:ReadableStream<Uint8Array>|null|undefined):void {try{void body?.cancel().catch(()=>{});}catch{/* Cleanup must never publish provider diagnostics. */}}
/** Also bounds injected fetch/read implementations which ignore AbortSignal. */
function pending<T>(promise:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const abort=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);reject(failure());};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{if(settled){late?.(value);return;}settled=true;signal.removeEventListener('abort',abort);if(signal.aborted){late?.(value);reject(failure());}else resolve(value);},error=>{if(!settled){settled=true;signal.removeEventListener('abort',abort);reject(error);}});
    if(signal.aborted)abort();
  });
}
async function responseBytes(response:Response,signal:AbortSignal,limit:number):Promise<Uint8Array>{
  const declared=response.headers.get('content-length');let expected:number|null=null;
  if(declared!==null){check(/^(0|[1-9][0-9]*)$/.test(declared));expected=Number(declared);check(integer(expected));check(expected<=limit,413);}
  const reader=response.body?.getReader();check(reader);let length=0;const pieces:Uint8Array[]=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try {
    check(!signal.aborted);
    for(;;){const next=await pending(reader.read(),signal);check(!signal.aborted);if(next.done)break;check(next.value instanceof Uint8Array);length+=next.value.length;check(length<=limit,413);if(expected!==null)check(length<=expected);pieces.push(next.value.slice());}
    check(expected===null||length===expected);
    const bytes=new Uint8Array(length);let at=0;for(const piece of pieces){bytes.set(piece,at);at+=piece.length;}return bytes;
  }finally{
    signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Pending reads are already rejected/cancelled. */}
  }
}
function decode(value:unknown,length:number):Uint8Array {
  check(typeof value==='string'&&value.length<=Math.ceil(RANGE/3)*4&&value.length%4===0);
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,end=value.length-padding,alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  check(value.length/4*3-padding===length);
  for(let i=0;i<end;i++)check(alphabet.includes(value[i]));for(let i=end;i<value.length;i++)check(value[i]==='=');
  if(padding)check(alphabet.indexOf(value[end-1])%(padding===2?16:4)===0);
  let raw:string;try{raw=atob(value);}catch{throw failure();}check(raw.length===length);
  return Uint8Array.from(raw,char=>char.charCodeAt(0));
}
async function hash(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}

export function createInlineAttachmentSource(config:Config):InlineAttachmentSource {
  let origin:string,workspaceId:string,headers:Record<string,string>,request:typeof fetch,timeout:number;
  try {
    const url=new URL(config.supabaseUrl);
    check((url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/');origin=url.origin;
    check(valid_id(config.workspaceId));workspaceId=JSON.parse(canonicalJSON(config.workspaceId));
    const key=config.serviceKey;check(typeof key==='string'&&key.length<=4096&&!/[\r\n\x00]/.test(key));headers={'Content-Type':'application/json',apikey:key};
    if(key.startsWith('sb_secret_'))check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(key));
    else{const parts=key.split('.');check(parts.length===3&&parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)));check(JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-parts[1].length%4)%4))).role==='service_role');headers.Authorization='Bearer '+key;}
    request=config.fetch??globalThis.fetch;check(typeof request==='function');timeout=config.timeoutMs??15000;check(integer(timeout)&&timeout>0&&timeout<=30000);
  }catch{throw failure();}
  return Object.freeze({async read(input){
    let context:StoreContext,metadata:Entity,attachmentId:string,offset:number,length:number,sourceDigest:string|null,callerSignal:AbortSignal|undefined;
    try {
      check(is_object(input)&&['context','attachmentId','metadata','offset','length','sourceDigest'].every(k=>Object.hasOwn(input,k))&&Object.keys(input).every(k=>['context','attachmentId','metadata','offset','length','sourceDigest','signal'].includes(k)),400);
      context=validateContext(JSON.parse(canonicalJSON(input.context)));check(context.workspaceId===workspaceId,403);
      attachmentId=input.attachmentId;offset=input.offset;length=input.length;sourceDigest=input.sourceDigest;callerSignal=input.signal;
      check(valid_id(attachmentId)&&is_object(input.metadata)&&!['data','storage_id','cloud_chunks'].some(k=>Object.hasOwn(input.metadata,k)),400);
      const serialized=canonicalJSON(input.metadata);check(enc.encode(serialized).length<=RANGE,413);metadata=JSON.parse(serialized);
      check(metadata.id===attachmentId&&(!Object.hasOwn(metadata,'storage')||metadata.storage===null||metadata.storage==='inline')&&integer(metadata.size)&&metadata.size<=MAX_FILE,400);
      check(!Object.hasOwn(metadata,'sha256')||typeof metadata.sha256==='string'&&HASH.test(metadata.sha256),400);
      check(integer(offset)&&integer(length)&&length<=RANGE&&offset<=metadata.size&&length<=metadata.size-offset,400);
      check(sourceDigest===null?offset===0&&length===0:typeof sourceDigest==='string'&&HASH.test(sourceDigest),400);
      check(callerSignal===undefined||callerSignal instanceof AbortSignal,400);
    }catch(error){throw safe(error);}
    const controller=new AbortController(),signal=callerSignal?AbortSignal.any([callerSignal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(),timeout);let response:Response|undefined;
    try {
      check(!signal.aborted);
      // Serialize only snapshotted values. No caller URL, headers, key or cookie.
      const body=JSON.stringify({p_context:context,p_attachment_id:attachmentId,p_expected:metadata,p_offset:offset,p_length:length,p_source_digest:sourceDigest});
      response=await pending(Promise.resolve(request(origin+'/rest/v1/rpc/fountain_cloud_inline_attachment_range',{method:'POST',headers:{...headers},body,redirect:'error',credentials:'omit',signal})),signal,value=>cancel(value.body));
      check(!signal.aborted);check(!response.redirected);
      if(response.status!==200){
        let code='';try{const bytes=await responseBytes(response,signal,4096),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(typeof value?.code==='string')code=value.code;}catch{if(signal.aborted)throw failure();}
        const typed:Record<string,number>={PT400:400,'22023':400,PT401:401,PT403:403,PT404:404,PT409:409,PT413:413,PT429:429,PT503:503};throw failure(typed[code]??response.status);
      }
      const bytes=await responseBytes(response,signal,MAX_RESPONSE),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      const fields=['workspaceId','attachmentId','offset','size','sha256','sourceDigest','bytesBase64'];
      check(is_object(value)&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k)));
      check(value.workspaceId===workspaceId&&value.attachmentId===attachmentId&&value.offset===offset&&value.size===metadata.size);
      check(typeof value.sha256==='string'&&HASH.test(value.sha256)&&typeof value.sourceDigest==='string'&&HASH.test(value.sourceDigest));
      if(sourceDigest!==null)check(value.sourceDigest===sourceDigest,409);
      if(Object.hasOwn(metadata,'sha256'))check(value.sha256===metadata.sha256,409);
      const data=decode(value.bytesBase64,length);
      if(offset===0&&length===metadata.size)check(await hash(data)===value.sha256,409);
      check(!signal.aborted);return {offset,size:value.size,sha256:value.sha256,sourceDigest:value.sourceDigest,bytes:data};
    }catch(error){throw safe(error);}
    finally{clearTimeout(timer);try{cancel(response?.body);}catch{/* Untrusted transport cleanup is never public. */}}
  }});
}
