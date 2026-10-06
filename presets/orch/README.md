# Orchestral samples

Orchestral sounds FM cannot make, as PCM. 22,050 Hz, signed 16-bit mono.
Levels are set per sound and baked into the WAV: each file's loudest
50 ms sits at a fixed RMS — orch-hit and orch-hit2 −4 dB, timpani −5, pizz −7.
The kits' drums run from −3 (kick and snare) to −10 (cymbals). A sound
quieter than its level is driven up with a gain into a limiter and then a
hard clip; a louder one is turned down. Balance a score further with
`:vel` / `:vol` or a per-sound `(gain …)` effect.

```
orch-hit    the Fairlight ORCH5 stab, a C major chord     0.8 s
orch-hit2   the RX5's DX Orchestra stab, rooted on C      0.56 s
timpani     one timpani stroke, near C#3                  0.8 s
pizz        a violin section pizzicato, C5                0.35 s
```

The hits and the timpani sound as recorded on `:oct 4 c`, and other notes
retune them. `pizz` plays the pitch written: its `:rate` puts the C5 it was
recorded at on `:oct 5 c`. Every note a
score plays is baked into the sample bank on its own, and the bank holds
32 KB a song, so a long sample used at many pitches fills it quickly — trim
one with `:frames` when a score needs room.

## Sources

All CC0 1.0 — [licence](LICENSE-CC0.txt).

- `orch-hit`: druidbloke's recreation of the Fairlight ORCH5 stab
  ([Freesound 165599](https://freesound.org/people/druidbloke/sounds/165599/)).
  Decoded from the MP3 Freesound serves, resampled, cut to 0.8 s from the
  3 s original with a half-cosine fade over its last 40%.
- `orch-hit2`, `timpani`: MckAudio's recordings of a Yamaha RX5
  ([MckSamplePacks](https://github.com/MckAudio/MckSamplePacks/tree/master/RX5),
  `MISC/011_DX_Orchestra`, `PERC/017_Timpani`). Resampled from 48 kHz and
  shortened with a half-cosine fade.
- `pizz`: Versilian Studios' VSCO 2 Community Edition
  ([VSCO-2-CE](https://github.com/sgossner/VSCO-2-CE),
  `Strings/Violin Section/Pizz/VlnEns_Pizz_C4_v2_rr1`). Resampled from
  44.1 kHz and shortened with a half-cosine fade.
