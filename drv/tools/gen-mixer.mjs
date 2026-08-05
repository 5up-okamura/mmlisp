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
// That is what fixes the unroll at PACE_PASSES and the pass count at three.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
// samples: one emit every PACE_PASSES ticks, which is why the unroll is 3.
//
// The pad exists because the mix is CHEAPER than the frame at anything under a
// full three-voice load: without it the feed would simply finish early and hold,
// which is the same bug in smaller print. Each loop copy is specialised on
// (role, shift), so its per-tick cost is a constant the generator can compute —
// and the pad it needs is therefore a baked immediate, not a runtime lookup.
export const FRAME_CYCLES = 59659;  // Z80 at 3.579545 MHz, one 59.92 Hz frame
export const PACE_PASSES = 3;       // voice passes per frame = the emit cadence
// The pad is sized against the true period, FRAME_CYCLES / R — and then the
// frame's work OUTSIDE the loops is charged back against it, because a frame
// that pads to the full period and then spends 13k cycles on segment set-up
// ends 20% late, which is a slow tempo and eventually a dropped frame.
//
// That charge is a debt in 16-cycle pad units, spread over all R samples rather
// than over the segment that incurred it: the pad lives where the SILENT passes
// are, and the segments are usually in the loud one. It is estimated from the
// last frame's segment count — frames come in the same shape as their
// predecessor, and a frame that ran long simply pads less on the next.
export const PACE_RESERVE = 7200;   // frame-level: consume, pass set-up, flush,
                                    // plus the margin that keeps the typical
                                    // frame just UNDER its budget rather than
                                    // just over — late is worse than short
