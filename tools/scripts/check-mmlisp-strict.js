#!/usr/bin/env node
"use strict";

const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const COMPILER_PATH = path.join(ROOT, "live", "src", "mmlisp2ir.js");

async function compile(src, filename) {
  const { compileMMLisp } = await import(COMPILER_PATH);
  return compileMMLisp(src, filename);
}

function assertCodes(actualDiagnostics, expectedCodes, label) {
  const actualCodes = actualDiagnostics.map((d) => d.code);
  const sameLength = actualCodes.length === expectedCodes.length;
  const sameCodes =
    sameLength &&
    actualCodes.every((code, index) => code === expectedCodes[index]);

  if (!sameCodes) {
    throw new Error(
      `${label}: expected [${expectedCodes.join(", ")}], got [${actualCodes.join(", ")}]`,
    );
  }
}

async function main() {
  const cases = [
    {
      label: "unknown atom",
      src: "(fm1 :tempo 120 xyz)",
      expected: ["E_UNKNOWN_ATOM"],
    },
    {
      label: "unknown list",
      src: "(fm1 :tempo 120 (foo))",
      expected: ["E_UNKNOWN_LIST"],
    },
    {
      label: "empty list",
      src: "(fm1 :tempo 120 ())",
      expected: ["E_UNKNOWN_LIST"],
    },
    {
      label: "unknown tuplet element",
      src: "(fm1 :tempo 120 :len 4 (t c (foo) d))",
      expected: ["E_UNKNOWN_TUPLET_ELEM"],
    },
    {
      label: "go arity",
      src: "(fm1 :tempo 120 #a c (go a 2 3))",
      expected: ["E_GO_ARITY"],
    },
    {
      label: "unknown top-level form",
      src: "(zonk :tempo 120 c)",
      expected: ["E_UNKNOWN_TOPLEVEL_FORM"],
    },
    // Values that compile but cannot mean what was written: warned, not dropped.
    {
      label: "macro :step 0",
      src: "(fm1 (macro :vel [15 12 9] :step 0) c)",
      expected: ["W_MACRO_STEP_INVALID"],
    },
    {
      label: "glide time typo",
      src: "(fm1 (glide 8x) c e)",
      expected: ["W_GLIDE_INVALID"],
    },
    {
      label: "def-pcm number typo",
      src: '(def-pcm k :file "/k.wav" :rate 8k :offset 1.5 :frames 100)',
      expected: ["W_SAMPLE_KEY_INVALID", "W_SAMPLE_KEY_INVALID"],
    },
    {
      label: "shuffle out of range",
      src: "(sqr1 :shuffle 30 c :shuffle 95 c :shuffle 0 c :shuffle 66 c)",
      expected: ["W_SHUFFLE_STRAIGHT", "W_SHUFFLE_CLAMPED"],
    },
    {
      label: "inline sweep :wait",
      src: "(fm1 (x 2 :tl1 (linear 0..60 :len 8 :wait 4) c) (macro :tl1 (linear 0..60 :len 8 :wait 4)) c)",
      expected: ["W_SWEEP_WAIT"],
    },
    {
      label: "curve value written without its keyword",
      src: "(fm1 :len 8 (note (+ 60 (noise -12..12 3))) (macro :tl1 (sin -20..20 8)) c (note (+ 60 (noise -12..12 :seed 3))) (macro :tl1 (sin -20..20 :len 8)) c)",
      expected: ["E_CURVE_STRAY_VALUE", "E_CURVE_STRAY_VALUE"],
    },
    {
      label: "curve param that does not read",
      src: "(fm1 (macro :tl1 (sin :from 0 :to 20 :len 8x :phase p)) c (macro :tl1 (sin :from 0 :to 20 :len 8 :phase 4)) c)",
      expected: ["W_CURVE_PARAM_INVALID", "W_CURVE_PARAM_INVALID"],
    },
    {
      label: "curve params from compile-time values",
      src: "(def-val v 5)\n(fm1 (let [n 20 w 2] (macro :tl1 [(wait (* w 8)) (sin :from $v :to (* n 2) :len (+ 4 4) :phase (+ 60 4) :rate n)]) :tl2 (linear :from 0 :to n :len (frames 12)) c))",
      expected: [],
    },
    {
      label: "curve param expression with a $",
      src: "(def-val v 5)\n(fm1 (macro :tl1 (linear :from 0 :to (+ $v 4) :len 8)) c (let [x (* $v 2)] :tl1 (linear :from 0 :to x :len 8) c))",
      expected: ["E_CURVE_PARAM_RUNTIME", "E_CURVE_PARAM_RUNTIME"],
    },
    {
      label: "let binds as a [name expr …] vector",
      src: "(def riff c d)\n(fm1 :len 8 (let [root 60 up (+ root 2)] (note root) (note up)) :tl1 (let [x 30] (+ x 5)) c (let ((old 1)) c) (let [odd 1 two] c) (let [riff 60] c))",
      expected: ["E_LET_SHADOWS_DEF", "E_LET_BINDING", "E_LET_BINDING"],
    },
    {
      label: "for: values, names, passes",
      src: "(def riff c d)\n(def-val v 3 0..10)\n(fm1 :len 16 (for [i 0..3 n [0 7]] (note (+ 60 i n))) (for [i 7] c) (for [i 0.5..2] c) (for [i [$v]] c) (for [c 0..1] d) (for [riff 0..1] d) (for [lo 0..99 hi 0..99] c) (for [] c) :tl1 (for [i 0..1] 3))",
      expected: ["E_LET_SHADOWS_DEF", "E_FOR_VALUES", "E_FOR_VALUES", "E_EVAL_TYPE", "E_LET_NAME", "E_FOR_COUNT", "E_FOR_VALUES", "E_EVAL_UNKNOWN_HEAD"],
    },
    {
      label: "if: tests, arity, $ and curve tests",
      src: "(def riff c e g)\n(def-val v 3 0..10)\n(fm1 :len 16 (for [i 0..7] (if (= (mod i 4) 0) (note 72) (note 60))) (if (< 1 2) riff b) (if 0 c) :tl1 (if (<= 1 1 2) 10 20) (if (= $v 1) c) :tl1 (if 1 2) (if 1) (if (sin :from 0 :to 1 :len 4f) c) (note (mod 3 0)))",
      expected: ["E_EVAL_TYPE", "E_EVAL_ARITY", "E_EVAL_ARITY", "E_EVAL_TYPE", "E_EVAL_DIV_ZERO"],
    },
    {
      label: "parametric def: a name the argument mentions is not captured",
      // Captured, (hi n) would play n + n = 200 (E_NOTE_RANGE), and (sh 0)
      // would bind the name 0 (E_LET_NAME).
      src: "(def (hi root) (for [n [0 100]] (note (+ root n))))\n(def (sh n) (let [m (+ n 1) n 5] (note (+ 60 m n))))\n(fm1 :len 8 (let [n 20] (hi n)) (sh 0))",
      expected: [],
    },
    {
      label: ":snap: a mask, not a level — no operator, curve, word, fraction, note name, macro; not on pcm",
      src: "(fm1 :len 8 :snap+ 1 c :snap (sin 0..1 :len 4) c :snap foo c :snap [0 4.5] c :snap [c e g] c (macro :snap [0]) c :snap [0 4 7] :snap 2741 :snap none c)\n(pcm1 :snap [0] c)",
      expected: ["E_PARAM_VALUE", "E_PARAM_VALUE", "E_PARAM_VALUE", "E_PARAM_VALUE", "E_EVAL_OPERAND", "E_MACRO_TARGET", "E_PCM_NO_PITCH", "E_PCM_SAMPLE_REQUIRED"],
    },
    {
      label: "echo before any note",
      src: "(fm1 (echo 3 :vel+ -3) c d (echo 2 :vel+ -2))",
      expected: ["W_ECHO_NO_NOTE"],
    },
    {
      label: "def-pcm rate not above 0",
      src: '(def-pcm k :file "/k.wav" :rate 0)',
      expected: ["W_SAMPLE_KEY_INVALID"],
    },
    {
      label: "wait value typo",
      src: "(fm1 (macro :tl1 (linear 0..60 :len 8 :wait 4x) :vel [15 (wait zz) (linear 15..0 :len 4)]) c)",
      expected: ["W_WAIT_INVALID", "W_WAIT_INVALID"],
    },
    // A noise curve where a number is needed is one draw (language.md §11.1).
    {
      label: "noise drawn as a note, a length and a rounded value",
      src: "(fm1 (let [root 60] (note (+ root (noise 0..12))) (note (+ root (noise 0..12)) (frames (round (noise 10..20)))) (for [i 0..1] (note (+ root (round (noise 0..12 :seed 1)))))))",
      expected: [],
    },
    {
      label: "every compile-time number takes an expression",
      src: "(def-score :pcm-voices (+ 1 0))\n(def-val g (+ 10 10) :from 0 :to (* 4 10))\n(def-mod :ch fm2 :vel+ (- 2))\n(def-se hit :prio (+ 1 2) (fm1 c))\n(fm4 :shuffle (+ 50 10) c c)\n(fm2 :gate* (/ 1 2) c :gate- (ticks 12) c (x (+ 1 2) c) #a c (go a (+ 1 1)) (trig (+ 1 2)) (echo (+ 1 1) :vel+ -3) c (delay (+ 1 2) :vel+ -4 :time (* 2 4)) c :oct (round (noise 4..6)) c)",
      expected: [],
    },
    {
      label: "midi and hz",
      src: "(def (rnd root) (note (+ root (noise 0..12))))\n(fm1 (rnd (midi c+4)) (note (midi b-3)) :tl1 (round (/ (hz a4) 22)))\n(def-fm v :alg 7)\n(fm3-csm v)\n(fm3-1 :oct 5 c)\n(fm3-csm-rate (note (midi e3)))",
      expected: [],
    },
    {
      label: "hz as an inline CSM rate",
      src: "(def-fm v :alg 4)\n(fm3-csm v :oct 4 :csm-rate (hz a3) c :csm-rate (* 2 (hz a3)) c)",
      expected: [],
    },
    {
      label: "midi takes a note name with its octave",
      src: "(fm1 (note (midi c)) (note (midi 60)))",
      expected: ["E_EVAL_OPERAND", "E_EVAL_OPERAND"],
    },
    {
      label: "a movement curve where a number is needed",
      src: "(fm1 (note (+ 60 (pink 0..12))))",
      expected: ["E_EVAL_TYPE"],
    },
    // CSM with the operators as tracks (language.md §15): a note-less
    // (fm3-csm voice) beside fm3-1..fm3-4, the rate from an fm3-csm-rate track.
    {
      label: "CSM formant tracks accepted",
      src: "(def-fm v :alg 7)\n(fm3-csm v)\n(fm3-1 :oct 5 c (macro :vol [31 16]) c)\n(fm3-2 :oct 6 e)\n(fm3-csm-rate :oct 3 c _ c)",
      expected: [],
    },
    {
      label: "CSM formant tracks: a note on fm3-csm",
      src: "(def-fm v :alg 7)\n(fm3-csm v c)\n(fm3-1 :oct 5 c)\n(fm3-csm-rate :oct 3 c)",
      expected: ["E_FM3_MODE_CONFLICT"],
    },
    {
      label: "CSM formant tracks without a rate track",
      src: "(def-fm v :alg 7)\n(fm3-csm v)\n(fm3-1 :oct 5 c)",
      expected: ["E_CSM_RATE_MISSING"],
    },
    {
      label: "CSM formant tracks: inline :csm-rate beside the rate track",
      src: "(def-fm v :alg 7)\n(fm3-csm v :csm-rate 200)\n(fm3-1 :oct 5 c)\n(fm3-csm-rate :oct 3 c)",
      expected: ["E_CSM_RATE_SOURCE_CONFLICT"],
    },
    {
      label: "fm3-1 beside fm3-csm-rate alone",
      src: "(fm3-1 :oct 5 c)\n(fm3-csm-rate :oct 3 c)",
      expected: ["E_FM3_MODE_CONFLICT"],
    },
    {
      label: "fm3 beside fm3-csm",
      src: "(fm3 c)\n(fm3-csm c)",
      expected: ["E_FM3_MODE_CONFLICT"],
    },
    {
      label: "def-se part on CH3",
      src: "(fm1 c)\n(def-se hit (fm3 c) (fm3-1 c) (fm3-csm c) (fm2 c))",
      expected: ["E_SE_PART", "E_SE_PART", "E_SE_PART"],
    },
    // Velocity sensitivity (:vel1–:vel4): a ratio 0–1, fixed at compile time.
    {
      label: "velocity sensitivity accepted",
      src: "(def-fm v :alg 4 :vel1 0.5 :vel4 0)\n(fm1 v c :vel2 1 (param-set :vel3 0.25) c)",
      expected: [],
    },
    {
      label: "velocity sensitivity out of range",
      src: "(def-fm v :vel1 1.5)\n(fm1 v c :vel2 -0.5 c)",
      expected: ["E_VOICE_VALUE", "E_PARAM_VALUE"],
    },
    {
      label: "velocity sensitivity has no relative, curve, $ or macro form",
      src: "(def-val x 1)\n(fm1 :vel2+ 0.1 :vel2 (linear 0..1 :len 4) :vel2 $x (macro :vel2 [0 1]) c)",
      expected: ["E_PARAM_VALUE", "E_PARAM_VALUE", "E_PARAM_VALUE", "E_MACRO_TARGET"],
    },
    {
      label: "velocity sensitivity off FM",
      src: "(sqr1 :vel1 0.5 c)",
      expected: ["E_UNSUPPORTED_TARGET"],
    },
    // Targets (language.md §19): what pc88's chips have, and what they do not.
    {
      label: "pc88 score accepted",
      src: '(def-score :target pc88)\n(fm6 c)\n(sqr1 :mode both :noise-rate 12 c)\n(noise c)\n(pcm2 :prio 1 kick :len 4 c c)\n(pcm2 :prio 2 hat :len 8 c c c c)',
      expected: [],
    },
    {
      label: "pc88 settings ignored, sounds it lacks refused",
      src: '(def-score :target pc88 :pcm-voices 1)\n(sqr3 c)\n(noise :mode white1 c :mode periodic0 c)\n(pcm1 kick c)\n(pcm2 kick :mode loop d)',
      expected: ["W_TARGET", "E_TARGET", "W_TARGET", "E_TARGET", "E_TARGET", "E_TARGET", "E_TARGET"],
    },
    {
      label: "Mega Drive refuses the SSG's words",
      src: '(sqr1 :noise-rate 3 c)',
      expected: ["E_TARGET"],
    },
    {
      label: "pc88 rhythm by the kit roles",
      src: '(def-score :target pc88)\n(def-pcm kick :file "/k.wav" :fx [(gain 3)])\n(def-pcm clap :file "/c.wav")\n(pcm1 kick c clap c)\n(pcm2 kick c clap c)',
      expected: ["W_TARGET", "E_TARGET"],
    },
    {
      label: "the kit roles are built in on pc88 only",
      src: '(pcm1 kick c)',
      expected: ["E_UNKNOWN_ATOM", "E_PCM_SAMPLE_REQUIRED"],
    },
    {
      label: "unknown target",
      src: "(def-score :target nes)\n(fm1 c)",
      expected: ["E_SCORE_OPTION"],
    },
    // A part's word on another part's channel (language.md §19): inline, in
    // a macro and in a param-set; a song-wide word is any track's.
    {
      label: "a channel takes its own part's words",
      src: '(sqr1 :tl1 30 :pan left :lfo-rate 3 (macro :ar1 [3 1]) (param-set :tl2 3) c)\n(noise :ssg1 8 c)\n(fm1 :pcm-start 4 (macro :mode [white0]) c)\n(def-pcm k :file "/k.wav")\n(pcm1 k :pan left c)',
      expected: ["E_UNSUPPORTED_TARGET", "E_UNSUPPORTED_TARGET", "E_UNSUPPORTED_TARGET", "E_UNSUPPORTED_TARGET",
        "E_UNSUPPORTED_TARGET", "E_UNSUPPORTED_TARGET", "E_UNSUPPORTED_TARGET", "E_UNSUPPORTED_TARGET"],
    },
    {
      label: "pc88's parts take pan where the chip has it",
      src: '(def-score :target pc88)\n(def-pcm k :file "/k.wav")\n(sqr1 :pan left c)\n(pcm1 k :pan left c)\n(pcm2 kick :pan right c)',
      expected: ["E_UNSUPPORTED_TARGET"],
    },
  ];

  for (const testCase of cases) {
    const result = await compile(testCase.src, testCase.label);
    assertCodes(result.diagnostics, testCase.expected, testCase.label);
  }

  console.log(`Strict compiler checks passed: ${cases.length}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
