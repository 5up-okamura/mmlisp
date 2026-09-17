// THE STOP-LENGTH LISTENING SET (plan-pcm-spec.md D9, study round item 1).
//
//   node experimental/dac-stream/stop-listen.mjs [--score PATH] [--frames N]
//        [--stops 28,60,100,200] [--hz 60,120] [--lpf] [--rate 44100] [--no-mix]
//
// The question it puts to the EAR: what does a 68000 bus stop of L µs, once or
// twice a frame, do to the PCM — and so whether the 68000 may write the YM2612
// itself (which would lengthen every stop) instead of feeding the Z80's pair
// expander. Nothing here is a gate.
//
// One real score goes through the SHIPPED image in the JS machine exactly as
// engine-score-gate runs it — the reference driver renders the slots, the
// pairs model pumps them twice a frame — plus a bus grab of L µs injected at
// the pump instants (the pumps themselves are charged nothing by the model, so
// 0 µs is the model's ideal and 28 µs at 120 Hz is about what the real pumps
// cost, 1,100–1,320 master each). For every (L, cadence) it writes:
//
//   * `…-mix.wav`   the whole song: FM and PSG from the register writes the
//                   chip saw, at their cycle times, through the nuked cores
//                   (live/src/synth-md.js — the same DSP the browser plays),
//                   with the DAC byte the machine wrote held until the next;
//   * `…-dac.wav`   the DAC alone, the same hold, mono;
//
// and for each a `repaid` twin: what the same stops sound like under an
// engine whose corrector DOES repay them — a phase reference that does not
// wrap inside the stop and a ladder sized to the stop (its cost a slot is in
// the manifest). Such an engine keeps its sample index on the wall clock, so
// the host's pairs are consumed at the same sample as with no stop at all:
// the DAC bytes are the `stop0` run's, and each stop only delays the slots
// after it until the ladder has paid it back. The shipped corrector expires
// past half a scanline (1,500 master, 28 µs) and reads a longer stop modulo
// a line, so from 60 µs up the `shipped` files are the DAC running slow by
// the stops, with every onset still on time — the host's pairs are what
// place an onset, and they are written on the 68000's clock.
//
// THE FIRST VERSION OF THIS TWIN WAS WRONG (2026-09-17, caught by ear): it
// re-timed the SHIPPED run's bytes onto the repaying clock. Those bytes
// already carry the onsets at their wall-clock places, so every repaid cycle
// moved every later onset EARLY — 47 ms by the end of sin008 at 200 µs. The
// onset column in the manifest is measured so that cannot come back quietly.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "../../tools/mmb-build.mjs";
import { buildEngine } from "../../tools/build-engine.mjs";
import { PairsModel, inTime, pairsCfgFromHeader } from "../../tools/pairs-model.mjs";
import { DrvPlayer } from "../../../live/src/drv-player.js";
import { SlotBuilder } from "../../../live/src/slot-builder.js";
import { MegaDriveSynth } from "../../../live/src/synth-md.js";
import { PCM1, pcm1Base } from "../../engine/config.mjs";
import { Machine, traceMeta } from "../../tools/machine.mjs";
import { analyzeTime } from "../../engine/analyze.mjs";
import { syntheticH } from "../../engine/pcm1-ref.mjs";
import { PHASE_TABLE } from "../../engine/observer.mjs";
import { MAX_QUANTA, CORR } from "../../engine/corrector.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const SCORE = resolve(arg("score", join(drv, "tests", "sin008.mmlisp")));
const FRAMES = Number(arg("frames", 900));
const STOPS = arg("stops", "28,60,100,200").split(",").map(Number);
const HZ = arg("hz", "60,120").split(",").map(Number);
const RATE = Number(arg("rate", 44100));
const LPF = flag("lpf");
const MIX = !flag("no-mix");
const OUT = join(drv, "out", "dac-stream", "stop-listen");

