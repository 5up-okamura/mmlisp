/**
 * MMLisp → IR compiler — ES module port of tools/scripts/mmlisp2ir.js (v0.3)
 * No Node.js dependencies; input is a MMLisp source string.
 *
 * API:
 *   compileMMLisp(src: string, filename?: string)
 *     → { ir: object, diagnostics: array, sourceMap: array }
 *
 * Errors in diagnostics have: { severity, code, message, line, column, track }
 */

import { parse } from "./mmlisp-parser.js";
import { clampForTarget, pitchToMidi, sampleCurveUnit } from "./ir-utils.js";
import {
  makeEnv,
  isEvalHead,
  isReservedHead,
  evalValue,
  evalScalarValue,
  evalLet,
  evalLengthValue,
  lookupBound,
} from "./mmlisp-eval.js";

// 96 ticks/quarter (384/whole). Divisible by both MMLisp's note fractions and
// mucom's default 128-clock/whole grid (LCM 384), so imported 128th notes land
// on exact ticks instead of rounding (1/128 whole = 3 ticks, not 1.5).
const PPQN = 96;
const WHOLE_TICKS = PPQN * 4;
// Macro-legal targets — everything a `(macro :target …)` may drive.
const SUPPORTED_TARGETS = new Set([
  "NOTE_PITCH",
  "NOTE_SEMI",
  "KEYON",
  "VEL",
  "VOL",
  "MASTER",
  "FM_ALG",
  "FM_FB",
  "FM_AMS",
  "FM_FMS",
  "LFO_RATE",
  "PAN",
  "NOISE_MODE",
  ...[1, 2, 3, 4].flatMap((op) => [
    `FM_AR${op}`,
    `FM_DR${op}`,
    `FM_SR${op}`,
    `FM_RR${op}`,
    `FM_SL${op}`,
    `FM_TL${op}`,
    `FM_KS${op}`,
    `FM_ML${op}`,
    `FM_DT${op}`,
    `FM_SSG${op}`,
    `FM_AMEN${op}`,
  ]),
]);

// PARAM-legal targets — what an inline `:target v` / `(param-set …)` may write.
// A strict subset of the macro-legal set: NOTE_SEMI, KEYON and VEL have no
// meaningful absolute-write semantics (NOTE_SEMI duplicates NOTE_PITCH, KEYON is
// a note event, VEL is key-on-sticky), so they are macro-only. Writing them as a
// PARAM is rejected.
const PARAM_SET_TARGETS = new Set(
  [...SUPPORTED_TARGETS].filter(
    (t) => t !== "NOTE_SEMI" && t !== "KEYON" && t !== "VEL",
  ),
);

const TRACK_OPTION_KEYS = new Set([
  ":ch",
  ":prio",
  ":oct",
  ":len",
  ":gate",
  ":gate*",
  ":gate-",
  ":vel",
  ":shuffle",
  ":shuffle-base",
]);

// Curve function names recognized in inline curve specs (PARAM_SWEEP authoring)
const CURVE_NAMES = new Set([
  "linear",
  "ease-in",
  "ease-out",
  "ease-inout",
  "ease-in-sine",
  "ease-out-sine",
  "ease-inout-sine",
  "ease-in-quad",
  "ease-out-quad",
  "ease-inout-quad",
  "ease-in-cubic",
  "ease-out-cubic",
  "ease-inout-cubic",
  "ease-in-quart",
  "ease-out-quart",
  "ease-inout-quart",
  "ease-in-quint",
  "ease-out-quint",
  "ease-inout-quint",
  "ease-in-expo",
  "ease-out-expo",
  "ease-inout-expo",
  "ease-in-circ",
  "ease-out-circ",
  "ease-inout-circ",
  "ease-in-back",
  "ease-out-back",
  "ease-inout-back",
  "ease-in-elastic",
  "ease-out-elastic",
  "ease-inout-elastic",
  "ease-in-bounce",
  "ease-out-bounce",
  "ease-inout-bounce",
  "sin",
  "triangle",
  "square",
  "saw",
  "ramp",
  "noise",
  "pink",
  "perlin",
  "brown",
  "const", // constant value (positional arg); sugar for linear from = to
]);

// Loop waveforms produce PARAM_SWEEP with loop:true; easing/linear produce loop:false
const LOOP_CURVE_NAMES = new Set([
  "sin",
  "triangle",
  "square",
  "saw",
  "ramp",
  "noise",
  "pink",
  "perlin",
  "brown",
]);

// PSG noise mode symbols — white0-3 and periodic0-3 map to FB + NF bits
// white:    FB=1, NF varies: 00/01/10/11 → white0/1/2/3
// periodic: FB=0, NF varies: 00/01/10/11 → periodic0/1/2/3
const NOISE_MODE_MAP = {
  white0: 0b1_00, // 4
  white1: 0b1_01, // 5
  white2: 0b1_10, // 6
  white3: 0b1_11, // 7
  periodic0: 0b0_00, // 0
  periodic1: 0b0_01, // 1
  periodic2: 0b0_10, // 2
  periodic3: 0b0_11, // 3
};

// PAN symbolic values → logical range -1/0/+1 (encodeB4 maps these to L/LR/R bits)
const PAN_MAP = { left: -1, center: 0, right: 1 };

function atomValue(node) {
  if (!node) return null;
  if (node.kind === "atom" || node.kind === "string") return node.value;
  return null;
}

function describeNodeToken(node) {
  const atom = atomValue(node);
  if (atom !== null) return atom;
  if (node?.kind === "list") {
    const head = atomValue(node.items?.[0]);
    return head ? `(${head} ...)` : "(...)";
  }
  return node?.kind ?? "unknown";
}

function pushUnknownDiag(diagnostics, code, label, node, trackName) {
  const diagSrc =
    node?.kind === "list" && Array.isArray(node.items) && node.items.length > 0
      ? nodeSrc(node.items[0])
      : nodeSrc(node);
  pushDiag(
    diagnostics,
    "error",
    code,
    `${label}: ${describeNodeToken(node)}`,
    diagSrc,
    trackName,
  );
}

function isAtom(node, value) {
  return node && node.kind === "atom" && node.value === value;
}

