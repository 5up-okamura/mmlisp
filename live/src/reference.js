// The language reference the Library panel lists (its Ref source): one entry
// per feature, in English. docs/language.md is the full text and wins where
// the two differ; this is the short form, written to be searched and
// inserted. `cd tools && npm run check:reference` compiles every example.
//
// An entry:
//   name     what the list shows and the search matches first
//   aliases  other names it is found by (`:vel+` finds :vel)
//   prefixes word starts that belong to it (`:tl` covers :tl1–:tl4)
//   cat      its category (REFERENCE_CATEGORIES)
//   syntax   how it is written
//   summary  one or two sentences: what it does, its range and default
//   tracks   the tracks it applies to — 'fm' / 'psg' / 'pcm' — or null for
//            anywhere (Library's Fits track filter reads it)
//   insert   the text Insert puts at the cursor
//   example  a whole score that compiles clean; ▶ plays it
//   section  the language.md section that has the rest

export const REFERENCE_CATEGORIES = [
  ['score', 'Score and song-wide'],
  ['channels', 'Channels'],
  ['notes', 'Notes and lengths'],
  ['track', 'Track keywords'],
  ['fm', 'FM voices and registers'],
  ['defs', 'Definitions and values'],
  ['macros', 'Macros'],
  ['curves', 'Curves'],
  ['effects', 'Echo, delay, glide'],
  ['flow', 'Loops and flow'],
  ['fm3', 'FM3 and CSM'],
  ['pcm', 'PCM samples'],
  ['fx', 'Sample effects (:fx)'],
];

const FM = ['fm'];
const PSG = ['psg'];
const PCM = ['pcm'];
const FM_PSG = ['fm', 'psg'];

