#!/usr/bin/env node
// The MDX (X68000) and MGS (MSX) song importers on files built here: each
// command family they read lands where it should, and every score they
// write compiles clean for its target. The files are made up — real songs
// are their composers', and stay out of the repo.
import assert from "node:assert/strict";
import { parseMdx, analyzeMdx, mdxToMmlisp } from "../../live/src/import-mdx.js";
import { parseMgs, analyzeMgs, mgsToMmlisp } from "../../live/src/import-mgs.js";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";

const clean = (source, what) => {
  const { diagnostics } = compileMMLisp(source, `${what}.mmlisp`);
  const bad = diagnostics.filter((d) => d.severity !== "warning" && !/^W_/.test(d.code));
  if (bad.length) {
    console.error(source);
    for (const d of bad) console.error(`${d.code} ${d.line}:${d.column} ${d.message}`);
    throw new Error(`${what}: the imported score does not compile clean`);
  }
};
const has = (source, re, what) => {
  if (!re.test(source)) { console.error(source); assert.fail(`${what}: expected ${re}`); }
};

// ── MDX ───────────────────────────────────────────────────────────────────

const be16 = (n) => [(n >> 8) & 255, n & 255];
function buildMdx({ title, pdx = "", tracks, voices }) {
  const head = [...Buffer.from(title, "latin1"), 0x0d, 0x0a, 0x1a, ...Buffer.from(pdx, "latin1"), 0];
  const table = 2 + tracks.length * 2;
  const body = [], offs = [];
  for (const t of tracks) { offs.push(table + body.length); body.push(...t); }
  const voiceAt = table + body.length;
  for (const v of voices) {
    body.push(v.num, (v.fb << 3) | v.con, 15);
    for (const f of [(o) => (o.dt << 4) | o.mul, (o) => o.tl, (o) => (o.ks << 6) | o.ar, (o) => (o.am << 7) | o.dr,
      (o) => (o.dt2 << 6) | o.sr, (o) => (o.sl << 4) | o.rr]) for (const o of v.ops) body.push(f(o));
  }
  return new Uint8Array([...head, ...be16(voiceAt), ...offs.flatMap(be16), ...body]);
}
const op = (o = {}) => ({ dt: 0, mul: 1, tl: 30, ks: 0, ar: 31, am: 0, dr: 10, dt2: 0, sr: 0, sl: 5, rr: 7, ...o });
const N = (midi, clocks) => [0x80 + midi - 15, clocks - 1]; // $80 is d+0, MIDI 15
const R = (clocks) => [clocks - 1];
const END = [0xf1, 0, 0];
const loopTo = (track, at) => { const off = at - (track.length + 3); track.push(0xf1, ...be16(off & 0xffff)); };

