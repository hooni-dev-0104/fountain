import assert from 'node:assert/strict';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {Workspace} from '../functions/_shared/core.ts';
import {DatabaseVerification,pair,prepareSchema} from '../functions/_shared/database-verification.ts';
import {dispatchStaged} from '../functions/_shared/domain.ts';
import {createAdvancedExtension} from '../functions/_shared/advanced.ts';
const time='2026-10-17T00:00:00.000000+00:00';
class Store{
 requestTime=time;context={memberId:'local'};records=new Map();metadata=new Map();sequence=0;contentActor=null;
 // Synchronous scope model for dispatchStaged only. Actual CloudStore actor
 // validation/provenance is tested separately; this does not prove SQL behavior.
 with_content_actor(origin,action){const previous=this.contentActor;this.contentActor=clone(origin);try{const value=action();assert(!(value&&typeof value.then==='function'),'Fixture actor callback must be synchronous');return value;}finally{this.contentActor=previous;}}
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

// The test double restores nested scopes on both success and failure.
{
 const store=new Store(),outer={member_id:'local',cause:'human'},inner={member_id:'alice',cause:'automation'};
 assert.throws(()=>store.with_content_actor(outer,()=>{assert.deepEqual(store.contentActor,outer);store.with_content_actor(inner,()=>assert.deepEqual(store.contentActor,inner));assert.deepEqual(store.contentActor,outer);throw Error('fixture actor rollback');}),/fixture actor rollback/);
 assert.equal(store.contentActor,null);
 console.log('PASS synchronous in-memory actor scope restoration; no SQL provenance claim');
}

function fixture(){const store=new Store();store.context={memberId:'local',workspaceId:'typed-fixture',cacheBinding:'fixture'};Object.defineProperty(store,'principal',{get(){return store.get('member',store.context.memberId);}});for(const [id,role]of [['local','owner'],['alice','member'],['bob','member'],['guest','guest'],['inactive','member']])store.put('member',{id,name:id,role,active:id!=='inactive'});store.put('teamspace',{id:'general',visibility:'open',owner_id:'local'});store.put('settings',{id:'workspace'});
const call=(method,path,body={},actor='local',query=new URLSearchParams())=>{store.context.memberId=actor;return store.transaction(()=>dispatchStaged(store,method,path,body,query,[createAdvancedExtension({cloud:true})]).payload);};return {store,call};}
let checks=0;function denied(f,status,method,path,body={},actor='local',query){const before=clone([f.store.records,f.store.metadata]);assert.throws(()=>f.call(method,path,body,actor,query),e=>e instanceof APIError&&e.status===status);assert.deepEqual([f.store.records,f.store.metadata],before);checks++;}
const dbPath='/api/databases/typed',rowPath=dbPath+'/rows/row',contextPath=rowPath+'/verification';
function setup(props=[{id:'title',name:'Title',type:'title'},{id:'verified',name:'Verified',type:'verification'}]){const f=fixture(),db=f.call('POST','/api/databases',{id:'typed',name:'Typed',properties:props}),owner=pair(db)[0];return {...f,db,owner};}
{
const f=setup();assert.equal(f.owner.initial_default,'created_by');const row=f.call('POST',dbPath+'/rows',{id:'row',properties:{title:'Original'}},'alice');assert.deepEqual(row.properties[f.owner.id],['alice']);assert(!('_owner_generations'in row));const context=f.call('GET',contextPath,{},'bob');assert.equal(context.revision.length,64);assert.equal(context.can_verify,true);const verified=f.call('POST',contextPath,{revision:context.revision,expires_at:null},'bob');assert.equal(verified.verification.status,'verified');assert.equal(verified.verification.verified_by,'bob');denied(f,409,'DELETE',contextPath,{revision:context.revision},'bob');assert.equal(f.call('GET',dbPath).rows[0].properties.verified.status,'verified');f.call('DELETE',contextPath,{revision:verified.revision},'alice');assert.equal(f.call('GET',contextPath).verification.status,'unverified');checks++;
}
console.log('PASS '+checks+' database Owner and Verification staged checks');
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner',limit:'unlimited'},{id:'verified',name:'Verified',type:'verification'}]);f.call('POST',dbPath+'/rows',{id:'row',properties:{title:'Original'}},'alice');
 for(const field of ['verification','_owner_generations','verification_cycle','_verification_generation','owner_generations']){denied(f,400,'PATCH',rowPath,{[field]:null});denied(f,400,'POST',dbPath+'/rows',{id:'forged',[field]:null});}
 for(const value of [null,{},'verified'])denied(f,400,'PATCH',rowPath,{properties:{verified:value}});
 for(const revision of [null,true,0,'X'.repeat(64),'0'.repeat(63)])denied(f,400,'POST',contextPath,{revision});
 const token=f.call('GET',contextPath).revision;for(const expires_at of [true,{},[],'2099-01-01','2099-01-01T00:00:00','2000-01-01T00:00:00Z'])denied(f,400,'POST',contextPath,{revision:token,expires_at});
 denied(f,400,'POST',contextPath,{revision:token,unknown:true});denied(f,405,'PATCH',contextPath);denied(f,400,'GET',contextPath,{},'local',new URLSearchParams('x=1'));
 for(const value of [null,'alice',[false],Array(1001).fill('alice')])denied(f,400,'PATCH',rowPath,{properties:{owner:value}});for(const value of [['missing'],['inactive']])denied(f,404,'PATCH',rowPath,{properties:{owner:value}});
 f.call('PATCH',rowPath,{properties:{owner:['alice','bob','bob']}});assert.deepEqual(f.store.get('row','row').properties.owner,['alice','bob']);const before=f.store.get('row','row');const props=clone(f.db.properties);props.find(p=>p.type==='owner').limit='one';denied(f,409,'PATCH',dbPath,{properties:props});assert.deepEqual(f.store.get('row','row'),before);
 const db=f.store.get('database','typed');db.permissions={default:'workspace',members:{guest:'edit'},groups:{},inherit:false};f.store.put('database',db);f.call('PATCH',rowPath,{properties:{owner:['guest']}},'guest');assert.deepEqual(f.store.get('row','row').properties.owner,['guest','alice','bob']);assert.deepEqual(f.call('GET',contextPath,{},'guest').owners,['guest']);checks++;
}
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'person',name:'Person',type:'multi_select'}]);f.call('POST',dbPath+'/rows',{id:'row',properties:{person:['bob']}},'alice');
 const props=[f.db.properties[0],{id:'person',name:'Owner',type:'owner'},{id:'verified',name:'Verified',type:'verification'}];const db=f.call('PATCH',dbPath,{properties:props});assert.deepEqual(f.call('GET',contextPath).owners,[]);f.call('PATCH',rowPath,{properties:{person:['alice']}});let context=f.call('GET',contextPath);f.call('POST',contextPath,{revision:context.revision});const raw=f.store.get('row','row');
 f.call('PATCH',dbPath,{properties:[props[0]]});f.call('PATCH',dbPath,{properties:props});context=f.call('GET',contextPath);assert(context.owner_property.generation>db.properties[1].generation);assert.deepEqual(context.owners,[]);assert.equal(context.verification.status,'unverified');assert.deepEqual(f.store.get('row','row'),raw);checks++;
}
{
 const f=setup([{id:'title',name:'Title',type:'title'}]);f.call('POST',dbPath+'/rows',{id:'row',properties:{title:'Legacy'}},'alice');const raw=f.store.get('row','row');const db=f.call('PATCH',dbPath,{properties:[...f.db.properties,{id:'owner',name:'Owner',type:'owner'}]});assert.deepEqual(f.call('GET',contextPath).owners,['alice']);assert.deepEqual(f.store.get('row','row'),raw);const props=clone(db.properties);props.at(-1).default='none';f.call('PATCH',dbPath,{properties:props});assert.deepEqual(f.call('GET',contextPath).owners,['alice']);assert.deepEqual(f.call('POST',dbPath+'/rows',{id:'new',properties:{}},'alice').properties.owner,[]);checks++;
}
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'person',name:'Person',type:'person'}]),db=f.store.get('database','typed');db.row_permissions={mode:'assigned',property_id:'person',allow_create:true};f.store.put('database',db);denied(f,400,'PATCH',dbPath,{properties:[db.properties[0],{id:'person',name:'Owner',type:'owner'}]});db.properties.at(-1).type='owner';assert.equal(Access._row_policy(db),null);checks++;
}
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner'},{id:'verified',name:'Verified',type:'verification'}]);f.call('POST',dbPath+'/rows',{id:'row',properties:{title:'Original'}},'alice');let context=f.call('GET',contextPath);f.call('POST',contextPath,{revision:context.revision,expires_at:'2099-01-01T00:00:00Z'});const before=f.store.get('row','row');before.private_unknown={nested:['retained']};f.store.put('row',before);f.call('PATCH',rowPath,{properties:{owner:['bob']}});const changed=f.store.get('row','row');assert.deepEqual(changed.verification,before.verification);assert.deepEqual(changed.private_unknown,before.private_unknown);assert.equal(changed.owner_id,'alice');context=f.call('GET',contextPath);assert.deepEqual(context.verification.owners,['bob']);f.call('POST',contextPath,{revision:context.revision,expires_at:'2099-01-01T00:00:00Z'});assert.equal(f.store.get('row','row').verification_cycle,2);const copy=f.call('POST',rowPath+'/duplicate',{},'bob').rows[0];assert.equal(copy.owner_id,'bob');assert.deepEqual(copy.properties.owner,['bob']);assert.equal(copy.properties.verified.status,'unverified');assert(!('verification'in f.store.get('row',copy.id)));checks++;
 for(const property_id of ['owner','verified'])denied(f,400,'POST','/api/forms',{name:'Form',database_id:'typed',fields:[{id:'answer',property_id,type:'text'}]});
 const automation=f.call('POST','/api/automations',{id:'forge',name:'Forge',database_id:'typed',actions:[{type:'set_property',property_id:'verified',value:null}]});denied(f,400,'POST','/api/automations/'+automation.id+'/run',{row_id:'row'});
}
console.log('PASS '+checks+' extended database Owner and Verification production checks');
// Identical protocols against production SQLite Application and staged TS
// dispatch. Tokens are opaque per engine; statuses/CAS outcomes are compared.
{
 const {spawnSync}=await import('node:child_process');const f=fixture();let stale,staleSchema;
 const properties=[{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner',limit:'unlimited'},{id:'verified',name:'Verified',type:'verification'}];
 const operations=[
 ['POST','/api/databases',{id:'typed',name:'Typed',properties}],['POST',dbPath+'/rows',{id:'row',properties:{title:'Source'}},'alice'],['GET',contextPath,{},'bob'],['POST',contextPath,{revision:'$current',expires_at:'2026-10-17T09:00:00.000000+09:00'},'bob'],['POST',contextPath,{revision:'$current',expires_at:'2026-10-17T00:00:00.000001Z'},'bob'],['POST',contextPath,{revision:'$current',expires_at:'2026-10-17T09:00:00.000001+09:00'},'bob'],['POST',contextPath,{revision:'$current',expires_at:'2099-01-01T00:00:00Z'},'bob'],['DELETE',contextPath,{revision:'$stale'},'bob'],['GET',dbPath],['PATCH',rowPath,{properties:{owner:['alice','bob','bob']}}],['GET',contextPath],['PATCH',rowPath,{properties:{verified:null}}],['PATCH',rowPath,{verification:null}],['POST',contextPath,{revision:'$current',expires_at:'2020-01-01T00:00:00Z'}],['POST',contextPath,{revision:'$current',expires_at:null}],['DELETE',contextPath,{revision:'$current'}],['GET',contextPath],['PATCH',dbPath,{properties:[properties[0],{...properties[1],limit:'one'},properties[2]]}],['PATCH',rowPath,{properties:{owner:['inactive']}}],['PATCH',rowPath,{properties:{owner:['bob']}}],['PATCH',dbPath,{properties:[properties[0],{...properties[1],limit:'one',default:'none'},properties[2]]}],['POST',dbPath+'/rows',{id:'second',properties:{}},'alice'],['GET',dbPath],['PATCH',dbPath,{properties:[properties[0]]}],['PATCH',dbPath,{properties}],['GET',contextPath],['PATCH',rowPath,{properties:{owner:['alice']}}],['POST',contextPath,{revision:'$current'}],['GET',contextPath]
 ].map(([method,path,body={},actor='local'])=>({method,path,body,actor}));
 operations.push(...[{properties,schema_revision:'$schemaCurrent'},{properties,schema_revision:'$schemaStale'},{properties,schema_revision:null}].map(body=>({method:'PATCH',path:dbPath,body,actor:'local'})));
 const pick=value=>{if(value?.revision&&value?.row_id)return {...value,revision:'<opaque>'};if(value?.database&&value?.rows)return {properties:value.database.properties,rows:value.rows.map(row=>({id:row.id,owner_id:row.owner_id,properties:row.properties}))};if(value?.database_id&&value?.properties)return {id:value.id,owner_id:value.owner_id,properties:value.properties};if(Array.isArray(value?.properties))return {properties:value.properties};return value;};
 const actual=operations.map(op=>{try{const body=clone(op.body);if(body.revision==='$current')body.revision=f.call('GET',contextPath,{},op.actor).revision;if(body.revision==='$stale')body.revision=stale;if(body.schema_revision==='$schemaCurrent')body.schema_revision=f.call('GET',dbPath).database.schema_revision;if(body.schema_revision==='$schemaStale')body.schema_revision=staleSchema;const value=f.call(op.method,op.path,body,op.actor);if(op.method==='GET'&&op.path===contextPath&&!stale)stale=value.revision;if(value.schema_revision&&!staleSchema)staleSchema=value.schema_revision;return {ok:pick(value)};}catch(e){if(!(e instanceof APIError))throw e;return {error:{status:e.status,message:e.message}};}});
 const oracle=String.raw`
import json,sys
from fountain import core,database_verification
from fountain.server import Application
spec=json.load(sys.stdin);core.now=lambda:spec['time'];database_verification.now=lambda:spec['time']
s=core.Store(':memory:');app=Application(s)
for identity,role in [('local','owner'),('alice','member'),('bob','member'),('guest','guest'),('inactive','member')]:s.put('member',{'id':identity,'name':identity,'role':role,'active':identity!='inactive'})
def call(method,path,body,actor):return app.dispatch(method,path,body,{},principal=s.get('member',actor))[1]
def pick(v):
 if v.get('revision') and v.get('row_id'):return {**v,'revision':'<opaque>'}
 if 'database' in v and 'rows' in v:return {'properties':v['database']['properties'],'rows':[{'id':r['id'],'owner_id':r['owner_id'],'properties':r['properties']} for r in v['rows']]}
 if 'database_id' in v and 'properties' in v:return {'id':v['id'],'owner_id':v['owner_id'],'properties':v['properties']}
 if isinstance(v.get('properties'),list):return {'properties':v['properties']}
 return v
out=[];stale=None;staleSchema=None
for op in spec['operations']:
 body=op['body'];actor=op['actor']
 try:
  if body.get('revision')=='$current':body['revision']=call('GET','/api/databases/typed/rows/row/verification',{},actor)['revision']
  if body.get('revision')=='$stale':body['revision']=stale
  if body.get('schema_revision')=='$schemaCurrent':body['schema_revision']=call('GET','/api/databases/typed',{},actor)['database']['schema_revision']
  if body.get('schema_revision')=='$schemaStale':body['schema_revision']=staleSchema
  value=call(op['method'],op['path'],body,actor)
  if value.get('schema_revision') and staleSchema is None:staleSchema=value['schema_revision']
  if op['method']=='GET' and op['path'].endswith('/verification') and stale is None:stale=value['revision']
  out.append({'ok':pick(value)})
 except core.APIError as e:out.append({'error':{'status':e.status,'message':e.message}})
print(json.dumps(out));s.close()
`;
 const result=spawnSync(process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/fountain/.data/supabase-venv/bin/python',['-c',oracle],{input:JSON.stringify({time,operations}),encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr);const expected=JSON.parse(result.stdout);for(let i=0;i<actual.length;i++)assert.deepEqual(actual[i],expected[i],'protocol operation '+i+' '+operations[i].method+' '+operations[i].path);console.log('PASS '+operations.length+' Python/SQLite versus TypeScript database verification protocols with normalized opaque tokens');
}
// Actual default CloudStore retries/pagination over a bounded RPC model. This is
// not a claim of PostgreSQL or authenticated remote execution.
{
 const {PAGE_HEADER_META_KEY,projectPageHeader}=await import('../functions/_shared/page-headers.ts');const {createDomain}=await import('../functions/_shared/domain.ts');
 const f=fixture(),properties=[{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner',limit:'unlimited',default:'created_by',initial_default:'created_by',generation:1},{id:'verified',name:'Verified',type:'verification',generation:2,owner_property_id:'owner'}];
 f.store.put('database',{id:'typed',name:'Typed',owner_id:'local',properties,_property_generation:2,row_permissions:{},permissions:{default:'workspace',inherit:false,members:{},groups:{}}});f.store.put('row',{id:'row',database_id:'typed',owner_id:'alice',properties:{title:'Source',owner:['alice']},_owner_generations:{owner:1},unknown:{retain:true}});
 const ids=Array.from({length:1000},(_,i)=>'member-'+String(i).padStart(4,'0'));for(const id of ids)f.store.put('member',{id,name:id,role:'member',active:true});for(let i=0;i<15;i++)f.store.put('row',{id:'private-'+i,database_id:'unrelated',owner_id:'local',properties:{body:'x'.repeat(5*1024*1024)}});
 let snapshots=0,commits=0,revision=0,rowReads=0;const changes=[],auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'typed-fixture',authSessionActive:true,member:f.store.get('member','local')}};
 const provider={async snapshot(request){snapshots++;const all=[...f.store.records].flatMap(([kind,rows])=>[...rows.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=request.selection.pageSize;const page=all.slice(offset,offset+size);rowReads+=page.filter(v=>v.kind==='row'&&v.id.startsWith('private-')).length;const result={workspaceId:auth.profile.workspaceId,memberId:request.context.memberId,revision,accessRevision:0,principal:f.store.get('member',request.context.memberId),entities:clone(page),meta:request.selection.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,value:f.store.list('page').map(projectPageHeader),present:true}:{key,value:f.store.meta(key),present:f.store.metadata.has(key)}),nextCursor:offset+size<all.length?{offset:offset+size}:null};assert(Buffer.byteLength(JSON.stringify(result))<16*1024*1024);return result;},async commit(request){commits++;assert.equal(request.expectedRevision,revision);changes.push(clone(request.changes));for(const change of request.changes){if(change.op==='put')f.store.put(change.kind,change.data);else if(change.op==='delete')f.store.delete(change.kind,change.id);else f.store.set_meta(change.key,change.value);revision++;}return {revision};}};
 const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>Date.parse(time)});async function call(method,path,body){return domain(new Request('https://fixture.example'+path,{method,...(body?{body:JSON.stringify(body)}:{})}),path,auth);}
 const context=await(await call('GET',contextPath)).json();assert.equal(context.members.length,1003);assert.equal(context.can_verify,true);assert.deepEqual(changes.at(-1),[]);assert.equal(rowReads,0);assert(snapshots<64);snapshots=0;
 const assigned=await(await call('PATCH',rowPath,{properties:{owner:ids}})).json();assert.equal(assigned.properties.owner.length,1000);assert.equal(f.store.get('row','row').owner_id,'alice');assert.deepEqual(f.store.get('row','row').unknown,{retain:true});assert.equal(changes.at(-1).length,2);assert.equal(rowReads,0);assert(snapshots<64,'1000 Owner IDs must not require one missing-selection retry per person');snapshots=0;
 const current=await(await call('GET',contextPath)).json(),verified=await(await call('POST',contextPath,{revision:current.revision,expires_at:null})).json();assert.equal(verified.verification.status,'verified');assert.equal(verified.owners.length,1000);assert.equal(changes.at(-1).length,2);assert.equal(rowReads,0);assert(snapshots<64);snapshots=0;
 const auto=await(await call('POST','/api/databases',{name:'Auto pair',properties:[{id:'verified',name:'Verified',type:'verification'}]})).json();assert.equal(auto.properties.filter(p=>p.type==='owner').length,1);assert(!('_property_generation'in auto));assert(snapshots<64);assert.equal(rowReads,0);
 const changedProperties=clone(auto.properties);changedProperties[0].name='Concurrent schema';const schemaBeforeCommits=commits;await call('PATCH','/api/databases/'+auto.id,{properties:changedProperties,schema_revision:auto.schema_revision});assert.equal(commits,schemaBeforeCommits+1);const schemaSource=f.store.get('database',auto.id);await assert.rejects(()=>call('PATCH','/api/databases/'+auto.id,{properties:auto.properties,schema_revision:auto.schema_revision}),e=>e instanceof APIError&&e.status===409);assert.equal(commits,schemaBeforeCommits+1);assert.deepEqual(f.store.get('database',auto.id),schemaSource);
 console.log('PASS real CloudStore/default provider model: 1000 Owner writes/context/verification, generated auto-pair, 75MiB unrelated row bodies unread, '+commits+' commits; no actual cloud');
}
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner'},{id:'verified',name:'Verified',type:'verification'}]);f.call('POST',dbPath+'/rows',{id:'row',properties:{}},'alice');f.store.requestTime='2026-10-17T00:00:00.123000+00:00';
 for(const expires_at of ['2026-10-17T00:00:00.123000Z','2026-10-17T09:00:00.123000+09:00'])denied(f,400,'POST',contextPath,{revision:f.call('GET',contextPath).revision,expires_at});
 const verified=f.call('POST',contextPath,{revision:f.call('GET',contextPath).revision,expires_at:'2026-10-17T09:00:00.123001+09:00'});assert.equal(verified.verification.status,'verified');f.store.requestTime='2026-10-17T00:00:00.123001+00:00';assert.equal(f.call('GET',contextPath).verification.status,'expired');
 for(const [id,key,value]of [['owner','owner_property_id','forged'],['verified','initial_default','none'],['verified','default','none'],['verified','limit','one']]){const properties=clone(f.db.properties);properties.find(p=>p.id===id)[key]=value;denied(f,400,'PATCH',dbPath,{properties});}
 const original=f.store.get('row','row');for(const cycle of [true,-1,1.5,null,'2',Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1]){f.store.put('row',{...clone(original),verification_cycle:cycle});denied(f,409,'POST',contextPath,{revision:f.call('GET',contextPath).revision});}
 const exported=JSON.parse(f.call('GET','/api/export',{},'local',new URLSearchParams('format=json')).content);const row=exported.rows.find(r=>r.id==='row');for(const key of ['verification','_owner_generations','verification_cycle'])assert(!(key in row));assert(!('_property_generation'in exported.databases.find(d=>d.id==='typed')));
 console.log('PASS microsecond/timezone expiry, nonapplicable managed fields, exhausted/malformed cycles and JSON export redaction');
}
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner'}]);const token=f.db.schema_revision;assert.match(token,/^[0-9a-f]{64}$/);assert.equal(f.call('GET',dbPath).database.schema_revision,token);assert.equal(f.call('GET','/api/workspace').databases.find(d=>d.id==='typed').schema_revision,token);
 const properties=clone(f.db.properties);properties.at(-1).default='none';const next=f.call('PATCH',dbPath,{properties,schema_revision:token});assert.notEqual(next.schema_revision,token);denied(f,409,'PATCH',dbPath,{properties:f.db.properties,schema_revision:token});assert(!('schema_revision'in f.store.get('database','typed')));
 for(const schema_revision of [null,false,0,'A'.repeat(64),'0'.repeat(63)])denied(f,400,'PATCH',dbPath,{properties,schema_revision});assert.equal(f.call('PATCH',dbPath,{properties}).schema_revision,next.schema_revision);denied(f,400,'POST','/api/databases',{id:'forged',name:'Forged',schema_revision:token});
 console.log('PASS schema CAS create/GET/workspace consistency, interleaved writer409 rollback, malformed400, private raw source and legacy omission');
}
{
 const f=setup([{id:'title',name:'Title',type:'title'},{id:'owner',name:'Owner',type:'owner',limit:'unlimited'},{id:'verified',name:'Verified',type:'verification'}]);f.call('POST',dbPath+'/rows',{id:'row',properties:{}},'alice');let database=f.store.get('database','typed');database.permissions={default:'workspace',inherit:false,members:{guest:'edit'},groups:{}};database.properties[1].private='never';database.properties[2].private='never';f.store.put('database',database);
 const ids=Array.from({length:1000},(_,i)=>'member-'+i);for(const id of ids)f.store.put('member',{id,name:id,role:'member',active:true});f.call('PATCH',rowPath,{properties:{owner:ids}});denied(f,400,'PATCH',rowPath,{properties:{owner:['guest']}},'guest');const context=f.call('GET',contextPath,{},'guest');assert.deepEqual(context.owners,[]);assert(!('private'in context.owner_property));assert(!('private'in context.verification_property));
 const original=f.store.get('database','typed');for(const value of [null,true,[],{},-1,Number.MAX_SAFE_INTEGER]){f.store.put('database',{...clone(original),_property_generation:value});denied(f,409,'PATCH',dbPath,{properties:original.properties});}
 console.log('PASS hidden Owner merge1000 budget, descriptor whitelist and corrupted generation highwater failclosed');
}
