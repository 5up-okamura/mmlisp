// The DAC feed must be PACED, not burst (driver.md §5.1).
//
//   node tools/dac-gate.mjs [score.mmlisp …] [--frames N]
//
// Every other gate in this repo compares sample VALUES — the mixer's arithmetic,
// the resampler's indexing, the loop points. None of them can see WHEN a value
// is written, and that blind spot cost three hardware bring-up rounds: the
// engine computed a frame of perfectly correct samples and then emitted all 175
// of them in 13% of the frame, so the DAC ran ~8x fast in bursts with a DC hold
// between. Byte-identical, and unlistenable.
//
// So this gate measures timing and nothing else. It runs the real engine over a
// real score and checks, for every frame that carries a full feed:
//
//   * the writes SPAN the frame (a burst is the failure being guarded against)
//   * every sample lands close to its own instant in the frame
//
// Tolerances are deliberately loose. Perfect pacing is not the bar — the bar is
// that the DAC is fed at something recognisably like its own sample rate.
//
// And the bar is a SHARE of frames, not every frame, because a frame's cost is
// not uniform: the one that starts a score carries the patch dump, and one that
// crosses a loop point runs several times as many mixer segments as its
// neighbours. Those frames spend cycles the pad then cannot give back, and the
// feed compresses into what is left. The burst this gate exists to catch was
// every frame of every score, so a share is enough to catch it, and it is the
// honest bar for a driver whose frame is nearly full (driver.md §5.1).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";
import { buildMmb } from "./mmb-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const fIdx = argv.indexOf("--frames");
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1]) : 240;
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!scores.length) {
  scores = ["tests/m3-pcm-softmix.mmlisp", "tests/m2-pcmloop.mmlisp", "tests/m3-pcm-slice.mmlisp"]
    .map((p) => join(drv, p));
}

const FRAME_CYCLES = 59659;      // Z80 at 3.579545 MHz, 59.92 Hz
// A frame's writes must cover at least this much of it. The burst this gate
// exists to catch covers 0.12. Loose on purpose: WANDER below is the real bar,
// and it already sees a feed that finishes early — this one is here so a
// pathological burst fails on both counts and reads unambiguously.
const MIN_SPAN = 0.70;
// And no sample may land more than this share of a frame from its own time,
// once the feed's constant offset is taken out (see WANDER below). The burst
// reads 0.88. This bar is set where the engine's own per-frame overhead puts it:
// ~14k cycles a frame go on mixer segment set-up, outside the paced loop, and
// the feed has to run that much faster in between to end the frame on time
// (driver.md §5.1). Cutting THAT is what tightens this number — not retuning it.
//
// 0.05 of it is the ROM-window stall, priced in when the harness started
// charging it — and its shape is forced, not tunable: the stall lands on the
// SOUNDING third of the feed (+PACE_WINDOW a sample, R/3 x 14 = ~800 cycles of
// drift by the pass boundary), while the debt can only give it back from the
// SILENT passes, which run last (their pads are the frame's one reservoir, and
// running them last is what makes the segment count a measurement — engine.z80
// pp_feed). One debt unit across two silent passes returns 16 x 2R/3 = ~1,870
// cycles, so the error swings +800 then -1,870: ~0.045 of the frame, measured
// as +0.5 ms on every PCM score the day the charge landed. The alternative is
// not charging at all, which reads 0.05 better here and loses 2-3 whole frames
// a second on hardware. Same rule as above: cutting the mixer's real cost is
// what tightens this — not retuning it.
const MAX_WANDER = 0.31;
// Share of feeding frames that must meet both.
const MIN_OK = 0.95;

