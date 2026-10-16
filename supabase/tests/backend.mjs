/** Entry integration with an injected Auth boundary; actual deployment is verified separately. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createBackend} from '../functions/_shared/backend.ts';
import {AuthError} from '../functions/_shared/auth.ts';
const origin='https://fountain.example';
test('health is explicitly incomplete and exposes no workspace or credentials',async()=>{
  let calls=0;const app=createBackend({origins:[origin],auth:async()=>{calls++;throw Error('private');}});
  const result=await app(new Request(origin+'/functions/v1/fountain-api/health'));assert.equal(result.status,200);assert.equal((await result.json()).ready,false);assert.equal(calls,0);
});
test('session integration preserves typed failures and captured-binding logout',async()=>{
  let captured;const app=createBackend({origins:[origin],auth:async()=>({session:async()=>({status:200,body:{required:true,authenticated:false,mode:'accounts',member:null}}),login:async()=>{throw new AuthError(401,'AUTH_REJECTED','로그인을 확인해 주세요.');},logout:async(cookie,options)=>{captured={cookie,options};return{status:200,body:{authenticated:false},setCookie:'fountain_session=; Max-Age=0; HttpOnly; Secure; SameSite=Strict'};}})});
  const session=await app(new Request(origin+'/fountain-api/api/session'));assert.equal((await session.json()).authenticated,false);
  const login=await app(new Request(origin+'/api/session',{method:'POST',headers:{Origin:origin,'X-Fountain-Request':'1'},body:'{"email":"fixture@example.invalid","password":"not-a-real-password"}'}));assert.equal(login.status,401);assert.equal((await login.json()).code,'AUTH_REJECTED');
  const logout=await app(new Request(origin+'/api/session',{method:'DELETE',headers:{Origin:origin,'X-Fountain-Request':'1',Cookie:'fountain_session=opaque'},body:'{"cache_binding":"captured-A"}'}));assert.equal(logout.status,200);assert.deepEqual(captured,{cookie:'fountain_session=opaque',options:{expectedBinding:'captured-A'}});assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);
  const privateRead=await app(new Request(origin+'/api/workspace'));assert.equal(privateRead.status,401);assert.equal((await privateRead.json()).code,'AUTH_REQUIRED');
});
test('unconfigured business routes cannot pretend feature parity or bypass identity',async()=>{
  const app=createBackend({origins:[],auth:async()=>({session:async()=>({status:200,body:{authenticated:true}})})});
  const result=await app(new Request(origin+'/api/workspace'));assert.equal(result.status,503);assert.equal((await result.json()).code,'BACKEND_MIGRATION_IN_PROGRESS');
  const head=await app(new Request(origin+'/health',{method:'HEAD'}));assert.equal(head.status,200);assert.equal(await head.text(),'');
});
test('domain dispatch receives only a per-request verified context and cannot bypass the boundary',async()=>{
  let dispatched=0;const fake=()=>({session:async()=>({status:200,body:{authenticated:true}})});
  const missing=createBackend({origins:[],auth:async()=>fake(),domain:async()=>{dispatched++;return new Response('private');}});
  assert.equal((await missing(new Request(origin+'/api/workspace'))).status,503);assert.equal(dispatched,0);
  const denied=createBackend({origins:[],auth:async()=>({...fake(),authorize:async()=>{throw new AuthError(401,'AUTH_REQUIRED','로그인이 필요합니다.');}}),domain:async()=>{dispatched++;return new Response('private');}});
  assert.equal((await denied(new Request(origin+'/api/workspace'))).status,401);assert.equal(dispatched,0);
});
