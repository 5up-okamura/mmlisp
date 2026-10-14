// ---------------------------------------------------------------------------
// VOICE CHANGES MOVE AHEAD OF THEIR NOTE (an IR pass, run by the compiler).
//
// A voice def compiles to a burst of PARAM_SETs (~36 register writes a
// channel) at the tick of the note that uses it. On the driver those writes
// and the note's key-on share one frame, and the frame's other key-ons queue
// behind them on the pair wire: two channels changing voice on a downbeat
// delay that beat by several frames — the tempo wobble a listener hears.
//
// So the voice's writes are moved into the silence before the note, where the
// wire is idle and the channel is keyed off:
//
//   rest  …  a REST before the note is split, and the voice lands in the last
//            `restFrames` of it (or at the rest's start, if shorter); a voice
//            written at the rest's start (`stab _ c`) goes there too
//   note  …  a note that ran to the next one is cut `noteFrames` short (its
//            gate shortened, a REST put after it) and the voice lands there
//
// WHICH FRAME of that window: the earliest that is free — no other channel's
// voice already there, no FM key-on there on any channel — else the one with
// the fewest. Each voice is ~36 writes of 68000 render and of wire; several
// channels changing voice before the same beat used to land on the same
// frame (the window's first), and a voice written at a rest's start landed
// on whatever beat the rest began on. One voice alone keeps the window's
// first frame, as before. Frames are counted in ticks of the song's fastest
// PAL frame, so two voices a slot apart are on different frames on either
// standard (driver.md §3.3).
//
// A gap with a voice in it moves the voice and the channel's own settings
// with it (MOVE_TARGETS: :vel, :vol, :pan, :pitch); :lfo-rate and anything
// else the whole chip shares stays with the note.
// Nothing moves across a loop edge, a marker or a jump, into or out of a slur,
// on an FM3 operator or CSM track, or on an effect's part; a `PARAM_ADD`-like
// event on a voice target between the two keeps the order it was written in.
//
// `cutTail` writes RR 15 on every operator just before the moved voice: the
// previous note's release would otherwise finish on the NEW voice's ratios and
// release rates. The voice's own RR follows and restores them.
//
// The IR preview and the driver both play the moved stream, so what the
// editor plays is still what the driver plays (driver.md §14.3).
// ---------------------------------------------------------------------------
import { expandLoops } from "./ir-utils.js";

// A voice: what a `def-fm` compiles to. Its presence is what moves a gap.
export const VOICE_TARGETS = new Set([
  "FM_ALG", "FM_FB", "FM_AMS", "FM_FMS",
  ...[1, 2, 3, 4].flatMap((op) =>
    ["AR", "DR", "SR", "RR", "SL", "TL", "KS", "ML", "DT", "SSG", "AMEN"].map((k) => `FM_${k}${op}`)),
]);
// What moves with a voice: the channel's own settings written before the note
// (`:vel`, `:vol`, `:pan`, `:pitch`), which would otherwise rewrite the new
// voice's levels and pitch in the note's frame. A `:vel` alone moves nothing.
// LFO rate, master and tempo are the whole chip's and stay with the note.
export const MOVE_TARGETS = new Set([...VOICE_TARGETS, "VEL", "VOL", "PAN", "NOTE_PITCH", "NOTE_SEMI"]);

const FM_CHANNELS = new Set(["fm1", "fm2", "fm3", "fm4", "fm5", "fm6"]);
// Events that may sit between the previous note and this one without ending
// the search: writes that land at the note's tick.
const GAP_CMDS = new Set(["PARAM_SET", "PARAM_ADD", "PARAM_MUL", "PARAM_FROM_VAL", "PARAM_SWEEP", "PARAM_SWEEP_STOP"]);
const TIMELINE_CMDS = new Set(["NOTE_ON", "REST", "TIE"]);
// A track that drives the chip in a way a moved voice could disturb.
const UNSAFE_TRACK_CMDS = new Set(["FM3_MODE", "FM3_OP_PITCH", "CSM_ON", "CSM_OFF", "CSM_RATE"]);

/**
 * Ticks per frame at the song's fastest tempo, on the 50 Hz frame — so a
 * window of N frames is at least N frames at every tempo the song plays, on
 * either standard, and the moved stream is the same music on both (the PAL
 * and NTSC bakes differ in no tick, driver.md §3.3).
 */
function maxTicksPerFrame(tracks, ppqn, frameHz = 50) {
  let bpm = 0;
  for (const t of tracks)
    for (const ev of t.events ?? []) {
      if (ev.cmd === "TEMPO_SET") bpm = Math.max(bpm, Number(ev.args?.bpm) || 0);
      if (ev.cmd === "TEMPO_SWEEP") bpm = Math.max(bpm, Number(ev.args?.from) || 0, Number(ev.args?.to) || 0);
    }
  return ((bpm || 120) * ppqn) / 60 / frameHz;
}

