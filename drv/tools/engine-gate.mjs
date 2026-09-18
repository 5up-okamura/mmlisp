// THE LIGHT ENGINE GATE (docs/driver.md §12.4).
//
//   node tools/engine-gate.mjs [--voices 1,2,3] [--case NAME] [--seconds S]
//   node tools/engine-gate.mjs --negatives      the gate's own faults must fail
//
// Each light image runs in the JS instruction model (tools/machine.mjs) with a
// host that writes {op,val} pairs into the FIFO page once a frame, as the
// VSync-only SGDK host will. Five things are graded:
//
//   TIME     every DAC interval is its slot's length, the rate is exact, no hole
//   VALUE    every DAC byte equals live/src/pcm-model.js driven by the pairs the
//            expander ACTUALLY consumed, in the slots it consumed them — so the
//            pieces, the mix and the tables are graded, not the host
//   INTENT   what the model's edge applied (source, END, WRAP) is what the host
//            meant, command by command — this is where a staged store landing
//            inside a generation's window shows (`idleAfterGen`)
//   WRITES   the chip's settling table and the frequency latch (analyze.mjs)
//   PAIRS    the expander consumed at the image's own step slots, every pair
//            the host wrote exactly once and in order
//
// Negatives (--negatives): `mis-cost` (an uncosted `nop` in the mix: TIME),
// `wrap` (a reference that wraps instead of saturating: VALUE on the clip
// case), `idle` (no IDLE pairs after a generation: INTENT on the adjacent case).
import { buildLightImage } from "./build-engine.mjs";
import { Machine, traceMeta } from "./machine.mjs";
import { analyzeTime, analyzeWrites } from "../engine/analyze.mjs";
import { buildRungs, buildClamp, rung, sourceValue, bias } from "../engine/lut.mjs";
import { PcmEngineModel, pcmOp, pcmLoopPoints, pcmShotPoints, pcmPageOfShift, pcmRung,
  PCM_SILENCE_ADDR, PCM_SILENCE_BYTE, PCM_WINDOW } from "../../live/src/pcm-model.js";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VOICES = arg("voices", "1,2,3").split(",").map(Number);
const ONLY = arg("case", null);
const SECONDS = Number(arg("seconds", 2));
const NEGATIVES = argv.includes("--negatives");

// ── The bank: signed bytes, every blob a multiple of 16, the top page silent ─
const BANK = new Uint8Array(0x8000);
const S = {};
let cursor = 0x0100;
function place(name, values) {
  const len = Math.ceil(values.length / 16) * 16;
  S[name] = { src: PCM_WINDOW + cursor, len };
  values.forEach((x, i) => { BANK[cursor + i] = x & 0xff; });
  cursor += len + 64;
}
place("sine", Array.from({ length: 1600 }, (_, i) => Math.round(120 * Math.sin(2 * Math.PI * i / 90))));
place("saw", Array.from({ length: 2000 }, (_, i) => ((i * 5) % 256) - 128));
place("square", Array.from({ length: 1200 }, (_, i) => ((i >> 4) & 1 ? 127 : -128)));
place("ramp", Array.from({ length: 704 }, (_, i) => ((i * 3) & 0xff) - 128));
place("short", Array.from({ length: 40 }, (_, i) => 100 - i * 5));
place("tone", Array.from({ length: 4000 }, (_, i) => Math.round(110 * Math.sin(2 * Math.PI * i / 37)
  * (i < 800 ? i / 800 : 1))));
if (cursor > 0x7f00) throw new Error("the test samples reach the silence page");

