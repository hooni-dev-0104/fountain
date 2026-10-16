/* Generic shell only. Private API, public-site and form responses never enter CacheStorage. */
'use strict';
const CACHE = 'fountain-shell-presence-v1';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/collaboration.js', '/offline.js', '/uploads.js', '/transport.js', '/mutations.js', '/presence.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload', credentials: 'omit' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('fountain-shell-') && name !== CACHE)
    .map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search || !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    let response;
    try {
      response = await fetch(request);
    } catch (error) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request.mode === 'navigate' ? '/' : url.pathname);
      if (cached) return cached;
      throw error;
    }
    if (response.ok && response.type !== 'opaqueredirect') {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(url.pathname, response.clone());
      } catch { /* Cache quota cannot turn a successful network response into a failure. */ }
    }
    // HTTP 401/403/500 are authoritative; only a genuine network failure uses cache.
    return response;
  })());
});
