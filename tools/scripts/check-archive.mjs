#!/usr/bin/env node
// The archive reader (live/src/archive.js) and the folder an archive opens as
// (live/src/source-folder.js), on ZIP and LZH archives written here — no
// third-party files. ZIP: stored and deflate, UTF-8 and Shift_JIS names, the
// Unicode Path field, a Mac's junk, one root folder, a climbing name, an
// encrypted entry, a damaged one. LZH: header levels 0, 1 and 2 with -lh0-
// and -lh5- (an encoder below, written from LHA's send_block), several blocks,
// Shift_JIS and directory names, a damaged header.
//
// With directories as arguments it also reads every .zip / .lzh / .lha found
// under them and requires each file's CRC to match — how the LHA variants were
// checked against lhasa's test archives (github.com/fragglet/lhasa,
// test/archives): `npm run check:archive -- <dir>`.
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { openAsBlob, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readArchive } from "../../live/src/archive.js";
import { folderFromArchive } from "../../live/src/source-folder.js";

const enc = new TextEncoder();
const sjis = (s) => {
  // The few Shift_JIS names used here, by table: node has no encoder for it.
  const table = { "曲": [0x8b, 0xc8], "の": [0x82, 0xcc], "音": [0x89, 0xb9] };
  return Uint8Array.from([...s].flatMap((ch) => table[ch] ?? [ch.charCodeAt(0)]));
};

function crc32(u8) {
  let c = 0xffffffff;
  for (const b of u8) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function crc16(u8) {
  let c = 0;
  for (const b of u8) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xa001 ^ (c >>> 1) : c >>> 1;
  }
  return c;
}
const le = (n, v) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xff);

// ---- ZIP ----------------------------------------------------------------

// entries: [{ name: Uint8Array, data, method, flags, extra, crc }]
function zip(entries) {
  const out = [], cd = [];
  for (const e of entries) {
    const body = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? crc32(e.data);
    const extra = e.extra ?? new Uint8Array();
    const offset = out.length;
    const common = [...le(2, 20), ...le(2, e.flags ?? 0), ...le(2, e.method), ...le(4, 0), ...le(4, crc), ...le(4, body.length), ...le(4, e.data.length), ...le(2, e.name.length)];
    out.push(...le(4, 0x04034b50), ...common, ...le(2, 0), ...e.name, ...body);
    cd.push(...le(4, 0x02014b50), ...le(2, 20), ...common, ...le(2, extra.length), ...le(2, 0), ...le(2, 0), ...le(2, 0), ...le(4, 0), ...le(4, offset), ...e.name, ...extra);
  }
  const cdOffset = out.length;
  out.push(...cd, ...le(4, 0x06054b50), ...le(2, 0), ...le(2, 0), ...le(2, entries.length), ...le(2, entries.length), ...le(4, cd.length), ...le(4, cdOffset), ...le(2, 0));
  return new Blob([Uint8Array.from(out)], { type: "application/zip" });
}

// ---- LZH: an -lh5- encoder ----------------------------------------------

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  put(n, v) {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >>> i) & 1);
      if (++this.n === 8) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  done() { if (this.n) this.put(8 - this.n, 0); return Uint8Array.from(this.bytes); }
}

// Huffman lengths for `freq` (none longer than 16 for the sizes used here),
// and the canonical codes LHA's make_table reads them as.
function huffman(freq) {
  const nodes = freq.map((f, sym) => ({ f, sym })).filter((n) => n.f > 0);
  const lens = new Uint8Array(freq.length);
  if (nodes.length === 1) return { single: nodes[0].sym, lens, codes: new Uint32Array(freq.length) };
  let heap = nodes.map((n) => ({ ...n, leaves: [n.sym] }));
  while (heap.length > 1) {
    heap.sort((a, b) => a.f - b.f);
    const [a, b] = heap.splice(0, 2);
    for (const s of [...a.leaves, ...b.leaves]) lens[s]++;
    heap.push({ f: a.f + b.f, leaves: [...a.leaves, ...b.leaves] });
  }
  assert.ok(Math.max(...lens) <= 16, "the test's Huffman code fits 16 bits");
  const count = new Uint32Array(17);
  for (const l of lens) count[l]++;
  count[0] = 0;
  const next = new Uint32Array(18);
  for (let l = 1; l <= 16; l++) next[l + 1] = next[l] + (count[l] << (16 - l));
  const codes = new Uint32Array(freq.length);
  for (let s = 0; s < freq.length; s++) {
    const l = lens[s];
    if (!l) continue;
    codes[s] = next[l] >>> (16 - l);
    next[l] += 1 << (16 - l);
  }
  return { single: -1, lens, codes };
}

