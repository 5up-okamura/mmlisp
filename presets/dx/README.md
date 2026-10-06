# DX drum kit

11 one-shots recorded by oceansonmars from an Oberheim DX, published on
[Freesound](https://freesound.org/people/oceansonmars/packs/39619/), CC0 1.0
— [licence](LICENSE-CC0.txt). The pack's pattern loops are not included.
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for.

The pack files its sounds loosely — its snare_04 is a clap, and three of its
"snares" are toms — so they are mapped by ear. The five toms, each with its
own character, run tom1-tom5 from low to high by pitch (about 126, 137, 140,
174 and 180 Hz); there is no tom6. Every file keeps its recorded length
with only a few milliseconds of fade, and the silence before each hit is
trimmed.
Levels are set by role and baked into the WAV: each file's loudest 50 ms
sits at a fixed RMS — kick, snare and clap −3 dB, toms −5, rim and hand
percussion −8, hi-hats −9, cymbals −10. A sound quieter than its level is
driven up with a gain into a limiter and then a hard clip (the density of
classic game PCM, a little grit by design); a louder one is turned down.
Balance a score further with `:vel` / `:vol` or a per-sound `(gain …)`
effect.

```
 35 kick2        39 clap         43 tom2         47 tom4
 36 kick         41 tom1         45 tom3         48 tom5
 38 snare        42 hat          46 hat-open
```

Source files (Freesound IDs): dxkick_03 709709, dxkick_01 709707,
dxsnare_01 709713, dxsnare_04 709716 (clap), dxsnare_03 709715 (tom1),
dxclosedhat_01 709704, dxsnare_02 709714 (tom2), dxtom_02 709719 (tom3),
dxopenhat 709712, dxsnare_05 709717 (tom4), dxtom_01 709718 (tom5).

Changes from the source: stereo mixed to mono, resampled from 44.1 kHz,
leading silence trimmed, short end fade, and set to a level by role.

The pack has no rim, cymbal or percussion one-shots, so those GM notes are
absent rather than filled from another instrument: 37, 40, 44, 49-81.
