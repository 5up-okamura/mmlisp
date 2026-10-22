/**
 * A fast model of one YM2612 channel, for search (voice-estimate.js): the
 * chip's integer rules for phase, log-sin and exp, modulation, feedback, the
 * eight algorithms in the chip's own order (S1, S3, S2, S4 — S3 hears S2 from
 * the sample before, as Nuked-OPN2's fm_algorithm has it) and the envelope
 * generator. It renders a note some 30 times faster than Nuked; against it a
 * patch comes out within about 1 dB of log-spectral error, where two
 * different patches lie 15–25 dB apart. No LFO, SSG-EG or detune.
 */
import { midiToFnumBlock } from "./ir-utils.js";

export const RATE = 7670454 / 144;
const LOGSIN = new Uint16Array(256), EXP = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256);
  EXP[i] = Math.round((Math.pow(2, i / 256) - 1) * 1024);
}
// one operator: phase (10-bit) and attenuation (12-bit, 4.8) → 14-bit signed
function opOut(phase, att) {
  const p = phase & 1023;
  const q = p & 256 ? 255 - (p & 255) : p & 255;
  const a = LOGSIN[q] + (att << 2);
  const l = a > 0x1fff ? 0x1fff : a;
  const v = ((EXP[255 - (l & 255)] | 1024) << 2) >> (l >> 8); // 13-bit magnitude, as the chip's
  return p & 512 ? -v : v;
}
const EG_INC = [
  [0, 1, 0, 1, 0, 1, 0, 1], [0, 1, 0, 1, 1, 1, 0, 1], [0, 1, 1, 1, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 2, 1, 1, 1, 2], [1, 2, 1, 2, 1, 2, 1, 2], [1, 2, 2, 2, 1, 2, 2, 2],
  [2, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 4, 2, 2, 2, 4], [2, 4, 2, 4, 2, 4, 2, 4], [2, 4, 4, 4, 2, 4, 4, 4],
  [4, 4, 4, 4, 4, 4, 4, 4], [4, 4, 4, 8, 4, 4, 4, 8], [4, 8, 4, 8, 4, 8, 4, 8], [4, 8, 8, 8, 4, 8, 8, 8],
  [8, 8, 8, 8, 8, 8, 8, 8],
];
function egStep(rate, counter) { // the increment this EG tick, or 0
  if (rate < 2) return 0;
  if (rate < 48) {
    const shift = 11 - (rate >> 2);
    if (counter & ((1 << shift) - 1)) return 0;
    return EG_INC[rate & 3][(counter >> shift) & 7];
  }
  const row = rate >= 60 ? 16 : 4 + ((rate - 48) >> 2) * 4 + (rate & 3);
  return EG_INC[row][counter & 7];
}
// the diagram's carriers per algorithm (op index 0..3 = op1..op4)
export const CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];

/**
 * patch: { alg, fb, ops: [{ ar, dr, sr, sl, rr, tl, ml, dt, ks }] } (op1..op4)
 * returns Float32Array at RATE, ±1 = the 14-bit channel full scale
 */
