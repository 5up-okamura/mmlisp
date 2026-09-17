// The generated C tables, in a directory of the caller's own.
//
//   const t = generatedTables();
//   try { cc([...t.flags, gate_main.c, mmlispseq.c, t.tables]) } finally { t.dispose() }
//
// WHY THIS EXISTS. Several verification tools compile the 68k sequencer, and
// regenerating `drv/68k/tables.c` and `drv/68k/mml_rate.h` in place left the
// tree modified. The generated pair goes to a temporary directory instead, and
// the stamps it produced are checked against the ones this process reads.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pcmBankStamp } from "../../live/src/mmb.js";
import { ENGINE_IMAGES } from "../../live/src/engine-images.js";

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
  const rate = [1, 2, 3].map((v) => defineOf(text, `MML_PCM_STAMP_${v}`));
  const want = [1, 2, 3].map((v) => pcmBankStamp(ENGINE_IMAGES[v].rateHz));
  if (rate.some((x, i) => x !== want[i])) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`c-tables: the generated stamps ${rate} do not match this run's ${want}`);
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
