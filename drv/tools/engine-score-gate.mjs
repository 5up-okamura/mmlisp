// REAL SCORES THROUGH THE LIGHT ENGINE IMAGES, in the JS instruction model
// (docs/driver.md §12.4): the reference driver renders the
// frames, the host model (tools/pairs-model.mjs — the twin of the 68000's
// mmlpairs.c) turns them into pairs and PSG bytes once a frame, the score's
// engine image (pcm1/pcm2/pcm3, from the MMB header) consumes them, and five
// things are graded:
//
//   WRITES  every FM register write the chip saw is the frames', per port,
//           in order, and nothing else; the chip's settling table holds
//   PSG     every PSG byte, in order
//   VALUE   every DAC byte equals live/src/pcm-model.js driven by the pairs the
//           expander actually consumed, in the slots it consumed them
//   TIME    every DAC interval is its slot's length: the clock did not move
//   SYNC    on m3-pcm-sync, each PCM onset against the fm1 key-on it goes with
//   LATENCY every START command, from its frame to the voice starting, within
//           LATENCY_MAX frames — a start must not wait behind the FM backlog
//
//   node tools/engine-score-gate.mjs [score.mmlisp …] [--frames N]
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { buildLightImage } from "./build-engine.mjs";
import { FrameRecorder, MMLP_AHEAD_ONE, PairsModel, inTime, pairsCfgForImage, recordPcm, recordWrites } from "./pairs-model.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { headerPcmVoices } from "../../live/src/mmb.js";
import { PcmEngineModel, PCM_SILENCE_BYTE } from "../../live/src/pcm-model.js";
import { Machine, traceMeta } from "./machine.mjs";
import { analyzeTime, analyzeWrites } from "../engine/analyze.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const fIdx = argv.indexOf("--frames");
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1]) : 240;
let scores = argv.filter((a, i) => !a.startsWith("--") && !(fIdx >= 0 && i === fIdx + 1));
if (!scores.length) scores = ["tests/m2-pcm.mmlisp", "tests/m4-fm6-only.mmlisp", "tests/m3-pcm-vol.mmlisp",
  "tests/m3-pcm-master.mmlisp", "tests/m3-pcm-softmix.mmlisp", "tests/m3-pcm-volmix.mmlisp",
  "tests/m3-pcm-slice.mmlisp", "tests/m2-csm.mmlisp", "tests/m3-macro-multi.mmlisp",
  "tests/m3-pcm-sync.mmlisp", "sgdk/example/demo.mmlisp",
  "tests/m4-pcm-loop.mmlisp", "tests/m4-pcm-2v-master.mmlisp", "tests/m4-pcm-3v.mmlisp", "tests/m4-pcm-loop-curve.mmlisp", "tests/m4-pcm-loop-mode.mmlisp"]
  .map((s) => join(drv, s));

// The bound on LATENCY, in frames. A start's own path is about two (the frame,
// the grab, the head's lead over the engine's read index); three voices starting
// in one frame queue behind each other's pairs (m4-pcm-3v, 3.8). Behind a
// burst's FM backlog, before the PCM lane, a start waited 8-10.
const LATENCY_MAX = 4;

const images = new Map();
const imageFor = (voices) => {
  if (!images.has(voices)) images.set(voices, buildLightImage(voices));
  return images.get(voices);
};

