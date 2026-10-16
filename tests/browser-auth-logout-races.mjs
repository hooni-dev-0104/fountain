/** Actual logout races at storage and HTTP boundaries preserve a newly signed-in actor. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const python=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
for(const boundary of ['clear','delete']){
  const directory=await mkdtemp(join(tmpdir(),'fountain-retention-race-'));let server,browser;
  try{
    server=spawn(python,['-m','fountain.server','--database','sqlite','--port','0','--data',join(directory,'fixture.db')],{cwd:root,env:{PATH:process.env.PATH,HOME:homedir(),FOUNTAIN_ACCESS_TOKEN:'',PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});
    const origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),15000);const receive=chunk=>{output+=chunk;const match=output.match(/Fountain: http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',receive);server.stderr.on('data',receive);server.once('error',reject);});
    browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({serviceWorkers:'block'});
    const api=async(path,body)=>{const response=await context.request.fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'X-Fountain-Request':'1'},...(body===undefined?{}:{data:body})});assert.ok(response.ok(),path+' '+response.status());return response.json();};
    const password='Review-fixture-password-2026',a=(await api('/accounts')).accounts.find(value=>value.role==='owner');
    await api('/accounts',{member_id:a.id,password});const b=await api('/members',{name:'B fixture',email:'b-review@fixture.invalid',role:'member'});await api('/accounts',{member_id:b.id,password});await api('/accounts/enable',{});await api('/session',{email:a.email,password});
    const page=await context.newPage();await page.goto(origin);await page.waitForSelector('#sidebar .brand');await page.waitForFunction(()=>!!state.offlineProfile);
    const old=await page.evaluate(()=>structuredClone(state.offlineProfile));
    await page.evaluate(boundary=>{
      window.reviewOffline=FountainOffline;window.reviewTransport=FountainTransport;window.reviewHeld=false;
      const hold=()=>new Promise(resolve=>{window.reviewHeld=true;window.reviewRelease=resolve;});
      if(boundary==='clear')globalThis.FountainOffline={...reviewOffline,clearActiveProfile:async actor=>{window.reviewCapturedActor=actor?.id||null;await hold();return reviewOffline.clearActiveProfile(actor);}};
      else globalThis.FountainTransport={...reviewTransport,request:async(path,options={})=>{if(path==='/api/session'&&options.method==='DELETE'&&!window.reviewHeld){window.reviewDeleteBody=JSON.parse(options.body||'{}');await hold();}return reviewTransport.request(path,options);}};
      window.reviewLogout=doAction({dataset:{action:'logout'}}).then(()=>null,error=>error.message);
    },boundary);
    await page.waitForFunction(()=>reviewHeld);
    await api('/session',{email:b.email,password});
    const current=await page.evaluate(async()=>{
      const session=await(await reviewTransport.request('/api/session')).json(),workspace=await(await reviewTransport.request('/api/workspace')).json();
      const profile=await reviewOffline.saveProfile({workspaceId:session.workspace_id,memberId:session.member.id,session,workspace});
      await reviewOffline.saveDraft(reviewOffline.key(profile,'welcome'),'b-unsent',{blocks:[{id:'b',text:'B UNSENT'}]});return profile;
    });
    await page.evaluate(()=>reviewRelease());await page.evaluate(()=>reviewLogout);
    const stored=await page.evaluate(id=>new Promise((resolve,reject)=>{const opening=indexedDB.open('fountain-offline-v1');opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction(['profiles','drafts']),profile=tx.objectStore('profiles').get(id),drafts=tx.objectStore('drafts').index('profileId').count(id);tx.oncomplete=()=>{resolve({profile:!!profile.result,drafts:drafts.result,capturedActor:window.reviewCapturedActor,deleteBody:window.reviewDeleteBody});db.close();};};}),current.id);
    assert.equal(stored.profile,true,boundary+': stale A logout erased B profile');assert.equal(stored.drafts,1,boundary+': stale A logout erased B input');
    if(boundary==='clear')assert.equal(stored.capturedActor,old.id);
    else assert.equal(stored.deleteBody.cache_binding,old.cacheBinding);
    const session=await api('/session');assert.equal(session.authenticated,true);assert.equal(session.member.id,b.id,boundary+': stale A DELETE revoked the current B cookie');
    console.log('PASS isolated real Chrome/SQLite HTTP logout race at '+boundary+' boundary: B draft and session preserved');
  }finally{await browser?.close();if(server){const done=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await done;}await rm(directory,{recursive:true,force:true});}
}