export const PACE_SEG = 2400;       // per segment: mix_seg in and out, boundary math
export const PACE_SEG_MAX = 31;     // segments the debt table goes up to
export const paceTarget = (R) => Math.floor(FRAME_CYCLES / R);
export const paceDebt = (R, segs) =>
  Math.min(255, Math.round((PACE_RESERVE + segs * PACE_SEG) / (16 * R)));

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
function tickCost(variant, role, shift) {
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
function feed(pad) {
  const o = [];
  const push = (s) => o.push("        " + s);
  push("ld   a,(iy+0)          ; the sample the LAST frame finished");
  push("xor  $80               ; the plane is signed, the DAC is not");
  push("ld   (YM_DATA0),a      ; $2A: latched once a frame, then fed blind");
  push("inc  iy");
  if (pad > 0) {
    // Whether a copy pads at all is baked (its cost is known here); HOW MUCH is
    // not, because the segment charges its own overhead against it — see
    // ms_set_pad. G_PAD is written once per segment, never per tick.
    const k = lbl("pd");
    push("ld   a,(G_PAD)         ; pace: hold the tick to the frame's period");
    o.push(`${k}:`);
    push("dec  a");
    push(`jr   nz,${k}`);
  }
  return o;
}
// Cycles a feed costs at pad n: 49 for the emit, 16n + 8 for the pad.
const feedCost = (pad) => 49 + (pad > 0 ? 16 * pad + 8 : 0);
// The pad that brings one unrolled iteration (U ticks + a feed + `dec b`/`jp nz`)
// up to the frame's tick period. Below one iteration there is nothing to give
// back, so the copy is generated without a pad at all and simply runs long.
function padFor(variant, role, shift, U, R) {
  // One iteration carries exactly one sample, so its period IS the tick period.
  const n = Math.floor((paceTarget(R)
    - U * tickCost(variant, role, shift) - feedCost(0) - 14 - 8) / 16);
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
function loopSet(prefix, variant, role, U, paced, R) {
  const out = [];
  const N = IDLE_SHIFT + 1;               // shifts 0..7, then mute, then idle
  for (let s = 0; s < N; s++)
    out.push(loop(`${prefix}_s${s}`, variant, role, s, U,
      paced ? padFor(variant, role, s, U, R) : null));
  for (let s = 0; s < N; s++) out.push(loop(`${prefix}1_s${s}`, variant, role, s, 1));
  out.push(`${prefix}_tab:`);
  out.push(`        dw   ${[...Array(N)].map((_, s) => `${prefix}_s${s}`).join(", ")}`);
  out.push(`${prefix}1_tab:`);
  out.push(`        dw   ${[...Array(N)].map((_, s) => `${prefix}1_s${s}`).join(", ")}`);
  return out.join("\n");
}

export function generateMixerCore(
  { variant = "i8sat", R = 175, unroll = 2, paced = false } = {},
) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
  if (paced && variant !== "i8sat")
    throw new Error("paced feed is written for the shipped i8sat plane only");
  if (paced && unroll !== PACE_PASSES)
    throw new Error(`paced feed needs unroll = PACE_PASSES (${PACE_PASSES})`);
  uid = 0;
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
; the pad after it holds the iteration to ${paceTarget(R)} cycles. Three passes of R ticks
; carry R samples, so the frame's feed comes out at its own rate by construction.
` : ""}; ===========================================================================

PCM_MIX_R   equ ${R}
MIX_UNROLL  equ ${unroll}
PCM_MUTE_SH equ ${MUTE_SHIFT}      ; PV_SHIFT meaning "silent, keep advancing"
PCM_IDLE_SH equ ${IDLE_SHIFT}      ; PV_SHIFT meaning "no voice here at all"
${paced ? `PCM_PASSES  equ ${PACE_PASSES}      ; passes per frame — the feed's cadence
PCM_TICK_CY equ ${paceTarget(R)}     ; the period one paced iteration holds to
PCM_SEG_MAX equ ${PACE_SEG_MAX}      ; debt_tab's last entry (segments per frame)
` : ""}`);

  L.push("R_FIRST_BEG:");
  L.push(loopSet("mix_first", variant, "first", unroll, paced, R));
  L.push("R_FIRST_END:");
  L.push("R_ADD_BEG:");
  L.push(loopSet("mix_add", variant, "add", unroll, paced, R));
  L.push("R_ADD_END:");

  // ── output pass ──────────────────────────────────────────────────────────
  // Paced builds have no output PASS: the samples went out inside the mix. What
  // is left is the handful the interleave could not reach — a segment shorter
  // than the unroll leaves its ticks to the single-tick loop, which carries no
  // feed, and R is not a multiple of the cadence — so the frame ends by flushing
  // them. Normally one sample; a heavily segmented frame, a few more.
  L.push("R_OUT_BEG:");
  if (paced) {
    L.push(`; flush_rest: HL = plane cursor, B = samples still owed (0 = none).
flush_rest:
        ld   a,b
        or   a
        ret  z
fr_loop:
        ld   a,(hl)
        xor  $80
        inc  l
        ld   (YM_DATA0),a       ; $2A is fed blind — driver.md §5.1
        djnz fr_loop
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
${paced ? `        ld   hl,G_NSEG          ; what this frame is costing the NEXT one
        inc  (hl)
` : ""}
        ; --- split B into unrolled iterations + single-tick remainder ---
        ; Done here, before the register file is loaded, because it is the last
        ; moment HL and DE are free.
${paced ? `        ld   h,0                ; the cadence is 3, so the divide is a table
        ld   l,b
        ld   de,div_tab
        add  hl,de
        ld   a,(hl)
        ld   (G_SEG_N),a        ; iterations
        ld   l,a
        add  a,a
        add  a,l                ; 3 x iterations
        ld   l,a
        ld   a,b
        sub  l
        ld   (G_SEG_R),a        ; remainder ticks (0..2)` :
`        ld   a,b
        and  MIX_UNROLL-1
        ld   (G_SEG_R),a        ; remainder ticks
        ld   a,b
        ; iterations = ticks / MIX_UNROLL (MIX_UNROLL is a power of two)
${unroll === 1 ? "" : `${[...Array(Math.log2(unroll) | 0)].map(() => "        srl  a").join("\n")}\n`}        ld   (G_SEG_N),a`}
        ; --- load the register file ---
        ld   l,(ix+PV_FRAC)
        ld   h,(ix+PV_FRAC+1)
        ld   e,(ix+PV_INCF)
        ld   d,(ix+PV_INCF+1)
        exx                     ; HL' = frac, DE' = incFrac
        ld   c,(ix+PV_INCI)     ; AFTER the exx — exx swaps BC too
        ld   e,(ix+PV_PTR)
        ld   d,(ix+PV_PTR+1)
        ld   a,(G_SEG_I)
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
        ; --- write the position back ---
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
        ret

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

; ms_bind: point both entries at this PASS's copies${paced ? ", and size its pad" : ""}.
;
; The copy is chosen by (role, shift) and BOTH are constant for a whole voice
; pass — a pass is one voice, and PV_SHIFT only moves when a PCM_VOL arrives,
; which happens between passes. Doing this per SEGMENT re-derived it five or six
; times a frame${paced ? ", along with a pad that had not changed either" : ""}: ~1,700 cycles spent on values that were
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
${paced ? `        call ms_set_pad
` : ""}        pop  bc
        pop  de
        pop  hl
        ret
`);

  if (paced) {
    const IT = Math.floor(R / PACE_PASSES) + 1;   // iterations a segment can hold
    L.push(`
; ms_set_pad: G_PAD = base(role, shift) − G_DEBT, the pad this segment's copies
; hold to. Floored at 1 — the pad loop counts DOWN from G_PAD, so zero would be
; 256 — which is also what a frame with no slack left to give does.
ms_set_pad:
        call pcm_debt           ; re-estimated per segment: a frame that turns
                                ; out heavier than its predecessor tightens from
                                ; the segment where it finds out
        ld   hl,pad_add_tab
        ld   a,(G_SEG_L)
        or   a
        jr   nz,msp_role
        ld   hl,pad_first_tab
msp_role:
        ld   d,0
        ld   e,(ix+PV_SHIFT)
        add  hl,de
        ld   a,(hl)
        or   a
        ret  z                  ; this copy carries no pad — nothing to hold to
        ld   hl,G_DEBT
        sub  (hl)
        jr   c,msp_min
        or   a
        jr   nz,msp_store
msp_min:
        ld   a,1
msp_store:
        ld   (G_PAD),a
        ret

; Pad each copy would need to hit ${paceTarget(R)} cycles with the frame to itself, by
; shift, mute last. 0 = the copy is already at or over the period, and is
; generated without pad code at all.
pad_first_tab:
        db   ${[...Array(IDLE_SHIFT + 1)].map((_, s) => padFor(variant, "first", s, unroll, R)).join(",")}
pad_add_tab:
        db   ${[...Array(IDLE_SHIFT + 1)].map((_, s) => padFor(variant, "add", s, unroll, R)).join(",")}

; debt_tab[segments] = ${PACE_RESERVE} + segments x ${PACE_SEG} cycles of per-frame overhead, in
; 16-cycle pad units, spread over all PCM_MIX_R samples of the frame.
debt_tab:`);
    const debt = [...Array(PACE_SEG_MAX + 1)].map((_, n) => paceDebt(R, n));
    for (let i = 0; i <= PACE_SEG_MAX; i += 16)
      L.push(`        db   ${debt.slice(i, i + 16).join(",")}`);
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
  const { variant = "i8sat", R = 175, unroll = 2 } = opts;
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
  console.log(`wrote ${dst} (i8sat, R = 175, unroll ${PACE_PASSES}, paced feed`
    + ` — the settled configuration)`);
  console.log(`  tick period ${paceTarget(175)} cyc; pads`);
  for (const role of ["first", "add"]) {
    const pads = [...Array(IDLE_SHIFT + 1)].map((_, s) =>
      `${s === MUTE_SHIFT ? "mute" : s === IDLE_SHIFT ? "idle" : `s${s}`}`
      + `:${padFor("i8sat", role, s, PACE_PASSES, 175)}`);
    console.log(`  ${role.padEnd(5)} ${pads.join(" ")}`);
  }
}
