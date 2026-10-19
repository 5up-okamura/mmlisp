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
    {
      label: "def-se part on CH3",
      src: "(fm1 c)\n(def-se hit (fm3 c) (fm3-1 c) (fm3-csm c) (fm2 c))",
      expected: ["E_SE_PART", "E_SE_PART", "E_SE_PART"],
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
