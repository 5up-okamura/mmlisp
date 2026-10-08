# Envelopes

Named macros that give a note its shape. They are written for the PSG, which
has no voice of its own: `sqr1 env-pluck c` is the square channel's
instrument. Each is a plain `(def name (macro …))`, so one also works on an
FM track, on top of the voice, and on the noise channel. Original work, MIT
like the rest of the repository.

Two kinds, one target each, so they combine — `sqr1 env-piano vib-delay c`:

- **Level** (`env-…`) shapes `:vel+`: offsets from the note's own `:vel`, so a
  quiet note and a loud one share a shape and keep their dynamics. `0` is
  the note's level; `-15` reaches silence on the PSG (on FM, the velocity
  floor — language.md §6).
- **Pitch** (`vib`, `vib-delay`, `slide-up`, `drop`) shapes `:pitch` only.

```
env-pluck        a short decay, six frames
env-pluck-long   a 12-frame tail, fast then lingering
env-stab         full for three frames, then cut
env-bell         a slow exponential tail, half a second
env-piano        a long decay that settles, a short release
env-guitar       a quicker decay that settles lower, a short release
env-organ        full while held, a short release
env-brass        a little swell into full, held, a short release
env-lead         a decay to two-thirds, held, a short release
env-pad          a slow swell, held, then a slow fall
env-tremolo      full / three-quarters, two frames each
env-hat          a four-frame tick, for the noise channel
env-snare        an eleven-frame burst, for the noise channel

vib              ±25 cents, five a second, from the start
vib-delay        ±15 cents after eight frames
slide-up         the pitch rises three semitones into the note
drop             the pitch falls eight semitones over eight frames
```

A MIDI import puts these on the notes it sends to a PSG channel, chosen by
the GM program's family (piano → `env-piano`, organ → `env-organ`, strings
and pads → `env-pad`, …).

Every step is one frame (`:step 1f`, the default) unless the def says
otherwise, so a shape lasts the same time at any tempo. `#sus` holds a value
until key-off and `#rel` starts the release, so the shapes with a release
need the note's length to end before the next note for it to sound. A macro
is sticky: once written, it shapes every following note on the track until
another macro on its target replaces it, or `(macro :vel none)` /
`(macro :pitch none)` clears it.
