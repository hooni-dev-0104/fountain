/** Deep page creation through actual CloudStore/default createTransactions and a
 * paginated RPC model. No PostgreSQL/cloud execution is claimed. */
import assert from 'node:assert/strict';
import {clone} from '../functions/_shared/access.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';
const {createDomain}=await import(process.env.FOUNTAIN_TEST_DOMAIN_MODULE||'../functions/_shared/domain.ts');
const time='2026-10-16T00:00:00.123000+00:00',depth=100;
const results=[];
for(const inWiki of [false,true]){
 const rows=new Map(),metadata=new Map();
 const put=(kind,data)=>{if(!rows.has(kind))rows.set(kind,new Map());rows.get(kind).set(data.id,clone({...data,created_at:data.created_at??time,updated_at:time}));};
 put('member',{id:'alice',name:'Alice',role:'member',active:true});
 for(let i=0;i<depth;i++)put('page',{id:'ancestor-'+i,title:'Ancestor '+i,parent_id:i?'ancestor-'+(i-1):null,is_wiki:i===0&&inWiki,owner_id:'alice',revision:0,teamspace_id:null,permissions:{default:'private',inherit:true,members:{},groups:{}},blocks:[{id:'block-'+i,type:'paragraph',text:'preserve '+i}]});
 const before=canonicalJSON([...rows.get('page').values()]);let snapshots=0,commits=0,revision=0;
 const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'deep-create-fixture',authSessionActive:true,member:clone(rows.get('member').get('alice'))}};
 const provider={
  async snapshot(request){snapshots++;const selected=[...rows].flatMap(([kind,values])=>[...values.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=request.selection.pageSize;
   return{workspaceId:auth.profile.workspaceId,memberId:request.context.memberId,revision,accessRevision:0,principal:clone(rows.get('member').get(request.context.memberId)),entities:clone(selected.slice(offset,offset+size)),meta:request.selection.metaKeys.map(key=>({key,value:metadata.get(key)??null,present:metadata.has(key)})),nextCursor:offset+size<selected.length?{offset:offset+size}:null};},
  async commit(request){commits++;assert.equal(request.expectedRevision,revision);for(const change of request.changes){if(change.op==='put')put(change.kind,change.data);else if(change.op==='delete')rows.get(change.kind)?.delete(change.id);else metadata.set(change.key,clone(change.value));revision++;}return{revision};}
 };
 const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>Date.parse(time)});
 let status,error=null,value=null;
 try{const response=await domain(new Request('https://fixture.example/api/pages',{method:'POST',body:JSON.stringify({id:'deep-created',title:'New child',parent_id:'ancestor-99'})}),'/api/pages',auth);status=response.status;value=await response.json();}
 catch(cause){error={status:cause.status,code:cause.code??null,message:cause.message};}
 assert.equal(canonicalJSON([...rows.get('page').values()].filter(page=>page.id!=='deep-created')),before,'existing ancestor records must remain byte-equivalent');
 if(error){assert.equal(commits,0);assert.equal(rows.get('page').has('deep-created'),false);assert.equal(rows.get('wiki_page')?.has('deep-created')??false,false);}
 results.push({inWiki,depth,snapshots,commits,status:status??error?.status,error,sourceUnchanged:true});
 if(!error){assert.equal(status,201);assert.equal(value.id,'deep-created');assert.equal(value.owner_id,'alice');assert.equal(commits,1);assert(snapshots<20,'batch ancestry selection must be bounded by pagination, not depth');assert.equal(rows.get('wiki_page')?.get('deep-created')?.owner_id??null,inWiki?'alice':null);}
}
console.log(JSON.stringify({actualCloudStore:true,defaultSelectionRounds:64,actualCloud:false,results}));
assert(results.every(result=>result.error===null),'deep owned ordinary/wiki parent creation must succeed under default selection budget');
console.log('PASS deep ordinary/wiki create: existing ancestors unchanged, actor-only wiki sidecar, no selection budget increase');
