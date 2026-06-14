const CACHE_NAME = 'rubies-care-v3'; // bump to evict every client's old asset cache
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Evict old caches on version bump
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls: network-only (never cache live data)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // App shell: network-first, fall back to cache.
  // cache: 'no-store' bypasses the browser HTTP cache — plain fetch() reads
  // it, which resurrects stale JS/CSS Safari cached before the server sent
  // Cache-Control headers. The SW cache below is the only fallback layer.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then(res => {
      // Update cache with fresh copy
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
