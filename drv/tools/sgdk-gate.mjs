// THE WHOLE THING, BUILT WITH SGDK AND RUN ON BLASTEM (R28 §63.6 step 4).
//
//   node tools/sgdk-gate.mjs [score.mmlisp] [--seconds N] [--keep]
//
// An SGDK project is made in a scratch directory with `install-sgdk`, the
// example program on autoplay, and the score compiled in; it is built with the
// m68k toolchain SGDK's own makefile expects (GDK, or ~/Developer/gendev), and
// the ROM runs for N seconds in the headless BlastEm under drv/blastem/
// — the same patched core, so the log carries every DAC write, every YM and
// PSG access by CPU, every bus grab and every Z80 write to the state block.
//
// What is graded, from that log alone:
//   * every FM register write the Z80 made is the score's slot stream, per
//     port, in order (the reference driver renders the same score here)
//   * every PSG byte the 68000 wrote is the stream's, in order
//   * every DAC byte matches live/src/pcm-model.js — the same engine model the
//     host gates use — driven by the engine's OWN state-block writes as BlastEm
//     logged them, against the score's own 32 KB bank
//   * the DAC clock. Bus stops are not repaid, so the rate is checked against
//     what it should be once the stops are taken out, and the loss they cost is
//     reported as the pitch error it is
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { sgdkEnv, makeProject, runRom, dropProject } from "./sgdk-project.mjs";
import { buildLightImage } from "./build-engine.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot } from "../../live/src/slot-builder.js";
import { readProbe } from "./probe-analysis.mjs";
import { PcmEngineModel, PCM_SILENCE_BYTE } from "../../live/src/pcm-model.js";
import { scorePcmVoices } from "../../live/src/export-mmb.js";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 4));
const KEEP = argv.includes("--keep");
// --burn N: the example's stand-in for a game's own frame (example/main.c)
const BURN = Number(arg("burn", 0));
const score = argv.find((a) => a.endsWith(".mmlisp")) ?? join(drv, "tests", "m2-pcm.mmlisp");

const E = sgdkEnv("sgdk-gate");

// ── the project ────────────────────────────────────────────────────────────
let built;
try { built = makeProject(E, score, { flags: BURN ? `-DMMLISP_BURN=${BURN}` : "" }); }
catch (e) {
  console.error(e.output ?? e.message);
  console.error("FAIL: the SGDK build failed");
  if (!KEEP && e.proj) dropProject(e.proj);
  process.exit(1);
}
const { proj, rom, sampleBank } = built;

// ── the run ────────────────────────────────────────────────────────────────
const outDir = join(drv, "out", "sgdk-gate");
mkdirSync(outDir, { recursive: true });
const tag = basename(score, ".mmlisp");
const log = join(outDir, `${tag}-${SECONDS}s.log`);
runRom(E, rom, { seconds: SECONDS, log, wav: log.replace(/\.log$/, ".wav") });
const L = readProbe(readFileSync(log));

// ── the reference driver's own stream ──────────────────────────────────────
const { bytes: mmb, ir } = buildMmb(score);
const player = new DrvPlayer();
player.loadMMB(mmb, sampleBank);
// The SGDK host primes at load and the example starts every track once the
// load has gone out — the reference's prime mode. The idle frames between
// change no write's order, only when it happens, so 0 of them will do here.
const slots = player.captureSlotLog({ maxFrames: Math.round(SECONDS * 60) + 60, prime: 0, builder: new SlotBuilder() }).slots;
const want = [[], []], psgWant = [];
slots.forEach((s, f) => { const d = decodeSlot(s); for (const [r, v] of d.fm0) want[0].push({ r, v, f }); for (const [r, v] of d.fm1) want[1].push({ r, v, f }); psgWant.push(...d.psg); });

// ── grading ────────────────────────────────────────────────────────────────
// The image the host booted is the one the score's header names.
const voices = Math.max(1, scorePcmVoices(ir));
const { cfg, descriptor: desc } = buildLightImage(voices);
const errors = [];
// GRADE FROM THE IMAGE THE SCORE BOOTED. MMLisp_init brings up pcm1 — it is
// the FM/PSG writer for a score without PCM too — and MMLisp_loadScore boots
// the score's own image over it, so a pcm2/pcm3 score has a first engine whose
// samples are another image's. The engine writes its ready mark once per boot,
// so the last one is where this run's engine begins. The upload that precedes
// it holds the bus for about 5M master (6,912 bytes through the Z80 window);
// that is a load, not a runtime stop, and it is outside the graded span.
const STATE_OFF = desc.state & 0xff;
const readyMarks = L.ramWrites.filter((w) => w.region === "glob"
  && w.addr === STATE_OFF + (desc.ready - desc.state) && w.value === desc.readyMark);
