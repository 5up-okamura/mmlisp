# 808 drum kit

22 one-shots from the Michael Fischer / Technopolis recordings of a TR-808
(1994), [upstream](https://github.com/tidalcycles/sounds-tr808-fischer) at
`85fbecf1bec3`, CC0 1.0 — [licence](LICENSE-CC0.txt).
22,050 Hz, signed 16-bit mono.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for; toms run tom1-tom6, low to high.

One representative knob setting per instrument; the six GM toms use the low,
mid and high drums at TUNING 2.5 and 7.5, with no digital pitch change. Long
hits are shortened with a half-cosine fade; there are no loops. Levels are
untouched, so the kit is not balanced yet.

```
 35 kick2        43 tom2         57 crash2
 36 kick         45 tom3         62 conga-mute
 37 rim          46 hat-open     63 conga-hi
 38 snare        47 tom4         64 conga-lo
 39 clap         48 tom5         70 maracas
 40 snare2       49 crash        75 claves
 41 tom1         50 tom6
 42 hat          56 cowbell
```

A TR-808 has no pedal hi-hat, ride, china, splash or bongos, so those GM notes
are absent rather than filled from another instrument: 44, 51-55, 58-61, 65-69,
71-74, 76-81. Note 38 is the 808's own snare under GM's acoustic name, and
62 mute hi conga is a shortened high conga rather than a muted take.
