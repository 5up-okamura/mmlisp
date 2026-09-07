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
import { generate } from "./gen-stream.mjs";
import { generateObserver } from "./observer.mjs";

export const FAULTS = {
  "drop-copy": "the 68000 transfers one byte fewer than it announced",
  "no-commit": "the 68000 never writes the local commit byte",
  "early-commit": "the commit is written BEFORE the payload, not after it",
  "late-request": "the request is delayed past the window it was computed for",
  "zero-divisor": "the 68000's foreground load divides by zero, which traps",
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
            bootNops: c0.observer.bootNops, ...c0.observer.stall }
        : { vdp: true, disabled: true, load: c0.observer.load,
            loadProbe: c0.observer.loadProbe, bootNops: c0.observer.bootNops })
    : null;
  if (grab) {
    if (captureOffset !== null && grab.computed) grab.captureOffset = captureOffset;
    if (fault) grab.fault = fault;
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
