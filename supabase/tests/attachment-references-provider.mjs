/** Bounded RPC transport contract; fake fetch only, no external service writes. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createStoreProvider,normalizeSelection} from '../functions/_shared/store.ts';
const context={workspaceId:'refs-fixture',memberId:'owner',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)},attachmentId='문😀'.repeat(80),serviceKey='sb_secret_reference_transport_fixture_only';
const reply=()=>({context,attachmentId,revision:17,referenced:false});
function fixture(fetch){return createStoreProvider({supabaseUrl:'https://fixture.invalid',serviceKey,fetch});}
const rejected=(promise,status)=>assert.rejects(promise,error=>error.status===status&&!String(error.message).includes(serviceKey));
test('actual store provider uses the fixed metadata RPC and preserves 160-scalar opaque IDs/context',async()=>{
 let calls=0;const provider=fixture(async(url,init)=>{calls++;assert.equal(url,'https://fixture.invalid/rest/v1/rpc/fountain_cloud_store_attachment_references');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.headers.apikey,serviceKey);assert.equal(init.headers.Authorization,undefined);assert.deepEqual(JSON.parse(init.body),{p_context:context,p_attachment_id:attachmentId});return Response.json(reply());});
 const value=await provider.attachmentReferences({context,attachmentId});assert.deepEqual(value,reply());assert(Object.isFrozen(value)&&Object.isFrozen(value.context));assert.equal(calls,1);await rejected(provider.attachmentReferences({context,attachmentId:'x'.repeat(161)}),400);assert.equal(calls,1);
});
test('response limit is exactly4096 bytes and cancels oversized streaming replies',async()=>{
 const raw=JSON.stringify(reply()),exact=raw+' '.repeat(4096-Buffer.byteLength(raw));const good=fixture(async()=>new Response(exact));assert.deepEqual(await good.attachmentReferences({context,attachmentId}),reply());
 let cancelled=false,sent=false;const bad=fixture(async()=>new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode(exact+' '));}},cancel(){cancelled=true;}})));await rejected(bad.attachmentReferences({context,attachmentId}),413);assert(cancelled);
});
test('metadata DTO rejects wrong context, ID, revision, boolean, extra keys and malformed JSON without diagnostics',async()=>{
 for(const mutate of [v=>({...v,context:{...context,workspaceId:'foreign'}}),v=>({...v,context:{...context,sessionHash:'z'}}),v=>({...v,attachmentId:'foreign'}),v=>({...v,revision:9007199254740992}),v=>({...v,revision:-1}),v=>({...v,referenced:1}),v=>({...v,diagnostic:serviceKey}),v=>({attachmentId,revision:1,referenced:false})]){const p=fixture(async()=>Response.json(mutate(reply())));await rejected(p.attachmentReferences({context,attachmentId}),503);}
 for(const raw of ['{"context":', 'not-json'])await rejected(fixture(async()=>new Response(raw)).attachmentReferences({context,attachmentId}),503);
 for(const status of [404,500,503])await rejected(fixture(async()=>Response.json({error:serviceKey},{status})).attachmentReferences({context,attachmentId}),503);
 await rejected(fixture(async()=>{throw Error(serviceKey);}).attachmentReferences({context,attachmentId}),503);
});
test('existing snapshot transport keeps its16MiB default rather than the scalar limit',async()=>{
 const page={workspaceId:context.workspaceId,memberId:context.memberId,revision:17,accessRevision:1,principal:{id:'owner',role:'owner',active:true},entities:[],meta:[{key:'large',present:true,value:'x'.repeat(8192)}],nextCursor:null};
 const p=fixture(async(url)=>{assert(url.endsWith('/fountain_cloud_store_snapshot'));return Response.json(page);});assert.deepEqual(await p.snapshot({context,selection:normalizeSelection({})}),page);
});
test('probe rejects whitespace-only, NUL and unpaired surrogate IDs before transport while preserving valid emoji',async()=>{
 let calls=0;const p=fixture(async()=>{calls++;return Response.json(reply());});for(const id of [' ','\t\n','bad\0id','bad\ud800id','\udfff'])await rejected(p.attachmentReferences({context,attachmentId:id}),400);assert.equal(calls,0);assert.deepEqual(await p.attachmentReferences({context,attachmentId}),reply());assert.equal(calls,1);
});
test('probe blank-ID semantics match Python whitespace while FEFF remains a valid opaque ID',async()=>{
 let calls=0;const p=fixture(async(_url,init)=>{calls++;return Response.json({...reply(),attachmentId:JSON.parse(init.body).p_attachment_id});});for(const id of ['\u0085','\u001c','\u001d\u001e\u001f','\u00a0\u1680','\u2000\u200a','\u2028\u2029\u202f\u205f\u3000','\t\r\n \u0085'])await rejected(p.attachmentReferences({context,attachmentId:id}),400);assert.equal(calls,0);assert.equal((await p.attachmentReferences({context,attachmentId:'\ufeff'})).attachmentId,'\ufeff');assert.equal(calls,1);
});
