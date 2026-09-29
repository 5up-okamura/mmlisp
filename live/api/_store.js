// Short share links (File > Share…): a score's link fragment — `n` (compile
// name) and `s` (deflate-raw + base64url source) — stored under a short id in
// Upstash Redis. Files starting with `_` are not routes.
//
// The id is derived from the content, so sharing the same score twice gives
// the same link, and a stored link never changes what it plays.

import { createHash } from 'node:crypto';

// Vercel's Upstash integration names the pair KV_* (or UPSTASH_REDIS_* when
// created from Upstash's own console).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const MAX_DATA = 96 * 1024; // base64url chars — ~72 KB compressed
export const MAX_NAME = 200;
export const ID_RE = /^[A-Za-z0-9_-]{8,16}$/;
const DATA_RE = /^[A-Za-z0-9_-]+$/;
const KEY = (id) => `share:${id}`;

export function configured() {
  return Boolean(URL_ && TOKEN);
}

async function redis(...command) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `redis HTTP ${res.status}`);
  return body.result;
}

// null when the pair is not a well-formed share.
export function validShare(n, s) {
  if (typeof s !== 'string' || !s || s.length > MAX_DATA || !DATA_RE.test(s)) return null;
  if (n != null && (typeof n !== 'string' || n.length > MAX_NAME || /[\u0000-\u001f]/.test(n))) return null;
  return { n: n || '', s };
}

// Store the share; returns its id. The id is a prefix of the content hash,
// lengthened only on the (practically impossible) clash with another score.
export async function putShare({ n, s }) {
  const value = JSON.stringify({ n, s });
  const hash = createHash('sha256').update(value).digest('base64url');
  for (let len = 8; len <= 16; len += 2) {
    const id = hash.slice(0, len);
    if ((await redis('SET', KEY(id), value, 'NX')) === 'OK') return id;
    if ((await redis('GET', KEY(id))) === value) return id; // shared before
  }
  throw new Error('no free id');
}

export async function getShare(id) {
  const value = await redis('GET', KEY(id));
  return value ? JSON.parse(value) : null;
}
