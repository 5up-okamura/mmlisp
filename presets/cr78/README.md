# CR-78 drum kit

10 one-shots recorded by wikter from a Roland CR-78 through a Delta 44,
published on [Freesound](https://freesound.org/people/wikter/packs/40417/),
CC0 1.0 — [licence](LICENSE-CC0.txt).
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for.

The CR-78's voices are short, and every file keeps its recorded length with
only a few milliseconds of fade; the rimshot is a 5 ms click.
Levels are set by role and baked into the WAV: each file's loudest 50 ms
sits at a fixed RMS — kick, snare and clap −3 dB, toms −5, rim and hand
percussion −8, hi-hats −9, cymbals −10. A sound quieter than its level is
driven up with a gain into a limiter and then a hard clip (the density of
classic game PCM, a little grit by design); a louder one is turned down.
Balance a score further with `:vel` / `:vol` or a per-sound `(gain …)`
effect.

```
 36 kick         42 hat          61 bongo-lo     75 claves
 37 rim          49 crash        64 conga-lo
 38 snare        60 bongo-hi     70 maracas
```

Source files (Freesound IDs): bassdrum 723610, rimshot 723618, snare-drum
723619, hhat 723614, cymbal 723612, hb-hi-bongo 723613, low-bongo 723615,
low-conga 723616, maraca 723617, clave 723611.

Changes from the source: resampled from 44.1 kHz, leading silence trimmed,
short end fade, and set to a level by role.

The pack has no open hi-hat, toms, clap or cowbell, so those GM notes are
absent rather than filled from another instrument: 35, 39-41, 43-48, 50-59,
62, 63, 65-69, 71-74, 76-81.
