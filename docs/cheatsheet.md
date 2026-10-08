# MMLisp Cheat Sheet

The language on two pages — for writing a score, not for learning it. Every
entry points at its section in the reference ([language.md](language.md)),
which wins wherever the two differ; the [guide](guide.md) is the tutorial.

## A whole song

```lisp
(def-score :title "First Song" :pcm-voices 1)  ; the score's settings (§1)
(import "presets/gm/set.mmlisp")   ; 128 FM voices: gm-piano, gm-bass-syn1, ...
(import "presets/tr808/set.mmlisp")  ; PCM drums: kick, snare, hat, clap, ...

(def pluck (macro :vel [15 12 9 6 3]))  ; a velocity envelope, one step a frame
(def riff c e g > c < b g e d)          ; a phrase: 8 eighths = 1 bar

(fm1 :tempo 132 gm-lead-square :oct 4 :len 8
  #top
  riff | riff |
  (glide 16) g4 ~ a4 e2 | (glide none) c1 |
  (go top))                             ; loop forever from #top

(fm2 gm-bass-syn1 :oct 2 :len 8 :gate* 0.7
  #top (x 8 c c g g) | (go top))

(sqr1 :oct 5 :len 16 :vel 9 pluck
  #top (x 16 c e g e) | (go top))

(noise :mode white2 :len 8 (macro :vel [12 6 0])
  #top (x 32 c) | (go top))

(pcm1 :len 8
  #top (x 8 kick c _ snare c _) | (go top))
```

One file is one score: top-level `def`s, `import`s and one form per channel,
in any order (a def before its first use). Every track above plays 4 bars,
then jumps back to `#top`. `;` starts a comment.

## Channels (§2)

| Channel | Chip | |
| --- | --- | --- |
| `fm1`–`fm6` | YM2612 FM | `fm6` is taken by the DAC in a score that plays PCM |
| `sqr1`–`sqr3` | PSG square | |
| `noise` | PSG noise | `:mode white0`–`white3` / `periodic0`–`periodic3` |
| `pcm1`–`pcm3` | samples on the fm6 DAC | `(def-score :pcm-voices N)`: 1 = 14.4 kHz, 2 = 10.1, 3 = 6.7 |
| `fm3-1`–`fm3-4` | FM3, one pitch per operator | patch from a note-less `(fm3 voice)` (§15) |
| `fm3-csm`, `fm3-csm-rate` | FM3 CSM | pitch = formant, rate track = buzz (§15) |

Two forms of one channel append; with different `:prio` right after the
channel name they layer, lower number winning (§1).

## Notes and lengths (§3, §4)

| Write | Means |
| --- | --- |
| `c d e f g a b` | notes; `c+` sharp, `b-` flat |
| `_` | rest at `:len`; `_4` a quarter rest (`r` is not a rest) |
| `c4` `e8.` `g2/1` | note with its own length: quarter, dotted eighth, two bars |
| `c6t` `c16f` `c125ms` | ticks (quarter = 96), frames (1/60 s), milliseconds |
| `>` `<` `o+2` `o-1` | octave up / down / by N — sticky |
| `v+2` `v-1` | velocity up / down — sticky |
| `c ~ c` | tie: one attack, held (PCM too) |
| `c ~ e` | slur: moves pitch without a new attack (FM/PSG) |
| `(t c e g)` | tuplet: the three share one `:len` slot |
| <code>&#124;</code> | bar marker, end of each bar: checks lengths, plays nothing (§18) |

`:oct 4` is middle C (MIDI 60). A length is a denominator (`4` quarter, `8`
eighth), `N.` dotted, `N/M` a fraction of a whole note, `Nt` `Nf` `Nms`.

## Track keywords — all sticky (§5)

