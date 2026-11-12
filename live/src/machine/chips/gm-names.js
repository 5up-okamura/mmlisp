// ---------------------------------------------------------------------------
// General MIDI's names, as the language has them: the 128 programs as the gm
// preset set's voices (presets/gm), the voices named for an instrument (the
// roles, the OPLL's ROM) as the program each stands for, and the drum keys
// as the kit roles (presets/gm-drums). Read by the MIDI chip (chips/midi.js),
// the MIDI export (midi-plan.js) and the imports (import-midi.js,
// import-sf2.js).
// ---------------------------------------------------------------------------

/** The GM programs, in order: the gm preset set's voices (presets/gm). */
export const GM_PROGRAMS = [
  "gm-piano", "gm-piano-bright", "gm-piano-e-grand", "gm-honkytonk", "gm-ep1", "gm-ep2", "gm-harpsi", "gm-clav",
  "gm-celesta", "gm-glock", "gm-musicbox", "gm-vibes", "gm-marimba", "gm-xylo", "gm-tubular", "gm-dulcimer",
  "gm-organ-drawbar", "gm-organ-perc", "gm-organ-rock", "gm-organ-church", "gm-organ-reed", "gm-accordion", "gm-harmonica", "gm-bandoneon",
  "gm-guitar-nylon", "gm-guitar-steel", "gm-guitar-jazz", "gm-guitar-clean", "gm-guitar-mute", "gm-guitar-od", "gm-guitar-dist", "gm-guitar-harm",
  "gm-bass-acoustic", "gm-bass-finger", "gm-bass-pick", "gm-bass-fretless", "gm-bass-slap1", "gm-bass-slap2", "gm-bass-syn1", "gm-bass-syn2",
  "gm-violin", "gm-viola", "gm-cello", "gm-contrabass", "gm-str-trem", "gm-str-pizz", "gm-harp", "gm-timpani",
  "gm-strings1", "gm-strings2", "gm-synstr1", "gm-synstr2", "gm-choir", "gm-voice-ooh", "gm-synvox", "gm-orch-hit",
  "gm-trumpet", "gm-trombone", "gm-tuba", "gm-trumpet-mute", "gm-horn", "gm-brass", "gm-synbrass1", "gm-synbrass2",
  "gm-sax-soprano", "gm-sax-alto", "gm-sax-tenor", "gm-sax-bari", "gm-oboe", "gm-english-horn", "gm-bassoon", "gm-clarinet",
  "gm-piccolo", "gm-flute", "gm-recorder", "gm-panflute", "gm-bottle", "gm-shakuhachi", "gm-whistle", "gm-ocarina",
  "gm-lead-square", "gm-lead-saw", "gm-lead-calliope", "gm-lead-chiff", "gm-lead-charang", "gm-lead-voice", "gm-lead-fifths", "gm-lead-basslead",
  "gm-pad-newage", "gm-pad-warm", "gm-pad-poly", "gm-pad-choir", "gm-pad-bowed", "gm-pad-metal", "gm-pad-halo", "gm-pad-sweep",
  "gm-fx-rain", "gm-fx-soundtrack", "gm-fx-crystal", "gm-fx-atmos", "gm-fx-bright", "gm-fx-goblins", "gm-fx-echoes", "gm-fx-scifi",
  "gm-sitar", "gm-banjo", "gm-shamisen", "gm-koto", "gm-kalimba", "gm-bagpipe", "gm-fiddle", "gm-shanai",
  "gm-tinkle", "gm-agogo", "gm-steeldrum", "gm-woodblock", "gm-taiko", "gm-tom-melodic", "gm-syndrum", "gm-revcymbal",
  "gm-fretnoise", "gm-breath", "gm-seashore", "gm-bird", "gm-phone", "gm-heli", "gm-applause", "gm-gunshot",
];
/**
 * The voices named for an instrument, as the gm voice they stand for: the
 * fifteen melodic roles (presets/fm-roles, each its gm voice's copy, and the
 * OPLL's ROM names — the FM-PAC's and the VRC7's built in, a 4-op reading
 * elsewhere), and the VRC7's own ROM names.
 */
export const NAMED_VOICES = {
  piano: "gm-piano", harpsichord: "gm-harpsi", vibraphone: "gm-vibes", organ: "gm-organ-drawbar",
  guitar: "gm-guitar-nylon", "electric-guitar": "gm-guitar-clean", "acoustic-bass": "gm-bass-acoustic",
  "synth-bass": "gm-bass-syn1", violin: "gm-violin", trumpet: "gm-trumpet", horn: "gm-horn",
  oboe: "gm-oboe", clarinet: "gm-clarinet", flute: "gm-flute", synth: "gm-lead-saw",
  // The VRC7's ROM beside those (chips/vrc7.js VRC7_ROM_NAMES).
  "buzzy-bell": "gm-glock", wurly: "gm-ep1", bells: "gm-tubular", vibes: "gm-vibes",
  tutti: "gm-strings1", fretless: "gm-bass-fretless", sweep: "gm-pad-sweep",
};
const GM_PROGRAM_OF = new Map(GM_PROGRAMS.map((name, i) => [name, i]));
/** The GM program a voice named `name` is, or undefined. */
export const programOf = (name) => GM_PROGRAM_OF.get(NAMED_VOICES[name] ?? name);
/**
 * The GM drum keys and the kit roles they are (presets/gm-drums, the names
 * a SoundFont kit is read under: import-sf2.js), and the other way round.
 */
export const GM_KIT_ROLES = {
  35: "kick2", 36: "kick", 37: "rim", 38: "snare", 39: "clap", 40: "snare2", 41: "tom1", 42: "hat",
  43: "tom2", 44: "hat-pedal", 45: "tom3", 46: "hat-open", 47: "tom4", 48: "tom5", 49: "crash", 50: "tom6",
  51: "ride", 52: "china", 53: "ride-bell", 54: "tamb", 55: "splash", 56: "cowbell", 57: "crash2",
  58: "vibraslap", 59: "ride2", 60: "bongo-hi", 61: "bongo-lo", 62: "conga-mute", 63: "conga-hi",
  64: "conga-lo", 65: "timbale-hi", 66: "timbale-lo", 67: "agogo-hi", 68: "agogo-lo", 69: "cabasa",
  70: "maracas", 71: "whistle", 72: "whistle-long", 73: "guiro", 74: "guiro-long", 75: "claves",
  76: "woodblock-hi", 77: "woodblock-lo", 78: "cuica-mute", 79: "cuica", 80: "triangle-mute",
  81: "triangle", 85: "castanets",
};
/** A kit role → its GM drum note. */
export const GM_DRUM_NOTE = Object.fromEntries(Object.entries(GM_KIT_ROLES).map(([note, role]) => [role, Number(note)]));
