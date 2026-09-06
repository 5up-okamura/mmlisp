// Run the dac-stream prototype on BlastEm, and read what the DAC really did
// (docs/dac-engine-implementation.md §10.3 step 3, R1).
//
//   sh drv/blastem/setup.sh                                   # once
//   node drv/experimental/dac-stream/machine-probe.mjs [--case NAME] [--seconds N]
//
// The JS instruction model says the placement arithmetic is right. It cannot
// say anything about bus arbitration, the ROM window, the YM's own timing, or
// what a 68000 taking the bus costs — and §6.4 has been an empty column since
// the prototype started. This fills the emulator half of it.
//
// It is still a model. A green run here is a reason to spend a hardware round,
// not a substitute for one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../tools/z80asm.mjs";
import { buildConfig, stampLine } from "./config.mjs";
import { generate } from "./gen-stream.mjs";
import { buildRom } from "./rom.mjs";
import { mixOne, mixTwo, LEVELS } from "./lut.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const OUT = join(drv, "out", "dac-stream");
const BLAST = join(drv, "out", "blastem");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 5));
const ONLY = arg("case", null);

const core = ["blastem_libretro.dylib", "blastem_libretro.so"]
  .map((f) => join(BLAST, f)).find(existsSync);
const host = join(BLAST, "host");
if (!core || !existsSync(host)) {
  console.error("machine-probe: BlastEm is not built here — run `sh drv/blastem/setup.sh` first");
  process.exit(2);
}

// The §10.3 order: output only, then the mixer, then the 68000 on the bus.
const sine = (n, amp, cycles) => Uint8Array.from({ length: n },
  (_, i) => Math.round(128 + amp * Math.sin((2 * Math.PI * i * cycles) / n)) & 0xff);
const CASES = [
  { name: "output only", cfg: {}, wave: sine(256, 120, 1) },
  { name: "output only + CSM", cfg: { csm: true }, wave: sine(256, 120, 1) },
  { name: "one voice", cfg: { voices: 1 } },
  { name: "two voices", cfg: { voices: 2 } },
  { name: "two voices + CSM", cfg: { voices: 2, csm: true } },
  { name: "2ch complete budget", cfg: { voices: 2, complete: true } },
  { name: "2ch complete budget + CSM", cfg: { voices: 2, complete: true, csm: true } },
  // The 68000 takes the bus on a schedule. `every`/`cycles` are dbra counts —
  // roughly 10 68000 cycles an iteration — so these are orders of magnitude,
  // named as such, not calibrated stall lengths.
  { name: "…with the 68000 taking the bus", cfg: { voices: 2, complete: true },
    grab: { every: 2000, cycles: 40 } },
];

const MCLK = 53693175;
const Z80_DIV = 15;

