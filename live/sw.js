// MMLisp Live — service worker.
//
// Scope: /live/ (registered as ./sw.js from /live/index.html). Once this worker
// controls the page it intercepts *all* fetches that page makes — including the
// same-origin WASM under /player/wasm/ and the cross-origin CDN modules — not
// just requests under the scope path.
//
// Strategy: installable + fast repeat loads, NOT guaranteed full offline. There
// is no precache list to maintain; everything is cached at runtime as it is
// requested. Navigations are network-first (so a deploy is picked up promptly)
// with a cached index.html fallback; every other GET is stale-while-revalidate.
// Bump VERSION to drop the old cache on the next activation.

const VERSION = 'mmlisp-v1';
const CACHE = `mmlisp-${VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

// Put a response in the cache, ignoring failures (opaque/partial/quota).
async function put(request, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch (_) { /* best effort */ }
}

// Serve cached copy immediately when present; refresh it in the background.
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// Network-first for page loads; fall back to any cached shell when offline.
async function navigate(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) put(request, response.clone());
    return response;
  } catch (_) {
    return (await caches.match(request)) ||
      (await caches.match('./index.html')) ||
      Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // let writes pass straight through

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
