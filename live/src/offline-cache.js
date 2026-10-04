// Fill the service worker's cache with every file the app can fetch, so the
// installed app runs offline — a preset, a snippet or the synth's worklet
// before it was ever opened. Run from the page on every launch, not from the
// worker: iOS stops a worker's background work within seconds, which left
// the samples (fetched last) uncached; the page lives as long as it is open.
//
// No list is kept: files are found by following references — from the page
// and the worklet, their module imports, stylesheets, fonts and icons; from
// the preset, snippet and example indexes, each score's (import "…") — tried
// against the score's own folder, then the app's, as the compiler resolves it
// — and the samples its :file names, relative to the score. Each is
// fetched through the worker (sw.js), whose network-first handler stores it;
// one already cached is only read for its references.

const ROOTS = ['./', './index.html', './worklet.js', './manifest.webmanifest',
  './presets/index.json', './snippets/index.json', './examples/index.json'];
const TEXT = /\.(?:html|js|css|json|webmanifest|mmlisp)$|\/$/;

// [url, optional]: an optional one (an import's other candidate) is not
// missed when absent.
function references(url, text, root) {
  const out = [];
  const add = (ref, base = url, optional = false) => {
    if (!ref || /^(?:[a-z]+:|\/\/|#)/i.test(ref)) return; // another origin, data:, mailto:, anchors
    out.push([new URL(ref, base).href, optional]);
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
    try { for (const f of JSON.parse(text)) add(f, root); } catch (_) { /* not a list */ }
  }
  if (/\.webmanifest$/.test(path)) {
    try { for (const icon of JSON.parse(text).icons || []) add(icon.src); } catch (_) { /* malformed */ }
  }
  if (/\.mmlisp$/.test(path)) {
    for (const m of text.matchAll(/\(import\s+"([^"]+)"/g)) { add(m[1], url, true); add(m[1], root, true); }
    for (const m of text.matchAll(/:file\s+"([^"]+)"/g)) add(m[1]);
  }
  return out;
}

// Resolves to { cached, missing }: the number of files now held, and the
// paths of those that could not be fetched (offline, or gone) — the next
// launch tries those again.
export async function precacheApp(root = new URL('./', location.href).href) {
  const queue = ROOTS.map((r) => [new URL(r, root).href, false]);
  const seen = new Set();
  const missing = [];
  const fetched = [];
  let cached = 0;
  while (queue.length) {
    const [url, optional] = queue.shift();
    if (seen.has(url) || new URL(url).origin !== location.origin) continue;
    seen.add(url);
    try {
      let response = await caches.match(url);
      if (!response) {
        response = await fetch(url);
        if (response.ok) fetched.push(url);
      }
      if (!response.ok) { if (!optional) missing.push(url.slice(root.length)); continue; }
      cached++;
      if (TEXT.test(new URL(url).pathname)) queue.push(...references(url, await response.text(), root));
    } catch (_) {
      if (!optional) missing.push(url.slice(root.length));
    }
  }
  // What was fetched counts only once the worker has stored it: read the
  // cache back (after a moment for the last writes) rather than trust it.
  if (fetched.length) await new Promise((ok) => setTimeout(ok, 1000));
  for (const url of fetched) {
    if (!(await caches.match(url))) { cached--; missing.push(`${url.slice(root.length)} (not stored)`); }
  }
  return { cached, missing };
}