function parseIntLike(value) {
  if (typeof value !== "string") return null;
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function normalizePathSeparators(path) {
  return String(path || "").replace(/\\/g, "/");
}

function isAbsolutePath(path) {
  const p = normalizePathSeparators(path);
  return (
    p.startsWith("/") ||
    /^[a-zA-Z]:\//.test(p) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)
  );
}

function dirnamePosix(path) {
  const p = normalizePathSeparators(path);
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return p.slice(0, idx);
}

function normalizePosixPath(path) {
  const p = normalizePathSeparators(path);
  const isAbs = p.startsWith("/");
  const segs = p.split("/");
  const out = [];
  for (const seg of segs) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbs) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

function resolveSamplePath(sampleFile, sourceFile) {
  const file = normalizePathSeparators(sampleFile);
  if (!file || isAbsolutePath(file)) return file;
  const baseDir = dirnamePosix(sourceFile || "");
  if (!baseDir) return file;
  return normalizePosixPath(`${baseDir}/${file}`);
}

// Convert an Nf frame count (wall-clock, 1/60 s) to musical ticks at `bpm`.
// Used where a duration advances the tick timeline (note length, :gate, ~,
// rest). The conversion uses the tempo active at compile time, so under a
// runtime tempo change an Nf note scales with tempo like any tick duration.
function framesToTicks(frames, bpm) {
  if (frames === 0) return 0; // 0f = hold, mirroring plain 0
  return Math.max(1, Math.round((frames * bpm * PPQN) / 3600));
}

// Inverse of framesToTicks: a tick duration → 60 Hz frame count at `bpm`.
function ticksToFrames(ticks, bpm) {
  if (!ticks) return ticks;
  return Math.max(1, Math.round((ticks * 3600) / (bpm * PPQN)));
}

// Resolve a macro spec's `:len`/`:wait` from ticks to frames at the note's
// tempo, so the driver — which samples macros on a 60 Hz frame clock — gets an
// absolute frame count (`lenFrames`). `Nf` lens are already frames. Returns a
// copy; the shared def spec is left untouched. Mirrors the glide/delay Nf→tick
// resolution done at compile time.
function resolveMacroLen(spec, bpm) {
  if (!spec || typeof spec !== "object" || bpm == null) return { ...spec };
  const out = { ...spec };
  // `:step` in ticks → frames (the driver clocks macros on 60 Hz frames).
  if (out.step?.unit === "tick") {
    out.step = { unit: "frame", value: ticksToFrames(out.step.value, bpm) };
  }
  if (out.type === "curve") {
    if (!out.lenFrames && out.frames != null) {
      out.frames = ticksToFrames(out.frames, bpm);
      out.lenFrames = true;
    }
    // `:wait N` is a pre-delay before the curve starts (docs §11); resolve it to
    // frames so the MMB exporter can lower it to hold steps (mirrors stages).
    if (out.waitTicks != null && out.waitFrames == null) {
      out.waitFrames = ticksToFrames(out.waitTicks, bpm);
    }
  } else if (out.type === "stages") {
    out.stages = (out.stages ?? []).map((st) => {
      const s = { ...st };
      if (s.curve && !s.lenFrames && s.frames != null) {
        s.frames = ticksToFrames(s.frames, bpm);
        s.lenFrames = true;
      }
      if (s.waitTicks != null && s.waitFrames == null) {
        s.waitFrames = ticksToFrames(s.waitTicks, bpm);
      }
      return s;
    });
  }
  return out;
}

// `bpm` gives a structural context (note length / gate / tie / rest): there an
// `Nf` token is converted to ticks at the active tempo. When `bpm` is null
// (curve `:len` context) the raw frame count is returned and paired with a
// `lenFrames` flag the player honors natively.
function parseLengthToken(value, inheritedTicks, bpm = null) {
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
function parseStepToken(value) {
  if (typeof value !== "string") return null;
  if (/^\d+f$/.test(value)) {
    const n = parseInt(value, 10);
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
function isRestAtom(val) {
  if (val === "_") return true;
  return parseRestLength(val, null) !== null;
}

// Parse the length of a rest token; the leading "_" is stripped before parsing.
function parseRestLength(val, inheritedTicks, bpm = null) {
  if (typeof val !== "string" || !val.startsWith("_")) return null;
  const suffix = val.slice(1);
  if (suffix === "") return inheritedTicks;
  return parseLengthToken(suffix, inheritedTicks, bpm);
}

// The gate family. The operation is chosen by the keyword so each is
// unambiguous (no overloading one arg as either a ratio or a time):
//   :gate  <time>  — absolute sounding time (length / Nf / Nt token); `0` = hold.
//   :gate* <ratio> — fraction of the note length (0 <= ratio < 1).
//   :gate- <time>  — shorten: note length minus this time (key off early).
function parseGateFamily(keyword, val, bpm = null) {
  if (typeof val !== "string") return null;
  if (keyword === ":gate*") {
    const f = parseFloat(val);
    return !isNaN(f) && f >= 0 && f < 1 ? { type: "ratio", value: f } : null;
  }
  const ticks = val === "0" ? 0 : parseLengthToken(val, null, bpm);
  if (ticks === null || ticks < 0) return null;
  return keyword === ":gate-"
    ? { type: "cut", value: ticks }
    : { type: "ticks", value: ticks };
}

function resolveGateTicks(gateSpec, lengthTicks) {
  if (!gateSpec) return lengthTicks;
  if (gateSpec.type === "ratio")
    return Math.round(lengthTicks * gateSpec.value);
  // `cut`: shorten the gate by a fixed amount (key off early) — note length minus
  // the cut, floored at 1 tick. Set by `:gate-cut`.
  if (gateSpec.type === "cut")
    return Math.max(1, lengthTicks - gateSpec.value);
  return gateSpec.value;
}

// Offset macros (pitch/semi) keep their absolute values but record whether the
// operator was `+` (additive: compose with the channel's live pitch offset at
// play time) as an explicit `add` flag. Unlike VEL the values are not baked, so
// the same lowered macro serves both centers; the player and the MMB exporter
// read `add`. `op` is dropped — it was only a parse-time marker.
function withAddFlag(spec) {
  const out = { ...spec, add: spec.op === "+" };
  delete out.op;
  return out;
}

function makeNoteArgs(pitch, lengthTicks, gateSpec, vel, activeMacros, bpm) {
  const gateTicks = resolveGateTicks(gateSpec, lengthTicks);
  const args = { pitch, length: lengthTicks };
  if (gateTicks < lengthTicks) args.gate = gateTicks;
  if (vel !== undefined && vel !== 15) args.vel = vel;
  if (activeMacros && Object.keys(activeMacros).length > 0) {
    for (const [target, spec0] of Object.entries(activeMacros)) {
      // Each spec may carry its own .step (the per-macro :step clock). Resolve a
      // tick-unit `:len` to an absolute frame count at this note's tempo first.
      const spec = resolveMacroLen(spec0, bpm);
      if (target === "NOTE_PITCH") args.pitchMacro = withAddFlag(spec);
      else if (target === "NOTE_SEMI") args.note_semi = withAddFlag(spec);
      else if (target === "VEL") {
        // `:vel*`/`:vel+` combine the macro with this note's velocity, resolved
        // here so it tracks per-note vel changes → a plain absolute velMacro.
        // `*` scales by the 0..1 vel ratio (vel 15 = ×1 = unchanged); `+` adds
        // the note's vel as an offset (vel is a relative envelope around it).
        if (spec.op === "*") {
          const scaled = scaleMacroValues(spec, (vel ?? 15) / 15, "VEL");
          delete scaled.op;
          args.velMacro = scaled;
        } else if (spec.op === "+") {
          const shifted = addMacroValues(spec, vel ?? 15, "VEL");
          delete shifted.op;
          args.velMacro = shifted;
        } else {
          args.velMacro = { ...spec };
        }
      } else {
        // NOTE_SEMI → note_semi, KEYON → keyon, FM_TL1 → fm_tl1, ...
        const key = target.toLowerCase();
        args[key] = { ...spec };
      }
    }
  }
  return args;
}

function fm3OpMask(opIndex) {
  if (!Number.isInteger(opIndex) || opIndex < 1 || opIndex > 4) {
    throw new Error(`Invalid FM3 operator index: ${opIndex}`);
  }
  return 0x10 << (opIndex - 1);
}

function makeFm3OpNoteArgs(
  pitch,
  lengthTicks,
  gateSpec,
  vel,
  opIndex,
  activeMacros,
  bpm,
) {
  const args = makeNoteArgs(pitch, lengthTicks, gateSpec, vel, activeMacros, bpm);
  args.fm3Op = opIndex;
  args.opMask = fm3OpMask(opIndex);
  return args;
}

function emitCsmRateEvent(
  trackState,
  events,
  diagnostics,
  src,
  trackName,
  rateArgs,
  markInline = false,
) {
  const args =
    rateArgs?.hz !== undefined
      ? { hz: clampCsmRateHz(rateArgs.hz, diagnostics, src, trackName) }
      : {
          from: clampCsmRateHz(rateArgs.from, diagnostics, src, trackName),
          to: clampCsmRateHz(rateArgs.to, diagnostics, src, trackName),
          len: rateArgs.len,
          curve: rateArgs.curve,
        };
  if (rateArgs?.params && typeof rateArgs.params === "object") {
    args.params = { ...rateArgs.params };
  }
  if (markInline) {
    trackState.hasInlineCsmRate = true;
  }
  events.push({
    tick: trackState.tick,
    cmd: "CSM_RATE",
    args,
    src,
  });
}

// (glide ...) on fm3-csm-rate slides Timer A Hz between notes: emit the swept
// CSM_RATE form (same shape as inline `:csm-rate (curve ...)`) from the previous
// note's Hz — or a one-shot `(glide <from> <time>)` override, given as a raw Hz
// literal or a pitch — to the new Hz. The sweep length is clamped to the note
// length so scheduled sweep writes cannot overrun the next note's rate.
function emitCsmRateNoteHz(
  trackState,
  events,
  diagnostics,
  src,
  trackName,
  hz,
  lengthTicks,
) {
  const glideTicks = trackState.glide ?? 0;
  let fromHz = null;
  if (glideTicks > 0 && trackState.lastCsmHz != null) {
    const override = trackState.glideFrom;
    trackState.glideFrom = null; // one-shot reset, mirrors emitGlideIfNeeded
    if (override != null) {
      const n = parseNumberLike(String(override));
      fromHz = n !== null ? n : csmPitchToHz(String(override));
      if (!Number.isFinite(fromHz)) fromHz = trackState.lastCsmHz;
    } else {
      fromHz = trackState.lastCsmHz;
    }
  }
  if (fromHz != null && fromHz !== hz) {
    emitCsmRateEvent(trackState, events, diagnostics, src, trackName, {
      from: fromHz,
      to: hz,
      len: Math.min(glideTicks, lengthTicks),
      curve: "linear",
    });
  } else {
    emitCsmRateEvent(trackState, events, diagnostics, src, trackName, { hz });
  }
  trackState.lastCsmHz = hz;
}

function isPcmModeSymbol(value) {
  return value === "shot" || value === "loop";
}

function isPcmTrackName(name) {
  return /^pcm[1-3]$/.test(name);
}

function isTrackPcmActive(trackState) {
  return !!trackState?.isPcmTrack;
}

function isLikelyPcmBodyToken(value) {
  if (!value) return false;
  if (value.startsWith(":")) return true;
  if (value.startsWith("#")) return true;
  if (value === "~" || value === ">" || value === "<" || value === "_")
    return true;
  if (value === "go" || value === "x" || value === "param-set") return true;
  if (isRestAtom(value)) return true;
  if (isNoteAtom(value)) return true;
  if (isPerNoteLengthAtom(value)) return true;
  return false;
}

function emitNoteForTrack(
  trackState,
  noteName,
  lengthTicks,
  events,
  diagnostics,
  src,
  trackName,
) {
  // Slur/tie connector (X ~ Y): a pending `~` connects this note to the previous
  // one. Same pitch → TIE (extend the previous note; works on every channel).
  // Different pitch → legato (a NOTE_ON that updates the frequency without
  // re-keying), applied on the standard FM/PSG note path below.
  let legato = false;
  if (trackState.pendingLegato) {
    trackState.pendingLegato = false;
    const cmpPitch = noteName + trackState.defaultOct;
    const prev = trackState.lastNotePitch;
    if (prev && pitchToMidi(cmpPitch) === pitchToMidi(String(prev))) {
      events.push({
        tick: trackState.tick,
        cmd: "TIE",
        args: { length: lengthTicks },
        src,
      });
      // Re-resolve the tied group head's gate against the full tied length. A
      // relative gate (`:gate-` / `:gate*`) means "cut/fraction of the whole
      // tied note", not of just the first segment, so the key-off must land near
      // the tied end — otherwise the head keys off mid-tie and the tie breaks.
      const head = trackState.tiedHead;
      if (head) {
        head.total += lengthTicks;
        const g = resolveGateTicks(head.gateSpec, head.total);
        if (g < head.total) head.ev.args.gate = g;
        else delete head.ev.args.gate;
      }
      trackState.tick += lengthTicks;
      updateLastNotePitch(trackState, cmpPitch);
      return;
    }
    legato = true;
  }
  if (isTrackPcmActive(trackState)) {
    if (!trackState.pcmSampleName) {
      pushDiag(
        diagnostics,
        "warning",
        "E_PCM_SAMPLE_REQUIRED",
        "pcm mode requires a sample symbol before note data",
        src,
        trackName,
      );
      trackState.tick += lengthTicks;
      return;
    }
    if (!trackState.sampleDefs?.has(trackState.pcmSampleName)) {
      pushDiag(
        diagnostics,
        "error",
        "E_PCM_SAMPLE_UNDEFINED",
        `undefined sample def: ${trackState.pcmSampleName}`,
        src,
        trackName,
      );
      trackState.tick += lengthTicks;
      return;
    }

    const fullPitch = noteName + trackState.defaultOct;
    const pcmMidiRaw = pitchToMidi(fullPitch);
    const pcmMidiClamped = Math.max(36, Math.min(84, pcmMidiRaw));
    if (pcmMidiClamped !== pcmMidiRaw) {
      pushDiag(
        diagnostics,
        "warning",
        "W_PCM_PITCH_CLAMP",
        `pcm pitch out of practical range (C2-C6), clamped: ${fullPitch}`,
        src,
        trackName,
      );
    }
    const pcmRate = Math.pow(2, (pcmMidiClamped - 60) / 12);
    const gateTicks = resolveGateTicks(trackState.defaultGate, lengthTicks);
    const mode = trackState.pcmPendingMode ?? "shot";
    const sampleDef = trackState.sampleDefs?.get(trackState.pcmSampleName);
    const args = {
      sample: trackState.pcmSampleName,
      pitch: fullPitch,
      rate: pcmRate,
      length: lengthTicks,
      mode,
    };
    if (Number.isFinite(sampleDef?.rate) && sampleDef.rate > 0) {
      args.baseRate = sampleDef.rate;
    }
    if (trackState.defaultVel !== undefined && trackState.defaultVel !== 15) {
      args.vel = trackState.defaultVel;
    }
    if (gateTicks < lengthTicks) args.gate = gateTicks;

    const pcmEv = {
      tick: trackState.tick,
      cmd: "PCM_NOTE_ON",
      args,
      src,
    };
    stampDelay(pcmEv, trackState);
    events.push(pcmEv);
    if (mode === "loop" && gateTicks > 0) {
      events.push({
        tick: trackState.tick + gateTicks,
        cmd: "PCM_NOTE_OFF",
        args: { sample: trackState.pcmSampleName, mode },
        src,
      });
    }
    trackState.tick += lengthTicks;
    trackState.pcmPendingMode = null;
    return;
  }

  if (trackState.isCsmRateTrack) {
    const pitch = csmTrackPitch(
      trackState,
      noteName,
      diagnostics,
      src,
      trackName,
    );
    emitCsmRateNoteHz(
      trackState,
      events,
      diagnostics,
      src,
      trackName,
      csmPitchToHz(pitch),
      lengthTicks,
    );
    trackState.tick += lengthTicks;
    return;
  }

  const fullPitch = noteName + trackState.defaultOct;
  emitGlideIfNeeded(trackState, fullPitch, events, trackState.glide, src);
  if (trackState.isFm3OpTrack) {
    events.push({
      tick: trackState.tick,
      cmd: "FM3_OP_PITCH",
      args: { op: trackState.fm3OpIndex, pitch: fullPitch },
      src,
    });
  }
  if (trackState.isCsmTrack && !trackState.hasCsmOn) {
    events.push({
      tick: trackState.tick,
      cmd: "CSM_ON",
      args: {},
      src,
    });
    trackState.hasCsmOn = true;
  }
  const noteEv = {
    tick: trackState.tick,
    cmd: "NOTE_ON",
    args: trackState.isFm3OpTrack
      ? makeFm3OpNoteArgs(
          fullPitch,
          lengthTicks,
          trackState.defaultGate,
          trackState.defaultVel,
          trackState.fm3OpIndex,
          trackState.activeMacros,
          trackState.currentTempo,
        )
      : makeNoteArgs(
          fullPitch,
          lengthTicks,
          trackState.defaultGate,
          trackState.defaultVel,
          trackState.activeMacros,
          trackState.currentTempo,
        ),
    src,
  };
  // Legato slur: frequency changes, the operator is not re-keyed (§ tie/slur).
  // FM3-op notes have their own per-operator keying, so legato is FM/PSG only.
  if (legato && !trackState.isFm3OpTrack) noteEv.args.legato = true;
  stampDelay(noteEv, trackState);
  events.push(noteEv);
  // Head of a (possibly) tied group: a following TIE re-resolves a relative gate
  // against the full tied length. Captured with the gate spec active *here*.
  trackState.tiedHead = {
    ev: noteEv,
    gateSpec: trackState.defaultGate,
    total: lengthTicks,
  };
  trackState.tick += lengthTicks;
  updateLastNotePitch(trackState, fullPitch);
  // Feed the (echo …) history from the standard pitch path (FM3-op/PCM excluded).
  if (!trackState.isFm3OpTrack)
    pushRecentNote(
      trackState,
      fullPitch,
      lengthTicks,
      trackState.defaultGate,
      trackState.defaultVel ?? 15,
    );
}

// `(note expr [len])` (§2.5): evaluate a MIDI number and emit one NOTE_ON at
// that absolute pitch, reusing emitNoteForTrack so ties/glide/shuffle/PCM/macros
// behave identically to a literal note. The octave is set from the MIDI number
// (temporarily, so it does not leak into following notes) — the note name +
// octave round-trips through pitchToMidi unchanged.
function emitEvalNote(node, trackState, events, diagnostics, trackName, typedDefs, env) {
  const items = node.items.filter((n) => n.kind !== "comment");
  const ctx = makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs);
  if (items.length < 2 || items.length > 3) {
    pushDiag(diagnostics, "error", "E_NOTE_ARGS", "(note expr [len]) takes a pitch and optional length", nodeSrc(node), trackName);
    return;
  }
  const scalar = evalScalarValue(items[1], env, ctx);
  if (scalar === null) return; // diagnostic already pushed
  const midi = Math.round(scalar);
  if (midi < 0 || midi > 127) {
    pushDiag(diagnostics, "error", "E_NOTE_RANGE", `note ${midi} out of MIDI range 0..127`, nodeSrc(node), trackName);
    return;
  }
  const hasLen = items.length === 3;
  const lengthTicks = hasLen
    ? resolveLengthNode(items[2], trackState.defaultLength, trackState, ctx, env)
    : trackState.defaultLength;
  // An explicit per-note length skips shuffle (matching literal `c8`); a default
  // length swings (matching a bare note).
  const ticks = hasLen ? lengthTicks : resolveShuffleTicks(lengthTicks, trackState);
  const { name, octave } = midiToNoteParts(midi);
  const savedOct = trackState.defaultOct;
  trackState.defaultOct = octave;
  emitNoteForTrack(trackState, name, ticks, events, diagnostics, nodeSrc(node), trackName);
  trackState.defaultOct = savedOct;
}

/**
 * v0.4: Emit glide PARAM_SWEEP before NOTE_ON if glide is active.
 * Inserts a portamento slide from lastNotePitch to newPitch over glideTicks.
 * Resets glideFrom after emission (one-shot override).
 */
function emitGlideIfNeeded(trackState, newPitch, events, glideTicks, nodeSrc) {
  if (glideTicks <= 0 || !trackState.lastNotePitch) return; // No glide or first note

  const fromPitch = trackState.glideFrom || trackState.lastNotePitch;
  trackState.glideFrom = null; // One-shot reset

  // NOTE_PITCH is a numeric cent offset relative to the note's own base pitch
  // (the player applies `baseMidi + centOffset/100`). Express the glide as an
  // offset sweep: start at (fromPitch − newPitch) cents, end at 0, so the note
  // slides from the previous/override pitch up or down to its own pitch.
  const fromCents =
    (pitchToMidi(String(fromPitch)) - pitchToMidi(String(newPitch))) * 100;
  events.push({
    tick: trackState.tick,
    cmd: "PARAM_SWEEP",
    args: {
      target: "NOTE_PITCH",
      from: fromCents,
      to: 0,
      curve: "linear",
      frames: glideTicks,
      loop: false,
      // A glide is a bounded one-shot: it slides over `frames` then stops, unlike
      // an inline pitch sweep that holds its final value until the next event. So
      // it must not extend across following notes (which would clobber their pitch).
      bounded: true,
    },
    src: nodeSrc,
  });
}

/**
 * v0.4: Update lastNotePitch after emitting NOTE_ON.
 */
function updateLastNotePitch(trackState, pitch) {
  trackState.lastNotePitch = pitch;
}

// v0.5: rolling history of recently emitted notes (max 9) for (echo …) replay.
// pitch is absolute (includes octave), so the replay needs no octave bookkeeping.
function pushRecentNote(trackState, pitch, length, gateSpec, vel) {
  const hist = (trackState.recentNotes ||= []);
  hist.push({ pitch, length, gateSpec, vel });
  if (hist.length > 9) hist.shift();
}

// Resolve a tap's value relative to the source: additive (src + by·k) or
// multiplicative (src · by^k), clamped to the target range. Shared by echo/delay.
function tapValue(domain, by, k, srcVal, target) {
  const v = domain === "mul" ? srcVal * Math.pow(by, k) : srcVal + by * k;
  return clampForTarget(target, v);
}

// (echo …): replay the single note `back` positions back (back=1 = the last
// note), once per tap (1..count), each modulating `target` relative to that
// note's own value. Advances trackState.tick so the phrase lengthens. This
// matches mucom `\=n1,n2` (the note n1 back), where `back` = n1. v1 targets VEL.
function emitEchoReplay(trackState, events, { domain, count, by, back }, src) {
  const hist = trackState.recentNotes || [];
  if (!hist.length || count < 1) return;
  const note = hist[Math.max(0, hist.length - back)]; // clamp to the oldest note
  if (!note) return;
  // mucom replays the echoed pitch at the *current* defaults (the `\` expansion
  // substitutes the bare note name, inheriting the current length `l` and gate
  // `q`), not the source note's length/gate.
  const len = trackState.defaultLength;
  const gate = trackState.defaultGate;
  for (let k = 1; k <= count; k++) {
    const vel = tapValue(domain, by, k, note.vel ?? 15, "VEL");
    events.push({
      tick: trackState.tick,
      cmd: "NOTE_ON",
      args: makeNoteArgs(note.pitch, len, gate, vel, null),
      src,
    });
    trackState.tick += len;
  }
}

function applyMacroEntryToState(trackState, irTarget, spec) {
  if (!spec || !SUPPORTED_TARGETS.has(irTarget)) return;
  trackState.activeMacros[irTarget] = spec;
}

// v0.5: `:macro :target none` clears one active macro; `:macro none` clears all.
function clearMacroTarget(trackState, irTarget) {
  if (irTarget && SUPPORTED_TARGETS.has(irTarget))
    delete trackState.activeMacros[irTarget];
}

// v0.5: resolve a (delay …) spec into concrete per-tap velocities, RELATIVE to
// the source note's vel. `param` = a regular ramp from `:by` (additive on :vel /
// geometric on :vel*); `list` = explicit per-tap deltas/ratios; `curve` = a
// relative envelope whose tap count is :len ÷ spacing. mode "add"|"mul".
function resolveDelayVels(spec, delayTicks, srcVel) {
  if (!spec || !(delayTicks > 0)) return null;
  const apply = (rel) =>
    clampForTarget("VEL", spec.mode === "mul" ? srcVel * rel : srcVel + rel);
  if (spec.type === "param") {
    const out = [];
    for (let k = 1; k <= spec.count; k++)
      out.push(tapValue(spec.mode, spec.by ?? 0, k, srcVel, "VEL"));
    return out.length ? out : null;
  }
  if (spec.type === "list") {
    return spec.list.length ? spec.list.map(apply) : null;
  }
  if (spec.type === "curve") {
    const { from = 0, to = 0, frames = 0, curve = "linear", params } = spec;
    const count = Math.floor(frames / delayTicks);
    if (count < 1) return null;
    const out = [];
    for (let k = 1; k <= count; k++)
      out.push(apply(from + (to - from) * sampleCurveUnit(curve, k / count, params)));
    return out;
  }
  return null;
}

// Largest numeric value in a :vel macro — the reference peak for echo scaling.
function velMacroPeak(spec) {
  if (!spec) return 0;
  if (spec.type === "steps") {
    return (spec.steps || []).reduce(
      (m, v) => (v !== null && v !== undefined ? Math.max(m, v) : m),
      0,
    );
  }
  if (spec.type === "curve") {
    return Math.max(spec.from ?? 0, spec.to ?? 0);
  }
  if (spec.type === "stages") {
    return (spec.stages || []).reduce(
      (m, st) =>
        st && st.from !== undefined ? Math.max(m, st.from, st.to ?? 0) : m,
      0,
    );
  }
  return 0;
}

// Scale a macro spec's values by `factor`, clamped to `target`'s range (kept
// float, quantized at playback), preserving type, markers, and per-macro step.
// Shared by the `*` multiplicative modifier (factor = the note's static base)
// and :delay echoes (factor = the echo's vel ratio).
// Apply fn to every scalar value a macro spec carries (step values / curve
// from&to / stage from&to), preserving nulls. Shared by scale and add.
function mapMacroValues(spec, fn) {
  if (!spec) return spec;
  const s = (v) => (v === null || v === undefined ? v : fn(v));
  if (spec.type === "steps") {
    return { ...spec, steps: (spec.steps || []).map(s) };
  }
  if (spec.type === "curve") {
    return { ...spec, from: s(spec.from ?? 0), to: s(spec.to ?? 0) };
  }
  if (spec.type === "stages") {
    return {
      ...spec,
      stages: (spec.stages || []).map((st) =>
        st && st.from !== undefined
          ? { ...st, from: s(st.from), to: s(st.to ?? 0) }
          : st,
      ),
    };
  }
  return spec;
}

function scaleMacroValues(spec, factor, target) {
  return mapMacroValues(spec, (v) => clampForTarget(target, v * factor));
}

function addMacroValues(spec, offset, target) {
  return mapMacroValues(spec, (v) => clampForTarget(target, v + offset));
}

// A :delay echo's inherited vel tail peaks at the echo's :delay-vels level.
function scaleVelMacroSteps(spec, ratio) {
  return scaleMacroValues(spec, ratio, "VEL");
}

// Macro targets that accept the `*` (multiplicative) modifier: each has a
// per-note/channel static base its macro values scale. Offset targets
// (NOTE_PITCH/NOTE_SEMI) and discrete ones (PAN/KEYON/...) have no base, so
// `*` is rejected there. VOL/MASTER live in a separate channel-level macro
// path and are not wired yet; add them here once that path tracks a base.
const OP_BASE_TARGETS = new Set(["VEL"]);

// Offset targets carry a runtime base (the channel's live pitch offset), so `+`
// composes the macro with it — resolved in the player, not baked here like VEL.
// `*` has no meaningful multiply of a signed offset and stays rejected.
const OP_ADD_TARGETS = new Set(["NOTE_PITCH", "NOTE_SEMI"]);

// Split a trailing arithmetic operator off a keyword/atom:
// "vel*" -> { stem: "vel", op: "*" }, "oct+" -> {stem:"oct", op:"+"}, "vel" -> {stem, op:null}.
// Only `+` (add to base) and `*` (multiply base) are operators; no `-`/`/`.
function opSuffix(sym) {
  const last = sym.length > 1 ? sym[sym.length - 1] : "";
  return last === "*" || last === "+"
    ? { stem: sym.slice(0, -1), op: last }
    : { stem: sym, op: null };
}

// Split a macro keyword into its canonical target and the arithmetic operator:
// `:vel*` -> { target: "VEL", op: "*" }, `:vel+` -> op "+", `:vel` -> op null.
function macroKeyword(sym) {
  const { stem, op } = opSuffix(sym);
  return { target: canonicalTarget(stem), op };
}

// Resolve a `$name` value/operand to a source id: "$time" (built-in) or a
// declared slot name. Diagnoses unknown names. Returns null if `raw` is not a
// `$` reference.
function resolveValRef(raw, vals, diagnostics, trackName, src) {
  if (typeof raw !== "string" || !raw.startsWith("$")) return null;
  const name = raw.slice(1);
  if (name === "time") return "$time";
  if (vals?.has(name)) return name;
  pushDiag(
    diagnostics,
    "error",
    "E_VAL_UNDEFINED",
    `undefined value: ${raw} (declare with (def-val ${name} …))`,
    src,
    trackName,
  );
  return name; // keep the IR well-formed; player treats a missing slot as 0
}

// ── Value-machine left-fold lowering (v0.6 §4.3) ──────────────────────────
// A `$ref`-bearing hw-param expression lowers to a chain of the existing param
// opcodes with the param itself as the accumulator: a seed (const→PARAM_SET,
// $slot→PARAM_FROM_VAL, self-ref $P→none) then add/mul terms (PARAM_ADD /
// PARAM_ADD/MUL with a {src} slot). Shapes that need a true temporary, a
// subtract-from / divide-by / subtract-a-slot, a negative multiply, or ×$slot
// on an i16 target are E_EVAL_NOT_LOWERABLE (the honest list). No new opcodes,
// no new IR shapes — the exporter already lowers each event 1:1.
const VALUE_ARITH = new Set(["+", "-", "*", "/"]);

function exprHasValRef(node) {
  if (node?.kind === "atom")
    return typeof node.value === "string" && node.value.startsWith("$");
  if (node?.kind === "list") return node.items.some(exprHasValRef);
  return false;
}

// Fold a purely-constant subtree (numbers + let-bound scalars, no $ref) → number
// | null. Keeps the linearizer from treating a computed constant as a term.
function constFoldExpr(node, env) {
  if (node?.kind === "atom") {
    const n = parseNumberLike(node.value);
    if (n !== null) return n;
    const bound = lookupBound(env, node.value);
    return typeof bound === "number" ? bound : null;
  }
  if (node?.kind === "list" && node.bracket === "()") {
    const items = node.items.filter((x) => x.kind !== "comment");
    const head = atomValue(items[0]);
    if (VALUE_ARITH.has(head) && items.length === 3) {
      const a = constFoldExpr(items[1], env);
      const b = constFoldExpr(items[2], env);
      if (a === null || b === null) return null;
      if (head === "+") return a + b;
      if (head === "-") return a - b;
      if (head === "*") return a * b;
      return b === 0 ? null : a / b;
    }
  }
  return null;
}

// Linearize a value expression into a step chain, or an {error}. `target` is the
// canonical param being written (for self-ref detection and the i16 caveat).
function linearizeValueExpr(node, target, env, vals, diagnostics, trackName, src) {
  const i16 = target === "NOTE_PITCH" || target === "TEMPO_SCALE";
  const err = (code, msg) => ({ error: { code, msg } });

  // A leaf → {const}|{slot}|{self}|{error}|null (null = not a leaf).
  const leaf = (n) => {
    if (n?.kind !== "atom") return null;
    const v = n.value;
    if (typeof v === "string" && v.startsWith("$")) {
      const name = v.slice(1);
      // Self-ref: $<param> naming the target being written (canonicalTarget keys
      // on the `:` keyword form). Seed nothing — start from the current value.
      if (name !== "time" && canonicalTarget(":" + name) === target) return { self: true };
      return { slot: resolveValRef(v, vals, diagnostics, trackName, src) };
    }
    return { error: err("E_EVAL_OPERAND", `not a value operand: ${v}`).error };
  };
  // A leaf usable as an additive term (const or plain slot); self/expr → null.
  const addTerm = (n) => {
    const c = constFoldExpr(n, env);
    if (c !== null) return { const: c };
    const lf = leaf(n);
    return lf && lf.slot !== undefined ? { slot: lf.slot } : null;
  };
  const scale = (chain, k) => {
    if (chain.error) return chain;
    if (k === 1) return chain;
    if (k < 0) return err("E_EVAL_NOT_LOWERABLE",
      "multiply by a negative constant (PARAM_MUL factor is unsigned 8.8)");
    const s = chain.steps;
    if (s.length === 1 && s[0].op === "set") return { steps: [{ op: "set", val: s[0].val * k }] };
    return { steps: [...s, { op: "mul", val: k }] };
  };
  const mulval = (chain, ref) => {
    if (chain.error) return chain;
    if (i16) return err("E_EVAL_NOT_LOWERABLE",
      "multiply by a $value on an i16 target (NOTE_PITCH/TEMPO_SCALE) is not sign-correct");
    return { steps: [...chain.steps, { op: "mulval", ref }] };
  };
  const append = (chain, term) => {
    if (chain.error) return chain;
    if (term.const !== undefined) {
      if (term.const === 0) return chain;
      const s = chain.steps;
      if (s.length === 1 && s[0].op === "set") return { steps: [{ op: "set", val: s[0].val + term.const }] };
      return { steps: [...s, { op: "add", val: term.const }] };
    }
    return { steps: [...chain.steps, { op: "addval", ref: term.slot }] };
  };

  const lin = (n) => {
    const c = constFoldExpr(n, env);
    if (c !== null) return { steps: [{ op: "set", val: c }] };
    const lf = leaf(n);
    if (lf) {
      if (lf.error) return { error: lf.error };
      if (lf.self) return { steps: [{ op: "self" }] };
      return { steps: [{ op: "fromval", ref: lf.slot }] };
    }
    if (n?.kind !== "list" || n.bracket !== "()")
      return err("E_EVAL_OPERAND", "unsupported value operand");
    const items = n.items.filter((x) => x.kind !== "comment");
    const head = atomValue(items[0]);
    if (!VALUE_ARITH.has(head) || items.length !== 3)
      return err("E_EVAL_NOT_LOWERABLE",
        `${head} with a runtime value has no param-opcode lowering`);
    const [, A, B] = items;
    const ca = constFoldExpr(A, env), cb = constFoldExpr(B, env);
    if (head === "*") {
      if (ca !== null) return scale(lin(B), ca);
      if (cb !== null) return scale(lin(A), cb);
      const lb = leaf(B), la = leaf(A);
      if (lb && lb.slot !== undefined) return mulval(lin(A), lb.slot);
      if (la && la.slot !== undefined) return mulval(lin(B), la.slot);
      return err("E_EVAL_NOT_LOWERABLE",
        "product of two runtime sub-expressions needs a temporary (not built; §4.5)");
    }
    if (head === "/") {
      if (cb === 0) return err("E_EVAL_DIV_ZERO", "division by zero");
      if (cb !== null) return scale(lin(A), 1 / cb);
      return err("E_EVAL_NOT_LOWERABLE", "divide by a runtime value has no opcode");
    }
    if (head === "+") {
      const tb = addTerm(B); if (tb) return append(lin(A), tb);
      const ta = addTerm(A); if (ta) return append(lin(B), ta);
      return err("E_EVAL_NOT_LOWERABLE",
        "sum of two runtime sub-expressions needs a temporary (not built; §4.5)");
    }
    // head === "-"
    if (cb !== null) return append(lin(A), { const: -cb });
    const lb = leaf(B);
    if (lb && lb.slot !== undefined)
      return err("E_EVAL_NOT_LOWERABLE",
        "subtract a runtime value has no SUB_VAL opcode (invert the slot's range instead)");
    return err("E_EVAL_NOT_LOWERABLE",
      "subtract-from a runtime value requires negation (not lowerable)");
  };

  return lin(node);
}

// Emit a `$ref` value expression as its param-opcode chain, or diagnose why it
// cannot lower. `push(cmd, args)` appends an IR event on the current target.
function lowerValueExpr(node, target, push, env, vals, diagnostics, trackName, src) {
  const r = linearizeValueExpr(node, target, env, vals, diagnostics, trackName, src);
  if (r.error) {
    pushDiag(diagnostics, "error", r.error.code, r.error.msg, src, trackName);
    return;
  }
  const writes = r.steps.filter((s) => s.op !== "self").length;
  if (writes > 6)
    pushDiag(diagnostics, "warning", "W_EVAL_CHAIN_LONG",
      `expression lowers to ${writes} register writes (§4.7)`, src, trackName);
  for (const s of r.steps) {
    if (s.op === "self") continue;
    if (s.op === "set") push("PARAM_SET", { target, value: Math.round(s.val) });
    else if (s.op === "fromval") push("PARAM_FROM_VAL", { target, src: s.ref });
    else if (s.op === "add") push("PARAM_ADD", { target, delta: Math.round(s.val) });
    else if (s.op === "addval") push("PARAM_ADD", { target, delta: { src: s.ref } });
    else if (s.op === "mul") push("PARAM_MUL", { target, factor: s.val });
    else if (s.op === "mulval") push("PARAM_MUL", { target, factor: { src: s.ref } });
  }
}

// Target group: a [] vector of macro keywords in target position, e.g.
// (macro [:tl1 :tl2 :tl3 :tl4] spec) — one spec applied to every target.
// Returns the keyword strings, or null if node is not an all-keyword vector.
// Unambiguous: spec vectors only ever appear in the value position.
function macroTargetGroup(node) {
  if (node?.kind !== "list" || node.bracket !== "[]") return null;
  const items = node.items.filter((n) => n.kind !== "comment");
  if (items.length === 0) return null;
  const syms = items.map((n) => atomValue(n));
  return syms.every((s) => typeof s === "string" && s.startsWith(":"))
    ? syms
    : null;
}

// Validate a `+`/`*` operator against its target; pushes a diagnostic and
// returns false when the target has no base value to add to / scale.
function macroOpOk(target, op, sym, diagnostics, trackName) {
  if (OP_BASE_TARGETS.has(target)) return true; // VEL: + and * both bake a base
  if (op === "+" && OP_ADD_TARGETS.has(target)) return true; // additive offset
  const msg = OP_ADD_TARGETS.has(target)
    ? `'${sym}' — offset targets (pitch/semi) accept + only, not *`
    : `'${sym}' has no base value to combine with; +/* apply only to ${[...OP_BASE_TARGETS].join(", ").toLowerCase()}`;
  pushDiag(diagnostics, "error", "E_MACRO_OP_NO_BASE", msg, null, trackName);
  return false;
}

// Stamp the active :delay config onto a freshly-emitted note event so the
// post-pass (expandTrackDelays) can generate echoes from it.
function stampDelay(ev, trackState) {
  if (!(trackState.delayTicks > 0) || !trackState.delaySpec) return;
  const vels = resolveDelayVels(
    trackState.delaySpec,
    trackState.delayTicks,
    ev.args?.vel ?? 15,
  );
  if (vels && vels.length) ev._delay = { ticks: trackState.delayTicks, vels };
}

// v0.5 §1.5.3: compile-time delay expansion. Each note stamped with _delay
// emits echo copies at +k·spacing with the tap velocities. Written (source)
// notes outrank echoes: an echo overlapping any written note is dropped, so
// echoes only sound in the gaps the written part leaves (monophonic priority).
function expandTrackDelays(track) {
  const events = track.events;
  const NOTE_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON"]);
  const sources = events.filter((e) => e._delay && NOTE_CMDS.has(e.cmd));
  if (sources.length === 0) {
    for (const e of events) delete e._delay;
    return;
  }
  const occupied = events
    .filter((e) => NOTE_CMDS.has(e.cmd))
    .map((e) => {
      const len = e.args.gate ?? e.args.length ?? 0;
      return [e.tick, e.tick + len];
    });
  const collides = (t, len) =>
    occupied.some(([s, en]) => t < en && t + len > s);

  const echoes = [];
  for (const ev of sources) {
    const { ticks, vels } = ev._delay;
    const len = ev.args.gate ?? ev.args.length ?? 0;
    for (let k = 0; k < vels.length; k++) {
      const tick = ev.tick + (k + 1) * ticks;
      if (collides(tick, len)) continue;
      // Echoes inherit the source's articulation macros (keyon / semi / pitch /
      // op, each with its own :step). The vel macro is inherited but scaled so
      // this echo's tail peaks at its :delay-vels level; the dry note is left
      // untouched.
      const args = { ...ev.args };
      const dv = vels[k];
      if (args.velMacro) {
        const peak = velMacroPeak(args.velMacro);
        const ratio = peak > 0 ? dv / peak : 0;
        args.velMacro = scaleVelMacroSteps(args.velMacro, ratio);
      }
      if (dv === 15) delete args.vel;
      else args.vel = dv;
      echoes.push({ tick, cmd: ev.cmd, args, src: ev.src });
    }
  }
  for (const e of events) delete e._delay;
  if (echoes.length) {
    events.push(...echoes);
    events.sort((a, b) => a.tick - b.tick);
  }
}

// v0.5 :prio layering. Multiple forms of the same channel with different :prio
// values become independent parallel timelines; this post-pass flattens them
// into one monophonic event stream. Lower number = higher priority. Note events
// are resolved preemptively: a note is dropped where a higher-priority note is
// already sounding, and truncated (simple cut to silence) where a higher-priority
// note begins mid-sustain. All non-note events pass through in tick order, so
// loops/param automation on layered channels are best-effort only (warned below).
const PRIO_NOTE_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON"]);
const PRIO_FLOW_CMDS = new Set([
  "JUMP",
  "LOOP_BEGIN",
  "LOOP_END",
  "LOOP_BREAK",
]);

// Sounding span of a note: gate (if set) else length; 0 means hold
// indefinitely (§ gate/len 0), modelled here as occupying the channel forever.
function prioNoteSpan(ev) {
  const g = ev.args.gate;
  if (g === 0) return Infinity;
  if (g != null) return g;
  const l = ev.args.length;
  return l === 0 ? Infinity : (l ?? 0);
}

function flattenPriorityLayers(head, layers, diagnostics) {
  // Highest priority first (lowest number). The first layer is the container we
  // reuse for channel/scoreChannel; only its event list is rebuilt.
  layers.sort((a, b) => a.prio - b.prio);

  if (layers.filter((l) => l.trackData.events.some((e) => PRIO_FLOW_CMDS.has(e.cmd))).length > 1) {
    pushDiag(
      diagnostics,
      "warning",
      "W_PRIO_LAYER_FLOW",
      `loops/flow control across :prio layers on channel ${head} are not resolved; keep loops on a single layer`,
      { line: 1, column: 1 },
      head,
    );
  }

  const occupied = []; // committed sounding intervals from higher-priority layers
  const drop = new Set();

  for (const { trackData } of layers) {
    const notes = trackData.events
      .filter((e) => PRIO_NOTE_CMDS.has(e.cmd))
      .sort((a, b) => a.tick - b.tick);

    const committed = [];
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      const t = ev.tick;
      // Suppressed: starts while a higher-priority note is sounding.
      if (occupied.some(([s, e]) => t >= s && t < e)) {
        drop.add(ev);
        continue;
      }
      const rawEnd = t + prioNoteSpan(ev); // gate/len end (may be Infinity)
      const nextSame = notes[i + 1]?.tick ?? Infinity; // own retrigger ends it
      let nextHi = Infinity; // next higher-priority onset
      for (const [s] of occupied) if (s > t && s < nextHi) nextHi = s;
      // A higher-priority note interrupts before this note's natural end → cut
      // to silence (no release tail in this version).
      if (nextHi < rawEnd && nextHi < nextSame) ev.args.gate = nextHi - t;
      committed.push([t, Math.min(rawEnd, nextSame, nextHi)]);
    }
    occupied.push(...committed);
  }

  const base = layers[0].trackData;
  base.events = layers
    .flatMap((l) => l.trackData.events)
    .filter((ev) => !drop.has(ev))
    .sort((a, b) => a.tick - b.tick);
  return base;
}

function applyTypedMacroDef(trackState, td) {
  if (!td) return false;
  if (td.tag === "macro") {
    if (td.clear) clearMacroTarget(trackState, td.target);
    else applyMacroEntryToState(trackState, td.target, td.spec);
    return true;
  }
  if (td.tag === "macro-list") {
    for (const entry of td.entries || []) {
      if (!entry) continue;
      if (entry.clear) clearMacroTarget(trackState, entry.target);
      else applyMacroEntryToState(trackState, entry.target, entry.spec);
    }
    return true;
  }
  return false;
}

function parseSampleDef(root, diagnostics) {
  const bodyItems = root.items.filter((n) => n.kind !== "comment");
  const sample = {
    file: null,
    rate: null,
    offset: null,
    frames: null,
    loopStart: null,
    loopEnd: null,
    bitDepth: null,
    volume: null,
    compress: null,
    reverb: null,
  };

  for (let ki = 3; ki + 1 < bodyItems.length; ki += 2) {
    const key = atomValue(bodyItems[ki]);
    const rawVal = atomValue(bodyItems[ki + 1]);
    if (key === ":file") {
      sample.file = rawVal;
    } else if (key === ":rate") {
      const rate = parseIntLike(rawVal);
      if (rate !== null) sample.rate = rate;
    } else if (key === ":offset") {
      const offset = parseIntLike(rawVal);
      if (offset !== null) sample.offset = offset;
    } else if (key === ":frames") {
      const frames = parseIntLike(rawVal);
      if (frames !== null) sample.frames = frames;
    } else if (key === ":loop-start") {
      const loopStart = parseIntLike(rawVal);
      if (loopStart !== null) sample.loopStart = loopStart;
    } else if (key === ":loop-end") {
      const loopEnd = parseIntLike(rawVal);
      if (loopEnd !== null) sample.loopEnd = loopEnd;
    } else if (key === ":bit-depth") {
      const bitDepth = parseIntLike(rawVal);
      if (bitDepth !== null) sample.bitDepth = bitDepth;
    } else if (key === ":volume") {
      if (rawVal !== null) sample.volume = rawVal;
    } else if (key === ":compress") {
      if (rawVal !== null) sample.compress = rawVal;
    } else if (key === ":reverb") {
      if (rawVal !== null) sample.reverb = rawVal;
    }
  }

  if (!sample.file) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_FILE",
      "def :sample requires :file",
      nodeSrc(root),
      null,
    );
  }

  // :offset / :frames slice one file into many samples (a bank). Frames, not
  // bytes — like :loop-start/:loop-end, which stay relative to the slice.
  if (sample.offset !== null && sample.offset < 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_SLICE",
      `def :sample :offset must be >= 0 (got ${sample.offset})`,
      nodeSrc(root),
      null,
    );
  }
  if (sample.frames !== null && sample.frames <= 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_SLICE",
      `def :sample :frames must be > 0 (got ${sample.frames})`,
      nodeSrc(root),
      null,
    );
  }

  return sample;
}

