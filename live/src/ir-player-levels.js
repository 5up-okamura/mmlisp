// A voice's level (_lv: vel, the fader, a note's :vel / :vol macros, the
// panel's hand) composed where it is written; its pitch (_pt: the note, its
// :pitch offset, a note's :pitch / :semi macros); and a track's note — its
// gate, its close, its :keyon retriggers — one path for every voice.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { clampForTarget, pitchToMidi, VOL_UNITY } from "./ir-utils.js";
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

  // The level written again from what it is, whatever moved it (`why`): a
  // note's macro step ("liveVel" / "liveVol", the term that stepped), the
  // score's fader ("fader", _volWord), the panel's hand ("hand"). Only
  // where it is written differs by kind:
  //   fm, fm3op  the carriers' / the operator's TL
  //   psg        the lane's attenuation — a fader or the panel moves a keyed
  //              lane's only (an idle one's would drone a tone; its next
  //              note composes from it)
  //   voice      a chip's sample voice's sounding hit (_chipPcmWrite)
  //   strk       a sample track's fader: the hits it sounds
  //   pcm        a Mega Drive PCM voice: its model takes the term itself
  //   mtrk       a MIDI channel's: the output's plan plays it
  _lvWrite(site, when, why = "fader") {
    const [kind, at] = site.split(":");
    const n = Number(at);
    const step = why === "liveVel" || why === "liveVol";
    if (kind === "fm") {
      if (n === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(n, when);
    } else if (kind === "fm3op") {
      if (why !== "hand" || this._fm3Ops) this._writeFm3OpTl(n, when);
    } else if (kind === "psg") {
      // (the panel's move, while a run plays: a run knows a lane keyed at its
      // cursor, not at the chip's now — its level moves where the sent writes
      // end; stopped, the keys' lane is live)
      if (why === "hand" && this._playing && !this._lv(site).key && !(when != null && when >= this._writeCursor - 1e-9)) return;
      if (!step && !this._psgKeyed(n, when)) return;
      this._psgRecompose(n, when);
    } else if (kind === "voice") this._chipPcmWrite(at, when ?? this._audioContext?.currentTime ?? 0, why === "hand");
    else if (kind === "strk") {
      for (const [voice, h] of this._chipPcm?.owner ?? []) if (h.ti === n) this._chipPcmWrite(voice, when);
    } else if (kind === "pcm") {
      if (step) this._pcmLevelStep(n, why === "liveVel" ? "vel" : "vol", this._lv(site)[why], when);
      else this._pcmEv(when ?? 0, { kind: "vol", voice: n, value: this._lv(site).vol });
    }
  },

  // The fader's site an event's track writes (:vol): its voice's level, a
  // sample track's own (its hits on the chips' voices follow it), a MIDI
  // channel's; an fm3-N track's is its operator's (driver.md §13.4), the
  // note-less (fm3 …) track's the group fader over all four.
  _volSite(ev) {
    const r = ev._route, ti = ev._trackIndex;
    if (this._target?.name === "midi" || r?.core === "none") return `mtrk:${ti}`;
    if (r?.core === "fm") {
      const op = this._fm3OpOf(ev);
      return op ? `fm3op:${op}` : `fm:${ev._chIndex ?? 0}`;
    }
    if (r?.core === "psg") return `psg:${ev._psgCh ?? 0}`;
    if (r?.core === "sample") return r.part?.name === "dac" ? `pcm:${ev._chIndex ?? 0}` : `strk:${ti}`;
    return null;
  },

  // :vol, on any track: the fader at its site (_volSite) — a value, `+` `*`
  // `$slot`, a sweep a step a frame (written where it moves) — over a :vol
  // macro's until its next step, the level written again (_lvWrite). A Mega
  // Drive PCM voice's fader is its model's integer.
  _volWord(ev) {
    const site = this._volSite(ev);
    if (!site) return null;
    const L = this._lv(site);
    const fit = site.startsWith("pcm:") ? (v) => Math.round(Math.max(0, Math.min(31, v))) : (v) => Math.max(0, Math.min(31, v));
    const read = () => L.vol;
    const write = (v, t) => {
      this._lvSetVol(site, fit(v));
      this._lvWrite(site, t, "fader");
    };
    return { read, write, sweep: (e, when) => this._sweepWord(e, when, read(), (v, t) => { if (fit(v) !== L.vol) write(v, t); }) };
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

  // ---- a voice's pitch ----
  // One model for every pitched voice — an FM channel ("fm:0"), an fm3
  // operator ("fm3op:1"), a tone lane ("psg:0"), a chip's sample voice
  // ("voice:adpcm") — as the driver keeps a channel's (driver.md §8, §13):
  //
  //   midi     the note sounding
  //   offset   the voice's sticky :pitch, in cents (a sample track's own,
  //            `strk:N`, copied onto the voice it plays: _chipPcmHit)
  //   now      the pitch sounding, { note, cents }: a macro's step, or the
  //            note's onset; null where a :pitch / :snap write left the plain
  //            note + offset
  //   note     the note it is (a macro's step asks whether it still is)
  //
  // A :pitch step sounds note + v cents, a :semi step note + v semitones,
  // each over the offset where additive (`:pitch+`, `:semi+`) and over 0
  // where not — the later bind winning in a frame — as the driver's
  // NOTE_PITCH / NOTE_SEMI slots write; only where it is written differs by
  // kind (_ptWrite).
  _pt(site) {
    let P = this._pitches.get(site);
    if (!P) this._pitches.set(site, (P = { midi: 60, offset: 0, now: null, note: null }));
    return P;
  },

  // The pitch sounding: { note, cents }.
  _ptNow(P) {
    return P.now ?? { note: P.midi, cents: P.offset };
  },

  // The pitch written again from what it is.
  _ptWrite(site, when) {
    const [kind, at] = site.split(":");
    const n = Number(at);
    const { note, cents } = this._ptNow(this._pt(site));
    if (kind === "fm") this._writeFmNote(n, note, cents, when);
    else if (kind === "fm3op") this._writeFm3OpPitch(n, note, cents, when);
    else if (kind === "psg") this._psgSetPitch(n, note, cents, when);
    else if (kind === "voice") this._chipPcmWrite(at, when);
  },

  // A note begins on the voice at `midi`, sounding from `cents` (the
  // driver's onset_pitch: a running :pitch sweep's next value, else the
  // offset — _onsetPitchOffset).
  _ptNoteOn(site, midi, cents) {
    const P = this._pt(site);
    P.midi = midi;
    P.now = { note: midi, cents };
    P.note = {};
    return P;
  },

  // A :pitch / :snap write: the offset (where given) and the plain note, now.
  _ptOffset(site, cents, when) {
    const P = this._pt(site);
    if (cents != null) P.offset = cents;
    P.now = null;
    this._ptWrite(site, when);
  },

  // The note's :pitch and :semi macros (`args.pitchMacro`, `args.note_semi`),
  // in bind order: each step sounds its pitch and — while `live()` — writes
  // it. A first step on the note moves it at once: what the note sounds
  // from, which it writes itself once it has (live() false till then).
  _ptMacros(site, args, when, gateTicks, live = null) {
    const P = this._pt(site), note = P.note;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const run = (spec, semi) => {
      if (!spec) return;
      this._scheduleMacro(spec, noteFrames, gateSecs, when, (v, t) => {
        if (P.note !== note) return; // the voice's next note took it over
        const base = spec.add ? P.offset : 0;
        P.now = semi ? { note: P.midi + v, cents: base } : { note: P.midi, cents: base + v };
        if (!live || live()) this._ptWrite(site, t);
      }, this._stepSecs(spec.step));
    };
    const keys = Object.keys(args ?? {});
    const pair = [[args?.pitchMacro, false], [args?.note_semi, true]];
    if (args?.pitchMacro && args?.note_semi && keys.indexOf("note_semi") < keys.indexOf("pitchMacro")) pair.reverse();
    for (const [spec, semi] of pair) run(spec, semi);
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

  // ---- a note: one path for every voice ----
  // A note on any voice, `v` its adapter. What every note is, is this path's:
  // its gate (_noteGate) and :keyon retriggers (_keyonRetrigs), its level
  // (_lv at `v.level`) and pitch (_pt at `v.pitch`) with their macros, whose
  // first steps on the note move them at once and write nothing until it has
  // keyed. The voice says only what it writes: `v.key(n)` its key-on — the
  // level and pitch its first steps composed among its own writes, in its
  // chip's order — returning what closing is on it (`close(t, how)`,
  // _closeNote) and what a retrigger is (`retrigger(t, closed)`, `tailOff(t)`,
  // _noteRetriggers). `n`: { ti, gate, retrigs, pitchMoved() }.
  //   v.vel       its velocity (the note's when absent)
  //   v.levelArgs the macros its level takes (the note's :vel and :vol)
  //   v.midi      its note (the note's pitch when absent)
  //   v.pitchOn   false where an event before it set its note (an fm3
  //               operator's FM3_OP_PITCH): its macros only
  //   v.pitchGate the span its pitch macros run (the note's macros')
  //   v.audible   whether its track is heard (its voice's strip, a sample's)
  // A note of a track not heard (muted, or another soloed: `v.audible`, its
  // track's when absent) only silences its voice (`v.silence`, its level's
  // site when absent: _silence) — a previous note left sounding, or one
  // queued before the mute landed, must not ring on; it keys nothing, and
  // its record closes as any note's does.
  _playNote(ev, when, v) {
    const ti = ev._trackIndex ?? 0;
    if (!(v.audible ?? this._isTrackAudible(ti))) return void this._silence(v.silence ?? v.level, when);
    const gate = this._gateOf(ti) ?? this._noteGate(ev, when);
    const retrigs = this._retrigsOf(ti);
    let keyed = false;
    const live = () => keyed;
    if (v.level) {
      this._lvNoteOn(v.level, v.vel ?? ev.args?.vel ?? 15);
      this._envRetrigs = retrigs; // (its level's envelopes start over at each)
      this._lvMacros(v.level, v.levelArgs ?? ev.args ?? {}, when, gate.macroGate, live);
      this._envRetrigs = null;
    }
    let onset = null;
    if (v.pitch) {
      const P = v.pitchOn === false ? this._pt(v.pitch)
        : this._ptNoteOn(v.pitch, v.midi ?? pitchToMidi(ev.args?.pitch ?? "c4"), this._onsetPitchOffset(ev, this._pt(v.pitch).offset));
      onset = P.now;
      this._ptMacros(v.pitch, ev.args, when, v.pitchGate ?? gate.macroGate, live);
    }
    const n = { ti, gate, retrigs, pitchMoved: () => this._pt(v.pitch).now !== onset };
    const r = v.key?.(n) ?? {};
    keyed = true;
    if (r.close) this._noteCloses(ti, r.close);
    if (r.retrigger) this._noteRetriggers(ti, r.retrigger, r.tailOff);
    return n;
  },

  // A note's macro on a word of its voice beyond its level and pitch (an
  // FM channel's :pan and operator words, a lane's :pan, :wave, :duty,
  // :mode, the SSG's mixer and noise period): each step written by
  // `write(v, t)` from the note's frames, within its gate. A :keyon
  // retrigger starts it over — the driver restarts every slot but a
  // place's: :pan runs on, as :pitch does (`runsOn`, driver.md §14).
  // `moved`: a step written only where its rounded value moves (a register
  // a rewrite would re-trigger).
  _noteMacro(spec, n, when, write, { runsOn = false, moved = false } = {}) {
    if (!spec) return;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, n.gate.macroGate);
    let last = null;
    const step = moved ? (v, t) => { const r = Math.round(v); if (r !== last) write(r, t); last = r; } : write;
    this._envRetrigs = runsOn ? null : n.retrigs;
    this._scheduleMacro(spec, noteFrames, gateSecs, when, step, this._stepSecs(spec.step));
    this._envRetrigs = null;
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
      // its :keyon retriggers, one stream (_noteRetriggers); what it does when
      // let go — its held macros' release (_onLetGo) — and where it closed
      // and what waits for that (an echo tail's key-off)
      retrigs: this._keyonRetrigs(ev.args?.keyon, when, gate.macroGate),
      release: [], closedAt: null, closed: [],
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
    const { spec, when, gateTicks } = o.retrigs;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const tail = (end) => {
      if (keyOff && end != null && end > o.closedAt + 1e-9) this._whileNote(ti, end, () => keyOff(end));
    };
    // The :keyon macro stepped as every macro is (_scheduleMacro), in the
    // KEYON phase — after the frame's dispatch and sweeps, before its
    // macros, in track order, as the driver steps its channels' KEYON slots
    // — each step >= 0.5 but the note's own attack a retrigger.
    this._scheduleMacro(spec, noteFrames, gateSecs, when, (v, t) => {
      if (v >= 0.5 && t > when + 1e-6) retrigger(t, o.closedAt != null && t >= o.closedAt - 1e-9);
    }, o.retrigs.step, (end) => {
      if (o.closedAt != null) tail(end);
      else o.closed.push(() => tail(end));
    }, { phase: KEYON, ord: [ti] });
  },
  // What closing track `ti`'s note does on its voice: `close(t, how)`, how
  // { next, legato, keys } at the track's next note, { host } at the host's
  // key-off, { gate } at its gate's end, {} at a rest or the track's end.
  _noteCloses(ti, close) {
    const o = this._open[ti];
    if (o && o.note === this._noteOf[ti]) o.close = close;
  },
  // What the note of `scope` (its track and note) does when it is let go:
  // its record's list (a throwaway where it has none — a key of Live's).
  _onLetGo(scope) {
    const o = this._open[scope.ti];
    return o && o.note === scope.note ? o.release : [];
  },
  // Note `o` let go at `when` — closed, or a hot-swap's boundary while it
  // holds: its macros take their release where the steps the run has sent
  // end, its retriggers stop (each once).
  _letGo(o, when) {
    const off = Math.max(when, this._sentUntil() ?? when);
    for (const f of o.release.splice(0)) f(off);
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
    if (!how.next) this._letGo(o, t);
    for (const f of o.closed) f();
  },


};