const tmp = mkdtempSync(join(tmpdir(), "dacgate-"));
let failures = 0;
try {
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const { writeMixer, PACE_WINDOW } = await import("./gen-mixer.mjs");
  writeMixer();
  const built = assemble(join(drv, "src", "engine.z80"));
  const sym = (n) => built.symbols.get(n);
  const R = sym("PCM_MIX_R");
  const WANT_GAP = FRAME_CYCLES / R;

  for (const score of scores) {
    const name = basename(score);
    const { bytes: mmb, sampleBank } = buildMmb(score);
    const mmbPath = join(tmp, "s.mmb"), smpPath = join(tmp, "s.smp");
    writeFileSync(mmbPath, mmb);
    if (!sampleBank?.length) { console.log(`skip  ${name} — no sample bank`); continue; }
    writeFileSync(smpPath, sampleBank);
    const out = execFileSync(exe, [mmbPath, String(FRAMES), "--samples", smpPath], { maxBuffer: 1 << 28 });
    const slots = [];
    for (let i = 0; i + 2 <= out.length; ) {
      const n = out[i] | (out[i + 1] << 8); i += 2; slots.push(out.subarray(i, i + n)); i += n;
    }

    const RAM = 0x2000, RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
    const ram = new Uint8Array(RAM); ram.set(built.bytes, 0);
    const smp = sampleBank;
    // The harness charges PACE_WINDOW cycles on every read through the $8000
    // window, because that is what a sample fetch costs on hardware over the
    // 68000's bus and what the engine's pace_win_tab budgets the pad for
    // (gen-mixer.mjs). Without the charge this gate times an emulator-shaped
    // frame the pad is deliberately NOT tuned to, and fails the real thing.
    let bankReg = 0, cyc = 0, stamps = [], winReads = 0;
    const addr = [0, 0];
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < RAM) return ram[a];
        if (a === 0x4000) return 0;
        if (a >= 0x8000) { winReads++; return smp[bankReg * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < RAM) { ram[a] = d; return; }
        if (a === 0x6000) { bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
        if (a === 0x4000) { addr[0] = d; return; }
        if (a === 0x4002) { addr[1] = d; return; }
        if (a === 0x4001 && addr[0] === 0x2a) stamps.push(cyc); },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) cpu.step();

    let posted = 0;
    const spans = [], gaps = [];
    for (let f = 0; f < slots.length; f++) {
      while (posted < slots.length) {
        const head = ram[sym("H_HEAD")], next = (head + 1) % DEPTH;
        if (next === ram[sym("H_TAIL")]) break;
        ram.fill(0, RING + head * SLOT, RING + head * SLOT + SLOT);
        ram.set(slots[posted++], RING + head * SLOT);
        ram[sym("H_HEAD")] = next;
      }
      stamps = []; cyc = 0;
      cpu.intRequest();
      let g = 0;
      while (cpu.halted && g++ < 1000) cyc += cpu.step();
      while (!cpu.halted && g++ < 3_000_000) { winReads = 0; cyc += cpu.step() + winReads * PACE_WINDOW; }
      if (stamps.length < R) continue;          // no full feed this frame
      spans.push((stamps[stamps.length - 1] - stamps[0]) / FRAME_CYCLES);
      // WANDER: how far a sample lands from where it belongs, as a share of the
      // frame. Sample i should be written at i x frame/R; the whole feed sitting
      // late by a constant is just the slot consume in front of it and is
      // inaudible, so what counts is the SPREAD of that error, not its offset.
      // The burst reads 0.88 here. This is the metric that matters: gaps only
      // describe the instantaneous rate, and a feed can hold the right average
      // rate while a sample still lands two milliseconds from its own time.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < R; i++) {
        const e = stamps[i] - i * WANT_GAP;
        if (e < lo) lo = e;
        if (e > hi) hi = e;
      }
      gaps.push((hi - lo) / FRAME_CYCLES);
    }
    const full = spans.length;
    if (!full) { console.log(`skip  ${name} — no frame carried a full feed`); continue; }
    const good = spans.filter((s, i) => s >= MIN_SPAN && gaps[i] <= MAX_WANDER).length;
    const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)];
    const share = good / full;
    const ok = share >= MIN_OK;
    const ms = (v) => (1000 * v / 59.92).toFixed(2);
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${name} — ${full} full frames, ${(100 * share).toFixed(0)}% paced; ` +
      `span ${(100 * pct(spans, 0.5)).toFixed(0)}% of the frame (worst ${(100 * pct(spans, 0)).toFixed(0)}%), ` +
      `wander ${ms(pct(gaps, 0.5))} ms (worst ${ms(pct(gaps, 1))})`,
    );
    if (!ok) failures++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed — the DAC is not being fed at its own rate` : "\nDAC feed paced");
if (failures) process.exit(1);
