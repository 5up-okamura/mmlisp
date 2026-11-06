// ---------------------------------------------------------------------------
// MIDI export (File > Export > MIDI…)
//
// The score's portable core as a Standard MIDI File, on every target: what
// a note, a level, a pan and a pitch are, read off the IR at its own
// resolution (format 1, 96 ticks a quarter, the IR's). A machine's own words
// — an FM operator, a duty, a wave, a noise mode, the SSG's envelope — have
// no MIDI reading and are left out, said once in `notes`.
//
//   NOTE_ON / PCM_NOTE_ON  a note on, off at its gate (ties summed); a hold
//                          (gate 0) off at the next note or the song's end;
//                          a slur's note on before the note it leaves goes off
//   :keyon                 an off and an on at each retrigger
//   :vel 0-15              the velocity, its 2 dB steps read as dB
//   :vol + :master         CC7, the two faders' dB summed (0 is silence); a
//                          note's vol macro in :vol's place to the next note
//   a note's vel macro     CC11, below the note's velocity (its peak)
//   :pitch, glide, the pitch and :semi macros  pitch bend, its range (RPN 0)
//                          the least of 2 / 12 / 24 the track needs
//   :snap                  applied to the note before it is written
//   :pan, the pan macro    CC10
//   :tempo, its sweeps     tempo, the sweep a step a frame as the driver's
//   (x N …), (go …)        written out; a song that loops plays once through
//                          its loop (the tracks' loops to their common
//                          length, as the VGM), marked loopStart / loopEnd;
//                          the loop point's writes kept though they repeat,
//                          the loop's first note's bend and levels again
//   #label, (trig N)       a marker, a cue point
//   a gm-* voice           a program change, the voice the channel plays
//                          (a voice change's `_voiceSet`): the gm set is GM's 128 in order;
//                          a role's (piano, flute …) and a ROM voice's name
//                          is the gm voice it stands for (NAMED_VOICES)
//   a kit role's sample    channel 10, at the role's GM note (import-sf2.js);
//                          the track's faders go into the velocity there
//
// The values a score's def-vals hold are their inits and what the score
// writes to them: nothing plays the file to move them. A def-se's parts are
// not in the file (the VGM's rule). A track takes a channel of its own in
// score order, 10 kept for the drums; past fifteen the next port's (meta
// 0x21).
//
// The voice a note plays is not in the IR: compileMMLisp keeps it on each
// NOTE_ON as `_voice` under `voiceStamps: true` (ir.md §5.1), which this
// export compiles with; without it no program change is written.
// ---------------------------------------------------------------------------

import {
  pitchToMidi, snapNote, expandLoops, sampleCurveUnit, clampForTarget,
  VEL_DB_PER_STEP, VOL_STEP_DB, VOL_UNITY, FRAME_HZ_NTSC,
} from "./ir-utils.js";
import { KIT_ROLES } from "./import-sf2.js";

const PPQN = 96;
const DRUM_CH = 9;
const BEND_RANGES = [2, 12, 24];
// Tracks that loop are written out to a common length, the LCM of their loops;
// past this many bars the longest loop's length stands (said in `notes`).
const LCM_CAP_TICKS = PPQN * 4 * 1024;

/** The GM programs, in order: the gm preset set's voices (presets/gm). */
export const GM_PROGRAMS = [
  "gm-piano", "gm-piano-bright", "gm-piano-e-grand", "gm-honkytonk", "gm-ep1", "gm-ep2", "gm-harpsi", "gm-clav",
  "gm-celesta", "gm-glock", "gm-musicbox", "gm-vibes", "gm-marimba", "gm-xylo", "gm-tubular", "gm-dulcimer",
  "gm-organ-drawbar", "gm-organ-perc", "gm-organ-rock", "gm-organ-church", "gm-organ-reed", "gm-accordion", "gm-harmonica", "gm-bandoneon",
  "gm-guitar-nylon", "gm-guitar-steel", "gm-guitar-jazz", "gm-guitar-clean", "gm-guitar-mute", "gm-guitar-od", "gm-guitar-dist", "gm-guitar-harm",
  "gm-bass-acoustic", "gm-bass-finger", "gm-bass-pick", "gm-bass-fretless", "gm-bass-slap1", "gm-bass-slap2", "gm-bass-syn1", "gm-bass-syn2",
  "gm-violin", "gm-viola", "gm-cello", "gm-contrabass", "gm-str-trem", "gm-str-pizz", "gm-harp", "gm-timpani",
  "gm-strings1", "gm-strings2", "gm-synstr1", "gm-synstr2", "gm-choir", "gm-voice-ooh", "gm-synvox", "gm-orch-hit",
  "gm-trumpet", "gm-trombone", "gm-tuba", "gm-trumpet-mute", "gm-horn", "gm-brass", "gm-synbrass1", "gm-synbrass2",
  "gm-sax-soprano", "gm-sax-alto", "gm-sax-tenor", "gm-sax-bari", "gm-oboe", "gm-english-horn", "gm-bassoon", "gm-clarinet",
  "gm-piccolo", "gm-flute", "gm-recorder", "gm-panflute", "gm-bottle", "gm-shakuhachi", "gm-whistle", "gm-ocarina",
  "gm-lead-square", "gm-lead-saw", "gm-lead-calliope", "gm-lead-chiff", "gm-lead-charang", "gm-lead-voice", "gm-lead-fifths", "gm-lead-basslead",
  "gm-pad-newage", "gm-pad-warm", "gm-pad-poly", "gm-pad-choir", "gm-pad-bowed", "gm-pad-metal", "gm-pad-halo", "gm-pad-sweep",
  "gm-fx-rain", "gm-fx-soundtrack", "gm-fx-crystal", "gm-fx-atmos", "gm-fx-bright", "gm-fx-goblins", "gm-fx-echoes", "gm-fx-scifi",
  "gm-sitar", "gm-banjo", "gm-shamisen", "gm-koto", "gm-kalimba", "gm-bagpipe", "gm-fiddle", "gm-shanai",
  "gm-tinkle", "gm-agogo", "gm-steeldrum", "gm-woodblock", "gm-taiko", "gm-tom-melodic", "gm-syndrum", "gm-revcymbal",
  "gm-fretnoise", "gm-breath", "gm-seashore", "gm-bird", "gm-phone", "gm-heli", "gm-applause", "gm-gunshot",
];
/**
 * The voices named for an instrument, as the gm voice they stand for: the
 * fifteen melodic roles (presets/fm-roles, each its gm voice's copy, and the
 * OPLL's ROM names — the FM-PAC's and the VRC7's built in, a 4-op reading
 * elsewhere), and the VRC7's own ROM names.
 */
