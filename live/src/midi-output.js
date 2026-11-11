// ---------------------------------------------------------------------------
// MIDI output (MMLisp > MIDI > Output): a `:target midi` score played to a
// MIDI port as it plays — a sound module, a DAW, a synth.
//
// What goes out is the MIDI export's (export-midi.js midiPlan): the same
// channels, notes, programs, levels, pans and bends a .mid of the score
// holds, sent ahead of the audio with Web MIDI's timestamps, on the
// preview's own clock — each track on its IR track's (IRPlayer trackTickAt),
// so a tempo dialled in, a loop going round, a seek and a hold move it as
// they move the chips. A plan is the song once through its loop; past its
// end a looping song goes round from its loopStart.
//
//   a run's start or a seek  each channel's controllers as of the point
//                            (program, bend range, CCs, bend), then the
//                            notes from there
//   a hot-swap               the outgoing plan stops at the swap's bar, its
//                            notes off there; the incoming one goes on from
//                            the bar, its controllers as they stand
//   mute / solo              a track that does not sound sends no key; one
//                            muted mid-note lets it go at once
//   the panel's level        a strip's :vol or the MASTER in Live's hand
//                            (`levelOf`): a melodic channel's CC7 is the
//                            panel's level, sent as it moves and over the
//                            plan's; channel 10's keys, whose velocity holds
//                            the level, move by the difference from the
//                            score's (no louder than the key at full)
//   stop                     every key let go, All Notes Off on each channel
//   Live's keyboards         a key at once on a channel (keyOn / keyOff);
//                            stopped, the channel takes its opening voice
//                            from the plan first (channelOpening)
//
// A track past fifteen melodic channels is the file's second port: one
// output has one, so it is not sent (`onSkip` says so once).
//
// `MidiOutRun` takes no browser API: `send(bytes, timestampMs)` and
// `perfAt(audioTime)` are its caller's (Live: the MIDIOutput and the
// AudioContext's output timestamp), so node checks it
// (tools: check:midi-out).
// ---------------------------------------------------------------------------

import { RPN_BEND, midiPlan, faderDb, velocity7 } from "./export-midi.js";

// CC7 for a level in dB, as the plan writes it (export-midi.js level7).
const cc7Of = (db) => (db === -Infinity ? 0 : Math.max(0, Math.min(127, Math.round(127 * 10 ** (db / 40)))));
import { compileMMLisp } from "./mmlisp2ir.js";

export const midiOutSupported = typeof navigator !== "undefined"
  && typeof navigator.requestMIDIAccess === "function";

/**
 * The page's MIDI outputs: `list()` [{ id, name }], `output(id)`; `onChange`
 * when one comes or goes. Resolves null where the browser refused access.
 */
export async function openMidiOutputs(onChange) {
  let access;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch {
    return null;
  }
  access.addEventListener?.("statechange", () => onChange?.());
  return {
    list: () => [...access.outputs.values()].filter((o) => o.state !== "disconnected").map((o) => ({ id: o.id, name: o.name || "MIDI output" })),
    output: (id) => access.outputs.get(id) ?? null,
  };
}

/**
 * The plan of a score's source, compiled as the MIDI export compiles it (the
 * voices kept, no voice hoist), `vals` the def-vals' values; null on an
 * error. Live runs it in the compile worker (kind 'midi').
 */
export function midiPlanOf(src, name, imports, vals) {
  // A slider moved replans the score it compiled last: its IR is kept, as a
  // def-val's value changes no IR.
  const key = `${name}\u0000${src}\u0000${[...(imports ?? new Map())].map(([k, v]) => `${k}:${v.length}:${v}`).join("\u0000")}`;
  if (lastCompiled?.key !== key) {
    const { ir, diagnostics } = compileMMLisp(src, name, { imports, voiceStamps: true, voiceHoist: false });
    lastCompiled = { key, ir: diagnostics.some((d) => d.severity === "error") ? null : ir };
  }
  return lastCompiled.ir ? midiPlan(lastCompiled.ir, { vals }) : null;
}
let lastCompiled = null;

