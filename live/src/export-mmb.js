// ---------------------------------------------------------------------------
// MMB v0.2 export
//
// Lowers compiled IR (docs/ir.md) into the MMB binary container (docs/mmb.md,
// docs/opcodes.md) the Z80 driver decodes in place. Follows the export-vgm.js
// pattern: pure function, IR in → Uint8Array out, plus a diagnostics list for
// everything the M1 stream cannot carry (macro specs, dynamic sweep endpoints,
// per-note PCM modes) so the caller can warn instead of silently degrading.
//
// Key lowerings (see docs/opcodes.md):
// - Time: tick-stamped IR events → delta/duration stream. NOTE_ON/REST/TIE/
//   PCM_NOTE_ON advance the clock; clock gaps (e.g. notes dropped by :prio
//   flattening) are filled with synthesized RESTs.
// - vel/gate: Option B — NOTE_ON carries {note, dur}; vel and gate become
//   sticky track state via PARAM_SET VEL / PARAM_SET GATE (gate in eighths of
//   dur). A gate that is not an exact eighth uses NOTE_ON_EX with an absolute
//   tick gate.
// - Pitch: note names → u8 MIDI at compile time (pitchToMidi).
// - Tempo: BPM → 8.8 tick increment (bpmToTickIncrement); BPM is metadata.
// - Sweep lengths: IR tick lengths → 60 Hz frames at the tempo active at the
//   event's tick (a global tick→BPM timeline is prescanned from TEMPO events).
// ---------------------------------------------------------------------------

import {
  MAGIC,
  VERSION_MAJOR,
  VERSION_MINOR,
  HEADER_SIZE,
  SECTION_ID,
  SECTION_FLAG,
  TRACK_FLAG,
  OPCODE,
  TARGET_ID,
  targetWidth,
  curveId,
  resolveChannelId,
  encodeDuration,
  bpmToTickIncrement,
  pcmBakeRate,
  PCM_BAKE_STAMP,
} from "./mmb.js";
import { pitchToMidi, clampForTarget, sampleCurveUnit } from "./ir-utils.js";
import { buildLutBlob } from "./lut-blob.js";
import { dedupEventStream } from "./mmb-dedup.js";
import { planVoices, VOICE_TARGETS } from "./mmb-voices.js";

const YM2612_MASTER_CLOCK = 7670454; // NTSC; matches ir-player.js

// NOTE_ON macro spec key → target name (opcodes.md §7). Most keys uppercase
// directly (vol→VOL, fm_tl1→FM_TL1, note_semi→NOTE_SEMI); velMacro/pitchMacro
// are the two irregular ones.
function macroKeyToTarget(key) {
  if (key === "velMacro") return "VEL";
  if (key === "pitchMacro") return "NOTE_PITCH";
  return key.toUpperCase();
}

// NOTE_ON macro spec keys — snapshotted per note; the exporter diffs them into
// sticky MACRO_SET / MACRO_CLEAR (driver.md §13.1). Unlowered forms still warn.
const MACRO_ARG_KEYS = new Set([
  "pitchMacro",
  "velMacro",
  "note_semi",
  "keyon",
  "pan",
  "noise_mode",
  "vol",
  "master",
  "lfo_rate",
  "fm_alg",
  "fm_fb",
  "fm_ams",
  "fm_fms",
  ...[1, 2, 3, 4].flatMap((op) => [
    `fm_tl${op}`,
    `fm_ar${op}`,
    `fm_dr${op}`,
    `fm_sr${op}`,
    `fm_rr${op}`,
    `fm_sl${op}`,
    `fm_ml${op}`,
    `fm_dt${op}`,
    `fm_ks${op}`,
    `fm_amen${op}`,
    `fm_ssg${op}`,
  ]),
]);

// ── Loop-invariant VOICE_SET hoist ─────────────────────────────────────────
// mucom-style scores carry the voice at the loop head (`#loop @psg003`), so every
// iteration re-applies the same 29 registers. Change-only suppression drops all of
// those chip writes, but the driver still pays the per-register shadow bookkeeping
// — measured at ~30k Z80 cycles per track, which put a 7-track import's loop frame
// at 4.4× the 59,659-cycle frame budget and made the loop audibly stumble.
//
// When the loop body cannot disturb the channel's voiced state, that VOICE_SET can
// be emitted BEFORE the marker: pass 1 still applies it and the backward JUMP lands
// after it. MARKER itself writes no register, so moving a VOICE_SET across it
// cannot reorder any chip write — the register trace is unchanged, which is what
// the drv gate asserts.
//
// Returns Map<trackIndex, Map<markerEventIndex, voiceEmitEventIndex>>.
function planVoiceHoists(ir, plans) {
  const hoists = new Map();
  const tracks = ir.tracks ?? [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const plan = plans.get(ti);
    if (!plan) continue;
    const events = tracks[ti].events ?? [];

    // JUMP-target markers only — a `(trig N)` marker carries `code` and is never
    // a target. First occurrence wins, matching the encoder's markerOffsets.
    const markerAt = new Map();
    events.forEach((ev, i) => {
      if (ev.cmd !== "MARKER") return;
      const id = ev.args?.id;
      if (id == null || ev.args?.code != null || markerAt.has(id)) return;
      markerAt.set(id, i);
    });

    const candidates = new Map(); // marker event index → voice emit event index
    const rejected = new Set();
    for (let j = 0; j < events.length; j++) {
      const ev = events[j];
      if (ev.cmd !== "JUMP" || ev.args?.repeat != null) continue;
      const m = markerAt.get(ev.args?.to);
      if (m === undefined || m >= j) continue; // backward jumps only
      // The VOICE_SET has to sit immediately after the marker at the same tick:
      // with anything in between, hoisting would reorder that event's writes.
      const v = m + 1;
      if (!plan.emit.has(v) || events[v]?.tick !== events[m].tick) continue;
      if (voicedStateDisturbed(events, m + 1, j, plan, v)) rejected.add(m);
      else candidates.set(m, v);
    }
    for (const m of rejected) candidates.delete(m); // any dirty path un-hoists
    if (candidates.size) hoists.set(ti, candidates);
  }
  return hoists;
}

// Can anything in events[from..to] leave the channel's voiced registers different
// from what the loop-head VOICE_SET left them? Conservative: unknown means yes.
function voicedStateDisturbed(events, from, to, plan, hoistedEmit) {
  for (let k = from; k <= to && k < events.length; k++) {
    const ev = events[k];
    if (plan.drop.has(k)) {
      // Coalesced burst member. Only a *second* voice change matters: then
      // iteration 2 does need the head VOICE_SET back.
      if (plan.emit.has(k) && k !== hoistedEmit) return true;
      continue;
    }
    const a = ev.args ?? {};
    switch (ev.cmd) {
      case "PARAM_SET":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_FROM_VAL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        if (VOICE_TARGETS.has(a.target)) return true;
        break;
      case "NOTE_ON":
        // A macro on an op param keeps writing that register and where it stops
        // is not a compile-time fact, so treat its presence as disturbed.
        for (const key of Object.keys(a)) {
          if (MACRO_ARG_KEYS.has(key) && VOICE_TARGETS.has(macroKeyToTarget(key))) {
            return true;
          }
        }
        break;
      default:
        break;
    }
  }
  return false;
}

