// Compile a .mmlisp source to an MMB v0.2 binary on disk, using the same
// live/src toolchain the browser uses. Usage:
//   node mmb-build.mjs <in.mmlisp> <out.mmb>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { collectImports, compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";
import { loadSamplesForIr } from "./wav.mjs";

/* The sources of every file a score imports, transitively, keyed the way the
 * compiler looks them up (language.md §9.2): the importing file's directory
 * joined with the literal path, as a normalized posix path. The compiler does
 * no I/O — the browser reads the files ahead of it and so does this. A path
 * that does not exist is left out, so the compiler's own E_IMPORT_NOT_FOUND
 * names it. */
export function readImportSources(sourcePath, src = readFileSync(sourcePath, "utf8")) {
  const map = new Map();
  const walk = (filePath, text) => {
    const dir = dirname(filePath).replace(/\\/g, "/");
    for (const p of collectImports(text)) {
      const full = posix.normalize(posix.isAbsolute(p) ? p : posix.join(dir, p));
      if (map.has(full) || !existsSync(full)) continue;
      const t = readFileSync(full, "utf8");
      map.set(full, t);
      walk(full, t);
    }
  };
  walk(sourcePath.replace(/\\/g, "/"), src);
  return map;
}

// `frameHz` picks the video standard the score is baked for (driver.md §3.3):
// 60 for NTSC, 50 for PAL. It has to be given to the COMPILER, not the
// exporter — an `Nf` duration is already ticks by the time the IR exists.
export function buildMmb(sourcePath, { frameHz } = {}) {
  const src = readFileSync(sourcePath, "utf8");
  const imports = readImportSources(sourcePath, src);
  const { ir, diagnostics } = compileMMLisp(src, sourcePath, { frameHz, imports });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    throw new Error(
      `compile failed: ${errors.map((e) => e.message).join("; ")}`,
    );
  }
  // PCM songs need the sample blobs (SAMPLE_BANK); load the WAVs the compiler
  // resolved. Non-PCM songs skip this entirely.
  const opts = {};
  const sampleDiags = [];
  if ((ir.metadata?.samples ?? []).length) {
    opts.samples = loadSamplesForIr(ir, sampleDiags);
  }
  const { bytes, sampleBank, pcmEntryIds, diagnostics: exportDiags } = encodeMmb(ir, opts);
  return {
    bytes,
    sampleBank,
    pcmEntryIds,
    ir,
    diagnostics: [...diagnostics, ...sampleDiags, ...exportDiags],
  };
}

/* Point tracks at other channels, in an already-built MMB (TRACK_TABLE: u16
 * count, then 5-byte entries of track id / channel id / flags / offset16).
 * `map` is keyed by TRACK ID.
 *
 * How a sound-effect track reaches a channel the BGM owns (driver.md §2.5).
 * The compiler gives each channel one track, so the two cannot be authored on
 * the same channel in one score; the effect is written on a spare channel and
 * pointed at the BGM's here. A bundle manifest's `remap` (tools/bundle.mjs),
 * `install-sgdk --remap` and the gates' `.cmds.json` all go through this, so
 * the reference player and the target read the same bytes.
 */
export function remapTrackChannels(mmb, map) {
  const u16 = (o) => mmb[o] | (mmb[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  const sections = u16(8), header = u16(10);
  const moved = [];
  for (let i = 0; i < sections; i++) {
    const at = header + i * 12;
    if (u16(at) !== 0x0001) continue; // SEC_TRACK_TABLE
    const off = u32(at + 4);
    const count = u16(off);
    for (let k = 0; k < count; k++) {
      const e = off + 2 + k * 5;
      const to = map[mmb[e]];
      if (to == null) continue;
      moved.push({ track: mmb[e], from: mmb[e + 1], to });
      mmb[e + 1] = to;
    }
  }
  return moved;
}

/** Parse a `--remap 4:0,5:0` argument into the map remapTrackChannels takes. */
export function parseRemap(spec) {
  const map = {};
  for (const pair of String(spec).split(",")) {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(pair);
    if (!m) throw new Error(`bad --remap entry "${pair}" — expected track:channel`);
    map[Number(m[1])] = Number(m[2]);
  }
  return map;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: node mmb-build.mjs <in.mmlisp> <out.mmb>");
    process.exit(2);
  }
  const { bytes, sampleBank, diagnostics } = buildMmb(inPath);
  writeFileSync(outPath, bytes);
  console.log(`${outPath}: ${bytes.length} bytes`);
  if (sampleBank && sampleBank.length) {
    // PCM blobs ride a separate sample bank now (plan-se.md), not in the .mmb.
    const smpPath = outPath.replace(/\.mmb$/, "") + ".smp";
    writeFileSync(smpPath, sampleBank);
    console.log(`${smpPath}: ${sampleBank.length} bytes (sample bank)`);
  }
  for (const d of diagnostics) console.warn(`  ${d.severity}: ${d.message}`);
}