function runScore(path) {
  const { bytes, sampleBank } = buildMmb(path);
  const pcmVoices = headerPcmVoices(bytes[6] | (bytes[7] << 8));
  const built = imageFor(Math.max(1, pcmVoices));
  const { cfg, descriptor: desc } = built;
  const player = new DrvPlayer();
  player.loadMMB(bytes, sampleBank);
  // The frames the SGDK host takes: every write in the sequencer's order, uncapped.
  const frames = player.captureSlotLog({ maxFrames: FRAMES, commands: [], builder: new FrameRecorder() }).slots;
  // The bank the window shows: the score's own, or silence.
  const bank = new Uint8Array(0x8000);
  if (sampleBank) bank.set(sampleBank.subarray(0, 0x8000), 0);
  const model = new PairsModel({ ...pairsCfgForImage(desc), ahead: MMLP_AHEAD_ONE });
  const fifoAddrs = Array.from({ length: 256 }, (_, i) => desc.fifo + i);
  const m = new Machine(cfg, { bytes: built.bytes, symbols: built.symbols }, { rom: bank, watch: fifoAddrs });
  m.trace.meta = traceMeta(cfg, { case: basename(path), frames: FRAMES });
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  const frameCycles = Math.round(cfg.frameCycles);
  // The host (driver.md §6.6): one frame rendered and ONE grab of sixteen pairs
  // a frame, from the vertical interrupt. Every eighth grab is SKIPPED, as the
  // VBlank pump is when the main loop overruns: the next grab then comes two
  // frames after the last, and the in-grab test (mmlpairs.h mmlp_in_time) must
  // give the pairs back, not write them.
  let tick = 0, frame = 0, fifoLo = null;
  const psgOut = [];
  m.host = { every: frameCycles, fn: (ram, cycle) => {
    const t = tick++;
    if (frame < frames.length) model.frame(frames[frame++]);
    if (t % 8 === 7) return [];
    const prev = fifoLo;
    const g = model.plan(prev);
    fifoLo = ram[desc.fifoLo];
    const writes = [];
    if (g.bytes.length && !inTime(prev, g.dst, fifoLo)) model.abort();
    else if (g.bytes.length) for (let i = 0; i < g.fill.length; i++) writes.push([g.dst + i, g.fill[i]]);
    for (const b of model.psgTake()) psgOut.push({ cycle, byte: b });
    return writes;
  } };
  m.hostNext = dac0 + frameCycles;
  // Run the frames plus a tail so the queue drains, then compare.
  m.run(dac0 + (frames.length + 12) * cfg.frameCycles);
  const fails = [];
  const dac = m.trace.dacCycle, n = dac.length;

  // ── WRITES: FM per port against the frames ──────────────────────────
  // The DAC enable ($2B) rides the PCM lane (mmlpairs.h), ahead of the FM
  // queue, so it is held to its own order: list 2.
  const want = [[], [], []];
  for (const f of frames) {
    const d = recordWrites(f);
    for (const [r, v] of d.fm0) want[r === 0x2b ? 2 : 0].push({ reg: r, val: v });
    for (const [r, v] of d.fm1) want[1].push({ reg: r, val: v });
  }
  const seen = [[], [], []];
  for (const [cycle, port, reg, val] of m.trace.ym) if (cycle >= dac0) seen[port === 0 && reg === 0x2b ? 2 : port].push({ reg, val });
  for (const p of [0, 1, 2]) {
    if (seen[p].length !== want[p].length)
      fails.push(`WRITES ${p === 2 ? "$2B" : `port ${p}`}: the chip saw ${seen[p].length} writes, the score has ${want[p].length}`);
    for (let i = 0; i < Math.min(seen[p].length, want[p].length); i++) {
      const a = seen[p][i], b = want[p][i];
      if (a.reg !== b.reg || a.val !== b.val) {
        fails.push(`WRITES ${p === 2 ? "$2B" : `port ${p}`}, write ${i}: chip saw $${a.reg.toString(16)}=$${a.val.toString(16)},`
          + ` the score says $${b.reg.toString(16)}=$${b.val.toString(16)}`);
        break;
      }
    }
  }
  const settle = analyzeWrites(m.trace, cfg);
  if (settle.problems.length) fails.push(...settle.problems.slice(0, 3).map((p) => `WRITES ${p}`));
  if (m.trace.stray.length) fails.push(`STRAY ${m.trace.stray.length} writes outside every device`);
  if (model.fault) fails.push(`PAIRS ${model.fault} PCM commands for a voice the image does not have`);

  // ── PSG bytes, in order ───────────────────────────────────────────────
  const psgWant = frames.flatMap((f) => recordWrites(f).psg);
  if (psgOut.length !== psgWant.length) fails.push(`PSG: ${psgOut.length} bytes written, the score has ${psgWant.length}`);
  for (let i = 0; i < Math.min(psgOut.length, psgWant.length); i++)
    if (psgOut[i].byte !== psgWant[i]) { fails.push(`PSG byte ${i}: ${psgOut[i].byte} for ${psgWant[i]}`); break; }

  // ── VALUE: the model, fed the pairs the expander read ─────────────────
  const slotOf = (cycle) => {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (dac[mid] <= cycle) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const consumed = new Map();
  for (const [cycle, addr, val] of m.trace.globRead) {
    if (cycle < dac0) continue;
    const s = slotOf(cycle);
    if (s >= n - 1) continue;                     // the last slot is cut off by the end of the run
    if (!consumed.has(s)) consumed.set(s, [null, null]);
    consumed.get(s)[(addr - desc.fifo) & 1] = val;
  }
  const pcm = new PcmEngineModel(desc, bank);
  let valueFails = 0;
  for (let s = 0; s < n; s++) {
    const expect = pcm.slot(consumed.get(s) ?? null);
    if (m.trace.dacValue[s] !== expect && valueFails++ < 2)
      fails.push(`VALUE slot ${s}: DAC ${m.trace.dacValue[s]}, model ${expect}`);
  }
  if (valueFails > 2) fails.push(`VALUE ${valueFails} bytes differ in all`);

  // ── TIME ──────────────────────────────────────────────────────────────
  const time = analyzeTime(m.trace, cfg);
  if (time.gapMin !== Math.floor(cfg.periodCycles) || time.gapMax !== Math.ceil(cfg.periodCycles))
    fails.push(`TIME intervals ${time.gapMin}..${time.gapMax}, the slot is ${cfg.periodCycles}`);
  if (Math.abs(time.rateErrPct) > 0.001) fails.push(`TIME rate ${time.meanRateHz} Hz (${time.rateErrPct}%)`);

  // ── SYNC: each PCM start's first sound against the nearest fm1 key-on ──
  // (a score that keys fm1 on the beats its PCM starts on, like
  // tests/m3-pcm-sync.mmlisp). Reported in ms; + means the drum is late.
  const dacOn = m.trace.dacValue.filter((v) => v !== PCM_SILENCE_BYTE).length;
  const keyOns = m.trace.ym.filter(([c, port, reg, val]) => c >= dac0 && port === 0 && reg === 0x28
    && (val & 7) === 0 && (val & 0xf0)).map(([c]) => c);
  const starts = pcm.log.filter((e) => e.kind === "start").map((e) => e.slot);
  const sync = [];
  if (keyOns.length) for (const s0 of starts) {
    let i = s0 + desc.lead;
    while (i < n && m.trace.dacValue[i] === PCM_SILENCE_BYTE) i++;
    if (i >= n) continue;
    const t = dac[i];
    const k = keyOns.reduce((b, c) => (Math.abs(c - t) < Math.abs(b - t) ? c : b), keyOns[0]);
    sync.push(((t - k) * cfg.machine.z80Div / cfg.machine.masterHz) * 1000);
  }
  // ── LATENCY: each START command, from its frame to the voice starting ──
  // The frame's host tick (the slot is taken in at tick f, which runs at
  // dac0 + (f + 1) frames) to the DAC slot the engine applied the start in,
  // matched per voice in order. A start that waits behind other pairs shows
  // up here and nowhere else: every other check grades WHAT was played.
  const cmds = Array.from({ length: desc.voices }, () => []);
  frames.forEach((r, f) => { for (const x of recordPcm(r)) if (x[0] === 1 && x[1] < desc.voices) cmds[x[1]].push(f); });
  const applied = Array.from({ length: desc.voices }, () => []);
  for (const e of pcm.log) if (e.kind === "start") applied[e.v].push(e.slot);
  const latency = [];
  for (let v = 0; v < desc.voices; v++) {
    if (applied[v].length !== cmds[v].length)
      fails.push(`LATENCY voice ${v}: ${cmds[v].length} START commands, the engine started ${applied[v].length} times`);
    for (let k = 0; k < Math.min(cmds[v].length, applied[v].length); k++)
      latency.push((dac[applied[v][k]] - (dac0 + (cmds[v][k] + 1) * cfg.frameCycles)) / cfg.frameCycles);
  }
  const late = latency.filter((x) => x > LATENCY_MAX);
  if (late.length) fails.push(`LATENCY ${late.length} starts later than ${LATENCY_MAX} frames: ${late.map((x) => x.toFixed(2)).join(" ")}`);
  if (basename(path) === "m3-pcm-sync.mmlisp") {
    const off = sync.slice(1).filter((x) => x < -2 || x > 5);
    if (off.length) fails.push(`SYNC ${off.length} PCM onsets outside -2..+5 ms of their key-on: ${off.map((x) => x.toFixed(1)).join(" ")}`);
  }
  return { fails, time, seen, want, psg: psgOut.length, starts: starts.length, model, dacOn,
    slots: frames.length, sync, desc, latency };
}

let failed = 0;
const pad = (s, k) => String(s).padEnd(k);
for (const score of scores) {
  const r = runScore(score);
  if (r.fails.length) failed++;
  console.log(`${r.fails.length ? "FAIL" : "ok  "}  ${pad(basename(score, ".mmlisp"), 20)} pcm${r.desc.voices} ${r.slots} frames ·`
    + ` ${r.time.meanRateHz} Hz gap ${r.time.gapMin}..${r.time.gapMax}`
    + ` · FM ${r.seen[0].length + r.seen[2].length}+${r.seen[1].length} of ${r.want[0].length + r.want[2].length}+${r.want[1].length} · PSG ${r.psg}`
    + ` · ${r.starts} PCM starts, ${r.dacOn} sounding DAC bytes · ${r.model.pairsWritten} pairs, ${r.model.grabs} grabs (${r.model.late} late)`);
  if (r.latency.length) {
    const worst = Math.max(...r.latency), mean = r.latency.reduce((a, b) => a + b, 0) / r.latency.length;
    console.log(`      LATENCY start command → voice started: mean ${mean.toFixed(2)}, worst ${worst.toFixed(2)} frames over ${r.latency.length}`);
  }
  if (r.sync.length && /m3-pcm-sync/.test(score)) console.log(`      SYNC pcm vs fm1 key-on: ${r.sync.map((x) => x.toFixed(1)).join(" ")} ms`);
  for (const f of r.fails.slice(0, 6)) console.log(`      ! ${f}`);
}
console.log(`\n${failed ? `FAIL: ${failed} of ${scores.length} scores` : `${scores.length} scores pass`} · ${FRAMES} frames each`
  + ` · images ${[...images.values()].map((b) => `pcm${b.descriptor.voices} ${b.descriptor.stamp}`).join(", ")}`);
process.exit(failed ? 1 : 0);
