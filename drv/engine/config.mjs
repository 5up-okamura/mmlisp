// The ONE configuration object for the light engine.
// The rule it was built to: "one configuration object generates the Z80, the
// 68k, the JS and the material" — nothing re-derives a clock of its own.
//
// Everything downstream — the generated Z80 source, the emulated machine, the
// analyzer's nominal period, the acceptance thresholds — reads THIS. Nothing
// re-derives a clock from a constant of its own, and nothing here is read from
// an environment variable: a configuration is passed in, hashed, and stamped
// into every artifact it produced.
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

// ── YM2612 registers and ports ─────────────────────────────────────────────
export const YM = {
  addr0: 0x4000, data0: 0x4001, addr1: 0x4002, data1: 0x4003,
  psg: 0x7f11, bank: 0x6000,
  // Registers this engine touches, by name, so no magic number appears in
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

// The engine globals, by offset from glob[0]. Every live byte in the region is
// named here and nowhere else, so two features cannot quietly pick the same
// address.
export const GLOB = {
  csmHi: 0x01,    // u8  CSM ch3 frequency, block/hi
  csmLo: 0x02,    // u8  CSM ch3 frequency, lo
};

// ── THE N-VOICE PAIR PROFILE (plan-pcm-spec.md D1 + D4 study) ──────────────
//
// One to three PCM voices at a fixed pitch class with a 2^k step, and the
// level model D4 asks for: 6 dB RUNGS with the master folded into each voice's
// rung by the 68000, so a voice costs ONE table read and there is no master
// stage. Eight pages: page 0 is silence, page 7 - r is the rung `s * 2^-r` for
// r = 0..6 (unity .. -36 dB) — the reference's PCM_TOTAL_MAX_SHIFT = 7 made
// into tables. Every page takes a SIGNED source byte and returns it BIASED, so
// a sum of voices is a sum of biased terms and the saturating add is the 512 B
// clamp table, cascaded once per extra voice (sat(sat(a+b)+c) — the
// reference's 8-bit saturating add, order and all).
//
// Voice 0's pointer lives in DE'; voices 1 and 2 keep theirs in a self-modified
// `ld hl,nn` inside the mix, so no register the expander or the decode owns is
// taken, and a third voice needs nothing the second did not.
//
// Everything the 68000 tells the engine arrives as ONE ring of 2-byte {op,val}
// pairs it writes and the expander sites consume:
//
//   state  the voices' live and staged state and the expander's variables —
//          everything the block edge and the sites touch by absolute address
//   fifo   128 pairs, a whole page so the consumer's index is `inc l`
export const RAM_NV = (voices) => ({
  size: 0x2000,
  ...(voices >= 2
    ? { code: [0x0000, 0x1100], clamp: [0x1100, 0x1300] }
    : { code: [0x0000, 0x1300] }),
  lut: [0x1300, 0x1b00],    // 8 rung pages (lut.mjs buildRungs)
  phase: [0x1b00, 0x1c00],
  ring: [0x1c00, 0x1d00],
  fifo: [0x1d00, 0x1e00],
  state: [0x1e00, 0x1e60],
  pub: [0x1e60, 0x1e80],
  glob: [0x1f00, 0x1f80],
  stack: [0x1f80, 0x2000],
});
export const NV_LEVELS = 8;
export const NV_MAX_VOICES = 3;

// THE STATE BLOCK LIVES IN THE GLOBALS PAGE, at glob + $30, for two reasons.
// The expander's store handler maps a pair `{op, val}` with op < $22 onto
// `(PCM_STATE + op) := val` — one handler for the rungs, the staged start and
// the generation bumps — so the 68000-writable bytes are the first $22 of the
// block and the Z80's own bytes sit above them, out of any op's reach. And the
// BlastEm probe already logs every Z80 write to $1F00..$1F7F, so the instant the
// engine consumed a command is on the instrument's log for free.
//
// A START OR A STOP IS A GENERATION, NOT A FLAG. A byte the 68000 sets and the
// Z80 clears has a window between the Z80's read and its clear, and a bus grab
// lands at any machine-cycle boundary — a start written in that window would be
// cleared unseen. So the host WRITES A NEW GENERATION into `startGen` (after
// the staged bytes) and the Z80 keeps `lastStart`, acts when they differ, and
// latches the value it read: a bump that lands between the read and the latch
// stays different and is acted on at the next edge.
export const PCM1_BASE_OFF = 0x30;                 // from glob[0]
export const pcm1Base = (cfg) => cfg.ram.glob[0] + PCM1_BASE_OFF;
export const PCM1_OP_LIMIT = 0x22;                 // ops below this are commands
export const PCM1_READY_MARK = 0xd2;

// Where a parked voice reads from: the top PAGE of the sample bank, which the
// exporter fills with silence. It is above every sample's end, so once parked
// the voice re-parks at every edge for ever; and a page rather than 32 bytes
// because a parked voice keeps its step — up to 8 — and reads at most 15 x 8
// bytes past the park point before the next edge re-parks it.
export const PCM1_SILENCE = 0xff00;

// The per-block reservations: nothing is reserved — the edge and the
// expander are all real code.
export const RESERVE_LIGHT = Array.from({ length: 16 }, (_, b) => [b, 0,
  b === 0 ? "the block edge part B — IMPLEMENTED: the staged start applied before the first mix"
  : b === 15 ? "the block edge part A — IMPLEMENTED: the level pages and the park"
  : "free for the decode's pieces and the expander's sites"]);
export const CODE_ESTIMATE_LIGHT = [];

// The N-voice state block, from the same base as the rest (glob + $30). Eight
// 68000-writable bytes a voice from op $01 — the rung page, the staged start
// (source, end, step) and the two generations — so three voices end at $18,
// below PORT ($20). The Z80's own bytes start at $22, out of every op's reach.
export const PCMN = {
  bucket: 0x00,
  level: (v) => 0x01 + 8 * v, stSrc: (v) => 0x02 + 8 * v, stEnd: (v) => 0x04 + 8 * v,
  stStep: (v) => 0x06 + 8 * v, startGen: (v) => 0x07 + 8 * v, stopGen: (v) => 0x08 + 8 * v,
  port: 0x20,
  liveEnd: (v) => 0x22 + 5 * v, lastStart: (v) => 0x24 + 5 * v, lastStop: (v) => 0x25 + 5 * v,
  parkMask: (v) => 0x26 + 5 * v,
  fifoLo: 0x31, ready: 0x32, size: 0x33,
};

// THE LOOP-CAPABLE STATE BLOCK (plan-pcm-spec.md D10, design study 2026-09-17).
// Nine 68000-writable bytes a voice from op $01: the rung page, the staged
// start (source, END), the staged WRAP — where the pointer goes when it
// reaches END: the loop start for a looping note, PCM_SILENCE for a shot or a
// release — and TWO generations: `startGen` (pointer, END and WRAP := the
// staged ones, at the next edge) and `endGen` (END and WRAP only — a RETARGET:
// a loop point moved by a curve, or a note-off that sends the release to the
// sample's end). Three voices end at $1B, below PORT ($20). The Z80's own
// bytes start at $22: the live END and WRAP, the two latched generations, and
// the three masks the edge pieces hand each other.
export const PCMN_L = {
  bucket: 0x00,
  level: (v) => 0x01 + 9 * v, stSrc: (v) => 0x02 + 9 * v, stEnd: (v) => 0x04 + 9 * v,
  stWrap: (v) => 0x06 + 9 * v, startGen: (v) => 0x08 + 9 * v, endGen: (v) => 0x09 + 9 * v,
  port: 0x20,
  liveEnd: (v) => 0x22 + 9 * v, liveWrap: (v) => 0x24 + 9 * v, lastStart: (v) => 0x26 + 9 * v,
  lastEnd: (v) => 0x27 + 9 * v, parkMask: (v) => 0x28 + 9 * v, startMask: (v) => 0x29 + 9 * v,
  applyMask: (v) => 0x2a + 9 * v,
  fifoLo: 0x3d, ready: 0x3e, size: 0x3f,
};

/**
 * Where each voice's block boundary falls inside the 16-sample block. Voice v's
 * edge pieces (STOP, COMPARE, PARK, START) sit at its own four positions, so
 * two voices never share an edge slot: 0/8 for two, 0/5/11 for three.
 */
export const voiceOffsets = (voices, B = 16) =>
  Array.from({ length: voices }, (_, v) => Math.round((v * B) / voices) % B);

/**
 * Build the full configuration. Everything derived lives here so the
 * arithmetic exists exactly once.
 */
export function buildConfig({
  machine = NTSC,
  voices,              // 1..3 PCM voices
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
  // Build the engine's BUDGET: every unimplemented feature's cycles are
  // executed as padding and its RAM is reserved. The code is the same code;
  // what changes is that the schedule now has to survive the finished engine's
  // costs, and the gate measures it doing so.
  complete = false,
  // The per-slot ceiling this build is judged against. §4 and R1 set 79.6% and
  // it is still what a shipped build is measured by. The average is judged
  // separately.
  workTarget = 0.796,
  meanTarget = 0.796,
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
  // timestamp resolution.
  //
  // A constant, predictable wait is not the unpredictable external stall §3.1
  // (R1) says static padding cannot absorb — it can be charged like any other
  // cycle, and it is, so the pad shrinks by it and the period stays exact. The
  // 68000 was spinning in a two-instruction ROM loop while this was measured,
  // so it is the FLOOR: a 68000 doing VDP DMA contends harder.
  windowWait = 3,
  // THE SHIPPED IMAGE. No Timer A/B set-up at boot — the engine keeps no timer
  // and the sequencer owns $24..$27 through the pair stream — and the level
  // family takes SIGNED source bytes, because that is what the sample bank
  // holds (mmb.md §10). Test images keep the biased family the gates were
  // written against.
  production = false,
  signedSource = false,
  // THE N-VOICE PAIR PROFILE (D1/D4 study): `pairs: true` with `complete: true`
  // and 1..3 voices. Its own RAM map (RAM_NV), eight rung pages, no reserve.
  pairs = false,
  // The DAC period in MASTER clocks, and the only rate knob.
  sampleMaster = null,
  // The lap in 16-sample blocks. Default: the shortest lap the group and the
  // block close on (80 samples at 9,987.6 Hz). A lower rate needs a SHORTER lap
  // in blocks to keep the lap under the pumps' spacing (one grab a lap).
  lapBlocks = null,
  // Expander steps a lap (each consumes one pair).
  xpSteps = 16,
  // How many voices, from voice 0, carry the 2^k octave step. The rest read
  // one byte a sample, which is what makes an extra voice cheap.
  stepVoices = null,
  // THE LOOP-CAPABLE EDGE (D10): PCMN_L's state block and the six-piece edge
  // (START-GEN, END-GEN, APPLY, COMPARE, WRAP, START) in place of the
  // four-piece one.
  loops = false,
} = {}) {
  if (!sampleMaster) throw new Error("the DAC period `sampleMaster` (master clocks) is required");
  const p = { name: `m${sampleMaster}`, sampleMaster };

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
  let cycleSlots = lcm(groupSlots, blockSamples);
  if (lapBlocks) {
    const want = lapBlocks * blockSamples;
    if (want % cycleSlots)
      throw new Error(`a lap of ${lapBlocks} blocks does not close on the ${cycleSlots}-sample repeat`);
    cycleSlots = want;
  }

  // Timer B, as a phase reference. Its period in Z80 cycles and in samples.
  const timerBfm = 16 * (256 - timerB);
  const timerBcycles = (timerBfm * machine.fmSampleMaster) / machine.z80Div;
  const timerBsamples = (timerBfm * machine.fmSampleMaster) / p.sampleMaster;
  const timerAcycles = (timerAfm * machine.fmSampleMaster) / machine.z80Div;

  if (!pairs) throw new Error("the engine is the N-voice pair profile: pass `pairs: true`");
  if (!complete) throw new Error("the N-voice pair profile is a complete build");
  if (!(voices >= 1 && voices <= NV_MAX_VOICES)) throw new Error(`the N-voice profile takes 1..${NV_MAX_VOICES} voices`);
  if (!signedSource) throw new Error("the N-voice rung pages take signed source bytes");
  const levels = NV_LEVELS;
  // THE LEAD IS 18, one more than a schedule without the block edge would take,
  // for the same reason 17 was chosen over 16: the block phase decides which
  // slot carries the edge, and with 17 the START piece (156 cycles, before the
  // mix) lands on the last slot of the lap — the one that also pays the
  // loop-back `jp` — at 85.2% of its interval. With 18 that slot is a plain
  // one. One more sample of latency, 0.1 ms.
  if (lead === blockSamples + 1) lead = blockSamples + 2;
  // The light images share ONE map whatever their voice count, so nothing the
  // host or the exporter addresses moves between them (D10 design §1.3).
  const ram = RAM_NV(loops ? NV_MAX_VOICES : voices);
  if ((ram.lut[1] - ram.lut[0]) >> 8 !== levels)
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
  // THE CONFIGURATION IS THE IMAGE'S IDENTITY: `stamp` is a hash of this whole
  // object, and every host-side mirror carries it (build-engine.mjs
  // lightDescriptor -> live/src/engine-images.js and sgdk/mmlispdrv_bin.h).
  // The fields the engine does not vary are pinned here rather than dropped,
  // because a field that leaves the object renames every image built from it.
  const cfg = {
    machine, profile: p, ym: YM, ram, levels, workTarget, meanTarget,
    voices, blockSamples, blocks, lead, csm: false, fmBurst: 0, observeTimerB: false,
    complete, windowWait,
    oneVoice: false, production, signedSource,
    multi: true, xpSteps, voiceOffsets: voiceOffsets(voices, blockSamples),
    stepVoices: stepVoices ?? voices, ...(loops ? { loops: true } : {}),
    reserve: RESERVE_LIGHT,
    codeEstimate: CODE_ESTIMATE_LIGHT,
    correctorBudget: false, command: false, ymWriter: false, csmHost: false,
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
  `MMLISPDRV ${c.stamp} ${c.profile.name} ${c.rateHz.toFixed(2)}Hz`
  + ` period ${c.periodNum}/${c.periodDen} group ${c.groupSlots}x${c.groupCycles}`
  + ` voices ${c.voices} block ${c.blockSamples}`
  // R8 §23.2: the level count, the RAM shape and the ceiling this build was
  // judged against belong to its identity. Two images that differ only in how
  // much work a slot was allowed to carry are not the same artifact.
  + ` levels ${c.levels} lut ${hexAddr(c.ram.lut?.[0])}..${hexAddr(c.ram.lut?.[1])}`
  + `${c.ram.phase ? ` phase ${hexAddr(c.ram.phase[0])}` : ""}`
  + ` work ${(c.workTarget * 100).toFixed(1)}%/${(c.meanTarget * 100).toFixed(1)}%`
  + (c.production ? " production" : "") + (c.signedSource ? " signed-src" : "");

const hexAddr = (v) => (v === undefined ? "-" : `$${v.toString(16).padStart(4, "0")}`);
