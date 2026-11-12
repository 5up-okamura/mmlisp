// Lengths and time: ticks (PPQN), frames on the compile's clock, ms, a
// length token, a gate, a step; the note stream's tokens (a note, a rest,
// a per-note length, an octave or velocity shift) and a MIDI note's name.

import { FRAME_HZ_NTSC } from "../../ir/timing.js";
import { pushDiag, atomValue, nodeSrc } from "./diag.js";
import { evalLengthValue, isEvalHead, evalScalarValue } from "../mmlisp-eval.js";

// 96 ticks/quarter (384/whole). Divisible by both MMLisp's note fractions and
// mucom's default 128-clock/whole grid (LCM 384), so imported 128th notes land
// on exact ticks instead of rounding (1/128 whole = 3 ticks, not 1.5).
export const PPQN = 96;
export const WHOLE_TICKS = PPQN * 4;

// The frame clock this compile targets (driver.md §3.3). It is one number for
// the whole compile — every `Nf` in the source means that many frames of THIS
// clock — so it is a compile-scoped constant rather than a parameter threaded
// through the eighteen call sites of parseLengthToken. compileMMLisp sets it
// on entry and restores it on the way out; compiling is synchronous and does
// not recurse (an import only collects defs), so no two targets are ever live
// at once. Authoring is NTSC; PAL is an export target.
let compileFrameHz = FRAME_HZ_NTSC;
// compileMMLisp's way in: the clock to count `Nf` in, the one before returned.
export function setCompileFrameHz(hz) {
  const prev = compileFrameHz;
  compileFrameHz = hz;
  return prev;
}

// Convert an Nf frame count (wall-clock, 1/compileFrameHz s) to musical ticks
// at `bpm`. Used where a duration advances the tick timeline (note length,
// :gate, ~, rest). The conversion uses the tempo active at compile time, so
// under a runtime tempo change an Nf note scales with tempo like any tick
// duration.
export function framesToTicks(frames, bpm) {
  if (frames === 0) return 0; // 0f = hold, mirroring plain 0
  return Math.max(1, Math.round((frames * bpm * PPQN) / (compileFrameHz * 60)));
}

function msToTicks(ms, bpm) {
  if (ms === 0) return 0; // 0ms = hold, mirroring plain 0
  return Math.max(1, Math.round((ms * bpm * PPQN) / 60000));
}

// An `Nms` on the frame clock: where a length is a frame count (curve `:len`,
// `:wait`, `:hold`, `(wait …)`, macro `:step`), a millisecond duration is the
// nearest whole frame, so it keeps its wall-clock length at any tempo.
function msToFrames(ms) {
  if (ms === 0) return 0;
  return Math.max(1, Math.round((ms * compileFrameHz) / 1000));
}

// `Nf` and `Nms` — the tokens that are a frame count outside a structural
// position (parseLengthToken with no tempo).
export const isFrameToken = (v) => /^\d+(f|ms)$/.test(String(v));

// A length token as an absolute duration in SECONDS, without the detour through
// ticks. The PCM range needs this: a tick is 5.2 ms at 120 BPM, so
// resolving `1ms` to ticks would round it away, while the engine can place a
// loop 1.11 ms long (one 16-byte block at pcm1 — driver.md §5).
export function lengthTokenSeconds(token, bpm = 120) {
  if (typeof token !== "string") return null;
  if (/^\d+ms$/.test(token)) return parseInt(token, 10) / 1000;
  if (/^\d+f$/.test(token)) return parseInt(token, 10) / compileFrameHz;
  const ticks = parseLengthToken(token, null, bpm);
  if (ticks === null || !Number.isFinite(ticks)) return null;
  return (ticks * 60) / ((bpm || 120) * PPQN);
}

// Inverse of framesToTicks: a tick duration → a frame count at `bpm`, on the
// clock this compile targets.
function ticksToFrames(ticks, bpm) {
  if (!ticks) return ticks;
  return Math.max(1, Math.round((ticks * compileFrameHz * 60) / (bpm * PPQN)));
}

