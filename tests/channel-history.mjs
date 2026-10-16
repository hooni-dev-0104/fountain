import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../static/collaboration.js');
const plain=value=>JSON.parse(JSON.stringify(value));
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
globalThis.addEventListener ||= ()=>{};globalThis.removeEventListener ||= ()=>{};
function memory(){
  const operations=new Map(),drafts=new Map(),snapshots=new Map();
  return {operations,drafts,fail:false,key:()=> 'key',getSnapshot:async()=>snapshots.get('key'),saveSnapshot:async(key,value)=>snapshots.set(key,structuredClone(value)),
    pendingOperations:async()=>[...operations.values()].map(value=>structuredClone(value)),
    putOperations:async function(key,entries){if(this.fail){this.fail=false;throw Error('disk unavailable');}for(const entry of entries)operations.set(entry.id,structuredClone(entry));},
    acknowledge:async(key,ids)=>ids.forEach(id=>operations.delete(id)),
    saveDraft:async(key,id,draft)=>{if(draft===null)drafts.delete(id);else drafts.set(id,{clientId:id,draft:structuredClone(draft)});},getDrafts:async()=>[...drafts.values()],getProfile:async()=>({id:'profile'})};
}
const profile={id:'profile',session:{cache_binding:'binding'}};
function fixture(blocks=[{id:'b',text:'A🙂B'}]){
  const store=memory();globalThis.FountainOffline=store;
  let state=C.seedState(blocks),seq=0,epoch='epoch',revision=1;
  const snapshot=()=>({epoch,seq,state:C.publicState(state),blocks:C.project(state),page:{id:'p',revision},access_level:4});
  const changes=[],errors=[],histories=[],requests=[];
  const channel=new C.DocumentChannel({pageId:'p',profile,onChange:change=>changes.push(change),onHistory:value=>histories.push(value),onError:error=>errors.push(error),fetcher:async(path,body)=>{
    if(body){for(const operation of body.ops)if(operation.type==='history.cancel')for(const id of operation.targets)assert.ok(state.seen[id]||body.ops.some(value=>value.id===id),'every HTTP cancellation target is causally available');requests.push(body.ops.map(op=>op.id));state=C.applyOperations(state,body.ops);seq++;revision++;return {...snapshot(),ack:body.ops.map(op=>op.id)};}return snapshot();
  }});
  return {channel,store,changes,errors,histories,requests,snapshot,remote:ops=>{state=C.applyOperations(state,ops);seq++;revision++;},replace:()=>{state=C.seedState([{id:'b',text:'new'}]);epoch='replacement';revision++;},state:()=>state};
}
const op=(client,clock,type,fields={})=>({id:client+':'+clock,client,clock,type,...(type==='history.cancel'?{}:{block_id:'b'}),...fields});
let f=fixture();await f.channel.open(f.snapshot(),{cached:true});
const local=f.channel.replaceText('b','AX🙂B');await f.channel.persistence;
f.channel.submitPrepared(local);await f.channel.persistence;assert.equal(f.channel.undoStack.length,1,'exact operation replay does not add a second history action');
f.remote(local);f.remote([op('family',10,'text.insert',{after_id:local[0].id+':0',text:'Y'})]);await f.channel.receive(f.snapshot());
assert.equal(f.changes.at(-1).blocks[0].text,'AXY🙂B');
await f.channel.undo();assert.equal(f.changes.at(-1).blocks[0].text,'AY🙂B','undo hides own original characters only');
await f.channel.redo();assert.equal(f.changes.at(-1).blocks[0].text,'AXY🙂B');
assert.ok([...f.channel.pending.values()].filter(value=>value.type==='history.cancel').every(value=>!Object.hasOwn(value,'block_id')));
assert.equal(f.channel.undoStack.length,1);f.channel.close();assert.equal(f.channel.undoStack.length,0);

f=fixture([{id:'b',text:'A'}]);await f.channel.open(f.snapshot(),{cached:true});
f.channel.replaceText('b','AB');f.channel.replaceText('b','ABC');await f.channel.persistence;
assert.equal(f.channel.undoStack.length,1,'adjacent typing merges history IDs without rewriting wire groups');
assert.equal(new Set([...f.channel.pending.values()].map(value=>value.group_id)).size,2);
await f.channel.undo();assert.equal(f.changes.at(-1).blocks[0].text,'A');
await f.channel.redo();assert.equal(f.changes.at(-1).blocks[0].text,'ABC');
f.channel.transact({kind:'structure'},()=>f.channel.reconcile([{id:'b',type:'paragraph',text:'X'},{id:'child',type:'quote',text:'new',parent_id:'b'}]));
await f.channel.persistence;assert.equal(f.channel.undoStack.length,2,'reconcile internal text and structure queues are one action');
await f.channel.undo();assert.deepEqual(f.changes.at(-1).blocks.map(value=>[value.id,value.text]),[['b','ABC']]);
f.channel.replaceText('b','ABCD');assert.equal(f.channel.redoStack.length,0,'new edits retire redo');await f.channel.persistence;f.channel.close();

