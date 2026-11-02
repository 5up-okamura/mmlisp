# wavetable

Basic waves for the wave channels: `wt-sine`, `wt-triangle`, `wt-saw`,
`wt-square`, `wt-pulse25`, `wt-pulse12`, `wt-organ` and `wt-bell`. Each is a
`def-wave` of 32 steps, which every machine with wave channels takes.

```lisp
(def-score :target pce)
(import "presets/wavetable/set.mmlisp")
(wave1 wt-organ :len 4 c e g e)
```

Copy one into the score (Copy, or Insert in the Library) and draw on it in
the vector editor.