// Resolve a macro spec's `:len`/`:wait` to the macro's clock at the note's
// tempo. A frame `:step` (the default) clocks the macro on 60 Hz frames, so
// every length becomes an absolute frame count (`lenFrames`). A tick `:step`
// stays ticks: the driver then counts the note's track ticks (driver.md
// §13.2), so the steps land on the beat, and every length becomes ticks.
// Returns a copy; the shared def spec is left untouched.
export function resolveMacroLen(spec, bpm) {
  if (!spec || typeof spec !== "object" || bpm == null) return { ...spec };
  const out = { ...spec };
  const ticks = out.step?.unit === "tick";
  const len = (n, isFrames) =>
    ticks ? (isFrames ? framesToTicks(n, bpm) : n) : isFrames ? n : ticksToFrames(n, bpm);
  const resolve = (o) => {
    resolveCurveHold(o, bpm);
    if (o.frames != null && (o.type === "curve" || o.curve)) {
      o.frames = len(o.frames, !!o.lenFrames);
      o.lenFrames = !ticks;
    }
    // `:wait N` is a pre-delay (docs §11): one unit, so the MMB exporter can
    // lower it to hold steps.
    if (ticks) {
      if (o.waitTicks == null && o.waitFrames != null) o.waitTicks = framesToTicks(o.waitFrames, bpm);
      delete o.waitFrames;
    } else if (o.waitTicks != null && o.waitFrames == null) {
      o.waitFrames = ticksToFrames(o.waitTicks, bpm);
    }
    return o;
  };
  if (out.type === "curve") resolve(out);
  else if (out.type === "stages") out.stages = (out.stages ?? []).map((st) => resolve({ ...st }));
  return out;
}

// `bpm` gives a structural context (note length / gate / tie / rest): there an
// `Nf` or `Nms` token is converted to ticks at the active tempo. When `bpm` is
// null (curve `:len` context) both return a frame count, which the caller
// pairs with a `lenFrames` flag (isFrameToken) the player honors natively.
export function parseLengthToken(value, inheritedTicks, bpm = null) {
  if (!value) return inheritedTicks;
  // Tick count: "14t" — exact tick value
  if (/^\d+t$/.test(value)) {
    return parseInt(value, 10);
  }
  // Frame count: "16f" — 60 Hz update intervals.
  if (/^\d+f$/.test(value)) {
    const frames = parseInt(value, 10);
    return bpm != null ? framesToTicks(frames, bpm) : frames;
  }
  // Milliseconds: "300ms" — an absolute duration, tempo-independent, and the
  // only length token finer than a tick (one tick is 5.2 ms at 120 BPM). Like
  // Nf, in a structural context it converts to ticks at the tempo in force,
  // and elsewhere it is a frame count.
  if (/^\d+ms$/.test(value)) {
    const ms = parseInt(value, 10);
    return bpm != null ? msToTicks(ms, bpm) : msToFrames(ms);
  }
  // Fraction: "1/2", "3/4"
  if (/^\d+\/\d+$/.test(value)) {
    const [n, d] = value.split("/").map((v) => parseInt(v, 10));
    return Math.round((WHOLE_TICKS * n) / d);
  }
  // Dotted integer: "4." = 1.5 × quarter, "8." = 1.5 × eighth, etc.
  if (/^\d+\.$/.test(value)) {
    const d = parseInt(value, 10);
    return Math.round((WHOLE_TICKS * 3) / (d * 2));
  }
  // Plain integer note-length denominator: "4" = quarter, "8" = eighth, etc.
  // Special: "0" = hold note (len=0, KEY-OFF driven by runtime)
  if (/^\d+$/.test(value)) {
    const d = parseInt(value, 10);
    if (d === 0) return 0;
    return Math.round(WHOLE_TICKS / d);
  }
  return inheritedTicks;
}