// A note's key, by channel: what a stop lets go.
const keyOf = (bytes) => ((bytes[0] & 0x0f) << 7) | bytes[1];
const isOn = (b) => (b[0] & 0xf0) === 0x90 && b[2] > 0;
const isOff = (b) => (b[0] & 0xf0) === 0x80 || ((b[0] & 0xf0) === 0x90 && b[2] === 0);
// What a run's start chases: a channel event that is not a key, by its kind
// (a controller by its number); the bend range's RPN goes as one block.
const RPN_CCS = new Set([101, 100, 6, 38]);
const chaseKey = (b) => {
  const kind = b[0] & 0xf0;
  if (kind === 0xb0) return RPN_CCS.has(b[1]) ? null : `cc${b[1]}`;
  if (kind === 0xc0 || kind === 0xe0) return `k${kind}`;
  return null;
};
// Grace for a plan that comes after its run began (it compiles off the
// page's thread): notes due this recently still go, at once.
const LATE_SEC = 0.25;

/**
 * A channel's opening voice in a plan: its bank, program, volume and pan as
 * they stand before its first key (the first track on it that sets each) —
 * what a key Live's keyboards play on it is sent after while the song is
 * stopped. Bytes, in the order to send them.
 */
export function channelOpening(plan, channel) {
  const got = new Map();
  for (const t of plan?.tracks ?? []) {
    if (t.port > 0 || t.channel !== channel) continue;
    const own = new Map();
    for (const { bytes } of t.events) {
      const kind = bytes[0] & 0xf0;
      if (kind === 0x90 && bytes[2] > 0) break;
      if (kind === 0xc0) own.set("prog", bytes);
      else if (kind === 0xb0 && OPENING_CC.includes(bytes[1])) own.set(bytes[1], bytes);
    }
    for (const [k, b] of own) if (!got.has(k)) got.set(k, b);
  }
  return [0, 32, "prog", 7, 10].filter((k) => got.has(k)).map((k) => [...got.get(k)]);
}
const OPENING_CC = [0, 32, 7, 10];

export class MidiOutRun {
  /**
   * @param {{ send: (bytes: number[], timestampMs: number) => void,
   *           perfAt?: (audioTime: number) => number,
   *           clear?: () => void,
   *           onSkip?: (what: string) => void,
   *           levelOf?: (trackIndex: number) => ({ vol: number, master: number,
   *             scoreVol: number, scoreMaster: number } | null) }} io
   *        `clear` drops what was sent ahead and not yet played (MIDIOutput
   *        clear(), where the browser has it); `levelOf` a track's level as
   *        the panel holds it — its :vol and the master as shown (0–31) and
   *        the score's — or null while the score's own stands
   */
  constructor({ send, perfAt = (t) => t * 1000, clear = null, onSkip = null, levelOf = null }) {
    this.send = send;
    this.levelOf = levelOf;
    this.perfAt = perfAt;
    this.clear = clear;
    this.onSkip = onSkip;
    this.lastAt = -Infinity; // the latest time anything was sent for
    this.plans = new WeakMap(); // IR → its plan, made ahead of its play or swap
    this.plan = null; // for this.planIr
    this.planIr = null;
    this.irSeen = null; // the IR the player ran at the last pass
    this.running = false;
    this.run = 0; // the player's runNumber this run began at
    this.skipSaid = "";
    this.tracks = null; // per plan track: { sent, active: Map key → { bytes, at, off }, audible }
    this.runStart = null; // audio time the run began
    this.swapAt = null; // the pending hot-swap's time, as last seen
    this.chase = true; // the next plan starts from a point (not a swap)
    this.offAt = null; // the swap whose keys were let go
  }

  /**
   * The plan for the IR `ir` (midiPlan of the same score): kept for when the
   * player runs it — given ahead, for an IR about to play or swap in.
   */
  setPlan(plan, ir) {
    this.plans.set(ir, plan);
    if (ir !== this.planIr) return;
    // The IR playing planned again (a def-val moved): each track goes on from
    // where it was sent to, its keys still held.
    const carry = this.tracks ? new Map(this.plan.tracks.map((t, k) => [t.trackIndex, this.tracks[k]])) : null;
    this.plan = plan;
    this.tracks = carry ? plan.tracks.map((t) => carry.get(t.trackIndex) ?? { sent: carry.values().next().value?.sent ?? 0, active: new Map(), audible: true }) : null;
    this.sayskipped();
  }

