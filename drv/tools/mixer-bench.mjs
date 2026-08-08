// P0 gate — measure the voice-outer PCM mixer (docs/driver.md §5.3, §12.4).
//
// The whole 68k/Z80 split rests on an ESTIMATE of what this loop costs, so the
// estimate gets asserted rather than assumed. This generates the mixer for each
// configuration (tools/gen-mixer.mjs), assembles it, runs one full frame in the
// first-party emulator with the cycle counter on, attributes cycles per stage,
// and checks every DAC byte against a JS model of the same mix — so a
// fast-but-wrong loop cannot pass.
//
//   node tools/mixer-bench.mjs [--json] [--rates=175,160,128] [--unroll=1,4]
//
// CAVEAT, and it matters: the emulator charges documented Z80 cycles with NO
// bank-window wait states. Every mix tick reads its sample from 68k ROM through
// that window, so on silicon each tick pays bus arbitration on top. These
// numbers are a FLOOR, and the sample fetch is the instruction most exposed to
// the gap.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./z80asm.mjs";
import { generateBenchImage, VARIANTS } from "./gen-mixer.mjs";
import { Z80Cpu } from "./z80cpu.mjs";

const FRAME_CYCLES = 59736; // 896040 master clocks / 15 — a 59.92 Hz frame
const RAM_SIZE = 0x2000;
const WINDOW = 0x8000;
const PCM_V_SIZE = 8;
const FM_WRITE = 61; // cycles per YM write, driver.md §6.2
const CONSUME_OVERHEAD = 500;
// A typical frame emits ~60 register writes (driver.md §6.2). The mix rate
// ceiling is what is left once those and the consume loop are reserved.
const TYPICAL_WRITES = 60;
const MIX_BUDGET = FRAME_CYCLES - CONSUME_OVERHEAD - TYPICAL_WRITES * FM_WRITE;

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(",").map(Number) : dflt;
};
const RATES = arg("rates", [175, 160, 128]);
const UNROLLS = arg("unroll", [2]);

const tmp = mkdtempSync(join(tmpdir(), "mixbench-"));
function build(variant, R, unroll) {
  const path = join(tmp, `mixer-${variant}-${R}-${unroll}.z80`);
  writeFileSync(path, generateBenchImage({ variant, R, unroll }));
  const built = assemble(path);
  // Shift specialisation × unrolling multiplies code fast; without this the
  // image quietly runs into the mix buffer and the frame never terminates.
  const floor = built.symbols.get("MIXLO");
  if (built.bytes.length > floor) {
    throw new Error(
      `${variant} R=${R} unroll=${unroll}: image ${built.bytes.length} B overruns MIXLO ` +
        `(0x${floor.toString(16)}) — lower the unroll factor`,
    );
  }
  return built;
}

// One realistic voice: a 16 kHz sample played at natural pitch on the mix grid.
const incFor = (r) => Math.floor((16000 / 60 / r) * 65536);

