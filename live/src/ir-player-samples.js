// The sample voices: the Mega Drive's PCM (the worklet's model, fed the
// score's events) and the chips' own — the YM2608's ADPCM-B and rhythm, PCM8,
// the DDA, the DMC, the OPLL's rhythm — each voice's sounding hit writing its
// level, pitch and tune when one moves.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { clampForTarget, pitchToMidi, levelOffset, levelSteps, levelGain, VOL_UNITY, KEY_ORDER_EPS_SECS } from "./ir-utils.js";
import { curveId, curveUnit8, sweepValue, sweepStep } from "./mmb.js";
import { engineImage } from "./engine-images.js";
import { ROM_SOUND_SEC } from "./chips/rhythm-rom.js";
import { PCM8_RATE } from "./chips/msm6258.js";
import { DDA_RATE, ddaStep } from "./chips/huc6280.js";
import { dmcRate, dmcRates, dmcLevels, dmcEncode } from "./chips/rp2a03.js";
import { DDA_HOLD_SEC, DMC_LOAD_LEAD_SECS, PCM_LOOP_MAX, VOICES, PCM_SWEEP_AFTER, PCM_POINT_TARGETS, macroLeadsWithHold, SWEEP, MACRO, AFTER } from "./ir-player-shared.js";

// A part's words that set where its next notes play: their range and
// loop (seconds as heard), each a value of the track's state `st`.
function rangeWords(st, loop = true) {
  const w = (o, k, other) => ({
    read: () => st[o]?.[k] ?? 0,
    write: (v) => { (st[o] ??= {})[k] = Number(v); if (other) st[o][other] = null; },
  });
  return {
    RANGE_START: w("range", "start"), RANGE_END: w("range", "end", "len"), RANGE_LEN: w("range", "len", "end"),
    ...(loop ? { LOOP_START: w("loop", "start"), LOOP_END: w("loop", "end", "len"), LOOP_LEN: w("loop", "len", "end") } : {}),
  };
}

// A chip-own sample voice's level from vel + vol + master + its strip, on
// its part's ladder (chips/parts.js `level`): the rhythm's IL attenuation
// (unclamped — a sound falling past what the IL reaches is dumped), the
// ADPCM-B's linear register, PCM8's gain.
function rhythmAtt(level, { vel, vol, master }) {
  return levelOffset(level, { vel, faders: [vol, master] });
}

function pcm8Gain({ vel, vol, master }) {
  return levelGain({ vel, faders: [vol, master] });
}

function adpcmLevel(level, { vel, vol, master }) {
  return Math.round((level.steps - 1) * levelGain({ vel, faders: [vol, master] }));
}

