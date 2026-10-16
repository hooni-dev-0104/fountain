/** Execute the real entry with an in-memory Deno environment and real app.
 * No secrets, accounts, provider requests or cloud deployments are provisioned.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {createApplication} from '../functions/_shared/application.ts';
import {errorResponse} from '../functions/_shared/http.ts';
import {deployment} from '../functions/fountain-api/deployment.ts';

const source=await readFile(new URL('../functions/fountain-api/index.ts',import.meta.url),'utf8');
const script=stripTypeScriptTypes(source.replace(/^import [^\n]+;\n/gm,''));
function entry(extra={}){
 const values={SUPABASE_URL:'https://entry-fixture.supabase.co',SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:'sb_publishable_entry_fixture'}),SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_entry_fixture_only_0123456789'}),...extra};
 const reads=[],configs=[],requests=[];let serve;
 vm.runInNewContext(script,{
  crypto,TextEncoder,deployment,errorResponse,
  Deno:{env:{get(name){reads.push(name);return values[name];}},serve(handler){serve=handler;}},
  createApplication(config){configs.push(config);return createApplication({...config,fetch:async()=>{requests.push(true);throw Error('Unexpected provider I/O');}});},
 });
 return {reads,configs,requests,request:path=>serve(new Request('https://entry-fixture.invalid'+path))};
}
test('deployed entry forwards only explicit AI settings and keeps keys out of public responses',async()=>{
 const expected={FOUNTAIN_AI_PROVIDER:'compatible-http',FOUNTAIN_AI_URL:'https://provider.invalid/infer',FOUNTAIN_AI_MODEL:'fixture-model',FOUNTAIN_AI_KEY:'private-provider-fixture-key'};
 const f=entry({...expected,FOUNTAIN_SCIM_TOKEN:'unused-scim-fixture',UNRELATED_PRIVATE_SECRET:'unused-secret-fixture'});
 for(const path of ['/health','/api/session']){
  const response=await f.request(path);assert.equal(response.status,200);const text=await response.text();
  for(const hidden of ['private-provider-fixture-key','unused-scim-fixture','unused-secret-fixture','sb_secret_entry_fixture_only_0123456789'])assert(!text.includes(hidden));
 }
 assert.equal(f.configs.length,1);assert.deepEqual(structuredClone(f.configs[0].env),expected);
 assert(!f.reads.includes('FOUNTAIN_SCIM_TOKEN'));assert(!f.reads.includes('UNRELATED_PRIVATE_SECRET'));assert.equal(f.requests.length,0);
});
test('a fresh deployment has no configured AI and makes no implicit provider request',async()=>{
 const f=entry();assert.equal((await f.request('/health')).status,200);
 assert.deepEqual(structuredClone(f.configs[0].env),{});assert.equal(f.requests.length,0);
});
