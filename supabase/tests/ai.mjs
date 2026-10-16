import assert from 'node:assert/strict';
import test from 'node:test';
import {createAI} from '../functions/_shared/ai.ts';
const copy=structuredClone,stamp='2026-10-16T00:00:00.000000+00:00';
function fixture(){
 const key=(kind,id)=>JSON.stringify([kind,id]),records=new Map();let revision=0;
 const seed=(kind,data)=>{records.set(key(kind,data.id),{kind,id:data.id,data:{...copy(data),created_at:stamp,updated_at:stamp},createdAt:stamp,updatedAt:stamp});};
 seed('settings',{id:'workspace'});seed('page',{id:'p',title:'captured title',blocks:[{text:'captured body'}],owner_id:'alice',permissions:{default:'private'},archived:false});
 const context={hash:'a'.repeat(64),userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',cacheBinding:'b'.repeat(32),expiresAt:Date.now()+60000,profile:{workspaceId:'qa',authSessionActive:true,member:{id:'alice',role:'member',active:true}}};let active=copy(context),calls=0;
 const provider={async snapshot(r){const s=r.selection;return {workspaceId:'qa',memberId:'alice',revision,accessRevision:0,principal:copy(context.profile.member),entities:[...records.values()].filter(v=>s.kinds.includes(v.kind)||s.ids[v.kind]?.includes(v.id)).map(value=>copy(value)),meta:s.metaKeys.map(key=>({key,value:null,present:false})),nextCursor:null};},async commit(r){assert.equal(r.expectedRevision,revision);for(const c of r.changes){if(c.op==='put')seed(c.kind,c.data);else if(c.op==='delete')records.delete(key(c.kind,c.id));revision++;}return {revision};}};
 return {context,records,provider,authorize:async()=>copy(active),switchLogin(){active.cacheBinding='c'.repeat(32);},hidePage(){const p=records.get(key('page','p'));p.data.owner_id='bob';revision++;},get calls(){return calls;},infer:async(url,options)=>{calls++;assert.equal(url,'https://provider.invalid/infer');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer private-fixture-key');assert.match(JSON.parse(options.body).messages[1].content,/captured body/);return new Response(JSON.stringify({choices:[{message:{content:'summary'}}]}));}};
}
const env={FOUNTAIN_AI_URL:'https://provider.invalid/infer',FOUNTAIN_AI_MODEL:'fixture-model',FOUNTAIN_AI_KEY:'private-fixture-key'};
test('authorized source is inferred outside transactions and only a safe result is published',async()=>{
 const f=fixture(),run=createAI({...f,env,fetch:f.infer});const result=await run({action:'summarize',prompt:'요약',page_id:'p'},f.context);
 assert.deepEqual(result,{text:'summary',provider:'provider.invalid',model:'fixture-model',citations:[{page_id:'p'}]});assert.equal(f.calls,1);assert.equal([...f.records.values()].filter(v=>v.kind==='audit'&&v.data.action==='ai.executed').length,1);
 assert(!JSON.stringify(result).includes('private-fixture-key'));
});
test('login change or page denial during provider wait cannot return output or audit success',async()=>{
 for(const change of ['switchLogin','hidePage']){
  const f=fixture(),run=createAI({...f,env,fetch:async(...args)=>{const result=await f.infer(...args);f[change]();return result;}});
  await assert.rejects(run({prompt:'요약',page_id:'p'},f.context),error=>[401,404].includes(error.status));
  assert.equal(f.calls,1);assert.equal([...f.records.values()].filter(v=>v.kind==='audit').length,0);
 }
});
test('an unconfigured provider cannot pretend to generate content or call a paid API',async()=>{
 const f=fixture(),run=createAI({...f,env:{},fetch:f.infer});await assert.rejects(run({prompt:'요약',page_id:'p'},f.context),error=>error.status===503);assert.equal(f.calls,0);
});
test('cloud inference requires an explicit provider URL even when a model and key exist',async()=>{
 const f=fixture(),{FOUNTAIN_AI_URL,...partial}=env,run=createAI({...f,env:partial,fetch:f.infer});
 await assert.rejects(run({prompt:'요약',page_id:'p'},f.context),error=>error.status===503&&error.message.includes('FOUNTAIN_AI_URL'));
 assert.equal(f.calls,0);assert.equal([...f.records.values()].filter(v=>v.kind==='audit').length,0);
});