export const sampleMethods = {
  // PCM track dispatch. The worklet runs the driver's own voice model and
  // engine on the score's baked bank (worklet.js _applyPcmEvent), so what goes
  // across is the score's events — note, release, level, master, loop point —
  // timed, in the order the driver's sequencer would act on them. Global
  // events (tempo/markers/loops) are handled by _dispatchGlobalEvent first.
  // A sample part whose sound is elsewhere (the MIDI drums): nothing to write.
  _dispatchNothing() {},

  _dispatchDacEvent(ev, when) {
    const voice = ev._chIndex ?? 0;
    switch (ev.cmd) {
      case "PCM_NOTE_ON":
        this._dispatchPcmNoteOn(ev, when);
        break;
      case "PCM_NOTE_OFF":
        this._pcmEv(when, { kind: ev.args?.mode === "gate" ? "cut" : "off", voice });
        break;
      // A word, every way it is written (_word).
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._pcmWord(voice, String(ev.args?.target ?? "").toUpperCase()));
        break;
      default:
        break;
    }
  },

  _pcmEv(when, fields) {
    // A strip in the panel's hand: its value is the voice's :vol.
    const hand = this._handVol(`pcm:${fields.voice}`);
    if (hand != null) {
      if (fields.kind === "vol") fields = { ...fields, value: hand };
      else if (fields.kind === "on" || fields.kind === "retrig") fields = { ...fields, vol: hand };
    }
    if (fields.kind === "master" && this._masterHand) fields = { ...fields, value: this._masterHand.v };
    this._write({ type: "pcm-ev", when, ...fields });
  },

  // A point, from the IR's seconds to the engine's byte offset — the
  // same multiply and clamp the MMB exporter applies (export-mmb.js
  // targetValue), at the rate of the image the score names.
  _pcmLoopBytes(sec) {
    const rate = this._pcmBankRate ?? engineImage(Math.max(1, this._ir?.metadata?.pcmVoices ?? 1), this._ir?.metadata?.frameHz).rateHz;
    return Math.max(0, Math.min(PCM_LOOP_MAX, Math.round(Number(sec ?? 0) * rate)));
  },

  // A PCM voice's word (the Mega Drive's): its fader — a sweep steps the
  // voice's bank a frame at a time, as the driver's sweep engine does
  // (driver.md §14), written where it moves — its :vel, and its sample's
  // points; null for the words only FM and PSG have.
  _pcmWord(voice, target) {
    if (target === "VOL" || target === "VEL") {
      // Its level's (_lv): the engine's model composes it, from these.
      const L = this._lv(`pcm:${voice}`);
      const kind = target === "VOL" ? "vol" : "vel";
      const fit = (v) => Math.max(0, Math.min(target === "VOL" ? 31 : 15, Math.round(v)));
      const read = () => L[kind];
      const write = (v, t) => this._pcmEv(t, { kind, voice, value: (L[kind] = fit(v)) });
      return {
        read, write,
        sweep: (ev, when) => this._sweepWord(ev, when, read(), (v, t) => { if (L[kind] !== fit(v)) write(v, t); }),
      };
    }
    if (PCM_POINT_TARGETS.has(target)) return {
      read: () => this._pcmPointNow?.[`${voice}:${target}`] ?? 0,
      write: (v, t) => {
        (this._pcmPointNow ??= {})[`${voice}:${target}`] = v;
        this._pcmEv(t, { kind: "point", voice, target, value: this._pcmLoopBytes(v) });
      },
      sweep: (ev, when) => this._schedulePcmLoopSweep(voice, ev, when),
    };
    return null;
  },

  // The chips' own sample voices — the YM2608's ADPCM-B and rhythm, PCM8,
  // the DDA, the OPLL's rhythm — and their levels, which move while they
  // sound: the track's :vol and :pitch (a value, a sweep, a $slot), the
  // note's :vel / :vol / :pitch / :semi macros, :master and the panel's
  // strip. A voice belongs to the hit that last keyed it (`owner`); each of
  // those moves writes the owner's level, pitch and tune as they are then,
  // where they moved (_chipPcmWrite), as an FM channel's and a tone lane's
  // are. A rhythm sound's IL stops 23 dB down, so one fading below it (or
  // a :vol 0) is dumped instead.
  _chipPcmState() {
    return (this._chipPcm ??= {
      cents: new Map(), // track → its :pitch, in cents (its :vol is _lv(`strk:…`)'s)
      owner: new Map(), // voice ("adpcm", a rhythm sound, "pcm8-0", "dda-0" …) → the hit sounding on it
      lane: new Map(), // a kit's channel → the hit that last keyed it (a pair's tune, _chipPcmWrite)
      frames: false, // a DDA frame is waiting (_chipPcmFrame)
    });
  },

  // A sample track's word: its fader and its pitch, which its sounding hits
  // follow, and the words of its part (`own`: { WORD: { read, write } }).
  _sampleWord(ev, own = {}) {
    const ti = ev._trackIndex;
    const target = String(ev.args?.target ?? "").toUpperCase();
    const st = this._chipPcmState();
    const moved = (t) => { for (const [voice, h] of st.owner) if (h.ti === ti) this._chipPcmWrite(voice, t); };
    if (target === "VOL" && !own.noVol) return {
      read: () => this._lv(`strk:${ti}`).vol,
      write: (v, t) => { this._lvSetVol(`strk:${ti}`, v); moved(t); },
    };
    if (target === "NOTE_PITCH" && own.pitch) return {
      read: () => st.cents.get(ti) ?? 0,
      write: (v, t) => { st.cents.set(ti, v); moved(t); },
    };
    return own[target] ?? null;
  },

  // A hit (or an ADPCM-B note) keyed on `voice`: its own :vel / :vol /
  // :pitch / :semi macros run from it a step at a time, and each :keyon
  // step re-keys the voice — a hit of its own, its level envelopes starting
  // over with it, as on FM and PSG (a gate or loop note's only inside its
  // gate). `key(t, hit)` writes a key: the first, then each step's.
  _chipPcmHit(voice, ev, when, end, fields, key) {
    const st = this._chipPcmState();
    const { keyon, velMacro, vol: volMacro, pitchMacro, note_semi: semiMacro } = ev.args ?? {};
    const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const held = ev.args?.mode === "gate" || ev.args?.mode === "loop";
    const retrigs = this._keyonRetrigs(keyon, when, gateTicks, held ? gateSecs : Infinity);
    // The note's macros as they are now, shared by its retriggers' hits.
    const macros = [[velMacro, "vel", "VEL"], [volMacro, "vol", "VOL"], [pitchMacro, "cents", "NOTE_PITCH"], [semiMacro, "semi", "NOTE_SEMI"]];
    const onset = {};
    for (const [spec, k, target] of macros) onset[k] = this._macroOnset(spec, when, gateTicks, target);
    const mac = { ...onset };
    // A note under a running :pitch sweep sounds from the sweep's value on
    // its frame, as an FM or tone note does (_onsetPitchOffset).
    const sw = this._slots.get(this._slotKey(ev, "NOTE_PITCH"));
    if (sw) st.cents.set(ev._trackIndex, this._sweepAt(sw, sw.next));
    const hit = { t: when, end, voice, ti: ev._trackIndex, vel: Number(ev.args?.vel ?? 15), mac, ...fields };
    // A tuned hit's (the OPLL rhythm's) pitch runs its note's whole length:
    // the channel keeps moving through the sound's release.
    const slot = fields.tune ? this._resolveNoteFramesAndGate(when, ev.args?.length ?? gateTicks) : null;
    this._envRetrigs = retrigs;
    for (const [spec, k, target] of macros) {
      if (!spec) continue;
      const span = slot && (k === "cents" || k === "semi") ? slot : { noteFrames, gateSecs };
      this._scheduleMacro(spec, span.noteFrames, span.gateSecs, when, (v, t) => {
        mac[k] = clampForTarget(target, v);
        if (st.owner.get(voice)?.mac === mac) this._chipPcmWrite(voice, t);
      }, this._stepSecs(spec.step));
    }
    this._envRetrigs = null;
    const keyHit = (h) => {
      // The track's own sound on the channel ends at its next note (not at a
      // retrigger of the same note, which plays over it).
      const prev = st.owner.get(voice);
      if (prev?.dda != null && prev.ti === h.ti && prev.mac !== h.mac && !prev.dumped && prev.end > h.t) {
        prev.end = h.t;
        this._ddaFrame(prev, h.t);
      }
      st.owner.set(voice, h);
      const lane = this._routes.get(h.ti)?.part?.kitLane?.[voice];
      if (lane != null) st.lane.set(lane, h);
      key(h.t, h);
      if (h.dda != null && !st.frames) {
        st.frames = true;
        this._chipPcmNext(this._eventFrame(h.t));
      }
    };
    const fresh = { ...hit }; // a retrigger's hit starts as the note's did
    keyHit(hit);
    // A retrigger keys at its time, before its frame's steps: its level
    // envelopes start over there, from their first samples.
    this._eachTime(retrigs, (t) => {
      for (const k of ["vel", "vol"]) if (onset[k] != null) mac[k] = onset[k];
      keyHit({ ...fresh, t, end: end + (t - when) });
    });
    return hit;
  },

  // The hit that holds `voice` now, if it is `ti`'s: a gate's end stops
  // only the track's own sound.
  _chipPcmOwnHit(voice, ti) {
    const h = this._chipPcm?.owner.get(voice);
    return h?.ti === ti ? h : null;
  },

  // A hit's level now: { vel, vol, master }.
  _chipPcmLevelAt(hit) {
    return {
      vel: hit.mac.vel ?? hit.vel,
      vol: this._handVol(`voice:${hit.voice}`) ?? hit.mac.vol ?? this._lv(`strk:${hit.ti}`).vol,
      master: this._handMaster() ?? this._masterVol ?? VOL_UNITY,
    };
  },

  // A hit's pitch move now, in cents: the track's :pitch and the note's
  // :pitch / :semi macros.
  _hitCents(hit) {
    return (this._chipPcm.cents.get(hit.ti) ?? 0) + (hit.mac.cents ?? 0) + 100 * (hit.mac.semi ?? 0);
  },

  // The ADPCM-B's Delta-N for a hit now: its note and its pitch move over
  // the sample's rate.
  _adpcmDeltaN(hit) {
    const enc = this._target.chipFor("adpcm-b").adpcm;
    return enc.deltaN(hit.rate * 2 ** ((hit.midi - 60) / 12 + this._hitCents(hit) / 1200));
  },

  // The DDA's frame `k`, as work of the frame once its steps are done
  // (VOICES): each sounding hit's samples on the CPU's timer, and its end.
  // The frames go on while a hit has samples to write.
  _chipPcmNext(k) {
    const st = this._chipPcm;
    let more = false;
    for (const h of st.owner.values()) if (h.dda != null && !h.dumped) more = true;
    if (!more) { st.frames = false; return; }
    const t = this._frameOrigin + k / 60;
    this._step(k, VOICES, t, () => {
      if (this._chipPcm !== st) return;
      for (const h of st.owner.values()) if (h.dda != null && !h.dumped) this._ddaFrame(h, t + 1 / 60);
      this._chipPcmNext(k + 1);
    });
  },

  // `voice`'s sounding hit's level, pitch and tune at `t`, where they moved
  // since its last write (`force`: written whatever — the panel's move,
  // over what was sent ahead of it).
  _chipPcmWrite(voice, t, force = false) {
    const st = this._chipPcm;
    const h = st?.owner.get(voice);
    if (!h) return;
    // An OPLL rhythm hit's pitch moves its channel while the sound rings
    // and on through its release, to the next hit on the channel: its own
    // or its pair's (SD with HH, TOM with the cymbal), which tunes it.
    const lane = this._routes.get(h.ti)?.part?.kitLane?.[voice];
    if (h.tune && (lane == null || st.lane.get(lane) === h)) {
      const midi = h.midi + this._hitCents(h) / 100;
      if (midi !== h.tuned || force) {
        h.tuned = midi;
        for (const [p, a, d] of this._rhythmEnc.tune(voice, midi, t)) this._write(p, a, d, t);
      }
    }
    if (h.dumped || t >= h.end) return;
    const lv = this._chipPcmLevelAt(h);
    if (h.dda != null) {
      const att = levelSteps(this._routes.get(h.ti).part.level, { vel: lv.vel, faders: [lv.vol, lv.master] });
      if (att !== h.att || force) { h.att = att; for (const [p, a, d] of this._ddaEncoder().level(h.dda, att)) this._write(p, a, d, t); }
    } else if (h.pcm8 != null) {
      const gain = pcm8Gain(lv);
      if (gain !== h.gain || force) { h.gain = gain; this._pcm8Ev(t, { kind: "gain", voice: h.pcm8, value: gain }); }
      const step = this._pcm8Step(h);
      if (step !== h.step) { h.step = step; this._pcm8Ev(t, { kind: "step", voice: h.pcm8, value: step }); }
    } else if (voice === "adpcm") {
      const chip = this._target.chipFor("adpcm-b");
      const level = adpcmLevel(this._routes.get(h.ti).part.level, lv);
      if (level !== h.level || force) {
        h.level = level;
        for (const [p, a, d] of chip.adpcm.level(level)) this._write(p, a, d, t);
      }
      const deltaN = this._adpcmDeltaN(h);
      if (deltaN !== h.deltaN) {
        h.deltaN = deltaN;
        for (const [p, a, d] of chip.adpcm.pitch(deltaN)) this._write(p, a, d, t);
      }
    } else {
      const level = this._routes.get(h.ti).part.level;
      const top = level.steps - 1;
      const att = rhythmAtt(level, lv);
      // Turned off, or falling below what the level reaches: the sound stops.
      const falling = att > (h.lastAtt ?? h.att);
      h.lastAtt = att;
      if (lv.vol <= 0 || lv.master <= 0 || (att > top && falling)) {
        h.dumped = true;
        for (const [p, a, d] of this._rhythmEnc.dump(voice, t)) this._write(p, a, d, t);
        return;
      }
      const il = top - Math.min(top, att);
      if (il === h.il && !force) return;
      h.il = il;
      for (const [p, a, d] of this._rhythmEnc.level(voice, il, h.pan, t)) this._write(p, a, d, t);
    }
  },

  // The YM2608's ADPCM-B: a note plays its sample's range at the Delta-N of
  // its pitch, its level vel + vol + master as one linear level (the chip's
  // $0B, moving with them while it sounds), its pan the track's; `shot`
  // plays to the range's end, `gate` stops at the note's end, `loop` repeats
  // the range until then. A range the track writes (:pcm-start …) is time as
  // heard (language.md §16), so it reaches into the sample by the note's
  // pitch; on the RAM it rounds to the 4-byte address unit, 8 frames.
  _dispatchAdpcmEvent(ev, when) {
    const ti = ev._trackIndex;
    const st = (this._adpcmState ??= new Map()).get(ti) ?? { pan: 0 };
    this._adpcmState.set(ti, st);
    const enc = this._target.chipFor("adpcm-b").adpcm;
    const out = (writes) => { for (const [p, a, d] of writes) this._write(p, a, d, when); };
    const cp = this._chipPcmState();
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._adpcmBank?.entries?.[ev.args?.sample];
        if (!entry || !this._isVoiceTrackAudible(ti, "adpcm")) break;
        const ratio = 2 ** ((pitchToMidi(ev.args?.pitch ?? "c4") - 60) / 12);
        const frames = (sec) => sec * entry.rate * ratio;
        const UNIT_FRAMES = 8;
        let { start, stop } = entry;
        const r = st.range ?? {};
        const a = r.start != null ? frames(r.start) : 0;
        const b = r.end != null ? frames(r.end) : r.len != null ? a + frames(r.len) : null;
        if (a > 0) start = Math.min(stop, entry.start + Math.floor(a / UNIT_FRAMES));
        if (b != null) stop = Math.max(start, Math.min(stop, entry.start + Math.ceil(b / UNIT_FRAMES) - 1));
        const mode = ev.args?.mode;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const playHz = (deltaN) => (deltaN / 65536) * (this._target.chipFor("adpcm-b").clock / 144);
        // A shot ends where its range does at the pitch it keys at.
        const shotLen = ((stop - start + 1) * UNIT_FRAMES) / playHz(enc.deltaN(entry.rate * ratio));
        this._chipPcmHit("adpcm", ev, when, mode === "shot" || !mode ? when + shotLen : Infinity, { rate: entry.rate, midi }, (t, h) => {
          h.level = adpcmLevel(this._routes.get(h.ti).part.level, this._chipPcmLevelAt(h, t));
          h.deltaN = this._adpcmDeltaN(h, t);
          for (const [p, a, d] of enc.note({ start, stop }, h.deltaN, h.level, st.pan, mode === "loop")) this._write(p, a, d, t);
        });
        break;
      }
      case "PCM_NOTE_OFF":
        // Only the track that keyed the voice last stops it.
        if (ev.args?.mode === "gate" || ev.args?.mode === "loop") {
          const h = this._chipPcmOwnHit("adpcm", ti);
          if (!cp.owner.has("adpcm") || h) out(enc.stop());
          if (h) h.end = Math.min(h.end, when);
        }
        break;
      // A word, every way it is written (_word): the track's fader and
      // pitch, its pan, and the range the next notes play (seconds as
      // heard; a loop is the range itself on this chip, the compiler holds
      // it to that).
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, {
          pitch: true,
          PAN: { read: () => st.pan, write: (v) => { st.pan = this._snapMacroOutput("PAN", v); } },
          ...rangeWords(st, false),
        }));
        break;
      default:
        break;
    }
  },

  _pcm8Ev(when, fields) {
    this._write({ type: "pcm8", when, ...fields });
  },

  // A PCM8 voice's step through its sample a mix sample: the note's pitch,
  // the track's :pitch and the note's :pitch / :semi macros, over the rate
  // the sample plays C4 at.
  _pcm8Step(hit) {
    const cents = this._hitCents(hit);
    return (hit.rate * 2 ** ((hit.midi - 60) / 12 + cents / 1200)) / PCM8_RATE;
  },

  // The X68000's PCM8 (chips/msm6258.js): a note plays its sample from the
  // range's start at its pitch's step, its gain vel + vol + master moving
  // with them while it sounds (_chipPcmWrite); `shot` plays to the range's
  // end, `gate` is cut at the note's end, `loop` repeats the loop until then
  // and plays the rest out. A point the track writes (:pcm-start …) is time
  // as heard, read at the key-on, so it reaches into the sample by the
  // note's pitch.
  _dispatchPcm8Event(ev, when) {
    const ti = ev._trackIndex;
    const voice = ev._chIndex ?? 0;
    const key = `pcm8-${voice}`;
    const st = (this._pcm8State ??= new Map()).get(ti) ?? {};
    this._pcm8State.set(ti, st);
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._frameBank?.entries?.[ev.args?.sample];
        if (!entry || !this._isVoiceTrackAudible(ti, key)) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // sample frames a second, as heard
        const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
        const r = st.range ?? {}, l = st.loop ?? {};
        const start = at(r.start) ?? 0;
        const end = r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : entry.data.length;
        const loopStart = l.start != null ? at(l.start) : undefined;
        const loopEnd = l.end != null ? at(l.end) : l.len != null ? (loopStart ?? entry.loopStart) + at(l.len) : undefined;
        const mode = ev.args?.mode;
        const shotEnd = when + Math.max(0, Math.min(end, entry.data.length) - start) / perSec;
        // A held note (:len 0) waits for triggerKeyOff, as the Mega Drive's does.
        if (this._resolveGateTicks(ev.args?.gate, ev.args?.length) === 0) this._holdChannels.set(this._holdKey(ev), ti);
        this._chipPcmHit(key, ev, when, mode === "shot" || !mode ? shotEnd : Infinity,
          { rate: entry.rate, midi, pcm8: voice }, (t, h) => {
            h.gain = pcm8Gain(this._chipPcmLevelAt(h, t));
            h.step = this._pcm8Step(h, t);
            this._pcm8Ev(t, { kind: "on", voice, sample: ev.args.sample, gain: h.gain, step: h.step,
              start, end, loopStart, loopEnd, mode: mode ?? "shot" });
          });
        break;
      }
      case "PCM_NOTE_OFF": {
        // Only the track that keyed the voice last stops it.
        const h = this._chipPcmOwnHit(key, ti);
        if (!h) break;
        if (ev.args?.mode === "gate") { this._pcm8Ev(when, { kind: "cut", voice }); h.end = Math.min(h.end, when); }
        else if (ev.args?.mode === "loop") this._pcm8Ev(when, { kind: "off", voice });
        break;
      }
      // A word, every way it is written (_word): the track's fader and
      // pitch, the range and loop the next notes play.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, { pitch: true, ...rangeWords(st) }));
        break;
      default:
        break;
    }
  },

  // The PC Engine's DDA encoder (chips/huc6280.js): its wave chip's, shared
  // with the wave lanes (it keeps the channels' state).
  _ddaEncoder() {
    return this._toneEnc?.find((l) => l?.enc.dda)?.enc.dda ?? null;
  },

  // The PC Engine's DDA (pcm1-pcm6): a note's sample baked at DDA_RATE at
  // its pitch — its range and loop read as PCM8's are — written a byte a
  // timer tick to the channel's $06 from its key-on to its end: the
  // sample's, the track's next note's, a gate's or loop's at its gate, or
  // the next note of any of the channel's names (wave5 under pcm5, which
  // ends it where it starts: _dispatchPsgEvent). The bytes go out a frame
  // at a time with its level (_chipPcmWrite, _ddaFrame), then the channel
  // off; its pan is written at its key-on.
  _dispatchDdaEvent(ev, when) {
    const ti = ev._trackIndex;
    const ch = ev._chIndex ?? 0;
    const key = `dda-${ch}`;
    const enc = this._ddaEncoder();
    const st = (this._ddaState ??= new Map()).get(ti) ?? { pan: 0 };
    this._ddaState.set(ti, st);
    const write = (writes, t) => { for (const [p, a, d] of writes) this._write(p, a, d, t); };
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._frameBank?.entries?.[ev.args?.sample];
        if (!enc || !entry?.data.length || !this._isVoiceTrackAudible(ti, key)) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // source frames a second, as heard
        const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
        const r = st.range ?? {}, l = st.loop ?? {};
        const start = Math.min(at(r.start) ?? 0, entry.data.length);
        const end = Math.min(entry.data.length, r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : entry.data.length);
        const loopStart = Math.min(end, l.start != null ? at(l.start) : entry.loopStart ?? start);
        const loopEnd = Math.min(end, l.end != null ? at(l.end) : l.len != null ? loopStart + at(l.len) : entry.loopEnd ?? end);
        const mode = ev.args?.mode ?? "shot";
        // Where it stops: a gate or loop note at its gate (on its frame, as
        // its writes are); a shot when its sample runs out, a loop held for a
        // while; any of them at the track's next note on the channel
        // (_chipPcmHit), the last sample before it, so the channel is off
        // before that note keys it.
        const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
        const onFrame = (t) => (this._target.frameClock ? this._frameStart(t) : t);
        const stop = mode !== "shot" && gateTicks > 0 ? onFrame(this._timeAfterTicks(when, gateTicks)) : Infinity;
        const cap = Number.isFinite(stop) ? Math.floor((stop - when) * DDA_RATE + 1e-9)
          : mode === "loop" ? Math.ceil(DDA_HOLD_SEC * DDA_RATE) : Infinity;
        const step = perSec / DDA_RATE; // source frames a timer tick
        const looped = mode === "loop" && loopEnd - loopStart >= 1;
        const total = Math.min(cap, looped ? Infinity : Math.max(0, Math.ceil(((mode === "loop" ? loopEnd : end) - start) / step - 1e-9)));
        if (!(total > 0)) break;
        // The timer's bytes, as far as they are written (_ddaFrame).
        const bytes = [];
        let pos = start;
        bytes.upTo = (n) => {
          for (; bytes.length < Math.min(n, total); pos += step) {
            if (looped && pos >= loopEnd) pos = loopStart + ((pos - loopStart) % (loopEnd - loopStart));
            const i = Math.floor(pos), f = pos - i;
            const x = entry.data[i] * (1 - f) + (entry.data[Math.min(i + 1, entry.data.length - 1)] ?? 0) * f;
            bytes.push(ddaStep(x));
          }
        };
        const off = when + total / DDA_RATE;
        this._chipPcmHit(key, ev, when, off, { dda: ch, bytes, total, sent: 0 }, (t, h) => {
          h.att = levelSteps(ev._route.part.level, this._ddaLevel(h, t));
          write([...enc.pan(ch, st.pan), ...enc.level(ch, h.att)], t);
        });
        break;
      }
      // A word, every way it is written (_word): the track's fader, its
      // pan, the range and loop the next notes play.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, {
          PAN: { read: () => st.pan, write: (v) => { st.pan = Math.max(-1, Math.min(1, Number(v) || 0)); } },
          ...rangeWords(st),
        }));
        break;
      default:
        break;
    }
  },

  // The DMC's rate for each sample its notes play (chips/rp2a03.js dmcRates).
  _dmcRateOf(name) {
    this._dmcRates ??= dmcRates(this._ir, this._target.headsOf("fc-dpcm"), this._frameBank?.entries);
    return this._dmcRates.get(name) ?? dmcRate(Infinity);
  },

  // The 2A03's DMC (pcm1): a note's sample — its range as heard, read as
  // DDA's is — resampled to its pitch at its def-pcm's rate (_dmcRateOf),
  // its level (vel + vol + master at key-on) in it, and encoded to the
  // 1-bit delta (chips/rp2a03.js dmcEncode). Each hit loads its bytes into
  // the memory a hair ahead of its key-on, on the machine's own timing (the
  // load is not a frame's write), then starts the DMC; `loop` repeats the
  // range, and a loop or gate note stops at its gate. A shot plays out, or
  // until the next note starts over.
  _dispatchDpcmEvent(ev, when) {
    const ti = ev._trackIndex;
    const st = (this._dpcmState ??= new Map()).get(ti) ?? {};
    this._dpcmState.set(ti, st);
    const dmc = this._target.chipFor("fc-dpcm").dmc;
    const write = (writes, t) => { for (const [p, a, d] of writes) this._write(p, a, d, t); };
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const name = ev.args?.sample;
        const entry = this._frameBank?.entries?.[name];
        if (!entry?.data.length || !this._isVoiceTrackAudible(ti, "dpcm")) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // source frames a second, as heard
        const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
        const r = st.range ?? {};
        const start = Math.min(at(r.start) ?? 0, entry.data.length);
        const end = Math.min(entry.data.length, r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : entry.data.length);
        if (end <= start) break;
        const mode = ev.args?.mode ?? "shot";
        // The level at key-on: the note's vel (or its macro's first step),
        // the track's :vol (or its macro's), the master, the strip.
        const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
        const gain = levelGain({
          vel: this._macroOnset(ev.args?.velMacro, when, gateTicks, "VEL") ?? Number(ev.args?.vel ?? 15),
          faders: [this._handVol("voice:dpcm") ?? this._macroOnset(ev.args?.vol, when, gateTicks, "VOL") ?? this._lv(`strk:${ti}`).vol,
            this._handMaster() ?? this._masterVol ?? VOL_UNITY],
        });
        const rate = this._dmcRateOf(name);
        const levels = dmcLevels(entry, perSec, rate, gain, start, end);
        const bytes = dmcEncode(levels, mode === "loop");
        const loadAt = (this._target.frameClock ? this._frameStart(when) : when) - DMC_LOAD_LEAD_SECS;
        // Live's worklet takes the load as one stream tick (thousands of
        // messages would stall the page); a capture, a write at a time.
        const load = dmc.load(bytes), timed = this._writeTimer;
        if (timed.stream) {
          const flat = new Uint8Array(2 * load.length);
          load.forEach(([, a, d], k) => { flat[2 * k] = a; flat[2 * k + 1] = d; });
          timed.stream({ when: loadAt, rate: 1, port: load[0][0], perTick: load.length, bytes: flat });
        } else for (const [p, a, d] of load) timed(p, a, d, loadAt);
        // The worklet writes timed writes at its block's start but a stream
        // at its sample: the start goes as a stream too, so it follows the
        // load it plays (a capture keeps the order by time).
        const go = dmc.start(bytes, rate, mode === "loop");
        if (timed.stream) {
          const flat = new Uint8Array(2 * go.length);
          go.forEach(([, a, d], k) => { flat[2 * k] = a; flat[2 * k + 1] = d; });
          const t = this._target.frameClock ? this._frameTime(when) : when;
          timed.stream({ when: t, rate: 1, port: go[0][0], perTick: go.length, bytes: flat });
        } else write(go, when);
        if (mode !== "shot" && gateTicks > 0) {
          // At its gate, while it is the track's note (a note there takes over).
          const gate = this._timeAfterTicks(when, gateTicks);
          this._whileNote(ti, gate, () => write(dmc.stop(), gate));
        }
        break;
      }
      // A word, every way it is written (_word): the track's fader (read
      // at the next key-on), the range the next notes play.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, rangeWords(st, false)));
        break;
      default:
        break;
    }
  },

  // A DDA hit's samples up to `until` (a frame's end), on the CPU's timer,
  // not the video frame — as one stream a frame where the writer takes one
  // (Live's worklet, a write a tick at its sample), else a write at a time
  // (a capture, the exports) — and, once its last is out or its end has
  // come, the channel off, a key-order lead before its end: past its last
  // sample, and before the key-on of a note of another of the channel's
  // names that starts there or ends it (`cut`).
  _ddaFrame(h, until) {
    const enc = this._ddaEncoder();
    const timed = this._writeTimer;
    const ch = h.dda;
    const last = Math.min(h.total, Math.ceil((h.end - h.t) * DDA_RATE - 1e-9));
    const to = Math.min(last, Math.ceil((until - h.t) * DDA_RATE - 1e-9));
    if (to > h.sent) {
      h.bytes.upTo(to);
      const from = h.sent;
      if (timed.stream) {
        const per = enc.sample(ch, 0);
        const flat = new Uint8Array((to - from) * per.length * 2);
        for (let k = from; k < to; k++)
          enc.sample(ch, h.bytes[k]).forEach(([, a, d], j) => { flat[2 * ((k - from) * per.length + j)] = a; flat[2 * ((k - from) * per.length + j) + 1] = d; });
        timed.stream({ when: h.t + from / DDA_RATE, rate: DDA_RATE, port: per[0][0], perTick: per.length, bytes: flat });
      } else for (let k = from; k < to; k++) for (const [p, a, d] of enc.sample(ch, h.bytes[k])) timed(p, a, d, h.t + k / DDA_RATE);
      h.sent = to;
    }
    // The off waits for the frame it falls in: a note starting on the
    // channel at the sample's very end is dispatched before that frame.
    const at = Math.min(h.end, h.t + last / DDA_RATE) - KEY_ORDER_EPS_SECS;
    if (h.sent >= last && until > at) {
      h.dumped = true;
      for (const [p, a, d] of enc.off(ch)) timed(p, a, d, at);
    }
  },

  // A DDA hit's level terms: vel + vol + master (levelSteps).
  _ddaLevel(h, t) {
    const lv = this._chipPcmLevelAt(h, t);
    return { vel: lv.vel, faders: [lv.vol, lv.master] };
  },

  // A chip's ROM rhythm (the YM2608's, the OPLL's): a hit writes its sound's
  // level and pan, then keys it; vel + vol + master fold into the level as
  // an FM carrier's do, on the part's ladder (the YM2608's IL 0.75 dB a
  // step, the OPLL's volume 3 dB), and move it while the sound plays
  // (_chipPcmWrite), and `:mode gate` dumps it at the note's end. On the
  // OPLL a hit's note tunes its channel.
  _dispatchRhythmEvent(ev, when) {
    const ti = ev._trackIndex;
    const st = (this._rhythmState ??= new Map()).get(ti) ?? { pan: 0 };
    this._rhythmState.set(ti, st);
    const enc = this._rhythmEnc;
    const part = ev._route.part;
    const sound = this._ir?.metadata?.samples?.find((s) => s.name === ev.args?.sample)?.rhythm;
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        if (!sound || !this._isVoiceAudible(sound)) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const sec = part.soundSec?.[sound] ?? ROM_SOUND_SEC[sound];
        this._chipPcmHit(sound, ev, when, when + sec, { pan: st.pan, midi, tune: !!enc.tune }, (t, h) => {
          const lv = this._chipPcmLevelAt(h, t);
          // A hit at :vol 0 is silence: it takes the sound from an earlier one.
          const silent = lv.vol <= 0 || lv.master <= 0;
          const top = part.level.steps - 1;
          h.dumped = silent;
          h.att = rhythmAtt(part.level, lv);
          h.il = top - Math.min(top, h.att);
          h.tuned = midi + this._hitCents(h, t) / 100;
          const writes = silent ? enc.dump(sound, t) : enc.hit(sound, h.il, st.pan, t, h.tuned);
          for (const [p, a, d] of writes) this._write(p, a, d, t);
        });
        break;
      }
      case "PCM_NOTE_OFF":
        // Only the track that keyed the sound last dumps it.
        if (sound && ev.args?.mode === "gate") {
          const h = this._chipPcmOwnHit(sound, ti);
          if (h) {
            for (const [p, a, d] of enc.dump(sound, when)) this._write(p, a, d, when);
            h.end = Math.min(h.end, when);
          }
        }
        break;
      // A word, every way it is written (_word): the track's fader, its
      // pitch where the rhythm tunes (the OPLL's), its pan.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, {
          pitch: !!enc.tune,
          PAN: { read: () => st.pan, write: (v) => { st.pan = this._snapMacroOutput("PAN", v); } },
        }));
        break;
      default:
        break;
    }
  },

  // A swept point, stepped the way the driver steps it: integer from/to
  // in bytes, the curve lowered to the driver's eight shapes, one value a
  // frame (mmlispseq.c process_sweep, drv-player _processSweep). The worklet's
  // voice model sends a RETARGET only when the rounded block moves.
  _schedulePcmLoopSweep(voice, ev, when) {
    const a = ev.args ?? {};
    const target = (a.target ?? "").toUpperCase();
    const df = this._curveFields(a, when);
    const from = this._pcmLoopBytes(df.from), to = this._pcmLoopBytes(df.to);
    const len = this._sweepLen(a, when), loop = !!a.loop, id = curveId(a.curve);
    const step16 = sweepStep(len, loop);
    this._runSweep(this._slotKey(ev, target), SWEEP, {
      loop, baseFrames: len, startWhen: when, startFrame: this._eventFrame(when),
      valueAt: (f) => (!loop && f >= len - 1 ? to : sweepValue(from, to, curveUnit8(id, ((f * step16) & 0xffff) >> 8))),
      // After its frame's dispatch: a sweep that starts with a note moves
      // that note's loop, not the one before it.
      timeOf: (f) => when + f / 60 + PCM_SWEEP_AFTER,
    }, (value, t) => this._pcmEv(t, { kind: "point", voice, target, value }));
  },

  _dispatchPcmNoteOn(ev, when) {
    // A muted PCM track must not sound. PCM owns no FM/PSG channel, so there is
    // no key-off to suppress it after the fact (as _applyAudibility does for
    // those) — the note has to be dropped here, like FM/PSG NOTE_ON do.
    // A voice started before a mute or solo landed is released here, where its
    // next note would have replaced it; a loop would otherwise run on.
    if (!this._isTrackAudible(ev._trackIndex)) {
      this._pcmEv(when, { kind: "off", voice: ev._chIndex ?? 0 });
      return;
    }
    const sample = String(ev.args?.sample ?? "").trim();
    if (!sample) return;
    const velRaw = Number(ev.args?.vel ?? 15);
    const noteVel = Number.isFinite(velRaw) ? velRaw : 15;
    const voice = ev._chIndex ?? 0;
    this._pcmSample[voice] = sample;
    // The bank baked one blob per (sample, note); the worklet finds it by the
    // same MIDI number the exporter keyed it with (export-mmb.js midiNote).
    const midi = Math.max(0, Math.min(127, Math.round(pitchToMidi(ev.args?.pitch ?? "c4"))));

    // The note's macros (driver.md §13): :vel and :vol are the voice's level,
    // a :keyon step plays the blob again from its start. Each runs to the
    // next note on the track, which re-instantiates them; a :keyon retrigger
    // restarts the level envelopes, as it does on FM and PSG.
    const { keyon, velMacro, vol: volMacro } = ev.args ?? {};
    const lengthTicks = ev.args.length;
    const gateTicks = this._resolveGateTicks(ev.args?.gate, lengthTicks);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    if (gateTicks === 0) this._holdChannels.set(this._holdKey(ev), ev._trackIndex); // waits for KEY_OFF
    // A :keyon retrigger STARTs after its frame's level steps, so it
    // carries them: they ride its event instead of sending a level of their
    // own. Each step is its frame's work (MACRO), each retrigger after them.
    // The retriggers come one at a time (_keyonRetrigs): `cur` is the next,
    // the last of its frame, which that frame's level steps ride.
    const retrigs = this._keyonRetrigs(keyon, when, gateTicks);
    const times = retrigs?.();
    let ahead = times?.next();
    const pullRetrig = () => {
      if (!ahead || ahead.done) return null;
      let t = ahead.value;
      const F = this._eventFrame(t);
      for (ahead = times.next(); !ahead.done && this._eventFrame(ahead.value) === F; ahead = times.next()) t = ahead.value;
      return { F, t };
    };
    let cur = pullRetrig();
    const first = []; // the samples on the note itself: its key-on composes from them
    let on = false;
    const level = (kind, value, t) => {
      if (cur && this._eventFrame(t) === cur.F) cur[kind] = value;
      else this._pcmEv(t, { kind, voice, value, macro: true });
    };
    this._envRetrigs = retrigs;
    for (const [spec, kind, target] of [[velMacro, "vel", "VEL"], [volMacro, "vol", "VOL"]]) {
      if (!spec) continue;
      this._scheduleMacro(
        spec, noteFrames, gateSecs, when,
        (v, t) => {
          const value = clampForTarget(target, v);
          if (on) level(kind, value, t);
          else first.push({ t, kind, value });
        },
        this._stepSecs(spec.step),
      );
    }
    this._envRetrigs = null;
    // The note starts at its :vel macro's first sample, as the driver's
    // note-on composes it (a leading hold: the note's own vel).
    const firstVel = velMacro && !macroLeadsWithHold(velMacro)
      ? first.find((x) => x.kind === "vel")?.value ?? noteVel
      : noteVel;
    // ...and at its :vol macro's first sample, else the fader (restore_level_base).
    const firstVol = volMacro && !macroLeadsWithHold(volMacro)
      ? first.find((x) => x.kind === "vol")?.value ?? null
      : null;
    // A PCM note takes fm6 as the DAC: $2B on where it is off (its first
    // note, or after an fm6 note took it: _fmKey) — as the driver does.
    if (this._dacClaim && !this._dacOn) {
      this._dacOn = true;
      this._write(0, 0x2b, 0x80, when);
    }
    this._pcmEv(when, {
      kind: "on",
      voice,
      track: ev._trackIndex ?? null,
      sample,
      midi,
      mode: ev.args?.mode === "loop" ? "loop" : "shot",
      vel: firstVel,
      vol: firstVol,
    });
    on = true;
    for (const x of first) level(x.kind, x.value, x.t);
    // Each retrigger while the note is the track's: its next note takes over.
    const ti = ev._trackIndex, note = this._noteOf[ti];
    const retrig = () => {
      if (!cur) return;
      const t = cur.t + PCM_SWEEP_AFTER;
      this._step(cur.F, AFTER, t, () => {
        if (this._noteOf[ti] !== note || this._letGo[ti] === note) return; // the next note's, or let go
        const { F: _F, t: _at, ...carried } = cur;
        this._pcmEv(t, { kind: "retrig", voice, ...carried });
        cur = pullRetrig();
        retrig();
      }, null, !!retrigs?.endless);
    };
    retrig();
  },
};
