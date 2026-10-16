/** Actual loopback HTTP transport proofs; not PostgreSQL/Auth/ACL or hosted QA proof. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {test,after} from 'node:test';
import {createInlineAttachmentSource} from '../functions/_shared/inline-attachments.ts';
import {StoreError} from '../functions/_shared/store.ts';

const key='sb_secret_inline_fixture_not_real_000',workspace='inline-transport-fixture';
const context={workspaceId:workspace,memberId:'local',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceDigest=digest('independent PostgreSQL source-row fixture');
const original=Buffer.from(Uint8Array.from({length:65536+117},(_,i)=>(i*31+i%113)&255));
let content=original,expectedKey=key,behavior=null;const requests=[],protocolErrors=[];
const metadata=()=>({id:'qa-inline',owner_id:'local',page_id:'qa-page',name:'가족🙂.bin',mime:'application/octet-stream',size:content.length});
const input=(overrides={})=>({context:structuredClone(context),attachmentId:'qa-inline',metadata:metadata(),offset:0,length:0,sourceDigest:null,...overrides});
const dto=body=>({workspaceId:workspace,attachmentId:body.p_attachment_id,offset:body.p_offset,size:content.length,sha256:digest(content),sourceDigest,bytesBase64:content.subarray(body.p_offset,body.p_offset+body.p_length).toString('base64')});
function answer(res,value,status=200,headers={}){res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(value));}
const server=http.createServer(async(req,res)=>{
 try{
  const pieces=[];for await(const part of req)pieces.push(part);const raw=Buffer.concat(pieces),body=JSON.parse(raw);requests.push({body,headers:req.headers,rawBytes:raw.length});
  assert.equal(req.url,'/rest/v1/rpc/fountain_cloud_inline_attachment_range');assert.equal(req.method,'POST');assert.equal(req.headers.apikey,expectedKey);
  assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.origin,undefined);
  assert.equal(req.headers.authorization,expectedKey.startsWith('sb_secret_')?undefined:'Bearer '+expectedKey);
  assert.deepEqual(Object.keys(body).sort(),['p_attachment_id','p_context','p_expected','p_length','p_offset','p_source_digest']);
  assert.equal(body.p_context.workspaceId,workspace);assert.equal(body.p_attachment_id,body.p_expected.id);assert(!Object.hasOwn(body.p_expected,'data'));assert(raw.length<70*1024);
  if(behavior)return await behavior(body,req,res);
  answer(res,dto(body),200,{'Set-Cookie':'provider_cookie_never_public=private','Authorization':'provider_header_never_public'});
 }catch(error){protocolErrors.push(error);answer(res,{},500);}
});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.deepEqual(protocolErrors,[]);});
const source=(config={})=>createInlineAttachmentSource({supabaseUrl:origin,serviceKey:key,workspaceId:workspace,...config});
async function rejects(promise,status){await assert.rejects(promise,error=>error instanceof StoreError&&error.status===status&&!String(error).includes(key)&&!String(error).includes('PRIVATE_DIAGNOSTIC')&&!JSON.stringify(error).includes('provider_cookie'));}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition){for(let i=0;i<100;i++){if(condition())return;await delay(10);}throw Error('Loopback cancellation was not observed');}
function reset(){content=original;behavior=null;expectedKey=key;}

test('preflight and 64KiB+117 reassembly use exact fresh HTTP requests and independent full SHA',async()=>{
 reset();const provider=source(),start=requests.length,base=input();const before=await provider.read(base);
 assert.deepEqual(Object.keys(before).sort(),['bytes','offset','sha256','size','sourceDigest']);assert.equal(before.size,original.length);assert.equal(before.bytes.length,0);assert.equal(before.sha256,digest(original));assert.equal(before.sourceDigest,sourceDigest);
 const first=await provider.read(input({length:65536,sourceDigest})),last=await provider.read(input({offset:65536,length:117,sourceDigest}));
 const joined=Buffer.concat([first.bytes,last.bytes]);assert.deepEqual(joined,original);assert.equal(digest(joined),before.sha256);assert.equal(requests.length,start+3);
 assert.deepEqual(requests.at(-1).body,inputToRPC(input({offset:65536,length:117,sourceDigest})));
 first.bytes.fill(0);const fresh=await provider.read(input({length:1,sourceDigest}));assert.equal(fresh.bytes[0],original[0]);assert.equal(requests.length,start+4);
 const end=await provider.read(input({offset:original.length,length:0,sourceDigest}));assert.equal(end.offset,original.length);assert.equal(end.bytes.length,0);
});
function inputToRPC(i){return{p_context:i.context,p_attachment_id:i.attachmentId,p_expected:i.metadata,p_offset:i.offset,p_length:i.length,p_source_digest:i.sourceDigest};}

test('empty and small complete inline files validate independent whole-file hashes',async()=>{
 reset();content=Buffer.alloc(0);const empty=await source().read(input());assert.equal(empty.size,0);assert.equal(empty.sha256,digest(Buffer.alloc(0)));assert.equal(empty.bytes.length,0);
 const prefix=Buffer.from('한글🙂 inline fixture ');content=Buffer.concat([prefix,Buffer.alloc(80-prefix.length,97)]);assert.equal(content.length,80);
 const all=await source().read(input({length:content.length,sourceDigest}));assert.deepEqual(Buffer.from(all.bytes),content);assert.equal(all.sha256,digest(content));
 behavior=(body,req,res)=>answer(res,{...dto(body),sha256:'f'.repeat(64)});await rejects(source().read(input({length:content.length,sourceDigest})),409);reset();
});

test('factory config and each input are copied before I/O; returned ranges are not cached',async()=>{
 reset();const config={supabaseUrl:origin,serviceKey:key,workspaceId:workspace},provider=createInlineAttachmentSource(config),i=input({length:12,sourceDigest});
 const expected=structuredClone(i),promise=provider.read(i);i.context.workspaceId='other';i.metadata.name='mutated';i.length=0;i.sourceDigest=null;config.supabaseUrl='https://never-contact.invalid';config.workspaceId='other';config.serviceKey='different';
 const value=await promise;assert.equal(value.bytes.length,12);assert.deepEqual(requests.at(-1).body,inputToRPC(expected));
 const count=requests.length;await provider.read(input());await provider.read(input());assert.equal(requests.length,count+2);
});

test('invalid context, workspace, inline metadata, range or caller authority never reaches HTTP',async()=>{
 reset();const provider=source(),before=requests.length;
 const invalid=[
  [input({context:{...context,workspaceId:'other'}}),403],[input({context:{...context,sessionHash:'bad'}}),400],
  [input({context:{...context,kind:'scim'}}),503],[input({metadata:{...metadata(),data:''}}),400],
  [input({metadata:{...metadata(),storage_id:null}}),400],[input({metadata:{...metadata(),cloud_chunks:[]}}),400],
  [input({metadata:{...metadata(),storage:'chunks'}}),400],[input({metadata:{...metadata(),id:'other'}}),400],
  [input({metadata:{...metadata(),size:5_000_001}}),400],[input({metadata:{...metadata(),size:-1}}),400],
  [input({metadata:{...metadata(),sha256:null}}),400],[input({metadata:{...metadata(),sha256:'A'.repeat(64)}}),400],
  [input({metadata:{...metadata(),note:'x'.repeat(65536)}}),413],[input({metadata:{...metadata(),note:'🙂'.repeat(16384)}}),413],[input({metadata:{...metadata(),invalid:undefined}}),400],
  [input({offset:1}),400],[input({length:1}),400],[input({offset:-1,sourceDigest}),400],
  [input({offset:content.length,length:1,sourceDigest}),400],[input({length:65537,sourceDigest}),400],
  [input({sourceDigest:'A'.repeat(64)}),400],[input({sourceDigest:undefined}),400],[input({signal:{aborted:false}}),400],
  [input({headers:{Authorization:'caller-secret'}}),400],[input({supabaseUrl:'https://never-contact.invalid'}),400],
 ];
 for(const [i,status]of invalid)await rejects(provider.read(i),status);
 for(const storage of [null,'inline'])await provider.read(input({metadata:{...metadata(),storage}}));
 assert.equal(requests.length,before+2);
});

test('untrusted DTOs reject cross-workspace, range, metadata, digest, extra fields and noncanonical base64',async()=>{
 reset();const mutations=[v=>({...v,workspaceId:'other'}),v=>({...v,attachmentId:'other'}),v=>({...v,offset:1}),v=>({...v,size:v.size+1}),v=>({...v,sha256:'A'.repeat(64)}),v=>({...v,sourceDigest:'not-a-hash'}),v=>({...v,extra:key}),v=>{delete v.sha256;return v;},v=>({...v,bytesBase64:'AB=='}),v=>({...v,bytesBase64:'AA==\n'}),v=>({...v,bytesBase64:'AA==='}),v=>({...v,bytesBase64:'_A=='}),v=>({...v,bytesBase64:''})];
 for(const mutate of mutations){behavior=(body,req,res)=>answer(res,mutate(dto(body)));await rejects(source().read(input({length:1,sourceDigest})),503);}
 behavior=(body,req,res)=>answer(res,{...dto(body),bytesBase64:'AAB='});await rejects(source().read(input({length:2,sourceDigest})),503);
 behavior=(body,req,res)=>answer(res,{...dto(body),sourceDigest:'e'.repeat(64)});await rejects(source().read(input({length:1,sourceDigest})),409);
 behavior=(body,req,res)=>answer(res,{...dto(body),sha256:'e'.repeat(64)});await rejects(source().read(input({length:1,sourceDigest,metadata:{...metadata(),sha256:digest(content)}})),409);reset();
});

test('SQL typed denials and hostile provider errors are resource-generic and never expose diagnostics',async()=>{
 reset();for(const [code,status]of [['22023',400],['PT401',401],['PT403',403],['PT404',404],['PT409',409],['PT413',413],['PT503',503]]){
  behavior=(body,req,res)=>answer(res,{code,message:'PRIVATE_DIAGNOSTIC '+key,details:'provider_cookie'},code==='PT409'?400:status);await rejects(source().read(input()),status);
 }
 behavior=(body,req,res)=>answer(res,{code:'unknown',message:'PRIVATE_DIAGNOSTIC '+key},500);await rejects(source().read(input()),503);
 await rejects(source({fetch:async()=>{throw new StoreError(401,key,'PRIVATE_DIAGNOSTIC '+key);}}).read(input()),401);
 behavior=(body,req,res)=>answer(res,{code:'PT401',message:'PRIVATE_DIAGNOSTIC '+key},401);
 const old={...context,sessionHash:'c'.repeat(64)};const before=requests.length;await rejects(source().read(input({context:old})),401);assert.equal(requests.length,before+1);assert.deepEqual(requests.at(-1).body.p_context,old);reset();
});

test('modern secret versus legacy service-role JWT stay in fixed server-owned request headers',async()=>{
 reset();const jwt=['{"alg":"HS256"}','{"role":"service_role"}','fixture-signature'].map(v=>Buffer.from(v).toString('base64url')).join('.');expectedKey=jwt;
 await source({serviceKey:jwt}).read(input());assert.equal(requests.at(-1).headers.authorization,'Bearer '+jwt);reset();
 for(const config of [{supabaseUrl:'http://remote.invalid'},{supabaseUrl:'https://user:secret@remote.invalid'},{supabaseUrl:'https://remote.invalid/path'},{supabaseUrl:'https://remote.invalid?key=x'},{supabaseUrl:'file:///tmp/x'},{serviceKey:'sb_publishable_not_service'},{serviceKey:'sb_secret_short'},{serviceKey:key+'\r\nCookie:x'},{serviceKey:Buffer.from('{}').toString('base64url')+'.'+Buffer.from('{"role":"anon"}').toString('base64url')+'.x'},{workspaceId:''},{timeoutMs:0},{timeoutMs:30001}])assert.throws(()=>source(config),error=>error instanceof StoreError&&error.status===503&&!String(error).includes(key));
});

test('response bounds, malformed lengths and redirects fail closed and cancel actual loopback bodies',async()=>{
 reset();let closed=false;
 behavior=(body,req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});const timer=setInterval(()=>res.write(' '.repeat(8192)),1);res.on('close',()=>{clearInterval(timer);closed=true;});};
 await rejects(source().read(input()),413);await until(()=>closed);
 for(const header of ['98305','bad','-1','1']){
  behavior=(body,req,res)=>{res.writeHead(200,{'Content-Type':'application/json','Content-Length':header,'Connection':'close'});res.end(JSON.stringify(dto(body)));};
  await rejects(source().read(input()),header==='98305'?413:503);
 }
 behavior=(body,req,res)=>{res.writeHead(302,{Location:'https://never-contact.invalid/'+key});res.end();};await rejects(source().read(input()),503);reset();
});

test('pre-abort, streamed abort and deadlines cancel without publishing abort reasons',async()=>{
 reset();const pre=new AbortController();pre.abort(Error('PRIVATE_DIAGNOSTIC '+key));const count=requests.length;await rejects(source().read(input({signal:pre.signal})),503);assert.equal(requests.length,count);
 for(const mode of ['deadline-before-headers','deadline-body','caller-body']){
  let closed=false,started=false;
  behavior=(body,req,res)=>{res.on('close',()=>closed=true);if(mode!=='deadline-before-headers'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}started=true;};
  const caller=new AbortController(),begin=Date.now(),reading=source({timeoutMs:100}).read(input({signal:caller.signal}));
  if(mode==='caller-body'){await until(()=>started);caller.abort(Error('PRIVATE_DIAGNOSTIC '+key));}
  await rejects(reading,503);assert(Date.now()-begin<2000);await until(()=>closed);
 }
 let finish,cancelled=false;const begin=Date.now(),reading=source({timeoutMs:20,fetch:()=>new Promise(resolve=>finish=resolve)}).read(input());
 await rejects(reading,503);assert(Date.now()-begin<1000);finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));await until(()=>cancelled);reset();
});
