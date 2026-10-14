// ---------------------------------------------------------------------------
// mucom88 (.muc) -> MMLisp import (best-effort: FM voices + FM/SSG notes)
//
// mucom88 targets the PC-8801 / YM2608 (OPNA): FM A-C,H-J, SSG D-F, rhythm G,
// ADPCM K. MMLisp targets the Mega Drive (YM2612 FM1-6 + SN76489 PSG). FM maps
// near 1:1; SSG -> PSG square is an approximate pitch/level map; ADPCM K becomes
// a PCM track (its `#pcm` bank is decoded to samples — see mucom-pcm.js); rhythm
// G plays the RX5 kit on one PCM track, a :prio layer per sound (rhythmLayers).
//
// This converts MML *text* into MMLisp *source text*. Anything not in the
// supported subset is skipped and reported in `warnings`.
// ---------------------------------------------------------------------------

import { decodeMucomPcmBank } from "./mucom-pcm.js";
import { encodeWav } from "./export-wav.js";
import { VEL_DB_PER_STEP, pitchToMidi } from "./ir-utils.js";
import { compileMMLisp } from "./mmlisp2ir.js";
import { encodeMmb } from "./export-mmb.js";

const PPQN = 96; // must match mmlisp2ir.js
const WHOLE_TICKS = PPQN * 4; // 384 MMLisp ticks per whole note
const DEFAULT_WHOLE_CLOCKS = 128; // mucom C-resolution default (clocks/whole note)

// part letter -> MMLisp channel
const FM_PARTS = { A: "fm1", B: "fm2", C: "fm3", H: "fm4", I: "fm5", J: "fm6" };
const SSG_PARTS = { D: "sqr1", E: "sqr2", F: "sqr3" };
// K is the OPNA's single ADPCM channel; its samples come from the `#pcm` bank.
// Only routed when that bank was supplied — otherwise K is dropped (see below).
const PCM_PARTS = { K: "pcm1" };

// mucom `D` detune is an offset on the same pitch word the software LFO moves
// (F-number at the note's block on FM, the o1 period on SSG — negated there by
// the compiler), so its size in cents depends on the note: D150 is 2.1
// semitones on b but 4 on c. It goes through lfoCents like the LFO does.
// Below this spread across the pitch classes one `:pitch` serves every note;
// above it the part re-states `:pitch` per pitch class.
const DETUNE_SPREAD_CENTS = 10;
// The software LFO (`M`) is modelled from the driver itself (music.asm
// PLLFO), not with a cents-per-unit factor: it adds a vector to the channel's
// raw pitch word every few clocks, so its depth in cents depends on the note
// and is far from linear once it is large — Koshiro uses `M1,1,-9,250` as a
// long pitch dive, which a cents triangle turns into a ±46-semitone wobble.
// The pitch words of one octave, per pitch class c..b (FM F-number at the
// note's block; SSG tone period at o1, before the driver's octave shift).
const FM_FNUM = [0x26a, 0x28f, 0x2b6, 0x2df, 0x30b, 0x339, 0x36a, 0x39e, 0x3d5, 0x410, 0x44e, 0x48f];
const SSG_PERIOD = [0xee8, 0xe12, 0xd48, 0xc89, 0xbd5, 0xb2b, 0xa8a, 0x9f3, 0x964, 0x8dd, 0x85e, 0x7e6];
// An LFO whose wave repeats within this many clocks, or keeps the pitch word in
// range, is a vibrato: a looping triangle. Otherwise it is a sweep (a dive, a
// rise), drawn as its exact curve as far as the notes it plays on last.
const LFO_VIBRATO_MAX_PERIOD = 96;
// A vibrato's depth differs per pitch class (the word moves the same, the
// pitch does not); past this spread each pitch class gets its own triangle.
const LFO_DEPTH_SPREAD_CENTS = 12;
const LFO_SWEEP_MAX_CLOCKS = 1536; // how far a sweep curve is drawn at most
const LFO_SWEEP_TOLERANCE = 4; // cents, piecewise-linear fit of the curve
// The compiler's SSG presets, `@0`-`@15` on D-F (ssgdat.asm): the soft
// envelope (E), the mix (as P: 1 tone, 2 noise) and an optional software LFO
// as MML M delay,clock,vector,peak. The table stores the raw driver vector,
// which the M command would have negated for SSG, so it is negated here.
const SSG_PRESETS = [
  { env: [255, 255, 255, 255, 0, 255], mix: 1 }, // normal
  { env: [255, 255, 255, 200, 0, 10], mix: 1 },
  { env: [255, 255, 255, 200, 1, 10], mix: 1 },
  { env: [255, 255, 255, 190, 0, 10], mix: 1, lfo: [16, 1, -25, 4] },
  { env: [255, 255, 255, 190, 1, 10], mix: 1, lfo: [16, 1, -25, 4] },
  { env: [255, 255, 255, 170, 0, 10], mix: 1 },
  { env: [40, 70, 14, 190, 0, 15], mix: 1, lfo: [16, 1, -24, 5] }, // Sega type
  { env: [120, 30, 255, 255, 0, 10], mix: 1, lfo: [16, 1, -25, 4] }, // strings
  { env: [255, 255, 255, 225, 8, 15], mix: 1 }, // piano / harp
  { env: [255, 255, 255, 1, 255, 255], mix: 2 }, // closed hi-hat
  { env: [255, 255, 255, 200, 8, 255], mix: 2 }, // open hi-hat
  { env: [255, 255, 255, 220, 20, 8], mix: 1, lfo: [1, 1, -300, 255] }, // synth tom
  { env: [255, 255, 255, 255, 0, 10], mix: 1, lfo: [1, 1, 400, 4] }, // UFO
  { env: [255, 255, 255, 255, 0, 10], mix: 1, lfo: [1, 1, -80, 255] }, // falling
  { env: [120, 80, 255, 255, 0, 255], mix: 1, lfo: [1, 1, 250, 1] }, // whistle
  { env: [255, 255, 255, 220, 0, 255], mix: 1, lfo: [1, 1, -3000, 255] }, // bomb
];

// G is the OPNA's built-in rhythm generator: six sounds in the chip's ROM, each
// with its own voice. They become the RX5 kit's samples on one PCM track, so
// where two overlap one is chosen by priority (rhythmLayers). Its channel is pcm1, or pcm2 when
// part K plays.
const RHYTHM_PART = "G";
// The six, in the order of the key-on bits (`@` is a mask) and of `v`'s
// levels: the sample, its priority (lower wins, as :prio) and how long it
// rings — the time the RX5 sample stays within 6 dB of its peak, during which
// a lower-priority hit is dropped rather than cutting it.
// `ms` is the sample's whole length, for the bank-fit bake.
const RHYTHM_SOUNDS = [
  { name: "kick", prio: 4, ringMs: 40, ms: 160 }, // BD
  { name: "snare", prio: 1, ringMs: 60, ms: 220 }, // SD
  { name: "ride", prio: 3, ringMs: 350, ms: 600 }, // TOP (the OPNA's top cymbal is a ride)
  { name: "hat", prio: 6, ringMs: 40, ms: 120 }, // HH
  { name: "tom4", prio: 2, ringMs: 65, ms: 400 }, // TOM
  { name: "rim", prio: 5, ringMs: 15, ms: 80 }, // RIM
];
const RHYTHM_KIT = "presets/rx5/set.mmlisp";
const RHYTHM_KIT_RATE = 22050;
const RHYTHM_DB_PER_STEP = 0.75; // the total level (0-63) and each sound's (0-31)

// Where mucom's native ADPCM octave lands: o1 plays the sample at its own rate,
// and so does MMLisp's C4 (`:oct 4`) at the def's `:rate`. K octaves mirror
// around it (see octSet). It is also the default for a K part that never states
// an octave — mucom's own o6 would play a drum at 1/32 of its rate.
const MUCOM_PCM_DEFAULT_OCT = 4;
// mucom velocity is 0-255 on K but 0-15 on FM/SSG. On K it IS the ADPCM-B level
// register — the driver writes `TOTALV*4 + v` to 0x0B, TOTALV being 0 outside a
// fade and PVMODE 0 by default (music.asm PCMVOL/PL1/PL2) — so `v` is a linear
// absolute level. That absolute value is worthless to us: it means something
// only inside the OPNA's mix, where the ADPCM output is loud beside its own FM,
// and the YM2612's DAC has no such relationship. Songs also use only the bottom
// half of the register (corpus max 130, median 40), so any fixed divisor throws
// away headroom the MD could have used and leaves the drums under the FM bed.
//
// What DOES carry over is the song's own dynamics. So normalize per song: the
// loudest drum becomes :vel 15 (full DAC) and every other note keeps its dB
// distance from it, on the same 2 dB ladder FM rides. No magic constant, and
// nothing is left on the table.
const MUCOM_PCM_VEL_MAX = 255; // register range, for clamping relative v+/v-
// mucom K parts set `v` explicitly, so this only backs a bare v+/v- with none.
const MUCOM_PCM_VEL_DEFAULT = 64;

// mucom octave -> MMLisp :oct for FM and SSG. FM reads one higher than MMLisp;
// SSG/PSG uses a different frequency table and needs no shift. K parts do not
// shift: they mirror around MUCOM_PCM_DEFAULT_OCT (octSet).
const octShiftFor = (letter) => (letter in SSG_PARTS ? 0 : -1);
const MUCOM_DEFAULT_OCT = 6; // mucom's default octave when a part sets none