function lh5(data, blockCodes = 1500) {
  const NC = 510, NT = 19, NP = 14, TBIT = 5, CBIT = 9, PBIT = 4;
  // Greedy matches in an 8 KiB window.
  const codes = [];
  for (let o = 0; o < data.length;) {
    let best = 0, dist = 0;
    for (let from = Math.max(0, o - 8192); from < o; from++) {
      let l = 0;
      while (l < 256 && o + l < data.length && data[from + l] === data[o + l]) l++;
      if (l > best) { best = l; dist = o - from - 1; }
    }
    if (best >= 3) { codes.push({ c: best + 253, dist }); o += best; }
    else codes.push({ c: data[o++] });
  }
  const pSym = (d) => (d === 0 ? 0 : 32 - Math.clz32(d));
  const w = new BitWriter();
  for (let at = 0; at < codes.length; at += blockCodes) {
    const block = codes.slice(at, at + blockCodes);
    const cFreq = new Array(NC).fill(0), pFreq = new Array(NP).fill(0);
    for (const k of block) { cFreq[k.c]++; if (k.c >= 256) pFreq[pSym(k.dist)]++; }
    const c = huffman(cFreq);
    w.put(16, block.length);
    let t = null;
    if (c.single < 0) {
      // The code lengths, run-length coded (count_t_freq / write_c_len).
      let n = NC;
      while (n > 0 && c.lens[n - 1] === 0) n--;
      const items = [];
      for (let i = 0; i < n;) {
        const k = c.lens[i++];
        if (k) { items.push([k + 2]); continue; }
        let run = 1;
        while (i < n && c.lens[i] === 0) { i++; run++; }
        if (run <= 2) for (let r = 0; r < run; r++) items.push([0]);
        else if (run <= 18) items.push([1, 4, run - 3]);
        else if (run === 19) items.push([0], [1, 4, 15]);
        else items.push([2, CBIT, run - 20]);
      }
      const tFreq = new Array(NT).fill(0);
      for (const [s] of items) tFreq[s]++;
      t = huffman(tFreq);
      writePtLen(w, t, NT, TBIT, 3);
      w.put(CBIT, n);
      for (const [s, bits, v] of items) {
        w.put(t.lens[s], t.codes[s]);
        if (bits) w.put(bits, v);
      }
    } else {
      w.put(TBIT, 0); w.put(TBIT, 0); w.put(CBIT, 0); w.put(CBIT, c.single);
    }
    const p = pFreq.some((f) => f) ? huffman(pFreq) : { single: 0, lens: [], codes: [] };
    writePtLen(w, p, NP, PBIT, -1);
    for (const k of block) {
      if (c.single < 0) w.put(c.lens[k.c], c.codes[k.c]);
      if (k.c < 256) continue;
      const s = pSym(k.dist);
      if (p.single < 0) w.put(p.lens[s], p.codes[s]);
      if (s > 1) w.put(s - 1, k.dist - (1 << (s - 1)));
    }
  }
  return w.done();
}

function writePtLen(w, tree, nn, nbit, special) {
  if (tree.single >= 0) { w.put(nbit, 0); w.put(nbit, tree.single); return; }
  let n = nn;
  while (n > 0 && tree.lens[n - 1] === 0) n--;
  w.put(nbit, n);
  for (let i = 0; i < n;) {
    const k = tree.lens[i++];
    if (k <= 6) w.put(3, k);
    else w.put(k - 3, (1 << (k - 3)) - 2);
    if (i === special) {
      while (i < 6 && tree.lens[i] === 0) i++;
      w.put(2, (i - 3) & 3);
    }
  }
}

// ---- LZH: headers ---------------------------------------------------------

