import assert from 'node:assert/strict';
import test from 'node:test';
import {HttpError,canonicalOrigin,requestPath,checkRequest,readBytes,readJSON,jsonResponse,errorResponse,preflight} from '../functions/_shared/http.ts';
import {AuthError} from '../functions/_shared/auth.ts';
import {APIError} from '../functions/_shared/access.ts';
const origin='https://fountain.example',origins=new Set([origin]);
test('origins are canonical and remote HTTPS only',()=>{
  assert.equal(canonicalOrigin(origin+'/'),origin);assert.equal(canonicalOrigin('http://localhost:8787'),'http://localhost:8787');
  for(const value of ['http://outside.example','https://user:pass@example.test','https://example.test/path','https://example.test/?key=secret','file:///tmp/a'])assert.throws(()=>canonicalOrigin(value),HttpError);
});
test('fixed Edge prefix preserves canonical logical APIs without encoded traversal',()=>{
  assert.equal(requestPath(new Request(origin+'/functions/v1/fountain-api/api/pages/%ED%95%9C%EA%B8%80')),'/api/pages/%ED%95%9C%EA%B8%80');
  for(const path of ['/api//pages','/api/pages/%252e%252e/secret','/api/pages/id%2fsecret','/api/pages/%2500','/api/pages/%255csecret','/api/pages/%ZZ'])assert.throws(()=>requestPath(new Request(origin+path)),HttpError);
});
test('known web origin and native no-Origin preserve CSRF header requirements',()=>{
  checkRequest(new Request(origin+'/api/session',{method:'POST',headers:{'X-Fountain-Request':'1'}}),origins);
  for(const value of ['null','https://evil.example'])assert.throws(()=>checkRequest(new Request(origin+'/api/session',{method:'POST',headers:{Origin:value,'X-Fountain-Request':'1'}}),origins),HttpError);
  assert.throws(()=>checkRequest(new Request(origin+'/api/session',{method:'POST',headers:{Origin:origin}}),origins),HttpError);
});
test('stream budgets reject oversized, incomplete and invalid UTF-8 bodies',async()=>{
  await assert.rejects(()=>readBytes(new Request(origin,{method:'POST',body:'abcdef'}),5),error=>error.status===413);
  await assert.rejects(()=>readBytes(new Request(origin,{method:'POST',body:'x',headers:{'Content-Length':'5'}})),error=>error.status===400);
  await assert.rejects(()=>readJSON(new Request(origin,{method:'POST',body:Uint8Array.of(0xff)})),error=>error.status===400);
  for(const text of ['[]','null','NaN','{"x":Infinity}'])await assert.rejects(()=>readJSON(new Request(origin,{method:'POST',body:text})),error=>error.status===400);
  assert.deepEqual(await readJSON(new Request(origin,{method:'POST',body:'{"text":"가족 🏠"}'})),{text:'가족 🏠'});
});
test('responses never echo private unexpected errors and preflight is bounded',async()=>{
  const response=errorResponse(Error('private password=DO_NOT_ECHO'));assert.equal(response.status,500);assert.doesNotMatch(await response.text(),/DO_NOT_ECHO/);
  const headers=jsonResponse({ok:true}).headers;assert.equal(headers.get('Cache-Control'),'no-store');assert.equal(headers.get('X-Content-Type-Options'),'nosniff');
  const request=new Request(origin,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type, X-Fountain-Request'}});
  const allowed=preflight(request,origins);assert.equal(allowed.status,204);assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(allowed.headers.get('Access-Control-Allow-Credentials'),'true');
  assert.throws(()=>preflight(new Request(origin,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization'}}),origins),HttpError);
});
test('explicit trusted auth/domain errors retain status while forged driver lookalikes are redacted',async()=>{
  const auth=errorResponse(new AuthError(401,'AUTH_REJECTED','로그인을 확인해 주세요.'));assert.equal(auth.status,401);assert.equal((await auth.json()).code,'AUTH_REJECTED');
  assert.equal(errorResponse(new APIError(403,'Resource access denied')).status,403);
  const forged=errorResponse(Object.assign(Error('password=DO_NOT_ECHO'),{status:401,code:'AUTH_REJECTED'}));assert.equal(forged.status,500);assert.doesNotMatch(await forged.text(),/DO_NOT_ECHO/);
});