// Parse a :step token into an explicit { unit, value }. parseLengthToken
// collapses "16f" (frames) and "1/4"/"14t" (ticks) into a bare number, losing
// the unit the player needs to schedule each kind correctly.
export function parseStepToken(value) {
  if (typeof value !== "string") return null;
  if (isFrameToken(value)) {
    const n = parseLengthToken(value, null);
    return n > 0 ? { unit: "frame", value: n } : null;
  }
  if (/^\d+t$/.test(value)) {
    const n = parseInt(value, 10);
    return n > 0 ? { unit: "tick", value: n } : null;
  }
  const ticks = parseLengthToken(value, null);
  if (ticks === null || ticks <= 0) return null;
  return { unit: "tick", value: ticks };
}

// Returns true if val is a rest token: "_", "_4", "_4.", "_14t", "_16f", "_1/2"
export function isRestAtom(val) {
  if (val === "_") return true;
  return parseRestLength(val, null) !== null;
}

// Parse the length of a rest token; the leading "_" is stripped before parsing.
export function parseRestLength(val, inheritedTicks, bpm = null) {
  if (typeof val !== "string" || !val.startsWith("_")) return null;
  const suffix = val.slice(1);
  if (suffix === "") return inheritedTicks;
  return parseLengthToken(suffix, inheritedTicks, bpm);
}

// The gate family. The operation is chosen by the keyword so each is
// unambiguous (no overloading one arg as either a ratio or a time):
//   :gate  <time>  — absolute sounding time (length / Nf / Nt token); `0` = hold.
//   :gate* <ratio> — fraction of the note length (0 <= ratio <= 1).
//   :gate- <time>  — shorten: note length minus this time (key off early).
export function parseGateFamily(keyword, val, bpm = null) {
  if (typeof val !== "string") return null;
  if (keyword === ":gate*") {
    const f = parseFloat(val);
    return !isNaN(f) && f >= 0 && f <= 1 ? { type: "ratio", value: f } : null;
  }
  const ticks = val === "0" ? 0 : parseLengthToken(val, null, bpm);
  if (ticks === null || ticks < 0) return null;
  return keyword === ":gate-"
    ? { type: "cut", value: ticks }
    : { type: "ticks", value: ticks };
}

export function gateInvalid(diagnostics, keyword, raw, src, trackName) {
  pushDiag(diagnostics, "error", "E_GATE_INVALID",
    keyword === ":gate*"
      ? `:gate* takes a ratio 0.0 to 1.0, not ${raw}`
      : `${keyword} takes a length, not ${raw}`,
    src, trackName);
}

export function resolveGateTicks(gateSpec, lengthTicks) {
  if (!gateSpec) return lengthTicks;
  // A ratio above 0 keeps at least one tick: 0 is the hold (§17), and a
  // short gate must not round into it.
  if (gateSpec.type === "ratio")
    return gateSpec.value > 0
      ? Math.max(1, Math.round(lengthTicks * gateSpec.value))
      : 0;
  // `cut`: shorten the gate by a fixed amount (key off early) — note length minus
  // the cut. A note no longer than the cut is not cut at all (full gate), as
  // mucom's q: shortening it to a tick would leave nothing to hear.
  if (gateSpec.type === "cut")
    return gateSpec.value >= lengthTicks ? lengthTicks : lengthTicks - gateSpec.value;
  return gateSpec.value;
}

export function isNoteAtom(val) {
  return typeof val === "string" && /^[a-g][+\-]?$/.test(val);
}

// Velocity shift atom: "v+", "v-", "v+8", "v-16" etc.
export function isVelShiftAtom(val) {
  return typeof val === "string" && /^v[+\-]\d*$/.test(val);
}

// Octave shift atom: "o+", "o-", "o+2", "o-2" etc. (parallel to v±; complements
// the traditional < / > which shift by ±1).
export function isOctShiftAtom(val) {
  return typeof val === "string" && /^o[+\-]\d*$/.test(val);
}

