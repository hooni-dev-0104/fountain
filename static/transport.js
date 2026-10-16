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
  function shareURL(route = 'home', primaryOrigin) {
    appURL(route); // Logical routes remain validated even when no public origin exists.
    const origin = shareOrigin(primaryOrigin);
    return origin === null ? null : origin + '/#' + route;
  }
  function publicShareURL(path, primaryOrigin) {
    localPath(path, 'public');
    const origin = shareOrigin(primaryOrigin);
    return origin === null ? null : new URL(path, origin).href;
  }
  function publicURL(path, primaryOrigin) {
    const local = localPath(path, 'public'), primary = primaryFrontend(primaryOrigin);
    // Desktop previews stay within the bundled UI and its popup policy.
    return root.location.origin === 'https://fountain.desktop.invalid' || primary === null ? local : new URL(path, primary).href;
  }
  root.FountainTransport = Object.freeze({ origin: root.location.origin, native: false, apiURL, request, events, xhr, publicURL, publicShareURL, appURL, shareURL, downloadURL: apiURL });
})(globalThis);
