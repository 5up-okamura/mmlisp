// THE N-VOICE PROFILE'S GATE, in the JS instruction model (the D1/D4 study).
//
//   node experimental/dac-stream/gate-nv.mjs [--voices N] [--period P] [--step-voices K]
//                                            [--seconds S] [--case NAME]
//
// Runs a voice-study point (voice-study.mjs pointConfig) — the split image with
// the decode, the corrector and the protocol placed — in tools/machine.mjs and
// grades two things the placement cannot:
//
//   TIME   every DAC interval is the slot's length. A mis-costed instruction in
//          the mix or an edge piece moves the interval, so this is what proves
//          the study's cycle figures rather than repeating them.
//   VALUE  every DAC byte equals a reference written from the edge semantics
//          alone — each voice's block state (pointer, step, END, park) at its
//          own block phase, its rung page from the level byte its PARK read,
//          and sat(sat(v0 + v1) + v2) from the rung arithmetic — reading
//          nothing of the engine's state and none of its tables.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, PCMN, pcm1Base, PCM1_SILENCE } from "../../engine/config.mjs";
import { generateSplit } from "../../engine/decode-split.mjs";
import { mixRungs, rungsAgree, SILENCE } from "../../engine/lut.mjs";
import { analyzeValue, analyzeTime } from "../../engine/analyze.mjs";
import { syntheticH } from "../../engine/pcm1-ref.mjs";
import { assemble } from "../../tools/z80asm.mjs";
import { Machine } from "../../tools/machine.mjs";
import { pointConfig } from "./voice-study.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "out", "dac-stream");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 3));
const ONLY = arg("case", null);
// The gate's own negatives: an uncosted instruction in the mix (TIME has to
// fail) and a reference that wraps instead of saturating (VALUE has to fail on
// the clipping case). A gate that has never failed proves nothing.
const FAULT = arg("fault", null);

// ── The bank: SIGNED bytes, silence is 0, the top page is silence ──────────
const BANK = new Uint8Array(0x8000);
const SAMPLES = {};
let cursor = 0x0100;
function place(name, values) {
  SAMPLES[name] = { at: 0x8000 + cursor, bytes: values.length };
  values.forEach((v, i) => { BANK[cursor + i] = v & 0xff; });
  cursor += values.length + 64;
}
place("sine", Array.from({ length: 1500 }, (_, i) => Math.round(120 * Math.sin(2 * Math.PI * i / 90))));
place("saw", Array.from({ length: 2000 }, (_, i) => ((i * 5) % 256) - 128));
place("square", Array.from({ length: 1200 }, (_, i) => ((i >> 4) & 1 ? 127 : -128)));
place("ramp", Array.from({ length: 700 }, (_, i) => ((i * 3) & 0xff) - 128));
place("short", Array.from({ length: 48 }, (_, i) => 100 - i * 4));
if (cursor > PCM1_SILENCE - 0x8000) throw new Error("the samples reach the silence page");

