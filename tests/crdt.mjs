import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),crdt=require('../static/collaboration.js');
const fixtures=JSON.parse(await readFile(new URL('./fixtures/crdt-vectors.json',import.meta.url),'utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));
let permutations=0;
for(const vector of fixtures.vectors){
  const initial=crdt.seedState(vector.initial_blocks);
  for(const order of vector.permutations){
    let state=initial;for(const index of order)state=crdt.applyOperations(state,[vector.operations[index]]);
    assert.deepEqual(plain(crdt.project(state)),vector.expected,vector.name);
    assert.deepEqual(plain(crdt.project(crdt.applyOperations(state,vector.operations))),vector.expected,vector.name+' idempotency');
    for(const op of vector.operations)assert.equal(state.seen[op.id],createHash('sha256').update(crdt.canonical(op)).digest('hex'));
    assert.equal(state.max_clock,Math.max(0,...vector.operations.map(op=>op.clock)));permutations++;
  }
}
assert.equal(crdt.sha256('abc'),createHash('sha256').update('abc').digest('hex'));
assert.equal(crdt.sha256('한🙂'),createHash('sha256').update('한🙂').digest('hex'));
assert.equal(Object.getPrototypeOf(crdt.seedState([{id:'__proto__',text:'안녕'}]).blocks),null);
const initial=crdt.seedState([{id:'a',text:'secret'}]);
const op={id:'test:1',client:'test',clock:1,type:'block.delete',block_id:'a'};
const deleted=crdt.applyOperations(initial,[op]);assert.ok(!JSON.stringify(crdt.publicState(deleted)).includes('secret'));
assert.throws(()=>crdt.applyOperations(deleted,[{...op,type:'block.set',field:'type',value:'quote'}]),error=>error.status===409);
for(const marks of [{link:'javascript:alert(1)'},{link:'//example.com'},{link:'/\\evil'},{bold:'true'},{color:'url(evil)'}])assert.throws(()=>crdt.validateMarks(marks));
assert.throws(()=>crdt.applyOperations(initial,[{...op,clock:9007199254740992,id:'test:9007199254740992'}]));
console.log(`PASS: ${fixtures.vectors.length} Python/JS CRDT vectors, ${permutations} reorderings, digest parity, tombstones, Unicode, safe marks and idempotency`);

const publicCopy=crdt.publicState(deleted);
assert.ok(Object.values(publicCopy.seen).every(value=>value===true));
assert.deepEqual(crdt.project(crdt.applyOperations(publicCopy,[{...op,type:'block.insert',block_type:'paragraph'}])),[]);
// A delayed ACK from a retired epoch must never roll back a newer restored document.
const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
globalThis.addEventListener ||= ()=>{};globalThis.removeEventListener ||= ()=>{};
const snapshot=(epoch,revision,text)=>({epoch,seq:epoch==='old'?1:0,state:crdt.seedState([{id:'b',text}]),page:{id:'p',revision},access_level:3});
const channel=new crdt.DocumentChannel({pageId:'p',profile:{session:{}},onChange:()=>{}});
await channel.open(snapshot('old',1,'old'),{cached:true});
await channel.receive(snapshot('new',2,'new'),'reset');
await channel.receive(snapshot('old',1,'old'),'ack');
assert.equal(channel.base.epoch,'new');assert.equal(crdt.project(channel.state)[0].text,'new');channel.close();
if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);
console.log('PASS: public seen redaction, ACK sentinel replay, retired-epoch ACK rollback regression');
// Storage and epoch races use an actual channel with a deterministic asynchronous store.
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
function memoryStore(){
  const snapshots=new Map(),operations=new Map(),drafts=new Map();
  const store={snapshots,operations,drafts,failPending:false,failOperations:false,
    key:()=> 'key',getSnapshot:async key=>snapshots.get(key)||null,saveSnapshot:async(key,value)=>{snapshots.set(key,structuredClone(value));},
    pendingOperations:async()=>[...operations.values()].map(value=>structuredClone(value)),
    putOperations:async(key,values)=>{if(store.failOperations){store.failOperations=false;throw new Error('temporary storage fault');}for(const value of values)if(!operations.has(value.id))operations.set(value.id,structuredClone(value));},
    acknowledge:async(key,ids)=>ids.forEach(id=>operations.delete(id)),
    saveDraft:async(key,id,value)=>{if(value?.reason==='pending'&&store.failPending){store.failPending=false;throw new Error('crash after operations committed');}if(value===null)drafts.delete(id);else drafts.set(id,{clientId:id,draft:structuredClone(value),updatedAt:Date.now()});},
    getDrafts:async()=>[...drafts.values()].map(value=>structuredClone(value)),getProfile:async()=>({id:'profile'})};
  return store;
}
const profile={id:'profile',session:{cache_binding:'binding'}};
let store=memoryStore();globalThis.FountainOffline=store;
let local=new crdt.DocumentChannel({pageId:'p',profile});await local.open(snapshot('old',1,'OLD'),{cached:true});
local.replaceText('b','LOCAL DRAFT');await local.persistence;await local.receive(snapshot('new',2,'NEW'),'reset');
local.replaceText('b','NEW EDIT');await local.persistence;
assert.ok([...store.drafts.values()].some(record=>record.draft.reason==='epoch_changed'&&record.draft.blocks[0].text==='LOCAL DRAFT'),'a new pending draft must not overwrite old recovery');
local.close();
store=memoryStore();globalThis.FountainOffline=store;local=new crdt.DocumentChannel({pageId:'p',profile});await local.open(snapshot('old',1,'OLD'),{cached:true});
store.failPending=true;local.replaceText('b','UNSENT');await local.persistence.catch(()=>{});assert.ok(store.operations.size>0);local.close();
store.snapshots.set('key',snapshot('new',2,'REMOTE NEW'));
local=new crdt.DocumentChannel({pageId:'p',profile});await local.open(snapshot('new',2,'REMOTE NEW'),{cached:true});
assert.ok([...store.drafts.values()].some(record=>record.draft.reason==='epoch_changed'&&record.draft.blocks[0].text==='UNSENT'),'durable basis reconstructs an operation-only crash window');local.close();
store=memoryStore();globalThis.FountainOffline=store;local=new crdt.DocumentChannel({pageId:'p',profile});await local.open(snapshot('old',1,'OLD'),{cached:true});
store.failOperations=true;local.replaceText('b','FIRST');await local.persistence.catch(()=>{});assert.equal(local.durable,false);
local.replaceText('b','FIRST SECOND');await local.persistence;assert.equal(local.durable,true);assert.equal(store.operations.size,local.pending.size);local.close();
store=memoryStore();globalThis.FountainOffline=store;local=new crdt.DocumentChannel({pageId:'p',profile});await local.open({...snapshot('old',1,'OLD'),access_revision:1},{cached:true});
await local.receive({...snapshot('old',1,'OLD'),access_revision:5,access_level:1});await local.receive({...snapshot('old',1,'OLD'),access_revision:4,access_level:3},'ack');assert.equal(local.base.access_level,1);local.close();
delete globalThis.FountainOffline;if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);
console.log('PASS: immutable recovery slots, operation-only crash recovery, retry all pending after storage failure, ACL generation fence');
