// Real loopback HTTP + WebCrypto/binary tests. No actual Supabase bucket, SQL,
// Deno deployment, quota reservation, or 5GB transfer is claimed by this suite.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {createStorage,IncrementalSHA256,StorageError,CHUNK_SIZE,READ_SIZE,MAX_FILE_SIZE,checkQuota,byteRange} from '../functions/_shared/storage.ts';
import {APIError} from '../functions/_shared/access.ts';
const key='sb_secret_fixture_storage_key_never_public',bucket='fountain-private';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const allow=()=>{};
let server,origin;
const provider={objects:new Map(),calls:[],public:false,limit:50_000_000,uploadStatus:200,readMode:null,loseACK:false};
function reset(){provider.objects.clear();provider.calls=[];provider.public=false;provider.limit=50_000_000;provider.uploadStatus=200;provider.readMode=null;provider.loseACK=false;return createStorage({supabaseUrl:origin,serviceKey:key,bucket,workspaceId:'family-한글',maxObjectBytes:50_000_000});}
function json(response,status,value){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));}
before(async()=>{
  server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.apikey,key);assert.equal(req.headers.authorization,undefined);
      const path=new URL(req.url,origin).pathname;provider.calls.push([req.method,path]);
      assert(!req.url.includes(key));
      if(path==='/storage/v1/bucket/'+bucket){json(res,200,{id:bucket,public:provider.public,file_size_limit:provider.limit,allowed_mime_types:['application/octet-stream']});return;}
      const authenticated='/storage/v1/object/authenticated/'+bucket+'/',upload='/storage/v1/object/'+bucket+'/';
      if(req.method==='GET'&&path.startsWith(authenticated)){
        const id=path.slice(authenticated.length),stored=provider.objects.get(id);if(!stored){json(res,404,{message:'private provider diagnostic '+key});return;}
        if(provider.readMode==='redirect'){res.writeHead(302,{Location:origin+'/must-not-follow'});res.end();return;}
        const bytes=Buffer.from(stored);
        if(provider.readMode==='corrupt')bytes[0]^=1;
        if(provider.readMode==='truncated'){res.writeHead(200,{'Content-Length':String(bytes.length)});res.write(bytes.subarray(0,Math.max(0,bytes.length-1)));res.socket.destroy();return;}
        if(provider.readMode==='extra'){res.writeHead(200);res.end(Buffer.concat([bytes,Buffer.from([1])]));return;}
        res.writeHead(200,{'Content-Length':String(bytes.length),'Content-Type':'application/octet-stream'});res.end(bytes);return;
      }
      if(req.method==='POST'&&path.startsWith(upload)){
        assert.equal(req.headers['x-upsert'],'false');assert.equal(req.headers['content-type'],'application/octet-stream');
        let size=0;const pieces=[];for await(const bytes of req){size+=bytes.length;if(size>CHUNK_SIZE)throw Error('request exceeded chunk bound');pieces.push(bytes);}
        if(provider.uploadStatus!==200){json(res,provider.uploadStatus,{message:'private password and service key '+key});return;}
        const id=path.slice(upload.length);if(provider.objects.has(id)){json(res,400,{error:'Duplicate',message:'Asset Already Exists'});return;}
        provider.objects.set(id,Buffer.concat(pieces));if(provider.loseACK){provider.loseACK=false;req.socket.destroy();return;}
        json(res,200,{Key:bucket+'/'+id});return;
      }
      if(req.method==='DELETE'&&path==='/storage/v1/object/'+bucket){let raw='';for await(const bytes of req)raw+=bytes;const body=JSON.parse(raw);for(const id of body.prefixes)provider.objects.delete(id);json(res,200,[]);return;}
      json(res,404,{message:'unhandled fixture'});
    }catch{if(!res.headersSent)json(res,500,{message:'fixture failure'});else res.destroy();}
  });server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server.closeAllConnections();server.close();await once(server,'close');});
async function attachment(storage,size=CHUNK_SIZE+131071){const bytes=Buffer.alloc(size);for(let i=0;i<size;i++)bytes[i]=(i*37+17)%256;const chunks=[];for(let i=0;i<size;i+=CHUNK_SIZE)chunks.push(await storage.writeChunk('file-one',i,bytes.subarray(i,i+CHUNK_SIZE),allow));return {bytes,manifest:{id:'file-one',name:'가족 원본 🏠.bin',size,sha256:sha(bytes),chunks}};}
const reject=(action,status,code)=>assert.rejects(action,e=>e instanceof StorageError&&e.status===status&&(!code||e.code===code)&&!e.message.includes(key)&&!e.message.includes('password'));

