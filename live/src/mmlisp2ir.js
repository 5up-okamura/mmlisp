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

// 96 ticks/quarter (384/whole). Divisible by both MMLisp's note fractions and
// mucom's default 128-clock/whole grid (LCM 384), so imported 128th notes land
// on exact ticks instead of rounding (1/128 whole = 3 ticks, not 1.5).
const PPQN = 96;
const WHOLE_TICKS = PPQN * 4;
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
  ":write",
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

function parseLengthToken(value, inheritedTicks) {
  if (!value) return inheritedTicks;
  // Tick count: "14t" — exact tick value
  if (/^\d+t$/.test(value)) {
    return parseInt(value, 10);
  }
  // Frame count: "16f" — 60 Hz update intervals used in macro :len context.
  // Returns the raw frame count; the player schedules one step per 1/60 s.
  if (/^\d+f$/.test(value)) {
    return parseInt(value, 10);
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
function parseRestLength(val, inheritedTicks) {
  if (typeof val !== "string" || !val.startsWith("_")) return null;
  const suffix = val.slice(1);
  if (suffix === "") return inheritedTicks;
  return parseLengthToken(suffix, inheritedTicks);
}

// The gate family. The operation is chosen by the keyword so each is
// unambiguous (no overloading one arg as either a ratio or a time):
//   :gate  <time>  — absolute sounding time (length / Nf / Nt token); `0` = hold.
//   :gate* <ratio> — fraction of the note length (0 <= ratio < 1).
//   :gate- <time>  — shorten: note length minus this time (key off early).
function parseGateFamily(keyword, val) {
  if (typeof val !== "string") return null;
  if (keyword === ":gate*") {
    const f = parseFloat(val);
    return !isNaN(f) && f >= 0 && f < 1 ? { type: "ratio", value: f } : null;
  }
  const ticks = val === "0" ? 0 : parseLengthToken(val, null);
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

function makeNoteArgs(pitch, lengthTicks, gateSpec, vel, activeMacros) {
  const gateTicks = resolveGateTicks(gateSpec, lengthTicks);
  const args = { pitch, length: lengthTicks };
  if (gateTicks < lengthTicks) args.gate = gateTicks;
  if (vel !== undefined && vel !== 15) args.vel = vel;
  if (activeMacros && Object.keys(activeMacros).length > 0) {
    for (const [target, spec] of Object.entries(activeMacros)) {
      // Each spec may carry its own .step (the per-macro :step clock).
      if (target === "NOTE_PITCH") args.pitchMacro = { ...spec };
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
) {
  const args = makeNoteArgs(pitch, lengthTicks, gateSpec, vel, activeMacros);
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

function isPcmModeSymbol(value) {
  return value === "shot" || value === "loop";
}

function isPcmTrackName(name) {
  return /^pcm[1-3]$/.test(name);
}

function isTrackPcmActive(trackState) {
  return !!(
    trackState?.isPcmTrack ||
    trackState?.fm6Mode === "shot" ||
    trackState?.fm6Mode === "loop"
  );
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
    emitCsmRateEvent(trackState, events, diagnostics, src, trackName, {
      hz: csmPitchToHz(pitch),
    });
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
        )
      : makeNoteArgs(
          fullPitch,
          lengthTicks,
          trackState.defaultGate,
          trackState.defaultVel,
          trackState.activeMacros,
        ),
    src,
  };
  stampDelay(noteEv, trackState);
  events.push(noteEv);
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
function macroOpOk(target, sym, diagnostics, trackName) {
  if (OP_BASE_TARGETS.has(target)) return true;
  pushDiag(
    diagnostics,
    "error",
    "E_MACRO_OP_NO_BASE",
    `'${sym}' has no base value to combine with; +/* apply only to ${[...OP_BASE_TARGETS].join(", ").toLowerCase()}`,
    null,
    trackName,
  );
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
  // reuse for route_hint/channel; only its event list is rebuilt.
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

  return sample;
}

function collectMacroEntriesFromItems(items, diagnostics, trackName) {
  const entries = [];
  let currentStep = null; // :step applies to the targets that follow it
  for (let ki = 0; ki + 1 < items.length; ki += 2) {
    // Target group: [:tl1 :tl2 ...] — expand to one entry per keyword,
    // sharing a single parsed spec (pure sugar; per-keyword `*` still applies).
    const group = macroTargetGroup(items[ki]);
    const syms = group ?? [atomValue(items[ki])];
    if (!group && !syms[0]?.startsWith(":")) continue;
    if (syms[0] === ":step") {
      currentStep = parseStepToken(atomValue(items[ki + 1]));
      continue;
    }
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
      );
      if (spec) {
        if (op && !macroOpOk(irTarget, sym, diagnostics, trackName)) continue;
        if (op) spec.op = op;
        if (currentStep) spec.step = currentStep;
        entries.push({ target: irTarget, spec });
      }
    }
  }
  return entries;
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
    const curveSpec = parseCurveSpec(
      node,
      diagnostics,
      nodeSrc(node),
      trackName,
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
) {
  if (!node || node.kind !== "list" || !node.items || node.items.length === 0)
    return null;
  const head = atomValue(node.items[0]);
  if (!CURVE_NAMES.has(head)) return null;

  let from;
  let to;
  let frames;
  let lenFrames = false; // :len given as Nf (frames) vs ticks (note-length / Nt)
  let waitTicks = null;
  let waitKeyOff = false;
  let forceLoop = false;
  const params = {};
  let hasParams = false;

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

  for (let j = 1; j < node.items.length; j++) {
    const k = atomValue(node.items[j]);
    if (k === ":loop") {
      // Value-less flag: force this curve to loop (forward), e.g. so an easing
      // curve can be a cycling sustain stage.
      forceLoop = true;
      continue;
    }
    if (k && k.startsWith(":") && j + 1 < node.items.length) {
      const v = atomValue(node.items[j + 1]);
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
        case ":from":
          from = parseNumberLike(v);
          break;
        case ":to":
          to = parseNumberLike(v);
          break;
        case ":len":
          frames = parseLengthToken(v, null);
          lenFrames = /^\d+f$/.test(v); // Nf is an absolute frame count, not ticks
          break;
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
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "rate",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":rate"),
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
  return spec;
}

function parseNumberLike(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function canonicalTarget(symbol) {
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
  if (!td) return null;
  if (td.tag === "fm-kw") {
    const base = td.extends
      ? resolveVoice(td.extends, typedDefs, diagnostics, seen)
      : new Map();
    if (base === null) return null;
    // Child overrides parent
    const merged = new Map(base);
    for (const [k, v] of td.kwMap) merged.set(k, v);
    return merged;
  }
  return null;
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

function getKeywordMap(items, startIndex) {
  const map = new Map();
  let i = startIndex;
  while (i < items.length) {
    const key = items[i];
    if (!(key && key.kind === "atom" && key.value.startsWith(":"))) {
      i += 1;
      continue;
    }
    const value = items[i + 1];
    if (!value) break;
    map.set(key.value, value);
    i += 2;
  }
  return map;
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

const VALID_WRITE_SCOPE = new Set(["notes", "fm-params", "ctrl", "reg", "any"]);

function parseWriteScope(options, diagnostics, trackName) {
  const scopeNode = options.get(":write");
  if (!scopeNode) return ["any"];
  const candidates = [];
  if (scopeNode.kind === "list") {
    for (const item of scopeNode.items) {
      const v = atomValue(item);
      if (v) candidates.push(v.replace(/^:/, ""));
    }
  } else {
    const v = atomValue(scopeNode);
    if (v) candidates.push(v.replace(/^:/, ""));
  }
  const valid = candidates.filter((s) => VALID_WRITE_SCOPE.has(s));
  const invalid = candidates.filter((s) => !VALID_WRITE_SCOPE.has(s));
  if (invalid.length > 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_WRITE_SCOPE_INVALID",
      `Unknown write scope values: ${invalid.join(", ")}`,
      nodeSrc(scopeNode),
      trackName,
    );
  }
  return valid.length > 0 ? valid : ["any"];
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
) {
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
              const raw = op === "*" ? parseFloat(rawVal) : parseIntLike(rawVal);
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultOct;
                const next =
                  op === "+" ? cur + raw : op === "*" ? cur * raw : raw;
                trackState.defaultOct = Math.max(0, Math.round(next));
              }
              break;
            }
            case ":len":
              trackState.defaultLength = parseLengthToken(
                rawVal,
                trackState.defaultLength,
              );
              break;
            case ":gate":
            case ":gate*":
            case ":gate-": {
              const g = parseGateFamily(val, rawVal);
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
              const raw = op === "*" ? parseFloat(rawVal) : parseIntLike(rawVal);
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
                );
                if (!curveSpec) break;

                const from = parseNumberLike(String(curveSpec.from ?? ""));
                const to = parseNumberLike(String(curveSpec.to ?? ""));
                const len =
                  Number.isFinite(Number(curveSpec.frames)) &&
                  Number(curveSpec.frames) > 0
                    ? Number(curveSpec.frames)
                    : null;

                const fromBpm = from ?? trackState.currentTempo;
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
                  trackState.currentTempo = toBpm;
                  events.push({
                    tick: trackState.tick,
                    cmd: "TEMPO_SWEEP",
                    args: {
                      from: fromBpm,
                      to: toBpm,
                      len,
                      curve: curveSpec.curve,
                      params: curveSpec.params,
                    },
                    src: nodeSrc(node),
                  });
                } else {
                  pushDiag(
                    diagnostics,
                    "error",
                    "E_TEMPO_INVALID",
                    "invalid :tempo curve; expected (:curve :from N :to M :len L)",
                    nodeSrc(node),
                    trackName,
                  );
                }
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
              if (trackState.isPcmTrack && isPcmModeSymbol(rawVal)) {
                trackState.pcmPendingMode = rawVal;
              } else if (trackState.isFm6Track && rawVal === "fm") {
                trackState.fm6Mode = "fm";
              } else if (trackState.isFm6Track && isPcmModeSymbol(rawVal)) {
                trackState.fm6Mode = rawVal;
                trackState.pcmPendingMode = rawVal;
              } else {
                pushDiag(
                  diagnostics,
                  "error",
                  "E_PCM_MODE_INVALID",
                  trackState.isFm6Track
                    ? "fm6 :mode must be fm, shot, or loop"
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
              if (!SUPPORTED_TARGETS.has(target)) break;
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
              // Absolute: curve sweep or literal set.
              const curveSpec = parseCurveSpec(
                items[i],
                diagnostics,
                nodeSrc(node),
                trackName,
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

      // Tie: ~ [optional-length]
      if (val === "~") {
        i++;
        let tieTicks = trackState.defaultLength;
        if (i < items.length) {
          const parsed = parseLengthToken(atomValue(items[i]), null);
          if (parsed !== null) {
            tieTicks = parsed;
            i++;
          }
        }
        events.push({
          tick: trackState.tick,
          cmd: "TIE",
          args: { length: tieTicks },
          src: nodeSrc(node),
        });
        trackState.tick += tieTicks;
        continue;
      }

      // Rest atom: "_", "_4", "_4.", "_14t", "_16f"
      if (isRestAtom(val)) {
        const ticks = resolveShuffleTicks(
          parseRestLength(val, trackState.defaultLength),
          trackState,
        );
        events.push({
          tick: trackState.tick,
          cmd: "REST",
          args: { length: ticks },
          src: nodeSrc(node),
        });
        trackState.tick += ticks;
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
          emitCsmRateEvent(
            trackState,
            events,
            diagnostics,
            nodeSrc(node),
            trackName,
            { hz: rawHz },
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

      // Subgroup / tuplet: list starting with a note or per-note-length atom.
      // Tick duration is distributed among all elements using Bresenham method.
      if (isNoteAtom(head) || isPerNoteLengthAtom(head)) {
        const elems = node.items.filter((ev) => ev?.kind !== "comment");
        const n = elems.length;
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
          const cv = parseCurveSpec(a2node, diagnostics, nodeSrc(node), trackName);
          if (cv) spec = { mode, type: "curve", ...cv };
        } else if (parseIntLike(a2) !== null) {
          spec = { mode, type: "param", count: Math.max(1, parseIntLike(a2)) };
        }
        let time = null;
        for (let j = 3; j + 1 < items.length; j += 2) {
          const key = atomValue(items[j]);
          const val = atomValue(items[j + 1]);
          if (key === ":by" && spec?.type === "param") spec.by = parseFloat(val);
          else if (key === ":time") time = parseLengthToken(val, null);
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
      // (glide <from-pitch> <time>) sets an explicit start pitch; (glide 0) off.
      if (head === "glide") {
        const items = node.items;
        const has2 = items.length >= 3;
        if (has2) trackState.glideFrom = atomValue(items[1]);
        const tv = atomValue(items[has2 ? 2 : 1]);
        const t = tv === "0" ? 0 : parseLengthToken(tv, null);
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
        let currentStep = null;
        while (j < rest.length) {
          const sym = atomValue(rest[j]);
          const group = macroTargetGroup(rest[j]);
          if (sym === ":step") {
            if (j + 1 < rest.length) {
              currentStep = parseStepToken(atomValue(rest[j + 1]));
              j += 2;
            } else j++;
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
                );
                if (spec && currentStep) spec.step = currentStep;
                if (
                  spec &&
                  op &&
                  !macroOpOk(target, groupSym, diagnostics, trackName)
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
          const value = parseIntLike(atomValue(valueNode)) ?? 0;
          if (!SUPPORTED_TARGETS.has(target)) {
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
    if (e.cmd === "MARKER") {
      const id = e.args?.id;
      if (markers.has(id)) {
        pushDiag(
          diagnostics,
          "error",
          "E_MARKER_DUP",
          `Duplicate marker id: ${id}`,
          e.src,
          track.name,
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
        track.name,
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
  const defns = new Map();
  const typedDefs = new Map();
  const sampleDefs = new Map();
  const vals = new Map(); // v0.5: (def-val name init) runtime value slots
  const remaining = [];

  for (const root of roots) {
    if (root.kind !== "list" || root.items.length < 2) {
      remaining.push(root);
      continue;
    }
    const head = atomValue(root.items[0]);

    // (def-val name init) — declare a runtime value slot (Tier 0/1 dynamic
    // value). Slots are assigned indices in declaration order.
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
      const init = parseIntLike(atomValue(root.items[2])) ?? 0;
      if (!vals.has(name)) vals.set(name, { name, slot: vals.size, init });
      continue;
    }

    if (head === "def") {
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

    if (head === "defn") {
      const name = atomValue(root.items[1]);
      if (!name) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEFN_NAME",
          "defn name must be a symbol",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const paramsNode = root.items.filter((n) => n.kind !== "comment")[2];
      if (
        !paramsNode ||
        paramsNode.kind !== "list" ||
        paramsNode.bracket !== "[]"
      ) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEFN_PARAMS",
          "defn params must be a [...] vector",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const params = paramsNode.items
        .map((item) => atomValue(item))
        .filter(Boolean);
      const body = root.items.slice(3);
      defns.set(name, { params, body, src: nodeSrc(root) });
      continue;
    }

    remaining.push(root);
  }

  return { defs, defns, typedDefs, sampleDefs, vals, remaining };
}

function substituteNode(node, bindings) {
  if (node.kind === "atom" && bindings.has(node.value)) {
    const replacement = bindings.get(node.value);
    return replacement ? { ...replacement } : node;
  }
  if (node.kind === "list") {
    return {
      ...node,
      items: node.items.map((item) => substituteNode(item, bindings)),
    };
  }
  return node;
}

function expandNode(node, defs, defns, depth) {
  if (depth > 16)
    throw new Error("Macro expansion depth exceeded (possible recursion)");
  if (node.kind === "atom" && defs.has(node.value))
    return defs.get(node.value).map((n) => ({ ...n }));
  if (node.kind !== "list") return [node];

  const head = atomValue(node.items[0]);
  if (head && defs.has(head) && node.items.length === 1)
    return defs.get(head).map((n) => ({ ...n }));
  if (head && defns.has(head)) {
    const { params, body } = defns.get(head);
    const args = node.items.slice(1);
    const bindings = new Map();
    for (let i = 0; i < params.length; i++)
      bindings.set(params[i], args[i] || null);
    const expanded = [];
    for (const bodyNode of body) {
      const substituted = substituteNode(bodyNode, bindings);
      expanded.push(...expandNode(substituted, defs, defns, depth + 1));
    }
    return expanded;
  }

  const newItems = [];
  for (const item of node.items)
    newItems.push(...expandNode(item, defs, defns, depth + 1));
  return [{ ...node, items: newItems }];
}

function expandRoots(roots, defs, defns) {
  const result = [];
  for (const root of roots) result.push(...expandNode(root, defs, defns, 0));
  return result;
}

/**
 * Compile MMLisp source string to IR.
 * @param {string} src - MMLisp source text
 * @param {string} [filename] - filename for metadata / source map
 * @returns {{ ir: object, diagnostics: array, sourceMap: array }}
 */
export function compileMMLisp(src, filename = "untitled.mmlisp") {
  const diagnostics = [];
  const parsed = parse(src);
  const { defs, defns, typedDefs, sampleDefs, vals, remaining } = collectDefs(
    parsed,
    diagnostics,
  );
  if (!typedDefs.has("@init-fm")) {
    typedDefs.set("@init-fm", {
      tag: "fm-kw",
      extends: null,
      kwMap: createInitFmKwMap(),
      src: null,
    });
  }
  const roots = expandRoots(remaining, defs, defns);

  const score = roots.find(
    (node) =>
      node.kind === "list" &&
      node.items.length > 0 &&
      isAtom(node.items[0], "score"),
  );
  if (!score) throw new Error("No (score ...) form found");

  const scoreOptions = getKeywordMap(score.items, 1);
  const titleNode = scoreOptions.get(":title");
  const authorNode = scoreOptions.get(":author");
  const scoreTempoNode = scoreOptions.get(":tempo");
  const scoreTempoVal = parseIntLike(atomValue(scoreTempoNode));
  const scoreLfoRateNode = scoreOptions.get(":lfo-rate");
  const scoreShuffleNode = scoreOptions.get(":shuffle");

  const rawScoreShuffle = parseIntLike(atomValue(scoreShuffleNode)) ?? 0;
  const scoreShuffleRatio =
    rawScoreShuffle >= 51 ? Math.min(90, rawScoreShuffle) : 0;

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

  const scoreChannelHeads = new Set();
  for (const node of score.items) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;
    const head = atomValue(node.items[0]);
    if (head) scoreChannelHeads.add(head);
  }

  const hasCsmMode =
    scoreChannelHeads.has("fm3-csm") || scoreChannelHeads.has("fm3-csm-rate");
  const hasFm3OpTracks =
    scoreChannelHeads.has("fm3-1") ||
    scoreChannelHeads.has("fm3-2") ||
    scoreChannelHeads.has("fm3-3") ||
    scoreChannelHeads.has("fm3-4");
  const hasFm3NormalOrOp = scoreChannelHeads.has("fm3") || hasFm3OpTracks;
  if (hasCsmMode && hasFm3NormalOrOp) {
    pushDiag(
      diagnostics,
      "error",
      "E_FM3_MODE_CONFLICT",
      "fm3-csm/fm3-csm-rate cannot be mixed with fm3 or fm3-1..fm3-4 in the same score",
      nodeSrc(score),
      "global",
    );
  }

  const hasCompanionCsmRateTrack = scoreChannelHeads.has("fm3-csm-rate");
  let hasInlineCsmRate = false;
  const trackByKey = new Map();
  const trackOrder = [];
  const loopCounter = { count: 0 };

  for (const node of score.items) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (!head || !CHANNEL_NAMES.includes(head)) continue;

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
      let shuffleRatio = scoreShuffleRatio;
      let shuffleBase = Math.round(WHOLE_TICKS / 8);

      if (inlineOpts[":oct"] !== undefined) {
        const v = parseIntLike(inlineOpts[":oct"]);
        if (v !== null) defaultOct = Math.max(0, v);
      }
      if (inlineOpts[":len"] !== undefined) {
        defaultLength = parseLengthToken(inlineOpts[":len"], defaultLength);
      }
      for (const gk of [":gate", ":gate*", ":gate-"]) {
        if (inlineOpts[gk] !== undefined) {
          const g = parseGateFamily(gk, inlineOpts[gk]);
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
        const rawTrackShuffle = parseIntLike(inlineOpts[":shuffle"]);
        if (rawTrackShuffle !== null) {
          shuffleRatio =
            rawTrackShuffle === 50
              ? 0
              : Math.max(51, Math.min(90, rawTrackShuffle));
        }
      }
      if (inlineOpts[":shuffle-base"] !== undefined) {
        shuffleBase = parseLengthToken(
          inlineOpts[":shuffle-base"],
          shuffleBase,
        );
      }

      // All state is sticky and persists across consecutive forms of the same channel
      const trackState = {
        tick: 0,
        defaultLength,
        defaultOct,
        defaultGate,
        currentTempo: scoreTempoVal ?? 120,
        isFm3OpTrack: /^fm3-[1-4]$/.test(head),
        fm3OpIndex: /^fm3-[1-4]$/.test(head)
          ? parseInt(head.slice(4), 10)
          : null,
        isCsmTrack: head === "fm3-csm",
        isCsmRateTrack: head === "fm3-csm-rate",
        isPcmTrack,
        isFm6Track: head === "fm6",
        fm6Mode: "fm",
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
        route_hint: {
          allocation_preference: "ordered_first_fit",
          channel_candidates: [
            head === "fm3-csm" ||
            head === "fm3-csm-rate" ||
            /^fm3-[1-4]$/.test(head)
              ? "fm3"
              : head,
          ],
          write_scope: ["any"],
        },
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
        );
      }
      for (const gk of [":gate", ":gate*", ":gate-"]) {
        if (inlineOpts[gk] !== undefined) {
          const g = parseGateFamily(gk, inlineOpts[gk]);
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
      nodeSrc(score),
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

  if (tracks.length > 0) {
    const initEvents = [];
    const scoreSrc = nodeSrc(score);
    if (hasFm3OpTracks) {
      initEvents.push({
        tick: 0,
        cmd: "FM3_MODE",
        args: { mode: "op" },
        src: scoreSrc,
      });
    }
    const lfoRateVal = parseIntLike(atomValue(scoreLfoRateNode));
    if (lfoRateVal !== null) {
      initEvents.push({
        tick: 0,
        cmd: "PARAM_SET",
        args: { target: "LFO_RATE", value: lfoRateVal },
        src: scoreSrc,
      });
    }
    if (scoreTempoVal !== null) {
      initEvents.push({
        tick: 0,
        cmd: "TEMPO_SET",
        args: { bpm: scoreTempoVal },
        src: scoreSrc,
      });
    }
    if (initEvents.length > 0) tracks[0].events.unshift(...initEvents);
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
      title: atomValue(titleNode) || filename,
      author: atomValue(authorNode) || "unknown",
      source: filename,
      vals: [...vals.values()].map((v) => ({
        name: v.name,
        slot: v.slot,
        init: v.init,
      })),
      samples: [...sampleDefs.entries()].map(([name, sample]) => ({
        name,
        file: sample.file,
        resolvedFile: resolveSamplePath(sample.file, filename),
        rate: sample.rate,
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