// ── The host's commands, as the converter will write them (design §2.1) ────
// Every command is its staged stores, then its generation, then idleAfterGen
// IDLE pairs. `intent` is what the edge must apply for it.
function commands(desc, { idle = true } = {}) {
  const gens = Array.from({ length: desc.voices }, () => ({ start: 0, end: 0 }));
  const idles = () => Array.from({ length: idle ? desc.idleAfterGen : 0 }, () => [0, 0]);
  const w16 = (name, v, x) => [[pcmOp(name, v), x & 0xff], [pcmOp(name, v) + 1, (x >> 8) & 0xff]];
  return {
    start(v, sample, { page = 7, loop = null } = {}) {
      const s = S[sample];
      const pts = loop ? pcmLoopPoints(s.src, s.len, loop[0], loop[1]) : pcmShotPoints(s.src, s.len);
      gens[v].start = (gens[v].start + 1) & 0xff;
      return { pairs: [[pcmOp("LEVEL", v), desc.lutPage + page], ...w16("SRC", v, s.src), ...w16("END", v, pts.end),
        ...w16("WRAP", v, pts.wrap), [pcmOp("START", v), gens[v].start], ...idles()],
        intent: { v, kind: "start", src: s.src, end: pts.end, wrap: pts.wrap } };
    },
    retarget(v, sample, loop) {
      const s = S[sample];
      const pts = loop ? pcmLoopPoints(s.src, s.len, loop[0], loop[1]) : pcmShotPoints(s.src, s.len);
      gens[v].end = (gens[v].end + 1) & 0xff;
      return { pairs: [...w16("END", v, pts.end), ...w16("WRAP", v, pts.wrap), [pcmOp("RETARGET", v), gens[v].end],
        ...idles()], intent: { v, kind: "retarget", end: pts.end, wrap: pts.wrap } };
    },
    level(v, page) { return { pairs: [[pcmOp("LEVEL", v), desc.lutPage + page]], intent: null }; },
    fm(port, reg, val) { return { pairs: [[0x20, port], [reg, val]], intent: null }; },
    pitch(port, ch, hi, lo) { return { pairs: [[0x20, port], [0xa4 + ch, hi], [0xa0 + ch, lo]], intent: null }; },
  };
}

/** The script of a case: [{frame, cmd}] — `frame` is when the host has it. */
function script(kind, desc, frames, opts) {
  const c = commands(desc, opts), V = desc.voices, out = [];
  const at = (frame, cmd) => out.push({ frame, cmd });
  if (kind === "idle") return out;
  if (kind === "shots") {
    const names = ["sine", "saw", "ramp", "short"];
    for (let f = 2, k = 0; f < frames; f += 7, k++)
      for (let v = 0; v < V; v++) {
        at(f + v, c.start(v, names[(k + v) % names.length], { page: 7 - ((k + v) % 4) }));
        at(f + v, c.pitch(k % 2, k % 3, 0x22 + (k % 8), 0x69 + k));
        at(f + v, c.fm(0, 0x28, 0xf0 | (k % 3)));
        at(f + v, c.fm(1, 0x40 + (k % 3), 0x10 + k));
      }
  }
  if (kind === "loop") {
    for (let v = 0; v < V; v++) {
      at(2 + v, c.start(v, "tone", { loop: [1000 + 37 * v, 1370 + 37 * v] }));
      at(40 + v, c.retarget(v, "tone", null));                     // the release: play the tail and park
      at(70 + 3 * v, c.start(v, "saw", { loop: [0, 200], page: 6 }));
      at(95 + 3 * v, c.retarget(v, "saw", null));
    }
  }
  if (kind === "retarget") {
    for (let v = 0; v < V; v++) {
      at(2 + v, c.start(v, "tone", { loop: [900, 3000] }));
      // Down below where the pointer is, up again, the start moved, one block long.
      const moves = [[900, 1200], [1500, 3900], [16, 400], [3000, 3016], [0, 4000], [2000, 2600]];
      moves.forEach(([ls, le], k) => at(12 + 9 * k + v, c.retarget(v, "tone", [ls, le])));
      at(80 + v, c.retarget(v, "tone", null));
    }
  }
  if (kind === "levels") {
    for (let v = 0; v < V; v++) at(2, c.start(v, "tone", { loop: [800, 4000], page: 7 }));
    for (let f = 5, k = 0; f < frames; f += 3, k++)
      for (let v = 0; v < V; v++) at(f, c.level(v, (k + 2 * v) % 8));
  }
  if (kind === "clip") {
    for (let v = 0; v < V; v++) at(2, c.start(v, "square", { loop: [0, 1200], page: 7 }));
  }
  if (kind === "roll") {
    const names = ["short", "ramp", "sine"];
    for (let f = 2, k = 0; f < frames; f += 1, k++) at(f, c.start(k % V, names[k % 3], { page: 7 - (k % 3) }));
  }
  if (kind === "adjacent") {
    // A start and then a retarget of the SAME voice, as close as the host is
    // allowed to put them: the retarget's staged END lands right after the
    // start's IDLE window.
    for (let f = 2, k = 0; f < frames - 4; f += 6, k++)
      for (let v = 0; v < V; v++) {
        at(f, c.start(v, "tone", { loop: [400 + 16 * k, 900 + 32 * k] }));
        at(f, c.retarget(v, "tone", [200 + 8 * k, 700 + 16 * k]));
      }
  }
  return out;
}
const CASES = ["idle", "shots", "loop", "retarget", "levels", "clip", "roll", "adjacent"];

