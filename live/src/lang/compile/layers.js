// A track after its body: delays expanded, priority layers flattened or
// shared onto one channel, counted loops written out, the checks a track
// and the song's words must pass.

import { expandLoops } from "../../ir/timing.js";
import { pushDiag } from "./diag.js";
import { isSongTarget } from "./keywords.js";
import { WHOLE_TICKS, PPQN } from "./length.js";
import { velMacroPeak, scaleMacroValues } from "./macros.js";

// Where a score's writes outrun what the driver keeps, or two channels race
// for one song-wide value, say so — the driver would act deterministically,
// but not as written (language.md §5.1, §8). Judged on the written timeline:
// a loop's passes are its first.
// A part that takes another's channels while its notes sound (the FM-PAC's
// rhythm, fm7-9: chips/ym2413.js `takes`; the Mega Drive's PCM, fm6's DAC:
// chips/dac-mix.js `claims`), `sharesTaken`: both play, and where a note of
// one sounds over a note of the other the later takes the channels — said
// once a score, at the first place (W_TARGET). Judged on the written
// timeline, a note its length: a loop's passes are its first.
export function warnSharedChannels(tracks, target, diagnostics) {
  for (const part of target.parts.filter((p) => p.sharesTaken)) {
    const taken = (c) => part.takes?.(c) || (!!part.claims && c?.part.kind === part.claims.kind && c.voice === part.claims.voice);
    // Each note at the tick it plays: a counted loop's passes written out
    // (an import's repeats fold into them).
    const played = (t) => {
      const copy = { events: t.events.slice() };
      convertCountedJumps(copy);
      return copy.events.some((e) => e.cmd === "LOOP_BEGIN") ? expandLoops(copy.events) : copy.events;
    };
    const spans = (keep) => tracks.filter((t) => keep(t.scoreChannel ?? t.channel)).flatMap((t) =>
      played(t).filter((e) => (e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON") && e.args?.length > 0)
        .map((e) => ({ head: t.scoreChannel ?? t.channel, from: e.tick, to: e.tick + e.args.length })));
    const hits = spans((h) => target.partOf(h) === part);
    if (!hits.length) continue;
    const fm = spans((h) => taken(target.channels[h]));
    const names = target.channelNames.filter((h) => taken(target.channels[h]));
    const shared = names.length > 1 ? `${names[0]}–${names[names.length - 1]}'s channels` : names[0];
    let first = null;
    for (const a of hits) for (const b of fm)
      if (a.from < b.to && b.from < a.to && (!first || Math.max(a.from, b.from) < first.at))
        first = { at: Math.max(a.from, b.from), hit: a.head, fm: b.head };
    if (first)
      pushDiag(diagnostics, "warning", "W_TARGET",
        `${first.fm} and ${first.hit} meet at bar ${Math.floor(first.at / WHOLE_TICKS) + 1} (tick ${first.at}): the ${part.label} plays on ${shared}, and the later note takes it`,
        null, "global");
  }
}

export function warnSongWrites(tracks, diagnostics, frameHz) {
  const tempos = tracks
    .flatMap((t) => t.events.filter((e) => e.cmd === "TEMPO_SET"))
    .map((e) => [e.tick, e.args?.bpm ?? 120])
    .sort((a, b) => a[0] - b[0]);
  const bpmAt = (tick) => tempos.reduce((bpm, [t, b]) => (t <= tick ? b : bpm), 120);
  const ticksOf = (ev) => {
    const n = Number(ev.args?.frames ?? 1);
    return ev.args?.lenFrames ? (n * bpmAt(ev.tick) * PPQN) / (60 * frameHz) : n;
  };
  // A channel runs two sweeps at once; a third evicts one (driver.md §4).
  for (const t of tracks) {
    const live = new Map(); // target → end tick
    for (const ev of t.events) {
      const target = ev.args?.target;
      if (!target || isSongTarget(target)) continue;
      if (ev.cmd === "PARAM_SET" || ev.cmd === "PARAM_SWEEP_STOP") live.delete(target);
      if (ev.cmd !== "PARAM_SWEEP") continue;
      for (const [k, end] of live) if (end <= ev.tick) live.delete(k);
      if (!live.has(target) && live.size >= 2) {
        pushDiag(diagnostics, "warning", "W_SWEEP_SLOTS",
          `a third sweep at once on ${t.scoreChannel} (${[...live.keys(), target].join(", ")}): the channel runs two, so one is cut off`,
          ev.src, t.scoreChannel);
        break;
      }
      live.set(target, ev.args?.loop ? Infinity : ev.tick + ticksOf(ev));
    }
  }
  // Two channels writing one song-wide value on one tick, differently: the
  // later track wins. The same write twice (each part of a song setting the
  // song's LFO) races nothing.
  const writers = new Map(); // "target@tick" → { channel, what }
  for (const t of tracks)
    for (const ev of t.events) {
      if (!ev.cmd.startsWith("PARAM_") || !isSongTarget(ev.args?.target)) continue;
      const key = `${ev.args.target}@${ev.tick}`;
      const what = `${ev.cmd} ${JSON.stringify(ev.args)}`;
      const other = writers.get(key);
      if (other != null && other.channel !== t.scoreChannel && other.what !== what)
        pushDiag(diagnostics, "warning", "W_SONG_WRITE_RACE",
          `${other.channel} and ${t.scoreChannel} write the same song-wide value on one tick; ${t.scoreChannel}'s, the later track, wins`,
          ev.src, t.scoreChannel);
      writers.set(key, { channel: t.scoreChannel, what });
    }
}

// [start, end) note intervals, indexed for the two questions the delay and
// :prio passes ask: is a note sounding at `t`, and when does the next one
// start after `t`. Sorted by start, with the latest end among each prefix — a
// note sounds at `t` iff one starting by `t` ends after it.
function intervalIndex(intervals) {
  const starts = [];
  const reach = [];
  for (const [st, en] of [...intervals].sort((a, b) => a[0] - b[0])) {
    starts.push(st);
    reach.push(Math.max(en, reach.at(-1) ?? -Infinity));
  }
  const startedBy = (t) => { // how many start at or before t
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    sounding: (t) => {
      const n = startedBy(t);
      return n > 0 && reach[n - 1] > t;
    },
    nextStart: (t) => starts[startedBy(t)] ?? Infinity,
  };
}

// Compile-time delay expansion (§12). Each note stamped with _delay
// emits echo copies at +k·spacing with the tap velocities. Written (source)
// notes outrank echoes (monophonic priority): a tap starting while a written
// note sounds (its gate) is dropped, and one starting in a gap is cut short at
// the next written note. Among taps the newer cuts the older; two on one tick
// keep the louder.
export function expandTrackDelays(track) {
  const events = track.events;
  const NOTE_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON"]);
  const sources = events.filter((e) => e._delay && NOTE_CMDS.has(e.cmd));
  if (sources.length === 0) {
    for (const e of events) delete e._delay;
    return;
  }
  const { sounding, nextStart: nextWritten } = intervalIndex(
    events.filter((e) => NOTE_CMDS.has(e.cmd)).map((e) => [e.tick, e.tick + prioNoteSpan(e)]),
  );

  const echoes = [];
  for (const ev of sources) {
    const { ticks, vels } = ev._delay;
    const span = prioNoteSpan(ev);
    for (let k = 0; k < vels.length; k++) {
      const tick = ev.tick + (k + 1) * ticks;
      if (sounding(tick)) continue;
      // Echoes inherit the source's articulation macros (keyon / semi / pitch /
      // op, each with its own :step). The vel macro is inherited but scaled so
      // this echo's tail peaks at its :delay-vels level; the dry note is left
      // untouched.
      const args = { ...ev.args };
      const dv = vels[k];
      if (args.velMacro) {
        const peak = velMacroPeak(args.velMacro);
        const ratio = peak > 0 ? dv / peak : 0;
        args.velMacro = scaleMacroValues(args.velMacro, ratio, "VEL");
      }
      if (dv === 15) delete args.vel;
      else args.vel = dv;
      echoes.push({
        tick, cmd: ev.cmd, args, src: ev.src, _voice: ev._voice,
        _end: Math.min(tick + span, nextWritten(tick)),
      });
    }
  }
  for (const e of events) delete e._delay;
  // Same tick: the louder tap stays. Then each tap ends where the next begins.
  echoes.sort((a, b) => a.tick - b.tick || (b.args.vel ?? 15) - (a.args.vel ?? 15));
  const taps = echoes.filter((e, i) => i === 0 || e.tick !== echoes[i - 1].tick);
  taps.forEach((e, i) => {
    const end = Math.min(e._end, taps[i + 1]?.tick ?? Infinity);
    if (end - e.tick < prioNoteSpan(e)) e.args.gate = end - e.tick;
    delete e._end;
  });
  if (taps.length) {
    events.push(...taps);
    events.sort((a, b) => a.tick - b.tick);
  }
}

// :prio layering (§1). Multiple forms of the same channel with different :prio
// values become independent parallel timelines; this post-pass flattens them
// into one monophonic event stream. Lower number = higher priority. Note events
// are resolved preemptively: a note is dropped where a higher-priority note is
// already sounding, and truncated (simple cut to silence) where a higher-priority
// note begins mid-sustain. A channel parameter belongs to the highest layer
// that sets it; other non-note events pass through in tick order. Counted
// loops are written out first, and an endless loop must agree across layers.
const PRIO_NOTE_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON"]);

// Sounding span of a note: gate (if set) else length; 0 means hold
// indefinitely (§ gate/len 0), modelled here as occupying the channel forever.
function prioNoteSpan(ev) {
  const g = ev.args.gate;
  if (g === 0) return Infinity;
  if (g != null) return g;
  const l = ev.args.length;
  return l === 0 ? Infinity : (l ?? 0);
}

// A channel is one voice, so its layers compete for it.
export function flattenPriorityLayers(head, layers, diagnostics) {
  // Highest priority first (lowest number). The first layer is the container we
  // reuse for channel/scoreChannel; only its event list is rebuilt.
  layers.sort((a, b) => a.prio - b.prio);
  const drop = new Set();
  const loop = alignLayerLoops(`channel ${head}`, head, layers, drop, diagnostics);

  // The voice, :pan, :vol and the other channel parameters are the channel's
  // registers, one of each: a parameter a higher-priority layer sets is that
  // layer's, and a lower layer's writes to it are dropped. One no higher layer
  // touches is the lower layer's to set, for every layer's notes.
  const owned = new Set();
  for (const { trackData } of layers) {
    const mine = new Set();
    for (const e of trackData.events) {
      const target = e.cmd.startsWith("PARAM_") ? e.args?.target : null;
      if (target == null) continue;
      if (owned.has(target)) drop.add(e);
      else mine.add(target);
    }
    for (const t of mine) owned.add(t);
  }
  resolveLayerNotes(layers, drop);

  // A layer's rests say nothing once the layers share one voice — a lower
  // layer's note may sound through a higher layer's rest and the other way
  // round — so the merged stream keeps none: its gaps are rests already (the
  // MMB exporter writes one wherever time passes without a note).
  const base = layers[0].trackData;
  base.events = layers
    .flatMap((l) => l.trackData.events)
    .filter((ev) => !drop.has(ev) && ev.cmd !== "REST")
    .sort((a, b) => a.tick - b.tick || (a === loop?.jump) - (b === loop?.jump));
  return base;
}

// One channel played under several names, each a part of its own
// (chips/parts.js `sharePrio`: the PC Engine's wave, noise and DDA on one
// channel): the tracks stay their own, and where their notes meet the
// :prio layering decides across them — a lower :prio first, at an equal one
// the part's sharePrio (pcm before noise before wave). A note starting under
// a higher one is dropped, one sounding when a higher one starts is cut.
export function shareChannelLayers(heads, layers, diagnostics) {
  layers.sort((a, b) => a.prio - b.prio || a.rank - b.rank);
  const drop = new Set();
  // Each track keeps its own loop: they stay apart, and every one must jump.
  alignLayerLoops(heads.join(" and "), heads[0], layers, drop, diagnostics, true);
  resolveLayerNotes(layers, drop);
  for (const { trackData } of layers) trackData.events = trackData.events.filter((ev) => !drop.has(ev));
}

// The layers' loops, made one (flattenPriorityLayers, shareChannelLayers): a
// counted loop is written out, and an endless one must loop over the same
// ticks on every layer that has one; the highest layer's MARKER and JUMP are
// kept (returned), the others' (unless `eachOwn`: tracks that stay apart
// keep theirs) and what any layer has past the end go into `drop`.
function alignLayerLoops(what, head, layers, drop, diagnostics, eachOwn = false) {
  // A counted loop compiles once, so after one a layer runs on pass-1 ticks
  // while its neighbours run on real ones: each layer's counted loops are
  // written out first (a `(go label N)` becoming the loop pair it stands for).
  for (const { trackData } of layers) {
    convertCountedJumps(trackData);
    if (trackData.events.some((e) => e.cmd === "LOOP_BEGIN")) {
      trackData.events = expandLoops(trackData.events).map((e) => (e.args ? { ...e, args: { ...e.args } } : e));
    }
  }

  // An endless loop (the song's `#loop … (go loop)`, an (x …) without a count)
  // is the channel's, one: layers that loop must loop over the same ticks, and
  // the merged stream keeps the highest one's MARKER and JUMP. What any layer
  // has past the jump never plays.
  const loopOf = (evs) => {
    const jumps = evs.filter((e) => e.cmd === "JUMP");
    if (!jumps.length) return undefined;
    const marker = jumps.length === 1 && evs.find((e) => e.cmd === "MARKER" && e.args?.id === jumps[0].args?.to);
    return marker ? { from: marker.tick, to: jumps[0].tick, jump: jumps[0], marker } : null;
  };
  const looping = layers.map((l) => loopOf(l.trackData.events)).filter((x) => x !== undefined);
  let loop = null;
  if (looping.some((x) => x === null || x.from !== looping[0].from || x.to !== looping[0].to)) {
    pushDiag(
      diagnostics,
      "error",
      "E_PRIO_LAYER_LOOP",
      `the :prio layers on ${what} loop over different ticks; a channel has one loop — start and end it at the same tick on every layer that loops`,
      { line: 1, column: 1 },
      head,
    );
    for (const x of looping.slice(1)) if (x) drop.add(x.jump).add(x.marker); // one E_ is enough
  } else if (looping.length) {
    loop = looping[0];
    if (!eachOwn) for (const x of looping.slice(1)) drop.add(x.jump).add(x.marker);
    const jumps = new Set(looping.map((x) => x.jump));
    let lost = false;
    for (const { trackData } of layers) {
      for (const e of trackData.events) {
        if (jumps.has(e) || drop.has(e)) continue;
        const note = PRIO_NOTE_CMDS.has(e.cmd);
        if (e.tick > loop.to || (note && e.tick === loop.to)) { drop.add(e); lost ||= note; }
      }
    }
    if (lost) {
      pushDiag(
        diagnostics,
        "warning",
        "W_PRIO_LAYER_PAST_LOOP",
        `a :prio layer on ${what} has notes past the channel's loop end; they never play`,
        { line: 1, column: 1 },
        head,
      );
    }
  }
  return loop;
}

// The layers' notes, highest first, against the ones above them: a note
// starting while a higher one sounds goes into `drop`; one a higher one
// starts under before its end is cut there (its gate).
function resolveLayerNotes(layers, drop) {
  let occupied = []; // committed sounding intervals from higher-priority layers
  for (const { trackData } of layers) {
    const notes = trackData.events
      .filter((e) => PRIO_NOTE_CMDS.has(e.cmd) && !drop.has(e))
      .sort((a, b) => a.tick - b.tick);

    const committed = []; // this layer's sounding intervals
    const higher = intervalIndex(occupied);
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      const t = ev.tick;
      // Suppressed: starts while a higher-priority note is sounding.
      if (higher.sounding(t)) {
        drop.add(ev);
        continue;
      }
      const rawEnd = t + prioNoteSpan(ev); // gate/len end (may be Infinity)
      const nextSame = notes[i + 1]?.tick ?? Infinity; // own retrigger ends it
      const nextHi = higher.nextStart(t); // next higher-priority onset
      // A higher-priority note interrupts before this note's natural end → cut
      // to silence (no release tail in this version).
      if (nextHi < rawEnd && nextHi < nextSame) ev.args.gate = nextHi - t;
      committed.push([t, Math.min(rawEnd, nextSame, nextHi)]);
    }
    occupied = [...occupied, ...committed];
  }
}

// Turn a counted backward jump — `(go label N)` -> JUMP { to, repeat } — plus
// its `#label` MARKER into the same LOOP_BEGIN/LOOP_END pair that `(x N …)`
// emits, so the loader's `_expandLoops` (nesting, count, (break)) handles both.
// Runs on a track's merged events, so the label and the `go` may come from
// different `(fmN …)` forms (mucom multi-line loops). Count-less JUMPs (infinite
// `(go label)` / `#loop`) are left untouched for the track-level loop.
export function convertCountedJumps(track) {
  const events = track.events;
  if (!events) return;
  // Left-to-right so an inner counted loop is converted before its outer one;
  // that claims inner (break) (LOOP_BREAK id:null) for the inner loop first.
  for (let j = 0; j < events.length; j++) {
    const ev = events[j];
    if (ev.cmd !== "JUMP" || ev.args?.repeat == null) continue;
    const id = ev.args.to;
    let m = -1;
    for (let k = j - 1; k >= 0; k--) {
      if (events[k].cmd === "MARKER" && events[k].args?.id === id) { m = k; break; }
    }
    if (m < 0) continue; // no backward marker — leave for validateTrack to flag
    events[m] = { ...events[m], cmd: "LOOP_BEGIN", args: { id } };
    events[j] = { ...ev, cmd: "LOOP_END", args: { id, repeat: ev.args.repeat } };
    for (let k = m + 1; k < j; k++) {
      if (events[k].cmd === "LOOP_BREAK" && events[k].args?.id == null) {
        events[k] = { ...events[k], args: { ...events[k].args, id } };
      }
    }
  }
}

export function validateTrack(track, diagnostics) {
  const markers = new Map();
  const pendingJumps = [];

  for (const e of track.events) {
    if (e.cmd === "MARKER") {
      const id = e.args?.id;
      if (markers.has(id)) {
        pushDiag(
          diagnostics,
          "error",
          "E_MARKER_DUP",
          `Duplicate marker id: ${id}`,
          e.src,
          track.scoreChannel,
        );
      } else {
        markers.set(id, true);
      }
    }
    if (e.cmd === "JUMP") {
      pendingJumps.push(e);
    }
  }

  for (const j of pendingJumps) {
    if (!markers.has(j.args.to)) {
      pushDiag(
        diagnostics,
        "error",
        "E_JUMP_UNRESOLVED",
        `Jump target marker not found: ${j.args.to}`,
        j.src,
        track.scoreChannel,
      );
    } else if (j.args.repeat != null) {
      // A counted `(go label N)` whose marker is forward: convertCountedJumps
      // only rewrites *backward* counted jumps into LOOP_BEGIN/LOOP_END, and a
      // forward one has no meaning. Drop it, so every JUMP in the IR is plain.
      track.events.splice(track.events.indexOf(j), 1);
      pushDiag(
        diagnostics,
        "error",
        "E_GO_FORWARD_COUNT",
        `forward counted jump unsupported: (go ${j.args.to} ${j.args.repeat}) — the marker must precede the go`,
        j.src,
        track.scoreChannel,
      );
    }
  }
}
