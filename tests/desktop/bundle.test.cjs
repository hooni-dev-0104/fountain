'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const builder=import('../../apps/desktop/build.mjs');
const assets=import('../../apps/web/build.mjs');
const expected=['app.js','backup.js','collaboration.js','index.html','mutations.js','offline.js','presence.js','public.js','recovery-import.js','style.css','sw.js','transport.js','uploads.js','version-diff.js'];
async function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fountain-desktop-bundle-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'static'),destination=path.join(root,'bundle');fs.mkdirSync(source);fs.mkdirSync(destination);
  for(const name of expected)fs.writeFileSync(path.join(source,name),'public '+name+' 한글🙂\n');
  fs.writeFileSync(path.join(destination,'old-marker'),'preserve old bundle');
  return {root,source,destination,build:(await builder).createBuilder({source,destination})};
}
function preserved(f){assert.equal(fs.readFileSync(path.join(f.destination,'old-marker'),'utf8'),'preserve old bundle');}

test('desktop output contains only reviewed public bytes and a versioned MIME/SHA manifest',async t=>{
  const f=await fixture(t);assert.deepEqual([...(await assets).ASSETS],expected);
  fs.mkdirSync(path.join(f.source,'.data'));fs.writeFileSync(path.join(f.source,'.data','password'),'private canary');
  fs.mkdirSync(path.join(f.source,'api'));fs.writeFileSync(path.join(f.source,'api','public-relay.mjs'),'not desktop code');
  for(const name of ['vercel.json','app.js.map','private.sqlite','source.ts'])fs.writeFileSync(path.join(f.source,name),'never bundle');
  const result=await f.build(),manifest=JSON.parse(fs.readFileSync(path.join(f.destination,'manifest.json'),'utf8'));
  assert.deepEqual(result.manifest,manifest);assert.equal(result.destination,f.destination);
  assert.deepEqual(fs.readdirSync(f.destination).sort(),[...expected,'manifest.json'].sort());
  assert.deepEqual(Object.keys(manifest).sort(),['files','version']);assert.equal(manifest.version,1);
  assert.deepEqual(manifest.files.map(file=>file.name),expected);
  for(const file of manifest.files){
    const bytes=fs.readFileSync(path.join(f.destination,file.name));
    assert.deepEqual(Object.keys(file).sort(),['mime','name','sha256','size']);
    assert.deepEqual(bytes,fs.readFileSync(path.join(f.source,file.name)));
    assert.equal(file.size,bytes.length);assert.equal(file.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.mime,{'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'}[path.extname(file.name)]);
  }
  assert.equal(fs.existsSync(path.join(f.destination,'old-marker')),false);
  const first=fs.readFileSync(path.join(f.destination,'manifest.json'));await f.build();
  assert.deepEqual(fs.readFileSync(path.join(f.destination,'manifest.json')),first);
  assert.deepEqual(fs.readdirSync(f.root).sort(),['bundle','static']);
});
test('missing, directory and oversized source assets preserve the old bundle',async t=>{
  for(const type of ['missing','directory','oversized']){
    const f=await fixture(t),asset=path.join(f.source,'app.js');fs.unlinkSync(asset);
    if(type==='directory')fs.mkdirSync(asset);
    if(type==='oversized'){fs.writeFileSync(asset,'');fs.truncateSync(asset,4*1024*1024+1);}
    await assert.rejects(f.build(),undefined,type);preserved(f);
  }
});
test('source symlinks, linked source roots and linked source parents are refused before replacement',async t=>{
  if(process.platform==='win32')return t.skip('Symlink fixture needs an enabled Windows developer mode');
  for(const type of ['asset','root','parent']){
    const f=await fixture(t);let source=f.source;
    if(type==='asset'){const file=path.join(source,'app.js');fs.renameSync(file,path.join(f.root,'outside.js'));fs.symlinkSync(path.join(f.root,'outside.js'),file);}
    else if(type==='root'){source=path.join(f.root,'source-link');fs.symlinkSync(f.source,source,'dir');}
    else{const link=path.join(f.root,'parent-link');fs.symlinkSync(f.root,link,'dir');source=path.join(link,'static');}
    await assert.rejects((await builder).createBuilder({source,destination:f.destination})());preserved(f);
  }
});
test('output symlinks, regular files and linked parents are refused without deleting their target',async t=>{
  for(const type of ['file',...(process.platform==='win32'?[]:['link','broken-link','parent'])]){
    const f=await fixture(t);let destination=f.destination;
    if(type==='file'){fs.rmSync(destination,{recursive:true});fs.writeFileSync(destination,'keep regular file');}
    else if(type==='parent'){const link=path.join(f.root,'output-parent');fs.symlinkSync(f.root,link,'dir');destination=path.join(link,'bundle');}
    else{destination=path.join(f.root,'output-link');fs.symlinkSync(type==='link'?f.destination:path.join(f.root,'absent'),destination,'dir');}
    await assert.rejects((await builder).createBuilder({source:f.source,destination})());
    if(type==='file')assert.equal(fs.readFileSync(destination,'utf8'),'keep regular file');else preserved(f);
  }
});
test('total input limit rejects otherwise valid files before touching an old bundle',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(Math.floor(16*1024*1024/14)+1,120);
  for(const name of expected)fs.writeFileSync(path.join(f.source,name),bytes);
  await assert.rejects(f.build(),/too large/);preserved(f);
});
test('CLI rejects output arguments and pack/start rebuild only through the fixed builder',()=>{
  const script=path.resolve(__dirname,'../../apps/desktop/build.mjs');
  const result=spawnSync(process.execPath,[script,'--output','/not-an-output'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/accepts no arguments/);
  const desktop=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../apps/desktop/package.json'),'utf8'));
  assert.equal(desktop.scripts.build,'node build.mjs');assert.equal(desktop.scripts.prestart,'node build.mjs');
  const pack=fs.readFileSync(path.resolve(__dirname,'../../apps/desktop/pack.cjs'),'utf8');
  assert.ok(pack.indexOf('await build()')<pack.indexOf('await packager('));assert.ok(pack.includes('/^\\/build\\.mjs$/'));
});
test('failed publication restores the complete old bundle and leaves no partial new destination',async t=>{
  for(const hadOld of [true,false]){
    const f=await fixture(t),failure=Error('injected publish rename failure');if(!hadOld)fs.rmSync(f.destination,{recursive:true});
    const publish=(await builder).createBuilder({source:f.source,destination:f.destination,renameDirectory:async(from,to)=>{
      if(path.basename(from).startsWith('.fountain-bundle-')&&to===f.destination){
        assert.equal(fs.existsSync(f.destination),false);assert.equal(fs.existsSync(f.destination+'.previous'),hadOld);
        if(hadOld)assert.equal(fs.readFileSync(path.join(f.destination+'.previous','old-marker'),'utf8'),'preserve old bundle');
        throw failure;
      }
      return fs.promises.rename(from,to);
    }});
    await assert.rejects(publish(),error=>error===failure);
    if(hadOld){preserved(f);assert.deepEqual(fs.readdirSync(f.destination),['old-marker']);}else assert.equal(fs.existsSync(f.destination),false);
    assert.equal(fs.existsSync(f.destination+'.previous'),false);
    assert.deepEqual(fs.readdirSync(f.root).sort(),hadOld?['bundle','static']:['static']);
  }
});
test('restore failure retains the old backup and original cause; next build restores a missing destination',async t=>{
  const f=await fixture(t),failure=Error('publish failed'),restoreFailure=Error('restore failed'),previous=f.destination+'.previous';
  const publish=(await builder).createBuilder({source:f.source,destination:f.destination,renameDirectory:async(from,to)=>{
    if(path.basename(from).startsWith('.fountain-bundle-'))throw failure;
    if(from===previous&&to===f.destination)throw restoreFailure;
    return fs.promises.rename(from,to);
  }});
  await assert.rejects(publish(),error=>error instanceof AggregateError&&error.cause===failure&&error.errors.includes(failure)&&error.errors.includes(restoreFailure));
  assert.equal(fs.existsSync(f.destination),false);assert.equal(fs.readFileSync(path.join(previous,'old-marker'),'utf8'),'preserve old bundle');
  assert.deepEqual(fs.readdirSync(f.root).sort(),['bundle.previous','static']);
  fs.unlinkSync(path.join(f.source,'app.js'));await assert.rejects(f.build());
  preserved(f);assert.equal(fs.existsSync(previous),false);assert.deepEqual(fs.readdirSync(f.root).sort(),['bundle','static']);
});
test('ambiguous crash residue and non-directory backups fail closed and preserve both outputs',async t=>{
  for(const type of ['directory','file',...(process.platform==='win32'?[]:['link'])]){
    const f=await fixture(t),previous=f.destination+'.previous';
    if(type==='directory'){fs.mkdirSync(previous);fs.writeFileSync(path.join(previous,'prior-marker'),'retain previous');}
    else if(type==='file')fs.writeFileSync(previous,'retain previous');
    else fs.symlinkSync(f.destination,previous,'dir');
    await assert.rejects(f.build());preserved(f);
    if(type==='directory')assert.equal(fs.readFileSync(path.join(previous,'prior-marker'),'utf8'),'retain previous');
    if(type==='file')assert.equal(fs.readFileSync(previous,'utf8'),'retain previous');
    if(type==='link')assert.equal(fs.lstatSync(previous).isSymbolicLink(),true);
  }
});

test('crash stages are retained for review and block packaging after the previous bundle is restored',async t=>{
  const f=await fixture(t),previous=f.destination+'.previous',stage=path.join(f.root,'.fountain-bundle-interrupted');
  fs.renameSync(f.destination,previous);fs.mkdirSync(stage);fs.writeFileSync(path.join(stage,'app.js'),'interrupted public bytes');
  await assert.rejects(f.build(),/stage requires review/);preserved(f);
  assert.equal(fs.existsSync(previous),false);assert.equal(fs.readFileSync(path.join(stage,'app.js'),'utf8'),'interrupted public bytes');
  assert.deepEqual(fs.readdirSync(f.destination),['old-marker']);
});
