/** SQL-backed bridge fixture only: it does not model OS key storage or prove a device runtime. */
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const paths={profiles:'id',meta:'id',snapshots:'key',databaseSnapshots:'key',localPages:'key',transfers:'key',operations:['key','id'],drafts:['key','clientId'],mutations:['profileId','id']};
export class SQLiteBridge {
  constructor(file,{origin,profileId,generation=1}){
    this.origin=origin;this.generation=generation;this.lease=randomUUID();this.profileId=profileId;this.identityState=profileId?'verified':'unknown';this.validUntil=Date.now()+3600000;this.calls=[];this.failStage=false;this.failCommit=false;this.loseReceipt=false;this.holdCommit=false;this.cursors=new Map();
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; CREATE TABLE IF NOT EXISTS control(id TEXT PRIMARY KEY,value INTEGER); INSERT OR IGNORE INTO control VALUES (\'head\',0); CREATE TABLE IF NOT EXISTS records(bucket TEXT,key TEXT,value TEXT,PRIMARY KEY(bucket,key)); CREATE TABLE IF NOT EXISTS recovery(bucket TEXT,key TEXT,value TEXT,PRIMARY KEY(bucket,key)); CREATE TABLE IF NOT EXISTS stages(tx TEXT,base INTEGER,part INTEGER,bytes BLOB,PRIMARY KEY(tx,part)); CREATE TABLE IF NOT EXISTS receipts(tx TEXT PRIMARY KEY,digest TEXT,head INTEGER); CREATE TABLE IF NOT EXISTS tombstones(kind TEXT,key TEXT,PRIMARY KEY(kind,key));');
  }
  get head(){return this.db.prepare('SELECT value FROM control WHERE id=\'head\'').get().value;}
  assert(args){assert.equal(args.generation,this.generation);if(args.lease!==undefined)assert.equal(args.lease,this.lease);}
  async outboxOpen(args){this.assert(args);this.calls.push('open');return{generation:this.generation,lease:this.lease,head:this.head,identityState:this.identityState,profileId:this.identityState==='verified'?this.profileId:null,validUntil:this.validUntil};}
  async stageDelta(args){this.assert(args);this.calls.push('stage');if(this.failStage){this.failStage=false;throw new Error('Fixture stage failure');}const bytes=Buffer.from(args.bytesBase64,'base64');assert.ok(bytes.length<=256*1024);const old=this.db.prepare('SELECT * FROM stages WHERE tx=? AND part=?').get(args.txId,args.part);if(old){assert.equal(old.base,args.baseHead);assert.ok(Buffer.from(old.bytes).equals(bytes));}else{const previous=this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(bytes)),0) AS size FROM stages WHERE tx=?').get(args.txId);assert.equal(args.part,previous.count);assert.ok(previous.size+bytes.length<=64*1024*1024);this.db.prepare('INSERT INTO stages VALUES (?,?,?,?)').run(args.txId,args.baseHead,args.part,bytes);}return{generation:this.generation,part:args.part};}
  async commitDelta(args){
    this.assert(args);this.calls.push('commit');const receipt=this.db.prepare('SELECT * FROM receipts WHERE tx=?').get(args.txId);if(receipt){assert.equal(receipt.digest,args.digest);return{generation:this.generation,head:receipt.head,txId:args.txId};}
    assert.equal(args.baseHead,this.head);const parts=this.db.prepare('SELECT * FROM stages WHERE tx=? ORDER BY part').all(args.txId);assert.ok(parts.length);const bytes=Buffer.concat(parts.map(row=>Buffer.from(row.bytes)));assert.equal(createHash('sha256').update(bytes).digest('hex'),args.digest);const delta=JSON.parse(bytes.toString('utf8'));assert.equal(delta.origin,this.origin);assert.equal(delta.version,1);assert.ok(['active','quarantine'].includes(delta.mode));if(delta.mode==='active')assert.equal(this.identityState,'verified');
    this.db.exec('BEGIN IMMEDIATE');let head;
    try{
      const table=delta.mode==='active'?'records':'recovery';
      for(const change of delta.changes){assert.ok(Object.hasOwn(paths,change.bucket));assert.ok(['put','delete'].includes(change.op));if(change.op==='put'){const keyPath=paths[change.bucket],actual=Array.isArray(keyPath)?keyPath.map(key=>change.value[key]):change.value[keyPath];assert.equal(JSON.stringify(actual),JSON.stringify(change.key));assert.ok(Buffer.byteLength(JSON.stringify(change.value))<=16*1024*1024);if(delta.mode==='active'){if(change.bucket==='profiles'){assert.equal(change.value.id,this.profileId);assert.ok(Number.isFinite(change.value.validUntil)&&change.value.validUntil<=this.validUntil);}else if(change.bucket==='meta'&&change.value.id==='active')assert.equal(change.value.profileId,this.profileId);else if(change.bucket!=='meta')assert.equal(change.value.profileId,this.profileId);}this.db.prepare('INSERT INTO '+table+' VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(change.bucket,JSON.stringify(change.key),JSON.stringify(change.value));}else this.db.prepare('DELETE FROM '+table+' WHERE bucket=? AND key=?').run(change.bucket,JSON.stringify(change.key));}
      let revokeProfile=false;
      if(delta.mode==='active')for(const change of delta.changes)if(change.op==='put'&&change.bucket==='meta'&&/^revoked(?:-resource)?:/.test(change.value.id)){
        const whole=change.value.id.startsWith('revoked:'),scope=change.value.id.slice(whole?'revoked:'.length:'revoked-resource:'.length);this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run(whole?'profile':'resource',scope);
        for(const row of this.db.prepare('SELECT * FROM records').all()){if(row.bucket==='meta')continue;const value=JSON.parse(row.value),matches=whole?(value.profileId===scope||value.id===scope):(value.key===scope||value.resourceKey===scope||value.scopeId===scope||row.bucket==='transfers'&&typeof value.key==='string'&&value.key.startsWith(scope+'|'));if(matches)this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(row.bucket,row.key);}
        if(whole&&scope===this.profileId){this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run('meta',JSON.stringify('active'));revokeProfile=true;}
      }
      if(this.failCommit){this.failCommit=false;throw new Error('Fixture rollback before COMMIT');}head=this.head+1;this.db.prepare('UPDATE control SET value=? WHERE id=\'head\'').run(head);this.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(args.txId,args.digest,head);this.db.prepare('DELETE FROM stages WHERE tx=?').run(args.txId);this.db.exec('COMMIT');if(revokeProfile)this.identityState='blocked';
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(this.loseReceipt){this.loseReceipt=false;throw new Error('Fixture callback lost after SQL COMMIT');}
    if(this.holdCommit){this.holdCommit=false;this.held=true;await new Promise(resolve=>this.release=resolve);this.held=false;}
    return{generation:this.generation,head,txId:args.txId};
  }
  async readPage(args){this.assert(args);this.calls.push('read');assert.equal(this.identityState,'verified');assert.equal(args.head,this.head);assert.ok(args.byteLimit<=256*1024);let position=args.cursor?this.cursors.get(args.cursor):{index:0,offset:0,lease:this.lease,head:this.head};assert.ok(position&&position.lease===this.lease&&position.head===this.head);const rows=this.db.prepare('SELECT * FROM records ORDER BY bucket,key').all(),fragments=[];let budget=args.byteLimit;
    while(position.index<rows.length&&budget>0){const row=rows[position.index],bytes=Buffer.from(row.value),length=Math.min(budget,bytes.length-position.offset);fragments.push({bucket:row.bucket,key:JSON.parse(row.key),offset:position.offset,total:bytes.length,bytesBase64:bytes.subarray(position.offset,position.offset+length).toString('base64')});budget-=length;position={...position,offset:position.offset+length};if(position.offset===bytes.length)position={...position,index:position.index+1,offset:0};}
    let next=null;if(position.index<rows.length){next=randomUUID();this.cursors.set(next,position);}return{generation:this.generation,head:this.head,fragments,next};
  }
  rotateOwner(){this.lease=randomUUID();}
  records(table='records'){assert.ok(['records','recovery','receipts'].includes(table));return this.db.prepare('SELECT * FROM '+table).all();}
  close(){this.db.close();}
}
