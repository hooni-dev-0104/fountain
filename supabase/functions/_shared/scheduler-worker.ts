/** Pure planning and staged execution for a SQL-bound scheduled slot.
 * No ticket transport, grant issuance, broker settlement or SQL lives here.
 * definitionHash/dueHash are opaque PostgreSQL jsonb::text attestations, NOT JS
 * canonical hashes. The provider MUST check both against the current broker at
 * EVERY NEW snapshot/commit, with current grant/author/lease/generation. Exact
 * accepted receipts still reauthorize before ACK but must survive self-nextAt
 * advancement. Neither this module nor the scalar guard substitutes for SQL.
 * A calendar plan never grants data authority; unavailable authors and control
 * outcomes must be settled by the separate control-only broker RPC.
 */
import {Access,APIError,ROLES,clone,get,has,is_object,valid_id} from './access.ts';
import type {Entity} from './access.ts';
import {Workspace} from './core.ts';
import {Advanced} from './advanced.ts';
import {Scheduler,next_occurrence,scheduleDatetime,scheduleISO,validate_schedule} from './scheduler.ts';
import {MissingSelection,ServiceStore,StoreError,canonicalJSON,mergeSelection,normalizeSelection,validateServiceContext} from './store.ts';
import type {AutomationContext,Selection,ServiceProvider} from './store.ts';

export type SafeSchedule = {frequency?:string;interval?:number;timezone?:string;start_at?:string;end_at?:string};
export type PlanningImage = {
  jobId:string;workspaceId:string;automationId:string;incarnation:string;
  definitionVersion:number;definitionHash:string;dueHash:string;fixedNow:string;revision:number;
  enabled:boolean;trigger:string;schedule:SafeSchedule|null;nextRunAt:string|null;
  malformed:boolean;authorAvailable:boolean;
};
export type SchedulePlan = {kind:'due'|'defer'|'complete'|'invalid';scheduledAt:string|null;runId:string;nextRunAt:string|null;error?:string};
export type BoundClaim = {
  jobId:string;workspaceId:string;automationId:string;definitionVersion:number;
  definitionHash:string;dueHash:string;fixedNow:string;scheduledAt:string;runId:string;nextRunAt:string|null;
};
export type ScheduledResult = {revision:number;runId:string;status:'succeeded'|'failed'};
export type ScheduledOptions = {selection?:Selection;maxSelectionRounds?:number;maxConflicts?:number};
export class SchedulerWorkerError extends StoreError {
  constructor(code:string,status=409){super(status,code,status===503?'Scheduled execution is unavailable':'Scheduled claim is invalid or no longer current');this.name='SchedulerWorkerError';}
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
function check(value:unknown,code='INVALID_SCHEDULE_DTO',status=code==='INVALID_SCHEDULE_DTO'?400:409):asserts value{if(!value)throw new SchedulerWorkerError(code,status);}
function object(value:unknown,keys:string[]):asserts value is Entity {
  check(is_object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>has(value,key)));
  plain(value);
}
function plain(value:unknown):asserts value is Entity {
  check(is_object(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null));
  check(Object.getOwnPropertySymbols(value).length===0&&Object.values(Object.getOwnPropertyDescriptors(value)).every(item=>!item.get&&!item.set));
}
function jsonDTO(value:unknown):void {
  // JSON validation only: this output is never used to calculate SQL hashes.
  try{check(new TextEncoder().encode(canonicalJSON(value)).length<=16384);}catch{throw new SchedulerWorkerError('INVALID_SCHEDULE_DTO',400);}
}
function date(value:unknown):asserts value is string {
  check(typeof value==='string'&&value.length<=100);
  try{scheduleDatetime(value,'scheduled datetime');}catch{throw new SchedulerWorkerError('INVALID_SCHEDULE_DTO',400);}
}
const normalized=(value:string)=>scheduleISO(scheduleDatetime(value,'scheduled datetime'));
function identity(value:unknown):void{check(valid_id(value));}
function hash(value:unknown):void{check(typeof value==='string'&&HASH.test(value));}
function uuid(value:unknown):void{check(typeof value==='string'&&UUID.test(value));}
function common(value:Entity):void {
  uuid(value.jobId);identity(value.workspaceId);identity(value.automationId);check(positive(value.definitionVersion));hash(value.definitionHash);hash(value.dueHash);date(value.fixedNow);
}
export function validatePlanningImage(input:unknown):PlanningImage {
  object(input,['jobId','workspaceId','automationId','incarnation','definitionVersion','definitionHash','dueHash','fixedNow','revision','enabled','trigger','schedule','nextRunAt','malformed','authorAvailable']);
  common(input);uuid(input.incarnation);check(Number.isSafeInteger(input.revision)&&input.revision>=0);
  check(typeof input.enabled==='boolean'&&typeof input.malformed==='boolean'&&typeof input.authorAvailable==='boolean'&&typeof input.trigger==='string'&&input.trigger.length<=100);
  check(input.nextRunAt===null||typeof input.nextRunAt==='string'&&input.nextRunAt.length<=100);
  if(input.schedule!==null){
    plain(input.schedule);check(Object.keys(input.schedule).every(key=>['frequency','interval','timezone','start_at','end_at'].includes(key)));
    for(const [key,value]of Object.entries(input.schedule))check(key==='interval'?typeof value==='number'&&Number.isFinite(value):typeof value==='string'&&value.length<=100);
  }
  jsonDTO(input);return Object.freeze(clone(input)) as PlanningImage;
}
export function validateBoundClaim(input:unknown):BoundClaim {
  object(input,['jobId','workspaceId','automationId','definitionVersion','definitionHash','dueHash','fixedNow','scheduledAt','runId','nextRunAt']);common(input);date(input.scheduledAt);hash(input.runId);
  check(input.nextRunAt===null||typeof input.nextRunAt==='string');if(input.nextRunAt!==null)date(input.nextRunAt);
  check(scheduleDatetime(input.scheduledAt,'slot')<=scheduleDatetime(input.fixedNow,'now'),'CLAIM_NOT_DUE');
  check(input.nextRunAt===null||scheduleDatetime(input.nextRunAt,'next')>scheduleDatetime(input.fixedNow,'now'),'INVALID_CLAIM_NEXT');
  check(input.runId===Scheduler._run_id(input.automationId,normalized(input.scheduledAt)),'CLAIM_RUN_MISMATCH');
  jsonDTO(input);return Object.freeze(clone(input)) as BoundClaim;
}
/** Calendar classification only. authorAvailable=false does NOT create a Store
 * or manufacture a principal: SQL prepare must select control-only settlement. */
