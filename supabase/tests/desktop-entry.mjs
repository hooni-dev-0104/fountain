/** Sealed template boundary fixtures, not deployed Edge/SQL/Auth/desktop proof.
 * The final test uses the real application with no session and zero provider I/O. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {createApplication} from '../functions/_shared/application.ts';

const source=await readFile(new URL('./live-desktop-entry.template.ts',import.meta.url),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex'),nonce=Buffer.alloc(32,7).toString('base64url');
const scope={workspaceId:'fountain-qa-cloud-desktop-0123456789abcdef',challengeHash:sha(nonce),nonceHash:'a'.repeat(64),emails:['owner@example.invalid','child@example.invalid']};
const project='https://ehnovtfadpkwtubmwltl.supabase.co',endpoint=project+'/functions/v1/fountain-verify/wire',cookie='fountain_session='+'A'.repeat(43),cf='__cf_bm=fixture_cf.private-value-123';
const fixtureEnv={SUPABASE_URL:project,SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:'sb_publishable_fixture12345'}),SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_fixture123456789012345678901234567890'})};
async function entry({action=async()=>new Response('application-response',{status:201}),provider=async()=>new Response('{}'),real=false,fast=false,env={},workspaceId=scope.workspaceId}={}){
 const script=stripTypeScriptTypes(source.replace(/^import [^\n]+;\n/gm,'').replace('QA_SCOPE',JSON.stringify({...scope,workspaceId})));
 const calls=[],configs=[],requests=[],reads=[];let serve;
 await vm.runInNewContext('(async()=>{'+script+'})()',{
  crypto,TextEncoder,TextDecoder,Uint8Array,Request,Response,Headers,URL,AbortController,AbortSignal,ReadableStream,atob,btoa,
  setTimeout:(f,ms)=>setTimeout(f,fast&&ms===125000?10:ms),clearTimeout,
  Deno:{env:{get(k){reads.push(k);return {...fixtureEnv,...env}[k];}},serve(h){serve=h;}},
  fetch:async(input,init)=>{calls.push({input,init});return provider(input,init);},
  createApplication(config){configs.push(config);if(real)return createApplication(config);return async request=>{requests.push(request);return action(config,request);};},
 });
 const request=(path='/api/session',o={})=>serve(new Request(o.url??endpoint,{method:o.method??'GET',headers:{'X-Fountain-Verify':nonce,'X-Fountain-Request':'1','X-Fountain-Test-Path':path,...o.headers},...(o.body!==undefined?{body:o.body,...(o.body instanceof ReadableStream?{duplex:'half'}:{})}:{})}));
 return {request,calls,configs,requests,reads};
}
async function status(response){await response.arrayBuffer();return response.status;}

test('import/configuration has zero I/O and rejects a different project',async()=>{
 const f=await entry();assert.equal(f.calls.length,0);assert.equal(f.configs.length,0);
 assert(!f.reads.includes('UNRELATED_SECRET'));await assert.rejects(entry({env:{SUPABASE_URL:'https://different.supabase.co'}}),/QA_SCOPE_REJECTED/);
});
test('the exact nonce gate precedes cookies, application and providers',async()=>{
 const f=await entry();for(const o of [
  {headers:{Cookie:cookie,'X-Fountain-Verify':''}},{headers:{'X-Fountain-Verify':'A'.repeat(43)}},{headers:{'X-Fountain-Verify':nonce.slice(0,-1)+'d'}},
  {headers:{Origin:'https://attacker.invalid'}},{headers:{Authorization:'Bearer fixture'}},{url:endpoint+'?token=fixture'},
  {url:project+'/functions/v1/another/wire'},{url:project+'/wire'},{method:'OPTIONS'},{headers:{'X-Fountain-Request':'0'}},
 ])assert.equal(await status(await f.request('/api/session',o)),404);
 assert.equal(f.configs.length,0);assert.equal(f.calls.length,0);
 assert.equal(await status(await f.request('/api/session',{url:project+'/fountain-verify/wire'})),201);
});
test('path guard rejects escapes/providers but permits once-encoded IDs and printable query backslashes',async()=>{
 const f=await entry();for(const path of ['/api/../admin','/api/%2e%2e/admin','/api/%252fadmin','/api/%2Fadmin','/api/%5cadmin','/api/%00','/api/%ZZ','/api//pages','/api/pages/#fragment','/scim/v2/Users','/auth/v1/user','/api/scim/tokens','https://attacker.invalid/api/session','//attacker.invalid/api/session','/sites/a/b','/api/session?x=%ZZ','/api/pages/'+'x'.repeat(8200)])assert.equal(await status(await f.request(path)),503,path);
 assert.equal(f.configs.length,0);
 for(const path of ['/api/pages/%ED%95%9C%EA%B8%80','/api/pages/id%20space','/api/pages/id%3F','/api/pages/id%23','/api/pages/id%25','/api/pages/a?x=\\printable%23%3F%25','/sites/qa-slug','/forms/qa-slug'])assert.equal(await status(await f.request(path)),201,path);
 assert.equal(f.calls.length,0);
});
test('normal session plus only the allowed Cloudflare cookie forwards one private session',async()=>{
 const f=await entry({action:async(_cfg,r)=>{assert(!r.headers.get('Cookie')?.includes('__cf_bm'));return new Response('no cookie echo');}});
 for(const raw of [cookie,cf+'; '+cookie,cookie+'; '+cf]){const response=await f.request('/api/session',{headers:{Cookie:raw}});assert.equal(f.requests.at(-1).headers.get('Cookie'),cookie);assert(!(await response.text()).includes('private-value'));}
 for(const headers of [{},{Cookie:cf}]){await status(await f.request('/api/session',{headers}));assert.equal(f.requests.at(-1).headers.get('Cookie'),null);}
 assert.equal(f.calls.length,0);
});
test('duplicate/malformed/foreign cookies and outer headers over 8KiB fail before app',async()=>{
 const f=await entry();for(const raw of [cookie+'; '+cookie,cookie+'; fountain_session=short','fountain_session=short','fountain_session='+('A'.repeat(42)+'B'),cookie+'; other_cookie=value',cf+'; '+cf,'__cf_bm=',cookie+'; fountain_session','fountain_session ='+ 'A'.repeat(43),cookie+'; __cf_bm='+ 'x'.repeat(8192)])assert.equal(await status(await f.request('/api/session',{headers:{Cookie:raw}})),503);
 assert.equal(f.configs.length,0);assert.equal(f.calls.length,0);
});
test('binary bytes, truthful lengths, Range and real status/Set-Cookie survive the wire',async()=>{
 const binary=new Uint8Array([0,255,128,10,13,0]);const f=await entry({action:async(cfg,r)=>{
  assert.equal(r.headers.get('Content-Length'),'6');assert.equal(r.headers.get('Content-Type'),'application/octet-stream');assert.equal(r.headers.get('Range'),'bytes=0-5');assert.equal(r.headers.get('If-Range'),'"fixture"');
  assert.equal(r.headers.get('Cookie'),cookie);for(const key of ['Origin','Authorization','X-Fountain-Verify','X-Fountain-Test-Path','X-Untrusted'])assert.equal(r.headers.has(key),false);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()),binary);assert.equal(cfg.workspaceId,scope.workspaceId);assert.equal(cfg.origins.length,0);assert.equal(cfg.setupEnabled,true);
  return new Response(binary,{status:206,headers:{'Set-Cookie':cookie+'; HttpOnly; Secure','Content-Range':'bytes 0-5/6'}});
 }});const response=await f.request('/api/uploads/owned/chunks?offset=0',{method:'PUT',headers:{Cookie:cf+'; '+cookie,'Content-Type':'application/octet-stream','Content-Length':'6',Range:'bytes=0-5','If-Range':'"fixture"','X-Untrusted':'drop'},body:binary});
 assert.equal(response.status,206);assert.equal(response.headers.get('Set-Cookie'),cookie+'; HttpOnly; Secure');assert.equal(response.headers.get('Content-Range'),'bytes 0-5/6');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),binary);
});
test('length mismatch, malformed length and actual body overflow reject before app',async()=>{
 const f=await entry();for(const length of ['7','-1','10000001','01'])assert.equal(await status(await f.request('/api/session',{method:'POST',headers:{'Content-Length':length},body:new Uint8Array(6)})),503);
 assert.equal(await status(await f.request('/api/session',{method:'POST',body:new Uint8Array(10000001)})),503);assert.equal(f.configs.length,0);
});
test('provider guard pins RPC workspace and rejects unrelated RPC/Auth/Storage destinations',async()=>{
 const allowed=await entry({action:cfg=>cfg.fetch(project+'/rest/v1/rpc/fountain_cloud_store_snapshot',{method:'POST',body:JSON.stringify({p_context:{workspaceId:scope.workspaceId}})})});assert.equal(await status(await allowed.request()),200);assert.equal(allowed.calls.length,1);
 for(const [url,init] of [
  [project+'/rest/v1/rpc/fountain_cloud_store_snapshot',{method:'POST',body:JSON.stringify({p_context:{workspaceId:'original'}})}],
  [project+'/rest/v1/rpc/fountain_cloud_scheduler_broker',{method:'POST',body:JSON.stringify({p_workspace_id:scope.workspaceId})}],['https://attacker.invalid/auth/v1/user',{}],
  [project+'/auth/v1/admin/users',{method:'POST',body:JSON.stringify({email:scope.emails[0],password:'fixture',email_confirm:true,app_metadata:{fountain_bootstrap:scope.nonceHash}})}],
  [project+'/auth/v1/admin/users/00000000-0000-4000-8000-000000000001',{method:'GET'}],
  [project+'/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:'foreign@example.invalid',password:'fixture'})}],
  [project+'/storage/v1/object/fountain-files/v1/'+'f'.repeat(64)+'/'+'0'.repeat(64)+'/0-'+'0'.repeat(64),{method:'GET'}],
 ]){const f=await entry({action:cfg=>cfg.fetch(url,init)});const response=await f.request();assert.equal(response.status,503);assert.equal(await response.text(),'{"code":"QA_UNAVAILABLE"}');assert.equal(f.calls.length,0);}
});
test('bootstrap Admin is unlocked by exactly the private scoped successful RPC, never client fields',async()=>{
 const f=await entry({provider:async()=>Response.json({allowed:true}),action:async cfg=>{
  await cfg.fetch(project+'/rest/v1/rpc/fountain_cloud_bootstrap_begin',{method:'POST',body:JSON.stringify({p_workspace_id:scope.workspaceId,p_nonce_hash:scope.nonceHash})});
  return cfg.fetch(project+'/auth/v1/admin/users',{method:'POST',body:JSON.stringify({email:scope.emails[0],password:'fixture',email_confirm:true,app_metadata:{fountain_bootstrap:scope.nonceHash}})});
 }});assert.equal(await status(await f.request()),200);assert.equal(f.calls.length,2);
});
test('pending incoming body and response stream cancel at the sealed deadline',async()=>{
 let outputCancelled=false;const f=await entry({fast:true,action:async()=>new Response(new ReadableStream({cancel(){outputCancelled=true;}}))});await assert.rejects((await f.request()).arrayBuffer());assert(outputCancelled);
 let inputCancelled=false;const body=new ReadableStream({cancel(){inputCancelled=true;}});assert.equal(await status(await f.request('/api/session',{method:'POST',body})),503);assert(inputCancelled);assert.equal(f.calls.length,0);
});
test('real application anonymous session remains anonymous, with Cloudflare-only cookie and no I/O',async()=>{
 const f=await entry({real:true,provider:async()=>{throw Error('Unexpected real I/O');}});const response=await f.request('/api/session',{headers:{Cookie:cf}});assert.equal(response.status,200);const value=await response.json();assert.equal(value.authenticated,false);assert.equal(value.setup_supported,true);assert.equal(f.calls.length,0);
 const publicText=JSON.stringify(value);for(const secret of ['private-value','sb_secret_',nonce,scope.nonceHash])assert(!publicText.includes(secret));
});

test('only explicit disposable client, inline and search namespace families may construct the gate',async()=>{
 for(const kind of ['native','inline','search']){const workspaceId='fountain-qa-cloud-'+kind+'-0123456789abcdef';const f=await entry({workspaceId});assert.equal(await status(await f.request()),201);assert.equal(f.configs[0].workspaceId,workspaceId);assert.equal(f.calls.length,0);}
 for(const invalid of ['original','fountain-qa-cloud-any-0123456789abcdef','fountain-qa-cloud-native-0123456789abcde','fountain-qa-cloud-native-0123456789abcdef-extra'])await assert.rejects(entry({workspaceId:invalid}),/QA_SCOPE_REJECTED/);
});
test('inline source RPC keeps the same exact disposable human-context workspace boundary',async()=>{
 const rpc=project+'/rest/v1/rpc/fountain_cloud_inline_attachment_range';
 for(const workspaceId of [scope.workspaceId,'original']){
  const f=await entry({action:cfg=>cfg.fetch(rpc,{method:'POST',body:JSON.stringify({p_context:{workspaceId},p_attachment_id:'inline',p_expected:{id:'inline'},p_offset:0,p_length:0,p_source_digest:null})})});
  assert.equal(await status(await f.request()),workspaceId===scope.workspaceId?200:503);assert.equal(f.calls.length,workspaceId===scope.workspaceId?1:0);
 }
});
