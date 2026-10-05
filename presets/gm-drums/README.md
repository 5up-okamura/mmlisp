# GM muted drum kit

42 one-shots from Virtuosity Drums (Versilian Studios and Karoryfer Samples,
drummer Austin McMahon), [upstream](https://github.com/sfzinstruments/virtuosity_drums)
at `9f04cf9a7345`, CC0 1.0 — [licence](LICENSE-CC0.txt).
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for; toms run tom1-tom6, low to high.

Short articulations throughout: one muted low tom resampled across the six GM
toms, and faded tails where the source has no muted take. The snare is a full
center hit (mid mic, top velocity), shortened to 0.26 s — the muted take it
replaced was too thin to carry next to FM.

Every file is louder than peak-normalizing alone would make it: a gain into a
limiter is baked into the WAV, bringing the body of each hit (its first
100 ms) toward a level by role — kicks about −6 dB RMS, snare and toms −9,
hand percussion −11, cymbals −12 — at most 12 dB of gain, the peak just under
full scale. Balance a score's drums further with `:vel` / `:vol`.

```
 35 kick2           51 ride            67 agogo-hi
 36 kick            53 ride-bell       68 agogo-lo
 37 rim             54 tamb            69 cabasa
 38 snare           56 cowbell         71 whistle
 41 tom1            57 crash2          72 whistle-long
 42 hat             58 vibraslap       73 guiro
 43 tom2            59 ride2           74 guiro-long
 44 hat-pedal       60 bongo-hi        75 claves
 45 tom3            61 bongo-lo        76 woodblock-hi
 46 hat-open        62 conga-mute      77 woodblock-lo
 47 tom4            63 conga-hi        78 cuica-mute
 48 tom5            64 conga-lo        79 cuica
 49 crash           65 timbale-hi      80 triangle-mute
 50 tom6            66 timbale-lo      81 triangle
```

Not in the kit, for want of a source articulation: 39 hand clap,
40 electric snare, 52 chinese cymbal, 55 splash cymbal, 70 maracas.
The GM percussion range is 35-81.
