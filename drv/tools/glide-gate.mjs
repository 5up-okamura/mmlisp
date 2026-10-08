// Glide gate — a glide longer than its note slides on from where the pitch is
// (language.md §14).
//
// The two players can agree and both be wrong here (ab-gate only sees them
// diverge), so this checks the driver's own output against the rule, at
// every key-on frame of tests/m4-glide-lag and tests/m4-csm-glide:
//
//   **a gliding note** — the pitch (fm1) or Timer A period (fm3-csm-rate)
//   does not jump across the key-on: it moves no more than a glide's steps
//   over the frames around it. Before the rule, each note restarted from the
//   previous note's WRITTEN pitch, several semitones away.
//   **a note that does not glide** while a glide still runs — it starts at
//   its own pitch (with the sticky `:pitch` offset), or its own rate: the
//   running glide ended there and does not bleed on.
//
//   node tools/glide-gate.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { midiToFnumBlock, pitchToMidi, csmTimerPeriod } from "../../live/src/ir-utils.js";

const here = dirname(fileURLToPath(import.meta.url));
const tests = join(here, "..", "tests");

// Largest move across a key-on (frame before → frame after) that still reads
// as a slide: pitch in semitones, Timer A in period steps. A glide here moves
// at most ~0.2 semitone / ~3 period steps a frame; the jumps this catches were
// 3+ semitones and tens of steps.
const MAX_PITCH_MOVE = 0.5;
const MAX_PERIOD_MOVE = 8;
const SETTLE_TOL = 0.05; // semitones (F-number resolution)

function compile(file) {
  const { ir, diagnostics } = compileMMLisp(readFileSync(file, "utf8"), file);
  const errs = diagnostics.filter((d) => d.severity === "error");
  if (errs.length) throw new Error(`${file}: ${errs.map((d) => d.message).join("; ")}`);
  return ir;
}

function capture(ir, frames) {
  const { bytes } = encodeMmb(ir);
  const drv = new DrvPlayer();
  drv.loadMMB(bytes);
  return drv.captureRegisterLog({ maxFrames: frames }).writes;
}

// Per-frame value of a register pair, held between writes.
function perFrame(writes, frames, hiAddr, loAddr, decode) {
  const out = new Array(frames).fill(null);
  // The driver writes only what changed, so either half alone moves it.
  let hi = null;
  let lo = null;
  let cur = null;
  let i = 0;
  for (let f = 0; f < frames; f++) {
    for (; i < writes.length && writes[i].frame <= f; i++) {
      const w = writes[i];
      if (w.port !== 0) continue;
      if (w.addr === hiAddr) hi = w.data;
      else if (w.addr === loAddr) lo = w.data;
      else continue;
      if (hi !== null && lo !== null) cur = decode(hi, lo);
    }
    out[f] = cur;
  }
  return out;
}

const C4 = (() => {
  const { fnum, block } = midiToFnumBlock(60);
  return fnum * 2 ** block;
})();
const fmPitch = (hi, lo) =>
  60 + 12 * Math.log2(((((hi & 7) << 8) | lo) * 2 ** ((hi >> 3) & 7)) / C4);
const timerA = (hi, lo) => (hi << 2) | (lo & 3);
const periodOf = (hz) => Math.max(0, Math.min(1023, Math.round(csmTimerPeriod(hz))));

// The IR events of a track grouped by tick, and the frame a tick lands on.
function byTick(track) {
  const m = new Map();
  for (const e of track.events) {
    if (!m.has(e.tick)) m.set(e.tick, []);
    m.get(e.tick).push(e);
  }
  return m;
}
function frameOf(ir) {
  const tempo = ir.tracks.flatMap((t) => t.events).filter((e) => e.cmd.startsWith("TEMPO"));
  if (tempo.length !== 1) throw new Error("glide-gate scores keep one constant tempo");
  const bpm = tempo[0].args.bpm;
  return (tick) => Math.round((tick * 3600) / (bpm * ir.ppqn));
}

const failures = [];
const counts = { glide: 0, settle: 0, rateGlide: 0, rateSettle: 0 };
const fail = (where, msg) => failures.push(`${where}: ${msg}`);

{
  const file = join(tests, "m4-glide-lag.mmlisp");
  const ir = compile(file);
  const at = frameOf(ir);
  const fm1 = ir.tracks.find((t) => t.channel === "fm1");
  const ticks = byTick(fm1);
  const end = at(Math.max(...ticks.keys())) + 4;
  const pitch = perFrame(capture(ir, end), end, 0xa4, 0xa0, fmPitch);
  for (const [tick, evs] of ticks) {
    const note = evs.find((e) => e.cmd === "NOTE_ON");
    if (!note || tick === 0) continue;
    const f = at(tick);
    const glide = evs.find((e) => e.cmd === "PARAM_SWEEP" && e.args.bounded);
    const set = evs.find((e) => e.cmd === "PARAM_SET" && e.args.target === "NOTE_PITCH");
    const where = `m4-glide-lag fm1 tick ${tick} (${note.args.pitch})`;
    if (glide) {
      counts.glide++;
      const move = Math.abs(pitch[f + 1] - pitch[f - 1]);
      if (!(move <= MAX_PITCH_MOVE))
        fail(where, `pitch jumps ${move.toFixed(2)} semitones across the key-on`);
    } else if (set) {
      counts.settle++;
      const want = pitchToMidi(note.args.pitch) + set.args.value / 100;
      if (!(Math.abs(pitch[f + 1] - want) <= SETTLE_TOL))
        fail(where, `starts at ${pitch[f + 1]?.toFixed(2)}, not its own ${want.toFixed(2)}`);
    }
  }
}

{
  const file = join(tests, "m4-csm-glide.mmlisp");
  const ir = compile(file);
  const at = frameOf(ir);
  const rate = ir.tracks.flatMap((t) => t.events)
    .filter((e) => e.cmd === "CSM_RATE" && e.args.run === undefined); // not a rest's stop
  const end = at(Math.max(...rate.map((e) => e.tick))) + 4;
  const ta = perFrame(capture(ir, end), end, 0x24, 0x25, timerA);
  for (const e of rate) {
    if (e.tick === 0) continue;
    const f = at(e.tick);
    const where = `m4-csm-glide rate tick ${e.tick}`;
    if (e.args.hz === undefined) {
      counts.rateGlide++;
      const move = Math.abs(ta[f + 1] - ta[f - 1]);
      if (!(move <= MAX_PERIOD_MOVE))
        fail(where, `Timer A jumps ${move} steps across the rate note`);
    } else if (rate.some((p) => p.tick < e.tick && p.args.len && p.tick + p.args.len > e.tick)) {
      counts.rateSettle++;
      if (ta[f + 1] !== periodOf(e.args.hz))
        fail(where, `Timer A ${ta[f + 1]}, not its own ${periodOf(e.args.hz)} (${e.args.hz} Hz)`);
    }
  }
}

// The scores must exercise both halves of the rule on both paths.
for (const [k, n] of Object.entries(counts)) if (n === 0) fail("coverage", `no ${k} case checked`);

if (failures.length) {
  console.log("glide-gate: FAIL");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(
  `glide-gate: ok (${counts.glide} glides, ${counts.settle} settled notes; ` +
    `${counts.rateGlide} rate glides, ${counts.rateSettle} settled rates)`,
);
