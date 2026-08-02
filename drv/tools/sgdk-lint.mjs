// Type-check the SGDK glue against the sequencer API.
//
// The glue (sgdk/mmlispdrv.c) cannot be gated the way the sequencer is: it
// talks to SGDK and to a real Z80, neither of which lives in this repo. But the
// most likely way for it to break is not exotic — it is drifting out of step
// with mmlispseq.h, which changes far more often than SGDK does. So compile it
// against a hand-written shim of the handful of SGDK symbols it uses, with the
// REAL mmlispseq.h in the include path.
//
// What a clean run means: the glue and the sequencer agree on every name, type
// and argument. What it does NOT mean: anything at all about behaviour on
// hardware, or that the shim's signatures still match your SGDK version.
//
//   node tools/sgdk-lint.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "sgdklint-"));

// The example is what people copy, so it is linted too — against a stub of the
// `song.h` rescomp would generate.
writeFileSync(join(tmp, "song.h"), "extern const u8 song_mmb[];\n");

const cc = (src, extra = []) =>
  execFileSync(
    process.env.CC ?? "cc",
    ["-std=c99", "-c", "-O1", "-Wall", "-Wextra", "-Werror",
      // The two casts between a ROM pointer and a 32-bit integer (a bank number,
      // a Z80-RAM address) are exact on m68k and only lossy on this 64-bit host.
      // Silencing them is the price of type-checking 68k code here; nothing else
      // is relaxed.
      "-Wno-pointer-to-int-cast", "-Wno-int-to-pointer-cast",
      "-I", join(here, "sgdk-shim"), "-I", join(drv, "68k"), "-I", join(drv, "sgdk"),
      ...extra,
      "-o", join(tmp, "out.o"), src],
    { stdio: "pipe" },
  );

try {
  cc(join(drv, "sgdk", "mmlispdrv.c"));
  console.log("ok    sgdk/mmlispdrv.c agrees with 68k/mmlispseq.h");
  // SGDK's entry point is `int main(bool hardReset)`, which a hosted compiler
  // rejects on sight and whose parameter its own templates never use. Rename it
  // and let that one parameter be unused, rather than write an example that
  // does not look like every other SGDK program.
  cc(join(drv, "sgdk", "example", "main.c"),
     ["-I", tmp, "-Dmain=sgdk_main", "-Wno-unused-parameter"]);
  console.log("ok    sgdk/example/main.c agrees with the host API");
  console.log("      (a type-check only — it says nothing about SGDK or hardware)");
} catch (e) {
  console.error(e.stderr?.toString() ?? e.message);
  console.error("FAIL: the SGDK host files do not compile against the API");
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
