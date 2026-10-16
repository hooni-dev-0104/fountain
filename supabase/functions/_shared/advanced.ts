/** Synchronous advanced domain staging; external inference is a separate phase. */
import {Access,APIError,casefold,clone,get,has,is_object,put_key,truth} from './access.ts';
import type {Entity} from './access.ts';
import {Authorization} from './authorization.ts';
import {Workspace,normalize_blocks} from './core.ts';
import type {CoreStore} from './core.ts';
import {MissingSelection} from './store.ts';
import {validate_schedule,scheduleDatetime} from './scheduler.ts';
import {blocks_html,render_public,pythonJSON} from './publishing.ts';
import {scim_resource} from './scim.ts';
import {coreRoute} from './domain.ts';
import type {DomainRequest,DomainResult,DomainExtension} from './domain.ts';

export class AdvancedError extends APIError {constructor(message:string,status=400){super(status,message);this.name='AdvancedError';}}
export function advancedRequire(condition:unknown,message:string,status=400):asserts condition{if(!truth(condition))throw new AdvancedError(message,status);}
const check=advancedRequire;
const trim=(value:string)=>value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu,'');
function text(value:unknown,name:string,limit=10000):string{check(typeof value==='string'&&Array.from(trim(value)).length>0&&Array.from(trim(value)).length<=limit,name+': 비어 있지 않은 문자열이 필요합니다');return trim(value);}
const EMAIL=/^[^\p{White_Space}\u001c-\u001f@]+@[^\p{White_Space}\u001c-\u001f@]+\.[^\p{White_Space}\u001c-\u001f@]+$/u;
export function pythonEqual(a:any,b:any):boolean{
  if(a===b)return true;
  if(['number','boolean'].includes(typeof a)&&['number','boolean'].includes(typeof b))return Number(a)===Number(b);
  if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>pythonEqual(v,b[i]));
  return is_object(a)&&is_object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>has(b,key)&&pythonEqual(a[key],b[key]));
}
export type AdvancedOptions={access?:Access;actor?:string;clock?:()=>number;uid?:()=>string;env?:Record<string,string|undefined>;cloud?:boolean};
export type PreparedAI={action:string;prompt:string;context:string;page_id:any;model:string;instructions:string;endpoint:string;key:string|undefined};
function actorStore(store:CoreStore,actor:string):CoreStore{
  // Only domain ownership/audit defaults change. The original CloudStore's
  // immutable RPC auth context is never reassigned or used to impersonate a login.
  let wrapped:CoreStore;
  wrapped=new Proxy(store,{get(target,key){
    if(key==='audit')return (action:string,details:Entity,user=actor)=>target.audit(action,details,user);
    if(key==='context')return {...target.context,memberId:actor};
    if(key==='transaction')return <T>(action:(value:CoreStore)=>T)=>target.transaction(()=>action(wrapped));
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});return wrapped;
}

export class Advanced {
  static collections=new Set(['teamspaces','members','groups','automations','forms','sites','integrations']);
  collections=Advanced.collections;store:CoreStore;workspace:Workspace;access?:Access;actor:string;
  private options:AdvancedOptions;private env:Record<string,string|undefined>;
  constructor(store:CoreStore,workspace:Workspace,options:AdvancedOptions={}){
    this.store=store;this.workspace=workspace;this.options=options;this.access=options.access;this.actor=options.actor??store.context?.memberId??'local';this.env=options.env??{};
    if(!store.get('settings','workspace'))store.put('settings',{id:'workspace',name:'Fountain',disable_guests:false,disable_public_sharing:false,disable_export:false,trash_retention_days:30,transcript_retention_days:30});
  }
  // Register generated IDs with the staged store. Raw random IDs would trigger
  // MissingSelection for a different absent ID on every snapshot retry.
  private id(kind:string):string{return this.store.allocate_id(kind);}
  private now():string{return this.options.clock?new Date(this.options.clock()).toISOString().replace(/\.(\d{3})Z$/,'.$1000+00:00'):this.store.requestTime??new Date().toISOString().replace(/\.(\d{3})Z$/,'.$1000+00:00');}
  private audit(action:string,details:Entity){return this.store.audit(action,details,this.actor);}
  settings():Entity{return this.store.get('settings','workspace')||{};}
  overview():Entity{return {...Object.fromEntries([...this.collections].map(kind=>[kind,this.store.list(kind.slice(0,-1))])),audit:this.store.list('audit').slice(-100),settings:this.settings(),features:this.capabilities().features};}
  local_ai():boolean{if(this.options.cloud!==false)return false;try{const url=new URL(this.env.FOUNTAIN_AI_URL||'');return url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);}catch{return false;}}
  capabilities():Entity{return {mode:this.options.cloud!==false||truth(this.store.meta('auth_accounts_required',false))?'member-accounts':this.env.FOUNTAIN_ACCESS_TOKEN?'trusted-family-shared':'local-single-user',features:FEATURE_ROWS.map(row=>Object.fromEntries(['id','name','plan','status','detail'].map((key,index)=>[key,row[index]]))),ai_configured:!!((this.env.FOUNTAIN_AI_PROVIDER||'compatible-http')==='compatible-http'&&this.env.FOUNTAIN_AI_MODEL&&(this.options.cloud===false||this.env.FOUNTAIN_AI_URL)&&(this.env.FOUNTAIN_AI_KEY||this.local_ai())),scim_configured:!!this.env.FOUNTAIN_SCIM_TOKEN,search_advanced:true,source:'https://www.notion.com/pricing'};}
  item(kind:string,identity:unknown):Entity{const item=this.store.get(this.collections.has(kind)?kind.slice(0,-1):kind,identity);check(item!==null,'항목을 찾을 수 없습니다',404);return item;}
  save(kind:string,body:Entity,identity:any=null):Entity{
    check(is_object(body),'JSON 객체가 필요합니다');const old=truth(identity)?this.item(kind,identity):{},data={...old,...clone(body),id:truth(identity)?identity:this.id(this.collections.has(kind)?kind.slice(0,-1):kind)};
    if(['teamspaces','groups','automations','forms','sites','integrations'].includes(kind))data.name=text(get(data,'name',''),'이름',200);
    if(kind==='members'){
      if(has(data,'active'))check(typeof data.active==='boolean','활성 상태는 참·거짓 값이어야 합니다');
      const email=casefold(text(get(data,'email',''),'이메일',254));check(EMAIL.test(email),'올바른 이메일이 필요합니다');
      check(!this.store.list('member').some(member=>member.id!==data.id&&typeof member.email==='string'&&casefold(trim(member.email))===email),'이미 등록된 이메일입니다',409);
      check(['owner','admin','member','guest'].includes(get(data,'role','member')),'올바른 역할이 필요합니다');check(!(data.role==='guest'&&truth(get(this.settings(),'disable_guests'))),'게스트가 비활성화되었습니다',403);
      data.email=email;data.name=text(get(data,'name')||email.split('@')[0],'이름',200);if(!has(data,'role'))data.role='member';
    }
    if(['groups','teamspaces'].includes(kind)){
      const members=get(data,'members',[]);check(Array.isArray(members)&&members.every(member=>typeof member==='string'),'멤버 ID 목록이 필요합니다');check(members.every(member=>this.store.get('member',member)),'존재하지 않는 멤버입니다');
      if(kind==='teamspaces'){const groups=get(data,'groups',[]);check(Array.isArray(groups)&&groups.every(group=>typeof group==='string'&&this.store.get('group',group)),'유효한 그룹 ID 목록이 필요합니다');check(['open','closed','private'].includes(get(data,'visibility','open')),'잘못된 공개 범위입니다');}
    }
    if(['forms','automations'].includes(kind)){const database=get(data,'database_id','projects');check(this.store.get('database',database),'대상 데이터베이스가 없습니다',404);data.database_id=database;}
    if(kind==='forms'){
      check(!truth(get(this.settings(),'disable_public_sharing'))||!truth(get(data,'published')),'공개 공유가 비활성화되었습니다',403);if(!has(data,'fields'))data.fields=[];const fields=data.fields;check(Array.isArray(fields)&&fields.length<=100,'질문은 최대 100개입니다');const seen=new Set();
      for(const field of fields){check(is_object(field),'질문 객체가 필요합니다');field.id=text(get(field,'id',''),'질문 ID',100);check(!seen.has(field.id),'질문 ID가 중복됩니다');seen.add(field.id);check(['text','number','select','email','date','checkbox'].includes(get(field,'type','text')),'지원하지 않는 질문 유형');const condition=get(field,'condition');if(truth(condition))check(is_object(condition)&&condition.field!==field.id&&seen.has(condition.field),'조건은 앞선 질문을 참조해야 합니다');}
    }
    if(kind==='sites'){
      check(!truth(get(this.settings(),'disable_public_sharing'))||!truth(get(data,'published')),'공개 공유가 비활성화되었습니다',403);check(!truth(get(this.item('page',get(data,'page_id','')),'archived')),'삭제된 페이지는 게시할 수 없습니다');const slug=get(data,'slug',data.id);check(typeof slug==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(slug),'주소에는 영문·숫자·밑줄·하이픈만 사용합니다');check(!this.store.list('site').some(site=>site.id!==data.id&&site.slug===slug),'이미 사용 중인 주소입니다',409);data.slug=slug;
    }
    if(kind==='automations'){
      check(['manual','row.created','row.updated','scheduled'].includes(get(data,'trigger','manual')),'지원하지 않는 실행 조건');const actions=get(data,'actions',[]);check(Array.isArray(actions)&&actions.length>0&&actions.length<=20,'작업은 1개 이상 20개 이하입니다');for(const action of actions)check(is_object(action)&&['set_property','create_row','create_page'].includes(action.type),'지원하지 않는 자동화 작업');check(typeof get(data,'enabled',true)==='boolean','자동화 활성 상태는 참·거짓이어야 합니다');if(!has(data,'owner_id'))data.owner_id=this.actor;
      for(const key of ['next_run_at','last_run_at','last_run_status','last_error','schedule_status'])check(!has(body,key),'실행 상태는 서버에서 관리합니다');
      if(has(data,'row_id')){if(data.row_id==='')data.row_id=null;check(data.row_id===null||typeof data.row_id==='string','올바른 대상 항목 ID가 필요합니다');if(truth(data.row_id)){const target=this.store.get('row',data.row_id);check(target&&target.database_id===data.database_id,'예약 대상 항목을 찾을 수 없습니다',404);this.access?.require_resource('row',data.row_id,3);}}
      if(data.trigger==='scheduled'){const schedule=validate_schedule(get(data,'schedule'));if(!Object.keys(old).length||old.trigger!=='scheduled'||!pythonEqual(old.schedule,schedule)){data.next_run_at=schedule.start_at;data.schedule_status='pending';}data.schedule=schedule;if(actions.some(action=>action.type==='set_property'))check(truth(get(data,'row_id')),'예약 속성 변경에는 대상 항목이 필요합니다');}
      else for(const key of ['schedule','next_run_at','schedule_status'])delete data[key];
    }
    this.store.put(this.collections.has(kind)?kind.slice(0,-1):kind,data);this.audit(kind+'.'+(truth(identity)?'updated':'created'),{id:data.id});return this.item(kind,data.id);
  }
  static field_visible(field:Entity,answers:Entity):boolean{const condition=get(field,'condition');return !truth(condition)||pythonEqual(get(answers,condition.field),get(condition,'equals'));}
  submit_form(identity:string,body:Entity):Entity{
    check(!truth(get(this.settings(),'disable_public_sharing')),'공개 공유가 비활성화되었습니다',403);const form=this.item('forms',identity);check(truth(get(form,'published',false)),'양식이 게시되지 않았습니다',404);const answers=get(body,'answers',{});check(is_object(answers),'응답 객체가 필요합니다');const values:Entity={};
    for(const field of form.fields){if(!Advanced.field_visible(field,answers))continue;const value=get(answers,field.id),missing=value===null||value===''||Array.isArray(value)&&value.length===0;check(!(truth(get(field,'required'))&&missing),get(field,'label',field.id)+': 필수 응답입니다');if(missing)continue;const type=get(field,'type','text');check(['string','number','boolean'].includes(typeof value),'응답 형식이 잘못되었습니다');if(type==='number')check(typeof value==='number','숫자 응답이 필요합니다');else if(type==='checkbox')check(typeof value==='boolean','체크박스 응답이 필요합니다');else if(type==='select')check(get(field,'options',[]).some((item:any)=>pythonEqual(item,value)),'목록에서 선택해 주세요');else check(typeof value==='string'&&Array.from(value).length<=10000,'문자열 응답이 필요합니다');if(type==='email')check(EMAIL.test(value),'올바른 이메일이 필요합니다');put_key(values,get(field,'property_id',field.id),value);}
    const row=this.create_row(form.database_id,values),submission=this.store.put('submission',{id:this.id('submission'),form_id:identity,row_id:row.id,answers});this.audit('form.submitted',{form_id:identity,row_id:row.id});this.trigger('row.created',form.database_id,row);return {row,submission};
  }
  create_row(database:string,values:Entity):Entity{return this.workspace.create_row(database,{values});}
  trigger(event:string,database:string,row:Entity):Entity[]{
    const results=[];for(const automation of this.store.list('automation'))if(truth(get(automation,'enabled',true))&&automation.trigger===event&&automation.database_id===database){try{results.push(this.run_as_author(automation.id,{row_id:row.id}));}catch(error){if(error instanceof MissingSelection||!(error instanceof APIError))throw error;this.audit('automation.failed',{id:automation.id,error:error.message});}}return results;
  }
  run_as_author(identity:string,body:Entity):Entity{
    const automation=this.item('automations',identity),author=get(automation,'owner_id','local'),member=this.store.get('member',author);
    check(member&&get(member,'active',true)===true,'자동화 작성자가 비활성화되었습니다',403);const access=new Access(this.store,member);access.require_resource('database',automation.database_id,4);
    const scoped=actorStore(this.store,author),workspace=new Workspace(scoped,{access,actor:author});return new Advanced(scoped,workspace,{...this.options,access,actor:author}).run_automation(identity,body);
  }
  run_automation(identity:string,body:Entity):Entity{return this.store.transaction(()=>this._run_automation(identity,body));}
  private _run_automation(identity:string,body:Entity):Entity{
    const automation=this.item('automations',identity);check(truth(get(automation,'enabled',true)),'비활성화된 자동화입니다',409);const rowId=get(body,'row_id');let row=truth(rowId)?this.item('row',rowId):null;if(row){this.access?.require_resource('row',rowId,3);check(row.database_id===automation.database_id,'다른 데이터베이스의 행입니다');}
    const conditions=get(automation,'conditions',{});check(is_object(conditions),'조건 객체가 필요합니다');if(truth(conditions)&&(!row||Object.entries(conditions).some(([key,value])=>!pythonEqual(get(get(row,'properties',{}),key),value))))return {skipped:true,reason:'조건 불일치'};
    check(row!==null||!automation.actions.some((action:Entity)=>action.type==='set_property'),'속성을 변경할 행을 지정해 주세요');const results=[],authority=this.access?new Authorization(this.access,this.options.cloud!==false?{ownerAccounts:'cloud-commit'}:undefined):null;
    for(const action of automation.actions){if(action.type==='set_property'){const key=text(get(action,'property_id',''),'속성 ID',100),changes={properties:Object.fromEntries([[key,get(action,'value')]])};authority?.prepare('PATCH','/api/databases/'+automation.database_id+'/rows/'+rowId,changes);row=this.workspace.update_row(automation.database_id,rowId,changes);results.push({type:action.type,row_id:rowId});}
      else if(action.type==='create_row'){const changes={properties:get(action,'values',{})};authority?.prepare('POST','/api/databases/'+automation.database_id+'/rows',changes);results.push(this.workspace.create_row(automation.database_id,changes));}
      else{const changes={title:text(get(action,'title',''),'페이지 제목',500)};authority?.prepare('POST','/api/pages',changes);results.push(this.workspace.create_page(changes));}}
    this.audit('automation.executed',{id:identity,row_id:rowId,actions:results.length});return {results,executed_at:this.now()};
  }
  update_settings(body:Entity):Entity{
    const allowed=new Set(['name','disable_guests','disable_public_sharing','disable_export','trash_retention_days','transcript_retention_days','saml_metadata_url','saml_entity_id','custom_domain']);check(Object.keys(body).every(key=>allowed.has(key)),'지원하지 않는 설정입니다');for(const key of ['disable_guests','disable_public_sharing','disable_export'])if(has(body,key))check(typeof body[key]==='boolean','보안 설정에는 참·거짓 값이 필요합니다');for(const key of ['trash_retention_days','transcript_retention_days'])if(has(body,key))check(Number.isInteger(body[key])&&typeof body[key]==='number'&&body[key]>=1&&body[key]<=3650,'보존 기간은 1~3650일입니다');
    if(truth(body.saml_metadata_url)){let scheme='';try{scheme=new URL(body.saml_metadata_url).protocol;}catch{}check(typeof body.saml_metadata_url==='string'&&scheme==='https:','HTTPS 메타데이터 URL이 필요합니다');}
    const data={...this.settings(),...clone(body)};this.store.put('settings',data);this.audit('settings.updated',{fields:Object.keys(body)});return data;
  }
  analytics():Entity{
    const events=this.store.list('audit'),counts:Entity={},pages:Entity={},days:Entity={};for(const event of events){const action=get(event,'action',''),date=get(event,'created_at','').slice(0,10);put_key(counts,action,get(counts,action,0)+1);put_key(days,date,get(days,date,0)+1);const details=get(event,'details',{});if(is_object(details)&&truth(get(details,'page_id')))put_key(pages,details.page_id,get(pages,details.page_id,0)+1);}
    return {events:events.length,actions:counts,pages,daily:days,members:this.store.list('member').length,page_count:this.store.list('page').filter(page=>!truth(get(page,'archived'))).length,rows:this.store.list('row').length};
  }
  cleanup():Entity{
    const settings=this.settings(),timestamp=(this.options.clock??(()=>this.store.requestTime?Date.parse(this.store.requestTime):Date.now()))(),removed:Entity={pages:0,transcripts:0};
    for(const [kind,ageKey,key] of [['page','trash_retention_days','deleted_at'],['transcript','transcript_retention_days','created_at']])for(const item of this.store.list(kind)){
      if(kind==='page'&&!truth(get(item,'archived')))continue;const date=get(item,key),parsed=typeof date==='string'?Date.parse(date):NaN,expired=timestamp-parsed>get(settings,ageKey,30)*86400000;
      if(expired){this.store.delete(kind,item.id);if(kind==='page'){this.store.delete('collaboration',item.id);for(const childKind of ['version','comment'])for(const child of this.store.list(childKind))if(child.page_id===item.id)this.store.delete(childKind,child.id);}removed[kind==='page'?'pages':'transcripts']++;}}
    this.audit('retention.executed',removed);return removed;
  }
  prepare_ai(body:Entity):PreparedAI{
    check(is_object(body),'JSON 객체가 필요합니다');check((this.env.FOUNTAIN_AI_PROVIDER||'compatible-http')==='compatible-http','지원하지 않는 AI 공급자입니다. 로컬 모델 또는 호환 HTTP API를 설정해 주세요.',503);
    check(this.options.cloud===false||!!this.env.FOUNTAIN_AI_URL,'클라우드 AI에 사용할 FOUNTAIN_AI_URL을 설정해 주세요.',503);
    const key=this.env.FOUNTAIN_AI_KEY,endpoint=this.env.FOUNTAIN_AI_URL||'https://api.openai.com/v1/chat/completions';check(key||this.local_ai(),'AI가 설정되지 않았습니다. 무료 로컬 모델의 FOUNTAIN_AI_URL과 FOUNTAIN_AI_MODEL을 설정해 주세요.',503);const model=this.env.FOUNTAIN_AI_MODEL;check(model,'FOUNTAIN_AI_MODEL에 사용할 모델 이름을 설정해 주세요.',503);
    const action=get(body,'action','answer'),instructions:Entity={summarize:'주어진 문서를 한국어로 간결하게 요약하세요.',write:'사용자 요청에 맞춰 문서를 작성하세요.',translate:'사용자가 요청한 언어로 번역하세요.',answer:'주어진 문맥으로 답하고 근거 없는 주장을 하지 마세요.',meeting:'회의 대화록을 결정 사항, 담당자와 후속 작업으로 정리하세요.',autofill:'요청한 데이터베이스 속성 값을 제안하세요.'};check(typeof action==='string'&&has(instructions,action),'지원하지 않는 AI 작업입니다');const prompt=text(get(body,'prompt',''),'프롬프트',50000),pageId=get(body,'page_id');let context='';if(this.access)check(this.access.active&&this.access.regular,'AI access requires a workspace member',403);if(truth(pageId)){const page=this.access?this.access.require_resource('page',pageId):this.item('page',pageId);check(!truth(get(page,'archived')),'삭제된 페이지입니다',404);context=get(page,'title','')+'\n'+get(page,'blocks',[]).map((block:Entity)=>get(block,'text','')).join('\n');}
    let url:URL;try{url=new URL(endpoint);}catch{throw new AdvancedError('AI 공급자 연결에는 HTTPS가 필요합니다',503);}check((url.protocol==='https:'||this.local_ai())&&!url.username&&!url.password,'AI 공급자 연결에는 HTTPS가 필요합니다',503);return {action,prompt,context,page_id:pageId,model,instructions:instructions[action],endpoint,key};
  }
  finish_ai(prepared:PreparedAI,result:Entity):Entity{if(truth(prepared.page_id))check(!truth(get(this.item('page',prepared.page_id),'archived')),'삭제된 페이지입니다',404);this.audit('ai.executed',{action:prepared.action,page_id:prepared.page_id});return result;}
  remove_access_references(kind:string,identity:string):void{
    const field=kind==='member'?'members':'groups';
    for(const entityKind of ['page','database','row','teamspace','group'])for(const item of this.store.list(entityKind)){
      let changed=false;const grants=get(get(item,'permissions',{})||{},field,{});if(is_object(grants)&&has(grants,identity)){delete grants[identity];changed=true;}
      if(['teamspace','group'].includes(entityKind)&&Array.isArray(item[field])&&item[field].includes(identity)){item[field]=item[field].filter((value:string)=>value!==identity);changed=true;}if(changed)this.store.put(entityKind,item);
    }
  }
  clipboard(body:Entity):Entity{
    let blocks=get(body,'blocks',[]);check(Array.isArray(blocks)&&blocks.length<=1000,'블록 목록이 필요합니다');blocks=normalize_blocks(blocks,()=>this.id('clipboard'));const plain=[];for(const block of blocks){check(is_object(block)&&typeof get(block,'text','')==='string','블록 형식이 잘못되었습니다');const value=get(block,'text','');check(Array.from(value).length<=100000,'블록이 너무 큽니다');plain.push(value);}
    const identity=this.id('clipboard');this.store.put('clipboard',{id:identity,owner_id:this.actor,blocks});for(const entry of this.store.list('clipboard').slice(0,-20))this.store.delete('clipboard',entry.id);return {id:identity,text:plain.join('\n'),html:blocks_html(blocks)+'<!-- fountain-copy: '+identity+' -->'};
  }
  scim(method:string,path:string,body:Entity,query:URLSearchParams|Entity):DomainResult{return scim_resource(this,method,path,body,query);}
  public_view(path:string):DomainResult|null{return render_public(this,path);}
  dispatch(method:string,path:string,body:Entity,query:URLSearchParams|Entity):DomainResult|null{
    const result=(payload:any,status=200)=>({status,payload});
    if(method==='GET'&&(path.startsWith('/sites/')||path.startsWith('/forms/')))return this.public_view(path);
    if(path.startsWith('/scim/v2/'))return this.scim(method,path,body,query);
    if(path==='/api/advanced'&&method==='GET')return result(this.overview());if(path==='/api/capabilities'&&method==='GET')return result(this.capabilities());if(path==='/api/settings'&&['PATCH','PUT'].includes(method))return result(this.update_settings(body));if(path==='/api/analytics'&&method==='GET')return result(this.analytics());if(path==='/api/retention/run'&&method==='POST')return result(this.cleanup());
    if(path==='/api/clipboard'&&method==='POST')return result(this.clipboard(body));if(path.startsWith('/api/clipboard/')&&method==='GET')return result(this.item('clipboard',path.split('/').at(-1)));
    if(path==='/api/audit'&&method==='GET'){const q=query instanceof URLSearchParams?query.get('q')||'':get(query,'q',[''])[0],search=casefold(q);return result({events:this.store.list('audit').filter(event=>casefold(pythonJSON(event)).includes(search))});}
    const parts=path.replace(/^\/+|\/+$/g,'').split('/');
    if(parts.length===4&&parts[0]==='api'&&parts[1]==='automations'&&parts[3]==='runs'&&method==='GET'){this.item('automations',parts[2]);return result({runs:this.store.list('automation_run').filter(record=>record.automation_id===parts[2]).sort((a,b)=>String(b.started_at||'').localeCompare(String(a.started_at||''))).slice(0,200).map(({result,...record})=>record)});}
    if(parts.length===4&&parts[0]==='api'&&parts[1]==='pages'&&parts[3]==='verify'){
      const page=this.item('page',parts[2]);if(method==='POST'){const owner=get(body,'owner','local');check(this.store.get('member',owner),'검증 담당자가 없습니다',404);const expiry=get(body,'expires_at');if(truth(expiry)){try{const parsed=scheduleDatetime(expiry,'expires_at');check(parsed>BigInt(Math.floor((this.options.clock??Date.now)()))*1000n,'검증 만료일은 시간대가 있는 미래 시각이어야 합니다');}catch(error){if(error instanceof AdvancedError)throw error;throw new AdvancedError('검증 만료일 형식이 잘못되었습니다');}}page.verification={owner,verified_by:this.actor,verified_at:this.now(),expires_at:expiry};}else if(method==='DELETE')delete page.verification;else return null;this.store.put('page',page);this.audit('page.verification.updated',{page_id:page.id});return result(page);
    }
    if(parts.length>=2&&parts[0]==='api'&&this.collections.has(parts[1])){
      const kind=parts[1],identity=parts.length>2?parts[2]:null;if(parts.length===4&&method==='POST'){if(kind==='forms'&&parts[3]==='submit')return result(this.submit_form(identity,body),201);if(kind==='automations'&&parts[3]==='run')return result(this.run_automation(identity,body));return null;}
      if(method==='GET')return result(truth(identity)?this.item(kind,identity):{[kind]:this.store.list(kind.slice(0,-1))});if(method==='POST'&&identity===null)return result(this.save(kind,body),201);if(method==='PATCH'&&truth(identity))return result(this.save(kind,body,identity));if(method==='DELETE'&&truth(identity)){this.item(kind,identity);this.store.delete(kind.slice(0,-1),identity);this.audit(kind+'.deleted',{id:identity});return result({deleted:true});}
    }return null;
  }
}

