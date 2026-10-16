/** SQL-backed native proof/gate model only; no OS key storage, SDK or device evidence. */
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const paths={profiles:'id',meta:'id',snapshots:'key',databaseSnapshots:'key',localPages:'key',transfers:'key',operations:['key','id'],drafts:['key','clientId'],mutations:['profileId','id']};
const integer=value=>Number.isSafeInteger(value)&&value>=0,id=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const denied=()=>Object.assign(new Error('Current resource access proof required'),{code:'OUTBOX_ACCESS_REQUIRED'});
export class SQLiteBridge {
  constructor(file,{origin,profileId,generation=1}){
    this.origin=origin;this.generation=generation;this.lease=randomUUID();this.profileId=profileId;this.identityState=profileId?'verified':'unknown';this.validUntil=Date.now()+3600000;this.calls=[];this.failStage=false;this.failCommit=false;this.loseReceipt=false;this.holdCommit=false;this.cursors=new Map();
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; CREATE TABLE IF NOT EXISTS control(id TEXT PRIMARY KEY,value INTEGER); INSERT OR IGNORE INTO control VALUES (\'head\',0); INSERT OR IGNORE INTO control VALUES (\'proofEpoch\',0); CREATE TABLE IF NOT EXISTS records(bucket TEXT,key TEXT,value TEXT,PRIMARY KEY(bucket,key)); CREATE TABLE IF NOT EXISTS recovery(bucket TEXT,key TEXT,value TEXT,PRIMARY KEY(bucket,key)); CREATE TABLE IF NOT EXISTS stages(tx TEXT,base INTEGER,part INTEGER,bytes BLOB,PRIMARY KEY(tx,part)); CREATE TABLE IF NOT EXISTS receipts(tx TEXT PRIMARY KEY,digest TEXT,head INTEGER); CREATE TABLE IF NOT EXISTS tombstones(kind TEXT,key TEXT,PRIMARY KEY(kind,key));');
  }
  get head(){return this.db.prepare('SELECT value FROM control WHERE id=\'head\'').get().value;}
  get proofEpoch(){return this.db.prepare('SELECT value FROM control WHERE id=\'proofEpoch\'').get().value;}
  control(key){const row=this.db.prepare('SELECT value FROM control WHERE id=?').get(key);return row?JSON.parse(row.value):null;}
  putControl(key,value){this.db.prepare('INSERT INTO control VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  get proofs(){return this.control('proofs')||{};}
  boundary(){return {generation:this.generation,lease:this.lease,profileId:this.profileId,proofEpoch:this.proofEpoch};}
  identity(){const parts=this.profileId?.split('|')||[];return{workspace_id:decodeURIComponent(parts[1]||''),current_member_id:decodeURIComponent(parts[2]||''),session_binding:decodeURIComponent(parts[3]||'')};}
  envelope(value){const expected=this.identity();return Object.entries(expected).every(([key,want])=>value?.[key]===want)&&integer(value.access_revision)&&integer(value.data_revision);}
  writeObservation(proofs,floors,{deniedKey=null,invalidating=false}={}){
    let overflow=Buffer.byteLength(JSON.stringify({proofs,floors}))>(this.ledgerLimit||16*1024*1024);
    if(overflow){
      const previous=this.proofs;for(const [key,value]of Object.entries(proofs))if(canonical(value)!==canonical(previous[key]))previous[key]={kind:value.kind,id:value.id,profileId:this.profileId,invalid:true};proofs=previous;
      if(Buffer.byteLength(JSON.stringify({proofs,floors}))>(this.ledgerLimit||16*1024*1024))proofs={'workspace:workspace':{kind:'workspace',id:'workspace',profileId:this.profileId,invalid:true}};
    }
    this.db.exec('BEGIN IMMEDIATE');try{
      this.putControl('proofs',proofs);this.putControl('revisionFloors',floors);
      if(deniedKey){this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run('resource',deniedKey);for(const row of this.db.prepare('SELECT * FROM records ORDER BY bucket,key').iterate()){const record=JSON.parse(row.value);if(record.key===deniedKey||record.resourceKey===deniedKey||record.scopeId===deniedKey){if(['operations','drafts','mutations'].includes(row.bucket))this.db.prepare('INSERT INTO recovery VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(row.bucket,row.key,row.value);this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(row.bucket,row.key);}}}
      if(this.failObservation){this.failObservation=false;throw Error('Fixture proof ledger rollback');}this.db.prepare('UPDATE control SET value=value+1 WHERE id=\'proofEpoch\'').run();this.db.exec('COMMIT');this.cursors.clear();
    }catch(error){this.db.exec('ROLLBACK');throw error;}if(overflow||invalidating)throw denied();
  }
  /** Test-only simulation of the native HTTPS response observer; never a bridge method. */
  observeCanonical(path,value,{status=200,boundary=this.boundary(),now=Date.now()}={}){
    assert.deepEqual(boundary,this.boundary(),'late observation cannot reinstall proof');assert.equal(this.identityState,'verified');assert.ok(this.validUntil>now);
    let kind,resourceId;if(path==='/api/workspace'){kind='workspace';resourceId='workspace';}else{const match=path.match(/^\/api\/(databases|pages)\/([^/?]+)(\/collaboration)?$/);assert.ok(match&&!path.includes('?'));assert.ok(match[1]==='pages'?match[3]==='/collaboration':!match[3]);kind=match[1]==='pages'?'page':'database';resourceId=decodeURIComponent(match[2]);assert.ok(id(resourceId));}
    const proofs=this.proofs,key=kind+':'+resourceId,floors=this.control('revisionFloors')||{},floor=floors[this.profileId]||{accessRevision:0,dataRevision:0},prior=proofs[key]?.profileId===this.profileId?proofs[key]:null,resourceKey=this.profileId+'|'+(kind==='database'?'database|':'')+encodeURIComponent(resourceId);
    if([403,404].includes(status)){proofs[key]={kind,id:resourceId,denied:true,profileId:this.profileId};return this.writeObservation(proofs,floors,{deniedKey:kind==='workspace'?null:resourceKey});}
    assert.equal(status,200);if(prior?.denied||this.db.prepare('SELECT 1 FROM tombstones WHERE kind=? AND key=?').get('resource',resourceKey))throw denied();
    // A valid but late revision is not malformed evidence and cannot change the ledger.
    if(this.envelope(value))assert.ok(value.access_revision>=floor.accessRevision&&value.data_revision>=floor.dataRevision,'canonical response below private revision floor');
    let proof;
    try{
      assert.ok(this.envelope(value),'canonical identity and revisions required');proof={kind,id:resourceId,profileId:this.profileId,accessRevision:value.access_revision,dataRevision:value.data_revision,observedAt:now,validUntil:Math.min(this.validUntil,now+86400000),accessLevel:0,epoch:null,seq:null,locked:false,archived:false};
      const listed=values=>{assert.ok(Array.isArray(values));const result={};for(const item of values){assert.ok(id(item.id)&&Number.isSafeInteger(item.access_level)&&item.access_level>=1&&item.access_level<=4&&!Object.hasOwn(result,item.id));result[item.id]={accessLevel:item.access_level,locked:item.locked===true,archived:item.archived===true};}return result;};
      if(kind==='workspace'){proof.pages=listed(value.pages);proof.databases=listed(value.databases);}
      else{const resource=kind==='page'?value.page:value.database;assert.equal(resource?.id,resourceId);assert.ok(Number.isSafeInteger(resource.access_level)&&resource.access_level>=1&&resource.access_level<=4);proof.accessLevel=resource.access_level;proof.locked=resource.locked===true;proof.archived=resource.archived===true;
        if(kind==='page'){assert.ok(id(value.epoch)&&integer(value.seq)&&value.access_level===resource.access_level);proof.epoch=value.epoch;proof.seq=value.seq;}
        else{proof.rows=listed(value.rows);assert.equal(typeof resource.can_create_row,'boolean');proof.canCreateRow=resource.can_create_row;proof.properties=resource.properties||[];}
      }
    }catch{proofs[key]={kind,id:resourceId,profileId:this.profileId,invalid:true};return this.writeObservation(proofs,floors,{invalidating:true});}
    const semantic=entry=>Object.fromEntries(Object.entries(entry).filter(([field])=>!['observedAt','validUntil'].includes(field)));if(prior&&!prior.denied&&!prior.invalid&&prior.validUntil>now&&this.validUntil>=prior.validUntil&&canonical(semantic(prior))===canonical(semantic(proof)))return false;
    proofs[key]=proof;floors[this.profileId]={accessRevision:Math.max(floor.accessRevision,value.access_revision),dataRevision:Math.max(floor.dataRevision,value.data_revision)};return this.writeObservation(proofs,floors);
  }
  issues(rows=null){
    if(this.identityState!=='verified')return[];const issues=[],proofs=this.proofs,floor=(this.control('revisionFloors')||{})[this.profileId]||{accessRevision:0,dataRevision:0},seen=new Set(),now=Date.now()+(this.proofClockOffset||0);
    const issue=(kind,resourceId,reason)=>{if(issues.length>=101)return;const key=JSON.stringify([kind,resourceId,reason]);if(!seen.has(key)){seen.add(key);issues.push({kind,id:resourceId,reason});}};
    const proof=(kind,resourceId,edit=false)=>{const value=proofs[kind+':'+resourceId],resourceKey=this.profileId+'|'+(kind==='database'?'database|':'')+encodeURIComponent(resourceId);if(this.db.prepare('SELECT 1 FROM tombstones WHERE kind=? AND key=?').get('resource',resourceKey)||value?.denied){issue(kind,resourceId,'denied');return null;}if(!value||value.invalid||value.profileId!==this.profileId){issue(kind,resourceId,'missing');return null;}if(value.validUntil<=now||this.validUntil<=now){issue(kind,resourceId,'expired');return null;}if(value.accessRevision<floor.accessRevision||value.dataRevision<floor.dataRevision){issue(kind,resourceId,'revision_changed');return null;}if(kind!=='workspace'&&(value.accessLevel<(edit?3:1)||edit&&(value.locked||value.archived))){issue(kind,resourceId,'denied');return null;}return value;};
    const revision=(value,evidence,kind,resourceId)=>{if(evidence&&(!this.envelope(value)||value.access_revision!==evidence.accessRevision||value.data_revision!==evidence.dataRevision)){issue(kind,resourceId,'revision_changed');return false;}return !!evidence;};
    const page=(pageId,edit=false)=>proof('page',pageId,edit);
    for(const value of Object.values(proofs))if(value.profileId===this.profileId&&value.denied)issue(value.kind,value.id,'denied');
    for(const row of rows||this.db.prepare('SELECT bucket,key,value FROM records ORDER BY bucket,key').iterate()){if(issues.length>=101)break;const value=JSON.parse(row.value);if(row.bucket==='meta')continue;
      if(row.bucket==='profiles'){
        const workspace=value.workspace,evidence=proof('workspace','workspace');if(!revision(workspace,evidence,'workspace','workspace'))continue;
        for(const [name,kind]of[['pages','page'],['databases','database']])for(const resource of workspace[name]||[]){const current=evidence[name]?.[resource.id];if(proofs[kind+':'+resource.id]?.invalid)issue(kind,resource.id,'missing');if(proofs[kind+':'+resource.id]?.denied||this.db.prepare('SELECT 1 FROM tombstones WHERE kind=? AND key=?').get('resource',this.profileId+'|'+(kind==='database'?'database|':'')+encodeURIComponent(resource.id)))issue(kind,resource.id,'denied');if(!current||current.accessLevel!==resource.access_level||current.locked!==(resource.locked===true)||current.archived!==(resource.archived===true))issue(kind,resource.id,'revision_changed');}
        continue;
      }
      const resourceKey=value.resourceKey||value.scopeId||value.key;if(typeof resourceKey!=='string'||!resourceKey.startsWith(this.profileId+'|')){issue('workspace','workspace','denied');continue;}
      const parts=resourceKey.slice(this.profileId.length+1).split('|'),kind=parts[0]==='database'?'database':'page',resourceId=decodeURIComponent(parts[kind==='database'?1:0]);
      if(row.bucket==='localPages'){issue('page',resourceId,'local_dependency');continue;}
      if(row.bucket==='databaseSnapshots'){
        const evidence=proof('database',resourceId),snapshot=value.snapshot;if(!revision(snapshot,evidence,'database',resourceId))continue;
        for(const cached of snapshot.rows||[])if(!evidence.rows[cached.id]||evidence.rows[cached.id].accessLevel!==cached.access_level)issue('database',resourceId,'revision_changed');continue;
      }
      if(row.bucket==='mutations'){
        const operation=value.operation;if(operation.kind==='page.create'){issue('page',operation.target_id,'local_dependency');continue;}
        if(kind==='page'){page(resourceId,true);continue;}const evidence=proof('database',resourceId,true);if(!evidence)continue;
        if(operation.kind==='row.create'&&!evidence.canCreateRow||operation.kind!=='row.create'&&evidence.rows[operation.target_id]?.accessLevel<3||operation.kind!=='row.create'&&!evidence.rows[operation.target_id])issue('database',resourceId,'denied');
        const reference=(rowId,target=resourceId)=>{if(!rowId)return;const candidates=target?[proofs['database:'+target]]:Object.values(proofs).filter(value=>value.kind==='database');if(!candidates.some(candidate=>candidate&&candidate.profileId===this.profileId&&!candidate.denied&&!candidate.invalid&&!this.db.prepare('SELECT 1 FROM tombstones WHERE kind=? AND key=?').get('resource',this.profileId+'|database|'+encodeURIComponent(candidate.id))&&candidate.validUntil>now&&candidate.accessRevision>=floor.accessRevision&&candidate.dataRevision>=floor.dataRevision&&candidate.rows?.[rowId]?.accessLevel>=1))issue('database',resourceId,'revision_changed');};
        const fields=value=>{if(!value)return;reference(value.parent_row_id);for(const rowId of value.depends_on||[])reference(rowId);};
        const properties=value=>{for(const property of evidence.properties)if(property.type==='relation')for(const rowId of value?.[property.id]||[])reference(rowId,property.database_id||null);};
        fields(operation.body);properties(operation.body?.properties);fields(operation.base);fields(operation.base?.fields);properties(operation.base?.properties);
        for(const [rowId,base]of Object.entries(operation.base_rows||{})){reference(rowId);fields(base);fields(base?.fields);properties(base?.properties);}continue;
      }
      const evidence=page(resourceId,!['snapshots'].includes(row.bucket));if(!evidence)continue;
      if(row.bucket==='snapshots'){if(!revision(value.snapshot,evidence,'page',resourceId))continue;if(value.snapshot.page?.id!==resourceId||value.snapshot.access_level!==evidence.accessLevel)issue('page',resourceId,'revision_changed');if(value.snapshot.epoch!==evidence.epoch||value.snapshot.seq!==evidence.seq)issue('page',resourceId,'epoch_changed');}
      if(row.bucket==='drafts'&&value.draft?.reason==='basis'){const snapshot=this.db.prepare("SELECT 1 FROM records WHERE bucket='snapshots' AND key=?").get(JSON.stringify(resourceKey));if(!snapshot)issue('page',resourceId,'missing');else if(value.draft.epoch!==evidence.epoch||value.draft.seq!==evidence.seq)issue('page',resourceId,'epoch_changed');}
      if(row.bucket==='operations'&&value.operation?._epoch!==evidence.epoch||row.bucket==='drafts'&&value.draft?.epoch&&value.draft.epoch!==evidence.epoch||row.bucket==='transfers'&&value.publication&&value.publication.epoch!==evidence.epoch)issue('page',resourceId,'epoch_changed');
    }return issues;
  }
  assert(args){assert.equal(args.generation,this.generation);if(args.lease!==undefined)assert.equal(args.lease,this.lease);}
  async outboxOpen(args){this.assert(args);this.calls.push('open');const issues=this.issues();return{generation:this.generation,lease:this.lease,head:this.head,proofEpoch:this.proofEpoch,resourceAccess:issues.length?'required':'ready',accessIssues:issues.slice(0,100),accessIssuesTruncated:issues.length>100,identityState:this.identityState,profileId:this.identityState==='verified'?this.profileId:null,validUntil:this.validUntil};}
  async stageDelta(args){
    this.assert(args);this.calls.push('stage');if(!integer(args.proofEpoch))throw denied();if(this.failStage){this.failStage=false;throw new Error('Fixture stage failure');}const receipt=this.control('receipt:'+args.txId);if(receipt){assert.equal(receipt.profileId,this.profileId);if(receipt.mode==='active')assert.equal(this.identityState,'verified');return{generation:this.generation,part:args.part};}
    const bytes=Buffer.from(args.bytesBase64,'base64');assert.ok(bytes.length<=256*1024);const prior=this.control('stage:'+args.txId);if(prior)assert.deepEqual(prior,{lease:this.lease,baseHead:args.baseHead,proofEpoch:args.proofEpoch});else this.putControl('stage:'+args.txId,{lease:this.lease,baseHead:args.baseHead,proofEpoch:args.proofEpoch});const old=this.db.prepare('SELECT * FROM stages WHERE tx=? AND part=?').get(args.txId,args.part);if(old){assert.equal(old.base,args.baseHead);assert.ok(Buffer.from(old.bytes).equals(bytes));}else{const previous=this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(bytes)),0) AS size FROM stages WHERE tx=?').get(args.txId);assert.equal(args.part,previous.count);assert.ok(previous.size+bytes.length<=64*1024*1024);this.db.prepare('INSERT INTO stages VALUES (?,?,?,?)').run(args.txId,args.baseHead,args.part,bytes);}return{generation:this.generation,part:args.part};
  }
  async commitDelta(args){
    this.assert(args);this.calls.push('commit');const receipt=this.db.prepare('SELECT * FROM receipts WHERE tx=?').get(args.txId);if(receipt){assert.equal(receipt.digest,args.digest);const original=this.control('receipt:'+args.txId);assert.equal(original.profileId,this.profileId);if(original.mode==='active')assert.equal(this.identityState,'verified');return{generation:this.generation,head:receipt.head,txId:args.txId,proofEpoch:original.proofEpoch};}
    assert.equal(args.baseHead,this.head);assert.deepEqual(this.control('stage:'+args.txId),{lease:this.lease,baseHead:args.baseHead,proofEpoch:args.proofEpoch});const parts=this.db.prepare('SELECT * FROM stages WHERE tx=? ORDER BY part').all(args.txId);assert.ok(parts.length);const bytes=Buffer.concat(parts.map(row=>Buffer.from(row.bytes)));assert.equal(createHash('sha256').update(bytes).digest('hex'),args.digest);const delta=JSON.parse(bytes.toString('utf8'));assert.equal(delta.origin,this.origin);assert.equal(delta.version,1);assert.ok(['active','quarantine'].includes(delta.mode));if(delta.mode==='active')assert.equal(this.identityState,'verified');
    this.db.exec('BEGIN IMMEDIATE');let head;
    try{
      const table=delta.mode==='active'?'records':'recovery';
      for(const change of delta.changes){assert.ok(Object.hasOwn(paths,change.bucket));assert.ok(['put','delete'].includes(change.op));if(change.op==='put'){const keyPath=paths[change.bucket],actual=Array.isArray(keyPath)?keyPath.map(key=>change.value[key]):change.value[keyPath];assert.equal(JSON.stringify(actual),JSON.stringify(change.key));assert.ok(Buffer.byteLength(JSON.stringify(change.value))<=16*1024*1024);if(delta.mode==='active'){if(change.bucket==='profiles'){assert.equal(change.value.id,this.profileId);assert.ok(Number.isFinite(change.value.validUntil)&&change.value.validUntil<=this.validUntil);}else if(change.bucket==='meta'&&change.value.id==='active')assert.equal(change.value.profileId,this.profileId);else if(change.bucket!=='meta')assert.equal(change.value.profileId,this.profileId);}this.db.prepare('INSERT INTO '+table+' VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(change.bucket,JSON.stringify(change.key),JSON.stringify(change.value));}else this.db.prepare('DELETE FROM '+table+' WHERE bucket=? AND key=?').run(change.bucket,JSON.stringify(change.key));}
      let revokeProfile=false;
      if(delta.mode==='active')for(const change of delta.changes)if(change.op==='put'&&change.bucket==='meta'&&/^revoked(?:-resource)?:/.test(change.value.id)){
        const whole=change.value.id.startsWith('revoked:'),scope=change.value.id.slice(whole?'revoked:'.length:'revoked-resource:'.length);this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run(whole?'profile':'resource',scope);
        for(const row of this.db.prepare('SELECT * FROM records ORDER BY bucket,key').iterate()){if(row.bucket==='meta')continue;const value=JSON.parse(row.value),matches=whole?(value.profileId===scope||value.id===scope):(value.key===scope||value.resourceKey===scope||value.scopeId===scope||row.bucket==='transfers'&&typeof value.key==='string'&&value.key.startsWith(scope+'|'));if(matches){if(!whole&&['operations','drafts','mutations'].includes(row.bucket))this.db.prepare('INSERT INTO recovery VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(row.bucket,row.key,row.value);this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(row.bucket,row.key);}}
        if(whole)for(const row of this.db.prepare('SELECT * FROM recovery ORDER BY bucket,key').iterate()){const value=JSON.parse(row.value);if(value.profileId===scope||value.id===scope)this.db.prepare('DELETE FROM recovery WHERE bucket=? AND key=?').run(row.bucket,row.key);}
        if(whole&&scope===this.profileId){this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run('meta',JSON.stringify('active'));revokeProfile=true;}
      }
      const cleanup=delta.changes.every(change=>change.op==='delete'||change.bucket==='meta'&&/^revoked(?:-resource)?:/.test(change.value?.id));
      if(delta.mode==='active'&&!cleanup&&(args.proofEpoch!==this.proofEpoch||this.issues().length))throw denied();
      if(this.failCommit){this.failCommit=false;throw new Error('Fixture rollback before COMMIT');}head=this.head+1;this.db.prepare('UPDATE control SET value=? WHERE id=\'head\'').run(head);this.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(args.txId,args.digest,head);this.putControl('receipt:'+args.txId,{proofEpoch:args.proofEpoch,profileId:this.profileId,mode:delta.mode});this.db.prepare('DELETE FROM stages WHERE tx=?').run(args.txId);this.db.exec('COMMIT');if(revokeProfile)this.identityState='blocked';
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(this.loseReceipt){this.loseReceipt=false;throw new Error('Fixture callback lost after SQL COMMIT');}
    if(this.holdCommit){this.holdCommit=false;this.held=true;await new Promise(resolve=>this.release=resolve);this.held=false;}
    return{generation:this.generation,head,txId:args.txId,proofEpoch:args.proofEpoch};
  }
  async readPage(args){
    this.assert(args);this.calls.push('read');assert.equal(this.identityState,'verified');if(args.proofEpoch!==this.proofEpoch||this.issues().length)throw denied();assert.equal(args.head,this.head);assert.ok(args.byteLimit<=256*1024);
    let position=args.cursor?this.cursors.get(args.cursor):{bucket:'',key:'',offset:0,lease:this.lease,head:this.head,proofEpoch:this.proofEpoch};if(!position||position.lease!==this.lease||position.head!==this.head||position.proofEpoch!==this.proofEpoch)throw denied();
    const following=this.db.prepare('SELECT * FROM records WHERE bucket>? OR (bucket=? AND key>?) ORDER BY bucket,key LIMIT 1'),same=this.db.prepare('SELECT * FROM records WHERE bucket=? AND key=?'),fragments=[];let budget=args.byteLimit;
    while(budget>0){const row=position.offset?same.get(position.bucket,position.key):following.get(position.bucket,position.bucket,position.key);if(!row)break;const bytes=Buffer.from(row.value),length=Math.min(budget,bytes.length-position.offset);assert.ok(bytes.length<=16*1024*1024);fragments.push({bucket:row.bucket,key:JSON.parse(row.key),offset:position.offset,total:bytes.length,bytesBase64:bytes.subarray(position.offset,position.offset+length).toString('base64')});budget-=length;position={...position,bucket:row.bucket,key:row.key,offset:position.offset+length};if(position.offset===bytes.length)position={...position,offset:0};}
    const hasMore=position.offset||this.db.prepare('SELECT 1 FROM records WHERE bucket>? OR (bucket=? AND key>?) LIMIT 1').get(position.bucket,position.bucket,position.key);let next=null;if(hasMore){next=randomUUID();this.cursors.set(next,position);}const reply={generation:this.generation,head:this.head,proofEpoch:this.proofEpoch,fragments,next};
    if(this.holdRead){this.holdRead=false;this.readHeld=true;await new Promise(resolve=>this.releaseRead=resolve);this.readHeld=false;}if(args.proofEpoch!==this.proofEpoch||this.issues().length)throw denied();return reply;
  }
  rotateOwner(){this.lease=randomUUID();this.db.exec("DELETE FROM stages; DELETE FROM control WHERE id LIKE 'stage:%'");}
  records(table='records'){assert.ok(['records','recovery','receipts'].includes(table));return this.db.prepare('SELECT * FROM '+table).all();}
  close(){this.db.close();}
}
