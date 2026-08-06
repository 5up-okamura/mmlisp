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

const FRAME_CYCLES = 59659;      // Z80 at 3.579545 MHz, one 59.92 Hz frame

const tmp = mkdtempSync(join(tmpdir(), "budget-"));
try {
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const { writeMixer, PACE_WINDOW } = await import("./gen-mixer.mjs");
  writeMixer();
  const built = assemble(join(drv, "src", "engine.z80"),
    PUMP ? { defines: { PUMP_ON: 1 } } : {});
  const sym = (n) => built.symbols.get(n);
  const RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
  console.log(`engine ${built.bytes.length} B · write pump `
    + `${sym("PUMP_ON") ? "ON" : "off"}${PUMP ? " (--pump)" : ""} · budget ${FRAME_CYCLES} cyc/frame`);

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
    if (!sampleBank?.length) { console.log(`skip  ${name} — no sample bank`); continue; }
    writeFileSync(smpPath, sampleBank);
    const out = execFileSync(exe, [mmbPath, String(FRAMES), "--samples", smpPath], { maxBuffer: 1 << 28 });
    const slots = [];
    for (let i = 0; i + 2 <= out.length; ) {
      const n = out[i] | (out[i + 1] << 8); i += 2; slots.push(out.subarray(i, i + n)); i += n;
    }

    const ram = new Uint8Array(0x2000);
    ram.set(built.bytes, 0);
    let bankReg = 0, cyc = 0, winReads = 0;
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < 0x2000) return ram[a];
        if (a === 0x4000) return 0;                       // status: never BUSY
        if (a >= 0x8000) { winReads++; return sampleBank[bankReg * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < 0x2000) { ram[a] = d; return; }
        if (a === 0x6000) bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff; },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) cpu.step();

    let posted = 0;
    const costs = [];
    for (let f = 0; f < slots.length; f++) {
      while (posted < slots.length) {
        const head = ram[sym("H_HEAD")], next = (head + 1) % DEPTH;
        if (next === ram[sym("H_TAIL")]) break;
        ram.fill(0, RING + head * SLOT, RING + head * SLOT + SLOT);
        ram.set(slots[posted++], RING + head * SLOT);
        ram[sym("H_HEAD")] = next;
      }
      cyc = 0;
      cpu.intRequest();
      let g = 0;
      while (cpu.halted && g++ < 1000) cyc += cpu.step();
      while (!cpu.halted && g++ < 3_000_000) { winReads = 0; cyc += cpu.step() + winReads * PACE_WINDOW; }
      costs.push(cyc);
    }
    if (!costs.length) { console.log(`skip  ${name} — no frames`); continue; }
    const pct = (q) => [...costs].sort((a, b) => a - b)[Math.floor((costs.length - 1) * q)];
    const over = costs.filter((c) => c > FRAME_CYCLES).length;
    const share = (100 * over / costs.length).toFixed(1);
    const of = (v) => `${(100 * v / FRAME_CYCLES).toFixed(0)}%`;
    console.log(`  ${name} — ${costs.length} frames (${(costs.length / 59.92).toFixed(1)} s)`
      + ` · p50 ${pct(0.5)} (${of(pct(0.5))}) · `
      + `p95 ${pct(0.95)} (${of(pct(0.95))}) · max ${pct(1)} (${of(pct(1))})`);
    // The number to watch. Each one is a vblank the Z80 never sees: the 68k's
    // stamp brings the frame back late (§6.7), the tempo holds, and the DAC
    // hiccups once on the way through.
    console.log(`      over budget: ${over}/${costs.length} frames (${share}%) `
      + `— each is a lost vblank, a catch-up, and one DAC hiccup`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