const readyAt = readyMarks.at(-1);
const dac = readyAt ? L.dac.filter((d) => d.time > readyAt.time) : L.dac;
const dac0 = dac[0]?.time ?? 0;
// FM: every Z80 data write attributed to the latched register, DAC and boot excluded.
const latch = [null, null], seen = [[], []];
for (const e of L.ymZ80) {
  if (e.read) continue;
  if (e.kind === "addr") { latch[e.part] = e.byte; continue; }
  const reg = latch[e.part];
  if (reg === null || e.time < dac0) continue;
  if (e.part === 0 && reg === 0x2a) continue;
  seen[e.part].push({ r: reg, v: e.byte, t: e.time });
}
for (const p of [0, 1]) {
  const n = Math.min(seen[p].length, want[p].length);
  for (let i = 0; i < n; i++) {
    const a = seen[p][i], b = want[p][i];
    if (a.r !== b.r || a.v !== b.v) { errors.push(`FM port ${p} write ${i}: chip saw $${a.r.toString(16)}=$${a.v.toString(16)}, the score says $${b.r.toString(16)}=$${b.v.toString(16)}`); break; }
  }
  if (seen[p].length > want[p].length) errors.push(`FM port ${p}: the chip saw ${seen[p].length} writes, the score has ${want[p].length}`);
}
// The engine's boot writes $2B (DAC enable) only; anything else before the first sample is a stray.
// SGDK's own boot mutes the PSG before the score starts, so the score's stream
// is matched as what the 68000 wrote AFTER the engine's first frame.
const firstFrame = L.grabs.length > 8 ? L.grabs[8][0] : dac0;
const psgSeen = L.psg68k.filter((e) => e.time >= firstFrame).map((e) => e.value & 0xff);
for (let i = 0; i < Math.min(psgSeen.length, psgWant.length); i++)
  if (psgSeen[i] !== psgWant[i]) { errors.push(`PSG byte ${i}: the 68000 wrote ${psgSeen[i]}, the score says ${psgWant[i]}`); break; }
// Did the engine boot, and did the host see it? The ready mark is a Z80 write
// the probe logs, and the number of grabs says whether frames ran at all.
if (!readyAt) errors.push("the engine never wrote its ready mark");
if (L.grabs.length < SECONDS * 50) errors.push(`only ${L.grabs.length} bus grabs in ${SECONDS}s — the host is not pumping once a frame`);
if (L.psgZ80.length) errors.push(`${L.psgZ80.length} PSG writes came from the Z80`);
if (L.ym68k.filter((e) => e.time >= dac0).length) errors.push(`${L.ym68k.length} YM accesses came from the 68000 while the engine ran`);
// DAC: the engine model (live/src/pcm-model.js), stepped one slot per DAC
// write and fed the STORES the engine's own expander made — the 68000-writable
// half of the state block, as BlastEm logged the Z80 writing it. Nothing about
// the score is assumed here: if the wire dropped a pair or wrote it late, the
// model sees exactly what the engine saw and the DAC still has to match.
const dacT = dac.map((d) => d.time);
const stateSpan = desc.opLimit;          // ops below this are the host's
const stores = [];                       // {slot, op, val}, in time order
{
  let si = 0;
  for (const w of L.ramWrites) {
    if (w.region !== "glob") continue;
    const op = w.addr - STATE_OFF;
    if (op < 0 || op >= stateSpan) continue;       // the Z80's own bytes, and fifoLo/ready
    while (si + 1 < dacT.length && dacT[si + 1] <= w.time) si++;
    if (w.time < dacT[0]) continue;                // boot, before the first sample
    stores.push({ slot: si, op, val: w.value });
  }
}
const bank = new Uint8Array(0x8000);
if (sampleBank) bank.set(sampleBank.subarray(0, 0x8000), 0);
const pcm = new PcmEngineModel(desc, bank);
let bad = -1, k = 0;
for (let i = 0; i < dac.length; i++) {
  const expect = pcm.slot();
  if (dac[i].value !== expect && bad < 0) { bad = i; errors.push(`DAC sample ${i} was ${dac[i].value}, the model says ${expect}`); }
  while (k < stores.length && stores[k].slot === i) { pcm.store(stores[k].op, stores[k].val); k++; }
}
const starts = pcm.log.filter((e) => e.kind === "start-apply");
// The clock.
const gaps = [];
for (let i = 1; i < dacT.length; i++) gaps.push(dacT[i] - dacT[i - 1]);
const span = dacT.at(-1) - dacT[0];
const rate = (dacT.length - 1) / (span / cfg.machine.masterHz);
// BUS STOPS ARE NOT REPAID (driver.md §5): the DAC simply runs slow by the time
// the bus was held. So the engine is graded on the rate it keeps while it runs,
// and what the stops cost is reported as the pitch error it is — the ear's
// verdict was that 200 µs twice a frame is inaudible (plan-pcm-spec.md D9).
const stops = L.stops.filter(([x]) => x >= dac0 && x <= dacT.at(-1)).map(([x, y]) => y - x);
const held = stops.reduce((a, b) => a + b, 0);
const rateRun = (dacT.length - 1) / ((span - held) / cfg.machine.masterHz);
const lostPct = 100 * (rate / desc.rateHz - 1);
const over = stops.filter((x) => x > 3000).length;
if (Math.abs(rateRun / desc.rateHz - 1) > 0.002)
  errors.push(`DAC rate ${rateRun.toFixed(2)} Hz between stops is ${(100 * (rateRun / desc.rateHz - 1)).toFixed(3)}% off`);
