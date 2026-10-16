/** Actual loopback HTTP transport tests; SQL/CAS/RLS require root's real-DB suite. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createSessionVault, VaultError } from '../functions/_shared/vault.ts';

const serviceKey='sb_secret_isolated_fixture_not_a_real_key',workspaceId='isolated-vault-workspace';
const hash='a'.repeat(64),leaseId='lease_'.repeat(6),createdAt=Date.now(),tokens={version:1,keyId:'fixture-key',iv:'AAAAAAAAAAAAAAAA',data:'AAAAAAAAAAAAAAAAAAAAAA'};
const row={hash,userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'b'.repeat(32),createdAt,expiresAt:createdAt+604800000,version:0,tokens,revokedAt:null,logoutPending:false};
let handler=(_call,response)=>{response.writeHead(204);response.end();},calls=[],checks=0,unexpected=0;
const server=http.createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const call={url:request.url,method:request.method,headers:request.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8')||'null')};calls.push(call);
  if(!request.url.startsWith('/rest/v1/rpc/fountain_cloud_')){unexpected++;response.writeHead(404);response.end();return;}
  try{handler(call,response);}catch{response.writeHead(500);response.end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const supabaseUrl='http://127.0.0.1:'+server.address().port,vault=createSessionVault({supabaseUrl,serviceKey,workspaceId});
const json=value=>{handler=(_call,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};};
const rejected=async action=>{await assert.rejects(action,error=>error instanceof VaultError&&error.status===503&&error.code==='SESSION_STORAGE_UNAVAILABLE'&&!String(error).includes(serviceKey)&&!String(error).includes('PRIVATE_DIAGNOSTIC'));checks++;};
const last=()=>calls.at(-1),name=()=>last().url.slice('/rest/v1/rpc/fountain_cloud_'.length);
try{
  await vault.create(structuredClone(row));assert.equal(name(),'vault_create');assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_row:row});checks++;
  assert.equal(last().headers.apikey,serviceKey);assert.equal(last().headers.authorization,undefined,'modern secret key is not a JWT');assert.equal(last().method,'POST');checks++;
  json(row);assert.deepEqual(await vault.read(hash),row);assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_hash:hash});checks++;
  json(null);assert.equal(await vault.read(hash),null);checks++;
  const profile={workspaceId,authSessionActive:true,member:{id:'legacy-local',name:'나',email:'local@fountain.local',role:'owner',active:true}};
  json(profile);assert.deepEqual(await vault.resolveProfile(row.userId,row.authSessionId),profile);assert.equal(name(),'resolve_profile');assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_user_id:row.userId,p_auth_session_id:row.authSessionId});checks++;
  json({...profile,authSessionActive:false});assert.equal((await vault.resolveProfile(row.userId,row.authSessionId)).authSessionActive,false,'live Auth-session failure remains distinguishable from unlinked identity');checks++;
  for(const answer of [true,false]){
    json(answer);assert.equal(await vault.claimRefresh(hash,0,leaseId,createdAt+30000,createdAt),answer);assert.equal(name(),'vault_claim_refresh');assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_hash:hash,p_expected_version:0,p_lease_id:leaseId,p_until:createdAt+30000,p_now:createdAt});checks++;
    assert.equal(await vault.finishRefresh(hash,0,leaseId,tokens),answer);assert.equal(name(),'vault_finish_refresh');assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_hash:hash,p_expected_version:0,p_lease_id:leaseId,p_tokens:tokens});checks++;
    assert.equal(await vault.finishLogout(hash,1),answer);assert.equal(name(),'vault_finish_logout');checks++;
  }
  handler=(_call,response)=>{response.writeHead(204);response.end();};await vault.releaseRefresh(hash,leaseId);assert.equal(name(),'vault_release_refresh');checks++;
  const revoked={...row,version:1,revokedAt:createdAt+1,logoutPending:true};json(revoked);assert.deepEqual(await vault.revoke(hash,createdAt+1),revoked);assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_hash:hash,p_now:createdAt+1,p_expected_version:null,p_lease_id:null});checks++;
  assert.deepEqual(await vault.revoke(hash,createdAt+2),revoked,'adapter preserves retry-only envelope/version returned by idempotent SQL revoke');checks++;
  await vault.revoke(hash,createdAt+2,{version:0,leaseId});assert.deepEqual(last().body,{p_workspace_id:workspaceId,p_hash:hash,p_now:createdAt+2,p_expected_version:0,p_lease_id:leaseId});checks++;
  json(null);assert.equal(await vault.revoke(hash,createdAt+3,{version:0,leaseId}),null,'lost refresh holder cannot interpret a failed conditional fence as its own new revocation');checks++;
  json({...revoked,tokens:null,logoutPending:false});assert.equal((await vault.read(hash)).tokens,null);checks++;

  const legacyKey=[Buffer.from('fixture-header').toString('base64url'),Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url'),'fixture-signature'].join('.');
  json(null);await createSessionVault({supabaseUrl,serviceKey:legacyKey,workspaceId}).read(hash);assert.equal(last().headers.apikey,legacyKey);assert.equal(last().headers.authorization,'Bearer '+legacyKey);checks++;
  for(const key of ['sb_publishable_not_service','eyJ.bad.signature',legacyKey.replace(legacyKey.split('.')[1],Buffer.from('{"role":"anon"}').toString('base64url'))])assert.throws(()=>createSessionVault({supabaseUrl,serviceKey:key,workspaceId}),VaultError);
  for(const url of ['http://not-loopback.invalid','https://user:password@example.invalid','https://example.invalid/path','https://example.invalid/?private=1','https://example.invalid/#fragment'])assert.throws(()=>createSessionVault({supabaseUrl:url,serviceKey,workspaceId}),VaultError);checks+=8;
  let before=calls.length;
  for(const invalid of [hash.toUpperCase(),'raw-43-character-cookie-handle','',null])await rejected(()=>vault.read(invalid));
  for(const invalid of [{...row,tokens:{...tokens,access_token:'PRIVATE_DIAGNOSTIC'}},{...row,version:1},{...row,createdAt:String(createdAt)},{...row,expiresAt:row.expiresAt+1},{...row,tokens:null},{...row,access_token:'PRIVATE_DIAGNOSTIC'}])await rejected(()=>vault.create(invalid));
  for(const invalid of [{...tokens,data:'not valid base64'},{...tokens,iv:'too-short'},{...tokens,version:2},{...tokens,data:'AB'}])await rejected(()=>vault.finishRefresh(hash,0,leaseId,invalid));
  await rejected(()=>vault.claimRefresh(hash,0,leaseId,createdAt+60001,createdAt));await rejected(()=>vault.claimRefresh(hash,-1,leaseId,createdAt+30000,createdAt));await rejected(()=>vault.resolveProfile('invalid',row.authSessionId));assert.equal(calls.length,before,'invalid input never reaches the service credential endpoint');checks++;
  for(const invalid of [{...row,hash:'c'.repeat(64)},{...row,tokens:{...tokens,keyId:'bad key'}},{...row,createdAt:'wrong'},{...row,revokedAt:createdAt,logoutPending:false},{...row,logoutPending:true},{...row,extra:'PRIVATE_DIAGNOSTIC'}]){json(invalid);await rejected(()=>vault.read(hash));}
  for(const invalid of [{...profile,workspaceId:'other-workspace'},{...profile,member:{...profile.member,role:'superuser'}},{...profile,member:{...profile.member,active:'true'}},{...profile,authSessionActive:'true'}]){json(invalid);await rejected(()=>vault.resolveProfile(row.userId,row.authSessionId));}
  json('true');await rejected(()=>vault.finishLogout(hash,1));
  for(const status of [400,401,403,404,409,429,500,503]){handler=(_call,response)=>{response.writeHead(status);response.end(JSON.stringify({message:'PRIVATE_DIAGNOSTIC '+serviceKey}));};await rejected(()=>vault.read(hash));}
  handler=(_call,response)=>{response.writeHead(302,{Location:supabaseUrl+'/unexpected-service-key-destination'});response.end();};await rejected(()=>vault.read(hash));assert.equal(unexpected,0,'service credential is never forwarded through redirects');checks++;
  handler=(_call,response)=>{response.writeHead(200);response.end('"'+'x'.repeat(262145)+'"');};await rejected(()=>vault.read(hash));
  handler=(_call,response)=>{response.writeHead(200);response.end('{bad-json PRIVATE_DIAGNOSTIC');};await rejected(()=>vault.read(hash));
  handler=(_call,response)=>{response.writeHead(200);response.end(Buffer.from([0xff]));};await rejected(()=>vault.read(hash));
  handler=(_call,response)=>{setTimeout(()=>{if(!response.destroyed){response.writeHead(200);response.end('null');}},100);};await rejected(()=>createSessionVault({supabaseUrl,serviceKey,workspaceId,timeoutMs:20}).read(hash));
  await rejected(()=>createSessionVault({supabaseUrl,serviceKey,workspaceId,fetch:async()=>{throw Error('PRIVATE_DIAGNOSTIC '+serviceKey);}}).read(hash));
  assert.ok(calls.every(call=>call.body.p_workspace_id===workspaceId));checks++;
  console.log('PASS vault adapter:',checks,'actual HTTP contract/validation/redaction/header/namespace/redirect/bounds checks; SQL CAS/RLS not exercised by this fixture');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
