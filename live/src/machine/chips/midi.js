// MIDI (`:target midi`, language.md §19): fifteen melodic channels and the
// drums (eight tracks of channel 10), a General MIDI instrument's. A chip
// with no sound of its own: the score goes out as a Standard MIDI File
// (export-midi.js) and, while Live plays, to a MIDI output (midi-output.js).
// The IR player runs its clock and writes nothing (its `none` core).
import { words } from "./parts.js";
import { GM_KIT_ROLES, GM_PROGRAMS, NAMED_VOICES, programOf } from "./gm-names.js";

// A channel's controllers, CC0–CC127 (`:cc74`), each a value 0–127 a write,
// a macro or a sweep moves; its channel pressure; its program and bank, and
// its pitch bend's range, which a channel sets. A controller a word of the
// language writes is that word's (export-midi.js writes it): `:cc7` is
// refused for `:vol`, so the two never fight over CC7.
export const NAMED_CC = {
  0: ":bank", 32: ":bank", // its MSB and LSB
  6: ":bend-range", 38: ":bend-range", 100: ":bend-range", 101: ":bend-range", // RPN 0
  7: ":vol", 10: ":pan",
  11: "a :vel macro", // within a note, below its velocity
};
const CC = /^CC(\d|[1-9]\d|1[01]\d|12[0-7])$/;
const ownCC = (w) => CC.test(w) && !(Number(w.slice(2)) in NAMED_CC);

export const midiChannel = {
  name: "midi",
  label: "MIDI channel",
  kind: "midi",
  // Velocity is the language's :vel, its 2 dB steps read as a GM level.
  level: { scale: "linear", steps: 128 },
  words: words({ test: ownCC }, "PRESSURE", "PROG", "BANK", "BEND_RANGE", "PAN"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "a MIDI channel has no :mode; its sound is its :prog" },
  // A voice named for an instrument (gm-*, a role, a ROM voice's name) is a
  // program here: a channel naming it writes its PROG (mmlisp2ir emitVoice),
  // and the names are built in, as the OPLL's ROM voices are.
  programOf,
  programNames: [...GM_PROGRAMS, ...Object.keys(NAMED_VOICES)],
};

export const midiDrums = {
  name: "midi-drums",
  label: "MIDI drums",
  kind: "sample",
  // Each hit's velocity; the track's faders go into it.
  level: { scale: "linear", steps: 128 },
  // No :pan: the eight tracks share channel 10 and its one CC10 (a GM kit
  // pans its keys itself).
  words: words(),
  points: false,
  // The GM kit's roles, built in: `kick` plays key 36. A sample that is no
  // role plays its written note as the key (export-midi.js says so). The
  // kit's order is the drum tracks' first sounds in a new score.
  kit: Object.fromEntries([...new Set(["kick", "snare", "hat", "hat-open", "crash", "ride", "tom4", "tom2", ...Object.values(GM_KIT_ROLES)])].map((role) => [role, role])),
  // The mixer's strips are its tracks, not its sounds: the MIDI output keys
  // a track or not (stems.js mixerStrips).
  soundStrips: false,
  checkNote({ sample, sampleName, once }) {
    if (!sample.rhythm)
      once(`key:${sampleName}`, `${sampleName} is no GM kit role (kick, snare, hat …): on drum1–drum8 it plays its written note as the key`, "warning");
  },
};

export const midi = {
  chip: "midi",
  clock: 0,
  parts: [midiChannel, midiDrums],
  // Nothing to write and nothing to sound: the IR player keeps the clock,
  // and the score's sound is the MIDI output's.
  encoder: true,
  emulator: true,
};
