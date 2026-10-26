/**
 * MMLisp → IR compiler (tools/scripts/mmlisp2ir.js is a thin wrapper around it).
 * No Node.js dependencies; input is a MMLisp source string.
 *
 * API:
 *   compileMMLisp(src: string, filename?: string)
 *     → { ir: object, diagnostics: array, sourceMap: array }
 *
 * Errors in diagnostics have: { severity, code, message, line, column, track }
 */

import { hoistVoiceChanges } from "./voice-hoist.js";
import { TARGETS, DEFAULT_TARGET as DEFAULT_TARGET_NAME, targetProfile, partsWithWord, partsWithSetting, ALL_CHANNEL_NAMES } from "./targets.js";
import { NOISE_MODE_MAP } from "./chips/sn76489.js";
import { FM_CHANNEL_WORDS, FM_OP_WORDS, opWords, fmInitVoice } from "./chips/fm-words.js";
import { opllRomVoices } from "./chips/ym2413.js";
import { parse } from "./mmlisp-parser.js";
import {
  clampForTarget,
  csmTimerHz,
  csmTimerPeriod,
  midiToHz,
  pitchToMidi,
  sampleCurveUnit,
  WAVE,
  waveCombine,
  waveSteps,
  expandLoops,
  FRAME_HZ_NTSC,
  FRAME_HZ_PAL,
  VEL_FINE,
} from "./ir-utils.js";
import {
  makeEnv,
  isEvalHead,
  isReservedHead,
  evalValue,
  evalScalarValue,
  evalLet,
  evalFor,
  evalIf,
  letPairs,
  evalLengthValue,
  lookupBound,
} from "./mmlisp-eval.js";
import { SAMPLE_EFFECTS } from "./sample-fx.js";

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
  "LFO_RATE",
  "LFO_FREQ",
  "LFO_PMD",
  "LFO_AMD",
  "LFO_WAVE",
  "NOISE_RATE",
  "ENV_RATE",
  "PAN",
  "NOISE_MODE",
  // The FM family's (chips/fm-words.js), the inline-only ones aside.
  ...FM_CHANNEL_WORDS.map((w) => w.word),
  ...opWords(FM_OP_WORDS.filter((w) => !w.inline)).map((w) => w.word),
]);

// What a (macro …) may step: the supported targets, and the SSG's mixer,
// which a `:mode` macro on it becomes (its inline :mode is the part's).
const MACRO_TARGETS = new Set([...SUPPORTED_TARGETS, "SSG_MIX"]);

// Inline-only targets: sticky channel state with no per-note macro form.
// SNAP (`:snap`, language.md §5.3) is a pitch-class mask the channel's every
// pitch write passes through; a mask is set, never swept or stepped.
// SSG_ENV (`:env`, language.md §19) is the SSG channel's envelope shape, or
// none: a channel's setting, no level; ENV_SEMI and ENV_DETUNE (`:env-semi`,
// `:env-detune`) move the period the channel's notes or rates give it.
const INLINE_TARGETS = new Set(["SNAP", "SSG_ENV", "ENV_SEMI", "ENV_DETUNE", ...opWords(FM_OP_WORDS.filter((w) => w.inline)).map((w) => w.word)]);

// An operator's velocity sensitivity, `:vel1`–`:vel4` (language.md §6): a
// ratio 0–1 of the note's velocity offset, carried as sixteenths. A voice
// param written in a def-fm or inline, never swept: the driver composes it at
// each level write, so it has no macro, `+`/`*` or `$` form.
const VEL_SENS_TARGETS = new Set(opWords(FM_OP_WORDS.filter((w) => w.word === "FM_VEL")).map((w) => w.word));
const VEL_SENS_KEYWORDS = new Set(opWords(FM_OP_WORDS.filter((w) => w.word === "FM_VEL")).map((w) => w.kw));
// The IR's value for "the role's own" (16 on a carrier, 0 on a modulator).
const VEL_SENS_AUTO = -1;
// A ratio 0–1 → sixteenths, or null when it is not one.
function velSensSixteenths(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 16) : null;
}

// Does the score write a velocity sensitivity anywhere — in a voice, inline,
// or in a snippet or effect it defines or imports? Then every voice states all
// four (resolveVoices), so a voice change also resets what the voice before it
// set. A score that never writes one emits none and plays exactly as before.
function writesVelSens(...roots) {
  const seen = new WeakSet();
  const walk = (n) => {
    if (!n || typeof n !== "object" || seen.has(n)) return false;
    seen.add(n);
    if (n.kind === "atom") return VEL_SENS_KEYWORDS.has(n.value);
    if (n instanceof Map) {
      for (const v of n.values()) if (walk(v)) return true;
      return false;
    }
    return (Array.isArray(n) ? n : Object.values(n)).some(walk);
  };
  return roots.some(walk);
}

// A PCM voice has no pitch step. The engine advances its pointer one byte
// a sample and nothing else, so a note picks a BAKED blob and that is the whole
// pitch mechanism. Every runtime pitch move — cents, semitones, glide, a
// (macro :pitch …) vibrato — has no hardware to land on; reject it rather than
// drop it silently (.claude/memory/pcm.md).
const PCM_PITCH_TARGETS = new Set(["NOTE_PITCH", "NOTE_SEMI", "SNAP"]);

// A PCM note's points (docs/language.md §16): the range it plays,
// :pcm-start / :pcm-end / :pcm-len (RANGE_*), and inside it the loop a held
// loop note repeats, :loop-start / :loop-end / :loop-len (LOOP_*). Their
// values are LENGTH TOKENS, not plain numbers, and they drive the engine's
// block edge rather than a chip register — so they are PARAM-legal (a literal
// or a curve) but not macro-legal. An …_END and an …_LEN both set their span's
// far bound, pinning the end vs the length; the last one written wins.
// The song-wide write targets a macro does not take (a macro is a note's).
const SONG_TARGETS = new Set(["MASTER", "LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE", "NOISE_RATE", "ENV_RATE"]);
// Song-wide write targets: their sweeps run in slots of their own on the
// driver, not in the writing channel's two (driver.md §4).
const isSongTarget = (t) => SONG_TARGETS.has(t) || /^VAL\d+$/.test(t ?? "");

// Where a score's writes outrun what the driver keeps, or two channels race
// for one song-wide value, say so — the driver would act deterministically,
// but not as written (language.md §5.1, §8). Judged on the written timeline:
// a loop's passes are its first.
function warnSongWrites(tracks, diagnostics, frameHz) {
  const tempos = tracks
    .flatMap((t) => t.events.filter((e) => e.cmd === "TEMPO_SET"))
    .map((e) => [e.tick, e.args?.bpm ?? 120])
    .sort((a, b) => a[0] - b[0]);
  const bpmAt = (tick) => tempos.reduce((bpm, [t, b]) => (t <= tick ? b : bpm), 120);
  const ticksOf = (ev) => {
    const n = Number(ev.args?.frames ?? 1);
    return ev.args?.lenFrames ? (n * bpmAt(ev.tick) * PPQN) / (60 * frameHz) : n;
  };
  // A channel runs two sweeps at once; a third evicts one (driver.md §4).
  for (const t of tracks) {
    const live = new Map(); // target → end tick
    for (const ev of t.events) {
      const target = ev.args?.target;
      if (!target || isSongTarget(target)) continue;
      if (ev.cmd === "PARAM_SET" || ev.cmd === "PARAM_SWEEP_STOP") live.delete(target);
      if (ev.cmd !== "PARAM_SWEEP") continue;
      for (const [k, end] of live) if (end <= ev.tick) live.delete(k);
      if (!live.has(target) && live.size >= 2) {
        pushDiag(diagnostics, "warning", "W_SWEEP_SLOTS",
          `a third sweep at once on ${t.scoreChannel} (${[...live.keys(), target].join(", ")}): the channel runs two, so one is cut off`,
          ev.src, t.scoreChannel);
        break;
      }
      live.set(target, ev.args?.loop ? Infinity : ev.tick + ticksOf(ev));
    }
  }
  // Two channels writing one song-wide value on one tick: the later track wins.
  const writers = new Map(); // "target@tick" → channel
  for (const t of tracks)
    for (const ev of t.events) {
      if (!ev.cmd.startsWith("PARAM_") || !isSongTarget(ev.args?.target)) continue;
      const key = `${ev.args.target}@${ev.tick}`;
      const other = writers.get(key);
      if (other != null && other !== t.scoreChannel)
        pushDiag(diagnostics, "warning", "W_SONG_WRITE_RACE",
          `${other} and ${t.scoreChannel} write the same song-wide value on one tick; ${t.scoreChannel}'s, the later track, wins`,
          ev.src, t.scoreChannel);
      writers.set(key, t.scoreChannel);
    }
}
const PCM_POINT_TARGETS = new Set(["RANGE_START", "RANGE_END", "RANGE_LEN",
  "LOOP_START", "LOOP_END", "LOOP_LEN"]);
const PCM_PITCH_KEYWORD = { NOTE_PITCH: ":pitch", NOTE_SEMI: ":semi" };

// What a (macro …) can drive on a pcm track: a retrigger (`:keyon` plays the
// blob again from its start — a roll) and the voice's level. The rest are
// chip registers a soft-mixed voice does not have.
const PCM_MACRO_TARGETS = new Set(["KEYON", "VEL", "VOL"]);
const PCM_MACRO_ARG_KEYS = ["keyon", "velMacro", "vol"];
// A part that pitches its voice (parts.js `pitch`) takes the pitch words
// but :snap, and their macros.
const PITCHED_PCM_MACRO_ARG_KEYS = [...PCM_MACRO_ARG_KEYS, "pitchMacro", "note_semi"];
const pcmTakesPitch = (trackState, irTarget) => !!trackState?.part?.pitch && irTarget !== "SNAP";

function pcmRejectsPitch(trackState, what, diagnostics, src, trackName, irTarget = "NOTE_PITCH") {
  if (!trackState?.isPcmTrack || pcmTakesPitch(trackState, irTarget)) return false;
  pushDiag(
    diagnostics ?? [],
    "error",
    "E_PCM_NO_PITCH",
    `${what} has no effect on a pcm track: a PCM voice plays its baked blob and cannot bend`,
    src ?? { line: 1, column: 1 },
    trackName,
  );
  return true;
}

// A PCM point (`:pcm-start` …, inline or in a (param-set …)) is a length
// everywhere: the literal, and both ends of a curve. The IR carries SECONDS;
// the exporter turns them into the engine's byte offsets at the image's rate
// (driver.md §5). Events go out through `push(cmd, args)`.
function writePcmPoint(target, keyword, op, valueNode, trackState, push, diagnostics, src, trackName, env = null) {
  // A sample part's word, so it reaches here on a sample track (trackLacks).
  const t = trackState.target;
  if (trackState.part.points === false) {
    const takers = t.channelNames.filter((h) => t.partOf(h).kind === "sample" && t.partOf(h).points !== false);
    targetDiag(diagnostics, "error",
      `${keyword}: on ${t.name} ${trackState.head} plays the ${trackState.part.label} sounds, which have no range or loop${takers.length ? `; ${takers.join(" or ")} takes it` : ""}`,
      src, trackName);
    return;
  }
  if (op) {
    pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET",
      `${keyword} takes a length, so '${op}' has no meaning on it`, src, trackName);
    return;
  }
  const secOf = (tok) => lengthTokenSeconds(tok, trackState.currentTempo);
  const rangeCurve = parseCurveSpec(valueNode, diagnostics, src, trackName, true, secOf, env);
  requireCurveFrom(rangeCurve, diagnostics, trackName, "a PCM point", src);
  if (rangeCurve) {
    // A part that reads its range at key-on (the ADPCM-B's addresses) has no
    // moving point: the sweep's start is the point.
    if (trackState.part.pointSweeps === false) {
      targetDiag(diagnostics, "warning",
        `${keyword}: the ${trackState.part.label} reads its range at each note's key-on, so a curve is read as its start`,
        src, trackName);
      push("PARAM_SET", { target, value: rangeCurve.from });
      return;
    }
    push("PARAM_SWEEP", { target, ...rangeCurve });
    return;
  }
  const rawVal = atomValue(valueNode);
  const sec = secOf(rawVal);
  if (sec === null) {
    pushDiag(diagnostics, "error", "E_PCM_RANGE_LENGTH",
      `${keyword} needs a length (300ms, 16, 8., 6t, 3f): got ${rawVal}`, src, trackName);
    return;
  }
  push("PARAM_SET", { target, value: sec });
}

