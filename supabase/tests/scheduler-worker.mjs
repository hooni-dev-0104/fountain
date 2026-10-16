/** Actual TS calendar/Workspace/Advanced/Access/Scheduler/ServiceStore execution.
 * Provider below models revision-pinned RPC and broker receipts; it is NOT SQL,
 * Deno, Cron, Auth-provider or actual hosted authority evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createSchedulePlan,executeScheduledClaim,validateBoundClaim,validatePlanningImage,SchedulerWorkerError} from '../functions/_shared/scheduler-worker.ts';
import {Scheduler,next_occurrence} from '../functions/_shared/scheduler.ts';
import {StoreError,canonicalJSON} from '../functions/_shared/store.ts';
const copy=structuredClone,stamp='2026-10-17T00:00:00.000000+00:00',fixedNow='2026-10-17T00:00:00.123456+00:00',automationId='예약?#% 😀';
const image={jobId:'11111111-1111-4111-8111-111111111111',workspaceId:'가족 空間',automationId,incarnation:'22222222-2222-4222-8222-222222222222',definitionVersion:1,definitionHash:'f'.repeat(64),dueHash:'e'.repeat(64),fixedNow,revision:5,enabled:true,trigger:'scheduled',schedule:{frequency:'minutes',interval:5,timezone:'UTC',start_at:'2026-10-17T00:00:00Z'},nextRunAt:null,malformed:false,authorAvailable:true};
const claimFor=(source=image)=>{const plan=createSchedulePlan(source);return {jobId:source.jobId,workspaceId:source.workspaceId,automationId:source.automationId,definitionVersion:source.definitionVersion,definitionHash:source.definitionHash,dueHash:source.dueHash,fixedNow:source.fixedNow,scheduledAt:plan.scheduledAt,runId:plan.runId,nextRunAt:plan.nextRunAt};};
const contextFor=claim=>({kind:'automation',workspaceId:claim.workspaceId,memberId:'alice',grantId:'33333333-3333-4333-8333-333333333333',grantVersion:1,resourceId:claim.automationId,runId:claim.runId,leaseId:'44444444-4444-4444-8444-444444444444',generation:1,ticketHash:'d'.repeat(64)});
const key=(kind,id)=>JSON.stringify([kind,id]),sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const error=(code,status=409)=>new StoreError(status,code,'Model sanitized denial');
class Provider {
 constructor(source=image){this.source=copy(source);this.claim=claimFor(source);this.context=contextFor(this.claim);this.records=new Map();this.meta=new Map();this.revision=5;this.snapshots=[];this.commits=[];this.receipts=new Map();this.done=false;this.currentDefinition=source.definitionHash;this.currentDue=source.dueHash;this.active=true;this.checkMember=true;this.beforeSnapshot=null;this.beforeCommit=null;this.dropAcks=0;
  this.seed('member',{id:'alice',name:'작성자',email:'alice@fixture.invalid',role:'member',active:true});this.seed('member',{id:'bob',name:'다른 계정',email:'bob@fixture.invalid',role:'owner',active:true});
  this.seed('settings',{id:'workspace',name:'가족',disable_export:false});this.seed('teamspace',{id:'general',visibility:'open',members:['alice','bob']});
  this.seed('database',{id:'projects',owner_id:'alice',name:'작업',properties:[{id:'name',name:'이름',type:'title'},{id:'n',name:'숫자',type:'number'}],permissions:{default:'private',members:{},groups:{}}});
  this.seed('row',{id:'target',database_id:'projects',owner_id:'alice',properties:{name:'원본',n:0},parent_row_id:null,depends_on:[]});
  this.seed('automation',{id:source.automationId,owner_id:'alice',trigger:'scheduled',enabled:true,schedule:copy(source.schedule),next_run_at:source.nextRunAt,database_id:'projects',row_id:'target',actions:[{type:'set_property',property_id:'n',value:2},{type:'create_row',values:{name:'새 행'}},{type:'create_page',title:'예약 문서 😀'}]});
 }
 seed(kind,value){const data={...copy(value),created_at:stamp,updated_at:stamp};this.records.set(key(kind,value.id),{kind,id:value.id,data,createdAt:stamp,updatedAt:stamp});}
 record(kind,id){return this.records.get(key(kind,id))?.data??null;}
 authorize(context){if(!this.active||canonicalJSON(context)!==canonicalJSON(this.context))throw error('AUTH_REQUIRED',401);const member=this.record('member',context.memberId),automation=this.record('automation',context.resourceId);
  if(this.checkMember&&(!member||member.active!==true||!['owner','admin','member','guest'].includes(member.role)||automation?.owner_id!==context.memberId))throw error('AUTH_REQUIRED',401);
  return {id:context.memberId,name:'작성자',email:'alice@fixture.invalid',role:this.roleOverride??member?.role??'member',active:true};
 }
 attest(){if(this.done)throw error('JOB_DONE');if(this.currentDefinition!==this.claim.definitionHash||this.currentDue!==this.claim.dueHash)throw error('BROKER_ATTESTATION_CHANGED');}
 async snapshot(request){this.snapshots.push(copy(request));if(this.beforeSnapshot)this.beforeSnapshot(this,request);const principal=this.authorize(request.context);this.attest();if(request.expectedRevision!==undefined&&request.expectedRevision!==this.revision)throw error('REVISION_CONFLICT');
  const selected=request.selection,rows=[...this.records.values()].filter(row=>selected.kinds.includes(row.kind)||(Object.hasOwn(selected.ids,row.kind)&&selected.ids[row.kind].includes(row.id))),index=request.cursor?.index??0;
  return {workspaceId:request.context.workspaceId,memberId:request.context.memberId,revision:this.revision,accessRevision:0,principal,entities:copy(rows.slice(index,index+selected.pageSize)),meta:selected.metaKeys.map(key=>({key,value:copy(this.meta.get(key)??null),present:this.meta.has(key)})),nextCursor:index+selected.pageSize<rows.length?{index:index+selected.pageSize}:null};
 }
 respond(value){if(this.dropAcks>0){this.dropAcks--;throw Error('PRIVATE lost acknowledgement');}return value;}
 async commit(request){this.commits.push(copy(request));if(this.beforeCommit)this.beforeCommit(this,request);this.authorize(request.context);
  assert.equal(await sha(request.canonical),request.digest);assert.deepEqual(JSON.parse(request.canonical),{context:request.context,expectedRevision:request.expectedRevision,changes:request.changes});
  const receiptKey=canonicalJSON([request.context,request.transactionId]),prior=this.receipts.get(receiptKey);if(prior){if(prior.digest!==request.digest)throw error('COMMIT_ID_REUSED');return this.respond({revision:prior.revision});}
  this.attest();if(request.expectedRevision!==this.revision)throw error('REVISION_CONFLICT');
  const records=copy(this.records);let changes=0;
  for(const change of request.changes){assert.notEqual(change.op,'meta');const identity=key(change.kind,change.id),old=records.get(identity);if(change.op==='put'){if((old?.createdAt??null)!==change.previousCreatedAt)throw error('REVISION_CONFLICT');records.set(identity,{kind:change.kind,id:change.id,data:copy(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});changes++;}else if(records.delete(identity))changes++;}
  const run=records.get(key('automation_run',this.claim.runId))?.data,automation=records.get(key('automation',this.claim.automationId))?.data;
  assert(run&&['succeeded','failed'].includes(run.status));assert.equal(run.scheduled_at,this.claim.scheduledAt);assert.equal(automation.next_run_at,this.claim.nextRunAt);
  this.records=records;this.revision+=changes;this.done=true;this.receipts.set(receiptKey,{digest:request.digest,revision:this.revision});return this.respond({revision:this.revision});
 }
}
const full={selection:{kinds:['group','member','automation','automation_run','settings','teamspace','database','row','page','audit']}};
const rows=p=>[...p.records.values()].filter(item=>item.kind==='row').map(item=>item.data),pages=p=>[...p.records.values()].filter(item=>item.kind==='page').map(item=>item.data);
const run=p=>executeScheduledClaim(p.context,p.claim,p,full);
const rejects=(promise,code)=>assert.rejects(promise,error=>error instanceof StoreError&&error.code===code);
const throws=fn=>assert.throws(fn,error=>error instanceof StoreError);

test('calendar plans reuse exact UTC microseconds, stable run IDs and future coalescing',()=>{
 const due=createSchedulePlan(image);assert.deepEqual(due,{kind:'due',scheduledAt:'2026-10-17T00:00:00+00:00',runId:Scheduler._run_id(automationId,'2026-10-17T00:00:00+00:00'),nextRunAt:'2026-10-17T00:05:00+00:00'});
 const future=createSchedulePlan({...image,nextRunAt:'2026-10-18T09:00:00+09:00'});assert.equal(future.kind,'defer');assert.equal(future.scheduledAt,'2026-10-18T00:00:00+00:00');assert.equal(future.nextRunAt,future.scheduledAt);
 const missed=createSchedulePlan({...image,fixedNow:'2027-03-01T11:33:00Z'});assert.equal(missed.nextRunAt,'2027-03-01T11:35:00+00:00');assert.equal(missed.runId,due.runId);
});
test('end/invalid/author-unavailable are plans only without a provider or principal',()=>{
 const complete=createSchedulePlan({...image,nextRunAt:'2026-10-18T00:00:00Z',schedule:{...image.schedule,end_at:'2026-10-17T00:00:00Z'}});assert.equal(complete.kind,'complete');assert.equal(complete.nextRunAt,null);
 for(const source of [{...image,schedule:{...image.schedule,interval:0}},{...image,schedule:{...image.schedule,frequency:'invalid'}},{...image,nextRunAt:'broken'},{...image,schedule:null},{...image,malformed:true}]){const plan=createSchedulePlan(source);assert.equal(plan.kind,'invalid');assert.equal(plan.runId,Scheduler._run_id(automationId,'invalid-schedule'));assert.equal(plan.nextRunAt,null);assert.equal(plan.scheduledAt,null);assert.equal(typeof plan.error,'string');}
 const unavailable=createSchedulePlan({...image,authorAvailable:false});assert.deepEqual(unavailable,createSchedulePlan(image));for(const source of [{...image,enabled:false},{...image,trigger:'manual'}])assert.throws(()=>createSchedulePlan(source),error=>error.code==='JOB_NOT_ACTIVE'&&error.status===409);
});
test('DST gap/overlap/non-hour and date-line calendars are unchanged',()=>{
 for(const [timezone,start_at,fixedNow]of [['America/New_York','2026-03-07T02:30:00-05:00','2026-03-08T07:30:00Z'],['America/New_York','2026-10-31T01:30:00-04:00','2026-11-01T05:30:00Z'],['Australia/Lord_Howe','2026-10-03T02:15:00+10:30','2026-10-04T00:00:00Z'],['Pacific/Apia','2011-12-29T10:00:00-10:00','2011-12-31T00:00:00Z']]){const schedule={frequency:'days',timezone,start_at},plan=createSchedulePlan({...image,fixedNow,schedule});assert.equal(plan.nextRunAt,next_occurrence(schedule,fixedNow));}
});
test('strict scalar DTOs reject nested metadata, spoofed fields and malformed types',()=>{
 for(const value of [null,[],{...image,provider_key:'PRIVATE'},{...image,authorAvailable:1},{...image,enabled:'true'},{...image,definitionVersion:true},{...image,revision:-1},{...image,jobId:[image.jobId]},{...image,workspaceId:'\0'},{...image,definitionHash:'A'.repeat(64)},{...image,dueHash:[]},{...image,fixedNow:'2026-10-17'},{...image,nextRunAt:{}},{...image,schedule:{...image.schedule,provider_key:'PRIVATE'}},{...image,schedule:{...image.schedule,timezone:{secret:'PRIVATE'}}},{...image,schedule:{...image.schedule,interval:true}}])throws(()=>validatePlanningImage(value));
 const candidate=claimFor();for(const patch of [{extra:'PRIVATE'},{runId:'0'.repeat(64)},{scheduledAt:'2026-10-18T00:00:00Z'},{nextRunAt:fixedNow},{jobId:[candidate.jobId]},{definitionVersion:1.5},{fixedNow:'broken'},{nextRunAt:{secret:'PRIVATE'}}])throws(()=>validateBoundClaim({...candidate,...patch}));
 let read=0;const schedule={...image.schedule};Object.defineProperty(schedule,'timezone',{enumerable:true,get(){read++;return 'UTC';}});throws(()=>validatePlanningImage({...image,schedule}));assert.equal(read,0);
 assert.deepEqual(validatePlanningImage(JSON.parse(JSON.stringify(image))),image);assert.equal(validateBoundClaim(candidate).workspaceId,image.workspaceId);
});
test('real staged actions update/create rows and page using current author and fixed DB time',async()=>{
 const provider=new Provider(),result=await run(provider);assert.deepEqual(Object.keys(result).sort(),['revision','runId','status']);assert.equal(result.status,'succeeded');assert.equal(result.runId,provider.claim.runId);assert.equal(provider.record('row','target').properties.n,2);
 assert.equal(rows(provider).length,2);assert.equal(rows(provider).find(row=>row.id!=='target').properties.name,'새 행');assert.equal(pages(provider).length,1);assert.equal(pages(provider)[0].title,'예약 문서 😀');assert.equal(pages(provider)[0].owner_id,'alice');
 const saved=provider.record('automation_run',provider.claim.runId);assert.equal(saved.started_at,fixedNow);assert.equal(saved.finished_at,fixedNow);assert.equal(saved.scheduled_at,provider.claim.scheduledAt);assert.equal(provider.record('automation',automationId).next_run_at,provider.claim.nextRunAt);assert.equal(provider.receipts.size,1);assert(provider.done);
 assert([...provider.records.values()].filter(item=>item.kind==='audit').every(item=>item.data.user==='alice'));assert(provider.commits[0].changes.every(change=>change.data.updated_at==='2026-10-17T00:00:00.123000+00:00'));assert(!JSON.stringify(result).includes('새 행'));
});
test('opaque SQL attestation is not recomputed from JavaScript JSON/number formatting',async()=>{
 const source={...image,definitionHash:'1'.repeat(64),dueHash:'2'.repeat(64)},provider=new Provider(source);provider.record('automation',automationId).conditions={};provider.record('automation',automationId).arbitrary_scale=1;assert.equal((await run(provider)).status,'succeeded');assert(provider.snapshots.every(request=>request.context.runId===provider.claim.runId));
});
test('workspace/resource/run context mismatch is denied before provider I/O',async()=>{
 for(const patch of [{workspaceId:'other'},{resourceId:'other'},{runId:'0'.repeat(64)}]){const provider=new Provider();await rejects(executeScheduledClaim({...provider.context,...patch},provider.claim,provider),'CLAIM_CONTEXT_MISMATCH');assert.equal(provider.snapshots.length,0);assert.equal(provider.commits.length,0);}
 const provider=new Provider();await assert.rejects(executeScheduledClaim({...provider.context,kind:'scim'},provider.claim,provider),StoreError);assert.equal(provider.snapshots.length,0);
});
test('late worker cannot execute the next slot even when provider scalar projection is stale',async()=>{
 const provider=new Provider();provider.record('automation',automationId).next_run_at='2026-10-17T00:05:00+00:00';const before=copy(provider.records);await rejects(run(provider),'CLAIM_SLOT_CHANGED');assert.equal(provider.commits.length,0);assert.deepEqual(provider.records,before);
});
test('a prior stable run stops actions and stays available for broker control dedup',async()=>{
 const provider=new Provider();provider.seed('automation_run',{id:provider.claim.runId,automation_id:automationId,status:'succeeded',result:{private:'original'}});const before=copy(provider.records);await rejects(run(provider),'RUN_ALREADY_EXISTS');assert.equal(provider.commits.length,0);assert.deepEqual(provider.records,before);
});
test('current author/context mismatch and inactive record stop before actions',async()=>{
 for(const mutate of [p=>{p.record('automation',automationId).owner_id='bob';},p=>{p.record('member','alice').active=false;},p=>{p.record('member','alice').role='OWNER';}]){const provider=new Provider();provider.checkMember=false;provider.roleOverride='member';mutate(provider);const before=copy(provider.records);await assert.rejects(run(provider),error=>error instanceof SchedulerWorkerError&&['CLAIM_AUTHOR_CHANGED','CLAIM_AUTHOR_UNAVAILABLE'].includes(error.code));assert.equal(provider.commits.length,0);assert.deepEqual(provider.records,before);}
});
test('current database ACL denial records failure without performing any action',async()=>{
 const provider=new Provider();provider.record('database','projects').owner_id='bob';const result=await run(provider);assert.equal(result.status,'failed');assert.equal(provider.record('row','target').properties.n,0);assert.equal(rows(provider).length,1);assert.equal(pages(provider).length,0);assert.equal(provider.record('automation_run',provider.claim.runId).status,'failed');
});
test('domain failure rolls back all partial actions while retaining failed run and nextAt',async()=>{
 const provider=new Provider();provider.record('automation',automationId).actions=[{type:'create_row',values:{name:'must rollback'}},{type:'set_property',property_id:'unknown',value:1}];assert.equal((await run(provider)).status,'failed');assert.equal(rows(provider).length,1);assert.equal(pages(provider).length,0);assert.equal(provider.record('row','target').properties.n,0);assert.equal(provider.record('automation',automationId).next_run_at,provider.claim.nextRunAt);assert(![...provider.records.values()].some(item=>item.kind==='audit'&&item.data.action==='row.created'));
});
test('MissingSelection expands fresh pinned reads and commits each domain effect once',async()=>{
 const provider=new Provider(),result=await executeScheduledClaim(provider.context,provider.claim,provider);assert.equal(result.status,'succeeded');assert(provider.snapshots.length>1);assert.equal(provider.commits.length,1);assert.equal(provider.receipts.size,1);assert.equal(rows(provider).length,2);assert.equal(pages(provider).length,1);assert(provider.snapshots.every(request=>!request.selection.kinds.includes('automation')&&request.selection.ids.automation.includes(automationId)));
});
test('selection limit is typed and preserves all source records',async()=>{
 const provider=new Provider(),before=copy(provider.records);await rejects(executeScheduledClaim(provider.context,provider.claim,provider,{maxSelectionRounds:1}),'SELECTION_LIMIT');assert.equal(provider.commits.length,0);assert.deepEqual(provider.records,before);
});
test('each fresh snapshot must pass provider attestation after definition changes',async()=>{
 const provider=new Provider();provider.beforeSnapshot=(p)=>{if(p.snapshots.length===2)p.currentDefinition='0'.repeat(64);};const before=copy(provider.records);await rejects(executeScheduledClaim(provider.context,provider.claim,provider),'BROKER_ATTESTATION_CHANGED');assert.equal(provider.commits.length,0);assert.deepEqual(provider.records,before);
});
test('CAS replay rechecks the claimed slot and never blindly executes a newer occurrence',async()=>{
 const provider=new Provider();provider.beforeCommit=p=>{p.beforeCommit=null;p.record('automation',automationId).next_run_at='2026-10-17T00:05:00+00:00';p.revision++;};await rejects(run(provider),'CLAIM_SLOT_CHANGED');assert.equal(provider.commits.length,1);assert.equal(rows(provider).length,1);assert.equal(pages(provider).length,0);assert.equal(provider.receipts.size,0);
});
test('same-slot CAS conflict replays pure actions with the original fixed time',async()=>{
 const provider=new Provider();provider.beforeCommit=p=>{p.beforeCommit=null;p.revision++;};assert.equal((await run(provider)).status,'succeeded');assert.equal(provider.commits.length,2);assert.equal(provider.receipts.size,1);assert.equal(rows(provider).length,2);assert.equal(provider.record('automation_run',provider.claim.runId).started_at,fixedNow);
});
test('lost ACK retries identical transaction/digest without re-running accepted actions',async()=>{
 const provider=new Provider();provider.dropAcks=1;assert.equal((await run(provider)).status,'succeeded');assert.equal(provider.commits.length,2);assert.deepEqual(provider.commits[0],provider.commits[1]);assert.equal(provider.receipts.size,1);assert.equal(rows(provider).length,2);assert.equal(pages(provider).length,1);
 await rejects(run(provider),'JOB_DONE');assert.equal(provider.commits.length,2);
});
test('persistent unknown ACK fails closed after same-request retry and publishes no second result',async()=>{
 const provider=new Provider();provider.dropAcks=2;await rejects(run(provider),'COMMIT_UNCERTAIN');assert.equal(provider.commits.length,2);assert.deepEqual(provider.commits[0],provider.commits[1]);assert.equal(provider.receipts.size,1);assert.equal(rows(provider).length,2);
});
test('receipt replay still checks actual author revocation',async()=>{
 const provider=new Provider();provider.dropAcks=1;provider.beforeCommit=p=>{if(p.commits.length===2)p.active=false;};await rejects(run(provider),'AUTH_REQUIRED');assert.equal(provider.receipts.size,1);assert.equal(provider.commits.length,2);assert.equal(rows(provider).length,2);
});
test('self-disabling final occurrence preserves exact ACK and blocks new work',async()=>{
 const source={...image,schedule:{...image.schedule,end_at:'2026-10-17T00:00:00Z'}},provider=new Provider(source);provider.dropAcks=1;assert.equal((await run(provider)).status,'succeeded');assert.equal(provider.record('automation',automationId).enabled,false);assert.equal(provider.record('automation',automationId).next_run_at,null);assert.equal(provider.commits.length,2);assert.deepEqual(provider.commits[0],provider.commits[1]);await rejects(run(provider),'JOB_DONE');
});
test('malformed persisted schedule and absent settings never invent background authority',async()=>{
 const provider=new Provider();provider.record('automation',automationId).schedule.interval=true;await rejects(run(provider),'CLAIM_SLOT_CHANGED');assert.equal(provider.commits.length,0);
 const missing=new Provider();missing.records.delete(key('settings','workspace'));await rejects(run(missing),'WORKSPACE_CONFIGURATION_MISSING');assert.equal(missing.commits.length,0);
});
test('worker bounds reject coercive or excessive retry options before network access',async()=>{
 for(const options of [{maxSelectionRounds:0},{maxSelectionRounds:true},{maxSelectionRounds:129},{maxConflicts:0},{maxConflicts:6}]){const provider=new Provider();await rejects(executeScheduledClaim(provider.context,provider.claim,provider,options),'INVALID_WORKER_OPTIONS');assert.equal(provider.snapshots.length,0);}
});

test('malformed provider principal is rejected at the shared Store boundary',async()=>{
 const provider=new Provider();provider.checkMember=false;provider.record('member','alice').role='OWNER';await rejects(run(provider),'STORAGE_RESPONSE_INVALID');assert.equal(provider.commits.length,0);
});
test('a different actual member cannot borrow a bound automation resource',async()=>{
 const provider=new Provider();provider.context.memberId='bob';provider.checkMember=false;await rejects(run(provider),'CLAIM_AUTHOR_CHANGED');assert.equal(provider.commits.length,0);assert.equal(rows(provider).length,1);
});
test('changed bound nextAt is rejected before a single action is staged for commit',async()=>{
 const provider=new Provider();provider.claim.nextRunAt='2026-10-17T00:10:00+00:00';const before=copy(provider.records);await rejects(run(provider),'CLAIM_SLOT_CHANGED');assert.equal(provider.commits.length,0);assert.deepEqual(provider.records,before);
});
test('provider attestation is required again at commit, after the staged callback',async()=>{
 const provider=new Provider();provider.beforeCommit=p=>{p.currentDue='0'.repeat(64);};const before=copy(provider.records);await rejects(run(provider),'BROKER_ATTESTATION_CHANGED');assert.equal(provider.receipts.size,0);assert.deepEqual(provider.records,before);
});
test('invalid source shapes never expose credential markers in public errors/plans',()=>{
 const secret='PRIVATE_PROVIDER_CREDENTIAL_MARKER';for(const source of [{...image,schedule:{...image.schedule,provider_key:secret}},{...image,schedule:{...image.schedule,frequency:{credential:secret}}}]){try{createSchedulePlan(source);assert.fail('unsafe DTO was accepted');}catch(error){assert(error instanceof SchedulerWorkerError);assert(!error.message.includes(secret));}}
 const plan=createSchedulePlan({...image,schedule:{...image.schedule,frequency:secret}});assert.equal(plan.kind,'invalid');assert(!JSON.stringify(plan).includes(secret));
});
