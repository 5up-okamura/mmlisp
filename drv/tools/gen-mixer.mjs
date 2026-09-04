// Generator for the post-split voice-outer PCM mixer (docs/driver.md §5.3).
//
// Same pattern as gen-tables.mjs: the asm is generated, not hand-maintained,
// because the loop has to exist in 10 copies (8 shifts, mute, idle) × 2 roles,
// unrolled, in two lengths. Writing 40 near-identical loops by hand would be
// unreadable and unmaintainable; here each loop body appears ONCE, as a
// documented template — and the generator can then PRICE what it emits, which
// is what the pacing pad is computed from.
//
//   node tools/gen-mixer.mjs            → writes src/mixer.z80 (default config)
//   node tools/gen-mixer.mjs --help     → options
//
// Three optimisations over the first P0 prototype, all measured by
// tools/mixer-bench.mjs:
//
//  1. SHIFT SPECIALISATION. The per-voice attenuation is `sra a` repeated
//     `shift` times. A single loop has to dispatch into that chain every tick
//     (a `jr`, 12 cycles). Eight copies of the loop, one per shift, bake the
//     chain in and cost exactly 8·shift with no dispatch at all. The caller
//     picks the copy once per voice per frame from an 8-entry table.
//
//  2. INCREMENT IN A REGISTER. The integer part of the 16.16 increment was a
//     self-modified immediate (`adc a,n`, 7 cycles). Register C is free for the
//     whole pass — the loop uses only A, DE (sample pointer), HL (buffer
//     cursor) and B (tick counter) — so `adc a,c` (4 cycles) does the job and
//     the self-modification disappears with it.
//
//  3. UNROLL. `djnz` costs 13 cycles a tick; unrolling by U amortises it to
//     13/U. R need not divide by U: the remainder runs as straight-line bodies
//     ahead of the loop.
//
// Register contract inside every loop:
//     DE  = sample pointer (window address)   HL  = buffer cursor (H = plane, L = tick)
//     B   = iteration counter                 C   = increment integer part
//     HL' = fractional position               DE' = increment fraction
//
// `exx` is flag-transparent, so the carry out of `add hl,de` (the fraction)
// chains straight into `adc a,c` (the pointer). That is the whole 16.16
// advance: one 32-bit add split across the two register sets.
//
// PACING (driver.md §5.1). A fourth concern, and the one that cost three
// hardware bring-up rounds: the DAC has to be fed at ITS OWN rate. A separate
// output pass after the mix emits a frame of samples in ~12% of the frame — the
// values are right and the sound is not. So in the shipped configuration the
// feed is INTERLEAVED into the mix: one `$2A` write every PACE_PASSES ticks,
// inside the loop, plus a pad that holds the iteration to a constant period.
// That is what fixes the unroll at PACE_PASSES and the pass count to match.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PCM_MASTER_MAX_SHIFT,
  PCM_MAX_SHIFT,
  PCM_SAMPLES_PER_GATE,
  PCM_SAMPLES_PER_FRAME,
  PCM_FM_NUM,
  PCM_FM_DEN,
  PCM_FM_PER_SAMPLE,
  PCM_RING_TARGET,
} from "../../live/src/mmb.js";

export const MUTE_SHIFT = 8;   // PV_SHIFT value meaning "silent, keep advancing"
// PV_SHIFT for a pass with no voice behind it at all (engine.z80's G_IDLEV).
// Distinct from MUTE because it must NOT advance a position: `:vol 0` keeps a
// note running silently and has to stay in step, an absent voice has nothing to
// stay in step with. The difference is 35 cycles a tick, and it matters because
// those are the cycles the pad has to give back to the frame — an idle pass is
// where nearly all of a light frame's slack lives.
export const IDLE_SHIFT = 9;
export const VARIANTS = ["i16", "i8", "i8sat", "i16nr", "i8satnr", "i8satsh"];

// ── The pacing model ───────────────────────────────────────────────────────
// Every frame runs exactly PACE_PASSES voice passes of R ticks (silent voices
// included — see engine.z80), so R·PACE_PASSES tick bodies carry exactly R
// samples: one emit every PACE_PASSES ticks, which is why the unroll follows it.
//
// The pad exists because the mix is CHEAPER than the frame at anything under a
// full three-voice load: without it the feed would simply finish early and hold,
// which is the same bug in smaller print. Each loop copy is specialised on
// (role, shift), so its per-tick cost is a constant the generator can compute —
// and the pad it needs is therefore a baked immediate, not a runtime lookup.
// A NTSC Mega Drive frame is 262 lines x 3420 master clocks = 896,040, and the
// Z80 runs at master/15 — so 59,736 Z80 cycles, not 59,659. 59,659 is
// 3,579,545 / 60, i.e. a 60 Hz frame, while every comment beside it said
// 59.92 Hz. The 77-cycle error is 0.13% and would not matter, except that it
// put the DAC's own clock (166.67 samples x 358.4 = 59,733) just ABOVE the
// frame instead of three cycles below it — which reads as "the sample rate
// cannot fit a frame even with zero work", and that is not true.
export const FRAME_CYCLES = 59736;  // 896040 master clocks / 15
// ONE. A pass's iteration is PACE_PASSES ticks of ONE voice plus an emit, and
// it must fit a sample period: P*(tick+PACE_WINDOW) + 134 <= 358. With a
// 16.16-resampling tick at 78 that is 226 for P=1, 318 for P=2 and 410 for P=3
// — so three never fitted at any volume and two fitted only just.
//
// "Just" is not enough, and the reason is the GATE rather than the period. The
// timer passes PCM_GROUP samples per overflow, so a group gets 3 x 358 = 1,075
// cycles for its mixing AND for whatever out-of-loop work falls in it, and a
// group that runs long is never made up (two of its three samples can be early,
// the third waits for the timer regardless). Per group:
//
//     P=2   3 x 318 = 954   -> 121 cycles for everything else
//     P=1   3 x 226 = 678   -> 397 cycles for everything else
//
// The frame's out-of-loop work is ~16k over ~55 groups, ~290 a group on
// average and lumpy — which P=2 cannot absorb and P=1 can.
export const PACE_PASSES = 2;       // voice passes per frame = the emit cadence
// The Timer-B sample clock (driver.md §5.1.2): the gate is 16k FM samples =
// 2304k YM clocks and 3k samples come out of it, so the RATE is 16/3 FM samples
// a DAC sample for every k — 9987.6 Hz — and k only decides how many samples
// the engine may average its out-of-loop work over. The Z80 and the YM run off
// the same crystal at master/15 and master/7, so a YM clock is 7/15 of a Z80
// one and the period converts exactly.
// Timer B's period is 16 x (256 - TB) FM samples and an FM sample is 144 YM
// clocks, so TB is the ONE knob here: k = 256 - TB buys 2304k YM clocks a gate
// and 3k samples out of it — the SAME sample rate for every k, because both
// sides scale together. k is therefore the window the engine may average over,
// and it was never chosen: k = 1 is the timer's shortest period and PCM_GROUP
// = 3 fell out of it. See .claude/memory/plan-68k-split.md 2026-08-09.
// K is the WINDOW the engine may average its out-of-loop work over: one gate
// per PCM_GROUP = PCM_SAMPLES_PER_GATE x K samples, at the same sample rate for
// every K, so a large K amortises the gate's 141 cycles and a small one spends
// them. 16 is the shipped value — 48 samples a gate, ~3.5 gates a frame.
//
// K = 1 with PCM_SAMPLES_PER_GATE = 1 is the OTHER end: every sample gated, the
// only shape Timer B can hold an exact clock in, and it costs 55 gates a frame
// instead of 3.5. That is the whole trade — see plan-68k-split.md 2026-08-27.
// Anything between is the worst of both: the gate's cost without its clock.
export const TIMER_B_K = Number(process.env.TIMER_B_K ?? 16);   // 256 - TB
export const TIMER_B_TB = 256 - TIMER_B_K;    // the byte the engine writes to $26

// WHICH TIMER GATES THE DAC. Timer B's period is 16 x (256 - TB) FM samples, so
// its shortest gate is 16 and the highest rate it can hold EVERY sample at is
// 3,329 Hz. Timer A's is (1024 - NA) FM samples across a 10-bit register: any
// integer 1..1024, i.e. 52 Hz to 53,267 Hz at one-FM-sample resolution.
//
// Timer A is not free: CSM (docs/language.md, `fm3-csm`) drives its key-ons off
// Timer A, so a score with a CSM track owns it and the DAC keeps Timer B at
// 3,329 Hz. Everything else takes Timer A and picks its rate. Nothing in the
// ENGINE knows which is which past the four constants below — the status flag
// it polls, the $27 bits that load/enable it, the $27 bit that resets the flag,
// and the register writes that set the period.
export const PCM_TIMER = (process.env.PCM_TIMER ?? "B").toUpperCase();
if (PCM_TIMER !== "A" && PCM_TIMER !== "B")
  throw new Error(`PCM_TIMER must be A or B, got ${PCM_TIMER}`);
// FM samples per overflow, from the rate mmb.js already derived: one overflow
// carries PCM_SAMPLES_PER_GATE samples on Timer B and exactly one on Timer A.
export const TIMER_FM =
  PCM_TIMER === "B" ? 16 * TIMER_B_K : PCM_FM_NUM / PCM_FM_DEN;
if (PCM_TIMER === "A") {
  if (!Number.isInteger(TIMER_FM) || TIMER_FM < 1 || TIMER_FM > 1024)
    throw new Error(
      `Timer A needs a whole number of FM samples per DAC sample in 1..1024; ` +
        `PCM_FM = ${PCM_FM_PER_SAMPLE}`);
  if (PCM_SAMPLES_PER_GATE !== 1)
    throw new Error("Timer A gates ONE sample per overflow: set PCM_SPG=1");
}
export const TIMER_A_NA = PCM_TIMER === "A" ? 1024 - TIMER_FM : 0;
// The four bytes the shape comes down to. Bits of $27: 0 Load A, 1 Load B,
// 2 Enable A, 3 Enable B, 4 Reset flag A, 5 Reset flag B; of the status byte:
// 0 flag A, 1 flag B, 7 BUSY.
export const TIMER_FLAG  = PCM_TIMER === "A" ? 0x01 : 0x02;
export const TIMER_LOAD  = PCM_TIMER === "A" ? 0x05 : 0x0a;
export const TIMER_RESET = PCM_TIMER === "A" ? 0x10 : 0x20;

export const GATE_YM = 144 * TIMER_FM;        // YM clocks per overflow
export const PCM_GROUP =
  PCM_TIMER === "B" ? PCM_SAMPLES_PER_GATE * TIMER_B_K : 1;
