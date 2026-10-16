import { waitForAsync } from './async-browser.mjs';
/** Real Chrome transfers bounded raw chunks, resumes after reload and respects changing access. */
import {
  createRequire
}
from 'node:module';
import {
  spawn
}
from 'node:child_process';
import {
  mkdtemp,rm,mkdir,writeFile,readFile,utimes
}
from 'node:fs/promises';
import {
  createHash
}
from 'node:crypto';
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
const directory=await mkdtemp(join(tmpdir(),'fountain-uploads-browser-'));
const python=process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const CHUNK=4*1024*1024;
let server,browser,origin,page;
const releases=[],errors=[],chunks=[];
async function startServer() {
  const env= {
    ...process.env
  };
  delete env.FOUNTAIN_ACCESS_TOKEN;
  server=spawn(python,['-m','fountain.server','--port','0','--data',join(directory,'workspace.db')], {
    cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']
  });
  return new Promise((resolve,reject)=> {
    let output=''; const timer=setTimeout(()=>reject(new Error(output)),15000); const receive=chunk=> {
      output+=chunk.toString(); const match=output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/); if(match) {
        clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]);
      }
    }; server.stdout.on('data',receive); server.stderr.on('data',receive); server.once('error',error=> {
      clearTimeout(timer); reject(error);
    }); server.once('exit',code=> {
      clearTimeout(timer); reject(new Error(`server ${code}: ${output}`));
    });
  });
}
async function request(context,path,body,method) {
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
  const value=await request(context,path,body,method);
  assert.ok(value.ok(),`${path}: ${value.status()} ${await value.text()}`);
  return value.json();
}
async function action(name,id) {
  await page.locator(`[data-action="${name}"]${id?`[data-id="${id}"]`:''}`).first().click();
}
async function gate(context,predicate) {
  let release,arrived;
  const held=new Promise(resolve=>arrived=resolve),ready=new Promise(resolve=>release=resolve);
  releases.push(release);
  const handler=async route=> {
    if(predicate(route.request())) {
      arrived(route.request());
      await ready;
    }
    await route.continue().catch(()=> {
    });
  };
  await context.route('**/api/uploads/**',handler);
  return {
    held,release,remove:()=>context.unroute('**/api/uploads/**',handler)
  };
}
async function records() {
  return page.evaluate(async()=> {
    const db=await new Promise((resolve,reject)=> {
      const opening=indexedDB.open('fountain-upload-metadata-v1',1); opening.onsuccess=()=>resolve(opening.result); opening.onerror=()=>reject(opening.error);
    }); const values=await new Promise((resolve,reject)=> {
      const query=db.transaction('transfers').objectStore('transfers').getAll(); query.onsuccess=()=>resolve(query.result); query.onerror=()=>reject(query.error);
    }); db.close(); return values;
  });
}
async function finish(id) {
  await page.waitForSelector(`.upload-card[data-upload-id="${id}"][data-upload-state="done"]`);
  await page.waitForFunction(()=>state.channel?.pending.size===0);
}
try {
  const bytes=Buffer.alloc(9*1024*1024+37);
  for(let index=0; index<bytes.length; index++)bytes[index]=(index*31+7)%251;
  const original=join(directory,'family-large.bin'),wrongDirectory=join(directory,'wrong');
  await mkdir(wrongDirectory);
  const wrong=join(wrongDirectory,'family-large.bin');
  const modified=Buffer.from(bytes);
  modified[0]^=255;
  await writeFile(original,bytes);
  await writeFile(wrong,modified);
  const timestamp=new Date('2025-01-01T00:00:00Z');
  await utimes(original,timestamp,timestamp);
  await utimes(wrong,timestamp,timestamp);
  const small=join(directory,'retry-file.bin'),cancelFile=join(directory,'cancel-file.bin'),documentRetry=join(directory,'document-retry.bin');
  await writeFile(small,bytes.subarray(0,CHUNK+101));
  await writeFile(cancelFile,bytes);
  await writeFile(documentRetry,bytes.subarray(0,CHUNK+101));
  origin=await startServer();
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME? {
    executablePath:process.env.FOUNTAIN_CHROME,headless:true
  }
  : {
    channel:'chrome',headless:true
  });
  const owner=await browser.newContext(),memberContext=await browser.newContext( {
    viewport: {
      width:1440,height:1100
    }
  });
  const password='Large-file-family-password-2026';
  const ownerInfo=(await api(owner,'/accounts')).accounts.find(account=>account.role==='owner');
  await api(owner,'/accounts', {
    member_id:ownerInfo.id,password
  });
  const member=await api(owner,'/members', {
    name:'파일을 나누는 가족',email:'upload@example.local',role:'member'
  });
  await api(owner,'/accounts', {
    member_id:member.id,password
  });
  await api(owner,'/accounts/enable', {
  });
  await api(owner,'/session', {
    email:ownerInfo.email,password
  });
  const document=await api(owner,'/pages', {
    title:'가족 파일 모음',icon:'📎',permissions: {
      default:'private',inherit:false,members: {
        [member.id]:'edit'
      },groups: {
      }
    },blocks:[ {
      id:'upload-intro',text:'가족과 나눌 파일을 한곳에 모아요.'
    }]
  });
  const pageId=document.id;
  page=await memberContext.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror',failure=>errors.push(failure.message));
  page.on('request',value=> {
    if(value.method()==='PUT'&&value.url().includes('/chunks?offset=')) {
      const record= {
        url:value.url(),type:value.headers()['content-type'],length:value.postDataBuffer()?.length
      }; record.ready=value.allHeaders().then(headers=> {
        record.contentLength=Number(headers['content-length']);
      }); chunks.push(record);
    }
  });
  await page.goto(origin+'/#page/'+pageId);
  await page.locator('#login-form [name="email"]').fill(member.email);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('#attachment-input', {
    state:'attached'
  });
  assert.equal(await page.evaluate(()=>FountainUploads.MAX_SIZE),5_000_000_000);
  assert.ok((await page.locator('[data-action="add-file"]').getAttribute('title')).includes('5 GB'));
  // Pause a real >5 MB file after one confirmed 4 MiB chunk.
  const heldSecond=await gate(memberContext,value=>value.method()==='PUT'&&value.url().endsWith('/chunks?offset='+CHUNK));
  await page.locator('#attachment-input').setInputFiles(original);
  const secondRequest=await heldSecond.held;
  const uploadId=new URL(secondRequest.url()).pathname.split('/')[3];
  await page.waitForFunction(id=>state.uploadManager?.jobs.get(id)?.offset===4*1024*1024,uploadId);
  assert.equal((await api(memberContext,'/uploads/'+uploadId)).offset,CHUNK);
  assert.equal(await page.locator('.attachment-link').count(),0);
  await mkdir('/tmp/fountain-browser', {
    recursive:true
  });
  await page.screenshot( {
    path:'/tmp/fountain-browser/uploads-desktop.png',fullPage:true
  });
  await page.setViewportSize( {
    width:390,height:844
  });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot( {
    path:'/tmp/fountain-browser/uploads-mobile.png',fullPage:true
  });
  await page.setViewportSize( {
    width:1440,height:1100
  });
  await action('upload-pause',uploadId);
  await page.waitForSelector(`.upload-card[data-upload-id="${uploadId}"][data-upload-state="paused"]`);
  assert.equal((await api(memberContext,'/uploads/'+uploadId)).offset,CHUNK);
  heldSecond.release();
  await heldSecond.remove();
  await page.reload();
  await page.waitForSelector(`.upload-card[data-upload-id="${uploadId}"][data-upload-state="reselect"]`);
  let stored=await records();
  const metadata=stored.find(value=>value.id===uploadId);
  assert.ok(metadata);
  assert.ok(JSON.stringify(metadata).length<2500);
  assert.equal(metadata.fingerprint.first.length,64);
  for(const forbidden of ['data','bytes','token','password','file'])assert.ok(!(forbidden in metadata));
  assert.equal(await page.evaluate(id=>state.uploadManager.jobs.get(id).file===null,uploadId),true);
  const beforeMismatch=chunks.length;
  await action('upload-reselect',uploadId);
  await page.locator('#attachment-input').setInputFiles(wrong);
  await page.waitForFunction(id=>state.uploadManager.jobs.get(id)?.message.includes('표본이 다릅니다'),uploadId);
  assert.equal(chunks.length,beforeMismatch);
  assert.ok((await records()).some(value=>value.id===uploadId));
  await action('upload-reselect',uploadId);
  await page.locator('#attachment-input').setInputFiles(original);
  await finish(uploadId);
  assert.equal((await api(memberContext,'/uploads/'+uploadId)).completed,true);
  assert.ok(!(await records()).some(value=>value.id===uploadId));
  const attachment=await api(memberContext,'/attachments/'+uploadId);
  assert.equal(attachment.storage,'chunks');
  assert.equal(attachment.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(attachment.size,bytes.length);
  const downloadPromise=page.waitForEvent('download');
  await page.locator(`.attachment-link[href*="${uploadId}"]`).click();
  const download=await downloadPromise;
  assert.deepEqual(await readFile(await download.path()),bytes);
  const range=await memberContext.request.get(origin+'/api/attachments/'+uploadId+'/download', {
    headers: {
      Range:`bytes=${CHUNK-7}-${CHUNK+22}`
    }
  });
  assert.equal(range.status(),206);
  assert.deepEqual(await range.body(),bytes.subarray(CHUNK-7,CHUNK+23));
  const uploadChunks=chunks.filter(value=>value.url.includes('/'+uploadId+'/'));
  assert.equal(uploadChunks.filter(value=>value.url.endsWith('offset=0')).length,1);
  await Promise.all(uploadChunks.map(value=>value.ready));
  assert.ok(uploadChunks.every(value=>value.type==='application/octet-stream'&&Number.isFinite(value.length??value.contentLength)&&(value.length??value.contentLength)<=CHUNK),JSON.stringify(uploadChunks));
  assert.ok(uploadChunks.some(value=>(value.length??value.contentLength)===CHUNK));
  // Completed bytes are not a completed attachment until the CRDT file block is acknowledged.
  const blockOperations=async route=>route.fulfill( {
    status:503,contentType:'application/json',body:JSON.stringify( {
      error:'문서 저장을 잠시 처리하지 못했습니다.'
    })
  });
  const operationsPath='**/api/pages/'+pageId+'/operations';
  await memberContext.route(operationsPath,blockOperations);
  await page.locator('#attachment-input').setInputFiles(documentRetry);
  await page.waitForFunction(()=>[...state.uploadManager.jobs.values()].some(job=>job.name==='document-retry.bin'&&job.status==='error'));
  const documentRetryId=await page.evaluate(()=>[...state.uploadManager.jobs.values()].find(job=>job.name==='document-retry.bin').id);
  assert.equal((await api(memberContext,'/uploads/'+documentRetryId)).completed,true);
  assert.ok((await records()).some(value=>value.id===documentRetryId));
  assert.equal((await api(owner,'/pages/'+pageId)).blocks.filter(block=>block.attachment_id===documentRetryId).length,0);
  assert.ok((await page.locator(`.upload-card[data-upload-id="${documentRetryId}"]`).innerText()).includes('문서 첨부가 아직 저장되지 않았습니다'));
  await memberContext.unroute(operationsPath,blockOperations);
  await action('upload-retry',documentRetryId);
  await finish(documentRetryId);
  assert.equal((await api(owner,'/pages/'+pageId)).blocks.filter(block=>block.attachment_id===documentRetryId).length,1);
  assert.ok(!(await records()).some(value=>value.id===documentRetryId));
  // A transient server error exposes retry; the next attempt reconciles the authoritative offset.
  let failures=0;
  const failChunks=async route=> {
    if(route.request().method()==='PUT'&&route.request().url().endsWith('offset=0')) {
      failures++;
      await route.fulfill( {
        status:503,contentType:'application/json',body:JSON.stringify( {
          error:'일시적인 전송 오류입니다.'
        })
      });
    }
    else await route.continue();
  };
  await memberContext.route('**/api/uploads/**',failChunks);
  await page.locator('#attachment-input').setInputFiles(small);
  await page.waitForFunction(()=>[...state.uploadManager.jobs.values()].some(job=>job.name==='retry-file.bin'&&job.status==='error'));
  assert.equal(failures,3);
  const retryId=await page.evaluate(()=>[...state.uploadManager.jobs.values()].find(job=>job.name==='retry-file.bin').id);
  await memberContext.unroute('**/api/uploads/**',failChunks);
  await action('upload-retry',retryId);
  await finish(retryId);
  // Cancel aborts an in-flight raw request and deletes the incomplete session, never adding a block.
  const heldCancel=await gate(memberContext,value=>value.method()==='PUT'&&value.url().endsWith('/chunks?offset=0'));
  await page.locator('#attachment-input').setInputFiles(cancelFile);
  const cancelRequest=await heldCancel.held,cancelId=new URL(cancelRequest.url()).pathname.split('/')[3];
  await page.evaluate(id=> {
    const manager=state.uploadManager,job=manager.jobs.get(id),original=manager.authorized.bind(manager); let held=false; manager.authorized=async()=> {
      if(!held) {
        held=true; await new Promise(resolve=>window.__releaseUploadSave=resolve);
      }
      return original();
    }; window.__lateUploadSave=manager.save(job).then(()=>( {
      saved:true
    })).catch(failure=>( {
      saved:false,name:failure.name
    })); window.__restoreUploadAuthorized=()=>manager.authorized=original;
  },cancelId);
  await action('upload-cancel',cancelId);
  await page.waitForFunction(id=>!state.uploadManager.jobs.has(id),cancelId);
  assert.equal((await request(memberContext,'/uploads/'+cancelId)).status(),404);
  assert.ok(!(await records()).some(value=>value.id===cancelId));
  await page.evaluate(()=>window.__releaseUploadSave());
  assert.equal((await page.evaluate(()=>window.__lateUploadSave)).saved,false);
  await page.evaluate(()=>window.__restoreUploadAuthorized());
  assert.ok(!(await records()).some(value=>value.id===cancelId));
  heldCancel.release();
  await heldCancel.remove();
  assert.equal((await api(owner,'/pages/'+pageId)).blocks.filter(block=>block.type==='file').length,3);
  // Navigating to another page aborts the old page's attempt and cannot attach there.
  const heldMove=await gate(memberContext,value=>value.method()==='PUT'&&value.url().endsWith('/chunks?offset=0'));
  await page.locator('#attachment-input').setInputFiles(cancelFile);
  const moveRequest=await heldMove.held,moveId=new URL(moveRequest.url()).pathname.split('/')[3];
  const other=await api(owner,'/pages', {
    title:'다른 문서',permissions: {
      default:'private',inherit:false,members: {
        [member.id]:'edit'
      },groups: {
      }
    },blocks:[ {
      id:'other-text',text:'이곳에는 다른 문서의 전송이 붙지 않습니다.'
    }]
  });
  await page.goto(origin+'/#page/'+other.id);
  await page.waitForFunction(()=>document.querySelector('#page-title')?.textContent==='다른 문서');
  heldMove.release();
  await heldMove.remove();
  assert.equal((await api(owner,'/pages/'+other.id)).blocks.filter(block=>block.type==='file').length,0);
  assert.equal(await page.locator('.upload-card').count(),0);
  assert.ok((await records()).some(value=>value.id===moveId));
  await page.goto(origin+'/#page/'+pageId);
  await page.waitForFunction(()=>document.querySelector('#page-title')?.textContent==='가족 파일 모음');
  await page.waitForSelector('#attachment-input', {
    state:'attached'
  });
  await page.waitForSelector(`.upload-card[data-upload-id="${moveId}"]`);
  await action('upload-cancel',moveId);
  await page.waitForFunction(id=>!state.uploadManager.jobs.has(id),moveId);
  // Even at 100% bytes sent, loss of edit access before finalization adds no attachment.
  const heldComplete=await gate(memberContext,value=>value.method()==='POST'&&value.url().endsWith('/complete'));
  await page.locator('#attachment-input').setInputFiles(small);
  const completeRequest=await heldComplete.held,revokedId=new URL(completeRequest.url()).pathname.split('/')[3];
  assert.equal((await api(memberContext,'/uploads/'+revokedId)).offset,CHUNK+101);
  await api(owner,'/pages/'+pageId+'/permissions', {
    permissions: {
      default:'private',inherit:false,members: {
        [member.id]:'view'
      },groups: {
      }
    }
  },'PATCH');
  await page.waitForSelector('.block-content[contenteditable="false"]');
  heldComplete.release();
  await heldComplete.remove();
  assert.equal((await request(memberContext,'/uploads/'+revokedId+'/complete', {
  })).status(),403);
  assert.equal((await api(owner,'/pages/'+pageId)).blocks.filter(block=>block.type==='file').length,3);
  assert.equal((await request(memberContext,'/attachments/'+revokedId)).status(),404);
  await api(owner,'/pages/'+pageId+'/permissions', {
    permissions: {
      default:'private',inherit:false,members: {
        [member.id]:'edit'
      },groups: {
      }
    }
  },'PATCH');
  await page.waitForSelector('.block-content[contenteditable="true"]');
  await action('settings');
  await action('logout');
  await page.waitForSelector('#login-form');
  await waitForAsync(page,async()=> {
    const db=await new Promise(resolve=> {
      const opening=indexedDB.open('fountain-upload-metadata-v1'); opening.onsuccess=()=>resolve(opening.result);
    }); const values=await new Promise(resolve=> {
      const value=db.transaction('transfers').objectStore('transfers').getAll(); value.onsuccess=()=>resolve(value.result);
    }); db.close(); return values.length===0;
  });
  await page.locator('#login-form [name="email"]').fill(member.email);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form .solid-btn').click();
  await page.waitForSelector('.block-content[contenteditable="true"]');
  assert.equal(await page.locator('.upload-card').count(),0);
  assert.equal((await api(memberContext,'/uploads/'+revokedId)).offset,CHUNK+101);
  assert.deepEqual(errors,[],'browser runtime errors');
  console.log('PASS: actual 9 MB raw chunk upload/download byte equality + range, progress/pause, refresh and matching-file resume, fingerprint mismatch, bounded503 retry, canonical attachment ACK, cancel/late-save fence, page navigation, ACL revocation before finalize, logout metadata isolation');
  console.log('Screenshots: /tmp/fountain-browser/uploads-{desktop,mobile}.png');
  console.log('Browser verification uses a 9 MB fixture; it does not claim a full 5 GB browser transfer.');
}
catch(failure) {
  if(page)await page.screenshot( {
    path:'/tmp/fountain-browser/uploads-failure.png',fullPage:true
  }).catch(()=> {
  });
  throw failure;
}
finally {
  releases.forEach(release=>release());
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
