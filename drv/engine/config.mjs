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
  // THE PUBLICATION REGION IS AT THE SAME ADDRESS IN BOTH PROFILES (R12 §33.2).
  // Not because the layout needs it — `protocolLayout(base)` takes the base
  // from the map — but because the instrument watches one range, and a P1
  // prototype whose snapshot lands somewhere the watch does not cover cannot be
  // scored against the P2 one. The phase table moved to $1B00 to make room; it
  // only ever needed to be page aligned.
  pub: [0x1e40, 0x1e60],    // 32 B — the runtime protocol (protocol.mjs)
  phase: [0x1b00, 0x1c00],  // 256 B, page aligned — the calibrated phase table
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
  stagePad: 0x06, // u8  the byte after the three staged ones. R15's record
                  //     named its target with a 2-bit slot number and could
                  //     reach this; the R16 bundle carries all three values and
                  //     names nothing, so what this byte is for now is the
                  //     check that it NEVER changes (R16 §41.4)
  cmdDump: 0x0b,  // 3 B the consumer's bit bucket. A command that must not be
                  //     applied is stored ANYWAY, into these instead of into
                  //     the staged bytes — one `xor` on the destination's low
                  //     operand is the whole suppression, so the slot has one
                  //     length whatever the queue held (R16 §41.3)
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

// ── THE ONE-VOICE INTEGRATION PROFILE (R28 §63.3 D1, §63.5) ────────────────
//
// One PCM voice at a fixed pitch class with a 2^k step, so the clamp table goes
// (a single voice's sum is itself) and the code region absorbs its 512 B. What
// takes the place of the mailbox and the pop-based writer is ONE ring of 2-byte
// {op,val} pairs the 68000 writes and the expander sites consume (§63.3 D3/D4).
//
//   state  the PCM voice's live and staged state, the expander's variables and
//          its 32-entry dispatch table (64 B) — everything the block edge and
//          the sites touch by absolute address
//   fifo   128 pairs, a whole page so the consumer's index is `inc l`
export const RAM_1V = {
  size: 0x2000,
  code: [0x0000, 0x0c00],   // 3,072 B — the old clamp region is code now
  lut: [0x0c00, 0x1b00],    // 3,840 B — 15 levels x 256, k/14 (lut.mjs)
  phase: [0x1b00, 0x1c00],  // 256 B, page aligned — the observer's phase table
  ring: [0x1c00, 0x1d00],   // 256 B — the finished samples
  fifo: [0x1d00, 0x1e00],   // 256 B — the {op,val} pair ring (R28 §63.3 D3)
  state: [0x1e00, 0x1e60],  // 96 B — reserved for the expander's later needs
  pub: [0x1e60, 0x1e80],    // 32 B — the runtime protocol (protocol.mjs)
                            //   (the PCM state block is in the globals: PCM1)
  glob: [0x1f00, 0x1f80],   // 128 B
  stack: [0x1f80, 0x2000],  // 128 B
};

