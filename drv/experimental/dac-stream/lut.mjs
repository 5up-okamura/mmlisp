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
// LEVELS ARE NOT SHIFTS. Evenly spaced levels of k/(n-1) with round-half-away-
// from-zero, not eight octaves of `sra`: §3.4 says not to narrow the fade range
// into a bit shift. The top level is bit-exact unity, which matters because
// most of the time nothing is being faded at all, and level 0 is silence.
//
// HOW MANY LEVELS IS A PROFILE'S CHOICE (R8 §23.2). The shipped one is 16, and
// 16 pages is 4 KB of an 8 KB machine. The experimental 15-level profile exists
// because the phase observer needs a page-aligned 256 B table and there is no
// free page anywhere else in the complete 2ch map (§21.4): 15 levels are 3,840 B
// and the page that comes free is the table's. What that costs is one step of
// volume resolution, and the two profiles are different builds — the default is
// NOT changed and a score's meaning under 16 levels is not reinterpreted.
export const LEVELS = 16;

export const unbias = (b) => (b & 0xff) - 128;
export const bias = (s) => (s + 128) & 0xff;

/**
 * The signed value a level maps a signed sample to. The ONE definition, for
 * every profile: level k of n scales by k/(n-1), so 0 is silence and n-1 is
 * unity whatever n is. The 15-level profile is k/14 — it is NOT the 16-level
 * table with a page removed and the numbers shifted, which would move every
 * level's meaning by a different amount and leave unity in the wrong place.
 */
export const scale = (s, level, levels = LEVELS) => {
  const v = (s * level) / (levels - 1);
  const r = v < 0 ? -Math.round(-v) : Math.round(v);
  return Math.max(-128, Math.min(127, r));
};

/**
 * A level a score or a command carries, on the 0..15 scale the language uses,
 * onto this profile's 0..levels-1 (R8 §23.2: the rule has to be written down).
 *
 * round(v * (n-1) / 15). It is the identity at 16 levels; at 15 it keeps
 * silence at silence and unity at unity, stays monotone, and — this is the
 * cost, stated rather than discovered — is not injective: commands 7 and 8 both
 * land on level 7. Every other command has a level of its own.
 *
 *   command  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15
 *   level    0  1  2  3  4  5  6  7  7  8  9 10 11 12 13 14
 */
export const levelFromCommand = (v, levels = LEVELS) =>
  Math.round((v * (levels - 1)) / 15);

/** `levels` pages of 256 bytes, biased in and biased out. Page = level. */
export function buildLut(levels = LEVELS) {
  const out = new Uint8Array(levels * 256);
  for (let level = 0; level < levels; level++)
    for (let b = 0; b < 256; b++) out[level * 256 + b] = bias(scale(unbias(b), level, levels));
  return out;
}

/**
 * The pages a level index may name, from the RAM map. The mixer's page number
 * is a SELF-MODIFIED operand — the host writes it and the block edge stores it
 * into `mix_v0+1` — so a number outside this range does not fault, it silently
 * reads whatever else is at that address as a volume table. In the 15-level
 * profile the page immediately after the family is the phase table, which is
 * exactly the accident worth checking for (R8 §23.2).
 */
export const lutPages = (cfg) => ({
  first: cfg.ram.lut[0] >> 8,
  last: (cfg.ram.lut[1] >> 8) - 1,
  levels: (cfg.ram.lut[1] - cfg.ram.lut[0]) >> 8,
});
export function pageIsALevel(cfg, page) {
  const { first, last } = lutPages(cfg);
  return page >= first && page <= last;
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
//
// IT DOES NOT READ THE TABLES. §3.4 (R1): "参照計算は生成済みLUT・飽和表を
// 読まず、定義した算術から期待値を求める". A reference that indexes the same
// arrays the image was built from cannot fail on a table that is wrong — the
// two share the error and agree. So the expectation is computed from `scale`
// and `satAdd` directly, and the tables are checked against the SAME
// arithmetic separately (`tablesAgree`), which is a different assertion with a
// different failure mode.
const satAdd = (a, b) => Math.max(-128, Math.min(127, a + b));

/** One voice: source byte -> voice level -> master. Biased in, biased out. */
export const mixOne = (src, vel, master, levels = LEVELS) =>
  bias(scale(scale(unbias(src), vel, levels), master, levels));

/**
 * Two voices: scale each, saturate the sum, then master — in that order.
 * The order is the definition, not an implementation detail: it is where the
 * rounding happens, and the 15-level profile keeps it exactly (R8 §23.2).
 */
export const mixTwo = (src0, vel0, src1, vel1, master, levels = LEVELS) =>
  bias(scale(satAdd(scale(unbias(src0), vel0, levels), scale(unbias(src1), vel1, levels)),
    master, levels));

/** What a silent ring holds, and what the DAC gets when nothing is playing. */
export const SILENCE = bias(0);

/**
 * Do the GENERATED tables implement the same arithmetic? Reported separately
 * from the value gate, because "the image's tables are wrong" and "the mixer
 * used them wrongly" are different faults and a single comparison cannot tell
 * them apart.
 */
export function tablesAgree(levels = LEVELS) {
  const lut = buildLut(levels);
  const clamp = buildClamp();
  const problems = [];
  if (lut.length !== levels * 256) problems.push(`the level family is ${lut.length} B, not ${levels * 256}`);
  for (let level = 0; level < levels && problems.length < 4; level++)
    for (let b = 0; b < 256; b++) {
      const want = bias(scale(unbias(b), level, levels));
      if (lut[level * 256 + b] !== want) {
        problems.push(`LUT[${level}][${b}] = ${lut[level * 256 + b]}, the arithmetic says ${want}`);
        break;
      }
    }
  // Silence and unity are the two levels a score relies on being exact.
  for (let b = 0; b < 256; b++) {
    if (lut[b] !== SILENCE) { problems.push(`level 0 is not silence at ${b}`); break; }
    if (lut[(levels - 1) * 256 + b] !== b) { problems.push(`level ${levels - 1} is not unity at ${b}`); break; }
  }
  for (let i = 0; i < CLAMP_SIZE && problems.length < 6; i++) {
    // The index is the sum of two biased bytes, so its signed value is i - 256
    // and both halves of that are already clamped to [-128, 127].
    const want = bias(Math.max(-128, Math.min(127, i - 256)));
    if (clamp[i] !== want) problems.push(`CLAMP[${i}] = ${clamp[i]}, the arithmetic says ${want}`);
  }
  return problems;
}