function collectMacroEntriesFromItems(items, diagnostics, trackName) {
  const entries = [];
  // :step is position-free — one per macro applies to every target, regardless
  // of where it sits. Scan it out first; 2+ is an error (split into separate
  // (macro …) forms for multiple clocks).
  const macroStep = extractMacroStep(items, diagnostics, trackName);
  for (let ki = 0; ki + 1 < items.length; ki += 2) {
    // Target group: [:tl1 :tl2 ...] — expand to one entry per keyword,
    // sharing a single parsed spec (pure sugar; per-keyword `*` still applies).
    const group = macroTargetGroup(items[ki]);
    const syms = group ?? [atomValue(items[ki])];
    if (!group && !syms[0]?.startsWith(":")) continue;
    if (syms[0] === ":step") continue; // handled by extractMacroStep
    const isClear = atomValue(items[ki + 1]) === "none";
    for (const sym of syms) {
      // Trailing operator: `*` scales the target's static base, `+` adds to it
      // (e.g. `:vel*`/`:vel+`), instead of replacing.
      const { target: irTarget, op } = macroKeyword(sym);
      // `:target none` is a clear directive — valid inline, so valid in a def too.
      if (isClear) {
        entries.push({ target: irTarget, clear: true });
        continue;
      }
      // Parse per target so step values clamp to each target's own range —
      // exactly equivalent to writing the :target spec pair per target.
      // Relative (+/*) macros parse unclamped (signed offsets / ratios).
      const spec = parseMacroSpec(
        items[ki + 1],
        irTarget,
        diagnostics,
        trackName,
        !op,
        null,
        macroStep,
      );
      if (spec) {
        if (op && !macroOpOk(irTarget, op, sym, diagnostics, trackName)) continue;
        if (op) spec.op = op;
        if (macroStep) spec.step = macroStep;
        entries.push({ target: irTarget, spec });
      }
    }
  }
  return entries;
}

// Pull the single `:step` clock out of a macro's items (position-free). Returns
// the parsed step or null; pushes E_MACRO_STEP_DUP when more than one appears.
function extractMacroStep(items, diagnostics, trackName) {
  let step = null;
  let count = 0;
  for (let k = 0; k < items.length; k++) {
    if (atomValue(items[k]) !== ":step") continue;
    count++;
    if (count === 1 && k + 1 < items.length)
      step = parseStepToken(atomValue(items[k + 1]));
  }
  if (count > 1) {
    pushDiag(
      diagnostics,
      "error",
      "E_MACRO_STEP_DUP",
      "a macro takes at most one :step; use separate (macro …) forms for multiple clocks",
      null,
      trackName,
    );
  }
  return step;
}

// A bare value-slot operand (`$depth`) → its FROM_VAL-form name ("depth", or
// "$time" for the frame counter); null for anything that isn't a `$name` atom.
function scaleSlotName(node) {
  const v = atomValue(node);
  if (typeof v !== "string" || !v.startsWith("$")) return null;
  const name = v.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  return name === "time" ? "$time" : name;
}

// Recognize a scaled-macro expression `(* <signal> $slot)` (v0.6 §4.4): exactly
// one bare value-slot operand and one non-slot operand. Returns
// { signal, slot } (slot in FROM_VAL name form) or null. The caller evaluates
// `signal` to a signal spec and attaches `spec.scale = slot`.
function detectScaledMacro(node) {
  const items = node.items?.filter((n) => n.kind !== "comment") ?? [];
  if (atomValue(items[0]) !== "*" || items.length !== 3) return null;
  const s1 = scaleSlotName(items[1]);
  const s2 = scaleSlotName(items[2]);
  if (s1 && !s2) return { slot: s1, signal: items[2] };
  if (s2 && !s1) return { slot: s2, signal: items[1] };
  return null;
}

/**
 * Parse a :macro spec node for any target.
 * Accepts both step-vector [...] and curve (...) forms.
 * Steps are clamped with clampForTarget(target, n) — works for any target.
 * Returns { type: "steps", steps, loopIndex, releaseIndex }
 *      or { type: "curve", ...curveSpec }
 *      or { type: "stages", stages: [...] }  (multi-stage sequential)
 * or null if the node cannot be parsed.
 */
function parseMacroSpec(
  node,
  target,
  diagnostics = null,
  trackName = null,
  clamp = true,
  env = null, // body eval env, so `(let …)` bindings reach macro values
  step = null, // the macro's :step, for signal⊕signal materialization resolution
) {
  if (!node) return null;
  // Relative (+/*) macros carry signed offsets / ratios; leave them unclamped
  // here and clamp only after combining with the base (add/scaleMacroValues).
  const clampVal = (v) => (clamp ? clampForTarget(target, v) : v);
  // Step-vector or multi-stage form: [...]
  if (node.kind === "list" && node.bracket === "[]") {
    const items = node.items.filter((n) => n.kind !== "comment");

    // If all items are () expressions, treat as multi-stage sequential.
    // (Parser stores the bracket as the open+close pair, "()", not "(".)
    const allExprs =
      items.length > 0 &&
      items.every((it) => it.kind === "list" && it.bracket === "()");
    if (allExprs) {
      const stages = [];
      for (const stageNode of items) {
        const head = atomValue(stageNode.items?.[0]);
        if (head === "wait") {
          // (wait key-off) or (wait N) or (wait Nf)
          const arg = atomValue(stageNode.items?.[1]);
          if (arg === "key-off") {
            stages.push({ waitKeyOff: true });
          } else if (/^\d+f$/.test(arg)) {
            // Nf is a wall-clock frame count; carry the unit so the player's
            // frame branch schedules it directly (a stage wait is a local
            // sampler delay, not a timeline advance — tempo-independent).
            stages.push({ waitFrames: parseInt(arg, 10) });
          } else {
            const t = parseLengthToken(arg, null);
            stages.push({ waitTicks: t ?? 1 });
          }
          continue;
        }
        const curveSpec = parseCurveSpec(
          stageNode,
          diagnostics,
          nodeSrc(stageNode),
          trackName,
          true,
        );
        if (curveSpec) stages.push(curveSpec);
      }
      return { type: "stages", stages };
    }

    // Step-vector form: [15 :hold 14 13 :off 11 9 7 5 3 0 _ ...]
    // For MODE target, also accept noise mode symbols (white0-3, periodic0-3).
    // For PAN target, also accept pan symbols (left, center, right).
    const steps = [];
    let loopIndex = null;
    let releaseIndex = null;
    for (const item of items) {
      const val = atomValue(item);
      if (val === ":hold") {
        loopIndex = steps.length;
        continue;
      }
      if (val === ":off") {
        releaseIndex = steps.length;
        continue;
      }
      let n = parseIntLike(val);
      if (n === null && target === "NOISE_MODE" && val in NOISE_MODE_MAP) {
        n = NOISE_MODE_MAP[val];
      }
      if (n === null && target === "PAN" && val in PAN_MAP) {
        n = PAN_MAP[val];
      }
      if (n !== null) {
        steps.push(clampVal(n));
      } else if (val === "_") {
        steps.push(null); // hold: advance 1 frame, no write
      }
    }
    // src spans the whole `[...]` literal so the player can highlight the
    // sounding step sequence during playback.
    return { type: "steps", steps, loopIndex, releaseIndex, src: nodeSrc(node) };
  }
  // Curve form: (ease-out :from 15 :to 0 :len 1)
  if (node.kind === "list" && node.bracket === "()") {
    // Scaled macro (v0.6 §4.4, frame tier): `(macro :pitch (* (sin …) $depth))`
    // rides a value slot as a per-frame depth knob — the driver writes
    // `(sample × slot) >> 8` each frame. Detected here BEFORE evalValue, which
    // would otherwise error E_EVAL_NOT_LOWERABLE on the bare `$slot`. Shape:
    // `(* <signal> $slot)` (exactly two operands, one a value slot, one a
    // signal). The signal folds to a symbolic/materialized spec; `spec.scale`
    // carries the slot name (exporter → MMB flags bit2 + a slot byte).
    const scaled = detectScaledMacro(node);
    if (scaled) {
      const r = evalValue(
        scaled.signal,
        env ?? makeEnv(null),
        makeEvalCtx(
          diagnostics,
          trackName,
          nodeSrc(node),
          null,
          macroStepFramesForEval(step),
        ),
      );
      if (!r) return null;
      if (r.kind !== "signal") {
        pushDiag(
          diagnostics,
          "error",
          "E_EVAL_TYPE",
          "a scaled macro `(* signal $slot)` needs a signal operand (a curve/LFO), not a scalar",
          nodeSrc(node),
          trackName,
        );
        return null;
      }
      const base = r.spec.steps
        ? {
            type: "steps",
            steps: r.spec.steps,
            loopIndex: r.spec.loopIndex ?? null,
            releaseIndex: r.spec.releaseIndex ?? null,
          }
        : { type: "curve", ...r.spec };
      base.scale = scaled.slot;
      return base;
    }
    // Compile-time eval in macro position: `(macro :pitch (+ (sin …) 10))`
    // folds affinely to a symbolic curve (byte-identical LUT), and a scalar
    // expression becomes a constant signal. A bare curve head is disjoint from
    // eval heads, so it falls through to parseCurveSpec unchanged.
    if (isEvalHead(atomValue(node.items?.[0]))) {
      const r = evalValue(
        node,
        env ?? makeEnv(null),
        makeEvalCtx(
          diagnostics,
          trackName,
          nodeSrc(node),
          null,
          macroStepFramesForEval(step),
        ),
      );
      if (!r) return null;
      if (r.kind === "signal") {
        // A materialized signal⊕signal result is a float step vector; a symbolic
        // (affine-folded) curve stays a curve.
        return r.spec.steps
          ? {
              type: "steps",
              steps: r.spec.steps,
              loopIndex: r.spec.loopIndex ?? null,
              releaseIndex: r.spec.releaseIndex ?? null,
            }
          : { type: "curve", ...r.spec };
      }
      return {
        type: "steps",
        steps: [clampVal(r.value)],
        loopIndex: 0,
        releaseIndex: null,
      };
    }
    const curveSpec = parseCurveSpec(
      node,
      diagnostics,
      nodeSrc(node),
      trackName,
      true,
    );
    if (curveSpec) return { type: "curve", ...curveSpec };
  }
  // Scalar constant: e.g. `:keyon 1`. A constant signal equivalent to
  // `[:hold N]` (single value, looped). Mainly for :keyon (1 = fire every
  // :step, 0 = never).
  const scalar = parseIntLike(atomValue(node));
  if (scalar !== null) {
    return {
      type: "steps",
      steps: [clampVal(scalar)],
      loopIndex: 0,
      releaseIndex: null,
    };
  }
  return null;
}

