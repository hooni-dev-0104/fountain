/** Production Inbox/Access/CloudStore with a private staged RPC model; not cloud proof. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Inbox} from '../functions/_shared/inbox.ts';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {Workspace} from '../functions/_shared/core.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
import {createDomain} from '../functions/_shared/domain.ts';
import {Advanced,createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {projectPageHeader,PAGE_HEADER_META_KEY} from '../functions/_shared/page-headers.ts';
import {projectVerificationIndex,VERIFICATION_INDEX_META_KEY} from '../functions/_shared/verification-index.ts';
const stamp='2026-10-17T00:00:00.123000+00:00',now=Date.parse(stamp);
class Store{
 sequence=0;records=new Map();metadata=new Map();context={memberId:'alice'};requestTime=stamp;
 get(kind,id){return clone(this.records.get(kind)?.get(id)??null)}
 list(kind){return [...(this.records.get(kind)?.values()??[])].map(clone)}
 meta(key,fallback=null){return clone(this.metadata.get(key)??fallback)}
 set_meta(key,value){this.metadata.set(key,clone(value))}
 audit(action,details,user){return this.put('audit',{id:'audit'+(++this.sequence),action,details,user})}
 put(kind,value){if(!this.records.has(kind))this.records.set(kind,new Map());const record={created_at:stamp,updated_at:stamp,...clone(value)};this.records.get(kind).set(record.id,record);return clone(record)}
}
function fixture(actor='alice'){
 const store=new Store();for(const [id,role]of [['local','owner'],['alice','member'],['bob','member'],['guest','guest'],['inactive','member']])store.put('member',{id,role,active:id!=='inactive'});
 store.put('settings',{id:'workspace'});
 const page=store.put('page',{id:'page😀',title:'검증 문서',icon:'📘',revision:4,owner_id:'local',blocks:[{text:'not-in-inbox'}],permissions:{default:'private',inherit:false,groups:{},members:{alice:'edit',guest:'view'}},verification:{owners:['alice','guest'],owner:'alice',verified_by:'local',verified_at:'2026-10-16T00:00:00Z',expires_at:stamp,cycle_revision:4}});
 const inbox=new Inbox(store,new Access(store,store.get('member',actor)),()=>now);return{store,page,inbox};
}
let checks=0;
const query=value=>new URLSearchParams(value),denied=(fn,status)=>{assert.throws(fn,error=>error instanceof APIError&&error.status===status);checks++};
{
 const f=fixture(),before=clone(f.store.records),result=f.inbox.get(query(''));assert.equal(result.total,1);assert.equal(result.unread_count,1);assert.match(result.items[0].id,/^[a-f0-9]{64}$/);
 assert.deepEqual(Object.keys(result.items[0]).sort(),['id','type','page_id','title','icon','verified_at','expires_at','read','archived'].sort());assert(!JSON.stringify(result).includes('not-in-inbox'));assert.deepEqual(f.store.records,before);
 for(const actor of ['local','bob','inactive'])assert.equal(fixture(actor).inbox.get(query('')).total,0);assert.equal(fixture('guest').inbox.get(query('')).total,1);checks++;
 const id=result.items[0].id;f.inbox.patch(id,{read:true});assert.equal(new Inbox(f.store,new Access(f.store,f.store.get('member','alice')),()=>now).get(query('')).items[0].read,true);assert.equal(f.inbox.get(query('filter=unread')).total,0);
 const guest=new Inbox(f.store,new Access(f.store,f.store.get('member','guest')),()=>now);assert.equal(guest.get(query('')).items[0].read,false);
 f.inbox.patch(id,{read:false,archived:true});assert.equal(f.inbox.get(query('')).total,0);assert.equal(f.inbox.get(query('')).unread_count,0);assert.equal(f.inbox.get(query('filter=archived')).total,1);f.inbox.patch(id,{archived:false});assert.equal(f.inbox.get(query('')).unread_count,1);assert.deepEqual(f.store.get('page',f.page.id),f.page);checks++;
 for(const body of [{},{read:1},{archived:null},{read:true,member_id:'guest'},[],null])denied(()=>f.inbox.patch(id,body),400);
 for(const id of ['x','A'.repeat(64),'__proto__'])denied(()=>f.inbox.patch(id,{read:true}),400);
}
for(const value of ['filter=all&filter=unread','limit=0','limit=101','limit=01','offset=-1','offset=1000001','unknown=x','filter=ALL','limit=1&limit=1','filter=','unknown=','filter=all&filter=','__proto__=x'])denied(()=>fixture().inbox.get(query(value)),400);
{
 const f=fixture(),id=f.inbox.get(query('')).items[0].id;
 for(const actor of ['local','bob'])denied(()=>new Inbox(f.store,new Access(f.store,f.store.get('member',actor)),()=>now).patch(id,{read:true}),404);
 for(const change of [{verification:null},{archived:true},{deleted:true},{deleted_at:'2026-10-17T00:00:00Z'},{verification:{...f.page.verification,owners:['guest']}},{permissions:{default:'private',inherit:false,groups:{},members:{}}},{verification:{...f.page.verification,expires_at:'2099-01-01T00:00:00Z'}}]){f.store.put('page',{...f.page,...change});denied(()=>f.inbox.patch(id,{read:true}),404);assert.equal(f.store.list('inbox_receipt').length,0)}
 f.store.put('page',f.page);f.inbox.patch(id,{read:true});f.store.put('page',{...f.page,title:'new content',revision:20});assert.equal(f.inbox.get(query('')).items[0].id,id);assert.equal(f.inbox.get(query('')).items[0].read,true);
 f.store.put('page',{...f.page,verification:{...f.page.verification,cycle_revision:5}});assert.notEqual(f.inbox.get(query('')).items[0].id,id);assert.equal(f.inbox.get(query('')).items[0].read,false);assert.equal(f.store.list('inbox_receipt').length,1);checks++;
}
{
 const f=fixture();for(const override of [{expires_at:null},{expires_at:false},{expires_at:'2099-01-01T00:00:00Z'},{expires_at:'2026-10-17T00:00:00.123001Z'},{owners:['alice',3]},{verified_at:false},{owners:[]},{cycle_revision:false}]){f.store.put('page',{...f.page,verification:{...f.page.verification,...override}});assert.equal(f.inbox.get(query('')).total,0,JSON.stringify(override));checks++}
}
{
 const f=fixture(),access=new Access(f.store,f.store.get('member','alice')),advanced=new Advanced(f.store,new Workspace(f.store,{actor:'alice',access}),{actor:'alice',access,clock:()=>now}),guard=new Authorization(access);
 const verify=()=>advanced.dispatch('POST','/api/pages/'+f.page.id+'/verify',{owners:['alice'],expires_at:'2099-01-01T00:00:00Z'},new URLSearchParams()).payload;
 const first=verify();assert.equal(first.verification.cycle_revision,5);assert(!Object.hasOwn(guard.project('/api/pages/'+f.page.id,{page:first}).page.verification,'cycle_revision'));
 const inbox=new Inbox(f.store,access,()=>Date.parse('2099-01-02T00:00:00Z')),id=inbox.get(query('')).items[0].id;inbox.patch(id,{read:true});verify();assert.notEqual(inbox.get(query('')).items[0].id,id);assert.equal(inbox.get(query('')).items[0].read,false);denied(()=>inbox.patch(id,{read:true}),404);checks++;
}
{
 const f=fixture();for(const id of ['z','a'])f.store.put('page',{...f.page,id,verification:{...f.page.verification,expires_at:'2026-10-16T23:00:00Z'}});
 const full=f.inbox.get(query('')),first=f.inbox.get(query('limit=1'));assert.equal(full.items[0].page_id,f.page.id);assert.equal(first.total,3);assert.equal(first.has_more,true);assert.deepEqual(full.items.slice(1).map(item=>item.id),full.items.slice(1).map(item=>item.id).sort());assert.deepEqual(f.inbox.get(query('offset=3')).items,[]);checks++;
}
// Exact DTO/event/receipt parity against actual Python SQLite. Inputs are
// operator-owned fixtures; actor principal is not an Auth or cloud proof.
{
 const f=fixture(),records=Object.fromEntries([...f.store.records.keys()].map(kind=>[kind,f.store.list(kind)])),results=[];
 for(const cycle of [4,null,0,Number.MAX_SAFE_INTEGER]){const page=f.store.get('page',f.page.id);if(cycle===null)delete page.verification.cycle_revision;else page.verification.cycle_revision=cycle;f.store.put('page',page);
 for(const actor of ['alice','guest','local','bob','inactive']){
  const inbox=new Inbox(f.store,new Access(f.store,f.store.get('member',actor)),()=>now),first=inbox.get(query(''));results.push(first);
  if(first.items.length){results.push(inbox.patch(first.items[0].id,{read:true}));results.push(inbox.get(query('filter=unread')));results.push(inbox.patch(first.items[0].id,{archived:true}));results.push(inbox.get(query('filter=archived')))}
 }
 }
 const oracle=spawnSync(process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',['-c',`
import sys,json
from datetime import datetime
from fountain.core import Store
from fountain.access import Access
from fountain.inbox import Inbox
x=json.load(sys.stdin);s=Store(':memory:')
for kind,rows in x['records'].items():
 for row in rows:s.put(kind,row)
out=[]
for cycle in [4,None,0,9007199254740991]:
 page=s.get('page','page😀')
 if cycle is None:page['verification'].pop('cycle_revision',None)
 else:page['verification']['cycle_revision']=cycle
 s.put('page',page)
 for actor in ['alice','guest','local','bob','inactive']:
  i=Inbox(s,Access(s,s.get('member',actor)),clock=lambda:datetime.fromisoformat(x['stamp']));first=i.get({});out.append(first)
  if first['items']:
   id=first['items'][0]['id'];out.extend([i.patch(id,{'read':True}),i.get({'filter':['unread']}),i.patch(id,{'archived':True}),i.get({'filter':['archived']})])
print(json.dumps(out));s.close()
`],{input:JSON.stringify({records,stamp}),encoding:'utf8'});assert.equal(oracle.status,0,oracle.stderr);assert.deepEqual(results,JSON.parse(oracle.stdout));console.log('PASS inbox '+results.length+' Python/SQLite vs TypeScript DTO/event/receipt results');
}
// Real CloudStore/default transaction budget; private provider is paginated
// and modeled, not a PostgreSQL or actual Auth claim.
{
 const f=fixture(),owners=Array.from({length:1000},(_,i)=>'m'+i);owners[0]='alice';for(const id of owners)f.store.put('member',{id,role:'member',active:true});
 f.store.put('page',{...f.page,permissions:{default:'workspace',inherit:false,members:{},groups:{}},verification:{...f.page.verification,owners}});
 let snapshots=0,commits=0,revision=0;const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:now+60000,profile:{workspaceId:'inbox-fixture',member:f.store.get('member','alice'),authSessionActive:true}};
 const provider={async snapshot(request){snapshots++;const selected=request.selection,all=[...f.store.records].flatMap(([kind,rows])=>[...rows.values()].filter(data=>selected.kinds.includes(kind)||selected.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=selected.pageSize;
  return{workspaceId:'inbox-fixture',memberId:'alice',principal:auth.profile.member,revision,accessRevision:0,entities:clone(all.slice(offset,offset+size)),meta:selected.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,present:true,value:f.store.list('page').map(projectPageHeader)}:key===VERIFICATION_INDEX_META_KEY?{key,present:true,value:projectVerificationIndex(f.store.list('database'),f.store.list('row'))}:{key,present:f.store.metadata.has(key),value:f.store.meta(key)}),nextCursor:offset+size<all.length?{offset:offset+size}:null};},async commit(request){commits++;for(const change of request.changes){assert.equal(change.op,'put');f.store.put(change.kind,change.data);revision++;}return{revision}}};
 const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>now,extensions:[createAdvancedExtension({clock:()=>now,cloud:true})]});
 const get=await domain(new Request('https://fixture.example/api/inbox'),'/api/inbox',auth),body=await get.json();assert.equal(get.status,200);assert.equal(body.total,1);assert(snapshots<30);assert.equal(revision,0,'GET never creates a receipt');const firstSnapshots=snapshots;snapshots=0;
 const patchPath='/api/inbox/'+body.items[0].id,patched=await domain(new Request('https://fixture.example'+patchPath,{method:'PATCH',body:JSON.stringify({read:true})}),patchPath,auth);assert.equal((await patched.json()).read,true);assert.equal(revision,1);assert(snapshots<30);
 console.log('PASS inbox real CloudStore/default transactions: 1000 assignees GET '+firstSnapshots+' / PATCH '+snapshots+' model snapshot calls, receipt-only commit');
}
console.log('PASS inbox '+checks+' staged production authorization/receipt/query/freshness checks; no external cloud I/O');
