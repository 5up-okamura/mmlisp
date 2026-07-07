// Central driver build: regenerate the constant-table equs, then assemble the
// resident image plus its overlay ROM blob (see build-overlays.mjs). Both
// verify.mjs (gate) and emit-bin.mjs (artifacts) go through here so the
// resident/overlay split is defined in exactly one place.
//
// While `OVERLAYS` is empty the resident is the whole driver and the overlay
// blob is empty — the build path is live but a no-op, so the M1 model (window
// always serves the MMB) is unchanged.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlays } from "./build-overlays.mjs";
import { generateTables } from "./gen-tables.mjs";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Overlay configuration. Cold code (rarely invoked, not the per-frame loop)
// moves into these files; each is assembled at OVERLAY_SLOT and loaded on
// demand into that shared RAM buffer. The overlay ROM ships at OVERLAY_BANK.
export const OVERLAY_BANK = 1;
// Order defines the overlay index in ovl_desc_tab (0 = ovl_setup, 1 = ovl_cmd,
// 2 = ovl_pcm).
const OVERLAYS = ["ovl_setup.z80", "ovl_cmd.z80", "ovl_pcm.z80"];

export function buildDriver() {
  writeFileSync(join(srcDir, "tables.z80"), generateTables());
  const built = buildOverlays({
    residentPath: join(srcDir, "mmlispdrv.z80"),
    overlayPaths: OVERLAYS.map((f) => join(srcDir, f)),
    descTab: "ovl_desc_tab",
  });
  // The PCM voice structs live in the RAM gap just below OVERLAY_SLOT; assert the
  // resident code does not grow into them (G_PCMV is $16F0). Assert each overlay
  // still fits the shared slot.
  const gPcmv = built.symbols.get("G_PCMV");
  const slot = built.symbols.get("OVERLAY_SLOT");
  const dataBase = built.symbols.get("DATA_BASE");
  if (built.resident.length > gPcmv) {
    throw new Error(
      `resident (${built.resident.length}) overruns G_PCMV (0x${gPcmv.toString(16)})`,
    );
  }
  const slotSize = dataBase - slot;
  for (const ov of built.overlays) {
    if (ov.length > slotSize)
      throw new Error(`overlay ${ov.length} B > slot ${slotSize} B`);
  }
  return { ...built, overlayBank: OVERLAY_BANK };
}