/** Call outside staging. The caller must reauthenticate the original binding and
 * current page access before finish_ai; never serialize PreparedAI to a client. */
export async function infer_ai(prepared:PreparedAI,request:typeof fetch=fetch):Promise<Entity>{
  try{const endpoint=new URL(prepared.endpoint);check(!endpoint.username&&!endpoint.password&&(endpoint.protocol==='https:'||endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)),'AI 공급자 연결에는 HTTPS가 필요합니다',502);const response=await request(prepared.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{'Content-Type':'application/json',...(prepared.key?{Authorization:'Bearer '+prepared.key}:{})},body:JSON.stringify({model:prepared.model,messages:[{role:'system',content:prepared.instructions},{role:'user',content:prepared.prompt+'\n\n문서:\n'+prepared.context}]})});if(!response.ok||response.redirected){await response.body?.cancel();throw new AdvancedError('AI 공급자가 응답하지 않았거나 올바르지 않은 응답을 반환했습니다',502);}const reader=response.body?.getReader();check(reader!==undefined,'AI 응답 형식이 잘못되었습니다',502);const chunks=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;check(length<=2000000,'AI 응답 형식이 잘못되었습니다',502);chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)),output=value?.choices?.[0]?.message?.content;check(typeof output==='string','AI 응답 형식이 잘못되었습니다',502);return {text:output,provider:new URL(prepared.endpoint).hostname,model:prepared.model,citations:prepared.context?[{page_id:prepared.page_id}]:[]};}
  catch{throw new AdvancedError('AI 공급자가 응답하지 않았거나 올바르지 않은 응답을 반환했습니다',502);}
}
export function createAdvancedExtension(options:AdvancedOptions={}):DomainExtension{return (r:DomainRequest)=>{
  // Pure SCIM helpers exist, but the cloud bearer/service authority is a distinct
  // boundary that must be installed explicitly. A cookie login cannot replace it.
  if(r.path.startsWith('/scim/v2/'))return null;
  const advanced=new Advanced(r.store,r.workspace,{...options,access:r.access,actor:r.access.member_id});
  const rowRoute=r.parts[0]==='api'&&r.parts[1]==='databases'&&r.parts[3]==='rows';
  const event=r.method==='POST'&&(r.parts.length===4||r.parts.length===6&&r.parts[5]==='duplicate')?'row.created':r.method==='PATCH'&&r.parts.length===5?'row.updated':null;
  if(rowRoute&&event){const result=coreRoute(r);if(!result)return null;const rows=Array.isArray(result.payload.rows)?result.payload.rows:[result.payload];for(const row of rows)advanced.trigger(event,r.parts[2],row);return {...result,payload:Array.isArray(result.payload.rows)?{...result.payload,rows:rows.map(row=>r.store.get('row',row.id))}:r.store.get('row',result.payload.id)};}
  const result=advanced.dispatch(r.method,r.path,r.body,r.query);
  if(result&&r.method==='DELETE'&&r.parts.length===3&&r.parts[0]==='api'&&['members','groups'].includes(r.parts[1]))advanced.remove_access_references(r.parts[1]==='members'?'member':'group',r.parts[2]);
  return result;
};}

