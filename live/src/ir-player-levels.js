// A voice's level (_lv: vel, the fader, a note's :vel / :vol macros, the
// panel's hand) composed where it is written, and a full gate's key-off or
// silence left to the track's next event.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { clampForTarget, VOL_UNITY } from "./ir-utils.js";
import { KEYON, MACRO } from "./ir-player-shared.js";

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
  // chip's sample voice ("voice:adpcm", "voice:pcm8-0", a rhythm sound's) is
  // one too, its fader the track's (_sampleLevel); a Mega Drive PCM voice
  // ("pcm:0") is composed in the driver's own voice model, which its note's
  // levels are sent to; a MIDI channel ("mtrk:0") is the output's.
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

  // The level written again from what it is (`key`: what moved, where the
  // voice's model takes the term itself).
  _lvWrite(site, when, key = null) {
    const [kind, at] = site.split(":");
    const n = Number(at);
    if (kind === "fm") {
      if (n === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(n, when);
    } else if (kind === "fm3op") this._writeFm3OpTl(n, when);
    else if (kind === "psg") this._psgRecompose(n, when);
    else if (kind === "voice") this._chipPcmWrite(at, when);
    else if (kind === "pcm" && key) this._pcmLevelStep(n, key === "liveVel" ? "vel" : "vol", this._lv(site)[key], when);
  },

  // A sample voice's level now — its note's velocity and :vol macro, the
  // panel's hand, over its track's fader — and the master: { vel, vol, master }.
  _sampleLevel(site, ti) {
    const L = this._lv(site);
    return {
      vel: this._lvVel(L),
      vol: L.hand ? L.hand.v : (L.liveVol ?? this._lv(`strk:${ti}`).vol),
      master: this._handMaster() ?? this._masterVol ?? VOL_UNITY,
    };
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
  // A first step on the note itself moves the value at once: what the note's
  // key-on composes from, as the driver's note-on does (driver.md §7.2) —
  // `live()` false until it has keyed — and what a :keyon retrigger starts
  // over from (`first`, _lvRetrig).
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
        if (!live || live()) this._lvWrite(site, t, key);
      }, this._stepSecs(spec.step), (end) => {
        if (end != null) lvl.at = Math.max(lvl.at ?? -Infinity, end);
        if (--lvl.left === 0) for (const f of lvl.waiters.splice(0)) f(lvl.at);
      });
    };
    const keys = Object.keys(args);
    const pair = [[args.velMacro, "VEL", "liveVel"], [args.vol, "VOL", "liveVol"]];
    if (args.vol && args.velMacro && keys.indexOf("vol") < keys.indexOf("velMacro")) pair.reverse();
    for (const [spec, target, key] of pair) run(spec, target, key);
    note.first = { liveVel: L.liveVel, liveVol: L.liveVol };
  },

  // A :keyon retrigger of the note at `site`: its level envelopes start over
  // from their first samples, which the re-key composes from.
  _lvRetrig(site) {
    const L = this._lv(site), first = L.note?.first;
    if (first) Object.assign(L, first);
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
  // step at a time (its silence is its close's, _psgSilence).
  _psgNoteLevel(psgCh, ev, noteWhen, gateTicks, baseVel) {
    const args = ev.args;
    const site = `psg:${psgCh}`;
    const L = this._lvNoteOn(site, Math.max(0, Math.min(15, baseVel)));
    // A first sample on the note itself is what the key-on composes from
    // (driver.md §7.2): the macros' steps write once the key-on has.
    let keyed = false;
    this._lvMacros(site, args, noteWhen, gateTicks, () => keyed);
    this._psgRecompose(psgCh, noteWhen);
    keyed = true;
  },

  // A tone lane's silence at the end of its note's gate `off`: there, or
  // with a level macro at its tail.
  _psgSilence(psgCh, ti, macros, off) {
    if (!macros) return void this._psgSetAtt(psgCh, this._psgOff(psgCh), off);
    this._lvEnded(`psg:${psgCh}`, (end) => {
      // (a tail done before the gate closed, or none written: at its close)
      const at = Math.max(end ?? off, off);
      this._whileNote(ti, at, () => this._psgSetAtt(psgCh, this._psgOff(psgCh), at));
    });
  },

  // ---- a track's note: one gate rule, one close, for every voice ----
  // A note's gate, as the driver keeps it on every channel (opcodes.md
  // §3.1): 0 holds — the host's key-off, a rest or the track's end closes
  // it; one that reaches the note's end (none written, or the note's own
  // length) closes at the track's next event (`open`, the driver's
  // pendingOff); any other closes at its end (`timed`), inside a tie when it
  // reaches past the note. The note's macros run as a held note's until it
  // closes (`macroGate` 0) unless its gate is shorter than the note.
  _noteGate(ev, when) {
    const length = ev.args?.length ?? 0;
    const ticks = this._frameGate(when, ev.args?.gate ?? length, length);
    const hold = !(ticks > 0);
    return {
      length, ticks, hold,
      open: !hold && ticks === length,
      timed: !hold && ticks !== length,
      end: hold ? Infinity : this._timeAfterTicks(when, ticks),
      macroGate: hold || ticks >= length ? 0 : ticks,
    };
  },

  // Track `ti`'s note `ev` at `when` opens: its gate decided (_noteGate),
  // and a timed gate's close set at its end ({ gate }: on a frame-clocked
  // machine, whole frames from its key-on, on every voice). What closing
  // does on its voice is the voice's (_noteCloses).
  _openNote(ti, ev, when) {
    const gate = this._noteGate(ev, when);
    const o = (this._open[ti] = {
      note: this._noteOf[ti], gate, at: gate.end, close: null, key: this._holdKey(ev),
      // its :keyon retriggers, one stream (_noteRetriggers); where it closed,
      // and what waits for that
      retrigs: this._keyonRetrigs(ev.args?.keyon, when, gate.macroGate), closedAt: null, closed: [],
    });
    if (gate.timed) this._whileNote(ti, gate.end, () => { if (this._open[ti] === o) this._closeNote(ti, gate.end, { gate: true }); });
    return gate;
  },
  // The gate of track `ti`'s note dispatching now.
  _gateOf(ti) {
    return this._open[ti]?.gate;
  },
  // Its :keyon retriggers (_keyonRetrigs): what its envelopes start over at
  // (_envRetrigs) and its voice re-attacks at (_noteRetriggers).
  _retrigsOf(ti) {
    return this._open[ti]?.retrigs ?? null;
  },
  // Track `ti`'s note's :keyon retriggers on its voice: `retrigger(t,
  // closed)` re-attacks it at each (`closed`: past the note's close — an
  // echo tail, which the release region steps); and where the stream ends
  // past the close, `keyOff(t)` keys the tail off a step after the macro's
  // last, as the driver's KEYON slot does at its release's end — while the
  // note is the track's.
  _noteRetriggers(ti, retrigger, keyOff = null) {
    const o = this._open[ti];
    if (!o?.retrigs || o.note !== this._noteOf[ti]) return;
    const tail = (end) => {
      if (keyOff && end != null && end > o.closedAt + 1e-9) this._whileNote(ti, end, () => keyOff(end));
    };
    // (a frame's retriggers in track order, as the driver steps its channels')
    this._eachTime(o.retrigs, (t) => retrigger(t, o.closedAt != null && t >= o.closedAt - 1e-9), KEYON, (end) => {
      if (o.closedAt != null) tail(end);
      else o.closed.push(() => tail(end));
    }, [ti]);
  },
  // What closing track `ti`'s note does on its voice: `close(t, how)`, how
  // { next, legato, keys } at the track's next note, { host } at the host's
  // key-off, { gate } at its gate's end, {} at a rest or the track's end.
  _noteCloses(ti, close) {
    const o = this._open[ti];
    if (o && o.note === this._noteOf[ti]) o.close = close;
  },
  // Track `ti`'s note closed at `t`: on its voice first, then its macros
  // take their release, as the driver's dispatch keys off before its
  // frame's macros step — but at the track's next note, which takes the
  // voice over.
  _closeNote(ti, t, how = {}) {
    const o = this._open[ti];
    if (!o) return;
    this._open[ti] = null;
    o.closedAt = t;
    o.close?.(t, how);
    if (!how.next) this._letGoNote(ti, t);
    for (const f of o.closed) f();
  },


};
