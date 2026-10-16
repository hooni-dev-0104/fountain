/** Opt-in full-size Chrome transfer; the entire file never enters a JS buffer. */
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,open,rm,stat,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FOUNTAIN_PLAYWRIGHT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const repository=dirname(dirname(fileURLToPath(import.meta.url)));
const size=Number(process.argv[2]||5_000_000_000),reportPath=process.argv[3];
assert.ok(Number.isSafeInteger(size)&&size>0&&size<=5_000_000_000);
const folder=await mkdtemp(join(tmpdir(),'fountain-real-browser-file-'));
const original=join(folder,'실제 대용량 검증.bin');
const descriptor=await open(original,'w');await descriptor.truncate(size);await descriptor.close();
const expected=createHash('sha256');for await(const block of createReadStream(original,{highWaterMark:65536}))expected.update(block);
const digest=expected.digest('hex'),environment={...process.env};delete environment.FOUNTAIN_ACCESS_TOKEN;
let server,browser;const started=Date.now();
try{
  server=spawn(process.env.FOUNTAIN_PYTHON||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),['-m','fountain.server','--port','0','--data',join(folder,'workspace.db')],{cwd:repository,env:environment,stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Server startup timeout: '+output)),15000);
    const consume=chunk=>{output+=chunk;const match=output.match(/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};
    server.stdout.on('data',consume);server.stderr.on('data',consume);server.once('error',reject);
  });
  browser=await chromium.launch(process.env.FOUNTAIN_CHROME?{executablePath:process.env.FOUNTAIN_CHROME,headless:true}:{channel:'chrome',headless:true});
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[];
  const sourceHashes={};
  for(const asset of ['app.js','uploads.js']){
    const source=await context.request.get(origin+'/'+asset);assert.equal(source.status(),200);
    sourceHashes[asset]=createHash('sha256').update(await source.body()).digest('hex');
  }
  page.on('pageerror',failure=>errors.push(failure.message));
  const created=await context.request.post(origin+'/api/pages',{headers:{'X-Fountain-Request':'1'},data:{title:'실제 대용량 브라우저 검증',blocks:[]}});
  assert.equal(created.status(),201);const document=await created.json();
  await page.goto(origin+'/#page/'+document.id);await page.waitForSelector('#attachment-input',{state:'attached'});
  await page.locator('#attachment-input').setInputFiles(original);
  let peakHeap=0,lastReported=-1;
  const deadline=Date.now()+15*60_000;
  while(Date.now()<deadline){
    const progress=await page.evaluate(()=>({job:state.uploadManager?.view().at(-1)||null,heap:performance.memory?.usedJSHeapSize||null}));
    if(progress.heap)peakHeap=Math.max(peakHeap,progress.heap);
    const completed=progress.job?.offset||0;
    if(Math.floor(completed/500_000_000)!==lastReported){lastReported=Math.floor(completed/500_000_000);console.log(JSON.stringify({phase:'browser-upload',bytes:completed,total:size,status:progress.job?.status,seconds:(Date.now()-started)/1000}));}
    if(progress.job?.status==='done')break;
    if(['error','denied'].includes(progress.job?.status))throw new Error(JSON.stringify(progress.job));
    await page.waitForTimeout(200);
  }
  assert.equal(await page.locator('[data-upload-state="done"]').count(),1,'upload did not finish');
  const response=await context.request.get(origin+'/api/pages/'+document.id);const detail=await response.json();
  const attachmentBlock=detail.blocks.find(block=>block.type==='file');assert.ok(attachmentBlock);
  const metadata=await (await context.request.get(origin+'/api/attachments/'+attachmentBlock.attachment_id)).json();
  assert.equal(metadata.size,size);assert.equal(metadata.sha256,digest);
  console.log(JSON.stringify({phase:'browser-download',size,sha256:digest}));
  const waiting=page.waitForEvent('download',{timeout:15*60_000});await page.locator('.attachment-link').click();const download=await waiting;
  const saved=await download.path();assert.ok(saved);assert.equal((await stat(saved)).size,size);
  const actual=createHash('sha256');for await(const block of createReadStream(saved,{highWaterMark:65536}))actual.update(block);
  assert.equal(actual.digest('hex'),digest);assert.deepEqual(errors,[]);
  const report={size,sha256:digest,browser_upload:true,browser_download:true,server_document_reference:true,browser_js_heap_peak_bytes:peakHeap||null,source_hashes:sourceHashes,seconds:(Date.now()-started)/1000};
  if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({phase:'passed',...report}));
}finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null){server.kill('SIGINT');await new Promise(resolve=>server.once('exit',resolve));}
  await rm(folder,{recursive:true,force:true});
}