export const NAMED_VOICES = {
  piano: "gm-piano", harpsichord: "gm-harpsi", vibraphone: "gm-vibes", organ: "gm-organ-drawbar",
  guitar: "gm-guitar-nylon", "electric-guitar": "gm-guitar-clean", "acoustic-bass": "gm-bass-acoustic",
  "synth-bass": "gm-bass-syn1", violin: "gm-violin", trumpet: "gm-trumpet", horn: "gm-horn",
  oboe: "gm-oboe", clarinet: "gm-clarinet", flute: "gm-flute", synth: "gm-lead-saw",
  // The VRC7's ROM beside those (chips/vrc7.js VRC7_ROM_NAMES).
  "buzzy-bell": "gm-glock", wurly: "gm-ep1", bells: "gm-tubular", vibes: "gm-vibes",
  tutti: "gm-strings1", fretless: "gm-bass-fretless", sweep: "gm-pad-sweep",
};
const GM_PROGRAM_OF = new Map(GM_PROGRAMS.map((name, i) => [name, i]));
/** The GM program a voice named `name` is, or undefined. */
export const programOf = (name) => GM_PROGRAM_OF.get(NAMED_VOICES[name] ?? name);
/** A kit role → its GM drum note (the inverse of import-sf2.js's table). */
export const GM_DRUM_NOTE = Object.fromEntries(Object.entries(KIT_ROLES).map(([note, role]) => [role, Number(note)]));

// The words this export reads; any other write is a machine's own.
const READ_TARGETS = new Set(["VOL", "MASTER", "PAN", "NOTE_PITCH", "SNAP"]);
const READ_NOTE_ARGS = new Set([
  "pitch", "length", "gate", "vel", "legato", "fm3Op", "opMask", "sample", "rate", "mode", "baseRate",
  "pitchMacro", "velMacro", "note_semi", "keyon", "pan", "vol",
]);
const STRUCTURE = new Set(["NOTE_ON", "PCM_NOTE_ON", "PCM_NOTE_OFF", "REST", "TIE", "MARKER", "JUMP", "TRIG", "TEMPO_SET", "TEMPO_SWEEP"]);
const PARAM_CMDS = new Set(["PARAM_SET", "PARAM_ADD", "PARAM_MUL", "PARAM_FROM_VAL", "PARAM_SWEEP", "PARAM_SWEEP_STOP"]);

// ── Levels ─────────────────────────────────────────────────────────────
const velDb = (v) => (Math.max(0, Math.min(15, v)) - 15) * VEL_DB_PER_STEP;
const faderDb = (v) => (v <= 0 ? -Infinity : (Math.min(VOL_UNITY, v) - VOL_UNITY) * VOL_STEP_DB);
// dB → a 7-bit level, as GM reads one: gain ∝ (value / 127)².
const level7 = (db) => (db === -Infinity ? 0 : Math.max(0, Math.min(127, Math.round(127 * 10 ** (db / 40)))));
const pan7 = (p) => Math.max(0, Math.min(127, Math.round(p < 0 ? 64 + p * 64 : 64 + p * 63)));

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;

// The macro scale (ir.md §6): (sample × (slot & 0xFF)) >> 8, by magnitude.
function scaleSample(sample, slot) {
  const mag = (Math.abs(Math.round(sample)) * ((slot & 0xff) >>> 0)) >> 8;
  return sample < 0 ? -mag : mag;
}

// ── One track's events, played once through (ir-player _flattenTracks) ──
function flatten(track) {
  const events = expandLoops(track.events ?? []).sort((a, b) => a.tick - b.tick);
  const markers = new Map();
  for (const e of events) if (e.cmd === "MARKER" && e.args?.id) markers.set(e.args.id, e.tick);
  // The backward JUMP that goes furthest back is the track's loop.
  let jumpTick = -1, to = null, best = Infinity;
  for (const e of events) {
    if (e.cmd !== "JUMP") continue;
    const target = markers.get(e.args?.to) ?? -1;
    if (target >= 0 && target <= e.tick && target < best) [best, jumpTick, to] = [target, e.tick, e.args.to];
  }
  const trimmed = jumpTick >= 0 ? events.filter((e) => e.tick <= jumpTick && e.cmd !== "JUMP") : events.filter((e) => e.cmd !== "JUMP");
  const endTick = trimmed.reduce((m, e) => Math.max(m, e.tick + (Number(e.args?.length) || 0)), 0);
  if (jumpTick < 0) return { events: trimmed, hasLoop: false, endTick };
  const loopStartTick = best;
  // The loop resumes AT the label: what is written before it on its tick ran once.
  // A label inside a counted loop is written out once a pass: the loop's is
  // the copy at loopStartTick, the last (markers keeps the last).
  let loopStartIndex = trimmed.findIndex((e) => e.tick > loopStartTick || (e.cmd === "MARKER" && e.args?.id === to && e.tick === loopStartTick));
  if (loopStartIndex < 0) loopStartIndex = trimmed.length;
  return { events: trimmed, hasLoop: true, loopStartTick, loopStartIndex, loopDuration: Math.max(1, jumpTick - loopStartTick), endTick };
}

