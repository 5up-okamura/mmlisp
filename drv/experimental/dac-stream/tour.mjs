// THE LISTENING TOUR (docs/dac-engine-implementation.md §46.4).
//
// A fixed timeline the complete engine plays, so that what the four limits, the
// corrector and the mailbox add up to can be put in front of an ear instead of
// read off a table. It is the SAME image the gates measure — the 2ch 15-level
// engine with the corrector, the runtime protocol and the one-slot mailbox —
// driven by a 68000 host whose desired state comes from a section table rather
// than from a rolling walk.
//
// Every section is 128 iterations of the host's loop. One iteration is one
// read and one publish attempt, and the generated transfer period puts them
// 438,762 master apart, so a section is 128 * 2 * 438,762 = 2.093 s.
//
// The mode byte is a set of bits, so a section can be two things at once:
export const MODE = {
  idle: 1,      // no transfer at all — what the DAC sounds like left alone
  dense: 2,     // the waits halved: two transfers inside one observation
  v0: 4,        // voice 0's level follows the triangle
  m: 8,         // …the master's does
  fast: 16,     // the triangle steps every iteration instead of every 32
  v1: 32,       // …voice 1's follows it too
};

/** 0..14..0 over 32 steps — what the host's triangle produces. */
export const triangle = (n) => {
  const u = n & 31;
  return Math.min(14, u < 16 ? u : 31 - u);
};

// v0, v1, m, mode, how many sections, and what it is for. Where a mode bit says
// the triangle drives a page, the level written here is the one the section
// STARTS from and the triangle takes over from the second iteration.
export const TOUR = [
  { v0: 14, v1: 0, m: 14, mode: 0, n: 1, what: "voice 0 alone, at full level" },
  { v0: 0, v1: 14, m: 14, mode: 0, n: 1, what: "voice 1 alone, at full level" },
  { v0: 7, v1: 7, m: 14, mode: 0, n: 1, what: "both voices, an ordinary sum" },
  { v0: 14, v1: 14, m: 14, mode: 0, n: 1, what: "both at full: the clamp, on purpose" },
  { v0: 0, v1: 0, m: 14, mode: MODE.v0, n: 4,
    what: "voice 0 through all fifteen levels, up and then down, half a second a step" },
  { v0: 14, v1: 14, m: 0, mode: MODE.m, n: 4,
    what: "the same fade on the master, with both voices held at full" },
  { v0: 0, v1: 0, m: 14, mode: MODE.v0 | MODE.v1 | MODE.fast, n: 2,
    what: "a different desired state every publication — 61 updates a second" },
  { v0: 7, v1: 7, m: 14, mode: 0, n: 1, what: "back to the ordinary sum, and held" },
  { v0: 7, v1: 7, m: 14, mode: MODE.idle, n: 2,
    what: "the same material with NO transfer at all: the 68000 never takes the bus" },
  { v0: 7, v1: 7, m: 14, mode: 0, n: 2,
    what: "the same material at the representative density: one transfer an observation" },
  { v0: 7, v1: 7, m: 14, mode: MODE.dense, n: 2,
    what: "the same material at twice it: two transfers inside one observation, which is"
      + " over the 1,500 master live contract and is meant to be heard as such" },
];

/**
 * The table as the 68000 reads it: four bytes a section, repeated `n` times.
 *
 * The levels above are 0..14; the mixer wants an absolute Z80 PAGE, and the
 * level family does not start at page 0 — in the 15-level profile it is
 * $0C00..$1B00, so page 12 is silence and page 26 is unity. `base` is that
 * first page, and staging a level without it stages the code region as a
 * volume table (R8 §23.2's `pageIsALevel`).
 */
export const tourBytes = (base) =>
  TOUR.flatMap((s) => Array.from({ length: s.n },
    () => [base + s.v0, base + s.v1, base + s.m, s.mode]));

export const TOUR_SECTIONS = () => tourBytes().length;