// PARAM-legal targets — what an inline `:target v` / `(param-set …)` may write.
// A strict subset of the macro-legal set: NOTE_SEMI, KEYON and VEL have no
// meaningful absolute-write semantics (NOTE_SEMI duplicates NOTE_PITCH, KEYON is
// a note event, VEL is key-on-sticky), so they are macro-only. Writing them as a
// PARAM is rejected.
const PARAM_SET_TARGETS = new Set([
  ...[...SUPPORTED_TARGETS].filter(
    (t) => t !== "NOTE_SEMI" && t !== "KEYON" && t !== "VEL",
  ),
  ...INLINE_TARGETS,
  ...PCM_POINT_TARGETS,
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


// The language's word for "this target has no such thing": a feature that
// would change what is heard is an error, a setting with no meaning here a
// warning (docs/roadmap.md, the pc88 item).
function targetDiag(diagnostics, severity, message, src, track) {
  pushDiag(diagnostics, severity, severity === "error" ? "E_TARGET" : "W_TARGET", message, src, track);
}
// A write target this machine's chips do not have: why, or null. A word is
// a part's when one claims it (chips/parts.js); the rest are on every target.
function targetLacks(irTarget, sym, target) {
  if (target.hasWord(irTarget)) return null;
  const owners = [...new Set(partsWithWord(irTarget).map((p) => p.label))];
  if (!owners.length) return null;
  const hint = target.hints?.[irTarget];
  return `${sym} is the ${owners.join(" / ")}'s; the ${target.system} has none${hint ? ` — ${hint}` : ""}`;
}
// A part's word on a channel of another part (`:tl1` on sqr1): the channel
// has no such thing, on every target. A song-wide word is any track's. The
// owners named are this target's where it has any, else every target's.
function trackLacks(irTarget, sym, trackState) {
  const { part, head, target } = trackState;
  if (!part || isSongTarget(irTarget) || part.words(irTarget)) return null;
  const all = partsWithWord(irTarget);
  if (!all.length) return null;
  const here = all.filter((p) => target.parts.includes(p));
  const owners = [...new Set((here.length ? here : all).map((p) => p.label))];
  return `${sym} is the ${owners.join(" / ")}'s; ${head} (${part.label}) has no such thing`;
}

// PAN symbolic values → logical range -1/0/+1 (encodeB4 maps these to L/LR/R bits)
const PAN_MAP = { left: -1, center: 0, right: 1 };
// A target's own symbols: the pan's places, the OPM LFO's waveforms, the
// SSG's `:env none` (the 4-bit level back), `:env-semi none` and
// `:env-detune none` (no move), and `:env-rate note` (the envelope's period
// on the writing track's notes, language.md §19).
const TARGET_SYMBOLS = {
  PAN: PAN_MAP,
  LFO_WAVE: { saw: 0, square: 1, triangle: 2, noise: 3 },
  SSG_ENV: { none: -1 },
  ENV_RATE: { note: 0 },
  ENV_SEMI: { none: 0 },
  ENV_DETUNE: { none: 0 },
  // The SSG mixer's, as a `:mode` macro steps it (its inline :mode is the part's modes).
  SSG_MIX: { tone: 0, noise: 1, both: 2, env: 3 },
};

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

function parseIntLike(value) {
  if (typeof value !== "string") return null;
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  if (/^0x[0-9a-f]+$/i.test(value)) return parseInt(value, 16); // e.g. :seed 0xDEAD
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

// A sample path is relative to the FILE THAT DEFINED IT (docs/language.md §16):
// a def written in the score resolves against the score, and one folded in by
// `import` against the imported file, so a preset set can ship its own wav/.
function resolveSamplePath(sampleFile, baseDir) {
  const file = normalizePathSeparators(sampleFile);
  if (!file || isAbsolutePath(file)) return file;
  const base = normalizePathSeparators(baseDir || "");
  if (!base) return file;
  return normalizePosixPath(`${base}/${file}`);
}

// Where a file sits relative to the compiling score: its importer's directory
// joined with the path as written in that importer.
function importedFilePath(path, baseDir) {
  const p = normalizePathSeparators(path);
  if (isAbsolutePath(p) || !baseDir) return normalizePosixPath(p);
  return normalizePosixPath(`${baseDir}/${p}`);
}

// The frame clock this compile targets (driver.md §3.3). It is one number for
// the whole compile — every `Nf` in the source means that many frames of THIS
// clock — so it is a compile-scoped constant rather than a parameter threaded
// through the eighteen call sites of parseLengthToken. compileMMLisp sets it
// on entry and restores it on the way out; compiling is synchronous and does
// not recurse (an import only collects defs), so no two targets are ever live
// at once. Authoring is NTSC; PAL is an export target.
let compileFrameHz = FRAME_HZ_NTSC;

// Convert an Nf frame count (wall-clock, 1/compileFrameHz s) to musical ticks
// at `bpm`. Used where a duration advances the tick timeline (note length,
// :gate, ~, rest). The conversion uses the tempo active at compile time, so
// under a runtime tempo change an Nf note scales with tempo like any tick
// duration.
function framesToTicks(frames, bpm) {
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
const isFrameToken = (v) => /^\d+(f|ms)$/.test(String(v));

// A length token as an absolute duration in SECONDS, without the detour through
// ticks. The PCM range needs this: a tick is 5.2 ms at 120 BPM, so
// resolving `1ms` to ticks would round it away, while the engine can place a
// loop 1.11 ms long (one 16-byte block at pcm1 — driver.md §5).
function lengthTokenSeconds(token, bpm = 120) {
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
function resolveMacroLen(spec, bpm) {
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
function parseStepToken(value) {
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
//   :gate* <ratio> — fraction of the note length (0 <= ratio <= 1).
//   :gate- <time>  — shorten: note length minus this time (key off early).
function parseGateFamily(keyword, val, bpm = null) {
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

// A compile-time number in a value position (language.md §7.1): a literal, a
// `let` name, or an expression — `(+ 1 2)`, `(midi c4)`, a `noise` draw. The
// one reader for every count, id, option, ratio and level that resolves at
// compile time, so no position takes literals only. isConstNumberNode says
// whether a node is one (an optional positional asks first); readConstNumber
// returns the number, null when the node is not one (the caller says what the
// position takes), or undefined when an expression failed (the evaluator has
// said why).
function isConstNumberNode(node, env) {
  if (!node) return false;
  if (node.kind === "atom")
    return parseNumberLike(node.value) !== null || typeof lookupBound(env, node.value) === "number";
  const head = atomValue(node.items?.[0]);
  return node.kind === "list" && node.bracket === "()" && (isEvalHead(head) || head === "noise");
}
function readConstNumber(node, env, diagnostics, trackName, src, typedDefs = null) {
  if (!isConstNumberNode(node, env)) return null;
  if (node.kind === "atom") {
    const n = parseNumberLike(node.value);
    return n !== null ? n : lookupBound(env, node.value);
  }
  return evalScalarValue(node, env, makeEvalCtx(diagnostics, trackName, src, typedDefs)) ?? undefined;
}

// `:oct` / `:vel` resolve at compile time (§8): a number, a let-bound name or
// an expression. A `$slot` or a curve cannot be one — both are errors rather
// than the silent no-op they used to be.
// `fraction`: a value that keeps a fraction (:vel's eighths) — else a whole
// number, but for a `*` ratio.
function compileTimeScalar(node, raw, op, evalEnv, keyword, diagnostics, trackName, src, typedDefs, fraction = false) {
  if (node?.kind === "list") {
    const head = atomValue(node.items?.[0]);
    if (isConstNumberNode(node, evalEnv)) {
      return evalScalarValue(node, evalEnv, makeEvalCtx(diagnostics, trackName, src, typedDefs));
    }
    pushDiag(diagnostics, "error", "E_VALUE_COMPILE_TIME",
      `${keyword} takes a number or an expression, not (${head ?? ""} …) — use a (macro …) for motion`,
      src, trackName);
    return null;
  }
  const bound = lookupBound(evalEnv, raw);
  if (typeof bound === "number") return bound;
  const v = op === "*" || fraction ? parseNumberLike(raw) : parseIntLike(raw);
  if (v !== null && !Number.isNaN(v)) return v;
  pushDiag(diagnostics, "error", "E_VALUE_COMPILE_TIME",
    typeof raw === "string" && raw.startsWith("$")
      ? `${keyword} resolves at compile time and cannot read ${raw}`
      : `${keyword} takes a number, not ${raw}`,
    src, trackName);
  return null;
}

function gateInvalid(diagnostics, keyword, raw, src, trackName) {
  pushDiag(diagnostics, "error", "E_GATE_INVALID",
    keyword === ":gate*"
      ? `:gate* takes a ratio 0.0 to 1.0, not ${raw}`
      : `${keyword} takes a length, not ${raw}`,
    src, trackName);
}

function resolveGateTicks(gateSpec, lengthTicks) {
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
        // `*` multiplies the note's vel by each value (1 = unchanged); `+` adds
        // the note's vel as an offset (vel is a relative envelope around it).
        if (spec.op === "*") {
          const scaled = scaleMacroValues(spec, vel ?? 15, "VEL");
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
// CSM_RATE form (same shape as inline `:csm-rate (curve ...)`) from the rate
// running at this tick — a previous slide still under way included, as a
// note's glide starts from the pitch sounding (emitGlideIfNeeded) — or a
// one-shot `(glide <from> <time>)` override, given as a raw Hz literal or a
// pitch, to the new Hz over the full glide. A rate note with no glide is the
// const form, which ends a running slide. The ramp is kept in Timer A's
// period, the unit the driver sweeps in.
function emitCsmRateNoteHz(
  trackState,
  events,
  diagnostics,
  src,
  trackName,
  hz,
) {
  const tick = trackState.tick;
  const glideTicks = trackState.glide ?? 0;
  const ramp = trackState.glideRamp;
  trackState.csmStopped = false; // a rate starts Timer A again
  let fromHz = null;
  if (glideTicks > 0 && ramp) {
    const override = trackState.glideFrom;
    trackState.glideFrom = null; // one-shot reset, mirrors emitGlideIfNeeded
    if (override != null) {
      const n = parseNumberLike(String(override));
      fromHz = n !== null ? n : csmPitchToHz(String(override));
    }
    if (!Number.isFinite(fromHz))
      fromHz = Math.round(csmTimerHz(rampAt(ramp, tick), trackState.fmClock) * 100) / 100;
  }
  if (fromHz != null && fromHz !== hz) {
    emitCsmRateEvent(trackState, events, diagnostics, src, trackName, {
      from: fromHz,
      to: hz,
      len: glideTicks,
      curve: "linear",
    });
    trackState.glideRamp = {
      tick,
      ticks: glideTicks,
      from: csmTimerPeriod(fromHz, trackState.fmClock),
      to: csmTimerPeriod(hz, trackState.fmClock),
    };
  } else {
    emitCsmRateEvent(trackState, events, diagnostics, src, trackName, { hz });
    trackState.glideRamp = settledRamp(tick, csmTimerPeriod(hz, trackState.fmClock));
  }
}

function isPcmModeSymbol(value) {
  return value === "shot" || value === "loop" || value === "gate";
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
  // A `:key` voice moves the written note by its key − 60 (§9). Done here, at
  // the one entry every note takes, so ties, slurs, glides and echoes all see
  // the sounding pitch, as if it had been written.
  const shift = trackState.voiceKeyShift ?? 0;
  if (shift !== 0 && !trackState.isPcmTrack && !trackState.isCsmRateTrack) {
    const midi = pitchToMidi(noteName + trackState.defaultOct) + shift;
    if (midi < 0 || midi > 127) {
      pushDiag(diagnostics, "error", "E_NOTE_RANGE",
        `note ${midi} out of MIDI range 0..127 (the voice's :key moves it by ${shift})`,
        src, trackName);
      trackState.tick += lengthTicks;
      return;
    }
    const { name, octave } = midiToNoteParts(midi);
    const savedOct = trackState.defaultOct;
    trackState.voiceKeyShift = 0;
    trackState.defaultOct = octave;
    try {
      emitNoteForTrack(trackState, name, lengthTicks, events, diagnostics, src, trackName);
    } finally {
      trackState.defaultOct = savedOct;
      trackState.voiceKeyShift = shift;
    }
    return;
  }
  // Slur/tie connector (X ~ Y): a pending `~` connects this note to the previous
  // one. Same pitch → TIE (extend the previous note; works on every channel).
  // Different pitch → legato (a NOTE_ON that updates the frequency without
  // re-keying), applied on the standard FM/PSG note path below.
  let legato = false;
  if (trackState.pendingLegato && trackState.isPcmTrack) {
    // A tie on a sample holds the note: the same sample at the same pitch is
    // waited out as a TIE, not struck again. Anything else (a slur — PCM has
    // no pitch moves — or another sample) is a new hit.
    trackState.pendingLegato = false;
    const h = trackState.pcmTiedHead;
    const fullPitch = noteName + trackState.defaultOct;
    if (h && h.sample === trackState.pcmSampleName && pitchToMidi(h.pitch) === pitchToMidi(fullPitch)) {
      const tie = { tick: trackState.tick, cmd: "TIE", args: { length: lengthTicks }, src };
      events.push(tie);
      h.segs.push(tie);
      h.total += lengthTicks;
      placePcmTieOff(h, events);
      trackState.tick += lengthTicks;
      return;
    }
  } else if (trackState.pendingLegato) {
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
      trackState.lastNotePitch = cmpPitch;
      return;
    }
    legato = true;
    // A slur carries the left note into this one, so the left note (the head
    // of its tied group) sounds its whole slot: a gate cut there would key it
    // off before the slur and leave the new pitch nothing to ride. A hold
    // (gate 0) already never keys off, so it stays.
    const head = trackState.tiedHead;
    if (head && head.ev.args.gate > 0) delete head.ev.args.gate;
  }
  if (trackState.isPcmTrack) {
    const reported = (trackState.pcmReported ??= new Set());
    if (!trackState.pcmSampleName) {
      if (!reported.has("")) {
        reported.add("");
        pushDiag(diagnostics, "error", "E_PCM_SAMPLE_REQUIRED",
          "a pcm note needs a sample: name one before the notes", src, trackName);
      }
      trackState.tick += lengthTicks;
      return;
    }
    const fullPitch = noteName + trackState.defaultOct;
    // A voice the chip pitches glides as FM does (parts.js `pitch`).
    if (trackState.part?.pitch) emitGlideIfNeeded(trackState, fullPitch, events, trackState.glide, src);
    const mode = trackState.pcmMode; // sticky, like every track parameter
    const { ev: pcmEv, off, hasMacros } = pushPcmNote(trackState, events, {
      sample: trackState.pcmSampleName, pitch: fullPitch, length: lengthTicks,
      gateSpec: trackState.defaultGate, vel: trackState.defaultVel, mode,
      macros: trackState.activeMacros,
    }, src);
    stampDelay(pcmEv, trackState);
    // The head a `~` ties on to (placePcmTieOff).
    trackState.pcmTiedHead = {
      ev: pcmEv, off, segs: [pcmEv], total: lengthTicks, gateSpec: trackState.defaultGate,
      sample: trackState.pcmSampleName, pitch: fullPitch, mode, hasMacros,
    };
    trackState.tick += lengthTicks;
    if (trackState.part?.pitch) trackState.lastNotePitch = fullPitch;
    pushRecentNote(trackState, fullPitch, lengthTicks, trackState.defaultGate,
      trackState.defaultVel ?? 15, { sample: trackState.pcmSampleName, mode });
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
  if (trackState.isCsmTrack && trackState.csmStopped) {
    // An inline :csm-rate's buzz rested: the note starts it again.
    events.push({ tick: trackState.tick, cmd: "CSM_RATE", args: { run: true }, src });
    trackState.csmStopped = false;
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
  // The voice the note plays, for a def-mod :voice (a pcm note names its sample).
  if (trackState.voiceName) noteEv._voice = trackState.voiceName;
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
  trackState.lastNotePitch = fullPitch;
  // Feed the (echo …) history (a pcm note feeds it above).
  pushRecentNote(
    trackState,
    fullPitch,
    lengthTicks,
    trackState.defaultGate,
    trackState.defaultVel ?? 15,
  );
}

// `(note expr [len])` (§7.3): evaluate a MIDI number and emit one NOTE_ON at
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
  // Swing goes by the nominal length, written or default (§5.2).
  const ticks = resolveShuffleTicks(lengthTicks, trackState);
  const { name, octave } = midiToNoteParts(midi);
  const savedOct = trackState.defaultOct;
  trackState.defaultOct = octave;
  emitNoteForTrack(trackState, name, ticks, events, diagnostics, nodeSrc(node), trackName);
  trackState.defaultOct = savedOct;
}

// What a following note connects to: the previous pitch (a `~` tie/slur and a
// glide start from it), a pending `~`, and the head of the sounding tied group
// (whose gate a tie extends). Compiled in stream order, but a loop is not
// played in stream order — these carry the state across its edges.
function connectionState(ts) {
  return {
    lastNotePitch: ts.lastNotePitch,
    glideRamp: ts.glideRamp,
    pendingLegato: ts.pendingLegato,
    // The head as it stands here: a tie after this point (the body's, past a
    // (break)) extends the copy in force, not this one — else the tie after
    // the loop would count the body's too, and the gate land past the note.
    // Its event is the same one: whichever path writes last sets its gate.
    tiedHead: ts.tiedHead && { ...ts.tiedHead },
  };
}
function restoreConnectionState(ts, st) {
  ts.lastNotePitch = st.lastNotePitch;
  ts.glideRamp = st.glideRamp;
  ts.pendingLegato = st.pendingLegato;
  ts.tiedHead = st.tiedHead;
}

// A `~` pending at a backward jump connects to the jump target's first note.
// The target was compiled for the path that first entered it: when that note
// is a TIE (the entry was tied into it), the tail is tied into it too, so the
// tail note's gate is re-resolved across the TIE run — else it keys off at its
// own gate and the tie extends silence. The pending `~` itself stays for the
// stream-order successor (a counted loop's last pass falls through to it).
function connectAcrossJump(ts, events, fromIdx) {
  if (!ts.pendingLegato || !ts.tiedHead) return;
  let tieLen = 0;
  for (let k = fromIdx; k < events.length; k++) {
    const c = events[k].cmd;
    if (c === "TIE") tieLen += events[k].args?.length ?? 0;
    else if (c === "NOTE_ON" || c === "REST" || c === "PCM_NOTE_ON") break;
  }
  if (tieLen === 0) return;
  const head = ts.tiedHead;
  const total = head.total + tieLen;
  const g = resolveGateTicks(head.gateSpec, total);
  if (g < total) head.ev.args.gate = g;
  else delete head.ev.args.gate;
}

// Where a track's glide has its pitch (absolute cents) or, on fm3-csm-rate,
// its rate (Timer A period): a linear ramp from `from` at `tick` to `to` over
// `ticks`, then `to` — a note without a glide is a ramp of length 0. The value
// at a later tick is exact at constant tempo (a sweep's frames are fixed from
// the tempo at its start).
function rampAt(ramp, tick) {
  if (!ramp) return null;
  if (!(ramp.ticks > 0) || tick >= ramp.tick + ramp.ticks) return ramp.to;
  return ramp.from + ((ramp.to - ramp.from) * (tick - ramp.tick)) / ramp.ticks;
}
function rampRunning(ramp, tick) {
  return !!ramp && ramp.ticks > 0 && tick < ramp.tick + ramp.ticks;
}
function settledRamp(tick, value) {
  return { tick, ticks: 0, from: value, to: value };
}

/**
 * Glide (§14): a bounded NOTE_PITCH sweep before the NOTE_ON, from the pitch
 * sounding at this tick — the previous glide's remaining offset included, so a
 * glide longer than its note reads as a lagging pitch with no jump — to the
 * note's own pitch plus the sticky `:pitch` offset. A note with no glide of its
 * own ends a glide still running (a PARAM_SET ends its target's sweep in both
 * players), so a glide never bleeds into a later note. The `(glide from T)`
 * override is a one-shot absolute start.
 */
function emitGlideIfNeeded(trackState, newPitch, events, glideTicks, nodeSrc) {
  const tick = trackState.tick;
  const sticky = trackState.pitchSticky ?? 0;
  const base = pitchToMidi(String(newPitch)) * 100;
  const ramp = trackState.glideRamp;
  if (glideTicks <= 0 || !trackState.lastNotePitch) {
    startWithoutGlide(trackState, newPitch, events, nodeSrc);
    return;
  }
  const override = trackState.glideFrom;
  trackState.glideFrom = null; // One-shot reset
  const from = override
    ? pitchToMidi(String(override)) * 100 + sticky
    : rampAt(ramp, tick) ??
      pitchToMidi(String(trackState.lastNotePitch)) * 100 + sticky;
  trackState.glideRamp = { tick, ticks: glideTicks, from, to: base + sticky };
  // NOTE_PITCH is a cent offset relative to the note's own base pitch (the
  // player applies `baseMidi + centOffset/100`).
  events.push({
    tick,
    cmd: "PARAM_SWEEP",
    args: {
      target: "NOTE_PITCH",
      from: Math.round(from - base),
      to: sticky,
      curve: "linear",
      frames: glideTicks,
      loop: false,
      // A glide is a bounded one-shot: it slides over `frames` then stops, unlike
      // an inline pitch sweep that holds its final value until the next event.
      bounded: true,
    },
    src: nodeSrc,
  });
}

// A note that does not glide starts at its own pitch: a glide still running at
// its tick is ended there — by a sweep that holds the sticky offset for one
// tick, which replaces the glide like any sweep on its target. Not a PARAM_SET:
// that would write the old note's pitch on the spot, a moment before this
// note's own; a sweep's value is taken up by the note-on (onset_pitch).
function startWithoutGlide(trackState, pitch, events, src) {
  const tick = trackState.tick;
  const sticky = trackState.pitchSticky ?? 0;
  if (rampRunning(trackState.glideRamp, tick))
    events.push({
      tick,
      cmd: "PARAM_SWEEP",
      args: { target: "NOTE_PITCH", from: sticky, to: sticky, curve: "linear", frames: 1, loop: false, bounded: true },
      src,
    });
  trackState.glideRamp = settledRamp(tick, pitchToMidi(String(pitch)) * 100 + sticky);
}

// The `:pitch` offset the score set last, as far as the compiler can know it:
// a literal set, plus literal `:pitch+` steps; null once a curve or a `$value`
// makes it a runtime value (a glide then lands on offset 0). A `:pitch` write
// also ends a running glide in both players, so the pitch settles there.
function noteUserPitchWrites(trackState, written) {
  if (!written.length) return;
  for (const ev of written) {
    const v = ev.cmd === "PARAM_SET" ? ev.args.value : ev.args.delta;
    if (ev.cmd === "PARAM_SET" && typeof v === "number") trackState.pitchSticky = v;
    else if (ev.cmd === "PARAM_ADD" && typeof v === "number" && trackState.pitchSticky != null)
      trackState.pitchSticky += v;
    else trackState.pitchSticky = null;
  }
  if (trackState.lastNotePitch && !trackState.isCsmRateTrack)
    trackState.glideRamp = settledRamp(
      trackState.tick,
      pitchToMidi(String(trackState.lastNotePitch)) * 100 + (trackState.pitchSticky ?? 0),
    );
}

// A PCM note tied on (`c ~ c`): its key-off moves to the gate of the whole
// tied length, as an FM note's does. The off is an event of its own, so it
// goes where that gate lands — in the head (the head's own gate, which ends
// its duration there), or inside a TIE, which is split around it.
function placePcmTieOff(h, events) {
  if (h.off) {
    const at = events.indexOf(h.off);
    if (at >= 0) events.splice(at, 1);
    h.off = null;
  }
  const head = h.ev;
  const gate = resolveGateTicks(h.gateSpec, h.total);
  delete head.args.gate;
  if (!(gate > 0 && (h.mode !== "shot" || (h.hasMacros && gate < h.total)))) return;
  const offTick = head.tick + gate;
  const off = { tick: offTick, cmd: "PCM_NOTE_OFF", args: { sample: h.sample, mode: h.mode }, src: head.src };
  h.off = off;
  if (gate < head.args.length) {
    head.args.gate = gate;
    events.splice(events.indexOf(head) + 1, 0, off);
    return;
  }
  for (let k = 1; k < h.segs.length; k++) {
    const seg = h.segs[k];
    const end = seg.tick + seg.args.length;
    if (offTick > end || (offTick === end && k < h.segs.length - 1)) continue;
    const at = events.indexOf(seg);
    if (offTick <= seg.tick) {
      events.splice(at, 0, off);
    } else if (offTick >= end) {
      events.splice(at + 1, 0, off);
    } else {
      // Inside this TIE: wait to the off, release, wait out the rest.
      const rest = { tick: offTick, cmd: "TIE", args: { length: end - offTick }, src: seg.src };
      seg.args.length = offTick - seg.tick;
      events.splice(at + 1, 0, off, rest);
      h.segs.splice(k + 1, 0, rest);
    }
    return;
  }
}

// A part's rules for its notes (chips/parts.js `checkNote`), over a compiled
// layer's PCM notes — every one the layer wrote, before :prio flattening
// drops any. Reported once per layer, sample and reason.
// `shared` is the part's across the score's tracks (one rule said once).
function checkPartNotes(events, trackState, sampleDefs, diagnostics, trackName, shared = {}) {
  const { part, head, target } = trackState;
  if (!part?.checkNote) return;
  const seen = new Set();
  for (const ev of events) {
    if (ev.cmd !== "PCM_NOTE_ON") continue;
    const sample = sampleDefs.get(ev.args?.sample);
    if (!sample) continue;
    part.checkNote({
      sample, sampleName: ev.args.sample, pitch: ev.args.pitch, mode: ev.args.mode, head, target, shared,
      once(key, msg, severity = "error") {
        if (seen.has(key)) return;
        seen.add(key);
        targetDiag(diagnostics, severity, msg, ev.src, trackName);
      },
    });
  }
}

// One pcm note: its PCM_NOTE_ON and, where something listens for it, its
// PCM_NOTE_OFF — the note a pcm track writes, and an (echo …) tap replaying
// one. `macros` null plays it bare (an echo tap, as an FM/PSG one is).
function pushPcmNote(trackState, events, note, src) {
  const { sample, pitch, length, gateSpec, vel, mode, macros } = note;
  // Every note gets its own blob, baked at its own rate (driver.md §14.2);
  // the 32 KB bank is the only limit, so there is no practical-range clamp.
  const pcmRate = Math.pow(2, (pitchToMidi(pitch) - 60) / 12);
  const gateTicks = resolveGateTicks(gateSpec, length);
  const sampleDef = trackState.sampleDefs?.get(sample);
  const args = { sample, pitch, rate: pcmRate, length, mode };
  if (Number.isFinite(sampleDef?.rate) && sampleDef.rate > 0) {
    args.baseRate = sampleDef.rate;
  }
  if (vel !== undefined && vel !== 15) args.vel = vel;
  if (gateTicks < length) args.gate = gateTicks;
  // The note's macros, resolved as an FM/PSG note's are (a `:vel*` macro
  // scaled by this note's vel, tick lengths at this tempo).
  if (macros) {
    const withMacros = makeNoteArgs(pitch, length, gateSpec, vel, macros, trackState.currentTempo);
    const keys = trackState.part?.pitch ? PITCHED_PCM_MACRO_ARG_KEYS : PCM_MACRO_ARG_KEYS;
    for (const key of keys) if (withMacros[key]) args[key] = withMacros[key];
  }
  const hasMacros = PCM_MACRO_ARG_KEYS.some((key) => args[key]);
  const ev = { tick: trackState.tick, cmd: "PCM_NOTE_ON", args, src };
  events.push(ev);
  // The note's key-off: a loop's release, a gate note's cut, and where a
  // shot's macros take theirs — a shot with none has nothing that listens,
  // and at full gate the next note or rest keys it off anyway.
  let off = null;
  if (gateTicks > 0 && (mode !== "shot" || (hasMacros && gateTicks < length))) {
    off = {
      tick: trackState.tick + gateTicks,
      cmd: "PCM_NOTE_OFF",
      args: { sample, mode },
      src,
    };
    events.push(off);
  }
  return { ev, off, hasMacros };
}

// Rolling history of recently emitted notes (max 9) for (echo …) replay.
// pitch is absolute (includes octave), so the replay needs no octave bookkeeping.
// A pcm note also keeps its sample and mode, which its replay plays again.
function pushRecentNote(trackState, pitch, length, gateSpec, vel, pcm = null) {
  const hist = (trackState.recentNotes ||= []);
  hist.push({ pitch, length, gateSpec, vel, pcm });
  if (hist.length > 9) hist.shift();
}

// The shared arguments of (echo …) and (delay …): `[N] :vel+|:vel* V`, then
// `:key value` options. `:vel+` adds per tap and `:vel*` multiplies, relative
// to the source note (§12). V is the per-tap step — a number, with N taps
// (tap k is vel + k·V, or vel · V^k); the taps themselves — `[a b c]`, each
// relative to the source; or an envelope — a curve whose taps are its :len ÷
// the spacing. Returns { spec, opts } (spec as resolveDelayVels reads it) or
// null after a diagnostic.
function readTapArgs(form, items, env, ctx, diagnostics, trackName, src) {
  const code = form === "echo" ? "E_ECHO" : "E_DELAY";
  const fail = (suffix, msg) => {
    pushDiag(diagnostics, "error", `${code}_${suffix}`, msg, src, trackName);
    return null;
  };
  let j = 1;
  const countValue = isConstNumberNode(items[j], env)
    ? readConstNumber(items[j], env, diagnostics, trackName, src, ctx.typedDefs ?? null)
    : null;
  if (countValue === undefined) return null; // the evaluator has said why
  const count = countValue === null ? null : Math.round(countValue);
  if (count !== null) j++;
  const kw = atomValue(items[j]);
  if (kw !== ":vel+" && kw !== ":vel*")
    return fail("TARGET", `(${form} …) writes :vel+ (add per tap) or :vel* (multiply per tap), not ${kw ?? "nothing"}`);
  const mode = kw === ":vel*" ? "mul" : "add";
  const vNode = items[j + 1];
  const opts = {}, optNodes = {};
  for (let k = j + 2; k + 1 < items.length; k += 2) {
    opts[atomValue(items[k])] = atomValue(items[k + 1]);
    optNodes[atomValue(items[k])] = items[k + 1];
  }
  let spec;
  if (vNode?.kind === "list" && vNode.bracket === "[]") {
    if (count !== null)
      return fail("ARGS", `(${form} …): a vector gives the taps itself — drop the count ${count}`);
    const list = vNode.items.filter((n) => n.kind !== "comment").map((n) => parseNumberLike(atomValue(n)));
    if (!list.length || list.some((v) => v === null))
      return fail("ARGS", `(${form} …): a tap vector holds numbers`);
    spec = { mode, type: "list", list };
  } else {
    const r = vNode ? evalValue(vNode, env, ctx) : null;
    if (!r) return vNode ? null : fail("ARGS", `(${form} …) needs a value after ${kw}`);
    if (r.kind === "signal") {
      if (r.spec.steps || r.spec.stages)
        return fail("ARGS", `(${form} …): the envelope is one curve`);
      if (count !== null)
        return fail("ARGS", `(${form} …): a curve gives the taps by its :len — drop the count ${count}`);
      requireCurveFrom(r.spec, diagnostics, trackName, `(${form} …)`, src);
      spec = { mode, type: "curve", ...r.spec };
    } else {
      if (count === null)
        return fail("ARGS", `(${form} …): a per-tap step needs the tap count first — (${form} 3 ${kw} ${r.value}…)`);
      spec = { mode, type: "param", count: Math.max(1, count), by: r.value };
    }
  }
  return { spec, opts, optNodes };
}

// (echo …): replay the single note `back` positions back (back=1 = the last
// note), once per tap (1..count), each modulating `target` relative to that
// note's own value. Advances trackState.tick so the phrase lengthens. This
// matches mucom `\=n1,n2` (the note n1 back), where `back` = n1. The taps
// move :vel.
function emitEchoReplay(trackState, events, spec, back, src) {
  const hist = trackState.recentNotes || [];
  if (!hist.length) return;
  const note = hist[Math.max(0, hist.length - back)]; // clamp to the oldest note
  if (!note) return;
  // mucom replays the echoed pitch at the *current* defaults (the `\` expansion
  // substitutes the bare note name, inheriting the current length `l` and gate
  // `q`), not the source note's length/gate. The taps are spaced by that
  // length, which is also what an envelope's tap count divides by.
  const len = trackState.defaultLength;
  const gate = trackState.defaultGate;
  for (const vel of resolveDelayVels(spec, len, note.vel ?? 15) ?? []) {
    if (note.pcm) {
      pushPcmNote(trackState, events, {
        ...note.pcm, pitch: note.pitch, length: len, gateSpec: gate, vel, macros: null,
      }, src);
      trackState.tick += len;
      continue;
    }
    startWithoutGlide(trackState, note.pitch, events, src);
    // An FM3 operator's note is its own pitch write plus an operator-keyed
    // NOTE_ON, as a written one is.
    const op = trackState.isFm3OpTrack ? trackState.fm3OpIndex : null;
    if (op !== null)
      events.push({ tick: trackState.tick, cmd: "FM3_OP_PITCH", args: { op, pitch: note.pitch }, src });
    const ev = {
      tick: trackState.tick,
      cmd: "NOTE_ON",
      args: op !== null
        ? makeFm3OpNoteArgs(note.pitch, len, gate, vel, op, null)
        : makeNoteArgs(note.pitch, len, gate, vel, null),
      src,
    };
    // The voice the tap plays, for a def-mod :voice, as a written note's.
    if (trackState.voiceName) ev._voice = trackState.voiceName;
    events.push(ev);
    trackState.tick += len;
  }
}

function applyMacroEntryToState(trackState, irTarget, spec, ctx) {
  if (!spec || !MACRO_TARGETS.has(irTarget)) return;
  if (
    PCM_PITCH_TARGETS.has(irTarget) &&
    pcmRejectsPitch(
      trackState,
      `(macro ${PCM_PITCH_KEYWORD[irTarget]} …)`,
      ctx?.diagnostics,
      ctx?.src,
      ctx?.trackName,
      irTarget,
    )
  )
    return;
  if (trackState?.isPcmTrack && !PCM_MACRO_TARGETS.has(irTarget) && !(PCM_PITCH_TARGETS.has(irTarget) && pcmTakesPitch(trackState, irTarget))) {
    pushDiag(
      ctx?.diagnostics ?? [],
      "error",
      "E_PCM_MACRO_TARGET",
      `(macro ${ctx?.keyword ?? irTarget} …) has no effect on a pcm track: ` +
        "a PCM voice takes :keyon, :vel and :vol",
      ctx?.src ?? { line: 1, column: 1 },
      ctx?.trackName,
    );
    return;
  }
  trackState.activeMacros[irTarget] = spec;
}

// `(macro :target none)` clears one active macro; `(macro none)` clears all.
function clearMacroTarget(trackState, irTarget) {
  if (irTarget && MACRO_TARGETS.has(irTarget))
    delete trackState.activeMacros[irTarget];
}

// Resolve a (delay …) spec into concrete per-tap velocities, RELATIVE to
// the source note's vel. `param` = a regular ramp from `:by` (additive on :vel /
// geometric on :vel*); `list` = explicit per-tap deltas/ratios; `curve` = a
// relative envelope whose tap count is :len ÷ spacing. mode "add"|"mul".
function resolveDelayVels(spec, delayTicks, srcVel) {
  if (!spec || !(delayTicks > 0)) return null;
  const mul = spec.mode === "mul";
  const apply = (rel) => clampForTarget("VEL", mul ? srcVel * rel : srcVel + rel);
  if (spec.type === "param") {
    const by = spec.by ?? 0;
    const out = [];
    for (let k = 1; k <= spec.count; k++) out.push(apply(mul ? Math.pow(by, k) : by * k));
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
        st && st.from !== undefined ? Math.max(m, st.from, st.to ?? 0) : st?.fromNow ? Math.max(m, st.to ?? 0) : m,
      0,
    );
  }
  return 0;
}

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
          : st?.fromNow // a release from where the level is: its end alone
            ? { ...st, to: s(st.to ?? 0) }
            : st,
      ),
    };
  }
  return spec;
}

// Scale a macro spec's values by `factor`, clamped to `target`'s range (kept
// float, quantized at playback), preserving type, markers, and per-macro step.
// Shared by the `*` multiplicative modifier (factor = the note's static base)
// and :delay echoes (factor = the echo's vel ratio).
function scaleMacroValues(spec, factor, target) {
  return mapMacroValues(spec, (v) => clampForTarget(target, v * factor));
}

function addMacroValues(spec, offset, target) {
  return mapMacroValues(spec, (v) => clampForTarget(target, v + offset));
}

// Macro targets that accept the `*` (multiplicative) modifier: each has a
// per-note/channel static base its macro values scale. Offset targets
// (NOTE_PITCH/NOTE_SEMI) and discrete ones (PAN/KEYON/...) have no base, so
// `*` is rejected there.
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

function exprHasValRef(node) {
  if (node?.kind === "atom")
    return typeof node.value === "string" && node.value.startsWith("$");
  if (node?.kind === "list") return node.items.some(exprHasValRef);
  return false;
}

// The eval ctx of a value position that lowers a `$` reference: the evaluator
// keeps it symbolic as a param-opcode chain (mmlisp-eval.js Runtime), `$<param>`
// naming `target` reads the parameter itself, and a `$name` resolves (and is
// diagnosed) against the declared slots.
function valueCtx(target, vals, diagnostics, trackName, src, typedDefs = null) {
  return {
    ...makeEvalCtx(diagnostics, trackName, src, typedDefs),
    i16: target === "NOTE_PITCH" || target === "SNAP",
    isSelf: (name) => target != null && (canonicalTarget(":" + name) === target ||
      (vals?.has(name) && `VAL${vals.get(name).slot}` === target)),
    resolveSlot: (raw) => resolveValRef(raw, vals, diagnostics, trackName, src),
  };
}

// Emit a runtime value's opcode chain on `target` (language.md §7.1.2): the
// seed, then each term, the parameter itself the accumulator.
function emitRuntime(steps, target, push, diagnostics, trackName, src) {
  const writes = steps.filter((s) => s.op !== "self").length;
  if (writes > 6)
    pushDiag(diagnostics, "warning", "W_EVAL_CHAIN_LONG",
      `expression lowers to ${writes} register writes (language.md §7.1.2)`, src, trackName);
  for (const s of steps) {
    if (s.op === "self") continue;
    if (s.op === "set") push("PARAM_SET", { target, value: Math.round(s.val) });
    else if (s.op === "fromval") push("PARAM_FROM_VAL", { target, src: s.ref });
    else if (s.op === "add") push("PARAM_ADD", { target, delta: Math.round(s.val) });
    else if (s.op === "addval") push("PARAM_ADD", { target, delta: { src: s.ref } });
    else if (s.op === "mul") push("PARAM_MUL", { target, factor: s.val });
    else if (s.op === "mulval") push("PARAM_MUL", { target, factor: { src: s.ref } });
  }
}

// Read a value-position node. Every parameter write reads its value here, so
// a literal, a let name, an expression, a curve and a `$` reference mean the
// same thing wherever a value goes. Returns
//   { kind: "none" }            — the word `none`
//   { kind: "scalar", value }   — a number (literal, let name, expression)
//   { kind: "signal", spec }    — a curve, or arithmetic on one
//   { kind: "runtime", steps }  — carries a `$` reference: the opcode chain
//                                 that computes it at run time (+ `node`)
//   { kind: "symbol", value }   — any other bare word, for the position to name
// or null after a diagnostic. `ctx` is a valueCtx where a `$` can lower.
function readValue(node, env, ctx) {
  if (node?.kind === "atom") {
    const v = node.value;
    if (v === "none") return { kind: "none" };
    if (
      !(typeof v === "string" && v.startsWith("$")) &&
      parseNumberLike(v) === null && lookupBound(env, v) === undefined
    )
      return { kind: "symbol", value: v };
  }
  const r = evalValue(node, env, ctx);
  if (r?.kind === "runtime") r.node = node;
  return r;
}

const atomNode = (value) => ({ kind: "atom", value: String(value) });

// Targets written as a value alone: no curve, no `+` / `*` (the envelope's
// moves are read where its period is written, language.md §19).
const SET_ONLY_TARGETS = new Set(["ENV_SEMI", "ENV_DETUNE"]);
// Targets whose literal keeps its fraction: a rate in Hz (an SSG
// envelope's period is a step of it at the bass).
const FRACTIONAL_TARGETS = new Set(["ENV_RATE"]);

// Write a hardware parameter from a readValue result. An operator reads the
// parameter itself: `:tl1+ e` is `(+ $tl1 e)` and `:tl1* e` is `(* $tl1 e)`,
// lowered like any other runtime expression (PARAM_ADD / PARAM_MUL).
function writeParam(target, op, sym, v, push, env, vals, diagnostics, trackName, src) {
  if (!v) return;
  const err = (code, msg) => pushDiag(diagnostics, "error", code, msg, src, trackName);
  if (v.kind === "none" && !op && TARGET_SYMBOLS[target]?.none !== undefined) {
    push("PARAM_SET", { target, value: TARGET_SYMBOLS[target].none });
    return;
  }
  if (v.kind === "none") {
    // Stop a running inline PARAM_SWEEP, freezing the value.
    if (op) err("E_PARAM_VALUE", `${sym} needs a number or a $value, not none`);
    else push("PARAM_SWEEP_STOP", { target });
    return;
  }
  if (v.kind === "symbol") {
    if (!op && v.value in (TARGET_SYMBOLS[target] ?? {}))
      push("PARAM_SET", { target, value: TARGET_SYMBOLS[target][v.value] });
    else
      err("E_PARAM_VALUE",
        `${sym} takes a number, a curve or a $value, not '${v.value}'`);
    return;
  }
  if ((v.kind === "signal" || op) && SET_ONLY_TARGETS.has(target)) {
    err("E_PARAM_VALUE", `${sym} takes a number or a $value, read at the write`);
    return;
  }
  if (v.kind === "signal") {
    if (op)
      err("E_EVAL_TYPE", `${sym} needs a number or a $value; a curve has no '${op}' form`);
    else if (v.spec.steps)
      // A materialized signal⊕signal step vector has no inline PARAM_SWEEP
      // form — it's a macro-only shape.
      err("E_EVAL_SIGNAL_SHAPE",
        `signal arithmetic ${sym} is only valid in a (macro …), not an inline sweep`);
    else push("PARAM_SWEEP", { target, ...v.spec });
    return;
  }
  if (!op && v.kind === "scalar") {
    push("PARAM_SET", { target, value: FRACTIONAL_TARGETS.has(target) ? v.value : Math.round(v.value) });
    return;
  }
  let steps = v.steps;
  if (op) {
    const operand = v.kind === "scalar" ? atomNode(v.value) : v.node;
    const expr = { kind: "list", bracket: "()", items: [atomNode(op), atomNode("$" + opSuffix(sym).stem.slice(1)), operand] };
    const r = evalValue(expr, env, valueCtx(target, vals, diagnostics, trackName, src));
    if (!r) return;
    steps = r.steps;
  }
  emitRuntime(steps, target, push, diagnostics, trackName, src);
}

// A level written on an SSG channel on its envelope (`:env`): the envelope
// is the level there, so a :vol or :vel only silences at 0. Said once a track.
function warnEnvLevel(trackState, sym, diagnostics, src, trackName) {
  if (!trackState.ssgEnv || trackState.envLevelSaid) return;
  trackState.envLevelSaid = true;
  pushDiag(diagnostics, "warning", "W_TARGET",
    `${sym} does not set the level of ${trackState.head} on :env (the envelope is its level; 0 still silences)`,
    src, trackName);
}

// `:snap` (language.md §5.3): a pitch-class mask the channel's pitch writes
// snap down to. Written as the classes `[0 4 7]` (each folded mod 12, so
// `(+ root n)` transposes), the mask itself, or a `$slot`; `none` is 0 = off.
// A mask is state, not a level: no curve, no `+`/`*`.
function writeSnap(sym, op, valueNode, env, vals, push, diagnostics, src, trackName, typedDefs) {
  const err = (msg) => pushDiag(diagnostics, "error", "E_PARAM_VALUE", msg, src, trackName);
  if (op) return err(`${sym} is a mask; it has no '${op}' form`);
  if (valueNode?.kind === "list" && valueNode.bracket === "[]") {
    let mask = 0;
    for (const item of valueNode.items.filter((n) => n.kind !== "comment")) {
      const v = evalScalarValue(item, env, makeEvalCtx(diagnostics, trackName, src, typedDefs));
      if (v === null) return;
      if (!Number.isInteger(v)) return err(`:snap takes whole pitch classes, not ${v}`);
      mask |= 1 << (((v % 12) + 12) % 12);
    }
    push("PARAM_SET", { target: "SNAP", value: mask });
    return;
  }
  const v = readValue(valueNode, env, valueCtx("SNAP", vals, diagnostics, trackName, src, typedDefs));
  if (!v) return;
  if (v.kind === "none") push("PARAM_SET", { target: "SNAP", value: 0 });
  else if (v.kind === "scalar") push("PARAM_SET", { target: "SNAP", value: Math.round(v.value) });
  else if (v.kind === "runtime") emitRuntime(v.steps, "SNAP", push, diagnostics, trackName, src);
  else err(`:snap takes pitch classes [0 4 7], a mask, a $value or none, not a ${v.kind === "signal" ? "curve" : `'${v.value}'`}`);
}

// An inline `:vel2 0.5`: a ratio 0–1, fixed at compile time, on an FM track.
function writeVelSens(target, sym, op, valueNode, env, vals, push, diagnostics, src, trackName, typedDefs) {
  const err = (code, msg) => pushDiag(diagnostics, "error", code, msg, src, trackName);
  const ch = String(trackName).split(":")[0];
  if (ch === "fm3-csm-rate") // a rate source, not a voice (a PSG or PCM track is its part's)
    return err("E_UNSUPPORTED_TARGET", `${sym} is an FM operator's; ${ch} has none`);
  if (op) return err("E_PARAM_VALUE", `${sym} is a ratio set as a whole; it has no '${op}' form`);
  const v = readValue(valueNode, env, valueCtx(target, vals, diagnostics, trackName, src, typedDefs));
  if (!v) return;
  const k16 = v.kind === "scalar" ? velSensSixteenths(v.value) : null;
  if (k16 === null) {
    const what = v.kind === "scalar" ? v.value : v.kind === "signal" ? "a curve"
      : v.kind === "runtime" ? "a $value" : `'${v.value ?? v.kind}'`;
    return err("E_PARAM_VALUE", `${sym} takes a ratio 0..1 of the velocity, fixed at compile time, not ${what}`);
  }
  push("PARAM_SET", { target, value: k16 });
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

// [start, end) note intervals, indexed for the two questions the delay and
// :prio passes ask: is a note sounding at `t`, and when does the next one
// start after `t`. Sorted by start, with the latest end among each prefix — a
// note sounds at `t` iff one starting by `t` ends after it.
function intervalIndex(intervals) {
  const starts = [];
  const reach = [];
  for (const [st, en] of [...intervals].sort((a, b) => a[0] - b[0])) {
    starts.push(st);
    reach.push(Math.max(en, reach.at(-1) ?? -Infinity));
  }
  const startedBy = (t) => { // how many start at or before t
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    sounding: (t) => {
      const n = startedBy(t);
      return n > 0 && reach[n - 1] > t;
    },
    nextStart: (t) => starts[startedBy(t)] ?? Infinity,
  };
}

// Compile-time delay expansion (§12). Each note stamped with _delay
// emits echo copies at +k·spacing with the tap velocities. Written (source)
// notes outrank echoes (monophonic priority): a tap starting while a written
// note sounds (its gate) is dropped, and one starting in a gap is cut short at
// the next written note. Among taps the newer cuts the older; two on one tick
// keep the louder.
function expandTrackDelays(track) {
  const events = track.events;
  const NOTE_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON"]);
  const sources = events.filter((e) => e._delay && NOTE_CMDS.has(e.cmd));
  if (sources.length === 0) {
    for (const e of events) delete e._delay;
    return;
  }
  const { sounding, nextStart: nextWritten } = intervalIndex(
    events.filter((e) => NOTE_CMDS.has(e.cmd)).map((e) => [e.tick, e.tick + prioNoteSpan(e)]),
  );

  const echoes = [];
  for (const ev of sources) {
    const { ticks, vels } = ev._delay;
    const span = prioNoteSpan(ev);
    for (let k = 0; k < vels.length; k++) {
      const tick = ev.tick + (k + 1) * ticks;
      if (sounding(tick)) continue;
      // Echoes inherit the source's articulation macros (keyon / semi / pitch /
      // op, each with its own :step). The vel macro is inherited but scaled so
      // this echo's tail peaks at its :delay-vels level; the dry note is left
      // untouched.
      const args = { ...ev.args };
      const dv = vels[k];
      if (args.velMacro) {
        const peak = velMacroPeak(args.velMacro);
        const ratio = peak > 0 ? dv / peak : 0;
        args.velMacro = scaleMacroValues(args.velMacro, ratio, "VEL");
      }
      if (dv === 15) delete args.vel;
      else args.vel = dv;
      echoes.push({
        tick, cmd: ev.cmd, args, src: ev.src, _voice: ev._voice,
        _end: Math.min(tick + span, nextWritten(tick)),
      });
    }
  }
  for (const e of events) delete e._delay;
  // Same tick: the louder tap stays. Then each tap ends where the next begins.
  echoes.sort((a, b) => a.tick - b.tick || (b.args.vel ?? 15) - (a.args.vel ?? 15));
  const taps = echoes.filter((e, i) => i === 0 || e.tick !== echoes[i - 1].tick);
  taps.forEach((e, i) => {
    const end = Math.min(e._end, taps[i + 1]?.tick ?? Infinity);
    if (end - e.tick < prioNoteSpan(e)) e.args.gate = end - e.tick;
    delete e._end;
  });
  if (taps.length) {
    events.push(...taps);
    events.sort((a, b) => a.tick - b.tick);
  }
}

// :prio layering (§1). Multiple forms of the same channel with different :prio
// values become independent parallel timelines; this post-pass flattens them
// into one monophonic event stream. Lower number = higher priority. Note events
// are resolved preemptively: a note is dropped where a higher-priority note is
// already sounding, and truncated (simple cut to silence) where a higher-priority
// note begins mid-sustain. A channel parameter belongs to the highest layer
// that sets it; other non-note events pass through in tick order. Counted
// loops are written out first, and an endless loop must agree across layers.
const PRIO_NOTE_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON"]);

// Sounding span of a note: gate (if set) else length; 0 means hold
// indefinitely (§ gate/len 0), modelled here as occupying the channel forever.
function prioNoteSpan(ev) {
  const g = ev.args.gate;
  if (g === 0) return Infinity;
  if (g != null) return g;
  const l = ev.args.length;
  return l === 0 ? Infinity : (l ?? 0);
}

// A channel is one voice, so its layers compete for it.
function flattenPriorityLayers(head, layers, diagnostics) {
  // Highest priority first (lowest number). The first layer is the container we
  // reuse for channel/scoreChannel; only its event list is rebuilt.
  layers.sort((a, b) => a.prio - b.prio);

  // A counted loop compiles once, so after one a layer runs on pass-1 ticks
  // while its neighbours run on real ones: each layer's counted loops are
  // written out first (a `(go label N)` becoming the loop pair it stands for).
  for (const { trackData } of layers) {
    convertCountedJumps(trackData);
    if (trackData.events.some((e) => e.cmd === "LOOP_BEGIN")) {
      trackData.events = expandLoops(trackData.events).map((e) => (e.args ? { ...e, args: { ...e.args } } : e));
    }
  }

  let occupied = []; // committed sounding intervals from higher-priority layers
  const drop = new Set();

  // An endless loop (the song's `#loop … (go loop)`, an (x …) without a count)
  // is the channel's, one: layers that loop must loop over the same ticks, and
  // the merged stream keeps the highest one's MARKER and JUMP. What any layer
  // has past the jump never plays.
  const loopOf = (evs) => {
    const jumps = evs.filter((e) => e.cmd === "JUMP");
    if (!jumps.length) return undefined;
    const marker = jumps.length === 1 && evs.find((e) => e.cmd === "MARKER" && e.args?.id === jumps[0].args?.to);
    return marker ? { from: marker.tick, to: jumps[0].tick, jump: jumps[0], marker } : null;
  };
  const looping = layers.map((l) => loopOf(l.trackData.events)).filter((x) => x !== undefined);
  let loop = null;
  if (looping.some((x) => x === null || x.from !== looping[0].from || x.to !== looping[0].to)) {
    pushDiag(
      diagnostics,
      "error",
      "E_PRIO_LAYER_LOOP",
      `the :prio layers on channel ${head} loop over different ticks; a channel has one loop — start and end it at the same tick on every layer that loops`,
      { line: 1, column: 1 },
      head,
    );
    for (const x of looping.slice(1)) if (x) drop.add(x.jump).add(x.marker); // one E_ is enough
  } else if (looping.length) {
    loop = looping[0];
    for (const x of looping.slice(1)) drop.add(x.jump).add(x.marker);
    let lost = false;
    for (const { trackData } of layers) {
      for (const e of trackData.events) {
        if (e === loop.jump || drop.has(e)) continue;
        const note = PRIO_NOTE_CMDS.has(e.cmd);
        if (e.tick > loop.to || (note && e.tick === loop.to)) { drop.add(e); lost ||= note; }
      }
    }
    if (lost) {
      pushDiag(
        diagnostics,
        "warning",
        "W_PRIO_LAYER_PAST_LOOP",
        `a :prio layer on channel ${head} has notes past the channel's loop end; they never play`,
        { line: 1, column: 1 },
        head,
      );
    }
  }

  // The voice, :pan, :vol and the other channel parameters are the channel's
  // registers, one of each: a parameter a higher-priority layer sets is that
  // layer's, and a lower layer's writes to it are dropped. One no higher layer
  // touches is the lower layer's to set, for every layer's notes.
  const owned = new Set();
  for (const { trackData } of layers) {
    const mine = new Set();
    for (const e of trackData.events) {
      const target = e.cmd.startsWith("PARAM_") ? e.args?.target : null;
      if (target == null) continue;
      if (owned.has(target)) drop.add(e);
      else mine.add(target);
    }
    for (const t of mine) owned.add(t);
  }

  for (const { trackData } of layers) {
    const notes = trackData.events
      .filter((e) => PRIO_NOTE_CMDS.has(e.cmd) && !drop.has(e))
      .sort((a, b) => a.tick - b.tick);

    const committed = []; // this layer's sounding intervals
    const higher = intervalIndex(occupied);
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      const t = ev.tick;
      // Suppressed: starts while a higher-priority note is sounding.
      if (higher.sounding(t)) {
        drop.add(ev);
        continue;
      }
      const rawEnd = t + prioNoteSpan(ev); // gate/len end (may be Infinity)
      const nextSame = notes[i + 1]?.tick ?? Infinity; // own retrigger ends it
      const nextHi = higher.nextStart(t); // next higher-priority onset
      // A higher-priority note interrupts before this note's natural end → cut
      // to silence (no release tail in this version).
      if (nextHi < rawEnd && nextHi < nextSame) ev.args.gate = nextHi - t;
      committed.push([t, Math.min(rawEnd, nextSame, nextHi)]);
    }
    occupied = [...occupied, ...committed];
  }

  // A layer's rests say nothing once the layers share one voice — a lower
  // layer's note may sound through a higher layer's rest and the other way
  // round — so the merged stream keeps none: its gaps are rests already (the
  // MMB exporter writes one wherever time passes without a note).
  const base = layers[0].trackData;
  base.events = layers
    .flatMap((l) => l.trackData.events)
    .filter((ev) => !drop.has(ev) && ev.cmd !== "REST")
    .sort((a, b) => a.tick - b.tick || (a === loop?.jump) - (b === loop?.jump));
  return base;
}

// (def-mod [:ch c|[c…]] [:voice v|[v…]] action…) — a score-wide rewrite of
// the notes it selects (language.md §9.4): `:keyon off` turns them into rests,
// `:vel` / `:vel+` / `:vel*` move their velocity (clamped to 0–15). Read after
// the defs are expanded, so a def can name a list of targets.
const MOD_VEL_OPS = { ":vel": "=", ":vel+": "+", ":vel*": "*" };
function parseModDef(root, channelNames, typedDefs, sampleDefs, diagnostics) {
  const items = root.items.filter((n) => n.kind !== "comment");
  const src = nodeSrc(root);
  const err = (code, msg, at = src) => pushDiag(diagnostics, "error", code, `def-mod: ${msg}`, at, "global");
  const mod = { ch: null, voice: null, keyonOff: false, vel: [] };
  let ok = true;
  for (let k = 1; k < items.length; k += 2) {
    const key = atomValue(items[k]);
    const valueNode = items[k + 1];
    if (!valueNode) {
      err("E_MOD_OPTION", `${key ?? "a value"} needs a value`, nodeSrc(items[k]));
      ok = false;
      break;
    }
    if (key === ":ch" || key === ":voice") {
      const names = valueNode.kind === "list" && valueNode.bracket === "[]"
        ? valueNode.items.filter((n) => n.kind !== "comment")
        : [valueNode];
      const set = (key === ":ch" ? mod.ch : mod.voice) ?? new Set();
      for (const n of names) {
        const name = n.kind === "atom" ? n.value : null;
        const known = key === ":ch"
          ? channelNames.includes(name)
          : typedDefs.get(name)?.tag === "voice" || sampleDefs.has(name);
        if (!known) {
          err("E_MOD_TARGET", key === ":ch"
            ? `${name ?? "a list"} is not a channel name`
            : `${name ?? "a list"} is not a def-fm voice or a def-pcm sample`, nodeSrc(n));
          ok = false;
          continue;
        }
        set.add(name);
      }
      if (key === ":ch") mod.ch = set;
      else mod.voice = set;
    } else if (key === ":keyon") {
      if (atomValue(valueNode) === "off") mod.keyonOff = true;
      else {
        err("E_MOD_OPTION", `:keyon takes off, not ${atomValue(valueNode) ?? "a list"}`, nodeSrc(valueNode));
        ok = false;
      }
    } else if (MOD_VEL_OPS[key]) {
      const value = readConstNumber(valueNode, null, diagnostics, "global", nodeSrc(valueNode));
      if (value === undefined) ok = false;
      else if (value === null) {
        err("E_MOD_OPTION", `${key} takes a number, not ${atomValue(valueNode) ?? "a list"}`, nodeSrc(valueNode));
        ok = false;
      } else mod.vel.push({ op: MOD_VEL_OPS[key], value });
    } else {
      err("E_MOD_OPTION", `unknown option ${key ?? describeNodeToken(items[k])} (takes :ch :voice :keyon :vel :vel+ :vel*)`,
        nodeSrc(items[k]));
      ok = false;
    }
  }
  if (ok && !mod.keyonOff && mod.vel.length === 0) {
    err("E_MOD_OPTION", "nothing to do: give :keyon off or :vel / :vel+ / :vel*");
    ok = false;
  }
  return ok ? mod : null;
}

// A note's velocity — `vel` and every value of its vel macro — through a
// mod's ops in written order, each clamped. `:vel V` sets the note's vel and
// moves its envelope by the same step, so the shape survives.
function applyModVel(args, ops) {
  let v = args.vel ?? 15;
  let macro = args.velMacro;
  for (const { op, value } of ops) {
    const next = op === "+" ? v + value : op === "*" ? v * value : value;
    if (macro)
      macro = mapMacroValues(macro, (x) =>
        clampForTarget("VEL", op === "*" ? x * value : x + (op === "+" ? value : value - v)));
    v = clampForTarget("VEL", next);
  }
  if (v === 15) delete args.vel;
  else args.vel = v;
  if (macro) args.velMacro = macro;
}

// Apply the score's def-mods to one layer's events (head = its channel name).
// Runs after the delay expansion, so echoes are notes like any other, and
// before the :prio merge, so a removed note leaves its time to a lower layer.
function applyMods(events, head, mods) {
  const mine = mods.filter((m) => !m.ch || m.ch.has(head));
  if (mine.length === 0) return events;
  const voiceOf = (ev) => (ev.cmd.startsWith("PCM_") ? ev.args.sample : ev._voice ?? null);
  const hits = (ev) => mine.filter((m) => !m.voice || m.voice.has(voiceOf(ev)));
  const out = [];
  let dropped = false; // the last note was removed: its ties go with it
  for (const ev of events) {
    if (ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") {
      const ms = hits(ev);
      if (ms.some((m) => m.keyonOff)) {
        out.push({ tick: ev.tick, cmd: "REST", args: { length: ev.args.length }, src: ev.src });
        dropped = true;
        continue;
      }
      // A slur from a removed note has nothing to slur from.
      if (dropped) delete ev.args.legato;
      dropped = false;
      for (const m of ms) if (m.vel.length) applyModVel(ev.args, m.vel);
    } else if (ev.cmd === "TIE" && dropped) {
      out.push({ tick: ev.tick, cmd: "REST", args: { length: ev.args.length }, src: ev.src });
      continue;
    } else if (ev.cmd === "PCM_NOTE_OFF" && hits(ev).some((m) => m.keyonOff)) {
      continue;
    }
    out.push(ev);
  }
  return out;
}

// `:fx [(name …) (name …)]` → the IR's resolved chain (docs/ir.md §2.2):
// `{type, …params}` with every param filled in, times in seconds (at the
// score's opening tempo, like the range points) and levels in dB. The table
// the params are checked against is sample-fx.js's, the same one that runs
// them.
function resolveSampleEffects(node, bpm, diagnostics, src) {
  const err = (code, msg, at) =>
    pushDiag(diagnostics, "error", code, `def-pcm :fx ${msg}`, at ? nodeSrc(at) : src, "global");
  if (node?.kind !== "list" || node.bracket !== "[]") {
    err("E_SAMPLE_FX", `takes a [...] of effects, got ${describeNodeToken(node)}`, node);
    return [];
  }
  const chain = [];
  for (const item of node.items) {
    if (item.kind === "comment") continue;
    const items = item.kind === "list" ? item.items.filter((n) => n.kind !== "comment") : null;
    const type = items && item.bracket === "()" ? atomValue(items[0]) : null;
    const spec = type ? SAMPLE_EFFECTS[type] : null;
    if (!spec) {
      err("E_SAMPLE_FX_UNKNOWN",
        `has no effect ${describeNodeToken(item)} (known: ${Object.keys(SAMPLE_EFFECTS).join(", ")})`, item);
      continue;
    }
    const raw = {};
    let k = 1;
    if (spec.pos && k < items.length && !atomValue(items[k])?.startsWith(":")) {
      raw[spec.pos] = items[k++];
    }
    for (; k < items.length; k += 2) {
      const key = atomValue(items[k]);
      const name = key?.startsWith(":") ? key.slice(1) : null;
      if (!name || !spec.params[name]) {
        err("E_SAMPLE_FX_PARAM", `(${type}) has no parameter ${describeNodeToken(items[k])}`, items[k]);
        continue;
      }
      if (k + 1 >= items.length) {
        err("E_SAMPLE_FX_PARAM", `(${type}) ${key} has no value`, items[k]);
        continue;
      }
      raw[name] = items[k + 1];
    }
    const fx = { type };
    let ok = true;
    for (const [name, p] of Object.entries(spec.params)) {
      const at = raw[name];
      if (at === undefined) {
        if (p.required) {
          err("E_SAMPLE_FX_PARAM", `(${type}) needs :${name}`, item);
          ok = false;
        } else fx[name] = p.def;
        continue;
      }
      const tok = atomValue(at);
      let v = null;
      if (p.kind === "time") {
        v = lengthTokenSeconds(tok, bpm);
        // Only a span has to be positive (`positive`); an attack, a release or
        // an :at of 0 is instant / the start.
        if (v !== null && !(v > 0) && p.positive) v = null;
      } else if (p.kind === "curve") {
        v = CURVE_NAMES.has(tok) && !LOOP_CURVE_NAMES.has(tok) ? tok : null;
      } else {
        const n = typeof tok === "string" && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) ? Number(tok) : null;
        v = n !== null && (p.kind !== "int" || Number.isInteger(n)) ? n : null;
        if (v !== null && ((p.min != null && v < p.min) || (p.max != null && v > p.max))) v = null;
      }
      if (v === null) {
        const want = p.kind === "time" ? (p.positive ? "a length > 0" : "a length")
          : p.kind === "curve" ? "a one-shot curve name (linear, ease-…)"
          : `${p.kind === "int" ? "an integer" : "a number"}` +
            (p.min != null && p.max != null ? ` ${p.min}..${p.max}`
              : p.min != null ? ` >= ${p.min}` : p.max != null ? ` <= ${p.max}` : "");
        err("E_SAMPLE_FX_PARAM", `(${type}) :${name} must be ${want}, got ${describeNodeToken(at)}`, at);
        ok = false;
        continue;
      }
      fx[name] = v;
    }
    if (ok) chain.push(fx);
  }
  return chain;
}

// A def-pcm's `:key value …` body. `base` is the sample it extends: the
// child takes the base's file (still read from the base's folder), slice,
// loop and effects and overrides the keys it writes (resolveSampleExtends).
function parseSampleDef(bodyItems, base, diagnostics, src) {
  const sample = {
    extends: base,
    file: null,
    rate: null,
    offset: null,
    frames: null,
    startTok: null,
    endTok: null,
    lenTok: null,
    startSec: null,
    endSec: null,
    loopStartTok: null,
    loopEndTok: null,
    loopLenTok: null,
    loopStartSec: null,
    loopEndSec: null,
    fxNode: null,
    fx: [],
  };

  for (let ki = 0; ki + 1 < bodyItems.length; ki += 2) {
    const key = atomValue(bodyItems[ki]);
    const rawVal = atomValue(bodyItems[ki + 1]);
    if (key === ":fx") {
      // Resolved with the range points, once the score's opening tempo is known
      // (a fade `:len 8` is a musical length).
      sample.fxNode = bodyItems[ki + 1];
      continue;
    }
    if (key === ":file") {
      sample.file = rawVal;
    } else if (key === ":rate" || key === ":offset" || key === ":frames") {
      // Whole numbers: a rate in Hz, a frame position and a frame count. One
      // that does not read leaves the key at its default — say so.
      const n = parseIntLike(rawVal);
      if (n !== null && key === ":rate" && n <= 0)
        pushDiag(diagnostics, "warning", "W_SAMPLE_KEY_INVALID",
          `def-pcm :rate takes a rate in Hz above 0, not ${n}; the file's own rate is kept`,
          nodeSrc(bodyItems[ki + 1]) ?? src, null);
      else if (n !== null) sample[key.slice(1)] = n;
      else
        pushDiag(diagnostics, "warning", "W_SAMPLE_KEY_INVALID",
          `def-pcm ${key} takes a whole number, not ${rawVal ?? "a list"}; the default is kept`,
          nodeSrc(bodyItems[ki + 1]) ?? src, null);
    } else if (key === ":pcm-start") {
      sample.startTok = rawVal;
    } else if (key === ":pcm-end") {
      sample.endTok = rawVal;
      sample.lenTok = null; // the two spell one bound; the last one wins
    } else if (key === ":pcm-len") {
      sample.lenTok = rawVal;
      sample.endTok = null;
    } else if (key === ":loop-start") {
      sample.loopStartTok = rawVal;
    } else if (key === ":loop-end") {
      sample.loopEndTok = rawVal;
      sample.loopLenTok = null;
    } else if (key === ":loop-len") {
      sample.loopLenTok = rawVal;
      sample.loopEndTok = null;
    } else {
      // A key the def does not have would otherwise drop out silently.
      pushDiag(diagnostics, "error", "E_UNKNOWN_KEYWORD",
        `def-pcm has no key ${key}`, nodeSrc(bodyItems[ki]) ?? src, null);
    }
  }

  if (!sample.file && !base) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_FILE",
      "def-pcm needs :file, or a base sample to extend",
      src,
      null,
    );
  }

  // :offset / :frames slice one file into many samples (a bank). Frames, not
  // bytes — like :pcm-start/:pcm-end, which stay relative to the slice.
  if (sample.offset !== null && sample.offset < 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_SLICE",
      `def-pcm :offset must be >= 0 (got ${sample.offset})`,
      src,
      null,
    );
  }
  if (sample.frames !== null && sample.frames <= 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_SLICE",
      `def-pcm :frames must be > 0 (got ${sample.frames})`,
      src,
      null,
    );
  }

  return sample;
}

