import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {AdminAuthority,ACTIONS,generationKey,invalidateMember} from '../functions/_shared/admin-roles.ts';
const python=process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/fountain/.data/supabase-venv/bin/python';
const stamp='2026-10-17T08:00:00.000000+00:00';
function py(code,input){const result=spawnSync(python,['-c',code],{encoding:'utf8',input:JSON.stringify(input),maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
const fixture=py(`import json\nfrom fountain.core import Store\nfrom tests.test_admin_roles import fixture\ns=Store(':memory:');fixture(s)\nprint(json.dumps({'records':{k:s.list(k) for k in ['member','admin_role','admin_assignment','page']},'meta':{r[0]:json.loads(r[1]) for r in s.db.execute('SELECT key,data FROM meta')}}));s.close()`);
class Store{
 records=new Map();metadata=new Map();counter=100;
 constructor(){for(const[kind,rows]of Object.entries(fixture.records))for(const row of rows)this.put(kind,row);this.metadata=new Map(Object.entries(clone(fixture.meta)));}
 get(kind,id){return clone(this.records.get(kind)?.get(id)??null);}
 list(kind){return [...(this.records.get(kind)?.values()??[])].map(clone);}
 meta(key,fallback=null){return clone(this.metadata.has(key)?this.metadata.get(key):fallback);}
 put(kind,value){if(!this.records.has(kind))this.records.set(kind,new Map());const previous=this.get(kind,value.id);const row={...clone(value),created_at:previous?.created_at??stamp,updated_at:stamp};this.records.get(kind).set(row.id,row);return clone(row);}
 delete(kind,id){this.records.get(kind)?.delete(id);}
 set_meta(key,value){this.metadata.set(key,clone(value));}
 allocate_id(){return (++this.counter).toString(16).padStart(32,'0');}
 audit(action,details,user){return this.put('audit',{id:'audit-'+this.list('audit').length,action,details,user});}
 transaction(action){const records=clone(this.records),meta=clone(this.metadata),counter=this.counter;try{return action();}catch(error){this.records=records;this.metadata=meta;this.counter=counter;throw error;}}
}
const authority=(store,actor='alice',principal=store.get('member',actor))=>new AdminAuthority(store,new Access(store,principal));
const overview=store=>authority(store,'local').overview();
const mutate=(store,method,path,body={})=>authority(store,'local').route(method,path,{revision:overview(store).revision,...body},{});
let checks=0;
function denied(status,action,store){const before=store?clone([store.records,store.metadata]):null;assert.throws(action,error=>error instanceof APIError&&error.status===status);if(store)assert.deepEqual([store.records,store.metadata],before);checks++;}
{
 const s=new Store(),a=authority(s),before=clone([s.records,s.metadata]);assert.deepEqual(a.actions(),['audit.read','analytics.read']);assert.equal(a.access.owner,false);assert.equal(a.access.can('page',s.get('page','private')),false);assert.deepEqual(new Set(authority(s,'local').actions()),ACTIONS);assert.deepEqual(authority(s,'admin').actions(),['members.read','members.manage','groups.read','groups.membership.manage']);for(const id of ['guest','inactive','bob'])assert.deepEqual(authority(s,id).actions(),[]);assert.equal(a.allows('__proto__'),false);assert.equal(a.allows({}),false);checks++;
 const value=overview(s);assert.deepEqual(value.assignments,[{member_id:'alice',role_ids:['analytics','audit']}]);const publicKeys=[];const walk=item=>{if(Array.isArray(item))item.forEach(walk);else if(item&&typeof item==='object')for(const [key,child]of Object.entries(item)){publicKeys.push(key);walk(child);}};walk(value);for(const key of ['generation','nonce','permissions'])assert(!publicKeys.includes(key));assert.deepEqual([s.records,s.metadata],before);checks++;
 for(const principal of [{id:'bob',role:'owner'},{id:'missing',role:'owner'},{id:'guest',role:'member'}])assert.deepEqual(authority(s,'alice',principal).actions(),[]);checks++;
 const alice=s.get('member','alice');s.put('member',{...alice,admin_actions:['members.manage'],capabilities:{'members.manage':true}});assert.equal(a.allows('members.manage'),false);for(const change of [{active:false},{role:'guest'},{role:'admin'},{role:'unknown'}]){s.put('member',{...alice,...change});assert.deepEqual(a.actions(),[]);}checks++;
}
{
 const s=new Store(),created=mutate(s,'POST','/api/admin/roles',{name:'감사😀',actions:['audit.read']}),id=created.created_role_id;assert.match(id,/^[0-9a-f]{32}$/);assert.equal(s.meta('access_revision'),1);mutate(s,'PUT','/api/admin/assignments/__proto__',{role_ids:[id]});assert.equal(authority(s,'__proto__').allows('audit.read'),true);assert.equal(authority(s,'__proto__').access.owner,false);mutate(s,'DELETE','/api/admin/roles/'+id);assert.deepEqual(authority(s,'__proto__').actions(),[]);assert.equal(s.list('audit').length,3);checks++;
 const old=s.get('admin_assignment','alice');assert.equal(invalidateMember(s,'bob'),false);assert.equal(s.meta(generationKey('bob')),null);assert.equal(invalidateMember(s,'alice'),true);s.put('admin_assignment',old);assert.deepEqual(authority(s).actions(),[]);mutate(s,'PUT','/api/admin/assignments/alice',{role_ids:['audit']});assert.deepEqual(authority(s).actions(),['audit.read']);checks++;
 const role=s.get('admin_role','audit');for(const change of [{version:true},{version:2},{nonce:'2'.repeat(32)+'\n'},{actions:['audit.read','future.read']},{actions:['members.manage']},{wildcard:true}]){s.put('admin_role',{...role,...change});assert.deepEqual(authority(s).actions(),[]);}s.put('admin_role',role);checks++;
 s.set_meta('access_revision',false);denied(503,()=>mutate(s,'POST','/api/admin/roles',{name:'rollback',actions:['audit.read']}),s);
}
{
 const s=new Store(),oldRole=s.get('admin_role','audit'),oldRevision=overview(s).revision;
 mutate(s,'PATCH','/api/admin/roles/audit',{description:'same authority'});assert.equal(authority(s).allows('audit.read'),true);
 mutate(s,'DELETE','/api/admin/roles/audit');s.put('admin_role',{...oldRole,nonce:'3'.repeat(32)});
 assert.deepEqual(authority(s).actions(),['analytics.read']);assert.notEqual(overview(s).revision,oldRevision);
 mutate(s,'PUT','/api/admin/assignments/alice',{role_ids:['audit','analytics']});assert.equal(authority(s).allows('audit.read'),true);checks++;
 const assignment=s.get('admin_assignment','alice');for(const role_nonces of [{},{audit:'3'.repeat(32)},{...assignment.role_nonces,future:'3'.repeat(32)}]){s.put('admin_assignment',{...assignment,role_nonces});assert.deepEqual(authority(s).actions(),[]);}checks++;
}
{
 const s=new Store();for(const actor of ['alice','admin','guest'])for(const[method,path,body]of [['POST','/api/admin/roles',{name:'x',actions:['audit.read']}],['DELETE','/api/admin/roles/audit',{}],['PUT','/api/admin/assignments/bob',{role_ids:['audit']}]] )denied(403,()=>authority(s,actor).route(method,path,{revision:overview(s).revision,...body},{}),s);
 for(const body of [{name:''},{name:'\u0085'},{name:'😀'.repeat(101)},{name:'x\n'},{name:'\ud800'},{actions:[]},{actions:['members.manage']},{actions:['groups.membership.manage']},{actions:['audit.read','audit.read']},{actions:['future.read']},JSON.parse('{"__proto__":{}}'),{revision:overview(s).revision+'\n'}])denied(400,()=>mutate(s,'POST','/api/admin/roles',{name:'role',actions:['audit.read'],...body}),s);
 for(const query of [new URLSearchParams('q=x'),{q:['x']},null,[]])denied(400,()=>authority(s,'local').route('GET','/api/admin/roles',{},query),s);
 denied(409,()=>mutate(s,'PATCH','/api/admin/roles/audit',{name:'stale',revision:'0'.repeat(64)}),s);
 for(const id of ['local','guest','inactive','absent'])denied(400,()=>mutate(s,'PUT','/api/admin/assignments/'+id,{role_ids:['audit']}),s);
}
{
 const s=new Store(),added=['content.search.read','content.search.export','content.permissions.manage','content.publish.manage'];
 for(const actor of ['alice','admin','bob','guest'])assert(!authority(s,actor).actions().some(action=>added.includes(action)));
 assert(added.every(action=>authority(s,'local').allows(action)));
 for(const action of added.slice(1))denied(400,()=>mutate(s,'POST','/api/admin/roles',{name:'Invalid grant',actions:[action]}),s);
 const created=mutate(s,'POST','/api/admin/roles',{name:'Explicit content export',actions:['content.search.read','content.search.export']});
 mutate(s,'PUT','/api/admin/assignments/alice',{role_ids:[created.created_role_id,'audit']});
 assert.deepEqual(authority(s).actions(),['audit.read','content.search.read','content.search.export']);
 assert.equal(authority(s).access.can('page',s.get('page','private')),false);
 denied(400,()=>mutate(s,'PATCH','/api/admin/roles/'+created.created_role_id,{actions:['content.search.export']}),s);checks++;
}
// Match full DTOs, opaque canonical revisions and errors against real SQLite.
{
 const s=new Store(),reader={get:(kind,id)=>s.get(kind,id),list:kind=>s.list(kind),meta:(key,fallback=null)=>s.meta(key,fallback)};
 const owner=authority(reader,'local');assert.deepEqual(owner.overview(),overview(s));assert.equal(owner.route('GET','/api/admin/self',{},{}).can_manage_roles,true);
 denied(503,()=>owner.route('POST','/api/admin/roles',{revision:overview(s).revision,name:'role',actions:['audit.read']},{}),s);
 const member=authority(reader);assert.deepEqual(member.actions(),['audit.read','analytics.read']);denied(403,()=>member.route('POST','/api/admin/roles',{revision:overview(s).revision,name:'role',actions:['audit.read']},{}),s);checks++;
}
{
 const s=new Store(),generations=Object.fromEntries(s.metadata);
 for(let i=0;i<1001;i++){const id='bulk'+i;s.put('member',{id,role:'member'});s.put('admin_assignment',{id,member_id:id,role_ids:['audit'],role_nonces:{audit:'2'.repeat(32)},generation:'1'.repeat(32)});generations[generationKey(id)]='1'.repeat(32);}
 s.admin_member_generations=()=>clone(generations);s.meta=()=>assert.fail('per-member metadata read');const value=overview(s);assert.equal(value.assignments.length,1002);assert.equal(value.eligible_members.length,1006);checks++;
}
{
 const cases=[],step=(method='GET',path='/api/admin/roles',body={},extra={})=>({method,path,body,...extra});
 for(const actor of ['local','alice','admin','guest','inactive','bob','__proto__','成员😀'])cases.push({steps:[step('GET','/api/admin/self',{}, {actor}),step('GET','/api/admin/roles',{}, {actor})]});
 for(const principal of [{id:'bob',role:'owner'},{id:'missing',role:'owner'},{id:'guest',role:'member'}])cases.push({steps:[step('GET','/api/admin/self',{}, {principal})]});
 for(const body of [{name:''},{name:'\u0085'},{name:'\ufeff'},{name:'😀'.repeat(100)},{name:'😀'.repeat(101)},{name:'x\n'},{name:'\ud800'},{description:'x'.repeat(1001)},{actions:[]},{actions:['members.manage']},{actions:['groups.membership.manage']},{actions:['audit.read','audit.read']},{actions:['future.read']},JSON.parse('{"__proto__":{}}'),{revision:'0'.repeat(64)+'\n'}])cases.push({steps:[step('POST','/api/admin/roles',{revision:'$current',name:'role',actions:['audit.read'],...body})]});
 for(const [method,path]of [['GET','/api/admin/roles/'],['GET','/api/admin/roles/audit/x'],['GET','/api/admin/self/'],['GET','/api/admin/assignments/alice/'],['PUT','/api/admin/roles'],['GET','/api/admin/roles/audit'],['POST','/api/admin/assignments/alice'],['HEAD','/api/admin/self']])cases.push({steps:[step(method,path)]});
 cases.push({steps:[step('GET','/api/admin/roles',{}, {query:{q:['x']}})]});
 for(const id of ['local','guest','inactive','absent','bob','__proto__','成员😀'])cases.push({steps:[step('PUT','/api/admin/assignments/'+id,{revision:'$current',role_ids:['audit','people']}),step('GET','/api/admin/self',{}, {actor:id})]});
 cases.push({steps:[step('POST','/api/admin/roles',{revision:'$current',name:'새 역할😀',actions:['analytics.read','audit.read']}),step('PATCH','/api/admin/roles/audit',{revision:'$current',description:'새 설명'}),step('PUT','/api/admin/assignments/alice',{revision:'$current',role_ids:['people','analytics']}),step('GET','/api/admin/self',{}, {actor:'alice'}),step('DELETE','/api/admin/roles/people',{revision:'$current'}),step('GET','/api/admin/self',{}, {actor:'alice'}),step('PUT','/api/admin/assignments/alice',{revision:'$current',role_ids:[]}),step('GET','/api/admin/self',{}, {actor:'alice'})]});
 for(const value of [{...fixture.records.admin_role[0],version:true},{...fixture.records.admin_role[0],actions:['audit.read','future.read']},{...fixture.records.admin_role[0],nonce:'2'.repeat(32)+'\n'}])cases.push({changes:[{op:'put',kind:'admin_role',value}],steps:[step('GET','/api/admin/self',{}, {actor:'alice'}),step()]});
 for(const value of [{...fixture.records.admin_assignment[0],generation:'1'.repeat(32)+'\n'},{...fixture.records.admin_assignment[0],role_ids:['audit','audit']},{...fixture.records.admin_assignment[0],extra:true},{...fixture.records.admin_assignment[0],role_nonces:{}},{...fixture.records.admin_assignment[0],role_nonces:{audit:'2'.repeat(32)}}])cases.push({changes:[{op:'put',kind:'admin_assignment',value}],steps:[step('GET','/api/admin/self',{}, {actor:'alice'}),step()]});
 cases.push({changes:[{op:'rotate',id:'alice'}],steps:[step('GET','/api/admin/self',{}, {actor:'alice'}),step()]});
 cases.push({changes:[{op:'put',kind:'member',value:{...fixture.records.member.find(member=>member.id==='alice'),extension:1.0}}],steps:[step(),step('GET','/api/admin/self',{}, {actor:'alice'})]});
 cases.push({changes:[{op:'delete',kind:'admin_role',id:'audit'},{op:'put',kind:'admin_role',value:{...fixture.records.admin_role.find(role=>role.id==='audit'),nonce:'3'.repeat(32)}}],steps:[step(),step('GET','/api/admin/self',{}, {actor:'alice'}),step('PUT','/api/admin/assignments/alice',{revision:'$current',role_ids:['audit','analytics']}),step('GET','/api/admin/self',{}, {actor:'alice'})]});
 cases.push({changes:[{op:'meta',key:'access_revision',value:false}],steps:[step('POST','/api/admin/roles',{revision:'$current',name:'rollback',actions:['audit.read']}),step()]});
 const actual=cases.map(test=>{
  const s=new Store();for(const change of test.changes??[]){if(change.op==='put')s.put(change.kind,change.value);else if(change.op==='delete')s.delete(change.kind,change.id);else if(change.op==='rotate')invalidateMember(s,change.id);else s.set_meta(change.key,change.value);}
  return test.steps.map(step=>{const a=authority(s,step.actor??'local',step.principal??s.get('member',step.actor??'local')),body=clone(step.body??{});if(body.revision==='$current')body.revision=overview(s).revision;try{return{status:200,body:a.route(step.method??'GET',step.path??'/api/admin/roles',body,step.query??{})};}catch(error){return{status:error.status,error:error.message};}});
 });
 const expected=py(`import json,sys\nfrom tests.admin_roles_oracle import run\nprint(json.dumps(run(json.load(sys.stdin)),ensure_ascii=True))`,cases);assert.deepEqual(actual,expected);checks++;console.log('PASS '+cases.reduce((sum,test)=>sum+test.steps.length,0)+' exact Python SQLite / TypeScript admin role results');
}
console.log('PASS '+checks+' admin role security checks');