export function createSchedulePlan(input:unknown):SchedulePlan {
  const image=validatePlanningImage(input);check(image.enabled&&image.trigger==='scheduled','JOB_NOT_ACTIVE');
  const invalid=(error:string):SchedulePlan=>({kind:'invalid',scheduledAt:null,runId:Scheduler._run_id(image.automationId,'invalid-schedule'),nextRunAt:null,error});
  if(image.malformed)return invalid('Invalid schedule metadata');
  try{
    const schedule=validate_schedule(image.schedule),due=scheduleDatetime(image.nextRunAt||schedule.start_at,'next_run_at'),now=scheduleDatetime(image.fixedNow,'now'),scheduledAt=scheduleISO(due),runId=Scheduler._run_id(image.automationId,scheduledAt);
    if(has(schedule,'end_at')&&due>scheduleDatetime(schedule.end_at,'end_at'))return {kind:'complete',scheduledAt,runId,nextRunAt:null};
    if(due>now)return {kind:'defer',scheduledAt,runId,nextRunAt:scheduledAt};
    return {kind:'due',scheduledAt,runId,nextRunAt:next_occurrence(schedule,scheduleISO(now))};
  }catch(error){if(error instanceof APIError)return invalid(error.message.slice(0,1000));throw error;}
}
/** SQL attestation is indispensable: equal scalar slots alone do not detect
 * changed actions, conditions, schema or ACL. Never replace the provider checks
 * with a JS hash over the snapshot. All local guards run BEFORE any action. */