// ── The host: pokes at each voice's mid-block, far from its edge slots ─────
function hostScript(kind, cfg, cycles) {
  const B = cfg.blockSamples, T = cfg.periodCycles, lead = cfg.lead;
  const S = (key, v) => pcm1Base(cfg) + (typeof PCMN[key] === "function" ? PCMN[key](v) : PCMN[key]);
  const lutPage = cfg.ram.lut[0] >> 8;
  const pokes = [], events = [];
  const gens = Array.from({ length: cfg.voices }, () => ({ start: 0, stop: 0 }));
  // Built sample 16K + o_v + 8 is built in slot (that - lead): the host writes
  // at that slot's start, eight samples clear of the voice's edges either side.
  const midOf = (v, K) => Math.round((B * K + cfg.voiceOffsets[v] + 8 - lead) * T);
  const start = (v, K, name, step = 1) => {
    const s = SAMPLES[name], at = midOf(v, K);
    const st = v < cfg.stepVoices ? step : 1;
    const end = (s.at + s.bytes - 16 * st) & 0xffff;
    const gen = (gens[v].start = (gens[v].start + 1) & 0xff);
    events.push({ at, v, kind: "start", src: s.at, end, step: st, seq: events.length });
    pokes.push({ at, addr: S("stSrc", v), value: s.at & 0xff }, { at, addr: S("stSrc", v) + 1, value: s.at >> 8 },
      { at, addr: S("stEnd", v), value: end & 0xff }, { at, addr: S("stEnd", v) + 1, value: end >> 8 },
      { at, addr: S("stStep", v), value: st }, { at, addr: S("startGen", v), value: gen });
  };
  const stop = (v, K) => {
    const at = midOf(v, K), gen = (gens[v].stop = (gens[v].stop + 1) & 0xff);
    events.push({ at, v, kind: "stop", seq: events.length });
    pokes.push({ at, addr: S("stopGen", v), value: gen });
  };
  const level = (v, K, rungPage) => {
    const at = midOf(v, K) + 40;
    events.push({ at, v, kind: "level", page: rungPage, seq: events.length });
    pokes.push({ at, addr: S("level", v), value: lutPage + rungPage });
  };
  const blocks = Math.floor(cycles / (B * T)) - 6;
  const V = cfg.voices;
  for (let v = 0; v < V; v++) level(v, 2, 7);               // every voice at unity from block 2
  if (kind === "shots")
    for (let v = 0; v < V; v++) start(v, 3 + v, ["sine", "saw", "ramp"][v], 1 << v);
  if (kind === "clip")                                         // full-scale squares on top of each other
    for (let v = 0; v < V; v++) start(v, 3, "square", 1);
  if (kind === "levels") {
    for (let v = 0; v < V; v++) start(v, 3, ["saw", "sine", "square"][v], 1);
    for (let K = 4, n = 0; K < blocks; K += 3, n++)
      for (let v = 0; v < V; v++) {
        level(v, K, (n + 3 * v) % 8);
        if (K % 24 === 4) start(v, K + 1, ["saw", "sine", "square"][v], 1);
      }
  }
  if (kind === "stop")
    for (let v = 0; v < V; v++) { start(v, 3, "saw", 1); stop(v, 20 + 5 * v); start(v, 40, "ramp", 2); stop(v, 70); }
  if (kind === "roll")
    for (let K = 3; K < blocks; K += 2)
      for (let v = 0; v < V; v++) if ((K + v) % 3) start(v, K, K % 2 ? "short" : "ramp", 1 << ((K + v) % 4));
  return { pokes: pokes.sort((a, b) => a.at - b.at), events };
}

// ── The reference ──────────────────────────────────────────────────────────
function reference(cfg, events, dac) {
  const B = cfg.blockSamples, lead = cfg.lead, V = cfg.voices;
  const lutPage = cfg.ram.lut[0] >> 8;
  const slotT = (sample) => { const s = sample - lead; return s < 0 ? null : dac[s]; };
  const states = [];   // states[v][K] = { ptr, step, page } for voice v's block K
  for (let v = 0; v < V; v++) {
    const o = cfg.voiceOffsets[v];
    const blocks = Math.ceil(dac.length / B) + 2;
    const mine = events.filter((e) => e.v === v);
    let ptr = PCM1_SILENCE, step = 1, end = 0, page = 0, park = 0;
    let seenStart = -1, seenStop = -1, seenLevel = -1, levelByte = 0;
    const list = [];
    for (let K = 0; K < blocks; K++) {
      const j = B * K + o;                         // this block's first sample
      const tStop = slotT(j - 3), tCmp = slotT(j - 2), tPark = slotT(j - 1), tStart = slotT(j);
      if (K > 0 && tStart === undefined) { list.push({ ptr, step, page }); continue; }
      if (tStop !== null) for (const e of mine)
        if (e.kind === "stop" && e.at < tStop && e.seq > seenStop) { seenStop = e.seq; end = 0; }
      // The pointer the COMPARE sees: fifteen samples into the previous block.
      const prev = K > 0 ? list[K - 1] : { ptr: PCM1_SILENCE, step: 1 };
      if (tCmp !== null && K > 0) park = ((prev.ptr + 15 * prev.step) & 0xffff) >= end ? 1 : 0;
      let next = K > 0 ? (prev.ptr + 16 * prev.step) & 0xffff : PCM1_SILENCE;
      if (tPark !== null) {
        for (const e of mine)
          if (e.kind === "level" && e.at < tPark && e.seq > seenLevel) { seenLevel = e.seq; levelByte = e.page; }
        page = levelByte;
        if (park) next = PCM1_SILENCE;
      }
      if (tStart !== null) {
        let start = null;
        for (const e of mine)
          if (e.kind === "start" && e.at < tStart && e.seq > seenStart) { seenStart = e.seq; start = e; }
        if (start) { next = start.src; step = start.step; end = start.end; }
      }
      ptr = next;
      list.push({ ptr, step: ptr === PCM1_SILENCE && K === 0 ? 1 : step, page });
    }
    states.push(list);
  }
  void lutPage;
  return (i) => {
    if (i < lead) return SILENCE;
    const srcs = [], pages = [];
    for (let v = 0; v < V; v++) {
      const o = cfg.voiceOffsets[v];
      if (i < o) { srcs.push(0); pages.push(0); continue; }
      const K = Math.floor((i - o) / B), m = (i - o) % B;
      const s = states[v][K];
      const a = (s.ptr + m * s.step) & 0xffff;
      if (a < 0x8000) throw new Error(`reference: voice ${v} sample ${i} reads RAM at $${a.toString(16)}`);
      srcs.push(BANK[a - 0x8000]); pages.push(s.page);
    }
    if (FAULT === "wrap") {
      let acc = 0;
      for (let v = 0; v < V; v++) acc += pages[v] ? ((srcs[v] << 24) >> 24) >> (7 - pages[v]) : 0;
      return (acc + 128) & 0xff;
    }
    return mixRungs(srcs, pages);
  };
}

