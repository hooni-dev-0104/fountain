/** Real app/entry composition, anonymous Auth only; zero provider or cloud I/O.
 * VM supplies environment fixtures, never a fabricated owner or Auth session. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createApplication} from '../functions/_shared/application.ts';
import {errorResponse} from '../functions/_shared/http.ts';
import {deployment} from '../functions/fountain-api/deployment.ts';

const web='https://family.example.invalid',other='https://other.example.invalid',backend='https://fixture.supabase.co';
const publishable='sb_publishable_fixture_public_12345',secret='sb_secret_fixture_private_12345678901234567890';
const config={supabaseUrl:backend,publishableKey:publishable,serviceKey:secret,cryptoKeys:[{id:'fixture',secret}],workspaceId:'qa-public-web-origin',origins:[web]};
function fixture(extra={}){
 const calls=[];const app=createApplication({...config,...extra,fetch:async(input,init)=>{calls.push({input,init});throw Error('private-provider-diagnostic');}});
 return {calls,async request(path='/api/session',options={}){try{return await app(new Request(backend+path,options));}catch(error){return errorResponse(error);}}};
}
function assertNoSecrets(text){for(const value of [secret,publishable,'private-provider-diagnostic','fixture_session_private','refresh_token','access_token','sessionHash'])assert(!text.includes(value),value);}

test('default, omitted, undefined and null preserve the original session JSON exactly',async()=>{
 const baseline=fixture(),expected=await (await baseline.request()).text();assert.equal(JSON.parse(expected).authenticated,false);assert(!expected.includes('public_web_origin'));
 for(const extra of [{},{publicWebOrigin:undefined},{publicWebOrigin:null}]){const f=fixture(extra);assert.equal(await (await f.request()).text(),expected);assert.equal(f.calls.length,0);}
 assert.equal(deployment.publicWebOrigin,null);assert.equal(baseline.calls.length,0);assertNoSecrets(expected);
});
test('only explicitly configured HTTPS origin appears in real anonymous GET and HEAD stays bodyless',async()=>{
 const f=fixture({publicWebOrigin:web,setupEnabled:true});const response=await f.request();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.has('Set-Cookie'),false);
 const text=await response.text(),value=JSON.parse(text);assert.equal(value.public_web_origin,web);assert.equal(value.authenticated,false);assert.equal(value.setup_supported,true);assertNoSecrets(text);
 const head=await f.request('/api/session',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('Content-Type'),response.headers.get('Content-Type'));assert.equal(f.calls.length,0);
});
test('invalid or unallowlisted configuration fails before real Auth/provider I/O',async()=>{
 for(const publicWebOrigin of ['',false,7,{},[],other,'http://family.example.invalid','http://localhost:8787','https://user:pass@family.example.invalid','https://family.example.invalid/','https://family.example.invalid/path','https://family.example.invalid?query=private','https://family.example.invalid#fragment','https://FAMILY.example.invalid','https://family.example.invalid:443','https://family.example.invalid\\escape']){
  const f=fixture({publicWebOrigin});const response=await f.request('/api/session',{method:'POST',headers:{'X-Fountain-Request':'1','Content-Type':'application/json'},body:JSON.stringify({email:'qa@example.invalid',password:'fixture-private-password'})});
  assert.equal(response.status,500,JSON.stringify(publicWebOrigin));const text=await response.text();assert.equal(JSON.parse(text).code,'CONFIGURATION_ERROR');assertNoSecrets(text);assert.equal(f.calls.length,0);
 }
 const f=fixture({origins:[],publicWebOrigin:web});assert.equal((await f.request()).status,500);assert.equal(f.calls.length,0);
});
test('only allowlisted CORS origins remain allowed and client metadata cannot override deployment configuration',async()=>{
 const f=fixture({publicWebOrigin:web});
 const allowed=await f.request('/api/session?public_web_origin='+encodeURIComponent(other),{headers:{Origin:web,'X-Public-Web-Origin':other}});assert.equal(allowed.status,200);assert.equal((await allowed.json()).public_web_origin,web);
 const denied=await f.request('/api/session',{headers:{Origin:other}});assert.equal(denied.status,403);assert.equal(Object.hasOwn(await denied.json(),'public_web_origin'),false);
 const preflight=await f.request('/api/session',{method:'OPTIONS',headers:{Origin:web,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type, X-Fountain-Request'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),web);assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'),'true');
 assert.equal(f.calls.length,0);
});
test('DELETE retains ordinary anonymous logout semantics and private clear-cookie stays a header',async()=>{
 const f=fixture({publicWebOrigin:web});const response=await f.request('/api/session',{method:'DELETE',headers:{'X-Fountain-Request':'1'},body:'{}'});assert.equal(response.status,200);
 const text=await response.text();assert.equal(JSON.parse(text).authenticated,false);assert.equal(Object.hasOwn(JSON.parse(text),'public_web_origin'),false);assert(!text.includes('fountain_session='));assertNoSecrets(text);assert.equal(f.calls.length,0);
});
test('real Auth login rejection keeps provider diagnostics private and never returns session metadata',async()=>{
 const calls=[];const app=createApplication({...config,publicWebOrigin:web,fetch:async(input,init)=>{calls.push({input,init});return Response.json({error:'invalid_grant',error_description:'private-provider-diagnostic '+secret},{status:401});}});
 const response=await app(new Request(backend+'/api/session',{method:'POST',headers:{Origin:web,'X-Fountain-Request':'1','Content-Type':'application/json'},body:JSON.stringify({email:'fixture@example.invalid',password:'fixture-private-password'})}));
 assert.equal(response.status,401);const text=await response.text();assert.equal(JSON.parse(text).code,'AUTH_REJECTED');assert.equal(Object.hasOwn(JSON.parse(text),'public_web_origin'),false);assert.equal(response.headers.has('Set-Cookie'),false);assertNoSecrets(text);
 assert.equal(calls.length,1);assert.equal(new URL(calls[0].input).pathname,'/auth/v1/token');
});

const entrySource=stripTypeScriptTypes((await readFile(new URL('../functions/fountain-api/index.ts',import.meta.url),'utf8')).replace(/^import [^\n]+;\n/gm,''));
function entry(publicWebOrigin,origins=[web]){
 const configs=[],reads=[],calls=[];let serve;const values={SUPABASE_URL:backend,SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:publishable}),SUPABASE_SECRET_KEYS:JSON.stringify({default:secret}),UNRELATED_SECRET:'must-not-read'};
 vm.runInNewContext(entrySource,{
  crypto,TextEncoder,errorResponse,deployment:{...deployment,workspaceId:config.workspaceId,webOrigins:origins,publicWebOrigin},
  Deno:{env:{get(name){reads.push(name);return values[name];}},serve(handler){serve=handler;}},
  createApplication(value){configs.push(value);return createApplication({...value,fetch:async()=>{calls.push(true);throw Error('private-provider-diagnostic');}});},
 });
 return {configs,reads,calls,request:()=>serve(new Request(backend+'/api/session'))};
}
test('real entry passes only present nonsecret deployment metadata and performs no provider I/O',async()=>{
 const configured=entry(web),response=await configured.request(),text=await response.text();assert.equal(response.status,200);assert.equal(JSON.parse(text).public_web_origin,web);assert.equal(configured.configs[0].publicWebOrigin,web);assertNoSecrets(text);assert.equal(configured.calls.length,0);assert(!configured.reads.includes('UNRELATED_SECRET'));
 for(const value of [null,undefined]){const f=entry(value),response=await f.request();assert.equal(response.status,200);assert.equal(Object.hasOwn(f.configs[0],'publicWebOrigin'),false);assert.equal(Object.hasOwn(await response.json(),'public_web_origin'),false);assert.equal(f.calls.length,0);}
 const bad=entry(other);assert.equal((await bad.request()).status,500);assert.equal(bad.calls.length,0);
});