function resolveShuffleTicks(nominalTicks, trackState) {
  if (
    trackState.shuffleRatio === 0 ||
    nominalTicks !== trackState.shuffleBase
  ) {
    return nominalTicks;
  }
  const pair = 2 * trackState.shuffleBase;
  const beat1 = Math.round((pair * trackState.shuffleRatio) / 100);
  const beat2 = pair - beat1;
  const ticks = trackState.subBeatParity === 0 ? beat1 : beat2;
  trackState.subBeatParity ^= 1;
  return ticks;
}

function isNoteAtom(val) {
  return typeof val === "string" && /^[a-g][+\-]?$/.test(val);
}

// Velocity shift atom: "v+", "v-", "v+8", "v-16" etc.
function isVelShiftAtom(val) {
  return typeof val === "string" && /^v[+\-]\d*$/.test(val);
}

// Octave shift atom: "o+", "o-", "o+2", "o-2" etc. (parallel to v±; complements
// the traditional < / > which shift by ±1).
function isOctShiftAtom(val) {
  return typeof val === "string" && /^o[+\-]\d*$/.test(val);
}

// Per-note length atom: note name + any valid length token suffix.
// Examples: c4, e8., f+12t, b-6f, a1/2
function parsePerNoteLength(val) {
  if (typeof val !== "string") return null;
  const m = val.match(/^([a-g][+\-]?)(.+)$/);
  if (!m) return null;
  const noteName = m[1];
  const lengthStr = m[2];
  const parsed = parseLengthToken(lengthStr, null);
  if (parsed === null) return null;
  return { noteName, lengthStr };
}

function isPerNoteLengthAtom(val) {
  return parsePerNoteLength(val) !== null;
}

/**
 * Parse an inline curve spec node, e.g. (ease-out :from 28 :to 20 :len 8).
 * Returns a PARAM_SWEEP args object or null if the node is not a curve form.
 */
function parseCurveSpec(
  node,
  diagnostics = null,
  src = null,
  trackName = null,
  requireCurve = false,
) {
  if (!node || node.kind !== "list" || !node.items || node.items.length === 0)
    return null;
  const head = atomValue(node.items[0]);
  if (!CURVE_NAMES.has(head)) {
    // A `(...)` in a value position must be a curve; an unknown head is a typo
    // (e.g. the literal word `curve`, or a misspelled easing name) — flag it
    // instead of silently falling through to a literal/zero. `[...]` step
    // vectors and non-list values are left to their own parsers.
    if (requireCurve && node.bracket === "()" && diagnostics) {
      pushDiag(
        diagnostics,
        "error",
        "E_UNKNOWN_CURVE",
        `unknown curve function: ${head ?? "(empty)"}`,
        src ?? nodeSrc(node),
        trackName,
      );
    }
    return null;
  }

  let from;
  let to;
  let frames;
  let lenFrames = false; // :len given as Nf (frames) vs ticks (note-length / Nt)
  let waitTicks = null;
  let waitKeyOff = false;
  let forceLoop = false;
  const params = {};
  let hasParams = false;
  // v0.5 dynamic macro params: $name in :from/:to/:rate records a runtime slot
  // source here (with a placeholder static value); the player resolves it at
  // note-on. `:len`/`:step` (which need a frame/tick unit) are not dynamic yet.
  const dyn = {};
  let hasDyn = false;
  const dynSrc = (v) =>
    typeof v === "string" && v.startsWith("$") ? v.slice(1) : null;

  // `const` is sugar for a flat segment: the positional value becomes
  // from = to, emitted as a (non-loop) linear curve (needs no new sampler).
  const isConst = head === "const";
  if (isConst) {
    const cval = parseNumberLike(atomValue(node.items[1]));
    if (cval !== null) {
      from = cval;
      to = cval;
    }
  }

  const COMMON_PARAM_KEYS = new Set([":phase", ":rate", ":wait"]);
  const LOOP_WAVE_PARAM_KEYS = new Set([":duty", ":skew"]);
  const STOCHASTIC_PARAM_KEYS = new Set([
    ":hold",
    ":jitter",
    ":beta",
    ":octaves",
    ":lacunarity",
    ":persistence",
    ":leak",
    ":seed",
  ]);
  const STOCHASTIC_CURVES = new Set(["noise", "pink", "perlin", "brown"]);
  const LOOP_WAVE_CURVES = new Set([
    "sin",
    "triangle",
    "square",
    "saw",
    "ramp",
  ]);

  const supportsParamKey = (curveName, key) => {
    if (COMMON_PARAM_KEYS.has(key)) return true;
    if (LOOP_WAVE_PARAM_KEYS.has(key)) return LOOP_WAVE_CURVES.has(curveName);
    if (!STOCHASTIC_PARAM_KEYS.has(key)) return false;
    if (!STOCHASTIC_CURVES.has(curveName)) return false;
    if (key === ":seed") return true; // all four stochastic curves
    if (key === ":beta") return curveName === "pink";
    if (key === ":octaves" || key === ":lacunarity" || key === ":persistence") {
      return curveName === "perlin";
    }
    if (key === ":leak") return curveName === "brown";
    return true;
  };

  const clampNum = (n, min, max) => Math.max(min, Math.min(max, n));
  const clampWithWarning = (n, min, max, key) => {
    const clamped = clampNum(n, min, max);
    if (
      diagnostics &&
      Number.isFinite(n) &&
      Number.isFinite(clamped) &&
      clamped !== n
    ) {
      pushDiag(
        diagnostics,
        "warning",
        "W_CURVE_PARAM_CLAMPED",
        `curve param ${key} out of range (${min}..${max}); clamped: ${n} -> ${clamped}`,
        src ?? nodeSrc(node),
        trackName,
      );
    }
    return clamped;
  };
  const setParam = (key, value) => {
    params[key] = value;
    hasParams = true;
  };

  let rangeUsed = false; // positional `A..B` seen (conflicts with :from/:to)
  for (let j = 1; j < node.items.length; j++) {
    const k = atomValue(node.items[j]);
    // Positional range sugar: `(sin -1..1 :rate 6 :len 4)` sets from/to.
    const range = !isConst && parseRangeToken(k);
    if (range) {
      if (rangeUsed || from !== undefined || to !== undefined) {
        if (diagnostics) {
          pushDiag(
            diagnostics,
            "error",
            "E_CURVE_RANGE_CONFLICT",
            `curve range ${k} conflicts with another range or :from/:to`,
            src ?? nodeSrc(node),
            trackName,
          );
        }
      } else {
        from = range.from;
        to = range.to;
        rangeUsed = true;
      }
      continue;
    }
    // A `..`-bearing token that is not a clean range is a range typo (no other
    // token contains `..`); flag it instead of silently ignoring it.
    if (!isConst && typeof k === "string" && k.includes("..") && diagnostics) {
      pushDiag(
        diagnostics,
        "error",
        "E_CURVE_RANGE_MALFORMED",
        `malformed range '${k}' (expected A..B)`,
        src ?? nodeSrc(node),
        trackName,
      );
      continue;
    }
    if (k === ":loop") {
      // Value-less flag: force this curve to loop (forward), e.g. so an easing
      // curve can be a cycling sustain stage.
      forceLoop = true;
      continue;
    }
    if (k && k.startsWith(":") && j + 1 < node.items.length) {
      const v = atomValue(node.items[j + 1]);
      if ((k === ":from" || k === ":to") && rangeUsed) {
        if (diagnostics) {
          pushDiag(
            diagnostics,
            "error",
            "E_CURVE_RANGE_CONFLICT",
            `${k} conflicts with the positional range on curve ${head}`,
            src ?? nodeSrc(node),
            trackName,
          );
        }
        j++;
        continue;
      }
      if (
        !supportsParamKey(head, k) &&
        k !== ":from" &&
        k !== ":to" &&
        k !== ":len"
      ) {
        if (diagnostics) {
          pushDiag(
            diagnostics,
            "error",
            "E_CURVE_PARAM_UNKNOWN",
            `unknown curve param ${k} for curve ${head}`,
            src ?? nodeSrc(node),
            trackName,
          );
        }
        j++;
        continue;
      }
      switch (k) {
        case ":from": {
          const s = dynSrc(v);
          if (s) {
            from = 0;
            dyn.from = s;
            hasDyn = true;
          } else from = parseNumberLike(v);
          break;
        }
        case ":to": {
          const s = dynSrc(v);
          if (s) {
            to = 0;
            dyn.to = s;
            hasDyn = true;
          } else to = parseNumberLike(v);
          break;
        }
        case ":len": {
          const s = dynSrc(v);
          if (s) {
            // Dynamic length: unit comes from the slot's def-val :unit; the
            // player resolves the frame/tick interpretation at note-on.
            frames = 1;
            dyn.len = s;
            hasDyn = true;
          } else {
            frames = parseLengthToken(v, null);
            lenFrames = /^\d+f$/.test(v); // Nf is an absolute frame count, not ticks
          }
          break;
        }
        case ":wait":
          if (v === "key-off") {
            waitKeyOff = true;
          } else {
            const t = parseLengthToken(v, null);
            if (t !== null) waitTicks = t;
          }
          break;
        case ":phase": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("phase", clampWithWarning(n, 0, 255, ":phase"));
          break;
        }
        case ":rate": {
          const s = dynSrc(v);
          if (s) {
            setParam("rate", 1);
            dyn.rate = s;
            hasDyn = true;
            break;
          }
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "rate",
              // 0 = freeze (no phase advance); matches the player's rate >= 0.
              clampWithWarning(n, 0, Number.MAX_VALUE, ":rate"),
            );
          break;
        }
        case ":duty": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("duty", clampWithWarning(n, 1, 255, ":duty"));
          break;
        }
        case ":skew": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("skew", clampWithWarning(n, -127, 127, ":skew"));
          break;
        }
        case ":hold": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam(
              "hold",
              clampWithWarning(n, 1, Number.MAX_SAFE_INTEGER, ":hold"),
            );
          break;
        }
        case ":jitter": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam("jitter", clampWithWarning(n, 0, 1, ":jitter"));
          break;
        }
        case ":beta": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "beta",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":beta"),
            );
          break;
        }
        case ":octaves": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("octaves", clampWithWarning(n, 1, 8, ":octaves"));
          break;
        }
        case ":lacunarity": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "lacunarity",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":lacunarity"),
            );
          break;
        }
        case ":persistence": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "persistence",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":persistence"),
            );
          break;
        }
        case ":leak": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam("leak", clampWithWarning(n, 0, 0.9999, ":leak"));
          break;
        }
        case ":seed": {
          // u32 seed for stochastic LUT regeneration (compile-time; default
          // 0xDEAD keeps seedless sources byte-identical). Independent
          // statistical sequence, unlike :phase (a shift of the same table).
          const n = parseIntLike(v);
          if (n !== null) setParam("seed", n >>> 0);
          break;
        }
      }
      j++;
    }
  }

  const spec = {
    curve: isConst ? "linear" : head,
    to: to ?? 0,
    loop: LOOP_CURVE_NAMES.has(head) || forceLoop,
  };
  if (from !== null && from !== undefined) spec.from = from;
  if (frames !== null && frames !== undefined) spec.frames = frames;
  if (lenFrames) spec.lenFrames = true;
  if (waitTicks !== null) spec.waitTicks = waitTicks;
  if (waitKeyOff) spec.waitKeyOff = true;
  if (hasParams) spec.params = params;
  if (hasDyn) spec.dyn = dyn;
  return spec;
}