// ── The host: VSync only, 16 pairs a grab, written ahead of the index ──────
const PAIRS_PER_GRAB = 16, AHEAD = 48;

function runCase(built, kind, { seconds, fault }) {
  const { cfg, descriptor: desc } = built;
  const frames = Math.round(seconds * 60);
  const items = script(kind, desc, frames, { idle: fault !== "idle" });
  const fifoAddrs = Array.from({ length: 256 }, (_, i) => desc.fifo + i);
  const m = new Machine(cfg, { bytes: built.bytes, symbols: built.symbols }, { rom: BANK, watch: fifoAddrs });
  m.trace.meta = traceMeta(cfg, { case: kind });
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  // The queue: every command's pairs, in order, released at its frame.
  const queue = [];
  for (const { frame, cmd } of items.sort((a, b) => a.frame - b.frame))
    for (const p of cmd.pairs) queue.push({ frame, op: p[0], val: p[1] });
  const written = [];
  let H = null, frame = 0;
  m.host = { every: cfg.frameCycles, fn: (ram) => {
    frame++;
    const C = ram[desc.fifoLo] >> 1;
    if (H === null || ((H - C) & 127) > 64 || H === C) H = (C + AHEAD) & 127;
    // Never overrun pairs not yet read: the head may not come within one grab
    // of the index from behind.
    const room = Math.max(0, 128 - ((H - C) & 127) - 1);
    const writes = [];
    for (let n = 0; n < Math.min(PAIRS_PER_GRAB, room) && queue.length && queue[0].frame <= frame; n++) {
      const p = queue.shift();
      writes.push([desc.fifo + 2 * H, p.op], [desc.fifo + 2 * H + 1, p.val]);
      written.push([p.op, p.val]);
      H = (H + 1) & 127;
    }
    return writes;
  } };
  m.hostNext = dac0 + cfg.frameCycles;
  m.run(dac0 + (frames + 20) * cfg.frameCycles);
  const fails = [];
  const dac = m.trace.dacCycle, n = dac.length;

  // ── TIME ─────────────────────────────────────────────────────────────
  const time = analyzeTime(m.trace, cfg);
  if (time.gapMin !== Math.floor(cfg.periodCycles) || time.gapMax !== Math.ceil(cfg.periodCycles))
    fails.push(`TIME intervals ${time.gapMin}..${time.gapMax}, the slot is ${cfg.periodCycles}`);
  if (Math.abs(time.rateErrPct) > 0.001) fails.push(`TIME rate ${time.meanRateHz} Hz (${time.rateErrPct}%)`);
  if (time.holes.length) fails.push(`TIME ${time.holes.length} hole(s)`);

  // ── PAIRS: what the expander read, and in which slot ─────────────────
  const slotOf = (cycle) => { let lo = 0, hi = n - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (dac[mid] <= cycle) lo = mid; else hi = mid - 1; } return lo; };
  const consumed = new Map(), readOrder = [];
  for (const [cycle, addr, val] of m.trace.globRead) {
    if (cycle < dac0) continue;
    const off = addr - desc.fifo, s = slotOf(cycle);
    if (s >= n - 1) continue;                     // the last slot is cut off by the end of the run
    if (!consumed.has(s)) consumed.set(s, [null, null]);
    consumed.get(s)[off & 1] = val;
  }
  const xp = new Set(desc.xpSlots);
  for (const [s, pair] of [...consumed.entries()].sort((a, b) => a[0] - b[0])) {
    if (!xp.has(s % desc.lapSamples)) { fails.push(`PAIRS a pair was read in slot ${s % desc.lapSamples}, not an expander slot`); break; }
    if (pair[0] === null || pair[1] === null) { fails.push(`PAIRS slot ${s}: a half-read pair`); break; }
    if (pair[0] !== 0) readOrder.push(pair);
  }
  const wroteOrder = written.filter(([op]) => op !== 0);
  const tail = readOrder.length === wroteOrder.length ? null
    : `the host wrote ${wroteOrder.length} non-IDLE pairs, the expander read ${readOrder.length}`;
  if (tail) fails.push(`PAIRS ${tail}`);
  for (let i = 0; i < Math.min(readOrder.length, wroteOrder.length); i++)
    if (readOrder[i][0] !== wroteOrder[i][0] || readOrder[i][1] !== wroteOrder[i][1]) {
      fails.push(`PAIRS pair ${i}: read ${readOrder[i]}, written ${wroteOrder[i]}`); break;
    }
  if (queue.length) fails.push(`PAIRS ${queue.length} pairs never left the host's queue`);

  // ── VALUE: the model, fed what the expander read ─────────────────────
  const model = new PcmEngineModel(desc, BANK, { saturate: fault !== "wrap" });
  let valueFails = 0;
  for (let s = 0; s < n; s++) {
    const want = model.slot(consumed.get(s) ?? null);
    if (m.trace.dacValue[s] !== want && valueFails++ < 3)
      fails.push(`VALUE slot ${s} (block pos ${(s + desc.lead) % 16}): DAC ${m.trace.dacValue[s]}, model ${want}`);
  }
  if (valueFails > 3) fails.push(`VALUE ${valueFails} bytes differ in all`);

  // ── INTENT: what the edge applied, command by command, per voice ─────
  const intents = items.map((x) => x.cmd.intent).filter(Boolean);
  for (let v = 0; v < desc.voices; v++) {
    const want = intents.filter((x) => x.v === v);
    const got = [];
    for (const e of model.log.filter((x) => x.v === v)) {
      if (e.kind === "start-apply") got.push({ kind: "start", end: e.end, wrap: e.wrap });
      else if (e.kind === "start") { if (got.length && got.at(-1).kind === "start") got.at(-1).src = e.src; }
      else got.push({ kind: "retarget", end: e.end, wrap: e.wrap });
    }
    if (got.length !== want.length) { fails.push(`INTENT voice ${v}: ${want.length} commands sent, the edge applied ${got.length}`); continue; }
    for (let i = 0; i < want.length; i++) {
      const a = want[i], b = got[i];
      if (a.kind !== b.kind || a.end !== b.end || a.wrap !== b.wrap || (a.kind === "start" && a.src !== b.src)) {
        fails.push(`INTENT voice ${v} command ${i}: meant ${JSON.stringify(a)}, applied ${JSON.stringify(b)}`);
        break;
      }
    }
  }

  // ── WRITES ───────────────────────────────────────────────────────────
  const settle = analyzeWrites(m.trace, cfg);
  if (settle.problems.length) fails.push(...settle.problems.slice(0, 3).map((p) => `WRITES ${p}`));
  if (m.trace.stray.length) fails.push(`STRAY ${m.trace.stray.length} writes outside every device`);
  if (m.trace.dacEnable.length) fails.push("WRITES the image wrote $2B — the DAC enable is the sequencer's");

  const nonSilent = m.trace.dacValue.filter((x) => x !== PCM_SILENCE_BYTE).length;
  if (kind !== "idle" && !nonSilent) fails.push("VALUE the case never made a sound");
  if (kind === "idle" && nonSilent) fails.push(`VALUE ${nonSilent} non-silent bytes with nothing playing`);
  return { fails, time, n, nonSilent, pairs: wroteOrder.length, commands: intents.length };
}

