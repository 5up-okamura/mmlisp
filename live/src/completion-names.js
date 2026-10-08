// The words the editor's completion offers: form heads after `(`, keyword
// params after `:`, and `:mode` values. Kept apart from the page so
// `check:reference` can hold every one of them to an entry in reference.js —
// a name the completion offers is a name the reference explains.

// After '(' — the def heads, the forms, the compile-time eval heads (§7), the
// curves (§11) and the def-pcm :fx effects (§16).
export const AC_FORMS = [
  'def', 'def-val', 'def-fm', 'def-pcm', 'def-se', 'def-score', 'def-mod', 'import',
  't', 'x', 'go', 'break', 'trig', 'param-set',
  'echo', 'delay', 'glide', 'macro', 'wait',
  'let', 'note', 'ticks', 'frames',
  'min', 'max', 'abs', 'round', 'floor',
  'linear',
  'ease-in', 'ease-out', 'ease-inout',
  ...['sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'elastic', 'bounce']
    .flatMap((k) => [`ease-in-${k}`, `ease-out-${k}`, `ease-inout-${k}`]),
  'sin', 'triangle', 'square', 'saw', 'ramp',
  'noise', 'pink', 'perlin', 'brown',
  'gain', 'normalize', 'comp', 'limit', 'crush', 'hpf', 'lpf', 'drive', 'fade', 'reverb',
];

export const AC_TRACKS = [
  'fm1', 'fm2', 'fm3', 'fm3-csm', 'fm3-csm-rate', 'fm3-1', 'fm3-2', 'fm3-3', 'fm3-4',
  'fm4', 'fm5', 'fm6',
  'sqr1', 'sqr2', 'sqr3', 'noise',
  'pcm1', 'pcm2', 'pcm3',
];

// FM operator params, one per operator (1–4).
const AC_FM_OP_PARAMS = ['ar', 'dr', 'sr', 'rr', 'sl', 'tl', 'ml', 'dt', 'ks', 'ssg', 'am']
  .flatMap((p) => [1, 2, 3, 4].map((op) => `:${p}${op}`));

// After ':' — the keywords the compiler accepts (mmlisp2ir.js: canonicalTarget,
// the track and note options, the def keys, the curve and effect params).
export const AC_PARAMS = [
  // song-wide (written on a track; §1) and the def-score keys
  ':tempo', ':lfo-rate', ':master', ':title', ':composer', ':author', ':pcm-voices',
  // track / channel
  ':prio', ':oct', ':oct+', ':len', ':gate', ':gate*', ':gate-',
  ':vel', ':vel+', ':vel*', ':vol', ':pan', ':mode', ':shuffle', ':shuffle-base',
  // note dynamics / sequencer
  ':pitch', ':pitch+', ':semi', ':semi+', ':keyon', ':csm-rate',
  // echo / delay, macro, def-val, def-mod
  ':back', ':time', ':step', ':unit', ':ch', ':voice',
  // def-fm
  ':key',
  // def-pcm and the track's PCM points
  ':file', ':rate', ':offset', ':frames',
  ':pcm-start', ':pcm-end', ':pcm-len', ':loop-start', ':loop-end', ':loop-len',
  // :fx effect params
  ':fx', ':db', ':peak', ':threshold', ':ratio', ':attack', ':release',
  ':knee', ':makeup', ':ceiling', ':bits', ':at', ':curve',
  ':size', ':damp', ':mix', ':predelay', ':tail',
  // curve params
  ':from', ':to', ':phase', ':wait', ':duty', ':skew', ':hold', ':jitter',
  ':beta', ':octaves', ':lacunarity', ':persistence', ':leak', ':seed',
  // FM channel
  ':alg', ':fb', ':ams', ':fms',
  ...AC_FM_OP_PARAMS,
];

export const AC_MODE_VALUES = ['shot', 'loop'];
