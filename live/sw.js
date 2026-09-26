// MMLisp Live — service worker.
//
// Scope: /live/ (registered as ./sw.js from /live/index.html). Once this worker
// controls the page it intercepts *all* fetches that page makes — including the
// same-origin WASM beside this file and the cross-origin CDN modules — not
// just requests under the scope path.
//
// Strategy: installable, and usable offline once visited. There is no precache
// list to maintain; everything is cached at runtime as it is requested.
//
// Everything of our own (same origin: the page, its modules, the worklet, the
// WASM, presets) is NETWORK-FIRST with the cache as the offline fallback, so
// the page and the code it runs always come from the same deploy. Serving the
// modules stale-while-revalidate ran a freshly fetched index.html against the
// previous deploy's scripts on the first launch after every update — an error
// that went away on the next launch. Only cross-origin CDN modules (versioned
// URLs) stay stale-while-revalidate, for fast repeat loads.
// Bump VERSION to drop the old cache on the next activation.

const VERSION = 'mmlisp-v2';
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

// Network-first; fall back to the cached copy (and, for a page load, to any
// cached shell) when offline.
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) put(request, response.clone());
    return response;
  } catch (_) {
    return (await caches.match(request)) ||
      (request.mode === 'navigate' && (await caches.match('./index.html'))) ||
      Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // let writes pass straight through

  const sameOrigin = new URL(request.url).origin === self.location.origin;
  event.respondWith(
    request.mode === 'navigate' || sameOrigin
      ? networkFirst(request)
      : staleWhileRevalidate(request),
  );
});
