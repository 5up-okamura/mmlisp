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
| `fm3-1`–`fm3-4` | FM3, one pitch per operator | patch from a note-less `(fm3 voice)` — a note on it is an error (§15) |
| `fm3-csm`, `fm3-csm-rate` | FM3 CSM | pitch = formant, rate track = buzz; beside `fm3-1`–`fm3-4` each operator is a formant track and the rate track the voice (§15) |

Two forms of one channel append; with different `:prio` right after the
channel name they layer, lower number winning (§1) — for the voice, `:pan`
and `:vol` too.

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
| `:len` | 8 | default note length; `0` = hold; the track waits for the key-off (§17) |
| `:gate` `:gate*` `:gate-` | full | sounding part: absolute, a ratio (`0.7`), or length minus (`12t`) |
| `:vel` | 15 | 0–15, 2 dB a step, in eighths (`14.5`); never mutes |
| `:vel1`–`:vel4` | role | an FM operator's velocity sensitivity, 0–1: carriers 1, modulators 0 unless set (§6) |
| `:vol` / `:master` | 31 | 0–31 fader, `0` mutes; `:master` is song-wide |
| `:tempo` | 120 | BPM, song-wide, from any track; a curve sweeps it |
| `:pan` | center | `left` `center` `right` (FM) |
| `:snap` | none | pitch classes every note snaps down onto: `[0 2 4 5 7 9 11]`, a `$slot`, `none` (§5.3) |
| `:shuffle` | none | warps the sixteenth grid (`:shuffle-base`): `66` swings a pair 66:34, `[7 6 3 4]` a 4-step groove (§5.2) |
| `:mode` | | `noise`: noise mode; `pcm`: `shot` / `loop` / `gate` |
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
(def-fm keys lead :vel1 0.5)            ; modulator op1 takes half the velocity: softer is darker
(def-pcm hit :file "hit.wav")           ; relative to this file (§16)
(def-val bright 20 0..40 :public)       ; a slot the game / a slider writes, read as $bright (§8)
(def-val gain 256 0..512 :public)       ; as a factor, :vol* $gain is ×gain/256
(def-val swell 0)                       ; the score's own value: :swell (linear 0..40 :len 8/1) moves it
(import "presets/gm/set.mmlisp")        ; another file's defs (§9.2)
(import "presets/tr808/set.mmlisp" :over) ; replaces earlier imports' same names
(def-mod :ch fm2 :keyon off)            ; score-wide: fm2's notes become rests (§9.4)
(def-mod :voice [hat hat-open] :vel+ -3) ; every note on these, quieter (clamped 0–15)
```

Naming a voice or sample in a track body switches to it. An FM voice change
is sent in the silence before its note, so the note it follows ends about 40 ms
early when there is no rest between them (language §9). Preset sets:
`presets/gm` (gm-piano … gm-gunshot), `presets/waveforms` (wave-sine,
acid-saw, …), `presets/tr808`, `tr909`, `cr78`, `dr220`, `dx`, `rx5`,
`hiphop`, `drumnbass` and `gm-drums` (PCM kits: kick, snare, hat, …), `presets/orch` (PCM
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
(macro :vel [(linear 15..4 :len 1) #rel (linear :to 0 :len 8f)]) ; release from where it is
(macro :pitch (sin -30..30 :len 8f))                ; vibrato, ±30 cents
(macro :step 1/16 :semi [#sus 0 4 7] :keyon 1)      ; arpeggio, re-keyed each 16th
(macro [:tl1 :tl2] (linear 40..0 :len 8))           ; one curve on two targets
(macro :vel none)   (macro none)                    ; clear one / all
```

A macro is sticky: it runs on every following note until cleared. Targets:
`:vel :vol :pitch :semi :keyon :pan :mode`, the FM voice (`:alg :fb :ams
:fms`) and the operators (`:tl1`–`:tl4`, `:ar :dr :sr :rr :sl :ml :dt :ks :ssg
:am` 1–4). The song-wide `:master` and `:lfo-rate` are inline only (a sweep, not
a macro). `:step` is frames (`2f`) or a note length (`16`, on the beat).

## Curves (§11)

`(name A..B :len L …)` — `linear`, `ease-in` / `ease-out` / `ease-inout` (and
`-sine -cubic -expo -back -bounce …`), the loop waves `sin triangle square saw
ramp`, and the random `noise pink perlin brown` (macro only). Options: `:rate`,
`:phase`, `:mode loop|shot`, `:wait`, `:duty` (square), `:seed`. A param takes
a number, a `let` name or an expression (`:to (* 2 top)`); `:from :to :len
:rate` also a bare `$slot`, never an expression with a `$`.