function parseNumberLike(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Resolve a length in a structural position: a plain length-token atom, a
// `(ticks expr)` / `(frames expr)` unit bridge (§2.4), or a bare eval
// expression whose numeric result is a note denominator — `(+ 2 2)` ≡ `4` ≡ a
// quarter note, uniform with a literal number. Frames convert to ticks at the
// active tempo (like Nf, [[project-todo-2-nf-always-frame]]).
function resolveLengthNode(node, inherited, trackState, ctx, env) {
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

// Positional curve-range sugar: `A..B` → { from: A, to: B } (v0.6). Endpoints
// are signed decimals; `40..0` is a valid descending range. Returns null for
// anything that is not exactly a range token.
const RANGE_RE = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
function parseRangeToken(value) {
  if (typeof value !== "string") return null;
  const m = RANGE_RE.exec(value);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

// Inverse of pitchToMidi for `(note <midi>)` (§2.5): MIDI → { note name, octave }
// with sharps spelled `+`, matching the literal note grammar. C4 = 60.
const MIDI_NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
function midiToNoteParts(midi) {
  return {
    name: MIDI_NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
  };
}

// Build the context the compile-time evaluator needs (mmlisp-eval.js): the
// diagnostic sink, and callbacks that keep curve internals inside this module —
// `parseCurve` (a curve head → symbolic signal) and `mapMacroValues` (affine
// value-axis fold). Curve names are the set the evaluator dispatches signals on.
// Affine value-axis fold for the evaluator's symbolic signals. Unlike
// `mapMacroValues` (which keys on `spec.type`), a parseCurveSpec output is
// *type-less* (`{curve, from, to, …}`), so detect the shape by its fields. The
// curve branch mirrors mapMacroValues exactly (`from ?? 0`, `to ?? 0`) so a
// folded curve is byte-identical to the equivalent shifted literal.
function foldCurveValues(spec, fn) {
  if (Array.isArray(spec.steps)) {
    return { ...spec, steps: spec.steps.map((v) => (v == null ? v : fn(v))) };
  }
  if (Array.isArray(spec.stages)) {
    return {
      ...spec,
      stages: spec.stages.map((st) =>
        st && st.from !== undefined
          ? { ...st, from: fn(st.from), to: fn(st.to ?? 0) }
          : st,
      ),
    };
  }
  return { ...spec, from: fn(spec.from ?? 0), to: fn(spec.to ?? 0) };
}

// A name that would be a note-stream token cannot be a `let` binding name
// (E_LET_NAME) — bindings must not shadow the literal note grammar.
function isNoteStreamToken(name) {
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

function makeEvalCtx(diagnostics, trackName, src, typedDefs = null, stepFrames = 1) {
  return {
    pushDiag,
    diagnostics,
    trackName,
    src,
    curveNames: CURVE_NAMES,
    parseCurve: (n) => parseCurveSpec(n, diagnostics, nodeSrc(n), trackName, false),
    foldSignal: foldCurveValues,
    isNoteStreamToken,
    isDefName: (n) => !!typedDefs && typedDefs.has(n),
    stepFrames, // frame :step for signal⊕signal materialization (0 = tick, unsupported)
  };
}

// Frame count of a macro :step for materialization; a frame step passes through,
// a tick step is not lowerable yet (0 → E_EVAL_SIGNAL_STEP), default is 1f.
function macroStepFramesForEval(step) {
  if (step?.unit === "frame") return step.value;
  if (step?.unit === "tick") return 0;
  return 1;
}

// Build a tick-0-or-mid-track TEMPO_SWEEP event from a `(curve …)` value node,
// shared by inline `:tempo` and score-level `:tempo`. `fallbackFromBpm` is the
// sweep start when the curve omits `:from` (the current tempo). Returns
// `{ event, toBpm }` on success, or null (a diagnostic is pushed for a
// malformed curve; a non-curve node returns null silently for the caller to
// handle). `src`/`trackName` locate diagnostics.
function buildTempoSweepFromCurve(
  valueNode,
  tick,
  fallbackFromBpm,
  diagnostics,
  src,
  trackName,
) {
  if (
    !(
      valueNode?.kind === "list" &&
      valueNode.bracket === "()" &&
      valueNode.items?.length > 0
    )
  ) {
    return null;
  }
  const curveSpec = parseCurveSpec(valueNode, diagnostics, src, trackName, true);
  if (!curveSpec) return null;

  const from = parseNumberLike(String(curveSpec.from ?? ""));
  const to = parseNumberLike(String(curveSpec.to ?? ""));
  const len =
    Number.isFinite(Number(curveSpec.frames)) && Number(curveSpec.frames) > 0
      ? Number(curveSpec.frames)
      : null;
  const fromBpm = from ?? fallbackFromBpm;
  const toBpm = to;
  if (
    fromBpm !== null &&
    Number.isFinite(fromBpm) &&
    fromBpm > 0 &&
    toBpm !== null &&
    Number.isFinite(toBpm) &&
    toBpm > 0 &&
    len !== null &&
    len > 0
  ) {
    return {
      event: {
        tick,
        cmd: "TEMPO_SWEEP",
        args: {
          from: fromBpm,
          to: toBpm,
          len,
          curve: curveSpec.curve,
          params: curveSpec.params,
        },
        src,
      },
      toBpm,
    };
  }
  pushDiag(
    diagnostics,
    "error",
    "E_TEMPO_INVALID",
    "invalid :tempo curve; expected (<curve> :from N :to M :len L)",
    src,
    trackName,
  );
  return null;
}

function clampCsmRateHz(hz, diagnostics, src, trackName) {
  const min = 52;
  const max = 53270;
  const clamped = Math.max(min, Math.min(max, hz));
  if (clamped !== hz) {
    pushDiag(
      diagnostics,
      "warning",
      "W_CSM_RATE_CLAMPED",
      `:csm-rate ${hz}Hz out of range (${min}..${max}); clamped to ${clamped}Hz`,
      src,
      trackName,
    );
  }
  return clamped;
}

function csmPitchToHz(pitch) {
  const midi = pitchToMidi(pitch);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function csmTrackPitch(trackState, noteName, diagnostics, src, trackName) {
  let oct = trackState.defaultOct;
  if (oct > 10) {
    pushDiag(
      diagnostics,
      "warning",
      "W_CSM_RATE_OCT_CLAMPED",
      `fm3-csm-rate note octave ${oct} exceeds 10; clamped to 10 (use raw Hz literal above this range)`,
      src,
      trackName,
    );
    oct = 10;
  }
  return `${noteName}${Math.max(0, oct)}`;
}

export function canonicalTarget(symbol) {
  const map = {
    // Sequencer / level
    ":vol": "VOL",
    ":master": "MASTER",
    ":tempo-scale": "TEMPO_SCALE",
    ":pitch": "NOTE_PITCH",
    ":semi": "NOTE_SEMI",
    ":keyon": "KEYON",
    // LFO
    ":lfo-rate": "LFO_RATE",
    // FM channel-level
    ":alg": "FM_ALG",
    ":fb": "FM_FB",
    ":ams": "FM_AMS",
    ":fms": "FM_FMS",
    ":pan": "PAN",
    ":mode": "NOISE_MODE",
    // FM operator params — :tl1–:tl4, :ar1–:ar4, etc.
    ...[1, 2, 3, 4].reduce((acc, op) => {
      acc[`:tl${op}`] = `FM_TL${op}`;
      acc[`:ar${op}`] = `FM_AR${op}`;
      acc[`:dr${op}`] = `FM_DR${op}`;
      acc[`:sr${op}`] = `FM_SR${op}`;
      acc[`:rr${op}`] = `FM_RR${op}`;
      acc[`:sl${op}`] = `FM_SL${op}`;
      acc[`:ml${op}`] = `FM_ML${op}`;
      acc[`:dt${op}`] = `FM_DT${op}`;
      acc[`:ks${op}`] = `FM_KS${op}`;
      acc[`:am${op}`] = `FM_AMEN${op}`;
      acc[`:ssg${op}`] = `FM_SSG${op}`;
      return acc;
    }, {}),
  };
  return (
    map[symbol] || symbol.replace(/^:/, "").toUpperCase().replace(/-/g, "_")
  );
}

const FM_OP_PARAMS = [
  "AR",
  "DR",
  "SR",
  "RR",
  "SL",
  "TL",
  "KS",
  "ML",
  "DT",
  "SSG",
  "AMEN",
];

function createInitFmKwMap() {
  const kwMap = new Map([
    ["FM_ALG", 7],
    ["FM_FB", 0],
    ["FM_AMS", 0],
    ["FM_FMS", 0],
  ]);
  for (const op of [1, 2, 3, 4]) {
    kwMap.set(`FM_AR${op}`, 31);
    kwMap.set(`FM_DR${op}`, 0);
    kwMap.set(`FM_SR${op}`, 0);
    kwMap.set(`FM_RR${op}`, 15);
    kwMap.set(`FM_SL${op}`, 0);
    kwMap.set(`FM_TL${op}`, 0);
    kwMap.set(`FM_KS${op}`, 0);
    kwMap.set(`FM_ML${op}`, 1);
    kwMap.set(`FM_DT${op}`, 0);
    kwMap.set(`FM_SSG${op}`, 0);
    kwMap.set(`FM_AMEN${op}`, 0);
  }
  return kwMap;
}

function getVecInts(vecNode) {
  if (!vecNode || vecNode.kind !== "list") return [];
  return vecNode.items.map((item) => parseIntLike(atomValue(item)) ?? 0);
}

function emitVoice(td, tick, events, src, typedDefs, diagnostics) {
  if (td.tag === "fm") {
    emitFmPatch(td, tick, events, src);
    return true;
  }
  if (td.tag === "fm-kw") {
    const kwMap = td.extends
      ? resolveVoice(
          td.extends,
          typedDefs ?? new Map(),
          diagnostics ?? [],
          new Set(),
        )
      : new Map();
    if (kwMap) {
      // Merge child overrides on top of resolved base
      const merged = new Map(kwMap);
      for (const [k, v] of td.kwMap) merged.set(k, v);
      emitVoiceFromKwMap(merged, tick, events, src);
    } else {
      // Base resolution failed; emit child keys only
      emitVoiceFromKwMap(td.kwMap, tick, events, src);
    }
    return true;
  }
  return false;
}

// Resolve :extends chain into a flat kwMap of canonical param names → number.
// Returns null and emits a diagnostic on cycle/missing-base.
function resolveVoice(name, typedDefs, diagnostics, seen = new Set()) {
  if (seen.has(name)) {
    pushDiag(
      diagnostics,
      "error",
      "E_EXTENDS_CYCLE",
      `cycle detected in :extends chain: ${name}`,
      null,
      null,
    );
    return null;
  }
  seen.add(name);
  const td = typedDefs.get(name);
  if (!td || td.tag !== "fm-kw") {
    // Unknown or non-voice `:extend` base — error instead of silently emitting
    // the child's own keys only (which leaves a half-set, broken patch).
    pushDiag(
      diagnostics,
      "error",
      "E_EXTENDS_BASE_UNKNOWN",
      `:extend base '${name}' is not a defined FM voice`,
      null,
      null,
    );
    return null;
  }
  const base = td.extends
    ? resolveVoice(td.extends, typedDefs, diagnostics, seen)
    : new Map();
  if (base === null) return null;
  // Child overrides parent
  const merged = new Map(base);
  for (const [k, v] of td.kwMap) merged.set(k, v);
  return merged;
}

function emitVoiceFromKwMap(kwMap, tick, events, src) {
  const EMIT_KEYS = [
    "FM_ALG",
    "FM_FB",
    "FM_AMS",
    "FM_FMS",
    ...[1, 2, 3, 4].flatMap((op) => FM_OP_PARAMS.map((p) => `FM_${p}${op}`)),
  ];
  for (const target of EMIT_KEYS) {
    const value = kwMap.get(target);
    if (value !== undefined)
      events.push({ tick, cmd: "PARAM_SET", args: { target, value }, src });
  }
}

function emitFmPatch(td, tick, events, src) {
  const chVals = getVecInts(td.algFb);
  const [alg, fb] = chVals;
  if (alg !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_ALG", value: alg },
      src,
    });
  if (fb !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_FB", value: fb },
      src,
    });
  if (chVals[2] !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_AMS", value: chVals[2] },
      src,
    });
  if (chVals[3] !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_FMS", value: chVals[3] },
      src,
    });
  for (let op = 0; op < 4; op++) {
    const vals = getVecInts(td.ops[op]);
    FM_OP_PARAMS.forEach((pname, pi) => {
      if (vals[pi] !== undefined)
        events.push({
          tick,
          cmd: "PARAM_SET",
          args: { target: `FM_${pname}${op + 1}`, value: vals[pi] },
          src,
        });
    });
  }
}

function pushDiag(diagnostics, severity, code, message, src, track) {
  diagnostics.push({
    severity,
    code,
    message,
    line: src?.line ?? 1,
    column: src?.column ?? 1,
    track,
  });
}

// Source span for a node: { line, column } start plus { endLine, endColumn }
// end, all 1-based; endColumn is one past the last character. Lists carry their
// own end (from the parser); atom-likes span their literal text on one line.
function nodeSrc(node) {
  const src = { line: node.line, column: node.column };
  if (node.kind === "list") {
    src.endLine = node.endLine ?? node.line;
    src.endColumn = node.endColumn ?? node.column + 1;
  } else {
    const len = typeof node.value === "string" ? node.value.length : 1;
    src.endLine = node.line;
    src.endColumn = node.column + Math.max(1, len);
  }
  return src;
}

function parseSingleChannel(channelNode) {
  if (!channelNode) return "fm1";
  const val = atomValue(channelNode);
  return val ? val.replace(/^:/, "").toLowerCase() : "fm1";
}

function parseTrackHead(items) {
  const options = new Map();
  let i = 1;
  while (i < items.length) {
    const item = items[i];
    const val = atomValue(item);
    if (
      val &&
      item.kind === "atom" &&
      TRACK_OPTION_KEYS.has(val) &&
      i + 1 < items.length
    ) {
      options.set(val, items[i + 1]);
      i += 2;
    } else {
      break;
    }
  }
  return { options, bodyStart: i };
}

/**
 * Unified v0.4 channel body compiler.
 * Processes notes, rests, inline modifiers, and structural forms directly
 * from an indexed item list. All state (oct, len, gate, vol) is sticky:
 * modifications persist in trackState across items and across channel forms.
 */
function compileChannelBody(
  items,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
  loopCounter,
  vals,
  env = null,
) {
  // Lexical env for compile-time eval (`let`, step 4). Step 1 only ever sees
  // the empty root, but the parameter is threaded through the body recursions
  // now so later steps need no re-plumbing.
  const evalEnv = env ?? makeEnv(null);
  let i = 0;
  while (i < items.length) {
    const node = items[i];
    if (!node) {
      i++;
      continue;
    }

    // Skip comments
    if (node.kind === "comment") {
      i++;
      continue;
    }

    // ── Atom items ───────────────────────────────────────────────────────
    if (node.kind === "atom") {
      const val = node.value;

      // Label marker: #name
      if (val.startsWith("#")) {
        const id = val.slice(1);
        if (!id) {
          pushDiag(
            diagnostics,
            "error",
            "E_LABEL_EMPTY",
            "label name must not be empty",
            nodeSrc(node),
            trackName,
          );
        } else {
          events.push({
            tick: trackState.tick,
            cmd: "MARKER",
            args: { id },
            src: nodeSrc(node),
          });
        }
        i++;
        continue;
      }

      // Bar marker: | — an inspection aid, not a musical event. Records the
      // running tick and a 1-based ordinal so the editor can show a region's
      // span (difference between consecutive bars) and which bar a `|` is. No
      // meter/time-signature concept — songs may change meter freely. Emits
      // nothing to the event stream, so the driver is unaffected.
      if (val === "|") {
        const bars = (trackState.bars ??= []);
        bars.push({
          ordinal: bars.length + 1,
          tick: trackState.tick,
          line: node.line,
          column: node.column,
        });
        i++;
        continue;
      }

      // Inline keyword modifier: :oct N, :len N, :gate N, :vol N, :tl1 30, etc.
      if (val.startsWith(":")) {
        i++;
        if (i < items.length) {
          const rawVal = atomValue(items[i]);
          switch (val) {
            case ":oct":
            case ":oct+":
            case ":oct*": {
              // absolute / +add / *multiply against the running octave base
              const { op } = opSuffix(val);
              const bound = lookupBound(evalEnv, rawVal); // let-bound scalar
              const raw =
                typeof bound === "number"
                  ? bound
                  : op === "*"
                    ? parseFloat(rawVal)
                    : parseIntLike(rawVal);
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultOct;
                const next =
                  op === "+" ? cur + raw : op === "*" ? cur * raw : raw;
                trackState.defaultOct = Math.max(0, Math.round(next));
              }
              break;
            }
            case ":len":
              trackState.defaultLength = resolveLengthNode(
                items[i],
                trackState.defaultLength,
                trackState,
                makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                evalEnv,
              );
              break;
            case ":gate":
            case ":gate*":
            case ":gate-": {
              // `(ticks/frames …)` are absolute times → only meaningful for
              // `:gate`; ratios/cuts (`:gate*`/`:gate-`) keep the token parser.
              if (val === ":gate" && items[i]?.kind === "list") {
                const t = resolveLengthNode(
                  items[i],
                  0,
                  trackState,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                  evalEnv,
                );
                trackState.defaultGate = { type: "ticks", value: t };
                break;
              }
              const g = parseGateFamily(val, rawVal, trackState.currentTempo);
              if (g !== null) trackState.defaultGate = g;
              break;
            }
            case ":vol": {
              const valueNode = items[i];
              const curveSpec = parseCurveSpec(
                valueNode,
                diagnostics,
                nodeSrc(node),
                trackName,
                true,
              );
              if (curveSpec) {
                events.push({
                  tick: trackState.tick,
                  cmd: "PARAM_SWEEP",
                  args: { target: "VOL", ...curveSpec },
                  src: nodeSrc(node),
                });
              } else {
                const v = parseIntLike(rawVal);
                if (v !== null) {
                  // v0.4: :vol range is 0-31 (was 0-15)
                  trackState.defaultVol = Math.max(0, Math.min(31, v));
                  events.push({
                    tick: trackState.tick,
                    cmd: "PARAM_SET",
                    args: { target: "VOL", value: trackState.defaultVol },
                    src: nodeSrc(node),
                  });
                }
              }
              break;
            }
            case ":vel":
            case ":vel+":
            case ":vel*": {
              // per-note velocity (KEY-ON scoped, sticky): absolute / +add /
              // *multiply against the running vel base (default 15).
              const { op } = opSuffix(val);
              const bound = lookupBound(evalEnv, rawVal); // let-bound scalar
              const raw =
                typeof bound === "number"
                  ? bound
                  : op === "*"
                    ? parseFloat(rawVal)
                    : parseIntLike(rawVal);
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultVel ?? 15;
                const next =
                  op === "+" ? cur + raw : op === "*" ? cur * raw : raw;
                trackState.defaultVel = Math.max(0, Math.min(15, Math.round(next)));
              }
              break;
            }
            case ":master": {
              const valueNode = items[i];
              const curveSpec = parseCurveSpec(
                valueNode,
                diagnostics,
                nodeSrc(node),
                trackName,
                true,
              );
              if (curveSpec) {
                events.push({
                  tick: trackState.tick,
                  cmd: "PARAM_SWEEP",
                  args: { target: "MASTER", ...curveSpec },
                  src: nodeSrc(node),
                });
              } else {
                // global master level, score-wide
                const v = parseIntLike(rawVal);
                if (v !== null) {
                  events.push({
                    tick: trackState.tick,
                    cmd: "PARAM_SET",
                    args: {
                      target: "MASTER",
                      value: Math.max(0, Math.min(31, v)),
                    },
                    src: nodeSrc(node),
                  });
                }
              }
              break;
            }
            case ":csm-rate": {
              if (!trackState.isCsmTrack) break;
              const valueNode = items[i];
              const hz = parseNumberLike(rawVal);
              if (hz !== null) {
                emitCsmRateEvent(
                  trackState,
                  events,
                  diagnostics,
                  nodeSrc(node),
                  trackName,
                  { hz },
                  true,
                );
                break;
              }

              if (
                valueNode?.kind === "list" &&
                valueNode.bracket === "()" &&
                valueNode.items?.length > 0
              ) {
                const curveSpec = parseCurveSpec(
                  valueNode,
                  diagnostics,
                  nodeSrc(node),
                  trackName,
                  true,
                );
                if (!curveSpec) break;

                const from = parseNumberLike(String(curveSpec.from ?? ""));
                const to = parseNumberLike(String(curveSpec.to ?? ""));
                const len =
                  Number.isFinite(Number(curveSpec.frames)) &&
                  Number(curveSpec.frames) > 0
                    ? Number(curveSpec.frames)
                    : null;

                if (
                  from !== null &&
                  to !== null &&
                  Number.isFinite(from) &&
                  Number.isFinite(to) &&
                  len !== null &&
                  len > 0
                ) {
                  emitCsmRateEvent(
                    trackState,
                    events,
                    diagnostics,
                    nodeSrc(node),
                    trackName,
                    {
                      from,
                      to,
                      len,
                      curve: curveSpec.curve,
                      params: curveSpec.params,
                    },
                    true,
                  );
                } else {
                  pushDiag(
                    diagnostics,
                    "error",
                    "E_CSM_RATE_INVALID",
                    "invalid :csm-rate curve; expected (:curve :from N :to M :len L)",
                    nodeSrc(node),
                    trackName,
                  );
                }
              }
              break;
            }
            case ":tempo": {
              const valueNode = items[i];
              const bpm = parseNumberLike(rawVal);
              if (bpm !== null && bpm > 0) {
                trackState.currentTempo = bpm;
                events.push({
                  tick: trackState.tick,
                  cmd: "TEMPO_SET",
                  args: { bpm },
                  src: nodeSrc(node),
                });
                break;
              }

              const swept = buildTempoSweepFromCurve(
                valueNode,
                trackState.tick,
                trackState.currentTempo,
                diagnostics,
                nodeSrc(node),
                trackName,
              );
              if (swept) {
                trackState.currentTempo = swept.toBpm;
                events.push(swept.event);
              }
              break;
            }
            case ":sample": {
              if (!isTrackPcmActive(trackState)) break;
              if (rawVal) {
                trackState.pcmSampleName = rawVal;
              } else {
                pushDiag(
                  diagnostics,
                  "warning",
                  "E_PCM_SAMPLE_REQUIRED",
                  "pcm mode requires :sample <name>",
                  nodeSrc(node),
                  trackName,
                );
              }
              break;
            }
            case ":mode": {
              if (trackState.isNoiseTrack) {
                if (rawVal in NOISE_MODE_MAP) {
                  events.push({
                    tick: trackState.tick,
                    cmd: "PARAM_SET",
                    args: { target: "NOISE_MODE", value: NOISE_MODE_MAP[rawVal] },
                    src: nodeSrc(node),
                  });
                } else {
                  pushDiag(
                    diagnostics,
                    "error",
                    "E_NOISE_MODE_INVALID",
                    "noise :mode must be white0-3 or periodic0-3",
                    nodeSrc(node),
                    trackName,
                  );
                }
              } else if (trackState.isPcmTrack && isPcmModeSymbol(rawVal)) {
                trackState.pcmPendingMode = rawVal;
              } else {
                pushDiag(
                  diagnostics,
                  "error",
                  "E_PCM_MODE_INVALID",
                  trackState.isFm6Track
                    ? "fm6 is FM only; use pcm1-3 for PCM"
                    : "pcm :mode must be shot or loop",
                  nodeSrc(node),
                  trackName,
                );
              }
              break;
            }
            case ":break":
              // :break takes no value; the keyword path already stepped onto the
              // next token, so back up to leave it for the next iteration. Id is
              // the current (x …) loop, or null inside a #label…(go label N) loop
              // where convertCountedJumps assigns it after the forms merge.
              i--; // back up — :break has no value argument
              events.push({
                tick: trackState.tick,
                cmd: "LOOP_BREAK",
                args: { id: trackState.currentLoopId ?? null },
                src: nodeSrc(node),
              });
              break;
            default: {
              // Inline hardware param write: :tl1 30, :tl1+ 5, :tl1 $x, ...
              // Absolute literal → PARAM_SET; curve → PARAM_SWEEP; +/* operator
              // or $value → runtime PARAM_ADD/PARAM_MUL/PARAM_FROM_VAL.
              const { stem, op } = opSuffix(val);
              const target = canonicalTarget(stem);
              if (!SUPPORTED_TARGETS.has(target)) {
                // Unrecognized `:keyword` — a typo or a stray track-header option
                // used mid-body. Fail loudly instead of dropping it silently.
                pushDiag(
                  diagnostics,
                  "error",
                  "E_UNKNOWN_KEYWORD",
                  `unknown inline keyword: ${val}`,
                  nodeSrc(node),
                  trackName,
                );
                break;
              }
              if (!PARAM_SET_TARGETS.has(target)) {
                // A known macro keyword (:semi/:keyon) with no absolute-write
                // meaning — valid in a (macro …) but not as an inline write.
                pushDiag(
                  diagnostics,
                  "error",
                  "E_UNSUPPORTED_TARGET",
                  `${val} is macro-only; not an inline parameter write`,
                  nodeSrc(node),
                  trackName,
                );
                break;
              }
              const push = (cmd, args) =>
                events.push({
                  tick: trackState.tick,
                  cmd,
                  args,
                  src: nodeSrc(node),
                });
              if (!op && rawVal === "none") {
                // Stop a running inline PARAM_SWEEP, freezing the value.
                push("PARAM_SWEEP_STOP", { target });
                break;
              }
              // Dynamic value ($slot / $time) — runtime resolved.
              const ref = resolveValRef(
                rawVal,
                vals,
                diagnostics,
                trackName,
                nodeSrc(node),
              );
              if (ref !== null) {
                if (op === "+") push("PARAM_ADD", { target, delta: { src: ref } });
                else if (op === "*")
                  push("PARAM_MUL", { target, factor: { src: ref } });
                else push("PARAM_FROM_VAL", { target, src: ref });
                break;
              }
              // Relative literal: :tl1+ 5 / :tl1* 0.5 → runtime read-modify-write.
              if (op) {
                const n = op === "*" ? parseFloat(rawVal) : parseIntLike(rawVal);
                if (n !== null && !Number.isNaN(n)) {
                  if (op === "*") push("PARAM_MUL", { target, factor: n });
                  else push("PARAM_ADD", { target, delta: n });
                }
                break;
              }
              // Compile-time eval: a scalar expression folds to PARAM_SET
              // (`:tl1 (+ 20 10)`); an expression producing a signal — e.g.
              // affine `(+ (sin …) 10)` — folds to PARAM_SWEEP, byte-identical
              // to the shifted literal curve. Eval-builtin heads are disjoint
              // from curve names, so this precedes parseCurveSpec without
              // disturbing bare-curve dispatch.
              if (
                !op &&
                items[i]?.kind === "list" &&
                items[i].bracket === "()" &&
                isEvalHead(atomValue(items[i].items?.[0]))
              ) {
                // A `$ref`-bearing expression is a runtime value-machine write:
                // lower it to a param-opcode chain (§4.3). Pure-scalar / signal
                // expressions (no $ref) fold via evalValue as before.
                if (exprHasValRef(items[i])) {
                  lowerValueExpr(
                    items[i],
                    target,
                    push,
                    evalEnv,
                    vals,
                    diagnostics,
                    trackName,
                    nodeSrc(node),
                  );
                  break;
                }
                const r = evalValue(
                  items[i],
                  evalEnv,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                );
                if (r) {
                  if (r.kind === "signal" && r.spec.steps) {
                    // A materialized signal⊕signal step vector has no inline
                    // PARAM_SWEEP form — it's a macro-only shape.
                    pushDiag(
                      diagnostics,
                      "error",
                      "E_EVAL_SIGNAL_SHAPE",
                      `signal arithmetic ${val} is only valid in a (macro …), not an inline sweep`,
                      nodeSrc(node),
                      trackName,
                    );
                  } else if (r.kind === "signal") {
                    push("PARAM_SWEEP", { target, ...r.spec });
                  } else {
                    push("PARAM_SET", { target, value: Math.round(r.value) });
                  }
                }
                break;
              }
              // Bare let-bound scalar: `(let ((x 30)) :tl1 x …)`.
              if (!op) {
                const bound = lookupBound(evalEnv, rawVal);
                if (typeof bound === "number") {
                  push("PARAM_SET", { target, value: Math.round(bound) });
                  break;
                }
              }
              // Absolute: curve sweep or literal set.
              const curveSpec = parseCurveSpec(
                items[i],
                diagnostics,
                nodeSrc(node),
                trackName,
                true,
              );
              if (curveSpec) {
                push("PARAM_SWEEP", { target, ...curveSpec });
              } else {
                let value = parseIntLike(rawVal);
                if (value === null && target === "PAN" && rawVal in PAN_MAP)
                  value = PAN_MAP[rawVal];
                push("PARAM_SET", { target, value: value ?? 0 });
              }
              break;
            }
          }
          i++;
        }
        continue;
      }

      // Octave shift
      if (val === ">") {
        trackState.defaultOct = trackState.defaultOct + 1;
        i++;
        continue;
      }
      if (val === "<") {
        trackState.defaultOct = Math.max(0, trackState.defaultOct - 1);
        i++;
        continue;
      }
      // Octave shift atom: o+, o-, o+2, o-2 (parallel to v±)
      if (isOctShiftAtom(val)) {
        const sign = val[1] === "+" ? 1 : -1;
        const delta = val.length > 2 ? parseInt(val.slice(2), 10) : 1;
        trackState.defaultOct = Math.max(0, trackState.defaultOct + sign * delta);
        i++;
        continue;
      }

      // :break as standalone atom — emits LOOP_BREAK for the enclosing loop. Id
      // is the current (x …) loop, or null inside a `#label …(go label N)` loop
      // where convertCountedJumps assigns it after the forms merge.
      if (val === ":break") {
        events.push({
          tick: trackState.tick,
          cmd: "LOOP_BREAK",
          args: { id: trackState.currentLoopId ?? null },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Slur/tie connector: X ~ Y. Marks the next real note as connected to the
      // previous one — same pitch ties (extends), different pitch slurs (a
      // legato NOTE_ON: new pitch, no re-key). The flag attaches to the next
      // real note, skipping state tokens (`c ~ > d`). The connected note keeps
      // its own length, so `~` consumes none.
      if (val === "~") {
        trackState.pendingLegato = true;
        i++;
        continue;
      }

      // Rest atom: "_", "_4", "_4.", "_14t", "_16f"
      if (isRestAtom(val)) {
        const ticks = resolveShuffleTicks(
          parseRestLength(val, trackState.defaultLength, trackState.currentTempo),
          trackState,
        );
        events.push({
          tick: trackState.tick,
          cmd: "REST",
          args: { length: ticks },
          src: nodeSrc(node),
        });
        trackState.tick += ticks;
        trackState.tiedHead = null; // a rest ends the tied group
        i++;
        continue;
      }

      // Velocity shift: v+, v-, v+8, v-16
      if (isVelShiftAtom(val)) {
        const sign = val[1] === "+" ? 1 : -1;
        const delta = val.length > 2 ? parseInt(val.slice(2), 10) : 1;
        trackState.defaultVel = Math.max(
          0,
          Math.min(15, trackState.defaultVel + sign * delta),
        );
        i++;
        continue;
      }

      // Per-note length atom: c4, e8., f+12t, b-6f, a1/2
      if (isPerNoteLengthAtom(val)) {
        const { noteName, lengthStr } = parsePerNoteLength(val);
        const perNoteTicks = parseLengthToken(
          lengthStr,
          trackState.defaultLength,
          trackState.currentTempo,
        );
        emitNoteForTrack(
          trackState,
          noteName,
          perNoteTicks,
          events,
          diagnostics,
          nodeSrc(node),
          trackName,
        );
        i++;
        continue;
      }

      // Bare note: c, d, e, f, g, a, b (with optional + or -)
      if (isNoteAtom(val)) {
        const ticks = resolveShuffleTicks(trackState.defaultLength, trackState);
        emitNoteForTrack(
          trackState,
          val,
          ticks,
          events,
          diagnostics,
          nodeSrc(node),
          trackName,
        );
        i++;
        continue;
      }

      // Bare identifier: sample symbol in PCM mode
      if (isTrackPcmActive(trackState) && trackState.sampleDefs?.has(val)) {
        trackState.pcmSampleName = val;
        i++;
        continue;
      }

      // Bare identifier: typed def reference (voice/patch switch)
      if (typedDefs?.has(val)) {
        const td = typedDefs.get(val);
        if (!applyTypedMacroDef(trackState, td)) {
          emitVoice(
            td,
            trackState.tick,
            events,
            nodeSrc(node),
            typedDefs,
            diagnostics,
          );
        }
        i++;
        continue;
      }

      // Unknown atom: report as error (except fm3-csm-rate numeric shorthand).
      if (trackState.isCsmRateTrack) {
        const rawHz = parseNumberLike(val);
        if (rawHz !== null) {
          const ticks = resolveShuffleTicks(
            trackState.defaultLength,
            trackState,
          );
          emitCsmRateNoteHz(
            trackState,
            events,
            diagnostics,
            nodeSrc(node),
            trackName,
            rawHz,
            ticks,
          );
          trackState.tick += ticks;
          i++;
          continue;
        }
      }
      pushUnknownDiag(
        diagnostics,
        "E_UNKNOWN_ATOM",
        "Unknown token",
        node,
        trackName,
      );
      i++;
      continue;
    }

    // ── List items ───────────────────────────────────────────────────────
    if (node.kind === "list") {
      if (node.items.length === 0) {
        pushUnknownDiag(
          diagnostics,
          "E_UNKNOWN_LIST",
          "Unknown list form",
          node,
          trackName,
        );
        i++;
        continue;
      }
      const head = atomValue(node.items[0]);
      if (!head) {
        pushUnknownDiag(
          diagnostics,
          "E_UNKNOWN_LIST",
          "Unknown list form",
          node,
          trackName,
        );
        i++;
        continue;
      }

      // Tuplet: (t elem …) divides one current :len slot among its elements
      // using Bresenham distribution (remainders spread evenly).
      if (head === "t") {
        const elems = node.items
          .slice(1)
          .filter((ev) => ev?.kind !== "comment");
        const n = elems.length;
        if (n === 0) {
          pushDiag(
            diagnostics,
            "error",
            "E_TUPLET_EMPTY",
            "(t …) needs at least one element",
            nodeSrc(node),
            trackName,
          );
          i++;
          continue;
        }
        const totalTicks = trackState.defaultLength;
        let acc = 0;
        for (let j = 0; j < n; j++) {
          acc += totalTicks;
          const slotTicks = Math.floor(acc / n);
          acc -= slotTicks * n;
          const ev = elems[j];
          const evVal = atomValue(ev);
          if (evVal === "_") {
            events.push({
              tick: trackState.tick,
              cmd: "REST",
              args: { length: slotTicks },
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
          } else if (isPerNoteLengthAtom(evVal)) {
            const { noteName } = parsePerNoteLength(evVal);
            emitNoteForTrack(
              trackState,
              noteName,
              slotTicks,
              events,
              diagnostics,
              nodeSrc(ev),
              trackName,
            );
          } else if (isNoteAtom(evVal)) {
            emitNoteForTrack(
              trackState,
              evVal,
              slotTicks,
              events,
              diagnostics,
              nodeSrc(ev),
              trackName,
            );
          } else {
            pushUnknownDiag(
              diagnostics,
              "E_UNKNOWN_TUPLET_ELEM",
              "Unknown tuplet element",
              ev,
              trackName,
            );
          }
        }
        i++;
        continue;
      }

      // Repeat loop: (x N ...) counts N times; (x ...) loops forever
      // :break inside the body emits LOOP_BREAK linked to this loop's id
      if (head === "x") {
        const maybeCount = parseIntLike(atomValue(node.items[1]));
        const bodyStart = maybeCount !== null ? 2 : 1;
        const loopId = `_x${loopCounter.count++}`;
        const savedLoopId = trackState.currentLoopId;
        trackState.currentLoopId = maybeCount !== null ? loopId : null; // only counted loops support :break
        if (maybeCount !== null) {
          events.push({
            tick: trackState.tick,
            cmd: "LOOP_BEGIN",
            args: { id: loopId },
            src: nodeSrc(node.items[0]),
          });
          compileChannelBody(
            node.items.slice(bodyStart),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            evalEnv,
          );
          events.push({
            tick: trackState.tick,
            cmd: "LOOP_END",
            args: { id: loopId, repeat: maybeCount },
            src: nodeSrc(node.items[0]),
          });
          trackState.currentLoopId = savedLoopId;
        } else {
          events.push({
            tick: trackState.tick,
            cmd: "MARKER",
            args: { id: loopId },
            src: nodeSrc(node.items[0]),
          });
          compileChannelBody(
            node.items.slice(bodyStart),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            evalEnv,
          );
          trackState.currentLoopId = savedLoopId;
          events.push({
            tick: trackState.tick,
            cmd: "JUMP",
            args: { to: loopId },
            src: nodeSrc(node.items[0]),
          });
        }
        i++;
        continue;
      }

      // Jump: (go label) infinite, (go label N) repeats the #label..go section
      // N times then falls through (same loop as (x N …); see convertCountedJumps).
      if (head === "go") {
        const label = atomValue(node.items[1]);
        if (!label) {
          pushDiag(
            diagnostics,
            "error",
            "E_GO_NO_LABEL",
            "go requires a label",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        if (node.items.length < 2 || node.items.length > 3) {
          pushDiag(
            diagnostics,
            "error",
            "E_GO_ARITY",
            "go takes a label and an optional repeat count: (go label [N])",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        let repeat = null;
        if (node.items.length === 3) {
          repeat = parseIntLike(atomValue(node.items[2]));
          if (repeat === null || repeat < 1) {
            pushDiag(
              diagnostics,
              "error",
              "E_GO_COUNT",
              "go repeat count must be a positive integer",
              nodeSrc(node.items[0]),
              trackName,
            );
            i++;
            continue;
          }
        }
        events.push({
          tick: trackState.tick,
          cmd: "JUMP",
          args: repeat !== null ? { to: label, repeat } : { to: label },
          src: nodeSrc(node.items[0]),
        });
        i++;
        continue;
      }

      // Trigger: (trig N) — a music→game sync point. Emits the MARKER opcode
      // (0x42) with an explicit id N (0..63); the driver mirrors it into the
      // track's 68k-readable status byte (MB_TSTAT, driver.md §6.1). Unlike a
      // `#name` label it is never a JUMP target, so its id is emitted verbatim
      // rather than sequenced. The game polls MB_TSTAT and reads N.
      if (head === "trig") {
        if (node.items.length !== 2) {
          pushDiag(
            diagnostics,
            "error",
            "E_TRIG_ARITY",
            "trig takes one id: (trig N), N = 0..63",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        const code = parseIntLike(atomValue(node.items[1]));
        if (code === null || code < 0 || code > 63) {
          pushDiag(
            diagnostics,
            "error",
            "E_TRIG_RANGE",
            "trig id must be an integer 0..63 (MB_TSTAT is 6 bits)",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        events.push({
          tick: trackState.tick,
          cmd: "MARKER",
          args: { code },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Echo: (echo <target> <count> :by N [:back B]) — inline note-replay that
      // lengthens the phrase. Replays the single note B positions back (B=1 =
      // the last note), relative to that note's value; :vel adds, :vel*
      // multiplies. mucom `\=n1,n2` ≡ (echo :vel 1 :by -n2 :back n1).
      if (head === "echo") {
        const items = node.items;
        const tgt = atomValue(items[1]) || ":vel";
        const { stem, op } = opSuffix(tgt);
        const param = stem.replace(/^:/, "");
        let count = 1;
        let j = 2;
        const c0 = parseIntLike(atomValue(items[2]));
        if (c0 !== null) {
          count = Math.max(1, c0);
          j = 3;
        }
        let by = 0;
        let back = 1;
        for (; j + 1 < items.length; j += 2) {
          const key = atomValue(items[j]);
          const val = atomValue(items[j + 1]);
          if (key === ":by") by = parseFloat(val);
          else if (key === ":back")
            back = Math.max(1, parseIntLike(val) ?? 1);
        }
        if (param !== "vel") {
          pushDiag(
            diagnostics,
            "error",
            "E_ECHO_TARGET",
            `(echo …) supports :vel+/:vel* for now (got ${tgt})`,
            nodeSrc(items[0]),
            trackName,
          );
        } else if (!op) {
          pushDiag(
            diagnostics,
            "error",
            "E_ECHO_OP_REQUIRED",
            `(echo …) needs an operator: :vel+ (add) or :vel* (multiply)`,
            nodeSrc(items[0]),
            trackName,
          );
        } else {
          emitEchoReplay(
            trackState,
            events,
            { domain: op === "*" ? "mul" : "add", count, by, back },
            nodeSrc(node),
          );
        }
        i++;
        continue;
      }

      // Delay: (delay <target> <count> :by N :time T) parametric, or
      // (delay <target> [list|curve] :time T) explicit. Relative to the source
      // note; sticky (applies to following notes). (delay none) / (delay :vel none)
      // clear. Overlay/gap-filling (does not lengthen) via expandTrackDelays.
      if (head === "delay") {
        const items = node.items;
        const a1 = atomValue(items[1]);
        if (a1 === "none") {
          trackState.delaySpec = null;
          trackState.delayTicks = 0;
          i++;
          continue;
        }
        const { stem, op } = opSuffix(a1 || ":vel");
        const param = stem.replace(/^:/, "");
        const mode = op === "*" ? "mul" : "add";
        const a2node = items[2];
        const a2 = atomValue(a2node);
        if (param !== "vel") {
          pushDiag(
            diagnostics,
            "error",
            "E_DELAY_TARGET",
            `(delay …) supports :vel/:vel* for now (got ${a1})`,
            nodeSrc(items[0]),
            trackName,
          );
          i++;
          continue;
        }
        if (a2 === "none") {
          trackState.delaySpec = null;
          trackState.delayTicks = 0;
          i++;
          continue;
        }
        // Setting (not clearing) a relative delay requires an operator.
        if (!op) {
          pushDiag(
            diagnostics,
            "error",
            "E_DELAY_OP_REQUIRED",
            `(delay …) needs an operator: :vel+ (add) or :vel* (multiply)`,
            nodeSrc(items[0]),
            trackName,
          );
          i++;
          continue;
        }
        // 2nd arg: number = tap count (+:by); [list]/(curve) = explicit.
        let spec = null;
        if (a2node?.kind === "list" && a2node.bracket === "[]") {
          const list = a2node.items
            .filter((n) => n.kind !== "comment")
            .map((n) => parseFloat(atomValue(n)))
            .filter((v) => !isNaN(v));
          spec = { mode, type: "list", list };
        } else if (a2node?.kind === "list" && a2node.bracket === "()") {
          const cv = parseCurveSpec(a2node, diagnostics, nodeSrc(node), trackName, true);
          if (cv) spec = { mode, type: "curve", ...cv };
        } else if (parseIntLike(a2) !== null) {
          spec = { mode, type: "param", count: Math.max(1, parseIntLike(a2)) };
        }
        let time = null;
        for (let j = 3; j + 1 < items.length; j += 2) {
          const key = atomValue(items[j]);
          const val = atomValue(items[j + 1]);
          if (key === ":by" && spec?.type === "param") spec.by = parseFloat(val);
          else if (key === ":time")
            time = parseLengthToken(val, null, trackState.currentTempo);
        }
        if (spec && time !== null && time > 0) {
          trackState.delaySpec = spec;
          trackState.delayTicks = time;
        } else {
          pushDiag(
            diagnostics,
            "error",
            "E_DELAY_ARGS",
            "(delay …) needs a count/[list]/(curve) and :time T",
            nodeSrc(items[0]),
            trackName,
          );
        }
        i++;
        continue;
      }

      // Glide: (glide <time>) portamento from the previous note;
      // (glide <from-pitch> <time>) sets an explicit start pitch; (glide none) off.
      if (head === "glide") {
        const items = node.items;
        const has2 = items.length >= 3;
        if (has2) trackState.glideFrom = atomValue(items[1]);
        const tv = atomValue(items[has2 ? 2 : 1]);
        // `none` disables glide (off-unification: none = clear a feature).
        const t =
          tv === "none"
            ? 0
            : parseLengthToken(tv, null, trackState.currentTempo);
        if (t !== null) trackState.glide = Math.max(0, t);
        i++;
        continue;
      }

      // Macro: (macro :target spec [:target spec …] [:step clk]) inline envelope;
      // (macro none) clears all, (macro :vel none) clears one; bare def names and
      // def references may be mixed in. Runtime within-note envelope.
      if (head === "macro") {
        const rest = node.items.slice(1).filter((n) => n.kind !== "comment");
        if (rest.length === 1 && atomValue(rest[0]) === "none") {
          trackState.activeMacros = {};
          i++;
          continue;
        }
        let j = 0;
        // :step is position-free — one per macro applies to every target.
        const macroStep = extractMacroStep(rest, diagnostics, trackName);
        while (j < rest.length) {
          const sym = atomValue(rest[j]);
          const group = macroTargetGroup(rest[j]);
          if (sym === ":step") {
            j += j + 1 < rest.length ? 2 : 1; // consumed above
          } else if (group || sym?.startsWith(":")) {
            if (j + 1 < rest.length) {
              const isClear = atomValue(rest[j + 1]) === "none";
              // Target group [:tl1 :tl2 ...] applies the one spec (or clear)
              // to every keyword — sugar for writing the pair per target.
              for (const groupSym of group ?? [sym]) {
                const { target, op } = macroKeyword(groupSym);
                if (isClear) {
                  clearMacroTarget(trackState, target);
                  continue;
                }
                const spec = parseMacroSpec(
                  rest[j + 1],
                  target,
                  diagnostics,
                  trackName,
                  !op,
                  evalEnv,
                  macroStep,
                );
                if (spec && macroStep) spec.step = macroStep;
                if (
                  spec &&
                  op &&
                  !macroOpOk(target, op, groupSym, diagnostics, trackName)
                ) {
                  // +/* misused — diagnostic pushed; drop this entry.
                } else {
                  if (spec && op) spec.op = op;
                  applyMacroEntryToState(trackState, target, spec);
                }
              }
              j += 2;
            } else j++;
          } else if (sym && typedDefs?.has(sym)) {
            applyTypedMacroDef(trackState, typedDefs.get(sym));
            j++;
          } else j++;
        }
        i++;
        continue;
      }

      // Param set: (param-set :target value ...)
      if (head === "param-set") {
        let j = 1;
        while (j + 1 < node.items.length) {
          const targetNode = node.items[j];
          const valueNode = node.items[j + 1];
          const target = canonicalTarget(atomValue(targetNode));
          // Value may be a compile-time eval form: (param-set :tl1 (+ 20 10)).
          let value;
          if (
            valueNode?.kind === "list" &&
            valueNode.bracket === "()" &&
            isEvalHead(atomValue(valueNode.items?.[0]))
          ) {
            const scalar = evalScalarValue(
              valueNode,
              evalEnv,
              makeEvalCtx(diagnostics, trackName, nodeSrc(targetNode), typedDefs),
            );
            value = scalar === null ? 0 : Math.round(scalar);
          } else {
            const bound = lookupBound(evalEnv, atomValue(valueNode));
            value =
              typeof bound === "number"
                ? Math.round(bound)
                : parseIntLike(atomValue(valueNode)) ?? 0;
          }
          if (!PARAM_SET_TARGETS.has(target)) {
            pushDiag(
              diagnostics,
              "error",
              "E_UNSUPPORTED_TARGET",
              `Unsupported param-set target: ${target}`,
              nodeSrc(targetNode),
              trackName,
            );
          }
          events.push({
            tick: trackState.tick,
            cmd: "PARAM_SET",
            args: { target, value },
            src: nodeSrc(targetNode),
          });
          j += 2;
        }
        i++;
        continue;
      }

      // Item-position `let` (§7): bind, then compile the body in the extended
      // env, spliced in place so sticky state behaves as if unwrapped.
      if (head === "let") {
        const childEnv = evalLet(
          node,
          evalEnv,
          makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
        );
        if (childEnv) {
          compileChannelBody(
            node.items.slice(2).filter((n) => n.kind !== "comment"),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            childEnv,
          );
        }
        i++;
        continue;
      }

      // `(note expr [len])` (§2.5): a computed absolute-pitch NOTE_ON.
      if (head === "note") {
        emitEvalNote(node, trackState, events, diagnostics, trackName, typedDefs, evalEnv);
        i++;
        continue;
      }

      pushUnknownDiag(
        diagnostics,
        "E_UNKNOWN_LIST",
        "Unknown list form",
        node,
        trackName,
      );
      i++;
      continue;
    }

    pushUnknownDiag(
      diagnostics,
      "E_UNKNOWN_NODE",
      "Unknown channel-body node",
      node,
      trackName,
    );
    i++;
  }
}

// Turn a counted backward jump — `(go label N)` -> JUMP { to, repeat } — plus
// its `#label` MARKER into the same LOOP_BEGIN/LOOP_END pair that `(x N …)`
// emits, so the loader's `_expandLoops` (nesting, count, :break) handles both.
// Runs on a track's merged events, so the label and the `go` may come from
// different `(fmN …)` forms (mucom multi-line loops). Count-less JUMPs (infinite
// `(go label)` / `#loop`) are left untouched for the track-level loop.
function convertCountedJumps(track) {
  const events = track.events;
  if (!events) return;
  // Left-to-right so an inner counted loop is converted before its outer one;
  // that claims inner :break (LOOP_BREAK id:null) for the inner loop first.
  for (let j = 0; j < events.length; j++) {
    const ev = events[j];
    if (ev.cmd !== "JUMP" || ev.args?.repeat == null) continue;
    const id = ev.args.to;
    let m = -1;
    for (let k = j - 1; k >= 0; k--) {
      if (events[k].cmd === "MARKER" && events[k].args?.id === id) { m = k; break; }
    }
    if (m < 0) continue; // no backward marker — leave for validateTrack to flag
    events[m] = { ...events[m], cmd: "LOOP_BEGIN", args: { id } };
    events[j] = { ...ev, cmd: "LOOP_END", args: { id, repeat: ev.args.repeat } };
    for (let k = m + 1; k < j; k++) {
      if (events[k].cmd === "LOOP_BREAK" && events[k].args?.id == null) {
        events[k] = { ...events[k], args: { ...events[k].args, id } };
      }
    }
  }
}

function validateTrack(track, diagnostics) {
  const markers = new Map();
  const pendingJumps = [];

  for (const e of track.events) {
    // `(trig N)` markers carry an explicit `code` and no label `id`; they are
    // never JUMP targets, so they are exempt from the label-uniqueness check.
    if (e.cmd === "MARKER" && e.args?.code == null) {
      const id = e.args?.id;
      if (markers.has(id)) {
        pushDiag(
          diagnostics,
          "error",
          "E_MARKER_DUP",
          `Duplicate marker id: ${id}`,
          e.src,
          track.scoreChannel,
        );
      } else {
        markers.set(id, true);
      }
    }
    if (e.cmd === "JUMP") {
      pendingJumps.push(e);
    }
  }

  for (const j of pendingJumps) {
    if (!markers.has(j.args.to)) {
      pushDiag(
        diagnostics,
        "error",
        "E_JUMP_UNRESOLVED",
        `Jump target marker not found: ${j.args.to}`,
        j.src,
        track.scoreChannel,
      );
    } else if (j.args.repeat != null) {
      // A counted `(go label N)` whose marker is forward: convertCountedJumps
      // only rewrites *backward* counted jumps into LOOP_BEGIN/LOOP_END, so this
      // survived as a raw JUMP the player would loop with `repeat` ignored.
      // Forward counted jumps are unsupported (only backward `(go head N)` and
      // infinite `(go label)` are).
      pushDiag(
        diagnostics,
        "error",
        "E_GO_FORWARD_COUNT",
        `forward counted jump unsupported: (go ${j.args.to} ${j.args.repeat}) — the marker must precede the go`,
        j.src,
        track.scoreChannel,
      );
    }
  }
}

function buildSourceMap(tracks) {
  const lineToTick = new Map();
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      const line = ev.src?.line;
      if (line == null) continue;
      const cur = lineToTick.get(line);
      if (cur === undefined || ev.tick < cur) lineToTick.set(line, ev.tick);
    }
  }
  return [...lineToTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, tick]) => ({ line, tick }));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortObject(value[key]);
    return out;
  }
  return value;
}

function collectDefs(roots, diagnostics) {
  const defs = new Map();
  const paramDefs = new Map(); // (def (name param…) body…) parametric snippets
  const typedDefs = new Map();
  const sampleDefs = new Map();
  const vals = new Map(); // v0.5: (def-val name init) runtime value slots
  const fileMeta = { title: null, author: null }; // v0.6: (def title/author "…")
  const imports = []; // v0.6 Phase 2: (import "path") — [{path, src}]
  const remaining = [];

  for (const root of roots) {
    if (root.kind !== "list" || root.items.length < 2) {
      remaining.push(root);
      continue;
    }
    const head = atomValue(root.items[0]);

    // (import "path") — compile-time merge of another file's defs (v0.6 Phase 2).
    // The host resolves the path to source text (relative to the importing file)
    // before compileMMLisp; here we only record it. Only the string-literal form
    // is an import; anything else keeps flowing to the unknown-form checks.
    if (head === "import") {
      const pathNode = root.items[1];
      if (pathNode?.kind !== "string" || typeof pathNode.value !== "string") {
        pushDiag(
          diagnostics,
          "error",
          "E_IMPORT_PATH",
          "import path must be a string literal, e.g. (import \"voices/brass.mmlisp\")",
          nodeSrc(root),
          null,
        );
        continue;
      }
      imports.push({ path: pathNode.value, src: nodeSrc(root) });
      continue;
    }

    // (def-val name init :min M :max X) — declare a runtime value slot (Tier
    // 0/1 dynamic value). init is the default; :min/:max bound the live control
    // (the Dynamic Parameters sliders). Slots are indexed in declaration order.
    if (head === "def-val") {
      const name = atomValue(root.items[1]);
      if (!name || name.startsWith("$")) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEFVAL_NAME",
          "def-val name must be a plain symbol (no $ prefix)",
          nodeSrc(root),
          null,
        );
        continue;
      }
      // Optional positional init (item[2]); absent when options start there
      // (e.g. `(def-val x :from 0 :to -127)`), then init defaults to `from`.
      const initPos = parseIntLike(atomValue(root.items[2]));
      let from;
      let to;
      let minOpt;
      let maxOpt;
      let step = 1; // slider granularity (control resolution)
      let unit = "frame"; // time unit when this slot feeds :len/:step
      let k = initPos === null ? 2 : 3;
      // Positional range sugar: `(def-val amp 24 0..127)` ≡ `:from 0 :to 127`.
      const range = parseRangeToken(atomValue(root.items[k]));
      if (range) {
        from = range.from;
        to = range.to;
        k += 1;
      }
      for (; k + 1 < root.items.length; k += 2) {
        const key = atomValue(root.items[k]);
        const raw = atomValue(root.items[k + 1]);
        if (key === ":unit") {
          if (raw === "frame" || raw === "tick") unit = raw;
          continue;
        }
        const v = parseIntLike(raw);
        if (v === null) continue;
        if (key === ":from") from = v;
        else if (key === ":to") to = v;
        else if (key === ":min") minOpt = v;
        else if (key === ":max") maxOpt = v;
        else if (key === ":step" && v > 0) step = v;
      }
      // `:from`/`:to` are order-free directional endpoints (from = the start,
      // so a slider runs from → to); `:min`/`:max` are accepted synonyms.
      let min;
      let max;
      let reversed = false;
      if (from !== undefined || to !== undefined) {
        const a = from ?? 0;
        const b = to ?? 0;
        min = Math.min(a, b);
        max = Math.max(a, b);
        reversed = a > b;
      } else {
        min = minOpt ?? 0;
        max = maxOpt ?? 127;
      }
      const init = initPos ?? from ?? min;
      if (!vals.has(name))
        vals.set(name, {
          name,
          slot: vals.size,
          init,
          min,
          max,
          step,
          reversed,
          unit,
        });
      continue;
    }

    if (head === "def") {
      // Parametric snippet def: (def (name param…) body…). Token substitution
      // only — no computation; params shadow note/length tokens inside the body.
      const nameNode = root.items[1];
      if (nameNode?.kind === "list") {
        const sig = nameNode.items.filter((n) => n.kind !== "comment");
        const pname = atomValue(sig[0]);
        if (!pname) {
          pushDiag(
            diagnostics,
            "error",
            "E_DEF_NAME",
            "parametric def name must be a symbol",
            nodeSrc(root),
            null,
          );
          continue;
        }
        if (isReservedHead(pname)) {
          pushDiag(
            diagnostics,
            "error",
            "E_DEF_RESERVED",
            `'${pname}' is a reserved eval builtin and cannot be a def name`,
            nodeSrc(root),
            null,
          );
          continue;
        }
        const params = sig
          .slice(1)
          .map((n) => atomValue(n))
          .filter(Boolean);
        const body = root.items.slice(2).filter((n) => n.kind !== "comment");
        paramDefs.set(pname, { params, body, src: nodeSrc(root) });
        continue;
      }
      const name = atomValue(root.items[1]);
      if (!name) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEF_NAME",
          "def name must be a symbol",
          nodeSrc(root),
          null,
        );
        continue;
      }
      if (isReservedHead(name)) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEF_RESERVED",
          `'${name}' is a reserved eval builtin and cannot be a def name`,
          nodeSrc(root),
          null,
        );
        continue;
      }
      // Reserved file-metadata defs (v0.6, replaces the score option tier):
      // (def title "…") / (def author "…"). Only the string form is metadata;
      // any other value keeps the name available as an ordinary def.
      if (
        (name === "title" || name === "author") &&
        root.items[2]?.kind === "string"
      ) {
        fileMeta[name] = root.items[2].value;
        continue;
      }
      const maybeTag = atomValue(root.items[2]);
      const macroFnNode = root.items[2];
      if (
        macroFnNode?.kind === "list" &&
        atomValue(macroFnNode.items?.[0]) === "macro"
      ) {
        // (def name (macro :target spec …))
        const src = nodeSrc(root);
        const entries = collectMacroEntriesFromItems(
          macroFnNode.items.slice(1).filter((n) => n.kind !== "comment"),
          diagnostics,
          name,
        );
        if (entries.length === 1) {
          typedDefs.set(name, { tag: "macro", ...entries[0], src });
        } else if (entries.length > 1) {
          typedDefs.set(name, { tag: "macro-list", entries, src });
        }
      } else if (maybeTag === ":sample") {
        const src = nodeSrc(root);
        const sample = parseSampleDef(root, diagnostics);
        sampleDefs.set(name, { tag: "sample", ...sample, src });
      } else if (maybeTag === ":extend") {
        // Keyword-map FM voice def with inheritance
        // (def child :extend base :alg 7 :tl1 20 ...)
        const src = nodeSrc(root);
        const bodyItems = root.items.filter((n) => n.kind !== "comment");
        const baseName = atomValue(bodyItems[3]);
        const kwMap = new Map();
        for (let ki = 4; ki + 1 < bodyItems.length; ki += 2) {
          const kwSym = atomValue(bodyItems[ki]);
          const kwVal = parseIntLike(atomValue(bodyItems[ki + 1]));
          if (kwSym?.startsWith(":") && kwVal !== null) {
            kwMap.set(canonicalTarget(kwSym), kwVal);
          }
        }
        typedDefs.set(name, { tag: "fm-kw", extends: baseName, kwMap, src });
      } else if (
        maybeTag?.startsWith(":alg") ||
        maybeTag?.startsWith(":fb") ||
        maybeTag?.startsWith(":ar") ||
        maybeTag?.startsWith(":tl") ||
        maybeTag?.startsWith(":dr") ||
        maybeTag?.startsWith(":sr") ||
        maybeTag?.startsWith(":rr")
      ) {
        // Keyword-map FM voice def without :fm tag (bare keyword form)
        // (def my-patch :alg 7 :fb 0 :tl1 20 ...)
        const src = nodeSrc(root);
        const bodyItems = root.items.filter((n) => n.kind !== "comment");
        const kwMap = new Map();
        for (let ki = 2; ki + 1 < bodyItems.length; ki += 2) {
          const kwSym = atomValue(bodyItems[ki]);
          const kwVal = parseIntLike(atomValue(bodyItems[ki + 1]));
          if (kwSym?.startsWith(":") && kwVal !== null) {
            kwMap.set(canonicalTarget(kwSym), kwVal);
          }
        }
        typedDefs.set(name, { tag: "fm-kw", extends: null, kwMap, src });
      } else {
        defs.set(
          name,
          root.items.slice(2).filter((n) => n.kind !== "comment"),
        );
      }
      continue;
    }

    remaining.push(root);
  }

  return { defs, paramDefs, typedDefs, sampleDefs, vals, fileMeta, imports, remaining };
}

// v0.6 Phase 2: the four def namespaces `import` folds across files. def-val
// slots and tracks are deliberately NOT imported (a slot's index is the
// importing file's host-visible layout; tracks are songs, not a library).
const IMPORT_DEF_KINDS = ["defs", "paramDefs", "typedDefs", "sampleDefs"];

// Scan source text for its top-level (import "path") forms. Exported so the host
// can drive async file resolution (recursing through nested imports) before the
// synchronous compileMMLisp — the compiler itself never does I/O.
export function collectImports(src) {
  const parsed = parse(src);
  const paths = [];
  for (const root of parsed) {
    if (root.kind !== "list" || root.items.length < 2) continue;
    if (atomValue(root.items[0]) !== "import") continue;
    const pathNode = root.items[1];
    if (pathNode?.kind === "string" && typeof pathNode.value === "string")
      paths.push(pathNode.value);
  }
  return paths;
}

// Merge `incoming` def bundle into `base` with strict conflict detection. A name
// already present for the same kind is E_IMPORT_CONFLICT *only if it traces back
// to a different origin file* — a diamond (two imports pulling in the same third
// file) resolves to one origin and dedups silently. Used to fold sibling imports.
function mergeImportsStrict(base, incoming, diagnostics, conflictSrc) {
  for (const kind of IMPORT_DEF_KINDS) {
    for (const [name, def] of incoming[kind]) {
      const incomingOrigin = incoming.origin[kind].get(name);
      if (base[kind].has(name)) {
        if (base.origin[kind].get(name) === incomingOrigin) continue; // diamond
        pushDiag(
          diagnostics,
          "error",
          "E_IMPORT_CONFLICT",
          `'${name}' is defined by more than one imported file`,
          conflictSrc,
          null,
        );
        continue;
      }
      base[kind].set(name, def);
      base.origin[kind].set(name, incomingOrigin);
    }
  }
}

// Overlay a file's *own* defs onto `base` for the four def kinds; they silently
// win (the importing file overrides imported defaults). `originPath` tags each
// entry so a later strict merge can tell diamonds from true conflicts.
function overlayDefs(base, own, originPath) {
  for (const kind of IMPORT_DEF_KINDS) {
    for (const [name, def] of own[kind]) {
      base[kind].set(name, def);
      base.origin[kind].set(name, originPath);
    }
  }
}

function emptyImportBundle() {
  return {
    defs: new Map(),
    paramDefs: new Map(),
    typedDefs: new Map(),
    sampleDefs: new Map(),
    origin: {
      defs: new Map(),
      paramDefs: new Map(),
      typedDefs: new Map(),
      sampleDefs: new Map(),
    },
  };
}

// Warn (once per file) about content in an imported file that import ignores:
// def-val slots and track/other top-level forms. Defs-only is the MVP scope.
function warnImportIgnored(bundle, importPath, diagnostics, importSrc) {
  if (bundle.vals.size > 0) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' declares def-val slots; import folds defs only, so they are ignored`,
      importSrc,
      null,
    );
  }
  const hasTracks = bundle.remaining.some(
    (n) => n?.kind === "list" && n.items.length > 0,
  );
  if (hasTracks) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' contains track/other forms; import folds defs only, so they are ignored`,
      importSrc,
      null,
    );
  }
}

