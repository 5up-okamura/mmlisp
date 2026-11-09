# The language and IR — rulings not to re-propose

`docs/language.md` is the spec. `:key value` is a sticky parameter,
`(form …)` an event or control, `#name` a position (§7.0).

- **No CALL/RET in the language**: sharing is the encoder's job.
- Counted `(go label N)` stays.
- Holds keep both `:len 0` (waits for the host) and `:gate 0` (does not).
- The short forms `>` `<` `o±N` `v±N` stay; `:wait` and `(wait …)` both
  stay; `:csm-rate` and the `fm3-csm-rate` track both stay; `(glide …)`
  stays a form.
- PSG envelopes are macros, not a def head. No second sigil (`@vel`).
- **`for` binds numbers only** (no `:step`, literal range ends, no note
  names); a `for` over tokens is the next step if chords as offsets prove
  awkward, not an evaluator exception.
- Comparisons `=` `<` `>` `<=` `>=` give 1/0; no boolean type.
- **Macro-curve `$slot` params stay baked on MMB** (cost in
  representation); reopen as an offset slot on the scaled-macro mechanism,
  not live endpoints.
- More PCM tracks than voices, if built, drops by `:prio` (no merged bake).
- No def-se on CH3.
- **The driver gains no evaluator**, only readers and flags: the
  compile-time evaluator may grow; an `if` on a `$` value is an error.
  Live ≡ hardware is reached by growing the driver's reads, not shrinking
  the preview.

Known: an override looping curve on a pitch macro skews the ir↔drv A/B by
±8 in the F-number at note boundaries.
