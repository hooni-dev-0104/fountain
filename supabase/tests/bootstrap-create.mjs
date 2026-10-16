/** Bootstrap orchestration over a real loopback HTTP provider fixture.
 * Auth.setup signature/session validation and SQL semantics have separate tests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createOnboarding} from '../functions/_shared/onboarding.ts';
import {AuthError} from '../functions/_shared/auth.ts';
const credentials={email:'owner@example.invalid',password:'fixture-password-long',nonce:'A'.repeat(43)},serviceKey='sb_secret_only_isolated_fixture',result={status:200,body:{authenticated:true},setCookie:'private-fixture-cookie'};
async function fixture(){
 const calls=[];let mode='ok',created=false;
 const server=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);calls.push({path:req.url,body,key:req.headers.apikey});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/rest/v1/rpc/fountain_cloud_bootstrap_begin'){
   if(mode==='deny'){res.statusCode=403;res.end('{"diagnostic":"PRIVATE"}');return;}
   if(mode==='false'){res.end('{"allowed":false}');return;}
   res.end('{"allowed":true}');return;
  }
  if(req.url==='/auth/v1/admin/users'){
   if(mode==='duplicate'){res.statusCode=409;res.end('{"diagnostic":"PRIVATE"}');return;}
   if(mode==='provider422'){res.statusCode=422;res.end('{"code":"email_exists","msg":"PRIVATE"}');return;}
   created=true;if(mode==='lost'){res.destroy();return;}
   res.end(JSON.stringify({id:'11111111-1111-4111-8111-111111111111',app_metadata:body.app_metadata}));return;
  }res.statusCode=404;res.end('{}');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api=createOnboarding({supabaseUrl:`http://127.0.0.1:${server.address().port}`,serviceKey,publishableKey:'public-fixture-key',workspaceId:'qa-bootstrap'});
 return {api,calls,get created(){return created;},set mode(v){mode=v;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const unrecognized=()=>new AuthError(401,'AUTH_REJECTED','Fixture account is not ready');
test('existing signed account setup completes without any Admin creation',async()=>{
 const f=await fixture();try{assert.deepEqual(await f.api.bootstrapCreate(credentials,async body=>{assert.deepEqual(body,credentials);return result;}),result);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('only an explicit valid operator code permits no-email account creation followed by signed setup',async()=>{
 const f=await fixture();try{let setup=0;const value=await f.api.bootstrapCreate(credentials,async()=>{if(!setup++)throw unrecognized();return result;});
  assert.deepEqual(value,result);assert.equal(setup,2);assert.equal(f.calls.length,2);assert(f.calls.every(c=>c.key===serviceKey));
  assert.equal(f.calls[0].body.p_workspace_id,'qa-bootstrap');assert.match(f.calls[0].body.p_nonce_hash,/^[a-f0-9]{64}$/);assert(!JSON.stringify(f.calls[0]).includes(credentials.nonce));
  assert.equal(f.calls[1].body.email_confirm,true);assert.equal(f.calls[1].body.password,credentials.password);assert.equal(f.calls[1].body.app_metadata.fountain_bootstrap,f.calls[0].body.p_nonce_hash);
 }finally{await f.close();}
});
test('provider/storage errors cannot fall through into creating another account',async()=>{
 const f=await fixture();try{for(const error of [new AuthError(503,'SETUP_UNAVAILABLE','private'),new AuthError(403,'SETUP_REJECTED','private'),new AuthError(409,'SETUP_CONFLICT','private')])await assert.rejects(f.api.bootstrapCreate(credentials,async()=>{throw error;}),e=>e===error);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('rejected or malformed preflight and duplicate account never return a new cookie',async()=>{
 for(const mode of ['deny','false','duplicate']){const f=await fixture();try{f.mode=mode;await assert.rejects(f.api.bootstrapCreate(credentials,async()=>{throw unrecognized();}),e=>e instanceof AuthError&&!e.message.includes('PRIVATE'));assert.equal(f.created,false);assert(!f.calls.some(c=>c.path.includes('logout')||c.path.includes('?filter')));}finally{await f.close();}}
});
test('an uncertain create acknowledgement is recovered by the next signed setup without resending Admin creation',async()=>{
 const f=await fixture();try{f.mode='lost';await assert.rejects(f.api.bootstrapCreate(credentials,async()=>{throw unrecognized();}),e=>e.status===503);assert.equal(f.created,true);const prior=f.calls.length;
  assert.deepEqual(await f.api.bootstrapCreate(credentials,async()=>result),result);assert.equal(f.calls.length,prior);
 }finally{await f.close();}
});
test('actual Admin 422 input rejection is not a retryable infrastructure failure',async()=>{
 const f=await fixture();try{f.mode='provider422';await assert.rejects(f.api.bootstrapCreate(credentials,async()=>{throw unrecognized();}),e=>e instanceof AuthError&&e.status===400&&e.code==='INVALID_SETUP'&&!e.message.includes('PRIVATE'));assert.equal(f.created,false);assert.equal(f.calls.filter(c=>c.path==='/auth/v1/admin/users').length,1);}finally{await f.close();}
});
