/** Full composition boundary, no real provider or authenticated-domain claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createApplication} from '../functions/_shared/application.ts';
const origin='https://fountain.example';
function fixture(){
 const requests=[];
 const app=createApplication({supabaseUrl:'https://fixture.supabase.co',serviceKey:'sb_secret_composition_fixture_only',publishableKey:'sb_publishable_composition_fixture_only',cryptoKeys:[{id:'fixture',secret:'a'.repeat(64)}],workspaceId:'family',origins:[origin],fetch:async(input)=>{requests.push(input);throw Error('PRIVATE_PROVIDER_DIAGNOSTIC');}});
 return {app,requests};
}
test('assembled application keeps health incomplete and anonymous sessions private without provider I/O',async()=>{
 const f=fixture();
 const health=await f.app(new Request(origin+'/functions/v1/fountain-api/health'));
 assert.equal(health.status,200);assert.equal((await health.json()).ready,false);
 const session=await f.app(new Request(origin+'/fountain-api/api/session'));const body=await session.json();
 assert.equal(body.authenticated,false);assert.equal(body.mode,'accounts');assert.equal(body.setup_supported,undefined);assert.equal(session.headers.has('Set-Cookie'),false);
 for(const path of ['/api/workspace','/api/backup','/api/accounts','/api/pages/private/events','/api/attachments/private/download','/sites/private']){
   const response=await f.app(new Request(origin+path));assert.equal(response.status,401);assert.equal((await response.json()).code,'AUTH_REQUIRED');
 }
 assert.equal(f.requests.length,0);
});
test('assembled login/setup reject unknown origins and do not expose provider diagnostics',async()=>{
 const f=fixture(),post=(body,source=origin)=>f.app(new Request(origin+'/api/session',{method:'POST',headers:{Origin:source,'X-Fountain-Request':'1'},body:JSON.stringify(body)}));
 const credentials={email:'fixture@example.invalid',password:'not-a-real-password'};
 assert.equal((await post(credentials,'https://untrusted.example')).status,403);assert.equal(f.requests.length,0);
 const setup=await post({...credentials,setup_nonce:'A'.repeat(43),create_account:true});assert.equal(setup.status,503);assert.equal(setup.headers.has('Set-Cookie'),false);assert.equal(f.requests.length,0);
 const login=await post(credentials);assert.equal(login.status,503);assert.equal(login.headers.has('Set-Cookie'),false);assert(!JSON.stringify(await login.json()).includes('PRIVATE_PROVIDER_DIAGNOSTIC'));assert.equal(f.requests.length,1);
});
