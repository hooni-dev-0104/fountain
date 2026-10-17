/** Body-free wiki/verification integration on actual CloudStore/default
 * transactions, with SQL virtual-header metadata emulated by an atomic RPC
 * model. This is not actual Supabase/PostgreSQL/Auth/SDK execution. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Access,clone} from '../functions/_shared/access.ts';
import {PAGE_HEADER_META_KEY,projectPageHeader} from '../functions/_shared/page-headers.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {Wiki} from '../functions/_shared/wiki.ts';
import {Workspace} from '../functions/_shared/core.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
const {createDomain}=await import(process.env.FOUNTAIN_TEST_DOMAIN_MODULE||'../functions/_shared/domain.ts');
const {createAdvancedExtension}=await import(process.env.FOUNTAIN_TEST_ADVANCED_MODULE||'../functions/_shared/advanced.ts');
const time='2026-10-16T00:00:00.123000+00:00',largeBlocks=()=>Array.from({length:500},(_,i)=>({id:'b'+i,type:'paragraph',text:'x'.repeat(2500)}));
const acl={default:'private',inherit:false,members:{alice:'full',bob:'edit',guest:'edit'},groups:{}};
function fixture({depth=1,inherited=false,headerMode='valid'}={}){
 const rows=new Map(),metadata=new Map(),operations=[];let revision=0,actor='alice',current=null;
 function put(kind,data){if(!rows.has(kind))rows.set(kind,new Map());rows.get(kind).set(data.id,clone({...data,created_at:data.created_at??time,updated_at:time}));}
 for(const [id,role]of [['alice','member'],['bob','member'],['guest','guest']])put('member',{id,name:id,role,active:true,email:id+'@example.invalid'});
 put('settings',{id:'workspace',name:'Fountain'});
 put('page',{id:'root',title:'Knowledge',icon:'📖',parent_id:null,is_wiki:true,owner_id:'alice',revision:0,permissions:{...acl,members:{alice:'full',bob:'edit'}},blocks:largeBlocks(),cover:'original-cover',private_payload:{unchanged:true}});
 for(let i=1;i<depth;i++)put('page',{id:'ancestor-'+i,title:'Ancestor '+i,parent_id:i===1?'root':'ancestor-'+(i-1),owner_id:'alice',revision:0,permissions:inherited?{default:'private',inherit:true,members:{},groups:{}}:acl,blocks:largeBlocks(),cover:'ancestor cover'});
 put('page',{id:'child',title:'Child',icon:'📄',parent_id:depth===1?'root':'ancestor-'+(depth-1),owner_id:'alice',revision:0,permissions:inherited?{default:'private',inherit:true,members:{},groups:{}}:clone(acl),blocks:[{id:'body',type:'paragraph',text:'preserve target body'}],cover:'child-cover',private_payload:{unchanged:true},verification:{owners:['alice'],owner:'alice',verified_by:'alice',verified_at:'2020-01-01T00:00:00Z',expires_at:null,cycle_revision:0}});
 put('page',{id:'ordinary',title:'Ordinary',parent_id:null,owner_id:'alice',revision:0,permissions:clone(acl),blocks:[{id:'ordinary-body',type:'paragraph',text:'preserve ordinary body'}],cover:'ordinary-cover',private_payload:{unchanged:true}});
 for(let i=0;i<60;i++)put('page',{id:'unrelated-'+i,title:'Private unrelated '+i,parent_id:null,owner_id:'someone-else',revision:0,permissions:{default:'private',inherit:false,members:{},groups:{}},blocks:largeBlocks(),cover:'never-include-in-headers'});
 const pageHash=()=>{const hash=createHash('sha256');for(const page of rows.get('page').values())hash.update(JSON.stringify(page));return hash.digest('hex');};
 const provider={async snapshot(request){
  current.snapshots++;current.pageKind ||= request.selection.kinds.includes('page');
  const selected=[...rows].flatMap(([kind,values])=>[...values.values()].filter(data=>request.selection.kinds.includes(kind)||request.selection.ids[kind]?.includes(data.id)).map(data=>({kind,id:data.id,data,createdAt:data.created_at,updatedAt:data.updated_at}))),offset=request.cursor?.offset??0,size=Math.min(request.selection.pageSize,4),entities=clone(selected.slice(offset,offset+size));
  for(const record of entities)if(record.kind==='page')current.bodyIds.add(record.id);
  const headers=[...rows.get('page').values()].map(projectPageHeader).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const result={workspaceId:'wiki-header-fixture',memberId:request.context.memberId,revision,accessRevision:0,principal:clone(rows.get('member').get(request.context.memberId)),entities,meta:request.selection.metaKeys.map(key=>key===PAGE_HEADER_META_KEY?{key,value:headerMode==='valid'?headers:headerMode==='invalid'?[{id:'root',blocks:[]}]:null,present:headerMode!=='missing'}:{key,value:metadata.get(key)??null,present:metadata.has(key)}),nextCursor:offset+size<selected.length?{offset:offset+size}:null};
  const bytes=Buffer.byteLength(JSON.stringify(result));current.maxResponseBytes=Math.max(current.maxResponseBytes,bytes);assert(bytes<16*1024*1024);return result;
 },async commit(request){current.commits++;current.changes=clone(request.changes);assert.equal(request.expectedRevision,revision);for(const change of request.changes){if(change.op==='put')put(change.kind,change.data);else if(change.op==='delete')rows.get(change.kind)?.delete(change.id);else metadata.set(change.key,clone(change.value));revision++;}return{revision};}};
 const auth=()=>({hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'c'.repeat(32),expiresAt:Date.parse(time)+60000,profile:{workspaceId:'wiki-header-fixture',authSessionActive:true,member:clone(rows.get('member').get(actor))}});
 const domain=createDomain({provider,extensions:[createAdvancedExtension({cloud:true})],authorize:async()=>auth(),clock:()=>Date.parse(time)});
 function begin(label){current={label,snapshots:0,commits:0,pageKind:false,bodyIds:new Set(),maxResponseBytes:0,changes:[]};return current;}
 function finish(op){operations.push({...op,bodyIds:[...op.bodyIds]});}
 async function call(method,id,kind,body,as='alice'){
  actor=as;const op=begin(method+' '+id+'/'+kind),before=pageHash(),path='/api/pages/'+id+'/'+kind;
  try{const response=await domain(new Request('https://fixture.example'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),path,auth()),value=await response.json();if(method==='GET'){assert.equal(pageHash(),before);assert.deepEqual(op.changes,[]);}return{status:response.status,value,op};}
  catch(error){assert.equal(pageHash(),before);assert.equal(op.commits,0);console.log(JSON.stringify({rejectedOperation:{label:op.label,status:error.status,code:error.code??null,snapshots:op.snapshots,commits:op.commits,pageKind:op.pageKind,bodyIds:[...op.bodyIds],maxResponseBytes:op.maxResponseBytes,sourceUnchanged:true}}));throw error;}
  finally{finish(op);}
 }
 return{rows,metadata,operations,call,provider,auth,begin,finish,pageHash,get:(id)=>clone(rows.get('page').get(id))};
}
let checks=0;
{
 const f=fixture(),originalOrdinary=f.get('ordinary'),originalChild=f.get('child'),originalRoot=f.get('root');
 const ordinary=await f.call('GET','ordinary','wiki-owner');assert.equal(ordinary.value.in_wiki,false);assert.equal(ordinary.value.owner,null);assert.deepEqual(ordinary.op.bodyIds.size,0);checks++;
 const view=await f.call('GET','root','wiki');assert.equal(view.value.total,1);assert.equal(view.value.items[0].owner.id,'alice');assert.equal(view.op.bodyIds.size,0);assert(!JSON.stringify(view.value).includes('preserve target body'));checks++;
 const hidden=await f.call('GET','child','wiki-owner',undefined,'guest');assert.equal(hidden.value.in_wiki,true);assert.equal(hidden.value.wiki,null);assert.equal(hidden.value.owner,null);assert.deepEqual(hidden.value.members,[{id:'guest',name:'guest'}]);checks++;
 const converted=await f.call('POST','ordinary','wiki',{revision:0});assert.equal(converted.status,200);assert.deepEqual([...converted.op.bodyIds],['ordinary']);for(const key of ['blocks','cover','private_payload','owner_id','permissions'])assert.deepEqual(f.get('ordinary')[key],originalOrdinary[key]);checks++;
 await f.call('DELETE','ordinary','wiki',{revision:1});for(const key of ['blocks','cover','private_payload','owner_id','permissions'])assert.deepEqual(f.get('ordinary')[key],originalOrdinary[key]);checks++;
 const owner=await f.call('PATCH','child','wiki-owner',{owner_id:'bob',revision:0});assert.equal(owner.value.owner.id,'bob');assert.deepEqual([...owner.op.bodyIds],['child']);for(const key of ['blocks','cover','private_payload','owner_id','permissions'])assert.deepEqual(f.get('child')[key],originalChild[key]);assert.equal(f.get('child').verification.verified_at,originalChild.verification.verified_at);assert.equal(f.metadata.has('access_revision'),false);checks++;
 const verified=await f.call('POST','child','verify',{owners:['bob'],revision:1},'bob');assert.deepEqual(verified.value.verification.owners,['bob']);assert.deepEqual([...verified.op.bodyIds],['child']);checks++;
 await f.call('DELETE','child','verify',{revision:2},'bob');assert.equal(f.get('child').verification,undefined);for(const key of ['blocks','cover','private_payload','owner_id','permissions'])assert.deepEqual(f.get('child')[key],originalChild[key]);checks++;
 assert.deepEqual(f.get('root'),originalRoot);assert(f.operations.every(op=>!op.pageKind&&!op.bodyIds.some(id=>id.startsWith('unrelated-'))));
 console.log(JSON.stringify({wideOrdinaryAndWiki:f.operations.map(({label,snapshots,commits,pageKind,bodyIds,maxResponseBytes,changes})=>({label,snapshots,commits,pageKind,bodyIds,maxResponseBytes,domainWrites:changes.length}))}));
}
for(const [depth,inherited]of [[100,false],[30,true]]){
 const f=fixture({depth,inherited}),as=inherited?'bob':'alice';
 const view=await f.call('GET','child','wiki-owner',undefined,as);assert.equal(view.value.in_wiki,true);assert.equal(view.op.bodyIds.size,0);
 if(inherited)await f.call('PATCH','child','wiki-owner',{owner_id:'bob',revision:0},as);
 const page=f.get('child'),result=await f.call('POST','child','verify',{owners:[as],revision:page.revision},as);assert.equal(result.status,200);assert.deepEqual([...result.op.bodyIds],['child']);assert(f.operations.every(op=>!op.pageKind&&!op.bodyIds.some(id=>id==='root'||id.startsWith('ancestor-')||id.startsWith('unrelated-'))));checks+=2;
 console.log(JSON.stringify({depth,inherited,operations:f.operations.map(({label,snapshots,bodyIds,maxResponseBytes})=>({label,snapshots,bodyIds,maxResponseBytes}))}));
}
{
 const f=fixture(),op=f.begin('staged move/undo'),execute=createTransactions({provider:f.provider,authorize:async()=>f.auth(),clock:()=>Date.parse(time)});
 await execute(f.auth(),s=>{
  const genericAccess=new Access(s,s.principal),genericAuthority=new Authorization(genericAccess);
  genericAuthority.prepare('PATCH','/api/pages/child',{title:'no mutation'});assert.equal(genericAccess.store,s);assert.equal(genericAuthority.store,s);
  const access=new Access(s,s.principal),authority=new Authorization(access);authority.prepare('GET','/api/pages/child/wiki-owner',{});
  const reader=access.store,wiki=new Wiki(s,access),workspace=new Workspace(s,{actor:'alice',access});assert.equal(wiki.headers,reader);assert.equal(authority.store,reader);
  workspace.update_page('child',{parent_id:null,revision:0});assert.equal(wiki.ownerView('child').in_wiki,false);
  workspace.update_page('child',{parent_id:'root',revision:1});assert.equal(wiki.ownerView('child').in_wiki,true);
  wiki.convert('DELETE','root',{revision:0});assert.equal(wiki.ownerView('child').in_wiki,false);
  wiki.convert('POST','root',{revision:1});assert.equal(wiki.ownerView('child').in_wiki,true);
 });f.finish(op);assert.equal(f.get('child').parent_id,'root');assert.equal(f.get('root').is_wiki,true);assert.equal(f.get('child').blocks[0].text,'preserve target body');assert(!op.pageKind);checks++;
}
for(const headerMode of ['missing','invalid']){
 const f=fixture({headerMode});await assert.rejects(()=>f.call('GET','ordinary','wiki-owner'),error=>error.status===503);assert(f.operations.every(op=>!op.pageKind&&op.bodyIds.length===0));checks++;
}
console.log('PASS '+checks+' production wiki/header domain integration checks: body-free GET/ACL/ancestry, raw mutation body preservation, wide/deep/inherited/hidden/overlay/fail-closed; RPC model only');
