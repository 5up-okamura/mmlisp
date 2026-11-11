// A note's macros, a step at a time (_macroSteps, _scheduleMacro), its :keyon
// retriggers one at a time, and the macros a note binds on each kind of
// channel.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { clampForTarget, sampleCurveUnit, KEY_OFF_LEAD_SECS } from "./ir-utils.js";
import { scaleMacroSample, MACRO } from "./ir-player-shared.js";

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
    // The note's gate as its steps read it (_macroSteps): a held note's —
    // a hold, a note the track's next event closes (a full gate) — is open
    // until it is let go (_heldNote, below), and the steps wait at the
    // release for it.
    const G = { secs: gateSecs, frames: noteFrames };
    let endless = gateSecs > when + 1e8; // a run does not wait for a held note's
    const restarts = this._envRetrigs?.(G) ?? null;
    let restartWait = false;
    const nextRestart = () => {
      for (;;) {
        const r = restarts?.next();
        if (!r || r.done) return Infinity;
        if (r.value === null) { restartWait = true; return Infinity; } // its gate first
        if ("end" in r.value || r.value.t >= G.secs) return Infinity;
        if (r.value.t > when + 1e-6) return r.value.t;
      }
    };
    const segment = (at) => this._macroSteps(spec, null, {
      get secs() { return G.secs; },
      get frames() { return Math.max(1, G.frames - Math.round((at - when) * 60)); },
    }, at, stepSecs);
    let it = segment(when), cut = nextRestart();
    const scope = this._noteScope;
    const ours = () => !scope || this._noteOf[scope.ti] === scope.note;
    let run = {}, pending = null, parked = false;
    // A step already behind the run is written at once. With no run (the
    // keys while stopped, a run that is over) a minute is laid out, and a
    // held note's macro not at all: nothing steps it on.
    const pull = (dropped = false) => {
      const limit = Number.isFinite(this._writeCursor) ? Infinity
        : endless ? -Infinity : (this._audioContext?.currentTime ?? 0) + 60;
      for (;;) {
        const { value, done } = it.next(dropped ? false : undefined);
        dropped = false;
        if (done) {
          if (cut !== Infinity) { it = segment(cut); cut = nextRestart(); continue; }
          onEnd?.(value ?? null);
          return;
        }
        if (value.wait) {
          // Waiting for the gate: a :keyon retrigger before it starts over.
          if (cut !== Infinity) { it = segment(cut); cut = nextRestart(); continue; }
          parked = true; // the gate, when the note is let go
          return;
        }
        if ("k" in value) continue;
        const { v, t } = value;
        if (t >= cut - 1e-9) { it = segment(cut); cut = nextRestart(); continue; }
        if (t > limit) return;
        if (t <= this._writeCursor) {
          if (!ours()) return;
          writeFn(this._macroValue(spec, v, t), t);
          continue;
        }
        const mine = run;
        pending = { t, valid: value.valid };
        this._putWork(this._eventFrame(t), MACRO, t, () => {
          if (mine !== run || !ours()) return;
          pending = null;
          writeFn(this._macroValue(spec, v, t), t);
          pull();
        }, null, endless);
        return;
      }
    };
    // Let go at `off` (the host's key-off, triggerKeyOff; the track's next
    // event, _resolveOff): the gate closes there and the steps go on from
    // where they are — a step waiting that is no longer the note's (by its
    // own rule: a sustain's in the key-off's frame or after it, a curve's
    // past the note's frames) goes, and what follows it comes.
    if (endless && scope) this._heldNote(scope).push((off) => {
      if (!ours()) return;
      G.secs = off - KEY_OFF_LEAD_SECS;
      G.frames = Math.max(1, Math.floor((off - when) * 60 + 1e-6));
      endless = false;
      if (cut !== Infinity && cut >= G.secs) cut = Infinity;
      if (restartWait) { restartWait = false; cut = nextRestart(); }
      if (pending?.valid && !pending.valid()) {
        run = {};
        pending = null;
        pull(true);
      } else if (parked) {
        parked = false;
        pull();
      }
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
    const restarts = this._envRetrigs?.({ secs: gateSecs, frames: noteFrames }) ?? null;
    const starts = [when];
    for (const r of restarts ?? []) {
      if (r === null || "end" in r || r.t >= gateSecs || r.t > when + 60) break;
      if (r.t > when + 1e-6) starts.push(r.t);
    }
    let end = null;
    for (let i = 0; i < starts.length; i++) {
      const cut = starts[i + 1] ?? Infinity;
      const it = this._macroSteps(spec, Math.max(1, noteFrames - Math.round((starts[i] - when) * 60)), gateSecs, starts[i], stepSecs, !!marks);
      for (;;) {
        const { value, done } = it.next();
        if (done) { end = value; break; }
        if (value.wait || value.t >= cut - 1e-9 || value.t > when + 60) break;
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
    // The note's gate, read as the steps go: `gateSecs` a number, or a
    // holder { secs, frames } a held note's let-go closes (_scheduleMacro).
    // Where a step needs the gate closed — the release, a wait for key-off
    // — and it is not yet, { wait: true } is yielded until it is.
    const G = typeof gateSecs === "object" ? gateSecs : { secs: gateSecs, frames: noteFrames };
    const held = () => G.secs > when + 1e8;
    const offT = () => this._keyOffFrameTime(when, G.secs);
    // A sample in the key-off's frame is the release's: the driver leaves
    // for it before that frame's step.
    const offFrame = () => (held() ? Infinity : this._eventFrame(G.secs + KEY_OFF_LEAD_SECS));

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
          while (held()) yield { wait: true };
          // A tick clock counts the release from the key-off's tick; its first
          // sample still lands on the key-off's frame.
          t = tickClock ? G.secs + KEY_OFF_LEAD_SECS : offT();
        }
        // A :wait advances the time cursor. A pure wait stage (no curve) stops
        // here; a curve stage with :wait uses it as a pre-delay, then plays.
        const waitFrom = t;
        if (stage.waitKeyOff) {
          while (held()) yield { wait: true };
          t = Math.max(t, offT());
        }
        else if (stage.waitTicks != null)
          t = this._timeAfterTicks(t, Math.max(0, Number(stage.waitTicks)));
        else if (stage.waitFrames != null) t += stage.waitFrames / 60;
        if (mark && !stage.curve)
          for (let k = 0; k < shown[i]; k++) {
            const at = waitFrom + ((t - waitFrom) * k) / shown[i];
            if (!keyed || at < offT()) yield { k: shownAt[i] + k, t: at };
          }
        if (keyed && t >= offT() - 1e-9) {
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
          held() ? Infinity : Math.max(0, Math.ceil((offT() - t) * perSec) + stepUnits);
        const budget = !keyed
          ? loop ? 0 : baseFrames
          : loop
            ? untilOff === Infinity ? Math.max(0, Math.floor((G.secs - t) * perSec)) : untilOff
            : Math.min(baseFrames, untilOff);
        let cut = false;
        for (let frame = 0; frame < budget; frame += stepUnits) {
          if (keyed && this._eventFrame(adv(t, frame)) >= offFrame()) {
            cut = true;
            break;
          }
          const phase = loop
            ? (frame % baseFrames) / baseFrames
            : baseFrames <= 1
              ? 1
              : Math.min(1, frame / (baseFrames - 1));
          const v = from + (to - from) * share(sampleCurveUnit(curve, phase, params));
          const at = keyed ? adv(t, frame) : Math.max(offT(), adv(t, frame));
          // (a step the caller drops — a held note's, past where it was let
          // go — is not where its release starts from: next(false))
          // (`valid`: whether it is still the note's once its gate has moved)
          const taken = yield { v, t: at, valid: () => !keyed || this._eventFrame(at) < offFrame() };
          if (keyed && taken !== false) last = v;
          if (mark) yield { k: shownAt[i] + Math.min(shown[i] - 1, Math.floor((loop ? frame % baseFrames : frame) / stepUnits)), t: at };
        }
        t = cut ? offT() : adv(t, budget);
        if (keyed && (cut || t >= offT() - 1e-9)) i = rel - 1; // key-off: on to the release
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
      if (waitKeyOff) while (held()) yield { wait: true };
      const waitFrameOffset = waitKeyOff
        ? Math.max(0, Math.round((G.secs - when) * perSec))
        : tickClock
          ? Math.max(0, Math.round(Number(waitTicks ?? 0)))
          : waitFrames != null
            ? Math.max(0, Math.round(Number(waitFrames)))
            : Math.max(
                0,
                Math.round(Number(waitTicks ?? 0) * this._secsPerTick * 60),
              );
      const startWhen = waitKeyOff
        ? Math.max(when, G.secs)
        : adv(when, waitFrameOffset);
      // The note's frames left — its gate's, as it closes (a held note's).
      const activeFrames = () => {
        const remainingFrames = Math.max(0, (G.frames / 60) * perSec - waitFrameOffset);
        return waitKeyOff ? baseFrames : loop ? remainingFrames : Math.min(remainingFrames, baseFrames);
      };
      for (let frame = 0; frame < activeFrames(); frame += stepUnits) {
        const phase = loop
          ? (frame % baseFrames) / baseFrames
          : baseFrames <= 1
            ? 1
            : Math.min(1, frame / (baseFrames - 1));
        yield { v: from + (to - from) * sampleCurveUnit(curve, phase, params), t: adv(startWhen, frame), valid: () => frame < activeFrames() };
        if (mark) yield { k: Math.floor((loop ? frame % baseFrames : frame) / stepUnits), t: adv(startWhen, frame) };
      }
      return adv(startWhen, activeFrames());
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
      // (A step in the key-off's frame is the release's, see the stages form.)
      let t = when;
      let idx = 0;
      while (
        sustainEnd > 0 &&
        (held() ? true : this._eventFrame(t) < offFrame())
      ) {
        if (steps[idx] !== null && steps[idx] !== undefined)
          yield { v: steps[idx], t, valid: () => held() || this._eventFrame(t) < offFrame() };
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

      // Release phase after gate (steps after :off), spaced by :step too —
      // once the gate has closed.
      while (held()) yield { wait: true };
      const releaseAt = offT();
      if (releaseIndex !== null && releaseIndex < steps.length) {
        // A tick clock counts the release from the key-off's tick; its first
        // step still lands on the key-off's frame.
        const tick = spec.step?.unit === "tick";
        t = tick ? G.secs + KEY_OFF_LEAD_SECS : releaseAt;
        for (let ri = releaseIndex; ri < steps.length; ri++) {
          if (steps[ri] !== null && steps[ri] !== undefined)
            yield { v: steps[ri], t: tick ? Math.max(releaseAt, t) : t };
          if (mark) yield { k: ri, t: tick ? Math.max(releaseAt, t) : t };
          t = tickClock ? this._timeAfterTicks(t, stepUnits) : t + stepSecs;
        }
        return t; // time after last release write
      }
      return G.secs; // time at gate-off
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

  // The gap a :keyon retrigger keys off before it keys on again, so the
  // chip sees the transition: short, to keep the beat, under the key-off
  // lead (a step's 0.4 at most).
  _retrigGap(retrigs) {
    return Math.min(KEY_OFF_LEAD_SECS, Math.max(0.001, (retrigs?.step ?? 1 / 60) * 0.4));
  },

  // The times a note's `:keyon` macro re-attacks it (every sample ≥ 0.5 but
  // the first, which is the note's own attack), as one stream the note's
  // voice and its envelopes read alike (_noteRetriggers, _envRetrigs).
  // `G`: the gate as the steps read it ({ secs, frames }, _macroSteps) — a
  // held note's, closed when it is let go; a null is the steps waiting for
  // that. Each time comes as { t, valid } (_macroSteps' validity); the last
  // as { end }: a step after the macro's last, where an echo tail past the
  // note's close keys it off (_noteRetriggers).
  _keyonRetrigs(keyonSpec, when, gateTicks) {
    if (!keyonSpec) return null;
    const own = this._resolveNoteFramesAndGate(when, gateTicks);
    const stepSecs = this._stepSecs(keyonSpec.step);
    const self = this;
    const times = function* (G = { secs: own.gateSecs, frames: own.noteFrames }) {
      const it = self._macroSteps(keyonSpec, null, G, when, stepSecs);
      for (let r = it.next(); ; r = it.next()) {
        if (r.done) { yield { end: r.value ?? null }; return; }
        const x = r.value;
        if (x.wait) { yield null; continue; }
        if ("k" in x) continue;
        if (self._macroValue(keyonSpec, x.v, x.t) >= 0.5 && x.t > when + 1e-6) yield { t: x.t, valid: x.valid };
      }
    };
    times.endless = own.gateSecs > when + 1e8; // a held note's: until it is let go
    times.when = when;
    times.step = stepSecs;
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
    const off = Math.max(when, this._sentUntil() ?? when);
    const h = this._heldNotes.get(ti);
    this._heldNotes.delete(ti);
    if (!h || h.note !== this._noteOf[ti] || !h.release.length) return null;
    for (const f of h.release) f(off);
    return off;
  },

};
