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
      src: "(score :tempo 120 (fm1 xyz))",
      expected: ["E_UNKNOWN_ATOM"],
    },
    {
      label: "unknown list",
      src: "(score :tempo 120 (fm1 (foo)))",
      expected: ["E_UNKNOWN_LIST"],
    },
    {
      label: "empty list",
      src: "(score :tempo 120 (fm1 ()))",
      expected: ["E_UNKNOWN_LIST"],
    },
    {
      label: "unknown tuplet element",
      src: "(score :tempo 120 (fm1 :len 4 (c (foo) d)))",
      expected: ["E_UNKNOWN_TUPLET_ELEM"],
    },
    {
      label: "goto arity",
      src: "(score :tempo 120 (fm1 #a c (goto a 2)))",
      expected: ["E_GOTO_ARITY"],
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
