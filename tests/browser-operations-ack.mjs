/** Real Chrome/IndexedDB ACK atomicity and process-restart recovery, isolated from app data. */
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-operations-ack-'));
const sources=new Map(await Promise.all(['offline.js','collaboration.js'].map(async name=>['/'+name,await readFile(new URL('../static/'+name,import.meta.url))])));
const server=createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');
  if(sources.has(request.url)){response.setHeader('Content-Type','application/javascript');response.end(sources.get(request.url));}
  else if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Isolated ACK fixture</title>');}
  else{response.statusCode=404;response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let context,page,stage='startup';
async function launch(){
  context=await chromium.launchPersistentContext(directory,{...(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME}:{channel:'chrome'}),headless:true,serviceWorkers:'block'});
  page=await context.newPage();await page.goto(origin);
  await page.addScriptTag({url:origin+'/offline.js'});await page.addScriptTag({url:origin+'/collaboration.js'});
  await page.evaluate(()=>{globalThis.fixtureOnline=false;Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>fixtureOnline});});
}
async function fault(mode){
  await page.evaluate(mode=>{
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args){
      if(this.name==='snapshots'&&value.snapshot?.seq>0){
        if(mode==='put')throw new DOMException('Synthetic canonical put failure','QuotaExceededError');
        const result=put.call(this,value,...args);result.addEventListener('success',()=>this.transaction.abort(),{once:true});return result;
      }
      return put.call(this,value,...args);
    };
    globalThis.restoreAckFault=()=>{IDBObjectStore.prototype.put=put;};
  },mode);
}
async function setup(id){
  return page.evaluate(async id=>{
    const profile=await FountainOffline.saveProfile({workspaceId:'ack-workspace',memberId:'ack-member',session:{authenticated:true,mode:'accounts',cache_binding:'ack-binding',expires_at:new Date(Date.now()+3600000).toISOString(),member:{id:'ack-member',active:true}},workspace:{pages:[]}});
    const key=FountainOffline.key(profile,id),state=FountainCollaboration.seedState([{id:'b',text:'ORIGINAL'}]);
    const snapshot={epoch:'epoch-'+id,seq:0,state,blocks:FountainCollaboration.project(state),page:{id,revision:0,locked:false},access_level:3,access_revision:1,workspace_id:profile.workspaceId,current_member_id:profile.memberId,session_binding:profile.cacheBinding};
    await FountainOffline.saveSnapshot(key,snapshot);
    return {profile,key,snapshot};
  },id);
}
async function coldRestart(){await context.close();context=null;await launch();}
async function queue(fixture,count=2){
  return page.evaluate(async({fixture,count})=>{
    const operations=Array.from({length:count},(_,index)=>({id:'fixture:'+(index+1),client:'fixture',clock:index+1,type:'text.insert',block_id:'b',after_id:index?'fixture:'+index+':0':'seed:b:0',text:String.fromCharCode(88+index),_epoch:fixture.snapshot.epoch}));
    await FountainOffline.putOperations(fixture.key,operations);return operations;
  },{fixture,count});
}
async function canonical(fixture,operations,patch={}){
  return page.evaluate(({fixture,operations,patch})=>{
    const state=FountainCollaboration.applyOperations(fixture.snapshot.state,operations.map(({_epoch,...operation})=>operation));
    return {...fixture.snapshot,seq:operations.length,state,blocks:FountainCollaboration.project(state),...patch,page:{...fixture.snapshot.page,revision:operations.length,...patch.page}};
  },{fixture,operations,patch});
}
async function commit(fixture,snapshot,ids){return page.evaluate(({key,snapshot,ids})=>FountainOffline.commitOperationsAck(key,snapshot,ids),{key:fixture.key,snapshot,ids});}
async function inspect(fixture){return page.evaluate(async key=>({snapshot:await FountainOffline.getSnapshot(key),pending:await FountainOffline.pendingOperations(key),drafts:await FountainOffline.getDrafts(key)}),fixture.key);}
try{
  await launch();
  stage='canonical put failure followed by an actual Chrome process restart';
  const fixture=await setup('crash-put');
  await page.evaluate(async fixture=>{
    const crdt=FountainCollaboration;let remote=structuredClone(fixture.snapshot);
    globalThis.ackErrors=[];globalThis.ackStatuses=[];
    globalThis.ackChannel=new crdt.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile,onError:error=>ackErrors.push(error.message),onStatus:value=>ackStatuses.push(value),fetcher:async(path,body)=>{
      remote.state=crdt.applyOperations(remote.state,body.ops);remote.blocks=crdt.project(remote.state);remote.seq+=body.ops.length;remote.page.revision++;
      return {...structuredClone(remote),ack:body.ops.map(operation=>operation.id)};
    }});
    await ackChannel.open(fixture.snapshot,{cached:true});ackChannel.replaceText('b','MY ACCEPTED EDIT');await ackChannel.persistence;clearTimeout(ackChannel.flushTimer);
  },fixture);
  await fault('put');
  const failed=await page.evaluate(async key=>{
    fixtureOnline=true;await ackChannel.flush();fixtureOnline=false;restoreAckFault();
    const result={pending:ackChannel.pending.size,stored:(await FountainOffline.pendingOperations(key)).length,snapshot:await FountainOffline.getSnapshot(key),status:ackChannel.status,durable:ackChannel.durable};ackChannel.close();return result;
  },fixture.key);
  await coldRestart();
  const recovered=await page.evaluate(async fixture=>{
    const cached=await FountainOffline.getSnapshot(fixture.key),pending=await FountainOffline.pendingOperations(fixture.key);
    const channel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:await FountainOffline.getProfile()});
    await channel.open(cached,{cached:true});const text=FountainCollaboration.project(channel.state)[0].text;channel.close();return {text,pending:pending.length,seq:cached.seq};
  },fixture);
  assert.equal(recovered.text,'MY ACCEPTED EDIT','a failed canonical save after server ACK must survive a Chrome cold restart');
  assert.ok(recovered.pending>0);assert.ok(failed.pending>0);assert.ok(failed.stored>0);assert.equal(failed.status,'error');assert.equal(failed.durable,false);
  console.log('PASS: canonical put failure preserves the accepted edit across Chrome process restart');

  stage='actual transaction abort rolls back both canonical put and operation deletes';
  const abortFixture=await setup('transaction-abort'),abortOps=await queue(abortFixture),abortSnapshot=await canonical(abortFixture,abortOps);
  await fault('abort');
  await assert.rejects(commit(abortFixture,abortSnapshot,abortOps.map(value=>value.id)));
  await page.evaluate(()=>restoreAckFault());
  let stored=await inspect(abortFixture);assert.equal(stored.snapshot.seq,0);assert.equal(stored.pending.length,2);
  await coldRestart();stored=await inspect(abortFixture);assert.equal(stored.snapshot.seq,0);assert.equal(stored.pending.length,2);

  stage='ACK deletes only matching epoch and own seen IDs, with canonical data in the same commit';
  const proofFixture=await setup('proof'),proofOps=await queue(proofFixture),proofSnapshot=await canonical(proofFixture,proofOps.slice(0,1));
  await page.evaluate(async({key,epoch})=>FountainOffline.putOperations(key,[{id:'toString',_epoch:epoch},{id:'other-epoch',_epoch:'retired-epoch'}]),{key:proofFixture.key,epoch:proofFixture.snapshot.epoch});
  proofSnapshot.state.seen['other-epoch']=true;
  let committed=await commit(proofFixture,proofSnapshot,[proofOps[0].id,proofOps[1].id,'toString','other-epoch','unseen']);
  assert.deepEqual(committed.acknowledged,[proofOps[0].id]);assert.equal(committed.snapshot.seq,1);
  stored=await inspect(proofFixture);assert.deepEqual(stored.pending.map(value=>value.id).sort(),['fixture:2','other-epoch','toString']);
  const repeated=await commit(proofFixture,proofSnapshot,[proofOps[0].id]);assert.deepEqual(repeated.acknowledged,[proofOps[0].id]);

  stage='older same-epoch ACK uses the selected persisted canonical without ACL or revision rollback';
  const staleFixture=await setup('stale'),staleOps=await queue(staleFixture),newer=await canonical(staleFixture,staleOps,{seq:8,access_revision:5,access_level:1,page:{revision:12}}),older=await canonical(staleFixture,[],{seq:1,access_revision:1,page:{revision:2}});
  await page.evaluate(({key,snapshot})=>FountainOffline.saveSnapshot(key,snapshot),{key:staleFixture.key,snapshot:newer});
  committed=await commit(staleFixture,older,staleOps.map(value=>value.id));assert.deepEqual(committed.acknowledged,staleOps.map(value=>value.id));
  assert.equal(committed.snapshot.seq,8);assert.equal(committed.snapshot.access_level,1);assert.equal(committed.snapshot.access_revision,5);assert.equal(committed.snapshot.page.revision,12);
  const revisionOnly={...older,access_revision:5,seq:100};
  committed=await commit(staleFixture,revisionOnly,[]);assert.equal(committed.snapshot.seq,8);assert.equal(committed.snapshot.page.revision,12);

  stage='delayed same-document snapshot cannot downgrade the persisted global data revision';
  const dataFixture=await setup('data-revision'),dataOps=await queue(dataFixture,3),dataFresh=await canonical(dataFixture,dataOps.slice(0,2),{data_revision:10}),dataOld={...dataFresh,data_revision:9};
  await page.evaluate(({key,snapshot})=>FountainOffline.saveSnapshot(key,snapshot),{key:dataFixture.key,snapshot:dataFresh});
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;globalThis.snapshotPuts=0;IDBObjectStore.prototype.put=function(...args){if(this.name==='snapshots')snapshotPuts++;return put.apply(this,args);};globalThis.restoreDataPut=()=>IDBObjectStore.prototype.put=put;});
  const selected=await page.evaluate(({key,snapshot})=>FountainOffline.saveSnapshot(key,snapshot),{key:dataFixture.key,snapshot:dataOld});
  assert.deepEqual(selected,dataFresh);assert.equal(await page.evaluate(()=>snapshotPuts),0,'an older data revision never becomes an active native snapshot delta');
  assert.equal(await page.evaluate(async({key,snapshot})=>{for(const value of [undefined,null,'9',9.5,NaN,Infinity]){const input={...snapshot,data_revision:value};if(value===undefined)delete input.data_revision;const selected=await FountainOffline.saveSnapshot(key,input);if(selected.data_revision!==snapshot.data_revision)return false;}return true;},{key:dataFixture.key,snapshot:dataFresh}),true,'a known persisted data floor is also preserved against unversioned or malformed late input');
  const pendingBefore=(await inspect(dataFixture)).pending;
  committed=await commit(dataFixture,dataOld,dataOps.map(value=>value.id));assert.deepEqual(committed.snapshot,dataFresh);assert.deepEqual(committed.acknowledged,dataOps.slice(0,2).map(value=>value.id));
  assert.deepEqual((await inspect(dataFixture)).pending,pendingBefore.slice(2),'only the persisted canonical own-seen operations are removed, without rewriting the unconfirmed input');
  committed=await commit(dataFixture,{...dataOld,epoch:'different-epoch'},[dataOps[2].id]);assert.deepEqual(committed.acknowledged,[]);assert.deepEqual((await inspect(dataFixture)).pending,pendingBefore.slice(2));
  assert.equal(await page.evaluate(()=>snapshotPuts),0);await page.evaluate(()=>restoreDataPut());

  stage='epoch mismatch cannot ACK an operation using the replacement epoch';
  const epochFixture=await setup('epoch-proof'),epochOps=await queue(epochFixture),oldEpochAck=await canonical(epochFixture,epochOps),replacement={...oldEpochAck,epoch:'replacement',seq:0,page:{...oldEpochAck.page,revision:20}};
  await page.evaluate(({key,snapshot})=>FountainOffline.saveSnapshot(key,snapshot),{key:epochFixture.key,snapshot:replacement});
  committed=await commit(epochFixture,oldEpochAck,epochOps.map(value=>value.id));assert.deepEqual(committed.acknowledged,[]);assert.equal(committed.snapshot.epoch,'replacement');assert.equal((await inspect(epochFixture)).pending.length,2);

  stage='newer unsaved RAM state is not used as durable ACK proof';
  const ramFixture=await setup('ram-failure'),ramOps=await queue(ramFixture),ramNewer=await canonical(ramFixture,ramOps),ramOlder=await canonical(ramFixture,ramOps.slice(0,1));
  await page.evaluate(async fixture=>{globalThis.ramChannel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile});await ramChannel.open(fixture.snapshot,{cached:true});},ramFixture);
  await fault('put');await assert.rejects(page.evaluate(snapshot=>ramChannel.receive(snapshot),ramNewer));await page.evaluate(()=>restoreAckFault());
  const ramResult=await page.evaluate(async({snapshot,ids,key})=>{
    const acknowledged=await ramChannel.receive(snapshot,'ack',ids);const result={acknowledged,ramSeq:ramChannel.base.seq,pending:[...ramChannel.pending.keys()],persisted:await FountainOffline.getSnapshot(key),rows:await FountainOffline.pendingOperations(key)};ramChannel.close();return result;
  },{snapshot:ramOlder,ids:ramOps.map(value=>value.id),key:ramFixture.key});
  assert.deepEqual(ramResult.acknowledged,[ramOps[0].id]);assert.equal(ramResult.ramSeq,2);assert.equal(ramResult.persisted.seq,1);assert.deepEqual(ramResult.pending,[ramOps[1].id]);assert.equal(ramResult.rows.length,1);
  await coldRestart();
  const rebuilt=await page.evaluate(async key=>{const snapshot=await FountainOffline.getSnapshot(key),rows=await FountainOffline.pendingOperations(key);let state=snapshot.state;for(const {_epoch,...operation} of rows)state=FountainCollaboration.applyOperations(state,[operation]);return FountainCollaboration.project(state);},ramFixture.key);
  assert.deepEqual(rebuilt,ramNewer.blocks);

  stage='retired epoch and newer RAM access fence reject old ACKs before any storage commit';
  const retiredFixture=await setup('retired-ram'),retiredOps=await queue(retiredFixture),retiredAck=await canonical(retiredFixture,retiredOps);
  const fenced=await page.evaluate(async({fixture,snapshot,ids})=>{
    const channel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile});await channel.open(fixture.snapshot,{cached:true});
    channel.retiredEpochs.add(snapshot.epoch);
    const retired=await channel.receive(snapshot,'ack',ids);let persisted=await FountainOffline.getSnapshot(fixture.key);
    channel.retiredEpochs.clear();channel.base.access_revision=10;
    const access=await channel.receive(snapshot,'ack',ids);channel.base.access_revision=1;channel.base.epoch='newer-unsaved-epoch';channel.base.page.revision=20;
    const reset=await channel.receive(snapshot,'ack',ids);const rows=await FountainOffline.pendingOperations(fixture.key);persisted=await FountainOffline.getSnapshot(fixture.key);channel.close();return {retired,access,reset,seq:persisted.seq,rows:rows.length};
  },{fixture:retiredFixture,snapshot:retiredAck,ids:retiredOps.map(value=>value.id)});
  assert.deepEqual(fenced.retired,[]);assert.deepEqual(fenced.access,[]);assert.deepEqual(fenced.reset,[]);assert.equal(fenced.seq,0);assert.equal(fenced.rows,2);

  stage='epoch recovery stores a durable recovery draft before deleting old operations';
  const recoveryFixture=await setup('recovery'),recoveryOps=await queue(recoveryFixture);
  const recovery=await page.evaluate(async({fixture,ids})=>{
    const channel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile});await channel.open(fixture.snapshot,{cached:true});
    const state=FountainCollaboration.seedState([{id:'b',text:'REPLACEMENT'}]),snapshot={...fixture.snapshot,epoch:'new-recovery-epoch',seq:0,state,blocks:FountainCollaboration.project(state),page:{...fixture.snapshot.page,revision:10},ack:ids};
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='drafts'&&value.draft?.reason==='epoch_changed')throw new DOMException('Synthetic recovery failure','QuotaExceededError');return original.call(this,value,...args);};
    let failed=false;try{await channel.receive(snapshot,'ack',ids);}catch{failed=true;}finally{IDBObjectStore.prototype.put=original;}
    const before={memory:channel.pending.size,rows:(await FountainOffline.pendingOperations(fixture.key)).length};
    await channel.receive(snapshot,'ack',ids);
    const drafts=await FountainOffline.getDrafts(fixture.key),rows=await FountainOffline.pendingOperations(fixture.key);channel.close();return {failed,before,rows:rows.length,recovered:drafts.filter(record=>record.draft.reason==='epoch_changed').map(record=>record.draft)};
  },{fixture:recoveryFixture,ids:recoveryOps.map(value=>value.id)});
  assert.equal(recovery.failed,true);assert.equal(recovery.before.memory,2);assert.equal(recovery.before.rows,2);assert.equal(recovery.rows,0);assert.ok(recovery.recovered.some(draft=>draft.ops.length===2&&draft.blocks[0].text.includes('XY')));

  stage='read-only recovery retains unproved operations until its recovery draft commits';
  const readonlyFixture=await setup('read-only'),readonlyOps=await queue(readonlyFixture),readonlySnapshot=await canonical(readonlyFixture,readonlyOps.slice(0,1),{access_revision:5,access_level:1,page:{revision:10}});
  const readonly=await page.evaluate(async({fixture,snapshot,ids})=>{
    const channel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile});await channel.open(fixture.snapshot,{cached:true});
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(this.name==='drafts'&&value.draft?.reason==='read_only')throw new DOMException('Synthetic recovery fault','QuotaExceededError');return put.call(this,value,...args);};
    let failed=false;try{await channel.receive(snapshot,'ack',ids);}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
    const before={memory:channel.pending.size,rows:(await FountainOffline.pendingOperations(fixture.key)).length};
    await channel.receive(snapshot,'ack',ids);const drafts=await FountainOffline.getDrafts(fixture.key),rows=await FountainOffline.pendingOperations(fixture.key);channel.close();
    return {failed,before,rows:rows.length,recovered:drafts.filter(record=>record.draft.reason==='read_only').map(record=>record.draft)};
  },{fixture:readonlyFixture,snapshot:readonlySnapshot,ids:readonlyOps.map(value=>value.id)});
  assert.equal(readonly.failed,true);assert.deepEqual(readonly.before,{memory:1,rows:1});assert.equal(readonly.rows,0);assert.ok(readonly.recovered.some(draft=>draft.ops.length===1&&draft.ops[0].id===readonlyOps[1].id));

  stage='snapshot identity, account and revoked resource checks remain transactional';
  const identityFixture=await setup('identity'),identityOps=await queue(identityFixture),identitySnapshot=await canonical(identityFixture,identityOps);
  await assert.rejects(commit(identityFixture,{...identitySnapshot,current_member_id:'another-member'},identityOps.map(value=>value.id)),/identity/);
  assert.equal((await inspect(identityFixture)).pending.length,2);assert.equal((await inspect(identityFixture)).snapshot.seq,0);
  for(const missing of ['workspace_id','current_member_id','session_binding','page.id']){
    const incomplete=structuredClone(identitySnapshot);
    if(missing==='page.id')delete incomplete.page.id;else delete incomplete[missing];
    await assert.rejects(commit(identityFixture,incomplete,identityOps.map(value=>value.id)),/identity/);
    const unchanged=await inspect(identityFixture);assert.equal(unchanged.pending.length,2);assert.equal(unchanged.snapshot.seq,0);
  }
  for(const malformed of [{...identitySnapshot,blocks:null},{...identitySnapshot,page:null},{...identitySnapshot,state:{...identitySnapshot.state,blocks:[]}},{...identitySnapshot,state:{...identitySnapshot.state,seen:[]}}]){
    await assert.rejects(commit(identityFixture,malformed,identityOps.map(value=>value.id)),/Canonical/);
    assert.equal((await inspect(identityFixture)).pending.length,2);assert.equal((await inspect(identityFixture)).snapshot.seq,0);
  }
  const legacyFixture=await setup('unbound-legacy'),legacyOps=await queue(legacyFixture),boundOlder=await canonical(legacyFixture,legacyOps),unboundNewer={...boundOlder,seq:20,page:{revision:20}};
  delete unboundNewer.workspace_id;delete unboundNewer.current_member_id;delete unboundNewer.session_binding;
  await page.evaluate(({key,snapshot})=>FountainOffline.saveSnapshot(key,snapshot),{key:legacyFixture.key,snapshot:unboundNewer});
  await assert.rejects(commit(legacyFixture,boundOlder,legacyOps.map(value=>value.id)),/identity/);
  assert.equal((await inspect(legacyFixture)).pending.length,2);assert.equal((await inspect(legacyFixture)).snapshot.seq,20);
  await page.evaluate(key=>FountainOffline.purgeResource(key),identityFixture.key);
  await assert.rejects(commit(identityFixture,identitySnapshot,identityOps.map(value=>value.id)),/revoked/);
  assert.equal((await inspect(identityFixture)).snapshot,null);

  stage='late closed ACK does not mutate memory or report success after commit';
  const closedFixture=await setup('closed'),closedOps=await queue(closedFixture),closedSnapshot=await canonical(closedFixture,closedOps);
  const closed=await page.evaluate(async({fixture,snapshot,ids})=>{
    const real=FountainOffline;let channel,changes=0;globalThis.FountainOffline={...real,commitOperationsAck:async(...args)=>{const committed=await real.commitOperationsAck(...args);channel.close();return committed;}};
    try{channel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile,onChange:()=>changes++});await channel.open(fixture.snapshot,{cached:true});const before=changes;
      const acknowledged=await channel.receive(snapshot,'ack',ids);return {acknowledged,pending:channel.pending.size,before,changes,stored:(await real.pendingOperations(fixture.key)).length,seq:(await real.getSnapshot(fixture.key)).seq};
    }finally{channel?.close();globalThis.FountainOffline=real;}
  },{fixture:closedFixture,snapshot:closedSnapshot,ids:closedOps.map(value=>value.id)});
  assert.deepEqual(closed.acknowledged,[]);assert.equal(closed.pending,2);assert.equal(closed.before,closed.changes);assert.equal(closed.stored,0);assert.equal(closed.seq,2);

  stage='HTTP ACK arriving after channel close leaves pending rows and cached canonical intact';
  const lateFixture=await setup('late-response'),lateOps=await queue(lateFixture),lateSnapshot=await canonical(lateFixture,lateOps);
  const late=await page.evaluate(async({fixture,snapshot,ids})=>{
    let release,entered;const response=new Promise(resolve=>release=resolve),sent=new Promise(resolve=>entered=resolve);
    const channel=new FountainCollaboration.DocumentChannel({pageId:fixture.snapshot.page.id,profile:fixture.profile,fetcher:async()=>{entered();return response;}});
    await channel.open(fixture.snapshot,{cached:true});fixtureOnline=true;const flushing=channel.flush();await sent;channel.close();release({...snapshot,ack:ids});await flushing;fixtureOnline=false;
    return {rows:(await FountainOffline.pendingOperations(fixture.key)).length,seq:(await FountainOffline.getSnapshot(fixture.key)).seq,pending:channel.pending.size};
  },{fixture:lateFixture,snapshot:lateSnapshot,ids:lateOps.map(value=>value.id)});
  assert.deepEqual(late,{rows:2,seq:0,pending:2});
  const accountFixture=await setup('account-change'),accountOps=await queue(accountFixture),accountSnapshot=await canonical(accountFixture,accountOps);
  await page.evaluate(async()=>FountainOffline.saveProfile({workspaceId:'ack-workspace',memberId:'another-account',session:{authenticated:true,mode:'accounts',cache_binding:'other-binding',expires_at:new Date(Date.now()+3600000).toISOString(),member:{id:'another-account',active:true}},workspace:{pages:[]}}));
  await assert.rejects(commit(accountFixture,accountSnapshot,accountOps.map(value=>value.id)),/profile/);
  assert.equal((await inspect(accountFixture)).snapshot,null);
  console.log('PASS: real IndexedDB atomic rollback, persisted proof selection, stale/RAM/epoch/ACL fences, recovery ordering, identity/revocation and closed-scope ACK isolation');
}catch(error){console.error('FAILED stage:',stage);throw error;}
finally{if(context)await context.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
