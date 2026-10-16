import { waitForAsync } from './async-browser.mjs';
/** Mock AI responses verify escaped output and document, modal, epoch and login scope guards. */
import {
  createRequire
}
from 'node:module';
import {
  spawn
}
from 'node:child_process';
import {
  mkdtemp,rm,mkdir,readFile,writeFile
}
from 'node:fs/promises';
import {
  homedir,tmpdir
}
from 'node:os';
import {
  join
}
from 'node:path';
import {
  fileURLToPath
}
from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url), {
  chromium
}
=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const directory=await mkdtemp(join(tmpdir(),'fountain-ai-browser-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let server,browser,origin,owner,member,viewer;
const errors=[];
async function startServer() {
  const environment= {
    ...process.env
  };
  delete environment.FOUNTAIN_ACCESS_TOKEN;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')], {
    cwd:fileURLToPath(new URL('..',import.meta.url)),env:environment,stdio:['ignore','pipe','pipe']
  });
  return new Promise((resolve,reject)=> {
    let output=''; const timer=setTimeout(()=>reject(new Error(output)),15000); const accept=chunk=> {
      output+=chunk.toString(); const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/); if(match) {
        clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]);
      }
    }; server.stdout.on('data',accept); server.stderr.on('data',accept); server.once('error',error=> {
      clearTimeout(timer); reject(error);
    }); server.once('exit',code=> {
      clearTimeout(timer); reject(new Error(`server ${code}: ${output}`));
    });
  });
}
async function response(context,path,body,method) {
  return context.request.fetch(origin+'/api'+path, {
    method:method||(body?'POST':'GET'),headers: {
      'X-Fountain-Request':'1'
    },...(body? {
      data:body
    }
    : {
    })
  });
}
async function api(context,path,body,method) {
  const result=await response(context,path,body,method);
  assert.ok(result.ok(),`${path}: ${result.status()} ${await result.text()}`);
  return result.json();
}
async function login(page,email,password) {
  await page.waitForSelector('#login-form [name="email"]');
  await page.locator('#login-form [name="email"]').fill(email);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('#sidebar .brand');
}
async function action(page,name,suffix='') {
  await page.locator(`[data-action="${name}"]${suffix}`).first().click();
}
// Every AI response in this test is intercepted; no configured provider is called.
const aiRequests=[],held=[];
async function openAI(page){await page.evaluate(()=>showAI());await page.waitForSelector('#ai-form');}
async function submitAI(page){await page.locator('#ai-form [name="prompt"]').fill('격리된 UI 테스트 요청');await page.locator('#ai-form .solid-btn').click();}
async function nextRequest(page,index){await waitForAsync(page,index=>window.aiRequestCount>=index+1,index);return held[index];}
async function release(page,index,body={text:'지연된 이전 응답'},status=200){held[index].resolve({body,status});await waitForAsync(page,count=>window.aiSettled>=count,index+1);}
async function documentReady(page,id){await waitForAsync(page,id=>state.route==='page'&&state.channel?.pageId===id&&!state.channel.closed&&state.page?.id===id&&!!document.querySelector('#page-title'),id);}
try {
  origin=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();
  const ownerInfo=(await api(context,'/accounts')).accounts.find(account=>account.role==='owner'),password='AI-UI-scoped-family-test-2026';
  await api(context,'/accounts',{member_id:ownerInfo.id,password});const editor=await api(context,'/members',{name:'두 번째 가족',email:'ai-ui@example.local',role:'member'});await api(context,'/accounts',{member_id:editor.id,password});await api(context,'/accounts/enable',{});
  owner=await context.newPage();owner.on('pageerror',error=>errors.push(error.message));
  await owner.route('**/api/ai',async route=>{const payload=route.request().postDataJSON();aiRequests.push(payload);let resolve;const gate=new Promise(done=>resolve=done);held.push({resolve});await owner.evaluate(count=>window.aiRequestCount=count,aiRequests.length);const result=await gate;await route.fulfill({status:result.status,contentType:'application/json',body:JSON.stringify(result.body)});});
  await owner.goto(origin);await login(owner,ownerInfo.email,password);
  const first=await api(context,'/pages',{title:'첫 번째 AI 문서',blocks:[{id:'ai-first',type:'paragraph',text:'원본 본문'}]}),second=await api(context,'/pages',{title:'두 번째 AI 문서',blocks:[{id:'ai-second',type:'paragraph',text:'다른 본문'}]});
  await owner.evaluate(()=>{const original=api;window.aiSettled=0;window.aiRequestCount=0;api=async(...args)=>{try{return await original(...args);}finally{if(args[0]==='/ai')window.aiSettled++;}};});
  await owner.evaluate(id=>navigate('page',id),first.id);await documentReady(owner,first.id);
  await openAI(owner);await submitAI(owner);await nextRequest(owner,0);assert.equal(aiRequests[0].page_id,first.id);
  await owner.locator('[data-action="close-modal"]').click();await openAI(owner);await release(owner,0);
  assert.equal(await owner.locator('#ai-output').innerText(),'','closing and reopening must not let the previous request write into the new modal');
  console.log('PASS stale modal response guard');
  // Normal provider output is escaped and never automatically applied to the document.
  let index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);
  const unsafe='<img src=x onerror="window.aiInjected=true"> 응답 <script>window.aiInjected=true</script>';
  await release(owner,index,{text:unsafe,provider:'<b>mock provider</b>'});assert.equal(await owner.locator('.ai-result').innerText(),unsafe);assert.equal(await owner.locator('#ai-output img,#ai-output script,#ai-output b').count(),0);assert.equal(await owner.evaluate(()=>!!window.aiInjected),false);assert.equal((await api(context,'/pages/'+first.id)).blocks[0].text,'원본 본문');
  await openAI(owner);index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);await release(owner,index,{error:'설정한 AI 서비스에 연결할 수 없습니다. <img src=x>'},503);assert.match(await owner.locator('#ai-output').innerText(),/서비스에 연결할 수 없습니다/);assert.equal(await owner.locator('#ai-output img').count(),0);
  // Late error responses obey the same DOM guard as successful responses.
  await openAI(owner);index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);await owner.locator('[data-action="close-modal"]').click();await openAI(owner);await release(owner,index,{error:'이전 모달의 오류'},503);assert.equal(await owner.locator('#ai-output').innerText(),'');
  // A response for the first page cannot enter an AI dialog opened on another page.
  index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);assert.equal(aiRequests[index].page_id,first.id);
  await owner.evaluate(id=>navigate('page',id),second.id);await documentReady(owner,second.id);await openAI(owner);await release(owner,index,{text:'이전 문서의 결과'});assert.equal(await owner.locator('#ai-output').innerText(),'');
  // Ordinary revisions in the same channel/epoch do not invalidate a useful answer.
  index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);const sameEpoch=await owner.evaluate(()=>state.channel.base.epoch),revision=await owner.evaluate(()=>state.channel.base.page.revision);
  await api(context,'/pages/'+second.id,{title:'같은 문서의 새 제목'},'PATCH');await waitForAsync(owner,revision=>state.channel.base.page.revision>revision,revision);assert.equal(await owner.evaluate(()=>state.channel.base.epoch),sameEpoch);
  await release(owner,index,{text:'같은 문서의 정상 응답',provider:'mock'});assert.equal(await owner.locator('.ai-result').innerText(),'같은 문서의 정상 응답');
  // Epoch replacement invalidates the earlier request even when the route is unchanged.
  await openAI(owner);index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);
  await api(context,'/pages/'+second.id+'/blocks',{blocks:[{id:'restored',type:'paragraph',text:'새 epoch의 본문'}]},'PUT');await waitForAsync(owner,epoch=>state.channel.base.epoch!==epoch,sameEpoch);
  await release(owner,index,{text:'이전 epoch의 결과'});assert.ok(!(await owner.locator('#ai-output').innerText()).includes('이전 epoch의 결과'));
  // Hold only the AI invocation's first save. Navigation's own save remains real.
  await owner.evaluate(()=>{window.aiOriginalSave=savePage;let first=true;window.aiSaveHeld=false;window.aiSaveReleased=false;savePage=async()=>{if(!first)return window.aiOriginalSave();first=false;window.aiSaveHeld=true;await new Promise(resolve=>window.releaseAISave=resolve);const result=await window.aiOriginalSave();window.aiSaveReleased=true;return result;};});
  await openAI(owner);const beforeSaveRequests=aiRequests.length;await submitAI(owner);await owner.waitForFunction(()=>window.aiSaveHeld);
  await owner.evaluate(id=>navigate('page',id),first.id);await documentReady(owner,first.id);await openAI(owner);await owner.evaluate(()=>window.releaseAISave());await owner.waitForFunction(()=>window.aiSaveReleased);await owner.evaluate(()=>{savePage=window.aiOriginalSave;});assert.equal(aiRequests.length,beforeSaveRequests,'changing the document during save must send zero AI requests');assert.equal(await owner.locator('#ai-output').innerText(),'');
  // Closing/reopening while save is pending also cancels transmission before POST.
  await owner.evaluate(()=>{window.aiOriginalSave=savePage;window.aiSaveHeld=false;window.aiSaveReleased=false;savePage=async()=>{window.aiSaveHeld=true;await new Promise(resolve=>window.releaseAISave=resolve);const result=await window.aiOriginalSave();window.aiSaveReleased=true;return result;};});
  await openAI(owner);const beforeModalSaveRequests=aiRequests.length;await submitAI(owner);await owner.waitForFunction(()=>window.aiSaveHeld);await owner.locator('[data-action="close-modal"]').click();await openAI(owner);await owner.evaluate(()=>window.releaseAISave());await owner.waitForFunction(()=>window.aiSaveReleased);await owner.evaluate(()=>{savePage=window.aiOriginalSave;});assert.equal(aiRequests.length,beforeModalSaveRequests,'replacing the form during save must send zero AI requests');assert.equal(await owner.locator('#ai-output').innerText(),'');
  // Real logout and another family login cannot receive the previous user's answer/error.
  index=aiRequests.length;await submitAI(owner);await nextRequest(owner,index);await owner.evaluate(()=>doAction({dataset:{action:'logout'}}));await login(owner,editor.email,password);await owner.evaluate(id=>navigate('page',id),second.id);await documentReady(owner,second.id);await openAI(owner);
  await release(owner,index,{text:'이전 로그인 사용자의 결과'});assert.equal(await owner.locator('#ai-output').innerText(),'');assert.equal(await owner.evaluate(()=>state.session.member.id),editor.id);
  assert.deepEqual(errors,[]);console.log('PASS: mocked AI escaped output/errors, modal/page/login/epoch fences, same-epoch revision retention and no POST after save scope changes');
}finally{for(const item of held)item.resolve({status:200,body:{text:'test cleanup'}});await browser?.close();if(server){server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
