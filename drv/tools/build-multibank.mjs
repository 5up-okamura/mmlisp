import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./z80asm.mjs";
import { multibankConfig, generateMultibank } from "../engine/gen-multibank.mjs";

export function buildMultibankImage({ period = 354, fault = null, xpSteps = 15, voices = 2 } = {}) {
  const cfg = multibankConfig(period, xpSteps, voices), gen = generateMultibank(cfg);
  let source = gen.text;
  if (fault === "timing") source = source.replace("slot0:\n", "slot0:\nnop\n");
  else if (fault) throw new Error(`unknown multibank image fault ${fault}`);
  const dir = mkdtempSync(join(tmpdir(), "mmlisp-multibank-"));
  try {
    const path = join(dir, "engine.z80");
    writeFileSync(path, source);
    const built = assemble(path);
    return { cfg, gen, bytes: Uint8Array.from(built.bytes), symbols: built.symbols };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
