// THE WHOLE THING, BUILT WITH SGDK AND RUN ON BLASTEM (R28 §63.6 step 4).
//
//   node tools/sgdk-gate.mjs [score.mmlisp] [--seconds N] [--keep]
//
// An SGDK project is made in a scratch directory with `install-sgdk`, the
// example program on autoplay, and the score compiled in; it is built with the
// m68k toolchain SGDK's own makefile expects (GDK, or ~/Developer/gendev), and
// the ROM runs for N seconds in the headless BlastEm the dac-stream probe uses
// — the same patched core, so the log carries every DAC write, every YM and
// PSG access by CPU, every bus grab and every Z80 write to the state block.
//
// What is graded, from that log alone:
//   * every FM register write the Z80 made is the score's slot stream, per
//     port, in order (the reference driver renders the same score here)
//   * every PSG byte the 68000 wrote is the stream's, in order
//   * every DAC byte matches the one-voice reference driven by the engine's
//     own state writes, against the score's own 32 KB bank
//   * the DAC clock: nominal rate, and every runtime bus stop inside 1,500 master
//
// NOT YET ON THE LIGHT IMAGES (.claude/memory/plan-pcm-d10-design.md §8 S4):
// its DAC grading reads the one-voice image's state block and reference, which
// left with that image. S4 grades each light image with live/src/pcm-model.js
// fed the engine's own state writes, and removes this stop.
console.error("sgdk:gate is being moved to the light engine images (D10 S4); it cannot grade them yet");
process.exit(2);
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { sgdkEnv, makeProject, runRom, dropProject } from "./sgdk-project.mjs";
import { buildLightImage } from "./build-engine.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot } from "../../live/src/slot-builder.js";
import { readProbe } from "./probe-analysis.mjs";
import { PCM1, PCM1_BASE_OFF, pcm1Base } from "../engine/config.mjs";
import { reference } from "../engine/pcm1-ref.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 4));
const KEEP = argv.includes("--keep");
// --burn N: the example's stand-in for a game's own frame (example/main.c)
const BURN = Number(arg("burn", 0));
// --vblank-only: the example built with one pump a frame (MMLisp_attachVBlankOnly)
const VBLANK_ONLY = argv.includes("--vblank-only");
const score = argv.find((a) => a.endsWith(".mmlisp")) ?? join(drv, "tests", "m2-pcm.mmlisp");

const E = sgdkEnv("sgdk-gate");

// ── the project ────────────────────────────────────────────────────────────
let built;
try { built = makeProject(E, score, { flags: [BURN ? `-DMMLISP_BURN=${BURN}` : "", VBLANK_ONLY ? "-DMMLISP_VBLANK_ONLY=1" : ""].join(" ").trim() }); }
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
const { bytes: mmb } = buildMmb(score);
const player = new DrvPlayer();
player.loadMMB(mmb, sampleBank);
// The SGDK host primes at load and the example starts every track once the
// load has gone out — the reference's prime mode. The idle frames between
// change no write's order, only when it happens, so 0 of them will do here.
const slots = player.captureSlotLog({ maxFrames: Math.round(SECONDS * 60) + 60, prime: 0, builder: new SlotBuilder() }).slots;
const want = [[], []], psgWant = [];
slots.forEach((s, f) => { const d = decodeSlot(s); for (const [r, v] of d.fm0) want[0].push({ r, v, f }); for (const [r, v] of d.fm1) want[1].push({ r, v, f }); psgWant.push(...d.psg); });

