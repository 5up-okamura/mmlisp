#!/usr/bin/env node
// MGS import held to the real MGSDRV: the song played by MGSDRV (libkss-js,
// which runs the driver on an emulated MSX and writes VGM) against the
// imported score's own VGM (as File > Export > VGM writes it), compared
// frame by frame on every PSG, SCC and FM channel — whether it sounds, its
// pitch and its level — at the start offset that agrees best.
//
//   cd tools && npm i --no-save libkss-js     (it carries MGSDRV; not a dependency)
//   node scripts/ab-mgsdrv.mjs song.mgs [seconds=40] [channel]
//
// With a channel (psg:0, scc:2, fm:4 …) it lists that channel's changes on
// both sides instead.
import fs from "node:fs";
import { parseMgs, mgsToMmlisp } from "../../live/src/import-mgs.js";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderVgm } from "../../live/src/export-vgm.js";

const [file, seconds = "40", only] = process.argv.slice(2);
if (!file) { console.error("usage: node scripts/ab-mgsdrv.mjs song.mgs [seconds] [channel]"); process.exit(1); }
let libkss;
try { libkss = await import("libkss-js"); }
catch { console.error("libkss-js is not installed: cd tools && npm i --no-save libkss-js"); process.exit(1); }

const bytes = new Uint8Array(fs.readFileSync(file));
await libkss.KSSPlay.initialize();
const kss = libkss.KSS.createUniqueInstance(bytes, file);
const refVgm = kss.toVGM({ duration: Number(seconds) * 1000, loop: 1 });
kss.release();

const { source } = mgsToMmlisp(parseMgs(bytes), { fileName: file.split("/").pop() });
const { ir, diagnostics } = compileMMLisp(source, "import.mmlisp");
const errors = diagnostics.filter((d) => !/^W_/.test(d.code));
if (errors.length) { for (const d of errors) console.error(`${d.code} ${d.line}:${d.column} ${d.message}`); process.exit(1); }
const player = new IRPlayer(() => {});
player.loadJSON(ir);
const ourVgm = renderVgm(player, {}, null).bytes;

// A VGM → the chips' registers at the end of each 1/60 s frame.
// Each side read on its own frame, in the frame's middle (a write on its
// edge is on one side of it): MGSDRV's on libkss at the MSX's 59.92 Hz
// (3579545 / 228 / 262), ours at the player's 60 Hz — so frame n is frame n.
const MSX_FRAME = 44100 / (3579545 / 228 / 262);
function frames(u8, step = 735) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = dv.getUint32(8, true) >= 0x150 ? 0x34 + dv.getUint32(0x34, true) : 0x40;
  const ay = new Uint8Array(16), opll = new Uint8Array(64);
  const scc = { freq: new Uint16Array(5), vol: new Uint8Array(5), key: 0 };
  const out = [];
  let t = 0, next = step / 2;
  const wait = (n) => { t += n; while (t >= next) { out.push({ ay: ay.slice(), opll: opll.slice(), scc: { freq: scc.freq.slice(), vol: scc.vol.slice(), key: scc.key } }); next += step; } };
  while (p < u8.length) {
    const c = u8[p];
    if (c === 0x66) break;
    if (c === 0xa0) { ay[u8[p + 1] & 15] = u8[p + 2]; p += 3; }
    else if (c === 0x51) { opll[u8[p + 1] & 63] = u8[p + 2]; p += 3; }
    else if (c === 0xd2) {
      const port = u8[p + 1] & 0x7f, a = u8[p + 2], d = u8[p + 3];
      if (port === 1 && a >> 1 < 5) { const ch = a >> 1; scc.freq[ch] = a & 1 ? (scc.freq[ch] & 0xff) | ((d & 15) << 8) : (scc.freq[ch] & 0xf00) | d; }
      else if (port === 2 && a < 5) scc.vol[a] = d & 15;
      else if (port === 3) scc.key = d;
      p += 4;
    } else if (c === 0x61) { wait(dv.getUint16(p + 1, true)); p += 3; }
    else if (c === 0x62) { wait(735); p++; }
    else if (c === 0x63) { wait(882); p++; }
    else if (c >= 0x70 && c <= 0x7f) { wait((c & 15) + 1); p++; }
    else if (c === 0x67) p += 7 + dv.getUint32(p + 3, true);
    else if (c >= 0x30 && c <= 0x3f) p += 2;
    else if (c >= 0x40 && c <= 0xbf) p += 3;
    else if (c >= 0xc0 && c <= 0xdf) p += 4;
    else if (c >= 0xe0) p += 5;
    else throw new Error(`VGM command $${c.toString(16)} at ${p}`);
  }
  return out;
}

