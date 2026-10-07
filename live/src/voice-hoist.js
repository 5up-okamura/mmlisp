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
//   rest  …  a REST before the note is split, and the voice lands
//            `restFrames` before the note (or at the rest's start, if shorter)
//   note  …  a note that ran to the next one is cut `noteFrames` short (its
//            gate shortened, a REST put after it) and the voice lands there
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
  let b = e - 1, depth = 0;
  for (; b >= 0; b--) {
    if (out[b].cmd === "LOOP_END") depth++;
    else if (out[b].cmd === "LOOP_BEGIN") { if (depth === 0) break; depth--; }
  }
  if (b < 0 || out[b].args?.id !== id) return null;
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
 * moved and how many could not (no silence before the note, or a structure in
 * the way).
 *
 * The previous note is keyed off by a REST (a pending key-off, driver.md
 * §6.3) or by its gate, so the voice always lands at least one tick after a
 * REST begins — never in the same tick as a key-off it would precede.
 */
export function hoistVoiceChanges(tracks, { ppqn = 96, restFrames = 4, noteFrames = 2, cutTail = false } = {}) {
  const tpf = maxTicksPerFrame(tracks, ppqn);
  const restTicks = Math.ceil(restFrames * tpf), noteTicks = Math.ceil(noteFrames * tpf);
  const stats = { moved: 0, stayed: 0 };
  const rest = (tick, length, src) => ({ tick, cmd: "REST", args: { length }, src });
  for (const track of tracks) {
    if (!FM_CHANNELS.has(track.channel) || track.se) continue;
    let out = track.events ?? [];
    if (out.some((e) => UNSAFE_TRACK_CMDS.has(e.cmd))) continue;
    // From the end, so a splice never shifts an index still to visit.
    for (let n = out.length - 1; n >= 0; n--) {
      const note = out[n];
      if (note.cmd !== "NOTE_ON" || note.args?.legato) continue;
      // The gap: the writes between the previous timeline event and this note.
      let g = n - 1;
      while (g >= 0 && GAP_CMDS.has(out[g].cmd)) g--;
      if (!out.slice(g + 1, n).some((e) => e.cmd === "PARAM_SET" && VOICE_TARGETS.has(e.args?.target))) continue;
      // A loop whose body ends in a rest: its final pass leaves that rest out
      // (a break before it) and the rest is written after the loop, where the
      // voice can go into it. (x N A R) plays as (x N A (break) R) R.
      if (g >= 0 && out[g].cmd === "LOOP_END") {
        const peeled = peelLoopRest(out, g);
        if (peeled) { out = peeled.events; n += peeled.added; g += peeled.added; }
      }
      const gap = out.slice(g + 1, n);
      const voice = gap.filter((e) => e.cmd === "PARAM_SET" && MOVE_TARGETS.has(e.args?.target));
      const T = out[n].tick, prev = g >= 0 ? out[g] : null;
      // Another kind of write on a voice target in the gap fixes the order;
      // a timeline event that does not end at this note is a structure edge.
      // A track's first voice is primed at load (driver.md §4.1): nothing to do.
      if (!out.slice(0, g + 1).some((e) => TIMELINE_CMDS.has(e.cmd))) continue;
      if (gap.some((e) => e.cmd !== "PARAM_SET" && MOVE_TARGETS.has(e.args?.target))
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
        head.push(rest(K, 1, note.src));
        after = rest(at, T - at, note.src);
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
      const moved = voice.map((e) => ({ ...e, tick: at }));
      const keep = gap.filter((e) => !voice.includes(e));
      out = [...out.slice(0, g), ...head, ...cut, ...moved, after, ...keep, ...out.slice(n)];
      stats.moved++;
    }
    track.events = out;
  }
  return stats;
}
