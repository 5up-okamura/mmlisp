import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./z80asm.mjs";
import { multibankConfig, generateMultibank } from "../engine/gen-multibank.mjs";

import { NTSC, PAL } from "../engine/config.mjs";
export function buildMultibankImage({ period = 354, fault = null, xpSteps, voices = 2, frameHz = 60 } = {}) {
  if (![50,60].includes(frameHz)) throw new RangeError("banked frame rate must be 50 or 60");
  xpSteps ??= voices === 1 ? (frameHz === 50 ? 48 : 55) : 15;
  const cfg = multibankConfig(period, xpSteps, voices, frameHz === 50 ? PAL : NTSC), gen = generateMultibank(cfg);
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