{
  // A: tempo, voice, v, q, a tie, detune, an LFO, a repeat with a break and
  // the song's loop. B: pan and a portamento. H: the noise. ADPCM: two
  // samples at two rates.
  const A = [0xff, 200, 0xfd, 1, 0xfb, 15, 0xf8, 6, ...N(60, 48), 0xf7, ...N(62, 48), ...N(64, 48), ...R(48)];
  const top = A.length;
  A.push(0xf3, ...be16(32), 0xec, 2, ...be16(8), ...be16(64 * 256),
    0xf6, 2, 0, ...N(60, 24), ...N(64, 24), 0xf4, 0, 0, ...N(67, 48), 0xf5, 0, 0, ...N(72, 96));
  loopTo(A, top);
  const B = [0xfd, 1, 0xfb, 10, 0xfc, 1, 0xf2, ...be16(256 * 64 / 96 * 2 | 0), ...N(48, 96), 0xfc, 2, ...N(52, 96), ...END];
  const H = [0xfd, 2, 0xed, 0x80 | 20, ...N(60, 24), ...N(60, 24), ...END];
  const P = [0xed, 2, ...N(15, 48), 0xed, 4, 0xfb, 15, ...N(16, 48), ...END]; // v8, then v15
  // C: a tie through a rest — MXDRV keys off at the rest's end, not at a
  // second rest's — and an end whose second byte is not 0.
  const C = [0xfd, 1, 0xf7, ...N(60, 24), ...R(24), ...R(24), ...N(62, 24), 0xf1, 0, 0x55];
  // D: a D, then back to 0 (stated: :pitch sticks); a portamento on a note
  // tied to (it starts at the note the tie continues). E: a track of no
  // notes that dithers the tempo, looping — MXDRV's way to a tempo between
  // two Timer B values: imported as its average.
  const D = [0xfd, 1, 0xf3, 0, 64, ...N(60, 24), 0xf3, 0, 0, ...N(60, 24), 0xf7, ...N(62, 24), 0xf2, ...be16(256), ...N(62, 48), ...END];
  const E = [0xff, 213, ...R(73), 0xff, 214, ...R(64)];
  loopTo(E, 0);
  const tracks = [A, B, C, D, E, END, END, H, P];
  const voices = [
    { num: 1, con: 4, fb: 5, ops: [op(), op({ tl: 0 }), op({ tl: 20, dt2: 1 }), op({ tl: 0 })] },
    { num: 2, con: 7, fb: 0, ops: [op({ tl: 127 }), op({ tl: 127 }), op({ tl: 127 }), op({ tl: 0 })] },
  ];
  // The PDX: a bank of 96 (offset, size), two samples of ADPCM after it.
  const pdx = new Uint8Array(768 + 256);
  const put32 = (p, v) => { pdx[p] = v >>> 24; pdx[p + 1] = (v >> 16) & 255; pdx[p + 2] = (v >> 8) & 255; pdx[p + 3] = v & 255; };
  put32(0, 768); put32(4, 128); put32(8, 896); put32(12, 128);
  for (let i = 768; i < pdx.length; i++) pdx[i] = (i * 37) & 255 | 0x11;

  const mdx = parseMdx(buildMdx({ title: "Test song", pdx: "test", tracks, voices }));
  assert.equal(mdx.title, "Test song");
  assert.equal(mdx.pdxName, "test.PDX");
  const a = analyzeMdx(mdx);
  assert.equal(a.bpm, 113.55); // Timer B 213: E's, set after A's 200
  assert.equal(a.tracks[0].notes.length, 3 + 5 + 1, "A: three notes, the repeat's five, one after");
  assert.equal(a.tracks[0].loopClock, 192);
  assert.equal(a.tracks[2].end, 96, "C: $F1 $00 ends the track, whatever follows");
  assert.equal(a.tracks[2].loopClock, null);
  for (const structure of [true, false]) {
    const { source, warnings, pcm } = mdxToMmlisp(mdx, { pdx, structure, fileName: "test.mdx" }, a);
    const what = `MDX (${structure ? "folded" : "flat"})`;
    has(source, /\(def-score :target x68k :title "Test song"\)/, what);
    has(source, /\(def-fm voice-01[\s\S]*:dt2-2 1/, what); // C1, the third in register order, is op2
    assert.ok(!/:tempo 87\.19/.test(source), `${what}: A's @t at clock 0 is E's at once`);
    has(source, /:gate\* 0\.75[\s\S]*? c d ~ e/, what); // q6 as the gate, the notes whole; & : d legato into e
    has(source, /:pitch 50/, what); // D 32 = half a semitone
    has(source, /\(macro :pitch\+ \(triangle /, what);
    has(source, /#top/, what);
    has(source, /\(go top\)/, what);
    has(source, /:pan left[\s\S]*:pan right/, what);
    has(source, /\(fm3[\s\S]*c4? _8 d/, what); // held through the first rest only
    has(source, /\(fm2[\s\S]*\(macro :pitch\+ \(linear 0\.\./, what);
    has(source, /\(noise[\s\S]*:noise-rate 12/, what); // NFRQ 20 → 32 - 20
    has(source, /\(fm4[\s\S]*:pitch 100[\s\S]*:pitch 0 /, what);
    has(source, /\(fm4[\s\S]*\(macro :pitch\+ \(linear 0\.\.75 :len 96t :wait 48t\)\) d ~ d/, what);
    // E's dither is its average, 42.53 Timer B periods a clock, from the start.
    assert.ok(!/\(fm5/.test(source), `${what}: no track for E's tempo`);
    has(source, /\(fm1[^]*?:tempo 114\.8 /, what);
    has(source, /\(def-pcm pdx-000 :file "test-pdx\.wav" :rate 7812/, what);
    has(source, /\(pcm1[\s\S]*pdx-001/, what);
    // PCM8's volume, as MXDRV sets it: v8 the sample as it is, v15 ×5 (+14 dB).
    has(source, /\(def-pcm pdx-000 [^\n]*:frames \d+\)/, what);
    has(source, /\(def-pcm pdx-001 [^\n]*:fx \[\(gain 14\)\]\)/, what);
    assert.ok(!/\(pcm1[^\n]*:vel/.test(source), `${what}: both ADPCM notes at their sample's full level`);
    assert.ok(pcm && pcm.entries.length === 2, `${what}: two samples in the wav`);
    assert.deepEqual(warnings.filter((w) => !/keys only some/.test(w)), [], `${what}: no warnings`);
    clean(source, what);
  }
  // @q as :gate- (clocks short), q under a tie: the chain's head takes the
  // last note's cut, exact; q8 after a q writes the full gate back.
  {
    const A4 = [0xfd, 1, 0xff, 200, 0xf8, 6, 0xf7, ...N(60, 24), ...N(60, 24), ...N(62, 24), 0xf8, 8, ...N(64, 24), ...END];
    const A5 = [0xfd, 1, 0xf8, 0x100 - 12, ...N(60, 24), ...N(62, 48), ...END]; // @q12
    const mdx3 = parseMdx(buildMdx({ title: "Gates", tracks: [A4, A5, END, END, END, END, END, END, END], voices }));
    const { source } = mdxToMmlisp(mdx3, { structure: false, fileName: "gates.mdx" }, analyzeMdx(mdx3));
    has(source, /\(fm1[^\n]*:gate- 32 [\s\S]*? c ~ c :gate\* 0\.75 d :gate\* 1 e/, "MDX gates");
    has(source, /\(fm2[^\n]*:gate- 16 [\s\S]*?c d4/, "MDX gates");
    clean(source, "MDX gates");
  }
  // A song on its composer's own grid: 22-clock 8ths, 176-clock bars. Its
  // quarter is 44 clocks, the tempo 48/44 faster, the notes plain 8ths.
  {
    const A2 = [0xff, 200, 0xfd, 1, ...N(60, 22), ...N(62, 22), ...N(64, 44), ...N(65, 44), ...N(67, 44), ...END];
    const mdx2 = parseMdx(buildMdx({ title: "Odd grid", tracks: [A2, END, END, END, END, END, END, END, END], voices }));
    const a2 = analyzeMdx(mdx2);
    assert.equal(a2.quarter, 44);
    assert.equal(a2.bpm, 95.12);
    const { source } = mdxToMmlisp(mdx2, { structure: false, fileName: "odd.mdx" }, a2);
    has(source, /c8 d8 e f g/, "MDX on a 44-clock quarter");
    assert.ok(!/\d+t\b/.test(source.slice(source.indexOf("(fm1"))), "MDX on a 44-clock quarter: no tick lengths");
    clean(source, "MDX odd grid");
  }
  // Without its PDX the ADPCM is left out, and said so.
  const { source, warnings } = mdxToMmlisp(mdx, { fileName: "test.mdx" }, a);
  assert.ok(!/\(pcm1/.test(source) && warnings.some((w) => /test\.PDX/.test(w)), "MDX without its PDX");
  clean(source, "MDX without PDX");
}

// ── MGS ───────────────────────────────────────────────────────────────────

function buildMgs({ title, tempo, tracks, defs, opll = 0 }) {
  const ascii = [...Buffer.from(`MGS313\r\n${title}\r\n`, "latin1"), 0x1a];
  const header = 4 + 18 * 2;
  const body = [], offs = new Array(18).fill(0);
  [defs, ...tracks].forEach((t, i) => { if (!t) return; offs[i] = header + body.length; body.push(...t); });
  const le = (n) => [n & 255, (n >> 8) & 255];
  return new Uint8Array([...ascii, 0, opll, ...le(tempo), ...offs.flatMap(le), ...body]);
}
// MGSARC's form of a file: literals only, then the end code.
function compressMgs(u8) {
  let head = 0;
  while (u8[head] !== 0) head++;
  const data = u8.subarray(head + 2);
  const out = [...u8.subarray(0, head + 2), 0, 0];
  out[3] = 0x41; // "A13"
  out[head + 1] |= 0x80;
  let ctrl = out.length, bit = 0;
  out.push(0);
  const put = (b) => { if (b) out[ctrl] |= 0x80 >> bit; if (++bit === 8) { bit = 0; ctrl = out.length; out.push(0); } };
  for (const byte of data) { put(1); out.push(byte); }
  put(0); put(1); out.push(0, 0, 0);
  return new Uint8Array(out);
}

{
  const wave = Array.from({ length: 32 }, (_, i) => (i < 16 ? i * 8 : (i - 32) * 8) & 255);
  const defs = [
    0x02, 0, 0x40 | 31, 4, 0x0f, 0x20 | 10, 4, 0x00, // @e0: noise 31; f, a=4 (to a over 4), 0
    0x02, 1, 0x80, 128, 32, 12, 64, 0, 8, // @r1
    0x02, 2, 0x20, 6, 0x12, 0xf6, 0x0f, 0x12, 5, 0x0f, // @e2: \-10 f, \5 f
    0x02, 3, 0x20, 3, 0xe8, 3, 0x05, // @e3: 8:3 (8 for 3 counts), 5
    0x03, 0, ...wave,
    0x00, 15, 0x21, 0x01, 0x1e, 0x0f, 0xf0, 0xf4, 0x24, 0x13, // @v15 (@0-@14 are the ROM's)
    0xff,
  ];
  const T = (n, len) => [0x20 | n, len]; // c=0 … b=11, rest 12
  // PSG 1: o4, v13, q6, a portamento, a tie, the loop at `$`; PSG 2: the
  // envelope and the noise; SCC 1: a wave, @r, an LFO and a repeat with a
  // break.
  const psg1 = [0xd3, 0xcd, 0x44, 6, ...T(0, 48), 0x53, 0, ...T(4, 48), 0x40, ...T(7, 48), ...T(7, 48), 0x5d,
    0x50, 0xfb, ...T(9, 96), 0xff];
  const psg2 = [0xd2, 0xcf, 0x80, ...T(0, 24), 0x82, ...T(0, 24), 0x2c, 48,
    0xcc, 0x48, 2, 0x80, ...T(0, 24), // v12, k2: @e0 below v
    0x83, 0xcf, ...T(0, 24), // @e3 at v15
    0x86, 0xcc, 0x48, 3, ...T(0, 24), 0xff]; // no envelope, v12, k3: a release
  const scc1 = [0x41, ...[150, 0], ...new Array(48).fill(1), 0xd4, 0xcc, 0x80, 0x49, 1, 0x54, 13, 3, 1, 4,
    0x57, 2, 0, 0, ...T(0, 24), 0x58, 0, 0, ...T(4, 24), 0x59, 0, 0, 0, ...T(7, 48), 0xff];
  // FM 1: the @v voice, then ROM voice 3 with the sustain on; FM rhythm
  // (#opll_mode 1): a kick.
  const fm1 = [0xd3, 0xcf, 0x8f, ...T(0, 48), 0x82, 0x5b, 1, ...T(4, 48), 0xff]; // @15, then @2: ROM voice 3
  // FM 2: q0 holds c through a rest, to the `/`.
  const fm2 = [0xd3, 0xcf, 0x84, 0x44, 0, ...T(0, 24), ...T(12, 24), 0x4a, ...T(12, 24), 0x44, 8, ...T(2, 24), 0xff];
  const rhythm = [0x45, 0x00 | 11, 0x45, 0x80 | 9, 0x31, 48, 0xa1, // vb11 vh9, b+h with a length, then h at l
    0x5a, 1, 0x30, 24, 0x21, 24, 0x30, 24, 0xff]; // kf: the kick cut by the hat
  const mgsBytes = buildMgs({ title: "MGS test", tempo: 120, defs, opll: 1,
    tracks: [psg1, psg2, null, scc1, null, null, null, null, fm1, fm2, null, null, null, null, rhythm] });
  const plain = parseMgs(mgsBytes);
  const packed = parseMgs(compressMgs(mgsBytes));
  assert.deepEqual([...packed.u8], [...plain.u8], "MGSARC's form decompresses to the file");
  const a = analyzeMgs(plain);
  assert.equal(plain.title, "MGS test");
  assert.equal(a.bpm, 150); // SCC 1 sets t150 at the start, over #tempo 120
  const by = (i) => a.tracks.find((t) => t.index === i);
  assert.equal(by(1).loopStep, 192);
  assert.equal(by(4).notes.length, 4, "SCC: the repeat's c e c, then g");
  for (const structure of [true, false]) {
    const { source, warnings } = mgsToMmlisp(plain, { structure, fileName: "test.mgs" }, a);
    const what = `MGS (${structure ? "folded" : "flat"})`;
    has(source, /\(def-score :target msx :title "MGS test"\)/, what);
    assert.ok(!/\(fm7/.test(source), `${what}: no fm7 in #opll_mode 1`);
    has(source, /:tempo 150/, what);
    has(source, /\(sqr1[\s\S]*?:gate\* 0\.75[\s\S]*? c /, what); // q6 as the gate, c its whole quarter
    has(source, /\(macro :pitch\+ \(linear -400\.\.0 :len 96t\)\)/, what); // c_e: from c to e
    has(source, /e4? (\(macro :pitch none\) )?~ g/, what); // e & g: the e slurs into the g
    has(source, /#top[\s\S]*:pitch -?\d+[\s\S]*\(go top\)/, what); // `$`, then \ 5
    has(source, /\(sqr2[\s\S]*:mode noise :noise-rate 31/, what);
    has(source, /\(def vol-e0-v15 \(macro :vol \[31 \(wait 1f\) 29 28 26 0\]\)\)/, what); // a=4: toward a, a step short (MGSDRV's)
    has(source, /\(def vol-e0-v12-k2 \(macro :vol \[26 \(wait 1f\) 25 23 22 0\]\)\)/, what); // relative to v
    has(source, /\(def bend-e2-c3 \(macro :pitch\+ \[-20 -10\]\)\)/, what); // \-10 then \5: the period's own units, + up
    has(source, /\(def-wave scc-00 :wave \[0 8 16/, what);
    has(source, /\(def vol-r1-v12-scc \(macro :vol \[28 29 30 \(wait 4f\) 29 [^\]]*#rel \(linear :len 8f\)\]\)\)/, what); // (E × 13) >> 8
    has(source, /#rel \(linear :len \d+f\)/, what);
    has(source, /\(wave1[\s\S]*scc-00[\s\S]*\(triangle /, what);
    has(source, /\(def-fm mgs-v15 :fb 7\n  :am1 0 :vib1 0 :eg1 1 :ks1 0 :ml1 1 :ksl1 0 :tl1 30 :ws1 1 :ar1 15 :dr1 0/, what);
    has(source, /\(fm1[\s\S]*mgs-v15[\s\S]*:oct 3[\s\S]*piano :sus 1/, what); // FM's o4 is an octave below the PSG's
    has(source, /\(rhythm1[\s\S]*kick :vol 25/, what); // vb11 (3 dB steps)
    has(source, /\(rhythm2[\s\S]*hat :vol 22/, what);
    has(source, /\(rhythm1[\s\S]*kick :vol 25 :mode shot[^|]*c2 :mode gate c(8)? _(8)? c/, what); // ko: rings to its next; kf: keyed off at the hat's hit
    has(source, /\(def vol-e3-v15-k2 \(macro :vol \[20 \(wait 2f\) 16 #rel \(linear :len 10f\)\]\)\)/, what); // 8:3 holds; k2 from level 5
    has(source, /\(macro :vol \[26 #rel \(linear :len 36f\)\]\)/, what); // k3 at v12
    has(source, /\(fm2[^\n]*:len 4\n  [^|]*c _8 d8/, what); // q0 holds c through the rest, to the `/`
    clean(source, what);
  }
}

// y: the user voice's registers, the PSG's mixer and noise, the rhythm's
// levels and tuning; kf keying a ko hit off.
{
  const T = (n, len) => [0x20 | n, len];
  const Y = (r, d) => [0x5c, r, d];
  const defs = [0x00, 15, 0x21, 0x01, 0x1e, 0x0f, 0xf0, 0xf4, 0x24, 0x13, 0xff];
  const psg1 = [0xd4, 0xcf, ...Y(6, 20), ...Y(7, 0b110110), ...T(0, 48), 0xff]; // noise 20; A: tone and noise
  const fm1 = [0xd4, 0xcf, 0x8f, ...Y(2, 0x45), ...Y(4, 0xa3), ...T(0, 48), 0xff]; // @15, y2 (KSL 1, TL 5), y4 (AR 10, DR 3)
  const fm2 = [0xd4, 0xcf, 0x82, ...Y(2, 0x45), ...T(0, 48), 0xff]; // a ROM voice: y on it is not read
  const rhythm = [0x45, 0x00 | 11, ...Y(0x36, 6), ...Y(0x17, 0x80), ...Y(0x27, 0x05), ...Y(0x37, 0x40), // BD 9, SD tuned, HH 11 SD 15
    0x30, 24, 0x5a, 1, 0x28, 24, 0x30, 24, 0xff]; // b; kf: s (keys the b off), b
  const mgs = parseMgs(buildMgs({ title: "y", tempo: 120, defs, opll: 1,
    tracks: [psg1, null, null, null, null, null, null, null, fm1, fm2, null, null, null, null, rhythm] }));
  const { source } = mgsToMmlisp(mgs, { fileName: "y.mgs" });
  const what = "MGS y";
  has(source, /\(sqr1[^|]*:mode both :noise-rate 20/, what);
  has(source, /\(fm1[^|]*mgs-v15 :ksl1 1 :tl1 5 :ar1 10 :dr1 3/, what);
  has(source, /\(fm2[^|]*\n  piano :sus 0 :vol/, what);
  has(source, /\(rhythm1[^|]*kick :vol 22 :mode gate[^|]*c _ c \|/, what); // y $36: 6 down; keyed off by the snare, and at the end
  has(source, /\(rhythm2[^|]*snare :vol 31 :mode gate[^|]*_ d _ \|/, what); // $180 at block 2: d4
  clean(source, what);
}

console.log("MDX / MGS import checks passed");
