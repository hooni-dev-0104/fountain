/** Real CloudStore/default transaction tests with an in-memory snapshot RPC
 * contract model. This does not claim PostgreSQL execution or real Auth. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CloudStore, StoreError} from '../functions/_shared/store.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {PAGE_HEADER_META_KEY, PAGE_HEADER_FIELDS, projectPageHeader, pageHeaderReader} from '../functions/_shared/page-headers.ts';
const clone=structuredClone,time='2026-10-16T00:00:00.000000+00:00';
const context={workspaceId:'header 空間',memberId:'local',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)};
const principal={id:'local',role:'owner',active:true};
const auth={hash:context.sessionHash,userId:context.userId,authSessionId:context.authSessionId,cacheBinding:context.cacheBinding,profile:{workspaceId:context.workspaceId,member:principal}};
const scalarSort=(a,b)=>{const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)-y[i].codePointAt(0);if(d)return d;}return x.length-y.length;};
const record=(kind,data)=>({kind,id:data.id,data:{...clone(data),created_at:time,updated_at:time},createdAt:time,updatedAt:time});
class Provider {
 constructor(pages=[]){this.records=pages.map(data=>record('page',data));this.revision=7;this.requests=[];this.commits=[];this.metaOverride=undefined;this.present=true;}
 async snapshot(request){
  assert.deepEqual(request.context,context);this.requests.push(clone(request));if(request.expectedRevision!==undefined)assert.equal(request.expectedRevision,this.revision);
  const all=this.records.filter(row=>request.selection.kinds.includes(row.kind)||request.selection.ids[row.kind]?.includes(row.id));
  const index=request.cursor?.index??0,rows=all.slice(index,index+request.selection.pageSize);
  return {workspaceId:context.workspaceId,memberId:context.memberId,revision:this.revision,accessRevision:0,principal:clone(principal),entities:clone(rows),meta:request.selection.metaKeys.map(key=>({key,present:key===PAGE_HEADER_META_KEY?this.present:false,value:key===PAGE_HEADER_META_KEY?clone(this.metaOverride===undefined?this.records.filter(row=>row.kind==='page').sort((a,b)=>scalarSort(a.id,b.id)).map(row=>projectPageHeader(row.data)):this.metaOverride):null})),nextCursor:index+rows.length<all.length?{index:index+rows.length}:null};
 }
 async commit(request){assert.deepEqual(request.context,context);assert.equal(request.expectedRevision,this.revision);assert(request.changes.length<=1000);this.commits.push(clone(request));return{revision:this.revision+request.changes.length};}
}
let checks=0;
async function test(name,action){try{await action();checks++;}catch(error){error.message=name+': '+error.message;throw error;}}
const invalid=callback=>assert.throws(callback,error=>error.status===503);
await test('75 MiB bodies exceed original kernel limit, metadata stays small through actual default transactions',async()=>{
 const pages=Array.from({length:5},(_,index)=>({id:'large-'+index,title:'문서 '+index,blocks:[{id:'block',text:'x'.repeat(15*1024*1024)}],cover:'private cover',secret:'private unknown'}));
 const negative=new Provider(pages);
 await assert.rejects(CloudStore.open(negative,context,{kinds:['page'],pageSize:1}),error=>error instanceof StoreError&&error.code==='STORAGE_LIMIT'&&error.status===413);
 assert.equal(negative.requests.length,5,'negative control reaches the unchanged aggregate 64 MiB limit across five individually valid snapshots');
 const provider=new Provider(pages),execute=createTransactions({provider,authorize:async()=>clone(auth)});
 const result=await execute(auth,store=>{const reader=pageHeaderReader(store);assert.equal(reader.get('page','large-3').title,'문서 3');return reader.list('page');});
 assert.equal(result.value.length,5);assert(result.value.every(page=>!Object.hasOwn(page,'blocks')&&!Object.hasOwn(page,'cover')&&!Object.hasOwn(page,'secret')));
 assert(provider.requests.every(request=>!request.selection.kinds.includes('page')&&!Object.hasOwn(request.selection.ids,'page')));
 assert.equal(provider.requests.length,2);assert.equal(provider.commits.length,1);assert.deepEqual(provider.commits[0].changes,[]);
 assert(Buffer.byteLength(JSON.stringify(result.value))<4096);
});
await test('staged put/delete and alternate same-revision rollback branches are current',async()=>{
 const provider=new Provider([{id:'one',title:'원본',icon:null},{id:'two',title:'둘'}]);
 const store=await CloudStore.open(provider,context,{ids:{page:['one','two']},metaKeys:[PAGE_HEADER_META_KEY]});const reader=pageHeaderReader(store);
 assert.equal(reader.get('page','one').title,'원본');
 assert.throws(()=>store.transaction(()=>{store.put('page',{...store.get('page','one'),title:'임시',blocks:['must omit']});assert.equal(reader.get('page','one').title,'임시');throw Error('rollback');}),/rollback/);
 store.put('page',{...store.get('page','one'),title:'현재',blocks:['must omit']});assert.equal(reader.get('page','one').title,'현재');
 assert.throws(()=>store.transaction(()=>{store.delete('page','two');assert.equal(reader.get('page','two'),null);throw Error('rollback');}),/rollback/);
 assert.equal(reader.get('page','two').title,'둘');const revisionBeforeFailure=store.revision,generationBeforeFailure=store.page_header_generation;const cyclic={id:'one'};cyclic.self=cyclic;assert.throws(()=>store.put('page',cyclic));assert.equal(store.revision,revisionBeforeFailure);assert.equal(store.page_header_generation,generationBeforeFailure);assert.equal(reader.get('page','one').title,'현재');store.delete('page','two');assert.equal(reader.get('page','two'),null);
 const generated=store.put('page',{title:'신규',blocks:['omitted']});assert.equal(reader.get('page',generated.id).title,'신규');
 const copy=store.meta(PAGE_HEADER_META_KEY);copy[0].title='mutated';assert.equal(reader.get('page','one').title,'현재');
 assert.throws(()=>store.set_meta(PAGE_HEADER_META_KEY,[]),error=>error.code==='SELECTION_FORBIDDEN');
 await store.commit();assert.equal(provider.commits[0].changes.length,3);
});
await test('missing/null/nonarray metadata and invalid IDs/extra fields fail closed without full page fallback',async()=>{
 for(const value of [null,{},false,[null],[{}],[{id:''}],[{id:'a',blocks:[]}],[{id:'a'},{id:'a'}]]){
  const provider=new Provider([{id:'a'}]);provider.metaOverride=value;const store=await CloudStore.open(provider,context,{metaKeys:[PAGE_HEADER_META_KEY]});invalid(()=>pageHeaderReader(store).list('page'));
  assert.equal(provider.requests.length,1);assert.equal(provider.requests[0].selection.kinds.length,0);
 }
 const missing=new Provider([{id:'a'}]);missing.present=false;const store=await CloudStore.open(missing,context,{metaKeys:[PAGE_HEADER_META_KEY]});invalid(()=>store.meta(PAGE_HEADER_META_KEY,[]));
});
await test('header projection preserves absent/null Unicode and prototype-looking IDs; reader has no mutation methods',async()=>{
 assert.equal(PAGE_HEADER_FIELDS.length,16);
 const provider=new Provider([{id:'__proto__',title:'가족 😀',parent_id:null},{id:'\u{10000}',title:null},{id:'\uE000'}]);
 const store=await CloudStore.open(provider,context,{metaKeys:[PAGE_HEADER_META_KEY]});const reader=pageHeaderReader(store);
 assert.deepEqual(reader.list('page').map(page=>page.id),['__proto__','\uE000','\u{10000}']);assert.equal(reader.get('page','__proto__').parent_id,null);
 assert.equal(Object.hasOwn(reader.get('page','\uE000'),'title'),false);assert.equal(reader.get('page','\u{10000}').title,null);
 for(const method of ['put','delete','set_meta','transaction','commit','allocate_id'])assert.equal(method in reader,false);
 assert.equal(reader.get('page',null),null);assert.equal(reader.get('page','missing'),null);
 const raw={list:kind=>kind==='page'?[{id:'local',title:'local',blocks:['private']}]:[{id:'member'}],get:(kind,id)=>({kind,id}),meta:(key,fallback)=>key==='test'?7:fallback};
 const local=pageHeaderReader(raw),twice=pageHeaderReader(local);assert.deepEqual(twice.list('page'),[{id:'local',title:'local'}]);assert.deepEqual(local.get('member','x'),{kind:'member',id:'x'});assert.equal(local.meta('test'),7);
});
await test('repeated cursor metadata must stay stable and remains authority/revision pinned',async()=>{
 const provider=new Provider([{id:'a'},{id:'b'}]);provider.records.push(record('group',{id:'g1'}),record('group',{id:'g2'}));
 const store=await CloudStore.open(provider,context,{kinds:['group'],metaKeys:[PAGE_HEADER_META_KEY],pageSize:1});assert.equal(store.page_headers().length,2);assert.equal(provider.requests.length,2);assert.equal(provider.requests[1].expectedRevision,7);
 const changed=new Provider([{id:'a'}]);changed.records.push(record('group',{id:'g1'}),record('group',{id:'g2'}));const snapshot=changed.snapshot.bind(changed);let count=0;changed.snapshot=async request=>{const result=await snapshot(request);if(count++===1)result.meta[0].value[0].title='different';return result;};
 await assert.rejects(CloudStore.open(changed,context,{kinds:['group'],metaKeys:[PAGE_HEADER_META_KEY],pageSize:1}),error=>error.code==='STORAGE_RESPONSE_INVALID');
});
await test('1000 repeated gets build one header map per stable generation, with no global cross-store cache',async()=>{
 const pages=Array.from({length:1000},(_,index)=>({id:'page-'+index,title:'Title '+index,parent_id:index?'page-'+(index-1):null,permissions:{default:'workspace',members:{},groups:{},inherit:true},verification:{owners:['local'],expires_at:null}}));
 const provider=new Provider(pages),store=await CloudStore.open(provider,context,{metaKeys:[PAGE_HEADER_META_KEY]});
 const base=store.page_headers.bind(store);let projections=0;store.page_headers=()=>{projections++;return base();};
 const reader=pageHeaderReader(store);assert.equal(pageHeaderReader(reader),reader);
 const started=performance.now();for(let index=0;index<1000;index++)assert.equal(reader.get('page','page-'+index).title,'Title '+index);
 const elapsed=performance.now()-started;assert.equal(projections,1);
 const copy=reader.get('page','page-0');copy.permissions.default='private';assert.equal(reader.get('page','page-0').permissions.default,'workspace');const listed=reader.list('page');listed[0].permissions.default='private';listed.pop();assert.equal(reader.list('page').length,1000);assert.equal(reader.get('page','page-0').permissions.default,'workspace');
 const otherProvider=new Provider([{id:'page-0',title:'Other workspace snapshot'}]),otherStore=await CloudStore.open(otherProvider,context,{metaKeys:[PAGE_HEADER_META_KEY]});assert.equal(otherStore.page_header_generation,store.page_header_generation);
 assert.equal(pageHeaderReader(otherStore).get('page','page-0').title,'Other workspace snapshot');
 const generation=store.page_header_generation;assert.throws(()=>store.transaction(()=>{throw Error('rollback without writes');}),/rollback without writes/);assert(store.page_header_generation>generation);reader.get('page','page-0');assert.equal(projections,2);
 console.log(JSON.stringify({pageHeaderBenchmark:{headers:1000,gets:1000,elapsedMs:Math.round(elapsed*100)/100,initialHeaderMaps:1,cache:'Store-local monotonic generation; no global authority state'}}));
});
await test('cached headers cannot bypass pending, uncertain or aborted kernel read guards',async()=>{
 for(const failure of ['uncertain','aborted']){
  const provider=new Provider([{id:'a',title:'cached'}]),store=await CloudStore.open(provider,context,{metaKeys:[PAGE_HEADER_META_KEY]});const reader=pageHeaderReader(store);reader.get('page','a');
  provider.commit=async()=>{throw failure==='aborted'?new StoreError(409,'REVISION_CONFLICT','changed'):Error('network unavailable');};
  const committing=store.commit();assert.equal(store.state,'pending');assert.throws(()=>reader.get('page','a'),error=>error.code==='STORE_NOT_READABLE');assert.throws(()=>reader.list('page'),error=>error.code==='STORE_NOT_READABLE');assert.throws(()=>reader.get('page',null),error=>error.code==='STORE_NOT_READABLE');
  await assert.rejects(committing);assert.equal(store.state,failure);assert.throws(()=>reader.get('page','a'),error=>error.code==='STORE_NOT_READABLE');
 }
});
await test('selection replay cannot inherit changed session authority',async()=>{
 const provider=new Provider([{id:'a'}]);let authorizations=0;
 const execute=createTransactions({provider,authorize:async()=>{const current=clone(auth);if(authorizations++>0)current.cacheBinding='d'.repeat(32);return current;}});
 await assert.rejects(execute(auth,store=>pageHeaderReader(store).list('page')),error=>error.status===401);
 assert.equal(provider.requests.length,1);assert.equal(provider.commits.length,0);
});
await test('formal SQL migration changes only reserved metadata projection, preserving budgets, cursor and authority',async()=>{
 const source=readFileSync(new URL('../migrations/20261016143508_fountain_cloud_service_authority.sql',import.meta.url),'utf8');const start=source.indexOf('CREATE FUNCTION fountain_cloud.store_snapshot_locked('),end=source.indexOf('\nREVOKE ALL ON FUNCTION fountain_cloud.store_snapshot_locked',start);
 const original=source.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'),proposal=readFileSync(new URL('../migrations/20261017054146_fountain_wiki_page_headers.sql',import.meta.url),'utf8').trimEnd();
 const cut=text=>text.slice(0,text.indexOf(' SELECT COALESCE(jsonb_agg(jsonb_build_object(\'key\''))+text.slice(text.indexOf(' total_bytes:='));assert.equal(cut(proposal),cut(original));
 assert(proposal.includes("e.data->'id' IS DISTINCT FROM to_jsonb(e.id)"));assert(proposal.includes("THEN 'null'::jsonb"));
 assert(proposal.includes("ORDER BY e.id COLLATE \"C\""));for(const field of PAGE_HEADER_FIELDS)assert(proposal.includes("'"+field+"'"));
});
console.log(`PASS ${checks} page header kernel scenarios (real CloudStore/default transactions, modeled RPC, no actual SQL/Auth)`);
