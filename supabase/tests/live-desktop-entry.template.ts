/** TEST ONLY. Root replaces the scope literal and deploys behind its sealed gate.
 * No seed, fake principal, model, credential output or production entrypoint. */
import {createApplication} from '../_shared/application.ts';
const scope=QA_SCOPE;
const project='https://ehnovtfadpkwtubmwltl.supabase.co',qaOrigin='https://fountain-qa.example.invalid';
const encoder=new TextEncoder(),HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))].map(n=>n.toString(16).padStart(2,'0')).join('');
function require(value:unknown):asserts value {if(!value)throw Error('QA_SCOPE_REJECTED');}
function canonicalNonce(s:string){try{return /^[A-Za-z0-9_-]{43}$/.test(s)&&btoa(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'=')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')===s;}catch{return false;}}
function envKeys(name:string,legacy:string){try{const raw=Deno.env.get(name);if(raw){const value=JSON.parse(raw);require(object(value));const result=[value.default,...Object.values(value)].filter(v=>typeof v==='string'&&v);require(result.length>0);return [...new Set(result)] as string[];}const value=Deno.env.get(legacy);require(typeof value==='string'&&!!value);return [value];}catch{throw Error('QA_CONFIGURATION_UNAVAILABLE');}}
function role(key:string){try{const p=key.split('.');require(p.length===3&&p.every(v=>/^[A-Za-z0-9_-]+$/.test(v)));return JSON.parse(atob(p[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-p[1].length%4)%4))).role;}catch{return null;}}
require(/^fountain-qa-cloud-(?:desktop|native|inline)-[a-f0-9]{16}$/.test(scope.workspaceId)&&HASH.test(scope.challengeHash)&&HASH.test(scope.nonceHash));
require(Array.isArray(scope.emails)&&scope.emails.length===2&&new Set(scope.emails).size===2&&scope.emails.every((e:unknown)=>typeof e==='string'&&/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,190}\.invalid$/.test(e)));
require(Deno.env.get('SUPABASE_URL')===project);
const publishableKey=envKeys('SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY')[0],secrets=envKeys('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY'),serviceKey=secrets[0];
require(/^sb_publishable_[A-Za-z0-9_-]{8,512}$/.test(publishableKey)||role(publishableKey)==='anon');
require(secrets.every(key=>/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(key)||role(key)==='service_role'));
const cryptoKeys=await Promise.all(secrets.map(async secret=>({secret,id:(await sha(secret)).slice(0,24)}))),workspaceHash=await sha(scope.workspaceId);
const rpc=new Set(['vault_create','vault_read','resolve_profile','vault_claim_refresh','vault_finish_refresh','vault_release_refresh','vault_revoke','vault_finish_logout','store_snapshot','store_commit','presence_publishers','onboarding_claim','onboarding_invite','bootstrap_begin','accounts','account_revoke_attempt','backup_authorize','backup_export','backup_jobs','upload_gc_fence','inline_attachment_range']);
const safeHeaders=['Content-Type','Range','If-Range','If-Match','If-None-Match','Accept','Last-Event-ID'];
function sessionCookie(raw:string|null){
 if(raw===null||raw==='')return null;require(raw.length<=8192&&/^[\x20-\x7e]+$/.test(raw));let session:string|null=null,cloudflare=false;
 for(const part of raw.split(';')){const item=part.trim();if(item.startsWith('fountain_session=')){const value=item.slice(17);require(session===null&&canonicalNonce(value));session='fountain_session='+value;}
  else{require(!cloudflare&&item.startsWith('__cf_bm=')&&/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(item.slice(8)));cloudflare=true;}}
 return session;
}
function logicalPath(value:string){
 require(value.length>0&&value.length<=8192&&/^[\x21-\x7e]+$/.test(value)&&!value.includes('#'));
 const question=value.indexOf('?'),path=question<0?value:value.slice(0,question),query=question<0?'':value.slice(question+1);
 require(path.startsWith('/')&&!path.includes('//')&&!path.includes('\\'));
 const parts=path.split('/').slice(1).map(part=>{const decoded=decodeURIComponent(part);require(decoded!=='.'&&decoded!=='..'&&!/[\x00-\x1f\x7f/\\]/.test(decoded)&&!/%(?:2f|5c|2e|0[0-9a-f]|1[0-9a-f]|7f|25)/i.test(decoded));return decoded;});
 // Query bytes may contain printable backslashes and encoded #/?/%; they are
 // never interpreted as a pathname or external URL.
 require(!/[\x00-\x1f\x7f]/.test(decodeURIComponent(query)));
 require(parts[0]==='api'&&parts.length>=2&&parts[1]!==''&&!['admin','auth','scim','provider','functions','rest','storage','realtime'].includes(parts[1])||parts.length===2&&['sites','forms'].includes(parts[0])&&!!parts[1]);
 const target=new URL(qaOrigin+value);require(target.origin===qaOrigin&&target.pathname===path);return value;
}
async function bytes(response:Response,limit:number,signal?:AbortSignal){const reader=response.body?.getReader();if(!reader)return new Uint8Array();const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const chunks:Uint8Array[]=[];let size=0;try{for(;;){const p=await reader.read();require(!signal?.aborted);if(p.done)break;size+=p.value.length;require(size<=limit);chunks.push(p.value);}const result=new Uint8Array(size);let at=0;for(const p of chunks){result.set(p,at);at+=p.length;}return result;}finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}}
const unavailable=()=>new Response('{"code":"QA_UNAVAILABLE"}',{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
Deno.serve(async request=>{
 const url=new URL(request.url),nonce=request.headers.get('X-Fountain-Verify')??'';
 if(!['/functions/v1/fountain-verify/wire','/fountain-verify/wire'].includes(url.pathname)||url.search||url.hash||request.headers.has('Origin')||request.headers.has('Authorization')||request.headers.get('X-Fountain-Request')!=='1'||!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(request.method)||!canonicalNonce(nonce)||await sha(nonce)!==scope.challengeHash)return new Response(null,{status:404});
 const deadline=new AbortController(),disconnect=()=>deadline.abort(),timer=setTimeout(disconnect,125000);request.signal.addEventListener('abort',disconnect,{once:true});if(request.signal.aborted)disconnect();
 const clean=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',disconnect);};
 try{
  const path=logicalPath(request.headers.get('X-Fountain-Test-Path')??''),cookie=sessionCookie(request.headers.get('Cookie'));
  const size=request.headers.get('Content-Length');require(size===null||/^(0|[1-9][0-9]{0,7})$/.test(size)&&Number(size)<=10000000);
  const body=await bytes(new Response(request.body),10000000,deadline.signal);require(size===null||Number(size)===body.length);require(!['GET','HEAD'].includes(request.method)||body.length===0);
  const intents=new Map<string,{email:string;nonce:string;kind:string}>();let bootstrap=false;
  const guardedFetch:typeof fetch=async(input,init)=>{
   require(!deadline.signal.aborted);const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),method=init?.method??'GET';require(target.origin===project&&!target.username&&!target.password&&!target.hash);
   let rpcName='',params:Record<string,any>|null=null;
   if(target.pathname.startsWith('/rest/v1/rpc/fountain_cloud_')){
    rpcName=target.pathname.slice('/rest/v1/rpc/fountain_cloud_'.length);require(rpc.has(rpcName)&&method==='POST'&&!target.search&&typeof init?.body==='string');params=JSON.parse(init!.body as string);require(object(params));
    require((params.p_workspace_id===scope.workspaceId||params.p_context?.workspaceId===scope.workspaceId)&&(!Object.hasOwn(params,'p_workspace_id')||params.p_workspace_id===scope.workspaceId)&&(!Object.hasOwn(params,'p_context')||params.p_context?.workspaceId===scope.workspaceId));
    if(rpcName==='bootstrap_begin')require(params.p_nonce_hash===scope.nonceHash);
   }else if(target.pathname==='/auth/v1/admin/users'){
    require(method==='POST'&&!target.search&&typeof init?.body==='string');const p=JSON.parse(init!.body as string);require(object(p)&&scope.emails.includes(p.email)&&typeof p.password==='string'&&p.email_confirm===true&&object(p.app_metadata));
    const intent=intents.get(p.id);require(bootstrap&&p.app_metadata.fountain_bootstrap===scope.nonceHash&&Object.keys(p.app_metadata).length===1&&Object.keys(p).length===4&&Object.keys(p).every(k=>['email','password','email_confirm','app_metadata'].includes(k))||intent&&intent.email===p.email&&p.app_metadata.fountain_account_intent===intent.nonce&&Object.keys(p.app_metadata).length===1&&Object.keys(p).length===5&&Object.keys(p).every(k=>['id','email','password','email_confirm','app_metadata'].includes(k)));
   }else if(/^\/auth\/v1\/admin\/users\/[a-f0-9-]{36}$/i.test(target.pathname)){
    const id=target.pathname.split('/').at(-1)!,intent=intents.get(id);require(UUID.test(id)&&intent&&!target.search&&['GET','PUT'].includes(method));
    if(method==='PUT'){require(typeof init?.body==='string');const p=JSON.parse(init!.body as string),key=intent!.kind==='create'?'fountain_account_intent':'fountain_password_intent';require(object(p)&&typeof p.password==='string'&&object(p.app_metadata)&&Object.keys(p.app_metadata).length===1&&p.app_metadata[key]===intent!.nonce&&Object.keys(p).every(k=>['password','app_metadata'].includes(k)));}
   }else if(target.pathname==='/auth/v1/token'){
    require(method==='POST'&&target.searchParams.size===1&&typeof init?.body==='string');const p=JSON.parse(init!.body as string),grant=target.searchParams.get('grant_type');require(object(p)&&(grant==='password'&&scope.emails.includes(p.email)&&typeof p.password==='string'||grant==='refresh_token'&&typeof p.refresh_token==='string'));
   }else if(target.pathname==='/auth/v1/user')require(method==='GET'&&!target.search);
   else if(target.pathname==='/auth/v1/logout')require(method==='POST'&&target.search==='?scope=local');
   else if(target.pathname==='/storage/v1/bucket/fountain-files')require(method==='GET'&&!target.search);
   else if(target.pathname==='/storage/v1/object/fountain-files'&&method==='DELETE'){
    require(!target.search&&typeof init?.body==='string');const p=JSON.parse(init!.body as string);require(object(p)&&Object.keys(p).length===1&&Array.isArray(p.prefixes)&&p.prefixes.length>0&&p.prefixes.length<=100&&p.prefixes.every((v:unknown)=>typeof v==='string'&&new RegExp('^v1/'+workspaceHash+'/[a-f0-9]{64}/(?:0|[1-9][0-9]{0,10})-[a-f0-9]{64}$').test(v)));
   }else require(!target.search&&['GET','POST'].includes(method)&&new RegExp('^/storage/v1/object/(?:authenticated/)?fountain-files/v1/'+workspaceHash+'/[a-f0-9]{64}/(?:0|[1-9][0-9]{0,10})-[a-f0-9]{64}$').test(target.pathname));
   const response=await fetch(input,{...init,redirect:'error',signal:AbortSignal.any([deadline.signal,...(init?.signal?[init.signal]:[])])});require(!response.redirected);
   if(response.status===200&&rpcName==='bootstrap_begin'){const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(response.clone(),262144,deadline.signal)));bootstrap=object(v)&&v.allowed===true;}
   if(response.status===200&&rpcName==='accounts'&&params?.p_action==='begin'){const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(response.clone(),262144,deadline.signal)));require(object(v)&&UUID.test(v.userId)&&scope.emails.includes(v.providerEmail)&&/^[a-f0-9]{32}$/.test(v.nonce)&&['create','password'].includes(v.kind));intents.set(v.userId,{email:v.providerEmail,nonce:v.nonce,kind:v.kind});}
   return response;
  };
  const headers=new Headers({'X-Fountain-Request':'1'});for(const key of safeHeaders){const value=request.headers.get(key);if(value!==null)headers.set(key,value);}if(cookie)headers.set('Cookie',cookie);if(!['GET','HEAD'].includes(request.method))headers.set('Content-Length',String(body.length));
  const app=createApplication({supabaseUrl:project,publishableKey,serviceKey,cryptoKeys,workspaceId:scope.workspaceId,origins:[],fetch:guardedFetch,setupEnabled:true,env:{}});
  const response=await app(new Request(qaOrigin+path,{method:request.method,headers,signal:deadline.signal,...(!['GET','HEAD'].includes(request.method)?{body}:{})}));
  // Preserve real bytes/status/Set-Cookie. Keep abort/deadline alive through SSE
  // and Range delivery rather than dropping the timer when headers arrive.
  if(!response.body){clean();return response;}const reader=response.body.getReader();let finished=false;
  const done=()=>{if(finished)return;finished=true;clean();deadline.signal.removeEventListener('abort',abort);};
  let controller:ReadableStreamDefaultController<Uint8Array>;const abort=()=>{done();void reader.cancel().catch(()=>{});try{controller.error(Error('QA_STREAM_UNAVAILABLE'));}catch{}};
  const stream=new ReadableStream<Uint8Array>({start(c){controller=c;deadline.signal.addEventListener('abort',abort,{once:true});if(deadline.signal.aborted)abort();},async pull(c){try{const p=await reader.read();if(finished)return;if(p.done){done();c.close();reader.releaseLock();}else c.enqueue(p.value);}catch{done();try{c.error(Error('QA_STREAM_UNAVAILABLE'));}catch{}}},async cancel(){done();deadline.abort();await reader.cancel().catch(()=>{});}});
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 }catch{clean();deadline.abort();return unavailable();}
});