/** The image's own tables against the arithmetic (not read by the model). */
function tablesAgree(built) {
  const problems = [];
  const at = (sym) => built.symbols.get(sym);
  const lut = built.cfg.ram.lut[0], clamp = built.cfg.ram.clamp?.[0];
  const rungs = buildRungs();
  for (let p = 0; p < 8 && problems.length < 2; p++)
    for (let b = 0; b < 256; b++) {
      if (built.bytes[lut + p * 256 + b] !== bias(rung(sourceValue(b, true), p))
        || bias(pcmRung(sourceValue(b, true), p)) !== rungs[p * 256 + b]) { problems.push(`TABLE rung page ${p} byte ${b}`); break; }
    }
  if (built.cfg.voices >= 2) {
    const c = buildClamp();
    for (let i = 0; i < 512; i++) if (built.bytes[clamp + i] !== c[i]) { problems.push(`TABLE clamp[${i}]`); break; }
  }
  void at;
  return problems;
}

function runImage(voices, { seconds = SECONDS, only = ONLY, fault = null, log = console.log } = {}) {
  const built = buildLightImage(voices, { fault: fault === "mis-cost" ? "mis-cost" : null });
  const d = built.descriptor;
  let failed = 0;
  const tables = tablesAgree(built);
  if (tables.length) { failed++; for (const t of tables) log(`FAIL  pcm${voices} ${t}`); }
  for (const kind of CASES) {
    if (only && kind !== only) continue;
    const r = runCase(built, kind, { seconds, fault });
    if (r.fails.length) failed++;
    log(`${r.fails.length ? "FAIL" : "ok  "}  pcm${voices} ${d.rateHz.toFixed(1)} Hz ${kind.padEnd(9)}`
      + ` ${r.n} samples, ${r.nonSilent} sounding · gap ${r.time.gapMin}..${r.time.gapMax}`
      + ` · ${r.commands} PCM commands, ${r.pairs} pairs`);
    for (const f of r.fails.slice(0, 5)) log(`      ! ${f}`);
  }
  return { failed, desc: d };
}