  sayskipped() {
    const skipped = this.plan.tracks.filter((t) => t.port > 0).map((t) => t.name).join(", ");
    if (skipped && skipped !== this.skipSaid) this.onSkip?.(`past fifteen channels, not sent: ${skipped}`);
    this.skipSaid = skipped;
  }

  /**
   * One pass: what falls due before `now` + the player's lookahead goes out.
   * Call it a few times a frame's worth (Live: every 25 ms) while the output
   * is on; it notices the run start, stop, seek and swap by itself.
   * @param {IRPlayer} player
   * @param {number} now  the AudioContext's time
   */
  pass(player, now) {
    if (!player?.isPlaying?.()) {
      if (this.running) this.stop(now);
      return;
    }
    // A seek while playing begins the run again (IRPlayer runNumber): what
    // sounds is let go, and the run starts over from its point, chased.
    const run = player.runNumber?.() ?? 0;
    if (this.running && run !== this.run) this.stop(now);
    if (!this.running) {
      this.running = true;
      this.run = run;
      this.runStart = now;
      this.chase = true;
      this.tracks = null;
    }
    const ir = player.loadedIr();
    if (ir !== this.irSeen) {
      // A swap went in (or a new run's IR): the outgoing plan is done — its
      // keys let go at the bar already, if it was a swap that was seen.
      if (this.plan && this.tracks && !(this.swapAt != null && this.offAt === this.swapAt)) this.allOff(this.swapAt ?? now);
      this.offAt = null;
      this.irSeen = ir;
      this.plan = null;
      this.planIr = null;
      this.tracks = null;
      if (this.swapAt == null) this.chase = true;
    }
    if (!this.plan) {
      const plan = this.plans.get(ir);
      if (!plan) return; // its plan is coming
      this.plan = plan;
      this.planIr = ir;
      this.sayskipped();
    }
    // The preview's loop off: the song stops at its jump, and so does this.
    this.loops = player.loopEnabled?.() ?? true;
    const swap = player.pendingSwapTime();
    if (swap != null) this.swapAt = swap;
    const horizon = Math.min(now + Math.max(0.15, player.lookaheadSec()), swap ?? Infinity);

    if (!this.tracks) this.begin(player, now);
    const held = new Set(player.heldTracks?.() ?? []);
    for (const [k, t] of this.plan.tracks.entries()) {
      const st = this.tracks[k];
      if (t.port > 0) continue;
      // A track stopped at a `:len 0` note waits: its clock picks up from
      // there at the key-off (IRPlayer _resumeHeldTrack).
      if (held.has(t.trackIndex)) continue;
      // The panel's level: a melodic channel's CC7 goes out as it moves; a
      // drum's keys move by its difference from the score's. At 0, a mute.
      const lv = this.levelOf?.(t.trackIndex) ?? null;
      const db = lv ? faderDb(lv.vol) + faderDb(lv.master) : 0;
      const delta = lv && t.drums ? db - faderDb(lv.scoreVol) - faderDb(lv.scoreMaster) : 0;
      const cc7 = lv && !t.drums ? cc7Of(db) : null;
      if (cc7 != null && st.cc7 !== cc7) this.send([0xb0 | t.channel, 7, cc7], this.perfAt(now));
      // The score's back: its CC7 as the plan last had it, which may have
      // gone out as the panel's.
      else if (cc7 == null && st.cc7 != null && st.planCc7 != null) this.send([0xb0 | t.channel, 7, st.planCc7], this.perfAt(now));
      st.cc7 = cc7;
      const audible = player.isTrackAudible(t.trackIndex) && db > -Infinity;
      if (st.audible && !audible) this.letGo(st, now); // muted mid-note
      st.audible = audible;
      // A key is held until its off is due, not only sent: a stop may drop
      // an off sent ahead (clear), and the key needs one of its own then.
      for (const [k, a] of st.active) if (a.off <= now) st.active.delete(k);
      const c0 = player.trackTickAt(t.trackIndex, now), c1 = player.trackTickAt(t.trackIndex, horizon);
      if (!c0 || !c1 || !(c1.raw > c0.raw)) continue; // held, or no time ahead
      const spt = (horizon - now) / (c1.raw - c0.raw);
      const to = c1.raw;
      if (st.sent >= to) continue;
      this.window(t, st.sent, to, (e, raw) => {
        const at = Math.max(now, now + (raw - c0.raw) * spt);
        let bytes = e.bytes;
        if (isOn(bytes)) {
          if (!audible) return;
          if (delta) bytes = [bytes[0], bytes[1], Math.max(1, Math.min(127, Math.round(bytes[2] * 10 ** (delta / 40))))];
          st.active.set(keyOf(bytes), { bytes, at, off: Infinity });
        } else if (isOff(e.bytes)) {
          const a = st.active.get(keyOf(e.bytes));
          if (a) a.off = at;
        }
        // The plan's CC7 under the panel's level is the panel's.
        else if ((bytes[0] & 0xf0) === 0xb0 && bytes[1] === 7) {
          st.planCc7 = bytes[2];
          if (cc7 != null) bytes = [bytes[0], 7, cc7];
        }
        this.lastAt = Math.max(this.lastAt, at);
        this.send(bytes, this.perfAt(at));
      });
      st.sent = to;
    }
    // The outgoing plan's keys let go at the swap's bar, once.
    if (swap != null && horizon >= swap && this.offAt !== swap) { this.allOff(swap); this.offAt = swap; }
    if (swap == null) this.swapAt = null;
  }

