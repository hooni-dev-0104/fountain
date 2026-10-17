/** Import-capacity regression through actual CloudStore/default transactions.
 * In-memory atomic RPC contract model; no actual SQL/cloud/Auth execution. */
import assert from 'node:assert/strict';
import {clone} from '../functions/_shared/access.ts';
const {createDomain}=await import(process.env.FOUNTAIN_TEST_DOMAIN_MODULE||'../functions/_shared/domain.ts');
const time='2026-10-16T00:00:00.123000+00:00',records=new Map(),principal={id:'local',name:'Owner',role:'owner',active:true};
let snapshots=0,commits=0,revision=0,changeCount=0,maxResponseBytes=0;
const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'wiki-import-fixture',authSessionActive:true,member:principal}};
const provider={
 async snapshot(request){snapshots++;const all=[...records.values()].filter(record=>request.selection.kinds.includes(record.kind)||request.selection.ids[record.kind]?.includes(record.id)),offset=request.cursor?.offset??0,size=request.selection.pageSize;
  const result={workspaceId:auth.profile.workspaceId,memberId:'local',revision,accessRevision:0,principal:clone(principal),entities:clone(all.slice(offset,offset+size)),meta:request.selection.metaKeys.map(key=>({key,value:null,present:false})),nextCursor:offset+size<all.length?{offset:offset+size}:null};maxResponseBytes=Math.max(maxResponseBytes,Buffer.byteLength(JSON.stringify(result)));return result;},
 async commit(request){commits++;assert.equal(request.expectedRevision,revision);assert(request.changes.length<=1000);changeCount=request.changes.length;for(const change of request.changes){assert.equal(change.op,'put');records.set(change.kind+':'+change.id,{kind:change.kind,id:change.id,data:clone(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});revision++;}return{revision};}
};
const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>Date.parse(time)}),pages=Array.from({length:400},(_,i)=>({id:'import-'+i,title:'Imported '+i,blocks:[]}));
let error=null,status=null,body=null;
try{const response=await domain(new Request('https://fixture.example/api/import',{method:'POST',body:JSON.stringify({format:'json',content:JSON.stringify({pages})})}),'/api/import',auth);status=response.status;body=await response.json();}catch(cause){error={status:cause.status,code:cause.code??null,message:cause.message};}
const pageRecords=[...records.values()].filter(record=>record.kind==='page'),sidecars=[...records.values()].filter(record=>record.kind==='wiki_page');
console.log(JSON.stringify({actualCloudStore:true,defaultSelectionRounds:64,defaultMaxChanges:1000,actualCloud:false,importPages:400,snapshots,commits,changeCount,status,error,maxResponseBytes,storedPages:pageRecords.length,sidecars:sidecars.length,sourceUnchangedOnFailure:error?records.size===0:null}));
assert.equal(error,null,'400-page import must keep existing atomic write capacity');assert.equal(status,201);assert.equal(body.pages.length,400);assert.equal(pageRecords.length,400);assert.equal(sidecars.length,0);assert.equal(changeCount,800);assert.equal(commits,1);assert.equal(snapshots,1);for(const record of pageRecords){assert.equal(record.data.owner_id,'local');assert.equal(record.data.revision,0);assert.deepEqual(record.data.blocks,[]);}
console.log('PASS 400-page JSON import: 800 atomic domain writes, no extra creator sidecars or read/byte/selection budget changes');