// Deterministic pseudo-random sample data (no Math.random — the bench must be
// reproducible so a cycle change is always a code change).
function makeSamples(n) {
  const out = new Uint8Array(n);
  let x = 0x2f6e2b1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

const toI8 = (b) => (b < 128 ? b : b - 256);

// ── JS model of the generated mixer ────────────────────────────────────────
function modelMix(samples, voices, variant, R) {
  const n = voices.length;
  const buf = new Int32Array(R);
  voices.forEach((v, vi) => {
    let ptr = v.ptr;
    let frac = v.frac;
    for (let t = 0; t < R; t++) {
      const s = toI8(samples[ptr - WINDOW]) >> v.shift; // sra: sign-preserving
      if (variant.startsWith("i8sat")) {
        // signed plane, saturating at every add
        buf[t] = vi === 0 ? s : Math.max(-128, Math.min(127, buf[t] + s));
      } else if (variant === "i8") {
        buf[t] = vi === 0 ? (s ^ 0x80) & 0xff : (buf[t] + s) & 0xff;
      } else {
        const b = (s ^ 0x80) & 0xff;
        buf[t] = vi === 0 ? b : buf[t] + b;
      }
      if (variant.endsWith("nr")) {
        ptr = (ptr + 1) & 0xffff; // pre-resampled: one sample per tick
      } else {
        frac += v.incF;
        const carry = frac > 0xffff ? 1 : 0;
        frac &= 0xffff;
        ptr = (ptr + v.incI + carry) & 0xffff;
      }
    }
  });
  const out = new Uint8Array(R);
  const bias = 128 * (n - 1);
  for (let t = 0; t < R; t++) {
    if (variant.startsWith("i8sat")) out[t] = (buf[t] ^ 0x80) & 0xff;
    else if (variant === "i8") out[t] = buf[t] & 0xff;
    else out[t] = Math.max(0, Math.min(255, buf[t] - bias));
  }
  return out;
}

// How far an 8-bit buffer's output actually lands from sum-then-saturate, on
// the same voices. This is the audible cost of the cheaper buffer, and it is
// zero by construction at 1 and 2 voices: with a single add there is only one
// saturation point either way.
function diffVsWide(samples, voices, variant, R) {
  if (variant.startsWith("i16")) return { diffPct: null, diffMax: 0 };
  const got = modelMix(samples, voices, variant, R);
  const ref = modelMix(samples, voices, variant.endsWith("nr") ? "i16nr" : "i16", R);
  let n = 0;
  let max = 0;
  for (let i = 0; i < R; i++) {
    const d = Math.abs(got[i] - ref[i]);
    if (d) { n++; max = Math.max(max, d); }
  }
  return { diffPct: (n / R) * 100, diffMax: max };
}

// ── One emulated frame ─────────────────────────────────────────────────────
function runFrame({ bytes, symbols }, samples, voices, variant) {
  const ram = new Uint8Array(RAM_SIZE);
  ram.set(bytes, 0);
  const sym = (name) => {
    const v = symbols.get(name);
    if (v === undefined) throw new Error(`missing symbol ${name}`);
    return v;
  };

  const n = voices.length;
  ram[sym("G_NVOICE")] = n;
  const bias = variant.startsWith("i8") ? 0 : 128 * (n - 1);
  ram[sym("G_BIASLO")] = bias & 0xff;
  ram[sym("G_BIASHI")] = (bias >> 8) & 0xff;

  const vbase = sym("VOICES");
  voices.forEach((v, i) => {
    const o = vbase + i * PCM_V_SIZE;
    ram[o + 0] = v.ptr & 0xff;
    ram[o + 1] = (v.ptr >> 8) & 0xff;
    ram[o + 2] = v.frac & 0xff;
    ram[o + 3] = (v.frac >> 8) & 0xff;
    ram[o + 4] = v.incF & 0xff;
    ram[o + 5] = (v.incF >> 8) & 0xff;
    ram[o + 6] = v.incI;
    ram[o + 7] = v.shift;
  });

  const dac = [];
  let ymAddr = -1;
  const cpu = new Z80Cpu({
    read: (a) => {
      a &= 0xffff;
      if (a < RAM_SIZE) return ram[a];
      if (a === 0x4000) return 0; // status: never BUSY
      if (a >= WINDOW) return samples[a - WINDOW] ?? 0;
      return 0xff;
    },
    write: (a, d) => {
      a &= 0xffff;
      if (a < RAM_SIZE) { ram[a] = d; return; }
      if (a === 0x4000) { ymAddr = d; return; }
      if (a === 0x4001 && ymAddr === 0x2a) dac.push(d);
    },
  });
  cpu.pc = 0;

  const ranges = [
    ["first voice", sym("R_FIRST_BEG"), sym("R_FIRST_END")],
    ["added voices", sym("R_ADD_BEG"), sym("R_ADD_END")],
    ["output pass", sym("R_OUT_BEG"), sym("R_OUT_END")],
  ];
  const byStage = new Map();
  let total = 0;
  let steps = 0;
  while (!cpu.halted) {
    const pc = cpu.pc;
    const c = cpu.step();
    total += c;
    const r = ranges.find(([, lo, hi]) => pc >= lo && pc < hi);
    const key = r ? r[0] : "per-frame setup";
    byStage.set(key, (byStage.get(key) ?? 0) + c);
    if (++steps > 5_000_000) throw new Error("mixer did not halt");
  }
  return { total, byStage, dac };
}

// ── Run ────────────────────────────────────────────────────────────────────
const samples = makeSamples(0x8000);

// Three voices at slightly different rates and volumes, so no two passes are
// accidentally identical and the model has to actually track each one.
function makeVoices(n, variant, R) {
  // i8 headroom: fold ceil(log2 n) into every shift so the signed sum cannot
  // overflow one plane (driver.md §5.3).
  const head = variant === "i8" ? Math.ceil(Math.log2(Math.max(1, n))) : 0;
  const inc = incFor(R);
  const base = [
    { ptr: WINDOW + 0x0100, shift: 0 },
    { ptr: WINDOW + 0x1000, shift: 1 },
    { ptr: WINDOW + 0x2000, shift: 2 },
  ];
  return base.slice(0, n).map((v, i) => ({
    ptr: v.ptr,
    frac: 0,
    incF: (inc + i * 3571) & 0xffff,
    incI: (inc + i * 3571) >>> 16,
    shift: Math.min(7, v.shift + head),
  }));
}

const results = [];
for (const unroll of UNROLLS) {
  for (const R of RATES) {
    for (const variant of VARIANTS) {
      const built = build(variant, R, unroll);
      for (let n = 1; n <= 3; n++) {
        const voices = makeVoices(n, variant, R);
        const { total, byStage, dac } = runFrame(built, samples, voices, variant);
        const want = modelMix(samples, voices, variant, R);
        let bad = -1;
        if (dac.length !== R) bad = -2;
        else for (let i = 0; i < R; i++) if (dac[i] !== want[i]) { bad = i; break; }
        results.push({
          unroll, rate: R, hz: R * 60, variant, voices: n,
          image: built.bytes.length,
          cycles: total,
          pct: (total / FRAME_CYCLES) * 100,
          perTick: total / R,
          writes: Math.floor((FRAME_CYCLES - total - CONSUME_OVERHEAD) / FM_WRITE),
          maxR: Math.floor(MIX_BUDGET / (total / R)),
          ...diffVsWide(samples, voices, variant, R),
          byStage: Object.fromEntries([...byStage].sort((a, b) => b[1] - a[1])),
          ok: bad === -1, bad,
          got: bad >= 0 ? dac[bad] : null,
          wanted: bad >= 0 ? want[bad] : null,
        });
      }
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`frame budget ${FRAME_CYCLES} cycles · documented Z80 timing, NO bank-window wait states (a floor)`);
  console.log(`variants: i16 = sum-then-saturate · i8 = 8-bit headroom · i8sat = 8-bit saturating-add · i16nr = pre-resampled\n`);
  console.log(" U    R    kHz  variant  voices    cycles   %frame  cyc/tick  FM writes   max kHz   vs i16  model");
  console.log("-".repeat(100));
  let prev = null;
  for (const r of results) {
    const key = `${r.unroll}/${r.rate}`;
    if (prev && prev !== key) console.log("");
    prev = key;
    console.log([
      String(r.unroll).padStart(2),
      String(r.rate).padStart(5),
      (r.hz / 1000).toFixed(1).padStart(7),
      "  " + r.variant.padEnd(7),
      String(r.voices).padStart(5),
      String(r.cycles).padStart(10),
      `${r.pct.toFixed(0)}%`.padStart(9),
      r.perTick.toFixed(0).padStart(10),
      String(Math.max(0, r.writes)).padStart(11),
      `${(r.maxR * 60 / 1000).toFixed(1)}`.padStart(10),
      (r.diffPct === null ? "—" : `${r.diffPct.toFixed(1)}% /${r.diffMax}`).padStart(9),
      (r.ok ? "  ok" : `  DIVERGES @${r.bad} got ${r.got} want ${r.wanted}`).padStart(7),
    ].join(""));
  }
  console.log(`\n'FM writes' = what is left for the slot's chip writes at ~${FM_WRITE} cycles each (driver.md §6.2).`);
  console.log(`'max kHz'   = the highest mix rate this configuration sustains once ${TYPICAL_WRITES} writes/frame are reserved.`);
  console.log(`'vs i16'    = share of output samples differing from sum-then-saturate, and the largest difference (of 255).`);
  const focus = results.filter((x) => x.voices === 3 && x.rate === RATES[0] && x.unroll === UNROLLS[0]);
  if (focus.length) {
    console.log(`\nWhere the cycles go (3 voices, R = ${RATES[0]}, unroll ${UNROLLS[0]}):`);
    for (const r of focus) {
      const parts = Object.entries(r.byStage)
        .map(([k, v]) => `${k} ${(v / r.rate).toFixed(0)}`)
        .join(" · ");
      console.log(`  ${r.variant.padEnd(6)} ${parts}   (cycles/tick)`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length} case(s) diverge from the model`);
  process.exit(1);
}
