#!/usr/bin/env node
// mucom88 import held to the real mucom88: the song as mucom88 renders it
// (its VGM, YM2608) against the imported score's own VGM (pc88, as File >
// Export > VGM writes it), compared frame by frame on every FM and SSG
// channel — whether it sounds, its pitch and its level — and on the rhythm's
// hits, at the start offset and clock ratio that agree best (the reference
// starts a little late, and fmgen's Timer-B runs it a few tenths of a
// percent fast).
//
//   mucom88 -x -o song.mub -b song.vgm -l 60 song.muc      (in the song's folder, the .muc as UTF-8)
//   node scripts/ab-mucom88.mjs song.muc song.vgm [--flat] [channel]
//
// `--flat` imports the song with every loop written out (importMucom's
// unfold) instead of folded. With a channel (fm:0, ssg:2, rh:1 …) it lists
// that channel's changes on both sides instead. The .muc's voice .dat and
// PCM .bin are read beside it by the names it gives.
import fs from "node:fs";
import path from "node:path";
import { importMucom } from "../../live/src/import-mucom.js";
import { compileMMLisp, collectImports } from "../../live/src/mmlisp2ir.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderVgm } from "../../live/src/export-vgm.js";

const args = process.argv.slice(2);
const flat = args.includes("--flat") && !!args.splice(args.indexOf("--flat"), 1);
const [file, refFile, only] = args;
if (!file || !refFile) { console.error("usage: node scripts/ab-mucom88.mjs song.muc song.vgm [--flat] [channel]"); process.exit(1); }

// The song's banks, beside it by the names it gives (`#voice`, `#pcm`).
const bytes = fs.readFileSync(file);
const text = new TextDecoder("shift_jis").decode(bytes);
const meta = (k) => text.match(new RegExp(`^#${k}\\s+(\\S+)`, "mi"))?.[1];
const beside = (name, ext) => {
  if (!name) return null;
  const want = [name, path.extname(name) ? null : name + ext].filter(Boolean).map((n) => path.basename(n).toLowerCase());
  const hit = fs.readdirSync(path.dirname(file)).find((e) => want.includes(e.toLowerCase()));
  return hit ? fs.readFileSync(path.join(path.dirname(file), hit)) : null;
};
const res = importMucom(bytes, beside(meta("voice"), ".dat") ?? beside("voice.dat"), beside(meta("pcm"), ".bin"), { target: "pc88", unfold: flat });
// The presets the score imports, from live/.
const LIVE = new URL("../../live/", import.meta.url);
const importsOf = (src, acc = new Map()) => {
  for (const p of collectImports(src)) {
    if (acc.has(p)) continue;
    try { acc.set(p, fs.readFileSync(new URL(p, LIVE), "utf8")); } catch { continue; }
    importsOf(acc.get(p), acc);
  }
  return acc;
};
const { ir, diagnostics } = compileMMLisp(res.source, "import.mmlisp", { imports: importsOf(res.source) });
const errors = diagnostics.filter((d) => d.severity === "error" || /^E_/.test(d.code));
if (errors.length) { for (const d of errors) console.error(`${d.code} ${d.line}:${d.column} ${d.message}`); process.exit(1); }
const player = new IRPlayer(() => {});
player.loadJSON(ir);
const ourVgm = renderVgm(player, {}, null).bytes;
const refVgm = new Uint8Array(fs.readFileSync(refFile));

// A VGM → the YM2608's registers at the middle of each 1/120 s frame, and
// the rhythm sounds keyed in it.
const STEP = 44100 / 120;
function frames(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = dv.getUint32(8, true) >= 0x150 ? 0x34 + dv.getUint32(0x34, true) : 0x40;
  const reg = [new Uint8Array(256), new Uint8Array(256)];
  const keyed = new Uint8Array(6); // an FM channel's slots on
  let hits = 0; // rhythm key-ons this frame
  const out = [];
  let t = 0, next = STEP / 2;
  const wait = (n) => { t += n; while (t >= next) { out.push({ reg: [reg[0].slice(), reg[1].slice()], keyed: keyed.slice(), hits }); hits = 0; next += STEP; } };
  const write = (port, a, d) => {
    reg[port][a] = d;
    if (port === 0 && a === 0x28) { const ch = d & 3, hi = (d >> 2) & 1; if (ch < 3) keyed[ch + 3 * hi] = d >> 4; }
    if (port === 0 && a === 0x10 && !(d & 0x80)) hits |= d & 0x3f;
  };
  while (p < u8.length) {
    const c = u8[p];
    if (c === 0x66) break;
    if (c === 0x56 || c === 0x57) { write(c - 0x56, u8[p + 1], u8[p + 2]); p += 3; }
    else if (c === 0x61) { wait(dv.getUint16(p + 1, true)); p += 3; }
    else if (c === 0x62) { wait(735); p++; }
    else if (c === 0x63) { wait(882); p++; }
    else if (c >= 0x70 && c <= 0x7f) { wait((c & 15) + 1); p++; }
    else if (c >= 0x80 && c <= 0x8f) { wait(c & 15); p++; }
    else if (c === 0x67) p += 7 + dv.getUint32(p + 3, true);
    else if (c === 0xe0) p += 5;
    else if (c >= 0x30 && c <= 0x3f) p += 2;
    else if (c >= 0x40 && c <= 0xbf) p += 3;
    else if (c >= 0xc0 && c <= 0xdf) p += 4;
    else if (c >= 0xe1) p += 5;
    else throw new Error(`VGM command $${c.toString(16)} at ${p}`);
  }
  return out;
}

