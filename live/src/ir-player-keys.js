// The keys' surface: Live's MIDI keyboard and the panel's audition play a
// channel through these, never the player's state.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { velK, VOL_UNITY } from "./ir-utils.js";

export const keyMethods = {
  /** The machine's name, and its FM encoder (chips/) for a key's own writes. */
  machine() {
    return this._target.name;
  },

  fmEncoder() {
    return this._fmEnc;
  },

  /** The machine's ROM rhythm encoder, for a key's hit; null without one. */
  rhythmEncoder() {
    return this._rhythmEnc ?? null;
  },

  /** The seconds a tick lasts at the tempo now. */
  secsPerTick() {
    return this._secsPerTick;
  },

  /** The chips' resting voices, written now (a player made for the keys). */
  initVoices() {
    this._initDefaultVoices();
  },

  /**
   * A tone lane keyed at `midi` (a noise lane triggered). At `vel` (0-15);
   * without one at the level the lane has — its last note's velocity — as an
   * FM key without one sounds at its channel's level.
   */
  keyTone(lane, midi, vel = null, when = this._keyNow()) {
    if (this._isNoiseLane(lane)) this._psgTriggerNoise(when, lane);
    else this._psgSetPitch(lane, midi, 0, when);
    const L = this._lv(`psg:${lane}`);
    this.keyToneLevel(lane, vel ?? L.liveVel ?? L.vel, when);
  },

  /** A keyed tone lane's level at `vel` — a wave role's envelope steps it. */
  keyToneLevel(lane, vel, when = this._keyNow()) {
    // The key has the lane's level until it is let go (_lvVel); the song's
    // note there stays the song's, and has the lane back then.
    this._lv(`psg:${lane}`).key = { vel: Math.max(0, Math.min(15, vel)) };
    this._psgRecompose(lane, when);
  },

  /** The velocity a key holds the lane at (keyTone), 15 with none held. */
  keyToneVel(lane) {
    return this._lv(`psg:${lane}`).key?.vel ?? 15;
  },

  keyToneOff(lane, when = this._keyNow()) {
    this._lv(`psg:${lane}`).key = null;
    this._psgSetAtt(lane, this._psgOff(lane), when);
  },

  /** An FM channel's carriers at a key's `vel`, composed as a note's are, until keyFmOff. */
  keyFmLevel(ch, vel, when = this._keyNow()) {
    this._lv(`fm:${ch}`).key = { vel };
    this._writeFmLevel(ch, when);
  },

  /** The key on the channel let go: its level is the song's note's again. */
  keyFmOff(ch) {
    this._lv(`fm:${ch}`).key = null;
  },

  /** An OPN's CH3 in its special mode: every operator at `midi`, as one voice. */
  keyFm3Unison(midi) {
    for (let op = 1; op <= 4; op++) this._writeFm3OpPitch(op, midi, 0);
  },

  /**
   * A patch for a channel the keys borrow from the song, as writes (the
   * song's shadow stays the song's): its carriers at `vel` composed as a
   * note's on that channel are — its :vol and the master as shown — or at
   * the voiced level without one; the channel's own pan.
   */
  keyPatchWrites(ch, regs, vel, when = this._keyNow()) {
    const fm = this._fmEnc;
    const carriers = this._carrierOps(regs);
    const vol = this._lvVol(this._lv(`fm:${ch}`));
    const ops = regs.ops.map((o, i) => {
      const voiced = o.voicedTl ?? o.tl ?? 0;
      const tl = vel != null && carriers.includes(i)
        ? this._carrierTl({ voicedTl: voiced, velK: o.velK }, vel, vol, this._handMaster() ?? this._masterVol ?? VOL_UNITY)
        : voiced;
      return { ...o, tl: tl & 0x7f, rs: o.rs ?? 0, ar: o.ar ?? 0, d2r: o.d2r ?? 0, ssg: o.ssg ?? 0 };
    });
    // The OPLL's encoder keeps the song's voice as timelines: a held
    // channel's patch goes past them (chips/ym2413.js `held`).
    if (fm.held) return fm.held.patch(ch, { ...regs, ops }, ops[carriers[0]]?.tl);
    const out = [];
    ops.forEach((op, i) => {
      for (const reg of ["dt-ml", "tl", "ks-ar", "am-dr", "sr", "sl-rr", "ssg-eg"]) out.push(...fm.op(ch, i, reg, op));
    });
    out.push(...fm.alg(ch, regs));
    out.push(...fm.pan(ch, { pan: this._chRegs[ch]?.pan ?? 0, ams: regs.ams ?? 0, fms: regs.fms ?? 0 }));
    return out;
  },

  _keyNow() {
    return this._audioContext?.currentTime;
  },
};