export const SAMPLE_CYCLES = Math.round((GATE_YM / PCM_GROUP) * (7 / 15)); // 358
// The gate's period in Z80 cycles, EXACT — not SAMPLE_CYCLES x PCM_GROUP.
// Rounding 358.4 down to 358 loses 0.4 a sample, which is 66 cycles a frame
// against the 81 the vblank has left once the DAC's own clock is paid. Every
// harness that models the timer imports THIS rather than re-deriving 2304 from
// scratch, because seven copies of a constant is what made every previous
// change to it a bug hunt.
export const GATE_CY = (GATE_YM / (53693175 / 7)) * 3579545;
// What the pad actually holds an iteration to: one quantum SHORT of the period.
// Every loop must be able to run slightly fast, because the frame spends cycles
// outside them (the slot's writes, the pass transitions) and a loop padded to
// the exact period could never give those back — it would fall behind by them
// every frame, for ever. The gate is the upper bound in the other direction, so
// running 4% fast costs nothing: sample 1 of each group waits for Timer B
// anyway. It is the one number here that is a judgement rather than a
// measurement; `npm run dac:wav` is what re-judges it.
// What the pad holds an iteration to, as a FRACTION of the sample period — a
// fraction because a fixed pad silently stops matching the period when the rate
// knob moves.
//
// 0.40, AND IT IS A MEASUREMENT NOW. It was 0.73, reasoned from the group
// arithmetic below, and 0.73 is what made the driver never once sound right:
//
//   PAD 0.73    ISR p50 121% of a vblank · 64% of interrupts overran
//               DAC delivered 68% of the samples the clock owed
//   PAD 0.40    ISR p50  74%             ·  0.3%
//               DAC delivered 99%
//
// The chain, measured end to end on an emulated Mega Drive (see
// drv/verify-rom/, and .claude/memory/plan-68k-split.md for the round): the
// pads are 41% of the interrupt, the interrupt therefore does not fit in a
// vblank, the VDP's /INT is a PULSE so the next one is lost outright, the
// catch-up consumes that frame's slot WITHOUT MIXING (§6.7, deliberately) — and
// the mixer ends up running every OTHER frame. The ring drains, the DAC starves
// a third of the time, and `music x256` reads a perfect 0x0100 throughout,
// because the catch-up keeps the FRAME count right while the samples inside the
// frames go missing.
//
// The old reasoning, and why it stopped applying: a Timer B group was 3 x 358 =
// 1,075 cycles for the mixing AND the out-of-loop work in it, so the pad got
// what was left after both — ~1075/PCM_GROUP minus ~260 of out-of-loop work.
// **At PCM_GROUP = 1 there is no group.** Every sample is gated and Timer B
// re-synchronises every one of them, so spacing "samples 2 and 3 of a group" is
// a job that does not exist at this rate, and the cycles spent on it are the
// overrun. The pad still earns its keep below the deadline: at 0.20 and below
// the mixer bursts its whole chunk at the frame head and a single 73-period
// hole appears where the ring's clamp drops samples, against 2.3 periods at
// 0.30-0.40. So it is not zero — it is what spreads production without
// crowding out the frame.
//
// Measured across five PCM scores; 0.40 is better than 0.73 on four and equal
// on the fifth, and never worse.
//
// The default is therefore conditional, not flat: every one of those runs was at
// PCM_GROUP = 1, and at PCM_GROUP > 1 the group is real and the pad's original
// job with it. That path is unmeasured under this engine (9,987 Hz is broken on
// this branch anyway), so it keeps the number it had rather than inheriting a
// finding that does not apply to it. Re-measure before changing it:
//
//   PAD_FRACTION=<f> node tools/build-verify-rom.mjs drv/tests/<score>.mmlisp
//   MMLISP_PROBE_LOG=out/p.log out/blastem/host ... && node tools/dac-log.mjs out/p.log
// 0.55 at PCM_GROUP = 1, re-measured 2026-09-01 after the emit came down from
// 384 cycles to 230 and the interrupt from 83% of a vblank to 57%. The pad is
// what puts those cycles back into the frame's span, so the value had to move
// with them; 0.40 was right when the interrupt was full.
//
// sin008 / budget-2v, delivered samples, BlastEm:
//
//   PAD_FRACTION   3,329 Hz     4,439 Hz     6,658 Hz
//     0.40        98.6 / —     98.5 / —     93.7 / —
//     0.45        98.6 / 99.0  97.8 / 98.4  93.6 / 91.1
//     0.50        99.1 / 98.8  98.4 / 98.3  93.5 / 91.1
//     0.55        99.3 / 99.3  98.7 / 98.7  93.2 / 91.1
//     0.60        99.3 / 99.6  98.5 / 98.7  93.1 / 91.1
//     0.70        97.9 / —     97.4 / —     92.9 / —
//     0.85        64.4 / —     65.9 / —     65.2 / —
//
// The plateau is 0.50-0.60 and the cliff past it is real — at 0.85 the padded
// iteration is longer than the sample period and the frame cannot keep up at
// any rate. 0.55 is the middle of the plateau rather than its edge, which is
// where a knob with a cliff belongs.
export const PAD_FRACTION = Number(
  process.env.PAD_FRACTION ?? (PCM_GROUP === 1 ? 0.55 : 0.73));
// THE PAD IS NOT DEAD TIME, and this was worth one wrong hypothesis to learn.
//
// It looks like waste — 6,100 cycles a frame at two voices, 16% of the
// interrupt, spent holding a loop back — and the obvious move is to charge the
// emit its real cost so padFor stops handing out pad the frame cannot afford.
// Measured on BlastEm, every version of that is WORSE:
//
//   EMIT_CYCLES  PAD_TARGET       sin008 @ 3,329 / 4,439 / 6,658 / 8,878 Hz
//   182 (wrong)  0.40 x period      98.7   98.3   92.3   87.2
//   263 (real)   0.40 x period      97.4   98.6   92.3     —
//   263 (real)   max(that, iter)    98.3   98.1   74.2   45.8
//
// The reason is that the mixer is not free-running. It mixes exactly the
// frame's chunk and stops, so the pad does not cost throughput — it decides
// WHERE IN THE FRAME the mixing happens. Unpadded, the interrupt bursts through
// its chunk in the first third of the frame and returns, and the remaining two
// thirds have only the idle loop's feed to send samples from. Padded, the
// interrupt spans the frame and the emit points are spread through it, which is
// XGM2's "<=168 cycles between outputs EVERYWHERE" in this engine's shape.
//
// So PAD_FRACTION is not an efficiency knob, it is HOW MUCH OF THE FRAME THE
// INTERRUPT SPANS, and 0.40 is the measured value. EMIT_CYCLES below is part of
// the same tuning and not a cost model — see its comment.
export const PAD_TARGET = Math.round(SAMPLE_CYCLES * PAD_FRACTION);
// Under Timer B the pad's whole job is the interval between samples 2 and 3 of
// a gate's group: the gate itself re-synchronises sample 1, so nothing the pad
// does can accumulate and nothing outside the loop has to be charged against
// it. It is therefore a baked constant per (role, shift) — the runtime debt,
// its estimator (PACE_RESERVE / PACE_SEG), its tables and the per-frame segment
// count are all deleted, along with the ~20% slow frame they existed to stop.
// The history is in .claude/memory/plan-68k-split.md; the short version is that
// no constant can make an interval constant, which is what a clock is for.
// What a read through the $8000 ROM window costs beyond the Z80's own 7 — the
// 68000's bus arbiter. NEVER MEASURED HERE, and it is 14 because 14 was the
// estimate that got written down; at two voices it is 28 cycles a sample.
//
// XGM2 charges 3. Its mix macros count `ADD (HL)` as "7+3" and `LDI` as "16+3"
// for exactly this read (SGDK, src/snd/xgm2/drv_xgm2_pcm_mac.i80), which is a
// second opinion from a driver that ships and is 4.7x smaller than ours.
//
// It pulls two ways, which is why it is a knob and not a constant: padFor
// SUBTRACTS `fetches x PACE_WINDOW` when it sizes the pad, so a smaller value
// makes the generated pads BIGGER, while frame-budget ADDS it when it times the
// frame. Only the machine can settle it — sweep MMLISP_PACE against dac-log.
export const PACE_WINDOW = Number(process.env.MMLISP_PACE ?? 14);

// Master's ceiling, and therefore the number of `sra a` slots every emit
// reserves for the master chain. IMPORTED, not mirrored: the sequencer composes
// the shift and the mixer holds the code it patches into, so a drift between
// the two would overflow the chain rather than merely mis-level the mix.
export { PCM_MASTER_MAX_SHIFT };
// A -> A x `unroll`, for turning an ITERATION count into a TICK count. It was
// written as `add a,a / add a,l` (x3) when the unroll was fixed at three, in
// TWO generated sites — and a stale factor here cuts a voice pass short, which
// presents as the mixer diverging at a ring page edge several hundred samples
// later. Derived from the unroll now; anything past 4 needs a real multiply and
// says so rather than emitting silently wrong code.
export function mulByUnroll(u) {
  if (u === 1) return "        ; x1 = ticks: the unroll is one, the count is already in ticks";
  if (u === 2) return "        add  a,a                ; x2 = ticks";
  if (u === 3) return "        add  a,a\n        add  a,l                ; x3 = ticks";
  if (u === 4) return "        add  a,a\n        add  a,a                ; x4 = ticks";
  throw new Error(`gen-mixer: no iterations->ticks multiply for unroll ${u}`);
}
export const paceTarget = (R) => Math.floor(FRAME_CYCLES / R);
export const DEFAULT_R = Math.ceil(PCM_SAMPLES_PER_FRAME) + 8;

