// The living §10 budget report: static size audit + the worst-case stack
// watermark across the full gate corpus. Run `npm run budget` after any driver
// change to keep design-eval.md §10 / z80-driver-status.md honest.
//
//   node budget.mjs [--top N]   (default N = 8 deepest scores listed)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sizeAudit } from "./size-audit.mjs";
import { verify } from "./verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tests = join(here, "..", "tests");
const examples = join(here, "..", "..", "examples", "source");

// The full gate corpus with its verify:all frame budgets — worst-case stack
// depends on which path fires *and* how long it runs, so a subset undercounts.
const CORPUS = [
  [join(examples, "ab-core.mmlisp"), undefined],
  [join(tests, "stress-m1.mmlisp"), 1800],
  [join(tests, "stress-m2skip.mmlisp"), 1200],
  [join(tests, "m2-motion.mmlisp"), 800],
  [join(tests, "m2b-pitch.mmlisp"), 500],
  [join(tests, "m2-csm.mmlisp"), 300],
  [join(tests, "m2-pcm.mmlisp"), 200],
  [join(tests, "m2-pcmloop.mmlisp"), 400],
  [join(tests, "m2-mailbox.mmlisp"), 400],
  [join(tests, "m3-fm3op.mmlisp"), 300],
  [join(tests, "m3-macro.mmlisp"), 300],
  [join(tests, "m3-macro-curve.mmlisp"), 300],
  [join(tests, "m3-macro-semi.mmlisp"), 300],
  [join(tests, "m3-dynval.mmlisp"), 200],
  [join(tests, "m3-macro-pitch.mmlisp"), 200],
  [join(tests, "m3-macro-multi.mmlisp"), 300],
  [join(tests, "m3-pcm-softmix.mmlisp"), 300],
  [join(tests, "m3-macro-keyon.mmlisp"), 200],
  [join(tests, "m3-slur.mmlisp"), 300],
  [join(tests, "m3-macro-vel.mmlisp"), 200],
  [join(tests, "m3-macro-scale.mmlisp"), 250],
];

const topN = (() => {
  const i = process.argv.indexOf("--top");
  return i >= 0 ? Number(process.argv[i + 1]) : 8;
})();

const a = sizeAudit();
console.log("== resident image ==");
console.log(`  code ${a.resident} B · ceiling ${a.ceiling} B · free ${a.free} B`);
console.log(`  overlays ${a.overlays.join("/")} B in a ${a.slot} B slot (slack ${a.overlaySlack} B)`);
const coldGross = a.coldSetup.reduce((s, [, v]) => s + v, 0);
console.log(`  rare cold-setup gross ${coldGross} B (overlay-eviction candidate)`);

console.log("\n== stack watermark (full gate corpus) ==");
const rows = [];
let bad = 0;
for (const [path, frames] of CORPUS) {
  const r = verify(path, { frames });
  if (!r.ok) bad++;
  rows.push({ name: path.split("/").pop().replace(/\.mmlisp$/, ""), ...r.stats.stack, ok: r.ok });
}
rows.sort((x, y) => y.used - x.used);
for (const s of rows.slice(0, topN)) {
  console.log(`  ${String(s.used).padStart(3)} B used · ${s.reserve} B reserve  ${s.name}${s.ok ? "" : "  ⚠ TRACE MISMATCH"}`);
}
const worst = rows[0];
console.log(`  ── worst: ${worst.used} B used of the ${worst.window} B window ` +
  `(${worst.reserve} B reserve) on ${worst.name}`);
if (bad) {
  console.log(`\n⚠ ${bad} score(s) mismatched — stack numbers are from a broken driver.`);
  process.exit(1);
}
