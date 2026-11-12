// A word is one rule on every machine (live/src/player/ir-player-words.js _word),
// as check:note-path holds a note's path: on every machine's channels —
// its melodic ones, and its sample ones on a sample — each word the channel takes is written a value, swept with no
// :from, moved by `+` and `*`, and read off a `$slot` — and the writes the
// preview makes are held to the rule:
//   a sweep with no :from starts at the word's value now and ends on its :to,
//   a `+` / `*` reads the value now (after a sweep, where it left it — the
//   driver's arithmetic, opcodes.md PARAM_MUL: ×0.5 is 128/256, the
//   fraction dropped),
//   a `$slot` writes the slot's value.
// check:words holds the Mega Drive's against the driver; this holds the
// other machines' to the same rule, where there is no driver to hold them to.
//
//   cd tools && npm run check:word-rule
//   node scripts/check-word-rule.mjs --only noise-rate   # one word
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/lang/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { bakedChipSamples } from "../../drv/tools/wav.mjs";
import { IRPlayer } from "../../live/src/player/ir-player.js";
import { TARGETS, targetProfile } from "../../live/src/machine/targets.js";
import { newScoreSource } from "../../live/src/app/new-score.js";
import { CORE_OF_KIND } from "../../live/src/player/ir-player-shared.js";

// keyword → [a value (an integer: a slot $s holds it too), a sweep's :to, a
// `+`'s delta]: each inside every machine's range for it, so no write is
// clamped.
const WORDS = {
  vol: [20, 8, 3],
  master: [20, 8, 3],
  pitch: [50, -30, 10],
  pan: [-1, 1, -1], // (the OPN's pan is its left and right bits; a lane's steps in fifteenths)
  "noise-rate": [20, 5, 2],
  "env-rate": [40, 10, 5],
  duty: [4, 12, -2],
  "lfo-rate": [2, 6, 1],
  "lfo-freq": [10, 30, 5],
  "lfo-pmd": [10, 30, 5],
  "lfo-amd": [10, 30, 5],
  tl1: [20, 40, 3],
  fb: [2, 6, 1],
  m: [20, 5, 2], // a value slot, the score's own word (language.md §8)
};
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

// A sample channel's score sits beside drv/tests' wavs, which its :file reads;
// a rhythm channel plays its own sound (a kit role by name), any other blip.
const SAMPLE_SCORE = fileURLToPath(new URL("../../drv/tests/word-rule.mmlisp", import.meta.url));
const RHYTHM = new Set(["rhythm", "opll-rhythm", "midi-drums"]);

const mul = (v) => Math.floor((Math.round(v) * 128) / 256);
const near = (a, b) => Math.abs(a - b) < 1e-6;

// The channel `head` of machine `name` writing `kw` every way; its writes of
// the word in order, each { how, v } — `set` a written value, `sweep` a
// sweep's step — or null where the channel has no such word. `voice`: a
// sample channel's sound (null on a melodic one).
function writes(name, head, kw, voice = null) {
  const [a, t, d] = WORDS[kw];
  const src = `(def-score :target ${name})
(def-val m 0 -1000..1000)
(def-val s ${a} -1000..1000)
${voice ? '(def-pcm blip :file "blip.wav")\n' : ""}(${head}${voice ? ` ${voice}` : ""} :tempo 120 :len 4 :${kw} ${a} c :${kw} (linear :to ${t} :len 1/2) c c :${kw}+ ${d} c :${kw}* 0.5 c :${kw} $s c)`;
  const path = voice ? SAMPLE_SCORE : "word-rule.mmlisp";
  const { ir, diagnostics } = compileMMLisp(src, path, { imports: readImportSources(path, src) });
  if (diagnostics.some((x) => x.severity === "error" || x.code === "W_TARGET")) return null;
  const target = ir.tracks.flatMap((tr) => tr.events ?? []).find((e) => e.cmd === "PARAM_SET" && near(Number(e.args?.value), a))?.args?.target;
  if (!target) return null;
  const p = new IRPlayer(() => {});
  p.loadJSON(ir);
  if (voice) {
    // The samples as Live bakes them: the chip's own RAM, or frames.
    const { adpcm, frames } = bakedChipSamples(ir, targetProfile(name));
    p.setAdpcmBank(adpcm);
    p.setFrameBank(frames);
  }
  const log = [];
  const word = p._word.bind(p);
  p._word = (ev, when, w) => {
    if (w && ev.cmd !== "PARAM_SWEEP" && String(ev.args?.target ?? "").toUpperCase() === target) {
      const own = w.write;
      w = { ...w, write: (v, at) => { log.push({ how: "set", v }); return own(v, at); } };
    }
    return word(ev, when, w);
  };
  const run = p._runSweep.bind(p);
  p._runSweep = (slot, phase, sw, write) => run(slot, phase, sw, slot.endsWith(`:${target}`)
    ? (v, at) => { log.push({ how: "sweep", v }); return write(v, at); }
    : write);
  p.captureRegisterLog();
  // From the score's first value on (a part's init writes come before it).
  const from = log.findIndex((e) => e.how === "set" && near(e.v, a));
  return from < 0 ? null : log.slice(from);
}

