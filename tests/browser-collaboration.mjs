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
  mkdtemp,rm,mkdir,readFile
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
async function append(page,id,text) {
  const length=await page.locator(`.block[data-id="${id}"] .block-content`).evaluate(element=>Array.from(element.innerText).length);
  await select(page,id,length);
  await page.keyboard.insertText(text);
}
async function saved(page) {
  await page.waitForFunction(()=>state.channel?.pending.size===0&&state.channel?.status==='synced');
}
async function contains(page,id,...texts) {
  await page.waitForFunction(( {
    id,texts
  })=> {
    const value=document.querySelector(`.block[data-id="${CSS.escape(id)}"] .block-content`)?.innerText||''; return texts.every(text=>value.includes(text));
  }, {
    id,texts
  });
}
try {
  origin=await startServer();
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME? {
    executablePath:process.env.FOUNTAIN_CHROME,headless:true
  }
  : {
    channel:'chrome',headless:true
  });
  const ownerContext=await browser.newContext( {
    viewport: {
      width:1440,height:1100
    }
  }),memberContext=await browser.newContext(),viewerContext=await browser.newContext();
  const ownerInfo=(await api(ownerContext,'/accounts')).accounts.find(account=>account.role==='owner'),password='Collaboration-family-passphrase-2026';
  await api(ownerContext,'/accounts', {
    member_id:ownerInfo.id,password
  });
  const editor=await api(ownerContext,'/members', {
    name:'함께 쓰는 가족',email:'editor@example.local',role:'member'
  }),reader=await api(ownerContext,'/members', {
    name:'읽는 가족',email:'reader@example.local',role:'member'
  });
  await api(ownerContext,'/accounts', {
    member_id:editor.id,password
  });
  await api(ownerContext,'/accounts', {
    member_id:reader.id,password
  });
  await api(ownerContext,'/accounts/enable', {
  });
  owner=await ownerContext.newPage();
  owner.setDefaultTimeout(15000);
  owner.on('pageerror',error=>errors.push(error.message));
  await owner.goto(origin);
  await login(owner,ownerInfo.email,password);
  const pageRecord=await api(ownerContext,'/pages', {
    title:'함께 쓰는 가족 노트',icon:'🌿',permissions: {
      default:'private',inherit:false,members: {
        [editor.id]:'edit',[reader.id]:'view'
      },groups: {
      }
    },blocks:[ {
      id:'shared-text',type:'paragraph',text:'가족의 생각을 함께 적어요.'
    }, {
      id:'nested-text',type:'bullet',text:'주말에 같이 만들 작은 계획'
    }, {
      id:'safe-paste',type:'paragraph',text:'자료를 모아요.'
    }]
  });
  const id=pageRecord.id;
  await owner.goto(origin+'/#page/'+id);
  await owner.waitForSelector('.block-content[contenteditable="true"]');
  member=await memberContext.newPage();
  member.setDefaultTimeout(15000);
  member.on('pageerror',error=>errors.push(error.message));
  await member.goto(origin+'/#page/'+id);
  await login(member,editor.email,password);
  await member.waitForSelector('.block-content[contenteditable="true"]');
  viewer=await viewerContext.newPage();
  viewer.setDefaultTimeout(15000);
  viewer.on('pageerror',error=>errors.push(error.message));
  await viewer.goto(origin+'/#page/'+id);
  await login(viewer,reader.email,password);
  await viewer.waitForSelector('.block-content[contenteditable="false"]');
  assert.equal(await viewer.locator('.rich-toolbar').count(),0);
  // Hold both operation requests so each user inserts at the same original character anchor.
  let release,held=0;
  const gate=new Promise(resolve=>release=resolve),path='**/api/pages/'+id+'/operations';
  const hold=async route=> {
    held++;
    await gate;
    await route.continue();
  };
  await ownerContext.route(path,hold);
  await memberContext.route(path,hold);
  await Promise.all([append(owner,'shared-text',' · 첫째🙂'),append(member,'shared-text',' · 둘째한글')]);
  const deadline=Date.now()+5000;
  while(held<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(held,2);
  release();
  await Promise.all([contains(owner,'shared-text','첫째🙂','둘째한글'),contains(member,'shared-text','첫째🙂','둘째한글')]);
  await saved(owner);
  await saved(member);
  await ownerContext.unroute(path,hold);
  await memberContext.unroute(path,hold);
  assert.equal(await owner.locator('.block[data-id="shared-text"] .block-content').innerText(),await member.locator('.block[data-id="shared-text"] .block-content').innerText());
  // A remote insertion before the caret preserves its character identity, not its old numeric offset.
  await select(owner,'shared-text',5);
  const caret=await owner.evaluate(()=>selectedTextPosition().anchor.before);
  await select(member,'shared-text',0);
  await member.keyboard.insertText('먼저 ');
  await contains(owner,'shared-text','먼저 ');
  assert.equal(await owner.evaluate(()=>selectedTextPosition().anchor.before),caret);
  // Composition is kept intact while remote edits arrive; composing Enter must not split a block.
  await select(owner,'shared-text',await owner.locator('.block[data-id="shared-text"] .block-content').evaluate(element=>Array.from(element.innerText).length));
  await owner.evaluate(()=> {
    const element=document.querySelector('.block[data-id="shared-text"] .block-content'); element.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles:true,data:''
    })); element.append(document.createTextNode(' 한글조합')); const range=document.createRange(); range.selectNodeContents(element); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); element.dispatchEvent(new InputEvent('input', {
      bubbles:true,inputType:'insertCompositionText',data:'한글조합',isComposing:true
    })); element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles:true,key:'Enter',isComposing:true,keyCode:229
    }));
  });
  await append(member,'shared-text',' · 원격동안');
  await saved(member);
  await owner.waitForFunction(()=>state.blocks.some(block=>block.text.includes('원격동안')));
  assert.ok(!(await owner.locator('.block[data-id="shared-text"] .block-content').innerText()).includes('원격동안'));
  await owner.evaluate(()=>document.querySelector('.block[data-id="shared-text"] .block-content').dispatchEvent(new CompositionEvent('compositionend', {
    bubbles:true,data:'한글조합'
  })));
  await Promise.all([contains(owner,'shared-text','한글조합','원격동안'),contains(member,'shared-text','한글조합','원격동안')]);
  assert.equal(await owner.locator('#blocks>.block').count(),3);
  // Rich formatting is a per-character CRDT operation and appears in the other user's renderer.
  await select(owner,'shared-text',0,2);
  await action(owner,'rich-mark','[data-mark="bold"]');
  await member.waitForSelector('.block[data-id="shared-text"] .rich-bold');
  await select(owner,'shared-text',3,7);
  await owner.waitForFunction(()=>state.richSelection?.start===3&&state.richSelection?.end===7);
  await owner.locator('#rich-color').selectOption('green');
  await member.waitForSelector('.block[data-id="shared-text"] .rich-color-green');
  await select(owner,'shared-text',0,2);
  await action(owner,'rich-link');
  await owner.locator('#rich-link-form [name="link"]').fill('https://example.com/family');
  await owner.locator('#rich-link-form .solid-btn').click();
  await member.waitForSelector('.block-content a[href="https://example.com/family"]');
  await select(owner,'shared-text',0,2);
  await action(owner,'rich-link');
  await owner.locator('#rich-link-form [name="link"]').fill('javascript:window.__unsafe=1');
  await owner.locator('#rich-link-form .solid-btn').click();
  assert.equal(await owner.locator('#blocks a[href^="javascript:"]').count(),0);
  await action(owner,'close-modal');
  await select(owner,'nested-text',0);
  await owner.keyboard.press('Tab');
  await member.waitForFunction(()=>state.blocks.find(block=>block.id==='nested-text')?.parent_id==='shared-text');
  assert.equal((await api(ownerContext,'/pages/'+id)).blocks.find(block=>block.id==='nested-text').parent_id,'shared-text');
  await append(owner,'safe-paste','');
  await owner.keyboard.press('Shift+Enter');await owner.keyboard.insertText('줄바꿈 유지');
  await contains(member,'safe-paste','\n줄바꿈 유지');await saved(owner);
  // Paste/drop always insert text/plain, never clipboard HTML, handlers or JavaScript links.
  await ownerContext.grantPermissions(['clipboard-read','clipboard-write']);
  await owner.evaluate(async()=>navigator.clipboard.write([new ClipboardItem( {
    'text/plain':new Blob([' 안전한 붙여넣기'], {
      type:'text/plain'
    }),'text/html':new Blob(['<script>window.__unsafe=1</script><img src=x onerror="window.__unsafe=1"><a href="javascript:window.__unsafe=1">unsafe</a><span style="position:fixed">unsafe</span>'], {
      type:'text/html'
    })
  })]));
  await select(owner,'safe-paste',6);
  await owner.keyboard.press(process.platform==='darwin'?'Meta+V':'Control+V');
  await contains(owner,'safe-paste','안전한 붙여넣기');
  await owner.evaluate(()=> {
    const transfer=new DataTransfer(); transfer.setData('text/plain',' 안전한 드롭'); transfer.setData('text/html','<img src=x onerror="window.__unsafe=1">'); document.querySelector('.block[data-id="safe-paste"] .block-content').dispatchEvent(new DragEvent('drop', {
      bubbles:true,cancelable:true,dataTransfer:transfer
    }));
  });
  await contains(member,'safe-paste','안전한 드롭');
  assert.equal(await owner.locator('#blocks script,#blocks img,#blocks [onerror],#blocks a[href^="javascript:"]').count(),0);
  assert.equal(await owner.evaluate(()=>window.__unsafe),undefined);
  await saved(owner);
  await mkdir('/tmp/fountain-browser', {
    recursive:true
  });
  await owner.waitForFunction(()=>!document.querySelector('#toast').classList.contains('visible'));
  await owner.waitForTimeout(250);
  await owner.screenshot( {
    path:'/tmp/fountain-browser/collaboration-desktop.png',fullPage:true
  });
  await owner.setViewportSize( {
    width:390,height:844
  });
  await owner.waitForTimeout(300);
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await owner.screenshot( {
    path:'/tmp/fountain-browser/collaboration-mobile.png',fullPage:true
  });
  await owner.setViewportSize( {
    width:1440,height:1100
  });
  // A newly booted home warms a favorite that this browser has never opened.
  const favorite=await api(ownerContext,'/pages', {
    title:'자동 보관한 가족 문서',blocks:[ {
      id:'favorite-block',text:'즐겨찾기 자동 보관 내용'
    }]
  });
  await api(ownerContext,'/pages/'+favorite.id, {
    favorite:true
  },'PATCH');
  await owner.goto(origin+'/#home');
  await owner.reload();
  await owner.waitForSelector('.recent-grid');
  await owner.waitForFunction(async id=> {
    const profile=await FountainOffline.getProfile(); return !!(profile&&await FountainOffline.getSnapshot(FountainOffline.key(profile,id)));
  },favorite.id);
  await ownerContext.setOffline(true);
  await owner.waitForFunction(()=>state.offline);
  await action(owner,'page',`[data-id="${favorite.id}"]`);
  await contains(owner,'favorite-block','즐겨찾기 자동 보관 내용');
  await append(owner,'favorite-block',' 오프라인 확인');
  await owner.evaluate(()=>state.channel.persistence);
  await ownerContext.setOffline(false);
  await saved(owner);
  await owner.goto(origin+'/#page/'+id);
  await owner.waitForSelector('.block-content[contenteditable="true"]');
  // Lock enforcement is server-side, while stream metadata makes the editor read-only.
  await api(ownerContext,'/pages/'+id, {
    locked:true
  },'PATCH');
  await member.waitForSelector('.block-content[contenteditable="false"]');
  assert.equal((await response(memberContext,'/pages/'+id+'/operations', {
    epoch:(await api(ownerContext,'/pages/'+id+'/collaboration')).epoch,ops:[ {
      id:'lockedtest:100000',client:'lockedtest',clock:100000,type:'text.insert',block_id:'shared-text',after_id:null,text:'거부'
    }]
  })).status(),423);
  await api(ownerContext,'/pages/'+id, {
    locked:false
  },'PATCH');
  await member.waitForSelector('.block-content[contenteditable="true"]');
  // An offline edit crossing a classic history epoch is retained for explicit recovery.
  await ownerContext.setOffline(true);
  await append(owner,'shared-text',' 오프라인 복구작업');
  await owner.evaluate(()=>state.channel.persistence);
  const oldEpoch=await owner.evaluate(()=>state.channel.base.epoch);
  await api(memberContext,'/pages/'+id+'/blocks', {
    blocks:[ {
      id:'shared-text',type:'paragraph',text:'복원된 현재 문서'
    }]
  },'PUT');
  await ownerContext.setOffline(false);
  await owner.waitForSelector('#recovery-drafts');
  await owner.waitForFunction(epoch=>state.channel.base.epoch!==epoch,oldEpoch);
  assert.equal((await api(ownerContext,'/pages/'+id)).blocks[0].text,'복원된 현재 문서');
  await append(owner,'shared-text',' 새 편집');
  await owner.evaluate(()=>state.channel.persistence);
  assert.ok(await owner.evaluate(async()=> {
    const records=await FountainOffline.getDrafts(state.channel.key); return records.some(record=>!['basis','pending'].includes(record.draft.reason)&&record.draft.blocks.some(block=>block.text.includes('오프라인 복구작업')));
  }));
  const exported=owner.waitForEvent('download');
  await action(owner,'export-recovery');
  const download=await exported;
  assert.ok((await readFile(await download.path(),'utf8')).includes('오프라인 복구작업'));
  await action(owner,'apply-recovery');
  await saved(owner);
  assert.ok((await api(ownerContext,'/pages/'+id)).blocks.some(block=>block.text.includes('오프라인 복구작업')));
  assert.ok((await api(ownerContext,'/pages/'+id)).blocks[0].text.startsWith('복원된 현재 문서'));
  // A page denial purges only that resource; another cached page and the active identity survive.
  await member.goto(origin+'/#home');
  await member.reload();
  await member.waitForSelector('.recent-grid');
  await member.waitForFunction(async id=> {
    const profile=await FountainOffline.getProfile(); return !!(profile&&await FountainOffline.getSnapshot(FountainOffline.key(profile,id)));
  },favorite.id);
  await member.goto(origin+'/#page/'+id);
  await member.waitForSelector('.block-content[contenteditable="true"]');
  await api(ownerContext,'/pages/'+id+'/permissions', {
    permissions: {
      default:'private',inherit:false,members: {
        [editor.id]:'none',[reader.id]:'view'
      },groups: {
      }
    }
  },'PATCH');
  await member.waitForFunction(()=>document.querySelector('#main').textContent.includes('이 문서에 접근할 수 없습니다.'));
  const isolation=await member.evaluate(async( {
    id,favorite
  })=> {
    const profile=await FountainOffline.getProfile(); return {
      profile:!!profile,denied:await FountainOffline.getSnapshot(FountainOffline.key(profile,id)),other:!!await FountainOffline.getSnapshot(FountainOffline.key(profile,favorite)),listed:profile.workspace.pages.some(page=>page.id===id)
    };
  }, {
    id,favorite:favorite.id
  });
  assert.equal(isolation.profile,true);
  assert.equal(isolation.denied,null);
  assert.equal(isolation.other,true);
  assert.equal(isolation.listed,false);
  assert.ok(!(await member.locator('#main').innerText()).includes('오프라인 복구작업'));
  assert.equal((await response(viewerContext,'/pages/'+id+'/operations', {
    epoch:(await api(ownerContext,'/pages/'+id+'/collaboration')).epoch,ops:[]
  })).status(),403);
  assert.deepEqual(errors,[],'browser runtime errors');
  console.log('PASS: two account CRDT convergence, caret anchor, Korean IME, rich text/link/color, nested blocks, safe clipboard/drop, viewer/lock enforcement, favorite warming+offline edit, epoch draft recovery+export+append, resource denial isolation');
  console.log('Screenshots: /tmp/fountain-browser/collaboration-{desktop,mobile}.png');
}
catch(error) {
  if(owner)await owner.screenshot( {
    path:'/tmp/fountain-browser/collaboration-failure.png',fullPage:true
  }).catch(()=> {
  });
  throw error;
}
finally {
  if(browser)await browser.close();
  if(server&&server.exitCode===null) {
    server.kill('SIGTERM');
    await new Promise(resolve=> {
      server.once('exit',resolve); setTimeout(resolve,3000);
    });
  }
  await rm(directory, {
    recursive:true,force:true
  });
}
