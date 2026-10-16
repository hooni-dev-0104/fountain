/** Production SCIM HTTP -> ServiceProvider -> ServiceStore -> Advanced -> SCIM
 * over real loopback RPC HTTP. Auth/grant/SQL state and transaction fences here
 * are explicitly a MEMORY MODEL, not hosted SQL/GoTrue/deprovision/last-owner QA. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {createScimHTTP} from '../functions/_shared/scim-http.ts';
import {createApplication} from '../functions/_shared/application.ts';
import {canonicalJSON} from '../functions/_shared/store.ts';

const copy=structuredClone,workspace='SCIM HTTP 가족',secret='sb_secret_scim_http_fixture_only_0123456789',token=Buffer.alloc(32,31).toString('base64url');
const sha=value=>createHash('sha256').update(value).digest('hex'),identity=(kind,id)=>canonicalJSON([kind,id]),stamp='2026-10-17T00:00:00.000000+00:00';
const diagnostic='PRIVATE_SQL_PROVIDER_DIAGNOSTIC',bodySecret='PRIVATE_PAGE_NOT_SCIM_DATA',localHash='PRIVATE_LEGACY_PASSWORD_HASH';
const errorSchema='urn:ietf:params:scim:api:messages:2.0:Error',userSchema='urn:ietf:params:scim:schemas:core:2.0:User';
const grantId='11111111-1111-4111-8111-111111111111';
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function fail(status=409,message='MODEL_DENIAL'){throw Object.assign(Error(diagnostic+' '+secret),{status,diagnostic:message});}
function legacy(role='service_role'){return Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.fixture_signature';}
class DatabaseModel {
 constructor(){this.records=new Map();this.meta=new Map([['workspace_id',workspace],['access_revision',0]]);this.revision=5;this.grantId=grantId;this.grantVersion=1;this.issuer='alice';this.enabled=true;this.mapped=true;this.issuerActive=true;this.issuerRole='owner';this.calls=[];this.receipts=new Map();this.faults=new Map();this.transform=null;this.afterAction=null;this.commitConflicts=0;this.conflictMessage='REVISION_CONFLICT';this.rejectLastOwner=false;
  for(const [id,role]of [['alice','owner'],['bob','member'],['carol','guest']])this.seed('member',{id,name:id,email:id+'@fixture.invalid',role,active:true,password_hash:localHash});
  this.seed('settings',{id:'workspace',name:bodySecret,disable_guests:false,disable_export:false});this.seed('group',{id:'family',name:'가족',members:['bob']});
  this.seed('teamspace',{id:'general',name:'공간',visibility:'private',members:['bob'],groups:['family']});
  for(const [kind,id]of [['page','private-page'],['database','private-db'],['row','private-row']])this.seed(kind,{id,owner_id:'alice',title:bodySecret,permissions:{default:'private',members:{bob:3},groups:{family:3}}});
 }
 seed(kind,value){const data={...copy(value),created_at:stamp,updated_at:stamp};this.records.set(identity(kind,data.id),{kind,id:data.id,data,createdAt:stamp,updatedAt:stamp});}
 record(kind,id){return this.records.get(identity(kind,id))?.data??null;}
 context(){return {kind:'scim',workspaceId:workspace,memberId:this.issuer,grantId:this.grantId,grantVersion:this.grantVersion,tokenHash:sha(token)};}
 current(){if(!this.enabled||!this.mapped||!this.issuerActive)fail(401);if(this.issuerRole!=='owner')fail(403);return {id:this.issuer,name:'발급 소유자',email:'issuer@fixture.invalid',role:'owner',active:true};}
 apply(action,p){
  if(action==='authorize'){this.current();assert.equal(p.p_workspace_id,workspace);if(p.p_token_hash!==sha(token))fail(401);assert.deepEqual(Object.keys(p).sort(),['p_token_hash','p_workspace_id']);return this.context();}
  const principal=this.current();if(canonicalJSON(p.p_context)!==canonicalJSON(this.context()))fail(401);
  if(action==='snapshot'){
   if(p.p_expected_revision!==null&&p.p_expected_revision!==this.revision)fail(409,'REVISION_CONFLICT');const selection=p.p_selection,index=p.p_cursor?.index??0;
   const records=[...this.records.values()].filter(row=>selection.kinds.includes(row.kind)||(Object.hasOwn(selection.ids,row.kind)&&selection.ids[row.kind].includes(row.id)));
   return {workspaceId:workspace,memberId:this.issuer,revision:this.revision,accessRevision:this.meta.get('access_revision'),principal,entities:copy(records.slice(index,index+selection.pageSize)),meta:selection.metaKeys.map(key=>({key,value:copy(this.meta.get(key)??null),present:this.meta.has(key)})),nextCursor:index+selection.pageSize<records.length?{index:index+selection.pageSize}:null};
  }
  if(action==='commit'){
   assert.equal(sha(p.p_canonical),p.p_digest);assert.deepEqual(JSON.parse(p.p_canonical),{context:p.p_context,expectedRevision:p.p_expected_revision,changes:p.p_changes});
   const key=canonicalJSON([p.p_context,p.p_transaction_id]),prior=this.receipts.get(key);if(prior){if(prior.digest!==p.p_digest)fail();return {revision:prior.revision};}
   if(this.commitConflicts){this.commitConflicts--;this.revision++;fail(409,this.conflictMessage);}if(this.revision!==p.p_expected_revision)fail(409,'REVISION_CONFLICT');
   if(this.rejectLastOwner&&p.p_changes.some(c=>c.kind==='member'&&c.id==='alice'&&(c.op==='delete'||c.data?.active===false)))fail(409,'LAST_OWNER_ACCOUNT');
   const records=copy(this.records),meta=copy(this.meta);let count=0;
   for(const c of p.p_changes){if(c.op==='meta'){assert.equal(c.key,'access_revision');meta.set(c.key,copy(c.value));count++;continue;}const key=identity(c.kind,c.id),old=records.get(key);if(c.op==='put'){assert.equal(c.previousCreatedAt,old?.createdAt??null);records.set(key,{kind:c.kind,id:c.id,data:copy(c.data),createdAt:c.data.created_at,updatedAt:c.data.updated_at});count++;}else if(records.delete(key))count++;}
   this.records=records;this.meta=meta;this.revision+=count;this.receipts.set(key,{digest:p.p_digest,revision:this.revision});return {revision:this.revision};
  }
  fail(400);
 }
}
async function fixture(t,{serviceKey=secret,...options}={}){
 const model=new DatabaseModel(),paths=[],closed=[];let address;
 const server=http.createServer(async(req,res)=>{try{
  paths.push(req.url);const match=/^\/rest\/v1\/rpc\/fountain_cloud_(scim_authorize|service_(snapshot|commit))$/.exec(req.url);assert(match,'Unexpected provider path');assert.equal(req.method,'POST');assert.equal(req.headers.apikey,serviceKey);assert.equal(req.headers.authorization,serviceKey.startsWith('sb_secret_')?undefined:'Bearer '+serviceKey);
  let raw='';for await(const bytes of req)raw+=bytes;assert(!raw.includes(token));const payload=JSON.parse(raw),action=match[1]==='scim_authorize'?'authorize':match[2];model.calls.push({action,raw,payload:copy(payload)});const fault=model.faults.get(action)?.shift();
  if(fault?.before)fail(fault.status??503,fault.message??diagnostic);const value=model.apply(action,payload);if(model.afterAction)await model.afterAction(action,payload,value);
  if(fault?.type==='destroy'){req.socket.destroy();return;}
  if(fault?.type==='status'){res.writeHead(fault.status??503,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'XX000',message:diagnostic,detail:serviceKey}));return;}
  if(fault?.type==='redirect'){res.writeHead(302,{Location:address+'/credential-leak?token='+diagnostic});res.end();return;}
  if(fault?.type==='hold'){fault.entered.resolve();await fault.release.promise;}
  if(fault?.type==='hold-headers'||fault?.type==='hold-body'){res.on('close',()=>{closed.push(action);fault.closed?.resolve();});fault.entered?.resolve();if(fault.type==='hold-body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}return;}
  res.writeHead(200,{'Content-Type':'application/json'});if(fault?.type==='malformed')res.end('{'+diagnostic);else if(fault?.type==='oversized')res.end(' '.repeat(4097));else if(fault?.type==='utf8')res.end(Buffer.from([0xc3,0x28]));else res.end(JSON.stringify(model.transform?model.transform(action,value):value));
 }catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({code:error.status===409?'PT409':'XX000',message:error.diagnostic??diagnostic,detail:serviceKey}));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');address='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
 const handler=createScimHTTP({supabaseUrl:address,serviceKey,workspaceId:workspace,clock:()=>Date.parse(stamp),...options});
 async function request(method='GET',path='/scim/v2/Users',body,headers={},signal){const response=await handler(new Request('https://edge.fixture.invalid'+path,{method,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/scim+json'}),...headers},...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)}),...(signal?{signal}:{})}));const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null,text,headers:response.headers};}
 return {model,handler,request,address,paths,closed};
}
const calls=(f,action)=>f.model.calls.filter(c=>c.action===action);
function safe(result){for(const hidden of [token,sha(token),secret,diagnostic,bodySecret,localHash,grantId,'tokenHash','grantVersion','password_hash'])assert(!result.text.includes(hidden),hidden);assert.match(result.headers.get('content-type'),/^application\/scim\+json/);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('x-content-type-options'),'nosniff');if(result.status>=400&&result.body){assert.deepEqual(result.body.schemas,[errorSchema]);assert.equal(result.body.status,String(result.status));assert.deepEqual(Object.keys(result.body).sort(),['detail','schemas','status']);}if(result.status===401)assert.equal(result.headers.get('www-authenticate'),'Bearer');}
async function createUser(f,extra={}){const result=await f.request('POST','/scim/v2/Users',{schemas:[userSchema],userName:'new@fixture.invalid',displayName:'새 사용자',active:true,...extra});assert.equal(result.status,201,result.text);safe(result);return result.body;}

test('canonical bearer only: cookie/origin/anonymous/URL credentials/JWT/server/public key substitutes stop before RPC',async t=>{
 const f=await fixture(t),before=()=>f.model.calls.length;
 for(const headers of [{Cookie:'old-browser-cookie'},{Cookie:''},{Origin:'https://family.invalid'},{Origin:''},{Authorization:''},{Authorization:'bearer '+token},{Authorization:'Bearer  '+token},{Authorization:'Bearer '+token+'='},{Authorization:'Bearer '+token.slice(0,-1)+'B'},{Authorization:'Bearer '+legacy()},{Authorization:'Bearer '+secret},{Authorization:'Bearer sb_publishable_'+'p'.repeat(40)},{Authorization:'Basic '+token},{Authorization:'Bearer '+token+', Bearer '+token}]){const count=before(),response=await f.request('GET',undefined,undefined,headers);assert([401,403].includes(response.status),response.text);safe(response);assert.equal(before(),count);}
 for(const key of ['token','access_token','api_key','apikey'])for(const supplied of ['', 'Bearer '+token]){const count=before(),response=await f.request('GET','/scim/v2/Users?'+key+'=untrusted-credential',undefined,{Authorization:supplied});assert([400,401,403].includes(response.status));safe(response);assert.equal(before(),count);}
});
test('real modern service-key RPC grants only the current issuer and exposes safe SCIM Users with no browser-header requirement',async t=>{
 const f=await fixture(t),response=await f.request();assert.equal(response.status,200,response.text);safe(response);assert.equal(response.body.totalResults,3);assert.equal(response.body.Resources[0].userName,'alice@fixture.invalid');assert.deepEqual(Object.keys(response.body.Resources[0]).sort(),['active','displayName','id','meta','schemas','userName']);assert(calls(f,'snapshot').length>1);assert.equal(calls(f,'authorize').length,2);assert.equal(calls(f,'commit').length,1);assert.deepEqual(calls(f,'commit')[0].payload.p_changes,[]);assert.equal(f.model.revision,5);
 for(const c of calls(f,'snapshot')){assert.deepEqual(c.payload.p_context,f.model.context());assert(!('authSessionId'in c.payload.p_context));}assert.equal(response.body.Resources.some(item=>Object.hasOwn(item,'role')),false);
});
test('Users create/read/PUT/PATCH/delete runs actual resource staging and cannot adopt caller roles or Auth IDs',async t=>{
 const f=await fixture(t),user=await createUser(f,{id:randomUUID(),role:'owner',auth_user_id:randomUUID(),password:localHash,user_metadata:{role:'owner'}});assert.equal(f.model.record('member',user.id).role,'member');assert.equal(f.model.record('member',user.id).email,'new@fixture.invalid');
 let response=await f.request('GET','/scim/v2/Users/'+user.id);assert.equal(response.status,200);assert.equal(response.body.id,user.id);safe(response);
 response=await f.request('PUT','/scim/v2/Users/'+user.id,{userName:'renamed@fixture.invalid',displayName:'수정 이름',active:true});assert.equal(response.status,200);assert.equal(response.body.userName,'renamed@fixture.invalid');
 response=await f.request('PATCH','/scim/v2/Users/'+user.id,{Operations:[{op:'replace',path:'active',value:false},{op:'replace',path:'displayName',value:'비활성 사용자'}]});assert.equal(response.status,200);assert.equal(response.body.active,false);safe(response);
 response=await f.request('DELETE','/scim/v2/Users/'+user.id);assert.equal(response.status,204);assert.equal(response.text,'');safe(response);assert.equal(f.model.record('member',user.id),null);assert.equal(f.model.receipts.size,5);assert.equal(f.model.meta.get('access_revision'),4);
 assert.equal((await f.request('GET','/scim/v2/Users/'+user.id)).status,404);
});
test('Groups create/list/read/PUT/add/replace/delete stages real members and strips group ACL references',async t=>{
 const f=await fixture(t);let response=await f.request('POST','/scim/v2/Groups',{displayName:'새 그룹',members:[{value:'bob'}]});assert.equal(response.status,201,response.text);const id=response.body.id;safe(response);
 response=await f.request('PUT','/scim/v2/Groups/'+id,{displayName:'변경',members:[{value:'alice'}]});assert.equal(response.status,200);
 response=await f.request('PATCH','/scim/v2/Groups/'+id,{Operations:[{op:'add',path:'members',value:[{value:'carol'},{value:'alice'}]}]});assert.equal(response.status,200);assert.deepEqual(response.body.members,[{value:'alice'},{value:'carol'}]);
 assert.equal((await f.request('GET','/scim/v2/Groups/'+id)).status,200);assert.equal((await f.request('GET','/scim/v2/Groups')).body.totalResults,2);
 response=await f.request('DELETE','/scim/v2/Groups/family');assert.equal(response.status,204);safe(response);assert.deepEqual(f.model.record('teamspace','general').groups,[]);for(const [kind,id]of [['page','private-page'],['database','private-db'],['row','private-row']])assert.deepEqual(f.model.record(kind,id).permissions.groups,{});
});
test('Users DELETE uses production ACL/group cleanup; provider-only last-owner fence is labeled model behavior',async t=>{
 const f=await fixture(t),response=await f.request('DELETE','/scim/v2/Users/bob');assert.equal(response.status,204,response.text);assert.deepEqual(f.model.record('group','family').members,[]);assert.deepEqual(f.model.record('teamspace','general').members,[]);for(const [kind,id]of [['page','private-page'],['database','private-db'],['row','private-row']])assert.deepEqual(f.model.record(kind,id).permissions.members,{});
 f.model.rejectLastOwner=true;const before=copy(f.model.records),rejected=await f.request('DELETE','/scim/v2/Users/alice');assert.equal(rejected.status,409);safe(rejected);assert.deepEqual(f.model.records,before); // This is transport handling, not proof of SQL deprovision/last-owner logic.
});
test('list pagination, empty pages and unsupported filter/bulk remain explicit; cloud discovery intentionally rejects legacy mutation methods',async t=>{
 const f=await fixture(t);let response=await f.request('GET','/scim/v2/Users?startIndex=2&count=1');assert.equal(response.status,200);assert.equal(response.body.startIndex,2);assert.equal(response.body.itemsPerPage,1);assert.equal(response.body.Resources[0].id,'bob');
 response=await f.request('GET','/scim/v2/Users?startIndex=100&count=0');assert.equal(response.body.totalResults,3);assert.deepEqual(response.body.Resources,[]);
 for(const path of ['/scim/v2/Users?filter=userName%20eq%20%22bob%22','/scim/v2/Users?startIndex=nope','/scim/v2/Bulk']){const response=await f.request('GET',path);assert([400,404].includes(response.status));safe(response);}
 for(const method of ['GET','HEAD']){const response=await f.request(method,'/scim/v2/ServiceProviderConfig');assert.equal(response.status,200,response.text);if(method!=='HEAD'){assert.equal(response.body.filter.supported,false);assert.equal(response.body.bulk.supported,false);}safe(response);}
 const revision=f.model.revision,access=f.model.meta.get('access_revision');for(const method of ['OPTIONS','POST','PUT','PATCH','DELETE']){const count=calls(f,'snapshot').length,commits=calls(f,'commit').length,response=await f.request(method,'/scim/v2/ServiceProviderConfig',['POST','PUT','PATCH','DELETE'].includes(method)?{}:undefined);assert.equal(response.status,405);safe(response);assert.equal(calls(f,'snapshot').length,count);assert.equal(calls(f,'commit').length,commits);}assert.equal(f.model.revision,revision);assert.equal(f.model.meta.get('access_revision'),access);
 const anonymous=await f.request('POST','/scim/v2/ServiceProviderConfig',{}, {Authorization:''});assert.equal(anonymous.status,401);safe(anonymous);
});
test('HEAD/204/error/media/cache and normalized deployment prefixes return RFC-shaped responses without private data',async t=>{
 const f=await fixture(t);for(const path of ['/scim/v2/Users/bob','/functions/v1/fountain-api/scim/v2/Users/bob','/fountain-api/scim/v2/Users/bob']){const response=await f.request('HEAD',path);assert.equal(response.status,200);assert.equal(response.body,null);safe(response);}
 for(const [method,path,status]of [['GET','/api/scim/tokens',404],['OPTIONS','/scim/v2/Users',405],['GET','/scim/v2/Users/no-such-user',404],['PATCH','/scim/v2/Users',400]]){const response=await f.request(method,path,method==='PATCH'?{}:undefined);assert.equal(response.status,status);safe(response);}
 const response=await f.request('HEAD',undefined,undefined,{Authorization:''});assert.equal(response.status,401);assert.equal(response.text,'');safe(response);
});
test('invalid encoded separators and escapes preserve SCIM errors/provider-zero through direct and real application composition',async t=>{
 const f=await fixture(t),application=createApplication({supabaseUrl:f.address,serviceKey:secret,publishableKey:'sb_publishable_scim_fixture',cryptoKeys:[{id:'fixture',secret}],workspaceId:workspace,origins:[]});
 for(const prefix of ['','/fountain-api','/functions/v1/fountain-api'])for(const suffix of ['/Users%2Fbob','/Users/%ZZ'])for(const handler of [f.handler,application]){const count=f.model.calls.length,response=await handler(new Request('https://edge.fixture.invalid'+prefix+'/scim/v2'+suffix,{headers:{Authorization:'Bearer '+token}})),text=await response.text(),result={status:response.status,text,body:JSON.parse(text),headers:response.headers};assert.equal(result.status,400,result.text);safe(result);assert.equal(f.model.calls.length,count);}
});
test('legacy service-role transport works and non-service or invalid transport configurations never contact a provider',async t=>{
 const f=await fixture(t,{serviceKey:legacy()});assert.equal((await f.request()).status,200);
 for(const key of ['sb_publishable_'+'p'.repeat(30),legacy('anon'),legacy('authenticated'),'', 'sb_secret_short'])assert.throws(()=>createScimHTTP({supabaseUrl:f.address,serviceKey:key,workspaceId:workspace}));
 for(const options of [{supabaseUrl:'https://user:pass@fixture.invalid/'},{supabaseUrl:'http://untrusted.invalid/'},{supabaseUrl:f.address+'/wrong'},{timeoutMs:0},{budgetMs:0}])assert.throws(()=>createScimHTTP({supabaseUrl:f.address,serviceKey:secret,workspaceId:workspace,...options}));
});
test('known revision conflicts reopen fresh data within bounds; other conflicts do not blindly repeat actions',async t=>{
 const f=await fixture(t);f.model.commitConflicts=1;const user=await createUser(f);assert.equal(calls(f,'commit').length,2);assert.notEqual(calls(f,'commit')[0].payload.p_transaction_id,calls(f,'commit')[1].payload.p_transaction_id);assert.equal(f.model.receipts.size,1);assert.equal([...f.model.records.values()].filter(row=>row.kind==='member').length,4);assert(f.model.record('member',user.id));
 const bounded=await fixture(t);bounded.model.commitConflicts=9;let result=await bounded.request('POST','/scim/v2/Users',{userName:'fail@fixture.invalid'});assert.equal(result.status,409);assert.equal(calls(bounded,'commit').length,3);assert.equal(bounded.model.receipts.size,0);safe(result);
 const denied=await fixture(t);denied.model.commitConflicts=1;denied.model.conflictMessage='OTHER_CONFLICT';result=await denied.request('POST','/scim/v2/Users',{userName:'fail@fixture.invalid'});assert.equal(result.status,409);assert.equal(calls(denied,'commit').length,1);safe(result);
});
test('MissingSelection expands actual snapshots, and the 64-round ceiling cannot publish partial group creation',async t=>{
 const f=await fixture(t);for(let i=0;i<80;i++)f.model.seed('member',{id:'member-'+i,name:'member-'+i,email:'member'+i+'@fixture.invalid',role:'member',active:true});const before=copy(f.model.records),response=await f.request('POST','/scim/v2/Groups',{displayName:'bounded',members:Array.from({length:80},(_,i)=>({value:'member-'+i}))});assert.equal(response.status,503);safe(response);assert.equal(calls(f,'snapshot').length,64);assert.equal(calls(f,'commit').length,0);assert.deepEqual(f.model.records,before);
});
test('lost accepted commit acknowledgement retries identical bytes/transaction/canonical/digest and applies one action',async t=>{
 for(const type of ['destroy','status']){const f=await fixture(t);f.model.faults.set('commit',[{type}]);await createUser(f);const commits=calls(f,'commit');assert.equal(commits.length,2);assert.equal(commits[0].raw,commits[1].raw);assert.equal(f.model.receipts.size,1);assert.equal([...f.model.records.values()].filter(r=>r.kind==='member').length,4);assert.equal(f.model.meta.get('access_revision'),1);assert.equal(calls(f,'authorize').length,2);}
});
test('persistent unknown commit ACK never reruns the action or changes transaction identity',async t=>{
 const f=await fixture(t);f.model.faults.set('commit',[{type:'destroy'},{type:'status'}]);const response=await f.request('POST','/scim/v2/Users',{userName:'uncertain@fixture.invalid'});assert.equal(response.status,503);safe(response);assert.equal(calls(f,'commit').length,2);assert.equal(calls(f,'commit')[0].raw,calls(f,'commit')[1].raw);assert.equal(f.model.receipts.size,1);assert.equal([...f.model.records.values()].filter(r=>r.kind==='member').length,4);assert.equal(calls(f,'authorize').length,1);
});
test('revocation, issuer changes or grant rotation before final authorize hide private read/write responses',async t=>{
 for(const mutate of [m=>m.enabled=false,m=>m.issuerActive=false,m=>m.mapped=false,m=>m.issuerRole='admin',m=>m.grantVersion++,m=>m.grantId=randomUUID(),m=>m.issuer='bob']){
  const f=await fixture(t);f.model.afterAction=(action)=>{if(action==='commit'){f.model.afterAction=null;mutate(f.model);}};const response=await f.request('POST','/scim/v2/Users',{userName:'committed@fixture.invalid'});assert([401,403].includes(response.status),response.text);safe(response);assert(!response.body.id&&!response.body.Resources);assert.equal(f.model.receipts.size,1);
 }
 const f=await fixture(t);f.model.afterAction=action=>{if(action==='snapshot'){f.model.afterAction=null;f.model.grantVersion++;}};const response=await f.request('GET','/scim/v2/ServiceProviderConfig');assert.equal(response.status,401);safe(response);
});
test('revocation before an exact lost-ACK retry rejects receipt publication while preserving the already-accepted effect',async t=>{
 const f=await fixture(t);f.model.faults.set('commit',[{type:'destroy'}]);f.model.afterAction=action=>{if(action==='commit'){f.model.afterAction=null;f.model.enabled=false;}};const response=await f.request('POST','/scim/v2/Users',{userName:'once@fixture.invalid'});assert.equal(response.status,401);safe(response);assert.equal(calls(f,'commit').length,2);assert.equal(f.model.receipts.size,1);assert.equal([...f.model.records.values()].filter(r=>r.kind==='member').length,4);
});
test('wrong authorize DTO workspace/token/kind and snapshot principal/affinity fail closed without public secrets',async t=>{
 for(const patch of [{workspaceId:'other'},{tokenHash:'0'.repeat(64)},{grantId:[]},{grantVersion:0},{memberId:{}},{extra:diagnostic},{kind:'owner'}]){const f=await fixture(t);f.model.transform=(action,value)=>action==='authorize'?{...value,...patch}:value;const response=await f.request();assert.equal(response.status,503);safe(response);assert.equal(calls(f,'snapshot').length,0);}
 for(const patch of [{workspaceId:'wrong'},{memberId:'bob'},{principal:{id:'alice',name:'a',email:'a@fixture.invalid',role:'OWNER',active:true}}]){const f=await fixture(t);f.model.transform=(action,value)=>action==='snapshot'?{...value,...patch}:value;const response=await f.request();assert.equal(response.status,503);safe(response);assert.equal(calls(f,'commit').length,0);}
});
test('bounded authorize replies reject malformed UTF8/JSON/oversized/redirect/status without private provider diagnostics',async t=>{
 for(const type of ['malformed','utf8','oversized','redirect']){const f=await fixture(t);f.model.faults.set('authorize',[{type}]);const response=await f.request();assert.equal(response.status,503);safe(response);assert.equal(calls(f,'snapshot').length,0);assert.equal(f.paths.length,1);}
 for(const status of [401,403,429,500]){const f=await fixture(t);f.model.faults.set('authorize',[{before:true,status}]);const response=await f.request();assert.equal(response.status,status===500?503:status);safe(response);assert.equal(calls(f,'snapshot').length,0);}
});
test('request JSON/media/UTF8/length limits and duplicate emails cannot write a partial resource',async t=>{
 const f=await fixture(t);for(const [body,headers,status]of [['[]',{},400],['{',{},400],[new Uint8Array([0xc3,0x28]),{},400],['{}',{'Content-Type':'text/plain'},415],['{}',{'Content-Encoding':'gzip'},415],['{}',{'Content-Length':'1'},400],['{}',{'Content-Length':'10000001'},413],[' '.repeat(10_000_001),{},413]]){const response=await f.request('POST','/scim/v2/Users',body,headers);assert.equal(response.status,status,response.text);safe(response);assert.equal(calls(f,'commit').length,0);}
 const response=await f.request('POST','/scim/v2/Users',{userName:'BOB@fixture.invalid',displayName:'duplicate'});assert.equal(response.status,409);safe(response);assert.equal(f.model.receipts.size,0);
});
test('whole-request deadlines and caller cancellation close actual stalled RPC sockets; pending input streams are cancelled',async t=>{
 for(const type of ['hold-headers','hold-body']){const f=await fixture(t,{budgetMs:90,timeoutMs:2000}),entered=deferred(),closed=deferred();f.model.faults.set('authorize',[{type,entered,closed}]);const pending=f.request();await entered.promise;const response=await pending;assert.equal(response.status,503);safe(response);await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('SCIM provider socket remained open')),1000).unref())]);assert(f.closed.includes('authorize'));assert.equal(calls(f,'snapshot').length,0);}
 const f=await fixture(t,{budgetMs:80});let cancelled=0;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled++;}});const response=await f.handler(new Request('https://edge.fixture.invalid/scim/v2/Users',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/scim+json'},body:stream,duplex:'half'}));assert.equal(response.status,503);assert.equal(cancelled,1);assert.equal(calls(f,'snapshot').length,0);
 const network=await fixture(t,{budgetMs:2000}),entered=deferred(),closed=deferred(),aborter=new AbortController();network.model.faults.set('authorize',[{type:'hold-body',entered,closed}]);const pending=network.request('GET',undefined,undefined,{},aborter.signal);await entered.promise;aborter.abort(Error(diagnostic));const stopped=await pending;assert.equal(stopped.status,503);safe(stopped);await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Aborted SCIM socket remained open')),1000).unref())]);
});
test('per-RPC authorization timeout closes the real socket without retrying or reaching data under a live outer budget',async t=>{
 const f=await fixture(t,{timeoutMs:80,budgetMs:2000}),entered=deferred(),closed=deferred();f.model.faults.set('authorize',[{type:'hold-headers',entered,closed}]);const started=performance.now(),pending=f.request();await entered.promise;const response=await pending;assert.equal(response.status,503);safe(response);assert(performance.now()-started<1500);await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('SCIM per-RPC timeout did not close its socket')),1000).unref())]);assert.equal(calls(f,'authorize').length,1);assert.equal(calls(f,'snapshot').length,0);assert.equal(calls(f,'commit').length,0);
});
