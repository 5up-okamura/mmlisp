// The IR's time: frame rates, the key-off lead and order epsilon, a held
// note's frame count, a track's loops expanded, a macro's frames, the ticks
// an event plays.

import { sampleCurveUnit } from "./curves.js";

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

// The video standard's frame rate, which is the driver's whole clock: a track
// advances by a per-frame tick increment and every macro, sweep and delay is
// counted in frames (driver.md §3). A score is COMPILED for one of these and
// the MMB says which (mmb.md §4, PAL_TIMEBASE) — the driver itself only counts
// frames, so the rate lives in the numbers the exporter bakes, never at
// runtime. Authoring is NTSC; PAL is an export target.
export const FRAME_HZ_NTSC = 60;
export const FRAME_HZ_PAL = 50;

// Lead time in seconds before gate boundary for FM key-off writes.
// Gives the FM envelope time to start decaying before the note technically ends.
export const KEY_OFF_LEAD_SECS = 0.005;

// Ordering margin for a key-off that lands on the note-on it must precede: a
// microsecond, far below the frame the driver works in and far below anything
// audible, but far above the float noise in tick→time arithmetic. It only
// keeps the two $28 writes in order for a time-sorted consumer — the
// separation the chip needs to re-attack (it latches key state once per
// 18.77 µs slot round) comes from the write path itself, which spends 48
// internal cycles per register write.
export const KEY_ORDER_EPS_SECS = 1e-6;


// Sentinel frame count used for hold notes (gateTicks === 0).
// Macros continue until triggerKeyOff() is called at runtime.
export const HOLD_FRAMES = 0x7fffffff;

// A track's counted loops (LOOP_BEGIN … LOOP_END, with (break)) written out:
// one pass after another, each event re-ticked, and what follows a loop
// shifted by its full expanded duration. The player plays a track this way;
// the compiler expands :prio layers with it before merging them.
export function expandLoops(events) {
  // One-pass finite expansion with correct tick re-basing.
  // Events that follow a loop block are shifted forward by the full loop
  // duration (count * bodyDuration) so they play after all repetitions,
  // not interleaved with early repetitions.

  function findFinalPassBreak(loopBody, loopId) {
    let depth = 0;
    for (let i = 0; i < loopBody.length; i++) {
      const ev = loopBody[i];
      if (ev.cmd === "LOOP_BEGIN") {
        depth++;
        continue;
      }
      if (ev.cmd === "LOOP_END") {
        if (depth > 0) depth--;
        continue;
      }
      if (depth === 0 && ev.cmd === "LOOP_BREAK" && ev.args?.id === loopId) {
        return { index: i, tick: ev.tick };
      }
    }
    return null;
  }

  // Returns { events, extra } where `extra` is how much longer the expanded
  // list is than the compressed input (the accumulated loop-expansion shift).
  // `extra` is what lets an OUTER loop offset its repetitions by the inner
  // body's *expanded* duration — without it, nested loops overlap.
  function expand(evList, depth) {
    if (depth > 8) return { events: [], extra: 0 }; // safety guard
    const out = [];
    let j = 0;
    let tickOffset = 0; // accumulated tick shift from all loops processed so far

    while (j < evList.length) {
      const ev = evList[j];
      if (ev.cmd === "LOOP_BEGIN") {
        // Find matching LOOP_END (ignoring nested pairs)
        let k = j + 1;
        let depth2 = 0;
        while (k < evList.length) {
          if (evList[k].cmd === "LOOP_BEGIN") depth2++;
          if (evList[k].cmd === "LOOP_END") {
            if (depth2 === 0) break;
            depth2--;
          }
          k++;
        }
        const loopBody = evList.slice(j + 1, k);
        const count = evList[k]?.args?.repeat;
        const loopId = ev.args?.id;

        // Derive body duration from LOOP_BEGIN / LOOP_END ticks for accuracy.
        // Falls back to first/last body event ticks if LOOP_END tick is missing.
        const loopBeginTick = ev.tick;
        const loopEndTick =
          evList[k]?.tick ??
          (loopBody.length > 0
            ? loopBody[loopBody.length - 1].tick
            : loopBeginTick);
        const bodyDuration = loopEndTick - loopBeginTick;
        const finalBreak = findFinalPassBreak(loopBody, loopId);
        const finalBodyDuration =
          finalBreak != null
            ? Math.max(0, finalBreak.tick - loopBeginTick)
            : bodyDuration;

        // Expand once; the EXPANDED body may be longer than bodyDuration when
        // it contains its own loops, so reps must advance by repDur, not by the
        // compressed bodyDuration (otherwise repetitions overlap → desync).
        const full = expand(loopBody, depth + 1);
        const repDur = bodyDuration + full.extra;
        const final =
          finalBreak != null
            ? expand(loopBody.slice(0, finalBreak.index), depth + 1)
            : full;
        const finalRepDur = finalBodyDuration + final.extra;

        for (let rep = 0; rep < count; rep++) {
          const body = rep === count - 1 ? final.events : full.events;
          for (const bodyEv of body) {
            out.push({
              ...bodyEv,
              tick: bodyEv.tick + tickOffset + rep * repDur,
            });
          }
        }

        // Shift following events by the loop's full expanded duration.
        const totalLoopDuration =
          count > 0 ? (count - 1) * repDur + finalRepDur : 0;
        tickOffset += totalLoopDuration - bodyDuration;
        j = k + 1; // skip past LOOP_END
      } else if (ev.cmd === "LOOP_BREAK") {
        // LOOP_BREAK is structural; it is consumed during expansion.
        j++;
      } else {
        // Apply accumulated offset so post-loop events play after all reps
        out.push({ ...ev, tick: ev.tick + tickOffset });
        j++;
      }
    }
    return { events: out, extra: tickOffset };
  }

  return expand(events, 0).events;
}

