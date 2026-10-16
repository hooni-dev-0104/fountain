/** Shared HTTP boundary for the Supabase backend; no secrets or business state. */
import {AuthError} from './auth.ts';
import {APIError} from './access.ts';
export class HttpError extends Error {
  status:number;
  code:string;
  constructor(status:number,message:string,code='BAD_REQUEST'){super(message);this.status=status;this.code=code;}
}
export function canonicalOrigin(value:string):string {
  let url:URL;try{url=new URL(value);}catch{throw new HttpError(500,'Invalid backend origin','CONFIGURATION_ERROR');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new HttpError(500,'Invalid backend origin','CONFIGURATION_ERROR');
  return url.origin;
}
export function requestPath(request:Request):string {
  const url=new URL(request.url);
  let path=url.pathname;
  for(const prefix of ['/functions/v1/fountain-api','/fountain-api'])if(path===prefix||path.startsWith(prefix+'/')){path=path.slice(prefix.length)||'/';break;}
  if(path.length>8192||url.search.length>8192||path.includes('\\')||path.includes('//'))throw new HttpError(400,'Invalid request path');
  let decoded=path;
  for(let count=0;count<5;count++){
    if(/[\u0000-\u001f\u007f\\]/.test(decoded)||decoded.split('/').some(part=>part==='.'||part==='..'))throw new HttpError(400,'Invalid request path');
    let next:string;try{next=decodeURIComponent(decoded);}catch{throw new HttpError(400,'Invalid request path');}
    if(next===decoded)return path;
    if(next.split('/').length!==decoded.split('/').length)throw new HttpError(400,'Encoded path separator is not allowed');
    decoded=next;
  }
  throw new HttpError(400,'Request path encoding is too deep');
}
export function checkRequest(request:Request,origins:ReadonlySet<string>):void {
  const method=request.method.toUpperCase();
  if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method))throw new HttpError(405,'Unsupported request method');
  const origin=request.headers.get('Origin');
  if(origin&&!origins.has(origin))throw new HttpError(403,'Request origin is not allowed','ORIGIN_DENIED');
  if(!['GET','HEAD','OPTIONS'].includes(method)&&request.headers.get('X-Fountain-Request')!=='1')throw new HttpError(403,'Fountain request header is required','REQUEST_HEADER_REQUIRED');
}
export async function readBytes(request:Request,limit=10_000_000):Promise<Uint8Array> {
  const size=request.headers.get('Content-Length');
  if(size!==null&&(!/^\d+$/.test(size)||!Number.isSafeInteger(Number(size))))throw new HttpError(400,'Invalid request length');
  if(size!==null&&Number(size)>limit)throw new HttpError(413,'Request body is too large','BODY_LIMIT');
  if(!request.body){if(size!==null&&Number(size)!==0)throw new HttpError(400,'Incomplete request body');return new Uint8Array();}
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw new HttpError(413,'Request body is too large','BODY_LIMIT');chunks.push(value);}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  if(size!==null&&length!==Number(size))throw new HttpError(400,'Incomplete request body');
  const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
export async function readJSON(request:Request):Promise<Record<string,unknown>> {
  const bytes=await readBytes(request);if(!bytes.byteLength)return {};
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HttpError(400,'Invalid JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'JSON body must be an object');
  return value as Record<string,unknown>;
}
export function jsonResponse(value:unknown,status=200,extra:HeadersInit={}):Response {
  const headers=new Headers(extra);headers.set('Content-Type','application/json; charset=utf-8');headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');
  return new Response(JSON.stringify(value),{status,headers});
}
export function errorResponse(error:unknown):Response {
  if(error instanceof HttpError)return jsonResponse({error:error.message,code:error.code},error.status);
  if(error instanceof AuthError)return jsonResponse({error:error.message,code:error.code},error.status);
  if(error instanceof APIError)return jsonResponse({error:error.message},error.status);
  // Driver/provider errors can contain credentials, URLs or SQL values.
  return jsonResponse({error:'The backend could not complete this request.',code:'INTERNAL_ERROR'},500);
}
export function preflight(request:Request,origins:ReadonlySet<string>):Response {
  checkRequest(request,origins);
  const origin=request.headers.get('Origin');
  if(!origin)throw new HttpError(403,'A known request origin is required','ORIGIN_DENIED');
  const method=request.headers.get('Access-Control-Request-Method')||'';
  if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method))throw new HttpError(405,'Unsupported request method');
  const names=(request.headers.get('Access-Control-Request-Headers')||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean),allowed=new Set(['content-type','x-fountain-request','range','if-none-match']);
  if(names.some(name=>!allowed.has(name)))throw new HttpError(403,'Request headers are not allowed');
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Methods':method,'Access-Control-Allow-Headers':names.join(', '),'Access-Control-Max-Age':'600','Cache-Control':'no-store','Vary':'Origin'}});
}