export function assertClaimedSlot(store:ServiceStore,context:AutomationContext,claim:BoundClaim):void {
  check(store.context.kind==='automation'&&canonicalJSON(store.context)===canonicalJSON(context),'CLAIM_CONTEXT_MISMATCH');
  check(store.meta('workspace_id')===claim.workspaceId&&store.principal.id===context.memberId&&get(store.principal,'active',true)===true&&ROLES.has(store.principal.role),'CLAIM_CONTEXT_MISMATCH');
  const automation=store.get('automation',claim.automationId);
  check(automation&&automation.id===context.resourceId&&automation.owner_id===context.memberId,'CLAIM_AUTHOR_CHANGED');
  check(automation.trigger==='scheduled'&&get(automation,'enabled',true)===true,'JOB_NOT_ACTIVE');
  const member=store.get('member',context.memberId);
  check(member&&member.id===context.memberId&&get(member,'active',true)===true&&ROLES.has(member.role)&&member.role===store.principal.role,'CLAIM_AUTHOR_UNAVAILABLE',403);
  let plan:SchedulePlan;
  try{
    const schedule=validate_schedule(automation.schedule),due=scheduleDatetime(get(automation,'next_run_at')||schedule.start_at,'next_run_at'),scheduledAt=scheduleISO(due);
    check(due<=scheduleDatetime(claim.fixedNow,'now')&&(!has(schedule,'end_at')||due<=scheduleDatetime(schedule.end_at,'end_at')),'CLAIM_SLOT_CHANGED');
    plan={kind:'due',scheduledAt,runId:Scheduler._run_id(automation.id,scheduledAt),nextRunAt:next_occurrence(schedule,normalized(claim.fixedNow))};
  }catch(error){if(error instanceof SchedulerWorkerError||error instanceof MissingSelection)throw error;throw new SchedulerWorkerError('CLAIM_SLOT_CHANGED');}
  check(plan.scheduledAt===normalized(claim.scheduledAt)&&plan.runId===claim.runId&&plan.nextRunAt===(claim.nextRunAt===null?null:normalized(claim.nextRunAt)),'CLAIM_SLOT_CHANGED');
  check(store.get('automation_run',claim.runId)===null,'RUN_ALREADY_EXISTS');
}
/** Bounded fresh-snapshot replay. Only a known CAS conflict may re-run pure
 * actions; an uncertain commit retries the SAME ServiceStore request exactly.
 * Result deliberately excludes run.result/error and private action payloads. */
export async function executeScheduledClaim(inputContext:AutomationContext,inputClaim:unknown,provider:ServiceProvider,options:ScheduledOptions={}):Promise<ScheduledResult> {
  const context=validateServiceContext(inputContext);check(context.kind==='automation','CLAIM_CONTEXT_MISMATCH');const claim=validateBoundClaim(inputClaim);
  check(context.workspaceId===claim.workspaceId&&context.resourceId===claim.automationId&&context.runId===claim.runId,'CLAIM_CONTEXT_MISMATCH');
  const rounds=options.maxSelectionRounds??64,conflicts=options.maxConflicts??3;
  check(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=128&&Number.isSafeInteger(conflicts)&&conflicts>=1&&conflicts<=5,'INVALID_WORKER_OPTIONS',400);
  let selected=mergeSelection({kinds:['group'],ids:{automation:[claim.automationId],member:[context.memberId],automation_run:[claim.runId],settings:['workspace']}},options.selection??{}),collisions=0;
  for(let round=0;round<rounds;round++){
    let store:ServiceStore;
    try{store=await ServiceStore.open(provider,context,selected,{clock:()=>Date.parse(claim.fixedNow)});}
    catch(error){if(error instanceof StoreError&&error.code==='REVISION_CONFLICT'&&++collisions<conflicts)continue;throw error;}
    let status:'succeeded'|'failed';
    try{status=store.transaction(()=>{
      assertClaimedSlot(store,context,claim);
      // Advanced construction may initialize settings; a background data lease
      // must not silently create an absent workspace configuration.
      check(store.get('settings','workspace')!==null,'WORKSPACE_CONFIGURATION_MISSING',503);
      const access=new Access(store,store.principal),workspace=new Workspace(store,{actor:context.memberId,access}),advanced=new Advanced(store,workspace,{actor:context.memberId,access,cloud:true});
      const runs=new Scheduler(store,(id,body,actor)=>{check(id===claim.automationId&&actor===context.memberId,'CLAIM_CONTEXT_MISMATCH');return advanced.run_as_author(id,body);}).tick_one(claim.automationId,claim.fixedNow);
      check(runs.length===1&&runs[0].id===claim.runId&&['succeeded','failed'].includes(runs[0].status)&&runs[0].next_run_at===(claim.nextRunAt===null?null:normalized(claim.nextRunAt)),'CLAIM_SLOT_CHANGED');
      return runs[0].status;
    });}
    catch(error){
      if(!(error instanceof MissingSelection))throw error;const expanded=mergeSelection(selected,error.selection);
      check(canonicalJSON(expanded)!==canonicalJSON(normalizeSelection(selected)),'SELECTION_STALLED',503);selected=expanded;continue;
    }
    try{
      let committed:{revision:number};try{committed=await store.commit();}catch(error){if(store.state!=='uncertain')throw error;committed=await store.commit();}
      return {revision:committed.revision,runId:claim.runId,status};
    }catch(error){if(error instanceof StoreError&&error.code==='REVISION_CONFLICT'&&++collisions<conflicts)continue;throw error;}
  }
  throw new SchedulerWorkerError('SELECTION_LIMIT',503);
}
