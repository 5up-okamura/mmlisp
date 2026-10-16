// Short share links (File > Share…): a score's link fragment — `n` (compile
// name) and `s` (deflate-raw + base64url source) — stored under a short id in
// the SHARES KV namespace.
//
// The id is derived from the score itself — its name and its source text, not
// the compressed bytes, which differ between browsers' deflate — so sharing
// the same score twice gives the same link from anywhere, and a stored link
// never changes what it plays.

export const MAX_DATA = 96 * 1024; // base64url chars — ~72 KB compressed
export const MAX_NAME = 200;
const MAX_SOURCE = 1024 * 1024; // inflated bytes — a score, never a bomb
export const ID_RE = /^[A-Za-z0-9_-]{8,16}$/;
const DATA_RE = /^[A-Za-z0-9_-]+$/;
const KEY = (id) => `share:${id}`;

// null when the pair is not a well-formed share.
export function validShare(n, s) {
  if (typeof s !== 'string' || !s || s.length > MAX_DATA || !DATA_RE.test(s)) return null;
  if (n != null && (typeof n !== 'string' || n.length > MAX_NAME || /[\u0000-\u001f]/.test(n))) return null;
  return { n: n || '', s };
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The inflated source, or null past MAX_SOURCE or on bad data.
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SOURCE) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// The score's identity: sha256 of name, NUL, source text. null when `s` does
// not inflate to one.
async function identity({ n, s }) {
  try {
    const src = await inflate(fromBase64Url(s));
    if (!src) return null;
    const name = new TextEncoder().encode(n);
    const buf = new Uint8Array(name.length + 1 + src.length);
    buf.set(name, 0);
    buf.set(src, name.length + 1);
    return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
  } catch {
    return null;
  }
}

// Store the share; returns its id, or null for data that is not a score. The
// id is a prefix of the identity hash, lengthened only on the (practically
// impossible) clash with a different score. KV has no atomic set-if-absent,
// but two writers of one id write the same score, so the race is harmless.
export async function putShare(kv, share) {
  const hash = await identity(share);
  if (!hash) return null;
  for (let len = 8; len <= 16; len += 2) {
    const id = hash.slice(0, len);
    const stored = await kv.get(KEY(id));
    if (!stored) {
      await kv.put(KEY(id), JSON.stringify(share));
      return id;
    }
    if ((await identity(JSON.parse(stored))) === hash) return id; // shared before
  }
  throw new Error('no free id');
}

export async function getShare(kv, id) {
  const value = await kv.get(KEY(id), { cacheTtl: 86400 });
  return value ? JSON.parse(value) : null;
}
