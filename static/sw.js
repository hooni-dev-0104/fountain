/* Generic shell only. Private API, public-site and form responses never enter CacheStorage. */
'use strict';
const CACHE = 'fountain-shell-admin-content-v1';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/collaboration.js', '/offline.js', '/uploads.js', '/transport.js', '/mutations.js', '/presence.js', '/version-diff.js', '/recovery-import.js', '/backup.js'];
importScripts('/backup.js');
const backupTickets=new Map();
// Capabilities are issued ONLY here. Callers cannot rebind an expired, cancelled
// or previous-worker token, so no unbounded retired-token registry is needed.
const issueBackupToken=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function sameScope(session,scope){return session?.authenticated===true&&session.member?.role==='owner'&&session.member?.active===true&&session.workspace_id===scope.workspaceId&&session.member.id===scope.memberId&&session.cache_binding===scope.binding;}
self.addEventListener('message',event=>{
  const value=event.data,source=event.source;
  if(!value||!['fountain-backup-register','fountain-backup-cancel'].includes(value.type)||!source?.id)return;
  event.waitUntil((async()=>{
    const client=await self.clients.get(source.id);let ok=false,issued=null;
    if(client&&new URL(client.url).origin===self.location.origin&&FountainBackup.UUID.test(value.jobId)){
      for(const [id,ticket] of backupTickets)if(!ticket.started&&ticket.expires<Date.now()){ticket.abort.abort();ticket.port?.close();backupTickets.delete(id);}
      const jobId=value.jobId.toLowerCase(),old=backupTickets.get(jobId);
      if(value.type==='fountain-backup-cancel'){
        if(FountainBackup.TOKEN.test(value.transferId||'')&&old?.clientId===source.id&&old.transferId===value.transferId){old.abort.abort();old.port?.close();backupTickets.delete(jobId);}ok=true;
      }else if(!Object.hasOwn(value,'transferId')&&event.ports[0]&&(old||backupTickets.size<8)&&value.scope&&['workspaceId','memberId','binding'].every(k=>typeof value.scope[k]==='string'&&value.scope[k].length>0&&value.scope[k].length<=1000)&&(!old||old.clientId===source.id&&!old.started)){
        // Only RAM tickets from the initiating same-origin window. The server
        // still checks the job's original Auth/session identity on every Range.
        if(old){old.abort.abort();old.port?.close();}
        issued=issueBackupToken();const ticket={clientId:source.id,transferId:issued,scope:{workspaceId:value.scope.workspaceId,memberId:value.scope.memberId,binding:value.scope.binding},expires:Date.now()+60000,abort:new AbortController(),started:false,port:event.ports[0],proofs:new Map()};
        ticket.port.onmessage=event=>{const result=event.data,pending=ticket.proofs.get(result?.requestId);if(!pending||result.type!=='fountain-backup-proof-result')return;ticket.proofs.delete(result.requestId);clearTimeout(pending.timer);pending.resolve(result.granted===true);};
        backupTickets.set(jobId,ticket);ok=true;
      }
    }
    event.ports[0]?.postMessage({ok,...(ok&&issued?{transferId:issued}:{})});
  })());
});
async function backupDownload(event,id,transferId){
  const ticket=backupTickets.get(id),headers={'Cache-Control':'no-store','Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fountain-backup.sqlite"','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  if(!ticket||ticket.transferId!==transferId||ticket.started||ticket.expires<Date.now()||event.clientId&&ticket.clientId!==event.clientId)return backupRejected(409);
  // A navigation has no reliable originating clientId. Treat this as a one-use
  // capability handoff, requiring continuing explicit proof from its registered
  // source window. Never forward the capability URL/token to an API or cache.
  ticket.started=true;const signal=AbortSignal.any([event.request.signal,ticket.abort.signal]);let offset=0,settled=false,finishLifetime,streamController;
  const lifetime=new Promise(resolve=>{finishLifetime=resolve;});event.waitUntil(lifetime);
  const notify=(state,extra={})=>{void self.clients.get(ticket.clientId).then(client=>client?.postMessage({type:'fountain-backup-state',jobId:id,transferId:ticket.transferId,state,...extra}));};
  const current=async()=>{if(signal.aborted||backupTickets.get(id)!==ticket||!await self.clients.get(ticket.clientId))throw FountainBackup.failure(401);};
  const finish=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);for(const pending of ticket.proofs.values()){clearTimeout(pending.timer);pending.resolve(false);}ticket.proofs.clear();ticket.port.close();if(backupTickets.get(id)===ticket)backupTickets.delete(id);finishLifetime();};
  const aborted=()=>{if(settled)return;try{streamController?.error(new Error('백업 다운로드가 중단되었습니다.'));}catch{}notify('error',{status:ticket.errorStatus||499});finish();};
  signal.addEventListener('abort',aborted,{once:true});
  async function proof(){await current();const requestId=crypto.randomUUID();const allowed=await new Promise(resolve=>{const timer=setTimeout(()=>{ticket.proofs.delete(requestId);resolve(false);},4000);ticket.proofs.set(requestId,{resolve,timer});ticket.port.postMessage({type:'fountain-backup-proof',requestId});});await current();if(!allowed)throw FountainBackup.failure(401);}
  async function request(path,extra={}){await current();const response=await fetch(path,{...extra,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{'X-Fountain-Request':'1',...extra.headers},signal});await current();return response;}
  async function auth(){const response=await request('/api/session');if(response.status!==200){await response.body?.cancel();throw FountainBackup.failure(response.status);}if(!sameScope(await FountainBackup.readJSON(response),ticket.scope))throw FountainBackup.failure(401);await current();}
  try{
    await proof();await auth();const response=await request('/api/backup/jobs/'+id);if(response.status!==200){await response.body?.cancel();throw FountainBackup.failure(response.status);}
    const job=FountainBackup.validateJob(await FountainBackup.readJSON(response),id);if(job.phase!=='ready')throw FountainBackup.failure(409);await current();headers['Content-Length']=String(job.size);headers['Accept-Ranges']='none';
    const hash=new FountainBackup.SHA256();
    const stream=new ReadableStream({start(controller){streamController=controller;if(signal.aborted)aborted();},async pull(controller){
      try{
        await proof();if(Date.parse(job.expires_at)<=Date.now())throw FountainBackup.failure(410);
        const end=Math.min(job.size,offset+FountainBackup.CHUNK)-1,response=await request('/api/backup?job_id='+id,{headers:{Range:'bytes='+offset+'-'+end}});
        if(response.status!==206){await response.body?.cancel();throw FountainBackup.failure(response.status);}
        if(response.headers.get('Content-Range')!==`bytes ${offset}-${end}/${job.size}`||response.headers.get('Content-Length')!==String(end-offset+1))throw FountainBackup.failure();
        const reader=response.body?.getReader();if(!reader)throw FountainBackup.failure();const data=new Uint8Array(end-offset+1);let written=0;
        try{for(;;){const next=await reader.read();if(next.done)break;if(written+next.value.length>data.length)throw FountainBackup.failure();data.set(next.value,written);written+=next.value.length;}if(written!==data.length)throw FountainBackup.failure();}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        // Do not release even a bounded private chunk after a cookie/account
        // switch. Backend independently rechecks the original scope per 64KiB.
        await auth();hash.update(data);offset+=data.length;
        if(offset===job.size&&hash.hex()!==job.sha256)throw FountainBackup.failure();
        await proof();controller.enqueue(data);notify('downloading',{completed:offset,size:job.size});
        if(offset===job.size){controller.close();notify('complete',{completed:offset,size:job.size});finish();}
      }catch(error){ticket.errorStatus=error.status||503;ticket.abort.abort();if(!settled){controller.error(new Error('백업 다운로드가 중단되었습니다.'));notify('error',{status:ticket.errorStatus});finish();}}
    },async cancel(){ticket.abort.abort();finish();}},{highWaterMark:0});
    return new Response(stream,{headers});
  }catch(error){ticket.errorStatus=error.status||503;ticket.abort.abort();if(!settled){notify('error',{status:ticket.errorStatus});finish();}return backupRejected([401,403,409,410].includes(error.status)?error.status:503);}
}
function backupRejected(status){return new Response('백업 다운로드 연결을 확인해 주세요.',{status,headers:{'Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'"}});}
function reservedBackupPath(path){
  // Claim malformed variants BEFORE any network/cache branch. Decode only for
  // recognition; an encoded/traversal alias is never accepted as a handoff.
  for(let depth=0;depth<8;depth++){
    const normalized=new URL(self.location.origin+path).pathname.replace(/^\/+/, '/').toLowerCase();
    if(normalized.startsWith('/__fountain_backup_stream'))return true;
    let next;try{next=decodeURIComponent(path);}catch{return /%/.test(path.split('/')[1]||'');}
    if(next===path)return false;path=next;
  }
  return /%/.test(path.split('/')[1]||''); // Unclassifiable encoded top-level path: fail closed.
}
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload', credentials: 'omit' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('fountain-shell-') && name !== CACHE)
    .map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const handoff=/^\/__fountain_backup_stream\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if(url.origin===self.location.origin&&reservedBackupPath(url.pathname)){
    if(request.method!=='GET'||!handoff||url.search)event.respondWith(backupRejected(409));
    else{const ticket=[...backupTickets].find(([,value])=>value.transferId===handoff[1]);event.respondWith(ticket?backupDownload(event,ticket[0],handoff[1]):backupRejected(409));}return;
  }
  if(request.method==='GET'&&url.origin===self.location.origin&&url.pathname==='/api/backup'&&!request.headers.has('Range')&&[...url.searchParams.keys()].length===1&&url.searchParams.getAll('job_id').length===1&&FountainBackup.UUID.test(url.searchParams.get('job_id')||'')){
    event.respondWith(backupRejected(409));return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search || !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    let response;
    try {
      response = await fetch(request);
    } catch (error) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request.mode === 'navigate' ? '/' : url.pathname);
      if (cached) return cached;
      throw error;
    }
    if (response.ok && response.type !== 'opaqueredirect') {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(url.pathname, response.clone());
      } catch { /* Cache quota cannot turn a successful network response into a failure. */ }
    }
    // HTTP 401/403/500 are authoritative; only a genuine network failure uses cache.
    return response;
  })());
});
