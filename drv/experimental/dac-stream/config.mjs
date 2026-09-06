// The ONE configuration object for the DAC stream prototype
// (docs/dac-engine-implementation.md §5/P0: "新規ビルド設定は1つの設定オブジェクト
// から、Z80・68k・JS・素材へ生成する").
//
// Everything downstream — the generated Z80 source, the emulated machine, the
// analyzer's nominal period, the acceptance thresholds — reads THIS. Nothing
// re-derives a clock from a constant of its own, and nothing here is read from
// an environment variable: a configuration is passed in, hashed, and stamped
// into every artifact it produced. That is the whole difference from the
// engine's current knobs, where five committed files each remembered whatever
// the last probe run happened to export.
import { createHash } from "node:crypto";

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// ── The machine ────────────────────────────────────────────────────────────
// NTSC Mega Drive. Every clock in the file is an exact integer ratio of the
// master clock; nothing is a rounded Hz figure.
export const NTSC = {
  region: "ntsc",
  masterHz: 53693175,
  z80Div: 15,          // Z80 = master / 15 = 3,579,545 Hz
  ymDiv: 7,            // YM2612 input = master / 7
  fmSampleMaster: 1008, // one FM output sample = 144 YM clocks = 1008 master
  frameMaster: 896040,  // 262 lines x 3420 master clocks
  intPulseZ80: 228,     // /INT is asserted for ONE scanline, then dropped
};

// ── The profile ────────────────────────────────────────────────────────────
// `sampleMaster` is the DAC period in MASTER clocks, and it is the only rate
// knob. 5,376 = 16,128 / 3 — a third of Timer B's shortest period — which is
// how §3.2 names it: the prototype's clock is CYCLES, and Timer B is a phase
// reference at a rationally related rate, not the thing that gates a sample.
export const PROFILES = {
  // ~9,987.6 Hz — the §1 first target.
  p10k: { name: "p10k", sampleMaster: 5376 },
  // ~3,329 Hz — what the shipped engine runs at, for a like-for-like read.
  p3k3: { name: "p3k3", sampleMaster: 16128 },
  // ~13,317 Hz — §1 extension 1. Present so the generator is exercised at a
  // period where the work does NOT fit; it is not a target for P1.
  p13k: { name: "p13k", sampleMaster: 4032 },
};

// ── YM2612 registers and ports ─────────────────────────────────────────────
export const YM = {
  addr0: 0x4000, data0: 0x4001, addr1: 0x4002, data1: 0x4003,
  psg: 0x7f11, bank: 0x6000,
  // Registers this prototype touches, by name, so no magic number appears in
  // the generator.
  R_TIMER_A_HI: 0x24, R_TIMER_A_LO: 0x25, R_TIMER_B: 0x26,
  R_TIMER_CTL: 0x27, R_KEY: 0x28, R_DAC: 0x2a, R_DACEN: 0x2b,
  // $27 bits: 0 Load A, 1 Load B, 2 Enable A, 3 Enable B, 4 Reset A, 5 Reset B,
  // 6-7 CH3 mode (00 normal, 01 multi-frequency, 10 CSM).
  CTL_LOAD_A: 0x01, CTL_LOAD_B: 0x02, CTL_ENA_A: 0x04, CTL_ENA_B: 0x08,
  CTL_RESET_A: 0x10, CTL_RESET_B: 0x20, CTL_CH3_CSM: 0x80,
  ST_FLAG_A: 0x01, ST_FLAG_B: 0x02, ST_BUSY: 0x80,
  // What the chip needs BETWEEN writes, in Z80 cycles — XGM2's hardware
  // measurement as carried in docs/driver.md §5.1. This is a settling time per
  // register range, not a busy flag to poll: the analyzer CHECKS the generated
  // schedule against it and never emits a poll.
  wait: {
    addrToOwnData: 6,
    "0x21-0x2f": 0,   // …except $28
    "0x28": 53,
    "0x30-0x9e": 39,
    "0xa0-0xb6": 22,
  },
};

// ── The prototype's RAM map ────────────────────────────────────────────────
// Z80 RAM is 8 KB. Non-overlap is asserted by buildConfig(), not by reading.
export const RAM_P1 = {
  size: 0x2000,
  code: [0x0000, 0x1a00],   // boot + the generated output loop
  wave: [0x1c00, 0x1d00],   // 256 B, page aligned — P1's known waveform
  glob: [0x1f00, 0x1f80],   // engine globals
  stack: [0x1f80, 0x2000],  // 128 B, grows down from $2000
};

// With a mixer the map changes shape: the volume tables want 16 whole pages and
// the finished-sample ring wants one.
//
// THE RING IS A WHOLE 256-BYTE PAGE, not the three 16-byte blocks §3.3 names as
// its starting candidate, and the reason is that it makes both cursors `inc c`
// / `inc l` with no boundary arithmetic AT ALL — no compare, no reset, no
// branch, and therefore nothing whose cost depends on where in the block the
// engine is. §3.3 asks for load, latency and RAM to be compared before changing
// the count: RAM 256 B against 48, latency IDENTICAL (it is set by the build
// cursor's 16-sample lead, not by the ring's size), and load lower by one
// compare-and-reset every 16 samples. The BLOCK is still 16 samples — it is
// what volume changes and note onsets are quantised to (§3.4, §3.7) — it just
// is not what the ring is made of.
export const RAM_P2 = {
  size: 0x2000,
  code: [0x0000, 0x0a00],   // boot + the loop + the mix routine
  clamp: [0x0a00, 0x0c00],  // 512 B, page aligned — the saturating add (lut.mjs)
  lut: [0x0c00, 0x1c00],    // 16 pages x 256 B — the level family (lut.mjs)
  ring: [0x1c00, 0x1d00],   // 256 B, page aligned — the finished samples
  glob: [0x1f00, 0x1f80],
  stack: [0x1f80, 0x2000],
};

