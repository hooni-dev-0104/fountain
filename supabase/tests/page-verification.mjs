/** Production synchronous verification/Access/Authorization on a staged memory Store.
 * No provider, SQL, HTTP or actual cloud execution is claimed by this test. */
import assert from 'node:assert/strict';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
import {Advanced,createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
import {Workspace} from '../functions/_shared/core.ts';
import {createDomain} from '../functions/_shared/domain.ts';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const time='2026-10-16T00:00:00.123000+00:00',path='/api/pages/verification-page/verify';
class Store{
  requestTime=time;context={memberId:'editor'};records=new Map();metadata=new Map();sequence=0;
  get(kind,id){return clone(this.records.get(kind)?.get(id)??null);}
  list(kind){return [...(this.records.get(kind)?.values()??[])].map(clone);}
  meta(key,fallback=null){return clone(this.metadata.get(key)??fallback);}
  set_meta(key,value){this.metadata.set(key,clone(value));}
  allocate_id(){return 'fixture-'+(++this.sequence);}
  put(kind,value){const next={...clone(value),id:value.id||this.allocate_id(),created_at:value.created_at??time,updated_at:time};if(!this.records.has(kind))this.records.set(kind,new Map());this.records.get(kind).set(next.id,next);return clone(next);}
  delete(kind,id){this.records.get(kind)?.delete(id);}
  audit(action,details,user='editor'){return this.put('audit',{action,details,user});}
  transaction(action){const old=clone([this.records,this.metadata,this.sequence]);try{return action();}catch(error){[this.records,this.metadata,this.sequence]=old;throw error;}}
}
function fixture(actor='editor'){
  const store=new Store();store.context.memberId=actor;
  for(const [id,role]of [['local','owner'],['editor','member'],['reader','member'],['viewer','member'],['commenter','member'],['guest','guest'],['no-read','member'],['inactive','member']])store.put('member',{id,name:id,email:id+'@example.invalid',role,active:id!=='inactive',private:'never-return'});
  store.put('page',{id:'verification-page',title:'원문',revision:7,owner_id:'local',blocks:[{id:'b',type:'paragraph',text:'그대로'}],permissions:{default:'private',inherit:false,groups:{},members:{editor:'edit',reader:'view',viewer:'view',commenter:'comment',guest:'edit'}}});
  const access=new Access(store,store.get('member',actor)),authority=new Authorization(access),workspace=new Workspace(store,{actor,access}),advanced=new Advanced(store,workspace,{actor,access,clock:()=>Date.parse(time)});
  const call=(method,body={})=>store.transaction(()=>{body=clone(body);authority.prepare(method,path,body);const value=advanced.dispatch(method,path,body,{});return authority.project(path,value.payload);});
  return{store,access,authority,advanced,call};
}
let checks=0;
function denied(f,status,method='POST',body={}){const before=clone(f.store.records);assert.throws(()=>f.call(method,body),error=>error instanceof APIError&&error.status===status);assert.deepEqual(f.store.records,before);checks++;}
{
  const f=fixture(),before=f.store.get('page','verification-page'),page=f.call('POST',{owners:['editor','reader','editor'],revision:7});assert.deepEqual(page.verification.owners,['editor','reader']);assert.equal(page.verification.owner,'editor');assert.equal(page.verification.verified_by,'editor');assert.equal(page.revision,8);
  const removed=f.call('DELETE',{revision:8});assert.equal(removed.revision,9);assert.equal(removed.verification,undefined);for(const field of ['owner_id','blocks','permissions'])assert.deepEqual(removed[field],before[field]);checks++;
}
{
  const f=fixture();assert.deepEqual(f.call('POST').verification.owners,['editor']);assert.deepEqual(f.call('POST',{owner:'reader'}).verification.owners,['reader']);assert.deepEqual(f.call('POST',{owners:Array(1001).fill('reader')}).verification.owners,['reader']);checks++;
}
for(const actor of ['viewer','commenter'])for(const method of ['POST','DELETE'])denied(fixture(actor),403,method);
for(const id of ['inactive','no-read','missing'])denied(fixture(),404,'POST',{owners:[id]});
denied(fixture('guest'),404,'POST',{owners:['reader']});assert.deepEqual(fixture('guest').call('POST',{owners:['guest']}).verification.owners,['guest']);
{
  const f=fixture();let reads=0;const get=f.store.get.bind(f.store);f.store.get=(kind,id)=>{if(kind==='member')reads++;return get(kind,id);};
  for(const body of [{owners:[]},{owners:'reader'},{owners:['reader',3]},{owner:''},{owners:['x'.repeat(161)]},{owners:['reader'],owner:'reader'},{owner_id:'reader'},{owners:['\0']},{owners:Array.from({length:1001},(_,i)=>String(i))}]){reads=0;denied(f,400,'POST',body);assert.equal(reads,0,'malformed lists must fail before any member lookup');}
  denied(f,400,'DELETE',{owner:'editor'});
}
{
  const f=fixture();for(const expires_at of [false,0,[],{},'','2099-02-30T00:00:00Z','2099-01-01','2099-01-01T00:00:00','2099-01-01 00:00:00Z','2099-01-01T00:00:00+24:00','2020-01-01T00:00:00Z'])denied(f,400,'POST',{expires_at});
  assert.equal(f.call('POST',{expires_at:null}).verification.expires_at,null);const expires_at='2099-01-01T09:00:00.123456+09:00';assert.equal(f.call('POST',{expires_at}).verification.expires_at,expires_at);checks++;
}
{
  const f=fixture();for(const method of ['POST','DELETE']){denied(f,409,method,{revision:6});for(const revision of [true,-1,'7',7.5,9007199254740992])denied(f,400,method,{revision});}
  const page=f.store.get('page','verification-page');page.revision=Number.MAX_SAFE_INTEGER;f.store.put('page',page);denied(f,409);
}
{
  const owner=fixture('local');owner.call('POST',{owners:['local','reader']});const guest=new Access(owner.store,owner.store.get('member','guest')),guard=new Authorization(guest),page=owner.store.get('page','verification-page');
  const projected=guard.project('/api/pages/verification-page',{page}).page;assert.deepEqual(projected.verification.owners,[]);assert.equal(projected.verification.owner,null);assert.equal(projected.verification.verified_by,null);assert.equal(JSON.stringify(projected.verification).includes('reader'),false);
  const advanced=new Advanced(owner.store,new Workspace(owner.store,{actor:'guest',access:guest}),{actor:'guest',access:guest});const next=advanced.dispatch('POST',path,{owners:['guest']},{}).payload;assert.deepEqual(guard.project(path,next).verification.owners,['guest']);assert.deepEqual(owner.store.get('page','verification-page').verification.owners,['guest','local','reader']);
  advanced.dispatch('DELETE',path,{},{});assert.equal(owner.store.get('page','verification-page').verification,undefined);checks++;
}
{
  const f=fixture(),page=f.store.get('page','verification-page');page.verification={owners:['reader','inactive','no-read'],owner:{private:'never-return'},verified_by:{private:'never-return'},verified_at:{private:'never-return'},expires_at:false,unknown:'never-return'};f.store.put('page',page);
  const dto=f.authority.project('/api/workspace',{pages:[page],members:[]}).pages[0].verification;assert.deepEqual(dto,{owners:[],owner:null,verified_by:null,verified_at:null,expires_at:null});assert.deepEqual(f.store.get('page','verification-page').verification,page.verification);checks++;
}
// Exercise stored-source validity through real Authorization, including workspace's
// filtering pass: a valid hidden DTO must not be mistaken for an empty raw source.
{
  const f=fixture('guest'),neutral={owners:[],owner:null,verified_by:null,verified_at:null,expires_at:null},valid={owners:['local'],owner:'local',verified_by:'local',verified_at:'2026-10-17T00:00:00Z',expires_at:null};
  const malformed=[...[false,0,[],{},'','x'.repeat(101),'2099-02-30T00:00:00Z','2099-01-01T00:00:00','2099-01-01T00:00:00+24:00'].map(expires_at=>({expires_at})),...[null,false,'',{},'x'.repeat(101),'2026-02-30T00:00:00Z'].map(verified_at=>({verified_at})),...['local',[],['local',123],[null],['inactive'],['no-read'],['missing']].map(owners=>({owners}))];
  const sources=[...malformed.map(value=>({...valid,...value})),null,false,[],{}],neutralCount=sources.length;sources.push(valid,{...valid,expires_at:'2020-01-01T09:00:00.123456+09:00'});const legacy={...valid};delete legacy.owners;sources.push(legacy);
  const actual=[];
  for(const [index,source]of sources.entries()){
    const page={...f.store.get('page','verification-page'),verification:source},before=clone(page);
    for(const route of ['/api/pages/verification-page','/api/workspace']){
      const payload=route==='/api/workspace'?{pages:[page]}:{page},result=f.authority.project(route,payload),dto=(result.pages?.[0]??result.page).verification;
      assert.deepEqual(dto,index<neutralCount?neutral:{...neutral,verified_at:valid.verified_at,expires_at:source.expires_at});actual.push(dto);checks++;
    }
    assert.deepEqual(page,before,'projection must not repair stored source');
  }
  const oracle=spawnSync(process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',['-c',`
import json,sys
from fountain.core import Store
from fountain.access import Access
from fountain.authorization import Authorization
x=json.load(sys.stdin);s=Store(':memory:')
for kind,rows in x['records'].items():
 for row in rows:s.put(kind,row)
a=Authorization(Access(s,s.get('member','guest')));out=[]
for source in x['sources']:
 page={**s.get('page','verification-page'),'verification':source}
 for route in ['/api/pages/verification-page','/api/workspace']:
  v=a.project(route,{'pages':[page]} if route=='/api/workspace' else {'page':page})
  out.append((v['pages'][0] if 'pages' in v else v['page'])['verification'])
print(json.dumps(out));s.close()
`],{input:JSON.stringify({records:Object.fromEntries([...f.store.records.keys()].map(kind=>[kind,f.store.list(kind)])),sources}),encoding:'utf8'});
  assert.equal(oracle.status,0,oracle.stderr);assert.deepEqual(actual,JSON.parse(oracle.stdout),'raw verification projection Python/SQLite parity');
}
console.log('PASS page verification '+checks+' staged production checks: edit-level remove, owners/legacy, active-visible-readable membership, expiry, CAS/rollback, private projection and hidden-owner preservation; no cloud/SQL proof');
let parityChecks=0;
for(const actor of ['editor','guest']){
  const f=fixture(actor),page=f.store.get('page','verification-page');page.verification={owners:['local','reader'],owner:'local',verified_by:'local',verified_at:time,expires_at:null};f.store.put('page',page);
  const operations=[{}, {owners:['editor','reader','editor']},{owners:['guest']},{owner:'reader'}, {owners:[]},{owners:['missing']},{owners:['inactive']},{owners:['no-read']},{expires_at:false},{expires_at:0},{expires_at:[]},{expires_at:{}},{expires_at:''},{expires_at:'2099-01-01T09:00:00.123456+09:00'},{expires_at:'2099-01-01T00:00:00+24:00'},{expires_at:'2099-02-30T00:00:00Z'},{revision:true},{revision:7.5},{revision:0}].map(body=>({method:'dispatch',args:['POST',path,body,{}]}));operations.push({method:'dispatch',args:['DELETE',path,{},{}]});
  const spec={actor,access:true,clockISO:time,records:Object.fromEntries([...f.store.records.keys()].map(kind=>[kind,f.store.list(kind)])),operations};
  const actual=operations.map(op=>{try{return{ok:f.store.transaction(()=>f.advanced.dispatch(...op.args))};}catch(error){if(!(error instanceof APIError))throw error;return{error:{status:error.status,message:error.message}};}});
  const oracle=spawnSync(process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',[fileURLToPath(new URL('./advanced-oracle.py',import.meta.url))],{input:JSON.stringify(spec),encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(oracle.status,0,oracle.stderr);assert.deepEqual(actual,JSON.parse(oracle.stdout).results,'Python/TypeScript verification contract '+actor);parityChecks+=operations.length;
}
console.log('PASS '+parityChecks+' Python/SQLite versus TypeScript staged verification results, including hidden-owner preservation and strict timestamp/CAS errors');

// Actual CloudStore + default createTransactions selection/CAS stack with a
// paginated atomic provider model. This is not an actual PostgreSQL claim.
for(const count of [100,1000]){
  const f=fixture('local'),ids=Array.from({length:count},(_,i)=>'assignee-'+i);
  for(const id of ids)f.store.put('member',{id,name:id,role:'member',active:true});
  const page=f.store.get('page','verification-page');page.permissions={default:'workspace',inherit:false,members:{guest:'edit'},groups:{}};f.store.put('page',page);
  let snapshots=0,commits=0,revision=0,memberKindRequests=0;
  const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'verification-fixture',authSessionActive:true,member:f.store.get('member','local')}};
  const provider={async snapshot(request){snapshots++;assert.equal(request.context.workspaceId,auth.profile.workspaceId);if(request.selection.kinds.includes('member'))memberKindRequests++;
    const all=[...f.store.records].flatMap(([kind,rows])=>[...rows.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=request.selection.pageSize;
    return{workspaceId:auth.profile.workspaceId,memberId:request.context.memberId,revision,accessRevision:0,principal:f.store.get('member',request.context.memberId),entities:clone(all.slice(offset,offset+size)),meta:request.selection.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,value:f.store.list('page').map(projectPageHeader).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),present:true}:{key,value:f.store.meta(key),present:f.store.metadata.has(key)}),nextCursor:offset+size<all.length?{offset:offset+size}:null};},
    async commit(request){commits++;assert.equal(request.expectedRevision,revision);for(const change of request.changes){if(change.op==='put')f.store.put(change.kind,change.data);else if(change.op==='delete')f.store.delete(change.kind,change.id);else f.store.set_meta(change.key,change.value);revision++;}return{revision};}};
  const domain=createDomain({provider,extensions:[createAdvancedExtension({cloud:true})],authorize:async()=>clone(auth),clock:()=>Date.parse(time)});
  await assert.rejects(()=>domain(new Request('https://fixture.example'+path,{method:'POST',body:JSON.stringify({owners:[ids[0],3]})}),path,auth),error=>error.status===400);assert.equal(memberKindRequests,0,'invalid shape must not request private member kind');assert.equal(commits,0);snapshots=0;
  const response=await domain(new Request('https://fixture.example'+path,{method:'POST',body:JSON.stringify({owners:ids,revision:7})}),path,auth),body=await response.json();
  assert.equal(response.status,200);assert.deepEqual(body.verification.owners,ids);assert.equal(body.revision,8);assert.equal(commits,1);assert(memberKindRequests>0);assert(snapshots<20,'bounded kind selection, not one round per assignee');
  if(count===100){
    auth.profile.member=f.store.get('member','guest');snapshots=0;
    const next=await domain(new Request('https://fixture.example'+path,{method:'POST',body:JSON.stringify({owners:['guest'],revision:8})}),path,auth),visible=await next.json();
    assert.equal(next.status,200);assert.deepEqual(visible.verification.owners,['guest']);assert.equal(visible.verification.verified_at,time);assert.deepEqual(f.store.get('page','verification-page').verification.owners,['guest',...ids]);assert.equal(commits,2);assert(snapshots<20);
  }
  console.log('PASS actual CloudStore/default transaction '+count+' distinct owners: '+snapshots+' paginated model snapshot calls, '+commits+' commit; no real cloud');
}
