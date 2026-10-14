# Hip-hop drum kit

Nine one-shots for boom-bap and lo-fi beats, gathered from two CC0
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

- `kick`, `kick2`, `rim`, `snare`, `snare2`, `hat`, `hat-pedal`, `hat-open`:
  hits cut from three loops in holizna's [Lofi Drum Loops](https://freesound.org/people/holizna/packs/34855/):
  - `kick` and `snare` from "Boom Bap Hiphop Kick Snare Loop 95 BPM"
    ([Freesound 629132](https://freesound.org/s/629132/)), 0.3 s from
    0.325 s and from 3.144 s;
  - `kick2`, `rim`, `hat-pedal` and `hat-open` from "Funky Lofi Drum Loop
    88 BPM" ([Freesound 629137](https://freesound.org/s/629137/)), 0.32 s
    from 0.009 s, 0.32 s from 0.710 s, 0.12 s from 1.299 s and 0.41 s from
    2.298 s — `rim` is the loop's snare, a third snare on the side-stick
    note; under `hat-open` the loop's kick at 2.41 s is subtracted (the
    loop's lone first kick, aligned and scaled) and a 200 Hz high-pass
    (24 dB/oct) takes what is left of it;
  - `snare2` and `hat` from "BoomBap Drums 90 BPM"
    ([Freesound 629139](https://freesound.org/s/629139/)), 0.34 s from
    0.667 s and 0.3 s from 0.350 s, the hat high-passed at 1 kHz
    (24 dB/oct).
- `clap`: the tr808 kit's clap, the same file — see
  [tr808](../tr808/README.md) for its source (the TR-808 recordings in
  tidalcycles/sounds-tr808-fischer, CC0).

All are resampled to 22,050 Hz and mixed to mono. The kit has no toms,
cymbals or Latin percussion, so those GM notes are absent.
