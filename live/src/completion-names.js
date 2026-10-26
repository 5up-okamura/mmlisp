// The words the editor's completion offers: form heads after `(`, keyword
// params after `:`, and `:mode` values. Kept apart from the page so
// `check:reference` can hold every one of them to an entry in reference.js —
// a name the completion offers is a name the reference explains.

// After '(' — the def heads, the forms, the compile-time eval heads (§7), the
// curves (§11) and the def-pcm :fx effects (§16).
import { ALL_CHANNEL_NAMES, partsWithWord } from "./targets.js";
import { FM_CHANNEL_WORDS, opWords } from "./chips/fm-words.js";

export const AC_FORMS = [
  'def', 'def-val', 'def-fm', 'def-pcm', 'def-wave', 'def-se', 'def-score', 'def-mod', 'import',
  't', 'x', 'go', 'break', 'trig', 'param-set',
  'echo', 'delay', 'glide', 'macro', 'wait',
  'let', 'for', 'if', 'note', 'ticks', 'frames',
  'min', 'max', 'abs', 'round', 'floor', 'mod', 'not', 'midi', 'hz',
  'linear',
  'ease-in', 'ease-out', 'ease-inout',
  ...['sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'elastic', 'bounce']
    .flatMap((k) => [`ease-in-${k}`, `ease-out-${k}`, `ease-inout-${k}`]),
  'sin', 'triangle', 'square', 'saw', 'ramp',
  'noise', 'pink', 'perlin', 'brown',
  'gain', 'normalize', 'comp', 'limit', 'crush', 'hpf', 'lpf', 'drive', 'fade', 'reverb',
];

export const AC_TRACKS = [
  ...ALL_CHANNEL_NAMES, // every target's (targets/)
];

// The FM family's words (chips/fm-words.js): the channel's, and each
// operator's (1–4) some part has — the OPLL's own words on its two.
const AC_FM_PARAMS = [...FM_CHANNEL_WORDS, ...opWords()].filter((w) => partsWithWord(w.word).length).map((w) => w.kw);

// After ':' — the keywords the compiler accepts (mmlisp2ir.js: canonicalTarget,
// the track and note options, the def keys, the curve and effect params).
export const AC_PARAMS = [
  // song-wide (written on a track; §1) and the def-score keys
  ':tempo', ':lfo-rate', ':master', ':title', ':composer', ':author', ':pcm-voices', ':target',
  ':noise-rate', ':env-rate', ':lfo-freq', ':lfo-pmd', ':lfo-amd', ':lfo-wave',
  // track / channel
  ':prio', ':oct', ':oct+', ':len', ':gate', ':gate*', ':gate-',
  ':vel', ':vel+', ':vel*', ':vol', ':pan', ':snap', ':mode', ':env', ':env-semi', ':env-detune', ':shuffle', ':shuffle-base',
  // note dynamics / sequencer
  ':pitch', ':pitch+', ':semi', ':semi+', ':keyon', ':csm-rate',
  // echo / delay, macro, def-val, def-mod
  ':back', ':time', ':step', ':unit', ':public', ':ch', ':voice',
  // import
  ':over',
  // def-fm
  ':key',
  // def-pcm and the track's PCM points
  ':file', ':rate', ':offset', ':frames',
  ':wave', // def-wave
  ':pcm-start', ':pcm-end', ':pcm-len', ':loop-start', ':loop-end', ':loop-len',
  // :fx effect params
  ':fx', ':db', ':peak', ':threshold', ':ratio', ':attack', ':release',
  ':knee', ':makeup', ':ceiling', ':bits', ':at', ':curve',
  ':size', ':damp', ':mix', ':predelay', ':tail',
  // curve params
  ':from', ':to', ':phase', ':wait', ':duty', ':skew', ':hold', ':jitter',
  ':beta', ':octaves', ':lacunarity', ':persistence', ':leak', ':seed',
  // FM
  ...AC_FM_PARAMS,
];

export const AC_MODE_VALUES = ['shot', 'loop', 'gate'];