export const RAM = RAM_P1;

/**
 * Build the full configuration. Everything derived lives here so the
 * arithmetic exists exactly once.
 */
export function buildConfig({
  machine = NTSC,
  profile = "p10k",
  voices = 0,          // P1 = 0 (a fixed waveform), P2 = 1..3
  blockSamples = 16,   // §3.3 — the finished-PCM block
  // How far ahead of the play cursor the build cursor runs. 16 would align a
  // built block with a slot block exactly, which puts the block edge in the
  // LAST slot of the 80-slot schedule — the one that also pays the loop-back —
  // and takes that interval from 79.6% to 82.2% of its period, past §4's
  // ceiling, for no reason but arithmetic coincidence. 17 moves the edge one
  // slot earlier and costs one sample of latency (0.1 ms).
  lead = blockSamples + 1,
  blocks = 3,          // §3.3 — playing / finished / under construction
  timerB = 255,        // $26: period = 16 x (256 - TB) FM samples. 255 = shortest
  timerAfm = 64,       // CSM key-on period, in FM samples (Timer A = 1024 - NA)
  csm = false,         // program CH3 for CSM and issue its writes
  fmBurst = 0,         // FM register writes crowded into ONE slot (§6.3)
  // TIMER B IS OFF BY DEFAULT (§3.2, R1). Reading its overflow flag was the
  // prototype's declared phase reference and it never was one: the reset ->
  // read window is longer than the timer's own period at every cadence tried,
  // so the flag is set every single time and carries no information. It stays
  // available as a YM-traffic load case, and nothing in the normal profile
  // reads it.
  observeTimerB = false,
} = {}) {
  const p = PROFILES[profile];
  if (!p) throw new Error(`unknown profile ${profile}`);

  const z80Hz = machine.masterHz / machine.z80Div;
  const fmSampleHz = machine.masterHz / machine.fmSampleMaster;
  // The DAC period in Z80 cycles — a RATIO, never rounded. 5376/15 = 358.4.
  const periodNum = p.sampleMaster;
  const periodDen = machine.z80Div;
  const periodCycles = periodNum / periodDen;
  const rateHz = machine.masterHz / p.sampleMaster;

  // How many samples it takes for the period to become a whole number of Z80
  // cycles. THIS is the repeat unit of the static schedule, and it is why the
  // average carries no drift at all: the group is exact, so error cannot
  // accumulate across groups — only inside one.
  const groupSlots = periodDen / gcd(periodNum, periodDen);
  const groupCycles = (periodNum * groupSlots) / periodDen;
  if (!Number.isInteger(groupCycles)) throw new Error("group is not a whole number of cycles");

  // Bresenham the group's cycles over its slots: every slot is within one
  // cycle of the exact period and the group closes on it exactly.
  const slotCycles = [];
  for (let i = 0; i < groupSlots; i++)
    slotCycles.push(Math.floor(((i + 1) * groupCycles) / groupSlots)
      - Math.floor((i * groupCycles) / groupSlots));

  // The static schedule's full repeat: the group pattern and the block pattern
  // have to close together, or the unrolled code is not periodic.
  const lcm = (a, b) => (a / gcd(a, b)) * b;
  const cycleSlots = voices ? lcm(groupSlots, blockSamples) : groupSlots;

  // Timer B, as a phase reference. Its period in Z80 cycles and in samples.
  const timerBfm = 16 * (256 - timerB);
  const timerBcycles = (timerBfm * machine.fmSampleMaster) / machine.z80Div;
  const timerBsamples = (timerBfm * machine.fmSampleMaster) / p.sampleMaster;
  const timerAcycles = (timerAfm * machine.fmSampleMaster) / machine.z80Div;

  const ram = voices ? RAM_P2 : RAM_P1;
  const regions = Object.entries(ram).filter(([k]) => k !== "size")
    .map(([k, v]) => ({ k, lo: v[0], hi: v[1] })).sort((a, b) => a.lo - b.lo);
  for (const r of regions)
    if (r.lo >= r.hi || r.hi > ram.size) throw new Error(`RAM region ${r.k} is malformed`);
  for (let i = 1; i < regions.length; i++)
    if (regions[i].lo < regions[i - 1].hi)
      throw new Error(`RAM regions ${regions[i - 1].k} and ${regions[i].k} overlap`);

  const cfg = {
    machine, profile: p, ym: YM, ram,
    voices, blockSamples, blocks, lead, csm, fmBurst, observeTimerB,
    z80Hz, fmSampleHz, rateHz,
    periodNum, periodDen, periodCycles,
    groupSlots, groupCycles, slotCycles, cycleSlots,
    frameCycles: machine.frameMaster / machine.z80Div,
    samplesPerFrame: machine.frameMaster / p.sampleMaster,
    timerB, timerBfm, timerBcycles, timerBsamples,
    timerAfm, timerAcycles, timerAna: 1024 - timerAfm,
  };
  cfg.stamp = createHash("sha256").update(JSON.stringify(cfg,
    (k, v) => (k === "stamp" ? undefined : v))).digest("hex").slice(0, 12);
  return cfg;
}

/** One line that identifies a build, for stamping into every artifact. */
export const stampLine = (c) =>
  `DAC-STREAM ${c.stamp} ${c.profile.name} ${c.rateHz.toFixed(2)}Hz`
  + ` period ${c.periodNum}/${c.periodDen} group ${c.groupSlots}x${c.groupCycles}`
  + ` voices ${c.voices} block ${c.blockSamples}`
  + ` TB ${c.timerB} csm ${c.csm ? 1 : 0}`;
