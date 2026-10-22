// The FM voice estimate (live/src/voice-estimate.js) on a sound whose patch is
// known: a brass-like alg 2 voice rendered on the model. The search must read
// its pitch, come within a few dB of it on a short budget, and write a def-fm
// that compiles. The model itself is held to Nuked by the A/B of a sine and a
// feedback saw (exact rules, so near-zero error). No recording is kept in the
// repository. A hiss must be read as a noise and come out with its note as
// :key.
import { renderModel, RATE } from "../../live/src/fm-model.js";
import { estimateVoice, features, distance, patchToDef, patchToRegs } from "../../live/src/voice-estimate.js";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import createNukedModule from "../../live/nuked-opn2.js";
import { midiToFnumBlock, OP_ADDR_OFFSET } from "../../live/src/ir-utils.js";

const op = (o) => ({ ar: 31, dr: 0, sr: 0, sl: 0, rr: 7, tl: 0, ml: 1, dt: 0, ks: 0, ...o });
const fails = [];

// the model against the chip, on two patches whose rules are exact
const ym = await createNukedModule();
ym._nopn_init();
const chPtr = ym._nopn_get_channel_buffer_ptr();
function chip(patch, midi, secs) {
  const w = (a, d) => ym._nopn_write_reg(0, a, d);
  ym._nopn_reset();
  for (let o = 0; o < 4; o++) {
    const p = patch.ops[o], off = OP_ADDR_OFFSET[o];
    w(0x30 + off, p.ml); w(0x40 + off, p.tl); w(0x50 + off, (p.ks << 6) | p.ar);
    w(0x60 + off, p.dr); w(0x70 + off, p.sr); w(0x80 + off, (p.sl << 4) | p.rr);
  }
  w(0xb0, (patch.fb << 3) | patch.alg); w(0xb4, 0xc0);
  const { fnum, block } = midiToFnumBlock(midi);
  w(0xa4, (block << 3) | (fnum >> 8)); w(0xa0, fnum & 0xff); w(0x28, 0xf0);
  const n = Math.round(secs * RATE), out = new Float32Array(n);
  for (let i = 0; i < n; i += 4096) {
    const k = Math.min(4096, n - i); ym._nopn_render(k);
    const h = new Int16Array(ym.HEAP16.buffer, chPtr, k * 6);
    for (let j = 0; j < k; j++) out[i + j] = h[j * 6] / 256;
  }
  return out;
}
for (const [name, p] of [
  ["sine", { alg: 7, fb: 0, ops: [op({ tl: 127 }), op({ tl: 127 }), op({ tl: 127 }), op({})] }],
  ["feedback saw", { alg: 7, fb: 6, ops: [op({}), op({ tl: 127 }), op({ tl: 127 }), op({ tl: 127 })] }],
]) {
  const d = distance(features(chip(p, 57, 0.4)), features(renderModel(p, 57, 0, 0.4)));
  if (d > 1) fails.push(`model vs Nuked, ${name}: ${d.toFixed(2)} dB`);
}

// the search on a known patch
const truth = { alg: 2, fb: 4, ops: [op({ ar: 18, tl: 32 }), op({ ar: 20, tl: 40, ml: 2 }), op({ ar: 16, tl: 30, dr: 4, sl: 3 }), op({ ar: 20, dr: 3, sl: 2 })] };
const x = renderModel(truth, 55, 0, 0.6);
const t0 = performance.now();
const r = estimateVoice(x, RATE, { stage1: 120, stage2: 300, ils: 300 });
const secs = (performance.now() - t0) / 1000;
if (r.pitch.midi !== 55 || Math.abs(r.pitch.cents) > 10) fails.push(`pitch ${r.pitch.midi} ${r.pitch.cents}¢ for 55`);
if (r.candidates.length !== 3) fails.push(`${r.candidates.length} candidates for 3`);
const best = r.candidates[0];
const dur = r.target.length / RATE;
const d = distance(features(r.target), features(renderModel(best.patch, r.pitch.midi, r.pitch.cents, dur, dur)));
if (d > 4) fails.push(`best candidate ${d.toFixed(2)} dB from the known patch`);
const def = patchToDef(best.patch, "brass.wav", r.pitch, "brass.wav");
const c = compileMMLisp(`${def}\n(fm1 brass c)`, "check.mmlisp");
const errs = c.diagnostics.filter((x) => x.severity === "error");
if (errs.length) fails.push(`def-fm: ${errs.map((e) => e.code + " " + e.message).join("; ")}`);
const regs = patchToRegs(best.patch);
if (regs.ops.length !== 4 || regs.algorithm !== best.patch.alg) fails.push("regs");

// a noise: no pitch read, the note searched, the voice written with :key
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
const hiss = Float32Array.from({ length: Math.round(0.15 * RATE) }, (_, i) => rnd() * Math.exp(-i / (0.04 * RATE)) * 0.5);
const n = estimateVoice(hiss, RATE, { stage1: 80, stage2: 120, ils: 120 });
if (!n.noisy) fails.push(`a hiss read as pitched (clarity ${n.pitch.clarity.toFixed(2)})`);
const nb = n.candidates[0];
const ndef = patchToDef(nb.patch, "hiss.wav", nb.note, "hiss.wav", n.noisy);
if (!/ :key \d+/.test(ndef)) fails.push("a noise's def-fm has no :key");
const nc = compileMMLisp(`${ndef}\n(fm1 hiss c)`, "check.mmlisp");
if (nc.diagnostics.some((x) => x.severity === "error")) fails.push("a noise's def-fm does not compile");

if (fails.length) {
  console.error("FM voice estimate checks FAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log(`FM voice estimate checks passed: model ≡ Nuked, pitch g3, best alg ${best.patch.alg} at ${d.toFixed(2)} dB, def-fm compiles; a hiss read as a noise, its voice at :key ${nb.note.midi} (${secs.toFixed(1)} s)`);
