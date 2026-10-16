/** Python/SQLite oracle parity; fixtures never access production or providers. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Advanced,AdvancedError,infer_ai,createAdvancedExtension} from '../functions/_shared/advanced.ts';
import {Workspace,compareText} from '../functions/_shared/core.ts';
import {Access,APIError,clone} from '../functions/_shared/access.ts';
import {Scheduler} from '../functions/_shared/scheduler.ts';
import {MissingSelection} from '../functions/_shared/store.ts';
import {Authorization} from '../functions/_shared/authorization.ts';
import http from 'node:http';
import {once} from 'node:events';

const root=fileURLToPath(new URL('../../',import.meta.url)),python=process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',time='2026-10-16T00:00:00.123000+00:00';
class MemoryStore{
 requestTime=time;context={memberId:'local'};records=new Map();metadata=new Map();revision=0;
 constructor(uid){this.uid=uid;}
 allocate_id(){return this.uid();}get(kind,id){return clone(this.records.get(kind)?.get(id)??null);}
 list(kind){return [...(this.records.get(kind)?.values()??[])].sort((a,b)=>compareText(a.created_at,b.created_at)||compareText(a.id,b.id)).map(clone);}
 meta(key,fallback=null){return key==='_entity_revision'?this.revision:clone(this.metadata.has(key)?this.metadata.get(key):fallback);}
 set_meta(key,value){this.metadata.set(key,clone(value));this.revision++;return clone(value);}
 put(kind,data){const id=data.id||this.uid(),prior=this.get(kind,id),value={...clone(data),id,created_at:prior?.created_at??time,updated_at:time};JSON.stringify(value,(_,item)=>{if(typeof item==='function'||typeof item==='undefined')throw new APIError(400,'Invalid serialization');return item;});if(!this.records.has(kind))this.records.set(kind,new Map());this.records.get(kind).set(id,value);this.revision++;return clone(value);}
 delete(kind,id){if(this.records.get(kind)?.delete(id))this.revision++;}
 audit(action,details,user=this.context.memberId){return this.put('audit',{action,details,user});}
 transaction(action){const before=clone([this.records,this.metadata,this.revision]);try{return action(this);}catch(error){[this.records,this.metadata,this.revision]=before;throw error;}}
}
function reference(value,refs){if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&Object.hasOwn(value,'$ref'))return clone(value.$ref.split('.').reduce((item,key)=>item[key],refs));if(Array.isArray(value))return value.map(item=>reference(item,refs));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,reference(item,refs)]));return value;}
function setup(spec){let count=0;const uid=()=>`generated-${String(++count).padStart(4,'0')}`,store=new MemoryStore(uid);store.context.memberId=spec.actor??'local';for(const [key,value]of Object.entries(spec.meta??{}))store.set_meta(key,value);for(const [kind,records]of Object.entries(spec.records??{}))for(const record of records)store.put(kind,record);const access=spec.access?new Access(store,store.get('member',store.context.memberId)):undefined,workspace=new Workspace(store,{actor:store.context.memberId,access,uid}),options={actor:store.context.memberId,access,uid,env:spec.env??{},cloud:false,...(spec.clockISO?{clock:()=>Date.parse(spec.clockISO)}:{})},advanced=new Advanced(store,workspace,options);return {store,workspace,advanced,options};}
function run(spec){const {store,workspace,advanced}=setup(spec),refs={},results=[];for(const operation of spec.operations){try{const args=reference(operation.args??[],refs),result=store.transaction(()=>operation.method.startsWith('workspace.')?workspace[operation.method.split('.')[1]](...args):['scim_patch_user','scim_patch_group','scim_delete_user'].includes(operation.method)?advanced.scim(operation.method==='scim_delete_user'?'DELETE':'PATCH','/scim/v2/'+(operation.method==='scim_patch_group'?'Groups':'Users')+'/'+args[0],args[1]??{},{}):operation.method==='form_public'?advanced.public_view('/forms/'+args[0]):operation.method==='scheduler.tick'?new Scheduler(store,(id,body)=>advanced.run_as_author(id,body)).tick(...args):advanced[operation.method](...args));if(operation.as)refs[operation.as]=clone(result);results.push({ok:result});}catch(error){results.push(error instanceof APIError?{error:{status:error.status,message:error.message}}:{unexpected:{type:error.name,message:error.message}});}}return {results,records:Object.fromEntries([...store.records.keys()].sort().filter(kind=>store.records.get(kind).size).map(kind=>[kind,store.list(kind)])),revision:store.revision};}
let checks=0;
function parity(name,spec){const process=spawnSync(python,[root+'supabase/tests/advanced-oracle.py'],{input:JSON.stringify(spec),encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(process.status,0,process.stderr);const actual=JSON.parse(JSON.stringify(run(spec))),expected=JSON.parse(process.stdout);assert.deepEqual(actual,expected,name);checks+=spec.operations.length;return actual;}
const base={meta:{workspace_id:'fixture',auth_accounts_required:true},records:{member:[{id:'local',name:'나',email:'local@fountain.local',role:'owner',active:true},{id:'alice',name:'가족',email:'alice@example.org',role:'member',active:true}],teamspace:[{id:'general',visibility:'open',members:['local','alice']}],database:[{id:'projects',name:'가족 DB',owner_id:'local',properties:[{id:'name',name:'이름',type:'title'},{id:'status',name:'상태',type:'status',options:['시작 전','진행 중','완료']},{id:'priority',name:'우선',type:'select',options:['높음','낮음']},{id:'n',name:'숫자',type:'number'},{id:'done',name:'확인',type:'checkbox'}]}],page:[{id:'welcome',title:'환영 <script>',revision:0,blocks:[{id:'first',type:'paragraph',text:'본문 😀'}]}]}};
parity('collections, strict settings, duplicate/Unicode email and visibility', {...base,operations:[
 {method:'settings'},{method:'capabilities'},
 {method:'save',args:['members',{email:' STRAßE@example.org ',name:'가족'}],as:'member'},
 {method:'save',args:['members',{email:'strasse@example.org'}]},
 {method:'save',args:['members',{email:'bad'}]},
 {method:'save',args:['members',{email:'b@example.org',active:'false'}]},
 {method:'save',args:['members',{email:'b@example.org',role:'superuser'}]},
 {method:'save',args:['groups',{name:'팀',members:[{$ref:'member.id'}]}],as:'group'},
 {method:'save',args:['teamspaces',{name:'비공개',members:['alice'],groups:[{$ref:'group.id'}],visibility:'private'}]},
 {method:'save',args:['teamspaces',{name:'잘못',members:['missing']}]},
 {method:'save',args:['integrations',{name:'연결',provider:'none'}]},
 {method:'update_settings',args:[{name:'가족',disable_guests:true,disable_public_sharing:true}]},
 {method:'save',args:['members',{email:'guest@example.org',role:'guest'}]},
 ...[{disable_guests:'false'},{trash_retention_days:0},{transcript_retention_days:true},{extra:true},{saml_metadata_url:'http://example.org'}].map(body=>({method:'update_settings',args:[body]})),
 {method:'update_settings',args:[{saml_metadata_url:'https://example.org/metadata',custom_domain:'home.example.org'}]},
 {method:'overview'},{method:'analytics'}
]});
parity('forms conditional scalar typing and published checks',{...base,operations:[
 {method:'save',args:['forms',{name:'요청',published:true,fields:[{id:'name',required:true},{id:'status',type:'select',options:['진행 중','완료']},{id:'note',property_id:'priority',required:true,condition:{field:'status',equals:'진행 중'}}]}],as:'form'},
 {method:'submit_form',args:[{$ref:'form.id'},{answers:{}}]},
 {method:'submit_form',args:[{$ref:'form.id'},{answers:{name:'시작',status:'진행 중'}}]},
 {method:'submit_form',args:[{$ref:'form.id'},{answers:{name:'완료',status:'완료',note:'숨김'}}]},
 {method:'submit_form',args:[{$ref:'form.id'},{answers:{name:'선택',status:'목록 밖'}}]},
 {method:'save',args:['forms',{name:'잘못',fields:[{id:'a',condition:{field:'b'}}]}]},
 {method:'save',args:['forms',{name:'중복',fields:[{id:'a'},{id:'a'}]}]},
 {method:'save',args:['forms',{name:'숫자',published:true,fields:[{id:'n',type:'number'},{id:'done',type:'checkbox'}]}],as:'typed'},
 {method:'submit_form',args:[{$ref:'typed.id'},{answers:{n:true}}]},
 {method:'submit_form',args:[{$ref:'typed.id'},{answers:{done:1}}]},
 {method:'submit_form',args:[{$ref:'typed.id'},{answers:{n:3,done:false}}]},
 {method:'save',args:['forms',{name:'비공개'}],as:'private'},
 {method:'submit_form',args:[{$ref:'private.id'},{answers:{}}]},
 {method:'update_settings',args:[{disable_public_sharing:true}]},
 {method:'submit_form',args:[{$ref:'form.id'},{answers:{name:'막힘'}}]}
]});
parity('automations condition/rollback/current author and schedules',{...base,access:true,operations:[
 {method:'workspace.create_row',args:['projects',{id:'target',properties:{name:'유지',status:'시작 전'}}]},
 {method:'save',args:['automations',{name:'시작',trigger:'row.updated',conditions:{status:'시작 전'},actions:[{type:'set_property',property_id:'status',value:'진행 중'}]}],as:'automation'},
 {method:'trigger',args:['row.updated','projects',{id:'target'}]},
 {method:'run_automation',args:[{$ref:'automation.id'},{row_id:'target'}]},
 {method:'save',args:['automations',{name:'실패',actions:[{type:'set_property',property_id:'status',value:'완료'},{type:'create_row',values:{unknown:'invalid'}}]}],as:'broken'},
 {method:'run_automation',args:[{$ref:'broken.id'},{row_id:'target'}]},
 {method:'save',args:['automations',{name:'예약',trigger:'scheduled',row_id:'target',schedule:{frequency:'months',start_at:'2026-01-31T09:30:00+09:00',timezone:'Asia/Seoul'},actions:[{type:'set_property',property_id:'status',value:'완료'}]}],as:'scheduled'},
 {method:'save',args:['automations',{last_run_at:'forged'},{$ref:'scheduled.id'}]},
 {method:'save',args:['automations',{name:'불가',trigger:'scheduled',schedule:{frequency:'days',start_at:'2026-01-01T00:00:00Z'},actions:[{type:'set_property',property_id:'status',value:'완료'}]}]},
 {method:'save',args:['automations',{name:'생성',actions:[{type:'create_page',title:'자동 페이지'},{type:'create_row',values:{name:'생성 행'}}]}],as:'create'},
 {method:'run_as_author',args:[{$ref:'create.id'},{}]},
 {method:'dispatch',args:['GET','/api/automations/'+ 'missing'+'/runs',{},{}]}
]});
parity('escaped published site/form HTML and rich clipboard',{...base,operations:[
 {method:'save',args:['sites',{name:'게시',page_id:'welcome',slug:'safe',published:true,description:'"설명"'}],as:'site'},
 {method:'public_view',args:['/sites/safe']},
 {method:'save',args:['sites',{name:'중복',page_id:'welcome',slug:'safe'}]},
 {method:'save',args:['sites',{name:'잘못',page_id:'welcome',slug:'<script>'}]},
 {method:'save',args:['forms',{name:'양식',published:true,fields:[{id:'first',label:'<질문>',required:true},{id:'next',type:'select',options:['선택','<script>'],condition:{field:'first',equals:'한글😀'}}]}],as:'form'},
 {method:'form_public',args:[{$ref:'form.id'}]},
 {method:'dispatch',args:['GET','/sites/safe',{},{}]},
 {method:'clipboard',args:[{blocks:[{id:'a',type:'heading1',text:'<script>" & \'😀'},{id:'b',type:'todo',parent_id:'a',checked:true,rich_text:[{text:'링크\n',marks:{bold:true,color:'red',background:'blue',link:'https://example.org/?a=1&b=2'}}]},{id:'d',type:'divider'}]}]},
 {method:'workspace.update_page',args:['welcome',{archived:true}]},
 {method:'public_view',args:['/sites/safe']}
]});
parity('SCIM users/groups lifecycle, merge, filter and pagination',{...base,operations:[
 {method:'scim',args:['GET','/scim/v2/ServiceProviderConfig',{},{}]},
 {method:'scim',args:['OPTIONS','/scim/v2/ServiceProviderConfig',{},{}]},
 {method:'scim',args:['POST','/scim/v2/Users',{userName:'c@example.org',displayName:'새 사용자'},{}],as:'user'},
 {method:'scim',args:['POST','/scim/v2/Users',{userName:'d@example.org',displayName:'다음 사용자'},{}],as:'other'},
 {method:'scim',args:['POST','/scim/v2/Groups',{displayName:'팀',members:[{value:{$ref:'user.payload.id'}}]},{}],as:'group'},
 {method:'scim_patch_user',args:[{$ref:'user.payload.id'},{Operations:[{op:'replace',path:'active',value:false}]}]},
 {method:'scim_patch_group',args:[{$ref:'group.payload.id'},{Operations:[{op:'add',value:{members:[{value:{$ref:'other.payload.id'}}]}}]}]},
 {method:'scim',args:['GET','/scim/v2/Users',{}, {count:['1'],startIndex:['2']}]},
 {method:'scim',args:['GET','/scim/v2/Users',{}, {count:['0']}]},
 {method:'scim',args:['GET','/scim/v2/Groups',{},{}]},
 {method:'scim',args:['GET','/scim/v2/Users',{}, {filter:['']}]},
 {method:'scim',args:['GET','/scim/v2/Users',{}, {startIndex:['bad']}]},
 {method:'scim',args:['GET','/scim/v2/Unknown',{},{}]},
 {method:'scim',args:['DELETE','/scim/v2/Users',{},{}]},
 {method:'scim',args:['POST','/scim/v2/Users/id',{},{}]},
 {method:'scim_delete_user',args:[{$ref:'user.payload.id'}]},
 {method:'scim',args:['GET','/scim/v2/Users',{},{}]}
]});
parity('verification, retention cascades, audit search and aliases',{...base,clockISO:'2026-10-16T00:00:00.123000+00:00',records:{...base.records,page:[...base.records.page,{id:'old',title:'삭제',archived:true,deleted_at:'2020-01-01T00:00:00+00:00'},{id:'new',title:'유지',archived:true,deleted_at:'2026-10-15T00:00:00+00:00'}],version:[{id:'v',page_id:'old',blocks:[]}],comment:[{id:'c',page_id:'old'}],collaboration:[{id:'old',state:{}}]},operations:[
 {method:'dispatch',args:['POST','/api/pages/welcome/verify',{owner:'local',expires_at:'2027-01-01T00:00:00+00:00'},{}]},
 {method:'dispatch',args:['POST','/api/pages/welcome/verify',{owner:'missing'},{}]},
 {method:'dispatch',args:['POST','/api/pages/welcome/verify',{owner:'local',expires_at:'2020-01-01T00:00:00+00:00'},{}]},
 {method:'dispatch',args:['POST','/api/pages/welcome/verify',{expires_at:'not-a-date'},{}]},
 {method:'dispatch',args:['DELETE','/api/pages/welcome/verify',{},{}]},
 {method:'cleanup'},
 {method:'dispatch',args:['GET','/api/audit',{}, {q:['retention']}]},
 {method:'dispatch',args:['GET','/api/members/alice/extra/nested',{},{}]},
 {method:'dispatch',args:['PATCH','/api/members/alice/extra',{name:'변경'},{}]},
 {method:'dispatch',args:['GET','/api/clipboard/missing/last',{},{}]},
 {method:'dispatch',args:['POST','/api/forms/missing/unknown',{},{}]}
]});
parity('scheduler staged due/restart/condition/success and failed rollback',{...base,access:true,operations:[
 {method:'save',args:['automations',{name:'예약 생성',trigger:'scheduled',schedule:{frequency:'minutes',interval:5,timezone:'UTC',start_at:'2026-01-31T00:30:00Z'},actions:[{type:'create_row',values:{name:'예약 행'}}]}]},
 {method:'scheduler.tick',args:['2026-01-31T00:29:59Z']},
 {method:'scheduler.tick',args:['2026-01-31T00:30:00Z']},
 {method:'scheduler.tick',args:['2026-01-31T00:30:01Z']},
 {method:'scheduler.tick',args:['2026-04-10T12:33:00Z']},
 {method:'save',args:['automations',{name:'실패',trigger:'scheduled',schedule:{frequency:'days',timezone:'UTC',start_at:'2026-01-01T00:00:00Z'},actions:[{type:'create_row',values:{name:'부분'}},{type:'create_row',values:{unknown:'실패'}}]}]},
 {method:'scheduler.tick',args:['2026-04-10T12:33:01Z']},
 {method:'scheduler.tick',args:['2026-04-10T12:33:02Z']}
]});
// Cloud-only invariant: no local/scim synthetic owner fallback is permitted.
for(const author of ['local','scim']){
 const {store,advanced}=setup(base);store.delete('member',author);store.put('automation',{id:'guard',name:'guard',owner_id:author,database_id:'projects',actions:[{type:'create_row',values:{name:'must not exist'}}]});const before=clone(store.records),revision=store.revision;
 assert.throws(()=>advanced.run_as_author('guard',{}),error=>error instanceof APIError&&error.status===403);assert.deepEqual(store.records,before);assert.equal(store.revision,revision);checks++;
}
{
 const {store,advanced}=setup({...base,access:true});store.put('automation',{id:'selection',name:'selection',owner_id:'local',enabled:true,trigger:'row.created',database_id:'projects',actions:[{type:'set_property',property_id:'status',value:'완료'}]});const originalGet=store.get.bind(store);store.get=(kind,id)=>{if(kind==='row'&&id==='target')throw new MissingSelection({ids:{row:['target']}});return originalGet(kind,id);};const before=clone(store.records),revision=store.revision;
 assert.throws(()=>store.transaction(()=>advanced.trigger('row.created','projects',{id:'target'})),MissingSelection);assert.deepEqual(store.records,before);assert.equal(store.revision,revision);checks++;
 store.put('automation',{...store.get('automation','selection'),trigger:'scheduled',row_id:'target',schedule:{frequency:'days',start_at:'2026-01-01T00:00:00Z'}});const previous=clone(store.records),rev=store.revision;
 assert.throws(()=>new Scheduler(store,(id,body)=>advanced.run_as_author(id,body)).tick('2026-10-16T00:00:00Z'),MissingSelection);assert.deepEqual(store.records,previous);assert.equal(store.revision,rev);checks++;
}
{
 const {store,workspace}=setup({...base,actor:'alice',access:true});store.put('automation',{id:'author',name:'author',owner_id:'local',database_id:'projects',actions:[{type:'create_row',values:{name:'owner row'}}]});const access=new Access(store,store.get('member','alice')),service=new Advanced(store,workspace,{actor:'alice',access}),context=clone(store.context);service.run_as_author('author',{});const row=store.list('row')[0];assert.equal(row.owner_id,'local');assert(store.list('audit').filter(record=>['row.created','automation.executed'].includes(record.action)).every(record=>record.user==='local'));assert.deepEqual(store.context,context);checks++;
}
assert.equal(createAdvancedExtension()({path:'/scim/v2/Users'}),null,'SCIM needs an explicit bearer/trusted service boundary');checks++;
for(const failure of [false,true]){
 const {store,workspace,options}=setup({...base,access:true}),access=new Access(store,store.get('member','local')),authority=new Authorization(access),extension=createAdvancedExtension(options);
 store.put('automation',{id:'row-trigger',owner_id:'local',trigger:'row.created',enabled:true,database_id:'projects',actions:[{type:'set_property',property_id:'status',value:'완료'},...(failure?[{type:'create_row',values:{unknown:'invalid'}}]:[])]});
 const body={properties:{name:'original',status:'시작 전'}},path='/api/databases/projects/rows';authority.prepare('POST',path,body);
 const result=store.transaction(()=>extension({method:'POST',path,parts:path.slice(1).split('/'),body,query:new URLSearchParams(),store,workspace,access,authority}));
 assert.equal(result.status,201);assert.equal(result.payload.properties.status,failure?'시작 전':'완료');assert.equal(store.get('row',result.payload.id).properties.status,result.payload.properties.status);assert.equal(store.list('audit').some(item=>item.action==='automation.failed'),failure);checks++;
}
{
 const spec={...base,access:true,records:{...base.records,page:[{...base.records.page[0],permissions:{members:{alice:'edit'},groups:{}}}],group:[{id:'group',members:['alice']}]}}, {store,workspace,options}=setup(spec),access=new Access(store,store.get('member','local')),authority=new Authorization(access),path='/api/members/alice';authority.prepare('DELETE',path,{});
 const result=store.transaction(()=>createAdvancedExtension(options)({method:'DELETE',path,parts:path.slice(1).split('/'),body:{},query:new URLSearchParams(),store,workspace,access,authority}));
 assert.deepEqual(result.payload,{deleted:true});assert.equal(store.get('member','alice'),null);assert.deepEqual(store.get('page','welcome').permissions.members,{});assert.deepEqual(store.get('group','group').members,[]);assert(!store.get('teamspace','general').members.includes('alice'));checks++;
}
let mode='ok',requests=0,redirects=0;
const server=http.createServer(async(request,response)=>{
 requests++;const chunks=[];for await(const chunk of request)chunks.push(chunk);if(request.url==='/redirected'){redirects++;response.writeHead(200);response.end('{}');return;}
 assert.equal(request.headers.authorization,'Bearer fixture-only-key');assert.equal(JSON.parse(Buffer.concat(chunks)).model,'fixture-model');
 if(mode==='redirect'){response.writeHead(302,{Location:'/redirected'});response.end();return;}
 response.writeHead(mode==='error'?500:200,{'Content-Type':'application/json'});response.end(mode==='error'?'private provider diagnostics fixture-only-key':mode==='invalid'?'{}':JSON.stringify({choices:[{message:{content:'실제 fixture 응답'}}]}));
});server.listen(0,'127.0.0.1');await once(server,'listening');
try{
 const {store,workspace}=setup(base),env={FOUNTAIN_AI_URL:'http://127.0.0.1:'+server.address().port+'/infer',FOUNTAIN_AI_MODEL:'fixture-model',FOUNTAIN_AI_KEY:'fixture-only-key'},service=new Advanced(store,workspace,{cloud:false,env}),before=store.revision,prepared=service.prepare_ai({action:'summarize',prompt:'요약',page_id:'welcome'});assert.equal(store.revision,before);assert.equal(requests,0);const result=await infer_ai(prepared);assert.equal(result.text,'실제 fixture 응답');assert.deepEqual(result.citations,[{page_id:'welcome'}]);service.finish_ai(prepared,result);assert.equal(store.list('audit').at(-1).action,'ai.executed');checks++;
 assert.throws(()=>new Advanced(store,workspace,{env}).prepare_ai({prompt:'cloud cannot use laptop'}),error=>error instanceof APIError&&error.status===503);checks++;
 for(mode of ['redirect','error','invalid']){await assert.rejects(infer_ai(prepared),error=>error instanceof APIError&&error.status===502&&!error.message.includes('fixture-only-key'));checks++;}assert.equal(redirects,0);
 const count=requests;await assert.rejects(infer_ai({...prepared,endpoint:'http://remote.invalid/infer'}),APIError);assert.equal(requests,count);checks++;
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify({ok:true,pythonOracleOperations:94,allChecks:checks,provider:'real isolated HTTP fixture only',externalOrCloudDeployment:false}));
