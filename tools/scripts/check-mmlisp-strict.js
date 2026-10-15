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