// The one-voice state block, by offset from state[0]. Every byte the block edge,
// the expander and the 68000 touch by absolute address is named here.
//
// THE STATE LIVES IN THE GLOBALS PAGE, at glob + $30, for two reasons. The
// expander's store handler maps a pair `{op, val}` with op < $22 onto
// `(PCM1_BASE + op) := val` — one handler for the levels, the staged start and
// both generation bumps — so the 68000-writable bytes are the first $22 of the
// block and the Z80's own bytes sit above them, out of any op's reach. And the
// BlastEm probe already logs every Z80 write to $1F00..$1F7F, so the instant the
// engine consumed a command is on the instrument's log for free.
//
// A START OR A STOP IS A GENERATION, NOT A FLAG. A byte the 68000 sets and the
// Z80 clears has a window between the Z80's read and its clear, and a bus grab
// lands at any machine-cycle boundary — a start written in that window would be
// cleared unseen. So the host WRITES A NEW GENERATION into `startGen` (after
// the three staged bytes) and the Z80 keeps `lastStart`, acts when they differ,
// and latches the value it read: a bump that lands between the read and the
// latch stays different and is acted on at the next edge. `stopGen` /
// `lastStop` likewise.
export const PCM1_BASE_OFF = 0x30;                 // from glob[0]
export const pcm1Base = (cfg) => cfg.ram.glob[0] + PCM1_BASE_OFF;
export const PCM1_OP_LIMIT = 0x22;                 // ops below this are commands
export const PCM1 = {
  // ── 68000-writable, one byte per op ($00..$21) ──────────────────────
  bucket: 0x00,     // u8  where op $00 (IDLE) lands: nothing reads it
  level: 0x01,      // u8  the voice's absolute LUT page (host-computed)
  master: 0x02,     // u8  the master's absolute LUT page
  stSrc: 0x03,      // u16 the staged start address, in the window
  stEnd: 0x05,      // u16 the staged end, `sampleEnd - 16 * step`
  stStep: 0x07,     // u8  the staged 2^k step
  startGen: 0x08,   // u8  a NEW value here, after the staged bytes, is a start
  stopGen: 0x09,    // u8  a new value here is a stop at the next edge
  port: 0x20,       // op $20 is PORT — dispatched before the store, never stored
  // ── Z80-owned, above any op's reach ─────────────────────────────────
  liveEnd: 0x22,    // u16 the address the play pointer parks at (D2)
  lastStart: 0x24,  // u8  the startGen it last acted on
  lastStop: 0x25,   // u8  the stopGen it last acted on
  parkMask: 0x26,   // u8  the compare's answer, $ff when the voice parks
  fifoLo: 0x27,     // u8  the expander's consumer index — what the 68000 reads
  ready: 0x28,      // u8  PCM1_READY_MARK once boot is done — the host's go signal
  size: 0x29,
};
export const PCM1_READY_MARK = 0xd2;
export const PCM1_OPS = { IDLE: 0x00, LEVEL: 0x01, MASTER: 0x02, SRC_LO: 0x03, SRC_HI: 0x04,
  END_LO: 0x05, END_HI: 0x06, STEP: 0x07, START: 0x08, STOP: 0x09, PORT: 0x20 };

// Where the parked voice reads from: the top PAGE of the sample bank, which the
// exporter fills with silence (R28 §63.3 D2). It is above every sample's end,
// so once parked the voice re-parks at every edge for ever; and a page rather
// than 32 bytes because a parked voice keeps its step — up to 8 — and reads at
// most 15 x 8 bytes past the park point before the next edge re-parks it.
export const PCM1_SILENCE = 0xff00;

// THE EXPANDER'S SITES (R28 §63.3 D4, step 2). Sixteen steps a lap, each two
// pieces in two slots — A fetches the pair and runs one of three balanced arms
// (RAW / PORT / STORE), B idles the consumed pair, advances the pointer and
// publishes the index — so position p of the 128-pair page is always consumed
// by step p mod 16, at a fixed slot. Three steps a block at (b5,b7) (b9,b10)
// (b11,b12), and one more at (b3,b4) of the block that starts the lap. Nothing
// lands on b6 or b8, where the engine's own CSM pair writes the frequency latch;
// the one A-site pair that straddles them (b5 → b9) is where a producer must
// not place a pitch pair's two halves (see EXPANDER_UNSAFE_PAIR_STARTS).
export const EXPANDER_STEPS = 16;
export const EXPANDER_SITES_PER_BLOCK = [[5, 7], [9, 10], [11, 12]];
export const EXPANDER_EXTRA_SITE = [3, 4];
/** The (A slot, B slot) pairs for one lap, in consumption order. */
export function expanderSites(cfg) {
  const B = cfg.blockSamples, n = cfg.cycleSlots;
  const slotOf = (block, b) => ((block * B + b - cfg.lead) % n + n) % n;
  const list = [];
  for (let block = 0; block < n / B; block++) {
    const at = block === 0 ? [EXPANDER_EXTRA_SITE, ...EXPANDER_SITES_PER_BLOCK] : EXPANDER_SITES_PER_BLOCK;
    for (const [a, b] of at) list.push({ block, ba: a, bb: b, a: slotOf(block, a), b: slotOf(block, b) });
  }
  list.sort((x, y) => x.a - y.a);
  if (list.length !== EXPANDER_STEPS) throw new Error(`${list.length} expander steps, not ${EXPANDER_STEPS}`);
  return list;
}
/** Step indices whose A-site is followed by the CSM pair before the next A-site. */
export const expanderUnsafePairStarts = (cfg) =>
  expanderSites(cfg).map((s, k) => (s.ba === 5 ? k : -1)).filter((k) => k >= 0);

