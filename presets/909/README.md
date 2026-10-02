# 909 drum kit

13 one-shots from the TR-909 JGB pack: sampled by Janne G:son Berg from his
own TR-909, cut up and published by altemark on
[Freesound](https://freesound.org/people/altemark/packs/1643/), CC BY 4.0 —
[licence](LICENSE-CC-BY-4.0.txt). Using or redistributing these files
requires crediting them, for example: "TR-909 samples by Janne G:son Berg,
via altemark (freesound.org), CC BY 4.0".
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for.

The 909's three toms sit on GM's low, low-mid and high tom (tom3, tom4,
tom6). Note 35 is a second bass-drum setting and 40 a short snare.
Long hits are shortened with a half-cosine fade; there are no loops. Every
file is peak-normalized to 0 dBFS, so each hit uses the full 8 bits and sits
level with FM; the kit is not balanced between its sounds — set that with
`:vel` / `:vol` or a per-sound `(gain …)` effect.

```
 35 kick2        40 snare2       47 tom4
 36 kick         42 hat          49 crash
 37 rim          45 tom3         50 tom6
 38 snare        46 hat-open     51 ride
 39 clap
```

Source files (Freesound IDs): bd07 26493, bd01 26486, rs01 26670, sn01
26674, clp01 26552, clp15 26566, sn16 26689, ch01 26520, lt01 26596, oh02
26644, mt01 26620, ht01 26574, ride06 26663.

Changes from the source: 2:1 low-pass decimation from 44.1 kHz, shortened
with a half-cosine fade, and peak-normalized.

A TR-909 has three toms and no pedal hi-hat, cowbell or Latin percussion, so
those GM notes are absent rather than filled from another instrument: 41, 43,
44, 48, 52-81.