/**
 * A note's macro (`NOTE_ON`'s velMacro, wave) as the frames a key plays, for a
 * note whose length nobody knows yet: `held`, a value a frame while the key is
 * down (null: no change), going round from `loop` when it runs out (null: it
 * stays at its last), and `released` from the key's letting go. The player
 * schedules a note's macros ahead, to its gate; a key has none.
 */
export function macroFrames(spec) {
  if (spec.type === "steps") {
    const end = spec.releaseIndex ?? spec.steps.length;
    return { held: spec.steps.slice(0, end), loop: spec.loopIndex ?? null, released: spec.steps.slice(end) };
  }
  const held = [], released = [];
  let loop = null, out = held;
  for (const stage of spec.stages) {
    if (stage.waitKeyOff) { out = released; continue; }
    if (stage.loop) loop = out.length;
    const last = Math.max(1, stage.frames - 1);
    for (let i = 0; i < stage.frames; i++)
      out.push(stage.from + (stage.to - stage.from) * sampleCurveUnit(stage.curve, i / last));
  }
  return { held, loop, released };
}

// Ticks a track takes to play once through, counted loops unrolled: the IR
// holds one pass of an `(x N …)` body, so its last tick undercounts. A body
// with a `(break)` stops there on its final pass. (The MCP's mmlisp_check
// summary, Tools > Lessons' sameLength.)
export function playedTicks(ev) {
  const lastTick = ev.reduce((m, e) => Math.max(m, (e.tick ?? 0) + (e.args?.length ?? 0)), 0);
  const root = { begin: 0, end: lastTick, children: [] };
  const stack = [root];
  for (const e of ev) {
    const top = stack[stack.length - 1];
    if (e.cmd === "LOOP_BEGIN") {
      const node = { id: e.args?.id, begin: e.tick, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (e.cmd === "LOOP_END" && top.id === e.args?.id && stack.length > 1) {
      Object.assign(top, { end: e.tick, repeat: e.args?.repeat ?? 1 });
      stack.pop();
    } else if (e.cmd === "LOOP_BREAK") {
      const loop = stack.findLast((n) => n.id === e.args?.id);
      if (loop) loop.brk = e.tick;
    }
  }
  const body = (n, to) =>
    to - n.begin + n.children
      .filter((c) => c.end != null && c.end <= to)
      .reduce((sum, c) => sum + loop(c) - (c.end - c.begin), 0);
  const loop = (n) => (n.repeat - 1) * body(n, n.end) + body(n, n.brk ?? n.end);
  return body(root, lastTick);
}
