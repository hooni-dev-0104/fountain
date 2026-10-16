import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),C=require('../static/collaboration.js'),R=require('../static/recovery-import.js');
if(process.argv.includes('--deep-json-child')){
  const malicious='{"blocks":'+'['.repeat(1800000)+'0'+']'.repeat(1800000)+'}';
  assert.throws(()=>R.parse(malicious,{}),error=>error.code==='INVALID_RECOVERY');
  console.log('PASS: quote-aware preparse depth fence under 64MiB heap');process.exit(0);
}
const source={origin:'http://localhost:8787',workspaceId:'workspace',memberId:'member'},binding='old-binding';
const profileId=[source.origin,source.workspaceId,source.memberId,binding].join('|');
const record=(id,kind,target,body={},extra={})=>({id,profileId,resourceKey:profileId+'|'+(kind.startsWith('row.')?'database|db':target),status:'conflict',operation:{id,kind,target_id:target,body,depends_on:[],...(kind.startsWith('row.')?{database_id:'db'}:{}),...extra}});
const envelope=(records,extra={})=>({format:'fountain-recovery-v2',origin:source.origin,workspace_id:source.workspaceId,member_id:source.memberId,source_binding:binding,records,localPages:[],...extra});
const parse=value=>R.parse(JSON.stringify(value),source);
function replayFile(state,operations,pageId='old-page'){
  return envelope([record('create-'+pageId,'page.create',pageId,{title:'보존'})],{localPages:[{metadata:{page:{id:pageId}},snapshot:{epoch:'old',page:{id:pageId},state,blocks:[{id:'readable',text:'CANONICAL'}]},operations,drafts:[{draft:{epoch:'old',reason:'pending',blocks:[{id:'last',text:'LAST READABLE'}]}}]}]});
}
const pendingInsert=(text)=>({id:'pending:1',client:'pending',clock:1,type:'text.insert',block_id:'b',after_id:null,text,_epoch:'old'});
if(process.argv.includes('--rga-budget-child')){
  // Each fixture must fall back before invoking the reducer, under a bounded heap.
  const originalApply=C.applyOperations;let calls=0;C.applyOperations=()=>{calls++;throw Error('unsafe eager replay');};
  const empty=C.seedState([{id:'b',text:''}]);
  const huge='🙂'.repeat(60000),large=parse(replayFile(empty,[pendingInsert(huge)]));
  assert.equal(large.localPages[0].blocks[0].text,'LAST READABLE');
  assert.equal(JSON.parse(large.localPages[0].blocks.slice(1).map(block=>block.text).join('')).ops[0].text,huge);
  const publicHistory=(operation)=>({...empty,history:{version:1,public:true,baseline:{blocks:{}},ops:{[operation.id]:operation}}});
  const insert={id:'old:1',client:'old',clock:1,type:'text.insert',block_id:'b',after_id:null,character_count:1000000000,mark_keys:[]};
  const malformed=[{...empty,history:{version:1,baseline:{blocks:{}},ops:{'old:1':{id:'old:1',client:'old',clock:1,type:'text.insert',block_id:'b',text:huge,marks:{}}}}}, {...empty,history:{version:1,baseline:{blocks:{}},ops:{'old:1':{id:'old:1',client:'old',clock:1,type:'text.insert',block_id:'b',text:'a',marks:{bold:'x'.repeat(100000)}}}}}, publicHistory(insert),publicHistory({...insert,character_count:-1}),publicHistory({...insert,character_count:1.5}),publicHistory({...insert,character_count:50000,mark_keys:['bold','italic']}),
    publicHistory({id:'old:1',client:'old',clock:1,type:'text.format',block_id:'b',char_ids:Array(17000).fill('missing'),mark_keys:['bold','italic']}),
    publicHistory({id:'old:1',client:'old',clock:1,type:'text.delete',block_id:'b',char_ids:Array(50001).fill('missing')}),
    {...empty,blocks:'x'.repeat(2000000)}, {...empty,blocks:[]},
    {...empty,history:{baseline:{blocks:'x'.repeat(1000)},ops:{}}},
    {...empty,history:{baseline:{blocks:{}},ops:'x'.repeat(1000)}},
    {...empty,blocks:{b:{...empty.blocks.b,fields:'x'.repeat(1000)}}},
    {...empty,blocks:{b:{...empty.blocks.b,chars:{c:{stamp:[0,'seed','b'],marks:'x'.repeat(1000)}}}}},
    {...empty,blocks:{b:{...empty.blocks.b,insert:[0,'seed','x'.repeat(10000)]}}}];
  for(const unsafe of malformed){const result=parse(replayFile(unsafe,[pendingInsert('fresh')]));assert.equal(result.localPages[0].blocks[0].text,'LAST READABLE');assert.ok(result.warnings.some(warning=>warning.includes('본문 구성 범위')));assert.deepEqual(JSON.parse(result.localPages[0].blocks.slice(1).map(block=>block.text).join('')).state,JSON.parse(JSON.stringify(unsafe)));}
  const freshDeletes=parse(replayFile(empty,[{id:'pending:1',client:'pending',clock:1,type:'text.delete',block_id:'b',char_ids:Array(50001).fill('missing'),_epoch:'old'}]));assert.equal(freshDeletes.summary.replayedCodePoints,0);
  assert.equal(calls,0);C.applyOperations=originalApply;
  assert.equal(R.bodyCodePoints([{text:'한🙂👨‍👩‍👧'}]),7);assert.equal(R.bodyCodePoints([{text:huge}],{limit:50000}),50001);
  let id=0;const remapped=R.remapBlocks([{id:'raw',text:huge}],{newId:()=>String(++id)});assert.equal(remapped[0].text,huge);assert.notEqual(remapped[0].id,'raw');
  console.log('PASS: RGA amplification fence and lossless fallback under 64MiB heap');process.exit(0);
}
const rows=[record('old-create','row.create','old-row',{properties:{name:'한🙂',reference:'old-row'}}),record('old-patch','row.patch','old-row',{properties:{name:'보존'}},{depends_on:['old-create']})];
const normalized=parse(envelope(rows));assert.equal(normalized.records.length,2);assert.equal(normalized.records[0].operation.body.properties.name,'한🙂');
assert.ok(!Object.hasOwn(normalized.records[0],'result'));assert.equal(normalized.source.sourceBinding,binding);assert.equal(normalized.digest.length,64);
assert.equal(R.parse(JSON.stringify(envelope(rows),null,4),source).digest,normalized.digest);
const legacy=envelope(rows);delete legacy.origin;delete legacy.source_binding;legacy.format='fountain-mutation-recovery-v1';assert.equal(parse(legacy).source.origin,source.origin);
const forged=envelope([{...rows[0],status:'applied',result:{status:'applied',data_revision:99999},operation:{...rows[0].operation,body:{...rows[0].operation.body,permissions:[{access:4}]}}}]);
const applied=parse(forged);assert.ok(applied.warnings.some(value=>value.includes('증거')));assert.equal(applied.records[0].operation.body.permissions,undefined);assert.equal(applied.records[0].result,undefined);
for(const changed of [{...source,memberId:'other'},{...source,workspaceId:'other'},{...source,origin:'http://elsewhere.invalid'}])assert.throws(()=>R.parse(JSON.stringify(envelope(rows)),changed),error=>error.code==='IMPORT_SOURCE_MISMATCH');
const mismatched=envelope(rows);mismatched.records[0]={...rows[0],profileId:'http://evil.invalid|workspace|member|old-binding'};assert.throws(()=>parse(mismatched));
assert.throws(()=>parse(envelope([rows[0],rows[0]])));
assert.throws(()=>parse(envelope([record('a','row.patch','row',{}, {depends_on:['b']}),record('b','row.patch','row',{}, {depends_on:['a']})])));
assert.throws(()=>R.parse('{"blocks":[],"__proto__":{"polluted":true}}',source));assert.equal({}.polluted,undefined);
assert.throws(()=>R.parse('{"blocks":['+'['.repeat(40)+'0'+']'.repeat(40)+']}',source));
assert.throws(()=>R.parse(' '.repeat(16*1024*1024+1),source));
assert.throws(()=>parse(envelope(Array.from({length:1001},(_,index)=>record('op-'+index,'row.delete','row-'+index)))));
const raw={epoch:'old',ops:[{id:'old:1',client:'old',clock:1,type:'text.insert',block_id:'gone',text:'손실 없이🙂',after_id:null}]},rawText=JSON.stringify(raw,null,3);
const readable=R.parse(rawText,source);assert.equal(readable.kind,'body');assert.equal(readable.drafts[0].draft.blocks.map(block=>block.text).join(''),rawText);assert.ok(readable.warnings.some(value=>value.includes('재실행하지')));
const body=R.parse(JSON.stringify({blocks:[{id:'parent',type:'heading1',text:'한🙂'},{id:'child',type:'todo',text:'할 일',parent_id:'parent',checked:true,rich_text:[{text:'할 일',marks:{bold:true}}]}],ops:[]}),source);
let sequence=0;const built=R.buildBody(body.drafts[0].draft.blocks,{newId:()=> 'fresh-'+(++sequence),clientId:'fresh_client',epoch:'fresh-epoch'});
assert.ok(built.blocks.every(block=>!['parent','child'].includes(block.id)));assert.equal(built.blocks[1].parent_id,built.blocks[0].id);
let state=C.seedState([]);for(let offset=0;offset<built.operations.length;offset+=1000)state=C.applyOperations(state,built.operations.slice(offset,offset+1000).map(({_epoch,...operation})=>operation));assert.deepEqual(JSON.parse(JSON.stringify(C.project(state))),built.blocks);
assert.ok(Object.keys(state.blocks).every(id=>id.startsWith('fresh-')));assert.ok(Object.values(state.blocks).flatMap(block=>Object.keys(block.chars)).every(id=>id.startsWith('fresh_client:')));
const wrapped=R.wrapDraft({...source,cacheBinding:binding},'current-page',{blocks:[{id:'b',text:'본문'}],ops:[],reason:'epoch_changed'});assert.equal(parse(wrapped).drafts[0].page_id,'current-page');
const localRecord=record('page-create','page.create','old-page',{title:'새 사본'}),localState=C.seedState([{id:'old-block',text:'원래'}]);
const local=parse(envelope([localRecord],{localPages:[{metadata:{page:{id:'old-page',owner_id:'old-owner',permissions:[{access:4}]}},snapshot:{epoch:'old',page:{id:'old-page'},state:localState,blocks:C.project(localState),workspace_id:source.workspaceId,current_member_id:source.memberId,session_binding:binding},operations:[{id:'edit:1',client:'edit',clock:1,type:'text.insert',block_id:'old-block',after_id:'seed:old-block:0',text:'🙂',_epoch:'old'}],drafts:[]}]}));
assert.equal(local.localPages[0].blocks[0].text,'원🙂래');assert.equal(local.localPages[0].owner_id,undefined);
const tabs=envelope([localRecord],{localPages:[{metadata:{page:{id:'old-page'}},snapshot:{epoch:'old',page:{id:'old-page'},state:localState,blocks:C.project(localState)},operations:[{id:'tabA:1',client:'tabA',clock:1,type:'text.insert',block_id:'old-block',after_id:'seed:old-block:0',text:'A',_epoch:'old'},{id:'tabB:1',client:'tabB',clock:1,type:'text.insert',block_id:'old-block',after_id:'seed:old-block:0',text:'B',_epoch:'old'}],drafts:[{updatedAt:10,draft:{epoch:'old',reason:'pending',blocks:[{id:'old-block',text:'원A래'}]}}]}]});
const union=parse(tabs);assert.equal(union.localPages[0].blocks[0].text,'원BA래','a last-view draft from tab A cannot drop tab B durable operations');
const mixed=structuredClone(tabs);mixed.localPages[0].operations[1]._epoch='different-epoch';const mixedParsed=parse(mixed);
assert.equal(mixedParsed.localPages[0].blocks[0].text,'원A래');assert.ok(mixedParsed.warnings.some(value=>value.includes('다른 문서 버전')));
assert.ok(mixedParsed.localPages[0].blocks.filter(block=>block.type==='code').map(block=>block.text).join('').includes('different-epoch'));