Where a curve goes: a macro (per note), an inline sweep (`:tl1 (linear 40..0
:len 2)`, `:vol`, `:pan`), `:tempo`, `(delay …)`. A macro curve needs its
start written (`40..0`, not `:to 0` alone) — but the release's curve, right
after `#rel` / `(wait key-off)`: without `:from` it falls from where the macro
is at the key-off. Where a number is needed,
`noise` is one draw: `(note (+ (midi c4) (noise 0..12)))` is a random key, the
same on every build (§11.1); `(midi c+4)` is 61 and `(hz a4)` 440 (§7.1).

## More forms

| Write | Means |
| --- | --- |
| `(echo 3 :vel+ -2)` | replay the last note 3 times, quieter; takes time — the mucom import's `\=`; for an echo effect write `(delay …)` (§12) |
| `(delay 2 :vel* 0.6 :time 1/8)` | echo copies of every following note in the gaps (§12) |
| `(glide 8)` … `(glide none)` | portamento into each note (§14) |
| `(let [root 60] (note root) (note (+ root 7)))` | computed pitches, MIDI numbers (§7.2, §7.3) |
| `(for [i 0..7] (note (+ 60 i)))`, `(for [n [0 4 7]] (note (+ 48 n)))` | notes generated from values, written out once a pass (§7.5) |
| `(if (= (mod i 4) 0) (note 72) (note 60))` | a branch chosen at compile time; compare with `= < > <= >= not` (1/0); else optional in the note stream (§7.6) |
| `:tl1 (+ 20 10)`, `(min 7 5)`, `(mod i 4)` | compile-time arithmetic (§7.1) |
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
after its note-off; `:mode gate` plays the range once and is cut at the gate.
`…-len` keeps the length when its start moves.

A note's pitch picks a resampled copy, baked into the 32 KB bank — only what
the score plays is baked. No pitch moves on PCM (`:pitch`, `(glide)`; pc88's
pcm1 takes them); levels
step 6 dB; voices sum and hard-clip. `:fx` effects, baked in order: `gain`
`normalize` `comp` `limit` `crush` `hpf` `lpf` `drive` `fade` `reverb`.

## Mistakes the compiler catches — and the ones it can't

- A loop bakes its state: `(x 4 c >)` plays `c c c c` and leaves the octave
  up. Rebalance, `(x 4 c > c <)`.
- `(e g a)` is not a tuplet — write `(t e g a)`.
- A def named like a note or length (`a`–`g`, `e8`) is `E_DEF_NAME`, as a
  `let` name is. Pick words (`riff`, `root`).
- `:prio` goes right after the channel name, nowhere else.
- A macro target that does not exist — a typo like `(macro :vell [15 9])` —
  is `E_MACRO_TARGET`; the targets are listed under Macros above.
- In a PCM score an `fm6` track is an error — move it to `fm1`–`fm5`.
- A channel takes its own chip's words: FM operator keys and `:pan` on a
  `sqr`/`noise`/`pcm` track, or `:mode white0` on an FM track, are
  `E_UNSUPPORTED_TARGET`.
- `(def-score :target pc88)` holds a score to the PC-8801's YM2608 (§19):
  sqr `:mode tone|noise|both|env`, song-wide `:noise-rate`, `noise` is sqr3,
  a drum's steps as macros (`(macro :mode [both noise] :noise-rate [2 4 6])`),
  the hardware envelope as a channel's level — `:env 0–15` its shape (8/12
  saws, 10/14 triangles; `none` off), restarted at each key-on, the
  song-wide `:env-rate` Hz or `note` (the track's pitch), moved by the
  track's `:env-semi` semitones and `:env-detune` register steps (+ lower;
  with `:mode tone` a step off beats the timbre); `:mode env` plays the
  envelope alone, a buzzer (`(sqr1 :env 8 :env-rate note :mode env c)`),
  pcm1 the ADPCM-B, `rhythm1`–`rhythm6` the ROM rhythm, built in under the
  kit roles (`(rhythm1 kick c hat c)`, no def; a track per sound for its own
  `:vol`/`:pan`). A word or channel only another target's
  chips have is `E_TARGET`. It exports VGM (FM, SSG, rhythm, the ADPCM-B
  with its RAM image) and plays and renders WAV through ymfm's YM2608; the
  rhythm plays from the user's own ROM (File ▸ Import ▸ YM2608 Rhythm ROM…), else
  from an imported kit's `:file`s, cut to the ROM sounds' lengths.
- `(def-score :target x68k)` holds a score to the X68000's YM2151 (§19):
  `fm1`–`fm8` (fm8 `:mode noise`: its fourth operator the noise, the voice
  whole), `noise` (that operator alone), song-wide `:noise-rate`, DT2
  as `:dt2-1`–`:dt2-4` 0–3, the LFO as `:lfo-freq` `:lfo-pmd` `:lfo-amd`
  `:lfo-wave`; `pcm1`–`pcm8` PCM8's voices mixed into the MSM6258's ADPCM
  (pitch moves allowed, no `:pan`); no SSG-EG, no FM3 modes. VGM and WAV.
