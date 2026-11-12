// Short share links (File > Share…): a score's link fragment — `n` (compile
// name) and `s` (deflate-raw + base64url source) — stored under a short id in
// the SHARES KV namespace, and `f`, the files it carries (a ZIP,
// share-files.js), beside it under the same id.
//
// The id is derived from the score itself — its name and its source text, and
// its files' paths, sizes and CRCs, not the compressed bytes, which differ
// between browsers' deflate — so sharing the same score twice gives the same
// link from anywhere, and a stored link never changes what it plays.
import { MAX_SHARE_FILES, bundleEntries } from '../src/app/share-files.js';

export const MAX_DATA = 96 * 1024; // base64url chars — ~72 KB compressed
export const MAX_NAME = 200;
const MAX_SOURCE = 1024 * 1024; // inflated bytes — a score, never a bomb
export const ID_RE = /^[A-Za-z0-9_-]{8,16}$/;
const DATA_RE = /^[A-Za-z0-9_-]+$/;
const MAX_FILES_DATA = Math.ceil((MAX_SHARE_FILES * 4) / 3); // base64url chars
const KEY = (id) => `share:${id}`;
const FILES_KEY = (id) => `files:${id}`;

// null when the fields are not a well-formed share; `f` may be left out.
export function validShare(n, s, f) {
  if (typeof s !== 'string' || !s || s.length > MAX_DATA || !DATA_RE.test(s)) return null;
  if (n != null && (typeof n !== 'string' || n.length > MAX_NAME || /[\u0000-\u001f]/.test(n))) return null;
  if (f != null && (typeof f !== 'string' || !f || f.length > MAX_FILES_DATA || !DATA_RE.test(f))) return null;
  return f ? { n: n || '', s, f } : { n: n || '', s };
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

// The score's identity: sha256 of name, NUL, source text — and, for a share
// with files, NUL and each file's path, size and CRC. null when `s` does not
// inflate to one.
async function identity({ n, s }, entries = null) {
  try {
    const src = await inflate(fromBase64Url(s));
    if (!src) return null;
    const enc = new TextEncoder();
    const name = enc.encode(n);
    const files = entries ? enc.encode('\0' + entries.map((e) => `${e.path}:${e.size}:${e.crc}`).join('\n')) : new Uint8Array(0);
    const buf = new Uint8Array(name.length + 1 + src.length + files.length);
    buf.set(name, 0);
    buf.set(src, name.length + 1);
    buf.set(files, name.length + 1 + src.length);
    return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
  } catch {
    return null;
  }
}

// Store the share; returns its id, or null for data that is not a score (or
// files that are not a bundle this app writes). The id is a prefix of the
// identity hash, lengthened only on the (practically impossible) clash with a
// different score. KV has no atomic set-if-absent, but two writers of one id
// write the same score, so the race is harmless; the files go first, so a
// stored share always finds its own.
export async function putShare(kv, { n, s, f }) {
  const files = f ? fromBase64Url(f) : null;
  const entries = files ? await bundleEntries(files) : null;
  if (files && !entries) return null;
  const hash = await identity({ n, s }, entries);
  if (!hash) return null;
  for (let len = 8; len <= 16; len += 2) {
    const id = hash.slice(0, len);
    const stored = await kv.get(KEY(id));
    if (!stored) {
      if (files) await kv.put(FILES_KEY(id), files);
      await kv.put(KEY(id), JSON.stringify(files ? { n, s, files: true } : { n, s }));
      return id;
    }
    const was = JSON.parse(stored);
    const wasEntries = was.files ? await bundleEntries(await getShareFiles(kv, id)) : null;
    if ((await identity(was, wasEntries)) === hash) return id; // shared before
  }
  throw new Error('no free id');
}

export async function getShare(kv, id) {
  const value = await kv.get(KEY(id), { cacheTtl: 86400 });
  return value ? JSON.parse(value) : null;
}

/** A share's files (the ZIP's bytes), or null. */
export async function getShareFiles(kv, id) {
  const value = await kv.get(FILES_KEY(id), { type: 'arrayBuffer', cacheTtl: 86400 });
  return value ? new Uint8Array(value) : null;
}