export function renderModel(patch, midi, cents, seconds, keySeconds = seconds) {
  const { fnum, block } = midiToFnumBlock(midi + cents / 100);
  const kc = (block << 2) | (fnum >> 9 & 3);
  const n = Math.round(seconds * RATE), keyN = Math.round(keySeconds * RATE);
  const out = new Float32Array(n);
  const ops = patch.ops.map((p) => {
    const base = (fnum << block) >> 1;
    const inc = p.ml === 0 ? base >> 1 : base * p.ml;
    const ksr = kc >> (3 - (p.ks & 3));
    const rate = (r) => (r === 0 ? 0 : Math.min(63, 2 * r + ksr));
    return {
      inc, phase: 0, att: 1023, state: 0, // 0 attack, 1 decay, 2 sustain, 3 release
      ar: rate(p.ar), dr: rate(p.dr), sr: rate(p.sr), rr: Math.min(63, 4 * p.rr + 2 + ksr),
      sl: p.sl === 15 ? 1023 : p.sl << 5, tl: p.tl << 3,
    };
  });
  for (const o of ops) if (o.ar >= 62) { o.att = 0; o.state = 1; }
  const fb = patch.fb, alg = patch.alg, fbSh = 10 - fb;
  // per-operator state in locals (the hot loop touches nothing else)
  const inc = Int32Array.from(ops, (o) => o.inc), phs = new Int32Array(4);
  const att = Int32Array.from(ops, (o) => o.att), st = Int32Array.from(ops, (o) => o.state);
  const tl = Int32Array.from(ops, (o) => o.tl), sl = Int32Array.from(ops, (o) => o.sl);
  const rAr = Int32Array.from(ops, (o) => o.ar), rDr = Int32Array.from(ops, (o) => o.dr);
  const rSr = Int32Array.from(ops, (o) => o.sr), rRr = Int32Array.from(ops, (o) => o.rr);
  const c1 = alg === 1 || alg === 5, c2 = alg <= 2, c3 = alg === 0 || (alg >= 3 && alg <= 6);
  const c4a = alg === 2 || alg === 5, c4b = alg === 3, c4c = alg <= 4;
  const out1 = alg === 7, out3 = alg >= 5, out2 = alg >= 4;
  let o1a = 0, o1b = 0, s2prev = 0, egc = 0, egDiv = 0;
  let e0 = Math.min(1023, att[0] + tl[0]), e1 = Math.min(1023, att[1] + tl[1]);
  let e2 = Math.min(1023, att[2] + tl[2]), e3 = Math.min(1023, att[3] + tl[3]);
  for (let i = 0; i < n; i++) {
    if (i === keyN) st.fill(3);
    if (++egDiv === 3) { // the EG runs every third sample
      egDiv = 0; egc++;
      for (let k = 0; k < 4; k++) {
        const s = st[k], r = s === 0 ? rAr[k] : s === 1 ? rDr[k] : s === 2 ? rSr[k] : rRr[k];
        const d = egStep(r, egc);
        if (!d) continue;
        if (s === 0) {
          att[k] += (~att[k] * d) >> 4;
          if (att[k] <= 0) { att[k] = 0; st[k] = 1; }
        } else {
          att[k] = att[k] + d > 1023 ? 1023 : att[k] + d;
          if (s === 1 && att[k] >= sl[k]) st[k] = 2;
        }
      }
      e0 = Math.min(1023, att[0] + tl[0]); e1 = Math.min(1023, att[1] + tl[1]);
      e2 = Math.min(1023, att[2] + tl[2]); e3 = Math.min(1023, att[3] + tl[3]);
    }
    // the chip's order and latches (Nuked's fm_algorithm): S1, S3, S2, S4;
    // S3 hears S2 from the sample before
    const s1 = opOut((phs[0] >> 10) + (fb ? (o1a + o1b) >> fbSh : 0), e0);
    o1b = o1a; o1a = s1;
    const s3 = opOut((phs[2] >> 10) + (((c1 ? s1 : 0) + (c2 ? s2prev : 0)) >> 1), e2);
    const s2 = opOut((phs[1] >> 10) + ((c3 ? s1 : 0) >> 1), e1);
    s2prev = s2;
    const s4 = opOut((phs[3] >> 10) + (((c4a ? s1 : 0) + (c4b ? s2 : 0) + (c4c ? s3 : 0)) >> 1), e3);
    // the carriers into the 9-bit accumulator, each >> 5, clamped as it adds
    let acc = 0;
    if (out1) { acc += s1 >> 5; acc = acc > 255 ? 255 : acc < -256 ? -256 : acc; }
    if (out3) { acc += s3 >> 5; acc = acc > 255 ? 255 : acc < -256 ? -256 : acc; }
    if (out2) { acc += s2 >> 5; acc = acc > 255 ? 255 : acc < -256 ? -256 : acc; }
    acc += s4 >> 5; acc = acc > 255 ? 255 : acc < -256 ? -256 : acc;
    out[i] = acc / 256;
    phs[0] = (phs[0] + inc[0]) & 0xfffff; phs[1] = (phs[1] + inc[1]) & 0xfffff;
    phs[2] = (phs[2] + inc[2]) & 0xfffff; phs[3] = (phs[3] + inc[3]) & 0xfffff;
  }
  return out;
}