/** The LOOP_BEGIN of the LOOP_END at out[e], or -1. */
function loopBegin(out, e) {
  let b = e - 1, depth = 0;
  for (; b >= 0; b--) {
    if (out[b].cmd === "LOOP_END") depth++;
    else if (out[b].cmd === "LOOP_BEGIN") { if (depth === 0) break; depth--; }
  }
  return b >= 0 && out[b].args?.id === out[e].args?.id ? b : -1;
}

/**
 * The silence that ends at out[g] (a REST, or a loop ending in one): back
 * across rests that join and loops of nothing but rests — `_2 (x 26 _1)` —
 * to the index of its first event. A voice written before it,
 * `stab _2 (x 26 _1) c`, sounds at the note after it.
 */
function silenceStart(out, g) {
  let s = g;
  for (;;) {
    if (out[s].cmd === "LOOP_END") {
      const b = restLoop(out, s);
      if (b < 0) return s;
      s = b;
    }
    const p = out[s - 1];
    if (!p) return s;
    if (p.cmd === "REST" && p.tick + p.args.length === out[s].tick) { s--; continue; }
    if (p.cmd === "LOOP_END" && p.tick === out[s].tick) { s--; continue; }
    return s;
  }
}
/** The LOOP_BEGIN of the LOOP_END at out[e] when its body is rests end to
 *  end from the loop's start to its end (and its own break), else -1. */
function restLoop(out, e) {
  const b = loopBegin(out, e);
  if (b < 0) return -1;
  let tick = out[b].tick;
  for (let i = b + 1; i < e; i++) {
    const x = out[i];
    if (x.cmd === "LOOP_BREAK" && x.args?.id === out[b].args?.id) continue;
    if (x.cmd !== "REST" || x.tick !== tick) return -1;
    tick += x.args.length;
  }
  return tick === out[e].tick ? b : -1;
}

/**
 * out[e] is a LOOP_END whose body's last event is a REST: put a LOOP_BREAK
 * before that rest and the rest again after the loop, and move every later
 * event one rest later in the track's flow ticks (the loop's final pass is now
 * that much shorter, so nothing moves in time). null when the loop already has
 * a break, plays once, or does not end in a rest.
 */
function peelLoopRest(out, e) {
  const end = out[e], id = end.args?.id;
  if (!(end.args?.repeat >= 2)) return null;
  const b = loopBegin(out, e);
  if (b < 0) return null;
  const r = out[e - 1];
  if (r.cmd !== "REST" || r.tick + r.args.length !== end.tick || e - 1 === b) return null;
  if (out.slice(b + 1, e).some((x) => x.cmd === "LOOP_BREAK" && x.args?.id === id)) return null;
  const L = r.args.length;
  const later = out.slice(e + 1).map((x) => ({ ...x, tick: x.tick + L }));
  const events = [...out.slice(0, e - 1), { tick: r.tick, cmd: "LOOP_BREAK", args: { id }, src: r.src }, r, end,
    { ...r, tick: end.tick }, ...later];
  return { events, added: 2 };
}

/**
 * Move each FM voice change ahead of its note, in place. Returns how many
 * moved, how many could not (no silence before the note, or a structure in
 * the way), and how many were spread to a later frame of their window.
 *
 * The previous note is keyed off by a REST (a pending key-off, driver.md
 * §6.3) or by its gate, so the voice always lands at least one tick after a
 * REST begins — never in the same tick as a key-off it would precede.
 */