export const REFERENCE = [
  // ---- score and song-wide -------------------------------------------------
  {
    name: 'def-score', aliases: [':title', ':composer', ':author', ':pcm-voices'], cat: 'score', section: '§1', tracks: null,
    syntax: '(def-score :title "…" :composer "…" :author "…" :pcm-voices N)',
    summary: 'The score\'s settings: its metadata, and how many PCM voices the driver plays (0–3; fewer voices, a higher DAC rate). Every key is optional.',
    insert: '(def-score :title "" :composer "" :author "")',
    example: '(def-score :title "Demo" :composer "Me")\n(fm1 c e g)',
  },
  {
    name: 'import', cat: 'score', section: '§9.2', tracks: null,
    syntax: '(import "path/set.mmlisp")',
    summary: 'Folds another file\'s defs in at compile time, under this file\'s own. Its def-val, def-score, def-mod and tracks are not imported.',
    insert: '(import "presets/gm/set.mmlisp")',
    example: '(import "presets/gm/set.mmlisp")\n(fm1 gm-piano c e g)',
  },
  {
    name: ':tempo', cat: 'score', section: '§5', tracks: null,
    syntax: ':tempo BPM  ·  :tempo (curve …)',
    summary: 'Song-wide tempo, written on any track; a curve sweeps it. Default 120.',
    insert: ':tempo 120',
    example: '(fm1 :tempo 90 c e g :tempo (linear 90..180 :len 1) c e g c e g)',
  },
  {
    name: ':master', cat: 'score', section: '§6', tracks: null,
    syntax: ':master 0–31  ·  :master (curve …)',
    summary: 'Song-wide fader with unity at 31; 0 is a hard mute. A curve fades it.',
    insert: ':master 31',
    example: '(fm1 :len 4 c e g :master (linear 31..10 :len 1) c e g c)',
  },
  {
    name: ':lfo-rate', cat: 'score', section: '§1', tracks: null,
    syntax: ':lfo-rate 0–8',
    summary: 'The chip\'s one LFO, song-wide; 0 is off. A voice takes it through :ams (level) and :fms (pitch).',
    insert: ':lfo-rate 5',
    example: '(fm1 :lfo-rate 5 :fms 5 :len 2 c e)',
  },
  {
    name: ':prio', cat: 'score', section: '§1', tracks: null,
    syntax: '(fm1 :prio N …)',
    summary: 'Right after the channel name only. Forms of one channel with different :prio are layers on one voice: the lower number wins, a lower layer\'s note sounds in the higher one\'s gaps. Default 8.',
    insert: ':prio 1',
    example: '(fm1 :prio 1 :len 4 c _ _ g _ _)\n(fm1 :prio 5 :len 16 e e e e e e e e e e e e e e e e e e e e e e e e)',
  },
  {
    name: 'def-mod', aliases: [':ch', ':voice'], cat: 'score', section: '§9.4', tracks: null,
    syntax: '(def-mod [:ch c|[c …]] [:voice v|[v …]] :keyon off | :vel V | :vel+ N | :vel* R)',
    summary: 'Rewrites every note it selects, score-wide: :keyon off turns them into rests (play the part yourself on the keys), the vel ops move their velocity, clamped to 0–15.',
    insert: '(def-mod :ch fm1 :keyon off)',
    example: '(def-mod :ch fm2 :keyon off)\n(fm1 :len 4 c e g e)\n(fm2 :len 4 g b > d < b)',
  },

  // ---- channels ------------------------------------------------------------
  {
    name: 'fm1–fm6', aliases: ['fm1', 'fm2', 'fm3', 'fm4', 'fm5', 'fm6'], cat: 'channels', section: '§2', tracks: FM,
    syntax: '(fm1 …)',
    summary: 'The YM2612\'s six FM channels. A score that plays PCM owns fm6 as the DAC, so there an fm6 track is an error.',
    insert: '(fm1 :len 8 c d e f)',
    example: '(fm1 :len 8 c d e f g a b > c)',
  },
  {
    name: 'sqr1–sqr3', aliases: ['sqr1', 'sqr2', 'sqr3', 'psg'], cat: 'channels', section: '§2', tracks: PSG,
    syntax: '(sqr1 …)',
    summary: 'The PSG\'s three square-wave channels. No voice of their own: shape a note with a macro.',
    insert: '(sqr1 :len 8 c e g e)',
    example: '(sqr1 :oct 5 :len 8 c e g e)',
  },
  {
    name: 'noise', cat: 'channels', section: '§2', tracks: PSG,
    syntax: '(noise :mode white0 …)',
    summary: 'The PSG\'s noise channel. :mode white0–white3 or periodic0–periodic3 (sticky); 3 follows sqr3\'s pitch.',
    insert: '(noise :mode white2 :len 8 c c c c)',
    example: '(noise :mode white2 :len 8 (macro :vel [12 6 0]) c c c c c c c c)',
  },
  {
    name: 'pcm1–pcm3', aliases: ['pcm1', 'pcm2', 'pcm3'], cat: 'channels', section: '§16', tracks: PCM,
    syntax: '(pcm1 sample c …)',
    summary: 'Samples, soft-mixed on the fm6 DAC. Name a def-pcm sample before its notes; a note\'s pitch picks a resampled copy.',
    insert: '(pcm1 :len 8 kick c snare c)',
    example: '(import "presets/tr808/set.mmlisp")\n(pcm1 :len 8 kick c snare c kick c c snare c)',
  },

  // ---- notes and lengths ---------------------------------------------------
  {
    name: 'notes', aliases: ['c d e f g a b', 'sharp', 'flat'], cat: 'notes', section: '§3', tracks: null,
    syntax: 'c d e f g a b  ·  c+ (sharp)  ·  b- (flat)',
    summary: 'Note names at the track\'s :oct and :len. :oct 4 is middle C (MIDI 60).',
    insert: 'c d e f',
    example: '(fm1 :len 8 c d e f g a b > c)',
  },
  {
    name: '_ (rest)', aliases: ['_', 'rest'], cat: 'notes', section: '§3', tracks: null,
    syntax: '_  ·  _4  ·  _8.',
    summary: 'A rest at :len, or at its own length. `r` is not a rest.',
    insert: '_',
    example: '(fm1 :len 8 c _ e _ g _4)',
  },
  {
    name: 'length suffix', aliases: ['length', 'c4', 'dotted', 'ticks', 'frames', 'ms'], cat: 'notes', section: '§4', tracks: null,
    syntax: 'c4  ·  e8.  ·  g2/1  ·  c6t  ·  c16f  ·  c125ms',
    summary: 'A note\'s own length: a denominator (4 quarter), dotted, a fraction of a whole note, ticks (quarter = 96), frames, milliseconds. Affects that note only.',
    insert: 'c4',
    example: '(fm1 c4 e8. g16 c2/1)',
  },
  {
    name: '> < (octave)', aliases: ['>', '<', 'o+', 'o-', 'octave shift'], cat: 'notes', section: '§3', tracks: null,
    syntax: '>  ·  <  ·  o+2  ·  o-1',
    summary: 'Octave up / down by one, or by N — sticky, like :oct.',
    insert: '>',
    example: '(fm1 :len 8 c e g > c < g e c)',
  },
  {
    name: 'v+ v- (velocity)', aliases: ['v+', 'v-', 'velocity shift'], cat: 'notes', section: '§3', tracks: null,
    syntax: 'v+2  ·  v-1',
    summary: 'Velocity up / down by N (default 1) — sticky, like :vel+.',
    insert: 'v-2',
    example: '(fm1 :len 8 c v-3 c v-3 c v-3 c)',
  },
  {
    name: '~ (tie, slur)', aliases: ['~', 'tie', 'slur', 'legato'], cat: 'notes', section: '§3', tracks: null,
    syntax: 'c ~ c  ·  c ~ e',
    summary: 'Same pitch: a tie, one attack held (PCM too). Another pitch: a slur, the pitch moves with no new attack (FM / PSG).',
    insert: '~',
    example: '(fm1 :len 4 c ~ c e ~ g c2)',
  },
  {
    name: '(t …) tuplet', aliases: ['t', 'tuplet', 'triplet'], cat: 'notes', section: '§3', tracks: null,
    syntax: '(t c e g)',
    summary: 'Divides one :len slot evenly among its notes and rests.',
    insert: '(t c e g)',
    example: '(fm1 :len 4 c (t e g a) f (t c _ c))',
  },
  {
    name: '| (bar)', aliases: ['|', 'bar'], cat: 'notes', section: '§18', tracks: null,
    syntax: '… |',
    summary: 'A bar marker at the end of each bar: plays nothing, and is checked against the tracks\' lengths.',
    insert: '|',
    example: '(fm1 :len 4 c e g e | c e g e |)',
  },

  // ---- track keywords ------------------------------------------------------
  {
    name: ':oct', aliases: [':oct+'], cat: 'track', section: '§5', tracks: null,
    syntax: ':oct N  ·  :oct+ N',
    summary: 'The octave notes are read in. Default 4 (middle C).',
    insert: ':oct 4',
    example: '(fm1 :oct 3 :len 8 c e g :oct 5 c e g)',
  },
  {
    name: ':len', cat: 'track', section: '§5', tracks: null,
    syntax: ':len L',
    summary: 'The default note length. Default 8; 0 holds a note without advancing (the game keys it off).',
    insert: ':len 8',
    example: '(fm1 :len 8 c e :len 16 g g g g :len 4 c)',
  },
  {
    name: ':gate', aliases: [':gate*', ':gate-', 'staccato'], cat: 'track', section: '§5', tracks: null,
    syntax: ':gate L  ·  :gate* 0.0–1.0  ·  :gate- L',
    summary: 'How long a note sounds in its slot: an absolute length, a ratio, or the slot minus a length. Every note keys off at its gate, so the next re-attacks.',
    insert: ':gate* 0.5',
    example: '(fm1 :len 8 c e g e :gate* 0.3 c e g e)',
  },
  {
    name: ':vel', aliases: [':vel+', ':vel*', 'velocity'], cat: 'track', section: '§6', tracks: null,
    syntax: ':vel 0–15  ·  :vel+ N  ·  :vel* R',
    summary: 'Note-on velocity, 2 dB a step, 15 = the voice\'s own level. Attenuation only — never a mute. Default 15.',
    insert: ':vel 12',
    example: '(fm1 :len 8 :vel 15 c :vel 11 c :vel 7 c :vel 3 c)',
  },
  {
    name: ':vol', aliases: ['volume', 'fader'], cat: 'track', section: '§6', tracks: null,
    syntax: ':vol 0–31  ·  :vol (curve …)',
    summary: 'The channel fader, unity at 31; 0 is a hard mute. A curve fades it.',
    insert: ':vol 24',
    example: '(fm1 :len 4 c e :vol (linear 31..8 :len 1) g e c e g e)',
  },
  {
    name: ':pan', cat: 'track', section: '§5', tracks: FM,
    syntax: ':pan left | center | right  ·  :pan (curve …)',
    summary: 'FM stereo: one side, both, or a curve snapping between them.',
    insert: ':pan left',
    example: '(fm1 :len 8 :pan left c e :pan right g e :pan center c)',
  },
  {
    name: ':mode', aliases: ['shot', 'loop', 'white0', 'periodic0'], cat: 'track', section: '§5', tracks: ['psg', 'pcm'],
    syntax: ':mode white0–3 | periodic0–3  ·  :mode shot | loop',
    summary: 'On noise: the noise mode (sticky). On pcm1–pcm3: whether a note plays the sample once or loops while held.',
    insert: ':mode white2',
    example: '(noise :len 8 :mode white0 c c :mode white2 c c :mode periodic1 c c)',
  },
  {
    name: ':shuffle', aliases: [':shuffle-base', 'swing'], cat: 'track', section: '§5.2', tracks: null,
    syntax: ':shuffle 51–90 | none  ·  :shuffle-base L',
    summary: 'Swing: note pairs of the base length (default an eighth) split R : 100−R.',
    insert: ':shuffle 66',
    example: '(sqr1 :shuffle 66 :len 8 c c c c c c c c)',
  },

  // ---- FM voices and registers ---------------------------------------------
  {
    name: 'def-fm', aliases: ['voice', 'patch', 'init-fm'], cat: 'fm', section: '§9', tracks: FM,
    syntax: '(def-fm name init-fm :alg N :fb N :tl1 N …)',
    summary: 'An FM voice: the channel\'s :alg :fb :ams :fms and the operator params. A leading name is the voice it extends (init-fm is the blank one). Name it in a track to switch to it.',
    insert: '(def-fm lead init-fm :alg 4 :fb 3 :tl1 30 :tl2 0 :tl3 30 :tl4 0)',
    example: '(def-fm lead init-fm :alg 4 :fb 3 :tl1 30 :tl2 0 :tl3 30 :tl4 0)\n(fm1 lead :len 8 c e g > c)',
  },
  {
    name: ':key (voice)', aliases: [':key', 'drum voice'], cat: 'fm', section: '§9', tracks: FM,
    syntax: '(def-fm name base :key N)',
    summary: 'In a def-fm: c4 sounds at MIDI note N, and every note on the voice moves by N − 60 — how a drum voice is tuned.',
    insert: ':key 35',
    example: '(def-fm thud init-fm :alg 7 :key 35)\n(fm1 thud :len 4 c c d c)',
  },
  {
    name: ':alg :fb :ams :fms', aliases: [':alg', ':fb', ':ams', ':fms', 'algorithm', 'feedback'], cat: 'fm', section: '§10', tracks: FM,
    syntax: ':alg 0–7  ·  :fb 0–7  ·  :ams 0–3  ·  :fms 0–7',
    summary: 'The channel\'s algorithm, operator-1 feedback, and how much of the LFO reaches its level (:ams) and pitch (:fms). Inline, as a macro, or in a def-fm.',
    insert: ':fb 5',
    example: '(fm1 :len 8 c e :fb 6 c e :alg 7 c e)',
  },
  {
    name: 'operator params', aliases: [':tl1', ':ar1', ':dr1', ':sr1', ':rr1', ':sl1', ':ml1', ':dt1', ':ks1', ':ssg1', ':am1', 'tl', 'ar'],
    prefixes: [':tl', ':ar', ':dr', ':sr', ':rr', ':sl', ':ml', ':dt', ':ks', ':ssg', ':am'],
    cat: 'fm', section: '§10', tracks: FM,
    syntax: ':tl1–:tl4 0–127  ·  :ar :dr :sr 0–31  ·  :rr :sl :ml 0–15  ·  :dt −3–3  ·  :ks 0–3  ·  :ssg 0–15  ·  :am 0–1  (1–4)',
    summary: 'One operator\'s register: a value, a curve (a sweep), none (stop a sweep), $slot, or :tl1+ N / :tl1* R relative to its live value.',
    insert: ':tl1 30',
    example: '(fm1 :len 8 c e :tl1 (linear 0..60 :len 1) g e c e g e)',
  },
  {
    name: '(param-set …)', aliases: ['param-set'], cat: 'fm', section: '§5.1', tracks: null,
    syntax: '(param-set :target v :target v …)',
    summary: 'Several absolute register writes at once.',
    insert: '(param-set :tl1 20 :tl2 30)',
    example: '(fm1 :len 8 c e (param-set :fb 6 :tl1 20) g e)',
  },

  // ---- definitions and values ----------------------------------------------
  {
    name: 'def', aliases: ['snippet', 'constant'], cat: 'defs', section: '§9', tracks: null,
    syntax: '(def name item …)',
    summary: 'A snippet: its items are pasted wherever the name is written — a phrase, a macro, a constant. Don\'t name one like a note (a–g, e8): the note wins.',
    insert: '(def riff c e g e)',
    example: '(def riff c e g e)\n(fm1 :len 8 riff riff > riff <)',
  },
  {
    name: 'def (parametric)', aliases: ['function', 'fn'], cat: 'defs', section: '§9.1', tracks: null,
    syntax: '(def (name param …) item …)',
    summary: 'A snippet with parameters: (name arg …) pastes the body with each argument in place of its parameter.',
    insert: '(def (beat n) (x 4 > n < n))',
    example: '(def (beat n) (x 2 > n < n))\n(fm1 :len 8 (beat c) (beat e))',
  },
  {
    name: 'def-val', aliases: ['$', 'slot', 'runtime value', ':unit'], cat: 'defs', section: '§8', tracks: null,
    syntax: '(def-val name init A..B)  ·  $name',
    summary: 'A runtime value slot the game (or a Live slider) writes; $name reads it where a value goes.',
    insert: '(def-val bright 20 0..40)',
    example: '(def-val bright 20 0..40)\n(fm1 :len 8 :tl1 $bright c e g e)',
  },
  {
    name: 'def-se', aliases: ['sound effect', 'se'], cat: 'defs', section: '§9.3', tracks: null,
    syntax: '(def-se name [:prio N] [:tempo T] (channel …) …)',
    summary: 'A sound effect: parts the game starts by number, taking channels from the song while they play.',
    insert: '(def-se jump :prio 3 (sqr3 :oct 5 :len 32 c e g > c))',
    example: '(def-se jump :prio 3 (sqr3 :oct 5 :len 32 c e g > c))\n(fm1 c e g)',
  },
  {
    name: '(let …)', aliases: ['let'], cat: 'defs', section: '§7.2', tracks: null,
    syntax: '(let ((name expr) …) body …)',
    summary: 'Local values for the body, evaluated at compile time.',
    insert: '(let ((root 60)) (note root) (note (+ root 7)))',
    example: '(fm1 :len 8 (let ((root 60)) (note root) (note (+ root 4)) (note (+ root 7))))',
  },
  {
    name: '(note …)', aliases: ['note', 'midi'], cat: 'defs', section: '§7.3', tracks: null,
    syntax: '(note expr [len])',
    summary: 'A note at a computed MIDI number (60 = middle C).',
    insert: '(note 60)',
    example: '(fm1 :len 8 (note 60) (note 64) (note 67) (note 72 4))',
  },
  {
    name: 'arithmetic', aliases: ['+', '-', '*', '/', 'min', 'max', 'abs', 'round', 'floor', 'ticks', 'frames'],
    cat: 'defs', section: '§7.1', tracks: null,
    syntax: '(+ a b)  (- a b)  (* a b)  (/ a b)  (min …)  (max …)  (abs x)  (round x)  (floor x)',
    summary: 'Compile-time arithmetic wherever a value goes; with a $slot inside it becomes a runtime expression. (ticks n) / (frames n) make a length.',
    insert: '(+ 20 10)',
    example: '(def depth 20)\n(fm1 :len 8 :tl1 (+ depth 10) c e g e)',
  },

  // ---- macros --------------------------------------------------------------
  {
    name: '(macro …)', aliases: ['macro', 'envelope'], cat: 'macros', section: '§10', tracks: null,
    syntax: '(macro :target spec …)  ·  (macro :target none)  ·  (macro none)',
    summary: 'Per-note automation, sticky: every following note runs it until cleared. Targets: :vel :vol :master :pitch :semi :keyon :pan :mode :lfo-rate and the FM registers.',
    insert: '(macro :vel [15 12 9 6 3])',
    example: '(def pluck (macro :vel [15 12 9 6 3]))\n(sqr1 :oct 5 :len 8 pluck c e g e)',
  },
  {
    name: '#sus #rel', aliases: ['#sus', '#rel', 'sustain', 'release', 'loop point'], cat: 'macros', section: '§10', tracks: null,
    syntax: '[15 #sus 13 #rel 8 4 0]',
    summary: 'Marks in a step vector: the steps after #sus loop until key-off, then the run from #rel plays.',
    insert: '(macro :vel [15 #sus 13 #rel 8 4 0])',
    example: '(sqr1 :oct 5 :len 4 :gate* 0.6 (macro :vel [15 #sus 13 #rel 8 4 0]) c e g e)',
  },
  {
    name: ':step', cat: 'macros', section: '§10', tracks: null,
    syntax: '(macro :step L …)',
    summary: 'How long each macro value lasts: frames (2f) or a note length (16, on the beat). Default one frame.',
    insert: ':step 2f',
    example: '(sqr1 :oct 5 :len 4 (macro :step 4f :vel [15 12 9 6 3 0]) c e g e)',
  },
  {
    name: ':pitch', aliases: [':pitch+', 'vibrato', 'bend'], cat: 'macros', section: '§10', tracks: FM_PSG,
    syntax: ':pitch cents  ·  (macro :pitch spec)',
    summary: 'A pitch offset in cents, with no new attack — vibrato as a macro, a bend inline. :pitch+ adds to the live offset.',
    insert: '(macro :pitch (sin -30..30 :len 8f))',
    example: '(fm1 :len 2 (macro :pitch (sin -30..30 :len 8f :wait 8)) c e)',
  },
  {
    name: ':semi', aliases: [':semi+', 'arpeggio'], cat: 'macros', section: '§10', tracks: FM_PSG,
    syntax: '(macro :semi [0 4 7])',
    summary: 'Semitone steps (±48) with no new attack — the chiptune arpeggio.',
    insert: '(macro :step 1/16 :semi [#sus 0 4 7])',
    example: '(sqr1 :oct 5 :len 2 (macro :step 2f :semi [#sus 0 4 7]) c f)',
  },
  {
    name: ':keyon', aliases: ['retrigger'], cat: 'macros', section: '§10', tracks: FM,
    syntax: '(macro :keyon [1 0 …])',
    summary: 'Re-attacks the note wherever the value is 1 — with :semi, an arpeggio that re-keys.',
    insert: ':keyon 1',
    example: '(fm1 :len 2 (macro :step 1/16 :semi [#sus 0 4 7] :keyon 1) c f)',
  },
  {
    name: '(wait …)', aliases: ['wait'], cat: 'macros', section: '§10', tracks: null,
    syntax: '[v (curve …) (wait L) …]  ·  (wait key-off)',
    summary: 'A stage in a macro vector: holds the value for a length, or until the note\'s key-off.',
    insert: '(wait 8)',
    example: '(sqr1 :oct 5 :len 2 (macro :vel [15 (wait 8) (linear 15..0 :len 8)]) c e)',
  },

  // ---- curves --------------------------------------------------------------
  {
    name: 'linear', cat: 'curves', section: '§11', tracks: null,
    syntax: '(linear A..B :len L)',
    summary: 'A straight ramp from A to B over L. Where a value goes: inline it sweeps the register, in a macro it shapes each note.',
    insert: '(linear 0..100 :len 8)',
    example: '(fm1 :len 4 :tl1 (linear 0..60 :len 1) c e g e)',
  },
  {
    name: 'ease-*', aliases: ['ease-in', 'ease-out', 'ease-inout', 'easing'], prefixes: ['ease-'], cat: 'curves', section: '§11', tracks: null,
    syntax: '(ease-out A..B :len L)  ·  ease-{in,out,inout}-{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}',
    summary: 'Eased ramps: slow at the start (in), the end (out) or both.',
    insert: '(ease-out 0..100 :len 8)',
    example: '(fm1 :len 4 :vol (ease-out-expo 31..4 :len 1) c e g e)',
  },
  {
    name: 'loop waves', aliases: ['sin', 'triangle', 'square', 'saw', 'ramp', 'lfo'], cat: 'curves', section: '§11', tracks: null,
    syntax: '(sin A..B :len L)  ·  triangle  ·  square [:duty]  ·  saw  ·  ramp  [:skew]',
    summary: 'Waves that cycle until key-off, one period per :len; :phase, :rate and :mode shot shape them.',
    insert: '(sin -20..20 :len 16)',
    example: '(fm1 :len 2 (macro :pitch (sin -25..25 :len 8f)) c e)',
  },
  {
    name: 'noise curves', aliases: ['pink', 'perlin', 'brown', 'random', ':seed', ':hold', ':jitter', ':beta',
      ':octaves', ':lacunarity', ':persistence', ':leak'], cat: 'curves', section: '§11', tracks: null,
    syntax: '(noise A..B :len L [:seed N] [:hold L])  ·  pink  ·  perlin  ·  brown',
    summary: 'Random curves, macro only (the driver has no random source for an inline sweep). :seed picks the sequence; :hold L keeps each value for the length L.',
    insert: '(macro :pitch (perlin -30..30 :len 8))',
    example: '(sqr1 :oct 5 :len 2 (macro :pitch (brown -40..40 :len 16f :seed 7)) c e)',
  },
  {
    name: 'curve options', aliases: [':phase', ':rate', ':wait', ':duty', ':skew', ':from', ':to'], cat: 'curves', section: '§11', tracks: null,
    syntax: ':from :to  ·  :len  ·  :phase 0–255  ·  :rate R  ·  :mode loop|shot  ·  :wait L|key-off',
    summary: 'Options every curve takes: endpoints (A..B), length, start phase, speed, looping, and a delay before it starts.',
    insert: ':wait 8',
    example: '(fm1 :len 2 (macro :pitch (sin -30..30 :len 8f :wait 4 :rate 2)) c e)',
  },

  // ---- echo, delay, glide --------------------------------------------------
  {
    name: '(echo …)', aliases: ['echo', 'repeat', ':back'], cat: 'effects', section: '§12', tracks: null,
    syntax: '(echo N :vel+ step | :vel* ratio [:back B])',
    summary: 'Replays the last note (or the one B back) N times at the current :len, each quieter — it takes time.',
    insert: '(echo 3 :vel+ -2)',
    example: '(fm1 :len 8 c (echo 3 :vel+ -3) e (echo 2 :vel* 0.6))',
  },
  {
    name: '(delay …)', aliases: ['delay', ':time'], cat: 'effects', section: '§12', tracks: null,
    syntax: '(delay N :vel+ step | :vel* ratio :time T)  ·  (delay none)',
    summary: 'Sticky: every following note echoes at +k·T into the gaps the part leaves, never over a written note.',
    insert: '(delay 3 :vel+ -4 :time 1/8)',
    example: '(fm1 (delay 3 :vel+ -4 :time 1/8) :len 4 c _ e _)',
  },
  {
    name: '(glide …)', aliases: ['glide', 'portamento'], cat: 'effects', section: '§14', tracks: FM_PSG,
    syntax: '(glide T)  ·  (glide from T)  ·  (glide none)',
    summary: 'Portamento into each following note over T, from the pitch sounding (a T longer than the notes lags behind them); from sets the next glide\'s start pitch.',
    insert: '(glide 8)',
    example: '(fm1 :len 4 (glide 16) c g e > c (glide none) < c)',
  },

  // ---- loops and flow ------------------------------------------------------
  {
    name: '(x …)', aliases: ['x', 'repeat'], cat: 'flow', section: '§13', tracks: null,
    syntax: '(x N body …)  ·  (x body …)',
    summary: 'Plays the body N times (forever without N). The body compiles once: (x 4 c >) plays c c c c.',
    insert: '(x 4 c e g e)',
    example: '(fm1 :len 8 (x 2 c e g e) (x 2 d f a f))',
  },
  {
    name: '#label (go …)', aliases: ['#', 'go', 'label', 'song loop'], cat: 'flow', section: '§13', tracks: null,
    syntax: '#name … (go name)  ·  (go name N)',
    summary: 'A position, and a jump back to it: forever — the song loop — or so the section plays N times.',
    insert: '#top\n  \n  (go top)',
    example: '(fm1 :len 8 #verse c e g e (go verse 2) c2)',
  },
  {
    name: '(break)', aliases: ['break'], cat: 'flow', section: '§13', tracks: null,
    syntax: '(x N … (break) …)',
    summary: 'On the last pass of the enclosing counted loop, leaves it here.',
    insert: '(break)',
    example: '(fm1 :len 8 (x 3 c e (break) g e) c2)',
  },
  {
    name: '(trig N)', aliases: ['trig', 'cue', 'sync'], cat: 'flow', section: '§13', tracks: null,
    syntax: '(trig N)',
    summary: 'A cue the game reads (N 0–63) — music-to-game sync. The Live log shows it as it passes.',
    insert: '(trig 1)',
    example: '(fm1 :len 4 c e (trig 1) g e)',
  },

  // ---- FM3 and CSM ---------------------------------------------------------
  {
    name: 'fm3-1–fm3-4', aliases: ['fm3-1', 'fm3-2', 'fm3-3', 'fm3-4', 'independent operator'], cat: 'fm3', section: '§15', tracks: FM,
    syntax: '(fm3 voice)  (fm3-1 …) … (fm3-4 …)',
    summary: 'FM3 with one pitch per operator: each fm3-N track plays one operator; a note-less (fm3 voice) gives the shared patch.',
    insert: '(fm3-1 :len 8 c e g e)',
    example: '(def-fm kit init-fm :alg 7 :tl1 20 :tl2 30 :tl3 25 :tl4 0)\n(fm3 kit)\n(fm3-1 :oct 5 :len 8 c c)\n(fm3-2 :oct 3 :len 4 c _)',
  },
  {
    name: 'fm3-csm', aliases: ['csm', 'fm3-csm-rate', ':csm-rate', 'formant'], cat: 'fm3', section: '§15', tracks: FM,
    syntax: '(fm3-csm voice …)  ·  (fm3-csm-rate …)  ·  :csm-rate Hz',
    summary: 'CSM: the fm3-csm note is the formant, Timer A\'s rate the buzz pitch — from :csm-rate or an fm3-csm-rate track of notes.',
    insert: '(fm3-csm-rate :oct 6 :len 1 c d e f)',
    example: '(def-fm brass init-fm :alg 4 :tl1 24 :tl3 24)\n(fm3-csm brass :oct 4 :len 2 c _ e _)\n(fm3-csm-rate :oct 6 :len 1 c d)',
  },

  // ---- PCM -----------------------------------------------------------------
  {
    name: 'def-pcm', aliases: ['sample', 'wav', ':file', ':rate'], cat: 'pcm', section: '§16', tracks: PCM,
    syntax: '(def-pcm name :file "x.wav" [:rate Hz] …)  ·  (def-pcm name base …)',
    summary: 'A sample from a WAV, relative to the score; a leading name extends another sample. Baked to 8-bit at each pitch played.',
    insert: '(def-pcm hit :file "sounds/hit.wav")',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm big-snare snare :fx [(gain 4)])\n(pcm1 :len 8 kick c big-snare c)',
  },
  {
    name: 'range points', aliases: [':pcm-start', ':pcm-end', ':pcm-len', 'trim'], cat: 'pcm', section: '§16', tracks: PCM,
    syntax: ':pcm-start L  ·  :pcm-end L  ·  :pcm-len L',
    summary: 'The part of the sample a note plays, as lengths (100ms) — on the def, or on the track as a value or curve.',
    insert: ':pcm-start 20ms',
    example: '(import "presets/orch/set.mmlisp")\n(def-pcm hit-tail orch-hit :pcm-start 80ms)\n(pcm1 :len 4 orch-hit c hit-tail c)',
  },
  {
    name: 'loop points', aliases: [':loop-start', ':loop-end', ':loop-len', 'sustain loop'], cat: 'pcm', section: '§16', tracks: PCM,
    syntax: ':loop-start L  ·  :loop-end L  ·  :loop-len L  (with :mode loop)',
    summary: 'The loop a held :mode loop note repeats inside the range, then it runs on to the end after its note-off.',
    insert: ':loop-start 300ms :loop-len 100ms',
    example: '(import "presets/orch/set.mmlisp")\n(def-pcm held orch-hit :loop-start 60ms :loop-len 40ms)\n(pcm1 held :mode loop :len 2 c _)',
  },
  {
    name: ':offset :frames', aliases: [':offset', ':frames', 'sample bank', 'slice'], cat: 'pcm', section: '§16', tracks: PCM,
    syntax: '(def-pcm name :file "kit.wav" :offset F :frames N)',
    summary: 'Cut one sample out of a file that holds several, in frames.',
    insert: ':offset 0 :frames 4000',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm kick-short kick :frames 2000)\n(pcm1 :len 8 kick c kick-short c)',
  },

  // ---- sample effects ------------------------------------------------------
  {
    name: ':fx', aliases: ['effects', 'fx chain'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: ':fx [(effect :param v …) …]',
    summary: 'A def-pcm\'s processing chain, run in order when the sample is baked — no driver cost.',
    insert: ':fx [(normalize)]',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm loud-snare snare :fx [(comp :threshold -30 :ratio 8) (normalize)])\n(pcm1 :len 8 snare c loud-snare c)',
  },
  {
    name: '(gain …)', aliases: ['gain', ':db'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(gain dB)',
    summary: 'Scales the level by dB, positive louder. Nothing clips until the chain ends.',
    insert: '(gain 6)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm loud snare :fx [(gain 6)])\n(pcm1 :len 8 snare c loud c)',
  },
  {
    name: '(normalize …)', aliases: ['normalize', ':peak'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(normalize [:peak dBFS])',
    summary: 'Scales so the peak lands on :peak (default 0 dBFS).',
    insert: '(normalize)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm full clap :fx [(normalize)])\n(pcm1 :len 8 clap c full c)',
  },
  {
    name: '(comp …)', aliases: ['comp', 'compressor', ':threshold', ':ratio', ':attack', ':release', ':knee', ':makeup'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(comp :threshold dB :ratio R :attack L :release L :knee dB :makeup dB)',
    summary: 'A compressor: above the threshold the level rises 1/ratio as fast.',
    insert: '(comp :threshold -18 :ratio 4)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm fat kick :fx [(comp :threshold -30 :ratio 8) (normalize)])\n(pcm1 :len 8 kick c fat c)',
  },
  {
    name: '(limit …)', aliases: ['limit', 'limiter', ':ceiling'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(limit [:ceiling dBFS])',
    summary: 'A brickwall limiter: the peak never passes the ceiling.',
    insert: '(limit)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm hot snare :fx [(gain 12) (limit)])\n(pcm1 :len 8 snare c hot c)',
  },
  {
    name: '(crush …)', aliases: ['crush', 'bitcrush', 'lo-fi', ':bits'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(crush :bits N)',
    summary: 'Quantizes to N bits — the lo-fi step.',
    insert: '(crush :bits 4)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm lofi snare :fx [(crush :bits 3)])\n(pcm1 :len 8 snare c lofi c)',
  },
  {
    name: '(hpf …)', aliases: ['hpf', 'high-pass', 'low cut', ':freq'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(hpf :freq Hz)',
    summary: 'High-pass filter, 12 dB/oct: cuts below :freq — a low cut also buys level headroom.',
    insert: '(hpf 100)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm thin snare :fx [(hpf 800)])\n(pcm1 :len 8 snare c thin c)',
  },
  {
    name: '(lpf …)', aliases: ['lpf', 'low-pass', 'high cut', 'filter'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(lpf :freq Hz)',
    summary: 'Low-pass filter, 12 dB/oct: cuts above :freq — darker, duller.',
    insert: '(lpf 3000)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm dull snare :fx [(lpf 1500)])\n(pcm1 :len 8 snare c dull c)',
  },
  {
    name: '(drive …)', aliases: ['drive', 'saturation', 'distortion', 'overdrive'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(drive :db N)',
    summary: 'Soft saturation (tanh): N dB into it; a full-scale peak stays full scale, quieter parts come up.',
    insert: '(drive 12)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm dirty snare :fx [(drive 18)])\n(pcm1 :len 8 snare c dirty c)',
  },
  {
    name: '(fade …)', aliases: ['fade', ':at', ':curve'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(fade :at L :len L [:curve name])',
    summary: 'Fades to silence from :at over :len and cuts the sample there — it saves bank bytes.',
    insert: '(fade :at 120ms :len 80ms)',
    example: '(import "presets/orch/set.mmlisp")\n(def-pcm short orch-hit :fx [(fade :at 60ms :len 60ms)])\n(pcm1 :len 4 orch-hit c short c)',
  },
  {
    name: '(reverb …)', aliases: ['reverb', 'room', ':size', ':damp', ':mix', ':predelay', ':tail'], cat: 'fx', section: '§16', tracks: PCM,
    syntax: '(reverb :size :damp :mix :predelay :tail L)',
    summary: 'A Freeverb-style room; grows the sample by :tail and fades the tail out.',
    insert: '(reverb :tail 250ms)',
    example: '(import "presets/tr808/set.mmlisp")\n(def-pcm roomy clap :fx [(reverb :tail 300ms)])\n(pcm1 :len 4 clap c roomy c)',
  },
];

// The entry a word of the language belongs to — a form head, a keyword, a
// track name — by its name, an alias or a prefix; null when none does. The
// completion's info and the editor's hover read it.
let _index = null;
export function referenceFor(word) {
  if (!_index) {
    _index = { exact: new Map(), prefixes: [] };
    for (const e of REFERENCE) {
      for (const n of [e.name, ...(e.aliases ?? [])]) if (!_index.exact.has(n)) _index.exact.set(n, e);
      for (const p of e.prefixes ?? []) _index.prefixes.push([p, e]);
    }
  }
  return _index.exact.get(word) ?? _index.prefixes.find(([p]) => word.startsWith(p))?.[1] ?? null;
}