// The per-block reservations of the one-voice engine: nothing is reserved any
// more — the corrector, the edge and the expander are all real code.
export const RESERVE_1V = Array.from({ length: 16 }, (_, b) => [b, 0,
  b === 0 ? "the block edge part B — IMPLEMENTED: the staged start applied before the first mix"
  : b === 15 ? "the block edge part A — IMPLEMENTED: the level pages and the park"
  : "free for the decode's pieces and the expander's sites"]);
export const CODE_ESTIMATE_1V = [];

// ── THE N-VOICE PAIR PROFILE (plan-pcm-spec.md D1 + D4 study) ──────────────
//
// The one-voice pair engine with one to three voices, and the level model D4
// asks for: 6 dB RUNGS with the master folded into each voice's rung by the
// 68000, so a voice costs ONE table read and there is no master stage. Eight
// pages: page 0 is silence, page 7 - r is the rung `s * 2^-r` for r = 0..6
// (unity .. -36 dB) — the reference's PCM_TOTAL_MAX_SHIFT = 7 made into
// tables. Every page takes a SIGNED source byte and returns it BIASED, so a
// sum of voices is a sum of biased terms and the saturating add is the old
// 512 B clamp table, cascaded once per extra voice (sat(sat(a+b)+c) — the
// reference's 8-bit saturating add, order and all).
//
// Voice 0's pointer lives in DE' as in the one-voice engine; voices 1 and 2
// keep theirs in a self-modified `ld hl,nn` inside the mix, so no register
// the expander or the decode owns is taken, and a third voice needs nothing
// the second did not.
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

// The N-voice state block, from the same base as PCM1 (glob + $30). Eight
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
export const PCMN_L_OPS = (v) => ({ LEVEL: 0x01 + 9 * v, SRC_LO: 0x02 + 9 * v, SRC_HI: 0x03 + 9 * v,
  END_LO: 0x04 + 9 * v, END_HI: 0x05 + 9 * v, WRAP_LO: 0x06 + 9 * v, WRAP_HI: 0x07 + 9 * v,
  START: 0x08 + 9 * v, RETARGET: 0x09 + 9 * v });

/**
 * Where each voice's block boundary falls inside the 16-sample block. Voice v's
 * edge pieces (STOP, COMPARE, PARK, START) sit at its own four positions, so
 * two voices never share an edge slot: 0/8 for two, 0/5/11 for three.
 */
export const voiceOffsets = (voices, B = 16) =>
  Array.from({ length: voices }, (_, v) => Math.round((v * B) / voices) % B);

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


// ── The corrector's budget image (R10 §29.5) ───────────────────────────────
//
// The time-publication reservation and the H observer are two mechanisms for
// the same clock problem, and at this stage the engine does not need both. R10
// §29.5 authorises spending one on the other: blocks b1..b4's 75 cycles each go
// to the corrector, and the 70 B of code the publication owed leaves the
// estimate with them. Nothing else moves — voice state, commands, YM/PSG and
// the block edge keep every cycle and every byte.
//
// This is a PROFILE and it is named in the stamp. It is not the finished
// engine's budget: if the shared-origin design turns out to need both the
// observer and a published output index, the whole estimate is redone rather
// than this one quietly promoted.
export const RESERVE_2CH_CORR = RESERVE_2CH.map(([b, cyc, why]) =>
  (b >= 1 && b <= 4
    ? [b, 0, "REPLACED by the bounded corrector (R10 §29.5) — the time publication is not reserved here"]
    : [b, cyc, why]));