// Documented Z80 cycle counts for exactly the instructions `body()` emits, so
// the pad is derived from the generated code rather than from a hand-kept copy
// of it. Unknown forms throw: a body that grows a new instruction must price it.
const COST = [
  [/^ld\s+a,\(de\)$/, 7], [/^ld\s+a,e$/, 4], [/^ld\s+e,a$/, 4],
  [/^ld\s+\(hl\),a$/, 7], [/^ld\s+\(hl\),\S+$/, 10],
  [/^sra\s+a$/, 8], [/^xor\s+\S+$/, 7],
  [/^add\s+a,\(hl\)$/, 7], [/^adc\s+a,c$/, 4], [/^add\s+a,c$/, 4], [/^add\s+hl,de$/, 11],
  [/^inc\s+de$/, 6], [/^inc\s+\(hl\)$/, 11], [/^(inc|dec)\s+[hlde]$/, 4],
  [/^exx$/, 4],
  [/^jp\s+pe,/, 10],   // not taken: the common path, saturation is the exception
  [/^jr\s+nc,/, 12],   // taken; the carry path costs 11, and one cycle is noise
];
function costOf(line) {
  const i = line.replace(/;.*$/, "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!i || i.endsWith(":")) return 0;
  for (const [re, c] of COST) if (re.test(i)) return c;
  throw new Error(`gen-mixer: no cycle cost for "${i}"`);
}
// The carry paths (`jr nc,k` over an `inc`) are the one place where the count
// depends on data: taken costs 12, the fall-through 11. Price the taken path and
// skip what it jumps over — the difference is one cycle in ninety.
export function tickCost(variant, role, shift) {
  const lines = body(variant, role, shift, []);
  let n = 0, skipTo = null;
  for (const l of lines) {
    const i = l.replace(/;.*$/, "").trim();
    if (skipTo) { if (i === `${skipTo}:`) skipTo = null; continue; }
    const br = /^jr\s+nc,(\S+)$/.exec(i);
    if (br) { n += 12; skipTo = br[1]; continue; }
    n += costOf(l);
  }
  return n;
}

let uid = 0;
const lbl = (p) => `${p}${uid++}`;

// Every emit's master chain, in generation order — the addresses engine.z80's
// pc_master patches. Inline (loop-copy) sites and out-of-line ones are kept
// apart because only the inline ones carry a dispatch byte to patch as well.
let masterInline = [];
let masterOutOfLine = [];

// ── The loop body, once ────────────────────────────────────────────────────
// variant: i16   two planes, biased unsigned, sum then saturate at output
//          i8    one plane, signed, headroom instead of saturation
//          i16nr i16 with the position advancing exactly one sample per tick
//                (what pre-resampled samples would cost — the control case)
// role:    "first" stores, "add" accumulates. Running the first active voice
//          as a store removes the frame-long buffer clear entirely.
function body(variant, role, shift, deferred = []) {
  const o = [];
  const push = (s) => o.push("        " + s);
  const nr = variant.endsWith("nr");        // baked at the note: one byte a tick
  // Baked at an ANCHOR, played 2^k above it: the advance is a whole number of
  // bytes and C carries it. 24 cycles against 6 for `inc de` and 43 for the
  // 16.16 resampler — measured, tools/adv-cost. This is what an octave shift
  // costs, and it is the reason the resampler could go: nothing needs a
  // fraction any more.
  const sh = variant.endsWith("sh");
  const sat = variant.startsWith("i8sat");  // 8-bit, saturate at every add
  const wide = variant.startsWith("i16");   // two planes, sum then saturate
  // Shift index 8 is MUTE: `:vol 0` / `:master 0` silences a voice but it must
  // keep advancing, matching FM where a note continues under a 0 fader
  // (driver.md §14). Dropping the fetch and the accumulate is also the one
  // case where the specialised loops are faster than the general one.
  const idle = shift === IDLE_SHIFT;         // no voice at all behind this pass
  const mute = shift === MUTE_SHIFT || idle;

  if (!mute) {
    push("ld   a,(de)             ; sample");
    for (let i = 0; i < shift; i++) push("sra  a");
  }

  if (mute) {
    if (role === "first") {
      // Nothing has written this tick's slot yet, so store the value that
      // means silence for this plane's encoding.
      push(`ld   (hl),${sat ? "0" : "$80"}   ; ${idle ? "no voice: the plane's silence" : "muted, but the position still advances"}`);
      if (wide) {
        push("inc  h");
        push("ld   (hl),0");
        push("dec  h");
      }
    }
    // An accumulating muted voice contributes nothing at all.
  } else if (role === "first") {
    // i8sat keeps the plane SIGNED (the output pass biases); the other variants
    // bias here, which makes their output pass a bare copy.
    if (!sat) push("xor  $80               ; bias: the plane is the reference point");
    push("ld   (hl),a");
    if (wide) {
      push("inc  h");
      push("ld   (hl),0            ; high plane starts at zero");
      push("dec  h");
    }
  } else if (sat) {
    // Saturate at every add instead of summing wide. The Z80 has no saturating
    // add, but `add a,(hl)` sets P/V on SIGNED overflow, so the common path is
    // one not-taken `jp pe` (10 cycles) against the ~26 the high plane costs.
    // Clips earlier than sum-then-saturate and is order-dependent — but it
    // never attenuates, so unlike the headroom variant it cannot pump.
    const ov = lbl("ov");
    const dn = lbl("dn");
    push("add  a,(hl)");
    push(`jp   pe,${ov}`);
    o.push(`${dn}:`);
    push("ld   (hl),a");
    deferred.push(
      `${ov}:\n` +
      `        jp   m,${ov}_hi        ; overflow inverts the sign, so a negative\n` +
      `        ld   a,$80             ; result means the true value was positive\n` +
      `        jp   ${dn}\n` +
      `${ov}_hi:\n` +
      `        ld   a,$7f\n` +
      `        jp   ${dn}`,
    );
  } else if (wide) {
    push("xor  $80");
    push("add  a,(hl)");
    push("ld   (hl),a");
    const k = lbl("nc");
    push(`jr   nc,${k}`);
    push("inc  h");
    push("inc  (hl)              ; the high plane only ever takes a carry");
    push("dec  h");
    o.push(`${k}:`);
  } else {
    push("add  a,(hl)            ; headroom guarantees no overflow");
    push("ld   (hl),a");
  }
  push("inc  l");

  if (idle) return o;      // nothing to advance, and that is the whole point
  if (nr) {
    push("inc  de                ; baked at this note: one sample per tick");
  } else if (sh) {
    push("ld   a,e");
    push("add  a,c               ; C = 2^k bytes a tick, the octave shift");
    push("ld   e,a");
    const k = lbl("np");
    push(`jr   nc,${k}`);
    push("inc  d");
    o.push(`${k}:`);
  } else {
    push("exx");
    push("add  hl,de             ; frac += incFrac");
    push("exx                    ; flag-transparent: the carry survives");
    push("ld   a,e");
    push("adc  a,c               ; ptr += incInt + frac carry");
    push("ld   e,a");
    const k = lbl("np");
    push(`jr   nc,${k}`);
    push("inc  d");
    o.push(`${k}:`);
  }
  return o;
}

// One DAC sample, plus the pad that holds this iteration to the frame's tick
// period. Emitted at the head of the first body of an unrolled loop, where A is
// dead and no flag is live — the fraction's carry does not reach here.
//
// IY is the emit cursor. It belongs to the frame, not the segment: the engine
// points it at the finished plane once and every loop in every pass advances the
// same register, so the cadence survives the segment splits and the pass
// boundaries without anything having to hand it over.
// The gate, inline: hold for Timer B on the group's first sample and step the
// phase. Every emit in the engine begins with exactly this block.
//
// THE PHASE LIVES IN A', THE SHADOW ACCUMULATOR, AND NOWHERE ELSE. It used to
// be a RAM byte behind `call gate_step`, which cost 69 cycles of the ~165 an
// emit gets — 11,000 a frame to maintain a counter that never exceeds 3. `ex
// af,af'` is 4 cycles and reaches it directly, so the whole step is 24, inline,
// in 8 bytes.
//
// What that buys has a price, and it is a global one: `ex af,af'` is now
// RESERVED for the pacing, everywhere in the engine, for the whole life of the
// driver. Nothing else may use AF' — not the mixer, not the sequencer, not a
// future interrupt path (the handler's push/pop af does not touch it, which is
// what makes this work across the frame boundary). `exx` is unaffected and the
// mixer's own use of it is fine. A second user of AF' would not fail a gate; it
// would drift the DAC's phase and read as jitter, so it is called out here and
// at the definition of gate_wait.
function gatePrologue() {
  const k = lbl("gt");
  return [
    "        ex   af,af'            ; A' is the gate phase (1..GROUP); see gatePrologue",
    "        dec  a",
    `        jr   nz,${k}            ; not this sample's turn to wait`,
    "        call gate_wait         ; hold for Timer B; returns A = PCM_GROUP",
    `${k}:`,
    "        ex   af,af'            ; …and the mixer's A and flags come back",
  ];
}

// The master chain: PCM_MASTER_MAX_SHIFT two-byte slots that engine.z80's
// pc_master writes `sra a` into, followed by a `jr` over the ones the shift did
// not use. Generated in its UNITY form — the jump first, so a chain that is
// never patched attenuates by nothing, which is what a build that never sees a
// PCM_MASTER command must do.
//
// It is code rather than data because the emit has nowhere to put a count: A
// holds the sample, A' the gate phase, HL/DE/BC the mixer's register file and
// IY the ring cursor, so a runtime shift would have to FETCH its count every
// sample — more than the shift itself costs. Master moves on a 6 dB grid, so a
// full fade rewrites these about seven times (driver.md §14.1).
function masterChain(ms, tail) {
  const o = [`${ms}:`];
  o.push(`        jr   ${tail}${" ".repeat(Math.max(1, 18 - tail.length))}; master chain, slot 0 — PATCHED`);
  for (let i = 1; i < PCM_MASTER_MAX_SHIFT; i++)
    o.push("        sra  a                 ; …slot — PATCHED");
  return o;
}

// PCM_GROUP = 1 — EVERY sample is gated, which is the only shape Timer B can
// hold to (its shortest period is 16 FM samples = one sample at 3,329 Hz). With
// no ungated samples there is no phase to keep, so AF' carries nothing, the
// dispatch branch the phase doubled as is gone, and the whole emit collapses
// into ONE out-of-line routine instead of twenty-four inline copies with a
// master chain apiece.
//
// It is a smaller emit as well as a smaller image. Measured against the phase
// form it replaces: 226 cycles a sample became 182, and a frame emits ~55 of
// them — 2,400 cycles, which is the same order as the whole frame's overrun.
export const ONE_GATE = PCM_GROUP === 1;

// Samples the mix loops must leave for the frame's boundary. See the equ's
// comment below for what it buys; the size is the boundary's own length in
// sample periods, rounded up.
export const PCM_EMIT_RESERVE = Number(process.env.PCM_RESERVE ?? 3);

// emit_gate: one gated DAC sample. Poll Timer B, clear its flag, re-latch $2A
// (the flag clear costs the address register), then the ring byte through the
// master chain. Touches A, the flags and IY; nothing else. The RING WRAP is not
// here — the loops' segment bounds keep the cursor short of the top, and
// feed_one, which has no such bound, does the test itself.
// The ask: one status read and one bit test, and NZ means a sample is due. Its
// two instructions are inline at every call site — the answer is "no" about
// half the time, and a call/ret round trip around them is 27 cycles for it.
function askBlock() {
  return [
    "        ld   a,(YM_ADDR0)      ; the ONE status read (see emit_send)",
    `        bit  ${TIMER_FLAG === 0x01 ? 0 : 1},a               ; this timer's flag: NZ = a sample is due`,
  ];
}

function emitGate() {
  return [
    "; emit_try: one sample IF the timer says one is due, and NOTHING otherwise.",
    ";",
    "; This is the whole pacing model, and it is the opposite of the one it",
    "; replaces. Waiting for the gate put the timer INSIDE the interrupt: 55",
    "; samples x one period each is 97% of a vblank of pure spin, measured at",
    "; 35,688 of the ISR's 59,290 cycles against 23,602 of actual work. An ISR",
    "; that long loses the next vblank outright whenever a frame runs heavy, and",
    "; a lost vblank is a lost frame of music — the tempo wobble, not a hiccup.",
    ";",
    "; So nothing blocks. The mixer runs at its own speed and every stretch of",
    "; code ASKS, at most a sample period apart; whoever is running when the",
    "; timer comes due is the one that sends it. That is XGM2's structure and",
    "; its <=168-cycles-between-outputs rule is what makes it work.",
    ";",
    "; ONE STATUS READ, AND THE WRITES ARE SPACED BY WORK RATHER THAN BY POLLS.",
    "; This routine used to read the status FOUR times — once to ask, and once",
    "; before each of the three writes that follow — for 96 cycles a sample of",
    "; asking a question whose answer was already in the first read's bit 7.",
    "; Measured at 384 cycles a sample against XGM2's ~67 for the same four chip",
    "; accesses (.claude/memory/plan-68k-split.md, 2026-08-11 and 2026-09-01).",
    ";",
    "; What the polls were buying is SPACING between accesses, and the routine",
    "; had plenty of work to give: the ring's fill accounting, the cursor's wrap",
    "; and the sample fetch were all done in one run BEFORE the writes, so the",
    "; writes ended up back to back with nothing between them. Interleaved, each",
    "; write is followed by 27-46 cycles of real work before the next one — more",
    "; separation than a satisfied poll gave — and the polls are gone.",
    ";",
    "; A and the flags are dead at every call site; IY is the ring cursor, and",
    "; IYH is now read directly, so HL is never touched and never spilled.",
    "emit_try:",
    ...askBlock(),
    "        ret  z                 ; not due — the caller carries straight on",
    "emit_send:                     ; …and the entry every inline ask calls into",
    "        ; DUE, and THERE IS NOTHING TO WAIT FOR. This routine writes \$27 and",
    "        ; \$2A and nothing else, and both are inside the range the YM2612",
    "        ; acknowledges immediately. XGM2's header carries the measurement",
    "        ; (SGDK, src/snd/xgm2/drv_xgm2.s80), taken on hardware:",
    "        ;",
    "        ;   address write needs 6 Z80 cycles before its data (8 by spec)",
    "        ;   NO WAIT between writes to \$21-\$2F, except \$28",
    "        ;   \$28 (key on/off)  53 Z80 cycles between writes",
    "        ;   \$30-\$9E           39",
    "        ;   \$A0-\$B6           22",
    "        ;   a data write can take up to 53 to acknowledge",
    "        ;",
    "        ; So the DAC and the timer's flag reset are the two cheapest things",
    "        ; on the chip, and this routine spent 96 cycles a sample polling",
    "        ; BUSY between them plus a spin that could only ever fire on someone",
    "        ; else's write. XGM2 polls nothing here either — its whole sample",
    "        ; output is 80 cycles and its two register writes sit back to back.",
    "        ;",
    "        ; The BUSY that IS real belongs to the slot's FM writes, and it is a",
    "        ; wait between writes to the SAME range rather than a property of the",
    "        ; chip being unavailable; cr_p0 is where that question lives.",
    "        ld   a,$27",
    "        ld   (YM_ADDR0),a      ; [1/4] the flag-reset register's address",
    "        ; …and the RING accounting fills the gap behind it. This is the",
    "        ; whole of the accounting now: no per-frame debt, no reserve, no",
    "        ; flush. The mixer adds what it wrote to G_FILL and every send takes",
    "        ; one back, which is what a ring IS — and it is what lets the send",
    "        ; happen from anywhere, including after the interrupt has returned.",
    "        ;",
    "        ; A frame quota could not survive that: with the send no longer",
    "        ; blocking, the count a frame gets out varies, and a quota reset per",
    "        ; frame turned the surplus into skipped and repeated samples. It",
    "        ; showed up as `a2-flat` — the same bytes on a PERFECT clock — going",
    "        ; from -46 dB to -27 dB, which is the stream itself being wrong and",
    "        ; not its timing.",
    "        ;",
    "        ; 16 bits, decremented through A alone: HL is the mixer's plane",
    "        ; cursor at the inline call sites and this may not touch it.",
    "        ld   a,(G_FILL)",
    "        or   a",
    "        jr   nz,et_lo",
    "        ld   a,(G_FILL+1)",
    "        or   a",
    "        ret  z                 ; the ring is empty — nothing finished to send",
    "        dec  a",
    "        ld   (G_FILL+1),a",
    "        ld   a,255",
    "        ld   (G_FILL),a",
    "        jr   et_have",
    "et_lo:",
    "        dec  a",
    "        ld   (G_FILL),a",
    "et_have:",
    "eg_r27:",
    "        ld   a,$2a             ; PATCHED by cs_r27: $27 with the timer's",
    "        ld   (YM_DATA0),a      ; [2/4] RESET bit in it, over a RAM read",
    "        ld   a,$2a",
    "        ld   (YM_ADDR0),a      ; [3/4] the DAC's address",
    "        ld   a,(iy+0)          ; the ring: what an earlier frame finished",
    ...masterChain("eg_ms", "eg_ex"),
    "        jr   eg_ex",
    "eg_ex:",
    "        xor  $80               ; the ring is signed, the DAC is not",
    "        ld   (YM_DATA0),a      ; [4/4] $2A, and the sample is out",
    "        ; THE CURSOR WRAPS ITSELF. The ring is two 256-byte pages, so an",
    "        ; `inc iyl` cannot leave the page it is in and SETS Z on the carry",
    "        ; out — which is the page boundary, and the only moment IYH has to",
    "        ; move. RING_PAGE is the one bit of it that names the two pages.",
    "        ;",
    "        ; What that replaces is `inc iy` plus a compare against RING_TOP: 37",
    "        ; cycles a sample, and before the half registers arrived it was 89,",
    "        ; because HL belongs to the mixer and had to go through the stack.",
    "        ; It is 20 here, and 31 once in 256.",
    "        ;",
    "        ; It also makes the feed cursor UNABLE to overrun the ring, which is",
    "        ; what feed_wrap and mvf_ringcap's feed-distance bound existed for.",
    "        ; Both are gone (engine.z80).",
    "        inc  iyl",
    "        jr   nz,et_nw",
    "        ld   a,iyh",
    "        xor  RING_PAGE",
    "        ld   iyh,a",
    "et_nw:",
    "        ret",
  ];
}

function feed(pad) {
  const o = [];
  const push = (s) => o.push("        " + s);
  // The gate. Timer B overflows every GROUP samples, so one emit in GROUP holds
  // for it and the other two are placed by the code — the pad below is what
  // places them. The counter is CONTINUOUS across frames on purpose: a frame
  // carries 166 or 167 samples and neither divides GROUP, so a phase that
  // restarted per frame would put a wait at every frame boundary.
  //
  // TWO COPIES OF THE EMIT, and the gate's own branch chooses between them
  // (driver.md §14.1). The plain one is byte-for-byte what this emitted before
  // master moved out of the per-voice shift, and it is the FALL-THROUGH, so at
  // `master 31` — every frame of most songs — the mix costs exactly what it
  // used to. The attenuated copy carries the master chain and a jump back, 24
  // cycles a sample that only a fade pays for. There is no third way: the emit
  // is inlined into all twenty loop copies, so the choice cannot be a register
  // test (nothing is free) and cannot be free (a branch is 12 either way) — it
  // has to be the branch that is already there, with its target patched.
  if (ONE_GATE) {
    // No phase, no dispatch, no chain: one call, and the master chain lives in
    // the single copy the call reaches.
    // THE ASK IS INLINE; ONLY THE SEND IS A CALL. "Not due" is the answer about
    // half the time and it used to cost 49 cycles, 27 of them the call and the
    // ret around a three-instruction test. Here it is 31, and the `call nz`
    // costs the due path nothing it was not already paying.
    o.push(...askBlock());
    o.push("        call nz,emit_send      ; …and only then, the sample (§5.1.2)");
    o.push(...padBlock(pad));
    return o;
  }
  const n = uid++;
  const ea = `ea${n}`, ep = `ep${n}`, ms = `ms${n}`, ex = `ex${n}`;
  masterInline.push({ ms, ea, ep, ex });
  o.push(`        ex   af,af'            ; A' is the gate phase (1..GROUP); see gatePrologue`);
  o.push(`        dec  a`);
  o.push(`        jr   nz,${ep}${" ".repeat(Math.max(1, 15 - ep.length))}; PATCHED: ${ep} at unity, ${ea} under a shift`);
  o.push(`        call gate_wait         ; hold for Timer B; returns A = PCM_GROUP`);
  // The gate's own sample falls in here rather than being dispatched, so it
  // takes the general form always — one sample in PCM_GROUP paying the chain's
  // skip and the jump back, ~80 cycles a frame, against a second patch site.
  o.push(`${ea}:`);
  o.push(`        ex   af,af'            ; …and the mixer's A and flags come back`);
  o.push(`        ld   a,(iy+0)          ; the ring: what an earlier frame finished`);
  o.push(...masterChain(ms, ex));
  o.push(`        jr   ${ex}               ; …and into the tail the plain copy shares`);
  o.push(`${ep}:`);
  o.push(`        ex   af,af'            ; …and the mixer's A and flags come back`);
  push("ld   a,(iy+0)          ; the ring: what an earlier frame finished");
  o.push(`${ex}:`);
  push("xor  $80               ; the ring is signed, the DAC is not");
  push("ld   (YM_DATA0),a      ; $2A, fed blind");
  push("inc  iy                ; wraps at a SEGMENT boundary, never here");
  o.push(...padBlock(pad));
  return o;
}

// The pace pad, shared by both emit shapes.
function padBlock(pad) {
  const o = [];
  const push = (s) => o.push("        " + s);
  if (pad === "runtime") {
    // The IDLE copies alone take a RUNTIME pad. They are where all of a frame's
    // slack lives — a silent iteration's own work is ~75 cycles against a
    // sounding one's 339 — so how much of it the frame can afford is the one
    // pacing number that is not a constant. engine.z80's pcm_pad sizes it once
    // a frame from what the frame is doing (§5.1.2).
    const k = lbl("pd");
    push("ld   a,(G_PAD)         ; pace: what this frame can afford to hold to");
    o.push(`${k}:`);
    push("dec  a");
    push(`jr   nz,${k}`);
  } else if (pad > 0) {
    // BAKED, not looked up. Under Timer B the pad is no longer compensating for
    // anything the frame does — the gate re-synchronises the group's first
    // sample every time (§5.1.2) — so all it has to do is space samples 2 and 3
    // of a group, whose interval nothing else sets. That makes it a constant of
    // (role, shift), which is exactly what this generator knows, and it takes
    // the whole runtime debt estimator with it.
    const k = lbl("pd");
    push(`ld   a,${pad}${" ".repeat(Math.max(1, 17 - String(pad).length))}; pace: hold the tick to the sample period`);
    o.push(`${k}:`);
    push("dec  a");
    push(`jr   nz,${k}`);
  }
  return o;
}
// What one inline emit costs — the WHOLE block `feed()` emits, gate and all.
//
//   ex  af,af'      4        ld  a,(iy+0)      19
//   dec a           4        xor $80            7
//   jr  nz,gt       12       ld  (YM_DATA0),a  13
//   ex  af,af'      4        inc iy            10
//
// = 73, and it is the NON-gate path: two of every PCM_GROUP emits take it,
// which is what the pad has to space (the third re-synchronises on the timer,
// so whatever it costs is absorbed by the wait it replaces).
//
// This was 49 — the four instructions on the right — from before Timer B
// existed, and Stage B put `call gate_step` in front of the block without
// moving the number. The gap was 69 cycles charged ~165 times a frame, so the
// baked pads over-ran a sample period by that much and `pass_cost_tab` under-
// reported a pass by ~4,000 cycles, which handed `pcm_pad` ~13,000 cycles of
// pad the frame did not have. That was the bulk of the frame's overrun, and the
// other half of the fix was to make the step itself cost 24 instead of 69
// (gatePrologue).
// **THIS IS A PAD TUNING CONSTANT, NOT THE EMIT'S COST.** The emit measures 263
// cycles with the call (and 49 to answer "not due") on tools/z80cpu.mjs with no
// BUSY waits; 182 predates the fill accounting and the wrap moving onto the
// send path, and it counted one BUSY poll where there were four.
//
// It stays at 182 because padFor is the only thing that reads it, and what
// padFor produces is `PAD_TARGET - EMIT_CYCLES` of pad — a SPAN, not a cost.
// Correcting the number shortens that span and the interrupt stops covering the
// frame; see PAD_TARGET above for the three measurements. Change it only
// together with PAD_FRACTION, against the same table.
export const EMIT_CYCLES = ONE_GATE ? Number(process.env.MMLISP_EMIT_CY ?? 182) : 73;
// What the GATING emit costs on top of the other two, once per PCM_GROUP: the
// taken branch into `gate_wait`, its flag reset, the $2A re-latch, and the
// reload of the phase. Only the frame's total cares (`pass_cost_tab`); the pad
// does not, because this emit's interval is the timer's and not the pad's.
//
//   jr nz not taken 7 · call gate_wait 17 · gate_wait's body incl. its
//   `ld a,PCM_GROUP` 129 · minus the 12-cycle taken jr it replaces = 141
//
// At PCM_GROUP = 1 there is no such thing: EVERY emit gates, so the gate is
// inside EMIT_CYCLES and there is nothing to charge on top of it.
//
//   call emit_gate 17 · poll, last pass 34 · $27 + its data 40 · $2A re-latch 20
//   · ld a,(iy+0) 19 · the chain's skip 12 · xor 7 · ld (YM_DATA0),a 13
//   · inc iy 10 · ret 10 = 182
export const GATE_CYCLES = ONE_GATE ? 0 : 141;
// The pad that brings one unrolled iteration (U ticks + an emit + `dec b`/`jp
// nz`) up to ONE SAMPLE PERIOD. Below a period there is nothing to hold back,
// so the copy is generated without pad code at all.
//
// The window stall DOES ride here now. It is time the tick really takes on
// hardware, and the pad is what a sample period has left over after the tick —
// so a copy that fetches has that much less slack, and one that does not
// (MUTE, IDLE) keeps it. Under the old debt this could not be expressed: the
// sounding copy's pad was clamped to its floor and the silent passes paid.
function padFor(variant, role, shift, U) {
  const fetches = shift <= 7 ? U : 0;      // MUTE and IDLE read no samples
  const n = Math.floor((PAD_TARGET - U * tickCost(variant, role, shift)
    - fetches * PACE_WINDOW - EMIT_CYCLES - 14) / 16);
  return n < 1 ? 0 : Math.min(n, 255);
}

function loop(name, variant, role, shift, U, pad = null) {
  const deferred = [];
  const out = [`${name}:`];
  const lp = `${name}_lp`;
  out.push(`${lp}:`);
  for (let i = 0; i < U; i++) {
    if (pad !== null && i === 0) out.push(...feed(pad));
    out.push(...body(variant, role, shift, deferred));
  }
  // djnz is a relative branch (±128) and an unrolled body outruns it, so the
  // unrolled loops close with dec b / jp nz — 14 cycles against djnz's 13, and
  // amortised over U ticks either way.
  if (U === 1) out.push(`        djnz ${lp}`);
  else out.push(`        dec  b`, `        jp   nz,${lp}`);
  out.push("        ret");
  // Out-of-line clamp handlers: off the hot path, reached only on overflow.
  out.push(...deferred);
  return out.join("\n");
}

// A voice pass is split into segments at loop/end boundaries (engine.z80), so
// the loops take their tick count from the caller rather than baking R in.
// Each shift gets an unrolled entry (B = unrolled iterations) and a single-tick
// entry (B = ticks) for the remainder — with U = 2 the remainder is at most one
// tick, and the boundary segment never has to run on a slow generic path.
// Which shifts get a copy. NOT 0..7: PV_SHIFT only ever arrives from the slot,
// the sequencer composes it, and PCM_MAX_SHIFT clamps it — so 5, 6 and 7 were
// twelve loop copies (both roles, unrolled and single-tick) that nothing could
// ever reach. The table stays the full width so the index is still the raw
// PV_SHIFT byte, with the unreachable entries aimed at the MUTE copy: a shift
// that somehow got past the clamp then goes SILENT, which is noticed, instead
// of playing at a level nobody chose.
const shiftsFor = () =>
  [...Array(PCM_MAX_SHIFT + 1).keys(), MUTE_SHIFT, IDLE_SHIFT];

// Pitch-baked voices get a second set of the UNROLLED copies only, with the
// 16.16 resampler replaced by `inc de` (driver.md §14.2). Three things are
// deliberately NOT duplicated, because the resampling copy is already CORRECT
// for a baked voice and only costs more:
//   - the single-tick copies. With unroll 2 a segment leaves at most one tick
//     to them, and `frac += 0 / ptr += 1` is what the general path computes
//     anyway.
//   - MUTE, for the same reason: it advances the position and nothing else.
//   - IDLE, which does not advance at all, so the two are the same code.
// That is half the copies for nearly all of the saving.
const NR_SHIFTS = [...Array(PCM_MAX_SHIFT + 1).keys()];

// The nr set and its table. The table is the SAME WIDTH as the resampling one so
// ms_bind can swap between them with one pointer and no second index, and every
// slot the nr set does not fill points at the resampling copy — which is not a
// fallback but the right code for that slot.
function nrLoopSet(prefix, variant, role, U) {
  const out = [];
  const N = IDLE_SHIFT + 1;
  for (const s of NR_SHIFTS)
    out.push(loop(`${prefix}nr_s${s}`, variant, role, s, U, padFor(variant, role, s, U)));
  out.push(`${prefix}nr_tab:`);
  out.push(`        dw   ${[...Array(N)].map((_, s) =>
    NR_SHIFTS.includes(s) ? `${prefix}nr_s${s}`
      : `${prefix}_s${shiftsFor().includes(s) ? s : MUTE_SHIFT}`).join(", ")}`);
  return out.join("\n");
}

function loopSet(prefix, variant, role, U, paced, R) {
  const out = [];
  const N = IDLE_SHIFT + 1;               // the TABLE's width — PV_SHIFT is the index
  const live = shiftsFor();
  const copy = (base, s) => `${base}_s${live.includes(s) ? s : MUTE_SHIFT}`;
  for (const s of live)
    out.push(loop(`${prefix}_s${s}`, variant, role, s, U,
      paced ? (s === IDLE_SHIFT ? "runtime" : padFor(variant, role, s, U)) : null));
  for (const s of live) out.push(loop(`${prefix}1_s${s}`, variant, role, s, 1));
  out.push(`${prefix}_tab:`);
  out.push(`        dw   ${[...Array(N)].map((_, s) => copy(prefix, s)).join(", ")}`);
  out.push(`${prefix}1_tab:`);
  out.push(`        dw   ${[...Array(N)].map((_, s) => copy(`${prefix}1`, s)).join(", ")}`);
  return out.join("\n");
}

export function generateMixerCore(
  { variant = "i8sat", R = DEFAULT_R, unroll = 2, paced = false } = {},
) {
  const MUL_U = mulByUnroll(unroll);
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
  if (paced && variant !== "i8sat")
    throw new Error("paced feed is written for the shipped i8sat plane only");
  // (the paced build then swaps its ADVANCE to i8satsh below — the plane is
  // still i8sat, which is what this guard is about)
  if (paced && unroll !== PACE_PASSES)
    throw new Error(`paced feed needs unroll = PACE_PASSES (${PACE_PASSES})`);
  uid = 0;
  masterInline = [];
  masterOutOfLine = [];
  const wide = variant.startsWith("i16");
  const L = [];
  L.push(`; ===========================================================================
; PCM soft mixer core — voice-outer, ${variant}, R = ${R}, unroll ${unroll}${paced ? ", paced feed" : ""}
;
; GENERATED by tools/gen-mixer.mjs — do not edit. Regenerate instead.
; Design and measured cost: docs/driver.md §5.3 / §5.3.1.
;
; Included by src/engine.z80 (and by the bench image). The includer owns the RAM
; map and the PV_* struct offsets; this file defines only PCM_MIX_R and the code.
;
; Each voice owns the register file for its whole pass and writes into a
; frame-long mix buffer. The inner loops carry NO loop/end bounds check — the
; caller splits the pass into segments that cannot cross a boundary, which is
; exactly what a voice-outer pass buys.
${paced ? `;
; The DAC feed is INTERLEAVED, not a pass of its own (§5.1): the head of every
; unrolled iteration writes one sample of the plane the LAST frame finished, and
; the pad after it holds the iteration to ${SAMPLE_CYCLES} cycles — the sample period,
; which is Timer B's and not the frame's.
` : ""}; ===========================================================================

PCM_MIX_R   equ ${R}
MIX_UNROLL  equ ${unroll}
PCM_MUTE_SH equ ${MUTE_SHIFT}      ; PV_SHIFT meaning "silent, keep advancing"
PCM_IDLE_SH equ ${IDLE_SHIFT}      ; PV_SHIFT meaning "no voice here at all"
${paced ? `PCM_PASSES  equ ${PACE_PASSES}      ; passes per frame — the feed's cadence
PCM_TICK_CY equ ${SAMPLE_CYCLES}     ; the sample period one iteration holds to
; Whether sizing the idle pad at runtime can produce anything but its floor.
; pcm_pad's result is clamped to [1, PCM_IDLE_PAD], so when the pad target
; leaves room for exactly one 16-cycle unit the whole estimator — the pass cost
; table, the 16-bit shift, the clamp — is ~870 cycles a frame spent deriving the
; number 1. That is not a rounding error: at PCM_GROUP = 1 it sits inside the
; frame head's hole, which is the DAC's largest recurring one.
; How often the slot's chip-write loops stop to feed the DAC: every
; (mask + 1) writes. A run of writes is otherwise a stretch with no sample in
; it, and at PCM_GROUP = 1 a sample period is ~8 writes, so 4 was already
; marginal and a short sub-slot could pass through without pumping at all.
PCM_PUMP_MASK equ ${ONE_GATE ? 1 : 3}
PCM_PAD_LIVE equ ${Math.max(1, padFor(variant, "add", IDLE_SHIFT, unroll)) > 1 ? 1 : 0}
PCM_IDLE_PAD equ ${Math.max(1, padFor(variant, "add", IDLE_SHIFT, unroll))}      ; the most an idle iteration may hold to
                        ; FLOORED AT 1: the pad loop counts DOWN, so a zero here
                        ; is 256 iterations — ~4,000 cycles an idle tick, which
                        ; pp_pad_floor stores unguarded. A pad target small
                        ; enough to leave nothing over (PCM_GROUP = 1, where the
                        ; gate does all the spacing) hit exactly that.
PCM_GROUP   equ ${PCM_GROUP}       ; samples per Timer B gate (§5.1.2)
; What the mix loops may NOT emit, so that the frame's BOUNDARY can.
;
; A gated emit pins the frame: CHUNK samples at one gate period each span
; CHUNK x PCM_TICK_CY however cheap the code between them is, and anything the
; frame does OUTSIDE that span is added to it. The boundary — the pass tails,
; the ring bookkeeping, the ISR's own prologue and epilogue, and the next
; frame's slot head before its first chip write — is ~2.5 sample periods of
; exactly that, and with the loops claiming every sample the frame owes there
; was no sample left for it to send. So the DAC held, once a frame, 60 times a
; second: measured at 3.45 sample periods a frame, and it is the 60 Hz sideband
; npm run dac:wav reports. This is XGM2's "<=168 cycles between sample outputs
; EVERYWHERE" rule in the form Timer B forces on us.
PCM_EMIT_RESERVE equ ${PCM_EMIT_RESERVE}  ; samples held back for the boundary
PCM_TB      equ ${TIMER_B_TB}       ; the \$26 byte: Timer B overflows every
                        ; 16 x (256 - TB) FM samples, and PCM_GROUP comes out
                        ; of each one. Generated, so the two cannot drift.
` : ""}`);

  // TWO ADVANCE FORMS, AND NEITHER IS A RESAMPLER. `mix_*_s*` is the octave
  // shift (C = 2^k bytes a tick) and `mix_*nr_s*` is one byte a tick; ms_bind
  // picks between them once a pass on the voice's increment, exactly as it used
  // to pick between the resampler and nr. Every sounding entry in a bank is
  // baked now (live/src/export-mmb.js bakes looped material too), so the 16.16
  // path had nothing left to play — and taking it out is what frees HL'/DE'
  // for the emit, which was the whole point.
  const advance = paced ? `${variant}sh` : variant;
  L.push("R_FIRST_BEG:");
  L.push(loopSet("mix_first", advance, "first", unroll, paced, R));
  L.push("R_FIRST_END:");
  L.push("R_ADD_BEG:");
  L.push(loopSet("mix_add", advance, "add", unroll, paced, R));
  L.push("R_ADD_END:");
  if (paced) {
    L.push("R_NR_BEG:");
    for (const role of ["first", "add"])
      L.push(nrLoopSet(`mix_${role}`, `${variant}nr`, role, unroll));
    L.push("R_NR_END:");
  }

  // ── output pass ──────────────────────────────────────────────────────────
  // Paced builds have no output PASS: the samples went out inside the mix. What
  // is left is the handful the interleave could not reach — a segment shorter
  // than the unroll leaves its ticks to the single-tick loop, which carries no
  // feed, and R is not a multiple of the cadence — so the frame ends by flushing
  // them. Normally one sample; a heavily segmented frame, a few more.
  L.push("R_OUT_BEG:");
  if (paced) masterOutOfLine.push(ONE_GATE ? "eg_ms" : "fo_ms");
  if (paced && ONE_GATE) L.push(emitGate().join("\n"));
  if (paced) {
    L.push(`; flush_rest: IY = ring cursor, B = samples still owed (0 = none). Same gate
; as the inline emit — a sample that comes out here is still a sample.
${ONE_GATE ? `flush_rest:
        ; NOTHING BLOCKS at PCM_GROUP = 1 (see emit_try), so there is nothing to
        ; flush: a sample the frame still owes goes out the moment the timer
        ; comes due, from whatever code is running — the mixer, the slot's write
        ; loops, or the idle feed after the interrupt has returned. Draining the
        ; debt here would be the one place that waits, which is the thing this
        ; design removed.
        ret
` : `flush_rest:
        ld   a,b
        or   a
        ret  z
fr_loop:
        push bc
        call feed_one
        pop  bc
        djnz fr_loop
        ret
`}
; feed_one: one sample out of the ring, gate and all — the out-of-line twin of
; the emit the loops carry inline (§5.1.2). Every stretch of work longer than a
; sample period calls this, which is what stops the frame's chip writes and its
; pass transitions from being dead time the DAC spends holding. Touches A, HL
; and the flags; IY is the feed cursor and G_EMITS the frame's remaining debt.
;
; The ASK is inline here too, ahead of the spill: "not due" is the answer most
; of the time, and saving HL to find that out cost 21 cycles for nothing.
feed_one:
${ONE_GATE ? "" : `        ld   a,(G_EMITS)
        or   a
        ret  z                  ; the frame's samples are all out
        dec  a
        ld   (G_EMITS),a
`}${ONE_GATE ? `${askBlock().join("\n")}
        ret  z                  ; not due — and nothing was saved to restore
        push hl                 ; HL is the slot cursor at most call sites
        call emit_send          ; the one emit, and the debt is ITS business` : `        push hl                 ; HL is the slot cursor at most call sites
${gatePrologue().join("\n")}
        ld   a,$2a              ; the call sites are chip writes: re-latch
        ld   (YM_ADDR0),a
        ld   a,(iy+0)
${masterChain("fo_ms", "fo_ex").join("\n")}
        jr   fo_ex
fo_ex:
        xor  $80
        ld   (YM_DATA0),a       ; $2A is fed blind
        inc  iy`}
        ; No wrap here: emit_send does it, on the send path, for every caller.
        pop  hl
        ret`);
  } else if (wide) {
    L.push(`; DAC byte = clamp(sum - 128*(N-1), 0, 255). inc/dec/ld leave the carry
; alone, so the borrow out of \`sub e\` reaches \`sbc a,d\` across the plane read.
out_pass:
        ld   a,$2a
        ld   (YM_ADDR0),a       ; the address register is latched once
        ld   hl,MIXLO
        ld   a,(G_BIASLO)
        ld   e,a
        ld   a,(G_BIASHI)
        ld   d,a
        ld   b,PCM_MIX_R
op_loop:
        ld   a,(hl)
        sub  e
        inc  h
        ld   c,a                ; C = low result
        ld   a,(hl)
        dec  h
        inc  l
        sbc  a,d
        jr   nz,op_clamp
        ld   a,c
op_have:
        ld   (YM_DATA0),a       ; $2A is fed blind — driver.md §5.1
        djnz op_loop
        ret
op_clamp:
        jp   m,op_zero
        ld   a,255
        jr   op_have
op_zero:
        xor  a
        jr   op_have`);
  } else if (variant.startsWith("i8sat")) {
    L.push(`; The plane is signed (saturated at every add), so the output pass biases.
out_pass:
        ld   a,$2a
        ld   (YM_ADDR0),a
        ld   hl,MIXLO
        ld   b,PCM_MIX_R
os_loop:
        ld   a,(hl)
        xor  $80
        inc  l
        ld   (YM_DATA0),a       ; $2A is fed blind — driver.md §5.1
        djnz os_loop
        ret`);
  } else {
    L.push(`; The first voice biased as it stored, so the plane is already DAC-ready.
out_pass:
        ld   a,$2a
        ld   (YM_ADDR0),a
        ld   hl,MIXLO
        ld   b,PCM_MIX_R
o8_loop:
        ld   a,(hl)
        inc  l
        ld   (YM_DATA0),a
        djnz o8_loop
        ret`);
  }
  L.push("R_OUT_END:");

  // ── master patch sites (driver.md §14.1) ─────────────────────────────────
  // Where the master shift LIVES: engine.z80's pc_master writes the chain at
  // every address below, and for the inline sites the dispatch byte eight bytes
  // ahead of it as well. Generated rather than hand-kept because there is one
  // entry per loop copy and a missed one is a copy that ignores master — which
  // still makes sound, just at the wrong level, and only while that copy runs.
  if (paced) {
    // At PCM_GROUP = 1 there are no inline sites at all: the loops call the one
    // emit, so its chain is the only one and the dispatch byte does not exist.
    // The three equs stay defined — engine.z80's mst_apply is not generated and
    // reads them unconditionally — and MST_N = 0 is what stops it walking a
    // table that is not there.
    const first = masterInline[0] ?? { ms: "eg_ms", ea: "eg_ms", ep: "eg_ms", ex: "eg_ex" };
    L.push(`
; The two values the dispatch byte takes. Label arithmetic, not literals: the
; block's layout is this generator's business and the assembler is what proves
; the offsets still hold.
MST_D_PLAIN equ ${first.ep}-${first.ms}+7   ; fall through to the unpatched emit
MST_D_ATTEN equ ${first.ea}-${first.ms}+7   ; …or into the one with the chain
MST_SLOTS   equ ${PCM_MASTER_MAX_SHIFT}      ; chain slots, = PCM_MASTER_MAX_SHIFT
MST_CHAIN_D equ 8       ; chain address - dispatch byte address
; How far past a chain its tail is — where the jump over the unused slots has to
; land. It differs between the two shapes: an inline site's tail sits behind the
; plain copy's own prologue, feed_one's does not. Label arithmetic per shape, so
; neither can be re-laid-out without this following.
MST_SKIP    equ ${first.ex}-${first.ms}
MST_SKIP1   equ ${ONE_GATE ? "eg_ex-eg_ms" : "fo_ex-fo_ms"}
MST_N       equ ${masterInline.length}
MST_N1      equ ${masterOutOfLine.length}
; EG_R27P: the byte cs_r27 patches with the gated $27. At PCM_GROUP = 1 it is
; the emit's own immediate — 6 cycles a sample cheaper than the RAM read it
; replaces; otherwise it IS that RAM byte, so the write is a harmless repeat of
; the one cs_r27 already makes.
EG_R27P     equ ${ONE_GATE ? "eg_r27+1" : "G_R27G"}
mst_tab:
        dw   ${(masterInline.length ? masterInline.map((m) => m.ms) : ["0"]).join(", ")}
mst_tab1:
        dw   ${masterOutOfLine.join(", ")}`);
  }

  // ── silence fill ─────────────────────────────────────────────────────────
  // If the storing voice ends part-way through a frame the rest of the plane
  // was never written, so it has to be filled with the value that means
  // silence for this buffer format. Paced builds have no use for it: every pass
  // runs its full R ticks, silently if there is no voice behind it, so the
  // storing pass has already written the whole plane.
  if (!paced) L.push(`
; fill_silence: HL = plane cursor, B = ticks remaining. Nothing to do when B = 0.
fill_silence:
        ld   a,b
        or   a
        ret  z
${wide ? `fs_lp:
        ld   (hl),$80
        inc  h
        ld   (hl),0
        dec  h
        inc  l
        djnz fs_lp
        ret` : `fs_lp:
        ld   (hl),${variant.startsWith("i8sat") ? "0" : "$80"}
        inc  l
        djnz fs_lp
        ret`}`);

  // ── per-voice entry ──────────────────────────────────────────────────────
  L.push(`
; mix_seg: run one segment of a voice pass — the ticks the caller has already
; proved cannot cross a loop or end boundary.
;
;   IX = voice struct      A  = 0 for the storing voice, nonzero to accumulate
;   B  = ticks in this segment (1..255)
;   L  = buffer tick index (H is set here)
;
; Splits B into unrolled iterations plus a single-tick remainder, loads the
; register file, and returns the advanced position in the struct.
mix_seg:
        ld   (G_SEG_L),a        ; accumulate flag (A is needed for other things)
        ld   a,l
        ld   (G_SEG_I),a        ; buffer index to resume at

        ; --- split B into unrolled iterations + single-tick remainder ---
        ; Done here, before the register file is loaded, because it is the last
        ; moment HL and DE are free.
${paced ? `${ONE_GATE ? "" : `        ld   a,(G_EMITS)        ; nothing to feed: single-tick copies only
        or   a
        jr   nz,ms_paced
        ld   (G_SEG_N),a
        ld   a,b
        ld   (G_SEG_R),a
        jr   ms_split
ms_paced:`}
        ld   h,0                ; the cadence is 3, so the divide is a table
        ld   l,b
        ld   de,div_tab
        add  hl,de
        ld   a,(hl)
        ; …capped by what the frame still owes, and charged, exactly as
        ; mix_seg_live does it — this is the path a SILENT pass takes, and it
        ; emits too.
${ONE_GATE ? `        ; PCM_GROUP = 1: the loop does not RESERVE samples and does not charge
        ; them up front. Every iteration asks emit_try, emit_try charges what it
        ; actually sends, and a segment that asks more often than the timer
        ; answers simply gets fewer — which is the correct answer, not an
        ; overrun. The cap this replaces existed to keep a BLOCKING emit inside
        ; the frame's debt; nothing blocks now.` : `        ld   hl,G_EMITS
        push bc
        ld   b,a                ; the segment's iterations
        ld   a,(hl)
        sub  PCM_EMIT_RESERVE   ; …less what the FRAME BOUNDARY is owed
        jr   nc,ms_av
        xor  a                  ; the reserve is all that is left
ms_av:
        cp   b
        jr   nc,ms_take      ; spare >= iterations: the loop takes them all
        ld   b,a                ; …otherwise only what is spare
ms_take:
        ld   a,b
        pop  bc`}
ms_owed:
        ld   (G_SEG_N),a        ; iterations
${ONE_GATE ? "" : `        neg
        add  a,(hl)
        ld   (hl),a`}
        ld   a,(G_SEG_N)
        ld   l,a
${MUL_U}
        ld   l,a
        ld   a,b
        sub  l
        ld   (G_SEG_R),a        ; ticks the single-tick copies take
ms_split:` :
`        ld   a,b
        and  MIX_UNROLL-1
        ld   (G_SEG_R),a        ; remainder ticks
        ld   a,b
        ; iterations = ticks / MIX_UNROLL (MIX_UNROLL is a power of two)
${unroll === 1 ? "" : `${[...Array(Math.log2(unroll) | 0)].map(() => "        srl  a").join("\n")}\n`}        ld   (G_SEG_N),a`}
        ; --- load the register file ---
        ; Its own label so the profiler can price it: this block and ms_done's
        ; store are the whole of what carrying the register file across a
        ; voice's consecutive segments could remove.
ms_load:
${paced ? `        ; NO REGISTER FILE — in the PACED build, and only there. The shipped
        ; engine calls mix_seg from mvf_idle_seg alone (engine.z80), with
        ; IX = G_IDLEV, so the copy ms_bind picks is always the IDLE shift and
        ; its whole tick body is one inc l: no sample read, no position
        ; advanced, the fraction and the increment never looked at. Loading them
        ; was seven ld r,(ix+d) at 19 cycles each — the Z80's dearest
        ; addressing mode — and storing them back four more, every segment.
        ;
        ; The bench image (mixer-bench.mjs, paced: false) uses mix_seg as the
        ; GENERAL path, sounding voices included, so it keeps the file.
        ; The shipped sounding path is mix_seg_live, which carries its file
        ; across a whole pass and is untouched either way.
` : `        ld   l,(ix+PV_FRAC)
        ld   h,(ix+PV_FRAC+1)
        ld   e,(ix+PV_INCF)
        ld   d,(ix+PV_INCF+1)
        exx                     ; HL' = frac, DE' = incFrac
        ld   c,(ix+PV_INCI)     ; AFTER the exx — exx swaps BC too
        ld   e,(ix+PV_PTR)
        ld   d,(ix+PV_PTR+1)
`}        ld   a,(G_SEG_I)
        ld   l,a
        ld   a,(G_MIXP)         ; the plane being mixed this frame
        ld   h,a
        ; --- unrolled iterations ---
        ld   a,(G_SEG_N)
        ld   b,a
        or   a
        jr   z,ms_rem
        push bc
        call ms_call_unrolled
        pop  bc
ms_rem:
        ld   a,(G_SEG_R)
        or   a
        jr   z,ms_done
        ld   b,a
        call ms_call_single
ms_done:
${paced ? `        ; Only the resume index — see ms_load: the idle pass moved no position.
        ld   a,l
        ld   (G_SEG_I),a
        ret` : `        ; --- write the position back ---
        ld   (ix+PV_PTR),e
        ld   (ix+PV_PTR+1),d
        ld   a,l
        ld   (G_SEG_I),a        ; resume index for the caller
        exx
        ld   (ix+PV_FRAC),l
        ld   (ix+PV_FRAC+1),h
        exx
        ld   a,(G_SEG_I)
        ld   l,a
        ret`}

; Entry to the shift-specialised copies. Both are bare self-modified jumps that
; ms_bind has already pointed at the right loop, so the per-segment path is ONE
; instruction — the register file in HL/DE is live here and nothing may touch
; it. The copy rets to mix_seg, which is why these are jumps and not calls.
ms_call_unrolled:
ms_go_u:
        jp   0
ms_call_single:
ms_go_s:
        jp   0
${paced ? `
; ── the live-file segment path (§5.1 (b)) ───────────────────────────────────
; A sounding pass keeps its register file LIVE across its consecutive
; segments: ms_pload fills it once at pass entry, mix_seg_live runs one
; segment without touching the struct, and ms_pstore writes the position back
; once when the pass ends. The boundary math between segments (engine.z80
; mvf_seg) works on the live registers — DE = ptr, C = incInt, HL' = frac,
; DE' = incFrac are its to preserve. What this removes is ms_load + ms_done
; on every segment after a pass's first, measured at ~2.7k cycles a frame.
; mix_seg above keeps the load/store shape for the IDLE path, which runs one
; segment a pass on G_IDLEV and would gain nothing.

; ms_pload: fill the register file from the voice struct, once per pass. The
; plane cursor is NOT built here — mix_seg_live rebuilds HL every segment,
; because the boundary math needs HL and the index is parked in G_IDX.
ms_pload:
        ; NO FRACTION. It used to load HL' = frac and DE' = incFrac and the pass
        ; carried them for its whole life; there is no fraction any more, and
        ; THE SHADOW SET IS NOT THE MIXER'S — the emit keeps the YM ports there.
        ld   c,(ix+PV_INCI)     ; bytes a tick: 1, or 2^k for an octave shift
        ld   e,(ix+PV_PTR)
        ld   d,(ix+PV_PTR+1)
        ret

; ms_pstore: the pass is over — write the live position back, once.
ms_pstore:
        ld   (ix+PV_PTR),e
        ld   (ix+PV_PTR+1),d
        ret

; mix_seg_live: one segment on the LIVE register file.
;   B = ticks (1..255); G_IDX = plane index; G_SEG_L was set at bind time
mix_seg_live:
        ; A frame with nothing to feed — a PRIME frame building the ring's lead
        ; (§5.1.2) — runs entirely on the SINGLE-TICK copies, which carry no
        ; emit. Slower per tick by the djnz, and it is one frame per burst.
${ONE_GATE ? "" : `        ld   a,(G_EMITS)
        or   a
        jr   nz,msl_paced
        ld   (G_SEG_N),a
        ld   a,b
        ld   (G_SEG_R),a
        jr   msl_go
msl_paced:`}
        push de                 ; the divide needs DE; the file owns it
        ld   h,0                ; the cadence is 3, so the divide is a table
        ld   l,b
        ld   de,div_tab
        add  hl,de
        ld   a,(hl)
        pop  de
        ; The loop emits one sample per iteration and does NOT check whether the
        ; frame still owes any — that check is HERE, once a segment, where it is
        ; free. Anything the loop may not emit runs through the single-tick
        ; copies instead, which carry no emit at all. That is also what pays for
        ; the samples the frame's other emit points (feed_one) took.
${ONE_GATE ? `        ; PCM_GROUP = 1: the loop does not RESERVE samples and does not charge
        ; them up front. Every iteration asks emit_try, emit_try charges what it
        ; actually sends, and a segment that asks more often than the timer
        ; answers simply gets fewer — which is the correct answer, not an
        ; overrun. The cap this replaces existed to keep a BLOCKING emit inside
        ; the frame's debt; nothing blocks now.` : `        ld   hl,G_EMITS
        push bc
        ld   b,a                ; the segment's iterations
        ld   a,(hl)
        sub  PCM_EMIT_RESERVE   ; …less what the FRAME BOUNDARY is owed
        jr   nc,msl_av
        xor  a                  ; the reserve is all that is left
msl_av:
        cp   b
        jr   nc,msl_take      ; spare >= iterations: the loop takes them all
        ld   b,a                ; …otherwise only what is spare
msl_take:
        ld   a,b
        pop  bc`}
msl_owed:
        ld   (G_SEG_N),a        ; iterations, and samples, this segment carries
${ONE_GATE ? "" : `        neg
        add  a,(hl)
        ld   (hl),a             ; charge them to the frame`}
        ld   a,(G_SEG_N)
        ld   l,a
${MUL_U}
        ld   l,a
        ld   a,b
        sub  l
        ld   (G_SEG_R),a        ; ticks the single-tick copies take
msl_go:
        ld   a,(G_IDX)
        ld   l,a
        ld   a,(G_MIXP)
        ld   h,a                ; plane cursor rebuilt; the rest is live
        ld   a,(G_SEG_N)
        or   a
        jr   z,msl_rem
        ld   b,a
        call ms_call_unrolled
msl_rem:
        ld   a,(G_SEG_R)
        or   a
        jr   z,msl_done
        ld   b,a
        call ms_call_single
msl_done:
        ld   a,l
        ld   (G_IDX),a          ; park the plane index for the boundary math
        ret
` : ""}

; ms_bind: point both entries at this PASS's copies.
;
; The copy is chosen by (role, shift) and BOTH are constant for a whole voice
; pass — a pass is one voice, and PV_SHIFT only moves when a PCM_VOL arrives,
; which happens between passes. Doing this per SEGMENT re-derived it five or six
; times a frame: ~1,700 cycles spent on values that were
; already known. Rebind after anything that changes the voice under the pass —
; engine.z80 does it at pass entry and again when a pass falls through to the
; silent loop.
ms_bind:
        push hl
        push de
        push bc
        ld   a,(ix+PV_SHIFT)
        add  a,a                ; word table
        ld   e,a
        ld   d,0
${paced ? `        ; PITCH BAKED? incI == 1 and incF == 0 means the 16.16 resampler would
        ; advance the position by exactly one sample a tick — so the copy that
        ; has no resampler is not an approximation of this voice, it is the same
        ; arithmetic with 37 cycles a tick taken out (driver.md §14.2). Decided
        ; ONCE A PASS here, never per tick, and it costs four instructions.
        ;
        ; Only the UNROLLED entry swaps. The single-tick copies below keep the
        ; resampling table on purpose: a segment leaves them at most one tick and
        ; the general path computes the same +1 for a baked voice anyway.
        ld   a,(ix+PV_INCI)
        dec  a
        or   (ix+PV_INCF)
        or   (ix+PV_INCF+1)
        jr   nz,msb_rs
        ld   hl,mix_addnr_tab
        ld   a,(G_SEG_L)
        or   a
        jr   nz,msb_u
        ld   hl,mix_firstnr_tab
        jr   msb_u
msb_rs:` : ""}
        ld   hl,mix_add_tab
        ld   a,(G_SEG_L)
        or   a
        jr   nz,msb_u
        ld   hl,mix_first_tab
msb_u:
        add  hl,de
        ld   a,(hl)
        inc  hl
        ld   h,(hl)
        ld   l,a
        ld   (ms_go_u+1),hl
        ; Halfway. ms_bind is ~230 cycles of straight line that a pass runs
        ; once, and the emit that precedes it is another 250 — together more
        ; than a sample period at PCM_FM = 8, which is one overflow thrown away
        ; per pass per frame. The registers are already spilled above, so the
        ; ask costs the 43 cycles it takes to find the timer not due.
        call feed_one
        ld   hl,mix_add1_tab
        ld   a,(G_SEG_L)
        or   a
        jr   nz,msb_s
        ld   hl,mix_first1_tab
msb_s:
        add  hl,de
        ld   a,(hl)
        inc  hl
        ld   h,(hl)
        ld   l,a
        ld   (ms_go_s+1),hl
        pop  bc
        pop  de
        pop  hl
        ret
`);

  // What ONE PASS costs, unpadded, by shift — R/PACE_PASSES iterations of
  // (U ticks + an emit + the loop's back edge + the window stall). The engine
  // sums three of these to find what a frame has left for the silent passes'
  // pad, and a table is what removes the multiply from that path. Priced with
  // the "add" role for every entry: the first pass is cheaper, so the sum comes
  // out high, so the pad comes out small — which is the safe direction.
  //
  // The emit is priced at its AVERAGE here, not at the pad's non-gate figure:
  // one emit in PCM_GROUP takes the gate path, and the frame really does spend
  // those cycles even though the pad has no interest in them.
  if (paced) {
    const iters = Math.floor(R / PACE_PASSES);
    const emit = EMIT_CYCLES + Math.round(GATE_CYCLES / PCM_GROUP);
    const cost = [...Array(IDLE_SHIFT + 1)].map((_, s) => Math.min(65535, iters *
      (unroll * tickCost(variant, "add", s) + (s <= 7 ? unroll * PACE_WINDOW : 0)
        + emit + 14)));
    L.push(`
; pass_cost_tab[shift] = ${iters} iterations x one unpadded iteration, in cycles.
pass_cost_tab:`);
    for (let i = 0; i <= IDLE_SHIFT; i += 5)
      L.push(`        dw   ${cost.slice(i, i + 5).join(", ")}`);
  }

  // The cadence is 3, which is the one divisor the Z80 cannot shift. A segment
  // is at most R ticks, so the whole quotient fits in a table smaller than the
  // shift-and-add routine it replaces — and costs ~30 cycles per segment
  // instead of ~150.
  if (paced) {
    const q = [...Array(R + 1)].map((_, n) => (n / PACE_PASSES) | 0);
    L.push(`\n; div_tab[n] = n / ${PACE_PASSES}, for n = 0..PCM_MIX_R\ndiv_tab:`);
    for (let i = 0; i <= R; i += 16)
      L.push(`        db   ${q.slice(i, i + 16).join(",")}`);
  }
  return L.join("\n");
}

// Standalone image for tools/mixer-bench.mjs: the RAM map, the core, and a
// driver that mixes G_NVOICE voices for one whole frame in a single segment.
export function generateBenchImage(opts = {}) {
  const { variant = "i8sat", R = DEFAULT_R, unroll = 2 } = opts;
  const wide = variant.startsWith("i16");
  return `; GENERATED by tools/gen-mixer.mjs — bench image, do not edit.
YM_ADDR0    equ $4000
YM_DATA0    equ $4001
MIXLO       equ $1000
MIXHI       equ $1100
PV_PTR      equ 0
PV_FRAC     equ 2
PV_INCF     equ 4
PV_INCI     equ 6
PV_SHIFT    equ 7
PCM_V_SIZE  equ 8
VOICES      equ $1600
G_NVOICE    equ $1620
G_BIASLO    equ $1622
G_BIASHI    equ $1623
G_VIDX      equ $1624
G_VPTR      equ $1625
G_SEG_N     equ $1627
G_SEG_L     equ $1629
G_SEG_I     equ $162a
G_SEG_R     equ $162b
G_MIXP      equ $162c
STACK_TOP   equ $1f00

        org 0
        jp   bench

${generateMixerCore({ variant, R, unroll })}

bench:
        di
        ld   sp,STACK_TOP
        ld   a,MIXLO>>8
        ld   (G_MIXP),a         ; the bench mixes into the one plane it has
        call frame
        halt

frame:
        ld   a,(G_NVOICE)
        or   a
        ret  z
        ld   hl,VOICES
        ld   (G_VPTR),hl
        xor  a
        ld   (G_VIDX),a
fr_voice:
        ld   ix,(G_VPTR)
        ld   a,(G_VIDX)
        ; The specialised copies are bound per PASS, not per segment, so a
        ; caller that drives mix_seg itself has to bind too — the entries are
        ; self-modified jumps and are not valid until it does.
        ld   (G_SEG_L),a
        call ms_bind
        ld   a,(G_VIDX)
        ld   b,PCM_MIX_R
        ld   l,0
        call mix_seg
        ld   hl,(G_VPTR)
        ld   de,PCM_V_SIZE
        add  hl,de
        ld   (G_VPTR),hl
        ld   hl,G_VIDX
        inc  (hl)
        ld   a,(G_NVOICE)
        cp   (hl)
        jr   nz,fr_voice
        jp   out_pass
`;
}

// ── The sample clock, for the engine's own source ──────────────────────────
// engine.z80 uses these BEFORE its `include "mixer.z80"` (the boot's timer
// setup, the ring target), so they cannot live in the mixer core; they are a
// second generated file it includes at the top. Generated for the reason
// everything else here is: the rate has three mirrors (this, mml_rate.h,
// mmb.js) and a hand-kept one is what put the DAC 37 ms behind the FM.
export const RATE_PATH =
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "rate.z80");