// A looping track's passes, up to `endTick`; each event knows its pass.
function unroll(f, endTick) {
  const out = f.events.map((e) => ({ ...e, _pass: 0 }));
  if (!f.hasLoop) return out;
  // (stable: a pass's events at its last tick stay ahead of the next pass's)
  const body = f.events.slice(f.loopStartIndex);
  for (let k = 1; f.loopStartTick + k * f.loopDuration < endTick; k++) {
    const shift = k * f.loopDuration;
    for (const e of body) if (e.tick + shift < endTick) out.push({ ...e, tick: e.tick + shift, _pass: k });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

// ── The tempo map ───────────────────────────────────────────────────────
// Points { tick, bpm }, each holding to the next; a sweep a point a frame.
function tempoMap(allEvents, frameHz, loopStart = null) {
  const evs = allEvents.filter((e) => e.cmd === "TEMPO_SET" || e.cmd === "TEMPO_SWEEP").sort((a, b) => a.tick - b.tick);
  const opening = evs.find((e) => e.tick === 0 && e.cmd === "TEMPO_SET")?.args?.bpm ?? 120;
  let pts = [{ tick: 0, bpm: opening }];
  for (const e of evs) {
    pts = pts.filter((p) => p.tick < e.tick); // a set cancels what was ahead of it
    if (e.cmd === "TEMPO_SET") {
      const bpm = Number(e.args?.bpm);
      if (bpm > 0) pts.push({ tick: e.tick, bpm, forced: e.tick === loopStart });
      continue;
    }
    const { from, to, len, curve = "linear", params } = e.args ?? {};
    if (!(from > 0) || !(to > 0) || !(len > 0)) continue;
    // The length as frames at the average tempo, as the driver counts it.
    const frames = Math.max(1, Math.round((len * 60 * frameHz) / (((from + to) / 2) * PPQN)));
    let t = e.tick;
    for (let i = 0; i < frames && t < e.tick + len; i++) {
      const bpm = from + (to - from) * sampleCurveUnit(curve, frames <= 1 ? 1 : i / (frames - 1), params);
      pts.push({ tick: t, bpm, forced: i === 0 && e.tick === loopStart });
      t += (bpm * PPQN) / 60 / frameHz;
    }
    pts.push({ tick: e.tick + len, bpm: to });
  }
  if (!pts.length || pts[0].tick > 0) pts.unshift({ tick: 0, bpm: opening });
  // Same tick: the last write stands.
  const merged = [];
  for (const p of pts) {
    if (merged.length && Math.abs(merged.at(-1).tick - p.tick) < 1e-9) merged[merged.length - 1] = { ...p, forced: p.forced || merged.at(-1).forced };
    else merged.push(p);
  }
  let sec = 0;
  for (let i = 0; i < merged.length; i++) {
    merged[i].sec = sec;
    const next = merged[i + 1];
    if (next) sec += ((next.tick - merged[i].tick) * 60) / (merged[i].bpm * PPQN);
  }
  const segAtTick = (tick) => {
    let lo = 0, hi = merged.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (merged[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return merged[lo];
  };
  const segAtSec = (s) => {
    let lo = 0, hi = merged.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (merged[mid].sec <= s) lo = mid;
      else hi = mid - 1;
    }
    return merged[lo];
  };
  return {
    points: merged,
    secAt: (tick) => { const p = segAtTick(tick); return p.sec + ((tick - p.tick) * 60) / (p.bpm * PPQN); },
    tickAt: (s) => { const p = segAtSec(s); return p.tick + ((s - p.sec) * p.bpm * PPQN) / 60; },
  };
}

// ── A parameter over time ───────────────────────────────────────────────
// [tick, value, forced] points, each holding to the next, from a target's
// writes in tick order (ir.md §5.6–5.10): a set, an add or a multiply on the
// value it holds, a slot read, a sweep a frame until the next write on the
// target. A write at the song's loop point is `forced`: kept though it
// repeats the value, for it is what a pass after the first starts from.
function paramLine(events, target, init, ctx, endTick) {
  const pts = [[0, init, false]];
  let cur = init;
  let sweep = null;
  const put = (tick, v, forced = false) => {
    v = clampForTarget(target, v);
    cur = v;
    if (pts.length && Math.abs(pts.at(-1)[0] - tick) < 1e-9) pts[pts.length - 1] = [tick, v, forced || pts.at(-1)[2]];
    else if (forced || pts.at(-1)[1] !== v) pts.push([tick, v, forced]);
  };
  // A sweep's frames before `until`.
  const run = (until) => {
    if (!sweep) return;
    const { sec0, n, loop, from, to, curve, params } = sweep;
    for (; ; sweep.f++) {
      const f = sweep.f;
      if (!loop && f >= n) { sweep = null; return; }
      const t = ctx.tickAt(sec0 + f / ctx.frameHz);
      if (t >= until - 1e-9) return;
      const phase = loop ? (f % n) / n : n <= 1 ? 1 : Math.min(1, f / (n - 1));
      put(t, from + (to - from) * sampleCurveUnit(curve, phase, params));
    }
  };
  for (const e of events) {
    run(e.tick);
    sweep = null;
    const a = e.args ?? {};
    const operand = (o) => (typeof o === "object" && o ? ctx.slotAt(o.src, e.tick) : Number(o));
    const forced = e.tick === ctx.loopStart;
    if (e.cmd === "PARAM_SET") put(e.tick, Number(a.value), forced);
    else if (e.cmd === "PARAM_ADD") put(e.tick, cur + operand(a.delta), forced);
    else if (e.cmd === "PARAM_MUL") {
      const f = typeof a.factor === "object" ? operand(a.factor) : Math.round(Number(a.factor) * 256);
      put(e.tick, Math.floor((cur * f) / 256), forced);
    } else if (e.cmd === "PARAM_FROM_VAL") put(e.tick, ctx.slotAt(a.src, e.tick), forced);
    else if (e.cmd === "PARAM_SWEEP") {
      const dyn = a.dyn ?? {};
      const from = dyn.from != null ? ctx.slotAt(dyn.from, e.tick) : a.from ?? cur;
      const to = dyn.to != null ? ctx.slotAt(dyn.to, e.tick) : a.to ?? 0;
      const params = dyn.rate != null ? { ...a.params, rate: ctx.slotAt(dyn.rate, e.tick) } : a.params;
      const sec0 = ctx.secAt(e.tick);
      const n = dyn.len != null
        ? ctx.lenFromSlot(dyn.len, e.tick)
        : a.lenFrames
          ? Math.max(1, Math.round(Number(a.frames ?? 1)))
          : Math.max(1, Math.round((ctx.secAt(e.tick + Number(a.frames ?? 1)) - sec0) * ctx.frameHz));
      sweep = { sec0, n, f: 0, loop: !!a.loop && !a.bounded, from, to, curve: a.curve ?? "linear", params };
    }
    // PARAM_SWEEP_STOP: frozen where it is.
  }
  run(endTick);
  return pts;
}

// The points of a line in (a, b).
function pointsIn(pts, a, b) {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= a) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < pts.length && pts[i][0] < b; i++) out.push(pts[i]);
  return out;
}

// The value a line holds at `tick`.
function lineAt(pts, tick) {
  let lo = 0, hi = pts.length - 1;
  if (tick < pts[0][0]) return pts[0][1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid][0] <= tick + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo][1];
}

