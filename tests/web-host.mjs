import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createPublicRelay,UPSTREAM,CSP} from '../apps/web/api/public-relay.mjs';
import {build,ASSETS} from '../apps/web/build.mjs';
const origin='https://preview.example.invalid',token='a'.repeat(43),enc=new TextEncoder();
const incoming=(path='/sites/family',options={})=>new Request(origin+path,options);
function protectedHeaders(response,location=null){
  for(const name of ['Cache-Control','CDN-Cache-Control','Vercel-CDN-Cache-Control'])assert.match(response.headers.get(name),/no-store/);
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Content-Security-Policy'),CSP);
  assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(response.headers.get('Location'),location);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
}
test('protected document navigation cancels 401 bytes and returns only its own relative login location',async()=>{
  for(const path of ['/sites/family','/forms/form_1','/api/public-relay?kind=forms&slug=form_1']){
    let cancelled=0,pulls=0,signal;
    const relay=createPublicRelay({timeoutMs:20,fetch:async(url,init)=>{
      assert.equal(url,UPSTREAM+(path.startsWith('/sites/')?'/sites/family':'/forms/form_1'));signal=init.signal;
      return new Response(new ReadableStream({pull(){pulls++;},cancel(){cancelled++;}},{highWaterMark:0}),{status:401,headers:{'Content-Type':'application/json','Content-Length':'1000000000','Location':'https://attacker.invalid/steal','Set-Cookie':'foreign=private','Access-Control-Allow-Origin':'*','X-Fountain-Format':'html'}});
    }});
    const logical=path.startsWith('/sites/')?'/sites/family':'/forms/form_1',location='/#open-public='+encodeURIComponent(logical);
    const response=await relay(incoming(path,{headers:{Accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8','Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate',Host:'attacker.invalid'}}));
    assert.equal(response.status,303);protectedHeaders(response,location);assert.equal(await response.text(),'');assert.equal(cancelled,1);assert.equal(pulls,0);
    assert.match(response.headers.get('Vary'),/Accept/);assert.match(response.headers.get('Vary'),/Sec-Fetch-Dest/);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(signal.aborted,false,'completed transition clears its deadline');
  }
});
test('login transition requires positive explicit HTML navigation and never changes HEAD, fetch or 403 errors',async()=>{
  const cases=[
    [401,'GET',{Accept:'text/html'},303],
    [401,'GET',{Accept:'TEXT/HTML; q=0.5','Sec-Fetch-Dest':'document'},303],
    [401,'GET',{},401],
    ...['application/json','*/*','text/*','text/html;q=0','text/html;q=0.000','text/html;q=2','text/html;q=bad','text/html;q=.5','text/html;q=0.1234','text/html;q=1;q=0','text/html, text/html;q=1','text/html-bogus'].map(Accept=>[401,'GET',{Accept},401]),
    [401,'GET',{Accept:'text/html','Sec-Fetch-Dest':'empty'},401],
    [401,'GET',{Accept:'text/html','Sec-Fetch-Dest':''},401],
    [401,'GET',{Accept:'text/html','Sec-Fetch-Dest':'iframe'},401],
    [401,'GET',{Accept:'text/html','Sec-Fetch-Mode':'cors'},401],
    [401,'GET',{Accept:'text/html','Sec-Fetch-Mode':'same-origin'},401],
    [401,'HEAD',{Accept:'text/html','Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate'},401],
    [403,'GET',{Accept:'text/html','Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate'},403],
  ];
  for(const [status,method,headers,expected]of cases){
    let cancelled=0;const relay=createPublicRelay({fetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(enc.encode('{"error":"login required"}'));controller.close();},cancel(){cancelled++;}}),{status,headers:{'Content-Type':'application/json','Location':'https://attacker.invalid','Set-Cookie':'foreign=private'}})});
    const response=await relay(incoming('/sites/family',{method,headers}));assert.equal(response.status,expected,JSON.stringify({status,method,headers}));
    protectedHeaders(response,expected===303?'/#open-public=%2Fsites%2Ffamily':null);
    assert.equal(await response.text(),expected===303||method==='HEAD'?'':'{"error":"login required"}');
    if(expected===303||method==='HEAD')assert.equal(cancelled,1);
  }
  const controller=new AbortController();let cancelled=false;
  const aborted=createPublicRelay({fetch:async()=>{controller.abort();return new Response(new ReadableStream({cancel(){cancelled=true;}},{highWaterMark:0}),{status:401});}});
  const response=await aborted(incoming('/forms/form_1',{headers:{Accept:'text/html'},signal:controller.signal}));
  assert.equal(response.status,502);protectedHeaders(response);assert(cancelled);
});
test('production entry is a Web Standard handler; fixed host, allowlisted routing and bounded header forwarding',async()=>{
  let calls=0;const relay=createPublicRelay({fetch:async(url,init)=>{
    calls++;assert.equal(url,UPSTREAM+'/forms/form_1');assert.equal(init.redirect,'manual');assert.equal(init.method,'GET');
    assert.equal(init.headers.get('Cookie'),'fountain_session='+token);assert.equal(init.headers.get('Origin'),origin);assert.equal(init.headers.get('Authorization'),null);assert.equal(init.headers.get('Host'),null);
    return new Response('<h1>Family</h1>',{headers:{'Content-Type':'text/plain','X-Fountain-Format':'html','Set-Cookie':'foreign=secret','Location':'https://malicious.invalid','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=99999'}});
  }});
  const result=await relay(incoming('/api/public-relay?kind=forms&slug=form_1',{headers:{Cookie:'unrelated=private; fountain_session='+token,Origin:origin,Authorization:'Bearer MUST_NOT_FORWARD',Host:'malicious.invalid'}}));
  assert.equal(calls,1);assert.equal(result.headers.get('Content-Type'),'text/html; charset=utf-8');protectedHeaders(result);assert.equal(await result.text(),'<h1>Family</h1>');
  const exported=(await import('../apps/web/api/public-relay.mjs')).default;assert.equal(typeof exported.fetch,'function');
});
test('malicious paths, upstream overrides, methods, duplicate routing keys and invalid headers never fetch',async()=>{
  let calls=0;const relay=createPublicRelay({fetch:async()=>{calls++;throw Error('unexpected');}});
  for(const path of ['/api/private','/sites/a/b','/sites/a%2fb','/sites/%252e%252e','/sites/a#fragment','/forms/id?url=https://evil.invalid','/api/public-relay?kind=sites&slug=x&upstream=https://evil.invalid','/api/public-relay?kind=sites&kind=forms&slug=x','/api/public-relay?kind=sites&slug=..','/api/public-relay?kind=sites&slug=https%3A%2F%2Fevil.invalid','/sites/a?kind=forms&slug=a']){
    const response=await relay(incoming(path,{headers:{Accept:'text/html','Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate'}}));assert.equal(response.status,404,path);protectedHeaders(response);
  }
  assert.equal((await relay(incoming('/sites/a',{method:'POST',body:'x'}))).status,405);
  for(const headers of [{Cookie:'fountain_session=bad'},{Cookie:'fountain_session='+token+'; fountain_session='+token},{Cookie:'other='+'a'.repeat(17000)},{Origin:'null'},{Origin:'http://remote.invalid'},{Origin:origin+'/extra'}])assert.equal((await relay(incoming('/sites/a',{headers}))).status,400);
  assert.equal(calls,0);
  for(const config of [{timeoutMs:0},{maxBytes:17*1024*1024},{fetch:null}])assert.throws(()=>createPublicRelay(config));
});
test('only an exact trusted successful HTML marker restores HTML; JSON fields and upstream mime cannot grant it',async()=>{
  for(const [status,mime,marker,expected] of [[200,'application/json','html','application/json'],[200,'text/plain',null,'text/plain'],[200,'text/html',null,'text/plain'],[200,'text/plain','HTML','text/plain'],[403,'text/plain','html','text/plain'],[200,'text/html','html','text/html']]){
    const body='{"_html":"<script>forged()</script>","html":"<h1>json</h1>"}',response=await createPublicRelay({fetch:async()=>new Response(body,{status,headers:{'Content-Type':mime,...(marker?{'X-Fountain-Format':marker}:{})}})})(incoming());
    assert.equal(response.status,status);assert.equal(response.headers.get('Content-Type').split(';')[0],expected);protectedHeaders(response);assert.equal(await response.text(),body);
  }
  const noCookie=createPublicRelay({fetch:async(_url,init)=>{assert.equal(init.headers.get('Cookie'),null);return new Response('plain',{headers:{'Content-Type':'text/plain'}});}});
  assert.equal(await (await noCookie(incoming('/sites/a',{headers:{Cookie:'unrelated=secret'}}))).text(),'plain');
});
test('redirects, network errors, declared overlimits and timeouts are generic no-store failures',async()=>{
  for(const fetch of [async()=>Response.redirect('https://evil.invalid',302),async()=>{throw Error('private provider URL secret');},async()=>new Response('x',{headers:{'Content-Length':'1000000000'}})]){
    const response=await createPublicRelay({fetch})(incoming());assert.equal(response.status,502);protectedHeaders(response);assert(!((await response.text()).includes('secret')));
  }
  let aborted=false;const timeout=createPublicRelay({timeoutMs:15,fetch:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('private'));},{once:true}))});
  assert.equal((await timeout(incoming())).status,502);assert(aborted);
});
test('HEAD cancels provider bytes; streaming honors pull/cancel and preserves bounded memory',async()=>{
  let cancelled=0,pulls=0;
  const upstream=()=>new ReadableStream({pull(c){pulls++;c.enqueue(enc.encode('piece'));},cancel(){cancelled++;}},{highWaterMark:0});
  const relay=createPublicRelay({fetch:async(_url,init)=>{assert(['GET','HEAD'].includes(init.method));return new Response(upstream(),{headers:{'Content-Type':'text/plain','X-Fountain-Format':'html'}});}});
  const head=await relay(incoming('/sites/a',{method:'HEAD'}));assert.equal(await head.text(),'');assert.equal(cancelled,1);assert.equal(pulls,0);
  const body=await relay(incoming());assert.equal(pulls,0);const reader=body.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'piece');assert.equal(pulls,1);await reader.cancel();assert.equal(cancelled,2);
});
test('midstream abort, read failure and actual-byte overlimit cancel private upstream without raw diagnostics',async()=>{
  let cancelled=0;
  const oversized=createPublicRelay({maxBytes:3,fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(enc.encode('four'));},cancel(){cancelled++;}},{highWaterMark:0}))});
  await assert.rejects((await oversized(incoming())).text(),/Public page stream interrupted/);assert.equal(cancelled,1);
  const controller=new AbortController(),aborting=createPublicRelay({fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(enc.encode('part'));},cancel(){cancelled++;}},{highWaterMark:0}))});
  const response=await aborting(incoming('/sites/a',{signal:controller.signal})),reader=response.body.getReader();await reader.read();controller.abort();await assert.rejects(reader.read(),/Public page stream interrupted/);assert.equal(cancelled,2);
  const broken=createPublicRelay({fetch:async()=>new Response(new ReadableStream({pull(c){c.error(Error('SECRET provider path'));}},{highWaterMark:0}))});
  await assert.rejects((await broken(incoming())).text(),error=>error.message==='Public page stream interrupted');
});
test('real loopback HTTP upstream streams unchanged bytes and closes after cancellation (not Vercel deployment proof)',async t=>{
  let closed;const closure=new Promise(resolve=>{closed=resolve;});
  const server=createServer((req,res)=>{
    assert.equal(req.url,'/functions/v1/fountain-api/sites/family');assert.equal(req.headers.cookie,'fountain_session='+token);assert.equal(req.headers.authorization,undefined);
    res.writeHead(200,{'Content-Type':'text/plain','X-Fountain-Format':'html'});res.write('<h1>real HTTP</h1>');res.on('close',closed);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const local='http://127.0.0.1:'+server.address().port;
  const relay=createPublicRelay({fetch:(url,init)=>{assert.equal(url,UPSTREAM+'/sites/family');return fetch(local+new URL(url).pathname,init);}});
  const response=await relay(incoming('/sites/family',{headers:{Cookie:'fountain_session='+token}}));
  assert.equal(response.headers.get('Content-Type'),'text/html; charset=utf-8');const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'<h1>real HTTP</h1>');await reader.cancel();
  await Promise.race([closure,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('upstream not closed')),1500))]);
});
test('allowlisted artifact includes static shell and one relay, while uploads/SSE keep direct external rewrites',async()=>{
  const result=await build(),actual=[];
  async function walk(dir,prefix=''){for(const name of await readdir(dir)){const path=join(dir,name),info=await lstat(path);assert(!info.isSymbolicLink());if(info.isDirectory())await walk(path,prefix+name+'/');else actual.push(prefix+name);}}
  await walk(result.destination);assert.deepEqual(actual.sort(),[...ASSETS,'api/public-relay.mjs','vercel.json'].sort());assert.equal(result.files.length,19);
  assert.equal(await readFile(join(result.destination,'api/public-relay.mjs'),'utf8'),await readFile(new URL('../apps/web/api/public-relay.mjs',import.meta.url),'utf8'));
  const config=JSON.parse(await readFile(join(result.destination,'vercel.json'),'utf8'));
  assert(!config.outputDirectory&&!config.buildCommand&&!config.installCommand);assert.equal(config.framework,null);
  const api=config.rewrites.find(rule=>rule.source.startsWith('/api/:path'));
  const pattern=new RegExp('^'+api.source.replace(':path','')+'$');
  for(const path of ['/api/uploads/id/chunks','/api/pages/id/events','/api/session','/api/forms/id/submit'])assert(pattern.test(path));
  assert(!pattern.test('/api/public-relay'));assert(!pattern.test('/api/public-relay/anything'));assert.equal(api.destination,UPSTREAM+'/api/:path');
  for(const kind of ['sites','forms'])assert.equal(config.rewrites.find(r=>r.source==='/'+kind+'/:slug').destination,'/api/public-relay?kind='+kind+'&slug=:slug');
  const headers=config.headers[0].headers;for(const name of ['Cache-Control','CDN-Cache-Control','Vercel-CDN-Cache-Control'])assert.equal(headers.find(h=>h.key===name).value,'no-store');
});
