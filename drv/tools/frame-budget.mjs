// Does the engine's frame FIT? (driver.md §5.1)
//
//   node tools/frame-budget.mjs [score.mmlisp|score.mmb …] [--frames N]
//
// `npm run dac` measures how evenly the DAC is fed and `npm run mixer` measures
// throughput; neither can answer this one, and the gap cost a hardware round.
// The write pump (§5.1.1) improved every dac-gate number on a busy score while
// taking 17.9% -> 24.6% of that score's frames past 59,659 cycles — which on the
// machine is a lost vblank, a catch-up, and one DAC hiccup apiece (§6.7),
// reported as clicking with the tempo wobbling behind it. Every gate here said
// "ok".
//
// It measures WALL TIME, not work, and the difference is the whole tool. The
// engine emits `chunk` samples a frame on Timer B's clock, and 167 x 358.4 is
// 59,853 cycles — 100.3% of a vblank ALL BY ITSELF. So a frame is not "the work
// it does"; it is the sample clock, plus every cycle of work that does not
// happen to fall inside a gate wait. Modelling the gate as satisfied-on-demand
// (which this did until 2026-08-08) makes waiting free and reports the work
// instead: it read 88% for a song that `dac-gate` put at 110% and that a real
// Mega Drive ran at 134%, and it reported 0.2% of frames over budget while the
// machine was losing a quarter of them. The timer FREE-RUNS here now and the
// engine really waits for it.
//
// So this one measures cycles per frame and nothing else. There is no pass/fail
// bar: what a frame may cost depends on the score, and a patch-dump frame is
// SUPPOSED to run long (the catch-up exists for it). What matters is the SHARE
// of ordinary frames that overrun, and how it moves when the engine changes —
// run it before and after anything that touches the frame.
//
// The ROM-window stall is charged the same way dac-gate charges it: a sample
// fetch through the $8000 window is not a Z80 memory read, and PACE_WINDOW is
// what it costs on the 68000's bus (gen-mixer.mjs). Without the charge this
// times an emulator-shaped frame that hardware never runs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
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
// Build the engine with the write pump forced on, to price the switch without
// editing the source (engine.z80, PUMP_ON).
const PUMP = argv.includes("--pump");
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!scores.length) {
  scores = ["tests/m3-pcm-softmix.mmlisp", "tests/m2-pcmloop.mmlisp", "tests/m3-fm6-pcm.mmlisp"]
    .map((p) => join(drv, p));
}
// 240 frames is four seconds, which characterises a gate score and not a song —
// the frames that overrun are at the loop point and the dense bar. A `.mmb` is
// a real song and gets a minute of it unless told otherwise.
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1])
  : (scores.some((f) => f.endsWith(".mmb")) ? 4000 : 240);

