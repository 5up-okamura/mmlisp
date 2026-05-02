/**
 * Macro target range table.
 *
 * Used by the compiler (parseMacroSpec / step-vector parsing) and the player
 * (_scheduleMacro write path) to clamp and round macro output values.
 *
 * integer: true  — Math.round then clamp (used for all hardware registers and
 *                  snap-to-integer targets like :pan, :mode)
 * integer: false — clamp only, preserve fractional value (e.g. NOTE_PITCH in cents)
 *
 * Targets with a numeric suffix (FM_TL1–FM_TL4 etc.) fall back to the
 * suffix-stripped key via clampForTarget().
 */
export const MACRO_TARGET_RANGE = {
  // KEY-ON scoped
  NOTE_PITCH: { min: -32768, max: 32767, integer: false },
  VEL: { min: 0, max: 15, integer: true },

  // Channel-level
  VOL: { min: 0, max: 31, integer: true },
  MASTER: { min: 0, max: 31, integer: true },

  // LFO
  LFO_RATE: { min: 0, max: 8, integer: true },

  // FM channel params
  FM_ALG: { min: 0, max: 7, integer: true },
  FM_FB: { min: 0, max: 7, integer: true },
  FM_AMS: { min: 0, max: 3, integer: true },
  FM_FMS: { min: 0, max: 7, integer: true },

  // FM operator params — shared by FM_TL1–FM_TL4, FM_AR1–FM_AR4, etc.
  // clampForTarget() strips the trailing digit before lookup.
  FM_TL: { min: 0, max: 127, integer: true },
  FM_AR: { min: 0, max: 31, integer: true },
  FM_DR: { min: 0, max: 31, integer: true },
  FM_SR: { min: 0, max: 31, integer: true },
  FM_RR: { min: 0, max: 15, integer: true },
  FM_SL: { min: 0, max: 15, integer: true },
  FM_ML: { min: 0, max: 15, integer: true },
  FM_DT: { min: 0, max: 7, integer: true },
  FM_KS: { min: 0, max: 3, integer: true },
  FM_AMEN: { min: 0, max: 1, integer: true },
  FM_SSG: { min: 0, max: 15, integer: true },

  // FM panning — bits 7-6 of B4
  PAN: { min: -1, max: 1, integer: true },

  // PSG noise mode (0-7 via `:mode` keyword on noise channel)
  NOISE_MODE: { min: 0, max: 7, integer: true },
};

/**
 * Clamp a macro output value to the hardware range for the given target.
 * For integer targets, rounds before clamping.
 * For targets with a numeric suffix (e.g. "FM_TL1"), strips the suffix and
 * looks up the base key (e.g. "FM_TL").
 * Returns v unchanged if no range entry is found.
 *
 * @param {string} target  - canonical target name (e.g. "FM_TL1", "VEL", "PAN")
 * @param {number} v       - raw value from macro interpolation
 * @returns {number}
 */
export function clampForTarget(target, v) {
  const range =
    MACRO_TARGET_RANGE[target] ??
    MACRO_TARGET_RANGE[target.replace(/\d+$/, "")];
  if (!range) return v;
  const val = range.integer ? Math.round(v) : v;
  return Math.max(range.min, Math.min(range.max, val));
}
