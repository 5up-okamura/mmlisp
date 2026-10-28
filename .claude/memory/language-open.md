# The language and IR — the user's rulings and the reasons behind them

`docs/language.md` is the spec and the guide teaches it; this file keeps only
what a developer needs and no reader of the docs does: rulings not to
re-propose, and why the value machine is shaped as it is. A language question
waiting on the user goes in §1 until it is decided and built.

## 1. Rulings — do not re-propose

The rule behind the 2026-09-26 syntax audit: `:key value` is a sticky
parameter, `(form …)` an event or control, `#name` a position; an operator
suffix combines with the target's base (language.md §7.0).

- **No CALL/RET in the language** — naming is a source convenience, sharing is
  the encoder's job (MACRO_TABLE / VOICE_TABLE dedup, the CALL/RET pass).
- **Counted `(go label N)` stays** — flat, cross-form counted loops are wanted
  beyond the mucom import; its post-merge rewrite is the feature's own cost.
- **Holds keep both `:len 0`** (the track waits for the host) **and `:gate 0`**
  (it does not) — two features.
- **The short relative forms `>` `<` `o±N` `v±N` stay** (no free symbol pair
  for velocity).
- **`:wait` and `(wait …)` both stay** (a curve's own start delay vs a stage);
  so do **`:csm-rate` and the `fm3-csm-rate` track** (different use and range).
- **`(glide …)` stays a form** (two arities); gate is §7.0's documented
  exception.
- **PSG envelopes are macros, not a new def head** (2026-10-03): an envelope
  is already `(def name (macro …))`, and the only need was tooling, so the
  voice picker lists macro defs. Naming a head was hard because the thing was
  not a new concept.
- **No second sigil (`@vel`)** — more syntax for the same semantics; the `$`
  namespace carries every tier, kept apart by reserved-name checks.
- **`for` binds numbers only, with `let`'s vector** (2026-10-19). No `:step`
  (it broke the `[name value …]` pairing; a step is arithmetic in the body),
  range ends literal integers, and no note names in a value list — the user
  accepted writing chords as MIDI offsets from a `let` root to keep one
  mechanism (a value, emitted by `(note …)`) and the no-implicit-note→number
  rule. If that proves awkward, the next step is a `for` over tokens (a
  parameterized `def`, close to the roadmap's def-functions), not an
  exception in the evaluator.
- **Comparisons are `=` `<` `>` `<=` `>=`, giving 1/0** (2026-10-19). The
  user chose the Clojure names over word names (`lt` …) although `<` `>` are
  also the octave shifts: a list head is never a note-stream token, so the
  two never meet. No boolean type — a comparison is a number, and `if` takes
  any non-zero as true. Reserving `mod` cost a gate fixture its `def-fm mod`
  (now `modv`); a score naming a voice `mod` gets `E_DEF_RESERVED`.
- **Macro-curve `$slot` params stay baked on MMB** (2026-10-20, considered and
  shelved). Making a macro curve's `:from`/`:to`/`:rate`/`:len` slot-fed on the
  driver needs a second blob form (a normalized shape + offset/scale per
  descriptor, i16 for pitch), the player moved to the same integer math for
  A/B, and per-region descriptors for multi-stage — cost in representation,
  not cycles. What a score needs is already writable: a live depth is the
  scaled macro `(* signal $slot)`, a live centre is a slot-relative param
  (`:tl1+ $x`), and the gap is visible as `W_MMB_DYN_BAKED`. Not per-frame
  either: a macro reading `:to $x` every frame while an inline sweep reads it
  once would make one curve mean two things. A two-slot `:from $a :to $b`
  is the scratch-slot problem (§7.1.2). Reopen only when a real score needs a
  centre that follows the game every frame — then as an offset slot on the
  scaled-macro mechanism (`offset + (shape × scale) >> 8`), not as live
  endpoints.
- **PCM levels stay on the 6 dB shift ladder** (2026-10-21). A 3 dB step in
  the Z80 mixer or level-baked copies were weighed; the user finds 6 dB
  enough for drums. Do not re-propose finer PCM levels.
- **No effect (def-se) on CH3** stays (2026-10-21). An effect over the
  independent-operator or CSM mode would have to save and restore what the
  frequency registers mean, not just their values; a "normal mode only"
  exception is writable but adds a conditional rule. Wanted, but not at that
  price.

## 1.1 Open

- A diagnostic inside a def repeats once per expansion, at the one source
  position: `(for [i 0..15] (rnd …))` logs the same curve error 16 times.
  Deduping identical (code, line, column) in `pushDiag` is the fix, but
  diagnostics are part of check:snapshot's baseline for 249 scores.

## 2. Why the value machine has this shape

Compile-time eval was designed twice; the second round reversed two of the
first round's decisions, and those reasons are what will be argued again:

- **Grow the driver rather than shrink the preview.** Round 1 cut the JS
  player's read-modify-write reads down to what the Z80 could read; round 2
  gave the driver a generic shadow read, derived from the write-descriptor
  table, so every FM operator param is readable. `live ≡ hardware` is reached
  upward, not downward.
- **The lowering table is open.** Round 1 allowed `$`-bearing expressions only
  from a small closed table; with the target param itself as the accumulator,
  any left-linear expression over constants and `$slot`s lowers to existing
  opcode chains, with zero new opcodes.

**The governing constraint:** the driver gains no evaluator — only readers and
flags. The user restated it as the direction for the language's growth
(2026-10-19): Live is the composing environment, so the compile-time
evaluator may grow (`for` and `if` landed; recursive def-functions are the
roadmap's next) while the driver's dynamic side stays minimal — an `if` on a `$` value
is an error, never a runtime branch. A `$slot` is a value kind of the evaluator itself (mmlisp-eval.js
`Runtime`, the opcode chain kept symbolic like a signal), so the accumulator
lowering and the scaled macro `(* signal $slot)` are its arithmetic, with no
separate linearizer or pattern detector in mmlisp2ir.

The vision it serves: `def-val` slots are the score's input ports, expressions
the wiring, the sampling tiers the rates — the game writes variables, the
score declares how the music responds.

## 3. A known A/B divergence

An override looping curve on a pitch macro skews the ir↔drv A/B by ±8 in the
F-number at note boundaries, proven scale-independent.

## 4. Shuffle as a grid warp — decided 2026-10-28 (plan A), not built

**Why.** A Furnace / DefleMask swing is two speeds alternating a row at a
time: the *grid* stretches, whatever the notes' lengths. `:shuffle` today
(`resolveShuffleTicks` in mmlisp2ir.js) swings only a note or rest whose
nominal length equals `:shuffle-base`, flipping `subBeatParity` per swung
item; any other length plays straight, so an odd number of base units (a
dotted eighth on a 16th base) flips every pair after it. Measured with
`:shuffle 70 :shuffle-base 16 :len 16` (96 PPQN, a pair = 48 ticks):

| Body | Onsets now | Onsets wanted |
| --- | --- | --- |
| `c d e f` | 0 34 48 82 | same |
| `c8. d e f g` | 0 72 106 120 154 | 0 82 96 130 144 |
| `c _8. d e f` | 0 106 120 154 | 0 96 130 144 |
| `_16 c8 d e` | 34 82 96 | same (by luck: an even span) |

**Decided (the user chose plan A over splitting lengths in the importer).**
`:shuffle R` warps the time of the `:shuffle-base` grid: in each pair
(2 × base from the pairing origin) the first half maps onto the first R %
of the pair and the second half onto the rest, linearly within each half —
so every onset *and* end lands on the warped grid, any length, ticks finer
than the base in proportion (a DAW's swing). R's range widens below 50 —
a short first beat, which a 3/7 tracker swing needs (R 30); the bounds are
for the session to settle. A body of base-length items only must come out
as today (check:snapshot holds it).

**Grooves, not only pairs.** A Furnace speed pattern runs up to 16 speeds
in turn, a row each, and 09xx switches between the song's grooves:
demos/nes/christmas-fever.fur opens on `0900` = groove [7 6 3 4] (its key-ons
at frames 0 7 13 16 20 in Furnace's VGM) and later `0901` = [4 2]. So the
warp wants an N-step form — the base units of a cycle in those proportions
(`:shuffle [7 6 3 4]`, say), the pair's `R` its two-step case. The import
reads both (`t.speeds`, `t.grooves`) and today plays each at its average.

**For the session to decide.** The pairing origin (the track's start, a
`:shuffle` change restarting it as now); how loops carry the phase (today's
`swingsOtherWay` / `W_SHUFFLE_LOOP` copy a body twice when it leaves the
parity flipped — with a positional warp the phase is the elapsed nominal
ticks mod the pair); the warnings and errors (`W_SHUFFLE_STRAIGHT` changes
meaning). Docs to update: language.md §5.2, the cheatsheet, reference.js
(and i18n).

**The importer after it lands** (import-tracker.js): where the speeds
differ, each track's head gets the warp over `:shuffle-base <a row>` —
R = round(100 · sp0 / (sp0 + sp1)) for two, the pattern for a groove —
restated on every track where 09xx / 0Fxx change them (speedMarks follows
Furnace's playback.cpp for both); rows stay on the straight grid (EDxx delays and ECxx cuts
in straight ticks, warped with it); the "imported at their average" warning
goes. Test song: Furnace's demos/nes/christmas-fever.fur (speeds 7/3).
An interim that laid each row at its own speed in the importer matched
Furnace's key-on times and was backed out in favour of this.

**Checking against Furnace.** Its CLI renders what the import must match:
`/Applications/Furnace/Furnace.app/Contents/MacOS/Furnace -loops 0 -vgmout
x.vgm song.fur` (the register writes: compare key-on times and periods with
`IRPlayer.captureRegisterLog`) and `-outmode perchan -output x.wav` (one WAV
a channel: levels).