if (NEGATIVES) {
  // Each fault must make the gate fail on the case built to catch it.
  const expect = [["mis-cost", "idle", "TIME"], ["wrap", "clip", "VALUE"], ["idle", "adjacent", "INTENT"]];
  let bad = 0;
  for (const [fault, kind, what] of expect)
    for (const v of VOICES) {
      if (fault === "wrap" && v === 1) continue;           // one voice has nothing to saturate
      const lines = [];
      const r = runImage(v, { only: kind, fault, log: (l) => lines.push(l) });
      const caught = r.failed > 0 && lines.some((l) => l.includes(`! ${what}`));
      if (!caught) bad++;
      console.log(`${caught ? "ok  " : "FAIL"}  fault ${fault.padEnd(8)} pcm${v} ${kind}: ${caught ? `${what} caught it` : "the gate passed a broken build"}`);
    }
  if (bad) { console.log(`\nFAIL: ${bad} fault(s) went unnoticed`); process.exit(1); }
  console.log("\nevery fault is caught");
  process.exit(0);
}

let failed = 0;
for (const v of VOICES) {
  const r = runImage(v);
  failed += r.failed;
}
console.log(`\n${failed ? `FAIL: ${failed} case(s)` : "every case passes"} · light images ${VOICES.map((v) => `pcm${v}`).join(" ")}`);
process.exit(failed ? 1 : 0);
