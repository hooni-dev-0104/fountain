import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const diff=createRequire(import.meta.url)('../static/version-diff.js');
const block=(id,text='',extra={})=>({id,type:'paragraph',text,parent_id:null,...extra});
const version=(blocks,title='Page')=>({title,blocks});
const summary=extra=>({added:0,removed:0,moved:0,textChanged:0,attributesChanged:0,...extra});
function reconstruct(result,before,after){
  assert.equal(result.runs.filter(run=>run.type!=='insert').map(run=>run.text).join(''),before);
  assert.equal(result.runs.filter(run=>run.type!=='delete').map(run=>run.text).join(''),after);
  let previous=null;
  for(const run of result.runs){
    assert.ok(['equal','delete','insert'].includes(run.type));assert.ok(run.text);assert.notEqual(run.type,previous);previous=run.type;
  }
}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

if(process.argv.includes('--linear-budget-child')){
  const started=performance.now(),size=4*1024*1024,before='a'.repeat(size),after='b'.repeat(size);
  const result=diff.diffText(before,after);assert.equal(result.coarse,true);reconstruct(result,before,after);
  assert.deepEqual(result.runs.map(run=>run.type),['delete','insert']);
  const comparison=diff.compareVersions(version([block('large',before)]),version([block('large',after)]));
  assert.equal(comparison.coarse,true);assert.deepEqual(comparison.summary,summary({textChanged:1}));
  reconstruct(comparison.changes[0].textDiff,before,after);
  const prefix='가🙂'.repeat(Math.floor(size/3));
  const smallEdit=diff.diffText(prefix+'x',prefix+'y',{maxCells:16});
  assert.equal(smallEdit.coarse,false);reconstruct(smallEdit,prefix+'x',prefix+'y');
  assert.ok(performance.now()-started<10000,'large comparison exceeded its linear-work time allowance');
  console.log('PASS: 4MiB coarse reconstruction and long Unicode-prefix edit under a 64MiB V8 heap');
}else{
  assert.strictEqual(globalThis.FountainVersionDiff,diff);
  const browser={};vm.runInNewContext(readFileSync(new URL('../static/version-diff.js',import.meta.url),'utf8'),browser);
  assert.equal(typeof browser.FountainVersionDiff.compareVersions,'function');
  assert.equal(browser.FountainVersionDiff.diffText('a','b').runs.length,2);
  reconstruct(diff.diffText('<script>before</script>','<img src=x onerror=alert(1)>'),'<script>before</script>','<img src=x onerror=alert(1)>');
  assert.deepEqual(diff.diffText('',''),{runs:[],coarse:false});
  assert.deepEqual(diff.diffText('same','same'),{runs:[{type:'equal',text:'same'}],coarse:false});
  assert.deepEqual(diff.diffText('','new'),{runs:[{type:'insert',text:'new'}],coarse:false});
  assert.deepEqual(diff.diffText('old',''),{runs:[{type:'delete',text:'old'}],coarse:false});
  assert.deepEqual(diff.diffText('가🙂나','가🚀나'),{runs:[{type:'equal',text:'가'},{type:'delete',text:'🙂'},{type:'insert',text:'🚀'},{type:'equal',text:'나'}],coarse:false});
  assert.deepEqual(diff.diffText('one two one','one one'),{runs:[{type:'equal',text:'one '},{type:'delete',text:'two '},{type:'equal',text:'one'}],coarse:false});
  assert.deepEqual(diff.diffText('kitten','sitting'),{runs:[{type:'delete',text:'k'},{type:'insert',text:'s'},{type:'equal',text:'itt'},{type:'delete',text:'e'},{type:'insert',text:'i'},{type:'equal',text:'n'},{type:'insert',text:'g'}],coarse:false});
  assert.deepEqual(diff.diffText('prefixOLDsuffix','prefixNEWsuffix',{maxCells:0}),{runs:[{type:'equal',text:'prefix'},{type:'delete',text:'OLD'},{type:'insert',text:'NEW'},{type:'equal',text:'suffix'}],coarse:true});
  for(const [before,after] of [['🙂','🚀'],['\ud83d','\ud83d🙂'],['👩‍💻','👩‍🔬'],['e\u0301','é'],['a\nb','a\nc']])reconstruct(diff.diffText(before,after),before,after);

  const original=freeze(version([block('a','first'),block('b','second')]));
  const unchanged=diff.compareVersions(original,original);
  assert.deepEqual(unchanged.summary,summary());assert.equal(unchanged.titleChanged,false);assert.equal(unchanged.coarse,false);assert.equal(unchanged.changes.length,2);
  for(const change of unchanged.changes)assert.equal(change.added||change.removed||change.moved||change.textChanged||change.attributesChanged,false);
  const title=diff.compareVersions(original,version(original.blocks,'New title'));
  assert.equal(title.titleChanged,true);reconstruct(title.titleDiff,'Page','New title');assert.deepEqual(title.summary,summary());

  const inserted=diff.compareVersions(original,version([block('new','new'),...original.blocks]));
  assert.deepEqual(inserted.summary,summary({added:1}));assert.equal(inserted.changes[0].id,'new');
  assert.equal(inserted.changes[0].before,null);assert.equal(inserted.changes[0].textChanged,false);reconstruct(inserted.changes[0].textDiff,'','new');
  const removed=diff.compareVersions(version([block('a'),block('b'),block('c')]),version([block('a'),block('c')]));
  assert.deepEqual(removed.summary,summary({removed:1}));assert.deepEqual(removed.changes.map(value=>value.id),['a','b','c']);assert.equal(removed.changes[1].after,null);
  const reordered=diff.compareVersions(version([block('a'),block('b'),block('c')]),version([block('c'),block('a'),block('b')]));
  assert.deepEqual(reordered.summary,summary({moved:1}));assert.deepEqual(reordered.changes.filter(value=>value.moved).map(value=>value.id),['c']);
  const swapped=diff.compareVersions(version([block('a'),block('b'),block('c')]),version([block('b'),block('a'),block('c')]));
  assert.deepEqual(swapped.changes.filter(value=>value.moved).map(value=>value.id),['b']);
  const parentMove=diff.compareVersions(version([block('p'),block('q'),block('child','',{parent_id:'p'}),block('sibling','',{parent_id:'p'})]),version([block('p'),block('q'),block('child','',{parent_id:'q'}),block('sibling','',{parent_id:'p'})]));
  assert.deepEqual(parentMove.summary,summary({moved:1}));assert.equal(parentMove.changes.find(value=>value.id==='child').moved,true);
  const subtree=diff.compareVersions(version([block('p'),block('child','',{parent_id:'p'}),block('q')]),version([block('q'),block('p'),block('child','',{parent_id:'p'})]));
  assert.deepEqual(subtree.summary,summary({moved:1}));assert.equal(subtree.changes.find(value=>value.id==='child').moved,false);

  const rich=(id,text,tokens,extra={})=>block(id,text,{rich_text:tokens,...extra});
  const token=(text,marks={})=>({text,marks});
  const compare=(before,after)=>diff.compareVersions(version([before]),version([after]));
  // Renderer-equivalent defaults must not look reformatted after a mark is disabled.
  for(const defaults of [{bold:false},{color:'default'},{background:'default'},{link:null},{link:''},
      {italic:false},{underline:false},{strike:false},{code:false}]){
    const plain=rich('a','same',[token('same')]),disabled=rich('a','same',[token('same',defaults)]);
    assert.deepEqual(compare(plain,disabled).summary,summary(),JSON.stringify(defaults));
    assert.deepEqual(compare(disabled,plain).summary,summary(),JSON.stringify(defaults));
  }
  assert.deepEqual(compare(rich('a','old',[token('o',{bold:false}),token('l',{color:'default'}),token('d',{link:null})]),rich('a','new',[token('new')])).summary,summary({textChanged:1}));
  for(const [enabled,disabled] of [[{bold:true},{bold:false}],[{italic:true},{italic:false}],
      [{underline:true},{underline:false}],[{strike:true},{strike:false}],[{code:true},{code:false}],
      [{color:'blue'},{color:'default'}],[{background:'yellow'},{background:'default'}],
      [{link:'https://example.com'},{link:null}]]){
    assert.deepEqual(compare(rich('a','same',[token('same',enabled)]),rich('a','same',[token('same',disabled)])).summary,summary({attributesChanged:1}));
  }
  assert.deepEqual(compare(block('a','body'),block('a','new body')).summary,summary({textChanged:1}));
  assert.deepEqual(compare(rich('a','ab',[token('a',{bold:true}),token('b',{bold:true})]),rich('a','ab',[token('ab',{bold:true})])).summary,summary());
  assert.deepEqual(compare(rich('a','AB',[token('A',{bold:true}),token('B')]),rich('a','AXB',[token('A',{bold:true}),token('X',{italic:true}),token('B')])).summary,summary({textChanged:1}));
  assert.deepEqual(compare(rich('a','AwordB',[token('A'),token('word',{bold:true}),token('B')]),rich('a','AB',[token('AB')])).summary,summary({textChanged:1}));
  assert.deepEqual(compare(rich('a','abc',[token('a',{bold:true}),token('bc')]),rich('a','abc',[token('ab',{bold:true}),token('c')])).summary,summary({attributesChanged:1}));
  assert.deepEqual(compare(rich('a','old',[token('old',{bold:true})]),rich('a','new',[token('new',{italic:true})])).summary,summary({textChanged:1,attributesChanged:1}));
  assert.deepEqual(compare(block('a','',{type:'todo',checked:false}),block('a','',{type:'todo',checked:true})).summary,summary({attributesChanged:1}));
  assert.deepEqual(compare(block('a','',{attachment_id:'one',size:4}),block('a','',{attachment_id:'two',size:4})).summary,summary({attributesChanged:1}));
  assert.deepEqual(compare(block('a','body',{metadata:{a:1,b:2}}),block('a','body',{metadata:{b:2,a:1}})).summary,summary());
  assert.deepEqual(compare(rich('a','plain replacement',[token('stale',{bold:true})]),block('a','plain replacement')).summary,summary());
  const bounded=diff.compareVersions(version([block('a','foo'),block('b','foo')],''),version([block('a','bar'),block('b','bar')],''),{maxCells:16});
  assert.equal(bounded.changes[0].textDiff.coarse,false);assert.equal(bounded.changes[1].textDiff.coarse,true);assert.equal(bounded.coarse,true);

  const hostileId=compare(block('__proto__','before'),block('__proto__','after'));
  assert.equal(hostileId.changes[0].id,'__proto__');assert.equal(hostileId.changes[0].textChanged,true);
  for(const invalid of [version([block('same'),block('same')]),version([block('')]),{title:'x',blocks:[{id:2,text:''}]},{title:'x',blocks:'bad'}])assert.throws(()=>diff.compareVersions(invalid,version([])),TypeError);
  assert.throws(()=>diff.compareVersions(version([]),version([block('same'),block('same')])),TypeError);
  for(const invalid of [-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>diff.diffText('a','b',{maxCells:invalid}),TypeError);
  assert.throws(()=>diff.diffText(null,'b'),TypeError);
  const cycle={};cycle.self=cycle;assert.throws(()=>compare(block('a','',{extra:cycle}),block('a')),TypeError);
  const frozenBefore=freeze(version([rich('b','가🙂',[token('가',{bold:true}),token('🙂')],{checked:false})]));
  const frozenAfter=freeze(version([rich('b','가🚀',[token('가',{italic:true}),token('🚀')],{checked:true})]));
  const serializedBefore=JSON.stringify(frozenBefore),serializedAfter=JSON.stringify(frozenAfter);
  diff.compareVersions(frozenBefore,frozenAfter);assert.equal(JSON.stringify(frozenBefore),serializedBefore);assert.equal(JSON.stringify(frozenAfter),serializedAfter);

  let seed=8411;
  const random=limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};
  const alphabet=['a','b','가','🙂','🚀',' ','\n'];
  for(let sample=0;sample<400;sample++){
    const string=()=>Array.from({length:random(35)},()=>alphabet[random(alphabet.length)]).join('');
    const before=string(),after=string();
    for(const maxCells of [0,24,200000]){
      const result=diff.diffText(before,after,{maxCells});reconstruct(result,before,after);
      for(const run of result.runs)for(const point of run.text){const value=point.codePointAt(0);assert.ok(value<0xd800||value>0xdfff,'diff split a valid surrogate pair');}
    }
  }
  const large=spawnSync(process.execPath,['--max-old-space-size=64',fileURLToPath(import.meta.url),'--linear-budget-child'],{encoding:'utf8',timeout:15000});
  assert.equal(large.status,0,large.stderr||String(large.error));assert.match(large.stdout,/4MiB/);
  console.log('PASS: independent Unicode/LCS/title/identity/LIS/attribute/format cases, 1200 reconstruction vectors, frozen inputs and 4MiB bounded-heap regression');
}
