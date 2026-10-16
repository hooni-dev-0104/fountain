/** Definition-only helpers for Root's sealed REAL PostgreSQL service QA.
 * Importing performs no I/O and issues no grant, lease, token or human session.
 * Root owns fixture seeds, real authorities, outer nonce/fetch gates and cleanup.
 */
import {Access} from '../functions/_shared/access.ts';
import {CloudStore,ServiceStore,StoreError,canonicalJSON,createServiceProvider,createStoreProvider,normalizeSelection,validateContext,validateServiceContext} from '../functions/_shared/store.ts';
import type {AutomationContext,ScimContext,MaintenanceContext,ServiceDataContext,StoreContext,ServiceCommitRequest,CommitRequest,SnapshotPage,NormalizedSelection,ServiceProvider} from '../functions/_shared/store.ts';

type Context=ServiceDataContext|StoreContext;
type Commit<C>={context:C;expectedRevision:number;transactionId:string;digest:string;canonical:string;changes:ServiceCommitRequest['changes']};
type Snapshot<C>={context:C;selection:NormalizedSelection;cursor?:unknown;expectedRevision?:number};
type Provider<C>={snapshot:(request:Snapshot<C>)=>Promise<SnapshotPage>;commit:(request:Commit<C>)=>Promise<{revision:number}>};
type Store=ServiceStore|CloudStore;
export type ServiceReceiptCheckpoint={request:ServiceCommitRequest;revision:number};
export type HumanReceiptCheckpoint={request:CommitRequest;revision:number};
/** SERVER-PRIVATE only. Keep this object within the same sealed invocation (for
 * example across Root's NDJSON/MCP barrier); never serialize it to a response. */
