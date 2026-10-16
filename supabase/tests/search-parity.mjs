/** Cross-runtime API payload equality, using real Python/SQLite as the oracle.
 * This does not establish deployment, real Auth or native UI execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Access,APIError} from '../functions/_shared/access.ts';
import {advancedSearch} from '../functions/_shared/search.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
const date='2026-10-16T09:30:00.123456+09:00';
const shared={owner_id:'alice',teamspace_id:'general',created_at:date,updated_at:date,permissions:{default:'workspace',inherit:false}};
const prop=(id,type)=>({id,name:'property-name-must-not-match',type});
const records={
 member:['local','admin','alice','bob','guest'].map(id=>({id,role:id==='local'?'owner':id==='admin'?'admin':id==='guest'?'guest':'member',active:true})),
 teamspace:[{id:'general',visibility:'open'},{id:'secret-space',visibility:'private',members:['alice']}],
 page:[
  {...shared,id:'root',title:'가족 여행 계획',blocks:[{type:'paragraph',text:'서울 한강 산책과 Straße İ 😀 가족 여행'},{type:'file',text:'file-secret-token'},{type:'embed',text:'embed-secret-token'},{type:'paragraph',attachment_id:'private-file',text:'attachment-secret-token'}]},
  {...shared,id:'child',parent_id:'root',title:'서울 일정',blocks:[{type:'paragraph',text:'가족\u3000여행\n한국어 한글 테스트'}]},
  {...shared,id:'private',title:'hidden-secret-token',permissions:{default:'private'},blocks:[{type:'paragraph',text:'very secret-token'}]},
  {...shared,id:'guest-page',title:'게스트 공유',permissions:{default:'private',members:{guest:'view'}},blocks:[]},
  {...shared,id:'archived',archived:true,title:'archived-token',blocks:[]},
  {...shared,id:'bad-date',title:'Invalid date',updated_at:'2026-02-30T00:00:00Z',created_at:'bad',blocks:[]},
  {...shared,id:'__proto__',title:'constructor prototype',blocks:[{type:'paragraph',text:'x'.repeat(230)+'İß😀 검색 일치'+'y'.repeat(200)}]},
  ...['0001-01-01T00:00:00+23:59','9999-12-31T23:59:59-23:59','2026-10-15T23:59:59.999999Z','2026-10-16T00:00:00Z'].map((updated_at,i)=>({...shared,id:'stamp-'+i,title:'Time boundary',updated_at,blocks:[]})),
 ],
 database:[{...shared,id:'db',name:'가족 여행 DB',description:'공동 일정과 예산',parent_id:'root',properties:[prop('title','title'),prop('text','text'),prop('number','number'),prop('select','select'),prop('multi','multi_select'),prop('checkbox','checkbox'),prop('date','date'),prop('url','url'),prop('email','email'),prop('phone','phone'),prop('person','person'),prop('files','files'),prop('relation','relation'),prop('formula','formula'),prop('unknown','unknown')]},
  {...shared,id:'assigned',name:'담당 일정',row_permissions:{mode:'assigned',property_id:'assignee'},properties:[prop('title','title'),prop('assignee','person')]},
  {...shared,id:'private-db',name:'private-db-token',permissions:{default:'private'},properties:[prop('title','title')]},
  {...shared,id:'archived-db',name:'archived-token',archived:true,properties:[]}],
 row:[{...shared,id:'row',database_id:'db',properties:{title:'가족 여행 준비',text:'서울 예약',number:0.000001,select:'진행',multi:['가족','서울'],checkbox:true,date:{start:'2026-10-16',end:'2026-10-17'},url:'https://example.invalid/family',email:'family@example.invalid',phone:'010-0000-0000',person:['person-secret-token'],files:['files-secret-token'],relation:['relation-secret-token'],formula:'formula-secret-token',unknown:{text:'unknown-secret-token'}}},
  {...shared,id:'assigned-alice',database_id:'assigned',properties:{title:'alice assignment-token',assignee:['alice']}},
  {...shared,id:'assigned-bob',database_id:'assigned',properties:{title:'bob assignment-token',assignee:['bob']}},
  {...shared,id:'hidden-row',database_id:'private-db',properties:{title:'private-db-token'}},
  {...shared,id:'archived-row',database_id:'db',archived:true,properties:{title:'archived-token'}},
  ...[0,-0,1e-7,1e-6,1e20,1e21,-2.5,1.2345678901234567,9007199254740991].map((number,i)=>({...shared,id:'number-'+i,database_id:'db',properties:{title:'Number '+i,number}}))],
};
const params=value=>new URLSearchParams(value).toString();
const queries=['',...['가족','"가족 여행"','서울 여행','STRASSE','i\u0307','😀','검색 일치','property-name-must-not-match','file-secret-token','embed-secret-token','attachment-secret-token','person-secret-token','files-secret-token','relation-secret-token','formula-secret-token','unknown-secret-token','assignment-token','private-db-token','hidden-secret-token','archived-token','0.000001','1e-7','1e+21','2026-10-17','" 가족 여행 "'].map(q=>params({q})),
 ...['relevance','updated_desc','updated_asc','created_desc','created_asc','title'].map(sort=>params({sort})),
 ...['page','database','row','row,page'].map(types=>params({types})),
 ...[{title_only:'1',q:'서울'},{teamspace:'general'},{teamspace:'secret-space'},{teamspace:'missing'},{in:'root'},{in:'private'},{in:'missing'},{owner:'alice'},{owner:'bob'},{date_field:'created',after:'2026-10-16T00:30:00.123Z'},{before:'2026-10-16T00:30:00.124Z'},{limit:'1'},{limit:'50'},{result_set:'f'.repeat(64)}].map(params),
 ['owner=alice','owner=bob','owner=alice'].join('&'),Array.from({length:21},()=> 'owner=alice').join('&'),
 ...['q=x&q=y','q=%22unclosed','q=%22%22','q=x%22y','types=page,page','types=unknown','limit=01','limit=0','limit=51','offset=1','offset=-1','offset=100001','sort=unknown','foo=bar','title_only=true','after=2026-02-30T00%3A00%3A00.000Z','after=2026-10-16T00%3A00%3A00Z','after=2026-10-17T00%3A00%3A00.000Z&before=2026-10-16T00%3A00%3A00.000Z'],
 params({q:'😀'.repeat(501)}),params({q:Array.from({length:17},(_,i)=>'term'+i).join(' ')})];

test('advanced search agrees with Python/SQLite on Unicode, hidden data, filters, sorts and invalid input',()=>{
 const cases=['local','admin','alice','bob','guest'].flatMap(member=>queries.map(query=>({member,query})));
 const python=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',[root+'supabase/tests/search-oracle.py'],{cwd:root,input:JSON.stringify({records,cases}),encoding:'utf8',maxBuffer:16*1024*1024});
 assert.equal(python.status,0,python.stderr);const expected=JSON.parse(python.stdout);
 const store={get:(kind,id)=>structuredClone(records[kind]?.find(v=>v.id===id)??null),list:kind=>structuredClone(records[kind]??[]),meta:(key,fallback=null)=>key==='workspace_id'?'advanced-search-fixture':fallback};
 for(const [i,item] of cases.entries()){
  const access=new Access(store,store.get('member',item.member));let actual;
  try{actual={ok:advancedSearch(store,access,new URLSearchParams(item.query))};}catch(error){if(!(error instanceof APIError))throw error;actual={status:error.status};}
  assert.deepEqual(actual,expected[i],JSON.stringify(item));
 }
 console.log(`PASS ${cases.length} advanced-search Python/SQLite payload comparisons`);
});
