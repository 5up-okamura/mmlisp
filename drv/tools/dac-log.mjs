// What the DAC's clock actually did, from the emulator's own record of it.
//
//   MMLISP_PROBE_LOG=out/probe.log node tools/blastem-probe.mjs <score> ...
//   node tools/dac-log.mjs out/probe.log
//
// The engine's job is to write $2A every PCM_TICK_CY cycles, for ever. Whether
// it does is not visible in `music x256` — that counts FRAMES, and a frame can
// be perfectly on time while the samples inside it are not (plan-68k-split.md,
// 2026-08-29: "music x256 0100 (100%) ... and it still sounds badly unstable").
// On a percussion track an uneven sample clock is indistinguishable from tempo
// wobble by ear, which is why it was misdiagnosed as one for several rounds.
//
// So this reports the INTERVALS, and three things about them:
//
//   the distribution   — a clock that is right has no tail
//   the holes          — stretches longer than a sample period, and where in
//                        the frame they fall. Every one of them is the DAC
//                        holding its last value: a step, at 60 Hz, which is
//                        the sideband.
//   the deficit        — samples the frame owed against samples it sent. This
//                        is the number that says whether the rate is real.
//
// The log is written by drv/blastem/probe.patch. All cycles in it are MASTER
// clocks; everything below is in Z80 cycles, because that is the unit the
// engine's own budget is written in.
import { readFileSync } from "node:fs";

const MCLK_NTSC = 53693175;
const MCLKS_PER_Z80 = 15;
const KIND = { DAC: 1, GRAB: 2, RELEASE: 3, VINT: 4, DACEN: 5 };

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("usage: node tools/dac-log.mjs <probe.log> [--skip N] [--rate HZ]");
  process.exit(2);
}
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
// The first second is bring-up: the Z80 image is uploaded, the score is parsed,
// the tracks are started. Measuring it says nothing about the steady state and
// its one enormous hole swamps every percentile.
const SKIP_S = arg("--skip", 1);

const buf = readFileSync(path);
const n = Math.floor(buf.length / 8);
const dac = [], vint = [], grab = [];
for (let i = 0; i < n; i++) {
  const kind = buf[i * 8], cyc = buf.readUInt32LE(i * 8 + 4);
  if (kind === KIND.DAC) dac.push(cyc);
  else if (kind === KIND.VINT) vint.push(cyc);
  else if (kind === KIND.GRAB) grab.push(cyc);
  else if (kind === KIND.RELEASE) grab.push(-cyc);
}
if (dac.length < 2) { console.error("dac-log: no $2A writes in the log"); process.exit(1); }

const t0 = dac[0] + SKIP_S * MCLK_NTSC;
const w = dac.filter((c) => c >= t0);
const span = w[w.length - 1] - w[0];
const seconds = span / MCLK_NTSC;
const measured = (w.length - 1) / seconds;

// The nominal rate: taken from the log unless given, because a probe run and
// the tree it was built from can disagree and the log is the one that happened.
const NOMINAL = arg("--rate", 0) || Number(process.env.PCM_RATE ?? 0)
  || Math.round(MCLK_NTSC / 7 / 2304 * (Number(process.env.PCM_SPG ?? 1)));
const period = MCLK_NTSC / NOMINAL / MCLKS_PER_Z80;   // Z80 cycles a sample

const iv = [];
for (let i = 1; i < w.length; i++) iv.push((w[i] - w[i - 1]) / MCLKS_PER_Z80);
const sorted = [...iv].sort((a, b) => a - b);
const pct = (q) => sorted[Math.floor((sorted.length - 1) * q)];

console.log(`dac-log: ${path}`);
console.log(`  ${w.length} writes over ${seconds.toFixed(2)} s (first ${SKIP_S}s skipped as bring-up)`);
console.log(`  rate     ${measured.toFixed(0)} Hz measured · ${NOMINAL} Hz nominal`
  + `  → ${(100 * measured / NOMINAL).toFixed(1)}% of the samples the clock owed`);
console.log(`  interval ${period.toFixed(1)} cyc nominal · p05 ${pct(0.05).toFixed(0)}`
  + ` · p50 ${pct(0.5).toFixed(0)} · p95 ${pct(0.95).toFixed(0)} · max ${pct(1).toFixed(0)}`);

// ── Holes ──────────────────────────────────────────────────────────────────
// A gap of more than 1.5 periods is the DAC holding its last value for at least
// one whole sample it should have moved on from. Counted in PERIODS LOST rather
// than in gaps, because one 4-period hole and four 1-period ones are not the
// same defect.
const HOLE = 1.5 * period;
const holes = iv.map((v, i) => ({ v, at: w[i] })).filter((h) => h.v > HOLE);
const lost = holes.reduce((t, h) => t + (h.v / period - 1), 0);
const frames = Math.max(1, seconds * 59.9227);
console.log(`  holes    ${(holes.length / frames).toFixed(2)} a frame`
  + ` · ${(lost / frames).toFixed(2)} sample periods lost a frame`
  + ` · worst ${(pct(1) / period).toFixed(1)} periods`);

// ── Where in the frame ─────────────────────────────────────────────────────
// The interval by tenth of the frame. A clock that is even is flat here; a
// clock whose work does not fit is long at one end and catching up at the
// other, and that sawtooth IS the 60 Hz sideband. Nothing else in this file
// says WHERE to look.
if (vint.length > 2) {
  const vb = vint.filter((c) => c >= w[0] && c <= w[w.length - 1]).sort((a, b) => a - b);
  if (vb.length > 2) {
    const bins = Array.from({ length: 10 }, () => ({ sum: 0, n: 0 }));
    let vi = 0;
    for (let i = 1; i < w.length; i++) {
      while (vi + 1 < vb.length && vb[vi + 1] <= w[i - 1]) vi++;
      const start = vb[vi], next = vb[vi + 1];
      if (!next || w[i - 1] < start) continue;
      const f = (w[i - 1] - start) / (next - start);
      if (f < 0 || f >= 1) continue;
      const b = bins[Math.floor(f * 10)];
      b.sum += (w[i] - w[i - 1]) / MCLKS_PER_Z80; b.n++;
    }
    const cells = bins.map((b) => b.n ? (b.sum / b.n).toFixed(0).padStart(5) : "    -");
    console.log(`  by tenth of the frame (nominal ${period.toFixed(0)}):`);
    console.log(`   ${cells.join("")}`);
  }
}

// ── The 68000's bus grabs ──────────────────────────────────────────────────
// The Z80 executes NOTHING while the 68000 holds its bus, so every one of these
// is a stretch the sample clock cannot be served in. Reported because the model
// (tools/frame-budget.mjs) charges a FIXED cost once a frame, and this is the
// measurement that says whether that shape is right.
const spans = [];
for (let i = 1; i < grab.length; i++)
  if (grab[i - 1] > 0 && grab[i] < 0 && -grab[i] >= t0)
    spans.push((-grab[i] - grab[i - 1]) / MCLKS_PER_Z80);
if (spans.length) {
  const ss = [...spans].sort((a, b) => a - b);
  const total = spans.reduce((t, c) => t + c, 0);
  console.log(`  68k grab ${(spans.length / frames).toFixed(1)} a frame`
    + ` · ${(total / frames).toFixed(0)} cyc a frame held`
    + ` · p50 ${ss[Math.floor(ss.length / 2)].toFixed(0)}`
    + ` · max ${ss[ss.length - 1].toFixed(0)}`);
}
