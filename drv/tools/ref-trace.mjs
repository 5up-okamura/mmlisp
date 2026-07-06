// Capture the JS reference driver's register-write log for an MMB binary.
// This is the normative trace the Z80 build must reproduce (driver.md §12.4).
// Usage:
//   node ref-trace.mjs <song.mmb> [out.json] [--max-frames N]
import { readFileSync, writeFileSync } from "node:fs";
import { DrvPlayer } from "../../live/src/drv-player.js";

export function refTrace(mmbBytes, { maxFrames = 36000 } = {}) {
  const drv = new DrvPlayer();
  drv.loadMMB(mmbBytes);
  const cap = drv.captureRegisterLog({ maxFrames });
  return {
    frames: cap.frames,
    ended: cap.ended,
    writes: cap.writes,
    diagnostics: cap.diagnostics,
    skippedOpcodes: cap.skippedOpcodes,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const mfIdx = args.indexOf("--max-frames");
  const maxFrames = mfIdx >= 0 ? Number(args.splice(mfIdx, 2)[1]) : 36000;
  const [inPath, outPath] = args;
  if (!inPath) {
    console.error("usage: node ref-trace.mjs <song.mmb> [out.json] [--max-frames N]");
    process.exit(2);
  }
  const trace = refTrace(new Uint8Array(readFileSync(inPath)), { maxFrames });
  const json = JSON.stringify(trace);
  if (outPath) {
    writeFileSync(outPath, json);
    console.log(
      `${outPath}: ${trace.writes.length} writes over ${trace.frames} frames` +
        ` (ended=${trace.ended})`,
    );
  } else {
    console.log(json);
  }
}
