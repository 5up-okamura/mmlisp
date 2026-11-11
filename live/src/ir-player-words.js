// A word's event, one rule on every track (_word): a value, a $slot, + and *,
// a sweep stepped a frame at a time in its slot, a stop; the value slots; the
// words of the FM and tone lanes.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { toSlotValue, VOL_UNITY, sampleSweepPhase, sampleCurveUnit, WAVE } from "./ir-utils.js";
import { curveId, sweepFrameValue } from "./mmb.js";
import { isSongWord, SLOT_FREEING, DRIVER_SWEEP_CURVES, SWEEP, SONG } from "./ir-player-shared.js";

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
    this._runSweep(this._slotKey(ev, target), isSongWord(target) ? SONG : SWEEP, sw, write);
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
    this._runSweep(this._slotKey(ev, target), isSongWord(target) ? SONG : SWEEP, {
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
    const slot = this._valNames?.indexOf(name);
    if (slot >= 0) this._slots.delete(`song:VAL${slot}`);
    this._vals[name] = v;
  },

  // ---- the song's words ----
  // A song-wide word (isSongWord), written on any track: where it is read
  // and how it is written, one table as a voice's words are — MASTER, a
  // value slot, the SSG's noise period and envelope rate, a wave chip's own
  // LFO words. A sweep without a :from starts at the word's value now and
  // each step writes the value (a `+` / `*` after it reads where it left
  // it). null where the machine has no such word (the FM's LFO words are an
  // FM channel's, _applyParam).
  _songWord(ev, target) {
    // A sweep's step is a score write at its own time: the panel's hand first.
    const gated = (id, write) => (v, t) => { if (this._scoreWrites(id)) write(v, t); };
    if (target === "MASTER") return {
      read: () => this._masterVol ?? VOL_UNITY,
      write: (v, t) => this._applyMasterChange(v, t),
    };
    const val = /^VAL(\d+)$/.exec(target);
    if (val) {
      // A value slot (`:name …`, language.md §8): the slot is its value now,
      // an i16; one in the panel's hand is skipped while held.
      const name = this._valNames?.[Number(val[1])];
      if (name == null || !this._scoreWrites(`val:${name}`)) return null;
      const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
      return {
        read: () => this._vals[name] ?? 0,
        write: gated(`val:${name}`, (v) => { this._vals[name] = i16(v); }),
      };
    }
    if (target === "NOISE_RATE") {
      const read = () => this._noiseRateBase ?? 9;
      const write = (v, t) => {
        this._noiseRateBase = v;
        this._psgWrites(this._psg((c) => c.noiseRate(v), "noiseRate"), t);
      };
      return { read, write, sweep: (e, when) => this._sweepUnits(e, when, read(), write) };
    }
    if (target === "ENV_RATE") {
      // 0 follows the writing track's notes (a tone lane's), from its next;
      // a rate is a cycle of the writing track's shape as it is now.
      const lane = this._toneEnc[ev._psgCh]?.part?.songWords?.("ENV_RATE") ? ev._psgCh : null;
      const by = lane != null ? { shape: this._psgEnv[lane], semi: this._envSemi[lane], detune: this._envDetune[lane] } : {};
      const read = () => this._envRate ?? 0;
      return {
        read,
        write: (v, t) => {
          this._envRate = v;
          this._envFollow = v ? null : this._toneEnc[lane]?.part?.kind !== "noise" ? lane : null;
          if (v) this._writeEnvPeriod(v, by, t);
        },
        sweep: (e, when) => {
          this._envFollow = null;
          this._sweepUnits(e, when, read(), (v, t) => this._writeEnvPeriod((this._envRate = v), by, t), 64);
        },
      };
    }
    // A wave chip with an LFO of its own (the PC Engine's, the FDS's
    // modulation) takes the song's LFO words it has, through its lane, so an
    // optional chip (the FDS) is started before its first write. (Its table,
    // LFO_WAVE, is written whole: _dispatchEvent.)
    const lfo = this._waveLfoRoute(target);
    if (lfo && lfo.word !== "lfoTable") {
      const read = () => this._waveLfo[lfo.word] ?? 0;
      const write = (v, t) => lfo.write((this._waveLfo[lfo.word] = Math.round(v)), t);
      return { read, write, sweep: (e, when) => this._sweepUnits(e, when, read(), gated(target, write)) };
    }
    return null;
  },

  getVal(name) {
    return this._vals?.[name] ?? 0;
  },

  // Elapsed 60 Hz frames since playback start, at audio time `when`.
  _valTime(when) {
    return Math.max(0, Math.round((when - (this._startAudioTime ?? 0)) * 60));
  },

  // Resolve a value source id: "$time" (built-in) or a slot name — its value
  // now. Slots are kept finite at write time (setVal); the finite guard here
  // is belt-and-braces so no dynamic-value path can ever hand NaN to
  // downstream math.
  _resolveSrc(src, when) {
    if (src === "$time") return this._valTime(when);
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

  // ---- a voice's pan ----
  // -1 (left) .. 1 (right), each chip writing it at its own resolution
  // (ir-utils panSide), kept by the site the track writes:
  //   fm    an FM channel's ($B4, with its AMS / FMS: chRegs)
  //   psg   a lane's own (the PC Engine's $05, the Game Boy's NR51)
  //   strk  a sample track's, which its hits key on with (_panOf)
  // A part has :pan where it says so (chips/parts.js `words`).
  _panSite(ev) {
    const r = ev._route;
    if (r?.core === "fm") return `fm:${ev._chIndex ?? 0}`;
    if (r?.core === "psg") return `psg:${ev._psgCh ?? 0}`;
    // The Mega Drive's PCM is one stream on fm6's DAC: its pan is fm6's.
    if (r?.core === "sample" && r.part?.name === "dac") return "fm:5";
    if (r?.core === "sample") return `strk:${ev._trackIndex}`;
    return null; // a MIDI channel's: the output's
  },
  _panOf(site) {
    return this._onVoice(site, "pan") ?? 0;
  },
  _setPan(site, v, when) {
    this._onVoice(site, "setPan", Math.max(-1, Math.min(1, Number(v) || 0)), when);
  },
  // :pan, on any track that has it: a value, `+` `*` `$slot`, a sweep — a
  // lane's on the encoder's fifteenths of a side, as its driver steps it.
  _panWord(ev) {
    const site = this._panSite(ev);
    if (!site) return null;
    const read = () => this._panOf(site);
    const write = (v, t) => this._setPan(site, v, t);
    return site.startsWith("psg:")
      ? { read, write, sweep: (e, when) => this._sweepUnits(e, when, read(), write, 15) }
      : { read, write };
  },

  // ---- a voice's :pitch and :snap ----
  // :pitch, on any pitched track: the voice's sticky offset in cents (_pt),
  // the plain note + offset sounding at once (_ptOffset) — an FM channel's,
  // an fm3 operator's own (driver.md §13.4), a lane's, a sample track's
  // onto the hits it sounds (a part that pitches its voice, chips/parts.js
  // `pitch`); a value, `+` `*` `$slot`, a sweep. null on a track without.
  _pitchWord(ev) {
    const r = ev._route;
    const fm = r?.core === "fm", op = fm ? this._fm3OpOf(ev) : 0;
    const site = fm ? (op ? `fm3op:${op}` : `fm:${ev._chIndex ?? 0}`)
      : r?.core === "psg" ? `psg:${ev._psgCh ?? 0}`
      : r?.core === "sample" && r.part?.pitch ? `strk:${ev._trackIndex}` : null;
    if (!site) return null;
    const P = this._pt(site);
    return {
      read: () => P.offset,
      write: (v, t) => {
        const cents = Math.round(v);
        if (!site.startsWith("strk:")) return void this._ptOffset(site, cents, t);
        P.offset = cents;
        for (const [voice, h] of this._chipPcm?.owner ?? []) if (h.ti === ev._trackIndex) this._ptOffset(`voice:${voice}`, cents, t);
      },
    };
  },
  // :snap, a channel's sticky mask (language.md §5.3): the sounding note
  // moves onto it at once — an FM channel's, CH3's on an fm3-N track (that
  // operator's note moves), a tone lane's. null on a track without.
  _snapWord(ev) {
    const r = ev._route;
    const fit = (v) => Math.max(0, Math.min(0xfff, Math.round(Number(v) || 0)));
    if (r?.core === "fm") {
      const ch = ev._chIndex ?? 0, op = this._fm3OpOf(ev), regs = this._chRegs[ch];
      return {
        read: () => regs.snap ?? 0,
        write: (v, t) => { regs.snap = fit(v); this._ptOffset(op ? `fm3op:${op}` : `fm:${ch}`, null, t); },
      };
    }
    if (r?.core === "psg") {
      const lane = ev._psgCh ?? 0;
      return {
        read: () => this._psgSnap[lane] ?? 0,
        write: (v, t) => {
          this._psgSnap[lane] = fit(v);
          if (!this._isNoiseLane(lane)) this._ptOffset(`psg:${lane}`, null, t);
        },
      };
    }
    return null;
  },

  // An FM channel's word (an fm3-N track's: that operator's where it has
  // its own, driver.md §13.4): _readParam and _applyParam.
  _fmWord(ch, ev) {
    const target = String(ev.args?.target ?? "").toUpperCase();
    return {
      read: () => this._readParam(ch, target),
      write: (value, t) => this._applyParam(ch, { ...ev, cmd: "PARAM_SET", args: { target, value } }, t),
    };
  },

  // A tone lane's word: where it is read and how it is written, or null
  // where the lane has none by that name.
  _psgWord(psgCh, target) {
    const int = (v) => Math.round(Number(v) || 0);
    switch (target) {
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
      default: return null;
    }
  },

  // A sweep holds a slot, as the driver's do (driver.md §4 step 3): a
  // song-wide word's (MASTER, LFO_RATE …) is the song's, any other its
  // channel's — an fm3 operator's its own. A value, a sweep or a stop of the
  // word from any track frees the slot (SLOT_FREEING), and the sweep's
  // frames still waiting for their time (_at) stop there; a `+`, a `*` or a
  // `$slot` moves the word and the sweep steps on.
  _slotKey(ev, target) {
    if (isSongWord(target)) return `song:${target}`;
    const r = ev._route;
    // A chip's sample track keeps its words (_sampleWord), and so its slots;
    // the Mega Drive's PCM's pan is fm6's (_panSite), in fm6's slot.
    if (r?.core === "sample" && r.part?.name !== "dac") return `strk${ev._trackIndex}:${target}`;
    if (r?.core === "sample" && target === "PAN") return "fm5:0:PAN";
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
