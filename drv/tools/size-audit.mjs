// Static size audit of the resident driver image (design-eval.md §10 budget).
//
// Methodology (reproduces the §10 numbers): assemble via build-driver.mjs, sort
// the code symbols by address, and take each routine's size as the gap to the
// next symbol. The scarce resource is resident code between 0 and the G_PCMV
// ceiling (the PCM voice structs sit just above it); everything per-frame must
// live there. Overlays share one RAM slot and are cheap cold-code storage.
//
//   node size-audit.mjs [--routines N]   (default N = 16 fattest spans)
import { buildDriver } from "./build-driver.mjs";

// Rare-event cold-setup handlers that are candidates for overlay eviction
// (§10 funding menu). Reported as a named group so the "gross cold setup"
// figure stays live.
const COLD_SETUP = [
  "d_tempo_sweep",
  "d_csm_on",
  "d_csm_off",
  "d_csm_rate",
  "d_marker",
  "d_fm3_mode",
  "d_tempo_set",
];

export function sizeAudit() {
  const b = buildDriver();
  const sym = b.symbols;
  const ceiling = sym.get("G_PCMV"); // resident code must not overrun this
  const residentBytes = b.resident.length;

  // Per-routine spans: sort code-region labels, size = gap to the next label.
  const code = [...sym.entries()]
    .filter(([, v]) => v < residentBytes)
    .sort((a, c) => a[1] - c[1]);
  const spans = new Map();
  for (let i = 0; i < code.length; i++) {
    const next = i + 1 < code.length ? code[i + 1][1] : residentBytes;
    spans.set(code[i][0], next - code[i][1]);
  }

  const slot = sym.get("DATA_BASE") - sym.get("OVERLAY_SLOT");
  const overlays = b.overlays.map((o) => o.length);

  return {
    resident: residentBytes,
    ceiling,
    free: ceiling - residentBytes,
    slot,
    overlays,
    overlaySlack: slot - Math.max(...overlays),
    coldSetup: COLD_SETUP.map((n) => [n, spans.get(n) ?? 0]),
    spans,
  };
}

function hex(n) {
  return "$" + n.toString(16).toUpperCase();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const rIdx = process.argv.indexOf("--routines");
  const topN = rIdx >= 0 ? Number(process.argv[rIdx + 1]) : 16;
  const a = sizeAudit();

  console.log("== resident image ==");
  console.log(`  code      ${a.resident} B`);
  console.log(`  ceiling   ${a.ceiling} B (G_PCMV ${hex(a.ceiling)})`);
  console.log(`  free      ${a.free} B  ← the scarce resource`);

  console.log("\n== overlays ==");
  console.log(`  slot      ${a.slot} B`);
  console.log(`  sizes     ${a.overlays.join(" / ")} B`);
  console.log(`  slack     ${a.overlaySlack} B (room to grow the largest)`);

  const coldGross = a.coldSetup.reduce((s, [, v]) => s + v, 0);
  console.log(`\n== rare-event cold setup (overlay-eviction candidates) ==`);
  for (const [n, v] of a.coldSetup) console.log(`  ${String(v).padStart(4)} B  ${n}`);
  console.log(`  ${String(coldGross).padStart(4)} B  gross`);

  console.log(`\n== ${topN} fattest label spans ==`);
  [...a.spans.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topN)
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} B  ${k}`));
}
