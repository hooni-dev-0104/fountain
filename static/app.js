'use strict';
// Connection codes live only in this tab, never in cache or persistent settings.
let setupCodeFromLink=null;
if(/^#setup=[A-Za-z0-9_-]{43}$/.test(location.hash)){
  setupCodeFromLink=location.hash.slice(7);
  history.replaceState(null,'',location.pathname+location.search+'#home');
}
// A public-page login return is a local path, held only for this tab's login.
let publicReturnPath=null;
if(location.hash.startsWith('#open-public=')){
  const encoded=location.hash.slice(13);
  try{
    const path=decodeURIComponent(encoded);
    if(!FountainTransport.native&&location.origin!=='https://fountain.desktop.invalid'&&/^\/(forms|sites)\/[A-Za-z0-9_-]{1,160}$/.test(path)&&encodeURIComponent(path)===encoded)publicReturnPath=path;
  }catch{ /* Malformed return links never become navigation targets. */ }
  history.replaceState(null,'',location.pathname+location.search+'#home');
}
const logoutPendingKey=()=>FountainTransport.native?'fountain-logout-pending:'+encodeURIComponent(FountainTransport.origin):'fountain-logout-pending';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ( {
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}
[c]));
const uid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const icons = {
  home:'<path d="m3 9 6-5 6 5v7H4V9m3 7v-5h5v5"/>',search:'<circle cx="8" cy="8" r="5"/><path d="m12 12 4 4"/>',inbox:'<path d="M3 4h12v12H3zM3 11h4l1 2h2l1-2h4"/>',spark:'<path d="m9 2 1.8 5.2L16 9l-5.2 1.8L9 16l-1.8-5.2L2 9l5.2-1.8z"/>',chevron:'<path d="m7 5 4 4-4 4"/>',down:'<path d="m5 7 4 4 4-4"/>',plus:'<path d="M9 3v12M3 9h12"/>',clock:'<circle cx="9" cy="9" r="6"/><path d="M9 5v4l3 2"/>',grid:'<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="11" y="3" width="5" height="5" rx="1"/><rect x="3" y="11" width="5" height="5" rx="1"/><rect x="11" y="11" width="5" height="5" rx="1"/>',table:'<rect x="2" y="3" width="14" height="12" rx="1"/><path d="M2 7h14M7 7v8"/>',board:'<rect x="2" y="3" width="4" height="10" rx="1"/><rect x="7" y="3" width="4" height="7" rx="1"/><rect x="12" y="3" width="4" height="12" rx="1"/>',calendar:'<rect x="3" y="4" width="12" height="12" rx="2"/><path d="M6 2v4m6-4v4M3 8h12"/>',chart:'<path d="M3 3v12h13M6 12V8m4 4V4m4 8V6"/>',star:'<path d="m9 2 2.1 4.3 4.7.7-3.4 3.3.8 4.7L9 12.8 4.8 15l.8-4.7L2.2 7l4.7-.7z"/>',settings:'<path d="m7 2-1 2-2 .5v3L2 9l2 1.5v3l2 .5 1 2h4l1-2 2-.5v-3L16 9l-2-1.5v-3L12 4l-1-2z"/><circle cx="9" cy="9" r="2.5"/>',trash:'<path d="M3 5h12M6 5V3h6v2M5 5l1 11h6l1-11M8 8v5m2-5v5"/>',arrow:'<path d="M3 9h12m-4-4 4 4-4 4"/>',share:'<path d="M9 11V2m-3 3 3-3 3 3M5 8H3v8h12V8h-2"/>',dots:'<circle cx="4" cy="9" r=".6"/><circle cx="9" cy="9" r=".6"/><circle cx="14" cy="9" r=".6"/>',filter:'<path d="M3 4h12M5 9h8M7 14h4"/>',menu:'<path d="M3 4h12M3 9h12M3 14h12"/>',people:'<circle cx="7" cy="6" r="3"/><path d="M2 16v-2a5 5 0 0 1 10 0v2m1-13a3 3 0 0 1 0 6m1 3a4 4 0 0 1 3 4"/>',lock:'<rect x="4" y="8" width="10" height="8" rx="1"/><path d="M6 8V5a3 3 0 0 1 6 0v3"/>',link:'<path d="m7 11 4-4M7 6l2-2a4 4 0 0 1 5 5l-2 2M6 7 4 9a4 4 0 0 0 5 5l2-2"/>',check:'<path d="m4 9 3 3 7-8"/>'
};
const icon = name => `<svg viewBox="0 0 18 18" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const state = {
  collapsedRows:new Set(),timelineProperty:null,timelineZoom:'day',timelineBounds:null,timelineFocusDay:null,channel:null,offline:false,offlineProfile:null,session:null,workspace:null, route:'home',page:null,blocks:[],versions:[],comments:[],database:null,rows:[],view:'table',filter:'',sort:false,saving:null,saveTimer:null,advanced:null,settingsTab:'members',loaded:false,activeBlock:null,trash:false,dirty:false,editSequence:0
};
function unsubmittedNativeForms(){
  const forms=[];
  for(const form of $$('#row-form,#comment-form,#property-form,#owner-settings-form')){
    const fields=[];
    for(const control of [...form.elements]){
      if(!(control.name||control.dataset.recoveryField)||control.disabled||control.readOnly||['password','file','submit','button'].includes(control.type))continue;
      let value,original;
      if(control.type==='checkbox'||control.type==='radio'){value=control.checked;original=control.defaultChecked;}
      else if(control.tagName==='SELECT'){value=[...control.selectedOptions].map(option=>option.value);original=[...control.options].filter(option=>option.defaultSelected).map(option=>option.value);if(!control.multiple&&!original.length&&control.options.length)original=[control.options[0].value];}
      else{value=control.value;original=control.defaultValue;}
      if(JSON.stringify(value)!==JSON.stringify(original))fields.push({name:control.name||control.dataset.recoveryField,value});
    }
    if(fields.length)forms.push({kind:form.id==='row-form'?'row':form.id==='comment-form'?'comment':'database-properties',fields});
  }
  return forms;
}
function rememberNativeInput(profile,lastEdits){if(!profile||!lastEdits)return;state.authRecoveryMemory||=new Map();const recoveryId=uid();state.authRecoveryMemory.set(recoveryId,{profile:structuredClone(profile),lastEdits:structuredClone(lastEdits),recoveryId});}
// Reconciliation freezes producers synchronously. It never waits for the POST or local
// persistence promise that may have entered this barrier in the first place.
window.addEventListener('fountain-native-outbox-pause',event=>{
  const detail=event.detail;if(!FountainTransport.native||!FountainTransport.outboxEnabled||!detail?.owner||!detail.token)return;
  detail.waitUntil(Promise.resolve({owner:detail.owner,token:detail.token}));
  if(state.nativeOutboxResuming&&state.nativeOutboxPause?.scopeEpoch===detail.scopeEpoch&&state.nativeOutboxPause?.generation===detail.generation)return;
  const previous=state.nativeOutboxPause;
  const navigation=state.nativeNavigation?.opening?state.nativeNavigation:null;
  const paused={...detail,navigation,channel:state.channel,loaded:state.loaded,profile:state.offlineProfile,saveScheduled:!!state.saveTimer,titleScheduled:!!state.titleTimer,route:state.route,id:navigation?.id||(state.route==='page'?state.page?.id:state.database?.id),dom:[],input:null,forms:unsubmittedNativeForms(),resourceKind:navigation?.route==='database'?'database':state.route==='page'?'page':state.database?.id?'database':null,focus:document.activeElement,selection:state.route==='page'?selectedTextPosition():null};
  try{if(state.loaded)paused.input=authenticationInput(state.offlineProfile);}catch{ /* Keep the live DOM when it cannot yet be represented as a bounded draft. */ }
  if(previous?.channel)previous.channel.resumeNetwork?.(previous.owner+':'+previous.token);
  state.nativeOutboxPause=paused;if(state.verifiedPages||state.adminConsole)closeModal();clearVerifiedPages();clearAdminConsole();clearDatabaseVerification();clearDatabasePropertyView();clearInbox();clearWikiMutation();clearWikiPage();clearTimeout(state.saveTimer);clearTimeout(state.titleTimer);
  state.channel?.pauseNetwork?.(detail.owner+':'+detail.token);
  state.presenceManager?.pause({leave:false});
  for(const node of [$('#main'),$('#sidebar'),$('#topbar'),$('#overlay-root')].filter(Boolean)){paused.dom.push({node,inert:previous?.dom.find(item=>item.node===node)?.inert??node.inert});node.inert=true;}
});
function nativeOutboxBlockedNotice(){
  const status=$('#save-status');if(status)status.textContent='기기 기록 확인 필요 · 원본 보관됨';
  if(!document.querySelector('.native-outbox-blocked')){const action=document.createElement('button');action.className='solid-btn native-outbox-blocked';action.textContent='보관된 기록 확인하고 계속';action.addEventListener('click',()=>FountainNativeRecovery.open());document.body.append(action);}
}
function clearNativeLogoutView(){
  state.bootGeneration=(state.bootGeneration||0)+1;closeDocument();closeMutations();closeModal();state.page=null;state.blocks=[];state.database=null;state.rows=[];state.loaded=false;state.offlineProfile=null;
  $('#main').innerHTML='<div class="loading">로그아웃을 마무리하고 있습니다…</div>';$('#sidebar').replaceChildren();$('#topbar').replaceChildren();
}
window.addEventListener('fountain-native-anonymous-session',event=>{
  const detail=event.detail;if(!FountainTransport.native||!FountainTransport.outboxEnabled||detail?.origin!==FountainTransport.origin||detail.generation!==FountainTransport.generation||detail.scopeEpoch!==FountainTransport.scopeEpoch||detail.session?.authenticated!==false||FountainNativeStorage?.ready!==false||!['unknown','blocked'].includes(FountainNativeStorage.identityState))return;
  if(!state.loaded&&!state.nativeOutboxPause&&state.session?.authenticated===false&&$('#login-form')){
    state.session={...state.session,...detail.session,mode:detail.session.mode||state.session.mode,authenticated:false,member:null,identity:null,cache_binding:null};return;
  }
  const paused=state.nativeOutboxPause,profile=state.offlineProfile||paused?.profile;let input=paused?.input;
  try{input=authenticationInput(profile)||input;}catch{/* The paused RAM input remains available. */}
  const forms=unsubmittedNativeForms();if(profile&&(input||forms.length))rememberNativeInput(profile,{...(input||{}),...(forms.length?{formInput:forms}:{})});
  const mode=detail.session.mode||state.session?.mode||'accounts';clearNativeLogoutView();state.session={...detail.session,mode,authenticated:false,member:null,identity:null,cache_binding:null};state.nativeOutboxPause=null;
  for(const node of [$('#main'),$('#sidebar'),$('#topbar'),$('#overlay-root')].filter(Boolean))node.inert=false;
  document.querySelector('.native-outbox-blocked')?.remove();renderLogin(false);
});
window.addEventListener('fountain-native-outbox-resume',event=>{
  const detail=event.detail,paused=state.nativeOutboxPause;if(!paused||state.nativeOutboxResuming||detail.owner!==paused.owner||detail.token!==paused.token)return;
  const current=()=>state.nativeOutboxPause===paused&&FountainTransport.origin===paused.origin&&FountainTransport.generation===paused.generation&&FountainTransport.scopeEpoch===paused.scopeEpoch;
  const resume=async()=>{
    const resuming={owner:paused.owner,token:paused.token};state.nativeOutboxResuming=resuming;
    try{
      if(!current()||detail.blocked){if(current())nativeOutboxBlockedNotice();return;}
      if(detail.terminal===true&&FountainNativeStorage?.identityState==='blocked'){
        // The exact own-profile erase was acknowledged. Its blocked header is a
        // terminal logout boundary, not permission to read the erased cache.
        clearNativeLogoutView();
      }else if(paused.loaded&&detail.reconciled){
        const fresh=await detail.readCurrent?.(paused.id&&paused.resourceKind?{kind:paused.resourceKind,id:paused.id}:null);if(!current())return;
        const same=fresh?.profile?.id===paused.profile?.id;
        const snapshot=fresh?.snapshot;
        const navigating=paused.navigation&&state.nativeNavigation===paused.navigation&&paused.navigation.binding===state.session?.cache_binding&&paused.navigation.generation===state.bootGeneration;
        // During navigation the old DOM is still mounted, but the new page has no
        // channel yet. Its protected HTTP reply will initialize the new view.
        const openingPage=navigating&&paused.route==='page'&&!paused.channel?.base;
        const safePage=paused.route!=='page'||!detail.summary?.counts?.quarantine&&same&&(openingPage||snapshot&&snapshot.epoch===paused.channel?.base.epoch&&snapshot.access_level>=3&&!snapshot.page?.locked&&!snapshot.page?.archived);
        const unsafeDatabase=!navigating&&paused.resourceKind==='database'&&paused.id&&(!snapshot||FountainCollaboration.canonical({database:state.database,rows:state.rows})!==FountainCollaboration.canonical({database:snapshot.database,rows:snapshot.rows||[]})||detail.summary?.counts?.quarantine>0);
        if(!same||!safePage||unsafeDatabase||detail.preservedInput||paused.profile?.session?.member?.role!==fresh?.profile?.session?.member?.role){
          const forms=unsubmittedNativeForms();if(paused.profile&&(paused.input||forms.length))rememberNativeInput(paused.profile,{...(paused.input||{}),...(forms.length?{formInput:forms}:{})});
          // Detached DOM retains unfinished form/composition input in RAM without exposing
          // an old private row or document through the newly authorized active view.
          state.nativeOutboxDOMArchive||=new Map();const archive=document.createDocumentFragment();while($('#main').firstChild)archive.append($('#main').firstChild);state.nativeOutboxDOMArchive.set(paused.profile?.id+'|'+paused.route+'|'+paused.id,archive);
          state.bootGeneration=(state.bootGeneration||0)+1;closeDocument();closeMutations();closeModal();state.page=null;state.blocks=[];state.database=null;state.rows=[];state.dirty=false;state.composition=null;
          state.offlineProfile=fresh?.profile||null;state.session=fresh?.profile?.session||state.session;state.serverWorkspace=fresh?.profile?.workspace||null;state.workspace=fresh?.profile?.workspace||null;state.loaded=false;
          $('#main').innerHTML='<div class="empty"><h2>기기 기록을 다시 확인했습니다.</h2><p>이전 입력은 보관했습니다. 최신 문서를 다시 열어 계속하세요.</p><button class="outline-btn" data-action="reload">최신 문서 열기</button></div>';$('#sidebar').replaceChildren();$('#topbar').replaceChildren();
          const resumeGeneration=state.bootGeneration;setTimeout(()=>{if(!state.loaded&&!state.nativeOutboxPause&&!state.nativeRecoveryPaused&&state.bootGeneration===resumeGeneration&&FountainTransport.scopeEpoch===paused.scopeEpoch)boot();},0);
        }else{
          state.offlineProfile=fresh.profile;state.session=fresh.profile.session;state.serverWorkspace=fresh.profile.workspace;state.workspace=fresh.profile.workspace;renderSidebar();
          // Capture composition/DOM input before the initiating response is allowed to paint.
          // Existing channel persistence is deliberately not awaited here.
          if(!navigating&&!state.composition&&state.channel===paused.channel){state.nativeOutboxPause=null;reconcileEditor();state.nativeOutboxPause=paused;}
          if(snapshot&&paused.route==='database'){state.database=snapshot.database;state.rows=snapshot.rows||[];if(!$('.modal'))renderDatabase();}
          if(!navigating&&paused.route==='page'&&snapshot&&paused.channel&&state.channel===paused.channel)setTimeout(()=>{if(state.channel===paused.channel&&!state.nativeOutboxPause)paused.channel.receive(snapshot,'native-reconcile').catch(error=>toast(error.message));},0);
        }
      }
      if(!current())return;state.nativeOutboxPause=null;document.querySelector('.native-outbox-blocked')?.remove();for(const item of paused.dom)if(item.node.isConnected)item.node.inert=item.inert;
      if(paused.focus?.isConnected&&!state.composition&&!document.activeElement?.closest?.('.native-recovery-dialog')){paused.focus.focus?.({preventScroll:true});if(paused.selection&&state.channel===paused.channel)restoreTextPosition(paused.selection);}
      paused.channel?.resumeNetwork?.(paused.owner+':'+paused.token);
      const channel=state.channel,profile=paused.profile,binding=profile?.session?.cache_binding;
      if(state.loaded&&state.route==='page'&&channel&&channel===paused.channel&&!channel.closed&&state.page?.id===paused.id&&channel.pageId===paused.id&&typeof profile?.id==='string'&&profile.id&&typeof binding==='string'&&binding&&state.offlineProfile?.id===profile.id&&channel.profile?.id===profile.id&&state.session?.cache_binding===binding&&['synced','pending','offline','error','waiting'].includes(channel.status)&&!(channel.status==='synced'&&channel.durable===false)){
        documentStatus({status:channel.status,pending:channel.pending.size,durable:channel.durable!==false});
      }
      if(state.loaded&&!state.nativeRecoveryPaused){if((paused.titleScheduled||detail.reconciled)&&state.titlePending&&!state.titleSaving)state.titleTimer=setTimeout(()=>saveTitle().catch(error=>toast(error.message)),450);if(paused.saveScheduled&&state.channel&&!state.composition)scheduleSave();if(detail.reconciled)ensurePresence();}
    }catch(error){if(current())nativeOutboxBlockedNotice();throw error;}finally{if(state.nativeOutboxResuming===resuming)state.nativeOutboxResuming=null;}
  };
  detail.waitUntil(resume());
});
window.addEventListener('fountain-native-outbox-ready',()=>{document.querySelector('.native-outbox-blocked')?.remove();if(state.nativeRecoveryPaused||state.nativeOutboxPause){for(const node of [$('#main'),$('#sidebar'),$('#topbar'),$('#overlay-root')].filter(Boolean))node.inert=false;state.nativeRecoveryPaused=false;state.nativeOutboxPause=null;boot();}});
// SCIM credentials belong to this settings view only. Never add them to state or caches.
let scimPanel=null;
let searchView=null,searchNavigation=0;
function clearSearch(){const view=searchView;searchView=null;if(!view)return;view.closed=true;clearTimeout(view.timer);view.probe.abort();view.request?.abort();view.results.replaceChildren();view.input.value='';}
function clearScimPanel(){const panel=scimPanel;scimPanel=null;for(const input of $$('#scim-secret,#scim-proof'))input.value='';panel?.close();}
// BEGIN SCIM VIEW MODEL — response secrets remain inside this disposable closure.
function scimGrantStatus(grant,now=Date.now()) {
  if(!grant.enabled&&grant.version>1)return '철회됨';
  if(grant.expires_at&&Date.parse(grant.expires_at)<=now)return '만료됨';
  if(grant.enabled)return '활성';
  if(grant.version===1&&grant.pending_until)return Date.parse(grant.pending_until)>now?'활성화 대기':'활성화 기한 만료';
  return '비활성';
}
function createScimView({request,current,changed,newId,now=Date.now,disposed=()=>{}}) {
  let closed=false,busy=false,secret=null,tokens=[],cursor=null,creation=null,selected=null,error='',available=false,confirmation=null;
  const live=()=>!closed&&current();
  const update=()=>{if(live())changed();else close();};
  function close(){if(closed)return;closed=true;secret=null;creation=null;selected=null;confirmation=null;tokens=[];cursor=null;disposed();}
  const metadata=value=>{const {id,purpose,version,enabled,issuer_member_id,created_at,expires_at,pending_until}=value;return {id,purpose,version,enabled,issuer_member_id,created_at,expires_at,pending_until};};
  function snapshot(){return {busy,tokens:tokens.map(metadata),cursor,creation:creation?{...creation}:null,selected:selected?metadata(selected):null,error,available,confirmation,hasSecret:!!secret};}
  function merge(grant){grant=metadata(grant);tokens=[grant,...tokens.filter(item=>item.id!==grant.id)];selected=grant;}
  async function run(operation){if(!live()||busy)return;busy=true;error='';update();try{await operation();}catch(e){if(live())error=e.code==='STALE_REQUEST'?'로그인 상태가 변경되었습니다.':(!e.status||e.status>=500)?'응답을 확인하지 못했습니다. 같은 요청을 다시 시도하거나 목록에서 현재 상태를 확인하세요.':'요청하지 못했습니다. 최신 목록과 권한·만료 시각을 확인하세요.';}finally{busy=false;update();}}
  async function load(more=false){return run(async()=>{
    try{const result=await request('/scim/tokens?limit=50'+(more&&cursor?'&cursor='+encodeURIComponent(cursor):''));if(!live())return;
      const items=result.tokens.map(metadata);tokens=more?[...tokens,...items.filter(item=>!tokens.some(old=>old.id===item.id))]:items;cursor=result.next_cursor;available=true;
    }catch(e){if(!live())return;if([404,405,501,503].includes(e.status)){available=false;error='현재 서버에서 SCIM 토큰 관리를 사용할 수 없습니다. Supabase 백엔드 연결과 서버 설정을 확인하세요.';}else throw e;}
  });}
  async function issue(expiresAt=null){return run(async()=>{
    if(!available||selected)return;
    if(!creation){if(expiresAt&&(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now())){error='미래의 만료 시각을 입력하세요.';return;}creation={transaction_id:newId(),expires_at:expiresAt};}
    // A lost acknowledgement must reuse this exact transaction, including expiry.
    const result=await request('/scim/tokens',{...creation});if(!live())return;merge(result.grant);
    if(typeof result.token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(result.token)){secret=result.token;creation=null;}
    else{secret=null;creation=null;error='토큰은 최초 응답에서만 표시됩니다. 이 항목을 철회한 뒤 새 토큰을 발급하세요.';}
  });}
  function select(id){if(!live()||busy)return;secret=null;creation=null;confirmation=null;selected=tokens.find(item=>item.id===id)||null;error='';update();}
  async function activate(proof,acknowledged){return run(async()=>{
    if(!selected||scimGrantStatus(selected,now())!=='활성화 대기')return;
    if(!acknowledged){error='토큰 보관과 계정 연동 허용 확인란을 선택하세요.';return;}
    const token=secret||proof;if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token)){error='발급 시 보관한 토큰을 입력하세요.';return;}
    const result=await request('/scim/tokens/'+encodeURIComponent(selected.id)+'/activate',{token});if(!live())return;secret=null;merge(result.grant);
  });}
  async function revoke(id){if(confirmation!==id){if(live()&&!busy){confirmation=id;update();}return;}return run(async()=>{
    const result=await request('/scim/tokens/'+encodeURIComponent(id),{},'DELETE');if(!live())return;
    secret=null;creation=null;confirmation=null;merge(result.grant);
  });}
  function restart(){if(!live()||busy||creation||selected&&scimGrantStatus(selected,now())!=='철회됨')return;secret=null;selected=null;error='';update();}
  return {close,snapshot,load,issue,select,activate,revoke,restart,secret:()=>live()?secret:null};
}
// END SCIM VIEW MODEL
function isOwner() { return state.session?.member?.role==='owner'; }
function isAdmin() { return ['owner','admin'].includes(state.session?.member?.role); }
function resourceLevel(resource) {
  return Number.isInteger(resource?.access_level)?resource.access_level:(state.session?.mode==='accounts'?0:4);
}
function pageEditable() { return !state.nativeRecoveryPaused&&!state.nativeOutboxPause&&!state.openingDocument&&!!state.channel&&!state.channel.closed&&!!state.channel.base&&state.channel.pageId===state.page?.id&&resourceLevel(state.page)>=3&&!state.page?.locked&&!state.page?.archived; }
function blockEditable() { return pageEditable()&&!state.history?.historyPending; }
function editorTransaction(kind,fn,options={}) {
  const channel=state.channel;if(!channel||!blockEditable())return;
  return channel.transact({kind,beforeSelection:selectedTextPosition(),afterSelection:()=>selectedTextPosition(),...options},fn);
}
function refreshHistoryControls(history=state.channel?.historyState?.()||{}) {
  state.history=history;
  for(const direction of ['undo','redo']){const button=$(`[data-action="${direction}"]`);if(button)button.disabled=!pageEditable()||history.busy||!history[direction==='undo'?'canUndo':'canRedo'];}
  const pending=!!history.historyPending;
  for(const element of $$('#blocks .block-content'))element.contentEditable=String(blockEditable());
  for(const element of $$('#blocks .block'))element.draggable=blockEditable();
  for(const element of $$('#blocks button,#blocks input,.rich-toolbar button:not([data-action="undo"]):not([data-action="redo"]),.rich-toolbar select,[data-action="add-block"]'))element.disabled=!blockEditable();
  const attachment=$('[data-action="add-file"]');if(attachment)attachment.disabled=!blockEditable()||state.offline||!!state.uploadManager?.active();
  let notice=$('#history-state');
  if(pending||history.truncated){if(!notice){notice=document.createElement('p');notice.id='history-state';notice.className='history-state';notice.setAttribute('role','status');$('#blocks')?.before(notice);}notice.textContent=pending?'실행 취소 결과를 확인하려면 연결이 필요합니다. 본문 편집을 잠시 기다려 주세요.':'이전의 큰 편집은 실행 취소 범위를 벗어났습니다.';}else notice?.remove();
}
async function runHistory(direction) {
  const channel=state.channel,epoch=channel?.base?.epoch,binding=state.session?.cache_binding;
  if(!channel||state.route!=='page'||!blockEditable()||state.composition||channel.historyState().busy)return;
  const result=await channel[direction]();
  if(state.channel!==channel||channel.base.epoch!==epoch||state.session?.cache_binding!==binding)return;
  refreshHistoryControls();if(result.selection&&!result.historyPending){restoreTextPosition(result.selection);if(!document.activeElement?.closest?.('.block-content'))focusBlock(state.blocks.find(block=>!['file','divider'].includes(block.type))?.id,false);}
}
function historyInput(event) {
  if(!['historyUndo','historyRedo'].includes(event.inputType))return false;
  if(event.isComposing||state.composition)return false;
  event.preventDefault();if(!state.historyCommand)runHistory(event.inputType==='historyUndo'?'undo':'redo').catch(error=>toast(error.message));return true;
}
function databaseEditable() { return resourceLevel(state.database)>=3; }
function canCreateRow() {
  return state.database?.can_create_row??(databaseEditable()&&state.database?.row_permissions?.allow_create!==false);
}
const administrativeActions=new Set(['activity','invite','new-teamspace','teamspace','add-advanced','edit-advanced','run-automation','fill-form','site-link','open-sites','backup','export']);
function pruneAdministrativeControls() {
  if(state.offline){$$('[data-action="new-database"],[data-action="add-file"]').forEach(el=>el.remove());for(const el of $$('[data-action]'))if(administrativeActions.has(el.dataset.action)||serverOnlyActions.has(el.dataset.action))el.remove();}
  if(state.localPageOnly)for(const el of $$('[data-action]'))if(serverOnlyActions.has(el.dataset.action))el.remove();
  if(!isOwner())$$('[data-action="activity"],[data-action="backup"],[data-action="export"]').forEach(el=>el.remove());
  if(!isAdmin()) {
    for(const el of $$('[data-action]'))if(administrativeActions.has(el.dataset.action))el.remove();
    $$('.invite-card').forEach(el=>el.remove());
    const activity=$('.activity-panel');if(activity)activity.remove();
    const dashboard=$('.dashboard-bottom');if(dashboard)dashboard.style.gridTemplateColumns='1fr';
    const settings=$('#sidebar .sidebar-bottom [data-action="settings"] .label');if(settings)settings.textContent='내 계정';
  }
  if(state.session?.member?.role==='guest') {
    $$('[data-action="add-page"]:not([data-parent]),[data-action="new-database"]').forEach(el=>el.remove());
  }
  $$('[data-action="add-page"][data-parent]').forEach(el=>{
    const parent=state.workspace?.pages.find(p=>p.id===el.dataset.parent);
    if(!parent||resourceLevel(parent)<3||parent.locked||parent.archived)el.remove();
  });
}
// Durable entity edits share the current login binding with document drafts.
const serverOnlyActions=new Set(['new-database','teamspace','history','share','db-share','lock-page','delete-page','verify-page','move-page','duplicate-page','copy-blocks','new-property','task-settings','duplicate-row','restore-version','restore-page','trash','settings','ai','new-teamspace','wiki-toggle','confirm-wiki-toggle','wiki-owner','row-verification','owner-settings','verified-pages','admin-settings']);
const activeMutationStatuses=new Set(['pending','deferred','applied']);
function closeMutations() {
  if(state.recoveryImport)closeModal();
  state.mutations?.close();state.mutations=null;state.mutationRecords=[];for(const channel of state.bodySyncChannels||[])channel.close();state.bodySyncChannels=new Set();
  clearTimeout(state.mutationRefreshTimer);
}
function metadataOverlay(page,snapshot=state.channel?.pageId===page.id?state.channel.base:null) {
  const value={...page};
  for(const record of state.mutationRecords||[])if(activeMutationStatuses.has(record.status)&&record.operation.kind==='page.patch'&&record.operation.target_id===page.id){if(record.status==='applied'&&Number.isSafeInteger(record.result?.data_revision)&&snapshot?.data_revision>=record.result.data_revision)continue;Object.assign(value,record.operation.body);}
  return value;
}
async function cachedResourceIds() {
  const profile=state.offlineProfile;if(!profile)return;
  const [pages,databases,locals]=await Promise.all([FountainOffline.listSnapshots(profile),FountainOffline.listDatabases(profile),FountainOffline.listLocalPages(profile)]);
  if(state.offlineProfile?.id!==profile.id)return;
  state.cachedPages=new Set([...pages.map(record=>record.snapshot.page.id),...locals.map(record=>record.metadata.page.id)]);
  state.cachedDatabases=new Set(databases.map(record=>record.snapshot.database.id));
}
async function ensureMutations() {
  if(state.nativeRecoveryPaused||!window.FountainMutations||!state.offlineProfile)return null;
  const profile=state.offlineProfile;
  if(state.mutations&&state.mutationProfileId===profile.id)return state.mutations;
  closeMutations();state.mutationProfileId=profile.id;
  const controller=new FountainMutations.Controller({profile,
    onChange:()=>{if(state.nativeOutboxPause||state.mutations!==controller)return;clearTimeout(state.mutationRefreshTimer);state.mutationRefreshTimer=setTimeout(()=>refreshMutationUI(controller).catch(error=>{if(state.mutations===controller)toast(error.message);}),80);},
    onDenied:async detail=>{
      if(state.nativeOutboxPause||state.mutations!==controller)return;
      if(detail.kind==='session'){if(!await suspendLoginInput(state.offlineProfile))return;if(detail.switched||state.session?.mode==='local'&&state.session.required===false){state.offlineProfile=null;await boot();}else renderLogin(false);return;}
      closeDeniedResource(detail);refreshMutationUI(controller).catch(()=>{});
    },
    onError:error=>{if(state.mutations===controller&&error.status)toast(error.message);}
  });
  state.mutations=controller;
  state.mutationRecords=await controller.records();
  if(state.mutations!==controller)return null;
  await cachedResourceIds();
  const workspace=await controller.workspace(state.serverWorkspace||state.workspace);
  if(state.mutations!==controller)return null;state.workspace=workspace;
  renderSyncIndicators();return controller;
}
function closeDeniedResource(detail) {
  const id=detail.databaseId||detail.pageId;
  if(detail.kind==='database'){
    state.cachedDatabases?.delete(id);
    if(state.workspace)state.workspace.databases=state.workspace.databases.filter(database=>database.id!==id);
    if(state.serverWorkspace)state.serverWorkspace.databases=state.serverWorkspace.databases.filter(database=>database.id!==id);
    if(state.database?.id===id||state.navigatingDatabaseId===id){state.database=null;state.rows=[];state.route='denied';closeModal();$('#main').innerHTML=`<div class="empty"><h2>이 데이터베이스에 접근할 수 없습니다.</h2><p>${esc(detail.message||'서버에서 읽기 권한을 확인해 주세요.')}</p><button class="outline-btn" data-action="home">홈으로 돌아가기</button></div>`;renderTopbar('접근 권한 없음');}
  }else if(detail.kind==='page'&&state.page?.id===id){closeDocument();state.page=null;state.blocks=[];state.route='denied';closeModal();$('#main').innerHTML=`<div class="empty"><h2>이 페이지에 접근할 수 없습니다.</h2><button class="outline-btn" data-action="home">홈으로 돌아가기</button></div>`;renderTopbar('접근 권한 없음');}
  renderSidebar();
}
async function refreshMutationUI(controller=state.mutations,current=()=>true) {
  if(!current()||state.nativeOutboxPause||!controller||state.mutations!==controller)return;
  const records=await controller.records();if(!current()||state.nativeOutboxPause||state.mutations!==controller)return;
  state.mutationRecords=records;
  const workspace=await controller.workspace(state.serverWorkspace||state.workspace);
  if(!current()||state.nativeOutboxPause||state.mutations!==controller)return;state.workspace=workspace;
  await cachedResourceIds();
  if(!current()||state.nativeOutboxPause||state.mutations!==controller)return;
  renderSidebar();renderSyncIndicators();
  if(state.route==='page'&&state.page){
    const local=await controller.localPage(state.page.id);
    if(!current()||state.nativeOutboxPause||state.mutations!==controller)return;
    state.localPageOnly=!!local?.metadata.localOnly;
    const basis=local?.metadata.page&&local.metadata.page.revision>=(state.channel?.base.page.revision||0)?local.metadata.page:state.channel?.base.page||state.page;
    state.page=metadataOverlay({...state.page,...basis,access_level:state.channel?.base.access_level??state.page.access_level});
    patchPageMetadataUI();
    if(!state.localPageOnly&&state.channel?.remoteDeferred){await state.channel.resumeRemote();if(!current())return;}
    if(state.channel)documentStatus({status:state.channel.status,pending:state.channel.pending.size,durable:state.channel.durable!==false});
  }
  if(state.database&&['home','database'].includes(state.route)){
    const id=state.database.id;
    try{
      const data=await controller.loadDatabase(id,{remote:false});
      if(!current()||state.mutations!==controller||state.database?.id!==id)return;
      state.database=data.database;state.rows=data.rows||[];
      if(!$('.modal')&&!state.composition){
        if(state.route==='database')renderDatabase();
        else if($('#home-database')){$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;applyDatabaseControls();}
      }
    }catch(error){if(current()&&error.status&&[401,403,404].includes(error.status))toast(error.message);}
  }
  if(!current())return;
  if($('#mutation-queue-list'))renderMutationQueue();
  syncCreatedPageBodies(controller).catch(error=>{if(state.mutations===controller&&error.status)toast(error.message);});
}
async function syncCreatedPageBodies(controller) {
  if(state.nativeOutboxPause||state.offline||!navigator.onLine||state.mutations!==controller||state.bodySyncRunning===controller)return;
  const profile=state.offlineProfile;state.bodySyncRunning=controller;
  try{
    for(const record of await FountainOffline.listLocalPages(profile)){
      if(state.nativeOutboxPause||state.mutations!==controller||state.offline)return;
      const id=record.metadata.page.id;
      if(record.metadata.localOnly||state.channel?.pageId===id||!(await controller.pageReady(id)))continue;
      const key=FountainOffline.key(profile,id);
      if(!(await FountainOffline.pendingOperations(key)).length)continue;
      const local=await controller.localPage(id);if(!local?.snapshot||state.mutations!==controller)return;
      const channel=new FountainCollaboration.DocumentChannel({pageId:id,profile,deferRemote:true,
        fetcher:async(path,body,method)=>{if(state.mutations!==controller)throw new Error('로그인 계정이 변경되었습니다.');return api(path,body,method);},
        onDenied:detail=>{if(state.mutations===controller&&[403,404].includes(detail.status))closeDeniedResource({kind:'page',pageId:id,...detail});}
      });
      state.bodySyncChannels||=new Set();state.bodySyncChannels.add(channel);
      try{await channel.open(local.snapshot,{cached:true});if(state.nativeOutboxPause||state.mutations!==controller)return;await channel.resumeRemote();await channel.flush();await channel.persistence;}
      finally{channel.close();state.bodySyncChannels.delete(channel);}
    }
  }finally{if(state.bodySyncRunning===controller)state.bodySyncRunning=null;}
}
function nativeCacheOnly() { return !!FountainTransport.native&&!FountainTransport.outboxEnabled; }
function renderSyncIndicators() {
  const records=state.mutationRecords||[],waiting=records.filter(record=>activeMutationStatuses.has(record.status)),paused=records.filter(record=>!activeMutationStatuses.has(record.status));
  const label=paused.length?`충돌·확인 ${paused.length}개`:waiting.length?`동기화 대기 ${waiting.length}개`:state.offline?(nativeCacheOnly()?'오프라인 · 앱 캐시에 보관됨':'오프라인 · 기기에 저장됨'):(nativeCacheOnly()?'서버 연결 · 앱 캐시':'기기 저장 · 연결됨');
  for(const el of $$('[data-sync-label]'))el.textContent=label;
  for(const el of $$('[data-action="sync-queue"]')){el.classList.toggle('has-conflicts',!!paused.length);el.classList.toggle('has-pending',!!waiting.length);}
}
function mutationTitle(record) {
  const op=record.operation;
  return ({'page.create':'새 페이지 만들기','page.patch':'페이지 정보 수정','row.create':'새 항목 만들기','row.patch':'항목 수정','row.delete':'항목과 하위 항목 삭제'})[op.kind]||'저장된 변경';
}
function mutationDetail(record) {
  const body=record.operation.body||{},values=body.properties||body;
  return Object.entries(values).filter(([key])=>!['permissions','blocks'].includes(key)).map(([key,value])=>{
    const name=state.database?.properties?.find(property=>property.id===key)?.name||({title:'제목',icon:'아이콘',cover:'커버',favorite:'즐겨찾기',parent_id:'상위 페이지',parent_row_id:'상위 항목',depends_on:'선행 작업'})[key]||key;
    return name+': '+(typeof value==='object'?JSON.stringify(value):String(value??''));
  }).join(' · ')||record.operation.target_id;
}
function mutationError(record) {
  const raw=String(record.result?.error||record.error||'');
  if(!raw)return '';
  if(/Row properties changed/i.test(raw))return '다른 기기에서 같은 속성을 바꿨습니다. 보관한 내용을 내려받거나 현재 서버 값을 기준으로 다시 적용하세요.';
  if(/schema|property definition|property.*changed/i.test(raw))return '서버의 속성 정의가 바뀌었습니다. 최신 속성을 확인한 뒤 다시 적용하세요.';
  if(/Subitem changed|subtree|children/i.test(raw))return '하위 항목이 변경되었습니다. 삭제할 범위를 다시 확인한 뒤 적용하세요.';
  if(/cycle|circular/i.test(raw))return '상위 항목이나 선행 작업에 순환 연결이 있습니다. 연결 관계를 다시 확인해 주세요.';
  if(/locked/i.test(raw))return '문서가 잠겨 있습니다. 연결 후 잠금 상태를 확인하세요.';
  if(record.status==='denied')return '현재 이 변경을 저장할 권한이 없습니다. 복구 내용을 보관하고 공유 권한을 확인하세요.';
  if(record.status==='conflict')return '서버의 내용이 바뀌어 변경을 보관했습니다. 최신 내용을 확인한 뒤 다시 적용하세요.';
  return /[가-힣]/.test(raw)?raw:'변경 내용이나 연결 상태를 확인해 주세요. 원본 변경은 복구 파일에 보관됩니다.';
}
function renderMutationQueue() {
  const list=$('#mutation-queue-list');if(!list)return;
  const records=state.mutationRecords||[];
  const names={paused:'가져옴 · 적용 전 확인',pending:nativeCacheOnly()?'앱 캐시에 보관 · 동기화 대기':'기기에 저장 · 동기화 대기',deferred:'선행 작업 완료 대기',applied:'서버 저장됨 · 최신 내용 확인 중',conflict:'같은 내용이 변경되어 확인 필요',denied:'변경 권한 확인 필요',invalid:'내용 또는 구조 확인 필요'};
  list.innerHTML=records.length?records.map(record=>`<article class="mutation-card" data-mutation-id="${esc(record.id)}" data-mutation-status="${esc(record.status)}"><div class="mutation-heading"><strong>${esc(mutationTitle(record))}</strong><span>${esc(names[record.status]||'확인 필요')}</span></div><p>${esc(mutationDetail(record))}</p>${record.result?.error||record.error?`<p class="mutation-error">${esc(mutationError(record))}</p>`:''}<div class="mutation-actions"><button class="outline-btn" data-action="export-mutation" data-id="${esc(record.id)}">복구 내용 내려받기</button>${!activeMutationStatuses.has(record.status)?`<button class="outline-btn" data-action="reapply-mutation" data-id="${esc(record.id)}" ${state.offline?'disabled':''}>현재 값 기준으로 다시 적용</button>`:''}${record.status!=='applied'?`<button class="outline-btn" data-action="drop-mutation" data-id="${esc(record.id)}">변경 폐기</button>`:''}</div></article>`).join(''):`<div class="empty">동기화할 변경이 없습니다.<br>${nativeCacheOnly()?'앱 캐시에 보관한 데이터는 연결 없이도 열 수 있습니다. 캐시를 지우면 미전송 변경을 잃을 수 있습니다.':'기기에 저장한 데이터는 연결 없이도 열 수 있습니다.'}</div>`;
  $('#sync-now')?.toggleAttribute('disabled',state.offline);
}
function clearRecoveryImport() {
  const view=state.recoveryImport;state.recoveryImport=null;if(!view)return;
  view.sequence++;view.rawText=null;
  if(view.prepared?.token)view.scope.controller.discardPrepared?.(view.prepared.token);
  view.prepared=null;
}
function recoveryImportCurrent(view,sequence=view?.sequence) {
  const scope=view?.scope,currentId=state.route==='page'?state.page?.id:state.route==='database'?state.database?.id:null;
  return !!scope&&state.recoveryImport===view&&view.sequence===sequence&&view.modal?.isConnected&&$('.mutation-modal')===view.modal&&state.mutations===scope.controller&&state.offlineProfile?.id===scope.profileId&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.memberId&&state.workspace?.workspace_id===scope.workspaceId&&state.route===scope.route&&currentId===scope.routeId;
}
function recoveryImportError(error) {
  if(error.code==='TARGET_PAGE_REQUIRED')return '본문을 복구할 문서를 선택한 뒤 미리보기를 다시 확인해 주세요.';
  if(error.code==='IMPORT_SOURCE_MISMATCH')return '다른 서버나 다른 사용자의 복구 파일은 이 계정에 가져올 수 없습니다.';
  if(error.code==='IMPORT_PREVIEW_STALE'||error.status===409)return '미리보기 이후 서버의 내용이나 권한이 바뀌었습니다. 미리보기를 다시 확인한 뒤 가져와 주세요.';
  if(error.code==='INVALID_RECOVERY'||error instanceof SyntaxError)return '지원하지 않거나 손상된 복구 JSON입니다. 원본 파일을 확인해 주세요.';
  return /[가-힣]/.test(error.message||'')?error.message:'복구 내용을 확인하지 못했습니다. 연결 상태와 현재 권한, 원본 파일을 확인해 주세요.';
}
function recoveryPreviewText(value) {
  let text=typeof value==='object'&&value!==null?JSON.stringify(value):String(value??'');
  return esc(text.length>2500?text.slice(0,2500)+'… (긴 내용의 일부만 표시)':text);
}
function recoveryDatabase(item) { return state.workspace?.databases?.find(database=>database.id===item?.databaseId)||(state.database?.id===item?.databaseId?state.database:null); }
function recoveryRowName(row,item) {
  const property=item?.titlePropertyId||recoveryDatabase(item)?.properties?.find(property=>property.type==='title')?.id;
  return String(row?.properties?.[property]||row?.properties?.name||row?.properties?.title||row?.title||'항목');
}
function recoveryItemTitle(item) {
  if(item.title&&item.title!==item.targetId)return item.title;
  return item.kind?.startsWith('row.')?recoveryRowName(item.after||item.before,item):({'page.create':'새 문서 사본','page.patch':'문서 정보 수정',body:'본문 복구'})[item.kind]||'복구 내용';
}
function recoveryPreviewValue(value,item={}) {
  if(value===null||value===undefined)return '<span class="muted">해당 내용 없음</span>';
  if(Array.isArray(value)&&value.every(block=>block&&typeof block==='object'&&typeof block.type==='string'&&typeof block.text==='string'))return value.slice(0,50).map(block=>`<div class="recovery-preview-block"><small>${versionAttributes(block)}</small><div class="${block.type==='code'?'recovery-code':''}">${block.type==='file'?'📎 ':''}${recoveryPreviewText(block.text)}${block.type==='file'&&Number.isFinite(block.size)?` <small>${esc(sizeLabel(block.size))}</small>`:''}</div></div>`).join('')+(value.length>50?`<small>총 ${value.length}개 블록 중 앞의 50개를 표시합니다.</small>`:'');
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const page=item.kind?.startsWith('page.'),labels={title:'제목',icon:'아이콘',cover:'표지',favorite:'즐겨찾기',parent_id:'상위 문서',parent_row_id:'상위 항목',depends_on:'선행 작업',name:'이름',status:'상태',priority:'우선순위',due:'날짜'};
    const source=page?Object.fromEntries(['title','icon','cover','favorite','parent_id'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])):value.properties||value;
    const fields=Object.entries(source).filter(([key])=>page||value.properties||!['id','owner_id','access_level','permissions','revision','archived','locked','teamspace_id','blocks'].includes(key)).map(([key,raw])=>{
      let display=raw;
      if(page&&key==='favorite')display=raw?'켜짐':'꺼짐';
      if(page&&key==='cover')display=raw?'표지 있음':'표지 없음';
      if(page&&key==='parent_id'){if(!raw)display='최상위 문서';else{display=state.workspace?.pages?.find(page=>page.id===raw)?.title||state.recoveryImport?.prepared?.items?.find(page=>page.targetId===raw)?.after?.title;if(!display)return '';}}
      const label=page?labels[key]:item.propertyLabels?.[key]||recoveryDatabase(item)?.properties?.find(property=>property.id===key)?.name||labels[key]||'속성';
      return `<div><dt>${esc(label)}</dt><dd>${recoveryPreviewText(display)}</dd></div>`;
    }).join('');
    return `<dl class="recovery-value-list">${fields}</dl>${page&&item.kind==='page.create'&&Array.isArray(value.blocks)?`<h4>복구 본문 · ${value.blocks.length}개 블록</h4>${recoveryPreviewValue(value.blocks,{kind:'body'})}`:''}`;
  }
  return recoveryPreviewText(value);
}
function renderRecoveryImport(view) {
  if(!recoveryImportCurrent(view))return;
  const panel=$('#recovery-import-preview',view.modal);if(!panel)return;
  const prepared=view.prepared;
  panel.innerHTML=view.error?`<div class="info-box" role="alert">${esc(view.error)}</div>`:view.busy?'<p role="status">원본과 현재 서버 내용을 확인하고 있습니다…</p>':view.result?`<div class="recovery-import-success" role="status"><strong>${view.result.duplicate?'이미 가져온 복구 파일입니다.':'복구 대기열에 보관했습니다.'}</strong><p>서버에 자동으로 반영하지 않았습니다. 변경은 ‘현재 값 기준으로 다시 적용’, 본문은 문서의 ‘보관된 편집 내용’에서 확인한 뒤 적용하세요.</p></div>`:'';
  if(prepared){
    const labels={records:'저장된 변경',localPages:'문서 사본',drafts:'본문 복구',blocks:'블록',createdPages:'새 문서 사본',createdRows:'새 항목 사본',updatedPages:'문서 정보 수정',updatedRows:'항목 수정',deletedRows:'삭제 대상'};
    panel.innerHTML+=`<div class="recovery-import-heading"><strong>${esc(view.fileName||'복구 파일')} 미리보기</strong><span>${prepared.kind==='body'?'본문을 복구 내용으로 복사':'변경을 새 복구 항목으로 보관'}</span></div><div class="recovery-import-summary">${Object.entries(prepared.summary||{}).filter(([,count])=>count).map(([key,count])=>`<span>${esc(labels[key]||key)} ${esc(count)}</span>`).join('')}</div>${prepared.warnings?.length?`<ul class="recovery-import-warnings">${prepared.warnings.map(warning=>`<li>${esc(warning)}</li>`).join('')}</ul>`:''}<div class="recovery-import-items">${(prepared.items||[]).slice(0,view.itemLimit||30).map(item=>`<article class="recovery-import-item"><strong>${esc(recoveryItemTitle(item))}</strong><div class="recovery-import-pair${item.kind==='body'?' recovery-import-body':''}">${item.kind==='body'?'':`<section><h4>현재 내용</h4>${recoveryPreviewValue(item.before,item)}</section>`}<section><h4>${item.kind==='body'?'가져올 복구 내용':'가져올 내용'}</h4>${recoveryPreviewValue(item.after,item)}</section></div>${item.deleteRows?.length?`<div class="recovery-delete-range"><strong>현재 삭제 범위 ${item.deleteRows.length}개</strong><ul>${item.deleteRows.slice(0,100).map(row=>`<li>${esc(recoveryRowName(row,item))}</li>`).join('')}</ul></div>`:''}</article>`).join('')}</div>${prepared.items?.length>(view.itemLimit||30)?'<button class="outline-btn" data-action="recovery-preview-more">미리보기 더 보기</button>':''}<div class="recovery-import-confirm"><p>가져오기는 이 로그인에 적용 전 상태로 보관합니다. 현재 문서나 서버 내용을 바로 변경하지 않습니다.</p><button class="solid-btn" data-action="confirm-recovery-import" ${view.staging?'disabled':''}>${view.staging?'복구 내용을 보관하는 중…':'확인하고 복구 대기열에 가져오기'}</button></div>`;
  }
  const target=$('#recovery-target-page',view.modal);if(target)target.disabled=prepared?.kind==='typed'||!!view.staging;
  const retry=$('[data-action="prepare-recovery-import"]',view.modal);if(retry)retry.disabled=!(view.rawText||view.archiveId||view.memoryId)||view.busy||view.staging;
}
function invalidateRecoveryPrepared(view) {
  if(view.prepared?.token)view.scope.controller.discardPrepared?.(view.prepared.token);
  view.prepared=null;view.result=null;view.error=null;view.itemLimit=30;
}
async function prepareRecoveryImport(view=state.recoveryImport) {
  if(!recoveryImportCurrent(view)||!(view.rawText||view.archiveId||view.memoryId))return;
  invalidateRecoveryPrepared(view);const sequence=++view.sequence;view.staging=false;view.busy=true;renderRecoveryImport(view);
  const current=()=>recoveryImportCurrent(view,sequence);
  try{
    const targetPageId=$('#recovery-target-page',view.modal)?.value||undefined;
    let prepared;
    if(view.archiveId)prepared=await view.scope.controller.prepareArchivedRecovery(view.archiveId,{isCurrent:current});
    else if(view.memoryId){const entry=authenticationMemory().find(value=>(value.recoveryId===view.memoryId||value.profile.id===view.memoryId));if(!entry)throw new Error('현재 계정의 마지막 입력을 다시 확인해 주세요.');prepared=await view.scope.controller.prepareImport(JSON.stringify(authenticationMemoryFile(entry)),{targetPageId:entry.lastEdits.pageId||targetPageId,isCurrent:current});}
    else try{prepared=await view.scope.controller.prepareImport(view.rawText,{isCurrent:current});}catch(error){if(error.code!=='TARGET_PAGE_REQUIRED'||!targetPageId||!current())throw error;prepared=await view.scope.controller.prepareImport(view.rawText,{targetPageId,isCurrent:current});}
    if(!current()){view.scope.controller.discardPrepared?.(prepared.token);return;}
    view.prepared=prepared;
  }catch(error){if(current())view.error=recoveryImportError(error);}
  finally{if(current()){view.busy=false;renderRecoveryImport(view);}}
}
async function readRecoveryFile(file) {
  const view=state.recoveryImport;if(!file||!recoveryImportCurrent(view))return;
  invalidateRecoveryPrepared(view);const sequence=++view.sequence;view.rawText=null;view.archiveId=null;view.memoryId=null;view.fileName=file.name;view.busy=false;view.staging=false;
  if(file.size>16*1024*1024){view.error='복구 JSON은 최대 16 MiB까지 선택할 수 있습니다.';renderRecoveryImport(view);return;}
  view.busy=true;renderRecoveryImport(view);
  try{const text=await file.text();if(!recoveryImportCurrent(view,sequence))return;view.rawText=text;view.busy=false;await prepareRecoveryImport(view);}catch(error){if(recoveryImportCurrent(view,sequence)){view.busy=false;view.error=recoveryImportError(error);renderRecoveryImport(view);}}
}
async function confirmRecoveryImport() {
  const view=state.recoveryImport;if(!recoveryImportCurrent(view)||!view.prepared||view.staging)return;
  const sequence=view.sequence,prepared={token:view.prepared.token,digest:view.prepared.digest},current=()=>recoveryImportCurrent(view,sequence);
  view.staging=true;view.error=null;renderRecoveryImport(view);
  try{
    const result=await view.scope.controller.importPrepared(prepared,{isCurrent:current});if(!current())return;
    view.scope.controller.discardPrepared?.(prepared.token);view.prepared=null;view.rawText=null;view.result=result;
    const records=await view.scope.controller.records();if(!current())return;state.mutationRecords=records;renderMutationQueue();
    if(state.route==='page'&&state.channel){const channel=state.channel,drafts=await FountainOffline.getDrafts(channel.key);if(!current()||state.channel!==channel)return;state.recoveryDrafts=drafts.filter(record=>!['pending','basis'].includes(record.draft?.reason));renderRecoveryDrafts();}
  }catch(error){if(current()){if(error.code==='IMPORT_PREVIEW_STALE'||error.status===409){view.scope.controller.discardPrepared?.(view.prepared?.token);view.prepared=null;}view.error=recoveryImportError(error);}}
  finally{if(current()){view.staging=false;renderRecoveryImport(view);}}
}
function nativeRecoveryAvailable() {
  return globalThis.FountainTransport?.native===true&&globalThis.FountainNativeRecovery?.available===true;
}
function authenticationReadableBlocks(text) {
  const blocks=[],prefix='auth-readable-'+uid();
  for(let start=0;start<text.length;){let end=Math.min(text.length,start+32000);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;blocks.push({id:prefix+'-'+blocks.length,type:'code',language:'text',text:text.slice(start,end),parent_id:null});start=end;}
  return blocks;
}
function authenticationInput(profile) {
  if(!profile||state.offlineProfile?.id!==profile.id||state.route!=='page'||!state.page)return null;
  const channel=state.channel;readBlocks();
  const pending=state.titlePending||state.titleSavingInput;
  let title=pending?.id===state.page.id?{title:pending.title,basePage:structuredClone(pending.basePage)}:undefined;
  const titleElement=$('#page-title');
  if(titleElement){const visible=titleElement.innerText.trim()||'제목 없음',basis=pending?.id===state.page.id?pending.basePage:state.titleInputBasis||state.pageViewBasis||state.page;if(visible!==state.page.title||title)title={title:visible,basePage:structuredClone(basis)};}
  let changed=false,blocks=state.blocks;
  try{changed=!!channel&&(channel.pending.size>0||FountainCollaboration.canonical(FountainCollaboration.normalizeBlocks(blocks))!==FountainCollaboration.canonical(FountainCollaboration.normalizeBlocks(channel.base.blocks||[])));}
  catch{changed=true;blocks=authenticationReadableBlocks($$('#blocks .block-content').map(element=>element.innerText).join('\n\n'));state.authRetentionError='편집 한도를 넘은 입력은 원문 조각으로 보관했습니다. 같은 계정으로 로그인해 복구 내용을 확인해 주세요.';}
  if(title&&Array.from(title.title).length>500){blocks=[...(changed?blocks:[]),...authenticationReadableBlocks('입력한 제목:\n'+title.title)];title=undefined;changed=true;state.authRetentionError='긴 제목은 원문 조각으로 보관했습니다. 같은 계정으로 로그인해 복구 내용을 확인해 주세요.';}
  const draft=changed?{epoch:channel?.base.epoch,seq:channel?.base.seq,reason:'auth_suspended',blocks:structuredClone(blocks),ops:[...(channel?.pending.values()||[])].map(value=>structuredClone(value))}:undefined;
  return title||draft?{pageId:state.page.id,...(title?{title}:{}),...(draft?{draft}:{})}:null;
}
async function suspendLoginInput(profile=state.offlineProfile) {
  if(state.nativeRecoveryPaused||state.authSuspending)return false;
  let lastEdits;const generation=(state.bootGeneration||0)+1;state.bootGeneration=generation;state.authSuspending=true;
  try{lastEdits=authenticationInput(profile);}
  catch{if(profile&&state.offlineProfile?.id===profile.id&&state.page)lastEdits={pageId:state.page.id,draft:{reason:'auth_suspended',blocks:authenticationReadableBlocks($$('#blocks .block-content').map(element=>element.innerText).join('\n\n'))}};state.authRetentionError='마지막 입력을 다시 확인해야 합니다. 앱을 닫지 말고 같은 계정으로 로그인해 주세요.';}
  finally{closeDocument();closeMutations();closeModal();state.loaded=false;document.body.classList.add('login-mode');$('#sidebar').replaceChildren();$('#topbar').replaceChildren();$('#main').innerHTML='<div class="loading">로그인 상태를 확인하고 있습니다…</div>';}
  try{
    const result=profile?await FountainOffline.suspendProfile(profile,{lastEdits}):{profileId:null,lastEditsSaved:false,reason:'missing'};
    if(lastEdits&&!result.lastEditsSaved&&result.reason!=='revoked'){state.authRecoveryMemory||=new Map();state.authRecoveryMemory.set(profile.id,{profile:structuredClone(profile),lastEdits,recoveryId:uid()});state.authRetentionError='마지막 입력을 아직 저장하지 못했습니다. 앱을 닫지 말고 같은 계정으로 다시 로그인해 주세요.';}
  }catch(error){
    if(lastEdits){state.authRecoveryMemory||=new Map();state.authRecoveryMemory.set(profile.id,{profile:structuredClone(profile),lastEdits,recoveryId:uid()});}
    state.authRetentionError='마지막 입력을 아직 저장하지 못했습니다. 앱을 닫지 말고 같은 계정으로 다시 로그인해 주세요.';
  }finally{state.authSuspending=false;}
  return generation===state.bootGeneration;
}
function authenticationMemory() {
  const current=state.offlineProfile;
  return current?[...(state.authRecoveryMemory?.values()||[])].filter(value=>value.profile.origin===current.origin&&value.profile.workspaceId===current.workspaceId&&value.profile.memberId===current.memberId):[];
}
function authenticationMemoryFile({profile,lastEdits,recoveryId}) {
  const {pageId,draft,title,formInput}=lastEdits,records=[],drafts=draft?[{page_id:pageId,draft}]:[];
  if(formInput?.length)drafts.push({page_id:pageId||'unsubmitted-form',draft:{reason:'auth_suspended',blocks:authenticationReadableBlocks(JSON.stringify(formInput,null,2))}});
  if(title)records.push({id:recoveryId,profileId:profile.id,resourceKey:profile.id+'|'+encodeURIComponent(pageId),operation:{id:recoveryId,kind:'page.patch',target_id:pageId,depends_on:[],body:{title:title.title},base:{fields:{title:title.basePage?.title??null}}}});
  return {format:'fountain-recovery-v2',origin:profile.origin,workspace_id:profile.workspaceId,member_id:profile.memberId,source_binding:profile.cacheBinding,records,localPages:[],drafts};
}
function renderRecoveryArchives(view) {
  if(!recoveryImportCurrent(view))return;
  const panel=$('#recovery-archives',view.modal);if(!panel)return;
  const memory=authenticationMemory();
  panel.innerHTML='<h3>이전 로그인에서 보관한 편집</h3><p>같은 계정의 기록을 현재 권한으로 확인합니다. 선택만으로 서버에 반영하지 않습니다.</p>'+(view.archivesError?`<p role="status">${esc(view.archivesError)}</p>`:view.archivesBusy?'<p role="status">보관 기록을 확인하고 있습니다…</p>':'')+(view.archives||[]).map(item=>`<div class="history-item"><div>보관한 편집 · ${Object.values(item.counts||{}).reduce((sum,count)=>sum+(Number.isSafeInteger(count)?count:0),0)}개<small>${date(item.createdAt)}</small></div><button class="outline-btn" data-action="prepare-archived-recovery" data-id="${esc(item.id)}">내용 확인</button></div>`).join('')+memory.map(value=>`<div class="history-item"><div>아직 저장하지 못한 마지막 입력<small>복구를 마칠 때까지 앱을 닫지 마세요.</small></div><button class="outline-btn" data-action="prepare-memory-recovery" data-id="${esc(value.recoveryId||value.profile.id)}">내용 확인</button></div>`).join('')+(!view.archivesBusy&&!view.archivesError&&!view.archives?.length&&!memory.length?'<p class="muted">이 계정에서 보관한 이전 편집이 없습니다.</p>':'')+(view.archivesNext?'<button class="outline-btn" data-action="more-archive-recovery">보관 기록 더 보기</button>':'');
}
async function loadRecoveryArchives(view,more=false) {
  if(!recoveryImportCurrent(view)||view.archivesBusy)return;
  if(state.offline){view.archivesError='연결한 뒤 같은 계정의 보관 기록을 확인할 수 있습니다.';renderRecoveryArchives(view);return;}
  const sequence=view.archiveSequence=(view.archiveSequence||0)+1;view.archivesBusy=true;view.archivesError=null;renderRecoveryArchives(view);
  try{const result=await view.scope.controller.recoveryArchives({cursor:more?view.archivesNext:null,limit:20});if(!recoveryImportCurrent(view)||view.archiveSequence!==sequence)return;view.archives=more?[...(view.archives||[]),...result.items]:result.items;view.archivesNext=result.next;}
  catch(error){if(recoveryImportCurrent(view)&&view.archiveSequence===sequence)view.archivesError=error.message;}
  finally{if(recoveryImportCurrent(view)&&view.archiveSequence===sequence){view.archivesBusy=false;renderRecoveryArchives(view);}}
}
async function prepareNativeRecovery() {
  if(!nativeRecoveryAvailable())throw new Error('이 앱에서는 보관 내용 복구를 사용할 수 없습니다.');
  if(state.nativeRecoveryPaused)return;
  if(state.nativeOutboxPause){
    const paused=state.nativeOutboxPause,profile=paused.profile||state.offlineProfile;let input=paused.input;
    try{input=authenticationInput(profile)||input;}catch{/* The detached DOM below retains input that cannot yet be normalized. */}
    const forms=unsubmittedNativeForms();if(profile&&(input||forms.length))rememberNativeInput(profile,{...(input||{}),...(forms.length?{formInput:forms}:{})});
    state.nativeOutboxDOMArchive||=new Map();const archive=document.createDocumentFragment();while($('#main').firstChild)archive.append($('#main').firstChild);state.nativeOutboxDOMArchive.set(profile?.id+'|'+state.route+'|'+(state.page?.id||state.database?.id||''),archive);
    // Storage uncertainty is already journalled. Preserve RAM, never await the initiating
    // failed/native-pending persistence promise merely to enter independent recovery.
    state.nativeRecoveryPaused=true;state.nativeOutboxPause=null;state.bootGeneration=(state.bootGeneration||0)+1;clearTimeout(state.titleTimer);closeDocument();closeMutations();closeModal();
    for(const node of [$('#main'),$('#sidebar'),$('#topbar'),$('#overlay-root')].filter(Boolean))node.inert=false;
    document.body.classList.add('login-mode');$('#sidebar').replaceChildren();$('#topbar').replaceChildren();$('#main').innerHTML='<section id="native-recovery-paused" class="info-box"><p>확인되지 않은 입력과 기기 원본을 보관했습니다. 현재 계정으로 복구 방법을 선택해 주세요.</p></section>';return;
  }
  if(state.nativeRecoveryPreparing)throw new Error('현재 편집 내용을 보관하고 있습니다. 잠시 기다려 주세요.');
  if(state.composition)throw new Error('입력 중인 글자를 마무리한 뒤 다시 열어 주세요.');
  const scope={channel:state.channel,controller:state.mutations,profileId:state.offlineProfile?.id,binding:state.session?.cache_binding,epoch:FountainTransport.scopeEpoch};
  const current=()=>state.channel===scope.channel&&state.mutations===scope.controller&&state.offlineProfile?.id===scope.profileId&&state.session?.cache_binding===scope.binding&&FountainTransport.scopeEpoch===scope.epoch;
  const check=()=>{if(!current())throw new Error('문서나 로그인 상태가 바뀌었습니다. 다시 확인해 주세요.');};
  clearTimeout(state.titleTimer);
  try {
  reconcileEditor();state.nativeRecoveryPreparing=true;
  if(scope.channel)await scope.channel.persistence;
  check();
  if(scope.channel?.pending?.size&&scope.channel.durable===false)throw new Error('현재 편집 내용을 아직 보관하지 못했습니다. 저장 상태를 확인한 뒤 다시 열어 주세요.');
  if(state.titleSaving)await state.titleSaving;
  check();
  const pending=state.titlePending;
  if(pending){
    if(!scope.controller)throw new Error('현재 제목을 먼저 보관한 뒤 다시 열어 주세요.');
    await scope.controller.patchPage(pending.id,{title:pending.title},{basePage:pending.basePage});
    check();if(state.titlePending===pending)state.titlePending=null;
  }
  if(scope.channel)await scope.channel.persistence;
  check();
  state.nativeRecoveryPaused=true;state.bootGeneration=(state.bootGeneration||0)+1;
  clearTimeout(state.titleTimer);closeDocument();closeMutations();closeModal();document.body.classList.remove('sidebar-open');document.body.classList.add('login-mode');
  for(const element of $$('#main [contenteditable]'))element.contentEditable='false';
  for(const element of $$('#main input,#main textarea,#main select'))element.disabled=true;
  const notice=document.createElement('section');notice.id='native-recovery-paused';notice.className='info-box';notice.setAttribute('role','status');
  const text=document.createElement('p');text.textContent='보관 내용을 확인하는 동안 편집과 동기화를 일시 중지했습니다. 마친 뒤 앱을 다시 열어 계속하세요.';
  const reopen=document.createElement('button');reopen.className='outline-btn';reopen.dataset.action='native-recovery';reopen.textContent='보관 내용 다시 확인';
  const reload=document.createElement('button');reload.className='outline-btn';reload.dataset.action='reload-after-native-recovery';reload.textContent='앱 다시 열기';notice.append(text,reopen,reload);$('#main').replaceChildren(notice);
  const status=$('#save-status');if(status)status.textContent='보관 내용 확인 · 편집 일시 중지';
  } finally {
    state.nativeRecoveryPreparing=false;
    if(!state.nativeRecoveryPaused&&current()&&state.titlePending&&!state.titleSaving)state.titleTimer=setTimeout(()=>saveTitle().catch(error=>toast(error.message)),450);
  }
}
async function openMutationQueue() {
  const scope={controller:state.mutations,profileId:state.offlineProfile?.id,binding:state.session?.cache_binding,memberId:state.session?.member?.id,workspaceId:state.workspace?.workspace_id,route:state.route,routeId:state.route==='page'?state.page?.id:state.route==='database'?state.database?.id:null};
  if(!scope.controller||!scope.profileId)throw new Error('로그인한 뒤 기기 저장 내용을 확인해 주세요.');
  const pages=(state.workspace?.pages||[]).filter(page=>resourceLevel(page)>=3&&!page.locked&&!page.archived);if(scope.route==='page'&&pageEditable()&&!pages.some(page=>page.id===scope.routeId))pages.unshift(state.page);
  openModal('기기 저장과 동기화',`<p>${nativeCacheOnly()?'연결이 끊기면 변경을 앱 캐시에 보관합니다. 캐시를 지우거나 앱을 삭제하면 미전송 변경을 잃을 수 있으니 먼저 동기화하거나 복구 내용을 내려받으세요.':'연결이 끊겨도 변경을 이 기기에 보관합니다.'} 서버에서도 같은 값이 바뀌면 자동으로 덮어쓰지 않고 여기서 확인합니다.</p><div class="mutation-toolbar"><button class="solid-btn" id="sync-now" data-action="sync-now">지금 동기화</button><button class="outline-btn" data-action="export-mutations">전체 복구 내용 내려받기</button>${nativeRecoveryAvailable()?'<button class="outline-btn" data-action="native-recovery">앱 보관 내용 찾기</button>':''}</div><section id="recovery-archives" class="recovery-import-panel" aria-label="이전 로그인 편집 복구"></section><section class="recovery-import-panel" aria-label="복구 JSON 가져오기"><h3>복구 JSON 가져오기</h3><p>내려받은 복구 파일을 먼저 검토하세요. 가져온 항목은 자동으로 서버에 반영하지 않습니다.</p><label class="recovery-file-label">복구 파일 · 최대 16 MiB<input id="recovery-import-file" type="file" accept=".json,application/json" aria-label="복구 JSON 파일"></label><div class="recovery-import-controls"><label>본문 복구 위치<select id="recovery-target-page" aria-label="본문 복구 위치"><option value="">문서를 선택하세요</option>${pages.map(page=>`<option value="${esc(page.id)}" ${scope.route==='page'&&scope.routeId===page.id?'selected':''}>${esc(page.title||'제목 없음')}</option>`).join('')}</select></label><button class="outline-btn" data-action="prepare-recovery-import" disabled>미리보기 다시 확인</button></div><div id="recovery-import-preview" aria-live="polite"></div></section><div id="mutation-queue-list" aria-live="polite"></div>`,'mutation-modal');
  const view={scope,modal:$('.mutation-modal'),sequence:0,rawText:null,prepared:null};state.recoveryImport=view;loadRecoveryArchives(view);
  try{const records=await scope.controller.records();if(!recoveryImportCurrent(view))return;state.mutationRecords=records;renderMutationQueue();}catch(error){if(recoveryImportCurrent(view)){view.error=recoveryImportError(error);renderRecoveryImport(view);}}
}
async function syncMutations({controller=state.mutations,current=()=>true}={}) {
  const active=()=>!!controller&&state.mutations===controller&&!state.nativeOutboxPause&&!state.nativeRecoveryPaused&&current();if(!active())return;
  const initial=await controller.records();if(!active())return;
  const expected=new Set(initial.filter(record=>['pending','deferred'].includes(record.status)).map(record=>record.id));
  try{
    for(let attempt=0;attempt<3;attempt++){
      if(!active())return;await controller.sync();if(!active())return;
      const records=await controller.records();if(!active())return;
      const paused=new Set(records.filter(record=>!activeMutationStatuses.has(record.status)).map(record=>record.id));
      const remaining=records.filter(record=>expected.has(record.id)&&['pending','deferred'].includes(record.status));
      if(!remaining.length||remaining.every(record=>(record.operation.depends_on||[]).some(id=>paused.has(id))))break;
    }
  }catch(error){if(!active())return;if(error.status&&error.status<500)throw error;state.offline=true;toast('서버에 연결하지 못했습니다. 변경은 기기에 보관했으며 다시 연결되면 동기화합니다.');}
  if(!active())return;await refreshMutationUI(controller,active);
}
async function loadDatabaseData(id,{remote=!state.offline}={}) {
  const controller=await ensureMutations();
  const data=controller?await controller.loadDatabase(id,{remote}):await api('/databases/'+encodeURIComponent(id));
  if(controller&&controller!==state.mutations){const error=new Error('로그인 계정이 변경되었습니다.');error.code='STALE_REQUEST';throw error;}
  if(state.offlineProfile)await cachedResourceIds();
  return data;
}
async function api(path, body, method, options={}) {
  const workspaceScope=FountainTransport.workspaceScope?.(),transport=workspaceScope?FountainTransport.capture():FountainTransport;
  const requestMethod=String(method||(body?'POST':'GET')).toUpperCase();
  const ownLegacyTransition=FountainTransport.native===true&&!workspaceScope&&state.accountMode!==true&&path==='/session'&&['POST','DELETE'].includes(requestMethod);
  const requestScope={origin:FountainTransport.origin,generation:FountainTransport.generation,binding:state.session?.cache_binding,memberId:state.session?.member?.id,workspaceId:state.session?.workspace_id,epoch:FountainTransport.scopeEpoch,bootGeneration:state.bootGeneration};
  const stale=()=>{const error=new Error('로그인 상태가 변경되었습니다. 다시 확인해 주세요.');error.code='STALE_REQUEST';return error;};
  const assertCurrent=()=>{if(state.workspaceSwitching||options.current&&!options.current()||requestScope.origin!==FountainTransport.origin||requestScope.generation!==FountainTransport.generation||requestScope.workspaceId!==state.session?.workspace_id||requestScope.epoch!==FountainTransport.scopeEpoch||requestScope.binding!==state.session?.cache_binding||requestScope.memberId!==state.session?.member?.id||requestScope.bootGeneration!==state.bootGeneration)throw stale();};
  const responsePending = transport.request('/api' + path, {
    ...(options.signal?{signal:options.signal}:{}),method:requestMethod,headers: {
      'Content-Type':'application/json'
    }, ...(body ? {
      body:JSON.stringify(body)
    }
    : {
    })
  });
  // Legacy native authentication fences old requests synchronously when invoked.
  // Admit only this exact single transition; another auth/config/workspace change
  // must still reject the response, including changes during JSON consumption.
  if(ownLegacyTransition&&Number.isSafeInteger(requestScope.epoch)&&FountainTransport.scopeEpoch===requestScope.epoch+1&&requestScope.origin===FountainTransport.origin&&requestScope.generation===FountainTransport.generation&&!FountainTransport.workspaceScope?.())requestScope.epoch=FountainTransport.scopeEpoch;
  const response = await responsePending;
  assertCurrent();
  const data = await response.json().catch(()=>( {
    error:'응답을 읽을 수 없습니다.'
  }));
  assertCurrent();
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.message || '요청을 처리하지 못했습니다.');
    error.status = response.status;
    error.data=data;
    if(response.status===401&&path!=='/session'){
      const session=await transport.request('/api/session',options.signal?{signal:options.signal}:undefined).then(result=>result.json()).catch(()=>null);
      assertCurrent();
      if(session?.authenticated)throw stale();
      if(session)state.session=session;
      closeModal();renderLogin();
    }
    throw error;
  }
  return data;
}
function toast(message) {
  const target=$('#toast');
  target.textContent=message;
  target.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>target.classList.remove('visible'),3500);
}
function date(value) {
  return value ? new Date(value).toLocaleDateString('ko-KR', {
    month:'short',day:'numeric'
  }) : '방금 전';
}
function nameOf(row,db=state.database) {
  const prop=db?.properties?.find(p=>p.type==='title') || db?.properties?.[0];
  return (row.properties || row.values || {
  })[prop?.id || 'name'] || '제목 없음';
}
function valuesOf(row) {
  return row.properties || row.values || {
  };
}
function optionsOf(property) {
  return (property.options || []).map(o=>typeof o==='string'?o:o.name || o.label || o.value);
}
function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}
function status(value) {
  const v=String(value||'시작 전');
  return `<span class="status ${/진행|progress|doing/i.test(v)?'blue':/완료|done|complete/i.test(v)?'':'gray'}">${esc(v)}</span>`;
}
async function refreshWorkspace({adminView=null,adminCurrent=null}={}) {
  const binding=state.session?.cache_binding,member=state.session?.member?.id;
  const workspace=await api('/workspace');
  if(binding!==state.session?.cache_binding||member!==state.session?.member?.id||workspace.current_member_id&&workspace.current_member_id!==member||workspace.session_binding&&workspace.session_binding!==binding){const error=new Error('로그인 정보를 다시 확인합니다.');error.code='SESSION_CHANGED';throw error;}
  const controller=state.mutations,overlay=controller?await controller.workspace(workspace):workspace;
  if(binding!==state.session?.cache_binding||controller!==state.mutations){const error=new Error('로그인 계정이 변경되었습니다.');error.code='STALE_REQUEST';throw error;}
  let preserveAdmin=false;
  if(adminView){if(typeof adminCurrent!=='function'||!adminCurrent()||!adminCan(adminView,'content.restore.manage')||!await adminCheck(adminView)||!adminCurrent())return false;preserveAdmin=true;}
  if(binding!==state.session?.cache_binding||member!==state.session?.member?.id||controller!==state.mutations){const error=new Error('로그인 계정이 변경되었습니다.');error.code='STALE_REQUEST';throw error;}
  if(state.adminConsole&&state.serverWorkspace?.access_revision!==workspace.access_revision&&!preserveAdmin)closeModal();
  state.serverWorkspace=workspace;state.workspace=overlay;
  if(state.session?.authenticated&&window.FountainOffline)await cacheProfile().catch(error=>{if(error.name!=='SecurityError')toast(error.message);});
  renderSidebar();return true;
}
function renderSidebar() {
  const w=state.workspace;
  if(!w)return;
  const pages=w.pages.filter(p=>!p.deleted&&!p.deleted_at&&!p.archived&&(!state.offline||state.cachedPages?.has(p.id)));
  const favorite=pages.filter(p=>p.favorite);
  const roots=pages.filter(p=>!p.parent_id);
  const pageItem=(p,depth=0)=>`<div class="nav-item page-nav ${state.page?.id===p.id&&state.route==='page'?'active':''}" style="padding-left:${10+depth*13}px"><button data-action="page" data-id="${esc(p.id)}" class="nav-item" style="padding:0;min-height:23px"><span class="page-icon">${esc(p.is_wiki===true?'📚':p.icon||'📄')}</span><span class="label">${esc(p.title||'제목 없음')}</span></button><button class="page-menu" aria-label="하위 페이지 추가" data-action="add-page" data-parent="${esc(p.id)}">+</button></div>${pages.filter(q=>q.parent_id===p.id).map(q=>pageItem(q,Math.min(depth+1,4))).join('')}`;
  $('#sidebar').innerHTML=`<div class="brand"><span class="brand-mark">f</span>fountain<span style="font-family:sans-serif;font-size:9px;letter-spacing:1px;color:#a5a497;margin-left:2px;font-weight:400">WORKSPACE</span></div><button class="workspace-switch" data-action="${state.accountMode?'workspaces':'settings'}"><span class="workspace-avatar">F</span><span class="workspace-name">${esc(w.settings?.name||'Fountain 스튜디오')}<small>함께 만드는 작은 가능성</small></span>${icon('down')}</button><nav><button class="nav-item" data-action="search">${icon('search')}<span class="label">검색</span><span class="shortcut">⌘ K</span></button><button class="nav-item ${state.route==='home'?'active':''}" data-action="home">${icon('home')}<span class="label">홈</span></button><button class="nav-item" data-action="inbox">${icon('inbox')}<span class="label">알림함</span></button><button class="nav-item" data-action="activity">${icon('clock')}<span class="label">업데이트</span></button><button class="nav-item" data-action="ai">${icon('spark')}<span class="label">Fountain AI</span><span class="badge">AI</span></button></nav><div class="sidebar-pages"><div class="section-label">즐겨찾기<span>${icon('star')}</span></div>${favorite.length?favorite.map(p=>pageItem(p)).join(''):'<div class="small muted" style="padding:5px 12px;font-size:10px">자주 찾는 페이지를 모아보세요</div>'}<div class="section-label">팀스페이스<button data-action="new-teamspace" aria-label="팀스페이스 추가">+</button></div>${(w.teamspaces||[{id:'general',name:'Fountain 팀'}]).map(t=>`<button class="nav-item" data-action="teamspace" data-id="${esc(t.id)}"><span class="team-icon">${esc((t.name||'팀')[0])}</span><span class="label">${esc(t.name||'Fountain 팀')}</span>${icon('down')}</button>`).join('')}${(w.databases||[]).filter(d=>!state.offline||state.cachedDatabases?.has(d.id)).map(d=>`<button class="nav-item ${state.route==='database'&&state.database?.id===d.id?'active':''}" data-action="database" data-id="${esc(d.id)}" style="padding-left:20px"><span class="page-icon">${esc(d.icon||'▤')}</span><span class="label">${esc(d.name||d.title||'프로젝트')}</span></button>`).join('')}<div class="section-label">페이지<button data-action="add-page" aria-label="새 페이지">+</button></div>${roots.map(p=>pageItem(p)).join('')}<button class="nav-item muted" data-action="add-page">${icon('plus')}<span class="label">새 페이지</span></button><button class="nav-item muted" data-action="new-database">${icon('table')}<span class="label">새 데이터베이스</span></button></div><div class="sidebar-bottom">${state.offline?'<button class="nav-item" data-action="logout">로그아웃</button>':''}<button class="nav-item sync-status-button" data-action="sync-queue"><span aria-hidden="true">↻</span><span class="label" data-sync-label>기기 저장과 동기화</span></button><button class="nav-item" data-action="settings">${icon('settings')}<span class="label">설정 및 멤버</span></button><button class="nav-item" data-action="trash">${icon('trash')}<span class="label">휴지통</span></button><div class="invite-card"><strong>좋은 생각은, 함께 자라니까요.</strong>팀원을 초대하고 한곳에서 시작하세요.<br><button data-action="invite">멤버 초대하기 ↗</button></div></div>`;
  pruneAdministrativeControls();renderSyncIndicators();
}
function renderTopbar(title='홈',emoji='') {
  $('#topbar').innerHTML=`<div class="crumb"><button class="mobile-toggle" data-action="toggle-sidebar" aria-label="메뉴 열기">${icon('menu')}</button><button data-action="home">Fountain 스튜디오</button><span>/</span><span>${esc(emoji)}</span><span class="current">${esc(title)}</span></div><div class="top-actions"><span class="save-status" id="save-status">${state.route==='page'?'모든 변경 사항 저장됨':'나만의 리듬으로, 함께'}</span><button class="sync-status-button sync-topbar" data-action="sync-queue" title="기기 저장과 동기화"><span aria-hidden="true">↻</span><span data-sync-label>기기 저장</span></button><div id="page-presence" class="page-presence" aria-label="현재 페이지 접속자" role="status"></div>${state.route==='page'?`<button ${resourceLevel(state.page)<3?'disabled':''} data-action="favorite" aria-label="즐겨찾기">${icon('star')}</button><button data-action="share" aria-label="페이지 공유">${icon('share')}공유</button><button ${resourceLevel(state.page)<3?'disabled':''} data-action="history" aria-label="페이지 기록">${icon('clock')}</button><button data-action="page-menu" aria-label="페이지 메뉴">${icon('dots')}</button>`:`${state.route==='database'?`<button data-action="db-share">${icon('share')}공유</button>`:''}<button class="desktop-only" data-action="activity" aria-label="활동 기록">${icon('clock')}</button><button data-action="settings" aria-label="설정">${icon('dots')}</button>`}</div>`;
  pruneAdministrativeControls();renderSyncIndicators();renderPresenceParticipants(state.presenceManager?.participants||[]);
}
async function navigate(route,id) {
  if(state.nativeOutboxPause)return;
  if(state.nativeRecoveryPaused)return;
  settingsOpenSequence++;if(!state.verifiedPages?.opening)clearVerifiedPages();clearAdminConsole();
  state.uploadTargetPageId=route==='page'?id:null;state.uploadManager?.pauseAll('다른 문서를 여는 동안 파일 전송을 일시 중지했습니다.');
  const binding=state.session?.cache_binding,generation=state.bootGeneration;
  const navigation={route,id,binding,generation,opening:false};state.nativeNavigation=navigation;
  const current=()=>!state.nativeRecoveryPaused&&state.nativeNavigation===navigation&&binding===state.session?.cache_binding&&generation===state.bootGeneration;
  try {
    await saveTitle();if(!current())return;
    await savePage();if(!current())return;
    closeDocument();
    navigation.opening=true;
    closeModal();
    document.body.classList.remove('sidebar-open');
    state.route=route;if(route!=='page')state.localPageOnly=false;
    if(route==='page') {
      state.dirty=false;
      const local=await state.mutations?.localPage(id);
      if(!current())return;
      state.localPageOnly=!!local?.metadata.localOnly;
      if(state.offline||state.localPageOnly){
        const snapshot=local?.snapshot||await FountainOffline.getSnapshot(FountainOffline.key(state.offlineProfile,id));
        if(!current())return;
        if(!snapshot)throw new Error('이 페이지는 기기에 보관되어 있지 않습니다. 연결 후 한 번 열어 주세요.');
        await openDocument(id,null,snapshot);
      }else{
        const detail=await api('/pages/'+encodeURIComponent(id));if(!current())return;await openDocument(id,detail);
      }
      if(!current())return;renderPage();
      location.hash=new URL(FountainTransport.appURL('page/'+encodeURIComponent(id))).hash;
    }
    else if(route==='database') {
      state.localPageOnly=false;state.navigatingDatabaseId=id;
      const data=await loadDatabaseData(id);if(!current())return;state.navigatingDatabaseId=null;
      state.database=data.database;
      state.rows=data.rows||[];
      renderDatabase();
      location.hash=new URL(FountainTransport.appURL('database/'+encodeURIComponent(id))).hash;
    }
    else {
      renderHome();
      location.hash=new URL(FountainTransport.appURL('home')).hash;
    }
    renderSidebar();
    window.scrollTo(0,0);
    return true;
  }
  catch(error) {
    if(!current())return;
    if(!error.status&&error instanceof TypeError&&['page','database'].includes(route)&&!state.offline&&state.offlineProfile){state.offline=true;state.cachedPages=new Set((await FountainOffline.listSnapshots(state.offlineProfile)).map(record=>record.snapshot.page.id));await navigate(route,id);return;}
    state.navigatingDatabaseId=null;
    if(error.code==='STALE_REQUEST')return;if(error.code==='SESSION_CHANGED'){boot();return;}toast(error.message);
  }finally{if(state.nativeNavigation===navigation)state.nativeNavigation=null;}
}
function renderHome() {
  if(state.nativeOutboxPause)return;
  if(state.nativeRecoveryPaused)return;
  renderTopbar();
  const pages=state.workspace.pages.filter(p=>!p.deleted&&!p.deleted_at&&!p.archived&&(!state.offline||state.cachedPages?.has(p.id))).slice(0,3);
  const today=new Date().toLocaleDateString('ko-KR', {
    month:'long',day:'numeric',weekday:'long'
  });
  $('#main').innerHTML=`<div class="main-inner"><div class="welcome-row"><div><div class="date-label">${esc(today)}</div><h1>반가워요, 오늘도 좋은 하루예요 <span style="font-size:25px">☀️</span></h1><p>생각을 정리하고, 함께 만드는 일에 집중해 보세요.</p></div><button class="outline-btn" data-action="add-page">${icon('plus')}새 페이지</button></div><section class="hero"><div class="hero-text"><div class="eyebrow">A LITTLE SPACE, BIG POSSIBILITIES</div><h2>흩어져 있던 생각이<br>하나의 가능성이 되는 곳.</h2><p>문서부터 프로젝트, 팀의 모든 이야기를 Fountain에 담아보세요.</p><button data-action="page" data-id="${esc(pages[0]?.id||'welcome')}">우리 워크스페이스 둘러보기 ${icon('arrow')}</button></div><div class="hero-art" aria-hidden="true"><div class="art-orbit"></div><div class="art-paper"><i></i><i></i><i></i><i></i></div><div class="art-card"></div><div class="art-flower">✳</div></div></section><section><div class="section-heading"><h2>${icon('clock')}최근 방문한 페이지</h2><button data-action="search">모든 페이지 ${icon('chevron')}</button></div><div class="recent-grid">${pages.map((p,i)=>`<button class="page-card" data-action="page" data-id="${esc(p.id)}"><div class="card-cover c${i}"></div><div class="card-body"><div class="card-title"><span>${esc(p.icon||['🌿','📝','💡'][i])}</span>${esc(p.title||'제목 없음')}</div><div class="card-meta"><span>Fountain 스튜디오</span><span>${date(p.updated_at)} 수정</span></div></div></button>`).join('')}${pages.length<3?`<button class="page-card" data-action="add-page"><div class="card-cover c2"><span style="z-index:1;font-size:23px;color:#8b9da4">+</span></div><div class="card-body"><div class="card-title">새로운 아이디어</div><div class="card-meta">빈 페이지에서 시작해 보세요</div></div></button>`:''}</div></section><div class="dashboard-bottom"><section><div class="section-heading"><h2>${icon('table')}우리 팀 프로젝트</h2><button data-action="database" data-id="${esc(state.workspace.databases?.[0]?.id||'projects')}">전체 보기 ${icon('chevron')}</button></div><div class="panel" id="home-database"><div class="empty">프로젝트를 불러오는 중…</div></div></section><section class="activity-panel"><div class="section-heading"><h2>${icon('inbox')}워크스페이스 소식</h2><button data-action="activity">${icon('dots')}</button></div><div class="activity-list" id="home-activity"><div class="activity"><span class="activity-avatar">F</span><p><strong>Fountain</strong>에 오신 것을 환영해요.<span class="activity-page">🌱 함께 만드는 워크스페이스</span><small>오늘</small></p></div></div><div class="quote-card">“위대한 일은 작은 일들이<br>모여 이루어집니다.”<span>작은 시작을 응원하는 Fountain</span></div></section></div><footer class="footer-line"><span><i></i>모든 변경 사항이 안전하게 저장됩니다</span><span>Made for your flow. &nbsp; ✳ Fountain</span></footer></div>`;
  loadHomeData();
  pruneAdministrativeControls();
}
async function loadHomeData() {
  const id=state.workspace.databases?.find(database=>!state.offline||state.cachedDatabases?.has(database.id))?.id;
  if(id) {
    try {
      const data=await loadDatabaseData(id);
      if(state.route!=='home')return;
      state.database=data.database;
      state.rows=data.rows||[];
      $('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;applyDatabaseControls();
    }
    catch(e) {
      if($('#home-database'))$('#home-database').innerHTML=`<div class="empty">${esc(e.message)}<br><button data-action="new-database">데이터베이스 만들기</button></div>`;
    }
  }
  else if($('#home-database'))$('#home-database').innerHTML=state.offline?'<div class="empty">기기에 보관한 데이터베이스가 없습니다.<br>연결한 상태에서 한 번 열어 주세요.</div>':'<div class="empty"><button data-action="new-database">+ 첫 데이터베이스 만들기</button></div>';
  if(state.offline||!isOwner())return;
  try {
    const data=await api('/audit');
    const records=normalizeList(data.events||data.audit||data.entries||data);
    if(state.route==='home'&&records.length)$('#home-activity').innerHTML=records.slice(0,3).map((r,i)=>`<div class="activity"><span class="activity-avatar">${['F','나','팀'][i]}</span><p><strong>${esc(r.actor_name||r.user||r.actor||'워크스페이스')}</strong><br>${esc(r.action||r.event||'새로운 활동')}<span class="activity-page">${esc(r.target_name||r.resource_type||'')}</span><small>${date(r.created_at||r.timestamp)}</small></p></div>`).join('');
  }
  catch {
  }
}
function richTokensFromChars(chars) {
  const tokens=[];for(const char of chars){const marks=char.marks||{};if(tokens.length&&FountainCollaboration.canonical(tokens.at(-1).marks)===FountainCollaboration.canonical(marks))tokens.at(-1).text+=char.text;else tokens.push({text:char.text,marks:{...marks}});}return tokens;
}
function nestBlock(id,direction,grouped=false) {
  if(!grouped)return editorTransaction('structure',()=>nestBlock(id,direction,true));
  if(!blockEditable())return;
  readBlocks();const block=state.blocks.find(item=>item.id===id),index=state.blocks.indexOf(block);if(!block)return;
  if(direction>0){const previous=[...state.blocks.slice(0,index)].reverse().find(item=>(item.parent_id||null)===(block.parent_id||null));if(!previous)return toast('앞에 있는 블록 아래로 들여쓸 수 있습니다.');block.parent_id=previous.id;}
  else{const parent=state.blocks.find(item=>item.id===block.parent_id);if(!parent)return;block.parent_id=parent.parent_id||null;}
  renderBlocks(id);scheduleSave();
}
document.addEventListener('beforeinput',event=>{
  if((event.target.id==='page-title'||event.target.closest?.('.block-content'))&&!pageEditable()){event.preventDefault();return;}
  if(event.target.id==='page-title'&&!state.titlePending)state.titleInputBasis={...structuredClone(state.pageViewBasis||state.page),title:event.target.innerText.trim()||'제목 없음'};
  const element=event.target.closest?.('.block-content');if(!element||!state.channel)return;
  if(historyInput(event))return;if(!blockEditable()){event.preventDefault();return;}if(state.composition)return;
  state.inputBaseline={id:element.closest('.block').dataset.id,chars:state.channel.chars(element.closest('.block').dataset.id),selection:selectedTextPosition(),kind:['insertParagraph','insertLineBreak'].includes(event.inputType)?'structure':'typing'};
});
document.addEventListener('compositionstart',event=>{
  const element=event.target.closest?.('.block-content');if(!element||!state.channel)return;
  if(!blockEditable())return;state.channel.breakHistory();const id=element.closest('.block').dataset.id;state.composition={id,chars:state.channel.chars(id),selection:selectedTextPosition()};
});
document.addEventListener('compositionend',event=>{
  const element=event.target.closest?.('.block-content'),composition=state.composition;if(!element||!composition)return;
  queueMicrotask(()=>{if(state.composition!==composition)return;state.composition=null;commitEditableText(element,composition.chars,{kind:'composition',beforeSelection:composition.selection});state.channel?.breakHistory();state.inputBaseline=null;patchDocumentBlocks();scheduleSave();});
});
document.addEventListener('pointerdown',event=>{
  const control=event.target.closest?.('.rich-toolbar');if(!control)return;
  state.richSelection=richSelection();if(event.target.closest('button'))event.preventDefault();
});
document.addEventListener('focusin',event=>{if(!event.target.closest?.('.block-content,.rich-toolbar'))state.channel?.breakHistory();});
document.addEventListener('selectionchange',()=>{
  if(!state.composition)state.presenceManager?.update();
  if(document.activeElement?.closest?.('.block-content')){state.richSelection=richSelection();const selected=selectedTextPosition();if(!state.composition&&state.expectedSelection&&FountainCollaboration.canonical(selected)!==FountainCollaboration.canonical(state.expectedSelection))state.channel?.breakHistory();state.expectedSelection=selected;}
});
window.addEventListener('fountain-offline-profile-changed',async()=>{
  if(state.workspaceSwitching||state.nativeOutboxPause||state.nativeRecoveryPaused||state.authSuspending)return;
  const generation=state.bootGeneration,current=await FountainOffline.getProfile().catch(()=>null);
  if(state.nativeRecoveryPaused||generation!==state.bootGeneration)return;
  if(state.offlineProfile&&current?.id!==state.offlineProfile.id||current&&current.session.cache_binding!==state.session?.cache_binding){if(!await suspendLoginInput(state.offlineProfile))return;state.offlineProfile=null;state.page=null;state.blocks=[];await boot();}
});
window.addEventListener('fountain-offline-profile-cleared',event=>{
  if(state.loaded&&state.offlineProfile?.id===event.detail?.profileId)renderLogin(false);
});
window.addEventListener('fountain-offline-resource-purged',event=>{
  if(state.nativeRecoveryPaused)return;
  if(!state.offlineProfile||!event.detail?.key)return;
  let id;try{id=decodeURIComponent(event.detail.key.split('|').at(-1));}catch{return;}
  if(event.detail.kind==='database'||event.detail.key.split('|').length===6){if(FountainOffline.databaseKey(state.offlineProfile,id)===event.detail.key)closeDeniedResource({kind:'database',databaseId:id});return;}
  if(FountainOffline.key(state.offlineProfile,id)!==event.detail.key)return;
  if(state.workspace){state.workspace.pages=state.workspace.pages.filter(page=>page.id!==id);if(state.route==='home')renderHome();renderSidebar();}
});
window.addEventListener('offline',async()=>{
  if(state.nativeRecoveryPaused)return;
  state.offline=true;const profile=state.offlineProfile,generation=state.bootGeneration,binding=state.session?.cache_binding;if(!profile)return;
  const current=()=>!state.nativeRecoveryPaused&&generation===state.bootGeneration&&state.offlineProfile?.id===profile.id&&binding===state.session?.cache_binding;
  const snapshots=await FountainOffline.listSnapshots(profile);if(!current())return;
  state.cachedPages=new Set(snapshots.map(record=>record.snapshot.page.id));await cachedResourceIds();if(!current())return;renderSidebar();renderSyncIndicators();if(state.route==='home')renderHome();else if(state.route==='database')renderDatabase();
});
window.addEventListener('online',async()=>{
  if(state.accountMode&&(!state.account?.session?.authenticated||FountainTransport.workspaceScope?.()?.offline)){await boot();return;}
  if(!state.loaded||state.nativeRecoveryPaused)return;
  if(!state.mutations){if(!state.channel&&state.offline)boot();return;}
  const controller=state.mutations,binding=state.session?.cache_binding;
  try{
    const session=await api('/session');if(state.mutations!==controller||binding!==state.session?.cache_binding)return;
    if(!session.authenticated||session.cache_binding!==binding){boot();return;}
    state.offline=false;await refreshWorkspace();if(state.nativeOutboxPause||state.mutations!==controller)return;
    await syncMutations();
    if(state.route==='database'&&!$('.modal'))await reloadDatabase();
    renderSyncIndicators();pruneAdministrativeControls();
  }catch(error){if(!error.status)state.offline=true;else toast(error.message);renderSyncIndicators();}
});

function insertPlainText(element,text,grouped=false) {
  if(!grouped)return editorTransaction('paste',()=>insertPlainText(element,text,true));
  if(!blockEditable()||!state.channel)return;
  const id=element.closest('.block').dataset.id,baseline=state.channel.chars(id),selection=getSelection();
  if(!selection.rangeCount||!element.contains(selection.anchorNode)){element.focus();const range=document.createRange();range.selectNodeContents(element);range.collapse(false);selection.removeAllRanges();selection.addRange(range);}
  const range=selection.getRangeAt(0);range.deleteContents();const node=document.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);commitEditableText(element,baseline);scheduleSave();
}
document.addEventListener('paste',event=>{
  const element=event.target.closest?.('.block-content');if(!element)return;event.preventDefault();insertPlainText(element,event.clipboardData?.getData('text/plain')||'');
});
document.addEventListener('drop',event=>{
  const element=event.target.closest?.('.block-content');if(!element||dragId)return;event.preventDefault();
  if(event.dataTransfer?.files?.length){attachFile(event.dataTransfer.files[0]).catch(error=>toast(error.message));return;}
  insertPlainText(element,event.dataTransfer?.getData('text/plain')||'');
});

function metadataWorkspace(workspace) {
  return {...workspace,pages:(workspace.pages||[]).map(page=>{const value={...page};delete value.blocks;return value;})};
}
function recentPageIds(profile=state.offlineProfile) {
  if(!profile)return [];try{const values=JSON.parse(localStorage.getItem('fountain-recent:'+profile.id)||'[]');return Array.isArray(values)?values.filter(value=>typeof value==='string').slice(0,12):[];}catch{return [];}
}
function recordRecentPage(id) {if(state.offlineProfile)localStorage.setItem('fountain-recent:'+state.offlineProfile.id,JSON.stringify([id,...recentPageIds().filter(value=>value!==id)].slice(0,12)));}
async function warmOfflinePages() {
  const profile=state.offlineProfile,generation=state.bootGeneration;if(state.nativeOutboxPause||!profile||state.offline)return;
  const allowed=new Set(state.workspace.pages.filter(page=>!page.archived).map(page=>page.id));
  const ids=[...new Set([...state.workspace.pages.filter(page=>page.favorite&&!page.archived).map(page=>page.id),...recentPageIds(profile)])].filter(id=>allowed.has(id)).slice(0,20);
  for(const id of ids){
    if(state.nativeOutboxPause||generation!==state.bootGeneration||state.offlineProfile?.id!==profile.id)return;
    const key=FountainOffline.key(profile,id);
    try{
      if((await state.mutations?.localPage(id))?.metadata.localOnly)continue;
      const response=await FountainTransport.request('/api/pages/'+encodeURIComponent(id)+'/collaboration');
      if(state.nativeOutboxPause||generation!==state.bootGeneration||state.offlineProfile?.id!==profile.id)return;
      if([403,404].includes(response.status)){await FountainOffline.purgeResource(key);continue;}
      if(!response.ok)continue;const snapshot=await response.json();
      if(snapshot.session_binding!==profile.session.cache_binding||snapshot.workspace_id!==profile.workspaceId||snapshot.page?.id!==id||generation!==state.bootGeneration||state.offlineProfile?.id!==profile.id)continue;
      await FountainOffline.saveSnapshot(key,snapshot);
    }catch{/* Background warming never substitutes cached data for an HTTP denial. */}
  }
}
async function cacheProfile(workspaceId=state.workspace?.workspace_id||state.session?.workspace_id) {
  if(!window.FountainOffline||!workspaceId)return null;
  const session=state.session,workspace=state.workspace;
  if(workspace.current_member_id&&workspace.current_member_id!==session.member.id||workspace.session_binding&&workspace.session_binding!==session.cache_binding)throw new Error('로그인과 워크스페이스 정보가 일치하지 않습니다.');
  const profile=await FountainOffline.saveProfile({workspaceId,memberId:session.member.id,session,workspace:metadataWorkspace(state.serverWorkspace||workspace)});
  if(session.cache_binding!==state.session?.cache_binding){const error=new Error('로그인 계정이 변경되었습니다.');error.code='STALE_REQUEST';throw error;}
  state.offlineProfile=profile;return profile;
}
function closeDocument() {
  // The previous page stays visible while the next authority/snapshot is in
  // flight. It must stop accepting input as soon as its channel is closed.
  for(const element of $$('#page-title,#blocks .block-content'))element.contentEditable='false';
  for(const control of $$('.editor-wrap button,.editor-wrap input,.editor-wrap select,.editor-wrap textarea'))control.disabled=true;
  clearWikiMutation();clearWikiPage();
  if(state.versionView||state.verificationView)closeModal();clearTimeout(state.verificationTimer);state.verificationTimer=null;state.versions=[];
  state.presenceManager?.close();state.presenceManager=null;state.presenceChannel=null;
  state.uploadManager?.dispose();state.uploadManager=null;state.uploadReselectId=null;
  state.channel?.close();state.channel=null;state.history={};state.expectedSelection=null;state.renderedChars=new Map();state.composition=null;state.inputBaseline=null;clearTimeout(state.saveTimer);state.saveTimer=null;state.recoveryDrafts=[];
}
function documentStatus({status,pending,durable=true}) {
  if(state.nativeOutboxPause)return;
  if(!state.channel||state.route!=='page')return;
  state.offline=!navigator.onLine||status==='offline';state.dirty=durable===false;
  const element=$('#save-status');if(element)element.textContent=FountainTransport.native&&FountainTransport.outboxEnabled&&authenticationMemory().length?'보관된 입력 복구 확인 필요':status==='offline'?(durable?(nativeCacheOnly()?'오프라인 · 앱 캐시에 보관됨':'오프라인 · 기기에 저장됨'):'오프라인 · 기기 저장 실패'):status==='error'?'동기화 확인 필요':state.localPageOnly?(nativeCacheOnly()?'앱 캐시에 보관됨 · 새 페이지 동기화 대기':'기기에 저장됨 · 새 페이지 동기화 대기'):pending?'변경 사항 동기화 중…':'모든 변경 사항 저장됨';
  $('#offline-state')?.remove();
  if(state.offline){const note=document.createElement('div');note.id='offline-state';note.className='offline-notice';note.textContent=nativeCacheOnly()?'오프라인에서 문서를 편집하고 있습니다. 변경은 앱 캐시에 보관되며 연결되면 동기화합니다. 캐시를 지우거나 앱을 삭제하면 미전송 변경을 잃을 수 있습니다. 댓글·파일·공유 설정은 연결 후 사용할 수 있습니다.':'오프라인에서 문서를 편집하고 있습니다. 연결되면 변경 사항을 합칩니다. 제목과 문서, 보관한 데이터베이스의 변경은 이 기기에 저장됩니다. 댓글·파일·공유 설정은 연결 후 사용할 수 있습니다.';$('.editor-wrap')?.prepend(note);}
  const title=$('#page-title');if(title)title.contentEditable=String(pageEditable());
  const comment=$('#comment-form');if(comment)comment.hidden=state.offline||state.localPageOnly||resourceLevel(state.page)<2;
  renderSyncIndicators();ensurePresence();refreshHistoryControls();
}
function renderPresenceParticipants(participants) {
  const container=$('#page-presence');if(!container)return;
  container.replaceChildren();if(state.route!=='page'||state.offline||!participants.length)return;
  const people=document.createElement('span');people.className='presence-avatars';
  for(const person of participants.slice(0,3)){
    const avatar=document.createElement('span');avatar.className='presence-avatar';avatar.style.setProperty('--presence-color',person.color);avatar.textContent=Array.from(person.name)[0]||'·';avatar.title=person.name;people.append(avatar);
  }
  const count=document.createElement('span');count.className='presence-count';count.textContent=participants.length+'명 접속';count.dataset.short=participants.length+'명';container.append(people,count);container.title=participants.map(person=>person.name).join(', ');
}
function ensurePresence() {
  const channel=state.channel,profile=state.offlineProfile;
  if(state.nativeOutboxPause||!window.FountainPresence||!channel||!profile||state.route!=='page'||state.openingDocument)return;
  if(state.presenceManager&&state.presenceChannel===channel){
    if(state.presenceManager.epoch!==channel.base.epoch)state.presenceManager.restart(channel.base.epoch);
    if(state.offline||state.localPageOnly||channel.remoteDeferred)state.presenceManager.pause({leave:!state.offline});else state.presenceManager.start();state.presenceManager.layout();return;
  }
  state.presenceManager?.close();
  const manager=new FountainPresence.Manager({pageId:channel.pageId,profile,clientId:channel.clientId,epoch:channel.base.epoch,
    isAuthorized:()=>state.offlineProfile?.id===profile.id&&state.session?.cache_binding===profile.session.cache_binding&&state.session?.member?.id===profile.memberId,
    isCurrent:()=>state.channel===channel&&state.route==='page'&&state.page?.id===channel.pageId&&!state.offline&&!state.localPageOnly&&!channel.remoteDeferred&&resourceLevel(state.page)>=1,
    getSelection:()=>{const selection=selectedTextPosition();return selection&&!state.composition?{block_id:selection.id,anchor:selection.anchor,focus:selection.focus}:null;},
    getBlockElement:id=>$(`.block[data-id="${CSS.escape(id)}"] .block-content`),getChars:id=>channel.chars(id),
    onParticipants:participants=>{if(state.presenceManager===manager)renderPresenceParticipants(participants);},
    onDenied:async()=>{if(state.presenceManager===manager&&state.channel===channel)await channel.reconnect();}
  });
  state.presenceManager=manager;state.presenceChannel=channel;manager.start();
}
function selectedTextPosition() {
  const selection=getSelection();if(!selection?.rangeCount)return null;
  const node=selection.anchorNode?.nodeType===Node.ELEMENT_NODE?selection.anchorNode:selection.anchorNode?.parentElement;
  const element=node?.closest?.('.block-content');if(!element)return null;
  const focusNode=selection.focusNode?.nodeType===Node.ELEMENT_NODE?selection.focusNode:selection.focusNode?.parentElement;
  if(!element.contains(focusNode)&&focusNode!==element)return null;
  const offset=(target,index)=>{const range=document.createRange();range.selectNodeContents(element);try{range.setEnd(target,index);return Array.from(range.toString()).length;}catch{return 0;}};
  const id=element.closest('.block').dataset.id,chars=state.renderedChars?.get(id)||state.channel?.chars(id)||[];
  const point=value=>({before:value?chars[value-1]?.id:null,after:chars[value]?.id||null,offset:value});
  return {id,anchor:point(offset(selection.anchorNode,selection.anchorOffset)),focus:point(offset(selection.focusNode,selection.focusOffset))};
}
function restoreTextPosition(saved) {
  if(!saved||!state.channel)return;
  const element=$(`.block[data-id="${CSS.escape(saved.id)}"] .block-content`);if(!element)return;
  const chars=state.channel.chars(saved.id);
  const index=point=>{let found=point.before?chars.findIndex(char=>char.id===point.before):-1;if(found>=0)return found+1;found=point.after?chars.findIndex(char=>char.id===point.after):-1;return found>=0?found:Math.min(point.offset,chars.length);};
  const locate=position=>{let remaining=position,walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),node;while((node=walker.nextNode())){const points=Array.from(node.textContent);if(remaining<=points.length)return [node,points.slice(0,remaining).join('').length];remaining-=points.length;}return [element,element.childNodes.length];};
  const anchor=locate(index(saved.anchor)),focus=locate(index(saved.focus)),selection=getSelection();element.focus({preventScroll:true});selection.setBaseAndExtent(anchor[0],anchor[1],focus[0],focus[1]);
}
function patchDocumentBlocks(saved=selectedTextPosition()) {
  if(state.nativeOutboxPause)return;
  const container=$('#blocks');if(!container)return;
  const scratch=document.createElement('div');scratch.innerHTML=state.blocks.map(blockHTML).join('');
  const retained=new Map([...container.children].map(element=>[element.dataset.id,element]));
  for(const fresh of [...scratch.children]){
    const old=retained.get(fresh.dataset.id);retained.delete(fresh.dataset.id);
    if(old&&old.outerHTML===fresh.outerHTML)container.append(old);else{if(old)old.replaceWith(fresh);container.append(fresh);}
  }
  for(const old of retained.values())old.remove();
  state.renderedChars=new Map(state.blocks.map(block=>[block.id,state.channel?.chars(block.id)||[]]));
  restoreTextPosition(saved);state.presenceManager?.layout();if(!state.composition)state.presenceManager?.update();
}
async function openDocument(id,detail,cachedSnapshot) {
  if(state.nativeRecoveryPaused)return;
  const binding=state.session?.cache_binding,generation=state.bootGeneration;
  const navigation=state.nativeNavigation;
  const current=()=>!state.nativeRecoveryPaused&&(!navigation||state.nativeNavigation===navigation)&&binding===state.session?.cache_binding&&generation===state.bootGeneration;
  const snapshot=cachedSnapshot||await api('/pages/'+encodeURIComponent(id)+'/collaboration');
  if(!current())return;
  if(binding!==state.session?.cache_binding||snapshot.session_binding&&snapshot.session_binding!==binding){const error=new Error('로그인 계정이 변경되었습니다.');error.code='SESSION_CHANGED';throw error;}
  if(!state.offlineProfile&&!cachedSnapshot)await cacheProfile(snapshot.workspace_id);
  if(!current())return;
  if(!state.offlineProfile)throw new Error('오프라인 저장 프로필을 확인하지 못했습니다. 다시 로그인해 주세요.');
  state.page=metadataOverlay({...snapshot.page,access_level:snapshot.access_level},snapshot);state.blocks=snapshot.blocks;
  state.comments=detail?.comments||[];state.openingDocument=true;
  const channel=new FountainCollaboration.DocumentChannel({pageId:id,profile:state.offlineProfile,fetcher:api,deferRemote:!!state.localPageOnly,
    onPresence:payload=>{if(state.channel===channel){ensurePresence();state.presenceManager?.receive(payload);}},
    onChange:change=>{
      if(state.nativeOutboxPause||state.channel!==channel||state.route!=='page')return;
      const beforeEditable=pageEditable(),selection=change.selection||selectedTextPosition();
      state.page=metadataOverlay({...change.snapshot.page,access_level:change.snapshot.access_level},change.snapshot);state.blocks=change.blocks;invalidateVersionView();invalidateVerificationView();
      if(!pageEditable())state.uploadManager?.pauseAll('문서가 읽기 전용으로 바뀌어 전송을 일시 중지했습니다.');
      ensurePresence();
      if(state.nativeOutboxPause||state.openingDocument||state.composition)return;
      if(beforeEditable!==pageEditable()){renderPage();return;}
      patchDocumentBlocks(selection);
      patchPageMetadataUI();
    },onHistory:history=>{if(state.channel===channel)refreshHistoryControls(history);},onStatus:documentStatus,onDraft:drafts=>{if(state.channel===channel){state.recoveryDrafts=drafts;renderRecoveryDrafts();}},
    onError:error=>{if(state.channel===channel)toast(error.message);},
    onDenied:async({status,message,switched})=>{
      if(state.channel!==channel)return;
      if(status===401){if(!await suspendLoginInput(state.offlineProfile))return;if(switched||state.session?.mode==='local'&&state.session.required===false){state.offlineProfile=null;await boot();}else renderLogin(false);return;}
      closeDocument();state.page=null;state.blocks=[];state.dirty=false;
      if(switched){state.offlineProfile=null;boot();return;}
      if(status===401)renderLogin(false);else{$('#main').innerHTML=`<div class="empty"><h2>이 문서에 접근할 수 없습니다.</h2><p>${esc(message)}</p><button class="outline-btn" data-action="home">홈으로 돌아가기</button></div>`;if(state.workspace)state.workspace.pages=state.workspace.pages.filter(page=>page.id!==id);renderSidebar();renderTopbar('접근 권한 없음');}
    }});
  state.channel=channel;await channel.open(snapshot,{cached:!!cachedSnapshot});if(!current()||state.channel!==channel){channel.close();return;}state.openingDocument=false;if(state.localPageOnly&&!state.blocks.length&&pageEditable()){channel.transact({kind:'structure',record:false},()=>channel.reconcile([{id:uid(),type:'paragraph',text:'',parent_id:null}]));await channel.persistence;}recordRecentPage(id);
}
function richTextHTML(block) {
  const tokens=block.rich_text?.map(token=>token.text).join('')===block.text?block.rich_text:[{text:block.text||'',marks:{}}];
  return (tokens||[]).map(token=>{
    const marks=token.marks||{},classes=FountainCollaboration.BOOL_MARKS.filter(mark=>marks[mark]===true).map(mark=>'rich-'+mark);
    if(FountainCollaboration.PALETTE.includes(marks.color)&&marks.color!=='default')classes.push('rich-color-'+marks.color);
    if(FountainCollaboration.PALETTE.includes(marks.background)&&marks.background!=='default')classes.push('rich-background-'+marks.background);
    let text=esc(token.text);if(classes.length)text=`<span class="${classes.join(' ')}">${text}</span>`;
    if(marks.link){try{FountainCollaboration.validateMarks({link:marks.link});text=`<a href="${esc(marks.link)}" rel="noopener noreferrer" class="rich-link">${text}</a>`;}catch{/* Invalid cached links are rendered as plain text. */}}
    return text;
  }).join('');
}
function blockDepth(block) {let depth=0,parent=block.parent_id,seen=new Set([block.id]);while(parent&&!seen.has(parent)){seen.add(parent);depth++;parent=state.blocks.find(item=>item.id===parent)?.parent_id;}return Math.min(depth,8);}
function reconcileEditor() {
  if(!state.channel||state.composition||state.reconciling||!blockEditable())return [];
  readBlocks();const desired=structuredClone(state.blocks);if(FountainCollaboration.canonical(FountainCollaboration.normalizeBlocks(desired))===FountainCollaboration.canonical(FountainCollaboration.normalizeBlocks(FountainCollaboration.project(state.channel.state))))return [];state.reconciling=true;
  try{return state.channel.reconcile(desired);}finally{state.reconciling=false;}
}
function commitEditableText(element,baseline,meta={},grouped=false) {
  if(!grouped)return editorTransaction(meta.kind||state.inputBaseline?.kind||'typing',()=>commitEditableText(element,baseline,meta,true),{blockId:element.closest('.block').dataset.id,beforeSelection:meta.beforeSelection||state.inputBaseline?.selection||selectedTextPosition()});
  if(!state.channel||!blockEditable()||state.composition)return;
  const id=element.closest('.block').dataset.id;
  const raw=editorPlainText(element);
  const offset=selectedTextPosition();
  const operations=state.channel.replaceText(id,raw,baseline||state.channel.chars(id),state.typingMarks);
  const inserted=operations.filter(operation=>operation.type==='text.insert').at(-1);
  if(offset&&inserted&&offset.anchor.offset===offset.focus.offset){const id=inserted.id+':'+(Array.from(inserted.text).length-1);offset.anchor={before:id,after:null,offset:offset.anchor.offset};offset.focus={...offset.anchor};restoreTextPosition(offset);state.expectedSelection=selectedTextPosition();return operations;}
  if(offset){const chars=state.channel.chars(id);const point=offset.anchor.offset;offset.anchor={before:chars[point-1]?.id||null,after:chars[point]?.id||null,offset:point};const end=offset.focus.offset;offset.focus={before:chars[end-1]?.id||null,after:chars[end]?.id||null,offset:end};restoreTextPosition(offset);}state.expectedSelection=selectedTextPosition();return operations;
}
function richSelection() {
  const position=selectedTextPosition();if(!position)return null;
  const chars=state.channel?.chars(position.id)||[];const start=Math.min(position.anchor.offset,position.focus.offset),end=Math.max(position.anchor.offset,position.focus.offset);
  return {id:position.id,position,chars:chars.slice(start,end),start,end};
}
function applyRichMark(mark,value) {
  if(!blockEditable()||!state.channel)return;
  const selected=state.richSelection||richSelection();if(!selected)return toast('먼저 글자를 선택해 주세요.');
  if(!selected.chars.length){state.channel.breakHistory();state.typingMarks={...(state.typingMarks||{}),[mark]:value};toast('다음에 입력할 글자에 서식을 적용합니다.');return;}
  editorTransaction('format',()=>state.channel.format(selected.id,selected.chars.map(char=>char.id),{[mark]:value}),{beforeSelection:selected.position,afterSelection:selected.position});restoreTextPosition(selected.position);state.richSelection=richSelection();
}
function renderRecoveryDrafts() {
  $('#recovery-drafts')?.remove();if(!state.recoveryDrafts?.length||!$('.editor-wrap'))return;
  const section=document.createElement('section');section.id='recovery-drafts';section.className='recovery-drafts';
  section.innerHTML=`<strong>보관된 편집 내용 ${state.recoveryDrafts.length}개</strong><p>문서가 이전 버전으로 복원되었거나 편집 권한이 바뀌었습니다. 현재 문서와 합칠지 확인한 뒤 복구하세요.</p>${state.recoveryDrafts.map((record,index)=>`<div><span>${esc(new Date(record.updatedAt).toLocaleString('ko-KR'))}</span><button class="outline-btn" data-action="export-recovery" data-index="${index}">내용 내려받기</button>${pageEditable()&&record.draft.blocks?.length?`<button class="outline-btn" data-action="apply-recovery" data-index="${index}">복구 내용을 새 블록으로 추가</button>`:''}</div>`).join('')}`;
  $('.editor-wrap').prepend(section);
}

function renderPage() {
  if(state.nativeOutboxPause)return;
  if(state.nativeRecoveryPaused)return;
  const p=state.page;state.pageViewBasis=structuredClone(p);
  renderTopbar(p.title,p.icon);
  $('#main').innerHTML=`${p.cover?'<div class="page-cover"></div>':''}<article class="editor-wrap ${p.cover?'has-cover':''}"><button class="page-emoji" data-action="change-icon" aria-label="페이지 아이콘 변경">${esc(p.icon||'📄')}</button><h1 class="page-title" id="page-title" contenteditable="${pageEditable()}" role="textbox" aria-label="페이지 제목">${esc(p.title)}</h1><div id="wiki-owner-status" class="wiki-owner-status"></div><section id="wiki-panel" class="wiki-panel"></section><div id="page-verification-status" class="page-verification-status" role="status" aria-live="polite"></div><div class="page-tools" style="flex-wrap:wrap"><span>${icon('clock')}</span><span>${date(p.updated_at)} 수정</span><button data-action="favorite" class="${p.favorite?'favorite-on':''}">${p.favorite?'★ 즐겨찾기':'☆ 즐겨찾기'}</button><button data-action="toggle-cover">${p.cover?'커버 제거':'커버 추가'}</button>${!pageEditable()?'<span>🔒 읽기 전용</span>':'<button data-action="add-file" title="파일당 최대 5 GB">📎 파일 추가</button><input id="attachment-input" type="file" aria-label="첨부할 파일 (최대 5 GB)" hidden>'}<button data-action="ai" style="margin-left:auto">✦ AI 도우미</button></div><div id="wiki-home-content">${pageEditable()?`<div class="rich-toolbar" aria-label="본문 편집"><button data-action="undo" aria-label="실행 취소" title="실행 취소 (⌘/Ctrl Z)">↶</button><button data-action="redo" aria-label="다시 실행" title="다시 실행 (⌘/Ctrl Shift Z)">↷</button><span class="history-divider" aria-hidden="true"></span><button data-action="rich-mark" data-mark="bold" aria-label="굵게"><b>B</b></button><button data-action="rich-mark" data-mark="italic" aria-label="기울임"><i>I</i></button><button data-action="rich-mark" data-mark="underline" aria-label="밑줄"><u>U</u></button><button data-action="rich-mark" data-mark="strike" aria-label="취소선"><s>S</s></button><button data-action="rich-mark" data-mark="code" aria-label="인라인 코드">&lt;/&gt;</button><button data-action="rich-link">${icon('link')}링크</button><label>글자색<select id="rich-color" aria-label="글자색"><option value="default">기본</option>${FountainCollaboration.PALETTE.filter(color=>color!=='default').map(color=>`<option value="${color}">${esc(({gray:'회색',brown:'갈색',orange:'주황',yellow:'노랑',green:'초록',blue:'파랑',purple:'보라',pink:'분홍',red:'빨강'})[color])}</option>`).join('')}</select></label><label>배경<select id="rich-background" aria-label="글자 배경"><option value="default">없음</option>${FountainCollaboration.PALETTE.filter(color=>color!=='default').map(color=>`<option value="${color}">${esc(({gray:'회색',brown:'갈색',orange:'주황',yellow:'노랑',green:'초록',blue:'파랑',purple:'보라',pink:'분홍',red:'빨강'})[color])}</option>`).join('')}</select></label></div>`:''}<div id="blocks" aria-label="페이지 블록">${state.blocks.map(blockHTML).join('')}</div>${pageEditable()?'<button class="editor-end" data-action="add-block"><span>+</span> 글을 쓰거나 ‘/’로 블록을 추가하세요</button>':''}<section class="comment-section"><h3>댓글 <span class="muted">${state.comments.filter(c=>!c.resolved).length}</span></h3><div id="comments">${commentsHTML()}</div><form class="comment-form" id="comment-form"><input name="text" aria-label="댓글 내용" placeholder="생각을 나눠보세요…" required maxlength="10000"><button class="outline-btn">보내기 ${icon('arrow')}</button></form></section></div></article>`;
  if(!pageEditable()) {
    for(const action of ['change-icon','favorite','toggle-cover'])$$(`[data-action="${action}"]`).forEach(el=>el.disabled=true);
  }
  if(resourceLevel(p)<2)$('#comment-form')?.remove();
  state.renderedChars=new Map(state.blocks.map(block=>[block.id,state.channel?.chars(block.id)||[]]));
  documentStatus({status:state.channel?.status||'synced',pending:state.channel?.pending.size||0,durable:state.channel?.durable!==false});renderRecoveryDrafts();ensureUploads();
  pruneAdministrativeControls();renderVerificationStatus();void syncWikiPage();

}
function patchPageMetadataUI() {
  if(state.nativeOutboxPause)return;
  if(!state.page||state.route!=='page')return;
  void syncWikiPage();renderVerificationStatus();
  state.pageViewBasis||=structuredClone(state.page);
  const title=$('#page-title');
  if(title&&document.activeElement!==title&&!state.titlePending&&!state.titleSaving){title.textContent=state.page.title;state.pageViewBasis.title=state.page.title;}
  const emoji=$('.page-emoji');if(emoji){emoji.textContent=state.page.icon||'📄';state.pageViewBasis.icon=state.page.icon;}
  for(const favorite of $$('.page-tools [data-action="favorite"]')){favorite.textContent=state.page.favorite?'★ 즐겨찾기':'☆ 즐겨찾기';favorite.classList.toggle('favorite-on',!!state.page.favorite);}
  state.pageViewBasis.favorite=state.page.favorite;
  const editor=$('.editor-wrap');if(editor){editor.classList.toggle('has-cover',!!state.page.cover);if(state.page.cover&&!$('.page-cover')){const cover=document.createElement('div');cover.className='page-cover';editor.before(cover);}if(!state.page.cover)$('.page-cover')?.remove();state.pageViewBasis.cover=state.page.cover;}
  const crumb=$('.crumb .current');if(crumb&&document.activeElement!==title&&!state.titlePending)crumb.textContent=state.page.title;
}
function commentsHTML() {
  return state.comments.filter(c=>!c.resolved).map(c=>`<div class="comment-item">${resourceLevel(state.page)>=4||c.author===state.session?.member?.id?`<button data-action="resolve-comment" data-id="${esc(c.id)}">해결 ✓</button>`:''}<strong>${esc(c.author_name||c.author||'나')}</strong> <span class="muted small">${date(c.created_at)}</span><div>${esc(c.text)}</div></div>`).join('');
}
const blockTypes=[['paragraph','텍스트','일반 텍스트로 작성','T'],['heading1','제목 1','가장 큰 제목','H₁'],['heading2','제목 2','중간 크기 제목','H₂'],['heading3','제목 3','작은 제목','H₃'],['bullet','글머리 기호','간단한 목록','•'],['numbered','번호 매기기','순서가 있는 목록','1.'],['todo','할 일 목록','완료 여부를 체크','☑'],['quote','인용','인상 깊은 문장','❝'],['callout','콜아웃','중요한 내용을 강조','💡'],['code','코드','코드와 서식을 보존','⌘'],['divider','구분선','내용을 나누는 선','―'],['toggle','토글','접을 수 있는 메모','▸'],['bookmark','북마크','링크를 기록','↗']];
function blockHTML(b,i) {
  const type=b.type||'paragraph';
  let marker='';
  if(type==='todo')marker=`<span class="block-marker"><input type="checkbox" aria-label="할 일 완료" data-check="${esc(b.id)}" ${b.checked?'checked':''} ${!blockEditable()?'disabled':''}></span>`;
  else if(type==='bullet')marker='<span class="block-marker">•</span>';
  else if(type==='numbered')marker=`<span class="block-marker">${i+1}.</span>`;
  else if(type==='toggle')marker=`<button class="block-marker" data-action="toggle-block" data-id="${esc(b.id)}">▸</button>`;
  return `<div class="block ${b.checked?'checked':''}" data-id="${esc(b.id)}" data-type="${esc(type)}" style="--block-depth:${blockDepth(b)}" draggable="${blockEditable()}">${blockEditable()?`<span class="block-handle"><button data-action="block-menu" data-id="${esc(b.id)}" aria-label="블록 메뉴">⠿</button></span>`:''}${type==='file'?`<a class="outline-btn attachment-link" href="${esc(FountainTransport.downloadURL('/api/attachments/'+encodeURIComponent(b.attachment_id||'')+'/download'))}" download="${esc(b.text||'첨부 파일')}">📎 ${esc(b.text||'첨부 파일')}<span class="muted small">${Number.isFinite(b.size)?(b.size/1000).toLocaleString('ko-KR',{maximumFractionDigits:1})+' KB':''} ↓</span></a>`:type==='divider'?'<hr>':marker+`<div class="block-content" contenteditable="${blockEditable()}" role="textbox" aria-multiline="true" data-placeholder="글을 쓰거나 ‘/’로 명령어를 입력하세요">${richTextHTML(b)}</div>`}</div>`;
}
function editorPlainText(element) {
  let last=element;while(last.lastChild)last=last.lastChild;
  const text=element.innerText;
  return last.nodeType===Node.ELEMENT_NODE&&last.nodeName==='BR'?text.replace(/\n$/,''):text;
}
function readBlocks() {
  if(state.route!=='page')return;
  for(const element of $$('.block')) {
    const b=state.blocks.find(b=>b.id===element.dataset.id);
    if(b&&$('.block-content',element))b.text=editorPlainText($('.block-content',element));
  }
}
function scheduleSave() {
  if(state.nativeOutboxPause||!state.channel)return;
  reconcileEditor();state.dirty=false;
  clearTimeout(state.saveTimer);state.saveTimer=setTimeout(()=>savePage().catch(error=>toast(error.message)),250);
}
async function savePage() {
  clearTimeout(state.saveTimer);state.saveTimer=null;
  if(state.nativeOutboxPause||state.route!=='page'||!state.channel)return;
  reconcileEditor();await state.channel.flush();
}
function uploadScope() {
  return {workspaceId:state.offlineProfile?.workspaceId||state.workspace?.workspace_id||state.session?.workspace_id,memberId:state.session?.member?.id,binding:state.session?.cache_binding,pageId:state.page?.id};
}
function currentUploadScope(scope) {
  return state.route==='page'&&state.uploadTargetPageId===scope.pageId&&state.page?.id===scope.pageId&&state.session?.member?.id===scope.memberId&&state.session?.cache_binding===scope.binding&&state.offlineProfile?.workspaceId===scope.workspaceId&&pageEditable()&&!state.offline;
}
function sizeLabel(size) {
  if(size>=1_000_000_000)return (size/1_000_000_000).toLocaleString('ko-KR',{maximumFractionDigits:2})+' GB';
  if(size>=1_000_000)return (size/1_000_000).toLocaleString('ko-KR',{maximumFractionDigits:2})+' MB';
  if(size>=1000)return (size/1000).toLocaleString('ko-KR',{maximumFractionDigits:1})+' KB';return size+' B';
}
async function uploadDenied({status,message,scope}) {
  if(state.session?.cache_binding!==scope.binding||state.page?.id!==scope.pageId)return;
  if(status===401){await state.channel?.deny(401,message);return;}
  if(status===410){toast('전송 기한이 만료되었습니다. 파일을 새로 선택해 다시 전송해 주세요.');return;}
  try{const snapshot=await api('/pages/'+encodeURIComponent(scope.pageId)+'/collaboration');if(state.channel?.pageId===scope.pageId)await state.channel.receive(snapshot,'upload-permission');toast(status===404?'전송 정보가 만료되었거나 삭제되었습니다. 파일을 새로 선택해 주세요.':message);}
  catch(failure){if([401,403,404].includes(failure.status))await state.channel?.deny(failure.status,failure.message);else toast(message);}
}
function ensureUploads() {
  if(!window.FountainUploads||!state.page||!state.offlineProfile)return;
  const scope=uploadScope(),manager=state.uploadManager;
  if(manager&&Object.keys(scope).every(key=>manager.scope[key]===scope[key])&&!manager.closed){renderUploads(manager.view());return;}
  manager?.dispose();
  const created=new FountainUploads.UploadManager({scope,isCurrent:currentUploadScope,onChange:jobs=>{if(state.uploadManager===created)renderUploads(jobs);},onDenied:uploadDenied,
    onComplete:async(attachment,originalScope,canAttach=()=>true,publication)=>{
      if(state.uploadManager!==created||!currentUploadScope(originalScope)||!canAttach())return false;
      const channel=state.channel,epoch=channel?.base?.epoch;
      const current=()=>state.channel===channel&&channel?.base?.epoch===epoch&&state.uploadManager===created&&currentUploadScope(originalScope)&&canAttach();
      const actual=await api('/session');if(actual.cache_binding!==originalScope.binding||actual.member?.id!==originalScope.memberId){created.dispose();boot();return false;}
      if(!current())return false;
      let receipt=publication?.get();
      if(!receipt){
        if(publication?.version!==1)throw new Error('이전 첨부의 문서 연결 기록을 확인할 수 없습니다. 복구 내용을 확인한 뒤 파일을 새로 전송해 주세요.');
        if(!blockEditable())throw new Error('실행 취소 결과를 확인한 뒤 첨부를 다시 시도해 주세요.');
        const blockId=uid(),group=uid(),make=(type,fields)=>channel.operation(type,blockId,{...fields,group_id:group});
        const ops=[make('block.insert',{parent_id:null,after_id:state.blocks.filter(block=>!block.parent_id).at(-1)?.id||null,block_type:'file'}),make('text.insert',{after_id:null,text:attachment.name}),make('block.set',{field:'attachment_id',value:attachment.id}),make('block.set',{field:'size',value:attachment.size})];
        receipt={epoch,block_id:blockId,ops};await publication.save(receipt);
      }
      if(!current())return false;
      if(receipt.epoch!==epoch||!Array.isArray(receipt.ops)||!receipt.ops.length)throw new Error('문서 버전이 변경되어 이전 첨부를 자동으로 연결하지 않았습니다. 파일을 새로 전송해 주세요.');
      channel.transact({kind:'attachment',beforeSelection:selectedTextPosition(),afterSelection:()=>selectedTextPosition()},()=>channel.submitPrepared(receipt.ops));
      await channel.persistence;if(!current())return false;
      await channel.flush();if(!current())return false;
      if(!receipt.ops.every(operation=>Object.hasOwn(channel.base.state.seen,operation.id)))throw new Error('파일 전송은 끝났지만 문서 첨부가 아직 저장되지 않았습니다. 다시 시도해 주세요.');
      return true;
    }});
  state.uploadManager=created;created.load().catch(failure=>{if(state.uploadManager===created&&!created.closed)toast(failure.message);});
}
function renderUploads(jobs) {
  let panel=$('#upload-panel');if(!$('.editor-wrap'))return;
  if(!jobs.length){panel?.remove();const add=$('[data-action="add-file"]');if(add)add.disabled=!pageEditable()||state.offline;return;}
  if(!panel){panel=document.createElement('section');panel.id='upload-panel';panel.className='upload-panel';panel.setAttribute('aria-label','파일 전송');($('.rich-toolbar')||$('#blocks')).before(panel);}
  const editable=pageEditable()&&!state.offline,signature=jobs.map(job=>[job.id,job.name,job.status,job.message,job.hasFile,editable].join(':')).join('|');
  if(panel.dataset.signature!==signature){
    panel.dataset.signature=signature;
    panel.innerHTML=`<div class="upload-panel-title"><strong>파일 전송</strong><span>파일당 최대 5 GB</span></div>${jobs.map(job=>{
      const active=['fingerprint','starting','uploading','checking','finishing','attaching'].includes(job.status),complete=job.status==='done';
      return `<article class="upload-card" data-upload-id="${esc(job.id)}" data-upload-state="${esc(job.status)}"><div class="upload-file-heading"><span aria-hidden="true">${complete?'✓':'📎'}</span><strong>${esc(job.name)}</strong><span>${sizeLabel(job.size)}</span></div><progress max="${Math.max(1,job.size)}" value="0" aria-label="${esc(job.name)} 전송 진행률"></progress><div class="upload-progress-label"></div><p role="status">${esc(job.message)}</p><div class="upload-actions">${active&&job.status!=='attaching'?`<button data-action="upload-pause" data-id="${esc(job.id)}">일시 중지</button>`:''}${!active&&!complete&&!['denied','cancelled'].includes(job.status)?`${job.hasFile?`<button data-action="upload-retry" data-id="${esc(job.id)}" ${!editable?'disabled':''}>다시 시도</button>`:''}<button data-action="upload-reselect" data-id="${esc(job.id)}" ${!editable?'disabled':''}>동일한 원본 파일 선택</button>`:''}${!complete&&!['denied','cancelled','attaching'].includes(job.status)?`<button data-action="upload-cancel" data-id="${esc(job.id)}">취소</button>`:''}${complete||job.status==='denied'?`<button data-action="upload-dismiss" data-id="${esc(job.id)}">닫기</button>`:''}</div></article>`;
    }).join('')}<p class="upload-sample-note">이어 보내기는 파일 이름·크기·수정 시각과 앞뒤 일부 표본을 비교합니다. 원본 전체가 동일하다는 검증은 아닙니다. 새로고침 후에는 원본 파일을 다시 선택해 주세요.</p>`;
  }
  for(const job of jobs){const card=$(`[data-upload-id="${CSS.escape(job.id)}"]`,panel);if(!card)continue;const transferred=job.status==='done'?job.size:Math.min(job.size,job.offset+(job.loaded||0));$('progress',card).value=job.size===0&&job.status==='done'?1:transferred;$('.upload-progress-label',card).textContent=`${sizeLabel(transferred)} / ${sizeLabel(job.size)} · ${job.size?Math.min(100,Math.floor(transferred/job.size*100)):job.status==='done'?100:0}%`;
  }
  const add=$('[data-action="add-file"]');if(add)add.disabled=state.uploadManager?.active()||!editable;
}
async function attachFile(file) {
  if(!file)return;
  if(!pageEditable()||state.offline)throw new Error('파일을 전송하려면 문서 편집 권한과 서버 연결이 필요합니다.');
  ensureUploads();const manager=state.uploadManager;if(!manager)throw new Error('파일 전송 정보를 준비하지 못했습니다.');
  const resumeId=state.uploadReselectId;state.uploadReselectId=null;
  return resumeId?manager.resume(resumeId,file):manager.start(file);
}

function focusBlock(id,atEnd=true) {
  const el=$(`.block[data-id="${CSS.escape(id)}"] .block-content`);
  if(!el)return;
  el.focus();
  const range=document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  const selection=getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
function renderBlocks(focusId) {
  patchDocumentBlocks();
  if(focusId)focusBlock(focusId);
}
function addBlock(type='paragraph',afterId,text='',grouped=false) {
  if(!grouped)return editorTransaction('structure',()=>addBlock(type,afterId,text,true));
  if(!blockEditable())throw new Error('페이지 편집 권한이 없습니다.');
  readBlocks();
  const b= {
    id:uid(),type,text
  };
  const index=afterId?state.blocks.findIndex(b=>b.id===afterId)+1:state.blocks.length;
  state.blocks.splice(index,0,b);
  renderBlocks(b.id);
  scheduleSave();
  return b;
}
function openSlash(id,query='') {
  closeSlash();
  const el=$(`.block[data-id="${CSS.escape(id)}"]`);
  if(!el)return;
  state.activeBlock=id;
  const rect=el.getBoundingClientRect();
  const menu=document.createElement('div');
  menu.className='slash-menu';
  menu.style.left=Math.min(rect.left,innerWidth-250)+'px';
  menu.style.top=Math.min(rect.bottom+4,innerHeight-330)+'px';
  menu.setAttribute('role','menu');
  menu.innerHTML=blockTypes.filter(t=>!query||t[1].includes(query)||t[0].includes(query)).map(([type,name,description,symbol])=>`<button data-action="set-block-type" data-id="${esc(id)}" data-type="${type}" role="menuitem"><span>${symbol}</span><span>${name}<small>${description}</small></span></button>`).join('');
  document.body.append(menu);
}
function closeSlash() {
  $('.slash-menu')?.remove();
}
const DAY_MS=86_400_000;
function dateRange(value) {
  const start=typeof value==='string'?value:value?.start;
  const end=typeof value==='object'&&value?value.end||start:start;
  const parse=text=>{
    const iso=typeof text==='string'?text.slice(0,10):'';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return null;
    const value=Date.parse(iso+'T00:00:00Z');
    return Number.isFinite(value)&&new Date(value).toISOString().slice(0,10)===iso?Math.floor(value/DAY_MS):null;
  };
  const first=parse(start),last=parse(end);
  return first===null||last===null||last<first?null:{start:first,end:last,startISO:String(start).slice(0,10),endISO:String(end).slice(0,10)};
}
function dateRangeLabel(value) {
  const range=dateRange(value);
  return range?range.startISO===range.endISO?range.startISO:range.startISO+' → '+range.endISO:'날짜 미정';
}
function isoDay(day) { return new Date(day*DAY_MS).toISOString().slice(0,10); }
function rowHierarchy(rows) {
  const index=new Map(rows.map(row=>[row.id,row])),children=new Map(),result=[],seen=new Set();
  if(state.database?.task_settings?.subitems!==true)return rows.map(row=>({row,depth:0,children:[]}));
  for(const row of rows){const parent=index.has(row.parent_row_id)?row.parent_row_id:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row);}
  function visit(row,depth){
    if(seen.has(row.id))return;seen.add(row.id);
    const nested=children.get(row.id)||[];result.push({row,depth,children:nested});
    if(!state.collapsedRows.has(row.id))for(const child of nested)visit(child,depth+1);
    else {const hide=item=>{if(seen.has(item.id))return;seen.add(item.id);for(const child of children.get(item.id)||[])hide(child);};nested.forEach(hide);}
  }
  for(const row of children.get(null)||[])visit(row,0);
  for(const row of rows)if(!seen.has(row.id))visit(row,0);
  return result;
}
function taskTitle(item) {
  const {row,depth,children}=item;
  const dependencies=(row.depends_on||[]).filter(id=>state.rows.some(candidate=>candidate.id===id));
  const names=dependencies.map(id=>nameOf(state.rows.find(row=>row.id===id))).join(', ');
  return `<span class="task-title" style="padding-left:${Math.min(depth,12)*17}px">${children.length?`<button class="task-collapse" data-action="toggle-subitems" data-id="${esc(row.id)}" aria-label="${esc(nameOf(row))} 하위 항목 ${state.collapsedRows.has(row.id)?'펼치기':'접기'}" aria-expanded="${!state.collapsedRows.has(row.id)}">${state.collapsedRows.has(row.id)?'▸':'▾'}</button>`:'<span class="task-spacer"></span>'}<span class="task-page-icon">${depth?'↳':'▤'}</span><span class="task-name">${esc(nameOf(row))}</span>${dependencies.length?`<span class="task-dependencies" title="선행 항목: ${esc(names)}" aria-label="선행 항목 ${dependencies.length}개">↗ ${dependencies.length}</span>`:''}${children.length?`<span class="task-child-count">${children.length}</span>`:''}</span>`;
}
function taskListHTML(rows) {
  const statusProperty=state.database.properties.find(property=>property.type==='status');
  const dateProperty=state.database.properties.find(property=>property.id===state.database.task_settings?.date_property)||state.database.properties.find(property=>property.type==='date');
  return `<div class="task-list"><div class="task-list-heading"><span>프로젝트</span><span>상태</span><span>일정</span></div>${rowHierarchy(rows).map(item=>`<div class="task-list-row" data-action="edit-row" data-id="${esc(item.row.id)}" role="button" tabindex="0">${taskTitle(item)}<span>${status(valuesOf(item.row)[statusProperty?.id])}</span><span class="task-date">${esc(dateRangeLabel(valuesOf(item.row)[dateProperty?.id]))}</span><div class="row-trust-summary">${databaseTrustSummary(item.row)}</div></div>`).join('')||'<div class="empty">표시할 항목이 없습니다.</div>'}</div>${canCreateRow()?'<button class="new-row" data-action="add-row">+ 새 항목</button>':''}`;
}
function timelineHTML(rows) {
  const properties=state.database.properties.filter(property=>property.type==='date');
  if(!properties.some(property=>property.id===state.timelineProperty))state.timelineProperty=state.database.task_settings?.date_property||properties[0]?.id;
  const field=properties.find(property=>property.id===state.timelineProperty)||properties[0];
  const ordered=rowHierarchy(rows),scheduled=ordered.map(item=>({...item,range:dateRange(valuesOf(item.row)[field?.id])}));
  const ranges=scheduled.map(item=>item.range).filter(Boolean),today=Math.floor(Date.now()/DAY_MS);
  let first=Math.min(today,...ranges.map(range=>range.start))-3,last=Math.max(today+20,...ranges.map(range=>range.end))+3;
  if(state.timelineBounds){first=state.timelineBounds.start;last=state.timelineBounds.end;}
  // Weeks start on Monday. Large spans use a bounded canvas rather than creating a DOM cell per day.
  first-=((new Date(first*DAY_MS).getUTCDay()+6)%7);
  const days=Math.max(7,last-first+1),unit=state.timelineZoom==='week'?15:34,dayWidth=Math.min(unit,20000/days),width=days*dayWidth;
  let step=Math.max(state.timelineZoom==='week'?7:Math.ceil(25/dayWidth),Math.ceil(days/600));
  if(state.timelineZoom==='week')step=Math.ceil(step/7)*7;
  const ticks=[];for(let offset=0;offset<days;offset+=step){const when=new Date((first+offset)*DAY_MS);ticks.push(`<span class="timeline-tick" style="left:${offset*dayWidth}px;width:${step*dayWidth}px"><small>${offset===0||when.getUTCDate()<=step?when.getUTCMonth()+1+'월':''}</small>${when.getUTCDate()}${state.timelineZoom==='week'&&step===7?'일 주간':'일'}</span>`);}
  const current=today>=first&&today<first+days?`<span class="timeline-today" style="left:${(today-first+.5)*dayWidth}px" title="오늘"></span>`:'';
  const dated=scheduled.filter(item=>item.range),undated=scheduled.filter(item=>!item.range);
  return `<div class="timeline-controls"><label>날짜 속성<select id="timeline-property" aria-label="타임라인 날짜 속성">${properties.map(property=>`<option value="${esc(property.id)}" ${property.id===field?.id?'selected':''}>${esc(property.name)}</option>`).join('')}</select></label><label>보기<select id="timeline-zoom" aria-label="타임라인 간격"><option value="day" ${state.timelineZoom!=='week'?'selected':''}>일</option><option value="week" ${state.timelineZoom==='week'?'selected':''}>주</option></select></label><button class="outline-btn" data-action="timeline-today">오늘</button><button class="outline-btn" data-action="timeline-fit">전체 일정</button><span class="timeline-range-label">${isoDay(first)} — ${isoDay(first+days-1)}</span></div>${!field?'<div class="info-box">날짜 속성을 추가하면 실제 일정을 타임라인에서 볼 수 있습니다.</div>':''}<div class="timeline-scroll-hint">↔ 좌우로 스크롤해 전체 일정을 살펴보세요</div><div class="timeline-scroll" role="region" aria-label="프로젝트 일정 타임라인" tabindex="0"><div class="timeline-grid" data-first="${first}" data-day-width="${dayWidth}" style="--timeline-width:${width}px;--day-width:${dayWidth}px"><div class="timeline-header"><div class="timeline-sticky">프로젝트 · ${dated.length}</div><div class="timeline-axis">${ticks.join('')}${current}</div></div>${dated.map(item=>{const range=item.range,visible=range.end>=first&&range.start<first+days,left=(Math.max(range.start,first)-first)*dayWidth,barWidth=(Math.min(range.end,first+days-1)-Math.max(range.start,first)+1)*dayWidth;return `<div class="timeline-row"><div class="timeline-sticky" data-action="edit-row" data-id="${esc(item.row.id)}" role="button" tabindex="0">${taskTitle(item)}</div><div class="timeline-canvas">${current}${visible?`<button class="timeline-bar ${item.depth?'is-subitem':''}" data-day="${range.start}" data-action="edit-row" data-id="${esc(item.row.id)}" style="left:${left}px;width:${Math.max(5,barWidth)}px" title="${esc(nameOf(item.row))}: ${range.startISO} → ${range.endISO}" aria-label="${esc(nameOf(item.row))} ${range.startISO}부터 ${range.endISO}까지"><span>${esc(nameOf(item.row))}</span></button>`:'<span class="timeline-outside">선택한 범위 밖</span>'}</div></div>`;}).join('')||'<div class="empty">아직 날짜가 지정된 항목이 없습니다.</div>'}</div></div>${undated.length?`<section class="timeline-unscheduled"><h3>날짜 미정 <span>${undated.length}</span></h3>${undated.map(item=>`<div class="task-list-row" data-action="edit-row" data-id="${esc(item.row.id)}" role="button" tabindex="0">${taskTitle(item)}<span class="muted small">날짜를 지정하세요</span></div>`).join('')}</section>`:''}`;
}
function focusTimeline() {
  const scroll=$('.timeline-scroll'),grid=$('.timeline-grid');if(!scroll||!grid)return;
  const target=state.timelineFocusDay??Number($('.timeline-bar')?.dataset.day||Math.floor(Date.now()/DAY_MS));
  const sticky=$('.timeline-sticky',scroll)?.offsetWidth||220;
  scroll.scrollLeft=Math.max(0,(target-Number(grid.dataset.first)+.5)*Number(grid.dataset.dayWidth)-Math.max(20,(scroll.clientWidth-sticky)/2));
}
function openTaskSettings() {
  if(resourceLevel(state.database)<4)throw new Error('데이터베이스 전체 권한이 필요합니다.');
  const settings=state.database.task_settings||{};
  openModal('프로젝트 일정 설정',`<p>하위 항목과 선행 작업을 연결하고, 선행 작업의 일정이 바뀌었을 때 후속 작업을 조정하세요.</p><form id="task-settings-form" class="form-grid"><label class="checkbox-label"><input name="subitems" type="checkbox" ${settings.subitems?'checked':''}>하위 항목 사용</label><label class="checkbox-label"><input name="dependencies" type="checkbox" ${settings.dependencies?'checked':''}>선행·후속 작업 연결 사용</label><label>일정에 사용할 날짜 속성<select name="date_property">${state.database.properties.filter(property=>property.type==='date').map(property=>`<option value="${esc(property.id)}" ${settings.date_property===property.id?'selected':''}>${esc(property.name)}</option>`).join('')}</select></label><label>선행 작업 일정 변경 시<select name="shift"><option value="none" ${!settings.shift||settings.shift==='none'?'selected':''}>자동 조정 안 함</option><option value="overlap" ${settings.shift==='overlap'?'selected':''}>일정이 겹칠 때 후속 작업 이동</option><option value="maintain" ${settings.shift==='maintain'?'selected':''}>작업 사이 간격을 유지하며 이동</option></select></label><label class="checkbox-label"><input name="skip_weekends" type="checkbox" ${settings.skip_weekends?'checked':''}>일정 조정 시 주말 건너뛰기</label><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn">설정 저장</button></div></form>`);
}

function databaseToolbar(compact=false) {
  return `<div class="db-toolbar"><div class="view-tabs">${[['table','테이블','table'],['board','보드','board'],...(!compact?[['timeline','타임라인','calendar'],['list','리스트','menu'],['calendar','캘린더','calendar'],['gallery','갤러리','grid'],['chart','차트','chart']]:[])].map(([v,n,i])=>`<button data-action="db-view" data-view="${v}" class="${state.view===v?'active':''}">${icon(i)}${n}</button>`).join('')}</div><div class="db-actions"><button data-action="filter" aria-label="필터">${icon('filter')}</button>${!compact?'<button data-action="db-export" aria-label="CSV 내보내기">↗</button><button data-action="new-property" aria-label="속성 추가">＋ 속성</button><button data-action="owner-settings" aria-label="담당자 속성 설정">☻ 담당자</button><button data-action="task-settings" aria-label="프로젝트 일정 설정">⚙ 일정</button>':''}<button class="solid-btn" data-action="add-row">새로 만들기 ${icon('down')}</button></div></div>`;
}
function databaseMemberName(id,members=state.workspace?.members||[]) { const member=members.find(member=>member?.id===id);return typeof member?.name==='string'&&member.name?member.name:'비공개 담당자'; }
function databaseVerificationLabel(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return '미검증';
  const status=['unverified','verified','expired','unknown'].includes(value.status)?value.status:'unknown';
  if(['verified','expired'].includes(status)&&(!verificationTimestamp(value.verified_at)||(value.expires_at!=null&&!verificationTimestamp(value.expires_at))))return '정보 확인 필요';
  if(status==='verified'&&verificationTimestamp(value.expires_at)&&Date.parse(value.expires_at)<=Date.now())return '검증 만료';
  return {unverified:'미검증',verified:'검증됨',expired:'검증 만료',unknown:'정보 확인 필요'}[status];
}
function databaseValueText(property,value,row=null) {
  if(property?.type==='verification'&&row?.computed_pending)return '동기화 후 확인';
  if(property?.type==='owner')return Array.isArray(value)?value.filter(id=>typeof id==='string').map(id=>databaseMemberName(id)).join(', ')||'미지정':'미지정';
  if(property?.type==='verification')return databaseVerificationLabel(value);
  if(property?.type==='date')return dateRangeLabel(value);
  if(property?.type==='person')return typeof value==='string'?state.workspace?.members?.find(member=>member.id===value)?.name||value||'—':'—';
  if(Array.isArray(value))return value.filter(item=>['string','number','boolean'].includes(typeof item)).join(', ');
  return ['string','number','boolean'].includes(typeof value)?String(value):'—';
}
function databaseValueHTML(property,value,row=null) {
  if(property.type==='verification'&&row?.computed_pending)return '<span class="verification-badge">동기화 후 확인</span>';
  if(property.type==='verification'){const label=databaseVerificationLabel(value);return `<span class="verification-badge ${label==='검증됨'?'verified':''}">${label==='검증됨'?'✓ ':''}${esc(label)}</span>`;}
  if(['status','select'].includes(property.type))return status(typeof value==='string'?value:'');
  if(property.type==='checkbox')return value?'☑':'☐';
  return esc(databaseValueText(property,value)||'—');
}
function databaseRowSummary(row){return state.database.properties.filter(property=>property.type!=='title').map(property=>databaseValueText(property,valuesOf(row)[property.id],row)).filter(text=>text&&text!=='—').join(' · ');}
function databaseTrustSummary(row){return state.database.properties.filter(property=>['owner','verification'].includes(property.type)).map(property=>`<span>${esc(property.name)} · ${databaseValueHTML(property,valuesOf(row)[property.id],row)}</span>`).join('');}
function scheduleDatabaseVerificationExpiry(){
  clearTimeout(state.databaseVerificationTimer);state.databaseVerificationTimer=null;
  const scope=databaseScope(),property=state.database?.properties?.find(property=>property.type==='verification');if(!property||state.route!=='database')return;
  const future=state.rows.map(row=>valuesOf(row)[property.id]).filter(value=>value?.status==='verified'&&verificationTimestamp(value.expires_at)&&Date.parse(value.expires_at)>Date.now()).map(value=>Date.parse(value.expires_at));if(!future.length)return;
  state.databaseVerificationTimer=setTimeout(()=>{if(!databaseScopeCurrent(scope))return;if($('#db-view'))$('#db-view').innerHTML=databaseView();const view=state.databaseVerification;if(databaseVerificationCurrent(view)&&view.info){const badge=$('.row-verification-heading .verification-badge',view.panel),label=$('.row-verification-value',view.form);if(badge)badge.outerHTML=databaseValueHTML(property,view.info.verification);if(label)label.innerHTML=databaseValueHTML(property,view.info.verification);}scheduleDatabaseVerificationExpiry();},Math.min(60000,Math.max(1,Math.min(...future)-Date.now())));
}
function tableHTML(rows,compact=false) {
  const props=(state.database?.properties||[]).slice(0,compact?4:100);
  return `<div class="data-table-scroll"><table class="data-table" style="--table-columns:${props.length}"><thead><tr>${props.map(property=>`<th>${property.type==='title'?'Aa':property.type==='status'?'◉':property.type==='verification'?'✓':['person','owner'].includes(property.type)?'☻':property.type==='date'?'▦':'≡'} &nbsp;${esc(property.name)}</th>`).join('')}</tr></thead><tbody>${rowHierarchy(rows).map(item=>`<tr tabindex="0" role="button" data-action="edit-row" data-id="${esc(item.row.id)}" aria-label="${esc(nameOf(item.row))}">${props.map((property,index)=>{const value=valuesOf(item.row)[property.id];return `<td>${index===0?taskTitle(item):databaseValueHTML(property,value,item.row)}</td>`;}).join('')}</tr>`).join('')}</tbody></table>${!rows.length?'<div class="empty">아직 항목이 없어요. 첫 번째 항목을 추가해 보세요.</div>':''}</div>`;
}
function filteredRows() {
  let rows=[...state.rows];
  if(state.filter)rows=rows.filter(r=>state.database.properties.some(property=>databaseValueText(property,valuesOf(r)[property.id],r).toLowerCase().includes(state.filter.toLowerCase())));
  if(state.sort)rows.sort((a,b)=>String(nameOf(a)).localeCompare(String(nameOf(b)),'ko'));
  return rows;
}
function databaseView() {
  const rows=filteredRows(),props=state.database.properties;
  const title=props.find(p=>p.type==='title')||props[0];
  const group=props.find(p=>p.type==='status')||props.find(p=>p.type==='select');
  if(state.view==='timeline')return timelineHTML(rows);
  if(state.view==='list')return taskListHTML(rows);
  if(state.view==='table')return tableHTML(rows)+`<button class="new-row" data-action="add-row">+ 새 항목</button>`;
  if(state.view==='board') {
    const options=[...new Set([...optionsOf(group|| {
    }),...rows.map(r=>valuesOf(r)[group?.id]||'미지정')])];
    return `<div class="board">${options.map(value=>`<div class="board-column"><h3>${status(value)}<span>${rows.filter(r=>(valuesOf(r)[group?.id]||'미지정')===value).length}</span></h3>${rows.filter(r=>(valuesOf(r)[group?.id]||'미지정')===value).map(r=>`<button class="board-card" data-action="edit-row" data-id="${esc(r.id)}">${esc(valuesOf(r)[title.id]||'제목 없음')}<small>${esc(databaseRowSummary(r))}</small></button>`).join('')}<button class="new-row" data-action="add-row" data-status="${esc(value)}">+ 새 항목</button></div>`).join('')}</div>`;
  }
  if(state.view==='gallery')return `<div class="gallery">${rows.map(r=>`<button class="board-card" data-action="edit-row" data-id="${esc(r.id)}">${esc(nameOf(r))}<small>${esc(databaseRowSummary(r))}</small></button>`).join('')}</div>`;
  if(state.view==='chart') {
    const counts= {
    };
    rows.forEach(r=> {
      const k=valuesOf(r)[group?.id]||'미지정'; counts[k]=(counts[k]||0)+1;
    });
    const max=Math.max(1,...Object.values(counts));
    return `<div class="chart">${Object.entries(counts).map(([k,n])=>`<div class="chart-column"><div class="chart-bar" style="height:${Math.max(8,n/max*85)}%">${n}</div><span>${esc(k)}</span></div>`).join('')}</div>`;
  }
  const dateProp=props.find(p=>p.type==='date');
  const now=new Date();
  const first=new Date(now.getFullYear(),now.getMonth(),1).getDay();
  const count=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  return `<div style="padding:14px;font-size:13px">${now.getFullYear()}년 ${now.getMonth()+1}월</div><div class="calendar">${['일','월','화','수','목','금','토'].map(d=>`<div class="weekday">${d}</div>`).join('')}${Array.from({length:first},()=>'<div></div>').join('')}${Array.from({length:count},(_,i)=>{const key=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`;return `<div>${i+1}${rows.filter(r=>{const range=dateRange(valuesOf(r)[dateProp?.id]);return range&&key>=range.startISO&&key<=range.endISO;}).map(r=>`<button data-action="edit-row" data-id="${esc(r.id)}">${esc(nameOf(r))}</button>`).join('')}</div>`;}).join('')}</div>${!dateProp?'<div class="info-box">날짜 속성을 추가하면 캘린더에 항목을 표시할 수 있습니다.</div>':''}`;
}
function renderDatabase() {
  if(state.nativeOutboxPause)return;
  if(state.nativeRecoveryPaused)return;
  renderTopbar(state.database.name||state.database.title,'▤');
  $('#main').innerHTML=`<section class="db-full"><div class="eyebrow">TEAM WORK, IN ONE PLACE</div><div class="database-heading"><h1>▤ ${esc(state.database.name||state.database.title||'프로젝트')}</h1><button class="outline-btn" data-action="db-export">↗ CSV 내보내기</button></div><p class="muted">작은 할 일부터 큰 목표까지, 우리의 다음 한 걸음을 함께 기록해요.</p><div class="panel">${databaseToolbar()}<div id="db-filters" ${state.filter?'':'hidden'} class="filters"><input id="db-filter-input" aria-label="항목 필터" placeholder="모든 속성에서 검색" value="${esc(state.filter)}"><button class="outline-btn" data-action="db-sort">이름 ${state.sort?'↓':'↕'} 정렬</button><button data-action="clear-filter" aria-label="필터 해제">×</button></div><div id="db-view">${databaseView()}</div></div></section>`;
  applyDatabaseControls();scheduleDatabaseVerificationExpiry();
  if(state.view==='timeline')focusTimeline();
}
async function reloadDatabase() {
  const data=await loadDatabaseData(state.database.id);
  clearDatabaseVerification();state.database=data.database;
  state.rows=data.rows;
  if(state.route==='database')renderDatabase();
  else if($('#home-database'))$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;
  applyDatabaseControls();
}
function openModal(title,content,cls='') {
  settingsOpenSequence++;clearVerifiedPages();clearAdminConsole();clearSearch();searchNavigation++;
  clearDatabaseVerification();clearDatabasePropertyView();clearWikiMutation();clearInbox();clearScimPanel();stopBackup();clearRecoveryImport();state.versionView=null;state.verificationView=null;closeSlash();
  $('#overlay-root').innerHTML=`<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-action="close-modal" aria-label="닫기">×</button></header><div class="modal-body">${content}</div></section></div>`;
  if(state.route==='page'&&resourceLevel(state.page)<4)$$('[data-action="delete-page"],[data-action="move-page"]',$('.modal')).forEach(el=>el.remove());
  if(state.route==='page'&&resourceLevel(state.page)<3){for(const action of ['lock-page','delete-page','verify-page','move-page','change-block-type','move-block','delete-block','restore-version'])$$(`[data-action="${action}"]`,$('.modal')).forEach(el=>el.remove());}
  pruneAdministrativeControls();
  const body=$('.modal-body');
  requestAnimationFrame(()=>{if(body?.isConnected)$('input:not([type=checkbox]),textarea,select,button',body)?.focus();});
}
function closeModal() {
  settingsOpenSequence++;clearVerifiedPages();clearAdminConsole();clearSearch();searchNavigation++;
  clearDatabaseVerification();clearDatabasePropertyView();clearWikiMutation();clearInbox();clearScimPanel();stopBackup();clearRecoveryImport();state.versionView=null;state.verificationView=null;$('#overlay-root').innerHTML='';
  closeSlash();
}
function wikiScope(){return {pageId:state.page?.id,channel:state.channel,epoch:state.channel?.base?.epoch,binding:state.session?.cache_binding,member:state.session?.member?.id,role:state.session?.member?.role,profile:state.offlineProfile?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,transportEpoch:FountainTransport.scopeEpoch,origin:FountainTransport.origin};}
function wikiScopeCurrent(scope){return !!scope&&state.route==='page'&&state.page?.id===scope.pageId&&state.channel===scope.channel&&!scope.channel?.closed&&scope.channel?.base?.epoch===scope.epoch&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.member&&state.session?.member?.role===scope.role&&state.offlineProfile?.id===scope.profile&&state.workspace?.workspace_id===scope.workspace&&state.bootGeneration===scope.boot&&FountainTransport.scopeEpoch===scope.transportEpoch&&FountainTransport.origin===scope.origin&&!state.nativeOutboxPause&&!state.nativeRecoveryPaused;}
function clearWikiMutation(){const view=state.wikiMutation;state.wikiMutation=null;if(view){view.request?.abort();if(view.modal?.isConnected)view.modal.closest('.modal-backdrop')?.remove();}}
function clearWikiPage(){const view=state.wikiPage;state.wikiPage=null;view?.request?.abort();$('#wiki-owner-status')?.replaceChildren();$('#wiki-panel')?.replaceChildren();const home=$('#wiki-home-content');if(home)home.hidden=false;}
function wikiCurrent(view){return state.wikiPage===view&&wikiScopeCurrent(view?.scope);}
function wikiVerificationAllowed(){const view=state.wikiPage;return !!view&&wikiCurrent(view)&&(view.kind==='root'||view.info?.can_verify===true);}
function renderWikiPage(view){
  if(!wikiCurrent(view))return;
  const panel=$('#wiki-panel'),owner=$('#wiki-owner-status'),home=$('#wiki-home-content');if(!panel||!owner)return;
  if(home)home.hidden=view.kind==='root'&&view.view!=='home';
  owner.replaceChildren();panel.replaceChildren();
  if(view.kind==='root'){
    panel.innerHTML=`<div class="wiki-heading">📚 위키</div><nav class="wiki-tabs" aria-label="위키 보기">${[['home','홈'],['all','모든 페이지'],['owned','내 담당 페이지']].map(([id,label])=>`<button class="text-btn ${view.view===id?'selected':''}" data-action="wiki-tab" data-view="${id}" aria-pressed="${view.view===id}">${label}</button>`).join('')}</nav>${view.view==='home'?'':`<form id="wiki-search-form" class="wiki-search"><label>위키 페이지 검색<input name="q" maxlength="200" value="${esc(view.query)}" placeholder="페이지 제목 검색"></label><button class="outline-btn" ${view.loading?'disabled':''}>검색</button><button type="button" class="outline-btn" data-action="wiki-refresh" ${view.loading?'disabled':''}>새로고침</button></form><div class="wiki-status" role="status">${state.offline?'목록은 인터넷에 연결한 뒤 확인할 수 있습니다.':view.loading?'페이지 목록을 확인하는 중…':`${view.total}개 페이지`}</div><div class="wiki-error" role="alert">${esc(view.error||'')}</div><div class="wiki-table" role="table" aria-label="위키 페이지 목록"><div class="wiki-table-head" role="row"><span role="columnheader">페이지</span><span role="columnheader">지식 담당자</span><span role="columnheader">검증</span></div>${view.items.map(item=>`<div class="wiki-table-row" role="row"><button role="cell" class="wiki-page-link" data-action="page" data-id="${esc(item.id)}">${esc(item.icon||'📄')} ${esc(item.title||'제목 없음')}</button><span role="cell">${esc(item.owner?.name||'담당자 정보 비공개')}</span><span role="cell">${wikiVerificationLabel(item.verification)}</span></div>`).join('')||(!view.loading?'<div class="wiki-empty">표시할 페이지가 없습니다.</div>':'')}</div>${view.hasMore?`<button class="outline-btn wiki-more" data-action="wiki-more" ${view.loading?'disabled':''}>더 보기</button>`:''}`}`;
  }else if(view.info?.in_wiki){
    owner.innerHTML=`<span>위키 페이지</span>${view.info.wiki?`<button class="text-btn" data-action="page" data-id="${esc(view.info.wiki.id)}">${esc(view.info.wiki.title||'위키 홈')}</button>`:''}<span>지식 담당자: ${esc(view.info.owner?.name||'정보 비공개')}</span>${view.info.can_manage&&pageEditable()&&!state.offline?'<button class="text-btn" data-action="wiki-owner">담당자 변경</button>':''}${!view.info.can_verify?'<span class="wiki-owner-note">검증은 편집 권한이 있는 지식 담당자가 설정합니다.</span>':''}`;
  }else if(view.error){owner.innerHTML=`<span role="status">${esc(view.error)}</span><button class="text-btn" data-action="wiki-refresh">다시 확인</button>`;}
  renderVerificationStatus();
}
function validWikiOwner(value){return value===null||!!value&&typeof value.id==='string'&&value.id.length>0&&typeof value.name==='string';}
function wikiVerificationLabel(value){if(value==null)return '검증 미설정';if(!verificationTimestamp(value.verified_at)||value.expires_at!=null&&!verificationTimestamp(value.expires_at))return '검증 상태 확인 필요';return value.expires_at!=null&&Date.parse(value.expires_at)<=Date.now()?'검증 만료':'검증됨';}
async function syncWikiPage(force=false){
  if(state.route!=='page'||!state.page||!state.channel||state.nativeOutboxPause||state.nativeRecoveryPaused)return;
  let view=state.wikiPage;
  if(view&&!wikiCurrent(view)){clearWikiPage();view=null;}
  const kind=state.page.is_wiki===true?'root':'page',revision=state.page.revision;
  if(view&&view.root===(kind==='root')&&!force&&view.revision===revision){renderWikiPage(view);return view.pending;}
  if(!view||view.root!==(kind==='root')){clearWikiPage();view={scope:wikiScope(),root:kind==='root',kind,view:'home',query:'',items:[],total:0,hasMore:false,loading:false,info:null,error:null};state.wikiPage=view;}
  view.revision=revision;view.request?.abort();view.serial=(view.serial||0)+1;view.loading=false;view.request=new AbortController();view.info=null;view.error=null;
  if(kind==='root'){view.kind='root';renderWikiPage(view);if(view.view!=='home')await loadWikiPages(view);return;}
  view.kind='checking';renderWikiPage(view);
  if(state.offline||state.localPageOnly){view.error='위키 담당자와 검증 설정은 연결 후 확인할 수 있습니다.';renderWikiPage(view);return;}
  const serial=view.serial=(view.serial||0)+1;
  view.pending=(async()=>{try{
    const info=await api('/pages/'+encodeURIComponent(view.scope.pageId)+'/wiki-owner',undefined,'GET',{signal:view.request.signal,current:()=>wikiCurrent(view)&&view.serial===serial});
    if(!wikiCurrent(view)||view.serial!==serial)return;
    if(typeof info.in_wiki!=='boolean'||!validWikiOwner(info.owner)||!Array.isArray(info.members)||!info.members.every(member=>member!==null&&validWikiOwner(member))||!Number.isSafeInteger(info.revision)||typeof info.can_manage!=='boolean'||typeof info.can_verify!=='boolean'||info.wiki!==null&&(!info.wiki||typeof info.wiki.id!=='string'||typeof info.wiki.title!=='string'))throw new Error('위키 담당자 정보를 확인하지 못했습니다.');
    if(info.revision!==state.page.revision){view.error='페이지가 변경되었습니다. 다시 확인해 주세요.';return;}
    view.info=info;view.kind=info.in_wiki?'child':'ordinary';
  }catch(error){if(!wikiCurrent(view)||view.serial!==serial)return;view.info=null;view.kind='unknown';view.error=[403,404].includes(error.status)?'현재 위키 정보를 확인할 수 없습니다.':error.message;}
  finally{if(wikiCurrent(view)&&view.serial===serial){view.pending=null;renderWikiPage(view);invalidateVerificationView();}}})();return view.pending;
}
async function loadWikiPages(view,more=false){
  if(!wikiCurrent(view)||view.loading||view.kind!=='root'||view.view==='home')return;
  if(state.offline){view.error='페이지 목록은 인터넷 연결 후 확인할 수 있습니다.';renderWikiPage(view);return;}
  view.loading=true;view.error=null;const offset=more?view.items.length:0,tab=view.view,query=view.query,serial=view.serial=(view.serial||0)+1;view.request?.abort();view.request=new AbortController();renderWikiPage(view);
  try{
    const result=await api('/pages/'+encodeURIComponent(view.scope.pageId)+'/wiki?view='+tab+'&q='+encodeURIComponent(query)+'&limit=50&offset='+offset,undefined,'GET',{signal:view.request.signal,current:()=>wikiCurrent(view)&&view.serial===serial});
    if(!wikiCurrent(view)||view.serial!==serial)return;
    if(!result.wiki||result.wiki.id!==view.scope.pageId||!Array.isArray(result.items)||result.items.length>50||!result.items.every(item=>typeof item.id==='string'&&typeof item.title==='string'&&validWikiOwner(item.owner)&&typeof item.can_edit==='boolean'&&typeof item.can_verify==='boolean')||!Number.isSafeInteger(result.total)||typeof result.has_more!=='boolean'||result.offset!==offset||result.limit!==50)throw new Error('위키 목록을 확인하지 못했습니다.');
    const items=more?[...view.items,...result.items]:result.items;if(new Set(items.map(item=>item.id)).size!==items.length)throw new Error('목록이 변경되었습니다. 새로고침해 주세요.');view.items=items;view.total=result.total;view.hasMore=result.has_more;
  }catch(error){if(!wikiCurrent(view)||view.serial!==serial)return;if([401,403,404].includes(error.status)){view.items=[];view.total=0;view.hasMore=false;}view.error=error.message;}
  finally{if(wikiCurrent(view)&&view.serial===serial){view.loading=false;renderWikiPage(view);}}
}
async function wikiTab(tab){
  const view=state.wikiPage;if(!wikiCurrent(view)||view.kind!=='root'||!['home','all','owned'].includes(tab))return;
  if(state.composition){toast('입력 중인 글자를 완료한 뒤 보기를 바꿔 주세요.');return;}
  reconcileEditor();view.request?.abort();view.serial=(view.serial||0)+1;view.loading=false;view.view=tab;view.items=[];view.total=0;view.hasMore=false;view.error=null;renderWikiPage(view);if(tab!=='home')await loadWikiPages(view);
}
function wikiMutationCurrent(view){return state.wikiMutation===view&&view.modal?.isConnected&&$('.wiki-mutation-modal')===view.modal&&wikiScopeCurrent(view.scope)&&pageEditable()&&!state.offline&&!state.localPageOnly;}
function wikiToggleModal(){
  if(!pageEditable()||resourceLevel(state.page)<4||state.offline||state.localPageOnly||state.page.parent_id&&!state.page.is_wiki)throw new Error('독립 페이지의 전체 권한으로 연결된 상태에서 설정할 수 있습니다.');
  const scope=wikiScope(),revision=state.page.revision,remove=state.page.is_wiki===true;
  if(!Number.isSafeInteger(revision))throw new Error('페이지를 다시 열어 버전을 확인해 주세요.');
  openModal(remove?'위키 해제':'위키로 전환',`<p>${remove?'일반 페이지로 되돌립니다. 본문, 하위 페이지와 공유 권한은 유지됩니다.':'이 페이지의 본문은 위키 홈으로 유지됩니다. 모든 페이지와 내 담당 페이지 보기를 사용할 수 있습니다.'}</p><div class="wiki-error" role="alert"></div><div class="form-actions"><button class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn" data-action="confirm-wiki-toggle">${remove?'위키 해제':'위키로 전환'}</button></div>`,'wiki-mutation-modal');state.wikiMutation={scope,revision,remove,kind:'toggle',modal:$('.wiki-mutation-modal'),busy:false};
}
async function wikiOwnerModal(){
  const initial=wikiScope(),overlay=$('#overlay-root').firstChild;await syncWikiPage(true);if(!wikiScopeCurrent(initial)||$('#overlay-root').firstChild!==overlay)return;const page=state.wikiPage;if(!wikiCurrent(page)||!page.info?.in_wiki||!page.info.can_manage||!pageEditable())throw new Error('현재 위키 페이지의 편집 권한이 필요합니다.');
  const scope=wikiScope(),info=page.info;
  openModal('지식 담당자 변경',`<p>담당자 지정으로 문서 접근 권한이 추가되지 않습니다. 지식 담당자는 편집 권한이 있을 때 이 페이지를 검증할 수 있습니다.</p><form id="wiki-owner-form" class="form-grid"><label>지식 담당자<select name="owner_id" required><option value="">담당자 선택</option>${info.members.map(member=>`<option value="${esc(member.id)}" ${member.id===info.owner?.id?'selected':''}>${esc(member.name||'이름 없는 멤버')}</option>`).join('')}</select></label><div class="wiki-error" role="alert"></div><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">취소</button><button type="submit" class="solid-btn">담당자 저장</button></div></form>`,'wiki-mutation-modal');state.wikiMutation={scope,revision:info.revision,kind:'owner',modal:$('.wiki-mutation-modal'),busy:false,ids:info.members.map(member=>member.id)};
}
async function saveWikiMutation(){
  const view=state.wikiMutation;if(!wikiMutationCurrent(view)||view.busy)return;const error=$('.wiki-error',view.modal);let owner;
  try{
    if(view.kind==='owner'){owner=$('[name="owner_id"]',view.modal).value;if(!view.ids.includes(owner))throw new Error('담당자를 선택해 주세요.');}
    view.busy=true;error.textContent='';for(const control of $$('input,select,button',view.modal))if(control.dataset.action!=='close-modal')control.disabled=true;
    const current=()=>wikiMutationCurrent(view);
    if(!current())return;await saveTitle();if(!current())return;await savePage();if(!current())return;
    if(state.page.revision!==view.revision)throw new Error('페이지가 설정을 연 뒤 변경되었습니다. 취소하고 최신 페이지에서 다시 확인해 주세요.');
    view.request=new AbortController();await api('/pages/'+encodeURIComponent(view.scope.pageId)+(view.kind==='owner'?'/wiki-owner':'/wiki'),view.kind==='owner'?{owner_id:owner,revision:view.revision}:{revision:view.revision},view.kind==='owner'?'PATCH':view.remove?'DELETE':'POST',{signal:view.request.signal,current});if(!current())return;
    const snapshot=await api('/pages/'+encodeURIComponent(view.scope.pageId)+'/collaboration',undefined,'GET',{signal:view.request.signal,current});if(!current())return;await view.scope.channel.receive(snapshot,'wiki');if(!current())return;
    const index=state.workspace.pages.findIndex(page=>page.id===view.scope.pageId);if(index>=0)state.workspace.pages[index]=state.page;renderSidebar();closeModal();await syncWikiPage(true);
  }catch(failure){if(wikiMutationCurrent(view)){error.textContent=failure.status===409?'페이지가 변경되었습니다. 입력은 유지됩니다. 취소하고 최신 정보를 다시 확인해 주세요.':failure.message;if([403,404].includes(failure.status))clearWikiPage();}}
  finally{if(wikiMutationCurrent(view)){view.busy=false;for(const control of $$('input,select,button',view.modal))control.disabled=false;}}
}
function clearInbox(){const view=state.inboxView;state.inboxView=null;if(view){view.closed=true;view.request?.abort();view.items=[];if(view.modal?.isConnected)view.modal.closest('.modal-backdrop')?.remove();}}
function inboxScopeCurrent(view) {
  const scope=view?.scope;
  return !!scope&&!view.closed&&state.inboxView===view&&view.modal?.isConnected&&$('.inbox-modal')===view.modal&&!state.nativeRecoveryPaused&&!state.nativeOutboxPause&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.member&&state.session?.member?.role===scope.role&&state.offlineProfile?.id===scope.profile&&state.workspace?.workspace_id===scope.workspace&&state.bootGeneration===scope.boot&&FountainTransport.scopeEpoch===scope.epoch&&FountainTransport.origin===scope.origin;
}
function inboxOnline(){return !state.offline&&navigator.onLine;}
function renderInbox(view) {
  if(!inboxScopeCurrent(view))return;
  const disabled=view.loading||view.busy||!inboxOnline(),labels={all:'전체',unread:'읽지 않음',archived:'보관함'};
  $('.modal-body',view.modal).innerHTML=`<p class="inbox-intro">내가 담당하는 페이지나 데이터베이스 항목의 검증이 만료되면 표시됩니다. 읽음·보관 상태는 같은 계정의 다른 기기에서도 이어집니다.</p><div class="inbox-toolbar"><nav aria-label="알림 필터">${Object.entries(labels).map(([filter,label])=>`<button class="outline-btn ${view.filter===filter?'selected':''}" data-action="inbox-filter" data-filter="${filter}" aria-pressed="${view.filter===filter}" ${disabled?'disabled':''}>${label}</button>`).join('')}</nav><button class="outline-btn" data-action="inbox-refresh" ${view.loading||view.busy?'disabled':''}>새로고침</button></div><div id="inbox-status" role="status" aria-live="polite">${!inboxOnline()?'알림함은 인터넷 연결 후 사용할 수 있습니다.':view.loading?'알림을 확인하는 중…':`읽지 않은 알림 ${view.unread}개`}</div><div id="inbox-error" role="alert">${esc(view.error||'')}</div><div class="inbox-list">${view.items.map(item=>`<article class="inbox-item ${item.read?'':'unread'}"><button class="inbox-page" data-action="inbox-open" data-id="${item.id}" ${disabled?'disabled':''}><span aria-hidden="true">${esc(item.icon||'📄')}</span><span><strong>${esc(item.title||'제목 없음')}</strong><small>${item.resource_type==='row'?'항목':'페이지'} 검증 만료 · ${esc(verificationDate(item.expires_at))}</small></span>${!item.read?'<span class="inbox-unread-dot" aria-label="읽지 않음"></span>':''}</button><div class="inbox-item-actions"><button class="text-btn" data-action="inbox-read" data-id="${item.id}" ${disabled?'disabled':''}>${item.read?'읽지 않음으로 표시':'읽음으로 표시'}</button><button class="text-btn" data-action="inbox-archive" data-id="${item.id}" ${disabled?'disabled':''}>${item.archived?'보관 해제':'보관'}</button></div></article>`).join('')||(!view.loading?'<div class="inbox-empty">이곳에 표시할 알림이 없습니다.</div>':'')}</div><div class="inbox-footer"><span>${view.total}개 중 ${view.items.length}개 표시</span>${view.hasMore?`<button class="outline-btn" data-action="inbox-more" ${disabled?'disabled':''}>더 보기</button>`:''}</div>`;
  view.modal.setAttribute('aria-busy',String(!!(view.loading||view.busy)));
}
function validInboxItem(item) {
  return !!item&&/^[a-f0-9]{64}$/.test(item.id)&&item.type==='verification.expired'&&[undefined,'page','row'].includes(item.resource_type)&&(item.resource_type==='row'?typeof item.row_id==='string'&&item.row_id.length>0&&typeof item.database_id==='string'&&item.database_id.length>0:typeof item.page_id==='string'&&item.page_id.length>0)&&typeof item.title==='string'&&(item.icon==null||typeof item.icon==='string')&&verificationTimestamp(item.verified_at)&&verificationTimestamp(item.expires_at)&&typeof item.read==='boolean'&&typeof item.archived==='boolean';
}
async function loadInbox(view,more=false) {
  if(!inboxScopeCurrent(view)||view.loading||view.busy)return;
  if(!inboxOnline()){view.error='인터넷에 연결한 뒤 새로고침해 주세요.';renderInbox(view);return;}
  view.loading=true;view.error=null;view.request=new AbortController();renderInbox(view);
  const offset=more?view.items.length:0,filter=view.filter;
  try{
    if(!inboxScopeCurrent(view)||!inboxOnline())return;
    const result=await api('/inbox?filter='+filter+'&limit=50&offset='+offset,undefined,'GET',{signal:view.request.signal,current:()=>inboxScopeCurrent(view)&&inboxOnline()});
    if(!inboxScopeCurrent(view)||filter!==view.filter||!inboxOnline())return;
    if(!Array.isArray(result.items)||result.items.length>50||!result.items.every(validInboxItem)||!Number.isSafeInteger(result.unread_count)||result.unread_count<0||!Number.isSafeInteger(result.total)||result.total<0||typeof result.has_more!=='boolean'||result.offset!==offset||result.limit!==50)throw new Error('알림 응답을 확인하지 못했습니다. 다시 시도해 주세요.');
    const items=more?[...view.items,...result.items]:result.items;
    if(new Set(items.map(item=>item.id)).size!==items.length)throw new Error('알림 목록이 변경되었습니다. 새로고침해 주세요.');
    view.items=items;view.unread=result.unread_count;view.total=result.total;view.hasMore=result.has_more;
  }catch(error){if(!inboxScopeCurrent(view))return;if([401,403,404].includes(error.status)){view.items=[];view.total=0;view.hasMore=false;}view.error=error.message;}
  finally{if(inboxScopeCurrent(view)){view.loading=false;view.request=null;renderInbox(view);}}
}
async function openInbox() {
  const scope={binding:state.session?.cache_binding,member:state.session?.member?.id,role:state.session?.member?.role,profile:state.offlineProfile?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,epoch:FountainTransport.scopeEpoch,origin:FountainTransport.origin};
  if(!scope.member)throw new Error('로그인한 뒤 알림함을 확인해 주세요.');
  openModal('알림함','<div class="loading">알림을 확인하는 중…</div>','inbox-modal');
  const view={scope,modal:$('.inbox-modal'),filter:'all',items:[],unread:0,total:0,hasMore:false,loading:false,busy:false,error:null,closed:false};state.inboxView=view;
  view.modal.onkeydown=event=>{if(event.key!=='Tab')return;const controls=$$('button',view.modal).filter(button=>!button.disabled&&button.getClientRects().length),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}};
  renderInbox(view);await loadInbox(view);
}
async function inboxAction(action,id) {
  const view=state.inboxView;if(!inboxScopeCurrent(view)||view.loading||view.busy)return;
  const item=view.items.find(item=>item.id===id);if(!item)return;
  if(!inboxOnline()){view.error='읽음·보관 변경은 인터넷 연결 후 사용할 수 있습니다.';renderInbox(view);return;}
  const patch=action==='inbox-archive'?{archived:!item.archived}:{read:action==='inbox-open'?true:!item.read};
  view.busy=true;view.error=null;view.request=new AbortController();renderInbox(view);
  let refresh=false;
  try{
    if(!inboxScopeCurrent(view)||!inboxOnline())return;
    const result=await api('/inbox/'+id,patch,'PATCH',{signal:view.request.signal,current:()=>inboxScopeCurrent(view)&&inboxOnline()});
    if(!inboxScopeCurrent(view)||!inboxOnline())return;
    if(!validInboxItem(result)||result.id!==item.id||result.page_id!==item.page_id||result.resource_type!==item.resource_type||result.row_id!==item.row_id||result.database_id!==item.database_id)throw new Error('변경된 알림을 확인하지 못했습니다. 새로고침해 주세요.');
    if(action==='inbox-open'){const scope=view.scope;closeModal();if(item.resource_type==='row'){const opened=await navigate('database',item.database_id);if(opened===true&&sameDatabaseIdentity(scope)&&state.database?.id===item.database_id&&!$('.modal')&&state.rows.some(row=>row.id===item.row_id))openRow(item.row_id);}else await navigate('page',item.page_id);return;}
    refresh=true;
  }catch(error){if(!inboxScopeCurrent(view))return;if([401,403,404].includes(error.status)){view.items=[];view.total=0;view.hasMore=false;refresh=error.status!==401;}view.error=error.status===404?'알림이 갱신되었거나 접근 권한이 변경되었습니다. 목록을 다시 확인해 주세요.':error.status===403?'알림을 확인할 권한이 없습니다. 목록을 다시 확인해 주세요.':error.message;}
  finally{if(inboxScopeCurrent(view)){view.busy=false;view.request=null;renderInbox(view);}}
  if(refresh&&inboxScopeCurrent(view)){const error=view.error;await loadInbox(view);if(error&&inboxScopeCurrent(view)){view.error=error;renderInbox(view);}}
}
function stopBackup(){const manager=state.backupManager;state.backupManager=null;if(manager)void manager.close();}
function backupScope(){return {profileId:state.offlineProfile?.id,binding:state.session?.cache_binding,workspaceId:state.workspace?.workspace_id||state.session?.workspace_id||state.offlineProfile?.workspaceId,memberId:state.session?.member?.id,accountBinding:state.session?.account_binding,transportEpoch:FountainTransport.scopeEpoch,boot:state.bootGeneration,channel:state.channel,epoch:state.channel?.base?.epoch,route:state.route};}
async function openBackup(){
  if(!isOwner())throw new Error('소유자만 백업할 수 있습니다.');
  openModal('워크스페이스 백업','<p>서버에 저장된 내용을 백업 파일로 준비합니다.</p><div id="backup-status" role="status" aria-live="polite"></div><progress id="backup-progress" aria-label="백업 진행률" style="width:100%"></progress><div class="form-actions"><button class="outline-btn" data-action="backup-cancel">취소</button><button class="solid-btn" data-action="backup-retry" hidden>다시 시도</button></div>','backup-modal');
  const modal=$('.backup-modal'),current=scope=>modal.isConnected&&isOwner()&&!state.nativeRecoveryPaused&&Object.entries(scope).every(([key,value])=>backupScope()[key]===value);
  const manager=new FountainBackup.Manager({getScope:backupScope,isCurrent:current,onChange:value=>{
    if(state.backupManager!==manager||!modal.isConnected)return;
    const labels={working:value.job?.phase==='snapshot'?'저장된 내용을 확인하고 있어요…':'백업 파일을 만들고 있어요…',downloading:'백업 파일을 내려받고 있어요…',complete:FountainTransport.native?'백업 파일을 저장했습니다.':'백업 파일을 전달했습니다. 브라우저의 다운로드 목록에서 확인하세요.',legacy:'기존 서버의 백업 다운로드를 시작했습니다.',error:value.error||'백업을 완료하지 못했습니다.'};
    const progress=value.job?.progress,detail=value.state==='working'&&progress?` · ${progress.source_rows.toLocaleString('ko-KR')}개 항목 · ${(progress.output_bytes/1048576).toLocaleString('ko-KR',{maximumFractionDigits:1})} MB`:value.state==='downloading'&&value.job?.size?` · ${(value.downloaded/1048576).toLocaleString('ko-KR',{maximumFractionDigits:1})} / ${(value.job.size/1048576).toLocaleString('ko-KR',{maximumFractionDigits:1})} MB`:'';
    $('#backup-status').textContent=(labels[value.state]||'백업을 준비하고 있어요…')+detail;
    const meter=$('#backup-progress');if(value.state==='complete'){meter.max=1;meter.value=1;}else if(value.state==='downloading'&&value.job?.size){meter.max=value.job.size;meter.value=value.downloaded;}else meter.removeAttribute('value');
    $('[data-action="backup-retry"]',modal).hidden=value.state!=='error';$('[data-action="backup-retry"]',modal).textContent=value.restartRequired?'새 백업 시작':'다시 시도';$('[data-action="backup-cancel"]',modal).textContent=['complete','legacy','error'].includes(value.state)?'닫기':'취소';
  }});
  state.backupManager=manager;await manager.start();
}
function field(label,name,placeholder='',type='text',value='') {
  return `<label>${label}<input name="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${type==='text'?'maxlength="300"':''}></label>`;
}
function form(content,id,submit='만들기') {
  return `<form class="form-grid" id="${id}">${content}<div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn">${submit}</button></div></form>`;
}
function openSearch() {
  if(!state.loaded||!state.workspace||state.nativeRecoveryPaused||state.authSuspending)return;
  const options=(items,label)=>`<option value="">${label}</option>${items.map(item=>`<option value="${esc(item.id)}">${esc(item.name||item.title||item.email||item.id)}</option>`).join('')}`;
  openModal('워크스페이스 검색',`<input class="search-input" id="search-input" placeholder="페이지, 데이터베이스, 항목 검색…" aria-label="검색어"><div class="search-tools"><span id="search-mode" role="status">검색 범위를 확인하고 있어요…</span><button class="outline-btn" id="search-filter-toggle" aria-expanded="false" aria-controls="search-filters">${icon('filter')}필터</button></div><form id="search-filters" hidden><fieldset disabled><div class="search-types"><label><input type="checkbox" name="types" value="page" checked>페이지</label><label><input type="checkbox" name="types" value="database" checked>데이터베이스</label><label><input type="checkbox" name="types" value="row" checked>항목</label><label><input type="checkbox" name="title_only">제목만</label></div><div class="search-filter-grid"><label>소유자<select name="owner">${options(state.workspace.members||[],'모든 소유자')}</select></label><label>팀스페이스<select name="teamspace">${options(state.workspace.teamspaces||[],'전체 팀스페이스')}</select></label><label class="search-filter-wide">페이지 범위<select name="in">${options(state.workspace.pages||[],'모든 페이지 · 하위 문서 포함')}</select></label><label>날짜 기준<select name="date_field"><option value="updated">수정일</option><option value="created">생성일</option></select></label><label>정렬<select name="sort"><option value="relevance">관련도</option><option value="updated_desc">최근 수정순</option><option value="updated_asc">오래된 수정순</option><option value="created_desc">최근 생성순</option><option value="created_asc">오래된 생성순</option><option value="title">제목순</option></select></label><label>시작일<input type="date" name="after"></label><label>종료일 · 해당 날짜 포함<input type="date" name="before"></label></div><button type="button" class="text-btn" id="search-reset">필터 초기화</button></fieldset></form><div id="search-status" role="status" aria-live="polite"></div><div class="search-results" id="search-results"></div><div class="search-footer"><span class="keyboard-hint">Enter로 열기 · Esc로 닫기</span><button class="outline-btn" id="search-more" hidden>더 보기</button><button class="outline-btn" id="search-retry" hidden>다시 검색</button></div>`,'search-modal');
  $('.modal-body').style.padding='0';
  $('.modal-head').style.display='none';
  const view={modal:$('.search-modal'),input:$('#search-input'),results:$('#search-results'),form:$('#search-filters'),status:$('#search-status'),modeLabel:$('#search-mode'),more:$('#search-more'),retry:$('#search-retry'),sequence:0,items:[],next:null,marker:null,closed:false,busy:false,offline:state.offline,mode:state.offline?'offline':'pending',scope:searchScope(),probe:new AbortController()};
  searchView=view;
  $('#search-filter-toggle').onclick=event=>{const expanded=event.currentTarget.getAttribute('aria-expanded')!=='true';event.currentTarget.setAttribute('aria-expanded',String(expanded));view.form.hidden=!expanded;};
  view.form.onchange=()=>renderSearch(view);
  view.form.onsubmit=event=>{event.preventDefault();renderSearch(view);};
  $('#search-reset').onclick=()=>{view.form.reset();renderSearch(view);};
  view.more.onclick=()=>renderSearch(view,true);view.retry.onclick=()=>renderSearch(view);
  view.results.onclick=event=>{const button=event.target.closest('.search-result');if(!button)return;event.stopPropagation();const item=view.items[Number(button.dataset.index)];if(item)void openSearchResult(view,item);};
  updateSearchMode(view);
  if(view.offline){void renderSearch(view);return;}
  void (async()=>{try{
    const capabilities=await api('/capabilities',undefined,undefined,{signal:view.probe.signal,current:()=>searchCurrent(view)});
    if(!searchCurrent(view))return;view.mode=capabilities.search_advanced===true?'advanced':'legacy';
  }catch(error){if(!searchCurrent(view)||error.name==='AbortError'||error.code==='STALE_REQUEST')return;if([404,405].includes(error.status))view.mode='legacy';else{view.mode='unavailable';view.status.textContent='검색 지원 여부를 확인하지 못했습니다. 연결과 권한을 확인한 뒤 다시 열어 주세요.';}}
  if(!searchCurrent(view))return;updateSearchMode(view);if(view.mode!=='unavailable')await renderSearch(view);
  })();
}
function searchScope(){return {binding:state.session?.cache_binding,member:state.session?.member?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,epoch:FountainTransport.scopeEpoch};}
function sameSearchScope(scope){return !state.nativeRecoveryPaused&&!state.authSuspending&&Object.entries(scope).every(([key,value])=>searchScope()[key]===value);}
function searchCurrent(view){return searchView===view&&!view.closed&&view.modal.isConnected&&$('.search-modal')===view.modal&&$('#search-results')===view.results&&view.offline===state.offline&&sameSearchScope(view.scope);}
window.addEventListener('offline',()=>{if(searchView)closeModal();});
window.addEventListener('online',()=>{if(searchView)closeModal();});
function updateSearchMode(view){view.modeLabel.textContent={pending:'검색 범위를 확인하고 있어요…',advanced:'페이지 · 데이터베이스 · 항목 검색',legacy:'기존 서버 · 페이지 검색만 지원',offline:'오프라인 · 기기에 보관된 제목만 검색',unavailable:'검색을 사용할 수 없습니다.'}[view.mode];$('fieldset',view.form).disabled=view.mode!=='advanced';}
function searchParameters(view,more){
  const fields=new FormData(view.form),query=new URLSearchParams({q:view.input.value,limit:'20'}),types=fields.getAll('types');
  if(!types.length)throw new Error('검색할 유형을 하나 이상 선택하세요.');query.set('types',types.join(','));query.set('title_only',fields.has('title_only')?'1':'0');
  for(const name of ['owner','teamspace','in','date_field','sort'])if(fields.get(name))query.set(name,fields.get(name));
  for(const name of ['after','before'])if(fields.get(name)){const value=String(fields.get(name));if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('날짜를 확인해 주세요.');const [y,m,d]=value.split('-').map(Number),date=new Date(0);date.setFullYear(y,m-1,d);date.setHours(0,0,0,0);if(name==='before')date.setDate(date.getDate()+1);const iso=date.toISOString();if(!/^\d{4}-/.test(iso))throw new Error('날짜 범위를 확인해 주세요.');query.set(name,iso);}
  if(query.has('after')&&query.has('before')&&query.get('after')>=query.get('before'))throw new Error('종료일은 시작일보다 빠를 수 없습니다.');
  if(more){query.set('offset',String(view.next));query.set('result_set',view.marker);}return query;
}
async function renderSearch(view,more=false){
  if(!view||!searchCurrent(view)||['pending','unavailable'].includes(view.mode)||more&&view.busy)return;
  view.request?.abort();const controller=new AbortController();view.request=controller;const sequence=++view.sequence,current=()=>searchCurrent(view)&&sequence===view.sequence&&!controller.signal.aborted;
  view.busy=true;view.more.hidden=true;view.retry.hidden=true;view.status.textContent='검색하고 있어요…';
  if(!more){view.items=[];view.next=null;view.marker=null;view.results.replaceChildren();}
  try{
    let data;
    if(view.mode==='offline'){const q=view.input.value.toLocaleLowerCase();data={results:[...(state.workspace.pages||[]).filter(p=>state.cachedPages?.has(p.id)).map(p=>({type:'page',id:p.id,title:p.title,icon:p.icon})),...(state.workspace.databases||[]).filter(d=>state.cachedDatabases?.has(d.id)).map(d=>({type:'database',id:d.id,title:d.name,icon:d.icon}))].filter(item=>(item.title||'').toLocaleLowerCase().includes(q))};}
    else data=await api(view.mode==='advanced'?'/search/advanced?'+searchParameters(view,more):'/search?q='+encodeURIComponent(view.input.value),undefined,undefined,{signal:controller.signal,current});
    if(!current())return;
    const items=normalizeList(data.results||data.pages||data).filter(item=>view.mode==='legacy'?(item.type||'page')==='page':['page','database','row'].includes(item.type||'page')).map(item=>({type:item.type||'page',id:item.id||item.page_id,title:item.title||item.name||'제목 없음',icon:item.icon,snippet:view.mode==='offline'?'기기에 보관된 제목':item.snippet||item.excerpt||'',database_id:item.database_id,database_title:item.database_title}));
    view.items=more?[...view.items,...items]:items;view.next=data.has_more&&Number.isSafeInteger(data.next_offset)?data.next_offset:null;view.marker=typeof data.result_set==='string'&&/^[a-f0-9]{64}$/.test(data.result_set)?data.result_set:null;
    view.results.innerHTML=view.items.length?view.items.map((item,index)=>`<button class="search-result" data-index="${index}"><span class="page-icon">${esc(item.icon||(item.type==='row'?'▦':item.type==='database'?'▤':'📄'))}</span><span class="search-result-copy"><span class="search-result-title">${esc(item.title)}</span><small class="search-result-kind">${esc(item.type==='row'?'항목 · '+(item.database_title||'데이터베이스'):item.type==='database'?'데이터베이스':'페이지')}</small>${item.snippet?`<small class="search-result-snippet">${esc(item.snippet)}</small>`:''}</span><span class="search-result-arrow" aria-hidden="true">↵</span></button>`).join(''):'<div class="empty">검색 결과가 없어요. 다른 단어나 필터를 확인해 주세요.</div>';
    view.status.textContent=view.mode==='advanced'?`${Number.isSafeInteger(data.total)?data.total:view.items.length}개 결과 · ${view.items.length}개 표시`:`${view.items.length}개 결과`;
    view.more.hidden=!(view.next!==null&&view.marker);view.more.disabled=false;
  }catch(error){
    if(!current()||error.name==='AbortError'||error.code==='STALE_REQUEST')return;
    if([403,404].includes(error.status)){view.items=[];view.next=null;view.marker=null;view.results.replaceChildren();}
    if(error.status===409){view.items=[];view.next=null;view.marker=null;view.results.replaceChildren();view.status.textContent='목록이 변경되었습니다. 처음부터 다시 검색해 주세요.';view.retry.hidden=false;}
    else view.status.textContent=error.status===404?'선택한 범위를 찾을 수 없거나 접근할 수 없습니다.':error.status===403?'이 검색에 접근할 권한이 없습니다.':error.status&&error.status>=500?'검색 서버에 연결하지 못했습니다. 다시 시도해 주세요.':error.message;
  }finally{if(current())view.busy=false;}
}
async function openSearchResult(view,item){
  if(!searchCurrent(view)||typeof item.id!=='string')return;
  const scope=view.scope,ticket=searchNavigation;
  if(item.type!=='row'){await navigate(item.type==='database'?'database':'page',item.id);return;}
  if(typeof item.database_id!=='string')return;
  const opened=await navigate('database',item.database_id);
  if(opened!==true||!sameSearchScope(scope)||searchNavigation!==ticket+1||$('.modal')||state.route!=='database'||state.database?.id!==item.database_id)return;
  if(!state.rows.some(row=>row.id===item.id)){toast('항목이 삭제되었거나 더 이상 접근할 수 없습니다.');return;}
  openRow(item.id);
}
function sameDatabaseIdentity(scope){return !!scope&&!state.authSuspending&&!state.nativeOutboxPause&&!state.nativeRecoveryPaused&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.member&&state.session?.member?.role===scope.role&&state.offlineProfile?.id===scope.profile&&state.workspace?.workspace_id===scope.workspace&&state.bootGeneration===scope.boot&&FountainTransport.scopeEpoch===(scope.epoch??scope.transportEpoch)&&FountainTransport.origin===scope.origin;}
function databaseScope(){return {databaseId:state.database?.id,route:state.route,binding:state.session?.cache_binding,member:state.session?.member?.id,role:state.session?.member?.role,profile:state.offlineProfile?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,epoch:FountainTransport.scopeEpoch,origin:FountainTransport.origin,schema:FountainCollaboration.canonical(state.database?.properties||[])};}
function rowEditingScopeCurrent(scope){return sameDatabaseIdentity(scope)&&state.route===scope.route&&state.database?.id===scope.databaseId;}
function databaseScopeCurrent(scope){return sameDatabaseIdentity(scope)&&state.route===scope.route&&state.database?.id===scope.databaseId&&FountainCollaboration.canonical(state.database?.properties||[])===scope.schema;}
function databaseOwnerInputs(property,value,editable=true,members=state.workspace?.members||[]){
  const selected=Array.isArray(value)?value.filter(id=>typeof id==='string'):[];
  const people=members.filter(member=>member&&typeof member.id==='string'&&typeof member.name==='string'&&member.active!==false);
  return `<fieldset class="database-owner-inputs" data-owner-property="${esc(property.id)}"><legend>${property.limit==='unlimited'?'여러 명 선택 가능':'한 명 선택'}</legend>${people.map(member=>`<label><input type="checkbox" name="${esc(property.id)}" value="${esc(member.id)}" ${selected.includes(member.id)?'checked':''} ${!editable?'disabled':''}><span>${esc(member.name||'이름 없는 멤버')}</span></label>`).join('')||'<span class="muted">선택할 수 있는 담당자가 없습니다.</span>'}</fieldset>`;
}
function clearDatabaseVerification(){const view=state.databaseVerification;state.databaseVerification=null;view?.request?.abort();if(view?.panel?.isConnected)view.panel.replaceChildren();}
function clearDatabasePropertyView(){const view=state.databasePropertyView;state.databasePropertyView=null;view?.request?.abort();}
function databaseVerificationCurrent(view){return !!view&&state.databaseVerification===view&&databaseScopeCurrent(view.scope)&&view.modal?.isConnected&&view.modal===state.rowEditingModal&&view.form===$('#row-form')&&view.form.dataset.id===view.rowId&&state.rowEditingBaseline?.id===view.rowId&&state.rows.some(row=>row.id===view.rowId&&resourceLevel(row)>=1)&&!state.offline&&FountainCollaboration.canonical(state.rows.find(row=>row.id===view.rowId))===view.rowCanonical;}
function validDatabaseVerification(info,view){
  const expectedOwner=state.rowEditingDatabase?.properties.find(property=>property.type==='owner'),expectedVerification=state.rowEditingDatabase?.properties.find(property=>property.type==='verification')||null;
  if(FountainCollaboration.canonical(expectedOwner)!==FountainCollaboration.canonical(info?.owner_property)||FountainCollaboration.canonical(expectedVerification)!==FountainCollaboration.canonical(info?.verification_property))return false;
  return !!info&&info.database_id===view.scope.databaseId&&info.row_id===view.rowId&&/^[a-f0-9]{64}$/.test(info.revision)&&info.owner_property?.type==='owner'&&typeof info.owner_property.id==='string'&&(info.verification_property===null||info.verification_property?.type==='verification'&&typeof info.verification_property.id==='string')&&Array.isArray(info.owners)&&info.owners.every(id=>typeof id==='string')&&Array.isArray(info.members)&&info.members.every(member=>member&&typeof member.id==='string'&&typeof member.name==='string')&&typeof info.can_verify==='boolean'&&typeof info.can_manage==='boolean'&&info.verification&&['unverified','verified','expired','unknown'].includes(info.verification.status)&&(info.verification.verified_at===null||verificationTimestamp(info.verification.verified_at))&&(info.verification.expires_at===null||verificationTimestamp(info.verification.expires_at));
}
function renderDatabaseVerification(view){
  if(!databaseVerificationCurrent(view)||!view.info)return;const info=view.info,value=info.verification,expiry=value.expires_at,mode=expiry?'finite':'infinite';
  view.panel.innerHTML=`<div class="row-verification-heading"><strong>항목 검증</strong>${databaseValueHTML({type:'verification'},value)}</div><p class="small muted">현재 담당자가 지정된 항목을 편집 권한으로 검증합니다. 작성 중인 다른 속성은 그대로 보관됩니다.</p><div class="row-verification-current">담당자 · ${info.owners.map(id=>esc(databaseMemberName(id,info.members))).join(', ')||'미지정'}${value.verified_at?`<br>확인 ${esc(verificationDate(value.verified_at))}`:''}</div>${info.verification_property?`<label>검증 유효 기간<select data-row-verification-mode data-recovery-field="__verification_mode"><option value="infinite" ${mode==='infinite'?'selected':''}>만료 없음</option><option value="finite" ${mode==='finite'?'selected':''}>만료일 지정</option></select></label><label data-row-verification-expiry ${!expiry?'hidden':''}>만료 날짜와 시간<input type="datetime-local" step="1" data-recovery-field="__verification_expires" value="${esc(expiry?verificationLocalTime(expiry):'')}"><small>기기 시간대 · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone||'로컬')}</small></label>`:'<p class="small muted">검증 속성을 추가하면 이 항목을 검증할 수 있습니다.</p>'}<div class="database-verification-error" role="alert"></div><div class="row-verification-actions">${info.verification_property?`<button type="button" class="solid-btn" data-action="row-verification-save" ${!info.can_verify?'disabled':''}>검증 저장</button>${value.status!=='unverified'?`<button type="button" class="danger-btn" data-action="row-verification-remove" ${!info.can_manage?'disabled':''}>검증 해제</button>`:''}`:''}<button type="button" class="outline-btn" data-action="row-verification-refresh">최신 검증 확인</button></div>`;
  view.initialTime=$('[data-recovery-field="__verification_expires"]',view.panel)?.value||'';view.expiry=expiry;
  $('[data-row-verification-mode]',view.panel)?.addEventListener('change',event=>{$('[data-row-verification-expiry]',view.panel).hidden=event.target.value!=='finite';});
}
async function openDatabaseVerification({ownerOnly=false}={}){
  const form=$('#row-form'),rowId=form?.dataset.id,row=state.rows.find(row=>row.id===rowId),scope=state.rowEditingScope;
  if(!row||!databaseScopeCurrent(scope)||state.offline||state.nativeOutboxPause||state.nativeRecoveryPaused){if(!ownerOnly)throw Error('현재 항목을 서버에 연결한 상태에서 다시 열어 주세요.');return;}
  const previous=state.databaseVerification;if(previous?.busy)return;previous?.request?.abort();
  let panel=$('#row-verification-panel',form);if(!panel&&!ownerOnly){panel=document.createElement('section');panel.id='row-verification-panel';panel.className='row-verification-panel';$('.form-actions',form).before(panel);}
  const view={scope,rowId,rowCanonical:FountainCollaboration.canonical(row),modal:state.rowEditingModal,form,panel,request:new AbortController(),busy:false};state.databaseVerification=view;
  if(panel&&!ownerOnly)panel.innerHTML='<p role="status">검증 설정을 확인하고 있습니다…</p>';
  const property=state.rowEditingDatabase.properties.find(property=>property.type==='owner'),ownerFields=property?$$(`[name="${CSS.escape(property.id)}"]`,form):[],selection=ownerFields.filter(input=>input.checked).map(input=>input.value);
  try{
    const info=await api('/databases/'+encodeURIComponent(scope.databaseId)+'/rows/'+encodeURIComponent(rowId)+'/verification',undefined,'GET',{signal:view.request.signal,current:()=>databaseVerificationCurrent(view)});if(!databaseVerificationCurrent(view))return;if(!validDatabaseVerification(info,view))throw Error('검증 정보를 읽을 수 없습니다. 최신 항목을 다시 열어 주세요.');view.info=info;
    const fields=property?$$(`[name="${CSS.escape(property.id)}"]`,form):[];
    if(property&&JSON.stringify(fields.filter(input=>input.checked).map(input=>input.value))===JSON.stringify(selection)){
      const element=$(`[data-owner-property="${CSS.escape(property.id)}"]`,form);if(element){const template=document.createElement('template');template.innerHTML=databaseOwnerInputs(info.owner_property,selection,resourceLevel(row)>=3,info.members);for(const input of template.content.querySelectorAll('input')){const original=fields.find(field=>field.value===input.value);if(original)input.defaultChecked=original.defaultChecked;}element.replaceWith(template.content);}
    }
    if(!ownerOnly)renderDatabaseVerification(view);
  }catch(error){if(databaseVerificationCurrent(view)&&!ownerOnly&&panel)panel.innerHTML=`<div class="database-verification-error" role="alert">${esc(error.message)}</div><button type="button" class="outline-btn" data-action="row-verification-refresh">다시 확인</button>`;}
  finally{if(databaseVerificationCurrent(view))view.request=null;}
}
async function saveDatabaseVerification(remove){
  const view=state.databaseVerification;if(view?.busy)return;if(!databaseVerificationCurrent(view)||!view.info)return;
  const error=$('.database-verification-error',view.panel),current=()=>databaseVerificationCurrent(view);error.textContent='';
  if(remove?!view.info.can_manage:!view.info.can_verify){error.textContent='현재 담당자와 편집 권한을 확인해 주세요.';return;}
  view.busy=true;for(const button of $$('.row-verification-actions button',view.panel))button.disabled=true;
  try{
    const finite=$('[data-recovery-field="__verification_mode"]',view.panel)?.value==='finite',local=$('[data-recovery-field="__verification_expires"]',view.panel)?.value||'';let expires=null;
    if(!remove&&finite)expires=local===view.initialTime&&view.expiry?view.expiry:verificationExpiry(local);
    const body={revision:view.info.revision,...(!remove?{expires_at:expires}:{})};view.request=new AbortController();
    const info=await api('/databases/'+encodeURIComponent(view.scope.databaseId)+'/rows/'+encodeURIComponent(view.rowId)+'/verification',body,remove?'DELETE':'POST',{signal:view.request.signal,current});
    if(!current())return;if(!validDatabaseVerification(info,view))throw Error('저장 결과를 읽을 수 없습니다. 최신 검증 확인으로 결과를 확인해 주세요.');
    view.info=info;const property=info.verification_property;if(property){const row=state.rows.find(row=>row.id===view.rowId);row.properties={...valuesOf(row),[property.id]:structuredClone(info.verification)};state.rowEditingBaseline.properties={...valuesOf(state.rowEditingBaseline),[property.id]:structuredClone(info.verification)};view.rowCanonical=FountainCollaboration.canonical(row);const label=$('.row-verification-value',view.form);if(label)label.innerHTML=databaseValueHTML(property,info.verification);}
    renderDatabaseVerification(view);if($('#db-view'))$('#db-view').innerHTML=databaseView();scheduleDatabaseVerificationExpiry();toast(remove?'항목 검증을 해제했습니다.':'항목을 검증했습니다.');
  }catch(failure){if(current()){error.textContent=failure.status===409?'항목이나 담당자 설정이 변경되었습니다. 입력은 보관했습니다. 최신 검증 확인 후 다시 저장해 주세요.':failure.message;if(failure.status===409)view.conflict=true;}}
  finally{if(current()){view.busy=false;view.request=null;for(const button of $$('.row-verification-actions button',view.panel))button.disabled=button.dataset.action==='row-verification-save'?view.conflict||!view.info.can_verify:button.dataset.action==='row-verification-remove'?view.conflict||!view.info.can_manage:false;}}
}
function captureDatabasePropertyView(kind){const form=$(kind==='add'?'#property-form':'#owner-settings-form');if(!form)return;const error=document.createElement('div');error.className='database-property-error';error.setAttribute('role','alert');$('.form-actions',form)?.before(error);state.databasePropertyView={kind,scope:databaseScope(),database:structuredClone(state.database),form,modal:form.closest('.modal'),busy:false};}
function openOwnerSettings(){
  if(state.offline||resourceLevel(state.database)<4)throw Error('연결된 데이터베이스의 전체 권한이 필요합니다.');const property=state.database.properties.find(property=>property.type==='owner');if(!property)throw Error('담당자 속성을 먼저 추가해 주세요.');
  openModal('담당자 속성 설정',`<form id="owner-settings-form" class="form-grid"><p>지식 담당자 지정으로 항목 접근 권한이 추가되지 않습니다. 기본값 변경은 이후에 만드는 항목에 적용됩니다.</p><label>담당자 수<select name="limit"><option value="one" ${property.limit==='one'?'selected':''}>한 명</option><option value="unlimited" ${property.limit==='unlimited'?'selected':''}>제한 없음</option></select></label><label>새 항목의 담당자 기본값<select name="default"><option value="created_by" ${property.default==='created_by'?'selected':''}>작성자</option><option value="none" ${property.default==='none'?'selected':''}>기본값 없음</option></select></label><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">취소</button><button type="submit" class="solid-btn">설정 저장</button></div></form>`,'database-property-modal');captureDatabasePropertyView('settings');
}
async function saveDatabaseProperty(form){
  const view=state.databasePropertyView;if(!view||view.form!==form||view.busy)return;
  const current=()=>state.databasePropertyView===view&&view.modal.isConnected&&databaseScopeCurrent(view.scope)&&!state.offline&&resourceLevel(state.database)>=4,error=$('.database-property-error',form);
  if(!current()){error.textContent='데이터베이스나 로그인 상태가 변경되었습니다. 입력을 확인한 뒤 다시 열어 주세요.';return;}
  view.busy=true;const submit=$('.solid-btn',form);submit.disabled=true;error.textContent='';
  try{
    const data=Object.fromEntries(new FormData(form));let properties=structuredClone(view.database.properties);
    if(view.kind==='settings'){const property=properties.find(property=>property.type==='owner');property.limit=data.limit;property.default=data.default;}
    else{const property={id:uid().slice(0,8),name:data.name||'새 속성',type:data.type};if(['status','select','multi_select'].includes(property.type))property.options=(data.options||'').split(',').map(value=>value.trim()).filter(Boolean);if(property.type==='formula')property.expression=data.expression;if(property.type==='relation')property.database_id=data.database_id;if(property.type==='rollup'){if(!data.relation_property||!data.target_property)throw Error('롤업에 사용할 관계 속성과 대상 속성 ID를 지정해 주세요.');Object.assign(property,{target_property:data.target_property,relation_property:data.relation_property,aggregation:data.aggregation});}properties.push(property);}
    view.request=new AbortController();const latest=await api('/databases/'+encodeURIComponent(view.scope.databaseId),undefined,'GET',{signal:view.request.signal,current});if(!current())return;
    if(FountainCollaboration.canonical(latest.database?.properties||[])!==view.scope.schema)throw Error('다른 기기에서 속성이 변경되었습니다. 입력을 보관했으니 최신 데이터베이스를 다시 열어 주세요.');
    if(!/^[a-f0-9]{64}$/.test(latest.database?.schema_revision||''))throw Error('속성 버전을 확인할 수 없습니다. 최신 데이터베이스를 다시 열어 주세요.');
    await api('/databases/'+encodeURIComponent(view.scope.databaseId),{properties,schema_revision:latest.database.schema_revision},'PATCH',{signal:view.request.signal,current});if(!current())return;
    const result=await loadDatabaseData(view.scope.databaseId);if(!current())return;state.database=result.database;state.rows=result.rows||[];closeModal();renderDatabase();toast(view.kind==='settings'?'담당자 기본값과 인원 설정을 저장했습니다.':'속성을 추가했습니다.');
  }catch(failure){if(current())error.textContent=failure.status===409?'입력은 보관했습니다. '+failure.message+' 최신 설정을 확인한 뒤 다시 열어 주세요.':failure.message;}
  finally{if(state.databasePropertyView===view){view.busy=false;view.request=null;if(submit.isConnected)submit.disabled=false;}}
}

function openRow(id,initialStatus,draft=null) {
  const currentRow=state.rows.find(r=>r.id===id);
  if(id&&!currentRow)throw new Error('항목이 삭제되었거나 접근 권한이 변경되었습니다. 보관한 입력은 기기에 남아 있습니다.');
  const row=draft?.baselineRow?.id===id?draft.baselineRow:currentRow;
  state.rowEditingBaseline=row?structuredClone(row):null;state.rowEditingDatabase=structuredClone(state.database);if(Array.isArray(draft?.database?.properties))state.rowEditingDatabase.properties=structuredClone(draft.database.properties);
  const vals=row?valuesOf(row):state.database.row_permissions?.mode==='assigned'?{[state.database.row_permissions.property_id]:state.session?.member?.id||''}:{};
  const props=state.rowEditingDatabase.properties;
  const editable=currentRow?resourceLevel(currentRow)>=3:canCreateRow();
  if(!row&&!editable)throw new Error('항목 생성 권한이 없습니다.');
  openModal(row?'프로젝트 상세':'새 프로젝트',`<form id="row-form" data-id="${esc(id||'')}" class="form-grid"><div class="row-properties">${props.map(p=>{const value=vals[p.id]??(p.type==='owner'?p.default==='created_by'?[state.session?.member?.id].filter(Boolean):[]:p.type==='status'?initialStatus:'')??'';let input;if(p.type==='verification')input=`<span class="row-verification-value">${databaseValueHTML(p,value,row)}</span>`;else if(p.type==='owner')input=databaseOwnerInputs(p,value,editable);else if(p.type==='person'){const options=(state.workspace.members||[]).map(m=>({value:m.id,label:m.name||m.email||m.id}));if(value&&!options.some(o=>o.value===value))options.unshift({value,label:String(value)});input=`<select name="${esc(p.id)}"><option value="">미지정</option>${options.map(o=>`<option value="${esc(o.value)}" ${o.value===value?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`;}else if(['status','select'].includes(p.type)){let options=optionsOf(p);if(value&&!options.includes(value))options.unshift(value);input=`<select name="${esc(p.id)}"><option value="">미지정</option>${options.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select>`;}else if(p.type==='date'){const range=dateRange(value);input=`<span class="date-range-inputs"><input name="${esc(p.id)}" type="date" aria-label="${esc(p.name)} 시작일" value="${esc(range?.startISO||'')}"><span>→</span><input name="${esc(p.id)}__end" type="date" aria-label="${esc(p.name)} 종료일" value="${esc(typeof value==='object'&&value&&value.end?range?.endISO||'':'')}"></span>`;}else if(p.type==='checkbox')input=`<input name="${esc(p.id)}" type="checkbox" ${value?'checked':''} style="width:auto;justify-self:start">`;else input=`<input ${['formula','rollup','created_time','last_edited_time'].includes(p.type)?'readonly':''} name="${esc(p.id)}" value="${esc(Array.isArray(value)?value.join(', '):value)}" type="${p.type==='number'?'number':p.type==='date'?'date':p.type==='url'?'url':p.type==='email'?'email':'text'}" ${p.type==='title'?'required':''}>`;return p.type==='owner'?`<div class="row-owner-field"><span>${esc(p.name)}</span>${input}</div>`:`<label>${esc(p.name)}${input}</label>`;}).join('')}</div>${state.database.task_settings?.subitems===true?`<label>상위 항목<select name="parent_row_id"><option value="">최상위 항목</option>${state.rows.filter(candidate=>candidate.id!==id).map(candidate=>`<option value="${esc(candidate.id)}" ${row?.parent_row_id===candidate.id?'selected':''}>${esc(nameOf(candidate))}</option>`).join('')}</select></label>`:''}${state.database.task_settings?.dependencies===true?`<label>선행 항목<select name="depends_on" multiple aria-label="선행 항목" style="min-height:90px">${state.rows.filter(candidate=>candidate.id!==id).map(candidate=>`<option value="${esc(candidate.id)}" ${(row?.depends_on||[]).includes(candidate.id)?'selected':''}>${esc(nameOf(candidate))}</option>`).join('')}</select><small class="muted">선택한 작업이 먼저 끝난 뒤 이 작업이 시작됩니다. 여러 항목은 Ctrl 또는 ⌘ 키로 선택하세요.</small></label>`:''}${row&&props.some(property=>property.type==='verification')?'<section id="row-verification-panel" class="row-verification-panel"><button type="button" class="outline-btn" data-action="row-verification">검증 설정 열기</button><span class="small muted">검증에는 서버 연결이 필요합니다.</span></section>':''}<div class="form-actions">${row&&canCreateRow()?`<button type="button" class="outline-btn" data-action="duplicate-row" data-id="${esc(id)}">하위 항목과 복제</button>`:''}${row?`<button type="button" class="danger-btn" data-action="delete-row" data-id="${esc(id)}" style="margin-right:auto">삭제</button>`:''}<button type="button" class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn">저장하기</button></div></form>`,'database-row-modal');
  state.rowEditingScope=databaseScope();state.rowEditingModal=$('.modal');
  if(row&&props.some(property=>property.type==='owner')&&!state.offline)void openDatabaseVerification({ownerOnly:true});
  if(!editable){
    $$('#row-form input,#row-form select,#row-form textarea').forEach(el=>el.disabled=true);
    $('#row-form .solid-btn')?.remove();$('#row-form .danger-btn')?.remove();
  }

}
function taskGraphChanges(formElement,data,baseline=state.rowEditingBaseline) {
  const existing=baseline?.id===formElement.dataset.id?baseline:null,changes={};
  if(formElement.elements.namedItem('parent_row_id')&&(!existing||(data.parent_row_id||null)!==(existing.parent_row_id||null)))changes.parent_row_id=data.parent_row_id||null;
  if(formElement.elements.namedItem('depends_on')){
    const selected=new FormData(formElement).getAll('depends_on');
    if(!existing||JSON.stringify([...selected].sort())!==JSON.stringify([...(existing.depends_on||[])].sort()))changes.depends_on=selected;
  }
  return changes;
}
async function deleteTaskRow(id) {
  if(state.mutations){await state.mutations.deleteRow(state.database.id,id);if(!state.offline)await syncMutations();}
  else await api('/databases/'+state.database.id+'/rows/'+encodeURIComponent(id),{},'DELETE');
  state.collapsedRows.delete(id);closeModal();await reloadDatabase();toast('항목을 삭제했습니다.');
}
function applyDatabaseControls() {
  if(resourceLevel(state.database)<4)$$('[data-action="new-property"],[data-action="task-settings"],[data-action="owner-settings"]').forEach(el=>el.remove());
  if(!canCreateRow())$$('[data-action="add-row"]').forEach(el=>el.remove());
  $('#database-offline-note')?.remove();
  if(state.offline){const note=document.createElement('p');note.id='database-offline-note';note.className='offline-notice';note.textContent='기기에 보관한 데이터입니다. 변경은 연결 후 동기화됩니다. 수식·롤업과 연쇄 일정은 서버에 연결한 뒤 최종 계산됩니다.';($('.db-full>.panel')||$('#home-database'))?.before(note);}
  pruneAdministrativeControls();renderSyncIndicators();
}
async function renderAccounts(content) {
  if(!isOwner())throw new Error('가족 계정은 소유자만 관리할 수 있습니다.');
  content.innerHTML='<div class="empty">가족 계정을 불러오는 중…</div>';
  const result=await api('/accounts');
  state.accounts=result.accounts||[];
  if(state.settingsTab!=='accounts'||!content.isConnected)return;
  const ready=state.accounts.some(a=>a.role==='owner'&&a.active!==false&&a.has_account);
  content.innerHTML=`<h3>각자의 계정으로, 함께 쓰는 공간</h3><p>가족마다 이메일과 비밀번호로 로그인하고, 페이지를 공유할 사람을 정하세요. 비밀번호는 저장 후 다시 표시하지 않습니다.</p><div class="info-box">${result.required?'멤버별 로그인이 활성화되어 있습니다.':'현재는 '+(state.session?.mode==='family'?'가족 공유 암호':'로컬 워크스페이스')+' 모드입니다. 소유자의 비밀번호를 먼저 설정한 뒤 멤버별 로그인을 활성화하세요.'}</div><div class="settings-list">${state.accounts.map(account=>`<div class="settings-item"><div><strong>${esc(account.name||account.email)}</strong><small>${esc(account.email)} · ${esc(account.role)}${account.active===false?' · 비활성':''}<br>${account.has_account?'이메일 로그인 설정됨':'비밀번호 미설정'}</small></div><div><button data-action="account-password" data-id="${esc(account.id)}" ${account.active===false?'disabled':''}>${account.has_account?'비밀번호 변경':'로그인 설정'}</button>${account.has_account?`<button data-action="account-remove" data-id="${esc(account.id)}">로그인 해제</button>`:''}</div></div>`).join('')}</div><div class="form-actions"><button class="outline-btn" data-action="account-add-member">+ 가족 멤버 추가</button>${!result.required?`<button class="solid-btn" data-action="enable-accounts" ${!ready?'disabled':''}>멤버별 로그인 활성화</button>`:''}</div>${!ready?'<p>활성 소유자 계정에 비밀번호를 설정해야 로그인을 활성화할 수 있습니다.</p>':''}`;
}
function openAccountPassword(id) {
  if(!isOwner())throw new Error('소유자 권한이 필요합니다.');
  const account=state.accounts?.find(account=>account.id===id);
  if(!account)throw new Error('가족 멤버를 찾을 수 없습니다.');
  openModal(account.has_account?'비밀번호 변경':'가족 로그인 설정',`<p><strong>${esc(account.name)}</strong><br>${esc(account.email)}</p><form id="account-password-form" data-id="${esc(id)}" data-existing="${account.has_account?'true':'false'}" class="form-grid"><label>새 비밀번호<input name="password" type="password" minlength="10" maxlength="1024" required autocomplete="new-password" placeholder="10자 이상 입력하세요"></label><label>비밀번호 확인<input name="password_confirm" type="password" minlength="10" maxlength="1024" required autocomplete="new-password"></label><div class="info-box">변경하면 이 계정의 기존 로그인 세션이 종료됩니다. 비밀번호는 안전한 방법으로 해당 가족에게 전달하세요.</div><div class="form-actions"><button type="button" class="outline-btn" data-action="accounts">계정 목록</button><button class="solid-btn">${account.has_account?'비밀번호 변경':'로그인 설정'}</button></div></form>`);
}
const accessChoices=[['','기본 권한 따르기'],['none','접근 불가 · 소유자 제외'],['view','보기'],['comment','댓글 작성'],['edit','편집'],['full','전체 권한 · 공유 관리']];
async function openPermissions(kind,id) {
  if(state.route==='page'){await saveTitle();await savePage();}
  const result=await api('/'+kind+'/'+encodeURIComponent(id)+'/permissions');
  state.sharing={kind,id,result};
  const acl=result.permissions||{default:'workspace',members:{},groups:{},inherit:true};
  const manage=result.can_manage===true;
  const rows=(items,key)=>items.map(item=>`<label class="settings-item"><span><strong>${esc(item.name||item.email||item.id)}</strong><small>${esc(item.email||'')}${item.id===result.owner_id?' · 소유자':''}</small></span><select data-acl-kind="${key}" data-acl-id="${esc(item.id)}" aria-label="${esc(item.name||item.email||item.id)} 공유 권한" ${!manage||item.id===result.owner_id?'disabled':''}>${accessChoices.map(([value,label])=>`<option value="${value}" ${(item.id===result.owner_id?'full':(acl[key]?.[item.id]??''))===value?'selected':''}>${label}</option>`).join('')}</select></label>`).join('');
  const database=kind==='databases'?(state.database?.id===id?state.database:state.workspace.databases.find(d=>d.id===id)):null;
  const policy=result.row_permissions||database?.row_permissions||{mode:'all',allow_create:true,edit_assigned:true};
  const route=(kind==='pages'?'page':'database')+'/'+encodeURIComponent(id);
  const shareURL=typeof FountainTransport.shareURL==='function'?FountainTransport.shareURL(route,state.session?.public_web_origin):FountainTransport.appURL(route);
  openModal(kind==='pages'?'페이지 공유 및 권한':'데이터베이스 공유 및 권한',`<p>링크를 전달해도 아래에서 허용한 사람만 열 수 있습니다. 워크스페이스 소유자는 모든 문서에 접근할 수 있습니다. 그 외 멤버의 명시적 차단은 그룹과 상위 페이지의 허용보다 우선합니다.</p><div style="display:flex;gap:8px;margin-bottom:20px"><input id="share-url" style="flex:1;min-width:0" readonly value="${esc(shareURL||'')}" placeholder="${shareURL?'':'공유 웹 주소를 연결해 주세요.'}"><button class="outline-btn" data-action="copy-link" ${shareURL?'':'disabled'}>${icon('link')}링크 복사</button></div>${!manage?'<div class="info-box">현재 공유 설정을 볼 수 있습니다. 소유자 또는 전체 권한을 가진 사람만 변경할 수 있습니다.</div>':''}<form id="permissions-form" data-kind="${kind}" data-id="${esc(id)}" class="form-grid" style="margin-top:18px"><label>기본 공유 범위<select name="default" ${!manage?'disabled':''}><option value="private" ${acl.default==='private'?'selected':''}>지정·상속된 사람만 · 비공개</option><option value="workspace" ${acl.default==='workspace'?'selected':''}>워크스페이스 멤버 · 편집 (게스트 제외)</option></select></label><label style="display:flex;align-items:center"><input name="inherit" type="checkbox" style="width:auto" ${acl.inherit!==false?'checked':''} ${!manage?'disabled':''}>${kind==='pages'?'상위 페이지와 팀스페이스 권한 상속':'팀스페이스 권한 상속'}</label><div><strong class="small">가족 멤버</strong><div class="settings-list">${rows(result.members||[],'members')}</div></div>${result.groups?.length?`<div><strong class="small">그룹</strong><div class="settings-list">${rows(result.groups,'groups')}</div></div>`:''}${database?`<div style="border-top:1px solid var(--line);padding-top:15px"><strong class="small">항목별 접근</strong><label style="margin-top:12px">보여줄 항목<select name="row_mode" ${!manage?'disabled':''}><option value="all" ${policy.mode!=='assigned'?'selected':''}>접근 가능한 모든 항목</option><option value="assigned" ${policy.mode==='assigned'?'selected':''}>내가 담당자인 항목만</option></select></label><label style="margin-top:12px">담당자 속성<select name="property_id" ${!manage?'disabled':''}><option value="">선택하세요</option>${(database.properties||[]).filter(p=>p.type==='person').map(p=>`<option value="${esc(p.id)}" ${policy.property_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label style="display:flex;align-items:center;margin-top:12px"><input type="checkbox" name="edit_assigned" style="width:auto" ${policy.edit_assigned!==false?'checked':''} ${!manage?'disabled':''}>담당 항목 편집 허용</label><label style="display:flex;align-items:center;margin-top:12px"><input type="checkbox" name="allow_create" style="width:auto" ${policy.allow_create!==false?'checked':''} ${!manage?'disabled':''}>새 항목 생성 허용</label></div>`:''}${manage?'<div class="form-actions"><button class="solid-btn">공유 설정 저장</button></div>':''}</form>`);
}

let settingsOpenSequence=0;
function verifiedPagesIdentity(){return {binding:state.session?.cache_binding,member:state.session?.member?.id,role:state.session?.member?.role,profile:state.offlineProfile?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,epoch:FountainTransport.scopeEpoch,origin:FountainTransport.origin};}
function verifiedPagesIdentityCurrent(scope){return !!scope&&state.loaded&&state.session?.member?.active!==false&&!state.offline&&!state.authSuspending&&!state.nativeOutboxPause&&!state.nativeRecoveryPaused&&Object.entries(scope).every(([key,value])=>verifiedPagesIdentity()[key]===value);}
function clearVerifiedPages(){const view=state.verifiedPages;state.verifiedPages=null;if(!view)return;view.closed=true;view.sequence++;clearTimeout(view.timer);view.request?.abort();view.items=[];view.filters={owners:[],teamspaces:[]};if(view.content?.isConnected)view.content.replaceChildren();}
function verifiedPagesCurrent(view){return !!view&&!view.closed&&state.verifiedPages===view&&verifiedPagesIdentityCurrent(view.scope)&&state.settingsTab==='verified'&&view.modal?.isConnected&&$('.settings-modal')===view.modal&&$('#settings-content')===view.content&&view.content.isConnected&&view.form.isConnected&&$('#verified-pages-filters',view.content)===view.form&&state.nativeNavigation===view.navigation;}
function verifiedPagesId(value){return typeof value==='string'&&value.length>0&&Array.from(value).length<=200&&!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);}
function verifiedPagesPerson(value){return !!value&&verifiedPagesId(value.id)&&typeof value.name==='string';}
function validVerifiedPagesItem(item){return !!item&&verifiedPagesId(item.id)&&['page','row'].includes(item.resource_type)&&typeof item.title==='string'&&(item.icon==null||typeof item.icon==='string')&&Array.isArray(item.owners)&&item.owners.every(verifiedPagesPerson)&&(item.teamspace===null||verifiedPagesPerson(item.teamspace))&&item.verification&&['verified','expired'].includes(item.verification.status)&&verificationTimestamp(item.verification.verified_at)&&(item.verification.expires_at===null||verificationTimestamp(item.verification.expires_at))&&(item.resource_type==='page'?item.page_id===item.id:verifiedPagesId(item.database_id)&&item.row_id===item.id);}
function verifiedPagesOptions(select,options,label){const value=select.value;select.innerHTML=`<option value="">${label}</option>${value&&!options.some(option=>option.id===value)?`<option value="${esc(value)}">선택한 필터 · 정보 비공개</option>`:''}${options.map(option=>`<option value="${esc(option.id)}">${esc(option.name||'이름 없음')}</option>`).join('')}`;select.value=value;}
function renderVerifiedPages(view){
  if(!verifiedPagesCurrent(view))return;const disabled=view.loading||view.opening;
  const status=$('#verified-pages-status',view.content),error=$('#verified-pages-error',view.content),results=$('#verified-pages-results',view.content),footer=$('#verified-pages-count',view.content);
  status.textContent=view.opening?'최신 문서와 접근 권한을 확인하고 있습니다…':view.loading?'검증 문서를 불러오고 있습니다…':view.error?'목록을 불러오지 못했습니다.':`${view.total??0}개의 검증 문서와 항목`;
  error.textContent=view.error||'';results.innerHTML=view.loading?'<div class="empty" role="status">목록을 확인하고 있습니다…</div>':view.items.length?`<div class="verified-pages-scroll"><table class="verified-pages-table"><thead><tr><th>문서</th><th>담당자</th><th>팀스페이스</th><th>검증 상태</th><th>만료</th><th>열기</th></tr></thead><tbody>${view.items.map((item,index)=>`<tr><td data-label="문서"><strong>${esc(item.icon|| (item.resource_type==='row'?'▤':'📄'))} ${esc(item.title||'제목 없음')}</strong><small>${item.resource_type==='row'?'데이터베이스 항목':'페이지'}</small></td><td data-label="담당자">${item.owners.length?item.owners.map(owner=>esc(owner.name||'이름 없는 담당자')).join(', '):'담당자 정보 비공개'}</td><td data-label="팀스페이스">${esc(item.teamspace?.name||'위치 정보 비공개')}</td><td data-label="검증 상태"><span class="verification-badge ${item.verification.status==='verified'?'verified':''}">${item.verification.status==='verified'?'✓ 검증됨':'검증 만료'}</span><small>확인 ${esc(verificationDate(item.verification.verified_at))}</small></td><td data-label="만료">${item.verification.expires_at?esc(verificationDate(item.verification.expires_at)):'만료 없음'}</td><td data-label="열기"><div class="verified-pages-actions"><button type="button" class="outline-btn" data-action="verified-open" data-index="${index}" ${disabled?'disabled':''}>열기</button><button type="button" class="outline-btn" data-action="verified-edit" data-index="${index}" ${disabled?'disabled':''}>검증 보기</button></div></td></tr>`).join('')}</tbody></table></div>`:view.error?'':'<div class="empty">현재 조건에 맞는 검증 문서가 없습니다.</div>';
  footer.textContent=view.total===null?'':view.items.length?`${view.offset+1}–${view.offset+view.items.length} / ${view.total}개`:`0 / ${view.total}개`;
  $('[data-action="verified-previous"]',view.content).disabled=disabled||view.offset===0;$('[data-action="verified-next"]',view.content).disabled=disabled||!view.hasMore;
  $('[data-action="verified-retry"]',view.content).hidden=!view.error;$('[data-action="verified-refresh"]',view.content).disabled=!!view.opening;
  for(const control of view.form.elements)control.disabled=!!view.opening;
}
function verifiedPagesParameters(view){const fields=new FormData(view.form),q=String(fields.get('q')||'');if(Array.from(q).length>200||/[\u0000\uD800-\uDFFF]/u.test(q))throw Error('검색어는 올바른 문자로 200자 이내로 입력해 주세요.');const params=new URLSearchParams({q,status:fields.get('status')||'all',kind:fields.get('kind')||'all',limit:'50',offset:String(view.offset)});for(const key of ['owner','teamspace']){const value=fields.get(key);if(value)params.set(key,value);}return params;}
async function loadVerifiedPages(view){
  if(!verifiedPagesCurrent(view)||view.opening)return;const sequence=++view.sequence;view.request?.abort();clearTimeout(view.timer);view.request=new AbortController();view.loading=true;view.error=null;view.items=[];view.total=null;view.hasMore=false;renderVerifiedPages(view);
  const current=()=>verifiedPagesCurrent(view)&&view.sequence===sequence;
  try{
    const parameters=verifiedPagesParameters(view),offset=view.offset;
    if(!current())return;const result=await api('/verified-pages?'+parameters,undefined,'GET',{signal:view.request.signal,current});if(!current())return;
    if(!Array.isArray(result.items)||result.items.length>50||!result.items.every(validVerifiedPagesItem)||!Number.isSafeInteger(result.total)||result.total<0||typeof result.has_more!=='boolean'||result.limit!==50||result.offset!==offset||!Array.isArray(result.filters?.owners)||!result.filters.owners.every(verifiedPagesPerson)||!Array.isArray(result.filters?.teamspaces)||!result.filters.teamspaces.every(verifiedPagesPerson)||new Set(result.items.map(item=>item.resource_type+':'+item.id)).size!==result.items.length)throw Error('검증 목록 응답을 확인하지 못했습니다. 다시 시도해 주세요.');
    view.items=result.items.map(item=>({id:item.id,resource_type:item.resource_type,title:item.title,icon:item.icon,owners:item.owners.map(owner=>({id:owner.id,name:owner.name})),teamspace:item.teamspace?{id:item.teamspace.id,name:item.teamspace.name}:null,verification:{status:item.verification.status,verified_at:item.verification.verified_at,expires_at:item.verification.expires_at},...(item.resource_type==='page'?{page_id:item.page_id}:{database_id:item.database_id,row_id:item.row_id})}));
    view.total=result.total;view.hasMore=result.has_more;view.filters=result.filters;
    verifiedPagesOptions(view.form.elements.owner,result.filters.owners,'모든 담당자');verifiedPagesOptions(view.form.elements.teamspace,result.filters.teamspaces,'모든 팀스페이스');
  }catch(error){if(!current()||error.name==='AbortError'||error.code==='STALE_REQUEST')return;view.items=[];view.total=null;view.hasMore=false;view.filters={owners:[],teamspaces:[]};verifiedPagesOptions(view.form.elements.owner,[],'모든 담당자');verifiedPagesOptions(view.form.elements.teamspace,[],'모든 팀스페이스');view.error=[403,404].includes(error.status)?'현재 목록에 접근할 수 없습니다. 권한을 확인한 뒤 다시 열어 주세요.':error.status===409?'목록이 변경되었습니다. 새로고침해 주세요.':error.message;}
  finally{if(current()){view.loading=false;view.request=null;renderVerifiedPages(view);}}
}
function changeVerifiedPages(view,debounce=false){
  if(!verifiedPagesCurrent(view)||view.opening)return;view.sequence++;view.request?.abort();clearTimeout(view.timer);view.offset=0;view.items=[];view.total=null;view.hasMore=false;view.error=null;view.loading=true;renderVerifiedPages(view);
  if(debounce)view.timer=setTimeout(()=>{if(verifiedPagesCurrent(view))void loadVerifiedPages(view);},150);else void loadVerifiedPages(view);
}
async function mountVerifiedPages(content){
  if(!content||state.offline||!state.loaded||!state.session?.member||state.session.member.active===false)throw Error('현재 계정으로 서버에 연결한 뒤 검증 문서를 확인해 주세요.');
  content.innerHTML='<section class="verified-pages-directory"><h3>검증된 페이지</h3><p>현재 접근할 수 있는 검증 문서와 데이터베이스 항목입니다. 검증 변경은 문서를 연 뒤 현재 권한으로 진행합니다.</p><form id="verified-pages-filters" class="verified-pages-filters"><label class="verified-pages-query">문서 제목 검색<input name="q" maxlength="400" placeholder="검증 문서의 제목 검색"></label><label>담당자<select name="owner"><option value="">모든 담당자</option></select></label><label>팀스페이스<select name="teamspace"><option value="">모든 팀스페이스</option></select></label><label>검증 상태<select name="status"><option value="all">전체 검증 상태</option><option value="verified">검증됨</option><option value="expired">검증 만료</option></select></label><label>문서 종류<select name="kind"><option value="all">페이지와 항목</option><option value="page">페이지</option><option value="row">데이터베이스 항목</option></select></label><div class="verified-pages-filter-actions"><button class="solid-btn" type="submit">검색</button><button class="outline-btn" type="button" data-action="verified-clear">초기화</button><button class="outline-btn" type="button" data-action="verified-refresh">새로고침</button></div></form><div id="verified-pages-status" role="status" aria-live="polite"></div><div id="verified-pages-error" role="alert"></div><div id="verified-pages-results"></div><div class="verified-pages-footer"><span id="verified-pages-count"></span><div><button type="button" class="outline-btn" data-action="verified-previous">이전</button><button type="button" class="outline-btn" data-action="verified-next">다음</button><button type="button" class="outline-btn" data-action="verified-retry" hidden>다시 시도</button></div></div></section>';
  const view={scope:verifiedPagesIdentity(),navigation:state.nativeNavigation,modal:content.closest('.modal'),content,form:$('#verified-pages-filters',content),sequence:0,offset:0,items:[],filters:{owners:[],teamspaces:[]},total:null,hasMore:false,loading:false,opening:false,closed:false};state.verifiedPages=view;
  view.form.onsubmit=event=>{event.preventDefault();changeVerifiedPages(view);};view.form.onchange=event=>{if(event.target!==view.form.elements.q)changeVerifiedPages(view);};view.form.elements.q.oninput=()=>changeVerifiedPages(view,true);
  await loadVerifiedPages(view);
}
async function openVerifiedPages(){
  if(!state.loaded||state.offline||state.nativeOutboxPause||state.nativeRecoveryPaused||state.authSuspending||!state.session?.member||state.session.member.active===false)throw Error('현재 계정으로 서버에 연결한 뒤 확인해 주세요.');
  state.settingsTab='verified';openModal('워크스페이스 설정','<div class="settings-layout"><nav class="settings-tabs" id="settings-tabs"></nav><div class="settings-content" id="settings-content"></div></div>','settings-modal verified-settings-modal');$('.modal-body').style.padding='0';await renderSettings();
}
async function openVerifiedPagesItem(index,edit=false){
  const view=state.verifiedPages,item=view?.items[index];if(!verifiedPagesCurrent(view)||view.loading||view.opening||!item)return;
  const scope={...view.scope},ticket=searchNavigation;view.opening=true;view.request?.abort();renderVerifiedPages(view);
  const navigationPromise=navigate(item.resource_type==='page'?'page':'database',item.resource_type==='page'?item.page_id:item.database_id),navigation=state.nativeNavigation;view.navigation=navigation;
  const opened=await navigationPromise;
  if(opened!==true){if(state.verifiedPages===view&&verifiedPagesIdentityCurrent(scope)&&view.modal.isConnected&&searchNavigation===ticket&&state.nativeNavigation===null){view.navigation=null;}if(verifiedPagesCurrent(view)){view.opening=false;view.error='문서를 열지 못했습니다. 작성 중인 입력과 현재 화면을 확인해 주세요.';renderVerifiedPages(view);}return;}
  const current=()=>verifiedPagesIdentityCurrent(scope)&&state.nativeNavigation===null&&searchNavigation===ticket+1&&!$('.modal');if(!current())return;
  if(item.resource_type==='row'){
    if(state.route!=='database'||state.database?.id!==item.database_id)return;if(!state.rows.some(row=>row.id===item.row_id&&resourceLevel(row)>=1)){toast('항목이 삭제되었거나 더 이상 접근할 수 없습니다.');return;}openRow(item.row_id);if(edit)await openDatabaseVerification();return;
  }
  if(state.route!=='page'||state.page?.id!==item.page_id||!edit)return;await syncWikiPage();if(!current()||state.page?.id!==item.page_id)return;
  if(pageEditable()&&wikiVerificationAllowed())await verificationModal();else toast('현재 권한으로 문서의 검증 상태를 확인할 수 있습니다.');
}

// Delegated administration stays online and outside document/offline caches.
let adminSettingsRequest=null;

const adminActionLabels={'audit.read':'감사 로그 보기','analytics.read':'워크스페이스 분석 보기','members.read':'멤버 목록 보기','members.manage':'일반 멤버 관리','groups.read':'그룹 목록 보기','groups.membership.manage':'기존 그룹의 멤버 관리','content.search.read':'전체 콘텐츠 검색','content.search.export':'콘텐츠 검색 CSV 내보내기','content.permissions.manage':'콘텐츠 공유 권한 관리','content.publish.manage':'콘텐츠 게시 중단','content.restore.manage':'휴지통 페이지 복원'};

function clearAdminConsole(){adminSettingsRequest?.abort();
  adminSettingsRequest=null;
  const view=state.adminConsole;
  state.adminConsole=null;
  if(!view)return;
  disposeAdminContent(view);
  view.closed=true;
  view.sequence++;
  view.request?.abort();
  view.watch?.abort();
  clearTimeout(view.timer);
  view.data=null;
  view.overview=null;
  view.editor=null;
  view.capabilities=null;
  if(view.content?.isConnected)view.content.replaceChildren();
  }
function adminConsoleCurrent(view){return !!view&&!view.closed&&state.adminConsole===view&&verifiedPagesIdentityCurrent(view.scope)&&view.content?.isConnected&&view.modal?.isConnected&&$('.modal')===view.modal&&state.nativeNavigation===view.navigation;
  }
function adminPermissions(value){if(!value||!Array.isArray(value.actions)||!value.actions.every(action=>Object.hasOwn(adminActionLabels,action))||typeof value.can_manage_roles!=='boolean')throw Error('관리 권한 응답을 확인할 수 없습니다.');
  return {actions:[...new Set(value.actions)].sort(),can_manage_roles:value.can_manage_roles};
  }
function adminCan(view,action){return !!view.capabilities?.actions.includes(action);
  }
function adminTabs(view){return [['roles','관리 역할',view.capabilities?.can_manage_roles],['content','전체 콘텐츠',adminCan(view,'content.search.read')],['audit','감사 로그',adminCan(view,'audit.read')],['analytics','분석',adminCan(view,'analytics.read')],['members','멤버',adminCan(view,'members.read')],['groups','그룹 멤버',adminCan(view,'groups.read')]].filter(([, ,allowed])=>allowed);
  }
async function adminCheck(view,signal){const check=view.permissionSequence=(view.permissionSequence||0)+1,current=()=>adminConsoleCurrent(view)&&check===view.permissionSequence;
  let permissions;
  try{permissions=adminPermissions(await api('/admin/self',undefined,'GET',{signal,current}));}
  catch(error){if(!current()){const stale=new Error('지난 관리 권한 확인 요청입니다.');stale.code='STALE_REQUEST';throw stale;}
  disposeAdminContent(view);
  view.data=null;view.overview=null;view.editor=null;view.capabilities=null;view.notice=null;
  throw error;}
  if(!current())return false;
  const changed=view.capabilities&&JSON.stringify(view.capabilities)!==JSON.stringify(permissions);
  view.capabilities=permissions;
  if(changed){disposeAdminContent(view);
  view.request?.abort();
  view.request=null;
  view.sequence++;
  view.data=null;
  view.overview=null;
  view.editor=null;
  view.error='관리 권한이 변경되었습니다. 현재 권한으로 새로고침해 주세요.';
  view.busy=false;
  if(!adminTabs(view).some(([id])=>id===view.tab))view.tab=adminTabs(view)[0]?.[0]||null;
  renderAdminConsole(view);
  }return !changed;
  }
function watchAdminConsole(view){clearTimeout(view.timer);
  if(!adminConsoleCurrent(view))return;
  view.timer=setTimeout(async()=>{if(!adminConsoleCurrent(view))return;
  if(view.busy){watchAdminConsole(view);return;}
  view.watch=new AbortController();
  try{await adminCheck(view,view.watch.signal);
  }catch(error){if(adminConsoleCurrent(view)&&error.name!=='AbortError'&&error.code!=='STALE_REQUEST'){view.request?.abort();
  view.request=null;
  view.sequence++;
  view.data=null;
  view.overview=null;
  view.editor=null;
  view.capabilities=null;
  disposeAdminContent(view);
  view.notice=null;
  view.busy=false;
  view.error=error.message;
  renderAdminConsole(view);
  }}finally{view.watch=null;
  watchAdminConsole(view);
  }},5000);
  }
function adminRoleOverview(value){if(!value||!/^[a-f0-9]{64}$/.test(value.revision)||!['catalog','roles','assignments','eligible_members'].every(key=>Array.isArray(value[key]))||!value.roles.every(role=>typeof role.id==='string'&&typeof role.name==='string'&&Array.isArray(role.actions)&&role.actions.every(action=>Object.hasOwn(adminActionLabels,action)))||!value.assignments.every(item=>typeof item.member_id==='string'&&Array.isArray(item.role_ids)))throw Error('관리 역할 목록 응답을 확인할 수 없습니다.');
  return value;
  }
async function loadAdminConsole(view=state.adminConsole){if(!adminConsoleCurrent(view)||view.busy)return;
  view.request?.abort();
  const request=new AbortController();
  view.request=request;
  const sequence=++view.sequence,current=()=>adminConsoleCurrent(view)&&sequence===view.sequence;
  view.busy=true;
  view.error=null;
  view.data=null;
  view.overview=null;
  view.editor=null;
  renderAdminConsole(view);
  try{if(!await adminCheck(view,request.signal)||!current())return;
  if(!view.tab)view.tab=adminTabs(view)[0]?.[0]||null;
  if(!adminTabs(view).some(([id])=>id===view.tab)){view.error='현재 계정에 위임된 관리 권한이 없습니다.';
  return;
  }if(view.tab==='content'){await fetchAdminContent(view,request,sequence);return;}
  const path={roles:'/admin/roles',audit:'/audit',analytics:'/analytics',members:'/members',groups:'/groups'}[view.tab];
  const data=await api(path,undefined,'GET',{signal:request.signal,current});
  if(!current()||!await adminCheck(view,request.signal)||!current())return;
  if(view.tab==='roles')view.overview=adminRoleOverview(data);
  else if(view.tab==='groups'&&adminCan(view,'groups.membership.manage')&&adminCan(view,'members.read')){const people=await api('/members',undefined,'GET',{signal:request.signal,current});
  if(!current()||!await adminCheck(view,request.signal)||!current())return;
  view.data={...data,members:normalizeList(people.members)};
  }else view.data=data;
  }catch(error){if(current()&&error.name!=='AbortError'){if(view.tab==='content')adminContentError(view,adminContentState(view),error);view.data=null;
  view.overview=null;
  view.error=view.tab==='content'&&error.status===409?'콘텐츠나 공유 상태가 변경되었습니다. 새로고침한 뒤 다시 확인해 주세요.':error.message;
  }}finally{if(current()){view.busy=false;
  view.request=null;
  renderAdminConsole(view);
  watchAdminConsole(view);
  }}}
async function adminWrite(view,path,body,method){if(!adminConsoleCurrent(view)||view.busy)return;
  const request=new AbortController();
  view.request=request;
  const sequence=++view.sequence,current=()=>adminConsoleCurrent(view)&&sequence===view.sequence;
  view.busy=true;
  view.error=null;
  view.notice=null;
  renderAdminConsole(view);
  try{if(!await adminCheck(view,request.signal)||!current())return;
  const result=await api(path,body,method,{signal:request.signal,current});
  if(!current()||!await adminCheck(view,request.signal)||!current())return;
  if(view.tab==='roles'){view.overview=adminRoleOverview(result);
  view.editor=null;
  view.notice='관리 역할을 저장했습니다.';
  }else{view.data=null;
  view.notice='변경을 저장했습니다.';
  }view.busy=false;
  view.request=null;
  if(view.tab!=='roles'){await loadAdminConsole(view);
  return;
  }}catch(error){if(current()&&error.name!=='AbortError'){view.error=error.message;
  if(error.status===409){view.overview=null;
  view.editor=null;
  view.error='다른 관리 변경이 먼저 저장되었습니다. 새로고침한 뒤 다시 편집해 주세요.';
  }if([401,403].includes(error.status)){view.overview=null;
  view.data=null;
  view.editor=null;
  view.capabilities=null;
  }}}finally{if(current()){view.busy=false;
  view.request=null;
  renderAdminConsole(view);
  watchAdminConsole(view);
  }}}
function renderAdminConsole(view){if(!adminConsoleCurrent(view))return;
  const focused=view.tab==='content'&&view.content.contains(document.activeElement)?{name:document.activeElement.name,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
  const tabs=adminTabs(view),busy=view.busy?'disabled':'',overview=view.overview;
  view.content.innerHTML=`<section class="admin-console"><h3>${view.roleTab?'관리 역할':'위임된 관리 설정'}</h3><p>관리 작업은 서버에 연결된 상태에서만 가능합니다. 관리 역할을 맡아도 일반 문서의 공유 권한은 그대로 적용됩니다.</p><nav class="admin-console-tabs" aria-label="위임된 관리 영역">${(view.roleTab?tabs.filter(([id])=>id==='roles'):tabs).map(([id,label])=>`<button type="button" class="outline-btn" data-admin-tab="${id}" aria-pressed="${view.tab===id}" ${busy}>${label}</button>`).join('')}</nav><button type="button" class="outline-btn" data-admin-refresh ${busy}>현재 권한과 목록 새로고침</button>${view.busy?'<p role="status">서버에서 확인하고 있습니다…</p>':''}${view.notice?`<p role="status">${esc(view.notice)}</p>`:''}${view.error?`<p role="alert">${esc(view.error)}</p>`:''}<div id="admin-console-body"></div></section>`;
  const body=$('#admin-console-body',view.content);
  if(view.tab==='content'&&adminCan(view,'content.search.read'))renderAdminContent(view,body);
  else if(view.tab==='roles'&&overview){body.innerHTML=`<div class="info-box">역할은 일반 멤버와 멤버 관리자에게 개별적으로 여러 개 지정할 수 있습니다. 읽기와 관리는 각각 명시적으로 선택합니다. 역할 삭제 시 해당 역할의 지정도 해제됩니다.</div><button type="button" class="outline-btn" data-admin-new ${busy}>관리 역할 만들기</button><div class="settings-list">${overview.roles.map(role=>`<article class="settings-item"><div><strong>${esc(role.name)}</strong><small>${esc(role.description||'')}<br>${role.actions.map(action=>esc(adminActionLabels[action])).join(' · ')}</small></div><div><button type="button" data-admin-edit="${esc(role.id)}" ${busy}>편집</button><button type="button" data-admin-delete="${esc(role.id)}" ${busy}>${view.deleteId===role.id?'역할 삭제 확인':'삭제'}</button></div></article>`).join('')||'<p>만든 관리 역할이 없습니다.</p>'}</div><div id="admin-role-editor"></div><h4>멤버별 역할 지정</h4><div class="settings-list">${overview.eligible_members.map(member=>{const assigned=overview.assignments.find(item=>item.member_id===member.id)?.role_ids||[];
  return `<form class="admin-assignment-form form-grid" data-member-id="${esc(member.id)}"><fieldset ${busy}><legend>${esc(member.name||member.email||member.id)}</legend><small>${esc(member.email||'')} · ${esc(member.role)}</small>${overview.roles.map(role=>`<label class="checkbox-label"><input type="checkbox" name="role_ids" value="${esc(role.id)}" ${assigned.includes(role.id)?'checked':''}>${esc(role.name)}</label>`).join('')}<button class="solid-btn" ${busy}>역할 지정 저장</button><button type="button" class="outline-btn" data-admin-revoke="${esc(member.id)}" ${busy}>모든 관리 역할 해제</button></fieldset></form>`;
  }).join('')||'<p>역할을 지정할 수 있는 멤버가 없습니다.</p>'}</div>`;
  if(view.editor){const role=view.editor;
  $('#admin-role-editor',body).innerHTML=`<form id="admin-role-form" class="form-grid"><fieldset ${busy}><legend>${role.id?'관리 역할 편집':'새 관리 역할'}</legend><label>역할 이름<input name="name" maxlength="100" required value="${esc(role.name||'')}"></label><label>설명<textarea name="description" maxlength="1000">${esc(role.description||'')}</textarea></label><p>관리 권한에는 해당 목록 읽기 권한도 필요합니다. 아래에서 두 권한을 함께 선택해 주세요.</p>${Object.entries(adminActionLabels).map(([id,label])=>`<label class="checkbox-label"><input type="checkbox" name="actions" value="${id}" ${role.actions.includes(id)?'checked':''}>${label}</label>`).join('')}<p data-admin-pair-error role="alert"></p><button class="solid-btn" ${busy}>역할 저장</button><button type="button" class="outline-btn" data-admin-cancel ${busy}>편집 취소</button></fieldset></form>`;
  }}
else if(view.data&&view.tab==='members'){const members=normalizeList(view.data.members);
  body.innerHTML=`<h4>멤버 목록</h4>${adminCan(view,'members.manage')?'<form id="admin-member-new" class="form-grid"><label>이름<input name="name" maxlength="200" required></label><label>이메일<input name="email" type="email" required></label><p>새 멤버는 일반 멤버로 추가됩니다. 로그인 연결은 소유자가 관리합니다.</p><button class="solid-btn">일반 멤버 추가</button></form>':''}<div class="settings-list">${members.map(member=>`<article class="settings-item"><div><strong>${esc(member.name)}</strong><small>${esc(member.email||'')} · ${esc(member.role)} · ${member.active===false?'비활성':'활성'}</small></div>${adminCan(view,'members.manage')&&!['owner','admin'].includes(member.role)?`<button type="button" data-admin-member="${esc(member.id)}" ${busy}>멤버 관리</button>`:''}</article>`).join('')}</div><div id="admin-member-editor"></div>`;
  if(view.editor){const member=view.editor;
  $('#admin-member-editor',body).innerHTML=`<form id="admin-member-form" class="form-grid"><fieldset ${busy}><legend>일반 멤버 관리</legend><label>이름<input name="name" required value="${esc(member.name)}"></label><label>이메일<input name="email" type="email" value="${esc(member.email||'')}"></label><label>역할<select name="role"><option value="member" ${member.role==='member'?'selected':''}>일반 멤버</option><option value="guest" ${member.role==='guest'?'selected':''}>게스트</option></select></label><label class="checkbox-label"><input type="checkbox" name="active" ${member.active!==false?'checked':''}>활성 멤버</label><button class="solid-btn">멤버 저장</button><button type="button" class="outline-btn" data-admin-member-delete="${esc(member.id)}">${view.deleteId===member.id?'멤버 삭제 확인':'멤버 삭제'}</button></fieldset></form>`;
  }}
else if(view.data&&view.tab==='groups'){body.innerHTML=`<h4>기존 그룹</h4><p>이 화면에서는 기존 그룹의 멤버만 변경할 수 있습니다.</p><div class="settings-list">${normalizeList(view.data.groups).map(group=>`<article class="settings-item"><div><strong>${esc(group.name)}</strong><small>멤버 ${normalizeList(group.members).length}명</small></div>${adminCan(view,'groups.membership.manage')?`<button type="button" data-admin-group="${esc(group.id)}" ${busy}>그룹 멤버 편집</button>`:`<small>${normalizeList(group.members).map(id=>esc(id)).join(', ')}</small>`}</article>`).join('')}</div><div id="admin-group-editor"></div>`;
  if(view.editor){const group=view.editor;
  $('#admin-group-editor',body).innerHTML=`<form id="admin-group-form" class="form-grid"><fieldset ${busy}><legend>${esc(group.name)}의 멤버</legend>${adminCan(view,'members.read')?normalizeList(view.data.members).map(member=>`<label class="checkbox-label"><input type="checkbox" name="members" value="${esc(member.id)}" ${normalizeList(group.members).includes(member.id)?'checked':''}>${esc(member.name||member.email||member.id)} · ${esc(member.role)}</label>`).join(''):`<label>멤버 ID · 한 줄에 하나<textarea name="member_ids" spellcheck="false">${esc(normalizeList(group.members).join('\n'))}</textarea></label><p>멤버 목록 읽기 권한이 없어 이름은 표시하지 않습니다. 기존 멤버 ID만 입력할 수 있습니다.</p>`}<button class="solid-btn">그룹 멤버 저장</button></fieldset></form>`;
  }}
else if(view.data&&view.tab==='audit'){body.innerHTML=`<h4>감사 로그</h4><div class="settings-list">${normalizeList(view.data.events).map(event=>`<article class="settings-item"><div><strong>${esc(event.action||event.type||'활동')}</strong><small>${esc(event.created_at||'')} · ${esc(event.actor_name||event.actor_id||'')}</small><pre>${esc(JSON.stringify(event,null,2))}</pre></div></article>`).join('')||'<p>감사 기록이 없습니다.</p>'}</div>`;
  }
else if(view.data&&view.tab==='analytics'){body.innerHTML=`<h4>워크스페이스 분석</h4><pre>${esc(JSON.stringify(view.data,null,2))}</pre>`;
  }
for(const control of $$('button,input,select,textarea',view.content))if(view.busy&&!(view.tab==='content'&&control.closest('#admin-content-query')&&control.matches('input,select')))control.disabled=true;
  if(focused?.name){const input=$('#admin-content-query',view.content)?.elements[focused.name];if(input&&!input.disabled){input.focus({preventScroll:true});if(input.setSelectionRange&&typeof focused.start==='number')try{input.setSelectionRange(focused.start,focused.end);}catch{}}}
  view.content.onclick=event=>{const target=event.target.closest('button');
  if(!target)return;
  event.stopPropagation();
  const run=async()=>{if(!adminConsoleCurrent(view)||view.busy)return;
  if(target.hasAttribute('data-admin-refresh'))return loadAdminConsole(view);
  if(target.dataset.adminTab){disposeAdminContent(view);view.tab=target.dataset.adminTab;
  view.notice=null;
  view.deleteId=null;
  return loadAdminConsole(view);
  }if(target.hasAttribute('data-admin-new')){view.editor={name:'',description:'',actions:[]};
  view.deleteId=null;
  }else if(target.dataset.adminEdit)view.editor=structuredClone(view.overview.roles.find(role=>role.id===target.dataset.adminEdit));
  else if(target.hasAttribute('data-admin-cancel'))view.editor=null;
  else if(target.dataset.adminDelete){const id=target.dataset.adminDelete;
  if(view.deleteId!==id){view.deleteId=id;
  renderAdminConsole(view);
  return;
  }return adminWrite(view,'/admin/roles/'+encodeURIComponent(id),{revision:view.overview.revision},'DELETE');
  }else if(target.dataset.adminRevoke)return adminWrite(view,'/admin/assignments/'+encodeURIComponent(target.dataset.adminRevoke),{role_ids:[],revision:view.overview.revision},'PUT');
  else if(target.dataset.adminMember)view.editor=structuredClone(view.data.members.find(member=>member.id===target.dataset.adminMember));
  else if(target.dataset.adminMemberDelete){const id=target.dataset.adminMemberDelete;
  if(view.deleteId!==id){view.deleteId=id;
  renderAdminConsole(view);
  return;
  }return adminWrite(view,'/members/'+encodeURIComponent(id),{},'DELETE');
  }else if(target.dataset.adminGroup)view.editor=structuredClone(view.data.groups.find(group=>group.id===target.dataset.adminGroup));
  else return;
  renderAdminConsole(view);
  };
  run().catch(error=>{if(adminConsoleCurrent(view)){view.error=error.message;
  renderAdminConsole(view);
  }});
  };
  view.content.onsubmit=event=>{event.preventDefault();
  event.stopPropagation();
  if(!adminConsoleCurrent(view)||view.busy)return;
  const form=event.target,data=new FormData(form);
  let path,payload,method='POST';
  if(form.id==='admin-role-form'){const actions=data.getAll('actions');
  for(const [manage,read] of [['members.manage','members.read'],['groups.membership.manage','groups.read'],['content.search.export','content.search.read'],['content.permissions.manage','content.search.read'],['content.publish.manage','content.search.read'],['content.restore.manage','content.search.read']])if(actions.includes(manage)&&!actions.includes(read)){$('[data-admin-pair-error]',form).textContent='관리 권한과 필요한 목록 읽기를 함께 선택해 주세요.';
  return;
  }path='/admin/roles'+(view.editor.id?'/'+encodeURIComponent(view.editor.id):'');
  method=view.editor.id?'PATCH':'POST';
  payload={name:data.get('name'),description:data.get('description'),actions,revision:view.overview.revision};
  }else if(form.classList.contains('admin-assignment-form')){path='/admin/assignments/'+encodeURIComponent(form.dataset.memberId);
  method='PUT';
  payload={role_ids:data.getAll('role_ids'),revision:view.overview.revision};
  }else if(form.id==='admin-member-new'){path='/members';
  payload={name:data.get('name'),email:data.get('email'),role:'member'};
  }else if(form.id==='admin-member-form'){path='/members/'+encodeURIComponent(view.editor.id);
  method='PATCH';
  payload={name:data.get('name'),email:data.get('email'),role:data.get('role'),active:data.has('active')};
  }else if(form.id==='admin-group-form'){path='/groups/'+encodeURIComponent(view.editor.id);
  method='PATCH';
  payload={members:data.has('member_ids')?String(data.get('member_ids')).split(/\r?\n/).map(id=>id.trim()).filter(Boolean):data.getAll('members')};
  }else return;
  void adminWrite(view,path,payload,method);
  };
  }
// Administrator content metadata is memory-only and never sent to the offline store.
const adminContentKinds={page:'페이지',database:'데이터베이스',row:'데이터베이스 항목'};
const adminAudienceLabels={private:'비공개',internal:'워크스페이스 내부',external:'외부 게스트',web:'웹 공개',unknown:'확인 불가'};
const adminCauseLabels={human:'사람',automation:'자동화',import:'가져오기',public_form:'폼 제출',system:'시스템',unknown:'확인 불가'};
function disposeAdminContent(view){const content=view?.contentState;if(!content)return;clearTimeout(content.timer);content.request?.abort();content.pickerRequest?.abort();content.generation++;content.items=[];content.detail=null;content.picker=null;content.review=null;view.contentState=null;}
function adminContentState(view){return view.contentState||(view.contentState={query:{q:'',field:'all',kind:'all',status:'all',audience:'all',location_kind:'all',sort:'title',direction:'asc',limit:'50'},labels:{},items:[],cursor:null,history:[],next:null,generation:0});}
function adminContentCurrent(view,content){return adminConsoleCurrent(view)&&view.tab==='content'&&view.contentState===content&&adminCan(view,'content.search.read');}
function adminContentParams(content,cursor=content.cursor){const params=new URLSearchParams();for(const [key,value] of Object.entries(content.query))if(value!==null&&value!==undefined&&value!=='')params.set(key,/^(created|edited)_(after|before)$/.test(key)?new Date(value).toISOString():String(value));if(cursor)params.set('cursor',cursor);return params;}
function adminContentError(view,content,error){if(!adminContentCurrent(view,content)||error.name==='AbortError'||error.code==='STALE_REQUEST')return;content.detail=null;content.review=null;content.picker=null;content.items=[];content.next=null;if(error.status===409){content.items=[];content.next=null;content.cursor=null;content.history=[];view.error='콘텐츠나 공유 상태가 변경되었습니다. 새로고침한 뒤 다시 확인해 주세요.';}else view.error=error.message;if([401,403].includes(error.status)){disposeAdminContent(view);view.capabilities=null;view.busy=false;view.request=null;}renderAdminConsole(view);}
function adminContentValidate(value){if(!value||!Array.isArray(value.items)||!Number.isSafeInteger(value.content_revision)||!(value.next_cursor===null||typeof value.next_cursor==='string')||!value.items.every(item=>Object.hasOwn(adminContentKinds,item.kind)&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.snippet==='string'&&/^[a-f0-9]{64}$/.test(item.review_revision)&&Object.hasOwn(adminAudienceLabels,item.audience)&&item.access_summary&&item.publication))throw Error('콘텐츠 검색 응답을 확인할 수 없습니다.');return value;}
async function fetchAdminContent(view,request,sequence){const content=adminContentState(view),current=()=>adminContentCurrent(view,content)&&sequence===view.sequence;content.detail=null;content.review=null;content.picker=null;const data=adminContentValidate(await api('/admin/content?'+adminContentParams(content),undefined,'GET',{signal:request.signal,current}));if(!current()||!await adminCheck(view,request.signal)||!current())return;content.items=data.items;content.next=data.next_cursor;content.revision=data.content_revision;}
function changeAdminContent(view,patch,debounce=false){const content=adminContentState(view);Object.assign(content.query,patch);content.cursor=null;content.next=null;content.history=[];content.detail=null;content.review=null;content.picker=null;content.pickerRequest?.abort();content.request?.abort();content.generation++;clearTimeout(content.timer);view.notice=null;view.request?.abort();view.request=null;view.sequence++;view.busy=false;content.items=[];const run=()=>{if(!adminContentCurrent(view,content))return;if(content.query.location_kind!=='all'&&!content.query.location_id){content.picker={target:'location_id',kind:content.query.location_kind,q:'',items:[],next:null};renderAdminConsole(view);void loadAdminContentOptions(view,content);return;}void loadAdminConsole(view);};if(debounce)content.timer=setTimeout(run,300);else run();}
function adminContentSelect(name,label,values,value){return `<label>${label}<select name="${name}">${Object.entries(values).map(([id,text])=>`<option value="${esc(id)}" ${String(value)===id?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;}
function adminContentActor(actor){return actor?`${actor.name||'이름 기록 없음'} · ${adminCauseLabels[actor.cause]||'확인 불가'}`:'기록 없음 · 확인 불가';}
function adminContentRenderDate(value){if(!value)return '기록 없음';const instant=new Date(value);return Number.isNaN(instant.getTime())?'시각 확인 불가':instant.toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'});}
function renderAdminContent(view,body){const content=adminContentState(view),q=content.query;
 const pickButton=(target,kind,label)=>`<div class="admin-content-filter"><span>${label}</span><button type="button" class="outline-btn" data-content-picker="${target}" data-kind="${kind}">${esc(content.labels[target]||'선택 안 함')}</button>${q[target]?`<button type="button" data-content-clear="${target}" aria-label="${label} 필터 해제">해제</button>`:''}</div>`;
 body.innerHTML=`<section class="admin-content"><h4>워크스페이스 전체 콘텐츠 검색</h4><p class="muted">위임받은 관리 검색에서는 비공개 문서의 내용과 공유 상태도 확인할 수 있습니다. 문서를 여는 일반 권한은 별도로 적용됩니다. 검색 결과는 이 기기에 보관하지 않습니다.</p><form id="admin-content-query"><label>검색어<input name="q" value="${esc(q.q)}" placeholder="ID, 제목 또는 본문 · 여러 단어 및 큰따옴표 구문"></label><p class="muted">최대 512자. 입력이 길면 오류를 표시하며 자르지 않습니다.</p><div class="admin-content-filters">${adminContentSelect('field','검색 위치',{all:'전체',id:'ID',title:'제목',body:'본문'},q.field)}${adminContentSelect('kind','콘텐츠 종류',{all:'전체',...adminContentKinds},q.kind)}${adminContentSelect('status','상태',{all:'전체',active:'사용 중',trash:'휴지통'},q.status)}${adminContentSelect('audience','가장 넓은 공유 범위',{all:'전체',...adminAudienceLabels},q.audience)}${adminContentSelect('sort','정렬',{title:'제목',created:'생성 시각',edited:'마지막 편집 시각'},q.sort)}${adminContentSelect('direction','정렬 방향',{asc:'오름차순',desc:'내림차순'},q.direction)}${adminContentSelect('limit','한 번에 표시',{'10':'10개','25':'25개','50':'50개','100':'100개'},q.limit)}</div><details ${content.filtersOpen?'open':''}><summary>작성자·기간·위치·공유 대상 필터</summary><div class="admin-content-filters">${pickButton('creator_id','member','작성자')}${pickButton('editor_id','member','마지막 편집자')}${pickButton('shared_with_id','member','실제 접근 가능한 멤버')}${adminContentSelect('location_kind','위치 종류',{all:'전체',teamspace:'팀스페이스',page:'상위 페이지',database:'데이터베이스'},q.location_kind)}${q.location_kind!=='all'?pickButton('location_id',q.location_kind,'위치'):''}<label class="checkbox-label"><input name="creator_unknown" type="checkbox" ${q.creator_unknown==='1'?'checked':''}>작성자 기록 없음</label><label class="checkbox-label"><input name="editor_unknown" type="checkbox" ${q.editor_unknown==='1'?'checked':''}>편집자 기록 없음</label>${[['created_after','생성 이후 · 포함'],['created_before','생성 이전 · 미포함'],['edited_after','편집 이후 · 포함'],['edited_before','편집 이전 · 미포함']].map(([key,label])=>`<label>${label}<input type="datetime-local" name="${key}" value="${esc(q[key]||'')}" step="0.001"></label>`).join('')}</div></details><button class="solid-btn" type="submit">검색</button><button type="button" class="outline-btn" data-content-reset>필터 초기화</button>${adminCan(view,'content.search.export')?'<button type="button" class="outline-btn" data-content-export>현재 검색 CSV 내보내기</button>':''}</form><div id="admin-content-picker"></div><p role="status">${view.busy?'서버에서 확인하고 있습니다…':`현재 ${content.items.length}개 표시 · ${content.history.length+1}번째 화면`}</p><div class="admin-content-results">${content.items.map((item,index)=>`<article class="admin-content-item"><header><strong>${esc(item.icon||'')} ${esc(item.title||'제목 없음')}</strong><span>${adminContentKinds[item.kind]} · ${item.status==='trash'?'휴지통':'사용 중'}</span></header><p class="admin-content-snippet">${esc(item.snippet)}</p><dl><dt>위치</dt><dd>${esc(item.location?.title||'위치 확인 불가')}</dd><dt>작성</dt><dd>${esc(adminContentActor(item.creator))} · ${esc(adminContentRenderDate(item.created_at))}</dd><dt>마지막 편집</dt><dd>${esc(adminContentActor(item.last_editor))} · ${esc(adminContentRenderDate(item.edited_at))}</dd><dt>공유</dt><dd>${esc(adminAudienceLabels[item.audience])} · 내부 ${Number(item.access_summary.internal_count)||0}명 · 외부 ${Number(item.access_summary.external_count)||0}명</dd><dt>게시</dt><dd>${item.publication.state==='authenticated'?'로그인 필요 · 인증된 사이트':item.publication.state==='anonymous'?'익명 접근 가능':item.publication.state==='disabled'?'게시 비활성':'게시 없음'} · 사이트 ${Number(item.publication.site_count)||0}개 · 폼 ${Number(item.publication.form_count)||0}개</dd></dl><button type="button" class="outline-btn" data-content-detail="${index}">접근 멤버 및 공유 관리</button>${adminCan(view,'content.restore.manage')&&item.kind==='page'&&item.status==='trash'?`<button type="button" class="outline-btn" data-content-restore="${index}">휴지통 페이지 복원 검토</button>`:''}</article>`).join('')||(!view.busy?'<p>조건에 맞는 콘텐츠가 없습니다.</p>':'')}</div><nav class="admin-content-pages" aria-label="콘텐츠 검색 페이지"><button type="button" class="outline-btn" data-content-prev ${!content.history.length?'disabled':''}>이전</button><button type="button" class="outline-btn" data-content-next ${!content.next?'disabled':''}>다음</button></nav><div id="admin-content-detail"></div></section>`;
 const query=$('#admin-content-query',body);$('details',query).ontoggle=event=>{content.filtersOpen=event.target.open;};query.onsubmit=event=>{event.preventDefault();event.stopPropagation();readAdminContentQuery(view,query);};query.onchange=event=>{if(event.target.name!=='q')readAdminContentQuery(view,query);};query.elements.q.oninput=()=>readAdminContentQuery(view,query,true);
 body.onclick=event=>{const button=event.target.closest('button');if(!button)return;event.stopPropagation();if(!adminContentCurrent(view,content)||view.busy)return;void handleAdminContentClick(view,content,button).catch(error=>adminContentError(view,content,error));};
 renderAdminContentPicker(view,content);renderAdminContentDetail(view,content);
}
function readAdminContentQuery(view,form,debounce=false){if(!adminConsoleCurrent(view)||form!==$('#admin-content-query',view.content))return;const content=adminContentState(view),values=new FormData(form),patch={};for(const key of ['q','field','kind','status','audience','sort','direction','limit','location_kind','created_after','created_before','edited_after','edited_before'])patch[key]=String(values.get(key)||'');for(const key of ['creator_unknown','editor_unknown'])patch[key]=values.has(key)?'1':'';if(patch.location_kind!==content.query.location_kind){patch.location_id='';delete content.labels.location_id;}if(patch.creator_unknown==='1'){patch.creator_id='';delete content.labels.creator_id;}if(patch.editor_unknown==='1'){patch.editor_id='';delete content.labels.editor_id;}changeAdminContent(view,patch,debounce);}
async function handleAdminContentClick(view,content,button){if(button.hasAttribute('data-content-reset')){disposeAdminContent(view);return loadAdminConsole(view);}if(button.dataset.contentPicker){content.picker={target:button.dataset.contentPicker,kind:button.dataset.kind,q:'',items:[],next:null};return loadAdminContentOptions(view,content);}if(button.dataset.contentClear){delete content.labels[button.dataset.contentClear];return changeAdminContent(view,{[button.dataset.contentClear]:'',...(button.dataset.contentClear==='location_id'?{location_kind:'all'}:{})});}if(button.hasAttribute('data-content-next')){content.history.push(content.cursor);content.cursor=content.next;return loadAdminConsole(view);}if(button.hasAttribute('data-content-prev')){content.cursor=content.history.pop()||null;return loadAdminConsole(view);}if(button.hasAttribute('data-content-restore'))return loadAdminContentRestore(view,content,content.items[Number(button.dataset.contentRestore)]);if(button.hasAttribute('data-content-detail'))return loadAdminContentDetail(view,content,content.items[Number(button.dataset.contentDetail)]);if(button.hasAttribute('data-content-export'))return exportAdminContent(view,content);}
async function adminContentRead(view,content,path,request,current){if(!await adminCheck(view,request.signal)||!current())return null;const result=await api(path,undefined,'GET',{signal:request.signal,current});if(!current()||!await adminCheck(view,request.signal)||!current())return null;return result;}
async function loadAdminContentOptions(view,content,append=false){const picker=content.picker;if(!picker)return;content.pickerRequest?.abort();const request=new AbortController();content.pickerRequest=request;const generation=++content.generation,current=()=>adminContentCurrent(view,content)&&content.picker===picker&&generation===content.generation;picker.loading=true;renderAdminContentPicker(view,content);try{const params=new URLSearchParams({kind:picker.kind,q:picker.q,limit:'100'});if(append&&picker.next)params.set('cursor',picker.next);const result=await adminContentRead(view,content,'/admin/content/options?'+params,request,current);if(!result||!current())return;if(!Array.isArray(result.items)||!result.items.every(item=>typeof item.id==='string'&&typeof item.label==='string'))throw Error('선택 목록을 확인할 수 없습니다.');picker.items=append?[...picker.items,...result.items]:result.items;picker.next=result.next_cursor;picker.error=null;}catch(error){if(current()&&error.name!=='AbortError'&&error.code!=='STALE_REQUEST'){picker.items=[];picker.next=null;if([401,403].includes(error.status)){adminContentError(view,content,error);return;}picker.error=error.status===409?'목록이 변경되었습니다. 이름을 다시 검색해 주세요.':error.message;}}finally{if(current()){picker.loading=false;renderAdminContentPicker(view,content);}}}
function renderAdminContentPicker(view,content){const root=$('#admin-content-picker',view.content),picker=content.picker;if(!root||!adminContentCurrent(view,content))return;if(!picker){root.replaceChildren();return;}root.innerHTML=`<section class="admin-content-choice"><h5>이름으로 선택</h5><form id="admin-content-options-query"><label>이름 검색<input name="q" value="${esc(picker.q)}" placeholder="이름 또는 이메일"></label><button class="outline-btn">검색</button></form>${picker.loading?'<p role="status">목록을 확인하고 있습니다…</p>':''}${picker.error?`<p role="alert">${esc(picker.error)}</p>`:''}<div class="admin-content-options">${picker.items.map((item,index)=>`<button type="button" class="outline-btn" data-option-index="${index}" ${picker.loading?'disabled':''}>${esc(item.label||'이름 없음')}${item.email?' · '+esc(item.email):''}${item.active===false?' · 비활성':''}</button>`).join('')}</div>${picker.next?'<button type="button" class="outline-btn" data-option-more>더 보기</button>':''}<button type="button" class="outline-btn" data-option-close>선택 닫기</button></section>`;$('#admin-content-options-query',root).onsubmit=event=>{event.preventDefault();event.stopPropagation();picker.q=event.target.elements.q.value;void loadAdminContentOptions(view,content);};root.onclick=event=>{const target=event.target.closest('button');if(!target)return;event.stopPropagation();if(!adminContentCurrent(view,content)||picker.loading)return;if(target.hasAttribute('data-option-close')){content.picker=null;content.pickerRequest?.abort();renderAdminContentPicker(view,content);}else if(target.hasAttribute('data-option-more'))void loadAdminContentOptions(view,content,true);else if(target.hasAttribute('data-option-index')){const item=picker.items[Number(target.dataset.optionIndex)];if(!item)return;if(picker.target==='grant-member'||picker.target==='grant-group'){if(item.active===false){picker.error='비활성 멤버에게 새 권한을 부여할 수 없습니다.';renderAdminContentPicker(view,content);return;}const detail=content.detail;if(!detail)return;const key=picker.target==='grant-member'?'members':'groups';Object.defineProperty(detail.draft[key],item.id,{value:'view',writable:true,enumerable:true,configurable:true});detail.labels[key][item.id]=item.label||item.email||'이름 없음';content.picker=null;renderAdminContentPicker(view,content);renderAdminContentDetail(view,content);}else{content.labels[picker.target]=item.label||item.email||'이름 없음';const patch={[picker.target]:item.id};if(picker.target==='creator_id')patch.creator_unknown='';if(picker.target==='editor_id')patch.editor_unknown='';changeAdminContent(view,patch);}}};}
async function loadAdminContentDetail(view,content,item,append=false){if(!item)return;content.request?.abort();const request=new AbortController();content.request=request;const generation=++content.generation,current=()=>adminContentCurrent(view,content)&&generation===content.generation;let detail=append?content.detail:{item,items:[],next:null,loading:true};detail.loading=true;content.detail=detail;content.review=null;renderAdminContentDetail(view,content);try{const params=new URLSearchParams({kind:item.kind,id:item.id,limit:'100'});if(append&&detail.next)params.set('cursor',detail.next);const access=await adminContentRead(view,content,'/admin/content/access?'+params,request,current);if(!access||!current())return;if(access.review_revision!==item.review_revision||access.content_revision!==content.revision){const error=Error('콘텐츠가 변경되었습니다.');error.status=409;throw error;}detail.items=append?[...detail.items,...access.items]:access.items;detail.next=access.next_cursor;if(item.can_manage_permissions&&!append){const config=await adminContentRead(view,content,'/admin/content/permissions?'+new URLSearchParams({kind:item.kind,id:item.id}),request,current);if(!config||!current())return;if(config.review_revision!==item.review_revision){const error=Error('공유 상태가 변경되었습니다.');error.status=409;throw error;}detail.config=config;detail.draft=structuredClone({default:'workspace',inherit:true,members:{},groups:{},...(config.permissions||{})});detail.labels={members:Object.create(null),groups:Object.create(null)};for(const person of detail.items)detail.labels.members[person.id]=person.name||person.email||'이름 기록 없음';await adminContentGrantLabels(view,content,detail,request,current);}
 }catch(error){if(current())adminContentError(view,content,error);}finally{if(current()&&content.detail===detail){detail.loading=false;renderAdminContentDetail(view,content);}}}
function adminContentRestoreConfig(config,item){
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),fields=['kind','id','permissions','review_revision','source_invalid'];
 let valid=object(config)&&Object.keys(config).length===fields.length&&fields.every(key=>Object.hasOwn(config,key))&&config.kind==='page'&&config.id===item.id&&typeof config.source_invalid==='boolean'&&typeof config.review_revision==='string'&&/^[a-f0-9]{64}$/.test(config.review_revision);
 const permissions=config?.permissions;
 if(permissions!==null){valid=valid&&object(permissions)&&Object.keys(permissions).every(key=>['default','inherit','members','groups'].includes(key));if(valid){if(Object.hasOwn(permissions,'default'))valid=['private','workspace'].includes(permissions.default);if(Object.hasOwn(permissions,'inherit'))valid=valid&&typeof permissions.inherit==='boolean';for(const key of ['members','groups'])if(Object.hasOwn(permissions,key))valid=valid&&object(permissions[key])&&Object.keys(permissions[key]).length<=1000&&Object.values(permissions[key]).every(level=>['none','view','comment','edit','full'].includes(level));}}
 if(!valid||config.source_invalid&&permissions!==null)throw Error('복원 검토 응답을 확인할 수 없습니다.');return config;
}
// Restoration uses a separate read-only review; the manage action never opens a page body.
async function loadAdminContentRestore(view,content,item){
 if(!item||item.kind!=='page'||item.status!=='trash'||!adminContentCurrent(view,content)||!adminCan(view,'content.restore.manage'))return;
 content.request?.abort();content.pickerRequest?.abort();content.picker=null;content.review=null;
 const request=new AbortController(),detail={item,restore:true,mode:'private',loading:true};content.request=request;content.detail=detail;
 const generation=++content.generation,current=()=>adminContentCurrent(view,content)&&adminCan(view,'content.restore.manage')&&generation===content.generation&&content.detail===detail;
 renderAdminContentPicker(view,content);renderAdminContentDetail(view,content);
 try{const config=await adminContentRead(view,content,'/admin/content/restore?'+new URLSearchParams({kind:'page',id:item.id}),request,current);if(!config||!current())return;
  adminContentRestoreConfig(config,item);
  if(config.review_revision!==item.review_revision){const error=Error('콘텐츠나 원래 위치가 변경되었습니다.');error.status=409;throw error;}
  detail.config=config;
 }catch(error){if(current())adminContentError(view,content,error);}finally{if(current()){detail.loading=false;renderAdminContentDetail(view,content);}}
}
function renderAdminContentRestore(view,content,root,detail){
 const item=detail.item,config=detail.config,permissions=config?.permissions;
 root.innerHTML=`<section class="admin-content-detail"><h4>${esc(item.title||'제목 없음')} · 휴지통 페이지 복원 검토</h4><p>선택한 페이지 한 개만 복원합니다. 하위 페이지의 휴지통 상태와 각자의 공유 설정·게시 상태는 유지됩니다.</p><p>워크스페이스 소유자는 복원 방식과 관계없이 관리 권한으로 접근할 수 있습니다.</p><dl><dt>원래 위치</dt><dd>${esc(item.location?.title||'위치 확인 불가')}</dd><dt>현재 공유 범위</dt><dd>${esc(adminAudienceLabels[item.audience])} · 내부 ${Number(item.access_summary.internal_count)||0}명 · 외부 ${Number(item.access_summary.external_count)||0}명</dd></dl>${detail.loading?'<p role="status">현재 공유 설정과 복원 조건을 확인하고 있습니다…</p>':''}${config?`<p>${config.source_invalid?'저장된 직접 공유 설정이 유효하지 않습니다. 원래 설정 복원은 이 상태를 유지합니다.':permissions===null?'직접 공유 설정 없음 · 기본 상속 규칙이 적용됩니다.':`현재 직접 공유: ${permissions.default==='private'?'비공개':'워크스페이스 내부'} · 상위 권한 ${permissions.inherit===false?'상속 안 함':'상속'} · 개별 멤버 ${Object.keys(permissions.members||{}).length}명 · 그룹 ${Object.keys(permissions.groups||{}).length}개`}</p><form id="admin-content-restore-form"><fieldset><legend>복원 방식</legend><label class="checkbox-label"><input type="radio" name="mode" value="private" ${detail.mode==='private'?'checked':''}>내 비공개 페이지로 복원</label><p>현재 계정을 이 페이지의 문서 소유자로 지정하므로 복원 후 본문에 접근할 수 있습니다. 상위 페이지와 팀스페이스 연결을 제거하고 직접 멤버·그룹 공유와 상속을 끕니다.</p><label class="checkbox-label"><input type="radio" name="mode" value="original" ${detail.mode==='original'?'checked':''}>원래 위치와 공유 설정으로 복원</label><p>원래 문서 소유자, 상위 페이지, 팀스페이스, 공유 설정을 유지합니다. 원래 위치나 상위 페이지를 사용할 수 없으면 복원하지 않습니다.</p></fieldset><p>이 페이지에 연결된 모든 사이트의 게시를 중단합니다. 복원 후 자동으로 다시 게시하지 않습니다.</p><p>검토 후 콘텐츠·공유·원래 위치가 바뀌면 현재 검토를 폐기하고 목록을 새로고침한 뒤 다시 검토해야 합니다.</p><button class="solid-btn" type="submit">선택한 방식으로 페이지 복원</button></form>`:''}<button type="button" class="outline-btn" data-content-restore-close>복원 검토 닫기</button></section>`;
 const current=()=>adminContentCurrent(view,content)&&adminCan(view,'content.restore.manage')&&content.detail===detail;
 root.onchange=event=>{if(!current()||view.busy||event.target.name!=='mode')return;if(['original','private'].includes(event.target.value)){detail.mode=event.target.value;content.review=null;}};
 const form=$('#admin-content-restore-form',root);if(form)form.onsubmit=event=>{event.preventDefault();event.stopPropagation();if(!current()||view.busy||detail.loading||!detail.config)return;content.review={path:'restore',body:{mode:detail.mode},label:'선택한 페이지 복원'};void applyAdminContentChange(view,content).catch(error=>adminContentError(view,content,error));};
 root.onclick=event=>{const button=event.target.closest('button');if(!button)return;event.stopPropagation();if(!current()||view.busy)return;if(button.hasAttribute('data-content-restore-close')){content.request?.abort();content.generation++;content.detail=null;content.review=null;renderAdminContentDetail(view,content);}};
 for(const control of $$('button,input,select',root))if(view.busy||!adminCan(view,'content.restore.manage')||detail.loading&&!control.hasAttribute('data-content-restore-close'))control.disabled=true;
}
async function adminContentGrantLabels(view,content,detail,request,current){for(const key of ['members','groups']){const missing=new Set(Object.keys(detail.draft[key]||{}).filter(id=>!Object.hasOwn(detail.labels[key],id)));if(!missing.size)continue;let cursor=null;do{const params=new URLSearchParams({kind:key==='members'?'member':'group',limit:'100'});if(cursor)params.set('cursor',cursor);const data=await adminContentRead(view,content,'/admin/content/options?'+params,request,current);if(!data||!current())return;if(data.content_revision!==content.revision){const error=Error('공유 대상 목록이 변경되었습니다.');error.status=409;throw error;}for(const option of data.items)if(missing.has(option.id)){detail.labels[key][option.id]=(option.label||option.email||'이름 기록 없음')+(option.active===false?' · 비활성':'');missing.delete(option.id);}cursor=data.next_cursor;}while(cursor&&missing.size);}}
function adminContentLevelOptions(value){return Object.entries({none:'접근 거부',view:'보기',comment:'댓글',edit:'편집',full:'모든 권한'}).map(([key,label])=>`<option value="${key}" ${key===value?'selected':''}>${label}</option>`).join('');}
function renderAdminContentDetail(view,content){const root=$('#admin-content-detail',view.content),detail=content.detail;if(!root||!adminContentCurrent(view,content))return;if(!detail){root.replaceChildren();return;}if(detail.restore){renderAdminContentRestore(view,content,root,detail);return;}const item=detail.item,review=content.review;root.innerHTML=`<section class="admin-content-detail"><h4>${esc(item.title||'제목 없음')} · 공유 검토</h4><p>워크스페이스 소유자는 관리 권한으로 항상 접근할 수 있습니다. 아래의 실제 공유 멤버 수와 별도로 표시합니다.</p>${detail.loading?'<p role="status">현재 접근 상태를 확인하고 있습니다…</p>':''}<div class="settings-list">${detail.items.map((person,index)=>`<article class="settings-item"><div><strong>${esc(person.name||person.email||'이름 기록 없음')}</strong><small>${esc(person.email||'')} · ${esc(({owner:'소유자',admin:'멤버 관리자',member:'일반 멤버',guest:'게스트'})[person.role]||person.role)} · ${esc(({resource_owner:'문서 소유자',direct:'직접 공유',group:'그룹 공유',inherited:'상위 문서에서 상속',workspace:'워크스페이스 공유',assignment:'담당자 정책',workspace_admin:'소유자의 관리 접근'})[person.via]||'접근 권한')} · ${esc(({1:'보기',2:'댓글',3:'편집',4:'모든 권한'})[person.level]||'')}</small></div>${person.can_revoke&&item.can_manage_permissions?`<button type="button" class="outline-btn" data-content-deny="${index}">이 멤버 접근 거부 검토</button>`:'<small>이 화면에서 철회할 수 없음</small>'}</article>`).join('')}</div>${detail.next?'<button type="button" class="outline-btn" data-content-access-more>접근 멤버 더 보기</button>':''}${detail.config?`<h5>직접 공유 설정</h5><p>${detail.config.source_invalid?'저장된 공유 설정이 유효하지 않습니다. 기존 접근 상태를 확인한 뒤 새 설정으로 교체할 수 있습니다.':detail.config.permissions===null?'직접 설정 없음 · 기본 상속 규칙이 적용됩니다.':'현재 문서에 저장된 직접 공유 설정입니다.'}</p><form id="admin-content-acl"><label>기본 접근<select name="default"><option value="private" ${detail.draft.default==='private'?'selected':''}>비공개</option><option value="workspace" ${detail.draft.default==='workspace'?'selected':''}>워크스페이스 내부</option></select></label><label class="checkbox-label"><input type="checkbox" name="inherit" ${detail.draft.inherit?'checked':''}>상위 문서의 권한 상속</label>${['members','groups'].map(key=>`<fieldset><legend>${key==='members'?'개별 멤버':'직접 공유 그룹'}</legend>${Object.entries(detail.draft[key]||{}).map(([id,level],index)=>`<label>${esc(detail.labels[key][id]||'이름 확인 필요 · 기존 공유 대상')}<select data-acl-kind="${key}" data-acl-index="${index}">${adminContentLevelOptions(level)}</select><button type="button" class="outline-btn" data-acl-remove="${key}" data-index="${index}">${key==='groups'?'직접 그룹 공유 제거 검토':'직접 설정 제거'}</button></label>`).join('')}<button type="button" class="outline-btn" data-acl-add="${key}">${key==='members'?'이름으로 멤버 추가':'이름으로 그룹 추가'}</button></fieldset>`).join('')}<button class="solid-btn">공유 설정 교체 검토</button></form><button type="button" class="outline-btn" data-content-private>직접 공유를 비공개로 전환 검토</button>`:''}${item.can_unpublish?'<button type="button" class="outline-btn" data-content-unpublish>연결된 사이트·폼 게시 중단 검토</button>':''}${item.kind==='row'?'<p>데이터베이스 항목은 독립적으로 게시를 중단할 수 없습니다.</p>':''}<div id="admin-content-review">${review?`<section class="info-box"><h5>변경 전 확인</h5><p>${esc(review.label)}</p><p>상속, 그룹 및 다른 공유 경로에 따라 영향이 달라질 수 있습니다. 문서 소유자와 워크스페이스 소유자의 접근은 유지됩니다.</p><button type="button" class="solid-btn" data-content-confirm>검토한 변경 적용</button><button type="button" class="outline-btn" data-content-review-cancel>취소</button></section>`:''}</div><button type="button" class="outline-btn" data-content-detail-close>공유 검토 닫기</button></section>`;
 root.onchange=event=>{if(!adminContentCurrent(view,content)||detail!==content.detail)return;const target=event.target;if(target.name==='default')detail.draft.default=target.value;else if(target.name==='inherit')detail.draft.inherit=target.checked;else if(target.dataset.aclKind){const key=target.dataset.aclKind,id=Object.keys(detail.draft[key])[Number(target.dataset.aclIndex)];if(id)detail.draft[key][id]=target.value;}content.review=null;};const form=$('#admin-content-acl',root);if(form)form.onsubmit=event=>{event.preventDefault();event.stopPropagation();content.review={path:'permissions',body:{operation:'replace_permissions',permissions:structuredClone(detail.draft)},label:'선택한 멤버·그룹·상속 설정으로 직접 공유를 교체합니다.'};renderAdminContentDetail(view,content);};
 root.onclick=event=>{const button=event.target.closest('button');if(!button)return;event.stopPropagation();if(!adminContentCurrent(view,content)||view.busy||detail.loading)return;const run=async()=>{if(button.hasAttribute('data-content-access-more'))return loadAdminContentDetail(view,content,item,true);if(button.hasAttribute('data-content-detail-close')){content.request?.abort();content.detail=null;content.review=null;renderAdminContentDetail(view,content);return;}if(button.hasAttribute('data-content-review-cancel')){content.review=null;renderAdminContentDetail(view,content);return;}if(button.hasAttribute('data-content-confirm'))return applyAdminContentChange(view,content);if(button.hasAttribute('data-content-deny')){const person=detail.items[Number(button.dataset.contentDeny)];content.review={path:'permissions',body:{operation:'revoke_member',member_id:person.id},label:`${person.name||person.email||'선택한 멤버'}의 접근을 명시적으로 거부합니다.`};}else if(button.hasAttribute('data-content-private'))content.review={path:'permissions',body:{operation:'set_private'},label:'직접 멤버·그룹 공유를 모두 제거하고 상속을 끄며 비공개로 전환합니다.'};else if(button.hasAttribute('data-content-unpublish'))content.review={path:'unpublish',body:{},label:item.kind==='page'?'이 페이지에 연결된 모든 활성 사이트의 게시를 중단합니다.':'이 데이터베이스에 연결된 모든 활성 폼의 게시를 중단합니다.'};else if(button.dataset.aclAdd){const key=button.dataset.aclAdd;content.picker={target:key==='members'?'grant-member':'grant-group',kind:key==='members'?'member':'group',q:'',items:[],next:null};return loadAdminContentOptions(view,content);}else if(button.dataset.aclRemove){const key=button.dataset.aclRemove,id=Object.keys(detail.draft[key])[Number(button.dataset.index)];if(key==='groups'&&detail.config?.permissions?.groups?.[id]&&detail.config.permissions.groups[id]!=='none'){content.review={path:'permissions',body:{operation:'remove_group',group_id:id},label:`${detail.labels.groups[id]||'선택한 그룹'}의 직접 공유만 제거합니다. 다른 공유 경로의 접근은 유지될 수 있습니다.`};}else delete detail.draft[key][id];}else return;renderAdminContentDetail(view,content);};void run().catch(error=>adminContentError(view,content,error));};for(const control of $$('button,input,select',root))if(detail.loading||view.busy)control.disabled=true;}
async function applyAdminContentChange(view,content){const detail=content.detail,review=content.review;if(!detail||!review||review.path==='restore'&&(!detail.restore||!detail.config||!adminCan(view,'content.restore.manage')))return;const request=new AbortController();content.request=request;const generation=++content.generation,current=()=>adminContentCurrent(view,content)&&generation===content.generation;view.busy=true;renderAdminContentDetail(view,content);try{if(!await adminCheck(view,request.signal)||!current())return;const result=await api('/admin/content/'+review.path,{kind:detail.item.kind,id:detail.item.id,review_revision:review.path==='restore'?detail.config.review_revision:detail.item.review_revision,...review.body},'POST',{signal:request.signal,current});if(!current()||!await adminCheck(view,request.signal)||!current())return;if(result.applied!==true)throw Error('변경 완료를 확인하지 못했습니다. 새로고침으로 현재 상태를 확인해 주세요.');if(review.path==='restore'&&(!await refreshWorkspace({adminView:view,adminCurrent:current})||!current()))return;content.review=null;content.detail=null;view.notice='검토한 관리 변경을 적용했습니다.';view.busy=false;content.cursor=null;content.history=[];await loadAdminConsole(view);}catch(error){if(current())adminContentError(view,content,error);}finally{if(current()){view.busy=false;renderAdminConsole(view);}}}
// The file is committed only after a complete byte count and transport EOF.
function createAdminCSVDecoder(onData,{current=()=>true}={}){
 const buffer=new Uint8Array(99999),utf8=new TextDecoder('utf-8',{fatal:true});
 let length=0,total=0,terminal=false,closed=false,pushing=false;
 const failure=status=>Object.assign(new Error(status===401?'다시 로그인한 뒤 내보내 주세요.':status===403?'내보내기 권한이 변경되었습니다. 현재 권한을 확인해 주세요.':status===409?'콘텐츠가 변경되었습니다. 새로고침한 뒤 다시 내보내 주세요.':'내보내기 파일을 완전히 받지 못했습니다. 다시 시도해 주세요.'),status?{status}:{});
 const assertCurrent=()=>{if(!current())throw Object.assign(new Error('지난 내보내기 요청입니다.'),{code:'STALE_REQUEST'});};
 function record(line){
  // Only flat two-field objects are valid. Parse keys before assignment so
  // duplicate spellings (including escaped keys) cannot be hidden by JSON.parse.
  const string=/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value=Object.create(null);let at=0;
  const skip=()=>{while(/[ \t\r]/.test(line[at]||'')&&at<line.length)at++;};
  const take=character=>{skip();if(line[at++]!==character)throw failure();};
  const token=pattern=>{skip();pattern.lastIndex=at;const match=pattern.exec(line);if(!match)throw failure();at=pattern.lastIndex;return match[0];};
  take('{');
  for(let field=0;field<2;field++){
   const key=JSON.parse(token(string));if(Object.hasOwn(value,key))throw failure();take(':');skip();
   value[key]=line[at]==='"'?JSON.parse(token(string)):Number(token(number));
   if(field===0)take(',');
  }
  take('}');skip();if(at!==line.length)throw failure();
  const keys=Object.keys(value);
  if(value.type==='data'&&keys.includes('data')&&typeof value.data==='string')return value;
  if(value.type==='complete'&&keys.includes('bytes')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0)return value;
  if(value.type==='error'&&keys.includes('status')&&[400,401,403,409,413,503].includes(value.status))return value;
  throw failure();
 }
 async function line(){
  if(length===0||terminal)throw failure();
  let frame;try{frame=record(utf8.decode(buffer.subarray(0,length)));}catch(error){if(error.status)throw error;throw failure();}
  length=0;
  if(frame.type==='error')throw failure(frame.status);
  if(frame.type==='complete'){if(frame.bytes!==total)throw failure();terminal=true;return;}
  const encoded=frame.data;
  if(encoded.length===0||encoded.length>87384||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw failure();
  let binary;try{binary=atob(encoded);}catch{throw failure();}
  if(binary.length<1||binary.length>65536||btoa(binary)!==encoded||!Number.isSafeInteger(total+binary.length))throw failure();
  total+=binary.length;assertCurrent();await onData(Uint8Array.from(binary,character=>character.charCodeAt(0)));assertCurrent();
 }
 return {
  async push(bytes){if(closed||pushing||!(bytes instanceof Uint8Array))throw failure();pushing=true;
   try{assertCurrent();let at=0;while(at<bytes.length){if(terminal)throw failure();const newline=bytes.indexOf(10,at),end=newline<0?bytes.length:newline,size=end-at;if(length+size>buffer.length)throw failure();buffer.set(bytes.subarray(at,end),length);length+=size;at=end;if(newline<0)break;at++;await line();}}
   catch(error){closed=true;throw error;}finally{pushing=false;}
  },
  finish(){assertCurrent();if(closed||pushing||length!==0||!terminal)throw failure();closed=true;return total;}
 };
}

async function exportAdminContent(view,content){
 const request=new AbortController();content.request?.abort();content.request=request;
 const generation=++content.generation,current=()=>adminContentCurrent(view,content)&&generation===content.generation;
 view.busy=true;view.error=null;view.notice='전체 검색 결과를 내려받고 있습니다. 전송이 끝나기 전에는 저장을 완료하지 않습니다.';
 renderAdminConsole(view);let reader,writable,committed=false;
 try{
  // Open the OS chooser in the original click gesture, before any network await.
  const handle=!FountainTransport.native&&typeof window.showSaveFilePicker==='function'?await window.showSaveFilePicker({suggestedName:'fountain-content.csv',types:[{description:'CSV 파일',accept:{'text/csv':['.csv']}}]}):null;
  if(!current())return;
  if(!adminCan(view,'content.search.export')||!await adminCheck(view,request.signal)||!current())return;
  const params=adminContentParams(content,null);params.set('format','frames');
  const response=await FountainTransport.request('/api/admin/content/export?'+params,{signal:request.signal});
  if(!current())return;
  if(!response.ok){const data=await response.json().catch(()=>({}));const error=Error(data.error||'CSV 내보내기에 실패했습니다.');error.status=response.status;throw error;}
  const protocol=response.headers.get('X-Fountain-CSV-Protocol');
  if(!/^application\/x-ndjson(?:;|$)/i.test(response.headers.get('content-type')||'')||protocol!=='1'&&(!FountainTransport.native||protocol!==null))throw Error('내보내기 응답을 확인할 수 없습니다.');
  if(handle)writable=await handle.createWritable();
  if(!current())return;
  const chunks=[],limit=FountainTransport.native?8*1024*1024:32*1024*1024;let buffered=0;
  const write=async chunk=>{if(writable){await writable.write(chunk);return;}buffered+=chunk.byteLength;if(buffered>limit)throw Error(FountainTransport.native?'이 앱의 파일 저장 한도 8 MB를 넘었습니다. 스트리밍 파일 저장을 지원하는 웹 브라우저에서 내보내 주세요.':'이 브라우저의 메모리 다운로드 한도 32 MB를 넘었습니다. 스트리밍 파일 저장을 지원하는 브라우저에서 다시 시도해 주세요.');chunks.push(chunk);};
  const decoder=createAdminCSVDecoder(write,{current});
  reader=response.body?.getReader();
  if(reader){while(true){const chunk=await reader.read();if(!current())throw Object.assign(Error('지난 내보내기 요청입니다.'),{code:'STALE_REQUEST'});if(chunk.done)break;await decoder.push(chunk.value);}}
  else await decoder.push(new Uint8Array(await response.arrayBuffer()));
  decoder.finish();
  if(!current()||!await adminCheck(view,request.signal)||!current())return;
  if(writable){await writable.close();committed=true;}
  else{const blob=new Blob(chunks,{type:'text/csv;charset=utf-8'}),filename='fountain-content.csv';if(FountainTransport.native)await FountainTransport.saveData(filename,blob,'text/csv;charset=utf-8');else{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
  if(current())view.notice=writable||FountainTransport.native?'CSV 파일 저장을 완료했습니다.':'CSV 전송을 완료했습니다. 브라우저의 다운로드 목록에서 확인해 주세요.';
 }catch(error){if(current()){view.notice=null;if(error.name==='AbortError')view.notice='CSV 저장을 취소했습니다.';else adminContentError(view,content,error);}}
 finally{request.abort();try{await reader?.cancel();}catch{}if(writable&&!committed)try{await writable.abort();}catch{}if(current()){view.busy=false;renderAdminConsole(view);}}
}

async function mountAdminConsole(content,{roleTab=false,capabilities=null}={}){clearAdminConsole();
  const view={scope:verifiedPagesIdentity(),navigation:state.nativeNavigation,modal:content.closest('.modal'),content,roleTab,tab:roleTab?'roles':null,capabilities,sequence:0,busy:false,closed:false};
  state.adminConsole=view;
  await loadAdminConsole(view);
  }
async function openAdminConsole(){if(!verifiedPagesIdentityCurrent(verifiedPagesIdentity()))throw Error('현재 계정으로 서버에 연결해 주세요.');
  openModal('위임된 관리 설정','<div id="admin-console-content"></div>','admin-settings-modal');
  await mountAdminConsole($('#admin-console-content'));
  }
window.addEventListener('focus',()=>{const view=state.adminConsole;
  if(adminConsoleCurrent(view)&&!view.busy)void adminCheck(view).catch(error=>{if(adminConsoleCurrent(view)&&error.name!=='AbortError'&&error.code!=='STALE_REQUEST'){view.data=null;
  view.overview=null;
  view.capabilities=null;
  view.editor=null;
  view.notice=null;
  disposeAdminContent(view);
  view.error='현재 관리 권한을 다시 확인해 주세요.';
  renderAdminConsole(view);
  }});
  });


async function openSettings(tab='members') {
  if(tab==='verified'){await openVerifiedPages();return;}
  clearScimPanel();
  const selfScope=verifiedPagesIdentity(),selfTicket=++settingsOpenSequence,selfOverlay=$('#overlay-root').firstChild,selfNavigation=state.nativeNavigation;let self=null;adminSettingsRequest?.abort();const selfRequest=new AbortController();adminSettingsRequest=selfRequest;const selfCurrent=()=>verifiedPagesIdentityCurrent(selfScope)&&settingsOpenSequence===selfTicket&&$('#overlay-root').firstChild===selfOverlay&&state.nativeNavigation===selfNavigation;try{self=adminPermissions(await api('/admin/self',undefined,'GET',{signal:selfRequest.signal,current:selfCurrent}));}catch(error){if(!selfCurrent())return;if(error.status!==404)toast(error.message);}finally{if(adminSettingsRequest===selfRequest)adminSettingsRequest=null;}if(!selfCurrent())return;
  if(!isAdmin()){openModal('내 계정',`<p><strong>${esc(state.session?.member?.name||'가족')}</strong><br>${esc(state.session?.member?.email||'')}<br>${esc(state.session?.member?.role||'')}</p><button class="outline-btn" data-action="verified-pages">검증된 페이지</button>${self?.actions.length?'<button class="outline-btn" data-action="admin-settings">위임된 관리 설정</button>':''}${state.accountMode?'<button class="outline-btn" data-action="workspaces">내 작업공간</button><button class="outline-btn" data-action="workspace-invite">가족 계정 초대</button>':''}<button class="outline-btn" data-action="logout">로그아웃</button>`);return;}
  const identity=verifiedPagesIdentity(),ticket=++settingsOpenSequence,navigation=state.nativeNavigation,overlay=$('#overlay-root').firstChild;const current=()=>verifiedPagesIdentityCurrent(identity)&&isAdmin()&&settingsOpenSequence===ticket&&state.nativeNavigation===navigation&&$('#overlay-root').firstChild===overlay;
  state.settingsTab=tab;
  if(tab==='admin-roles'&&isOwner()){openModal('워크스페이스 설정','<div class="settings-layout"><nav class="settings-tabs" id="settings-tabs"></nav><div class="settings-content" id="settings-content"></div></div>','settings-modal');$('.modal-body').style.padding='0';await renderSettings();return true;}
  try {
    const advanced=await api('/advanced',undefined,'GET',{current});if(!current())return;state.advanced=advanced;
  }
  catch(e) {
    if(!current())return;toast(e.message);
    state.advanced= {
    };
  }
  openModal('워크스페이스 설정','<div class="settings-layout"><nav class="settings-tabs" id="settings-tabs"></nav><div class="settings-content" id="settings-content"></div></div>','settings-modal');
  $('.modal-body').style.padding='0';const modal=$('.settings-modal');
  await renderSettings();return modal.isConnected&&$('.settings-modal')===modal&&verifiedPagesIdentityCurrent(identity)&&state.settingsTab===tab&&state.nativeNavigation===navigation;
}
const settingsTabs=[['admin-roles','관리 역할'],['admin-settings','위임된 관리 설정'],['verified','검증된 페이지'],['accounts','가족 계정'],['members','멤버 및 그룹'],['security','보안 및 권한'],['scim','SCIM 계정 연동'],['automations','자동화'],['forms','폼'],['sites','사이트'],['AI','AI 및 연결'],['analytics','워크스페이스 분석'],['features','기능 제공 현황'],['export','가져오기 / 내보내기']];
async function renderSettings() {
  clearVerifiedPages();clearAdminConsole();clearScimPanel();
  if(!$('#settings-tabs')||!$('#settings-content'))return;
  if(!isAdmin()&&state.settingsTab!=='verified'){$('#settings-tabs').innerHTML=`<a href="${esc(organizationURL())}">조직 관리 ↗</a>`;$('#settings-content').textContent='관리자 권한이 필요합니다.';return;}
  const tab=state.settingsTab;$('.settings-modal')?.classList.toggle('verified-settings-modal',tab==='verified');$('.settings-modal')?.classList.toggle('admin-settings-modal',['admin-roles','admin-settings'].includes(tab));
  $('#settings-tabs').innerHTML=settingsTabs.filter(([key])=>(isAdmin()||key==='verified')&&(!['admin-roles','accounts','security','scim','analytics','export','AI'].includes(key)||isOwner())).map(([key,name])=>`<button data-action="settings-tab" data-tab="${key}" class="${tab===key?'active':''}">${name}</button>`).join('')+`<a href="${esc(organizationURL())}">조직 관리 ↗</a>${state.accountMode?'<button data-action="workspaces">내 작업공간</button><button data-action="workspace-invite">가족 계정 초대</button>':''}`;
  let content=$('#settings-content');if(['verified','admin-roles','admin-settings'].includes(tab)){const fresh=content.cloneNode(false);content.replaceWith(fresh);content=fresh;}
  const a=state.advanced|| {
  };
  const header=(title,desc,button='')=>`<div class="section-heading"><h3>${title}</h3>${button}</div><p>${desc}</p>`;
  const add=(kind,label)=>`<button class="outline-btn" data-action="add-advanced" data-kind="${kind}">+ ${label}</button>`;
  const items=(kind,detail)=>`<div class="settings-list">${normalizeList(a[kind]).map(item=>`<div class="settings-item"><div><strong>${esc(item.name||item.title||item.email||item.id)}</strong><small>${esc(detail(item))}</small></div><div>${kind==='automations'?`<button data-action="toggle-automation" data-id="${esc(item.id)}">${item.enabled===false?'사용':'일시 중지'}</button><button data-action="automation-runs" data-id="${esc(item.id)}">기록</button><button data-action="run-automation" data-id="${esc(item.id)}" ${item.enabled===false?'disabled title="직접 실행하려면 먼저 자동화를 사용 상태로 바꾸세요"':''}>한 번 실행</button>`:''}${kind==='forms'?`<button data-action="fill-form" data-id="${esc(item.id)}">응답</button>`:''}${kind==='sites'?`<button data-action="site-link" data-id="${esc(item.id)}">링크</button>`:''}${kind!=='members'||isOwner()||!['owner','admin'].includes(item.role)?`<button data-action="edit-advanced" data-kind="${kind}" data-id="${esc(item.id)}">관리</button>`:''}</div></div>`).join('')||'<div class="empty">아직 항목이 없어요. 첫 번째 항목을 만들어 보세요.</div>'}</div>`;
  if(tab==='admin-roles'){await mountAdminConsole(content,{roleTab:true});}
  else if(tab==='admin-settings'){await mountAdminConsole(content);}
  else if(tab==='verified'){await mountVerifiedPages(content);}
  else if(tab==='scim'){await renderScimSettings(content);}
  else if(tab==='accounts'){await renderAccounts(content);}
  else if(tab==='members') {
    content.innerHTML=header('함께 만드는 워크스페이스','팀원을 초대하고, 역할과 그룹을 관리하세요.',add('members','멤버 초대'))+items('members',m=>`${m.email||''} · ${m.role||'member'}`)+`<div class="section-heading" style="margin-top:28px"><h3>그룹</h3>${add('groups','그룹 추가')}</div>`+items('groups',g=>`${(g.members||[]).length}명의 멤버`);
  }
  else if(tab==='security') {
    const s=a.settings||state.workspace.settings|| {
    };
    content.innerHTML=header('보안 및 권한','워크스페이스의 데이터 접근 정책을 설정하세요.')+`<form class="form-grid" id="security-form">${field('워크스페이스 이름','workspace_name','Fountain 스튜디오','text',s.name||'Fountain 스튜디오')}<label style="display:flex;align-items:center"><input class="toggle" style="width:auto" type="checkbox" name="disable_guests" ${s.disable_guests?'checked':''}> 게스트 등록 제한</label><label style="display:flex;align-items:center"><input class="toggle" style="width:auto" type="checkbox" name="allow_public_sharing" ${!s.disable_public_sharing?'checked':''}> 공개 링크 공유 허용</label><label style="display:flex;align-items:center"><input class="toggle" style="width:auto" type="checkbox" name="allow_export" ${!s.disable_export?'checked':''}> 데이터 내보내기 허용</label>${field('휴지통 보존 기간 (일)','trash_retention_days','30','number',s.trash_retention_days??30)}${field('사용자 지정 도메인','custom_domain','예: home.example.com','text',s.custom_domain||'')}<button class="solid-btn">설정 저장</button></form><div class="info-box" style="margin-top:20px">로컬 워크스페이스입니다. 공유 암호를 설정하면 가족이 같은 공간에 로그인할 수 있습니다. 가족 계정에서 멤버별 이메일 로그인과 공유 권한을 설정할 수 있으며, 사용자 지정 도메인의 DNS·TLS는 직접 설정해야 합니다.</div><button class="outline-btn" style="margin-top:15px" data-action="activity">감사 로그 보기 ↗</button><button class="outline-btn" style="margin:15px 0 0 8px" data-action="logout">로그아웃</button>`;
  }
  else if(tab==='automations')content.innerHTML=header('작업에 흐름을 더하세요','항목 변경이나 예약 시각에 작업을 실행합니다. 예약은 이 서버가 실행되는 동안에만 동작합니다.',add('automations','자동화 만들기'))+items('automations',scheduleDescription);
  else if(tab==='forms')content.innerHTML=header('질문을 모아, 다음 단계로','폼을 만들고 응답을 데이터베이스에 수집하세요.',add('forms','폼 만들기'))+items('forms',i=>`${i.database_id||'연결된 데이터베이스 없음'} · ${(i.fields||[]).length}개 질문`);
  else if(tab==='sites')content.innerHTML=header('아이디어를 세상에 공유하세요','페이지를 게시용 보기로 공유합니다. 가족 로그인 모드에서는 로그인한 가족만 볼 수 있습니다.',add('sites','사이트 만들기'))+items('sites',i=>`${i.published?'게시됨':'초안'} · ${i.slug||i.page_id||''}`);
  else if(tab==='AI') {
    content.innerHTML=header('생각의 다음 한 걸음','페이지 요약, 초안 작성, 번역, 질문을 AI 도우미에서 시작하세요.')+'<button class="solid-btn" data-action="ai">✦ AI 도우미 열기</button><div class="info-box" style="margin-top:20px">무료 로컬 모델 또는 설정한 AI 서비스를 사용합니다. 외부 서비스 요금·한도는 연결 계정 정책을 따릅니다.</div><div class="section-heading" style="margin-top:28px"><h3>연결 및 통합</h3>'+add('integrations','연결 추가')+'</div>'+items('integrations',i=>`${i.provider||i.type||'사용자 정의'} · ${i.status||'연결 설정 필요'}`);
  }
  else if(tab==='analytics') {
    content.innerHTML='<div class="empty">분석을 불러오는 중…</div>';
    try {
      const d=await api('/analytics');
      if(state.settingsTab!==tab)return;
      const stats=d.stats||d;
      const primitive=Object.entries(stats).filter(([,v])=>typeof v==='number');
      content.innerHTML=header('워크스페이스의 성장 기록','현재 데이터와 활동을 바탕으로 집계한 사용 현황입니다.')+`<div class="stats-grid">${primitive.slice(0,9).map(([k,v])=>`<div class="stat"><b>${v.toLocaleString()}</b><span>${esc(({pages:'페이지',databases:'데이터베이스',rows:'데이터 항목',members:'멤버',blocks:'블록',comments:'댓글',events:'활동',forms:'폼',sites:'사이트',automations:'자동화',active_members:'활성 멤버',audit_events:'감사 기록',total_pages:'전체 페이지',total_blocks:'전체 블록',total_rows:'전체 항목'})[k]||k)}</span></div>`).join('')}</div><pre style="font-size:10px;color:#98a08b;white-space:pre-wrap">${esc(JSON.stringify(d,null,2))}</pre>`;
    }
    catch(e) {
      content.innerHTML=`<div class="empty">${esc(e.message)}</div>`;
    }
  }
  else if(tab==='features') {
    content.innerHTML='<div class="empty">기능 현황을 불러오는 중…</div>';
    try {
      const d=await api('/capabilities');
      const list=normalizeList(d.features||d.capabilities||d);
      content.innerHTML=header('기능 제공 현황','상용 플랜의 공개 기능을 참고한 독립 구현이며, 모든 구현 기능을 구독 없이 무료로 제공합니다. 외부 서비스 연동이 필요한 기능은 제공 범위를 구분합니다.')+`<table class="feature-table"><thead><tr><th>기능</th><th>제공 상태</th><th>설명</th></tr></thead><tbody>${list.map(f=>`<tr><td>${esc(f.name||f.feature||f.id)}<small class="muted" style="display:block;margin-top:5px">무료 제공 · 참고 플랜 ${esc(f.plan||'')}</small></td><td>${status(({implemented:'구현됨',partial:'일부 제공',configuration:'설정 필요',provider_required:'모델 연결 필요',service_required:'외부 서비스 필요'})[f.status]||f.status||'로컬 구현')}</td><td>${esc(f.description||f.notes||f.detail||'')}</td></tr>`).join('')}</tbody></table>${!list.length?`<pre style="white-space:pre-wrap;font-size:11px">${esc(JSON.stringify(d,null,2))}</pre>`:''}`;
    }
    catch(e) {
      content.innerHTML=esc(e.message);
    }
  }
  else if(tab==='export') {
    content.innerHTML=header('데이터는 언제나 내 손에','문서를 내보내거나 댓글·이력·설정을 포함한 전체 백업을 다운로드하세요.')+'<button class="solid-btn" data-action="backup">전체 백업 다운로드</button><div class="form-actions" style="justify-content:flex-start"><button class="outline-btn" data-action="export" data-format="json">문서·DB JSON</button><button class="outline-btn" data-action="export" data-format="markdown">Markdown</button><button class="outline-btn" data-action="export" data-format="csv">CSV</button></div><form class="form-grid" id="import-form" style="margin-top:25px"><label>가져올 형식<select name="format"><option value="markdown">Markdown</option><option value="csv">CSV</option><option value="json">JSON 백업</option></select></label>'+field('제목','title','가져온 문서')+'<label>내용<textarea name="content" required placeholder="파일 내용을 여기에 붙여넣으세요"></textarea></label><button class="solid-btn">가져오기</button></form>';
  }
}
async function renderScimSettings(content) {
  if(!isOwner()){content.textContent='소유자만 SCIM 토큰을 관리할 수 있습니다.';return;}
  const scope={binding:state.session?.cache_binding,member:state.session?.member?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,epoch:FountainTransport.scopeEpoch};
  const current=()=>content.isConnected&&$('#settings-content')===content&&state.settingsTab==='scim'&&isOwner()&&!state.offline&&!state.nativeRecoveryPaused&&scope.workspace===state.workspace?.workspace_id&&scope.binding===state.session?.cache_binding&&scope.member===state.session?.member?.id&&scope.boot===state.bootGeneration&&scope.epoch===FountainTransport.scopeEpoch;
  const panel=createScimView({request:api,current,newId:uid,changed:()=>renderScimPanel(content,panel),disposed:()=>{for(const input of $$('#scim-secret,#scim-proof',content))input.value='';}});scimPanel=panel;
  renderScimPanel(content,panel);await panel.load();
}
function renderScimPanel(content,panel) {
  if(scimPanel!==panel)return;
  const view=panel.snapshot(),selected=view.selected,when=value=>value?new Date(value).toLocaleString('ko-KR'):'없음';
  const pending=selected&&scimGrantStatus(selected)==='활성화 대기';
  content.innerHTML=`<h3>SCIM 계정 연동</h3><p>외부 인증 서비스에서 멤버와 그룹을 관리할 때 사용하는 소유자 전용 토큰입니다. 연동 서비스를 별도로 설정해야 하며, 기존 가족 로그인은 그대로 사용할 수 있습니다.</p><div class="info-box">토큰은 발급 직후 한 번만 표시됩니다. 안전하게 보관한 뒤 15분 안에 명시적으로 활성화하세요. 이 화면을 닫거나 다른 설정으로 이동하면 표시된 토큰을 지웁니다. 철회는 영구적입니다.</div>${view.error?`<p role="alert">${esc(view.error)}</p>`:''}<div class="form-actions" style="justify-content:flex-start"><button class="outline-btn" data-action="scim-refresh" ${view.busy?'disabled':''}>목록 새로고침</button></div>${view.available?`<section aria-label="SCIM 토큰 발급"><label>만료 시각 · 선택<input id="scim-expiry" type="datetime-local" ${view.creation||view.selected||view.busy?'disabled':''}></label><button class="solid-btn" data-action="scim-issue" ${view.busy||selected?'disabled':''}>${view.creation?'같은 발급 요청 다시 확인':'새 토큰 발급'}</button>${view.creation?`<p>응답 확인 중인 발급 ID: ${esc(view.creation.transaction_id)}. 다른 발급으로 바꾸지 않고 같은 요청을 확인합니다.</p>`:''}</section>`:''}${selected?`<section aria-label="선택한 SCIM 토큰"><h4>${esc(selected.id)}</h4><p>${esc(scimGrantStatus(selected))} · 만료 ${esc(when(selected.expires_at))}</p>${view.hasSecret?'<label>이번에만 표시되는 토큰<input id="scim-secret" type="text" readonly autocomplete="off" spellcheck="false" aria-label="이번에만 표시되는 SCIM 토큰"></label>':''}${pending?`${!view.hasSecret?'<label>발급 시 보관한 토큰<input id="scim-proof" type="password" autocomplete="off" spellcheck="false" maxlength="43"></label>':''}<p>활성화 기한: ${esc(when(selected.pending_until))}. 발급한 소유자만 활성화할 수 있습니다.</p><label class="checkbox-label"><input id="scim-ack" type="checkbox">토큰을 보관했으며 이 토큰으로 계정 연동을 허용합니다.</label><button class="solid-btn" data-action="scim-activate" ${view.busy?'disabled':''}>활성화</button>`:''}${scimGrantStatus(selected)==='철회됨'?'<button class="outline-btn" data-action="scim-new">새 토큰 발급으로 돌아가기</button>':''}</section>`:''}<div class="settings-list" aria-label="SCIM 토큰 목록">${view.tokens.map(grant=>`<div class="settings-item"><div><strong>${esc(grant.id)}</strong><small>${esc(scimGrantStatus(grant))} · 발급 ${esc(when(grant.created_at))}<br>발급자 ${esc(grant.issuer_member_id)} · 만료 ${esc(when(grant.expires_at))}</small></div><div>${scimGrantStatus(grant)==='활성화 대기'?`<button data-action="scim-select" data-id="${esc(grant.id)}" ${view.busy?'disabled':''}>활성화 준비</button>`:''}${scimGrantStatus(grant)!=='철회됨'?`<button data-action="scim-revoke" data-id="${esc(grant.id)}" ${view.busy?'disabled':''}>${view.confirmation===grant.id?'영구 철회 확인':'철회'}</button>`:''}</div></div>`).join('')||'<p>발급된 토큰이 없습니다.</p>'}</div>${view.cursor?`<button class="outline-btn" data-action="scim-more" ${view.busy?'disabled':''}>다음 50개</button>`:''}${view.busy?'<p role="status">요청을 확인하는 중…</p>':''}`;
  const input=$('#scim-secret',content);if(input)input.value=panel.secret()||'';
}
async function scimAction(action,id) {
  if(!isOwner()||state.offline)throw new Error('온라인 소유자만 SCIM 토큰을 관리할 수 있습니다.');
  const panel=scimPanel;if(!panel)return;
  if(action==='scim-refresh')await panel.load();
  else if(action==='scim-more')await panel.load(true);
  else if(action==='scim-select')panel.select(id);
  else if(action==='scim-new')panel.restart();
  else if(action==='scim-issue'){const value=$('#scim-expiry')?.value;await panel.issue(value?new Date(value).toISOString():null);}
  else if(action==='scim-activate'){const proof=$('#scim-proof'),token=proof?.value||'',ack=$('#scim-ack')?.checked===true;if(proof)proof.value='';await panel.activate(token,ack);}
  else if(action==='scim-revoke')await panel.revoke(id);
}
function zonedParts(value,timezone) {
  try {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
    return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  } catch { throw new Error('올바른 시간대를 입력하세요. 예: Asia/Seoul'); }
}
function zonedInput(value,timezone) {
  const parts=zonedParts(value,timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
function scheduleInstant(value,timezone) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))throw new Error('예약 시작 시각을 입력하세요.');
  const desired=Date.parse(value+(value.length===16?':00':'')+'Z');
  if(!Number.isFinite(desired))throw new Error('올바른 예약 시작 시각을 입력하세요.');
  let instant=desired;
  for(let i=0;i<4;i++){
    const parts=zonedParts(instant,timezone),shown=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const next=instant+desired-shown;if(next===instant)break;instant=next;
  }
  if(zonedInput(instant,timezone)!==value+(value.length===16?':00':''))throw new Error('이 시간대에 존재하지 않는 시각입니다. 다른 시각을 선택하세요.');
  return new Date(instant).toISOString();
}
function scheduleDescription(automation) {
  if(automation.trigger!=='scheduled')return `${automation.enabled===false?'일시 중지':'사용'} · ${{manual:'직접 실행','row.created':'항목 생성 시','row.updated':'항목 수정 시'}[automation.trigger]||automation.trigger||'직접 실행'}`;
  const period={minutes:'분',hours:'시간',days:'일',weeks:'주',months:'개월',years:'년'}[automation.schedule?.frequency]||'';
  return `${automation.schedule_status==='completed'?'예약 완료':automation.enabled===false?'일시 중지':'예약 사용'} · ${automation.schedule?.interval||1}${period}마다 · ${automation.schedule?.timezone||'시간대 미설정'}`;
}
function automationScheduleFields(item) {
  const schedule=item.schedule||{},timezone=schedule.timezone||'Asia/Seoul';
  const start=schedule.start_at||new Date(Date.now()+60_000).toISOString();
  return `<div id="automation-schedule-fields" class="schedule-fields" style="display:${item.trigger==='scheduled'?'grid':'none'}"><div class="schedule-period"><label>반복 간격<input name="schedule_interval" type="number" min="1" max="365" step="1" value="${esc(schedule.interval||1)}"></label><label>반복 단위<select name="schedule_frequency">${[['minutes','분'],['hours','시간'],['days','일'],['weeks','주'],['months','개월'],['years','년']].map(([value,label])=>`<option value="${value}" ${schedule.frequency===value?'selected':''}>${label}</option>`).join('')}</select></label></div><label>시간대<input name="schedule_timezone" value="${esc(timezone)}" placeholder="Asia/Seoul"></label><label>첫 실행 시각<input name="schedule_start_at" type="datetime-local" step="1" value="${esc(zonedInput(start,timezone))}"></label><label>마지막 실행 허용 시각 (선택)<input name="schedule_end_at" type="datetime-local" step="1" value="${esc(schedule.end_at?zonedInput(schedule.end_at,timezone):'')}"></label><div class="info-box">이 서버가 실행 중일 때 예약된 작업을 실행합니다. 서버가 꺼져 있는 동안에는 실행되지 않으며 클라우드 실행을 제공하지 않습니다.</div></div>`;
}
function updateScheduleFields() {
  const section=$('#automation-schedule-fields'),trigger=$('#advanced-form [name="trigger"]');
  if(!section||!trigger)return;
  const scheduled=trigger.value==='scheduled';section.style.display=scheduled?'grid':'none';
  $$('input,select',section).forEach(input=>input.disabled=!scheduled);
}
async function loadAutomationRows(databaseId,selectedId='') {
  const select=$('#automation-row');if(!select)return;
  const sequence=(state.automationRowRequest||0)+1;state.automationRowRequest=sequence;select.disabled=true;
  try {
    const data=await api('/databases/'+encodeURIComponent(databaseId));
    if(!select.isConnected||sequence!==state.automationRowRequest)return;
    select.innerHTML='<option value="">대상 항목 없음</option>'+data.rows.map(row=>`<option value="${esc(row.id)}" ${row.id===selectedId?'selected':''}>${esc(nameOf(row,data.database))}</option>`).join('');
  } finally {if(select.isConnected&&sequence===state.automationRowRequest)select.disabled=false;}
}
async function openAutomationRuns(id) {
  const automation=state.advanced?.automations?.find(item=>item.id===id),timezone=automation?.schedule?.timezone||'Asia/Seoul';
  openModal('예약 실행 기록',`<div id="automation-runs" data-id="${esc(id)}"><div class="empty">실행 기록을 불러오는 중…</div></div>`);
  const data=await api('/automations/'+encodeURIComponent(id)+'/runs');
  const content=$('#automation-runs');if(!content||content.dataset.id!==id)return;
  const when=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:timezone}):'—';
  const statusName={succeeded:'성공',success:'성공',completed:'완료',failed:'실패',running:'실행 중',skipped:'건너뜀'};
  content.innerHTML=`<p>${esc(automation?.name||'자동화')} · ${esc(timezone)}</p>${(data.runs||[]).map(run=>`<article class="automation-run"><div><strong>${esc(statusName[run.status]||run.status)}</strong><span class="muted">${esc(when(run.scheduled_at))}</span></div><small>시작 ${esc(when(run.started_at))}<br>종료 ${esc(when(run.finished_at))}</small>${run.error?`<small class="run-error">${esc(run.error)}</small>`:''}</article>`).join('')||'<div class="empty">아직 예약 실행 기록이 없습니다. 예약이 사용 상태이고 서버가 실행 중인지 확인하세요.</div>'}<div class="form-actions"><button class="outline-btn" data-action="automation-runs" data-id="${esc(id)}">새로고침</button><button class="outline-btn" data-action="automation-settings">자동화 목록</button></div>`;
}
async function openManualAutomation(id) {
  const automation=state.advanced?.automations?.find(item=>item.id===id);
  if(!automation)throw new Error('자동화를 찾을 수 없습니다.');
  const data=await api('/databases/'+encodeURIComponent(automation.database_id));
  openModal('자동화 직접 실행',`<p>한 번 실행합니다. 예약 주기는 변경하지 않습니다. 속성 변경 작업은 대상 항목을 선택하세요.</p><form id="run-automation-form" data-id="${esc(id)}" class="form-grid"><label>대상 항목<select name="row_id"><option value="">대상 항목 없음</option>${data.rows.map(row=>`<option value="${esc(row.id)}" ${row.id===automation.row_id?'selected':''}>${esc(nameOf(row,data.database))}</option>`).join('')}</select></label><button class="solid-btn">한 번 실행하기</button></form>`);
}

function advancedForm(kind,id) {
  const item=(state.advanced?.[kind]||[]).find(i=>i.id===id)|| {
  };
  if(kind==='members'&&!isOwner()&&['owner','admin'].includes(item.role)){toast('소유자만 소유자와 멤버십 관리자를 관리할 수 있습니다.');return;}
  let content='';
  const pages=state.workspace.pages.filter(p=>!p.archived);
  const dbs=state.workspace.databases;
  const select=(label,name,options,value)=>`<label>${label}<select name="${name}">${options.map(([v,n])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(n)}</option>`).join('')}</select></label>`;
  const checkbox=(label,name,checked)=>`<label style="display:flex;align-items:center"><input type="checkbox" style="width:auto" name="${name}" ${checked?'checked':''}>${label}</label>`;
  const nameField=field('이름','name','이름을 입력하세요','text',item.name||'');
  if(kind==='members')content=nameField+field('이메일','email','name@company.com','email',item.email||'')+select('역할','role',isOwner()?[['owner','소유자'],['member','멤버'],['admin','멤버십 관리자'],['guest','게스트']]:[['member','멤버'],['guest','게스트']],item.role||'member')+'<div class="info-box">워크스페이스의 로컬 멤버를 등록합니다. 초대 이메일은 자동 발송하지 않습니다. 소유자가 가족 계정에서 각 멤버의 로그인 비밀번호를 설정할 수 있습니다.</div>';
  else if(kind==='groups')content=nameField+`<label>그룹 멤버<select name="members" multiple style="min-height:100px">${(state.advanced.members||[]).map(m=>`<option value="${esc(m.id)}" ${(item.members||[]).includes(m.id)?'selected':''}>${esc(m.name||m.email)}</option>`).join('')}</select></label>`;
  else if(kind==='teamspaces')content=nameField+select('접근 범위','visibility',[['open','열린 팀스페이스'],['closed','비공개 팀스페이스'],['private','초대한 멤버 전용']],item.visibility||'open');
  else if(kind==='sites')content=nameField+select('게시할 페이지','page_id',pages.map(p=>[p.id,p.title]),item.page_id||pages[0]?.id)+field('사이트 주소','slug','our-team','text',item.slug||'')+field('검색 결과 제목','seo_title','사이트 제목','text',item.seo_title||'')+field('설명','description','페이지를 소개해 주세요','text',item.description||'')+checkbox('공개 사이트로 게시','published',!!item.published)+'<div class="info-box">게시하면 링크를 가진 누구나 페이지 내용을 열람할 수 있습니다.</div>';
  else if(kind==='forms')content=nameField+select('응답을 저장할 데이터베이스','database_id',dbs.map(d=>[d.id,d.name||d.title]),item.database_id||dbs[0]?.id)+`<label>질문 (JSON)<textarea name="fields" spellcheck="false" required>${esc(JSON.stringify(item.fields||[{id:'name',label:'프로젝트 이름',type:'text',required:true,property_id:'name'},{id:'status',label:'진행 상태',type:'select',property_id:'status',options:['시작 전','진행 중','완료']}],null,2))}</textarea></label>`+checkbox('폼 공개 및 응답 허용','published',!!item.published)+'<div class="info-box">각 질문의 property_id는 연결된 데이터베이스의 속성 ID와 같아야 합니다. 질문에 condition: {field, equals}를 추가하면 조건부로 표시됩니다.</div>';
  else if(kind==='automations')content=nameField+select('데이터베이스','database_id',dbs.map(d=>[d.id,d.name||d.title]),item.database_id||dbs[0]?.id)+select('실행 조건','trigger',[['manual','직접 실행'],['row.created','항목을 만들었을 때'],['row.updated','항목을 수정했을 때'],['scheduled','일정에 따라 반복']],item.trigger||'manual')+automationScheduleFields(item)+`<label>속성을 변경할 대상 항목<select name="row_id" id="automation-row"><option value="">대상 항목 없음</option></select><small class="muted">속성 변경 작업에 사용합니다. 새 항목이나 페이지 생성 작업은 비워둘 수 있습니다.</small></label><label>실행할 작업 (JSON)<textarea name="actions" required spellcheck="false">${esc(JSON.stringify(item.actions||[{type:'set_property',property_id:'status',value:'완료'}],null,2))}</textarea></label>`+checkbox('자동화 사용','enabled',item.enabled!==false);
  else if(kind==='integrations')content=nameField+select('제공자','provider',[['webhook','Webhook'],['slack','Slack'],['github','GitHub'],['google_drive','Google Drive'],['custom','사용자 정의']],item.provider||'webhook')+field('연결 URL','url','https://…','url',item.url||'')+'<div class="info-box">연결 메타데이터를 등록합니다. 실제 동기화와 OAuth 인증은 공급자 연결이 필요합니다.</div>';
  openModal(`${id?'관리':'새로 만들기'} · ${{members:'멤버',groups:'그룹',teamspaces:'팀스페이스',forms:'폼',sites:'사이트',automations:'자동화',integrations:'연결'}[kind]||kind}`,`<form id="advanced-form" data-kind="${kind}" data-id="${esc(id||'')}" class="form-grid">${content}<div class="form-actions"><button type="button" class="outline-btn" data-action="settings">설정으로 돌아가기</button><button class="solid-btn">저장하기</button></div></form>`,'database-row-modal');
  if(kind==='automations')updateScheduleFields();
  if(kind==='automations')loadAutomationRows(item.database_id||dbs[0]?.id,item.row_id||'').catch(error=>toast(error.message));
}
async function showAI() {
  openModal('✦ Fountain AI',`<p>아이디어의 시작부터 문서의 마무리까지, AI와 함께해 보세요.</p><form class="form-grid" id="ai-form"><label>작업<select name="action"><option value="summarize">페이지 요약</option><option value="write">초안 작성</option><option value="translate">번역</option><option value="answer">워크스페이스 질문</option></select></label><label>요청<textarea name="prompt" placeholder="어떤 도움이 필요한가요? 예: 이 문서를 세 문장으로 요약해 주세요."></textarea></label><button class="solid-btn">✦ 실행하기</button></form><div id="ai-output" aria-live="polite"></div><div class="info-box" style="margin-top:20px">공급자 연결 상태에 따라 실행 가능한 작업이 달라집니다. 민감한 정보는 전송 전에 확인하세요.</div>`);
}
function download(filename,content,mime='text/plain') {
  if(FountainTransport.native){FountainTransport.saveData(filename,content,mime).catch(error=>{if(error.name!=='AbortError')toast(error.message);});return;}
  const url=URL.createObjectURL(new Blob([content], {
    type:mime
  }));
  const a=document.createElement('a');
  a.href=url;
  a.download=filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function saveTitle() {
  if(state.nativeOutboxPause||state.nativeRecoveryPreparing||state.nativeRecoveryPaused)return;
  if (state.titleSaving) await state.titleSaving;
  if(state.nativeOutboxPause||state.nativeRecoveryPreparing||state.nativeRecoveryPaused)return;
  clearTimeout(state.titleTimer);
  const pending = state.titlePending;
  if (!pending) return;
  state.titlePending = null;
  state.titleSavingInput=pending;
  const binding=state.session?.cache_binding,profileId=state.offlineProfile?.id;
  state.titleSaving = (async () => {
    try {
      if (state.page?.id === pending.id) await updatePage({title:pending.title},pending.basePage);
      else if(state.mutations){await state.mutations.patchPage(pending.id,{title:pending.title},{basePage:pending.basePage});if(!state.offline)await syncMutations();}else await api('/pages/' + pending.id, {title:pending.title}, 'PATCH');
    } catch (error) {
      if(binding===state.session?.cache_binding&&profileId===state.offlineProfile?.id&&!state.authSuspending)state.titlePending ||= pending;
      throw error;
    }
  })();
  try { await state.titleSaving; }
  finally { state.titleSaving = null;if(state.titleSavingInput===pending)state.titleSavingInput=null; }
}
async function updatePage(patch,basePage=structuredClone(state.pageViewBasis||state.page)) {
  const scope={pageId:state.page?.id,controller:state.mutations,profileId:state.offlineProfile?.id,binding:state.session?.cache_binding};
  await savePage();
  if(state.nativeRecoveryPaused||scope.pageId!==state.page?.id||scope.controller!==state.mutations||scope.profileId!==state.offlineProfile?.id||scope.binding!==state.session?.cache_binding){const error=new Error('문서나 로그인 상태가 바뀌었습니다. 다시 확인해 주세요.');error.code='STALE_REQUEST';throw error;}
  const id = scope.pageId;
  const queued=state.mutations&&Object.keys(patch).every(key=>['title','icon','cover','favorite'].includes(key));
  const p=queued?await state.mutations.patchPage(id,patch,{basePage}):await api('/pages/'+id,{...patch,revision:state.page.revision},'PATCH');
  if(queued){state.mutationRecords=await state.mutations.records();if(!state.offline)await syncMutations();}
  if (state.page?.id !== id) return;
  if(queued&&state.channel?.pageId===id){const cached=await FountainOffline.getSnapshot(FountainOffline.key(state.offlineProfile,id));if(state.page?.id!==id)return;if(cached&&!state.localPageOnly)await state.channel.receive(cached,'metadata');}
  state.page=metadataOverlay(queued&&state.channel?.pageId===id?{...state.channel.base.page,access_level:state.channel.base.access_level}:(p.page||p));
  if(!queued&&state.channel?.pageId===id){const snapshot=await api('/pages/'+id+'/collaboration');await state.channel.receive(snapshot,'metadata');}
  const index=state.workspace.pages.findIndex(p=>p.id===state.page.id);
  if(index>=0)state.workspace.pages[index]=state.page;
  renderSidebar();
  renderTopbar(state.page.title,state.page.icon);
}
function verificationMembers() {
  const members=(state.workspace?.members||[]).filter(member=>member.active!==false&&typeof member.id==='string'&&member.id);
  const self=state.session?.member;
  if(self?.id&&!members.some(member=>member.id===self.id)&&self.active!==false)members.push(self);
  return members;
}
function verificationOwners(value) {return Array.isArray(value?.owners)?value.owners:typeof value?.owner==='string'?[value.owner]:[];}
function verificationDate(value) {return new Date(value).toLocaleString('ko-KR',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function verificationTimestamp(value) {
  if(typeof value!=='string')return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if(!match)return false;const [year,month,day,hour,minute,second,offsetHour=0,offsetMinute=0]=match.slice(1).map(part=>Number(part||0));
  return year>=1000&&month>=1&&month<=12&&day>=1&&day<=new Date(year,month,0).getDate()&&hour<=23&&minute<=59&&second<=59&&offsetHour<=23&&offsetMinute<=59&&Number.isFinite(Date.parse(value));
}
function verificationSummary() {
  const value=state.page?.verification,ownerShape=Array.isArray(value?.owners)?value.owners.every(id=>typeof id==='string'&&id.length>0):Object.hasOwn(value||{},'owner')&&(value.owner===null||typeof value.owner==='string'&&value.owner.length>0),valid=!!value&&typeof value==='object'&&!Array.isArray(value)&&ownerShape&&verificationTimestamp(value.verified_at)&&(value.expires_at==null||verificationTimestamp(value.expires_at)),expired=valid&&value.expires_at!=null&&Date.parse(value.expires_at)<=Date.now();
  const names=verificationOwners(value).map(id=>verificationMembers().find(member=>member.id===id)?.name).filter(Boolean);
  return {value,valid,expired,label:value==null?'검증 미설정':!valid?'검증 상태 확인 필요':expired?'검증 만료':'검증됨',names};
}
function renderVerificationStatus() {
  clearTimeout(state.verificationTimer);state.verificationTimer=null;
  const element=$('#page-verification-status');if(state.route!=='page'||!state.page||!element)return;
  const {value,valid,expired,label,names}=verificationSummary();
  element.innerHTML=`<span class="verification-badge ${valid&&!expired?'verified':''}">${valid&&!expired?'✓ ':''}${label}</span>${names.length?`<span>${names.map(esc).join(', ')}</span>`:value?'<span>담당자 정보 비공개</span>':''}${valid?`<span>확인 <time datetime="${esc(value.verified_at)}">${esc(verificationDate(value.verified_at))}</time> · ${value.expires_at?`<time datetime="${esc(value.expires_at)}">${esc(verificationDate(value.expires_at))}</time> 만료`:'만료 없음'}</span>`:''}${pageEditable()&&wikiVerificationAllowed()&&!state.offline&&!state.localPageOnly?'<button class="text-btn" data-action="verify-page">검증 설정</button>':''}`;
  const page=state.page.id,binding=state.session?.cache_binding,boot=state.bootGeneration;
  if(valid&&value.expires_at&&!expired){const remaining=Date.parse(value.expires_at)-Date.now();state.verificationTimer=setTimeout(()=>{if(state.route==='page'&&state.page?.id===page&&state.session?.cache_binding===binding&&state.bootGeneration===boot)renderVerificationStatus();},Math.min(60000,Math.max(1,remaining)));}
}
function verificationLocalTime(value) {
  const time=new Date(value);if(!Number.isFinite(time.getTime()))return '';
  const pad=number=>String(number).padStart(2,'0');
  return `${time.getFullYear()}-${pad(time.getMonth()+1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}
function verificationExpiry(value) {
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if(!match)throw new Error('만료 날짜와 시간을 입력해 주세요.');
  const [year,month,day,hour,minute,second]=match.slice(1).map(part=>Number(part||0)),time=new Date(year,month-1,day,hour,minute,second);
  if(year<1000||year>9998||time.getFullYear()!==year||time.getMonth()!==month-1||time.getDate()!==day||time.getHours()!==hour||time.getMinutes()!==minute||time.getSeconds()!==second)throw new Error('기기 시간대에 존재하는 날짜와 시간을 입력해 주세요.');
  if(time.getTime()<=Date.now())throw new Error('만료일은 현재보다 나중이어야 합니다.');
  return time.toISOString();
}
function verificationScopeCurrent(view) {
  const scope=view?.scope;
  return !!scope&&state.verificationView===view&&view.modal?.isConnected&&$('.verification-modal')===view.modal&&state.route==='page'&&state.page?.id===scope.pageId&&state.channel===scope.channel&&scope.channel.pageId===scope.pageId&&!scope.channel.closed&&scope.channel.base?.epoch===scope.epoch&&pageEditable()&&!state.offline&&!state.localPageOnly&&!state.nativeRecoveryPaused&&!state.nativeOutboxPause&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.member&&state.session?.member?.role===scope.role&&state.offlineProfile?.id===scope.profile&&state.workspace?.workspace_id===scope.workspace&&state.bootGeneration===scope.boot&&FountainTransport.scopeEpoch===scope.transportEpoch;
}
function invalidateVerificationView() {
  const view=state.verificationView;if(!view||verificationScopeCurrent(view)&&(state.wikiPage?.kind==='checking'||wikiVerificationAllowed()))return;
  if(view.modal?.isConnected){$('#verification-error',view.modal).textContent='문서나 로그인 상태가 변경되었습니다. 입력을 확인한 뒤 취소하고 다시 열어 주세요.';for(const control of $('#verification-form',view.modal).elements)if(control.dataset.action!=='close-modal')control.disabled=true;}
}
async function verificationModal() {
  const initial=wikiScope(),overlay=$('#overlay-root').firstChild;await syncWikiPage();if(!wikiScopeCurrent(initial)||$('#overlay-root').firstChild!==overlay)return;if(!wikiVerificationAllowed())throw new Error('현재 지식 담당자와 편집 권한을 확인한 뒤 검증할 수 있습니다.');
  if(state.route!=='page'||!state.channel||!pageEditable()||state.offline||state.localPageOnly)throw new Error('연결된 페이지의 편집 권한이 필요합니다.');
  if(!Number.isSafeInteger(state.page.revision)||state.page.revision<0)throw new Error('페이지를 다시 열어 최신 버전을 확인해 주세요.');
  const scope={pageId:state.page.id,channel:state.channel,epoch:state.channel.base?.epoch,binding:state.session?.cache_binding,member:state.session?.member?.id,role:state.session?.member?.role,profile:state.offlineProfile?.id,workspace:state.workspace?.workspace_id,boot:state.bootGeneration,transportEpoch:FountainTransport.scopeEpoch};
  const wiki=state.wikiPage?.info,members=wiki?.in_wiki?[wiki.owner].filter(Boolean):verificationMembers();
  const {value,valid,label}=verificationSummary(),selected=verificationOwners(value).filter(id=>members.some(member=>member.id===id)),owners=selected.length?selected:[scope.member],expiry=valid?value.expires_at||null:null,initialTime=expiry?verificationLocalTime(expiry):'';
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'기기 시간대';
  openModal('페이지 검증',`<form id="verification-form" class="form-grid" novalidate><p class="muted">담당자가 내용을 확인한 페이지임을 표시합니다. 담당자 지정으로 문서 접근 권한이 추가되지 않습니다.</p><div class="verification-current"><strong>${esc(label)}</strong>${valid?`<span>확인 ${esc(verificationDate(value.verified_at))}</span>`:''}</div><fieldset class="verification-owners"><legend>${wiki?.in_wiki?'검증 담당자 · 현재 지식 담당자':'검증 담당자 · 한 명 이상'}</legend>${members.map(member=>`<label><input type="checkbox" name="owners" value="${esc(member.id)}" ${owners.includes(member.id)?'checked':''}><span>${esc(member.name||'이름 없는 멤버')}${member.id===scope.member?' (나)':''}</span></label>`).join('')||'<p>선택할 수 있는 활성 멤버가 없습니다.</p>'}</fieldset><label>검증 유효 기간<select name="expiry_mode"><option value="infinite" ${!expiry?'selected':''}>만료 없음</option><option value="finite" ${expiry?'selected':''}>만료일 지정</option></select></label><label id="verification-expiry-label" ${!expiry?'hidden':''}>만료 날짜와 시간<input name="expires" type="datetime-local" step="1" value="${esc(initialTime)}"><small class="muted">기기 시간대: ${esc(zone)}</small></label><div id="verification-error" role="alert" aria-live="assertive"></div><div class="form-actions">${value!=null?'<button type="button" class="danger-btn" data-action="remove-verification">검증 해제</button>':''}<button type="button" class="outline-btn" data-action="close-modal">취소</button><button type="submit" class="solid-btn">검증 저장</button></div></form>`,'verification-modal');
  const modal=$('.verification-modal'),view={scope,modal,revision:state.page.revision,expiry,initialTime:$('[name="expires"]',modal).value,busy:false};state.verificationView=view;
  $('[name="expiry_mode"]',modal).onchange=event=>{$('#verification-expiry-label',modal).hidden=event.target.value!=='finite';};
  modal.onkeydown=event=>{
    if(event.key!=='Tab')return;
    const controls=$$('button,input,select',modal).filter(control=>!control.disabled&&control.getClientRects().length),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };
}
async function saveVerification(remove) {
  const view=state.verificationView;if(view?.busy)return;if(!verificationScopeCurrent(view)||!wikiVerificationAllowed()){invalidateVerificationView();return;}
  const form=$('#verification-form',view.modal),error=$('#verification-error',view.modal);
  const current=()=>verificationScopeCurrent(view);
  try{
    const owners=$$('[name="owners"]:checked',form).map(input=>input.value);
    if(!remove&&!owners.length)throw new Error('검증 담당자를 한 명 이상 선택해 주세요.');
    const finite=$('[name="expiry_mode"]',form).value==='finite',local=$('[name="expires"]',form).value;
    let expires=null;
    if(!remove&&finite){if(local===view.initialTime&&view.expiry){if(Date.parse(view.expiry)<=Date.now())throw new Error('만료일은 현재보다 나중이어야 합니다.');expires=view.expiry;}else expires=verificationExpiry(local);}
    view.busy=true;error.textContent='';for(const control of form.elements)control.disabled=true;form.setAttribute('aria-busy','true');
    if(!current())return;await saveTitle();if(!current())return;
    await savePage();if(!current())return;
    await syncWikiPage();if(!current())return;if(!wikiVerificationAllowed())throw new Error('현재 지식 담당자와 편집 권한을 다시 확인해 주세요.');
    if(state.page.revision!==view.revision)throw new Error('페이지가 설정을 연 뒤 변경되었습니다. 입력을 확인한 뒤 취소하고 검증 설정을 다시 열어 주세요.');
    await api('/pages/'+encodeURIComponent(view.scope.pageId)+'/verify',remove?{revision:view.revision}:{owners,expires_at:expires,revision:view.revision},remove?'DELETE':'POST',{current});
    if(!current())return;
    const snapshot=await api('/pages/'+encodeURIComponent(view.scope.pageId)+'/collaboration',undefined,'GET',{current});if(!current())return;
    await view.scope.channel.receive(snapshot,'verification');if(!current())return;
    closeModal();renderVerificationStatus();toast(remove?'검증을 해제했습니다.':'페이지를 검증했습니다.');
  }catch(failure){if(current())error.textContent=failure.status===409?'페이지가 설정을 연 뒤 변경되었습니다. 입력은 유지됩니다. 취소하고 최신 페이지에서 다시 설정해 주세요.':failure.message;}
  finally{if(current()){view.busy=false;for(const control of form.elements)control.disabled=false;form.removeAttribute('aria-busy');}}
}
function versionScopeCurrent(view) {
  const scope=view?.scope;
  return !!scope&&state.versionView===view&&view.modal?.isConnected&&$('.version-modal')===view.modal&&state.route==='page'&&state.page?.id===scope.pageId&&state.channel===scope.channel&&scope.channel.pageId===scope.pageId&&!scope.channel.closed&&scope.channel.base?.epoch===scope.epoch&&resourceLevel(state.page)>=3&&!state.page.archived&&!state.offline&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.memberId&&state.offlineProfile?.id===scope.profileId&&state.workspace?.workspace_id===scope.workspaceId;
}
function invalidateVersionView() {
  const view=state.versionView;if(!view)return;
  if(!versionScopeCurrent(view)){state.versionView=null;if(view.modal?.isConnected)closeModal();}
  else if(view.ready&&(view.locked!==!!state.page.locked||view.level!==resourceLevel(state.page))){view.locked=!!state.page.locked;view.level=resourceLevel(state.page);renderVersionComparison(view);}
}
function versionRuns(diff,side) {
  return (diff?.runs||[]).filter(run=>run.type!==(side==='before'?'insert':'delete')).map(run=>run.type==='equal'?esc(run.text):`<${run.type==='delete'?'del':'ins'}>${esc(run.text)}</${run.type==='delete'?'del':'ins'}>`).join('');
}
function versionAttributes(block) {
  if(!block)return '';
  const labels=[blockTypes.find(([type])=>type===block.type)?.[1]||({file:'파일',image:'이미지'})[block.type]||'텍스트'];
  if(block.type==='todo')labels.push(block.checked?'완료':'진행 중');
  if(block.language)labels.push(block.language);
  const marks=new Set();for(const token of block.rich_text||[])for(const [name,value] of Object.entries(token.marks||{}))if(value&&value!=='default')marks.add(({bold:'굵게',italic:'기울임',underline:'밑줄',strike:'취소선',code:'인라인 코드',link:'링크',color:'글자색',background:'배경색'})[name]||'서식');
  return [...labels,...marks].map(esc).join(' · ');
}
function versionBlockHTML(block,change,side,items) {
  if(!block)return '<div class="version-block version-block-missing">이 버전에는 없는 블록</div>';
  const flags=[change.added?'추가':null,change.removed?'삭제':null,change.moved?'이동':null,change.textChanged?'글 변경':null,change.attributesChanged?'서식·속성 변경':null].filter(Boolean);
  const index=items.findIndex(item=>item.id===block.id)+1;
  let text=change.textChanged||change.added||change.removed?versionRuns(change.textDiff,side):richTextHTML(block).replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g,'<span class="rich-link">$1</span>');
  if(block.type==='file')text=`<span class="version-file">📎 ${esc(block.text||'첨부 파일')} <small>${Number.isFinite(block.size)?esc(sizeLabel(block.size)):''}</small></span>`;
  else if(block.type==='divider')text='<hr>';
  else if(block.type==='todo')text=(block.checked?'☑ ':'☐ ')+text;
  return `<section class="version-block ${flags.length?'version-block-changed':''} version-type-${esc(block.type||'paragraph')}" data-preview-id="${esc(block.id)}" data-preview-side="${side}"><div class="version-block-meta"><span>${index}번째${block.parent_id?' · 하위 블록':''} · ${versionAttributes(block)}</span>${flags.length?`<span class="version-change-tags">${flags.map(esc).join(' · ')}</span>`:''}</div><div class="version-block-text">${text||'<span class="muted">빈 블록</span>'}</div></section>`;
}
function renderVersionComparison(view) {
  if(!versionScopeCurrent(view)||!view.ready)return;
  const selected=view.versions.find(version=>version.id===view.selectedId),body=$('.modal-body',view.modal);
  const canRestore=resourceLevel(state.page)>=4&&!state.page.locked&&!view.restoreBlocked;
  const list=`<nav class="version-list" aria-label="저장된 버전">${view.versions.map(version=>`<button class="version-choice ${version.id===view.selectedId?'selected':''}" data-action="select-version" data-id="${esc(version.id)}" aria-pressed="${version.id===view.selectedId}"><strong>버전 ${esc(version.revision??'')}</strong><small>${esc(date(version.created_at))}</small><span>${esc(version.title||'제목 없음')}</span></button>`).join('')}</nav>`;
  if(!selected){body.innerHTML='<p>현재 서버 내용과 저장된 버전을 읽기 전용으로 비교합니다.</p><div class="empty">아직 저장된 이전 버전이 없습니다.</div>';return;}
  const previous={title:selected.title||'',blocks:selected.blocks||[]},diff=FountainVersionDiff.compareVersions(previous,view.current);
  const labels={added:'블록 추가',removed:'블록 삭제',moved:'이동',textChanged:'글 변경',attributesChanged:'서식·속성'};
  const summary=Object.entries(diff.summary).filter(([,count])=>count).map(([name,count])=>`<span>${esc(labels[name]||name)} ${count}</span>`).join('');
  body.innerHTML=`<p class="version-intro">저장된 버전 → 기록을 열었을 때의 서버 내용입니다. 미리보기는 문서를 변경하지 않습니다.</p><div class="version-layout">${list}<div class="version-comparison"><div class="version-detail-head"><div><strong>버전 ${esc(selected.revision??'')}과 현재 비교</strong><small>현재 서버 버전 ${esc(view.revision)}</small></div><button class="outline-btn" data-action="restore-version" data-id="${esc(selected.id)}" ${!canRestore||view.restoring?'disabled':''}>제목과 본문 복원</button></div>${resourceLevel(state.page)<4?'<p class="version-permission-note">미리보기는 가능하며, 복원에는 페이지 전체 권한이 필요합니다.</p>':state.page.locked?'<p class="version-permission-note">잠긴 페이지입니다. 잠금을 해제한 뒤 복원할 수 있습니다.</p>':''}<div class="version-summary">${diff.titleChanged?'<span>제목 변경</span>':''}${summary||(!diff.titleChanged?'<span>변경 없음</span>':'')}<span class="version-legend"><del>삭제</del><ins>추가</ins></span></div>${diff.coarse?'<p class="version-coarse">긴 텍스트는 달라진 구간을 묶어서 표시합니다.</p>':''}<div id="version-status" role="status">${view.error?`<div class="info-box">${esc(view.error)}${view.restoreBlocked?'<button class="outline-btn" data-action="history">최신 기록 다시 열기</button>':''}</div>`:''}</div>${view.confirming?`<section class="version-confirm" role="group" aria-label="버전 복원 확인"><strong>버전 ${esc(selected.revision??'')}의 제목과 본문으로 복원할까요?</strong><p>지금의 제목과 본문은 새 기록으로 보관됩니다. 비교 후 다른 변경이 저장되었다면 복원을 중지합니다.</p><div class="form-actions"><button class="outline-btn" data-action="cancel-version-restore" ${view.restoring?'disabled':''}>돌아가기</button><button class="solid-btn" data-action="confirm-version-restore" data-id="${esc(selected.id)}" ${view.restoring||!canRestore?'disabled':''}>${view.restoring?'복원하는 중…':'제목과 본문 복원 확인'}</button></div></section>`:''}<div class="version-column-head"><strong>이전 · 버전 ${esc(selected.revision??'')}</strong><strong>현재 · 서버 버전 ${esc(view.revision)}</strong></div><div class="version-pair version-title-pair"><div><small>페이지 제목</small><h3>${versionRuns(diff.titleDiff,'before')||'제목 없음'}</h3></div><div><small>페이지 제목</small><h3>${versionRuns(diff.titleDiff,'after')||'제목 없음'}</h3></div></div><div class="version-blocks">${diff.changes.map(change=>`<div class="version-pair">${versionBlockHTML(change.before,change,'before',previous.blocks)}${versionBlockHTML(change.after,change,'after',view.current.blocks)}</div>`).join('')||'<div class="empty">빈 페이지입니다.</div>'}</div></div></div>`;
}
async function historyModal() {
  const scope={pageId:state.page?.id,channel:state.channel,epoch:state.channel?.base?.epoch,binding:state.session?.cache_binding,memberId:state.session?.member?.id,profileId:state.offlineProfile?.id,workspaceId:state.workspace?.workspace_id};
  if(state.route!=='page'||!scope.channel||resourceLevel(state.page)<3||state.offline||state.localPageOnly)throw new Error('연결된 페이지에서 편집 권한으로 기록을 확인할 수 있습니다.');
  openModal('페이지 기록','<div class="loading">저장된 버전과 현재 내용을 확인하는 중…</div>','version-modal');
  const view={scope,modal:$('.version-modal'),ready:false};state.versionView=view;
  try{
    await savePage();if(!versionScopeCurrent(view))return;
    const detail=await api('/pages/'+encodeURIComponent(scope.pageId));if(!versionScopeCurrent(view))return;
    if(resourceLevel(detail.page)<3){closeModal();return;}
    view.current={title:detail.page.title||'',blocks:structuredClone(detail.blocks||detail.page.blocks||[])};view.revision=detail.page.revision;view.versions=structuredClone(detail.versions||[]);view.selectedId=view.versions[0]?.id;view.locked=!!state.page.locked;view.level=resourceLevel(state.page);view.ready=true;
    renderVersionComparison(view);
  }catch(error){if(!versionScopeCurrent(view))return;if([401,403,404].includes(error.status)){closeModal();return;}$('.modal-body',view.modal).innerHTML=`<div class="empty">${esc(error.message)}</div>`;}
}
async function restoreSelectedVersion(id) {
  const view=state.versionView;if(!versionScopeCurrent(view)||!view.confirming||view.selectedId!==id||view.restoring||view.restoreBlocked)return;
  if(resourceLevel(state.page)<4||state.page.locked)throw new Error('복원에는 잠금 해제된 페이지의 전체 권한이 필요합니다.');
  view.restoring=true;view.error=null;renderVersionComparison(view);
  try{
    await api('/pages/'+encodeURIComponent(view.scope.pageId)+'/versions/'+encodeURIComponent(id)+'/restore',{revision:view.revision});
    if(!versionScopeCurrent(view))return;
    const channel=view.scope.channel;closeModal();await channel.reconnect();
  }catch(error){
    if(!versionScopeCurrent(view))return;view.restoring=false;view.confirming=false;
    if([401,403,404].includes(error.status)){closeModal();return;}
    view.restoreBlocked=error.status===409;view.error=view.restoreBlocked?'문서가 기록을 연 뒤 변경되었습니다. 최신 기록을 다시 열어 비교한 뒤 복원해 주세요.':error.status===423?'페이지가 잠겨 복원하지 못했습니다. 잠금을 해제한 뒤 다시 확인해 주세요.':error.message;renderVersionComparison(view);
  }
}
async function showTrash() {
  await refreshWorkspace();
  const pages=state.workspace.pages.filter(p=>p.archived||p.deleted||p.deleted_at);
  openModal('휴지통',`<p>삭제한 페이지를 복원할 수 있습니다.</p>${pages.map(p=>`<div class="settings-item"><span>${esc(p.icon||'📄')} ${esc(p.title)}</span><button class="outline-btn" data-action="restore-page" data-id="${esc(p.id)}">복원</button></div>`).join('')||'<div class="empty">휴지통이 비어 있어요.</div>'}`);
}
async function showActivity() {
  const data=await api('/audit');
  const audit=normalizeList(data.events||data.audit||data.entries||data);
  openModal('워크스페이스 활동',`<p>워크스페이스에서 기록된 최근 변경 사항입니다.</p>${audit.slice(0,100).map(r=>`<div class="history-item"><div>${esc(r.action||r.event)}<small>${esc(r.actor_name||r.user||r.actor||'로컬 멤버')} · ${esc(r.target_name||r.resource_type||'')} · ${date(r.created_at||r.timestamp)}</small></div></div>`).join('')||'<div class="empty">아직 기록된 활동이 없습니다.</div>'}`);
}
async function doAction(target,grouped=false) {
  if(state.nativeOutboxPause&&target?.dataset?.action!=='native-recovery')return;
  const a=target.dataset.action,id=target.dataset.id;
  if(a.startsWith('scim-')){await scimAction(a,id);return;}
  if(state.nativeRecoveryPaused&&!['native-recovery','reload-after-native-recovery'].includes(a))throw new Error('보관 내용을 확인한 뒤 앱을 다시 열어 주세요.');
  if(['undo','redo'].includes(a)){await runHistory(a);return;}
  if(['block-menu','rich-mark','rich-link','add-file','apply-recovery','indent-block','outdent-block','add-block','change-block-type','set-block-type','delete-block','move-block'].includes(a)&&!blockEditable())throw new Error('본문 편집 결과를 확인하는 중입니다. 잠시 기다려 주세요.');
  if(!grouped&&['apply-recovery','change-block-type','set-block-type','delete-block','move-block'].includes(a))return editorTransaction('structure',()=>doAction(target,true));
  if((state.offline||state.localPageOnly)&&(serverOnlyActions.has(a)||administrativeActions.has(a)))throw new Error('이 작업은 페이지가 서버에 저장되고 연결된 상태에서 사용할 수 있습니다.');
  if(administrativeActions.has(a)&&!isAdmin())throw new Error('관리자 권한이 필요합니다.');
  const edits=['favorite','toggle-cover','change-icon','add-file','add-block','block-menu','change-block-type','set-block-type','delete-block','move-block','restore-version','lock-page','delete-page','verify-page','move-page'];
  if(['delete-page','move-page'].includes(a)&&resourceLevel(state.page)<4)throw new Error('페이지 전체 권한이 필요합니다.');
  if(edits.includes(a)&&resourceLevel(state.page)<3)throw new Error('페이지 편집 권한이 없습니다.');
  if(['add-row','new-property'].includes(a)&&!(a==='add-row'?canCreateRow():resourceLevel(state.database)>=4))throw new Error('데이터베이스 편집 권한이 없습니다.');
  switch(a) {
    case'admin-settings':await openAdminConsole();break;
    case'verified-pages':await openVerifiedPages();break;
    case'verified-clear':{const view=state.verifiedPages;if(verifiedPagesCurrent(view)&&!view.opening){view.form.reset();changeVerifiedPages(view);}break;}
    case'verified-refresh':case'verified-retry':await loadVerifiedPages(state.verifiedPages);break;
    case'verified-previous':case'verified-next':{const view=state.verifiedPages;if(verifiedPagesCurrent(view)&&!view.loading&&!view.opening){view.offset=Math.max(0,view.offset+(a==='verified-next'?50:-50));await loadVerifiedPages(view);}break;}
    case'verified-open':case'verified-edit':await openVerifiedPagesItem(Number(target.dataset.index),a==='verified-edit');break;
    case'inbox':await openInbox();break;
    case'inbox-filter':{const view=state.inboxView,filter=target.dataset.filter;if(inboxScopeCurrent(view)&&!view.busy&&!view.loading&&['all','unread','archived'].includes(filter)){view.filter=filter;view.items=[];view.hasMore=false;await loadInbox(view);}break;}
    case'inbox-refresh':await loadInbox(state.inboxView);break;
    case'inbox-more':if(state.inboxView?.hasMore)await loadInbox(state.inboxView,true);break;
    case'inbox-open':case'inbox-read':case'inbox-archive':await inboxAction(a,id);break;
    case'sync-queue':await openMutationQueue();break;
    case'native-recovery':if(!nativeRecoveryAvailable())throw new Error('이 앱에서는 보관 내용 복구를 사용할 수 없습니다.');await FountainNativeRecovery.open();break;
    case'reload-after-native-recovery':location.reload();break;
    case'prepare-recovery-import':await prepareRecoveryImport();break;
    case'prepare-archived-recovery':case'prepare-memory-recovery':{const view=state.recoveryImport;if(!recoveryImportCurrent(view)||view.staging)break;invalidateRecoveryPrepared(view);view.rawText=null;view.archiveId=a==='prepare-archived-recovery'?id:null;view.memoryId=a==='prepare-memory-recovery'?id:null;view.fileName='이전 로그인에서 보관한 편집';await prepareRecoveryImport(view);break;}
    case'more-archive-recovery':await loadRecoveryArchives(state.recoveryImport,true);break;
    case'confirm-recovery-import':await confirmRecoveryImport();break;
    case'recovery-preview-more':if(recoveryImportCurrent(state.recoveryImport)){state.recoveryImport.itemLimit=(state.recoveryImport.itemLimit||30)+30;renderRecoveryImport(state.recoveryImport);}break;
    case'sync-now':await syncMutations();renderMutationQueue();break;
    case'export-mutations':download('fountain-offline-recovery.json',JSON.stringify(await state.mutations.export(),null,2),'application/json');break;
    case'export-mutation':download('fountain-offline-recovery.json',JSON.stringify(await state.mutations.export(id),null,2),'application/json');break;
    case'reapply-mutation':await state.mutations.reapply(id);await syncMutations();await refreshMutationUI();renderMutationQueue();toast('현재 서버 값을 기준으로 다시 적용했습니다.');break;
    case'drop-mutation':{
      const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const record of state.mutationRecords||[])if(!ids.has(record.id)&&(record.operation.depends_on||[]).some(dependency=>ids.has(dependency))){ids.add(record.id);changed=true;}}
      openModal('보관한 변경 폐기',`<p>이 변경${ids.size>1?'과 이를 기다리는 '+(ids.size-1)+'개 변경을':''} 기기에서 폐기합니다. 복구 내용이 필요하면 먼저 내려받으세요.</p><div class="form-actions"><button class="outline-btn" data-action="sync-queue">돌아가기</button><button class="danger-btn" data-action="confirm-drop-mutation" data-id="${esc(id)}">변경 폐기</button></div>`);break;
    }
    case'confirm-drop-mutation':{
      const controller=state.mutations,currentPageId=state.page?.id,before=await controller.records(),result=await controller.drop(id),removed=new Set(result.droppedIds||[]);
      if(state.nativeOutboxPause||state.mutations!==controller)return;
      const removedPages=new Set(before.filter(record=>removed.has(record.id)&&record.operation.kind==='page.create').map(record=>record.operation.target_id));
      if(removedPages.has(currentPageId)){closeDocument();state.page=null;state.localPageOnly=false;state.route='home';location.hash=new URL(FountainTransport.appURL('home')).hash;await refreshMutationUI();renderHome();}
      else await refreshMutationUI();
      await openMutationQueue();toast('선택한 변경과 의존 변경을 폐기했습니다.');break;
    }
    case'accounts':await openSettings('accounts');break;
    case'account-password':openAccountPassword(id);break;
    case'account-add-member':if(await openSettings('members')===true)advancedForm('members');break;
    case'account-remove':{
      if(!isOwner())throw new Error('소유자 권한이 필요합니다.');
      const account=state.accounts.find(account=>account.id===id);
      openModal('가족 로그인 해제',`<p>${esc(account?.name||'이 멤버')}의 비밀번호와 로그인 세션을 해제합니다. 멤버와 작성한 문서는 보관됩니다.</p><div class="form-actions"><button class="outline-btn" data-action="accounts">돌아가기</button><button class="danger-btn" data-action="confirm-remove-account" data-id="${esc(id)}">로그인 해제</button></div>`);break;
    }
    case'confirm-remove-account':await api('/accounts/'+encodeURIComponent(id),{},'DELETE');state.session=await api('/session');if(state.session.required&&!state.session.authenticated){closeModal();renderLogin();}else await openSettings('accounts');toast('가족 로그인을 해제했습니다.');break;
    case'enable-accounts':openModal('멤버별 로그인 활성화',`<p>이제 각자의 이메일과 비밀번호로 로그인합니다. 현재 열린 모든 로그인 세션이 종료됩니다. 설정한 소유자 이메일과 비밀번호를 확인한 뒤 활성화하세요.</p><div class="form-actions"><button class="outline-btn" data-action="accounts">돌아가기</button><button class="solid-btn" data-action="confirm-enable-accounts">활성화하고 로그인하기</button></div>`);break;
    case'confirm-enable-accounts':await api('/accounts/enable',{});state.session=await api('/session');closeModal();renderLogin();toast('멤버별 로그인을 활성화했습니다. 다시 로그인해 주세요.');break;
    case'reload':location.reload();break;
    case'home':await navigate('home');
    break;
    case'page':await navigate('page',id);
    break;
    case'database':await navigate('database',id);
    break;
    case'toggle-sidebar':document.body.classList.toggle('sidebar-open');
    break;
    case'search':openSearch();
    break;
    case'close-modal':closeModal();
    break;
    case'workspaces':await showWorkspaceDirectory();break;
    case'workspace-invite':await openWorkspaceInvitation();break;
    case'logout':{
      if(state.accountMode){await logoutAccount();break;}
      clearScimPanel();
      const actor=state.offlineProfile;if(actor&&state.authRecoveryMemory)for(const [key,value] of state.authRecoveryMemory)if(value.profile.origin===actor.origin&&value.profile.workspaceId===actor.workspaceId&&value.profile.memberId===actor.memberId)state.authRecoveryMemory.delete(key);
      const binding=actor?.cacheBinding||state.session?.cache_binding,generation=state.bootGeneration;
      closeDocument();closeMutations();await window.FountainOffline?.clearActiveProfile(actor);
      // Acknowledged native revocation intentionally forbids another cache read.
      // The original binding still fences the server DELETE against a new login.
      const terminalNative=FountainTransport.native&&FountainTransport.outboxEnabled&&actor&&typeof binding==='string'&&binding&&FountainNativeStorage?.identityState==='blocked';
      if(terminalNative)clearNativeLogoutView();
      const active=terminalNative?null:await window.FountainOffline?.getProfile();if(active&&active.id!==actor?.id){if(generation===state.bootGeneration)await boot();break;}
      state.offlineProfile=null;
      const marker=JSON.stringify({mode:state.session?.mode||'accounts',binding,nonce:uid()}),clearMarker=()=>{if(localStorage.getItem(logoutPendingKey())===marker)localStorage.removeItem(logoutPendingKey());};
      localStorage.setItem(logoutPendingKey(),marker);
      try{await api('/session',binding?{cache_binding:binding}:{},'DELETE');clearMarker();state.session=await api('/session');}
      catch(error){if(error.status===409||error.code==='STALE_REQUEST'){clearMarker();await boot();break;}if(error.status)throw error;}
      closeModal();if(state.session?.required||localStorage.getItem(logoutPendingKey()))renderLogin();else await boot();break;
    }
    case'add-page':openModal('새로운 페이지',`<p>작은 아이디어가 시작되는 빈 페이지를 만드세요.</p><form id="page-form" class="form-grid" data-parent="${esc(target.dataset.parent||'')}">${field('페이지 이름','title','무엇을 기록할까요?')}${field('아이콘','icon','🌿','text','📄')}<div class="form-actions"><button class="solid-btn">페이지 만들기</button></div></form>`);
    break;
    case'favorite':readBlocks();
    await updatePage( {
      favorite:!state.page.favorite
    });
    toast(state.page.favorite?'즐겨찾기에 추가했습니다.':'즐겨찾기에서 제거했습니다.');
    break;
    case'toggle-cover':readBlocks();
    await updatePage( {
      cover:state.page.cover?'':'sage'
    });
    renderPage();
    break;
    case'change-icon':state.iconEditingBasis=structuredClone(state.pageViewBasis||state.page);openModal('페이지 아이콘',form(field('이모지','icon','🌿','text',state.page.icon),'icon-form','변경하기'));
    break;
    case'rich-mark':{const selection=state.richSelection||richSelection();const value=!selection?.chars.every(char=>char.marks[target.dataset.mark]===true);applyRichMark(target.dataset.mark,value);break;}
    case'rich-link':{state.richSelection=state.richSelection||richSelection();if(!state.richSelection)return toast('링크를 적용할 글자를 선택해 주세요.');openModal('선택한 글자에 링크',form(field('주소','link','https://example.com'),'rich-link-form','링크 적용'));break;}
    case'indent-block':closeModal();nestBlock(id,1);break;
    case'outdent-block':closeModal();nestBlock(id,-1);break;
    case'pin-page':if(state.channel){await state.channel.persistence;await FountainOffline.saveSnapshot(state.channel.key,state.channel.base);toast('이 문서를 기기에 보관했습니다.');}break;
    case'export-recovery':{const record=state.recoveryDrafts[Number(target.dataset.index)];download('fountain-recovery.json',JSON.stringify(FountainRecovery.wrapDraft(state.offlineProfile,state.page.id,record.draft),null,2),'application/json');break;}
    case'apply-recovery':{
      const record=state.recoveryDrafts[Number(target.dataset.index)];if(!record||!pageEditable())break;
      if(!Array.isArray(record.draft.blocks)||!record.draft.blocks.length){toast('이 복구 내용은 작업 파일로 내려받아 보관해 주세요. 원본 초안은 유지합니다.');break;}
      const channel=state.channel,profileId=state.offlineProfile?.id,binding=state.session?.cache_binding,epoch=channel?.base?.epoch,current=()=>state.route==='page'&&state.channel===channel&&state.page?.id===channel?.pageId&&channel?.base?.epoch===epoch&&state.offlineProfile?.id===profileId&&state.session?.cache_binding===binding;
      const blocks=record.draft.blocks||[],elements=new Map($$('#blocks .block').map(element=>[element.dataset.id,element]));
      const currentBlocks=state.blocks.map(block=>{
        const element=elements.get(block.id),content=element&&$('.block-content',element);
        return content?{...block,text:editorPlainText(content)}:block;
      });
      if(currentBlocks.length+blocks.length>2000)throw new Error('현재 본문과 복구 내용을 합치면 블록 2000개 한도를 넘습니다. 복구 내용은 보관했으니 일부를 정리한 뒤 다시 추가해 주세요.');
      const addedPoints=FountainRecovery.bodyCodePoints(blocks,{limit:FountainRecovery.MAX_RGA_POINTS});
      if(addedPoints>FountainRecovery.MAX_RGA_POINTS||FountainRecovery.bodyCodePoints(currentBlocks,{limit:100000-addedPoints})+addedPoints>100000)throw new Error('한번에 복구할 본문이 커서 원본을 보관했습니다. 내용을 내려받아 나누어 복구하세요.');
      const ids=new Map(blocks.map(block=>[block.id,uid()]));
      let candidate;try{candidate=FountainCollaboration.normalizeBlocks([...structuredClone(currentBlocks),...blocks.map(block=>({...structuredClone(block),id:ids.get(block.id),parent_id:ids.get(block.parent_id)||null}))]);}catch{throw new Error('복구 블록 형식을 확인하지 못했습니다. 현재 본문과 원본 복구 내용은 유지합니다.');}
      state.blocks=candidate;reconcileEditor();await channel.persistence;if(!current())break;await FountainOffline.saveDraft(channel.key,record.clientId,null);const drafts=await FountainOffline.getDrafts(channel.key);if(!current())break;state.recoveryDrafts=drafts.filter(record=>!['pending','basis'].includes(record.draft.reason));renderRecoveryDrafts();scheduleSave();toast('복구 내용을 새 블록으로 추가했습니다.');break;
    }
    case'upload-pause':state.uploadManager?.pause(id);break;
    case'upload-retry':await state.uploadManager?.resume(id);break;
    case'upload-reselect':state.uploadReselectId=id;$('#attachment-input')?.click();break;
    case'upload-cancel':await state.uploadManager?.cancel(id);break;
    case'upload-dismiss':state.uploadManager?.jobs.delete(id);if(state.uploadManager)renderUploads(state.uploadManager.view());break;
    case'add-file':if(state.route!=='page'||!pageEditable())throw new Error('파일을 추가할 편집 권한이 없습니다.');state.uploadReselectId=null;$('#attachment-input')?.click();break;
    case'add-block':addBlock();
    break;
    case'block-menu': {
      state.activeBlock=id;
      const b=state.blocks.find(b=>b.id===id);
      openModal('블록 관리',`<div class="form-grid"><label>블록 종류<select id="block-type-select">${blockTypes.map(([k,n])=>`<option value="${k}" ${k===b.type?'selected':''}>${n}</option>`).join('')}</select></label><button class="outline-btn" data-action="change-block-type" data-id="${esc(id)}">종류 변경</button><div class="form-actions"><button class="outline-btn" data-action="indent-block" data-id="${esc(id)}">들여쓰기</button><button class="outline-btn" data-action="outdent-block" data-id="${esc(id)}">내어쓰기</button><button class="outline-btn" data-action="move-block" data-id="${esc(id)}" data-direction="-1">↑ 위로</button><button class="outline-btn" data-action="move-block" data-id="${esc(id)}" data-direction="1">↓ 아래로</button><button class="danger-btn" data-action="delete-block" data-id="${esc(id)}">블록 삭제</button></div></div>`);
      break;
    }
    case'change-block-type': {
      const b=state.blocks.find(b=>b.id===id);
      b.type=$('#block-type-select').value;
      readBlocks();
      closeModal();
      renderBlocks(id);
      scheduleSave();
      break;
    }
    case'set-block-type': {
      const b=state.blocks.find(b=>b.id===id);
      readBlocks();
      b.type=target.dataset.type;
      b.text=b.text.replace(/^\/[^\n]*/,'');
      closeSlash();
      renderBlocks(id);
      scheduleSave();
      break;
    }
    case'delete-block': {
      readBlocks();
      state.blocks=state.blocks.filter(b=>b.id!==id);
      closeModal();
      renderBlocks();
      scheduleSave();
      break;
    }
    case'move-block': {
      readBlocks();
      const from=state.blocks.findIndex(b=>b.id===id),to=from+Number(target.dataset.direction);
      if(to>=0&&to<state.blocks.length) {
        const [b]=state.blocks.splice(from,1);
        state.blocks.splice(to,0,b);
      }
      closeModal();
      renderBlocks(id);
      scheduleSave();
      break;
    }
    case'toggle-block': {
      const el=$(`.block[data-id="${CSS.escape(id)}"] .block-content`);
      el.hidden=!el.hidden;
      target.textContent=el.hidden?'▸':'▾';
      break;
    }
    case'history':await historyModal();
    break;
    case'select-version':{const view=state.versionView;if(versionScopeCurrent(view)&&view.versions.some(version=>version.id===id)&&!view.restoring){view.selectedId=id;view.confirming=false;renderVersionComparison(view);}break;}
    case'restore-version':{const view=state.versionView;if(versionScopeCurrent(view)&&view.selectedId===id&&resourceLevel(state.page)>=4&&!state.page.locked&&!view.restoreBlocked){view.confirming=true;renderVersionComparison(view);}break;}
    case'cancel-version-restore':{const view=state.versionView;if(versionScopeCurrent(view)&&!view.restoring){view.confirming=false;renderVersionComparison(view);}break;}
    case'confirm-version-restore':await restoreSelectedVersion(id);break;
    case'resolve-comment':await api('/comments/'+id, {
      resolved:true
    },'PATCH');
    state.comments.find(c=>c.id===id).resolved=true;
    $('#comments').innerHTML=commentsHTML();
    break;
    case'page-menu':{const initial=wikiScope(),overlay=$('#overlay-root').firstChild;await syncWikiPage();if(!wikiScopeCurrent(initial)||$('#overlay-root').firstChild!==overlay)break;openModal('페이지 메뉴',`<div class="form-grid"><button class="outline-btn" data-action="pin-page">기기에 보관 · 오프라인 편집</button><button class="outline-btn" data-action="copy-blocks">${icon('link')}블록 복사</button><button class="outline-btn" data-action="lock-page">${icon('lock')}${state.page.locked?'페이지 잠금 해제':'페이지 잠그기'}</button>${pageEditable()&&wikiVerificationAllowed()&&!state.offline&&!state.localPageOnly?'<button class="outline-btn" data-action="verify-page">페이지 검증 설정</button>':''}<button class="outline-btn" data-action="move-page">페이지 이동</button><button class="outline-btn" data-action="duplicate-page">페이지 복제</button>${resourceLevel(state.page)>=4&&!state.page.locked&&!state.offline&&!state.localPageOnly&&(!state.page.parent_id||state.page.is_wiki===true)?`<button class="outline-btn" data-action="wiki-toggle">${state.page.is_wiki===true?'위키 해제':'위키로 전환'}</button>`:''}<button class="outline-btn" data-action="history">${icon('clock')}페이지 기록</button><button class="danger-btn" data-action="delete-page">${icon('trash')}휴지통으로 이동</button></div>`);
    break;
    }
    case'lock-page':{const locked=!state.page.locked;closeModal();await updatePage({locked});renderPage();break;}
    case'delete-page':await api('/pages/'+state.page.id, {
    },'DELETE');
    await refreshWorkspace();
    await navigate('home');
    toast('페이지를 휴지통으로 이동했습니다.');
    break;
    case'duplicate-page': {
      await savePage();
      const p=await api('/pages', {
        title:state.page.title+' (사본)',icon:state.page.icon
      });
      await api('/pages/'+(p.id||p.page.id)+'/blocks', {
        blocks:(()=>{const ids=new Map(state.blocks.map(block=>[block.id,uid()]));return state.blocks.map(block=>({...block,id:ids.get(block.id),parent_id:ids.get(block.parent_id)||null}));})(),revision:p.revision||p.page?.revision
      },'PUT');
      await refreshWorkspace();
      await navigate('page',p.id||p.page.id);
      break;
    }
    case'wiki-toggle':wikiToggleModal();break;
    case'confirm-wiki-toggle':await saveWikiMutation();break;
    case'wiki-owner':await wikiOwnerModal();break;
    case'wiki-tab':await wikiTab(target.dataset.view);break;
    case'wiki-refresh':{const view=state.wikiPage;if(wikiCurrent(view)&&view.kind==='root')await loadWikiPages(view);else await syncWikiPage(true);break;}
    case'wiki-more':if(state.wikiPage?.hasMore)await loadWikiPages(state.wikiPage,true);break;
    case'verify-page':await verificationModal();break;
    case'remove-verification':await saveVerification(true);break;
    case'move-page':openModal('페이지 이동',`<form id="move-page-form" class="form-grid"><label>상위 페이지<select name="parent_id"><option value="">최상위 페이지</option>${state.workspace.pages.filter(p=>p.id!==state.page.id&&!p.archived).map(p=>`<option value="${esc(p.id)}" ${p.id===state.page.parent_id?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label><button class="solid-btn">이동하기</button></form>`);
    break;
    case'copy-blocks': {
      const scope=searchScope(),pageId=state.page?.id,current=()=>sameSearchScope(scope)&&state.route==='page'&&state.page?.id===pageId;
      readBlocks();
      const data=await api('/clipboard', {
        blocks:state.blocks
      });
      try {
        if(navigator.clipboard?.write&&typeof ClipboardItem!=='undefined')await navigator.clipboard.write([new ClipboardItem( {
          'text/plain':new Blob([data.text], {
            type:'text/plain'
          }),'text/html':new Blob([data.html], {
            type:'text/html'
          })
        })]);
        else await navigator.clipboard.writeText(data.text);
        if(current())toast('서식과 함께 블록을 복사했습니다.');
      }
      catch {
        if(!current())break;
        openModal('복사할 내용',`<p>아래 내용을 선택해서 복사하세요.</p><textarea style="width:100%;height:250px">${esc(data.text)}</textarea>`);
        $('textarea').select();
      }
      break;
    }
    case'share':await openPermissions('pages',state.page.id);break;
    case'db-share':await openPermissions('databases',state.database.id);break;
    case'copy-link': {
      const scope=searchScope(),current=()=>sameSearchScope(scope);
      const el=$('#share-url')||$('.modal-body input');
      try {
        await navigator.clipboard.writeText(el.value);
        if(current())toast('링크를 복사했습니다.');
      }
      catch {
        if(!current()||!el?.isConnected)break;
        el.select();
        toast('주소를 선택했습니다. Ctrl+C로 복사하세요.');
      }
      break;
    }
    case'open-sites':await openSettings('sites');
    break;
    case'trash':await showTrash();
    break;
    case'restore-page':await api('/pages/'+id+'/restore', {
    });
    await showTrash();
    toast('페이지를 복원했습니다.');
    break;
    case'activity':await showActivity();
    break;
    case'ai':await showAI();
    break;
    case'settings':await openSettings();
    break;
    case'settings-tab':state.settingsTab=target.dataset.tab;
    await renderSettings();
    break;
    case'invite':if(await openSettings('members')===true)advancedForm('members');
    break;
    case'new-teamspace':if(await openSettings('members')===true)advancedForm('teamspaces');
    break;
    case'teamspace': {
      if(await openSettings('members')!==true)break;
      const t=state.advanced.teamspaces?.find(t=>t.id===id);
      if(t)advancedForm('teamspaces',id);
      break;
    }
    case'add-advanced':advancedForm(target.dataset.kind);
    break;
    case'edit-advanced':advancedForm(target.dataset.kind,id);
    break;
    case'run-automation':await openManualAutomation(id);break;
    case'automation-runs':await openAutomationRuns(id);break;
    case'automation-settings':await openSettings('automations');break;
    case'toggle-automation':{const automation=state.advanced.automations.find(item=>item.id===id);await api('/automations/'+encodeURIComponent(id),{enabled:automation.enabled===false},'PATCH');await openSettings('automations');toast(automation.enabled===false?'자동화를 사용하도록 설정했습니다.':'자동화를 일시 중지했습니다.');break;}
    case'fill-form':{
      const url=FountainTransport.publicURL('/forms/'+encodeURIComponent(id),state.session?.public_web_origin);
      if(!url){toast('공유 웹 주소를 연결해 주세요.');break;}
      window.open(url,'_blank','noopener');break;
    }
    case'site-link': {
      const site=state.advanced.sites.find(s=>s.id===id);
      if(!site.published) {
        toast('먼저 사이트를 게시해 주세요.');
        break;
      }
      const url=FountainTransport.publicURL('/sites/'+encodeURIComponent(site.slug),state.session?.public_web_origin);
      if(!url){toast('공유 웹 주소를 연결해 주세요.');break;}
      window.open(url,'_blank','noopener');
      break;
    }
    case'add-row':if(!state.database) {
      toast('먼저 데이터베이스를 만들어 주세요.');
      break;
    }
    openRow(null,target.dataset.status);
    break;
    case'duplicate-row':{
      if(!canCreateRow())throw new Error('항목 생성 권한이 없습니다.');
      const result=await api('/databases/'+state.database.id+'/rows/'+encodeURIComponent(id)+'/duplicate',{});
      closeModal();await reloadDatabase();
      if(state.rows.some(row=>row.id===result.root_id))openRow(result.root_id);
      toast('하위 항목과 함께 복제했습니다.');break;
    }
    case'edit-row':openRow(id);
    break;
    case'delete-row':{
      if(resourceLevel(state.rows.find(row=>row.id===id))<3)throw new Error('항목 편집 권한이 없습니다.');
      if(state.rows.some(row=>row.parent_row_id===id)){openModal('하위 항목과 함께 삭제',`<p>이 항목을 삭제하면 연결된 하위 항목도 함께 삭제됩니다.</p><div class="form-actions"><button class="outline-btn" data-action="edit-row" data-id="${esc(id)}">돌아가기</button><button class="danger-btn" data-action="confirm-delete-row" data-id="${esc(id)}">하위 항목과 함께 삭제</button></div>`);break;}
      await deleteTaskRow(id);break;
    }
    case'confirm-delete-row':await deleteTaskRow(id);break;
    case'task-settings':openTaskSettings();break;
    case'toggle-subitems':if(state.collapsedRows.has(id))state.collapsedRows.delete(id);else state.collapsedRows.add(id);if(state.route==='database')renderDatabase();else if($('#home-database'))$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true);break;
    case'timeline-today':{const today=Math.floor(Date.now()/DAY_MS);state.timelineBounds={start:today-7,end:today+21};state.timelineFocusDay=today;renderDatabase();break;}
    case'timeline-fit':state.timelineBounds=null;state.timelineFocusDay=null;renderDatabase();break;
    case'db-view':state.view=target.dataset.view;
    if(state.route!=='database') {
      await navigate('database',state.database.id);
    }
    else renderDatabase();
    break;
    case'filter':if(state.route!=='database')await navigate('database',state.database.id);
    $('#db-filters').hidden=!$('#db-filters').hidden;
    if(!$('#db-filters').hidden)$('#db-filter-input').focus();
    break;
    case'db-sort':state.sort=!state.sort;
    renderDatabase();
    break;
    case'clear-filter':state.filter='';
    renderDatabase();
    break;
    case'db-export': {
      if(state.workspace.settings?.disable_export){toast('워크스페이스에서 내보내기를 제한했습니다.');break;}
      const props=state.database.properties;
      const cell=v=>'"'+String(Array.isArray(v)?v.join(', '):v&&typeof v==='object'?JSON.stringify(v):v??'').replace(/"/g,'""')+'"';
      const csv='\uFEFF'+[props.map(p=>cell(p.name)).join(','),...filteredRows().map(r=>props.map(p=>cell(valuesOf(r)[p.id])).join(','))].join('\r\n');
      download((state.database.name||'database')+'.csv',csv,'text/csv;charset=utf-8');
      toast('CSV를 내보냈습니다.');
      break;
    }
    case'new-database':openModal('새 데이터베이스',form(field('데이터베이스 이름','name','팀 프로젝트'),'database-form'));
    break;
    case'owner-settings':openOwnerSettings();break;
    case'row-verification':await openDatabaseVerification();break;
    case'row-verification-save':await saveDatabaseVerification(false);break;
    case'row-verification-remove':await saveDatabaseVerification(true);break;
    case'row-verification-refresh':await openDatabaseVerification();break;
    case'new-property':openModal('데이터베이스 속성 추가',form(field('속성 이름','name','마감일')+`<label>속성 종류<select name="type"><option value="text">텍스트</option><option value="number">숫자</option><option value="status">상태</option><option value="select">선택</option><option value="date">날짜</option><option value="person">사람</option><option value="owner">담당자</option><option value="verification">검증 · 담당자 자동 추가</option><option value="checkbox">체크박스</option><option value="multi_select">다중 선택</option><option value="files">파일 ID 목록</option><option value="url">URL</option><option value="email">이메일</option><option value="relation">관계형</option><option value="formula">수식</option><option value="rollup">롤업</option></select></label>`+field('선택 항목 (쉼표로 구분)','options','시작 전, 진행 중, 완료')+field('수식','expression',"prop('estimate') * 2")+`<label>관계형 대상 데이터베이스<select name="database_id">${state.workspace.databases.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>롤업에 사용할 관계 속성<select name="relation_property"><option value="">관계 속성을 선택하세요</option>${state.database.properties.filter(p=>p.type==='relation').map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('')}</select></label>`+field('롤업 대상 속성 ID','target_property','estimate')+`<label>롤업 집계<select name="aggregation"><option value="sum">합계</option><option value="count">개수</option><option value="average">평균</option><option value="min">최솟값</option><option value="max">최댓값</option></select></label>`,'property-form'));captureDatabasePropertyView('add');
    break;
    case'backup':{if(state.workspace.settings?.disable_export)throw new Error('워크스페이스에서 내보내기를 제한했습니다.');await openBackup();break;}
    case'backup-retry':if(state.backupManager?.restartRequired)await openBackup();else await state.backupManager?.retry();break;
    case'backup-cancel':closeModal();toast('백업 창을 닫았습니다.');break;
    case'export': {
      const data=await api('/export?format='+target.dataset.format);
      download(data.filename,data.content,data.mime);
      toast('백업 파일을 내보냈습니다.');
      break;
    }
  }
}
window.addEventListener('pagehide',()=>{clearVerifiedPages();clearAdminConsole();clearScimPanel();});
window.addEventListener('offline',()=>{if(state.verifiedPages||state.adminConsole)closeModal();});
document.addEventListener('click',event=> {
  if(state.nativeOutboxPause&&!event.target.closest?.('.native-recovery-dialog'))return;
  if(event.target.closest?.('.block-content a.rich-link')&&pageEditable()&&!event.metaKey&&!event.ctrlKey){event.preventDefault();return;}
  const target=event.target.closest('[data-action]'); if(target) {
    event.preventDefault(); doAction(target).catch(error=>toast(error.message));
  }
  else if(event.target.classList.contains('modal-backdrop'))closeModal(); else if(!event.target.closest('.slash-menu,.block-content'))closeSlash();
});
document.addEventListener('input',event=> {
  if(state.nativeOutboxPause)return;
  const el=event.target; if(el.id==='page-title') {
    if(!pageEditable())return;
    clearTimeout(state.titleTimer);
    const basePage=state.titlePending?.id===state.page.id?state.titlePending.basePage:state.titleInputBasis||structuredClone(state.pageViewBasis||state.page);
    state.titlePending={id:state.page.id,title:el.innerText.trim()||'제목 없음',basePage};state.titleInputBasis=null;
    state.titleTimer=setTimeout(()=>saveTitle().catch(e=>toast(e.message)),450);
  }
  if(el.classList.contains('block-content')) {
    if(state.composition||event.isComposing)return;if(['historyUndo','historyRedo'].includes(event.inputType)){patchDocumentBlocks();return;}if(!blockEditable()){patchDocumentBlocks();return;}
    const id=el.closest('.block').dataset.id;commitEditableText(el,state.inputBaseline?.id===id?state.inputBaseline.chars:undefined);state.inputBaseline=null;
    const text=state.blocks.find(block=>block.id===id)?.text||'';if(text.startsWith('/'))openSlash(id,text.slice(1));else closeSlash();scheduleSave();
  }
  if(el.id==='search-input') {
    const view=searchView;if(view&&searchCurrent(view)){clearTimeout(view.timer);view.sequence++;view.request?.abort();view.items=[];view.results.replaceChildren();view.more.hidden=true;view.status.textContent='검색을 준비하고 있어요…';view.timer=setTimeout(()=>renderSearch(view),150);}
  }
  if(el.id==='db-filter-input') {
    state.filter=el.value; $('#db-view').innerHTML=databaseView();
  }
});
document.addEventListener('change',event=> {
  if(state.nativeOutboxPause&&!event.target.closest?.('.native-recovery-dialog'))return;
  const el=event.target;
  if(el.id==='recovery-import-file'){const file=el.files?.[0];el.value='';readRecoveryFile(file).catch(error=>toast(recoveryImportError(error)));return;}
  if(el.id==='recovery-target-page'){prepareRecoveryImport().catch(error=>toast(recoveryImportError(error)));return;}
  if(el.id==='rich-color'||el.id==='rich-background'){applyRichMark(el.id==='rich-color'?'color':'background',el.value);return;}
  if(el.closest('#advanced-form')&&$('#advanced-form')?.dataset.kind==='automations'){if(el.name==='trigger')updateScheduleFields();if(el.name==='database_id')loadAutomationRows(el.value).catch(error=>toast(error.message));}
  if(el.id==='timeline-property'){state.timelineProperty=el.value;state.timelineBounds=null;state.timelineFocusDay=null;renderDatabase();return;}
  if(el.id==='timeline-zoom'){state.timelineZoom=el.value;renderDatabase();return;}
  if(el.dataset.check&&!blockEditable())return;
  if(el.id==='attachment-input'){const file=el.files?.[0];el.value='';attachFile(file).catch(error=>toast(error.message));return;}
  if(el.dataset.check) {
    editorTransaction('structure',()=>{const b=state.blocks.find(b=>b.id===el.dataset.check); b.checked=el.checked; el.closest('.block').classList.toggle('checked',el.checked); scheduleSave();});
  }
});
document.addEventListener('keydown',event=> {
  if(state.nativeOutboxPause)return;
  if(state.nativeRecoveryPaused)return;
  if(['Enter',' '].includes(event.key)&&event.target.matches('[data-action="edit-row"][role="button"]')){event.preventDefault();doAction(event.target).catch(error=>toast(error.message));return;}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k') {
    event.preventDefault(); openSearch(); return;
  }
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s') {
    event.preventDefault(); savePage().catch(e=>toast(e.message)); return;
  }
  if(event.key==='Escape') {
    closeSlash(); closeModal(); document.body.classList.remove('sidebar-open'); return;
  }
  if(event.target.id==='search-input'&&event.key==='Enter') {
    event.preventDefault(); $('.search-result')?.click(); return;
  }
  const el=event.target.closest('.block-content'); if(!el)return;if(event.isComposing||state.composition||event.keyCode===229)return;
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&(event.key.toLowerCase()==='z'||event.ctrlKey&&event.key.toLowerCase()==='y')){event.preventDefault();state.historyCommand=true;setTimeout(()=>{state.historyCommand=false;},0);runHistory(event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo').catch(error=>toast(error.message));return;}
  if(!blockEditable())return;
  const block=el.closest('.block'),id=block.dataset.id,b=state.blocks.find(b=>b.id===id);
  if(event.key==='Tab'){event.preventDefault();nestBlock(id,event.shiftKey?-1:1);return;}
  if((event.metaKey||event.ctrlKey)&&['b','i','u'].includes(event.key.toLowerCase())){event.preventDefault();const mark={b:'bold',i:'italic',u:'underline'}[event.key.toLowerCase()];state.richSelection=richSelection();applyRichMark(mark,!state.richSelection?.chars.every(char=>char.marks[mark]===true));return;}
  if(event.key==='Enter'&&!event.shiftKey&&b.type!=='code') {
    event.preventDefault(); if($('.slash-menu')) {
      $('.slash-menu button')?.click(); return;
    }
    editorTransaction('structure',()=>{readBlocks(); if(!b.text&&['bullet','numbered','todo','heading1','heading2','heading3','quote'].includes(b.type)) {
      b.type='paragraph'; renderBlocks(id); scheduleSave(); return;
    }
    const sel=getSelection(); const range=sel.rangeCount?sel.getRangeAt(0).cloneRange():null; let offset=b.text.length; if(range) {
      const before=range.cloneRange(); before.selectNodeContents(el); before.setEnd(range.startContainer,range.startOffset); offset=Array.from(before.toString()).length;
    }
    const points=Array.from(b.text),rest=points.slice(offset).join(''); b.text=points.slice(0,offset).join(''); const type=['todo','bullet','numbered'].includes(b.type)?b.type:'paragraph'; const next= {
      id:uid(),type,text:rest,parent_id:b.parent_id||null,rich_text:richTokensFromChars(state.channel.chars(id).slice(Array.from(b.text).length))
    }; state.blocks.splice(state.blocks.indexOf(b)+1,0,next); renderBlocks(next.id); scheduleSave();});
  }
  else if(event.key==='Backspace'&&!el.innerText) {
    const i=state.blocks.indexOf(b); if(i>0) {
      event.preventDefault();editorTransaction('structure',()=>{state.blocks.splice(i,1); renderBlocks(state.blocks[i-1].id); scheduleSave();});
    }
  }
  else if(event.key===' ') {
    const shortcuts= {
      '#':'heading1','##':'heading2','###':'heading3','-':'bullet','*':'bullet','1.':'numbered','[]':'todo','[ ]':'todo','>':'quote','```':'code','---':'divider'
    }; if(shortcuts[el.innerText]) {
      event.preventDefault();editorTransaction('structure',()=>{b.type=shortcuts[el.innerText]; b.text=''; renderBlocks(id); scheduleSave();});
    }
  }
});
let dragId=null;
document.addEventListener('dragstart',e=> {
  const b=e.target.closest('.block'); if(!blockEditable()||!b||e.target.closest('[contenteditable=true]')) {
    e.preventDefault(); return;
  }
  dragId=b.dataset.id; b.classList.add('dragging'); e.dataTransfer.setData('text/plain',dragId);
});
document.addEventListener('dragover',e=> {
  if(dragId&&e.target.closest('.block'))e.preventDefault();
});
document.addEventListener('drop',e=> {
  const b=e.target.closest('.block'); if(!dragId||!b)return; e.preventDefault();if(!blockEditable()){dragId=null;return;}editorTransaction('structure',()=>{readBlocks(); const from=state.blocks.findIndex(b=>b.id===dragId),to=state.blocks.findIndex(v=>v.id===b.dataset.id); const [item]=state.blocks.splice(from,1); state.blocks.splice(to,0,item); renderBlocks(dragId); scheduleSave(); dragId=null;});
});
document.addEventListener('dragend',()=> {
  $$('.dragging').forEach(b=>b.classList.remove('dragging')); dragId=null;
});
document.addEventListener('submit',async event=> {
  if(state.nativeOutboxPause&&!event.target.closest?.('.native-recovery-dialog')){event.preventDefault();return;}
  if(state.nativeRecoveryPaused)return;
  if(event.target.id==='wiki-owner-form'){event.preventDefault();await saveWikiMutation();return;}
  if(event.target.id==='wiki-search-form'){event.preventDefault();const view=state.wikiPage;if(wikiCurrent(view)&&!view.loading){view.query=event.target.q.value;view.items=[];view.hasMore=false;await loadWikiPages(view);}return;}
  if(event.target.id==='property-form'||event.target.id==='owner-settings-form'){event.preventDefault();await saveDatabaseProperty(event.target);return;}
  if(event.target.id==='verification-form'){event.preventDefault();await saveVerification(false);return;}
  const formElement=event.target; if(!formElement.id)return; event.preventDefault(); const data=Object.fromEntries(new FormData(formElement)),submit=$('button[type=submit],button.solid-btn',formElement); if(submit)submit.disabled=true; try {
    switch(formElement.id) {
      case'rich-link-form':{FountainCollaboration.validateMarks({link:data.link||null});closeModal();applyRichMark('link',data.link||null);break;}
      case'account-password-form':{
        if(!isOwner())throw new Error('소유자 권한이 필요합니다.');
        if(data.password!==data.password_confirm)throw new Error('비밀번호 확인이 일치하지 않습니다.');
        const accountId=formElement.dataset.id;
        await api('/accounts'+(formElement.dataset.existing==='true'?'/'+encodeURIComponent(accountId):''),formElement.dataset.existing==='true'?{password:data.password}:{member_id:accountId,password:data.password},formElement.dataset.existing==='true'?'PATCH':'POST');
        state.session=await api('/session');
        if(state.session.required&&!state.session.authenticated){closeModal();renderLogin();toast('비밀번호를 변경했습니다. 다시 로그인해 주세요.');}
        else{await openSettings('accounts');toast('가족 로그인 비밀번호를 저장했습니다.');}
        break;
      }
      case'permissions-form':{
        const sharing=state.sharing;
        if(!sharing?.result.can_manage)throw new Error('공유 설정을 변경할 권한이 없습니다.');
        const permissions={default:data.default,inherit:formElement.elements.namedItem('inherit').checked,members:{},groups:{}};
        for(const select of $$('[data-acl-kind]',formElement)){
          if(select.disabled||select.value==='')continue;
          permissions[select.dataset.aclKind][select.dataset.aclId]=select.value;
        }
        const payload={permissions};
        if(sharing.kind==='databases'){
          if(data.row_mode==='assigned'&&!data.property_id)throw new Error('담당자를 확인할 사람 속성을 선택해 주세요.');
          payload.row_permissions={mode:data.row_mode||'all',property_id:data.property_id||'',edit_assigned:formElement.elements.namedItem('edit_assigned').checked,allow_create:formElement.elements.namedItem('allow_create').checked};
        }
        await api('/'+sharing.kind+'/'+encodeURIComponent(sharing.id)+'/permissions',payload,'PATCH');
        await refreshWorkspace();
        await navigate(sharing.kind==='pages'?'page':'database',sharing.id);
        toast('공유 설정을 저장했습니다.');break;
      }
      case'login-form':{
        const credentials=state.session?.mode==='accounts'?{email:data.email,password:data.password}:{token:data.token};
        if(state.session?.setup_supported===true&&(data.setup_nonce||data.create_account)){
          if(!/^[A-Za-z0-9_-]{43}$/.test(data.setup_nonce||''))throw new Error('연결 코드를 확인해주세요.');
          credentials.setup_nonce=data.setup_nonce;
          if(data.create_account){if(Array.from(data.password||'').length<10)throw new Error('새 비밀번호는 10자 이상 입력해주세요.');if(data.password!==data.setup_password_confirm)throw new Error('비밀번호 확인이 일치하지 않습니다.');credentials.create_account=true;}
        }
        if(state.accountMode){if(credentials.setup_nonce&&data.workspace_id)credentials.workspace_id=data.workspace_id;await state.account.login(credentials);}else await api('/session',credentials);setupCodeFromLink=null;formElement.reset();await boot();break;
      } case'page-form': {
        const parentId=formElement.dataset.parent||null,parent=state.workspace.pages.find(page=>page.id===parentId);
        if(state.session?.member?.role==='guest'&&(!parentId||!parent||resourceLevel(parent)<3||parent.locked||parent.archived))throw new Error('상위 페이지 편집 권한이 필요합니다.');
        if(parentId&&(!parent||resourceLevel(parent)<3))throw new Error('상위 페이지 편집 권한이 없습니다.');
        const body={title:data.title||'제목 없음',icon:data.icon||'📄',parent_id:parentId};
        let p;
        if(state.mutations){const created=await state.mutations.createPage(body);p=created.page;await refreshMutationUI();if(!state.offline)await syncMutations();}
        else{p=await api('/pages',body);await refreshWorkspace();}
        await navigate('page',p.id||p.page.id);break;
      }
      case'icon-form':await updatePage( {
        icon:data.icon
      },state.iconEditingBasis); closeModal(); renderPage(); break; case'move-page-form':await updatePage( {
        parent_id:data.parent_id||null
      }); closeModal(); toast('페이지를 이동했습니다.'); break; case'comment-form': {
        const c=await api('/pages/'+state.page.id+'/comments', {
          text:data.text
        }); state.comments.push(c.comment||c); $('#comments').innerHTML=commentsHTML(); formElement.reset(); if(state.accountMode&&state.offlineProfile)await FountainOffline.clearWorkspaceInput(state.offlineProfile,'comment');toast('댓글을 남겼습니다.'); break;
      }
      case'row-form': {
        if(!rowEditingScopeCurrent(state.rowEditingScope)||state.rowEditingModal!==formElement.closest('.modal'))throw new Error('데이터베이스나 로그인 상태가 변경되었습니다. 입력은 보관되어 있습니다.');
        const rowScope=state.rowEditingScope,rowModal=state.rowEditingModal,controller=state.mutations,database=structuredClone(state.rowEditingDatabase),baselineRow=state.rowEditingBaseline?structuredClone(state.rowEditingBaseline):null,rowId=formElement.dataset.id;
        const current=()=>rowEditingScopeCurrent(rowScope)&&state.mutations===controller&&state.rowEditingScope===rowScope&&state.rowEditingModal===rowModal&&rowModal.isConnected&&$('#row-form')===formElement&&formElement.dataset.id===rowId&&(rowId?resourceLevel(state.rows.find(row=>row.id===rowId))>=3:canCreateRow());
        const properties=Object.create(null); for(const p of database.properties) {
          if(['formula','rollup','created_time','last_edited_time','verification'].includes(p.type))continue;
          if(p.type==='owner'){properties[p.id]=new FormData(formElement).getAll(p.id);if(p.limit==='one'&&properties[p.id].length>1)throw new Error('담당자는 한 명만 선택할 수 있습니다.');continue;}
          if(p.type==='date'){const start=data[p.id]||'',end=data[p.id+'__end']||'',original=valuesOf(baselineRow||{})[p.id],range=dateRange(original);if(end&&(!start||end<start))throw new Error('종료일은 시작일 이후여야 합니다.');properties[p.id]=range&&start===range.startISO&&end===(typeof original==='object'&&original?.end?range.endISO:'')?original:end?{start,end}:start;continue;}
          properties[p.id]=p.type==='checkbox'?formElement.elements.namedItem(p.id).checked:p.type==='number'?(data[p.id]!==''?Number(data[p.id]):null):['relation','multi_select','files'].includes(p.type)?String(data[p.id]||'').split(',').map(s=>s.trim()).filter(Boolean):data[p.id]||'';
        }
        const body={properties,...taskGraphChanges(formElement,data,baselineRow)};
        if(rowId&&baselineRow){
          for(const property of database.properties){
            if(!(property.id in properties))continue;
            const original=valuesOf(baselineRow)[property.id];
            const baseline=property.type==='checkbox'?!!original:property.type==='number'?(original===''||original==null?null:Number(original)):['relation','multi_select','files','owner'].includes(property.type)?(Array.isArray(original)?original:[]):original??'';
            if(JSON.stringify(properties[property.id])===JSON.stringify(baseline))delete properties[property.id];
          }
        }
        try{
        if(controller){
          const records=await controller.records();if(!current())break;const previousIds=new Set(records.map(record=>record.id));
          if(rowId)await controller.patchRow(database.id,rowId,body,{baseline:baselineRow,schema:database.properties});else await controller.createRow(database.id,body,{schema:database.properties});
          if(!current())break;
          if(!state.offline){await syncMutations({controller,current});if(!current())break;const records=await controller.records();if(!current())break;const invalid=records.find(record=>!previousIds.has(record.id)&&record.status==='invalid');if(invalid)throw new Error(mutationError(invalid)+' 변경 내용은 동기화 목록에 보관했습니다.');}
        }else{if(!current())break;await api('/databases/'+encodeURIComponent(database.id)+'/rows'+(rowId?'/'+encodeURIComponent(rowId):''),body,rowId?'PATCH':'POST',{current});if(!current())break;}
        if(!current())break;closeModal();const ticket=searchNavigation,completed=()=>rowEditingScopeCurrent(rowScope)&&state.mutations===controller&&searchNavigation===ticket&&!$('.modal');
        const result=await loadDatabaseData(database.id);if(!completed())break;state.database=result.database;state.rows=result.rows||[];
        if(state.route==='database')renderDatabase();else if($('#home-database')){$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;applyDatabaseControls();}
        if(state.accountMode&&state.offlineProfile)await FountainOffline.clearWorkspaceInput(state.offlineProfile,'row');
        toast(state.offline?(nativeCacheOnly()?'변경을 앱 캐시에 보관했습니다. 연결되면 동기화합니다.':'변경을 기기에 저장했습니다. 연결되면 동기화합니다.'):state.mutationRecords?.some(record=>record.operation.database_id===database.id)?'변경을 기기에 보관했습니다. 동기화 목록에서 상태를 확인하세요.':'프로젝트를 저장했습니다.');
        }catch(error){if(current())throw error;}
        break;
      }
      case'task-settings-form':{
        await api('/databases/'+state.database.id,{task_settings:{subitems:formElement.subitems.checked,dependencies:formElement.dependencies.checked,date_property:data.date_property,shift:data.shift,skip_weekends:formElement.skip_weekends.checked}},'PATCH');state.timelineProperty=data.date_property;closeModal();await reloadDatabase();toast('프로젝트 일정 설정을 저장했습니다.');break;
      }
      case'database-form': {
        const d=await api('/databases', {
          name:data.name||'새 데이터베이스',properties:[ {
            id:'name',name:'이름',type:'title'
          }, {
            id:'status',name:'상태',type:'status',options:['시작 전','진행 중','완료']
          }, {
            id:'due',name:'마감일',type:'date'
          }]
        }); await refreshWorkspace(); await navigate('database',d.id||d.database.id); break;
      }
      case'advanced-form': {
        const kind=formElement.dataset.kind,id=formElement.dataset.id; const payload= {
          ...data
        }; for(const key of ['fields','actions'])if(key in payload)payload[key]=JSON.parse(payload[key]);
        if(kind==='automations'){
          if(payload.trigger==='scheduled'){
            const interval=Number(payload.schedule_interval);if(!Number.isInteger(interval)||interval<1||interval>365)throw new Error('반복 간격은 1~365 사이의 정수여야 합니다.');
            payload.schedule={frequency:payload.schedule_frequency,interval,timezone:payload.schedule_timezone,start_at:scheduleInstant(payload.schedule_start_at,payload.schedule_timezone)};
            if(payload.schedule_end_at){payload.schedule.end_at=scheduleInstant(payload.schedule_end_at,payload.schedule_timezone);if(payload.schedule.end_at<payload.schedule.start_at)throw new Error('마지막 실행 시각은 첫 실행 이후여야 합니다.');}
            if(payload.actions.some(action=>action.type==='set_property')&&!payload.row_id)throw new Error('속성을 변경할 대상 항목을 선택하세요.');
          }
          for(const key of ['schedule_frequency','schedule_interval','schedule_timezone','schedule_start_at','schedule_end_at'])delete payload[key];
          if(!payload.row_id)payload.row_id=null;
        }
         for(const key of ['enabled','published'])if($(`[name="${key}"]`,formElement))payload[key]=$(`[name="${key}"]`,formElement).checked; if(kind==='groups')payload.members=new FormData(formElement).getAll('members'); await api('/'+kind+(id?'/'+id:''),payload,id?'PATCH':'POST'); await refreshWorkspace(); await openSettings( {
          members:'members',groups:'members',teamspaces:'members',automations:'automations',forms:'forms',sites:'sites',integrations:'AI'
        }
        [kind]); toast('저장했습니다.'); break;
      }
      case'security-form': {
        await api('/settings', {
          name:data.workspace_name,disable_public_sharing:!formElement.allow_public_sharing.checked,disable_export:!formElement.allow_export.checked,disable_guests:formElement.disable_guests.checked,trash_retention_days:Number(data.trash_retention_days),custom_domain:data.custom_domain
        },'PATCH'); await refreshWorkspace(); toast('설정을 저장했습니다.'); break;
      }
      case'run-automation-form': {
        const result=await api('/automations/'+formElement.dataset.id+'/run', {
          row_id:data.row_id
        }); toast(result.message||'자동화를 실행했습니다.'); await openSettings('automations'); break;
      }
      case'ai-form': {
        const output=$('#ai-output'),scope={route:state.route,pageId:state.route==='page'?state.page?.id:undefined,channel:state.channel,epoch:state.channel?.base?.epoch,binding:state.session?.cache_binding,memberId:state.session?.member?.id,profileId:state.offlineProfile?.id,workspaceId:state.workspace?.workspace_id};
        const current=()=>formElement.isConnected&&output?.isConnected&&$('#ai-form')===formElement&&$('#ai-output')===output&&state.route===scope.route&&(scope.route!=='page'||!!scope.pageId&&!!scope.channel&&scope.channel.pageId===scope.pageId&&state.page?.id===scope.pageId)&&state.channel===scope.channel&&(!scope.channel||!scope.channel.closed&&scope.channel.base?.epoch===scope.epoch)&&state.session?.cache_binding===scope.binding&&state.session?.member?.id===scope.memberId&&state.offlineProfile?.id===scope.profileId&&state.workspace?.workspace_id===scope.workspaceId;
        if(!current())break;
        output.innerHTML='<div class="empty">응답을 준비하고 있어요…</div>';
        try {
          if(scope.route==='page')await savePage();
          if(!current())break;
          const r=await api('/ai',{...data,page_id:scope.pageId});
          if(!current())break;
          output.innerHTML=`<div class="ai-result">${esc(r.text||r.output||r.result||JSON.stringify(r))}</div><p class="small muted">${esc(r.provider||r.mode||'')}</p>`;
        } catch(error) {
          if(current())output.innerHTML=`<div class="info-box" style="margin-top:15px">${esc(error.message)}</div>`;
        }
        break;
      }
      case'import-form':await api('/import',data); await refreshWorkspace(); closeModal(); if(state.route==='home')renderHome(); toast('데이터를 가져왔습니다.'); break;
    }
  }
  catch(error) {
    if(formElement.id==='login-form'&&$('#login-error'))$('#login-error').textContent=error.message;
    toast(error instanceof SyntaxError?'JSON 형식을 확인해 주세요.':error.message);
  }
  finally {
    if(submit?.isConnected)submit.disabled=false;
  }
});
window.addEventListener('beforeunload',event=> {
  if(state.saveTimer||state.titlePending||state.titleSaving||state.saving||state.dirty) {
    event.preventDefault(); event.returnValue='';
  }
});
function renderLogin(preserve=true) {
  if(state.verifiedPages||state.adminConsole)closeModal();clearVerifiedPages();clearAdminConsole();clearWikiMutation();clearWikiPage();clearInbox();clearScimPanel();stopBackup();
  if(state.nativeRecoveryPaused)return;
  if(preserve)return suspendLoginInput().then(current=>{if(current)renderLogin(false);});
  closeDocument();closeMutations();state.offlineProfile=null;state.offline=false;
  state.loaded=false;
  state.workspace=null;state.page=null;state.blocks=[];state.database=null;state.rows=[];state.dirty=false;state.titlePending=null;clearTimeout(state.saveTimer);clearTimeout(state.titleTimer);
  $('#sidebar').innerHTML='';
  $('#topbar').innerHTML='';
  $('#main').innerHTML=`<div class="login-wrap"><div class="brand"><span class="brand-mark">f</span>fountain</div><h1>우리 가족의 작은 작업실</h1><p>가족과 나누는 문서, 아이디어, 일상.<br>${state.session?.mode==='accounts'?'내 이메일과 비밀번호로 로그인하세요.':'공유 암호를 입력하고 함께 시작하세요.'}</p><form class="form-grid" id="login-form">${state.session?.mode==='accounts'?'<label>이메일<input name="email" type="email" required autocomplete="username" autofocus placeholder="name@example.com"></label><label>비밀번호<input name="password" type="password" required autocomplete="current-password" placeholder="계정 비밀번호"></label>':'<label>공유 암호<input name="token" type="password" required autocomplete="current-password" autofocus placeholder="가족 공유 암호"></label>'}<button class="solid-btn">워크스페이스 열기</button><div id="login-error" role="alert"></div></form><p><a href="${esc(organizationURL())}">조직 소유자 로그인 및 관리 ↗</a></p><small class="muted">Fountain · 구독 없이, 함께 쓰는 공간</small></div>`;
  if(state.session?.mode==='accounts'&&state.session.setup_supported===true){
    const panel=document.createElement('details');panel.className='info-box';panel.open=!!setupCodeFromLink;
    panel.innerHTML='<summary>처음 연결하거나 초대받았나요?</summary><p>받은 연결 코드를 입력하세요. 처음 시작한다면 새 계정 만들기를 선택하세요.</p><label>연결 코드<input name="setup_nonce" type="password" autocomplete="off" spellcheck="false" maxlength="43" placeholder="받은 연결 코드"></label><label style="display:flex;gap:8px;align-items:center"><input name="create_account" type="checkbox" value="true" style="width:auto">새 계정 만들기</label><label id="setup-confirm" hidden>비밀번호 확인<input name="setup_password_confirm" type="password" autocomplete="new-password"></label>';
    if(state.accountMode){const label=document.createElement('label');label.textContent='연결할 작업공간 ID (연결 안내에 있는 경우)';const input=document.createElement('input');input.name='workspace_id';input.pattern='[A-Za-z0-9_-]{1,160}';input.maxLength=160;input.autocomplete='off';label.append(input);panel.append(label);}
    const form=$('#login-form');form.insertBefore(panel,$('button',form));$('input[name="setup_nonce"]',panel).value=setupCodeFromLink||'';
    $('input[name="create_account"]',panel).addEventListener('change',event=>{const creating=event.target.checked;$('#setup-confirm').hidden=!creating;$('input[name="setup_password_confirm"]',panel).required=creating;$('input[name="password"]',form).autocomplete=creating?'new-password':'current-password';});
  }
  document.body.classList.add('login-mode');
  if(state.authRetentionError&&$('#login-error'))$('#login-error').textContent=state.authRetentionError;
}
async function bootLegacy() {
  if(state.verifiedPages||state.adminConsole)closeModal();clearVerifiedPages();clearAdminConsole();clearWikiMutation();clearWikiPage();clearInbox();clearScimPanel();clearSearch();
  if(state.nativeRecoveryPaused)return;
  const generation=(state.bootGeneration||0)+1;state.bootGeneration=generation;
  const cachedIdentity=await window.FountainOffline?.getProfile().catch(()=>null);
  if(state.nativeRecoveryPaused||generation!==state.bootGeneration)return;
  let renewLegacyLocal=false;
  try {
    document.body.classList.remove('login-mode');
    if(localStorage.getItem(logoutPendingKey())){
      const marker=localStorage.getItem(logoutPendingKey()),record=JSON.parse(marker),clearMarker=()=>{if(localStorage.getItem(logoutPendingKey())===marker)localStorage.removeItem(logoutPendingKey());};
      if(!record.binding){clearMarker();renewLegacyLocal=record.mode==='local'&&!cachedIdentity;if(!cachedIdentity&&record.mode!=='local'){state.session={mode:['accounts','family'].includes(record.mode)?record.mode:'accounts',required:true,authenticated:false};renderLogin(false);return;}}
      else try{
        // A restart may follow a different login. Observe the actual private
        // session before replaying this binding-specific logout intent.
        const actual=await api('/session');if(generation!==state.bootGeneration||localStorage.getItem(logoutPendingKey())!==marker)return;
        const anonymous=actual.authenticated===false&&typeof actual.required==='boolean'&&['cache_binding','member','identity','expires_at'].every(key=>actual[key]==null)&&(actual.mode===undefined||['accounts','family','local'].includes(actual.mode));
        if(anonymous||actual.authenticated===true&&typeof actual.cache_binding==='string'&&actual.cache_binding&&actual.cache_binding!==record.binding)clearMarker();
        else if(actual.authenticated===true&&typeof actual.cache_binding==='string'&&actual.cache_binding===record.binding){await api('/session',{cache_binding:record.binding},'DELETE');clearMarker();}
        else throw Object.assign(new Error('현재 로그인을 서버에서 다시 확인한 뒤 종료해 주세요.'),{code:'NATIVE_SESSION_REQUIRED',status:503});
      }catch(error){
        if(error.code==='STALE_REQUEST'||generation!==state.bootGeneration)return;
        if(error.status===409)clearMarker();
        else if(!error.status){state.session={mode:['accounts','family','local'].includes(record.mode)?record.mode:'accounts',required:true,authenticated:false};renderLogin();return;}
        else throw error;
      }
    }
    let session=await api('/session');if(generation!==state.bootGeneration)return;
    if(renewLegacyLocal&&session.mode==='local'&&session.authenticated===true&&session.required===false&&session.member?.id==='local'){await api('/session/renew-local',{cache_binding:session.cache_binding});if(generation!==state.bootGeneration)return;session=await api('/session');if(generation!==state.bootGeneration)return;}
    if(session.authenticated&&state.offlineProfile&&(state.offlineProfile.session.cache_binding!==session.cache_binding||state.offlineProfile.memberId!==session.member?.id)){if(!await suspendLoginInput(state.offlineProfile))return;state.offlineProfile=null;return boot();}state.session=session;
    if(!state.session.authenticated&&state.session.required){if(await suspendLoginInput(state.offlineProfile||cachedIdentity))renderLogin(false);return;}
    state.offline=false;await refreshWorkspace();
    try{await cacheProfile();}catch(error){
      if(error.fountainCode!=='PROFILE_SUSPENDED')throw error;
      if(session.mode!=='local'||session.required!==false){renderLogin(false);return;}
      await api('/session/renew-local',{cache_binding:session.cache_binding});if(generation!==state.bootGeneration)return;
      state.session=await api('/session');if(generation!==state.bootGeneration)return;await refreshWorkspace();await cacheProfile();
    }if(generation!==state.bootGeneration)return;
    await ensureMutations();if(generation!==state.bootGeneration)return;
    if(publicReturnPath&&state.session.authenticated&&!state.offline){
      const path=publicReturnPath;publicReturnPath=null;
      location.replace(new URL(path,location.origin).href);return;
    }
    state.loaded=true;
    const [route,id]=location.hash.slice(1).split('/');
    if(['page','database'].includes(route)&&id)await navigate(route,decodeURIComponent(id));
    else await navigate('home');
    warmOfflinePages();
  }
  catch(e) {
    if(generation!==state.bootGeneration||e.code==='STALE_REQUEST')return;
    if(e.code==='SESSION_CHANGED'){boot();return;}
    if(!e.status&&(e instanceof TypeError||e.name==='NetworkError'||e.name==='TimeoutError')){
      const profile=await window.FountainOffline?.getProfile().catch(()=>null);
      if(state.nativeRecoveryPaused||generation!==state.bootGeneration)return;
      if(profile){state.offlineProfile=profile;state.session=profile.session;state.serverWorkspace=profile.workspace;state.workspace=profile.workspace;state.offline=true;await ensureMutations();if(state.nativeRecoveryPaused||generation!==state.bootGeneration)return;await cachedResourceIds();if(state.nativeRecoveryPaused||generation!==state.bootGeneration)return;state.loaded=true;renderSidebar();const [route,id]=location.hash.slice(1).split('/');await navigate(['page','database'].includes(route)&&id?route:'home',id?decodeURIComponent(id):undefined);return;}
    }
    if(e.status===401) {
      renderLogin();
      return;
    }
    $('#main').innerHTML=`<div class="empty"><h2>워크스페이스에 연결하지 못했어요.</h2><p>${esc(e.message)}</p><button class="outline-btn" data-action="reload">다시 시도</button></div>`;
  }
}
window.addEventListener('resize',()=>{if(state.route==='database'&&state.view==='timeline')requestAnimationFrame(focusTimeline);});
window.addEventListener('hashchange', () => {
  if(state.accountMode){let destination;try{destination=FountainWorkspaces.parseRoute(location.hash);}catch(error){toast(error.message);return;}if(destination.workspaceId!==state.session?.workspace_id||location.hash==='#workspaces'){void boot();return;}}
  if (!state.loaded||state.nativeRecoveryPaused||state.nativeOutboxPause) return;
  const {route,id:routeId}=state.accountMode?FountainWorkspaces.parseRoute(location.hash):{route:location.hash.slice(1).split('/')[0],id:undefined};
  const encodedId=state.accountMode?routeId:location.hash.slice(1).split('/')[1];
  let id;
  try { id = encodedId ? state.accountMode?encodedId:decodeURIComponent(encodedId) : undefined; }
  catch { return; }
  const currentId = state.route === 'page' ? state.page?.id : state.database?.id;
  if (route === state.route && (route === 'home' || id === currentId)) return;
  navigate(['page', 'database'].includes(route) && id ? route : 'home', id);
});
const workspaceOpenCommands = new Map(), workspaceHints = new Map();
const absentDirectoryKey=()=> 'fountain-account-directory-absent:'+encodeURIComponent(FountainTransport.origin);
function organizationURL() { const scope=FountainTransport.workspaceScope?.(); return './organization.html'+(scope?'?workspace_id='+encodeURIComponent(scope.workspaceId)+'&workspace_binding='+scope.binding:''); }
function workspaceRoute() { return FountainWorkspaces.parseRoute(location.hash); }
async function parkCurrentWorkspace() {
  if(state.workspaceSwitching)throw new Error('작업공간을 전환하고 있습니다.');
  const profile=state.offlineProfile;
  state.workspaceSwitching=true;state.bootGeneration=(state.bootGeneration||0)+1;
  const channel=state.channel, pauseOwner='workspace-switch-'+uid();
  channel?.pauseNetwork(pauseOwner);closeMutations();state.presenceManager?.close();state.uploadManager?.dispose();stopBackup();clearSearch();
  clearTimeout(state.saveTimer);clearTimeout(state.titleTimer);clearTimeout(state.mutationRefreshTimer);
  let lastEdits,forms=[];
  try {
    if(profile){
      // compositionend can arrive after the workspace switch. Materialize its
      // current DOM text against A's captured CRDT characters before closing A.
      const composition=state.composition;
      if(composition&&channel){const element=$$('.block').find(element=>element.dataset.id===composition.id)?.querySelector('.block-content');state.composition=null;if(element)commitEditableText(element,composition.chars,{kind:'composition',beforeSelection:composition.selection});}
      reconcileEditor();lastEdits=authenticationInput(profile);forms=unsubmittedNativeForms().map(form=>({...form,databaseId:state.database?.id,rowId:$('#row-form')?.dataset.id||null,pageId:state.page?.id||null,...(form.kind==='row'?{baselineRow:structuredClone(state.rowEditingBaseline),database:structuredClone(state.rowEditingDatabase)}:{})}));
      if(channel)await channel.persistPending();
      await FountainOffline.parkProfile(profile,{lastEdits,forms});
    }
    closeDocument();closeMutations();closeModal();
    if(state.endingAccount)await FountainOffline.endAccount(state.endingAccount);
    await FountainTransport.parkWorkspace();
    state.offlineProfile=null;state.loaded=false;state.workspace=null;state.serverWorkspace=null;state.page=null;state.blocks=[];state.database=null;state.rows=[];state.dirty=false;state.titlePending=null;state.titleSavingInput=null;
    return true;
  } catch(error) {
    if(profile){state.authRecoveryMemory||=new Map();state.authRecoveryMemory.set(profile.id,{profile:structuredClone(profile),lastEdits:{...lastEdits,formInput:forms},recoveryId:uid()});}
    state.workspaceSwitching=false;
    // The original editor remains available in RAM. B is never activated after
    // a failed durable save; the user can restore storage and retry the switch.
    channel?.resumeNetwork(pauseOwner);await ensureMutations().catch(()=>{});toast('입력을 기기에 보관하지 못해 전환을 멈췄습니다. 앱을 닫지 말고 다시 시도해 주세요.');throw error;
  }
}
async function showWorkspaceDirectory({park=true}={}) {
  const offlineParent=state.offlineProfile?.accountBinding;
  if(park&&state.offlineProfile)await parkCurrentWorkspace();
  state.workspaceSwitching=false;state.loaded=false;state.directory?.close();history.replaceState(null,'','#workspaces');
  document.body.classList.remove('login-mode');$('#sidebar').replaceChildren();$('#topbar').innerHTML='<span class="crumb">계정의 작업공간</span>';$('#main').replaceChildren();
  if(!state.account.session?.authenticated||navigator.onLine===false){for(const scope of FountainTransport.previousWorkspaceScopes?.()||[])if(scope.accountBinding===offlineParent&&!workspaceHints.has(scope.workspaceId))workspaceHints.set(scope.workspaceId,{scope,name:scope.workspaceId});if(!FountainTransport.native){for(const profile of await FountainOffline.offlineWorkspaces(offlineParent))workspaceHints.set(profile.workspaceId,{scope:FountainWorkspaceScope.fromSession(profile.session,0),name:profile.workspace?.settings?.name||profile.workspaceId});}const items=[...workspaceHints.entries()].filter(([,item])=>item.scope.accountBinding===offlineParent&&item.scope.expiresAt>Date.now());$('#main').innerHTML='<section class="workspace-directory"><h1>기기에 보관한 작업공간</h1><p>인터넷에 연결되면 계정의 전체 목록을 확인할 수 있습니다.</p>'+items.map(([id,item])=>'<button class="workspace-choice" data-offline-workspace="'+esc(id)+'">'+esc(item.name)+'</button>').join('')+'<button class="outline-btn" data-action="reload">연결 다시 확인</button></section>';$$('[data-offline-workspace]').forEach(button=>button.onclick=()=>{void openOfflineWorkspace({workspaceId:button.dataset.offlineWorkspace,route:'home'}).catch(error=>toast(error.message));});return;}
  state.directory=FountainWorkspaces.mount($('#main'),{account:state.account,onOpen:async(id,result)=>{state.directory?.close();await selectAccountWorkspace(id,'home',undefined,result);},onLogout:logoutAccount,onError:error=>{if(error.status===401)renderAccountLogin();}});
}
function renderAccountLogin(){state.workspaceSwitching=false;state.session={mode:'accounts',authenticated:false,required:true,setup_supported:true};renderLogin(false);if(state.account?.pendingLogout){const form=$('#login-form');form.querySelectorAll('input,button').forEach(element=>element.disabled=true);const retry=document.createElement('button');retry.className='outline-btn';retry.type='button';retry.textContent='로그아웃 완료 다시 시도';retry.onclick=()=>logoutAccount().catch(error=>toast(error.message));form.append(retry);}}
async function endCachedAccount(binding){if(FountainTransport.outboxEnabled&&!globalThis.FountainNativeStorage?.ready)return;await FountainOffline.endAccount(binding);}
async function logoutAccount(){
  const binding=state.account.pendingLogout||state.account.session?.cache_binding||state.session?.account_binding;
  state.endingAccount=binding;try{if(state.offlineProfile)await parkCurrentWorkspace();else await endCachedAccount(binding);}finally{state.endingAccount=null;}
  state.workspaceSwitching=true;state.bootGeneration=(state.bootGeneration||0)+1;closeDocument();closeMutations();closeModal();state.directory?.close();
  await FountainTransport.parkWorkspace();state.offlineProfile=null;state.loaded=false;state.workspace=null;
  try{await state.account.logout(binding);}finally{state.workspaceSwitching=false;renderAccountLogin();}
}
async function restoreWorkspaceForms(profile){
  const forms=await FountainOffline.workspaceInput(profile);if(state.offlineProfile?.id!==profile.id||!forms?.length)return;
  const form=forms[0];if(form.kind==='row'&&form.databaseId){if(state.database?.id!==form.databaseId)await navigate('database',form.databaseId);if(state.offlineProfile?.id!==profile.id)return;openRow(form.rowId||undefined,undefined,form);}
  const target=form.kind==='row'?$('#row-form'):form.kind==='comment'?$('#comment-form'):null;
  if(target){for(const field of form.fields){for(const control of [...target.elements].filter(control=>control.name===field.name||control.dataset.recoveryField===field.name)){if(control.disabled||control.readOnly)continue;if(control.type==='checkbox'||control.type==='radio')control.checked=field.value===true;else if(control.tagName==='SELECT'&&Array.isArray(field.value))for(const option of control.options)option.selected=field.value.includes(option.value);else if(typeof field.value==='string')control.value=field.value;}}toast('전환 전에 작성하던 입력을 다시 열었습니다.');}
}
async function selectAccountWorkspace(workspaceId,route='home',id,opened){
  if(!FountainWorkspaces.validId(workspaceId))throw new Error('작업공간 주소를 확인해 주세요.');
  if(state.offlineProfile)await parkCurrentWorkspace();
  const generation=(state.bootGeneration||0)+1;state.bootGeneration=generation;state.workspaceSwitching=true;let stored;
  try{
    const parent=state.account.parent();stored=await FountainOffline.workspaceProfile(parent,workspaceId);
    const key=parent+':'+workspaceId+':'+(stored?.cacheBinding||'');let command=workspaceOpenCommands.get(key);if(!command){command=uid();workspaceOpenCommands.set(key,command);}
    const result=opened||await state.account.open(workspaceId,stored?.cacheBinding||null,command);
    if(generation!==state.bootGeneration||state.account.parent()!==parent)return;
    if(result.workspace_id!==workspaceId||result.account_binding!==parent||result.session?.workspace_id!==workspaceId||result.session.account_binding!==parent)throw new Error('선택한 작업공간의 권한을 확인하지 못했습니다.');
    let scope=FountainWorkspaceScope.fromSession(result.session,FountainTransport.scopeEpoch||0);
    scope=await FountainTransport.setWorkspace(scope);if(generation!==state.bootGeneration)return;
    FountainOffline.selectWorkspace(scope);state.session=result.session;state.offline=false;state.workspaceSwitching=false;state.directory?.close();
    await refreshWorkspace();if(generation!==state.bootGeneration)return;await cacheProfile();if(generation!==state.bootGeneration)return;await ensureMutations();if(generation!==state.bootGeneration)return;
    state.loaded=true;document.body.classList.remove('login-mode');
    if(['form','site'].includes(route)){location.assign(FountainTransport.publicURL('/'+(route==='form'?'forms':'sites')+'/'+encodeURIComponent(id),state.session.public_web_origin));return;}
    workspaceHints.set(workspaceId,{scope:FountainTransport.workspaceScope(),name:state.workspace.settings?.name||workspaceId});await navigate(route,id);await restoreWorkspaceForms(state.offlineProfile);warmOfflinePages();
  }catch(error){if(generation!==state.bootGeneration||error.code==='STALE_REQUEST')return;state.workspaceSwitching=false;if(stored&&(error.status===403||error.code==='WORKSPACE_GRANT_CHANGED')){await FountainOffline.suspendProfile(stored).catch(()=>{});workspaceHints.delete(workspaceId);error.message='이전 작업공간 권한이 종료되어 편집을 보관했습니다. 내 작업공간에서 다시 열면 현재 권한을 확인합니다.';}if(error.status===401){await endCachedAccount(state.account.session?.cache_binding);renderAccountLogin();return;}$('#main').innerHTML='<div class="empty"><h2>작업공간을 열지 못했습니다.</h2><p>'+esc(error.message)+'</p><button class="outline-btn" data-action="workspaces">내 작업공간</button><button class="outline-btn" data-action="reload">다시 시도</button></div>';throw error;}
}
async function openWorkspaceInvitation(){
  if(!state.accountMode||!state.offlineProfile)return;
  const scope=FountainTransport.workspaceScope(),parent=state.account.parent();
  openModal('기존 계정 초대','<p>Fountain 계정이 있는 가족의 이메일을 입력하세요. 초대는 15분 동안 유효합니다.</p><form id="workspace-invite-form" class="form-grid"><label>이메일<input name="email" type="email" required autocomplete="off"></label><label>역할<select name="role"><option value="member">멤버</option><option value="guest">게스트</option><option value="admin">관리자</option></select></label><button class="solid-btn">초대 만들기</button></form><div id="workspace-invite-result" role="status"></div>');
  const form=$('#workspace-invite-form'),output=$('#workspace-invite-result');let pending=null;
  form.onsubmit=event=>{event.preventDefault();event.stopImmediatePropagation();void(async()=>{const current=()=>form.isConnected&&state.account.parent()===parent&&FountainTransport.workspaceScope()?.binding===scope.binding;if(!current())return;pending||={email:form.elements.email.value.trim(),role:form.elements.role.value,code:FountainWorkspaces.code(),expires_at_ms:Date.now()+15*60*1000,command:uid()};try{const result=await state.account.invite(scope.workspaceId,{workspace_binding:scope.binding,email:pending.email,role:pending.role,code:pending.code,expires_at_ms:pending.expires_at_ms},pending.command);if(!current())return;const invitation=FountainWorkspaces.encodeInvitation({workspace_id:scope.workspaceId,invitation_id:result.invitation_id,code:pending.code});output.replaceChildren();const label=document.createElement('label');label.textContent='가족에게 전달할 초대 코드';const input=document.createElement('textarea');input.readOnly=true;input.value=invitation;label.append(input);output.append(label);form.querySelector('button').disabled=true;}catch(error){if(current())output.textContent=error.message;}})();};
}
async function openOfflineWorkspace(destination){
  let profile,scope;
  if(FountainTransport.native){
    const hint=workspaceHints.get(destination.workspaceId)?.scope||FountainTransport.previousWorkspaceScope?.(destination.workspaceId);
    if(!hint||hint.workspaceId!==destination.workspaceId)return false;
    scope=await FountainTransport.setWorkspaceOffline(hint);FountainOffline.selectWorkspace(scope);profile=await FountainOffline.getProfile();
  }else{
    profile=await FountainOffline.offlineWorkspace(destination.workspaceId);if(!profile)return false;
    scope=FountainWorkspaceScope.fromSession(profile.session,FountainTransport.scopeEpoch||0);await FountainTransport.setWorkspace(scope);FountainOffline.selectWorkspace(scope);
    // A parked cache is resumed only after its original public capability and
    // permanent local fences have been checked; no new server grant is minted.
    await FountainOffline.saveProfile(profile);
  }
  if(!profile||profile.workspaceId!==destination.workspaceId||profile.cacheBinding!==scope.binding||profile.accountBinding!==scope.accountBinding)return false;
  workspaceHints.set(profile.workspaceId,{scope:FountainTransport.workspaceScope(),name:profile.workspace?.settings?.name||profile.workspaceId});state.accountMode=true;state.offlineProfile=profile;state.session=profile.session;state.workspace=profile.workspace;state.serverWorkspace=profile.workspace;state.offline=true;state.workspaceSwitching=false;await ensureMutations();await cachedResourceIds();state.loaded=true;document.body.classList.remove('login-mode');renderSidebar();await navigate(['page','database'].includes(destination.route)?destination.route:'home',destination.id);await restoreWorkspaceForms(profile);return true;
}
async function boot(){
  if(!globalThis.FountainAccount||state.accountMode===false)return bootLegacy();
  state.account ||= new FountainAccount.Account();
  try{
    const oldParent=state.session?.account_binding,session=await state.account.observe();state.accountMode=true;localStorage.removeItem(absentDirectoryKey());
    if(oldParent&&oldParent!==session.cache_binding)await endCachedAccount(oldParent);
    if(!session.authenticated){if(state.offlineProfile)await suspendLoginInput();renderAccountLogin();return;}
    const destination=workspaceRoute();if(destination.workspaceId)await selectAccountWorkspace(destination.workspaceId,destination.route,destination.id);else await showWorkspaceDirectory();
  }catch(error){
    if(state.accountMode===undefined&&(error.code==='ACCOUNT_DIRECTORY_ABSENT'||[404,405,501].includes(error.status))){state.accountMode=false;localStorage.setItem(absentDirectoryKey(),'1');if(FountainTransport.useLegacyWorkspace)await FountainTransport.useLegacyWorkspace({accountDirectoryAbsent:true});return bootLegacy();}
    if(error.code==='STALE_ACCOUNT'||error.code==='STALE_REQUEST')return;
    if(state.accountMode===undefined&&navigator.onLine===false&&localStorage.getItem(absentDirectoryKey())==='1'){state.accountMode=false;if(FountainTransport.useLegacyWorkspace)await FountainTransport.useLegacyWorkspace({accountDirectoryAbsent:true});return bootLegacy();}
    if(!error.status&&!FountainTransport.native&&navigator.onLine===false||FountainTransport.isNetworkUnavailable?.(error)){
      try{const destination=workspaceRoute();if(destination.workspaceId&&await openOfflineWorkspace(destination))return;}catch{/* A local or native authority failure never enables another login mode. */}
    }
    $('#main').innerHTML='<div class="empty"><h2>계정에 연결하지 못했습니다.</h2><p>'+esc(error.message)+'</p><button class="outline-btn" data-action="reload">다시 시도</button></div>';
  }
}
window.addEventListener('fountain-workspace-auth-required',event=>{if(state.accountMode&&event.detail?.accountBinding===state.account?.session?.cache_binding)state.account.end(event.detail.accountBinding);});
window.addEventListener('fountain-account-ended',event=>{if(!state.accountMode)return;for(const [id,item] of workspaceHints)if(item.scope.accountBinding===event.detail?.binding)workspaceHints.delete(id);for(const key of workspaceOpenCommands.keys())if(key.startsWith(event.detail?.binding+':'))workspaceOpenCommands.delete(key);state.workspaceSwitching=true;state.bootGeneration=(state.bootGeneration||0)+1;closeDocument();closeMutations();closeModal();void endCachedAccount(event.detail?.binding).catch(()=>{}).finally(()=>{void FountainTransport.parkWorkspace();state.offlineProfile=null;state.workspace=null;state.loaded=false;renderAccountLogin();});});

boot();
