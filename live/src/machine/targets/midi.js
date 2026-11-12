// MIDI: a General MIDI instrument's channels — ch1–ch16 but ch10, which is
// the drums (drum1–drum8). No driver and no sound of its own
// (chips/midi.js): the score is delivered as a Standard MIDI File, and Live
// plays it to a MIDI output.
import { midi, midiChannel, midiDrums } from "../chips/midi.js";

const on = (part, voice, scope) => ({ chip: "midi", part, voice, scope });

export default {
  name: "midi",
  system: "MIDI",
  driver: null,
  // Its sound a MIDI output's (targets.js `sound`): a port, or the GM
  // SoundFont, which its WAV and stems render on (export-wav.js → gm-render.js).
  sound: "midi",
  chips: { midi },
  channels: {
    ...Object.fromEntries([...Array(16).keys()].filter((v) => v !== 9).map((v) => [`ch${v + 1}`, on(midiChannel, v, v)])),
    // The drums: channel 10, eight tracks of it, so hits sound together (a
    // kick under a hat), as a ROM rhythm's tracks do (the YM2608 has six) —
    // each a voice of the part, all on channel 10 (export-midi.js names them).
    ...Object.fromEntries([...Array(8).keys()].map((v) => [`drum${v + 1}`, on(midiDrums, v, 9)])),
  },
  hints: {},
};