test('incremental SHA256 binary vectors and private checkpoint resumption match independent Node hash',()=>{
  for(const size of [0,1,55,56,63,64,65,127,128,129,4097,1048576]){
    const bytes=randomBytes(size),hash=new IncrementalSHA256();let i=0;for(;i<Math.floor(size/2);i+=37)hash.update(bytes.subarray(i,Math.min(i+37,Math.floor(size/2))));
    const checkpoint=hash.state(),copy=new IncrementalSHA256(checkpoint);copy.update(bytes.subarray(Math.floor(size/2)));assert.equal(copy.hex(),sha(bytes));
    checkpoint.words[0]=0;assert.notEqual(hash.state().words[0],0);
  }
  assert.throws(()=>new IncrementalSHA256({words:Array(8).fill(-1),bytes:0,tail:''}),StorageError);
  assert.throws(()=>new IncrementalSHA256({words:Array(8).fill(0),bytes:1,tail:''}),StorageError);
});
test('private bucket upload produces only SHA/offset metadata; duplicates and lost upload ACK verify exact bytes',async()=>{
  const storage=reset(),bytes=randomBytes(65537);const first=await storage.writeChunk('file',0,bytes,allow);
  assert.equal(first.sha256,sha(bytes));assert.equal(first.size,bytes.length);assert.deepEqual(Object.keys(first).sort(),['version','attachmentId','offset','size','sha256'].sort());
  assert.deepEqual(await storage.writeChunk('file',0,bytes,allow),first);assert.equal(provider.objects.size,1);
  provider.loseACK=true;const second=await storage.writeChunk('other',0,bytes,allow);assert.equal(second.sha256,first.sha256);assert.equal(provider.objects.size,2);
  assert.deepEqual(Buffer.from(await storage.readChunk(first,allow)),bytes);assert(!JSON.stringify(first).includes(key));assert(!JSON.stringify(first).includes(origin));
});
test('input data and manifests are pinned before async boundaries',async()=>{
  const storage=reset(),bytes=Buffer.from([0,1,2,3]);let release,entered;const waiting=new Promise(r=>{entered=r;}),gate=async()=>{entered();await new Promise(r=>{release=r;});};
  let first=true;const pending=storage.writeChunk('file',0,bytes,()=>{if(first){first=false;return gate();}});await waiting;bytes.fill(9);release();const item=await pending;assert.equal(item.sha256,sha(Buffer.from([0,1,2,3])));
  const original={id:'file',name:'private.bin',size:4,chunks:[item]},response=await storage.download(original,allow);original.chunks[0].attachmentId='unrelated';original.name='changed';assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from([0,1,2,3]));
});
test('multi-chunk full-file SHA verification resumes only against identical private layout and rejects changed bytes',async()=>{
  const storage=reset(),{bytes,manifest}=await attachment(storage);
  const first=await storage.verify(manifest,allow,{maxChunks:1});assert.equal(first.completed,false);assert.equal(first.verifiedOffset,CHUNK_SIZE);assert.equal(first.sha256,undefined);
  const reordered=structuredClone(manifest);reordered.chunks=reordered.chunks.map(c=>Object.fromEntries(Object.entries(c).reverse()));
  const done=await storage.verify(reordered,allow,{checkpoint:first.checkpoint,maxChunks:1});assert.equal(done.completed,true);assert.equal(done.sha256,sha(bytes));assert.equal(done.verifiedOffset,bytes.length);
  const changed=structuredClone(manifest);changed.chunks[0].sha256='f'.repeat(64);await reject(()=>storage.verify(changed,allow,{checkpoint:first.checkpoint}),400);
  provider.readMode='corrupt';await reject(()=>storage.verify(manifest,allow),409,'STORAGE_HASH_MISMATCH');
});
test('HTTP byte ranges span chunk boundaries exactly, emit <=64KiB, HEAD and 416 read no object bytes',async()=>{
  const storage=reset(),{bytes,manifest}=await attachment(storage),start=CHUNK_SIZE-17,end=CHUNK_SIZE+100001;
  const response=await storage.download(manifest,allow,{range:`bytes=${start}-${end-1}`});assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),`bytes ${start}-${end-1}/${bytes.length}`);assert.equal(response.headers.get('Content-Length'),String(end-start));
  const parts=[];for await(const part of response.body){assert(part.length<=READ_SIZE);parts.push(part);}assert.deepEqual(Buffer.concat(parts),bytes.subarray(start,end));
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Disposition'),/filename\*=UTF-8''/);assert(![...response.headers.values()].join('').includes(key));
  const objectCalls=()=>provider.calls.filter(([method,path])=>method==='GET'&&path.includes('/object/')).length,prior=objectCalls();
  const head=await storage.download(manifest,allow,{method:'HEAD',range:'bytes=0-0'});assert.equal(head.status,200);assert.equal(head.body,null);assert.equal(head.headers.get('Content-Length'),String(bytes.length));
  const invalid=await storage.download(manifest,allow,{range:'bytes=0-1,3-4'});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('Content-Range'),'bytes */'+bytes.length);assert.equal(objectCalls(),prior);
  const full=await storage.download(manifest,allow,{range:'bytes=0-1',ifRange:'"changed"'});assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  const suffix=await storage.download(manifest,allow,{range:'bytes=-29'});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),bytes.subarray(-29));
});
test('authorization is rechecked before each public byte piece; revoked streams fail instead of succeeding truncated',async()=>{
  const storage=reset(),{manifest}=await attachment(storage,READ_SIZE*3);let active=true;
  const response=await storage.download(manifest,()=>{if(!active)throw new APIError(403,'Permission changed');}),reader=response.body.getReader();
  assert.equal((await reader.read()).value.length,READ_SIZE);active=false;await assert.rejects(()=>reader.read(),e=>e.status===403);assert.equal(response.headers.get('Content-Length'),String(READ_SIZE*3));
});
test('missing, corrupted, truncated, oversized and redirected provider objects never yield unverified bytes',async()=>{
  const storage=reset(),{manifest}=await attachment(storage,8193),item=manifest.chunks[0];
  for(const mode of ['corrupt','truncated','extra','redirect']){provider.readMode=mode;await assert.rejects(()=>storage.readChunk(item,allow),e=>e instanceof StorageError&&!e.message.includes(key));}
  assert(!provider.calls.some(([,path])=>path==='/must-not-follow'));provider.readMode=null;provider.objects.clear();await reject(()=>storage.readChunk(item,allow),409,'STORAGE_BYTES_MISSING');
});
test('public buckets, denied gates, object limits and provider quota errors remain explicit without secret diagnostics',async()=>{
  const storage=reset();provider.public=true;await reject(()=>storage.writeChunk('file',0,Buffer.from([1]),allow),503,'STORAGE_BUCKET_NOT_PRIVATE');assert.equal(provider.objects.size,0);
  provider.public=false;provider.limit=1;await reject(()=>storage.writeChunk('file',0,Buffer.from([1,2]),allow),413,'STORAGE_OBJECT_LIMIT');
  provider.limit=50_000_000;provider.uploadStatus=507;await reject(()=>storage.writeChunk('file',0,Buffer.from([1]),allow),507,'STORAGE_CAPACITY');
  const calls=provider.calls.length;await assert.rejects(()=>storage.writeChunk('file',0,Buffer.from([1]),()=>{throw new APIError(403,'Denied');}),e=>e.status===403);assert.equal(provider.calls.length,calls);
  assert.throws(()=>checkQuota(5_000_000_000,{limitBytes:1_000_000_000,usedBytes:0,reservedBytes:0}),e=>e.status===507);checkQuota(100,{limitBytes:1000,usedBytes:800,reservedBytes:100});
});
test('5GB metadata/HEAD stays bounded, invalid offsets/layout/ranges cannot fabricate success',async()=>{
  const storage=reset(),chunks=[];for(let offset=0;offset<MAX_FILE_SIZE;offset+=CHUNK_SIZE)chunks.push({version:1,attachmentId:'large',offset,size:Math.min(CHUNK_SIZE,MAX_FILE_SIZE-offset),sha256:'0'.repeat(64)});
  const head=await storage.download({id:'large',name:'large.bin',size:MAX_FILE_SIZE,chunks},allow,{method:'HEAD'});assert.equal(head.headers.get('Content-Length'),String(MAX_FILE_SIZE));assert.equal(provider.objects.size,0);
  await reject(()=>storage.writeChunk('file',1,Buffer.from([1]),allow),400);await reject(()=>storage.download({id:'large',name:'x',size:MAX_FILE_SIZE,chunks:chunks.slice(1)},allow),409,'STORAGE_LAYOUT');
  for(const range of ['bytes=-0','bytes=7-2','bytes=999-','bytes=0-2,3-4'])assert.throws(()=>byteRange(range,10),e=>e.status===416);
  const empty={id:'empty',name:'empty',size:0,chunks:[]},verified=await storage.verify(empty,allow);assert.equal(verified.completed,true);assert.equal(verified.sha256,sha(Buffer.alloc(0)));
});
test('physical removal requires a separate authoritative unreferenced claim and is idempotent',async()=>{
  const storage=reset(),item=await storage.writeChunk('file',0,Buffer.from([1,2,3]),allow);
  await reject(()=>storage.removeChunks([item],allow,async()=>false),409,'STORAGE_STILL_REFERENCED');assert.equal(provider.objects.size,1);
  await storage.removeChunks([item],allow,async()=>true);assert.equal(provider.objects.size,0);await storage.removeChunks([item],allow,async()=>true);assert.equal(provider.objects.size,0);
});
