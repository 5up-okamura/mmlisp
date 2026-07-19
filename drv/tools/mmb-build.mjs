// Compile a .mmlisp source to an MMB v0.2 binary on disk, using the same
// live/src toolchain the browser uses. Usage:
//   node mmb-build.mjs <in.mmlisp> <out.mmb>
import { readFileSync, writeFileSync } from "node:fs";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";
import { loadSamplesForIr } from "./wav.mjs";

export function buildMmb(sourcePath) {
  const src = readFileSync(sourcePath, "utf8");
  const { ir, diagnostics } = compileMMLisp(src, sourcePath);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    throw new Error(
      `compile failed: ${errors.map((e) => e.message).join("; ")}`,
    );
  }
  // PCM songs need the sample blobs (SAMPLE_BANK); load the WAVs the compiler
  // resolved. Non-PCM songs skip this entirely.
  const opts = {};
  if ((ir.metadata?.samples ?? []).length) {
    opts.samples = loadSamplesForIr(ir);
  }
  const { bytes, sampleBank, diagnostics: exportDiags } = encodeMmb(ir, opts);
  return { bytes, sampleBank, diagnostics: [...diagnostics, ...exportDiags] };
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
