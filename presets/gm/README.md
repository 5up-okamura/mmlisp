# GM 128-voice bank (YM2612)

The 128 melodic voices (bank MSB 0 / LSB 0) of the libOPNMIDI XG bank, from
[fm_banks/xg.wopn @ 8e0a0a6ac97a](https://github.com/Wohlstand/libOPNMIDI/blob/8e0a0a6ac97a21f22c4b4d53d67a8d916d8c487b/fm_banks/xg.wopn).
Copyright (c) 2018-2026 Vitaliy Novichkov (Wohlstand), MIT —
[notice](licenses/libopnmidi-xg.txt). The registers are the bank's; only the
operator order is re-ordered to MMLisp's 1,2,3,4, and the bank's note offsets
and shared LFO rate are not applied.

```
  1 gm-piano           33 gm-bass-acoustic   65 gm-sax-soprano     97 gm-fx-rain
  2 gm-piano-bright    34 gm-bass-finger     66 gm-sax-alto        98 gm-fx-soundtrack
  3 gm-piano-e-grand   35 gm-bass-pick       67 gm-sax-tenor       99 gm-fx-crystal
  4 gm-honkytonk       36 gm-bass-fretless   68 gm-sax-bari       100 gm-fx-atmos
  5 gm-ep1             37 gm-bass-slap1      69 gm-oboe           101 gm-fx-bright
  6 gm-ep2             38 gm-bass-slap2      70 gm-english-horn   102 gm-fx-goblins
  7 gm-harpsi          39 gm-bass-syn1       71 gm-bassoon        103 gm-fx-echoes
  8 gm-clav            40 gm-bass-syn2       72 gm-clarinet       104 gm-fx-scifi
  9 gm-celesta         41 gm-violin          73 gm-piccolo        105 gm-sitar
 10 gm-glock           42 gm-viola           74 gm-flute          106 gm-banjo
 11 gm-musicbox        43 gm-cello           75 gm-recorder       107 gm-shamisen
 12 gm-vibes           44 gm-contrabass      76 gm-panflute       108 gm-koto
 13 gm-marimba         45 gm-str-trem        77 gm-bottle         109 gm-kalimba
 14 gm-xylo            46 gm-str-pizz        78 gm-shakuhachi     110 gm-bagpipe
 15 gm-tubular         47 gm-harp            79 gm-whistle        111 gm-fiddle
 16 gm-dulcimer        48 gm-timpani         80 gm-ocarina        112 gm-shanai
 17 gm-organ-drawbar   49 gm-strings1        81 gm-lead-square    113 gm-tinkle
 18 gm-organ-perc      50 gm-strings2        82 gm-lead-saw       114 gm-agogo
 19 gm-organ-rock      51 gm-synstr1         83 gm-lead-calliope  115 gm-steeldrum
 20 gm-organ-church    52 gm-synstr2         84 gm-lead-chiff     116 gm-woodblock
 21 gm-organ-reed      53 gm-choir           85 gm-lead-charang   117 gm-taiko
 22 gm-accordion       54 gm-voice-ooh       86 gm-lead-voice     118 gm-tom-melodic
 23 gm-harmonica       55 gm-synvox          87 gm-lead-fifths    119 gm-syndrum
 24 gm-bandoneon       56 gm-orch-hit        88 gm-lead-basslead  120 gm-revcymbal
 25 gm-guitar-nylon    57 gm-trumpet         89 gm-pad-newage     121 gm-fretnoise
 26 gm-guitar-steel    58 gm-trombone        90 gm-pad-warm       122 gm-breath
 27 gm-guitar-jazz     59 gm-tuba            91 gm-pad-poly       123 gm-seashore
 28 gm-guitar-clean    60 gm-trumpet-mute    92 gm-pad-choir      124 gm-bird
 29 gm-guitar-mute     61 gm-horn            93 gm-pad-bowed      125 gm-phone
 30 gm-guitar-od       62 gm-brass           94 gm-pad-metal      126 gm-heli
 31 gm-guitar-dist     63 gm-synbrass1       95 gm-pad-halo       127 gm-applause
 32 gm-guitar-harm     64 gm-synbrass2       96 gm-pad-sweep      128 gm-gunshot
```