const engine = buildEngine();
const { cfg, header: H } = engine;
const built = { bytes: engine.bytes, symbols: engine.symbols };
const pcfg = pairsCfgFromHeader(H);
const S = (k) => pcm1Base(cfg) + PCM1[k];
const MCLK = cfg.machine.masterHz;
const Z80_DIV = cfg.machine.z80Div;
const usToCycles = (us) => Math.round((us * 1e-6 * cfg.z80Hz));
// THE REFERENCE WRAPS EVERY SCANLINE. The corrector reads the VDP's H counter,
// which repeats every line (3,420 master = 228 Z80 cycles), so a stop is seen
// MODULO a line, folded into -114..+114 cycles: a stop of 215 cycles reads as
// -13 (the engine looks 13 cycles EARLY and is slowed by 13 more), one of 358
// as -98. The 1,500-master contract is half a line, and beyond it the
// corrector does not fail to repay — it repays the wrong number. What it
// repays and what is left is predicted here from the line length alone and
// printed beside the measurement.
const LINE = PHASE_TABLE.mode.lineMaster / Z80_DIV;
const seenByLine = (L) => ((L % LINE) + LINE / 2) % LINE - LINE / 2;
const predictedRepaid = (L) => L ? 100 * seenByLine(L) / L : null;

// The score, rendered once: the slot stream and its bank are the same for
// every variant, only the machine run differs.
const { bytes, sampleBank } = buildMmb(SCORE);
const player = new DrvPlayer();
player.loadMMB(bytes, sampleBank);
const slots = player.captureSlotLog({ maxFrames: FRAMES, commands: [], builder: new SlotBuilder() }).slots;
const bank = new Uint8Array(0x8000);
if (sampleBank) bank.set(sampleBank.subarray(0, 0x8000), 0);

/** One run: the score through the shipped image with a stop of `us` at `hz`. */
function run(us, hz) {
  const model = new PairsModel(pcfg);
  const m = new Machine(cfg, built, { rom: bank, vdp: syntheticH() });
  m.trace.meta = traceMeta(cfg, { case: basename(SCORE), frames: FRAMES, stopUs: us, stopHz: hz });
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  const half = Math.round(cfg.frameCycles / 2);
  // The host, as engine-score-gate models it: a frame rendered at every other
  // half-frame tick, a pump at each, every fifth mid-frame pump skipped.
  let tick = 0, frame = 0, fifoLo = null;
  const psg = [];
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
    for (const b of model.psgTake()) psg.push({ cycle, byte: b });
    return writes;
  } };
  m.hostNext = dac0 + half;
  // The stops: at the pump instants — the VBlank pump alone at 60 Hz, both at
  // 120 Hz — so the Z80 is held right after the pump's own writes, which is
  // where a 68000 that also wrote the YM would still be holding it.
  const L = usToCycles(us);
  const end = dac0 + (slots.length + 12) * cfg.frameCycles;
  if (L > 0) {
    const everyTicks = hz === 60 ? 2 : 1;
    if (hz !== 60 && hz !== 120) throw new Error(`cadence ${hz} Hz: this set knows 60 (VBlank) and 120 (both pumps)`);
    for (let at = dac0 + half, k = 0; at < end; at += half, k++)
      if (k % everyTicks === 0) m.grabs.push({ at, cycles: L });
  }
  m.run(end);
  const ym = m.trace.ym.map(([cycle, port, reg, val]) => ({ cycle, port, reg, val }));
  const dac = m.trace.dacCycle.map((cycle, i) => ({ cycle, value: m.trace.dacValue[i] }));
  const time = analyzeTime(m.trace, cfg);
  const held = m.trace.grabs.reduce((s, [a, b]) => s + (b - a), 0);
  return { us, hz, L, dac0, ym, psg, dac, time, held, grabs: m.trace.grabs, model, end };
}

// Today's ladder: 28 quanta of 4 cycles a lap.
const TODAY_LADDER = MAX_QUANTA * CORR.quantumCycles;

/**
 * A REPAYING ENGINE'S CLOCK for `n` samples from `t0`: the exact slot lengths;
 * a stop delays the slot it lands in by its whole length and becomes debt;
 * once a lap up to `capPerLap` cycles of the debt are taken off that lap's
 * slots, spread evenly. Ideal otherwise — no reference error, no quantum — so
 * it is the best such an engine could sound, not a model of a particular one.
 * Returns the write times and the lag (the debt outstanding) at each sample.
 */
function repaidTimes(grabs, n, t0, capPerLap) {
  const lap = cfg.cycleSlots;
  const group = cfg.slotCycles.length;
  const t = new Float64Array(n);
  const lag = new Float64Array(n);
  t[0] = t0;
  let debt = 0, gi = 0, perSlot = 0;
  for (let i = 1; i < n; i++) {
    if (i % lap === 0) { const pay = Math.min(debt, capPerLap); perSlot = pay / lap; }
    const shorten = Math.min(perSlot, debt);
    let next = t[i - 1] + cfg.slotCycles[i % group] - shorten;
    debt -= shorten;
    while (gi < grabs.length && grabs[gi][0] < next) {
      const held = grabs[gi][1] - grabs[gi][0];
      next += held; debt += held; gi++;
    }
    t[i] = next; lag[i] = debt;
  }
  return { t, lag };
}

