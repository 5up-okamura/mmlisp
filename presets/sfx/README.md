# Sound effects and voices

Shouts and effects FM cannot make, as PCM. 22,050 Hz, signed 16-bit mono.
Levels are set per sound and baked into the WAV: each file's loudest
50 ms sits at a fixed RMS — gun −5 dB, the shouts, door and zaps −6, glass −8.
The kits' drums run from −3 (kick and snare) to −10 (cymbals). A sound
quieter than its level is driven up with a gain into a limiter and then a
hard clip; a louder one is turned down. Balance a score further with
`:vel` / `:vol` or a per-sound `(gain …)` effect.

```
hey      a shouted "hey!"       0.35 s
wao      a shouted "wao!"       0.42 s
ooo      a short "ooo"          0.28 s
glass    breaking glass         0.5 s
gun      a gunshot              0.8 s
door     a door slam            0.6 s
zap      a hip-hop zap          0.15 s
zap2     a robotic zap          0.3 s
```

Each sample sounds as recorded on `c`; other notes retune it, which is the
usual way to play a voice higher or lower. Every note a score plays is baked
into the sample bank on its own, and the bank holds 32 KB a song.

## Sources

- `hey` … `door`: MckAudio's recordings of a Yamaha RX5
  ([MckSamplePacks](https://github.com/MckAudio/MckSamplePacks/tree/master/RX5),
  `MISC/001-005` and `MISC/021`), CC0 1.0 — [licence](LICENSE-CC0.txt).
  Resampled from 48 kHz and shortened with a half-cosine fade.
- `zap`: the first hit of kontraamusic's "Hiphop - Zap Lock Loop"
  ([Freesound 751110](https://freesound.org/s/751110/)), CC BY 4.0 —
  [licence](LICENSE-CC-BY-4.0.txt). Using or redistributing this file
  requires crediting it, for example: "Zap by kontraamusic (freesound.org),
  CC BY 4.0". Downmixed, resampled from 44.1 kHz, and cut to 0.15 s, before
  the loop's second hit.
- `zap2`: zgump's "ROBO KISS" ([Freesound 82529](https://freesound.org/s/82529/)),
  CC0 1.0 — [licence](LICENSE-CC0.txt). Downmixed and resampled from
  44.1 kHz, at its full length.
