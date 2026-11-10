// A note's macros, a step at a time (_macroSteps, _scheduleMacro), its :keyon
// retriggers one at a time, and the macros a note binds on each kind of
// channel.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { clampForTarget, sampleCurveUnit, KEY_OFF_LEAD_SECS } from "./ir-utils.js";
import { KEYED, OP_MACRO_MAP, scaleMacroSample, MACRO } from "./ir-player-shared.js";

export const macroMethods = {
  // A glide ended by its target's next write before it ran its length.
  // `endTick`: the sweep's end, when the dispatch has resolved it already.
  // Resolve a NOTE_ON `step` spec ({ unit, value }) to seconds per step.
  // Absent → one frame (1/60 s), the default :step.
  _stepSecs(stepSpec) {
    if (!stepSpec) return 1 / 60;
    if (stepSpec.unit === "tick")
      return Math.max(1, stepSpec.value) * this._secsPerTick;
    return Math.max(1, stepSpec.value) / 60; // frame
  },

  // A note's macro, a step at a time: each step is work of its frame, after
  // that frame's sweeps (MACRO), and pulls the next when it has written —
  // so a held note's macro runs as long as it sounds, and nothing is laid
  // out ahead. A note's macros are its own until the track's next note,
  // which takes the lane over on its frame (the driver's dispatch runs
  // before the frame's macros): a step after that writes nothing, and the
  // macro stops there. `onEnd(t)`: when it has written its last, the time
  // just after it (null for a macro that writes nothing).
  //
  // Restarted by the note's :keyon retriggers (_envRetrigs, set around an
  // envelope's scheduling): a run per keyed segment, each cut at the next
  // retrigger. A retrigger after key-off (an echo tail) leaves the release
  // playing: the taps step through it.
  _scheduleMacro(spec, noteFrames, gateSecs, when, writeFn, stepSecs = 1 / 60, onEnd = null) {
    if (!spec) return void onEnd?.(null);
    const restarts = this._envRetrigs?.() ?? null;
    const nextRestart = () => {
      for (;;) {
        const r = restarts?.next();
        if (!r || r.done || r.value >= gateSecs) return Infinity;
        if (r.value > when + 1e-6) return r.value;
      }
    };
    const segment = (at) => this._macroSteps(spec, Math.max(1, noteFrames - Math.round((at - when) * 60)), gateSecs, at, stepSecs);
    let it = segment(when), cut = nextRestart();
    // A held note's (its gate is the key-off's, _resolveNoteFramesAndGate)
    // runs until it is let go: a run does not wait for it.
    let endless = gateSecs > when + 1e8;
    const scope = this._noteScope;
    const ours = () => !scope || this._noteOf[scope.ti] === scope.note;
    let segAt = when, lastT = -Infinity, run = {};
    // A step already behind the run is written at once. With no run (the
    // keys while stopped, a run that is over) a minute is laid out, and a
    // held note's macro not at all: nothing steps it on.
    const pull = () => {
      const limit = Number.isFinite(this._writeCursor) ? Infinity
        : endless ? -Infinity : (this._audioContext?.currentTime ?? 0) + 60;
      for (;;) {
        const { value, done } = it.next();
        if (done) {
          if (cut !== Infinity) { it = segment((segAt = cut)); cut = nextRestart(); continue; }
          onEnd?.(value ?? null);
          return;
        }
        if ("k" in value) continue;
        const { v, t } = value;
        if (t >= cut - 1e-9) { it = segment((segAt = cut)); cut = nextRestart(); continue; }
        if (t <= lastT + 1e-9) continue; // written before the note was let go (below)
        if (t > limit) return;
        if (t <= this._writeCursor) {
          if (!ours()) return;
          lastT = t;
          writeFn(this._macroValue(spec, v, t), t);
          continue;
        }
        const mine = run;
        this._putWork(this._eventFrame(t), MACRO, t, () => {
          if (mine !== run || !ours()) return;
          lastT = t;
          writeFn(this._macroValue(spec, v, t), t);
          pull();
        }, null, endless);
        return;
      }
    };
    // A held note let go at `off` (the host's key-off, triggerKeyOff): the
    // macro goes on as a note's whose gate ends there — its sustain stops,
    // its release plays — from the step after the last it wrote.
    if (endless && scope) this._heldNote(scope).push((off) => {
      if (!ours()) return;
      run = {}; // the held run's waiting step is dropped
      endless = false;
      cut = Infinity;
      it = this._macroSteps(spec, Math.max(1, Math.round((off - segAt) * 60)), off - KEY_OFF_LEAD_SECS, segAt, stepSecs);
      pull();
    });
    this._macroShown(spec, noteFrames, gateSecs, when, stepSecs);
    pull();
  },

  // The panel's view of a note's macro: the steps its vector editor counts,
  // and a step vector outlined while it sounds — laid out for the eye only
  // (a held note's, its first minute).
  _macroShown(spec, noteFrames, gateSecs, when, stepSecs) {
    const marks = spec.src && this._onPosition ? [] : null;
    const seq = spec.src && spec.type === "steps" && this._onSeq;
    if (!marks && !seq) return;
    const restarts = this._envRetrigs?.() ?? null;
    const starts = [when];
    for (const r of restarts ?? []) {
      if (r >= gateSecs || r > when + 60) break;
      if (r > when + 1e-6) starts.push(r);
    }
    let end = null;
    for (let i = 0; i < starts.length; i++) {
      const cut = starts[i + 1] ?? Infinity;
      const it = this._macroSteps(spec, Math.max(1, noteFrames - Math.round((starts[i] - when) * 60)), gateSecs, starts[i], stepSecs, !!marks);
      for (;;) {
        const { value, done } = it.next();
        if (done) { end = value; break; }
        if (value.t >= cut - 1e-9 || value.t > when + 60) break;
        if (marks && "k" in value) marks.push([value.k, value.t]);
      }
    }
    if (marks?.length)
      this._onPosition({ kind: "macro", src: spec.src, marks, end: Math.max(end ?? gateSecs, marks.at(-1)[1] + stepSecs) });
    if (seq) {
      const now = this._audioContext.currentTime;
      this._scheduleUiCallback(() => this._onSeq(true, spec.src), Math.max(0, when - now) * 1000);
      const hideAt = end ?? gateSecs;
      if (Number.isFinite(hideAt) && hideAt < when + 1e8)
        this._scheduleUiCallback(() => this._onSeq(false, spec.src), Math.max(0, hideAt - now) * 1000);
    }
  },

  // A macro's sample as written at `t`: a scaled macro (§7.0) reads its
  // slot then — `(sample × slot) >> 8`, a per-frame depth knob, as the
  // driver reads it live per frame.
  _macroValue(spec, v, t) {
    return spec.scale != null ? scaleMacroSample(Math.round(v), this._resolveSrc(spec.scale, t)) : v;
  },

  // A macro's steps, one at a time — the core every target and type shares:
  // yields { v, t } for each write (the raw sample: a scale, `untilSecs` and
  // the note's scope are the caller's, _macroValue) and, with `withMarks`,
  // { k, t } for each step the panel's vector editor counts (edit-tools.js
  // vectorAt). Returns the time just after its last write (for scheduling
  // silence), or null if it writes nothing (a curve type, an empty one).
  // stepSecs is the per-step duration for step-vector macros (the :step
  // clock); curve/stage sampling stays at 60 Hz.
  *_macroSteps(spec, noteFrames, gateSecs, when, stepSecs = 1 / 60, withMarks = false) {
    if (!spec) return null;
    const mark = withMarks;

    // :step is the macro sampling clock. Curve/stage macros sample (and hold)
    // every stepFrames; default 1f = 1 frame = 60 Hz (smooth, unchanged). A
    // coarser :step gives a stepped / sample-and-hold curve.
    const stepFrames = Math.max(1, Math.round(stepSecs * 60));
    // The clock's unit: a 60 Hz frame, or — a tick :step — a tick of the
    // note's track, the lengths then in ticks too (mmlisp2ir resolveMacroLen),
    // so the steps land on the beat (driver.md §13.2). Lengths, budgets and
    // steps below are counted in it.
    const tickClock = spec.step?.unit === "tick";
    const unitSecs = tickClock ? this._secsPerTick : 1 / 60;
    const perSec = 1 / unitSecs;
    const stepUnits = tickClock ? Math.max(1, Math.round(spec.step.value)) : stepFrames;
    // A time `u` units after `t0`: a tick clock counts through the tempo
    // changes known ahead, as the driver's does.
    const adv = (t0, u) => (tickClock ? this._timeAfterTicks(t0, u) : t0 + u * unitSecs);
    const lenUnits = (o, raw) =>
      !tickClock
        ? this._resolveLenFrames(o, raw, when)
        : o.dyn?.len != null
          ? this._resolveLenFrames(o, raw, when) / (60 * this._secsPerTick)
          : Math.max(1, Math.round(Number(raw)));

    if (spec.type === "stages") {
      const { stages } = spec;
      if (!stages || stages.length === 0) return null;

      // The release boundary, where export-mmb lowerStages puts it: the first
      // (wait key-off), else the first curve stage after a looping one. At
      // key-off the driver leaves attack/sustain for the release from wherever
      // it is, on the key-off's own frame; a macro with no release stops there.
      let rel = stages.length;
      for (let i = 0, afterLoop = false; i < stages.length; i++) {
        const st = stages[i];
        if (st.waitKeyOff || (st.curve && afterLoop)) {
          rel = i;
          break;
        }
        if (st.curve && st.loop) afterLoop = true;
      }
      const offT = this._keyOffFrameTime(when, gateSecs);
      // A sample in the key-off's frame is the release's: the driver leaves
      // for it before that frame's step.
      const offFrame = offT === Infinity ? Infinity : this._eventFrame(gateSecs + KEY_OFF_LEAD_SECS);

      // Where each stage's steps start in the vector shown: a curve its
      // steps (a looping one, one cycle), a wait its holds.
      const shown = !mark ? null : stages.map((st) => {
        if (st.waitKeyOff) return 0;
        if (!st.curve) {
          const frames = st.waitTicks != null ? Number(st.waitTicks) * this._secsPerTick * 60 : Number(st.waitFrames ?? 0);
          return Math.max(0, Math.ceil((tickClock ? frames / (60 * this._secsPerTick) : frames) / stepUnits));
        }
        const base = lenUnits(st, st.frames ?? 1);
        return Math.max(1, (st.loop ? Math.round : Math.ceil)(base / stepUnits));
      });
      const shownAt = shown?.map((_, i) => shown.slice(0, i).reduce((a, b) => a + b, 0));

      let t = when;
      let last = null; // the last value written: a release without :from starts there
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const keyed = i < rel;
        if (i === rel) {
          if (offT === Infinity) break;
          // A tick clock counts the release from the key-off's tick; its first
          // sample still lands on the key-off's frame.
          t = tickClock ? gateSecs + KEY_OFF_LEAD_SECS : offT;
        }
        // A :wait advances the time cursor. A pure wait stage (no curve) stops
        // here; a curve stage with :wait uses it as a pre-delay, then plays.
        const waitFrom = t;
        if (stage.waitKeyOff) t = Math.max(t, offT);
        else if (stage.waitTicks != null)
          t = this._timeAfterTicks(t, Math.max(0, Number(stage.waitTicks)));
        else if (stage.waitFrames != null) t += stage.waitFrames / 60;
        if (mark && !stage.curve)
          for (let k = 0; k < shown[i]; k++) {
            const at = waitFrom + ((t - waitFrom) * k) / shown[i];
            if (!keyed || at < offT) yield { k: shownAt[i] + k, t: at };
          }
        if (keyed && t >= offT - 1e-9) {
          i = rel - 1; // key-off during a wait: on to the release
          continue;
        }
        if (!stage.curve) continue; // pure wait stage
        // Regular curve stage (dynamic :from/:to/:rate resolved per note)
        const { curve = "linear", frames: rawFrames = 1, loop = false } = stage;
        const fields = this._curveFields(stage, when);
        const to = fields.to ?? 0, params = fields.params;
        const from = stage.fromNow ? last ?? to : fields.from ?? 0;
        // A release from where the level is moves by the driver's share of
        // the way, r of stage.fromNow (export-mmb.js), so the preview and the
        // driver agree.
        const one = stage.fromNow;
        const share = (u) => (one ? 1 - Math.max(0, Math.min(one - 1, Math.round((1 - u) * one))) / one : u);
        const baseFrames = lenUnits(stage, rawFrames);
        // A looping stage runs until key-off; a keyed one-shot is cut there.
        const untilOff =
          offT === Infinity ? Infinity : Math.max(0, Math.ceil((offT - t) * perSec) + stepUnits);
        const budget = !keyed
          ? loop ? 0 : baseFrames
          : loop
            ? untilOff === Infinity ? Math.max(0, Math.floor((gateSecs - t) * perSec)) : untilOff
            : Math.min(baseFrames, untilOff);
        let cut = false;
        for (let frame = 0; frame < budget; frame += stepUnits) {
          if (keyed && this._eventFrame(adv(t, frame)) >= offFrame) {
            cut = true;
            break;
          }
          const phase = loop
            ? (frame % baseFrames) / baseFrames
            : baseFrames <= 1
              ? 1
              : Math.min(1, frame / (baseFrames - 1));
          const v = from + (to - from) * share(sampleCurveUnit(curve, phase, params));
          if (keyed) last = v;
          const at = keyed ? adv(t, frame) : Math.max(offT, adv(t, frame));
          yield { v, t: at };
          if (mark) yield { k: shownAt[i] + Math.min(shown[i] - 1, Math.floor((loop ? frame % baseFrames : frame) / stepUnits)), t: at };
        }
        t = cut ? offT : adv(t, budget);
        if (keyed && (cut || t >= offT - 1e-9)) i = rel - 1; // key-off: on to the release
      }
      return t;
    }

    if (spec.type === "curve") {
      const {
        frames: rawFrames = 1,
        loop,
        curve = "linear",
        waitTicks = null,
        waitFrames = null,
        waitKeyOff = false,
      } = spec;
      const { from, to, params } = this._curveFields(spec, when);
      // :len → 60 Hz frames (ticks by default, `Nf` as absolute frames, or a
      // dynamic slot resolved by its unit).
      const baseFrames = lenUnits(spec, rawFrames);
      const waitFrameOffset = waitKeyOff
        ? Math.max(0, Math.round((gateSecs - when) * perSec))
        : tickClock
          ? Math.max(0, Math.round(Number(waitTicks ?? 0)))
          : waitFrames != null
            ? Math.max(0, Math.round(Number(waitFrames)))
            : Math.max(
                0,
                Math.round(Number(waitTicks ?? 0) * this._secsPerTick * 60),
              );
      const startWhen = waitKeyOff
        ? Math.max(when, gateSecs)
        : adv(when, waitFrameOffset);
      const remainingFrames = Math.max(0, (noteFrames / 60) * perSec - waitFrameOffset);
      const activeFrames = waitKeyOff
        ? baseFrames
        : loop
          ? remainingFrames
          : Math.min(remainingFrames, baseFrames);
      for (let frame = 0; frame < activeFrames; frame += stepUnits) {
        const phase = loop
          ? (frame % baseFrames) / baseFrames
          : baseFrames <= 1
            ? 1
            : Math.min(1, frame / (baseFrames - 1));
        yield { v: from + (to - from) * sampleCurveUnit(curve, phase, params), t: adv(startWhen, frame) };
        if (mark) yield { k: Math.floor((loop ? frame % baseFrames : frame) / stepUnits), t: adv(startWhen, frame) };
      }
      return adv(startWhen, activeFrames);
    }

    if (spec.type === "steps") {
      const { steps, loopIndex, releaseIndex } = spec;
      if (!steps || steps.length === 0) return null;

      const sustainEnd = releaseIndex ?? steps.length;

      // Attack + sustain loop until gate, advancing one step per :step interval.
      // An empty sustain section (`[#rel ...]`, releaseIndex 0) writes nothing
      // before key-off — the target keeps its current value until the release.
      // Key-off leaves attack/sustain for the release on its own frame, as the
      // driver does (see the stages form).
      const offT = this._keyOffFrameTime(when, gateSecs);
      const releaseAt = offT === Infinity ? gateSecs : offT;
      // A step in the key-off's frame is the release's (see the stages form).
      const offFrame = offT === Infinity ? Infinity : this._eventFrame(gateSecs + KEY_OFF_LEAD_SECS);
      let t = when;
      let idx = 0;
      while (
        sustainEnd > 0 &&
        (offFrame === Infinity ? t < releaseAt - 1e-9 : this._eventFrame(t) < offFrame)
      ) {
        if (steps[idx] !== null && steps[idx] !== undefined)
          yield { v: steps[idx], t };
        if (mark) yield { k: idx, t };
        idx++;
        if (idx >= sustainEnd) {
          if (loopIndex !== null) {
            idx = loopIndex;
          } else {
            break; // one-shot: hold last attack step
          }
        }
        t = tickClock ? this._timeAfterTicks(t, stepUnits) : t + stepSecs;
      }

      // Release phase after gate (steps after :off), spaced by :step too
      if (releaseIndex !== null && releaseIndex < steps.length) {
        // A tick clock counts the release from the key-off's tick; its first
        // step still lands on the key-off's frame.
        const tick = spec.step?.unit === "tick" && offT !== Infinity;
        t = tick ? gateSecs + KEY_OFF_LEAD_SECS : releaseAt;
        for (let ri = releaseIndex; ri < steps.length; ri++) {
          if (steps[ri] !== null && steps[ri] !== undefined)
            yield { v: steps[ri], t: tick ? Math.max(releaseAt, t) : t };
          if (mark) yield { k: ri, t: tick ? Math.max(releaseAt, t) : t };
          t = tickClock ? this._timeAfterTicks(t, stepUnits) : t + stepSecs;
        }
        return t; // time after last release write
      }
      return gateSecs; // time at gate-off
    }

    return null;
  },

  // The time of the driver frame a note's key-off lands in, for a macro that
  // started with the note at `when` (the macro steps on the note's frames).
  // Infinity for a held note.
  _keyOffFrameTime(when, gateSecs) {
    if (gateSecs > when + 1e8) return Infinity;
    const k = this._eventFrame(gateSecs + KEY_OFF_LEAD_SECS) - this._eventFrame(when);
    return when + Math.max(0, k) / 60;
  },

  // A macro's first sample, on the note itself (`when`), or null: what a
  // key composes from, as the driver's note-on does (driver.md §7.2).
  _macroOnset(spec, when, gateTicks, target) {
    if (!spec) return null;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    for (const x of this._macroSteps(spec, noteFrames, gateSecs, when, this._stepSecs(spec.step))) {
      if ("k" in x) continue;
      return x.t <= when + 1e-9 ? clampForTarget(target, this._macroValue(spec, x.v, x.t)) : null;
    }
    return null;
  },

  // Schedule PAN and FM operator param macros embedded in NOTE_ON args.
  // Keys: pan → PAN, fm_tl1 → FM_TL1, etc. (snake_case from makeNoteArgs)
  _scheduleFmOpMacros(
    ch,
    noteArgs,
    when,
    gateTicks,
  ) {
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    const retrigs = this._envRetrigs;
    for (const [key, target] of OP_MACRO_MAP) {
      const spec = noteArgs[key];
      if (!spec) continue;
      const t = target; // capture for closure
      // :pan is a place, not an envelope: it runs on through a :keyon
      // retrigger, as :pitch/:semi do (driver.md §14).
      this._envRetrigs = key === "pan" ? null : retrigs;
      this._scheduleMacro(
        spec,
        noteFrames,
        gateSecs,
        when,
        (v, when) => {
          this._applyParam(
            ch,
            {
              cmd: "PARAM_SET",
              args: { target: t, value: v },
            },
            when,
          );
        },
        this._stepSecs(spec.step),
      );
    }
    this._envRetrigs = retrigs;
  },

  // A note's :vel and :vol macros, as one level: at every sample time of
  // either, the note's level is recomposed from both lines' live values (the
  // driver composes both every frame, §7). An FM3 operator's note writes that
  // operator's TL; a channel's, its carriers.
  // Schedule a pitch macro for any channel (FM or PSG).
  // writeFn(centOffset, t) performs the hardware write for the channel.
  // `offsetGetter`: when the macro is additive (`:pitch+`/`:semi+`), each sample
  // is composed with the channel's live pitch offset (read fresh so it rides a
  // running pitch sweep). Override macros (`:pitch`/`:semi`) pass it unchanged.
  _schedulePitchMacro(
    pitchMacro,
    when,
    gateTicks,
    writeFn,
    offsetGetter = null,
  ) {
    if (!pitchMacro) return;

    const wf =
      pitchMacro.add && offsetGetter
        ? (cents, t) => writeFn(cents + offsetGetter(), t)
        : writeFn;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(
      pitchMacro,
      noteFrames,
      gateSecs,
      when,
      wf,
      this._stepSecs(pitchMacro.step),
    );
  },

  // Schedule a :semi macro (discrete semitone offsets) on the pitch write path.
  // Reuses the pitch writeFn; semitone values are ×100 to cents.
  _scheduleSemiMacro(
    semiMacro,
    when,
    gateTicks,
    writeFn,
    offsetGetter = null,
  ) {
    if (!semiMacro) return;

    // The semitones stay whole (writeFn's third argument) so the channel's
    // `:snap` mask sees note + semi, as the driver's write_note_semi does.
    const wf =
      semiMacro.add && offsetGetter
        ? (semi, t) => writeFn(offsetGetter(), t, semi)
        : (semi, t) => writeFn(0, t, semi);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(
      semiMacro,
      noteFrames,
      gateSecs,
      when,
      wf,
      this._stepSecs(semiMacro.step),
    );
  },

  // Schedule a :keyon retrigger gate. Sampled per :step; a value >= 0.5 fires a
  // key-off→key-on (restarting the envelope). The t=0 sample coincides with the
  // note's own NOTE_ON and is a no-op. keyMask is the operators keyed.
  // `onEnd(t)`: the time after its last step (where the final key-off goes).
  _scheduleKeyonMacro(keyonSpec, keyMask, ch, when, gateTicks, onEnd) {
    if (!keyonSpec) return;

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    const stepSecs = this._stepSecs(keyonSpec.step);
    // Gap to register the key-off before re-keying; kept short so on-beat
    // timing stays accurate, capped below KEY_OFF_LEAD_SECS.
    const gap = Math.min(KEY_OFF_LEAD_SECS, Math.max(0.001, stepSecs * 0.4));
    this._scheduleMacro(
      keyonSpec,
      noteFrames,
      gateSecs,
      when,
      (v, t) => {
        if (v < 0.5) return; // gate closed this step
        if (t <= when + 1e-6) return; // first sample = note's own key-on
        if (this._csmKeysCh3(ch)) return; // Timer A retriggers CH3 in CSM
        this._fmKey(ch, 0, Math.max(when, t - gap)); // key off
        this._fmKey(ch, keyMask, t); // key on
      },
      stepSecs,
      onEnd,
    );
  },

  // The times a note's `:keyon` macro re-attacks it (every sample ≥ 0.5 but
  // the first, which is the note's own attack).
  _keyonRetrigs(keyonSpec, when, gateTicks, until = Infinity) {
    if (!keyonSpec) return null;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const stepSecs = this._stepSecs(keyonSpec.step);
    const self = this;
    const times = function* () {
      for (const x of self._macroSteps(keyonSpec, noteFrames, gateSecs, when, stepSecs)) {
        if ("k" in x) continue;
        if (x.t >= until) return;
        if (self._macroValue(keyonSpec, x.v, x.t) >= 0.5 && x.t > when + 1e-6) yield x.t;
      }
    };
    times.endless = gateSecs > when + 1e8 && until === Infinity; // a held note's: until it is let go
    return times;
  },

  // What a held note (`scope`: its track and note) does when it is let go.
  _heldNote(scope) {
    let h = this._heldNotes.get(scope.ti);
    if (h?.note !== scope.note) this._heldNotes.set(scope.ti, (h = { note: scope.note, release: [] }));
    return h.release;
  },

  // The host's key-off of track `ti`'s held note at `when`: its macros take
  // their release where the steps the run has sent end, its retriggers stop.
  // Returns that time (null: the track holds no note with macros).
  _letGoNote(ti, when) {
    this._letGo[ti] = this._noteOf[ti];
    const h = this._heldNotes.get(ti);
    this._heldNotes.delete(ti);
    if (!h || h.note !== this._noteOf[ti] || !h.release.length) return null;
    const off = Math.max(when, this._sentUntil() ?? when);
    for (const f of h.release) f(off);
    return off;
  },

  // `run(t)` at each of `retrigs`' times, one after the other, as work at
  // its time while the track's note is still the one dispatching now.
  _eachTime(retrigs, run, phase = KEYED) {
    if (!retrigs) return;
    const times = retrigs();
    const scope = this._noteScope;
    // (A held note's stop when it is let go: its gate has closed.)
    const ours = () => !scope || (this._noteOf[scope.ti] === scope.note && this._letGo[scope.ti] !== scope.note);
    const endless = !!retrigs.endless;
    const next = () => {
      for (;;) {
        const r = times.next();
        if (r.done) return;
        const t = r.value;
        if (t <= this._writeCursor) {
          // Behind the run: at once. With no run (it is over, or stopped) a
          // minute is laid out, and a held note's not at all (_scheduleMacro).
          if (!Number.isFinite(this._writeCursor) && (endless || t > (this._audioContext?.currentTime ?? 0) + 60)) return;
          if (!ours()) return;
          run(t);
          continue;
        }
        this._putWork(this._eventFrame(t), phase, t, () => {
          if (!ours()) return;
          run(t);
          next();
        }, null, endless);
        return;
      }
    };
    next();
  },

  // An FM3 operator's `:keyon` retriggers, a step at a time: each a key-off
  // and a key-on of this operator alone, merged with the other operators'
  // in its frame's $28 edges (_fm3Edge), before the note's key-off `until`.
  // Sampled as _scheduleKeyonMacro samples a channel's: the same :step
  // clock, the same gap.
  _fm3Retriggers(opBit, keyonSpec, when, gateTicks, until) {
    if (!keyonSpec) return;
    const op = Math.log2(opBit) - 4, gen = this._fm3KeyGen[op];
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const stepSecs = this._stepSecs(keyonSpec.step);
    const gap = Math.min(KEY_OFF_LEAD_SECS, Math.max(0.001, stepSecs * 0.4));
    this._scheduleMacro(keyonSpec, noteFrames, gateSecs, when, (v, t) => {
      if (v < 0.5 || t <= when + 1e-6 || t >= until - 1e-9) return;
      const F = this._eventFrame(t);
      this._fm3Edge(opBit, Math.max(when, t - gap), F, 1, op, false, gen);
      this._fm3Edge(opBit, t, F, 1, op, true, gen);
    }, stepSecs);
  },

  // A PSG note's macro on a register word (the SSG's mixer, its noise
  // period): each step written as it comes, where it moved.
  _schedulePsgWordMacro(spec, noteWhen, gateTicks, write) {
    if (!spec) return;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(noteWhen, gateTicks);
    let last = null;
    this._scheduleMacro(spec, noteFrames, gateSecs, noteWhen, (v, t) => {
      const r = Math.round(v);
      if (r !== last) write(r, t);
      last = r;
    }, this._stepSecs(spec.step));
  },

  _schedulePsgModeMacro(
    psgCh,
    modeMacro,
    noteWhen,
    gateTicks,
  ) {
    if (!modeMacro) return;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      noteWhen,
      gateTicks,
    );
    this._scheduleMacro(
      modeMacro,
      noteFrames,
      gateSecs,
      noteWhen,
      (v, t) => {
        this._psgSetNoiseCfg(this._snapMacroOutput("NOISE_MODE", v), t, psgCh);
      },
      this._stepSecs(modeMacro.step),
    );
  },
};
