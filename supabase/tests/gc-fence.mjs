/** Real loopback HTTP for the manual GC transport; SQL/pins/retirement below
 * are a MODEL, independently verified by actual PostgreSQL QA. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createUploadGarbageFence} from '../functions/_shared/gc-fence.ts';
const context={workspaceId:'family',memberId:'owner',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)};
const auth=()=>({hash:context.sessionHash,userId:context.userId,authSessionId:context.authSessionId,cacheBinding:context.cacheBinding,expiresAt:Date.now()+60000,profile:{workspaceId:context.workspaceId,authSessionActive:true,member:{id:'owner',name:'Owner',email:'owner@qa.invalid',role:'owner',active:true}}});
const item={version:1,attachmentId:'retired',offset:0,size:4,sha256:'c'.repeat(64)},secret='sb_secret_gc_fence_test_only';
async function fixture(t,handler){const calls=[];const server=createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);const body=Buffer.concat(parts).toString();calls.push({path:req.url,headers:req.headers,body});await handler(req,res,body,calls.length);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return {url:'http://127.0.0.1:'+server.address().port,calls};}
test('manual fence sends only the current real person context and exact batch, server key stays private',async t=>{
 const f=await fixture(t,async(req,res,body)=>{assert.equal(req.headers.apikey,secret);assert.equal(req.headers.authorization,undefined);assert.equal(req.url,'/rest/v1/rpc/fountain_cloud_upload_gc_fence');assert.deepEqual(JSON.parse(body),{p_context:context,p_id:'retired',p_manifests:[item]});res.setHeader('Content-Type','application/json');res.end('{"allowed":true}');});
 await createUploadGarbageFence({supabaseUrl:f.url,serviceKey:secret,authorize:async()=>auth()})(auth(),'retired',[item]);assert.equal(f.calls.length,1);
});
test('an accepted fence with lost ACK retries identical request bytes and never releases quota itself',async t=>{
 const f=await fixture(t,async(req,res,body,index)=>{if(index===1){req.socket.destroy();return;}assert.equal(body,f.calls[0].body);res.end('{"allowed":true}');});
 await createUploadGarbageFence({supabaseUrl:f.url,serviceKey:secret,authorize:async()=>auth()})(auth(),'retired',[item]);assert.equal(f.calls.length,2);assert(f.calls.every(c=>c.path.endsWith('upload_gc_fence')));
});
test('changed login binding and invalid batch stop before any RPC; current grant may still be denied by SQL',async t=>{
 const f=await fixture(t,async(req,res)=>{res.statusCode=409;res.end(JSON.stringify({message:'PRIVATE '+secret}));});
 const changed=createUploadGarbageFence({supabaseUrl:f.url,serviceKey:secret,authorize:async()=>({...auth(),cacheBinding:'d'.repeat(32)})});await assert.rejects(changed(auth(),'retired',[item]),e=>e.status===401);assert.equal(f.calls.length,0);
 const fence=createUploadGarbageFence({supabaseUrl:f.url,serviceKey:secret,authorize:async()=>auth()});for(const bad of [[],Array(101).fill(item),[{...item,attachmentId:'foreign'}],[{...item,sha256:'bad'}],[{...item,offset:1}]])await assert.rejects(fence(auth(),'retired',bad),e=>e.status===400);assert.equal(f.calls.length,0);
 await assert.rejects(fence(auth(),'retired',[item]),e=>e.status===409&&!e.message.includes(secret)&&!e.message.includes('PRIVATE'));assert.equal(f.calls.length,1);
});
test('malformed/oversized replies and redirects never authorize physical deletion or expose diagnostics',async t=>{
 for(const mode of ['false','extra','large','bad','redirect']){const f=await fixture(t,async(req,res)=>{if(mode==='redirect'){res.statusCode=307;res.setHeader('Location','https://untrusted.invalid/');res.end();return;}res.end(mode==='false'?'{"allowed":false}':mode==='extra'?'{"allowed":true,"private":"secret"}':mode==='large'?' '.repeat(4097):'PRIVATE '+secret);});await assert.rejects(createUploadGarbageFence({supabaseUrl:f.url,serviceKey:secret,authorize:async()=>auth()})(auth(),'retired',[item]),e=>e.status===503&&!e.message.includes(secret));assert.equal(f.calls.length,2);assert(f.calls.every(call=>call.path==='/rest/v1/rpc/fountain_cloud_upload_gc_fence'));}
});