let cases = 0;
const failures = [];
for (const name of Object.keys(TARGETS)) {
  if (name === "midi") continue; // its sound is the output's (check:midi-out)
  const channels = targetProfile(name).channels;
  // Its melodic channels (File > New's score's), and its sample ones (its
  // channel table's), each with its sound.
  const sounds = new Map([...newScoreSource(name).matchAll(/^\((rhythm\d) (\S+)$/gm)].map((m) => [m[1], m[2]]));
  const heads = [
    ...[...newScoreSource(name).matchAll(/^\(([a-z0-9-]+)\b/gm)].map((m) => m[1])
      .filter((h) => ["fm", "psg"].includes(CORE_OF_KIND[channels[h]?.part?.kind])).map((h) => [h, null]),
    ...Object.keys(channels).filter((h) => channels[h].part?.kind === "sample")
      .map((h) => [h, RHYTHM.has(channels[h].part.name) ? (sounds.get(h) ?? "kick") : "blip"]),
  ];
  const before = cases;
  for (const kw of Object.keys(WORDS)) {
    if (only && kw !== only) continue;
    const [a, t, d] = WORDS[kw];
    for (const [head, voice] of heads) {
      const log = writes(name, head, kw, voice);
      if (!log) continue;
      cases++;
      const at = `${name} ${head} :${kw}`;
      try {
        const sweep = log.filter((e) => e.how === "sweep").map((e) => e.v);
        const sets = log.filter((e) => e.how === "set").map((e) => e.v);
        assert.ok(sweep.length > 1, `${at}: the sweep steps (${JSON.stringify(log)})`);
        assert.ok(Math.abs(sweep[0] - a) < Math.abs(t - a) / 4, `${at}: a sweep with no :from starts at the value now (${a}), not ${sweep[0]}`);
        assert.ok(near(sweep.at(-1), t), `${at}: the sweep ends on its :to (${t}), not ${sweep.at(-1)}`);
        const want = [a, t + d, mul(t + d), a];
        assert.equal(sets.length, want.length, `${at}: ${want.length} writes, not ${JSON.stringify(sets)}`);
        sets.forEach((v, i) => assert.ok(near(v, want[i]), `${at}: write ${i + 1} is ${want[i]} (${["the value", "+ from where the sweep left it", "* from the value now", "$s"][i]}), not ${v}`));
      } catch (e) {
        failures.push(e.message);
      }
    }
  }
  // (a machine whose every case the compiler refused would pass unseen)
  if (!only) assert.ok(cases > before, `${name}: no word was checked`);
}
for (const f of failures) console.error(`  ${f}`);
assert.equal(failures.length, 0, `check:word-rule: ${failures.length} of ${cases} cases part from the rule`);
console.log(`check:word-rule ok — ${cases} words on every machine's melodic and sample channels take a value, a sweep, + * and $slot by one rule`);
