/** Actual CRDT channel with a memory persistence fixture; not a native SDK test. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const C=createRequire(import.meta.url)('../static/collaboration.js');
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
globalThis.addEventListener ||= ()=>{};globalThis.removeEventListener ||= ()=>{};
const clone=structuredClone;
function fixture(){
 const operations=new Map(),drafts=new Map();let saved,state=C.seedState([{id:'b',text:'A'}]),seq=0,gate=null,entered=null;
 globalThis.FountainOffline={key:()=> 'key',getSnapshot:async()=>saved,saveSnapshot:async(_,value)=>{saved=clone(value);},pendingOperations:async()=>[...operations.values()].map(value=>clone(value)),putOperations:async(_,entries)=>entries.forEach(v=>operations.set(v.id,clone(v))),saveDraft:async(_,id,draft)=>{if(draft===null)drafts.delete(id);else drafts.set(id,{clientId:id,draft:clone(draft)});},getDrafts:async()=>[...drafts.values()],getProfile:async()=>({id:'profile'}),commitOperationsAck:async(_,snapshot,ids)=>{saved=clone(snapshot);const acknowledged=ids.filter(id=>Object.hasOwn(saved.state.seen,id)&&operations.get(id)?._epoch===saved.epoch);acknowledged.forEach(id=>operations.delete(id));return {snapshot:clone(saved),acknowledged};}};
 const snapshot=()=>({epoch:'epoch',seq,state:C.publicState(state),blocks:C.project(state),page:{id:'p',revision:seq},access_level:4});
 const requests=[];
 const channel=new C.DocumentChannel({pageId:'p',profile:{id:'profile',session:{cache_binding:'binding'}},fetcher:async(path,body)=>{
  requests.push({path,body});if(body){entered?.();if(gate)await gate;state=C.applyOperations(state,body.ops);seq++;return {...snapshot(),ack:body.ops.map(op=>op.id)};}return snapshot();
 }});
 return {channel,requests,operations,snapshot,hold(){let release,arrive;gate=new Promise(r=>release=r);const waiting=new Promise(r=>arrive=r);entered=arrive;return {waiting,release};}};
}
test('reconciliation pause suppresses network while retaining the exact durable local input',async()=>{
 const f=fixture();try{
  navigator.onLine=false;await f.channel.open(f.snapshot(),{cached:true});f.channel.replaceText('b','AB');await f.channel.persistence;
  const before=clone([...f.operations]);f.channel.pauseNetwork('plan-a');navigator.onLine=true;
  await f.channel.flush();await f.channel.reconnect();assert.equal(f.requests.length,0);assert.deepEqual([...f.operations],before);assert.equal(f.channel.remoteDeferred,false);
  assert.equal(f.channel.resumeNetwork('plan-a'),true);await f.channel.flush();assert.equal(f.requests.filter(v=>v.body).length,1);assert.equal(f.operations.size,0);
 }finally{f.channel.close();navigator.onLine=false;}
});
test('an already admitted POST can finish and persist its proven ACK while new sends are paused',async()=>{
 const f=fixture();try{
  assert.equal(typeof f.channel.pauseNetwork,'function');
  navigator.onLine=false;await f.channel.open(f.snapshot(),{cached:true});f.channel.replaceText('b','AB');await f.channel.persistence;
  const hold=f.hold();navigator.onLine=true;const flushing=f.channel.flush();await hold.waiting;
  f.channel.pauseNetwork('plan-a');hold.release();await flushing;
  assert.equal(f.channel.closed,false);assert.equal(f.requests.length,1);assert.equal(f.operations.size,0);assert.equal(f.channel.pending.size,0);assert.equal(f.channel.resumeNetwork('plan-a'),true);
 }finally{f.channel.close();navigator.onLine=false;}
});
test('only matching pause owners resume the channel and local creation deferral remains independent',async()=>{
 const f=fixture();try{
  await f.channel.open(f.snapshot(),{cached:true});f.channel.pauseNetwork('plan-a');f.channel.pauseNetwork('plan-b');
  assert.equal(f.channel.resumeNetwork('stale'),false);assert.equal(f.channel.resumeNetwork('plan-a'),false);
  assert.equal(f.channel.networkPaused,true);assert.equal(f.channel.resumeNetwork('plan-b'),true);assert.equal(f.channel.networkPaused,false);
  f.channel.remoteDeferred=true;f.channel.pauseNetwork('plan-c');f.channel.resumeNetwork('plan-c');assert.equal(f.channel.remoteDeferred,true);
  f.channel.close();assert.equal(f.channel.resumeNetwork('plan-c'),false);
 }finally{f.channel.close();navigator.onLine=false;}
});
