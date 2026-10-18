/* Account authentication is independent from workspace and organization cookies. */
(function (root) {
  'use strict';
  const binding = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const failure = (message, status, code) => Object.assign(new Error(message), { status, code });
  const uuid = () => root.crypto.randomUUID();
  class Account {
    constructor() { this.session = null; this.epoch = 0; this.pendingLogout = null; this.channel = typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel('fountain-account') : null; if (this.channel) this.channel.onmessage = event => { if (event.data?.type === 'logout' && event.data.binding === this.session?.cache_binding) { this.epoch++; this.session = null; root.dispatchEvent(new CustomEvent('fountain-account-ended', { detail: { binding: event.data.binding } })); } }; }
    async request(path, options = {}, { anonymous = false, epoch = this.epoch } = {}) {
      if (!/^\/api\/account\//.test(path)) throw new TypeError('계정 연결 경로를 확인해 주세요.');
      const adapter = root.FountainAccountTransport || root.FountainTransport;
      const request = adapter.unscopedRequest || adapter.request;
      const response = await request.call(adapter, path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, cache: 'no-store', signal: options.signal || root.AbortSignal?.timeout?.(45000) });
      if(path==='/api/account/session'&&(!options.method||options.method==='GET')&&response.headers.get('X-Fountain-Account-Directory')==='absent'){await response.body?.cancel();throw failure('이 서버는 기존 작업공간 로그인을 사용합니다.',404,'ACCOUNT_DIRECTORY_ABSENT');}
      const length = Number(response.headers.get('content-length')); if (length > 2 * 1024 * 1024) throw failure('계정 응답이 너무 큽니다.', 502);
      const reader=response.body?.getReader();if(!reader)throw failure('계정 응답을 확인하지 못했습니다.',502);
      let size=0;const chunks=[];try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>2*1024*1024)throw failure('계정 응답이 너무 큽니다.',502);chunks.push(next.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if (epoch !== this.epoch) throw failure('계정 연결이 변경되었습니다.', 409, 'STALE_ACCOUNT');
      let value; try { value = JSON.parse(text); } catch { throw failure('계정 응답을 확인하지 못했습니다.', response.status || 502); }
      if (!response.ok) {
        if (response.status === 401 && !anonymous && this.session?.cache_binding) this.end(this.session.cache_binding);
        throw failure(typeof value.error === 'string' ? value.error : '계정 요청을 완료하지 못했습니다.', response.status,typeof value.code==='string'&&/^[A-Z_]{1,80}$/.test(value.code)?value.code:undefined);
      }
      return value;
    }
    async observe() { const session = await this.request('/api/account/session', {}, { anonymous: true }); this.accept(session); return session; }
    accept(session) { if (!session || session.mode !== 'account' || typeof session.enabled!=='boolean' || typeof session.authenticated !== 'boolean' || !session.authenticated&&[session.cache_binding,session.identity,session.expires_at].some(value=>value!==null) || session.authenticated && (!binding(session.cache_binding) || !session.identity || !Number.isFinite(Date.parse(session.expires_at)))) throw failure('계정 상태를 확인하지 못했습니다.', 502); this.session = session; return session; }
    async login(credentials) { if (this.pendingLogout) throw failure('이전 로그아웃을 먼저 완료해 주세요.', 409); this.epoch++; const session = await this.request('/api/account/session', { method: 'POST', body: JSON.stringify(credentials) }, { anonymous: true }); return this.accept(session); }
    end(parent) { this.epoch++; this.session = null; this.channel?.postMessage({ type: 'logout', binding: parent }); root.dispatchEvent(new CustomEvent('fountain-account-ended', { detail: { binding: parent } })); }
    async logout(expectedBinding) { const parent = this.pendingLogout || this.session?.cache_binding || expectedBinding; if (!binding(parent)) return; if (!this.pendingLogout) { this.pendingLogout = parent; this.end(parent); } await this.request('/api/account/session', { method: 'DELETE', body: JSON.stringify({ session_binding: parent }) }, { anonymous: true }); this.pendingLogout = null; }
    parent() { const value = this.session?.cache_binding; if (this.session?.authenticated!==true || !binding(value) || Date.parse(this.session.expires_at) <= Date.now()) throw failure('다시 로그인해 주세요.', 401); return value; }
    async list(cursor = null) { const parent = this.parent(); const value = await this.request('/api/account/workspaces?session_binding=' + parent + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); if (value.account_binding !== parent || !Array.isArray(value.workspaces) || !(value.next_cursor === null || typeof value.next_cursor === 'string')) throw failure('작업공간 목록의 계정을 확인하지 못했습니다.', 502); return value; }
    command(path, body, commandId = uuid()) { return this.request(path, { method: 'POST', body: JSON.stringify({ ...body, session_binding: this.parent(), command_id: commandId }) }); }
    create(name, workspaceId, commandId) { return this.command('/api/account/workspaces', { workspace_id: workspaceId, name }, commandId); }
    open(workspaceId, expectedBinding = null, commandId) { return this.command('/api/account/workspaces/' + encodeURIComponent(workspaceId) + '/open', { expected_binding: expectedBinding }, commandId); }
    invite(workspaceId, body, commandId) { return this.command('/api/account/workspaces/' + encodeURIComponent(workspaceId) + '/invitations', body, commandId); }
    preview(body) { return this.request('/api/account/invitation-preview', { method: 'POST', body: JSON.stringify({ ...body, session_binding: this.parent() }) }); }
    acceptInvitation(body, commandId) { return this.command('/api/account/invitation-accept', body, commandId); }
  }
  root.FountainAccount = Object.freeze({ Account, binding });
})(globalThis);
