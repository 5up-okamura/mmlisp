// A score's samples baked for its machine, as its sample part bakes them
// (chips/parts.js `bank`). Live's play and exports and the MCP server's render
// all bake here, so a machine plays its samples the same through each:
//   "adpcm"  the YM2608's ADPCM-B RAM image (chips/adpcm-b.js)
//   "pcm8"   the X68000's PCM8 voices, mixed into the MSM6258 (chips/msm6258.js)
//   "frames" frames the player writes as the chip's own registers (the PC
//            Engine's DDA, the 2A03's DMC), baked as PCM8's are
//   "mmb"    the Mega Drive's soft-mix bank, as an .mmb ships it
import { bakeAdpcmB } from "./chips/adpcm-b.js";
import { bakePcm8 } from "./chips/msm6258.js";
import { encodeMmb } from "./export-mmb.js";

/** How the machine bakes its samples, or null for one with no sample bank. */
export function sampleBankKind(target) {
  return target.parts.find((p) => p.bank)?.bank ?? null;
}

/** Whether `ir` has samples to bake: the Mega Drive's bank only with :pcm-voices. */
export function hasSampleBank(ir, target) {
  const kind = sampleBankKind(target);
  return kind !== null && (kind !== "mmb" || (ir.metadata?.pcmVoices ?? 0) > 0);
}

/**
 * Bake `ir`'s samples from their decoded files (`blobs`: { name: { data,
 * baseRate } }). Returns { kind, bake, pcm, warnings }: `bake` the kind's own
 * result (what the IR player and the worklet take), `pcm` the bundle the WAV
 * and VGM exports take ({ adpcm } | { pcm8 } | { frames } | { bank, entryIds,
 * pcmVoices, frameHz }), null when nothing sounds.
 */
export function bakeSampleBank(ir, blobs, target) {
  const kind = sampleBankKind(target);
  if (kind === "adpcm") {
    const bake = bakeAdpcmB(ir, blobs, target);
    return { kind, bake, pcm: bake.image.length ? { adpcm: bake } : null, warnings: bake.warnings };
  }
  if (kind === "pcm8" || kind === "frames") {
    const bake = bakePcm8(ir, blobs);
    return { kind, bake, pcm: Object.keys(bake.entries).length ? { [kind]: bake } : null, warnings: bake.warnings };
  }
  const pcmVoices = ir.metadata?.pcmVoices ?? 0;
  if (kind !== "mmb" || !pcmVoices || !blobs) return { kind, bake: null, pcm: null, warnings: [] };
  const { sampleBank, pcmEntryIds } = encodeMmb(ir, { samples: blobs, dedup: false }); // the bank only
  const frameHz = ir.metadata?.frameHz ?? 60;
  const pcm = sampleBank ? { bank: sampleBank, entryIds: pcmEntryIds ?? {}, pcmVoices, frameHz } : null;
  return { kind, bake: pcm, pcm, warnings: [] };
}
