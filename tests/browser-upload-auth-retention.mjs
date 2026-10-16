/** Actual Chrome IDB + disposable SQLite HTTP: passive auth never erases uploads.
 * This is browser/web storage evidence, not native SQLite/SDK/device evidence.
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
const temporary=await mkdtemp(join(tmpdir(),'fountain-upload-auth-retention-'));
let server,browser,context,page,origin,stage='startup';const errors=[],requests=[];
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function api(path,body,{method=body===undefined?'GET':'POST',status=200}={}){const response=await context.request.fetch(origin+'/api'+path,{method,headers:{'X-Fountain-Request':'1'},...(body===undefined?{}:{data:body})});assert.equal(response.status(),status,path);return response.json();}
async function raw(){return page.evaluate(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open('fountain-upload-metadata-v1',1);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('transfers'),query=tx.objectStore('transfers').getAll();query.onsuccess=()=>resolve(query.result);query.onerror=()=>reject(query.error);tx.oncomplete=()=>db.close();};}));}
async function waitFor(check){const deadline=Date.now()+10000;while(!await check()){if(Date.now()>deadline)throw Error('Upload auth retention condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
async function activate(email,password){await api('/session',{email,password});return page.evaluate(async()=>{const json=async path=>(await FountainTransport.request('/api'+path)).json(),session=await json('/session'),workspace=await json('/workspace');globalThis.profile=await FountainOffline.saveProfile({workspaceId:session.workspace_id,memberId:session.member.id,session,workspace});globalThis.activeProfileId=profile.id;return profile;});}
async function manager(name,pageId){return page.evaluate(async({name,pageId})=>{const scope={workspaceId:profile.workspaceId,memberId:profile.memberId,binding:profile.cacheBinding,pageId};const manager=new FountainUploads.UploadManager({scope,isCurrent:value=>activeProfileId===FountainOffline.key(profile,pageId).split('|').slice(0,4).join('|')&&value.binding===profile.cacheBinding&&value.memberId===profile.memberId,onDenied:value=>denials.push(value),onComplete:async(attachment,scope,current,publication)=>{await publication.save({epoch:'retained-epoch',block_id:'pending-'+attachment.id,ops:[{id:'publication-'+attachment.id+':1',client:'publication-'+attachment.id,clock:1,type:'block.insert',block_id:'pending-'+attachment.id,block_type:'file'},{id:'publication-'+attachment.id+':2',client:'publication-'+attachment.id,clock:2,type:'block.set',block_id:'pending-'+attachment.id,field:'attachment_id',value:attachment.id}]});return false;}});globalThis[name]=manager;await manager.load();return manager.view();},{name,pageId});}
async function publish(name,fileName){return page.evaluate(async({name,fileName})=>{await globalThis[name].start(new File(['Actual upload bytes retained by HTTP fixture'],fileName,{lastModified:1700000000000}));return [...globalThis[name].jobs.keys()][0];},{name,fileName});}
try{
  server=spawn(python,['-m','fountain.server','--database','sqlite','--port','0','--data',join(temporary,'workspace.sqlite')],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH,HOME:homedir(),FOUNTAIN_ACCESS_TOKEN:'',PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});
  origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Disposable HTTP startup timeout')),15000);const consume=value=>{output+=value;const match=output.match(/Fountain: http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',consume);server.stderr.on('data',consume);server.once('error',reject);server.once('exit',()=>{clearTimeout(timer);reject(Error('Disposable server exited'));});});
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});context=await browser.newContext({serviceWorkers:'block'});
  const password='Upload-retention-private-fixture-2026',owner=(await api('/accounts')).accounts.find(value=>value.role==='owner');await api('/accounts',{member_id:owner.id,password},{status:201});
  const bob=await api('/members',{name:'Other actor',email:'upload-retention-bob@fixture.invalid',role:'member'},{status:201});await api('/accounts',{member_id:bob.id,password},{status:201});await api('/accounts/enable',{});await api('/session',{email:owner.email,password});
  const document=await api('/pages',{title:'Upload auth retention',permissions:{default:'private',members:{[bob.id]:'edit'}}},{status:201});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().startsWith(origin+'/api/uploads/'))requests.push({method:request.method(),path:new URL(request.url()).pathname});});
  await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><script defer src="/transport.js"></script><script defer src="/offline.js"></script><script defer src="/collaboration.js"></script><script defer src="/uploads.js"></script>'}));await page.goto(origin);await page.waitForFunction(()=>globalThis.FountainUploads&&globalThis.FountainOffline,{},{timeout:10000});await page.evaluate(()=>{globalThis.denials=[];});
  const a1=await activate(owner.email,password);await manager('a1manager',document.id);const a1id=await publish('a1manager','first-binding.txt'),a1raw=await raw(),a1hash=digest(a1raw);assert.equal(a1raw.length,1);assert.equal(a1raw[0].publication.ops.length,2);
  stage='actual passive401 preserves metadata and publication operations';
  await api('/session',{}, {method:'DELETE'});await page.evaluate(id=>a1manager.resume(id),a1id);
  assert.equal(digest(await raw()),a1hash,'401 must preserve exact original upload/publication JSON');assert.equal(await page.evaluate(()=>a1manager.closed),true);
  assert.equal(await page.evaluate(()=>FountainOffline.getProfile()),null);

  stage='different actor cannot read old records or trigger automatic resume';
  const b1=await activate(bob.email,password),beforeB=requests.length;assert.deepEqual(await manager('bmanager',document.id),[]);assert.equal(requests.length,beforeB);assert.equal(digest(await raw()),a1hash);
  const bid=await publish('bmanager','other-actor.txt'),bRecord=(await raw()).find(value=>value.id===bid),bHash=digest([bRecord]);
  stage='same actor fresh binding isolates old metadata and does not auto resume';
  const a2=await activate(owner.email,password);assert.notEqual(a2.id,a1.id);const beforeA2=requests.length;assert.deepEqual(await manager('a2manager',document.id),[]);assert.equal(requests.length,beforeA2);assert.equal(digest((await raw()).filter(value=>value.profileId===a1.id)),a1hash);
  const a2id=await publish('a2manager','second-binding.txt'),allBefore=digest(await raw());
  stage='stale post-save and late401 never erase the old source or suspend new binding';
  await page.evaluate(()=>{globalThis.originalProfileGetter=FountainOffline;let count=0;globalThis.profileReadHeld=false;globalThis.FountainOffline={...originalProfileGetter,getProfile:async()=>{if(++count===2){profileReadHeld=true;await new Promise(resolve=>globalThis.releaseProfileRead=resolve);}return originalProfileGetter.getProfile();}};globalThis.pendingSave=a2manager.save(a2manager.jobs.values().next().value).then(()=>null,error=>error.name);});await waitFor(()=>page.evaluate(()=>profileReadHeld));
  const b2=await activate(bob.email,password);await page.evaluate(()=>releaseProfileRead());assert.equal(await page.evaluate(()=>pendingSave),'AbortError');await page.evaluate(()=>{globalThis.FountainOffline=originalProfileGetter;});
  const deniedBefore=await page.evaluate(()=>denials.length);await page.evaluate(()=>a2manager.fail(a2manager.jobs.values().next().value,Object.assign(new Error('late auth failure'),{status:401}),a2manager.generation));assert.equal(await page.evaluate(()=>denials.length),deniedBefore,'Stale 401 must not notify or fence the new actor');
  assert.equal((await page.evaluate(()=>FountainOffline.getProfile())).id,b2.id);assert.equal(digest(await raw()),allBefore);assert.equal(digest((await raw()).filter(value=>value.id===bid)),bHash);
  stage='expired/no-active profile fences manager but preserves all transfer rows';
  const a3=await activate(owner.email,password);await manager('expiredManager',document.id);const expiredId=await publish('expiredManager','expired-profile.txt'),beforeExpiry=digest(await raw());
  await page.evaluate(async()=>{const db=await new Promise(resolve=>{const open=indexedDB.open('fountain-offline-v1');open.onsuccess=()=>resolve(open.result);});await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),query=store.get(profile.id);query.onsuccess=()=>store.put({...query.result,validUntil:Date.now()-1000});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();dispatchEvent(new CustomEvent('fountain-offline-profile-changed',{detail:{profileId:profile.id}}));});await waitFor(()=>page.evaluate(()=>expiredManager.closed));assert.equal(await page.evaluate(()=>FountainOffline.getProfile()),null);assert.equal(digest(await raw()),beforeExpiry);
  stage='explicit captured actor logout erases all its bindings and preserves other actor';
  const capturedActor=a3;const b3=await activate(bob.email,password);await page.evaluate(profile=>FountainOffline.clearActiveProfile(profile),capturedActor);
  await waitFor(async()=>!(await raw()).some(value=>[a1.id,a2.id,a3.id].includes(value.profileId)));
  const remaining=await raw();assert.equal(remaining.length,1);assert.equal(digest(remaining),bHash);assert.equal((await page.evaluate(()=>FountainOffline.getProfile())).id,b3.id);
  assert.ok(!requests.some(value=>value.path==='/api/uploads/'+a1id&&value.method==='DELETE'),'Passive expiry must not cancel old server upload');assert.ok(!remaining.some(value=>value.id===a2id||value.id===expiredId));assert.deepEqual(errors,[]);
  console.log('PASS actual Chrome IDB + SQLite HTTP uploads: passive401/new binding/expired profile preserve exact metadata+publication.ops, no cross-actor read/auto-resume, stale save/401 fences, explicit actor logout all-bindings cleanup; NOT native SDK evidence');
}catch(error){console.error('Upload auth retention failed at: '+stage,errors);throw error;}
finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await exited;}}await rm(temporary,{recursive:true,force:true});}