/** PCM onsets: the first sounding byte after at least 64 silent ones. */
function onsets(values, times) {
  const o = [];
  let quiet = 64;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0x80) { quiet++; continue; }
    if (quiet >= 64) o.push(times[i]);
    quiet = 0;
  }
  return o;
}
const ms = (cycles) => (cycles / cfg.z80Hz) * 1000;

/** The worst onset displacement against the no-stop run, in ms, signed. */
function onsetShift(base, values, times) {
  const a = onsets(base.values, base.times), b = onsets(values, times);
  if (a.length !== b.length) return { count: `${b.length} of ${a.length}`, worst: NaN };
  let worst = 0, over = [];
  for (let k = 0; k < a.length; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) > Math.abs(worst)) worst = d;
    if (Math.abs(ms(d)) > 5) over.push(ms(d));
  }
  return { count: a.length, worst: ms(worst), over };
}

// ── WAV writers ────────────────────────────────────────────────────────────
function wavHeader(dataBytes, channels, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2 * channels, 28); h.writeUInt16LE(2 * channels, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}
const i16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x)));

/** The DAC alone: each byte held from its master time until the next. */
function dacWav(values, times, t0, seconds) {
  const n = Math.floor(seconds * RATE);
  const pcm = Buffer.alloc(n * 2);
  let k = 0, v = 128;
  for (let i = 0; i < n; i++) {
    const at = t0 + (i * MCLK) / RATE;
    while (k < times.length && times[k] * Z80_DIV <= at) v = values[k++];
    pcm.writeInt16LE(i16((v - 128) * 256), i * 2);
  }
  return Buffer.concat([wavHeader(pcm.length, 1, RATE), pcm]);
}

/** The whole song: register writes at their cycle times, the DAC held. */
async function mixWav(r, values, times, t0, seconds) {
  const synth = await MegaDriveSynth.create(RATE);
  synth.setLpf(LPF);
  synth.setDacEnabled(true);
  const n = Math.floor(seconds * RATE);
  const L = new Float32Array(n), R = new Float32Array(n);
  let yi = 0, pi = 0, di = 0, v = 128, native = 0;
  const fmMaster = cfg.machine.fmSampleMaster;
  synth.renderInto(L, R, n, (i) => {
    const at = t0 + (i * MCLK) / RATE;
    while (yi < r.ym.length && r.ym[yi].cycle * Z80_DIV <= at) { const w = r.ym[yi++]; synth.writeYM(w.port, w.reg, w.val); }
    while (pi < r.psg.length && r.psg[pi].cycle * Z80_DIV <= at) synth.writePSG(r.psg[pi++].byte);
  }, () => {
    const at = t0 + native++ * fmMaster;
    while (di < times.length && times[di] * Z80_DIV <= at) v = values[di++];
    return v;
  });
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { pcm.writeInt16LE(i16(L[i] * 32767), i * 4); pcm.writeInt16LE(i16(R[i] * 32767), i * 4 + 2); }
  return Buffer.concat([wavHeader(pcm.length, 2, RATE), pcm]);
}

