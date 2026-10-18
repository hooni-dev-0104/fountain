/* The organization realm has its own memory, transport, and session boundary. */
'use strict';
(function (root) {
  const PREFIX = '/api/organization';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CODE_KEYS = ['expiresAt', 'nonce', 'organizationId', 'requestId', 'revision', 'v', 'workspaceId'];
  class StaleResponse extends Error { constructor() { super('이전 로그인에서 시작한 요청입니다.'); this.code = 'STALE_RESPONSE'; } }
  function uuid() { return root.crypto.randomUUID(); }
  function randomCode() { return Array.from(root.crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join(''); }
  function pathAllowed(path) {
    return typeof path === 'string' && path.startsWith(PREFIX + '/') && !/[\\\u0000-\u0020\u007f#]/.test(path) && !/%(?:2e|2f|5c|25)/i.test(path) && !path.split('?')[0].split('/').some(part => part === '.' || part === '..');
  }
  function parseConnectionCode(value, now = Date.now()) {
    if (typeof value !== 'string' || value.length < 30 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('연결 코드 전체를 붙여 넣어 주세요.');
    let result;
    try { result = JSON.parse(root.atob(value.replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw Error('올바른 연결 코드가 아닙니다.'); }
    if (!result || Array.isArray(result) || Object.keys(result).sort().join(',') !== CODE_KEYS.join(',') || result.v !== 1 || !UUID.test(result.organizationId) || !UUID.test(result.requestId) || !Number.isSafeInteger(result.revision) || result.revision < 1 || typeof result.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(result.nonce) || typeof result.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(result.workspaceId) || !['string', 'number'].includes(typeof result.expiresAt)) throw Error('연결 코드 형식을 확인해 주세요.');
    const expiry = typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(result.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) throw Error('만료된 연결 코드입니다. 새 코드를 요청해 주세요.');
    return Object.freeze(result);
  }
  function encodeConnectionCode(value) {
    const raw = JSON.stringify(value);
    // The wire envelope contains ASCII identifiers only, never display names.
    const encoded = root.btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    parseConnectionCode(encoded);
    return encoded;
  }
  function createSessionFence() {
    let epoch = 0, binding = null;
    return Object.freeze({
      capture: () => Object.freeze({ epoch, binding }),
      current: scope => scope.epoch === epoch && scope.binding === binding,
      reset: value => { epoch++; binding = value || null; },
      binding: () => binding,
    });
  }
  function createCommand(method, path, body, binding) {
    if (!pathAllowed(path) || !['POST', 'PATCH', 'DELETE'].includes(method) || typeof binding !== 'string' || !binding) throw Error('요청을 확인할 수 없습니다.');
    const payload = Object.freeze({ ...body, session_binding: binding, command_id: body.command_id || uuid() });
    return Object.freeze({ method, path, body: JSON.stringify(payload), binding });
  }
  root.FountainOrganizationModel = Object.freeze({ parseConnectionCode, encodeConnectionCode, createSessionFence, createCommand, pathAllowed });
  if (!root.document) return;

  const app = root.document.getElementById('organization-app');
  const fence = createSessionFence();
  const state = { session: null, organizations: [], selected: null, detail: null, eligibility: null, error: '', notice: '', loading: true, busy: false, pending: null, connection: null, preview: null, confirmation: null, listSequence: 0, detailSequence: 0, sessionSequence: 0, logoutBinding: null };
  let channel;
  try { channel = new root.BroadcastChannel('fountain-organization-session'); } catch { /* Session revalidation on focus remains available. */ }
  function announce() { channel?.postMessage({ type: 'changed' }); }
  function element(tag, attributes = {}, ...children) {
    const item = root.document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') item.className = value;
      else if (key === 'text') item.textContent = String(value);
      else if (key === 'checked' || key === 'disabled' || key === 'readOnly' || key === 'required' || key === 'hidden' || key === 'open') item[key] = value;
      else item.setAttribute(key, String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) item.append(typeof child === 'string' ? root.document.createTextNode(child) : child);
    return item;
  }
  function button(label, action, data = {}, style = '', disabled = state.busy || !!state.pending) {
    return element('button', { type: 'button', class: style, 'data-action': action, disabled, ...Object.fromEntries(Object.entries(data).map(([key, value]) => ['data-' + key, value])) }, label);
  }
  function input(label, name, type = 'text', options = {}) { return element('label', {}, label, element('input', { name, type, ...options })); }
  function checkbox(label, name) { return element('label', { class: 'check' }, element('input', { name, type: 'checkbox', required: true }), element('span', {}, label)); }
  function submit(label) { return element('button', { type: 'submit', class: 'primary', disabled: state.busy || !!state.pending }, label); }
  function form(id, attributes = {}, ...children) { return element('form', { id, class: 'stack', ...attributes }, ...children); }
  function date(value) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
  function card(title, description, ...children) { return element('section', { class: 'card' }, element('h2', {}, title), description && element('p', { class: 'muted' }, description), ...children); }
  function clearPrivate(message = '') {
    fence.reset(null); state.session = null; state.organizations = []; state.selected = null; state.detail = null; state.eligibility = null; state.pending = null; state.preview = null; state.connection = null; state.confirmation = null; state.busy = false; state.notice = ''; state.error = message; state.logoutBinding = null;
    // Replacing these controls also discards password, claim, and connection inputs.
    app.replaceChildren();
  }
  async function wire(path, options = {}) {
    if (!pathAllowed(path)) throw Error('허용되지 않는 조직 요청입니다.');
    const headers = new Headers(options.headers);
    headers.set('X-Fountain-Request', '1');
    if (options.body) headers.set('Content-Type', 'application/json');
    const requestOptions = { ...options, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store' };
    const transport = root.FountainOrganizationTransport || root.FountainTransport;
    let response = transport?.request ? await transport.request(path, requestOptions) : await root.fetch(path, requestOptions);
    if (typeof response?.json !== 'function') {
      if (!Number.isInteger(response?.status)) throw Error('조직 서버 응답을 확인할 수 없습니다.');
      const body = response.body;
      response = new Response(typeof body === 'string' ? body : JSON.stringify(body ?? null), { status: response.status, headers: response.headers });
    }
    let value;
    try { value = await response.json(); } catch { throw Object.assign(Error('조직 서버 응답을 확인할 수 없습니다.'), { status: response.status }); }
    if (!response.ok) {
      const message = typeof value?.error === 'string' ? value.error : typeof value?.error?.message === 'string' ? value.error.message : typeof value?.message === 'string' ? value.message : '요청을 처리하지 못했습니다.';
      throw Object.assign(Error(message), { status: response.status });
    }
    return value;
  }
  async function boundRequest(path, options = {}) {
    const scope = fence.capture();
    if (!scope.binding) throw new StaleResponse();
    const method = options.method || 'GET';
    const fullPath = PREFIX + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + 'session_binding=' + encodeURIComponent(scope.binding) : '');
    try {
      const value = await wire(fullPath, options);
      if (!fence.current(scope)) throw new StaleResponse();
      if (value?.session_binding !== scope.binding) {
        clearPrivate('조직 로그인이 변경되었습니다. 다시 확인해 주세요.'); state.loading = false; render(); throw new StaleResponse();
      }
      return value;
    } catch (error) {
      if (!fence.current(scope)) throw new StaleResponse();
      if (error.status === 401) { clearPrivate('조직 로그인이 만료되었습니다. 다시 로그인해 주세요.'); state.loading = false; render(); announce(); }
      throw error;
    }
  }
  async function checkSession() {
    const sequence = ++state.sessionSequence;
    const scope = fence.capture();
    try {
      const value = await wire(PREFIX + '/session');
      if (sequence !== state.sessionSequence || !fence.current(scope)) return;
      if (value?.authenticated === true && typeof value.cache_binding === 'string' && value.cache_binding) {
        const changed = fence.binding() !== value.cache_binding;
        if (changed) clearPrivate();
        state.session = value;
        if (changed) fence.reset(value.cache_binding);
        state.loading = false;
        if (changed || !state.organizations.length) await loadHome();
        else render();
      } else {
        clearPrivate(); state.session = value; state.loading = false; render();
      }
    } catch (error) {
      if (sequence !== state.sessionSequence || !fence.current(scope)) return;
      state.loading = false; state.error = error.message; render();
    }
  }
  async function loadHome(preferred = state.selected) {
    const scope = fence.capture(), sequence = ++state.listSequence;
    state.loading = true; render();
    try {
      const [list, eligibility] = await Promise.all([boundRequest('/organizations'), boundRequest('/setup-eligibility')]);
      if (!fence.current(scope) || sequence !== state.listSequence) return;
      state.organizations = Array.isArray(list.organizations) ? list.organizations : [];
      state.eligibility = eligibility;
      state.selected = state.organizations.some(item => item.organization_id === preferred) ? preferred : state.organizations[0]?.organization_id || null;
      state.detail = null; state.loading = false;
      render();
      if (state.selected) await loadDetail(state.selected);
    } catch (error) {
      if (!fence.current(scope) || sequence !== state.listSequence || error.code === 'STALE_RESPONSE') return;
      state.loading = false; state.error = error.message; render();
    }
  }
  async function loadDetail(id) {
    const scope = fence.capture(), sequence = ++state.detailSequence;
    state.selected = id; state.detail = null; state.confirmation = null; state.preview = null; state.connection = null; render();
    try {
      const value = await boundRequest('/organizations/' + encodeURIComponent(id));
      if (!fence.current(scope) || sequence !== state.detailSequence || state.selected !== id) return;
      state.detail = value; render();
    } catch (error) {
      if (!fence.current(scope) || sequence !== state.detailSequence || error.code === 'STALE_RESPONSE') return;
      state.error = error.message; render();
    }
  }
  function issue(error) { if (error.code !== 'STALE_RESPONSE') { state.error = error.message; render(); } }
  async function mutate(method, path, body, label, effect = null) {
    if (state.busy || state.pending) return;
    state.pending = { command: createCommand(method, PREFIX + path, body, fence.binding()), label, effect };
    await sendPending();
  }
  async function sendPending() {
    const pending = state.pending;
    if (!pending || state.busy || pending.command.binding !== fence.binding()) return;
    const scope = fence.capture(); state.busy = true; state.error = ''; state.notice = ''; render();
    try {
      const result = await boundRequest(pending.command.path.slice(PREFIX.length), { method: pending.command.method, body: pending.command.body });
      if (!fence.current(scope) || state.pending !== pending) return;
      state.pending = null; state.confirmation = null;
      state.notice = pending.label + '을 완료했습니다.';
      // This refresh invalidates old revisions, and never reuses a successful command for new input.
      await loadHome(result.organization_id || state.selected);
      if (!fence.current(scope)) return;
      state.busy = false;
      if (result.organization_id === state.selected) pending.effect?.(result);
      render();
    } catch (error) {
      if (!fence.current(scope) || error.code === 'STALE_RESPONSE') return;
      state.busy = false;
      if (error.status >= 400 && error.status < 500) {
        state.pending = null;
        state.error = error.status === 409 ? '조직 정보가 변경되었습니다. 새로고침한 내용을 확인한 뒤 다시 진행해 주세요.' : error.message;
        if ([403, 404, 409].includes(error.status)) await loadHome();
      } else state.error = '완료 여부를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.';
      render();
    }
  }
  function mutationBody(extra = {}) { if (!state.detail) throw Error('조직을 먼저 선택해 주세요.'); return { revision: state.detail.revision, ...extra }; }
  function renderLogin() {
    const disabled = state.session?.enabled === false;
    return element('section', { class: 'login-card' }, element('span', { class: 'eyebrow' }, 'ORGANIZATION'), element('h1', {}, '조직의 공간을', element('br'), '함께 관리해요'), element('p', {}, '조직 소유자 계정으로 로그인하세요. 워크스페이스에 속하지 않아도 조직을 관리할 수 있어요.'),
      disabled ? element('p', { class: 'notice' }, '이 서버에는 조직 로그인이 아직 설정되지 않았습니다.') : state.logoutBinding ? button('로그아웃 다시 확인', 'retry-logout', {}, 'danger', state.busy) : form('organization-login', {}, input('이메일', 'email', 'email', { required: true, autocomplete: 'username', maxlength: 320 }), input('비밀번호', 'password', 'password', { required: true, autocomplete: 'current-password', maxlength: 1024 }), submit('조직 관리 열기')),
      state.error && element('p', { class: 'notice error', role: 'alert' }, state.error), state.notice && element('p', { class: 'notice success', role: 'status' }, state.notice), button('로그인 상태 다시 확인', 'session-check', {}, '', state.busy), element('p', { class: 'portal-footer' }, '조직 로그인은 워크스페이스 로그인과 별도로 유지됩니다.'));
  }
  function createForm() {
    const eligible = state.eligibility?.eligible === true;
    return element('details', {}, element('summary', {}, '새 조직 만들기'), eligible ? form('organization-create', {}, input('조직 이름', 'name', 'text', { required: true, maxlength: 160, placeholder: '예: 우리 가족' }), element('p', { class: 'muted' }, '현재 워크스페이스: ' + (state.eligibility.workspace_name || '이 워크스페이스')), checkbox('나를 이 조직의 첫 소유자로 지정합니다.', 'confirm_owner'), checkbox('현재 워크스페이스를 이 조직에 연결합니다.', 'attach_workspace'), submit('조직 만들기')) : element('p', { class: 'notice' }, '조직을 만들려면 같은 계정으로 현재 워크스페이스의 소유자 로그인을 먼저 완료해 주세요.'));
  }
  function acceptForm() {
    const preview = state.preview;
    const formNode = form('organization-preview', {}, element('label', {}, '받은 연결 코드', element('textarea', { name: 'code', required: true, maxlength: 2048, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '조직 소유자에게 받은 코드를 붙여 넣으세요.' })), submit('연결 대상 확인'));
    const children = [element('p', { class: 'muted' }, '같은 계정으로 현재 워크스페이스의 소유자 로그인이 필요합니다. 코드는 대상 확인에만 사용되며, 아래에서 동의해야 연결됩니다.'), formNode];
    if (preview) children.push(element('div', { class: 'preview' }, element('p', {}, '조직: ', element('strong', {}, preview.organization_name || preview.organization?.name || '이름 확인 불가')), element('p', {}, '워크스페이스: ', element('strong', {}, preview.workspace_name || preview.workspace?.name || '이름 확인 불가')), element('p', { class: 'muted' }, '유효 기간: ' + date(preview.expires_at)), checkbox('위 조직에 이 워크스페이스를 연결하는 데 동의합니다.', 'confirm_link'), button('워크스페이스 연결', 'accept-connection', {}, 'primary')));
    return element('details', { open: !!preview }, element('summary', {}, '받은 코드로 워크스페이스 연결'), element('div', { class: 'stack' }, children));
  }
  function bootstrapForm() {
    return element('details', {}, element('summary', {}, '초기 소유자 연결 코드가 있나요?'), form('organization-bootstrap', {}, element('p', { class: 'muted' }, '운영자가 발급한 조직 식별자와 초기 연결 코드를 입력하세요.'), input('조직 식별자', 'organization_id', 'text', { required: true, maxlength: 36, autocomplete: 'off', spellcheck: 'false' }), input('초기 연결 코드', 'code', 'password', { required: true, maxlength: 256, autocomplete: 'off', spellcheck: 'false' }), submit('초기 소유권 연결')));
  }
  function renderNav() {
    return element('nav', { class: 'organization-nav', 'aria-label': '소유 조직' }, element('h2', {}, '내 조직'), state.organizations.length ? state.organizations.map(item => {
      const node = button('', 'select', { id: item.organization_id }, 'organization-choice' + (item.organization_id === state.selected ? ' active' : ''));
      if (item.organization_id === state.selected) node.setAttribute('aria-current', 'true');
      node.append(element('span', { class: 'organization-symbol', 'aria-hidden': 'true' }, String(item.name || '조').slice(0, 1)), element('span', {}, item.name || '이름 없는 조직'));
      return node;
    }) : element('p', { class: 'muted' }, '소유한 조직이 없습니다.'), createForm(), acceptForm(), bootstrapForm());
  }
  const eventActions = { bootstrap: '초기 소유권 연결', rename: '조직 이름 변경', owner_grant: '소유자 추가', owner_revoke: '소유자 권한 철회', link_request: '워크스페이스 연결 요청', link_accept: '워크스페이스 연결', link_detach: '워크스페이스 연결 해제' };
  const eventActors = { operator: '운영자 작업', owner: '조직 소유자 작업', workspace_consent: '워크스페이스 소유자 동의' };
  function confirmation(kind, id, label) {
    return state.confirmation?.kind === kind && state.confirmation.id === id ? element('div', { class: 'operation-confirm' }, element('p', {}, label), element('div', { class: 'actions' }, button('확인하고 진행', 'confirm-' + kind, { id }, 'danger'), button('취소', 'cancel-confirmation'))) : null;
  }
  function renderDetail() {
    const detail = state.detail;
    if (state.loading || state.selected && !detail) return card('조직 정보', '', element('p', { class: 'loading', role: 'status' }, state.error ? '조직 정보를 다시 불러와 주세요.' : '조직 정보를 불러오는 중…'));
    if (!detail) return card('함께 쓰는 공간의 시작', '', element('div', { class: 'empty-state' }, element('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '❋'), element('h2', {}, '아직 소유한 조직이 없어요'), element('p', {}, '워크스페이스 소유자라면 새 조직을 만들거나,', element('br'), '운영자에게 받은 초기 연결 코드로 시작할 수 있어요.')));
    const owners = Array.isArray(detail.owners) ? detail.owners : [], workspaces = Array.isArray(detail.workspaces) ? detail.workspaces : [];
    const ownerList = element('div', { class: 'item-list' }, owners.map(owner => element('div', {}, element('div', { class: 'list-item' }, element('div', {}, element('div', { class: 'item-name' }, owner.name || owner.email || '조직 소유자', owner.self && element('span', { class: 'badge' }, '나')), element('span', { class: 'item-description' }, owner.email || '이메일 없음'), !owner.usable && element('span', { class: 'item-description' }, '현재 로그인할 수 없는 계정')), button('권한 철회', 'revoke-owner', { id: owner.grant_id }, 'danger', state.busy || !!state.pending || owners.filter(item => item.usable).length <= 1 && owner.usable)), confirmation('owner', owner.grant_id, (owner.self ? '내 소유자 권한을 철회하면 이 조직에 다시 접근하지 못할 수 있습니다.' : (owner.name || owner.email || '이 사용자') + '의 조직 소유자 권한을 철회할까요?') + ' 마지막으로 로그인 가능한 소유자는 철회할 수 없습니다.'))));
    const workspaceList = element('div', { class: 'item-list' }, workspaces.length ? workspaces.map(workspace => element('div', {}, element('div', { class: 'list-item' }, element('div', {}, element('div', { class: 'item-name' }, workspace.name || '워크스페이스'), element('span', { class: 'item-description' }, '연결됨 · ' + date(workspace.linked_at))), button('연결 해제', 'detach-workspace', { id: workspace.link_id }, 'danger')), confirmation('workspace', workspace.link_id, (workspace.name || '이 워크스페이스') + '의 조직 연결을 해제할까요?'))) : element('p', { class: 'muted' }, '연결된 워크스페이스가 없습니다.'));
    const request = form('organization-request', {}, element('p', { class: 'muted' }, '현재 서버의 워크스페이스에 대한 연결 요청을 만듭니다. 해당 워크스페이스 소유자가 코드를 확인하고 동의해야 연결됩니다. 코드는 15분 동안 유효합니다.'), element('p', { class: 'connection-label' }, state.eligibility?.workspace_name ? '대상: ' + state.eligibility.workspace_name : '대상: 현재 접속한 서버의 워크스페이스'), submit('연결 코드 만들기'));
    if (state.connection) request.append(element('label', {}, '워크스페이스 소유자에게 전달할 연결 코드', element('textarea', { class: 'code-box', readOnly: true, name: 'generated-code', spellcheck: 'false', text: state.connection.code })), element('p', { class: 'muted' }, date(state.connection.expiresAt) + '까지 유효합니다. 이 화면을 떠나면 코드는 보관되지 않습니다.'), button('연결 코드 복사', 'copy-code'));
    const events = Array.isArray(detail.events) ? detail.events : [];
    return element('div', { class: 'detail-stack' },
      card('조직 정보', '이 조직의 기본 정보를 관리합니다.', form('organization-rename', { class: 'inline-form' }, input('조직 이름', 'name', 'text', { required: true, maxlength: 160, value: detail.name || '' }), submit('이름 저장'))),
      card('조직 소유자', '소유자는 조직 이름과 소유자, 워크스페이스 연결을 관리할 수 있습니다.', ownerList, form('organization-owner', { class: 'inline-form' }, input('추가할 계정 이메일', 'email', 'email', { required: true, maxlength: 320, autocomplete: 'off', placeholder: 'name@example.com' }), submit('소유자 추가'))),
      card('연결된 워크스페이스', '워크스페이스의 멤버 권한과 조직 소유권은 각각 관리됩니다.', workspaceList, element('details', { open: !!state.connection }, element('summary', {}, '워크스페이스 연결 요청'), request)),
      card('최근 조직 활동', '조직 권한과 연결 변경 기록입니다.', element('div', { class: 'item-list event-list' }, events.length ? events.map(event => element('div', { class: 'list-item' }, element('div', { class: 'item-name' }, eventActions[event.action] || '조직 변경', element('span', { class: 'item-description' }, eventActors[event.actor_kind] || '조직 변경 기록')), element('time', { datetime: event.occurred_at }, date(event.occurred_at)))) : element('p', { class: 'muted' }, '최근 활동이 없습니다.'))));
  }
  function render() {
    if (!state.session?.authenticated) {
      app.replaceChildren(state.loading ? element('div', { class: 'loading', role: 'status' }, '조직 로그인을 확인하고 있어요…') : renderLogin());
      return;
    }
    const identity = state.session.identity || {};
    const status = element('div', { class: 'stack tight' }, state.error && element('div', { class: 'notice error', role: 'alert' }, state.error), state.notice && element('div', { class: 'notice success', role: 'status' }, state.notice));
    if (state.pending) status.append(element('div', { class: 'notice pending-box', role: 'status' }, state.busy ? '요청을 확인하고 있어요…' : '완료 여부가 불확실합니다. 새로운 변경은 잠시 멈추고 같은 요청을 다시 확인해 주세요.', !state.busy && element('div', { class: 'actions' }, button('같은 요청 다시 확인', 'retry', {}, 'primary', false))));
    app.replaceChildren(element('div', { class: 'topline' }, element('div', {}, element('span', { class: 'eyebrow' }, 'ORGANIZATION'), element('h1', {}, state.detail?.name || '조직 관리'), element('div', { class: 'identity' }, element('span', {}, [identity.name, identity.email].filter(Boolean).join(' · ')), button('로그아웃', 'logout', {}, '', state.busy))), button('새로고침', 'refresh', {}, '', state.busy || !!state.pending)), status, element('div', { class: 'portal-grid' }, renderNav(), renderDetail()), element('p', { class: 'portal-footer' }, '조직 로그아웃은 워크스페이스 로그인에 영향을 주지 않습니다. 조직 관리에는 서버 연결이 필요하며, 이 화면의 계정 정보와 연결 코드는 기기에 저장하지 않습니다.'));
  }
  async function login(data) {
    if (state.busy) return;
    clearPrivate(); state.busy = true; state.loading = false; render();
    const scope = fence.capture(), sequence = ++state.sessionSequence;
    try {
      const value = await wire(PREFIX + '/session', { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) });
      if (sequence !== state.sessionSequence || !fence.current(scope)) return;
      if (!value.authenticated || typeof value.cache_binding !== 'string' || !value.cache_binding) throw Error('로그인 응답을 확인할 수 없습니다.');
      clearPrivate(); state.session = value; fence.reset(value.cache_binding); announce(); await loadHome();
    } catch (error) { if (sequence === state.sessionSequence && fence.current(scope)) { state.busy = false; state.error = error.status ? error.message : '로그인 완료 여부를 확인하지 못했습니다. 로그인 상태를 다시 확인해 주세요.'; render(); } }
  }
  async function logout(binding = fence.binding()) {
    if (!binding || state.busy) return;
    ++state.sessionSequence; clearPrivate(); state.logoutBinding = binding; state.loading = false; state.busy = true; render();
    const scope = fence.capture();
    try {
      await wire(PREFIX + '/session', { method: 'DELETE', body: JSON.stringify({ session_binding: binding }) });
      if (!fence.current(scope)) return;
      state.busy = false; state.logoutBinding = null; state.notice = '조직 로그아웃을 완료했습니다.'; announce(); render();
    } catch (error) {
      if (!fence.current(scope)) return;
      state.busy = false;
      if ([401, 409].includes(error.status)) { state.logoutBinding = null; state.error = '조직 로그인이 변경되었습니다. 상태를 다시 확인해 주세요.'; render(); return; }
      state.error = '서버의 로그아웃 완료 여부를 확인하지 못했습니다. 아래 버튼으로 다시 확인해 주세요.'; render();
    }
  }
  app.addEventListener('submit', event => {
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof root.HTMLFormElement) || state.busy || state.pending) return;
    const data = new FormData(target);
    if (target.id === 'organization-login') { const password = target.elements.password; void login(data).finally(() => { if (password) password.value = ''; }); return; }
    if (!fence.binding()) return;
    state.error = ''; state.notice = '';
    const id = state.selected;
    try {
      if (target.id === 'organization-create') {
        if (!state.eligibility?.eligible || data.get('confirm_owner') !== 'on' || data.get('attach_workspace') !== 'on') throw Error('조직 생성과 워크스페이스 연결 동의를 확인해 주세요.');
        void mutate('POST', '/organizations', { organization_id: uuid(), name: String(data.get('name') || '').trim(), confirm_owner: true, attach_workspace: true, workspace_binding: state.eligibility.workspace_binding }, '조직 생성').catch(issue);
      } else if (target.id === 'organization-rename') void mutate('PATCH', '/organizations/' + id, mutationBody({ name: String(data.get('name') || '').trim() }), '이름 변경').catch(issue);
      else if (target.id === 'organization-owner') void mutate('POST', '/organizations/' + id + '/owners', mutationBody({ email: String(data.get('email') || '').trim() }), '소유자 추가').catch(issue);
      else if (target.id === 'organization-request') {
        const code = randomCode(), expiresAt = Date.now() + 15 * 60 * 1000, workspaceId = state.eligibility?.workspace_id;
        if (!workspaceId) throw Error('현재 워크스페이스를 확인한 뒤 다시 시도해 주세요.');
        void mutate('POST', '/organizations/' + id + '/workspace-requests', mutationBody({ workspace_id: workspaceId, code, expires_at_ms: expiresAt }), '연결 요청 생성', result => {
          const envelope = { v: 1, organizationId: id, requestId: result.request_id, revision: result.revision, nonce: code, expiresAt: result.expires_at || expiresAt, workspaceId };
          state.connection = { code: encodeConnectionCode(envelope), expiresAt: envelope.expiresAt };
        }).catch(issue);
      } else if (target.id === 'organization-bootstrap') {
        const organizationId = String(data.get('organization_id') || '').trim();
        if (!UUID.test(organizationId)) throw Error('운영자에게 받은 조직 식별자를 확인해 주세요.');
        void mutate('POST', '/bootstrap', { organization_id: organizationId, code: String(data.get('code') || '').trim() }, '초기 소유권 연결').catch(issue);
      } else if (target.id === 'organization-preview') void previewConnection(String(data.get('code') || '').trim()).catch(issue);
    } catch (error) { issue(error); }
  });
  async function previewConnection(code) {
    const envelope = parseConnectionCode(code), scope = fence.capture();
    state.busy = true; state.preview = null; state.error = ''; render();
    try {
      const value = await boundRequest('/workspace-preview', { method: 'POST', body: JSON.stringify({ session_binding: scope.binding, organization_id: envelope.organizationId, request_id: envelope.requestId, revision: envelope.revision, code: envelope.nonce }) });
      if (!fence.current(scope)) return;
      // Display names and authorization come only from the verified server preview.
      if (!value.workspace_binding || !value.organization_name || !value.workspace_name || value.organization_id !== envelope.organizationId || value.workspace_id !== envelope.workspaceId || !Number.isSafeInteger(value.revision)) throw Error('서버에서 연결 대상을 확인하지 못했습니다.');
      state.preview = { ...value, envelope }; state.busy = false; render();
    } catch (error) { if (fence.current(scope)) state.busy = false; throw error; }
  }
  app.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target || !app.contains(target) || target.disabled) return;
    const action = target.dataset.action, id = target.dataset.id;
    if (action === 'session-check') { state.error = ''; state.loading = true; render(); void checkSession(); return; }
    if (action === 'retry-logout') { void logout(state.logoutBinding); return; }
    if (action === 'logout') { void logout(); return; }
    if (action === 'retry') { void sendPending(); return; }
    if (state.busy || state.pending || !fence.binding()) return;
    state.error = ''; state.notice = '';
    try {
      if (action === 'refresh') { state.preview = null; state.connection = null; void loadHome(); }
      else if (action === 'select') void loadDetail(id);
      else if (action === 'revoke-owner') { state.confirmation = { kind: 'owner', id }; render(); }
      else if (action === 'detach-workspace') { state.confirmation = { kind: 'workspace', id }; render(); }
      else if (action === 'cancel-confirmation') { state.confirmation = null; render(); }
      else if (action === 'confirm-owner') void mutate('DELETE', '/organizations/' + state.selected + '/owners/' + id, mutationBody(), '소유자 권한 철회').catch(issue);
      else if (action === 'confirm-workspace') void mutate('DELETE', '/organizations/' + state.selected + '/workspaces/' + id, mutationBody(), '워크스페이스 연결 해제').catch(issue);
      else if (action === 'copy-code') {
        const scope = fence.capture(), code = state.connection?.code;
        if (!code) return;
        if (!root.navigator.clipboard?.writeText) { const control = app.querySelector('[name="generated-code"]'); control?.focus(); control?.select(); state.notice = '코드를 선택했습니다. 기기의 복사 명령을 사용해 주세요.'; return; }
        void root.navigator.clipboard.writeText(code).then(() => { if (fence.current(scope) && state.connection?.code === code) { state.notice = '연결 코드를 복사했습니다.'; render(); } }, () => { if (fence.current(scope)) { state.error = '자동 복사를 허용하지 않는 환경입니다. 코드를 직접 선택해 복사해 주세요.'; render(); } });
      } else if (action === 'accept-connection') {
        const preview = state.preview;
        if (!preview || !app.querySelector('[name="confirm_link"]')?.checked) throw Error('실제 조직과 워크스페이스를 확인하고 연결에 동의해 주세요.');
        const envelope = preview.envelope;
        if (new Date(preview.expires_at || envelope.expiresAt).getTime() <= Date.now()) throw Error('연결 코드가 만료되었습니다. 새 코드를 요청해 주세요.');
        void mutate('POST', '/workspace-accept', { organization_id: envelope.organizationId, request_id: envelope.requestId, revision: preview.revision, code: envelope.nonce, workspace_binding: preview.workspace_binding }, '워크스페이스 연결').catch(issue);
      }
    } catch (error) { issue(error); }
  });
  channel?.addEventListener('message', event => {
    if (event.data?.type !== 'changed') return;
    ++state.sessionSequence; clearPrivate(); state.loading = true; render(); void checkSession();
  });
  root.addEventListener('focus', () => { if (!state.busy && !state.pending) void checkSession(); });
  root.addEventListener('pagehide', () => { ++state.sessionSequence; clearPrivate(); state.loading = true; render(); });
  root.addEventListener('pageshow', event => { if (event.persisted) void checkSession(); });
  void checkSession();
})(globalThis);
