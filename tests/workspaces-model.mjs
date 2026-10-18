/** Deterministic account command and cross-session response tests, without credentials or network. */
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const responses=[],calls=[],events=[];
const root={crypto:webcrypto,Headers,Response,TextEncoder,TextDecoder,Uint8Array,URL,URLSearchParams,Date,Error,TypeError,atob,btoa,console,CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},dispatchEvent:event=>events.push(event),FountainTransport:{unscopedRequest:(path,options)=>{calls.push({path,options});return new Promise(resolve=>responses.push(resolve));}}};root.globalThis=root;
const context=vm.createContext(root);for(const name of ['account','workspaces'])vm.runInContext(await readFile(new URL('../static/'+name+'.js',import.meta.url),'utf8'),context);
const account=new root.FountainAccount.Account(),parent='c'.repeat(32),session={mode:'account',enabled:true,authenticated:true,cache_binding:parent,identity:{name:'가족',email:'family@example.invalid'},expires_at:new Date(Date.now()+3600000).toISOString()};
function reply(value,status=200,headers={}){responses.shift()(new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}}));}
let pending=account.observe();reply(session);await pending;
const late=account.list();account.end(parent);reply({account_binding:parent,workspaces:[],next_cursor:null});await assert.rejects(late,error=>error.code==='STALE_ACCOUNT');assert.equal(account.session,null);
account.accept(session);pending=account.open('family',null,'d36abffc-3358-4eb4-bd6a-c0fd4409fadc');reply({workspace_id:'family',account_binding:parent,session:{}});await pending;const open=JSON.parse(calls.at(-1).options.body);assert.equal(open.expected_binding,null);assert.equal(open.session_binding,parent);assert.equal(calls.at(-1).path,'/api/account/workspaces/family/open');
pending=account.logout();assert.equal(account.session,null);assert.equal(account.pendingLogout,parent);reply({error:'retry'},503);await assert.rejects(pending,error=>error.status===503);assert.equal(account.pendingLogout,parent);pending=account.logout();assert.equal(JSON.parse(calls.at(-1).options.body).session_binding,parent);reply({authenticated:false});await pending;assert.equal(account.pendingLogout,null);
const legacy=new root.FountainAccount.Account();pending=legacy.observe();reply({error:'legacy authentication required'},401,{'X-Fountain-Account-Directory':'absent'});await assert.rejects(pending,error=>error.code==='ACCOUNT_DIRECTORY_ABSENT');
assert.equal(events.filter(event=>event.type==='fountain-account-ended').length,2);
const routes=root.FountainWorkspaces;assert.equal(routes.parseRoute('#w/family/page/document').workspaceId,'family');assert.equal(routes.parseRoute('#w/family/form/form-one').route,'form');assert.throws(()=>routes.parseRoute('#w/%66amily/home'));assert.throws(()=>routes.parseRoute('#w/family/page/%2Foutside'));
const invite={workspace_id:'family',invitation_id:'329342ce-f934-42c1-8bfb-f03c3a261865',code:'f'.repeat(64)};assert.equal(JSON.stringify(routes.invitation(routes.encodeInvitation(invite))),JSON.stringify(invite));assert.throws(()=>routes.invitation(btoa(JSON.stringify({...invite,v:1,role:'owner'}))));
console.log('PASS account model: stale directory response fence, explicit stable open command, revoke-first unknown-ACK logout retry, explicit legacy capability, binding-free workspace navigation and strict invitation envelope');
