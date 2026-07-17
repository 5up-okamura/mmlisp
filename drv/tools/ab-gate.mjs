// ---------------------------------------------------------------------------
// A/B characterization gate: ir-player vs drv-player, headless.
//
// The trace gate (verify.mjs) only proves Z80 ≡ drv-player. It cannot see an
// ir-player ↔ drv-player divergence — when both references are wrong the same
// way, it passes (this is how the 2026-07 PSG soft-envelope release bug hid).
// `ab-compare.js` is the ONLY thing that sees that axis, and until now it ran
// only in the browser (`window.__abCompare()`), so nothing gated it.
//
// This wires it into `npm run verify:all`. It is a *characterization* gate, not
// a 0-diff gate: M2/M3 scores diverge by construction (the exporter pre-samples
// curves that ir-player evaluates in continuous time — driver.md §12/§13), so a
// "must be clean" rule is impossible. Instead each score's mismatch signature
// is frozen in `tests/ab-baseline.json`; the gate fails when a signature
// *changes*, surfacing any new divergence (or the disappearance of a known one)
// for review. Pure-M1 scores (ab-core) baseline to zero mismatches.
//
//   node tools/ab-gate.mjs            # check against the baseline
//   node tools/ab-gate.mjs --update   # regenerate the baseline (after review)
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { abCompare } from "../../live/src/ab-compare.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const baselinePath = join(here, "..", "tests", "ab-baseline.json");

// Corpus: the trace-gate scores (drv/tests) plus the two example songs. Every
// score the driver is verified against should also be watched on the ir↔drv
// axis. Add a score here when you add a trace gate for it.
function corpus() {
  const list = [];
  const tdir = join(here, "..", "tests");
  for (const f of readdirSync(tdir).sort()) {
    if (f.endsWith(".mmlisp")) list.push(join(tdir, f));
  }
  list.push(join(root, "examples", "source", "ab-core.mmlisp"));
  list.push(join(root, "examples", "source", "demo1.mmlisp"));
  return list;
}

// A stable, order-independent digest of the mismatch set. Deterministic (eval
// is pure), so the digest only moves when a divergence actually changes.
function digestMismatches(mismatches) {
  const norm = mismatches
    .map((m) => `${m.where}|${m.kind}|${m.frame}|${m.a ?? ""}|${m.b ?? ""}`)
    .sort();
  // FNV-1a 32-bit over the joined signature.
  let h = 0x811c9dc5;
  const s = norm.join("\n");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function signature(file) {
  const src = readFileSync(file, "utf8");
  const r = abCompare(src, { filename: basename(file) });
  const compileErrors = (r.stats.compileErrors ?? []).length;
  return {
    result: r,
    sig: {
      ok: r.ok,
      mismatches: r.mismatches.length,
      compileErrors,
      digest: digestMismatches(r.mismatches),
    },
  };
}

const update = process.argv.includes("--update");
const files = corpus();

if (update) {
  const baseline = {};
  for (const f of files) baseline[basename(f)] = signature(f).sig;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  const total = Object.values(baseline).reduce((n, s) => n + s.mismatches, 0);
  console.log(
    `ab-gate: wrote baseline for ${files.length} scores ` +
      `(${Object.values(baseline).filter((s) => s.ok).length} clean, ${total} total mismatches)`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    "ab-gate: no baseline (tests/ab-baseline.json). Run `node tools/ab-gate.mjs --update` first.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const changed = [];
const missing = [];
const extra = new Set(Object.keys(baseline));

for (const f of files) {
  const name = basename(f);
  extra.delete(name);
  const base = baseline[name];
  if (!base) {
    missing.push(name);
    continue;
  }
  const { result, sig } = signature(f);
  if (sig.digest !== base.digest || sig.mismatches !== base.mismatches || sig.ok !== base.ok) {
    changed.push({ name, base, sig, result });
  }
}

let clean = 0;
for (const name of Object.keys(baseline)) if (baseline[name].ok) clean++;

if (!changed.length && !missing.length && !extra.size) {
  const watched = files.length;
  console.log(
    `ab-gate: OK — ${watched} scores match baseline (${clean} clean, ` +
      `${watched - clean} with known ir↔drv divergence)`,
  );
  process.exit(0);
}

console.error("ab-gate: BASELINE MISMATCH\n");
for (const c of changed) {
  console.error(
    `  ${c.name}: ${c.base.mismatches} → ${c.sig.mismatches} mismatches ` +
      `(ok ${c.base.ok}→${c.sig.ok}, digest ${c.base.digest}→${c.sig.digest})`,
  );
  for (const m of c.result.mismatches.slice(0, 6)) {
    console.error(
      `      f${m.frame} ${m.where}: ${m.kind}` +
        (m.a !== undefined ? ` A=${m.a}` : "") +
        (m.b !== undefined ? ` B=${m.b}` : ""),
    );
  }
  if (c.result.mismatches.length > 6) {
    console.error(`      … ${c.result.mismatches.length - 6} more`);
  }
}
for (const name of missing) console.error(`  ${name}: in corpus but not in baseline (new score)`);
for (const name of extra) console.error(`  ${name}: in baseline but not in corpus (removed score)`);

console.error(
  "\nIf these changes are expected (a fix, or a deliberate divergence change),\n" +
    "review them, then re-freeze with: cd drv && node tools/ab-gate.mjs --update",
);
process.exit(1);
