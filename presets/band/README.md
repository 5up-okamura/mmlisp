# Guitar and bass samples

The RX5's guitar and bass one-shots, as PCM. 22,050 Hz, signed 16-bit mono.
Each file is peak-normalized to 0 dBFS; set levels with `:vel` / `:vol` or
a per-sound `(gain …)` effect.

```
               recorded at                    length
guitar         C3, a single picked note       0.65 s
guitar-5th     C3, a power chord              0.6 s
guitar-down    a down-strum, G major          0.18 s
guitar-up      an up-strum, G major           0.18 s
bass-elec      C2, an electric bass note      0.35 s
bass-elec-hi   C3, an electric bass note      0.3 s
bass-finger    A1, finger-plucked             0.5 s
bass-pick      C2, picked                     0.65 s
bass-syn       C2, a synth bass               0.45 s
```

The notes and the power chord play the pitch written: each `:rate` puts the
recording at its own octave, so `:oct 2 c` on `bass-elec` is C2, as
recorded. The strums are chords and play as recorded on `:oct 4 c`. Every
note a score plays is baked into the sample bank on its own, and a note
below the recording bakes longer (an octave down, twice the bytes); the bank
holds 32 KB a song, so a bass line over many pitches fills it quickly —
shorten a sample with `:frames` when a score needs room.

## Sources

All CC0 1.0 — [licence](LICENSE-CC0.txt). MckAudio's recordings of a Yamaha
RX5 ([MckSamplePacks](https://github.com/MckAudio/MckSamplePacks/tree/master/RX5),
`MISC/009-010` and `MISC/014-020`), resampled from 48 kHz and shortened with
a half-cosine fade.
