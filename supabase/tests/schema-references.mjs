/** Defensive schema-transition regression: a type change must not grant a
 * reference that the caller could not read under the original schema. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createBackend} from '../functions/_shared/backend.ts';
import {createDomain} from '../functions/_shared/domain.ts';
const copy=structuredClone,stamp='2026-10-16T00:00:00.000000+00:00';
function fixture(type,value,{hidden=false,shared=false,target='bob-db'}={}){
 const records=new Map(),key=(kind,id)=>JSON.stringify([kind,id]);let revision=0,commits=0;
 const seed=(kind,data)=>records.set(key(kind,data.id),{kind,id:data.id,data:{...copy(data),created_at:stamp,updated_at:stamp},createdAt:stamp,updatedAt:stamp});
 seed('teamspace',{id:'general',visibility:'open'});seed('settings',{id:'workspace'});
 const schema=[{id:'payload',name:'Payload',type,...(type==='relation'?{database_id:target}:{})},{id:'who',name:'Who',type:'text'}];
 seed('database',{id:'bob-db',name:'Bob',owner_id:'bob',properties:schema,permissions:{default:'private'},row_permissions:hidden?{mode:'assigned',property_id:'who'}:{}});
 seed('database',{id:'alice-db',name:'Alice',owner_id:'alice',properties:[{id:'title',name:'Title',type:'title'}],permissions:{default:'private'}});
 seed('row',{id:'bob-row',database_id:'bob-db',owner_id:'bob',properties:{payload:value,who:hidden?'alice':'bob'}});
 seed('row',{id:'alice-row',database_id:'alice-db',owner_id:'alice',properties:{title:'Private'}});
 seed('attachment',{id:'alice-file',owner_id:'alice',size:1});seed('attachment',{id:'bob-file',owner_id:'bob',size:1});
 if(shared)seed('page',{id:'shared',owner_id:'alice',blocks:[{attachment_id:'alice-file'}],permissions:{default:'private',members:{bob:'view'}}});
 const context={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'b'.repeat(32),expiresAt:Date.now()+60000,profile:{workspaceId:'qa',authSessionActive:true,member:{id:'bob',name:'Bob',email:'bob@example.invalid',role:'member',active:true}}};
 const provider={async snapshot(r){const s=r.selection;return {workspaceId:'qa',memberId:'bob',revision,accessRevision:0,principal:copy(context.profile.member),entities:[...records.values()].filter(v=>s.kinds.includes(v.kind)||s.ids[v.kind]?.includes(v.id)).map(v=>copy(v)),meta:s.metaKeys.map(key=>({key,value:null,present:false})),nextCursor:null};},async commit(r){commits++;assert.equal(r.expectedRevision,revision);for(const c of r.changes){if(c.op==='put')seed(c.kind,c.data);revision++;}return {revision};}};
 const authorize=async()=>copy(context),app=createBackend({origins:[],auth:async()=>({authorize,session:async()=>({status:200,body:{authenticated:true}})}),domain:createDomain({provider,authorize})});
 return {records,get commits(){return commits;},async patch(nextType,extra={}){return app(new Request('https://fixture.invalid/api/databases/bob-db',{method:'PATCH',headers:{'X-Fountain-Request':'1'},body:JSON.stringify({properties:[{id:'payload',name:'Updated',type:nextType,...extra},schema[1]]})}));}};
}
test('promoting text or multi-select to files rejects inaccessible existing references atomically',async()=>{
 for(const [type,value]of [['text','alice-file'],['multi_select',['alice-file']]]){
  const f=fixture(type,value),response=await f.patch('files');assert([400,403,404].includes(response.status));assert.equal(f.commits,0);assert.equal(f.records.get('["database","bob-db"]').data.properties[0].type,type);
 }
});
test('a previously removed field is also validated before becoming a file reference',async()=>{
 const f=fixture('multi_select',['alice-file']);f.records.get('["database","bob-db"]').data.properties=f.records.get('["database","bob-db"]').data.properties.slice(1);
 assert.equal((await f.patch('files')).status,404);assert.equal(f.commits,0);
});
test('empty, owned and already shared references allow legitimate type changes',async()=>{
 for(const [value,options]of [[[],{}],[null,{}],[['bob-file'],{}],[['alice-file'],{shared:true}]]){const f=fixture('multi_select',value,options);assert.equal((await f.patch('files')).status,200);assert.equal(f.commits,1);}
});
test('unchanged reference types preserve existing hidden row values during a rename',async()=>{
 const f=fixture('files',['alice-file'],{hidden:true});assert.equal((await f.patch('files')).status,200);assert.deepEqual(f.records.get('["row","bob-row"]').data.properties.payload,['alice-file']);
});
test('relation promotion checks current target visibility and target-database consistency',async()=>{
 const hidden=fixture('multi_select',['alice-row']);assert.equal((await hidden.patch('relation',{database_id:'alice-db'})).status,404);assert.equal(hidden.commits,0);
 const changed=fixture('relation',['bob-row']);assert.equal((await changed.patch('relation',{database_id:'alice-db'})).status,400);assert.equal(changed.commits,0);
 const own=fixture('multi_select',['bob-row']);assert.equal((await own.patch('relation',{database_id:'bob-db'})).status,200);
});
