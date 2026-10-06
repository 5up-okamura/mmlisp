# DR-220E drum kit

11 one-shots recorded by esnow from a Boss DR-220E straight into an audio
interface without processing, published on
[Freesound](https://freesound.org/people/esnow/packs/31223/), CC0 1.0 —
[licence](LICENSE-CC0.txt).
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for.

The DR-220E's three toms sit on GM's low, low-mid and high tom (tom3, tom4,
tom6). Long hits are shortened with a half-cosine fade; there are no loops.
The source was recorded quietly, so the drive raises it the most.
Levels are set by role and baked into the WAV: each file's loudest 50 ms
sits at a fixed RMS — kick, snare and clap −3 dB, toms −5, rim and hand
percussion −8, hi-hats −9, cymbals −10. A sound quieter than its level is
driven up with a gain into a limiter and then a hard clip (the density of
classic game PCM, a little grit by design); a louder one is turned down.
Balance a score further with `:vel` / `:vol` or a per-sound `(gain …)`
effect.

```
 36 kick         42 hat          47 tom4         53 ride-bell
 38 snare        45 tom3         50 tom6         56 cowbell
 39 clap         46 hat-open     52 china
```

Source files (Freesound IDs): BD 555940, SD 555945, SLP 555949, CH 555937,
LT 555942, OH 555946, MT 555941, HT 555943, CHY 555938, CUP 555944, CB
555939.

Changes from the source: resampled from 48 kHz, leading silence trimmed,
shortened with a half-cosine fade, and set to a level by role.

The pack has no rim, crash, ride body or Latin percussion, so those GM notes
are absent rather than filled from another instrument: 35, 37, 40, 41, 43,
44, 48, 49, 51, 54, 55, 57-81.
