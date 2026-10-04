// Fill the service worker's cache with every file the app can fetch, so the
// installed app runs offline — a preset, a snippet or the synth's worklet
// before it was ever opened. Run from the page on every launch, not from the
// worker: iOS stops a worker's background work within seconds, which left
// the samples (fetched last) uncached; the page lives as long as it is open.
//
// No list is kept: files are found by following references — from the page
// and the worklet, their module imports, stylesheets, fonts and icons; from
// the preset, snippet and example indexes, each score's (import "…") — its
// own folder's or the app's, as the compiler resolves it — and the samples
// its :file names, relative to the score. Each is
// fetched through the worker (sw.js), whose network-first handler stores it;
// one already cached is only read for its references.

const ROOTS = ['./', './index.html', './worklet.js', './manifest.webmanifest',
  './presets/index.json', './snippets/index.json', './examples/index.json'];
const TEXT = /\.(?:html|js|css|json|webmanifest|mmlisp)$|\/$/;

// Each reference is a list of candidate URLs, tried in order until one is
// found; only a reference none of whose candidates exists is missing.
function references(url, text, root, listed) {
  const out = [];
  const resolve = (ref, base) => (!ref || /^(?:[a-z]+:|\/\/|#)/i.test(ref) ? null : new URL(ref, base).href);
  const add = (ref, base = url) => { // another origin, data:, mailto: and anchors stay out
    const href = resolve(ref, base);
    if (href) out.push([href]);
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
    try {
      for (const f of JSON.parse(text)) {
        const href = resolve(f, root);
        if (href) { listed.add(href); out.push([href]); }
      }
    } catch (_) { /* not a list */ }
  }
  if (/\.webmanifest$/.test(path)) {
    try { for (const icon of JSON.parse(text).icons || []) add(icon.src); } catch (_) { /* malformed */ }
  }
  if (/\.mmlisp$/.test(path)) {
    // The score's own folder first, then the app's, as the compiler resolves
    // an import. A candidate an index lists is known to exist and is taken
    // alone, sparing a request for the other that would only 404 (a snippet
    // imports "presets/gm/set.mmlisp", which is not under snippets/).
    for (const m of text.matchAll(/\(import\s+"([^"]+)"/g)) {
      const candidates = [resolve(m[1], url), resolve(m[1], root)].filter((c, i, a) => c && a.indexOf(c) === i);
      const known = candidates.find((c) => listed.has(c));
      if (candidates.length) out.push(known ? [known] : candidates);
    }
    for (const m of text.matchAll(/:file\s+"([^"]+)"/g)) add(m[1]);
  }
  return out;
}

// Resolves to { cached, missing }: the number of files now held, and the
// paths of those that could not be fetched (offline, or gone) — the next
// launch tries those again.
export async function precacheApp(root = new URL('./', location.href).href) {
  // The indexes come first in ROOTS, so every listed file is known before any
  // score's imports are resolved.
  const queue = ROOTS.map((r) => [new URL(r, root).href]);
  const seen = new Set();
  const listed = new Set();
  const missing = [];
  const fetched = [];
  let cached = 0;
  const get = async (url) => {
    let response = await caches.match(url);
    if (!response) {
      response = await fetch(url);
      if (response.ok) fetched.push(url);
    }
    return response.ok ? response : null;
  };
  while (queue.length) {
    const candidates = queue.shift().filter((c) => new URL(c).origin === location.origin);
    if (!candidates.length || candidates.some((c) => seen.has(c))) continue;
    let url = null, response = null;
    for (const c of candidates) {
      seen.add(c);
      try { response = await get(c); } catch (_) { response = null; }
      if (response) { url = c; break; }
    }
    if (!response) { missing.push(candidates[candidates.length - 1].slice(root.length)); continue; }
    cached++;
    try {
      if (TEXT.test(new URL(url).pathname)) queue.push(...references(url, await response.text(), root, listed));
    } catch (_) { /* unreadable: its references wait for the next launch */ }
  }
  // What was fetched counts only once the worker has stored it: read the
  // cache back (after a moment for the last writes) rather than trust it.
  if (fetched.length) await new Promise((ok) => setTimeout(ok, 1000));
  for (const url of fetched) {
    if (!(await caches.match(url))) { cached--; missing.push(`${url.slice(root.length)} (not stored)`); }
  }
  return { cached, missing };
}
