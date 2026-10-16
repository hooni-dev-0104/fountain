'use strict';
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
function isOwner() { return state.session?.member?.role==='owner'; }
function isAdmin() { return ['owner','admin'].includes(state.session?.member?.role); }
function resourceLevel(resource) {
  return Number.isInteger(resource?.access_level)?resource.access_level:(state.session?.mode==='accounts'?0:4);
}
function pageEditable() { return !state.nativeRecoveryPaused&&resourceLevel(state.page)>=3&&!state.page?.locked&&!state.page?.archived; }
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
    $$('[data-action="add-page"],[data-action="new-database"]').forEach(el=>el.remove());
  }
  $$('[data-action="add-page"][data-parent]').forEach(el=>{
    const parent=state.workspace?.pages.find(p=>p.id===el.dataset.parent);
    if(parent&&resourceLevel(parent)<3)el.remove();
  });
}
// Durable entity edits share the current login binding with document drafts.
const serverOnlyActions=new Set(['new-database','teamspace','history','share','db-share','lock-page','delete-page','verify-page','move-page','duplicate-page','copy-blocks','new-property','task-settings','duplicate-row','restore-version','restore-page','trash','settings','ai','new-teamspace']);
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
    onChange:()=>{if(state.mutations!==controller)return;clearTimeout(state.mutationRefreshTimer);state.mutationRefreshTimer=setTimeout(()=>refreshMutationUI(controller).catch(error=>{if(state.mutations===controller)toast(error.message);}),80);},
    onDenied:async detail=>{
      if(state.mutations!==controller)return;
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
async function refreshMutationUI(controller=state.mutations) {
  if(!controller||state.mutations!==controller)return;
  const records=await controller.records();if(state.mutations!==controller)return;
  state.mutationRecords=records;
  const workspace=await controller.workspace(state.serverWorkspace||state.workspace);
  if(state.mutations!==controller)return;state.workspace=workspace;
  await cachedResourceIds();
  if(state.mutations!==controller)return;
  renderSidebar();renderSyncIndicators();
  if(state.route==='page'&&state.page){
    const local=await controller.localPage(state.page.id);
    if(state.mutations!==controller)return;
    state.localPageOnly=!!local?.metadata.localOnly;
    const basis=local?.metadata.page&&local.metadata.page.revision>=(state.channel?.base.page.revision||0)?local.metadata.page:state.channel?.base.page||state.page;
    state.page=metadataOverlay({...state.page,...basis,access_level:state.channel?.base.access_level??state.page.access_level});
    patchPageMetadataUI();
    if(!state.localPageOnly&&state.channel?.remoteDeferred){await state.channel.resumeRemote();}
    if(state.channel)documentStatus({status:state.channel.status,pending:state.channel.pending.size,durable:state.channel.durable!==false});
  }
  if(state.database&&['home','database'].includes(state.route)){
    const id=state.database.id;
    try{
      const data=await controller.loadDatabase(id,{remote:false});
      if(state.mutations!==controller||state.database?.id!==id)return;
      state.database=data.database;state.rows=data.rows||[];
      if(!$('.modal')&&!state.composition){
        if(state.route==='database')renderDatabase();
        else if($('#home-database')){$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;applyDatabaseControls();}
      }
    }catch(error){if(error.status&&[401,403,404].includes(error.status))toast(error.message);}
  }
  if($('#mutation-queue-list'))renderMutationQueue();
  syncCreatedPageBodies(controller).catch(error=>{if(state.mutations===controller&&error.status)toast(error.message);});
}
async function syncCreatedPageBodies(controller) {
  if(state.offline||!navigator.onLine||state.mutations!==controller||state.bodySyncRunning===controller)return;
  const profile=state.offlineProfile;state.bodySyncRunning=controller;
  try{
    for(const record of await FountainOffline.listLocalPages(profile)){
      if(state.mutations!==controller||state.offline)return;
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
      try{await channel.open(local.snapshot,{cached:true});if(state.mutations!==controller)return;await channel.resumeRemote();await channel.flush();await channel.persistence;}
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
    else if(view.memoryId){const entry=authenticationMemory().find(value=>value.profile.id===view.memoryId);if(!entry)throw new Error('현재 계정의 마지막 입력을 다시 확인해 주세요.');prepared=await view.scope.controller.prepareImport(JSON.stringify(authenticationMemoryFile(entry)),{targetPageId:entry.lastEdits.pageId,isCurrent:current});}
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
  const {pageId,draft,title}=lastEdits,records=[];
  if(title)records.push({id:recoveryId,profileId:profile.id,resourceKey:profile.id+'|'+encodeURIComponent(pageId),operation:{id:recoveryId,kind:'page.patch',target_id:pageId,depends_on:[],body:{title:title.title},base:{fields:{title:title.basePage?.title??null}}}});
  return {format:'fountain-recovery-v2',origin:profile.origin,workspace_id:profile.workspaceId,member_id:profile.memberId,source_binding:profile.cacheBinding,records,localPages:[],drafts:draft?[{page_id:pageId,draft}]:[]};
}
function renderRecoveryArchives(view) {
  if(!recoveryImportCurrent(view))return;
  const panel=$('#recovery-archives',view.modal);if(!panel)return;
  const memory=authenticationMemory();
  panel.innerHTML='<h3>이전 로그인에서 보관한 편집</h3><p>같은 계정의 기록을 현재 권한으로 확인합니다. 선택만으로 서버에 반영하지 않습니다.</p>'+(view.archivesError?`<p role="status">${esc(view.archivesError)}</p>`:view.archivesBusy?'<p role="status">보관 기록을 확인하고 있습니다…</p>':'')+(view.archives||[]).map(item=>`<div class="history-item"><div>보관한 편집 · ${Object.values(item.counts||{}).reduce((sum,count)=>sum+(Number.isSafeInteger(count)?count:0),0)}개<small>${date(item.createdAt)}</small></div><button class="outline-btn" data-action="prepare-archived-recovery" data-id="${esc(item.id)}">내용 확인</button></div>`).join('')+memory.map(value=>`<div class="history-item"><div>아직 저장하지 못한 마지막 입력<small>복구를 마칠 때까지 앱을 닫지 마세요.</small></div><button class="outline-btn" data-action="prepare-memory-recovery" data-id="${esc(value.profile.id)}">내용 확인</button></div>`).join('')+(!view.archivesBusy&&!view.archivesError&&!view.archives?.length&&!memory.length?'<p class="muted">이 계정에서 보관한 이전 편집이 없습니다.</p>':'')+(view.archivesNext?'<button class="outline-btn" data-action="more-archive-recovery">보관 기록 더 보기</button>':'');
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
async function syncMutations() {
  const controller=state.mutations;if(!controller)return;
  const expected=new Set((await controller.records()).filter(record=>['pending','deferred'].includes(record.status)).map(record=>record.id));
  try{
    for(let attempt=0;attempt<3;attempt++){
      await controller.sync();if(state.mutations!==controller)return;
      const records=await controller.records(),paused=new Set(records.filter(record=>!activeMutationStatuses.has(record.status)).map(record=>record.id));
      const remaining=records.filter(record=>expected.has(record.id)&&['pending','deferred'].includes(record.status));
      if(!remaining.length||remaining.every(record=>(record.operation.depends_on||[]).some(id=>paused.has(id))))break;
    }
  }catch(error){if(error.status&&error.status<500)throw error;state.offline=true;toast('서버에 연결하지 못했습니다. 변경은 기기에 보관했으며 다시 연결되면 동기화합니다.');}
  if(state.mutations!==controller)return;
  await refreshMutationUI(controller);
}
async function loadDatabaseData(id,{remote=!state.offline}={}) {
  const controller=await ensureMutations();
  const data=controller?await controller.loadDatabase(id,{remote}):await api('/databases/'+encodeURIComponent(id));
  if(controller&&controller!==state.mutations){const error=new Error('로그인 계정이 변경되었습니다.');error.code='STALE_REQUEST';throw error;}
  if(state.offlineProfile)await cachedResourceIds();
  return data;
}
async function api(path, body, method) {
  const requestScope={binding:state.session?.cache_binding,memberId:state.session?.member?.id,bootGeneration:state.bootGeneration};
  const stale=()=>{const error=new Error('로그인 상태가 변경되었습니다. 다시 확인해 주세요.');error.code='STALE_REQUEST';return error;};
  const assertCurrent=()=>{if(requestScope.binding!==state.session?.cache_binding||requestScope.memberId!==state.session?.member?.id||requestScope.bootGeneration!==state.bootGeneration)throw stale();};
  const response = await FountainTransport.request('/api' + path, {
    method:method || (body ? 'POST':'GET'),headers: {
      'Content-Type':'application/json'
    }, ...(body ? {
      body:JSON.stringify(body)
    }
    : {
    })
  });
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
      const session=await FountainTransport.request('/api/session').then(result=>result.json()).catch(()=>null);
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
async function refreshWorkspace() {
  const binding=state.session?.cache_binding,member=state.session?.member?.id;
  const workspace=await api('/workspace');
  if(binding!==state.session?.cache_binding||member!==state.session?.member?.id||workspace.current_member_id&&workspace.current_member_id!==member||workspace.session_binding&&workspace.session_binding!==binding){const error=new Error('로그인 정보를 다시 확인합니다.');error.code='SESSION_CHANGED';throw error;}
  const controller=state.mutations,overlay=controller?await controller.workspace(workspace):workspace;
  if(binding!==state.session?.cache_binding||controller!==state.mutations){const error=new Error('로그인 계정이 변경되었습니다.');error.code='STALE_REQUEST';throw error;}
  state.serverWorkspace=workspace;state.workspace=overlay;
  if(state.session?.authenticated&&window.FountainOffline)await cacheProfile().catch(error=>{if(error.name!=='SecurityError')toast(error.message);});
  renderSidebar();
}
function renderSidebar() {
  const w=state.workspace;
  if(!w)return;
  const pages=w.pages.filter(p=>!p.deleted&&!p.deleted_at&&!p.archived&&(!state.offline||state.cachedPages?.has(p.id)));
  const favorite=pages.filter(p=>p.favorite);
  const roots=pages.filter(p=>!p.parent_id);
  const pageItem=(p,depth=0)=>`<div class="nav-item page-nav ${state.page?.id===p.id&&state.route==='page'?'active':''}" style="padding-left:${10+depth*13}px"><button data-action="page" data-id="${esc(p.id)}" class="nav-item" style="padding:0;min-height:23px"><span class="page-icon">${esc(p.icon||'📄')}</span><span class="label">${esc(p.title||'제목 없음')}</span></button><button class="page-menu" aria-label="하위 페이지 추가" data-action="add-page" data-parent="${esc(p.id)}">+</button></div>${pages.filter(q=>q.parent_id===p.id).map(q=>pageItem(q,Math.min(depth+1,4))).join('')}`;
  $('#sidebar').innerHTML=`<div class="brand"><span class="brand-mark">f</span>fountain<span style="font-family:sans-serif;font-size:9px;letter-spacing:1px;color:#a5a497;margin-left:2px;font-weight:400">WORKSPACE</span></div><button class="workspace-switch" data-action="settings"><span class="workspace-avatar">F</span><span class="workspace-name">${esc(w.settings?.name||'Fountain 스튜디오')}<small>함께 만드는 작은 가능성</small></span>${icon('down')}</button><nav><button class="nav-item" data-action="search">${icon('search')}<span class="label">검색</span><span class="shortcut">⌘ K</span></button><button class="nav-item ${state.route==='home'?'active':''}" data-action="home">${icon('home')}<span class="label">홈</span></button><button class="nav-item" data-action="activity">${icon('inbox')}<span class="label">업데이트</span></button><button class="nav-item" data-action="ai">${icon('spark')}<span class="label">Fountain AI</span><span class="badge">AI</span></button></nav><div class="sidebar-pages"><div class="section-label">즐겨찾기<span>${icon('star')}</span></div>${favorite.length?favorite.map(p=>pageItem(p)).join(''):'<div class="small muted" style="padding:5px 12px;font-size:10px">자주 찾는 페이지를 모아보세요</div>'}<div class="section-label">팀스페이스<button data-action="new-teamspace" aria-label="팀스페이스 추가">+</button></div>${(w.teamspaces||[{id:'general',name:'Fountain 팀'}]).map(t=>`<button class="nav-item" data-action="teamspace" data-id="${esc(t.id)}"><span class="team-icon">${esc((t.name||'팀')[0])}</span><span class="label">${esc(t.name||'Fountain 팀')}</span>${icon('down')}</button>`).join('')}${(w.databases||[]).filter(d=>!state.offline||state.cachedDatabases?.has(d.id)).map(d=>`<button class="nav-item ${state.route==='database'&&state.database?.id===d.id?'active':''}" data-action="database" data-id="${esc(d.id)}" style="padding-left:20px"><span class="page-icon">${esc(d.icon||'▤')}</span><span class="label">${esc(d.name||d.title||'프로젝트')}</span></button>`).join('')}<div class="section-label">페이지<button data-action="add-page" aria-label="새 페이지">+</button></div>${roots.map(p=>pageItem(p)).join('')}<button class="nav-item muted" data-action="add-page">${icon('plus')}<span class="label">새 페이지</span></button><button class="nav-item muted" data-action="new-database">${icon('table')}<span class="label">새 데이터베이스</span></button></div><div class="sidebar-bottom">${state.offline?'<button class="nav-item" data-action="logout">로그아웃</button>':''}<button class="nav-item sync-status-button" data-action="sync-queue"><span aria-hidden="true">↻</span><span class="label" data-sync-label>기기 저장과 동기화</span></button><button class="nav-item" data-action="settings">${icon('settings')}<span class="label">설정 및 멤버</span></button><button class="nav-item" data-action="trash">${icon('trash')}<span class="label">휴지통</span></button><div class="invite-card"><strong>좋은 생각은, 함께 자라니까요.</strong>팀원을 초대하고 한곳에서 시작하세요.<br><button data-action="invite">멤버 초대하기 ↗</button></div></div>`;
  pruneAdministrativeControls();renderSyncIndicators();
}
function renderTopbar(title='홈',emoji='') {
  $('#topbar').innerHTML=`<div class="crumb"><button class="mobile-toggle" data-action="toggle-sidebar" aria-label="메뉴 열기">${icon('menu')}</button><button data-action="home">Fountain 스튜디오</button><span>/</span><span>${esc(emoji)}</span><span class="current">${esc(title)}</span></div><div class="top-actions"><span class="save-status" id="save-status">${state.route==='page'?'모든 변경 사항 저장됨':'나만의 리듬으로, 함께'}</span><button class="sync-status-button sync-topbar" data-action="sync-queue" title="기기 저장과 동기화"><span aria-hidden="true">↻</span><span data-sync-label>기기 저장</span></button><div id="page-presence" class="page-presence" aria-label="현재 페이지 접속자" role="status"></div>${state.route==='page'?`<button ${resourceLevel(state.page)<3?'disabled':''} data-action="favorite" aria-label="즐겨찾기">${icon('star')}</button><button data-action="share" aria-label="페이지 공유">${icon('share')}공유</button><button ${resourceLevel(state.page)<3?'disabled':''} data-action="history" aria-label="페이지 기록">${icon('clock')}</button><button data-action="page-menu" aria-label="페이지 메뉴">${icon('dots')}</button>`:`${state.route==='database'?`<button data-action="db-share">${icon('share')}공유</button>`:''}<button class="desktop-only" data-action="activity" aria-label="활동 기록">${icon('clock')}</button><button data-action="settings" aria-label="설정">${icon('dots')}</button>`}</div>`;
  pruneAdministrativeControls();renderSyncIndicators();renderPresenceParticipants(state.presenceManager?.participants||[]);
}
async function navigate(route,id) {
  if(state.nativeRecoveryPaused)return;
  state.uploadTargetPageId=route==='page'?id:null;state.uploadManager?.pauseAll('다른 문서를 여는 동안 파일 전송을 일시 중지했습니다.');
  const binding=state.session?.cache_binding,generation=state.bootGeneration;
  const current=()=>!state.nativeRecoveryPaused&&binding===state.session?.cache_binding&&generation===state.bootGeneration;
  try {
    await saveTitle();if(!current())return;
    await savePage();if(!current())return;
    closeDocument();
    closeModal();
    document.body.classList.remove('sidebar-open');
    state.route=route;if(route!=='page')state.localPageOnly=false;
    if(route==='page') {
      state.dirty=false;
      const local=await state.mutations?.localPage(id);
      if(binding!==state.session?.cache_binding||generation!==state.bootGeneration)return;
      state.localPageOnly=!!local?.metadata.localOnly;
      if(state.offline||state.localPageOnly){
        const snapshot=local?.snapshot||await FountainOffline.getSnapshot(FountainOffline.key(state.offlineProfile,id));
        if(!current())return;
        if(!snapshot)throw new Error('이 페이지는 기기에 보관되어 있지 않습니다. 연결 후 한 번 열어 주세요.');
        await openDocument(id,null,snapshot);
      }else{
        const detail=await api('/pages/'+encodeURIComponent(id));if(binding!==state.session?.cache_binding||generation!==state.bootGeneration)return;await openDocument(id,detail);
      }
      if(!current())return;renderPage();
      location.hash='page/'+id;
    }
    else if(route==='database') {
      state.localPageOnly=false;state.navigatingDatabaseId=id;
      const data=await loadDatabaseData(id);if(!current())return;state.navigatingDatabaseId=null;
      state.database=data.database;
      state.rows=data.rows||[];
      renderDatabase();
      location.hash='database/'+id;
    }
    else {
      renderHome();
      location.hash='home';
    }
    renderSidebar();
    window.scrollTo(0,0);
  }
  catch(error) {
    if(!current())return;
    if(!error.status&&error instanceof TypeError&&['page','database'].includes(route)&&!state.offline&&state.offlineProfile){state.offline=true;state.cachedPages=new Set((await FountainOffline.listSnapshots(state.offlineProfile)).map(record=>record.snapshot.page.id));await navigate(route,id);return;}
    state.navigatingDatabaseId=null;
    if(error.code==='STALE_REQUEST')return;if(error.code==='SESSION_CHANGED'){boot();return;}toast(error.message);
  }
}
function renderHome() {
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
  if(state.nativeRecoveryPaused||state.authSuspending)return;
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
  if(!state.loaded||state.nativeRecoveryPaused)return;
  if(!state.mutations){if(!state.channel&&state.offline)boot();return;}
  const controller=state.mutations,binding=state.session?.cache_binding;
  try{
    const session=await api('/session');if(state.mutations!==controller||binding!==state.session?.cache_binding)return;
    if(!session.authenticated||session.cache_binding!==binding){boot();return;}
    state.offline=false;await refreshWorkspace();if(state.mutations!==controller)return;
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
  const profile=state.offlineProfile,generation=state.bootGeneration;if(!profile||state.offline)return;
  const allowed=new Set(state.workspace.pages.filter(page=>!page.archived).map(page=>page.id));
  const ids=[...new Set([...state.workspace.pages.filter(page=>page.favorite&&!page.archived).map(page=>page.id),...recentPageIds(profile)])].filter(id=>allowed.has(id)).slice(0,20);
  for(const id of ids){
    if(generation!==state.bootGeneration||state.offlineProfile?.id!==profile.id)return;
    const key=FountainOffline.key(profile,id);
    try{
      if((await state.mutations?.localPage(id))?.metadata.localOnly)continue;
      const response=await FountainTransport.request('/api/pages/'+encodeURIComponent(id)+'/collaboration');
      if(generation!==state.bootGeneration||state.offlineProfile?.id!==profile.id)return;
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
  if(state.versionView)closeModal();state.versions=[];
  state.presenceManager?.close();state.presenceManager=null;state.presenceChannel=null;
  state.uploadManager?.dispose();state.uploadManager=null;state.uploadReselectId=null;
  state.channel?.close();state.channel=null;state.history={};state.expectedSelection=null;state.renderedChars=new Map();state.composition=null;state.inputBaseline=null;clearTimeout(state.saveTimer);state.saveTimer=null;state.recoveryDrafts=[];
}
function documentStatus({status,pending,durable=true}) {
  if(!state.channel||state.route!=='page')return;
  state.offline=!navigator.onLine||status==='offline';state.dirty=durable===false;
  const element=$('#save-status');if(element)element.textContent=status==='offline'?(durable?(nativeCacheOnly()?'오프라인 · 앱 캐시에 보관됨':'오프라인 · 기기에 저장됨'):'오프라인 · 기기 저장 실패'):status==='error'?'동기화 확인 필요':state.localPageOnly?(nativeCacheOnly()?'앱 캐시에 보관됨 · 새 페이지 동기화 대기':'기기에 저장됨 · 새 페이지 동기화 대기'):pending?'변경 사항 동기화 중…':'모든 변경 사항 저장됨';
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
  if(!window.FountainPresence||!channel||!profile||state.route!=='page'||state.openingDocument)return;
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
  const current=()=>!state.nativeRecoveryPaused&&binding===state.session?.cache_binding&&generation===state.bootGeneration;
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
      if(state.channel!==channel||state.route!=='page')return;
      const beforeEditable=pageEditable(),selection=change.selection||selectedTextPosition();
      state.page=metadataOverlay({...change.snapshot.page,access_level:change.snapshot.access_level},change.snapshot);state.blocks=change.blocks;invalidateVersionView();
      if(!pageEditable())state.uploadManager?.pauseAll('문서가 읽기 전용으로 바뀌어 전송을 일시 중지했습니다.');
      ensurePresence();
      if(state.openingDocument||state.composition)return;
      if(beforeEditable!==pageEditable()){renderPage();return;}
      patchDocumentBlocks(selection);
      patchPageMetadataUI();
    },onHistory:history=>{if(state.channel===channel)refreshHistoryControls(history);},onStatus:documentStatus,onDraft:drafts=>{if(state.channel===channel){state.recoveryDrafts=drafts;renderRecoveryDrafts();}},
    onError:error=>{if(state.channel===channel)toast(error.message);},
    onDenied:async({status,message,switched})=>{
      if(state.channel!==channel&&state.channel!==null)return;
      if(status===401){if(!await suspendLoginInput(state.offlineProfile))return;if(switched||state.session?.mode==='local'&&state.session.required===false){state.offlineProfile=null;await boot();}else renderLogin(false);return;}
      closeDocument();state.page=null;state.blocks=[];state.dirty=false;
      if(switched){state.offlineProfile=null;boot();return;}
      if(status===401)renderLogin(false);else{$('#main').innerHTML=`<div class="empty"><h2>이 문서에 접근할 수 없습니다.</h2><p>${esc(message)}</p><button class="outline-btn" data-action="home">홈으로 돌아가기</button></div>`;if(state.workspace)state.workspace.pages=state.workspace.pages.filter(page=>page.id!==id);renderSidebar();renderTopbar('접근 권한 없음');}
    }});
  state.channel=channel;await channel.open(snapshot,{cached:!!cachedSnapshot});if(!current()||state.channel!==channel){channel.close();return;}if(state.localPageOnly&&!state.blocks.length&&pageEditable()){channel.transact({kind:'structure',record:false},()=>channel.reconcile([{id:uid(),type:'paragraph',text:'',parent_id:null}]));await channel.persistence;}state.openingDocument=false;recordRecentPage(id);
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
  if(state.nativeRecoveryPaused)return;
  const p=state.page;state.pageViewBasis=structuredClone(p);
  renderTopbar(p.title,p.icon);
  $('#main').innerHTML=`${p.cover?'<div class="page-cover"></div>':''}<article class="editor-wrap ${p.cover?'has-cover':''}"><button class="page-emoji" data-action="change-icon" aria-label="페이지 아이콘 변경">${esc(p.icon||'📄')}</button><h1 class="page-title" id="page-title" contenteditable="${pageEditable()}" role="textbox" aria-label="페이지 제목">${esc(p.title)}</h1><div class="page-tools" style="flex-wrap:wrap"><span>${icon('clock')}</span><span>${date(p.updated_at)} 수정</span><button data-action="favorite" class="${p.favorite?'favorite-on':''}">${p.favorite?'★ 즐겨찾기':'☆ 즐겨찾기'}</button><button data-action="toggle-cover">${p.cover?'커버 제거':'커버 추가'}</button>${!pageEditable()?'<span>🔒 읽기 전용</span>':'<button data-action="add-file" title="파일당 최대 5 GB">📎 파일 추가</button><input id="attachment-input" type="file" aria-label="첨부할 파일 (최대 5 GB)" hidden>'}<button data-action="ai" style="margin-left:auto">✦ AI 도우미</button></div>${pageEditable()?`<div class="rich-toolbar" aria-label="본문 편집"><button data-action="undo" aria-label="실행 취소" title="실행 취소 (⌘/Ctrl Z)">↶</button><button data-action="redo" aria-label="다시 실행" title="다시 실행 (⌘/Ctrl Shift Z)">↷</button><span class="history-divider" aria-hidden="true"></span><button data-action="rich-mark" data-mark="bold" aria-label="굵게"><b>B</b></button><button data-action="rich-mark" data-mark="italic" aria-label="기울임"><i>I</i></button><button data-action="rich-mark" data-mark="underline" aria-label="밑줄"><u>U</u></button><button data-action="rich-mark" data-mark="strike" aria-label="취소선"><s>S</s></button><button data-action="rich-mark" data-mark="code" aria-label="인라인 코드">&lt;/&gt;</button><button data-action="rich-link">${icon('link')}링크</button><label>글자색<select id="rich-color" aria-label="글자색"><option value="default">기본</option>${FountainCollaboration.PALETTE.filter(color=>color!=='default').map(color=>`<option value="${color}">${esc(({gray:'회색',brown:'갈색',orange:'주황',yellow:'노랑',green:'초록',blue:'파랑',purple:'보라',pink:'분홍',red:'빨강'})[color])}</option>`).join('')}</select></label><label>배경<select id="rich-background" aria-label="글자 배경"><option value="default">없음</option>${FountainCollaboration.PALETTE.filter(color=>color!=='default').map(color=>`<option value="${color}">${esc(({gray:'회색',brown:'갈색',orange:'주황',yellow:'노랑',green:'초록',blue:'파랑',purple:'보라',pink:'분홍',red:'빨강'})[color])}</option>`).join('')}</select></label></div>`:''}<div id="blocks" aria-label="페이지 블록">${state.blocks.map(blockHTML).join('')}</div>${pageEditable()?'<button class="editor-end" data-action="add-block"><span>+</span> 글을 쓰거나 ‘/’로 블록을 추가하세요</button>':''}<section class="comment-section"><h3>댓글 <span class="muted">${state.comments.filter(c=>!c.resolved).length}</span></h3><div id="comments">${commentsHTML()}</div><form class="comment-form" id="comment-form"><input name="text" aria-label="댓글 내용" placeholder="생각을 나눠보세요…" required maxlength="10000"><button class="outline-btn">보내기 ${icon('arrow')}</button></form></section></article>`;
  if(!pageEditable()) {
    for(const action of ['change-icon','favorite','toggle-cover'])$$(`[data-action="${action}"]`).forEach(el=>el.disabled=true);
  }
  if(resourceLevel(p)<2)$('#comment-form')?.remove();
  state.renderedChars=new Map(state.blocks.map(block=>[block.id,state.channel?.chars(block.id)||[]]));
  documentStatus({status:state.channel?.status||'synced',pending:state.channel?.pending.size||0,durable:state.channel?.durable!==false});renderRecoveryDrafts();ensureUploads();
  pruneAdministrativeControls();

}
function patchPageMetadataUI() {
  if(!state.page||state.route!=='page')return;
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
  if(!state.channel)return;
  reconcileEditor();state.dirty=false;
  clearTimeout(state.saveTimer);state.saveTimer=setTimeout(()=>savePage().catch(error=>toast(error.message)),250);
}
async function savePage() {
  clearTimeout(state.saveTimer);state.saveTimer=null;
  if(state.route!=='page'||!state.channel)return;
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
  return `<div class="task-list"><div class="task-list-heading"><span>프로젝트</span><span>상태</span><span>일정</span></div>${rowHierarchy(rows).map(item=>`<div class="task-list-row" data-action="edit-row" data-id="${esc(item.row.id)}" role="button" tabindex="0">${taskTitle(item)}<span>${status(valuesOf(item.row)[statusProperty?.id])}</span><span class="task-date">${esc(dateRangeLabel(valuesOf(item.row)[dateProperty?.id]))}</span></div>`).join('')||'<div class="empty">표시할 항목이 없습니다.</div>'}</div>${canCreateRow()?'<button class="new-row" data-action="add-row">+ 새 항목</button>':''}`;
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
  return `<div class="db-toolbar"><div class="view-tabs">${[['table','테이블','table'],['board','보드','board'],...(!compact?[['timeline','타임라인','calendar'],['list','리스트','menu'],['calendar','캘린더','calendar'],['gallery','갤러리','grid'],['chart','차트','chart']]:[])].map(([v,n,i])=>`<button data-action="db-view" data-view="${v}" class="${state.view===v?'active':''}">${icon(i)}${n}</button>`).join('')}</div><div class="db-actions"><button data-action="filter" aria-label="필터">${icon('filter')}</button>${!compact?'<button data-action="db-export" aria-label="CSV 내보내기">↗</button><button data-action="new-property" aria-label="속성 추가">＋ 속성</button><button data-action="task-settings" aria-label="프로젝트 일정 설정">⚙ 일정</button>':''}<button class="solid-btn" data-action="add-row">새로 만들기 ${icon('down')}</button></div></div>`;
}
function tableHTML(rows,compact=false) {
  const props=(state.database?.properties||[]).slice(0,compact?4:20);
  return `<div class="data-table-scroll"><table class="data-table" style="--table-columns:${props.length}"><thead><tr>${props.map(property=>`<th>${property.type==='title'?'Aa':property.type==='status'?'◉':property.type==='date'?'▦':property.type==='person'?'☻':'≡'} &nbsp;${esc(property.name)}</th>`).join('')}</tr></thead><tbody>${rowHierarchy(rows).map(item=>`<tr tabindex="0" role="button" data-action="edit-row" data-id="${esc(item.row.id)}" aria-label="${esc(nameOf(item.row))}">${props.map((property,index)=>{const value=valuesOf(item.row)[property.id];return `<td>${index===0?taskTitle(item):['status','select'].includes(property.type)?status(value):property.type==='checkbox'?value?'☑':'☐':property.type==='date'?esc(dateRangeLabel(value)):property.type==='person'?esc(state.workspace.members.find(member=>member.id===value)?.name||value||'—'):esc(Array.isArray(value)?value.join(', '):value||'—')}</td>`;}).join('')}</tr>`).join('')}</tbody></table>${!rows.length?'<div class="empty">아직 항목이 없어요. 첫 번째 항목을 추가해 보세요.</div>':''}</div>`;
}
function filteredRows() {
  let rows=[...state.rows];
  if(state.filter)rows=rows.filter(r=>Object.values(valuesOf(r)).some(v=>(dateRange(v)?dateRangeLabel(v):String(v)).toLowerCase().includes(state.filter.toLowerCase())));
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
    return `<div class="board">${options.map(value=>`<div class="board-column"><h3>${status(value)}<span>${rows.filter(r=>(valuesOf(r)[group?.id]||'미지정')===value).length}</span></h3>${rows.filter(r=>(valuesOf(r)[group?.id]||'미지정')===value).map(r=>`<button class="board-card" data-action="edit-row" data-id="${esc(r.id)}">${esc(valuesOf(r)[title.id]||'제목 없음')}<small>${esc(Object.values(valuesOf(r)).slice(1).filter(Boolean).map(value=>dateRange(value)?dateRangeLabel(value):Array.isArray(value)?value.join(', '):String(value)).join(' · '))}</small></button>`).join('')}<button class="new-row" data-action="add-row" data-status="${esc(value)}">+ 새 항목</button></div>`).join('')}</div>`;
  }
  if(state.view==='gallery')return `<div class="gallery">${rows.map(r=>`<button class="board-card" data-action="edit-row" data-id="${esc(r.id)}">${esc(nameOf(r))}<small>${esc(Object.values(valuesOf(r)).slice(1).filter(Boolean).map(value=>dateRange(value)?dateRangeLabel(value):Array.isArray(value)?value.join(', '):String(value)).join(' · '))}</small></button>`).join('')}</div>`;
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
  if(state.nativeRecoveryPaused)return;
  renderTopbar(state.database.name||state.database.title,'▤');
  $('#main').innerHTML=`<section class="db-full"><div class="eyebrow">TEAM WORK, IN ONE PLACE</div><div class="database-heading"><h1>▤ ${esc(state.database.name||state.database.title||'프로젝트')}</h1><button class="outline-btn" data-action="db-export">↗ CSV 내보내기</button></div><p class="muted">작은 할 일부터 큰 목표까지, 우리의 다음 한 걸음을 함께 기록해요.</p><div class="panel">${databaseToolbar()}<div id="db-filters" ${state.filter?'':'hidden'} class="filters"><input id="db-filter-input" aria-label="항목 필터" placeholder="모든 속성에서 검색" value="${esc(state.filter)}"><button class="outline-btn" data-action="db-sort">이름 ${state.sort?'↓':'↕'} 정렬</button><button data-action="clear-filter" aria-label="필터 해제">×</button></div><div id="db-view">${databaseView()}</div></div></section>`;
  applyDatabaseControls();
  if(state.view==='timeline')focusTimeline();
}
async function reloadDatabase() {
  const data=await loadDatabaseData(state.database.id);
  state.database=data.database;
  state.rows=data.rows;
  if(state.route==='database')renderDatabase();
  else if($('#home-database'))$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;
  applyDatabaseControls();
}
function openModal(title,content,cls='') {
  clearRecoveryImport();state.versionView=null;closeSlash();
  $('#overlay-root').innerHTML=`<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-action="close-modal" aria-label="닫기">×</button></header><div class="modal-body">${content}</div></section></div>`;
  if(state.route==='page'&&resourceLevel(state.page)<4)$$('[data-action="delete-page"],[data-action="move-page"]',$('.modal')).forEach(el=>el.remove());
  if(state.route==='page'&&resourceLevel(state.page)<3){for(const action of ['lock-page','delete-page','verify-page','move-page','change-block-type','move-block','delete-block','restore-version'])$$(`[data-action="${action}"]`,$('.modal')).forEach(el=>el.remove());}
  pruneAdministrativeControls();
  const body=$('.modal-body');
  requestAnimationFrame(()=>{if(body?.isConnected)$('input:not([type=checkbox]),textarea,select,button',body)?.focus();});
}
function closeModal() {
  clearRecoveryImport();state.versionView=null;$('#overlay-root').innerHTML='';
  closeSlash();
}
function field(label,name,placeholder='',type='text',value='') {
  return `<label>${label}<input name="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${type==='text'?'maxlength="300"':''}></label>`;
}
function form(content,id,submit='만들기') {
  return `<form class="form-grid" id="${id}">${content}<div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn">${submit}</button></div></form>`;
}
function openSearch() {
  openModal('워크스페이스 검색','<input class="search-input" id="search-input" placeholder="페이지와 아이디어를 찾아보세요…" aria-label="검색어"><div class="search-results" id="search-results"></div><div class="keyboard-hint">Enter로 열기 &nbsp; · &nbsp; Esc로 닫기</div>','search-modal');
  $('.modal-body').style.padding='0';
  $('.modal-head').style.display='none';
  renderSearch('');
}
async function renderSearch(q) {
  try {
    const data=state.offline?{results:[...state.workspace.pages.filter(page=>state.cachedPages?.has(page.id)).map(page=>({...page,type:'page'})),...state.workspace.databases.filter(database=>state.cachedDatabases?.has(database.id)).map(database=>({...database,title:database.name,type:'database'}))].filter(item=>(item.title||'').toLowerCase().includes(q.toLowerCase()))}:await api('/search?q='+encodeURIComponent(q));
    if(!$('#search-results'))return;
    const results=normalizeList(data.results||data.pages||data);
    $('#search-results').innerHTML=results.length?results.map(p=>`<button class="search-result" data-action="${p.type==='database'?'database':'page'}" data-id="${esc(p.id||p.page_id)}"><span class="page-icon">${esc(p.icon||'📄')}</span><span>${esc(p.title||p.name)}<small style="display:block">${esc(p.excerpt||p.snippet||'Fountain 스튜디오')}</small></span><span class="muted" style="margin-left:auto">↵</span></button>`).join(''):'<div class="empty">검색 결과가 없어요. 다른 단어로 찾아보세요.</div>';
  }
  catch(e) {
    toast(e.message);
  }
}
function openRow(id,initialStatus) {
  const row=state.rows.find(r=>r.id===id);
  state.rowEditingBaseline=row?structuredClone(row):null;state.rowEditingDatabase=structuredClone(state.database);
  const vals=row?valuesOf(row):state.database.row_permissions?.mode==='assigned'?{[state.database.row_permissions.property_id]:state.session?.member?.id||''}:{};
  const props=state.database.properties;
  const editable=row?resourceLevel(row)>=3:canCreateRow();
  if(!row&&!editable)throw new Error('항목 생성 권한이 없습니다.');
  openModal(row?'프로젝트 상세':'새 프로젝트',`<form id="row-form" data-id="${esc(id||'')}" class="form-grid"><div class="row-properties">${props.map(p=>{const value=vals[p.id]??(p.type==='status'?initialStatus:'')??'';let input;if(p.type==='person'){const options=(state.workspace.members||[]).map(m=>({value:m.id,label:m.name||m.email||m.id}));if(value&&!options.some(o=>o.value===value))options.unshift({value,label:String(value)});input=`<select name="${esc(p.id)}"><option value="">미지정</option>${options.map(o=>`<option value="${esc(o.value)}" ${o.value===value?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`;}else if(['status','select'].includes(p.type)){let options=optionsOf(p);if(value&&!options.includes(value))options.unshift(value);input=`<select name="${esc(p.id)}"><option value="">미지정</option>${options.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select>`;}else if(p.type==='date'){const range=dateRange(value);input=`<span class="date-range-inputs"><input name="${esc(p.id)}" type="date" aria-label="${esc(p.name)} 시작일" value="${esc(range?.startISO||'')}"><span>→</span><input name="${esc(p.id)}__end" type="date" aria-label="${esc(p.name)} 종료일" value="${esc(typeof value==='object'&&value&&value.end?range?.endISO||'':'')}"></span>`;}else if(p.type==='checkbox')input=`<input name="${esc(p.id)}" type="checkbox" ${value?'checked':''} style="width:auto;justify-self:start">`;else input=`<input ${['formula','rollup','created_time','last_edited_time'].includes(p.type)?'readonly':''} name="${esc(p.id)}" value="${esc(Array.isArray(value)?value.join(', '):value)}" type="${p.type==='number'?'number':p.type==='date'?'date':p.type==='url'?'url':p.type==='email'?'email':'text'}" ${p.type==='title'?'required':''}>`;return `<label>${esc(p.name)}${input}</label>`;}).join('')}</div>${state.database.task_settings?.subitems===true?`<label>상위 항목<select name="parent_row_id"><option value="">최상위 항목</option>${state.rows.filter(candidate=>candidate.id!==id).map(candidate=>`<option value="${esc(candidate.id)}" ${row?.parent_row_id===candidate.id?'selected':''}>${esc(nameOf(candidate))}</option>`).join('')}</select></label>`:''}${state.database.task_settings?.dependencies===true?`<label>선행 항목<select name="depends_on" multiple aria-label="선행 항목" style="min-height:90px">${state.rows.filter(candidate=>candidate.id!==id).map(candidate=>`<option value="${esc(candidate.id)}" ${(row?.depends_on||[]).includes(candidate.id)?'selected':''}>${esc(nameOf(candidate))}</option>`).join('')}</select><small class="muted">선택한 작업이 먼저 끝난 뒤 이 작업이 시작됩니다. 여러 항목은 Ctrl 또는 ⌘ 키로 선택하세요.</small></label>`:''}<div class="form-actions">${row&&canCreateRow()?`<button type="button" class="outline-btn" data-action="duplicate-row" data-id="${esc(id)}">하위 항목과 복제</button>`:''}${row?`<button type="button" class="danger-btn" data-action="delete-row" data-id="${esc(id)}" style="margin-right:auto">삭제</button>`:''}<button type="button" class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn">저장하기</button></div></form>`);
  if(!editable){
    $$('#row-form input,#row-form select,#row-form textarea').forEach(el=>el.disabled=true);
    $('#row-form .solid-btn')?.remove();$('#row-form .danger-btn')?.remove();
  }

}
function taskGraphChanges(formElement,data) {
  const existing=state.rowEditingBaseline?.id===formElement.dataset.id?state.rowEditingBaseline:null,changes={};
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
  if(resourceLevel(state.database)<4)$$('[data-action="new-property"],[data-action="task-settings"]').forEach(el=>el.remove());
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
  openModal(kind==='pages'?'페이지 공유 및 권한':'데이터베이스 공유 및 권한',`<p>링크를 전달해도 아래에서 허용한 사람만 열 수 있습니다. 워크스페이스 소유자는 모든 문서에 접근할 수 있습니다. 그 외 멤버의 명시적 차단은 그룹과 상위 페이지의 허용보다 우선합니다.</p><div style="display:flex;gap:8px;margin-bottom:20px"><input id="share-url" style="flex:1;min-width:0" readonly value="${esc(FountainTransport.appURL((kind==='pages'?'page':'database')+'/'+encodeURIComponent(id)))}"><button class="outline-btn" data-action="copy-link">${icon('link')}링크 복사</button></div>${!manage?'<div class="info-box">현재 공유 설정을 볼 수 있습니다. 소유자 또는 전체 권한을 가진 사람만 변경할 수 있습니다.</div>':''}<form id="permissions-form" data-kind="${kind}" data-id="${esc(id)}" class="form-grid" style="margin-top:18px"><label>기본 공유 범위<select name="default" ${!manage?'disabled':''}><option value="private" ${acl.default==='private'?'selected':''}>지정·상속된 사람만 · 비공개</option><option value="workspace" ${acl.default==='workspace'?'selected':''}>워크스페이스 멤버 · 편집 (게스트 제외)</option></select></label><label style="display:flex;align-items:center"><input name="inherit" type="checkbox" style="width:auto" ${acl.inherit!==false?'checked':''} ${!manage?'disabled':''}>${kind==='pages'?'상위 페이지와 팀스페이스 권한 상속':'팀스페이스 권한 상속'}</label><div><strong class="small">가족 멤버</strong><div class="settings-list">${rows(result.members||[],'members')}</div></div>${result.groups?.length?`<div><strong class="small">그룹</strong><div class="settings-list">${rows(result.groups,'groups')}</div></div>`:''}${database?`<div style="border-top:1px solid var(--line);padding-top:15px"><strong class="small">항목별 접근</strong><label style="margin-top:12px">보여줄 항목<select name="row_mode" ${!manage?'disabled':''}><option value="all" ${policy.mode!=='assigned'?'selected':''}>접근 가능한 모든 항목</option><option value="assigned" ${policy.mode==='assigned'?'selected':''}>내가 담당자인 항목만</option></select></label><label style="margin-top:12px">담당자 속성<select name="property_id" ${!manage?'disabled':''}><option value="">선택하세요</option>${(database.properties||[]).filter(p=>p.type==='person').map(p=>`<option value="${esc(p.id)}" ${policy.property_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label style="display:flex;align-items:center;margin-top:12px"><input type="checkbox" name="edit_assigned" style="width:auto" ${policy.edit_assigned!==false?'checked':''} ${!manage?'disabled':''}>담당 항목 편집 허용</label><label style="display:flex;align-items:center;margin-top:12px"><input type="checkbox" name="allow_create" style="width:auto" ${policy.allow_create!==false?'checked':''} ${!manage?'disabled':''}>새 항목 생성 허용</label></div>`:''}${manage?'<div class="form-actions"><button class="solid-btn">공유 설정 저장</button></div>':''}</form>`);
}

async function openSettings(tab='members') {
  if(!isAdmin()){openModal('내 계정',`<p><strong>${esc(state.session?.member?.name||'가족')}</strong><br>${esc(state.session?.member?.email||'')}<br>${esc(state.session?.member?.role||'')}</p><button class="outline-btn" data-action="logout">로그아웃</button>`);return;}
  state.settingsTab=tab;
  try {
    state.advanced=await api('/advanced');
  }
  catch(e) {
    toast(e.message);
    state.advanced= {
    };
  }
  openModal('워크스페이스 설정','<div class="settings-layout"><nav class="settings-tabs" id="settings-tabs"></nav><div class="settings-content" id="settings-content"></div></div>','settings-modal');
  $('.modal-body').style.padding='0';
  await renderSettings();
}
const settingsTabs=[['accounts','가족 계정'],['members','멤버 및 그룹'],['security','보안 및 권한'],['automations','자동화'],['forms','폼'],['sites','사이트'],['AI','AI 및 연결'],['analytics','워크스페이스 분석'],['features','기능 제공 현황'],['export','가져오기 / 내보내기']];
async function renderSettings() {
  const tab=state.settingsTab;
  $('#settings-tabs').innerHTML=settingsTabs.filter(([key])=>!['accounts','security','analytics','export','AI'].includes(key)||isOwner()).map(([key,name])=>`<button data-action="settings-tab" data-tab="${key}" class="${tab===key?'active':''}">${name}</button>`).join('');
  const content=$('#settings-content'),a=state.advanced|| {
  };
  const header=(title,desc,button='')=>`<div class="section-heading"><h3>${title}</h3>${button}</div><p>${desc}</p>`;
  const add=(kind,label)=>`<button class="outline-btn" data-action="add-advanced" data-kind="${kind}">+ ${label}</button>`;
  const items=(kind,detail)=>`<div class="settings-list">${normalizeList(a[kind]).map(item=>`<div class="settings-item"><div><strong>${esc(item.name||item.title||item.email||item.id)}</strong><small>${esc(detail(item))}</small></div><div>${kind==='automations'?`<button data-action="toggle-automation" data-id="${esc(item.id)}">${item.enabled===false?'사용':'일시 중지'}</button><button data-action="automation-runs" data-id="${esc(item.id)}">기록</button><button data-action="run-automation" data-id="${esc(item.id)}" ${item.enabled===false?'disabled title="직접 실행하려면 먼저 자동화를 사용 상태로 바꾸세요"':''}>한 번 실행</button>`:''}${kind==='forms'?`<button data-action="fill-form" data-id="${esc(item.id)}">응답</button>`:''}${kind==='sites'?`<button data-action="site-link" data-id="${esc(item.id)}">링크</button>`:''}<button data-action="edit-advanced" data-kind="${kind}" data-id="${esc(item.id)}">관리</button></div></div>`).join('')||'<div class="empty">아직 항목이 없어요. 첫 번째 항목을 만들어 보세요.</div>'}</div>`;
  if(tab==='accounts'){await renderAccounts(content);}
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
  let content='';
  const pages=state.workspace.pages.filter(p=>!p.archived);
  const dbs=state.workspace.databases;
  const select=(label,name,options,value)=>`<label>${label}<select name="${name}">${options.map(([v,n])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(n)}</option>`).join('')}</select></label>`;
  const checkbox=(label,name,checked)=>`<label style="display:flex;align-items:center"><input type="checkbox" style="width:auto" name="${name}" ${checked?'checked':''}>${label}</label>`;
  const nameField=field('이름','name','이름을 입력하세요','text',item.name||'');
  if(kind==='members')content=nameField+field('이메일','email','name@company.com','email',item.email||'')+select('역할','role',[['owner','소유자'],['member','멤버'],['admin','관리자'],['guest','게스트']],item.role||'member')+'<div class="info-box">워크스페이스의 로컬 멤버를 등록합니다. 초대 이메일은 자동 발송하지 않습니다. 소유자가 가족 계정에서 각 멤버의 로그인 비밀번호를 설정할 수 있습니다.</div>';
  else if(kind==='groups')content=nameField+`<label>그룹 멤버<select name="members" multiple style="min-height:100px">${(state.advanced.members||[]).map(m=>`<option value="${esc(m.id)}" ${(item.members||[]).includes(m.id)?'selected':''}>${esc(m.name||m.email)}</option>`).join('')}</select></label>`;
  else if(kind==='teamspaces')content=nameField+select('접근 범위','visibility',[['open','열린 팀스페이스'],['closed','비공개 팀스페이스'],['private','초대한 멤버 전용']],item.visibility||'open');
  else if(kind==='sites')content=nameField+select('게시할 페이지','page_id',pages.map(p=>[p.id,p.title]),item.page_id||pages[0]?.id)+field('사이트 주소','slug','our-team','text',item.slug||'')+field('검색 결과 제목','seo_title','사이트 제목','text',item.seo_title||'')+field('설명','description','페이지를 소개해 주세요','text',item.description||'')+checkbox('공개 사이트로 게시','published',!!item.published)+'<div class="info-box">게시하면 링크를 가진 누구나 페이지 내용을 열람할 수 있습니다.</div>';
  else if(kind==='forms')content=nameField+select('응답을 저장할 데이터베이스','database_id',dbs.map(d=>[d.id,d.name||d.title]),item.database_id||dbs[0]?.id)+`<label>질문 (JSON)<textarea name="fields" spellcheck="false" required>${esc(JSON.stringify(item.fields||[{id:'name',label:'프로젝트 이름',type:'text',required:true,property_id:'name'},{id:'status',label:'진행 상태',type:'select',property_id:'status',options:['시작 전','진행 중','완료']}],null,2))}</textarea></label>`+checkbox('폼 공개 및 응답 허용','published',!!item.published)+'<div class="info-box">각 질문의 property_id는 연결된 데이터베이스의 속성 ID와 같아야 합니다. 질문에 condition: {field, equals}를 추가하면 조건부로 표시됩니다.</div>';
  else if(kind==='automations')content=nameField+select('데이터베이스','database_id',dbs.map(d=>[d.id,d.name||d.title]),item.database_id||dbs[0]?.id)+select('실행 조건','trigger',[['manual','직접 실행'],['row.created','항목을 만들었을 때'],['row.updated','항목을 수정했을 때'],['scheduled','일정에 따라 반복']],item.trigger||'manual')+automationScheduleFields(item)+`<label>속성을 변경할 대상 항목<select name="row_id" id="automation-row"><option value="">대상 항목 없음</option></select><small class="muted">속성 변경 작업에 사용합니다. 새 항목이나 페이지 생성 작업은 비워둘 수 있습니다.</small></label><label>실행할 작업 (JSON)<textarea name="actions" required spellcheck="false">${esc(JSON.stringify(item.actions||[{type:'set_property',property_id:'status',value:'완료'}],null,2))}</textarea></label>`+checkbox('자동화 사용','enabled',item.enabled!==false);
  else if(kind==='integrations')content=nameField+select('제공자','provider',[['webhook','Webhook'],['slack','Slack'],['github','GitHub'],['google_drive','Google Drive'],['custom','사용자 정의']],item.provider||'webhook')+field('연결 URL','url','https://…','url',item.url||'')+'<div class="info-box">연결 메타데이터를 등록합니다. 실제 동기화와 OAuth 인증은 공급자 연결이 필요합니다.</div>';
  openModal(`${id?'관리':'새로 만들기'} · ${{members:'멤버',groups:'그룹',teamspaces:'팀스페이스',forms:'폼',sites:'사이트',automations:'자동화',integrations:'연결'}[kind]||kind}`,`<form id="advanced-form" data-kind="${kind}" data-id="${esc(id||'')}" class="form-grid">${content}<div class="form-actions"><button type="button" class="outline-btn" data-action="settings">설정으로 돌아가기</button><button class="solid-btn">저장하기</button></div></form>`);
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
  if(state.nativeRecoveryPreparing||state.nativeRecoveryPaused)return;
  if (state.titleSaving) await state.titleSaving;
  if(state.nativeRecoveryPreparing||state.nativeRecoveryPaused)return;
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
  const a=target.dataset.action,id=target.dataset.id;
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
      if(state.mutations!==controller)return;
      const removedPages=new Set(before.filter(record=>removed.has(record.id)&&record.operation.kind==='page.create').map(record=>record.operation.target_id));
      if(removedPages.has(currentPageId)){closeDocument();state.page=null;state.localPageOnly=false;state.route='home';location.hash='home';await refreshMutationUI();renderHome();}
      else await refreshMutationUI();
      await openMutationQueue();toast('선택한 변경과 의존 변경을 폐기했습니다.');break;
    }
    case'accounts':await openSettings('accounts');break;
    case'account-password':openAccountPassword(id);break;
    case'account-add-member':await openSettings('members');advancedForm('members');break;
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
    case'logout':{
      const actor=state.offlineProfile;if(actor&&state.authRecoveryMemory)for(const [key,value] of state.authRecoveryMemory)if(value.profile.origin===actor.origin&&value.profile.workspaceId===actor.workspaceId&&value.profile.memberId===actor.memberId)state.authRecoveryMemory.delete(key);
      const binding=actor?.cacheBinding||state.session?.cache_binding,generation=state.bootGeneration;
      closeDocument();closeMutations();await window.FountainOffline?.clearActiveProfile(actor);
      const active=await window.FountainOffline?.getProfile();if(active&&active.id!==actor?.id){if(generation===state.bootGeneration)await boot();break;}
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
    case'page-menu':openModal('페이지 메뉴',`<div class="form-grid"><button class="outline-btn" data-action="pin-page">기기에 보관 · 오프라인 편집</button><button class="outline-btn" data-action="copy-blocks">${icon('link')}블록 복사</button><button class="outline-btn" data-action="lock-page">${icon('lock')}${state.page.locked?'페이지 잠금 해제':'페이지 잠그기'}</button><button class="outline-btn" data-action="verify-page">${state.page.verification?"페이지 검증 해제":"페이지 검증"}</button><button class="outline-btn" data-action="move-page">페이지 이동</button><button class="outline-btn" data-action="duplicate-page">페이지 복제</button><button class="outline-btn" data-action="history">${icon('clock')}페이지 기록</button><button class="danger-btn" data-action="delete-page">${icon('trash')}휴지통으로 이동</button></div>`);
    break;
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
    case'verify-page': {
      await saveTitle();
      await savePage();
      state.page = await api('/pages/' + state.page.id + '/verify', state.page.verification ? {} : {owner:'local'}, state.page.verification ? 'DELETE' : 'POST');
      closeModal(); renderPage(); toast(state.page.verification ? '페이지를 검증했습니다.' : '검증을 해제했습니다.');
      break;
    }
    case'move-page':openModal('페이지 이동',`<form id="move-page-form" class="form-grid"><label>상위 페이지<select name="parent_id"><option value="">최상위 페이지</option>${state.workspace.pages.filter(p=>p.id!==state.page.id&&!p.archived).map(p=>`<option value="${esc(p.id)}" ${p.id===state.page.parent_id?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label><button class="solid-btn">이동하기</button></form>`);
    break;
    case'copy-blocks': {
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
        toast('서식과 함께 블록을 복사했습니다.');
      }
      catch {
        openModal('복사할 내용',`<p>아래 내용을 선택해서 복사하세요.</p><textarea style="width:100%;height:250px">${esc(data.text)}</textarea>`);
        $('textarea').select();
      }
      break;
    }
    case'share':await openPermissions('pages',state.page.id);break;
    case'db-share':await openPermissions('databases',state.database.id);break;
    case'copy-link': {
      const el=$('#share-url')||$('.modal-body input');
      try {
        await navigator.clipboard.writeText(el.value);
        toast('링크를 복사했습니다.');
      }
      catch {
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
    case'invite':await openSettings('members');
    advancedForm('members');
    break;
    case'new-teamspace':await openSettings('members');
    advancedForm('teamspaces');
    break;
    case'teamspace': {
      await openSettings('members');
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
    case'fill-form':window.open(FountainTransport.publicURL('/forms/'+encodeURIComponent(id)),'_blank','noopener');
    break;
    case'site-link': {
      const site=state.advanced.sites.find(s=>s.id===id);
      if(!site.published) {
        toast('먼저 사이트를 게시해 주세요.');
        break;
      }
      window.open(FountainTransport.publicURL('/sites/'+encodeURIComponent(site.slug)),'_blank','noopener');
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
    case'new-property':openModal('데이터베이스 속성 추가',form(field('속성 이름','name','마감일')+`<label>속성 종류<select name="type"><option value="text">텍스트</option><option value="number">숫자</option><option value="status">상태</option><option value="select">선택</option><option value="date">날짜</option><option value="person">사람</option><option value="checkbox">체크박스</option><option value="multi_select">다중 선택</option><option value="files">파일 ID 목록</option><option value="url">URL</option><option value="email">이메일</option><option value="relation">관계형</option><option value="formula">수식</option><option value="rollup">롤업</option></select></label>`+field('선택 항목 (쉼표로 구분)','options','시작 전, 진행 중, 완료')+field('수식','expression',"prop('estimate') * 2")+`<label>관계형 대상 데이터베이스<select name="database_id">${state.workspace.databases.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>롤업에 사용할 관계 속성<select name="relation_property"><option value="">관계 속성을 선택하세요</option>${state.database.properties.filter(p=>p.type==='relation').map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('')}</select></label>`+field('롤업 대상 속성 ID','target_property','estimate')+`<label>롤업 집계<select name="aggregation"><option value="sum">합계</option><option value="count">개수</option><option value="average">평균</option><option value="min">최솟값</option><option value="max">최댓값</option></select></label>`,'property-form'));
    break;
    case'backup':{if(state.workspace.settings?.disable_export)throw new Error('워크스페이스에서 내보내기를 제한했습니다.');if(FountainTransport.native){await FountainTransport.download('/api/backup','fountain-backup.sqlite');break;}const link=document.createElement('a');link.href=FountainTransport.downloadURL('/api/backup');link.download='fountain-backup.sqlite';link.click();break;}
    case'export': {
      const data=await api('/export?format='+target.dataset.format);
      download(data.filename,data.content,data.mime);
      toast('백업 파일을 내보냈습니다.');
      break;
    }
  }
}
document.addEventListener('click',event=> {
  if(event.target.closest?.('.block-content a.rich-link')&&pageEditable()&&!event.metaKey&&!event.ctrlKey){event.preventDefault();return;}
  const target=event.target.closest('[data-action]'); if(target) {
    event.preventDefault(); doAction(target).catch(error=>toast(error.message));
  }
  else if(event.target.classList.contains('modal-backdrop'))closeModal(); else if(!event.target.closest('.slash-menu,.block-content'))closeSlash();
});
document.addEventListener('input',event=> {
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
    clearTimeout(state.searchTimer); state.searchTimer=setTimeout(()=>renderSearch(el.value),150);
  }
  if(el.id==='db-filter-input') {
    state.filter=el.value; $('#db-view').innerHTML=databaseView();
  }
});
document.addEventListener('change',event=> {
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
  if(state.nativeRecoveryPaused)return;
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
      case'login-form':await api('/session',state.session?.mode==='accounts'?{email:data.email,password:data.password}:{token:data.token}); await boot(); break; case'page-form': {
        if(state.session?.member?.role==='guest')throw new Error('페이지 생성 권한이 없습니다.');
        const parentId=formElement.dataset.parent||null,parent=state.workspace.pages.find(page=>page.id===parentId);
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
        }); state.comments.push(c.comment||c); $('#comments').innerHTML=commentsHTML(); formElement.reset(); toast('댓글을 남겼습니다.'); break;
      }
      case'row-form': {
        const properties= {
        }; for(const p of state.rowEditingDatabase.properties) {
          if(['formula','rollup','created_time','last_edited_time'].includes(p.type))continue;
          if(p.type==='date'){const start=data[p.id]||'',end=data[p.id+'__end']||'',original=valuesOf(state.rowEditingBaseline||{})[p.id],range=dateRange(original);if(end&&(!start||end<start))throw new Error('종료일은 시작일 이후여야 합니다.');properties[p.id]=range&&start===range.startISO&&end===(typeof original==='object'&&original?.end?range.endISO:'')?original:end?{start,end}:start;continue;}
          properties[p.id]=p.type==='checkbox'?formElement.elements.namedItem(p.id).checked:p.type==='number'?(data[p.id]!==''?Number(data[p.id]):null):['relation','multi_select','files'].includes(p.type)?String(data[p.id]||'').split(',').map(s=>s.trim()).filter(Boolean):data[p.id]||'';
        }
        const body={properties,...taskGraphChanges(formElement,data)};
        if(formElement.dataset.id&&state.rowEditingBaseline){
          for(const property of state.rowEditingDatabase.properties){
            if(!(property.id in properties))continue;
            const original=valuesOf(state.rowEditingBaseline)[property.id];
            const baseline=property.type==='checkbox'?!!original:property.type==='number'?(original===''||original==null?null:Number(original)):['relation','multi_select','files'].includes(property.type)?(Array.isArray(original)?original:[]):original??'';
            if(JSON.stringify(properties[property.id])===JSON.stringify(baseline))delete properties[property.id];
          }
        }
        if(state.mutations){
          const previousIds=new Set((await state.mutations.records()).map(record=>record.id));
          if(formElement.dataset.id)await state.mutations.patchRow(state.rowEditingDatabase.id,formElement.dataset.id,body,{baseline:state.rowEditingBaseline,schema:state.rowEditingDatabase.properties});else await state.mutations.createRow(state.rowEditingDatabase.id,body,{schema:state.rowEditingDatabase.properties});
          if(!state.offline){await syncMutations();const invalid=(await state.mutations.records()).find(record=>!previousIds.has(record.id)&&record.status==='invalid');if(invalid)throw new Error(mutationError(invalid)+' 변경 내용은 동기화 목록에 보관했습니다.');}
        }else await api('/databases/'+state.database.id+'/rows'+(formElement.dataset.id?'/'+formElement.dataset.id:''),body,formElement.dataset.id?'PATCH':'POST');
        closeModal();await reloadDatabase();toast(state.offline?(nativeCacheOnly()?'변경을 앱 캐시에 보관했습니다. 연결되면 동기화합니다.':'변경을 기기에 저장했습니다. 연결되면 동기화합니다.'):state.mutationRecords?.some(record=>record.operation.database_id===state.database.id)?'변경을 기기에 보관했습니다. 동기화 목록에서 상태를 확인하세요.':'프로젝트를 저장했습니다.');break;
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
      case'property-form': {
        const p= {
          id:uid().slice(0,8),name:data.name||'새 속성',type:data.type
        }; if(['status','select','multi_select'].includes(p.type))p.options=data.options.split(',').map(v=>v.trim()).filter(Boolean); if(p.type==='formula')p.expression=data.expression; if(p.type==='relation')p.database_id=data.database_id; if(p.type==='rollup') {
          if(!data.relation_property||!data.target_property)throw new Error('롤업에 사용할 관계 속성과 대상 속성 ID를 지정해 주세요.');
          p.target_property=data.target_property;p.relation_property=data.relation_property;p.aggregation=data.aggregation;
        }
        await api('/databases/'+state.database.id, {
          properties:[...state.database.properties,p]
        },'PATCH'); closeModal(); await reloadDatabase(); toast('속성을 추가했습니다.'); break;
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
  if(state.nativeRecoveryPaused)return;
  if(preserve)return suspendLoginInput().then(current=>{if(current)renderLogin(false);});
  closeDocument();closeMutations();state.offlineProfile=null;state.offline=false;
  state.loaded=false;
  state.workspace=null;state.page=null;state.blocks=[];state.database=null;state.rows=[];state.dirty=false;state.titlePending=null;clearTimeout(state.saveTimer);clearTimeout(state.titleTimer);
  $('#sidebar').innerHTML='';
  $('#topbar').innerHTML='';
  $('#main').innerHTML=`<div class="login-wrap"><div class="brand"><span class="brand-mark">f</span>fountain</div><h1>우리 가족의 작은 작업실</h1><p>가족과 나누는 문서, 아이디어, 일상.<br>${state.session?.mode==='accounts'?'내 이메일과 비밀번호로 로그인하세요.':'공유 암호를 입력하고 함께 시작하세요.'}</p><form class="form-grid" id="login-form">${state.session?.mode==='accounts'?'<label>이메일<input name="email" type="email" required autocomplete="username" autofocus placeholder="name@example.com"></label><label>비밀번호<input name="password" type="password" required autocomplete="current-password" placeholder="계정 비밀번호"></label>':'<label>공유 암호<input name="token" type="password" required autocomplete="current-password" autofocus placeholder="가족 공유 암호"></label>'}<button class="solid-btn">워크스페이스 열기</button><div id="login-error" role="alert"></div></form><small class="muted">Fountain · 구독 없이, 함께 쓰는 공간</small></div>`;
  document.body.classList.add('login-mode');
  if(state.authRetentionError&&$('#login-error'))$('#login-error').textContent=state.authRetentionError;
}
async function boot() {
  if(state.nativeRecoveryPaused)return;
  const generation=(state.bootGeneration||0)+1;state.bootGeneration=generation;
  const cachedIdentity=await window.FountainOffline?.getProfile().catch(()=>null);
  if(state.nativeRecoveryPaused||generation!==state.bootGeneration)return;
  let renewLegacyLocal=false;
  try {
    document.body.classList.remove('login-mode');
    if(localStorage.getItem(logoutPendingKey())){const marker=localStorage.getItem(logoutPendingKey()),record=JSON.parse(marker),clearMarker=()=>{if(localStorage.getItem(logoutPendingKey())===marker)localStorage.removeItem(logoutPendingKey());};if(!record.binding){clearMarker();renewLegacyLocal=record.mode==='local'&&!cachedIdentity;if(!cachedIdentity&&record.mode!=='local'){state.session={mode:['accounts','family'].includes(record.mode)?record.mode:'accounts',required:true,authenticated:false};renderLogin(false);return;}}else try{await api('/session',{cache_binding:record.binding},'DELETE');clearMarker();}catch(error){if(error.status===409){clearMarker();}else if(!error.status){state.session={mode:['accounts','family','local'].includes(record.mode)?record.mode:'accounts',required:true,authenticated:false};renderLogin();return;}else throw error;}}
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
  if (!state.loaded||state.nativeRecoveryPaused) return;
  const [route, encodedId] = location.hash.slice(1).split('/');
  let id;
  try { id = encodedId ? decodeURIComponent(encodedId) : undefined; }
  catch { return; }
  const currentId = state.route === 'page' ? state.page?.id : state.database?.id;
  if (route === state.route && (route === 'home' || id === currentId)) return;
  navigate(['page', 'database'].includes(route) && id ? route : 'home', id);
});
boot();
