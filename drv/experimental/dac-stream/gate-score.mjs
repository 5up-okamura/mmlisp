// A REAL SCORE THROUGH THE SHIPPED IMAGE, in the JS instruction model
// (R28 §63.6 step 4): the reference driver renders the slots, the host model
// (tools/pairs-model.mjs — the twin of the 68000's mmlpairs.c) turns them into
// pairs and PSG bytes twice a frame, the production image consumes them, and
// three things are graded:
//
//   * every FM register write the chip saw is the slot stream's, per port, in
//     order, and nothing else was written
//   * every DAC byte matches the one-voice reference driven by the engine's own
//     state writes, against the score's own 32 KB sample bank
//   * the clock did not move
//
//   node experimental/dac-stream/gate-score.mjs [score.mmlisp …] [--frames N]
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "../../tools/mmb-build.mjs";
import { buildEngine } from "../../tools/build-engine.mjs";
import { PairsModel, inTime, pairsCfgFromHeader } from "../../tools/pairs-model.mjs";
import { DrvPlayer } from "../../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot } from "../../../live/src/slot-builder.js";
import { PCM1, pcm1Base } from "./config.mjs";
import { Machine, traceMeta } from "./machine.mjs";
import { analyzeValue, analyzeTime, analyzeWrites, analyzeLead } from "./analyze.mjs";
import { reference, syntheticH } from "./pcm1-ref.mjs";
import { tablesAgree } from "./lut.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const argv = process.argv.slice(2);
const fIdx = argv.indexOf("--frames");
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1]) : 240;
let scores = argv.filter((a, i) => !a.startsWith("--") && !(fIdx >= 0 && i === fIdx + 1));
if (!scores.length) scores = ["tests/m2-pcm.mmlisp", "tests/m3-fm6-pcm.mmlisp", "tests/m3-pcm-vol.mmlisp",
  "tests/m3-pcm-master.mmlisp", "tests/m2-csm.mmlisp", "tests/m3-macro-multi.mmlisp", "../examples/source/demo1.mmlisp",
  "tests/m3-pcm-sync.mmlisp", "tests/sin008.mmlisp"]
  .map((s) => join(drv, s));

const LIMITS = { rateErrPct: 0.1, within5pct: 99.9, bandMin: 0.90, bandMax: 1.10 };
const engine = buildEngine();
const { cfg, header: H } = engine;
const built = { bytes: engine.bytes, symbols: engine.symbols };
const pcfg = pairsCfgFromHeader(H);
const S = (k) => pcm1Base(cfg) + PCM1[k];