/** Decode .muc bytes (usually Shift-JIS) to a string, UTF-8 fallback. */
export function decodeMucText(bytes) {
  for (const enc of ["shift-jis", "utf-8"]) {
    try {
      return new TextDecoder(enc, { fatal: false }).decode(bytes);
    } catch {
      /* try next */
    }
  }
  // Last resort: latin1-ish
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// --- length helpers ---------------------------------------------------------

// Convert a mucom length spec to an MMLisp length token.
// Convert a mucom note length to an MMLisp length token. Durations are computed
// on mucom's CLOCK grid (wholeClocks/whole, default 128) exactly as the driver
// does — base = floor(wholeClocks/len), each dot adds floor(prev/2) — then scaled
// to MMLisp ticks. This matters because lengths whose denominator doesn't divide
// wholeClocks (l48, l96, l24, …) are truncated by mucom; emitting the ideal
// fraction instead would drift tracks apart (e.g. l48 ≈ 2.67 clocks → mucom 2).
// A clean fraction is emitted when the grid value equals MMLisp's own fraction;
// otherwise raw `Nt` ticks reproduce mucom's truncation faithfully.
//
// `num` is the fraction (4, 8, …) or null; `dots` the dot count; `pct` the raw
// %clock count or null; `wholeClocks` the active C resolution.
function lengthToken(num, dots, pct, wholeClocks) {
  const factor = WHOLE_TICKS / wholeClocks; // mucom clocks -> MMLisp ticks (128 -> 3)
  if (pct != null) {
    // % is a raw clock count.
    return `${Math.max(1, Math.round(pct * factor))}t`;
  }
  if (num != null) {
    let clocks = Math.floor(wholeClocks / num);
    let add = clocks;
    for (let d = 0; d < dots; d++) { add = Math.floor(add / 2); clocks += add; }
    const ticks = Math.max(1, Math.round(clocks * factor));
    // Prefer the readable fraction when it lands on the exact same tick count
    // MMLisp would compute for it (the common case: len divides wholeClocks).
    if (dots <= 1) {
      const frac = dots ? (WHOLE_TICKS / num) * 1.5 : WHOLE_TICKS / num;
      if (Number.isInteger(frac) && frac === ticks) return dots ? `${num}.` : `${num}`;
    }
    return `${ticks}t`;
  }
  return null;
}

// Raw mucom clocks for a length spec (no MMLisp conversion). Mirrors
// lengthToken's dot arithmetic; used to resolve dots against the running
// default length.
function lengthClocks(num, dots, pct, wholeClocks) {
  if (pct != null) return pct;
  if (num == null) return null;
  let clocks = Math.floor(wholeClocks / num);
  let add = clocks;
  for (let d = 0; d < dots; d++) { add = Math.floor(add / 2); clocks += add; }
  return clocks;
}

// A note's length in clocks, as resolveLen reads it (the default when bare,
// a dots-only suffix dotting the default).
function noteClocks(num, dots, pct, hasLen, state) {
  if (hasLen && (num != null || pct != null)) return lengthClocks(num, dots, pct, state.wholeClocks);
  const def = state.defaultLen ?? { num: 4, dots: 0, pct: null };
  let clocks = lengthClocks(def.num, def.dots, def.pct, state.wholeClocks);
  let add = clocks;
  for (let d = 0; hasLen && d < dots; d++) { add = Math.floor(add / 2); clocks += add; }
  return clocks;
}

// Resolve a note/rest length token. A dots-only suffix (`f.`, `e-.` — dots but
// no number) applies the dots to the running DEFAULT length: mucom multiplies
// the note's current length by 1.5 per dot. lengthToken alone returns null when
// num is absent, which silently dropped the dot (part ran short over the loop).
function resolveLen(num, dots, pct, hasLen, state) {
  if (!hasLen) return defaultLenToken(state);
  if (num == null && pct == null && dots > 0) {
    const def = state.defaultLen;
    if (!def) return null; // no l/% seen yet — emit bare (best effort, rare)
    // Plain fractional default: keep the readable `num.` form (e.g. l16 f. -> 16.).
    if (def.num != null && !def.dots) {
      const token = lengthToken(def.num, dots, null, state.wholeClocks);
      return ditherClocks(lengthClocks(def.num, dots, null, state.wholeClocks), token, state);
    }
    // Dotted or clock-set default: dot from its resolved clocks.
    let clocks = lengthClocks(def.num, def.dots, def.pct, state.wholeClocks);
    if (clocks == null) return null;
    let add = clocks;
    for (let d = 0; d < dots; d++) { add = Math.floor(add / 2); clocks += add; }
    return ditherClocks(clocks, lengthToken(null, 0, clocks, state.wholeClocks), state);
  }
  return ditherClocks(lengthClocks(num, dots, pct, state.wholeClocks), lengthToken(num, dots, pct, state.wholeClocks), state);
}

// A clock count that is not a whole number of ticks (C112: a clock is 3.43
// ticks) rounds on every note, and MMLisp keeps no remainder either, so a
// part full of %1 or 32nds drifts from the others. Such a length is written
// as Nt with the rounding carried note to note (state.tickErr), which keeps
// the part's total exact — up to a tick per pass of a loop, which replays
// its body's lengths.
function ditherClocks(clocks, token, state) {
  if (clocks == null) return token;
  const exact = clocks * (WHOLE_TICKS / state.wholeClocks);
  if (Number.isInteger(exact)) return token;
  state.tickErr = state.tickErr ?? 0;
  const ticks = Math.max(1, Math.round(exact + state.tickErr));
  state.tickErr += exact - ticks;
  return `${ticks}t`;
}

// A bare note plays the default length; when that is not a whole number of
// ticks it is written out, dithered like any other (see ditherClocks).
function defaultLenToken(state) {
  const def = state.defaultLen;
  if (!def) return null;
  const clocks = lengthClocks(def.num, def.dots, def.pct, state.wholeClocks);
  if (clocks == null || Number.isInteger(clocks * (WHOLE_TICKS / state.wholeClocks))) return null;
  return ditherClocks(clocks, null, state);
}

// mucom `t` sets the OPNA Timer-B directly. The realtime tempo also depends on
// the clock resolution C (note clocks per whole note), since note durations are
// counted in those clocks. One Timer-B unit is 1152 master cycles (7.9872 MHz,
// prescaler 1/6 x 12 x 16) and the driver counts one clock every second
// overflow, so a clock lasts (256 - t) * 2304 / 7987200 s and
// BPM = 832000 / ((256 - t) * C) — t202 at C128 is 120.37 BPM, not a round 120
// (muc88.asm SETTMP's 3.46 is the same constant, rounded). Kept to two
// decimals: a rounded BPM drifts the song against the original by seconds.
function timerBToBpm(t, wholeClocks) {
  t = Math.max(0, Math.min(255, t));
  const denom = (256 - t) * (wholeClocks || DEFAULT_WHOLE_CLOCKS);
  if (denom <= 0) return 120;
  return Math.max(1, Math.round((832000 / denom) * 100) / 100);
}

// --- MML body tokenizer -----------------------------------------------------

const NOTE_LETTERS = new Set(["a", "b", "c", "d", "e", "f", "g"]);

// Parse one part's MML body string into a nested op tree. Mutates `state`
// (octave/length/vel/wholeClocks) which carries across the part. Returns the
// top-level op list; loops are nested as { t:'loop', count, body }.
function tokenizeBody(body, state, warn, partLetter, macros, depth = 0) {
  const root = [];
  const stack = [root]; // loop nesting; top is current op list
  // A lowercase `t` (Timer-B) tempo's BPM depends on the clock resolution C in
  // effect for the notes it governs, but `C` often follows `t` — on the same
  // line (`t202C192`) or a later one (`t225` alone, then `C192 …`). So defer its
  // conversion until the next note/rest, when state.wholeClocks reflects that C.
  // Kept on `state` so it persists across the part's lines (one call per line).
  state.pendingTempos = state.pendingTempos || [];
  const finalizeTempos = () => {
    if (!state.pendingTempos.length) return;
    for (const tp of state.pendingTempos) tp.bpm = timerBToBpm(tp.timerB, state.wholeClocks);
    state.pendingTempos.length = 0;
  };
  const push = (op) => {
    if (op.t === "note" || op.t === "rest") finalizeTempos();
    // How long the notes under a software LFO last (a tie or `&` runs it on):
    // a sweep is drawn only that far (lfoSpec).
    if (op.t === "lfoSet") { op.maxClocks = 0; state.lfoOp = op; state.lfoRun = 0; }
    else if (op.clocks != null && op.t !== "rest") {
      state.lfoRun = op.t === "tie" || state.lfoSlur ? state.lfoRun + op.clocks : op.clocks;
      if (state.lfoOp) state.lfoOp.maxClocks = Math.max(state.lfoOp.maxClocks, state.lfoRun);
    }
    if (op.t === "slur") state.lfoSlur = true;
    else if (op.t === "note" || op.t === "rest" || op.t === "porta") state.lfoSlur = false;
    stack[stack.length - 1].push(op);
  };
  const isSsg = partLetter in SSG_PARTS;
  const partLetterIsPcm = partLetter in PCM_PARTS;
  // Loop-span state (absent for macro bodies, which are single-line -> all (x)).
  state.decisions = state.decisions || [];
  if (state.decisionIdx == null) state.decisionIdx = 0;
  state.crossStack = state.crossStack || [];
  state.lfo = state.lfo || { on: false, delay: 0, clock: 0, amp: 0, amt: 0 };
  state.echo = state.echo || {}; // shared across parts via partState; local for macros
  let comment = null; // verbatim `; …` trailing comment, kept for the output line

  let i = 0;
  const n = body.length;
  const readInt = () => {
    let s = "";
    while (i < n && body[i] >= "0" && body[i] <= "9") s += body[i++];
    return s === "" ? null : parseInt(s, 10);
  };
  // A signed integer (for command args that may be negative), then a
  // comma-separated list of them (e.g. `M0,4,2,10`, `H3,4,2`).
  const readSignedInt = () => {
    let sign = 1;
    if (body[i] === "+") i++;
    else if (body[i] === "-") { sign = -1; i++; }
    const v = readInt();
    return v == null ? null : sign * v;
  };
  // A number in any form the driver's REDATA reads: decimal, $hex, negative.
  const readNum = () => {
    if (body[i] === "$") {
      i++;
      let h = "";
      while (i < n && /[0-9a-fA-F]/.test(body[i])) h += body[i++];
      return h ? parseInt(h, 16) : null;
    }
    return readSignedInt();
  };
  const readNumList = () => {
    const vals = [];
    for (;;) {
      const v = readSignedInt();
      if (v == null) break;
      vals.push(v);
      if (body[i] === ",") { i++; continue; }
      break;
    }
    return vals;
  };
  const skipSpaces = () => {
    while (i < n && /\s/.test(body[i])) i++;
  };

  while (i < n) {
    const c = body[i];

    if (/\s/.test(c)) { i++; continue; }
    if (c === "|") { i++; push({ t: "bar" }); continue; } // bar line → MMLisp |
    if (c === ";") { comment = body.slice(i).trim(); break; } // keep the comment

    // Note (lowercase a-g only; uppercase letters are commands like C/D/E). A
    // bare note inherits the :len default, so we emit it bare; only notes that
    // specify a length carry one.
    if (NOTE_LETTERS.has(c)) {
      i++;
      let acc = 0, num = null, dots = 0, pct = null, hasLen = false;
      while (i < n) {
        const d = body[i];
        if (d === "+" || d === "#") { acc += 1; i++; }
        else if (d === "-") { acc -= 1; i++; }
        else if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      const len = resolveLen(num, dots, pct, hasLen, state);
      push({ t: "note", letter: c, acc, len, clocks: noteClocks(num, dots, pct, hasLen, state) });
      continue;
    }

    // Rest (lowercase 'r' only; uppercase 'R' is reverb — see deferred list)
    if (c === "r") {
      i++;
      let num = null, dots = 0, pct = null, hasLen = false;
      while (i < n) {
        const d = body[i];
        if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      push({ t: "rest", len: resolveLen(num, dots, pct, hasLen, state), clocks: noteClocks(num, dots, pct, hasLen, state) });
      continue;
    }

    // Octave: keep the author's relative up/down as MMLisp < / > ; o sets it.
    if (c === "o") { i++; const v = readInt(); if (v != null) push({ t: "octSet", n: Math.max(1, Math.min(8, v)) }); continue; }
    if (c === "<") { i++; push({ t: "octDown" }); continue; }
    if (c === ">") { i++; push({ t: "octUp" }); continue; }

    // Default length l<n>[.] or l%<clocks> -> MMLisp :len
    if (c === "l") {
      i++;
      let token = null;
      if (body[i] === "%") { i++; const p = readInt() ?? 0; token = lengthToken(null, 0, p, state.wholeClocks); state.defaultLen = { num: null, dots: 0, pct: p }; }
      else {
        const num = readInt(); let dots = 0;
        while (body[i] === ".") { dots++; i++; }
        if (num != null) { token = lengthToken(num, dots, null, state.wholeClocks); state.defaultLen = { num, dots, pct: null }; }
      }
      if (token) push({ t: "lenSet", token });
      continue;
    }

    // `%<clocks>` (SET LIZM): set the default note length directly in clocks,
    // same as l%<clocks>. (As a note/rest suffix `%` is handled in their parsers;
    // this is the standalone command form, e.g. `%1c` = set len 1 clock, then c.)
    if (c === "%") {
      i++;
      const p = readInt();
      if (p != null) { push({ t: "lenSet", token: lengthToken(null, 0, p, state.wholeClocks) }); state.defaultLen = { num: null, dots: 0, pct: p }; }
      continue;
    }

    // Whole-note clock resolution
    if (c === "C") { i++; const v = readInt(); if (v != null && v > 0) state.wholeClocks = v; continue; }

    // Tempo: T<bpm> and t<timer>, both resolved to BPM once C is known
    // `T<bpm>` is compiled into a Timer-B value (muc88.asm SETTMP: clock
    // length 60000/(T*floor(C/4)) ms, rounded up, TB = 256 - 3.46*that), so it
    // plays at that value's tempo, not at T itself.
    if (c === "T") {
      i++;
      const v = readInt();
      if (v != null && v > 0) {
        const ms = Math.floor(60000 / (v * Math.floor(state.wholeClocks / 4))) + 1;
        const timerB = 346 * ms >= 25600 ? 1 : Math.floor((25600 - 346 * ms) / 100);
        const op = { t: "tempo", timerB, bpm: null };
        push(op);
        state.pendingTempos.push(op);
      }
      continue;
    }
    if (c === "t") { i++; const v = readInt(); if (v != null) { const op = { t: "tempo", timerB: v, bpm: null }; push(op); state.pendingTempos.push(op); } continue; }

    // Volume: v<0-15>, ) raise, ( lower
    // `v` is written plus the part's V offset (muc88.asm SETVOL; TOTALV). On K,
    // `vm<n>` picks the ADPCM volume mode instead — nothing to carry over.
    if (c === "v") {
      i++;
      if (body[i] === "m") { i++; readInt(); continue; }
      if (partLetter === RHYTHM_PART) {
        // v total,BD,SD,TOP,HH,TOM,RIM — a level left out keeps its value.
        const levels = [readInt()];
        while (body[i] === ",") { i++; levels.push(readInt()); }
        push({ t: "rhythmLevels", levels });
        continue;
      }
      const v = readInt();
      if (v != null) push({ t: "vel", v: partLetterIsPcm ? v : v + (state.tvOfs ?? 0) });
      continue;
    }
    if (c === "V") { i++; const v = readSignedInt(); if (v != null) state.tvOfs = v; continue; }
    if (c === ")") { i++; const v = readInt() ?? 1; push({ t: "velAdj", d: v }); continue; }
    if (c === "(") { i++; const v = readInt() ?? 1; push({ t: "velAdj", d: -v }); continue; }

    // Pan: p0=off, p1=right, p2=left, p3=center
    if (c === "p") {
      i++;
      // On G, `p$xy` pans sound x: a mono PCM track has nothing to carry it to.
      if (partLetter === RHYTHM_PART) { if (body[i] === "$") i++; while (i < n && /[0-9a-fA-F]/.test(body[i])) i++; continue; }
      const v = readInt();
      if (v != null) push({ t: "pan", v });
      continue;
    }

    // Quantize/gate: q<n> keys off n clocks early (staccato) -> :gate- (note
    // length minus that time). Sticky like mucom's q.
    if (c === "q") { i++; const n = readInt() ?? 0; push({ t: "gateCut", n, wholeClocks: state.wholeClocks }); continue; }

    // E AL,AR,DR,SL,SR,RR: SSG soft envelope (ADSR on a 0-255 level, per-clock
    // rates) -> a sticky :macro :vel volume envelope.
    if (c === "E") {
      i++;
      const [al = 0, ar = 0, dr = 0, sl = 0, sr = 0, rr = 0] = readNumList();
      push({ t: "ssgEnv", al, ar, dr, sl, sr, rr, wholeClocks: state.wholeClocks });
      continue;
    }

    // Detune: D<n> sets it, D<n>+ adds n to it (muc88.asm SETDT reads the
    // number, then a trailing `+` marks it relative). Relative detune is a
    // driver command, so inside a loop it accumulates on every pass.
    if (c === "D") {
      i++;
      if (body[i] === "+") i++; // `D+n` is not mucom syntax; read it as D n
      const val = readSignedInt() ?? 0;
      let rel = false;
      if (body[i] === "+") { rel = true; i++; }
      push({ t: "detune", val, rel });
      continue;
    }

    // Key shift: K<n> and k<n> each transpose the part by n semitones and the
    // two add up (msub.asm KEYSIFT: SIFTDAT + SIFTDA2). The compiler applies it
    // to every note it compiles, so it is compile-time state like the octave.
    if (c === "K" || c === "k") {
      i++;
      const v = readSignedInt();
      if (v != null) push({ t: "keyShift", which: c, n: v });
      continue;
    }

    // Macro call *n: keep it as a reference (defined as (def *n …)), not expanded.
    if (c === "*") {
      i++;
      const mn = readInt();
      if (mn != null) push({ t: "macroCall", n: mn });
      continue;
    }

    // Voice select @<n> or by name @"name" (FM only)
    if (c === "@") {
      i++;
      if (body[i] === "%") { i++; readInt(); warnOnce(warn, "@%", "register-dump voice (@%) not supported; dropped"); continue; }
      if (body[i] === '"') {
        i++; let name = "";
        while (i < n && body[i] !== '"') name += body[i++];
        if (body[i] === '"') i++;
        if (!isSsg) push({ t: "voiceByName", name });
        continue;
      }
      const v = readInt();
      if (v != null) {
        if (isSsg) {
          // An SSG preset is three commands in one (muc88.asm STCL5): the
          // envelope, the tone/noise mix, and for some a software LFO.
          const pre = SSG_PRESETS[v & 15];
          push({ t: "ssgEnv", al: pre.env[0], ar: pre.env[1], dr: pre.env[2], sl: pre.env[3], sr: pre.env[4], rr: pre.env[5], wholeClocks: state.wholeClocks });
          push({ t: "mix", v: pre.mix });
          if (pre.lfo) {
            const [delay, clock, amp, amt] = pre.lfo;
            Object.assign(state.lfo, { delay, clock, amp, amt, on: true });
            push({ t: "lfoSet", lfo: { ...state.lfo }, wholeClocks: state.wholeClocks });
          }
        } else push({ t: "voice", n: v });
      }
      continue;
    }

    // SSG mix P0-3 (off / tone / noise / both) and noise period w0-31.
    if (c === "P" && isSsg) { i++; const v = readInt(); if (v != null) push({ t: "mix", v }); continue; }
    if (c === "w" && isSsg) { i++; const v = readInt(); if (v != null) push({ t: "noiseFreq", n: v }); continue; }

    // Loops
    // Loop open. A single-line loop becomes a nested (x …) op; a loop that
    // spans source lines becomes #labelK …(go labelK n) (decided by scanLoopSpans).
    if (c === "[") {
      i++;
      const dec = state.decisions[state.decisionIdx++] || { cross: false };
      if (dec.cross) {
        push({ t: "loopMarker", label: dec.label });
        state.crossStack.push(dec.label);
      } else {
        const body2 = [];
        push({ t: "loop", count: 2, body: body2 });
        stack.push(body2);
      }
      continue;
    }
    if (c === "]") {
      // mucom tolerates whitespace before the repeat count (`] 2` == `]2`);
      // skip it so the count is read, not left as a stray unknown token.
      i++; skipSpaces(); const cnt = readInt();
      if (stack.length > 1) {
        // Close the innermost single-line loop (local nesting).
        stack.pop();
        const parent = stack[stack.length - 1];
        const loop = parent[parent.length - 1];
        if (loop && loop.t === "loop") loop.count = cnt ?? 2;
      } else if (state.crossStack.length > 0) {
        // Close the innermost cross-line loop -> (go labelK n).
        push({ t: "loopGo", label: state.crossStack.pop(), count: cnt ?? 2 });
      } else warnOnce(warn, "]", "unmatched ] loop end; ignored");
      continue;
    }
    if (c === "/") { i++; push({ t: "loopBreak" }); continue; }
    if (c === "L") { i++; push({ t: "globalLoop" }); continue; }

    // Tie: ^, ^<len>, or ^<note><len> (a repeated pitch is a tie continuation —
    // keep only its length). Slur '&' has no tie semantics; drop it.
    if (c === "^") {
      i++;
      let num = null, dots = 0, pct = null, hasLen = false;
      // mucom `^` takes only an optional length; the next letter is the next
      // note, not a redundant pitch — do not consume it.
      while (i < n) {
        const d = body[i];
        if (d === "+" || d === "#" || d === "-") i++;
        else if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      push({ t: "tie", len: resolveLen(num, dots, pct, hasLen, state), clocks: noteClocks(num, dots, pct, hasLen, state) }); // `^.` dots the default length
      continue;
    }
    // Slur/tie `&`: connects the previous note to the next without a re-key.
    // MMLisp's `X ~ Y` connector has the same semantics — same pitch ties
    // (extends), different pitch slurs (legato). Emit `~` between the two notes.
    if (c === "&") { i++; push({ t: "slur" }); continue; }

    // Portamento {from len to}: a pitch glide occupying one note's time. mucom
    // {c2b} slides c->b over length 2 (octaves may be crossed with < / >). Map to
    // MMLisp's portamento: (glide <start> <len>), the target note, (glide none).
    if (c === "{") {
      i++;
      let bo = 0; // octave shift inside the braces (relative to the running octave)
      const notes = []; // {letter, acc, bo} in order
      let inNum = null, inDots = 0, inPct = null;
      while (i < n && body[i] !== "}") {
        const d = body[i];
        if (NOTE_LETTERS.has(d)) {
          i++;
          let acc = 0;
          while (i < n && (body[i] === "+" || body[i] === "#" || body[i] === "-")) {
            acc += body[i] === "-" ? -1 : 1; i++;
          }
          notes.push({ letter: d.toLowerCase(), acc, bo });
        }
        else if (d === ">") { bo += 1; i++; }
        else if (d === "<") { bo -= 1; i++; }
        else if (d === "%") { i++; inPct = readInt() ?? 0; }
        else if (d >= "0" && d <= "9") { inNum = readInt(); }
        else if (d === ".") { inDots++; i++; }
        else i++;
      }
      if (body[i] === "}") i++;
      // A length after } overrides one inside the braces.
      let num = null, dots = 0, pct = null, hasLen = false;
      while (i < n) {
        const d = body[i];
        if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      const len = hasLen
        ? resolveLen(num, dots, pct, true, state)
        : resolveLen(inNum, inDots, inPct, inNum != null || inDots > 0 || inPct != null, state);
      const clocks = hasLen
        ? noteClocks(num, dots, pct, true, state)
        : noteClocks(inNum, inDots, inPct, inNum != null || inDots > 0 || inPct != null, state);
      if (notes.length >= 2) push({ t: "porta", from: notes[0], to: notes[notes.length - 1], len, clocks });
      else if (notes.length === 1) push({ t: "note", letter: notes[0].letter, acc: notes[0].acc, len, clocks });
      continue;
    }

    // Echo macro (¥/\, byte 0x5C). `\=n1,n2`: n1 = how many notes back to echo,
    // n2 = volume reduction. A trailing `\` is one echo tap of the single note
    // n1 positions back at vel-n2 -> (echo 1 :vel+ -n2 :back n1). The compiler
    // replays that note (absolute pitch, so octaves come out right) and lengthens.
    if (c === "¥" || c === "\\") {
      i++;
      if (body[i] === "=") {
        i++;
        const a = readInt() ?? 0;
        let b = 0;
        if (body[i] === ",") { i++; b = readInt() ?? 0; }
        state.echo.back = Math.max(0, Math.min(9, a));
        state.echo.drop = Math.max(0, b);
        continue;
      }
      const back = state.echo.back ?? 1;
      if (back > 0) push({ t: "echo", back, drop: state.echo.drop ?? 0 });
      continue;
    }

    // Hardware LFO: H speed,pms,ams -> the YM LFO (:lfo-rate global) plus the
    // per-channel sensitivities (:fms / :ams). FM only (rendered side skips SSG).
    if (c === "H") {
      i++;
      const [speed = 0, pms = 0, ams = 0] = readNumList();
      push({ t: "hwLfo", speed, pms, ams });
      continue;
    }

    // Software LFO (pitch vibrato): M delay,clock,amp,amount defines+enables it;
    // MF on/off; MW/MC/ML/MD set one param. State persists across the part's lines
    // and is emitted as a sticky `:macro :pitch (triangle …)` (cleared by MF 0).
    if (c === "M") {
      i++;
      const sub = (i < n && /[A-Za-z]/.test(body[i])) ? body[i++] : null;
      const nums = readNumList();
      const lfo = state.lfo;
      if (sub === "F") lfo.on = (nums[0] ?? 0) !== 0;
      else if (sub === "W") lfo.delay = nums[0] ?? lfo.delay;
      else if (sub === "C") lfo.clock = nums[0] ?? lfo.clock;
      else if (sub === "L") lfo.amp = nums[0] ?? lfo.amp;
      else if (sub === "D") lfo.amt = nums[0] ?? lfo.amt;
      else {
        lfo.delay = nums[0] ?? 0; lfo.clock = nums[1] ?? 0;
        lfo.amp = nums[2] ?? 0; lfo.amt = nums[3] ?? 0; lfo.on = true;
      }
      push({ t: "lfoSet", lfo: { ...lfo }, wholeClocks: state.wholeClocks });
      continue;
    }

    // Reverb: R<n> sets the amount and turns it on, RF<0|1> switches it,
    // Rm<n> picks a mode (muc88.asm SETRV).
    if (c === "R") {
      i++;
      const sub = body[i] === "F" || body[i] === "m" ? body[i++] : null;
      const v = readInt() ?? 0;
      if (sub === "F") push({ t: "reverb", on: v !== 0 });
      else if (sub == null) push({ t: "reverb", on: true, amt: v });
      continue;
    }
    // Register write: yNN,op,value with NN one of DM TL KA DR SR SL SE (the
    // operator's register in the channel), or y<reg>,<value> raw.
    if (c === "y") {
      i++;
      let name = "";
      while (i < n && /[A-Za-z]/.test(body[i])) name += body[i++];
      if (body[i] === ",") i++;
      const nums = [];
      for (;;) {
        const v = readNum();
        if (v == null) break;
        nums.push(v);
        if (body[i] === ",") { i++; continue; }
        break;
      }
      if (name && nums.length >= 2) push({ t: "opReg", name: name.toUpperCase(), op: nums[0], val: nums[1] });
      else if (!name && nums.length >= 2) push({ t: "rawReg", reg: nums[0], val: nums[1] });
      continue;
    }

    // Unsupported commands (S slot detune, s key-on revise; P/w outside SSG).
    // Consume the FULL argument list so nothing leaks into note/length parsing
    // (a leaked arg becomes a spurious note and drifts the channel).
    if ("SPws".includes(c)) {
      i++;
      warnOnce(warn, c, `command '${c}' not supported; dropped`);
      while (i < n && /[0-9$+\-,.]/.test(body[i])) i++;
      continue;
    }

    // Unknown char
    warnOnce(warn, c, `unknown token '${c}'; skipped`);
    i++;
  }

  if (stack.length > 1) warn.push(`part ${partLetter}: unterminated loop '[' — closed at end`);
  // Pending tempos are NOT finalized here: they persist on `state` so a `t` on
  // one line can pick up a `C` (and its first note) on a later line of the part.
  // Any still-pending at the very end are flushed by parseMucom.
  return { ops: root, comment };
}

function warnOnce(warn, key, msg) {
  warn._seen = warn._seen || new Set();
  if (warn._seen.has(key)) return;
  warn._seen.add(key);
  warn.push(msg);
}

// --- voice parsing ----------------------------------------------------------

// Parse all numbers from a voice block, ignoring a quoted "name" and the
// braces/commas. Supports $hex.
function parseVoiceNumbers(text) {
  const out = [];
  for (const tok of text.replace(/"[^"]*"/g, " ").split(/[\s,{}]+/)) {
    if (!tok) continue;
    const v = tok[0] === "$" ? parseInt(tok.slice(1), 16) : parseInt(tok, 10);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// --- top-level parse --------------------------------------------------------

/**
 * Parse mucom88 MML text into a structured, MMLisp-friendly intermediate.
 * @returns {{ meta:{title,author}, tempo:number|null,
 *             voices: Map<number, {fb,alg,ops:Array}>,
 *             parts: Map<string, Array>, warnings: string[] }}
 */
// Decide, per part letter, whether each `[ … ]` loop closes on the same source
// line it opened (single-line -> (x …)) or spans lines (cross-line -> #label /
// (go label n)). Returns Map<letter, Array<{cross, label}>> in `[` order.
function scanLoopSpans(lines) {
  const decisions = new Map(); // letter -> [{cross, label}]
  const stacks = new Map(); // letter -> [{ line, idx }]
  let crossLabel = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\t/g, " ");
    const pm = line.match(/^([A-K]+)(.*)$/);
    if (!pm) continue;
    let body = pm[2];
    const sc = body.indexOf(";");
    if (sc >= 0) body = body.slice(0, sc); // ignore brackets inside comments
    for (const letter of pm[1]) {
      if (!(letter in FM_PARTS) && !(letter in SSG_PARTS) && !(letter in PCM_PARTS) && letter !== RHYTHM_PART) continue;
      let dec = decisions.get(letter);
      if (!dec) { dec = []; decisions.set(letter, dec); }
      let st = stacks.get(letter);
      if (!st) { st = []; stacks.set(letter, st); }
      for (const ch of body) {
        if (ch === "[") { st.push({ line: li, idx: dec.length }); dec.push({ cross: false, label: null }); }
        else if (ch === "]") {
          const open = st.pop();
          if (open && open.line !== li) { dec[open.idx].cross = true; dec[open.idx].label = `loop${++crossLabel}`; }
        }
      }
    }
  }
  return decisions;
}

export function parseMucom(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const meta = { title: null, composer: null, author: null, voiceFile: null, pcmFile: null };
  const voices = new Map();
  // The music in source order: one item per source line. A part line becomes a
  // { kind:"form", letter, ops, comment } (one per letter); an in-music comment
  // line becomes { kind:"comment", text }. Emitted verbatim top-to-bottom.
  const scoreItems = [];
  const macros = new Map(); // *n -> { ops, comments }
  const warnings = [];
  const pendingComments = []; // full-line comments awaiting the next def/section
  let scoreComments = []; // comments just before the parts, kept above them
  let sawPart = false;
  const state = new Map(); // per-part scanner state

  // Macros (`*n`) are text-substituted in mucom, so their direct-clock lengths
  // (`%`) resolve against the caller's C. Macros are tokenized once, before the
  // parts set C, so seed them with the song's first C (most songs use one).
  const songClocks = (() => {
    const m = text.match(/(?<![A-Za-z])C(\d+)/);
    return m ? parseInt(m[1], 10) : DEFAULT_WHOLE_CLOCKS;
  })();

  // Pre-scan loop brackets per part: a `[ … ]` whose `[` and `]` are on
  // different source lines can't be a single `(x …)` form (we split each line
  // into its own (chN …) form), so it's emitted as `#labelK …(go labelK n)`
  // which spans forms. Returns, per letter, the decision for each `[` in order.
  const loopDecisions = scanLoopSpans(lines);

  // The echo macro `\=n1,n2` is GLOBAL in mucom (usually set on the conductor
  // part), so share one config object across every part.
  const sharedEcho = {};
  const partState = (letter) => {
    if (!state.has(letter)) {
      state.set(letter, {
        wholeClocks: DEFAULT_WHOLE_CLOCKS,
        defaultLen: null, // running `l`/`%` default, for dots-only notes (`f.`)
        decisions: loopDecisions.get(letter) || [],
        decisionIdx: 0,
        crossStack: [], // open cross-line loops (labels), persists across lines
        lfo: { on: false, delay: 0, clock: 0, amp: 0, amt: 0 }, // software LFO (M), persists across lines
        echo: sharedEcho, // shared: \=n1,n2 set in any part applies to all
      });
    }
    return state.get(letter);
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, " ");
    const trimmed = line.trim();
    i++;

    if (trimmed === "") continue;
    // Comments before the music attach to the next def / score header; comments
    // inside the music stay in place, in source order.
    if (trimmed.startsWith(";")) {
      if (sawPart) scoreItems.push({ kind: "comment", text: trimmed });
      else pendingComments.push(trimmed);
      continue;
    }

    // Macro definition: # *n{ … } — store its body, expanded where *n is used.
    const mac = trimmed.match(/^#\s*\*(\d+)\s*\{(.*)$/);
    if (mac) {
      let content = mac[2];
      while (!content.includes("}") && i < lines.length) { content += "\n" + lines[i]; i++; }
      content = content.slice(0, content.indexOf("}")).trim();
      const { ops } = tokenizeBody(content, { wholeClocks: songClocks }, warnings, "*", macros);
      macros.set(parseInt(mac[1], 10), { ops, comments: pendingComments.splice(0) });
      continue;
    }

    // Header directives: #Title, #Composer/#Author, #Option, ...
    if (trimmed.startsWith("#")) {
      const m = trimmed.match(/^#(\w+)\s+(.*)$/);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === "title") meta.title = val;
        else if (key === "composer") meta.composer = val;
        else if (key === "author") meta.author = val;
        else if (key === "voice") meta.voiceFile = val; // external @"name" bank (.dat)
        else if (key === "pcm") meta.pcmFile = val; // external ADPCM bank (*pcm.bin)
      }
      continue;
    }

    // Voice definition: @N:{ FB,AL + 4 operator lines, optional trailing "name" }
    // (also accepts the brace-less form: numbers across the following lines).
    const vm = trimmed.match(/^@(%?)(\d+)/);
    if (vm) {
      if (vm[1] === "%") {
        // @%n: the voice as the driver stores it, 6 rows of 4 register bytes
        // (DT/ML, TL, KS/AR, AM/DR, SR, SL/RR in slot order 1,3,2,4) and FB/AL
        // (expand.asm FV5) — a .dat record without its header and name.
        const num = parseInt(vm[2], 10);
        const name = (trimmed.match(/;\s*(\S+)/) || [])[1] || null;
        let block = "";
        while (i < lines.length && /^[\s$0-9]/.test(lines[i]) && lines[i].trim() !== "" && parseVoiceNumbers(block).length < 25) {
          block += " " + lines[i].replace(/;.*$/, "");
          i++;
        }
        const nums = parseVoiceNumbers(block);
        if (nums.length >= 25) {
          const rec = new Uint8Array(32);
          nums.slice(0, 25).forEach((b, k) => { rec[k + 1] = b & 0xff; });
          const v = parseVoiceDat(rec).get(0);
          if (v) voices.set(num, { ...v, name, comments: pendingComments.splice(0) });
        } else warnings.push(`voice @%${num}: expected 25 numbers, got ${nums.length}; skipped`);
        continue;
      }
      const num = parseInt(vm[2], 10);
      let block = trimmed.replace(/^@\d+\s*:?\s*/, "");
      if (block.startsWith("{")) {
        while (i < lines.length && !block.includes("}")) { block += "\n" + lines[i]; i++; }
      } else {
        while (i < lines.length && parseVoiceNumbers(block).length < 38) {
          const l2 = lines[i];
          if (l2.trim() === "" || /^[A-K@#;]/.test(l2.trim())) break;
          block += "\n" + l2;
          i++;
        }
      }
      const name = (block.match(/"([^"]*)"/) || [])[1] || null;
      const nums = parseVoiceNumbers(block);
      if (nums.length >= 38) {
        const fb = nums[0], alg = nums[1];
        const ops = [];
        for (let op = 0; op < 4; op++) {
          const b = 2 + op * 9;
          ops.push({
            ar: nums[b], dr: nums[b + 1], sr: nums[b + 2], rr: nums[b + 3],
            sl: nums[b + 4], tl: nums[b + 5], ks: nums[b + 6], ml: nums[b + 7], dt: nums[b + 8],
          });
        }
        voices.set(num, { fb, alg, ops, name, comments: pendingComments.splice(0) });
      } else {
        warnings.push(`voice @${num}: expected 38 numbers, got ${nums.length}; skipped`);
      }
      continue;
    }

    // Part line: leading letters A-K, then MML body.
    const pm = line.match(/^([A-K]+)(.*)$/);
    if (pm) {
      if (!sawPart) { scoreComments = pendingComments.splice(0); sawPart = true; }
      const letters = pm[1];
      const bodyStr = pm[2];
      for (const letter of letters) {
        if (!(letter in FM_PARTS) && !(letter in SSG_PARTS) && !(letter in PCM_PARTS) && letter !== RHYTHM_PART) continue;
        // K is always parsed — the song's tempo often lives on it, and `tempo`
        // is resolved here from scoreItems. mucomToMmlisp drops the K forms if
        // no `#pcm` bank was supplied (there'd be no samples to reference).
        const ch = FM_PARTS[letter] || SSG_PARTS[letter] || PCM_PARTS[letter] || "pcm1"; // G: see rhythmLayers
        const { ops, comment } = tokenizeBody(bodyStr, partState(letter), warnings, letter, macros);
        // A multi-letter line shares one trailing comment; keep it on the first.
        scoreItems.push({ kind: "form", letter, ch, ops, comment: letter === letters[0] ? comment : null });
      }
      continue;
    }
    // otherwise: stray line, ignore
  }

  // Flush any tempo still pending at end of a part (no note ever followed it):
  // resolve it against that part's final clock resolution.
  for (const st of state.values()) {
    if (st.pendingTempos?.length) {
      for (const tp of st.pendingTempos) tp.bpm = timerBToBpm(tp.timerB, st.wholeClocks);
      st.pendingTempos.length = 0;
    }
  }

  // The song's initial tempo seeds the score header (a tempo on a dropped part
  // can only live here). Mid-song changes are emitted inline by renderOps, so
  // multiple tempos are expected — not an error.
  let tempo = null;
  const tempoSources = scoreItems.filter((it) => it.kind === "form").map((it) => it.ops);
  for (const ops of tempoSources) {
    const t = findFirstTempo(ops);
    if (t != null) { tempo = t; break; }
  }
  if (warnings._seen) delete warnings._seen;
  return { meta, tempo, voices, macros, scoreItems, scoreComments, warnings };
}

// True if the first sounding/octave op is an absolute `o` set — then the source
// establishes the octave itself and we don't prepend a base.
function startsWithAbsoluteOctave(ops) {
  for (const op of ops) {
    if (op.t === "octSet") return true;
    if (op.t === "note" || op.t === "rest" || op.t === "tie" || op.t === "octUp" || op.t === "octDown") return false;
    if (op.t === "loop") return startsWithAbsoluteOctave(op.body);
  }
  return false;
}

function findFirstTempo(ops) {
  for (const op of ops) {
    if (op.t === "tempo") return op.bpm;
    if (op.t === "loop") { const t = findFirstTempo(op.body); if (t != null) return t; }
  }
  return null;
}

// --- MMLisp generation ------------------------------------------------------

const ACC = (acc) => (acc > 0 ? "+" : acc < 0 ? "-" : "");

// A note under the part's key shift (K/k). Untransposed it is written as the
// author wrote it; transposed it is respelled with sharps, and a shift that
// crosses an octave wraps the note in `>`/`<` so the running octave is left
// untouched (the compiler shifts the note, never the octave).
const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SHARP_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
function shiftedNote(letter, acc, shift) {
  if (!shift) return { name: `${letter}${ACC(acc)}`, dOct: 0 };
  const n = SEMI[letter] + acc + shift;
  const pc = ((n % 12) + 12) % 12;
  return { name: SHARP_NAMES[pc], dOct: Math.floor(n / 12) }; // relative to this octave's c
}
// The SN76489's 10-bit period bottoms out at A2 (~109 Hz); the SSG goes down
// to C1. A lower SSG note is played an octave (or two) up rather than pinned
// to the PSG's floor, which would be a wrong pitch.
const PSG_LOWEST_MIDI = 45;

function noteToken(letter, acc, len, ctx) {
  const shift = ctx.isPcm ? 0 : (ctx.keyShift?.K ?? 0) + (ctx.keyShift?.k ?? 0);
  let { name, dOct } = shiftedNote(letter, acc, shift);
  if (ctx.isSsg && !ctx.isNoise) {
    const midi = 12 * (ctx.oct + 1) + SEMI[letter] + acc + shift;
    if (midi < PSG_LOWEST_MIDI) {
      dOct += Math.ceil((PSG_LOWEST_MIDI - midi) / 12);
      warnOnce(ctx.warnings, "psgLow", "SSG notes below A2 are out of the PSG's range; played an octave up");
    }
  }
  const rep = (ch, k) => Array(k).fill(ch).join(" ");
  const up = dOct > 0 ? rep(">", dOct) : rep("<", -dOct);
  const down = dOct > 0 ? rep("<", dOct) : rep(">", -dOct);
  return `${up ? up + " " : ""}${name}${len ?? ""}${down ? " " + down : ""}`;
}

// --- software LFO -------------------------------------------------------------

// The pitch-word offset after each clock of a note, as PLLFO runs it: at key-on
// the delay and counter reload and the step count starts at half the peak;
// after `delay` clocks, every `clock` clocks the vector is added, and when the
// step count runs out the vector flips and the count reloads to the full
// peak. A triangle in the raw word: centred, heading in the vector's sign.
function lfoOffsets(lfo, clocks) {
  const out = new Array(clocks);
  let delay = lfo.delay, counter = lfo.clock, plc = lfo.amt >> 1, vec = lfo.amp, acc = 0;
  for (let t = 0; t < clocks; t++) {
    if (delay > 0) delay--;
    else if (--counter <= 0) {
      counter = lfo.clock;
      if (plc === 0) { vec = -vec; plc = lfo.amt; }
      plc--;
      acc += vec;
    }
    out[t] = acc;
  }
  return out;
}

// Cents of an offset on pitch class `pc`. FM adds it to the 14-bit block and
// F-number word, so it carries into the block (a dive below F-number 0 jumps
// up an octave's worth); SSG subtracts it from the o1 period, which then
// shifts — the compiler negates an SSG part's vector (muc88.asm SETMOD, as for
// `D`), so a positive one raises the pitch on both chips.
function lfoCents(isSsg, pc, off) {
  if (isSsg) {
    const p0 = SSG_PERIOD[pc], p = p0 - off;
    return p <= 0 ? 4800 : 1200 * Math.log2(p0 / p);
  }
  const f0 = FM_FNUM[pc], v = f0 + off;
  const blk = Math.floor(v / 2048), f = v - blk * 2048;
  return f <= 0 ? -4800 : 1200 * Math.log2((f * 2 ** blk) / f0);
}

const lfoOff = (lfo) => !lfo.on || lfo.amp * lfo.amt === 0 || lfo.clock === 0;

// Does the wave keep pitch class `pc` (null: every one) inside its word — no
// F-number carry into the block, no SSG period past 0 or 12 bits? Then its
// triangle in the word is a triangle in pitch too, however slow.
function lfoInRange(lfo, isSsg, pc) {
  const d = Math.abs(lfo.amp) * Math.ceil(lfo.amt / 2);
  const ok = (k) => (isSsg ? SSG_PERIOD[k] - d > 0 && SSG_PERIOD[k] + d < 4096 : FM_FNUM[k] - d > 0 && FM_FNUM[k] + d < 2048);
  return pc != null ? ok(pc) : FM_FNUM.every((_, k) => ok(k));
}

// A vibrato (a looping triangle) rather than a sweep: a fast wave, or one that
// stays in range.
const lfoIsVibrato = (lfo, isSsg, pc) =>
  2 * lfo.amt * lfo.clock <= LFO_VIBRATO_MAX_PERIOD || lfoInRange(lfo, isSsg, pc);

// A vibrato's depth in cents on pitch class `pc` (null: the mean of all 12) —
// the mean of the swing up and down, which differ once it is wide.
function lfoDepth(lfo, isSsg, pc) {
  const half = Math.abs(lfo.amp) * (lfo.amt >> 1 || 1);
  const at = (k) => (Math.abs(lfoCents(isSsg, k, half)) + Math.abs(lfoCents(isSsg, k, -half))) / 2;
  if (pc != null) return at(pc);
  let sum = 0;
  for (let k = 0; k < 12; k++) sum += at(k);
  return sum / 12;
}

// Is the LFO drawn per pitch class (a sweep, or a vibrato whose depth varies
// too much across the octave) rather than one spec for every note?
function lfoPerPitchClass(lfo, isSsg) {
  if (lfoOff(lfo)) return false;
  if (!lfoIsVibrato(lfo, isSsg, null)) return true;
  const d = Array.from({ length: 12 }, (_, k) => lfoDepth(lfo, isSsg, k));
  return Math.max(...d) - Math.min(...d) > LFO_DEPTH_SPREAD_CENTS;
}

// The (macro :pitch+ …) spec for a software LFO on pitch class `pc` (null: one
// for every note). A vibrato is a looping triangle; a sweep is the exact curve,
// fitted with linear segments, as far as its longest note (`maxClocks`).
// Lengths are whole-note fractions of the part's clock (`3/112`), which an
// `Nt` could not hold for every C.
// The MMB holds a macro of up to 255 steps and drops a longer one, so a macro
// over that many frames (at the song's opening tempo) is sampled at a coarser
// :step — which the preview plays too.
const MACRO_MAX_STEPS = 250; // under 255, for the rounding of lengths
function macroStep(frames) {
  const step = Math.ceil(frames / MACRO_MAX_STEPS);
  return step > 1 ? `:step ${step}f ` : "";
}

// The (macro …) body for a software LFO on pitch class `pc` (null: one for
// every note): `:pitch+` and its spec, a :step first when it is long.
function lfoSpec(lfo, isSsg, wholeClocks, pc, maxClocks, bpm) {
  if (lfoOff(lfo)) return ":pitch+ none";
  const len = (n) => `${n}/${wholeClocks}`;
  const frames = (clocks) => (clocks / wholeClocks) * (240 / (bpm || 120)) * 60;
  if (lfoIsVibrato(lfo, isSsg, pc)) {
    const cents = Math.max(1, Math.round(lfoDepth(lfo, isSsg, pc)));
    const dir = lfo.amp > 0 ? 1 : -1; // a positive vector raises the pitch first
    // :phase 64 starts the triangle at its centre, heading for :to — as PLLFO.
    const tri = `(triangle ${-dir * cents}..${dir * cents} :len ${len(2 * lfo.amt * lfo.clock)} :phase 64)`;
    const lead = lfo.delay + lfo.clock - 1; // clocks before the first step
    return `${macroStep(frames(lead + 2 * lfo.amt * lfo.clock))}:pitch+ ${lead > 0 ? `[ (wait ${len(lead)}) ${tri} ]` : tri}`;
  }
  const n = Math.min(LFO_SWEEP_MAX_CLOCKS, maxClocks || LFO_SWEEP_MAX_CLOCKS);
  const offs = lfoOffsets(lfo, n);
  const c = offs.map((o) => Math.max(-4800, Math.min(4800, lfoCents(isSsg, pc ?? 0, o))));
  const items = [];
  let i = 0;
  while (i < n && c[i] === 0) i++;
  if (i > 0) items.push(`(wait ${len(i)})`);
  // Greedy fit: extend each segment while every clock stays within tolerance.
  let a = Math.max(0, i - 1);
  while (a < n - 1) {
    let b = a + 1;
    for (let j = a + 2; j < n; j++) {
      let ok = true;
      for (let k = a + 1; k < j; k++) {
        const y = c[a] + ((c[j] - c[a]) * (k - a)) / (j - a);
        if (Math.abs(y - c[k]) > LFO_SWEEP_TOLERANCE) { ok = false; break; }
      }
      if (!ok) break;
      b = j;
    }
    items.push(`(linear ${Math.round(c[a])}..${Math.round(c[b])} :len ${len(b - a)})`);
    a = b;
  }
  return `${macroStep(frames(n))}:pitch+ [ ${items.join(" ")} ]`;
}

// Name an LFO spec once as (def lfoN (macro :pitch+ …)) and return the name.
function lfoName(ctx, spec) {
  let name = ctx.lfoRegistry.get(spec);
  if (!name) {
    const off = ":pitch+ none";
    name = spec === off ? "lfo-off" : `lfo${[...ctx.lfoRegistry.keys()].filter((k) => k !== off).length + 1}`;
    ctx.lfoRegistry.set(spec, name);
  }
  return name;
}

// Before a note: an LFO drawn per pitch class switches to this note's.
function lfoBeforeNote(ctx, out, letter, acc) {
  if (ctx.isNoise) return;
  const sw = ctx.lfoPerPc;
  // A slur keeps the running curve — unless an `M` came in between: the driver
  // reloads the delay then and restarts the wave on the new pitch.
  if (!sw || !ctx.lfoRegistry || (ctx.pendingSlur && !ctx.lfoChanged)) return;
  ctx.lfoChanged = false;
  const shift = (ctx.keyShift?.K ?? 0) + (ctx.keyShift?.k ?? 0);
  const pc = (((SEMI[letter] + acc + shift) % 12) + 12) % 12;
  const name = lfoName(ctx, lfoSpec(sw.lfo, ctx.isSsg, sw.wholeClocks, pc, sw.maxClocks, ctx.tempo));
  if (name !== ctx.lfoActive || ctx.verbose) { out.push(name); ctx.lfoActive = name; }
}

// --- rhythm (part G) ----------------------------------------------------------

// Part G's forms as one :prio layer per sound (RHYTHM_SOUNDS), each a copy of
// G's ops — its loops and `L` kept — that plays the notes whose `@` mask keys
// its sound and rests through the rest. The compiler's layering then picks
// what plays: a hit is dropped while a higher-priority one sounds (its :gate,
// the ring time) and cuts a lower one. A hit's level is the total plus the
// sound's own, against the loudest the part plays (:vel 15). `@` and `v` carry
// from pass to pass, so a loop whose passes key differently is written out
// pass by pass. Returns, per form, the layers' ops (null: the sound is never
// keyed anywhere in the part).
function rhythmLayers(forms, warnings) {
  const st = { mask: 0, levels: [63, 31, 31, 31, 31, 31, 31] };
  const KEEP = new Set(["loopBreak", "loopMarker", "loopGo", "globalLoop", "tempo", "lenSet", "bar"]);
  const walk = (ops) => ops.flatMap((op) => {
    switch (op.t) {
      case "voice": st.mask = op.n; return [];
      case "rhythmLevels":
        op.levels.forEach((v, k) => { if (v != null && k < 7) st.levels[k] = clamp(v, 0, k ? 31 : 63); });
        return [];
      case "velAdj": st.levels[0] = clamp(st.levels[0] + op.d, 0, 63); return [];
      case "loop": {
        const first = walk(op.body);
        const second = walk(op.body);
        if (JSON.stringify(first) === JSON.stringify(second)) return [{ ...op, body: first }];
        // Written out: passes 3.. from where the one before left, the last
        // stopping at its `/`.
        const head = op.body.slice(0, Math.max(0, op.body.findIndex((o) => o.t === "loopBreak")));
        const passes = [first, second];
        for (let p = 3; p <= op.count; p++) passes.push(walk(p === op.count && head.length ? head : op.body));
        if (op.count === 2 && head.length) passes[1] = second.slice(0, second.findIndex((o) => o.t === "loopBreak"));
        return passes.slice(0, Math.max(1, op.count)).flat().filter((o) => o.t !== "loopBreak");
      }
      case "note": {
        const hits = {};
        RHYTHM_SOUNDS.forEach((_, k) => {
          if (st.mask >> k & 1) hits[k] = RHYTHM_DB_PER_STEP * (63 - st.levels[0] + 31 - st.levels[k + 1]);
        });
        return [{ t: "note", letter: "c", acc: 0, len: op.len, clocks: op.clocks, hits }];
      }
      case "rest": case "tie": return [{ t: "rest", len: op.len, clocks: op.clocks }];
      case "macroCall":
        warnOnce(warnings, "rhythmMacro", "part G: a macro (*n) is not followed on the rhythm part; dropped");
        return [];
      default: return KEEP.has(op.t) ? [op] : [];
    }
  });
  const items = forms.map((f) => walk(f.ops));

  let loudest = Infinity;
  const keyed = new Set();
  const scan = (ops) => ops.forEach((op) => {
    if (op.t === "loop") scan(op.body);
    else if (op.hits) for (const [k, a] of Object.entries(op.hits)) { keyed.add(+k); loudest = Math.min(loudest, a); }
  });
  items.forEach(scan);
  return RHYTHM_SOUNDS.map((s, k) => {
    if (!keyed.has(k)) return null;
    let vel = null;
    const layer = (ops) => ops.flatMap((op) => {
      if (op.t === "loop") return [{ ...op, body: layer(op.body) }];
      if (!op.hits) return [op];
      if (op.hits[k] == null) return [{ t: "rest", len: op.len, clocks: op.clocks }];
      const v = clamp(Math.round(15 - (op.hits[k] - loudest) / VEL_DB_PER_STEP), 1, 15);
      const pre = v !== vel ? [{ t: "raw", text: `:vel ${(vel = v)}` }] : [];
      return [...pre, { t: "note", letter: "c", acc: 0, len: op.len, clocks: op.clocks }];
    });
    return items.map(layer);
  });
}

// --- loops ------------------------------------------------------------------
//
// mucom compiles a loop body ONCE and the driver repeats the bytes, so state
// splits in two:
//   compile-time — octave, `l`, K/k, the note `^` repeats: every pass plays
//     what the single compile produced, and after `]` the state is the full
//     body's (even when the last pass left at `/`). MMLisp's (x …) bakes the
//     same way, so these need nothing.
//   runtime — `)`/`(`, `D n+`, `q`, a tie `&` carried into the next note: driver
//     commands, so they act again on every pass (`[c)]4` is a crescendo) and
//     the last pass stops at `/`. An (x …) body would replay pass one.
// So a loop whose passes differ — its body renders differently from the state
// the previous pass left, or it ends in a tie into the next pass — is written
// out pass by pass. A tie INTO a loop only ties its first pass, so that pass is
// peeled off. Between written-out passes the compile-time state is put back.

const compileState = (ctx) => ({ oct: ctx.oct, len: ctx.len, keyShift: ctx.keyShift, lastNote: ctx.lastNote });

function setCompileState(ctx, st, out) {
  if (st.oct !== ctx.oct) { out.push(`:oct ${st.oct}`); ctx.oct = st.oct; }
  if (st.len != null && st.len !== ctx.len) { out.push(`:len ${st.len}`); ctx.len = st.len; }
  ctx.keyShift = st.keyShift;
  ctx.lastNote = st.lastNote;
}

// A throwaway copy of a render context: trial renders must not register defs
// or warnings the real render would then see as already done.
function scratchCtx(ctx) {
  const copy = (m) => (m ? new Map(m) : m);
  return {
    verbose: false,
    ...ctx,
    warnings: [],
    warnedVoices: new Set(ctx.warnedVoices),
    chain: null, // a trial must not patch the real output (finishChain)
    crossActive: [...(ctx.crossActive || [])],
    crossSnap: new Map(ctx.crossSnap || []),
    newUnrollCross: null, // a trial decides nothing
    lfoRegistry: copy(ctx.lfoRegistry),
    envRegistry: copy(ctx.envRegistry),
    echoRegistry: copy(ctx.echoRegistry),
    pcmRegistry: copy(ctx.pcmRegistry),
  };
}

// Bring the runtime state written into `out` from `ctx`'s to `st`'s.
function setRuntimeState(ctx, st, out) {
  if (st.vel != null && st.vel !== ctx.vel) pushVel(ctx, out, st.vel);
  ctx.qCut = st.qCut;
  ctx.reverb = st.reverb;
  if (st.gateCut != null) emitGate(ctx, out);
  if ((st.detune ?? 0) !== (ctx.detune ?? 0) && !ctx.isPcm) { ctx.detune = st.detune ?? 0; detuneChanged(ctx, out); }
}

// Would a loop across lines play differently pass to pass? The same trial
// renderLoop makes, from the state its #label was reached in.
function crossPassesDiffer(snap, tree, depth) {
  if (snap.pendingSlur) return true; // tied into: only pass one is
  const full = tree.filter((o) => o.t !== "loopBreak");
  const a = scratchCtx(snap);
  a.verbose = true;
  const t1 = [];
  renderOps(full, a, t1, depth + 1);
  const b = scratchCtx(a);
  setCompileState(b, compileState(snap), []);
  const t2 = [];
  renderOps(full, b, t2, depth + 1);
  return !!a.pendingSlur || t1.join(" ") !== t2.join(" ");
}

function renderLoop(op, ctx, out, depth) {
  const count = op.count;
  if (count <= 0) return;
  const bi = op.body.findIndex((o) => o.t === "loopBreak");
  const full = bi >= 0 ? op.body.filter((_, k) => k !== bi) : op.body;
  const head = bi >= 0 ? op.body.slice(0, bi) : op.body;
  const ct0 = compileState(ctx);

  // Trial: pass one from here, pass two from where pass one left the runtime
  // state (compile-time state reset, as the compiler never re-reads the body).
  // Rendered verbose — every state token written, even one that repeats the
  // current value — so a token pass two merely elides does not count as a
  // difference: (x …) replays pass one's tokens, which are then no-ops.
  const a = scratchCtx(ctx);
  a.verbose = true;
  const t1 = [];
  renderOps(full, a, t1, depth + 1);
  const ctFull = compileState(a);
  const b = scratchCtx(a);
  setCompileState(b, ct0, []);
  const t2 = [];
  renderOps(full, b, t2, depth + 1);
  const tiesOn = !!a.pendingSlur; // pass one ends in `&`: it slurs into pass two
  const varies = t1.join(" ") !== t2.join(" ");

  let linear = 0;
  if (count > 1 && (varies || tiesOn)) linear = count;
  else if (ctx.pendingSlur) linear = 1;

  let k = 0;
  for (; k < linear; k++) {
    if (k > 0) setCompileState(ctx, ct0, out);
    renderOps(k === count - 1 ? head : full, ctx, out, depth);
  }
  const rest = count - k;
  if (rest === 1) {
    if (k > 0) setCompileState(ctx, ct0, out);
    renderOps(head, ctx, out, depth);
  } else if (rest > 1) {
    if (k > 0) setCompileState(ctx, ct0, out);
    const inner = [];
    renderOps(op.body, ctx, inner, depth + 1); // a `/` renders as (break)
    if (inner.length) out.push(`(x ${rest} ${inner.join(" ")})`);
    if (bi >= 0) {
      // The last pass left at the break: the runtime state is the head's, not
      // the full body's the (x …) left behind.
      const h = scratchCtx(ctx);
      setCompileState(h, ct0, []);
      renderOps(head, h, [], depth + 1);
      setRuntimeState(ctx, h, out);
    }
  }
  setCompileState(ctx, ctFull, out);
}

function renderOps(ops, ctx, out, depth = 0) {
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    switch (op.t) {
      case "note":
        if (mutedHere(ctx) || ctx.pcmMuted) { ctx.pendingSlur = false; out.push(`_${op.len ?? ""}`); ctx.lastNote = { letter: op.letter, acc: op.acc }; break; }
        noiseModeBeforeNote(ctx, out);
        envBeforeNote(ctx, out);
        lfoBeforeNote(ctx, out, op.letter, op.acc);
        detuneBeforeNote(ctx, out, op.letter, op.acc);
        pcmNoteUse(ctx, op, ctx.pendingSlur);
        if (ctx.pendingSlur) { flushSlur(ctx, out); continueChain(ctx); } else startChain(ctx, out);
        if (!reverbNote(ctx, out, op, ops[k + 1])) out.push(noteToken(op.letter, op.acc, op.len, ctx));
        ctx.lastNote = { letter: op.letter, acc: op.acc };
        ctx.velHist = [...(ctx.velHist || []).slice(-9), ctx.vel];
        break;
      case "rest":
        // A rest ends a pending `&`: the next note keys on as usual. MMLisp's
        // `~` would reach past the rest and slur into it instead.
        ctx.pendingSlur = false;
        finishChain(ctx, out);
        out.push(`_${op.len ?? ""}`);
        break;
      case "keyShift":
        // Compile-time, like the octave: K and k are separate registers that add.
        ctx.keyShift = { ...(ctx.keyShift || { K: 0, k: 0 }), [op.which]: op.n };
        break;
      case "tie":
        if (mutedHere(ctx) || ctx.pcmMuted) { ctx.pendingSlur = false; out.push(`_${op.len ?? ""}`); break; }
        // mucom `^` ties to the SAME pitch as the previous note. MMLisp's `~`
        // is a connector to a note (X ~ Y); bare `~ <length>` is not valid, so
        // repeat the last note's pitch: `~ <pitch><len>` (same pitch = a tie).
        if (ctx.lastNote) {
          const p = ctx.lastNote;
          pcmNoteUse(ctx, { letter: p.letter, acc: p.acc, len: op.len }, true);
          continueChain(ctx);
          out.push(`~ ${noteToken(p.letter, p.acc, op.len, ctx)}`);
        } else {
          out.push("~"); // no preceding note (malformed) — best effort
        }
        ctx.pendingSlur = false;
        break;
      case "slur":
        // mucom `&` connector — legato into the next note. MMLisp's `~` is the
        // same, but it is written just before that note (flushSlur): a rest
        // cancels it, and a loop that follows ties only its first pass in.
        ctx.pendingSlur = true;
        break;
      case "bar":
        out.push("|"); // bar line — editorial marker, carried through verbatim
        break;
      case "raw": // a token written as is (part G's sample, :gate and :vel, rhythmLayers)
        out.push(op.text);
        break;
      case "octUp":
        // PCM part K is INVERTED (see octSet): mucom `>` raises the octave number,
        // which LOWERS the ADPCM pitch, so emit a MMLisp octave-DOWN.
        if (ctx.isPcm) { out.push("<"); ctx.oct--; } else { out.push(">"); ctx.oct++; }
        break;
      case "octDown":
        if (ctx.isPcm) { out.push(">"); ctx.oct++; } else { out.push("<"); ctx.oct--; }
        break;
      case "octSet":
        // mucom FM octaves read one higher than MMLisp's (drop one); SSG/PSG use a
        // different frequency table and need no shift. PCM part K is INVERTED: the
        // driver plays a HIGHER octave number at a LOWER pitch — it right-shifts the
        // sample-rate Δ-N by (octave-1), so o1 = native and each octave up halves
        // the rate (PCMGFQ/PCMNMB in music.asm). Mirror the octave around the native
        // reference (o1 -> MUCOM_PCM_DEFAULT_OCT) instead of shifting up.
        ctx.oct = ctx.isPcm ? (MUCOM_PCM_DEFAULT_OCT + 1 - op.n) : (op.n + ctx.octShift);
        out.push(`:oct ${ctx.oct}`);
        break;
      case "pan":
        // PCM is a soft-mix voice on the fm6 DAC and owns no FM channel, so it
        // has no pan lane.
        if (ctx.isPcm) { warnOnce(ctx.warnings, "pcmPan", "part K: pan (p) has no PCM equivalent; dropped"); break; }
        // mucom p: 0=off,1=right,2=left,3=center -> MMLisp :pan
        out.push(`:pan ${{ 1: "right", 2: "left" }[op.v] ?? "center"}`);
        break;
      case "detune": {
        if (ctx.isPcm) { warnOnce(ctx.warnings, "pcmDetune", "part K: detune (D) not supported on PCM; dropped"); break; }
        // Track the raw mucom D value (so relative D+ accumulates), then map to
        // cents with the chip's representative factor.
        ctx.detune = op.rel ? (ctx.detune ?? 0) + op.val : op.val;
        detuneChanged(ctx, out);
        break;
      }
      case "lenSet":
        ctx.len = op.token;
        out.push(`:len ${op.token}`);
        break;
      case "porta": {
        // mucom {from len to}: glide from the start pitch to the target over len.
        // (glide <from> <len>) — from needs an absolute octave (bare note = C4).
        if (mutedHere(ctx)) {
          ctx.pendingSlur = false;
          for (let s = op.to.bo; s > 0; s--) { out.push(">"); ctx.oct++; }
          for (let s = op.to.bo; s < 0; s++) { out.push("<"); ctx.oct--; }
          out.push(`_${op.len ?? ""}`);
          ctx.lastNote = { letter: op.to.letter, acc: op.to.acc };
          break;
        }
        noiseModeBeforeNote(ctx, out);
        envBeforeNote(ctx, out);
        lfoBeforeNote(ctx, out, op.to.letter, op.to.acc);
        detuneBeforeNote(ctx, out, op.to.letter, op.to.acc);
        const shift = ctx.isPcm ? 0 : (ctx.keyShift?.K ?? 0) + (ctx.keyShift?.k ?? 0);
        const from = shiftedNote(op.from.letter, op.from.acc, shift);
        const fromPitch = `${from.name}${ctx.oct + op.from.bo + from.dOct}`;
        const len = op.len ?? ctx.len ?? "4";
        if (ctx.pendingSlur) { flushSlur(ctx, out); continueChain(ctx); } else startChain(ctx, out);
        out.push(`(glide ${fromPitch} ${len})`);
        for (let s = op.to.bo; s > 0; s--) { out.push(">"); ctx.oct++; }
        for (let s = op.to.bo; s < 0; s++) { out.push("<"); ctx.oct--; }
        out.push(noteToken(op.to.letter, op.to.acc, op.len, ctx));
        out.push("(glide none)"); // one porta note only; following notes don't glide
        ctx.lastNote = { letter: op.to.letter, acc: op.to.acc };
        break;
      }
      case "hwLfo":
        // Hardware (YM) LFO. FM only — the SSG/PSG has no equivalent.
        if (ctx.isSsg) {
          warnOnce(ctx.warnings, "Hssg", "hardware LFO (H) is FM-only; dropped on SSG/PSG");
        } else {
          out.push(`:lfo-rate ${clamp(op.speed, 0, 8)} :fms ${clamp(op.pms, 0, 7)} :ams ${clamp(op.ams, 0, 3)}`);
        }
        break;
      case "lfoSet": {
        // Software pitch LFO -> a sticky (macro :pitch+ …), additive so it rides
        // a glide or detune. One spec for every note is named here; one drawn
        // per pitch class is named per note (lfoBeforeNote).
        const lfo = op.lfo;
        if (ctx.isPcm || ctx.isNoise) break;
        if (lfoPerPitchClass(lfo, ctx.isSsg)) {
          ctx.lfoPerPc = { lfo, wholeClocks: op.wholeClocks, maxClocks: op.maxClocks };
          ctx.lfoChanged = true;
          break;
        }
        ctx.lfoPerPc = null;
        const spec = lfoSpec(lfo, ctx.isSsg, op.wholeClocks, null, op.maxClocks, ctx.tempo);
        if (ctx.lfoRegistry) {
          const name = lfoName(ctx, spec);
          if (name !== ctx.lfoActive || ctx.verbose) { out.push(name); ctx.lfoActive = name; }
        } else {
          out.push(`(macro ${spec})`);
        }
        break;
      }
      case "ssgEnv":
        // The envelope is drawn per note level (envBeforeNote): see ssgEnvSpec.
        ctx.ssgEnv = op;
        ctx.envActive = null;
        break;
      case "opReg":
      case "rawReg": {
        // y: an FM register write, as the same parameter written inline. The
        // voice's next @ rewrites it, as the driver's voice set does.
        if (ctx.isSsg || ctx.isPcm) break;
        // A carrier's TL is rewritten by the next note's volume (STVOL), so a
        // y to it does not last; :tlN would. Dropped.
        const tlOp = op.t === "opReg" ? (op.name === "TL" ? op.op : null)
          : (op.reg & 0xf0) === 0x40 ? [1, 3, 2, 4][(op.reg >> 2) & 3] : null;
        if (tlOp != null && ctx.voiceAlg != null && ALG_CARRIERS[ctx.voiceAlg].includes(tlOp)) break;
        const toks = op.t === "opReg" ? opRegTokens(op.name, op.op, op.val) : rawRegTokens(op.reg, op.val);
        if (toks) out.push(toks);
        else warnOnce(ctx.warnings, `y${op.name ?? op.reg}`, `register write y${op.name ?? op.reg} has no MMLisp parameter; dropped`);
        break;
      }
      case "mix":
        // SSG P: 0 off, 1 tone, 2 noise, 3 both. Its notes sound on the PSG
        // square while tone is on, and on the noise copy of the part while
        // noise is on (mucomToMmlisp renders such a part twice).
        ctx.mix = op.v;
        break;
      case "noiseFreq":
        ctx.noiseW = op.n;
        break;
      case "vel":
        if (op.v !== ctx.vel || ctx.verbose) pushVel(ctx, out, op.v);
        break;
      case "gateCut":
        // mucom q<n> -> :gate- (key off n clocks early); convert clocks to ticks.
        ctx.qCut = Math.round(op.n * (WHOLE_TICKS / op.wholeClocks));
        emitGate(ctx, out);
        break;
      case "reverb":
        // FM reverb (R n / RF 0|1): at the q point the driver does not key off
        // but drops the level to (v+n)/2 and lets the note ring into the next
        // (music.asm FMSUB0). So no gate cut while it is on, and each note is
        // split at its q point into a tie whose tail is turned down with :vol
        // (reverbNote). On SSG the envelope runs on past the q point at
        // (level+n)/2 instead of releasing (SSSUBA / SOFEV7): kept ringing,
        // without the drop.
        if (ctx.isPcm) break;
        ctx.reverb = op.on;
        if (op.amt != null) ctx.reverbAmt = op.amt;
        emitGate(ctx, out);
        break;
      case "velAdj": {
        const nv = clamp((ctx.vel ?? (ctx.isPcm ? MUCOM_PCM_VEL_DEFAULT : 12)) + op.d, 0, ctx.isPcm ? MUCOM_PCM_VEL_MAX : 15);
        if (nv !== ctx.vel || ctx.verbose) pushVel(ctx, out, nv);
        break;
      }
      case "echo": {
        // mucom `\` -> one echo tap of the single note `back` positions back.
        // The driver plays it at the CURRENT volume minus `drop` (music.asm:
        // a relative -drop, the note, +drop), while MMLisp's :vel+ counts
        // from the replayed note's own vel — so the offset is converted here
        // from the vel each recent note was written at. Define each distinct
        // echo once as (def ecN (echo …)) and reference it by name. Omit the
        // default :back 1.
        const hist = ctx.velHist || [];
        const srcVel = hist[hist.length - op.back];
        let plus = -(op.drop ?? 0);
        if (srcVel != null && ctx.vel != null && !ctx.isPcm) {
          plus = velToken(clamp(ctx.vel - (op.drop ?? 0), 0, 15), ctx) - velToken(srcVel, ctx);
        }
        let form = `1 :vel+ ${plus}`;
        if (op.back !== 1) form += ` :back ${op.back}`;
        if (ctx.echoRegistry) {
          let name = ctx.echoRegistry.get(form);
          if (!name) { name = `ec${ctx.echoRegistry.size + 1}`; ctx.echoRegistry.set(form, name); }
          out.push(name);
        } else {
          out.push(`(echo ${form})`);
        }
        break;
      }
      case "macroCall":
        // A mucom macro is pasted text, and so is a (def *n …): whatever state
        // its body sets carries on after the call. Track it, or a later `)`
        // would count from a stale volume.
        if (ctx.macroOps && ctx.macroOps.has(op.n)) {
          const m = scratchCtx(ctx);
          renderOps(ctx.macroOps.get(op.n), m, [], depth + 1);
          for (const key of ["pcmSample", "pcmMuted", "vel", "detune", "detunePerNote", "pitchOut", "gateCut", "qCut", "reverb", "reverbAmt", "voiceAlg", "pcmCur", "mix", "noiseW", "noiseMode", "envActive", "ssgEnv", "velHist", "oct", "len", "keyShift", "lastNote", "lfoPerPc", "lfoActive"]) ctx[key] = m[key];
        }
        // Reference a (def *n …); skip macros whose body had no supported content.
        if (ctx.usableMacros && ctx.usableMacros.has(op.n)) out.push(`*${op.n}`);
        else if (!ctx.warnedVoices.has(`*${op.n}`)) {
          ctx.warnedVoices.add(`*${op.n}`);
          ctx.warnings.push(`macro *${op.n} has no MMLisp-supported content; dropped`);
        }
        break;
      case "voice":
        // On part K, @n selects a bank sample (1-based), not an FM voice. A bare
        // symbol rebinds the PCM track's sample, so that is all we emit; the def
        // is collected in pcmRegistry and spliced above the score.
        if (ctx.isPcm) {
          const entry = ctx.pcmEntries && ctx.pcmEntries.get(op.n);
          if (entry && ctx.pcmDrop?.has(entry.label)) {
            ctx.pcmSample = null; // dropped to fit the bank (fitPcmBank): its notes rest
            ctx.pcmMuted = true;
          } else if (entry) {
            ctx.pcmRegistry.set(op.n, entry);
            ctx.pcmSample = op.n;
            ctx.pcmMuted = false;
            out.push(entry.label);
          } else if (!ctx.warnedVoices.has(`pcm@${op.n}`)) {
            ctx.warnedVoices.add(`pcm@${op.n}`);
            ctx.warnings.push(`part K: @${op.n} is not in the PCM bank; dropped`);
          }
          break;
        }
        // Only switch to voices actually defined in this file; an undefined
        // @N would be an "unknown token" error, so skip it (use the default).
        if (ctx.definedVoices.has(op.n)) { out.push(`@${ctx.voiceLabels.get(op.n)}`); ctx.voiceAlg = ctx.voiceAlgs?.get(op.n) ?? null; }
        else if (!ctx.warnedVoices.has(op.n)) {
          ctx.warnedVoices.add(op.n);
          ctx.warnings.push(`voice @${op.n} referenced but not defined in this file — using default voice`);
        }
        break;
      case "voiceByName": {
        // @"name": resolve to an inline voice of that name. External banks
        // (#voice xxx.dat) aren't loaded, so unknown names just keep the default.
        const label = ctx.voiceByName && ctx.voiceByName.get(op.name);
        if (label) { out.push(`@${label}`); ctx.voiceAlg = ctx.voiceAlgByName?.get(op.name) ?? null; }
        else if (!ctx.warnedVoices.has(`"${op.name}"`)) {
          ctx.warnedVoices.add(`"${op.name}"`);
          ctx.warnings.push(`voice @"${op.name}" not defined in this file (external bank?) — using default voice`);
        }
        break;
      }
      case "loopBreak":
        // Inside an (x …) body (depth > 0) or a #label/(go) loop MMLisp's
        // (break) does the job. A loop across lines that is written out pass
        // by pass has no break in pass one, which is never its last.
        if (depth === 0 && ctx.unrollCross?.has(ctx.crossActive?.at(-1))) break;
        out.push("(break)");
        break;
      case "loopMarker": {
        // Pass one of a loop across lines renders in place, over its lines.
        // What it would repeat is judged at its (go) from a copy of the state
        // here; one whose passes differ is re-rendered without the label and
        // with passes two on written at the (go) (crossLoopPasses).
        const snap = scratchCtx(ctx);
        (ctx.crossSnap ||= new Map()).set(op.label, snap);
        (ctx.crossActive ||= []).push(op.label);
        if (ctx.unrollCross?.has(op.label)) break;
        flushSlur(ctx, out); // into a kept #label loop every pass ties in — best effort
        out.push(`#${op.label}`);
        break;
      }
      case "loopGo": {
        ctx.crossActive?.pop();
        const snap = ctx.crossSnap?.get(op.label);
        const tree = ctx.crossTrees?.get(op.label);
        if (ctx.unrollCross?.has(op.label) && snap && tree) {
          setCompileState(ctx, compileState(snap), out);
          renderLoop({ t: "loop", count: op.count - 1, body: tree }, ctx, out, depth);
          break;
        }
        if (snap && tree && op.count > 1 && ctx.newUnrollCross && crossPassesDiffer(snap, tree, depth)) {
          ctx.newUnrollCross.add(op.label);
        }
        out.push(`(go ${op.label} ${op.count})`);
        break;
      }
      case "globalLoop":
        // A part loops to its LAST L: each one re-stores the loop address
        // (muc88.asm SETJMP), so only that one becomes the #loop label. A tie
        // into L only ties the first time through — a loop back lands past it
        // — so it is dropped rather than tying every pass; the level chain
        // ends.
        if (--ctx.loopMarksLeft > 0) break;
        ctx.pendingSlur = false;
        finishChain(ctx, out);
        if (!ctx.hasGlobalLoop) { out.push("#loop"); ctx.hasGlobalLoop = true; }
        break;
      case "loop":
        // Single-line loop -> (x N …), or written out pass by pass (renderLoop).
        renderLoop(op, ctx, out, depth);
        break;
      case "tempo":
        // Emit an inline :tempo only when it changes the running tempo. The
        // first tempo already rides the first playable form (ctx.tempo), so
        // it's not repeated inline; mid-song changes are emitted here.
        if (ctx.isNoise) break; // the square track carries it
        if (op.bpm !== ctx.tempo || ctx.verbose) { out.push(`:tempo ${op.bpm}`); ctx.tempo = op.bpm; }
        break;
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v | 0)); }

// The SSG's volume register steps 3 dB (fmgen psg.cpp), 0 silent. The Mega
// Drive PSG's attenuator does not step evenly: Nuked-PSG's measured levels
// (ympsg_vol) fall 2 dB a step at the top and 7 dB at the bottom. A register
// value plays as the :vel whose level is nearest in dB (:vel = 15 - atten).
const PSG_LEVELS = [1.0, 0.772, 0.622, 0.485, 0.382, 0.29, 0.229, 0.174, 0.132, 0.096, 0.072, 0.051, 0.034, 0.019, 0.009];
const PSG_LEVEL_DB = PSG_LEVELS.map((x) => 20 * Math.log10(x));
function ssgRegVel(r) {
  if (r <= 0) return 0;
  const db = -3 * (15 - Math.min(15, r));
  let best = 0;
  for (let a = 1; a < PSG_LEVEL_DB.length; a++) if (Math.abs(PSG_LEVEL_DB[a] - db) < Math.abs(PSG_LEVEL_DB[best] - db)) best = a;
  return 15 - best;
}

// An SSG part that ever turns noise on renders twice: its square track keeps
// the notes played with tone on, its noise copy (ctx.isNoise) the ones with
// noise on; each rests through the other's.
function mutedHere(ctx) {
  if (!ctx.isSsg) return false;
  const mix = ctx.mix ?? 1;
  return ctx.isNoise ? !(mix & 2) : !(mix & 1);
}

// The noise copy's :mode, from the SSG noise period w0-31: the OPNA shifts its
// noise at 124.8 kHz / w, the SN76489 at 7 / 3.5 / 1.7 kHz (white0-2) — the
// nearest one, which is white0 for nearly every hi-hat.
function noiseModeBeforeNote(ctx, out) {
  if (!ctx.isNoise) return;
  const f = 124800 / Math.max(1, ctx.noiseW ?? 0);
  const rates = [6991, 3496, 1748];
  let best = 0;
  for (let k = 1; k < rates.length; k++) if (Math.abs(Math.log(f / rates[k])) < Math.abs(Math.log(f / rates[best]))) best = k;
  const mode = `white${best}`;
  if (mode !== ctx.noiseMode || ctx.verbose) { out.push(`:mode ${mode}`); ctx.noiseMode = mode; }
}

// --- level moves inside a tie ---------------------------------------------
//
// mucom's v ) ( write the carrier level at once, so `v1 c&[c&)]7` swells one
// held note. MMLisp's :vel is taken at note-on and a tie continuation keeps
// it; :vol (the fader, same 2 dB a step) moves a sounding note. So a run of
// tied notes is a "chain": a level change made inside it is rewritten, once
// the chain ends, as :vol under a :vel lifted to the chain's loudest level,
// and the fader goes back to 31 for the next note. The tokens are patched in
// place in the out arrays they were written to.
function pushVel(ctx, out, v) {
  out.push(`:vel ${velToken(v, ctx)}`);
  ctx.vel = v;
  if (ctx.chain) ctx.chain.cand.push({ arr: out, idx: out.length - 1, v });
}

function startChain(ctx, out) {
  finishChain(ctx, out);
  if (ctx.isPcm || ctx.vel == null) return;
  ctx.chain = { arr: out, idx: out.length, base: ctx.vel, toks: [], cand: [] };
}

// A tie continues the chain: level changes since the last note belong to it.
function continueChain(ctx) {
  if (!ctx.chain) return;
  ctx.chain.toks.push(...ctx.chain.cand);
  ctx.chain.cand = [];
}

function finishChain(ctx, out) {
  const ch = ctx.chain;
  ctx.chain = null;
  if (!ch || !ch.toks.length) return;
  const top = Math.max(ch.base, ...ch.toks.map((t) => t.v));
  // :vol is 2 dB a step, like :vel — so it moves as the written :vel would.
  // An SSG level is the envelope's times v (ssgEnvSpec), and on the PSG the
  // :vol steps add to the attenuator's, whose bottom ones are wide: the step
  // count is the attenuator's between the two at the envelope's sustain.
  const sl = ctx.isSsg ? (ctx.ssgEnv?.sl ?? 255) : 255;
  const velAt = (v) => (ctx.isSsg ? ssgRegVel(Math.floor((sl * (v + 1)) / 256)) : velToken(v, ctx));
  const vol = (v) => Math.max(0, 31 - (velAt(top) - velAt(v)));
  ch.arr[ch.idx] = `:vel ${velToken(top, ctx)} :vol ${vol(ch.base)} ${ch.arr[ch.idx]}`;
  for (const t of ch.toks) t.arr[t.idx] = `:vol ${vol(t.v)}`;
  out.push(":vol 31");
  // MMLisp's :vel is now `top` — unless a change after the chain re-set it.
  if (!ch.cand.length && ctx.vel !== top) out.push(`:vel ${velToken(ctx.vel, ctx)}`);
}

// --- SSG soft envelope -------------------------------------------------------
//
// mucom E AL,AR,DR,SL,SR,RR (music.asm SOFENV): a 0-255 level starts at AL,
// climbs AR a clock to 255, falls DR a clock to SL, then SR a clock towards 0
// while held; key-off falls RR a clock. The register gets level*(v+1)/256,
// which plays as ssgRegVel of it — so in dB a decay is deeper the louder the
// note, and its last steps are the PSG's wide ones. As a :vel* macro (the
// note's vel times each value) a stage is that played :vel over the note's,
// clock by clock, fitted with straight pieces. One envelope therefore draws
// per `v`, named like the LFO's pitch classes.
const SSG_ENV_TOLERANCE = 1; // :vel steps, the straight-piece fit of a stage
function ssgEnvSpec(op, wholeClocks, v, bpm) {
  const factor = WHOLE_TICKS / wholeClocks;
  let ticks = 0; // the stages' whole length, for macroStep
  const vel = Math.max(1, ssgRegVel(v));
  const played = (level) => ssgRegVel(Math.floor((level * (v + 1)) / 256));
  const ratio = (x) => Math.round((100 * x) / vel) / 100;
  const items = [];
  // A stage from level a towards b, `rate` a clock — SOFENV steps the level
  // once a clock and holds it between, so a note keeps its start level for
  // its first clock — as the played :vel per tick, fitted greedily with pieces
  // that stay within the tolerance.
  const stage = (a, b, rate) => {
    if (rate <= 0) return;
    const total = Math.max(1, Math.round(Math.ceil(Math.abs(b - a) / rate) * factor));
    ticks += total;
    const dir = b > a ? 1 : -1;
    const y = Array.from({ length: total + 1 }, (_, j) => {
      const lv = a + dir * Math.floor(j / factor) * rate;
      return played(dir > 0 ? Math.min(b, lv) : Math.max(b, lv));
    });
    let i = 0;
    while (i < total) {
      let j = i + 1;
      for (let e = i + 2; e <= total; e++) {
        let ok = true;
        for (let k = i + 1; k < e && ok; k++) ok = Math.abs(y[i] + ((y[e] - y[i]) * (k - i)) / (e - i) - y[k]) <= SSG_ENV_TOLERANCE;
        if (!ok) break;
        j = e;
      }
      items.push(`(linear ${ratio(y[i])}..${ratio(y[j])} :len ${j - i}t)`);
      i = j;
    }
  };
  const { al, ar, dr, sl, sr, rr } = op;
  if (al < 255) {
    if (ar > 0) stage(al, 255, ar);
    else items.push(`${ratio(played(al))}`); // AR 0: it never rises
  }
  if (al >= 255 || ar > 0) {
    if (sl < 255) stage(255, sl, dr);
    if (dr === 0 && sl < 255) items.push("1"); // DR 0: it holds at the top
    else if (sr > 0 && sl > 0) stage(sl, 0, sr);
  }
  // Key-off releases from wherever the level is; a macro curve needs its
  // start written, so it is SL — exact for a note that reached the sustain
  // and has not decayed far into it.
  items.push("(wait key-off)");
  if (sl > 0 && rr > 0) stage(sl, 0, rr);
  return `${macroStep((ticks / PPQN) * (60 / (bpm || 120)) * 60)}:vel* [ ${items.join(" ")} ]`;
}

// Before an SSG note: the envelope drawn for its `v`, if not already active.
function envBeforeNote(ctx, out) {
  const env = ctx.ssgEnv;
  if (!env || !ctx.envRegistry) return;
  const spec = ssgEnvSpec(env, env.wholeClocks, clamp(ctx.vel ?? 15, 0, 15), ctx.tempo);
  let name = ctx.envRegistry.get(spec);
  if (!name) { name = `env${ctx.envRegistry.size + 1}`; ctx.envRegistry.set(spec, name); }
  if (name !== ctx.envActive || ctx.verbose) { out.push(name); ctx.envActive = name; } // the def carries :macro :vel*
}

// Write a pending `&` as MMLisp's `~`, just before the note it slurs into.
function flushSlur(ctx, out) {
  if (ctx.pendingSlur) { out.push("~"); ctx.pendingSlur = false; }
}

// The parameters behind one operator register byte (yNN,op,value). `op` is
// the MMLisp operator number: muc88.asm SETREG maps op 2 and 3 to their slot
// offsets, so yTL,2 is the same operator as :tl2.
function opRegTokens(name, opn, val) {
  if (opn < 1 || opn > 4) return null;
  const v = val & 0xff;
  switch (name) {
    case "DM": return `:dt${opn} ${dtFromReg((v >> 4) & 7)} :ml${opn} ${v & 15}`;
    case "TL": return `:tl${opn} ${v & 127}`;
    case "KA": return `:ks${opn} ${v >> 6} :ar${opn} ${v & 31}`;
    case "DR": return `:dr${opn} ${v & 31}`;
    case "SR": return `:sr${opn} ${v & 31}`;
    case "SL": return `:sl${opn} ${v >> 4} :rr${opn} ${v & 15}`;
    case "SE": return `:ssg${opn} ${v & 15}`;
    default: return null;
  }
}

// A raw y<reg>,<value>: the operator registers 0x30-0x9F (slot offsets 0, 4,
// 8, 12 are operators 1, 3, 2, 4) and FB/AL at 0xB0.
function rawRegTokens(reg, val) {
  if (reg >= 0x30 && reg < 0xa0) {
    const names = { 0x30: "DM", 0x40: "TL", 0x50: "KA", 0x60: "DR", 0x70: "SR", 0x80: "SL", 0x90: "SE" };
    const opn = [1, 3, 2, 4][(reg >> 2) & 3];
    return opRegTokens(names[reg & 0xf0], opn, val);
  }
  if ((reg & 0xfc) === 0xb0) return `:fb ${(val >> 3) & 7} :alg ${val & 7}`;
  return null;
}

// Ticks of a length token as lengthToken writes them ("8", "8.", "12t").
function tokenTicks(tok) {
  if (tok == null) return null;
  const t = /^(\d+)t$/.exec(tok);
  if (t) return +t[1];
  const m = /^(\d+)(\.*)$/.exec(tok);
  if (!m) return null;
  let ticks = WHOLE_TICKS / +m[1], add = ticks;
  for (let d = 0; d < m[2].length; d++) { add /= 2; ticks += add; }
  return Number.isInteger(ticks) ? ticks : null;
}

// An FM note under reverb: up to its q point at the note's level, then tied
// on at the driver's reverb level, (v+4 + n) >> 1 on the FMVDAT index — the
// :vol fader takes the difference, 2 dB a step like :vel. Not when the note
// ties on (`&` next): the driver does nothing at its q point then.
function reverbNote(ctx, out, op, next) {
  if (!ctx.reverb || ctx.isSsg || ctx.isPcm || ctx.vel == null || !ctx.qCut || next?.t === "slur") return false;
  const total = tokenTicks(op.len ?? ctx.len);
  const cut = ctx.qCut;
  if (total == null || total <= cut) return false;
  const tailV = ((ctx.vel + 4 + (ctx.reverbAmt ?? 0)) >> 1) - 4;
  const drop = Math.max(0, velToken(ctx.vel, ctx) - velToken(clamp(tailV, 0, 15), ctx));
  if (!drop) return false;
  out.push(noteToken(op.letter, op.acc, `${total - cut}t`, ctx));
  out.push(`~ :vol ${31 - drop}`);
  out.push(noteToken(op.letter, op.acc, `${cut}t`, ctx));
  out.push(":vol 31");
  return true;
}

// How far into its sample a K note plays. The driver stops the ADPCM at the
// note's key-off — its q point, or the next note or rest (music.asm KEYOFF ->
// PCMEND) — where a MMLisp shot plays to the sample's end. So each sample's
// def is cut to the longest stretch the song ever plays of it (in source
// frames: a note above C4 runs through it faster): the drums stop where
// mucom's do, and the bank holds no sound that is never heard. Timed at the
// song's slowest tempo, the safe side.
function pcmNoteUse(ctx, op, continuation) {
  if (!ctx.isPcm || !ctx.pcmUse || ctx.pcmSample == null) return;
  const ticks = tokenTicks(op.len ?? ctx.len);
  if (ticks == null) return;
  if (!continuation || !ctx.pcmCur) {
    const midi = 12 * (ctx.oct + 1) + SEMI[op.letter] + op.acc;
    ctx.pcmCur = { sample: ctx.pcmSample, ticks: 0, ratio: 2 ** ((midi - 60) / 12) };
  }
  const cur = ctx.pcmCur;
  cur.ticks += ticks;
  const sec = (Math.max(1, cur.ticks - (ctx.qCut ?? 0)) * 60) / (ctx.pcmSlowestBpm * 96);
  const frames = Math.ceil(sec * ctx.pcmRate * cur.ratio);
  ctx.pcmUse.set(cur.sample, Math.max(ctx.pcmUse.get(cur.sample) ?? 0, frames));
}

// The :gate- in force: the part's q, or none while FM reverb holds notes on.
function emitGate(ctx, out) {
  const cut = ctx.reverb ? 0 : ctx.qCut ?? 0;
  if (cut !== ctx.gateCut || ctx.verbose) { out.push(`:gate- ${cut}t`); ctx.gateCut = cut; }
}

// A new `D`: write the one `:pitch` that serves every note, or leave it to
// detuneBeforeNote when the cents depend too much on the pitch class.
function detuneChanged(ctx, out) {
  if (ctx.isNoise) return;
  const raw = ctx.detune ?? 0;
  const cents = Array.from({ length: 12 }, (_, pc) => lfoCents(ctx.isSsg, pc, raw));
  ctx.detunePerNote = Math.max(...cents) - Math.min(...cents) > DETUNE_SPREAD_CENTS;
  if (ctx.detunePerNote) return;
  const mean = Math.round(cents.reduce((a, b) => a + b, 0) / 12);
  if (mean !== ctx.pitchOut || ctx.verbose) { out.push(`:pitch ${mean}`); ctx.pitchOut = mean; }
}

function detuneBeforeNote(ctx, out, letter, acc) {
  if (!ctx.detunePerNote || ctx.isPcm || ctx.isNoise) return;
  const shift = (ctx.keyShift?.K ?? 0) + (ctx.keyShift?.k ?? 0);
  const pc = (((SEMI[letter] + acc + shift) % 12) + 12) % 12;
  const cents = Math.round(lfoCents(ctx.isSsg, pc, ctx.detune ?? 0));
  if (cents !== ctx.pitchOut || ctx.verbose) { out.push(`:pitch ${cents}`); ctx.pitchOut = cents; }
}

// mucom velocity -> MMLisp :vel. FM shares MMLisp's 2 dB ladder one-to-one
// (mucom's FMVDAT steps the same); SSG is rescaled from 3 dB steps; K is
// normalized against the song's own loudest drum (ctx.pcmVelMax), so that note
// lands on :vel 15 and the rest keep their dB distance below it. `v` is a linear
// amplitude, :vel is a 2 dB ladder, so the ratio becomes dB and the ladder
// converts it to steps. Still lossy (16 steps), and v0 stays :vel 0.
function velToken(v, ctx) {
  // An SSG `v` is the register value an envelope at full level writes.
  if (ctx.isSsg) return ssgRegVel(v);
  if (!ctx.isPcm) return clamp(v, 0, 15);
  const max = ctx.pcmVelMax || 0;
  if (v <= 0 || max <= 0) return 0;
  const dbBelowLoudest = 20 * Math.log10(max / v);
  return clamp(Math.round(15 - dbBelowLoudest / VEL_DB_PER_STEP), 0, 15);
}

// Bank sample name -> an MMLisp symbol. Real names include "kick+snare",
// "hand clap", "C.Cymbal", "808openhihat" and Shift-JIS half-width katakana.
function sanitizeSampleName(name, index) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return `pcm${index}`;
  return /^[0-9]/.test(base) ? `pcm-${base}` : base;
}

// The .dat bank stores DT as the raw 3-bit register field; the language
// spells it signed (-3..+3).
function dtFromReg(r) {
  return r & 4 ? -(r & 3) : r & 3;
}

// The carriers of each algorithm, by MMLisp operator number.
const ALG_CARRIERS = [[4], [4], [4], [4], [2, 4], [2, 3, 4], [2, 3, 4], [1, 2, 3, 4]];
// mucom never plays a voice's carrier levels: its volume writes every carrier
// TL with one table value, FMVDAT[v+4] (music.asm STVOL/STV2), 2 at v15 and
// about 2 dB a step below — the same ladder as :vel. So a song's voices get
// their carrier TL set to that top value and :vel does the rest; kept as
// stored, a voice with quiet carriers came out up to ~10 dB too soft.
const MUCOM_CARRIER_TL = 2;

function voiceToDef(label, v, { mucomLevels = false } = {}) {
  const parts = [`:alg ${clamp(v.alg, 0, 7)} :fb ${clamp(v.fb, 0, 7)}`];
  const carriers = mucomLevels ? ALG_CARRIERS[clamp(v.alg, 0, 7)] : [];
  for (let op = 0; op < 4; op++) {
    const n = op + 1;
    const o = carriers.includes(n) ? { ...v.ops[op], tl: MUCOM_CARRIER_TL } : v.ops[op];
    parts.push(
      `:ar${n} ${clamp(o.ar, 0, 31)} :dr${n} ${clamp(o.dr, 0, 31)} :sr${n} ${clamp(o.sr, 0, 31)} ` +
      `:rr${n} ${clamp(o.rr, 0, 15)} :sl${n} ${clamp(o.sl, 0, 15)} :tl${n} ${clamp(o.tl, 0, 127)} ` +
      `:ks${n} ${clamp(o.ks, 0, 3)} :ml${n} ${clamp(o.ml, 0, 15)} :dt${n} ${clamp(o.dt, -3, 3)}`,
    );
  }
  const def = `(def-fm @${label}\n  ${parts.join("\n  ")})`;
  const head = (v.comments || []).join("\n");
  return head ? `${head}\n${def}` : def;
}

// Label each voice by its trailing "name" (sanitized to a symbol) if present,
// else by its number; dedupe collisions by suffixing the number.
function buildVoiceLabels(voices) {
  const labels = new Map();
  const used = new Set();
  for (const [num, v] of [...voices.entries()].sort((a, b) => a[0] - b[0])) {
    let label = String(v.name ?? "").trim().replace(/[^\w\-]/g, "");
    if (!label) label = String(num);
    if (used.has(label)) label = `${label}-${num}`;
    used.add(label);
    labels.set(num, label);
  }
  return labels;
}

const qstr = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * Render a parsed mucom song into MMLisp source text.
 * @returns {{ source:string, warnings:string[] }}
 */
export function mucomToMmlisp(parsed) {
  const { meta, tempo, voices, macros, scoreItems, scoreComments, warnings, pcm } = parsed;
  const lines = [];

  // Part K needs its `#pcm` bank to name samples; without one there is nothing
  // to reference, so drop those forms (the song still imports, minus drums).
  // The tempo was already resolved from them at parse time.
  if (!pcm) {
    for (const it of scoreItems) {
      if (it.kind === "form" && it.letter in PCM_PARTS) it.dropped = true;
    }
    if (scoreItems.some((it) => it.dropped)) {
      warnOnce(warnings, "partK", "part K (ADPCM) dropped: no #pcm bank supplied");
    }
  }
  // Part G: the RX5 kit on one PCM track, beside part K's when that plays.
  const kPlays = scoreItems.some((it) => it.kind === "form" && it.letter in PCM_PARTS && !it.dropped);
  const rhythmForms = scoreItems.filter((it) => it.kind === "form" && it.letter === RHYTHM_PART);
  const layers = rhythmForms.length ? rhythmLayers(rhythmForms, warnings) : [];
  const rhythmPlays = layers.some(Boolean);
  // Each G line becomes its layers' forms, in RHYTHM_SOUNDS order; a layer's
  // first form names its sample and sets its ring as the :gate.
  for (const [i, f] of rhythmForms.entries()) {
    const copies = [];
    layers.forEach((per, k) => {
      if (!per) return;
      const s = RHYTHM_SOUNDS[k];
      const head = i === 0
        ? [{ t: "raw", text: `${s.name} :gate ${Math.max(1, Math.round((s.ringMs / 1000) * ((tempo ?? 120) / 60) * PPQN))}t` }]
        : [];
      copies.push({ kind: "form", letter: f.letter, key: `${f.letter}~${s.name}`, ch: kPlays ? "pcm2" : "pcm1", prio: s.prio, ops: [...head, ...per[i]], comment: copies.length ? null : f.comment });
    });
    scoreItems.splice(scoreItems.indexOf(f), 1, ...copies);
  }

  // @n (1-based) -> the sample def it selects, deduped into pcmRegistry as it is
  // referenced so unused bank entries never reach the output (a bank holds up to
  // 32, a song typically plays a handful) — the rule mergeDatVoices uses.
  const pcmEntries = new Map();
  const pcmRegistry = new Map();
  const pcmUse = new Map(); // @n -> the most source frames a K note plays (pcmNoteUse)
  const slowest = (ops) => ops.reduce((m, op) => Math.min(m, op.t === "tempo" && op.bpm ? op.bpm : op.t === "loop" ? slowest(op.body) : Infinity), Infinity);
  const pcmSlowestBpm = Math.min(tempo ?? 120, ...scoreItems.filter((it) => it.kind === "form").map((it) => slowest(it.ops)));
  if (pcm) {
    const used = new Set([...voices.keys()].map((n) => `@${n}`));
    for (const e of pcm.entries) {
      let label = sanitizeSampleName(e.name, e.index);
      while (used.has(label)) label = `${label}-${e.index}`; // share one namespace with voices/*n
      used.add(label);
      pcmEntries.set(e.index, { ...e, label });
    }
  }
  const definedVoices = new Set(voices.keys());
  const warnedVoices = new Set();
  const macroOps = new Map([...(macros || new Map())].map(([n, m]) => [n, m.ops]));
  const voiceAlgs = new Map([...voices].map(([n, v]) => [n, clamp(v.alg, 0, 7)]));
  const voiceAlgByName = new Map([...voices].filter(([, v]) => v.name).map(([, v]) => [v.name, clamp(v.alg, 0, 7)]));
  const voiceLabels = buildVoiceLabels(voices);
  // name -> label, for @"name" voice selection (inline voices only)
  const voiceByName = new Map();
  for (const [num, v] of voices) if (v.name) voiceByName.set(v.name, voiceLabels.get(num));

  for (const [num, v] of [...voices.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push("", voiceToDef(voiceLabels.get(num), v, { mucomLevels: true }));
  }

  // Distinct software-LFO specs collected during rendering -> emitted as
  // (def lfoN :macro :pitch+ …) above the score, referenced by name.
  const lfoRegistry = new Map();
  const envRegistry = new Map(); // distinct SSG soft envelopes -> (def envN :macro :vel …)
  const echoRegistry = new Map(); // distinct echoes -> (def ecN (echo …)), referenced by name

  // A macro renders once into (def *n …), so a macro reached from part K must
  // render with the PCM ctx — there its `@n` selects a bank sample, not an FM
  // voice, and `v` runs 0-255. mucom songs never share a macro between K and
  // another part, so one ctx per macro is unambiguous.
  const pcmMacros = new Set();
  if (pcm) {
    const scan = (ops) => {
      for (const op of ops) {
        if (op.t === "macroCall") pcmMacros.add(op.n);
        else if (op.t === "loop") scan(op.body);
      }
    };
    for (const it of scoreItems) {
      if (it.kind === "form" && it.letter in PCM_PARTS && !it.dropped) scan(it.ops);
    }
  }

  // The loudest `v` anywhere K can reach — its own forms plus the macros it
  // calls, since a drum's volume is often set inside the macro. velToken scales
  // every K note against this so the loudest lands on :vel 15.
  // mucom's `(`/`)` nudge the volume relative to wherever it already is, so this
  // has to walk the same state renderOps does — reading a velAdj as an absolute
  // level would invent a loudest drum that the song never plays. State flows
  // across a letter's forms (and through loops, whose body is emitted once), and
  // a macro starts fresh, exactly as when it is rendered.
  const pcmVelMax = (() => {
    let max = 0;
    const scan = (ops, st) => {
      for (const op of ops) {
        if (op.t === "vel") st.v = op.v;
        else if (op.t === "velAdj") st.v = clamp((st.v ?? MUCOM_PCM_VEL_DEFAULT) + op.d, 0, MUCOM_PCM_VEL_MAX);
        else if (op.t === "loop") { scan(op.body, st); continue; }
        else continue;
        max = Math.max(max, st.v);
      }
    };
    const st = { v: null };
    for (const it of scoreItems) {
      if (it.kind === "form" && it.letter in PCM_PARTS && !it.dropped) scan(it.ops, st);
    }
    for (const [mn, mac] of macros || new Map()) if (pcmMacros.has(mn)) scan(mac.ops, { v: null });
    return max;
  })();

  // Macros become (def *n …); only those with supported content are kept.
  const usableMacros = new Set();
  for (const [mn, mac] of [...(macros || new Map()).entries()].sort((a, b) => a[0] - b[0])) {
    const toks = [];
    // No lfoRegistry here: a `*n` body can't reference another def (:macro lfoN),
    // so its LFO renders inline. The *n def is already singular, so no duplication.
    // No lfo/env/echo registries here (see above); PCM is different — a K macro
    // must resolve its @n against the bank, and a sample def IS referencable
    // from a macro body by name.
    const isPcm = pcmMacros.has(mn);
    renderOps(mac.ops, { vel: null, isPcm, octShift: -1, pcmEntries, pcmRegistry, pcmVelMax, hasGlobalLoop: false, definedVoices, voiceLabels, voiceByName, usableMacros, warnedVoices, warnings }, toks);
    const content = toks.join(" ").trim();
    if (!content) continue;
    usableMacros.add(mn);
    const head = (mac.comments || []).join("\n");
    lines.push("", (head ? head + "\n" : "") + `(def *${mn} ${content})`);
  }

  // They go in (def-score …); the tempo (score-global) rides the first
  // playable form below.
  // #title / #composer / #author map one to one.
  const metaDefs = [];
  const score = [meta.title && `:title ${qstr(meta.title)}`, meta.composer && `:composer ${qstr(meta.composer)}`,
    meta.author && `:author ${qstr(meta.author)}`].filter(Boolean);
  if (score.length) metaDefs.push(`(def-score ${score.join(" ")})`);
  if (rhythmPlays) {
    if (kPlays) metaDefs.push("; Part G's drums play beside part K's samples: two PCM voices.", "(def-score :pcm-voices 2)");
    metaDefs.push(`(import ${qstr(RHYTHM_KIT)})  ; part G (the OPNA rhythm) on the RX5 kit`);
  }
  // LFO defs (if any) are spliced in here once rendering has discovered them.
  const lfoDefAnchor = lines.length;
  lines.push("");
  for (const c of scoreComments || []) lines.push(c);
  lines.push(...metaDefs);

  // Each part line becomes one (chN …) form; they merge per channel, so the
  // author's line order can be preserved verbatim. State (octave/vel/detune)
  // flows per letter via a ctx kept across that part's lines.
  // Keyed by part letter, or letter + "~noise" for an SSG part's noise copy.
  const ctxByLetter = new Map();
  const letterCtx = (key) => {
    const letter = key[0];
    if (!ctxByLetter.has(key)) {
      const pcmPart = letter in PCM_PARTS || letter === RHYTHM_PART;
      ctxByLetter.set(key, { pcmUse, pcmDrop: parsed.pcmDrop, pcmRate: pcm?.rate, pcmSlowestBpm, isNoise: key.endsWith("~noise"), vel: null, detune: 0, tempo, macroOps, voiceAlgs, voiceAlgByName, oct: pcmPart ? MUCOM_PCM_DEFAULT_OCT : MUCOM_DEFAULT_OCT + octShiftFor(letter), len: null, isSsg: letter in SSG_PARTS, isPcm: pcmPart, octShift: octShiftFor(letter), hasGlobalLoop: false, definedVoices, voiceLabels, voiceByName, usableMacros, warnedVoices, warnings, lfoRegistry, envRegistry, echoRegistry, pcmEntries, pcmRegistry, pcmVelMax });
    }
    return ctxByLetter.get(key);
  };

  // An SSG part that turns its noise on (P2/P3, or a hi-hat preset) gets a
  // noise copy: every form again, on the noise channel, right after the
  // original. Each copy plays only the notes made with noise on (mutedHere).
  const usesNoise = (ops, seen = new Set()) => ops.some((op) =>
    (op.t === "mix" && op.v & 2) ||
    (op.t === "loop" && usesNoise(op.body, seen)) ||
    (op.t === "macroCall" && !seen.has(op.n) && macroOps.has(op.n) && (seen.add(op.n), usesNoise(macroOps.get(op.n), seen))));
  // The PSG has one noise channel and :prio layers cannot hold the parts'
  // counted loops, so the first part to use noise gets it; the others' noise
  // notes are dropped.
  const noiseLetters = Object.keys(SSG_PARTS).filter((l) =>
    scoreItems.some((it) => it.kind === "form" && it.letter === l && usesNoise(it.ops)));
  if (noiseLetters.length > 1) {
    warnings.push(`parts ${noiseLetters.join(", ")} all use SSG noise; the PSG has one noise channel, so only part ${noiseLetters[0]}'s noise is kept`);
  }
  const noiseLetter = noiseLetters[0];
  if (noiseLetter) {
    for (let k = scoreItems.length - 1; k >= 0; k--) {
      const it = scoreItems[k];
      if (it.kind !== "form" || it.letter !== noiseLetter) continue;
      scoreItems.splice(k + 1, 0, { kind: "form", letter: it.letter, key: `${it.letter}~noise`, ch: "noise", ops: it.ops, comment: null });
    }
  }

  const forms = scoreItems.filter((it) => it.kind === "form" && !it.dropped);
  const keyOf = (f) => f.key ?? f.letter;

  // Octave base per letter: mucom default o6 (= :oct 5 after the -1 shift),
  // unless that part opens with an absolute `o`.
  const allOpsByLetter = new Map();
  for (const f of forms) {
    const a = allOpsByLetter.get(f.letter) || [];
    a.push(...f.ops);
    allOpsByLetter.set(f.letter, a);
  }

  // Loops across lines, as trees: label -> the ops between its #label and its
  // (go) over every line of the part, inner ones nested as loop ops.
  const crossTrees = new Map();
  for (const key of new Set(forms.map(keyOf))) {
    const stack = [];
    for (const f of forms) {
      if (keyOf(f) !== key) continue;
      for (const op of f.ops) {
        if (op.t === "loopMarker") { stack.push({ label: op.label, items: [] }); continue; }
        if (op.t === "loopGo" && stack.length) {
          const top = stack.pop();
          crossTrees.set(top.label, top.items);
          if (stack.length) stack.at(-1).items.push({ t: "loop", count: op.count, body: top.items });
          continue;
        }
        if (stack.length) stack.at(-1).items.push(op);
      }
    }
  }

  // How many L each part has: the last one is its loop point.
  const loopMarks = new Map();
  const countL = (ops) => ops.reduce((n, op) => n + (op.t === "globalLoop" ? 1 : op.t === "loop" ? countL(op.body) : 0), 0);
  for (const f of forms) loopMarks.set(keyOf(f), (loopMarks.get(keyOf(f)) ?? 0) + countL(f.ops));

  // Render in source order so per-letter state flows correctly. A second
  // render writes out the loops across lines the first found to vary.
  const unrollCross = new Set();
  for (let phase = 0; phase < 2; phase++) {
    const found = new Set();
    ctxByLetter.clear();
    lfoRegistry.clear();
    envRegistry.clear();
    echoRegistry.clear();
    // Token arrays are joined only once every form is rendered: a level
    // chain (finishChain) patches tokens it wrote lines earlier.
    const lastToks = new Map();
    for (const f of forms) {
      const ctx = letterCtx(keyOf(f));
      if (ctx.loopMarksLeft == null) ctx.loopMarksLeft = loopMarks.get(keyOf(f)) ?? 0;
      Object.assign(ctx, { crossTrees, unrollCross, newUnrollCross: found });
      f.toks = [];
      renderOps(f.ops, ctx, f.toks);
      lastToks.set(keyOf(f), f.toks);
    }
    for (const [key, toks] of lastToks) finishChain(letterCtx(key), toks);
    for (const f of forms) { f.text = f.toks.join(" "); delete f.toks; }
    if (!found.size) break;
    for (const l of found) unrollCross.add(l);
  }

  // Per channel: the octave base on the first playable form, (go loop) on the
  // last for a part with an L (its #loop is emitted inline, at the last L).
  const firstForm = new Map();
  const lastForm = new Map();
  for (const f of forms) {
    if (f.text === "") continue;
    if (!firstForm.has(keyOf(f))) firstForm.set(keyOf(f), f);
    lastForm.set(keyOf(f), f);
  }
  for (const [key, f] of firstForm) {
    const letter = key[0];
    const prefix = [];
    // mucom default octave is o6; FM drops one (-> :oct 5), SSG/PSG keeps it; PCM
    // uses a native-reference default (see MUCOM_PCM_DEFAULT_OCT) instead of the
    // saturating :oct 9.
    if (!startsWithAbsoluteOctave(allOpsByLetter.get(letter) || [])) {
      const defOct = letter in PCM_PARTS || letter === RHYTHM_PART ? MUCOM_PCM_DEFAULT_OCT : MUCOM_DEFAULT_OCT + octShiftFor(letter);
      prefix.push(`:oct ${defOct}`);
    }
    if (prefix.length) f.text = `${prefix.join(" ")} ${f.text}`.trim();
  }
  // A part loops back to its L; one without L plays once and stops — its data
  // ends with no loop address (music.asm FMSUB1 -> FMEND).
  for (const [key, f] of lastForm) if (letterCtx(key).hasGlobalLoop) f.text = `${f.text} (go loop)`.trim();

  // Emit the discovered LFO / envelope / echo / PCM defs above the score (by name).
  if (lfoRegistry.size || envRegistry.size || echoRegistry.size || pcmRegistry.size) {
    const defLines = [];
    for (const [spec, name] of lfoRegistry) defLines.push("", `(def ${name} (macro ${spec}))`);
    for (const [spec, name] of envRegistry) defLines.push("", `(def ${name} (macro ${spec}))`);
    for (const [form, name] of echoRegistry) defLines.push("", `(def ${name} (echo ${form}))`);
    // Each referenced bank sample slices the one WAV the bank decoded to.
    for (const [, e] of [...pcmRegistry].sort((a, b) => a[0] - b[0])) {
      defLines.push(
        "",
        `(def-pcm ${e.label} :file ${qstr(pcm.wavFile)} :rate ${pcm.rate} :offset ${e.offset} :frames ${Math.min(e.frames, pcmUse.get(e.index) ?? e.frames)})`,
      );
    }
    lines.splice(lfoDefAnchor, 0, ...defLines);
  }

  // On the Mega Drive fm6 IS the DAC a PCM score plays through, so a song that
  // uses both part J and ADPCM drums cannot keep both (E_FM6_DAC). The drums
  // stay and J is kept as written but commented out, for the user to move to
  // a free channel or to trade against the drums.
  const pcmPlays = forms.some((f) => (f.letter in PCM_PARTS || f.letter === RHYTHM_PART) && f.text !== "");
  const fm6Forms = forms.filter((f) => f.ch === "fm6" && f.text !== "");
  if (pcmPlays && fm6Forms.length) {
    for (const f of fm6Forms) f.commentOut = true;
    warnings.push("part J (fm6) is commented out: fm6 is the DAC while the PCM drums play — move it to a free fm channel, or drop the drums, to hear it");
  }

  // Tempo rides the very first playable form (before its #loop/:oct prefix it
  // would also be fine — :tempo is score-global wherever it appears).
  const firstPlayable = scoreItems.find(
    (it) => it.kind === "form" && !it.dropped && !it.commentOut && it.text !== "",
  );
  if (firstPlayable) {
    firstPlayable.text = `:tempo ${tempo ?? 120} ${firstPlayable.text}`.trim();
  }

  // Emit forms and in-music comments verbatim, in source order (top level —
  // there is no wrapper to indent under).
  for (const it of scoreItems) {
    if (it.kind === "comment") { lines.push(it.text); continue; }
    if (it.dropped) continue; // parsed for tempo only (part K with no #pcm bank)
    if (it.text === "") { if (it.comment) lines.push(it.comment); continue; }
    const form = `(${it.ch}${it.prio != null ? ` :prio ${it.prio}` : ""} ${it.text})${it.comment ? `  ${it.comment}` : ""}`;
    lines.push(it.commentOut ? `; ${form}` : form);
  }

  lines.push("");
  return { source: lines.join("\n").replace(/^\n+/, ""), warnings, pcmVoices: rhythmPlays && kPlays ? 2 : 1, rhythm: rhythmPlays };
}

// --- external voice bank (.dat) --------------------------------------------

// Parse a mucom `.dat` voice bank: 256 voices x 32 bytes (see voiceformat.h).
// Each record is hed(1) + 6 param groups x 4 ops + FB/AL(1) + name(6). The four
// op bytes per group are in YM2608 slot order op1,op3,op2,op4. Returns
// Map<index, { fb, alg, ops:[{ar,dr,sr,rr,sl,tl,ks,ml,dt}x4], name }>.
export function parseVoiceDat(bytes) {
  const REC = 32;
  const voices = new Map();
  const slot = { 1: 0, 2: 2, 3: 1, 4: 3 }; // MMLisp op n -> byte position in a group
  const at = (i) => bytes[i] & 0xff;
  for (let v = 0; (v + 1) * REC <= bytes.length; v++) {
    const o = v * REC;
    let empty = true;
    for (let k = 0; k < REC; k++) if (at(o + k) !== 0) { empty = false; break; }
    if (empty) continue;
    const grp = (g) => [at(o + 1 + g * 4), at(o + 1 + g * 4 + 1), at(o + 1 + g * 4 + 2), at(o + 1 + g * 4 + 3)];
    const dtml = grp(0), tl = grp(1), ksar = grp(2), amdr = grp(3), sr = grp(4), slrr = grp(5);
    const fbal = at(o + 25);
    const ops = [];
    for (let n = 1; n <= 4; n++) {
      const p = slot[n];
      ops.push({
        ar: ksar[p] & 0x1f, dr: amdr[p] & 0x1f, sr: sr[p] & 0x1f, rr: slrr[p] & 0x0f,
        sl: (slrr[p] >> 4) & 0x0f, tl: tl[p] & 0x7f, ks: (ksar[p] >> 6) & 0x03,
        ml: dtml[p] & 0x0f, dt: dtFromReg((dtml[p] >> 4) & 0x07),
      });
    }
    // Names are Shift-JIS single bytes: ASCII, or half-width katakana
    // (0xA1-0xDF -> U+FF61-U+FF9F) as in @"ﾎﾟｰﾗﾍﾞ" — what decodeMucText makes of
    // the same bytes in the song, so @"name" resolves.
    let name = "";
    for (let k = 26; k < 32; k++) {
      const ch = at(o + k);
      if (ch >= 0x20 && ch < 0x7f) name += String.fromCharCode(ch);
      else if (ch >= 0xa1 && ch <= 0xdf) name += String.fromCharCode(0xff61 + ch - 0xa1);
    }
    voices.set(v, { fb: (fbal >> 3) & 0x07, alg: fbal & 0x07, ops, name: name.trim() || null });
  }
  return voices;
}

// Pull the voices a song actually references (by @n or @"name") out of a parsed
// .dat bank and add them to `parsed.voices`, so their (def-fm @name …) get emitted
// and @"name"/@n resolve. Only referenced voices are added (a bank has 256).
function mergeDatVoices(parsed, datVoices) {
  const refNums = new Set(), refNames = new Set();
  const scan = (ops) => {
    for (const op of ops) {
      if (op.t === "voice") refNums.add(op.n);
      else if (op.t === "voiceByName") refNames.add(op.name);
      else if (op.t === "loop") scan(op.body);
    }
  };
  for (const it of parsed.scoreItems) if (it.kind === "form") scan(it.ops);
  for (const mac of parsed.macros.values()) scan(mac.ops);
  const byName = new Map();
  for (const [num, v] of datVoices) if (v.name) byName.set(v.name, num);
  const add = (num) => { if (num != null && datVoices.has(num) && !parsed.voices.has(num)) parsed.voices.set(num, datVoices.get(num)); };
  for (const num of refNums) add(num);
  for (const name of refNames) add(byName.get(name));
}

/**
 * Convenience: bytes -> { source, warnings }. Pass the referenced `.dat` voice
 * bank (Uint8Array) as `datBytes` to resolve external @"name"/@n voices, and the
 * `#pcm` ADPCM bank (`*pcm.bin`) as `pcmBytes` to import part K — without it
 * K is dropped, since its `@n` would have no samples to name.
 */
export function importMucom(bytes, datBytes = null, pcmBytes = null) {
  const pcm = pcmBytes ? decodeMucomPcmForImport(parseMucom(decodeMucText(bytes)).meta.pcmFile, pcmBytes) : null;
  // A fresh parse per render: rendering adds the noise copies to scoreItems.
  const render = (pcmDrop) => {
    const parsed = parseMucom(decodeMucText(bytes));
    if (datBytes) mergeDatVoices(parsed, parseVoiceDat(datBytes));
    if (pcm) Object.assign(parsed, { pcm, pcmDrop });
    return mucomToMmlisp(parsed);
  };
  const out = pcm ? fitPcmBank(render, pcm) : render(null);
  // `pcm` rides along so the caller can save `wav` as `wavFile` beside the score
  // (what the emitted defs reference) and play `mono` before it exists on disk.
  return pcm ? { ...out, pcm } : out;
}

// The samples the score plays bake one blob per sample and pitch, at the rate
// of the engine image the voice count picks; past one 32 KB bank encodeMmb
// goes multi-bank on its own (docs/pcm-multibank.md). What can still fail is
// one blob longer than a bank holds (32,512 bytes) — a long sample at a low
// pitch — so the import bakes here and takes the first voice count whose rate
// fits every blob. When none does, the sample costing the most bytes is
// dropped (its notes become rests) and the search starts over. Said in
// warnings and a comment.
function fitPcmBank(render, pcm) {
  // Part G's kit stands in as silence of its samples' lengths: it costs the
  // bank the same.
  const kit = new Map([[RHYTHM_KIT, RHYTHM_SOUNDS.map((s) => `(def-pcm ${s.name} :file "${s.name}.wav")`).join("\n")]]);
  const kitData = new Map(RHYTHM_SOUNDS.map((s) => [s.name, new Float32Array(Math.round((s.ms / 1000) * RHYTHM_KIT_RATE))]));
  const bake = (source) => {
    const { ir, diagnostics } = compileMMLisp(source, "import.mmlisp", { imports: kit, frameHz: 60 });
    if (diagnostics.some((d) => d.severity === "error")) return { ok: true }; // not ours to judge here
    const samples = {};
    for (const def of ir.metadata?.samples ?? []) {
      if (kitData.has(def.name) && !def.offset && def.frames == null) {
        samples[def.name] = { data: kitData.get(def.name), baseRate: RHYTHM_KIT_RATE };
        continue;
      }
      const at = def.offset ?? 0;
      samples[def.name] = { data: pcm.mono.slice(at, at + (def.frames ?? pcm.mono.length - at)), baseRate: pcm.rate };
    }
    try {
      encodeMmb(ir, { samples, dedup: false }); // does the bank fit
      return { ok: true };
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return { ok: false, ir };
    }
  };
  // Bytes a def bakes to: its frames per distinct pitch played, resampled.
  const costliest = (ir) => {
    const pitches = new Map();
    for (const t of ir.tracks ?? []) for (const e of t.events ?? []) {
      if (e.cmd !== "PCM_NOTE_ON") continue;
      if (!pitches.has(e.args.sample)) pitches.set(e.args.sample, new Set());
      pitches.get(e.args.sample).add(e.args.pitch);
    }
    let worst = null;
    for (const def of ir.metadata?.samples ?? []) {
      const ps = pitches.get(def.name);
      if (!ps) continue;
      let bytes = 0;
      for (const p of ps) bytes += (def.frames ?? 0) / 2 ** ((pitchToMidi(p) - 60) / 12);
      if (!worst || bytes > worst.bytes) worst = { name: def.name, bytes };
    }
    return worst?.name;
  };
  const drop = new Set(); // sample labels
  for (;;) {
    const out = render(drop);
    let last = null;
    for (const n of [1, 2, 3].filter((n) => n >= out.pcmVoices)) {
      const source = n === out.pcmVoices ? out.source
        : `; A PCM sample fits one bank (32,512 bytes) at ${n} PCM voices' rate, not at ${out.pcmVoices}'s.\n(def-score :pcm-voices ${n})\n\n${out.source.replace(/^; Part G's drums.*\n\(def-score :pcm-voices 2\)\n/m, "")}`;
      const r = bake(source);
      if (r.ok) {
        if (n > out.pcmVoices) out.warnings.push(`PCM: a sample is longer than one bank (32,512 bytes) at ${out.pcmVoices} voice's rate; set (def-score :pcm-voices ${n}) to bake it at the lower rate`);
        if (drop.size) out.warnings.push(`PCM: ${[...drop].join(", ")} is longer than one bank (32,512 bytes) at every rate; dropped — its notes are rests`);
        return { ...out, source };
      }
      last = r.ir;
    }
    const worst = last && costliest(last);
    if (!worst || drop.has(worst)) {
      out.warnings.push("PCM: a sample is longer than one bank (32,512 bytes) even at 3 voices' rate; shorten it (:frames)");
      return out;
    }
    drop.add(worst);
  }
}

/**
 * Decode the `#pcm` bank into the shape mucomToMmlisp emits defs from. The bank
 * becomes ONE wav (MMLisp reads one sample per file, so the defs slice it by
 * `:offset`/`:frames`); the caller is responsible for saving those bytes next to
 * the score under `wavFile`.
 *
 * @returns {{ entries:Array<object>, wavFile:string, rate:number,
 *   wav:Uint8Array, mono:Float32Array }}
 */
function decodeMucomPcmForImport(pcmFile, pcmBytes) {
  const { pcm, sampleRate, entries } = decodeMucomPcmBank(pcmBytes);
  const base = String(pcmFile || "mucompcm.bin").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return {
    entries,
    wavFile: `${base}.wav`,
    rate: sampleRate,
    wav: encodeWav(pcm, null, sampleRate),
    mono: pcm,
  };
}

/**
 * Convert a standalone `.dat` voice bank into MMLisp `(def-fm @name …)` defs — a
 * voice library, no song needed. Unnamed/empty slots are skipped.
 * @returns {{ source:string, warnings:string[] }}
 */
export function voiceBankToMmlisp(datBytes) {
  const named = new Map([...parseVoiceDat(datBytes)].filter(([, v]) => v.name));
  const labels = buildVoiceLabels(named);
  const lines = [`; mucom88 voice bank — ${named.size} voices`];
  for (const [num, v] of [...named.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push("", voiceToDef(labels.get(num), v));
  }
  return { source: lines.join("\n") + "\n", warnings: named.size ? [] : ["no named voices in this bank"] };
}

/**
 * Convert a standalone `*pcm.bin` ADPCM bank into a sample library — the drum
 * kit on its own, no song needed (the `.dat` counterpart above). The bank is
 * decoded to one wav that every def slices, so the caller must save `pcm.wav`
 * as `pcm.wavFile` next to the score.
 *
 * @param {Uint8Array} pcmBytes
 * @param {string} [bankName] the .bin's filename, used to name the wav
 * @returns {{ source:string, warnings:string[], pcm:object }}
 */
export function pcmBankToMmlisp(pcmBytes, bankName = "mucompcm.bin") {
  const pcm = decodeMucomPcmForImport(bankName, pcmBytes);
  const used = new Set();
  const lines = [`; mucom88 PCM bank — ${pcm.entries.length} samples @ ${pcm.rate} Hz`];
  for (const e of pcm.entries) {
    let label = sanitizeSampleName(e.name, e.index);
    while (used.has(label)) label = `${label}-${e.index}`;
    used.add(label);
    lines.push(
      "",
      `(def-pcm ${label} :file ${qstr(pcm.wavFile)} :rate ${pcm.rate} :offset ${e.offset} :frames ${e.frames})`,
    );
  }
  return {
    source: lines.join("\n") + "\n",
    warnings: pcm.entries.length ? [] : ["no samples in this bank"],
    pcm,
  };
}
