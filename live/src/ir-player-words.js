// A word's event, one rule on every track (_word): a value, a $slot, + and *,
// a sweep stepped a frame at a time in its slot, a stop; the value slots; the
// words of the FM and tone lanes.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { toSlotValue, VOL_UNITY, sampleSweepPhase, sampleCurveUnit, WAVE } from "./ir-utils.js";
import { curveId, sweepFrameValue } from "./mmb.js";
import { SONG_WORDS, SLOT_FREEING, DRIVER_SWEEP_CURVES, SWEEP, SONG } from "./ir-player-shared.js";

export const wordMethods = {
  // ---- a sweep ----
  // A sweep holds its word's slot and takes one step a frame from the frame
  // it is dispatched in (driver.md §4 step 3): a one-shot for its length,
  // its last step on its target; a loop curve until the slot is freed. A
  // step is made when the one before it has run — nothing of a sweep is
  // known ahead, so a track's loop that writes the word again starts it
  // over, and one from before the loop runs on through it, as the driver's.
  // `write(value, t)` moves the word. sw.valueAt / sw.timeOf: a sweep with
  // its own steps (a song rate's integers, a PCM point's).
  _runSweep(slot, phase, sw, write) {
    sw.next = 0;
    this._slots.set(slot, sw);
    const len = sw.loop ? Infinity : sw.baseFrames;
    const step = (i) => {
      const t = sw.timeOf ? sw.timeOf(i) : this._sweepFrameTime(sw, i);
      this._step(sw.startFrame + i, phase, t, () => {
        if (this._slots.get(slot) !== sw) return; // freed: a value, a sweep, a stop
        sw.next = i + 1;
        write(sw.valueAt ? sw.valueAt(i) : this._sweepAt(sw, i), t);
        if (this._slots.get(slot) !== sw) return;
        if (i + 1 < len) step(i + 1);
        else this._slots.delete(slot);
      }, null, sw.loop);
    };
    step(0);
  },

  // A word's sweep from any track: from where the word is (`cur`) unless it
  // names a :from (language.md §11), its length in frames — ticks at the
  // tempo of its start, or frames as written, or a slot's (by its :unit).
  _sweepWord(ev, when, cur, write) {
    const a = ev.args ?? {};
    const target = String(a.target ?? "").toUpperCase();
    const df = this._curveFields(a, when);
    const from = df.from != null ? Number(df.from) : cur;
    const sw = {
      from, to: Number(df.to ?? from), curve: a.curve ?? "linear", params: df.params,
      baseFrames: this._sweepLen(a, when), loop: !!a.loop,
      startWhen: when, startFrame: this._eventFrame(when),
    };
    this._runSweep(this._slotKey(ev, target), SONG_WORDS.has(target) ? SONG : SWEEP, sw, write);
    return sw;
  },

  _sweepLen(a, when) {
    return a.dyn?.len != null
      ? this._resolveLenFrames(a, null, when)
      : a.lenFrames
        ? Math.max(1, Math.round(Number(a.frames ?? 1)))
        : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
  },

  // A sweep counted in a word's own units (the SSG's noise period and
  // envelope rate, a pulse's duty, a wave chip's LFO): the driver's integer
  // steps, the word written where it moves.
  // `scale`: the steps a whole value's fraction (ENV_RATE's Hz).
  _sweepUnits(ev, when, start, write, scale = 1) {
    const a = ev.args ?? {};
    const df = this._curveFields(a, when);
    const from = Math.round(Number(df.from ?? start) * scale), to = Math.round(Number(df.to ?? from / scale) * scale);
    const len = this._sweepLen(a, when), loop = !!a.loop, id = curveId(a.curve);
    const target = String(a.target ?? "").toUpperCase();
    let last = null;
    // The driver's integer steps; the word is written where it moves.
    this._runSweep(this._slotKey(ev, target), SONG_WORDS.has(target) ? SONG : SWEEP, {
      loop, baseFrames: len, startWhen: when, startFrame: this._eventFrame(when),
      valueAt: (f) => sweepFrameValue(id, from, to, len, loop, f) / scale,
      timeOf: (f) => when + f / 60,
    }, (v, t) => {
      if (v !== last) write(v, t);
      last = v;
    });
  },

  // Dynamic values — host API to set/read a value slot by name. A slot is an
  // i16, and that is the only bound: `def-val`'s :from/:to are the live
  // slider's endpoints, not a limit on what the host may write (language.md
  // §8). Bounds are applied where a value is *used*, per target, by the same
  // clamps the driver applies — so the preview and MMLispDRV agree on any
  // value a host writes. A non-finite write is ignored, exactly as
  // drv-player.js ignores it, leaving the slot at its previous value.
  setVal(name, value) {
    const v = toSlotValue(value);
    if (v === null || !this._vals) return;
    // The latest write wins: the host's ends the score's sweep of the slot.
    if (this._valSweeps) delete this._valSweeps[name];
    this._vals[name] = v;
  },

  // The score writing a value slot (`:name …`, language.md §8): a song-wide
  // target, so it is handled here whichever track carries it. A sweep runs in
  // the slot's own sweep slot, as on the driver — a write ends it only where
  // the driver's would (a SET, a STOP or a new sweep), and a read in a frame
  // sees what the sweep wrote the frame before (_resolveSrc).
  _writeVal(ev, name, when) {
    if (name == null) return;
    // A slot in the panel's hand: skipped while held, taken back once let go.
    if (!this._scoreWrites(`val:${name}`)) return;
    const a = ev.args ?? {};
    const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
    const cur = this._resolveSrc(name, when);
    // A one-shot past its last frame has left the slot, its endpoint in it.
    const sw = this._valSweeps[name];
    if (sw && !sw.loop && this._eventFrame(when) - sw.startFrame - 1 >= sw.baseFrames - 1) {
      delete this._valSweeps[name];
      this._vals[name] = cur;
    }
    switch (ev.cmd) {
      case "PARAM_SET":
        delete this._valSweeps[name];
        this._vals[name] = i16(a.value ?? 0);
        break;
      case "PARAM_SWEEP_STOP":
        delete this._valSweeps[name];
        this._vals[name] = cur;
        break;
      case "PARAM_FROM_VAL":
        this._vals[name] = i16(this._resolveSrc(a.src, when));
        break;
      case "PARAM_ADD":
      case "PARAM_MUL":
        this._vals[name] = i16(this._writeValue(ev, cur, when));
        break;
      case "PARAM_SWEEP": {
        const df = this._curveFields(a, when);
        const baseFrames = a.dyn?.len != null
          ? this._resolveLenFrames(a, null, when)
          : a.lenFrames
            ? Math.max(1, Math.round(Number(a.frames ?? 1)))
            : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
        this._valSweeps[name] = {
          from: df.from != null ? Number(df.from) : cur,
          to: Number(df.to ?? 0),
          curve: a.curve ?? "linear",
          params: df.params,
          baseFrames,
          loop: !!a.loop,
          startFrame: this._eventFrame(when),
          prev: cur,
        };
        break;
      }
    }
  },

  getVal(name) {
    return this._vals?.[name] ?? 0;
  },

  // Elapsed 60 Hz frames since playback start, at audio time `when`.
  _valTime(when) {
    return Math.max(0, Math.round((when - (this._startAudioTime ?? 0)) * 60));
  },

  // Resolve a value source id: "$time" (built-in) or a slot name. Slots are kept
  // finite at write time (setVal); the finite guard here is belt-and-braces
  // so no dynamic-value path can ever hand NaN to downstream math.
  _resolveSrc(src, when) {
    if (src === "$time") return this._valTime(when);
    const sw = this._valSweeps?.[src];
    if (sw) {
      // The driver steps a sweep after the frame's events, so an event reads
      // the value the frame before wrote — the slot as it was, in the sweep's
      // own first frame. A finished one-shot holds its endpoint (_sweepAt).
      const k = this._eventFrame(when) - sw.startFrame - 1;
      if (k < 0) return sw.prev;
      return Math.max(-32768, Math.min(32767, Math.round(this._sweepAt(sw, k))));
    }
    const v = this._vals?.[src];
    return Number.isFinite(v) ? v : 0;
  },

  // A write's value from its word's value now (`cur`): a SET's, a `$slot`'s,
  // a `+` or a `*`, in the driver's arithmetic (opcodes.md PARAM_ADD /
  // PARAM_MUL / PARAM_MUL_VAL: a factor is unsigned 8.8 — a literal ×256
  // rounded, a slot the 8.8 itself, 256 = ×1 — and the product drops its
  // fraction). Null for any other event. Every word's relative write reads
  // here, whatever kind of track writes it.
  _writeValue(ev, cur, when) {
    const a = ev.args ?? {};
    switch (ev.cmd) {
      case "PARAM_SET": return Number(a.value ?? 0);
      case "PARAM_FROM_VAL": return this._resolveSrc(a.src, when);
      case "PARAM_ADD": return cur + this._resolveOperand(a.delta, when);
      case "PARAM_MUL": {
        const f = a.factor;
        const fixed = f && typeof f === "object" && "src" in f ? this._resolveSrc(f.src, when) : Math.round((Number(f) || 0) * 256);
        return Math.floor((Math.round(cur) * Math.max(0, Math.min(0xffff, fixed))) / 256);
      }
      default: return null;
    }
  },

  // Resolve a PARAM_ADD/MUL operand: a literal number or a { src } reference.
  _resolveOperand(operand, when) {
    if (operand && typeof operand === "object" && "src" in operand)
      return this._resolveSrc(operand.src, when);
    return Number(operand) || 0;
  },

  // Dynamic macro params: resolve a curve spec's dynamic :from/:to/:rate
  // (spec.dyn = { from?, to?, rate? } slot names) to current slot values at
  // `when` (note-on) — one read per note, so the value is constant for the
  // note. Returns { from, to, params } with the dynamic fields overridden.
  _curveFields(spec, when) {
    const dyn = spec.dyn;
    let { from, to, params } = spec;
    if (dyn) {
      if (dyn.from != null) from = this._resolveSrc(dyn.from, when);
      if (dyn.to != null) to = this._resolveSrc(dyn.to, when);
      if (dyn.rate != null)
        params = { ...params, rate: this._resolveSrc(dyn.rate, when) };
    }
    return { from, to, params };
  },

  // Length of a curve/stage in 60 Hz frames. A dynamic :len (spec.dyn.len) reads
  // the slot at note-on and interprets it by the slot's unit (frame as-is / tick
  // → tempo-relative); otherwise the static frames field (ticks, or Nf frames).
  _resolveLenFrames(spec, rawFrames, when) {
    if (spec.dyn?.len != null) {
      const raw = this._resolveSrc(spec.dyn.len, when);
      const unit = this._valUnits?.[spec.dyn.len] ?? "frame";
      return unit === "tick"
        ? Math.max(1, Math.round(raw * this._secsPerTick * 60))
        : Math.max(1, Math.round(raw));
    }
    return spec.lenFrames
      ? Math.max(1, Math.round(Number(rawFrames)))
      : Math.max(1, Math.round(Number(rawFrames) * this._secsPerTick * 60));
  },

  // A word's event, whatever track writes it and whatever the word: a value
  // or a `$slot` (written), a `+` or a `*` (from the word as it is now), a
  // sweep (from where it is unless it names a :from, a step a frame), a stop
  // (its slot is freed, _freeSlot: the word stays where the sweep left it).
  // `w` is the word on that track — { read(), write(v, t) }, and `sweep`
  // where its sweep counts in units of its own — or null where the track
  // has no such word.
  _word(ev, when, w) {
    if (!w || ev.cmd === "PARAM_SWEEP_STOP") return;
    if (ev.cmd === "PARAM_SWEEP")
      return void (w.sweep ? w.sweep(ev, when) : this._sweepWord(ev, when, w.read(), w.write));
    const v = this._writeValue(ev, w.read(), when);
    if (v != null && Number.isFinite(v)) w.write(v, when);
  },

  // An FM channel's word (an fm3-N track's: that operator's where it has
  // its own, driver.md §13.4): _readParam and _applyParam.
  _fmWord(ch, ev) {
    const target = String(ev.args?.target ?? "").toUpperCase();
    return {
      read: () => this._readParam(ch, target, this._fm3OpOf(ev)),
      write: (value, t) => this._applyParam(ch, { ...ev, cmd: "PARAM_SET", args: { target, value } }, t),
    };
  },

  // A tone lane's word: where it is read and how it is written, or null
  // where the lane has none by that name.
  _psgWord(psgCh, target) {
    const int = (v) => Math.round(Number(v) || 0);
    switch (target) {
      // Sticky mask (language.md §5.3); the sounding note moves onto it.
      case "SNAP": return {
        read: () => this._psgSnap[psgCh] ?? 0,
        write: (v, t) => {
          this._psgSnap[psgCh] = Math.max(0, Math.min(0xfff, int(v)));
          if (!this._isNoiseLane(psgCh))
            this._psgSetPitch(psgCh, this._psgCurrentMidi[psgCh] ?? 60, this._psgPitchOffset[psgCh] ?? 0, t);
        },
      };
      // The fader: a keyed lane's level moves with it now (an idle one's
      // would drone a tone; its next note composes from it).
      case "VOL": return {
        read: () => this._lv(`psg:${psgCh}`).vol,
        write: (v, t) => {
          this._lvSetVol(`psg:${psgCh}`, v);
          if (this._psgKeyed(psgCh, t)) this._psgRecompose(psgCh, t);
        },
      };
      // The lane's level on the envelope (a shape), or its own (-1): a
      // sounding note changes over now; the shape starts at its key-on.
      case "SSG_ENV": return {
        read: () => this._psgEnv[psgCh] ?? -1,
        write: (v, t) => {
          const shape = Math.round(Number(v));
          this._psgEnv[psgCh] = !(shape >= 0) ? -1 : Math.min(15, shape);
          if (this._psgSounding[psgCh] && this._psgKeyed(psgCh, t)) this._psgRecompose(psgCh, t);
        },
      };
      // The lane's moves on its envelope's period: a period following its
      // notes moves now, a rate it writes at its next write.
      case "ENV_SEMI":
      case "ENV_DETUNE": {
        const of = target === "ENV_SEMI" ? this._envSemi : this._envDetune;
        return {
          read: () => of[psgCh] ?? 0,
          write: (v, t) => {
            of[psgCh] = int(v);
            if (this._envFollow === psgCh && this._psgHz[psgCh] > 0)
              this._writeEnvPeriod(this._psgHz[psgCh], this._envBy(psgCh), t);
          },
        };
      }
      // The SSG channel's mixer: tone, noise or both (chips/ssg.js).
      case "SSG_MIX": return {
        read: () => this._ssgMixBase[psgCh] ?? 0,
        write: (v, t) => {
          this._ssgMixBase[psgCh] = int(v);
          this._psgWrites(this._lane(psgCh, (e, ch) => e.mix(ch, this._ssgMixBase[psgCh], t)), t);
        },
      };
      // :lfo-sync: the lane's key-ons start the chip's LFO over.
      case "LFO_SYNC": return {
        read: () => (this._laneLfoSync[psgCh] ? 1 : 0),
        write: (v) => { this._laneLfoSync[psgCh] = Number(v) >= 0.5; },
      };
      // Channel 1 taking the wave chip's LFO (chips/huc6280.js).
      case "FM_FMS": return {
        read: () => this._laneFms?.[psgCh] ?? 0,
        write: (v, t) => {
          (this._laneFms ??= [])[psgCh] = Number(v);
          this._psgWrites(this._lane(psgCh, (e, ch) => e.lfo?.(ch, Number(v)) ?? []), t);
        },
      };
      // A pulse's duty in sixteenths; the encoder takes the nearest the
      // chip has. Its sweep steps in the driver's integers.
      case "DUTY": {
        const read = () => this._psgDuty[psgCh] ?? 8;
        const write = (v, t) => this._psgSetDuty(psgCh, v, t);
        return { read, write, sweep: (ev, when) => this._sweepUnits(ev, when, read(), write) };
      }
      // A channel's own pan (the PC Engine's $05), its sweep on the
      // encoder's fifteenths of a side.
      case "PAN": {
        const read = () => this._psgPan[psgCh];
        const write = (v, t) => this._psgSetPan(psgCh, v, t);
        return { read, write, sweep: (ev, when) => this._sweepUnits(ev, when, read(), write, 15) };
      }
      // A wave channel's def-wave (metadata.waves): its memory written
      // whole (chips/k051649.js — channels 4 and 5 share one).
      case "WAVE": return {
        read: () => this._laneWaveAt?.[psgCh] ?? -1,
        write: (v, t) => {
          this._laneExpr[psgCh] = null;
          (this._laneWaveAt ??= [])[psgCh] = v;
          this._writeLaneWaveIndex(psgCh, v, t);
        },
      };
      // The persistent noise mode, re-asserted on every noise NOTE_ON; a
      // sounding channel takes it now.
      case "NOISE_MODE": return {
        read: () => this._psgNoiseMode,
        write: (v, t) => {
          this._psgNoiseMode = this._snapMacroOutput("NOISE_MODE", v);
          if (this._psgSounding[psgCh]) this._psgSetNoiseCfg(this._psgNoiseMode, t, psgCh);
        },
      };
      // The lane's offset, on the note sounding then.
      case "NOTE_PITCH": return {
        read: () => this._psgPitchOffset[psgCh] ?? 0,
        write: (v, t) => {
          const cents = Math.round(v);
          this._psgPitchOffset[psgCh] = cents;
          this._psgSetPitch(psgCh, this._psgCurrentMidi[psgCh] ?? 60, cents, t);
        },
      };
      default: return null;
    }
  },

  // A score write of MASTER on any track: a value, a `$slot`, `+` / `*` from
  // the master now, a sweep (from the master now unless it names a :from),
  // a stop (its slot freed, the master stays where the sweep left it).
  _masterEvent(ev, when) {
    this._word(ev, when, {
      read: () => this._masterVol ?? VOL_UNITY,
      write: (v, t) => this._applyMasterChange(v, t),
    });
  },

  // A sweep holds a slot, as the driver's do (driver.md §4 step 3): a
  // song-wide word's (MASTER, LFO_RATE …) is the song's, any other its
  // channel's — an fm3 operator's its own. A value, a sweep or a stop of the
  // word from any track frees the slot (SLOT_FREEING), and the sweep's
  // frames still waiting for their time (_at) stop there; a `+`, a `*` or a
  // `$slot` moves the word and the sweep steps on.
  _slotKey(ev, target) {
    if (SONG_WORDS.has(target)) return `song:${target}`;
    const r = ev._route;
    // A chip's sample track keeps its words (_sampleWord), and so its slots.
    if (r?.core === "sample" && r.part?.name !== "dac") return `strk${ev._trackIndex}:${target}`;
    return `${r?.core}${r?.lane}:${this._fm3OpOf(ev)}:${target}`;
  },

  _freeSlot(ev) {
    if (!this._slots.size || !SLOT_FREEING.has(ev.cmd)) return;
    this._slots.delete(this._slotKey(ev, String(ev.args?.target ?? "").toUpperCase()));
  },

  // A sweep's value on its `frame`-th frame (0 = the frame it starts). The
  // curves the driver computes (driver.md §8) step the driver's integers
  // exactly; the rest (the wider easing families, the stochastic curves, a
  // :phase/:rate) sample the float curve, which the driver lowers to a
  // nearest shape.
  _sweepAt(sw, frame) {
    const id = DRIVER_SWEEP_CURVES.has(sw.curve) ? curveId(sw.curve) : null;
    if (id != null && sw.params?.phase == null && sw.params?.rate == null)
      return sweepFrameValue(
        id, Math.round(sw.from), Math.round(sw.to), sw.baseFrames, !!sw.loop, frame,
      );
    const phase = sampleSweepPhase(frame, sw.baseFrames, !!sw.loop, 0);
    return sw.from + (sw.to - sw.from) * sampleCurveUnit(sw.curve, phase, sw.params);
  },

  _sweepFrameTime(sw, k) {
    return Math.max(sw.startWhen, this._frameOrigin + (sw.startFrame + k) / 60);
  },
};
