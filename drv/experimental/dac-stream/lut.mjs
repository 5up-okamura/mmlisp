// The tables, and the arithmetic the JS reference and the Z80 share
// (docs/dac-engine-implementation.md §3.4: "既存の`:vel`・`:vol`・`:master`の
// 合成方法と無音時の再生位置継続は、JS参照実装と対応表を作って固定する").
//
// EVERYTHING IS BIASED-UNSIGNED, end to end: the source byte, every table's
// input and output, the ring, and what the DAC is handed. Nothing converts
// domains anywhere in the hot path — the conversion is baked into the tables.
// That is worth 21 cycles a sample against the same code with `xor $80` at the
// three places it would otherwise be needed, and 21 cycles is 6% of the period.
//
// ONE FAMILY SERVES BOTH the per-voice level and the master, because both are
// the same operation — scale by k/15, clamp — and a second family is another
// 4 KB of an 8 KB machine. The composition is two lookups in series, in the
// order the reference states: voice level first, master second. Folding them
// into one index would change where the rounding happens (§3.4 says so
// explicitly), and the "vel and master, opposed" gate case is what would catch
// it.
//
// LEVELS ARE NOT SHIFTS. 16 evenly spaced levels of k/15 with round-half-away-
// from-zero, not eight octaves of `sra`: §3.4 says not to narrow the fade range
// into a bit shift. Level 15 is bit-exact unity, which matters because most of
// the time nothing is being faded at all.
export const LEVELS = 16;

export const unbias = (b) => (b & 0xff) - 128;
export const bias = (s) => (s + 128) & 0xff;

/** The signed value a level maps a signed sample to. The ONE definition. */
export const scale = (s, level) => {
  const v = (s * level) / (LEVELS - 1);
  const r = v < 0 ? -Math.round(-v) : Math.round(v);
  return Math.max(-128, Math.min(127, r));
};

/** 16 pages of 256 bytes, biased in and biased out. Page = level. */
export function buildLut() {
  const out = new Uint8Array(LEVELS * 256);
  for (let level = 0; level < LEVELS; level++)
    for (let b = 0; b < 256; b++) out[level * 256 + b] = bias(scale(unbias(b), level));
  return out;
}

/**
 * The saturating add, as a table rather than a branch.
 *
 * Two biased contributions added with `add a,(hl)` make a 9-bit unsigned sum in
 * (carry, A) whose signed value is `sum - 256`. This table saturates it and
 * hands back a biased byte, in five instructions and no jump — which is what
 * lets a slot's work be CONSTANT TIME. The branch-and-fix form is 10 cycles on
 * the common path and 35 on the rare one, and in a cycle-placed schedule the
 * difference has to be padded away on every single sample anyway, so the
 * branch buys nothing and costs a page and a half of nothing.
 */
export const CLAMP_SIZE = 512;
export function buildClamp() {
  const out = new Uint8Array(CLAMP_SIZE);
  for (let i = 0; i < CLAMP_SIZE; i++)
    out[i] = bias(Math.max(-128, Math.min(127, i - 256)));
  return out;
}

// ── The reference, in JS ───────────────────────────────────────────────────
const LUT = buildLut();
const CLAMP = buildClamp();
const lut = (level, b) => LUT[level * 256 + (b & 0xff)];

/** One voice: source byte -> voice level -> master. */
export const mixOne = (src, vel, master) => lut(master, lut(vel, src));

/** Two voices, mixed exactly as the Z80 does: add, clamp, then master. */
export const mixTwo = (src0, vel0, src1, vel1, master) =>
  lut(master, CLAMP[lut(vel0, src0) + lut(vel1, src1)]);

/** What a silent ring holds, and what the DAC gets when nothing is playing. */
export const SILENCE = bias(0);