const CLOCK = 7987200;
const midiOf = (hz) => (hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null);
// An algorithm's carriers, as their TL registers' offsets (M1 0, M2 8, C1 4, C2 12 — op1 op3 op2 op4).
const OP_REG = { 1: 0, 2: 8, 3: 4, 4: 12 };
const CARRIERS = [[4], [4], [4], [4], [2, 4], [2, 3, 4], [2, 3, 4], [1, 2, 3, 4]];
function channel(f, id) {
  const [kind, n] = id.split(":"), i = Number(n);
  if (kind === "fm") {
    const r = f.reg[i < 3 ? 0 : 1], c = i % 3;
    const fnum = r[0xa0 + c] | ((r[0xa4 + c] & 7) << 8), block = (r[0xa4 + c] >> 3) & 7;
    const tl = Math.min(...CARRIERS[r[0xb0 + c] & 7].map((op) => r[0x40 + OP_REG[op] + c] & 127));
    return { on: f.keyed[i] !== 0, midi: midiOf((fnum * CLOCK) / 144 / 2 ** (21 - block)), vol: 127 - tl, text: "" };
  }
  if (kind === "ssg") {
    const r = f.reg[0];
    const per = (r[i * 2] | ((r[i * 2 + 1] & 15) << 8)) || 1;
    const tone = !(r[7] & (1 << i)), noise = !(r[7] & (8 << i)), vol = r[8 + i] & 15, env = !!(r[8 + i] & 16);
    return { on: (vol > 0 || env) && (tone || noise), midi: tone ? midiOf(CLOCK / 4 / 16 / per) : null, vol: env ? 16 : vol, text: `m${(tone ? 1 : 0) | (noise ? 2 : 0)}` };
  }
  // rh: a rhythm sound keyed in the frame (BD SD TOP HH TOM RIM), at its level.
  return { on: !!((f.hits >> i) & 1), midi: null, vol: f.reg[0][0x18 + i] & 31, text: "" };
}

const R = frames(refVgm), O = frames(ourVgm);
const ids = [...Array(6).keys()].map((i) => `fm:${i}`).concat([0, 1, 2].map((i) => `ssg:${i}`), [...Array(6).keys()].map((i) => `rh:${i}`));
// Where ours lines up: an offset (frames) and a clock ratio, the pair whose
// channels agree most often on sounding.
let best = { s: -1, off: 0, scale: 1 };
for (let scale = 0.99; scale <= 1.0101; scale += 0.001)
  for (let off = -40; off <= 40; off++) {
    let s = 0;
    for (let k = 20; k < O.length - 20; k += 5) {
      const r = R[Math.round(k * scale) + off];
      if (!r) continue;
      for (const id of ids.slice(0, 9)) if (channel(r, id).on === channel(O[k], id).on) s++;
    }
    if (s > best.s) best = { s, off, scale };
  }
const N = Math.min(O.length, Math.floor((R.length - best.off) / best.scale));
const ref = (k) => R[Math.min(R.length - 1, Math.max(0, Math.round(k * best.scale) + best.off))];

if (only) {
  const list = (get) => { const out = []; let prev = null; for (let k = 0; k < N; k++) { const c = channel(get(k), only); const key = `${c.on ? "on " : "off"} ${c.midi == null ? "-" : c.midi.toFixed(2)} v${c.vol} ${c.text}`; if (key !== prev) out.push(`${String(k).padStart(5)} ${key}`); prev = key; } return out; };
  const a = list(ref), b = list((k) => O[k]);
  for (let i = 0; i < Math.max(a.length, b.length); i++) console.log((a[i] ?? "").padEnd(36), b[i] ?? "");
  process.exit(0);
}
console.log(`${path.basename(file)}${flat ? " (flat)" : ""}: ${N} frames, the reference at ${best.off >= 0 ? "+" : ""}${best.off} frames ×${best.scale.toFixed(3)}`);
let all = 0, allAgree = 0, allPitched = 0, allNear = 0, allBoth = 0, allLevel = 0;
for (const id of ids) {
  let refOn = 0, ourOn = 0, agree = 0, both = 0, near = 0, pitched = 0, volDiff = 0;
  for (let k = 0; k < N; k++) {
    const a = channel(ref(k), id), b = channel(O[k], id);
    refOn += a.on; ourOn += b.on; agree += a.on === b.on;
    if (a.on && b.on) {
      both++; volDiff += Math.abs(a.vol - b.vol);
      if (a.midi != null && b.midi != null) { pitched++; if (Math.abs(a.midi - b.midi) < 0.5) near++; }
    }
  }
  if (!refOn && !ourOn) continue;
  all += N; allAgree += agree; allPitched += pitched; allNear += near; allBoth += both;
  for (let k = 0; k < N; k++) { const a = channel(ref(k), id), b = channel(O[k], id); if (a.on && b.on && a.vol === b.vol) allLevel++; }
  console.log(`${id.padEnd(6)} sounding ${String(refOn).padStart(5)} / ${String(ourOn).padStart(5)}  agree ${(100 * agree / N).toFixed(1).padStart(5)}%  pitch ±50c ${pitched ? (100 * near / pitched).toFixed(1).padStart(5) + "%" : "    -"}  level ±${both ? (volDiff / both).toFixed(2) : "-"}`);
}
// The whole song: sounding as the reference, at its pitch, at its level.
const pct = (a, b) => `${(100 * a / (b || 1)).toFixed(2)}%`;
console.log(`all    agree ${pct(allAgree, all)}  pitch ${pct(allNear, allPitched)}  level ${pct(allLevel, allBoth)}`);
