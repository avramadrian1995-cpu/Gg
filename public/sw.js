'use strict';

// Offline support: pages and assets come from the network when possible and
// fall back to the cache; API calls always go to the network (live slots).
const CACHE = 'miseda-v2';
const SHELL = [
  '/', '/css/app.css', '/js/common.js', '/js/site.js', '/offline.html',
  '/tracker/', '/tracker/app.js', '/tracker/styles.css', '/cont/', '/js/account.js',
  '/icons/icon-192.png', '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? caches.match('/offline.html') : Response.error())));
});
