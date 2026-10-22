// The FM voice estimate (live/src/voice-estimate.js) on a sound whose patch is
// known: a brass-like alg 2 voice rendered on the model. The search must read
// its pitch, come within a few dB of it on a short budget, and write a def-fm
// that compiles. The model itself is held to Nuked by the A/B of a sine and a
// feedback saw (exact rules, so near-zero error). No recording is kept in the
// repository.
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

if (fails.length) {
  console.error("FM voice estimate checks FAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log(`FM voice estimate checks passed: model ≡ Nuked, pitch g3, best alg ${best.patch.alg} at ${d.toFixed(2)} dB, def-fm compiles (${secs.toFixed(1)} s)`);
