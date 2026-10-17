/** Real domain/staging/transaction stack; atomic RPC model, not live Auth/SQL. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createDomain} from '../functions/_shared/domain.ts';
import {CloudStore,ServiceStore,StoreError} from '../functions/_shared/store.ts';
import {storeContext} from '../functions/_shared/transaction.ts';

const stamp='2026-10-17T00:00:00.000000+00:00',origin='https://activity.example.invalid',copy=structuredClone;
function fixture(){
  let revision=0,lost=false,conflict=false,active=true,calls=0;
  const records=new Map(),receipts=new Map(),views=new Map(),requests=[];
  const put=(kind,data)=>{data={created_at:stamp,updated_at:stamp,...data};records.set(JSON.stringify([kind,data.id]),{kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at});};
  put('member',{id:'alice',role:'member',active:true,email:'alice@example.invalid'});
  put('member',{id:'bob',role:'member',active:true,email:'bob@example.invalid'});
  put('teamspace',{id:'general',visibility:'open'});
  put('page',{id:'page',title:'Original',owner_id:'alice',teamspace_id:'general',revision:0,blocks:[],archived:false,permissions:{default:'private',inherit:false,members:{},groups:{}}});
  const auth=(member='alice')=>({hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'b'.repeat(32),expiresAt:Date.now()+60000,profile:{workspaceId:'activity-qa',authSessionActive:active,member:copy(records.get(JSON.stringify(['member',member])).data)}});
  const provider={
    async snapshot(request){
      if(!active)throw new StoreError(401,'AUTH_REQUIRED');
      const s=request.selection,all=[...records.values()].filter(r=>s.kinds.includes(r.kind)||s.ids[r.kind]?.includes(r.id)),offset=request.cursor?.offset??0;
      if(request.expectedRevision!==undefined&&request.expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT');
      return {workspaceId:'activity-qa',memberId:request.context.memberId,revision,accessRevision:0,principal:auth(request.context.memberId).profile.member,entities:copy(all.slice(offset,offset+s.pageSize)),meta:s.metaKeys.map(key=>({key,present:false,value:null})),nextCursor:offset+s.pageSize<all.length?{offset:offset+s.pageSize}:null};
    },
    async commit(request){
      requests.push(copy(request));calls++;
      if(!active)throw new StoreError(401,'AUTH_REQUIRED');
      if(receipts.has(request.transactionId))return receipts.get(request.transactionId);
      if(conflict){conflict=false;const row=records.get(JSON.stringify(['page','page']));row.data.title='Concurrent';revision++;throw new StoreError(409,'REVISION_CONFLICT');}
      assert.equal(request.expectedRevision,revision);
      for(const change of request.changes){
        if(change.op==='put')put(change.kind,change.data);
        else if(change.op==='delete')records.delete(JSON.stringify([change.kind,change.id]));
        else if(change.op==='activity_view'){
          assert.deepEqual(Object.keys(change).sort(),['commandId','id','kind','op']);assert.equal(change.kind,'page');
          const scope=JSON.stringify([request.context.memberId,change.kind,change.id]),before=views.get(change.commandId);
          if(before)assert.equal(before.scope,scope);
          else views.set(change.commandId,{scope,title:records.get(JSON.stringify(['page',change.id])).data.title});
        }else assert.equal(change.op,'meta');
      }
      revision+=request.changes.length;const result={revision};receipts.set(request.transactionId,result);
      if(lost){lost=false;throw Error('Model lost acknowledgement');}return result;
    }
  };
  const call=(path,{member='alice',method='GET'}={})=>{
    const context=auth(member),app=createDomain({provider,authorize:async()=>auth(member),clock:()=>Date.parse(stamp)});
    return app(new Request(origin+path,{method,headers:{'X-Fountain-Request':'1'}}),new URL(origin+path).pathname,context);
  };
  return {provider,views,requests,auth,call,get calls(){return calls;},lose(){lost=true;},race(){conflict=true;},revoke(){active=false;}};
}
test('normal collaboration snapshots, polling and workspace warming create no viewed op',async()=>{
  const f=fixture();for(const path of ['/api/pages/page/collaboration','/api/pages/page/collaboration','/api/workspace'])assert.equal((await f.call(path)).status,200);
  assert.equal(f.views.size,0);assert(f.requests.every(r=>r.changes.every(c=>c.op!=='activity_view')));
});
test('the actual online UI detail request records exactly one authorized page open',async()=>{
  const f=fixture();const response=await f.call('/api/pages/page');assert.equal(response.status,200);assert.equal((await response.json()).page.title,'Original');
  assert.equal((await f.call('/api/pages/page/collaboration')).status,200);assert.equal(f.views.size,1);
  assert.equal(f.requests.flatMap(r=>r.changes).filter(c=>c.op==='activity_view').length,1);
});
test('explicit collaboration open command is idempotent and does not carry caller actor or body',async()=>{
  const f=fixture(),path='/api/pages/page/collaboration?open_command='+'1'.repeat(32);
  assert.equal((await f.call(path)).status,200);assert.equal((await f.call(path)).status,200);assert.equal(f.views.size,1);
});
test('invalid and duplicate open command query is rejected without committing a view',async()=>{
  for(const suffix of ['bad','a'.repeat(31),'A'.repeat(32),'a'.repeat(32)+'&open_command='+'a'.repeat(32),'a'.repeat(32)+'&actor=owner']){
    const f=fixture();await assert.rejects(f.call('/api/pages/page/collaboration?open_command='+suffix),e=>e.status===400);assert.equal(f.views.size,0);assert.equal(f.calls,0);
  }
});
test('a hidden page and its explicit open command remain 404 with no activity',async()=>{
  const f=fixture();for(const path of ['/api/pages/page','/api/pages/page/collaboration?open_command='+'2'.repeat(32)])await assert.rejects(f.call(path,{member:'bob'}),e=>e.status===404);
  assert.equal(f.views.size,0);assert.equal(f.calls,0);
});
test('HEAD does not infer a page view from a metadata-only response',async()=>{
  const f=fixture();assert.equal((await f.call('/api/pages/page',{method:'HEAD'})).status,200);assert.equal(f.views.size,0);
});
test('uncertain ACK retries the same accepted view command and transaction receipt',async()=>{
  const f=fixture();f.lose();assert.equal((await f.call('/api/pages/page')).status,200);assert.equal(f.views.size,1);assert.equal(f.calls,2);
  assert.deepEqual(f.requests[0],f.requests[1]);
});
test('CAS conflict replays against the actual delivered source before recording view',async()=>{
  const f=fixture();f.race();const response=await f.call('/api/pages/page');assert.equal((await response.json()).page.title,'Concurrent');assert.equal(f.views.size,1);assert.equal([...f.views.values()][0].title,'Concurrent');
});
test('fresh Auth revocation refuses activity staging before source delivery',async()=>{
  const f=fixture();f.revoke();await assert.rejects(f.call('/api/pages/page'),e=>e.status===401);assert.equal(f.views.size,0);
});
test('the staging primitive rejects an absent source and invalid command',async()=>{
  const f=fixture(),context=storeContext(f.auth()),s=await CloudStore.open(f.provider,context,{kinds:['page']});
  assert.throws(()=>s.record_activity_view('page','missing','a'.repeat(32)),e=>e.status===409);
  assert.throws(()=>s.record_activity_view('page','page','a'),e=>e.status===400);
  assert.throws(()=>s.record_activity_view('database','page','a'.repeat(32)),e=>e.status===400);
  assert.equal(f.views.size,0);
});
test('service grants cannot stage a human page-open event',async()=>{
  const f=fixture(),context={kind:'automation',workspaceId:'activity-qa',memberId:'alice',grantId:'11111111-1111-4111-8111-111111111111',grantVersion:1,resourceId:'automation',runId:'a'.repeat(64),leaseId:'22222222-2222-4222-8222-222222222222',generation:1,ticketHash:'b'.repeat(64)};
  const s=await ServiceStore.open(f.provider,context,{kinds:['page']});
  assert.throws(()=>s.record_activity_view('page','page','a'.repeat(32)),e=>e instanceof StoreError);
  assert.equal(f.views.size,0);assert.equal(f.calls,0);
});
test('private open command allocation does not consume or constrain public entity IDs',async()=>{
  const f=fixture();let entityIds=0;
  const s=await CloudStore.open(f.provider,storeContext(f.auth()),{kinds:['page']},{idFactory:()=> 'public-id-'+(++entityIds)});
  s.transaction(()=>s.record_activity_view('page','page'));
  await s.commit();assert.equal(entityIds,0);assert.match([...f.views.keys()][0],/^[a-f0-9]{32}$/);
});
test('a generic audit entry with a forged actor remains separate from a page-open command',async()=>{
  const f=fixture(),s=await CloudStore.open(f.provider,storeContext(f.auth()),{});
  s.transaction(()=>s.audit('page.viewed',{page_id:'page',generation:'f'.repeat(32)},'owner'));
  await s.commit();assert.equal(f.views.size,0);assert(f.requests[0].changes.every(c=>c.op==='put'&&c.kind==='audit'));
});
