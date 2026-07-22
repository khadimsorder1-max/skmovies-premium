const VERSION = 'skm-v4.1.0';








const STATIC_CACHE = `skm-static-${VERSION}`;
const RUNTIME_CACHE = `skm-runtime-${VERSION}`;
const IMG_CACHE = `skm-img-${VERSION}`;

const RUNTIME_CACHE_MAX_ENTRIES = 50;
const IMG_CACHE_MAX_ENTRIES = 200;

const STATIC_ASSETS = ['/', '/offline.html', '/styles.css', '/app.js', '/manifest.json', '/assets/logo-512.webp', '/assets/logo-192.webp', '/assets/favicon-32.webp', '/assets/empty.webp', '/assets/og-image.webp'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, RUNTIME_CACHE, IMG_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  const isSameOrigin = url.origin === self.location.origin;
  if (isSameOrigin && url.pathname === '/sw.js') return;

  // Network-first for HTML, JS, CSS
  if (request.mode === 'navigate' || (isSameOrigin && /\.(?:css|js)$/.test(url.pathname))) {
    e.respondWith(
      fetch(request).then((res) => {
        const c = res.clone();
        caches.open(STATIC_CACHE).then((cache) => cache.put(request, c));
        return res;
      }).catch(() => caches.match(request).then((r) => r || caches.match('/offline.html')))
    );
    return;
  }

  // Cache-first for images (with LRU eviction)
  if (isSameOrigin && /\.(?:woff2?|webp|png|jpg|svg|ico)$/.test(url.pathname)) {
    e.respondWith(cacheFirstWithLimit(request, IMG_CACHE, IMG_CACHE_MAX_ENTRIES));
    return;
  }

  // /api/img — cache-first with limit
  if (isSameOrigin && url.pathname === '/api/img') {
    e.respondWith(cacheFirstWithLimit(request, IMG_CACHE, IMG_CACHE_MAX_ENTRIES));
    return;
  }

  // Other /api/* — network-first, cache fallback, with limit
  if (isSameOrigin && url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const c = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => {
            cache.put(request, c);
            trimCache(RUNTIME_CACHE, RUNTIME_CACHE_MAX_ENTRIES);
          });
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }
});

async function cacheFirstWithLimit(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      cache.put(request, res.clone());
      trimCache(cacheName, maxEntries);
    }
    return res;
  } catch (e) {
    return cached || new Response('Offline', { status: 503 });
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map((key) => cache.delete(key)));
}

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
