# Drum-and-bass kit

Twelve one-shots for drum and bass, gathered from two CC0 sources —
[licence](LICENSE-CC0.txt). 22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for.

`kick2` is the kick and the crash struck together, mixed into one sample —
the hit that opens a phrase in drum and bass — so it takes one PCM voice,
not two.

Levels are set by role and baked into the WAV: each file's loudest 50 ms
sits at a fixed RMS — kicks, snares and clap −3 dB, rim −8, hi-hats −9,
crash and ride −10. A sound quieter than its level is driven up with a gain
into a limiter and then a hard clip (the density of classic game PCM, a
little grit by design). Balance a score further with `:vel` / `:vol` or a
per-sound `(gain …)` effect.

```
 35 kick2        38 snare        42 hat          49 crash
 36 kick         39 clap         44 hat-pedal    51 ride
 37 rim          40 snare2       46 hat-open     53 ride-bell
```

## Sources

- `kick`, `snare`, `snare2`, `rim`, `clap`: soneproject's recordings of a
  Korg Electribe EMX-2, all recorded the same way from the same machine, so
  kick and snares share their air — [Korg Electribe Emx2 - Kick](https://freesound.org/people/soneproject/packs/15977/)
  slice a5 (Freesound 260525), at its own 0.43 s; and
  [Korg Electribe Emx2 - Snares](https://freesound.org/people/soneproject/packs/15964/)
  slices 8a, 6d, 70 and 8b (Freesound 260349, 260344, 260342, 260350), at
  their own lengths with a short end fade.
- `hat`, `hat-pedal`, `hat-open`, `crash`, `ride`, `ride-bell`: Virtuosity
  Drums (Versilian Studios and Karoryfer Samples), [upstream](https://github.com/sfzinstruments/virtuosity_drums)
  at `9f04cf9a7345`, the overhead mic — `Samples/oh/hh/oh_hh_closed_vl3_rr1`,
  `oh_hh_pedal_vl2_rr1`, `oh_hh_open_vl3_rr1`,
  `Samples/oh/crash/oh_crash_crash_vl3_rr1`,
  `Samples/oh/ride/oh_ride_ride_vl2_rr1` and `oh_ride_bell_vl2_rr1`;
  0.15 s, 0.15 s, 0.5 s, 0.7 s, 0.4 s and 0.4 s with a half-cosine fade.
- `kick2`: `kick` plus `crash` 6 dB under it, 0.7 s.

All are resampled to 22,050 Hz and mixed to mono. The kit has no toms or
Latin percussion, so those GM notes are absent.
