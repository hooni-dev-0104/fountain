/** Service authority + shared staging MODEL. No PostgreSQL, Auth provider,
 * deployed Edge, Cron or SCIM-provider execution is claimed by these tests. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Access} from '../functions/_shared/access.ts';
import {CloudStore,ServiceStore,StoreError,MissingSelection,canonicalJSON,createServiceProvider,validateContext,validateServiceContext} from '../functions/_shared/store.ts';
const copy=structuredClone,enc=new TextEncoder();
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',enc.encode(value))).toString('hex');
const grant='11111111-1111-4111-8111-111111111111',lease='22222222-2222-4222-8222-222222222222';
const automation=Object.freeze({kind:'automation',workspaceId:'서비스 空間',memberId:'alice',grantId:grant,grantVersion:1,resourceId:'예약 😀',runId:'a'.repeat(64),leaseId:lease,generation:1,ticketHash:'b'.repeat(64)});
const scim=Object.freeze({kind:'scim',workspaceId:automation.workspaceId,memberId:'alice',grantId:grant,grantVersion:1,tokenHash:'c'.repeat(64)});
const maintenance=Object.freeze({kind:'maintenance',workspaceId:automation.workspaceId,grantId:grant,grantVersion:1,purpose:'backup-gc',leaseId:lease,generation:1,ticketHash:'b'.repeat(64)});
const human={workspaceId:automation.workspaceId,memberId:'alice',userId:grant,authSessionId:lease,sessionHash:'d'.repeat(64),cacheBinding:'e'.repeat(32)};
const fixed='2026-10-16T00:00:00.000000+00:00',options={clock:()=>Date.parse(fixed)};
const key=(kind,id)=>canonicalJSON([kind,id]);
const failure=(code='AUTH_REQUIRED',status=401)=>new StoreError(status,code,'Model typed denial');
class Provider {
 constructor(context=automation){this.context=copy(context);this.revision=5;this.now=1000;this.until=2000;this.enabled=true;this.userActive=true;this.mapped=true;this.receipts=new Map();this.calls=[];this.records=new Map();this.metadata=new Map();this.drop=false;this.before=null;
  this.seed('member',{id:'alice',name:'작성자',email:'test@fixture.invalid',role:context.kind==='scim'?'owner':'member',active:true});
  this.seed('member',{id:'other',name:'소유자',email:'owner@fixture.invalid',role:'owner',active:true});
  this.seed('group',{id:'family',members:['alice']});this.seed('page',{id:'__proto__',title:'기존 😀',owner_id:'alice',permissions:{default:'private'}});
  this.seed('page',{id:'missing-access',owner_id:'other',permissions:{default:'private'}});
  this.seed('automation',{id:automation.resourceId,owner_id:'alice',enabled:true,trigger:'scheduled'});
 }
 seed(kind,data){const value={...copy(data),created_at:fixed,updated_at:fixed};this.records.set(key(kind,value.id),{kind,id:value.id,data:value,createdAt:fixed,updatedAt:fixed});}
 authorize(context){
  const member=this.records.get(key('member','alice')).data,resource=this.records.get(key('automation',automation.resourceId))?.data;
  if(canonicalJSON(context)!==canonicalJSON(this.context)||!this.enabled||!this.userActive||!this.mapped||this.now>=this.until||member.active!==true||!['owner','admin','member','guest'].includes(member.role))throw failure();
  if(context.kind==='scim'&&member.role!=='owner'||context.kind==='automation'&&(!resource||resource.owner_id!==context.memberId))throw failure();
  const {id,name,email,role,active}=member;return {id,name,email,role,active};
 }
 ready(context){if(context.kind==='automation'){const row=this.records.get(key('automation',context.resourceId))?.data;if(!row||row.enabled!==true||row.trigger!=='scheduled')throw failure('SERVICE_SCOPE_FORBIDDEN',403);}}
 async snapshot(request){this.calls.push(['snapshot',copy(request)]);const principal=this.authorize(request.context);this.ready(request.context);
  if(request.expectedRevision!==undefined&&request.expectedRevision!==this.revision)throw failure('REVISION_CONFLICT',409);
  const rows=[...this.records.values()].filter(row=>request.selection.kinds.includes(row.kind)||(Object.hasOwn(request.selection.ids,row.kind)&&request.selection.ids[row.kind].includes(row.id)));
  const scope=await sha(canonicalJSON([request.context,request.selection,this.revision]));if(request.cursor&&request.cursor.scope!==scope)throw failure('CURSOR_SCOPE',409);
  const index=request.cursor?.index??0,entities=copy(rows.slice(index,index+request.selection.pageSize));
  return {workspaceId:request.context.workspaceId,memberId:request.context.memberId,principal,revision:this.revision,accessRevision:0,entities,meta:request.selection.metaKeys.map(key=>({key,value:copy(this.metadata.get(key)??null),present:this.metadata.has(key)})),nextCursor:index+entities.length<rows.length?{index:index+entities.length,scope}:null};
 }
 async commit(request){this.calls.push(['commit',copy(request)]);if(this.before)this.before();this.authorize(request.context);
  assert.equal(await sha(request.canonical),request.digest);assert.deepEqual(JSON.parse(request.canonical),{context:request.context,expectedRevision:request.expectedRevision,changes:request.changes});
  const receiptKey=key(canonicalJSON(request.context),request.transactionId),receipt=this.receipts.get(receiptKey);
  if(receipt){if(receipt.digest!==request.digest)throw failure('COMMIT_ID_REUSED',409);return {revision:receipt.revision};}
  this.ready(request.context);if(this.revision!==request.expectedRevision)throw failure('REVISION_CONFLICT',409);
  const records=copy(this.records),metadata=copy(this.metadata);let steps=0;
  for(const change of request.changes){
   const allowed=request.context.kind==='automation'?['page','row','version','collaboration','automation','automation_run','audit']:['member','group','teamspace','page','database','row','audit'];
   if(change.op==='meta'){if(request.context.kind!=='scim'||change.key!=='access_revision')throw failure('SERVICE_SCOPE_FORBIDDEN',403);metadata.set(change.key,copy(change.value));steps++;continue;}
   if(!allowed.includes(change.kind))throw failure('SERVICE_SCOPE_FORBIDDEN',403);
   if(change.kind==='automation'&&change.id!==request.context.resourceId||change.kind==='automation_run'&&(change.id!==request.context.runId||change.data?.automation_id!==request.context.resourceId))throw failure('SERVICE_SCOPE_FORBIDDEN',403);
   const identity=key(change.kind,change.id),prior=records.get(identity);
   if(change.op==='put'){if((prior?.createdAt??null)!==change.previousCreatedAt)throw failure('REVISION_CONFLICT',409);records.set(identity,{kind:change.kind,id:change.id,data:copy(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});steps++;}
   else if(records.delete(identity))steps++;
  }
  if(request.changes.some(change=>change.kind==='member'&&this.records.get(key('member',change.id))?.data.role==='owner')&&![...records.values()].some(row=>row.kind==='member'&&row.data.role==='owner'&&row.data.active===true))throw failure('LAST_OWNER_ACCOUNT',409);
  this.records=records;this.metadata=metadata;this.revision+=steps;this.receipts.set(receiptKey,{digest:request.digest,revision:this.revision});
  if(this.drop){this.drop=false;throw Error('PRIVATE database/key diagnostics');}return {revision:this.revision};
 }
}
let checks=0;async function test(name,run){try{await run();checks++;}catch(error){error.message=name+': '+error.message;throw error;}}
const rejected=(p,code)=>assert.rejects(p,error=>error instanceof StoreError&&error.code===code);
const denied=fn=>assert.throws(fn,error=>error instanceof StoreError);
const selection={kinds:['page','group','member','automation','automation_run'],metaKeys:['access_revision'],pageSize:2};
await test('three exact authority shapes; frozen copies; no fabricated human contract',async()=>{
 for(const context of [automation,scim,maintenance]){assert.deepEqual(validateServiceContext(context),context);assert(Object.isFrozen(validateServiceContext(context)));denied(()=>validateContext(context));await rejected(CloudStore.open(new Provider(context),context,{}),'STORAGE_RESPONSE_INVALID');}
 denied(()=>validateServiceContext(human));
 for(const changes of [{grantVersion:true},{grantVersion:0},{grantVersion:1.5},{grantVersion:Number.MAX_SAFE_INTEGER+1},{grantId:[]},{grantId:[grant]},{grantId:{value:grant}},{userId:grant},{authSessionId:lease},{sessionHash:'a'.repeat(64)},{cacheBinding:'b'.repeat(32)},{kind:'owner'}])denied(()=>validateServiceContext({...automation,...changes}));
 for(const changes of [{leaseId:null},{leaseId:[lease]},{leaseId:{value:lease}},{generation:false},{generation:0},{ticketHash:'A'.repeat(64)},{runId:'bad'},{resourceId:''},{memberId:null},{workspaceId:'\0'}])denied(()=>validateServiceContext({...automation,...changes}));
 for(const changes of [{purpose:'export'},{memberId:'alice'},{purpose:'backup-gc',tokenHash:'a'.repeat(64)}])denied(()=>validateServiceContext({...maintenance,...changes}));
});
await test('maintenance cannot load a domain Store or contact its provider',async()=>{
 const provider=new Provider(maintenance);await rejected(ServiceStore.open(provider,maintenance,selection),'SERVICE_SCOPE_FORBIDDEN');assert.equal(provider.calls.length,0);
});
await test('actual author remains member and cannot read private owner resources',async()=>{
 const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);assert.equal(store.principal.role,'member');assert.equal(store.context.kind,'automation');assert.equal(store.context.userId,undefined);
 const access=new Access(store,store.principal);assert.equal(access.level('page',store.get('page','__proto__')),4);assert.equal(access.level('page',store.get('page','missing-access')),0);
 assert(provider.calls.filter(([kind])=>kind==='snapshot').length>1);assert.equal(store.get('page','__proto__').title,'기존 😀');assert.throws(()=>store.list('row'),MissingSelection);
});
await test('grant/lease/run/author/workspace scope changes are denied by the provider',async()=>{
 for(const changes of [{workspaceId:'other'},{memberId:'other'},{grantId:lease},{grantVersion:2},{generation:2},{leaseId:grant},{ticketHash:'d'.repeat(64)},{runId:'e'.repeat(64)},{resourceId:'elsewhere'}])await rejected(ServiceStore.open(new Provider(),{...automation,...changes},selection),'AUTH_REQUIRED');
 for(const mutate of [p=>p.enabled=false,p=>p.now=p.until,p=>p.mapped=false,p=>p.userActive=false,p=>p.records.get(key('member','alice')).data.active=false,p=>p.records.get(key('member','alice')).data.role='OWNER',p=>p.records.get(key('automation',automation.resourceId)).data.owner_id='other']){const provider=new Provider();mutate(provider);await rejected(ServiceStore.open(provider,automation,selection),'AUTH_REQUIRED');}
});
await test('SCIM uses its actual current owner, not token roles or a human SID',async()=>{
 const provider=new Provider(scim),store=await ServiceStore.open(provider,scim,selection,options);assert.equal(store.principal.role,'owner');assert.equal(store.context.authSessionId,undefined);
 await rejected(ServiceStore.open(provider,{...scim,tokenHash:'d'.repeat(64)},selection),'AUTH_REQUIRED');provider.records.get(key('member','alice')).data.role='admin';await rejected(ServiceStore.open(provider,scim,selection),'AUTH_REQUIRED');
});
await test('same staging kernel preserves timestamps, rollback, copies and one change one revision',async()=>{
 const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,{...options,idFactory:()=> '새 행'}),before=store.get('page','__proto__');
 assert.throws(()=>store.transaction(()=>{store.put('page',{...before,title:'rollback'});store.allocate_id('row');throw Error('rollback');}),/rollback/);assert.equal(store.revision,5);assert.equal(store.get('page','__proto__').title,'기존 😀');
 const rowId=store.allocate_id('row');store.put('row',{id:rowId,database_id:'db',properties:{text:'한글 😀'}});store.put('page',{...before,title:'수정'});store.delete('page','missing-access');assert.equal(store.revision,8);
 assert.equal(provider.revision,5);assert.deepEqual(await store.commit(),{revision:8});assert.equal(provider.records.get(key('row',rowId)).data.created_at,fixed);assert.equal(provider.records.get(key('page','__proto__')).data.created_at,before.created_at);
});
await test('uncertain commit blocks reads/writes and exact retry executes only once',async()=>{
 const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);store.put('page',{...store.get('page','__proto__'),title:'한 번'});provider.drop=true;
 await rejected(store.commit(),'COMMIT_UNCERTAIN');assert.equal(store.state,'uncertain');denied(()=>store.get('page','__proto__'));denied(()=>store.put('page',{id:'new'}));assert.equal(provider.revision,6);
 assert.deepEqual(await store.commit(),{revision:6});const requests=provider.calls.filter(([kind])=>kind==='commit').map(([,request])=>request);assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(provider.receipts.size,1);
 const changed=copy(requests[0]);changed.changes[0].data.title='collision';changed.canonical=canonicalJSON({context:changed.context,expectedRevision:changed.expectedRevision,changes:changed.changes});changed.digest=await sha(changed.canonical);await rejected(provider.commit(changed),'COMMIT_ID_REUSED');
});
await test('revoked grant denies receipt replay before acknowledgement',async()=>{
 for(const mutate of [p=>p.enabled=false,p=>p.now=p.until,p=>p.context.generation++,p=>p.mapped=false,p=>p.records.get(key('member','alice')).data.active=false]){const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);store.put('page',{...store.get('page','__proto__'),title:'committed'});provider.drop=true;await rejected(store.commit(),'COMMIT_UNCERTAIN');mutate(provider);await rejected(store.commit(),'AUTH_REQUIRED');assert.equal(provider.revision,6);assert.equal(provider.receipts.size,1);assert.equal(store.state,'uncertain');}
});
await test('cross-job action kinds and protected meta cannot commit partial changes',async()=>{
 for(const operation of [s=>s.put('database',{id:s.allocate_id('database'),name:'forbidden'}),s=>s.put('automation_run',{id:'other',automation_id:automation.resourceId}),s=>s.set_meta('access_revision',1)]){const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);store.put('page',{...store.get('page','__proto__'),title:'must rollback'});operation(store);await rejected(store.commit(),'SERVICE_SCOPE_FORBIDDEN');assert.equal(provider.revision,5);assert.equal(provider.records.get(key('page','__proto__')).data.title,'기존 😀');assert.equal(provider.receipts.size,0);}
 const store=await ServiceStore.open(new Provider(),automation,{},options);denied(()=>store.set_meta('_backup_storage_reserved',0));denied(()=>store.put('credential',{id:'secret'}));
});
await test('SCIM owner mutation uses the shared final-state last-owner check',async()=>{
 const provider=new Provider(scim);provider.records.delete(key('member','other'));const store=await ServiceStore.open(provider,scim,selection,options);store.put('member',{...store.get('member','alice'),active:false});await rejected(store.commit(),'LAST_OWNER_ACCOUNT');assert.equal(provider.revision,5);assert.equal(provider.records.get(key('member','alice')).data.active,true);
});
await test('changed revision and principal across snapshot pages reject mixed authority',async()=>{
 for(const change of [p=>p.revision++,p=>p.records.get(key('member','alice')).data.role='owner']){const provider=new Provider(),snapshot=provider.snapshot.bind(provider);let count=0;provider.snapshot=async request=>{if(count++===1)change(provider);return snapshot(request);};await assert.rejects(ServiceStore.open(provider,automation,selection),StoreError);}
});
await test('service transport has a distinct RPC namespace and no human credentials',async()=>{
 const calls=[],provider=createServiceProvider({supabaseUrl:'https://fixture.invalid',serviceKey:'sb_secret_'+ 'x'.repeat(20),fetch:async(url,init)=>{calls.push({url,init});return Response.json({revision:5});}});
 await provider.snapshot({context:automation,selection:{kinds:[],ids:{},metaKeys:[],pageSize:1}});await provider.commit({context:scim,expectedRevision:5,transactionId:lease,canonical:'{}',digest:'a'.repeat(64),changes:[]});
 assert(calls[0].url.endsWith('/fountain_cloud_service_snapshot'));assert(calls[1].url.endsWith('/fountain_cloud_service_commit'));for(const call of calls){const body=JSON.parse(call.init.body);assert.equal(body.p_context.authSessionId,undefined);assert.equal(body.p_context.sessionHash,undefined);assert.equal(call.init.redirect,'error');}
 const count=calls.length;await rejected(provider.snapshot({context:maintenance,selection:{kinds:[],ids:{},metaKeys:[],pageSize:1}}),'SERVICE_SCOPE_FORBIDDEN');assert.equal(calls.length,count);
});
await test('applied source has no installation/issuance/client grants or human authorization weakening',async()=>{
 const sql=readFileSync(new URL('../migrations/20261016143508_fountain_cloud_service_authority.sql',import.meta.url),'utf8');
 assert(!/CREATE(?: OR REPLACE)? FUNCTION fountain_cloud.store_context\(/.test(sql));assert(!/INSERT INTO fountain_cloud.service_(?:grants|leases)\b/.test(sql));assert(!/cron\.schedule|net\.http_post/.test(sql));
 for(const table of ['service_grants','service_leases','service_commit_receipts']){assert(sql.includes('ALTER TABLE fountain_cloud.'+table+' FORCE ROW LEVEL SECURITY;'));}
 assert(sql.includes('FROM PUBLIC,anon,authenticated,service_role;'));assert(sql.includes('FOR SHARE OF e,m,u'));assert(sql.includes('FOR SHARE OF g'));assert(sql.includes('FOR SHARE OF l'));assert(sql.includes("v_member->>'role' IS DISTINCT FROM 'owner'"));assert(sql.includes("IF v_kind='maintenance' THEN RETURN NULL"));
 assert(sql.includes('v_revision:=fountain_cloud.store_apply_changes_locked'));assert(sql.includes('revision:=fountain_cloud.store_apply_changes_locked'));assert(sql.includes("IF NOT FOUND THEN RAISE EXCEPTION 'LAST_OWNER_ACCOUNT'"));assert(sql.includes("'_backup_storage_reserved'"));assert(!/GRANT[^;]+fountain_private/i.test(sql));
 const commit=sql.slice(sql.indexOf('CREATE FUNCTION fountain_cloud.service_commit'));
 assert(commit.indexOf('fountain_cloud.service_context')<commit.indexOf('SELECT r.* INTO v_recorded'));assert(commit.includes('r.authority_hash=v_scope'));assert(commit.includes('v_recorded.digest<>p_digest'));
});
await test('self-disabling completion still acknowledges exact retry; new work is denied',async()=>{
 const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);
 store.put('automation',{...store.get('automation',automation.resourceId),enabled:false,next_run_at:null});provider.drop=true;
 await rejected(store.commit(),'COMMIT_UNCERTAIN');assert.deepEqual(await store.commit(),{revision:6});assert.equal(provider.receipts.size,1);
 await rejected(ServiceStore.open(provider,automation,selection),'SERVICE_SCOPE_FORBIDDEN');
});
await test('replaced current author invalidates an old accepted receipt',async()=>{
 const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);store.put('page',{...store.get('page','__proto__'),title:'one'});provider.drop=true;await rejected(store.commit(),'COMMIT_UNCERTAIN');
 provider.records.get(key('automation',automation.resourceId)).data.owner_id='other';await rejected(store.commit(),'AUTH_REQUIRED');assert.equal(provider.revision,6);
});
await test('service source uses the unchanged human SQL apply loop and receipt boundary',async()=>{
 const sql=readFileSync(new URL('../migrations/20261016143508_fountain_cloud_service_authority.sql',import.meta.url),'utf8'),original=readFileSync(new URL('../migrations/20261016134013_fountain_cloud_backup_reservation_boundary.sql',import.meta.url),'utf8');
 const before=original.slice(original.indexOf(' FOR change IN SELECT'),original.indexOf(' INSERT INTO fountain_cloud.store_commit_receipts'));
 const helper=sql.slice(sql.indexOf(' FOR v_change IN SELECT'),sql.indexOf(' RETURN v_revision;'));
 const normalized=helper.replace(/\bv_(revision|change|previous|found_previous|affected|data|change_kind|change_id|meta_key|steps|owner_mutated|ws)\b/g,(_,name)=>name);
 assert.equal(normalized,before);
 const start=sql.indexOf('CREATE OR REPLACE FUNCTION fountain_cloud.store_commit'),end=sql.indexOf('CREATE FUNCTION fountain_cloud.store_snapshot_locked'),wrapper=sql.slice(start,end);
 assert(wrapper.indexOf('store_context(p_context)')<wrapper.indexOf('SELECT * INTO recorded'));assert(wrapper.includes("r.session_hash=p_context->>'sessionHash'"));assert(wrapper.includes("jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes)"));
 const service=sql.slice(sql.indexOf('CREATE FUNCTION fountain_cloud.service_commit'));
 assert(service.indexOf('SELECT r.* INTO v_recorded')<service.indexOf('PERFORM fountain_cloud.service_data_ready'));
 assert(service.indexOf('PERFORM fountain_cloud.service_data_ready')<service.indexOf('PERFORM fountain_cloud.service_changes'));
});
await test('shared snapshot kernel retains the complete human page/cursor projection',async()=>{
 const draft=readFileSync(new URL('../migrations/20261016143508_fountain_cloud_service_authority.sql',import.meta.url),'utf8'),old=readFileSync(new URL('../migrations/20261016100057_fountain_cloud_atomic_store.sql',import.meta.url),'utf8');
 const original=old.slice(old.indexOf('CREATE FUNCTION fountain_cloud.store_snapshot('),old.indexOf('ALTER FUNCTION fountain_cloud.store_snapshot'));
 const shared=draft.slice(draft.indexOf('CREATE FUNCTION fountain_cloud.store_snapshot_locked('),draft.indexOf('REVOKE ALL ON FUNCTION fountain_cloud.store_snapshot_locked'));
 assert.equal(shared,original.replace('store_snapshot(p_context jsonb,','store_snapshot_locked(p_context jsonb,p_principal jsonb,').replace('principal:=fountain_cloud.store_context(p_context);','principal:=p_principal;'));
});
await test('service transactions retain async failure and PostgreSQL JSON pre-stage fences',async()=>{
 const provider=new Provider(),store=await ServiceStore.open(provider,automation,selection,options);
 for(const value of [{text:'\0'},JSON.parse('{"\\u0000":"x"}'),JSON.parse('{"\\ud800":"x"}')]){denied(()=>store.put('page',{...store.get('page','__proto__'),...value}));assert.equal(store.revision,5);assert.equal(provider.revision,5);}
 denied(()=>store.transaction(async()=>{}));assert.equal(store.state,'aborted');await rejected(store.commit(),'STORE_CLOSED');
});
console.log(JSON.stringify({ok:true,checks,humanContract:'separate unchanged validator and RPC scope',serviceAuthority:'memory model only',sql:'source assertions against applied migration; separate live QA required',cronOrScimDeployment:false}));