assert.throws(()=>parse(envelope([localRecord])));
const largeOps=JSON.stringify({ops:[{id:'old:1',text:'x'.repeat(150000)}]});const large=R.parse(largeOps,source);assert.equal(large.drafts[0].draft.blocks.map(block=>block.text).join(''),largeOps);assert.ok(large.drafts[0].draft.blocks.length>1);
// Captured independently from the real pre-import Controller.export at commit 5563368,
// using Chrome and an isolated SQLite workspace rather than this new serializer.
const goldenText=await readFile(new URL('./fixtures/recovery-v1.json',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(goldenText).digest('hex'),'cc3eeb7253a157dd6a0fe8c013a17dbaf48d8089c5d2f0dea9f7c8ca0400f63a');
const goldenFile=JSON.parse(goldenText),goldenSource=goldenFile.records[0].profileId.split('|');
const golden=R.parse(goldenText,{origin:goldenSource[0],workspaceId:decodeURIComponent(goldenSource[1]),memberId:decodeURIComponent(goldenSource[2])});
assert.equal(golden.records.length,11);assert.equal(golden.localPages.length,2);assert.equal(golden.summary.blocks,4);
assert.ok(golden.localPages.every(page=>page.blocks.some(block=>block.text==='복구할 본문 한글과 emoji 👨‍👩‍👧\n둘째 줄 & <plain text>')));
const nested=spawnSync(process.execPath,['--max-old-space-size=64',fileURLToPath(import.meta.url),'--deep-json-child'],{encoding:'utf8',timeout:10000});
assert.equal(nested.status,0,nested.stderr);assert.match(nested.stdout,/preparse depth fence/);
const quotedBody='literal [{\"nested\":\"}\\\"[\"}]';assert.equal(parse({blocks:[{id:'quoted',text:quotedBody}]}).drafts[0].draft.blocks[0].text,quotedBody);
const budgetChild=spawnSync(process.execPath,['--max-old-space-size=64',fileURLToPath(import.meta.url),'--rga-budget-child'],{encoding:'utf8',timeout:30000});
assert.equal(budgetChild.status,0,budgetChild.stderr);assert.match(budgetChild.stdout,/RGA amplification fence/);
const firstBudget=replayFile(C.seedState([{id:'b',text:''}]),[pendingInsert('A'.repeat(26000))],'first-budget');
const secondBudget=replayFile(C.seedState([{id:'b',text:''}]),[pendingInsert('B'.repeat(26000))],'second-budget');
const shared=parse(envelope([...firstBudget.records,...secondBudget.records],{localPages:[...firstBudget.localPages,...secondBudget.localPages]}));
assert.equal(shared.summary.replayedCodePoints,26000);assert.equal(shared.localPages[0].blocks[0].text,'A'.repeat(26000));assert.equal(shared.localPages[1].blocks[0].text,'LAST READABLE');assert.equal(JSON.parse(shared.localPages[1].blocks.slice(1).map(block=>block.text).join('')).ops[0].text,'B'.repeat(26000));
// Parse failure cannot permanently cancel already-scheduled normal edits.
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{};
const timerProfile={id:'timer-profile',origin:source.origin,workspaceId:source.workspaceId,memberId:source.memberId,cacheBinding:binding,session:{member:{id:source.memberId,role:'owner'}}};
globalThis.FountainOffline={getProfile:async()=>timerProfile,listMutations:async()=>[{id:'existing',status:'pending'}],stageRecoveryImport:async()=>{}};
globalThis.FountainTransport={origin:source.origin};require('../static/mutations.js');
const timerController=new FountainMutations.Controller({profile:timerProfile});let syncCalls=0;timerController.sync=async()=>{syncCalls++;};
timerController.schedule(25);await assert.rejects(timerController.prepareImport('{'));await new Promise(resolve=>setTimeout(resolve,80));assert.equal(syncCalls,1);timerController.close();
console.log('PASS: recovery v1/v2 source bounds, normalized digest, ignored receipts/ACL, graph limits, raw JSON preservation, fresh Unicode/format RGA body and parent mapping');
