'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {normalizeServer}=require('./security.cjs');
const UI_ORIGIN='https://fountain.desktop.invalid',PREFIX='/functions/v1/fountain-api',READ=65536;
const ASSETS=Object.freeze(['app.js','backup.js','collaboration.js','index.html','mutations.js','offline.js','organization.html','organization.js','organization.css','presence.js','public.js','recovery-import.js','style.css','sw.js','transport.js','uploads.js','version-diff.js']);
const MIME={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'};
const CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const SAFE_HEADERS=['content-type','content-disposition','content-length','content-range','accept-ranges','etag'];
const REQUEST_HEADERS=['content-type','accept','range','if-range','if-none-match','if-match','accept-language'];
const TYPES=new Set(['application/json','application/octet-stream','application/pdf','application/zip','application/vnd.sqlite3','text/plain','text/csv','text/markdown','text/event-stream','image/png','image/jpeg','image/gif','image/webp','image/svg+xml']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const requireValue=value=>{if(!value)throw Error('INVALID_CLOUD_INPUT');};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const controls=value=>/[\u0000-\u001f\u007f\\]/u.test(value);
function isCloudServer(server){try{const url=new URL(normalizeServer(server));return url.protocol==='https:'&&!url.port&&/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname);}catch{return false;}}
function cloudPartitions(server){requireValue(isCloudServer(server));const id=hash(normalizeServer(server));return Object.freeze({frontend:'persist:fountain-cloud-ui-'+id,network:'persist:fountain-cloud-network-'+id});}
function decoded(value,isPath){
 for(let pass=0;pass<12;pass++){
  requireValue(isPath?!controls(value):!/[\u0000-\u001f\u007f]/u.test(value));
  // Decoding is validation only: encoded ?/# in a resource ID and printable
  // query backslashes are data. The original encoded URL is always forwarded.
  if(isPath){requireValue(value.startsWith('/'));for(const part of value.split('/'))requireValue(part!=='.'&&part!=='..');}
  const next=decodeURIComponent(value.replace(/%(?![0-9a-f]{2})/gi,'%25'));
  if(next===value)return;
  if(isPath)requireValue(next.split('/').length===value.split('/').length);
  value=next;
 }
 throw Error('INVALID_CLOUD_INPUT');
}
function checkedURL(input,origin,localFragment=false){
 requireValue(typeof input==='string'&&input.length<=16384&&!controls(input)&&(localFragment||!input.includes('#')));
 const url=new URL(input);requireValue(url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password&&(localFragment||!url.hash));
 const raw=/^https:\/\/[^/?#]+(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(input.split('#',1)[0]);requireValue(raw);
 decoded(raw[1]||'/',true);decoded(raw[2]||'',false);
 return url;
}
function remoteRoute(url){
 if(url.pathname.startsWith('/api/'))return 'api';
 if(url.pathname==='/health'&&!url.search)return 'health';
 if(/^\/(?:sites|forms)\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname)&&!url.search)return 'public';
 return null;
}
function networkAllowed(target,server){
 try{if(!isCloudServer(server))return false;const origin=new URL(normalizeServer(server)).origin,url=checkedURL(target,origin);
  if(!url.pathname.startsWith(PREFIX+'/'))return false;
  return remoteRoute(new URL(origin+url.pathname.slice(PREFIX.length)+url.search))!==null;
 }catch{return false;}
}
function secureHeaders(extra={}){return new Headers({'Cache-Control':'no-store','Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin',...extra});}
function failure(status=503){return new Response(JSON.stringify({error:'데스크톱 연결 요청을 완료할 수 없습니다.',code:'CLOUD_TRANSPORT_UNAVAILABLE'}),{status,headers:secureHeaders({'Content-Type':'application/json; charset=utf-8'})});}
function cancel(body){try{void body?.cancel().catch(()=>{});}catch{}}
function denied(request,status){cancel(request?.body);return failure(status);}
async function regular(file,maximum){
 const before=await fs.lstat(file);requireValue(before.isFile()&&!before.isSymbolicLink()&&before.size<=maximum&&await fs.realpath(file)===file);
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{const opened=await handle.stat();requireValue(opened.isFile()&&opened.size===before.size&&opened.ino===before.ino&&opened.dev===before.dev);
  const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const part=await handle.read(bytes,offset,bytes.length-offset,null);requireValue(part.bytesRead>0);offset+=part.bytesRead;}
  const extra=await handle.read(Buffer.alloc(1),0,1,null),after=await handle.stat(),current=await fs.lstat(file);
  requireValue(!extra.bytesRead&&after.size===opened.size&&after.mtimeMs===opened.mtimeMs&&after.ctimeMs===opened.ctimeMs&&current.isFile()&&!current.isSymbolicLink()&&current.ino===opened.ino&&current.dev===opened.dev&&await fs.realpath(file)===file);return bytes;
 }finally{await handle.close();}
}
async function bundle(root){
 requireValue(typeof root==='string');root=path.resolve(root);const directory=await fs.lstat(root);requireValue(directory.isDirectory()&&!directory.isSymbolicLink()&&await fs.realpath(root)===root);
 const manifest=JSON.parse((await regular(path.join(root,'manifest.json'),32768)).toString('utf8'));requireValue(exact(manifest,['version','files'])&&manifest.version===1&&Array.isArray(manifest.files)&&manifest.files.length===ASSETS.length);
 const files=new Map();let total=0;
 for(const item of manifest.files){requireValue(exact(item,['name','mime','size','sha256'])&&ASSETS.includes(item.name)&&!files.has(item.name)&&item.mime===MIME[path.extname(item.name)]&&Number.isSafeInteger(item.size)&&item.size>=0&&item.size<=4*1024*1024&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256));
  total+=item.size;requireValue(total<=16*1024*1024);const bytes=await regular(path.join(root,item.name),4*1024*1024);requireValue(bytes.length===item.size&&hash(bytes)===item.sha256);files.set(item.name,{bytes,mime:item.mime});
 }
 return files;
}
function declared(headers){const value=headers.get('content-length');if(value===null)return null;requireValue(/^(0|[1-9][0-9]{0,15})$/.test(value)&&Number.isSafeInteger(Number(value)));return Number(value);}
async function createCloudClient({server,bundleRoot,fetch:send,requestTimeoutMs=30000,streamIdleMs=30000,sseLifetimeMs=55000}){
 requireValue(isCloudServer(server)&&typeof send==='function');
 for(const [value,max]of [[requestTimeoutMs,30000],[streamIdleMs,30000],[sseLifetimeMs,55000]])requireValue(Number.isSafeInteger(value)&&value>0&&value<=max);
 const backend=new URL(normalizeServer(server)).origin,active=new Set();let files;try{files=await bundle(bundleRoot);}catch{throw Error('CLOUD_BUNDLE_INVALID');}let enabled=false;
 function finish(record){if(record.finished)return;record.finished=true;clearTimeout(record.sseTimer);record.incoming?.removeEventListener('abort',record.onIncoming);active.delete(record);}
 function stop(record){if(!record.abort.signal.aborted)record.abort.abort();}
 function tracked(incoming){const record={abort:new AbortController(),incoming,finished:false,deadline:Date.now()+requestTimeoutMs,reader:null,output:null};
  record.onIncoming=()=>stop(record);record.abort.signal.addEventListener('abort',()=>{const reader=record.reader;record.reader=null;if(reader){cancel(reader);try{reader.releaseLock();}catch{}}try{record.output?.error(Error('CLOUD_STREAM_STOPPED'));}catch{}finish(record);},{once:true});
  // Pinned Electron does NOT propagate renderer cancellation to this signal.
  // It is supplemental only; deadlines, stream.cancel and owner suspend are required.
  incoming?.addEventListener('abort',record.onIncoming,{once:true});active.add(record);if(incoming?.aborted)stop(record);return record;
 }
 function wait(promise,record,timeout){
  return new Promise((resolve,reject)=>{let settled=false;const signal=record.abort.signal;
   const done=(value,error)=>{if(settled){if(value instanceof Response)cancel(value.body);return;}settled=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);error?reject(Error('CLOUD_IO_FAILED')):resolve(value);};
   const aborted=()=>done(null,true),timer=setTimeout(()=>{stop(record);done(null,true);},Math.max(1,timeout));signal.addEventListener('abort',aborted,{once:true});
   Promise.resolve(promise).then(value=>done(value,false),()=>done(null,true));if(signal.aborted)aborted();
  });
 }
 async function input(request,record,maximum=10000000){
  const length=declared(request.headers);requireValue(length===null||length<=maximum);const noBody=['GET','HEAD'].includes(request.method);requireValue(!noBody||length===null||length===0);
  if(!request.body){requireValue(length===null||length===0);return new Uint8Array(0);}
  const reader=request.body.getReader();record.reader=reader;const parts=[];let size=0;
  try{for(;;){const part=await wait(reader.read(),record,record.deadline-Date.now());if(part.done)break;requireValue(part.value instanceof Uint8Array&&part.value.length>0&&!noBody);size+=part.value.length;requireValue(size<=maximum);parts.push(part.value);}
   requireValue(length===null||length===size);const body=new Uint8Array(size);let offset=0;for(const part of parts){body.set(part,offset);offset+=part.length;}return body;
  }finally{record.reader=null;cancel(reader);try{reader.releaseLock();}catch{}}
 }
 function responseHeaders(response,route){
  const headers=secureHeaders();for(const name of SAFE_HEADERS){const value=response.headers.get(name);if(value!==null){requireValue(value.length<=8192&&!controls(value));headers.set(name,value);}}
  const original=(headers.get('content-type')||'application/octet-stream').split(';',1)[0].trim().toLowerCase();
  const html=route==='public'&&response.status===200&&response.headers.get('x-fountain-format')==='html'&&['text/plain','text/html'].includes(original);
  headers.set('content-type',html?'text/html; charset=utf-8':TYPES.has(original)?headers.get('content-type')||original:'text/plain; charset=utf-8');return headers;
 }
 function streamed(response,record,headers,maximum,sse){
  const expected=declared(headers);requireValue(expected===null||expected<=maximum);const reader=response.body.getReader();record.reader=reader;
  let received=0,pending=null,offset=0,ended=false;
  if(sse)record.sseTimer=setTimeout(()=>stop(record),sseLifetimeMs);
  return new ReadableStream({start(controller){record.output=controller;},async pull(controller){
   try{requireValue(!record.abort.signal.aborted);
    if(pending&&offset<pending.length){const end=Math.min(pending.length,offset+READ);controller.enqueue(pending.slice(offset,end));offset=end;if(offset===pending.length){pending=null;offset=0;}return;}
    // An idle deadline exists only while waiting for an upstream read, never
    // while a consumer is deliberately applying backpressure between pulls.
    const next=await wait(reader.read(),record,streamIdleMs);requireValue(!record.abort.signal.aborted);
    if(next.done){requireValue(expected===null||received===expected);ended=true;reader.releaseLock();record.reader=null;finish(record);controller.close();return;}
    // Retain at most ONE main-owned fetch piece plus one <=64KiB public copy.
    // Provider piece size is not a 64KiB heap guarantee or an arbitrary file cap.
    requireValue(next.value instanceof Uint8Array&&next.value.length>0);received+=next.value.length;requireValue(received<=maximum&&(expected===null||received<=expected));
    pending=next.value;offset=Math.min(READ,pending.length);controller.enqueue(pending.slice(0,offset));if(offset===pending.length){pending=null;offset=0;}
   }catch{stop(record);if(!ended)try{controller.error(Error('CLOUD_STREAM_STOPPED'));}catch{}finish(record);}
  },cancel(){stop(record);finish(record);}}, {highWaterMark:0});
 }
 async function handle(request){
  if(!enabled)return denied(request);let url,route;
  try{
   url=checkedURL(request.url,UI_ORIGIN,true);requireValue(['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(request.method));
   if(request.initiatorOrigin!==UI_ORIGIN&&!(request.initiatorOrigin===undefined&&['GET','HEAD'].includes(request.method)))return denied(request,403);
   const name=url.pathname==='/'?'index.html':url.pathname.startsWith('/static/')?url.pathname.slice(8):url.pathname.slice(1),asset=files.get(name);
   if(asset&&['GET','HEAD'].includes(request.method)){requireValue(url.search.length<=1024);const headers=secureHeaders({'Content-Type':asset.mime,'Content-Length':String(asset.bytes.length)});if(name==='sw.js')headers.set('Service-Worker-Allowed','/');return new Response(request.method==='HEAD'?null:asset.bytes,{headers});}
   requireValue(!request.url.includes('#')); // Only verified local assets may carry SPA fragments.
   route=remoteRoute(url);if(!route)return denied(request,404);if(route!=='api'&&!['GET','HEAD'].includes(request.method))return denied(request,405);
  }catch{return denied(request,400);}
  if(active.size>=16)return denied(request,429);const record=tracked(request.signal);let upstream;
  try{
   const body=await input(request,record);requireValue(enabled&&!record.abort.signal.aborted);
   const target=backend+PREFIX+url.pathname+url.search;requireValue(networkAllowed(target,backend));const outgoing=new Headers({'X-Fountain-Request':'1','Accept-Encoding':'identity'});
   for(const name of REQUEST_HEADERS){const value=request.headers.get(name);if(value!==null){requireValue(value.length<=8192&&!controls(value));outgoing.set(name,value);}}
   // Electron forbids a manual Content-Length extra header. Its bounded body
   // buffer lets Chromium frame the validated bytes and calculate the length.
   const response=await wait(send(target,{method:request.method,headers:outgoing,credentials:'include',cache:'no-store',redirect:'error',signal:record.abort.signal,...(!['GET','HEAD'].includes(request.method)?{body}:{})}),record,record.deadline-Date.now());upstream=response;
   requireValue(enabled&&!record.abort.signal.aborted&&response instanceof Response&&!response.redirected&&response.status>=200&&response.status<600&&(response.status<300||response.status===304||response.status>=400));
   if(response.status>=500){
    requireValue(route==='api'&&request.method!=='HEAD'&&(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase()==='application/json');
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await input(response,record,4096)));
    requireValue(enabled&&!record.abort.signal.aborted&&object(value)&&Object.hasOwn(value,'error')&&Object.keys(value).every(key=>key==='error'||key==='code')
     &&typeof value.error==='string'&&Array.from(value.error).length<=2048
     &&(!Object.hasOwn(value,'code')||typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)));
    // Rebuild only the public DTO: never forward raw gateway JSON/diagnostics,
    // duplicate JSON members, provider headers or an unvalidated HEAD body.
    const body=JSON.stringify({error:value.error,...(Object.hasOwn(value,'code')?{code:value.code}:{})});finish(record);
    return new Response(body,{status:response.status,headers:secureHeaders({'Content-Type':'application/json; charset=utf-8','Content-Length':String(Buffer.byteLength(body))})});
   }
   const headers=responseHeaders(response,route),sse=headers.get('content-type').split(';',1)[0].trim().toLowerCase()==='text/event-stream';
   const download=/^attachment(?:;|$)/i.test(headers.get('content-disposition')||'')||url.pathname==='/api/backup'||/^\/api\/attachments\/[^/]+\/download$/.test(url.pathname),maximum=download?5000000000:16*1024*1024;
   const length=declared(headers);requireValue(length===null||length<=maximum);
   if(request.method==='HEAD'||[204,205,304].includes(response.status)||!response.body){requireValue(request.method==='HEAD'||response.status===304||length===null||length===0);cancel(response.body);finish(record);return new Response(null,{status:response.status,headers});}
   return new Response(streamed(response,record,headers,sse?16*1024*1024:maximum,sse),{status:response.status,headers});
  }catch{stop(record);cancel(upstream?.body);finish(record);return denied(request);}
 }
 return Object.freeze({handle,resume(){enabled=true;},suspend(){enabled=false;for(const record of active)stop(record);},abortAll(){for(const record of active)stop(record);},activeCount(){return active.size;}});
}
module.exports={UI_ORIGIN,isCloudServer,cloudPartitions,networkAllowed,createCloudClient};
