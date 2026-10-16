/** Actual Chrome/IDB + disposable SQLite HTTP upload/CRDT integration.
 * Only the bounded-complete 202 protocol is injected; this is NOT a live
 * Supabase Storage, native SDK, or 5 GB transfer verification.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const temporary=await mkdtemp(join(tmpdir(),'fountain-upload-verify-')),CHUNK=4*1024*1024;
const fixture=String.raw`
import hashlib, sys
from fountain.server import create_server
server=create_server(port=0,db_path=sys.argv[1])
app=server.application
original=app.dispatch
def dispatch(method,path,body,query,**context):
    if method=='POST' and path.startswith('/api/uploads/') and path.endswith('/complete'):
        target=path.rsplit('/',1)[0]
        # Use the real original session/owner/page/lock ACL before reading bytes.
        with app.store.transaction():
            _,state=original('GET',target,{}, {},**context)
            if state['completed'] or state['name'].startswith('legacy-'):
                return original(method,path,body,query,**context)
            item=app.store.get('upload',state['id'])
            old=item.get('fixture_verified',0)
            end=min(item['size'],old+4194304)
            name=item['name']
            call=item.get('fixture_calls',0)+1
            item['fixture_calls']=call
            # Read actual stored SQLite chunks in <=64 KiB slices, then let
            # original complete compute and publish the final full SHA256.
            digest=hashlib.sha256()
            pos=0
            while pos<end:
                part=app.files._slice(item['id'],pos,end-pos)
                digest.update(part);pos+=len(part)
            item['fixture_verified']=end
            app.store.put('upload',item)
            if name.startswith('bad-'):
                value={**state,'verification_pending':True,'verified_offset':min(end,item['size']-1)}
                if name.startswith('bad-stuck'): value['verified_offset']=0
                if name.startswith('bad-decrease') and call>1: value['verified_offset']=0
                if name.startswith('bad-foreign'): value['id']='different-upload'
                if name.startswith('bad-oversize'): value['verified_offset']=item['size']+1
                if name.startswith('bad-completed'): value['completed']=True
                if name.startswith('bad-float'): value['verified_offset']=0.5
                if name.startswith('bad-shape'): value['verification_pending']=False
                if name.startswith('bad-final'): return 201,state
                return 202,value
            if end<item['size']:
                return 202,{**state,'verification_pending':True,'verified_offset':end}
            return original(method,path,body,query,**context)
    return original(method,path,body,query,**context)
app.dispatch=dispatch
print('VERIFY_HTTP_PORT='+str(server.server_port),flush=True)
try: server.serve_forever()
finally: server.server_close();app.store.close()
`;
let server,browser,context,page,origin,stage='startup';const errors=[],traffic=[],complete=[],releases=[];
const hash=value=>createHash('sha256').update(value).digest('hex');
async function api(path,body,{method=body===undefined?'GET':'POST',status=200,client=context}={}){const response=await client.request.fetch(origin+'/api'+path,{method,headers:{'X-Fountain-Request':'1'},...(body===undefined?{}:{data:body})});assert.equal(response.status(),status,path);return response.json();}
async function raw(){return page.evaluate(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open('fountain-upload-metadata-v1');opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('transfers'),query=tx.objectStore('transfers').getAll();query.onsuccess=()=>resolve(query.result);query.onerror=()=>reject(query.error);tx.oncomplete=()=>db.close();};}));}
async function boot(){await page.goto(origin);await page.waitForFunction(()=>globalThis.FountainUploads&&globalThis.FountainOffline);await page.evaluate(async()=>{const session=await(await FountainTransport.request('/api/session')).json(),workspace=await(await FountainTransport.request('/api/workspace')).json();globalThis.profile=await FountainOffline.saveProfile({workspaceId:session.workspace_id,memberId:session.member.id,session,workspace});globalThis.activeProfileId=profile.id;globalThis.published=[];});}
async function manager(pageId){await page.evaluate(async pageId=>{const scope={workspaceId:profile.workspaceId,memberId:profile.memberId,binding:profile.cacheBinding,pageId};globalThis.manager=new FountainUploads.UploadManager({scope,isCurrent:()=>activeProfileId===profile.id,onComplete:async(attachment,scope,current,publication)=>{if(!current()||(await FountainOffline.getProfile())?.id!==profile.id)return false;const response=await FountainTransport.request('/api/pages/'+encodeURIComponent(scope.pageId)+'/collaboration');if(!response.ok||!current())return false;const snapshot=await response.json();if(snapshot.session_binding!==scope.binding||!current())return false;const client='verify-'+attachment.id,block_id='file-'+attachment.id,ops=[{id:client+':1',client,clock:1,type:'block.insert',block_id,block_type:'file'},{id:client+':2',client,clock:2,type:'block.set',block_id,field:'attachment_id',value:attachment.id}];await publication.save({epoch:snapshot.epoch,block_id,ops});if(!current())return false;const result=await FountainTransport.request('/api/pages/'+encodeURIComponent(scope.pageId)+'/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({epoch:snapshot.epoch,ops})});if(!result.ok)throw Error('Actual document publication failed');published.push(attachment);return true;}});await manager.load();},pageId);}
async function upload(name,size){return page.evaluate(async({name,size})=>{const bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=(i*31+7)%251;globalThis.sourceFile=new File([bytes],name,{lastModified:1700000000000});const result=await manager.start(sourceFile);return {result,view:manager.view()};},{name,size});}
function bytes(size){const value=Buffer.alloc(size);for(let i=0;i<size;i++)value[i]=(i*31+7)%251;return value;}
try{
  server=spawn(python,['-u','-c',fixture,join(temporary,'workspace.sqlite')],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH,HOME:homedir(),FOUNTAIN_ACCESS_TOKEN:'',PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});
  origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Disposable verify HTTP startup timeout')),15000);const consume=value=>{output+=value;const match=output.match(/VERIFY_HTTP_PORT=(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',consume);server.stderr.on('data',consume);server.once('error',reject);server.once('exit',()=>{clearTimeout(timer);reject(Error('Disposable verify server exited'));});});
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});context=await browser.newContext({serviceWorkers:'block'});
  const password='Upload-verification-fixture-password-2026',owner=(await api('/accounts')).accounts.find(x=>x.role==='owner');await api('/accounts',{member_id:owner.id,password},{status:201});const bob=await api('/members',{name:'Other actor',email:'verify-bob@fixture.invalid',role:'member'},{status:201});await api('/accounts',{member_id:bob.id,password},{status:201});await api('/accounts/enable',{});await api('/session',{email:owner.email,password});
  const document=await api('/pages',{title:'Verification private document',permissions:{default:'private',inherit:false,members:{},groups:{}},blocks:[{id:'intro',text:'실제 HTTP 검증'}]},{status:201});
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/uploads/')||path.endsWith('/operations'))traffic.push({path,method:request.method()});});
  page.on('response',response=>{if(response.request().method()==='POST'&&response.url().endsWith('/complete'))complete.push({path:new URL(response.url()).pathname,status:response.status()});});
  await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><script defer src="/transport.js"></script><script defer src="/offline.js"></script><script defer src="/collaboration.js"></script><script defer src="/uploads.js"></script>'}));await boot();await manager(document.id);
  stage='legacy 9MB single201 publishes only after fresh collaboration proof';
  const legacy=await upload('legacy-nine.bin',9*1024*1024+37);assert.equal(legacy.view.at(-1).status,'done');assert.equal(legacy.result.sha256,hash(bytes(legacy.result.size)));assert.deepEqual(complete.map(x=>x.status),[201]);assert.equal((await raw()).length,0);
  stage='202 twice then final201, no publication before final response';
  const offset=complete.length,priorOps=traffic.filter(x=>x.path.endsWith('/operations')).length;
  let arrived,release;const held=new Promise(resolve=>arrived=resolve),ready=new Promise(resolve=>release=resolve);releases.push(release);let calls=0;
  const gate=async route=>{if(++calls===3){arrived();await ready;}await route.continue().catch(()=>{});};await page.route('**/api/uploads/*/complete',gate);
  await page.evaluate(()=>{globalThis.pendingUpload=manager.start(new File([new Uint8Array(9*1024*1024+37)],'pending-nine.bin',{lastModified:1700000000000}));});await held;
  const pending=(await raw()).find(x=>x.name==='pending-nine.bin');assert.equal(pending.verificationPending,true);assert.equal(pending.verifiedOffset,2*CHUNK);assert.equal(pending.publication,null);assert.equal(traffic.filter(x=>x.path.endsWith('/operations')).length,priorOps);assert.equal((await api('/uploads/'+pending.id)).completed,false);assert.equal((await context.request.get(origin+'/api/attachments/'+pending.id+'/download')).status(),404);
  release();await page.evaluate(()=>pendingUpload);await page.unroute('**/api/uploads/*/complete',gate);assert.deepEqual(complete.slice(offset).map(x=>x.status),[202,202,201]);assert.equal((await api('/uploads/'+pending.id)).completed,true);const download=await context.request.get(origin+'/api/attachments/'+pending.id+'/download');assert.equal(download.status(),200);assert.equal(hash(await download.body()),hash(Buffer.alloc(9*1024*1024+37)));assert.equal(traffic.filter(x=>x.path.endsWith('/operations')).length,priorOps+1);
  stage='eight calls pause, exact metadata survives reload; another actor reads/resumes zero';
  const beforeBound=complete.length,bounded=await upload('pending-bounded.bin',33*1024*1024+7),job=bounded.view.find(x=>x.name==='pending-bounded.bin');assert.equal(job.status,'paused');assert.equal(job.verifiedOffset,8*CHUNK);assert.equal(bounded.result,null);assert.equal(complete.length-beforeBound,8);const preserved=(await raw()).find(x=>x.id===job.id),preservedHash=hash(JSON.stringify(preserved));assert.equal((await api('/uploads/'+job.id)).completed,false);
  const other=await browser.newContext({serviceWorkers:'block'});await api('/session',{email:bob.email,password},{client:other});assert.equal((await other.request.get(origin+'/api/uploads/'+job.id)).status(),404);assert.equal((await other.request.get(origin+'/api/pages/'+document.id)).status(),404);
  const bobPage=await other.newPage(),bobRequests=[];bobPage.on('pageerror',error=>errors.push(error.message));bobPage.on('request',request=>{if(request.url().includes('/api/uploads/'))bobRequests.push(request.url());});await bobPage.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><script defer src="/transport.js"></script><script defer src="/offline.js"></script><script defer src="/collaboration.js"></script><script defer src="/uploads.js"></script>'}));await bobPage.goto(origin);await bobPage.waitForFunction(()=>globalThis.FountainUploads&&globalThis.FountainOffline);
  // Copy only the source metadata into this isolated test IDB, as an archive
  // remaining from another actor. Never copy any account/session cookies.
  const bobIsolation=await bobPage.evaluate(async({preserved,pageId})=>{const session=await(await FountainTransport.request('/api/session')).json(),workspace=await(await FountainTransport.request('/api/workspace')).json(),profile=await FountainOffline.saveProfile({workspaceId:session.workspace_id,memberId:session.member.id,session,workspace});const manager=new FountainUploads.UploadManager({scope:{workspaceId:profile.workspaceId,memberId:profile.memberId,binding:profile.cacheBinding,pageId},isCurrent:()=>true});await manager.load();const db=await new Promise(resolve=>{const query=indexedDB.open('fountain-upload-metadata-v1');query.onsuccess=()=>resolve(query.result);});await new Promise((resolve,reject)=>{const tx=db.transaction('transfers','readwrite');tx.objectStore('transfers').put(preserved);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});await manager.load();let rejected=false;try{await manager.resume(preserved.id,new File(['different actor'],preserved.name));}catch{rejected=true;}db.close();return {view:manager.view(),rejected};},{preserved,pageId:document.id});assert.deepEqual(bobIsolation,{view:[],rejected:true});assert.deepEqual(bobRequests,[],'Other actor never looks up/resumes archived uploads');await other.close();
  await page.reload();await page.waitForFunction(()=>globalThis.FountainUploads&&globalThis.FountainOffline);await page.evaluate(async()=>{globalThis.profile=await FountainOffline.getProfile();globalThis.activeProfileId=profile.id;globalThis.published=[];});await manager(document.id);assert.equal(hash(JSON.stringify((await raw()).find(x=>x.id===job.id))),preservedHash);assert.equal(await page.evaluate(id=>manager.jobs.get(id).status,job.id),'reselect');
  const beforeResume=traffic.length;await page.evaluate(async id=>{const size=33*1024*1024+7,bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=(i*31+7)%251;await manager.resume(id,new File([bytes],'pending-bounded.bin',{lastModified:1700000000000}));},job.id);assert.equal(traffic.slice(beforeResume).filter(x=>x.method==='PUT').length,0);assert.equal((await raw()).length,0);assert.equal((await api('/uploads/'+job.id)).attachment.sha256,hash(bytes(33*1024*1024+7)));
  stage='late final201 after pause cannot publish; completed status resumes with fresh proof';
  const opsBeforeLate=traffic.filter(x=>x.path.endsWith('/operations')).length;let finalArrived,releaseFinal;const finalHeld=new Promise(resolve=>finalArrived=resolve),finalReady=new Promise(resolve=>releaseFinal=resolve);releases.push(releaseFinal);let finalCalls=0;
  const holdFinal=async route=>{if(++finalCalls===3){const response=await route.fetch();assert.equal(response.status(),201);finalArrived();await finalReady;await route.fulfill({response}).catch(()=>{});}else await route.continue().catch(()=>{});};await page.route('**/api/uploads/*/complete',holdFinal);
  await page.evaluate(()=>{globalThis.lateUpload=manager.start(new File([new Uint8Array(2*4*1024*1024+1)],'pending-late.bin',{lastModified:1700000000000}));});await finalHeld;const late=(await raw()).find(x=>x.name==='pending-late.bin'),lateHash=hash(JSON.stringify(late));assert.equal((await api('/uploads/'+late.id)).completed,true);await page.evaluate(id=>manager.pause(id),late.id);releaseFinal();await page.evaluate(()=>lateUpload);await page.unroute('**/api/uploads/*/complete',holdFinal);assert.equal(traffic.filter(x=>x.path.endsWith('/operations')).length,opsBeforeLate);assert.equal(hash(JSON.stringify((await raw()).find(x=>x.id===late.id))),lateHash);await page.evaluate(id=>manager.resume(id),late.id);assert.equal(traffic.filter(x=>x.path.endsWith('/operations')).length,opsBeforeLate+1);assert.ok(!(await raw()).some(x=>x.id===late.id));
  stage='malformed/stuck/decreased/foreign/oversize/completed-without-metadata fail closed';
  const invalidIds=[];for(const mode of ['stuck','decrease','foreign','oversize','completed','float','shape','final']){const before=traffic.filter(x=>x.path.endsWith('/operations')).length,result=await upload('bad-'+mode+'.bin',CHUNK+17),item=result.view.at(-1);assert.equal(item.status,'error',mode);assert.equal(result.result,null);invalidIds.push(item.id);assert.ok((await raw()).some(x=>x.id===item.id),mode+' preserves metadata');assert.equal(traffic.filter(x=>x.path.endsWith('/operations')).length,before,mode+' never publishes');assert.equal((await api('/uploads/'+item.id)).completed,false);}
  stage='202 pending auth expiry preserves exact metadata and queued publication';
  let authArrived,releaseAuth;const authHeld=new Promise(resolve=>authArrived=resolve),authReady=new Promise(resolve=>releaseAuth=resolve);releases.push(releaseAuth);let authCalls=0;const holdAuth=async route=>{if(++authCalls===2){authArrived();await authReady;}await route.continue().catch(()=>{});};await page.route('**/api/uploads/*/complete',holdAuth);
  await page.evaluate(()=>{globalThis.authUpload=manager.start(new File([new Uint8Array(9*1024*1024+1)],'pending-auth.bin',{lastModified:1700000000000}));});await authHeld;const retained=(await raw()).find(x=>x.name==='pending-auth.bin');assert.equal(retained.verificationPending,true);assert.equal(retained.verifiedOffset,CHUNK);await page.evaluate(id=>{const job=manager.jobs.get(id);job.publication={epoch:'retained-proof',ops:[{id:'kept:1',client:'kept',clock:1,type:'block.insert',block_id:'not-published',block_type:'file'}]};return manager.save(job);},retained.id);const before401=hash(JSON.stringify(await raw())),ops401=traffic.filter(x=>x.path.endsWith('/operations')).length;await api('/session',{}, {method:'DELETE'});releaseAuth();await page.evaluate(()=>authUpload);await page.unroute('**/api/uploads/*/complete',holdAuth);assert.equal(complete.at(-1).status,401);assert.equal(hash(JSON.stringify(await raw())),before401);assert.equal(await page.evaluate(()=>manager.closed),true);assert.equal(traffic.filter(x=>x.path.endsWith('/operations')).length,ops401);assert.deepEqual(errors,[]);
  console.log('PASS upload verification: actual Chrome + disposable SQLite HTTP; legacy201, 202 progress/final SHA+CRDT publication, eight-call pause+reload, no retransmit/cross-actor access, eight malformed replies preserve source, passive401 preserves publication; protocol fixture, NOT live Supabase/native SDK/5GB evidence');
}catch(error){console.error('Upload verification failed at: '+stage,errors);throw error;}
finally{for(const release of releases)release();await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await exited;}}await rm(temporary,{recursive:true,force:true});}
