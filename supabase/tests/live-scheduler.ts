/** Definition-only real-application QA fixtures. Root owns scheduler SQL,
 * registry, dispatch/Cron, delivery claims and namespace cleanup. This helper
 * issues only real owner-cookie app requests; it never executes a worker or
 * fabricates its author, ticket, lease, human SID or broker result. */
import {createApplication} from '../functions/_shared/application.ts';
import {createSessionVault} from '../functions/_shared/vault.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';
import {Scheduler,scheduleDatetime,scheduleISO} from '../functions/_shared/scheduler.ts';
import {liveScope} from './live-domain.ts';
import type {LiveConfig} from './live-domain.ts';

export type SchedulerFixture={workspaceId:string;databaseId:string;rowId:string;automationId:string;scheduledAt:string;runId:string;expectedRowTitle:string;expectedPageTitle:string};
export type LiveSchedulerConfig=LiveConfig&{schedulerFixture?:SchedulerFixture};
export type SchedulerEffects={fixture:SchedulerFixture;checks:string[];createdRowId:string;createdPageId:string;nextRunAt:string;counts:{sourceRows:1;createdRows:1;createdPages:1;runs:1;observations:2}};
export class LiveSchedulerError extends Error {
  code:string;status:number;checks:string[];fixture:Partial<SchedulerFixture>;
  constructor(code:string,checks:string[]=[],fixture:Partial<SchedulerFixture>={},status=503){super('Disposable scheduler verification could not complete');this.code=code;this.status=status;this.checks=[...checks];this.fixture={...fixture};}
}
const DB='qa-scheduler-database',ROW='qa-scheduler-source-row',DBNAME='QA scheduler fixture database',NAME='QA scheduled broker actions',SOURCE='QA scheduler source row';
const ROWTITLE='QA scheduler created row',PAGETITLE='QA scheduler created page',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RPC=new Set(['vault_create','vault_read','resolve_profile','vault_claim_refresh','vault_finish_refresh','vault_release_refresh','vault_revoke','vault_finish_logout','store_snapshot','store_commit']);
const fixtureKeys=['workspaceId','databaseId','rowId','automationId','scheduledAt','runId','expectedRowTitle','expectedPageTitle'];
const properties=[{id:'name',name:'Name',type:'title'},{id:'counter',name:'Counter',type:'number'}],privateACL={default:'private',inherit:false,members:{},groups:{}};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function check(value:unknown,code:string):asserts value{if(!value)throw new LiveSchedulerError(code);}
function id(value:unknown):asserts value is string{check(typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value),'QA_ENTITY_ID');}
function normalized(value:unknown):string{return scheduleISO(scheduleDatetime(value,'QA scheduled time'));}
function actions(fixture:Pick<SchedulerFixture,'expectedRowTitle'|'expectedPageTitle'>){return [{type:'set_property',property_id:'counter',value:2},{type:'create_row',values:{name:fixture.expectedRowTitle}},{type:'create_page',title:fixture.expectedPageTitle}];}
function validateFixture(value:unknown,workspaceId:string):SchedulerFixture{
  check(object(value)&&Object.keys(value).length===fixtureKeys.length&&fixtureKeys.every(key=>Object.hasOwn(value,key))&&value.workspaceId===workspaceId,'QA_FIXTURE_SCOPE');
  for(const field of ['databaseId','rowId','automationId'])id(value[field]);
  check(value.databaseId===DB&&value.rowId===ROW&&value.expectedRowTitle===ROWTITLE&&value.expectedPageTitle===PAGETITLE,'QA_FIXTURE_IDENTITIES');
  check(typeof value.scheduledAt==='string'&&normalized(value.scheduledAt)===value.scheduledAt&&typeof value.runId==='string'&&/^[a-f0-9]{64}$/.test(value.runId)&&value.runId===Scheduler._run_id(value.automationId,value.scheduledAt),'QA_FIXTURE_SLOT');
  return {...value} as SchedulerFixture;
}
function runtime(config:LiveConfig,passwords:readonly string[],guardedFetch:typeof fetch){
  const scope=liveScope(config);check(/^fountain-qa-cloud-scheduler-[a-z0-9][a-z0-9_-]{0,100}$/.test(scope.workspaceId),'QA_SCHEDULER_NAMESPACE');
  check(typeof guardedFetch==='function'&&Array.isArray(passwords)&&[2,3].includes(passwords.length)&&passwords.every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)),'QA_ARGUMENTS');
  const cookies:string[]=[],checks:string[]=[],deadline=Date.now()+110000,appOrigin='https://fountain-qa.example.invalid';let calls=0,closing=false,sessionValue:Record<string,any>|null=null;
  const fetchQA:typeof fetch=async(input,init)=>{
    check(closing||Date.now()<deadline,'QA_PHASE_BUDGET');check(++calls<=512,'QA_FETCH_LIMIT');
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);check(target.origin===scope.supabaseUrl&&!target.username&&!target.password&&!target.hash,'QA_FETCH_ORIGIN');
    if(target.pathname.startsWith('/rest/v1/rpc/fountain_cloud_')){
      check(RPC.has(target.pathname.slice('/rest/v1/rpc/fountain_cloud_'.length))&&init?.method==='POST'&&typeof init.body==='string'&&!target.search,'QA_RPC_SCOPE');let body;
      try{body=JSON.parse(init!.body as string);}catch{throw new LiveSchedulerError('QA_RPC_BODY');}
      check(object(body)&&(body.p_workspace_id===scope.workspaceId||body.p_context?.workspaceId===scope.workspaceId)&&(!Object.hasOwn(body,'p_workspace_id')||body.p_workspace_id===scope.workspaceId)&&(!Object.hasOwn(body,'p_context')||body.p_context.workspaceId===scope.workspaceId),'QA_RPC_WORKSPACE');
    }else{
      check(['/auth/v1/token','/auth/v1/user','/auth/v1/logout'].includes(target.pathname),'QA_AUTH_PATH');
      if(target.pathname==='/auth/v1/token'&&target.searchParams.get('grant_type')==='password'){
        let body;try{body=JSON.parse(init!.body as string);}catch{throw new LiveSchedulerError('QA_AUTH_BODY');}
        check(body.email===scope.emails[0]&&body.password===passwords[0],'QA_OWNER_LOGIN_SCOPE');
      }
    }
    return guardedFetch(input,{...init,redirect:'error'});
  };
  const app=createApplication({...scope,origins:[appOrigin],fetch:fetchQA,setupEnabled:false,env:{}}),vault=createSessionVault({...scope,fetch:fetchQA});
  async function bounded(response:Response):Promise<Record<string,any>>{
    const reader=response.body?.getReader();check(reader,'QA_JSON');let length=0;const chunks:Uint8Array[]=[];
    try{for(;;){const part=await reader!.read();if(part.done)break;length+=part.value.length;check(length<=2*1024*1024,'QA_JSON_LIMIT');chunks.push(part.value);}const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(object(value),'QA_JSON');return value;}
    catch{throw new LiveSchedulerError('QA_JSON');}finally{await reader!.cancel().catch(()=>{});reader!.releaseLock();}
  }
  async function raw(cookie:string|null,method:string,path:string,body?:unknown):Promise<Response>{
    check(closing||Date.now()<deadline,'QA_PHASE_BUDGET');check(/^\/api\/[A-Za-z0-9_/-]+$/.test(path)&&!path.includes('..')&&['GET','POST','DELETE'].includes(method),'QA_ROUTE');
    return app(new Request(appOrigin+path,{method,headers:{Origin:appOrigin,'X-Fountain-Request':'1',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  }
  async function json(cookie:string,method:string,path:string,body:unknown=undefined,status=200):Promise<Record<string,any>>{
    const response=await raw(cookie,method,path,body);check(response.status===status,'QA_HTTP_'+status);return bounded(response);
  }
  async function login():Promise<string>{
    const response=await raw(null,'POST','/api/session',{email:scope.emails[0],password:passwords[0]}),cookie=response.headers.get('Set-Cookie')?.split(';')[0];if(cookie)cookies.push(cookie);
    check(response.status===200&&cookie&&/^fountain_session=[A-Za-z0-9_-]{43}$/.test(cookie),'QA_REAL_LOGIN');const value=await bounded(response);
    check(value.authenticated===true&&value.workspace_id===scope.workspaceId&&value.member?.id==='local'&&value.member.role==='owner'&&value.member.active===true,'QA_REAL_OWNER');
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(cookie!.slice('fountain_session='.length))),hash=[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join(''),entry=await vault.read(hash);
    check(entry&&entry.revokedAt===null&&entry.cacheBinding===value.cache_binding&&UUID.test(entry.userId)&&UUID.test(entry.authSessionId),'QA_REAL_VAULT');sessionValue=value;checks.push('real_owner_password_login_opaque_vault_and_current_workspace');return cookie!;
  }
  function bound(value:Record<string,any>):void{check(sessionValue&&value.workspace_id===scope.workspaceId&&value.current_member_id==='local'&&value.session_binding===sessionValue.cache_binding,'QA_API_SESSION_BINDING');}
  async function close():Promise<void>{
    closing=true;const ended=await Promise.allSettled(cookies.map(async cookie=>{const response=await raw(cookie,'DELETE','/api/session',{});check(response.status===200,'QA_LOGOUT');await response.body?.cancel();}));
    check(ended.every(result=>result.status==='fulfilled'),'QA_LOGOUT_PENDING');
  }
  return {scope,checks,json,login,bound,close};
}
function database(value:Record<string,any>,fixture:Pick<SchedulerFixture,'databaseId'>):void{
  check(value.database?.id===fixture.databaseId&&value.database.owner_id==='local'&&value.database.name===DBNAME&&value.database.teamspace_id==='general'&&value.database.access_level===4&&canonicalJSON(value.database.permissions)===canonicalJSON(privateACL)&&canonicalJSON(value.database.properties)===canonicalJSON(properties)&&Array.isArray(value.rows),'QA_DATABASE_CONTRACT');
}
function automation(value:Record<string,any>,fixture:SchedulerFixture):void{
  check(value.id===fixture.automationId&&value.name===NAME&&value.owner_id==='local'&&value.database_id===fixture.databaseId&&value.row_id===fixture.rowId&&value.trigger==='scheduled'&&value.enabled===true&&canonicalJSON(value.actions)===canonicalJSON(actions(fixture)),'QA_AUTOMATION_CONTRACT');
  check(value.schedule?.frequency==='minutes'&&value.schedule.interval===10&&value.schedule.timezone==='UTC'&&normalized(value.schedule.start_at)===fixture.scheduledAt,'QA_AUTOMATION_SCHEDULE');
}

/** New seed never adopts an existing object by name. Resume is permitted only
 * with Root's explicit complete fixture IDs and unchanged pre-dispatch state. */
export async function runSchedulerFixtures(config:LiveSchedulerConfig,passwords:readonly string[],guardedFetch:typeof fetch):Promise<SchedulerFixture>{
  const partial:Partial<SchedulerFixture>={databaseId:DB,rowId:ROW,expectedRowTitle:ROWTITLE,expectedPageTitle:PAGETITLE};let r:ReturnType<typeof runtime>|null=null,stage='CONFIGURATION';
  try{
    r=runtime(config,passwords,guardedFetch);partial.workspaceId=r.scope.workspaceId;const cookie=await r.login();let fixture:SchedulerFixture;
    if(config.schedulerFixture){fixture=validateFixture(config.schedulerFixture,r.scope.workspaceId);Object.assign(partial,fixture);}
    else{
      stage='EXISTING_OBJECT_GUARD';const workspace=await r.json(cookie,'GET','/api/workspace');r.bound(workspace);check(Array.isArray(workspace.databases)&&Array.isArray(workspace.pages)&&!workspace.databases.some(item=>item.id===DB||item.name===DBNAME)&&!workspace.pages.some(item=>item.title===PAGETITLE),'QA_AMBIGUOUS_EXISTING_FIXTURE');
      const current=await r.json(cookie,'GET','/api/automations');check(Array.isArray(current.automations)&&!current.automations.some(item=>item.name===NAME),'QA_AMBIGUOUS_EXISTING_AUTOMATION');
      stage='CREATE_DATABASE';const created=await r.json(cookie,'POST','/api/databases',{id:DB,name:DBNAME,properties,permissions:privateACL,teamspace_id:'general'},201);check(created.id===DB&&created.owner_id==='local','QA_CREATED_DATABASE');
      stage='CREATE_SOURCE_ROW';const row=await r.json(cookie,'POST','/api/databases/'+DB+'/rows',{id:ROW,properties:{name:SOURCE,counter:0}},201);check(row.id===ROW&&row.database_id===DB&&row.owner_id==='local'&&row.properties?.name===SOURCE&&row.properties.counter===0,'QA_CREATED_SOURCE_ROW');
      const start=scheduleISO(BigInt(Math.floor(Date.now()/1000)*1000-90000)*1000n);partial.scheduledAt=start;
      stage='CREATE_AUTOMATION';const saved=await r.json(cookie,'POST','/api/automations',{name:NAME,database_id:DB,row_id:ROW,trigger:'scheduled',enabled:true,schedule:{frequency:'minutes',interval:10,timezone:'UTC',start_at:start},actions:actions({expectedRowTitle:ROWTITLE,expectedPageTitle:PAGETITLE})},201);
      // Advanced.save allocates its own identity; a body.id would be ignored.
      id(saved.id);partial.automationId=saved.id;const scheduledAt=normalized(saved.next_run_at),runId=Scheduler._run_id(saved.id,scheduledAt);Object.assign(partial,{scheduledAt,runId});
      fixture=validateFixture(partial,r.scope.workspaceId);
    }
    stage='FRESH_API_BASELINE';const table=await r.json(cookie,'GET','/api/databases/'+fixture.databaseId);r.bound(table);database(table,fixture);
    check(table.rows.length===1&&table.rows[0].id===fixture.rowId&&table.rows[0].owner_id==='local'&&table.rows[0].properties?.name===SOURCE&&table.rows[0].properties.counter===0,'QA_BASELINE_SOURCE_ROW');
    const saved=await r.json(cookie,'GET','/api/automations/'+fixture.automationId);automation(saved,fixture);check(normalized(saved.next_run_at)===fixture.scheduledAt&&scheduleDatetime(fixture.scheduledAt,'due')<=BigInt(Date.now()-60000)*1000n,'QA_BASELINE_DUE_SLOT');
    const history=await r.json(cookie,'GET','/api/automations/'+fixture.automationId+'/runs');check(Array.isArray(history.runs)&&history.runs.length===0,'QA_BASELINE_UNEXECUTED');
    const workspace=await r.json(cookie,'GET','/api/workspace');r.bound(workspace);check(!workspace.pages.some(item=>item.title===fixture.expectedPageTitle),'QA_BASELINE_NO_GENERATED_PAGE');r.checks.push('actual_api_database_source_row_and_three_action_due_automation_verified');return {...fixture};
  }catch(error){throw new LiveSchedulerError('LIVE_SCHEDULER_SEED_'+stage+'_'+(error instanceof LiveSchedulerError?error.code:'FAILED'),r?.checks??[],partial);}
  finally{if(r)try{await r.close();}catch{throw new LiveSchedulerError('LIVE_SCHEDULER_SEED_LOGOUT_PENDING',r.checks,partial);}}
}

/** Observe effects after Root's actual dispatch. Two independent API reads
 * check duplicates; they do NOT by themselves prove Cron/delivery/SQL locking. */
export async function verifySchedulerEffects(config:LiveConfig,passwords:readonly string[],input:SchedulerFixture,guardedFetch:typeof fetch):Promise<SchedulerEffects>{
  let r:ReturnType<typeof runtime>|null=null,fixture:SchedulerFixture|undefined,stage='CONFIGURATION';
  try{
    r=runtime(config,passwords,guardedFetch);fixture=validateFixture(input,r.scope.workspaceId);const cookie=await r.login();let found:{rowId:string;pageId:string;next:string}|null=null;
    for(let observation=0;observation<2;observation++){
      stage='DATABASE_EFFECTS';const table=await r.json(cookie,'GET','/api/databases/'+fixture.databaseId);r.bound(table);database(table,fixture);
      const source=table.rows.filter(row=>row.id===fixture!.rowId),created=table.rows.filter(row=>row.properties?.name===fixture!.expectedRowTitle);
      check(table.rows.length===2&&source.length===1&&source[0].owner_id==='local'&&source[0].properties?.name===SOURCE&&source[0].properties.counter===2&&created.length===1&&created[0].id!==fixture.rowId&&created[0].owner_id==='local','QA_EXACT_ROW_EFFECTS');
      stage='PAGE_EFFECTS';const workspace=await r.json(cookie,'GET','/api/workspace');r.bound(workspace);const pages=workspace.pages.filter(page=>page.title===fixture!.expectedPageTitle);
      check(pages.length===1&&pages[0].owner_id==='local'&&pages[0].archived===false&&pages[0].access_level===4,'QA_EXACT_PAGE_EFFECTS');id(created[0].id);id(pages[0].id);
      const detail=await r.json(cookie,'GET','/api/pages/'+pages[0].id);check(detail.page?.id===pages[0].id&&detail.page.title===fixture.expectedPageTitle&&detail.page.owner_id==='local','QA_CREATED_PAGE_DETAIL');
      stage='AUTOMATION_EFFECTS';const saved=await r.json(cookie,'GET','/api/automations/'+fixture.automationId);automation(saved,fixture);const next=normalized(saved.next_run_at);check(scheduleDatetime(next,'next')>scheduleDatetime(fixture.scheduledAt,'due')&&saved.last_run_status==='succeeded','QA_ADVANCED_NEXT_SLOT');
      const advanced=await r.json(cookie,'GET','/api/advanced'),matches=advanced.automations?.filter(item=>item.id===fixture!.automationId);check(Array.isArray(matches)&&matches.length===1,'QA_ADVANCED_AUTOMATION_UNIQUE');automation(matches[0],fixture);check(normalized(matches[0].next_run_at)===next,'QA_ADVANCED_NEXT_MATCH');
      stage='RUN_EFFECTS';const history=await r.json(cookie,'GET','/api/automations/'+fixture.automationId+'/runs');check(Array.isArray(history.runs)&&history.runs.length===1,'QA_EXACT_RUN_COUNT');const run=history.runs[0];
      check(run.id===fixture.runId&&run.automation_id===fixture.automationId&&run.status==='succeeded'&&normalized(run.scheduled_at)===fixture.scheduledAt&&normalized(run.next_run_at)===next&&normalized(run.started_at)===normalized(run.finished_at)&&normalized(saved.last_run_at)===normalized(run.finished_at)&&!Object.hasOwn(run,'result')&&!run.error,'QA_EXACT_SUCCEEDED_RUN');
      const current={rowId:created[0].id,pageId:pages[0].id,next};if(found)check(canonicalJSON(current)===canonicalJSON(found),'QA_DUPLICATE_EFFECTS');found=current;
    }
    check(found,'QA_EFFECTS_MISSING');r.checks.push('actual_owner_api_original_counter_2_one_created_row_one_page_one_succeeded_slot_and_advanced_next_time','second_api_observation_has_identical_ids_counts_and_no_duplicate_effects');
    return {fixture:{...fixture},checks:[...r.checks],createdRowId:found.rowId,createdPageId:found.pageId,nextRunAt:found.next,counts:{sourceRows:1,createdRows:1,createdPages:1,runs:1,observations:2}};
  }catch(error){throw new LiveSchedulerError('LIVE_SCHEDULER_VERIFY_'+stage+'_'+(error instanceof LiveSchedulerError?error.code:'FAILED'),r?.checks??[],fixture??{});}
  finally{if(r)try{await r.close();}catch{throw new LiveSchedulerError('LIVE_SCHEDULER_VERIFY_LOGOUT_PENDING',r.checks,fixture??{});}}
}
