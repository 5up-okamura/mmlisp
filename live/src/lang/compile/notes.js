// A note emitted on a track: its args, its tie, its glide, an FM3
// operator note, the CSM rate, a PCM note and its tie-off, the echo's
// replays and taps, the shuffle, the delay stamp.

import { csmTimerHz, csmTimerPeriod, pitchToMidi, midiToHz } from "../../ir/pitch.js";
import { makeEvalCtx, isConstNumberNode, readConstNumber, requireCurveFrom } from "./curves.js";
import { parseNumberLike, pushDiag, nodeSrc, atomValue } from "./diag.js";
import { targetDiag, PITCHED_PCM_MACRO_ARG_KEYS, PCM_MACRO_ARG_KEYS } from "./keywords.js";
import { resolveGateTicks, resolveMacroLen, midiToNoteParts, resolveLengthNode } from "./length.js";
import { scaleMacroValues, addMacroValues, resolveDelayVels } from "./macros.js";
import { evalScalarValue, evalValue } from "../mmlisp-eval.js";

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

export function emitCsmRateEvent(
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
export function emitCsmRateNoteHz(
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

export function isPcmModeSymbol(value) {
  return value === "shot" || value === "loop" || value === "gate";
}

// Optional source-edit analysis stays outside the public IR. Capture notation
// before :key and shuffle; the compiler still resolves snippets and state.
export function editableContext(state, length, note = null) {
  return {
    length, octave: state.defaultOct, sample: state.isPcmTrack ? state.pcmSampleName : null,
    slot: !!state.tuplet,
    pitch: note == null ? null : note + state.defaultOct,
    voice: state.isPcmTrack ? state.pcmSampleName
      : state.part?.kind === "wave" ? (state.activeMacros.WAVE ? null : state.editWaveName ?? null)
      : state.voiceName ?? (state.part?.kind === "fm" ? "init-fm" : null),
  };
}

export function emitEditableNote(state, name, nominal, events, diagnostics, src, trackName) {
  const context = state.noteAnalysis ? editableContext(state, nominal, name) : null;
  if (context && state.pendingLegato) context.tied = true;
  const start = events.length;
  const ticks = resolveShuffleTicks(nominal, state, diagnostics, src, trackName);
  // A TIE takes the context as it is made: a PCM tie moves the head's off from
  // before it, and may split it, so it is neither at `start` nor alone after.
  state.editing = context;
  emitNoteForTrack(state, name, ticks, events, diagnostics, src, trackName);
  state.editing = null;
  if (context) for (let i = start; i < events.length; i++) {
    if (events[i].cmd === "NOTE_ON" || events[i].cmd === "PCM_NOTE_ON") events[i]._edit = context;
  }
}

function pushTie(state, events, length, src) {
  const tie = { tick: state.tick, cmd: "TIE", args: { length }, src,
    ...(state.editing ? { _edit: state.editing } : {}) };
  events.push(tie);
  return tie;
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
  // The right side may be a generated (note ...), not an editable token.
  // Its connection still makes the preceding written note unsafe to edit.
  if (trackState.noteAnalysis && trackState.pendingLegato) {
    const head = trackState.isPcmTrack ? trackState.pcmTiedHead : trackState.tiedHead;
    if (head?.ev?._edit) head.ev._edit.tied = true;
  }
  // A `:key` voice moves the written note by its key − 60 (§9). Done here, at
  // the one entry every note takes, so ties, slurs, glides and echoes all see
  // the sounding pitch, as if it had been written.
  const shift = trackState.voiceKeyShift ?? 0;
  // Every written note is held to MIDI 0..127, as `(note …)` is: an octave
  // past the range (`:oct 11 c`) would otherwise play on the chip's top block.
  if (!trackState.isCsmRateTrack) {
    const midi = pitchToMidi(noteName + trackState.defaultOct) + (trackState.isPcmTrack ? 0 : shift);
    if (midi < 0 || midi > 127) {
      pushDiag(diagnostics, "error", "E_NOTE_RANGE",
        `note ${midi} out of MIDI range 0..127${shift && !trackState.isPcmTrack ? ` (the voice's :key moves it by ${shift})` : ""}`,
        src, trackName);
      trackState.tick += lengthTicks;
      return;
    }
  }
  if (shift !== 0 && !trackState.isPcmTrack && !trackState.isCsmRateTrack) {
    const midi = pitchToMidi(noteName + trackState.defaultOct) + shift;
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
      h.segs.push(pushTie(trackState, events, lengthTicks, src));
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
      pushTie(trackState, events, lengthTicks, src);
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
export function emitEvalNote(node, trackState, events, diagnostics, trackName, typedDefs, env) {
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
  // The shuffle warps the written length (§5.2).
  const ticks = resolveShuffleTicks(lengthTicks, trackState, diagnostics, nodeSrc(node), trackName);
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
export function connectionState(ts) {
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
export function restoreConnectionState(ts, st) {
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
export function connectAcrossJump(ts, events, fromIdx) {
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
export function noteUserPitchWrites(trackState, written) {
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
export function checkPartNotes(events, trackState, sampleDefs, diagnostics, trackName, shared = {}) {
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
export function readTapArgs(form, items, env, ctx, diagnostics, trackName, src) {
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
export function emitEchoReplay(trackState, events, spec, back, src) {
  const hist = trackState.recentNotes || [];
  if (!hist.length) return;
  const note = hist[Math.max(0, hist.length - back)]; // clamp to the oldest note
  if (!note) return;
  // mucom replays the echoed pitch at the *current* defaults (the `\` expansion
  // substitutes the bare note name, inheriting the current length `l` and gate
  // `q`), not the source note's length/gate. The taps are spaced by that
  // length, which is also what an envelope's tap count divides by.
  const nominal = trackState.defaultLength;
  const gate = trackState.defaultGate;
  for (const vel of resolveDelayVels(spec, nominal, note.vel ?? 15) ?? []) {
    const len = resolveShuffleTicks(nominal, trackState); // a tap is a slot of the grid (§5.2)
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

// How many passes of a loop body it takes to come back to the same place in
// the shuffle cycle (§5.2): 1 when the body spans whole cycles, else the passes
// written to a turn — null when that is more than the cycle has steps (a body
// ending off a step), or the body holds a label a copy would repeat. A body
// that sets the shuffle (`shuffleIn` is not the one in force) plays every
// pass as written, as it does a :len.
export function shufflePasses(trackState, phaseIn, shuffleIn, events, bodyIdx) {
  const sh = trackState.shuffle;
  if (!sh || sh !== shuffleIn) return 1;
  const d = (((trackState.shufflePhase - phaseIn) % sh.cycle) + sh.cycle) % sh.cycle;
  if (d === 0) return 1;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const k = sh.cycle / gcd(d, sh.cycle);
  if (k > sh.cuts.length - 1 || events.slice(bodyIdx).some((e) => e.cmd === "MARKER")) return null;
  return k;
}

export function shuffleLoopWarning(diagnostics, what, src, trackName) {
  pushDiag(diagnostics, "warning", "W_SHUFFLE_LOOP",
    `this ${what} ends elsewhere in the shuffle cycle than it starts, so its next pass falls on other steps, but it plays as written — write it in (x …), or make it span whole steps of the cycle`,
    src, trackName);
}

export function dropLoopBreaks(events, from, to, id) {
  for (let k = to - 1; k >= from; k--)
    if (events[k].cmd === "LOOP_BREAK" && events[k].args?.id === id) events.splice(k, 1);
}

// `:shuffle` (§5.2) warps the time of the :shuffle-base grid: step i of the
// cycle (N × base from the origin) plays as its share of the cycle, linearly
// within the step, so every onset and end lands on the warped grid whatever
// the lengths. `nominalTicks` is an item's written length; what it plays is
// the warped distance from where the track is to where the item ends. A note
// the warp squeezes to nothing keeps one tick, taken back from the items after
// it (a 0 would be a hold, §17).
export function resolveShuffleTicks(nominalTicks, trackState, diagnostics = null, src = null, trackName = null) {
  const sh = trackState.shuffle;
  if (!sh || !(nominalTicks > 0)) return nominalTicks;
  const at = (p) => {
    const i = Math.min(Math.floor(p / sh.base), sh.cuts.length - 2);
    return sh.cuts[i] + Math.round(((p - i * sh.base) * (sh.cuts[i + 1] - sh.cuts[i])) / sh.base);
  };
  const p = trackState.shufflePhase;
  const q = p + nominalTicks;
  const wraps = Math.floor(q / sh.cycle);
  const end = q - wraps * sh.cycle;
  let ticks = wraps * sh.cycle + at(end) - at(p);
  trackState.shufflePhase = end;
  if (ticks <= 0) {
    trackState.shuffleDebt += 1 - ticks;
    ticks = 1;
    if (diagnostics)
      pushDiag(diagnostics, "warning", "W_SHUFFLE_SQUEEZED",
        `the shuffle leaves this ${nominalTicks}-tick item no time; it plays one tick, taken from what follows`,
        src, trackName);
  } else if (trackState.shuffleDebt > 0) {
    const back = Math.min(trackState.shuffleDebt, ticks - 1);
    ticks -= back;
    trackState.shuffleDebt -= back;
  }
  return ticks;
}

// A cycle's steps → where each starts in the warped cycle.
export function makeShuffle(steps, base) {
  const cycle = steps.length * base;
  const total = steps.reduce((s, w) => s + w, 0);
  const cuts = [0];
  let acc = 0;
  for (const w of steps) cuts.push(Math.round((cycle * (acc += w)) / total));
  return { steps, base, cycle, cuts };
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