// Resolve one imported file to its merged def bundle (its own defs winning over
// what it in turn imports). `stack` detects cycles; `cache` dedups diamonds.
function resolveImportFile(path, importSrc, importSources, diagnostics, cache, stack) {
  if (stack.includes(path)) {
    pushDiag(
      diagnostics,
      "error",
      "E_IMPORT_CYCLE",
      `import cycle: ${[...stack, path].join(" -> ")}`,
      importSrc,
      null,
    );
    return emptyImportBundle();
  }
  if (cache.has(path)) return cache.get(path);

  const text = importSources ? importSources.get(path) : undefined;
  if (typeof text !== "string") {
    pushDiag(
      diagnostics,
      "error",
      "E_IMPORT_NOT_FOUND",
      `imported file '${path}' could not be resolved`,
      importSrc,
      null,
    );
    const empty = emptyImportBundle();
    cache.set(path, empty);
    return empty;
  }

  const bundle = collectDefs(parse(text), diagnostics);
  warnImportIgnored(bundle, path, diagnostics, importSrc);

  // Resolve this file's own imports first (siblings merged strictly), then let
  // this file's defs overlay them.
  const merged = emptyImportBundle();
  const nextStack = [...stack, path];
  for (const imp of bundle.imports) {
    const sub = resolveImportFile(
      imp.path,
      imp.src,
      importSources,
      diagnostics,
      cache,
      nextStack,
    );
    mergeImportsStrict(merged, sub, diagnostics, imp.src);
  }
  overlayDefs(merged, bundle, path);

  cache.set(path, merged);
  return merged;
}