function runScore(path) {
  const { bytes, sampleBank } = buildMmb(path);
  const player = new DrvPlayer();
  player.loadMMB(bytes, sampleBank);
  const ref = player.captureSlotLog({ maxFrames: FRAMES, commands: [], builder: new SlotBuilder() });
  const slots = ref.slots;
  // The bank the window shows: the score's own, or silence.
  const bank = new Uint8Array(0x8000);
  if (sampleBank) bank.set(sampleBank.subarray(0, 0x8000), 0);
  const model = new PairsModel(pcfg);
  const watch = ["level", "master", "stSrc", "stEnd", "stStep", "startGen", "stopGen"]
    .flatMap((k) => (k === "stSrc" || k === "stEnd" ? [S(k), S(k) + 1] : [S(k)]));
  const m = new Machine(cfg, built, { rom: bank, watch, vdp: syntheticH() });
  m.trace.meta = traceMeta(cfg, { case: basename(path), frames: FRAMES });
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  const half = Math.round(cfg.frameCycles / 2);
  // The host: a frame rendered at every other half-frame tick, a grab at each.
  let tick = 0, frame = 0, fifoLo = null;
  const psgOut = [];
  // Every fifth mid-frame pump is SKIPPED, as an SGDK HInt pump is when it
  // lands inside MMLisp_frame: the next grab then comes a whole frame after
  // the last, the engine is past the planned destination, and the in-grab
  // test (mmlpairs.h mmlp_in_time) must give the pairs back, not write them.
  m.host = { every: half, fn: (ram, cycle) => {
    const t = tick++;
    if (t % 2 === 0 && frame < slots.length) model.slot(slots[frame++]);
    if (t % 10 === 5) return [];
    const prev = fifoLo;
    const g = model.plan(prev);
    fifoLo = ram[S("fifoLo")];
    const writes = [];
    if (g.bytes.length && !inTime(prev, g.dst, fifoLo)) model.abort();
    else if (g.bytes.length) for (let i = 0; i < g.fill.length; i++) writes.push([g.dst + i, g.fill[i]]);
    for (const b of model.psgTake()) psgOut.push({ cycle, byte: b });
    return writes;
  } };
  m.hostNext = dac0 + half;
  // Run the frames plus a tail so the queue drains, then compare.
  m.run(dac0 + (slots.length + 12) * cfg.frameCycles);

  // ── FM writes, per port, against the slot stream ──────────────────────
  const want = [[], []];
  for (const s of slots) { const d = decodeSlot(s); for (const [r, v] of d.fm0) want[0].push({ reg: r, val: v }); for (const [r, v] of d.fm1) want[1].push({ reg: r, val: v }); }
  const seen = [[], []];
  for (const [cycle, port, reg, val] of m.trace.ym) if (cycle >= dac0) seen[port].push({ reg, val });
  const fails = [];
  for (const p of [0, 1]) {
    if (seen[p].length !== want[p].length)
      fails.push(`WRITES port ${p}: the chip saw ${seen[p].length} writes, the score has ${want[p].length}`);
    for (let i = 0; i < Math.min(seen[p].length, want[p].length); i++) {
      const a = seen[p][i], b = want[p][i];
      if (a.reg !== b.reg || a.val !== b.val) {
        fails.push(`WRITES port ${p}, write ${i}: chip saw $${a.reg.toString(16)}=$${a.val.toString(16)},`
          + ` the score says $${b.reg.toString(16)}=$${b.val.toString(16)}`);
        break;
      }
    }
  }
  // ── PSG bytes, in order ───────────────────────────────────────────────
  const psgWant = slots.flatMap((s) => decodeSlot(s).psg);
  if (psgOut.length !== psgWant.length) fails.push(`PSG: ${psgOut.length} bytes written, the score has ${psgWant.length}`);
  for (let i = 0; i < Math.min(psgOut.length, psgWant.length); i++)
    if (psgOut[i].byte !== psgWant[i]) { fails.push(`PSG byte ${i}: ${psgOut[i].byte} for ${psgWant[i]}`); break; }
  // ── the DAC, against the reference driven by the engine's state writes ─
  const events = [];
  const st = { src: 0, end: 0, step: 1, sgen: 0, pgen: 0 };
  for (const [cycle, addr, val] of m.trace.globWrite) {
    const off = addr - pcm1Base(cfg);
    if (off === PCM1.stSrc) st.src = (st.src & 0xff00) | val;
    else if (off === PCM1.stSrc + 1) st.src = (st.src & 0xff) | (val << 8);
    else if (off === PCM1.stEnd) st.end = (st.end & 0xff00) | val;
    else if (off === PCM1.stEnd + 1) st.end = (st.end & 0xff) | (val << 8);
    else if (off === PCM1.stStep) st.step = val;
    else if (off === PCM1.startGen && val !== st.sgen) { st.sgen = val; events.push({ kind: "start", at: cycle, src: st.src, end: st.end, step: st.step, seq: events.length }); }
    else if (off === PCM1.stopGen && val !== st.pgen) { st.pgen = val; events.push({ kind: "stop", at: cycle, seq: events.length }); }
  }
  const lutPage = cfg.ram.lut[0] >> 8;
  const edges = [];
  const reads = m.trace.globRead.filter(([, a]) => a === S("level") || a === S("master"));
  for (let i = 0; i + 1 < reads.length; i += 2) edges.push({ cycle: reads[i][0], v0: reads[i][2] - lutPage, master: reads[i + 1][2] - lutPage });
  const refFn = reference(cfg, bank, events, m.trace.dacCycle, edges);
  if (process.env.GATE_DEBUG) {
    console.log("dac", m.trace.dacValue.slice(0, 48).join(","));
    console.log("ref", Array.from({ length: 48 }, (_, i) => refFn(i)).join(","));
    console.log("events", events.slice(0, 4), "edges", edges.slice(0, 4), "dac0", dac0);
  }
  const value = analyzeValue(m.trace, refFn);
  const time = analyzeTime(m.trace, cfg);
  const settle = analyzeWrites(m.trace, cfg);
  const lead = analyzeLead(m.trace, cfg, [built.symbols.get("mix_one"), built.symbols.get("xp_a")]);
  if (value.problems.length) fails.push(...value.problems.map((p) => `VALUE ${p}`));
  if (lead?.problems.length) fails.push(...lead.problems.slice(0, 2).map((p) => `LEAD ${p}`));
  if (settle.problems.length) fails.push(...settle.problems.slice(0, 3).map((p) => `SETTLE ${p}`));
  for (const p of tablesAgree(cfg.levels, { signed: true }).slice(0, 2)) fails.push(`TABLE ${p}`);
  if (Math.abs(time.rateErrPct) > LIMITS.rateErrPct) fails.push(`TIME mean rate ${time.meanRateHz} Hz is ${time.rateErrPct}% off`);
  if (time.within5pct < LIMITS.within5pct) fails.push(`TIME ${time.within5pct}% inside 0.95T..1.05T`);
  if (time.gapMin < cfg.periodCycles * LIMITS.bandMin || time.gapMax > cfg.periodCycles * LIMITS.bandMax) fails.push(`TIME interval range ${time.gapMin}..${time.gapMax}`);
  if (time.holes.length) fails.push(`TIME ${time.holes.length} hole(s)`);
  if (m.trace.stray.length) fails.push(`STRAY ${m.trace.stray.length} writes outside every device`);
  const dacOn = m.trace.dacValue.filter((v) => v !== 0x80).length;
  // ── SYNC: each PCM start's first sound against the nearest fm1 key-on ──
  // (a score that keys fm1 on the beats its PCM starts on, like
  // tests/m3-pcm-sync.mmlisp). Reported in ms; + means the drum is late.
  const keyOns = m.trace.ym.filter(([c, port, reg, val]) => c >= dac0 && port === 0 && reg === 0x28 && (val & 7) === 0 && (val & 0xf0)).map(([c]) => c);
  const sync = [];
  if (keyOns.length) for (const e of events.filter((x) => x.kind === "start")) {
    const i = m.trace.dacCycle.findIndex((c, k) => c > e.at && m.trace.dacValue[k] !== 0x80);
    if (i < 0) continue;
    const t = m.trace.dacCycle[i];
    const k = keyOns.reduce((b, c) => (Math.abs(c - t) < Math.abs(b - t) ? c : b), keyOns[0]);
    sync.push(((t - k) * cfg.machine.z80Div / cfg.machine.masterHz) * 1000);
  }
  // Graded only on the sync score: its first hit shares a slot with fm1's
  // first voice load, which the key-on waits behind.
  if (basename(path) === "m3-pcm-sync.mmlisp") {
    const off = sync.slice(1).filter((x) => x < -2 || x > 5);
    if (off.length) fails.push(`SYNC ${off.length} PCM onsets outside -2..+5 ms of their key-on: ${off.map((x) => x.toFixed(1)).join(" ")}`);
  }
  return { fails, time, seen, want, psg: psgOut.length, events, model, dacOn, slots: slots.length, sync };
}

