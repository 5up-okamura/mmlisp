# language.md vs the implementation — audit of 2026-09-18

Four agents read docs/language.md line by line against the compiler, the
editor preview (ir-player) and the MMB/driver path (export-mmb → drv-player ≡
C), with snippets compiled and run. Nothing was fixed yet. The key driver
findings (B1, B2, B4, B5) were re-checked by hand. Delete entries as they are
fixed; delete the file when empty.

Already known and not repeated here: sample keys :bit-depth/:volume/:compress/
:reverb; auto `(trig)`; trig not surfaced by the SGDK host; slot-fed macro-curve
params / sweep :rate/:len baked on MMB; curve×curve MVP limits; SE and PAL not
on the C driver.

## B — the driver plays it differently from the editor (the release risk)

1. `:gate 0` (§17 L1318) — the driver SUSPENDS the track like `:len 0`
   (drv-player `_noteOn` held on exGate 0); the doc and the preview advance by
   :len. Also `:len 0` (L1322): later events at the same tick never play on the
   driver until a host KEY_OFF.
2. Glide bleeds (§14 L1061): no cap at the note length, `bounded` is not
   carried to MMB, a NOTE_ON cancels only loop sweeps → later notes slide.
3. Glide / pitch macros on fm3-N (§15 L1082): glide lands on CH3's A2/A6
   (fm3-1) or is dropped (fm3-2..4: no sweep bank); pitch macros on fm3-N do
   nothing on the driver (macro engine covers ch 0-9 only).
4. `:vol* $slot` / PARAM_MUL_VAL (§8 L557/L479): preview multiplies by the
   slot as an integer, driver as 8.8 (`>> 8`) — ×20 vs ×0.078.
5. `(delay …)` taps (§12 L1004-1011): taps landing in a rest or on the same
   tick are pushed late on MMB (W_MMB_TICK_REGRESSION; the doc's own example).
   Same mechanism: `:prio` layering (§1 L66-83) — the flatten keeps the higher
   layer's RESTs, the export clock runs ahead.
6. def-val clamp (§8 L584-587): only ir-player clamps to min..max; VAL_TABLE
   carries no range, the C/SGDK setVal clamp only to i16.
7. Multi-stage macro, loop stage then a release stage (§10 L787-792): the
   preview plays the later stage after key-off; lowerStages sets the release
   only on an explicit `(wait key-off)` (the doc's `organ` example).
8. `:keyon` + `:off` (§10 L843-854): the driver's retrigger restarts every
   macro slot from its attack (tail vel replays 15); preview only re-keys $28.
   PSG `:keyon` works on the driver, not in the preview.
9. A curve stage with its own `:wait` loses its curve on MMB; a single curve
   with `:wait key-off` is dropped (W_MMB_MACRO_SKIPPED).
10. Curves > 255 steps are silently cut on MMB; a stages macro > 255 steps is
    silently dropped.
11. Computed float levels (§6 L337-339, suspected): driver composes from
    integer tables.
12. CSM "rest the rate source to silence" (§15 L1098): no CSM_OFF is emitted;
    the preview ignores the rest.

## C — the doc is wrong, or the code silently disagrees

- Doc facts: `125ms` → 24 ticks at 120 (not 48, L184); fm6 "sounds as FM in the
  gaps" (L92) contradicts E_FM6_DAC; "note names shadow definitions" is
  reversed (L128); `~ N` listed as a length context (L188); `:pitch+` +
  scale "cannot combine" is stale (L396); track-header options "not
  evaluated" (L432) — :tl1 is, :len is not; head options "ignored in the body"
  are E_UNKNOWN_KEYWORD (L232).
- Broken examples: `(* (sin :rate 6) $depth)` (no :from/:to → flat 0, L389);
  `(def (beat n) (x 8 > n > n <))` climbs an octave a pass (L666);
  `:keyon (square …)` / `(noise …)` with no :len (L848); the delay curve example
  drops every tap (L1011); `:leak 0.995` is a no-op (L922).
- Semantics: head `:len`/`:gate` computed values dropped (L191); second-form
  `:shuffle none` / `:shuffle-base` ignored (L307); Nf tempo seeding uses the
  track's own :tempo and the FIRST leading tempo, not the last (L205, L266);
  tiny `:gate*` rounds to gate 0 = hold (L242); `:wait Nf` read as ticks
  (L894); `:hold` quantizes the LUT index, not steps (L915); `:rate 0` also
  zeroes `:phase` (L893); `:seed 0xBEEF` ignored (L917); :min/:max not synonyms
  of :from/:to (L571); def-val non-integer init breaks the form (L568); local
  def does not win over an import in another namespace (L697); nested import
  paths resolve from the folder root, `..` rejected (L686); voice-def values
  must be integer literals (L624); let-bound curve lost when used bare (L508);
  E_LET_SHADOWS_DEF only for voice/macro defs (L511); `:break` in an infinite
  loop inside a counted one is inert (L1033); `(fm3 …)` notes beside fm3-N draw
  no diagnostic (L1087).
- Silent drops (no diagnostic): `:tempo 0`; `:vel (linear …)` inline; `:vel $a`
  / `:oct $a` / `:vel (+ 1 2)`; `:tempo (+ …)` → misleading E_UNKNOWN_CURVE;
  non-integer / unknown tokens in `[…]`; scalar macro specs with symbols
  (`(macro :pan left)`); `:gate* 1.5`.
- Diagnostics: nesting > 16 lists throws a JS Error (E_EVAL_DEPTH at 32 is
  unreachable; `(def lp c lp)` crashes); E_PCM_SAMPLE_REQUIRED is a warning
  and fires twice; E_PCM_SAMPLE_UNDEFINED twice; E_UNSUPPORTED_TARGET /
  E_VAL_UNDEFINED still emit their event; tick :len in curve×curve gives
  E_EVAL_NOT_LOWERABLE.