| Keyword | Default | |
| --- | --- | --- |
| `:oct` | 4 | octave |
| `:len` | 8 | default note length; `0` = hold without advancing (§17) |
| `:gate` `:gate*` `:gate-` | full | sounding part: absolute, a ratio (`0.7`), or length minus (`12t`) |
| `:vel` | 15 | 0–15, 2 dB a step; never mutes |
| `:vol` / `:master` | 31 | 0–31 fader, `0` mutes; `:master` is song-wide |
| `:tempo` | 120 | BPM, song-wide, from any track; a curve sweeps it |
| `:pan` | center | `left` `center` `right` (FM) |
| `:shuffle` | none | 51–90 swing on eighths (§5.2) |
| `:mode` | | `noise`: noise mode; `pcm`: `shot` / `loop` |
| `:alg :fb :tl1 :ar2 …` | voice | an FM register: value, curve, `none`, `$slot` (§5.1) |

A trailing `+` adds and `*` multiplies: `:vel+ -2`, `:vel* 0.5`, `:tl1+ 5`
(§7.0). Every note keys off at its gate, so the next one re-attacks; only `~`
and a hold carry a note into the next.

## Definitions (§9)

```lisp
(def riff c e g e)                      ; snippet: pasted where named
(def (beat n) (x 4 > n < n))            ; parametric: (beat c)
(def-fm lead init-fm :alg 4 :fb 3 :tl1 30 :tl2 0 :tl3 30 :tl4 0)
(def-fm lead-dark lead :fb 1)           ; extends lead
(def-fm thud lead :key 35)              ; c4 sounds at MIDI 35, d two above
(def-pcm hit :file "hit.wav")           ; relative to this file (§16)
(def-val bright 20 0..40)               ; runtime slot, read as $bright (§8)
(import "presets/gm/set.mmlisp")        ; another file's defs (§9.2)
(def-mod :ch fm2 :keyon off)            ; score-wide: fm2's notes become rests (§9.4)
(def-mod :voice [hat hat-open] :vel+ -3) ; every note on these, quieter (clamped 0–15)
```

Naming a voice or sample in a track body switches to it. An FM voice change
is sent in the silence before its note, so the note it follows ends about 40 ms
early when there is no rest between them (language §9). Preset sets:
`presets/gm` (gm-piano … gm-gunshot), `presets/waveforms` (wave-sine,
acid-saw, …), `presets/tr808`, `tr909`, `cr78`, `dr220`, `dx`, `rx5` and
`gm-drums` (PCM kits: kick, snare, hat, …), `presets/orch` (PCM
orchestral sounds: orch-hit, timpani, …), `presets/sfx` (PCM voices and
effects: hey, glass, zap, …), `presets/band` (PCM guitar and bass:
guitar, guitar-down, bass-finger, …), and `presets/fm-drums` (FM drums
on an fm track: fm-kick, fm-snare, fm-hat, … and fm-analog-kick, fm-elec-tom1,
fm-symph-snare, … — `:key` voices: at `:oct 4`, `c` is the drum as tuned, and
other notes retune it), and `presets/envelopes` (macros that shape a PSG
note — level as `:vel+`: env-pluck, env-piano, env-organ, env-pad, …; pitch:
vib, vib-delay, slide-up, drop; combine one of each; they work on FM too).

## Loops and flow (§13)

| Write | Means |
| --- | --- |
| `(x 4 c d e f)` | play the body 4 times |
| `(x 4 c d (break) e)` | the last pass stops at `(break)` |
| `#top … (go top)` | jump back forever — the song loop |
| `#verse … (go verse 2)` | the section plays twice |
| `(trig 3)` | cue the game reads (§13) |

## Macros — per-note automation (§10)

```lisp
(def pluck (macro :vel [15 12 8 4 0]))              ; one value per :step (1 frame)
(macro :vel [15 #sus 13 #rel 8 4 0])                ; #sus loops till key-off, #rel after
(macro :pitch (sin -30..30 :len 8f))                ; vibrato, ±30 cents
(macro :step 1/16 :semi [#sus 0 4 7] :keyon 1)      ; arpeggio, re-keyed each 16th
(macro [:tl1 :tl2] (linear 40..0 :len 8))           ; one curve on two targets
(macro :vel none)   (macro none)                    ; clear one / all
```