// ── A note's macro (ir.md §6) as [tick, value] writes ─────────────────────
// The note sounds from `on`, keys off at `off` (Infinity: held) and gives way
// at `limit`, the next note's on (ir-player _scheduleMacroImpl).
function macroWrites(spec, note, ctx) {
  if (!spec) return null;
  const out = [];
  const tickClock = spec.step?.unit === "tick";
  const stepUnits = Math.max(1, Math.round(Number(spec.step?.value ?? 1)));
  const adv = (t, u) => (tickClock ? t + u : ctx.tickAt(ctx.secAt(t) + u / ctx.frameHz));
  const units = (a, b) => (b === Infinity ? Infinity : tickClock ? b - a : (ctx.secAt(b) - ctx.secAt(a)) * ctx.frameHz);
  const { on, off } = note;
  const cap = Math.min(note.limit, ctx.endTick);
  const write = (v, t) => {
    if (t >= cap - 1e-9 || v == null) return;
    out.push([t, spec.scale != null ? scaleSample(v, ctx.slotAt(spec.scale, t)) : v]);
  };
  const fields = (o) => {
    const dyn = o.dyn ?? {};
    return {
      from: dyn.from != null ? ctx.slotAt(dyn.from, on) : o.from,
      to: dyn.to != null ? ctx.slotAt(dyn.to, on) : o.to ?? 0,
      params: dyn.rate != null ? { ...o.params, rate: ctx.slotAt(dyn.rate, on) } : o.params,
    };
  };
  const lenUnits = (o) => {
    if (o.dyn?.len != null) {
      const frames = ctx.lenFromSlot(o.dyn.len, on);
      return tickClock ? Math.max(1, Math.round(frames * (PPQN * ctx.bpmAt(on)) / 60 / ctx.frameHz)) : frames;
    }
    const raw = Math.max(1, Math.round(Number(o.frames ?? 1)));
    return tickClock || o.lenFrames ? raw : Math.max(1, Math.round(units(on, on + raw)));
  };
  const phaseOf = (loop, f, n) => (loop ? (f % n) / n : n <= 1 ? 1 : Math.min(1, f / (n - 1)));

  if (spec.type === "steps") {
    const { steps = [], loopIndex = null, releaseIndex = null } = spec;
    const sustainEnd = releaseIndex ?? steps.length;
    let t = on, idx = 0;
    while (sustainEnd > 0 && t < Math.min(off, cap) - 1e-9) {
      write(steps[idx], t);
      if (++idx >= sustainEnd) {
        if (loopIndex == null) break;
        idx = loopIndex;
      }
      t = adv(t, stepUnits);
    }
    if (releaseIndex != null && off !== Infinity)
      for (let ri = releaseIndex, rt = off; ri < steps.length; ri++, rt = adv(rt, stepUnits)) write(steps[ri], rt);
    return out;
  }

  if (spec.type === "curve") {
    const { loop = false, curve = "linear", waitTicks = null, waitFrames = null, waitKeyOff = false } = spec;
    const { from = 0, to, params } = fields(spec);
    const n = lenUnits(spec);
    if (waitKeyOff && off === Infinity) return out;
    const wait = tickClock ? Number(waitTicks ?? 0) : waitFrames != null ? Number(waitFrames) : waitTicks ? units(on, on + Number(waitTicks)) : 0;
    const start = waitKeyOff ? off : adv(on, Math.max(0, Math.round(wait)));
    const remaining = waitKeyOff ? n : units(start, Math.min(off, cap));
    const active = waitKeyOff ? n : loop ? remaining : Math.min(remaining, n);
    for (let f = 0; f < active; f += stepUnits) {
      const t = adv(start, f);
      if (t >= cap) break;
      write(from + (to - from) * sampleCurveUnit(curve, phaseOf(loop, f, n), params), t);
    }
    return out;
  }

  if (spec.type === "stages") {
    const stages = spec.stages ?? [];
    // The release: the first (wait key-off), else the first curve after a loop.
    let rel = stages.length;
    for (let i = 0, afterLoop = false; i < stages.length; i++) {
      if (stages[i].waitKeyOff || (stages[i].curve && afterLoop)) { rel = i; break; }
      if (stages[i].curve && stages[i].loop) afterLoop = true;
    }
    let t = on, last = null;
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const keyed = i < rel;
      if (i === rel) {
        if (off === Infinity) break;
        t = off;
      }
      if (st.waitKeyOff) {
        if (off === Infinity) break;
        t = Math.max(t, off);
      } else if (st.waitTicks != null) t += Math.max(0, Number(st.waitTicks));
      else if (st.waitFrames != null) t = ctx.tickAt(ctx.secAt(t) + Number(st.waitFrames) / ctx.frameHz);
      if (keyed && t >= off - 1e-9) { i = rel - 1; continue; }
      if (!st.curve) continue;
      const { from, to, params } = fields(st);
      const start = st.fromNow ? last ?? to : from ?? 0;
      const one = st.fromNow;
      const share = (u) => (one ? 1 - Math.max(0, Math.min(one - 1, Math.round((1 - u) * one))) / one : u);
      const n = lenUnits(st);
      const untilOff = off === Infinity ? Infinity : Math.max(0, Math.ceil(units(t, off)) + stepUnits);
      const budget = !keyed
        ? st.loop ? 0 : n
        : st.loop ? (untilOff === Infinity ? Math.floor(units(t, cap)) : untilOff) : Math.min(n, untilOff);
      let cut = false;
      for (let f = 0; f < budget; f += stepUnits) {
        const at = adv(t, f);
        if (keyed && at >= off - 1e-9) { cut = true; break; }
        if (at >= cap) break;
        const v = start + (to - start) * share(sampleCurveUnit(st.curve, phaseOf(st.loop, f, n), params));
        if (keyed) last = v;
        write(v, at);
      }
      t = cut ? off : adv(t, budget);
      if (keyed && (cut || t >= off - 1e-9)) i = rel - 1;
    }
    return out;
  }
  return out;
}

