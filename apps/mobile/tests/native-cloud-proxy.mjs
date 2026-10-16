/** Dedicated local TLS presentation of the sealed real Supabase QA application.
 * No business response or authentication is simulated. Secrets stay server-side.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {readFile,stat} from 'node:fs/promises';
import {once} from 'node:events';
const configPath=process.env.FOUNTAIN_NATIVE_CLOUD_QA_CONFIG||'.data/cloud-account-qa.json';
const info=await stat(configPath);assert.equal(info.mode&0o777,0o600,'The disposable cloud config must be private');
const config=JSON.parse(await readFile(configPath,'utf8'));
assert.equal(config.workspaceId,'fountain-qa-cloud-accounts-75254a74761a4888');
assert.equal(typeof config.nonce,'string');
const target='https://ehnovtfadpkwtubmwltl.supabase.co/functions/v1/fountain-verify/wire';
const allowed=new Set(['POST /api/session','GET /api/session','DELETE /api/session','GET /api/pages/qa-accounts-private']);
const server=createServer({cert:await readFile('apps/mobile/android/app/src/debug/res/raw/fountain_qa_ca.pem'),key:await readFile('.data/android-qa/qa-ca.key')},async(req,res)=>{
 try{
  const path=new URL(req.url,'https://qa.invalid');
  if(path.search||!allowed.has(req.method+' '+path.pathname)){res.writeHead(403,{'Cache-Control':'no-store'});res.end();return;}
  const pieces=[];let size=0;for await(const part of req){size+=part.length;assert(size<=65536);pieces.push(part);}
  const body=Buffer.concat(pieces);
  if(req.method==='POST'){
   const login=JSON.parse(body);assert.equal(login.email,config.emails[0]);assert.equal(login.password,config.passwords[0]);
   assert.deepEqual(Object.keys(login).sort(),['email','password']);
  }
  const headers={'X-Fountain-Verify':config.nonce,'X-Fountain-Request':'1','X-Fountain-Test-Method':req.method,'X-Fountain-Test-Path':path.pathname,'Content-Type':req.headers['content-type']||'application/json'};
  const cookie=String(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>/^fountain_session=[A-Za-z0-9_-]{43}$/.test(value));
  if(cookie)headers['X-Fountain-Test-Cookie']=cookie;
  const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});
  const response=await fetch(target,{method:'POST',headers,body,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(45000)]),redirect:'error'});
  const outgoing=Object.fromEntries([...response.headers].filter(([key])=>!['set-cookie','content-encoding','transfer-encoding','connection','content-length'].includes(key)));
  const cookies=response.headers.getSetCookie().filter(value=>value.startsWith('fountain_session='));
  if(cookies.length){assert(cookies.every(value=>/;\s*Secure(?:;|$)/i.test(value)));outgoing['Set-Cookie']=cookies;}
  res.writeHead(response.status,outgoing);
  if(response.body)for await(const part of response.body){if(!res.write(part))await once(res,'drain');}
  res.end();console.log(JSON.stringify({method:req.method,path:path.pathname,status:response.status,actualSupabase:true,secureCookiePreserved:cookies.length?true:undefined}));
 }catch{if(!res.headersSent)res.writeHead(503,{'Cache-Control':'no-store'});res.end();console.log(JSON.stringify({proxyFailure:true}));}
});
server.listen(61603,'127.0.0.1');await once(server,'listening');console.log(JSON.stringify({ready:true,port:61603,tls:true,actualSupabase:true,fixedDisposableWorkspace:true}));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
