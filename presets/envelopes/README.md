# Envelopes

13 named macros that give a note its shape — a decay, a swell, a tremolo, a
vibrato, a slide, a drop. They are written for the PSG, which has no voice
of its own: `sqr1 env-pluck c` is the square channel's instrument. Each is a
plain `(def name (macro …))`, so one also works on an FM track, on top of the
voice, and on the noise channel. Original work, MIT like the rest of the
repository.

```
env-pluck        a short decay, six frames
env-pluck-long   a 12-frame tail, fast then lingering
env-stab         full for three frames, then cut
env-bell         a slow exponential tail, half a second
env-organ        full while held, a short release
env-pad          a slow swell, held, then a slow fall
env-tremolo      full / three-quarters, two frames each
env-lead         a decay to two-thirds, then vibrato after eight frames
env-vibrato      full while held, a wide vibrato from the start
env-slide-up     the pitch rises three semitones into the note
env-drop         the pitch falls an octave as the note dies
env-hat          a four-frame tick, for the noise channel
env-snare        an eleven-frame burst, for the noise channel
```

Every step is one frame (`:step 1f`, the default) unless the def says
otherwise, so a shape lasts the same time at any tempo; `:vel` runs 0-15,
the PSG's own range, and on FM it offsets the voice's carrier levels (the
level model, language.md §6). `#sus` holds a value until key-off and `#rel`
starts the release, so `env-organ` and `env-pad` need the note's length to
end before the next note for their release to sound. A macro is sticky: once
written, it shapes every following note on the track until another macro
replaces it or `(macro :vel none)` clears it.
