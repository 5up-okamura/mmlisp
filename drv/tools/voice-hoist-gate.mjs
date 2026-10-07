// THE VOICE-HOIST PASS (live/src/voice-hoist.js) moves time, never notes.
// Over every score in tests/ and the SGDK example, compiled with and without
// it, through the preview's own loop expansion:
//
//   ONSETS  every note and PCM note starts at the same tick, on every track
//   SILENT  every voice write that moved lands after the channel's previous
//           note has keyed off (its gate, or the end of its tie chain)
//   CASES   tests/m4-voice-hoist.mmlisp moves each case it is written for
//
// The driver side — that the moved stream plays the same on the C sequencer
// as on drv-player — is c-gate's, which carries the fixture.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { hoistVoiceChanges, VOICE_TARGETS } from "../../live/src/voice-hoist.js";
import { IRPlayer } from "../../live/src/ir-player.js";

const expand = (events) => new IRPlayer(() => {})._expandLoops(events);
const onsets = (events) => expand(events).filter((e) => e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON")
  .map((e) => `${e.tick}:${e.args.pitch}`).join(" ");

// [start, keyOff] of each note: its gate, or its length and its ties.
function sounding(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.cmd !== "NOTE_ON") continue;
    let end = e.tick + e.args.length;
    for (let j = i + 1; events[j]?.cmd === "TIE" && events[j].tick === end; j++) end += events[j].args.length;
    out.push([e.tick, e.args.gate !== undefined && e.args.gate > 0 ? e.tick + e.args.gate : end]);
  }
  return out;
}

const files = [...readdirSync("tests").filter((f) => f.endsWith(".mmlisp")).map((f) => join("tests", f)),
  "sgdk/example/demo.mmlisp"];
let moved = 0, scores = 0, failed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  let a, b;
  try {
    a = compileMMLisp(src, f, { voiceHoist: false });
    b = compileMMLisp(src, f, {});
  } catch { continue; }
  if (a.diagnostics.some((d) => d.severity === "error")) continue;
  const st = hoistVoiceChanges(structuredClone(a.ir.tracks), { ppqn: 96 });
  if (st.moved) { scores++; moved += st.moved; }
  a.ir.tracks.forEach((ta, i) => {
    const tb = b.ir.tracks[i];
    if (onsets(ta.events) !== onsets(tb.events)) { failed++; console.log(`FAIL ONSETS ${f} ${ta.channel}`); return; }
    const before = new Set(expand(ta.events).filter((e) => e.cmd === "PARAM_SET").map((e) => `${e.tick}:${e.args.target}:${e.args.value}`));
    const after = expand(tb.events), notes = sounding(after);
    for (const e of after) {
      if (e.cmd !== "PARAM_SET" || !VOICE_TARGETS.has(e.args.target)) continue;
      if (before.has(`${e.tick}:${e.args.target}:${e.args.value}`)) continue; // did not move
      const last = notes.filter(([s]) => s < e.tick).at(-1);
      if (last && last[1] >= e.tick) { failed++; console.log(`FAIL SILENT ${f} ${tb.channel}: ${e.args.target} at ${e.tick}, the note keys off at ${last[1]}`); break; }
    }
  });
}
const fx = compileMMLisp(readFileSync("tests/m4-voice-hoist.mmlisp", "utf8"), "m4-voice-hoist.mmlisp", { voiceHoist: false });
const st = hoistVoiceChanges(fx.ir.tracks, { ppqn: 96 });
assert.deepEqual(st, { moved: 11, stayed: 0 }, "m4-voice-hoist: each case moves");
assert.equal(failed, 0, `${failed} voice-hoist failures`);
console.log(`ok voice hoist: ${moved} voice changes moved in ${scores} scores; onsets identical, every move into silence; m4-voice-hoist's cases`);
