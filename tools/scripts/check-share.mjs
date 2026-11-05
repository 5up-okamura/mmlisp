#!/usr/bin/env node
// Share links with files (live/worker/, live/src/share-files.js), run against
// an in-memory KV: a score alone keeps the id it always had; one with files
// stores them, serves them, and gets the same id however its ZIP was packed;
// a bundle that is not one the app writes is refused; a wav travels mono,
// 16-bit, at most CARRY_RATE — but at its own rate where a def counts frames.
import assert from "node:assert/strict";
import worker from "../../live/worker/index.js";
import { writeZip, readArchive } from "../../live/src/archive.js";
import { shareBundle, carriedWav, wavBytes, CARRY_RATE, MAX_SHARE_FILES } from "../../live/src/share-files.js";
import { decodeWav } from "../../live/src/wav-decode.js";

const kv = new Map();
const env = {
  SHARES: {
    async get(key, opts) {
      const v = kv.get(key);
      if (v == null) return null;
      return opts?.type === "arrayBuffer" ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
    },
    async put(key, value) { kv.set(key, value); },
  },
  ASSETS: { fetch: () => new Response("asset") },
};
const call = (path, init) => worker.fetch(new Request("https://mmlisp.test" + path, init), env);
const post = (body) => call("/api/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const b64u = (u8) => Buffer.from(u8).toString("base64url");
const packed = async (text) => b64u(new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()));

const src = '(def-score :pcm-voices 1)\n(def-pcm kick :file "wav/kick.wav")\n(pcm1 kick c)\n';
const s = await packed(src);

// A score alone: the id it had before files existed (sha256 of name NUL source).
const plain = await (await post({ n: "song.mmlisp", s })).json();
const want = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("song.mmlisp\0" + src))).toString("base64url").slice(0, 8);
assert.equal(plain.id, want, "a score alone keeps its id");
assert.ok(!/[#&]f=/.test(await call(`/s/${plain.id}`).then((r) => r.text())), "a score alone's link carries no files");

// A wav: 44.1 kHz stereo 16-bit, a second long, travels at CARRY_RATE mono.
const rate = 44100, n = rate;
const stereo = new Uint8Array(44 + n * 4);
{
  const v = new DataView(stereo.buffer);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) stereo[o + i] = t.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { const x = Math.round(Math.sin(i / 20) * 12000); v.setInt16(44 + i * 4, x, true); v.setInt16(46 + i * 4, x, true); }
}
const small = decodeWav(carriedWav(stereo));
assert.equal(small.sampleRate, CARRY_RATE, "a wav travels at CARRY_RATE");
assert.equal(small.data.length, Math.floor(n * CARRY_RATE / rate), "and its length in time stays");
assert.equal(decodeWav(carriedWav(stereo, { keepRate: true })).sampleRate, rate, "one counted in frames keeps its rate");
const tiny = wavBytes(new Float32Array(100), 8000);
assert.equal(carriedWav(tiny), tiny, "a wav already as small travels as it is");

// A share with files: stored, served, and its link says so.
const { zip, carried, left } = await shareBundle("song.mmlisp", src, [
  { path: "wav/kick.wav", bytes: carriedWav(stereo) },
  { path: "../outside.wav", bytes: tiny },
]);
assert.deepEqual(carried.map((f) => f.path), ["wav/kick.wav"], "the folder's wav is carried");
assert.deepEqual(left.map((f) => f.path), ["../outside.wav"], "one outside the folder is not");
const withFiles = await (await post({ n: "song.mmlisp", s, f: b64u(zip) })).json();
assert.notEqual(withFiles.id, plain.id, "files make another share");
assert.ok((await call(`/s/${withFiles.id}`).then((r) => r.text())).includes(`f=${withFiles.id}`), "its link names its files");
const served = new Uint8Array(await (await call(`/api/share/${withFiles.id}/files`)).arrayBuffer());
const paths = (await readArchive(new Blob([served]))).map((e) => e.path).sort();
assert.deepEqual(paths, ["song.mmlisp", "wav/kick.wav"], "the files come back as the ZIP, the score at its root");

// The same files packed another way (stored, in another order): the same id.
const entries = await readArchive(new Blob([zip]));
const rezip = await writeZip(await Promise.all(entries.reverse().map(async (e) => ({ path: e.path, bytes: await e.read() }))));
assert.equal((await (await post({ n: "song.mmlisp", s, f: b64u(rezip) })).json()).id, withFiles.id, "the same files, the same id");

// Refused: not a ZIP, a path out of its folder, a file that is neither score nor wav, too large.
const refused = async (f, why) => assert.equal((await post({ n: "song.mmlisp", s, f })).status, 400, why);
await refused(b64u(new Uint8Array([1, 2, 3])), "not a ZIP");
await refused(b64u(await writeZip([{ path: "../x.wav", bytes: tiny }])), "a path out of the folder");
await refused(b64u(await writeZip([{ path: "x.exe", bytes: tiny }])), "neither a score nor a wav");
await refused("A".repeat(Math.ceil((MAX_SHARE_FILES * 4) / 3) + 4), "over the size limit");
assert.equal((await call("/api/share/nosuchid/files")).status, 404, "no such files");

// Too many bytes to carry: the largest goes, and is named.
const big = { path: "big.wav", bytes: (await import("node:crypto")).randomBytes(MAX_SHARE_FILES + 1) }; // noise: no deflate shrinks it
const over = await shareBundle("song.mmlisp", src, [big, { path: "wav/kick.wav", bytes: tiny }]);
assert.deepEqual([over.carried.map((f) => f.path), over.left.map((f) => f.path)], [["wav/kick.wav"], ["big.wav"]], "the largest is left out");
console.log("Share checks passed: a score alone, files stored and served, one id however packed, bundles refused, wavs as they travel");
