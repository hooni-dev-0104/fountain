/* Same-origin browser transport. Remote/native adapters require a separate explicit contract. */
'use strict';
(function (root) {
  function invalid() { throw new TypeError('허용되지 않는 연결 경로입니다.'); }
  function localPath(path, kind) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020\u007f#]/.test(path)) invalid();
    const pathname = path.split('?')[0];
    let decoded = pathname;
    // Inspect before URL normalization, including nested percent-encoding.
    for (let depth = 0; depth < 8; depth++) {
      if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('//') || decoded.split('/').some(part => part === '.' || part === '..')) invalid();
      if (!/%[0-9a-f]{2}/i.test(decoded)) break;
      let next;
      try { next = decodeURIComponent(decoded); } catch { invalid(); }
      if (next === decoded) break;
      decoded = next;
      if (depth === 7) invalid();
    }
    if (kind === 'api' && !pathname.startsWith('/api/')) invalid();
    if (kind === 'public' && !/^\/(forms|sites)\/[^/]+$/.test(pathname)) invalid();
    const url = new URL(path, root.location.origin);
    if (url.origin !== root.location.origin) invalid();
    return url.href;
  }
  let workspace = null, epoch = 0, parked = false;
  const pending = new Set(), streams = new Set();
  const stale = () => Object.assign(new Error('작업공간이 변경되었습니다.'), { name: 'AbortError', code: 'STALE_REQUEST' });
  const scopeHelper = () => { if (!root.FountainWorkspaceScope) throw new TypeError('작업공간 연결을 준비하지 못했습니다.'); return root.FountainWorkspaceScope; };
  function route(path, scope = workspace) { if(/^\/api\/(?:account|organization)(?:\/|$)/.test(path))return path; return scope ? scopeHelper().wire(path, scope) : path; }
  function apiURL(path) { if (parked) throw stale(); return localPath(route(path), 'api'); }
  function fence() { epoch++; for (const controller of pending) controller.abort(); for (const source of streams) source.close(); pending.clear(); streams.clear(); }
  async function setWorkspace(scope) { fence(); parked = true; workspace = scopeHelper().validate({ ...scope, workspaceEpoch: epoch }); parked = false; return workspace; }
  async function parkWorkspace() { fence(); parked = true; return workspace; }
  function capture() {
    const selected = workspace, admittedEpoch = epoch;
    const current = () => !parked && epoch === admittedEpoch && workspace === selected;
    const check = () => { if (!current()) throw stale(); };
    const url = path => { check(); return localPath(route(path, selected), 'api'); };
    const bound = { origin: root.location.origin, native: false, workspaceScope: () => selected, current,
      apiURL: url, downloadURL: url,
      request: async (path, options = {}) => {
        const destination = url(path), controller = new AbortController(); pending.add(controller);
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const headers = new Headers(options.headers); headers.set('X-Fountain-Request', '1');
        try { const response = await root.fetch(destination, { ...options, headers, signal, credentials: 'same-origin', redirect: 'error' }); check(); if(response.status===401&&selected)root.dispatchEvent?.(new CustomEvent('fountain-workspace-auth-required',{detail:{accountBinding:selected.accountBinding}})); return response; }
        finally { pending.delete(controller); }
      },
      events: path => { const source = new root.EventSource(url(path), { withCredentials: true }), close=source.close.bind(source); source.close=()=>{streams.delete(source);close();}; streams.add(source); return source; },
      xhr: (method, path) => { const connection = new root.XMLHttpRequest(); connection.open(method, url(path)); connection.withCredentials = true; connection.setRequestHeader('X-Fountain-Request', '1'); const controller = new AbortController(); controller.signal.addEventListener('abort', () => connection.abort()); pending.add(controller); connection.addEventListener('loadend', () => pending.delete(controller), { once: true }); return connection; },
      appURL: route => { check(); return applicationURL(route, selected); },
      shareURL: (route, origin) => { check(); return shareLink(route, origin, selected); }
    };
    return Object.freeze(bound);
  }
  function request(path, options = {}) { return capture().request(path, options); }
  function events(path) { return capture().events(path); }
  function xhr(method, path) { return capture().xhr(method, path); }
  function applicationURL(route = 'home', scope = workspace) {
    if (typeof route !== 'string' || !/^(home|page\/[^/]+|database\/[^/]+|form\/[^/]+|site\/[^/]+)$/.test(route) || /[\\\u0000-\u0020\u007f#?]/.test(route)) invalid();
    // Validate encoded route identifiers with the same path rules.
    localPath('/' + route, 'app');
    return root.location.origin + '/#' + (scope ? scopeHelper().navigation(route, scope) : route);
  }
  function primaryFrontend(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || /[\\\u0000-\u0020\u007f]/.test(value)) invalid();
    let url; try { url = new URL(value); } catch { invalid(); }
    // Compare the raw origin: never silently normalize metadata supplied by callers.
    if (url.protocol !== 'https:' || url.origin !== value) invalid();
    return value;
  }
  function shareOrigin(primaryOrigin) {
    return primaryFrontend(primaryOrigin) ?? (root.location.origin === 'https://fountain.desktop.invalid' ? null : root.location.origin);
  }
  function shareLink(route = 'home', primaryOrigin, scope = workspace) {
    applicationURL(route, scope); // Logical routes remain validated even when no public origin exists.
    const origin = shareOrigin(primaryOrigin);
    return origin === null ? null : origin + '/#' + (scope ? scopeHelper().navigation(route, scope) : route);
  }
  function publicShareURL(path, primaryOrigin) {
    localPath(path, 'public');
    const origin = shareOrigin(primaryOrigin);
    return origin === null ? null : workspace ? origin + '/#' + scopeHelper().navigation((path.startsWith('/forms/')?'form/':'site/')+path.split('/')[2],workspace) : new URL(path, origin).href;
  }
  function publicURL(path, primaryOrigin) {
    const local = localPath(path, 'public'), primary = primaryFrontend(primaryOrigin);
    if(workspace)return localPath(scopeHelper().wire('/api'+path,workspace),'api');
    // Desktop previews stay within the bundled UI and its popup policy.
    return root.location.origin === 'https://fountain.desktop.invalid' || primary === null ? local : new URL(path, primary).href;
  }
  const meta=root.document?.querySelector?.('meta[name="fountain-workspace-scope"]');
  if(meta||/^\/api\/w\//.test(root.location.pathname||'')){workspace=scopeHelper().parsePresentationScope(root.location.pathname,meta?.content);}
  const appURL = route => applicationURL(route);
  const shareURL = (route, origin) => shareLink(route, origin);
  root.FountainTransport = Object.freeze({ get scopeEpoch() { return epoch; }, setWorkspace, parkWorkspace, workspaceScope: () => workspace, capture, unscopedRequest: (path, options = {}) => { if(!/^\/api\/(?:account|organization)\//.test(path))invalid();const headers = new Headers(options.headers); headers.set('X-Fountain-Request','1'); return root.fetch(localPath(path,'api'), { ...options, headers, credentials:'same-origin', redirect:'error' }); }, origin: root.location.origin, native: false, apiURL, request, events, xhr, publicURL, publicShareURL, appURL, shareURL, downloadURL: apiURL });
})(globalThis);
