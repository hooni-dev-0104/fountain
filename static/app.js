'use strict';
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
  workspace:null, route:'home',page:null,blocks:[],versions:[],comments:[],database:null,rows:[],view:'table',filter:'',sort:false,saving:null,saveTimer:null,advanced:null,settingsTab:'members',loaded:false,activeBlock:null,trash:false,dirty:false,editSequence:0
};
async function api(path, body, method) {
  const response = await fetch('/api' + path, {
    method:method || (body ? 'POST':'GET'),headers: {
      'Content-Type':'application/json','X-Fountain-Request':'1'
    }, ...(body ? {
      body:JSON.stringify(body)
    }
    : {
    })
  });
  const data = await response.json().catch(()=>( {
    error:'응답을 읽을 수 없습니다.'
  }));
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.message || '요청을 처리하지 못했습니다.');
    error.status = response.status;
    error.data=data;
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
  state.workspace=await api('/workspace');
  renderSidebar();
}
function renderSidebar() {
  const w=state.workspace;
  if(!w)return;
  const pages=w.pages.filter(p=>!p.deleted&&!p.deleted_at&&!p.archived);
  const favorite=pages.filter(p=>p.favorite);
  const roots=pages.filter(p=>!p.parent_id);
  const pageItem=(p,depth=0)=>`<div class="nav-item page-nav ${state.page?.id===p.id&&state.route==='page'?'active':''}" style="padding-left:${10+depth*13}px"><button data-action="page" data-id="${esc(p.id)}" class="nav-item" style="padding:0;min-height:23px"><span class="page-icon">${esc(p.icon||'📄')}</span><span class="label">${esc(p.title||'제목 없음')}</span></button><button class="page-menu" aria-label="하위 페이지 추가" data-action="add-page" data-parent="${esc(p.id)}">+</button></div>${pages.filter(q=>q.parent_id===p.id).map(q=>pageItem(q,Math.min(depth+1,4))).join('')}`;
  $('#sidebar').innerHTML=`<div class="brand"><span class="brand-mark">f</span>fountain<span style="font-family:sans-serif;font-size:9px;letter-spacing:1px;color:#a5a497;margin-left:2px;font-weight:400">WORKSPACE</span></div><button class="workspace-switch" data-action="settings"><span class="workspace-avatar">F</span><span class="workspace-name">${esc(w.settings?.name||'Fountain 스튜디오')}<small>함께 만드는 작은 가능성</small></span>${icon('down')}</button><nav><button class="nav-item" data-action="search">${icon('search')}<span class="label">검색</span><span class="shortcut">⌘ K</span></button><button class="nav-item ${state.route==='home'?'active':''}" data-action="home">${icon('home')}<span class="label">홈</span></button><button class="nav-item" data-action="activity">${icon('inbox')}<span class="label">업데이트</span></button><button class="nav-item" data-action="ai">${icon('spark')}<span class="label">Fountain AI</span><span class="badge">AI</span></button></nav><div class="sidebar-pages"><div class="section-label">즐겨찾기<span>${icon('star')}</span></div>${favorite.length?favorite.map(p=>pageItem(p)).join(''):'<div class="small muted" style="padding:5px 12px;font-size:10px">자주 찾는 페이지를 모아보세요</div>'}<div class="section-label">팀스페이스<button data-action="new-teamspace" aria-label="팀스페이스 추가">+</button></div>${(w.teamspaces||[{id:'general',name:'Fountain 팀'}]).map(t=>`<button class="nav-item" data-action="teamspace" data-id="${esc(t.id)}"><span class="team-icon">${esc((t.name||'팀')[0])}</span><span class="label">${esc(t.name||'Fountain 팀')}</span>${icon('down')}</button>`).join('')}${(w.databases||[]).map(d=>`<button class="nav-item ${state.route==='database'&&state.database?.id===d.id?'active':''}" data-action="database" data-id="${esc(d.id)}" style="padding-left:20px"><span class="page-icon">${esc(d.icon||'▤')}</span><span class="label">${esc(d.name||d.title||'프로젝트')}</span></button>`).join('')}<div class="section-label">페이지<button data-action="add-page" aria-label="새 페이지">+</button></div>${roots.map(p=>pageItem(p)).join('')}<button class="nav-item muted" data-action="add-page">${icon('plus')}<span class="label">새 페이지</span></button><button class="nav-item muted" data-action="new-database">${icon('table')}<span class="label">새 데이터베이스</span></button></div><div class="sidebar-bottom"><button class="nav-item" data-action="settings">${icon('settings')}<span class="label">설정 및 멤버</span></button><button class="nav-item" data-action="trash">${icon('trash')}<span class="label">휴지통</span></button><div class="invite-card"><strong>좋은 생각은, 함께 자라니까요.</strong>팀원을 초대하고 한곳에서 시작하세요.<br><button data-action="invite">멤버 초대하기 ↗</button></div></div>`;
}
function renderTopbar(title='홈',emoji='') {
  $('#topbar').innerHTML=`<div class="crumb"><button class="mobile-toggle" data-action="toggle-sidebar" aria-label="메뉴 열기">${icon('menu')}</button><button data-action="home">Fountain 스튜디오</button><span>/</span><span>${esc(emoji)}</span><span class="current">${esc(title)}</span></div><div class="top-actions"><span class="save-status" id="save-status">${state.route==='page'?'모든 변경 사항 저장됨':'나만의 리듬으로, 함께'}</span><div class="avatar-stack" aria-label="워크스페이스 멤버">${(state.workspace?.members||[]).slice(0,3).map(m=>`<span>${esc((m.name||'나')[0])}</span>`).join('')}</div>${state.route==='page'?`<button data-action="favorite" aria-label="즐겨찾기">${icon('star')}</button><button data-action="share">${icon('share')}공유</button><button data-action="history" aria-label="페이지 기록">${icon('clock')}</button><button data-action="page-menu" aria-label="페이지 메뉴">${icon('dots')}</button>`:`<button class="desktop-only" data-action="activity" aria-label="활동 기록">${icon('clock')}</button><button data-action="settings" aria-label="설정">${icon('dots')}</button>`}</div>`;
}
async function navigate(route,id) {
  try {
    await saveTitle();
    await savePage();
    closeModal();
    document.body.classList.remove('sidebar-open');
    state.route=route;
    if(route==='page') {
      state.dirty=false;
      const data=await api('/pages/'+encodeURIComponent(id));
      state.page=data.page;
      state.blocks=data.blocks||data.page.blocks||[];
      state.versions=data.versions||[];
      state.comments=data.comments||[];
      renderPage();
      location.hash='page/'+id;
    }
    else if(route==='database') {
      const data=await api('/databases/'+encodeURIComponent(id));
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
    toast(error.message);
  }
}
function renderHome() {
  renderTopbar();
  const pages=state.workspace.pages.filter(p=>!p.deleted&&!p.deleted_at&&!p.archived).slice(0,3);
  const today=new Date().toLocaleDateString('ko-KR', {
    month:'long',day:'numeric',weekday:'long'
  });
  $('#main').innerHTML=`<div class="main-inner"><div class="welcome-row"><div><div class="date-label">${esc(today)}</div><h1>반가워요, 오늘도 좋은 하루예요 <span style="font-size:25px">☀️</span></h1><p>생각을 정리하고, 함께 만드는 일에 집중해 보세요.</p></div><button class="outline-btn" data-action="add-page">${icon('plus')}새 페이지</button></div><section class="hero"><div class="hero-text"><div class="eyebrow">A LITTLE SPACE, BIG POSSIBILITIES</div><h2>흩어져 있던 생각이<br>하나의 가능성이 되는 곳.</h2><p>문서부터 프로젝트, 팀의 모든 이야기를 Fountain에 담아보세요.</p><button data-action="page" data-id="${esc(pages[0]?.id||'welcome')}">우리 워크스페이스 둘러보기 ${icon('arrow')}</button></div><div class="hero-art" aria-hidden="true"><div class="art-orbit"></div><div class="art-paper"><i></i><i></i><i></i><i></i></div><div class="art-card"></div><div class="art-flower">✳</div></div></section><section><div class="section-heading"><h2>${icon('clock')}최근 방문한 페이지</h2><button data-action="search">모든 페이지 ${icon('chevron')}</button></div><div class="recent-grid">${pages.map((p,i)=>`<button class="page-card" data-action="page" data-id="${esc(p.id)}"><div class="card-cover c${i}"></div><div class="card-body"><div class="card-title"><span>${esc(p.icon||['🌿','📝','💡'][i])}</span>${esc(p.title||'제목 없음')}</div><div class="card-meta"><span>Fountain 스튜디오</span><span>${date(p.updated_at)} 수정</span></div></div></button>`).join('')}${pages.length<3?`<button class="page-card" data-action="add-page"><div class="card-cover c2"><span style="z-index:1;font-size:23px;color:#8b9da4">+</span></div><div class="card-body"><div class="card-title">새로운 아이디어</div><div class="card-meta">빈 페이지에서 시작해 보세요</div></div></button>`:''}</div></section><div class="dashboard-bottom"><section><div class="section-heading"><h2>${icon('table')}우리 팀 프로젝트</h2><button data-action="database" data-id="${esc(state.workspace.databases?.[0]?.id||'projects')}">전체 보기 ${icon('chevron')}</button></div><div class="panel" id="home-database"><div class="empty">프로젝트를 불러오는 중…</div></div></section><section class="activity-panel"><div class="section-heading"><h2>${icon('inbox')}워크스페이스 소식</h2><button data-action="activity">${icon('dots')}</button></div><div class="activity-list" id="home-activity"><div class="activity"><span class="activity-avatar">F</span><p><strong>Fountain</strong>에 오신 것을 환영해요.<span class="activity-page">🌱 함께 만드는 워크스페이스</span><small>오늘</small></p></div></div><div class="quote-card">“위대한 일은 작은 일들이<br>모여 이루어집니다.”<span>작은 시작을 응원하는 Fountain</span></div></section></div><footer class="footer-line"><span><i></i>모든 변경 사항이 안전하게 저장됩니다</span><span>Made for your flow. &nbsp; ✳ Fountain</span></footer></div>`;
  loadHomeData();
}
async function loadHomeData() {
  const id=state.workspace.databases?.[0]?.id;
  if(id) {
    try {
      const data=await api('/databases/'+id);
      if(state.route!=='home')return;
      state.database=data.database;
      state.rows=data.rows||[];
      $('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;
    }
    catch(e) {
      if($('#home-database'))$('#home-database').innerHTML=`<div class="empty">${esc(e.message)}<br><button data-action="new-database">데이터베이스 만들기</button></div>`;
    }
  }
  else if($('#home-database'))$('#home-database').innerHTML='<div class="empty"><button data-action="new-database">+ 첫 데이터베이스 만들기</button></div>';
  try {
    const data=await api('/audit');
    const records=normalizeList(data.events||data.audit||data.entries||data);
    if(state.route==='home'&&records.length)$('#home-activity').innerHTML=records.slice(0,3).map((r,i)=>`<div class="activity"><span class="activity-avatar">${['F','나','팀'][i]}</span><p><strong>${esc(r.actor_name||r.user||r.actor||'워크스페이스')}</strong><br>${esc(r.action||r.event||'새로운 활동')}<span class="activity-page">${esc(r.target_name||r.resource_type||'')}</span><small>${date(r.created_at||r.timestamp)}</small></p></div>`).join('');
  }
  catch {
  }
}
function renderPage() {
  const p=state.page;
  renderTopbar(p.title,p.icon);
  $('#main').innerHTML=`${p.cover?'<div class="page-cover"></div>':''}<article class="editor-wrap ${p.cover?'has-cover':''}"><button class="page-emoji" data-action="change-icon" aria-label="페이지 아이콘 변경">${esc(p.icon||'📄')}</button><h1 class="page-title" id="page-title" contenteditable="${!p.locked}" role="textbox" aria-label="페이지 제목">${esc(p.title)}</h1><div class="page-tools"><span>${icon('clock')}</span><span>${date(p.updated_at)} 수정</span><button data-action="favorite" class="${p.favorite?'favorite-on':''}">${p.favorite?'★ 즐겨찾기':'☆ 즐겨찾기'}</button><button data-action="toggle-cover">${p.cover?'커버 제거':'커버 추가'}</button>${p.locked?'<span>🔒 잠긴 페이지</span>':''}<button data-action="ai" style="margin-left:auto">✦ AI 도우미</button></div><div id="blocks" aria-label="페이지 블록">${state.blocks.map(blockHTML).join('')}</div>${!p.locked?'<button class="editor-end" data-action="add-block"><span>+</span> 글을 쓰거나 ‘/’로 블록을 추가하세요</button>':''}<section class="comment-section"><h3>댓글 <span class="muted">${state.comments.filter(c=>!c.resolved).length}</span></h3><div id="comments">${commentsHTML()}</div><form class="comment-form" id="comment-form"><input name="text" aria-label="댓글 내용" placeholder="생각을 나눠보세요…" required maxlength="10000"><button class="outline-btn">보내기 ${icon('arrow')}</button></form></section></article>`;
}
function commentsHTML() {
  return state.comments.filter(c=>!c.resolved).map(c=>`<div class="comment-item"><button data-action="resolve-comment" data-id="${esc(c.id)}">해결 ✓</button><strong>${esc(c.author_name||c.author||'나')}</strong> <span class="muted small">${date(c.created_at)}</span><div>${esc(c.text)}</div></div>`).join('');
}
const blockTypes=[['paragraph','텍스트','일반 텍스트로 작성','T'],['heading1','제목 1','가장 큰 제목','H₁'],['heading2','제목 2','중간 크기 제목','H₂'],['heading3','제목 3','작은 제목','H₃'],['bullet','글머리 기호','간단한 목록','•'],['numbered','번호 매기기','순서가 있는 목록','1.'],['todo','할 일 목록','완료 여부를 체크','☑'],['quote','인용','인상 깊은 문장','❝'],['callout','콜아웃','중요한 내용을 강조','💡'],['code','코드','코드와 서식을 보존','⌘'],['divider','구분선','내용을 나누는 선','―'],['toggle','토글','접을 수 있는 메모','▸'],['bookmark','북마크','링크를 기록','↗']];
function blockHTML(b,i) {
  const type=b.type||'paragraph';
  let marker='';
  if(type==='todo')marker=`<span class="block-marker"><input type="checkbox" aria-label="할 일 완료" data-check="${esc(b.id)}" ${b.checked?'checked':''} ${state.page.locked?'disabled':''}></span>`;
  else if(type==='bullet')marker='<span class="block-marker">•</span>';
  else if(type==='numbered')marker=`<span class="block-marker">${i+1}.</span>`;
  else if(type==='toggle')marker=`<button class="block-marker" data-action="toggle-block" data-id="${esc(b.id)}">▸</button>`;
  return `<div class="block ${b.checked?'checked':''}" data-id="${esc(b.id)}" data-type="${esc(type)}" draggable="${!state.page.locked}">${!state.page.locked?`<span class="block-handle"><button data-action="block-menu" data-id="${esc(b.id)}" aria-label="블록 메뉴">⠿</button></span>`:''}${type==='divider'?'<hr>':marker+`<div class="block-content" contenteditable="${!state.page.locked}" role="textbox" aria-multiline="true" data-placeholder="글을 쓰거나 ‘/’로 명령어를 입력하세요">${esc(b.text||'')}</div>`}</div>`;
}
function readBlocks() {
  if(state.route!=='page')return;
  for(const element of $$('.block')) {
    const b=state.blocks.find(b=>b.id===element.dataset.id);
    if(b&&$('.block-content',element))b.text=$('.block-content',element).innerText.replace(/\n$/,'');
  }
}
function scheduleSave() {
  state.dirty=true;
  state.editSequence++;
  clearTimeout(state.saveTimer);
  $('#save-status')?.replaceChildren(document.createTextNode('저장 중…'));
  state.saveTimer=setTimeout(()=>savePage().catch(e=>toast(e.message)),650);
}
async function savePage() {
  if(state.saving) {
    await state.saving;
  }
  if(state.route!=='page'||!state.page||!state.dirty)return;
  clearTimeout(state.saveTimer);
  state.saveTimer=null;
  readBlocks();
  const id=state.page.id;
  const blocks=structuredClone(state.blocks);
  const revision=state.page.revision,sequence=state.editSequence;
  try {
    state.saving=api('/pages/'+id+'/blocks', {
      blocks,revision
    },'PUT');
    const result=await state.saving;
    if(state.page?.id===id) {
      state.page.revision=result.revision??result.page?.revision??state.page.revision;
      if(sequence===state.editSequence)state.dirty=false;
      state.page.updated_at=result.page?.updated_at||new Date().toISOString();
      if($('#save-status'))$('#save-status').textContent='모든 변경 사항 저장됨';
    }
  }
  catch(e) {
    if($('#save-status'))$('#save-status').textContent='저장하지 못함';
    if(e.status===409) {
      toast('다른 창에서 변경된 페이지입니다. 내용을 복사해 보관한 뒤 새로고침해 주세요.');
    }
    throw e;
  }
  finally {
    state.saving=null;
  }
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
  $('#blocks').innerHTML=state.blocks.map(blockHTML).join('');
  if(focusId)focusBlock(focusId);
}
function addBlock(type='paragraph',afterId,text='') {
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
function databaseToolbar(compact=false) {
  return `<div class="db-toolbar"><div class="view-tabs">${[['table','테이블','table'],['board','보드','board'],...(!compact?[['calendar','캘린더','calendar'],['gallery','갤러리','grid'],['chart','차트','chart']]:[])].map(([v,n,i])=>`<button data-action="db-view" data-view="${v}" class="${state.view===v?'active':''}">${icon(i)}${n}</button>`).join('')}</div><div class="db-actions"><button data-action="filter" aria-label="필터">${icon('filter')}</button>${!compact?'<button data-action="db-export" aria-label="CSV 내보내기">↗</button><button data-action="new-property" aria-label="속성 추가">＋ 속성</button>':''}<button class="solid-btn" data-action="add-row">새로 만들기 ${icon('down')}</button></div></div>`;
}
function tableHTML(rows,compact=false) {
  const db=state.database;
  const props=(db?.properties||[]).slice(0,compact?4:20);
  return `<div style="overflow-x:auto"><table class="data-table"><thead><tr>${props.map(p=>`<th>${p.type==='title'?'Aa':p.type==='status'?'◉':p.type==='date'?'▦':p.type==='person'?'☻':'≡'} &nbsp;${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr tabindex="0" role="button" data-action="edit-row" data-id="${esc(row.id)}" aria-label="${esc(nameOf(row))}">${props.map((p,i)=>{const v=valuesOf(row)[p.id];return `<td>${['status','select'].includes(p.type)?status(v):p.type==='checkbox'?v?'☑':'☐':i===0?'📄 &nbsp;'+esc(v||'제목 없음'):esc(Array.isArray(v)?v.join(', '):v||'—')}</td>`;}).join('')}</tr>`).join('')}</tbody></table>${!rows.length?'<div class="empty">아직 항목이 없어요. 첫 번째 항목을 추가해 보세요.</div>':''}</div>`;
}
function filteredRows() {
  let rows=[...state.rows];
  if(state.filter)rows=rows.filter(r=>Object.values(valuesOf(r)).some(v=>String(v).toLowerCase().includes(state.filter.toLowerCase())));
  if(state.sort)rows.sort((a,b)=>String(nameOf(a)).localeCompare(String(nameOf(b)),'ko'));
  return rows;
}
function databaseView() {
  const rows=filteredRows(),props=state.database.properties;
  const title=props.find(p=>p.type==='title')||props[0];
  const group=props.find(p=>p.type==='status')||props.find(p=>p.type==='select');
  if(state.view==='table')return tableHTML(rows)+`<button class="new-row" data-action="add-row">+ 새 항목</button>`;
  if(state.view==='board') {
    const options=[...new Set([...optionsOf(group|| {
    }),...rows.map(r=>valuesOf(r)[group?.id]||'미지정')])];
    return `<div class="board">${options.map(value=>`<div class="board-column"><h3>${status(value)}<span>${rows.filter(r=>(valuesOf(r)[group?.id]||'미지정')===value).length}</span></h3>${rows.filter(r=>(valuesOf(r)[group?.id]||'미지정')===value).map(r=>`<button class="board-card" data-action="edit-row" data-id="${esc(r.id)}">${esc(valuesOf(r)[title.id]||'제목 없음')}<small>${esc(Object.values(valuesOf(r)).slice(1).filter(Boolean).join(' · '))}</small></button>`).join('')}<button class="new-row" data-action="add-row" data-status="${esc(value)}">+ 새 항목</button></div>`).join('')}</div>`;
  }
  if(state.view==='gallery')return `<div class="gallery">${rows.map(r=>`<button class="board-card" data-action="edit-row" data-id="${esc(r.id)}">${esc(nameOf(r))}<small>${esc(Object.values(valuesOf(r)).slice(1).filter(Boolean).join(' · '))}</small></button>`).join('')}</div>`;
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
  return `<div style="padding:14px;font-size:13px">${now.getFullYear()}년 ${now.getMonth()+1}월</div><div class="calendar">${['일','월','화','수','목','금','토'].map(d=>`<div class="weekday">${d}</div>`).join('')}${Array.from({length:first},()=>'<div></div>').join('')}${Array.from({length:count},(_,i)=>{const key=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`;return `<div>${i+1}${rows.filter(r=>String(valuesOf(r)[dateProp?.id]||'').startsWith(key)).map(r=>`<button data-action="edit-row" data-id="${esc(r.id)}">${esc(nameOf(r))}</button>`).join('')}</div>`;}).join('')}</div>${!dateProp?'<div class="info-box">날짜 속성을 추가하면 캘린더에 항목을 표시할 수 있습니다.</div>':''}`;
}
function renderDatabase() {
  renderTopbar(state.database.name||state.database.title,'▤');
  $('#main').innerHTML=`<section class="db-full"><div class="eyebrow">TEAM WORK, IN ONE PLACE</div><div class="database-heading"><h1>▤ ${esc(state.database.name||state.database.title||'프로젝트')}</h1><button class="outline-btn" data-action="db-export">↗ CSV 내보내기</button></div><p class="muted">작은 할 일부터 큰 목표까지, 우리의 다음 한 걸음을 함께 기록해요.</p><div class="panel">${databaseToolbar()}<div id="db-filters" ${state.filter?'':'hidden'} class="filters"><input id="db-filter-input" aria-label="항목 필터" placeholder="모든 속성에서 검색" value="${esc(state.filter)}"><button class="outline-btn" data-action="db-sort">이름 ${state.sort?'↓':'↕'} 정렬</button><button data-action="clear-filter" aria-label="필터 해제">×</button></div><div id="db-view">${databaseView()}</div></div></section>`;
}
async function reloadDatabase() {
  const data=await api('/databases/'+state.database.id);
  state.database=data.database;
  state.rows=data.rows;
  if(state.route==='database')renderDatabase();
  else if($('#home-database'))$('#home-database').innerHTML=databaseToolbar(true)+tableHTML(state.rows.slice(0,5),true)+`<button class="new-row" data-action="add-row">+ 새 프로젝트</button>`;
}
function openModal(title,content,cls='') {
  closeSlash();
  $('#overlay-root').innerHTML=`<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-action="close-modal" aria-label="닫기">×</button></header><div class="modal-body">${content}</div></section></div>`;
  requestAnimationFrame(()=>$('input:not([type=checkbox]),textarea,select,button', $('.modal-body'))?.focus());
}
function closeModal() {
  $('#overlay-root').innerHTML='';
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
    const data=await api('/search?q='+encodeURIComponent(q));
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
  const vals=row?valuesOf(row): {
  };
  const props=state.database.properties;
  openModal(row?'프로젝트 상세':'새 프로젝트',`<form id="row-form" data-id="${esc(id||'')}" class="form-grid"><div class="row-properties">${props.map(p=>{const value=vals[p.id]??(p.type==='status'?initialStatus:'')??'';let input;if(['status','select','person'].includes(p.type)){let options=p.type==='person'?(state.workspace.members||[]).map(m=>m.name||m.email):optionsOf(p);if(value&&!options.includes(value))options.unshift(value);input=`<select name="${esc(p.id)}"><option value="">미지정</option>${options.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select>`;}else if(p.type==='checkbox')input=`<input name="${esc(p.id)}" type="checkbox" ${value?'checked':''} style="width:auto;justify-self:start">`;else input=`<input ${['formula','rollup','created_time','last_edited_time'].includes(p.type)?'readonly':''} name="${esc(p.id)}" value="${esc(Array.isArray(value)?value.join(', '):value)}" type="${p.type==='number'?'number':p.type==='date'?'date':p.type==='url'?'url':p.type==='email'?'email':'text'}" ${p.type==='title'?'required':''}>`;return `<label>${esc(p.name)}${input}</label>`;}).join('')}</div><div class="form-actions">${row?`<button type="button" class="danger-btn" data-action="delete-row" data-id="${esc(id)}" style="margin-right:auto">삭제</button>`:''}<button type="button" class="outline-btn" data-action="close-modal">취소</button><button class="solid-btn">저장하기</button></div></form>`);
}
async function openSettings(tab='members') {
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
const settingsTabs=[['members','멤버 및 그룹'],['security','보안 및 권한'],['automations','자동화'],['forms','폼'],['sites','사이트'],['AI','AI 및 연결'],['analytics','워크스페이스 분석'],['features','기능 제공 현황'],['export','가져오기 / 내보내기']];
async function renderSettings() {
  const tab=state.settingsTab;
  $('#settings-tabs').innerHTML=settingsTabs.map(([key,name])=>`<button data-action="settings-tab" data-tab="${key}" class="${tab===key?'active':''}">${name}</button>`).join('');
  const content=$('#settings-content'),a=state.advanced|| {
  };
  const header=(title,desc,button='')=>`<div class="section-heading"><h3>${title}</h3>${button}</div><p>${desc}</p>`;
  const add=(kind,label)=>`<button class="outline-btn" data-action="add-advanced" data-kind="${kind}">+ ${label}</button>`;
  const items=(kind,detail)=>`<div class="settings-list">${normalizeList(a[kind]).map(item=>`<div class="settings-item"><div><strong>${esc(item.name||item.title||item.email||item.id)}</strong><small>${esc(detail(item))}</small></div><div>${kind==='automations'?`<button data-action="run-automation" data-id="${esc(item.id)}">실행</button>`:''}${kind==='forms'?`<button data-action="fill-form" data-id="${esc(item.id)}">응답</button>`:''}${kind==='sites'?`<button data-action="site-link" data-id="${esc(item.id)}">링크</button>`:''}<button data-action="edit-advanced" data-kind="${kind}" data-id="${esc(item.id)}">관리</button></div></div>`).join('')||'<div class="empty">아직 항목이 없어요. 첫 번째 항목을 만들어 보세요.</div>'}</div>`;
  if(tab==='members') {
    content.innerHTML=header('함께 만드는 워크스페이스','팀원을 초대하고, 역할과 그룹을 관리하세요.',add('members','멤버 초대'))+items('members',m=>`${m.email||''} · ${m.role||'member'}`)+`<div class="section-heading" style="margin-top:28px"><h3>그룹</h3>${add('groups','그룹 추가')}</div>`+items('groups',g=>`${(g.members||[]).length}명의 멤버`);
  }
  else if(tab==='security') {
    const s=a.settings||state.workspace.settings|| {
    };
    content.innerHTML=header('보안 및 권한','워크스페이스의 데이터 접근 정책을 설정하세요.')+`<form class="form-grid" id="security-form">${field('워크스페이스 이름','workspace_name','Fountain 스튜디오','text',s.name||'Fountain 스튜디오')}<label style="display:flex;align-items:center"><input class="toggle" style="width:auto" type="checkbox" name="disable_guests" ${s.disable_guests?'checked':''}> 게스트 등록 제한</label><label style="display:flex;align-items:center"><input class="toggle" style="width:auto" type="checkbox" name="allow_public_sharing" ${!s.disable_public_sharing?'checked':''}> 공개 링크 공유 허용</label><label style="display:flex;align-items:center"><input class="toggle" style="width:auto" type="checkbox" name="allow_export" ${!s.disable_export?'checked':''}> 데이터 내보내기 허용</label>${field('휴지통 보존 기간 (일)','trash_retention_days','30','number',s.trash_retention_days??30)}${field('사용자 지정 도메인','custom_domain','예: home.example.com','text',s.custom_domain||'')}<button class="solid-btn">설정 저장</button></form><div class="info-box" style="margin-top:20px">로컬 워크스페이스입니다. 공유 암호를 설정하면 가족이 같은 공간에 로그인할 수 있습니다. 멤버별 로그인·역할 검증은 별도 인증 연동이 필요하며, 사용자 지정 도메인의 DNS·TLS는 직접 설정해야 합니다.</div><button class="outline-btn" style="margin-top:15px" data-action="activity">감사 로그 보기 ↗</button><button class="outline-btn" style="margin:15px 0 0 8px" data-action="logout">로그아웃</button>`;
  }
  else if(tab==='automations')content.innerHTML=header('작업에 흐름을 더하세요','조건에 맞는 데이터베이스 항목을 자동으로 업데이트합니다.',add('automations','자동화 만들기'))+items('automations',i=>`${i.enabled===false?'일시 중지':'활성'} · ${i.trigger||i.event||'수동 실행'}`);
  else if(tab==='forms')content.innerHTML=header('질문을 모아, 다음 단계로','폼을 만들고 응답을 데이터베이스에 수집하세요.',add('forms','폼 만들기'))+items('forms',i=>`${i.database_id||'연결된 데이터베이스 없음'} · ${(i.fields||[]).length}개 질문`);
  else if(tab==='sites')content.innerHTML=header('아이디어를 세상에 공유하세요','페이지를 공개 사이트로 게시합니다. 공개 범위를 확인하세요.',add('sites','사이트 만들기'))+items('sites',i=>`${i.published?'게시됨':'초안'} · ${i.slug||i.page_id||''}`);
  else if(tab==='AI') {
    content.innerHTML=header('생각의 다음 한 걸음','페이지 요약, 초안 작성, 번역, 질문을 AI 도우미에서 시작하세요.')+'<button class="solid-btn" data-action="ai">✦ AI 도우미 열기</button><div class="info-box" style="margin-top:20px">무료 로컬 모델(Ollama 등) 또는 호환 API를 연결해 사용할 수 있습니다. 모델이 연결되지 않으면 AI 작업을 실행하지 않습니다. 별도 구독 없이 가족과 함께 사용할 수 있습니다.</div><div class="section-heading" style="margin-top:28px"><h3>연결 및 통합</h3>'+add('integrations','연결 추가')+'</div>'+items('integrations',i=>`${i.provider||i.type||'사용자 정의'} · ${i.status||'연결 설정 필요'}`);
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
    content.innerHTML=header('데이터는 언제나 내 손에','워크스페이스를 백업하거나 Markdown과 CSV로 데이터를 가져오세요.')+'<div class="form-actions" style="justify-content:flex-start"><button class="outline-btn" data-action="export" data-format="json">JSON 백업</button><button class="outline-btn" data-action="export" data-format="markdown">Markdown</button><button class="outline-btn" data-action="export" data-format="csv">CSV</button></div><form class="form-grid" id="import-form" style="margin-top:25px"><label>가져올 형식<select name="format"><option value="markdown">Markdown</option><option value="csv">CSV</option><option value="json">JSON 백업</option></select></label>'+field('제목','title','가져온 문서')+'<label>내용<textarea name="content" required placeholder="파일 내용을 여기에 붙여넣으세요"></textarea></label><button class="solid-btn">가져오기</button></form>';
  }
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
  if(kind==='members')content=nameField+field('이메일','email','name@company.com','email',item.email||'')+select('역할','role',[['owner','소유자'],['member','멤버'],['admin','관리자'],['guest','게스트']],item.role||'member')+'<div class="info-box">워크스페이스의 로컬 멤버를 등록합니다. 초대 이메일 전송과 계정 로그인에는 인증 서비스 연결이 필요합니다.</div>';
  else if(kind==='groups')content=nameField+`<label>그룹 멤버<select name="members" multiple style="min-height:100px">${(state.advanced.members||[]).map(m=>`<option value="${esc(m.id)}" ${(item.members||[]).includes(m.id)?'selected':''}>${esc(m.name||m.email)}</option>`).join('')}</select></label>`;
  else if(kind==='teamspaces')content=nameField+select('접근 범위','visibility',[['open','열린 팀스페이스'],['closed','비공개 팀스페이스'],['private','초대한 멤버 전용']],item.visibility||'open');
  else if(kind==='sites')content=nameField+select('게시할 페이지','page_id',pages.map(p=>[p.id,p.title]),item.page_id||pages[0]?.id)+field('사이트 주소','slug','our-team','text',item.slug||'')+field('검색 결과 제목','seo_title','사이트 제목','text',item.seo_title||'')+field('설명','description','페이지를 소개해 주세요','text',item.description||'')+checkbox('공개 사이트로 게시','published',!!item.published)+'<div class="info-box">게시하면 링크를 가진 누구나 페이지 내용을 열람할 수 있습니다.</div>';
  else if(kind==='forms')content=nameField+select('응답을 저장할 데이터베이스','database_id',dbs.map(d=>[d.id,d.name||d.title]),item.database_id||dbs[0]?.id)+`<label>질문 (JSON)<textarea name="fields" spellcheck="false" required>${esc(JSON.stringify(item.fields||[{id:'name',label:'프로젝트 이름',type:'text',required:true,property_id:'name'},{id:'status',label:'진행 상태',type:'select',property_id:'status',options:['시작 전','진행 중','완료']}],null,2))}</textarea></label>`+checkbox('폼 공개 및 응답 허용','published',!!item.published)+'<div class="info-box">각 질문의 property_id는 연결된 데이터베이스의 속성 ID와 같아야 합니다. 질문에 condition: {field, equals}를 추가하면 조건부로 표시됩니다.</div>';
  else if(kind==='automations')content=nameField+select('데이터베이스','database_id',dbs.map(d=>[d.id,d.name||d.title]),item.database_id||dbs[0]?.id)+select('실행 조건','trigger',[['manual','직접 실행'],['row.created','항목을 만들었을 때'],['row.updated','항목을 수정했을 때']],item.trigger||'manual')+`<label>실행할 작업 (JSON)<textarea name="actions" required spellcheck="false">${esc(JSON.stringify(item.actions||[{type:'set_property',property_id:'status',value:'완료'}],null,2))}</textarea></label>`+checkbox('자동화 활성화','enabled',item.enabled!==false);
  else if(kind==='integrations')content=nameField+select('제공자','provider',[['webhook','Webhook'],['slack','Slack'],['github','GitHub'],['google_drive','Google Drive'],['custom','사용자 정의']],item.provider||'webhook')+field('연결 URL','url','https://…','url',item.url||'')+'<div class="info-box">연결 메타데이터를 등록합니다. 실제 동기화와 OAuth 인증은 공급자 연결이 필요합니다.</div>';
  openModal(`${id?'관리':'새로 만들기'} · ${{members:'멤버',groups:'그룹',teamspaces:'팀스페이스',forms:'폼',sites:'사이트',automations:'자동화',integrations:'연결'}[kind]||kind}`,`<form id="advanced-form" data-kind="${kind}" data-id="${esc(id||'')}" class="form-grid">${content}<div class="form-actions"><button type="button" class="outline-btn" data-action="settings">설정으로 돌아가기</button><button class="solid-btn">저장하기</button></div></form>`);
}
async function showAI() {
  openModal('✦ Fountain AI',`<p>아이디어의 시작부터 문서의 마무리까지, AI와 함께해 보세요.</p><form class="form-grid" id="ai-form"><label>작업<select name="action"><option value="summarize">페이지 요약</option><option value="write">초안 작성</option><option value="translate">번역</option><option value="answer">워크스페이스 질문</option></select></label><label>요청<textarea name="prompt" placeholder="어떤 도움이 필요한가요? 예: 이 문서를 세 문장으로 요약해 주세요."></textarea></label><button class="solid-btn">✦ 실행하기</button></form><div id="ai-output" aria-live="polite"></div><div class="info-box" style="margin-top:20px">공급자 연결 상태에 따라 실행 가능한 작업이 달라집니다. 민감한 정보는 전송 전에 확인하세요.</div>`);
}
function download(filename,content,mime='text/plain') {
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
  if (state.titleSaving) await state.titleSaving;
  clearTimeout(state.titleTimer);
  const pending = state.titlePending;
  if (!pending) return;
  state.titlePending = null;
  state.titleSaving = (async () => {
    try {
      if (state.page?.id === pending.id) await updatePage({title:pending.title});
      else await api('/pages/' + pending.id, {title:pending.title}, 'PATCH');
    } catch (error) {
      state.titlePending ||= pending;
      throw error;
    }
  })();
  try { await state.titleSaving; }
  finally { state.titleSaving = null; }
}
async function updatePage(patch) {
  await savePage();
  const id = state.page.id;
  const p=await api('/pages/'+id,{...patch,revision:state.page.revision},'PATCH');
  if (state.page?.id !== id) return;
  state.page=p.page||p;
  const index=state.workspace.pages.findIndex(p=>p.id===state.page.id);
  if(index>=0)state.workspace.pages[index]=state.page;
  renderSidebar();
  renderTopbar(state.page.title,state.page.icon);
}
async function historyModal() {
  await savePage();
  const d=await api('/pages/'+state.page.id);
  state.versions=d.versions||[];
  openModal('페이지 기록',`<p>이전 버전을 복원하면 현재 내용이 새 버전으로 보관됩니다.</p>${state.versions.map(v=>`<div class="history-item"><div>버전 ${esc(v.revision||v.version||'')}<small>${esc(v.title||state.page.title)} · ${date(v.created_at)}</small></div><button data-action="restore-version" data-id="${esc(v.id)}">이 버전 복원</button></div>`).join('')||'<div class="empty">아직 저장된 이전 버전이 없습니다.</div>'}`);
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
async function doAction(target) {
  const a=target.dataset.action,id=target.dataset.id;
  switch(a) {
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
    case'logout':await api('/session', {
    },'DELETE');
    closeModal();
    renderLogin();
    break;
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
    case'change-icon':openModal('페이지 아이콘',form(field('이모지','icon','🌿','text',state.page.icon),'icon-form','변경하기'));
    break;
    case'add-block':addBlock();
    break;
    case'block-menu': {
      state.activeBlock=id;
      const b=state.blocks.find(b=>b.id===id);
      openModal('블록 관리',`<div class="form-grid"><label>블록 종류<select id="block-type-select">${blockTypes.map(([k,n])=>`<option value="${k}" ${k===b.type?'selected':''}>${n}</option>`).join('')}</select></label><button class="outline-btn" data-action="change-block-type" data-id="${esc(id)}">종류 변경</button><div class="form-actions"><button class="outline-btn" data-action="move-block" data-id="${esc(id)}" data-direction="-1">↑ 위로</button><button class="outline-btn" data-action="move-block" data-id="${esc(id)}" data-direction="1">↓ 아래로</button><button class="danger-btn" data-action="delete-block" data-id="${esc(id)}">블록 삭제</button></div></div>`);
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
    case'restore-version':await api('/pages/'+state.page.id+'/versions/'+id+'/restore', {
    });
    await navigate('page',state.page.id);
    toast('페이지 버전을 복원했습니다.');
    break;
    case'resolve-comment':await api('/comments/'+id, {
      resolved:true
    },'PATCH');
    state.comments.find(c=>c.id===id).resolved=true;
    $('#comments').innerHTML=commentsHTML();
    break;
    case'page-menu':openModal('페이지 메뉴',`<div class="form-grid"><button class="outline-btn" data-action="copy-blocks">${icon('link')}블록 복사</button><button class="outline-btn" data-action="lock-page">${icon('lock')}${state.page.locked?'페이지 잠금 해제':'페이지 잠그기'}</button><button class="outline-btn" data-action="verify-page">${state.page.verification?"페이지 검증 해제":"페이지 검증"}</button><button class="outline-btn" data-action="move-page">페이지 이동</button><button class="outline-btn" data-action="duplicate-page">페이지 복제</button><button class="outline-btn" data-action="history">${icon('clock')}페이지 기록</button><button class="danger-btn" data-action="delete-page">${icon('trash')}휴지통으로 이동</button></div>`);
    break;
    case'lock-page':await savePage();
    await updatePage( {
      locked:!state.page.locked
    });
    closeModal();
    renderPage();
    break;
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
        blocks:state.blocks.map(b=>( {
          ...b,id:uid()
        })),revision:p.revision||p.page?.revision
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
    case'share':openModal('페이지 공유',`<p>같은 로컬 서버에 접근할 수 있는 사람에게 이 주소를 공유하세요.</p><input style="width:100%" readonly value="${esc(location.origin+'/#page/'+state.page.id)}"><button class="solid-btn" data-action="copy-link" style="margin-top:15px">${icon('link')}링크 복사</button><div class="info-box" style="margin-top:20px">외부 공개 페이지는 설정의 사이트에서 별도로 게시할 수 있습니다.</div><button class="outline-btn" style="margin-top:15px" data-action="open-sites">사이트 게시 설정</button>`);
    break;
    case'copy-link': {
      const el=$('.modal-body input');
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
    case'run-automation':openModal('자동화 실행',`<p>작업을 적용할 데이터베이스 항목의 ID를 선택하세요.</p><form id="run-automation-form" data-id="${esc(id)}" class="form-grid"><label>대상 항목<select name="row_id">${state.rows.map(r=>`<option value="${esc(r.id)}">${esc(nameOf(r))}</option>`).join('')}</select></label><button class="solid-btn">실행하기</button></form>`);
    break;
    case'fill-form':window.open('/forms/'+encodeURIComponent(id),'_blank','noopener');
    break;
    case'site-link': {
      const site=state.advanced.sites.find(s=>s.id===id);
      if(!site.published) {
        toast('먼저 사이트를 게시해 주세요.');
        break;
      }
      window.open('/sites/'+encodeURIComponent(site.slug),'_blank','noopener');
      break;
    }
    case'add-row':if(!state.database) {
      toast('먼저 데이터베이스를 만들어 주세요.');
      break;
    }
    openRow(null,target.dataset.status);
    break;
    case'edit-row':openRow(id);
    break;
    case'delete-row':await api('/databases/'+state.database.id+'/rows/'+id, {
    },'DELETE');
    closeModal();
    await reloadDatabase();
    toast('항목을 삭제했습니다.');
    break;
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
      const cell=v=>'"'+String(Array.isArray(v)?v.join(', '):v??'').replace(/"/g,'""')+'"';
      const csv='\uFEFF'+[props.map(p=>cell(p.name)).join(','),...filteredRows().map(r=>props.map(p=>cell(valuesOf(r)[p.id])).join(','))].join('\r\n');
      download((state.database.name||'database')+'.csv',csv,'text/csv;charset=utf-8');
      toast('CSV를 내보냈습니다.');
      break;
    }
    case'new-database':openModal('새 데이터베이스',form(field('데이터베이스 이름','name','팀 프로젝트'),'database-form'));
    break;
    case'new-property':openModal('데이터베이스 속성 추가',form(field('속성 이름','name','마감일')+`<label>속성 종류<select name="type"><option value="text">텍스트</option><option value="number">숫자</option><option value="status">상태</option><option value="select">선택</option><option value="date">날짜</option><option value="person">사람</option><option value="checkbox">체크박스</option><option value="multi_select">다중 선택</option><option value="files">파일 ID 목록</option><option value="url">URL</option><option value="email">이메일</option><option value="relation">관계형</option><option value="formula">수식</option><option value="rollup">롤업</option></select></label>`+field('선택 항목 (쉼표로 구분)','options','시작 전, 진행 중, 완료')+field('수식','expression',"prop('estimate') * 2")+`<label>관계형 대상 데이터베이스<select name="database_id">${state.workspace.databases.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>롤업에 사용할 관계 속성<select name="relation_property"><option value="">관계 속성을 선택하세요</option>${state.database.properties.filter(p=>p.type==='relation').map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('')}</select></label>`+field('롤업 대상 속성 ID','target_property','estimate')+`<label>롤업 집계<select name="aggregation"><option value="sum">합계</option><option value="count">개수</option><option value="average">평균</option><option value="min">최솟값</option><option value="max">최댓값</option></select></label>`,'property-form'));
    break;
    case'export': {
      const data=await api('/export?format='+target.dataset.format);
      download(data.filename,data.content,data.mime);
      toast('백업 파일을 내보냈습니다.');
      break;
    }
  }
}
document.addEventListener('click',event=> {
  const target=event.target.closest('[data-action]'); if(target) {
    event.preventDefault(); doAction(target).catch(error=>toast(error.message));
  }
  else if(event.target.classList.contains('modal-backdrop'))closeModal(); else if(!event.target.closest('.slash-menu,.block-content'))closeSlash();
});
document.addEventListener('input',event=> {
  const el=event.target; if(el.id==='page-title') {
    clearTimeout(state.titleTimer);
    state.titlePending={id:state.page.id,title:el.innerText.trim()||'제목 없음'};
    state.titleTimer=setTimeout(()=>saveTitle().catch(e=>toast(e.message)),450);
  }
  if(el.classList.contains('block-content')) {
    const text=el.innerText,b=state.blocks.find(b=>b.id===el.closest('.block').dataset.id); if(b)b.text=text; if(text.startsWith('/'))openSlash(b.id,text.slice(1)); else closeSlash(); scheduleSave();
  }
  if(el.id==='search-input') {
    clearTimeout(state.searchTimer); state.searchTimer=setTimeout(()=>renderSearch(el.value),150);
  }
  if(el.id==='db-filter-input') {
    state.filter=el.value; $('#db-view').innerHTML=databaseView();
  }
});
document.addEventListener('change',event=> {
  const el=event.target; if(el.dataset.check) {
    const b=state.blocks.find(b=>b.id===el.dataset.check); b.checked=el.checked; el.closest('.block').classList.toggle('checked',el.checked); scheduleSave();
  }
});
document.addEventListener('keydown',event=> {
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
  const el=event.target.closest('.block-content'); if(!el)return; const block=el.closest('.block'),id=block.dataset.id,b=state.blocks.find(b=>b.id===id); if(event.key==='Enter'&&!event.shiftKey&&b.type!=='code') {
    event.preventDefault(); if($('.slash-menu')) {
      $('.slash-menu button')?.click(); return;
    }
    readBlocks(); if(!b.text&&['bullet','numbered','todo','heading1','heading2','heading3','quote'].includes(b.type)) {
      b.type='paragraph'; renderBlocks(id); scheduleSave(); return;
    }
    const sel=getSelection(); const range=sel.rangeCount?sel.getRangeAt(0).cloneRange():null; let offset=b.text.length; if(range) {
      const before=range.cloneRange(); before.selectNodeContents(el); before.setEnd(range.startContainer,range.startOffset); offset=before.toString().length;
    }
    const rest=b.text.slice(offset); b.text=b.text.slice(0,offset); const type=['todo','bullet','numbered'].includes(b.type)?b.type:'paragraph'; const next= {
      id:uid(),type,text:rest
    }; state.blocks.splice(state.blocks.indexOf(b)+1,0,next); renderBlocks(next.id); scheduleSave();
  }
  else if(event.key==='Backspace'&&!el.innerText) {
    const i=state.blocks.indexOf(b); if(i>0) {
      event.preventDefault(); state.blocks.splice(i,1); renderBlocks(state.blocks[i-1].id); scheduleSave();
    }
  }
  else if(event.key===' ') {
    const shortcuts= {
      '#':'heading1','##':'heading2','###':'heading3','-':'bullet','*':'bullet','1.':'numbered','[]':'todo','[ ]':'todo','>':'quote','```':'code','---':'divider'
    }; if(shortcuts[el.innerText]) {
      event.preventDefault(); b.type=shortcuts[el.innerText]; b.text=''; renderBlocks(id); scheduleSave();
    }
  }
});
let dragId=null;
document.addEventListener('dragstart',e=> {
  const b=e.target.closest('.block'); if(!b||e.target.closest('[contenteditable=true]')) {
    e.preventDefault(); return;
  }
  dragId=b.dataset.id; b.classList.add('dragging'); e.dataTransfer.setData('text/plain',dragId);
});
document.addEventListener('dragover',e=> {
  if(dragId&&e.target.closest('.block'))e.preventDefault();
});
document.addEventListener('drop',e=> {
  const b=e.target.closest('.block'); if(!dragId||!b)return; e.preventDefault(); readBlocks(); const from=state.blocks.findIndex(b=>b.id===dragId),to=state.blocks.findIndex(v=>v.id===b.dataset.id); const [item]=state.blocks.splice(from,1); state.blocks.splice(to,0,item); renderBlocks(dragId); scheduleSave(); dragId=null;
});
document.addEventListener('dragend',()=> {
  $$('.dragging').forEach(b=>b.classList.remove('dragging')); dragId=null;
});
document.addEventListener('submit',async event=> {
  const formElement=event.target; if(!formElement.id)return; event.preventDefault(); const data=Object.fromEntries(new FormData(formElement)),submit=$('button[type=submit],button.solid-btn',formElement); if(submit)submit.disabled=true; try {
    switch(formElement.id) {
      case'login-form':await api('/session', {
        token:data.token
      }); await boot(); break; case'page-form': {
        const p=await api('/pages', {
          title:data.title||'제목 없음',icon:data.icon||'📄',parent_id:formElement.dataset.parent||null
        }); await refreshWorkspace(); await navigate('page',p.id||p.page.id); break;
      }
      case'icon-form':await updatePage( {
        icon:data.icon
      }); closeModal(); renderPage(); break; case'move-page-form':await updatePage( {
        parent_id:data.parent_id||null
      }); closeModal(); toast('페이지를 이동했습니다.'); break; case'comment-form': {
        const c=await api('/pages/'+state.page.id+'/comments', {
          text:data.text
        }); state.comments.push(c.comment||c); $('#comments').innerHTML=commentsHTML(); formElement.reset(); toast('댓글을 남겼습니다.'); break;
      }
      case'row-form': {
        const properties= {
        }; for(const p of state.database.properties) {
          if(['formula','rollup','created_time','last_edited_time'].includes(p.type))continue; properties[p.id]=p.type==='checkbox'?formElement.elements.namedItem(p.id).checked:p.type==='number'?(data[p.id]!==''?Number(data[p.id]):null):['relation','multi_select','files'].includes(p.type)?String(data[p.id]||'').split(',').map(s=>s.trim()).filter(Boolean):data[p.id]||'';
        }
        await api('/databases/'+state.database.id+'/rows'+(formElement.dataset.id?'/'+formElement.dataset.id:''), {
          properties
        },formElement.dataset.id?'PATCH':'POST'); closeModal(); await reloadDatabase(); toast('프로젝트를 저장했습니다.'); break;
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
        }; for(const key of ['fields','actions'])if(key in payload)payload[key]=JSON.parse(payload[key]); for(const key of ['enabled','published'])if($(`[name="${key}"]`,formElement))payload[key]=$(`[name="${key}"]`,formElement).checked; if(kind==='groups')payload.members=new FormData(formElement).getAll('members'); await api('/'+kind+(id?'/'+id:''),payload,id?'PATCH':'POST'); await refreshWorkspace(); await openSettings( {
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
        $('#ai-output').innerHTML='<div class="empty">응답을 준비하고 있어요…</div>'; if(state.route==='page')await savePage(); try {
          const r=await api('/ai', {
            ...data,page_id:state.route==='page'?state.page.id:undefined
          }); $('#ai-output').innerHTML=`<div class="ai-result">${esc(r.text||r.output||r.result||JSON.stringify(r))}</div><p class="small muted">${esc(r.provider||r.mode||'')}</p>`;
        }
        catch(e) {
          $('#ai-output').innerHTML=`<div class="info-box" style="margin-top:15px">${esc(e.message)}</div>`;
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
function renderLogin() {
  state.loaded=false;
  $('#sidebar').innerHTML='';
  $('#topbar').innerHTML='';
  $('#main').innerHTML=`<div class="login-wrap"><div class="brand"><span class="brand-mark">f</span>fountain</div><h1>우리 가족의 작은 작업실</h1><p>가족과 나누는 문서, 아이디어, 일상.<br>공유 암호를 입력하고 함께 시작하세요.</p><form class="form-grid" id="login-form"><label>공유 암호<input name="token" type="password" required autocomplete="current-password" autofocus placeholder="가족 공유 암호"></label><button class="solid-btn">워크스페이스 열기</button><div id="login-error" role="alert"></div></form><small class="muted">Fountain · 구독 없이, 함께 쓰는 공간</small></div>`;
  document.body.classList.add('login-mode');
}
async function boot() {
  try {
    document.body.classList.remove('login-mode');
    await refreshWorkspace();
    state.loaded=true;
    const [route,id]=location.hash.slice(1).split('/');
    if(['page','database'].includes(route)&&id)await navigate(route,decodeURIComponent(id));
    else await navigate('home');
  }
  catch(e) {
    if(e.status===401) {
      renderLogin();
      return;
    }
    $('#main').innerHTML=`<div class="empty"><h2>워크스페이스에 연결하지 못했어요.</h2><p>${esc(e.message)}</p><button class="outline-btn" data-action="reload">다시 시도</button></div>`;
  }
}
window.addEventListener('hashchange', () => {
  if (!state.loaded) return;
  const [route, encodedId] = location.hash.slice(1).split('/');
  let id;
  try { id = encodedId ? decodeURIComponent(encodedId) : undefined; }
  catch { return; }
  const currentId = state.route === 'page' ? state.page?.id : state.database?.id;
  if (route === state.route && (route === 'home' || id === currentId)) return;
  navigate(['page', 'database'].includes(route) && id ? route : 'home', id);
});
boot();
