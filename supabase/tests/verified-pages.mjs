/** Directory production modules and default CloudStore with a private RPC model. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {VerifiedPages,verifiedPagesQuery} from '../functions/_shared/verified-pages.ts';
import {createDomain} from '../functions/_shared/domain.ts';
import {createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
import {VERIFICATION_INDEX_META_KEY,projectVerificationIndex} from '../functions/_shared/verification-index.ts';
const python=process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/fountain/.data/supabase-venv/bin/python';
const stamp='2026-10-17T00:00:00.123000Z',now=Date.parse(stamp);
function runPython(code,input){const out=spawnSync(python,['-c',code],{encoding:'utf8',input:JSON.stringify(input),maxBuffer:4*1024*1024});assert.equal(out.status,0,out.stderr);return JSON.parse(out.stdout);}
const records=runPython(`import json\nfrom fountain.core import Store\nfrom tests.test_verified_pages import fixture\ns=Store(':memory:');fixture(s)\nprint(json.dumps({k:s.list(k) for k in ['member','teamspace','page','database','row']}));s.close()`);
class Store{
 records=new Map();requestTime=stamp;
 constructor(values=records){for(const[kind,rows]of Object.entries(values))for(const row of rows)this.put(kind,row);}
 get(kind,id){return clone(this.records.get(kind)?.get(id)??null)}
 list(kind){return [...(this.records.get(kind)?.values()??[])].map(clone)}
 meta(key,fallback=null){return clone(fallback)}
 put(kind,value){if(!this.records.has(kind))this.records.set(kind,new Map());const record={created_at:stamp,updated_at:stamp,...clone(value)};this.records.get(kind).set(record.id,record);return clone(record)}
}
const listing=(s=new Store(),actor='alice',q='',clock=()=>now)=>new VerifiedPages(s,new Access(s,s.get('member',actor)),clock).get(new URLSearchParams(q));
let checks=0;
{
 const s=new Store(),before=clone(s.records),value=listing(s);assert.deepEqual(value.items.map(x=>x.id),['row😀','page','wiki']);assert.deepEqual(value.items.map(x=>x.verification.status),['verified','expired','verified']);assert.deepEqual(s.records,before);
 for(const privateText of ['never','generation','revision','Hidden','Database private title','permissions','inactive'])assert(!JSON.stringify(value).includes(privateText));checks++;
 const guest=listing(s,'guest');assert.equal(guest.total,3);assert.deepEqual(guest.filters.owners,[{id:'guest',name:'guest'}]);assert.deepEqual(guest.filters.teamspaces,[{id:'new',name:'new space'}]);
 for(const q of ['owner=alice','owner=inactive','owner=absent','teamspace=private','teamspace=old','teamspace=absent']){const value=listing(s,'guest',q);assert.equal(value.total,0);assert.deepEqual(value.filters,guest.filters);}checks++;
 const page=s.get('page','page');page.verification.owners=['alice'];s.put('page',page);assert.deepEqual(listing(s,'guest').items.find(x=>x.id==='page').owners,[]);checks++;
 assert.equal(listing(s,'inactive').total,0);assert.equal(listing(s,'alice','q=STRASSE+a').items[0].id,'page');assert.equal(listing(s,'alice','q=.*').total,0);checks++;
 const whole=listing(s),second=listing(s,'alice','limit=1&offset=1');assert.deepEqual(second.items,whole.items.slice(1,2));assert.equal(second.total,3);assert.equal(second.has_more,true);assert.deepEqual(listing(s,'alice','q=missing').filters,whole.filters);checks++;
 assert.equal(listing(s,'alice','',()=>now+1).items.find(x=>x.id==='row😀').verification.status,'expired');checks++;
}
for(const q of ['q=a&q=b','unknown=x','__proto__=x','status=Verified','kind=database','owner=','teamspace=x%0a','q=%00','limit=01','limit=0','limit=101','offset=-1','offset=1000001','offset=1.0','offset=1%0a']){assert.throws(()=>verifiedPagesQuery(new URLSearchParams(q)),e=>e instanceof APIError&&e.status===400);checks++;}
for(const q of [null,[],{q:['a','b']},{q:'a'},{q:['\ud800']},{q:['😀'.repeat(201)]}]){assert.throws(()=>verifiedPagesQuery(q),e=>e instanceof APIError&&e.status===400);checks++;}assert.equal(verifiedPagesQuery({q:['😀'.repeat(200)]}).q,'😀'.repeat(200));checks++;
{
 const s=new Store();for(const parent of ['', 'missing',12,'page']){const p=s.get('page','page');p.parent_id=parent;s.put('page',p);assert.equal(listing(s).items.find(x=>x.id==='page').teamspace,null);}checks++;
 for(let i=0;i<65;i++)s.put('page',{id:String(i),owner_id:'local',teamspace_id:'new',parent_id:i<64?String(i+1):null});
 const page=s.get('page','page');page.parent_id='1';s.put('page',page);assert.equal(listing(s).items.find(x=>x.id==='page').teamspace.id,'new');page.parent_id='0';s.put('page',page);assert.equal(listing(s).items.find(x=>x.id==='page').teamspace,null);checks++;
 s.put('page',{id:'db',owner_id:'local',teamspace_id:'new'});const db=s.get('database','db');db.parent_id='db';s.put('database',db);assert.equal(listing(s).items.find(x=>x.resource_type==='row').teamspace.id,'new');checks++;
}
// Exact DTO and error protocol parity with real Python SQLite, at one pinned clock.
{
 const cases=[];for(const actor of ['alice','guest','bob','local','inactive'])for(const query of ['', 'status=expired','kind=row&owner=bob','teamspace=new','owner=absent','q=STRASSE+a','limit=1&offset=1'])cases.push({actor,query});
 for(const query of ['q=a&q=b','unknown=x','status=Verified','owner=','limit=01','offset=1000001'])cases.push({actor:'guest',query});
 const base=new Store(),page=base.get('page','page'),row=base.get('row','row😀'),db=base.get('database','db');
 const variants=[
  [{kind:'page',value:{...page,parent_id:''}}], [{kind:'page',value:{...page,parent_id:'missing'}}], [{kind:'page',value:{...page,parent_id:'page'}}],
  [{kind:'page',value:{...page,verification:{...page.verification,owners:['alice']}}}],
  [{kind:'page',value:{...page,verification:{...page.verification,owners:['inactive']}}}],
  [{kind:'page',value:{...page,archived:true}}], [{kind:'row',value:{...row,deleted:true}}],
  [{kind:'row',value:{...row,verification:{...row.verification,generation:99}}}],
  [{kind:'row',value:{...row,verification:{...row.verification,verified_at:false}}}],
  [{kind:'row',value:{...row,verification_cycle:false}}],
  [{kind:'database',value:{...db,row_permissions:{mode:'assigned',property_id:'assigned',edit_assigned:true}}}],
  [{kind:'database',value:{...db,properties:db.properties.slice(0,3)}}],
  [{kind:'database',value:{...db,properties:db.properties.map(p=>p.type==='verification'?{...p,generation:3}:p)}}],
  [{kind:'database',value:{...db,properties:db.properties.map(p=>p.type==='verification'?{...p,generation:false}:p)}}],
  [{kind:'row',value:{...row,properties:{...row.properties,owners:['inactive']}}}],
  [{kind:'page',value:{...page,id:'bmp',title:'\uE000'}},{kind:'page',value:{...page,id:'astral',title:'😀'}}],
 ];
 for(const actor of ['alice','guest'])for(const changes of variants)cases.push({actor,query:'',changes});
 const actual=cases.map(({actor,query,changes=[]})=>{const store=new Store();for(const {kind,value}of changes)store.put(kind,value);try{return{status:200,body:listing(store,actor,query)}}catch(error){return{status:error.status,error:error.message}}});
 const expected=runPython(`import json,sys\nfrom urllib.parse import parse_qs\nfrom datetime import datetime\nfrom fountain.core import Store,APIError\nfrom fountain.access import Access\nfrom fountain.verified_pages import VerifiedPages\nx=json.load(sys.stdin);out=[]\nfor case in x['cases']:\n s=Store(':memory:')\n for k,rows in x['records'].items():\n  for row in rows:s.put(k,row)\n for change in case.get('changes',[]):s.put(change['kind'],change['value'])\n try:out.append({'status':200,'body':VerifiedPages(s,Access(s,s.get('member',case['actor'])),clock=lambda:datetime.fromisoformat(x['stamp'])).get(parse_qs(case['query'],keep_blank_values=True))})\n except APIError as e:out.append({'status':e.status,'error':str(e)})\n s.close()\nprint(json.dumps(out))`,{records,cases,stamp});assert.deepEqual(actual,expected);checks++;console.log('PASS '+cases.length+' directory Python SQLite / TypeScript protocol results');
}
{
 const s=new Store();let snapshots=0,writes=0,bodyKinds=[],maxBytes=0,missingMeta=false;
 // A thousand eligible page owners exercise preload instead of 1,000 RPC rounds.
 const page=s.get('page','page');page.verification.owners=[];for(let i=0;i<1000;i++){const id='owner'+i;s.put('member',{id,name:id,role:'member',active:true});page.verification.owners.push(id);page.permissions.members[id]='view';}s.put('page',page);
 // Large unrelated bodies are deliberately outside reserved metadata selections.
 s.put('database',{id:'unrelated',properties:[{id:'name',type:'title'},{id:'body',type:'text'}]});const body='x'.repeat(50000);for(let i=0;i<1600;i++)s.put('row',{id:'big'+i,database_id:'unrelated',properties:{name:'irrelevant',body}});
 const row=s.get('row','row😀');row.properties.body='y'.repeat(5*1024*1024);s.put('row',row);
 const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:now+60000,profile:{workspaceId:'verified-directory-model',member:s.get('member','alice'),authSessionActive:true}};
 const provider={async snapshot(request){snapshots++;const selection=request.selection,all=[];for(const[kind,rows]of s.records)if(selection.kinds.includes(kind)||selection.ids[kind])for(const data of rows.values())if(selection.kinds.includes(kind)||selection.ids[kind]?.includes(data.id)){all.push({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at});if(['row','database','page'].includes(kind))bodyKinds.push(kind);}
  const offset=request.cursor?.offset??0,size=selection.pageSize,result={workspaceId:'verified-directory-model',memberId:'alice',principal:auth.profile.member,revision:0,accessRevision:0,entities:clone(all.slice(offset,offset+size)),meta:selection.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,present:!missingMeta,value:missingMeta?null:s.list('page').map(projectPageHeader)}:key===VERIFICATION_INDEX_META_KEY?{key,present:!missingMeta,value:missingMeta?null:projectVerificationIndex(s.list('database'),s.list('row'))}:{key,present:false,value:null}),nextCursor:offset+size<all.length?{offset:offset+size}:null};maxBytes=Math.max(maxBytes,new TextEncoder().encode(JSON.stringify(result)).length);return result;},async commit(request){writes+=request.changes.length;assert.deepEqual(request.changes,[],'directory attempted a write');return{revision:0};}};
 const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>now,extensions:[createAdvancedExtension({cloud:true,clock:()=>now})]});
 async function call(path='/api/verified-pages',method='GET',query=''){const request=new Request('https://fixture.example'+path+(query?'?'+query:''),{method});return domain(request,path,auth);}
 const response=await call(),result=await response.json();assert.equal(response.status,200);assert.equal(result.total,3);assert.equal(result.items.find(x=>x.id==='page').owners.length,1000);assert.equal(result.filters.owners.length,1003);assert.deepEqual(bodyKinds,[]);assert.equal(writes,0);assert(snapshots<64,'snapshot rounds '+snapshots);checks++;
 const getCount=snapshots;const head=await call('/api/verified-pages','HEAD');assert.equal(head.status,200);assert.deepEqual(await head.json(),result); // Transport wrapper suppresses HEAD response bytes.
 assert.equal(writes,0);assert.deepEqual(bodyKinds,[]);checks++;
 const filtered=await call('/api/verified-pages','GET','owner=absent');assert.equal((await filtered.json()).total,0);assert.equal(writes,0);checks++;
 for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS'])await assert.rejects(()=>call('/api/verified-pages',method),e=>e.status>=400);for(const path of ['/api/verified-pages/','/api/verified-pages/x'])await assert.rejects(()=>call(path),e=>e.status>=400);checks++;
 missingMeta=true;await assert.rejects(()=>call(),e=>e.status===503);assert.equal(writes,0);assert.deepEqual(bodyKinds,[]);checks++;
 console.log(JSON.stringify({actualCloudStore:true,actualCloud:false,initialGetSnapshots:getCount,totalSnapshots:snapshots,maxSnapshotBytes:maxBytes,writes,rawBodyKinds:bodyKinds,unrelatedBodyBytes:1600*body.length,largeVerifiedRowBytes:row.properties.body.length}));
}
console.log('PASS '+checks+' verified directory checks');
