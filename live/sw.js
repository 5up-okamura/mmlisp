// MMLisp Live — service worker.
//
// Scope: /live/ (registered as ./sw.js from /live/index.html). Once this worker
// controls the page it intercepts *all* fetches that page makes — including the
// same-origin WASM beside this file — not just requests under the scope path.
//
// Strategy: installable, and fully usable offline once installed.
//
// Everything of our own (same origin: the page, its modules, the worklet, the
// WASM, presets) is NETWORK-FIRST with the cache as the offline fallback, so
// the page and the code it runs always come from the same deploy. Serving the
// modules stale-while-revalidate ran a freshly fetched index.html against the
// previous deploy's scripts on the first launch after every update — an error
// that went away on the next launch. Anything cross-origin stays
// stale-while-revalidate.
//
// The cache is also filled ahead of use (precache below), so a preset, a
// snippet or the synth's worklet works offline before it was ever opened.
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
    await precache();
  })());
});

// The page asks on every launch, so files added since (a new preset) are
// fetched too; a file already cached is left to network-first to refresh.
self.addEventListener('message', (event) => {
  if (event.data === 'precache') event.waitUntil(precache());
});

// PRECACHE — every file the app can fetch, found by following references
// rather than kept in a list: from the page and the worklet, their module
// imports, stylesheets, fonts and icons; from the preset, snippet and example
// indexes, each score's (import "…") — rooted at the app — and the samples
// its :file names — relative to the score. A file already in the cache is not
// fetched again, only read for its references. Best effort: a failure skips
// that file, and the next launch tries again.
const ROOTS = ['./', './index.html', './worklet.js', './manifest.webmanifest',
  './presets/index.json', './snippets/index.json', './examples/index.json'];
const TEXT = /\.(?:html|js|css|json|webmanifest|mmlisp)$|\/$/;

function references(url, text) {
  const out = [];
  const add = (ref, base = url) => {
    if (!ref || /^(?:[a-z]+:|\/\/|#)/i.test(ref)) return; // another origin, data:, mailto:, anchors
    out.push(new URL(ref, base).href);
  };
  const path = new URL(url).pathname;
  if (/\.m?js$|\.html$|\/$/.test(path)) {
    for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\bimport\s+["']([^"']+)["']/g, /addModule\(\s*["']([^"']+)["']/g]) {
      for (const m of text.matchAll(re)) if (/^\.\.?\//.test(m[1])) add(m[1]);
    }
  }
  if (/\.html$|\/$/.test(path)) {
    for (const m of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) add(m[1].split(/[?#]/)[0]);
  }
  if (/\.css$/.test(path)) {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add(m[1]);
  }
  if (/\/index\.json$/.test(path)) {
    try { for (const f of JSON.parse(text)) add(f, self.registration.scope); } catch (_) { /* not a list */ }
  }
  if (/\.webmanifest$/.test(path)) {
    try { for (const icon of JSON.parse(text).icons || []) add(icon.src); } catch (_) { /* malformed */ }
  }
  if (/\.mmlisp$/.test(path)) {
    for (const m of text.matchAll(/\(import\s+"([^"]+)"/g)) add(m[1], self.registration.scope);
    for (const m of text.matchAll(/:file\s+"([^"]+)"/g)) add(m[1]);
  }
  return out;
}

let precaching = null;
function precache() {
  precaching ??= (async () => {
    const cache = await caches.open(CACHE);
    const queue = ROOTS.map((r) => new URL(r, self.registration.scope).href);
    const seen = new Set();
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url) || new URL(url).origin !== self.location.origin) continue;
      seen.add(url);
      try {
        let response = await cache.match(url);
        if (!response) {
          response = await fetch(url);
          if (!response.ok) continue;
          await cache.put(url, response.clone());
        }
        if (TEXT.test(new URL(url).pathname)) queue.push(...references(url, await response.text()));
      } catch (_) { /* offline or refused: next launch */ }
    }
  })().finally(() => { precaching = null; });
  return precaching;
}

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
  // An event stream never ends: caching one would hold it forever (the AI
  // bridge's link to 127.0.0.1, src/ai-bridge.js). Let it through untouched.
  if ((request.headers.get('accept') || '').includes('text/event-stream')) return;

  const sameOrigin = new URL(request.url).origin === self.location.origin;
  event.respondWith(
    request.mode === 'navigate' || sameOrigin
      ? networkFirst(request)
      : staleWhileRevalidate(request),
  );
});
