# FM drums (YM2612)

94 FM drums from the five named percussion banks of the libOPNMIDI XG bank,
[fm_banks/xg.wopn @ 8e0a0a6ac97a](https://github.com/Wohlstand/libOPNMIDI/blob/8e0a0a6ac97a21f22c4b4d53d67a8d916d8c487b/fm_banks/xg.wopn) —
the bank `presets/gm`'s melodic voices come from. Copyright (c) 2018-2026
Vitaliy Novichkov (Wohlstand), MIT — [notice](licenses/libopnmidi-xg.txt).
The registers are the bank's; only the operator order is re-ordered to
MMLisp's 1,2,3,4, and the bank's shared LFO rate is not applied.

The standard kit is here whole, GM notes 35-81, as `fm-` and the role name
every PCM kit uses (`fm-kick`, `fm-snare`, `fm-tom1` …), so a PCM kit and
this set import together. The other four kits add only the drums that sound
different from the ones before them, under the kit's prefix: `fm-std2-`,
`fm-analog-`, `fm-elec-`, `fm-symph-`. A kit's drum that is identical to an
earlier one is not repeated: the analog and electric kits' ride, and the
guiro, long guiro and mute triangle of all three, are the second standard
kit's, so they are `fm-std2-ride` and so on. A GM note a kit does not list is
the standard kit's drum.

Each drum is an FM voice whose `:key` is the bank's fixed key for it
(language.md §9): on a track at `:oct 4`, `c` plays the drum as the bank tuned
it, and another note retunes it — `d` is two semitones up. Drums with the same
registers extend the first of them with their own `:key`.

```lisp
(import "presets/fm-drums/set.mmlisp")
(fm5 :tempo 120 :oct 4 :len 8 fm-analog-kick c fm-hat c fm-elec-snare c fm-hat c)
```

To play a whole kit under the standard names, override the ones you want in
the score; a local def wins over an imported one:

```lisp
(def-fm fm-kick fm-analog-kick)
(def-fm fm-snare fm-analog-snare)
```

- An FM drum rings until its note keys off: `:len` (or the gate) is its
  length, so give cymbals and open hats a long note or a tie.
- Levels are the bank's: the kit is not balanced between its sounds — set
  that with `:vel` / `:vol`.

### Standard kit (StandKit)

```
 35 fm-kick2           51 fm-ride            67 fm-agogo-hi
 36 fm-kick            52 fm-china           68 fm-agogo-lo
 37 fm-rim             53 fm-ride-bell       69 fm-cabasa
 38 fm-snare           54 fm-tamb            70 fm-maracas
 39 fm-clap            55 fm-splash          71 fm-whistle
 40 fm-snare2          56 fm-cowbell         72 fm-whistle-long
 41 fm-tom1            57 fm-crash2          73 fm-guiro
 42 fm-hat             58 fm-vibraslap       74 fm-guiro-long
 43 fm-tom2            59 fm-ride2           75 fm-claves
 44 fm-hat-pedal       60 fm-bongo-hi        76 fm-woodblock-hi
 45 fm-tom3            61 fm-bongo-lo        77 fm-woodblock-lo
 46 fm-hat-open        62 fm-conga-mute      78 fm-cuica-mute
 47 fm-tom4            63 fm-conga-hi        79 fm-cuica
 48 fm-tom5            64 fm-conga-lo        80 fm-triangle-mute
 49 fm-crash           65 fm-timbale-hi      81 fm-triangle
 50 fm-tom6            66 fm-timbale-lo
```

### Second standard kit (StndKit2)

```
 41 fm-std2-tom1             74 fm-std2-guiro-long
 51 fm-std2-ride             80 fm-std2-triangle-mute
 73 fm-std2-guiro
```

### Analog kit (AnalgKit)

```
 35 fm-analog-kick2          46 fm-analog-hat-open
 36 fm-analog-kick           47 fm-analog-tom4
 38 fm-analog-snare          48 fm-analog-tom5
 39 fm-analog-clap           50 fm-analog-tom6
 40 fm-analog-snare2         52 fm-analog-china
 41 fm-analog-tom1           56 fm-analog-cowbell
 42 fm-analog-hat            62 fm-analog-conga-mute
 43 fm-analog-tom2           63 fm-analog-conga-hi
 44 fm-analog-hat-pedal      64 fm-analog-conga-lo
 45 fm-analog-tom3
```

### Electric kit (ElctrKit)

```
 35 fm-elec-kick2            43 fm-elec-tom2
 36 fm-elec-kick             45 fm-elec-tom3
 38 fm-elec-snare            47 fm-elec-tom4
 40 fm-elec-snare2           48 fm-elec-tom5
 41 fm-elec-tom1             50 fm-elec-tom6
```

### Symphonic kit (SymphKit)

```
 35 fm-symph-kick2           47 fm-symph-tom4
 36 fm-symph-kick            48 fm-symph-tom5
 38 fm-symph-snare           50 fm-symph-tom6
 40 fm-symph-snare2          51 fm-symph-ride
 41 fm-symph-tom1            57 fm-symph-crash2
 43 fm-symph-tom2            59 fm-symph-ride2
 45 fm-symph-tom3
```
