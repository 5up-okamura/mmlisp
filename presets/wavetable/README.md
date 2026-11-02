# wavetable

Waves for the wave channels, named by role as the ROM voices are, so a score
keeps its names between an FM channel and a wave channel: `organ` `flute`
`clarinet` `oboe` `violin` `trumpet` `horn` `piano` `vibraphone` `synth-bass`,
and the plain shapes `sine` `triangle` `saw` `square` `pulse25` `pulse12`. Each
is a `def-wave` of 32 steps, which every machine with wave channels takes.

A wave alone holds one level, and every wave held still sounds much like an
organ. What tells them apart is how a note moves, so each role also has a macro
to name: `wave-piano` strikes on a brighter wave, settles on `piano` and dies
away, stepping the wave and the level together.

```lisp
(def-score :target pce)
(import "presets/wavetable/set.mmlisp")
(wave1 wave-piano :len 4 c e g > c)
(wave2 :oct 2 wave-synth-bass :len 8 c c g c)
```

Copy one into the score (Copy, or Insert in the Library) and draw on it in the
vector editor. The set is written by `tools/scripts/gen-wavetable.mjs`, from
formulas; change a wave there.
