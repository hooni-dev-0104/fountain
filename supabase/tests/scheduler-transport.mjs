/** Actual loopback HTTP + production ticket transport/ServiceProvider/calendar/
 * ServiceStore/Workspace/Advanced/Scheduler. Durable SQL, grant authorization and
 * broker state below are a MODEL. No hosted SQL/Deno/Cron/provider QA is claimed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createSchedulerTransport,schedulerErrorResponse} from '../functions/_shared/scheduler-transport.ts';
import {createSchedulePlan} from '../functions/_shared/scheduler-worker.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';

const copy=structuredClone,secret='sb_secret_scheduler_http_fixture_only',marker='PRIVATE_SCHEDULER_SOURCE_MARKER';
const ticket=Buffer.alloc(32,23).toString('base64url'),sha=value=>createHash('sha256').update(value).digest('hex');
const stamp='2026-10-17T00:00:00.000000+00:00',fixedNow='2026-10-17T00:00:00.123456+00:00',automationId='예약?#% 😀';
const image={jobId:'11111111-1111-4111-8111-111111111111',workspaceId:'가족 空間',automationId,incarnation:'22222222-2222-4222-8222-222222222222',definitionVersion:1,definitionHash:'f'.repeat(64),dueHash:'e'.repeat(64),fixedNow,revision:5,enabled:true,trigger:'scheduled',schedule:{frequency:'minutes',interval:5,timezone:'UTC',start_at:'2026-10-17T00:00:00Z'},nextRunAt:null,malformed:false,authorAvailable:true};
const identity=(kind,id)=>canonicalJSON([kind,id]);
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function failure(status=409,message='BROKER_DENIED'){return Object.assign(Error(marker+' '+secret),{status,diagnostic:message});}
function legacyKey(role='service_role'){return Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role,exp:4102444800})).toString('base64url')+'.fixture_signature';}
class BrokerModel {
 constructor(source=image){this.image=copy(source);this.revision=source.revision;this.invocation=null;this.bound=null;this.done=false;this.active=true;this.control=false;this.prepareReceipts=new Map();this.commitReceipts=new Map();this.records=new Map();this.metadata=new Map([['workspace_id',source.workspaceId]]);this.calls=[];this.faults=new Map();this.responseTransform=null;this.prepareConflicts=0;this.conflictMessage='REVISION_CONFLICT';this.afterConflict=null;this.beforeAction=null;
  this.seed('member',{id:'alice',name:'현재 작성자',email:'alice@fixture.invalid',role:'member',active:true});this.seed('member',{id:'bob',name:'소유자',email:'bob@fixture.invalid',role:'owner',active:true});
  this.seed('settings',{id:'workspace',name:marker,disable_export:false});this.seed('teamspace',{id:'general',visibility:'open',members:['alice','bob']});
  this.seed('database',{id:'projects',owner_id:'alice',name:marker,properties:[{id:'name',name:'이름',type:'title'},{id:'n',name:'숫자',type:'number'}],permissions:{default:'private',members:{},groups:{}}});
  this.seed('row',{id:'target',database_id:'projects',owner_id:'alice',properties:{name:marker,n:0},parent_row_id:null,depends_on:[]});
  this.seed('automation',{id:source.automationId,owner_id:'alice',trigger:'scheduled',enabled:true,schedule:copy(source.schedule),next_run_at:source.nextRunAt,database_id:'projects',row_id:'target',actions:[{type:'set_property',property_id:'n',value:2},{type:'create_row',values:{name:marker}},{type:'create_page',title:marker}]});
 }
 seed(kind,value){const data={...copy(value),created_at:stamp,updated_at:stamp};this.records.set(identity(kind,data.id),{kind,id:data.id,data,createdAt:stamp,updatedAt:stamp});}
 record(kind,id){return this.records.get(identity(kind,id))?.data??null;}
 claim(){const plan=createSchedulePlan(this.image);return {jobId:this.image.jobId,workspaceId:this.image.workspaceId,automationId:this.image.automationId,definitionVersion:this.image.definitionVersion,definitionHash:this.image.definitionHash,dueHash:this.image.dueHash,fixedNow:this.image.fixedNow,scheduledAt:plan.scheduledAt,runId:plan.runId,nextRunAt:plan.nextRunAt};}
 context(){const claim=this.claim();return {kind:'automation',workspaceId:claim.workspaceId,memberId:'alice',grantId:'33333333-3333-4333-8333-333333333333',grantVersion:1,resourceId:claim.automationId,runId:claim.runId,leaseId:'44444444-4444-4444-8444-444444444444',generation:1,ticketHash:sha(ticket)};}
 ready(){return {state:'ready',context:this.context(),claim:this.claim()};}
 ticket(p){if(p.p_ticket_hash!==sha(ticket))throw failure(401);assert.match(p.p_invocation_id,/^[a-f0-9-]{36}$/);if(this.invocation&&this.invocation!==p.p_invocation_id)throw failure();this.invocation=p.p_invocation_id;}
 authorize(context){if(!this.active||canonicalJSON(context)!==canonicalJSON(this.context()))throw failure(401);const member=this.record('member','alice');if(member.active!==true||!['owner','admin','member','guest'].includes(member.role)||this.record('automation',automationId).owner_id!=='alice')throw failure(401);const {id,name,email,role,active}=member;return {id,name,email,role,active};}
 apply(action,p){
  if(action==='open'){assert.deepEqual(Object.keys(p).sort(),['p_invocation_id','p_ticket_hash']);this.ticket(p);return this.done?{state:'done'}:this.bound?copy(this.bound):{state:'planning',image:{...copy(this.image),revision:this.revision}};}
  if(action==='prepare'){
   this.ticket(p);assert.match(p.p_transaction_id,/^[a-f0-9-]{36}$/);assert.equal(sha(p.p_canonical),p.p_digest);assert.deepEqual(JSON.parse(p.p_canonical),{ticketHash:p.p_ticket_hash,invocationId:p.p_invocation_id,expectedRevision:p.p_expected_revision,plan:p.p_plan});
   const old=this.prepareReceipts.get(p.p_transaction_id);if(old){assert.equal(old.digest,p.p_digest);assert.equal(old.canonical,p.p_canonical);return copy(old.reply);}
   if(this.prepareConflicts){this.prepareConflicts--;this.revision++;this.afterConflict?.();throw failure(409,this.conflictMessage);}
   if(p.p_expected_revision!==this.revision)throw failure(409,'REVISION_CONFLICT');assert.deepEqual(p.p_plan,createSchedulePlan({...this.image,revision:this.revision}));
   const reply=this.control||p.p_plan.kind!=='due'||!this.image.authorAvailable?{state:'done'}:this.ready();if(reply.state==='done')this.done=true;else this.bound=copy(reply);
   this.prepareReceipts.set(p.p_transaction_id,{digest:p.p_digest,canonical:p.p_canonical,reply:copy(reply)});return reply;
  }
  if(action==='snapshot'){
   const principal=this.authorize(p.p_context);if(this.done)throw failure();if(p.p_expected_revision!==null&&p.p_expected_revision!==this.revision)throw failure(409,'REVISION_CONFLICT');
   const selected=p.p_selection,rows=[...this.records.values()].filter(row=>selected.kinds.includes(row.kind)||(Object.hasOwn(selected.ids,row.kind)&&selected.ids[row.kind].includes(row.id))),index=p.p_cursor?.index??0;
   return {workspaceId:this.image.workspaceId,memberId:'alice',revision:this.revision,accessRevision:0,principal,entities:copy(rows.slice(index,index+selected.pageSize)),meta:selected.metaKeys.map(key=>({key,value:copy(this.metadata.get(key)??null),present:this.metadata.has(key)})),nextCursor:index+selected.pageSize<rows.length?{index:index+selected.pageSize}:null};
  }
  if(action==='commit'){
   this.authorize(p.p_context);assert.equal(sha(p.p_canonical),p.p_digest);assert.deepEqual(JSON.parse(p.p_canonical),{context:p.p_context,expectedRevision:p.p_expected_revision,changes:p.p_changes});
   const key=canonicalJSON([p.p_context,p.p_transaction_id]),receipt=this.commitReceipts.get(key);if(receipt){assert.equal(receipt.digest,p.p_digest);return {revision:receipt.revision};}
   if(this.done)throw failure();if(p.p_expected_revision!==this.revision)throw failure(409,'REVISION_CONFLICT');const records=copy(this.records);let changes=0;
   for(const change of p.p_changes){assert.notEqual(change.op,'meta');const key=identity(change.kind,change.id),prior=records.get(key);if(change.op==='put'){assert.equal(change.previousCreatedAt,prior?.createdAt??null);records.set(key,{kind:change.kind,id:change.id,data:copy(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});changes++;}else if(records.delete(key))changes++;}
   const claim=this.claim(),run=records.get(identity('automation_run',claim.runId))?.data,automation=records.get(identity('automation',claim.automationId))?.data;assert(run&&['succeeded','failed'].includes(run.status));assert.equal(run.scheduled_at,claim.scheduledAt);assert.equal(automation.next_run_at,claim.nextRunAt);
   this.records=records;this.revision+=changes;this.done=true;this.commitReceipts.set(key,{digest:p.p_digest,revision:this.revision});return {revision:this.revision};
  }
  throw failure(400);
 }
}
async function fixture(t,{serviceKey=secret,source=image,...config}={}){
 const model=new BrokerModel(source),closed=[],faultEntered=[];let address;
 const server=http.createServer(async(req,res)=>{try{
  const found=/^\/rest\/v1\/rpc\/fountain_cloud_(scheduler_(open|prepare)|service_(snapshot|commit))$/.exec(req.url);assert(found,'Unexpected provider URL '+req.url);assert.equal(req.method,'POST');assert.equal(req.headers.apikey,serviceKey);assert.equal(req.headers.authorization,serviceKey.startsWith('sb_secret_')?undefined:'Bearer '+serviceKey);
  let raw='';for await(const bytes of req)raw+=bytes;assert(!raw.includes(ticket));const payload=JSON.parse(raw),action=found[2]??found[3];model.calls.push({action,raw,payload:copy(payload)});const fault=model.faults.get(action)?.shift();
  if(model.beforeAction)await model.beforeAction(action,payload);if(fault?.before)throw failure(fault.status??503,fault.message??'PRIVATE');const result=model.apply(action,payload);
  if(fault?.type==='destroy'){req.socket.destroy();return;}
  if(fault?.type==='status'){res.writeHead(fault.status??503,{'Content-Type':'application/json'});res.end(JSON.stringify({code:fault.code??'XX000',message:fault.message??marker,detail:serviceKey}));return;}
  if(fault?.type==='redirect'){res.writeHead(302,{Location:address+'/provider-leak?secret='+marker});res.end();return;}
  if(fault?.type==='hold'){fault.entered?.resolve();faultEntered.push(action);await fault.release.promise;}
  if(fault?.type==='hold-body'||fault?.type==='hold-headers'){
   res.on('close',()=>{closed.push(action);fault.closed?.resolve();});fault.entered?.resolve();if(fault.type==='hold-body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}return;
  }
  res.writeHead(200,{'Content-Type':'application/json'});if(fault?.type==='malformed')res.end('{'+marker);else if(fault?.type==='utf8')res.end(Buffer.from([0xc3,0x28]));else if(fault?.type==='oversized')res.end(' '.repeat(32769));else res.end(JSON.stringify(model.responseTransform?model.responseTransform(action,result):result));
 }catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({code:error.status===409?'PT409':'XX000',message:error.diagnostic??marker,detail:serviceKey}));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');address='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
 const transport=createSchedulerTransport({supabaseUrl:address,serviceKey,...config});
 async function request({method='POST',path='/functions/v1/fountain-worker',body=JSON.stringify({ticket}),headers={},signal}={}){const response=await transport(new Request('https://edge.fixture.invalid'+path,{method,headers:{'Content-Type':'application/json',...headers},...(method==='GET'||method==='HEAD'?{}:{body}),...(signal?{signal}:{})}));return {status:response.status,body:await response.json(),headers:response.headers};}
 return {model,request,transport,address,closed,faultEntered,serviceKey};
}
function safe(result){assert.deepEqual(Object.keys(result.body).sort(),result.status===200?['state']:['code','error']);const raw=JSON.stringify(result.body);for(const hidden of [secret,ticket,sha(ticket),marker,image.workspaceId,image.automationId,'context','claim','revision','runId','definitionHash'])assert(!raw.includes(hidden));assert.equal(result.headers.get('cache-control'),'no-store');}
const count=(f,action)=>f.model.calls.filter(call=>call.action===action);

test('modern private service key drives actual HTTP and all three domain actions with one author-bound run and no result leakage',async t=>{
 const f=await fixture(t),result=await f.request();assert.equal(result.status,200);assert.deepEqual(result.body,{state:'done'});safe(result);assert.equal(f.model.record('row','target').properties.n,2);
 const rows=[...f.model.records.values()].filter(row=>row.kind==='row'),pages=[...f.model.records.values()].filter(row=>row.kind==='page');assert.equal(rows.length,2);assert.equal(pages.length,1);assert.equal(pages[0].data.owner_id,'alice');assert.equal(pages[0].data.title,marker);
 assert.equal(count(f,'open').length,1);assert.equal(count(f,'prepare').length,1);assert(count(f,'snapshot').length>1);assert.equal(count(f,'commit').length,1);assert.equal(f.model.commitReceipts.size,1);
 for(const call of [...count(f,'snapshot'),...count(f,'commit')]){assert.equal(call.payload.p_context.memberId,'alice');assert.equal(call.payload.p_context.runId,f.model.claim().runId);assert(!('sessionHash'in call.payload.p_context));}
 const run=f.model.record('automation_run',f.model.claim().runId);assert.equal(run.started_at,fixedNow);assert.equal(run.finished_at,fixedNow);assert.equal(run.status,'succeeded');assert.equal(f.model.record('automation',automationId).next_run_at,f.model.claim().nextRunAt);
});
test('legacy service_role JWT works over HTTP while public keys and malformed configuration never reach a provider',async t=>{
 const f=await fixture(t,{serviceKey:legacyKey()});f.model.control=true;assert.equal((await f.request()).status,200);
 for(const serviceKey of ['sb_publishable_fixture_public',legacyKey('anon'),legacyKey('authenticated'),'not-a-key','sb_secret_short'])assert.throws(()=>createSchedulerTransport({supabaseUrl:f.address,serviceKey}));
 for(const config of [{supabaseUrl:'https://user:pass@fixture.invalid/'},{supabaseUrl:'http://remote.invalid/'},{supabaseUrl:f.address+'/arbitrary'},{timeoutMs:0},{budgetMs:0},{maxRevisionConflicts:6}])assert.throws(()=>createSchedulerTransport({supabaseUrl:f.address,serviceKey:secret,...config}));
 assert.equal(count(f,'open').length,1);
});
test('POST/path/header/query/content/body/token validation rejects before the first RPC',async t=>{
 const f=await fixture(t);const cases=[
  [{method:'GET'},405],[{method:'DELETE'},405],[{path:'/functions/v1/other'},404],[{path:'/?ticket='+ticket},404],
  ...['Cookie','Origin','Authorization'].map(name=>[{headers:{[name]:'fixture'}},403]),
  [{headers:{'Content-Type':'text/plain'}},415],[{headers:{'Content-Encoding':'gzip'}},415],
  [{headers:{'Content-Length':'257'}},413],[{headers:{'Content-Length':'not-numeric'}},400],[{headers:{'Content-Length':'1'}},400],
  [{body:' '.repeat(257)},413],[{body:new Uint8Array([0xc3,0x28])},400],[{body:'{'},400],[{body:'null'},400],[{body:'[]'},400],
  ...[{actor:'alice'},{url:'https://private.invalid'},{now:fixedNow},{context:{}},{ticketHash:sha(ticket)}].map(extra=>[{body:JSON.stringify({ticket,...extra})},400]),
  ...['',ticket+'=',ticket.slice(0,-1),ticket.slice(0,-1)+'B','!'.repeat(43)].map(value=>[{body:JSON.stringify({ticket:value})},400]),
 ];
 for(const [options,status]of cases){const result=await f.request(options);assert.equal(result.status,status,JSON.stringify(options));safe(result);assert.equal(f.model.calls.length,0);}
});
test('all fixed worker paths accept an exact 256-byte body; an unknown valid ticket cannot claim work',async t=>{
 for(const path of ['/','/fountain-worker','/functions/v1/fountain-worker']){const f=await fixture(t);f.model.control=true;const body=JSON.stringify({ticket}).padEnd(256,' '),result=await f.request({path,body,headers:{'Content-Length':'256'}});assert.equal(result.status,200);safe(result);}
 const f=await fixture(t),result=await f.request({body:JSON.stringify({ticket:Buffer.alloc(32,24).toString('base64url')})});assert.equal(result.status,401);assert.equal(count(f,'prepare').length,0);safe(result);
});
test('open lost accepted ACK retries the identical invocation and hash, with no duplicate claim',async t=>{
 for(const type of ['destroy','status']){const f=await fixture(t);f.model.control=true;f.model.faults.set('open',[{type}]);const result=await f.request();assert.equal(result.status,200);safe(result);assert.equal(count(f,'open').length,2);assert.equal(count(f,'open')[0].raw,count(f,'open')[1].raw);assert.equal(count(f,'prepare').length,1);}
});
test('prepare lost accepted ACK retries byte-identical transaction/canonical/digest without re-planning',async t=>{
 for(const type of ['destroy','status']){const f=await fixture(t);f.model.faults.set('prepare',[{type}]);const result=await f.request();assert.equal(result.status,200);safe(result);assert.equal(count(f,'open').length,1);const calls=count(f,'prepare');assert.equal(calls.length,2);assert.equal(calls[0].raw,calls[1].raw);assert.equal(f.model.prepareReceipts.size,1);assert.equal(count(f,'commit').length,1);}
});
test('persistent unknown open/prepare acknowledgements fail closed without new invocation or data execution',async t=>{
 for(const action of ['open','prepare']){const f=await fixture(t);f.model.faults.set(action,[{type:'destroy'},{type:'status'}]);const result=await f.request();assert.equal(result.status,503);safe(result);const calls=count(f,action);assert.equal(calls.length,2);assert.equal(calls[0].raw,calls[1].raw);assert.equal(count(f,'snapshot').length,0);assert.equal(count(f,'commit').length,0);assert.equal(count(f,'open').length,action==='open'?2:1);}
});
test('known revision conflict alone reopens a fresh revision while preserving fixed job time and invocation',async t=>{
 const f=await fixture(t);f.model.prepareConflicts=1;const result=await f.request();assert.equal(result.status,200);safe(result);const opens=count(f,'open'),prepares=count(f,'prepare');assert.equal(opens.length,2);assert.equal(opens[0].raw,opens[1].raw);assert.deepEqual(prepares.map(c=>c.payload.p_expected_revision),[5,6]);assert.notEqual(prepares[0].payload.p_transaction_id,prepares[1].payload.p_transaction_id);assert.deepEqual(prepares[0].payload.p_plan,prepares[1].payload.p_plan);assert.equal(f.model.record('automation_run',f.model.claim().runId).started_at,fixedNow);
 const blocked=await fixture(t);blocked.model.prepareConflicts=1;blocked.model.conflictMessage='OTHER_CONFLICT '+marker;const denied=await blocked.request();assert.equal(denied.status,409);safe(denied);assert.equal(count(blocked,'open').length,1);assert.equal(count(blocked,'prepare').length,1);assert.equal(count(blocked,'snapshot').length,0);
});
test('known-conflict retry budget stops without actions or an unbounded sequence of new plans',async t=>{
 const f=await fixture(t,{maxRevisionConflicts:2});f.model.prepareConflicts=5;const result=await f.request();assert.equal(result.status,409);safe(result);assert.equal(count(f,'open').length,2);assert.equal(count(f,'prepare').length,2);assert.equal(count(f,'snapshot').length,0);assert.equal(count(f,'commit').length,0);assert.equal(count(f,'open')[0].raw,count(f,'open')[1].raw);
});
test('fixed affinity and ready context/claim mismatch prevent all data I/O',async t=>{
 const transforms=[reply=>({...reply,context:{...reply.context,workspaceId:'other'}}),reply=>({...reply,context:{...reply.context,resourceId:'other'}}),reply=>({...reply,context:{...reply.context,runId:'0'.repeat(64)}}),reply=>({...reply,claim:{...reply.claim,jobId:randomUUID()}})];
 for(const change of transforms){const f=await fixture(t);f.model.responseTransform=(action,reply)=>action==='prepare'?change(reply):reply;const result=await f.request();assert.equal(result.status,503);safe(result);assert.equal(count(f,'snapshot').length,0);}
 const f=await fixture(t);f.model.prepareConflicts=1;f.model.afterConflict=()=>{f.model.image.fixedNow='2026-10-17T00:00:01Z';};const result=await f.request();assert.equal(result.status,503);assert.equal(count(f,'prepare').length,1);assert.equal(count(f,'snapshot').length,0);safe(result);
});
test('control-only planning and already-done open never load service data',async t=>{
 for(const source of [{...image,malformed:true},{...image,authorAvailable:false},{...image,nextRunAt:'2026-10-18T00:00:00Z'},{...image,nextRunAt:'2026-10-18T00:00:00Z',schedule:{...image.schedule,end_at:'2026-10-17T00:00:00Z'}}]){const f=await fixture(t,{source});f.model.control=true;const result=await f.request();assert.equal(result.status,200);safe(result);assert.equal(count(f,'prepare').length,1);assert.equal(count(f,'snapshot').length,0);assert.equal(count(f,'commit').length,0);}
 const f=await fixture(t);f.model.done=true;assert.equal((await f.request()).status,200);assert.equal(count(f,'prepare').length,0);assert.equal(count(f,'snapshot').length,0);
});
test('an already-ready open uses the same production author-bound executor',async t=>{
 const f=await fixture(t);f.model.bound=f.model.ready();const result=await f.request();assert.equal(result.status,200);assert.equal(count(f,'prepare').length,0);assert.equal(count(f,'commit').length,1);assert.equal(f.model.record('row','target').properties.n,2);safe(result);
});
test('two worker invocations cannot claim the same ticket while the first open HTTP response is pending',async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred();f.model.faults.set('open',[{type:'hold',entered,release}]);const first=f.request();await entered.promise;const second=await f.request();assert.equal(second.status,409);safe(second);assert.equal(count(f,'prepare').length,0);release.resolve();assert.equal((await first).status,200);assert.equal(count(f,'commit').length,1);assert.equal(f.model.commitReceipts.size,1);
});
test('actual ServiceProvider lost commit ACK retries the exact accepted writes once and never publishes private results',async t=>{
 for(const faults of [[{type:'destroy'}],[{type:'destroy'},{type:'status'}]]){const f=await fixture(t);f.model.faults.set('commit',copy(faults));const result=await f.request();assert.equal(result.status,faults.length===1?200:503);safe(result);const calls=count(f,'commit');assert.equal(calls.length,2);assert.equal(calls[0].raw,calls[1].raw);assert.equal(f.model.commitReceipts.size,1);assert.equal([...f.model.records.values()].filter(r=>r.kind==='row').length,2);assert.equal(count(f,'open').length,1);assert.equal(count(f,'prepare').length,1);}
});
test('provider 401/403 and nonrevision conflicts remain bounded static errors, never provider diagnostics',async t=>{
 for(const status of [400,401,403,404,409,410,413,429]){const f=await fixture(t);f.model.faults.set('open',[{before:true,status}]);const result=await f.request();assert.equal(result.status,status);safe(result);assert.equal(count(f,'open').length,1);assert.equal(count(f,'prepare').length,0);}
 const f=await fixture(t);f.model.active=false;const result=await f.request();assert.equal(result.status,401);safe(result);assert.equal(count(f,'commit').length,0);
});
test('malformed, oversized, redirected and structurally unexpected RPC replies never authorize data',async t=>{
 for(const type of ['malformed','utf8','oversized','redirect']){const f=await fixture(t);f.model.faults.set('open',[{type},{type}]);const result=await f.request();assert.equal(result.status,503);safe(result);assert.equal(count(f,'prepare').length,0);assert.equal(count(f,'snapshot').length,0);assert(count(f,'open').length<=2);}
 for(const value of [{state:'done',credential:marker},{state:'planning',image:{...image,schedule:{...image.schedule,key:marker}}},{state:'ready',context:{},claim:{}},{state:'unknown'}]){const f=await fixture(t);f.model.responseTransform=()=>value;const result=await f.request();assert.equal(result.status,503);safe(result);assert.equal(count(f,'snapshot').length,0);}
});
test('real HTTP headers/body stalls are aborted by the whole-invocation deadline and close their sockets',async t=>{
 for(const type of ['hold-headers','hold-body']){const f=await fixture(t,{budgetMs:80,timeoutMs:2000}),entered=deferred(),closed=deferred();f.model.faults.set('open',[{type,entered,closed}]);const started=performance.now(),pending=f.request();await entered.promise;const result=await pending;assert.equal(result.status,503);safe(result);assert(performance.now()-started<1500);await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Provider socket was not closed')),1000).unref())]);assert.equal(count(f,'open').length,1);assert(f.closed.includes('open'));}
});
test('an individual HTTP timeout retries only the same accepted invocation while the outer budget remains live',async t=>{
 const f=await fixture(t,{budgetMs:2000,timeoutMs:80}),entered=deferred(),closed=deferred();f.model.control=true;f.model.faults.set('open',[{type:'hold-headers',entered,closed}]);const pending=f.request();await entered.promise;const result=await pending;assert.equal(result.status,200);safe(result);assert.equal(count(f,'open').length,2);assert.equal(count(f,'open')[0].raw,count(f,'open')[1].raw);await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Timed-out provider socket remained open')),1000).unref())]);assert(f.closed.includes('open'));assert.equal(count(f,'prepare').length,1);
});
test('pending request body is cancelled on budget expiry and caller abort cancels an actual provider socket',async t=>{
 const f=await fixture(t,{budgetMs:50});let cancelled=0;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled++;}}),response=await f.transport(new Request('https://edge.fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/json'},body:stream,duplex:'half'}));assert.equal(response.status,503);assert.equal(cancelled,1);assert.equal(f.model.calls.length,0);
 const network=await fixture(t,{budgetMs:2000}),entered=deferred(),closed=deferred(),aborter=new AbortController();network.model.faults.set('open',[{type:'hold-body',entered,closed}]);const pending=network.request({signal:aborter.signal});await entered.promise;aborter.abort(Error(marker));const result=await pending;assert.equal(result.status,503);safe(result);await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Aborted HTTP socket remained open')),1000).unref())]);assert.equal(count(network,'open').length,1);
});
test('actual worker entry reads only server key settings, caches the real transport and emits safe configuration errors',async t=>{
 const source=await readFile(new URL('../functions/fountain-worker/index.ts',import.meta.url),'utf8'),script=stripTypeScriptTypes(source.replace(/^import [^\n]+;\n/gm,'')),f=await fixture(t);f.model.control=true;
 function entry(values){let handler;const reads=[],configs=[];vm.runInNewContext(script,{Deno:{env:{get(name){reads.push(name);return values[name];}},serve(value){handler=value;}},createSchedulerTransport(config){configs.push(copy(config));return createSchedulerTransport(config);},schedulerErrorResponse});return {reads,configs,handle:request=>handler(request)};}
 const worker=entry({SUPABASE_URL:f.address,SUPABASE_SECRET_KEYS:JSON.stringify({default:secret}),SUPABASE_ANON_KEY:'public-key-not-authority',UNRELATED_PRIVATE_ENV:marker});
 for(let i=0;i<2;i++){const response=await worker.handle(new Request('https://edge.fixture.invalid/',{method:'GET'}));assert.equal(response.status,405);assert(!(await response.text()).includes(secret));}assert.equal(worker.configs.length,1);assert.deepEqual(worker.reads,['SUPABASE_URL','SUPABASE_SECRET_KEYS']);assert.equal(f.model.calls.length,0);
 const response=await worker.handle(new Request('https://edge.fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'done'});
 for(const values of [{SUPABASE_URL:f.address,SUPABASE_SECRET_KEYS:'{'+marker},{SUPABASE_URL:f.address,SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_publishable_invalid'})},{}]){const rejected=entry(values),response=await rejected.handle(new Request('https://edge.fixture.invalid/'));assert.equal(response.status,503);const text=await response.text();assert(!text.includes(marker)&&!text.includes(secret));}
 const legacy=entry({SUPABASE_URL:f.address,SUPABASE_SERVICE_ROLE_KEY:legacyKey()});assert.equal((await legacy.handle(new Request('https://edge.fixture.invalid/',{method:'GET'}))).status,405);assert(legacy.reads.includes('SUPABASE_SERVICE_ROLE_KEY'));
});