export function rateSource() {
  const na = TIMER_A_NA;
  return `; GENERATED by tools/gen-mixer.mjs — do not edit.
; The DAC's sample clock: ${(53693175 / 7 / GATE_YM * (PCM_TIMER === "B" ? PCM_GROUP : 1)).toFixed(1)} Hz (${TIMER_FM} FM samples an overflow, ${PCM_TIMER === "B" ? PCM_GROUP : 1} sample(s) out of it, Timer ${PCM_TIMER}).

; WHICH TIMER, as the four values the engine actually uses. Timer B's period is
; 16 x (256 - TB) FM samples, so 16 is its shortest and 3,329 Hz the fastest
; clock it can gate EVERY sample at; Timer A's is (1024 - NA) across 10 bits,
; i.e. any rate from 52 Hz to 53,267 Hz. CSM owns Timer A when a score uses it,
; which is the whole reason both shapes stay in the engine.
PCM_TIMER_A equ ${PCM_TIMER === "A" ? 1 : 0}
PCM_TFLAG   equ $${TIMER_FLAG.toString(16).padStart(2, "0")}       ; the status bit this timer's overflow raises
PCM_TLOAD   equ $${TIMER_LOAD.toString(16).padStart(2, "0")}       ; \$27: Load | Enable, and BOTH are required
PCM_TRESET  equ $${TIMER_RESET.toString(16).padStart(2, "0")}       ; \$27: the bit that clears that flag
${PCM_TIMER === "A"
  ? `PCM_TA_HI   equ ${na >> 2}      ; \$24 = NA >> 2, NA = 1024 - ${TIMER_FM}
PCM_TA_LO   equ ${na & 3}      ; \$25 = NA & 3`
  : `PCM_TA_HI   equ 0
PCM_TA_LO   equ 0`}

; How many FINISHED samples the ring carries ahead of the feed: ONE FRAME of
; them, because that is exactly what mml_render_frame() cancels by starting a
; PCM track a frame early. Anything else is an offset between the PCM and the
; FM that nothing takes back out (live/src/mmb.js, PCM_RING_TARGET).
PCM_RING_TARGET equ ${PCM_RING_TARGET}
`;
}

