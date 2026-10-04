# RX5 drum kit

36 one-shots from MckAudio's recordings of a Yamaha RX5
([MckSamplePacks](https://github.com/MckAudio/MckSamplePacks/tree/master/RX5),
recorded with a ZOOM U-24), CC0 1.0 — [licence](LICENSE-CC0.txt).
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for; toms run tom1-tom6, low to high.

The RX5 carries a near-complete GM percussion set, and this kit takes one
voice per GM note from its standard (non-jazz, non-heavy) family. Tom 4 to
Tom 1 sit on tom3-tom6; tom1 and tom2 are Tom 4 played 6 and 3 semitones
lower, which is how the RX5 itself retunes a voice. The pedal hi-hat is the
jazz kit's, the ride 2 is the flat ride, and maracas is the RX5's shaker.
Long hits are shortened with a half-cosine fade and cymbals end at 0.6 s;
there are no loops. Every file is peak-normalized to 0 dBFS, so each hit
uses the full 8 bits and sits level with FM; the kit is not balanced between
its sounds — set that with `:vel` / `:vol` or a per-sound `(gain …)` effect.

```
 35 kick2        46 hat-open     56 cowbell      66 timbale-lo
 36 kick         47 tom4         59 ride2        67 agogo-hi
 37 rim          48 tom5         60 bongo-hi     68 agogo-lo
 38 snare        49 crash        61 bongo-lo     70 maracas
 39 clap         50 tom6         62 conga-mute   71 whistle
 40 snare2       51 ride         63 conga-hi     79 cuica
 41 tom1         52 china        64 conga-lo     85 castanets
 42 hat          53 ride-bell    65 timbale-hi
 43 tom2         54 tamb
 44 hat-pedal    55 splash
 45 tom3
```

Source files (`RX5/` in the upstream): BD/002 and 001, SD/004 rim shot, SD/001,
PERC/001 claps, SD/010 electric snare, TOMS/004-001, HATS/001 closed,
HATS/009 jazz pedal, HATS/002 open, HATS/005 crash, HATS/004 ride edge,
HATS/006 china, HATS/003 ride cup, PERC/002 tambourine, HATS/013 splash,
PERC/003 cowbell, HATS/010 flat ride, PERC/008-009 bongos, PERC/005-007
congas, PERC/010-011 timbales, PERC/012-013 agogos, PERC/004 shaker,
PERC/016 whistle, PERC/014 cuica, PERC/015 castanet.

Changes from the source: resampled from 48 kHz (two toms also pitched down),
leading silence trimmed, shortened with a half-cosine fade, and
peak-normalized.

The RX5 has no second crash, vibraslap, cabasa, guiro, claves, wood block,
muted cuica or triangle, and one whistle, so those GM notes are absent
rather than filled from another instrument: 57, 58, 69, 72-78, 80, 81.
Beyond the kit vocabulary's 35-81, note 85 carries the RX5's castanet.
The RX5's voices and effects are in [sfx](../sfx/README.md), its DX
Orchestra stab and timpani in [orch](../orch/README.md).
