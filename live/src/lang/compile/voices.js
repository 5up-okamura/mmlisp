// Voices and waves: a def-fm's (and the other voice defs') keywords
// resolved and emitted, a def-wave's expression folded to its steps.

import { sampleCurveUnit } from "../../ir/curves.js";
import { WAVE, waveSteps, waveCombine } from "../../ir/ranges.js";
import { makeEvalCtx, exprHasValRef, CURVE_NAMES, parseCurveSpec } from "./curves.js";
import { pushDiag, nodeSrc, atomValue, parseNumberLike } from "./diag.js";
import { expandNode } from "./expand.js";
import { canonicalTarget, VEL_SENS_TARGETS, velSensSixteenths, targetLacks, VEL_SENS_AUTO, keywordOf } from "./keywords.js";
import { evalValue, makeEnv } from "../mmlisp-eval.js";
import { fmInitVoice, FM_CHANNEL_WORDS, opWords, FM_OP_WORDS } from "../../machine/chips/fm-words.js";

// `init-fm`, the empty voice: a sine on the machine's FM part (chips/fm-words.js fmInitVoice).
export function createInitFmKwMap(target) {
  return fmInitVoice(target.parts.find((p) => p.kind === "fm"));
}

// What a voice that plays has and the machine does not: one line a voice, a
// score's first use of it saying so for all.
function voiceLacks(td, name, target, diagnostics) {
  if (td.lacksSaid || !td.lacks?.size) return;
  td.lacksSaid = true;
  const words = [...td.lacks.keys()];
  const shown = words.length > 6 ? `${words.slice(0, 6).join(" ")} and ${words.length - 6} more` : words.join(" ");
  const hints = [...new Set(words.map((w) => target.hints?.[canonicalTarget(w)]).filter(Boolean))];
  pushDiag(diagnostics, "warning", "W_TARGET",
    `'${name}' plays without ${shown}: the ${target.system} has none${hints.length ? ` — ${hints.join("; ")}` : ""}`,
    td.lacks.values().next().value, null);
}

// A def-fm voice switch: its registers as of `tick`, and the key shift its
// :key sets on the track. The track's part takes what it has of the voice
// (emitVoiceFromKwMap): a voice named on a channel with no FM (sqr1, pcm1)
// keeps only its :key there, and says so once per track and voice.
export function emitVoice(td, tick, events, src, trackState = null, name = null, diagnostics = null, trackName = null) {
  if (td.kwMap) {
    const from = events.length;
    const dropped = emitVoiceFromKwMap(td.kwMap, tick, events, src, trackState?.part, trackState?.target);
    // On a MIDI channel a voice is its program, by its name (chips/midi.js).
    const program = trackState?.part?.programOf ? trackState.part.programOf(name) : undefined;
    if (program != null) events.push({ tick, cmd: "PARAM_SET", args: { target: "PROG", value: program }, src });
    // The burst names its voice, as a note does (`_voice`): for an export
    // that follows the channel's voice as it plays (voiceStamps).
    if (name) for (let i = from; i < events.length; i++) events[i]._voiceSet = name;
    if (diagnostics && trackState?.part?.kind === "fm") voiceLacks(td, name, trackState.target, diagnostics);
    const said = trackState ? (trackState.voicesSaid ??= new Set()) : null;
    if (trackState?.part?.programOf && program == null && said && diagnostics && !said.has(name)) {
      said.add(name);
      pushDiag(diagnostics, "warning", "W_TARGET",
        `'${name}' names no GM instrument; ${trackState.head} (${trackState.part.label}) plays it as the output's sound — write :prog N`,
        src, trackName);
    } else if (dropped && program == null && said && diagnostics && !said.has(name)) {
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
export function resolveWaves(waveDefs, typedDefs, defs, paramDefs, diagnostics) {
  const read = new Map(); // name → steps, null when its def does not read
  const reading = new Set();
  const dataOf = (name, at) => {
    const td = waveDefs.get(name);
    if (!td) {
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
        if (!WAVE.lens.includes(vals.length)) { err(`:wave takes ${WAVE_LEN} values (or 64, the FDS's memory), not ${vals.length}`, nodeSrc(at)); continue; }
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
  for (const name of waveDefs.keys()) {
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
// shared ir/ranges.js waveCombine); the rest is left as the tree the IR player
// runs. Returns { n } | { data } | { tree }, or null after a diagnostic.
const WAVE_OPS = new Set(["+", "-", "*", "/"]);
export function waveExpr(node, { waveOf, vals = null, runtime = false, diagnostics, trackName }) {
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
export function waveIndexOf(waves, name, data) {
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
export function emitWave(trackState, events, src, name, diagnostics, trackName) {
  const index = trackState.waves?.index.get(name);
  if (index == null) return; // its def did not read
  const { part, head } = trackState;
  if (part?.words("WAVE")) {
    trackState.editWaveName = name;
    warnWaveLen(trackState, name, trackState.waves[index].data, src, diagnostics, trackName);
    events.push({ tick: trackState.tick, cmd: "PARAM_SET", args: { target: "WAVE", value: index }, src });
    return;
  }
  const said = (trackState.voicesSaid ??= new Set());
  if (said.has(name)) return;
  said.add(name);
  pushDiag(diagnostics, "warning", "W_TARGET",
    `'${name}' is a wave; ${head} (${part?.label ?? "this channel"}) has no wave memory, so it is left out`, src, trackName);
}

// A wave longer than the channel's memory (64 steps on a 32-step chip): every
// other step plays (ir-player _writeLaneWave), said once per track and wave.
export function warnWaveLen(trackState, name, data, src, diagnostics, trackName) {
  const { part, head } = trackState;
  const len = part?.waveLen ?? WAVE.len;
  if (!data || data.length <= len) return;
  const said = (trackState.wavesCut ??= new Set());
  if (said.has(name)) return;
  said.add(name);
  pushDiag(diagnostics, "warning", "W_TARGET",
    `'${name}' is ${data.length} steps; ${head} (${part?.label ?? "this channel"}) has ${len}, so every ${data.length / len === 2 ? "other" : `${data.length / len}th`} step plays`, src, trackName);
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
export function resolveVoices(typedDefs, defs, paramDefs, diagnostics, velSens = false, machine = null) {
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
    const lacks = new Map(typedDefs.get(td.extends)?.lacks); // word → where it is written
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
        // Said only where it would have sounded — `:ssg1 0` is no difference —
        // and only of a voice that plays (voiceLacks): an imported bank is
        // mostly names the score never reaches.
        if (machine && targetLacks(target, kw, machine)) {
          if (Math.round(v.value) !== 0) lacks.set(kw, nodeSrc(td.items[k]));
          else lacks.delete(kw);
        }
      }
      else if (v || expanded.length !== 1 || exprHasValRef(expanded[0]))
        err("E_VOICE_VALUE", `${kw} takes a number — a voice is fixed data`,
          nodeSrc(td.items[k + 1]));
    }
    td.kwMap = kwMap;
    td.lacks = lacks;
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