// ── Small byte-writer over a growable array ───────────────────────────────
class Writer {
  constructor() {
    this.bytes = [];
  }
  get length() {
    return this.bytes.length;
  }
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  u16(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }
  u32(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }
  i8(v) {
    this.bytes.push(v & 0xff);
  }
  i16(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  patchU16(at, v) {
    this.bytes[at] = v & 0xff;
    this.bytes[at + 1] = (v >> 8) & 0xff;
  }
  align2() {
    if (this.bytes.length % 2) this.bytes.push(0);
  }
}

// ── Global tick → BPM timeline ────────────────────────────────────────────
// Sweep/tempo lengths are converted ticks → frames at the tempo active at the
// event's tick. Tempo is score-global, so the timeline is built from TEMPO
// events across all tracks (a TEMPO_SWEEP contributes its endpoints).
function buildTempoTimeline(ir) {
  const points = [];
  for (const track of ir.tracks ?? []) {
    for (const ev of track.events ?? []) {
      if (ev.cmd === "TEMPO_SET") {
        const bpm = Number(ev.args?.bpm);
        if (bpm > 0) points.push({ tick: ev.tick ?? 0, bpm });
      } else if (ev.cmd === "TEMPO_SWEEP") {
        const from = Number(ev.args?.from);
        const to = Number(ev.args?.to);
        const tick = ev.tick ?? 0;
        const len = Math.max(0, Number(ev.args?.len ?? 0));
        if (from > 0) points.push({ tick, bpm: from });
        if (to > 0) points.push({ tick: tick + len, bpm: to });
      }
    }
  }
  points.sort((a, b) => a.tick - b.tick);
  return points;
}

function bpmAt(timeline, tick) {
  let bpm = 120;
  for (const p of timeline) {
    if (p.tick > tick) break;
    bpm = p.bpm;
  }
  return bpm;
}

function ticksToFrames(ticks, bpm) {
  // frames = ticks × secsPerTick × 60 = ticks × 3600 / (bpm × 96)
  return Math.max(1, Math.round((Number(ticks) * 3600) / (bpm * 96)));
}

// Timer A period from Hz (same formula as ir-player.js _setCsmRateHz).
function hzToTimerA(hz) {
  const safeHz = Math.max(52, Math.min(53270, Number(hz) || 52));
  const ta = Math.round(1024 - YM2612_MASTER_CLOCK / (144 * safeHz));
  return Math.max(0, Math.min(1023, ta));
}

function midiNote(pitch) {
  const midi = Math.round(pitchToMidi(pitch ?? "c4"));
  return Math.max(0, Math.min(127, midi));
}

/**
 * Encode compiled IR into an MMB v0.2 byte stream.
 *
 * @param {object} ir - compiled IR (compileMMLisp().ir)
 * @param {{ compilerVersion?: string,
 *           samples?: Record<string, { data: Uint8Array|Int8Array,
 *             baseRate?: number, loopStart?: number|null,
 *             loopEnd?: number|null }> }} [opts]
 *   `samples` supplies raw 8-bit signed PCM blobs keyed by sample name; when
 *   given (and PCM events exist) a SAMPLE_BANK section is emitted.
 * @returns {{ bytes: Uint8Array, diagnostics: Array<{severity, code, message, track?}> }}
 * @throws {RangeError} when the event stream overflows the u16 offset space
 *   (one 32KB bank window; mmb.md §12).
 */
export function encodeMmb(ir, opts = {}) {
  const diagnostics = [];
  const diag = (severity, code, message, track = null) =>
    diagnostics.push({ severity, code, message, ...(track ? { track } : {}) });

  const timeline = buildTempoTimeline(ir);
  const valSlots = new Map(
    (ir.metadata?.vals ?? []).map((v) => [v.name, v.slot]),
  );
  // The sample bank is PLANNED here, before the event stream, because baking
  // splits one sample into several entries and PCM_NOTE_ON has to name the one
  // its note belongs to (driver.md §14.2). `sampleIds` survives for diagnostics
  // — it is what tells a bad `:sample` name from a note the plan skipped.
  const bankPlan = opts.samples
    ? buildSampleBank(ir, opts.samples, diag, collectPcmUsage(ir))
    : null;
  const sampleIds = new Map(
    (ir.metadata?.samples ?? []).map((s, i) => [s.name, i]),
  );

  // Resolve a dynamic-value source name to a slot id (0xFF = $time).
  const slotId = (src, trackLabel) => {
    if (src === "$time") return 0xff;
    if (valSlots.has(src)) return valSlots.get(src) & 0xff;
    diag(
      "warning",
      "W_MMB_UNKNOWN_SLOT",
      `unknown value slot "${src}"; event skipped`,
      trackLabel,
    );
    return null;
  };

  // ── Macro registry (MACRO_TABLE §0x0007) ────────────────────────────────
  // Every distinct lowered macro is interned once and referenced by id from
  // MACRO_SET. Lowers the `steps`, `curve`, and `stages` forms onto i8 targets
  // that ride the PARAM_SET apply path; curve/stages are pre-sampled at the
  // :step clock (driver.md §13). The special targets (NOTE_PITCH i16,
  // NOTE_SEMI, KEYON) and dynamic (val-slot) params are still dropped.
  const macroRegistry = new Map(); // canonical key → { id, target, flags, step, loopStart, release, values }

  // :step clock → frames (default 1f). Tick units are not lowered yet.
  const macroStepFrames = (spec, target, trackLabel) => {
    if (spec.step?.unit === "frame") return Math.max(1, Math.min(255, spec.step.value));
    if (spec.step?.unit === "tick") {
      diag(
        "warning",
        "W_MMB_MACRO_STEP_TICK",
        `${target} macro :step in ticks not lowered yet (M3 slice); using 1f`,
        trackLabel,
      );
    }
    return 1;
  };

  // Sample one curve into an integer value array, clamped to the target.
  const sampleCurveValues = (spec, target, count, phaseAt) => {
    const from = Number(spec.from ?? 0);
    const to = Number(spec.to ?? 0);
    const out = [];
    for (let i = 0; i < count; i++) {
      const unit = sampleCurveUnit(spec.curve ?? "linear", phaseAt(i), spec.params);
      out.push(clampForTarget(target, Math.round(from + (to - from) * unit)));
    }
    return out;
  };

  // Lower one IR macro spec → { flags, step, loopStart, release, values } | null.
  const lowerMacro = (spec, target, trackLabel) => {
    const step = macroStepFrames(spec, target, trackLabel);
    const skip = (why) => {
      diag("warning", "W_MMB_MACRO_SKIPPED", `${target} macro ${why}; dropped`, trackLabel);
      return null;
    };

    if (spec.type === "steps") {
      // Round + clamp at the binding site (§2.2): a no-op for the integer step
      // vectors the parser already clamps, and the quantization point for the
      // float values a signal⊕signal materialization produces. Hold sentinels
      // (null) pass through untouched.
      const values = (spec.steps ?? []).map((v) =>
        v == null ? null : clampForTarget(target, Math.round(v)),
      );
      if (values.length === 0 || values.length > 255) return null;
      return {
        step,
        loopStart: spec.loopIndex == null ? 0xff : spec.loopIndex,
        release: spec.releaseIndex == null ? 0xff : spec.releaseIndex,
        values,
      };
    }

    if (spec.type === "curve") {
      if (spec.dyn) return skip("has dynamic (val-slot) params (later M3 slice)");
      // Tick/Nf `:len` is resolved to a frame count upstream (mmlisp2ir
      // resolveMacroLen); a curve reaching here without one has no `:len`.
      if (!spec.lenFrames) return skip("requires a :len");
      // `:wait N` (docs §11) is a pre-delay: hold the base value for waitFrames
      // (as `null` hold-sentinel steps) before the curve, so it lowers to the
      // same value blob shape the player/driver already skip. `:wait key-off` on
      // a single curve has no MMB form (release is a stages concept).
      if (spec.waitKeyOff)
        return skip("(:wait key-off) on a single curve is not lowered; use stages");
      const waitSteps = Math.min(254, Math.max(0, Math.round(Number(spec.waitFrames ?? 0) / step)));
      const hold = Array.from({ length: waitSteps }, () => null);
      const room = 255 - waitSteps;
      const baseFrames = Math.max(1, Math.round(Number(spec.frames ?? 1)));
      // A curve is pre-sampled every `step` frames (driver.md §13). A loop curve
      // fills the sustain region (one period, cycled); a one-shot fills the
      // attack region and holds its last value. A wait prefix shifts loopStart
      // past the hold steps so the loop replays only the curve.
      if (spec.loop) {
        const period = Math.max(1, Math.min(room, Math.round(baseFrames / step)));
        const values = sampleCurveValues(spec, target, period, (i) => (i * step) / baseFrames);
        return { step, loopStart: waitSteps, release: 0xff, values: [...hold, ...values] };
      }
      const n = Math.max(1, Math.min(room, Math.ceil(baseFrames / step)));
      const values = sampleCurveValues(spec, target, n, (i) =>
        baseFrames <= 1 ? 1 : Math.min(1, (i * step) / (baseFrames - 1)),
      );
      return { step, loopStart: 0xff, release: 0xff, values: [...hold, ...values] };
    }

    if (spec.type === "stages") return lowerStages(spec, target, trackLabel, step, skip);

    return skip(`(${spec?.type ?? "?"}) has no lowering`);
  };

  // Multi-stage: concatenate each stage's samples. `(wait N)` → hold-sentinel
  // steps; `(wait key-off)` marks the release boundary; a looping stage marks
  // the sustain loop start.
  const lowerStages = (spec, target, trackLabel, step, skip) => {
    const values = [];
    let loopStart = 0xff;
    let release = 0xff;
    for (const stage of spec.stages ?? []) {
      if (stage.waitKeyOff) {
        release = values.length;
        continue;
      }
      if (stage.waitFrames != null || stage.waitTicks != null) {
        if (stage.waitTicks != null && stage.waitFrames == null)
          return skip("stage (wait N) in ticks not lowered yet (M3 slice)");
        const frames = Math.max(0, Number(stage.waitFrames ?? 0));
        for (let f = 0; f < frames; f += step) values.push(null); // hold sentinel
        continue;
      }
      if (!stage.curve) continue;
      if (stage.dyn) return skip("stage has dynamic (val-slot) params (later M3 slice)");
      if (!stage.lenFrames) return skip("stage :len in ticks not lowered yet (M3 slice)");
      const baseFrames = Math.max(1, Math.round(Number(stage.frames ?? 1)));
      if (stage.loop) {
        loopStart = values.length;
        const period = Math.max(1, Math.round(baseFrames / step));
        values.push(...sampleCurveValues(stage, target, period, (i) => (i * step) / baseFrames));
      } else {
        const n = Math.max(1, Math.ceil(baseFrames / step));
        values.push(
          ...sampleCurveValues(stage, target, n, (i) =>
            baseFrames <= 1 ? 1 : Math.min(1, (i * step) / (baseFrames - 1)),
          ),
        );
      }
    }
    if (values.length === 0 || values.length > 255) return null;
    return { step, loopStart, release, values };
  };

  const internMacro = (spec, target, trackLabel, channelId) => {
    if (!spec || typeof spec !== "object") return null;
    if (target === "KEYON" && channelId > 9) {
      // Retrigger re-attacks the note's envelopes (FM hardware EG via $28 +
      // soft-env macros; PSG soft-env macros). The macro engine runs on channels
      // 0-9 only, so PCM (20-22) and FM3-op op2-4 (16-18) are deferred.
      diag(
        "warning",
        "W_MMB_KEYON_UNSUPPORTED",
        `:keyon is FM/PSG only (macro engine channels); dropped on ${trackLabel}`,
        trackLabel,
      );
      return null;
    }
    const lowered = lowerMacro(spec, target, trackLabel);
    if (!lowered) return null;
    // Scaled macro (v0.6 §4.4, frame tier): a value slot is a per-frame depth
    // knob; the driver writes `(sample × slot) >> 8`. The slot id rides one byte
    // appended after this macro's value blob (descriptor stays 8 bytes), gated
    // by flags bit2. An unknown slot degrades to a plain (override) macro.
    const scaleSlot = spec.scale != null ? slotId(spec.scale, trackLabel) : null;
    // bit0 = i16 values (cents); bit1 = additive (`:pitch+`/`:semi+` — the driver
    // composes each sample with the channel's live pitch offset, driver.md §8);
    // bit2 = scaled (§4.4). The intern key folds in `flags` + the scale slot, so
    // additive/override/scaled and distinct slots intern separately.
    const flags =
      (target === "NOTE_PITCH" ? 1 : 0) |
      (spec.add ? 2 : 0) |
      (scaleSlot != null ? 4 : 0);
    const key = `${target}|${flags}|${scaleSlot ?? ""}|${lowered.step}|${lowered.loopStart}|${lowered.release}|${lowered.values
      .map((v) => (v == null ? "_" : v))
      .join(",")}`;
    const hit = macroRegistry.get(key);
    if (hit) return hit.id;
    const id = macroRegistry.size;
    macroRegistry.set(key, { id, target, flags, scaleSlot, ...lowered });
    return id;
  };

  // ── EVENT_STREAM + per-track layout ─────────────────────────────────────
  const stream = new Writer();
  const trackEntries = []; // { trackId, channelId, flags, eventOffset }
  const evBounds = []; // { offset, cmd, track } — one per emitted event (dedup)

  // VOICE_TABLE coalescing (driver.md §10): fold full-voice PARAM_SET bursts
  // into deduplicated 29-byte entries + VOICE_SET. Plans are keyed by track
  // index; a null plan means the track has no coalescable voice. ON by default
  // (the Z80 VOICE_SET handler landed in ovl_voice); pass
  // opts.voiceCoalesce === false to force the raw PARAM_SET burst.
  const voices = opts.voiceCoalesce !== false ? planVoices(ir) : { table: [], plans: new Map() };
  // Which loop-head VOICE_SETs move above their marker (see planVoiceHoists).
  // opts.voiceHoist === false keeps them in the loop body — an A/B switch for
  // proving the move leaves the register trace alone.
  const voiceHoists =
    opts.voiceHoist === false ? new Map() : planVoiceHoists(ir, voices.plans);

  for (const track of ir.tracks ?? []) {
    const trackSeq = trackEntries.length; // this track's index (pushed at tail)
    const vplan = voices.plans.get(trackSeq) ?? null;
    const hoistAt = voiceHoists.get(trackSeq) ?? null; // marker idx → voice emit idx
    const hoisted = new Set(); // voice emit indices already written before a marker
    const label = track.scoreChannel ?? track.channel ?? String(track.id);
    const channelId = resolveChannelId(track.scoreChannel ?? track.channel);
    if (channelId === null) {
      diag(
        "warning",
        "W_MMB_UNKNOWN_CHANNEL",
        `unknown channel "${track.scoreChannel}"; track skipped`,
        label,
      );
      continue;
    }

    const eventOffset = stream.length;
    let flags = 0;
    if (
      track.scoreChannel === "fm3-csm" ||
      track.scoreChannel === "fm3-csm-rate"
    ) {
      flags |= TRACK_FLAG.isCsm;
    }
    if (channelId >= 16 && channelId <= 18) flags |= TRACK_FLAG.isFm3Op;

    // Per-track encoder state.
    let clock = 0; // running tick position of the stream
    let velState = 15; // sticky VEL (opcodes.md §4)
    let gateState = 8; // sticky GATE in eighths of dur
    const activeMacros = new Map(); // sticky active macro per target id (driver.md §13.1)
    const markerIds = new Map(); // marker string id → u8
    const markerOffsets = new Map(); // marker string id → stream offset
    const markerState = new Map(); // marker id → sticky {gate,macros} snapshot
    const jumpFixups = []; // { at, to } forward-marker patches
    const breakFixups = new Map(); // loop id → [patch offsets]
    // Markers this track jumps back to. Known before the linear pass because a
    // loop target has to invalidate the sticky VEL tracking when it is emitted
    // — see the MARKER case.
    const jumpTargets = new Set(
      (track.events ?? []).filter((e) => e.cmd === "JUMP").map((e) => e.args?.to),
    );

    // Synthesize RESTs for clock gaps (e.g. notes dropped by :prio layers).
    const syncClock = (tick) => {
      const t = tick ?? clock;
      if (t > clock) {
        stream.u8(OPCODE.REST);
        stream.raw(encodeDuration(t - clock));
        clock = t;
      } else if (t < clock) {
        diag(
          "warning",
          "W_MMB_TICK_REGRESSION",
          `event at tick ${t} behind stream clock ${clock}; emitted at ${clock}`,
          label,
        );
      }
    };

    const emitParamState = (targetId, value) => {
      stream.u8(OPCODE.PARAM_SET);
      stream.u8(targetId);
      stream.i8(value);
    };

    const events = track.events ?? [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const a = ev.args ?? {};
      // Voice coalescing: a full-voice PARAM_SET burst folds into one VOICE_SET
      // emitted at its first voice param; the rest of the burst is dropped.
      if (vplan && vplan.drop.has(i)) {
        if (vplan.emit.has(i) && !hoisted.has(i)) {
          syncClock(ev.tick);
          evBounds.push({ offset: stream.length, cmd: "VOICE_SET", track: trackSeq });
          stream.u8(OPCODE.VOICE_SET);
          stream.u8(vplan.emit.get(i));
        }
        continue;
      }
      // Loop-invariant VOICE_SET: emit it ahead of the marker it followed, so the
      // backward JUMP lands past it and iterations 2+ skip the whole re-apply.
      if (hoistAt?.has(i)) {
        const hv = hoistAt.get(i);
        syncClock(ev.tick);
        evBounds.push({ offset: stream.length, cmd: "VOICE_SET", track: trackSeq });
        stream.u8(OPCODE.VOICE_SET);
        stream.u8(vplan.emit.get(hv));
        hoisted.add(hv);
      }
      evBounds.push({ offset: stream.length, cmd: ev.cmd, track: trackSeq });
      switch (ev.cmd) {
        case "NOTE_ON": {
          syncClock(ev.tick);
          // Diff this note's snapshotted macros into sticky MACRO_SET / CLEAR.
          const desired = new Map(); // target → macro_id
          for (const key of Object.keys(a)) {
            if (!MACRO_ARG_KEYS.has(key)) continue;
            const id = internMacro(a[key], macroKeyToTarget(key), label, channelId);
            if (id != null) desired.set(macroKeyToTarget(key), id);
          }
          for (const target of [...activeMacros.keys()]) {
            if (!desired.has(target)) {
              stream.u8(OPCODE.MACRO_CLEAR);
              stream.u8(TARGET_ID[target]);
              activeMacros.delete(target);
            }
          }
          for (const [target, id] of desired) {
            if (activeMacros.get(target) !== id) {
              stream.u8(OPCODE.MACRO_SET);
              stream.u8(id);
              activeMacros.set(target, id);
            }
          }
          const vel = a.vel ?? 15;
          if (vel !== velState) {
            emitParamState(TARGET_ID.VEL, vel);
            velState = vel;
          }
          const length = a.length ?? 0;
          const note = midiNote(a.pitch);
          // Gate lowering: absent = full (8/8). An exact eighth updates the
          // sticky GATE state; anything else (incl. gate 0 hold) rides this
          // note as a NOTE_ON_EX absolute gate.
          let exGate = null;
          if (length > 0 && a.gate !== undefined) {
            const g = a.gate;
            if (g === 0) {
              exGate = 0;
            } else if ((g * 8) % length === 0) {
              const eighths = (g * 8) / length;
              if (eighths !== gateState) {
                emitParamState(TARGET_ID.GATE, eighths);
                gateState = eighths;
              }
            } else {
              exGate = g;
            }
          } else if (a.gate === undefined && gateState !== 8) {
            emitParamState(TARGET_ID.GATE, 8);
            gateState = 8;
          }
          // NOTE_ON_EX flags (opcodes.md §5.1), fields in bit order: bit1 = an
          // absolute gate, bit3 = legato (slur — no field, no re-key).
          let noteFlags = 0;
          if (exGate !== null) noteFlags |= 0b0010;
          if (a.legato) noteFlags |= 0b1000;
          if (noteFlags) {
            stream.u8(OPCODE.NOTE_ON_EX);
            stream.u8(noteFlags);
            stream.u8(note);
            stream.raw(encodeDuration(length));
            if (noteFlags & 0b0010) stream.raw(encodeDuration(exGate));
          } else {
            stream.u8(OPCODE.NOTE_ON);
            stream.u8(note);
            stream.raw(encodeDuration(length));
          }
          clock += length;
          break;
        }
        case "REST":
        case "TIE": {
          syncClock(ev.tick);
          const length = a.length ?? 0;
          stream.u8(ev.cmd === "REST" ? OPCODE.REST : OPCODE.TIE);
          stream.raw(encodeDuration(length));
          clock += length;
          break;
        }
        case "LOOP_BEGIN": {
          syncClock(ev.tick);
          // Count lives on LOOP_BEGIN in MMB; find the matching LOOP_END.
          let repeat = null;
          for (let j = i + 1; j < events.length; j++) {
            if (events[j].cmd === "LOOP_END" && events[j].args?.id === a.id) {
              repeat = events[j].args?.repeat ?? 1;
              break;
            }
          }
          if (repeat === null) {
            diag(
              "warning",
              "W_MMB_LOOP_UNMATCHED",
              `LOOP_BEGIN ${a.id} has no LOOP_END; emitted as pass-through`,
              label,
            );
            break;
          }
          if (repeat > 255) {
            diag(
              "warning",
              "W_MMB_LOOP_COUNT_CLAMPED",
              `loop count ${repeat} clamped to 255`,
              label,
            );
            repeat = 255;
          }
          // repeat 1 = body plays once — no loop needed; the matching LOOP_END
          // (and any LOOP_BREAKs) are dropped by the same rule.
          if (repeat >= 2) {
            stream.u8(OPCODE.LOOP_BEGIN);
            stream.u8(repeat);
          }
          break;
        }
        case "LOOP_END": {
          syncClock(ev.tick);
          if ((a.repeat ?? 1) >= 2) stream.u8(OPCODE.LOOP_END);
          // Resolve pending :break skips for this loop (to just past LOOP_END).
          for (const at of breakFixups.get(a.id) ?? []) {
            stream.patchU16(at, stream.length - (at + 2));
          }
          breakFixups.delete(a.id);
          break;
        }
        case "LOOP_BREAK": {
          syncClock(ev.tick);
          if (a.id == null) break; // authored outside a counted loop — inert
          stream.u8(OPCODE.LOOP_BREAK);
          const at = stream.length;
          stream.u16(0); // patched at the matching LOOP_END
          if (!breakFixups.has(a.id)) breakFixups.set(a.id, []);
          breakFixups.get(a.id).push(at);
          break;
        }
        case "MARKER": {
          syncClock(ev.tick);
          // Trigger marker `(trig N)`: an explicit id, never a JUMP target, so
          // it is emitted verbatim and skips the label id/offset bookkeeping.
          if (a.code != null) {
            stream.u8(OPCODE.MARKER);
            stream.u8(a.code & 0x3f);
            break;
          }
          if (!markerIds.has(a.id)) {
            if (markerIds.size >= 256) {
              diag(
                "warning",
                "W_MMB_MARKER_OVERFLOW",
                `more than 256 markers; "${a.id}" dropped`,
                label,
              );
              break;
            }
            markerIds.set(a.id, markerIds.size);
          }
          markerOffsets.set(a.id, stream.length);
          stream.u8(OPCODE.MARKER);
          stream.u8(markerIds.get(a.id));
          // Snapshot the sticky state entering this marker. A backward JUMP here
          // restores it (below) so iterations 2+ start from the same state as
          // iteration 1 — the linear encoder omits opcodes whose value already
          // matched the state at the marker, but the loop tail leaves a
          // different state, which would otherwise bleed into the loop body.
          //
          // VEL is deliberately NOT in that snapshot. Restoring it happens at
          // the JUMP, i.e. while the previous iteration's last note may still be
          // sounding — and PARAM_SET VEL is the one sticky param the driver acts
          // on immediately (it recomposes carrier TL, driver.md §7.1). A loop
          // whose marker sits at the top of the track snapshots the encoder's
          // *initial* vel 15, so the restore fired `VEL 15` into a note held
          // across the loop: +21.8 dB on a sustained chord, for as long as the
          // body took to reach its next note. That is the loop-point blast.
          //
          // Instead a loop target invalidates the tracking, so the body
          // re-asserts its own velocity at the note that needs it and depends on
          // nothing established before the marker. Same bytes, no level event on
          // a sounding note.
          markerState.set(a.id, {
            gateState,
            activeMacros: new Map(activeMacros),
          });
          if (jumpTargets.has(a.id)) velState = null;
          break;
        }
        case "JUMP": {
          syncClock(ev.tick);
          if (a.repeat != null) {
            // Forward counted go — a compile error upstream; never encodable.
            diag(
              "warning",
              "W_MMB_JUMP_REPEAT_SKIPPED",
              `counted JUMP to "${a.to}" not representable; dropped`,
              label,
            );
            break;
          }
          // Backward loop: re-establish the sticky state the loop body assumes
          // (the snapshot at its target marker) before jumping, so every
          // iteration replays identically. Emitted only for state that drifted.
          const snap = markerState.get(a.to);
          if (snap) {
            for (const target of [...activeMacros.keys()]) {
              if (snap.activeMacros.get(target) !== activeMacros.get(target)) {
                if (!snap.activeMacros.has(target)) {
                  stream.u8(OPCODE.MACRO_CLEAR);
                  stream.u8(TARGET_ID[target]);
                  activeMacros.delete(target);
                }
              }
            }
            for (const [target, id] of snap.activeMacros) {
              if (activeMacros.get(target) !== id) {
                stream.u8(OPCODE.MACRO_SET);
                stream.u8(id);
                activeMacros.set(target, id);
              }
            }
            // VEL is not restored here — the loop body re-asserts it (see the
            // MARKER case). GATE and the macro binds are silent state: nothing
            // reaches a register until the next note, so restoring them at the
            // jump cannot disturb one that is still sounding.
            if (gateState !== snap.gateState) {
              emitParamState(TARGET_ID.GATE, snap.gateState);
              gateState = snap.gateState;
            }
          }
          stream.u8(OPCODE.JUMP);
          if (markerOffsets.has(a.to)) {
            stream.u16(markerOffsets.get(a.to)); // backward: resolved now
            flags |= TRACK_FLAG.hasLoop;
          } else {
            jumpFixups.push({ at: stream.length, to: a.to });
            stream.u16(0);
          }
          break;
        }
        case "PARAM_SET": {
          syncClock(ev.tick);
          const id = TARGET_ID[a.target];
          if (id === undefined) {
            diag(
              "warning",
              "W_MMB_UNKNOWN_TARGET",
              `PARAM_SET target ${a.target} has no MMB id; dropped`,
              label,
            );
            break;
          }
          const value = Math.round(clampForTarget(a.target, a.value ?? 0));
          stream.u8(OPCODE.PARAM_SET);
          stream.u8(id);
          if (targetWidth(id) === 2) stream.i16(value);
          else stream.i8(value);
          break;
        }
        case "PARAM_ADD":
        case "PARAM_MUL": {
          syncClock(ev.tick);
          const id = TARGET_ID[a.target];
          if (id === undefined) {
            diag(
              "warning",
              "W_MMB_UNKNOWN_TARGET",
              `${ev.cmd} target ${a.target} has no MMB id; dropped`,
              label,
            );
            break;
          }
          const operand = ev.cmd === "PARAM_ADD" ? a.delta : a.factor;
          if (operand && typeof operand === "object" && "src" in operand) {
            const slot = slotId(operand.src, label);
            if (slot === null) break;
            stream.u8(
              ev.cmd === "PARAM_ADD" ? OPCODE.PARAM_ADD_VAL : OPCODE.PARAM_MUL_VAL,
            );
            stream.u8(id);
            stream.u8(slot);
          } else if (ev.cmd === "PARAM_ADD") {
            const delta = Math.round(Number(operand) || 0);
            stream.u8(OPCODE.PARAM_ADD);
            stream.u8(id);
            if (targetWidth(id) === 2) stream.i16(delta);
            else stream.i8(delta);
          } else {
            // factor → unsigned 8.8 (0x0100 = ×1.0)
            const factor = Math.max(
              0,
              Math.min(0xffff, Math.round((Number(operand) || 0) * 256)),
            );
            stream.u8(OPCODE.PARAM_MUL);
            stream.u8(id);
            stream.u16(factor);
          }
          break;
        }
        case "PARAM_FROM_VAL": {
          syncClock(ev.tick);
          const id = TARGET_ID[a.target];
          if (id === undefined) {
            diag(
              "warning",
              "W_MMB_UNKNOWN_TARGET",
              `PARAM_FROM_VAL target ${a.target} has no MMB id; dropped`,
              label,
            );
            break;
          }
          const slot = slotId(a.src, label);
          if (slot === null) break;
          stream.u8(OPCODE.PARAM_FROM_VAL);
          stream.u8(id);
          stream.u8(slot);
          break;
        }
        case "PARAM_SWEEP": {
          syncClock(ev.tick);
          const id = TARGET_ID[a.target];
          if (id === undefined) {
            diag(
              "warning",
              "W_MMB_UNKNOWN_TARGET",
              `PARAM_SWEEP target ${a.target} has no MMB id; dropped`,
              label,
            );
            break;
          }
          // Dynamic endpoints (§4.6, note-on tier): the `flags` byte marks
          // from/to as slot ids (bit1/bit2); the field then holds the slot id in
          // its low byte, and the driver reads the slot at sweep-dispatch time
          // (drv-player _startSweep / Z80 d_param_sweep). `:rate`/`:len` slots
          // are not lowered yet — they stay baked to the slot init (warned).
          let { from, to } = a;
          let flags = a.loop ? 1 : 0;
          if (a.dyn?.from != null) {
            const sid = slotId(a.dyn.from, label);
            if (sid != null) {
              flags |= 2;
              from = sid;
            }
          }
          if (a.dyn?.to != null) {
            const sid = slotId(a.dyn.to, label);
            if (sid != null) {
              flags |= 4;
              to = sid;
            }
          }
          if (a.dyn?.rate != null || a.dyn?.len != null) {
            diag(
              "warning",
              "W_MMB_DYN_SWEEP_BAKED",
              `dynamic sweep :rate/:len baked to slot init (endpoints are slot-fed)`,
              label,
            );
          }
          const frames = a.lenFrames
            ? Math.max(1, Math.round(Number(a.frames ?? 1)))
            : ticksToFrames(a.frames ?? 1, bpmAt(timeline, ev.tick ?? 0));
          stream.u8(OPCODE.PARAM_SWEEP);
          stream.u8(id);
          stream.u8(curveId(a.curve));
          stream.u8(flags);
          stream.i16(Math.round(Number(from ?? 0)));
          stream.i16(Math.round(Number(to ?? 0)));
          stream.u16(Math.min(0xffff, frames));
          break;
        }
        case "PARAM_SWEEP_STOP": {
          syncClock(ev.tick);
          const id = TARGET_ID[a.target];
          if (id === undefined) break;
          stream.u8(OPCODE.PARAM_SWEEP_STOP);
          stream.u8(id);
          break;
        }
        case "TEMPO_SET": {
          syncClock(ev.tick);
          stream.u8(OPCODE.TEMPO_SET);
          stream.u16(bpmToTickIncrement(a.bpm ?? 120));
          break;
        }
        case "TEMPO_SWEEP": {
          syncClock(ev.tick);
          const from = Number(a.from ?? 120);
          const to = Number(a.to ?? from);
          // Convert the tick length to frames at the average tempo — the driver
          // interpolates the increment linearly, so the average preserves the
          // sweep's musical length.
          const avg = Math.max(1, (from + to) / 2);
          const frames = ticksToFrames(a.len ?? 1, avg);
          stream.u8(OPCODE.TEMPO_SWEEP);
          stream.u16(bpmToTickIncrement(from));
          stream.u16(bpmToTickIncrement(to));
          stream.u16(Math.min(0xffff, frames));
          stream.u8(curveId(a.curve));
          break;
        }
        case "CSM_ON": {
          syncClock(ev.tick);
          stream.u8(OPCODE.CSM_ON);
          break;
        }
        case "CSM_OFF": {
          syncClock(ev.tick);
          stream.u8(OPCODE.CSM_OFF);
          break;
        }
        case "CSM_RATE": {
          syncClock(ev.tick);
          stream.u8(OPCODE.CSM_RATE);
          if (a.hz !== undefined) {
            stream.u8(0); // flags: const form
            stream.u16(hzToTimerA(a.hz));
          } else {
            stream.u8(1); // flags: swept form
            stream.u16(hzToTimerA(a.from));
            stream.u16(hzToTimerA(a.to));
            stream.u16(
              Math.min(
                0xffff,
                ticksToFrames(a.len ?? 1, bpmAt(timeline, ev.tick ?? 0)),
              ),
            );
            stream.u8(curveId(a.curve));
          }
          break;
        }
        case "FM3_MODE": {
          syncClock(ev.tick);
          stream.u8(OPCODE.FM3_MODE);
          stream.u8(a.mode === "op" ? 1 : a.mode === "csm" ? 2 : 0);
          break;
        }
        case "FM3_OP_PITCH": {
          syncClock(ev.tick);
          stream.u8(OPCODE.FM3_OP_PITCH);
          stream.u8(a.op ?? 1);
          stream.u8(midiNote(a.pitch));
          break;
        }
        case "PCM_NOTE_ON": {
          syncClock(ev.tick);
          const sampleId = bankPlan
            ? bankPlan.idFor(a.sample, midiNote(a.pitch))
            : sampleIds.get(a.sample);
          if (sampleId === undefined) {
            diag(
              "warning",
              "W_MMB_UNKNOWN_SAMPLE",
              `PCM sample "${a.sample}" not in metadata.samples; note dropped as REST`,
              label,
            );
            stream.u8(OPCODE.REST);
            stream.raw(encodeDuration(a.length ?? 0));
            clock += a.length ?? 0;
            break;
          }
          const vel = a.vel ?? 15;
          if (vel !== velState) {
            emitParamState(TARGET_ID.VEL, vel);
            velState = vel;
          }
          stream.u8(OPCODE.PCM_NOTE_ON);
          stream.u8(sampleId);
          stream.u8(midiNote(a.pitch));
          stream.raw(encodeDuration(a.length ?? 0));
          clock += a.length ?? 0;
          break;
        }
        case "PCM_NOTE_OFF": {
          syncClock(ev.tick);
          stream.u8(OPCODE.PCM_NOTE_OFF);
          break;
        }
        default:
          diag(
            "warning",
            "W_MMB_UNKNOWN_CMD",
            `IR command ${ev.cmd} has no MMB lowering; dropped`,
            label,
          );
          break;
      }
    }

    // Unresolved forward JUMPs (targets validated upstream; belt and braces).
    for (const fx of jumpFixups) {
      if (markerOffsets.has(fx.to)) {
        stream.patchU16(fx.at, markerOffsets.get(fx.to));
      } else {
        diag(
          "warning",
          "W_MMB_JUMP_UNRESOLVED",
          `JUMP to unknown marker "${fx.to}"; dest left at 0`,
          label,
        );
      }
    }
    for (const [id, ats] of breakFixups) {
      // repeat-1 loops drop their LOOP_END, leaving break fixups dangling.
      for (const at of ats) stream.patchU16(at, 0);
      diag(
        "warning",
        "W_MMB_BREAK_UNRESOLVED",
        `LOOP_BREAK for loop ${id} has no emitted LOOP_END; skip = 0`,
        label,
      );
    }

    evBounds.push({ offset: stream.length, cmd: "END_OF_TRACK", track: trackSeq });
    stream.u8(OPCODE.END_OF_TRACK);
    trackEntries.push({
      trackId: track.id ?? trackEntries.length,
      channelId,
      flags,
      eventOffset,
    });
  }

  // ── CALL/RET dedup (design-eval §9): factor repeated event runs. Pure
  // encode transform — trackEntries.eventOffset and JUMP dests are relinked in
  // place; the register trace is unchanged (verified by the ab-compare gate).
  let eventBytes = stream.bytes;
  if (opts.dedup !== false) {
    const d = dedupEventStream(eventBytes, evBounds, trackEntries, OPCODE);
    eventBytes = d.bytes;
  }

  // ── Sections ─────────────────────────────────────────────────────────────
  const sections = [];

  const trackTable = new Writer();
  trackTable.u16(trackEntries.length);
  for (const t of trackEntries) {
    trackTable.u8(t.trackId);
    trackTable.u8(t.channelId);
    trackTable.u8(t.flags);
    trackTable.u16(t.eventOffset);
  }
  sections.push({
    id: SECTION_ID.TRACK_TABLE,
    flags: SECTION_FLAG.REQUIRED,
    payload: trackTable.bytes,
  });
  sections.push({
    id: SECTION_ID.EVENT_STREAM,
    flags: SECTION_FLAG.REQUIRED,
    payload: eventBytes,
  });

  const metadata = new Writer();
  const putMeta = (key, value) => {
    const k = new TextEncoder().encode(key);
    const v = new TextEncoder().encode(String(value));
    metadata.u8(k.length);
    metadata.raw(k);
    metadata.u16(v.length);
    metadata.raw(v);
  };
  putMeta("title", ir.metadata?.title ?? "untitled");
  putMeta("author", ir.metadata?.author ?? "unknown");
  putMeta("compiler_version", opts.compilerVersion ?? "mmlisp v0.5");
  putMeta("bpm", bpmAt(timeline, 0));
  for (const v of ir.metadata?.vals ?? []) putMeta(`val_${v.slot}`, v.name);
  sections.push({
    id: SECTION_ID.METADATA,
    flags: SECTION_FLAG.REQUIRED,
    payload: metadata.bytes,
  });

  // SAMPLE_BANK is NOT an MMB section — the PCM blobs (the 32K-wall term) live
  // in a separate ROM bank the mixer latches per frame (plan-se.md), so the
  // control MMB stays small. buildSampleBank returns the whole bank image
  // (entry table + blobs); the host loads it into a bank and publishes its
  // number. The MMB references samples by id (PCM_NOTE_ON) as before.
  const usesPcm = (ir.tracks ?? []).some((t) =>
    (t.events ?? []).some((e) => e.cmd === "PCM_NOTE_ON"),
  );
  let sampleBank = null;
  if (usesPcm && opts.samples) {
    sampleBank = new Uint8Array(bankPlan.bytes);
    // The bank is its own window too: `pcm_note_on` reads the low u16 of an
    // entry's offset and addresses blobs from the window base, so anything past
    // 32KB wraps and plays another sample's bytes. Same wall as the MMB, and
    // the same reserved way out (WIDE_OFFSETS, mmb.md §12) — refuse rather than
    // ship a ROM that plays garbage. A mucom bank import is the usual way to
    // hit it: trim `:frames`, drop unused samples, or lower `:rate`.
    if (sampleBank.length > 0x8000) {
      throw new RangeError(
        `sample bank is ${sampleBank.length} bytes; exceeds the 32KB bank ` +
          `window by ${sampleBank.length - 0x8000}`,
      );
    }
  } else if (usesPcm) {
    diag(
      "warning",
      "W_MMB_NO_SAMPLE_BANK",
      "PCM events present but no sample blobs supplied (opts.samples); SAMPLE_BANK omitted",
    );
  }

  if (voices.table.length > 0) {
    const vt = new Writer();
    vt.u16(voices.table.length);
    for (const entry of voices.table) for (const b of entry) vt.u8(b);
    sections.push({ id: SECTION_ID.VOICE_TABLE, flags: 0, payload: vt.bytes });
  }

  const vals = ir.metadata?.vals ?? [];
  if (vals.length > 0) {
    const valTable = new Writer();
    valTable.u16(Math.min(16, vals.length));
    for (const v of vals.slice(0, 16)) valTable.i16(Math.round(v.init ?? 0));
    if (vals.length > 16) {
      diag(
        "warning",
        "W_MMB_VAL_OVERFLOW",
        `${vals.length} value slots; driver RAM holds 16 — extras dropped`,
      );
    }
    sections.push({ id: SECTION_ID.VAL_TABLE, flags: 0, payload: valTable.bytes });
  }

  // MACRO_TABLE (mmb.md §15): interned macro descriptors + value blobs.
  if (macroRegistry.size > 0) {
    sections.push({
      id: SECTION_ID.MACRO_TABLE,
      flags: 0,
      payload: buildMacroTable(macroRegistry),
    });
  }

  // LUT_TABLE (mmb.md §16): the driver's constant LUTs, in ROM, read through the
  // bank window — always emitted so the Z80 image needn't carry them. Identical
  // bytes for every song; the JS reference computes its own copy (buildLuts).
  sections.push({
    id: SECTION_ID.LUT_TABLE,
    flags: 0,
    payload: buildLutBlob().blob,
  });

  // ── Assemble file: header + directory (ascending id) + sections ─────────
  sections.sort((a, b) => a.id - b.id);
  const file = new Writer();
  file.raw(MAGIC);
  file.u8(VERSION_MAJOR);
  file.u8(VERSION_MINOR);
  file.u16(0); // flags: no WIDE_OFFSETS, no PAL_TIMEBASE
  file.u16(sections.length);
  file.u16(HEADER_SIZE);

  const dirStart = file.length;
  for (const s of sections) {
    file.u16(s.id);
    file.u16(s.flags);
    file.u32(0); // offset — patched below
    file.u32(s.payload.length);
  }
  sections.forEach((s, i) => {
    file.align2();
    const at = dirStart + i * 12 + 4;
    const off = file.length;
    file.bytes[at] = off & 0xff;
    file.bytes[at + 1] = (off >> 8) & 0xff;
    file.bytes[at + 2] = (off >> 16) & 0xff;
    file.bytes[at + 3] = (off >> 24) & 0xff;
    file.raw(s.payload);
  });

  // M1 constraint (mmb.md §12): the whole MMB must fit one 32KB bank window;
  // WIDE_OFFSETS multi-bank streaming is reserved, not implemented.
  if (file.length > 0x8000) {
    throw new RangeError(
      `MMB file is ${file.length} bytes; exceeds the 32KB bank window`,
    );
  }

  return { bytes: new Uint8Array(file.bytes), sampleBank, diagnostics };
}

// SAMPLE_BANK (mmb.md §10): entry table + raw 8-bit signed PCM blobs.
// MACRO_TABLE payload (mmb.md §15): entry_count u16, then entry_count × 8-byte
// descriptors {target, flags, step, loop_start, release, count, blob_offset u16},
// then the value blobs (i8, or i16 when flags bit0), byte-packed. Hold sentinel
// 0x80 / 0x8000 marks a `_` (advance, write nothing). A scaled macro (flags
// bit2) appends one slot-id byte immediately after its values — the descriptor
// stays 8 bytes; the reader finds the slot at `blob_offset + count × width`.
function buildMacroTable(registry) {
  const entries = [...registry.values()].sort((a, b) => a.id - b.id);
  const desc = new Writer();
  const blob = new Writer();
  desc.u16(entries.length);
  const offsets = [];
  let off = 0;
  for (const e of entries) {
    offsets.push(off);
    off += e.values.length * (e.flags & 1 ? 2 : 1) + (e.flags & 4 ? 1 : 0);
  }
  entries.forEach((e, i) => {
    desc.u8(TARGET_ID[e.target]);
    desc.u8(e.flags);
    desc.u8(e.step);
    desc.u8(e.loopStart);
    desc.u8(e.release);
    desc.u8(e.values.length);
    desc.u16(offsets[i]);
  });
  for (const e of entries) {
    for (const v of e.values) {
      if (e.flags & 1) blob.u16(v == null ? 0x8000 : v & 0xffff);
      else blob.u8(v == null ? 0x80 : v & 0xff);
    }
    if (e.flags & 4) blob.u8(e.scaleSlot & 0xff); // scaled: appended slot id
  }
  return [...desc.bytes, ...blob.bytes];
}

// ── Pitch baking (driver.md §14.2) ─────────────────────────────────────────
// Which notes each PCM sample is actually played at. The exporter bakes per
// PITCH CLASS, not per note: an octave is exactly a doubling of the increment,
// so one blob serves every octave of its pitch class and the mixer reaches the
// others by advancing 2^k bytes a tick. Per note it would be up to 49 blobs a
// sample; this is at most 12.
function collectPcmUsage(ir) {
  const use = new Map(); // sample name -> Set<midi note>
  for (const track of ir.tracks ?? []) {
    for (const ev of track.events ?? []) {
      if (ev.cmd !== "PCM_NOTE_ON") continue;
      const a = ev.args ?? {};
      const n = midiNote(a.pitch);
      if (!use.has(a.sample)) use.set(a.sample, new Set());
      use.get(a.sample).add(n);
    }
  }
  return use;
}

// Linear resample of an 8-bit signed blob from `from` Hz to `to` Hz. Linear and
// not nearest-neighbour on purpose: this runs once, at build time, where the
// better filter is free — the mixer's own nearest-neighbour step is what baking
// REMOVES, so the baked copy should not carry its artefacts forward.
function resample8(data, from, to) {
  const ratio = from / to;
  const outLen = Math.max(1, Math.round(data.length / ratio));
  const out = new Int8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = i0 + 1 < data.length ? i0 + 1 : i0;
    const f = x - i0;
    const s0 = (data[i0] << 24) >> 24;
    const s1 = (data[i1] << 24) >> 24;
    let v = Math.round(s0 + (s1 - s0) * f);
    out[i] = v > 127 ? 127 : v < -128 ? -128 : v;
  }
  return out;
}