// Fold all of the root file's imports into one bundle (siblings merged strictly).
function resolveImports(importForms, importSources, diagnostics) {
  const merged = emptyImportBundle();
  const cache = new Map();
  for (const imp of importForms) {
    const sub = resolveImportFile(
      imp.path,
      imp.src,
      importSources,
      diagnostics,
      cache,
      [],
    );
    mergeImportsStrict(merged, sub, diagnostics, imp.src);
  }
  return merged;
}

// Replace bare atoms matching a parameter name with the caller's argument node
// (lexically, within a parametric def body). Args are single nodes (atom/list).
function substituteParams(node, paramMap) {
  if (node.kind === "atom")
    return paramMap.has(node.value) ? { ...paramMap.get(node.value) } : { ...node };
  if (node.kind === "list")
    return {
      ...node,
      items: node.items.map((it) => substituteParams(it, paramMap)),
    };
  return { ...node };
}

function expandNode(node, defs, paramDefs, depth, diagnostics) {
  if (depth > 16)
    throw new Error("Macro expansion depth exceeded (possible recursion)");
  if (node.kind === "atom" && defs.has(node.value))
    return defs
      .get(node.value)
      .flatMap((n) => expandNode(n, defs, paramDefs, depth + 1, diagnostics));
  if (node.kind !== "list") return [node];

  const head = atomValue(node.items[0]);
  // Parametric snippet call: (name arg…) — substitute then re-expand the body.
  if (head && paramDefs.has(head)) {
    const def = paramDefs.get(head);
    const args = node.items.slice(1).filter((n) => n.kind !== "comment");
    if (args.length !== def.params.length) {
      pushDiag(
        diagnostics,
        "error",
        "E_DEF_ARITY",
        `(${head} …) expects ${def.params.length} argument(s), got ${args.length}`,
        nodeSrc(node),
        null,
      );
      return [];
    }
    const paramMap = new Map();
    def.params.forEach((p, idx) => paramMap.set(p, args[idx]));
    return def.body.flatMap((n) =>
      expandNode(substituteParams(n, paramMap), defs, paramDefs, depth + 1, diagnostics),
    );
  }
  if (head && defs.has(head) && node.items.length === 1)
    return defs
      .get(head)
      .flatMap((n) => expandNode(n, defs, paramDefs, depth + 1, diagnostics));

  const newItems = [];
  for (const item of node.items)
    newItems.push(...expandNode(item, defs, paramDefs, depth + 1, diagnostics));
  return [{ ...node, items: newItems }];
}