// ── The run ────────────────────────────────────────────────────────────────
const CASES = ["idle", "shots", "clip", "levels", "stop", "roll"];

export function runPoint({ voices, period, stepVoices = null, seconds = SECONDS, only = null, log = console.log }) {
  const opts = pointConfig(voices, period, stepVoices === null ? {} : { stepVoices });
  const cfg = buildConfig(opts);
  const r = generateSplit(cfg, { stackFill: true, correct: true, proto: true });
  if (!r.ok) throw new Error(`the point did not place: ${r.stage}`);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `stream-nv-${cfg.stamp}.z80`);
  const text = FAULT === "mis-cost" ? r.gen.text.replace(/^mix_one:$/m, "mix_one:\n        nop") : r.gen.text;
  if (FAULT === "mis-cost" && text === r.gen.text) throw new Error("the mis-cost fault found no mix_one");
  writeFileSync(path, text);
  const built = assemble(path);
  let failed = 0;
  for (const kind of CASES) {
    if (only && kind !== only) continue;
    const cycles = Math.round(seconds * cfg.z80Hz);
    const m = new Machine(cfg, built, { rom: BANK, pokes: [], vdp: syntheticH() });
    while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
    const dac0 = m.trace.dacCycle[0];
    const script = hostScript(kind, cfg, cycles);
    m.pokes = script.pokes.map((p) => ({ ...p, at: p.at + dac0 })).sort((a, b) => a.at - b.at);
    const events = script.events.map((e) => ({ ...e, at: e.at + dac0 }));
    m.run(cycles);
    const ref = reference(cfg, events, m.trace.dacCycle);
    const value = analyzeValue(m.trace, ref);
    const time = analyzeTime(m.trace, cfg);
    const fails = [...value.problems.map((p) => `VALUE ${p}`)];
    for (const p of rungsAgree()) fails.push(`TABLE ${p}`);
    if (time.gapMin !== Math.floor(cfg.periodCycles) || time.gapMax !== Math.ceil(cfg.periodCycles))
      fails.push(`TIME intervals ${time.gapMin}..${time.gapMax}, the slot is ${cfg.periodCycles}`);
    if (Math.abs(time.rateErrPct) > 0.001) fails.push(`TIME rate ${time.meanRateHz} Hz (${time.rateErrPct}%)`);
    const nonSilent = m.trace.dacValue.filter((x) => x !== SILENCE).length;
    if (kind !== "idle" && !nonSilent) fails.push("VALUE the case never made a sound");
    if (fails.length) failed++;
    log(`${fails.length ? "FAIL" : "ok  "}  ${voices}v ${cfg.rateHz.toFixed(1)} Hz ${kind.padEnd(7)}`
      + ` ${time.n} samples, ${nonSilent} non-silent · gap ${time.gapMin}..${time.gapMax}`
      + ` · ${events.length} host events`);
    for (const f of fails.slice(0, 4)) log(`      ! ${f}`);
  }
  return { failed, cfg, code: built.symbols.get("code_end") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const voices = Number(arg("voices", 2)), period = Number(arg("period", 461));
  // The bare defaults ARE a placed point: 2 voices at 461 cycles is the study's
  // best two-voice rate, and that point carries the octave step on voice 0 only
  // (with it on both, 235 cycles of mix do not fit a 461-cycle slot).
  const sv = arg("step-voices", "1");
  const r = runPoint({ voices, period, stepVoices: sv === null ? null : Number(sv), only: ONLY });
  console.log(`\n${r.failed ? `FAIL: ${r.failed} case(s)` : "all cases pass"} · ${voices} voices at`
    + ` ${r.cfg.rateHz.toFixed(1)} Hz, lap ${r.cfg.cycleSlots}, code ${r.code} B`);
  process.exit(r.failed ? 1 : 0);
}
