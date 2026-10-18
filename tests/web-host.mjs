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
const workspace='family_workspace-1',binding='b'.repeat(32),accountToken='c'.repeat(43);
const scoped=(kind='sites',slug='family')=>'/api/w/'+workspace+'/'+binding+'/'+kind+'/'+slug;
const rewritten=(kind='sites',slug='family')=>'/api/public-relay?workspace='+workspace+'&binding='+binding+'&kind='+kind+'&slug='+slug;
test('scoped publications restore trusted HTML using only account authority, for literal and finite rewrite routes',async()=>{
  for(const kind of ['sites','forms'])for(const path of [scoped(kind),rewritten(kind),scoped(kind)+'?workspace='+workspace+'&binding='+binding+'&kind='+kind+'&slug=family'])for(const method of ['GET','HEAD']){
    let cancelled=0;
    const response=await createPublicRelay({fetch:async(url,init)=>{
      assert.equal(url,UPSTREAM+scoped(kind));assert.equal(init.method,method);assert.equal(init.redirect,'manual');
      assert.equal(init.headers.get('Cookie'),'fountain_account_session='+accountToken);
      for(const key of ['Authorization','Host','X-Fountain-Workspace','X-Fountain-Account','X-Fountain-Verify'])assert.equal(init.headers.get(key),null);
      return new Response(new ReadableStream({start(c){c.enqueue(enc.encode('<main>Actual workspace</main>'));c.close();},cancel(){cancelled++;}}),{headers:{'Content-Type':'text/plain','X-Fountain-Format':'html','Content-Security-Policy':"default-src 'none'; sandbox",'Set-Cookie':'fountain_account_session=provider-secret','Location':'https://foreign.invalid','Access-Control-Allow-Origin':'*'}});
    }})(incoming(path,{method,headers:{Cookie:'fountain_session='+token+'; fountain_account_session='+accountToken+'; fountain_organization_session='+'d'.repeat(43)+'; provider_token=private',Authorization:'Bearer private','X-Fountain-Verify':'private'}}));
    assert.equal(response.status,200,path);assert.equal(response.headers.get('Content-Type'),'text/html; charset=utf-8');protectedHeaders(response);
    assert.equal(await response.text(),method==='HEAD'?'':'<main>Actual workspace</main>');if(method==='HEAD')assert.equal(cancelled,1);
  }
  const legacy=await createPublicRelay({fetch:async(url,init)=>{assert.equal(url,UPSTREAM+'/sites/family');assert.equal(init.headers.get('Cookie'),'fountain_session='+token);return new Response('ok');}})(incoming('/sites/family',{headers:{Cookie:'fountain_account_session='+accountToken+'; fountain_session='+token}}));
  assert.equal(await legacy.text(),'ok');
  for(const [path,cookie]of [[scoped(),'fountain_session='+token],['/sites/family','fountain_account_session='+accountToken]]){
    const result=await createPublicRelay({fetch:async(_url,init)=>{assert.equal(init.headers.get('Cookie'),null);return new Response('{}',{status:401,headers:{'Content-Type':'application/json'}});}})(incoming(path,{headers:{Cookie:cookie}}));
    assert.equal(result.status,401);assert.equal(await result.text(),'{}');
  }
});
test('scoped document login transition drops child authority; API, HEAD and denial errors retain status',async()=>{
  for(const kind of ['sites','forms'])for(const path of [scoped(kind),rewritten(kind)])for(const [method,headers,status,expected]of [
    ['GET',{Accept:'text/html','Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate'},401,303],
    ['GET',{Accept:'application/json'},401,401],['GET',{Accept:'text/html','Sec-Fetch-Dest':'empty'},401,401],
    ['HEAD',{Accept:'text/html'},401,401],['GET',{Accept:'text/html'},403,403]
  ]){
    let cancelled=0;const response=await createPublicRelay({fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode('{"error":"private"}'));c.close();},cancel(){cancelled++;}}),{status,headers:{'Content-Type':'application/json'}})})(incoming(path,{method,headers}));
    assert.equal(response.status,expected);const location=expected===303?'/#w/'+workspace+'/'+(kind==='sites'?'site':'form')+'/family':null;
    protectedHeaders(response,location);if(location){assert(!location.includes(binding));assert.equal(cancelled,1);}
    assert.equal(await response.text(),expected===303||method==='HEAD'?'':'{"error":"private"}');
  }
});
test('scoped relay rejects aliases, nested realms, duplicate or mismatched rewrites and malformed realm cookies before transport',async()=>{
  let calls=0;const relay=createPublicRelay({fetch:async()=>{calls++;throw Error('unexpected');}});
  const paths=[
    '/api/w/'+workspace+'/'+binding+'/pages/id','/api/w/'+workspace+'/'+binding+'/sites/a/b',
    scoped()+'/',scoped()+'?extra=x',scoped()+'#fragment',scoped().replace('/w/','/%77/'),
    scoped().replace(workspace,'%66amily_workspace-1'),scoped().replace(binding,binding.toUpperCase()),
    scoped().replace('/sites/','/%73ites/'),scoped().replace('/family','/%66amily'),
    '/api/w/'+'x'.repeat(161)+'/'+binding+'/sites/a','/api/w/'+workspace+'/'+binding+'/sites/'+'x'.repeat(161),
    '/api/w/'+workspace+'/'+binding.slice(1)+'/sites/a','/api/w/'+workspace+'/'+binding+'0/sites/a',
    scoped().replace('/family','/%2e%2e'),scoped().replace('/family','/a%2fb'),
    rewritten()+'&kind=forms',rewritten()+'&workspace='+workspace,rewritten()+'&binding='+binding,
    rewritten()+'&upstream=https://outside.invalid',rewritten().replace('workspace=','%77orkspace='),
    rewritten().replace('family_workspace-1','%66amily_workspace-1'),rewritten().replace('kind=sites','kind=%73ites'),
    '/api/public-relay?kind=sites&slug=family&workspace='+workspace,
    '/api/public-relay?kind=sites&slug=family&binding='+binding,
    scoped()+'?workspace=other&binding='+binding+'&kind=sites&slug=family',
    scoped()+'?workspace='+workspace+'&binding='+binding+'&kind=forms&slug=family',
    scoped()+'?workspace='+workspace+'&binding='+binding+'&kind=sites&slug=other'
  ];
  for(const path of paths){const response=await relay(incoming(path));assert.equal(response.status,404,path);protectedHeaders(response);}
  for(const cookie of ['fountain_account_session=bad','fountain_account_session='+accountToken+'; fountain_account_session='+accountToken,'fountain_account_session='+accountToken+'; fountain_session=bad','fountain_account_session='+accountToken+'; fountain_organization_session=bad','fountain_account_session='+accountToken+'; fountain_account_session','fountain_account_session='+accountToken+', fountain_account_session='+accountToken])assert.equal((await relay(incoming(scoped(),{headers:{Cookie:cookie}}))).status,400,cookie);
  assert.equal((await relay(incoming(scoped(),{method:'POST',body:'multipart-not-relayed',headers:{'Content-Type':'multipart/form-data; boundary=test'}}))).status,405);
  assert.equal(calls,0);
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
test('real scoped loopback relay preserves bytes and account cookie, cancels bounded streams, and never grants on other realm cookies',async t=>{
  const observed=[];let cancelled=0;
  const server=createServer((req,res)=>{
    observed.push({url:req.url,method:req.method,cookie:req.headers.cookie,authorization:req.headers.authorization});
    assert.equal(req.url,'/functions/v1/fountain-api'+scoped());assert.equal(req.headers.authorization,undefined);
    if(req.headers.cookie!=='fountain_account_session='+accountToken){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"account required"}');return;}
    res.writeHead(200,{'Content-Type':'text/plain','X-Fountain-Format':'html','Content-Security-Policy':"default-src 'none'; sandbox",'Set-Cookie':'provider=private'});
    if(req.method==='HEAD'){res.end();return;}
    res.write('<main>Real scoped HTML</main>');req.on('close',()=>{cancelled++;});
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const local='http://127.0.0.1:'+server.address().port;
  const relay=createPublicRelay({fetch:(url,init)=>{assert.equal(url,UPSTREAM+scoped());return fetch(local+new URL(url).pathname,init);}});
  const response=await relay(incoming(rewritten(),{headers:{Cookie:'fountain_session='+token+'; fountain_account_session='+accountToken,Authorization:'Bearer private'}}));
  protectedHeaders(response);assert.equal(response.headers.get('Content-Type'),'text/html; charset=utf-8');const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'<main>Real scoped HTML</main>');await reader.cancel();
  for(let n=0;cancelled===0&&n<50;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(cancelled,1);
  const head=await relay(incoming(scoped(),{method:'HEAD',headers:{Cookie:'fountain_account_session='+accountToken}}));assert.equal(head.status,200);assert.equal(await head.text(),'');protectedHeaders(head);
  const denied=await relay(incoming(scoped(),{headers:{Cookie:'fountain_session='+token}}));assert.equal(denied.status,401);assert.equal(await denied.text(),'{"error":"account required"}');protectedHeaders(denied);
  assert.deepEqual(observed.map(value=>[value.method,value.cookie]),[['GET','fountain_account_session='+accountToken],['HEAD','fountain_account_session='+accountToken],['GET',undefined]]);
});
test('scoped publication limits and HTML marker remain identical to legacy relay policy',async()=>{
  const boundary='/api/w/'+'w'.repeat(160)+'/'+binding+'/forms/'+'s'.repeat(160);
  const accepted=await createPublicRelay({fetch:async(url)=>{assert.equal(url,UPSTREAM+boundary);return new Response('ok',{headers:{'Content-Type':'text/plain','X-Fountain-Format':'html'}});}})(incoming(boundary));assert.equal(accepted.status,200);assert.equal(await accepted.text(),'ok');
  for(const [status,mime,marker,expected]of [[200,'application/json','html','application/json'],[200,'text/html',null,'text/plain'],[200,'text/plain','HTML','text/plain'],[403,'text/plain','html','text/plain']]){
    const response=await createPublicRelay({fetch:async()=>new Response('{"html":"<script>unsafe()</script>"}',{status,headers:{'Content-Type':mime,...(marker?{'X-Fountain-Format':marker}:{})}})})(incoming(scoped()));assert.equal(response.status,status);assert.equal(response.headers.get('Content-Type').split(';')[0],expected);protectedHeaders(response);await response.text();
  }
  let cancelled=0;const oversized=await createPublicRelay({maxBytes:3,fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(enc.encode('four'));},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{'X-Fountain-Format':'html','Content-Type':'text/plain'}})})(incoming(scoped()));await assert.rejects(oversized.text(),/Public page stream interrupted/);assert.equal(cancelled,1);
  const declared=await createPublicRelay({fetch:async()=>new Response('small',{headers:{'Content-Length':String(16*1024*1024+1)}})})(incoming(scoped()));assert.equal(declared.status,502);protectedHeaders(declared);await declared.text();
});
// This finite fixture deliberately models the observed deployed behavior:
// mapped destination query fields replace caller fields before the handler.
// It checks our config's pre-rewrite guards, not Vercel's implementation.
function publicationRewrite(path,config){
  const url=new URL(origin+path);
  for(const rule of config.rewrites.filter(rule=>rule.destination.startsWith('/api/public-relay?'))){
    const keys=[],source=rule.source.split('/').map(segment=>{
      const param=/^:([A-Za-z]+)(?:\(([^)]+)\))?$/.exec(segment);
      if(!param)return segment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      keys.push(param[1]);return '('+(param[2]??'[^/]+')+')';
    }).join('/'),match=new RegExp('^'+source+'$').exec(url.pathname);
    if(!match)continue;
    const condition=entry=>entry.type==='query'&&url.searchParams.has(entry.key)&&(entry.value===undefined||url.searchParams.getAll(entry.key).some(value=>new RegExp('^(?:'+entry.value+')$').test(value)));
    if(!(rule.has??[]).every(condition)||(rule.missing??[]).some(condition))continue;
    const params=Object.fromEntries(keys.map((key,index)=>[key,match[index+1]]));
    const destination=new URL(origin+rule.destination.replace(/:([A-Za-z]+)/g,(_all,key)=>params[key]));
    const merged=new URLSearchParams(url.search);for(const [key,value]of destination.searchParams)merged.set(key,value);
    destination.search=merged.toString();return destination.pathname+destination.search;
  }
  return null;
}
test('pre-rewrite guards reject reserved caller fields before platform destination replacement can erase them',async()=>{
  const config=JSON.parse(await readFile(new URL('../apps/web/vercel.json',import.meta.url),'utf8'));
  const paths=['/sites/family','/forms/family',scoped('sites'),scoped('forms')],reserved=['kind','slug','workspace','binding'];
  let calls=0;const relay=createPublicRelay({fetch:async()=>{calls++;return new Response('<main>trusted</main>',{headers:{'Content-Type':'text/plain','X-Fountain-Format':'html'}});}});
  for(const path of paths)for(const key of reserved)for(const query of [key+'=other',key+'=',key,key+'=first&'+key+'=second',key+'=%0A%0D',key+'=%ZZ','%'+key.charCodeAt(0).toString(16)+key.slice(1)+'=other']){
    const transformed=publicationRewrite(path+'?'+query,config);assert(transformed,'guard matches '+path+'?'+query);
    assert.equal(new URL(origin+transformed).searchParams.get('rejected'),'1','must reject before reserved fields are overwritten: '+path+'?'+query);
    const result=await relay(incoming(transformed));assert.equal(result.status,404);protectedHeaders(result);await result.text();
  }
  assert.equal(calls,0);
  for(const path of paths){const transformed=publicationRewrite(path,config);assert(transformed);assert.equal(new URL(origin+transformed).searchParams.has('rejected'),false);const result=await relay(incoming(transformed));assert.equal(result.status,200);assert.equal(await result.text(),'<main>trusted</main>');}
  assert.equal(calls,4);
  for(const path of paths){const result=await relay(incoming(publicationRewrite(path+'?extra=1',config)));assert.equal(result.status,404);await result.text();}assert.equal(calls,4);
  for(const path of ['/api/pages/id/events','/api/w/'+workspace+'/'+binding+'/pages/id/events','/api/uploads/id/chunks','/api/w/'+workspace+'/'+binding+'/api/forms/id/submit'])assert.equal(publicationRewrite(path+'?kind=sites',config),null);
});
test('allowlisted artifact includes static shell and one relay, while uploads/SSE keep direct external rewrites',async()=>{
  const result=await build(),actual=[];
  async function walk(dir,prefix=''){for(const name of await readdir(dir)){const path=join(dir,name),info=await lstat(path);assert(!info.isSymbolicLink());if(info.isDirectory())await walk(path,prefix+name+'/');else actual.push(prefix+name);}}
  await walk(result.destination);assert.deepEqual(actual.sort(),[...ASSETS,'api/public-relay.mjs','vercel.json'].sort());assert.equal(result.files.length,22);
  assert.equal(await readFile(join(result.destination,'api/public-relay.mjs'),'utf8'),await readFile(new URL('../apps/web/api/public-relay.mjs',import.meta.url),'utf8'));
  const config=JSON.parse(await readFile(join(result.destination,'vercel.json'),'utf8'));
  assert(!config.outputDirectory&&!config.buildCommand&&!config.installCommand);assert.equal(config.framework,null);
  const api=config.rewrites.find(rule=>rule.source.startsWith('/api/:path'));
  const pattern=new RegExp('^'+api.source.replace(':path','')+'$');
  for(const path of ['/api/uploads/id/chunks','/api/pages/id/events','/api/session','/api/forms/id/submit'])assert(pattern.test(path));
  assert(!pattern.test('/api/public-relay'));assert(!pattern.test('/api/public-relay/anything'));assert.equal(api.destination,UPSTREAM+'/api/:path');
  for(const kind of ['sites','forms'])assert.equal(config.rewrites.find(r=>r.source==='/'+kind+'/:slug').destination,'/api/public-relay?kind='+kind+'&slug=:slug');
  for(const kind of ['sites','forms']){const scoped=config.rewrites.find(r=>r.source==='/api/w/:workspace/:binding/'+kind+'/:slug');assert(scoped);assert.equal(scoped.destination,'/api/public-relay?workspace=:workspace&binding=:binding&kind='+kind+'&slug=:slug');assert(config.rewrites.indexOf(scoped)<config.rewrites.indexOf(api));}
  const headers=config.headers[0].headers;for(const name of ['Cache-Control','CDN-Cache-Control','Vercel-CDN-Cache-Control'])assert.equal(headers.find(h=>h.key===name).value,'no-store');
});
