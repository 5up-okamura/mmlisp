// The tables, and the arithmetic the JS reference and the Z80 share. The
// requirement: pin how the existing `:vel` / `:vol` / `:master` compose, and
// how a silent voice keeps its playback position, by building the table against
// the JS reference rather than by agreeing in prose (docs/driver.md §6.3, §7).
//
// A SOURCE BYTE IS SIGNED — that is what the sample bank holds (mmb.md §10) —
// and every table gives back a BIASED-UNSIGNED byte: the ring, the saturating
// add's operands and what the DAC is handed are all biased. The conversion is
// baked into the tables, so nothing in the hot path converts domains, and that
// is worth 21 cycles a sample against the same code with `xor $80` at the three
// places it would otherwise be needed — 6% of the period.
export const unbias = (b) => (b & 0xff) - 128;
export const bias = (s) => (s + 128) & 0xff;
/** The signed value of a SOURCE byte, in either convention (R28 step 4). */
export const sourceValue = (b, signed = false) => (signed ? ((b & 0xff) << 24) >> 24 : unbias(b));

/**
 * The pages a rung index may name, from the RAM map. The mixer's page number
 * is a SELF-MODIFIED operand — the host writes it and the block edge stores it
 * into `mix_v0+1` — so a number outside this range does not fault, it silently
 * reads whatever else is at that address as a volume table. The page
 * immediately after the family is the phase table, which is exactly the
 * accident worth checking for.
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

/** What a silent ring holds, and what the DAC gets when nothing is playing. */
export const SILENCE = bias(0);

// ── THE RUNG PAGES (plan-pcm-spec.md D4, the N-voice profile) ──────────────
//
// Eight pages, SIGNED IN and BIASED OUT: page 0 is silence, page 7 - r is the
// 6 dB rung r = 0..6 (unity .. -36 dB). A rung is the reference's arithmetic
// shift — `s >> r`, toward minus infinity, exactly what an `sra` chain does —
// so the tables are the shift model made constant-time, not a new curve. The
// output is biased because what follows is either the ring (one voice) or the
// saturating add of biased terms (two or three).
export const RUNG_PAGES = 8;
/** The signed value page `p` makes of signed sample `s`. */
export const rung = (s, page) => (page <= 0 ? 0 : s >> (RUNG_PAGES - 1 - page));
export function buildRungs() {
  const out = new Uint8Array(RUNG_PAGES * 256);
  for (let p = 0; p < RUNG_PAGES; p++)
    for (let b = 0; b < 256; b++) out[p * 256 + b] = bias(rung(sourceValue(b, true), p));
  return out;
}
