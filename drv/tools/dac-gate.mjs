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
//   * the gap between consecutive writes is close to frame / PCM_MIX_R
//
// Tolerances are deliberately loose. Perfect pacing is not the bar — the bar is
// that the DAC is fed at something recognisably like its own sample rate.
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
// exists to catch covers 0.12.
const MIN_SPAN = 0.80;
// And the gap between writes must be within this factor of frame / R.
const GAP_TOL = 1.35;

const tmp = mkdtempSync(join(tmpdir(), "dacgate-"));
let failures = 0;
try {
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const { writeMixer } = await import("./gen-mixer.mjs");
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
    let bankReg = 0, cyc = 0, stamps = [];
    const addr = [0, 0];
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < RAM) return ram[a];
        if (a === 0x4000) return 0;
        if (a >= 0x8000) return smp[bankReg * 0x8000 + (a - 0x8000)] ?? 0;
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

    let posted = 0, worstSpan = 1, worstGap = 0, full = 0;
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
      while (!cpu.halted && g++ < 3_000_000) cyc += cpu.step();
      if (stamps.length < R) continue;          // no full feed this frame
      full++;
      const span = (stamps[stamps.length - 1] - stamps[0]) / FRAME_CYCLES;
      if (span < worstSpan) worstSpan = span;
      const gaps = stamps.slice(1).map((v, i) => v - stamps[i]).sort((a, b) => a - b);
      const median = gaps[gaps.length >> 1];
      const off = Math.max(median / WANT_GAP, WANT_GAP / median);
      if (off > worstGap) worstGap = off;
    }
    if (!full) { console.log(`skip  ${name} — no frame carried a full feed`); continue; }
    const ok = worstSpan >= MIN_SPAN && worstGap <= GAP_TOL;
    const rate = (3579545 / (WANT_GAP * worstGap) / 1000).toFixed(1);
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${name} — ${full} full frames; worst span ` +
      `${(100 * worstSpan).toFixed(0)}% of the frame, worst median gap ${worstGap.toFixed(2)}x ` +
      `intended (~${rate} kHz vs ${(3579545 / WANT_GAP / 1000).toFixed(1)})`,
    );
    if (!ok) failures++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed — the DAC is not being fed at its own rate` : "\nDAC feed paced");
if (failures) process.exit(1);
