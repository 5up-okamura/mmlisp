#!/usr/bin/env node
// Every word written every way on every kind of Mega Drive track, the IR
// preview against the MMLispDRV reference (ab-compare.js). A word is one
// thing whatever track writes it; a way of writing it (a value, + * $slot,
// a sweep with and without :from, a stop) one rule — this lists where the
// preview and the driver part.
//
//   cd tools && npm run check:words                     # the table; fails on any
//   node scripts/probe-words.mjs           # the same
//   node scripts/probe-words.mjs --only vol            # one word
//   node scripts/probe-words.mjs --show pan:sqr1:sweep # one case's mismatches
import { abCompare, formatAbReport } from "../../live/src/render/ab-compare.js";
import { loadSamplesForIr } from "../../drv/tools/wav.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(join(HERE, "..", "..", "drv", "tests")); // the wavs the PCM track plays

const TRACKS = {
  fm1: "(fm1",
  "fm3-1": "(fm3-1",
  sqr1: "(sqr1",
  noise: "(noise",
  pcm1: "(pcm1 pad :mode loop",
};
// word → [value, a second value, the word's range for a sweep, tracks it is for]
const WORDS = {
  vol: ["20", "12", ["31", "4"], Object.keys(TRACKS)],
  master: ["20", "12", ["31", "4"], Object.keys(TRACKS)],
  vel: ["12", "6", ["15", "4"], Object.keys(TRACKS)],
  pan: ["-1", "1", ["-1", "1"], ["fm1", "pcm1"]],
  pitch: ["50", "-30", ["0", "200"], ["fm1", "fm3-1", "sqr1"]],
  tl1: ["20", "40", ["0", "60"], ["fm1"]],
  fb: ["2", "5", ["0", "7"], ["fm1"]],
  "lfo-rate": ["3", "6", ["0", "8"], ["fm1", "sqr1", "pcm1"]],
};
const FORMS = {
  set: (w, a, b) => `:${w} ${a} c c :${w} ${b} c c c c`,
  add: (w, a) => `:${w} ${a} c c :${w}+ 3 c c :${w}+ -2 c c`,
  mul: (w, a) => `:${w} ${a} c c :${w}* 0.5 c c :${w}* 1.5 c c`,
  slot: (w, a) => `:${w} ${a} c c :${w} $m c :m 7 c c c`,
  sweep: (w, a, b, [f, t]) => `:${w} ${a} c :${w} (linear ${f}..${t} :len 1/1) c c c c c`,
  "sweep-to": (w, a, b, [, t]) => `:${w} ${a} c :${w} (linear :to ${t} :len 1/1) c c c c c`,
  "sweep+": (w, a, b, [f, t]) => `:${w} ${a} c :${w} (linear ${f}..${t} :len 1/1) c :${w}+ 2 c c c c`,
  "sweep-set": (w, a, b, [f, t]) => `:${w} ${a} c :${w} (linear ${f}..${t} :len 1/1) c :${w} ${b} c c c c`,
};

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const show = argv.includes("--show") ? argv[argv.indexOf("--show") + 1] : null;
const src = (word, track, form) => {
  const [a, b, range] = WORDS[word];
  const body = FORMS[form](word, a, b, range);
  return `(def-pcm pad :file "pad.wav" :loop-start 9ms :loop-end 36ms)
(def-val m 9 -64..64 :public)
${TRACKS[track]} :tempo 120 :len 4 ${body})`;
};
const cell = (word, track, form) => {
  const r = abCompare(src(word, track, form), { maxSec: 5, filename: "probe.mmlisp", samples: (ir) => loadSamplesForIr(ir) });
  if (r.stats?.compileErrors) return { text: "—", r };
  return { text: r.mismatches.length ? String(r.mismatches.length) : "ok", r };
};

if (show) {
  const [word, track, form] = show.split(":");
  console.log(src(word, track, form));
  console.log(formatAbReport(cell(word, track, form).r, { maxLines: 20 }));
  process.exit(0);
}
const forms = Object.keys(FORMS);
console.log(["word:track".padEnd(16), ...forms.map((f) => f.padStart(9))].join(""));
let bad = 0;
for (const [word, [, , , tracks]] of Object.entries(WORDS)) {
  if (only && word !== only) continue;
  for (const track of tracks) {
    const row = forms.map((f) => cell(word, track, f).text);
    bad += row.filter((t) => t !== "ok" && t !== "—").length;
    console.log([`${word}:${track}`.padEnd(16), ...row.map((t) => t.padStart(9))].join(""));
  }
}
console.log(`\n${bad} cases where the preview and the driver part ("—": the compiler refuses it)`);
if (bad) process.exit(1);
