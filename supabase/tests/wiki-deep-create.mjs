/** Deep page creation through actual CloudStore/default createTransactions and a
 * paginated RPC model. No PostgreSQL/cloud execution is claimed. */
import assert from 'node:assert/strict';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
import {createHash} from 'node:crypto';
import {Access,clone} from '../functions/_shared/access.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {Wiki} from '../functions/_shared/wiki.ts';
import {Workspace} from '../functions/_shared/core.ts';
const {createDomain}=await import(process.env.FOUNTAIN_TEST_DOMAIN_MODULE||'../functions/_shared/domain.ts');
const time='2026-10-16T00:00:00.123000+00:00';
const results=[];
for(const {inWiki,depth,wide,explicitId,trustedMismatch=false} of [{inWiki:false,depth:100,wide:false},{inWiki:true,depth:100,wide:false},{inWiki:false,depth:1,wide:true},{inWiki:true,depth:1,wide:true},{inWiki:true,depth:1,wide:false,trustedMismatch:true}].flatMap(spec=>[true,false].map(explicitId=>({...spec,explicitId})))){
 const rows=new Map(),metadata=new Map();let createdId=null;
 const put=(kind,data)=>{if(!rows.has(kind))rows.set(kind,new Map());rows.get(kind).set(data.id,clone({...data,created_at:data.created_at??time,updated_at:time}));};
 put('member',{id:'alice',name:'Alice',role:'member',active:true});
 if(trustedMismatch)put('member',{id:'bob',name:'Bob',role:'member',active:true});
 for(let i=0;i<depth;i++)put('page',{id:'ancestor-'+i,title:'Ancestor '+i,parent_id:i?'ancestor-'+(i-1):null,is_wiki:i===0&&inWiki,owner_id:'alice',revision:0,teamspace_id:null,permissions:{default:'private',inherit:true,members:{},groups:{}},blocks:[{id:'block-'+i,type:'paragraph',text:'preserve '+i}]});
 if(wide)for(let i=0;i<60;i++)put('page',{id:'unrelated-'+i,title:'Unrelated '+i,parent_id:null,owner_id:'someone-else',revision:0,permissions:{default:'private',inherit:false,members:{},groups:{}},blocks:Array.from({length:500},(_,j)=>({id:'b'+j,type:'paragraph',text:'x'.repeat(2500)}))});
 // Hash each byte-safe record separately: the whole fixture intentionally
 // exceeds MAX_LOADED and must not itself use a 16 MiB canonicalJSON call.
 const sourceHash=()=>{const hash=createHash('sha256');for(const page of rows.get('page').values())if(page.id!==createdId)hash.update(canonicalJSON(page));return hash.digest('hex');};
 const before=sourceHash();let snapshots=0,commits=0,revision=0,maxSnapshotBytes=0,unrelatedSelected=false,pageKindSelected=false;
 const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'deep-create-fixture',authSessionActive:true,member:clone(rows.get('member').get('alice'))}};
 const provider={
  async snapshot(request){snapshots++;pageKindSelected ||= request.selection.kinds.includes('page');const selected=[...rows].flatMap(([kind,values])=>[...values.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=Math.min(request.selection.pageSize,wide?4:request.selection.pageSize);
   const entities=clone(selected.slice(offset,offset+size));unrelatedSelected ||= entities.some(record=>record.id.startsWith('unrelated-'));
   const result={workspaceId:auth.profile.workspaceId,memberId:request.context.memberId,revision,accessRevision:0,principal:clone(rows.get('member').get(request.context.memberId)),entities,meta:request.selection.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,value:[...(rows.get('page')?.values()??[])].map(projectPageHeader).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),present:true}:{key,value:metadata.get(key)??null,present:metadata.has(key)}),nextCursor:offset+size<selected.length?{offset:offset+size}:null};
   const bytes=Buffer.byteLength(JSON.stringify(result));maxSnapshotBytes=Math.max(maxSnapshotBytes,bytes);assert(bytes<16*1024*1024,'every RPC response respects its existing byte cap');return result;},
  async commit(request){commits++;assert.equal(request.expectedRevision,revision);for(const change of request.changes){if(change.op==='put')put(change.kind,change.data);else if(change.op==='delete')rows.get(change.kind)?.delete(change.id);else metadata.set(change.key,clone(change.value));revision++;}return{revision};}
 };
 const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>Date.parse(time)});
 let status,error=null,value=null;
 try{
  const input={...(explicitId?{id:'deep-created'}:{}),title:'New child',parent_id:'ancestor-'+(depth-1)};
  if(trustedMismatch){const execute=createTransactions({provider,authorize:async()=>clone(auth),clock:()=>Date.parse(time)}),result=await execute(auth,s=>new Workspace(s,{actor:'alice',access:new Access(s,s.principal)}).create_page({...input,owner_id:'bob'}));status=201;value=result.value;}
  else{const response=await domain(new Request('https://fixture.example/api/pages',{method:'POST',body:JSON.stringify(input)}),'/api/pages',auth);status=response.status;value=await response.json();}
  createdId=value.id;
 }
 catch(cause){error={status:cause.status,code:cause.code??null,message:cause.message};}
 assert.equal(sourceHash(),before,'existing ancestor and unrelated records must remain byte-equivalent');
 if(error){assert.equal(commits,0);assert.equal(rows.get('page').size,depth+(wide?60:0));assert.equal(rows.get('wiki_page')?.size??0,0);}
 results.push({inWiki,depth,wide,explicitId,trustedMismatch,unrelatedPages:wide?60:0,snapshots,commits,entityWrites:revision,maxSnapshotBytes,pageKindSelected,unrelatedSelected,status:status??error?.status,error,sourceUnchanged:true,storedOwner:rows.get('wiki_page')?.get(createdId)?.owner_id??null});
 if(!error){assert.equal(status,201);assert.equal(typeof value.id,'string');if(explicitId)assert.equal(value.id,'deep-created');else assert.match(value.id,/^[a-f0-9]{32}$/);assert.equal(value.owner_id,trustedMismatch?'bob':'alice');assert.equal(commits,1);assert(snapshots<20,'bounded creation reads');}
 if(!error&&!wide){
  const execute=createTransactions({provider,authorize:async()=>clone(auth),clock:()=>Date.parse(time)}),beforeRead=revision;
  const view=await execute(auth,s=>new Wiki(s,new Access(s,s.principal)).ownerView(createdId));
  assert.equal(revision,beforeRead,'knowledge-owner GET must not write domain data');assert.equal(view.value.in_wiki,inWiki);
  if(inWiki){assert.equal(view.value.owner.id,'alice');assert.equal(view.value.can_verify,true);}
  if(!inWiki){
   assert.equal(view.value.owner,null);assert.deepEqual(view.value.members,[]);assert.equal(view.value.can_manage,false);
   await execute(auth,s=>new Wiki(s,new Access(s,s.principal)).convert('POST','ancestor-0',{revision:0}));
   const adopted=await execute(auth,s=>new Wiki(s,new Access(s,s.principal)).ownerView(createdId));
   assert.equal(adopted.value.in_wiki,true);assert.equal(adopted.value.owner.id,'alice');assert.equal(adopted.value.can_verify,true);
   results.at(-1).ordinaryPrivateUntilAdoption=true;
  }
 }
}
console.log(JSON.stringify({actualCloudStore:true,defaultSelectionRounds:64,actualCloud:false,results}));
assert(results.every(result=>result.error===null),'deep and wide owned ordinary/wiki creation must succeed under unchanged selection and byte budgets');
for(const result of results){assert(result.snapshots<10,'creator stamp needs no ancestor lookups');assert.equal(result.entityWrites,result.trustedMismatch?3:2,'normal API keeps existing page+audit write cost; only trusted owner mismatch needs a private creator record');assert.equal(result.storedOwner,result.trustedMismatch?'alice':null);assert.equal(result.pageKindSelected,false);assert.equal(result.unrelatedSelected,false);}
console.log('PASS deep/wide ordinary/wiki create: normal API retains two writes; trusted owner mismatch privately preserves creator; no ancestor/unrelated body reads or budget increase');