// ── The set ────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
// A run is a whole set: stale files of this score from an earlier set would
// otherwise sit in the manifest's directory unnamed by it.
for (const f of readdirSync(OUT)) if (f.startsWith(`${basename(SCORE, ".mmlisp")}-`) && f.endsWith(".wav")) unlinkSync(join(OUT, f));
const cents = (rate) => 1200 * Math.log2(rate / cfg.rateHz);
const rows = [];
const variants = [[0, 0], ...HZ.flatMap((hz) => STOPS.map((us) => [us, hz]))];
let base = null;
for (const [us, hz] of variants) {
  const r = run(us, hz);
  const seconds = Math.min(FRAMES / 60, (r.dac.at(-1).cycle - r.dac0) / cfg.z80Hz);
  const t0 = r.dac0 * Z80_DIV;
  const tag = us === 0 ? "stop0" : `stop${us}us-${hz}hz`;
  const values = r.dac.map((d) => d.value);
  const shippedT = r.dac.map((d) => d.cycle);
  if (us === 0) base = { values, times: shippedT, dac0: r.dac0 };
  if (r.dac0 !== base.dac0) throw new Error(`${tag}: the first DAC write moved (${r.dac0} vs ${base.dac0})`);
  const files = {};
  const emit = async (kind, vals, times) => {
    const stem = join(OUT, `${basename(SCORE, ".mmlisp")}-${tag}-${kind}`);
    writeFileSync(`${stem}-dac.wav`, dacWav(vals, times, t0, seconds));
    files[`${kind}-dac`] = `${stem}-dac.wav`;
    if (MIX) { writeFileSync(`${stem}-mix.wav`, await mixWav(r, vals, times, t0, seconds)); files[`${kind}-mix`] = `${stem}-mix.wav`; }
  };
  await emit("shipped", values, shippedT);
  const shippedOnset = onsetShift(base, values, shippedT);
  let repaid = null;
  if (us > 0) {
    // Sized to pay the stops this cadence brings in a lap, with a quarter over
    // so the debt drains between them.
    const stopsPerLap = (hz * cfg.cycleSlots) / cfg.rateHz;
    const cap = Math.ceil(1.25 * r.L * stopsPerLap);
    const sized = repaidTimes(r.grabs, base.values.length, base.times[0], cap);
    await emit("repaid", base.values, sized.t);
    const today = repaidTimes(r.grabs, base.values.length, base.times[0], TODAY_LADDER);
    repaid = { cap, perSlot: cap / cfg.cycleSlots, pct: (100 * cap) / (cfg.cycleSlots * cfg.periodCycles),
      maxLag: ms(Math.max(...sized.lag.filter((_, i) => i % 64 === 0))),
      onset: onsetShift(base, base.values, sized.t),
      todayEndLag: ms(today.lag.at(-1)) };
  }
  const drift = r.time.drift;
  rows.push({ us, hz, L: r.L, grabs: r.grabs.length, held: r.held, rate: r.time.meanRateHz, cents: cents(r.time.meanRateHz),
    drift, repaidPct: r.held ? 100 * (1 - drift / r.held) : null, predicted: predictedRepaid(r.L), seen: seenByLine(r.L),
    gapMin: r.time.gapMin, gapMax: r.time.gapMax, shippedOnset, repaid, files, seconds });
  console.log(`${tag.padEnd(16)} ${String(r.grabs.length).padStart(4)} stops · shipped ${r.time.meanRateHz.toFixed(2)} Hz`
    + ` (${cents(r.time.meanRateHz).toFixed(1)} ct), onsets worst ${shippedOnset.worst >= 0 ? "+" : ""}${shippedOnset.worst.toFixed(1)} ms,`
    + ` ${shippedOnset.over.length} of ${shippedOnset.count} past 5 ms [${shippedOnset.over.map((x) => x.toFixed(1)).join(" ")}]`
    + (r.held ? ` · corrector repaid ${(100 * (1 - drift / r.held)).toFixed(0)}% (line wrap predicts ${predictedRepaid(r.L).toFixed(0)}%)` : "")
    + (repaid ? ` · repaid: ladder ${repaid.perSlot.toFixed(1)} cyc/slot, lag ≤ ${repaid.maxLag.toFixed(2)} ms,`
      + ` onsets ${repaid.onset.worst >= 0 ? "+" : ""}${repaid.onset.worst.toFixed(1)} ms · today's ladder would lag ${repaid.todayEndLag.toFixed(0)} ms by the end` : ""));
}

// ── The manifest ───────────────────────────────────────────────────────────
const lines = [];
lines.push(`# The stop-length listening set — ${basename(SCORE)}, ${FRAMES} frames`);
lines.push("");
lines.push(`Built by \`node drv/experimental/dac-stream/stop-listen.mjs --score ${basename(SCORE)} --frames ${FRAMES}`
  + ` --stops ${STOPS.join(",")} --hz ${HZ.join(",")}${LPF ? " --lpf" : ""}\`.`);
lines.push("");
lines.push("The shipped image (" + cfg.stamp + ") in the JS machine, the score's slots pumped twice a frame as");
lines.push("engine-score-gate does, plus a bus stop of L µs at each VBlank pump (60 Hz) or at both pumps");
lines.push("(120 Hz). The model charges the pumps themselves nothing, so `stop0` is the ideal and 28 µs at");
lines.push("120 Hz is about what the real pumps cost. Every `-mix.wav` is FM + PSG from the register writes");
lines.push("the chip saw, at their cycle times, through the browser's nuked cores" + (LPF ? " with the Model-1 LPF" : ", no analog LPF")
  + ", with the DAC byte held from its write to the next; every `-dac.wav` is the DAC alone.");