export const CODE_ESTIMATE_2CH_CORR =
  CODE_ESTIMATE_2CH.filter(([what]) => what !== "time publication");

// ── The command consumer's own profile (R16 §41.3) ─────────────────────────
//
// The consumer gets the reservation that was made for it and NOTHING ELSE:
// b9 and b10 of every block, `(73 + 72) * 5 = 725` cycles a lap, ten positions.
// b11..b14 keep the YM/PSG slot writer's 280 cycles a block and 120 B — R16
// §41.1 holds them until the host-YM safe-window P1 of §33.6 step 5 answers,
// and a shortfall in step 4 is not allowed to spend step 5's result in advance.
//
// R15's first attempt took six positions and displaced 280 cycles a block. That
// is what this profile refuses to do again: the limit is the reservation, and an
// image that needs more says so as a failure rather than by moving the line.
export const CMD_SLOTS_USED = [9, 10];
export const CMD_REPLACED = [9, 10];
export const RESERVE_2CH_CMD = RESERVE_2CH_CORR.map(([b, cyc, why]) =>
  (CMD_SLOTS_USED.includes(b)
    ? [b, 0, "REPLACED by the real PCM state consumer (R16 §41.3)"] : [b, cyc, why]));

/** What the consumer is allowed to spend, per lap, from its own reservation. */
export const cmdBudgetCycles = (cfg) => RESERVE_2CH_CORR
  .filter(([b]) => CMD_SLOTS_USED.includes(b))
  .reduce((t, [, c]) => t + c, 0) * (cfg.cycleSlots / cfg.blockSamples);

// The dispatch estimate goes: the consumer is real code now, and it is measured
// with everything else in the image.
export const CODE_ESTIMATE_2CH_CMD =
  CODE_ESTIMATE_2CH_CORR.filter(([what]) => what !== "command dispatch");

// ── The Z80 YM writer's own profile (R26 §59.3) ────────────────────────────
//
// b11..b14 — 280 cycles a block, 120 bytes of code — go to real instructions.
// The reservation was written for a shared routine with "a queue cursor in a
// self-modified operand" and a call site at each position; the engine's loop is
// eighty slots of straight-line code, so a call is 27 cycles the 70-cycle
// position does not have and the cursor has no register to live in but SP,
// which a call frame destroys. What replaces the pad is therefore INLINE,
// ELEVEN bytes a site — and 120 bytes buy TEN of the twenty positions, not
// twenty (ym-writer.mjs).
export const YM_SLOTS_USED = [11, 12, 13, 14];
export const YM_CODE_BUDGET = 120;                 // bytes, R16 §41.1
export const RESERVE_2CH_YM = RESERVE_2CH_CMD.map(([b, cyc, why]) =>
  (YM_SLOTS_USED.includes(b)
    ? [b, 0, "REPLACED by the real Z80 YM writer (R26 §59.3)"] : [b, cyc, why]));
export const CODE_ESTIMATE_2CH_YM =
  CODE_ESTIMATE_2CH_CMD.filter(([what]) => what !== "YM/PSG slot writer");

/** What the writer may spend, per BLOCK, from its own reservation. */
export const ymBudgetCycles = () => RESERVE_2CH_CORR
  .filter(([b]) => YM_SLOTS_USED.includes(b)).reduce((t, [, c]) => t + c, 0);

