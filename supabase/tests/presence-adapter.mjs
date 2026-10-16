/** Real CloudStore/transaction coordinator + external-proof RPC MODEL. No cloud calls. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PresenceService,createPresenceAdapter,createPublisherProofProvider} from '../functions/_shared/presence.ts';
import {createTransactions} from '../functions/_shared/transaction.ts';
import {StoreError} from '../functions/_shared/store.ts';
import {APIError} from '../functions/_shared/access.ts';
import {AuthError} from '../functions/_shared/auth.ts';
import {seed_state} from '../functions/_shared/crdt.ts';
const copy=structuredClone,key=(kind,id)=>JSON.stringify([kind,id]),time='2026-10-16T00:00:00.000000+00:00';
const a={hash:'a'.repeat(64),binding:'1'.repeat(32),member:'alice',user:'11111111-1111-4111-8111-111111111111',authSession:'22222222-2222-4222-8222-222222222222',active:true};
const b={hash:'b'.repeat(64),binding:'2'.repeat(32),member:'bob',user:'33333333-3333-4333-8333-333333333333',authSession:'44444444-4444-4444-8444-444444444444',active:true};
function fixture(){
 const data=new Map(),grants=new Map([[a.hash,copy(a)],[b.hash,copy(b)]]);let revision=0,proofCalls=0,depth=0;
 const seed=(kind,value)=>data.set(key(kind,value.id),{kind,id:value.id,data:{...copy(value),created_at:time,updated_at:time},createdAt:time,updatedAt:time});
 const member=id=>data.get(key('member',id))?.data;
 seed('member',{id:'alice',name:'A',email:'a@qa.invalid',role:'member',active:true});seed('member',{id:'bob',name:'B',email:'b@qa.invalid',role:'member',active:true});
 seed('group',{id:'readers',members:['bob']});seed('page',{id:'p',title:'PRIVATE_DOC',permissions:{default:'private',members:{alice:'view'},groups:{readers:'view'}},revision:0,blocks:[{id:'b',text:'한🙂'}]});seed('collaboration',{id:'p',epoch:'e',seq:0,state:seed_state([{id:'b',text:'한🙂'}])});
 const presence=(grant,client='peer')=>({id:PresenceService._identity('p','e',['session',grant.hash],client,'model'),page_id:'p',epoch:'e',member_id:grant.member,origin_kind:'session',origin_id:grant.hash,session_binding:grant.binding,client_id:client,seq:1,left:false,expires_at:115,retain_until:175,selection:null});
 seed('presence',presence(b));
 function authorize(){const grant=grants.get(a.hash),current=member('alice');if(!grant?.active||current?.active!==true)throw new AuthError(401,'AUTH_REQUIRED','Authentication required');return {hash:grant.hash,userId:grant.user,authSessionId:grant.authSession,cacheBinding:grant.binding,expiresAt:Date.now()+100000,profile:{workspaceId:'model',authSessionActive:true,member:copy(current)}};}
 const provider={
  async snapshot({context,selection,expectedRevision}){if(!grants.get(context.sessionHash)?.active)throw new StoreError(401,'AUTH_REQUIRED','Authentication required');if(expectedRevision!==undefined&&expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT','Changed');return {workspaceId:'model',memberId:context.memberId,revision,accessRevision:0,principal:copy(member(context.memberId)),entities:Array.from(data.values()).filter(value=>selection.kinds.includes(value.kind)||(selection.ids[value.kind]||[]).includes(value.id)).map(value=>copy(value)),meta:[],nextCursor:null};},
  async commit(request){if(!grants.get(request.context.sessionHash)?.active)throw new StoreError(401,'AUTH_REQUIRED','Authentication required');if(request.expectedRevision!==revision)throw new StoreError(409,'REVISION_CONFLICT','Changed');for(const change of request.changes){if(change.op==='put'){seed(change.kind,change.data);revision++;}else if(change.op==='delete'){if(data.delete(key(change.kind,change.id)))revision++;}else throw Error('Unexpected meta');}return {revision};}
 };
 const executeBase=createTransactions({provider,authorize:async()=>authorize(),clock:()=>Date.parse(time)});
 const execute=(initial,action,selection)=>executeBase(initial,store=>{depth++;try{return action(store);}finally{depth--;}},selection);
 const f={data,grants,member,seed,presence,authorize,get revision(){return revision;},get proofCalls(){return proofCalls;},change(kind,value){seed(kind,value);revision++;},beforeProof:null,afterProof:null};
 f.proofProvider={async publishers(context,hashes){assert.equal(depth,0,'Proof network inside staged action');proofCalls++;await f.beforeProof?.(proofCalls,context,hashes);if(!grants.get(context.sessionHash)?.active)throw new APIError(401,'Authentication required');const values=[];for(const hash of hashes){const grant=grants.get(hash),current=grant?member(grant.member):null;if(grant?.active&&current?.active===true){const {id,name,email,role,active}=current;values.push({hash,cacheBinding:grant.binding,member:{id,name,email,role,active}});}}await f.afterProof?.(proofCalls,context,hashes);return values;}};
 f.adapter=createPresenceAdapter({execute,proofProvider:f.proofProvider,clock:()=>100});return f;
}
let checks=0;
{
 const f=fixture(),before=copy(f.data),result=await f.adapter.snapshot(f.authorize(),'p');assert.equal(result.participants.length,1);assert.equal(f.proofCalls,2);assert.deepEqual(f.data,before);const participant=result.participants[0];assert.deepEqual(Object.keys(participant).sort(),['client_id','color','id','member_id','name','selection','seq']);assert(!JSON.stringify(participant).includes(b.hash));assert(!JSON.stringify(participant).includes('b@qa.invalid'));checks++;
}
{
 const f=fixture();f.beforeProof=count=>{if(count===2)f.grants.get(b.hash).active=false;};
 const result=await f.adapter.snapshot(f.authorize(),'p');assert.deepEqual(result.participants,[]);assert.equal(f.proofCalls,4);assert.equal(f.data.get(key('presence',f.presence(b).id)).data.left,true);checks++;
}
{
 const f=fixture();f.afterProof=count=>{if(count===1)f.change('group',{id:'readers',members:[]});};
 const result=await f.adapter.snapshot(f.authorize(),'p');assert.deepEqual(result.participants,[]);assert.equal(f.data.get(key('presence',f.presence(b).id)).data.left,true);checks++;
}
{
 const f=fixture();f.change('member',{...f.member('bob'),role:'owner'});f.change('group',{id:'readers',members:[]});
 f.afterProof=count=>{if(count===1)f.change('member',{...f.member('bob'),role:'member'});};
 const result=await f.adapter.snapshot(f.authorize(),'p');assert.deepEqual(result.participants,[]);assert.equal(f.proofCalls,4);checks++;
}
{
 const f=fixture(),carol={hash:'c'.repeat(64),binding:'3'.repeat(32),member:'carol',active:true};
 f.afterProof=count=>{if(count===1){f.grants.set(carol.hash,carol);f.change('member',{id:'carol',name:'C',email:'c@qa.invalid',role:'member',active:true});f.change('group',{id:'readers',members:['bob','carol']});f.change('presence',f.presence(carol));}};
 const result=await f.adapter.snapshot(f.authorize(),'p');assert.equal(result.participants.length,2);assert.equal(f.data.get(key('presence',f.presence(carol).id)).data.left,false);assert.equal(f.proofCalls,3);checks++;
}
{
 const f=fixture();f.beforeProof=count=>{f.grants.get(b.hash).active=count%2===1;};
 await assert.rejects(f.adapter.snapshot(f.authorize(),'p'),error=>error.code==='PRESENCE_CHANGED');assert.equal(f.proofCalls,6);checks++;
}
{
 const f=fixture();f.beforeProof=count=>{if(count===2)f.grants.get(a.hash).active=false;};
 await assert.rejects(f.adapter.snapshot(f.authorize(),'p'),error=>error.status===401);assert.equal(f.proofCalls,2);checks++;
}
{
 const f=fixture(),initial=f.authorize();const response=await f.adapter.snapshotWithDocument(initial,'p',store=>({epoch:store.get('collaboration','p').epoch,page:store.get('page','p'),seq:0}));
 assert.equal(response.snapshot.data_revision,response.presence.revision);assert.equal(response.snapshot.workspace_id,'model');assert.equal(response.snapshot.current_member_id,'alice');assert.equal(response.snapshot.session_binding,a.binding);checks++;
 const result=await f.adapter.update(initial,'p',{session_binding:a.binding,epoch:'e',client_id:'self',seq:1,selection:null});assert.equal(result.ack_seq,1);assert.equal(result.participants.length,2);assert.equal(f.data.get(key('page','p')).data.revision,0);assert.equal(f.data.get(key('collaboration','p')).data.seq,0);checks++;
}
{
 const context={workspaceId:'model',memberId:'alice',userId:a.user,authSessionId:a.authSession,sessionHash:a.hash,cacheBinding:a.binding},calls=[];let reply=()=>new Response('[]');
 const provider=createPublisherProofProvider({supabaseUrl:'https://fixture.invalid',serviceKey:'sb_secret_fixture_not_real',fetch:async(url,options)=>{calls.push({url,options});return reply();}});
 assert.deepEqual(await provider.publishers(context,[b.hash]),[]);assert.deepEqual(JSON.parse(calls[0].options.body),{p_context:context,p_hashes:[b.hash]});assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[0].options.redirect,'error');
 await assert.rejects(provider.publishers(context,[b.hash,b.hash]),error=>error.status===400);
 reply=()=>new Response(JSON.stringify([{hash:b.hash,cacheBinding:b.binding,member:{id:'bob',name:'B',email:'b@qa.invalid',role:'member',active:true},ciphertext:'SECRET'}]));await assert.rejects(provider.publishers(context,[b.hash]),error=>error.status===503&&!error.message.includes('SECRET'));
 reply=()=>new Response('SECRET raw SQL',{status:500});await assert.rejects(provider.publishers(context,[b.hash]),error=>error.status===503&&!error.message.includes('SECRET'));
 reply=()=>new Response('{}',{status:401});await assert.rejects(provider.publishers(context,[b.hash]),error=>error.status===401);
 reply=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));controller.close();}}));await assert.rejects(provider.publishers(context,[b.hash]),error=>error.status===503);checks++;
 const sql=readFileSync(new URL('../migrations/20261016103224_fountain_cloud_presence_publishers.sql',import.meta.url),'utf8');assert(sql.includes('PERFORM fountain_cloud.store_context(p_context)'));assert(sql.includes('FOR SHARE OF v,s,u,m,e'));assert(sql.includes('cardinality(p_hashes)>500'));assert(sql.includes("jsonb_build_object('hash',peer.hash,'cacheBinding',peer.cache_binding,'member',profile->'member')"));assert(/REVOKE ALL ON FUNCTION public\.fountain_cloud_presence_publishers[^;]+FROM PUBLIC,anon,authenticated;/.test(sql));assert(!/GRANT[^;]+fountain_private/i.test(sql));checks++;
}
console.log(JSON.stringify({ok:true,checks,pureActionsNeverCallProofRPC:true,currentMemberAndGroupACL:true,missingNewPeerRestarts:true,finalRevocationGuard:true,snapshotProjectionRevisionPinned:true,actualPostgreSQL:false}));
