// A voice's level (_lv: vel, the fader, a note's :vel / :vol macros, the
// panel's hand) composed where it is written, and a full gate's key-off or
// silence left to the track's next event.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { clampForTarget, VOL_UNITY } from "./ir-utils.js";
import { MACRO } from "./ir-player-shared.js";

export const levelMethods = {
  // ---- a voice's level ----
  // One model for every voice whose level the player composes — an FM
  // channel ("fm:0"), an fm3 operator ("fm3op:1"), a tone lane ("psg:0") —
  // kept by the site its strip's :vol names (_volSites):
  //
  //   vel, vol          the score's: its note's velocity, its fader
  //   liveVel, liveVol  its note's :vel / :vol macro, where one has stepped
  //   note, ends        the note sounding, and when its macros' levels end
  //   key               a key of Live's holding the voice: { vel }
  //   hand              the panel's hand on its :vol: { v, held, tracks, sites }
  //
  // The level is composed from what these are, each time one moves — a
  // note's key-on, a macro's step, a :vol or :master write, a sweep's step,
  // the panel, a key — as the driver re-composes a keyed channel (driver.md
  // §7); only where the result is written differs by kind (_lvWrite). A
  // sample voice and a MIDI channel keep the score's level in models of their
  // own: here they have the panel's hand.
  _lv(site) {
    let L = this._levels.get(site);
    if (!L) this._levels.set(site, (L = { vel: 15, vol: VOL_UNITY, liveVel: null, liveVol: null, note: null, ends: [], key: null, hand: null }));
    return L;
  },

  // What a level is composed from now: a key's velocity over the note's, the
  // panel's :vol over the score's.
  _lvVel(L) {
    return L.key?.vel ?? L.liveVel ?? L.vel;
  },

  _lvVol(L) {
    return L.hand ? L.hand.v : this._lvScoreVol(L);
  },

  _lvScoreVol(L) {
    return L.liveVol ?? L.vol;
  },

  // The level written again from what it is.
  _lvWrite(site, when) {
    const [kind, at] = site.split(":");
    const n = Number(at);
    if (kind === "fm") {
      if (n === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(n, when);
    } else if (kind === "fm3op") this._writeFm3OpTl(n, when);
    else if (kind === "psg") this._psgRecompose(n, when);
  },

  // A note begins on the voice: its velocity, the last note's macros gone.
  _lvNoteOn(site, vel) {
    const L = this._lv(site);
    L.vel = vel;
    L.liveVel = L.liveVol = null;
    L.note = {};
    return L;
  },

  // The note's :vel and :vol macros: each step, in its frame (MACRO), moves
  // the note's live value and — while `live()` — the level is written from
  // both as they are then. In bind order: which of the two steps first in a
  // frame. The note's `lvl`: when its level macros are done (_lvEnded).
  _lvMacros(site, args, when, gateTicks, live = null) {
    const L = this._lv(site);
    const note = L.note;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const lvl = (note.lvl = { left: 0, at: null, waiters: [] });
    const run = (spec, target, key) => {
      if (!spec) return;
      lvl.left++;
      this._scheduleMacro(spec, noteFrames, gateSecs, when, (v, t) => {
        if (L.note !== note) return; // the voice's next note took it over
        L[key] = clampForTarget(target, v);
        if (!live || live()) this._lvWrite(site, t);
      }, this._stepSecs(spec.step), (end) => {
        if (end != null) lvl.at = Math.max(lvl.at ?? -Infinity, end);
        if (--lvl.left === 0) for (const f of lvl.waiters.splice(0)) f(lvl.at);
      });
    };
    const keys = Object.keys(args);
    const pair = [[args.velMacro, "VEL", "liveVel"], [args.vol, "VOL", "liveVol"]];
    if (args.vol && args.velMacro && keys.indexOf("vol") < keys.indexOf("velMacro")) pair.reverse();
    for (const [spec, target, key] of pair) run(spec, target, key);
  },

  // `fn(at)` once the note's level macros at `site` have written their last:
  // the time just after it, or null when they write nothing.
  _lvEnded(site, fn) {
    const lvl = this._lv(site).note?.lvl;
    if (!lvl || lvl.left === 0) fn(lvl?.at ?? null);
    else lvl.waiters.push(fn);
  },

  // The fader written (a value, a sweep's step): over a :vol macro's until its next step.
  _lvSetVol(site, vol) {
    const L = this._lv(site);
    L.vol = Math.max(0, Math.min(31, vol));
    L.liveVol = null;
    return L;
  },

  // ---- a tone lane's level ----
  // Its attenuation, from the lane's level as it is (_lv).
  _psgRecompose(lane, when) {
    const L = this._lv(`psg:${lane}`);
    if (!L.note && !L.key) return;
    this._psgSetAtt(lane, this._composePsgAtt(lane, this._lvVel(L), this._lvVol(L), this._masterVol ?? VOL_UNITY), when);
  },

  // Whether the lane's note is keyed at `t` (now when absent): a :vol, a
  // :master or a sweep moves a keyed lane's level only — written to an idle
  // lane, a level would drone a tone.
  _psgKeyed(lane, t) {
    const L = this._lv(`psg:${lane}`);
    if (L.key) return true; // a key of Live's holds it
    return L.note != null && (t ?? -Infinity) < (this._psgKeyedUntil[lane] ?? 0) - 1e-6;
  },

  // A note's level on its lane: its key-on's, then its :vel and :vol macros a
  // step at a time, and silence at its gate — or, with a macro, at the
  // level's tail. gateTicks === 0 is a held note (triggerKeyOff ends it);
  // offWhen is null when the note holds or slurs into the next.
  _psgNoteLevel(psgCh, ev, noteWhen, gateTicks, baseVel, offWhen) {
    const args = ev.args;
    const site = `psg:${psgCh}`;
    const L = this._lvNoteOn(site, Math.max(0, Math.min(15, baseVel)));
    // A first sample on the note itself is what the key-on composes from
    // (driver.md §7.2): the macros' steps write once the key-on has.
    let keyed = false;
    this._lvMacros(site, args, noteWhen, gateTicks, () => keyed);
    this._psgRecompose(psgCh, noteWhen);
    keyed = true;
    // Silence at the gate, or with a macro at the level's tail — while the
    // note is the track's: the next note takes the level over.
    if (offWhen != null) this._psgSilence(psgCh, ev._trackIndex, !!(args.velMacro || args.vol), offWhen);
  },

  // A tone lane's silence at the end of its note's gate `off`: there, or
  // with a level macro at its tail.
  _psgSilence(psgCh, ti, macros, off) {
    if (!macros) return void this._psgSetAtt(psgCh, this._psgOff(psgCh), off);
    this._lvEnded(`psg:${psgCh}`, (at) => {
      if (at != null) this._whileNote(ti, at, () => this._psgSetAtt(psgCh, this._psgOff(psgCh), at));
    });
  },

  // A full-gate note's silence, at the track's next event that is not a
  // note: a rest, the track's end.
  _psgResolveOff(psgCh, ti, t) {
    const p = this._psgPending[psgCh];
    if (!p) return;
    this._psgPending[psgCh] = null;
    this._psgKeyedUntil[psgCh] = t;
    this._psgSilence(psgCh, ti, p.macros, t);
  },

  // A rest, or the track's end, on a track whose note's gate was full: its
  // key-off or silence now (driver: `pendingOff`, resolved by the next event).
  _resolveOff(ev, t) {
    const r = ev._route;
    if (r?.core === "psg") return void this._psgResolveOff(ev._psgCh ?? 0, ev._trackIndex, t);
    if (r?.core !== "fm") return;
    const op = this._fm3OpOf(ev);
    if (op) {
      if (this._fm3Pending[op - 1] != null) this._fm3ResolveOff(op, t);
      return;
    }
    const ch = ev._chIndex ?? 0;
    if (!this._pendingKeyOff[ch]) return;
    this._pendingKeyOff[ch] = false;
    if (!this._csmKeysCh3(ch)) this._fmKey(ch, 0, t);
  },
};
