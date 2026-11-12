// The sample voices: the Mega Drive's PCM (the worklet's model, fed the
// score's events) and the chips' own — the YM2608's ADPCM-B and rhythm, PCM8,
// the DDA, the DMC, the OPLL's rhythm — each voice's sounding hit writing its
// level, pitch and tune when one moves.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { pitchToMidi, levelOffset, levelSteps, levelGain, VOL_UNITY, KEY_ORDER_EPS_SECS } from "../lang/ir-utils.js";
import { curveId, curveUnit8, sweepValue, sweepStep } from "../driver/mmb.js";
import { engineImage } from "../driver/engine-images.js";
import { ROM_SOUND_SEC } from "../machine/chips/rhythm-rom.js";
import { PCM8_RATE } from "../machine/chips/msm6258.js";
import { DDA_RATE, ddaStep } from "../machine/chips/huc6280.js";
import { dmcRate, dmcRates, dmcLevels, dmcEncode } from "../machine/chips/rp2a03.js";
import { DDA_HOLD_SEC, DMC_LOAD_LEAD_SECS, PCM_LOOP_MAX, VOICES, PCM_SWEEP_AFTER, PCM_POINT_TARGETS, SWEEP, MACRO, AFTER } from "./ir-player-shared.js";

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

// A sample note's span, in its sample's frames at the note's pitch
// (`perSec`: frames a second as heard): the track's range and loop (seconds
// as heard, rangeWords) or the sample's own loop, clamped to the sample and
// the loop to the range — as PCM8's mix clamps a note (chips/msm6258.js).
// PCM8's, the DDA's and the DMC's notes alike; the ADPCM-B's is its RAM's
// 8-sample blocks (_dispatchAdpcmEvent).
function sampleSpan(st, entry, perSec) {
  const len = entry.data.length;
  const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
  const r = st.range ?? {}, l = st.loop ?? {};
  const start = Math.min(at(r.start) ?? 0, len);
  const end = Math.max(start, Math.min(len, r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : len));
  const inRange = (x) => Math.max(start, Math.min(end, x));
  const loopStart = inRange(l.start != null ? at(l.start) : entry.loopStart ?? start);
  const loopEnd = inRange(l.end != null ? at(l.end) : l.len != null ? loopStart + at(l.len) : entry.loopEnd ?? end);
  return { start, end, loopStart, loopEnd };
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

  // A step of a Mega Drive PCM note's :vel / :vol macro, to the voice model
  // — or, in a frame a :keyon retrigger is due in, carried by it.
  _pcmLevelStep(voice, kind, value, t) {
    const r = this._lv(`pcm:${voice}`).note?.due?.get(this._eventFrame(t));
    if (r) r.carried[kind] = value;
    else this._pcmEv(t, { kind, voice, value, macro: true });
  },

  // A point, from the IR's seconds to the engine's byte offset — the
  // same multiply and clamp the MMB exporter applies (export-mmb.js
  // targetValue), at the rate of the image the score names.
  _pcmLoopBytes(sec) {
    const rate = this._pcmBankRate ?? engineImage(Math.max(1, this._ir?.metadata?.pcmVoices ?? 1), this._ir?.metadata?.frameHz).rateHz;
    return Math.max(0, Math.min(PCM_LOOP_MAX, Math.round(Number(sec ?? 0) * rate)));
  },

  // A PCM voice's word (the Mega Drive's; its fader is every track's,
  // _volWord): its :vel — a sweep steps the voice's bank a frame at a time,
  // as the driver's sweep engine does (driver.md §14), written where it
  // moves — and its sample's points; null for the words only FM and PSG have.
  _pcmWord(voice, target) {
    if (target === "VEL") {
      // Its level's (_lv): the engine's model composes it, from these.
      const L = this._lv(`pcm:${voice}`);
      const fit = (v) => Math.max(0, Math.min(15, Math.round(v)));
      const read = () => L.vel;
      const write = (v, t) => this._pcmEv(t, { kind: "vel", voice, value: (L.vel = fit(v)) });
      return {
        read, write,
        sweep: (ev, when) => this._sweepWord(ev, when, read(), (v, t) => { if (L.vel !== fit(v)) write(v, t); }),
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
      owner: new Map(), // voice ("adpcm", a rhythm sound, "pcm8-0", "dda-0" …) → the hit sounding on it
      lane: new Map(), // a kit's channel → the hit that last keyed it (a pair's tune, _chipPcmWrite)
      frames: false, // a DDA frame is waiting (_chipPcmNext)
    });
  },

  // A sample track's word: those of its part (`own`: { WORD: { read, write } };
  // its fader, pan and pitch are every track's, _volWord _panWord _pitchWord).
  _sampleWord(ev, own = {}) {
    return own[String(ev.args?.target ?? "").toUpperCase()] ?? null;
  },

  // A hit (or an ADPCM-B note) keyed on `voice`: its own :vel / :vol /
  // :pitch / :semi macros run from it a step at a time, and each :keyon
  // step re-keys the voice — a hit of its own, its level envelopes starting
  // over with it, as on FM and PSG (a gate or loop note's only inside its
  // gate). `key(t, hit)` writes a key: the first, then each step's.
  // `release(t, h, how)` is what closing the note does on the chip
  // (_sampleClose), to the track's own sound on the voice (`h`, null where
  // another track's holds it).
  _chipPcmHit(voice, ev, when, end, fields, key, release = null) {
    const st = this._chipPcmState();
    const mode = ev.args?.mode ?? "shot", held = mode === "gate" || mode === "loop";
    const ti = ev._trackIndex;
    // The note's path is every voice's (_playNote): its level and pitch are
    // its voice's (_lv and _pt at `voice:…`, _sampleLevel, _hitCents), shared
    // by its retriggers' hits, its pitch over its track's :pitch (`strk:N`).
    // (A tuned hit's pitch runs its note's whole length: the channel keeps
    // moving through the sound's release.)
    const site = `voice:${voice}`;
    this._pt(site).offset = this._pt(`strk:${ti}`).offset;
    let hit = null;
    const keyHit = (h) => {
      // The track's own sound on the channel ends at its next note (not at a
      // retrigger of the same note, which plays over it).
      const prev = st.owner.get(voice);
      if (prev?.dda != null && prev.ti === h.ti && prev.note !== h.note && !prev.dumped && prev.end > h.t) {
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
    this._playNote(ev, when, {
      audible: this._isVoiceTrackAudible(ti, voice),
      level: site, vel: Number(ev.args?.vel ?? 15), pitch: site, midi: fields.midi ?? 60,
      pitchGate: fields.tune ? ev.args?.length : undefined,
      key: (n) => {
        const note = this._lv(site).note;
        hit = { t: when, end, voice, ti, note, ...fields };
        const fresh = { ...hit }; // a retrigger's hit starts as the note's did
        keyHit(hit);
        return {
          close: release && this._sampleClose(ev, (t, how) => release(t, this._chipPcmOwnHit(voice, ti), how)),
          // A retrigger keys at its time, before its frame's steps: its level
          // envelopes start over there, from their first samples (a gate or
          // loop note's only before its close: its sound is cut or released
          // there).
          retrigger: (t, closed) => {
            if (held && closed) return;
            if (this._lv(site).note === note) this._lvRetrig(site);
            keyHit({ ...fresh, t, end: end + (t - when) });
          },
        };
      },
    });
    return hit;
  },

  // What closing a sample note does (_closeNote): `release(t, { cut,
  // shot })` — at its gate, a rest or the track's end a `:mode gate` note's
  // cut, a loop's release; at the host's key-off a release; a shot's is the
  // chip's to take or not (the Mega Drive's voice model plays it out, as
  // the driver's key-off does). Nothing at the track's next note, which
  // takes the voice over.
  _sampleClose(ev, release) {
    const mode = ev.args?.mode ?? "shot";
    return (t, how) => {
      if (how.next) return;
      release(t, { cut: mode === "gate" && !how.host, shot: mode === "shot" && !how.host });
    };
  },

  // The hit that holds `voice` now, if it is `ti`'s: a gate's end stops
  // only the track's own sound.
  _chipPcmOwnHit(voice, ti) {
    const h = this._chipPcm?.owner.get(voice);
    return h?.ti === ti ? h : null;
  },

  // A hit's level now: its voice's (_sampleLevel).
  _chipPcmLevelAt(hit) {
    return this._sampleLevel(`voice:${hit.voice}`, hit.ti);
  },

  // A hit's pitch move now, in cents: its voice's pitch (_pt) over its note.
  _hitCents(hit) {
    const { note, cents } = this._ptNow(this._pt(`voice:${hit.voice}`));
    return 100 * (note - hit.midi) + cents;
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
    const st = (this._adpcmState ??= new Map()).get(ti) ?? {};
    this._adpcmState.set(ti, st);
    const enc = this._target.chipFor("adpcm-b").adpcm;
    const out = (writes) => { for (const [p, a, d] of writes) this._write(p, a, d, when); };
    const cp = this._chipPcmState();
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._adpcmBank?.entries?.[ev.args?.sample];
        if (!entry) break;
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
          for (const [p, a, d] of enc.note({ start, stop }, h.deltaN, h.level, this._panOf(`strk:${ti}`), mode === "loop")) this._write(p, a, d, t);
        }, (t, h, how) => {
          // (a voice nothing holds is stopped too)
          if (how.shot) return;
          if (!this._chipPcm?.owner.has("adpcm") || h) for (const [p, a, d] of enc.stop()) this._write(p, a, d, t);
          if (h) h.end = Math.min(h.end, t);
        });
        break;
      }
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
        this._word(ev, when, this._sampleWord(ev, rangeWords(st, false)));
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
        if (!entry) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // sample frames a second, as heard
        const { start, end, loopStart, loopEnd } = sampleSpan(st, entry, perSec);
        const mode = ev.args?.mode;
        const shotEnd = when + (end - start) / perSec;
        this._chipPcmHit(key, ev, when, mode === "shot" || !mode ? shotEnd : Infinity,
          { rate: entry.rate, midi, pcm8: voice }, (t, h) => {
            h.gain = pcm8Gain(this._chipPcmLevelAt(h, t));
            h.step = this._pcm8Step(h, t);
            this._pcm8Ev(t, { kind: "on", voice, sample: ev.args.sample, gain: h.gain, step: h.step,
              start, end, loopStart, loopEnd, mode: mode ?? "shot" });
          }, (t, h, { cut, shot }) => {
            if (!h || shot) return;
            this._pcm8Ev(t, { kind: cut ? "cut" : "off", voice });
            if (cut) h.end = Math.min(h.end, t);
          });
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
        this._word(ev, when, this._sampleWord(ev, rangeWords(st)));
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
    const st = (this._ddaState ??= new Map()).get(ti) ?? {};
    this._ddaState.set(ti, st);
    const write = (writes, t) => { for (const [p, a, d] of writes) this._write(p, a, d, t); };
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._frameBank?.entries?.[ev.args?.sample];
        if (!enc || !entry?.data.length) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // source frames a second, as heard
        const { start, end, loopStart, loopEnd } = sampleSpan(st, entry, perSec);
        const mode = ev.args?.mode ?? "shot";
        // Where it stops: a shot when its sample runs out, a loop held for
        // a while; a gate or loop note at its close (below: on its frame,
        // as its writes are); any of them at the track's next note on the
        // channel (_chipPcmHit), the last sample before it, so the channel
        // is off before that note keys it.
        const onFrame = (t) => (this._target.frameClock ? this._frameStart(t) : t);
        const cap = mode === "loop" ? Math.ceil(DDA_HOLD_SEC * DDA_RATE) : Infinity;
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
          write([...enc.pan(ch, this._panOf(`strk:${ti}`)), ...enc.level(ch, h.att)], t);
        }, (t, h, { shot }) => {
          if (!h || h.dumped || shot) return;
          h.end = Math.min(h.end, onFrame(t));
          // (never short of the samples its frames have sent: the off follows them)
          h.total = Math.min(h.total, Math.max(h.sent, Math.floor((h.end - h.t) * DDA_RATE + 1e-9)));
          this._ddaFrame(h, h.end); // its last samples, and the channel off
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
        if (!entry?.data.length) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // source frames a second, as heard
        const { start, end } = sampleSpan(st, entry, perSec);
        if (end <= start) break;
        const mode = ev.args?.mode ?? "shot";
        // The note's path is every voice's (_playNote); its level is baked
        // into the bytes at its key-on, stopped at its close (a shot plays out).
        this._playNote(ev, when, {
          audible: this._isVoiceTrackAudible(ti, "dpcm"),
          level: "voice:dpcm", vel: Number(ev.args?.vel ?? 15),
          key: () => {
            // The level at key-on, baked into the bytes: the voice's
            // (_sampleLevel) — its note's vel and :vol macro's first steps,
            // the strip, the track's :vol, the master.
            const lv = this._sampleLevel("voice:dpcm", ti);
            const gain = levelGain({ vel: lv.vel, faders: [lv.vol, lv.master] });
            const rate = this._dmcRateOf(name);
            const levels = dmcLevels(entry, perSec, rate, gain, start, end);
            const bytes = dmcEncode(levels, mode === "loop");
            const loadAt = (this._target.frameClock ? this._frameStart(when) : when) - DMC_LOAD_LEAD_SECS;
            // Live's worklet takes the load as one stream tick (thousands of
            // messages would stall the page); a capture, a write at a time.
            const load = dmc.load(bytes), timed = this._writeTimer;
            const stream = (writes, t) => {
              const flat = new Uint8Array(2 * writes.length);
              writes.forEach(([, a, d], k) => { flat[2 * k] = a; flat[2 * k + 1] = d; });
              timed.stream({ when: t, rate: 1, port: writes[0][0], perTick: writes.length, bytes: flat });
            };
            if (timed.stream) stream(load, loadAt);
            else for (const [p, a, d] of load) timed(p, a, d, loadAt);
            // The DMC started on the bytes loaded: at the key-on and each
            // :keyon retrigger (its envelopes start over from their first
            // steps, the level its bytes were baked at). The worklet writes
            // timed writes at its block's start but a stream at its sample:
            // the start goes as a stream too, so it follows the load it
            // plays (a capture keeps the order by time).
            const go = dmc.start(bytes, rate, mode === "loop");
            const startAt = (t) => {
              if (timed.stream) stream(go, this._target.frameClock ? this._frameTime(t) : t);
              else write(go, t);
            };
            startAt(when);
            return {
              close: this._sampleClose(ev, (t, { shot }) => { if (!shot) write(dmc.stop(), t); }),
              // (a gate or loop note's only before its close, as a chip's hit's)
              retrigger: (t, closed) => { if (mode === "shot" || !closed) startAt(t); },
            };
          },
        });
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
    const st = (this._rhythmState ??= new Map()).get(ti) ?? {};
    this._rhythmState.set(ti, st);
    const enc = this._rhythmEnc;
    const part = ev._route.part;
    const sound = this._ir?.metadata?.samples?.find((s) => s.name === ev.args?.sample)?.rhythm;
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        if (!sound) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const sec = part.soundSec?.[sound] ?? ROM_SOUND_SEC[sound];
        this._chipPcmHit(sound, ev, when, when + sec, { pan: this._panOf(`strk:${ti}`), midi, tune: !!enc.tune }, (t, h) => {
          const lv = this._chipPcmLevelAt(h, t);
          // A hit at :vol 0 is silence: it takes the sound from an earlier one.
          const silent = lv.vol <= 0 || lv.master <= 0;
          const top = part.level.steps - 1;
          h.dumped = silent;
          h.att = rhythmAtt(part.level, lv);
          h.il = top - Math.min(top, h.att);
          h.tuned = midi + this._hitCents(h, t) / 100;
          const writes = silent ? enc.dump(sound, t) : enc.hit(sound, h.il, h.pan, t, h.tuned);
          for (const [p, a, d] of writes) this._write(p, a, d, t);
        }, (t, h, { cut }) => {
          // A gate note's sound dumped at its gate; a rhythm sound has no release.
          if (!cut || !h) return;
          for (const [p, a, d] of enc.dump(sound, t)) this._write(p, a, d, t);
          h.end = Math.min(h.end, t);
        });
        break;
      }
      // A word, every way it is written (_word): the track's fader, its
      // pitch where the rhythm tunes (the OPLL's), its pan.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev));
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
    const sample = String(ev.args?.sample ?? "").trim();
    if (!sample) return;
    const velRaw = Number(ev.args?.vel ?? 15);
    const noteVel = Number.isFinite(velRaw) ? velRaw : 15;
    const voice = ev._chIndex ?? 0;
    this._pcmSample[voice] = sample;
    // The bank baked one blob per (sample, note); the worklet finds it by the
    // same MIDI number the exporter keyed it with (export-mmb.js midiNote).
    const midi = Math.max(0, Math.min(127, Math.round(pitchToMidi(ev.args?.pitch ?? "c4"))));

    // The note's path is every voice's (_playNote): its :vel and :vol macros
    // are the voice's level (driver.md §13), a :keyon step plays the blob
    // again from its start, a retrigger restarting the level envelopes as on
    // FM and PSG. Its level is the voice model's: each step goes to it
    // (_lvWrite, _pcmLevelStep), and the note starts at their first samples
    // (a leading hold: the note's own vel, the fader). A :keyon retrigger
    // STARTs after its frame's level steps, so it carries them: they ride its
    // event instead of sending a level of their own (`due`: the frames a
    // retrigger is due in, after their steps, AFTER).
    const site = `pcm:${voice}`;
    this._playNote(ev, when, {
      level: site, vel: noteVel,
      key: () => {
        const L = this._lv(site);
        const due = (L.note.due = new Map());
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
          vel: L.liveVel ?? noteVel,
          vol: L.liveVol,
        });
        // (its first samples, as the voice's macro values)
        if (L.liveVel != null) this._pcmLevelStep(voice, "vel", L.liveVel, when);
        if (L.liveVol != null) this._pcmLevelStep(voice, "vol", L.liveVol, when);
        return {
          // the driver's key-off — a loop's release, its tail played out (a
          // shot's plays on); a `:mode gate` note's cut
          close: this._sampleClose(ev, (t, how) => this._pcmEv(t, { kind: how.cut ? "cut" : "off", voice })),
          retrigger: (t) => {
            const F = this._eventFrame(t), r = { carried: {} };
            due.set(F, r);
            this._step(F, AFTER, t + PCM_SWEEP_AFTER, () => {
              if (due.get(F) !== r) return;
              due.delete(F);
              this._pcmEv(t + PCM_SWEEP_AFTER, { kind: "retrig", voice, ...r.carried });
            });
          },
        };
      },
    });
  },
};
