// ---------------------------------------------------------------------------
// What a part is (docs/language.md §19). A *part* is one kind of sound a chip
// has — 4-op FM, a square tone, a noise, a ROM rhythm sound, a sample voice —
// and carries the language that goes with it:
//
//   name      its word; a target's channel table binds channel names to it
//   label     what a diagnostic calls it
//   kind      the track class the compiler compiles it as:
//             fm | tone | noise | sample
//   words     the IR write targets only this part's channels take: a target
//             has the word when one of its parts does, and a channel takes
//             it when its own part does (`:tl1` on sqr1 is a channel that
//             has no such thing). A word no part claims (:vel, :vol, :pitch
//             …) is the portable core, on every channel of every target.
//   songWords the song-wide write targets the part brings (`:lfo-rate`):
//             the target has them, and any of its tracks may write them
//   modes     a track's `:mode` symbols → [IR target, value]; a `sample`
//             part's modes are the language's shot/loop/gate instead
//   modeError { code, message } for a `:mode` symbol it does not have
//   init      PARAM_SETs every track of the part starts with
//   points    false: the part's notes have no :pcm-start/:loop-* range
//   settings  def-score keys only this part reads (`:pcm-voices`)
//   kit       kit role → its sound: samples built in under those names
//   voiceOf   (ev, sampleDefs) → the physical voice a note sounds on, where
//             one track reaches several (`:prio` layers flatten per voice)
//   checkNote (note, ctx) → the part's rules for one note, after compile
//   checkScore(ctx) → the part's rules for the whole score
//
// A chip (ym2612.js …) is a clock and its parts; a target (targets/) is its
// chips, its channel table and the few readings of another machine's words.
// ---------------------------------------------------------------------------

/** A `has(word)` test over IR targets: names and/or RegExps. */
export function words(...patterns) {
  return (word) =>
    patterns.some((p) => (typeof p === "string" ? p === word : p.test(word)));
}

export const NO_WORDS = () => false;
