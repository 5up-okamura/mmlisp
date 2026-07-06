// Compile a .mmlisp source to an MMB v0.2 binary on disk, using the same
// live/src toolchain the browser uses. Usage:
//   node mmb-build.mjs <in.mmlisp> <out.mmb>
import { readFileSync, writeFileSync } from "node:fs";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";

export function buildMmb(sourcePath) {
  const src = readFileSync(sourcePath, "utf8");
  const { ir, diagnostics } = compileMMLisp(src, sourcePath);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    throw new Error(
      `compile failed: ${errors.map((e) => e.message).join("; ")}`,
    );
  }
  const { bytes, diagnostics: exportDiags } = encodeMmb(ir);
  return { bytes, diagnostics: [...diagnostics, ...exportDiags] };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: node mmb-build.mjs <in.mmlisp> <out.mmb>");
    process.exit(2);
  }
  const { bytes, diagnostics } = buildMmb(inPath);
  writeFileSync(outPath, bytes);
  console.log(`${outPath}: ${bytes.length} bytes`);
  for (const d of diagnostics) console.warn(`  ${d.severity}: ${d.message}`);
}
