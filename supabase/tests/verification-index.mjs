/** Actual CloudStore/default transactions over a modeled snapshot contract.
 * PostgreSQL/Auth are deliberately not claimed by this model. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CloudStore,StoreError} from '../functions/_shared/store.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {Access} from '../functions/_shared/access.ts';
import {DatabaseVerification} from '../functions/_shared/database-verification.ts';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
import {VERIFICATION_INDEX_META_KEY,projectVerificationIndex,projectVerificationDatabase,projectVerificationRow,validateVerificationIndex,inboxStoreReader} from '../functions/_shared/verification-index.ts';
const clone=structuredClone,time='2026-10-16T00:00:00.000000+00:00';
const context={workspaceId:'verification-index',memberId:'alice',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)};
const principal={id:'alice',role:'member',active:true,email:'alice@example.invalid'};
const auth={hash:context.sessionHash,userId:context.userId,authSessionId:context.authSessionId,cacheBinding:context.cacheBinding,profile:{workspaceId:context.workspaceId,member:principal}};
const database=(id='db')=>({id,name:'가족 지식',owner_id:'bob',permissions:{default:'workspace'},properties:[{id:'title',name:'문서',type:'title'},{id:'owner',name:'Owner',type:'owner',generation:1,initial_default:'created_by',default:'created_by',limit:'unlimited'},{id:'verification',name:'검증',type:'verification',generation:2,owner_property_id:'owner'},{id:'body',name:'본문',type:'text'}]});
const row=(id='row',database_id='db')=>({id,database_id,owner_id:'alice',properties:{title:'실제 문서',owner:['alice'],body:'private ordinary body'},_owner_generations:{owner:1},verification:{generation:2,verified_by:'alice',verified_at:time,expires_at:'2026-10-17T00:00:00Z'},verification_cycle:3});
const record=(kind,data)=>({kind,id:data.id,data:{...data,created_at:time,updated_at:time},createdAt:time,updatedAt:time});
class Provider{
 constructor(records=[]){this.records=records;this.revision=7;this.requests=[];this.commits=[];this.override=undefined;this.present=true;}
 async snapshot(request){
  assert.deepEqual(request.context,context);this.requests.push(clone(request));if(request.expectedRevision!==undefined)assert.equal(request.expectedRevision,this.revision);
  const all=this.records.filter(row=>request.selection.kinds.includes(row.kind)||request.selection.ids[row.kind]?.includes(row.id)),index=request.cursor?.index??0,rows=all.slice(index,index+request.selection.pageSize);
  const list=kind=>this.records.filter(row=>row.kind===kind).map(row=>row.data);
  return {workspaceId:context.workspaceId,memberId:context.memberId,revision:this.revision,accessRevision:0,principal:clone(principal),entities:clone(rows),meta:request.selection.metaKeys.map(key=>({key,present:key===VERIFICATION_INDEX_META_KEY?this.present:key===PAGE_HEADER_META_KEY,value:key===VERIFICATION_INDEX_META_KEY?clone(this.override===undefined?projectVerificationIndex(list('database'),list('row')):this.override):key===PAGE_HEADER_META_KEY?list('page').map(projectPageHeader):null})),nextCursor:index+rows.length<all.length?{index:index+rows.length}:null};
 }
 async commit(request){this.commits.push(clone(request));return{revision:this.revision+request.changes.length};}
}
let checks=0;async function test(name,action){try{await action();checks++;}catch(error){error.message=name+': '+error.message;throw error;}}
const invalid=callback=>assert.throws(callback,error=>error.status===503);
await test('75 MiB unrelated database bodies and actual verified row ordinary text never load through default transactions',async()=>{
 const records=Array.from({length:5},(_,i)=>record('database',{id:'large-db-'+i,properties:[],body:'x'.repeat(15*1024*1024)}));
 records.push(record('database',database()),record('row',{...row(),properties:{...row().properties,body:'z'.repeat(12*1024*1024)}}));
 const negative=new Provider(records);await assert.rejects(CloudStore.open(negative,context,{kinds:['database'],pageSize:1}),error=>error instanceof StoreError&&error.status===413&&error.code==='STORAGE_LIMIT');assert.equal(negative.requests.length,5);
 const provider=new Provider(records),execute=createTransactions({provider,authorize:async()=>clone(auth)});
 const result=await execute(auth,store=>{const reader=inboxStoreReader(store);return {databases:reader.list('database'),rows:reader.list('row')};});
 assert.equal(result.value.databases.length,1);assert.equal(result.value.rows.length,1);assert.equal(result.value.rows[0].properties.body,undefined);
 assert.equal(provider.requests.length,2);assert(provider.requests.every(r=>!r.selection.kinds.some(k=>['database','row','page'].includes(k))&&!['database','row','page'].some(k=>Object.hasOwn(r.selection.ids,k))));assert.deepEqual(provider.commits[0].changes,[]);assert(Buffer.byteLength(JSON.stringify(result.value))<2048);
});
await test('75 MiB unrelated row bodies are excluded; missing stamps never enter the composite',async()=>{
 const records=[record('database',database()),...Array.from({length:5},(_,i)=>record('row',{id:'large-row-'+i,database_id:'db',properties:{body:'x'.repeat(15*1024*1024)}})),record('row',row())];
 await assert.rejects(CloudStore.open(new Provider(records),context,{kinds:['row'],pageSize:1}),error=>error.status===413);
 const provider=new Provider(records),store=await CloudStore.open(provider,context,{metaKeys:[VERIFICATION_INDEX_META_KEY]});assert.deepEqual(inboxStoreReader(store).list('row').map(r=>r.id),['row']);assert.equal(provider.requests.length,1);
});
await test('strict composite shape, missing, null, duplicates, invalid IDs and unselected fields fail closed',async()=>{
 const good=projectVerificationIndex([database()],[row()]);const bad=[null,false,{},[],{databases:[],rows:[],extra:1},{databases:[null],rows:[]},{databases:[good.databases[0],good.databases[0]],rows:[]},{databases:[{...good.databases[0],id:''}],rows:[]},{databases:[{...good.databases[0],body:'secret'}],rows:[]},{databases:good.databases,rows:[good.rows[0],good.rows[0]]},{databases:good.databases,rows:[{...good.rows[0],id:''}]},{databases:good.databases,rows:[{...good.rows[0],database_id:'unknown'}]},{databases:good.databases,rows:[{...good.rows[0],properties:{body:'secret'}}]},{databases:good.databases,rows:[{...good.rows[0],verification:{...good.rows[0].verification,secret:true}}]},{databases:good.databases,rows:[{...good.rows[0],_owner_generations:{owner:1,private:2}}]}];
 for(const value of bad){const provider=new Provider();provider.override=value;const store=await CloudStore.open(provider,context,{metaKeys:[VERIFICATION_INDEX_META_KEY]});invalid(()=>inboxStoreReader(store).list('row'));assert.equal(provider.requests.length,1);}
 const provider=new Provider();provider.present=false;const store=await CloudStore.open(provider,context,{metaKeys:[VERIFICATION_INDEX_META_KEY]});invalid(()=>store.meta(VERIFICATION_INDEX_META_KEY,{}));
 for(const mutate of [d=>d.properties.push({...d.properties[1],id:'another'}),d=>d.properties[2].owner_property_id='wrong',d=>d.properties[1].generation=null,d=>d.properties.push({id:'title',type:'text'}),d=>d.properties=null]){const db=database();mutate(db);invalid(()=>projectVerificationDatabase(db));}
});
await test('projection preserves absent, null and invalid trust evidence without laundering; prototype-looking keys are data',async()=>{
 const db=database('__proto__');db.properties[1].id='__proto__';db.properties[2].owner_property_id='__proto__';db.properties.push({id:'other-title',type:'title'});
 const r=row('__proto__','__proto__');r.properties=JSON.parse('{"__proto__":["alice"],"title":null,"other-title":"hidden","body":"secret"}');r._owner_generations=JSON.parse('{"__proto__":1,"secret":7}');r.verification={generation:null,expires_at:null,verified_by:[],secret:'omit'};
 const value=validateVerificationIndex(projectVerificationIndex([db],[r]));assert.deepEqual(value.rows[0].properties,JSON.parse('{"__proto__":["alice"],"title":null}'));assert.deepEqual(value.rows[0]._owner_generations,JSON.parse('{"__proto__":1}'));assert.equal(Object.hasOwn(value.rows[0].verification,'verified_at'),false);assert.equal(value.rows[0].verification.expires_at,null);assert.deepEqual(value.rows[0].verification.verified_by,[]);assert.equal({}.polluted,undefined);
 for(const malformed of [null,false,7,[],['x']]){const raw={...row(),_owner_generations:malformed,verification:malformed};assert.deepEqual(projectVerificationRow(raw,projectVerificationDatabase(database()))._owner_generations,malformed);assert.deepEqual(projectVerificationRow(raw,projectVerificationDatabase(database())).verification,malformed);}
 const missing=row();delete missing._owner_generations;const projected=projectVerificationRow(missing,projectVerificationDatabase(database()));assert(!Object.hasOwn(projected,'_owner_generations'));
});
await test('staged row puts, deletes and same-revision rollback branches are current; reader is immutable',async()=>{
 const provider=new Provider([record('database',database()),record('row',row()),record('row',row('second'))]),store=await CloudStore.open(provider,context,{ids:{row:['row','second']},metaKeys:[VERIFICATION_INDEX_META_KEY]});const reader=inboxStoreReader(store);assert.equal(inboxStoreReader(reader),reader);
 assert.throws(()=>store.transaction(()=>{store.put('row',{...store.get('row','row'),verification_cycle:4});assert.equal(reader.get('row','row').verification_cycle,4);throw Error('rollback');}),/rollback/);
 store.put('row',{...store.get('row','row'),verification_cycle:5});assert.equal(reader.get('row','row').verification_cycle,5);
 assert.throws(()=>store.transaction(()=>{store.delete('row','second');assert.equal(reader.get('row','second'),null);throw Error('rollback');}),/rollback/);assert(reader.get('row','second'));store.delete('row','second');assert.equal(reader.get('row','second'),null);
 const draft=row();delete draft.id;const generated=store.put('row',draft);assert(reader.get('row',generated.id));const stripped={...store.get('row','row')};delete stripped.verification;store.put('row',stripped);assert.equal(reader.get('row','row'),null);
 const copy=reader.list('row');copy[0].properties.owner.push('forged');assert.deepEqual(reader.list('row')[0].properties.owner,['alice']);for(const name of ['put','delete','set_meta','transaction','commit','allocate_id'])assert(!(name in reader));
 assert.throws(()=>store.set_meta(VERIFICATION_INDEX_META_KEY,{}),error=>error.code==='SELECTION_FORBIDDEN');await store.commit();assert.equal(provider.commits[0].changes.length,4);
});
await test('database ACL/name changes overlay; unknown schema columns refuse; database delete removes its rows',async()=>{
 const provider=new Provider([record('database',database()),record('row',row())]),store=await CloudStore.open(provider,context,{ids:{database:['db']},metaKeys:[VERIFICATION_INDEX_META_KEY]});const reader=inboxStoreReader(store);
 store.put('database',{...store.get('database','db'),name:'현재',permissions:{default:'private'}});assert.equal(reader.get('database','db').name,'현재');assert.equal(reader.get('database','db').permissions.default,'private');
 assert.throws(()=>store.transaction(()=>{const db=store.get('database','db');db.properties.push({id:'new-title',type:'title'});db.properties.unshift(db.properties.pop());store.put('database',db);invalid(()=>reader.list('row'));throw Error('rollback');}),/rollback/);assert.equal(reader.list('row').length,1);
 store.delete('database','db');assert.equal(reader.list('database').length,0);assert.equal(reader.list('row').length,0);
});
await test('assigned row ACL, page inheritance and verification member eligibility share the same body-free adapter',async()=>{
 const db=database();db.parent_id='parent';db.permissions={default:'private',inherit:true};db.row_permissions={mode:'assigned',property_id:'assignee',edit_assigned:true};db.properties.push({id:'assignee',type:'person',name:'ACL assignment'});
 const r=row();r.properties.assignee=['alice'];const records=[record('database',db),record('row',r),record('page',{id:'parent',owner_id:'bob',permissions:{default:'private',members:{alice:'edit'}}}),record('member',principal),record('member',{id:'bob',role:'member',active:true})];
 const provider=new Provider(records),execute=createTransactions({provider,authorize:async()=>clone(auth)});
 const result=await execute(auth,store=>{const reader=inboxStoreReader(store),access=new Access(reader,principal),verification=new DatabaseVerification(reader,access);const db=reader.get('database','db'),row=reader.get('row','row');assert.equal(access.can('row',row,3),true);assert.deepEqual(verification.owners(db,row),['alice']);return row;});
 assert.deepEqual(result.value.properties.assignee,['alice']);assert(provider.requests.every(r=>!r.selection.kinds.some(k=>['database','row','page'].includes(k))&&!['database','row','page'].some(k=>Object.hasOwn(r.selection.ids,k))));
 const reader=inboxStoreReader({list:kind=>kind==='database'?[db]:kind==='row'?[{...r,properties:{...r.properties,assignee:['bob']}}]:records.filter(r=>r.kind===kind).map(r=>r.data),get:(kind,id)=>records.find(r=>r.kind===kind&&r.id===id)?.data??null,meta:(key,fallback)=>fallback});assert.equal(new Access(reader,principal).can('row',reader.get('row','row')),false);
});
await test('inactive owners and removed row assignments are evaluated from fresh projections without raw fallback',async()=>{
 const db=database();db.owner_id='other';db.permissions={default:'private',members:{alice:'edit',bob:'view'}};db.row_permissions={mode:'assigned',property_id:'assignee',edit_assigned:true};db.properties.push({id:'assignee',type:'person'});
 const r=row();r.properties.owner=['alice','bob','carol'];r.properties.assignee=['alice','carol'];const records=[record('database',db),record('row',r),record('member',principal),record('member',{id:'bob',role:'member',active:true}),record('member',{id:'carol',role:'member',active:false})];
 const provider=new Provider(records),execute=createTransactions({provider,authorize:async()=>clone(auth)});const result=await execute(auth,store=>{const reader=inboxStoreReader(store),access=new Access(reader,principal),verification=new DatabaseVerification(reader,access);return verification.owners(reader.get('database','db'),reader.get('row','row'),false);});assert.deepEqual(result.value,['alice']);assert(provider.requests.every(r=>!r.selection.kinds.some(k=>['database','row'].includes(k))&&!['database','row'].some(k=>Object.hasOwn(r.selection.ids,k))));
});
await test('stable generation caches once; pending, uncertain and aborted phases cannot reuse cached authority',async()=>{
 for(const mode of ['uncertain','aborted']){const provider=new Provider([record('database',database()),record('row',row())]),store=await CloudStore.open(provider,context,{metaKeys:[VERIFICATION_INDEX_META_KEY]});const original=store.database_verification_rows.bind(store);let calls=0;store.database_verification_rows=()=>{calls++;return original();};const reader=inboxStoreReader(store);for(let i=0;i<1000;i++)reader.get('row','row');assert.equal(calls,1);
  provider.commit=async()=>{throw mode==='aborted'?new StoreError(409,'REVISION_CONFLICT','changed'):Error('network');};const committing=store.commit();assert.throws(()=>reader.get('row','row'),e=>e.code==='STORE_NOT_READABLE');assert.throws(()=>reader.get('database',null),e=>e.code==='STORE_NOT_READABLE');assert.throws(()=>reader.requestTime,e=>e.code==='STORE_NOT_READABLE');await assert.rejects(committing);assert.equal(store.state,mode);assert.throws(()=>reader.list('row'),e=>e.code==='STORE_NOT_READABLE');}
});
await test('cursor metadata remains pinned; projection change rejects before any commit',async()=>{
 const provider=new Provider([record('database',database()),record('row',row()),record('group',{id:'one'}),record('group',{id:'two'})]),store=await CloudStore.open(provider,context,{kinds:['group'],metaKeys:[VERIFICATION_INDEX_META_KEY],pageSize:1});assert.equal(inboxStoreReader(store).list('row').length,1);assert.equal(provider.requests.length,2);assert.equal(provider.requests[1].expectedRevision,7);
 const changed=new Provider(provider.records),original=changed.snapshot.bind(changed);let calls=0;changed.snapshot=async request=>{const result=await original(request);if(calls++===1)result.meta[0].value.rows[0].verification_cycle++;return result;};await assert.rejects(CloudStore.open(changed,context,{kinds:['group'],metaKeys:[VERIFICATION_INDEX_META_KEY],pageSize:1}),e=>e.code==='STORAGE_RESPONSE_INVALID');assert.equal(changed.commits.length,0);
});
await test('formal SQL migration changes only snapshot metadata; authority, limits and cursors stay byte-identical',async()=>{
 const before=readFileSync(new URL('../migrations/20261017054146_fountain_wiki_page_headers.sql',import.meta.url),'utf8').trimEnd(),after=readFileSync(new URL('../migrations/20261017063604_fountain_database_verification_index.sql',import.meta.url),'utf8').trimEnd();
 const cut=text=>text.slice(0,text.indexOf(" SELECT COALESCE(jsonb_agg(jsonb_build_object('key'"))+text.slice(text.indexOf(' total_bytes:='));assert.equal(cut(after),cut(before));assert(after.includes("e.workspace_id=ws AND e.kind='database'"));assert(after.includes("e.workspace_id=ws AND e.kind='row' AND e.data ? 'verification'"));assert(after.includes("keys.key IN ('wiki_page_headers_v1','database_verification_rows_v1')"));assert(!after.includes('GRANT '));assert(!after.includes('REVOKE '));
});
console.log(`PASS ${checks} database verification index scenarios (real CloudStore/default transactions, modeled SQL RPC; no actual SQL/Auth)`);
