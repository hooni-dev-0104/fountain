/** Actual loopback HTTP + production maintenance transport/createStorage.
 * Durable SQL/Auth/grants, leases, tombstones, resource pins and quota below are
 * explicitly a MODEL. No PostgreSQL, hosted Deno, Cron or provider QA is claimed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {createMaintenanceTransport,maintenanceErrorResponse} from '../functions/_shared/maintenance-transport.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';
import {CHUNK_SIZE} from '../functions/_shared/storage.ts';
const copy=structuredClone,secret='sb_secret_maintenance_http_fixture_only',marker='PRIVATE_MAINTENANCE_MODEL_DIAGNOSTIC';
const ticket=Buffer.alloc(32,31).toString('base64url'),sha=value=>createHash('sha256').update(value).digest('hex'),workspace='가족 空間 maintenance';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const legacy=(role='service_role')=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.fixture_signature';
const manifest=(id='upload-fixture',bytes=Buffer.from('private fixture bytes'),offset=0)=>({version:1,attachmentId:id,offset,size:bytes.length,sha256:sha(bytes)});
const pathOf=m=>'v1/'+sha(workspace)+'/'+sha(m.attachmentId)+'/'+m.offset+'-'+m.sha256;
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function deny(status=401){throw Object.assign(Error(marker+' '+secret),{status});}
class ControlModel {
 constructor({mode='delete',purpose='upload-gc',items,bytes}={}){this.mode=mode;this.purpose=purpose;this.items=copy(items??[manifest()]);this.bytes=bytes??Buffer.from('private fixture bytes');this.active=true;this.generation=1;this.resourceCurrent=true;this.pendingCurrent=mode==='observe';this.tombstoned=mode==='delete';this.invocation=null;this.receipts=new Map();this.calls=[];this.events=[];this.faults=new Map();this.transform=null;this.after=null;this.checks=0;this.effects={observed:0,done:0};this.reserved=this.items.reduce((n,m)=>n+m.size,0);this.objects=new Map(this.items.map(m=>[pathOf(m),this.bytes]));this.bucket={id:'fountain-files',public:false,file_size_limit:CHUNK_SIZE};}
 context(){return {kind:'maintenance',workspaceId:workspace,grantId:'11111111-1111-4111-8111-111111111111',grantVersion:1,purpose:this.purpose,leaseId:'22222222-2222-4222-8222-222222222222',generation:this.generation,ticketHash:sha(ticket)};}
 authorize(p){if(!this.active||canonicalJSON(p.p_context)!==canonicalJSON(this.context())||p.p_invocation_id!==this.invocation)deny();}
 apply(action,p){
  if(action==='open'){assert.deepEqual(Object.keys(p).sort(),['p_invocation_id','p_ticket_hash']);if(!this.active||p.p_ticket_hash!==sha(ticket))deny();assert.match(p.p_invocation_id,UUID);if(this.invocation&&this.invocation!==p.p_invocation_id)deny(409);this.invocation=p.p_invocation_id;return this.mode==='none'?{state:'done'}:{state:'ready',context:this.context()};}
  this.authorize(p);assert.match(p.p_transaction_id,UUID);assert.equal(sha(p.p_canonical),p.p_digest);assert.deepEqual(JSON.parse(p.p_canonical),{context:p.p_context,invocationId:p.p_invocation_id,action,payload:{}});assert.deepEqual(p.p_payload,{});
  // Crucial MODEL contract: check revalidates the CURRENT resource even when
  // the transport reuses the same transaction ID. It never replays permission.
  if(action==='check'){this.checks++;if(!this.resourceCurrent||this.effects.done||this.mode==='delete'&&!this.tombstoned||this.mode==='observe'&&!this.pendingCurrent)deny(409);return {allowed:true};}
  const old=this.receipts.get(p.p_transaction_id);if(old){assert.equal(old.canonical,p.p_canonical);assert.equal(old.digest,p.p_digest);return copy(old.reply);}
  let result;if(action==='claim'){if(!this.resourceCurrent)deny(409);result=this.mode==='empty'?{state:'done'}:{state:this.mode,manifests:copy(this.items)};}
  else if(action==='observed'){if(this.mode!=='observe'||!this.resourceCurrent||!this.pendingCurrent)deny(409);this.effects.observed++;this.pendingCurrent=false;result={state:'done'};}
  else if(action==='done'){if(this.mode!=='delete'||!this.resourceCurrent||!this.tombstoned)deny(409);this.effects.done++;this.reserved=0;result={state:'done'};}
  else deny(400);this.receipts.set(p.p_transaction_id,{canonical:p.p_canonical,digest:p.p_digest,reply:copy(result)});return result;
 }
}
async function fixture(t,{serviceKey=secret,mode,purpose,items,bytes,...config}={}){
 const model=new ControlModel({mode,purpose,items,bytes}),closed=[];let address;
 const server=http.createServer(async(req,res)=>{try{
  assert.equal(req.headers.apikey,serviceKey);assert.equal(req.headers.authorization,serviceKey.startsWith('sb_secret_')?undefined:'Bearer '+serviceKey);
  const match=/^\/rest\/v1\/rpc\/fountain_cloud_maintenance_(open|step)$/.exec(req.url);let raw='';if(req.method!=='GET')for await(const part of req)raw+=part;
  let action,payload,result;if(match){assert.equal(req.method,'POST');assert(!raw.includes(ticket));payload=JSON.parse(raw);action=match[1]==='open'?'open':payload.p_action;}
  else if(req.url==='/storage/v1/bucket/fountain-files'){assert.equal(req.method,'GET');action='bucket';}
  else if(req.url.startsWith('/storage/v1/object/authenticated/fountain-files/')){assert.equal(req.method,'GET');action='read';payload={path:req.url.slice('/storage/v1/object/authenticated/fountain-files/'.length)};}
  else if(req.url==='/storage/v1/object/fountain-files'){assert.equal(req.method,'DELETE');action='delete';payload=JSON.parse(raw);assert.deepEqual(Object.keys(payload),['prefixes']);assert.deepEqual(payload.prefixes,model.items.map(pathOf));assert(model.tombstoned&&model.resourceCurrent&&model.active,'physical delete must have a current MODEL fence');}
  else throw Error('Unexpected provider route '+req.url);
  model.calls.push({action,raw,payload:copy(payload),method:req.method});model.events.push(action);const fault=model.faults.get(action)?.shift();if(fault?.before)deny(fault.status??503);
  if(match)result=model.apply(action,payload);else if(action==='bucket')result=model.bucket;else if(action==='read'){if(!model.objects.has(payload.path)){res.writeHead(404);res.end();return;}result=model.objects.get(payload.path);}else{for(const path of payload.prefixes)model.objects.delete(path);result=[];}
  if(model.after)await model.after(action,payload,result);
  if(fault?.type==='destroy'){req.socket.destroy();return;}
  if(fault?.type==='status'){res.writeHead(fault.status??503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:marker,key:serviceKey}));return;}
  if(fault?.type==='redirect'){res.writeHead(302,{Location:address+'/never-follow?secret='+marker});res.end();return;}
  if(fault?.type==='hold-body'||fault?.type==='hold-headers'){res.on('close',()=>{closed.push(action);fault.closed?.resolve();});fault.entered?.resolve();if(fault.type==='hold-body'){res.writeHead(200,{'Content-Type':action==='read'?'application/octet-stream':'application/json'});res.write(action==='read'?Buffer.alloc(1):'{');}return;}
  res.writeHead(200,{'Content-Type':action==='read'?'application/octet-stream':'application/json',...(action==='read'?{'Content-Length':String(fault?.type==='oversized'?result.length+1:result.length)}:{})});
  if(fault?.type==='malformed')res.end('{'+marker);else if(fault?.type==='utf8')res.end(Buffer.from([0xc3,0x28]));else if(fault?.type==='oversized')res.end(action==='read'?Buffer.concat([result,Buffer.alloc(1)]):' '.repeat(32769));else if(fault?.type==='wrong-bytes')res.end(Buffer.alloc(result.length,7));else res.end(action==='read'?result:JSON.stringify(model.transform?model.transform(action,result):result));
 }catch(error){if(res.headersSent){res.destroy();return;}res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:marker,key:serviceKey}));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');address='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
 const transport=createMaintenanceTransport({supabaseUrl:address,serviceKey,...config});
 async function request({path='/functions/v1/fountain-maintenance',method='POST',body=JSON.stringify({ticket}),headers={},signal}={}){const response=await transport(new Request('https://edge.fixture.invalid'+path,{method,headers:{'Content-Type':'application/json',...headers},...(['GET','HEAD'].includes(method)?{}:{body}),...(signal?{signal}:{})}));return {status:response.status,body:await response.json(),headers:response.headers};}
 return {model,request,transport,address,closed};
}
const calls=(f,action)=>f.model.calls.filter(c=>c.action===action);
function safe(result){assert.deepEqual(Object.keys(result.body).sort(),result.status===200?['state']:['code','error']);const raw=JSON.stringify(result.body);for(const value of [ticket,sha(ticket),secret,marker,workspace,'context','manifests','grantId','leaseId','attachmentId'])assert(!raw.includes(value),value);assert.equal(result.headers.get('Cache-Control'),'no-store');}
function fault(f,action,...items){f.model.faults.set(action,items);}

test('modern service key deletes exactly 16 fixed Storage prefixes with fresh model authority and no public data',async t=>{
 const items=Array.from({length:16},(_,i)=>manifest('physical-'+i)),f=await fixture(t,{items}),result=await f.request();assert.equal(result.status,200);safe(result);assert.deepEqual(result.body,{state:'done'});assert.equal(calls(f,'delete').length,1);assert.equal(f.model.objects.size,0);assert.equal(f.model.effects.done,1);assert.equal(f.model.reserved,0);assert(f.model.checks>=5);assert.equal(calls(f,'observed').length,0);assert.equal(f.model.events[f.model.events.indexOf('delete')-1],'check');assert.equal(f.model.events.at(-1),'done');
 for(const c of calls(f,'check'))assert.equal(c.raw,calls(f,'check')[0].raw);assert(f.model.tombstoned,'MODEL tombstones persist after acknowledgement');
});
test('legacy service_role headers work, while malformed keys/configurations cannot reach a provider',async t=>{
 const f=await fixture(t,{serviceKey:legacy()});assert.equal((await f.request()).status,200);assert.equal(calls(f,'delete').length,1);
 for(const serviceKey of ['sb_publishable_private_no',legacy('anon'),legacy('authenticated'),'bad-key','sb_secret_short'])assert.throws(()=>createMaintenanceTransport({supabaseUrl:f.address,serviceKey}));
 for(const config of [{supabaseUrl:'http://remote.invalid'},{supabaseUrl:f.address+'/path'},{supabaseUrl:'https://user:password@fixture.invalid'},{timeoutMs:0},{timeoutMs:15001},{budgetMs:0},{budgetMs:125001}])assert.throws(()=>createMaintenanceTransport({supabaseUrl:f.address,serviceKey:secret,...config}));
 assert.equal(calls(f,'open').length,1);
});
test('canonical ticket, method, query, cookie/origin/auth, body and content checks reject before RPC',async t=>{
 const f=await fixture(t),cases=[[{method:'GET'},405],[{method:'DELETE'},405],[{path:'/elsewhere'},404],[{path:'/?ticket='+ticket},404],...['Cookie','Origin','Authorization'].flatMap(name=>[[{headers:{[name]:'fixture'}},403],[{headers:{[name]:''}},403]]),[{headers:{'Content-Type':'text/plain'}},415],[{headers:{'Content-Encoding':'gzip'}},415],[{headers:{'Content-Length':'257'}},413],[{headers:{'Content-Length':'no'}},400],[{headers:{'Content-Length':'1'}},400],[{body:' '.repeat(257)},413],[{body:new Uint8Array([0xc3,0x28])},400],...['{','null','[]'].map(body=>[{body},400]),...['',ticket+'=',ticket.slice(0,-1),ticket.slice(0,-1)+'B','!'.repeat(43)].map(value=>[{body:JSON.stringify({ticket:value})},400]),...[{actor:'owner'},{url:'https://evil.invalid'},{clock:123},{context:{}},{ticketHash:sha(ticket)}].map(extra=>[{body:JSON.stringify({ticket,...extra})},400])];
 for(const [options,status]of cases){const result=await f.request(options);assert.equal(result.status,status,JSON.stringify(options));safe(result);assert.equal(f.model.calls.length,0);}
});
test('three fixed entry paths accept exactly 256 bytes; an unknown canonical ticket never claims work',async t=>{
 for(const path of ['/','/fountain-maintenance','/functions/v1/fountain-maintenance']){const f=await fixture(t,{mode:'none'}),r=await f.request({path,body:JSON.stringify({ticket}).padEnd(256,' '),headers:{'Content-Length':'256'}});assert.equal(r.status,200);safe(r);assert.equal(calls(f,'claim').length,0);}
 const f=await fixture(t),r=await f.request({body:JSON.stringify({ticket:Buffer.alloc(32,32).toString('base64url')})});assert.equal(r.status,401);safe(r);assert.equal(calls(f,'claim').length,0);
});
test('exact maintenance context rejects human/automation/extra actor fields, wrong purpose and wrong ticket hash',async t=>{
 for(const patch of [{kind:'automation'},{kind:'human'},{purpose:'scim'},{purpose:'upload'},{memberId:'owner'},{authSessionId:'fake'},{tokenHash:'a'.repeat(64)},{ticketHash:'a'.repeat(64)},{generation:0},{grantVersion:0},{leaseId:'bad'}]){const f=await fixture(t);f.model.transform=(a,r)=>a==='open'?{...r,context:{...r.context,...patch}}:r;const result=await f.request();assert.equal(result.status,503);safe(result);assert.equal(calls(f,'claim').length,0);}
 for(const purpose of ['backup-gc','upload-gc']){const f=await fixture(t,{purpose,mode:'empty'});assert.equal((await f.request()).status,200);assert.equal(calls(f,'delete').length,0);}
});
test('claim validation bounds manifests, exact fields, physical identities, canonical hashes and duplicate offsets',async t=>{
 const base=manifest(),badClaims=[{state:'done',context:{}},{state:'ready',manifests:[base]},{state:'delete',manifests:[]},{state:'observe',manifests:[base,manifest('other')]},{state:'delete',manifests:Array.from({length:17},(_,i)=>manifest('p'+i))},...[[base,base],[{...base,version:2}],[{...base,attachmentId:'../bad'}],[{...base,attachmentId:'\ud800'}],[{...base,offset:1}],[{...base,size:CHUNK_SIZE+1}],[{...base,sha256:'A'.repeat(64)}],[{...base,owner:'fake'}],[{...base,offset:CHUNK_SIZE*1192,size:CHUNK_SIZE}]].map(manifests=>({state:'delete',manifests}))];
 for(const claim of badClaims){const f=await fixture(t);f.model.transform=(a,r)=>a==='claim'?claim:r;const r=await f.request();assert.equal(r.status,503);safe(r);assert.equal(calls(f,'bucket').length,0);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.effects.done,0);}
});
test('observe reads and verifies an actual 4MiB chunk through createStorage, then records observed without deleting/releasing quota',async t=>{
 const bytes=Buffer.alloc(CHUNK_SIZE,29),f=await fixture(t,{mode:'observe',bytes,items:[manifest('pending-4m',bytes)]}),reserved=f.model.reserved,r=await f.request();assert.equal(r.status,200);safe(r);assert.equal(calls(f,'read').length,1);assert.equal(f.model.effects.observed,1);assert.equal(f.model.effects.done,0);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.reserved,reserved);assert.equal(f.model.objects.size,1);assert.equal(f.model.tombstoned,false);assert.equal(f.model.events.at(-2),'check');assert.equal(f.model.events.at(-1),'observed');
});
test('wrong SHA or oversized raw Storage bytes cannot acknowledge pending publication',async t=>{
 for(const type of ['wrong-bytes','oversized']){const f=await fixture(t,{mode:'observe'}),reserved=f.model.reserved;fault(f,'read',{type});const r=await f.request();assert([409,503].includes(r.status));safe(r);assert.equal(f.model.effects.observed,0);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.reserved,reserved);}
});
test('missing quarantined bytes stay uncertain: no Storage POST/delete, observed, done or quota release',async t=>{
 const f=await fixture(t,{mode:'observe'}),reserved=f.model.reserved;f.model.objects.clear();const r=await f.request();assert.equal(r.status,409);safe(r);assert.equal(calls(f,'read').length,1);assert.equal(calls(f,'delete').length,0);assert.equal(calls(f,'observed').length,0);assert.equal(calls(f,'done').length,0);assert.equal(f.model.reserved,reserved);assert.equal(f.model.tombstoned,false);assert(!f.model.calls.some(c=>['bucket','read','delete'].includes(c.action)&&c.method==='POST'));
});
test('public/wrong/private-bucket policy and malformed bucket bodies stop all physical deletion',async t=>{
 for(const bucket of [{id:'fountain-files',public:true},{id:'other',public:false},{id:'fountain-files',public:false,allowed_mime_types:['text/plain']},{id:'fountain-files',public:false,file_size_limit:'invalid'}]){const f=await fixture(t);f.model.bucket=bucket;const r=await f.request();assert([413,503].includes(r.status));safe(r);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.effects.done,0);}
 const f=await fixture(t);fault(f,'bucket',{type:'malformed'});const r=await f.request();assert.equal(r.status,503);safe(r);assert.equal(calls(f,'delete').length,0);
});
test('check repeats the same transaction bytes but freshly rechecks a changed resource before physical DELETE',async t=>{
 for(const mode of ['delete','observe']){const f=await fixture(t,{mode});f.model.after=(a)=>{if(a==='bucket'){if(mode==='observe')f.model.pendingCurrent=false;else f.model.resourceCurrent=false;}};const r=await f.request();assert.equal(r.status,409);safe(r);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.effects.done,0);assert.equal(f.model.effects.observed,0);assert(f.model.reserved>0);const checks=calls(f,'check');assert(checks.length>=(mode==='observe'?2:4));assert(checks.every(c=>c.raw===checks[0].raw));}
});
test('revocation after private-bucket lookup blocks DELETE even with an earlier accepted check',async t=>{
 const f=await fixture(t);f.model.after=a=>{if(a==='bucket')f.model.active=false;};const r=await f.request();assert.equal(r.status,401);safe(r);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.effects.done,0);assert(f.model.reserved>0);
});
test('generation change after accepted Storage DELETE prevents stale done/quota release; tombstone remains',async t=>{
 const f=await fixture(t);f.model.after=a=>{if(a==='delete')f.model.generation++;};const r=await f.request();assert.equal(r.status,401);safe(r);assert.equal(calls(f,'delete').length,1);assert.equal(f.model.objects.size,0);assert.equal(f.model.effects.done,0);assert.equal(calls(f,'done').length,0);assert(f.model.reserved>0);assert(f.model.tombstoned);
});
test('lost accepted open/claim/observed/done ACK retries identical wire bytes and applies one modeled effect',async t=>{
 for(const action of ['open','claim','observed','done']){const f=await fixture(t,{mode:action==='observed'?'observe':'delete'});fault(f,action,{type:'destroy'});const r=await f.request();assert.equal(r.status,200,action);safe(r);const retried=calls(f,action);assert.equal(retried.length,2,action);assert.equal(retried[0].raw,retried[1].raw);assert.equal(f.model.effects.observed,action==='observed'?1:0);assert.equal(f.model.effects.done,action==='observed'?0:1);assert.equal(calls(f,'delete').length,action==='observed'?0:1);}
});
test('accepted 5xx ACK uses the exact original receipt, while malformed check permission cannot authorize DELETE',async t=>{
 const f=await fixture(t);fault(f,'done',{type:'status',status:503});const r=await f.request();assert.equal(r.status,200);safe(r);assert.equal(f.model.effects.done,1);assert.equal(calls(f,'done')[0].raw,calls(f,'done')[1].raw);
 for(const reply of [{allowed:false},{allowed:true,resource:marker},{allowed:'true'},{}]){const f=await fixture(t);f.model.transform=(a,r)=>a==='check'?reply:r;const result=await f.request();assert([409,503].includes(result.status));safe(result);assert.equal(calls(f,'delete').length,0);assert.equal(f.model.effects.done,0);}
});
test('two lost accepted ACKs terminate without restaging or another physical DELETE',async t=>{
 const f=await fixture(t);fault(f,'done',{type:'destroy'},{type:'destroy'});const r=await f.request();assert.equal(r.status,503);safe(r);assert.equal(calls(f,'done').length,2);assert.equal(calls(f,'done')[0].raw,calls(f,'done')[1].raw);assert.equal(f.model.effects.done,1);assert.equal(calls(f,'delete').length,1);assert.equal(calls(f,'claim').length,1);
});
test('RPC redirects/malformed UTF8/JSON/oversized/invalid DTO replies never publish diagnostics or reach Storage',async t=>{
 for(const type of ['redirect','malformed','utf8','oversized']){const f=await fixture(t);fault(f,'open',{type},{type});const r=await f.request();assert.equal(r.status,503);safe(r);assert.equal(calls(f,'bucket').length,0);assert.equal(f.model.calls.some(c=>c.action==='delete'),false);}
 for(const reply of [{state:'done',secret:marker},{state:'ready'},{state:'unknown'},null,[]]){const f=await fixture(t);f.model.transform=(a,r)=>a==='open'?reply:r;const result=await f.request();assert.equal(result.status,503);safe(result);assert.equal(calls(f,'claim').length,0);}
});
test('slow actual RPC bodies, caller cancellation and stalled request input obey deadlines and cancel I/O',{timeout:5000},async t=>{
 const f=await fixture(t,{budgetMs:60,timeoutMs:1000});fault(f,'open',{type:'hold-body'});let start=Date.now();const r=await f.request();assert.equal(r.status,503);safe(r);assert(Date.now()-start<1500);await new Promise(resolve=>setTimeout(resolve,20));assert(f.closed.includes('open'));
 const g=await fixture(t,{budgetMs:1000,timeoutMs:1000}),entered=deferred(),abort=new AbortController();fault(g,'open',{type:'hold-headers',entered});const task=g.request({signal:abort.signal});await entered.promise;abort.abort();const cancelled=await task;assert.equal(cancelled.status,503);safe(cancelled);assert.equal(calls(g,'claim').length,0);
 let inputCancelled=false;const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){inputCancelled=true;}});const request=new Request('https://edge.fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'});const result=await f.transport(request);assert.equal(result.status,503);assert(inputCancelled);
});
test('slow actual Storage bodies and redirects never mark publication observed or follow arbitrary object paths',{timeout:5000},async t=>{
 const f=await fixture(t,{mode:'observe',budgetMs:150,timeoutMs:1000});fault(f,'read',{type:'hold-body'});const started=Date.now(),r=await f.request();assert.equal(r.status,409);assert(Date.now()-started<1500);safe(r);assert.equal(f.model.effects.observed,0);assert.equal(calls(f,'delete').length,0);assert(f.model.reserved>0);
 const g=await fixture(t,{mode:'observe'});fault(g,'read',{type:'redirect'});const result=await g.request();assert.equal(result.status,503);safe(result);assert.equal(calls(g,'read').length,1);assert.equal(g.model.effects.observed,0);
});
test('actual entry source reads only server-owned config and caches transport; VM execution is not hosted Deno proof',async t=>{
 const source=await readFile(new URL('../functions/fountain-maintenance/index.ts',import.meta.url),'utf8'),script=stripTypeScriptTypes(source.replace(/^import [^\n]+;\n/gm,'')),f=await fixture(t,{mode:'none'});
 function entry(values){let handler;const reads=[],configs=[];vm.runInNewContext(script,{Deno:{env:{get(name){reads.push(name);return values[name];}},serve(value){handler=value;}},createMaintenanceTransport(config){configs.push(copy(config));return createMaintenanceTransport(config);},maintenanceErrorResponse});return {reads,configs,handle:request=>handler(request)};}
 const worker=entry({SUPABASE_URL:f.address,SUPABASE_SECRET_KEYS:JSON.stringify({default:secret}),SUPABASE_ANON_KEY:'public-not-authority',UNRELATED_PRIVATE_ENV:marker});
 for(let i=0;i<2;i++){const result=await worker.handle(new Request('https://edge.fixture.invalid/'));assert.equal(result.status,405);}assert.equal(worker.configs.length,1);assert.deepEqual(worker.reads,['SUPABASE_URL','SUPABASE_SECRET_KEYS']);
 const result=await worker.handle(new Request('https://edge.fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}));assert.equal(result.status,200);assert.deepEqual(await result.json(),{state:'done'});
 const old=entry({SUPABASE_URL:f.address,SUPABASE_SERVICE_ROLE_KEY:legacy()});assert.equal((await old.handle(new Request('https://edge.fixture.invalid/'))).status,405);assert(old.reads.includes('SUPABASE_SERVICE_ROLE_KEY'));
 for(const values of [{},{SUPABASE_URL:f.address,SUPABASE_SECRET_KEYS:'{'+marker},{SUPABASE_URL:f.address,SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_publishable_invalid'})}]){const w=entry(values),response=await w.handle(new Request('https://edge.fixture.invalid/'));assert.equal(response.status,503);const text=await response.text();assert(!text.includes(marker)&&!text.includes(secret));}
});