// Pull the single `:step` clock out of a macro's items (position-free). Returns
// the parsed step or null; pushes E_MACRO_STEP_DUP when more than one appears.
function extractMacroStep(items, diagnostics, trackName) {
  let step = null;
  let count = 0;
  for (let k = 0; k < items.length; k++) {
    if (atomValue(items[k]) !== ":step") continue;
    count++;
    if (count !== 1) continue;
    const tok = k + 1 < items.length ? atomValue(items[k + 1]) : null;
    step = parseStepToken(tok);
    // A :step that is not a length > 0 would leave the macro on its 1f
    // default without a word — a typo heard as the wrong rate.
    if (step === null && diagnostics)
      pushDiag(diagnostics, "warning", "W_MACRO_STEP_INVALID",
        `:step takes a length > 0 (16, 24t, 2f, 30ms), not ${tok ?? "nothing"}; ` +
          "the macro steps at the default 1f",
        nodeSrc(items[k + 1] ?? items[k]), trackName);
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

// A curve that is not an inline sweep has no current value to start from —
// a macro's table is baked per note, a delay's envelope and a PCM point
// are lengths laid out at compile time — so its :from must be written (§11).
function requireCurveFrom(spec, diagnostics, trackName, where, src = null) {
  if (spec && !spec.steps && !spec.stages && spec.from === undefined && diagnostics)
    pushDiag(diagnostics, "error", "E_CURVE_FROM",
      `a curve in ${where} needs its :from (only an inline sweep starts from the current value)`,
      src, trackName);
}

/**
 * Parse a (macro …) spec node for any target.
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
  ratio = false, // a `*` macro: its values are multipliers, kept unrounded
) {
  if (!node) return null;
  // Relative (+/*) macros carry signed offsets / ratios; leave them unclamped
  // here and clamp only after combining with the base (add/scaleMacroValues).
  const clampVal = (v) => (clamp ? clampForTarget(target, v) : v);
  // A velocity keeps eighths of a step, as the driver holds it (§6).
  const roundVal = (n) => (ratio ? n : target === "VEL" ? Math.round(n * VEL_FINE) / VEL_FINE : Math.round(n));
  // One macro value: a number (rounded where it binds, like every value) or
  // the target's own symbol (`white2`, `left`), in a vector and as a scalar.
  const tokenValue = (val) => {
    if (typeof val !== "string") return null;
    if (target === "NOISE_MODE" && val in NOISE_MODE_MAP) return NOISE_MODE_MAP[val];
    if (target === "PAN" && val in PAN_MAP) return PAN_MAP[val];
    if (target === "SSG_MIX" && val in TARGET_SYMBOLS.SSG_MIX) return TARGET_SYMBOLS.SSG_MIX[val];
    const n = parseNumberLike(val);
    return n === null ? null : roundVal(n);
  };
  // Step-vector or multi-stage form: [...]
  if (node.kind === "list" && node.bracket === "[]") {
    const items = node.items.filter((n) => n.kind !== "comment");

    // A `let` name stands for its value: a number is a step, a curve a stage.
    const boundOf = (it) =>
      it.kind === "atom" && env ? lookupBound(env, atomValue(it)) : undefined;
    const isStage = (it) =>
      (it.kind === "list" && it.bracket === "()") ||
      (boundOf(it) !== undefined && typeof boundOf(it) === "object");

    // One grammar (language.md §10): a vector holding any stage is a stage
    // list, and in it a number is a one-:step stage, `_` waits one step,
    // `#rel` is where the release starts ((wait key-off)) and `#sus` makes the
    // stage after it loop until key-off. A vector of values alone stays the
    // step vector below.
    if (items.some(isStage)) {
      const oneStep = step ?? { unit: "frame", value: 1 };
      const stepWait = () =>
        oneStep.unit === "tick" ? { waitTicks: oneStep.value } : { waitFrames: oneStep.value };
      const stepStage = (v) => ({
        curve: "linear",
        from: v,
        to: v,
        frames: oneStep.value,
        ...(oneStep.unit === "tick" ? {} : { lenFrames: true }),
        loop: false,
      });
      const bad = (it, msg) =>
        diagnostics && pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID", msg, nodeSrc(it), trackName);
      const stages = [];
      let sus = null; // the #sus waiting for its stage
      // The stage right after (wait key-off) may leave out its :from: the
      // release then starts from where the macro is at the key-off (the
      // driver reads its last value). It must be the whole release.
      let atRelease = false, fromNow = null;
      for (const it of items) {
        const val = atomValue(it);
        if (fromNow && val !== "_") bad(it, "a release without its :from starts where the level is and is the whole release; nothing may follow it");
        if (val === "#sus") { sus = it; continue; }
        if (val === "#rel") { stages.push({ waitKeyOff: true }); atRelease = true; continue; }
        if (val === "_") { stages.push(stepWait()); atRelease = false; continue; }
        if (it.kind === "list" && atomValue(it.items?.[0]) === "wait") {
          // (wait key-off) or (wait N) or (wait Nf), N a length as a curve's
          // :wait reads it — a let name or an expression too.
          const arg = curveParamToken(it.items?.[1], env, "length", "(wait …)", "a stage",
            false, diagnostics, nodeSrc(it), trackName);
          if (arg === undefined) {
            stages.push({ waitTicks: 1 });
          } else if (arg === "key-off") {
            stages.push({ waitKeyOff: true });
            atRelease = true;
            continue;
          } else if (isFrameToken(arg)) {
            // Nf / Nms is a wall-clock frame count; carry the unit so the
            // player's frame branch schedules it directly (a stage wait is a
            // local sampler delay, not a timeline advance — tempo-independent).
            stages.push({ waitFrames: parseLengthToken(arg, null) });
          } else {
            const t = parseLengthToken(arg, null);
            if (t === null && diagnostics)
              pushDiag(diagnostics, "warning", "W_WAIT_INVALID",
                `(wait …) takes a length or key-off, not ${arg ?? "nothing"}; it waits 1 tick`,
                nodeSrc(it), trackName);
            stages.push({ waitTicks: t ?? 1 });
          }
          continue;
        }
        let spec = null;
        if (isStage(it)) {
          // A curve — a literal, a let name or arithmetic on one — or an
          // expression that folds to a number (then one step).
          const r = evalMacroNode(it);
          if (r?.kind === "signal" && !r.spec.steps) spec = r.spec;
          else if (r?.kind === "scalar") spec = stepStage(clampVal(r.value));
          else if (r) bad(it, "a stage is a curve, a number or (wait …)");
        } else {
          const b = boundOf(it);
          const n = typeof b === "number" ? roundVal(b) : tokenValue(val);
          if (n !== null) spec = stepStage(clampVal(n));
          else bad(it, `${val ?? "(…)"} is not a value for this macro`);
        }
        if (!spec) { atRelease = false; continue; }
        if (atRelease && spec.from === undefined && !spec.steps && !spec.stages && !sus) {
          // fromNow: the driver's share steps — 128 of the way, 32768 on the
          // i16 :pitch (mmb.md §15) — which the preview follows.
          spec = { ...spec, fromNow: target === "NOTE_PITCH" ? 32768 : 128 };
          fromNow = it;
        } else requireCurveFrom(spec, diagnostics, trackName, "a macro");
        atRelease = false;
        if (sus) {
          spec = { ...spec, loop: true };
          sus = null;
        }
        stages.push(spec);
      }
      if (sus) bad(sus, "#sus needs a stage after it to loop");
      return { type: "stages", stages };
    }

    // Step-vector form: [15 #sus 14 13 #rel 11 9 7 5 3 0 _ ...]
    // For MODE target, also accept noise mode symbols (white0-3, periodic0-3).
    // For PAN target, also accept pan symbols (left, center, right).
    const steps = [];
    let loopIndex = null;
    let releaseIndex = null;
    for (const item of items) {
      const val = atomValue(item);
      if (val === "#sus") {
        loopIndex = steps.length;
        continue;
      }
      if (val === "#rel") {
        releaseIndex = steps.length;
        continue;
      }
      const b = boundOf(item);
      const n = typeof b === "number" ? roundVal(b) : tokenValue(val);
      if (n !== null) {
        steps.push(clampVal(n));
      } else if (val === "_") {
        steps.push(null); // hold: advance 1 frame, no write
      } else if (diagnostics) {
        // Skipping it would shift every later step: say so instead.
        pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID",
          `${val ?? "(…)"} is not a value for this macro`, nodeSrc(item), trackName);
      }
    }
    // src spans the whole `[...]` literal so the player can highlight the
    // sounding step sequence during playback.
    return { type: "steps", steps, loopIndex, releaseIndex, src: nodeSrc(node) };
  }
  // A curve, an expression or a `let` name (§7.2) evaluates to a signal or a
  // number. Scaled macro (§7.0): `(* <signal> $slot)` evaluates to
  // the signal carrying `scale`, the slot it rides as a per-frame depth knob —
  // the driver writes `(sample × slot) >> 8` each frame (exporter → MMB flags
  // bit2 + a slot byte). A macro reads no other `$`.
  const bound =
    node.kind === "atom" && env && lookupBound(env, atomValue(node)) !== undefined;
  if (bound || (node.kind === "list" && node.bracket === "()")) {
    const r = evalMacroNode(node);
    if (!r) return null;
    if (r.kind === "runtime") {
      pushDiag(diagnostics, "error", "E_EVAL_NOT_LOWERABLE",
        "a macro reads a $value only as a scaled macro (* signal $slot)", nodeSrc(node), trackName);
      return null;
    }
    return macroSpecOf(r);
  }
  // Scalar constant: e.g. `:keyon 1`. A constant signal equivalent to
  // `[#sus N]` (single value, looped). Mainly for :keyon (1 = fire every
  // :step, 0 = never).
  const scalar = tokenValue(atomValue(node));
  if (scalar !== null) {
    return {
      type: "steps",
      steps: [clampVal(scalar)],
      loopIndex: 0,
      releaseIndex: null,
    };
  }
  return null;

  function evalMacroNode(n) {
    return evalValue(n, env ?? makeEnv(null), {
      ...makeEvalCtx(diagnostics, trackName, nodeSrc(n), null, macroStepFramesForEval(step)),
      // A slot's name, in its FROM_VAL form; an unknown one degrades the
      // scaled macro to a plain one at export.
      macro: true,
      resolveSlot: (raw) => (raw === "$time" ? "$time" : raw.slice(1)),
    });
  }

  // An eval result as a macro spec. A materialized signal⊕signal result is a
  // float step vector; a symbolic (affine-folded) curve stays a curve; a number
  // is a constant, held.
  function macroSpecOf(r) {
    if (r.kind === "signal") requireCurveFrom(r.spec, diagnostics, trackName, "a macro");
    if (r.kind === "scalar")
      return { type: "steps", steps: [clampVal(r.value)], loopIndex: 0, releaseIndex: null };
    return r.spec.steps
      ? {
          type: "steps",
          steps: r.spec.steps,
          loopIndex: r.spec.loopIndex ?? null,
          releaseIndex: r.spec.releaseIndex ?? null,
          ...(r.spec.scale ? { scale: r.spec.scale } : {}),
        }
      : { type: "curve", ...r.spec };
  }
}

// A loop body that left the shuffle pairing flipped plays its next pass on
// the other beats — unless it holds a label, which a second copy would repeat.
function swingsOtherWay(trackState, parityIn, events, bodyIdx) {
  return (
    trackState.subBeatParity !== parityIn &&
    !events.slice(bodyIdx).some((e) => e.cmd === "MARKER")
  );
}

function dropLoopBreaks(events, from, to, id) {
  for (let k = to - 1; k >= from; k--)
    if (events[k].cmd === "LOOP_BREAK" && events[k].args?.id === id) events.splice(k, 1);
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

// The state tokens that take no time: `>` `<` `o±N` `v±N`. Applies one to the
// track state and returns true, or returns false for anything else. Shared by
// the note stream and the tuplet, where they sit between the notes without
// taking a share of the slot (§3).
function applyTimelessStateToken(val, trackState) {
  if (val === ">" || val === "<" || isOctShiftAtom(val)) {
    const delta = val === ">" ? 1 : val === "<" ? -1
      : (val[1] === "+" ? 1 : -1) * (val.length > 2 ? parseInt(val.slice(2), 10) : 1);
    trackState.defaultOct = Math.max(0, trackState.defaultOct + delta);
    return true;
  }
  if (isVelShiftAtom(val)) {
    const delta = (val[1] === "+" ? 1 : -1) * (val.length > 2 ? parseInt(val.slice(2), 10) : 1);
    trackState.defaultVel = Math.max(0, Math.min(15, trackState.defaultVel + delta));
    return true;
  }
  return false;
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

// How each curve param reads a number (curveParamToken); `:from` / `:to` are
// numbers, or lengths on a PCM point. The keys a bare `$slot` feeds (§8).
const CURVE_PARAM_KIND = {
  ":len": "length", ":hold": "length", ":wait": "length",
  ":phase": "int", ":duty": "int", ":skew": "int", ":octaves": "int", ":seed": "int",
  ":rate": "number", ":jitter": "number", ":beta": "number", ":lacunarity": "number",
  ":persistence": "number", ":leak": "number",
};
const CURVE_DYN_KEYS = new Set([":from", ":to", ":len", ":rate"]);

// A curve parameter's value (language.md §11) as the token its reader takes.
// An atom is itself — a literal, or a bare `$slot` the caller records as a
// dynamic source — unless it is a `let` name; a `let` name or an expression is
// evaluated at compile time and its number written back as the token the same
// bare number would be. `kind` is how the param reads a number: "int" and
// "length" round it (a length's number is a note denominator, §7.4, and a
// `(ticks …)` / `(frames …)` bridge becomes an `Nt` / `Nf` token); "number"
// keeps it. A `$` inside an expression is an error: the driver reads one slot
// as-is, so a curve param takes a bare `$slot` or a compile-time value.
// Returns the token (null when there is none), or undefined after a diagnostic.
function curveParamToken(node, env, kind, key, head, dynOk, diagnostics, src, trackName) {
  if (!node) return null;
  if (node.kind === "atom" && !(env && lookupBound(env, node.value) !== undefined))
    return node.value;
  if (node.kind === "atom" || (node.kind === "list" && node.bracket === "()")) {
    const err = (code, msg) => {
      if (diagnostics) pushDiag(diagnostics, "error", code, msg, src, trackName);
    };
    const runtime = () =>
      err("E_CURVE_PARAM_RUNTIME",
        `curve param ${key} on ${head} takes ${dynOk ? "one bare slot ($v) or " : ""}a compile-time value, ` +
        `not an expression with a $ — the driver reads ${dynOk ? "one slot as-is" : "no slot here"}`);
    if (exprHasValRef(node)) return runtime();
    const ctx = {
      ...makeEvalCtx(diagnostics ?? [], trackName, src),
      resolveSlot: (raw) => raw.slice(1), // a let name bound to a `$` expression
    };
    if (kind === "length") {
      const lv = evalLengthValue(node, env, ctx);
      if (lv) return lv.unit === "error" ? undefined : `${lv.value}${lv.unit === "frame" ? "f" : "t"}`;
    }
    const r = evalValue(node, env, ctx);
    if (!r) return undefined;
    if (r.kind === "runtime") return runtime();
    if (r.kind === "signal")
      return err("E_EVAL_TYPE", `curve param ${key} on ${head} takes a number, not a curve`);
    return String(kind === "number" ? r.value : Math.round(r.value));
  }
  return null;
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
  // How a value in `:from` / `:to` is read. The PCM range points pass a
  // length-token reader here, so `(linear :from 16 :to 64)` sweeps a 16th
  // note down to a 64th instead of the bare numbers 16 and 64.
  scalar = null,
  // The lexical `let` env, so a param can name a binding (§7.2).
  env = null,
) {
  const readScalar = scalar ?? parseNumberLike;
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
        "E_EVAL_UNKNOWN_HEAD",
        `unknown function '${head ?? ""}' (not a curve or an expression)`,
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
  let waitFrames = null;
  let waitKeyOff = false;
  let loopMode = null; // :mode loop / shot; null = the curve's own (§11)
  let holdLen = null; // :hold as written: { n, frames }
  const params = {};
  let hasParams = false;
  // Dynamic curve params: $name in :from/:to/:rate/:len records a runtime
  // slot source here (with a placeholder static value); the player resolves
  // it at note-on — a `:len` by the slot's def-val :unit.
  const dyn = {};
  let hasDyn = false;
  const dynSrc = (v) =>
    typeof v === "string" && v.startsWith("$") ? v.slice(1) : null;

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
  // A value that does not read is dropped, as before — but said, so a typo
  // in a curve param is not silent.
  const badParam = (key, v) => {
    if (diagnostics)
      pushDiag(diagnostics, "warning", "W_CURVE_PARAM_INVALID",
        `curve param ${key} on ${head} does not read as a number: ${v ?? "nothing"}; ignored`,
        src ?? nodeSrc(node), trackName);
  };
  const setParam = (key, value) => {
    params[key] = value;
    hasParams = true;
  };

  let rangeUsed = false; // positional `A..B` seen (conflicts with :from/:to)
  const items = node.items.filter((n) => n.kind !== "comment"); // not elements
  for (let j = 1; j < items.length; j++) {
    const k = atomValue(items[j]);
    // Positional range sugar: `(sin -1..1 :rate 6 :len 4)` sets from/to.
    const range = parseRangeToken(k);
    if (range && scalar) {
      if (diagnostics) {
        pushDiag(
          diagnostics,
          "error",
          "E_CURVE_RANGE_MALFORMED",
          `${k}: this curve's ends are lengths — write :from and :to`,
          src ?? nodeSrc(node),
          trackName,
        );
      }
      continue;
    }
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
    if (typeof k === "string" && k.includes("..")) {
      if (diagnostics) {
        pushDiag(
          diagnostics,
          "error",
          "E_CURVE_RANGE_MALFORMED",
          `malformed range '${k}' (expected A..B, two numbers; a name or an expression goes in :from / :to)`,
          src ?? nodeSrc(node),
          trackName,
        );
      }
      continue;
    }
    if (k === ":mode") {
      // `:mode loop` cycles any curve (forward) — an easing curve as a
      // cycling sustain stage; `:mode shot` plays a loop wave once.
      const m = atomValue(items[j + 1]);
      if (m === "loop" || m === "shot") loopMode = m === "loop";
      else if (diagnostics)
        pushDiag(diagnostics, "error", "E_CURVE_MODE",
          `curve :mode takes loop or shot, not ${m ?? "nothing"}`,
          src ?? nodeSrc(node), trackName);
      j++;
      continue;
    }
    if (k && k.startsWith(":") && j + 1 >= items.length) {
      // Every curve param takes a value; a trailing keyword has none.
      if (diagnostics)
        pushDiag(diagnostics, "error", "E_CURVE_PARAM_UNKNOWN",
          `curve param ${k} on ${head} has no value`, src ?? nodeSrc(node), trackName);
      continue;
    }
    if (k && k.startsWith(":") && j + 1 < items.length) {
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
      const v = curveParamToken(
        items[j + 1], env, CURVE_PARAM_KIND[k] ?? (scalar ? "length" : "number"), k, head,
        CURVE_DYN_KEYS.has(k), diagnostics, src ?? nodeSrc(node), trackName);
      if (v === undefined) {
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
          } else {
            from = readScalar(v);
            if (from === null) badParam(k, v);
          }
          break;
        }
        case ":to": {
          const s = dynSrc(v);
          if (s) {
            to = 0;
            dyn.to = s;
            hasDyn = true;
          } else {
            to = readScalar(v);
            if (to === null) badParam(k, v);
          }
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
            lenFrames = isFrameToken(v); // Nf / Nms is an absolute frame count, not ticks
            if (frames === null) badParam(k, v);
          }
          break;
        }
        case ":wait":
          if (v === "key-off") {
            waitKeyOff = true;
          } else if (isFrameToken(v)) {
            // Nf / Nms is a wall-clock frame count, as a stage `(wait Nf)` is.
            waitFrames = parseLengthToken(v, null);
          } else {
            const t = parseLengthToken(v, null);
            if (t !== null) waitTicks = t;
            else if (diagnostics)
              pushDiag(diagnostics, "warning", "W_WAIT_INVALID",
                `:wait takes a length or key-off, not ${v ?? "nothing"}; the curve does not wait`,
                src ?? nodeSrc(node), trackName);
          }
          break;
        case ":phase": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("phase", clampWithWarning(n, 0, 255, ":phase"));
          if (n === null) badParam(k, v);
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
          if (n === null) badParam(k, v);
          break;
        }
        case ":duty": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("duty", clampWithWarning(n, 1, 255, ":duty"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":skew": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("skew", clampWithWarning(n, -127, 127, ":skew"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":hold": {
          // A length (§4): `Nf` / `Nms` frames, else ticks. Becomes a share
          // of :len (resolveCurveHold) once both are known in one unit.
          const isFrames = isFrameToken(v);
          const n = parseLengthToken(v, null);
          if (n > 0) holdLen = { n, frames: isFrames };
          else if (diagnostics)
            pushDiag(diagnostics, "error", "E_CURVE_HOLD",
              `:hold takes a length (8, 16., 3f, 40ms): got ${v}`, src ?? nodeSrc(node), trackName);
          break;
        }
        case ":jitter": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam("jitter", clampWithWarning(n, 0, 1, ":jitter"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":beta": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "beta",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":beta"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":octaves": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("octaves", clampWithWarning(n, 1, 8, ":octaves"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":lacunarity": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "lacunarity",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":lacunarity"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":persistence": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "persistence",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":persistence"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":leak": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam("leak", clampWithWarning(n, 0, 0.9999, ":leak"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":seed": {
          // u32 seed for stochastic LUT regeneration (compile-time; default
          // 0xDEAD keeps seedless sources byte-identical). Independent
          // statistical sequence, unlike :phase (a shift of the same table).
          const n = parseIntLike(v);
          if (n !== null) setParam("seed", n >>> 0);
          if (n === null) badParam(k, v);
          break;
        }
      }
      j++;
      continue;
    }
    // Every other element of a curve form reads as nothing: the ends are a
    // range or :from/:to, and every option is written as `:key value`, so a
    // bare token here is a param written without its keyword — the seed of
    // `(noise -12..12 3)` would never apply. Say so rather than drop it.
    if (diagnostics)
      pushDiag(diagnostics, "error", "E_CURVE_STRAY_VALUE",
        `curve ${head}: ${k ?? "a value"} is not a param — the ends are A..B (or :from / :to), and every option is written :key value, e.g. ${STOCHASTIC_CURVES.has(head) ? ":seed 3" : ":len 4"}`,
        src ?? nodeSrc(node), trackName);
  }

  const spec = {
    curve: head,
    to: to ?? 0,
    loop: loopMode ?? LOOP_CURVE_NAMES.has(head),
  };
  if (from !== null && from !== undefined) spec.from = from;
  if (frames !== null && frames !== undefined) spec.frames = frames;
  if (lenFrames) spec.lenFrames = true;
  if (waitTicks !== null) spec.waitTicks = waitTicks;
  if (waitFrames !== null) spec.waitFrames = waitFrames;
  if (waitKeyOff) spec.waitKeyOff = true;
  if (hasParams) spec.params = params;
  if (hasDyn) spec.dyn = dyn;
  if (holdLen) {
    // The hold is a share of :len, so it needs a literal one (§11).
    if (!(spec.frames > 0) || dyn.len) {
      if (diagnostics)
        pushDiag(diagnostics, "error", "E_CURVE_HOLD",
          dyn.len ? ":hold needs a literal :len, not a $slot" : ":hold needs a :len",
          src ?? nodeSrc(node), trackName);
    } else {
      spec.holdLen = holdLen;
      resolveCurveHold(spec, null);
    }
  }
  return spec;
}

// A stochastic curve's `:hold` (a length) as a share of its `:len`: the phase
// grid sampleCurveUnit holds the curve on, so the hold is a time, whatever
// :len and :rate are. In one unit it needs no tempo; frames against ticks wait
// for the macro's note, whose tempo resolveMacroLen knows.
function resolveCurveHold(spec, bpm) {
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

function parseNumberLike(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Resolve a length in a structural position: a plain length-token atom, a
// `(ticks expr)` / `(frames expr)` unit bridge (§7.4), or a bare eval
// expression whose numeric result is a note denominator — `(+ 2 2)` ≡ `4` ≡ a
// quarter note, uniform with a literal number. Frames convert to ticks at the
// active tempo, as an Nf length does (§4).
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

// Positional curve-range sugar: `A..B` → { from: A, to: B }. Endpoints
// are signed decimals; `40..0` is a valid descending range. Returns null for
// anything that is not exactly a range token.
const RANGE_RE = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
function parseRangeToken(value) {
  if (typeof value !== "string") return null;
  const m = RANGE_RE.exec(value);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

// Inverse of pitchToMidi for `(note <midi>)` (§7.3): MIDI → { note name, octave }
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
          : st?.fromNow // a release from where the level is: its end alone
            ? { ...st, to: fn(st.to ?? 0) }
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

// A def name is written bare in a channel body, so it must not read as a
// note-stream token there (`e`, `c+8`, `v+2`, `>`): the same rule as a `let`
// name (E_DEF_NAME). A def-val ($name) and a def-se (started by number) are
// never written bare.
function rejectNoteName(defHead, name, node, diagnostics) {
  if (!isNoteStreamToken(name)) return false;
  pushDiag(diagnostics, "error", "E_DEF_NAME",
    `${defHead} name '${name}' reads as a note or length token in a channel body; pick a word`,
    nodeSrc(node), null);
  return true;
}

// The compile's `noise` draw streams, one per seed (mmlisp-eval drawNoise):
// a score always draws the same, from the top.
let drawStreams = new Map();
function makeEvalCtx(diagnostics, trackName, src, typedDefs = null, stepFrames = 1) {
  return {
    pushDiag,
    diagnostics,
    drawStreams,
    trackName,
    src,
    curveNames: CURVE_NAMES,
    parseCurve: (n, env) => parseCurveSpec(n, diagnostics, nodeSrc(n), trackName, false, null, env),
    foldSignal: foldCurveValues,
    isNoteStreamToken,
    // A voice or a sample (the samples ride on the voice map, set once the
    // defs are merged); snippet names are caught at expansion (expandNode).
    isDefName: (n) => !!typedDefs && (typedDefs.has(n) || !!typedDefs.sampleNames?.has(n)),
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
  env = null,
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
  const curveSpec = parseCurveSpec(valueNode, diagnostics, src, trackName, true, null, env);
  if (!curveSpec) return null;

  const from = parseNumberLike(String(curveSpec.from ?? ""));
  const to = parseNumberLike(String(curveSpec.to ?? ""));
  const fromBpm = from ?? fallbackFromBpm;
  const toBpm = to;
  // TEMPO_SWEEP's `len` is ticks, which the player and the exporter turn into
  // frames at the sweep's average tempo — so an `Nf` / `Nms` length converts
  // to ticks at that same tempo, and keeps its frame count.
  const len =
    Number.isFinite(Number(curveSpec.frames)) && Number(curveSpec.frames) > 0
      ? curveSpec.lenFrames && fromBpm > 0 && toBpm > 0
        ? framesToTicks(Number(curveSpec.frames), (fromBpm + toBpm) / 2)
        : Number(curveSpec.frames)
      : null;
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
  return midiToHz(pitchToMidi(pitch));
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

// A `:keyword` the language already means something by — a target, a PCM
// point, or one of the body keywords handled by name — or the `$time` source.
const BODY_KEYWORDS = new Set(["oct", "len", "gate", "tempo", "shuffle", "shuffle-base",
  "csm-rate", "mode", "vel", "time", "prio", "pcm-voices", "step"]);
function isLanguageKeyword(name) {
  const t = canonicalTarget(":" + name);
  return BODY_KEYWORDS.has(name) || SUPPORTED_TARGETS.has(t) || INLINE_TARGETS.has(t) ||
    PCM_POINT_TARGETS.has(t);
}

// Keyword → IR target name (canonicalTarget).
const TARGET_KEYWORDS = new Map(Object.entries({
  // Sequencer / level
  ":vol": "VOL",
  ":master": "MASTER",
  ":pitch": "NOTE_PITCH",
  ":semi": "NOTE_SEMI",
  ":snap": "SNAP",
  ":keyon": "KEYON",
  // LFO
  ":lfo-rate": "LFO_RATE",
  ":lfo-freq": "LFO_FREQ",
  ":lfo-pmd": "LFO_PMD",
  ":lfo-amd": "LFO_AMD",
  ":lfo-wave": "LFO_WAVE",
  ":noise-rate": "NOISE_RATE",
  ":env": "SSG_ENV",
  ":env-rate": "ENV_RATE",
  ":env-semi": "ENV_SEMI",
  ":env-detune": "ENV_DETUNE",
  // PCM points: the range a note plays, and the loop inside it
  ":pcm-start": "RANGE_START",
  ":pcm-end": "RANGE_END",
  ":pcm-len": "RANGE_LEN",
  ":loop-start": "LOOP_START",
  ":loop-end": "LOOP_END",
  ":loop-len": "LOOP_LEN",
  ":pan": "PAN",
  ":mode": "NOISE_MODE",
  // The FM family's: the channel's, and each operator's (:tl1–:tl4 …) that
  // some part has — the OPLL's own words on its two operators only.
  ...Object.fromEntries([...FM_CHANNEL_WORDS, ...opWords()].filter((w) => partsWithWord(w.word).length).map((w) => [w.kw, w.word])),
}));

// The keyword a canonical target is written as (FM_SSG1 → :ssg1).
const KEYWORD_OF = new Map([...TARGET_KEYWORDS].map(([kw, t]) => [t, kw]));
function keywordOf(target) {
  return KEYWORD_OF.get(target) ?? `:${target.toLowerCase().replace(/_/g, "-")}`;
}

/**
 * A macro's curve as the steps it plays (the vector editor's view of it,
 * edit-tools.js vectorAt): `node` a curve form, `step` its macro's :step token
 * (1f when unwritten), `bpm` the tempo its lengths are read at. One value per
 * step, unrounded — a loop curve's one cycle — or null when the curve is not
 * one the steps stand for (no :from, a $value, a :wait, no length). `from`
 * stands in for a :from the curve leaves out.
 */
export function macroCurveSteps(node, { step = null, bpm = 120, from = null } = {}) {
  // Read alone, a param that names a def or a let (`:to top`) has no value:
  // any word the curve could not read means its steps are not these.
  const said = [];
  const spec = parseCurveSpec(node, said);
  // A release stage may leave :from out: it starts where the macro is
  // (`from`, the stage before it's last value).
  if (spec && spec.from == null && from != null) spec.from = from;
  if (!spec || said.length || spec.from == null || spec.dyn || spec.waitTicks != null || spec.waitFrames != null || spec.waitKeyOff)
    return null;
  const clock = (step != null ? parseStepToken(step) : null) ?? { unit: "frame", value: 1 };
  const lens = resolveMacroLen({ type: "curve", ...spec, step: clock }, bpm);
  const base = lens.frames;
  if (!(base > 0) || !(clock.value > 0)) return null;
  const at = (phase) => spec.from + (spec.to - spec.from) * sampleCurveUnit(spec.curve, phase, spec.params);
  if (![spec.from, spec.to].every(Number.isFinite)) return null;
  if (spec.loop) {
    const period = Math.max(1, Math.round(base / clock.value));
    return { values: Array.from({ length: period }, (_, i) => at((i * clock.value) / base)), loop: true };
  }
  const n = Math.max(1, Math.ceil(base / clock.value));
  return { values: Array.from({ length: n }, (_, i) => at(base <= 1 ? 1 : Math.min(1, (i * clock.value) / (base - 1)))), loop: false };
}

export function canonicalTarget(symbol) {
  const known = TARGET_KEYWORDS.get(symbol);
  if (known) return known;
  // The spelled-out fallback must not make `:range-start` a key.
  const t = symbol.replace(/^:/, "").toUpperCase().replace(/-/g, "_");
  return PCM_POINT_TARGETS.has(t) ? null : t;
}

// `init-fm`, the empty voice: a sine on the machine's FM part (chips/fm-words.js fmInitVoice).
function createInitFmKwMap(target) {
  return fmInitVoice(target.parts.find((p) => p.kind === "fm"));
}

// A def-fm voice switch: its registers as of `tick`, and the key shift its
// :key sets on the track. The track's part takes what it has of the voice
// (emitVoiceFromKwMap): a voice named on a channel with no FM (sqr1, pcm1)
// keeps only its :key there, and says so once per track and voice.
function emitVoice(td, tick, events, src, trackState = null, name = null, diagnostics = null, trackName = null) {
  if (td.kwMap) {
    const dropped = emitVoiceFromKwMap(td.kwMap, tick, events, src, trackState?.part, trackState?.target);
    const said = trackState ? (trackState.voicesSaid ??= new Set()) : null;
    if (dropped && said && diagnostics && !said.has(name)) {
      said.add(name);
      const { part, head } = trackState;
      pushDiag(diagnostics, "warning", "W_TARGET",
        `'${name}' is an FM voice; ${head} (${part.label}) ${part.kind === "fm" ? `plays it without ${dropped}` : "has no FM, so only its :key applies"}`,
        src, trackName);
    }
  }
  if (trackState) {
    const key = td.kwMap?.get(VOICE_KEY);
    trackState.voiceKeyShift = key === undefined ? 0 : key - 60;
  }
}

// A def-wave's `:wave`: a vector of its steps, or a wave expression
// (waveExpr) — a curve, another def-wave, and `+ - * /` over them and numbers.
// A written step out of range is an error; what an expression computes is
// rounded and kept in range, as a register write keeps it. Every wave that
// reads is listed, in def order, as the IR's metadata.waves; `index` maps its
// name to its place, and a track's anonymous wave (a `:wave` expression with
// no $slot) is added to it as the track compiles (waveIndexOf).
const WAVE_LEN = WAVE.len;
function resolveWaves(typedDefs, defs, paramDefs, diagnostics) {
  const read = new Map(); // name → steps, null when its def does not read
  const reading = new Set();
  const dataOf = (name, at) => {
    const td = typedDefs.get(name);
    if (td?.tag !== "wave") {
      pushDiag(diagnostics, "error", "E_WAVE_VALUE", `${name} is not a def-wave`, nodeSrc(at), null);
      return null;
    }
    if (td.data) return td.data; // an import's, read in its own compile
    if (read.has(name)) return read.get(name);
    if (reading.has(name)) {
      pushDiag(diagnostics, "error", "E_WAVE_VALUE", `def-wave ${name} is made of itself`, td.src, null);
      return null;
    }
    reading.add(name);
    const data = readWaveDef(td);
    reading.delete(name);
    read.set(name, data);
    if (data) td.data = data;
    return data;
  };
  const readWaveDef = (td) => {
    const err = (msg, src = td.src) => pushDiag(diagnostics, "error", "E_WAVE_VALUE", msg, src, null);
    const ctx = makeEvalCtx(diagnostics, null, td.src, typedDefs);
    let data = null;
    for (let k = 0; k < td.items.length; k += 2) {
      const kw = atomValue(td.items[k]);
      if (kw !== ":wave") {
        pushDiag(diagnostics, "error", "E_WAVE_PARAM", `def-wave has no key ${kw ?? "(…)"}; its one key is :wave`,
          nodeSrc(td.items[k]) ?? td.src, null);
        continue;
      }
      const at = td.items[k + 1];
      if (!at) { err(":wave has no value", nodeSrc(td.items[k])); continue; }
      const expanded = (n) => {
        const ex = expandNode(n, defs, paramDefs, 0, diagnostics);
        return ex.length === 1 ? ex[0] : null;
      };
      if (at.kind === "list" && at.bracket === "[]") {
        const items = at.items.filter((n) => n.kind !== "comment");
        const vals = items.map((n) => {
          const e = expanded(n);
          const v = e && !exprHasValRef(e) ? evalValue(e, makeEnv(null), ctx) : null;
          if (v?.kind !== "scalar") err(`a :wave value is a number, not ${atomValue(n) ?? "a list"}`, nodeSrc(n));
          return v?.kind === "scalar" ? Math.round(v.value) : 0;
        });
        if (vals.length !== WAVE_LEN) { err(`:wave takes ${WAVE_LEN} values, not ${vals.length}`, nodeSrc(at)); continue; }
        const out = vals.find((x) => x < WAVE.min || x > WAVE.max);
        if (out !== undefined) { err(`a :wave value is ${WAVE.min}..${WAVE.max}, not ${out}`, nodeSrc(at)); continue; }
        data = vals;
        continue;
      }
      const e = expanded(at);
      const r = e && waveExpr(e, { waveOf: dataOf, diagnostics, trackName: null });
      if (!r) continue;
      if (r.data) data = waveSteps(r.data);
      else err(r.tree ? "a def-wave is fixed data: a $value goes in a track's :wave" : `:wave takes a wave, not the number ${r.n}`, nodeSrc(at));
    }
    if (!data && !td.items.some((n) => atomValue(n) === ":wave")) err("def-wave needs :wave");
    return data;
  };
  const waves = [];
  const index = new Map();
  for (const [name, td] of typedDefs) {
    if (td.tag !== "wave") continue;
    const data = dataOf(name, null);
    if (data) index.set(name, waves.push({ name, data }) - 1);
  }
  waves.index = index;
  waves.dataOf = dataOf;
  return waves;
}

// A wave expression (language.md §19) as the compiler reads it: a def-wave's
// name, a curve (one cycle), a number, a `$slot` (`runtime`: a track's
// `:wave`), and `+ - * /` over them. What has no $slot is folded here (the
// shared ir-utils.js waveCombine); the rest is left as the tree the IR player
// runs. Returns { n } | { data } | { tree }, or null after a diagnostic.
const WAVE_OPS = new Set(["+", "-", "*", "/"]);
function waveExpr(node, { waveOf, vals = null, runtime = false, diagnostics, trackName }) {
  const err = (msg) => {
    pushDiag(diagnostics, "error", "E_WAVE_VALUE", msg, nodeSrc(node), trackName);
    return null;
  };
  if (node?.kind === "atom") {
    const v = node.value;
    const n = parseNumberLike(v);
    if (n !== null) return { n };
    if (typeof v === "string" && v.startsWith("$")) {
      if (!runtime) return err(`a def-wave is fixed data: ${v} goes in a track's :wave`);
      if (!vals?.has(v.slice(1))) return err(`${v} is not a def-val`);
      return { tree: { val: v.slice(1) } };
    }
    const data = waveOf(v, node);
    return data ? { data } : null;
  }
  const head = node?.kind === "list" && node.bracket === "()" ? atomValue(node.items[0]) : null;
  if (CURVE_NAMES.has(head)) {
    const spec = parseCurveSpec(node, diagnostics, nodeSrc(node), trackName);
    return spec ? { data: waveCycle(spec) } : null;
  }
  if (WAVE_OPS.has(head)) {
    const args = node.items.slice(1).filter((n) => n.kind !== "comment")
      .map((n) => waveExpr(n, { waveOf, vals, runtime, diagnostics, trackName }));
    if (!args.length) return err(`(${head}) has nothing to work on`);
    if (args.some((a) => !a)) return null;
    if (args.some((a) => a.tree)) {
      const leaf = (a) => a.tree ?? (a.data ? { data: a.data.map((x) => Math.round(x * 1000) / 1000) } : { n: a.n });
      return { tree: { op: head, args: args.map(leaf) } };
    }
    const r = waveCombine(head, args.map((a) => a.data ?? a.n));
    return Array.isArray(r) ? { data: r } : { n: r };
  }
  return err("a wave is def-wave names, curves and numbers under + - * /");
}

// A track's anonymous wave (a folded `:wave` expression): listed with the
// def-waves under `name`, its place in metadata.waves — the same place on
// the compile's second pass.
function waveIndexOf(waves, name, data) {
  const at = waves.index.get(name);
  if (at != null) { waves[at].data = data; return at; }
  waves.index.set(name, waves.push({ name, data }) - 1);
  return waves.length - 1;
}

// One cycle of a curve, whatever its :len, as a def-wave's steps (unrounded).
function waveCycle({ from = 0, to = 0, curve, params }) {
  return Array.from({ length: WAVE_LEN }, (_, i) => from + (to - from) * sampleCurveUnit(curve, i / WAVE_LEN, params));
}

/**
 * A def-wave's curve as its steps, rounded, for the vector editor
 * (edit-tools.js): null when the curve is not read alone (a param naming a
 * def or a let) or leaves the range.
 */
export function waveCurveSteps(node) {
  const said = [];
  const spec = parseCurveSpec(node, said);
  if (!spec || said.length || ![spec.from ?? 0, spec.to].every(Number.isFinite)) return null;
  const vals = waveCycle(spec).map((x) => Math.round(x));
  return vals.every((x) => x >= WAVE.min && x <= WAVE.max) ? vals : null;
}

// A def-wave named on a track: the channel plays it from here, on a part
// with wave memory; anywhere else it is nothing, said once per track and
// wave.
function emitWave(trackState, events, src, name, diagnostics, trackName) {
  const index = trackState.waves?.index.get(name);
  if (index == null) return; // its def did not read
  const { part, head } = trackState;
  if (part?.words("WAVE")) {
    events.push({ tick: trackState.tick, cmd: "PARAM_SET", args: { target: "WAVE", value: index }, src });
    return;
  }
  const said = (trackState.voicesSaid ??= new Set());
  if (said.has(name)) return;
  said.add(name);
  pushDiag(diagnostics, "warning", "W_TARGET",
    `'${name}' is a wave; ${head} (${part?.label ?? "this channel"}) has no wave memory, so it is left out`, src, trackName);
}

// The canonical targets a voice sets: the channel's ALG/FB/AMS/FMS and every
// operator param — the registers VOICE_TABLE carries (mmb.md §11).
// The four velocity sensitivities come last, outside VOICE_TABLE: the driver
// takes them as PARAM_SETs after the voice (mmb.md §11).
const VOICE_KEYS = [
  ...FM_CHANNEL_WORDS.filter((w) => !w.track).map((w) => w.word),
  ...opWords(FM_OP_WORDS.filter((w) => !w.inline)).map((w) => w.word),
  ...VEL_SENS_TARGETS,
];
const VOICE_KEY_SET = new Set(VOICE_KEYS);

// `:key N` is not a register: the compiler moves the voice's notes by N − 60
// (emitNoteForTrack), so the IR and the driver never see it.
const VOICE_KEY = "KEY";

// `(voice base :param value …)`: flatten each voice into one register map, the
// base's first and the voice's own writes over it. A value is anything that
// evaluates to a number — a literal, a snippet constant, an expression. Runs
// once every def is known, so a base may come from an import.
function resolveVoices(typedDefs, defs, paramDefs, diagnostics, velSens = false, machine = null) {
  const resolve = (name, seen) => {
    const td = typedDefs.get(name);
    if (td.kwMap || td.failed) return td.kwMap ?? null;
    const err = (code, msg, src = td.src) => {
      pushDiag(diagnostics, "error", code, msg, src, null);
    };
    let base = new Map();
    if (td.extends) {
      const b = typedDefs.get(td.extends);
      if (b?.tag !== "voice") {
        err("E_VOICE_EXTENDS", `'${td.extends}' is not a voice`);
        td.failed = true;
        return null;
      }
      if (seen.has(td.extends)) {
        err("E_VOICE_EXTENDS", `voice '${name}' extends itself`);
        td.failed = true;
        return null;
      }
      base = resolve(td.extends, new Set([...seen, name]));
      if (!base) {
        td.failed = true;
        return null;
      }
    }
    const kwMap = new Map(base);
    const ctx = makeEvalCtx(diagnostics, null, td.src, typedDefs);
    for (let k = 0; k < td.items.length; k += 2) {
      const kw = atomValue(td.items[k]);
      const target = kw === ":key" ? VOICE_KEY
        : kw?.startsWith(":") ? canonicalTarget(kw) : null;
      if (target !== VOICE_KEY && !VOICE_KEY_SET.has(target)) {
        err("E_VOICE_PARAM",
          `${kw ?? "(…)"} is not an FM voice parameter (:alg :fb :ams :fms, :ar1 … :am4, :ws1 :eg1 :ksl1 :vib1 …, :vel1 … :vel4, :key)`,
          nodeSrc(td.items[k]));
        continue;
      }
      if (k + 1 >= td.items.length) {
        err("E_VOICE_VALUE", `${kw} has no value`, nodeSrc(td.items[k]));
        continue;
      }
      // A snippet constant (`(def lvl 40)`) expands to its one node first.
      const expanded = expandNode(td.items[k + 1], defs, paramDefs, 0, diagnostics);
      const v = expanded.length === 1 && !exprHasValRef(expanded[0])
        ? evalValue(expanded[0], makeEnv(null), ctx)
        : null;
      if (v?.kind === "scalar" && target === VOICE_KEY &&
          (Math.round(v.value) < 0 || Math.round(v.value) > 127))
        err("E_VOICE_VALUE", `:key takes a MIDI note 0..127, got ${Math.round(v.value)}`,
          nodeSrc(td.items[k + 1]));
      else if (v?.kind === "scalar" && VEL_SENS_TARGETS.has(target)) {
        const k16 = velSensSixteenths(v.value);
        if (k16 === null)
          err("E_VOICE_VALUE", `${kw} takes a ratio 0..1 of the velocity, got ${v.value}`,
            nodeSrc(td.items[k + 1]));
        else kwMap.set(target, k16);
      } else if (v?.kind === "scalar") {
        kwMap.set(target, Math.round(v.value));
        // A register this machine lacks: the voice plays without it here
        // (emitVoiceFromKwMap) and keeps it for the machines that have one.
        // Said only where it would have sounded — `:ssg1 0` is no difference.
        const lacks = machine && Math.round(v.value) !== 0 && targetLacks(target, kw, machine);
        if (lacks) pushDiag(diagnostics, "warning", "W_TARGET", `${lacks} — '${name}' plays without it`, nodeSrc(td.items[k]), null);
      }
      else if (v || expanded.length !== 1 || exprHasValRef(expanded[0]))
        err("E_VOICE_VALUE", `${kw} takes a number — a voice is fixed data`,
          nodeSrc(td.items[k + 1]));
    }
    td.kwMap = kwMap;
    return kwMap;
  };
  for (const [name, td] of typedDefs) if (td.tag === "voice") resolve(name, new Set());
  // A score that writes a sensitivity anywhere has every voice state all four,
  // the unset ones as the role's own.
  if (velSens) {
    for (const td of typedDefs.values()) {
      if (td.tag !== "voice" || !td.kwMap) continue;
      for (const t of VEL_SENS_TARGETS) if (!td.kwMap.has(t)) td.kwMap.set(t, VEL_SENS_AUTO);
    }
  }
}

// A voice is the OPN/OPM family's patch on every channel that takes FM:
// what the track's `part` has no register for (SSG-EG on the OPM, DT2 on the
// OPN, all of it on a PSG) is left out, and on a part with DT2 a voice
// without one states it 0, so a voice change resets it. Returns the first
// word left out that the voice set to something and `machine` has — a
// word the machine lacks was said at the def (resolveVoices) — or null.
// With no part every key is written.
function emitVoiceFromKwMap(kwMap, tick, events, src, part = null, machine = null) {
  let dropped = null;
  for (const target of VOICE_KEYS) {
    let value = kwMap.get(target);
    if (part && !part.words(target)) {
      if (value !== undefined && value !== 0 && value !== VEL_SENS_AUTO && machine?.hasWord(target))
        dropped ??= keywordOf(target);
      continue;
    }
    if (value === undefined && part && /^FM_DT2_\d$/.test(target)) value = 0;
    if (value !== undefined)
      events.push({ tick, cmd: "PARAM_SET", args: { target, value }, src });
  }
  return dropped;
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
function markFile(node, file) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) markFile(n, file); return; }
  if (node.line != null) node.file = file;
  if (node.items) markFile(node.items, file);
}

