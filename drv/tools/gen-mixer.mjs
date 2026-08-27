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
} from "../../live/src/mmb.js";

export const MUTE_SHIFT = 8;   // PV_SHIFT value meaning "silent, keep advancing"
// PV_SHIFT for a pass with no voice behind it at all (engine.z80's G_IDLEV).
// Distinct from MUTE because it must NOT advance a position: `:vol 0` keeps a
// note running silently and has to stay in step, an absent voice has nothing to
// stay in step with. The difference is 35 cycles a tick, and it matters because
// those are the cycles the pad has to give back to the frame — an idle pass is
// where nearly all of a light frame's slack lives.
export const IDLE_SHIFT = 9;
export const VARIANTS = ["i16", "i8", "i8sat", "i16nr", "i8satnr"];

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
export const TIMER_B_K = 1;                  // 256 - TB
export const TIMER_B_TB = 256 - TIMER_B_K;    // the byte the engine writes to $26
export const GATE_YM = 2304 * TIMER_B_K;      // YM clocks per overflow
export const PCM_GROUP = PCM_SAMPLES_PER_GATE * TIMER_B_K;
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
// What the pad holds an iteration to. NOT the sample period, and that is the
// whole point: a Timer B group gets 3 x 358 = 1,075 cycles for the mixing AND
// for the out-of-loop work that falls in it, and a group that runs long is
// never made up. Padding each iteration to the full period spends every spare
// cycle on even spacing and leaves the frame's ~290 cycles a group of segment
// set-ups and chip writes with nowhere to go — measured, that is the whole
// overrun. So the pad gets what is left after both:
//
//     1075 / PCM_GROUP  -  out-of-loop work per sample  =  ~260
//
// Below the sample period the group's samples bunch slightly and then wait at
// the gate, which `npm run dac` measures as span and wander; above it the frame
// loses its vblank, which is a hiccup and a lost frame of music. This is the
// one number here that is a judgement rather than a measurement, and it is
// re-judged with `npm run dac` and `npm run dac:wav`.
// A FRACTION of the sample period. A fixed pad silently stops matching the
// period when the rate knob moves.
export const PAD_FRACTION = Number(process.env.PAD_FRACTION ?? 0.73);
export const PAD_TARGET = Math.round(SAMPLE_CYCLES * PAD_FRACTION);
// Under Timer B the pad's whole job is the interval between samples 2 and 3 of
// a gate's group: the gate itself re-synchronises sample 1, so nothing the pad
// does can accumulate and nothing outside the loop has to be charged against
// it. It is therefore a baked constant per (role, shift) — the runtime debt,
// its estimator (PACE_RESERVE / PACE_SEG), its tables and the per-frame segment
// count are all deleted, along with the ~20% slow frame they existed to stop.
// The history is in .claude/memory/plan-68k-split.md; the short version is that
// no constant can make an interval constant, which is what a clock is for.
export const PACE_WINDOW = 14;

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
  [/^add\s+a,\(hl\)$/, 7], [/^adc\s+a,c$/, 4], [/^add\s+hl,de$/, 11],
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
  const nr = variant.endsWith("nr");        // pre-resampled control case
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
    push("inc  de                ; pre-resampled: one sample per tick");
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
export const EMIT_CYCLES = 73;
// What the GATING emit costs on top of the other two, once per PCM_GROUP: the
// taken branch into `gate_wait`, its flag reset, the $2A re-latch, and the
// reload of the phase. Only the frame's total cares (`pass_cost_tab`); the pad
// does not, because this emit's interval is the timer's and not the pad's.
//
//   jr nz not taken 7 · call gate_wait 17 · gate_wait's body incl. its
//   `ld a,PCM_GROUP` 129 · minus the 12-cycle taken jr it replaces = 141
export const GATE_CYCLES = 141;
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
PCM_IDLE_PAD equ ${Math.max(1, padFor(variant, "add", IDLE_SHIFT, unroll))}      ; the most an idle iteration may hold to
                        ; FLOORED AT 1: the pad loop counts DOWN, so a zero here
                        ; is 256 iterations — ~4,000 cycles an idle tick, which
                        ; pp_pad_floor stores unguarded. A pad target small
                        ; enough to leave nothing over (PCM_GROUP = 1, where the
                        ; gate does all the spacing) hit exactly that.
PCM_GROUP   equ ${PCM_GROUP}       ; samples per Timer B gate (§5.1.2)
PCM_TB      equ ${TIMER_B_TB}       ; the \$26 byte: Timer B overflows every
                        ; 16 x (256 - TB) FM samples, and PCM_GROUP comes out
                        ; of each one. Generated, so the two cannot drift.
