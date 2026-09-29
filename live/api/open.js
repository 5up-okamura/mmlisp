// GET /s/<id> (rewritten here): the short link. Answers a small page that
// carries the score's own title for link cards, then hands the browser to the
// app with the full fragment (#n=…&s=…), which it loads as before.

import { ID_RE, configured, getShare } from './_store.js';

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res, status, { title, description, target, image, url }) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // A stored share never changes, so the edge can keep it; a miss may be
  // filled later only by the same id's own content, but keep misses short.
  res.setHeader('Cache-Control', status === 200
    ? 'public, max-age=3600, s-maxage=31536000, immutable'
    : 'public, max-age=60');
  res.send(`<!DOCTYPE html>
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
</html>`);
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `https://${host}`;
  const id = String(req.query.id || '');
  const base = {
    image: `${origin}/icons/icon-512.png`,
    url: `${origin}/s/${id}`,
    description: 'A Mega Drive (YM2612 + PSG) score — tap to play it in MMLisp Live.',
  };
  let share = null;
  if (ID_RE.test(id) && configured()) {
    try { share = await getShare(id); } catch { /* treated as missing */ }
  }
  if (!share) {
    return page(res, 404, { ...base, title: 'MMLisp Live', target: '/', description: 'This share link was not found.' });
  }
  const name = (share.n || 'untitled.mmlisp').split('/').pop().replace(/\.mmlisp$/i, '');
  const params = new URLSearchParams();
  if (share.n) params.set('n', share.n);
  const head = params.toString();
  const target = '/#' + (head ? head + '&' : '') + 's=' + share.s;
  return page(res, 200, { ...base, title: `${name} — MMLisp`, target });
}