// Per-note length atom: note name + any valid length token suffix.
// Examples: c4, e8., f+12t, b-6f, a1/2
export function parsePerNoteLength(val) {
  if (typeof val !== "string") return null;
  const m = val.match(/^([a-g][+\-]?)(.+)$/);
  if (!m) return null;
  const noteName = m[1];
  const lengthStr = m[2];
  const parsed = parseLengthToken(lengthStr, null);
  if (parsed === null) return null;
  return { noteName, lengthStr };
}

export function isPerNoteLengthAtom(val) {
  return parsePerNoteLength(val) !== null;
}

// A stochastic curve's `:hold` (a length) as a share of its `:len`: the phase
// grid sampleCurveUnit holds the curve on, so the hold is a time, whatever
// :len and :rate are. In one unit it needs no tempo; frames against ticks wait
// for the macro's note, whose tempo resolveMacroLen knows.
export function resolveCurveHold(spec, bpm) {
  const h = spec?.holdLen;
  if (!h) return spec;
  let hold = h.n;
  if (h.frames !== !!spec.lenFrames) {
    if (bpm == null) return spec;
    hold = h.frames ? framesToTicks(h.n, bpm) : ticksToFrames(h.n, bpm);
  }
  spec.params = { ...(spec.params ?? {}), hold: hold / spec.frames };
  delete spec.holdLen;
  return spec;
}

// Resolve a length in a structural position: a plain length-token atom, a
// `(ticks expr)` / `(frames expr)` unit bridge (§7.4), or a bare eval
// expression whose numeric result is a note denominator — `(+ 2 2)` ≡ `4` ≡ a
// quarter note, uniform with a literal number. Frames convert to ticks at the
// active tempo, as an Nf length does (§4).
export function resolveLengthNode(node, inherited, trackState, ctx, env) {
  if (node && node.kind === "list") {
    const lv = evalLengthValue(node, env, ctx);
    if (lv) {
      if (lv.unit === "error") return inherited;
      return lv.unit === "frame"
        ? framesToTicks(lv.value, trackState.currentTempo)
        : lv.value;
    }
    if (isEvalHead(atomValue(node.items?.[0]))) {
      const n = evalScalarValue(node, env, ctx);
      if (n === null) return inherited; // diagnostic already pushed
      const d = Math.round(n);
      return d === 0 ? 0 : Math.round(WHOLE_TICKS / d); // denominator, like a literal
    }
  }
  return parseLengthToken(atomValue(node), inherited, trackState.currentTempo);
}

// Positional curve-range sugar: `A..B` → { from: A, to: B }. Endpoints
// are signed decimals; `40..0` is a valid descending range. Returns null for
// anything that is not exactly a range token.
const RANGE_RE = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
export function parseRangeToken(value) {
  if (typeof value !== "string") return null;
  const m = RANGE_RE.exec(value);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

// Inverse of pitchToMidi for `(note <midi>)` (§7.3): MIDI → { note name, octave }
// with sharps spelled `+`, matching the literal note grammar. C4 = 60.
const MIDI_NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
export function midiToNoteParts(midi) {
  return {
    name: MIDI_NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
  };
}

// A name that would be a note-stream token cannot be a `let` binding name
// (E_LET_NAME) — bindings must not shadow the literal note grammar.
export function isNoteStreamToken(name) {
  return (
    typeof name === "string" &&
    (name === ">" ||
      name === "<" ||
      isNoteAtom(name) ||
      isPerNoteLengthAtom(name) ||
      isRestAtom(name) ||
      isVelShiftAtom(name) ||
      isOctShiftAtom(name) ||
      parseLengthToken(name, null) !== null)
  );
}

// A def name is written bare in a channel body, so it must not read as a
// note-stream token there (`e`, `c+8`, `v+2`, `>`): the same rule as a `let`
// name (E_DEF_NAME). A def-val ($name) and a def-se (started by number) are
// never written bare.
export function rejectNoteName(defHead, name, node, diagnostics) {
  if (!isNoteStreamToken(name)) return false;
  pushDiag(diagnostics, "error", "E_DEF_NAME",
    `${defHead} name '${name}' reads as a note or length token in a channel body; pick a word`,
    nodeSrc(node), null);
  return true;
}
