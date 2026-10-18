/** Run production UI functions against controlled asynchronous HTTP replies. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
const source=await readFile(new URL('../static/organization.js',import.meta.url),'utf8');
class Node {
  constructor(text=''){this.text=text;this.children=[];this.handlers={};this.dataset={};}
  setAttribute(key,value){if(key.startsWith('data-'))this.dataset[key.slice(5)]=value;this[key]=value;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  addEventListener(type,handler){this.handlers[type]=handler;}
  contains(){return true;}
  querySelector(){return null;}
  get textContent(){return this.text+this.children.map(v=>typeof v==='string'?v:v.textContent).join('');}
  set textContent(value){this.text=value;this.children=[];}
}
const rootNode=new Node(),requests=[];
const context=vm.createContext({crypto:webcrypto,atob,btoa,Uint8Array,Date,Object,Error,Number,Array,JSON,String,Headers,Response,
 document:{getElementById:()=>rootNode,createElement:()=>new Node(),createTextNode:text=>new Node(text)},
 addEventListener(){},fetch(path,options){return new Promise(resolve=>requests.push({path,options,resolve}));}});
const instrumented=source.replace('  void checkSession();\n})(globalThis);','  globalThis.testUI={state,fence,mutate,loadDetail,renderDetail};\n})(globalThis);');
assert.notEqual(instrumented,source);
vm.runInContext(instrumented,context);
const {state,fence,mutate,loadDetail,renderDetail}=context.testUI;
const a='380bc476-026b-43b7-ac51-f302cbefef15',b='0b9a3833-09f2-466b-af47-65fb74587799',binding='a'.repeat(32);
fence.reset(binding);state.session={authenticated:true,identity:{name:'Owner',email:'qa@example.invalid'}};state.selected=a;
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
function reply(path,value){const index=requests.findIndex(v=>v.path.includes(path));assert.notEqual(index,-1,path);requests.splice(index,1)[0].resolve(Response.json({...value,session_binding:binding}));}
const write=mutate('POST','/organizations/'+a+'/workspace-requests',{revision:3},'연결 요청',()=>{state.connection={code:'A-only'};});
reply('/workspace-requests',{organization_id:a,revision:4,changed:true});await settle();
reply('/organizations?',{organizations:[{organization_id:a,name:'A'},{organization_id:b,name:'B'}]});
reply('/setup-eligibility?',{eligible:false,workspace_id:'qa'});await settle();
assert.equal(state.busy,true,'organization selection must stay disabled during ACK refresh');
// Even a programmatic selection/late refresh must not expose A’s code on B.
const chooseB=loadDetail(b);await settle();
reply('/organizations/'+b+'?',{organization_id:b,name:'B',revision:1,owners:[],workspaces:[],events:[]});await chooseB;
reply('/organizations/'+a+'?',{organization_id:a,name:'A',revision:4,owners:[],workspaces:[],events:[]});await write;
assert.equal(state.selected,b);assert.equal(state.connection,null);assert.equal(state.busy,false);
state.detail={organization_id:b,name:'B',revision:3,owners:[],workspaces:[],events:[{id:a,revision:3,action:'link_accept',actor_kind:'workspace_consent',occurred_at:new Date().toISOString(),details:{}}]};
const rendered=renderDetail().textContent;
assert.match(rendered,/워크스페이스 연결/);assert.match(rendered,/워크스페이스 소유자 동의/);assert.doesNotMatch(rendered,/조직 소유자 작업/);
console.log(JSON.stringify({passed:2,productionUI:true,controlledAckRefreshRace:true,workspaceConsentActor:true}));