let failed = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const score of scores) {
  const r = runScore(score);
  if (r.fails.length) failed++;
  console.log(`${r.fails.length ? "FAIL" : "ok  "}  ${pad(basename(score, ".mmlisp"), 20)} ${r.slots} frames ·`
    + ` ${r.time.meanRateHz} Hz (${r.time.rateErrPct >= 0 ? "+" : ""}${r.time.rateErrPct}%) gap ${r.time.gapMin}..${r.time.gapMax}`
    + ` · FM ${r.seen[0].length}+${r.seen[1].length} of ${r.want[0].length}+${r.want[1].length} · PSG ${r.psg}`
    + ` · ${r.events.length} PCM events, ${r.dacOn} non-silent DAC bytes · ${r.model.pairsWritten} pairs, ${r.model.grabs} grabs (${r.model.late} late)`
    + (r.model.droppedVoice ? ` · ${r.model.droppedVoice} voice>0 dropped` : "") + (r.model.stepRounded ? ` · ${r.model.stepRounded} steps rounded` : ""));
  if (r.sync.length && /m3-pcm-sync/.test(score)) console.log(`      SYNC pcm vs fm1 key-on: ${r.sync.map((x) => x.toFixed(1)).join(" ")} ms`);
  for (const f of r.fails.slice(0, 6)) console.log(`      ! ${f}`);
}
console.log(`\n${failed ? `FAIL: ${failed} of ${scores.length} scores` : `${scores.length} scores pass`} · ${FRAMES} frames each · image ${engine.bytes.length} B, ${cfg.stamp}`);
process.exit(failed ? 1 : 0);
