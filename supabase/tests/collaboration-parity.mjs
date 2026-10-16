/** Actual Python collaboration/reducer oracle vs the cloud stage-only port.
 * Local test runtime only: no production process, network, Auth or database.
 * FOUNTAIN_PYTHON selects Python; the oracle's SQLite database is :memory:.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Access} from '../functions/_shared/access.ts';
import {Collaboration} from '../functions/_shared/collaboration.ts';
import {Workspace} from '../functions/_shared/core.ts';
import * as c from '../functions/_shared/crdt.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),plain=value=>JSON.parse(JSON.stringify(value)),copy=structuredClone;
const fixed='2026-10-16T00:00:00.000000+00:00';
const op=(client,clock,type='text.insert',fields={})=>({id:client+':'+clock,client,clock,type,...type==='history.cancel'?{}:{block_id:'text'},...fields});
const cancel=(client,clock,...targets)=>op(client,clock,'history.cancel',{targets});
const snapshot=(actor='local')=>({action:'snapshot',actor});
const send=(actor,ops,extra={})=>({action:'apply',actor,ops,...extra});
const basePage={id:'p',title:'제목 😀',owner_id:'local',revision:0,locked:false,archived:false,permissions:{default:'private',members:{alice:'edit',bob:'edit',reader:'view',guest:'comment'}},blocks:[{id:'text',text:'원본한🙂'}]};
const initial=[
 ['member',{id:'local',role:'owner',name:'소유자',active:true}],['member',{id:'alice',role:'member',name:'같은 이름',active:true}],['member',{id:'bob',role:'member',name:'같은 이름',active:true}],['member',{id:'reader',role:'member',active:true}],['member',{id:'guest',role:'guest',active:true}],
 ['group',{id:'family',members:['alice']}],['page',basePage],['attachment',{id:'secret',owner_id:'local',name:'비공개',size:0}],['attachment',{id:'allowed',owner_id:'alice',name:'첨부',size:0}]
];
const cases=[];const add=(name,steps,overrides={})=>cases.push({name,steps,initial,...overrides});
const edit=op('a',1,'text.insert',{text:'추가',after_id:null});
add('owned undo redo, foreign exact replay and id collision',[snapshot(),send('alice',[edit]),send('bob',[edit]),send('bob',[op('a',2,'text.insert',{text:'탈취'})]),send('local',[cancel('a',2,'a:1')]),send('alice',[cancel('a',2,'a:1')]),send('alice',[cancel('a',2,'a:1')]),send('alice',[cancel('a',3,'a:2')]),send('alice',[{...edit,text:'변조'}]),snapshot('reader')]);
add('remote text survives cancel and redo',[snapshot(),send('alice',[edit]),send('bob',[op('b',1,'text.insert',{after_id:'a:1:0',text:'REMOTE'})]),send('alice',[cancel('a',2,'a:1')]),send('alice',[cancel('a',3,'a:2')])]);
add('missing history target and invalid mixed batch rollback',[snapshot(),send('alice',[edit,cancel('a',3,'a:2')]),send('alice',[edit,op('a',2,'text.format',{char_ids:['seed:text:0'],marks:{link:'javascript:alert(1)'}})]),snapshot()]);
add('same-batch reverse cancel and grouped late writes',[snapshot(),send('alice',[cancel('a',2,'a:1'),edit]),send('alice',[op('a',3,'block.set',{field:'type',value:'heading_1',group_id:'birth'})]),send('bob',[op('a',4,'block.set',{field:'checked',value:true,group_id:'birth'})])]);
add('current resource levels locks archive and stale epoch',[snapshot('reader'),send('reader',[edit]),send('guest',[edit]),send('alice',[],{epoch:'stale'}),{action:'patch-page',body:{locked:true}},send('alice',[edit]),{action:'patch-page',body:{locked:false,archived:true}},send('alice',[edit]),snapshot('reader')]);
add('history window records once and captures current title',[snapshot(),send('alice',[edit],{at:100}),send('alice',[op('a',2,'text.insert',{text:'둘째'})],{at:110}),{action:'patch-page',body:{title:'현재 제목'}},send('bob',[op('b',1,'text.insert',{text:'30초후'})],{at:140})]);
add('cancel revealing forbidden attachment is fully rolled back',[snapshot(),send('local',[op('owner',1,'block.set',{field:'attachment_id',value:'secret'})]),send('alice',[op('family',2,'block.set',{field:'attachment_id',value:null})]),send('alice',[cancel('family',3,'family:2')]),snapshot()]);
add('client hints never become private contents',[snapshot(),send('alice',[edit]),send('alice',[cancel('a',2,'a:1')],{hints:{text:'FORGED',attachment_id:'secret'}})]);
add('missing tracked owner cannot be acquired by owner role or replay',[snapshot(),send('alice',[edit]),{action:'patch-document',body:{op_owners:{}}},send('local',[edit]),send('local',[op('a',2,'text.insert',{text:'takeover'})]),send('local',[cancel('a',2,'a:1')])]);
add('legacy replay has zero metadata/history/audit writes',[snapshot(),send('alice',[edit]),{action:'legacy-document'},send('bob',[edit]),send('bob',[op('a',2,'text.insert',{text:'new tracked'})]),send('alice',[op('a',3,'text.insert',{text:'client stolen'})])]);
add('replacement and version restore fence old epochs',[snapshot(),send('alice',[edit]),{action:'save',actor:'local',blocks:[{id:'text',text:'교체',rich_text:[{text:'교체',marks:{bold:true}}]}]},send('alice',[op('a',2,'text.insert',{text:'stale'})],{useInitialEpoch:true}),snapshot(),{action:'restore',actor:'local',version:'generated-1'},snapshot()]);
add('current principal deactivation and member grant revocation',[snapshot(),{action:'patch-member',id:'alice',body:{active:false}},send('alice',[edit]),{action:'patch-page',body:{permissions:{default:'private'}}},send('bob',[op('b',1,'text.insert',{text:'denied'})]),snapshot('bob')]);
const file=[op('create',1,'block.insert',{block_id:'file',block_type:'file',group_id:'birth'}),op('create',2,'block.set',{block_id:'file',field:'attachment_id',value:'allowed',group_id:'birth'}),op('create',3,'text.insert',{block_id:'file',text:'filename',group_id:'birth'})];
add('creation shell protects remote contribution and retains attachment',[snapshot(),send('alice',file),send('bob',[op('remote',1,'text.insert',{block_id:'file',text:'REMOTE'})]),send('alice',[cancel('create',4,...file.map(op=>op.id))]),snapshot('reader')]);
add('batch validation of boolean, Unicode, cancellation and group',[snapshot(),...[
 {...edit,clock:true,id:'a:true'},{...edit,text:'\ud800'},op('x',1,'block.set',{field:'checked',value:1}),cancel('x',2,'x:01'),cancel('x',2,'x:1','x:1'),{...cancel('x',2,'x:1'),block_id:'text'},{...edit,group_id:''},{...edit,marks:null}
].map(operation=>send('alice',[operation]))]);

class MemoryStore{
 constructor(records){this.records=new Map();this.metadata=new Map([['workspace_id','test-workspace'],['access_revision',2]]);this.requestTime=fixed;this.context={memberId:'local'};this.ids=0;for(const [kind,raw]of records){const data=copy(raw);if(kind==='page')data.blocks=c.normalize_blocks(data.blocks||[]);this.put(kind,data);}}
 allocate_id(){return 'generated-'+(++this.ids);}
 get(kind,id){return typeof id==='string'?copy(this.records.get(JSON.stringify([kind,id]))||null):null;}
 list(kind){return Array.from(this.records).filter(([key])=>JSON.parse(key)[0]===kind).map(([,data])=>copy(data)).sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));}
 put(kind,input){const data=copy(input),id=data.id||this.allocate_id(kind),previous=this.get(kind,id);Object.assign(data,{id,created_at:previous?.created_at||fixed,updated_at:fixed});this.records.set(JSON.stringify([kind,id]),data);this.metadata.set('_entity_revision',(this.metadata.get('_entity_revision')||0)+1);return copy(data);}
 delete(kind,id){if(this.records.delete(JSON.stringify([kind,id])))this.metadata.set('_entity_revision',this.metadata.get('_entity_revision')+1);}
 meta(key,fallback=null){return this.metadata.has(key)?copy(this.metadata.get(key)):fallback;}
 set_meta(key,value){this.metadata.set(key,copy(value));if(key!=='_entity_revision')this.metadata.set('_entity_revision',this.meta('_entity_revision',0)+1);return copy(value);}
 audit(action,details,user=this.context.memberId){return this.put('audit',{action,details,user});}
 transaction(callback){const records=copy(this.records),metadata=copy(this.metadata);try{return callback(this);}catch(error){this.records=records;this.metadata=metadata;throw error;}}
 dump(){return {entities:['page','collaboration','version','audit'].map(kind=>[kind,this.list(kind)]),revision:this.meta('_entity_revision')};}
}
function execute(test){
 const store=new MemoryStore(test.initial);let clock=100,epoch=0,firstEpoch=null;const workspace=new Workspace(store),service=new Collaboration(store,workspace,{clock:()=>clock,uid:()=> 'epoch-'+(++epoch)}),out=[];
 for(const step of test.steps){
  if(Object.hasOwn(step,'at'))clock=step.at;store.context.memberId=step.actor||'local';const access=new Access(store,store.get('member',store.context.memberId));let result;
  try{
   let value;
   if(step.action==='snapshot'){value=service.snapshot('p',access);firstEpoch??=value.epoch;}
   else if(step.action==='apply'){const body={epoch:step.useInitialEpoch?firstEpoch:Object.hasOwn(step,'epoch')?step.epoch:store.get('collaboration','p')?.epoch,ops:copy(step.ops),...Object.hasOwn(step,'hints')?{hints:step.hints}:{}};value=service.apply('p',body,access);}
   else if(step.action==='patch-page'){store.put('page',{...store.get('page','p'),...copy(step.body)});value=null;}
   else if(step.action==='patch-member'){store.put('member',{...store.get('member',step.id),...copy(step.body)});value=null;}
   else if(step.action==='patch-document'){store.put('collaboration',{...store.get('collaboration','p'),...copy(step.body)});value=null;}
   else if(step.action==='legacy-document'){const doc=store.get('collaboration','p');delete doc.state.history;doc.op_owners={};store.put('collaboration',doc);value=null;}
   else if(step.action==='save')value=workspace.save_blocks('p',copy(step.blocks));
   else if(step.action==='restore')value=workspace.restore_version('p',step.version);
   result={value};
  }catch(error){if(!Number.isInteger(error.status))throw new Error(test.name+': '+error.stack);result={error:{status:error.status,message:error.message}};}
  out.push({...result,persisted:store.dump()});
 }
 return plain(out);
}
const pure=JSON.parse(readFileSync(new URL('../../tests/fixtures/crdt-vectors.json',import.meta.url),'utf8')).vectors;
const normalizations=[
 [{text:'missing 😀'}],[{id:'c',parent_id:'p',text:'child'},{id:'p',text:'parent'}],[{id:'b',parent_id:'a',text:'b'},{id:'a',parent_id:'b',text:'a'}],[{id:'x',parent_id:'ghost',type:'heading_1',text:'한🙂'}],
 [{id:'x',text:'new',rich_text:[{text:'old',marks:{bold:true}}]}],[{id:'x',text:'',rich_text:[{text:'old',marks:{bold:'bad'}}]}],
 [{id:'x',type:null}],[{id:'x',rich_text:null}],[{id:'x',checked:1}],[{id:'x',text:'\ud800'}],[{id:'x',rich_text:[{text:'a',extra:true}]}]
];
const markInputs=[{bold:true,link:'https://example.com/a?q=1#b'},{italic:false,color:'red',link:null},{link:'https:example.com'},{link:'https:///example.com'},{link:'mailto://host'},{link:'mailto:a@example.com'},{link:'/local'},{link:'#anchor'},{link:'//evil'},{link:'javascript:alert(1)'},{bold:1},null,[],{unknown:true}];
let random=0x2190fa;const choose=values=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return values[random%values.length];};
const histories=[];
for(let index=0;index<40;index++){
 const initial=[{id:'__proto__',text:'가🙂',rich_text:[{text:'가🙂',marks:{bold:true}}]},{id:'text',text:'xyz'},{id:'p',text:''}],ops=[],clocks={a:0,b:0},owned={a:[],b:[]};
 for(let number=0;number<24;number++){
  const client=choose(['a','b']),clock=++clocks[client];let type=choose(['block.insert','block.move','block.set','text.insert','text.delete','text.format','block.delete','history.cancel']);
  if(type==='history.cancel'&&!owned[client].length)type='text.insert';let operation;
  if(type==='history.cancel')operation=cancel(client,clock,choose(owned[client]));else{
   operation=op(client,clock,type,{block_id:choose(['__proto__','text','p','new']),group_id:choose(['birth','later'])});
   if(type==='block.insert'||type==='block.move')Object.assign(operation,{parent_id:choose([null,'p','new']),after_id:choose([null,'text'])});
   if(type==='block.insert')operation.block_type=choose(['heading1','quote','paragraph']);if(type==='block.set')Object.assign(operation,{field:'type',value:choose(['heading_1','quote','paragraph'])});
   if(type==='text.insert')Object.assign(operation,{text:choose(['😀한','secret','x']),after_id:choose([null,'seed:text:0']),marks:{color:choose(['red','blue'])}});
   if(type==='text.delete'||type==='text.format')operation.char_ids=['seed:'+operation.block_id+':0'];if(type==='text.format')operation.marks={bold:choose([true,false])};
  }ops.push(operation);owned[client].push(operation.id);
 }
 histories.push({initial,ops});
}
const low=op('b',2,'block.set',{field:'type',value:'quote'}),high=op('a',3,'block.set',{field:'type',value:'heading1'});
histories.push({initial:[{id:'text',text:'x'}],ops:[low,high],extra:[cancel('a',4,'a:3')],hint_ops:[low]});
for(const kind of ['position','mark']){
 const low=kind==='position'?op('b',2,'block.move',{parent_id:null,after_id:'p'}):op('b',2,'text.format',{char_ids:['seed:text:0'],marks:{color:'blue'}});
 const high=kind==='position'?op('a',3,'block.move',{parent_id:'p',after_id:null}):op('a',3,'text.format',{char_ids:['seed:text:0'],marks:{color:'red'}});
 histories.push({initial:[{id:'text',text:'x'},{id:'p',text:''}],ops:[low,high],extra:[cancel('a',4,'a:3')],hint_ops:[low]});
}
histories.push({initial:[{id:'text',text:''}],ops:[op('a',1,'text.insert',{text:'xy'}),op('b',2,'text.insert',{text:'REMOTE',after_id:'a:1:0'}),cancel('a',3,'a:1')],permute:true});
histories.push({initial:[{id:'text',text:'x'}],ops:[op('a',1,'text.delete',{char_ids:['seed:text:0']}),op('b',1,'text.delete',{char_ids:['seed:text:0']}),cancel('a',2,'a:1')],permute:true});
histories.push({initial:[],ops:[op('a',1,'block.insert',{block_id:'p',block_type:'heading1',group_id:'birth'}),op('a',2,'text.insert',{block_id:'p',text:'original',group_id:'birth'}),op('b',1,'block.insert',{block_id:'child',parent_id:'p'}),cancel('a',3,'a:1','a:2')],permute:true});
const chain=[op('chain',1,'text.insert',{text:'safe'})];for(let clock=2;clock<=2002;clock++)chain.push(cancel('chain',clock,'chain:'+(clock-1)));histories.push({initial:[{id:'text',text:''}],ops:chain});
const oracle=String.raw`
import sys,json,copy
from contextlib import nullcontext
from unittest.mock import patch
from types import SimpleNamespace
from fountain import crdt
from fountain.core import Store,Workspace,APIError,AUDIT_ACTOR
from fountain.access import Access
from fountain.collaboration import Collaboration
payload=json.load(sys.stdin)
def attempt(callback):
 try:return {'value':callback()}
 except APIError as error:return {'error':dict(status=error.status,message=error.message)}
outputs=[]
for case in payload['cases']:
 store=Store(':memory:');workspace=Workspace.__new__(Workspace);workspace.store=store;ids=[0];epochs=[0];clock=[100]
 def uid(): ids[0]+=1;return 'generated-'+str(ids[0])
 def epoch():epochs[0]+=1;return 'epoch-'+str(epochs[0])
 class Clock:
  @staticmethod
  def now(zone):return SimpleNamespace(timestamp=lambda:clock[0])
 with patch('fountain.core.now',lambda:payload['fixed']),patch('fountain.core.uid',uid),patch('fountain.collaboration.uid',epoch),patch('fountain.collaboration.datetime',Clock):
  for kind,raw in case['initial']:
   data=copy.deepcopy(raw)
   if kind=='page':data['blocks']=workspace.validate_blocks(data.get('blocks',[]))
   store.put(kind,data)
  store.set_meta('workspace_id','test-workspace');store.set_meta('access_revision',2)
  # TS fixture metadata is inserted before entity seeding, not counted mutations.
  store.set_meta('_entity_revision',len(case['initial']))
  service=Collaboration(store,workspace);results=[];first_epoch=None
  for step in case['steps']:
   clock[0]=step.get('at',clock[0]);actor=step.get('actor','local');access=Access(store,store.get('member',actor));token=AUDIT_ACTOR.set(actor)
   try:
    def action():
     global first_epoch
     if step['action']=='snapshot':
      value=service.snapshot('p',access)
      if first_epoch is None:first_epoch=value['epoch']
      return value
     if step['action']=='apply':
      body=dict(epoch=first_epoch if step.get('useInitialEpoch') else step.get('epoch',(store.get('collaboration','p') or {}).get('epoch')),ops=copy.deepcopy(step['ops']))
      if 'hints' in step:body['hints']=step['hints']
      return service.apply('p',body,access)
     if step['action'].startswith('patch-'):
      kind={'patch-page':'page','patch-member':'member','patch-document':'collaboration'}[step['action']];identity=step.get('id','p');store.put(kind,dict(store.get(kind,identity),**copy.deepcopy(step['body'])));return None
     if step['action']=='legacy-document':
      doc=store.get('collaboration','p');doc['state'].pop('history',None);doc['op_owners']={};store.put('collaboration',doc);return None
     if step['action']=='save':return workspace.save_blocks('p',step['blocks'])
     if step['action']=='restore':return workspace.restore_version('p',step['version'])
    result=attempt(action);result['persisted']={'entities':[[kind,store.list(kind)] for kind in ['page','collaboration','version','audit']],'revision':store.meta('_entity_revision')};results.append(result)
   finally:AUDIT_ACTOR.reset(token)
  outputs.append(results)
 store.close()
normal=[]
for blocks in payload['normalizations']:
 with patch('fountain.crdt.uid',lambda:'stable-block'):normal.append(attempt(lambda:crdt.normalize_blocks(blocks)))
marks=[attempt(lambda value=value:crdt.validate_marks(value)) for value in payload['markInputs']]
pure=[]
for vector in payload['pure']:
 state=crdt.apply_operations(crdt.seed_state(vector['initial_blocks']),vector['operations']);pure.append(dict(state=state,public=crdt.public_state(state)))
histories=[]
for vector in payload['histories']:
 state=crdt.seed_state(vector['initial'])
 for start in range(0,len(vector['ops']),1000):state=crdt.apply_operations(state,vector['ops'][start:start+1000])
 public=crdt.public_state(state);extra=crdt.apply_operations(public,vector['extra']) if 'extra' in vector else None
 hints=crdt.capture_public_hints(crdt.public_state(crdt.apply_operations(crdt.seed_state(vector['initial']),vector.get('hint_ops',[]))))
 histories.append(dict(state=state,public=public,hydrated=crdt.hydrate_public_state(public),extra=extra,extraHydrated=crdt.hydrate_public_state(extra,hints) if extra else None))
print(json.dumps(dict(cases=outputs,normalizations=normal,marks=marks,pure=pure,histories=histories),ensure_ascii=True))
`;
const run=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',oracle],{cwd:root,input:JSON.stringify({cases,normalizations,markInputs,pure,histories,fixed}),encoding:'utf8',maxBuffer:64*1024*1024});assert.equal(run.status,0,run.stderr);const expected=JSON.parse(run.stdout);
for(const [index,test]of cases.entries())assert.deepEqual(execute(test),expected.cases[index],test.name);
const attempt=action=>{try{return {value:plain(action())};}catch(error){if(!Number.isInteger(error.status))throw error;return {error:{status:error.status,message:error.message}};}};
for(const [index,blocks]of normalizations.entries())assert.deepEqual(attempt(()=>c.normalize_blocks(blocks,()=> 'stable-block')),expected.normalizations[index],'normalize '+index);
for(const [index,marks]of markInputs.entries())assert.deepEqual(attempt(()=>c.validate_marks(marks)),expected.marks[index],'marks '+index);
let reorderings=0;
for(const [index,vector]of pure.entries())for(const ordering of vector.permutations){
 let state=c.seed_state(vector.initial_blocks);for(const number of ordering)state=c.apply_operations(state,[vector.operations[number]]);
 assert.deepEqual(plain(state),expected.pure[index].state,vector.name+' fullstate');assert.deepEqual(plain(c.public_state(state)),expected.pure[index].public,vector.name+' redaction');assert.deepEqual(plain(c.project(state)),vector.expected,vector.name);reorderings++;
}
function* permutations(items){if(!items.length){yield [];return;}for(let index=0;index<items.length;index++)for(const tail of permutations(items.filter((_,other)=>other!==index)))yield [items[index],...tail];}
let cancellationReorderings=0;
for(const [index,vector]of histories.entries()){
 let state=c.seed_state(vector.initial);for(let start=0;start<vector.ops.length;start+=1000)state=c.apply_operations(state,vector.ops.slice(start,start+1000));
 const pub=c.public_state(state),extra=vector.extra?c.apply_operations(pub,vector.extra):null,hints=c.capture_public_hints(c.public_state(c.apply_operations(c.seed_state(vector.initial),vector.hint_ops||[])));
 assert.deepEqual(plain({state,public:pub,hydrated:c.hydrate_public_state(pub),extra,extraHydrated:extra?c.hydrate_public_state(extra,hints):null}),expected.histories[index],'history '+index);
 if(vector.permute)for(const order of permutations(vector.ops)){let reordered=c.seed_state(vector.initial);for(const operation of order)reordered=c.apply_operations(reordered,[operation]);assert.deepEqual(plain(reordered),expected.histories[index].state,'cancel convergence '+index);cancellationReorderings++;}
}
console.log(JSON.stringify({ok:true,oracle:'actual Python Collaboration/Workspace/SQLite and CRDT/history',collaborationSequences:cases.length,steps:cases.reduce((n,test)=>n+test.steps.length,0),normalizations:normalizations.length,marks:markInputs.length,reorderings,historyVectors:histories.length,cancellationReorderings,includes2002NodeDAG:true,actualCloudOrSSE:false}));