// ── grading ────────────────────────────────────────────────────────────────
const { cfg } = buildLightImage(1);
const errors = [];
const dac0 = L.dac[0]?.time ?? 0;
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
const readyAt = L.ramWrites.find((w) => w.region === "glob" && w.addr === PCM1_BASE_OFF + PCM1.ready && w.value === 0xd2);
if (!readyAt) errors.push("the engine never wrote its ready mark");
if (L.grabs.length < SECONDS * (VBLANK_ONLY ? 50 : 100)) errors.push(`only ${L.grabs.length} bus grabs in ${SECONDS}s — the host is not calling MMLisp_frame/pump at 120/s`);
if (L.psgZ80.length) errors.push(`${L.psgZ80.length} PSG writes came from the Z80`);
if (L.ym68k.filter((e) => e.time >= dac0).length) errors.push(`${L.ym68k.length} YM accesses came from the 68000 while the engine ran`);
// DAC: the reference from the engine's own state writes.
const events = [];
const st = { src: 0, end: 0, step: 1, sgen: 0, pgen: 0 };
const levelWrites = [], masterWrites = [];
for (const w of L.ramWrites) {
  if (w.region !== "glob") continue;
  const off = w.addr - PCM1_BASE_OFF;
  if (off === PCM1.stSrc) st.src = (st.src & 0xff00) | w.value;
  else if (off === PCM1.stSrc + 1) st.src = (st.src & 0xff) | (w.value << 8);
  else if (off === PCM1.stEnd) st.end = (st.end & 0xff00) | w.value;
  else if (off === PCM1.stEnd + 1) st.end = (st.end & 0xff) | (w.value << 8);
  else if (off === PCM1.stStep) st.step = w.value;
  else if (off === PCM1.startGen && w.value !== st.sgen) { st.sgen = w.value; events.push({ kind: "start", at: w.time, src: st.src, end: st.end, step: st.step, seq: events.length }); }
  else if (off === PCM1.stopGen && w.value !== st.pgen) { st.pgen = w.value; events.push({ kind: "stop", at: w.time, seq: events.length }); }
  else if (off === PCM1.level) levelWrites.push(w);
  else if (off === PCM1.master) masterWrites.push(w);
}
const B = cfg.blockSamples, lead = cfg.lead, lutPage = cfg.ram.lut[0] >> 8;
const dacT = L.dac.map((d) => d.time);
const edges = [];
let li = 0, mi = 0, lv = lutPage, mv = lutPage + cfg.levels - 1;   // the shipped image boots at level 0
for (let K = 2; (B * K - lead - 1) < dacT.length; K++) {
  const t = dacT[B * K - lead - 1];
  while (li < levelWrites.length && levelWrites[li].time < t) lv = levelWrites[li++].value;
  while (mi < masterWrites.length && masterWrites[mi].time < t) mv = masterWrites[mi++].value;
  edges.push({ cycle: t, v0: lv - lutPage, master: mv - lutPage });
}
const bank = new Uint8Array(0x8000);
if (sampleBank) bank.set(sampleBank.subarray(0, 0x8000), 0);
const ref = reference(cfg, bank, events, dacT, edges);
let bad = -1;
for (let i = 0; i < L.dac.length; i++) if (L.dac[i].value !== ref(i)) { bad = i; break; }
if (bad >= 0) errors.push(`DAC sample ${bad} was ${L.dac[bad].value}, the reference says ${ref(bad)}`);
// The clock.
const gaps = [];
for (let i = 1; i < dacT.length; i++) gaps.push(dacT[i] - dacT[i - 1]);
const span = dacT.at(-1) - dacT[0];
const rate = (dacT.length - 1) / (span / cfg.machine.masterHz);
const stops = L.stops.filter(([x]) => x >= dac0).map(([x, y]) => y - x);
const over = stops.filter((x) => x > 1500).length;
if (Math.abs(rate / cfg.rateHz - 1) > 0.002) errors.push(`DAC rate ${rate.toFixed(2)} Hz is ${(100 * (rate / cfg.rateHz - 1)).toFixed(3)}% off`);
if (over) errors.push(`${over} runtime bus stops longer than 1,500 master`);
const nonSilent = L.dac.filter((d) => d.value !== 0x80).length;
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
if (keyOns.length) for (const e of events.filter((x) => x.kind === "start")) {
  const i = L.dac.findIndex((d) => d.time > e.at && d.value !== 0x80);
  if (i < 0) continue;
  const t = L.dac[i].time;
  const k = keyOns.reduce((b, c) => (Math.abs(c - t) < Math.abs(b - t) ? c : b), keyOns[0]);
  sync.push(((t - k) / cfg.machine.masterHz) * 1000);
}
if (tag === "m3-pcm-sync") {
  const off = sync.slice(1).filter((x) => x < -2 || x > 5);
  if (off.length) errors.push(`${off.length} PCM onsets outside -2..+5 ms of their fm1 key-on`);
}

console.log(`sgdk-gate  ${tag}: ${SECONDS}s on BlastEm · rom ${rom}`);
console.log(`  DAC ${L.dac.length} samples, ${rate.toFixed(2)} Hz, gap ${gaps.reduce((a, b) => Math.min(a, b), Infinity)}..${gaps.reduce((a, b) => Math.max(a, b), 0)} master,`
  + ` ${nonSilent} non-silent; ${events.length} PCM events; DAC ${bad < 0 ? "all match the reference" : "MISMATCH"}`);
console.log(`  FM ${seen[0].length}+${seen[1].length} writes seen of ${want[0].length}+${want[1].length} in the score's stream;`
  + ` PSG ${psgSeen.length} of ${psgWant.length}; ${L.grabs.length} grabs, runtime stops ${stops.reduce((a, b) => Math.min(a, b), stops.length ? Infinity : 0)}..${stops.reduce((a, b) => Math.max(a, b), 0)} master, ${over} over 1,500`);
if (tag === "m3-pcm-sync") console.log(`  SYNC pcm vs fm1 key-on: ${sync.map((x) => x.toFixed(1)).join(" ")} ms`);
console.log(`  timing: the lag floor moved ${drift.toFixed(1)} ms over the run (${floors.length} seconds)`);
for (const e of errors) console.log(`  ! ${e}`);
console.log(errors.length ? "FAIL" : "ok — the SGDK build plays the score on BlastEm as the reference says it should");
if (!KEEP) dropProject(proj); else console.log(`  project kept at ${proj}`);
process.exit(errors.length ? 1 : 0);
