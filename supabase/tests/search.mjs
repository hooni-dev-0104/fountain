/** Raw-Store unit contracts, not hosted Auth/SQL or semantic AI evidence. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {Access,APIError} from '../functions/_shared/access.ts';
import {advancedSearch,validateAdvancedSearchQuery} from '../functions/_shared/search.ts';
const stamp='2026-10-16T09:00:00.123456+09:00',acl={default:'workspace',inherit:false,members:{},groups:{}};
function fixture(){
 const records=new Map(),reads=[];let workspace='search-unit';
 const put=(kind,row)=>{records.set(kind+'\0'+row.id,{created_at:stamp,updated_at:stamp,owner_id:'bob',permissions:structuredClone(acl),...row});return row;};
 for(const [id,role]of [['local','owner'],['admin','admin'],['alice','member'],['bob','member'],['guest','guest'],['inactive','member']])put('member',{id,role,active:id!=='inactive',email:id+'@example.invalid',name:'member-name-must-not-match'});
 put('teamspace',{id:'general',visibility:'open'});put('teamspace',{id:'secret-space',visibility:'private',members:['bob']});
 put('page',{id:'root',title:'Family 서울',teamspace_id:'general',blocks:[{type:'paragraph',text:'Straße İ 한글 😀 alpha beta'},{type:'file',text:'file-secret'},{type:'embed',text:'embed-secret'},{type:'paragraph',attachment_id:'private-file',text:'attachment-secret'}]});
 put('page',{id:'child',title:'Child family',parent_id:'root',blocks:[{type:'paragraph',text:'서울 여행'}]});
 put('page',{id:'private',title:'private-secret',permissions:{default:'private'},teamspace_id:'secret-space',blocks:[{type:'paragraph',text:'private-body-secret'}]});
 put('page',{id:'detached',title:'Visible detached',parent_id:'private',blocks:[]});
 put('page',{id:'guest-page',title:'Guest gift',permissions:{default:'private',members:{guest:'view'}},blocks:[]});
 put('page',{id:'archive',title:'archived-secret',archived:true,blocks:[]});
 const props=[['name','title'],['text','text'],['number','number'],['check','checkbox'],['multi','multi_select'],['date','date'],['select','select'],['status','status'],['url','url'],['email','email'],['phone','phone'],['person','person'],['files','files'],['relation','relation'],['formula','formula'],['rollup','rollup'],['unknown','unknown']].map(([id,type])=>({id,type,name:'schema-name-must-not-match'}));
 put('database',{id:'db',name:'Visible DB',description:'Shared budget',parent_id:'root',properties:props});
 put('database',{id:'assigned',name:'Assigned tasks',row_permissions:{mode:'assigned',property_id:'assignee'},properties:[{id:'name',type:'title'},{id:'assignee',type:'person'}]});
 put('database',{id:'private-db',name:'private-db-secret',permissions:{default:'private'},properties:[{id:'name',type:'title'}]});
 put('database',{id:'archived-db',name:'archived-db-secret',archived:true,properties:[{id:'name',type:'title'}]});
 put('row',{id:'row',database_id:'db',properties:{name:'Row family',text:'safe alpha',number:1e-7,check:false,multi:['red','blue'],date:{start:'2026-10-16',end:'2026-10-17'},select:'Ready',status:'진행',url:'https://example.invalid/allowed',email:'family@example.invalid',phone:'010-0000',person:['person-secret'],files:['files-secret'],relation:['relation-secret'],formula:'formula-secret',rollup:'rollup-secret',unknown:{text:'unknown-secret'},extra:'extra-secret'}});
 put('row',{id:'assigned-alice',database_id:'assigned',properties:{name:'Current assignment',assignee:['alice']}});
 put('row',{id:'assigned-bob',database_id:'assigned',properties:{name:'other-assignment-secret',assignee:['bob']}});
 put('row',{id:'private-row',database_id:'private-db',permissions:{default:'private',members:{alice:'view'}},properties:{name:'private-row-secret'}});
 put('row',{id:'orphan',database_id:'missing-db',properties:{name:'orphan-secret'}});put('row',{id:'archived-db-row',database_id:'archived-db',properties:{name:'archived-row-secret'}});
 put('row',{id:'archived-row',database_id:'db',archived:'yes',properties:{name:'archived-row-secret'}});
 const store={get(kind,id){reads.push(['get',kind,id]);return records.get(kind+'\0'+id)??null;},list(kind){reads.push(['list',kind]);return [...records.entries()].filter(([key])=>key.startsWith(kind+'\0')).map(([,row])=>row);},meta(key,fallback=null){reads.push(['meta',key]);return key==='workspace_id'?workspace:fallback;},audit(){throw Error('Search must not audit raw query or mutate');}};
 const search=(query='',member='alice')=>advancedSearch(store,new Access(store,store.get('member',member)),query instanceof URLSearchParams?query:new URLSearchParams(query));
 return {records,reads,store,put,search,setWorkspace:value=>workspace=value,row:(kind,id)=>records.get(kind+'\0'+id)};
}
const ids=result=>result.results.map(row=>row.id);
function status(action,expected){assert.throws(action,error=>error instanceof APIError&&error.status===expected);}

test('raw Store authorization excludes hidden/assigned rows, archives, dangling databases and all non-whitelisted text',()=>{
 const f=fixture(),result=f.search('limit=50');assert.equal(result instanceof Promise,false);
 for(const hidden of ['private','private-db','private-row','assigned-bob','archive','archived-row','archived-db','orphan','archived-db-row'])assert(!ids(result).includes(hidden),hidden);
 assert(ids(result).includes('assigned-alice'));assert(ids(f.search('limit=50','local')).includes('assigned-bob'));
 assert(!ids(f.search('limit=50','admin')).includes('private'));assert.deepEqual(ids(f.search('limit=50','guest')),['guest-page']);status(()=>f.search('','inactive'),401);
 for(const secret of ['file-secret','embed-secret','attachment-secret','person-secret','files-secret','relation-secret','formula-secret','rollup-secret','unknown-secret','extra-secret','schema-name-must-not-match','member-name-must-not-match','orphan-secret'])assert.equal(f.search(new URLSearchParams({q:secret}),'local').total,0,secret);
 for(const row of result.results)assert.deepEqual(Object.keys(row).sort(),['type','id','title','icon','snippet','owner_id','created_at','updated_at',...(row.type==='row'?['database_id','database_title']:[])].sort());
 assert.equal(result.results.find(r=>r.id==='row').database_title,'Visible DB');
});

test('hidden payloads and fields cannot affect rank/count/snippet/content marker; authorize/filter before text access',()=>{
 const f=fixture(),before=f.search('limit=50');
 Object.defineProperty(f.row('page','private'),'blocks',{get(){throw Error('Hidden body extracted');}});
 Object.defineProperty(f.row('database','private-db'),'name',{get(){throw Error('Hidden database name extracted');}});
 Object.defineProperty(f.row('row','assigned-bob'),'properties',{get(){return {assignee:['bob'],name:'a different hidden token'};}});
 f.row('row','row').properties.relation=['new-hidden-reference'];f.row('page','root').blocks[1].text='different-file-secret';
 assert.deepEqual(f.search('limit=50'),before);assert.equal(f.search('q=different-file-secret').total,0);
 const visible=f.row('page','detached');Object.defineProperty(visible,'blocks',{get(){throw Error('Filtered body extracted');}});
 assert(!ids(f.search('owner=alice&limit=50')).includes('detached'));
 assert(!f.reads.some(entry=>entry[0]==='list'&&entry[1]==='member'));assert(!f.reads.some(entry=>entry[0]==='get'&&entry[1]==='member'&&entry[2]!=='alice'));
});

test('AND phrases, NFKC/casefold, Korean Jamo, Unicode White_Space and title-only remain lexical',()=>{
 const f=fixture();
 for(const q of ['STRASSE','i\u0307','한글','한글','😀','"alpha beta"','" alpha\u3000 beta "'])assert(ids(f.search(new URLSearchParams({q}))).includes('root'),q);
 assert.equal(f.search('q=alpha+nonexistent').total,0);assert.equal(f.search('q=STRASSE&title_only=1').total,0);
 assert.equal(f.search(new URLSearchParams({q:'alpha\u001cbeta'})).total,0);
 assert.equal(f.search(new URLSearchParams({q:'\ufeffSTRASSE'})).total,0);
 assert.equal(f.search('q=STRASSE').result_set,f.search('q=strasse').result_set);
 assert.equal(f.search('q=한글').result_set,f.search('q=한글').result_set);
 f.put('page',{id:'greek-exact',title:'ΐ',blocks:[]});f.put('page',{id:'greek-long',title:'ΐ extra',blocks:[]});
 assert.equal(ids(f.search(new URLSearchParams({q:'ΐ'})))[0],'greek-exact');
});

test('safe schema scalar text alone is indexed, with exact date ranges and stable numeric spellings',()=>{
 const f=fixture();for(const q of ['1e-7','false','red','blue','2026-10-17','Ready','진행','010-0000'])assert(ids(f.search(new URLSearchParams({q,types:'row'}))).includes('row'),q);
 for(const value of [{start:'2026-10-16',end:'2026-10-17',extra:'date-secret'},{start:{text:'date-secret'},end:'2026-10-17'},{start:'2026-10-18',end:'2026-10-17'},['date-secret']]){f.row('row','row').properties.date=value;assert.equal(f.search('q=date-secret').total,0);assert.equal(f.search('q=2026-10-17').total,0);}
 f.row('row','row').properties.text={private:'nested-secret'};f.row('row','row').properties.multi=['red',{private:'array-secret'}];f.row('row','row').properties.number=9007199254740992;
 for(const q of ['nested-secret','array-secret','9007199254740992'])assert.equal(f.search(new URLSearchParams({q})).total,0);
 for(const [n,expected]of [[-0,'0'],[1e-6,'0.000001'],[-2.5,'-2.5'],[9007199254740991,'9007199254740991']]){f.row('row','row').properties.number=n;assert(ids(f.search(new URLSearchParams({q:expected,types:'row'}))).includes('row'));}
});

test('container and owner filters use only visible explicit ancestry, inherited teamspaces and row database metadata',()=>{
 const f=fixture();assert.deepEqual(new Set(ids(f.search('in=root&limit=50'))),new Set(['root','child','db','row']));
 const team=ids(f.search('teamspace=general&limit=50'));for(const id of ['root','child','db','row'])assert(team.includes(id));assert(!team.includes('detached'));
 for(const query of ['in=missing','in=private','in=archive','teamspace=missing','teamspace=secret-space'])status(()=>f.search(query),404);
 f.put('page',{id:'absent-owner',title:'Absent owner',owner_id:undefined,blocks:[]});delete f.row('page','absent-owner').owner_id;
 f.put('page',{id:'null-owner',title:'Null owner',owner_id:null,blocks:[]});f.put('page',{id:'blank-owner',title:'Blank owner',owner_id:'',blocks:[]});
 assert(ids(f.search('owner=local&limit=50')).includes('absent-owner'));assert(!ids(f.search('owner=local&limit=50')).includes('null-owner'));
 for(const id of ['null-owner','blank-owner'])assert.equal(f.search('limit=50').results.find(r=>r.id===id).owner_id,null);
 assert.equal(f.search('owner=bob&owner=bob').result_set,f.search('owner=bob').result_set);
});

test('cycle handling terminates and visible hierarchies do not have an arbitrary 64-level cutoff',()=>{
 const f=fixture();f.put('page',{id:'cycle-a',title:'A',parent_id:'cycle-b',blocks:[]});f.put('page',{id:'cycle-b',title:'B',parent_id:'cycle-a',blocks:[]});
 assert.equal(f.search('in=cycle-a').total,2);
 let parent='root';for(let i=0;i<90;i++){const id='depth-'+i;f.put('page',{id,title:'Deep '+i,parent_id:parent,blocks:[]});parent=id;}
 assert.equal(f.search('in=root&types=page').total,92);
});

test('source ISO spelling is retained, integer floor UTC filters work, and invalid dates sort last in both directions',()=>{
 const f=fixture();f.put('page',{id:'floor',title:'Floor',updated_at:'1969-12-31T23:59:59.999999Z',created_at:'1969-12-31T23:59:59.999999Z',blocks:[]});
 f.put('page',{id:'invalid',title:'Invalid',updated_at:'2026-02-30T00:00:00Z',created_at:'0001-01-01T00:00:00+23:59',blocks:[]});
 const result=f.search('types=page&limit=50');assert.equal(result.results.find(r=>r.id==='root').updated_at,stamp);assert.equal(result.results.find(r=>r.id==='invalid').updated_at,null);assert.equal(result.results.find(r=>r.id==='invalid').created_at,null);
 assert.deepEqual(ids(f.search('after=1969-12-31T23%3A59%3A59.999Z&before=1970-01-01T00%3A00%3A00.000Z')),['floor']);
 for(const sort of ['updated_asc','updated_desc','created_asc','created_desc'])assert.equal(ids(f.search(new URLSearchParams({types:'page',sort,limit:'50'}))).at(-1),'invalid');
 assert(!ids(f.search('after=2026-10-16T00%3A00%3A00.124Z')).includes('root'));assert(ids(f.search('before=2026-10-16T00%3A00%3A00.124Z')).includes('root'));
});

test('Unicode snippets map casefold expansions/emoji to display scalars and never truncate searchable corpus',()=>{
 const f=fixture();for(const prefix of ['ß','😀']){
  f.put('page',{id:'long',title:'Long',blocks:[{type:'paragraph',text:prefix.repeat(230)+'NEEDLE'+'y'.repeat(230)}]});
  const row=f.search('q=needle').results.find(r=>r.id==='long');assert.equal(row.snippet,'…'+prefix.repeat(89)+'NEEDLE'+'y'.repeat(83)+'…');assert.equal(Array.from(row.snippet).length,180);
 }
 f.put('page',{id:'corpus',title:'Long corpus',blocks:[{type:'paragraph',text:'x'.repeat(100_000)+' end-signal'}]});assert(ids(f.search('q=end-signal')).includes('corpus'));
});

test('marker is independent SHA256 over exact scoped filters/all sorted small DTOs; fresh changes reject pagination',()=>{
 const f=fixture(),all=f.search('limit=50');
 const filters={q:'',terms:[],types:['page','database','row'],owners:[],teamspace:null,in:null,title_only:false,date_field:'updated',after:null,before:null,sort:'relevance'};
 const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 assert.equal(all.result_set,createHash('sha256').update(canonical([1,'search-unit','alice',filters,all.results])).digest('hex'));
 const first=f.search('limit=1');assert.equal(first.result_set,all.result_set);assert.equal(first.next_offset,1);
 const second=f.search(new URLSearchParams({limit:'2',offset:'1',result_set:first.result_set}));assert.deepEqual(second.results,all.results.slice(1,3));
 const old=first.result_set;f.row('page','root').title='Changed visible';status(()=>f.search(new URLSearchParams({offset:'1',result_set:old})),409);
 f.setWorkspace('another-workspace');status(()=>f.search(new URLSearchParams({result_set:f.search('','bob').result_set})),409);
});

test('malformed/duplicate/unknown input fails before any corpus extraction and pure preflight performs no I/O',()=>{
 const f=fixture(),access=new Access(f.store,f.store.get('member','alice'));f.reads.length=0;
 const malformed=['q=a&q=b','types=page,page','types=','owner=','teamspace=','in=','limit=0','limit=51','limit=01','limit=1e1','offset=1','offset=100001','offset=-1','offset=00','sort=bad','title_only=true','date_field=date','q=%22%22','q=%22unclosed','q=a%22b','q=%22a%22b','foo=1','result_set='+'A'.repeat(64),'q=%00','after=2026-02-30T00:00:00.000Z','after=2026-10-16T00:00:00Z','after=2026-10-16T00:00:00.000Z&before=2026-10-16T00:00:00.000Z'];
 malformed.push(new URLSearchParams({q:'😀'.repeat(501)}).toString(),new URLSearchParams({q:Array(17).fill('same').join(' ')}).toString(),Array.from({length:21},(_,i)=>'owner=owner'+i).join('&'));
 for(const raw of malformed){status(()=>validateAdvancedSearchQuery(new URLSearchParams(raw)),400);status(()=>advancedSearch(f.store,access,new URLSearchParams(raw)),400);}
 assert.deepEqual(f.reads,[]);validateAdvancedSearchQuery(new URLSearchParams({q:'😀'.repeat(500)}));
 const duplicates=new URLSearchParams();for(let i=0;i<21;i++)duplicates.append('owner','alice');validateAdvancedSearchQuery(duplicates);
 const empty={get:()=>null,list:()=>[],meta:()=> 'empty'};assert.equal(advancedSearch(empty,new Access(empty,{id:'owner',role:'owner',active:true}),new URLSearchParams()).total,0);
});