function expandRoots(roots, defs, paramDefs, diagnostics) {
  const result = [];
  for (const root of roots)
    result.push(...expandNode(root, defs, paramDefs, 0, diagnostics));
  return result;
}

/**
 * Compile MMLisp source string to IR.
 * @param {string} src - MMLisp source text
 * @param {string} [filename] - filename for metadata / source map
 * @param {object} [options]
 * @param {Map<string,string>} [options.imports] - resolved (import "path")
 *   sources, keyed by the literal path string. Provided by the host, which does
 *   the async file I/O (recursing through nested imports via collectImports)
 *   before this synchronous compile. Absent paths surface E_IMPORT_NOT_FOUND.
 * @returns {{ ir: object, diagnostics: array, sourceMap: array }}
 */
export function compileMMLisp(src, filename = "untitled.mmlisp", options = {}) {
  const diagnostics = [];
  const parsed = parse(src);
  const {
    defs,
    paramDefs,
    typedDefs,
    sampleDefs,
    vals,
    fileMeta,
    imports,
    remaining,
  } = collectDefs(parsed, diagnostics);
  // v0.6 Phase 2: fold imported defs in *under* this file's own — imports are
  // overridable defaults (local wins); two imports defining the same name is
  // E_IMPORT_CONFLICT. def-val slots and tracks are not imported (defs only).
  if (imports.length > 0) {
    const imported = resolveImports(imports, options.imports, diagnostics);
    const local = { defs, paramDefs, typedDefs, sampleDefs };
    overlayDefs(imported, local, filename); // local wins; `imported` = the union
    for (const kind of IMPORT_DEF_KINDS) {
      local[kind].clear();
      for (const [name, def] of imported[kind]) local[kind].set(name, def);
    }
  }
  if (!typedDefs.has("init-fm")) {
    typedDefs.set("init-fm", {
      tag: "fm-kw",
      extends: null,
      kwMap: createInitFmKwMap(),
      src: null,
    });
  }
  const roots = expandRoots(remaining, defs, paramDefs, diagnostics);

  // v0.6: 1 file = 1 score. There is no (score …) wrapper — the post-expand
  // root list *is* the score body: def/track forms interleave freely in source
  // order. File metadata comes from the reserved (def title/author "…") forms.
  const fileSrc = roots.length > 0 ? nodeSrc(roots[0]) : { line: 1, column: 1 };

  // The tempo active at tick 0 seeds every track's currentTempo (tempo is
  // score-global) and the Nf frame conversion. Prescan the leading `:key value`
  // run of each track form, in source order, for the first `:tempo` — a bare
  // BPM number or a curve (its :from, default 120).
  let scoreInitialBpm = null;
  outer: for (const node of roots) {
    if (node?.kind !== "list" || node.items.length === 0) continue;
    // PCM tracks carry the sample symbol as the first positional argument;
    // the keyword run starts after it.
    const start =
      isPcmTrackName(atomValue(node.items[0])) && node.items.length > 2 ? 2 : 1;
    for (let i = start; i + 1 < node.items.length; i += 2) {
      const key = atomValue(node.items[i]);
      if (typeof key !== "string" || !key.startsWith(":")) break;
      if (key !== ":tempo") continue;
      const valueNode = node.items[i + 1];
      const bpm = parseNumberLike(atomValue(valueNode));
      if (bpm !== null && bpm > 0) {
        scoreInitialBpm = bpm;
      } else {
        // Curve form: seed from its :from without emitting diagnostics here —
        // the body compiler re-parses it and reports errors once.
        const swept = buildTempoSweepFromCurve(valueNode, 0, 120, [], null, null);
        if (swept) scoreInitialBpm = swept.event.args.from;
      }
      break outer;
    }
  }

  // v0.4: Lists with a channel name as the form head are treated as tracks
  const CHANNEL_NAMES = [
    "fm1",
    "fm2",
    "fm3",
    "fm3-1",
    "fm3-2",
    "fm3-3",
    "fm3-4",
    "fm3-csm",
    "fm3-csm-rate",
    "fm4",
    "fm5",
    "fm6",
    "sqr1",
    "sqr2",
    "sqr3",
    "noise",
    "pcm1",
    "pcm2",
    "pcm3",
  ];

  const channelHeads = new Set();
  for (const node of roots) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;
    const head = atomValue(node.items[0]);
    if (head) channelHeads.add(head);
  }

  const hasCsmMode =
    channelHeads.has("fm3-csm") || channelHeads.has("fm3-csm-rate");
  const hasFm3OpTracks =
    channelHeads.has("fm3-1") ||
    channelHeads.has("fm3-2") ||
    channelHeads.has("fm3-3") ||
    channelHeads.has("fm3-4");
  const hasFm3NormalOrOp = channelHeads.has("fm3") || hasFm3OpTracks;
  if (hasCsmMode && hasFm3NormalOrOp) {
    pushDiag(
      diagnostics,
      "error",
      "E_FM3_MODE_CONFLICT",
      "fm3-csm/fm3-csm-rate cannot be mixed with fm3 or fm3-1..fm3-4 in the same score",
      fileSrc,
      "global",
    );
  }

  const hasCompanionCsmRateTrack = channelHeads.has("fm3-csm-rate");
  let hasInlineCsmRate = false;
  const trackByKey = new Map();
  const trackOrder = [];
  const loopCounter = { count: 0 };

  for (const node of roots) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (!head || !CHANNEL_NAMES.includes(head)) {
      // Defs were already collected, so any other top-level list head (usually
      // a channel-name typo) is an error — a silently-vanished track is worse
      // than a diagnostic.
      pushDiag(
        diagnostics,
        "error",
        "E_UNKNOWN_TOPLEVEL_FORM",
        `unknown top-level form head '${head ?? ""}'; expected a channel name or def`,
        nodeSrc(node.items[0]),
        null,
      );
      continue;
    }

    const isPcmTrack = isPcmTrackName(head);

    let pcmSampleName = null;
    let bodyStartIndex = 1;
    if (isPcmTrack && node.items.length > 1) {
      const maybeSample = node.items[1];
      const sampleVal = atomValue(maybeSample);
      if (
        sampleVal &&
        maybeSample.kind === "atom" &&
        !isLikelyPcmBodyToken(sampleVal)
      ) {
        pcmSampleName = sampleVal;
        bodyStartIndex = 2;
      }
    }

    // Collect inline options (key-value pairs immediately after the channel name).
    // Only TRACK_OPTION_KEYS are consumed here; hardware param keys (:tl1, :ar1, etc.)
    // and other modifiers (:vel, :master, etc.) are left in the body for compileChannelBody.
    // Example: (fm1 :oct 4 :len 8 :vol 10  c d e f)
    //                ^^^^^^^^^^^^^^^^^^^^^^^^^^^ options
    let i = bodyStartIndex;
    const inlineOpts = {};
    while (i + 1 < node.items.length) {
      const key = atomValue(node.items[i]);
      if (!TRACK_OPTION_KEYS.has(key)) break;
      inlineOpts[key] = atomValue(node.items[i + 1]);
      i += 2;
    }
    // Body items start after the inline options
    const bodyItems = node.items.slice(i);

    // v0.5: :prio layers forms on the same channel. Same prio appends (one
    // timeline); different prio values are independent parallel timelines on the
    // same physical channel, resolved by priority at the flatten post-pass.
    // Lower number = higher priority; default 8 (headroom on both sides).
    let prio = 8;
    if (inlineOpts[":prio"] !== undefined) {
      const v = parseIntLike(inlineOpts[":prio"]);
      if (v !== null) prio = Math.max(0, v);
    }
    const trackKey = `${head}:${prio}`;

    if (!trackByKey.has(trackKey)) {
      // Initialize defaults; inline options on the first form set the initial state
      let defaultOct = 4;
      let defaultLength = Math.round(WHOLE_TICKS / 8);
      let defaultGate = null;
      let defaultVol = 31; // v0.4: default vol is 31 (no attenuation)
      let defaultVel = 15; // v0.4: default velocity 0-15
      let shuffleRatio = 0; // v0.6: shuffle is per-track (no score-wide default)
      let shuffleBase = Math.round(WHOLE_TICKS / 8);

      if (inlineOpts[":oct"] !== undefined) {
        const v = parseIntLike(inlineOpts[":oct"]);
        if (v !== null) defaultOct = Math.max(0, v);
      }
      if (inlineOpts[":len"] !== undefined) {
        defaultLength = parseLengthToken(
          inlineOpts[":len"],
          defaultLength,
          scoreInitialBpm ?? 120,
        );
      }
      for (const gk of [":gate", ":gate*", ":gate-"]) {
        if (inlineOpts[gk] !== undefined) {
          const g = parseGateFamily(gk, inlineOpts[gk], scoreInitialBpm ?? 120);
          if (g !== null) defaultGate = g;
        }
      }
      if (inlineOpts[":vol"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vol"]);
        if (v !== null) defaultVol = Math.max(0, Math.min(31, v));
      }
      if (inlineOpts[":vel"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vel"]);
        if (v !== null) defaultVel = Math.max(0, Math.min(15, v));
      }
      if (inlineOpts[":shuffle"] !== undefined) {
        // `none` = straight (off-unification: none = clear a feature).
        if (inlineOpts[":shuffle"] === "none") {
          shuffleRatio = 0;
        } else {
          const rawTrackShuffle = parseIntLike(inlineOpts[":shuffle"]);
          if (rawTrackShuffle !== null) {
            shuffleRatio =
              rawTrackShuffle < 51 ? 0 : Math.min(90, rawTrackShuffle);
          }
        }
      }
      if (inlineOpts[":shuffle-base"] !== undefined) {
        shuffleBase = parseLengthToken(
          inlineOpts[":shuffle-base"],
          shuffleBase,
          scoreInitialBpm ?? 120,
        );
      }

      // All state is sticky and persists across consecutive forms of the same channel
      const trackState = {
        tick: 0,
        defaultLength,
        defaultOct,
        defaultGate,
        currentTempo: scoreInitialBpm ?? 120,
        isFm3OpTrack: /^fm3-[1-4]$/.test(head),
        fm3OpIndex: /^fm3-[1-4]$/.test(head)
          ? parseInt(head.slice(4), 10)
          : null,
        isCsmTrack: head === "fm3-csm",
        isCsmRateTrack: head === "fm3-csm-rate",
        isPcmTrack,
        isFm6Track: head === "fm6",
        isNoiseTrack: head === "noise",
        pcmSampleName,
        pcmPendingMode: null,
        sampleDefs,
        hasInlineCsmRate: false,
        hasCsmOn: false,
        defaultVol,
        defaultVel, // v0.4: per-note velocity, KEY-ON scoped, 0-15
        activeMacros: {}, // v0.4: unified macro map { target: spec, ... } for all targets
        delayTicks: 0, // v0.5: (delay …) tap spacing in ticks (0 = off)
        delaySpec: null, // v0.5: (delay …) relative spec {mode,type,…} or null

        glide: 0, // v0.4: glide duration in length-token units (0 = disabled)
        glideFrom: null, // v0.4: one-shot start pitch override for glide
        lastNotePitch: null, // v0.4: previous note's pitch for glide calculation
        lastCsmHz: null, // v0.5: previous fm3-csm-rate Hz for glide sweeps
        shuffleRatio,
        shuffleBase,
        subBeatParity: 0,
        currentLoopId: null, // id of innermost counted (x N ...) loop, for :break
      };

      const trackData = {
        id: trackOrder.length,
        // Original score channel name (e.g. "fm3-1", "pcm1"), preserved for the
        // UI to label and address per-sounding-channel. `channel` below collapses
        // FM3 variants to the shared hardware channel for the driver.
        scoreChannel: head,
        channel:
          head === "fm3-csm" ||
          head === "fm3-csm-rate" ||
          /^fm3-[1-4]$/.test(head)
            ? "fm3"
            : head,
        events: [],
      };

      // Emit initial VOL event if :vol was explicitly specified
      if (inlineOpts[":vol"] !== undefined) {
        trackData.events.push({
          tick: 0,
          cmd: "PARAM_SET",
          args: { target: "VOL", value: defaultVol },
          src: nodeSrc(node),
        });
      }

      // Emit default NOISE_MODE (white0) for noise channel
      if (head === "noise") {
        trackData.events.push({
          tick: 0,
          cmd: "PARAM_SET",
          args: { target: "NOISE_MODE", value: NOISE_MODE_MAP["white0"] },
          src: nodeSrc(node),
        });
      }

      trackByKey.set(trackKey, { trackData, trackState, head, prio });
      trackOrder.push(trackKey);
    } else {
      // Update sticky state from inline options on subsequent forms of the same channel
      const { trackData, trackState } = trackByKey.get(trackKey);

      if (isPcmTrack && pcmSampleName) {
        trackState.pcmSampleName = pcmSampleName;
      }

      if (inlineOpts[":oct"] !== undefined) {
        const v = parseIntLike(inlineOpts[":oct"]);
        if (v !== null) trackState.defaultOct = Math.max(0, v);
      }
      if (inlineOpts[":len"] !== undefined) {
        trackState.defaultLength = parseLengthToken(
          inlineOpts[":len"],
          trackState.defaultLength,
          trackState.currentTempo,
        );
      }
      for (const gk of [":gate", ":gate*", ":gate-"]) {
        if (inlineOpts[gk] !== undefined) {
          const g = parseGateFamily(gk, inlineOpts[gk], trackState.currentTempo);
          if (g !== null) trackState.defaultGate = g;
        }
      }
      if (inlineOpts[":shuffle"] !== undefined) {
        const v = parseIntLike(inlineOpts[":shuffle"]);
        if (v !== null) {
          trackState.shuffleRatio =
            v === 50 ? 0 : Math.max(51, Math.min(90, v));
          trackState.subBeatParity = 0;
        }
      }
      if (inlineOpts[":vol"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vol"]);
        if (v !== null) {
          trackState.defaultVol = Math.max(0, Math.min(31, v));
          trackData.events.push({
            tick: trackState.tick,
            cmd: "PARAM_SET",
            args: { target: "VOL", value: trackState.defaultVol },
            src: nodeSrc(node),
          });
        }
      }
      if (inlineOpts[":vel"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vel"]);
        if (v !== null) trackState.defaultVel = Math.max(0, Math.min(15, v));
      }
    }

    const { trackData, trackState } = trackByKey.get(trackKey);
    if (trackState.isPcmTrack) {
      if (!trackState.pcmSampleName) {
        pushDiag(
          diagnostics,
          "warning",
          "E_PCM_SAMPLE_REQUIRED",
          "pcm track requires a sample symbol before note data",
          nodeSrc(node),
          trackKey,
        );
      } else if (!sampleDefs.has(trackState.pcmSampleName)) {
        pushDiag(
          diagnostics,
          "error",
          "E_PCM_SAMPLE_UNDEFINED",
          `undefined sample def: ${trackState.pcmSampleName}`,
          nodeSrc(node),
          trackKey,
        );
      }
    }
    compileChannelBody(
      bodyItems,
      trackState,
      trackData.events,
      diagnostics,
      trackKey,
      typedDefs,
      loopCounter,
      vals,
    );

    // Surface bar markers (| … |) for the editor — inspection metadata only.
    if (trackState.bars?.length) trackData.bars = trackState.bars;

    if (trackState.isCsmTrack && trackState.hasCsmOn) {
      trackData.events.push({
        tick: trackState.tick,
        cmd: "CSM_OFF",
        args: {},
        src: nodeSrc(node),
      });
    }
    if (trackState.isCsmTrack && trackState.hasInlineCsmRate) {
      hasInlineCsmRate = true;
    }
  }

  if (hasInlineCsmRate && hasCompanionCsmRateTrack) {
    pushDiag(
      diagnostics,
      "error",
      "E_CSM_RATE_SOURCE_CONFLICT",
      "inline :csm-rate and fm3-csm-rate companion track are mutually exclusive per score",
      fileSrc,
      "global",
    );
  }

  // Expand :delay echoes per prio-layer (each layer is its own linear timeline),
  // then merge layers that share a physical channel (same head) into one track.
  for (const key of trackOrder) {
    expandTrackDelays(trackByKey.get(key).trackData);
  }

  const layersByHead = new Map();
  for (const key of trackOrder) {
    const entry = trackByKey.get(key);
    const arr = layersByHead.get(entry.head) ?? [];
    arr.push({ prio: entry.prio, trackData: entry.trackData });
    layersByHead.set(entry.head, arr);
  }

  const tracks = [];
  for (const [head, layers] of layersByHead) {
    tracks.push(
      layers.length === 1
        ? layers[0].trackData
        : flattenPriorityLayers(head, layers, diagnostics),
    );
  }
  tracks.forEach((t, idx) => {
    t.id = idx;
  });

  for (const track of tracks) convertCountedJumps(track);
  for (const track of tracks) validateTrack(track, diagnostics);

  // v0.6: tempo and LFO rate are written on tracks (body `:tempo` / `:lfo-rate`
  // emit their own tick-0 events); the only derived init event is FM3 op mode.
  if (tracks.length > 0 && hasFm3OpTracks) {
    tracks[0].events.unshift({
      tick: 0,
      cmd: "FM3_MODE",
      args: { mode: "op" },
      src: fileSrc,
    });
  }

  const sampleSourceBaseKnown = normalizePathSeparators(filename).includes("/");
  for (const [name, sample] of sampleDefs.entries()) {
    if (!sample?.file) continue;
    if (isAbsolutePath(sample.file)) continue;
    if (sampleSourceBaseKnown) continue;
    pushDiag(
      diagnostics,
      "warning",
      "W_SAMPLE_BASE_UNKNOWN",
      `sample path is relative but source base directory is unknown: ${name}`,
      sample.src ?? { line: 1, column: 1 },
      "global",
    );
  }

  const ir = sortObject({
    version: 1,
    ppqn: PPQN,
    metadata: {
      title: fileMeta.title || filename,
      author: fileMeta.author || "unknown",
      source: filename,
      vals: [...vals.values()].map((v) => ({
        name: v.name,
        slot: v.slot,
        init: v.init,
        min: v.min,
        max: v.max,
        step: v.step,
        reversed: v.reversed,
        unit: v.unit,
      })),
      samples: [...sampleDefs.entries()].map(([name, sample]) => ({
        name,
        file: sample.file,
        resolvedFile: resolveSamplePath(sample.file, filename),
        rate: sample.rate,
        offset: sample.offset,
        frames: sample.frames,
        loopStart: sample.loopStart,
        loopEnd: sample.loopEnd,
        bitDepth: sample.bitDepth,
        volume: sample.volume,
        compress: sample.compress,
        reverb: sample.reverb,
      })),
    },
    tracks,
  });

  return { ir, diagnostics, sourceMap: buildSourceMap(tracks) };
}
