// Is the DAC's SAMPLE CLOCK constant? (driver.md §5.1)
//
//   node tools/dac-clock.mjs [song.mmb | score.mmlisp] [--frames N]
//
// This is the gate the repo did not have, and its absence is why the driver
// could pass everything and still never sound right.
//
//   * every value gate (`c-gate`, `slot-gate`, `engine-gate`) compares the BYTES
//     written to $2A. Identical bytes, wrong clock, is silence to all of them.
//   * `dac-gate` compares TIMING, but in per-frame aggregate: what share of the
//     frame the writes span, and how far a sample lands from its own instant
//     once a constant offset is removed. A feed that runs 40% fast for two
//     thirds of the frame and then stops passes both, because the frame still
//     carries exactly R samples and the spread stays inside the bar.
//
// A DAC does not average. It is a zero-order hold: it reproduces the value it
// was last given until it is given another, so the INTERVAL between writes is
// as much a part of the output as the values are. An interval that moves is
// frequency modulation of everything being played, and at 60 Hz that is
// sidebands on every partial.
//
// So this measures two things and nothing else:
//
//   1. the distribution of the interval between consecutive $2A writes, against
//      the nominal frame/R — the clock itself; and
//   2. what that clock does to a STEADY TONE. It plays a looped sine through
//      the real engine, reconstructs the output as a zero-order hold at the real
//      emission times, and reports the sidebands at multiples of the frame rate
//      — against a reconstruction of the SAME BYTES at a uniform clock, so the
//      only difference between the two is when each byte was written.
//
// There is no pass/fail bar. The numbers are the point: a sideband above the
// carrier is not a tuning problem.
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
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1]) : 240;
const NOSTALL = argv.includes("--no-stall");
const scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const FRAME_CYCLES = 59736, Z80HZ = 3579545, SR = 44100, FRAME_HZ = 59.92;

// The tone case, synthesised here so it needs nothing checked in: 16 whole
// cycles in 256 samples, so the loop is seamless and any sideband in the output
// came from the driver.
function toneScore(dir) {
  const N = 256, RATE = 16000, b = Buffer.alloc(44 + N * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + N * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 16 * i / N) * 30000), 44 + i * 2);
  writeFileSync(join(dir, "sine.wav"), b);
  const src = join(dir, "tone.mmlisp");
  writeFileSync(src,
    `(def tone :sample :file "sine.wav" :loop-start 0 :loop-end ${N})\n`
    + `(pcm1 tone :tempo 120 :mode loop :oct 4 :len 1 :vel 15 c ~ ~ ~ ~ ~ ~ ~)\n`);
  return src;
}

