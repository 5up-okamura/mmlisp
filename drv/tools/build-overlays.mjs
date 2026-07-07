// Build a resident Z80 image plus a concatenated overlay ROM blob.
//
// Each overlay is assembled at `slot` (via `org slot`) with the resident image's
// symbols preloaded, so it can call resident routines and use resident equates
// directly — no import files. The resident's overlay-descriptor table (at the
// `descTab` symbol) is patched in place with each overlay's {rom_offset u16,
// length u16}, so the resident loader can LDIR the right bytes from the overlay
// ROM window into the slot.
import { assemble } from "./z80asm.mjs";

export function buildOverlays({ residentPath, overlayPaths, slot, descTab }) {
  const { bytes: resBytes, symbols } = assemble(residentPath);
  const resident = new Uint8Array(resBytes);
  const slotAddr = symbols.get("OVERLAY_SLOT") ?? slot; // single-sourced from the asm
  const blob = [];
  const overlays = [];
  for (const p of overlayPaths) {
    const full = assemble(p, { preload: symbols }).bytes;
    const code = full.slice(slotAddr); // drop the org pad → the ROM bytes
    overlays.push({ path: p, offset: blob.length, length: code.length });
    for (const b of code) blob.push(b);
  }
  if (overlays.length === 0) return { resident, overlay: new Uint8Array(0), overlays, symbols };
  const tabAddr = symbols.get(descTab);
  if (tabAddr == null) throw new Error(`descriptor table symbol '${descTab}' not found`);
  overlays.forEach((ov, i) => {
    const e = tabAddr + i * 4;
    resident[e] = ov.offset & 0xff;
    resident[e + 1] = (ov.offset >> 8) & 0xff;
    resident[e + 2] = ov.length & 0xff;
    resident[e + 3] = (ov.length >> 8) & 0xff;
  });
  return { resident, overlay: new Uint8Array(blob), overlays, symbols };
}