lines.push("");
lines.push("`shipped` = the DAC bytes at the times the machine wrote them. Onsets stay where they are with");
lines.push("no stop — the host's pairs, written on the 68000's clock, place them — but from 60 µs up the");
lines.push("corrector does not repay the stops, so the sample data runs SLOW by them: the cents column.");
lines.push("");
lines.push("`repaid` = an engine that does repay: its sample index stays on the wall clock, so it plays the");
lines.push("`stop0` bytes, and each stop only delays the next slots until a ladder sized to the stop has paid");
lines.push("it back (ideal: no reference error, no quantum). Its cost is the ladder column — cycles a slot");
lines.push("the engine would reserve. Today's ladder is " + TODAY_LADDER + " cycles a lap; the last column says how far behind");
lines.push("it would end up if it carried the debt instead of expiring it.");
lines.push("");
lines.push("Both onset columns are MEASURED: the worst displacement of any PCM onset against `stop0`.");
lines.push("");
lines.push(`WHY THE SHIPPED IMAGE REPAYS THE WRONG AMOUNT: the phase reference is the VDP's H counter, which`);
lines.push(`wraps every scanline (${LINE} Z80 cycles), so a stop is read modulo a line, folded into ±${LINE / 2}`);
lines.push("cycles. The 1,500-master contract is half a line. A 215-cycle stop reads as −13 (the engine is");
lines.push("slowed by 13 MORE cycles), a 358-cycle stop as −98, a 716-cycle stop as +32. The 'line wrap'");
lines.push("column is that prediction from the line length alone; the 'repaid' column is what was measured.");
lines.push("");
lines.push("| stop | cadence | cycles a stop | stops | shipped DAC rate | vs nominal | shipped onsets | corrector repaid / line wrap predicts | shipped interval | repaid: ladder cyc/slot (% of slot) | repaid lag max | repaid onsets | today's ladder, carried: lag at end | files |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const sgn = (x, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
for (const r of rows) {
  const f = Object.entries(r.files).map(([k, p]) => `${k}: \`${basename(p)}\``).join("<br>");
  const q = r.repaid;
  lines.push(`| ${r.us} µs | ${r.hz ? `${r.hz} Hz` : "—"} | ${r.L} | ${r.grabs} | ${r.rate.toFixed(2)} Hz | ${r.cents.toFixed(1)} ct |`
    + ` worst ${sgn(r.shippedOnset.worst)} ms; ${r.shippedOnset.over.length} of ${r.shippedOnset.count} past 5 ms | ${r.L ? `${r.repaidPct.toFixed(0)}% / ${r.predicted.toFixed(0)}%` : "—"} | ${r.gapMin}..${r.gapMax} |`
    + ` ${q ? `${q.perSlot.toFixed(1)} (${q.pct.toFixed(1)}%)` : "—"} | ${q ? `${q.maxLag.toFixed(2)} ms` : "—"} |`
    + ` ${q ? `${sgn(q.onset.worst)} ms` : "—"} | ${q ? `${q.todayEndLag.toFixed(0)} ms` : "—"} | ${f} |`);
}
lines.push("");
lines.push("## What to listen for");
lines.push("");
lines.push("* The hole itself: the DAC holds one byte for L µs, 60 or 120 times a second — a buzz at the");
lines.push("  cadence, louder as L grows, clearest on sustained PCM (open hi-hat, snare tails) and in the");
lines.push("  `-dac.wav` files. Compare each against `stop0`.");
lines.push("* `shipped` at 60 µs and above: onsets on time, but the PCM is FLAT against the FM by the cents");
lines.push("  column, and by a different amount whenever the stop length changes. sin008's PCM is all drums,");
lines.push("  where that is hard to hear; a pitched sample held against an FM note is where it would show.");
lines.push("* `repaid`: onsets on time AND the pitch right; only the holes remain. Against `shipped` this is");
lines.push("  what a longer-wrap phase reference plus a bigger ladder would buy, at the ladder column's cost.");
lines.push("* Nominal rate " + cfg.rateHz.toFixed(2) + " Hz; one Z80 cycle = " + (1e6 / cfg.z80Hz).toFixed(3) + " µs; a slot = " + cfg.periodCycles + " cycles.");
const manifest = join(OUT, "MANIFEST.md");
writeFileSync(manifest, lines.join("\n") + "\n");
console.log(`\nmanifest: ${manifest}`);
