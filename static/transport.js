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
  function apiURL(path) { return localPath(path, 'api'); }
  function request(path, options = {}) {
    const url = apiURL(path);
    const headers = new Headers(options.headers);
    headers.set('X-Fountain-Request', '1');
    return root.fetch(url, { ...options, headers, credentials: 'same-origin', redirect: 'error' });
  }
  function events(path) { return new root.EventSource(apiURL(path), { withCredentials: true }); }
  function xhr(method, path) {
    const connection = new root.XMLHttpRequest();
    connection.open(method, apiURL(path));
    connection.withCredentials = true;
    connection.setRequestHeader('X-Fountain-Request', '1');
    return connection;
  }
  function appURL(route = 'home') {
    if (typeof route !== 'string' || !/^(home|page\/[^/]+|database\/[^/]+)$/.test(route) || /[\\\u0000-\u0020\u007f#?]/.test(route)) invalid();
    // Validate encoded route identifiers with the same path rules.
    localPath('/' + route, 'app');
    return root.location.origin + '/#' + route;
  }
  root.FountainTransport = Object.freeze({ apiURL, request, events, xhr, publicURL: path => localPath(path, 'public'), appURL, downloadURL: apiURL });
})(globalThis);