export type LiveServiceCheckpoints={automation?:ServiceReceiptCheckpoint;scim?:ServiceReceiptCheckpoint;human?:HumanReceiptCheckpoint};
export type LiveServicesConfig={
  supabaseUrl:string;serviceKey:string;workspaceId:string;fetch:typeof fetch;clockMs:number;
  contexts:{automation:AutomationContext;scim:ScimContext;maintenance:MaintenanceContext};
  human?:StoreContext;checkpoints:LiveServiceCheckpoints;
};
export type ServicesPhase='automation'|'scim'|'automation-self-disable'|'automation-replay'|'scim-replay'|'automation-denied'|'scim-denied'|'automation-replay-denied'|'scim-replay-denied'|'maintenance-denied'|'human-regression'|'last-owner-denied';
export type PublicServiceReceipt={kind:'automation'|'scim'|'human';transactionId:string;digest:string;expectedRevision:number;revision:number;changes:number};
export type LiveServicesResult={phase:ServicesPhase;checks:string[];rpcCalls:number;receipts:PublicServiceReceipt[];principal?:{memberId:string;role:string}};
export class LiveServicesError extends Error {
  code:string;status:number;checks:string[];
  constructor(code:string,checks:string[]=[],status=503){super('Disposable service verification could not complete');this.code=code;this.status=status;this.checks=[...checks];}
}
const phases=new Set<ServicesPhase>(['automation','scim','automation-self-disable','automation-replay','scim-replay','automation-denied','scim-denied','automation-replay-denied','scim-replay-denied','maintenance-denied','human-regression','last-owner-denied']);
const PAGE='qa-service-page',PRIVATE='qa-service-owner-private',enc=new TextEncoder();
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function check(value:unknown,code:string):asserts value{if(!value)throw new LiveServicesError(code);}
const sha=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
function safeReceipt(kind:PublicServiceReceipt['kind'],checkpoint:{request:Commit<Context>;revision:number}):PublicServiceReceipt{
  const request=checkpoint.request;return {kind,transactionId:request.transactionId,digest:request.digest,expectedRevision:request.expectedRevision,revision:checkpoint.revision,changes:request.changes.length};
}
function scope(config:LiveServicesConfig){
  try{
    const url=new URL(config.supabaseUrl);
    check(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','QA_URL');
    check(typeof config.workspaceId==='string'&&/^fountain-qa-cloud-service-[a-z0-9][a-z0-9_-]{0,100}$/.test(config.workspaceId),'QA_WORKSPACE');
    check(typeof config.serviceKey==='string'&&config.serviceKey.length>0&&typeof config.fetch==='function'&&object(config.checkpoints),'QA_CONFIGURATION');
    check(Number.isSafeInteger(config.clockMs)&&config.clockMs>=0&&config.clockMs<=253402300799999,'QA_CLOCK');
    const automation=validateServiceContext(config.contexts.automation),scim=validateServiceContext(config.contexts.scim),maintenance=validateServiceContext(config.contexts.maintenance);
    check(automation.kind==='automation'&&automation.memberId==='child'&&scim.kind==='scim'&&scim.memberId==='local'&&maintenance.kind==='maintenance','QA_CURRENT_AUTHOR');
    check([automation,scim,maintenance].every(context=>context.workspaceId===config.workspaceId),'QA_CONTEXT_WORKSPACE');
    const human=config.human?validateContext(config.human):undefined;
    if(human)check(human.workspaceId===config.workspaceId&&human.memberId==='local','QA_HUMAN_WORKSPACE');
    return {url:url.origin,automation,scim,maintenance,human};
  }catch{throw new LiveServicesError('QA_CONFIGURATION',[],400);}
}
function selection(config:LiveServicesConfig,extra:string){
  return {kinds:['group'],ids:{page:[PAGE,PRIVATE,extra],member:['child','local'],automation:[config.contexts.automation.resourceId]},metaKeys:['access_revision'],pageSize:2};
}
async function canonical(request:Commit<Context>):Promise<void>{
  check(request.canonical===canonicalJSON({context:request.context,expectedRevision:request.expectedRevision,changes:request.changes}),'QA_CANONICAL_REQUEST');
  check(request.digest===await sha(request.canonical),'QA_CANONICAL_SHA256');
}
/** Operator fault injection ONLY: drop one ACK after the real provider has
 * accepted the commit. It does not simulate/fabricate any business response and
 * does not prove an actual network failure. The retry still contacts real SQL. */
function dropOneAcceptedAck<C extends Context>(provider:Provider<C>,remember:(request:Commit<C>,revision:number)=>void){
  let captured:Commit<C>|null=null,calls=0,accepted:number|null=null;
  const wrapped:Provider<C>={snapshot:request=>provider.snapshot(request),commit:async request=>{
    await canonical(request);if(captured)check(canonicalJSON(request)===canonicalJSON(captured),'QA_EXACT_UNCERTAIN_RETRY');else captured=structuredClone(request);
    const result=await provider.commit(request);calls++;
    if(accepted===null){accepted=result.revision;remember(structuredClone(request),result.revision);throw new Error('QA_OPERATOR_DISCARDED_REAL_ACCEPTED_ACK');}
    check(result.revision===accepted,'QA_ACCEPTED_RECEIPT_REVISION');return result;
  }};
  return {provider:wrapped,read:()=>{check(captured&&accepted!==null&&calls>=2,'QA_ACCEPTED_ACK_CHECKPOINT');return {request:captured,revision:accepted,calls};}};
}
async function finishUncertain(store:Store):Promise<void>{
  let lost=false;try{await store.commit();}catch(error){check(error instanceof StoreError&&error.status===503&&error.code==='COMMIT_UNCERTAIN','QA_FORCED_ACK_ERROR');lost=true;}
  check(lost&&store.state==='uncertain','QA_UNCERTAIN_STATE');await store.commit();check(store.state==='committed','QA_UNCERTAIN_RESOLVED');
}
async function denied(action:()=>Promise<unknown>,code:string):Promise<void>{
  try{await action();}catch(error){check(error instanceof StoreError&&[401,403].includes(error.status),code);return;}throw new LiveServicesError(code);
}
function checkpoint(config:LiveServicesConfig,kind:'automation'|'scim',context:ServiceDataContext):ServiceReceiptCheckpoint{
  const value=config.checkpoints[kind];check(value&&Number.isSafeInteger(value.revision)&&value.revision>=0,'QA_ACCEPTED_CHECKPOINT_REQUIRED');
  check(canonicalJSON(value.request.context)===canonicalJSON(context)&&value.request.context.workspaceId===config.workspaceId,'QA_CHECKPOINT_AUTHORITY');return value;
}

/** No I/O occurs until explicitly invoked by Root. All responses are a whitelist
 * of check labels and receipt metadata; authorities/source documents stay private. */
export async function runServices(config:LiveServicesConfig,phase:ServicesPhase):Promise<LiveServicesResult>{
  const fixed=scope(config);check(phases.has(phase),'QA_PHASE');const checks:string[]=[],receipts:PublicServiceReceipt[]=[];let rpcCalls=0,stage='INITIALIZE';
  const allowedContexts=[fixed.automation,fixed.scim,...(fixed.human?[fixed.human]:[])].map(value=>canonicalJSON(value));
  const fetchQA:typeof fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    check(url.origin===fixed.url&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/rest\/v1\/rpc\/fountain_cloud_(?:service|store)_(?:snapshot|commit)$/.test(url.pathname),'QA_RPC_SCOPE');
    check(init?.method==='POST'&&typeof init.body==='string','QA_RPC_INPUT');let body;
    try{body=JSON.parse(init!.body as string);}catch{throw new LiveServicesError('QA_RPC_INPUT');}
    check(object(body)&&object(body.p_context)&&body.p_context.workspaceId===config.workspaceId&&allowedContexts.includes(canonicalJSON(body.p_context)),'QA_RPC_AUTHORITY');
    check(url.pathname.includes('/fountain_cloud_service_')?body.p_context.kind==='automation'||body.p_context.kind==='scim':!Object.hasOwn(body.p_context,'kind'),'QA_RPC_CONTRACT');
    rpcCalls++;return config.fetch(input,{...init,redirect:'error'});
  };
  const providerConfig={supabaseUrl:fixed.url,serviceKey:config.serviceKey,fetch:fetchQA,timeoutMs:15000};
  const service=()=>createServiceProvider(providerConfig),human=()=>createStoreProvider(providerConfig),options={clock:()=>config.clockMs};
  const result=(principal?:LiveServicesResult['principal']):LiveServicesResult=>({phase,checks:[...checks],rpcCalls,receipts:[...receipts],...(principal?{principal}:{})});
  async function replay(kind:'automation'|'scim',mustDeny=false):Promise<void>{
    const context=kind==='automation'?fixed.automation:fixed.scim,value=checkpoint(config,kind,context);await canonical(value.request);
    if(mustDeny){await denied(()=>service().commit(structuredClone(value.request)),'QA_REVOKED_RECEIPT_ACCEPTED');checks.push(kind+'_actual_accepted_receipt_rechecked_current_authority_and_denied');return;}
    for(let i=0;i<2;i++){const response=await service().commit(structuredClone(value.request));check(response.revision===value.revision,'QA_EXACT_RECEIPT_REPLAY');}
    receipts.push(safeReceipt(kind,value));checks.push(kind+'_two_fresh_provider_rpc_exact_receipt_replays');
  }
  async function crud(kind:'automation'|'scim'|'human'):Promise<LiveServicesResult>{
    const isHuman=kind==='human',context=isHuman?fixed.human:kind==='automation'?fixed.automation:fixed.scim;check(context,'QA_REAL_HUMAN_REQUIRED');
    const extra='qa-service-created-'+kind,target=kind==='automation'?PAGE:PRIVATE,selected=selection(config,extra);
    const open=(source?:Provider<Context>):Promise<Store>=>isHuman?CloudStore.open((source??human()) as ReturnType<typeof createStoreProvider>,context as StoreContext,selected,options):ServiceStore.open((source??service()) as ServiceProvider,context as ServiceDataContext,selected,options);
    const base=(isHuman?human():service()) as Provider<Context>;
    const injected=dropOneAcceptedAck(base,(request,revision)=>{
      if(isHuman)config.checkpoints.human={request:request as CommitRequest,revision};else config.checkpoints[kind]={request:request as ServiceCommitRequest,revision};
    });
    stage='CURRENT_PRINCIPAL';const store=await open(injected.provider),access=new Access(store,store.principal);
    check(store.principal.id===context.memberId&&store.principal.active===true&&store.principal.role===(kind==='automation'?'member':'owner'),'QA_CURRENT_PRINCIPAL');
    const own=store.get('page',PAGE),privatePage=store.get('page',PRIVATE);check(own&&privatePage&&own.owner_id==='child'&&privatePage.owner_id==='local','QA_PAGE_SEED');
    check(access.level('page',own)===4&&access.level('page',privatePage)===(kind==='automation'?0:4),'QA_CURRENT_PAGE_ACCESS');
    checks.push(kind+'_real_current_principal_and_access_'+(kind==='automation'?'4_0':'4_4'));
    const original=store.get('page',target);check(original&&typeof original.title==='string'&&access.level('page',original)===4&&!store.get('page',extra),'QA_CRUD_SEED');
    stage='CREATE_AND_ACCEPTED_ACK_DROP';const staged=store.put('page',{id:extra,title:'QA service created 😀',owner_id:context.memberId,permissions:{default:'private',inherit:false,members:{},groups:{}},parent_id:null,blocks:[]});
    store.put('page',{...original,title:'QA service '+kind+' accepted'});await finishUncertain(store);const captured=injected.read();
    receipts.push(safeReceipt(kind,{request:captured.request,revision:captured.revision}));checks.push(kind+'_operator_discarded_one_real_sql_ack_then_identical_uncertain_retry');
    stage='EXACT_REPLAY';if(!isHuman)await replay(kind);else{for(let i=0;i<2;i++){const ack=await human().commit(structuredClone(captured.request as CommitRequest));check(ack.revision===captured.revision,'QA_HUMAN_EXACT_REPLAY');}checks.push('human_two_fresh_provider_rpc_exact_receipt_replays');}
    stage='READ_CREATED';const fresh=await open(),created=fresh.get('page',extra);check(created&&await sha(canonicalJSON(created))===await sha(canonicalJSON(staged))&&fresh.get('page',target)?.title==='QA service '+kind+' accepted','QA_REAL_CREATE_READ_SHA');
    stage='UPDATE';check(new Access(fresh,fresh.principal).level('page',created)===4,'QA_UPDATE_ACCESS');fresh.put('page',{...created,title:'QA service updated 한글'});await fresh.commit();
    stage='DELETE_AND_RESTORE';const updated=await open();check(updated.get('page',extra)?.title==='QA service updated 한글','QA_REAL_UPDATE_READ');updated.delete('page',extra);updated.put('page',{...updated.get('page',target),title:original.title});await updated.commit();
    const final=await open();check(final.get('page',extra)===null&&final.get('page',target)?.title===original.title,'QA_REAL_DELETE_RESTORE');checks.push(kind+'_actual_page_create_read_sha_update_delete_and_original_title_restored');
    return result({memberId:store.principal.id,role:store.principal.role});
  }
  try{
    if(phase==='automation'||phase==='scim')return await crud(phase);
    if(phase==='human-regression'){check(fixed.human,'QA_REAL_HUMAN_REQUIRED');return await crud('human');}
    if(phase==='last-owner-denied'){
      stage='LAST_OWNER_ATOMIC_SEED';const selected={kinds:['group'],ids:{member:['local','unlinked-owner'],page:[PRIVATE]},pageSize:2};
      const before=await ServiceStore.open(service(),fixed.scim,selected,options),owner=before.get('member','local'),unlinked=before.get('member','unlinked-owner'),page=before.get('page',PRIVATE),revision=before.revision;
      check(before.principal.id==='local'&&before.principal.role==='owner'&&before.principal.active===true&&owner?.role==='owner'&&owner.active===true,'QA_LAST_OWNER_CURRENT_PRINCIPAL');
      check(unlinked?.id==='unlinked-owner'&&unlinked.role==='owner'&&unlinked.active===true,'QA_UNLINKED_LOGICAL_OWNER_SEED');
      const attemptedTitle='QA last-owner rejected title must not persist';
      check(page&&page.owner_id==='local'&&typeof page.title==='string'&&page.title!==attemptedTitle&&new Access(before,before.principal).level('page',page)===4,'QA_LAST_OWNER_PRIVATE_PAGE_SEED');
      // Root verifies that unlinked-owner has no identity_mapping. Stage the
      // visible page change FIRST so an actual SQL rejection must roll it back.
      before.put('page',{...page,title:attemptedTitle});before.put('member',{...owner,active:false});
      stage='LAST_OWNER_ATOMIC_COMMIT';let rejected=false;
      try{await before.commit();}catch(error){check(error instanceof StoreError&&error.status===409&&error.code==='LAST_OWNER_ACCOUNT','QA_LAST_OWNER_SQL_409');rejected=true;}
      check(rejected&&before.state==='aborted','QA_LAST_OWNER_NOT_REJECTED');checks.push('scim_actual_last_mapped_owner_rejected_despite_unlinked_logical_owner');
      stage='LAST_OWNER_FRESH_SQL_ROLLBACK';const after=await ServiceStore.open(service(),fixed.scim,selected,options),preserved=after.get('member','local');
      check(after.revision===revision&&after.get('page',PRIVATE)?.title===page.title&&preserved?.active===true&&preserved.role==='owner'&&after.principal.id==='local'&&after.principal.role==='owner'&&after.principal.active===true,'QA_LAST_OWNER_ATOMIC_ROLLBACK');
      checks.push('actual_last_owner_409_preserves_global_revision_prior_page_title_and_active_owner');return result({memberId:after.principal.id,role:after.principal.role});
    }
    if(phase==='maintenance-denied'){
      stage='MAINTENANCE_CLIENT_FENCE';const before=rpcCalls,real=service(),context=fixed.maintenance as unknown as ServiceDataContext;
      const operations=[()=>ServiceStore.open(real,context,{},options),()=>real.snapshot({context,selection:normalizeSelection({})}),async()=>{
        const request={context,expectedRevision:0,changes:[]},serialized=canonicalJSON(request);
        return real.commit({...request,transactionId:crypto.randomUUID(),canonical:serialized,digest:await sha(serialized)});
      }];
      for(const action of operations){let rejected=false;try{await action();}catch(error){check(error instanceof StoreError&&error.status===403&&error.code==='SERVICE_SCOPE_FORBIDDEN','QA_MAINTENANCE_TYPED_DENIAL');rejected=true;}check(rejected,'QA_MAINTENANCE_NOT_DENIED');}
      check(rpcCalls===before,'QA_MAINTENANCE_PROVIDER_CONTACTED');checks.push('maintenance_domain_store_snapshot_commit_rejected_before_provider_zero_io');return result();
    }
    if(phase==='automation-self-disable'){
      stage='SELF_DISABLE';const injected=dropOneAcceptedAck<ServiceDataContext>(service(),(request,revision)=>{config.checkpoints.automation={request,revision};});
      const store=await ServiceStore.open(injected.provider,fixed.automation,selection(config,'qa-service-created-automation'),options);
      check(store.principal.id==='child'&&store.principal.role==='member','QA_SELF_DISABLE_AUTHOR');const automation=store.get('automation',fixed.automation.resourceId);check(automation&&automation.owner_id==='child'&&automation.enabled===true,'QA_ENABLED_AUTOMATION_SEED');
      store.put('automation',{...automation,enabled:false,next_run_at:null});await finishUncertain(store);injected.read();checks.push('automation_self_disable_actual_commit_and_operator_dropped_ack_exact_retry');
      await replay('automation');await denied(()=>ServiceStore.open(service(),fixed.automation,selection(config,'qa-service-created-automation'),options),'QA_DISABLED_AUTOMATION_NEW_WORK');checks.push('disabled_automation_new_snapshot_denied_after_two_actual_receipt_replays');return result({memberId:store.principal.id,role:store.principal.role});
    }
    const kind=phase.startsWith('automation')?'automation':'scim';
    if(phase.endsWith('-replay-denied')){stage='REVOKED_ACCEPTED_RECEIPT';await replay(kind,true);return result();}
    if(phase.endsWith('-replay')){stage='EXACT_ACCEPTED_RECEIPT';await replay(kind);return result();}
    stage='CURRENT_AUTHORITY_DENIED';await denied(()=>ServiceStore.open(service(),kind==='automation'?fixed.automation:fixed.scim,selection(config,'qa-service-created-'+kind),options),'QA_EXPECTED_CURRENT_DENIAL');checks.push(kind+'_actual_snapshot_rechecks_changed_grant_member_or_lease_and_denies');return result();
  }catch(error){const code=error instanceof LiveServicesError?error.code:'FAILED';throw new LiveServicesError('LIVE_SERVICES_'+phase.toUpperCase().replaceAll('-','_')+'_'+stage+'_'+code,checks);}
}