// The two bytes an idle entry writes into instead of the chip. They live in the
// chip region, which is where the slot writer's own state was always going to
// be, and they are what makes "the queue is empty" the same instructions as
// "write this register" rather than a branch (ym-writer.mjs).
export const YM_BUCKET = 0x1e60;



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
  // THE CORRECTOR'S BUDGET PROFILE (R10 §29.5): the time-publication reservation
  // is spent on the bounded corrector instead of being held alongside it. Only
  // legal on a `complete` build, because it is a statement about the complete
  // engine's budget.
  correctorBudget = false,
  // THE COMMAND CONSUMER'S PROFILE (R15 §39.4 step 3): the reserved command pad
  // is replaced by the real fixed-length PCM state consumer, which needs more
  // block positions than were reserved for it. Built on the corrector's image.
  command = false,
  // THE Z80 YM WRITER'S PROFILE (R26 §59.3): b11..b14's reserved pad is
  // replaced by the real writer. Built on the consumer's image, because the
  // question is what the writer costs on top of everything else that is real.
  ymWriter = false,
  // WHO LOADS THE CSM TEST VOICE (R19 §46.3). The Z80 does, out of a table in
  // its own image, unless this says the 68000 will write it before releasing the
  // bus — which takes 161 bytes of test scaffolding out of the engine's code
  // region, where it never belonged.
  csmHost = false,
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
  // THE SHIPPED IMAGE (R28 §63.6 step 4). No Timer A/B set-up at boot — the
  // engine keeps no timer and the sequencer owns $24..$27 through the pair
  // stream — and the level family takes SIGNED source bytes, because that is
  // what the sample bank holds (mmb.md §10). Test images keep the biased
  // family the gates were written against.
  production = false,
  signedSource = false,
  // THE N-VOICE PAIR PROFILE (D1/D4 study): `pairs: true` with `complete: true`
  // and 1..3 voices. Its own RAM map (RAM_NV), eight rung pages, no reserve.
  pairs = false,
  // A DAC period of the caller's own, in master clocks — the study's rate knob.
  // Overrides `profile`.
  sampleMaster = null,
  // The lap in 16-sample blocks. Default: the shortest lap the group and the
  // block close on (80 samples at 9,987.6 Hz). A lower rate needs a SHORTER lap
  // in blocks to keep the lap under the pumps' spacing (one grab a lap).
  lapBlocks = null,
  // Expander steps a lap in the N-voice profile (each consumes one pair).
  xpSteps = 16,
  // How many voices, from voice 0, carry the 2^k octave step. The rest read
  // one byte a sample, which is what makes an extra voice cheap.
  stepVoices = null,
  // The study's level-free variant: no rung page, no master (see gen-stream).
  flatLevel = false,
  // THE LOOP-CAPABLE EDGE (D10): PCMN_L's state block and the six-piece edge
  // (START-GEN, END-GEN, APPLY, COMPARE, WRAP, START) in place of the
  // four-piece one. Multi profile only.
  loops = false,
} = {}) {
  const p = sampleMaster
    ? { name: `m${sampleMaster}`, sampleMaster }
    : PROFILES[profile];
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
  let cycleSlots = voices ? lcm(groupSlots, blockSamples) : groupSlots;
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

  const multi = !!pairs;
  if (loops && !pairs) throw new Error("the loop-capable edge is an N-voice profile variant");
  if (multi) {
    if (!complete) throw new Error("the N-voice pair profile is a complete build");
    if (!(voices >= 1 && voices <= NV_MAX_VOICES)) throw new Error(`the N-voice profile takes 1..${NV_MAX_VOICES} voices`);
    if (command || ymWriter) throw new Error("the N-voice profile has neither the mailbox nor the pop-based writer");
    levels = NV_LEVELS;
    if (!signedSource) throw new Error("the N-voice rung pages take signed source bytes");
  } else if (levels !== 16 && levels !== 15) throw new Error(`levels must be 16 or 15, not ${levels}`);
  if (levels === 15 && !complete)
    throw new Error("the 15-level profile is the complete 2ch experiment; there is no P1 form of it");
  // THE ONE-VOICE INTEGRATION PROFILE (R28 §63): `voices: 1, complete: true`.
  // Fifteen levels, no clamp, the pair FIFO, and the reservations of RESERVE_1V.
  const oneVoice = voices === 1 && complete && !multi;
  if (multi && lead === blockSamples + 1) lead = blockSamples + 2;
  // THE LEAD IS 18 HERE, one more than the two-voice profile's 17, for the same
  // reason 17 was chosen over 16: the block phase decides which slot carries
  // the edge, and with 17 the START piece (156 cycles, before the mix) lands on
  // the last slot of the lap — the one that also pays the loop-back `jp` — at
  // 85.2% of its interval. With 18 that slot is a plain one. One more sample
  // of latency, 0.1 ms.
  if (oneVoice && lead === blockSamples + 1) lead = blockSamples + 2;
  if (oneVoice && levels !== 15)
    throw new Error("the one-voice profile is a 15-level build: its phase table needs the page");
  if (oneVoice && (command || ymWriter))
    throw new Error("the one-voice profile has neither the mailbox nor the pop-based writer (R28 §63.4)");
  const ram = multi ? RAM_NV(voices) : oneVoice ? RAM_1V
    : complete ? (levels === 15 ? RAM_P2_FULL_15 : RAM_P2_FULL) : voices ? RAM_P2 : RAM_P1;
  if (ram.lut && (ram.lut[1] - ram.lut[0]) >> 8 !== levels)
    throw new Error(`the RAM map has ${(ram.lut[1] - ram.lut[0]) >> 8} level pages, not ${levels}`);
  const regions = Object.entries(ram).filter(([k]) => k !== "size")
    .map(([k, v]) => ({ k, lo: v[0], hi: v[1] })).sort((a, b) => a.lo - b.lo);
  for (const r of regions)
    if (r.lo >= r.hi || r.hi > ram.size) throw new Error(`RAM region ${r.k} is malformed`);
  for (let i = 1; i < regions.length; i++)
    if (regions[i].lo < regions[i - 1].hi)
      throw new Error(`RAM regions ${regions[i - 1].k} and ${regions[i].k} overlap`);

  if (correctorBudget && !complete)
    throw new Error("the corrector budget is a statement about the complete 2ch engine");
  if (command && !correctorBudget)
    throw new Error("the command consumer is built on the corrector's budget image");
  if (ymWriter && !command)
    throw new Error("the YM writer is measured on the image the consumer is real in");
  if (!(workTarget > 0 && workTarget <= 1) || !(meanTarget > 0 && meanTarget <= 1))
    throw new Error("the work targets are fractions of a slot");
  const cfg = {
    machine, profile: p, ym: YM, ram, levels, workTarget, meanTarget,
    voices, blockSamples, blocks, lead, csm, fmBurst, observeTimerB, complete, windowWait,
    oneVoice, production, signedSource,
    ...(multi ? { multi, xpSteps, voiceOffsets: voiceOffsets(voices, blockSamples),
      stepVoices: stepVoices ?? voices, ...(flatLevel ? { flatLevel } : {}),
      ...(loops ? { loops: true } : {}) } : {}),
    reserve: oneVoice || multi ? RESERVE_1V : complete
      ? (ymWriter ? RESERVE_2CH_YM : command ? RESERVE_2CH_CMD
        : correctorBudget ? RESERVE_2CH_CORR : RESERVE_2CH) : null,
    codeEstimate: oneVoice || multi ? CODE_ESTIMATE_1V : ymWriter ? CODE_ESTIMATE_2CH_YM
      : command ? CODE_ESTIMATE_2CH_CMD
      : correctorBudget ? CODE_ESTIMATE_2CH_CORR : CODE_ESTIMATE_2CH,
    correctorBudget, command, ymWriter, csmHost,
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
  + ` work ${(c.workTarget * 100).toFixed(1)}%/${(c.meanTarget * 100).toFixed(1)}%`
  // R10 §29.5: which reservation this image spent on the corrector is part of
  // what it is. An image with b1..b4 free is not the same artifact as one that
  // still owes the time publication, and neither is the finished budget.
  + (c.oneVoice ? " one-voice" : "") + (c.production ? " production" : "")
  + (c.signedSource ? " signed-src" : "")
  + (c.correctorBudget ? " budget corr-for-timepub" : "")
  + (c.command ? " +pcm-state-consumer" : "")
  + (c.ymWriter ? " +z80-ym-writer" : "");

const hexAddr = (v) => (v === undefined ? "-" : `$${v.toString(16).padStart(4, "0")}`);