// entries: [{ name: Uint8Array, dir?: Uint8Array (0xFF between parts), data, method, level }]
function lzh(entries) {
  const out = [];
  for (const e of entries) {
    const body = e.method === "-lh5-" ? lh5(e.data, e.blocks) : e.data;
    const m = [...enc.encode(e.method)];
    const crc = le(2, crc16(e.data));
    if (e.level === 0) {
      const name = e.dir ? [...e.dir.map((b) => (b === 0xff ? 0x5c : b)), 0x5c, ...e.name] : [...e.name];
      const h = [...m, ...le(4, body.length), ...le(4, e.data.length), ...le(4, 0), 0x20, 0, name.length, ...name, ...crc];
      out.push(h.length, h.reduce((a, b) => a + b, 0) & 0xff, ...h, ...body);
    } else if (e.level === 1) {
      // The base header ends with the first ext header's size; each ext header
      // is [type, data…, size of the next], and the compressed size counts them.
      const exts = e.dir ? [0x02, ...e.dir, ...le(2, 0)] : [];
      const h = [...m, ...le(4, body.length + exts.length), ...le(4, e.data.length), ...le(4, 0), 0x20, 1, e.name.length, ...e.name, ...crc, 0x55, ...le(2, exts.length)];
      out.push(h.length, h.reduce((a, b) => a + b, 0) & 0xff, ...h, ...exts, ...body);
    } else {
      const parts = [[0x01, [...e.name]], ...(e.dir ? [[0x02, [...e.dir]]] : [])];
      // [size of next][type data…] chained; the last size is 0.
      const chain = [];
      for (const [type, data] of parts) chain.push(...le(2, data.length + 3), type, ...data);
      chain.push(...le(2, 0));
      const total = 24 + chain.length;
      out.push(...le(2, total), ...m, ...le(4, body.length), ...le(4, e.data.length), ...le(4, 0), 0x20, 2, ...crc, 0x55, ...chain, ...body);
    }
  }
  out.push(0);
  return new Blob([Uint8Array.from(out)]);
}

// ---- the checks -----------------------------------------------------------

// Text with repeats near and far, every byte value, and runs: matches of every
// distance class, literals of every value, code-length runs of each kind.
const song = enc.encode(
  Array.from({ length: 60 }, (_, i) => `(fm${(i % 6) + 1} :oct ${i % 8} c${i % 16} d e f g a b > c ; bar ${i}\n`).join("") +
    "x".repeat(300) + String.fromCharCode(...Array.from({ length: 128 }, (_, i) => 32 + (i * 7) % 95)),
);
const binary = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + (i >> 5)) & 0xff);

{
  const blob = zip([
    { name: enc.encode("pack/"), data: new Uint8Array(), method: 0 },
    { name: enc.encode("pack/song.mmlisp"), data: song, method: 8 },
    { name: enc.encode("pack/STORED.VGZ"), data: binary, method: 0 },
    { name: enc.encode("pack/samples/kick.wav"), data: binary, method: 8 },
    { name: enc.encode("pack/曲の音.txt"), data: enc.encode("utf8"), method: 0, flags: 0x0800 },
    { name: sjis("pack/曲.txt"), data: enc.encode("sjis"), method: 0 },
    // A legacy name with its UTF-8 twin in the Unicode Path field.
    { name: enc.encode("pack/legacy.txt"), data: enc.encode("unicode path"), method: 0,
      extra: Uint8Array.from([...le(2, 0x7075), ...le(2, 5 + enc.encode("pack/音.txt").length), 1, ...le(4, crc32(enc.encode("pack/legacy.txt"))), ...enc.encode("pack/音.txt")]) },
    { name: enc.encode("__MACOSX/pack/._song.mmlisp"), data: enc.encode("junk"), method: 0 },
    { name: enc.encode("pack/.DS_Store"), data: enc.encode("junk"), method: 0 },
    { name: enc.encode("pack/../escape.txt"), data: enc.encode("no"), method: 0 },
    { name: enc.encode("pack/secret.txt"), data: enc.encode("x"), method: 0, flags: 1 },
    { name: enc.encode("pack/damaged.txt"), data: enc.encode("x"), method: 0, crc: 1 },
  ]);
  const files = await readArchive(blob);
  const paths = files.map((f) => f.path);
  assert.ok(!paths.includes("pack/../escape.txt") && !paths.some((p) => p.includes("escape")), "a climbing name is left out");
  assert.ok(!paths.includes("pack/"), "a directory entry is left out");
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(await byPath["pack/song.mmlisp"].read(), song, "deflate");
  assert.deepEqual(await byPath["pack/STORED.VGZ"].read(), binary, "stored");
  assert.equal(new TextDecoder().decode(await byPath["pack/曲の音.txt"].read()), "utf8", "a UTF-8 marked name");
  assert.equal(new TextDecoder().decode(await byPath["pack/曲.txt"].read()), "sjis", "a Shift_JIS name");
  assert.ok(byPath["pack/音.txt"], "the Unicode Path field's name");
  await assert.rejects(byPath["pack/secret.txt"].read(), /encrypted/);
  await assert.rejects(byPath["pack/damaged.txt"].read(), /CRC/);

  const folder = await folderFromArchive(new File([blob], "pack.zip"));
  assert.equal(folder.name, "pack.zip");
  const names = (await folder.files()).map((f) => f.name).sort();
  assert.deepEqual(names, ["STORED.VGZ", "damaged.txt", "secret.txt", "song.mmlisp", "曲.txt", "曲の音.txt", "音.txt"].sort(),
    "one root folder opens as that folder; the Mac's junk and subfolders are not listed");
  assert.deepEqual(await folder.read("samples/kick.wav"), binary, "a path into a subfolder");
  assert.deepEqual(await folder.read("stored.vgz"), binary, "names match without regard to case");
  assert.equal(await folder.read("../song.mmlisp"), null);
  assert.equal(await folder.read("missing.wav"), null);
  const opened = await (await folder.files()).find((f) => f.name === "song.mmlisp").file();
  assert.equal(opened.name, "song.mmlisp");
  assert.equal(await opened.text(), new TextDecoder().decode(song));
  assert.equal(await folder.pathOf({}), null, "a handle is never inside an archive");
  assert.ok(await folder.same(folder));
}

