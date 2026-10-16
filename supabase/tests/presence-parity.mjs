/** Actual Python PresenceService + SQLite vs session-proof cloud port.
 * Auth is a deterministic injected proof model on BOTH sides, not real Supabase
 * sessions or native/device evidence. No legacy session/credential reads in TS.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {APIError} from '../functions/_shared/access.ts';
import {PresenceService,TTL,RETENTION} from '../functions/_shared/presence.ts';
import {seed_state,sha256,project,apply_operations} from '../functions/_shared/crdt.ts';
const copy=structuredClone,plain=value=>JSON.parse(JSON.stringify(value)),fixed='2026-10-16T00:00:00.000000+00:00',workspace='fixture 가정';
const sessions={local:{hash:'a'.repeat(64),binding:'1'.repeat(32),member:'local',active:true,expires:10000},alice:{hash:'b'.repeat(64),binding:'2'.repeat(32),member:'alice',active:true,expires:10000},bob:{hash:'c'.repeat(64),binding:'3'.repeat(32),member:'bob',active:true,expires:10000},alice2:{hash:'d'.repeat(64),binding:'4'.repeat(32),member:'alice',active:true,expires:10000}};
const page={id:'p',owner_id:'local',title:'커서',revision:0,permissions:{default:'private',members:{alice:'view',bob:'view'}},blocks:[{id:'cursor',type:'paragraph',text:'가🙂나',parent_id:null,rich_text:[{text:'가🙂나',marks:{}}]}]};
const document={id:'p',epoch:'epoch',seq:0,state:seed_state(page.blocks),op_owners:{}};
const initial=[['member',{id:'local',name:'나',role:'owner',active:true}],['member',{id:'alice',name:'가족😀'.repeat(40),email:'private@example.invalid',role:'member',active:true}],['member',{id:'bob',name:'가족2',role:'member',active:true}],['group',{id:'readers',members:['alice']}],['page',page],['collaboration',document]];
const point=offset=>({before:offset?'seed:cursor:'+(offset-1):null,after:offset<3?'seed:cursor:'+offset:null,offset});
const selection=(anchor=1,focus=2)=>({block_id:'cursor',anchor:point(anchor),focus:point(focus)});
const join=(seq=1,client='tab',fields={})=>({action:'update',cookie:'alice',fields:{seq,client_id:client,selection:selection(),...fields}});
const leave=(seq=1,client='tab')=>({action:'leave',cookie:'alice',fields:{seq,client_id:client}});
const snapshot=(cookie='local')=>({action:'snapshot',cookie});
const cases=[];const add=(name,steps,extra={})=>cases.push({name,initial,sessions,steps,...extra});
add('reader codepoint selection, equal seq and retained tombstone',[join(),snapshot(),join(1,'tab',{selection:null}),leave(5),join(4),join(6),leave(7),join(6),snapshot()]);
add('leave before join and same account independent sessions',[leave(5),join(4),{...join(1),cookie:'alice2'},snapshot(),leave(6),snapshot(),{...leave(2),cookie:'alice2'},snapshot()]);
add('TTL and original expiration retention cleanup',[join(),{...snapshot(),at:116},join(1),{...snapshot(),at:176},join(1)]);
add('unknown/deleted anchors and old epoch',[join(1,'unknown',{selection:{...selection(),anchor:{before:'missing',after:null,offset:0}}}),{action:'patch-document',body:{epoch:'new-epoch'}},snapshot(),join(2,'tab',{epoch:'epoch'}),join(3,'tab',{epoch:'new-epoch'}),{action:'delete-char'},snapshot()]);
add('binding and client input cannot impersonate actor',[join(1,'tab',{session_binding:'wrong'}),join(1,'tab',{member_id:'local'}),join(1,'bad client'),join(true),join(0),join(1,'tab',{epoch:''}),join(1,'tab',{selection:{...selection(),anchor:{...point(1),offset:true}}}),join(1,'tab',{selection:{...selection(),extra:'PRIVATE'}})]);
add('publisher revocation and current pinned group ACL',[join(),{action:'patch-page',body:{permissions:{default:'private',groups:{readers:'view'}}}},snapshot(),{action:'patch-group',body:{members:[]}},snapshot(),{action:'patch-group',body:{members:['alice']}},snapshot(),join(2),{action:'patch-session',cookie:'alice',body:{active:false}},snapshot()]);
add('current name, role and binding are rechecked',[join(),{action:'patch-member',id:'alice',body:{name:'새 이름😀'}},snapshot(),{action:'patch-session',cookie:'alice',body:{binding:'5'.repeat(32)}},snapshot(),join(2),{action:'patch-member',id:'alice',body:{active:false}},snapshot()]);
add('locked readers allowed; archived publishers retire',[join(),{action:'patch-page',body:{locked:true}},join(2),{action:'patch-page',body:{archived:true}},snapshot(),join(3),leave(4),{action:'patch-page',body:{archived:false}},snapshot()]);
add('presence never initializes document',[{action:'remove-document'},snapshot(),join()]);
add('invalid clock is rejected',[{...snapshot(),at:'bad'}, {...snapshot(),at:true}]);
const navigationInitial=copy(initial);for(let index=0;index<11;index++){navigationInitial.push(['page',{...page,id:'nav'+index}]);navigationInitial.push(['collaboration',{...document,id:'nav'+index}]);}
add('active vs retained quotas allow sequential navigation',Array.from({length:11},(_,index)=>[{...join(1),page:'nav'+index},{...leave(2),page:'nav'+index}]).flat(),{initial:navigationInitial});
add('ten active clients per session',[...Array.from({length:10},(_,index)=>join(1,'client'+index)),join(1,'eleventh'),leave(2,'client0'),join(1,'eleventh')]);
const peers={...copy(sessions)};for(let index=0;index<10;index++)peers['peer'+index]={hash:sha256('qa-peer-'+index),binding:sha256('binding-'+index).slice(0,32),member:'alice',active:true,expires:10000};
const record=(id,session,fields={})=>['presence',{id,page_id:'p',epoch:'epoch',member_id:session.member,origin_kind:'session',origin_id:session.hash,session_binding:session.binding,client_id:'seed-'+id,seq:1,left:true,expires_at:90,retain_until:150,selection:null,...fields}];
const retainedSession=Array.from({length:200},(_,index)=>record(index.toString(16).padStart(64,'0'),sessions.alice,{page_id:'elsewhere'}));
add('retained session hard cap source preserved',[join()],{initial:[...initial,...retainedSession]});
const retainedPage=Array.from({length:500},(_,index)=>record(index.toString(16).padStart(64,'0'),peers['peer'+index%10]));
add('retained page hard cap source preserved',[join()],{initial:[...initial,...retainedPage],sessions:peers});
const activePage=Array.from({length:100},(_,index)=>record(index.toString(16).padStart(64,'0'),peers['peer'+index%10],{left:false,expires_at:115,retain_until:175}));
add('active page hard cap source preserved',[join()],{initial:[...initial,...activePage],sessions:peers});
const expired=Array.from({length:501},(_,index)=>record(index.toString(16).padStart(64,'0'),sessions.bob,{retain_until:99,expires_at:39}));
add('cleanup deletes at most five hundred',[snapshot()],{initial:[...initial,...expired]});
const identity=PresenceService._identity('p','epoch',['session',sessions.alice.hash],'tab',workspace);
add('expired get beyond bounded cleanup cannot bypass retained quota',[join()],{initial:[...initial,...expired,record(identity,sessions.alice,{retain_until:99,expires_at:39}),...retainedSession.map(([kind,value],index)=>[kind,{...value,id:(1000+index).toString(16).padStart(64,'0')}])]});

class Store{
 constructor(test){this.records=new Map();this.metadata=new Map([['workspace_id',workspace],['access_revision',0]]);this.sessions=copy(test.sessions);this.context={};this.principal={};for(const [kind,data]of test.initial)this.put(kind,data);}
 get(kind,id){assert(!['session','credential'].includes(kind),'legacy secret kind loaded');return typeof id==='string'?copy(this.records.get(JSON.stringify([kind,id]))||null):null;}
 list(kind){assert(!['session','credential'].includes(kind));return Array.from(this.records).filter(([key])=>JSON.parse(key)[0]===kind).map(([,value])=>copy(value)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);}
 put(kind,raw){const data=copy(raw),old=this.get(kind,data.id);Object.assign(data,{created_at:old?.created_at||fixed,updated_at:fixed});this.records.set(JSON.stringify([kind,data.id]),data);this.metadata.set('_entity_revision',(this.metadata.get('_entity_revision')||0)+1);return copy(data);}
 delete(kind,id){if(this.records.delete(JSON.stringify([kind,id])))this.metadata.set('_entity_revision',this.meta('_entity_revision')+1);}
 meta(key,fallback=null){return this.metadata.has(key)?copy(this.metadata.get(key)):fallback;}
 transaction(action){const records=copy(this.records),metadata=copy(this.metadata);try{return action(this);}catch(error){this.records=records;this.metadata=metadata;throw error;}}
 dump(){return {presence:this.list('presence'),pages:this.list('page'),documents:this.list('collaboration'),audit:this.list('audit'),revision:this.meta('_entity_revision')};}
 valid(session,now){const member=this.get('member',session?.member);return session&&session.active&&session.expires>now&&member&&getActive(member)&&['owner','admin','member','guest'].includes(member.role)?member:null;}
}
const getActive=member=>!Object.hasOwn(member,'active')||member.active===true;
function execute(test){const store=new Store(test),output=[];let now=100;
 for(const step of test.steps){if(Object.hasOwn(step,'at'))now=step.at;let result;
  try{
   if(step.action.startsWith('patch-')){const kind={'patch-page':'page','patch-document':'collaboration','patch-member':'member','patch-group':'group'}[step.action];if(kind)store.put(kind,{...store.get(kind,step.id|| (kind==='group'?'readers':'p')),...copy(step.body)});else Object.assign(store.sessions[step.cookie],copy(step.body));result={value:null};}
   else if(step.action==='remove-document'){store.delete('collaboration','p');result={value:null};}
   else if(step.action==='delete-char'){const doc=store.get('collaboration','p');doc.state=apply_operations(doc.state,[{id:'edit:1',client:'edit',clock:1,type:'text.delete',block_id:'cursor',char_ids:['seed:cursor:1']}]);store.put('collaboration',doc);result={value:null};}
   else{
    const own=store.sessions[step.cookie||'alice'],principal=store.valid(own,typeof now==='number'&&Number.isFinite(now)?now:100);if(!principal)throw new APIError(401,'Authentication required');
    store.context={workspaceId:workspace,memberId:principal.id,userId:'11111111-1111-4111-8111-111111111111',authSessionId:'22222222-2222-4222-8222-222222222222',sessionHash:own.hash,cacheBinding:own.binding};store.principal=principal;
    const requested=new Set(Object.values(store.sessions).map(value=>value.hash)),values=new Map();for(const session of Object.values(store.sessions)){const member=store.valid(session,now);if(member)values.set(session.hash,{hash:session.hash,cacheBinding:session.binding,member});}
    const service=new PresenceService(store,{clock:()=>now,proofs:{requested,values}}),id=step.page||'p';
    if(step.action==='snapshot')result={value:service.snapshot(id)};else{const body={session_binding:own.binding,epoch:store.get('collaboration',id)?.epoch||'epoch',client_id:'tab',seq:1,...step.action==='update'?{selection:null}:{},...copy(step.fields||{})};result={value:service[step.action](id,body)};}
   }
  }catch(error){if(!Number.isInteger(error.status))throw new Error(test.name+': '+error.stack);result={error:{status:error.status,message:error.message}};}
  output.push({...result,persisted:store.dump()});
 }
 return plain(output);
}
const oracle=String.raw`
import sys,json,copy
from unittest.mock import patch
from fountain.core import Store,APIError
from fountain.presence import PresenceService
from fountain.crdt import apply_operations
payload=json.load(sys.stdin);results=[]
for test in payload['cases']:
 store=Store(':memory:');sessions=copy.deepcopy(test['sessions']);clock=[100]
 def valid(session):
  if session is None:return None
  member=store.get('member',session['member'])
  return member if session['active'] and session['expires']>clock[0] and member and member.get('active',True) is True and member.get('role') in {'owner','admin','member','guest'} else None
 class Auth:
  enabled=True
  def _digest(self,cookie):return sessions.get(cookie,{}).get('hash')
  def session_by_digest(self,digest):
   session=next((row for row in sessions.values() if row['hash']==digest),None)
   return dict(cache_binding=session['binding'],created_at='legacy') if valid(session) else None
  def principal_by_digest(self,digest):return valid(next((row for row in sessions.values() if row['hash']==digest),None))
  def session_info(self,cookie):
   session=sessions.get(cookie);member=valid(session)
   return dict(authenticated=bool(member),member=member,cache_binding=session['binding'] if session else None,workspace_id=payload['workspace'])
 with patch('fountain.core.now',lambda:payload['fixed']):
  for kind,data in test['initial']:store.put(kind,data)
  store.set_meta('workspace_id',payload['workspace']);store.set_meta('access_revision',0);store.set_meta('_entity_revision',len(test['initial']))
  service=PresenceService(store,Auth(),lambda:clock[0]);out=[]
  for step in test['steps']:
   clock[0]=step.get('at',clock[0])
   try:
    kind={'patch-page':'page','patch-document':'collaboration','patch-member':'member','patch-group':'group'}.get(step['action'])
    if kind:identity=step.get('id','readers' if kind=='group' else 'p');store.put(kind,dict(store.get(kind,identity),**copy.deepcopy(step['body'])));value=None
    elif step['action']=='patch-session':sessions[step['cookie']].update(step['body']);value=None
    elif step['action']=='remove-document':store.delete('collaboration','p');value=None
    elif step['action']=='delete-char':
     doc=store.get('collaboration','p');doc['state']=apply_operations(doc['state'],[dict(id='edit:1',client='edit',clock=1,type='text.delete',block_id='cursor',char_ids=['seed:cursor:1'])]);store.put('collaboration',doc);value=None
    elif step['action']=='snapshot':value=service.snapshot(step.get('page','p'),step.get('cookie','alice'))
    else:
     cookie=step.get('cookie','alice');session=sessions[cookie];page=step.get('page','p');body=dict(session_binding=session['binding'],epoch=(store.get('collaboration',page) or {}).get('epoch','epoch'),client_id='tab',seq=1)
     if step['action']=='update':body['selection']=None
     body.update(copy.deepcopy(step.get('fields',{})));value=getattr(service,step['action'])(page,body,cookie)
    result={'value':value}
   except APIError as error:result={'error':dict(status=error.status,message=error.message)}
   result['persisted']=dict(presence=store.list('presence'),pages=store.list('page'),documents=store.list('collaboration'),audit=store.list('audit'),revision=store.meta('_entity_revision'));out.append(result)
  results.append(out)
 store.close()
print(json.dumps(results,ensure_ascii=True))
`;
const run=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',oracle],{cwd:fileURLToPath(new URL('../../',import.meta.url)),input:JSON.stringify({cases,fixed,workspace}),encoding:'utf8',maxBuffer:64*1024*1024});assert.equal(run.status,0,run.stderr);const expected=JSON.parse(run.stdout);
for(const [index,test]of cases.entries())assert.deepEqual(execute(test),expected[index],test.name);
for(const test of cases){const values=execute(test);for(const [index,entry]of values.entries())if(['snapshot','update','leave'].includes(test.steps[index].action)){
 if(entry.value)for(const participant of entry.value.participants){const encoded=JSON.stringify(participant);assert(!encoded.includes('private@example.invalid'));assert(!encoded.includes('origin_id'));assert(!encoded.includes('session_binding'));assert(!encoded.includes('"text"'));}
}}
assert.equal(TTL,15);assert.equal(RETENTION,60);
console.log(JSON.stringify({ok:true,oracle:'actual Python PresenceService/SQLite; injected Auth proofs',sequences:cases.length,steps:cases.reduce((n,test)=>n+test.steps.length,0),includesPage100Retained500Session10Retained200:true,cleanupBound:500,noLegacySecretReads:true,actualCloudOrLocalAuthMode:false}));