` : ""}`);

  L.push("R_FIRST_BEG:");
  L.push(loopSet("mix_first", variant, "first", unroll, paced, R));
  L.push("R_FIRST_END:");
  L.push("R_ADD_BEG:");
  L.push(loopSet("mix_add", variant, "add", unroll, paced, R));
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
  if (paced) masterOutOfLine.push("fo_ms");
  if (paced) {
    L.push(`; flush_rest: IY = ring cursor, B = samples still owed (0 = none). Same gate
; as the inline emit — a sample that comes out here is still a sample.
flush_rest:
        ld   a,b
        or   a
        ret  z
fr_loop:
        push bc
        call feed_one
        pop  bc
        djnz fr_loop
        ret

; feed_one: one sample out of the ring, gate and all — the out-of-line twin of
; the emit the loops carry inline (§5.1.2). Every stretch of work longer than a
; sample period calls this, which is what stops the frame's chip writes and its
; pass transitions from being dead time the DAC spends holding. Touches A, HL
; and the flags; IY is the feed cursor and G_EMITS the frame's remaining debt.
feed_one:
        ld   a,(G_EMITS)
        or   a
        ret  z                  ; the frame's samples are all out
        dec  a
        ld   (G_EMITS),a
        push hl                 ; HL is the slot cursor at most call sites
${gatePrologue().join("\n")}
        ld   a,$2a              ; the call sites are chip writes: re-latch
        ld   (YM_ADDR0),a
        ld   a,(iy+0)
${masterChain("fo_ms", "fo_ex").join("\n")}
        jr   fo_ex
fo_ex:
        xor  $80
        ld   (YM_DATA0),a       ; $2A is fed blind
        inc  iy
        ; feed_wrap, INLINE. It is 47 cycles of body behind a 27-cycle call, and
        ; the out-of-line emit already costs over twice what the loops' inline
        ; one does — measured, the emit machinery (this, gate_wait and the gate
        ; prologue) is more than a third of what is inside the ~11% of Timer B
        ; groups that overrun, and those groups ARE the frame's overrun.
        ;
        ; The wrap itself stays: no segment bound protects this emit, unlike the
        ; loops', so the cursor really can reach the top here. It fires once per
        ; RING_TOP-RING_BUF samples; the rest of the time this is four
        ; instructions asking.
        push iy
        pop  hl
        ld   a,h
        cp   RING_TOP>>8
        jr   nz,fo_nowrap
        ld   iy,RING_BUF
fo_nowrap:
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
    const first = masterInline[0];
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
MST_SKIP1   equ fo_ex-fo_ms
MST_N       equ ${masterInline.length}
MST_N1      equ ${masterOutOfLine.length}
mst_tab:
        dw   ${masterInline.map((m) => m.ms).join(", ")}
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
${paced ? `        ld   a,(G_EMITS)        ; nothing to feed: single-tick copies only
        or   a
        jr   nz,ms_paced
        ld   (G_SEG_N),a
        ld   a,b
        ld   (G_SEG_R),a
        jr   ms_split
ms_paced:
        ld   h,0                ; the cadence is 3, so the divide is a table
        ld   l,b
        ld   de,div_tab
        add  hl,de
        ld   a,(hl)
        ; …capped by what the frame still owes, and charged, exactly as
        ; mix_seg_live does it — this is the path a SILENT pass takes, and it
        ; emits too.
        ld   hl,G_EMITS
        cp   (hl)
        jr   c,ms_owed
        ld   a,(hl)
ms_owed:
        ld   (G_SEG_N),a        ; iterations
        neg
        add  a,(hl)
        ld   (hl),a
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
        ld   l,(ix+PV_FRAC)
        ld   h,(ix+PV_FRAC+1)
        ld   e,(ix+PV_INCF)
        ld   d,(ix+PV_INCF+1)
        exx                     ; HL' = frac, DE' = incFrac
        ld   c,(ix+PV_INCI)     ; AFTER the exx — exx swaps BC too
        ld   e,(ix+PV_PTR)
        ld   d,(ix+PV_PTR+1)
        ret

; ms_pstore: the pass is over — write the live position back, once.
ms_pstore:
        ld   (ix+PV_PTR),e
        ld   (ix+PV_PTR+1),d
        exx
        ld   (ix+PV_FRAC),l
        ld   (ix+PV_FRAC+1),h
        exx
        ret

; mix_seg_live: one segment on the LIVE register file.
;   B = ticks (1..255); G_IDX = plane index; G_SEG_L was set at bind time
mix_seg_live:
        ; A frame with nothing to feed — a PRIME frame building the ring's lead
        ; (§5.1.2) — runs entirely on the SINGLE-TICK copies, which carry no
        ; emit. Slower per tick by the djnz, and it is one frame per burst.
        ld   a,(G_EMITS)
        or   a
        jr   nz,msl_paced
        ld   (G_SEG_N),a
        ld   a,b
        ld   (G_SEG_R),a
        jr   msl_go
msl_paced:
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
        ld   hl,G_EMITS
        cp   (hl)
        jr   c,msl_owed
        ld   a,(hl)             ; fewer owed than iterations: emit only those
msl_owed:
        ld   (G_SEG_N),a        ; iterations, and samples, this segment carries
        neg
        add  a,(hl)
        ld   (hl),a             ; charge them to the frame
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

// Write src/mixer.z80 in the settled configuration (driver.md §5.3.1) — the
// file engine.z80 includes. Exported so the engine build regenerates it rather
// than trusting a checked-in copy to match.
export function writeMixer() {
  const dst = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mixer.z80");
  writeFileSync(dst, generateMixerCore({ unroll: PACE_PASSES, paced: true }));
  return dst;
}

if (process.argv[1] && process.argv[1].endsWith("gen-mixer.mjs")) {
  const dst = writeMixer();
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
