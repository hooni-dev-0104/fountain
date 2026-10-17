// Actual loopback HTTP and production domain code; MemoryProvider is a SQL contract MODEL, not PostgreSQL evidence.
import assert from 'node:assert/strict';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {CloudStore,StoreError,canonicalJSON,normalizeSelection,createStoreProvider} from '../functions/_shared/store.ts';
import {createFiles} from '../functions/_shared/files.ts';
import {createStorage,CHUNK_SIZE} from '../functions/_shared/storage.ts';
import {Access} from '../functions/_shared/access.ts';
import {Collaboration} from '../functions/_shared/collaboration.ts';
import {normalize_blocks} from '../functions/_shared/crdt.ts';
import {createTransactions,storeContext} from '../functions/_shared/transaction.ts';
const clone=structuredClone,sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
const context=Object.freeze({workspaceId:'fixture 空間',memberId:'alice',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)});
const second=Object.freeze({...context,memberId:'bob',userId:'33333333-3333-4333-8333-333333333333',authSessionId:'44444444-4444-4444-8444-444444444444',sessionHash:'c'.repeat(64),cacheBinding:'d'.repeat(32)});
const fixedTime='2026-10-16T00:00:00.123000+00:00', options={clock:()=>Date.parse('2026-10-16T00:00:00.123Z')};
const error=(code,status=409)=>new StoreError(status,code,'Model typed error');
const key=(kind,id)=>JSON.stringify([kind,id]);
class MemoryProvider {
  constructor(){
    this.records=new Map();this.metadata=new Map([['workspace_id',context.workspaceId],['settings',{name:'가족'}],['seeded',true],['access_revision',2],['null-value',null],['literal-missing',{$fountainMissing:true}]]);
    this.revision=7;this.receipts=new Map();this.requests=[];this.snapshotRequests=[];this.active=new Map([[context.sessionHash,clone(context)],[second.sessionHash,clone(second)]]);this.failAfterAck=false;this.corruptAck=false;this.beforeCommit=null;this.failAt=-1;this.retiredStorageIds=new Set();
    this.seed('member',{id:'alice',name:'가족',email:'alice@test.test',role:'owner',active:true});
    this.seed('member',{id:'bob',name:'가족2',email:'bob@test.test',role:'member',active:true});
    this.seed('group',{id:'family',members:['alice']});this.seed('teamspace',{id:'general',visibility:'open'});
    this.seed('page',{id:'__proto__',title:'한글 😀',permissions:{default:'private',members:JSON.parse('{"alice":"edit","__proto__":"view"}')}});
    this.seed('page',{id:'가족 문서?#%',title:'두 번째',parent_id:'__proto__'});this.seed('page',{id:'third',title:'세 번째'});
    this.seed('credential',{id:'alice',password_hash:'MUST_NOT_READ'});this.seed('session',{id:'legacy',token:'MUST_NOT_READ'});
    this.seed('attachment',{id:'inline',owner_id:'alice',size:3,data:'PRIVATE_BYTES'});
  }
  seed(kind,value){const data={...clone(value),created_at:fixedTime,updated_at:fixedTime};this.records.set(key(kind,data.id),{kind,id:data.id,data,createdAt:fixedTime,updatedAt:fixedTime});}
  authorize(ctx){
    const grant=this.active.get(ctx.sessionHash),member=this.records.get(key('member',ctx.memberId));
    if(!grant||canonicalJSON(grant)!==canonicalJSON(ctx)||!member||member.data.active!==true||!['owner','admin','member','guest'].includes(member.data.role))throw error('AUTH_REQUIRED',401);
    const {id,name,email,role,active}=member.data;return {id,name,email,role,active};
  }
  async snapshot(request){
    this.snapshotRequests.push(clone(request));const principal=this.authorize(request.context);
    if(request.expectedRevision!==undefined&&request.expectedRevision!==this.revision)throw error('REVISION_CONFLICT');
    const selected=normalizeSelection(request.selection),scope=await sha(canonicalJSON([request.context,selected,this.revision]));
    if(request.cursor&&(request.cursor.scope!==scope||request.cursor.revision!==this.revision))throw error('CURSOR_SCOPE');
    const all=Array.from(this.records.values()).filter(record=>selected.kinds.includes(record.kind)||(Object.hasOwn(selected.ids,record.kind)&&selected.ids[record.kind].includes(record.id))).sort((a,b)=>a.kind.localeCompare(b.kind)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const index=request.cursor?.index||0,rows=clone(all.slice(index,index+selected.pageSize));
    for(const row of rows)if(row.kind==='attachment')delete row.data.data;
    return {workspaceId:request.context.workspaceId,memberId:request.context.memberId,revision:this.revision,accessRevision:this.metadata.get('access_revision')||0,principal,entities:rows,meta:selected.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,present:true,value:Array.from(this.records.values()).filter(record=>record.kind==='page').map(record=>projectPageHeader(record.data)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)}:{key,present:this.metadata.has(key),value:this.metadata.has(key)?clone(this.metadata.get(key)):null}),nextCursor:index+rows.length<all.length?{index:index+rows.length,scope,revision:this.revision}:null};
  }
  async commit(request){
    this.requests.push(clone(request));if(this.beforeCommit)await this.beforeCommit();
    this.authorize(request.context);
    assert.equal(await sha(request.canonical),request.digest);assert.deepEqual(JSON.parse(request.canonical),{context:request.context,expectedRevision:request.expectedRevision,changes:request.changes});
    const receiptKey=JSON.stringify([request.context.workspaceId,request.context.memberId,request.context.sessionHash,request.transactionId]),prior=this.receipts.get(receiptKey);
    if(prior){if(prior.digest!==request.digest)throw error('COMMIT_ID_REUSED');return {revision:prior.revision};}
    if(request.expectedRevision!==this.revision)throw error('REVISION_CONFLICT');
    const records=clone(this.records),metadata=clone(this.metadata);let steps=0,index=0;
    for(const change of request.changes){
      if(index++===this.failAt)throw error('INJECTED_SQL_FAILURE',503);
      if(change.op==='put'){
        if(['upload','attachment','attachment_cloud'].includes(change.kind)&&this.retiredStorageIds.has(change.data.storage_id??change.id))throw error('STORAGE_ID_RETIRED');
        const previous=records.get(key(change.kind,change.id));
        if((previous?.createdAt??null)!==change.previousCreatedAt)throw error('REVISION_CONFLICT');
        records.set(key(change.kind,change.id),{kind:change.kind,id:change.id,data:clone(change.data),createdAt:change.data.created_at,updatedAt:change.data.updated_at});steps++;
      }else if(change.op==='delete'){if(records.delete(key(change.kind,change.id)))steps++;}
      else{metadata.set(change.key,clone(change.value));steps++;}
    }
    this.records=records;this.metadata=metadata;this.revision+=steps;this.receipts.set(receiptKey,{digest:request.digest,revision:this.revision});
    if(this.failAfterAck){this.failAfterAck=false;throw new Error('SECRET SQL/password/network acknowledgement dropped');}
    if(this.corruptAck){this.corruptAck=false;return {revision:this.revision+1};}
    return {revision:this.revision};
  }
}
const serviceKey='sb_secret_fixture_files_no_public',bucket='fountain-private';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,options={}){
 const provider=new MemoryProvider();provider.records.delete(key('attachment','inline'));
 provider.seed('page',{id:'page',owner_id:'bob',title:'공유문서',permissions:{default:'private',inherit:false,members:{alice:'edit',bob:'view'},groups:{}},blocks:[]});
 let time=Date.parse('2026-10-16T00:00:00.123Z');
 const objects=new Map(),calls=[],backupPins=new Set(),fenceCalls=[],io={onUpload:null,beforeUpload:null,beforeDelete:null,loseACK:false,loseDeleteACK:false,deleteStatus:200,readMode:null};
 const server=createServer(async(req,res)=>{try{
  assert.equal(req.headers.apikey,serviceKey);assert.equal(req.headers.authorization,undefined);
  const path=new URL(req.url,'http://fixture').pathname;calls.push([req.method,path]);
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/storage/v1/bucket/'+bucket)return json(200,{id:bucket,public:false,file_size_limit:50_000_000,allowed_mime_types:['application/octet-stream']});
  const upload='/storage/v1/object/'+bucket+'/',read='/storage/v1/object/authenticated/'+bucket+'/';
  if(req.method==='POST'&&path.startsWith(upload)){const chunks=[];for await(const bytes of req)chunks.push(bytes);const id=path.slice(upload.length);if(io.beforeUpload)await io.beforeUpload(id);if(objects.has(id))return json(400,{error:'Duplicate'});objects.set(id,Buffer.concat(chunks));if(io.onUpload)await io.onUpload(id);if(io.loseACK){io.loseACK=false;req.socket.destroy();return;}return json(200,{Key:id});}
  if(req.method==='GET'&&path.startsWith(read)){if(io.readMode==='unavailable')return json(503,{message:'unavailable'});const bytes=objects.get(path.slice(read.length));if(!bytes)return json(404,{message:'PRIVATE '+serviceKey});const data=Buffer.from(bytes);if(io.readMode==='corrupt')data[0]^=1;res.writeHead(200,{'Content-Length':String(data.length)});res.end(data);return;}
  if(req.method==='DELETE'&&path==='/storage/v1/object/'+bucket){if(io.beforeDelete)await io.beforeDelete();if(io.deleteStatus!==200)return json(io.deleteStatus,{message:serviceKey});let text='';for await(const bytes of req)text+=bytes;for(const id of JSON.parse(text).prefixes)objects.delete(id);if(io.loseDeleteACK){io.loseDeleteACK=false;req.socket.destroy();return;}return json(200,[]);}
  json(404,{});
 }catch{if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeAllConnections();server.close();await once(server,'close');});
 const storage=createStorage({supabaseUrl:origin,serviceKey,bucket,workspaceId:context.workspaceId,maxObjectBytes:50_000_000});
 const auth=ctx=>{const principal=provider.authorize(ctx);return {hash:ctx.sessionHash,userId:ctx.userId,authSessionId:ctx.authSessionId,cacheBinding:ctx.cacheBinding,profile:{workspaceId:ctx.workspaceId,authSessionActive:true,member:principal},expiresAt:time+3600_000};};
 const fenceGarbage=async(initial,id,items)=>{provider.authorize(storeContext(initial));fenceCalls.push({id,items:clone(items)});if(backupPins.has(id))throw error('STORAGE_STILL_REFERENCED');const gc=provider.records.get(key('upload_gc',id))?.data;assert(gc&&!gc.pending);assert.deepEqual(items,gc.cloud_chunks.slice(0,100));provider.retiredStorageIds.add(id);};
 let current=context;const files=createFiles({provider,storage,authorize:async()=>auth(current),clock:()=>time,fenceGarbage,...options});
 return {provider,storage,files,auth:()=>auth(current),alice:()=>auth(context),bob:()=>auth(second),setActor:ctx=>{current=ctx;},objects,calls,io,backupPins,fenceCalls,fenceGarbage,clock:ms=>{time+=ms;},raw:(kind,id)=>provider.records.get(key(kind,id))?.data,seed:(kind,value)=>{provider.seed(kind,value);provider.revision++;}};
}
const rejected=(promise,status)=>assert.rejects(promise,e=>e.status===status&&!e.message.includes(serviceKey));
async function upload(f,bytes,name='가족 파일 😀.bin',page_id='page'){const item=await f.files.begin(f.auth(),{name,size:bytes.length,page_id});for(let offset=0;offset<bytes.length;offset+=CHUNK_SIZE)await f.files.append(f.auth(),item.id,offset,bytes.subarray(offset,offset+CHUNK_SIZE));return item;}
const req=(path,method='GET',body,headers={})=>new Request('https://app.test'+path,{method,...(body===undefined?{}:{body}),headers});

// Separate private-byte source MODEL. General snapshots above still redact data;
// actual SQL/base64 validation is covered by dedicated provider/live SQL tests.
async function legacyFixture(t,bytes=Buffer.from('existing inline attachment')){
 let f;const reads=[],io={afterRead:null};
 const inlineSource={async read(input){
  input.signal?.throwIfAborted();f.provider.authorize(input.context);reads.push({...input,signal:undefined});
  const original=f.raw('attachment',input.attachmentId);if(!original)throw error('NOT_FOUND',404);
  const metadata=clone(original);delete metadata.data;assert.equal(canonicalJSON(input.metadata),canonicalJSON(metadata));
  const sourceDigest=digest(Buffer.from(canonicalJSON(original)));
  if(input.sourceDigest!==null&&input.sourceDigest!==sourceDigest)throw error('SOURCE_CHANGED');
  const content=Buffer.from(original.data,'base64'),result={offset:input.offset,size:content.length,sha256:digest(content),sourceDigest,bytes:new Uint8Array(content.subarray(input.offset,input.offset+input.length))};
  if(io.afterRead)await io.afterRead(input);input.signal?.throwIfAborted();return result;
 }};
 f=await fixture(t,{inlineSource});f.seed('attachment',{id:'legacy-inline',owner_id:'alice',name:'가족 원본.html',mime:'text/html',size:bytes.length,data:bytes.toString('base64')});
 return {...f,inlineReads:reads,inlineIO:io};
}
test('existing inline download preserves IDs/bytes and never exposes raw data in a snapshot or writes Storage/quota',async t=>{
 const bytes=Buffer.from('기존 가족 첨부 🏠'),f=await legacyFixture(t,bytes),before=clone(f.raw('attachment','legacy-inline')),revision=f.provider.revision,metadata=clone(f.provider.metadata);
 const response=await f.files.handle(req('/api/attachments/legacy-inline/download'),'/api/attachments/legacy-inline/download',f.auth());
 assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/octet-stream');assert.match(response.headers.get('Content-Disposition'),/attachment;/);assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('ETag'),'"'+digest(bytes)+'"');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(f.inlineReads.length,2);assert.deepEqual(f.inlineReads.map(read=>[read.offset,read.length]),[[0,0],[0,bytes.length]]);
 for(const read of f.inlineReads)assert.equal(Object.hasOwn(read.metadata,'data'),false);
 assert.deepEqual(f.raw('attachment','legacy-inline'),before);assert.equal(f.provider.revision,revision);assert.deepEqual(f.provider.metadata,metadata);assert.equal(f.provider.receipts.size,0);assert.equal(f.calls.length,0);assert.equal(f.objects.size,0);
 const dto=await f.files.metadata(f.auth(),'legacy-inline');assert.equal(dto.storage,'inline');assert(!JSON.stringify(dto).includes(before.data));assert.equal(dto.sourceDigest,undefined);
});
test('inline ranges, suffixes, HEAD and If-Range use full-source preflight and existing HTTP semantics',async t=>{
 const bytes=Buffer.from('0123456789'),f=await legacyFixture(t,bytes),path='/api/attachments/legacy-inline/download',etag='"'+digest(bytes)+'"';
 for(const [range,ifRange,status,expected] of [['bytes=2-5',null,206,'2345'],['bytes=-3',null,206,'789'],['bytes=8-',etag,206,'89'],['bytes=2-3','"old"',200,'0123456789']]){
  const response=await f.files.download(f.auth(),'legacy-inline',req(path,'GET',undefined,{Range:range,...ifRange?{'If-Range':ifRange}:{}}));assert.equal(response.status,status);assert.equal(response.headers.get('Content-Length'),String(expected.length));assert.equal(await response.text(),expected);
 }
 for(const range of ['bytes=10-','bytes=0-1,3-4','bytes=-0','bogus']){const response=await f.files.download(f.auth(),'legacy-inline',req(path,'GET',undefined,{Range:range}));assert.equal(response.status,416);assert.equal(response.headers.get('Content-Range'),'bytes */10');assert.equal(await response.text(),'');}
 const prior=f.inlineReads.length,head=await f.files.download(f.auth(),'legacy-inline',req(path,'HEAD',undefined,{Range:'bytes=2-4'}));assert.equal(head.status,200);assert.equal(head.headers.get('Content-Length'),'10');assert.equal(await head.text(),'');assert.equal(f.inlineReads.length,prior+1);assert.equal(f.inlineReads.at(-1).length,0);
 const empty=await legacyFixture(t,Buffer.alloc(0)),response=await empty.files.download(empty.auth(),'legacy-inline',req(path));assert.equal(response.status,200);assert.equal(response.headers.get('ETag'),'"'+digest(Buffer.alloc(0))+'"');assert.equal((await response.arrayBuffer()).byteLength,0);assert.equal(empty.inlineReads.length,1);
});
test('inline stream rechecks shared ACL after the private byte read and stops on same-size source replacement',async t=>{
 for(const when of ['between-pieces','during-private-read']){
  const f=await legacyFixture(t,Buffer.alloc(150000,0x61));f.raw('page','page').owner_id='nobody';f.raw('page','page').blocks=[{id:'file',attachment_id:'legacy-inline'}];f.provider.revision++;f.setActor(second);
  // SQL computes current headers and ignores a forged persisted reserved key.
  f.provider.metadata.set(PAGE_HEADER_META_KEY,[{id:'forged',blocks:[{text:'must not be returned'}]}]);
  const response=await f.files.download(f.auth(),'legacy-inline',req('/api/attachments/legacy-inline/download')),reader=response.body.getReader();
  if(when==='between-pieces'){assert.equal((await reader.read()).value.length,65536);f.raw('page','page').permissions.members.bob='none';f.provider.revision++;}
  else f.inlineIO.afterRead=input=>{if(input.length){f.raw('page','page').permissions.members.bob='none';f.provider.revision++;}};
  await rejected(reader.read(),404);assert(f.raw('attachment','legacy-inline'));assert.equal(f.calls.length,0);
 }
 const f=await legacyFixture(t,Buffer.alloc(150000,0x61)),response=await f.files.download(f.auth(),'legacy-inline',req('/api/attachments/legacy-inline/download')),reader=response.body.getReader();await reader.read();
 f.raw('attachment','legacy-inline').data=Buffer.alloc(150000,0x62).toString('base64');await rejected(reader.read(),409);assert.equal(f.provider.receipts.size,0);
});
test('inline body cancellation/logout has no further reads, and a cloud overlay never falls back to original inline data',async t=>{
 const path='/api/attachments/legacy-inline/download';
 for(const action of ['cancel','logout','abort']){
  const f=await legacyFixture(t,Buffer.alloc(150000,0x61)),abort=new AbortController(),response=await f.files.download(f.auth(),'legacy-inline',new Request('https://app.test'+path,{signal:abort.signal})),reader=response.body.getReader();await reader.read();const before=f.inlineReads.length;
  if(action==='cancel'){await reader.cancel();assert.equal((await reader.read()).done,true);}
  else if(action==='logout'){f.provider.active.delete(context.sessionHash);await rejected(reader.read(),401);}
  else{abort.abort();await assert.rejects(reader.read(),error=>error.name==='AbortError');}
  assert.equal(f.inlineReads.length,before);assert.equal(f.calls.length,0);
 }
 const f=await legacyFixture(t),original=f.raw('attachment','legacy-inline'),fields=['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at'];
 f.seed('attachment_cloud',{...Object.fromEntries(Object.entries(original).filter(([key])=>key!=='data')),storage:'chunks',storage_id:'missing-cloud',cloud_chunks:[],source_fingerprint:canonicalJSON(Object.fromEntries(fields.map(key=>[key,original[key]??null])))});
 await rejected(f.files.download(f.auth(),'legacy-inline',req(path)),409);assert.equal(f.inlineReads.length,0);assert(f.raw('attachment','legacy-inline').data);
});

test('manual GC keeps bytes and reservation while a materialized backup pins them (SQL pins modeled)',async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await upload(f,Buffer.from('safe'));f.io.deleteStatus=503;await f.files.cancel(f.auth(),item.id);f.io.deleteStatus=200;f.backupPins.add(item.id);const deletes=f.calls.filter(([verb])=>verb==='DELETE').length;
 await rejected(f.files.garbageCollect(f.auth(),item.id),409);assert.equal(f.objects.size,1);assert.equal(f.raw('upload_gc',item.id).reserved_bytes,4);assert.equal(f.calls.filter(([verb])=>verb==='DELETE').length,deletes);
 f.backupPins.delete(item.id);assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,true);assert.equal(f.objects.size,0);
});
test('permanent SQL retirement fences a new reference after the final read gate and before physical DELETE (trigger modeled)',async t=>{
 const f=await fixture(t),item=await upload(f,Buffer.from('safe'));f.io.deleteStatus=503;await f.files.cancel(f.auth(),item.id);f.io.deleteStatus=200;let blocked=false;
 f.io.beforeDelete=async()=>{const store=await CloudStore.open(f.provider,storeContext(f.auth()),{ids:{attachment_cloud:['attempted-relink']}},options);store.put('attachment_cloud',{id:'attempted-relink',storage_id:item.id,name:'ref',size:4,cloud_chunks:clone(f.raw('upload_gc',item.id).cloud_chunks)});await assert.rejects(store.commit(),e=>e.code==='STORAGE_ID_RETIRED');blocked=true;};
 assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,true);assert.equal(blocked,true);assert(f.fenceCalls.length>=1);assert.equal(f.objects.size,0);assert.equal(f.raw('attachment_cloud','attempted-relink'),undefined);
});

