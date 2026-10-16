/** Independent Python/SQLite sync oracle + real TS transaction/domain stack.
 * MemoryProvider models atomic RPC; no deployed Supabase or SQL execution claim. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSync, SyncService, canonicalSyncJSON, BindingError } from '../functions/_shared/sync.ts';
import { dispatchStaged } from '../functions/_shared/domain.ts';
import { StoreError, canonicalJSON } from '../functions/_shared/store.ts';
import { AuthError } from '../functions/_shared/auth.ts';

const root = fileURLToPath(new URL('../../', import.meta.url)), python = process.env.FOUNTAIN_PYTHON || '/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const time='2026-10-16T00:00:00.123000+00:00', clone=structuredClone, rowKey=(kind,id)=>JSON.stringify([kind,id]);
const schema={name:{id:'name',name:'이름',type:'title'},n:{id:'n',name:'숫자',type:'number'},due:{id:'due',name:'날짜',type:'date'}};
const acl={default:'workspace',inherit:false,members:{},groups:{}};
const initial={meta:{workspace_id:'qa',settings:{name:'가족'},access_revision:0},records:{member:[{id:'alice',name:'앨리스',role:'member',active:true},{id:'bob',name:'밥',role:'member',active:true}],teamspace:[{id:'general',visibility:'open'}],settings:[{id:'workspace',name:'Fountain',disable_export:false}],database:[{id:'db',name:'표',owner_id:'alice',teamspace_id:'general',permissions:acl,properties:Object.values(schema),views:[],task_settings:{subitems:true,dependencies:true,date_property:'due',shift:'none',skip_weekends:false}}]}};
function fixture(spec=initial){
  const records=new Map(),meta=new Map(),receipts=new Map();let revision=0,currentActor=spec.actor??'alice',commits=0,afterCommit=null,loseACK=false;
  for(const [key,value]of Object.entries(spec.meta??{})){meta.set(key,clone(value));revision++;}
  function put(kind,value){const data={...clone(value),created_at:value.created_at??time,updated_at:value.updated_at??time};records.set(rowKey(kind,data.id),{kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at});}
  for(const [kind,values]of Object.entries(spec.records??{}))for(const value of values){put(kind,value);revision++;}
  const authorize=async()=>({hash:(currentActor==='alice'?'a':'b').repeat(64),userId:currentActor==='alice'?'11111111-1111-4111-8111-111111111111':'33333333-3333-4333-8333-333333333333',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:spec.binding??'binding-a',expiresAt:Date.now()+60000,profile:{workspaceId:'qa',authSessionActive:true,member:clone(records.get(rowKey('member',currentActor)).data)}});
  // Real StoreContext requires a 32-hex binding; use this same binding in both oracles.
  const binding=spec.binding??'a'.repeat(32);const auth=async()=>({...await authorize(),cacheBinding:binding});
  const provider={async snapshot(request){
    if(request.expectedRevision!==undefined&&request.expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT','Fixture changed');
    const selection=request.selection,all=[...records.values()].filter(record=>selection.kinds.includes(record.kind)||selection.ids[record.kind]?.includes(record.id)).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)),offset=request.cursor?.offset??0;
    return {workspaceId:'qa',memberId:request.context.memberId,revision,accessRevision:meta.get('access_revision')??0,principal:clone(records.get(rowKey('member',request.context.memberId)).data),entities:clone(all.slice(offset,offset+selection.pageSize)),meta:selection.metaKeys.map(key=>({key,present:meta.has(key),value:clone(meta.get(key)??null)})),nextCursor:offset+selection.pageSize<all.length?{offset:offset+selection.pageSize}:null};
  },async commit(request){
    const previous=receipts.get(request.transactionId);if(previous){assert.equal(previous.digest,request.digest);return {revision:previous.revision};}
    if(request.expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT','Fixture changed');
    assert.equal(createHash('sha256').update(request.canonical).digest('hex'),request.digest);
    for(const change of request.changes){if(change.op==='put')put(change.kind,change.data);else if(change.op==='delete')records.delete(rowKey(change.kind,change.id));else meta.set(change.key,clone(change.value));revision++;}
    receipts.set(request.transactionId,{revision,digest:request.digest});commits++;if(afterCommit)afterCommit(request);
    if(loseACK){loseACK=false;throw new Error('Fixture lost committed acknowledgement');}return {revision};
  }};
  const apply=createSync({provider,authorize:auth,dispatch:dispatchStaged,clock:()=>Date.parse(time)});
  return {apply,auth,records,meta,binding,provider,get revision(){return revision;},get commits(){return commits;},set afterCommit(value){afterCommit=value;},set actor(value){currentActor=value;},set loseACK(value){loseACK=value;}};
}
const batch=operations=>({workspace_id:'qa',session_binding:'a'.repeat(32),operations});
const page=(id='page-op',target='offline',body={title:'오프라인🙂'})=>({id,kind:'page.create',target_id:target,document_epoch:'11111111-2222-4333-8444-555555555555',body});
const row=(id='row-op',target='row',properties={name:'행',n:1},extra={})=>({id,kind:'row.create',target_id:target,database_id:'db',body:{properties,...extra},base:{schema:Object.fromEntries(Object.keys(properties).map(key=>[key,schema[key]]))}});
const patch=(id,target,properties,base)=>({id,kind:'row.patch',target_id:target,database_id:'db',body:{properties},base:{properties:base,schema:Object.fromEntries(Object.keys(properties).map(key=>[key,schema[key]]))}});
let assertions=0;
function oracle(spec){const result=spawnSync(python,[root+'supabase/tests/sync-oracle.py'],{input:JSON.stringify(spec),cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
async function parity(name,batches,spec={}){
  spec={...clone(initial),...spec,binding:'a'.repeat(32),batches};const f=fixture(spec),results=[];
  for(const request of batches){try{results.push({ok:await f.apply(request,await f.auth())});}catch(error){results.push({error:{status:error.status,message:error.message}});}}
  const records={};for(const record of f.records.values()){records[record.kind]??=[];records[record.kind].push(clone(record.data));}
  for(const values of Object.values(records))values.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  for(const audit of records.audit??[])delete audit.id;
  records.audit?.sort((a,b)=>canonicalJSON(a)<canonicalJSON(b)?-1:canonicalJSON(a)>canonicalJSON(b)?1:0);
  const actual={results,records,revision:f.revision},expected=oracle(spec);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,name);assertions+=batches.reduce((sum,item)=>sum+(item.operations?.length??1),0);return f;
}

const original=page();
await parity('page creation, exact receipt retry, collision and independent metadata fields',[
  batch([original]),batch([original]),batch([{...original,body:{title:'changed same ID'}}]),
  batch([{id:'title',kind:'page.patch',target_id:'offline',body:{title:'로컬 제목'},base:{fields:{title:'오프라인🙂'}}}]),
  batch([{id:'icon',kind:'page.patch',target_id:'offline',body:{icon:'🏠'},base:{fields:{icon:'📄'}}}]),
  batch([{id:'stale',kind:'page.patch',target_id:'offline',body:{title:'stale'},base:{fields:{title:'오프라인🙂'}}}]),
]);
await parity('rows typed schema/field merge, dependencies and original after-operation receipt',[
  batch([row('parent','parent',{name:'부모',n:2}),{...row('child','child',{name:'자식',n:3},{parent_row_id:'parent',depends_on:['parent']}),depends_on:['parent']}]),
  batch([patch('edit','parent',{n:7},{n:2}),patch('bad-base','child',{n:8},{n:2})]),
  batch([{id:'remove-missing-child',kind:'row.delete',target_id:'parent',database_id:'db',body:{},base_rows:{parent:{updated_at:time}}}]),
  batch([{id:'remove','kind':'row.delete',target_id:'parent',database_id:'db',depends_on:['edit'],body:{},base_rows:{parent:{updated_at:'obsolete',after_operation:'edit'},child:{updated_at:time,after_operation:'child'}}}]),
]);
await parity('invalid and failed operations roll back alone; later independent mutation still commits',[
  batch([null,{id:'invalid',kind:'page.create',target_id:'bad',document_epoch:'not-a-uuid',body:{}},row('valid','valid'),{...row('missing-dependency','later'),depends_on:['missing']},row('good-later','good-later')]),
  batch([{...patch('schema','valid',{n:8},{n:1}),base:{properties:{n:1},schema:{n:{...schema.n,type:'text'}}}}, {...patch('computed','valid',{n:3},{n:1}),body:{properties:{n:true}}}]),
  batch([page('unicode','한글?#%'),{...page('invalid-target','bad/slash')}]),
]);
await parity('missing own prerequisite receipt and exact subtree mismatch preserve rows',[
  batch([row('root','root'),row('child','child',{name:'자식'},{parent_row_id:'root'})]),
  batch([{id:'delete-no-receipt',kind:'row.delete',target_id:'root',database_id:'db',body:{},base_rows:{root:{updated_at:time,after_operation:'foreign'},child:{updated_at:time}}}]),
  batch([{id:'delete-extra',kind:'row.delete',target_id:'root',database_id:'db',body:{},base_rows:{root:{updated_at:time},child:{updated_at:time},extra:{updated_at:time}}}]),
]);
await parity('strict operation/resource fields and deferred prerequisites never create receipts',[
  batch([
    ...['bad/slash','bad\\slash','.','..','', '\u0080', 'x'.repeat(161)].map((target,index)=>page('invalid-target-'+index,target)),
    {...page('with-blocks','body-blocks'),body:{title:'x',blocks:[]}},
    {...page('bad-dependency','dep'),depends_on:['bad-dependency']},
    {...page('bad-op','op'),id:'spaces are invalid'},
    {...page('newline-op','op'),id:'newline\n'},
    {...page('newline-epoch','epoch'),document_epoch:'11111111222243338444555555555555\n'},
    {...page('bad-body','body'),body:[]},
    {...page('bad-field','field'),unknown:'unsupported'},
    {...row('missing-schema','missing-schema'),base:{}},
    {...page('forbidden-body-id','wrong-id'),body:{id:'different'}},
  ]),
  batch([{...page('first','first')},{...page('first','first'),body:{title:'changed'}},{...page('later','later'),depends_on:['first']}]),
]);
await parity('locked page and protected task descendants preserve complete source',[
  batch([{id:'locked-title',kind:'page.patch',target_id:'locked',body:{title:'changed'},base:{fields:{title:'locked'}}}]),
  batch([{id:'hidden-child',kind:'row.delete',target_id:'root',database_id:'db',body:{},base_rows:{root:{updated_at:time},child:{updated_at:time}}}]),
],{records:{...clone(initial.records),page:[{id:'locked',title:'locked',owner_id:'alice',teamspace_id:'general',permissions:acl,locked:true,archived:false,revision:0,blocks:[]}],row:[{id:'root',database_id:'db',owner_id:'alice',properties:{name:'부모'},parent_row_id:null,depends_on:[]},{id:'child',database_id:'db',owner_id:'bob',properties:{name:'숨김'},parent_row_id:'root',depends_on:[],permissions:{default:'private',inherit:false,members:{},groups:{}}}]}});
// Independent Python serializer vectors pin exponent spelling, reserved keys,
// Unicode scalar key order and real SHA bytes rather than duplicating the code.
{
  const vectors=[{n:1e-7},{n:0.00001},{n:-1.2345e-5},{n:0.0001},{n:1.0000000000000002},{n:1e14},{'𐀀':'🙂','\uE000':'한글',constructor:[null,true,false,'"\\\n']},JSON.parse('{"__proto__":{"n":0.00001}}')];
  const expected=oracle({digests:vectors});for(let i=0;i<vectors.length;i++){assert.equal(canonicalSyncJSON(vectors[i]),expected[i].canonical);assert.equal(SyncService._digest(vectors[i]),expected[i].digest);}assertions+=vectors.length;
}
// A legacy float/integer lexical ambiguity is retained as a conflict, never ignored.
{
  const f=fixture(),operation=row('legacy-float','legacy',{name:'원본',n:1});
  const legacy=oracle({digests:[operation],float_paths:[['body','properties','n']]}),legacyDigest=legacy[0].digest;
  // The independent Python process emits the historical float spelling.
  assert(legacy[0].canonical.includes('"n":1.0'));assert.notEqual(legacyDigest,SyncService._digest(operation));
  const id=SyncService.receipt_id('alice',operation.id),data={id,actor_id:'alice',workspace_id:'qa',operation_id:operation.id,kind:operation.kind,database_id:'db',digest:legacyDigest,result:{id:operation.id,status:'applied',http_status:201,resource_id:'legacy'},created_at:time,updated_at:time};
  f.records.set(rowKey('sync_receipt',id),{kind:'sync_receipt',id,data,createdAt:time,updatedAt:time});
  assert.equal((await f.apply(batch([operation]),await f.auth())).results[0].status,'conflict');assert.equal(f.records.has(rowKey('row','legacy')),false);assertions++;
}
{
  const f=fixture();f.loseACK=true;const initialAuth=await f.auth(),result=await f.apply(batch([page()]),initialAuth);
  assert.equal(result.results[0].status,'applied');assert.equal([...f.records.values()].filter(row=>row.kind==='sync_receipt').length,1);
  assert.equal([...f.records.values()].filter(row=>row.kind==='page').length,1);assertions+=2;
}
{
  const f=fixture(),initialAuth=await f.auth();f.afterCommit=request=>{if(request.changes.some(change=>change.kind==='sync_receipt'))f.actor='bob';};
  await assert.rejects(f.apply(batch([page('first','first'),page('second','second')]),initialAuth),error=>error instanceof AuthError&&error.status===401);
  assert(f.records.has(rowKey('page','first')));assert(!f.records.has(rowKey('page','second')));assert.equal([...f.records.values()].filter(row=>row.kind==='sync_receipt').length,1);assertions+=3;
}
{
  const f=fixture(),auth=await f.auth();for(const body of [{workspace_id:'other',session_binding:f.binding,operations:[]},{workspace_id:'qa',session_binding:'old',operations:[]}])await assert.rejects(f.apply(body,auth),error=>error instanceof BindingError);
  await assert.rejects(f.apply(batch(Array(51).fill(page())),auth),error=>error.status===400);assertions+=3;
}
{
  const f=fixture(),operation=page('actor-id','actor-page');await f.apply(batch([operation]),await f.auth());f.actor='bob';
  const result=await f.apply(batch([operation]),await f.auth());assert.equal(result.results[0].status,'conflict');
  assert.equal([...f.records.values()].filter(row=>row.kind==='sync_receipt').length,1);assertions+=2;
}
{
  const f=fixture(),dispatch=(store,method,path,body)=>{const result=dispatchStaged(store,method,path,body);return method==='POST'&&path.endsWith('/rows')?{status:503,payload:{}}:result;};
  const apply=createSync({provider:f.provider,authorize:f.auth,dispatch,clock:()=>Date.parse(time)});
  const result=await apply(batch([row('rolled-back','rolled-back'),page('independent','independent')]),await f.auth());
  assert.equal(result.results[0].status,'deferred');assert.equal(result.results[1].status,'applied');assert(!f.records.has(rowKey('row','rolled-back')));assert.equal([...f.records.values()].filter(row=>row.kind==='sync_receipt').length,1);assertions+=3;
}
console.log(`PASS sync: ${assertions} Python/SQLite, digest and actual TS transaction-stack checks; RPC provider is an isolated memory contract model`);
