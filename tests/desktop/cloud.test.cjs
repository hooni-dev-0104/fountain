'use strict';
// Actual Node loopback HTTP + pure transport. Not Electron, Supabase, TLS or 5GB evidence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{once}=require('node:events'),{createHash}=require('node:crypto');
const {UI_ORIGIN,isCloudServer,cloudPartitions,networkAllowed,createCloudClient}=require('../../apps/desktop/src/cloud.cjs');
const SERVER='https://abcdefghijklmnopqrst.supabase.co',PREFIX='/functions/v1/fountain-api';
const names=['account.js','workspaces.js','workspace-scope.js','app.js','backup.js','collaboration.js','index.html','mutations.js','offline.js','organization.html','organization.js','organization.css','presence.js','public.js','recovery-import.js','style.css','sw.js','transport.js','uploads.js','version-diff.js'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'fountain-cloud-test-'))),files=[];
 for(const name of names){const bytes=Buffer.from(name==='index.html'?'<main>fixture 한글</main>':'/* '+name+' */'),mime=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8';await fs.writeFile(path.join(root,name),bytes);files.push({name,mime,size:bytes.length,sha256:hash(bytes)});}
 await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({version:1,files}));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,files};
}
function req(logical='/api/echo',options={}){const request=new Request(UI_ORIGIN+logical,options);Object.defineProperty(request,'initiatorOrigin',{value:UI_ORIGIN});return request;}
async function client(t,fetcher,options={}){const {root}=await fixture(t);const c=await createCloudClient({server:SERVER,bundleRoot:root,fetch:fetcher,...options});t.after(()=>c.suspend());return c;}
async function loopback(t){const calls=[],state={handler:null},server=http.createServer(async(request,response)=>{const pieces=[];for await(const piece of request)pieces.push(piece);const body=Buffer.concat(pieces);calls.push({method:request.method,path:request.url,headers:request.headers,body});if(state.handler)return state.handler(request,response,body);response.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'fountain_session=FIXTURE_PRIVATE; HttpOnly; SameSite=Strict','Access-Control-Allow-Origin':'*'});response.end(JSON.stringify({method:request.method,bodyLength:body.length,sha256:hash(body)}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});const origin='http://127.0.0.1:'+server.address().port;
 const fetcher=(target,init)=>{assert(networkAllowed(target,SERVER));assert.equal(new URL(target).origin,SERVER);assert(new URL(target).pathname.startsWith(PREFIX+'/'));assert.equal(init.credentials,'include');assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');for(const name of ['content-length','host','transfer-encoding','connection','cookie2','keep-alive','te','trailer','upgrade'])assert.equal(init.headers.has(name),false,'Electron-forbidden header '+name);const u=new URL(target);return fetch(origin+u.pathname.slice(PREFIX.length)+u.search,init);};return {calls,state,fetcher};
}

test('cloud selector and private partition names canonicalize default ports and isolate backend origins',()=>{
 for(const server of [SERVER,SERVER+'/',SERVER+':443/',SERVER.toUpperCase()])assert(isCloudServer(server));
 for(const server of [SERVER+':8443','https://abcdefghijklmnopqrs.supabase.co','https://abcdefghijklmnopqrstu.supabase.co',SERVER+'.evil.invalid',SERVER+'/functions/v1/fountain-api','http://localhost:8787','https://127.0.0.1','https://user@abcdefghijklmnopqrst.supabase.co'])assert(!isCloudServer(server),server);
 assert.deepEqual(cloudPartitions(SERVER),cloudPartitions(SERVER+':443/'));const p=cloudPartitions(SERVER);assert.notEqual(p.frontend,p.network);assert.notEqual(p.frontend,cloudPartitions('https://01234567890123456789.supabase.co').frontend);assert(Object.isFrozen(p));
});
test('network firewall permits only fixed selected project API/public namespaces with hostile decoding denied',()=>{
 for(const tail of ['/api/session','/api/search?q=%ED%95%9C%EA%B8%80','/health','/sites/family','/forms/f-1'])assert(networkAllowed(SERVER+PREFIX+tail,SERVER));
 for(const target of [SERVER+'/auth/v1/user',SERVER+'/storage/v1/object',SERVER+'/scim/v2/Users',SERVER+PREFIX+'/scim/v2/Users',SERVER+PREFIX+'/api/x/%252e%252e/y',SERVER+PREFIX+'/api/x%252fy',SERVER+PREFIX+'/api/x?q=%250a',SERVER+PREFIX+'/api/x%255csecret',SERVER+PREFIX+'/api/x#hash','https://user@abcdefghijklmnopqrst.supabase.co'+PREFIX+'/api/session',SERVER+'.evil.invalid'+PREFIX+'/api/session',SERVER+PREFIX+'x/api/session'])assert(!networkAllowed(target,SERVER),target);
});
test('manifest hash/shape/mime/symlink validation fails before transport and bytes are pinned after construction',async t=>{
 const f=await fixture(t);let sends=0;const options={server:SERVER,bundleRoot:f.root,fetch:async()=>{sends++;return Response.json({});}};
 const c=await createCloudClient(options);c.resume();await fs.writeFile(path.join(f.root,'app.js'),'changed');assert.equal(await(await c.handle(req('/app.js'))).text(),'/* app.js */');
 await assert.rejects(createCloudClient(options));await fs.writeFile(path.join(f.root,'app.js'),'/* app.js */');const manifest=JSON.parse(await fs.readFile(path.join(f.root,'manifest.json')));manifest.files[0].mime='text/html';await fs.writeFile(path.join(f.root,'manifest.json'),JSON.stringify(manifest));await assert.rejects(createCloudClient(options));manifest.files[0].mime=f.files[0].mime;manifest.files.push(manifest.files[0]);await fs.writeFile(path.join(f.root,'manifest.json'),JSON.stringify(manifest));await assert.rejects(createCloudClient(options));manifest.files.pop();await fs.writeFile(path.join(f.root,'manifest.json'),JSON.stringify(manifest));await fs.unlink(path.join(f.root,'app.js'));await fs.symlink(path.join(f.root,'public.js'),path.join(f.root,'app.js'));await assert.rejects(createCloudClient(options));assert.equal(sends,0);
});
test('initial suspension, exact local aliases, HEAD and opaque cache queries never hit the backend',async t=>{
 let sends=0;const c=await client(t,async()=>{sends++;return Response.json({});});assert.equal((await c.handle(req('/'))).status,503);c.resume();
 for(const route of ['/','/index.html','/static/app.js','/app.js?v=%25tag','/sw.js','/organization.html','/organization.js','/organization.css']){const r=await c.handle(req(route));assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/worker-src 'self'/);await r.body.cancel();}
 assert.equal((await c.handle(req('/organization.html'))).headers.get('content-type'),'text/html; charset=utf-8');
 const head=await c.handle(req('/style.css',{method:'HEAD'}));assert.equal(head.body,null);assert.equal(head.headers.get('content-type'),'text/css; charset=utf-8');assert.equal((await c.handle(req('/sw.js'))).headers.get('service-worker-allowed'),'/');
 for(const route of ['/secret.env','/static/../secret','/__fountain_backup_stream/abc','/app.js?'+('a'.repeat(1025))])assert((await c.handle(req(route))).status>=400);assert.equal(sends,0);assert.equal(c.activeCount(),0);
});
test('initiator and hostile origin/path/method checks deny before private fetch',async t=>{
 let sends=0;const c=await client(t,async()=>{sends++;return Response.json({});});c.resume();
 for(const origin of [null,'null','https://foreign.invalid']){const r=new Request(UI_ORIGIN+'/api/echo');Object.defineProperty(r,'initiatorOrigin',{value:origin});assert.equal((await c.handle(r)).status,403);}
 assert.equal((await c.handle(new Request(UI_ORIGIN+'/api/echo',{method:'POST'}))).status,403);
 for(const route of ['/api/a%252fb','/api/x%255csecret','/api/x?x=%250d','/api/%252e%252e/secret'])assert.equal((await c.handle(req(route))).status,400);
 assert.equal((await c.handle(req('/forms/f',{method:'POST',body:'{}'}))).status,405);assert.equal((await c.handle(new Request('https://evil.invalid/api/echo'))).status,400);assert.equal(sends,0);
});
test('actual loopback JSON POST keeps UTF8/body hash, computed length, fixed headers and no caller secrets',async t=>{
 const b=await loopback(t),c=await client(t,b.fetcher);c.resume();const data=JSON.stringify({title:'가족 문서 🏠',n:7});
 const r=await c.handle(req('/api/echo?q=%25',{method:'POST',body:data,headers:{'Content-Type':'application/json','Cookie':'forbidden','Authorization':'Bearer SECRET','Origin':'https://evil.invalid','Referer':'https://evil.invalid','X-Fountain-Request':'0','Accept-Language':'ko'}}));assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('access-control-allow-origin'),null);assert.equal(r.headers.get('cache-control'),'no-store');const value=await r.json();assert.equal(value.bodyLength,Buffer.byteLength(data));assert.equal(value.sha256,hash(data));assert.equal(c.activeCount(),0);
 const sent=b.calls[0];assert.equal(sent.headers['x-fountain-request'],'1');assert.equal(sent.headers['accept-encoding'],'identity');assert.equal(sent.headers['content-length'],String(Buffer.byteLength(data)));for(const name of ['cookie','authorization','origin','referer'])assert.equal(sent.headers[name],undefined);assert.equal(sent.headers['accept-language'],'ko');
});
test('actual four MiB upload remains valid; oversize/mismatched declarations and GET bodies never publish',async t=>{
 const b=await loopback(t),c=await client(t,b.fetcher);c.resume();const bytes=Buffer.alloc(4*1024*1024,13);assert.equal((await(await c.handle(req('/api/uploads/u/chunks?offset=0',{method:'PUT',body:bytes,headers:{'Content-Type':'application/octet-stream'}}))).json()).sha256,hash(bytes));const before=b.calls.length;
 for(const [body,length]of [['x','2'],['x','bad'],['','10000001'],[Buffer.alloc(10000001),'10000001']]){const r=await c.handle(req('/api/echo',{method:'POST',body,headers:{'Content-Length':length}}));assert(r.status>=400);await r.body.cancel();}
 const fake={url:UI_ORIGIN+'/api/echo',method:'GET',initiatorOrigin:UI_ORIGIN,headers:new Headers({'Content-Length':'1'}),body:new ReadableStream({start(x){x.enqueue(new Uint8Array([1]));x.close();}})};assert((await c.handle(fake)).status>=400);assert.equal(b.calls.length,before);assert.equal(c.activeCount(),0);
});
test('only marked actual200 public HTML is restored; unsafe types/provider headers and diagnostics stay private',async t=>{
 let mode='marked';const c=await client(t,async()=>{if(mode==='error')return new Response('SERVICE_SECRET_NEVER_PUBLISH',{status:500,headers:{Location:'https://evil.invalid',Server:'private'}});return new Response('<b>public</b>',{status:mode==='marked404'?404:200,headers:{'Content-Type':mode==='plain'?'text/plain':'text/html',...(mode!=='unmarked'?{'X-Fountain-Format':'html'}:{}),'Set-Cookie':'private','Location':'https://evil.invalid','Access-Control-Allow-Origin':'*'}});});c.resume();
 for(const value of ['marked','plain','unmarked','marked404']){mode=value;const r=await c.handle(req('/sites/family'));assert.equal(r.headers.get('content-type').startsWith('text/html'),['marked','plain'].includes(value));assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('location'),null);assert.equal(r.headers.get('x-fountain-format'),null);await r.text();}
 mode='error';const error=await c.handle(req('/api/echo'));assert.equal(error.status,503);assert(!(await error.text()).includes('SERVICE_SECRET'));assert.equal(error.headers.get('server'),null);
});
test('a two MiB valid source piece streams in <=64KiB public pieces without extra pulls under backpressure',async t=>{
 const bytes=new Uint8Array(2*1024*1024).fill(7);let pulls=0;
 const c=await client(t,async()=>new Response(new ReadableStream({pull(x){pulls++;if(pulls===1)x.enqueue(bytes);else x.close();}},{highWaterMark:0}),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=x','Content-Length':String(bytes.length)}}),{requestTimeoutMs:40,streamIdleMs:40});c.resume();const r=await c.handle(req('/api/backup')),reader=r.body.getReader();const first=await reader.read();assert.equal(first.value.length,65536);await sleep(100);assert.equal(pulls,1);let count=first.value.length;for(;;){const part=await reader.read();if(part.done)break;assert(part.value.length<=65536);count+=part.value.length;}assert.equal(count,bytes.length);assert.equal(c.activeCount(),0);
});
test('truncated/oversized response length and body budgets fail streams and always release active state',async t=>{
 for(const [declared,actual]of [[2,1],[1,2]]){const c=await client(t,async()=>new Response(Buffer.alloc(actual),{headers:{'Content-Length':String(declared)}}));c.resume();const r=await c.handle(req());await assert.rejects(r.arrayBuffer());assert.equal(c.activeCount(),0);}
 const c=await client(t,async()=>new Response(Buffer.alloc(16*1024*1024+1)));c.resume();const r=await c.handle(req());await assert.rejects(r.arrayBuffer());assert.equal(c.activeCount(),0);
 const huge=await client(t,async()=>new Response(null,{headers:{'Content-Disposition':'attachment','Content-Length':'5000000001'}}));huge.resume();assert.equal((await huge.handle(req('/api/backup',{method:'HEAD'}))).status,503);assert.equal(huge.activeCount(),0);
});
test('header wait, per-read inactivity, body cancellation and suspend stop owned I/O',async t=>{
 const b=await loopback(t);b.state.handler=(_request,response)=>{setTimeout(()=>{if(!response.destroyed){response.writeHead(200);response.end('late');}},120);};const c=await client(t,b.fetcher,{requestTimeoutMs:40});c.resume();assert.equal((await c.handle(req())).status,503);assert.equal(c.activeCount(),0);
 let cancelled=0;const streaming=await client(t,async()=>new Response(new ReadableStream({cancel(){cancelled++;}})),{streamIdleMs:40});streaming.resume();const r=await streaming.handle(req());await assert.rejects(r.text());assert.equal(streaming.activeCount(),0);assert.equal(cancelled,1);
 const paused=await client(t,async()=>new Response(new ReadableStream({cancel(){cancelled++;}})));paused.resume();const pending=await paused.handle(req());paused.suspend();assert.equal(paused.activeCount(),0);await assert.rejects(pending.text());assert.equal((await paused.handle(req())).status,503);paused.resume();const again=await paused.handle(req());await again.body.cancel();assert.equal(paused.activeCount(),0);
});
test('SSE has bounded lifetime even during consumer pause; no arbitrary download total timeout',async t=>{
 let cancelled=false;const c=await client(t,async()=>new Response(new ReadableStream({start(x){x.enqueue(new TextEncoder().encode('data: {}\n\n'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'Text/Event-Stream; charset=utf-8'}}),{sseLifetimeMs:60,streamIdleMs:40});c.resume();const r=await c.handle(req('/api/pages/p/events'));const reader=r.body.getReader();assert(!(await reader.read()).done);await sleep(100);await assert.rejects(reader.read());assert(cancelled);assert.equal(c.activeCount(),0);
});
test('sixteen remote responses fill slots; seventeenth is denied and abortAll drains without disabling resume',async t=>{
 let cancelled=0;const c=await client(t,async()=>new Response(new ReadableStream({cancel(){cancelled++;}})));c.resume();const responses=await Promise.all(Array.from({length:16},()=>c.handle(req())));assert.equal(c.activeCount(),16);assert.equal((await c.handle(req())).status,429);c.abortAll();assert.equal(c.activeCount(),0);assert.equal(cancelled,16);for(const response of responses)await assert.rejects(response.text());const next=await c.handle(req());assert.equal(next.status,200);await next.body.cancel();assert.equal(c.activeCount(),0);
});
test('actual loopback range downloads preserve lengths/headers and HTTP SSE cancellation closes the provider',async t=>{
 const b=await loopback(t),data=Buffer.alloc(65536*3+9,42);let closed=0;
 b.state.handler=(request,response)=>{
  if(request.url==='/api/events'){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"ready":true}\n\n');const timer=setInterval(()=>response.write(': tick\n\n'),30);response.on('close',()=>{clearInterval(timer);closed++;});return;}
  const range=request.headers.range,bytes=range?data.subarray(10,101):data;response.writeHead(range?206:200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=x.sqlite','Content-Length':String(bytes.length),'ETag':'"known"','Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes 10-100/${data.length}`}:{})});response.end(bytes);
 };
 const c=await client(t,b.fetcher);c.resume();const range=await c.handle(req('/api/backup?job_id=fixture',{headers:{Range:'bytes=10-100','If-Range':'"known"'}}));assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 10-100/${data.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),data.subarray(10,101));
 const full=await c.handle(req('/api/attachments/file/download'));const pieces=[];for await(const part of full.body){assert(part.length<=65536);pieces.push(part);}assert.deepEqual(Buffer.concat(pieces),data);
 const events=await c.handle(req('/api/events')),reader=events.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/ready/);await reader.cancel();for(let i=0;i<50&&!closed;i++)await sleep(10);assert.equal(closed,1);assert.equal(c.activeCount(),0);
});
test('suspend during headers rejects pending work and cancels a late response even if injected fetch ignores abort',async t=>{
 let resolve,entered,cancelled=0;const waiting=new Promise(r=>entered=r);const c=await client(t,()=>{entered();return new Promise(r=>resolve=r);});c.resume();const pending=c.handle(req());await waiting;assert.equal(c.activeCount(),1);c.suspend();assert.equal((await pending).status,503);assert.equal(c.activeCount(),0);
 resolve(new Response(new ReadableStream({cancel(){cancelled++;}})));await sleep(10);assert.equal(cancelled,1);
});
test('incoming abort is supplemental, and a stalled request body is deadline bounded and cancelled',async t=>{
 let sent=0,cancelled=0;const c=await client(t,async()=>{sent++;return Response.json({});},{requestTimeoutMs:40});c.resume();
 const body=new ReadableStream({cancel(){cancelled++;}}),request=req('/api/upload',{method:'POST',body,duplex:'half'});assert.equal((await c.handle(request)).status,503);assert.equal(cancelled,1);assert.equal(sent,0);assert.equal(c.activeCount(),0);
 const abort=new AbortController();abort.abort();assert.equal((await c.handle(req('/api/echo',{signal:abort.signal}))).status,503);assert.equal(sent,0);
});
test('rejected provider responses are drained, redirects never follow, and 5GB HEAD remains metadata only',async t=>{
 let cancelled=0;const c=await client(t,async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:500}));c.resume();assert.equal((await c.handle(req())).status,503);assert.equal(cancelled,1);
 const b=await loopback(t);b.state.handler=(_req,res)=>{res.writeHead(302,{Location:'/api/forbidden-follow'});res.end();};const redirected=await client(t,b.fetcher);redirected.resume();assert.equal((await redirected.handle(req())).status,503);assert.equal(b.calls.length,1);
 const head=await client(t,async()=>new Response(null,{headers:{'Content-Disposition':'attachment','Content-Length':'5000000000'}}));head.resume();const value=await head.handle(req('/api/backup',{method:'HEAD'}));assert.equal(value.status,200);assert.equal(value.body,null);assert.equal(value.headers.get('content-length'),'5000000000');assert.equal(head.activeCount(),0);
});
test('early body rejection cancels input, and an uncooperative cancel promise never holds cleanup hostage',async t=>{
 let incomingCancelled=0;const c=await client(t,async()=>Response.json({}));c.resume();const request=req('/api/echo',{method:'POST',body:new ReadableStream({cancel(){incomingCancelled++;return new Promise(()=>{});}}),duplex:'half',headers:{'Content-Length':'10000001'}});
 assert((await c.handle(request)).status>=400);assert.equal(incomingCancelled,1);assert.equal(c.activeCount(),0);
 const provider=await client(t,async()=>new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}),{status:500}));provider.resume();const reply=await Promise.race([provider.handle(req()),sleep(200).then(()=>null)]);assert(reply,'provider cancellation cannot block safe error response');assert.equal(reply.status,503);assert.equal(provider.activeCount(),0);
});
test('conditional 304 preserves representation metadata without fabricating or requiring a body',async t=>{
 let header;const c=await client(t,async(_url,init)=>{header=init.headers.get('if-none-match');return new Response(null,{status:304,headers:{'Content-Length':'8192','ETag':'"same"'}});});c.resume();const r=await c.handle(req('/api/export',{headers:{'If-None-Match':'"same"'}}));assert.equal(r.status,304);assert.equal(r.body,null);assert.equal(r.headers.get('content-length'),'8192');assert.equal(r.headers.get('etag'),'"same"');assert.equal(header,'"same"');assert.equal(c.activeCount(),0);
});
test('actual HTTP keeps encoded Unicode/space/question/hash/percent resource IDs and printable query backslashes as data',async t=>{
 const b=await loopback(t),id='가족 문서?#%',logical='/api/pages/'+encodeURIComponent(id),term='C:\\Users\\가족';
 b.state.handler=(request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({exactResource:request.url===logical,exactQuery:request.url==='/api/search?q='+encodeURIComponent(term)}));};
 const c=await client(t,b.fetcher);c.resume();assert(networkAllowed(SERVER+PREFIX+logical,SERVER));const page=await c.handle(req(logical));assert.equal(page.status,200);assert.equal((await page.json()).exactResource,true);
 const search=await c.handle(req('/api/search?q='+encodeURIComponent(term)));assert.equal(search.status,200);assert.equal((await search.json()).exactQuery,true);
 assert(networkAllowed(SERVER+PREFIX+'/api/search?q=%255c',SERVER));
 for(const bad of ['/api/x%252fy','/api/x%255csecret','/api/%252e%252e/x','/api/search?q=%2500','/api/search?q=%257f','/api/search?q=C:\\Users','/api/x#raw'])assert(!networkAllowed(SERVER+PREFIX+bad,SERVER),bad);
});
test('SPA boot/reload and exact asset navigation fragments serve local bytes, never backend fragments',async t=>{
 let sends=0;const c=await client(t,async()=>{sends++;return Response.json({});});c.resume();
 const index=await(await c.handle(req('/'))).text();
 for(const tail of ['/#home','/#page/%EA%B0%80%EC%A1%B1','/index.html#home']){const r=await c.handle(new Request(UI_ORIGIN+tail));assert.equal(r.status,200);assert.equal(await r.text(),index);}
 assert.equal(await(await c.handle(req('/app.js#app'))).text(),'/* app.js */');assert.equal((await c.handle(req('/static/style.css#section',{method:'HEAD'}))).body,null);
 for(const tail of ['/api/session#home','/sites/family#home','/forms/f#x','/health#ready'])assert.equal((await c.handle(req(tail))).status,400);
 assert.equal((await c.handle(new Request('https://evil.invalid/#home'))).status,400);
 assert(!networkAllowed(SERVER+PREFIX+'/api/session#home',SERVER));assert.equal(sends,0);
});
test('actual HTTP preserves bounded exact public API quota507 and configured-error503 DTOs',async t=>{
 const b=await loopback(t);let value={error:'첨부 저장 용량이 부족합니다. 원본 파일은 유지됩니다.'},status=507;
 b.state.handler=(_request,response)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Set-Cookie':'private-provider-cookie','X-Provider-Secret':'hidden'});response.end(JSON.stringify(value));};
 const c=await client(t,b.fetcher);c.resume();
 for(const sample of [{status:507,value},{status:503,value:{error:'AI 서비스가 아직 설정되지 않았습니다.',code:'AI_NOT_CONFIGURED'}},{status:500,value:{error:'The backend could not complete this request.',code:'INTERNAL_ERROR'}}]){
  ({status,value}=sample);const r=await c.handle(req('/api/ai/ask',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}));assert.equal(r.status,status);assert.deepEqual(await r.json(),value);assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('x-provider-secret'),null);assert.equal(c.activeCount(),0);
 }
});
test('5xx recognition refuses unknown/malformed/oversized/non-JSON bodies and non-API/HEAD routes',async t=>{
 let selected;const c=await client(t,async()=>new Response(selected.body,{status:selected.status??507,headers:{'Content-Type':selected.type??'application/json',...(selected.headers??{})}}));c.resume();
 const samples=[
  {body:'{"error":"safe","diagnostics":"PROVIDER_SECRET"}'},
  {body:'{"code":"INTERNAL_ERROR","message":"PROVIDER_SECRET"}'},
  {body:'{"error":{"private":"PROVIDER_SECRET"}}'},
  {body:'{"error":"safe","code":"unsafe code"}'},
  {body:'{"error":"safe","code":null}'},
  {body:JSON.stringify({error:'x'.repeat(2049)})},
  {body:JSON.stringify({error:'x'.repeat(5000)})},
  {body:'{"error":"safe"'}, {body:'["PROVIDER_SECRET"]'},
  {body:Buffer.from([255,254,253])},
  {body:'{"error":"safe"}',headers:{'Content-Length':'100'}},
  {body:'<html>PROVIDER_SECRET</html>',type:'text/html'},
  {body:'{"error":"safe"}',type:'text/plain'},
 ];
 for(const sample of samples){selected=sample;const r=await c.handle(req('/api/ai/ask'));assert.equal(r.status,503);const body=await r.json();assert.equal(body.code,'CLOUD_TRANSPORT_UNAVAILABLE');assert(!JSON.stringify(body).includes('PROVIDER_SECRET'));assert.equal(c.activeCount(),0);}
 selected={body:'{"error":"safe"}'};for(const [route,method]of [['/sites/family','GET'],['/health','GET'],['/api/ai/ask','HEAD']]){const r=await c.handle(req(route,{method}));assert.equal(r.status,503);assert.equal((await r.json()).code,'CLOUD_TRANSPORT_UNAVAILABLE');}
 selected={body:'{"error":"PROVIDER_SECRET","error":"공개 오류"}'};const rebuilt=await c.handle(req());assert.equal(rebuilt.status,507);assert.deepEqual(await rebuilt.json(),{error:'공개 오류'});
});
test('public5xx body reads remain bounded by deadline and abort, with no retained active I/O',async t=>{
 let cancelled=0;const c=await client(t,async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:507,headers:{'Content-Type':'application/json'}}),{requestTimeoutMs:40});c.resume();assert.equal((await c.handle(req())).status,503);assert.equal(c.activeCount(),0);assert.equal(cancelled,1);
 let reading;const ready=new Promise(r=>reading=r);const suspended=await client(t,async()=>new Response(new ReadableStream({pull(){reading();},cancel(){cancelled++;}},{highWaterMark:0}),{status:503,headers:{'Content-Type':'application/json'}}));suspended.resume();const pending=suspended.handle(req());await ready;suspended.suspend();assert.equal((await pending).status,503);assert.equal(suspended.activeCount(),0);assert.equal(cancelled,2);
});

test('scoped workspace addresses preserve exact child route and private HTML while aliases fail before network',async t=>{
 const seen=[],binding='a'.repeat(32),prefix='/api/w/family_A/'+binding;
 const c=await client(t,async(url,init)=>{seen.push([url,init]);if(url.endsWith('/backup'))return new Response(null,{headers:{'Content-Type':'application/octet-stream','Content-Length':'5000000000'}});return new Response('private document',{headers:{'Content-Type':'text/plain','X-Fountain-Format':'html','Set-Cookie':'private'}});});c.resume();
 for(const route of [prefix+'/pages/'+encodeURIComponent('한글 ?#%'),'/api/account/session']){
  const result=await c.handle(req(route));assert.equal(result.status,200);await result.text();assert.equal(seen.at(-1)[0],SERVER+'/functions/v1/fountain-api'+route);
 }
 for(const route of [prefix+'/sites/family',prefix+'/forms/input']){const result=await c.handle(req(route));assert.equal(result.headers.get('content-type'),'text/html; charset=utf-8');assert.equal(result.headers.get('set-cookie'),null);await result.text();}
 const backup=await c.handle(req(prefix+'/backup',{method:'HEAD'}));assert.equal(backup.status,200);assert.equal(backup.headers.get('content-length'),'5000000000');
 const before=seen.length;
 for(const route of ['/api/w','/api/w/family_A/'+binding,'/api/w/family_A/notbinding/pages/x','/api/%77/family_A/'+binding+'/pages/x','/api/%2577/family_A/'+binding+'/pages/x',prefix+'/account/session',prefix+'/organization/session',prefix+'/%61ccount/session',prefix+'/%256frganization/session']){const result=await c.handle(req(route));assert(result.status>=400);await result.text();}
 assert.equal(seen.length,before);assert.equal(c.activeCount(),0);
});
