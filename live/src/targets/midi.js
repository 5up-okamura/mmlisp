// MIDI: a General MIDI instrument's channels — ch1–ch16 but ch10, which is
// the drums (drums, drums2–drums4). No driver and no sound of its own
// (chips/midi.js): the score is delivered as a Standard MIDI File, and Live
// plays it to a MIDI output.
import { midi, midiChannel, midiDrums } from "../chips/midi.js";

const on = (part, voice, scope) => ({ chip: "midi", part, voice, scope });

export default {
  name: "midi",
  system: "MIDI",
  driver: null,
  // No sound of its own: no WAV, VGM, stems or video (export-wav.js).
  sound: false,
  chips: { midi },
  channels: {
    ...Object.fromEntries([...Array(16).keys()].filter((v) => v !== 9).map((v) => [`ch${v + 1}`, on(midiChannel, v, v)])),
    // The drums: channel 10, four tracks of it, so hits sound together (a
    // kick under a hat) as a ROM rhythm's tracks do — each a voice of the
    // part, all on channel 10 (export-midi.js names them so).
    drums: on(midiDrums, 0, 9),
    drums2: on(midiDrums, 1, 9),
    drums3: on(midiDrums, 2, 9),
    drums4: on(midiDrums, 3, 9),
  },
  hints: {},
};