function runCase(c) {
  const cfg = buildConfig(c.cfg);
  const gen = generate(cfg);
  mkdirSync(OUT, { recursive: true });
  const zpath = join(OUT, `probe-${cfg.stamp}.z80`);
  writeFileSync(zpath, gen.text);
  const built = assemble(zpath);

  // P1 plays a waveform out of Z80 RAM, so it travels inside the image; P2
  // reads its voices through the 68k window, so they travel in the cartridge.
  let samples = null;
  let image = Uint8Array.from(built.bytes);
  if (cfg.voices) {
    samples = new Uint8Array(512);
    samples.set(sine(256, 120, 1), 0);
    samples.set(sine(256, 90, 3), 256);
  } else {
    // P1's waveform lives in Z80 RAM past the end of the assembled image, so
    // the upload has to carry it.
    const end = cfg.ram.wave[1];
    const grown = new Uint8Array(end);
    grown.set(image, 0);
    grown.set(c.wave, cfg.ram.wave[0]);
    image = grown;
  }

  const { rom, sha } = buildRom(image, samples, c.grab ?? null);
  const rpath = join(OUT, `probe-${cfg.stamp}.bin`);
  writeFileSync(rpath, rom);

  const log = join(OUT, `probe-${cfg.stamp}.log`);
  rmSync(log, { force: true });
  const frames = Math.round(SECONDS * 60);
  execFileSync(host, ["--core", core, "--rom", rpath, "--frames", String(frames),
    "--wav", join(OUT, `probe-${cfg.stamp}.wav`)],
    { env: { ...process.env, MMLISP_PROBE_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });

  return { cfg, gen, sha, log, rpath, image };
}

// ── Read the probe log ─────────────────────────────────────────────────────
const KIND = { DAC: 1, GRAB: 2, RELEASE: 3, VINT: 4, DACEN: 5 };
function readLog(path) {
  const buf = readFileSync(path);
  const n = Math.floor(buf.length / 8);
  const dac = [], val = [], grabs = [];
  let open = null;
  for (let i = 0; i < n; i++) {
    const kind = buf[i * 8];
    const v = buf.readUInt16LE(i * 8 + 2);
    const cyc = buf.readUInt32LE(i * 8 + 4);
    if (kind === KIND.DAC) { dac.push(cyc); val.push(v & 0xff); }
    else if (kind === KIND.GRAB) open = cyc;
    else if (kind === KIND.RELEASE && open !== null) { grabs.push([open, cyc]); open = null; }
  }
  return { dac, val, grabs };
}

const q = (s, p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];

console.log(`machine-probe — BlastEm, ${SECONDS}s a case`);
console.log(`  core ${core.split("/").pop()}`);
let failed = 0;
for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const r = runCase(c);
  const { dac, val, grabs } = readLog(r.log);
  if (dac.length < 100) {
    console.log(`FAIL  ${c.name.padEnd(30)} only ${dac.length} $2A writes — the ROM did not run`);
    failed++;
    continue;
  }
  // The 32-bit master clock wraps every ~80 s; a run this long cannot wrap,
  // and the check says so rather than assuming it (§6.2).
  let wrapped = false;
  for (let i = 1; i < dac.length; i++) if (dac[i] < dac[i - 1]) wrapped = true;

  // Skip the upload and the Z80's own boot.
  const t0 = dac[0] + 0.25 * MCLK;
  const t = dac.filter((x) => x >= t0);
  const T = r.cfg.periodCycles * Z80_DIV;      // the period in MASTER clocks
  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const span = t[t.length - 1] - t[0];
  const rate = ((t.length - 1) / span) * MCLK;
  const errPct = ((rate - r.cfg.rateHz) / r.cfg.rateHz) * 100;
  const within = (lo, hi) => gaps.filter((g) => g >= T * lo && g <= T * hi).length / gaps.length;
  const holes = gaps.filter((g) => g > T * 1.5);
  const inGrab = holes.filter((g, i) => {
    const at = t[gaps.indexOf(g) + 1] ?? 0;
    return grabs.some(([a, b]) => b > at - g && a < at);
  });

  const bad = Math.abs(errPct) > 0.1 || within(0.95, 1.05) < 0.999
    || sorted[0] < T * 0.9 || sorted[sorted.length - 1] > T * 1.1 || holes.length || wrapped;
  if (bad && !c.grab) failed++;
  console.log(`${bad ? (c.grab ? "info" : "FAIL") : "ok  "}  ${c.name.padEnd(30)}`
    + ` ${t.length} samples · ${rate.toFixed(2)} Hz (${errPct >= 0 ? "+" : ""}${errPct.toFixed(4)}%)`
    + ` · gap ${sorted[0]}..${sorted[sorted.length - 1]} master (T = ${T.toFixed(1)})`);
  console.log(`      ${(100 * within(0.95, 1.05)).toFixed(4)}% inside 0.95T..1.05T`
    + ` · ${(100 * within(0.9, 1.1)).toFixed(4)}% inside 0.90T..1.10T`
    + ` · p50 ${q(sorted, 0.5)} p99 ${q(sorted, 0.99)}`
    + ` · holes past 1.5T ${holes.length}${holes.length ? ` (${inGrab.length} overlap a bus grab)` : ""}`);
  if (grabs.length) console.log(`      the 68000 held the bus ${grabs.length} times,`
    + ` ${(grabs.reduce((s, [a, b]) => s + (b - a), 0) / MCLK * 1000).toFixed(1)} ms in total,`
    + ` longest ${Math.max(...grabs.map(([a, b]) => b - a))} master`);

  // VALUE — the same reference the JS gate uses, against the machine's bytes.
  if (r.cfg.voices) {
    const src = new Uint8Array(512);
    src.set(sine256(), 0); src.set(sine256b(), 256);
    let firstBad = -1;
    const lead = r.cfg.lead;
    const start = dac.length - t.length;
    for (let i = 1; i < t.length - 1 && firstBad < 0; i++) {
      const j = start + i;
      const want = r.cfg.voices >= 2
        ? mixTwo(src[(j - lead) % 256], LEVELS - 1, src[256 + ((j - lead) % 256)], LEVELS - 1, LEVELS - 1)
        : mixOne(src[(j - lead) % 256], LEVELS - 1, LEVELS - 1);
      if (val[j] !== want) firstBad = j;
    }
    console.log(`      value: ${firstBad < 0 ? "every sample matches the reference"
      : `sample ${firstBad} is ${val[firstBad]}, the reference says otherwise`}`);
  }
  console.log(`      rom ${r.sha} · ${stampLine(r.cfg).slice(0, 96)}`);
}
function sine256() { return sine(256, 120, 1); }
function sine256b() { return sine(256, 90, 3); }
console.log(failed ? `\nFAIL: ${failed} case(s)` : `\nall cases pass on BlastEm`);
process.exit(failed ? 1 : 0);