export function hoistVoiceChanges(tracks, { ppqn = 96, restFrames = 4, noteFrames = 2, cutTail = false } = {}) {
  const tpf = maxTicksPerFrame(tracks, ppqn);
  const G = Math.ceil(tpf); // one frame in ticks, on either standard
  const restTicks = Math.ceil(restFrames * tpf), noteTicks = Math.ceil(noteFrames * tpf);
  const stats = { moved: 0, stayed: 0, spread: 0 };
  const rest = (tick, length, src) => ({ tick, cmd: "REST", args: { length }, src });
  // Every moved voice, for the spread: the events are tagged with its id
  // while the pass runs (a splice or a peel copies events, a tag survives).
  const placements = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (!FM_CHANNELS.has(track.channel) || track.se) continue;
    let out = track.events ?? [];
    if (out.some((e) => UNSAFE_TRACK_CMDS.has(e.cmd))) continue;
    const isVoice = (e) => e.cmd === "PARAM_SET" && VOICE_TARGETS.has(e.args?.target);
    const isMove = (e) => e.cmd === "PARAM_SET" && MOVE_TARGETS.has(e.args?.target);
    // The run of writes at a silence's start, out[runAt(s) .. s).
    const runAt = (s) => {
      let r = s - 1;
      while (r >= 0 && GAP_CMDS.has(out[r].cmd) && out[r].tick === out[s].tick) r--;
      return r + 1;
    };
    // From the end, so a splice never shifts an index still to visit.
    for (let n = out.length - 1; n >= 0; n--) {
      let z = out[n];
      // What ends a silence: a note — with the voice in the gap before it, or
      // written at the silence's start (`stab _ c`, `stab _2 (x 26 _1) c`) —
      // or any other event, a loop edge or a marker, with a voice at the
      // silence's start (`stab _2 (x 26 _1 e …)`): a voice written before a
      // rest sounds at the next note, wherever that is, so it goes to the end
      // of the rest. Rests, breaks and gap writes end nothing.
      if (z.cmd === "REST" || z.cmd === "LOOP_BREAK" || GAP_CMDS.has(z.cmd)) continue;
      if (z.cmd === "LOOP_END" && restLoop(out, n) >= 0) continue;
      const isNote = z.cmd === "NOTE_ON" && !z.args?.legato;
      let g = n - 1;
      if (isNote) while (g >= 0 && GAP_CMDS.has(out[g].cmd)) g--;
      const inGap = isNote && out.slice(g + 1, n).some(isVoice);
      if (!inGap) {
        if (g < 0 || (out[g].cmd !== "REST" && out[g].cmd !== "LOOP_END")) continue;
        const s = silenceStart(out, g);
        if (!out.slice(runAt(s), s).some(isVoice)) continue;
      }
      // A loop whose body ends in a rest: its final pass leaves that rest out
      // (a break before it) and the rest is written after the loop, where the
      // voice can go into it. (x N A R) plays as (x N A (break) R) R.
      if (g >= 0 && out[g].cmd === "LOOP_END") {
        const peeled = peelLoopRest(out, g);
        if (peeled) { out = peeled.events; n += peeled.added; g += peeled.added; z = out[n]; }
      }
      // [runStart, runEnd) is the run that moves (empty for the gap's voice);
      // what is not a voice in it (`:lfo-rate`) stays where it was.
      let runStart = g, runEnd = g, front = [];
      if (!inGap) {
        if (out[g].cmd !== "REST") { stats.stayed++; continue; } // a loop that could not be peeled
        runEnd = silenceStart(out, g);
        runStart = runAt(runEnd);
        front = out.slice(runStart, runEnd).filter((e) => !isMove(e));
      }
      const gap = isNote ? out.slice(g + 1, n) : [];
      const source = inGap ? gap : out.slice(runStart, runEnd);
      const voice = source.filter(isMove);
      const T = z.tick, prev = g >= 0 ? out[g] : null;
      // Another kind of write on a voice target in the gap fixes the order;
      // a timeline event that does not end at this note is a structure edge.
      // A track's first voice is primed at load (driver.md §4.1): nothing to do.
      if (!out.slice(0, inGap ? g + 1 : runStart).some((e) => TIMELINE_CMDS.has(e.cmd))) continue;
      if (source.some((e) => e.cmd !== "PARAM_SET" && MOVE_TARGETS.has(e.args?.target))
          || prev.tick + (prev.args?.length ?? -1) !== T) { stats.stayed++; continue; }
      let head = [], at, after;
      if (prev.cmd === "REST") {
        const L = prev.args.length;
        if (L < 2) { stats.stayed++; continue; }
        at = Math.max(prev.tick + 1, T - restTicks);
        head = [rest(prev.tick, at - prev.tick, prev.src)];
        after = rest(at, T - at, prev.src);
      } else if (prev.cmd === "NOTE_ON" || prev.cmd === "TIE") {
        let h = g;
        while (h >= 0 && out[h].cmd === "TIE") h--;
        const first = h >= 0 ? out[h] : null;
        if (first?.cmd !== "NOTE_ON") { stats.stayed++; continue; }
        const total = T - first.tick, gate = first.args.gate ?? total;
        if (gate === 0) { stats.stayed++; continue; } // a held note: keyed off by the host
        // Key off at K, the voice one tick later, the note again at T.
        const K = Math.min(first.tick + gate, T - noteTicks);
        if (K <= prev.tick || T - K < 2) { stats.stayed++; continue; }
        at = K + 1;
        const fix = (e, length, gateTo) => {
          const args = { ...e.args, length };
          if (gateTo !== undefined && gateTo < length) args.gate = gateTo; else if (gateTo !== undefined) delete args.gate;
          return { ...e, args };
        };
        if (h === g) head = [fix(first, K - first.tick, Math.min(gate, K - first.tick))];
        else {
          // A tied note keys off by an absolute gate or at the chain's end.
          if (first.args.gate !== undefined) out[h] = { ...first, args: { ...first.args, gate: Math.min(gate, K - first.tick) } };
          head = [fix(prev, K - prev.tick)];
        }
        head.push(rest(K, 1, z.src));
        after = rest(at, T - at, z.src);
      } else { stats.stayed++; continue; }
      // The tail cut goes a frame ahead of the voice: written in the same tick
      // the exporter folds it into the voice's own RR (one VOICE_SET).
      const lead = Math.ceil(tpf);
      let cut = [];
      if (cutTail && T - at > lead + 1) {
        cut = [...[1, 2, 3, 4].map((op) => ({ tick: at, cmd: "PARAM_SET", args: { target: `FM_RR${op}`, value: 15 }, src: voice[0].src })),
          rest(at, lead, after.src)];
        at += lead;
        after = rest(at, T - at, after.src);
      }
      const id = placements.length;
      const moved = voice.map((e) => ({ ...e, tick: at, _hoist: id }));
      for (const e of cut) e._hoist = id;
      head[head.length - 1]._hoistHead = id;
      after._hoistAfter = id;
      // How far the voice may still go: before the edge, or a frame before
      // the note so its frame is never the note's.
      placements.push({ id, track: ti, room: (isNote ? T - G : T - 1) - at });
      const keep = inGap ? gap.filter((e) => !voice.includes(e)) : gap;
      out = [...out.slice(0, runStart), ...front, ...out.slice(runEnd, g), ...head, ...cut, ...moved, after, ...keep, ...out.slice(n)];
      stats.moved++;
    }
    track.events = out;
  }
  spreadVoices(tracks, placements, G, stats);
  return stats;
}

