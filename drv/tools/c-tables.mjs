// The generated C tables, in a directory of the caller's own.
//
//   const t = generatedTables();
//   try { cc([...t.flags, gate_main.c, mmlispseq.c, t.tables]) } finally { t.dispose() }
//
// WHY THIS EXISTS. Seven verification tools compile the 68k sequencer, and each
// of them regenerated `drv/68k/tables.c` and `drv/68k/mml_rate.h` in place
// first. The header carries the sample clock, and a bare run resolves that
// clock from the ambient environment — PCM_SPG=3, TIMER_B_K=16 — while the
// committed header is the branch's 3,333 Hz configuration. So `npm run c-gate`,
// and `npm run baseline` through it, rewrote a checked-in file every time and
// left it modified; the working practice was to notice it in `git status` and
// put it back. Restoring afterwards is not a fix: between the generate and the
// restore, the tree is a configuration nobody chose.
//
// Two things this does instead:
//
//   1. The generated pair goes to a temporary directory. Nothing in the tree
//      changes, so there is nothing to restore and nothing to forget.
//   2. THE RATE IS CHECKED, not assumed. The child process re-reads mmb.js and
//      could resolve a different clock than the parent is measuring against —
//      that is the same hazard the shared header was hiding. The numbers it
//      produced are compared with the ones this process is actually using, and
//      a disagreement is an error rather than a silently mismatched build.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PCM_SAMPLES_NUM, PCM_SAMPLES_DEN, PCM_BAKE_STAMP, PCM_RING_TARGET,
} from "../../live/src/mmb.js";

const here = dirname(fileURLToPath(import.meta.url));

const defineOf = (text, name) => {
  const m = text.match(new RegExp(`^#define\\s+${name}\\s+(-?\\d+)\\s*$`, "m"));
  if (!m) throw new Error(`c-tables: the generated header has no ${name}`);
  return Number(m[1]);
};

/**
 * Generate tables.c and mml_rate.h into a fresh directory and return what a
 * compiler needs to use them.
 *
 * @returns {{dir, tables, header, flags, rate, dispose}}
 */
export function generatedTables() {
  const dir = mkdtempSync(join(tmpdir(), "mml-ctables-"));
  try {
    execFileSync("node", [join(here, "gen-c-tables.mjs"), "--out", dir], { stdio: "pipe" });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`c-tables: the generator failed\n${e.stderr?.toString() ?? e.message}`);
  }
  const header = join(dir, "mml_rate.h");
  const text = readFileSync(header, "utf8");
  const rate = {
    spgNum: defineOf(text, "MML_SPG_NUM"), spgDen: defineOf(text, "MML_SPG_DEN"),
    stamp: defineOf(text, "MML_SPG_STAMP"), ringTarget: defineOf(text, "MML_PCM_RING_TARGET"),
  };
  const want = { spgNum: PCM_SAMPLES_NUM, spgDen: PCM_SAMPLES_DEN,
    stamp: PCM_BAKE_STAMP, ringTarget: PCM_RING_TARGET };
  const off = Object.keys(want).filter((k) => rate[k] !== want[k]);
  if (off.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`c-tables: the generated clock does not match this run's — `
      + off.map((k) => `${k} ${rate[k]} vs ${want[k]}`).join(", ")
      + `. Set PCM_SPG / TIMER_B_K / PCM_TIMER once, for the whole command.`);
  }
  return {
    dir, header, tables: join(dir, "tables.c"), rate,
    // `-I` alone cannot redirect this: mmlispseq.h says `#include "mml_rate.h"`
    // and a quoted include is resolved beside the file that wrote it, which is
    // drv/68k. Forcing the generated header in ahead of the translation unit
    // does redirect it — it defines MML_RATE_H, so the tree's copy then expands
    // to nothing behind its own guard.
    // …and the generated tables.c includes mmlispseq.h, which stays where it is
    // written, so the tree's 68k directory is on the path too.
    flags: [`-I${dir}`, `-I${join(here, "..", "68k")}`, "-include", header],
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