- `(def-score :target msx)` holds a score to the MSX's PSG, an AY-3-8910
  (§19): `sqr1`–`sqr3` and `noise` as on pc88 (`:mode tone|noise|both|env`,
  song-wide `:noise-rate`, `noise` is sqr3, `:env` / `:env-rate`); `wave1`–`wave5` the SCC's
  wavetable channels, each playing the `def-wave` named in it
  (`(def-wave saw :wave (saw -128..127))` — 32 values −128..127 (64 for
  fc's FDS; on a 32-step chip every other step plays) or one
  curve's cycle, or `+ - * /` over def-waves, curves and numbers; a track's
  `:wave (+ (* saw (- 1 $x)) (* soft $x))` follows `$x` as it moves;
  `(macro :wave [saw soft #sus saw])` steps def-waves a frame at a time; wave4
  and wave5 share one); `fm1`–`fm9` the FM-PAC's YM2413, 2-op (op1 into
  op2): the fifteen ROM voices built in as `piano`, `violin` …
  (a `def-fm` that extends one, or its own, is the chip's one user voice),
  `:ar` `:dr` 0–15, `:tl1` 0–63, `:ks` 0–1, its own `:ws1` `:eg1` `:ksl1`
  `:vib1` and the channel's `:sus 1`; no `:alg`, `:tl2`, `:pan`.
  `rhythm1`–`rhythm5` the FM-PAC's rhythm (`kick snare tom4 ride hat`, no
  def; a hit's note tunes it, c4 the chip's, and `:pitch` / `(glide …)` /
  pitch macros move it on through the release) in place of `fm7`–`fm9`. No
  PCM. VGM and WAV.
- `(def-score :target pce)` holds a score to the PC Engine's HuC6280 (§19):
  `wave1`–`wave6` wave channels as the SCC's (`def-wave`, `:wave`, its
  macro; a wave named under a note starts it over; 5-bit volume, 1.5 dB a
  step), `noise5` / `noise6` in place of wave5 / wave6, pitched by their
  notes (c2 the slowest rate, g4 the fastest); `:pan` −1..1 whole, on each
  channel's 4-bit left / right levels; the LFO as the FM LFO is written —
  the song's `:lfo-freq` (larger faster), `wave1` `:fms 0–3` taking it, its
  shape and speed `wave2`'s (keep it at `:vol 0` to hear wave1 alone);
  `pcm1`–`pcm6` channel N as DDA, a `def-pcm` at 6.99 kHz, 5 bits, each
  note baked at its pitch. `waveN` / `noiseN` / `pcmN` are one channel: all
  may be written, and where notes meet, `:prio` decides, else pcm > noise > wave.
  No FM, square, `:noise-rate` or `:mode`. VGM and WAV.
- `(def-score :target fc)` holds a score to the Famicom's 2A03 (§19):
  `sqr1` / `sqr2` the pulses, 4-bit linear volume, `:duty` in sixteenths
  (sticky, default 8; the chip's 2 / 4 / 8 / 12, the nearest taken; a value,
  a macro or a curve); `tri` the triangle, no level (`:vel` / `:vol` warn,
  only 0 silences; a rest halts it); `noise` pitched by its notes (c2 the
  slowest of 16 rates, d#3 the fastest), `:mode white | periodic`; `pcm1`
  the DMC, one voice: a `def-pcm` at one rate a def (the highest its whole
  sample fits 4081 bytes at), each note baked at its pitch with its level
  at key-on, a loop the whole range (`:loop-*` warns). Mono: no `:pan`; no
  FM, wave, `:noise-rate`. VGM and WAV. Expansions, named by chip, when a
  score names them — the VRC6 cartridge's
  `vrc6-sqr1` / `vrc6-sqr2` pulses (`:duty` the nearest of 1–8 sixteenths, a wider
  one its mirror), `vrc6-saw` (`:vel` its 6-bit rate, 15 = 63; above 13.25 the
  saw wraps, harsher, not louder); VGM leaves them out (WAV plays them).
  The Disk System's `fds-wave` plays def-waves (a 32-step one each
  step twice in its 64), its gain 0–32 as `:vel`; its modulation is the
  song's `:lfo-wave [32 steps of 0 1 2 4 -1 -2 -4 reset]`, `:lfo-pmd 0–63`
  (depth), `:lfo-freq 0–4095` (rate). VGM carries it.
- `:vel 0` is quiet, not silent — a rest is `_`, a mute is `:vol 0`.
- Tracks drift silently: end bars with `|` and compare lengths across tracks
  (the MCP `mmlisp_check` prints every track's length with its loops unrolled).
