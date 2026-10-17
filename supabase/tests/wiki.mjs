/** Production Wiki/ACL contracts with SQLite parity and real CloudStore over a
 * paginated RPC model. This file does not claim actual PostgreSQL/HTTP execution. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
import {Wiki} from '../functions/_shared/wiki.ts';
import {Workspace} from '../functions/_shared/core.ts';
import {Advanced,createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {createDomain} from '../functions/_shared/domain.ts';
const time='2026-10-16T00:00:00.123000+00:00';
class Store{
 requestTime=time;context={memberId:'local'};records=new Map();metadata=new Map();sequence=0;
 get(kind,id){return clone(this.records.get(kind)?.get(id)??null);}
 list(kind){return [...(this.records.get(kind)?.values()??[])].map(clone);}
 meta(key,fallback=null){return clone(this.metadata.get(key)??fallback);}
 set_meta(key,value){this.metadata.set(key,clone(value));}
 allocate_id(){return 'fixture-'+(++this.sequence);}
 put(kind,value){const next={...clone(value),id:value.id||this.allocate_id(),created_at:value.created_at??time,updated_at:time};if(!this.records.has(kind))this.records.set(kind,new Map());this.records.get(kind).set(next.id,next);return clone(next);}
 delete(kind,id){this.records.get(kind)?.delete(id);}
 audit(action,details,user=this.context.memberId){return this.put('audit',{action,details,user});}
 transaction(action){const old=clone([this.records,this.metadata,this.sequence]);try{return action();}catch(error){[this.records,this.metadata,this.sequence]=old;throw error;}}
}
function fixture(){
 const store=new Store();for(const [id,role]of [['local','owner'],['alice','member'],['bob','member'],['guest','guest'],['inactive','member']])store.put('member',{id,name:id,role,active:id!=='inactive',email:id+'@example.invalid',private:'never-return'});
 store.put('settings',{id:'workspace',name:'Fountain'});
 const root=store.put('page',{id:'wiki-root',title:'지식',parent_id:null,owner_id:'local',revision:0,blocks:[{type:'paragraph',text:'원문'}],permissions:{default:'private',inherit:false,groups:{},members:{alice:'edit',bob:'edit',guest:'view'}}});
 store.put('page',{...root,id:'child',title:'문서',parent_id:root.id});
 const call=(method,suffix,body={},actor='local',query={})=>store.transaction(()=>{
  store.context.memberId=actor;body=clone(body);const access=new Access(store,store.get('member',actor)),authority=new Authorization(access),workspace=new Workspace(store,{actor,access}),path=suffix==='create'?'/api/pages':'/api/pages/'+suffix;
  authority.prepare(method,path,body);let result;
  if(suffix==='create')result=workspace.create_page(body);
  else if(suffix.endsWith('/verify'))result=new Advanced(store,workspace,{actor,access,clock:()=>Date.parse(time)}).verify_page(method,suffix.split('/')[0],body);
  else if(!suffix.includes('/'))result=workspace.update_page(suffix,body);
  else result=new Wiki(store,access).route(method,suffix.split('/')[0],suffix.split('/')[1],body,query);
  return authority.project(path,result);
 });
 return{store,call,root};
}
let checks=0;
function denied(f,status,method,suffix,body={},actor='local',query={}){const before=clone([f.store.records,f.store.metadata]);assert.throws(()=>f.call(method,suffix,body,actor,query),error=>error instanceof APIError&&error.status===status);assert.deepEqual([f.store.records,f.store.metadata],before);checks++;}
{
 const f=fixture();f.call('POST','wiki-root/wiki',{revision:0});const created=f.call('POST','create',{id:'created',title:'새 문서',parent_id:'wiki-root',owner_id:'bob'},'alice');assert.equal(created.owner_id,'alice');assert.equal(created.is_wiki,false);assert.equal(f.store.get('wiki_page','created').owner_id,'alice');assert.equal(f.call('GET','created/wiki-owner',{},'alice').can_verify,true);checks++;
 for(const field of ['is_wiki','wiki_owner','knowledge_owner','wiki_page']){denied(f,400,'POST','create',{title:'x',parent_id:'wiki-root',[field]:true},'alice');denied(f,400,'PATCH','child',{[field]:true});}
 f.call('POST','wiki-root/verify',{owners:['alice','bob']});assert.deepEqual(f.store.get('page','wiki-root').verification.owners,['alice','bob']);checks++;
}
{
 const f=fixture(),source=f.store.get('page','child');assert.equal(f.call('GET','child/wiki-owner').in_wiki,false);assert.equal(f.call('GET','child/wiki-owner',{},'alice').can_verify,true);
 f.call('POST','wiki-root/wiki',{revision:0});const root=f.store.get('page','wiki-root');assert.equal(root.is_wiki,true);assert.equal(root.revision,1);assert.deepEqual(root.blocks,f.root.blocks);assert.deepEqual(root.permissions,f.root.permissions);assert.deepEqual(f.store.get('page','child'),source);
 assert.equal(f.call('GET','wiki-root/wiki-owner').in_wiki,false);assert.equal(f.call('GET','child/wiki-owner').in_wiki,true);assert.equal(f.call('GET','child/wiki-owner').owner.id,'local');
 f.call('DELETE','wiki-root/wiki',{revision:1});assert.deepEqual(f.store.get('page','child'),source);checks++;
}
for(const parent of [[],{},['wiki-root'],{id:'wiki-root'},false,3]){
 const f=fixture(),source=f.store.put('page',{...f.root,id:'malformed',is_wiki:true,parent_id:parent});f.call('POST','wiki-root/wiki',{revision:0});assert.deepEqual(f.store.get('page','malformed'),source);checks++;
}
{
 const f=fixture();denied(f,403,'POST','wiki-root/wiki',{revision:0},'alice');denied(f,409,'POST','child/wiki',{revision:0});denied(f,409,'POST','wiki-root/wiki',{revision:1});
 for(const revision of [null,true,-1,'0',0.5,9007199254740992])denied(f,400,'POST','wiki-root/wiki',{revision});
 for(const body of [{},{revision:0,unknown:true}])denied(f,400,'POST','wiki-root/wiki',body);
 f.store.put('page',{...f.root,locked:true});denied(f,423,'POST','wiki-root/wiki',{revision:0});
}
{
 const f=fixture();f.store.put('page',{...f.root,id:'nested',parent_id:'child',is_wiki:true});denied(f,409,'POST','wiki-root/wiki',{revision:0});f.store.delete('page','nested');f.call('POST','wiki-root/wiki',{revision:0});
 denied(f,409,'PATCH','wiki-root',{parent_id:'child',revision:1});
 f.call('PATCH','child',{parent_id:null,revision:0});assert.equal(f.call('GET','child/wiki-owner').in_wiki,false);f.call('PATCH','child',{parent_id:'wiki-root',revision:1});assert.equal(f.call('GET','child/wiki-owner').in_wiki,true);checks++;
 for(const parent_id of ['missing','child',[],{},false]){f.store.put('page',{...f.store.get('page','child'),parent_id});denied(f,404,'GET','child/wiki-owner');}
 for(const parent_id of [['wiki-root'],{id:'wiki-root'},'child','missing']){f.store.put('page',{...f.store.get('page','child'),parent_id,permissions:{default:'workspace',inherit:true,members:{},groups:{}}});for(const suffix of ['wiki-owner','wiki'])denied(f,404,'GET','child/'+suffix,{},'alice');}
}
{
 const f=fixture();f.call('POST','wiki-root/wiki',{revision:0});
 for(const body of [{},{owner_id:'alice'},{owner_id:true,revision:0},{owner_id:'alice',revision:true},{owner_id:'alice',revision:0,unknown:true}])denied(f,400,'PATCH','child/wiki-owner',body);
 denied(f,409,'PATCH','child/wiki-owner',{owner_id:'alice',revision:1});for(const owner_id of ['missing','inactive'])denied(f,404,'PATCH','child/wiki-owner',{owner_id,revision:0});denied(f,403,'PATCH','child/wiki-owner',{owner_id:'alice',revision:0},'guest');
 f.call('POST','child/verify',{owners:['local'],expires_at:'2099-01-01T00:00:00Z'});const before=f.store.get('page','child'),epoch=f.store.meta('access_revision',0);
 const value=f.call('PATCH','child/wiki-owner',{owner_id:'alice',revision:1},'bob'),after=f.store.get('page','child');assert.equal(value.owner.id,'alice');assert.equal(after.owner_id,'local');assert.deepEqual(after.permissions,before.permissions);assert.deepEqual(after.blocks,before.blocks);assert.equal(f.store.meta('access_revision',0),epoch);assert.deepEqual(after.verification.owners,['alice']);
 for(const key of ['verified_at','verified_by','expires_at','cycle_revision'])assert.deepEqual(after.verification[key],before.verification[key]);
 denied(f,403,'POST','child/verify',{},'bob');denied(f,403,'DELETE','child/verify',{},'local');denied(f,400,'POST','child/verify',{owners:['alice','bob']},'alice');f.call('DELETE','child/verify',{},'alice');checks++;
}
{
 const f=fixture();f.call('POST','wiki-root/wiki',{revision:0});
 const page=f.store.get('page','child');page.permissions.members.guest='edit';f.store.put('page',page);f.call('POST','child/verify',{});
 const owner=f.call('GET','child/wiki-owner',{},'guest');assert.equal(owner.in_wiki,true);assert.equal(owner.owner,null);assert.deepEqual(owner.members,[{id:'guest',name:'guest'}]);assert.equal(owner.can_manage,true);assert.equal(owner.can_verify,false);denied(f,404,'PATCH','child/wiki-owner',{owner_id:'alice',revision:1},'guest');
 f.call('PATCH','child/wiki-owner',{owner_id:'guest',revision:1},'guest');assert.deepEqual(f.store.get('page','child').verification.owners,['guest']);f.call('POST','child/verify',{},'guest');checks++;
}
{
 const f=fixture();f.call('POST','wiki-root/wiki',{revision:0});const root=f.store.get('page','wiki-root');delete root.permissions.members.guest;f.store.put('page',root);
 const owner=f.call('GET','child/wiki-owner',{},'guest');assert.equal(owner.in_wiki,true);assert.equal(owner.wiki,null);assert.equal(owner.owner,null);denied(f,404,'GET','wiki-root/wiki',{},'guest');checks++;
}
{
 const f=fixture();f.call('POST','wiki-root/wiki',{revision:0});for(const [id,title]of [['a','A'],['b','a'],['s','ß'],['t','SS'],['u','😀']])f.store.put('page',{...f.store.get('page','child'),id,title,private:'never-return'});
 const value=f.call('GET','wiki-root/wiki',{},'local',{limit:['2'],offset:['1']});assert.deepEqual(value.items.map(v=>v.id),['b','s']);assert.equal(value.total,6);assert.equal(value.has_more,true);assert.equal(f.call('GET','wiki-root/wiki',{},'local',{q:['SS']}).total,2);
 const allowed=['id','title','icon','parent_id','owner','verification','created_at','updated_at','revision','can_edit','can_verify'].sort();for(const item of value.items)assert.deepEqual(Object.keys(item).sort(),allowed);checks++;
 for(const query of [{q:['x'.repeat(201)]},{q:['😀'.repeat(201)]},{view:[]},{view:'all'},{view:['x']},{limit:['101']},{limit:['0']},{offset:['1000001']},{offset:['-1']},{limit:[' 1']},{limit:['1.0']},{offset:['1','2']},{bad:['x']}])denied(f,400,'GET','wiki-root/wiki',{},'local',query);
 denied(f,400,'GET','wiki-root/wiki',{},'local',new URLSearchParams('view=home&view=all'));denied(f,400,'POST','wiki-root/wiki',{revision:1},'local',{q:['x']});denied(f,405,'PUT','wiki-root/wiki');denied(f,405,'POST','child/wiki-owner');
}
{
 const f=fixture();f.call('POST','wiki-root/wiki',{revision:0});const source={owners:['local',3],verified_at:time,expires_at:false};f.store.put('page',{...f.store.get('page','child'),verification:source});f.call('PATCH','child/wiki-owner',{owner_id:'alice',revision:0});assert.deepEqual(f.store.get('page','child').verification,source);
 f.store.put('wiki_page',{id:'child',page_id:'wrong',owner_id:'alice'});assert.equal(f.call('GET','child/wiki-owner').owner,null);denied(f,403,'POST','child/verify');checks++;
}
console.log('PASS '+checks+' staged Wiki production checks');

// Same records and operations run through Python SQLite production Wiki, Access,
// Workspace and Advanced. No test-side duplicate implementation of wiki behavior.
const oracle=`
import json,sys
from fountain import core,advanced
from fountain.wiki import Wiki
from fountain.access import Access
from fountain.authorization import Authorization
spec=json.load(sys.stdin);core.now=lambda:spec['time'];advanced.now=lambda:spec['time']
s=core.Store(':memory:')
for kind,rows in spec['records'].items():
 for row in rows:s.put(kind,row)
w=core.Workspace.__new__(core.Workspace);w.store=s;w.lock=s.lock
out=[]
for op in spec['operations']:
 actor=op.get('actor','local');a=Access(s,s.get('member',actor));guard=Authorization(a);token=core.AUDIT_ACTOR.set(actor);at=core.CURRENT_ACCESS.set(a)
 method,suffix,body,query=op['method'],op['suffix'],op.get('body',{}),op.get('query',{})
 try:
  with s.transaction():
   path='/api/pages' if suffix=='create' else '/api/pages/'+suffix;guard.prepare(method,path,body)
   if suffix=='create':value=w.create_page(body)
   elif suffix.endswith('/verify'):value=advanced.Advanced(s,w).verify_page(method,suffix.split('/')[0],body)
   elif '/' not in suffix:value=w.update_page(suffix,body)
   else:value=Wiki(s,a).route(method,*suffix.split('/'),body,query)
   out.append({'ok':guard.project(path,value)})
 except core.APIError as e:out.append({'error':{'status':e.status,'message':str(e)}})
 finally:core.AUDIT_ACTOR.reset(token);core.CURRENT_ACCESS.reset(at)
print(json.dumps(out));s.close()
`;
const f=fixture(),records=Object.fromEntries([...f.store.records.keys()].map(kind=>[kind,f.store.list(kind)]));
const operations=[
 {method:'GET',suffix:'child/wiki-owner'},
 {method:'POST',suffix:'wiki-root/wiki',body:{revision:0}},
 {method:'POST',suffix:'create',body:{id:'created',title:'새 문서',parent_id:'wiki-root',owner_id:'bob'},actor:'alice'},
 ...['home','all','owned'].flatMap(view=>['local','alice','guest'].map(actor=>({method:'GET',suffix:'wiki-root/wiki',actor,query:{view:[view]}}))),
 {method:'PATCH',suffix:'child/wiki-owner',body:{owner_id:'alice',revision:0},actor:'bob'},
 {method:'POST',suffix:'child/verify',body:{owners:['alice']},actor:'alice'},
 {method:'POST',suffix:'child/verify',body:{owners:['alice','bob']},actor:'alice'},
 {method:'DELETE',suffix:'child/verify',actor:'local'},
 {method:'GET',suffix:'child/wiki-owner',actor:'guest'},
 {method:'PATCH',suffix:'child/wiki-owner',body:{owner_id:'bob',revision:2},actor:'alice'},
 {method:'DELETE',suffix:'child/verify',actor:'bob'},
 {method:'PATCH',suffix:'wiki-root',body:{parent_id:'child',revision:1}},
 ...[{limit:['']},{q:['😀'.repeat(201)]},{unknown:['x']},{view:['all','home']},{offset:['01']}].map(query=>({method:'GET',suffix:'wiki-root/wiki',query})),
 {method:'DELETE',suffix:'wiki-root/wiki',body:{revision:1}},
 {method:'GET',suffix:'child/wiki-owner'},
 {method:'POST',suffix:'child/verify',body:{owners:['alice','bob']},actor:'alice'},
];
const actual=operations.map(op=>{try{return{ok:f.call(op.method,op.suffix,op.body,op.actor,op.query)};}catch(error){if(!(error instanceof APIError))throw error;return{error:{status:error.status,message:error.message}};}});
const result=spawnSync(process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/fountain/.data/supabase-venv/bin/python',['-c',oracle],{input:JSON.stringify({time,records,operations}),encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr);assert.deepEqual(actual,JSON.parse(result.stdout));
console.log('PASS '+operations.length+' Python/SQLite versus TypeScript production wiki results');

// Real CloudStore/default createTransactions, paginated provider model, 1000
// eligible workspace members and 1000 descendants. GET commits have zero domain
// changes; ownership PATCH is one private owner sidecar, page and audit write.
{
 const f=fixture();f.store.delete('settings','workspace');f.store.put('page',{...f.root,is_wiki:true});for(let i=0;i<1000;i++){f.store.put('member',{id:'member-'+i,name:'Member '+i,role:'member',active:true});f.store.put('page',{...f.root,id:'page-'+i,title:'Page '+String(i).padStart(4,'0'),parent_id:'wiki-root',permissions:{default:'workspace',inherit:false,members:{},groups:{}}});}
 let snapshots=0,commits=0,revision=0;const changes=[];
 const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'wiki-fixture',authSessionActive:true,member:f.store.get('member','local')}};
 const provider={async snapshot(request){snapshots++;const all=[...f.store.records].flatMap(([kind,rows])=>[...rows.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=request.selection.pageSize;
 return{workspaceId:auth.profile.workspaceId,memberId:request.context.memberId,revision,accessRevision:0,principal:f.store.get('member',request.context.memberId),entities:clone(all.slice(offset,offset+size)),meta:request.selection.metaKeys.map(key=>({key,value:f.store.meta(key),present:f.store.metadata.has(key)})),nextCursor:offset+size<all.length?{offset:offset+size}:null};},async commit(request){commits++;assert.equal(request.expectedRevision,revision);changes.push(clone(request.changes));for(const change of request.changes){if(change.op==='put')f.store.put(change.kind,change.data);else if(change.op==='delete')f.store.delete(change.kind,change.id);else f.store.set_meta(change.key,change.value);revision++;}return{revision};}};
 const domain=createDomain({provider,extensions:[createAdvancedExtension({cloud:true})],authorize:async()=>clone(auth),clock:()=>Date.parse(time)});
 async function call(method,suffix,body){const path='/api/pages/'+suffix;return domain(new Request('https://fixture.example'+path,{method,...(body?{body:JSON.stringify(body)}:{})}),path.split('?')[0],auth);}
 const view=await (await call('GET','wiki-root/wiki?view=all&limit=100&offset=900')).json();assert.equal(view.total,1001);assert.equal(view.items.length,100);assert.equal(view.has_more,true);assert.deepEqual(changes.at(-1),[]);assert.equal(f.store.get('settings','workspace'),null);assert(snapshots<50,`snapshot calls ${snapshots}`);
 snapshots=0;const owners=await (await call('GET','page-0/wiki-owner')).json();assert.equal(owners.members.length,1003);assert.equal(owners.in_wiki,true);assert.deepEqual(changes.at(-1),[]);assert(snapshots<50,`snapshot calls ${snapshots}`);
 snapshots=0;const patched=await (await call('PATCH','page-0/wiki-owner',{owner_id:'member-999',revision:0})).json();assert.equal(patched.owner.id,'member-999');assert.equal(patched.can_verify,false);assert.equal(f.store.get('page','page-0').owner_id,'local');assert.equal(f.store.meta('access_revision',0),0);assert.equal(changes.at(-1).length,3);assert(snapshots<50,`snapshot calls ${snapshots}`);
 console.log('PASS actual CloudStore/default selection 1000 members+1000 descendants: '+commits+' commits, '+snapshots+' final-operation paginated snapshots; GET domain changes zero; no real cloud');
}
