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

// A local page survives editing and reopening while online, without any GET,
// SSE or operation POST before its durable page.create receipt is applied.
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
const priorSource=globalThis.EventSource,priorTransport=globalThis.FountainTransport;
let eventConnections=0,creationPending=true;
globalThis.EventSource=function(){};
globalThis.FountainTransport={events:()=>{eventConnections++;return {addEventListener(){},close(){}};}};
store=memoryStore();store.getLocalPage=async()=>({localOnly:creationPending});globalThis.FountainOffline=store;
const localSnapshot={epoch:'local-create-epoch',seq:0,state:crdt.seedState([]),blocks:[],page:{id:'p',revision:0,locked:false},access_level:4,session_binding:'binding'};
let remoteSnapshot=structuredClone(localSnapshot);const requests=[];
const fetcher=async(path,body)=>{
  requests.push({path,body});
  if(body){remoteSnapshot.state=crdt.applyOperations(remoteSnapshot.state,body.ops);remoteSnapshot.blocks=crdt.project(remoteSnapshot.state);remoteSnapshot.seq+=body.ops.length;return {...structuredClone(remoteSnapshot),ack:body.ops.map(op=>op.id)};}
  return structuredClone(remoteSnapshot);
};
local=new crdt.DocumentChannel({pageId:'p',profile,fetcher,deferRemote:true});
await local.open(localSnapshot,{cached:true});
local.submit([{type:'block.insert',block_id:'offline-block',fields:{block_type:'paragraph'}},
  {type:'text.insert',block_id:'offline-block',fields:{after_id:null,text:'새 페이지의 미전송 본문'}}]);
await local.persistence;
await local.flush();await local.reconnect();local.connectEvents();local.retry();await local.onlineHandler();
assert.equal(requests.length,0);assert.equal(eventConnections,0);
assert.equal(await local.resumeRemote(),false);
assert.ok(store.operations.size>0);local.close();
local=new crdt.DocumentChannel({pageId:'p',profile,fetcher,deferRemote:true});
await local.open(localSnapshot,{cached:true});
assert.equal(crdt.project(local.state)[0].text,'새 페이지의 미전송 본문');
assert.equal(requests.length,0);assert.equal(await local.resumeRemote(),false);
await assert.rejects(local.fetch('/pages/p/collaboration'),error=>error.status===425);
creationPending=false;
assert.deepEqual(await Promise.all([local.resumeRemote(),local.resumeRemote()]),[true,true]);
assert.equal(requests.filter(request=>!request.body).length,1);
assert.equal(eventConnections,1);assert.equal(local.remoteDeferred,false);
assert.equal(local.pending.size,0);assert.equal(store.operations.size,0);
assert.equal(remoteSnapshot.blocks[0].text,'새 페이지의 미전송 본문');
assert.equal((await store.getDrafts('key')).filter(record=>!['pending','basis'].includes(record.draft.reason)).length,0);
local.close();delete globalThis.FountainOffline;
if(priorSource===undefined)delete globalThis.EventSource;else globalThis.EventSource=priorSource;
if(priorTransport===undefined)delete globalThis.FountainTransport;else globalThis.FountainTransport=priorTransport;
if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);
console.log('PASS: local page remote gate across open, queue, flush, online, retry, restart and applied creation ACK');

// Presence is ephemeral and belongs to this exact actor, login and epoch.
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
store=memoryStore();globalThis.FountainOffline=store;
const presenceProfile={...profile,workspaceId:'family-workspace',memberId:'owner'};
const received=[];
local=new crdt.DocumentChannel({pageId:'p',profile:presenceProfile,onPresence:value=>received.push(plain(value))});
await local.open(snapshot('old',1,'현재 본문'),{cached:true});
const presence={epoch:'old',revision:10,workspace_id:'family-workspace',current_member_id:'owner',session_binding:'binding',participants:[{id:'peer',name:'가족',selection:null}]};
local.receivePresence(presence);
assert.equal(received.length,1);
for(const invalid of [{session_binding:'other-login'},{current_member_id:'other-member'},{workspace_id:'other-workspace'},{epoch:'other-epoch'},{revision:9},{revision:NaN},{participants:null}])local.receivePresence({...presence,...invalid});
assert.equal(received.length,1,'stale and unrelated presence must not reach the UI');
assert.equal((await store.getSnapshot('key')).participants,undefined,'live participants must not enter offline document snapshots');
await local.receive(snapshot('restored',2,'복원 본문'));
assert.equal(received.at(-1).reset,true);
assert.deepEqual(received.at(-1).participants,[]);
local.receivePresence({...presence,epoch:'restored',revision:11});
assert.equal(received.at(-1).revision,11);
local.close();local.receivePresence({...presence,epoch:'restored',revision:12});
assert.equal(received.at(-1).revision,11,'closed channels must ignore late presence');
local=new crdt.DocumentChannel({pageId:'p',profile:presenceProfile,deferRemote:true,onPresence:value=>received.push(plain(value))});
await local.open(localSnapshot,{cached:true});
const count=received.length;local.receivePresence({...presence,epoch:localSnapshot.epoch,revision:99});
assert.equal(received.length,count,'a local-only page must not accept live presence');
local.close();delete globalThis.FountainOffline;
if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);
console.log('PASS: ephemeral presence is fenced by actor, login, workspace, epoch, revision and local-only lifecycle');
