// Do the committed artifacts describe the SAME engine images?
//
//   node tools/rate-mirrors.mjs
//
// 68k/mml_rate.h, sgdk/mmlispdrv_bin.h and live/src/engine-images.js are each
// generated, and an SGDK project links the first two while the exporter bakes
// sample banks from the third. If they drift apart the driver refuses its own
// sample bank at load, or plays it at the wrong pitch. Nothing in the build
// reads the committed copies, so this does, off the stamps each carries.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_IMAGES, ENGINE_IMAGES_PAL } from "../../live/src/engine-images.js";
import { pcmBankStamp } from "../../live/src/mmb.js";

const drv = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = [
  ["68k/mml_rate.h", "the 68k sequencer's bank check"],
  ["sgdk/mmlispdrv_bin.h", "the engine images an SGDK project links"],
].map(([rel, what]) => {
  const m = /RATE-STAMPS\s+(\d+)\s+(\d+)\s+(\d+)/.exec(readFileSync(join(drv, rel), "utf8"));
  return { rel, what, stamps: m ? m.slice(1).map(Number) : null };
});
rows.push({ rel: "live/src/engine-images.js", what: "what the exporter bakes at",
  stamps: [1, 2, 3].map((v) => pcmBankStamp(ENGINE_IMAGES[v].rateHz)) });

let bad = 0;
const first = rows[2].stamps;
for (const r of rows) {
  const ok = r.stamps && r.stamps.every((x, i) => x === first[i]);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${r.rel.padEnd(26)} ${r.stamps ? r.stamps.join(" / ") : "no RATE-STAMPS"} Hz — ${r.what}`);
}
// The PAL stamps: the same images on PAL's clock, which only the 68k checks.
const palM = /RATE-STAMPS-PAL\s+(\d+)\s+(\d+)\s+(\d+)/.exec(readFileSync(join(drv, "68k/mml_rate.h"), "utf8"));
const palWant = [1, 2, 3].map((v) => pcmBankStamp(ENGINE_IMAGES_PAL[v].rateHz));
const palOk = palM && palM.slice(1).every((x, i) => Number(x) === palWant[i]);
if (!palOk) bad++;
console.log(`${palOk ? "ok  " : "FAIL"}  ${"68k/mml_rate.h (PAL)".padEnd(26)} ${palM ? palM.slice(1).join(" / ") : "no RATE-STAMPS-PAL"} Hz — against ${palWant.join(" / ")}`);
if (bad) {
  console.log("\nFAIL: the committed artifacts describe different engine images. Regenerate:");
  console.log("    node tools/emit-images.mjs && node tools/gen-c-tables.mjs && node tools/emit-bin.mjs");
  process.exit(1);
}
console.log("\nthe mirrors agree");
