/** CloudStore integration uses an explicit in-memory RPC model, not deployed SQL.
 * Actual Python class/state parity is in collaboration-parity.mjs.
 */
import assert from 'node:assert/strict';
import {CloudStore,StoreError} from '../functions/_shared/store.ts';
import {Access} from '../functions/_shared/access.ts';
import {Collaboration} from '../functions/_shared/collaboration.ts';
import {normalize_blocks} from '../functions/_shared/crdt.ts';
const time='2026-10-16T00:00:00.000000+00:00',copy=structuredClone,key=(kind,id)=>JSON.stringify([kind,id]);
const base={workspaceId:'fixture',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)};
const alice={...base,memberId:'alice'},bob={...base,memberId:'bob',userId:'33333333-3333-4333-8333-333333333333',authSessionId:'44444444-4444-4444-8444-444444444444',sessionHash:'c'.repeat(64)};
class Provider{
 constructor(){this.revision=0;this.data=new Map();this.receipts=new Map();this.commits=[];this.seed('page',{id:'p',title:'협업',owner_id:'alice',revision:0,blocks:normalize_blocks([{id:'text',text:'원본한🙂'}]),permissions:{default:'private',members:{bob:'edit'}}});}
 seed(kind,value){this.data.set(key(kind,value.id),{kind,id:value.id,data:{...copy(value),created_at:time,updated_at:time},createdAt:time,updatedAt:time});}
 async snapshot({context,selection,expectedRevision}){
  if(expectedRevision!==undefined&&expectedRevision!==this.revision)throw new StoreError(409,'REVISION_CONFLICT','Changed');
  return {workspaceId:context.workspaceId,memberId:context.memberId,revision:this.revision,accessRevision:0,principal:{id:context.memberId,role:'member',active:true},entities:Array.from(this.data.values()).filter(value=>selection.kinds.includes(value.kind)||(selection.ids[value.kind]||[]).includes(value.id)).map(value=>copy(value)),meta:[],nextCursor:null};
 }
 async commit(request){
  this.commits.push(copy(request));const prior=this.receipts.get(request.transactionId);if(prior){assert.equal(prior.digest,request.digest);return {revision:prior.revision};}
  if(request.expectedRevision!==this.revision)throw new StoreError(409,'REVISION_CONFLICT','Changed');
  const next=copy(this.data);let revision=this.revision;
  for(const change of request.changes){if(change.op==='put'){assert.equal(next.get(key(change.kind,change.id))?.createdAt??null,change.previousCreatedAt);next.set(key(change.kind,change.id),{kind:change.kind,id:change.id,data:copy(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});revision++;}else if(change.op==='delete'){if(next.delete(key(change.kind,change.id)))revision++;}else throw Error('Unexpected metadata write');}
  this.data=next;this.revision=revision;this.receipts.set(request.transactionId,{digest:request.digest,revision});return {revision};
 }
}
const provider=new Provider(),selection={kinds:['group'],ids:{page:['p'],collaboration:['p']}},options={clock:()=>Date.parse('2026-10-16T00:00:00Z')};
const open=context=>CloudStore.open(provider,context,selection,options);
const service=(store,epoch)=>new Collaboration(store,{validate_blocks:normalize_blocks},{uid:()=>epoch});
const a0=await open(alice),b0=await open(bob),aSeed=service(a0,'candidate-A').snapshot('p',new Access(a0,a0.principal)),bSeed=service(b0,'candidate-B').snapshot('p',new Access(b0,b0.principal));
assert.equal(provider.revision,0);assert.equal(provider.data.has(key('collaboration','p')),false);assert.equal(provider.commits.length,0);
assert.equal(aSeed.epoch,'candidate-A');assert.equal(bSeed.epoch,'candidate-B');await a0.commit();await assert.rejects(b0.commit(),error=>error.code==='REVISION_CONFLICT');
const bFresh=await open(bob),canonical=service(bFresh,'unused').snapshot('p',new Access(bFresh,bFresh.principal));assert.equal(canonical.epoch,'candidate-A');await bFresh.commit();assert.equal(provider.revision,1);
const operation=(client,text)=>({id:client+':1',client,clock:1,type:'text.insert',block_id:'text',text,after_id:null});
const first=operation('one','가족A'),second=operation('two','가족B');
const a1=await open(alice),b1=await open(bob),resultA=service(a1).apply('p',{epoch:canonical.epoch,ops:[first]},new Access(a1,a1.principal));
const resultB=service(b1).apply('p',{epoch:canonical.epoch,ops:[second]},new Access(b1,b1.principal));
assert.equal(resultA.seq,1);assert.equal(resultB.seq,1);assert.equal(provider.revision,1);assert.equal(provider.data.get(key('page','p')).data.revision,0);
await a1.commit();assert.equal(provider.revision,5);await assert.rejects(b1.commit(),error=>error.code==='REVISION_CONFLICT');
const retryB=await open(bob),acceptedB=service(retryB).apply('p',{epoch:canonical.epoch,ops:[second]},new Access(retryB,retryB.principal));assert.equal(acceptedB.seq,2);assert(acceptedB.blocks[0].text.includes('가족A'));assert(acceptedB.blocks[0].text.includes('가족B'));await retryB.commit();assert.equal(provider.revision,8);
const replay=await open(bob),before=copy(provider.data),ack=service(replay).apply('p',{epoch:canonical.epoch,ops:[first]},new Access(replay,replay.principal));assert.deepEqual(ack.ack,['one:1']);assert.equal(ack.seq,2);await replay.commit();assert.equal(provider.commits.at(-1).changes.length,0);assert.equal(provider.revision,8);assert.deepEqual(provider.data,before);
const forbidden=await open(alice),cancel={id:'two:2',client:'two',clock:2,type:'history.cancel',targets:['two:1']};assert.throws(()=>service(forbidden).apply('p',{epoch:canonical.epoch,ops:[cancel]},new Access(forbidden,forbidden.principal)),error=>error.status===403);await forbidden.commit();assert.equal(provider.commits.at(-1).changes.length,0);assert.deepEqual(provider.data,before);
const doc=provider.data.get(key('collaboration','p')).data;assert.deepEqual(doc.op_owners,{'one:1':'alice','two:1':'bob'});assert.equal(typeof doc.state.seen['one:1'],'string');assert.equal(ack.state.seen['one:1'],true);assert.equal(JSON.stringify(ack).includes('op_owners'),false);assert.equal(Array.from(provider.data.values()).filter(value=>value.kind==='version').length,1);assert.equal(Array.from(provider.data.values()).filter(value=>value.kind==='audit').length,2);
console.log(JSON.stringify({ok:true,lazyEpochCAS:true,stagedPageStateOwnersVersionAudit:true,concurrentMergeAfterFreshSnapshot:true,exactReplayWrites:0,fullOwnerCannotCancelOtherActor:true,actualPostgreSQL:false}));