// A NTSC Mega Drive frame is 262 lines x 3420 master clocks = 896,040, and the
// Z80 runs at master/15 — so 59,736 Z80 cycles, not 59,659. 59,659 is
// 3,579,545 / 60, i.e. a 60 Hz frame, while every comment beside it said
// 59.92 Hz. The 77-cycle error is 0.13% and would not matter, except that it
// put the DAC's own clock (166.67 samples x 358.4 = 59,733) just ABOVE the
// frame instead of three cycles below it — which reads as "the sample rate
// cannot fit a frame even with zero work", and that is not true.
const FRAME_CYCLES = 59736;      // 896040 master clocks / 15
// ── The 68000's bus grab, charged by default ────────────────────────────────
// Z80 cycles the 68000 steals each frame by holding the Z80 bus: MMLisp_frame
// takes it to read `tail`, to copy the slot, and to write `head`, and the Z80
// executes NOTHING while it is held. Every harness in this repo writes the slot
// into Z80 RAM as a free array assignment, so this cost was absent from all of
// them — and it is the last thing between what this tool reports and what the
// machine does.
//
// It defaults to 0 because ITS SIZE HAS NEVER BEEN MEASURED. A default of 1000
// was briefly fitted here, on the grounds that it made this tool report 24%
// over budget against a machine losing ~25% of its frames — and that was a
// COINCIDENCE, on a different score. The same machine's `music x256 = 0x0BF`
// puts its real frame at ~80,000 cycles (134% of budget), which no bus grab
// explains and which nothing in this corpus reproduces. A fitted constant that
// matches one number and contradicts the next is worse than an absent one.
//
// So: real, unmeasured, and left at 0. Sweep it with `--stall N` to see how
// much headroom a score has; do not put a number back here without measuring
// the grab itself.
const sIdx = argv.indexOf("--stall");
const STALL = sIdx >= 0 ? Number(argv[sIdx + 1]) : 0;
// `--pace N` overrides what THIS MODEL charges a $8000-window read, and nothing
// else. It defaults to the generator's PACE_WINDOW.
//
// It has to be separate from that constant, because PACE_WINDOW acts in two
// places that pull opposite ways: `padFor` SUBTRACTS `fetches x PACE_WINDOW`
// when it sizes the generated pad, and this file ADDS `winReads x PACE_WINDOW`
// when it times the frame. Lowering the constant therefore grows the pad in the
// ROM while shrinking the model's frame, and the two nearly cancel — sweeping
// it moved a two-voice frame by about 600 cycles when the charge itself is
// 4,667 (333 reads a frame at 14). That reads as "the probe cannot tell",
// which is a property of the sweep and not of the question.
//
// The question is what the MACHINE pays a window read, so the build must be
// held FIXED and only the model swept: flash one ROM, read its `music x256` and
// `lost/s`, then run this at --pace 0 / 7 / 14 and keep whichever reproduces
// them. PACE_WINDOW itself is an estimate that has never been measured.
const pIdx = argv.indexOf("--pace");
const PACE_OVERRIDE = pIdx >= 0 ? Number(argv[pIdx + 1]) : null;
// `--busy N` overrides the YM2612's BUSY time in Z80 cycles. The default is the
// datasheet's 32 internal cycles converted to the Z80's clock; the number the
// CHIP takes has never been measured here, and the engine spins on it after
// every write — 340 times a frame once every sample is gated. It is the largest
// unmeasured cost in the model, which is why it is a knob and not a constant.
const bIdx = argv.indexOf("--busy");
const BUSY_OVERRIDE = bIdx >= 0 ? Number(argv[bIdx + 1]) : null;

