# YM2608-style rhythm kit

The six sounds of the YM2608 (OPNA) rhythm section — bass drum, snare, top
cymbal, hi-hat, tom and rim shot — as recreated by メモル (Takanori
YOSHIMURA) in "YM2608風リズム音源音色データ Ver.2.0" (2608modoki2), from
[sound.jp/jaime](https://sound.jp/jaime/fmp_top.html). They are not the
chip's ROM: the author gathered sounds from their own instruments and edited
them to resemble the YM2608's, and the waveforms differ from the real chip.
22,050 Hz, signed 16-bit mono.

The author's terms, in [LICENSE-2608modoki2.txt](LICENSE-2608modoki2.txt):
free to distribute, reprint or build into software, paid or free; the author asks
(does not require) to be told which title uses them.

`set.mmlisp` names them by role, in the vocabulary every kit uses, so
swapping the import swaps the sounds under the same names. The number is
the GM note the file is named for. The OPNA's top cymbal is a ride, and its
one tom sits on tom4 — the same places the mucom88 importer gives them.

Levels are set by role and baked into the WAV: each file's loudest 50 ms
sits at a fixed RMS — kick and snare −3 dB, tom −5, rim −8, hi-hat −9,
ride −10. A sound quieter than its level is driven up with a gain into a
limiter and then a hard clip (the density of classic game PCM, a little grit
by design). Balance a score further with `:vel` / `:vol` or a per-sound
`(gain …)` effect.

```
 36 kick         38 snare        47 tom4
 37 rim          42 hat          51 ride
```

Files from the archive (2608modoki2.zip): `2608_bd`, `2608_rim`,
`2608_sd`, `2608_hh`, `2608_tom`, `2608_top`, each at its full length with a
short end fade. Changes from the source: resampled from 44.1 kHz and set to
a level by role.