function nodeSrc(node) {
  const src = { line: node.line, column: node.column };
  if (node.file) src.file = node.file;
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

/**
 * The channel body compiler.
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
  // Lexical env for compile-time eval: each `let` (§7.2) extends it for the
  // body it wraps.
  const evalEnv = env ?? makeEnv(null);
  const labelsHere = new Map(); // #label id -> its index in these items
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
          labelsHere.set(id, i);
          (trackState.labelParity ??= new Map()).set(id, trackState.subBeatParity);
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
        // A keyword that exists, on a channel that has no such thing.
        const wrongChannel = (kw, channels) =>
          pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET",
            `${kw} is only for ${channels}, not ${String(trackName).split(":")[0]}`,
            nodeSrc(node), trackName);
        if (i < items.length) {
          const rawVal = atomValue(items[i]);
          switch (val) {
            case ":oct":
            case ":oct+": {
              // absolute / +add against the running octave base
              const { op } = opSuffix(val);
              const raw = compileTimeScalar(
                items[i], rawVal, op, evalEnv, val, diagnostics, trackName, nodeSrc(node), typedDefs,
              );
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultOct;
                trackState.defaultOct = Math.max(0, Math.round(op === "+" ? cur + raw : raw));
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
              let g;
              if (items[i]?.kind === "list" && val === ":gate-") {
                // a length expression: `(ticks 12)`, `(* 2 8)` (§7.4)
                const t = resolveLengthNode(items[i], 0, trackState,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs), evalEnv);
                g = t > 0 ? { type: "cut", value: t } : null;
              } else if (items[i]?.kind === "list") {
                const f = readConstNumber(items[i], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
                if (f === undefined) break;
                g = f !== null && f >= 0 && f <= 1 ? { type: "ratio", value: f } : null;
              } else g = parseGateFamily(val, rawVal, trackState.currentTempo);
              if (g !== null) trackState.defaultGate = g;
              else gateInvalid(diagnostics, val, rawVal ?? "an expression out of range", nodeSrc(node), trackName);
              break;
            }
            case ":shuffle":
            case ":shuffle-base": {
              // Swing (§5.2): `none` or under 51 is straight. A change restarts
              // the pair count, so the next swung note is a first beat.
              if (val === ":shuffle") {
                const n = rawVal === "none" ? 0 : readConstNumber(items[i], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
                if (n === undefined) break;
                const v = n === null ? null : Math.round(n);
                if (v === null) {
                  pushDiag(diagnostics, "error", "E_SHUFFLE_INVALID",
                    `:shuffle takes 51..90 or none, not ${rawVal ?? "a list"}`,
                    nodeSrc(node), trackName);
                  break;
                }
                // 1–50 and over 90 are outside the swing's range: they play
                // straight / as 90, as before, but a typo should not pass.
                if (v !== 0 && v < 51)
                  pushDiag(diagnostics, "warning", "W_SHUFFLE_STRAIGHT",
                    `:shuffle ${v} is under 51 and plays straight; swing is 51..90 (none or 0 = straight)`,
                    nodeSrc(items[i]), trackName);
                else if (v > 90)
                  pushDiag(diagnostics, "warning", "W_SHUFFLE_CLAMPED",
                    `:shuffle ${v} is over 90 and plays as 90`, nodeSrc(items[i]), trackName);
                trackState.shuffleRatio = v < 51 ? 0 : Math.min(90, v);
              } else {
                trackState.shuffleBase = resolveLengthNode(
                  items[i],
                  trackState.shuffleBase,
                  trackState,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                  evalEnv,
                );
              }
              trackState.subBeatParity = 0;
              break;
            }
            case ":vel":
            case ":vel+":
            case ":vel*": {
              // per-note velocity (KEY-ON scoped, sticky): absolute / +add /
              // *multiply against the running vel base (default 15).
              const { op } = opSuffix(val);
              const raw = compileTimeScalar(
                items[i], rawVal, op, evalEnv, val, diagnostics, trackName, nodeSrc(node), typedDefs, true,
              );
              warnEnvLevel(trackState, val, diagnostics, nodeSrc(node), trackName);
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultVel ?? 15;
                const next =
                  op === "+" ? cur + raw : op === "*" ? cur * raw : raw;
                // On the driver's grid: eighths of a step (language.md §6).
                trackState.defaultVel = Math.max(0, Math.min(15, Math.round(next * VEL_FINE) / VEL_FINE));
              }
              break;
            }
            case ":csm-rate": {
              if (!trackState.isCsmTrack) {
                wrongChannel(val, "fm3-csm");
                break;
              }
              const valueNode = items[i];
              // A number, or an expression (§7.1: `(hz a3)`, `(* 2 110)`) —
              // a curve head is the swept form below.
              const isExpr = valueNode?.kind === "list" && valueNode.bracket === "()" &&
                !CURVE_NAMES.has(atomValue(valueNode.items?.[0]));
              const hz = isExpr
                ? evalScalarValue(valueNode, evalEnv, makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs))
                : parseNumberLike(rawVal);
              if (isExpr && hz === null) break; // diagnostic already pushed
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
                  null,
                  evalEnv,
                );
                if (!curveSpec) break;

                const from = parseNumberLike(String(curveSpec.from ?? ""));
                const to = parseNumberLike(String(curveSpec.to ?? ""));
                // CSM_RATE's `len` is ticks: an `Nf` / `Nms` length converts at
                // the tempo in force.
                const len =
                  Number.isFinite(Number(curveSpec.frames)) &&
                  Number(curveSpec.frames) > 0
                    ? curveSpec.lenFrames
                      ? framesToTicks(Number(curveSpec.frames), trackState.currentTempo)
                      : Number(curveSpec.frames)
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
                    "invalid :csm-rate curve; expected (<curve> :from N :to M :len L)",
                    nodeSrc(node),
                    trackName,
                  );
                }
              }
              break;
            }
            case ":tempo": {
              const valueNode = items[i];
              // A number is TEMPO_SET; a curve is a TEMPO_SWEEP below.
              const v = readValue(valueNode, evalEnv,
                valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs));
              if (!v) break;
              if (v.kind !== "scalar" && v.kind !== "signal") {
                pushDiag(diagnostics, "error", "E_TEMPO_INVALID",
                  ":tempo takes a BPM number or a curve", nodeSrc(node), trackName);
                break;
              }
              const bpm = v.kind === "scalar" ? v.value : null;
              if (bpm !== null && !(bpm > 0)) {
                pushDiag(diagnostics, "error", "E_TEMPO_INVALID",
                  `:tempo must be above 0 BPM, not ${bpm}`, nodeSrc(node), trackName);
                break;
              }
              if (bpm !== null && bpm > 0) {
                // At tick 0 the song's tempo is the last track's leading one
                // (last writer wins, §5): convert this track's lengths at the
                // tempo that plays, not at the one it wrote.
                trackState.currentTempo =
                  trackState.tick === 0 && trackState.initialBpm != null ? trackState.initialBpm : bpm;
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
                evalEnv,
              );
              if (swept) {
                trackState.currentTempo = swept.toBpm;
                events.push(swept.event);
              }
              break;
            }
            case ":wave": {
              // A wave expression (language.md §19): folded, an anonymous wave
              // the track names as it would a def-wave; with a $slot, the tree
              // the IR player runs as the slot moves. A bare name is the
              // def-wave itself, as written alone in the body.
              const { part, target: machine } = trackState;
              if (!part?.words("WAVE")) {
                wrongChannel(val, machine.headsOfKind("wave").join(", ") || "a wave channel");
                break;
              }
              const valueNode = items[i];
              if (valueNode?.kind === "atom" && trackState.waves?.index.has(valueNode.value)) {
                emitWave(trackState, events, nodeSrc(node), valueNode.value, diagnostics, trackName);
                break;
              }
              const r = waveExpr(valueNode, {
                waveOf: (name, at) => trackState.waves?.dataOf(name, at) ?? null,
                vals, runtime: true, diagnostics, trackName,
              });
              if (!r) break;
              if (r.n != null) {
                pushDiag(diagnostics, "error", "E_WAVE_VALUE", `:wave takes a wave, not the number ${r.n}`, nodeSrc(valueNode), trackName);
                break;
              }
              const args = r.tree
                ? { target: "WAVE", expr: r.tree }
                : { target: "WAVE", value: waveIndexOf(trackState.waves, `${trackState.head}@${valueNode.line}:${valueNode.column}`, waveSteps(r.data)) };
              events.push({ tick: trackState.tick, cmd: "PARAM_SET", args, src: nodeSrc(node) });
              break;
            }
            case ":mode": {
              // The part's symbols (chips/parts.js), else the target's reading
              // of another machine's (targets/), else the part's error.
              // A channel may have its own (the OPM's fm8: its noise).
              const { part, target: machine } = trackState;
              const own = machine.channels?.[trackState.head];
              const modes = own?.modes ?? part.modes;
              const modeError = own?.modes ? own.modeError : part.modeError;
              const reading = machine.readsAs?.modes?.[part.name]?.[rawVal];
              if (part.kind === "sample") {
                if (isPcmModeSymbol(rawVal)) trackState.pcmMode = rawVal;
                else
                  pushDiag(diagnostics, "error", "E_PCM_MODE_INVALID",
                    "pcm :mode must be shot, loop or gate", nodeSrc(node), trackName);
              } else if (modes && Object.hasOwn(modes, rawVal)) {
                const [target, value] = modes[rawVal];
                events.push({ tick: trackState.tick, cmd: "PARAM_SET",
                  args: { target, value }, src: nodeSrc(node) });
              } else if (reading?.write) {
                targetDiag(diagnostics, "warning",
                  `${trackState.head} :mode ${rawVal} is not a mode the ${machine.system} has; it reads as ${reading.as}`,
                  nodeSrc(node), trackName);
                const [target, value] = reading.write;
                events.push({ tick: trackState.tick, cmd: "PARAM_SET",
                  args: { target, value }, src: nodeSrc(node) });
              } else if (reading) {
                targetDiag(diagnostics, "error",
                  `${trackState.head} :mode ${rawVal} has no ${machine.name} sound: ${reading.none}`,
                  nodeSrc(node), trackName);
              } else if (modeError) {
                pushDiag(diagnostics, "error", modeError.code, modeError.message,
                  nodeSrc(node), trackName);
              } else {
                wrongChannel(val, machine.channelNames.filter((h) =>
                  machine.partOf(h).kind === "sample" || Object.keys(machine.channels[h].modes ?? machine.partOf(h).modes ?? {}).length).join(", "));
              }
              break;
            }
            default: {
              // Inline hardware param write: :tl1 30, :tl1+ 5, :tl1 $x, ...
              // Absolute literal → PARAM_SET; curve → PARAM_SWEEP; +/* operator
              // or $value → runtime PARAM_ADD/PARAM_MUL/PARAM_FROM_VAL.
              const { stem, op } = opSuffix(val);
              // A def-val's own name writes its slot: score-global, like
              // :tempo, whichever track carries it (§8).
              const valDef = vals?.get(stem.slice(1));
              const target = valDef ? `VAL${valDef.slot}` : canonicalTarget(stem);
              if (!valDef && !SUPPORTED_TARGETS.has(target) && !INLINE_TARGETS.has(target) &&
                  !PCM_POINT_TARGETS.has(target)) {
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
              if (
                PCM_PITCH_TARGETS.has(target) &&
                pcmRejectsPitch(
                  trackState,
                  val,
                  diagnostics,
                  nodeSrc(node),
                  trackName,
                  target,
                )
              )
                break;
              const lacks = !valDef && targetLacks(target, val, trackState.target);
              if (lacks) {
                targetDiag(diagnostics, "error", lacks, nodeSrc(node), trackName);
                break;
              }
              const chLacks = !valDef && trackLacks(target, val, trackState);
              if (chLacks) {
                pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET", chLacks, nodeSrc(node), trackName);
                break;
              }
              if (!valDef && !PARAM_SET_TARGETS.has(target)) {
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
              if (target === "SNAP") {
                writeSnap(val, op, items[i], evalEnv, vals, push, diagnostics, nodeSrc(node),
                  trackName, typedDefs);
                break;
              }
              if (VEL_SENS_TARGETS.has(target)) {
                writeVelSens(target, val, op, items[i], evalEnv, vals, push, diagnostics,
                  nodeSrc(node), trackName, typedDefs);
                break;
              }
              if (!op && rawVal === "none" && TARGET_SYMBOLS[target]?.none === undefined) {
                // Stop a running inline PARAM_SWEEP, freezing the value.
                push("PARAM_SWEEP_STOP", { target });
                break;
              }
              if (PCM_POINT_TARGETS.has(target)) {
                writePcmPoint(target, val, op, items[i], trackState, push,
                  diagnostics, nodeSrc(node), trackName, evalEnv);
                break;
              }
              const writtenFrom = events.length;
              writeParam(target, op, val, readValue(items[i], evalEnv, valueCtx(target, vals, diagnostics, trackName, nodeSrc(node), typedDefs)), push,
                evalEnv, vals, diagnostics, trackName, nodeSrc(node));
              if (target === "NOTE_PITCH")
                noteUserPitchWrites(trackState, events.slice(writtenFrom));
              if (target === "SSG_ENV")
                trackState.ssgEnv = (events.at(-1)?.args?.value ?? -1) >= 0;
              if (target === "VOL") warnEnvLevel(trackState, val, diagnostics, nodeSrc(node), trackName);
              break;
            }
          }
          i++;
        }
        continue;
      }

      // Octave and velocity shifts: > < o± v±
      if (applyTimelessStateToken(val, trackState)) {
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
        // A rest on the rate source rests the CSM buzz (language.md §15): Timer
        // A stops, CSM stays on, and the next rate (or, with an inline
        // :csm-rate, the next fm3-csm note) starts it again.
        if (
          !trackState.csmStopped &&
          (trackState.isCsmRateTrack ? trackState.glideRamp : trackState.isCsmTrack && trackState.hasInlineCsmRate)
        ) {
          events.push({ tick: trackState.tick, cmd: "CSM_RATE", args: { run: false }, src: nodeSrc(node) });
          trackState.csmStopped = true;
        }
        events.push({
          tick: trackState.tick,
          cmd: "REST",
          args: { length: ticks },
          src: nodeSrc(node),
        });
        trackState.tick += ticks;
        trackState.tiedHead = null; // a rest ends the tied group
        trackState.pcmTiedHead = null;
        i++;
        continue;
      }

      // Per-note length atom: c4, e8., f+12t, b-6f, a1/2
      if (isPerNoteLengthAtom(val)) {
        const { noteName, lengthStr } = parsePerNoteLength(val);
        // Swing goes by the nominal length, written or default (§5.2).
        const perNoteTicks = resolveShuffleTicks(
          parseLengthToken(lengthStr, trackState.defaultLength, trackState.currentTempo),
          trackState,
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

      // Bare identifier: a sample binds on a pcm track, as a voice does on FM
      if (trackState.isPcmTrack && trackState.sampleDefs?.has(val)) {
        trackState.pcmSampleName = val;
        i++;
        continue;
      }

      // Bare identifier: a def-wave (the wave the channel plays from here)
      if (typedDefs?.get(val)?.tag === "wave") {
        emitWave(trackState, events, nodeSrc(node), val, diagnostics, trackName);
        i++;
        continue;
      }

      // Bare identifier: a def-fm voice (a voice switch)
      if (typedDefs?.has(val)) {
        emitVoice(typedDefs.get(val), trackState.tick, events, nodeSrc(node), trackState, val, diagnostics, trackName);
        trackState.voiceName = val; // what a def-mod :voice matches

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

      // Tuplet: (t elem …) divides one current :len slot among its notes and
      // rests using Bresenham distribution (remainders spread evenly). The
      // timeless state tokens (> < o± v±) sit between them and take no share.
      if (head === "t") {
        const elems = node.items
          .slice(1)
          .filter((ev) => ev?.kind !== "comment");
        const takesSlot = (ev) => {
          const v = atomValue(ev);
          return v === "_" || isPerNoteLengthAtom(v) || isNoteAtom(v);
        };
        const n = elems.filter(takesSlot).length;
        if (n === 0) {
          pushDiag(
            diagnostics,
            "error",
            "E_TUPLET_EMPTY",
            "(t …) needs at least one note or rest",
            nodeSrc(node),
            trackName,
          );
          i++;
          continue;
        }
        const totalTicks = trackState.defaultLength;
        let acc = 0;
        for (const ev of elems) {
          const evVal = atomValue(ev);
          if (applyTimelessStateToken(evVal, trackState)) continue;
          if (!takesSlot(ev)) {
            pushUnknownDiag(
              diagnostics,
              "E_UNKNOWN_TUPLET_ELEM",
              "Unknown tuplet element",
              ev,
              trackName,
            );
            continue;
          }
          acc += totalTicks;
          const slotTicks = Math.floor(acc / n);
          acc -= slotTicks * n;
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
          } else {
            emitNoteForTrack(
              trackState,
              evVal,
              slotTicks,
              events,
              diagnostics,
              nodeSrc(ev),
              trackName,
            );
          }
        }
        i++;
        continue;
      }

      // Repeat loop: (x N ...) counts N times; (x ...) loops forever
      // (break) inside the body emits LOOP_BREAK linked to this loop's id
      if (head === "x") {
        const countNode = node.items[1];
        const countValue = isConstNumberNode(countNode, evalEnv)
          ? readConstNumber(countNode, evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs)
          : null;
        const maybeCount = countValue == null ? (countValue === undefined ? 1 : null) : Math.round(countValue);
        const bodyStart = maybeCount !== null ? 2 : 1;
        // "(x N)" has a space and parens, so no `#name` can spell it (§13).
        const loopId = `(x ${loopCounter.count++})`;
        const savedLoopId = trackState.currentLoopId;
        // Only counted loops support (break); inside an infinite (x …) it still
        // binds to the innermost COUNTED loop around it (§13).
        trackState.currentLoopId = maybeCount !== null ? loopId : savedLoopId;
        const loopSrc = nodeSrc(node.items[0]);
        const compileBody = () =>
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
        if (maybeCount !== null) {
          const parityIn = trackState.subBeatParity;
          events.push({ tick: trackState.tick, cmd: "LOOP_BEGIN", args: { id: loopId }, src: loopSrc });
          const bodyIdx = events.length;
          compileBody();
          // The loop whose pass is the last one: what follows goes on from it.
          let lastId = loopId;
          let lastCount = maybeCount;
          let lastIn = parityIn;
          if (maybeCount > 1 && swingsOtherWay(trackState, parityIn, events, bodyIdx)) {
            // An odd count of swung notes swings the next pass the other way,
            // and the IR holds one body: write the loop two passes to a turn
            // (the second compiled again on the flipped pairing), and an odd
            // count's last pass after it as a loop of one. The (break) is kept
            // only where the loop's last pass meets it.
            const diagLen = diagnostics.length;
            const firstEnd = events.length;
            compileBody();
            const odd = maybeCount % 2 === 1;
            dropLoopBreaks(events, bodyIdx, odd ? events.length : firstEnd, loopId);
            if (odd) {
              trackState.loopBreaks?.delete(loopId);
              trackState.loopBreakParity?.delete(loopId);
            }
            connectAcrossJump(trackState, events, bodyIdx);
            events.push({
              tick: trackState.tick,
              cmd: "LOOP_END",
              args: { id: loopId, repeat: Math.floor(maybeCount / 2) },
              src: loopSrc,
            });
            lastCount = Math.floor(maybeCount / 2);
            if (odd) {
              lastId = `(x ${loopCounter.count++})`;
              trackState.currentLoopId = lastId;
              lastIn = trackState.subBeatParity;
              lastCount = 1;
              events.push({ tick: trackState.tick, cmd: "LOOP_BEGIN", args: { id: lastId }, src: loopSrc });
              compileBody();
              events.push({ tick: trackState.tick, cmd: "LOOP_END", args: { id: lastId, repeat: 1 }, src: loopSrc });
            }
            diagnostics.length = diagLen; // the copies repeat the first pass's
          } else {
            // A `~` ending the body also connects it to the body's head on the
            // passes that loop back.
            connectAcrossJump(trackState, events, bodyIdx);
            events.push({
              tick: trackState.tick,
              cmd: "LOOP_END",
              args: { id: loopId, repeat: maybeCount },
              src: loopSrc,
            });
          }
          trackState.currentLoopId = savedLoopId;
          // With a (break) the last pass never reaches the tail: the loop is
          // left from the break, so the next note connects to what was sounding
          // there (a ~ / glide / tie from the tail would reach a note the
          // player never came from).
          const brk = trackState.loopBreaks?.get(lastId);
          if (brk) {
            restoreConnectionState(trackState, brk);
            trackState.loopBreaks.delete(lastId);
          }
          // The shuffle pairing goes on from where the last pass leaves — from
          // its (break), when it has one.
          const flips = lastIn ^ trackState.subBeatParity;
          const parityOut = trackState.loopBreakParity?.get(lastId);
          trackState.subBeatParity =
            parityOut != null
              ? parityOut ^ (flips & (lastCount - 1))
              : lastIn ^ (flips & lastCount);
          trackState.loopBreakParity?.delete(lastId);
        } else {
          const parityIn = trackState.subBeatParity;
          events.push({ tick: trackState.tick, cmd: "MARKER", args: { id: loopId }, src: loopSrc });
          const bodyIdx = events.length;
          compileBody();
          // Swinging the other way on the next pass: loop two passes at a time.
          if (swingsOtherWay(trackState, parityIn, events, bodyIdx)) {
            const diagLen = diagnostics.length;
            compileBody();
            diagnostics.length = diagLen;
          }
          trackState.currentLoopId = savedLoopId;
          events.push({ tick: trackState.tick, cmd: "JUMP", args: { to: loopId }, src: loopSrc });
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
          const r = readConstNumber(node.items[2], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
          repeat = r == null || !Number.isInteger(r) ? null : r;
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
        // A section that swings the other way on its next pass: an endless
        // one written in these items loops two passes at a time, as (x …)
        // does; any other cannot be copied here, so it is flagged.
        const target0 = events.findIndex((e) => e.cmd === "MARKER" && e.args?.id === label);
        const labelParity = trackState.labelParity?.get(label);
        if (labelParity != null && labelParity !== trackState.subBeatParity) {
          const at = labelsHere.get(label);
          if (repeat === null && at != null && target0 >= 0 &&
              swingsOtherWay(trackState, labelParity, events, target0 + 1)) {
            const diagLen = diagnostics.length;
            compileChannelBody(items.slice(at + 1, i), trackState, events, diagnostics,
              trackName, typedDefs, loopCounter, vals, evalEnv);
            diagnostics.length = diagLen;
          } else {
            pushDiag(diagnostics, "warning", "W_SHUFFLE_LOOP",
              `the #${label} section holds an odd count of swung notes, so its next pass swings the other way, but it plays as written — write it in (x …), or even the count`,
              nodeSrc(node.items[0]), trackName);
          }
        }
        // A `~` before the jump connects to the label's first note.
        const target = events.findIndex(
          (e) => e.cmd === "MARKER" && e.args?.id === label,
        );
        if (target >= 0) connectAcrossJump(trackState, events, target + 1);
        events.push({
          tick: trackState.tick,
          cmd: "JUMP",
          args: repeat !== null ? { to: label, repeat } : { to: label },
          src: nodeSrc(node.items[0]),
        });
        i++;
        continue;
      }

      // Loop break: (break) — on the final pass of the innermost counted loop,
      // exit here. Id is the current (x …) loop, or null inside a
      // `#label …(go label N)` loop where convertCountedJumps assigns it after
      // the forms merge.
      if (head === "break") {
        if (node.items.length !== 1) {
          pushDiag(
            diagnostics,
            "error",
            "E_BREAK_ARITY",
            "break takes no arguments: (break)",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        // The last pass leaves the loop HERE, so what follows the loop is
        // connected to this point, not to the body's tail (see (x N …)).
        if (trackState.currentLoopId) {
          (trackState.loopBreaks ??= new Map()).set(
            trackState.currentLoopId,
            connectionState(trackState),
          );
          (trackState.loopBreakParity ??= new Map()).set(
            trackState.currentLoopId,
            trackState.subBeatParity,
          );
        }
        events.push({
          tick: trackState.tick,
          cmd: "LOOP_BREAK",
          args: { id: trackState.currentLoopId ?? null },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Trigger: (trig N) — a music→game sync point. Emits TRIG with an
      // explicit id N (0..63); the driver writes it into the track's
      // 68k-readable status byte (opcodes.md §0x42) for the game to read.
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
        const t = readConstNumber(node.items[1], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
        const code = t == null || !Number.isInteger(t) ? null : t;
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
          cmd: "TRIG",
          args: { code },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Echo: (echo [N] :vel+|:vel* V [:back B]) — replays the note B back
      // (B=1 = the last) as taps that lengthen the phrase. mucom `\=n1,n2` ≡
      // (echo 1 :vel+ -n2 :back n1).
      // Delay: (delay [N] :vel+|:vel* V :time T) — sticky; every following
      // note gets taps overlaid at +k·T (expandTrackDelays); (delay none) and
      // (delay :vel none) clear it. Both read V the same way (readTapArgs).
      if (head === "echo" || head === "delay") {
        const items = node.items.filter((n) => n.kind !== "comment");
        const isDelay = head === "delay";
        if (isDelay && (atomValue(items[1]) === "none" ||
          (/^:vel[+*]?$/.test(atomValue(items[1]) ?? "") && atomValue(items[2]) === "none"))) {
          trackState.delaySpec = null;
          trackState.delayTicks = 0;
          i++;
          continue;
        }
        const tap = readTapArgs(head, items, evalEnv,
          makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs), diagnostics, trackName, nodeSrc(node));
        if (tap && isDelay) {
          const time = tap.opts[":time"], timeNode = tap.optNodes[":time"];
          // a length token, or a length expression — `(ticks 48)`, `(* 2 8)` (§7.4)
          const ticks = timeNode?.kind === "list"
            ? resolveLengthNode(timeNode, 0, trackState, makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs), evalEnv)
            : time == null ? null : parseLengthToken(time, null, trackState.currentTempo);
          if (ticks > 0) {
            trackState.delaySpec = tap.spec;
            trackState.delayTicks = ticks;
          } else {
            pushDiag(diagnostics, "error", "E_DELAY_ARGS",
              "(delay …) needs :time T, the spacing of its taps", nodeSrc(items[0]), trackName);
          }
        } else if (tap) {
          const back = Math.max(1, parseIntLike(tap.opts[":back"]) ?? 1);
          // Echo replays a note already written; before the first one it has
          // nothing to play — likely meant as (delay …), which is sticky.
          if (!trackState.recentNotes?.length)
            pushDiag(diagnostics, "warning", "W_ECHO_NO_NOTE",
              "(echo …) replays a note written before it, and there is none yet; " +
                "for an echo on every following note, write (delay … :time T)",
              nodeSrc(items[0]), trackName);
          emitEchoReplay(trackState, events, tap.spec, back, nodeSrc(node));
        }
        i++;
        continue;
      }

      // Glide: (glide <time>) portamento from the previous note;
      // (glide <from-pitch> <time>) sets an explicit start pitch; (glide none) off.
      if (head === "glide") {
        if (
          pcmRejectsPitch(
            trackState,
            "(glide …)",
            diagnostics,
            nodeSrc(node),
            trackName,
          )
        ) {
          i++;
          continue;
        }
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
        else
          pushDiag(diagnostics, "warning", "W_GLIDE_INVALID",
            `(glide …) takes a length or none, not ${tv ?? "nothing"}; the glide is unchanged`,
            nodeSrc(items[has2 ? 2 : 1] ?? node), trackName);
        i++;
        continue;
      }

      // Macro: (macro :target spec [:target spec …] [:step clk]) inline envelope;
      // (macro none) clears all, (macro :vel none) clears one; bare def names and
      // def references may be mixed in. Runtime within-note envelope.
      if (head === "macro") {
        // A named macro is a snippet, so `(macro pluck :pan …)` arrives as a
        // `(macro …)` nested in this one: it applies first, with its own
        // :step, as it would written on its own.
        const applyMacroForm = (form) => {
        const rest = form.items.slice(1).filter((n) => n.kind !== "comment");
        if (rest.length === 1 && atomValue(rest[0]) === "none") {
          trackState.activeMacros = {};
          return;
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
                let { target, op } = macroKeyword(groupSym);
                // A `:mode` macro on a part whose modes are its mixer's (the
                // SSG's) steps the mixer.
                if (target === "NOISE_MODE" && trackState.part?.modes?.tone?.[0] === "SSG_MIX") target = "SSG_MIX";
                else if (target === "SSG_MIX") target = null; // reached by :mode alone
                // A keyword that names no target is a typo, as it is inline
                // (E_UNKNOWN_KEYWORD) — never a macro that silently drops.
                if (!MACRO_TARGETS.has(target)) {
                  pushDiag(diagnostics, "error", "E_MACRO_TARGET",
                    `${groupSym} is not a macro target (language.md §10 lists them)`,
                    nodeSrc(rest[j]), trackName);
                  continue;
                }
                // A macro runs from a note's key-on; the song's own values
                // are not a note's. A looping sweep moves them over time.
                if (SONG_TARGETS.has(target) && !trackState.part?.songMacros?.(target)) {
                  pushDiag(diagnostics, "error", "E_MACRO_TARGET",
                    `${groupSym} is the song's, not a note's, so it takes no macro — sweep it instead (${groupSym} (sin …))`,
                    nodeSrc(rest[j]), trackName);
                  continue;
                }
                const lacks = targetLacks(target, groupSym, trackState.target);
                if (lacks) {
                  targetDiag(diagnostics, "error", lacks, nodeSrc(rest[j]), trackName);
                  continue;
                }
                const chLacks = trackLacks(target, groupSym, trackState);
                if (chLacks) {
                  pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET", chLacks, nodeSrc(rest[j]), trackName);
                  continue;
                }
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
                  op === "*",
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
                  applyMacroEntryToState(trackState, target, spec, {
                    diagnostics,
                    src: nodeSrc(node),
                    trackName,
                    keyword: groupSym,
                  });
                }
              }
              j += 2;
            } else j++;
          } else if (rest[j].kind === "list" && atomValue(rest[j].items?.[0]) === "macro") {
            applyMacroForm(rest[j]);
            j++;
          } else {
            pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID",
              `${sym ?? "(…)"} is not a :target, a target group or a named macro`,
              nodeSrc(rest[j]), trackName);
            j++;
          }
        }
        };
        applyMacroForm(node);
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
          const lacks = targetLacks(target, atomValue(targetNode), trackState.target);
          const chLacks = lacks ? null : trackLacks(target, atomValue(targetNode), trackState);
          if (lacks) {
            targetDiag(diagnostics, "error", lacks, nodeSrc(targetNode), trackName);
          } else if (chLacks) {
            pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET", chLacks, nodeSrc(targetNode), trackName);
          } else if (!PARAM_SET_TARGETS.has(target)) {
            pushDiag(
              diagnostics,
              "error",
              "E_UNSUPPORTED_TARGET",
              `Unsupported param-set target: ${target}`,
              nodeSrc(targetNode),
              trackName,
            );
          } else if (VEL_SENS_TARGETS.has(target)) {
            writeVelSens(target, atomValue(targetNode), null, valueNode, evalEnv, vals,
              (cmd, args) => events.push({ tick: trackState.tick, cmd, args, src: nodeSrc(targetNode) }),
              diagnostics, nodeSrc(targetNode), trackName, typedDefs);
          } else if (PCM_POINT_TARGETS.has(target)) {
            // The same length reading and pcm-track check as the inline write.
            writePcmPoint(target, atomValue(targetNode), null, valueNode, trackState,
              (cmd, args) => events.push({ tick: trackState.tick, cmd, args, src: nodeSrc(targetNode) }),
              diagnostics, nodeSrc(targetNode), trackName, evalEnv);
          } else {
            events.push({
              tick: trackState.tick,
              cmd: "PARAM_SET",
              args: { target, value },
              src: nodeSrc(targetNode),
            });
          }
          j += 2;
        }
        i++;
        continue;
      }

      // Item-position `let` (§7): bind, then compile the body in the extended
      // env, spliced in place so sticky state behaves as if unwrapped.
      if (head === "let") {
        // A binding may carry a `$` (a runtime value, lowered where it is
        // written); with no parameter here, `$<param>` is not a self-read.
        const childEnv = evalLet(
          node,
          evalEnv,
          valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs),
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

      // Item-position `for` (§7.5): the body compiled once a pass, in place,
      // each pass in its own env — as if every pass were written out.
      if (head === "for") {
        const envs = evalFor(
          node,
          evalEnv,
          valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs),
        );
        for (const passEnv of envs ?? []) {
          compileChannelBody(
            node.items.slice(2).filter((n) => n.kind !== "comment"),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            passEnv,
          );
        }
        i++;
        continue;
      }

      // Item-position `if` (§7.6): the chosen branch compiled in place, as if
      // it alone were written; no else and a false test write nothing.
      if (head === "if") {
        const branch = evalIf(
          node,
          evalEnv,
          valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs),
        );
        if (branch?.length) {
          compileChannelBody(
            branch,
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            evalEnv,
          );
        }
        i++;
        continue;
      }

      // `(note expr [len])` (§7.3): a computed absolute-pitch NOTE_ON.
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
// emits, so the loader's `_expandLoops` (nesting, count, (break)) handles both.
// Runs on a track's merged events, so the label and the `go` may come from
// different `(fmN …)` forms (mucom multi-line loops). Count-less JUMPs (infinite
// `(go label)` / `#loop`) are left untouched for the track-level loop.
function convertCountedJumps(track) {
  const events = track.events;
  if (!events) return;
  // Left-to-right so an inner counted loop is converted before its outer one;
  // that claims inner (break) (LOOP_BREAK id:null) for the inner loop first.
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
      // only rewrites *backward* counted jumps into LOOP_BEGIN/LOOP_END, and a
      // forward one has no meaning. Drop it, so every JUMP in the IR is plain.
      track.events.splice(track.events.indexOf(j), 1);
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
  // (def-se name [:prio N] [:tempo T] (channel body…)…) — a sound effect: its
  // parts are tracks the host starts by the effect's number, not the song.
  const seDefs = new Map();
  const vals = new Map(); // (def-val name init) runtime value slots
  // (def-score :title "…" :composer "…" :author "…" :pcm-voices N) — the score's settings.
  const fileMeta = { title: null, composer: null, author: null, pcmVoices: null, target: null };
  const imports = []; // (import "path") — [{path, src}]
  const mods = []; // (def-mod …) forms, read once the defs are known (parseModDef)
  const remaining = [];

  for (const root of roots) {
    if (root.kind !== "list" || root.items.length < 2) {
      remaining.push(root);
      continue;
    }
    const head = atomValue(root.items[0]);

    // (import "path") — compile-time merge of another file's defs (§9.2).
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
      const at = root.items.findIndex((n) => atomValue(n) === ":fx");
      // `:over`: this import's defs replace same-named ones from the imports
      // written before it (mergeImportsStrict) instead of conflicting.
      const over = root.items.slice(2).some((n) => atomValue(n) === ":over");
      imports.push({ path: pathNode.value, src: nodeSrc(root), fxNode: at > 1 ? root.items[at + 1] : null, over });
      continue;
    }

    // (def-val name init A..B) — declare a runtime value slot (§8). init is
    // the default; A..B (or :from/:to) are the ends of
    // the live control (the Dynamic Parameters sliders), not a bound on the
    // slot. Slots are indexed in declaration order.
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
      // `:name` writes the slot (§8), so a name the language already spells
      // as a keyword — or the built-in `$time` — would be two things at once.
      if (isLanguageKeyword(name)) {
        pushDiag(diagnostics, "error", "E_DEFVAL_NAME",
          `def-val ${name}: :${name} is already a keyword, so the value could not be written`,
          nodeSrc(root), null);
        continue;
      }
      // Optional positional init (item[2]); absent when options start there
      // (e.g. `(def-val x :from 0 :to -127)`), then init defaults to `from`.
      const initValue = readConstNumber(root.items[2], null, diagnostics, "global", nodeSrc(root));
      if (initValue === undefined) continue;
      const initPos = initValue === null ? null : initValue;
      const initRaw = atomValue(root.items[2]) ?? (initPos === null ? null : String(initPos));
      if ((initPos !== null && !Number.isInteger(initPos)) ||
        (initPos === null && initRaw != null && !initRaw.startsWith(":") && !parseRangeToken(initRaw))) {
        pushDiag(diagnostics, "error", "E_DEFVAL_INIT",
          `def-val ${name}: init must be an integer, not ${initRaw}`, nodeSrc(root), null);
        continue;
      }
      let from;
      let to;
      let step = 1; // slider granularity (control resolution)
      let unit = "frame"; // time unit when this slot feeds :len/:step
      let isPublic = false; // :public — a slider and the host's to write
      let k = initPos === null ? 2 : 3;
      // Positional range sugar: `(def-val amp 24 0..127)` ≡ `:from 0 :to 127`.
      const range = parseRangeToken(atomValue(root.items[k]));
      if (range) {
        from = range.from;
        to = range.to;
        k += 1;
      }
      for (; k < root.items.length; k += 2) {
        const key = atomValue(root.items[k]);
        if (key === ":public") {
          isPublic = true;
          k -= 1; // a flag: no value follows
          continue;
        }
        const raw = atomValue(root.items[k + 1]);
        const bad = (why) => pushDiag(diagnostics, "error", "E_DEFVAL_OPTION",
          `def-val ${name}: ${key} ${raw ?? ""} — ${why}`, nodeSrc(root), null);
        if (key === ":unit") {
          if (raw === "frame" || raw === "tick") unit = raw;
          else bad("must be frame or tick");
          continue;
        }
        if (!new Set([":from", ":to", ":step"]).has(key)) { bad("unknown option"); continue; }
        const v = readConstNumber(root.items[k + 1], null, diagnostics, "global", nodeSrc(root));
        if (v === undefined) continue;
        if (v === null || !Number.isInteger(v)) { bad("must be an integer"); continue; }
        if (key === ":from") from = v;
        else if (key === ":to") to = v;
        else if (key === ":step") { if (v > 0) step = v; else bad("must be > 0"); }
      }
      // `:from`/`:to` are order-free directional endpoints (from = the start,
      // so a slider runs from → to).
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
        min = 0;
        max = 127;
      }
      // `:from`/`:to` bound the live slider, not the slot, so `init` is kept
      // as written (§8). An init outside the slider's travel is a score bug —
      // said here, where it was authored, instead of folded in silently at
      // playback. A slot is an i16 on the driver; an init that cannot fit one
      // has no playable meaning.
      const init = initPos ?? from ?? min;
      if (init < -32768 || init > 32767) {
        pushDiag(diagnostics, "error", "E_DEFVAL_INIT",
          `def-val ${name}: init ${init} does not fit a 16-bit value slot`,
          nodeSrc(root), null);
        continue;
      }
      if (init < min || init > max)
        pushDiag(diagnostics, "warning", "W_DEFVAL_INIT_RANGE",
          `def-val ${name}: init ${init} is outside the slider range ${min}..${max}`,
          nodeSrc(root), null);
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
          public: isPublic,
        });
      continue;
    }

    if (head === "def-mod") {
      mods.push(root);
      continue;
    }

    if (head === "def-score") {
      parseScoreDef(root, fileMeta, diagnostics);
      continue;
    }

    if (head === "def-se") {
      const se = parseSeDef(root, diagnostics);
      if (se) seDefs.set(se.name, se);
      continue;
    }

    // (def-fm name [base] :alg 4 …) / (def-pcm name [base] :file "…" …)
    // — named data, like def-val. A leading name after the def's own is the
    // voice / sample it extends. Voices resolve in resolveVoices, samples in
    // resolveSampleExtends, once every def (imports included) is known.
    if (head === "def-fm" || head === "def-pcm") {
      const items = root.items.filter((n) => n.kind !== "comment");
      const name = atomValue(items[1]);
      if (name && items[1].kind === "atom" && rejectNoteName(head, name, root, diagnostics)) continue;
      if (!name || items[1].kind !== "atom" || isReservedHead(name)) {
        pushDiag(diagnostics, "error", name ? "E_DEF_RESERVED" : "E_DEF_NAME",
          name ? `'${name}' is a reserved eval builtin and cannot be a def name`
            : `${head} name must be a symbol`,
          nodeSrc(root), null);
        continue;
      }
      const baseTok = atomValue(items[2]);
      const base = baseTok && items[2].kind === "atom" && !baseTok.startsWith(":") ? baseTok : null;
      const body = items.slice(base ? 3 : 2);
      if (head === "def-fm")
        typedDefs.set(name, { tag: "voice", extends: base, items: body, src: nodeSrc(root) });
      else
        sampleDefs.set(name, {
          tag: "sample",
          ...parseSampleDef(body, base, diagnostics, nodeSrc(root)),
          src: nodeSrc(root),
        });
      continue;
    }

    // (def-wave name :wave [v …]) — a wavetable channel's wave, named data
    // like a def-fm voice; resolveWaves reads its values once every def is
    // known.
    if (head === "def-wave") {
      const items = root.items.filter((n) => n.kind !== "comment");
      const name = atomValue(items[1]);
      if (name && items[1].kind === "atom" && rejectNoteName(head, name, root, diagnostics)) continue;
      if (!name || items[1].kind !== "atom" || isReservedHead(name) || name.startsWith(":")) {
        pushDiag(diagnostics, "error", name && isReservedHead(name) ? "E_DEF_RESERVED" : "E_DEF_NAME",
          name && isReservedHead(name) ? `'${name}' is a reserved eval builtin and cannot be a def name`
            : `${head} name must be a symbol`,
          nodeSrc(root), null);
        continue;
      }
      typedDefs.set(name, { tag: "wave", items: items.slice(2), src: nodeSrc(root) });
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
        if (rejectNoteName(head, pname, root, diagnostics)) continue;
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
      if (rejectNoteName(head, name, root, diagnostics)) continue;
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
      // Anything else is a snippet: expanded where its name is written.
      defs.set(
        name,
        root.items.slice(2).filter((n) => n.kind !== "comment"),
      );
      continue;
    }

    remaining.push(root);
  }

  // `:public` slots first, each group in declaration order: the indices the
  // host writes do not move when the score adds a value of its own.
  const ordered = [...vals.values()].sort((a, b) => b.public - a.public || a.slot - b.slot);
  vals.clear();
  ordered.forEach((v, i) => vals.set(v.name, { ...v, slot: i }));
  if (vals.size > 16)
    pushDiag(diagnostics, "error", "E_DEFVAL_COUNT",
      `${vals.size} def-val slots; the driver holds 16`, null, null);
  return { defs, paramDefs, typedDefs, sampleDefs, seDefs, vals, fileMeta, imports, mods, remaining };
}

// The channels a sound effect may play on — every one a song may but CH3.
const SE_CHANNELS = new Set([
  "fm1", "fm2", "fm4", "fm5", "fm6", "sqr1", "sqr2", "sqr3", "noise",
  "pcm1", "pcm2", "pcm3",
]);
// CH3 is not an effect's: its operator mode and CSM are chip-wide, and the
// song's CH3 parts could not play on under an effect (driver.md §2.5).
const SE_CH3 = new Set(["fm3", "fm3-1", "fm3-2", "fm3-3", "fm3-4", "fm3-csm", "fm3-csm-rate"]);
// What an effect may not write, by IR target: the source keyword to name.
const SE_FORBIDDEN_TARGETS = { MASTER: ":master", LFO_RATE: ":lfo-rate", LFO_FREQ: ":lfo-freq", LFO_PMD: ":lfo-pmd",
  LFO_AMD: ":lfo-amd", LFO_WAVE: ":lfo-wave", NOISE_RATE: ":noise-rate",
  ENV_RATE: ":env-rate" };

// (def-se name [:prio N] [:tempo T] (channel body…)…). The head options are
// the effect's: :prio its default priority (0-255, the host may pass its
// own), :tempo the clock its parts run on (default 120) — its own, so an
// effect sounds the same in every song. Each part is a channel form, one per
// channel, written on the channel it takes from the song.
// (def-score :title "…" :composer "…" :author "…" :pcm-voices N :target T) — the
// whole score's settings (language.md §1). Several forms combine; a key given
// twice is an error, as is one it does not know.
function parseScoreDef(root, fileMeta, diagnostics) {
  const items = root.items.filter((n) => n.kind !== "comment");
  const err = (msg, at) =>
    pushDiag(diagnostics, "error", "E_SCORE_OPTION", `def-score: ${msg}`, nodeSrc(at ?? root), "global");
  for (let k = 1; k < items.length; k += 2) {
    const key = atomValue(items[k]);
    const v = items[k + 1];
    const field = { ":title": "title", ":composer": "composer", ":author": "author", ":pcm-voices": "pcmVoices",
      ":target": "target" }[key];
    if (!field) {
      err(`unknown option ${key ?? describeNodeToken(items[k])} (takes :title :composer :author :pcm-voices :target)`, items[k]);
      continue;
    }
    if (!v) {
      err(`${key} needs a value`, items[k]);
      continue;
    }
    if (fileMeta[field] !== null) {
      err(`${key} is given twice`, items[k]);
      continue;
    }
    if (field === "pcmVoices") {
      // How many PCM voices the driver plays: it picks the engine image and
      // with it the DAC rate (driver.md §5).
      const r = readConstNumber(v, null, diagnostics, "global", nodeSrc(v));
      const n = r == null || !Number.isInteger(r) ? null : r;
      if (n === null || n < 0 || n > 3)
        pushDiag(diagnostics, "error", "E_PCM_VOICES",
          `def-score :pcm-voices takes 0-3 (got ${atomValue(v) ?? "a list"})`, nodeSrc(v), "global");
      else fileMeta.pcmVoices = n;
    } else if (field === "target") {
      // The machine the score is for (targets.js): a symbol, md or pc88.
      const name = v.kind === "atom" ? v.value : null;
      if (name && Object.hasOwn(TARGETS, name)) fileMeta.target = name;
      else err(`:target takes ${Object.keys(TARGETS).join(" or ")}, not ${atomValue(v) ?? "a list"}`, v);
    } else if (v.kind === "string") fileMeta[field] = v.value;
    else err(`${key} takes a string`, v);
  }
}

function parseSeDef(root, diagnostics) {
  const items = root.items.filter((n) => n.kind !== "comment");
  const name = atomValue(items[1]);
  if (!name || items[1].kind !== "atom" || name.startsWith(":") || isReservedHead(name)) {
    pushDiag(diagnostics, "error", name && isReservedHead(name) ? "E_DEF_RESERVED" : "E_DEF_NAME",
      name && isReservedHead(name) ? `'${name}' is a reserved eval builtin and cannot be a def name`
        : "def-se name must be a symbol", nodeSrc(root), null);
    return null;
  }
  const se = { name, prio: 0, tempo: 120, parts: [], src: nodeSrc(root) };
  let i = 2;
  for (; i + 1 < items.length && items[i].kind === "atom"; i += 2) {
    const key = atomValue(items[i]);
    const v = readConstNumber(items[i + 1], null, diagnostics, "global", nodeSrc(items[i + 1]));
    if (v === undefined) continue;
    if (key === ":prio" && Number.isInteger(v) && v >= 0 && v <= 255) se.prio = v;
    else if (key === ":tempo" && v !== null && v > 0) se.tempo = v;
    else {
      pushDiag(diagnostics, "error", "E_SE_OPTION",
        key === ":prio" ? `def-se :prio takes 0-255, not ${atomValue(items[i + 1]) ?? "a list"}`
          : key === ":tempo" ? `def-se :tempo takes a BPM, not ${atomValue(items[i + 1]) ?? "a list"}`
            : `def-se takes :prio and :tempo before its parts, not ${key}`,
        nodeSrc(items[i]), null);
    }
  }
  const seen = new Set();
  for (const part of items.slice(i)) {
    const head = part.kind === "list" ? atomValue(part.items[0]) : null;
    if (head && SE_CH3.has(head)) {
      pushDiag(diagnostics, "error", "E_SE_PART",
        `def-se ${name}: an effect cannot play on CH3 (${head}); put it on fm1, fm2 or fm4–fm6`,
        nodeSrc(part), null);
      continue;
    }
    if (!head || !SE_CHANNELS.has(head)) {
      pushDiag(diagnostics, "error", "E_SE_PART",
        `a def-se part is a channel form, e.g. (fm1 …), not ${head ? `(${head} …)` : "that"}`,
        nodeSrc(part), null);
      continue;
    }
    if (seen.has(head)) {
      pushDiag(diagnostics, "error", "E_SE_PART",
        `def-se ${name} has two parts on ${head}; an effect plays one part a channel`,
        nodeSrc(part), null);
      continue;
    }
    seen.add(head);
    se.parts.push(part);
  }
  if (!se.parts.length) {
    pushDiag(diagnostics, "error", "E_SE_PART", `def-se ${name} has no parts`, nodeSrc(root), null);
    return null;
  }
  return se;
}

// The def namespaces `import` folds across files (§9.2). def-val
// slots and tracks are deliberately NOT imported (a slot's index is the
// importing file's host-visible layout; tracks are songs, not a library) —
// an effect is a def, so a game's set of them is one file every song shares.
const IMPORT_DEF_KINDS = ["defs", "paramDefs", "typedDefs", "sampleDefs", "seDefs"];

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
// An `:over` import (`over`) instead replaces what the earlier siblings define
// under its names, in every namespace, as a file's own defs do (overlayDefs) —
// so a kit layered on a base keeps the base's sounds it does not have.
function mergeImportsStrict(base, incoming, diagnostics, conflictSrc, over = false) {
  if (over) {
    for (const kind of IMPORT_DEF_KINDS)
      for (const name of incoming[kind].keys())
        for (const k of IMPORT_DEF_KINDS) {
          if (base.origin[k].get(name) === incoming.origin[kind].get(name)) continue; // diamond
          base[k].delete(name);
          base.origin[k].delete(name);
        }
  }
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
  // The overlaying file wins a name in every namespace: a local def-fm `pad`
  // hides an imported snippet `pad`, not just an imported def-fm `pad`.
  for (const kind of IMPORT_DEF_KINDS)
    for (const name of own[kind].keys())
      for (const k of IMPORT_DEF_KINDS) {
        base[k].delete(name);
        base.origin[k].delete(name);
      }
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
    seDefs: new Map(),
    origin: {
      defs: new Map(),
      paramDefs: new Map(),
      typedDefs: new Map(),
      sampleDefs: new Map(),
      seDefs: new Map(),
    },
  };
}

// Warn (once per file) about content in an imported file that import ignores:
// def-val slots and track/other top-level forms — import brings defs only.
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
  if (Object.values(bundle.fileMeta).some((v) => v !== null)) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' has a def-score; the settings are the importing score's own, so they are ignored`,
      importSrc,
      null,
    );
  }
  if (bundle.mods.length > 0) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' contains def-mod forms; a modifier is the importing score's own, so they are ignored`,
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
function resolveImportFile(path, importSrc, importSources, diagnostics, cache, stack, baseDir = "") {
  // Next to the importing file first; failing that, from the root (a served
  // score's `presets/…`) — and the file is then where it was found, so its
  // samples and its own imports resolve from there.
  const joined = importedFilePath(path, baseDir);
  const selfPath =
    !importSources?.has(joined) && importSources?.has(normalizePosixPath(path))
      ? normalizePosixPath(path)
      : joined;
  const selfDir = dirnamePosix(selfPath);
  if (stack.includes(selfPath)) {
    pushDiag(
      diagnostics,
      "error",
      "E_IMPORT_CYCLE",
      `import cycle: ${[...stack, selfPath].join(" -> ")}`,
      importSrc,
      null,
    );
    return emptyImportBundle();
  }
  if (cache.has(selfPath)) return cache.get(selfPath);

  const text = importSources?.get(selfPath);
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
    cache.set(selfPath, empty);
    return empty;
  }

  // Its nodes say which file they are from, so a position taken from one
  // (an event's src) is not read as a place in the score.
  const ast = parse(text);
  markFile(ast, path);
  const bundle = collectDefs(ast, diagnostics);
  warnImportIgnored(bundle, path, diagnostics, importSrc);
  // The set's own wav/ lives next to it, not next to the score that imports it
  // — and so does an extending sample's own :file.
  for (const sample of bundle.sampleDefs.values()) sample.baseDir = selfDir;

  // Resolve this file's own imports first (siblings merged strictly), then let
  // this file's defs overlay them.
  const merged = emptyImportBundle();
  const nextStack = [...stack, selfPath];
  for (const imp of bundle.imports) {
    const sub = resolveImportFile(
      imp.path,
      imp.src,
      importSources,
      diagnostics,
      cache,
      nextStack,
      selfDir,
    );
    mergeImportsStrict(merged, withImportEffect(sub, imp.fxNode), diagnostics, imp.src, imp.over);
  }
  overlayDefs(merged, bundle, selfPath);

  cache.set(selfPath, merged);
  return merged;
}

// Fold all of the root file's imports into one bundle (siblings merged strictly).
function resolveImports(importForms, importSources, diagnostics, scoreDir) {
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
      scoreDir,
    );
    mergeImportsStrict(merged, withImportEffect(sub, imp.fxNode), diagnostics, imp.src, imp.over);
  }
  return merged;
}

// An import's `:fx` rides on every sample it brings in, AHEAD of the def's
// own chain (the outermost import first): the kit is processed as a whole, then
// each sound is adjusted on top, so a per-sound level survives a kit-wide
// normalize. A copy — the cached bundle is shared by every importer.
function withImportEffect(bundle, fxNode) {
  if (!fxNode) return bundle;
  const sampleDefs = new Map();
  for (const [name, s] of bundle.sampleDefs)
    sampleDefs.set(name, { ...s, importFx: [fxNode, ...(s.importFx ?? [])] });
  return { ...bundle, sampleDefs };
}

// `(def-pcm name base …)`: the child takes the base's file (still read from the
// base's folder), slice, loop and effects — the import's chain included — and
// overrides the keys it writes. Runs once imports are merged, so a base may
// come from an imported kit.
function resolveSampleExtends(sampleDefs, diagnostics) {
  const done = new Set();
  const resolve = (name, seen) => {
    const own = sampleDefs.get(name);
    if (!own?.extends || done.has(name)) return own;
    if (seen.has(name)) {
      pushDiag(diagnostics, "error", "E_SAMPLE_EXTENDS",
        `sample '${name}' extends itself`, own.src, null);
      return null;
    }
    seen.add(name);
    const base = sampleDefs.has(own.extends) ? resolve(own.extends, seen) : null;
    done.add(name);
    if (!base) {
      if (!sampleDefs.has(own.extends))
        pushDiag(diagnostics, "error", "E_SAMPLE_EXTENDS",
          `'${own.extends}' is not a sample`, own.src, null);
      return null;
    }
    const child = { ...base, src: own.src, extends: null };
    for (const k of ["rate", "offset", "frames", "startTok", "loopStartTok", "fxNode"])
      if (own[k] !== null) child[k] = own[k];
    if (own.file !== null) {
      child.file = own.file;
      child.baseDir = own.baseDir;
    }
    if (own.endTok !== null || own.lenTok !== null) {
      child.endTok = own.endTok;
      child.lenTok = own.lenTok;
    }
    if (own.loopEndTok !== null || own.loopLenTok !== null) {
      child.loopEndTok = own.loopEndTok;
      child.loopLenTok = own.loopLenTok;
    }
    sampleDefs.set(name, child);
    return child;
  };
  for (const name of [...sampleDefs.keys()]) resolve(name, new Set());
}

// Replace bare atoms matching a parameter name with the caller's argument node
// (lexically, within a parametric def body). Args are single nodes (atom/list).
// A `let`/`for` name in the body is its own scope: it shadows a parameter of
// the same name, and one that an argument mentions is renamed, so the
// argument keeps meaning what it meant at the call — `(tri n)` into a body
// binding `n` does not read the body's `n`.
let freshNameCounter = 0;
function atomsIn(node, out = new Set()) {
  if (node.kind === "atom") out.add(node.value);
  else if (node.kind === "list") for (const it of node.items) atomsIn(it, out);
  return out;
}
function substituteParams(node, paramMap, argAtoms = null) {
  if (node.kind === "atom") {
    const sub = paramMap.get(node.value);
    if (!sub) return { ...node };
    // A renamed binding keeps the use site's own position for diagnostics.
    return sub.rename ? { ...node, value: sub.rename } : { ...sub };
  }
  if (node.kind !== "list") return { ...node };
  argAtoms ??= new Set([...paramMap.values()].flatMap((a) => [...atomsIn(a)]));
  const head = atomValue(node.items[0]);
  const vec = node.items[1];
  if ((head === "let" || head === "for") && vec?.kind === "list" && vec.bracket === "[]") {
    let pairs = null;
    try { pairs = letPairs(vec); } catch (_) {}
    if (pairs) {
      // Bindings in turn: a value sees the names before it, not its own.
      const scope = new Map(paramMap);
      const out = new Map();
      for (const [name, value] of pairs) {
        out.set(value, substituteParams(value, scope, argAtoms));
        if (name.kind !== "atom") { out.set(name, { ...name }); continue; }
        if (!argAtoms.has(name.value)) { scope.delete(name.value); out.set(name, { ...name }); continue; }
        const fresh = { ...name, value: `${name.value}__${++freshNameCounter}` };
        scope.set(name.value, { rename: fresh.value });
        out.set(name, fresh);
      }
      const items = vec.items.map((it) => out.get(it) ?? { ...it });
      return {
        ...node,
        items: [{ ...node.items[0] }, { ...vec, items },
          ...node.items.slice(2).map((it) => substituteParams(it, scope, argAtoms))],
      };
    }
  }
  return { ...node, items: node.items.map((it) => substituteParams(it, paramMap, argAtoms)) };
}

// `depth` counts snippet expansions only — a def expanding into a def — so a
// deep expression is not mistaken for recursion (its own limit is E_EVAL_DEPTH).
function expandNode(node, defs, paramDefs, depth, diagnostics) {
  if (depth > 16) {
    pushDiag(diagnostics, "error", "E_DEF_RECURSION",
      "snippet expansion nested more than 16 deep (a def that refers to itself?)",
      nodeSrc(node), null);
    return [];
  }
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

  // An `if`'s branch is one item: a snippet that expands to several stays one
  // branch, wrapped in an empty `let` (which compiles in place), so the else
  // is still the item after it.
  if (head === "if") {
    const pos = { line: node.line, column: node.column, file: node.file };
    const asOne = (n) => {
      const out = expandNode(n, defs, paramDefs, depth, diagnostics);
      return out.length === 1 ? out
        : [{ kind: "list", bracket: "()", ...pos, line: n.line, column: n.column, items: [
          { kind: "atom", value: "let", ...pos }, { kind: "list", bracket: "[]", ...pos, items: [] }, ...out] }];
    };
    let seen = 0; // the head and the test expand as usual; each branch stays one item
    return [{ ...node, items: node.items.flatMap((n) =>
      n.kind === "comment" ? [n] : seen++ < 2 ? expandNode(n, defs, paramDefs, depth, diagnostics) : asOne(n)) }];
  }

  // A `let` or `for` binding's name is a new name, not a reference: it is not
  // expanded, and naming a snippet with it is E_LET_SHADOWS_DEF (a voice or a
  // sample is caught where the form binds, mmlisp-eval.js).
  // A malformed vector is left as written, for the form's own diagnostic.
  if ((head === "let" || head === "for") && node.items[1]?.kind === "list" && node.items[1].bracket === "[]") {
    let pairs = null;
    try { pairs = letPairs(node.items[1]); } catch (_) {}
    if (pairs) {
      const names = new Set(pairs.map(([n]) => n).filter((n) => n.kind === "atom"));
      for (const n of names)
        if (defs.has(n.value) || paramDefs.has(n.value))
          pushDiag(diagnostics, "error", "E_LET_SHADOWS_DEF",
            `${head} name '${n.value}' shadows a def`, nodeSrc(n), null);
      const bindings = node.items[1].items.flatMap((n) =>
        names.has(n) ? [n] : expandNode(n, defs, paramDefs, depth, diagnostics));
      const rest = node.items.slice(2).flatMap((n) => expandNode(n, defs, paramDefs, depth, diagnostics));
      return [{ ...node, items: [node.items[0], { ...node.items[1], items: bindings }, ...rest] }];
    }
  }

  const newItems = [];
  for (const item of node.items)
    newItems.push(...expandNode(item, defs, paramDefs, depth, diagnostics));
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
  // `options.frameHz` picks the video standard the score is baked for: 60 for
  // NTSC (the default, and what the editor previews) or 50 for PAL. It is
  // compile-wide, so it is installed here rather than threaded — see
  // `compileFrameHz`. Restored in `finally` so a throw cannot leave the next
  // compile on the wrong clock.
  const wantHz = options.frameHz === FRAME_HZ_PAL ? FRAME_HZ_PAL : FRAME_HZ_NTSC;
  const prevHz = compileFrameHz;
  compileFrameHz = wantHz;
  try {
    // Tempo is song-wide, but each track converts its lengths (an `Nf` note,
    // a `125ms` gate) at the tempo in force as it goes — and a track sees only
    // its own :tempo writes. A song that changes tempo after tick 0 is compiled
    // twice: the first pass finds every track's tempo changes, the second
    // converts each length at the tempo the song has at its tick (§4).
    const first = compileScore(src, filename, options, wantHz, null);
    const tempoAt = songTempoMap(first.ir, first.openingBpm);
    const { openingBpm: _o, ...result } = tempoAt
      ? compileScore(src, filename, options, wantHz, tempoAt)
      : first;
    return result;
  } finally {
    compileFrameHz = prevHz;
  }
}

// The song's tempo at a tick, from every track's TEMPO_SET / TEMPO_SWEEP
// (a sweep counts at its end tempo from its start, as a track's own does),
// last writer winning at a tick in track order — or null when nothing changes
// the tempo after tick 0 and the song opens at the tempo the first pass read
// ahead (`opening`: a tempo written as an expression, or in a let, is not).
function songTempoMap(ir, opening) {
  const changes = [];
  (ir?.tracks ?? []).forEach((tr, ti) =>
    !tr.se && (tr.events ?? []).forEach((ev, ei) => {
      const bpm =
        ev.cmd === "TEMPO_SET" ? Number(ev.args?.bpm)
          : ev.cmd === "TEMPO_SWEEP" ? Number(ev.args?.to ?? ev.args?.from) : NaN;
      if (bpm > 0) changes.push({ tick: ev.tick ?? 0, ti, ei, bpm });
    }),
  );
  changes.sort((a, b) => a.tick - b.tick || a.ti - b.ti || a.ei - b.ei);
  const atZero = changes.filter((c) => c.tick === 0).at(-1)?.bpm ?? 120;
  if (!changes.some((c) => c.tick > 0) && atZero === opening) return null;
  return (tick) => {
    let bpm = null;
    for (const c of changes) {
      if (c.tick > tick) break;
      bpm = c.bpm;
    }
    return bpm;
  };
}

function compileScore(src, filename, options, frameHz, tempoAt) {
  const diagnostics = [];
  drawStreams = new Map(); // every compile draws from the top (makeEvalCtx)
  const parsed = parse(src);
  const {
    defs,
    paramDefs,
    typedDefs,
    sampleDefs,
    seDefs,
    vals,
    fileMeta,
    imports,
    mods: modForms,
    remaining,
  } = collectDefs(parsed, diagnostics);
  // Fold imported defs in *under* this file's own — imports are
  // overridable defaults (local wins); two imports defining the same name is
  // E_IMPORT_CONFLICT. def-val slots and tracks are not imported (defs only).
  if (imports.length > 0) {
    const imported = resolveImports(
      imports,
      options.imports,
      diagnostics,
      dirnamePosix(normalizePathSeparators(filename)),
    );
    const local = { defs, paramDefs, typedDefs, sampleDefs, seDefs };
    overlayDefs(imported, local, filename); // local wins; `imported` = the union
    for (const kind of IMPORT_DEF_KINDS) {
      local[kind].clear();
      for (const [name, def] of imported[kind]) local[kind].set(name, def);
    }
  }
  if (!typedDefs.has("init-fm")) {
    typedDefs.set("init-fm", {
      tag: "voice",
      extends: null,
      items: [],
      kwMap: createInitFmKwMap(targetProfile(fileMeta.target)),
      src: null,
    });
  }
  // The OPLL's fifteen ROM voices are built in on every target, as init-fm
  // is: the chip's own on its channels, a 4-op reading elsewhere
  // (chips/ym2413.js). A score's own def of the name is that def.
  for (const [name, kwMap] of opllRomVoices(targetProfile(fileMeta.target).parts.find((p) => p.kind === "fm")))
    if (!typedDefs.has(name)) typedDefs.set(name, { tag: "voice", extends: null, items: [], kwMap, src: null });
  resolveVoices(typedDefs, defs, paramDefs, diagnostics,
    writesVelSens(parsed, defs, paramDefs, typedDefs, seDefs), targetProfile(fileMeta.target));
  const waves = resolveWaves(typedDefs, defs, paramDefs, diagnostics);
  resolveSampleExtends(sampleDefs, diagnostics);
  // A target with a ROM rhythm kit names its sounds by the kit roles
  // (targets.js): a def of that name is that sound there, and one the score
  // does not define is built in, as init-fm is — an empty def (its "needs
  // :file" diagnostic goes nowhere: the ROM sound is all it is). A copy
  // either way: an import's defs are its cached bundle's, shared by every
  // score.
  const rhythmKit = Object.assign({}, ...targetProfile(fileMeta.target).parts.map((p) => p.kit ?? {}));
  for (const [name, sound] of Object.entries(rhythmKit))
    sampleDefs.set(name, {
      ...(sampleDefs.get(name) ?? { tag: "sample", ...parseSampleDef([], null, [], null), src: null }),
      rhythm: sound,
    });
  typedDefs.sampleNames = sampleDefs; // for a let name shadowing a sample
  const roots = expandRoots(remaining, defs, paramDefs, diagnostics);

  // 1 file = 1 score. There is no (score …) wrapper — the post-expand
  // root list *is* the score body: def/track forms interleave freely in source
  // order. File metadata comes from (def-score …).
  const fileSrc = roots.length > 0 ? nodeSrc(roots[0]) : { line: 1, column: 1 };

  // The tempo active at tick 0 seeds every track's currentTempo (tempo is
  // score-global) and the Nf frame conversion. Prescan the leading `:key value`
  // run of each track form for its `:tempo` — a bare BPM number or a curve
  // (its :from, default 120). Tempo is last-writer-wins at a tick, in track
  // order (§5), so the LAST track's leading tempo is the one that plays.
  let scoreInitialBpm = null;
  for (const node of roots) {
    if (node?.kind !== "list" || node.items.length === 0) continue;
    // The leading run: `:key value` pairs, and the voice / sample names bound
    // among them (they take no time).
    for (let i = 1; i + 1 < node.items.length; i += 2) {
      const key = atomValue(node.items[i]);
      if (typedDefs.has(key) || sampleDefs.has(key)) {
        i--;
        continue;
      }
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
      break;
    }
  }

  // The second pass knows the tempo the song really opens at (one written as
  // an expression or inside a let escapes the read-ahead above).
  if (tempoAt) scoreInitialBpm = tempoAt(0) ?? scoreInitialBpm;

  // A def is parsed before any track, so a musical length inside one has no
  // tempo yet. Resolve the loop tokens here, at the tempo the score opens with.
  // The unit is SECONDS in the sample's own time — what a wave editor shows —
  // and the exporter maps them per baked blob, so a loop stays where it was set
  // however the note transposes (docs/language.md §16).
  // One resolve per :fx form: an import's chain is shared by every sample
  // of the kit, and an :extend shares its base's, so each is checked once.
  const fxResolved = new Map();
  for (const sample of sampleDefs.values()) {
    const bpm = scoreInitialBpm ?? 120;
    const fx = (node) => {
      if (!fxResolved.has(node))
        fxResolved.set(node, resolveSampleEffects(node, bpm, diagnostics, sample.src ?? fileSrc));
      return fxResolved.get(node);
    };
    // The import's chain first, then the def's own.
    sample.fx = [
      ...(sample.importFx ?? []).flatMap(fx),
      ...(sample.fxNode ? fx(sample.fxNode) : []),
    ];
    const sec = (tok, key) => {
      if (tok == null) return null;
      const v = lengthTokenSeconds(tok, bpm);
      if (v === null || !(v >= 0)) {
        pushDiag(
          diagnostics,
          "error",
          "E_SAMPLE_RANGE",
          `def-pcm ${key} is not a length: ${tok}`,
          sample.src ?? fileSrc,
          "global",
        );
        return null;
      }
      return v;
    };
    const rangeErr = (msg) => pushDiag(diagnostics, "error", "E_SAMPLE_RANGE",
      `def-pcm ${msg}`, sample.src ?? fileSrc, "global");
    const start = sec(sample.startTok, ":pcm-start");
    const end = sec(sample.endTok, ":pcm-end");
    const len = sec(sample.lenTok, ":pcm-len");
    if (start !== null || end !== null || len !== null) {
      sample.startSec = start ?? 0;
      // :pcm-end and :pcm-len both set the far bound; neither given means "to
      // the end of the sample", which the exporter fills in.
      sample.endSec = end ?? (len === null ? null : sample.startSec + len);
      if (sample.endSec !== null && sample.endSec <= sample.startSec) {
        rangeErr(`range ends at or before it starts (${sample.startSec}s -> ${sample.endSec}s)`);
        sample.startSec = null;
        sample.endSec = null;
      }
    }
    // The loop sits inside the range: pcm-start ≤ loop-start < loop-end ≤
    // pcm-end. A loop point left out follows the range (null), which the
    // exporter fills in per note.
    const ls = sec(sample.loopStartTok, ":loop-start");
    const le = sec(sample.loopEndTok, ":loop-end");
    const ll = sec(sample.loopLenTok, ":loop-len");
    if (ls !== null || le !== null || ll !== null) {
      const rs = sample.startSec ?? 0, re = sample.endSec;
      const from = ls ?? rs;
      const to = le ?? (ll === null ? null : from + ll);
      if (to !== null && to <= from) {
        rangeErr(`loop ends at or before it starts (${from}s -> ${to}s)`);
      } else if (from < rs || (re !== null && (from >= re || (to !== null && to > re)))) {
        const sec2 = (x) => (x === null ? "end" : `${x}s`);
        rangeErr(`loop (${sec2(from)} -> ${sec2(to)}) is outside its range (${sec2(rs)} -> ${sec2(re)})`);
      } else {
        sample.loopStartSec = ls;
        sample.loopEndSec = to;
      }
    }
  }

  // Lists with a channel name as the form head are tracks: the target's
  // channels (targets/).
  const target = targetProfile(fileMeta.target);
  const CHANNEL_NAMES = target.channelNames;

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
  // CSM with the operators as tracks (language.md §15): a note-less
  // (fm3-csm voice) beside fm3-1..fm3-4 — each operator's F-number and level
  // is its track's, a formant — and the buzz from an fm3-csm-rate track, the
  // one rate source there.
  const hasCsmOps = channelHeads.has("fm3-csm") && hasFm3OpTracks;
  if (hasCsmMode && channelHeads.has("fm3")) {
    pushDiag(diagnostics, "error", "E_FM3_MODE_CONFLICT",
      "fm3-csm/fm3-csm-rate cannot be mixed with fm3 in the same score", fileSrc, "global");
  }
  if (hasCsmMode && hasFm3OpTracks && !hasCsmOps) {
    pushDiag(diagnostics, "error", "E_FM3_MODE_CONFLICT",
      "fm3-1..fm3-4 beside fm3-csm-rate need a note-less (fm3-csm voice) track for the shared patch",
      fileSrc, "global");
  }
  if (hasCsmOps && !channelHeads.has("fm3-csm-rate")) {
    pushDiag(diagnostics, "error", "E_CSM_RATE_MISSING",
      "fm3-csm beside fm3-1..fm3-4 takes its rate from an fm3-csm-rate track; the score has none",
      fileSrc, "global");
  }

  // A part that reads :pcm-voices (the Mega Drive's DAC soft mix) plays as
  // many voices as its engine image, a whole-song choice — one image plays
  // 1, 2 or 3 voices at 14.4 / 10.1 / 6.7 kHz. The score states it, or it is
  // the highest of the part's voices a track uses. Any other target has none.
  // An effect's channels count here too: its PCM needs the voices, and fm6 is
  // the DAC for an effect as for the song.
  const allHeads = new Set(channelHeads);
  for (const se of seDefs.values())
    for (const part of se.parts) allHeads.add(atomValue(part.items[0]));
  const countsVoices = (part) => part?.settings?.includes(":pcm-voices");
  let pcmUsed = 0;
  for (const head of allHeads)
    if (countsVoices(target.partOf(head))) pcmUsed = Math.max(pcmUsed, target.channels[head].voice + 1);
  const pcmVoices = target.parts.some(countsVoices) ? fileMeta.pcmVoices ?? pcmUsed : 0;

  // What the target has, and what it does not: its parts' rules
  // (chips/parts.js `checkScore`), then the rules every target shares. The
  // line between a warning and an error is docs/roadmap.md's pc88 item.
  const scorePush = (severity, code, message) => pushDiag(diagnostics, severity, code, message, fileSrc, "global");
  for (const part of target.parts) part.checkScore?.({ target, allHeads, pcmUsed, pcmVoices, push: scorePush });
  // A def-score setting only a part this target lacks reads.
  for (const [key, value] of [[":pcm-voices", fileMeta.pcmVoices]])
    if (value !== null && !target.parts.some((p) => p.settings?.includes(key)))
      targetDiag(diagnostics, "warning",
        `${key} is the ${partsWithSetting(key)}'s setting; ${target.name} has no such choice, so it is ignored`,
        fileSrc, "global");
  // Two names on one physical voice in different parts are one channel two
  // ways (the SSG's noise is a tone channel's mixer): a score has one.
  const byVoice = new Map();
  for (const head of allHeads) {
    const key = target.voiceKey(head);
    if (!key) continue;
    if (!byVoice.has(key)) byVoice.set(key, []);
    byVoice.get(key).push(head);
  }
  for (const heads of byVoice.values()) {
    const parts = new Set(heads.map((h) => target.partOf(h)));
    if (parts.size < 2) continue;
    const by = heads.find((h) => target.partOf(h).shareHint) ?? heads[1];
    const other = heads.find((h) => target.partOf(h) !== target.partOf(by));
    const hint = target.partOf(by).shareHint?.(other);
    targetDiag(diagnostics, "error",
      `on ${target.name} ${by} and ${other} are one channel, so a score has one or the other${hint ? ` — ${hint}` : ""}`,
      fileSrc, "global");
  }
  // Sound effects are started by a game through the target's driver.
  if (!target.driver && seDefs.size > 0)
    targetDiag(diagnostics, "error",
      `def-se is a sound effect a game starts through the Mega Drive's driver; the ${target.system}'s score (:target ${target.name}) is a VGM and has none`,
      [...seDefs.values()][0].src ?? fileSrc, "global");

  // A track's compile state — all of it sticky, persisting across
  // consecutive forms of the same channel. `tempoAt` is the song's tempo map
  // (second pass), which an effect's parts do not follow: they run at their
  // own tempo whatever the song does.
  const makeTrackState = (head, bpm, initialBpm, tempoAt) => ({
    tick: 0,
    head,
    target, // the machine (targets/): what its channels have
    part: target.partOf(head), // what the channel is (chips/parts.js)
    fmClock: target.chipForKind("fm")?.clock, // the CSM rate's Timer A runs on it
    defaultLength: Math.round(WHOLE_TICKS / 8),
    defaultOct: 4,
    voiceKeyShift: 0, // the current voice's `:key` − 60
    defaultGate: null,
    // The tempo lengths convert at: the song's at this tick when the
    // song-wide map is known (second pass), else this track's own.
    ownTempo: bpm,
    get currentTempo() {
      return (tempoAt && tempoAt(this.tick)) ?? this.ownTempo;
    },
    set currentTempo(v) {
      this.ownTempo = v;
    },
    initialBpm,
    isFm3OpTrack: /^fm3-[1-4]$/.test(head),
    fm3OpIndex: /^fm3-[1-4]$/.test(head)
      ? parseInt(head.slice(4), 10)
      : null,
    isCsmTrack: head === "fm3-csm",
    isCsmRateTrack: head === "fm3-csm-rate",
    isPcmTrack: target.partOf(head)?.kind === "sample",
    pcmSampleName: null, // bound by a bare sample name in the body
    pcmMode: "shot",
    sampleDefs,
    waves, // the def-waves, by name in waves.index (resolveWaves)
    hasInlineCsmRate: false,
    hasCsmOn: false,
    defaultVel: 15, // per-note velocity, KEY-ON scoped, 0-15
    activeMacros: {}, // the macros in force, { target: spec, ... } for all targets
    delayTicks: 0, // (delay …) tap spacing in ticks (0 = off)
    delaySpec: null, // (delay …) relative spec {mode,type,…} or null

    glide: 0, // glide duration in ticks (0 = disabled)
    glideFrom: null, // one-shot start pitch override for glide
    lastNotePitch: null, // previous note's pitch for glide calculation
    glideRamp: null, // where the last glide has the pitch (cents) / CSM rate (period): rampAt
    pitchSticky: 0, // the score's `:pitch` offset, null once it is a runtime value
    shuffleRatio: 0, // per-track swing, 0 = straight (§5.2)
    shuffleBase: Math.round(WHOLE_TICKS / 8),
    subBeatParity: 0,
    currentLoopId: null, // id of innermost counted (x N ...) loop, for (break)
  });

  const hasCompanionCsmRateTrack = channelHeads.has("fm3-csm-rate");
  let hasInlineCsmRate = false;
  // A stream that ends in `(go label)` never reaches its end: its CSM_OFF
  // would be unreachable on the driver and, in the preview — which runs a
  // track's events to their end before it loops — turn CSM off every pass.
  const endsInLoop = (events) => {
    const last = events[events.length - 1];
    return !!last && last.cmd === "JUMP" && last.args?.repeat == null;
  };
  const trackByKey = new Map();
  const trackOrder = [];
  const loopCounter = { count: 0 };

  for (const node of roots) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (head && !CHANNEL_NAMES.includes(head) && ALL_CHANNEL_NAMES.has(head)) {
      // Another machine's channel (targets/).
      targetDiag(diagnostics, "error", `${head} is not a channel of the ${target.system}`,
        nodeSrc(node.items[0]), null);
      continue;
    }
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

    // `:prio` is the one head option: it picks the layer (the timeline) the
    // form belongs to, so it must be read before the body. Everything else in
    // the form is body (language.md §5).
    // :prio layers forms on the same channel. Same prio appends (one
    // timeline); different prio values are independent parallel timelines on the
    // same physical channel, resolved by priority at the flatten post-pass.
    // Lower number = higher priority; default 8 (headroom on both sides).
    let i = 1;
    let prio = 8;
    if (atomValue(node.items[i]) === ":prio" && i + 1 < node.items.length) {
      const v = parseIntLike(atomValue(node.items[i + 1]));
      if (v !== null && v >= 0) prio = v;
      else
        pushDiag(diagnostics, "error", "E_PRIO_INVALID",
          `:prio takes a non-negative integer, not ${atomValue(node.items[i + 1]) ?? "a list"}`,
          nodeSrc(node.items[i]), head);
      i += 2;
    }
    const bodyItems = node.items.slice(i);
    const trackKey = `${head}:${prio}`;

    if (!trackByKey.has(trackKey)) {
      // All state is sticky and persists across consecutive forms of the same channel
      const trackState = makeTrackState(head, scoreInitialBpm ?? 120, scoreInitialBpm, tempoAt);

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

      // What the part starts every track with (the SN76489 noise's white0).
      // No src: nothing in the score wrote it, and a src (the whole track
      // form) would light the form up as the playhead, and lasting, on a
      // track with no notes.
      for (const args of trackState.part?.init ?? [])
        trackData.events.push({ tick: 0, cmd: "PARAM_SET", args: { ...args } });

      trackByKey.set(trackKey, { trackData, trackState, head, prio });
      trackOrder.push(trackKey);
    }

    const { trackData, trackState } = trackByKey.get(trackKey);
    // A pcm track's sample is checked where a note needs it (the note path),
    // once per track and sample — a body can still bind one before its notes.
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

    if (trackState.isCsmTrack && trackState.hasCsmOn && !endsInLoop(trackData.events)) {
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

  // Beside fm3-1..fm3-4 the rate track owns CSM: it turns the mode on at tick
  // 0 — Timer A held until its first rate — and off at its end, so the voice
  // sounds exactly while it plays (the note-less fm3-csm track ends at tick 0).
  if (hasCsmOps) {
    for (const key of trackOrder) {
      const { trackData, trackState } = trackByKey.get(key);
      if (!trackState.isCsmRateTrack) continue;
      const src = trackData.events[0]?.src;
      trackData.events.unshift(
        { tick: 0, cmd: "CSM_ON", args: {}, src },
        { tick: 0, cmd: "CSM_RATE", args: { run: false }, src },
      );
      if (!endsInLoop(trackData.events))
        trackData.events.push({ tick: trackState.tick, cmd: "CSM_OFF", args: {}, src });
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
  // def-mod: after the echoes exist, before the layers merge (applyMods).
  const mods = expandRoots(modForms, defs, paramDefs, diagnostics)
    .map((root) => parseModDef(root, CHANNEL_NAMES, typedDefs, sampleDefs, diagnostics))
    .filter(Boolean);
  for (const key of trackOrder) {
    const { trackData, head } = trackByKey.get(key);
    expandTrackDelays(trackData);
    if (mods.length) trackData.events = applyMods(trackData.events, head, mods);
  }

  const layersByHead = new Map();
  for (const key of trackOrder) {
    const entry = trackByKey.get(key);
    const arr = layersByHead.get(entry.head) ?? [];
    arr.push({ prio: entry.prio, trackData: entry.trackData });
    layersByHead.set(entry.head, arr);
  }

  // A part's rules for its notes, on every layer before flattening.
  const partShared = new Map();
  for (const key of trackOrder) {
    const { trackData, trackState } = trackByKey.get(key);
    const { part } = trackState;
    if (part && !partShared.has(part)) partShared.set(part, {});
    checkPartNotes(trackData.events, trackState, sampleDefs, diagnostics, key, partShared.get(part));
  }

  // Channels that share one wave memory (chips/parts.js `waveRam`: the SCC's
  // wave4 and wave5) play whichever wave was written last: said once when
  // their tracks name different ones.
  const waveRams = new Map();
  for (const key of trackOrder) {
    const { trackData, trackState } = trackByKey.get(key);
    const c = target.channels[trackState.head];
    if (!c?.part.waveRam) continue;
    const ram = `${c.chip}:${c.part.waveRam(c.voice)}`;
    const used = waveRams.get(ram) ?? { heads: new Set(), waves: new Set() };
    used.heads.add(trackState.head);
    for (const ev of trackData.events)
      if (ev.cmd === "PARAM_SET" && ev.args?.target === "WAVE") used.waves.add(ev.args.value);
    waveRams.set(ram, used);
  }
  for (const { heads, waves: named } of waveRams.values())
    if (heads.size > 1 && named.size > 1)
      targetDiag(diagnostics, "warning",
        `${[...heads].join(" and ")} share one wave memory, so the wave named last plays on both`, fileSrc, "global");

  const tracks = [];
  for (const [head, layers] of layersByHead) {
    tracks.push(
      layers.length === 1
        ? layers[0].trackData
        : flattenPriorityLayers(head, layers, diagnostics),
    );
  }

  // A part's rule over what its channels play together (chips/parts.js
  // `checkTracks`: the OPLL's one user voice), on each track's loops
  // written out, with the voices the score names.
  for (const part of target.parts) {
    if (!part.checkTracks) continue;
    const heads = new Set(target.channelNames.filter((h) => target.partOf(h) === part));
    const own = tracks.filter((t) => heads.has(t.channel));
    const named = [...typedDefs].filter(([, td]) => td.tag === "voice" && td.kwMap).map(([name, td]) => ({ name, kwMap: td.kwMap }));
    part.checkTracks({
      tracks: own.map((t) => ({ head: t.channel, events: expandLoops(t.events ?? []) })),
      named,
      push: (severity, code, message) => pushDiag(diagnostics, severity, code, message, fileSrc, "global"),
    });
  }

  // Sound effects (def-se), after the song's tracks: each part is a track of
  // its own on the channel it names — never merged into the song's timeline
  // there, since it takes the channel from the song rather than joining it —
  // on the effect's own clock, and marked with the effect's number (its
  // place among the def-se forms, imports first), which is how the host
  // starts it. The same set in every song gives the same numbers.
  let seIndex = 0;
  for (const se of seDefs.values()) {
    const parts = expandRoots(se.parts, defs, paramDefs, diagnostics);
    for (const node of parts) {
      const head = atomValue(node.items[0]);
      const trackState = makeTrackState(head, se.tempo, se.tempo, null);
      const trackData = {
        id: 0,
        scoreChannel: head,
        channel: head,
        se: { name: se.name, index: seIndex, prio: se.prio },
        events: [{ tick: 0, cmd: "TEMPO_SET", args: { bpm: se.tempo }, src: se.src }],
      };
      for (const args of trackState.part?.init ?? [])
        trackData.events.push({ tick: 0, cmd: "PARAM_SET", args: { ...args }, src: se.src });
      compileChannelBody(node.items.slice(1), trackState, trackData.events, diagnostics,
        `se:${se.name}:${head}`, typedDefs, loopCounter, vals);
      // :master, :lfo-rate and the def-val slots are the song's, not a
      // channel's — the game's fader, the chip's one LFO, the score's values —
      // and an effect's end would leave them as it set them. An effect does
      // not write them (language.md §9.3).
      const valNames = new Map([...vals.values()].map((v) => [`VAL${v.slot}`, `:${v.name}`]));
      for (const ev of trackData.events) {
        // A tempo sweep drives the song's clock; an effect's tempo is fixed.
        if (ev.cmd === "TEMPO_SWEEP") pushDiag(diagnostics, "error", "E_SE_PART",
          `def-se ${se.name}: a :tempo sweep moves the song's clock; an effect keeps a fixed tempo`,
          ev.src ?? se.src, null);
        const t = SE_FORBIDDEN_TARGETS[ev.args?.target] ?? valNames.get(ev.args?.target);
        if (t) pushDiag(diagnostics, "error", "E_SE_PART",
          `def-se ${se.name}: ${t} is the song's, not an effect's`, ev.src ?? se.src, null);
      }
      if (trackState.isCsmTrack && trackState.hasCsmOn)
        trackData.events.push({ tick: trackState.tick, cmd: "CSM_OFF", args: {}, src: se.src });
      expandTrackDelays(trackData);
      tracks.push(trackData);
    }
    seIndex++;
  }

  tracks.forEach((t, idx) => {
    t.id = idx;
    for (const ev of t.events) delete ev._voice;
  });
  warnSongWrites(tracks.filter((t) => !t.se), diagnostics, frameHz);

  for (const track of tracks) convertCountedJumps(track);
  // A (break) that no counted loop claimed does nothing — an infinite loop has
  // no final pass to exit. Drop it and say so; a score that carries one (a
  // mucom import whose `[` never closed) still plays.
  for (const track of tracks) {
    const stray = (track.events ?? []).filter(
      (ev) => ev.cmd === "LOOP_BREAK" && ev.args?.id == null,
    );
    for (const ev of stray)
      pushDiag(diagnostics, "warning", "W_BREAK_OUTSIDE_LOOP",
        "(break) is outside a counted loop — (x N …) or #label … (go label N) — and does nothing; dropped",
        ev.src ?? { line: 1, column: 1 }, track.scoreChannel ?? track.channel ?? null);
    if (stray.length) track.events = track.events.filter((ev) => !stray.includes(ev));
  }
  for (const track of tracks) validateTrack(track, diagnostics);
  // On the driver's machine, voice changes move into the silence before
  // their note (voice-hoist.js), so a voice's ~36 writes do not share the
  // note's frame on the driver's wire. A VGM target has no wire: a voice is
  // written at its note. `options.voiceHoist`: false turns it off; an
  // object sets its windows.
  if (options.voiceHoist !== false && target.driver)
    hoistVoiceChanges(tracks, { ppqn: PPQN, ...(options.voiceHoist ?? {}) });

  // Tempo and LFO rate are written on tracks (body `:tempo` / `:lfo-rate`
  // emit their own tick-0 events); the only derived init event is FM3 op mode.
  if (tracks.length > 0 && hasFm3OpTracks) {
    tracks[0].events.unshift({
      tick: 0,
      cmd: "FM3_MODE",
      args: { mode: hasCsmOps ? "csm-op" : "op" },
      src: fileSrc,
    });
  }

  // Beside fm3-1..fm3-4 the (fm3 …) track — or, in CSM, the (fm3-csm …)
  // track — is the shared patch alone: the channel's F-number is operator 4's
  // there, so a note on it would fight fm3-4 for pitch and key.
  if (tracks.some((t) => !t.se && /^fm3-[1-4]$/.test(t.scoreChannel))) {
    for (const t of tracks) {
      if (t.se || (t.scoreChannel !== "fm3" && t.scoreChannel !== "fm3-csm")) continue;
      const note = t.events.find((ev) => ev.cmd === "NOTE_ON");
      if (note)
        pushDiag(diagnostics, "error", "E_FM3_MODE_CONFLICT",
          `(${t.scoreChannel} …) beside fm3-1..fm3-4 is the shared patch only: it takes no notes` +
            (t.scoreChannel === "fm3-csm" ? " (the buzz is the fm3-csm-rate track's)" : ""),
          note.src ?? fileSrc, t.scoreChannel);
    }
  }

  // An imported def knows its own directory; a def written here depends on the
  // score's path being known.
  const sampleBaseDir = (sample) =>
    sample?.baseDir ?? dirnamePosix(normalizePathSeparators(filename));
  for (const [name, sample] of sampleDefs.entries()) {
    if (!sample?.file) continue;
    if (isAbsolutePath(sample.file)) continue;
    if (sampleBaseDir(sample)) continue;
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
      composer: fileMeta.composer ?? "",
      author: fileMeta.author ?? "",
      source: filename,
      pcmVoices,
      // The frame clock every `Nf`, macro step and sweep length in this IR was
      // resolved against (driver.md §3.3). The exporter reads it so a score can
      // never be compiled for one standard and baked for the other.
      frameHz,
      vals: [...vals.values()].map((v) => ({
        name: v.name,
        slot: v.slot,
        init: v.init,
        min: v.min,
        max: v.max,
        step: v.step,
        reversed: v.reversed,
        unit: v.unit,
        public: v.public,
      })),
      ...(target.name !== DEFAULT_TARGET_NAME ? { target: target.name } : {}),
      // The def-waves (ir.md): a PARAM_SET WAVE's value is the index.
      ...(waves.length ? { waves: waves.map((w) => ({ name: w.name, len: w.data.length, bits: WAVE.bits, data: w.data })) } : {}),
      samples: [...sampleDefs.entries()].map(([name, sample]) => ({
        name,
        ...(sample.rhythm ? { rhythm: sample.rhythm } : {}),
        file: sample.file,
        resolvedFile: sample.file ? resolveSamplePath(sample.file, sampleBaseDir(sample)) : null,
        rate: sample.rate,
        offset: sample.offset,
        frames: sample.frames,
        startSec: sample.startSec,
        endSec: sample.endSec,
        loopStartSec: sample.loopStartSec,
        loopEndSec: sample.loopEndSec,
        fx: sample.fx,
      })),
    },
    tracks,
  });

  rejectInlineStochasticSweeps(tracks, diagnostics);
  warnInlineSweepWaits(tracks, diagnostics);
  return { ir, diagnostics, sourceMap: buildSourceMap(tracks), openingBpm: scoreInitialBpm ?? 120 };
}

// A stochastic curve is data, not a formula: a macro samples it into the
// table the driver steps, but an inline sweep carries only a curve id, and the
// driver has no random source to evaluate one with — it would play a straight
// ramp while the preview plays noise (opcodes.md §8.1). So the stochastic
// curves are macro-only, and an inline one is an error rather than a sound
// that changes on export.
const STOCHASTIC_CURVE_NAMES = new Set(["noise", "pink", "perlin", "brown"]);
const INLINE_SWEEP_CMDS = new Set(["PARAM_SWEEP", "TEMPO_SWEEP", "CSM_RATE"]);
function rejectInlineStochasticSweeps(tracks, diagnostics) {
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      if (!INLINE_SWEEP_CMDS.has(ev.cmd)) continue;
      const curve = ev.args?.curve;
      if (!STOCHASTIC_CURVE_NAMES.has(curve)) continue;
      delete ev.args.holdLen; // a :hold in units only a macro's note resolves
      pushDiag(
        diagnostics,
        "error",
        "E_CURVE_MACRO_ONLY",
        `${curve} is macro-only: an inline sweep cannot carry its values, so the driver ` +
          `would play a straight ramp. Use it in a (macro …).`,
        ev.src,
        track.scoreChannel ?? track.channel,
      );
    }
  }
}

// `:wait` delays a macro's curve or a stage (§11); an inline sweep starts
// where it is written, and both players start it there whatever its :wait
// says. Warned once per written sweep (a repeat copies its events).
function warnInlineSweepWaits(tracks, diagnostics) {
  const seen = new Set();
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      if (!INLINE_SWEEP_CMDS.has(ev.cmd)) continue;
      const a = ev.args ?? {};
      if (a.waitTicks == null && a.waitFrames == null && !a.waitKeyOff) continue;
      const key = `${ev.src?.file ?? ""}:${ev.src?.line}:${ev.src?.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushDiag(diagnostics, "warning", "W_SWEEP_WAIT",
        "an inline sweep starts where it is written: its :wait is ignored " +
          "(:wait delays a curve in a (macro …) or a stage, language.md §11)",
        ev.src, track.scoreChannel ?? track.channel);
    }
  }
}