/**
 * Each moved voice takes the first slot of its window (`k` frames after where
 * it is) that is a frame clear of every FM key-on and of every voice already
 * placed, else the slot with the fewest; placed in order of first sounding.
 * Looked at on the expanded timeline, so a voice inside a loop is checked at
 * each of its repeats, against every track's key-ons at theirs.
 */
function spreadVoices(tracks, placements, G, stats) {
  const keyOns = [], at = new Map();
  for (const t of tracks) {
    if (t.se) continue;
    const fm = typeof t.channel === "string" && t.channel.startsWith("fm");
    for (const e of expandLoops(t.events ?? [])) {
      if (fm && e.cmd === "NOTE_ON" && !e.args?.legato) keyOns.push(e.tick);
      if (e._hoist !== undefined && e.cmd === "PARAM_SET" && MOVE_TARGETS.has(e.args?.target)) {
        const ticks = at.get(e._hoist) ?? at.set(e._hoist, []).get(e._hoist);
        if (ticks.at(-1) !== e.tick) ticks.push(e.tick);
      }
    }
  }
  keyOns.sort((a, b) => a - b);
  const placed = [];
  // Within a frame of x: busy if any is in (x - G, x + G).
  const near = (sorted, x) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x - G) lo = m + 1; else hi = m; }
    return lo < sorted.length && sorted[lo] < x + G;
  };
  const busy = (x) => (near(keyOns, x) ? 1 : 0) + placed.filter((y) => Math.abs(y - x) < G).length;
  const order = placements.filter((p) => at.has(p.id))
    .sort((a, b) => at.get(a.id)[0] - at.get(b.id)[0] || a.track - b.track || a.id - b.id);
  for (const p of order) {
    const ticks = at.get(p.id);
    let best = 0, cost = Infinity;
    for (let k = 0; k * G <= p.room && cost > 0; k++) {
      const c = ticks.reduce((sum, x) => sum + busy(x + k * G), 0);
      if (c < cost) { best = k; cost = c; }
    }
    p.shift = best * G;
    if (best) stats.spread++;
    for (const x of ticks) placed.push(x + p.shift);
  }
  const shift = new Map(placements.map((p) => [p.id, p.shift ?? 0]));
  for (const t of tracks)
    for (const e of t.events ?? []) {
      if (e._hoist !== undefined) { e.tick += shift.get(e._hoist); delete e._hoist; }
      if (e._hoistHead !== undefined) { e.args.length += shift.get(e._hoistHead); delete e._hoistHead; }
      if (e._hoistAfter !== undefined) {
        const d = shift.get(e._hoistAfter);
        e.tick += d; e.args.length -= d;
        delete e._hoistAfter;
      }
    }
}
