// The Worker in front of MMLisp Live's static assets (wrangler.jsonc). Only
// the share-link routes reach it; every other path is served as an asset.
//
//   POST /api/share {n, s, f?} → {id, url}: store a share link's fragment and
//     the files it carries (f: a ZIP, base64url), hand back its short form
//     (/s/<id>). The app falls back to the long link on any error.
//   GET /s/<id>: the short link. Answers a small page that carries the score's
//     own title for link cards, then hands the browser to the app with the
//     full fragment (#n=…&s=…, and f=<id> when it carries files), which it
//     loads as before.
//   GET /api/share/<id>/files: those files, the ZIP the app opens as a folder.

import { ID_RE, validShare, putShare, getShare, getShareFiles } from './store.js';

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

async function share(request, env, origin) {
  if (request.method !== 'POST') return json(405, { error: 'POST only' }, { Allow: 'POST' });
  if (!env.SHARES) return json(503, { error: 'share store not configured' });
  const body = await request.json().catch(() => null);
  const data = validShare(body?.n, body?.s, body?.f);
  if (!data) return json(400, { error: 'bad share' });
  try {
    const id = await putShare(env.SHARES, data);
    if (!id) return json(400, { error: 'bad share' });
    return json(200, { id, url: `${origin}/s/${id}` });
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
}

function page(status, { title, description, target, image, url }) {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MMLisp Live">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script>
</head>
<body style="background:#000;color:#7df;font-family:sans-serif">
<p><a href="${esc(target)}" style="color:inherit">Open in MMLisp Live</a></p>
</body>
</html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // A stored share never changes, so it can be kept; a miss may be filled
      // later only by the same id's own content, but keep misses short.
      'Cache-Control': status === 200 ? 'public, max-age=3600, immutable' : 'public, max-age=60',
    },
  });
}

async function open(env, origin, id) {
  const base = {
    image: `${origin}/icons/icon-512.png`,
    url: `${origin}/s/${id}`,
    description: 'A Mega Drive (YM2612 + PSG) score — tap to play it in MMLisp Live.',
  };
  let data = null;
  if (ID_RE.test(id) && env.SHARES) {
    try { data = await getShare(env.SHARES, id); } catch { /* treated as missing */ }
  }
  if (!data) {
    return page(404, { ...base, title: 'MMLisp Live', target: '/', description: 'This share link was not found.' });
  }
  const name = (data.n || 'untitled.mmlisp').split('/').pop().replace(/\.mmlisp$/i, '');
  const params = new URLSearchParams();
  if (data.n) params.set('n', data.n);
  if (data.files) params.set('f', id);
  const head = params.toString();
  const target = '/#' + (head ? head + '&' : '') + 's=' + data.s;
  return page(200, { ...base, title: `${name} — MMLisp`, target });
}

// A share's files; they never change, so they are kept.
async function files(env, id) {
  let bytes = null;
  if (ID_RE.test(id) && env.SHARES) {
    try { bytes = await getShareFiles(env.SHARES, id); } catch { /* treated as missing */ }
  }
  if (!bytes) return json(404, { error: 'no such files' }, { 'Cache-Control': 'public, max-age=60' });
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/share') return share(request, env, url.origin);
    const f = url.pathname.match(/^\/api\/share\/([^/]*)\/files$/);
    if (f) return files(env, f[1]);
    const m = url.pathname.match(/^\/s\/([^/]*)\/?$/);
    if (m) return open(env, url.origin, m[1]);
    return env.ASSETS.fetch(request);
  },
};