const CLOCK = 1789772.5;
// The OPLL's rhythm sounds: [$0E bit, channel, volume register, its shift].
const RHYTHM = [[0x10, 6, 0x36, 0], [0x08, 7, 0x37, 0], [0x04, 8, 0x38, 4], [0x02, 8, 0x38, 0], [0x01, 7, 0x37, 4]];
const midiOf = (hz) => (hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null);
function channel(f, id) {
  const [kind, n] = id.split(":"), i = Number(n);
  if (kind === "psg") {
    const per = (f.ay[i * 2] | ((f.ay[i * 2 + 1] & 15) << 8)) || 1;
    const tone = !(f.ay[7] & (1 << i)), noise = !(f.ay[7] & (8 << i)), vol = f.ay[8 + i] & 15;
    return { on: vol > 0 && (tone || noise), midi: tone ? midiOf(CLOCK / 16 / per) : null, vol, text: `m${(tone ? 1 : 0) | (noise ? 2 : 0)} n${f.ay[6] & 31}` };
  }
  if (kind === "scc") {
    const vol = f.scc.vol[i];
    return { on: !!((f.scc.key >> i) & 1) && vol > 0, midi: midiOf(CLOCK / 16 / (f.scc.freq[i] + 1)), vol, text: "" };
  }
  if (kind === "rh") {
    // A rhythm sound: keyed by its $0E bit or by its channel's key (a
    // driver may key either), at its channel's pitch and its volume nibble.
    const [bit, ch, reg, sh] = RHYTHM[i], hi = f.opll[0x20 + ch];
    const fnum = f.opll[0x10 + ch] | ((hi & 1) << 8), block = (hi >> 1) & 7;
    const on = !!(f.opll[0x0e] & 0x20) && (!!(f.opll[0x0e] & bit) || !!((hi >> 4) & 1));
    return { on, midi: fnum ? midiOf((fnum * 3579545) / 72 / 2 ** (19 - block)) : null, vol: 15 - ((f.opll[reg] >> sh) & 15), text: "" };
  }
  const hi = f.opll[0x20 + i], fnum = f.opll[0x10 + i] | ((hi & 1) << 8), block = (hi >> 1) & 7;
  // Under the rhythm channels 7-9 are its (rh:), not FM.
  return { on: !!((hi >> 4) & 1) && !(i >= 6 && f.opll[0x0e] & 0x20), midi: fnum ? midiOf((fnum * 3579545) / 72 / 2 ** (19 - block)) : null,
    vol: 15 - (f.opll[0x30 + i] & 15), text: `i${f.opll[0x30 + i] >> 4} s${(hi >> 5) & 1}` };
}

const R = frames(refVgm, MSX_FRAME), O = frames(ourVgm);
const ids = [0, 1, 2].map((i) => `psg:${i}`).concat([0, 1, 2, 3, 4].map((i) => `scc:${i}`), [...Array(9).keys()].map((i) => `fm:${i}`),
  [0, 1, 2, 3, 4].map((i) => `rh:${i}`)); // rh: BD SD TOM CYM HH
const N = Math.min(R.length, O.length);
let off = 0, best = -1;
for (let o = -10; o <= 10; o++) {
  let s = 0;
  for (let k = 20; k < N - 20; k += 3) for (const id of ids) if (channel(R[k], id).on === channel(O[k + o] ?? O[0], id).on) s++;
  if (s > best) { best = s; off = o; }
}
const ours = (k) => O[Math.min(O.length - 1, Math.max(0, k + off))];
if (only) {
  const list = (get) => { const out = []; let prev = null; for (let k = 0; k < N; k++) { const c = channel(get(k), only); const key = `${c.on ? "on " : "off"} ${c.midi == null ? "-" : c.midi.toFixed(2)} v${c.vol} ${c.text}`; if (key !== prev) out.push(`${String(k).padStart(5)} ${key}`); prev = key; } return out; };
  const a = list((k) => R[k]), b = list(ours);
  for (let i = 0; i < Math.max(a.length, b.length); i++) console.log((a[i] ?? "").padEnd(36), b[i] ?? "");
  process.exit(0);
}
console.log(`${file}: ${N} frames compared, ours ${off >= 0 ? "+" : ""}${off} frames`);
for (const id of ids) {
  let refOn = 0, ourOn = 0, agree = 0, both = 0, near = 0, pitched = 0, volDiff = 0;
  for (let k = 0; k < N; k++) {
    const a = channel(R[k], id), b = channel(ours(k), id);
    refOn += a.on; ourOn += b.on; agree += a.on === b.on;
    if (a.on && b.on) {
      both++; volDiff += Math.abs(a.vol - b.vol);
      if (a.midi != null && b.midi != null) { pitched++; if (Math.abs(a.midi - b.midi) < 0.5) near++; }
    }
  }
  if (!refOn && !ourOn) continue;
  console.log(`${id.padEnd(6)} sounding ${String(refOn).padStart(5)} / ${String(ourOn).padStart(5)}  agree ${(100 * agree / N).toFixed(1).padStart(5)}%  pitch ±50c ${pitched ? (100 * near / pitched).toFixed(1).padStart(5) + "%" : "    -"}  level ±${both ? (volDiff / both).toFixed(2) : "-"}`);
}
