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
  phase: [0x1e00, 0x1f00],  // 256 B, page aligned — the calibrated phase table
                            //   the observer's decoder indexes with the raw H
                            //   reading (observer.mjs). DECLARED HERE so the
                            //   overlap check below can see it: it used to be a
                            //   constant in observer.mjs, and nothing noticed
                            //   that its state bytes sat on top of G_STATUS
                            //   (R7 §20.2 B).
  glob: [0x1f00, 0x1f80],   // engine globals
  stack: [0x1f80, 0x2000],  // 128 B, grows down from $2000
};

// The engine globals, by offset from glob[0]. Every live byte in the region is
// named here and nowhere else, so two features cannot quietly pick the same
// address — which is exactly what the observer did.
export const GLOB = {
  status: 0x00,   // u8  last YM status byte read
  csmHi: 0x01,    // u8  CSM ch3 frequency, block/hi
  csmLo: 0x02,    // u8  CSM ch3 frequency, lo
  v0page: 0x03,   // u8  LUT page for voice 0's level
  v1page: 0x04,   // u8  …voice 1's
  mpage: 0x05,    // u8  …and the master's
  observe: 0x08,  // u8  the raw reading, when the observer only keeps it
  decode: 0x10,   // 6 B the phase decoder's state (observer.mjs STATE)
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

// The COMPLETE 2ch version's map (§10.3 step 2, R1: "2ch完成版のRAM、時刻公開、
// 次状態、ノート/ループ/バンク、FM/PSG、コマンド密度を全て予約した配置表を作る。
// 処理がまだ未実装なら上限の根拠を示し、0サイクル・0バイトとして置かない").
//
// Nothing here is speculative space: each region carries the reason for its
// size, and the total is what decides whether the 4 KB level family survives
// integration at all.
export const RAM_P2_FULL = {
  size: 0x2000,
  code: [0x0000, 0x0a00],   // 2560 B — 1,784 built, ~610 estimated for the rest
  clamp: [0x0a00, 0x0c00],  // 512 B — the saturating add
  lut: [0x0c00, 0x1c00],    // 4096 B — 16 levels x 256, voices and master both
  ring: [0x1c00, 0x1d00],   // 256 B — the finished samples
  queue: [0x1d00, 0x1e00],  // 256 B — the command queue, a page so its cursors
                            //   are `inc c` and no wrap is ever tested (§3.7)
  state: [0x1e00, 0x1e40],  // 64 B — 2 voices x (run cursor, blocks left, loop
                            //   target, bank, level) plus the STAGED next state
                            //   §3.5 requires to be separate from the live one
  pub: [0x1e40, 0x1e60],    // 32 B — the output-index snapshot, double buffered,
                            //   with a generation and the 1-byte publish bank
  chip: [0x1e60, 0x1ea0],   // 64 B — FM/PSG shadow and the slot writer's cursor
  glob: [0x1f00, 0x1f80],   // 128 B
  stack: [0x1f80, 0x2000],  // 128 B
};

// The EXPERIMENTAL 15-level profile (R8 §23.2). It exists for one reason: the
// phase observer needs a page-aligned 256 B table and the complete map has no
// free page — 176 B inside the code reservation, 96 B unreserved and 122 B
// inside the globals, none of it aligned (§21.4). Fifteen levels are 3,840 B
// and the page that comes free is the table's, so RING AND EVERYTHING AFTER IT
// DO NOT MOVE. The 512 B clamp is kept.
//
// This is a profile, not a change of default: RAM_P2_FULL is still 16 levels
// and still what a non-observer build gets.
export const RAM_P2_FULL_15 = {
  ...RAM_P2_FULL,
  lut: [0x0c00, 0x1b00],    // 3840 B — 15 levels x 256, k/14 (lut.mjs)
  phase: [0x1b00, 0x1c00],  // 256 B, page aligned — the observer's phase table
};

export const RAM = RAM_P1;

// ── The code the complete 2ch engine still owes ───────────────────────────
// Bytes, estimated the same way the cycles were: from a sketch of the
// instructions, not from a feeling. §10.3 step 2 (R1) forbids leaving an
// unwritten feature at zero, and bytes are the half of that which the cycle
// reservations cannot express — the code region is 2,560 B and the level
// tables have already taken 4 KB of the machine.
export const CODE_ESTIMATE_2CH = [
  ["time publication", 70, "a 32-bit add, five stores into the inactive bank, the bank flip"],
  ["voice run state", 120, "one routine called twice: countdown, branch-free select, stage"],
  ["command dispatch", 220, "record read, a jump table, and the handlers that stage state"],
  ["YM/PSG slot writer", 120, "a queue cursor in a self-modified operand, plus the $2A re-latch"],
  ["block edge part B", 30, "two staged pointers into DE'/IX, inside the mixer's register set"],
  ["call sites", 48, "16 reserved positions x 3 B, replacing pad bytes that are already there"],
];

// ── The per-block cycle reservations ───────────────────────────────────────
// One entry per position in a 16-sample block. These are EXECUTED as padding
// in a `complete` build, so the placement table and the timing gate describe
// the finished 2ch engine rather than the part of it that exists.
//
// Every figure is an instruction-level sketch, not a guess. The sketches are
// in the `why` strings; where one is a rate rather than a cost (the YM writes,
// the command density) the rate it buys is stated, because that is the number
// a score has to live inside.
export const RESERVE_2CH = [
  // b = (slotIndex + lead) mod 16 — the position in the BUILT block, so b = 15
  // is the slot that builds a block's last sample and carries the edge.
  [0, 48, "block edge part B: the two staged source pointers into DE'/IX"],
  [1, 75, "output index: a 32-bit add of 16 with the carry taken unconditionally"],
  [2, 75, "…the snapshot's four index bytes, into the INACTIVE bank"],
  [3, 75, "…a generation byte, then the 1-byte publish bank LAST (3.7)"],
  [4, 75, "…the bank pointer flip, and the slack the sketch is not sure of"],
  [5, 65, "voice 0 run state: blocks-left countdown, loop-or-advance selected"],
  [6, 65, "…branch-free, and the result STAGED rather than applied (3.5)"],
  [7, 65, "voice 1 run state"],
  [8, 65, "…likewise"],
  [9, 73, "one command: read the record, dispatch it, stage what it changes"],
  [10, 72, "…145 cyc a block = 624 commands/s, against ~10 PCM events a frame"],
  [11, 70, "one YM or PSG write: address, data, and the $2A re-latch behind it"],
  [12, 70, "…"],
  [13, 70, "…"],
  [14, 70, "…4 a block = 2,497 writes/s = 41.6 a frame, the shipped driver's typical"],
  [15, 0, "the block edge part A — IMPLEMENTED: the three level pages, 78 cyc"],
];



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
  // Build the COMPLETE 2ch engine's BUDGET: every unimplemented feature's
  // cycles are executed as padding and its RAM is reserved. The code is the
  // same code; what changes is that the schedule now has to survive the
  // finished engine's costs, and the gate measures it doing so.
  complete = false,
  // HOW MANY VOLUME LEVELS, and therefore how big the level family is. 16 is
  // the shipped one (4 KB). 15 is the experimental profile R8 §23.2 authorises
  // so that a page-aligned phase table exists at all; it is a different build
  // with a different RAM map, and it is named in the stamp.
  levels = 16,
  // The per-slot ceiling this build is judged against. §4 and R1 set 79.6% and
  // it is still what a shipped build is measured by; R8 §23.2 raises it FOR THE
  // EXPERIMENTAL PROFILE ONLY, to 83.9%, so the distributed observer can be
  // verified as real code. The average is judged separately and stays at 79.6%.
  workTarget = 0.796,
  meanTarget = 0.796,
  csm = false,         // program CH3 for CSM and issue its writes
  fmBurst = 0,         // FM register writes crowded into ONE slot (§6.3)
  // TIMER B IS OFF BY DEFAULT (§3.2, R1). Reading its overflow flag was the
  // prototype's declared phase reference and it never was one: the reset ->
  // read window is longer than the timer's own period at every cadence tried,
  // so the flag is set every single time and carries no information. It stays
  // available as a YM-traffic load case, and nothing in the normal profile
  // reads it.
  observeTimerB = false,
  // WHAT A READ THROUGH THE 68k WINDOW COSTS, in Z80 cycles on top of the
  // instruction's own time. MEASURED on BlastEm, 2026-09-06, by running the
  // same schedule with 0, 1 and 2 window reads a sample and reading the rate:
  //
  //   window reads a sample   0          1          2
  //   measured rate           9,987.57   9,904.66   9,823.12 Hz
  //   error from nominal      -0.0000%   -0.8301%   -1.6465%
  //   cost a read                        45 master  45 master  = 3 Z80 cycles
  //
  // Perfectly linear, and constant to within the probe's own 42-master-clock
  // timestamp resolution. It replaces a GUESS: the shipped engine's
  // `PACE_WINDOW` is 14 and has never been measured (gen-mixer.mjs says so).
  //
  // A constant, predictable wait is not the unpredictable external stall §3.1
  // (R1) says static padding cannot absorb — it can be charged like any other
  // cycle, and it is, so the pad shrinks by it and the period stays exact. The
  // 68000 was spinning in a two-instruction ROM loop while this was measured,
  // so it is the FLOOR: a 68000 doing VDP DMA contends harder, and that is
  // R1 step 3 stage 4.
  windowWait = 3,
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

  if (levels !== 16 && levels !== 15) throw new Error(`levels must be 16 or 15, not ${levels}`);
  if (levels === 15 && !complete)
    throw new Error("the 15-level profile is the complete 2ch experiment; there is no P1 form of it");
  const ram = complete ? (levels === 15 ? RAM_P2_FULL_15 : RAM_P2_FULL) : voices ? RAM_P2 : RAM_P1;
  if (ram.lut && (ram.lut[1] - ram.lut[0]) >> 8 !== levels)
    throw new Error(`the RAM map has ${(ram.lut[1] - ram.lut[0]) >> 8} level pages, not ${levels}`);
  const regions = Object.entries(ram).filter(([k]) => k !== "size")
    .map(([k, v]) => ({ k, lo: v[0], hi: v[1] })).sort((a, b) => a.lo - b.lo);
  for (const r of regions)
    if (r.lo >= r.hi || r.hi > ram.size) throw new Error(`RAM region ${r.k} is malformed`);
  for (let i = 1; i < regions.length; i++)
    if (regions[i].lo < regions[i - 1].hi)
      throw new Error(`RAM regions ${regions[i - 1].k} and ${regions[i].k} overlap`);

  if (!(workTarget > 0 && workTarget <= 1) || !(meanTarget > 0 && meanTarget <= 1))
    throw new Error("the work targets are fractions of a slot");
  const cfg = {
    machine, profile: p, ym: YM, ram, levels, workTarget, meanTarget,
    voices, blockSamples, blocks, lead, csm, fmBurst, observeTimerB, complete, windowWait,
    reserve: complete ? RESERVE_2CH : null,
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
  + ` TB ${c.timerB} csm ${c.csm ? 1 : 0}`
  // R8 §23.2: the level count, the RAM shape and the ceiling this build was
  // judged against belong to its identity. Two images that differ only in how
  // much work a slot was allowed to carry are not the same artifact.
  + ` levels ${c.levels} lut ${hexAddr(c.ram.lut?.[0])}..${hexAddr(c.ram.lut?.[1])}`
  + `${c.ram.phase ? ` phase ${hexAddr(c.ram.phase[0])}` : ""}`
  + ` work ${(c.workTarget * 100).toFixed(1)}%/${(c.meanTarget * 100).toFixed(1)}%`;

const hexAddr = (v) => (v === undefined ? "-" : `$${v.toString(16).padStart(4, "0")}`);