// The shortest a BAKED loop may be, in output samples. Resampling maps the loop
// points off integer samples and they have to round back, which moves where the
// loop repeats by up to half a sample — and when the loop is one waveform cycle,
// that period IS the perceived pitch. The error is 0.5/L, so:
//
//     20 samples   42.8 cents      200 samples   4.3 cents
//     50           17.2            430           2.0
//    100            8.6           4000           0.2
//
// A chorus or pad loop is already thousands of samples and never notices. A
// glitch loop is tens and would be 40 cents out — so the loop REGION is repeated
// until it clears this bar, which is bit-exact (repeating is literally what
// playback does) and costs at most this many bytes once. 430 puts every loop
// inside 2 cents, which is under what an ear catches against FM.
const MIN_BAKED_LOOP = 430;

// Bake a LOOPED sample for one note. Resample the whole blob, map the loop
// points through the same ratio, and repeat the loop region so its baked length
// clears MIN_BAKED_LOOP. The layout the engine wants is
//
//     [0 .. loopEnd)  the attack, played once
//     [loopStart .. loopEnd) repeated  the sustain
//     [loopEnd .. len)  the tail a release plays out
//
// so the repeats are spliced in ahead of the tail and loopEnd moves with them.
function bakeLooped(data, from, to, loopStart, loopEnd, name, diag) {
  const all = resample8(data, from, to);
  const ratio = from / to;
  const map = (p) => Math.min(all.length, Math.max(0, Math.round(p / ratio)));
  const ls = map(loopStart);
  let le = map(loopEnd);
  if (le <= ls) {
    // A loop that resampled to nothing cannot be repeated into existence. It is
    // a bad loop in the source, not a rounding problem, so say so and play the
    // blob straight through rather than emitting a zero-length loop the engine
    // would spin in.
    diag("warning", "W_MMB_BAKE_LOOP_EMPTY",
      `sample "${name}" has a loop of ${loopEnd - loopStart} frames that resampled `
        + `to ${le - ls}; baked without a loop`);
    return { bytes: all, loopStart: 0, loopEnd: 0 };
  }
  const reps = Math.max(1, Math.ceil(MIN_BAKED_LOOP / (le - ls)));
  if (reps === 1) return { bytes: all, loopStart: ls, loopEnd: le };
  const region = all.subarray(ls, le);
  const out = new Int8Array(all.length + (reps - 1) * region.length);
  out.set(all.subarray(0, le), 0);
  for (let r = 1; r < reps; r++) out.set(region, le + (r - 1) * region.length);
  const grown = le + (reps - 1) * region.length;
  out.set(all.subarray(le), grown);
  return { bytes: out, loopStart: ls, loopEnd: grown };
}