const FEATURE_ROWS:string[][]=[["pages","블록 문서와 중첩 페이지","Plus","implemented","페이지·문자 서식·중첩 블록·검색·휴지통·파일"],["attachments","대용량 첨부","Plus","implemented","파일당 5GB 청크 업로드·이어 올리기·구간 다운로드·전체 백업"],["collaboration","문서 실시간 공동 편집","Plus","implemented","문자·서식 병합, 원격 커서·선택, 내 작업 실행 취소·다시 실행과 권한 검사"],["history","페이지 버전 복원","Plus","implemented","저장한 문서 버전 복원; 보존 기한 제한 없음"],["databases","데이터베이스와 보기","Plus","implemented","속성·테이블·보드·달력·차트·목록·타임라인·하위 작업·의존관계"],["forms","사용자 지정 양식과 조건부 질문","Business","implemented","조건에 맞는 질문 검증 후 데이터베이스 행 생성"],["automations","데이터베이스 자동화","Plus","implemented","행 변경·수동·시간대별 반복 예약; 실행 기록·중복 방지·실패 롤백"],["sites","사이트 게시와 메타데이터","Plus","implemented","게시한 페이지의 공개 HTML; SEO 제목·설명"],["domains","사용자 지정 도메인","Plus","configuration","호스트명 설정; 실제 DNS·TLS는 운영자 설정 필요"],["teamspaces","비공개 팀스페이스와 그룹","Business","implemented","멤버 계정·비공개 공간·그룹 기반 접근 권한"],["permissions","세분화된 페이지·행 권한","Business","implemented","서버에서 페이지·담당 행 권한 적용; 관계·롤업 결과도 제한"],["ai","AI 생성·요약·번역·질의","Business","provider_required","무료 로컬 모델 또는 호환 API 연동; 모의 응답 없음"],["meeting","AI 회의록","Business","partial","입력한 대화록 요약; 음성 전사는 미연동"],["search","기업 검색","Business","partial","권한에 따른 페이지·DB·행 통합 검색과 필터; 연결 앱·AI 검색 미연동"],["verification","페이지 검증","Business","implemented","담당자·검증 만료일 저장"],["saml","SAML SSO","Business","configuration","IdP 메타데이터 설정; 서명 검증 로그인 흐름 미구현"],["scim","SCIM 사용자·그룹 프로비저닝","Enterprise","implemented","SCIM 2.0 Users/Groups; FOUNTAIN_SCIM_TOKEN 필수"],["audit","감사 로그와 CSV 내보내기","Enterprise","implemented","서버 변경 기록·검색·CSV; 외부 SIEM 미연동"],["analytics","워크스페이스 분석","Enterprise","implemented","실제 조회·편집 이벤트 집계"],["security","공유 제한·게스트·보존 정책","Enterprise","implemented","소유자·멤버 관리자 분리와 게스트·게시·내보내기 제한"],["retention","데이터 보존 정책","Enterprise","implemented","만료 휴지통·회의 대화록 수동 정리"],["integrations","연결 앱·SIEM·DLP","Enterprise","configuration","연결 설정 저장; 공급자 OAuth·동기화 미연동"],["agents","사용자 지정 AI 에이전트","Business","provider_required","정해진 문서 작업 실행; 자율 외부 도구 실행 미지원"],["offline","오프라인","Plus","partial","문서·DB 행·새 페이지·메타데이터 기기 보관과 재접속 병합·충돌 복구; DB 구조·권한·첨부는 연결 필요"],["zero_retention","AI 공급자 데이터 무보존","Enterprise","provider_required","사용하는 공급자 계약과 배포 설정으로 보장해야 함"],["support","전담 고객 성공·프리미엄 지원","Enterprise","service_required","소프트웨어로 제공할 수 없는 인적 서비스"]];