const goertzel = (buf, f) => {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) { const s = buf[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (buf.length / 2);
};
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

const tmp = mkdtempSync(join(tmpdir(), "dacclock-"));
try {
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const { MIXER_PATH, mixerSource, PACE_WINDOW } = await import("./gen-mixer.mjs");
  // The generated mixer goes to the assembler in memory: measuring the engine
  // is a READ, and writing src/mixer.z80 to do it left the tree modified.
  const built = assemble(join(drv, "src", "engine.z80"),
    { sources: { [MIXER_PATH]: mixerSource() } });
  const sym = (n) => built.symbols.get(n);
  const R = sym("PCM_MIX_R");
  const NOMINAL = FRAME_CYCLES / R;
  const stall = NOSTALL ? 0 : PACE_WINDOW;
  console.log(`engine ${built.bytes.length} B · R = ${R} · nominal sample period `
    + `${NOMINAL.toFixed(0)} cyc (${(Z80HZ / NOMINAL / 1000).toFixed(1)} kHz)`
    + `${stall ? ` · $8000 read charged ${stall} cyc` : " · no window stall charged"}`);

  // Run one score and return the $2A stream as [absolute cycle, byte].
  const capture = (score) => {
    let mmb, sampleBank;
    if (score.endsWith(".mmb")) {
      mmb = readFileSync(score);
      const smp = score.replace(/\.mmb$/, ".smp");
      if (!existsSync(smp)) return null;
      sampleBank = readFileSync(smp);
    } else {
      ({ bytes: mmb, sampleBank } = buildMmb(score));
    }
    if (!sampleBank?.length) return null;
    writeFileSync(join(tmp, "s.mmb"), mmb);
    writeFileSync(join(tmp, "s.smp"), sampleBank);
    const out = execFileSync(exe, [join(tmp, "s.mmb"), String(FRAMES), "--samples", join(tmp, "s.smp")],
      { maxBuffer: 1 << 28 });
    const slots = [];
    for (let i = 0; i + 2 <= out.length; ) {
      const n = out[i] | (out[i + 1] << 8); i += 2; slots.push(out.subarray(i, i + n)); i += n;
    }
    const RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
    const ram = new Uint8Array(0x2000); ram.set(built.bytes, 0);
    let bank = 0, cyc = 0, win = 0;
    const addr = [0, 0], ev = [];
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < 0x2000) return ram[a];
        if (a === 0x4000) return 0;
        if (a >= 0x8000) { win++; return sampleBank[bank * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < 0x2000) { ram[a] = d; return; }
        if (a === 0x6000) { bank = ((bank >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
        if (a === 0x4000) { addr[0] = d; return; }
        if (a === 0x4002) { addr[1] = d; return; }
        if (a === 0x4001 && addr[0] === 0x2a) ev.push([cyc, d]); },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) cpu.step();
    let posted = 0, base = 0;
    for (let f = 0; f < slots.length; f++) {
      while (posted < slots.length) {
        const h = ram[sym("H_HEAD")], n = (h + 1) % DEPTH;
        if (n === ram[sym("H_TAIL")]) break;
        ram.fill(0, RING + h * SLOT, RING + h * SLOT + SLOT);
        ram.set(slots[posted++], RING + h * SLOT);
        ram[sym("H_HEAD")] = n;
      }
      // A frame is FRAME_CYCLES of wall clock whatever the engine does inside
      // it. When the engine finishes early it halts, and that halt is dead time
      // the DAC spends holding — so it belongs in the timeline.
      // Monotonic: a frame that overran has already spent past its own vblank,
      // and the next frame starts from where it actually is, not from where the
      // schedule says it should be.
      cyc = Math.max(cyc, base);
      cpu.intRequest();
      let g = 0;
      while (cpu.halted && g++ < 1000) cyc += cpu.step();
      while (!cpu.halted && g++ < 3_000_000) { win = 0; cyc += cpu.step() + win * stall; }
      base += FRAME_CYCLES;
    }
    return ev;
  };

  // ── 1. the clock ─────────────────────────────────────────────────────────
  const clock = (ev, label) => {
    const g = [];
    for (let i = 1; i < ev.length; i++) g.push(ev[i][0] - ev[i - 1][0]);
    const s = [...g].sort((a, b) => a - b);
    const q = (x) => s[Math.floor((s.length - 1) * x)];
    const kHz = (c) => (Z80HZ / c / 1000).toFixed(1);
    console.log(`\n${label} — ${ev.length} samples`);
    console.log(`  interval  min ${q(0)}  p10 ${q(0.1)}  p50 ${q(0.5)}  p90 ${q(0.9)}`
      + `  p99 ${q(0.99)}  max ${q(1)}   (nominal ${NOMINAL.toFixed(0)})`);
    console.log(`  the DAC's instantaneous rate swings ${kHz(q(1))} kHz .. ${kHz(q(0))} kHz`);
    const early = g.filter((x) => x < NOMINAL * 0.9).length;
    const held = g.filter((x) => x > NOMINAL * 1.5).length;
    console.log(`  ${(100 * early / g.length).toFixed(0)}% of samples arrive EARLY (<90% of nominal),`
      + ` ${(100 * held / g.length).toFixed(1)}% are held past 150%`);
    // p50 far from nominal means the loop that produces audio is not being
    // paced at all, and the frame is squaring up elsewhere.
    const off = 100 * (q(0.5) - NOMINAL) / NOMINAL;
    if (Math.abs(off) > 5) {
      console.log(`  ! the MEDIAN interval is ${off.toFixed(0)}% off nominal — the sample clock is not`
        + ` being held; the frame's average is right and its clock is not`);
    }
  };

  // ── 2. what it does to a tone ────────────────────────────────────────────
  const sidebands = (ev) => {
    const span = ev[ev.length - 1][0] - ev[0][0];
    const N = Math.floor(span / Z80HZ * SR);
    const real = new Float64Array(N), ideal = new Float64Array(N);
    const uniform = span / (ev.length - 1);
    let k = 0;
    for (let i = 0; i < N; i++) {
      const t = ev[0][0] + i / SR * Z80HZ;
      while (k + 1 < ev.length && ev[k + 1][0] <= t) k++;
      real[i] = (ev[k][1] - 128) / 128;
    }
    for (let i = 0; i < N; i++) {
      const j = Math.min(ev.length - 1, Math.floor((i / SR * Z80HZ) / uniform));
      ideal[i] = (ev[j][1] - 128) / 128;
    }
    let f0 = 0, best = 0;
    for (let f = 200; f < 4000; f += 0.5) { const m = goertzel(ideal, f); if (m > best) { best = m; f0 = f; } }
    const rRef = db(goertzel(real, f0)), iRef = db(goertzel(ideal, f0));
    console.log(`\n  a steady ${f0.toFixed(0)} Hz tone, sidebands at multiples of the frame rate`);
    console.log(`     offset        real    uniform-clock   (dB relative to the tone)`);
    for (const k2 of [1, 2, 3, 4]) {
      for (const s of [-1, 1]) {
        const f = f0 + s * k2 * FRAME_HZ;
        if (f < 20) continue;
        const r = db(goertzel(real, f)) - rRef, u = db(goertzel(ideal, f)) - iRef;
        console.log(`     f0 ${s > 0 ? "+" : "-"} ${k2}x60Hz  ${r.toFixed(1).padStart(8)}`
          + `  ${u.toFixed(1).padStart(10)}` + (r - u > 6 ? "     <- the clock" : ""));
      }
    }
  };

  if (scores.length) {
    for (const s of scores) {
      const ev = capture(s);
      if (!ev) { console.log(`skip  ${basename(s)} — no sample bank`); continue; }
      clock(ev, basename(s));
    }
  }
  // The tone always runs: it is the case where the answer is unambiguous.
  const ev = capture(toneScore(tmp));
  clock(ev, "steady tone (synthesised)");
  sidebands(ev);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
