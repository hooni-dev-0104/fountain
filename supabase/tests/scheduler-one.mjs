/** Pure bounded Scheduler extraction regressions. The baseline mode can run
 * against the pre-extraction class. No Cron, service grants, SQL or cloud I/O. */
import assert from 'node:assert/strict';
import {APIError} from '../functions/_shared/access.ts';
import {MissingSelection} from '../functions/_shared/store.ts';
import {Scheduler,next_occurrence} from '../functions/_shared/scheduler.ts';
const clone=structuredClone,time='2026-10-16T00:00:00.000000+00:00',identity='예약 😀',now='2026-10-16T00:00:00.123456Z';
const key=(kind,id)=>JSON.stringify([kind,id]);
class Store {
 records=new Map();revision=0;requestTime=time;calls=[];forbidList=false;readFailure=null;
 get(kind,id){this.calls.push(['get',kind,id]);if(this.readFailure)this.readFailure(kind,id);return clone(this.records.get(key(kind,id))??null);}
 list(kind){this.calls.push(['list',kind]);if(this.forbidList&&kind==='automation')throw Error('Unbounded automation list is forbidden');return [...this.records.entries()].filter(([entry])=>JSON.parse(entry)[0]===kind).map(([,value])=>clone(value));}
 put(kind,data){const prior=this.get(kind,data.id),value={...clone(data),created_at:prior?.created_at??time,updated_at:time};JSON.stringify(value,(_,item)=>{if(typeof item==='undefined'||typeof item==='function')throw new APIError(400,'Invalid serialization');return item;});this.records.set(key(kind,data.id),value);this.revision++;return clone(value);}
 delete(kind,id){if(this.records.delete(key(kind,id)))this.revision++;}
 transaction(action){const records=clone(this.records),revision=this.revision;try{return action(this);}catch(error){this.records=records;this.revision=revision;throw error;}}
 seed(kind,data){this.records.set(key(kind,data.id),{...clone(data),created_at:time,updated_at:time});}
}
const base={id:identity,owner_id:'alice',enabled:true,trigger:'scheduled',row_id:'selected-row',schedule:{frequency:'minutes',interval:5,timezone:'UTC',start_at:'2026-10-16T00:00:00Z'}};
function setup(spec={},mode='tick'){
 const store=new Store();store.seed('member',{id:'alice',name:'작성자',role:'member',active:true});if(!spec.missing)store.seed('automation',{...base,...spec.automation});
 if(spec.seed)spec.seed(store);store.readFailure=spec.readFailure??null;store.forbidList=mode==='tick_one';const invocations=[];
 const callback=(id,body,actor)=>{invocations.push({id,body,actor});if(spec.callback)return spec.callback(store,id,body,actor);store.put('row',{id:'created-row',name:'예약 행',owner_id:actor});return {created:'created-row'};};
 const scheduler=new Scheduler(store,callback);let result,error;try{result=scheduler[mode](...(mode==='tick_one'?[identity,spec.now??now]:[spec.now??now]));}catch(caught){error={name:caught.name,status:caught.status??null,message:caught.message};}
 return {store,result,error,invocations};
}
const effect=run=>({result:run.result,error:run.error,records:[...run.store.records],revision:run.store.revision,invocations:run.invocations});
let checks=0;
function test(name,spec,assertion){const baseline=setup(spec,'tick');assertion(baseline);if(process.env.FOUNTAIN_SCHEDULER_BASELINE!=='1'){const single=setup(spec,'tick_one');assert.deepEqual(effect(single),effect(baseline),name+': exact tick/tick_one effects');assert(!single.store.calls.some(([action,kind])=>action==='list'&&kind==='automation'));assertion(single);}checks++;}
const noChange=run=>{assert.deepEqual(run.result,[]);assert.equal(run.store.revision,0);assert.equal(run.invocations.length,0);};
test('future due is unchanged',{automation:{next_run_at:'2026-10-16T00:05:00Z'}},noChange);
test('disabled job is unchanged',{automation:{enabled:false}},noChange);
test('non-scheduled job is unchanged',{automation:{trigger:'manual'}},noChange);
test('missing job is unchanged',{missing:true},noChange);
test('one due job keeps exact run ID/author/body/microsecond timestamp',{},run=>{
 assert.equal(run.result.length,1);const saved=run.result[0];assert.equal(saved.id,Scheduler._run_id(identity,'2026-10-16T00:00:00+00:00'));assert.equal(saved.status,'succeeded');assert.equal(saved.started_at,'2026-10-16T00:00:00.123456+00:00');assert.equal(saved.finished_at,saved.started_at);assert.deepEqual(run.invocations,[{id:identity,body:{row_id:'selected-row'},actor:'alice'}]);assert.equal(saved.next_run_at,'2026-10-16T00:05:00+00:00');assert.equal(run.store.get('row','created-row').owner_id,'alice');
});
test('long missed interval coalesces once',{now:'2027-03-01T11:33:00Z'},run=>{assert.equal(run.result.length,1);assert.equal(run.invocations.length,1);assert.equal(run.result[0].next_run_at,'2027-03-01T11:35:00+00:00');});
test('past end disables without executing',{automation:{next_run_at:'2026-10-17T00:00:00Z',schedule:{...base.schedule,end_at:'2026-10-16T00:00:00Z'}}},run=>{assert.deepEqual(run.result,[]);assert.equal(run.store.get('automation',identity).enabled,false);assert.equal(run.store.get('automation',identity).schedule_status,'completed');assert.equal(run.invocations.length,0);});
test('last valid occurrence executes then disables',{automation:{schedule:{...base.schedule,end_at:'2026-10-16T00:00:00Z'}}},run=>{assert.equal(run.result[0].next_run_at,null);assert.equal(run.store.get('automation',identity).enabled,false);assert.equal(run.store.get('automation',identity).schedule_status,'completed');});
test('existing stable run ID deduplicates and only advances schedule',{seed:store=>store.seed('automation_run',{id:Scheduler._run_id(identity,'2026-10-16T00:00:00+00:00'),automation_id:identity,status:'succeeded',marker:'immutable-prior-run'})},run=>{assert.deepEqual(run.result,[]);assert.equal(run.store.revision,1);assert.equal(run.invocations.length,0);assert.equal(run.store.get('automation',identity).next_run_at,'2026-10-16T00:05:00+00:00');assert.equal([...run.store.records.values()].find(row=>row.marker)?.marker,'immutable-prior-run');});
test('deduplicated final occurrence also disables',{automation:{schedule:{...base.schedule,end_at:'2026-10-16T00:00:00Z'}},seed:store=>store.seed('automation_run',{id:Scheduler._run_id(identity,'2026-10-16T00:00:00+00:00'),status:'failed'})},run=>{assert.deepEqual(run.result,[]);assert.equal(run.store.get('automation',identity).enabled,false);assert.equal(run.invocations.length,0);});
test('invalid schedule produces the existing stable failed run',{automation:{schedule:{...base.schedule,interval:true}}},run=>{assert.equal(run.result[0].id,Scheduler._run_id(identity,'invalid-schedule'));assert.equal(run.result[0].scheduled_at,null);assert.equal(run.result[0].status,'failed');assert.equal(run.store.get('automation',identity).enabled,false);assert.equal(run.invocations.length,0);});
test('invalid persisted next date is recorded as failed',{automation:{next_run_at:'broken'}},run=>{assert.equal(run.result[0].status,'failed');assert.equal(run.store.get('automation',identity).next_run_at,null);});
for(const author of [null,{id:'alice',role:'member',active:false},{id:'alice',role:'OWNER',active:true}])test('invalid current author records failure '+JSON.stringify(author),{seed:store=>{store.records.delete(key('member','alice'));if(author)store.seed('member',author);}},run=>{assert.equal(run.result[0].status,'failed');assert.equal(run.invocations.length,0);assert.equal(run.store.get('row','created-row'),null);assert.equal(run.store.get('automation',identity).last_run_status,'failed');});
test('callback failure rolls back its writes but keeps failed run/nextAt',{callback:store=>{store.put('row',{id:'partial',name:'must roll back'});throw new APIError(400,'x'.repeat(1200));}},run=>{assert.equal(run.store.get('row','partial'),null);assert.equal(run.result[0].status,'failed');assert.equal(run.result[0].error.length,1000);assert(!Object.hasOwn(run.result[0],'result'));assert.equal(run.store.get('automation',identity).next_run_at,'2026-10-16T00:05:00+00:00');});
test('callback deleting its automation does not resurrect it',{callback:store=>{store.delete('automation',identity);return {removed:true};}},run=>{assert.equal(run.result[0].status,'succeeded');assert.equal(run.store.get('automation',identity),null);});
test('callback edits survive latest automation reload',{callback:store=>{store.put('automation',{...store.get('automation',identity),name:'callback 최신 제목'});return {edited:true};}},run=>{assert.equal(run.store.get('automation',identity).name,'callback 최신 제목');assert.equal(run.store.get('automation',identity).next_run_at,'2026-10-16T00:05:00+00:00');});
test('MissingSelection from author rolls back the entire one-job transaction',{readFailure:(kind,id)=>{if(kind==='member'&&id==='alice')throw new MissingSelection({ids:{member:['alice']}});}},run=>{assert.equal(run.error.name,'MissingSelection');assert.equal(run.store.revision,0);assert(![...run.store.records.keys()].some(entry=>JSON.parse(entry)[0]==='automation_run'));});
test('MissingSelection from callback rolls back both run and callback records',{callback:store=>{store.put('row',{id:'partial'});throw new MissingSelection({ids:{row:['hidden']}});}},run=>{assert.equal(run.error.name,'MissingSelection');assert.equal(run.store.revision,0);assert.equal(run.store.get('row','partial'),null);});
test('asynchronous callback is recorded as a failed synchronous action',{callback:async()=>({unsafe:true})},run=>{assert.equal(run.result[0].status,'failed');assert.equal(run.result[0].error,'Scheduled callbacks must be synchronous');});
test('invalid now is rejected before any collection or target read',{now:'not-a-time'},run=>{assert.equal(run.error.status,400);assert.equal(run.store.calls.length,0);assert.equal(run.store.revision,0);});
test('DST gap uses unchanged next occurrence calculation',{automation:{schedule:{frequency:'days',timezone:'America/New_York',start_at:'2026-03-07T02:30:00-05:00'}},now:'2026-03-08T07:30:00Z'},run=>{assert.equal(run.result[0].next_run_at,next_occurrence({frequency:'days',timezone:'America/New_York',start_at:'2026-03-07T02:30:00-05:00'},'2026-03-08T07:30:00+00:00'));});
{
 const store=new Store();store.seed('member',{id:'alice',role:'member',active:true});for(const id of ['first','second','third'])store.seed('automation',{...base,id});let timeReads=0;const captured=new Date(now);captured.toISOString=()=>{timeReads++;return now;};const order=[];
 const result=new Scheduler(store,id=>{order.push(id);if(id==='first'){store.delete('automation','second');store.put('automation',{...store.get('automation','third'),name:'changed by first'});}return {id};}).tick(captured);
 assert.deepEqual(order,['first','third']);assert.equal(timeReads,1);assert.deepEqual(result.map(run=>run.automation_id),order);assert(result.every(run=>run.started_at==='2026-10-16T00:00:00.123456+00:00'));assert.equal(store.get('automation','third').name,'changed by first');checks++;
}
{
 const store=new Store();store.seed('member',{id:'alice',role:'member',active:true});for(const id of ['first','second'])store.seed('automation',{...base,id});
 assert.throws(()=>new Scheduler(store,id=>{store.put('row',{id:id+'-row'});if(id==='second')throw new MissingSelection({ids:{row:['later']}});return {id};}).tick(now),MissingSelection);
 assert(store.get('row','first-row'));assert.equal(store.get('row','second-row'),null);assert.equal(store.get('automation','first').next_run_at,'2026-10-16T00:05:00+00:00');assert(!Object.hasOwn(store.get('automation','second'),'next_run_at'));assert(store.get('automation_run',Scheduler._run_id('first','2026-10-16T00:00:00+00:00')));assert.equal(store.get('automation_run',Scheduler._run_id('second','2026-10-16T00:00:00+00:00')),null);checks++;
}
if(process.env.FOUNTAIN_SCHEDULER_BASELINE!=='1'){
 const store=new Store();store.seed('member',{id:'alice',role:'member',active:true});store.seed('automation',base);for(let n=0;n<1000;n++)store.seed('automation',{...base,id:'inaccessible-'+n});const before=clone(store.records);store.forbidList=true;store.readFailure=(kind,id)=>{if(kind==='automation'&&id!==identity)throw Error('Unrelated automation is inaccessible');};
 const result=new Scheduler(store,()=>({ok:true})).tick_one(identity,now);assert.equal(result.length,1);assert(!store.calls.some(([action,kind,id])=>kind==='automation'&&(action==='list'||id!==identity)));for(let n=0;n<1000;n++)assert.deepEqual(store.records.get(key('automation','inaccessible-'+n)),before.get(key('automation','inaccessible-'+n)));checks++;
}
console.log(JSON.stringify({ok:true,checks,mode:process.env.FOUNTAIN_SCHEDULER_BASELINE==='1'?'pre-extraction tick baseline':'tick + bounded tick_one exact effects',cronOrSQLDeployment:false}));
