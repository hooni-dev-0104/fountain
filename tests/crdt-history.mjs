import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const crdt=createRequire(import.meta.url)('../static/collaboration.js');
const plain=value=>JSON.parse(JSON.stringify(value));
const op=(client,clock,type,fields={})=>({id:client+':'+clock,client,clock,type,...(type==='history.cancel'?{}:{block_id:'b'}),...fields});
const cancel=(client,clock,...targets)=>op(client,clock,'history.cancel',{targets});
function* permutations(values){if(!values.length){yield [];return;}for(let i=0;i<values.length;i++)for(const tail of permutations(values.filter((_,j)=>i!==j)))yield [values[i],...tail];}
function converge(initial,operations,expected){
  const reference=crdt.applyOperations(initial,operations);
  assert.deepEqual(plain(crdt.project(reference)),expected);
  for(const order of permutations(operations)){
    let state=initial;for(const operation of order)state=crdt.applyOperations(state,[operation]);
    assert.deepEqual(plain(state),plain(reference));
    assert.deepEqual(plain(crdt.project(crdt.publicState(state))),expected);
  }
  return reference;
}
const seed=crdt.seedState([{id:'b',text:'x'}]);
const block=(text,type='paragraph')=>[{id:'b',type,parent_id:null,text,rich_text:text?[{text,marks:{}}]:[]}];
const heading=op('a',3,'block.set',{field:'type',value:'heading1'}),quote=op('b',2,'block.set',{field:'type',value:'quote'}),undo=cancel('a',4,'a:3');
const undone=converge(seed,[heading,quote,undo],block('x','quote'));
assert.equal(crdt.project(crdt.applyOperations(undone,[cancel('a',5,'a:4')]))[0].type,'heading1');
const deletionA=op('a',1,'text.delete',{char_ids:['seed:b:0']}),deletionB=op('b',2,'text.delete',{char_ids:['seed:b:0']});
const deleted=converge(seed,[deletionA,deletionB,cancel('a',3,'a:1')],block(''));
assert.equal(crdt.visibleChars(crdt.applyOperations(deleted,[cancel('b',4,'b:2')]),'b')[0].id,'seed:b:0');
const inserted=op('a',1,'text.insert',{after_id:null,text:'xy'}),foreign=op('b',2,'text.insert',{after_id:'a:1:0',text:'Z'});
const anchored=converge(crdt.seedState([{id:'b',text:''}]),[inserted,foreign,cancel('a',3,'a:1')],block('Z'));
assert.equal(crdt.project(crdt.applyOperations(anchored,[cancel('a',4,'a:3')]))[0].text,'xZy');
const file=[op('a',1,'block.insert',{block_type:'file',group_id:'birth'}),op('a',2,'block.set',{field:'attachment_id',value:'file-1',group_id:'birth'}),op('a',3,'block.set',{field:'size',value:7,group_id:'birth'}),op('a',4,'text.insert',{text:'filename',group_id:'birth'})];
const protectedFile=crdt.applyOperations(crdt.seedState([]),[...file,op('b',1,'text.insert',{text:'remote'}),cancel('a',5,...file.map(value=>value.id))]);
assert.deepEqual(plain(crdt.project(protectedFile)),[{id:'b',type:'file',attachment_id:'file-1',size:7,parent_id:null,text:'remote',rich_text:[{text:'remote',marks:{}}]}]);
const hidden=crdt.applyOperations(crdt.seedState([]),[...file,cancel('a',5,...file.map(value=>value.id))]);assert.deepEqual(crdt.project(hidden),[]);
const parentOps=[op('a',1,'block.insert',{block_id:'parent',block_type:'heading1',group_id:'parentBirth'}),op('a',2,'text.insert',{block_id:'parent',text:'initial',group_id:'parentBirth'}),op('b',1,'block.insert',{block_id:'child',parent_id:'parent'}),cancel('a',3,'a:1','a:2')];
const parentExpected=[{id:'parent',type:'heading1',parent_id:null,text:'',rich_text:[]},{id:'child',type:'paragraph',parent_id:'parent',text:'',rich_text:[]}];
const parentState=converge(crdt.seedState([]),parentOps,parentExpected);
const parentDeleted=crdt.applyOperations(parentState,[op('b',4,'block.delete',{block_id:'parent'})]);assert.deepEqual(crdt.project(parentDeleted).map(value=>[value.id,value.parent_id]),[['child',null]]);
const pendingPlaceholder=crdt.applyOperations(crdt.seedState([]),[op('b',2,'block.set',{field:'checked',value:true})]);assert.deepEqual(crdt.project(pendingPlaceholder),[]);
const cycleOps=[op('a',1,'block.insert',{block_id:'left',parent_id:'right',group_id:'leftBirth'}),op('a',2,'block.insert',{block_id:'right',parent_id:'left',group_id:'rightBirth'}),cancel('a',3,'a:1','a:2')];
converge(crdt.seedState([]),cycleOps,[]);
const marked=crdt.applyOperations(seed,[op('a',1,'text.delete',{char_ids:['seed:b:0']}),op('b',2,'text.format',{char_ids:['seed:b:0'],marks:{bold:true}}),cancel('a',3,'a:1')]);assert.equal(crdt.visibleChars(marked,'b')[0].marks.bold,true);
const positionState=crdt.applyOperations(crdt.seedState([{id:'b',text:''},{id:'p',text:''}]),[op('a',3,'block.move',{parent_id:'p',after_id:null}),op('b',2,'block.move',{parent_id:null,after_id:'p'})]);
const unknownPosition=crdt.applyOperations(crdt.publicState(positionState),[cancel('a',4,'a:3')]);assert.equal(unknownPosition.unresolved_slots[0].kind,'position');assert.equal(crdt.capturePublicHints(unknownPosition).has(crdt.canonical(['b','position',null,null,null,[2,'b','b:2']])),false);
const before=crdt.applyOperations(seed,[heading,quote]),publicBefore=crdt.publicState(before),unknown=crdt.applyOperations(publicBefore,[undo]);
assert.equal(unknown.unresolved_slots.length,1);assert.equal(unknown.unresolved_slots[0].field,'type');assert.deepEqual(unknown.unresolved_slots[0].source,[2,'b','b:2']);
assert.equal(crdt.capturePublicHints(unknown).has(crdt.canonical(['b','field','type',null,null,[2,'b','b:2']])),false);
const knownQuote=crdt.capturePublicHints(crdt.publicState(crdt.applyOperations(seed,[quote])));
const hydrated=crdt.hydratePublicState(unknown,knownQuote);assert.deepEqual(hydrated.unresolved_slots,[]);assert.equal(crdt.project(hydrated.state)[0].type,'quote');
const privacy=JSON.stringify(crdt.publicState(protectedFile));assert.ok(!privacy.includes('filename'));assert.ok(!privacy.includes('"value":"file-1"',privacy.indexOf('"history"')));assert.ok(!privacy.includes('"block_type"'));
const pristinePublic=crdt.publicState(seed);assert.equal(pristinePublic.history.public,true);assert.deepEqual(crdt.hydratePublicState(pristinePublic).unresolved_slots,[]);
let chain=crdt.seedState([{id:'b',text:''}]);const chainOps=[op('a',1,'text.insert',{text:'safe'})];for(let clock=2;clock<=2002;clock++)chainOps.push(cancel('a',clock,'a:'+(clock-1)));for(let start=0;start<chainOps.length;start+=1000)chain=crdt.applyOperations(chain,chainOps.slice(start,start+1000));assert.equal(crdt.project(chain)[0].text,'');
for(const invalid of [cancel('a',4,'b:1'),cancel('a',4,'a:4'),cancel('a',4,'a:01'),cancel('a',4,'a:1','a:1'),{...undo,block_id:'b'},{...heading,group_id:''}])assert.throws(()=>crdt.applyOperations(seed,[invalid]));
console.log('PASS: history cancellation permutations, same-ID deletes, anchored remote text, file shells, redaction, exact hydration, legacy public upgrade, 2002-node DAG and validation');