const tmp = mkdtempSync(join(tmpdir(), "budget-"));
try {
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const { writeMixer, PACE_WINDOW: PACE_GEN, GATE_CY } = await import("./gen-mixer.mjs");
  // The model's charge only; the generated pad keeps the generator's value.
  const PACE_WINDOW = PACE_OVERRIDE ?? PACE_GEN;
  writeMixer();
  const built = assemble(join(drv, "src", "engine.z80"),
    PUMP ? { defines: { PUMP_ON: 1 } } : {});
  const sym = (n) => built.symbols.get(n);
  const RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
  console.log(`engine ${built.bytes.length} B · write pump `
    + `${sym("PUMP_ON") ? "ON" : "off"}${PUMP ? " (--pump)" : ""} · budget ${FRAME_CYCLES} cyc/frame`
    + (STALL ? ` · 68k bus grab ${STALL} cyc/frame (--stall)` : ""));
  if (PACE_OVERRIDE !== null)
    console.log(`  window read charged ${PACE_WINDOW} cyc (--pace; the generator built the pads at ${PACE_GEN})`);

  for (const score of scores) {
    const name = basename(score);
    let mmb, sampleBank;
    if (score.endsWith(".mmb")) {
      mmb = readFileSync(score);
      const smp = score.replace(/\.mmb$/, ".smp");
      if (!existsSync(smp)) { console.log(`skip  ${name} — no .smp beside it`); continue; }
      sampleBank = readFileSync(smp);
    } else {
      ({ bytes: mmb, sampleBank } = buildMmb(score));
    }
    const mmbPath = join(tmp, "s.mmb"), smpPath = join(tmp, "s.smp");
    writeFileSync(mmbPath, mmb);
    // A score with no PCM still HAS a frame: the slot's chip writes, the
    // sub-slot pacing, the sequencer's own head. Skipping it meant every cycle
    // number in this repo came from a PCM score, and the PCM gate scores are
    // musically trivial — 19 B slots — so the write stream was never measured
    // at any density. An empty bank runs it fine; only PCM commands read one.
    if (!sampleBank?.length) sampleBank = new Uint8Array(0);
    writeFileSync(smpPath, sampleBank);
    const out = execFileSync(exe, [mmbPath, String(FRAMES), "--samples", smpPath], { maxBuffer: 1 << 28 });
    const slots = [];
    for (let i = 0; i + 2 <= out.length; ) {
      const n = out[i] | (out[i + 1] << 8); i += 2; slots.push(out.subarray(i, i + n)); i += n;
    }

    const ram = new Uint8Array(0x2000);
    ram.set(built.bytes, 0);
    let bankReg = 0, cyc = 0, winReads = 0, enableB = false, addr0 = 0;
    // The Timer B gate in Z80 cycles: 2304 YM clocks, one crystal. It FREE-RUNS
    // — `gateAt` is an absolute instant on the monotonic clock, never a delay
    // from wherever the engine happens to be.

    let gateAt = GATE_CY;
    // YM2612 BUSY, from the chip rather than from our own design doc — the
    // mistake that let an unenabled Timer B ship. Nuked-OPN2 holds BUSY for 32
    // INTERNAL cycles after a DATA write (ym3438.c: `write_busy_cnt >> 5`), an
    // internal cycle is 1/24 of an FM sample = 6 YM clocks, and a YM clock is
    // 7/15 of a Z80 one: 32 x 6 x 7/15 = 90 Z80 cycles. The consume loop polls
    // this before every data write (`cr_p0d`/`cr_p1d`/`cs_r27d`), so on the
    // chip those loops SPIN and in every harness here they fell straight
    // through — a frame's worth of writes given away free.
    // Judged on a MONOTONIC counter: `cyc` restarts every frame, so comparing
    // against it made the chip read BUSY at every frame boundary and the poll
    // loops spun until the frame caught up — 13k cycles a call.
    const BUSY_CY = BUSY_OVERRIDE ?? Math.round(32 * 6 * 7 / 15);
    let tcyc = 0, lastData = -1e9;
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < 0x2000) return ram[a];
        // Timer B's overflow flag — the engine's sample clock (§5.1.2) — and
        // BUSY (bit 7), which the engine spins on after every chip write. The
        // timer FREE-RUNS on the monotonic clock and the engine really waits
        // for it, which is the whole point of this tool: see WALL TIME below.
        // ENABLE B ($27 bit 3) gates the flag on the chip — Nuked-OPN2 only ever
        // sets it as `timer_b_overflow & timer_b_enable` (ym3438.c). Modelled
        // here too so this tool cannot report a frame the hardware never runs.
        if (a === 0x4000) return (tcyc - lastData < BUSY_CY ? 0x80 : 0)
          | (enableB && tcyc >= gateAt ? 0x02 : 0);
        if (a >= 0x8000) { winReads++; return sampleBank[bankReg * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < 0x2000) { ram[a] = d; return; }
        if (a === 0x6000) bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff;
        else if (a === 0x4000) addr0 = d;
        else if (a === 0x4001 && addr0 === 0x27) {
          enableB = (d & 0x08) !== 0;
          // The gate's flag reset. The timer free-runs, so the next overflow is
          // the next MULTIPLE of the period, not one period from here — an
          // engine that arrives late does not get a fresh period, it gets
          // whatever is left of the current one.
          if (d & 0x20) while (gateAt <= tcyc) gateAt += GATE_CY;
        }
        if (a === 0x4001 || a === 0x4003) lastData = tcyc; },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) tcyc += cpu.step();

    // ── WALL TIME, with the vblank arriving on its own clock ─────────────────
    // The Z80 gets FRAME_CYCLES of real time per vblank whether it works or
    // halts, and the VDP asserts its /INT for about one scanline. So a frame is
    // not "run until halt and count" — it is:
    //
    //   finishes before the next vblank  -> it halts, idles, takes the next one
    //   still working when it arrives    -> the ISR runs with interrupts off,
    //                                       the window closes, THE FRAME IS LOST
    //
    // Running frames back to back (which this did until 2026-08-08) removes the
    // idle, so the Timer B gate never has real time to advance in and the tool
    // reported a frame that was always behind its clock: 100% of frames over
    // budget where the machine was losing 27% of them. `lost` below is directly
    // comparable to the example program's `lost/s`, and `music` to its
    // `music x256` — which is the only number this tool has ever been trying to
    // predict.
    const INT_WINDOW = 228;   // ~one scanline of asserted /INT, in Z80 cycles
    const IDLE = sym("idle"), IDLE_END = sym("idle_halt");
    let posted = 0, missed = 0, nextVbl = 0;
    const costs = [];
    const postSlots = () => {
      while (posted < slots.length) {
        const head = ram[sym("H_HEAD")], next = (head + 1) % DEPTH;
        if (next === ram[sym("H_TAIL")]) break;
        ram.fill(0, RING + head * SLOT, RING + head * SLOT + SLOT);
        ram.set(slots[posted++], RING + head * SLOT);
        ram[sym("H_HEAD")] = next;
      }
    };
    let vbl = 0;   // real vblanks elapsed — the host's clock, not the engine's
    while (costs.length + missed < slots.length && vbl < 4 * slots.length) {
      // The Z80 sleeps until the vblank actually arrives.
      if (tcyc < nextVbl) tcyc = nextVbl;
      vbl++;
      nextVbl += FRAME_CYCLES;
      // What the host does every real frame (sgdk/mmlispdrv.c MMLisp_frame):
      // top the ring up and stamp the vblank the engine compares against.
      postSlots();
      ram[sym("H_VBL")] = vbl & 0xff;
      const start = tcyc;
      cpu.intRequest();
      let g = 0;
      // A frame is FRAME_CYCLES of wall clock, not "until the CPU halts":
      // the engine feeds the DAC from its idle loop and only halts in a
      // score with no PCM in it. A halted Z80 burns 4-cycle NOPs here,
      // exactly as it waits out the rest of a frame on hardware.
      // The frame's COST is the part the interrupt owns — cycles until the
      // engine first reaches its idle loop. What follows is the DAC feed,
      // which is meant to fill the rest of the frame; counting it would report
      // 100% for every score and say nothing.
      // TWO PHASES, and the split is the whole point of this tool now.
      //
      // Phase 1 runs the INTERRUPT to completion — until the engine reaches its
      // idle loop — with no cycle cap at all. An ISR that needs more than a
      // frame is exactly the failure this reports, and capping the loop at
      // FRAME_CYCLES (which is what "run a frame of wall clock" did) makes that
      // failure invisible: the frame is truncated, the vblank it blew through
      // is never counted, and every score reads 0 lost. It read 0 against a
      // machine losing 12 frames a second.
      //
      // Phase 2 is the idle feed, which fills whatever is left of the frame.
      let fcyc = 0, isr = 0, inIsr = true, left = false;
      while (g++ < 3_000_000 && (inIsr || fcyc < FRAME_CYCLES)) {
        const idling = cpu.pc >= IDLE && cpu.pc < IDLE_END;
        if (!left) { if (!idling) left = true; }
        else if (inIsr && idling) { isr = fcyc; inIsr = false; }
        winReads = 0;
        const c = cpu.step() + winReads * PACE_WINDOW;
        cpu.decay(c);
        tcyc += c; fcyc += c;
        // Blew past a vblank while still inside the ISR: its window closed and
        // that frame is gone. The engine's catch-up (§6.7) picks the slot up
        // later off the H_VBL stamp, which is why `missed` is not simply lost
        // music — but it IS a lost interrupt, and that is what the machine
        // reports as `lost/s`.
        while (tcyc > nextVbl + INT_WINDOW) {
          missed++; vbl++; nextVbl += FRAME_CYCLES;
          postSlots();
          ram[sym("H_VBL")] = vbl & 0xff;
        }
      }
      // The ISR's own length, not the frame's: the DAC feed fills the rest of
      // the frame by design (engine.z80 `idle`), so counting to the vblank
      // would report 100% for every score.
      costs.push((inIsr ? tcyc - start : isr) + STALL);   // the bus the 68000 holds; see STALL
    }
    if (!costs.length) { console.log(`skip  ${name} — no frames`); continue; }
    // The share of INTERRUPTS that ran past their own vblank. That vblank is
    // gone (the VDP's /INT is a pulse), and the catch-up then has to run TWO
    // frames inside the next one — which overruns again on anything but a light
    // score, and settles into a steady loss. It is the number the machine
    // reports as `lost/s`, and this tool could not see it at all while the
    // frame loop stopped at FRAME_CYCLES.
    const isrOver = costs.filter((c) => c > FRAME_CYCLES).length;
    const pct = (q) => [...costs].sort((a, b) => a - b)[Math.floor((costs.length - 1) * q)];
    const over = costs.filter((c) => c > FRAME_CYCLES).length;
    const totalCyc = costs.reduce((t, c) => t + c, 0);
    const share = (100 * over / costs.length).toFixed(1);
    const of = (v) => `${(100 * v / FRAME_CYCLES).toFixed(0)}%`;
    // Per INTERRUPT, not per frame of music: under catch-up (§6.7) one interrupt
    // consumes up to CATCH_MAX frames, so these are two different clocks and
    // saying "frames" here read as a 343% frame when the truth was three frames
    // in one ISR. The per-music-frame cost is the mean below.
    console.log(`  ${name} — ${costs.length} interrupts (${(vbl / 59.92).toFixed(1)} s)`
      + ` · per ISR p50 ${pct(0.5)} (${of(pct(0.5))}) · `
      + `p95 ${pct(0.95)} (${of(pct(0.95))}) · max ${pct(1)} (${of(pct(1))})`);
    // The number to watch. Each one is a vblank the Z80 never sees: the 68k's
    // stamp brings the frame back late (§6.7), the tempo holds, and the DAC
    // hiccups once on the way through.

    // The machine's own two numbers, so a run here can be put beside a photo of
    // the example program's readout without any arithmetic in between.
    //
    // `music` is CONSUMED frames over real vblanks, read from the engine's own
    // H_FRAMES — exactly what `MMLisp_readStats().audible` reports. Counting
    // ISR entries instead reads 26% where the machine says 73%, because the
    // catch-up (§6.7) makes one interrupt consume up to CATCH_MAX frames: the
    // interrupt count and the music's clock are different numbers.
    const consumed = ram[sym("H_FRAMES")] | (ram[sym("H_FRAMES") + 1] << 8);
    const music = consumed / Math.max(1, vbl);
    console.log(`      vs the machine: music x256 ${
      Math.round(music * 256).toString(16).padStart(4, "0")} (${(100 * music).toFixed(0)}%)`
      + ` · ${consumed} frames consumed in ${vbl} vblanks`
      + ` · lost ${(60 * (vbl - consumed) / Math.max(1, vbl)).toFixed(0)}/s`);
    console.log(`      ISR past its own vblank: ${isrOver}/${costs.length} `
      + `(${(100 * isrOver / costs.length).toFixed(1)}%) — each one is a lost interrupt, `
      + `and the catch-up runs two frames inside the next`);
    console.log(`      one frame of MUSIC costs ${(totalCyc / Math.max(1, consumed)).toFixed(0)}`
      + ` cyc (${(100 * totalCyc / Math.max(1, consumed) / FRAME_CYCLES).toFixed(0)}%`
      + ` of a vblank) — over 100% and the music runs slow by exactly that much`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
