/** Actual Inbox/Access/default CloudStore; RPC provider is a private model. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {Inbox} from '../functions/_shared/inbox.ts';
import {createDomain} from '../functions/_shared/domain.ts';
import {createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {projectPageHeader,PAGE_HEADER_META_KEY} from '../functions/_shared/page-headers.ts';
import {projectVerificationIndex,VERIFICATION_INDEX_META_KEY} from '../functions/_shared/verification-index.ts';
// Date.now-style clock is millisecond precision; exact-boundary fixture agrees.
const stamp='2026-10-17T00:00:00.123000Z',now=Date.parse(stamp);
class Store{
 records=new Map();requestTime=stamp;context={memberId:'alice'};
 get(kind,id){return clone(this.records.get(kind)?.get(id)??null)}
 list(kind){return [...(this.records.get(kind)?.values()??[])].map(clone)}
 meta(key,fallback=null){return clone(fallback)}
 put(kind,value){if(!this.records.has(kind))this.records.set(kind,new Map());const v={created_at:stamp,updated_at:stamp,...clone(value)};this.records.get(kind).set(v.id,v);return clone(v)}
}
function fixture(){const s=new Store();for(const [id,role]of [['local','owner'],['alice','member'],['bob','member'],['guest','guest'],['inactive','member']])s.put('member',{id,name:id,role,active:id!=='inactive'});
 s.put('settings',{id:'workspace'});s.put('teamspace',{id:'general',visibility:'open',members:['alice','bob'],groups:[]});
 s.put('database',{id:'db',name:'Knowledge',icon:'📚',owner_id:'local',teamspace_id:'general',permissions:{default:'private',inherit:false,members:{alice:'edit',bob:'edit',guest:'view'},groups:{}},row_permissions:{},properties:[{id:'name',name:'Name',type:'title'},{id:'notes',name:'Notes',type:'text'},{id:'assigned',name:'Assigned',type:'person'},{id:'owners',name:'Owner',type:'owner',generation:1,initial_default:'created_by',default:'created_by',limit:'unlimited'},{id:'verified',name:'Verification',type:'verification',generation:2,owner_property_id:'owners'}]});
 s.put('row',{id:'row😀',database_id:'db',owner_id:'alice',properties:{name:'Current knowledge',notes:'PRIVATE BODY',assigned:'alice',owners:['alice','guest']},_owner_generations:{owners:1},verification:{generation:2,verified_by:'local',verified_at:'2026-10-16T00:00:00Z',expires_at:stamp,private_extra:'never'},verification_cycle:3,unknown:'preserve'});return s;
}
const inbox=(s,actor='alice')=>new Inbox(s,new Access(s,s.get('member',actor)),()=>now),q=value=>new URLSearchParams(value);
let checks=0;
{
 const s=fixture(),before=clone(s.records),result=inbox(s).get(q('')),item=result.items[0];assert.equal(result.total,1);assert.equal(item.resource_type,'row');assert.equal(item.database_id,'db');assert.equal(item.row_id,'row😀');assert.equal(item.title,'Current knowledge');assert(!JSON.stringify(result).includes('PRIVATE BODY'));assert(!JSON.stringify(result).includes('generation'));assert.deepEqual(s.records,before);checks++;
 for(const actor of ['local','bob','inactive'])assert.equal(inbox(s,actor).get(q('')).total,0);assert.equal(inbox(s,'guest').get(q('')).total,1);checks++;
 inbox(s).patch(item.id,{read:true});assert.equal(inbox(s).get(q('')).items[0].read,true);assert.equal(inbox(s,'guest').get(q('')).items[0].read,false);inbox(s).patch(item.id,{archived:true});assert.equal(inbox(s).get(q('')).total,0);assert.equal(inbox(s).get(q('filter=archived')).total,1);assert.deepEqual(s.get('row','row😀'),before.get('row').get('row😀'));checks++;
 for(const actor of ['local','bob'])assert.throws(()=>inbox(s,actor).patch(item.id,{read:true}),e=>e instanceof APIError&&e.status===404);checks++;
 const row=s.get('row','row😀');row.verification_cycle=4;s.put('row',row);assert.notEqual(inbox(s).get(q('')).items[0].id,item.id);assert.throws(()=>inbox(s).patch(item.id,{read:true}),e=>e.status===404);checks++;
 const db=s.get('database','db');db.row_permissions={mode:'assigned',property_id:'assigned',edit_assigned:true};s.put('database',db);assert.equal(inbox(s).get(q('')).total,1);assert.equal(inbox(s,'guest').get(q('')).total,0);checks++;
 db.properties.find(p=>p.type==='verification').generation=3;s.put('database',db);assert.equal(inbox(s).get(q('')).total,0);checks++;
}
// Exact notification and receipt protocol parity, not fake human Auth.
{
 const s=fixture(),records=Object.fromEntries([...s.records].map(([kind])=>[kind,s.list(kind)])),values=[];
 for(const actor of ['alice','guest','bob','local']){const i=inbox(s,actor),v=i.get(q(''));values.push(v);if(v.items.length){values.push(i.patch(v.items[0].id,{read:true}));values.push(i.get(q('filter=unread')));}}
 const code=`import json,sys\nfrom datetime import datetime\nfrom fountain.core import Store\nfrom fountain.access import Access\nfrom fountain.inbox import Inbox\nx=json.load(sys.stdin);s=Store(':memory:')\nfor k,rows in x['records'].items():\n for row in rows:s.put(k,row)\nout=[]\nfor actor in ['alice','guest','bob','local']:\n i=Inbox(s,Access(s,s.get('member',actor)),clock=lambda:datetime.fromisoformat(x['stamp']));v=i.get({});out.append(v)\n if v['items']:\n  out.extend([i.patch(v['items'][0]['id'],{'read':True}),i.get({'filter':['unread']})])\nprint(json.dumps(out));s.close()`;
 const result=spawnSync(process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/fountain/.data/supabase-venv/bin/python',['-c',code],{encoding:'utf8',input:JSON.stringify({records,stamp})});assert.equal(result.status,0,result.stderr);assert.deepEqual(values,JSON.parse(result.stdout));checks++;console.log('PASS '+values.length+' row expiry Python/SQLite versus TypeScript DTO/receipt results');
}
{
 const s=fixture();let revision=0,snapshots=0,writes=0,bodyKinds=[];
 const auth={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:now+60000,profile:{workspaceId:'db-inbox-fixture',member:s.get('member','alice'),authSessionActive:true}};
 const provider={async snapshot(request){snapshots++;const selected=request.selection,all=[...s.records].flatMap(([kind,rows])=>[...rows.values()].filter(data=>selected.kinds.includes(kind)||selected.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at})));for(const v of all)if(['row','database','page'].includes(v.kind))bodyKinds.push(v.kind);const offset=request.cursor?.offset??0,size=selected.pageSize;
  return{workspaceId:'db-inbox-fixture',memberId:'alice',principal:auth.profile.member,revision,accessRevision:0,entities:clone(all.slice(offset,offset+size)),meta:selected.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,present:true,value:s.list('page').map(projectPageHeader)}:key===VERIFICATION_INDEX_META_KEY?{key,present:true,value:projectVerificationIndex(s.list('database'),s.list('row'))}:{key,present:false,value:null}),nextCursor:offset+size<all.length?{offset:offset+size}:null};},async commit(request){for(const change of request.changes){assert.equal(change.op,'put');assert.equal(change.kind,'inbox_receipt');s.put(change.kind,change.data);revision++;writes++;}return{revision}}};
 const domain=createDomain({provider,authorize:async()=>clone(auth),clock:()=>now,extensions:[createAdvancedExtension({cloud:true,clock:()=>now})]});
 const result=await domain(new Request('https://fixture.example/api/inbox'),'/api/inbox',auth),body=await result.json();assert.equal(result.status,200);assert.equal(body.total,1);assert.equal(writes,0);assert.deepEqual(bodyKinds,[]);assert(snapshots<20);
 const path='/api/inbox/'+body.items[0].id,reply=await domain(new Request('https://fixture.example'+path,{method:'PATCH',body:JSON.stringify({read:true})}),path,auth);assert.equal(reply.status,200);assert.equal((await reply.json()).read,true);assert.equal(writes,1);assert.deepEqual(bodyKinds,[]);checks++;console.log(JSON.stringify({actualCloudStore:true,actualCloud:false,snapshots,receiptWrites:writes,rawBodyKinds:bodyKinds}));
}
console.log('PASS '+checks+' row Inbox source/role/generation/receipt/default-transaction checks');