{
  // An archive with files beside its folder keeps its top level.
  const folder = await folderFromArchive(new File([zip([
    { name: enc.encode("a/x.txt"), data: enc.encode("1"), method: 0 },
    { name: enc.encode("y.txt"), data: enc.encode("2"), method: 0 },
  ])], "two.zip"));
  assert.deepEqual((await folder.files()).map((f) => f.name), ["y.txt"]);
  assert.deepEqual(await folder.read("a/x.txt"), enc.encode("1"));
}

{
  const dir = Uint8Array.from([...enc.encode("songs"), 0xff, ...sjis("曲")]);
  const blob = lzh([
    { level: 0, method: "-lh5-", name: enc.encode("SONG0.MML"), data: song },
    { level: 0, method: "-lh0-", name: enc.encode("BIN0.DAT"), dir: enc.encode("sub"), data: binary },
    { level: 1, method: "-lh5-", name: enc.encode("song1.mml"), dir, data: song },
    { level: 1, method: "-lh5-", name: enc.encode("bin1.dat"), data: binary, blocks: 64 }, // many blocks
    { level: 2, method: "-lh5-", name: sjis("曲の音.muc"), data: song },
    { level: 2, method: "-lh0-", name: enc.encode("bin2.dat"), dir, data: binary },
    { level: 2, method: "-lh5-", name: enc.encode("tiny"), data: enc.encode("aaaaaaaaaaaa") },
    { level: 2, method: "-lh5-", name: enc.encode("empty"), data: new Uint8Array() },
  ]);
  const files = await readArchive(blob);
  assert.deepEqual(files.map((f) => f.path), ["SONG0.MML", "sub/BIN0.DAT", "songs/曲/song1.mml", "bin1.dat", "曲の音.muc", "songs/曲/bin2.dat", "tiny", "empty"],
    "names and directories, levels 0–2");
  for (const f of files) {
    const want = /bin|BIN/.test(f.path) ? binary : f.path === "tiny" ? enc.encode("aaaaaaaaaaaa") : f.path === "empty" ? new Uint8Array() : song;
    assert.deepEqual(await f.read(), want, `${f.path} decodes`);
  }
  assert.ok(lh5(song).length < song.length / 2, "the encoder above really compresses — the decoder sees matches");

  // An extended header whose size could never advance the read is damage, not a hang.
  const bad = [...new Uint8Array(await lzh([{ level: 2, method: "-lh0-", name: enc.encode("x"), data: enc.encode("x") }]).arrayBuffer())];
  bad[24] = 1; bad[25] = 0;
  await assert.rejects(readArchive(new Blob([Uint8Array.from(bad)])), /damaged header/);
}

// lhasa's archives, or any others: every file in them must read with its CRC.
let external = 0;
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(zip|lzh|lha)$/i.test(n) ? [p] : [];
});
for (const arg of process.argv.slice(2)) {
  for (const path of walk(arg)) {
    for (const f of await readArchive(await openAsBlob(path))) {
      await f.read();
      external++;
    }
  }
}

console.log(`Archive checks passed: ZIP (stored, deflate, names, junk, root folder, damage), LZH (levels 0–2, -lh0-, -lh5-)${external ? `, ${external} files from the archives given` : ""}`);
