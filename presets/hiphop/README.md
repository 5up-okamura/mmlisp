# Hip-hop drum kit

Nine one-shots for boom-bap and lo-fi beats, gathered from three CC0
sources — [licence](LICENSE-CC0.txt). 22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for.

Levels are set by role and baked into the WAV: each file's loudest 50 ms
sits at a fixed RMS — kicks, snares, clap and rim −3 dB (the rim is a snare,
kept at a snare's level), hi-hats −9. A sound quieter than its level is
driven up with a gain into a limiter and then a hard clip (the density of
classic game PCM, a little grit by design). Balance a score further with
`:vel` / `:vol` or a per-sound `(gain …)` effect.

```
 35 kick2        38 snare        42 hat          46 hat-open
 36 kick         39 clap         44 hat-pedal
 37 rim          40 snare2
```

## Sources

- `kick`, `kick2`, `rim`, `snare`, `snare2`, `hat`, `hat-pedal`: hits cut
  from three loops in holizna's [Lofi Drum Loops](https://freesound.org/people/holizna/packs/34855/),
  each before the loop's next hit:
  - `kick` and `snare` from "Boom Bap Hiphop Kick Snare Loop 95 BPM"
    ([Freesound 629132](https://freesound.org/s/629132/)), 0.3 s from
    0.325 s and from 3.144 s;
  - `kick2`, `rim` and `hat-pedal` from "Funky Lofi Drum Loop 88 BPM"
    ([Freesound 629137](https://freesound.org/s/629137/)), 0.32 s from
    0.009 s, 0.32 s from 0.710 s and 0.12 s from 1.299 s — `rim` is the
    loop's snare, a third snare on the side-stick note;
  - `snare2` and `hat` from "BoomBap Drums 90 BPM"
    ([Freesound 629139](https://freesound.org/s/629139/)), 0.34 s from
    0.667 s and 0.3 s from 0.350 s, the hat high-passed at 1 kHz
    (24 dB/oct).
- `clap`: the tr808 kit's clap, the same file — see
  [tr808](../tr808/README.md) for its source (the TR-808 recordings in
  tidalcycles/sounds-tr808-fischer, CC0).
- `hat-open`: Virtuosity Drums (Versilian Studios and Karoryfer Samples),
  [upstream](https://github.com/sfzinstruments/virtuosity_drums) at
  `9f04cf9a7345`, the lo-fi mic — `Samples/lofi/hh/lofi_hh_open_vl3_rr1`,
  0.5 s with a half-cosine fade.

All are resampled to 22,050 Hz and mixed to mono. The kit has no toms,
cymbals or Latin percussion, so those GM notes are absent.
