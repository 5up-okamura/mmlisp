// ONE resolved case (docs/dac-engine-implementation.md §12.3).
//
// The CLI can override the compensation, the boot calibration and inject a
// protocol fault. Every one of those changes what is generated, so the case
// object the run RECORDS has to be the one the run USED — otherwise a stored
// JSON names a configuration that never existed and the rom hash is the only
// honest field in it. resolveCase() applies the overrides once, derives what
// both CPUs have to agree on (the window period, the window length) from the
// same place, and returns the object everything downstream reads.
import { buildConfig } from "./config.mjs";
import { COOP, windowPeriodMaster, generateCooperative } from "./cooperative.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../../tools/z80asm.mjs";
import { buildRom } from "./rom.mjs";
import { sine } from "./cases.mjs";
import { generate } from "./gen-stream.mjs";
import { generateObserver } from "./observer.mjs";

export const FAULTS = {
  "drop-copy": "the 68000 transfers one byte fewer than it announced",
  "no-commit": "the 68000 never writes the local commit byte",
  "early-commit": "the commit is written BEFORE the payload, not after it",
  "late-request": "the request is delayed past the window it was computed for",
  "zero-divisor": "the 68000's foreground load divides by zero, which traps",
  "short-load": "the foreground load becomes nops, so it is no longer a long instruction",
  "no-load-marks": "the load loop stops stamping, so its time cannot be checked",
};

/**
 * @param c0    a case from the table
 * @param opts  {compensation, captureOffset, fault} — the CLI's overrides
 * @returns {case, cfg, gen, coop} with the case fully resolved
 */
export function resolveCase(c0, { compensation = null, captureOffset = null, fault = null } = {}) {
  if (fault && !FAULTS[fault]) throw new Error(`unknown fault ${fault}; one of ${Object.keys(FAULTS)}`);
  const cfg = buildConfig(c0.cfg);
  const coop = c0.cooperative
    ? { ...c0.cooperative, ...(compensation === null ? {} : { compensation }) } : null;
  let grab = c0.grab ? { ...c0.grab }
    : c0.bankOnly ? { cooperative: true, disabled: true }
    : c0.calibrate ? { calibrate: true, disabled: true }
    // An observer case has a display and a busy 68000. It has no transfer
    // protocol of its own; `stall` injects a plain, UNREPAID bus grab, which is
    // the disturbance the observer is supposed to notice.
    : c0.observer ? (c0.observer.stall
        ? { vdp: true, optimized: true, load: c0.observer.load,
            bootNops: c0.observer.bootNops, publish: c0.observer.publish,
            ...c0.observer.stall }
        : { vdp: true, disabled: true, load: c0.observer.load,
            loadProbe: c0.observer.loadProbe, bootNops: c0.observer.bootNops,
            publish: c0.observer.publish })
    : null;
  if (grab) {
    if (captureOffset !== null && grab.computed) grab.captureOffset = captureOffset;
    if (fault) grab.fault = fault;
    // Two ways to break the load CHECK rather than the load: make it short, or
    // stop it reporting. The gate has to fail on both (R6 §17.2 C).
    if (fault === "short-load" || fault === "no-load-marks") {
      if (!c0.observer?.loadProbe)
        throw new Error(`fault ${fault} only applies to a case that times its own load`);
      if (fault === "short-load") grab.load = "short";
      else grab.loadProbe = false;
    }
    // BOTH CPUs read the window period from the schedule that produces it.
    // The 68000's arithmetic used to carry its own copy of 26,880 while the
    // Z80's came from the slot table; they agreed only because slots was 5.
    if (grab.cooperative || grab.hint) {
      if (!coop) throw new Error("a cooperative or hint transfer needs a cooperative schedule");
      grab.windowPeriod = windowPeriodMaster(cfg, coop.slots);
      grab.windowCycles = COOP.windowCycles;
    }
  }
  if (c0.observer && coop) throw new Error("an observer case has no cooperative window");
  const c = { ...c0, cooperative: coop, grab: grab ?? undefined };
  const gen = c0.observer ? generateObserver(cfg, c0.observer)
    : coop ? generateCooperative(cfg, coop) : generate(cfg);
  return { case: c, cfg, gen, coop, grab };
}

/**
 * Everything a case turns into, deterministically: the generated Z80 source,
 * the assembled image, the cartridge and its hash.
 *
 * It lives here rather than in the runner so that a second tool can ask "what
 * rom would this case produce?" without running the suite, and so that the
 * answer cannot drift from what the runner actually built (R5 §15.2 C).
 *
 * @param outDir  where the .z80 and .bin are written
 */
export function buildCase(c0, { outDir, compensation = null, captureOffset = null,
  fault = null, marks = false } = {}) {
  const resolved = resolveCase(c0, { compensation, captureOffset, fault });
  const cfg = resolved.cfg;
  let c = resolved.case;
  if (marks && c.grab) c = { ...c, grab: { ...c.grab, marks: true } };
  const gen = resolved.gen;
  const caseId = createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 12);
  mkdirSync(outDir, { recursive: true });
  const zpath = join(outDir, `probe-${cfg.stamp}-${caseId}.z80`);
  writeFileSync(zpath, gen.text);
  const built = assemble(zpath);

  // P1 plays a waveform out of Z80 RAM, so it travels inside the image; P2
  // reads its voices through the 68k window, so they travel in the cartridge.
  let samples = null;
  let image = Uint8Array.from(built.bytes);
  if (cfg.voices) {
    samples = new Uint8Array(512);
    samples.set(sine(256, 120, 1), 0);
    samples.set(sine(256, 90, 3), 256);
  } else {
    // The image may reach past the waveform page — the decoder's table sits
    // above it — so the upload is as long as whichever is further.
    const end = Math.max(cfg.ram.wave[1], image.length);
    const grown = new Uint8Array(end);
    grown.set(image, 0);
    grown.set(c.wave, cfg.ram.wave[0]);
    image = grown;
  }
  if (!samples && c.grab) samples = Uint8Array.from({ length: 512 }, (_, i) => (i * 73 + 19) & 255);
  const { rom, sha } = buildRom(image, samples, c.grab ?? null);
  const rpath = join(outDir, `probe-${cfg.stamp}-${caseId}-${sha}.bin`);
  writeFileSync(rpath, rom);
  return { cfg, gen, grab: resolved.grab, resolved: c, caseId, image, samples, sha, rpath, zpath };
}
