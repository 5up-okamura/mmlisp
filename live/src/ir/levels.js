// The level model every voice shares: :vel, :vol and the master as signed
// dB offsets, summed, then taken to a chip's steps at the write.

// ---------------------------------------------------------------------------
// Unified level model — additive dB offsets
// ---------------------------------------------------------------------------
// vel / vol / master each map to a signed dB offset; the offsets are summed (in
// float) on top of an operator's voiced TL, and quantized once at the register
// write. This is the PMD/MDSDRV table style, and the 68000 sequencer composes
// the same way (driver.md §7). The helpers below return register-step
// offsets — dB ÷ the part's step (chips/parts.js `level`: an FM chip's TL
// 0.75 dB, the SN76489's attenuator 2, the SSG's 3) — as floats.
//
// Velocity ladder (PMD / MDSDRV coarse-volume convention):
export const VEL_DB_PER_STEP = 2;
// The driver holds a live velocity in eighths of a step (0..15·8): a :vel
// macro is computed, so it moves finer than the 16-step ladder, and composes
// down to the chip's own resolution (FM TL 0.75 dB) — rounded once, at the
// register (driver.md §7). An authored :vel is a whole step (×8).
export const VEL_FINE = 8;
export const VEL_FINE_MAX = 15 * VEL_FINE;

/** A velocity as the driver holds it: 0..15 on the 1/VEL_FINE grid. */
export function velFine(v) {
  const q = Math.round(Number(v) * VEL_FINE) / VEL_FINE;
  return q < 0 ? 0 : q > 15 ? 15 : q;
}

/**
 * Sum level offsets (steps) the way the driver does: each held in quarter
 * steps, the sum rounded once (half away from zero, via an arithmetic shift).
 */
export function sumLevelOffsets(...offs) {
  let off4 = 0;
  for (const o of offs) off4 += Math.round(o * 4);
  return (off4 + (off4 >= 0 ? 2 : -2)) >> 2;
}
// An operator's velocity sensitivity (language.md §6, `:vel1`–`:vel4`), in
// sixteenths: 16 takes the note's whole velocity offset, 0 none of it.
// VEL_K_AUTO, what a voice that does not set it carries, is the role's own:
// 16 on a carrier (and on every operator in CH3's special mode), 0 on a
// modulator — the level model every voice had before the key existed.
export const VEL_K_UNITY = 16;
export const VEL_K_AUTO = -1;
export function velK(k, carrier) {
  return k >= 0 && k <= VEL_K_UNITY ? k : carrier ? VEL_K_UNITY : 0;
}

/**
 * sumLevelOffsets with the velocity offset scaled by `k` sixteenths, the
 * others whole — held in 64ths of a step and rounded once, as the driver does.
 * At k = 16 it is sumLevelOffsets exactly.
 */
export function sumLevelOffsetsK(velOff, k, ...offs) {
  if (k === VEL_K_UNITY) return sumLevelOffsets(velOff, ...offs);
  let off64 = Math.round(velOff * 4) * k;
  for (const o of offs) off64 += Math.round(o * 4) * VEL_K_UNITY;
  return (off64 + (off64 >= 0 ? 32 : -32)) >> 6;
}

// vol/master mixer-fader (tunable): VOL_UNITY = 0 dB reference on the 0–31
// scale. Unity sits at the top (31 = full, no attenuation), so vol/master is a
// pure attenuator — lower values cut, matching the master fader.
export const VOL_STEP_DB = 2;
export const VOL_UNITY = 31;

// Velocity (0-15) → attenuation in register steps of `stepDb` (a part's
// `level.stepDb`; float). 2 dB/step ladder: vel 15 = 0 (patch level), vel 0
// ≈ -30 dB floor. Attenuation only — never mutes (silence is a rest, or
// vol/master 0). Caller rounds once.
export function velSteps(vel, stepDb) {
  const v = Math.max(0, Math.min(15, vel));
  return ((15 - v) * VEL_DB_PER_STEP) / stepDb;
}

// A fader — vol, master, a mixer strip (0-31) — → its offset in register
// steps of `stepDb` (float). VOL_UNITY is 0 dB; 0 is a hard mute handled by
// the caller (this curve does not reach silence).
export function faderSteps(v, stepDb) {
  const x = Math.max(0, Math.min(31, v));
  return ((VOL_UNITY - x) * VOL_STEP_DB) / stepDb;
}

/**
 * The one level composition (language.md §6), for a part whose `level` is a
 * dB ladder (chips/parts.js): vel scaled by `k` sixteenths, plus each fader,
 * in the part's steps, summed as the driver does and rounded once. Unclamped:
 * levelSteps puts it on the register.
 */
export function levelOffset(level, { vel = 15, faders = [], k = VEL_K_UNITY }) {
  const step = level.stepDb;
  return sumLevelOffsetsK(velSteps(velFine(vel), step), k, ...faders.map((f) => faderSteps(f, step)));
}

/** levelOffset on top of `base` (an FM operator's voiced TL), as the register: 0 loud .. steps − 1. */
export function levelSteps(level, { base = 0, ...terms }) {
  return Math.max(0, Math.min(level.steps - 1, Math.round(base) + levelOffset(level, terms)));
}

/**
 * The same composition for a part whose level is linear (`level.scale:
 * "linear"` — the ADPCM-B, PCM8, a mixer's gain): a gain 0..1, 0 when a
 * fader is at 0 (the hard mute).
 */
export function levelGain({ vel = 15, faders = [] }) {
  if (faders.some((f) => f <= 0)) return 0;
  let db = (15 - velFine(vel)) * VEL_DB_PER_STEP;
  for (const f of faders) db += (VOL_UNITY - Math.min(31, f)) * VOL_STEP_DB;
  return 10 ** (-db / 20);
}
