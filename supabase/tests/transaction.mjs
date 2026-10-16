import assert from 'node:assert/strict';
import test from 'node:test';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {StoreError} from '../functions/_shared/store.ts';
const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'b'.repeat(32),expiresAt:Date.now()+60000,profile:{workspaceId:'qa',authSessionActive:true,member:{id:'alice',name:'A',email:'a@example.invalid',role:'member',active:true}}};
const clone=structuredClone,stamp='2026-10-16T00:00:00.000000+00:00';
function fixture(){
 let revision=0,record={id:'p',title:'original',created_at:stamp,updated_at:stamp},lost=false,conflict=false,commits=0;
 const receipts=new Map(),snapshots=[];
 const provider={
  async snapshot(request){snapshots.push(clone(request));const selected=request.selection;
   return {workspaceId:'qa',memberId:'alice',revision,accessRevision:0,principal:clone(auth.profile.member),entities:selected.kinds.includes('page')||selected.ids.page?.includes('p')?[{kind:'page',id:'p',data:clone(record),createdAt:stamp,updatedAt:record.updated_at}]:[],meta:selected.metaKeys.map(key=>({key,value:null,present:false})),nextCursor:null};},
  async commit(request){commits++;if(receipts.has(request.transactionId))return receipts.get(request.transactionId);
   if(conflict){conflict=false;revision++;throw new StoreError(409,'REVISION_CONFLICT','fixture conflict');}
   assert.equal(request.expectedRevision,revision);for(const change of request.changes)if(change.op==='put')record=clone(change.data);
   revision+=request.changes.length;const result={revision};receipts.set(request.transactionId,result);
   if(lost){lost=false;throw Error('ack lost');}return result;}
 };
 return {provider,snapshots,get record(){return record;},get commits(){return commits;},get receipts(){return receipts.size;},lose(){lost=true;},conflict(){conflict=true;}};
}
test('missing data expands a fresh snapshot and only an acknowledged value escapes',async()=>{
 const f=fixture();let actions=0,proofs=0;
 const execute=createTransactions({provider:f.provider,authorize:async()=>{proofs++;return clone(auth);}});
 const result=await execute(auth,store=>{actions++;const page=store.get('page','p');store.put('page',{...page,title:'saved'});return page.title;});
 assert.equal(result.value,'original');assert.equal(result.revision,1);assert.equal(f.record.title,'saved');assert.equal(actions,2);assert.equal(proofs,2);assert.equal(f.commits,1);
 assert.deepEqual(f.snapshots[1].selection.ids,{page:['p']});
});
test('lost commit acknowledgement retries the exact receipt without executing domain action twice',async()=>{
 const f=fixture();f.lose();let actions=0;
 const execute=createTransactions({provider:f.provider,authorize:async()=>clone(auth)});
 const result=await execute(auth,store=>{actions++;store.put('page',{...store.get('page','p'),title:'once'});return {accepted:true};},{kinds:['page']});
 assert.equal(actions,1);assert.equal(f.commits,2);assert.equal(f.receipts,1);assert.equal(result.revision,1);
});
test('revision conflict reauthorizes before replay and stops on changed login',async()=>{
 const f=fixture();f.conflict();let proofs=0,actions=0;
 const execute=createTransactions({provider:f.provider,authorize:async()=>{proofs++;return proofs===1?clone(auth):{...clone(auth),cacheBinding:'c'.repeat(32)};}});
 await assert.rejects(execute(auth,store=>{actions++;store.put('page',{...store.get('page','p'),title:'discarded'});return true;},{kinds:['page']}),error=>error.status===401);
 assert.equal(proofs,2);assert.equal(actions,1);assert.equal(f.record.title,'original');assert.equal(f.receipts,0);
});
test('asynchronous actions cannot publish a value or commit staged writes',async()=>{
 const f=fixture(),execute=createTransactions({provider:f.provider,authorize:async()=>clone(auth)});
 await assert.rejects(execute(auth,async store=>{await Promise.resolve();store.put('page',{title:'late'});return true;}),error=>error.code==='ASYNC_TRANSACTION_FORBIDDEN');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.commits,0);assert.equal(f.record.title,'original');
});
test('selection and collision retries are bounded',async()=>{
 const f=fixture(),execute=createTransactions({provider:f.provider,authorize:async()=>clone(auth),maxSelectionRounds:1});
 await assert.rejects(execute(auth,store=>store.list('page')),error=>error.code==='SELECTION_LIMIT');assert.equal(f.commits,0);
});