// The two generated sources engine.z80 includes, for assemble()'s `sources` —
// one place, so a tool that measures the engine cannot pick up a stale copy of
// half of it from the disk.
export function generatedSources() {
  return { [MIXER_PATH]: mixerSource(), [RATE_PATH]: rateSource() };
}

export function writeRate() {
  writeFileSync(RATE_PATH, rateSource());
  return RATE_PATH;
}

// Write src/mixer.z80 in the settled configuration (driver.md §5.3.1) — the
// file engine.z80 includes. Exported so the engine build regenerates it rather
// than trusting a checked-in copy to match.
// Where engine.z80's `include "mixer.z80"` resolves to.
export const MIXER_PATH =
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mixer.z80");

// The mixer's source, WITHOUT writing it. Pass it to assemble()'s `sources` and
// the engine builds from it with the working tree untouched — which is what
// every tool that only wants to measure should do (see the note in z80asm.mjs).
export function mixerSource() {
  return generateMixerCore({ unroll: PACE_PASSES, paced: true });
}

// Writing it is for `node tools/gen-mixer.mjs` and for install-sgdk's explicit
// regeneration — the two places that mean to change the tree.
export function writeMixer() {
  writeFileSync(MIXER_PATH, mixerSource());
  return MIXER_PATH;
}

if (process.argv[1] && process.argv[1].endsWith("gen-mixer.mjs")) {
  const dst = writeMixer();
  console.log(`wrote ${writeRate()}`);
  console.log(`wrote ${dst} (i8sat, R = ${DEFAULT_R}, unroll ${PACE_PASSES}, paced feed`
    + ` — the settled configuration)`);
  console.log(`  sample period ${SAMPLE_CYCLES} cyc, pads hold to ${PAD_TARGET}; pads`);
  for (const role of ["first", "add"]) {
    const pads = [...Array(IDLE_SHIFT + 1)].map((_, s) =>
      `${s === MUTE_SHIFT ? "mute" : s === IDLE_SHIFT ? "idle" : `s${s}`}`
      + `:${padFor("i8sat", role, s, PACE_PASSES)}`);
    console.log(`  ${role.padEnd(5)} ${pads.join(" ")}`);
  }
}
