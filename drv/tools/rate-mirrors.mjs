// Do the three committed artifacts describe the SAME sample clock?
//
//   node tools/rate-mirrors.mjs
//
// src/mixer.z80, src/rate.z80, src/ask-dense.z80, 68k/mml_rate.h and
// sgdk/mmlispdrv_bin.h are each generated for
// whatever the environment said when somebody last ran a tool that writes them
// — and every probe run does. Twice in one session they ended up describing
// three different clocks: the Z80 include at 9,987 Hz, the C header at 6,658
// and the engine image at 3,329. An SGDK project links all three, so that is a
// driver that plays at one rate, sequences at another and refuses its own
// sample bank at load.
//
// Nothing in the build catches it, because the build never READS the committed
// copies: build-engine hands the assembler a freshly generated mixer and rate
// in memory. So this does, off one line each of them carries.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const drv = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["src/mixer.z80", "the generated mixer core"],
  ["src/rate.z80", "the Z80 engine's include"],
  ["src/ask-dense.z80", "the ask the engine includes only at short periods"],
  ["68k/mml_rate.h", "the 68k sequencer's header"],
  ["sgdk/mmlispdrv_bin.h", "the engine image an SGDK project links"],
];

let bad = 0;
const seen = [];
for (const [rel, what] of files) {
  const text = readFileSync(join(drv, rel), "utf8");
  const m = /RATE-STAMP\s+(\d+)\s+(\d+)/.exec(text);
  if (!m) {
    console.log(`FAIL  ${rel} carries no RATE-STAMP — regenerate it`);
    bad++;
    continue;
  }
  seen.push({ rel, what, hz: Number(m[1]), lead: Number(m[2]) });
}
const first = seen[0];
for (const s of seen) {
  const ok = first && s.hz === first.hz && s.lead === first.lead;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${s.rel.padEnd(24)} ${String(s.hz).padStart(6)} Hz`
    + ` · lead ${String(s.lead).padStart(3)} samples — ${s.what}`);
}
if (bad) {
  console.log(`\nFAIL: the committed artifacts describe different sample clocks.`);
  console.log(`  Regenerate all three at ONE configuration, e.g.`);
  console.log(`    PCM_SPG=1 TIMER_B_K=1 node tools/gen-c-tables.mjs`);
  console.log(`    PCM_SPG=1 TIMER_B_K=1 node -e "import('./tools/gen-mixer.mjs').then(m=>m.writeRate())"`);
  console.log(`    PCM_SPG=1 TIMER_B_K=1 node tools/emit-bin.mjs`);
  process.exit(1);
}
console.log(`\nall ${seen.length} mirrors agree: ${first.hz} Hz, lead ${first.lead} samples`);
