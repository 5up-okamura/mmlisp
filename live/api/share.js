// POST /api/share {n, s} → {id, url}: store a share link's fragment, hand back
// its short form (/s/<id>). The app falls back to the long link on any error.

import { configured, validShare, putShare } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  if (!configured()) return res.status(503).json({ error: 'share store not configured' });
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const share = validShare(body?.n, body?.s);
  if (!share) return res.status(400).json({ error: 'bad share' });
  try {
    const id = await putShare(share);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return res.status(200).json({ id, url: `https://${host}/s/${id}` });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
