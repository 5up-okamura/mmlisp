// The frame-ordered work queue and the plain write queue: what an event sets
// going waits for its frame and its place in the driver's frame order
// (driver.md §4); a write ahead of the run waits for its time.
//
// A part of IRPlayer (ir-player.js), its methods mixed into the class there:
// `this` is the player.
import { KEYED, FM3_KEYS, UNSHIFTED, MACRO } from "./ir-player-shared.js";

export const workMethods = {
  /** A register write (port, addr, data) or a message ({ type, when, … }), at `when` — now when absent. */
  _write(portOrMsg, addr, data, when) {
    const msg = portOrMsg && typeof portOrMsg === "object" && !Array.isArray(portOrMsg);
    let t = msg ? portOrMsg.when : when;
    // Work of a frame writes after that frame's events (_runWork): what it
    // writes at its own time or ahead of it (a key-off's lead) moves with it.
    if (t != null && this._stampShift && t <= this._stampFrom + 1e-9) {
      t += this._stampShift;
      if (msg) portOrMsg = { ...portOrMsg, when: t };
      else when = t;
    }
    // On a frame-clocked target a write's time is its frame's (_sink).
    if (t != null && this._target?.frameClock) t = this._frameTime(t);
    if (t == null || t <= this._writeCursor) this._sink(portOrMsg, addr, data, when);
    else this._putAhead({ t, write: [portOrMsg, addr, data, when] });
  },

  // `run` at time `t`: now when the run has reached `t`, else as work of
  // `t`'s frame, in `phase`'s place in the frame's order.
  // `endless`: one of a chain that ends only when something stops it (a
  // held note's macro) — a run does not wait for it (_putWork).
  _at(t, run, phase = MACRO, endless = false) {
    if (t == null || t <= this._writeCursor) run();
    else this._putWork(this._eventFrame(t), phase, t, run, null, endless);
  },

  // `run` as work of frame `F`, whatever the time: a sweep's step waits for
  // its frame's events even in the frame it is dispatched in.
  // `endless`: one of a chain that ends only when something frees it (a
  // loop curve's steps) — a run does not wait for those to be done.
  _step(F, phase, t, run, ord = null, endless = false) {
    this._putWork(F, phase, t, run, ord, endless);
  },

  // Whether `when` is still ahead of the run: what composes a write from the
  // player's state (a level, a register word) waits for it then (_at), and
  // reads the state — and the panel's hand — as it is at that time.
  _isAhead(when) {
    return when != null && when > this._writeCursor;
  },

  // `ord`: within its frame and phase, the place the item takes — a list
  // compared in turn (FM3_KEYS: the driver's order, _scheduleFm3OpKey); a
  // dispatch's timed parts by time; the rest in the order they were made.
  _putWork(F, phase, t, run, ord = null, endless = false) {
    const q = this._work;
    const item = { F, phase, t, run, ord, endless };
    if (!endless) this._workFinite++;
    const after = (x) => {
      if (x.F !== F) return x.F > F;
      if (x.phase !== phase) return x.phase > phase;
      if (phase === KEYED) return x.t > t;
      if (!ord) return false;
      for (let i = 0; i < ord.length; i++) if (x.ord[i] !== ord[i]) return x.ord[i] > ord[i];
      return false;
    };
    const later = after;
    let lo = this._workHead, hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (later(q[mid])) hi = mid;
      else lo = mid + 1;
    }
    if (lo === q.length) q.push(item);
    else q.splice(lo, 0, item);
  },

  // The run reaches an event of frame `F` at time `t` (or a pass's horizon):
  // the work before it runs — every earlier frame's, and this frame's timed
  // parts up to `t` — then the plain writes up to `t` go out.
  _advance(F, t) {
    const q = this._work;
    while (this._workHead < q.length) {
      const item = q[this._workHead];
      if (!(item.F < F || (item.F === F && item.phase === KEYED && item.t <= t))) break;
      if (F === Infinity && !this._workFinite) break; // only endless chains are left
      this._workHead++;
      if (!item.endless) this._workFinite--;
      this._runWork(item);
    }
    if (this._workHead > 1024 && this._workHead * 2 > q.length) {
      q.splice(0, this._workHead);
      this._workHead = 0;
    }
    this._sendAhead(t);
  },

  _runWork(item) {
    // No earlier than its frame's last event: the driver's engines follow its dispatch.
    // (An event's time runs up to a frame past the frame's own, the driver
    // dispatching the ticks ahead of it: the work stays within half a frame
    // of its time, so the next frame's keeps its distance.)
    const ts = !UNSHIFTED.has(item.phase) && this._lastEvent.F === item.F
      ? Math.max(item.t, Math.min(this._lastEvent.t, item.t + 0.49 / 60)) : item.t;
    this._sendAhead(ts);
    const was = [this._stampFrom, this._stampShift];
    this._stampFrom = item.t;
    this._stampShift = ts - item.t;
    try {
      item.run();
    } finally {
      [this._stampFrom, this._stampShift] = was;
    }
  },

  // Work a run waits for: all but the endless chains.
  _workLeft() {
    return this._workFinite > 0;
  },

  // The time every call to the chip's encoders before it has been made by:
  // the horizon, or — with a frame's work still waiting — just before the
  // earliest time that work can carry (an event's frame begins up to a tick
  // ahead of its time, _eventFrame).
  _settled(horizon) {
    if (this._workHead >= this._work.length) return horizon;
    const F = this._work[this._workHead].F;
    return Math.min(horizon, this._frameOrigin + F / 60 - this._secsPerTick - 1e-6);
  },

  _putAhead(item) {
    const q = this._ahead;
    let lo = this._aheadHead, hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid].t <= item.t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === q.length) q.push(item);
    else q.splice(lo, 0, item);
  },

  // The run reaches time `until`: the plain writes up to it go out.
  _sendAhead(until) {
    const q = this._ahead;
    while (this._aheadHead < q.length && q[this._aheadHead].t <= until) {
      const item = q[this._aheadHead++];
      if (item.t > this._writeCursor) this._writeCursor = item.t;
      this._sink(...item.write);
    }
    if (until > this._writeCursor) this._writeCursor = until;
    if (this._aheadHead > 1024 && this._aheadHead * 2 > q.length) {
      q.splice(0, this._aheadHead);
      this._aheadHead = 0;
    }
  },

  _dropAhead() {
    this._ahead.length = 0;
    this._aheadHead = 0;
    this._work.length = 0;
    this._workHead = 0;
    this._workFinite = 0;
    this._stampFrom = -Infinity;
    this._stampShift = 0;
    this._lastEvent = { F: -Infinity, t: -Infinity };
  },
};
