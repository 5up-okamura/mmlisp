// Compile a .mmlisp source to an MMB v0.4 binary on disk, using the same
// live/src toolchain the browser uses. Usage:
//   node mmb-build.mjs <in.mmlisp> <out.mmb>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectImports, compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";
import { loadSamplesForIr } from "./wav.mjs";

/* The repository root: where a path not found next to its importer is read
 * from (language.md §9.2), so `presets/…` works from any folder. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Where a key the compiler uses is on disk: as given (absolute, or relative to
 * the working directory), else under the repository root. */
export function locateFile(path) {
  if (existsSync(path)) return path;
  if (!isAbsolute(path) && existsSync(resolve(REPO_ROOT, path))) return resolve(REPO_ROOT, path);
  return null;
}

/* The sources of every file a score imports, transitively, keyed the way the
 * compiler looks them up (language.md §9.2): the importing file's directory
 * joined with the literal path, as a normalized posix path, or — when nothing
 * is there — the literal path itself, read from the repository root. The file
 * then counts as being where it was found, so its own imports and samples
 * resolve from there. The compiler does no I/O — the browser reads the files
 * ahead of it and so does this. A path found nowhere is left out, so the
 * compiler's own E_IMPORT_NOT_FOUND names it. */
export function readImportSources(sourcePath, src = readFileSync(sourcePath, "utf8")) {
  const map = new Map();
  const walk = (filePath, text) => {
    const dir = dirname(filePath).replace(/\\/g, "/");
    for (const p of collectImports(text)) {
      let key = posix.normalize(posix.isAbsolute(p) ? p : posix.join(dir, p));
      let at = locateFile(key);
      if (!at && !posix.isAbsolute(p)) {
        key = posix.normalize(p);
        at = locateFile(key);
      }
      if (!at || map.has(key)) continue;
      const t = readFileSync(at, "utf8");
      map.set(key, t);
      walk(key, t);
    }
  };
  walk(sourcePath.replace(/\\/g, "/"), src);
  return map;
}

/* A score's source with the game's effects (a def-se file) imported — on its
 * first line, so the score's own line numbers stand. How a bundle's "se" and
 * `--se` reach every song, without the song naming them. */
export function withSeImport(sourcePath, src, seFile) {
  if (!seFile) return src;
  const rel = relative(dirname(resolve(sourcePath)), resolve(seFile)).split("\\").join("/");
  return `(import ${JSON.stringify(rel)}) ` + src;
}

// `frameHz` picks the video standard the score is baked for (driver.md §3.3):
// 60 for NTSC, 50 for PAL. It has to be given to the COMPILER, not the
// exporter — an `Nf` duration is already ticks by the time the IR exists.
// `seFile` gives the score the game's effects (withSeImport).
// `voiceHoist` is the compiler's pass (voice-hoist.js); the exporter's two
// VOICE_SET switches are `loopHoist` (driver.md §10.1) and `voiceRepeat` (§10.2).
/* A score file compiled as buildMmb compiles it (its imports, an effects
 * file folded in), with no MMB: { ir, diagnostics }. */
export function compileScoreFile(sourcePath, { frameHz, seFile, voiceHoist } = {}) {
  const src = withSeImport(sourcePath, readFileSync(sourcePath, "utf8"), seFile);
  const imports = readImportSources(sourcePath, src);
  return compileMMLisp(src, sourcePath, { frameHz, imports, voiceHoist });
}

export function buildMmb(sourcePath, { frameHz, seFile, multibank, voiceHoist, loopHoist, voiceRepeat } = {}) {
  const { ir, diagnostics } = compileScoreFile(sourcePath, { frameHz, seFile, voiceHoist });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    throw new Error(
      `compile failed: ${errors.map((e) => e.message).join("; ")}`,
    );
  }
  // PCM songs need the sample blobs (SAMPLE_BANK); load the WAVs the compiler
  // resolved. Non-PCM songs skip this entirely.
  const opts = { multibank, voiceHoist: loopHoist, voiceRepeat };
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

/* The score's sound effects (def-se), by number: [{name, prio}]. */
export function seListOf(ir) {
  const out = [];
  for (const t of ir.tracks ?? [])
    if (t.se && !out[t.se.index]) out[t.se.index] = { name: t.se.name, prio: t.se.prio };
  return out;
}

/* The C header a game takes the effects' numbers from — MMLisp_playSe(SE_JUMP).
 * A name is upper-cased with every other character an underscore. */
export function seHeader(list) {
  const lines = [
    "// Generated by MMLisp (tools/bundle.mjs, tools/install-sgdk.mjs) from the",
    "// score's def-se forms: the numbers MMLisp_playSe takes. Do not edit.",
    "#ifndef MMLISP_SE_H",
    "#define MMLISP_SE_H",
    `#define MMLISP_SE_COUNT ${list.length}`,
  ];
  const seen = new Map();
  list.forEach((e, i) => {
    const c = `SE_${e.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    if (seen.has(c)) throw new Error(`def-se ${seen.get(c)} and ${e.name} are both ${c} in C`);
    seen.set(c, e.name);
    lines.push(`#define ${c} ${i} // prio ${e.prio}`);
  });
  lines.push("#endif", "");
  return lines.join("\n");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: node mmb-build.mjs <in.mmlisp> <out.mmb>");
    process.exit(2);
  }
  const { bytes, sampleBank, diagnostics } = buildMmb(inPath, { multibank: process.argv.includes("--multibank") ? true : undefined, frameHz: process.argv.includes("--pal") ? 50 : undefined });
  writeFileSync(outPath, bytes);
  console.log(`${outPath}: ${bytes.length} bytes`);
  if (sampleBank && sampleBank.length) {
    // PCM blobs ride a separate sample bank now (docs/mmb.md §10), not in the .mmb.
    const smpPath = outPath.replace(/\.mmb$/, "") + ".smp";
    writeFileSync(smpPath, sampleBank);
    console.log(`${smpPath}: ${sampleBank.length} bytes (sample bank)`);
  }
  for (const d of diagnostics) console.warn(`  ${d.severity}: ${d.message}`);
}