  // A plan's first pass: each track from where it is now (or a little
  // before, for a plan that came late), its controllers chased there unless
  // the plan follows a swap, which leaves them as they stand.
  begin(player, now) {
    const from = Math.max(this.runStart ?? now, now - LATE_SEC);
    const at = this.swapAt != null && !this.chase ? Math.max(this.swapAt, now - LATE_SEC) : from;
    this.tracks = this.plan.tracks.map((t) => {
      const raw = player.trackTickAt(t.trackIndex, at)?.raw ?? 0;
      if (this.chase && t.port === 0) this.chaseTo(t, raw, now);
      return { sent: raw, active: new Map(), audible: true };
    });
    this.chase = false;
    this.swapAt = null;
  }

  // The plan's events in raw ticks [from, to) of a track's clock: round its
  // loop past the plan's end, nothing past the end of a song that stops.
  window(t, from, to, emit) {
    const { endTick, loopStart } = this.plan;
    const ev = t.events;
    let a = from;
    while (a < to) {
      const ta = this.tickOf(a);
      if (ta == null) break;
      const segEnd = Math.min(to, a + (endTick - ta));
      const tb = ta + (segEnd - a);
      let lo = 0, hi = ev.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].tick < ta) lo = m + 1; else hi = m; }
      // Round the loop again (past the plan's end), what stood before the
      // label at the loop point plays no more (export-midi.js `once`).
      const again = a >= endTick;
      const out = (e, raw) => { if (e.bytes[0] < 0xf0 && !(again && e.once)) emit(e, raw); };
      let i = lo;
      for (; i < ev.length && ev[i].tick < tb; i++) out(ev[i], a + (ev[i].tick - ta));
      // The plan's end reached: what stands at endTick itself — the offs of
      // the notes the loop's end or the song's end cuts — goes there.
      if (tb >= endTick) for (; i < ev.length && ev[i].tick <= endTick; i++) out(ev[i], a + (endTick - ta));
      if (segEnd <= a) break;
      a = segEnd;
      if ((loopStart == null || !this.loops) && a >= endTick) break;
    }
  }

  // A raw tick's place in the plan, or null past a song that does not loop.
  tickOf(raw) {
    const { endTick, loopStart } = this.plan;
    if (raw < endTick) return raw;
    if (loopStart == null || !this.loops) return null;
    return loopStart + ((raw - loopStart) % (endTick - loopStart));
  }

  // A track's controllers as they stand at raw tick `raw`, sent now: on a
  // pass after the first, as the plan's end left them, then the loop's own
  // writes from its start to the point (not what stood before its label).
  chaseTo(t, raw, now) {
    const { endTick, loopStart } = this.plan;
    const tick = this.tickOf(raw) ?? endTick;
    const round = raw >= endTick && loopStart != null && this.loops;
    const last = new Map();
    const take = (e) => { const k = chaseKey(e.bytes); if (k) last.set(k, e.bytes); };
    for (const e of t.events) {
      if (round ? e.tick > endTick : e.tick >= tick) break;
      take(e);
    }
    if (round) for (const e of t.events) {
      if (e.tick >= tick) break;
      if (e.tick >= loopStart && !e.once) take(e);
    }
    const ch = t.channel;
    const at = this.perfAt(now);
    if (t.bendRange) for (const [cc, v] of RPN_BEND(t.bendRange)) this.send([0xb0 | ch, cc, v], at);
    for (const k of ["k192", ...[...last.keys()].filter((k) => k.startsWith("cc")), "k224"])
      if (last.has(k)) this.send(last.get(k), at);
  }

  // A track's keys let go at `when` — a key sent ahead, after its own on:
  // what was sent ahead plays by its timestamp, so an off before it would
  // leave the key held. A key whose off was sent ahead too is let go again
  // (a second off is nothing): that off may have been dropped (clear).
  letGo(st, when) {
    for (const { bytes: b, at } of st.active.values())
      this.send([0x80 | (b[0] & 0x0f), b[1], 0], this.perfAt(Math.max(when, at + 0.001)));
    st.active.clear();
  }

  // Every key let go at `when`, and All Notes Off on each channel the plan
  // uses, after anything sent ahead (unless that was cleared).
  allOff(when, cleared = false) {
    if (!this.plan || !this.tracks) return;
    for (const st of this.tracks) this.letGo(st, when);
    const at = this.perfAt(cleared ? when : Math.max(when, this.lastAt + 0.001));
    for (const ch of new Set(this.plan.tracks.filter((t) => t.port === 0).map((t) => t.channel))) this.send([0xb0 | ch, 123, 0], at);
  }

  /**
   * A key of Live's keyboards on `channel`, now: `:target midi`'s sound is
   * the output's, so its keys go there, beside the song. Stopped, the
   * channel is first given its opening voice in `ir`'s plan; playing, it has
   * the song's. `vel` is the language's :vel (15 when not given).
   */
  // `level`: the channel's :vol and the master as the panel shows them,
  // which a key stopped plays at (its CC7, or a drum's velocity).
  keyOn(ir, channel, note, vel, now, level = null) {
    const at = this.perfAt(now);
    const db = level ? faderDb(level.vol) + faderDb(level.master) : 0;
    const drums = channel === 9;
    if (!this.running) {
      for (const b of channelOpening(this.plans.get(ir), channel)) this.send(b, at);
      if (level && !drums) this.send([0xb0 | channel, 7, cc7Of(db)], at);
    }
    const v = velocity7(vel ?? 15);
    this.send([0x90 | channel, note, drums && level && !this.running ? Math.max(1, Math.round(v * 10 ** (db / 40))) : v], at);
  }

  keyOff(channel, note, now) {
    this.send([0x80 | channel, note, 0], this.perfAt(now));
  }

  /** The run stopped (or the output was turned off): everything let go now. */
  stop(now) {
    // What was sent ahead dropped, where the output can; else let go after it.
    let cleared = false;
    if (this.clear) {
      try { this.clear(); cleared = true; } catch { /* not there after all */ }
    }
    if (cleared) for (const st of this.tracks ?? []) for (const a of st.active.values()) a.at = Math.min(a.at, now);
    this.allOff(now, cleared);
    this.lastAt = -Infinity;
    this.running = false;
    this.tracks = null;
    this.swapAt = null;
  }
}