if (lostPct < -1.5) errors.push(`bus stops cost ${(-lostPct).toFixed(2)}% of the DAC rate — more than a quarter tone`);
if (over) errors.push(`${over} runtime bus stops longer than 3,000 master (the grab is ~2,400)`);
const nonSilent = dac.filter((d) => d.value !== PCM_SILENCE_BYTE).length;
// TIMING: when each FM write reached the chip, against the frame the reference
// rendered it in. Wire bursts make single writes late; a LOST frame moves every
// later write a frame later for good. So the floor of the lag, second by
// second, must not climb: a climb of more than a frame is a frame the host lost.
const FRAME = 896040;
const lagRows = [];
for (const p of [0, 1]) for (let i = 0; i < Math.min(seen[p].length, want[p].length); i++) lagRows.push({ t: seen[p][i].t, f: want[p][i].f });
const floorBySecond = new Map();
for (const r of lagRows) {
  const sec = Math.floor(r.f / 60);
  const lag = r.t - r.f * FRAME;
  floorBySecond.set(sec, Math.min(floorBySecond.get(sec) ?? Infinity, lag));
}
const floors = [...floorBySecond.entries()].sort((a, b) => a[0] - b[0]).filter(([sec]) => sec >= 1).map(([, v]) => v);
const drift = floors.length > 1 ? (Math.max(...floors) - floors[0]) / cfg.machine.masterHz * 1000 : 0;
if (drift > 20) errors.push(`the FM arrives ${drift.toFixed(1)} ms later at the end than at the start: frames were lost`);
// SYNC (tests/m3-pcm-sync.mmlisp): each PCM start's first sound against the
// nearest fm1 key-on the chip saw. + means the drum is late.
const keyOns = seen[0].filter((w) => w.r === 0x28 && (w.v & 7) === 0 && (w.v & 0xf0)).map((w) => w.t);
const sync = [];
if (keyOns.length) for (const e of starts) {
  let i = e.slot + desc.lead;
  while (i < dac.length && dac[i].value === PCM_SILENCE_BYTE) i++;
  if (i >= dac.length) continue;
  const t = dac[i].time;
  const k = keyOns.reduce((b, c) => (Math.abs(c - t) < Math.abs(b - t) ? c : b), keyOns[0]);
  sync.push(((t - k) / cfg.machine.masterHz) * 1000);
}
if (tag === "m3-pcm-sync") {
  const off = sync.slice(1).filter((x) => x < -2 || x > 5);
  if (off.length) errors.push(`${off.length} PCM onsets outside -2..+5 ms of their fm1 key-on`);
}

console.log(`sgdk-gate  ${tag}: ${SECONDS}s on BlastEm · rom ${rom}`);
console.log(`  pcm${voices} image, ${desc.rateHz} Hz nominal · DAC ${dac.length} samples, ${rateRun.toFixed(2)} Hz between stops,`
  + ` ${rate.toFixed(2)} Hz over the run (${lostPct.toFixed(2)}% lost to bus stops = ${(1200 * Math.log2(rate / desc.rateHz)).toFixed(1)} cents),`
  + ` gap ${gaps.reduce((a, b) => Math.min(a, b), Infinity)}..${gaps.reduce((a, b) => Math.max(a, b), 0)} master,`
  + ` ${nonSilent} non-silent; ${starts.length} PCM starts; DAC ${bad < 0 ? "all match the model" : "MISMATCH"}`);
console.log(`  FM ${seen[0].length}+${seen[1].length} writes seen of ${want[0].length}+${want[1].length} in the score's stream;`
  + ` PSG ${psgSeen.length} of ${psgWant.length}; ${L.grabs.length} grabs, runtime stops ${stops.reduce((a, b) => Math.min(a, b), stops.length ? Infinity : 0)}..${stops.reduce((a, b) => Math.max(a, b), 0)} master, ${over} over 3,000`);
if (tag === "m3-pcm-sync") console.log(`  SYNC pcm vs fm1 key-on: ${sync.map((x) => x.toFixed(1)).join(" ")} ms`);
console.log(`  timing: the lag floor moved ${drift.toFixed(1)} ms over the run (${floors.length} seconds)`);
for (const e of errors) console.log(`  ! ${e}`);
console.log(errors.length ? "FAIL" : "ok — the SGDK build plays the score on BlastEm as the reference says it should");
if (!KEEP) dropProject(proj); else console.log(`  project kept at ${proj}`);
process.exit(errors.length ? 1 : 0);
