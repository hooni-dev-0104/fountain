/** Generic page/selected-workspace verification projection and inherited ACL on
 * actual CloudStore/default transactions. SQL virtual metadata is emulated by
 * a byte-safe paginated atomic RPC model, not actual PostgreSQL/cloud/Auth. */
import assert from 'node:assert/strict';
import {Access,clone} from '../functions/_shared/access.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
const {createDomain}=await import(process.env.FOUNTAIN_TEST_DOMAIN_MODULE||'../functions/_shared/domain.ts');
const {createAdvancedExtension}=await import(process.env.FOUNTAIN_TEST_ADVANCED_MODULE||'../functions/_shared/advanced.ts');
const time='2026-10-16T00:00:00.123000+00:00',neutral={owners:[],owner:null,verified_by:null,verified_at:null,expires_at:null};
function fixture({actor='local',active=true,bobRole='member'}={}){
 const rows=new Map(),metadata=new Map();let revision=0,trace;
 const seed=(kind,value)=>{if(!rows.has(kind))rows.set(kind,new Map());rows.get(kind).set(value.id,{...value,created_at:time,updated_at:time});};
 for(const [id,role,on]of [['local','owner',true],['bob',bobRole,active],['guest','guest',true],['inactive','member',false]])seed('member',{id,name:id,role,active:on});
 seed('settings',{id:'workspace',name:'Fountain'});
 const parentBody=[{id:'parent-block',type:'paragraph',text:'p'.repeat(500000)}];
 for(let i=0;i<30;i++)seed('page',{id:'parent-'+i,title:'Parent '+i,parent_id:i?'parent-'+(i-1):null,owner_id:'local',revision:0,permissions:{default:'private',inherit:i!==0,members:i?{}:{bob:'edit'},groups:{}},blocks:parentBody});
 seed('page',{id:'leaf',title:'Leaf',parent_id:'parent-29',owner_id:'local',revision:0,permissions:{default:'private',inherit:true,members:{guest:'view'},groups:{}},blocks:[{id:'leaf-block',type:'paragraph',text:'t'.repeat(500000)}],cover:'preserve cover',unknown:{preserve:true},verification:{owners:['bob'],owner:'bob',verified_by:'bob',verified_at:time,expires_at:null,cycle_revision:0}});
 const unrelated=Array.from({length:500},(_,i)=>({id:'u'+i,type:'paragraph',text:'u'.repeat(2500)}));
 for(let i=0;i<60;i++)seed('page',{id:'unrelated-'+i,title:'Unrelated',parent_id:null,owner_id:'someone-else',revision:0,permissions:{default:'private',inherit:false,members:{},groups:{}},blocks:unrelated});
 seed('database',{id:'db',parent_id:'leaf',owner_id:'local',permissions:{default:'private',inherit:true,members:{},groups:{}},properties:[{id:'who',type:'person'}],row_permissions:{mode:'assigned',property_id:'who',edit_assigned:true,allow_create:true}});
 seed('row',{id:'row',database_id:'db',properties:{who:'bob'}});
 const auth=()=>({hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'verification-header-fixture',authSessionActive:true,member:clone(rows.get('member').get(actor))}});
 const provider={async snapshot(request){trace.snapshots++;trace.pageKind ||=request.selection.kinds.includes('page');const all=[...rows].flatMap(([kind,values])=>[...values.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=Math.min(request.selection.pageSize,4),entities=clone(all.slice(offset,offset+size));for(const record of entities)if(record.kind==='page')trace.bodyIds.add(record.id);
  const headers=[...rows.get('page').values()].map(projectPageHeader).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),result={workspaceId:'verification-header-fixture',memberId:actor,revision,accessRevision:0,principal:clone(rows.get('member').get(actor)),entities,meta:request.selection.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,value:headers,present:true}:{key,value:metadata.get(key)??null,present:metadata.has(key)}),nextCursor:offset+size<all.length?{offset:offset+size}:null};trace.maxResponseBytes=Math.max(trace.maxResponseBytes,Buffer.byteLength(JSON.stringify(result)));assert(trace.maxResponseBytes<16*1024*1024);return result;},async commit(request){trace.commits++;trace.changes=clone(request.changes);assert.equal(request.expectedRevision,revision);for(const change of request.changes){if(change.op==='put')seed(change.kind,clone(change.data));else if(change.op==='delete')rows.get(change.kind)?.delete(change.id);else metadata.set(change.key,clone(change.value));revision++;}return{revision};}};
 const begin=label=>(trace={label,snapshots:0,commits:0,pageKind:false,bodyIds:new Set(),maxResponseBytes:0,changes:[]}),stats=()=>({...trace,bodyIds:[...trace.bodyIds]});
 const execute=createTransactions({provider,authorize:async()=>auth(),clock:()=>Date.parse(time)}),domain=createDomain({provider,extensions:[createAdvancedExtension({cloud:true})],authorize:async()=>auth(),clock:()=>Date.parse(time)});
 return{rows,auth,begin,stats,execute,domain};
}
const results=[];
for(const spec of [{actor:'local'},{actor:'bob'},{actor:'guest'},{actor:'local',active:false},{actor:'local',bobRole:'guest'}]){
 const f=fixture(spec),before=JSON.stringify(f.rows.get('page').get('leaf'));f.begin('generic GET '+JSON.stringify(spec));
 const response=await f.domain(new Request('https://fixture.example/api/pages/leaf'),'/api/pages/leaf',f.auth()),value=await response.json(),stats=f.stats();
 assert.equal(response.status,200);assert.equal(value.page.blocks[0].text.length,500000);assert.equal(value.page.cover,'preserve cover');assert.deepEqual(value.page.unknown,{preserve:true});assert.equal(JSON.stringify(f.rows.get('page').get('leaf')),before);
 if(spec.active===false)assert.deepEqual(value.page.verification,neutral);
 else if(spec.actor==='guest')assert.deepEqual(value.page.verification,{...neutral,verified_at:time});
 else{assert.deepEqual(value.page.verification.owners,['bob']);assert.equal(value.page.verification.verified_by,'bob');}
 results.push(stats);const {changes,...record}=stats;console.log(JSON.stringify({genericProjectionCase:{...record,domainWrites:changes.length}}));assert(stats.snapshots<24,'verification/caller inheritance must use bounded headers');assert.deepEqual(stats.bodyIds,['leaf'],'generic GET must not select parent bodies');
}
{
 const f=fixture({actor:'bob'}),before=clone(f.rows.get('page').get('leaf'));f.begin('generic inherited member PATCH preserves full target');
 const response=await f.domain(new Request('https://fixture.example/api/pages/leaf',{method:'PATCH',body:JSON.stringify({title:'Updated title',revision:0})}),'/api/pages/leaf',f.auth()),value=await response.json();assert.equal(response.status,200);assert.equal(value.title,'Updated title');assert.equal(value.revision,1);
 for(const key of ['blocks','cover','unknown','owner_id','permissions','verification'])assert.deepEqual(f.rows.get('page').get('leaf')[key],before[key]);results.push(f.stats());
}
{
 const f=fixture();f.begin('selected workspace DTO projection');
 const result=await f.execute(f.auth(),s=>{const access=new Access(s,s.principal),page=s.get('page','leaf'),authority=new Authorization(access),value=authority.project('/api/workspace',{pages:[page],members:s.list('member')});assert.equal(access.store,s);return value;});
 assert.deepEqual(result.value.pages[0].verification.owners,['bob']);assert.deepEqual(f.stats().changes,[]);results.push(f.stats());
}
{
 const f=fixture();f.begin('staged ACL rollback and current parent / database / row levels');
 await f.execute(f.auth(),s=>{
  const raw=s.get('page','leaf'),access=new Access(s,s.principal),bob=new Access(s,s.get('member','bob')),root=s.get('page','parent-0'),oldRoot=clone(root);let headerBuilds=0;const original=s.page_headers.bind(s);s.page_headers=()=>{headerBuilds++;return original();};
  const projected=()=>access.project_verification(raw);assert.deepEqual(projected().owners,['bob']);assert.deepEqual(projected().owners,['bob']);assert.equal(headerBuilds,1,'same request Access shares one lazy cached header index');assert.equal(access.store,s);
  assert.equal(bob.level('page',raw),3);assert.equal(bob.level('database',s.get('database','db')),3);assert.equal(bob.level('row',s.get('row','row')),3);assert.equal(bob.store,s);
  let deniedRevision;
  assert.throws(()=>s.transaction(()=>{s.put('page',{...root,permissions:{default:'private',inherit:false,members:{bob:'none'},groups:{}}});deniedRevision=s.meta('_entity_revision');assert.deepEqual(projected(),neutral);assert.equal(bob.level('row',s.get('row','row')),0);throw Error('fixture rollback');}),/fixture rollback/);
  assert.deepEqual(projected().owners,['bob']);assert.equal(bob.level('row',s.get('row','row')),3);
  s.put('page',{...root,permissions:{default:'private',inherit:false,members:{bob:'view'},groups:{}}});assert.equal(s.meta('_entity_revision'),deniedRevision);assert.deepEqual(projected().owners,['bob']);assert.equal(bob.level('page',raw),1);assert.equal(bob.level('row',s.get('row','row')),1);
  s.put('page',oldRoot);
  const parent=s.get('page','parent-29'),oldParent=clone(parent);s.put('page',{...parent,parent_id:'unrelated-0'});assert.deepEqual(projected(),neutral);s.put('page',oldParent);assert.deepEqual(projected().owners,['bob']);
 });results.push(f.stats());
}
console.log(JSON.stringify({actualCloudStore:true,defaultSelectionRounds:64,actualCloud:false,selectedWorkspaceProjectionOnly:true,results:results.map(({changes,...stats})=>({...stats,domainWrites:changes.length}))},null,2));
for(const stats of results){assert.equal(stats.pageKind,false);assert(stats.snapshots<24,'bounded metadata lookup must replace per-parent selection rounds');const allowed=stats.label.startsWith('staged ')?new Set(['leaf','parent-0','parent-29']):new Set(['leaf']);assert(stats.bodyIds.every(id=>allowed.has(id)),'only actual target/staged ACL mutation bodies may be selected');}
console.log('PASS '+results.length+' generic verified page/selected-workspace/current ACL checks: caller/assignee ancestors use shared headers, raw store and full body preserved; model RPC only');
