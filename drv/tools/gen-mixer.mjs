// Generator for the post-split voice-outer PCM mixer (docs/driver.md §5.3).
//
// Same pattern as gen-tables.mjs: the asm is generated, not hand-maintained,
// because the loop has to exist in 8 shift-specialised copies × 2 roles and be
// unrolled. Writing 16 near-identical loops by hand would be unreadable and
// unmaintainable; here each loop body appears ONCE, as a documented template.
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
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VARIANTS = ["i16", "i8", "i8sat", "i16nr", "i8satnr"];

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

  push("ld   a,(de)             ; sample");
  for (let i = 0; i < shift; i++) push("sra  a");

  if (role === "first") {
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

function loop(name, variant, role, shift, U) {
  const deferred = [];
  const out = [`${name}:`];
  const lp = `${name}_lp`;
  out.push(`${lp}:`);
  for (let i = 0; i < U; i++) out.push(...body(variant, role, shift, deferred));
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
function loopSet(prefix, variant, role, U) {
  const out = [];
  for (let s = 0; s < 8; s++) out.push(loop(`${prefix}_s${s}`, variant, role, s, U));
  for (let s = 0; s < 8; s++) out.push(loop(`${prefix}1_s${s}`, variant, role, s, 1));
  out.push(`${prefix}_tab:`);
  out.push(`        dw   ${[...Array(8)].map((_, s) => `${prefix}_s${s}`).join(", ")}`);
  out.push(`${prefix}1_tab:`);
  out.push(`        dw   ${[...Array(8)].map((_, s) => `${prefix}1_s${s}`).join(", ")}`);
  return out.join("\n");
}

export function generateMixerCore({ variant = "i8sat", R = 175, unroll = 2 } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
  uid = 0;
  const wide = variant.startsWith("i16");
  const L = [];
  L.push(`; ===========================================================================
; PCM soft mixer core — voice-outer, ${variant}, R = ${R}, unroll ${unroll}
;
; GENERATED by tools/gen-mixer.mjs — do not edit. Regenerate instead.
; Design and measured cost: docs/driver.md §5.3 / §5.3.1.
;
; Included by src/engine.z80 (and by the bench image). The includer owns the RAM
; map and the PV_* struct offsets; this file defines only PCM_MIX_R and the code.
;
; Each voice owns the register file for its whole pass and writes into a
; frame-long mix buffer; a final pass feeds the DAC. The inner loops carry NO
; loop/end bounds check — the caller splits the pass into segments that cannot
; cross a boundary, which is exactly what a voice-outer pass buys.
; ===========================================================================

PCM_MIX_R   equ ${R}
MIX_UNROLL  equ ${unroll}
`);

  L.push("R_FIRST_BEG:");
  L.push(loopSet("mix_first", variant, "first", unroll));
  L.push("R_FIRST_END:");
  L.push("R_ADD_BEG:");
  L.push(loopSet("mix_add", variant, "add", unroll));
  L.push("R_ADD_END:");

  // ── output pass ──────────────────────────────────────────────────────────
  L.push("R_OUT_BEG:");
  if (wide) {
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
  // silence for this buffer format.
  L.push(`
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
        ld   a,b
        ld   (G_SEG_N),a        ; ticks in this segment
        ld   a,l
        ld   (G_SEG_I),a        ; buffer index to resume at
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
        ld   h,MIXLO>>8
        ; --- unrolled iterations: B / MIX_UNROLL ---
        ld   a,(G_SEG_N)
        ld   b,a
        and  MIX_UNROLL-1
        ld   (G_SEG_R),a        ; remainder ticks
        ld   a,b
        ; B = ticks / MIX_UNROLL (MIX_UNROLL is a power of two)
${unroll === 1 ? "" : `${[...Array(Math.log2(unroll) | 0)].map(() => "        srl  a").join("\n")}\n`}        ld   b,a
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

; Pick the shift-specialised copy out of the right table. Done per segment (a
; handful of times per frame), never per tick.
ms_call_unrolled:
        push hl
        ld   hl,mix_add_tab
        ld   a,(G_SEG_L)
        or   a
        jr   nz,mcu_have
        ld   hl,mix_first_tab
mcu_have:
        jr   ms_enter
ms_call_single:
        push hl
        ld   hl,mix_add1_tab
        ld   a,(G_SEG_L)
        or   a
        jr   nz,mcs_have
        ld   hl,mix_first1_tab
mcs_have:
ms_enter:
        ld   a,(ix+PV_SHIFT)
        add  a,a                ; word table
        push de
        ld   e,a
        ld   d,0
        add  hl,de
        ld   e,(hl)
        inc  hl
        ld   d,(hl)
        ld   (ms_go+1),de
        pop  de
        pop  hl
ms_go:
        jp   0                  ; tail-call the specialised loop (it rets to us)
`);
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
STACK_TOP   equ $1f00

        org 0
        jp   bench

${generateMixerCore({ variant, R, unroll })}

bench:
        di
        ld   sp,STACK_TOP
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

if (process.argv[1] && process.argv[1].endsWith("gen-mixer.mjs")) {
  const dst = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mixer.z80");
  writeFileSync(dst, generateMixerCore());
  console.log(`wrote ${dst} (i8sat, R = 175, unroll 2 — the settled configuration)`);
}