f=fixture([{id:'b',text:'',type:'paragraph'}]);await f.channel.open(f.snapshot(),{cached:true});f.channel.clock=2;
const heading=f.channel.submit([{type:'block.set',block_id:'b',fields:{field:'type',value:'heading1'}}]);await f.channel.persistence;
f.remote([op('family',2,'block.set',{field:'type',value:'quote'}),...heading]);await f.channel.receive(f.snapshot());
assert.equal(f.changes.at(-1).blocks[0].type,'heading1');
await f.channel.undo();assert.equal(f.channel.historyState().historyPending,true,'hidden winning value is unresolved offline');
assert.equal(f.changes.at(-1).blocks[0].type,'heading1','keep the resolved view instead of guessing a value');
assert.throws(()=>f.channel.replaceText('b','unsafe'),error=>error.status===425);
await f.channel.persistence;assert.ok([...f.store.drafts.values()].some(record=>record.draft.history_pending));
assert.ok([...f.store.operations.values()].some(value=>value.type==='history.cancel'));
globalThis.navigator.onLine=true;await f.channel.flush();
assert.equal(f.channel.historyState().historyPending,false,JSON.stringify({errors:f.errors.map(error=>error.message),pending:f.channel.pending.size,unresolved:f.channel.state.unresolved_slots}));assert.equal(f.changes.at(-1).blocks[0].type,'quote');
assert.equal(f.channel.pending.size,0);
await f.channel.receive({...f.snapshot(),access_level:1});assert.equal(f.channel.undoStack.length,0,'read access clears history with no pending operations');
f.channel.close();globalThis.navigator.onLine=false;

f=fixture([{id:'b',text:'A'}]);await f.channel.open(f.snapshot(),{cached:true});f.channel.replaceText('b','AB');await f.channel.persistence;
f.store.fail=true;const undo=await f.channel.undo();assert.equal(undo.changed,true);const cancelIds=[...f.channel.pending.values()].filter(value=>value.type==='history.cancel').map(value=>value.id);
assert.equal(cancelIds.length,1);assert.equal(f.channel.redoStack.length,1);assert.equal(f.channel.undoStack.length,0);
await f.channel.persistPending();assert.deepEqual([...f.store.operations.values()].filter(value=>value.type==='history.cancel').map(value=>value.id),cancelIds,'retry persists the same cancellation IDs');
f.replace();await f.channel.receive(f.snapshot());assert.equal(f.channel.undoStack.length+f.channel.redoStack.length,0);f.channel.close();

f=fixture([{id:'b',text:'A'}]);await f.channel.open(f.snapshot(),{cached:true});
for(let index=0;index<110;index++)f.channel.transact({kind:'format'},()=>f.channel.format('b',['seed:b:0'],{bold:index%2===0}));
await f.channel.persistence;assert.equal(f.channel.undoStack.length,100);assert.equal(f.channel.historyState().truncated,true);f.channel.close();

f=fixture([{id:'b',text:'A'}]);await f.channel.open(f.snapshot(),{cached:true});
f.channel.transact({kind:'format'},()=>f.channel.submit(Array.from({length:1101},(_,index)=>({type:'text.format',block_id:'b',fields:{char_ids:['seed:b:0'],marks:{bold:index%2===0}}}))));
await f.channel.persistence;await f.channel.undo();assert.equal([...f.channel.pending.values()].filter(value=>value.type==='history.cancel').length,2,'large actions use complete bounded cancellation batches');
assert.deepEqual(plain(f.changes.at(-1).blocks[0].rich_text),[{text:'A',marks:{}}]);globalThis.navigator.onLine=true;await f.channel.flush();
assert.equal(f.requests.length,4);assert.ok(f.requests.every(batch=>batch.length<=300));assert.equal(f.channel.pending.size,0);
await f.channel.redo();await f.channel.flush();assert.equal(f.changes.at(-1).blocks[0].rich_text[0].marks.bold,true);f.channel.close();globalThis.navigator.onLine=false;

f=fixture();await f.channel.open(f.snapshot(),{cached:true});f.channel.replaceText('b','AX🙂B');await f.channel.persistence;
f.channel.pending.set('stale:1',{...op('stale',1,'text.insert',{after_id:null,text:'old'}),_epoch:'retired'});
let release,entered;const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>entered=resolve),readDrafts=f.store.getDrafts;
let recoveryWrites=0;const saveDraft=f.store.saveDraft;f.store.saveDraft=async(...args)=>{recoveryWrites++;return saveDraft(...args);};
f.store.getDrafts=async()=>{entered();await gate;return readDrafts();};
const rebuilding=f.channel.rebuild('queue');await waiting;f.channel.close();release();await rebuilding;
assert.equal(f.channel.historyHints.size,0,'a closed channel cannot repopulate remembered private values');
assert.equal(recoveryWrites,0,'a late recovery read cannot write a new draft after close');
delete globalThis.FountainOffline;
console.log('PASS: channel selective undo/redo, remote anchors, typing/structural groups, unknown offline barrier and canonical resolution, durable retry, ACL/epoch fences and bounded history');
