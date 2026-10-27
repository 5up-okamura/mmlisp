// ---------------------------------------------------------------------------
// What a part is (docs/language.md §19). A *part* is one kind of sound a chip
// has — 4-op FM, a square tone, a noise, a ROM rhythm sound, a sample voice —
// and carries the language that goes with it:
//
//   name      its word; a target's channel table binds channel names to it
//   label     what a diagnostic calls it
//   unit      the physical unit its voices are numbered in, where two parts
//             share one (the SSG's tone and noise are one channel's mixer);
//             the name by default. A channel table entry's `voice` is the
//             index in it — the chip's channel, the PSG's, the sample slot.
//   kind      the track class the compiler compiles it as:
//             fm | tone | noise | wave | sample
//   level     the part's level register, which the dB a note's vel / vol /
//             master (and a mixer strip) sum to is quantized onto once
//             (language.md §6; ir-utils.js levelSteps / levelGain): a
//             ladder { stepDb, steps }, 0 loud — FM's TL 0.75 dB in 128
//             steps, the SN76489's attenuator 2 dB in 16, the SSG's 3 dB in
//             16, the ROM rhythm's IL 0.75 dB in 32 — or { scale: "linear",
//             steps? }, a gain (the ADPCM-B's 0-255, PCM8's voice, the SCC's
//             0-15). The
//             Mega Drive's DAC voices have none: the driver's voice model
//             composes them (pcm-voices.js).
//   words     the IR write targets only this part's channels take: a target
//             has the word when one of its parts does, and a channel takes
//             it when its own part does (`:tl1` on sqr1 is a channel that
//             has no such thing). A word no part claims (:vel, :vol, :pitch
//             …) is the portable core, on every channel of every target.
//   songWords the song-wide write targets the part brings (`:lfo-rate`):
//             the target has them, and any of its tracks may write them
//   songMacros those of them a note's (macro …) may step on the part's
//             tracks (the SSG's noise period), the later write winning
//   modes     a track's `:mode` symbols → [IR target, value]; a `sample`
//             part's modes are the language's shot/loop/gate instead
//   modeError { code, message } for a `:mode` symbol it does not have
//   init      PARAM_SETs every track of the part starts with
//   points    false: the part's notes have no :pcm-start/:loop-* range
//   pitch     true: a sample part whose chip pitches the voice while it
//             plays, so its notes take :pitch, :semi, (glide …) and their
//             macros (not :snap); a soft-mixed voice plays its blob as baked
//   pointSweeps false: a range is read at key-on, so a swept point is its start
//   settings  def-score keys only this part reads (`:pcm-voices`)
//   sharePrio a rank where several parts are one channel's ways (the PC
//             Engine's wave, noise and DDA): a score writes any of them, and
//             where their notes meet the :prio layering decides across the
//             names, this rank at an equal :prio (0 first); parts without it
//             are one or the other in a score
//   noLevel   true: a part whose chip has no level for it (the 2A03's
//             triangle) — a note sounds or is halted, so a written :vel /
//             :vol says so (W_TARGET) and only 0 silences
//   rateNote  true: a noise whose note picks its rate (the 2A03's), pitched
//             as a tone lane is, on the PSG's noise lane
//   loopIsRange true: a sample part whose loop is a note's whole range (the
//             2A03's DMC): a :loop-* point is left out (W_TARGET)
//   claims    { kind, voice }: a channel of another part its notes take over
//             while they sound (the Mega Drive's DAC mix, fm6)
//   waveRam   (voice) → the wave memory a `wave` part's channel plays, where
//             channels share one (the SCC's 4 and 5)
//   kit       kit role → its sound: samples built in under those names
//   checkNote (note, ctx) → the part's rules for one note, after compile
//   checkScore(ctx) → the part's rules for the whole score
//   checkTracks({ tracks, named, push }) → the part's rules over what its
//             channels play together, tracks [{ head, events }] with loops
//             written out (the OPLL's one user voice)
//   initVoice an FM part's `init-fm`, where the family's init values are not
//             its sine (chips/fm-words.js fmInitVoice): Map word → value
//   modLevel  an FM part's ladder for a velocity-sensitive modulator's TL,
//             where its carrier's level is another register (the OPLL's)
//   ranges    { word: [min, max] }: an FM part's registers narrower than the
//             family's (chips/fm-words.js), which its writes are clamped to
//
// A chip (ym2612.js …) is a clock and its parts, and says how far the
// toolchain has it: `encoder` (the IR player writes its registers, so the
// register log and the VGM exist) and `emulator` (a core plays them, so Play
// and WAV do). An encoder takes a value at the language's widest — a wave's
// steps −128..127 (ir-utils WAVE), a pan −1..1 — and writes it at its chip's
// resolution (the SCC's 8 bits; the OPN's left and right bits, ir-utils
// panSide). A target (targets/) is its chips, its channel table and the
// few readings of another machine's words.
// ---------------------------------------------------------------------------

/** A `has(word)` test over IR targets: names and/or RegExps. */
export function words(...patterns) {
  return (word) =>
    patterns.some((p) => (typeof p === "string" ? p === word : p.test(word)));
}

export const NO_WORDS = () => false;
