import { waitForAsync } from './async-browser.mjs';
/** Independent account contexts exercise real CRDT operations, SSE and durable recovery. */
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
const directory=await mkdtemp(join(tmpdir(),'fountain-collaboration-browser-'));
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
async function select(page,id,start,end=start) {
  await page.evaluate(( {
    id,start,end
  })=> {
    const element=document.querySelector(`.block[data-id="${CSS.escape(id)}"] .block-content`); element.focus(); function point(position) {
      let remaining=position,walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),node; while((node=walker.nextNode())) {
        const points=Array.from(node.textContent); if(remaining<=points.length)return[node,points.slice(0,remaining).join('').length]; remaining-=points.length;
      }
      return[element,element.childNodes.length];
    }
    const a=point(start),b=point(end); getSelection().setBaseAndExtent(a[0],a[1],b[0],b[1]);
  }, {
    id,start,end
  });
}
async function saved(page){await waitForAsync(page,()=>state.channel?.pending.size===0&&state.channel?.status==='synced'&&!state.history?.busy);}
async function text(page,id,value){await page.waitForFunction(({id,value})=>document.querySelector(`.block[data-id="${CSS.escape(id)}"] .block-content`)?.innerText===value,{id,value});}
async function history(page,direction){await page.locator(`[data-action="${direction}"]`).click();await waitForAsync(page,()=>!state.history?.busy);}
try {
  origin=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
  const a=await browser.newContext({viewport:{width:1440,height:1050}}),b=await browser.newContext();
  const ownerInfo=(await api(a,'/accounts')).accounts.find(account=>account.role==='owner'),password='Undo-test-family-2026';
  await api(a,'/accounts',{member_id:ownerInfo.id,password});const editor=await api(a,'/members',{name:'함께 쓰는 가족',email:'undo@example.local',role:'member'});
  await api(a,'/accounts',{member_id:editor.id,password});await api(a,'/accounts/enable',{});
  owner=await a.newPage();member=await b.newPage();for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));
  await owner.goto(origin);await login(owner,ownerInfo.email,password);await member.goto(origin);await login(member,editor.email,password);
  const record=await api(a,'/pages',{title:'실행 취소를 함께 확인해요',icon:'↶',blocks:[{id:'text',type:'paragraph',text:'시작🙂'},{id:'second',type:'paragraph',text:'다음 블록'}]});
  const route=origin+'/#page/'+record.id;
  for(const page of [owner,member]){await page.goto(route);await page.waitForSelector('.block-content[contenteditable="true"]');}
  await select(owner,'text',3);await owner.keyboard.insertText('a');await owner.waitForTimeout(300);await owner.keyboard.insertText('bc');await saved(owner);await text(member,'text','시작🙂abc');
  await select(member,'text',6);await member.keyboard.insertText('가족');await saved(member);await text(owner,'text','시작🙂abc가족');
  await select(owner,'text',8);await owner.keyboard.press('Control+z');await text(owner,'text','시작🙂가족');await saved(owner);await text(member,'text','시작🙂가족');
  await owner.keyboard.press('Control+Shift+z');await text(owner,'text','시작🙂abc가족');await saved(owner);
  console.log('PASS remote selective Undo and keyboard Redo');
  // Browser menu/mobile beforeinput invokes one compensation command.
  const before=await owner.evaluate(()=>state.channel.undoStack.length);
  await owner.locator('.block[data-id="text"] .block-content').evaluate(element=>element.dispatchEvent(new InputEvent('beforeinput',{inputType:'historyUndo',bubbles:true,cancelable:true}))); 
  await text(owner,'text','시작🙂가족');assert.equal(await owner.evaluate(()=>state.channel.undoStack.length),before-1);await owner.keyboard.press('Control+y');await text(owner,'text','시작🙂abc가족');
  // Enter splits a block atomically; one Undo restores both structure and text.
  await select(owner,'text',3);await owner.keyboard.press('Enter');await owner.waitForFunction(()=>state.blocks.length===3);await history(owner,'undo');
  await owner.waitForFunction(()=>state.blocks.length===2);await text(owner,'text','시작🙂abc가족');await history(owner,'redo');await owner.waitForFunction(()=>state.blocks.length===3);await history(owner,'undo');
  console.log('PASS browser-menu Undo and atomic Enter');
  await select(owner,'second',0);await owner.keyboard.press('Tab');await owner.waitForFunction(()=>state.blocks.find(block=>block.id==='second').parent_id==='text');await history(owner,'undo');await owner.waitForFunction(()=>!state.blocks.find(block=>block.id==='second').parent_id);
  // Formatting restores the same character IDs and keeps the remote contribution.
  const ids=await owner.evaluate(()=>state.channel.chars('text').map(char=>char.id));
  await select(owner,'text',0,2);await owner.locator('[data-action="rich-mark"][data-mark="bold"]').click();await owner.waitForSelector('.block[data-id="text"] .rich-bold');
  await history(owner,'undo');assert.equal(await owner.locator('.block[data-id="text"] .rich-bold').count(),0);await history(owner,'redo');
  assert.deepEqual(await owner.evaluate(()=>state.channel.chars('text').map(char=>char.id)),ids);
  // A composed Korean/emoji string is one action; intermediate input isn't queued.
  await select(owner,'second',5);await owner.evaluate(()=>{
    const el=document.querySelector('.block[data-id="second"] .block-content');el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    el.textContent='다음 블록한글🙂';const selection=getSelection(),range=document.createRange();range.selectNodeContents(el);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
    el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'한글🙂'}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한글🙂'}));
  });await text(owner,'second','다음 블록한글🙂');await history(owner,'undo');await text(owner,'second','다음 블록');await history(owner,'redo');
  console.log('PASS formatting and composition');
  // Typing remains local and undoable while disconnected, then converges.
  await saved(owner);await a.setOffline(true);await select(owner,'second',8);await owner.keyboard.insertText('기기');await history(owner,'undo');await text(owner,'second','다음 블록한글🙂');await history(owner,'redo');await a.setOffline(false);await saved(owner);await text(member,'second','다음 블록한글🙂기기');
  // Native title undo is outside block history.
  const stack=await owner.evaluate(()=>state.channel.undoStack.length);await owner.locator('#page-title').click();await owner.keyboard.press('End');await owner.keyboard.insertText(' 제목');await owner.keyboard.press('Meta+z');assert.equal(await owner.evaluate(()=>state.channel.undoStack.length),stack);assert.equal(await owner.locator('#page-title').innerText(),'실행 취소를 함께 확인해요');
  console.log('PASS offline and native title');
  // Publication can be undone after canonical ACK and before the upload UI finishes.
  await owner.evaluate(()=>{ensureUploads();const original=state.uploadManager.onComplete;state.uploadManager.onComplete=async(...args)=>{const accepted=await original(...args);window.attachmentAccepted=accepted;await new Promise(resolve=>window.finishAttachment=resolve);return accepted;};});
  const fixture=join(directory,'undo-file.txt');await writeFile(fixture,'첨부는 실행 취소 후에도 보관됩니다.');await owner.locator('#attachment-input').setInputFiles(fixture);
  await owner.waitForFunction(()=>window.attachmentAccepted===true);const attachment=await owner.evaluate(()=>state.blocks.find(block=>block.type==='file').attachment_id);
  await history(owner,'undo');await owner.waitForFunction(()=>!state.blocks.some(block=>block.type==='file'));await saved(owner);
  // Crash window: canonical creation + Undo ACK, but upload metadata not removed.
  await owner.reload();await owner.waitForSelector('[data-upload-state="reselect"]');await owner.locator('[data-action="upload-reselect"]').click();await owner.locator('#attachment-input').setInputFiles(fixture);await owner.waitForSelector('[data-upload-state="done"]');assert.equal(await owner.locator('.attachment-link').count(),0);await saved(owner);
  const downloaded=await a.request.get(origin+'/api/attachments/'+attachment+'/download');assert.equal(await downloaded.text(),'첨부는 실행 취소 후에도 보관됩니다.');
  await owner.reload();await owner.waitForSelector('.rich-toolbar');assert.equal(await owner.locator('.attachment-link').count(),0);assert.equal(await owner.evaluate(()=>state.channel.historyState().canUndo),false);
  // Old completed records have no publication proof: preserve recovery, never guess insertion.
  await owner.evaluate(()=>{ensureUploads();const manager=state.uploadManager,original=manager.onComplete;manager.onComplete=async(...args)=>{const job=[...manager.jobs.values()].find(job=>job.status==='attaching');job.publicationVersion=0;await manager.save(job);return original(args[0],args[1],args[2],{...args[3],version:0});};});
  await owner.locator('#attachment-input').setInputFiles(fixture);await owner.waitForSelector('[data-upload-state="error"]');assert.equal(await owner.locator('.attachment-link').count(),0);assert.match(await owner.locator('.upload-card p').innerText(),/연결 기록/);
  await owner.reload();await owner.waitForSelector('[data-upload-state="reselect"]');await owner.locator('[data-action="upload-reselect"]').click();await owner.locator('#attachment-input').setInputFiles(fixture);await owner.waitForSelector('[data-upload-state="error"]');assert.equal(await owner.locator('.attachment-link').count(),0);await owner.locator('[data-action="upload-cancel"]').click();
  // Lock clears editor history; unlocking cannot revive the earlier actor stack.
  await select(owner,'second',Array.from('다음 블록한글🙂기기').length);await owner.keyboard.insertText(' 확인');await saved(owner);assert.equal(await owner.evaluate(()=>state.channel.historyState().canUndo),true);
  await api(a,'/pages/'+record.id,{locked:true},'PATCH');await owner.waitForFunction(()=>state.page.locked&&!state.channel.historyState().canUndo);await api(a,'/pages/'+record.id,{locked:false},'PATCH');await owner.waitForSelector('.rich-toolbar');assert.equal(await owner.evaluate(()=>state.channel.historyState().canUndo),false);
  // A redacted lower-clock winner cannot be guessed while Undo is offline.
  // Keep this document independent of the typing and attachment history above.
  const unknown=await api(a,'/pages',{title:'서버 확인을 기다리는 실행 취소',blocks:[{id:'unknown-winner',type:'paragraph',text:'확인 전에는 기존 화면을 유지합니다.'}]});
  await owner.goto(origin+'/#page/'+unknown.id);await waitForAsync(owner,id=>state.channel?.pageId===id&&!state.channel.closed&&!!document.querySelector('.block[data-id="unknown-winner"] .block-content[contenteditable="true"]'),unknown.id);
  await owner.evaluate(()=>{state.channel.clock=2;});
  await owner.locator('[data-action="block-menu"][data-id="unknown-winner"]').click();await owner.locator('#block-type-select').selectOption('heading1');await owner.locator('[data-action="change-block-type"]').click();await saved(owner);
  const unknownEpoch=await owner.evaluate(()=>state.channel.base.epoch);
  const lateQuote={id:'late_family:2',client:'late_family',clock:2,type:'block.set',block_id:'unknown-winner',field:'type',value:'quote'};
  await api(b,'/pages/'+unknown.id+'/operations',{epoch:unknownEpoch,ops:[lateQuote]});
  await waitForAsync(owner,()=>Object.hasOwn(state.channel.base.state.seen,'late_family:2'));
  assert.equal(await owner.evaluate(()=>state.blocks[0].type),'heading1');
  assert.equal(await owner.evaluate(()=>JSON.stringify(state.channel.base.state.history.ops['late_family:2']).includes('quote')),false,'public lineage does not disclose the losing quote value');
  await a.setOffline(true);await owner.waitForFunction(()=>state.offline);await owner.locator('[data-action="undo"]').click();await owner.waitForFunction(()=>state.history.historyPending&&state.history.busy);
  assert.equal(await owner.evaluate(()=>state.blocks[0].type),'heading1');
  assert.equal(await owner.locator('.block[data-id="unknown-winner"]').getAttribute('data-type'),'heading1');
  assert.equal(await owner.locator('.block-content').getAttribute('contenteditable'),'false');
  assert.equal(await owner.locator('#page-title').getAttribute('contenteditable'),'true','title keeps its native editing scope');
  for(const selector of ['[data-action="undo"]','[data-action="redo"]','[data-action="add-block"]','.block-handle button','.rich-toolbar [data-action="rich-mark"]','.rich-toolbar select']){
    for(const control of await owner.locator(selector).all())assert.equal(await control.isDisabled(),true,selector+' is blocked until the canonical value arrives');
  }
  assert.match(await owner.locator('#history-state').innerText(),/연결이 필요/);
  const cancelIds=await waitForAsync(owner,async()=>{await state.channel.persistence;const operations=await FountainOffline.pendingOperations(state.channel.key);const ids=operations.filter(operation=>operation.type==='history.cancel').map(operation=>operation.id);return ids.length?ids:false;});
  assert.equal(cancelIds.length,1);
  assert.ok(await owner.evaluate(async()=>{const drafts=await FountainOffline.getDrafts(state.channel.key);return drafts.some(record=>record.draft.history_pending===true);}),'the unresolved action and last resolved view are durable');
  await a.setOffline(false);await saved(owner);await owner.waitForSelector('.block[data-id="unknown-winner"][data-type="quote"] .block-content[contenteditable="true"]');
  assert.equal(await owner.locator('#history-state').count(),0);
  assert.equal(await owner.evaluate(ids=>ids.every(id=>Object.hasOwn(state.channel.base.state.seen,id)),cancelIds),true,'canonical ACK uses the exact offline cancellation IDs');
  assert.equal(await owner.evaluate(async()=>{const operations=await FountainOffline.pendingOperations(state.channel.key);return operations.length;}),0);
  assert.equal((await api(a,'/pages/'+unknown.id+'/collaboration')).blocks[0].type,'quote');
  console.log('PASS public unknown winner: offline last-view barrier, disabled block controls, durable cancellation and exact canonical resolution');
  await owner.goto(route);await waitForAsync(owner,id=>state.channel?.pageId===id&&!state.channel.closed&&!!document.querySelector('.rich-toolbar'),record.id);
  // Real mobile/editor layout, no reference image supplied.
  await owner.screenshot({path:'/tmp/fountain-undo-desktop.png',fullPage:true});await owner.setViewportSize({width:390,height:844});await waitForAsync(owner,()=>!document.body.classList.contains('sidebar-open')&&document.querySelector('#sidebar').getBoundingClientRect().right<=.5);await owner.screenshot({path:'/tmp/fountain-undo-mobile.png',fullPage:true,animations:'disabled'});
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS: real Chrome collaborative Undo/Redo, remote text, Enter, format, IME, offline, native title, attachment ACK/Undo and reload.');
}finally{await browser?.close();if(server){server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
