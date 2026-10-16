// Python/SQLite is an independent behavioral oracle. The JS store here models
// synchronous staging only; actual PostgreSQL/Edge execution is tested separately.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceCore, normalize_blocks, inline_markdown, compareText } from '../functions/_shared/core.ts';
import { APIError, Access, clone, get } from '../functions/_shared/access.ts';
import { Authorization } from '../functions/_shared/authorization.ts';
import { CloudStore, MissingSelection } from '../functions/_shared/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.FOUNTAIN_PYTHON || '/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const time = '2026-10-16T00:00:00.123000+00:00';
let checks = 0;
class MemoryStore {
  requestTime = time; context = { memberId: 'alice' }; records = new Map(); metadata = new Map(); revision = 0;
  constructor(uid) { this.uid = uid; }
  allocate_id() { return this.uid(); }
  get(kind, id) { return clone(this.records.get(kind)?.get(id) ?? null); }
  list(kind) { return [...(this.records.get(kind)?.values() ?? [])].sort((a,b)=>compareText(a.created_at,b.created_at)||compareText(a.id,b.id)).map(clone); }
  meta(key, fallback = null) { return key === '_entity_revision' ? this.revision : clone(this.metadata.has(key) ? this.metadata.get(key) : fallback); }
  set_meta(key,value) { this.metadata.set(key,clone(value)); this.revision++; return clone(value); }
  put(kind,data) { const id=data.id||this.uid(),prior=this.get(kind,id),value={...clone(data),id,created_at:prior?.created_at??time,updated_at:time}; if(!this.records.has(kind))this.records.set(kind,new Map());this.records.get(kind).set(id,value);this.revision++;return clone(value); }
  delete(kind,id) { if(this.records.get(kind)?.delete(id))this.revision++; }
  audit(action,details,user='alice') { return this.put('audit',{action,details,user}); }
  transaction(action) { const before=clone([this.records,this.metadata,this.revision]);try{return action(this);}catch(error){[this.records,this.metadata,this.revision]=before;throw error;} }
}
function reference(value, references) {
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&Object.hasOwn(value,'$ref'))return clone(value.$ref.split('.').reduce((item,key)=>item[key],references));
  if(Array.isArray(value))return value.map(item=>reference(item,references));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,reference(item,references)]));
  return value;
}
function run(spec) {
  let counter=0;const uid=()=>`generated-${String(++counter).padStart(4,'0')}`,store=new MemoryStore(uid),workspace=new WorkspaceCore(store,{actor:spec.actor??'alice',uid});
  for(const [key,value]of Object.entries(spec.meta??{}))store.set_meta(key,value);
  for(const [kind,records]of Object.entries(spec.records??{}))for(const record of records)store.put(kind,record);
  const results=[],refs={};
  for(const operation of spec.operations){try{const args=reference(operation.args??[],refs);if(operation.deny)args.push(row=>!operation.deny.includes(row.id));const result=store.transaction(()=>operation.method==='normalize_blocks'?normalize_blocks(...args,uid):operation.method==='inline_markdown'?inline_markdown(...args):workspace[operation.method](...args));if(result?.mime==='application/json')result.content=JSON.parse(result.content);if(operation.as)refs[operation.as]=clone(result);results.push({ok:result});}catch(error){results.push(error instanceof APIError?{error:{status:error.status,message:error.message}}:{unexpected:{type:error.name,message:error.message}});}}
  return {results,records:Object.fromEntries([...store.records.keys()].sort().filter(kind=>store.records.get(kind).size).map(kind=>[kind,store.list(kind)])),revision:store.revision};
}
function parity(name,spec) {
  const process=spawnSync(python,[resolve(root,'supabase/tests/core-oracle.py')],{input:JSON.stringify(spec),encoding:'utf8',cwd:root,maxBuffer:16*1024*1024});
  assert.equal(process.status,0,process.stderr);const expected=JSON.parse(process.stdout),actual=JSON.parse(JSON.stringify(run(spec)));
  assert.deepEqual(actual,expected,name);checks+=spec.operations.length;return actual;
}
const initial={meta:{workspace_id:'fixture',settings:{name:'가족'}},records:{member:[{id:'alice',name:'앨리스',role:'member',active:true},{id:'bob',name:'밥',role:'member',active:true}],teamspace:[{id:'general',visibility:'open'}]}};
parity('page lifecycle, save/history/comments/cycles/Unicode', {...initial,operations:[
  {method:'create_page',args:[{id:'root',title:'Straße Σς 한글🙂',blocks:[{id:'one',type:'heading_1',text:'Hello'}]}]},
  {method:'create_page',args:[{id:'child',title:'子',parent_id:'root'}]},
  {method:'create_page',args:[{id:'root'}]},
  {method:'update_page',args:['root',{title:'Changed',favorite:true,revision:0}]},
  {method:'update_page',args:['root',{title:'Stale',revision:0}]},
  {method:'update_page',args:['root',{parent_id:'child'}]},
  {method:'save_blocks',args:['root',[{id:'two',type:'paragraph',text:'A🙂',rich_text:[{text:'A🙂',marks:{bold:true,link:'https://example.invalid/x'}}]}],1]},
  {method:'detail',args:['root'],as:'history'},
  {method:'restore_version',args:['root',{$ref:'history.versions.0.id'}]},
  {method:'detail',args:['root']},
  {method:'create_comment',args:['root',{text:'댓글🙂',block_id:'one'}],as:'comment'},
  {method:'resolve_comment',args:[{$ref:'comment.id'},{resolved:true}]},
  {method:'resolve_comment',args:[{$ref:'comment.id'},{resolved:'true'}]},
  {method:'update_page',args:['root',{locked:true}]},
  {method:'save_blocks',args:['root',[]]},
  {method:'update_page',args:['root',{locked:false,archived:true}]},
  {method:'search',args:['changed']},
  {method:'update_page',args:['root',{archived:false}]},
  {method:'search',args:['Hello']},
  {method:'snapshot'},
]});
parity('block fields, safe marks, tree canonicalization and negative validation', {...initial,operations:[
  {method:'normalize_blocks',args:[[{id:'child',parent_id:'root',type:'todo',checked:false,attachment_id:null,size:0,language:'ko',text:'子'}, {id:'root',parent_id:'child',text:'父'}]]},
  {method:'normalize_blocks',args:[[{id:'__proto__',rich_text:[{text:'a',marks:{bold:false}},{text:'b',marks:{bold:false}}]}, {id:'constructor',parent_id:'missing',text:'🙂'}]]},
  {method:'normalize_blocks',args:[[{id:'x',text:'plain',rich_text:[{text:'rich',marks:{italic:true}}]}]]},
  ...[{type:'invalid'},{type:'todo',checked:1},{id:'x',text:'x',rich_text:[{text:'x',marks:{link:'javascript:alert(1)'}}]},{id:'x',size:-1},{id:'x',rich_text:[{text:'x',marks:{provider:'secret'}}]}].map(block=>({method:'normalize_blocks',args:[[block]]})),
  {method:'inline_markdown',args:[{text:'unused',rich_text:[{text:'`code`',marks:{code:true,bold:true,link:'https://example.invalid/(a)'}},{text:'<tag>_*',marks:{underline:true,strike:true}}]}]},
]});
const properties=[{id:'name',name:'이름',type:'title'},{id:'n',name:'숫자',type:'number'},{id:'done',name:'완료',type:'checkbox'},{id:'due',name:'날짜',type:'date'},{id:'tags',name:'태그',type:'multi_select'},{id:'related',name:'관계',type:'relation',database_id:'db'},{id:'double',name:'계산',type:'formula',expression:"prop('n') * 2"},{id:'sum',name:'합계',type:'rollup',relation_property:'related',target_property:'n',aggregation:'sum'}];
parity('database typed values, relations, computed fields and filters', {...initial,operations:[
  {method:'create_database',args:[{id:'db',name:'표',properties}]},
  {method:'create_row',args:['db',{id:'a',properties:{name:'첫, 행',n:2,done:false,due:{start:'2026-10-20',end:'2026-10-22'},tags:['높음','보통']}}]},
  {method:'create_row',args:['db',{id:'b',properties:{name:'Straße',n:5,related:['a']}}]},
  {method:'create_row',args:['db',{id:'bad',properties:{n:true}}]},
  {method:'update_row',args:['db','a',{properties:{double:8}}]},
  {method:'update_row',args:['db','b',{properties:{related:['missing']}}]},
  {method:'update_row',args:['db','b',{properties:{related:['a','a']}}]},
  {method:'database_detail',args:['db']},
  {method:'database_detail',args:['db',[{property:'name',operator:'contains',value:'STRASSE'}],[{property:'n',direction:'descending'}]]},
  {method:'database_detail',args:['db',[{property:'n',operator:'greater_than',value:3}]]},
  {method:'database_detail',args:['db',[{property:'unknown',operator:'is_empty'}]]},
  {method:'database_detail',args:['db',null,null],deny:['a']},
  {method:'export',args:['csv','db']},
  {method:'delete_row',args:['db','a']},
  {method:'database_detail',args:['db']},
]});
parity('formula and rollup errors remain per-field diagnostics', {...initial,operations:[
  {method:'create_database',args:[{id:'errors',properties:[{id:'n',name:'숫자',type:'number'},{id:'zero',name:'나눗셈',type:'formula',expression:"prop('n') / 0"},{id:'unknown',name:'없음',type:'formula',expression:"prop('missing')"},{id:'cycle',name:'순환',type:'formula',expression:"prop('cycle')"}]}]},
  {method:'create_row',args:['errors',{id:'a',properties:{n:1}}]},
  {method:'database_detail',args:['errors']},
]});
parity('markdown/CSV/JSON import private copies and export rich nested text', {...initial,operations:[
  {method:'import_data',args:[{format:'markdown',content:'# 제목\n- 할 일\r\n\n> 인용\n',title:'가져오기'}]},
  {method:'import_data',args:[{format:'csv',content:'이름,설명\r\n"첫, 항목","여러\n줄"\r\n다음,값\r\n'}]},
  {method:'import_data',args:[{format:'json',content:JSON.stringify({pages:[{id:'oldparent',title:'부모',blocks:[{id:'block',text:'**문자**'}]},{id:'oldchild',parent_id:'oldparent',title:'자식'}],databases:[{id:'old-db',name:'원본',properties:[{id:'name',name:'이름',type:'title'},{id:'relation',name:'관계',type:'relation',database_id:'old-db'}]}],rows:[{id:'oldrow',database_id:'old-db',properties:{name:'원래 행',relation:['oldrow']}}]})}]},
  {method:'export',args:['markdown']}, {method:'export',args:['json']},
  {method:'import_data',args:[{format:'csv',content:'a,b\n1,2,3\n'}]},
  {method:'import_data',args:[{format:'csv',content:'\na,b\n1,2\n'}]},
  {method:'import_data',args:[{format:'json',content:'{bad'}]},
  {method:'import_data',args:[{format:'json',content:JSON.stringify({pages:[{id:'a',title:'a',parent_id:'b'},{id:'b',title:'b',parent_id:'a'}]})}]},
]});
parity('task links, schedule plan writes, protected subtree and private duplicates', {...initial,operations:[
  {method:'create_database',args:[{id:'tasks',name:'일정',properties:[{id:'name',name:'이름',type:'title'},{id:'due',name:'날짜',type:'date'}],task_settings:{subitems:true,dependencies:true,date_property:'due',shift:'overlap',skip_weekends:true}}]},
  {method:'create_row',args:['tasks',{id:'parent',properties:{name:'부모',due:{start:'2026-10-20',end:'2026-10-22'}}}]},
  {method:'create_row',args:['tasks',{id:'child',parent_row_id:'parent',depends_on:['parent'],properties:{name:'자식',due:'2026-10-23'}}]},
  {method:'create_row',args:['tasks',{id:'next',depends_on:['child'],properties:{name:'다음',due:'2026-10-26'}}]},
  {method:'update_row',args:['tasks','parent',{properties:{due:{start:'2026-10-26',end:'2026-10-30'}}}]},
  {method:'database_detail',args:['tasks']},
  {method:'update_row',args:['tasks','parent',{depends_on:['child']}]},
  {method:'delete_row',args:['tasks','parent'],deny:['child']},
  {method:'duplicate_row',args:['tasks','parent'],deny:['child']},
  {method:'duplicate_row',args:['tasks','parent'],as:'copies'},
  {method:'delete_row',args:['tasks','parent']},
  {method:'database_detail',args:['tasks']},
  {method:'delete_row',args:['tasks',{$ref:'copies.root_id'}]},
]});
parity('typed validation and filter scalar/list Python semantics', {...initial,operations:[
  {method:'create_database',args:[{id:'types',properties:[{id:'title',name:'이름',type:'title'},{id:'number',name:'숫자',type:'number'},{id:'bool',name:'확인',type:'checkbox'},{id:'array',name:'여럿',type:'multi_select'},{id:'date',name:'날짜',type:'date'}]}]},
  {method:'create_row',args:['types',{id:'zero',properties:{title:'영',number:0,bool:false,array:['a','b']}}]},
  {method:'create_row',args:['types',{id:'one',properties:{title:'하나',number:1,bool:true,array:['a','c']}}]},
  ...[{},[],null,{unknown:'x'},{number:'1'},{number:true},{number:1e15},{bool:1},{array:'x'},{date:'2026-02-30'}].map(value=>({method:'validate_values',args:[{id:'types',properties:[{id:'number',type:'number'},{id:'bool',type:'checkbox'},{id:'array',type:'multi_select'},{id:'date',type:'date'}]},value]})),
  ...[{property:'bool',operator:'equals',value:1},{property:'bool',operator:'less_than',value:1},{property:'array',operator:'less_than',value:['a','c']},{property:'array',operator:'contains',value:'b'},{property:'number',operator:'invalid'},{property:'number',operator:'greater_than',value:'0'}].map(rule=>({method:'database_detail',args:['types',[rule]]})),
  ...[[],[{id:'x',name:'x',type:'bad'}],[{id:'x',name:'',type:'text'}],[{id:'x',name:'x',type:'text'},{id:'x',name:'x',type:'text'}],[{id:'r',name:'roll',type:'rollup',aggregation:'sum',target_property:'n',relation_property:'missing'}]].map(props=>({method:'validate_properties',args:[props]})),
]});
// Permission enforcement remains a separate pure boundary; primitives do not
// replace Authorization.prepare/project with a fake unrestricted CloudStore.
{
  let n=0;const store=new MemoryStore(()=>`permission-${++n}`);
  store.put('member',{id:'alice',name:'앨리스',role:'member'});store.put('member',{id:'bob',name:'밥',role:'guest'});store.put('teamspace',{id:'general',visibility:'open'});
  const workspace=new WorkspaceCore(store),page=workspace.create_page({id:'private',title:'비공개',permissions:{default:'private',members:{bob:'view'}}});
  const auth=new Authorization(new Access(store,store.get('member','bob')));
  assert.throws(()=>auth.prepare('PUT','/api/pages/private/blocks',{blocks:[]}),error=>error.status===403);
  const projected=auth.project('/api/pages/private',{page,blocks:page.blocks,versions:[{title:'secret',blocks:[]}],comments:[]});
  assert.deepEqual(projected.versions,[]);checks+=2;
}
// Actual CloudStore staging and selection errors (provider model; no network).
{
  const context={workspaceId:'fixture',memberId:'alice',userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),cacheBinding:'b'.repeat(32)};
  let commits=0,ids=0;
  const provider={snapshot:async({selection})=>({workspaceId:'fixture',memberId:'alice',revision:0,accessRevision:0,principal:{id:'alice',role:'owner',active:true},entities:[],meta:selection.metaKeys.map(key=>({key,present:false,value:null})),nextCursor:null}),commit:async()=>{commits++;throw new Error('domain staging must never commit');}};
  const store=await CloudStore.open(provider,context,{kinds:['page','version','audit','comment','collaboration','database','row','member','group','teamspace'],metaKeys:['settings']},{clock:()=>Date.parse(time),idFactory:()=>`reserved-${++ids}`});
  const workspace=new WorkspaceCore(store),page=workspace.create_page({title:'reserved ID'});
  assert.match(page.id,/^reserved-/);assert.equal(workspace.save_blocks(page.id,[{id:'x',text:'saved'}],0).revision,1);assert.equal(commits,0);
  const before=store.revision;assert.throws(()=>workspace.import_data({format:'json',content:JSON.stringify({pages:[{title:'valid'},{title:5}]})}),error=>error.status===400);assert.equal(store.revision,before);assert.equal(store.list('page').length,1);
  const narrow=await CloudStore.open(provider,context,{kinds:[],ids:{database:['missing']}},{clock:()=>Date.parse(time)});
  assert.throws(()=>new WorkspaceCore(narrow).page('unselected'),error=>error instanceof MissingSelection);
  const rollup={id:'db',properties:[{id:'r',type:'relation'},{id:'sum',type:'rollup',relation_property:'r',target_property:'n',aggregation:'sum'}]};
  assert.throws(()=>new WorkspaceCore(narrow).computed_rows(rollup,[{id:'row',database_id:'db',properties:{r:['unselected']}}]),error=>error instanceof MissingSelection);
  checks+=7;
}
console.log(`PASS core Python/SQLite oracle: ${checks} domain assertions; JS staging model only, not deployed Supabase evidence`);
