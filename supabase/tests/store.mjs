/** CloudStore pure kernel + Fetch/Response RPC transport fixtures.
 * MemoryProvider models a SQL transaction; it is NOT actual PostgreSQL evidence.
 * Deployed SQL is checked structurally here; real PostgreSQL evidence is separate.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CloudStore,MissingSelection,StoreError,canonicalJSON,createStoreProvider,mergeSelection,normalizeSelection} from '../functions/_shared/store.ts';
import {Access} from '../functions/_shared/access.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
const clone=structuredClone,sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
const context=Object.freeze({workspaceId:'fixture 空間',memberId:'alice',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)});
const second=Object.freeze({...context,memberId:'bob',userId:'33333333-3333-4333-8333-333333333333',authSessionId:'44444444-4444-4444-8444-444444444444',sessionHash:'c'.repeat(64),cacheBinding:'d'.repeat(32)});
const fixedTime='2026-10-16T00:00:00.123000+00:00', options={clock:()=>Date.parse('2026-10-16T00:00:00.123Z')};
const error=(code,status=409)=>new StoreError(status,code,'Model typed error');
const key=(kind,id)=>JSON.stringify([kind,id]);
class MemoryProvider {
  constructor(){
    this.records=new Map();this.metadata=new Map([['workspace_id',context.workspaceId],['settings',{name:'가족'}],['seeded',true],['access_revision',2],['null-value',null],['literal-missing',{$fountainMissing:true}]]);
    this.revision=7;this.receipts=new Map();this.requests=[];this.snapshotRequests=[];this.active=new Map([[context.sessionHash,clone(context)],[second.sessionHash,clone(second)]]);this.failAfterAck=false;this.corruptAck=false;this.beforeCommit=null;this.failAt=-1;
    this.seed('member',{id:'alice',name:'가족',email:'alice@test.test',role:'member',active:true});
    this.seed('member',{id:'bob',name:'가족2',email:'bob@test.test',role:'member',active:true});
    this.seed('group',{id:'family',members:['alice']});this.seed('teamspace',{id:'general',visibility:'open'});
    this.seed('page',{id:'__proto__',title:'한글 😀',permissions:{default:'private',members:JSON.parse('{"alice":"edit","__proto__":"view"}')}});
    this.seed('page',{id:'가족 문서?#%',title:'두 번째',parent_id:'__proto__'});this.seed('page',{id:'third',title:'세 번째'});
    this.seed('credential',{id:'alice',password_hash:'MUST_NOT_READ'});this.seed('session',{id:'legacy',token:'MUST_NOT_READ'});
    this.seed('attachment',{id:'inline',owner_id:'alice',size:3,data:'PRIVATE_BYTES'});
  }
  seed(kind,value){const data={...clone(value),created_at:fixedTime,updated_at:fixedTime};this.records.set(key(kind,data.id),{kind,id:data.id,data,createdAt:fixedTime,updatedAt:fixedTime});}
  authorize(ctx){
    const grant=this.active.get(ctx.sessionHash),member=this.records.get(key('member',ctx.memberId));
    if(!grant||canonicalJSON(grant)!==canonicalJSON(ctx)||!member||member.data.active!==true||!['owner','admin','member','guest'].includes(member.data.role))throw error('AUTH_REQUIRED',401);
    const {id,name,email,role,active}=member.data;return {id,name,email,role,active};
  }
  async snapshot(request){
    this.snapshotRequests.push(clone(request));const principal=this.authorize(request.context);
    if(request.expectedRevision!==undefined&&request.expectedRevision!==this.revision)throw error('REVISION_CONFLICT');
    const selected=normalizeSelection(request.selection),scope=await sha(canonicalJSON([request.context,selected,this.revision]));
    if(request.cursor&&(request.cursor.scope!==scope||request.cursor.revision!==this.revision))throw error('CURSOR_SCOPE');
    const all=Array.from(this.records.values()).filter(record=>selected.kinds.includes(record.kind)||(Object.hasOwn(selected.ids,record.kind)&&selected.ids[record.kind].includes(record.id))).sort((a,b)=>a.kind.localeCompare(b.kind)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const index=request.cursor?.index||0,rows=clone(all.slice(index,index+selected.pageSize));
    for(const row of rows)if(row.kind==='attachment')delete row.data.data;
    return {workspaceId:request.context.workspaceId,memberId:request.context.memberId,revision:this.revision,accessRevision:this.metadata.get('access_revision')||0,principal,entities:rows,meta:selected.metaKeys.map(key=>({key,present:this.metadata.has(key),value:this.metadata.has(key)?clone(this.metadata.get(key)):null})),nextCursor:index+rows.length<all.length?{index:index+rows.length,scope,revision:this.revision}:null};
  }
  async commit(request){
    this.requests.push(clone(request));if(this.beforeCommit)await this.beforeCommit();
    this.authorize(request.context);
    assert.equal(await sha(request.canonical),request.digest);assert.deepEqual(JSON.parse(request.canonical),{context:request.context,expectedRevision:request.expectedRevision,changes:request.changes});
    const receiptKey=JSON.stringify([request.context.workspaceId,request.context.memberId,request.context.sessionHash,request.transactionId]),prior=this.receipts.get(receiptKey);
    if(prior){if(prior.digest!==request.digest)throw error('COMMIT_ID_REUSED');return {revision:prior.revision};}
    if(request.expectedRevision!==this.revision)throw error('REVISION_CONFLICT');
    const records=clone(this.records),metadata=clone(this.metadata);let steps=0,index=0;
    for(const change of request.changes){
      if(index++===this.failAt)throw error('INJECTED_SQL_FAILURE',503);
      if(change.op==='put'){
        const previous=records.get(key(change.kind,change.id));
        if((previous?.createdAt??null)!==change.previousCreatedAt)throw error('REVISION_CONFLICT');
        records.set(key(change.kind,change.id),{kind:change.kind,id:change.id,data:clone(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});steps++;
      }else if(change.op==='delete'){if(records.delete(key(change.kind,change.id)))steps++;}
      else{metadata.set(change.key,clone(change.value));steps++;}
    }
    this.records=records;this.metadata=metadata;this.revision+=steps;this.receipts.set(receiptKey,{digest:request.digest,revision:this.revision});
    if(this.failAfterAck){this.failAfterAck=false;throw new Error('SECRET SQL/password/network acknowledgement dropped');}
    if(this.corruptAck){this.corruptAck=false;return {revision:this.revision+1};}
    return {revision:this.revision};
  }
}
let checks=0;
async function test(name,action){try{await action();checks++;}catch(error){error.message=name+': '+error.message;throw error;}}
const expectCode=(callback,code)=>assert.throws(callback,error=>error instanceof StoreError&&error.code===code);
const rejected=(promise,code)=>assert.rejects(promise,error=>error instanceof StoreError&&error.code===code);
const selection={kinds:['page','member','group','teamspace'],metaKeys:['settings','seeded','null-value','literal-missing','absent'],pageSize:2};
await test('paged pinned snapshots are explicit, safe, and isolated copies',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);
 assert(provider.snapshotRequests.length>1);for(const request of provider.snapshotRequests.slice(1))assert.equal(request.expectedRevision,7);
 assert.equal(store.get('page',null),null);assert.equal(store.get('page',{}),null);assert.equal(store.get('page','__proto__').title,'한글 😀');
 assert.equal(store.meta('absent','fallback'),'fallback');assert.equal(store.meta('null-value','fallback'),null);assert.deepEqual(store.meta('literal-missing'),{$fountainMissing:true});
 const copy=store.get('page','__proto__');copy.title='mutated';assert.equal(store.get('page','__proto__').title,'한글 😀');
 assert.throws(()=>store.selection.kinds.push('credential'),TypeError);assert.throws(()=>{store.principal.role='owner';},TypeError);
 assert.equal(store.revision,7);assert.equal(store.meta('_entity_revision'),7);assert.equal(store.meta('workspace_id'),context.workspaceId);assert.equal(store.meta('access_revision'),2);
 assert.equal(provider.snapshotRequests[0].selection.kinds.includes('credential'),false);
});
await test('MissingSelection distinguishes absent IDs, partial list and missing meta',async()=>{
 const store=await CloudStore.open(new MemoryProvider(),context,{ids:{page:['missing','__proto__']}},options);
 assert.equal(store.get('page','missing'),null);
 for(const [callback,expected]of [[()=>store.list('page'),{kinds:['page']}],[()=>store.get('page','third'),{ids:{page:['third']}}],[()=>store.meta('settings'),{metaKeys:['settings']}]])assert.throws(callback,error=>error instanceof MissingSelection&&canonicalJSON(error.selection)===canonicalJSON(expected));
 expectCode(()=>store.get('credential','alice'),'SELECTION_FORBIDDEN');
 assert.deepEqual(mergeSelection({ids:JSON.parse('{"page":["__proto__"]}'),metaKeys:['settings']},{kinds:['page'],ids:{row:['가족']}}),{kinds:['page'],ids:{row:['가족']},metaKeys:['settings'],pageSize:200});
});
await test('permission projection uses pinned data and fails closed until expanded',async()=>{
 const provider=new MemoryProvider();let selected={ids:{page:['__proto__']}};
 const partial=await CloudStore.open(provider,context,selected,options);assert.throws(()=>new Access(partial,partial.principal),MissingSelection);
 selected=mergeSelection(selected,{kinds:['group','member','page','teamspace']});const full=await CloudStore.open(provider,context,selected,options);
 const access=new Access(full,full.principal);assert.equal(access.level('page',full.get('page','__proto__')),3);
 const projected=new Authorization(access).project('/api/workspace',{pages:full.list('page'),databases:[],teamspaces:full.list('teamspace'),members:full.list('member')});
 assert.equal(projected.pages.find(page=>page.id==='__proto__').access_level,3);assert.equal(provider.revision,7);
});
await test('changed revision between pages never returns a mixed store',async()=>{
 const provider=new MemoryProvider(),base=provider.snapshot.bind(provider);let calls=0;
 provider.snapshot=async request=>{if(calls++===1)provider.revision++;return base(request);};
 await rejected(CloudStore.open(provider,context,selection,options),'REVISION_CONFLICT');
});
await test('cross workspace/member/session/cursor response is rejected',async()=>{
 for(const field of ['workspaceId','memberId']){
  const provider=new MemoryProvider(),base=provider.snapshot.bind(provider);provider.snapshot=async request=>({...await base(request),[field]:'other'});
  await rejected(CloudStore.open(provider,context,selection,options),'STORAGE_RESPONSE_INVALID');
 }
 for(const mutated of [{...context,workspaceId:'other'},{...context,memberId:'bob'},{...context,cacheBinding:'e'.repeat(32)},{...context,authSessionId:second.authSessionId}])await rejected(CloudStore.open(new MemoryProvider(),mutated,selection,options),'AUTH_REQUIRED');
});
await test('staged puts/meta and deletes count exactly like Python, clock is fixed',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,{...options,idFactory:()=> 'new-id'});
 const old=store.get('page','__proto__');old.created_at='forged';old.updated_at='forged';store.put('page',old);
 const created=store.put('row',{name:'새 행'});assert.equal(created.id,'new-id');assert.equal(created.created_at,fixedTime);assert.equal(created.updated_at,fixedTime);
 store.set_meta('settings',{name:'변경'});store.delete('page','missing');store.delete('page','third');store.delete('page','third');
 assert.equal(store.revision,11);assert.equal(provider.revision,7);assert.equal(store.get('page','__proto__').created_at,fixedTime);
 assert.deepEqual(await store.commit(),{revision:11});assert.equal(provider.revision,11);assert.equal(provider.requests[0].changes.length,4);assert.equal(provider.receipts.size,1);
 assert.deepEqual(await store.commit(),{revision:11});assert.equal(provider.requests.length,1);expectCode(()=>store.put('page',{id:'third'}),'STORE_CLOSED');
});
await test('generated IDs remain known absent after delete and empty commits are authenticated',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,{}, {...options,idFactory:()=> 'generated'});
 store.put('audit',{action:'fixture',details:{}});store.delete('audit','generated');store.delete('audit','generated');
 assert.equal(store.get('audit','generated'),null);assert.equal(store.revision,9);await store.commit();assert.equal(provider.revision,9);
 const read=await CloudStore.open(provider,context,{},options);await read.commit();assert.equal(provider.revision,9);assert.equal(provider.receipts.size,2);
 assert.equal(read.get('page',''),null);assert.equal(read.get('page','x'.repeat(161)),null);
});
await test('nested savepoint rollback preserves earlier stage and rolls back counters',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);
 store.transaction(()=>{store.put('page',{id:'third',title:'kept'});assert.throws(()=>store.transaction(()=>{store.delete('page','__proto__');store.set_meta('settings',{bad:true});throw Error('rollback');}));});
 assert.equal(store.get('page','third').title,'kept');assert(store.get('page','__proto__'));assert.equal(store.revision,8);assert.deepEqual(store.meta('settings'),{name:'가족'});
 assert.throws(()=>store.transaction(()=>{store.put('page',{id:'third',title:'discarded'});throw Error('outer');}));assert.equal(store.get('page','third').title,'kept');assert.equal(store.revision,8);
 await store.commit();assert.equal(provider.revision,8);
});
await test('async transaction callback is rejected and staged state rolled back',async()=>{
 const store=await CloudStore.open(new MemoryProvider(),context,selection,options);
 let late;const pending=new Promise(resolve=>{late=resolve;});
 expectCode(()=>store.transaction(async()=>{store.put('page',{id:'third',title:'discard'});await pending;store.put('page',{id:'third',title:'late write'});}),'ASYNC_TRANSACTION_FORBIDDEN');
 assert.equal(store.state,'aborted');late();await new Promise(resolve=>setTimeout(resolve,0));expectCode(()=>store.get('page','third'),'STORE_NOT_READABLE');
});
await test('two independent transactions CAS, loser must reopen and reauthorize',async()=>{
 const provider=new MemoryProvider(),a=await CloudStore.open(provider,context,selection,options),b=await CloudStore.open(provider,second,selection,options);
 a.put('page',{id:'third',title:'A'});b.put('page',{id:'third',title:'B'});await a.commit();await rejected(b.commit(),'REVISION_CONFLICT');assert.equal(b.state,'aborted');expectCode(()=>b.get('page','third'),'STORE_NOT_READABLE');
 const fresh=await CloudStore.open(provider,second,selection,options);assert.equal(fresh.get('page','third').title,'A');fresh.put('page',{id:'third',title:'B fresh'});await fresh.commit();assert.equal(provider.revision,9);
});
await test('live actor/session revocation gates writes and receipt replay',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);store.put('page',{id:'third',title:'committed'});provider.failAfterAck=true;
 await rejected(store.commit(),'COMMIT_UNCERTAIN');provider.active.delete(context.sessionHash);await rejected(store.commit(),'AUTH_REQUIRED');assert.equal(provider.revision,8);assert.equal(provider.receipts.size,1);assert.equal(store.state,'uncertain');
 const other=new MemoryProvider(),pending=await CloudStore.open(other,context,selection,options);pending.put('page',{id:'third'});other.records.get(key('member','alice')).data.active=false;await rejected(pending.commit(),'AUTH_REQUIRED');assert.equal(other.revision,7);assert.equal(other.receipts.size,0);
});
await test('lost ACK freezes reads/writes and exact retry does not rerun changes',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);store.put('page',{id:'third',title:'once'});provider.failAfterAck=true;
 await rejected(store.commit(),'COMMIT_UNCERTAIN');expectCode(()=>store.get('page','third'),'STORE_NOT_READABLE');expectCode(()=>store.set_meta('settings',{}),'STORE_NOT_READABLE');
 const other=await CloudStore.open(provider,second,selection,options);other.put('page',{id:'third',title:'remote after accepted'});await other.commit();assert.equal(provider.revision,9);
 assert.deepEqual(await store.commit(),{revision:8});assert.deepEqual(provider.requests[0],provider.requests[2]);assert.equal(provider.records.get(key('page','third')).data.title,'remote after accepted');assert.equal(provider.receipts.size,2);
});
await test('pending concurrent commit shares one immutable transaction',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);store.put('page',{id:'third'});
 let release;provider.beforeCommit=()=>new Promise(resolve=>{release=resolve;});const first=store.commit(),secondCall=store.commit();
 while(!release)await new Promise(resolve=>setTimeout(resolve,0));expectCode(()=>store.list('page'),'STORE_NOT_READABLE');release();assert.deepEqual(await first,await secondCall);assert.equal(provider.requests.length,1);
});
await test('malformed ACK remains unresolved and can exact-retry',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);store.put('page',{id:'third'});provider.corruptAck=true;
 await rejected(store.commit(),'STORAGE_RESPONSE_INVALID');assert.equal(store.state,'uncertain');await store.commit();assert.equal(provider.revision,8);assert.deepEqual(provider.requests[0],provider.requests[1]);
});
await test('receipt cannot be borrowed by another actor/session and digest reuse is rejected',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);store.put('page',{id:'third'});await store.commit();
 const request=clone(provider.requests[0]);request.changes[0].data.title='forged';request.canonical=canonicalJSON({context:request.context,expectedRevision:request.expectedRevision,changes:request.changes});request.digest=await sha(request.canonical);await rejected(provider.commit(request),'COMMIT_ID_REUSED');
 request.context=second;request.canonical=canonicalJSON({context:request.context,expectedRevision:request.expectedRevision,changes:request.changes});request.digest=await sha(request.canonical);await rejected(provider.commit(request),'REVISION_CONFLICT');assert.equal(provider.revision,8);
});
await test('server transaction failure has no partial data/revision/receipt',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);store.put('page',{id:'third',title:'one'});store.set_meta('settings',{name:'two'});provider.failAt=1;
 await rejected(store.commit(),'INJECTED_SQL_FAILURE');assert.equal(provider.records.get(key('page','third')).data.title,'세 번째');assert.equal(provider.revision,7);assert.equal(provider.receipts.size,0);
 provider.failAt=-1;await store.commit();assert.equal(provider.revision,9);assert.equal(provider.receipts.size,1);
});
await test('missing fields, duplicates, byte payloads, response bounds do not hydrate',async()=>{
 for(const mutate of [page=>{delete page.revision;},page=>{page.entities.push(page.entities[0]);},page=>{page.principal.active=1;},page=>{page.meta[0].key='local_cache_binding';},page=>{page.entities[0].data.id='other';}]){
  const provider=new MemoryProvider(),base=provider.snapshot.bind(provider);provider.snapshot=async request=>{const page=await base(request);mutate(page);return page;};await rejected(CloudStore.open(provider,context,{...selection,pageSize:500},options),'STORAGE_RESPONSE_INVALID');
 }
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,{ids:{attachment:['inline']}},options);assert.equal(store.get('attachment','inline').data,undefined);
 const base=provider.snapshot.bind(provider);provider.snapshot=async request=>{const page=await base(request);page.entities[0].data.data='PRIVATE';return page;};await rejected(CloudStore.open(provider,context,{ids:{attachment:['inline']}},options),'STORAGE_RESPONSE_INVALID');
});
for(const [name,invalid] of [
 ['NUL string value',{id:'third',nested:{text:'\u0000'}}],
 ['NUL object key',{id:'third',nested:Object.fromEntries([['\u0000','x']])}],
 ['lone surrogate object key',{id:'third',nested:Object.fromEntries([['\ud800','x']])}]
]) await test('JSONB rejects '+name+' before staging',async()=>{
 const provider=new MemoryProvider(),store=await CloudStore.open(provider,context,selection,options);
 const original=store.get('page','third'),records=clone(provider.records),metadata=clone(provider.metadata);
 expectCode(()=>store.put('page',invalid),'INVALID_STORE_INPUT');
 assert.equal(store.revision,7);assert.equal(store.state,'ready');assert.deepEqual(store.get('page','third'),original);
 assert.deepEqual(provider.records,records);assert.deepEqual(provider.metadata,metadata);
 await store.commit();assert.deepEqual(provider.requests[0].changes,[]);assert.equal(provider.revision,7);
});
await test('bounds and invalid JSON preserve staged records and counters',async()=>{
 const store=await CloudStore.open(new MemoryProvider(),context,selection,options),before=store.get('page','third');
 for(const data of [{id:'third',value:Number.MAX_SAFE_INTEGER+1},{id:'third',value:NaN},{id:'third',value:undefined},{id:'third',value:1n},{id:'third',value:new Uint8Array(3)},{id:'third',text:'\ud800'}])assert.throws(()=>store.put('page',data),StoreError);
 const cycle={id:'third'};cycle.self=cycle;assert.throws(()=>store.put('page',cycle),StoreError);
 expectCode(()=>store.put('page',{id:'third',text:'x'.repeat(16*1024*1024)}),'STORAGE_LIMIT');assert.equal(store.revision,7);assert.deepEqual(store.get('page','third'),before);
 expectCode(()=>normalizeSelection({ids:{page:Array.from({length:1001},(_,index)=>String(index))}}),'STORAGE_LIMIT');
 expectCode(()=>store.set_meta('_entity_revision',0),'SELECTION_FORBIDDEN');expectCode(()=>store.set_meta('workspace_id','other'),'SELECTION_FORBIDDEN');
 const shared={text:'valid shared reference'};store.put('page',{id:'third',a:shared,b:shared});assert.equal(store.revision,8);
});
await test('RPC transport scopes requests and sanitizes errors/redirects without leaking keys',async()=>{
 const calls=[],secret='sb_secret_FIXTURE_SECRET_not_real';let response=()=>new Response(JSON.stringify({revision:4}));
 const provider=createStoreProvider({supabaseUrl:'https://fixture.invalid',serviceKey:secret,fetch:async(url,init)=>{calls.push({url,init});return response();}});
 assert.deepEqual(await provider.commit({context,expectedRevision:3,transactionId:crypto.randomUUID(),digest:'a'.repeat(64),canonical:'{}',changes:[]}),{revision:4});
 const sent=JSON.parse(calls[0].init.body);assert.deepEqual(sent.p_context,context);assert.equal(calls[0].init.headers.apikey,secret);assert.equal(calls[0].init.headers.Authorization,undefined);assert.equal(calls[0].init.redirect,'error');
 response=()=>new Response('SECRET provider SQL password',{status:500});await assert.rejects(provider.snapshot({context,selection:normalizeSelection({})}),error=>error instanceof StoreError&&!error.message.includes('SECRET'));
 response=()=>new Response('{}',{status:403});await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'AUTH_REQUIRED');
 response=()=>new Response('{"code":"PT409","message":"REVISION_CONFLICT"}',{status:409});await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'REVISION_CONFLICT');
 response=()=>new Response('{"code":"PT409","message":"COMMIT_ID_REUSED"}',{status:409});await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'COMMIT_ID_REUSED');
 response=()=>new Response('{"code":"PT409","message":"LAST_OWNER_ACCOUNT"}',{status:409});await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'LAST_OWNER_ACCOUNT');
 response=()=>new Response('{"code":"PT409","message":"SECRET provider SQL"}',{status:409});await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'STORAGE_CONFLICT');
 response=()=>new Response('{bad');await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'STORAGE_UNAVAILABLE');
 response=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(16*1024*1024+1));controller.close();}}));await rejected(provider.snapshot({context,selection:normalizeSelection({})}),'STORAGE_LIMIT');
});
await test('SQL migration has service-only wrappers, live auth, CAS receipts and no legacy grants',async()=>{
 const sql=readFileSync(new URL('../migrations/20261016100057_fountain_cloud_atomic_store.sql',import.meta.url),'utf8');
 for(const name of ['snapshot','commit']){assert(sql.includes('CREATE FUNCTION public.fountain_cloud_store_'+name));assert(new RegExp('REVOKE ALL ON FUNCTION public.fountain_cloud_store_'+name+'[^;]+FROM PUBLIC,anon,authenticated;').test(sql));}
 assert(sql.includes('fountain_cloud.resolve_profile'));assert(sql.includes('FOR SHARE OF v,s,u,m,e'));assert(sql.includes('fountain_cloud.session_vault'));
 assert(sql.indexOf('PERFORM fountain_cloud.store_context(p_context);ws:=')<sql.indexOf('SELECT * INTO recorded'));assert(sql.includes("RAISE EXCEPTION 'COMMIT_ID_REUSED'"));assert(sql.includes("revision<>p_expected_revision"));
 assert(!/GRANT[^;]+fountain_private/i.test(sql));assert(!/\bEXECUTE\s+(?:format|p_|query|sql)/i.test(sql));assert(sql.includes('SET search_path=pg_catalog'));assert(!sql.includes('attachment_chunks'));
});
await test('reserved identifiers support related writes without expanding selections',async()=>{
 const provider=new MemoryProvider(),ids=['related-page','related-comment'];
 const store=await CloudStore.open(provider,context,{}, {...options,idFactory:()=>ids.shift()});
 const page=store.allocate_id('page'),comment=store.allocate_id('comment');
 assert.equal(store.get('page',page),null);
 store.put('page',{id:page,title:'가족 문서'});store.put('comment',{id:comment,page_id:page,text:'연결'});
 await store.commit();assert.equal(provider.records.get(key('comment',comment)).data.page_id,page);
});
await test('a known SQL denial aborts without retrying an accepted-write receipt',async()=>{
 const base=new MemoryProvider();let writes=0;
 const provider={snapshot:r=>base.snapshot(r),commit:async()=>{writes++;throw new StoreError(409,'LAST_OWNER_ACCOUNT','Cannot remove last owner');}};
 const store=await CloudStore.open(provider,context,selection,options);store.put('page',{...store.get('page','third'),title:'denied'});
 await rejected(store.commit(),'LAST_OWNER_ACCOUNT');assert.equal(store.state,'aborted');await rejected(store.commit(),'STORE_CLOSED');assert.equal(writes,1);
});
await test('identifier reservations roll back and collisions remain bounded and checked',async()=>{
 const provider=new MemoryProvider();let generated='reserved';
 const store=await CloudStore.open(provider,context,{}, {...options,idFactory:()=>generated});
 assert.throws(()=>store.transaction(()=>{store.allocate_id('page');throw Error('rollback');}),/rollback/);
 assert.equal(store.allocate_id('page'),'reserved');expectCode(()=>store.allocate_id('page'),'ID_ALLOCATION_FAILED');
 generated='third';const collision=store.allocate_id('page');store.put('page',{id:collision,title:'must not replace'});
 await rejected(store.commit(),'REVISION_CONFLICT');assert.equal(provider.records.get(key('page','third')).data.title,'세 번째');
});
console.log(JSON.stringify({ok:true,checks,pages:'explicit pinned selection',commit:'atomic memory-model CAS+exact retry',sql:'model tests; deployed SQL is verified separately',nativeOrCloudDeployment:false}));