// The latest write of `writes` at or before a tick, or undefined, read at
// ticks that only move forward: one pass over the writes, however long.
function cursor(writes) {
  let i = -1;
  return (tick) => {
    while (writes && i + 1 < writes.length && writes[i + 1][0] <= tick + 1e-9) i++;
    return i >= 0 ? writes[i][1] : undefined;
  };
}

const macroPeak = (writes, fallback) => {
  let peak = -Infinity;
  for (const [, v] of writes ?? []) if (Number.isFinite(v) && v > peak) peak = v;
  return peak === -Infinity ? fallback : peak;
};
const sortedTicks = (ticks) => [...new Set(ticks)].sort((x, y) => x - y);

// ── One track's MIDI events ───────────────────────────────────────────────
// { tick, order, bytes }: at one tick an off goes first, then metas, then
// controllers, then ons; a slur's off after the on it gives way to.
const ORDER = { off: 0, meta: 1, ctrl: 2, on: 3, legatoOff: 4 };

function trackEvents(events, ctx, chan, drums, notes) {
  const out = [];
  const st = (status) => status | chan;
  const ctrl = (tick, cc, v) => out.push({ tick, order: ORDER.ctrl, bytes: [st(0xb0), cc, v] });
  const line = (target, init) => paramLine(events.filter((e) => PARAM_CMDS.has(e.cmd) && e.args?.target === target), target, init, ctx, ctx.endTick);
  const vol = line("VOL", VOL_UNITY), pan = line("PAN", 0), pitch = line("NOTE_PITCH", 0), snap = line("SNAP", 0);
  const master = ctx.master;

  // The notes: their spans, ties summed, a hold to the next note; the voice
  // each plays as the channel plays it — the last voice change before it
  // (`_voiceSet`), which a jump back does not undo — or, on a track that
  // writes no voice (a voice named on a channel with no FM), the note's own.
  const followsVoices = events.some((e) => e._voiceSet);
  const idx = events.flatMap((e, i) => (e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON" ? [i] : []));
  const list = [];
  let voiceNow = null, voiceAt = -Infinity, vi = 0;
  for (let k = 0; k < idx.length; k++) {
    const ev = events[idx[k]];
    for (; vi < idx[k]; vi++) if (events[vi]._voiceSet) [voiceNow, voiceAt] = [events[vi]._voiceSet, events[vi].tick];
    const a = ev.args ?? {};
    let length = Number(a.length) || 0;
    for (let i = idx[k] + 1, at = ev.tick + length; i < events.length && events[i].tick <= at; i++)
      if (events[i].tick === at && events[i].cmd === "TIE") { length += events[i].args?.length ?? 0; at += events[i].args?.length ?? 0; }
    const gate = a.gate != null ? Math.min(a.gate, length) : length;
    const nextOn = k + 1 < idx.length ? events[idx[k + 1]].tick : Infinity;
    const held = length === 0 || gate === 0;
    const off = held ? Infinity : ev.tick + gate;
    const end = Math.min(held ? Infinity : off, nextOn, ctx.endTick);
    if (end <= ev.tick) continue;
    const key = drums ? GM_DRUM_NOTE[a.sample] : snapNote(pitchToMidi(a.pitch ?? "c4"), lineAt(snap, ev.tick) | 0);
    if (key == null) continue;
    list.push({
      ev, a, on: ev.tick, off, end, limit: nextOn, key: Math.max(0, Math.min(127, key)), base: pitchToMidi(a.pitch ?? "c4"),
      voice: followsVoices ? voiceNow : ev._voice, voiceAt,
    });
  }
  for (const n of list) {
    n.velW = macroWrites(n.a.velMacro, n, ctx);
    n.volW = macroWrites(n.a.vol, n, ctx);
    n.panW = macroWrites(n.a.pan, n, ctx);
  }
  for (const v of new Set(list.map((n) => n.voice)))
    if (v && v !== "init-fm" && !drums && programOf(v) == null) ctx.unnamed.add(v);

  // The pitch bend each note needs, in cents from its key, and the range.
  let need = 0;
  if (!drums) for (const n of list) {
    const pm = macroWrites(n.a.pitchMacro, n, ctx);
    const sm = macroWrites(n.a.note_semi, n, ctx);
    const pAt = cursor(pm), sAt = cursor(sm);
    const mask = lineAt(snap, n.on) | 0;
    const ticks = sortedTicks([n.on, ...pointsIn(pitch, n.on, n.end).map(([t]) => t),
      ...[...(pm ?? []), ...(sm ?? [])].map(([t]) => t).filter((t) => t >= n.on && t < n.end)]);
    n.bend = ticks.map((t) => {
      const p = pAt(t), sv = sAt(t);
      const sticky = lineAt(pitch, t);
      const cents = p != null ? (n.a.pitchMacro.add ? sticky : 0) + p : sv != null && !n.a.note_semi.add ? 0 : sticky;
      const c = (snapNote(n.base + Math.round(sv ?? 0), mask) - n.key) * 100 + cents;
      need = Math.max(need, Math.abs(c) / 100);
      return [t, c];
    });
  }
  const range = need > 1e-9 ? BEND_RANGES.find((r) => r >= need - 1e-9) ?? BEND_RANGES.at(-1) : 0;
  if (need > BEND_RANGES.at(-1) + 1e-9) ctx.note(`a pitch past ±${BEND_RANGES.at(-1)} semitones is held there`);
  if (range) for (const [cc, v] of [[101, 0], [100, 0], [6, range], [38, 0], [101, 127], [100, 127]]) ctrl(0, cc, v);

  // The loop's first note: a player looping between the marks comes back to
  // it from the end, so what a note decides for itself (its bend, its
  // macros' levels and pan) is written there again, and so is what the
  // score writes at the loop point (paramLine's `forced`).
  const firstInLoop = ctx.loopStart == null ? null : list.find((n) => n.on >= ctx.loopStart) ?? null;
  const anyVolMacro = list.some((n) => n.volW?.length);
  const usesPan = !drums && (pan.length > 1 || pan[0][1] !== 0 || list.some((n) => n.panW?.length));
  // The forced points are the loop point's few: gathered once, not searched.
  const forced = new Map([vol, pan, master].map((pts) => [pts, pts.filter(([, , f]) => f).map(([t]) => t)]));
  const forcedIn = (pts, a, b) => forced.get(pts).some((t) => t >= a && t <= b);

  // Each note's window, from its on to the next note's (before the first,
  // the track's head): CC7 the faders — or the note's vol macro, which takes
  // the fader's place until the next note (ir-player _fmLiveVolAt) — and
  // CC10 the pan or the note's pan macro.
  let cc7 = null, cc10 = null, cc11 = 127, bendNow = 8192, program = null;
  const head = { on: 0, limit: list[0]?.on ?? ctx.endTick, head: true };
  const windows = head.limit > 0 ? [head, ...list] : list;
  for (const n of windows) {
    const { on } = n;
    const limit = Math.min(n.limit ?? ctx.endTick, ctx.endTick);
    const again = n === firstInLoop;
    if (!drums) {
      const volAt = cursor(n.volW), panAt = cursor(n.panW);
      const t7 = sortedTicks([on, ...pointsIn(vol, on, limit).map(([t]) => t), ...pointsIn(master, on, limit).map(([t]) => t),
        ...(n.volW ?? []).map(([t]) => t)]);
      for (const t of t7) {
        const v = level7(faderDb(volAt(t) ?? lineAt(vol, t)) + faderDb(lineAt(master, t)));
        const force = (t === on && again && (n.volW?.length || anyVolMacro || forcedIn(vol, ctx.loopStart, on) || forcedIn(master, ctx.loopStart, on)))
          || (t !== on && (forcedIn(vol, t, t) || forcedIn(master, t, t)));
        if (v !== cc7 || force) ctrl(t, 7, (cc7 = v));
      }
      if (usesPan) {
        const t10 = sortedTicks([on, ...pointsIn(pan, on, limit).map(([t]) => t), ...(n.panW ?? []).map(([t]) => t)]);
        for (const t of t10) {
          const v = pan7(panAt(t) ?? lineAt(pan, t));
          const force = (t === on && again && (n.panW?.length || forcedIn(pan, ctx.loopStart, on))) || (t !== on && forcedIn(pan, t, t));
          if (v !== cc10 || force) ctrl(t, 10, (cc10 = v));
        }
      }
    }
    if (n.head) continue;

    const { a } = n;
    const vel = n.velW?.length ? macroPeak(n.velW, a.vel ?? 15) : a.vel ?? 15;
    let velocity;
    if (drums) {
      const fader = n.volW?.length ? n.volW[0][1] : lineAt(vol, on);
      velocity = level7(velDb(vel) + faderDb(fader) + faderDb(lineAt(master, on)));
      if (!velocity) continue;
    } else velocity = Math.max(1, level7(velDb(vel)));

    if (!drums) {
      // The voice: a gm-* one, a role or a ROM voice is its program; at the
      // loop's first note again when a voice change starts the loop.
      const prog = programOf(n.voice);
      if (prog != null && (prog !== program || (again && n.voiceAt >= ctx.loopStart)))
        out.push({ tick: on, order: ORDER.ctrl, bytes: [st(0xc0), (program = prog)] });
      // CC11: the note's vel macro, below its peak (the note's velocity).
      const velAt = cursor(n.velW);
      for (const t of sortedTicks([on, ...(n.velW ?? []).map(([t]) => t)])) {
        const vw = velAt(t);
        const v = level7(Math.min(0, vw != null ? velDb(vw) - velDb(vel) : 0));
        if (v !== cc11 || (t === on && again)) ctrl(t, 11, (cc11 = v));
      }
      // The bend.
      for (const [t, c] of n.bend) {
        const v = Math.max(0, Math.min(16383, 8192 + Math.round((Math.max(-range, Math.min(range, c / 100)) / (range || 1)) * 8192)));
        if (v !== bendNow || (t === on && again && range)) out.push({ tick: t, order: ORDER.ctrl, bytes: [st(0xe0), v & 0x7f, v >> 7] });
        bendNow = v;
      }
    }

    // The keys: a slur moves the key it holds; a :keyon retriggers it, on
    // whole ticks (a frame is less than one under 37.5 bpm).
    const prev = notes.at(-1);
    if (a.legato && prev && prev.open && prev.off === on) {
      if (prev.key === n.key) {
        prev.extend(n.end);
        if (n.end < n.limit) prev.open = false;
        continue;
      }
      prev.extend(on, ORDER.legatoOff);
    }
    const retrig = sortedTicks((macroWrites(a.keyon, n, ctx) ?? [])
      .filter(([, v]) => v >= 0.5).map(([t]) => Math.round(t)).filter((t) => t > on && t < n.end));
    let from = on;
    for (const r of [...retrig, null]) {
      const to = r ?? n.end;
      const note = { on: from, off: to, key: n.key, velocity, open: true };
      out.push({ tick: from, order: ORDER.on, bytes: [st(0x90), n.key, velocity] });
      const offEv = { tick: to, order: ORDER.off, bytes: [st(0x80), n.key, 0] };
      out.push(offEv);
      note.extend = (t, order = ORDER.off) => { offEv.tick = t; offEv.order = order; note.off = t; };
      notes.push(note);
      from = to;
    }
    if (n.end < (n.limit ?? Infinity)) notes.at(-1).open = false; // gated: nothing slurs from it
  }
  return out;
}

// ── The file ─────────────────────────────────────────────────────────────
const vlq = (v) => {
  const b = [v & 0x7f];
  while ((v >>>= 7)) b.unshift((v & 0x7f) | 0x80);
  return b;
};
const text = (s) => [...new TextEncoder().encode(s)];
const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];

function encodeTrack(events) {
  const sorted = events
    .map((e, i) => ({ ...e, tick: Math.max(0, Math.round(e.tick)), i }))
    .sort((a, b) => a.tick - b.tick || a.order - b.order || a.i - b.i);
  const body = [];
  let at = 0;
  for (const e of sorted) {
    body.push(...vlq(e.tick - at), ...e.bytes);
    at = e.tick;
  }
  body.push(0, ...meta(0x2f, []));
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
}

/**
 * The score as a Standard MIDI File.
 *
 * @param {object} ir  compileMMLisp's IR, compiled with `voiceStamps: true`
 *                     for the voices' program changes and `voiceHoist: false`:
 *                     the hoist is the driver's wire (voice-hoist.js), and
 *                     cuts a note short for the voice change after it
 * @returns {{ bytes: Uint8Array, notes: string[],
 *             tracks: Array<{ name, channel, port, drums, notes: Array<{on, off, key, velocity}> }> }}
 *          `notes`: what the file could not say, one line each
 */
export function exportMidi(ir) {
  const frameHz = ir.metadata?.frameHz ?? FRAME_HZ_NTSC;
  const said = new Set();
  const note = (s) => said.add(s);
  const songTracks = (ir.tracks ?? []).filter((t) => !t.se);
  if (songTracks.length < (ir.tracks ?? []).length) note("the def-se effects are not in the file");

  // The song's length: every track once through, the loops to their LCM
  // (ir-player captureRegisterLog), each track written out to it.
  const flat = songTracks.map(flatten);
  const looping = flat.filter((f) => f.hasLoop);
  const oneShotEnd = flat.filter((f) => !f.hasLoop).reduce((m, f) => Math.max(m, f.endTick), 0);
  let loopStart = null, endTick = flat.reduce((m, f) => Math.max(m, f.endTick), 1);
  if (looping.length) {
    loopStart = looping.reduce((m, f) => Math.max(m, f.loopStartTick), oneShotEnd);
    let period = looping.reduce((m, f) => lcm(m, f.loopDuration), 1);
    if (period > LCM_CAP_TICKS) {
      period = looping.reduce((m, f) => Math.max(m, f.loopDuration), 1);
      note("the tracks' loops meet only after more than 1024 bars: the file holds the longest loop once");
    }
    endTick = loopStart + period;
  }
  const played = flat.map((f) => unroll(f, endTick));

  const tempo = tempoMap(played.flat(), frameHz, loopStart);
  const ctx = {
    frameHz, endTick, note, loopStart, unnamed: new Set(),
    secAt: tempo.secAt,
    tickAt: tempo.tickAt,
    bpmAt: (tick) => tempo.points.findLast((p) => p.tick <= tick)?.bpm ?? 120,
    slotAt: () => 0,
    lenFromSlot: () => 1,
    master: [[0, VOL_UNITY]],
  };
  // The def-vals: their inits and what the score writes to them.
  const vals = ir.metadata?.vals ?? [];
  const units = Object.fromEntries(vals.map((v) => [v.name, v.unit ?? "frame"]));
  const inits = Object.fromEntries(vals.map((v) => [v.name, v.init ?? 0]));
  const lines = {};
  ctx.slotAt = (src, tick) => {
    if (src === "$time") return Math.floor(tempo.secAt(tick) * frameHz);
    if (lines[src]) return Math.round(lineAt(lines[src], tick));
    return inits[src] ?? 0;
  };
  ctx.lenFromSlot = (src, tick) => {
    const raw = ctx.slotAt(src, tick);
    return units[src] === "tick" ? Math.max(1, Math.round((tempo.secAt(tick + raw) - tempo.secAt(tick)) * frameHz)) : Math.max(1, Math.round(raw));
  };
  const all = played.flat().sort((a, b) => a.tick - b.tick);
  const slotLines = vals.map((v) => [v.name, paramLine(all.filter((e) => PARAM_CMDS.has(e.cmd) && e.args?.target === `VAL${v.slot}`), `VAL${v.slot}`, v.init ?? 0, ctx, endTick)]);
  for (const [name, pts] of slotLines) lines[name] = pts;
  ctx.master = paramLine(all.filter((e) => PARAM_CMDS.has(e.cmd) && e.args?.target === "MASTER"), "MASTER", VOL_UNITY, ctx, endTick);

  // What the file leaves out: a machine's own words, as the score wrote them
  // (a part's start-up write, which has no src, is no one's).
  const valTargets = new Set(vals.map((v) => `VAL${v.slot}`));
  const leftOut = new Set();
  for (const e of all) {
    if (!e.src || e._voiceSet) continue; // a voice is said below
    if (PARAM_CMDS.has(e.cmd)) {
      const t = e.args?.target;
      if (!READ_TARGETS.has(t) && !valTargets.has(t)) leftOut.add(t);
    } else if (!STRUCTURE.has(e.cmd) && !e.cmd.startsWith("LOOP_")) leftOut.add(e.cmd);
    if (e.cmd === "NOTE_ON") for (const k of Object.keys(e.args ?? {})) if (!READ_NOTE_ARGS.has(k)) leftOut.add(k.toUpperCase());
  }
  if (leftOut.size) {
    const names = [...leftOut].sort();
    note(`the machine's own writes are left out: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`);
  }

  // Channels: score order, 10 for the drums, fifteen a port.
  const MELODIC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  const kit = (events) => {
    const pcm = events.filter((e) => e.cmd === "PCM_NOTE_ON");
    return pcm.length > 0 && !events.some((e) => e.cmd === "NOTE_ON") && pcm.every((e) => GM_DRUM_NOTE[e.args?.sample] != null);
  };
  let melodic = 0;
  const assigned = played.map((events, i) => {
    const hasNotes = events.some((e) => e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON");
    if (!hasNotes) return null;
    const drums = kit(events);
    const slot = drums ? null : melodic++;
    return { i, events, drums, port: drums ? 0 : Math.floor(slot / MELODIC.length), channel: drums ? DRUM_CH : MELODIC[slot % MELODIC.length] };
  }).filter(Boolean);
  const ports = assigned.reduce((m, t) => Math.max(m, t.port + 1), 1);

  // The conductor: the title, the tempo, the loop's marks.
  const conductor = [];
  if (ir.metadata?.title) conductor.push({ tick: 0, order: ORDER.meta, bytes: meta(0x03, text(ir.metadata.title)) });
  let lastUs = null;
  for (const p of tempo.points) {
    const us = Math.max(1, Math.min(0xffffff, Math.round(60e6 / p.bpm)));
    if ((us === lastUs && !p.forced) || p.tick >= endTick) continue;
    conductor.push({ tick: p.tick, order: ORDER.meta, bytes: meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]) });
    lastUs = us;
  }
  if (loopStart != null) {
    conductor.push({ tick: loopStart, order: ORDER.meta, bytes: meta(0x06, text("loopStart")) });
    conductor.push({ tick: endTick, order: ORDER.meta, bytes: meta(0x06, text("loopEnd")) });
  }

  const tracksOut = [];
  const chunks = [encodeTrack(conductor)];
  for (const t of assigned) {
    const track = songTracks[t.i];
    const name = track.scoreChannel ?? track.channel ?? `track ${t.i + 1}`;
    const evNotes = [];
    const local = { ...ctx, note: (s) => note(`${name}: ${s}`) };
    const events = trackEvents(t.events, local, t.channel, t.drums, evNotes);
    events.push({ tick: 0, order: ORDER.meta, bytes: meta(0x03, text(name)) });
    if (ports > 1) events.push({ tick: 0, order: ORDER.meta, bytes: meta(0x21, [t.port]) });
    // A label and a trig, on the first pass.
    for (const e of t.events) {
      if (e._pass) continue;
      if (e.cmd === "MARKER" && e.args?.id && !/^\(x \d+\)$/.test(e.args.id)) events.push({ tick: e.tick, order: ORDER.meta, bytes: meta(0x06, text(e.args.id)) });
      if (e.cmd === "TRIG") events.push({ tick: e.tick, order: ORDER.meta, bytes: meta(0x07, text(`trig ${e.args?.code ?? 0}`)) });
    }
    chunks.push(encodeTrack(events));
    tracksOut.push({
      name, channel: t.channel + 1, port: t.port, drums: t.drums,
      notes: evNotes.map(({ on, off, key, velocity }) => ({ on: Math.round(on), off: Math.round(off), key, velocity })),
    });
  }

  // A voice named for no instrument plays the DAW's choice.
  if (ctx.unnamed.size) {
    const names = [...ctx.unnamed].sort();
    note(`no GM program for ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}: its channel's sound is the player's`);
  }

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, 0, PPQN];
  const bytes = new Uint8Array(header.length + chunks.reduce((m, c) => m + c.length, 0));
  bytes.set(header, 0);
  let p = header.length;
  for (const c of chunks) { bytes.set(c, p); p += c.length; }
  return { bytes, notes: [...said], tracks: tracksOut };
}
