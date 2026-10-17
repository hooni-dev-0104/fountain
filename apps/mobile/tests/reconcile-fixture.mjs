/** SQLite-backed coordinator MODEL. It does not implement or prove either OS reconciliation policy. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {SQLiteBridge} from './outbox-fixture.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ReconcileBridge extends SQLiteBridge{
  constructor(file,options){super(file,options);this.plan=null;this.receipts=new Map();this.cancelled=new Set();this.observed=new Map();this.authoritative=options.authoritative;this.handles=[];this.transforms=0;this.reconcileCalls=[];}
  async outboxOpen(args){const result=await super.outboxOpen(args);return{...result,resourceAccess:this.identityState==='verified'?result.resourceAccess:'required',reconciliationHandles:this.identityState==='verified'?this.handles:[]};}
  async stageDelta(args){assert.ok(!this.cancelled.has(args.txId),'settled unaccepted tx may never be staged again');return super.stageDelta(args);}
  async commitDelta(args){assert.ok(!this.cancelled.has(args.txId),'settled unaccepted tx may never commit late');return super.commitDelta(args);}
  async outboxReconcile(args){
    this.assert(args);this.reconcileCalls.push(structuredClone(args));
    assert.ok(!JSON.stringify(args).includes('sourceBody'),'renderer never supplies native source bodies');
    if(args.phase==='settle'){const result={generation:this.generation,state:'settled',lease:this.lease,settlements:args.journals.map(journal=>{const receipt=this.control('receipt:'+journal.txId),row=this.db.prepare('SELECT * FROM receipts WHERE tx=?').get(journal.txId);if(row){assert.equal(journal.digest,row.digest);return{txId:journal.txId,digest:journal.digest,status:'accepted',head:row.head,proofEpoch:receipt.proofEpoch};}const staged=this.control('stage:'+journal.txId);assert.ok(staged,'unknown staging stays unresolved');assert.equal(staged.baseHead,journal.baseHead);assert.equal(staged.proofEpoch,journal.proofEpoch);this.cancelled.add(journal.txId);return{txId:journal.txId,digest:journal.digest,status:'unaccepted'};})};
      if(args.reconciliations!==undefined)result.reconciliations=args.reconciliations.map(caps=>{
        const registry=this.control('reconcile-registry:'+caps.planId);assert.ok(registry,'unknown plan registry must retain the JS journal');assert.equal(registry.profileId,this.profileId,'only the current exact private profile qualifies');assert.deepEqual(registry.caps,caps,'original logical caps never change after restart');
        if(registry.response){const response=registry.response;return{planId:caps.planId,checksum:caps.checksum,status:'accepted',head:response.head,proofEpoch:response.proofEpoch,receipt:response.receipt};}
        registry.fenced=true;this.putControl('reconcile-registry:'+caps.planId,registry);if(this.plan?.planId===caps.planId)this.plan=null;return{planId:caps.planId,checksum:caps.checksum,status:'unaccepted'};
      });return result;
    }
    if(args.phase==='cancel'){if(this.plan?.planId===args.planId)this.plan=null;return{generation:this.generation,state:'cancelled',planId:args.planId};}
    if(args.phase==='commit'){
      const prior=this.receipts.get(args.planId);if(prior){assert.deepEqual(prior.input,args);if(this.loseReplay){this.loseReplay--;throw Error('Injected lost MODEL immutable receipt callback');}return prior.response;}
      const plan=this.plan;assert.ok(plan&&plan.planId===args.planId);assert.ok(!this.control('reconcile-registry:'+args.planId)?.fenced);assert.equal(args.checksum,plan.ready.checksum);assert.equal(args.baseHead,this.head);assert.equal(args.proofEpoch,this.proofEpoch);assert.equal(args.confirm,plan.ready.requiresConfirmation);
      if(this.failReconcile)throw Error('Injected failure before MODEL SQL COMMIT');
      const profile=this.authoritative.profile,source=this.head;let response;
      this.db.exec('BEGIN IMMEDIATE');try{
        const put=(bucket,key,value)=>this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(bucket,JSON.stringify(key),JSON.stringify(value));
        put('profiles',profile.id,profile);put('meta','active',{id:'active',profileId:profile.id});put('meta','last-profile',{id:'last-profile',profileId:profile.id});
        for(const [route,value]of this.observed){if(!route.includes('/collaboration'))continue;const key=profile.id+'|'+encodeURIComponent(value.page.id);put('snapshots',key,{key,profileId:profile.id,snapshot:value,updatedAt:Date.now()});for(const row of this.records().filter(row=>row.bucket==='operations')){const record=JSON.parse(row.value);if(record.operation._epoch===value.epoch&&value.state.seen[record.id])this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(row.bucket,row.key);}}
        this.db.prepare("UPDATE control SET value=? WHERE id='head'").run(source+1);response={generation:this.generation,state:'committed',planId:plan.planId,lease:this.lease,head:this.head,proofEpoch:this.proofEpoch,checksum:args.checksum,receipt:{version:1,planId:plan.planId,checksum:args.checksum,sourceHead:source,targetHead:this.head,mode:plan.mode,counts:plan.ready.counts}};const registry=this.control('reconcile-registry:'+plan.planId);this.putControl('reconcile-registry:'+plan.planId,{...registry,response});this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      this.transforms++;this.receipts.set(plan.planId,{input:structuredClone(args),response});this.plan=null;
      if(this.loseReconcile){this.loseReconcile--;throw Error('Injected lost MODEL SQL COMMIT callback');}return response;
    }
    assert.equal(args.phase,'prepare');
    if(!args.planId){assert.equal(args.baseHead,this.head);assert.equal(args.proofEpoch,this.proofEpoch);assert.ok(['current','upgrade','promote'].includes(args.mode));if(args.mode==='current')assert.equal(args.handles,undefined);else assert.ok(args.handles.length&&args.handles.every(handle=>this.handles.some(item=>item.handle===handle)));this.plan={planId:randomUUID(),mode:args.mode,page:0};this.observed.clear();}
    const plan=this.plan;assert.ok(plan);if(args.planId)assert.equal(args.planId,plan.planId);
    const descriptors=[[{kind:'workspace',id:'workspace'}],[{kind:'page',id:this.authoritative.page.page.id},{kind:'attachment',id:'가족🙂 file'}]];
    if(plan.page<descriptors.length)return{generation:this.generation,state:'collecting',planId:plan.planId,lease:this.lease,expiresAt:Date.now()+90000,sweep:1,needed:descriptors[plan.page++]};
    const counts={refresh:4,keep:0,acknowledge:0,quarantine:this.quarantineCount||0,import:plan.mode==='current'?0:1},reasons=this.badReasons?['untrusted_resource_name']:this.quarantineCount?['epoch_changed']:[];
    plan.ready={generation:this.generation,state:'ready',planId:plan.planId,lease:this.lease,baseHead:this.head,proofEpoch:this.proofEpoch,expiresAt:Date.now()+90000,checksum:hash([plan.planId,this.head,counts]),counts,reasons,requiresConfirmation:plan.mode!=='current'||counts.quarantine>0};this.putControl('reconcile-registry:'+plan.planId,{profileId:this.profileId,caps:{planId:plan.planId,checksum:plan.ready.checksum,lease:this.lease,baseHead:this.head,proofEpoch:this.proofEpoch}});return plan.ready;
  }
}
