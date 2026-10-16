/** HTTP contract with the real TS domain/transaction stack and an in-memory
 * atomic RPC model. Actual Supabase execution is verified separately. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createDomain} from '../functions/_shared/domain.ts';
import {createBackend} from '../functions/_shared/backend.ts';
import {StoreError} from '../functions/_shared/store.ts';
const stamp='2026-10-16T00:00:00.000000+00:00',origin='https://fountain.example',copy=structuredClone;
function fixture(){
 const records=new Map(),meta=new Map([['settings',{name:'Family'}],['access_revision',0]]),receipts=new Map();let revision=0;
 const put=(kind,value)=>{const data={created_at:stamp,updated_at:stamp,...value};records.set(JSON.stringify([kind,data.id]),{kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at});};
 put('member',{id:'alice',name:'A',email:'a@example.invalid',role:'member',active:true});put('member',{id:'bob',name:'B',email:'b@example.invalid',role:'member',active:true});put('teamspace',{id:'general',visibility:'open'});
 for(const id of ['public','private'])put('page',{id,title:id,owner_id:'alice',teamspace_id:'general',archived:false,locked:false,revision:0,blocks:[],permissions:{default:id==='private'?'private':'workspace',inherit:false,members:{},groups:{}}});
 const context=id=>({hash:(id==='alice'?'a':'b').repeat(64),userId:(id==='alice'?'11111111-1111-4111-8111-111111111111':'33333333-3333-4333-8333-333333333333'),authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.now()+60000,profile:{workspaceId:'qa',authSessionActive:true,member:copy(records.get(JSON.stringify(['member',id])).data)}});
 const provider={async snapshot(r){if(r.expectedRevision!==undefined&&r.expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT','Fixture changed');const s=r.selection;
  const all=[...records.values()].filter(v=>s.kinds.includes(v.kind)||s.ids[v.kind]?.includes(v.id));const offset=r.cursor?.offset||0;
  return {workspaceId:'qa',memberId:r.context.memberId,revision,accessRevision:meta.get('access_revision'),principal:context(r.context.memberId).profile.member,entities:copy(all.slice(offset,offset+s.pageSize)),meta:s.metaKeys.map(key=>({key,present:meta.has(key),value:copy(meta.get(key)??null)})),nextCursor:offset+s.pageSize<all.length?{offset:offset+s.pageSize}:null};},
  async commit(r){const previous=receipts.get(r.transactionId);if(previous)return previous;if(r.expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT','Fixture changed');
   for(const change of r.changes){if(change.op==='put')put(change.kind,change.data);else if(change.op==='delete')records.delete(JSON.stringify([change.kind,change.id]));else meta.set(change.key,copy(change.value));revision++;}
   const result={revision};receipts.set(r.transactionId,result);return result;}};
 const app=id=>{const auth=context(id),authorize=async()=>copy(auth);return createBackend({origins:[origin],auth:async()=>({authorize,session:async()=>({status:200,body:{authenticated:true}})}),domain:createDomain({provider,authorize,clock:()=>Date.parse(stamp)})});};
 const call=async(id,method,path,body)=>{const result=await app(id)(new Request(origin+path,{method,headers:{Origin:origin,'X-Fountain-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:result.status,body:await result.json()};};
 return {call,records,meta};
}
test('workspace is projected for each member and carries canonical synchronization metadata',async()=>{
 const f=fixture(),a=await f.call('alice','GET','/api/workspace'),b=await f.call('bob','GET','/api/workspace');
 assert.equal(a.status,200);assert.equal(a.body.pages.length,2);assert.deepEqual(b.body.pages.map(p=>p.id),['public']);assert.equal(b.body.current_member_id,'bob');assert.equal(b.body.session_binding,'c'.repeat(32));assert.equal(typeof b.body.data_revision,'number');
});
test('hidden resources stay closed, captured revisions reject stale edits, comments keep verified authors',async()=>{
 const f=fixture();assert.equal((await f.call('bob','GET','/api/pages/private')).status,404);
 assert.equal((await f.call('bob','PATCH','/api/pages/private',{title:'leak'})).status,404);
 const saved=await f.call('bob','PATCH','/api/pages/public',{title:'shared',revision:0});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
 assert.equal((await f.call('bob','PATCH','/api/pages/public',{title:'stale',revision:0})).status,409);
 const comment=await f.call('bob','POST','/api/pages/public/comments',{text:'hello',author:'alice'});assert.equal(comment.status,201);assert.equal(comment.body.author,'bob');
});
test('explicit page creation passes authorization, persists blocks, and version restore checks revision',async()=>{
 const f=fixture(),created=await f.call('alice','POST','/api/pages',{title:'new',owner_id:'bob'});assert.equal(created.status,201);assert.equal(created.body.owner_id,'alice');
 const id=created.body.id,saved=await f.call('alice','PUT',`/api/pages/${id}/blocks`,{revision:0,blocks:[{id:'b',type:'paragraph',text:'hello'}]});assert.equal(saved.status,200);
 const detail=await f.call('alice','GET',`/api/pages/${id}`);assert.equal(detail.body.blocks[0].text,'hello');assert.equal(detail.body.versions.length,1);
 const version=detail.body.versions[0].id;assert.equal((await f.call('alice','POST',`/api/pages/${id}/versions/${version}/restore`,{revision:0})).status,409);
 const restored=await f.call('alice','POST',`/api/pages/${id}/versions/${version}/restore`,{revision:1});assert.equal(restored.status,200);assert.deepEqual(restored.body.blocks,[]);
});
test('permission changes require full access and invalidate access revision atomically',async()=>{
 const f=fixture();assert.equal((await f.call('bob','PATCH','/api/pages/public/permissions',{permissions:{default:'private',members:{},groups:{}}})).status,403);
 const result=await f.call('alice','PATCH','/api/pages/public/permissions',{permissions:{default:'private',inherit:false,members:{},groups:{}}});assert.equal(result.status,200);assert.equal(f.meta.get('access_revision'),1);
 assert.equal((await f.call('bob','GET','/api/pages/public')).status,404);
});
test('advanced search filters before counting and never records the query in audit',async()=>{
 const f=fixture(),a=await f.call('alice','GET','/api/search/advanced?limit=1'),b=await f.call('bob','GET','/api/search/advanced?limit=1');
 assert.equal(a.status,200);assert.equal(a.body.total,2);assert.equal(b.status,200);assert.equal(b.body.total,1);
 assert.deepEqual(b.body.results.map(p=>p.id),['public']);
 const second=await f.call('alice','GET','/api/search/advanced?limit=1&offset=1&result_set='+a.body.result_set);
 assert.equal(second.status,200);assert.notEqual(second.body.results[0].id,a.body.results[0].id);
 assert.equal(second.body.result_set,a.body.result_set,'audit writes do not invalidate pagination');
 const noMatch=await f.call('bob','GET','/api/search/advanced?q=private-query-must-not-be-audited');assert.equal(noMatch.status,200);assert.equal(noMatch.body.total,0);
 const audits=[...f.records.values()].filter(v=>v.kind==='audit');
 assert(audits.length>=4);assert(!JSON.stringify(audits).includes('private-query-must-not-be-audited'));
 assert(audits.every(v=>Object.keys(v.data.details).every(k=>['mode','results','total'].includes(k))));
 assert.equal((await f.call('alice','PATCH','/api/pages/public',{title:'changed',revision:0})).status,200);
 assert.equal((await f.call('alice','GET','/api/search/advanced?limit=1&offset=1&result_set='+a.body.result_set)).status,409);
 assert.equal((await f.call('bob','GET','/api/search/advanced?in=private')).status,404);
 assert.equal((await f.call('bob','GET','/api/search/advanced?in=missing')).status,404);
 assert.equal((await f.call('bob','GET','/api/search?q=changed')).body.results.length,1);
});
test('malformed advanced GET and HEAD query makes zero domain provider calls',async()=>{
 let calls=0;const provider={snapshot:async()=>{calls++;throw Error('must not read');},commit:async()=>{calls++;throw Error('must not write');}};
 const app=createDomain({provider,authorize:async()=>{throw Error('no second auth needed');}});
 for(const method of ['GET','HEAD'])for(const query of ['?q=x&q=y','?types=unknown','?offset=1','?limit=01','?unknown=1']){
  await assert.rejects(()=>app(new Request(origin+'/api/search/advanced'+query,{method}),'/api/search/advanced',{}),error=>error.status===400);
 }
 assert.equal(calls,0);
});