test('resumable domain publishes exact bytes once, metadata stays private, GET/stream gates create no SQL receipts',async t=>{
 const f=await fixture(t),bytes=randomBytes(CHUNK_SIZE+17),item=await upload(f,bytes);
 const first=await f.files.append(f.auth(),item.id,0,bytes.subarray(0,CHUNK_SIZE));assert.equal(first.offset,bytes.length);assert.equal(f.objects.size,2);
 const done=await f.files.complete(f.auth(),item.id);assert.equal(done.sha256,digest(bytes));assert.equal(done.id,item.id);assert.deepEqual(await f.files.complete(f.auth(),item.id),done);
 assert.equal((await f.files.cancel(f.auth(),item.id)).cancelled,false);
 const before=f.provider.receipts.size;assert.equal((await f.files.status(f.auth(),item.id)).attachment.sha256,done.sha256);
 const metadata=await f.files.metadata(f.auth(),item.id);assert.deepEqual(Object.keys(metadata).sort(),['id','name','size','mime','storage','status','sha256'].sort());
 const response=await f.files.download(f.auth(),item.id,req('/api/attachments/'+item.id+'/download','GET',undefined,{Range:`bytes=${CHUNK_SIZE-3}-${CHUNK_SIZE+6}`}));assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(CHUNK_SIZE-3,CHUNK_SIZE+7));assert.equal(f.provider.receipts.size,before);
 const publicText=JSON.stringify([first,done,metadata]);for(const forbidden of ['cloud_chunks','pending','checkpoint','storage_id',serviceKey,'http://127.0.0.1'])assert(!publicText.includes(forbidden));
});
test('concurrent different bytes are fenced by durable intent before publication; identical concurrent retries do not advance twice',async t=>{
 const f=await fixture(t),item=await f.files.begin(f.auth(),{name:'race.bin',size:7}),a=Buffer.from('aaaaaaa'),b=Buffer.from('bbbbbbb');
 let release,entered;const ready=new Promise(r=>{entered=r;});f.io.onUpload=async()=>{entered();await new Promise(r=>{release=r;});};
 const first=f.files.append(f.auth(),item.id,0,a);await ready;await rejected(f.files.append(f.auth(),item.id,0,b),409);assert.equal(f.objects.size,1);release();await first;f.io.onUpload=null;
 const retries=await Promise.all([f.files.append(f.auth(),item.id,0,a),f.files.append(f.auth(),item.id,0,a)]);assert(retries.every(x=>x.offset===7));assert.equal(f.raw('upload',item.id).cloud_chunks.length,1);assert.equal(f.objects.size,1);
});
test('lost metadata acknowledgement exact-retries its receipt without duplicating offset or publication',async t=>{
 const f=await fixture(t),item=await f.files.begin(f.auth(),{name:'ack.bin',size:4});let lost=false;
 f.provider.beforeCommit=async()=>{const last=f.provider.requests.at(-1);if(!lost&&last.changes.some(c=>c.kind==='upload'&&c.data?.offset===4)){lost=true;f.provider.failAfterAck=true;}};
 assert.equal((await f.files.append(f.auth(),item.id,0,Buffer.from('once'))).offset,4);assert(lost);const requests=f.provider.requests.filter(r=>r.changes.some(c=>c.kind==='upload'&&c.data?.offset===4));assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(f.raw('upload',item.id).cloud_chunks.length,1);
});
test('fresh ACL and session gates after physical publish keep offset uncommitted and support exact authorized resume',async t=>{
 const f=await fixture(t);f.setActor(second);const item=await f.files.begin(f.auth(),{name:'revoked.bin',size:4,page_id:'page'});
 f.io.onUpload=()=>{f.raw('page','page').locked=true;f.provider.revision++;};await rejected(f.files.append(f.auth(),item.id,0,Buffer.from('data')),423);assert.equal(f.raw('upload',item.id).offset,0);assert(f.raw('upload',item.id).pending);assert.equal(f.raw('attachment',item.id),undefined);
 f.io.onUpload=null;f.raw('page','page').locked=false;f.provider.revision++;assert.equal((await f.files.append(f.auth(),item.id,0,Buffer.from('data'))).offset,4);
 const stale=f.bob();f.provider.active.delete(second.sessionHash);await rejected(f.files.complete(stale,item.id),401);assert.equal(f.raw('attachment',item.id),undefined);
});
test('9MB three chunks finish in one request; bounded server verification checkpoints return 202 then resume',async t=>{
 const f=await fixture(t),bytes=randomBytes(9_000_000),item=await upload(f,bytes);
 const response=await f.files.handle(req('/api/uploads/'+item.id+'/complete','POST','{"checkpoint":{"offset":9000000}}'),'/api/uploads/'+item.id+'/complete',f.auth());assert.equal(response.status,201);assert.equal((await response.json()).sha256,digest(bytes));
 const slow=await fixture(t,{verifyChunks:1}),u=await upload(slow,bytes);let responses=0,last;
 do{last=await slow.files.handle(req('/api/uploads/'+u.id+'/complete','POST','{"checkpoint":{"offset":9000000}}'),'/api/uploads/'+u.id+'/complete',slow.auth());responses++;if(last.status===202){const body=await last.json();assert.equal(body.verification_pending,true);assert(body.verified_offset<bytes.length);assert.equal(slow.raw('attachment',u.id),undefined);}}while(last.status===202);
 assert.equal(responses,3);assert.equal(last.status,201);assert.equal((await last.json()).sha256,digest(bytes));
});
test('same-length object corruption cannot complete and client never receives a false completed attachment',async t=>{
 const f=await fixture(t),item=await upload(f,Buffer.from('honest'));f.io.readMode='corrupt';await rejected(f.files.complete(f.auth(),item.id),409);assert.equal(f.raw('attachment',item.id),undefined);assert.equal(f.raw('upload',item.id).completed,false);
});
test('logical quota CAS survives races; failed GC retains quota until physical deletion acknowledgement',async t=>{
 const f=await fixture(t,{quotaBytes:10});const results=await Promise.allSettled([f.files.begin(f.auth(),{name:'a',size:7}),f.files.begin(f.auth(),{name:'b',size:7})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,507);
 const item=results.find(r=>r.status==='fulfilled').value;await f.files.append(f.auth(),item.id,0,Buffer.from('1234567'));f.io.deleteStatus=503;
 assert.equal((await f.files.cancel(f.auth(),item.id)).cleanup_pending,true);assert.equal(f.raw('upload',item.id),undefined);assert.equal(f.raw('upload_gc',item.id).reserved_bytes,7);await rejected(f.files.begin(f.auth(),{name:'c',size:4}),507);
 f.io.deleteStatus=200;assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,true);assert.equal(f.objects.size,0);await f.files.begin(f.auth(),{name:'new',size:10});
});
test('private backup reservations share attachment quota and a concurrent reservation invalidates stale file CAS',async t=>{
 const f=await fixture(t,{quotaBytes:10});f.provider.metadata.set('_backup_storage_reserved',8);f.provider.revision++;
 await rejected(f.files.begin(f.auth(),{name:'too-large',size:3}),507);assert.equal(f.objects.size,0);
 const exact=await f.files.begin(f.auth(),{name:'fits',size:2});assert.equal(exact.size,2);
 const second=await fixture(t,{quotaBytes:10}),commit=second.provider.commit.bind(second.provider);let injected=false;
 second.provider.commit=async request=>{if(!injected){injected=true;second.provider.metadata.set('_backup_storage_reserved',8);second.provider.revision++;}return commit(request);};
 await rejected(second.files.begin(second.auth(),{name:'stale',size:3}),507);assert.equal(injected,true);assert.equal([...second.provider.records.values()].filter(row=>row.kind==='upload').length,0);
 second.provider.metadata.set('_backup_storage_reserved',-1);second.provider.revision++;await rejected(second.files.begin(second.auth(),{name:'invalid',size:0}),409);
});
test('expiry cleanup requires owner, preserves completed attachment and zero-byte full SHA',async t=>{
 const f=await fixture(t),empty=await upload(f,Buffer.alloc(0));const file=await f.files.complete(f.auth(),empty.id);assert.equal(file.sha256,digest(Buffer.alloc(0)));assert.equal(f.objects.size,0);
 const abandoned=await upload(f,Buffer.from('pending'));f.clock(86400_001);f.setActor(second);await rejected(f.files.cleanup(f.auth()),403);f.setActor(context);assert.equal((await f.files.cleanup(f.auth())).removed,2);assert(f.raw('attachment',empty.id));assert.equal(f.raw('upload',abandoned.id),undefined);assert.equal(f.objects.size,0);
});
test('legacy inline and POSIX-style bytes migrate through actual source without changing originals or completed old upload',async t=>{
 for(const storage of ['inline','chunks']){
  const f=await fixture(t),bytes=randomBytes(CHUNK_SIZE+3),id='legacy-'+storage;f.seed('attachment',{id,name:'원본.bin',owner_id:'alice',size:bytes.length,mime:'application/octet-stream',storage,data:bytes.toString('base64'),sha256:digest(bytes)});f.seed('upload',{id,owner_id:'alice',completed:true,offset:bytes.length,size:bytes.length,expires_at:'2030-01-01T00:00:00Z'});
  const original=clone(f.raw('attachment',id)),oldUpload=clone(f.raw('upload',id));async function* source(){for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);}
  const migrated=await f.files.migrate(f.auth(),id,source());assert.equal(migrated.id,id);assert.equal(migrated.sha256,digest(bytes));assert.deepEqual(f.raw('attachment',id),original);assert.deepEqual(f.raw('upload',id),oldUpload);assert.equal(f.raw('attachment_cloud',id).storage_id===id,false);
  const response=await f.files.download(f.auth(),id,req('/api/attachments/'+id+'/download'));assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.deepEqual(await f.files.migrate(f.auth(),id,new Uint8Array()),migrated);
  f.raw('attachment',id).name='changed.bin';f.provider.revision++;await rejected(f.files.metadata(f.auth(),id),409);
 }
});
test('short or wrong-hash migration preserves legacy source and never creates a public companion',async t=>{
 const f=await fixture(t),bytes=Buffer.from('original'),id='legacy';f.seed('attachment',{id,name:'old.bin',owner_id:'alice',size:bytes.length,data:bytes.toString('base64'),sha256:digest(bytes)});const original=clone(f.raw('attachment',id));
 await rejected(f.files.migrate(f.auth(),id,Buffer.from('short')),409);assert.deepEqual(f.raw('attachment',id),original);assert.equal(f.raw('attachment_cloud',id),undefined);
 await rejected(f.files.migrate(f.auth(),id,Buffer.from('WRONGSHA')),409);assert.deepEqual(f.raw('attachment',id),original);assert.equal(f.raw('attachment_cloud',id),undefined);
});
test('HTTP raw chunk framing and inline small attachments preserve compatibility without byte metadata exposure',async t=>{
 const f=await fixture(t),data=Buffer.from('inline bytes'),response=await f.files.handle(req('/api/attachments','POST',JSON.stringify({name:'small.txt',data:data.toString('base64')}),{'Content-Type':'application/json'}),'/api/attachments',f.auth());assert.equal(response.status,201);const file=await response.json();assert.equal(file.data,undefined);assert.equal(file.sha256,digest(data));
 const item=await f.files.begin(f.auth(),{name:'raw',size:4}),path='/api/uploads/'+item.id+'/chunks';
 await rejected(f.files.handle(req(path+'?offset=0','PUT','data',{'Content-Type':'application/octet-stream'}),path,f.auth()),411);
 const raw=await f.files.handle(req(path+'?offset=0','PUT','data',{'Content-Type':'application/octet-stream','Content-Length':'4'}),path,f.auth());assert.equal(raw.status,200);assert.equal((await raw.json()).offset,4);
 await rejected(f.files.handle(req(path+'?offset=0&offset=1','PUT','data',{'Content-Type':'application/octet-stream','Content-Length':'4'}),path,f.auth()),400);
 assert.equal(await f.files.handle(req('/api/pages'),'/api/pages',f.auth()),null);
});
test('revoked shared attachment streams stop before further public bytes, foreign editors cannot delete',async t=>{
 const f=await fixture(t),bytes=randomBytes(150_000),item=await upload(f,bytes);await f.files.complete(f.auth(),item.id);
 f.raw('page','page').blocks=[{id:'file-block',attachment_id:item.id}];f.provider.revision++;
 f.setActor(second);const initial=f.auth();await rejected(f.files.remove(initial,item.id),403);
 f.provider.metadata.set(PAGE_HEADER_META_KEY,[{id:'forged',blocks:[{text:'must not be returned'}]}]);
 const response=await f.files.download(initial,item.id,req('/api/attachments/'+item.id+'/download')),reader=response.body.getReader();const first=await reader.read();assert.equal(first.value.length,65536);
 f.raw('page','page').permissions.members.bob='none';f.raw('page','page').owner_id='nobody';f.provider.revision++;
 await rejected(reader.read(),404);await rejected(f.files.metadata(initial,item.id),404);assert(f.raw('attachment',item.id));
});
test('explicit attachment deletion checks document/version/row references and defers physical GC without losing reservation',async t=>{
 const f=await fixture(t),item=await upload(f,Buffer.from('keep'));await f.files.complete(f.auth(),item.id);
 for(const kind of ['page','version']){const object={id:'reference-'+kind,blocks:[{attachment_id:item.id}]};f.seed(kind,object);await rejected(f.files.remove(f.auth(),item.id),409);f.provider.records.delete(key(kind,object.id));f.provider.revision++;}
 f.seed('database',{id:'db',properties:[{id:'files',type:'files'}]});f.seed('row',{id:'row',database_id:'db',properties:{files:[item.id]}});await rejected(f.files.remove(f.auth(),item.id),409);f.raw('row','row').properties.files=[];f.provider.revision++;
 f.io.deleteStatus=503;const path='/api/attachments/'+item.id,response=await f.files.handle(req(path,'DELETE'),path,f.auth());assert.deepEqual(await response.json(),{deleted:true,cleanup_pending:true});assert.equal(f.raw('attachment',item.id),undefined);assert.equal(f.raw('upload',item.id),undefined);assert.equal(f.raw('upload_gc',item.id).reserved_bytes,4);assert.equal(f.objects.size,1);
 f.io.deleteStatus=200;assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,true);assert.equal(f.objects.size,0);
});
test('expired pending reservations still count until cleanup and staged SQL failure publishes no object',async t=>{
 const f=await fixture(t,{quotaBytes:8}),item=await upload(f,Buffer.from('12345678'));f.clock(86400_001);await rejected(f.files.begin(f.auth(),{name:'new',size:1}),507);await f.files.cleanup(f.auth());assert.equal(f.objects.size,0);
 const next=await f.files.begin(f.auth(),{name:'rollback',size:4}),revision=f.provider.revision;f.provider.failAt=0;await rejected(f.files.append(f.auth(),next.id,0,Buffer.from('test')),503);assert.equal(f.raw('upload',next.id).pending,null);assert.equal(f.provider.revision,revision);assert.equal(f.objects.size,0);
});
test('GC cannot erase a live migration companion namespace and malformed metadata never reads provider bytes',async t=>{
 const f=await fixture(t),bytes=Buffer.from('source'),id='source';f.seed('attachment',{id,name:'old',size:bytes.length,owner_id:'alice'});await f.files.migrate(f.auth(),id,bytes);const overlay=f.raw('attachment_cloud',id),physical=overlay.storage_id;
 // Adversarial corrupt internal claim: normal application cannot create this.
 f.provider.records.delete(key('upload',physical));f.seed('upload_gc',{id:physical,owner_id:'alice',reserved_bytes:bytes.length,cloud_chunks:clone(overlay.cloud_chunks)});const prior=f.calls.length;await rejected(f.files.garbageCollect(f.auth(),physical),409);assert.equal(f.calls.length,prior);assert.equal(f.objects.size,1);
 f.raw('attachment',id).size='six';f.provider.revision++;await rejected(f.files.metadata(f.auth(),id),409);assert.equal(f.calls.length,prior);
});
test('inline HTTP accepts real 4MiB and maximum 5MB bytes using bounded linear base64 validation',{timeout:15000},async t=>{
 const f=await fixture(t),server=createServer(async(request,response)=>{
  try{
   const pieces=[];let length=0;for await(const piece of request){length+=piece.length;assert(length<=10_000_000);pieces.push(piece);}
   const result=await f.files.handle(new Request('https://app.test'+request.url,{method:request.method,headers:request.headers,body:Buffer.concat(pieces)}),request.url,f.auth());
   response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
  }catch(error){response.writeHead(error.status??500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:error.status?'Invalid attachment':'Unexpected fixture error'}));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:'+server.address().port+'/api/attachments';t.after(async()=>{server.closeAllConnections();server.close();await once(server,'close');});
 const send=data=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'large.bin',data})});
 for(const size of [CHUNK_SIZE,5_000_000]){
  const bytes=Buffer.alloc(size,0x5a),started=performance.now(),response=await send(bytes.toString('base64'));assert.equal(response.status,201);const file=await response.json();assert.equal(file.size,size);assert.equal(file.sha256,digest(bytes));assert.equal(file.data,undefined);
  const downloaded=await f.files.download(f.auth(),file.id,req('/api/attachments/'+file.id+'/download'));assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);t.diagnostic(`${size} byte HTTP/base64/upload/verify/download roundtrip ${Math.round(performance.now()-started)}ms (Node, not Edge CPU evidence)`);
 }
 const unchanged=()=>({records:clone(f.provider.records),metadata:clone(f.provider.metadata),revision:f.provider.revision,receipts:clone(f.provider.receipts),objects:clone(f.objects)}),baseline=unchanged();
 for(const invalid of ['A===','AA=','AAA','AA==AA==','AAAA====',' AA==','AA==\n','ÄAAA','AA-A','AA_A','A'.repeat(CHUNK_SIZE)+'!']){const response=await send(invalid);assert.equal(response.status,400);assert.deepEqual(unchanged(),baseline);}
 const oversized=await send(Buffer.alloc(5_000_001).toString('base64'));assert.equal(oversized.status,413);assert.deepEqual(unchanged(),baseline);
});
test('cancel cannot free quota while the single POST is held before physical publication; later verified GC reclaims it',{timeout:5000},async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await f.files.begin(f.auth(),{name:'late.bin',size:4}),bytes=Buffer.from('late');
 let release,entered;const ready=new Promise(resolve=>{entered=resolve;});f.io.beforeUpload=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
 const publishing=f.files.append(f.auth(),item.id,0,bytes).then(value=>({value}),error=>({error}));await ready;
 try{
  const result=await f.files.cancel(f.auth(),item.id);assert.equal(result.cleanup_pending,true);assert.equal(f.raw('upload_gc',item.id).reserved_bytes,4);assert(f.raw('upload_gc',item.id).pending.attempt_id);assert.equal(f.objects.size,0);assert.equal(f.calls.filter(([method])=>method==='DELETE').length,0);await rejected(f.files.begin(f.auth(),{name:'too-early',size:1}),507);
 }finally{release();await publishing;}
 assert.equal(f.objects.size,1);assert.equal(f.raw('upload',item.id),undefined);assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,true);assert.equal(f.objects.size,0);assert.equal(f.raw('upload_gc',item.id),undefined);await f.files.begin(f.auth(),{name:'safe-new',size:4});
});
test('identical concurrent retry never launches a second POST while original publication is unresolved',{timeout:5000},async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await f.files.begin(f.auth(),{name:'once.bin',size:4}),bytes=Buffer.from('once');let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
 f.io.beforeUpload=async()=>{entered();await new Promise(resolve=>{release=resolve;});};const first=f.files.append(f.auth(),item.id,0,bytes);await ready;
 try{await rejected(f.files.append(f.auth(),item.id,0,bytes),503);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);assert.equal(f.raw('upload',item.id).offset,0);}finally{release();await first;}
 await f.files.append(f.auth(),item.id,0,bytes);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);assert.equal(f.raw('upload',item.id).cloud_chunks.length,1);await f.files.cancel(f.auth(),item.id);assert.equal(f.objects.size,0);
});
test('lost POST ACK and failed readback recover only by exact existing-object read, never a replacement POST',async t=>{
 const f=await fixture(t),item=await f.files.begin(f.auth(),{name:'ack.bin',size:4}),bytes=Buffer.from('once');f.io.loseACK=true;f.io.onUpload=()=>{f.io.readMode='unavailable';};
 await rejected(f.files.append(f.auth(),item.id,0,bytes),503);assert.equal(f.raw('upload',item.id).offset,0);assert(f.raw('upload',item.id).pending.attempt_id);assert.equal(f.objects.size,1);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);
 f.io.onUpload=null;f.io.readMode=null;assert.equal((await f.files.append(f.auth(),item.id,0,bytes)).offset,4);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);assert.equal(f.raw('upload',item.id).pending,null);assert.equal((await f.files.complete(f.auth(),item.id)).sha256,digest(bytes));
});
test('process loss after durable claim before I/O stays quarantined across time and cancellation with no object evidence',async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await f.files.begin(f.auth(),{name:'crash.bin',size:4}),bytes=Buffer.from('safe');
 const crashed=createFiles({provider:f.provider,storage:{...f.storage,writeChunk:async()=>{throw Error('simulated process loss before I/O');}},authorize:async()=>f.auth(),clock:options.clock});
 await assert.rejects(crashed.append(f.auth(),item.id,0,bytes),/simulated process loss/);assert(f.raw('upload',item.id).pending.attempt_id);assert.equal(f.calls.length,0);
 await rejected(f.files.append(f.auth(),item.id,0,bytes),503);assert.equal(f.calls.filter(([method])=>method==='POST').length,0);assert.equal((await f.files.cancel(f.auth(),item.id)).cleanup_pending,true);f.clock(30*86400_000);assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,false);assert.equal(f.raw('upload_gc',item.id).reserved_bytes,4);await rejected(f.files.begin(f.auth(),{name:'unsafe',size:1}),507);assert.equal(f.calls.filter(([method])=>method==='DELETE').length,0);
});
test('late object settlement persists before GC deletion; failed deletion retries without POST or releasing reservation',{timeout:5000},async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await f.files.begin(f.auth(),{name:'late-gc.bin',size:4});let release,entered;const ready=new Promise(resolve=>{entered=resolve;});f.io.beforeUpload=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
 const append=f.files.append(f.auth(),item.id,0,Buffer.from('safe')).catch(error=>error);await ready;await f.files.cancel(f.auth(),item.id);release();await append;f.io.deleteStatus=503;
 await rejected(f.files.garbageCollect(f.auth(),item.id),503);const gc=f.raw('upload_gc',item.id);assert.equal(gc.pending,null);assert.equal(gc.cloud_chunks.length,1);assert.equal(gc.reserved_bytes,4);await rejected(f.files.begin(f.auth(),{name:'still-full',size:1}),507);
 f.io.deleteStatus=200;await f.files.garbageCollect(f.auth(),item.id);assert.equal(f.objects.size,0);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);assert.equal(f.raw('upload_gc',item.id),undefined);
});
test('retry may settle already visible exact bytes before original POST responds; cancel cannot be followed by a second late publication',{timeout:5000},async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await f.files.begin(f.auth(),{name:'visible.bin',size:4}),bytes=Buffer.from('once');let release,entered;const ready=new Promise(resolve=>{entered=resolve;});f.io.onUpload=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
 const original=f.files.append(f.auth(),item.id,0,bytes).catch(error=>error);await ready;
 try{assert.equal((await f.files.append(f.auth(),item.id,0,bytes)).offset,4);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);assert.equal((await f.files.cancel(f.auth(),item.id)).cancelled,true);assert.equal(f.objects.size,0);await f.files.begin(f.auth(),{name:'replacement',size:4});}finally{release();await original;}
 assert.equal(f.objects.size,0);assert.equal(f.raw('upload_gc',item.id),undefined);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);
});
test('lost physical DELETE acknowledgement retains durable GC reservation until exact idempotent deletion retry',async t=>{
 const f=await fixture(t,{quotaBytes:4}),item=await upload(f,Buffer.from('safe'));f.io.loseDeleteACK=true;assert.equal((await f.files.cancel(f.auth(),item.id)).cleanup_pending,true);assert.equal(f.objects.size,0);assert.equal(f.raw('upload_gc',item.id).reserved_bytes,4);await rejected(f.files.begin(f.auth(),{name:'blocked',size:1}),507);
 assert.equal((await f.files.garbageCollect(f.auth(),item.id)).removed,true);assert.equal(f.raw('upload_gc',item.id),undefined);assert.equal(f.calls.filter(([method])=>method==='POST').length,1);await f.files.begin(f.auth(),{name:'released',size:4});
});
test('normal cleanup rotates durably past more than four unknown quarantines and reclaims recovered known GC',{timeout:10000},async t=>{
 const f=await fixture(t,{quotaBytes:24}),unknown=[];
 const crashed=createFiles({provider:f.provider,storage:{...f.storage,writeChunk:async()=>{throw Error('simulated process loss');}},authorize:async()=>f.auth(),clock:options.clock});
 for(let i=0;i<5;i++){
  f.clock(1);const item=await f.files.begin(f.auth(),{name:'unknown-'+i,size:4});await assert.rejects(crashed.append(f.auth(),item.id,0,Buffer.from('lost')),/simulated process loss/);assert.equal((await f.files.cancel(f.auth(),item.id)).cleanup_pending,true);unknown.push(item.id);
 }
 f.clock(1);const known=await upload(f,Buffer.from('safe'));f.io.deleteStatus=503;assert.equal((await f.files.cancel(f.auth(),known.id)).cleanup_pending,true);f.io.deleteStatus=200;assert.equal(f.objects.size,1);await rejected(f.files.begin(f.auth(),{name:'full',size:1}),507);
 const objectReads=id=>f.calls.filter(([method,path])=>method==='GET'&&path.includes('/object/authenticated/')&&path.includes('/'+digest(Buffer.from(id))+'/')).length,before=unknown.map(objectReads);
 const server=createServer(async(request,response)=>{try{
  let data='';for await(const piece of request)data+=piece;assert(data.length<100);
  // New domain instance for EVERY HTTP invocation proves progress is durable,
  // rather than relying on an Edge worker's memory or a process-local cursor.
  const restarted=createFiles({provider:f.provider,storage:f.storage,authorize:async()=>f.auth(),clock:options.clock,quotaBytes:24,fenceGarbage:f.fenceGarbage});
  const result=await restarted.handle(new Request('https://app.test/api/uploads/cleanup',{method:'POST',body:data,headers:{'Content-Type':'application/json'}}),'/api/uploads/cleanup',f.auth());response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
 }catch(error){response.writeHead(error.status??500);response.end('{}');}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();server.close();await once(server,'close');});
 for(let round=0;round<3;round++){
  const reads=f.calls.filter(([method,path])=>method==='GET'&&path.includes('/object/authenticated/')).length,response=await fetch('http://127.0.0.1:'+server.address().port+'/api/uploads/cleanup',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}});assert.equal(response.status,200);const result=await response.json();assert.equal(result.removed,0);assert(result.cleanup_pending<=4);assert(f.calls.filter(([method,path])=>method==='GET'&&path.includes('/object/authenticated/')).length-reads<=4);
 }
 assert.equal(f.raw('upload_gc',known.id),undefined);assert.equal(f.objects.size,0);
 for(let i=0;i<unknown.length;i++){assert(f.raw('upload_gc',unknown[i]).pending.attempt_id);assert.equal(f.raw('upload_gc',unknown[i]).reserved_bytes,4);assert(objectReads(unknown[i])>before[i]);}
 await f.files.begin(f.auth(),{name:'released-four-bytes',size:4});await rejected(f.files.begin(f.auth(),{name:'unknown-still-reserved',size:1}),507);
});
test('cleanup cursor CAS rolls back before I/O, isolates owners and bounds rounds against new arrivals',async t=>{
 const f=await fixture(t),aliceCursor='upload_gc_cursor:'+digest(Buffer.from('alice')),bobCursor='upload_gc_cursor:'+digest(Buffer.from('bob'));
 const pending={offset:0,size:4,sha256:digest(Buffer.from('lost')),attempt_id:crypto.randomUUID()};for(let i=0;i<5;i++)f.seed('upload_gc',{id:'q'+i,owner_id:'alice',page_id:null,reserved_bytes:4,cloud_chunks:[],pending:clone(pending)});
 const before=clone(f.provider.metadata);f.provider.failAt=0;await rejected(f.files.cleanup(f.auth()),503);assert.deepEqual(f.provider.metadata,before);assert.equal(f.calls.length,0);f.provider.failAt=-1;
 await f.files.cleanup(f.auth());const alice=clone(f.provider.metadata.get(aliceCursor));assert.equal(alice.after.id,'q3');assert.equal(alice.through.id,'q4');assert.equal(f.provider.metadata.has(bobCursor),false);
 f.raw('member','bob').role='owner';f.provider.revision++;f.setActor(second);await f.files.cleanup(f.auth());assert.deepEqual(f.provider.metadata.get(aliceCursor),alice);assert.deepEqual(f.provider.metadata.get(bobCursor),alice);
 f.setActor(context);f.seed('upload_gc',{id:'q5',owner_id:'alice',page_id:null,reserved_bytes:4,cloud_chunks:[],pending:clone(pending)});const reads=id=>f.calls.filter(([method,path])=>method==='GET'&&path.includes('/object/authenticated/')&&path.includes('/'+digest(Buffer.from(id))+'/')).length;
 const newReads=reads('q5');await f.files.cleanup(f.auth());assert.equal(f.provider.metadata.get(aliceCursor),null);assert.equal(reads('q5'),newReads);assert.deepEqual(f.provider.metadata.get(bobCursor),alice);
 await f.files.cleanup(f.auth());await f.files.cleanup(f.auth());assert(reads('q5')>newReads);for(let i=0;i<6;i++){assert.equal(f.raw('upload_gc','q'+i).reserved_bytes,4);assert.deepEqual(f.raw('upload_gc','q'+i).pending,pending);}assert.equal(f.calls.filter(([method])=>method==='DELETE'||method==='POST').length,0);
});