A macro is sticky: it runs on every following note until cleared. Targets:
`:vel :vol :master :pitch :semi :keyon :pan :mode :lfo-rate`, the FM voice
(`:alg :fb :ams :fms`) and the operators (`:tl1`–`:tl4`, `:ar :dr :sr :rr :sl
:ml :dt :ks :ssg :am` 1–4). `:step` is frames (`2f`) or a note length (`16`,
on the beat).

## Curves (§11)

`(name A..B :len L …)` — `linear`, `ease-in` / `ease-out` / `ease-inout` (and
`-sine -cubic -expo -back -bounce …`), the loop waves `sin triangle square saw
ramp`, and the random `noise pink perlin brown` (macro only). Options: `:rate`,
`:phase`, `:mode loop|shot`, `:wait`, `:duty` (square), `:seed`.

Where a curve goes: a macro (per note), an inline sweep (`:tl1 (linear 40..0
:len 2)`, `:vol`, `:pan`), `:tempo`, `(delay …)`. A macro curve needs its
start written (`40..0`, not `:to 0` alone).

## More forms

| Write | Means |
| --- | --- |
| `(echo 3 :vel+ -2)` | replay the last note 3 times, quieter; takes time (§12) |
| `(delay 2 :vel* 0.6 :time 1/8)` | echo copies of every following note in the gaps (§12) |
| `(glide 8)` … `(glide none)` | portamento into each note (§14) |
| `(let ((root 60)) (note root) (note (+ root 7)))` | computed pitches, MIDI numbers (§7.2, §7.3) |
| `:tl1 (+ 20 10)`, `(min 7 5)` | compile-time arithmetic (§7.1) |
| `:tl1 (+ 40 (* $bright 2))` | runtime expression over a slot (§7.1.2) |

## PCM (§16)

```lisp
(def-score :pcm-voices 2)
(def-pcm pad :file "pad.wav" :loop-start 300ms :loop-len 100ms
  :fx [(normalize) (fade :at 400ms :len 200ms)])
(pcm1 :len 8 kick c snare c)            ; name the sample before its notes
(pcm2 pad :mode loop :len 1 c)
```

Four points, as lengths or curves, on the def and the track:
`:pcm-start` ── `:loop-start` ═ `:loop-end` ── `:pcm-end`. A `shot` plays the
range (`:pcm-*`) once; `:mode loop` plays from `:pcm-start`, repeats the loop
(`:loop-*`, default: the whole range) while held, and runs on to `:pcm-end`
after its note-off. `…-len` keeps the length when its start moves.

A note's pitch picks a resampled copy, baked into the 32 KB bank — only what
the score plays is baked. No pitch moves on PCM (`:pitch`, `(glide)`); levels
step 6 dB; voices sum and hard-clip. `:fx` effects, baked in order: `gain`
`normalize` `comp` `limit` `crush` `hpf` `lpf` `drive` `fade` `reverb`.

## Mistakes the compiler catches — and the ones it can't

- A loop bakes its state: `(x 4 c >)` plays `c c c c` and leaves the octave
  up. Rebalance, `(x 4 c > c <)`.
- `(e g a)` is not a tuplet — write `(t e g a)`.
- A def named like a note or length (`a`–`g`, `e8`) is never reached — the
  body reads the note, with no warning. Pick words (`riff`, `root`); `let`
  rejects such names outright.
- `:prio` goes right after the channel name, nowhere else.
- A macro target that does not exist — a typo like `(macro :vell [15 9])` —
  is `E_MACRO_TARGET`; the targets are listed under Macros above.
- In a PCM score an `fm6` track is an error — move it to `fm1`–`fm5`.
- `:vel 0` is quiet, not silent — a rest is `_`, a mute is `:vol 0`.
- Tracks drift silently: end bars with `|` and compare lengths across tracks
  (the MCP `mmlisp_check` prints every track's length with its loops unrolled).