function buildSampleBank(ir, blobs, diag, usage = new Map()) {
  const samples = ir.metadata?.samples ?? [];
  const entries = new Writer();
  const blobBytes = [];
  const rows = [];                 // one per ENTRY, in id order
  const entryIdFor = new Map();    // `${name}|${note}` -> entry id
  const fallbackFor = new Map();   // name -> entry id, for notes with no plan
  // Blob dedup. Two pitch classes of the same sample can resample to the same
  // bytes (a short one-shot, adjacent semitones), and so can two samples that
  // were the same file. Hash first, then compare — a collision must not silently
  // alias two different blobs together.
  const pool = new Map();          // hash -> [{ off, len, bytes }]
  const intern = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = ((h ^ (bytes[i] & 0xff)) * 0x01000193) >>> 0;
    const key = `${bytes.length}:${h}`;
    for (const c of pool.get(key) ?? []) {
      let same = true;
      for (let i = 0; i < bytes.length; i++) {
        if ((c.bytes[i] & 0xff) !== (bytes[i] & 0xff)) { same = false; break; }
      }
      if (same) return c.off;
    }
    const off = blobBytes.length;
    for (const b of bytes) blobBytes.push(b & 0xff);
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push({ off, len: bytes.length, bytes });
    return off;
  };
  const push = (row) => { rows.push(row); return rows.length - 1; };
  let bakedEntries = 0, bakedBlobBytes = 0, bakedSources = 0, bakedSourceBytes = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const blob = blobs[s.name];
    const data = blob?.data ?? new Uint8Array(0);
    if (!blob) {
      diag(
        "warning",
        "W_MMB_SAMPLE_BLOB_MISSING",
        `no blob supplied for sample "${s.name}"; empty entry`,
      );
    }
    const loopStart = blob?.loopStart ?? s.loopStart;
    const loopEnd = blob?.loopEnd ?? s.loopEnd;
    const hasLoop = loopStart != null && loopEnd != null;
    const rate = blob?.baseRate ?? s.rate ?? 13000;
    const notes = [...(usage.get(s.name) ?? [])].sort((x, y) => x - y);

    // LOOPED MATERIAL IS BAKED TOO, and the rounding it used to be refused for
    // is bought off with a few hundred bytes — see bakeLooped below.
    const bakeable = data.length > 0 && notes.length > 0;
    if (!bakeable) {
      fallbackFor.set(s.name, push({
        flags: hasLoop ? 1 : 0,
        off: intern(data), len: data.length, rate,
        loopStart: hasLoop ? loopStart : 0, loopEnd: hasLoop ? loopEnd : 0,
      }));
      continue;
    }

    // ONE BLOB PER NOTE, not per pitch class — and that is a measured choice
    // rather than the obvious one. Grouping by pitch class needs one blob for
    // every octave of it, because the mixer would reach the other octaves by
    // advancing 2^k bytes a tick; but a runtime-variable advance needs either a
    // branch (12 cycles) or a nop fill (4) inside the tick body, and that is
    // charged to EVERY baked tick including the k = 0 ones, against a baked
    // tick of 41. It buys sample ROM, which measures in hundreds of bytes
    // against a 32 KB window, with mixer cycles, which are the constraint this
    // whole exercise exists to relieve. So: every note gets its own blob, k is
    // always 0, and the mixer's advance stays a bare `inc de`.
    //
    // The hash pool below still collapses whatever is genuinely identical. If a
    // score ever does run the sample window out, the octave shift is the thing
    // to reach for — see driver.md §14.2.
    bakedSources++;
    bakedSourceBytes += data.length;
    const byNote = new Map();
    for (const n of notes) byNote.set(n, [n]);
    for (const [, ns] of byNote) {
      const anchor = ns[0];
      const to = pcmBakeRate(anchor);
      const b = hasLoop
        ? bakeLooped(data, rate, to, loopStart, loopEnd, s.name, diag)
        : { bytes: resample8(data, rate, to), loopStart: 0, loopEnd: 0 };
      const before = blobBytes.length;
      const off = intern(b.bytes);
      bakedBlobBytes += blobBytes.length - before;   // dedup hits cost nothing
      bakedEntries++;
      for (const n of ns) {
        const k = (n - anchor) / 12;
        // A pitch class is 12 apart by construction, so k is a whole number;
        // the guard is against a future change to the grouping, not the data.
        if (!Number.isInteger(k) || k < 0 || k > 15) {
          diag("warning", "W_MMB_BAKE_RANGE",
            `sample "${s.name}" note ${n} is ${k} octaves from its anchor; left unbaked`);
          continue;
        }
        entryIdFor.set(`${s.name}|${n}`, push({
          flags: (hasLoop ? 1 : 0) | 2 | (k << 4), off, len: b.bytes.length,
          rate: Math.round(to), loopStart: b.loopStart, loopEnd: b.loopEnd,
        }));
      }
    }
    // NO unbaked fallback entry. Every note this sample is played at came from
    // the same walk that built the plan, so a miss is impossible without a
    // change to the grouping above — and keeping one would carry a second full
    // copy of the blob for a case that cannot arise. A miss falls back to the
    // sample's lowest baked entry and says so.
  }

  // What baking cost, in the one unit that can run out. Reported rather than
  // silent: a sample played at many notes multiplies its blob, and the bank has
  // to fit one 32KB window (§12). Nothing here decides anything — it is the
  // number a composer needs to see before the window refuses the song.
  if (bakedBlobBytes > 0) {
    diag(
      "info",
      "I_MMB_BAKE_COST",
      `pitch baking: ${bakedEntries} entries from ${bakedSources} samples, ` +
        `${bakedBlobBytes} B of blobs (unbaked they were ${bakedSourceBytes} B)`,
    );
  }
  if (rows.length > 256) {
    diag("error", "E_MMB_SAMPLE_ENTRIES",
      `${rows.length} sample entries; the id byte holds 256`);
  }
  entries.u16(rows.length);
  entries.u16(PCM_BAKE_STAMP);   // the sample clock the baked blobs assume
  rows.forEach((r, id) => {
    entries.u8(id);
    entries.u8(r.flags);
    entries.u32(r.off);
    entries.u32(r.len);
    entries.u16(r.rate);
    entries.u32(r.loopStart);
    entries.u32(r.loopEnd);
  });
  return {
    bytes: [...entries.bytes, ...blobBytes],
    idFor: (name, note) => {
      const id = entryIdFor.get(`${name}|${note}`);
      if (id !== undefined) return id;
      const fb = fallbackFor.get(name);
      if (fb !== undefined) return fb;
      const any = [...entryIdFor.entries()].find(([k]) => k.startsWith(`${name}|`));
      if (any) {
        diag("warning", "W_MMB_BAKE_MISS",
          `sample "${name}" note ${note} has no baked entry; using its anchor`);
        return any[1];
      }
      return undefined;
    },
  };
}