test('latent one-batch CRDT history protects exact bytes through actual undo and permits deletion after reference release',async t=>{
 const f=await fixture(t),bytes=Buffer.from('latent private bytes'),uploading=await upload(f,bytes),item=await f.files.complete(f.auth(),uploading.id);
 f.seed('page',{...f.raw('page','page'),revision:0,blocks:normalize_blocks([{id:'latent',type:'file',attachment_id:null}])});
 const execute=createTransactions({provider:f.provider,authorize:async()=>f.auth(),clock:options.clock}),collab=s=>new Collaboration(s,{validate_blocks:normalize_blocks},{uid:()=> 'latent-epoch'});
 await execute(f.auth(),s=>collab(s).snapshot('page',new Access(s,s.principal)));
 const added={id:'latent:1',client:'latent',clock:1,type:'block.set',block_id:'latent',field:'attachment_id',value:item.id},replaced={...added,id:'latent:2',clock:2,value:null};
 await execute(f.auth(),s=>collab(s).apply('page',{epoch:'latent-epoch',ops:[added,replaced]},new Access(s,s.principal)));
 assert(!f.raw('page','page').blocks.some(b=>b.attachment_id===item.id));assert(![...f.provider.records.values()].filter(r=>r.kind==='version').some(r=>r.data.blocks?.some(b=>b.attachment_id===item.id)));
 assert.equal(f.raw('collaboration','page').state.history.ops['latent:1'].value,item.id);await rejected(f.files.remove(f.auth(),item.id),409);assert.equal(f.objects.size,1);
 await execute(f.auth(),s=>collab(s).apply('page',{epoch:'latent-epoch',ops:[{id:'latent:3',client:'latent',clock:3,type:'history.cancel',targets:['latent:2']}]},new Access(s,s.principal)));
 assert.equal(f.raw('page','page').blocks[0].attachment_id,item.id);const response=await f.files.download(f.auth(),item.id,req('/api/attachments/'+item.id+'/download'));assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 f.raw('page','page').blocks=[];for(const [k,row]of f.provider.records)if(['collaboration','version'].includes(row.kind))f.provider.records.delete(k);f.provider.revision++;
 assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});assert.equal(f.objects.size,0);
});
test('fallback sees only typed current, baseline, object history and files schema references',async t=>{
 const typed=[id=>['collaboration',{id:'page',state:{blocks:{old:{fields:{attachment_id:{value:id}}}}}}],id=>['collaboration',{id:'page',state:{history:{baseline:{blocks:{old:{fields:{attachment_id:{value:id}}}}},ops:{}}}}],id=>['collaboration',{id:'page',state:{history:{ops:{'client:1':{type:'block.set',field:'attachment_id',value:id}}}}}]];
 for(const make of typed){const f=await fixture(t),uploading=await upload(f,Buffer.from('typed')),item=await f.files.complete(f.auth(),uploading.id),[kind,value]=make(item.id);f.seed(kind,value);await rejected(f.files.remove(f.auth(),item.id),409);assert.equal(f.objects.size,1);}
 for(const value of [id=>id,id=>[id],id=>[{id}]]){const f=await fixture(t),uploading=await upload(f,Buffer.from('row')),item=await f.files.complete(f.auth(),uploading.id);f.seed('database',{id:'typed-db',properties:[{id:'f',type:'files'}]});f.seed('row',{id:'typed-row',database_id:'typed-db',properties:{f:value(item.id)}});await rejected(f.files.remove(f.auth(),item.id),409);}
 const f=await fixture(t),uploading=await upload(f,Buffer.from('literal')),item=await f.files.complete(f.auth(),uploading.id);f.seed('database',{id:'literal-db',properties:[{id:'attachment_id',type:'text'},{id:'f',type:'files'}]});f.seed('row',{id:'literal-row',database_id:'literal-db',properties:{attachment_id:item.id,f:'prefix'+item.id+'suffix'}});f.seed('collaboration',{id:'page',state:{metadata:{attachment_id:item.id},history:{ops:{note:{type:'text.insert',field:'attachment_id',value:item.id}}}}});f.raw('page','page').custom={attachment_id:item.id};f.provider.revision++;
 assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});assert.equal(f.objects.size,0);
});
test('fallback rejects malformed typed source containers before a mutation or physical DELETE',async t=>{
 for(const state of [{blocks:[]},{history:{ops:[]}},{blocks:{b:{fields:{attachment_id:{}}}}},{history:{ops:{bad:{type:'block.set',field:'attachment_id',value:42}}}}]){const f=await fixture(t),uploading=await upload(f,Buffer.from('malformed')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'page',state});const before=f.provider.requests.length;await rejected(f.files.remove(f.auth(),item.id),503);assert.equal(f.provider.requests.length,before);assert.equal(f.objects.size,1);assert(!f.calls.some(([method])=>method==='DELETE'));}
});
test('scalar provider deletion is metadata-only and a stale scalar cannot survive a source CAS race',async t=>{
 const f=await fixture(t),uploading=await upload(f,Buffer.from('scalar')),item=await f.files.complete(f.auth(),uploading.id);f.seed('page',{id:'large-secret',blocks:[{id:'big',text:'private'.repeat(700000)}]});let reads=0;
 f.provider.attachmentReferences=async request=>{reads++;assert.deepEqual(request,{context,attachmentId:item.id});return {...request,revision:f.provider.revision,referenced:false};};f.provider.snapshotRequests=[];
 f.provider.beforeCommit=async()=>{f.provider.beforeCommit=null;f.seed('collaboration',{id:'page',state:{history:{ops:{new:{type:'block.set',field:'attachment_id',value:item.id}}}}});};
 await rejected(f.files.remove(f.auth(),item.id),409);assert.equal(reads,1);assert(f.raw('attachment',item.id));assert.equal(f.objects.size,1);assert(!f.provider.snapshotRequests.some(r=>['page','version','collaboration','row','database'].some(kind=>r.selection.kinds.includes(kind)||(r.selection.ids[kind]??[]).length)));assert(!f.calls.some(([method])=>method==='DELETE'));
 f.provider.records.delete(key('collaboration','page'));f.provider.revision++;assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});assert.equal(reads,2);assert.equal(f.objects.size,0);
});
test('authority precedes scalar lookup and is rechecked before a positive-reference response',async t=>{
 const f=await fixture(t);let calls=0;f.provider.attachmentReferences=async request=>{calls++;return {...request,revision:f.provider.revision,referenced:true};};await rejected(f.files.remove(f.auth(),'missing-private-id'),404);assert.equal(calls,0);
 const uploading=await upload(f,Buffer.from('private')),item=await f.files.complete(f.auth(),uploading.id);f.provider.attachmentReferences=async request=>{calls++;const revision=f.provider.revision;f.provider.records.delete(key('attachment',item.id));f.provider.revision++;return {...request,revision,referenced:true};};await rejected(f.files.remove(f.auth(),item.id),404);assert.equal(calls,1);assert.equal(f.objects.size,1);assert(!f.calls.some(([method])=>method==='DELETE'));
});
test('current-schema row fallback handles absent, empty and prototype-named fields without inferring unrelated JSON',async t=>{
 for(const properties of [undefined,{},JSON.parse('{"__proto__":""}')]){const f=await fixture(t),uploading=await upload(f,Buffer.from('no row reference')),item=await f.files.complete(f.auth(),uploading.id);f.seed('database',{id:'schema-db',properties:[{id:'__proto__',type:'files'}]});f.seed('row',{id:'schema-row',database_id:'schema-db',...(properties===undefined?{}:{properties})});assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});}
 const f=await fixture(t),uploading=await upload(f,Buffer.from('prototype ref')),item=await f.files.complete(f.auth(),uploading.id);f.seed('database',{id:'schema-db',properties:[{id:'__proto__',type:'files'}]});f.seed('row',{id:'schema-row',database_id:'schema-db',properties:JSON.parse('{"__proto__":'+JSON.stringify(item.id)+'}')});await rejected(f.files.remove(f.auth(),item.id),409);
});
test('malformed row/database reference sources fail closed rather than delete a possible file',async t=>{
 for(const shape of ['missing-db','missing-schema','null-schema','bad-property','missing-property-type','null-properties','bad-files','bad-entry','null-entry','missing-entry-id']){const f=await fixture(t),uploading=await upload(f,Buffer.from(shape)),item=await f.files.complete(f.auth(),uploading.id);if(shape!=='missing-db')f.seed('database',{id:'source-db',...(shape==='missing-schema'?{}:{properties:shape==='null-schema'?null:shape==='bad-property'?[{id:3,type:'files'}]:shape==='missing-property-type'?[{id:'f'}]:[{id:'f',type:'files'}]})});f.seed('row',{id:'source-row',database_id:'source-db',properties:shape==='null-properties'?null:{f:shape==='bad-files'?{}:shape==='bad-entry'?[{id:3}]:shape==='null-entry'?[null]:shape==='missing-entry-id'?[{}]:[]}});const prior=f.provider.requests.length;await rejected(f.files.remove(f.auth(),item.id),503);assert.equal(f.provider.requests.length,prior);assert.equal(f.objects.size,1);assert(!f.calls.some(([method])=>method==='DELETE'));}
});
test('scalar lookup supports160-scalar logical IDs while preserving the separate physical object identity',async t=>{
 const f=await fixture(t),bytes=Buffer.from('opaque attachment bytes'),uploading=await upload(f,bytes);await f.files.complete(f.auth(),uploading.id);const id='문😀'.repeat(80),file=clone(f.raw('attachment',uploading.id));f.provider.records.delete(key('attachment',uploading.id));f.seed('attachment',{...file,id,storage_id:uploading.id});let refs=true,count=0;
 f.provider.attachmentReferences=async request=>{count++;assert.equal(request.attachmentId,id);return {...request,revision:f.provider.revision,referenced:refs};};await rejected(f.files.remove(f.auth(),id),409);assert.equal(f.objects.size,1);refs=false;assert.deepEqual(await f.files.remove(f.auth(),id),{deleted:true});assert.equal(count,2);assert.equal(f.objects.size,0);
});
test('scalar positive answers cannot bypass a fresh attachment edit-authority denial',async t=>{
 const f=await fixture(t),uploading=await upload(f,Buffer.from('revoked')),item=await f.files.complete(f.auth(),uploading.id);let reads=0;f.provider.attachmentReferences=async request=>{reads++;const revision=f.provider.revision;f.raw('member','alice').role='member';f.raw('attachment',item.id).owner_id='bob';f.provider.revision++;return {...request,revision,referenced:true};};await assert.rejects(f.files.remove(f.auth(),item.id),error=>error.status===403&&!error.message.includes('referenced'));assert.equal(reads,1);assert.equal(f.objects.size,1);assert(!f.calls.some(([method])=>method==='DELETE'));
});
test('optional scalar failures and malformed DTOs never expose raw provider diagnostics or mutate bytes',async t=>{
 for(const bad of ['throw','typed-throw','shape']){const f=await fixture(t),uploading=await upload(f,Buffer.from('diagnostic-safe')),item=await f.files.complete(f.auth(),uploading.id);f.provider.attachmentReferences=async request=>{if(bad==='throw')throw Error(serviceKey);if(bad==='typed-throw')throw new StoreError(503,'PRIVATE_DIAGNOSTIC',serviceKey);return {...request,revision:f.provider.revision,referenced:false,diagnostic:serviceKey};};await rejected(f.files.remove(f.auth(),item.id),503);assert(f.raw('attachment',item.id));assert.equal(f.objects.size,1);assert(!f.calls.some(([method])=>method==='DELETE'));}
});
test('scalar result remains outside domain/uncertain-ack retries and deletion uses the original receipt',async t=>{
 const f=await fixture(t),uploading=await upload(f,Buffer.from('same receipt')),item=await f.files.complete(f.auth(),uploading.id);let reads=0;f.provider.attachmentReferences=async request=>{reads++;return {...request,revision:f.provider.revision,referenced:false};};const before=f.provider.requests.length;f.provider.failAfterAck=true;assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});assert.equal(reads,1);const attempts=f.provider.requests.slice(before,before+2);assert.equal(attempts.length,2);assert.equal(attempts[0].transactionId,attempts[1].transactionId);assert.equal(attempts[0].digest,attempts[1].digest);assert.equal(f.calls.filter(([method])=>method==='DELETE').length,1);assert.equal(f.objects.size,0);
});
test('legacy missing CRDT containers are allowed while explicit malformed containers fail closed',async t=>{
 for(const document of [{},{state:{}},{state:{history:{}}},{state:{blocks:{b:{}}}}]){const f=await fixture(t),uploading=await upload(f,Buffer.from('legacy')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'minimal',...document});assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});}
 for(const document of [{state:null},{state:{history:null}},{state:{history:{baseline:null}}},{state:{blocks:null}},{state:{blocks:{b:null}}},{state:{blocks:{b:{fields:null}}}},{state:{blocks:{b:{fields:{attachment_id:null}}}}},{state:{history:{ops:null}}},{state:{history:{ops:{bad:'text'}}}}]){const f=await fixture(t),uploading=await upload(f,Buffer.from('malformed container')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'malformed',...document});await rejected(f.files.remove(f.auth(),item.id),503);assert.equal(f.objects.size,1);}
});
test('invalid typed reference IDs fail closed including schema IDs without rejecting normal Unicode',async t=>{
 for(const bad of [' ', '\n\t', 'bad\0id', '\ud800']){const f=await fixture(t),uploading=await upload(f,Buffer.from('invalid ref')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'page',state:{history:{ops:{bad:{type:'block.set',field:'attachment_id',value:bad}}}}});await rejected(f.files.remove(f.auth(),item.id),503);assert.equal(f.objects.size,1);}
 const f=await fixture(t),uploading=await upload(f,Buffer.from('invalid schema id')),item=await f.files.complete(f.auth(),uploading.id);f.seed('database',{id:'schema',properties:[{id:' ',type:'files'}]});f.seed('row',{id:'row',database_id:'schema',properties:{}});await rejected(f.files.remove(f.auth(),item.id),503);assert.equal(f.objects.size,1);
});
test('fallback matches Python whitespace ID rules and does not treat FEFF as blank',async t=>{
 for(const bad of ['\u0085','\u001c','\u001d\u001e\u001f','\u00a0\u1680','\u2000\u200a','\u2028\u2029\u202f\u205f\u3000','\t\r\n \u0085']){const f=await fixture(t),uploading=await upload(f,Buffer.from('blank IDs')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'page',state:{history:{ops:{bad:{type:'block.set',field:'attachment_id',value:bad}}}}});await rejected(f.files.remove(f.auth(),item.id),503);assert.equal(f.objects.size,1);}
 const f=await fixture(t),uploading=await upload(f,Buffer.from('FEFF opaque ID')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'page',state:{history:{ops:{other:{type:'block.set',field:'attachment_id',value:'\ufeff'}}}}});assert.deepEqual(await f.files.remove(f.auth(),item.id),{deleted:true});
});
test('actual createStoreProvider factory feeds Files the bounded scalar without loading document or CRDT bodies',async t=>{
 const f=await fixture(t),uploading=await upload(f,Buffer.from('factory bytes')),item=await f.files.complete(f.auth(),uploading.id);f.seed('collaboration',{id:'page',state:{private_text:'large-secret'.repeat(400000),history:{ops:{latent:{type:'block.set',field:'attachment_id',value:item.id}}}}});let referenced=true,scalarCalls=0;const calls=[];
 const provider=createStoreProvider({supabaseUrl:'https://fixture.invalid',serviceKey,fetch:async(url,init)=>{assert.equal(init.headers.apikey,serviceKey);const input=JSON.parse(init.body),name=new URL(url).pathname.split('/').at(-1);calls.push({name,selection:input.p_selection});if(name==='fountain_cloud_store_attachment_references'){scalarCalls++;assert.equal(input.p_attachment_id,item.id);return Response.json({context:input.p_context,attachmentId:input.p_attachment_id,revision:f.provider.revision,referenced});}if(name==='fountain_cloud_store_snapshot')return Response.json(await f.provider.snapshot({context:input.p_context,selection:input.p_selection,cursor:input.p_cursor,expectedRevision:input.p_expected_revision??undefined}));if(name==='fountain_cloud_store_commit')return Response.json(await f.provider.commit({context:input.p_context,expectedRevision:input.p_expected_revision,transactionId:input.p_transaction_id,digest:input.p_digest,canonical:input.p_canonical,changes:input.p_changes}));throw Error('Unexpected fixed RPC path');}});
 const files=createFiles({provider,storage:f.storage,authorize:async()=>f.auth(),clock:options.clock,fenceGarbage:f.fenceGarbage});await rejected(files.remove(f.auth(),item.id),409);assert.equal(f.objects.size,1);f.raw('collaboration','page').state.history.ops={};f.provider.revision++;referenced=false;assert.deepEqual(await files.remove(f.auth(),item.id),{deleted:true});assert.equal(scalarCalls,2);assert.equal(f.objects.size,0);assert(!calls.some(call=>['page','version','collaboration','row','database'].some(kind=>call.selection?.kinds.includes(kind)||(call.selection?.ids[kind]??[]).length)));
});
