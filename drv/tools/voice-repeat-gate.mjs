// REPEATED VOICE_SET ELISION (export-mmb.js planVoiceRepeats, driver.md §10.2)
// drops a VOICE_SET where the channel already holds that voice. Over every
// score in tests/ and the SGDK example, encoded with and without it:
//
//   STREAM  a planned drop changes the encoded stream
//   TRACE   drv-player writes the same registers, in the same frames, from
//           both streams (with a score's own host schedule, if it has one)
//   HOIST   the same, for the loop-head VOICE_SET hoist (driver.md §10.1),
//           which shares the elision's motion test
//   CASES   tests/m4-voice-repeat.mmlisp drops on each track exactly what its
//           comments say, and tests/m4-loop-hoist-tail.mmlisp hoists fm2's
//           and fm4's loop heads but not fm1's, under its macro tail
//
// That the shorter stream plays the same on the C sequencer is c-gate's, which
// carries the fixture.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { planVoiceRepeats, planVoiceHoists } from "../../live/src/export-mmb.js";
import { planVoices } from "../../live/src/mmb-voices.js";

const MAX_FRAMES = 3600;
const files = [...readdirSync("tests").filter((f) => f.endsWith(".mmlisp")).sort().map((f) => join("tests", f)),
  "sgdk/example/demo.mmlisp"];

function trace(bytes, sampleBank, commands, autoStart) {
  const p = new DrvPlayer();
  p.loadMMB(bytes, sampleBank);
  return p.captureRegisterLog({ maxFrames: MAX_FRAMES, commands, autoStart }).writes
    .map((w) => `${w.frame}:${w.port}:${w.addr}:${w.data}`).join(" ");
}

let scores = 0, dropped = 0, hoisted = 0, failed = 0;
for (const f of files) {
  let on, off, noHoist;
  try {
    on = buildMmb(f, {});
    off = buildMmb(f, { voiceRepeat: false });
    noHoist = buildMmb(f, { loopHoist: false });
  } catch { continue; }
  const cmds = f.replace(/\.mmlisp$/, ".cmds.json");
  const sidecar = existsSync(cmds) ? JSON.parse(readFileSync(cmds, "utf8")) : {};
  const tr = (b) => trace(b.bytes, b.sampleBank, sidecar.commands ?? [], sidecar.autoStart !== false);
  // HOIST: a moved VOICE_SET keeps the stream's length, so the bytes tell.
  if (Buffer.compare(Buffer.from(on.bytes), Buffer.from(noHoist.bytes)) !== 0) {
    hoisted++;
    if (tr(on) !== tr(noHoist)) { failed++; console.log(`FAIL HOIST ${f}: the register log differs with the loop-head hoist`); }
  }
  const n = [...planVoiceRepeats(on.ir, planVoices(on.ir).plans).values()].reduce((a, d) => a + d.size, 0);
  if (n === 0) continue;
  scores++; dropped += n;
  // The plan has to reach the stream, or TRACE would pass on two equal streams.
  if (Buffer.compare(Buffer.from(on.bytes), Buffer.from(off.bytes)) === 0) {
    failed++; console.log(`FAIL STREAM ${f}: ${n} VOICE_SETs planned away, the stream is unchanged`); continue;
  }
  if (tr(on) !== tr(off)) {
    failed++; console.log(`FAIL TRACE ${f}: ${n} VOICE_SETs dropped, the register log differs`);
  }
}

// CASES: the VOICE_SETs each track drops.
const fx = buildMmb("tests/m4-voice-repeat.mmlisp", {});
const plan = planVoiceRepeats(fx.ir, planVoices(fx.ir).plans);
const drops = Object.fromEntries(fx.ir.tracks.map((t, i) => [(t.se ? "se:" : "") + (t.scoreChannel ?? t.channel), plan.get(i)?.size ?? 0]));
assert.deepEqual(drops, { fm1: 7, fm2: 1, fm4: 1, fm5: 1, fm6: 2, fm3: 0, sqr1: 0, "se:fm1": 1 },
  "m4-voice-repeat: each track drops what its comment says");
const hs = buildMmb("tests/m4-loop-hoist-tail.mmlisp", {});
const hoists = planVoiceHoists(hs.ir, planVoices(hs.ir).plans);
assert.deepEqual([...hoists.keys()].map((i) => hs.ir.tracks[i].scoreChannel), ["fm2", "fm4"],
  "m4-loop-hoist-tail: fm2's and fm4's loop heads hoist, fm1's stays under its macro tail");
assert.equal(failed, 0, `${failed} voice-repeat failures`);
console.log(`ok voice repeat: ${dropped} VOICE_SETs dropped in ${scores} scores and ${hoisted} scores' loop heads hoisted, the register trace unchanged; m4-voice-repeat's cases`);
