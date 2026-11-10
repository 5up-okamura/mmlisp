// The panel's controls on the preview (hold / release / read, the hands a
// pause's resume carries): a word or register held is gated, a level (a
// strip's :vol, MASTER) laid over the score's.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { VOL_UNITY } from "./ir-utils.js";
import { toneLaneOf } from "./targets.js";
import { CORE_OF_KIND, WAVE_LFO_WORDS } from "./ir-player-shared.js";

// ---- the panel's controls ----
// A control is one thing the panel shows and can take in hand:
//   { id: "tempo" | "MASTER" | "LFO_RATE" …, kind: "word", word }   a song-wide word
//   { id: "vol:fm1", kind: "vol", strip }                            a strip's :vol
//   { id: "reg:0:FM_TL1", kind: "reg", ch, word }                    an FM channel's register word
//   { id: "val:cutoff", kind: "val", name }                          a value slot
// The players answer three calls for any of them (DrvPlayer has the same):
// hold — `value` sounds now and is the control's while it is held; release
// — let go, it stays until the score next writes it; read — what it is
// now. A run starts with the score's own values (play, seek).
//
// Two mechanisms carry a hand here. A level — a strip's :vol, MASTER — is
// laid over: the score's own runs on unheard, and wherever a level is
// composed the panel's value stands in (_handVol, _handMaster), so letting
// go has the score's to come back to. A word, a register and a slot are
// gated: the score's writes of one in hand are skipped (_scoreWrites), at
// their own time — a sweep's and a macro's frames wait for it (_at) — and
// the state is the panel's until the score takes it back.
//
// The player's state is the song at its cursor (the last horizon), and the
// chip is behind it by the lookahead: what the run has already sent plays
// out under a hand just taken. So the panel's write is made twice — now,
// and again where the sent writes end (_writeCursor) — and a hand has the
// chip to itself within the lookahead.
export const panelMethods = {
  /** The panel takes `c` in hand at `value`. */
  hold(c, value) {
    this._handCtl.set(c.id, c);
    if (c.kind === "vol") return this._holdVol(c.strip, value);
    if (c.word === "MASTER") {
      this._masterHand = { v: Math.max(0, Math.min(31, Math.round(value))), held: true };
      this._levelsNow();
      return;
    }
    const h = this._hands.get(c.id);
    if (h) h.held = true;
    else this._hands.set(c.id, { held: true });
    this._panelWrite = true;
    try {
      if (c.kind === "val") this.setVal(c.name, value);
      else if (c.word === "tempo") this._setTempoNow(value);
      else {
        const ch = c.kind === "reg" ? c.ch : 0;
        this.setParam(c.word, value, ch);
        const sent = this._sentUntil();
        if (sent != null) this.setParam(c.word, value, ch, sent);
      }
    } finally {
      this._panelWrite = false;
    }
  },

  /**
   * The controls in the panel's hand now — held, or let go and not yet
   * written over by the score — with the value each has: what a pause's
   * resume carries over (`seek`'s `hands`).
   * @returns {{ c: object, v: number, held: boolean }[]}
   */
  hands() {
    const out = [];
    for (const c of this._handCtl.values()) {
      const r = this.read(c);
      if (!r?.hand) continue;
      const held = c.kind === "vol" ? !!this._lv(this._volSites(c.strip)[0] ?? "").hand?.held
        : c.word === "MASTER" ? !!this._masterHand?.held : !!this._hands.get(c.id)?.held;
      out.push({ c, v: r.v, held });
    }
    return out;
  },

  // The panel's hands put back at `at` (a seek's point): each control's
  // value written there over the score's, held or let go as it was.
  _applyHands(list, at) {
    for (const { c, v, held } of list) {
      this.hold(c, v);
      if (c.kind === "vol") for (const site of this._volSites(c.strip)) this._levelNow(site, at);
      else if (c.word === "MASTER") this._recomposeLevels(at);
      else if (c.kind !== "val" && c.word !== "tempo") {
        this._panelWrite = true;
        try {
          this.setParam(c.word, v, c.kind === "reg" ? c.ch : 0, at);
        } finally {
          this._panelWrite = false;
        }
      }
      if (!held) this.release(c);
    }
  },

  /** The panel lets go of `c`: its value stays until the score writes it. */
  release(c) {
    if (c.kind === "vol") return this._releaseVol(c.strip);
    const h = c.word === "MASTER" ? this._masterHand : this._hands.get(c.id);
    if (h) h.held = false;
  },

  /**
   * `c` now, as the panel shows it. `hand`: the panel's value is in force
   * (held, or let go and not yet written over); `score`, for a level (a
   * strip's :vol, MASTER), is the score's value under it.
   * @returns {{ v: number, hand: boolean, score?: number } | null}
   */
  read(c) {
    if (c.kind === "vol") return this._volOf(c.strip);
    const when = this._audioContext?.currentTime ?? 0;
    if (c.word === "MASTER") {
      const score = this._masterVol ?? VOL_UNITY;
      return { v: this._masterHand ? this._masterHand.v : score, hand: !!this._masterHand, score };
    }
    const hand = this._hands.has(c.id);
    if (c.kind === "val") {
      const v = this.getVal(c.name);
      return v == null ? null : { v, hand };
    }
    if (c.kind === "reg") return { v: this._readParam(c.ch, c.word), hand };
    switch (c.word) {
      case "tempo": return { v: this._bpm, hand };
      case "LFO_RATE": return { v: this._lfoRate ?? 0, hand };
      default: {
        // The machine's LFO words: a wave chip's own where it has one, else the OPM's.
        const wave = this._toneEnc.some((l) => l?.enc.lfoFreq) ? WAVE_LFO_WORDS[c.word] : null;
        const opm = { LFO_FREQ: "freq", LFO_PMD: "pmd", LFO_AMD: "amd", LFO_WAVE: "wave" }[c.word];
        if (wave && wave !== "lfoTable") return { v: this._waveLfo[wave] ?? 0, hand };
        return opm ? { v: this._opmLfo?.[opm] ?? 0, hand } : null;
      }
    }
  },

  // Where the writes the run has sent end, while it plays: the time the
  // panel's write is made again (hold), after the last of them.
  _sentUntil() {
    return this._playing && Number.isFinite(this._writeCursor) ? this._writeCursor : null;
  },

  // The panel's MASTER, or null: laid over the score's wherever a level is composed.
  _handMaster() {
    return this._masterHand ? this._masterHand.v : null;
  },

  // Every level recomposed, after the panel moved MASTER: now, and where the
  // sent writes end.
  _levelsNow() {
    const now = this._playing ? this._audioContext?.currentTime : undefined;
    for (const when of [now, this._sentUntil()]) if (when !== null) this._recomposeLevels(when);
  },

  /** The value slots whose value is the panel's now, name → value. */
  valsInHand() {
    const out = {};
    for (const id of this._hands.keys()) if (id.startsWith("val:")) out[id.slice(4)] = this.getVal(id.slice(4));
    return out;
  },

  // A score write of the control `id`: skipped while it is held; let go, the
  // score takes it back.
  _scoreWrites(id) {
    const h = this._hands.get(id);
    if (!h) return true;
    if (h.held) return false;
    this._hands.delete(id);
    return true;
  },

  // ---- a strip's :vol in the panel's hand ----
  // A strip is its channels (`heads`) and the tracks on them, and for a
  // chip's sound several tracks share (the YM2608's rhythm) that sound, its
  // `voice`. Its level's site comes from the channels, so a player with no
  // tracks (the keys' while stopped) takes the hand as well. Held, the strip's level is
  // composed with the panel's value wherever the score's :vol goes in — the
  // score's own :vol writes run on unheard, so letting go has them to come
  // back to; let go, the value stays until the score writes :vol (a value, a
  // sweep, a note's :vol macro) on one of the strip's tracks.

  // `value` (0-31) sounds now, the score's :vol unheard while held.
  // strip: { heads: string[], tracks: number[], voice?: string }
  _holdVol(strip, value) {
    const sites = this._volSites(strip);
    if (!sites.length) return;
    let hand = this._lv(sites[0]).hand;
    if (!hand) {
      hand = { tracks: new Set(strip.tracks), sites };
      for (const site of sites) this._lv(site).hand = hand;
    }
    // Strips that share a site (the fm3 parts on channel 3) share its hand.
    for (const ti of strip.tracks ?? []) hand.tracks.add(ti);
    hand.v = Math.max(0, Math.min(31, Math.round(value)));
    hand.held = true;
    const sent = this._sentUntil();
    for (const site of sites) {
      this._levelNow(site, this._playing ? this._audioContext?.currentTime : undefined);
      if (sent != null) this._levelNow(site, sent);
    }
  },

  // Let go: it stays until the score writes :vol there.
  _releaseVol(strip) {
    const site = this._volSites(strip)[0];
    const hand = site && this._lv(site).hand;
    if (hand) hand.held = false;
  },

  // A strip's :vol now: the panel's while in hand, else the score's, its
  // :vol macro's included — and the score's either way (`score`).
  _volOf(strip) {
    const site = this._volSites(strip)[0];
    if (!site) return null;
    const when = this._audioContext?.currentTime ?? 0;
    const [kind, at] = site.split(":");
    const n = Number(at);
    const score = Math.round(kind === "fm" || kind === "fm3op" || kind === "psg" || kind === "pcm" ? this._lvScoreVol(this._lv(site))
      : kind === "midi" ? this._lvScoreVol(this._lv(`mtrk:${strip.tracks[0]}`))
      : this._lv(`strk:${strip.tracks[0]}`).vol);
    const hand = this._lv(site).hand;
    return { v: hand ? hand.v : score, hand: !!hand, score };
  },

  // Where a strip's level is composed: an FM channel, a PSG lane, a Mega
  // Drive PCM voice, a chip's sample voice.
  _volSites(strip) {
    if (strip.voice != null) return [`voice:${strip.voice}`];
    const sites = new Set();
    for (const head of strip.heads ?? []) {
      // A MIDI channel's :vol, the drums' too, is its output's (midi-output.js),
      // which reads the hand.
      if (this._target?.name === "midi") {
        sites.add(`midi:${head}`);
        continue;
      }
      const c = this._target.channels[head];
      const core = c && CORE_OF_KIND[c.part.kind];
      // An fm3 part's :vol is its operator's own (driver.md §13.4).
      const op = /^fm3-([1-4])$/.exec(head);
      if (op) sites.add(`fm3op:${op[1]}`);
      else if (core === "fm") sites.add(`fm:${c.voice}`);
      else if (core === "psg") sites.add(`psg:${toneLaneOf(c)}`);
      else if (core === "sample") sites.add(c.part.mixVoice ? `voice:${c.part.mixVoice(c.voice)}` : `pcm:${c.voice}`);
    }
    return [...sites];
  },

  // The panel's :vol at a level's site, or null.
  _handVol(site) {
    return this._levels.get(site)?.hand?.v ?? null;
  },

  // A score write of :vol on track `ti` takes a strip the panel let go back.
  // A Mega Drive PCM voice keeps its fader in the engine's model, where the
  // panel's value went: it gets the score's back (a note's :vol macro would
  // not say it).
  _volTakeBack(ti, when) {
    for (const hand of new Set([...this._levels.values()].map((L) => L.hand))) {
      if (!hand || hand.held || !hand.tracks.has(ti)) continue;
      for (const site of hand.sites) {
        this._lv(site).hand = null;
        const [kind, n] = site.split(":");
        if (kind === "pcm") this._pcmEv(when, { kind: "vol", voice: Number(n), value: this._lv(site).vol });
      }
    }
  },

  // A level recomposed at `when` (now when absent), after the panel moved
  // it: an FM channel, a keyed PSG lane, a Mega Drive PCM voice; a chip's
  // sample voice its sounding hit's (_chipPcmWrite).
  _levelNow(site, when) {
    const [kind, at] = site.split(":");
    const n = Number(at);
    if (kind === "fm") {
      if (n === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(n, when);
    } else if (kind === "fm3op") {
      if (this._fm3Ops) this._writeFm3OpTl(n, when);
    } else if (kind === "psg") {
      // A fader move must never un-silence an idle lane into a tone. A run
      // knows a lane keyed at its cursor, not at the chip's now: its level
      // moves where the sent writes end. Stopped, the keys' lane is live.
      if (this._playing && !this._lv(site).key && !(when != null && when >= this._writeCursor - 1e-9)) return;
      if (this._psgKeyed(n, when)) this._psgRecompose(n, when);
    } else if (kind === "pcm") this._pcmEv(when ?? 0, { kind: "vol", voice: n, value: this._handVol(site) });
    else if (kind === "voice") this._chipPcmWrite(at, when ?? this._audioContext?.currentTime ?? 0, true);
  },

  // ---- the keys ----
  // Live's keys play the score's machine through this player: a channel of
  // the running song they take over, or, stopped, the panel's own player. A
  // key's level is a note's: its velocity composed with its lane's :vol and
  // the master as the panel shows them (the score's, or the panel's hand), so
  // a key sounds at what is shown. `when` is now when absent.
};
