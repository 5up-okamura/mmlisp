// The YM2608's rhythm as the imports write it without a rhythm ROM: its six
// sounds on the RX5 kit's roles (presets/rx5), each with its priority and
// how long it rings. mucom88's part G, a VGM's and a module's rhythm, a
// MIDI's kit and a machine conversion's all read it.

import { PPQN } from "./import-song.js";

// The six, in the order of the key-on bits (`@` is a mask) and of `v`'s
// levels: the sample, its priority (lower wins, as :prio) and how long it
// rings — the time the RX5 sample stays within 6 dB of its peak, during which
// a lower-priority hit is dropped rather than cutting it.
// `ms` is the sample's whole length, for the bank-fit bake.
export const RHYTHM_SOUNDS = [
  { name: "kick", prio: 4, ringMs: 40, ms: 160 }, // BD
  { name: "snare", prio: 1, ringMs: 60, ms: 220 }, // SD
  { name: "ride", prio: 3, ringMs: 350, ms: 600 }, // TOP (the OPNA's top cymbal is a ride)
  { name: "hat", prio: 6, ringMs: 40, ms: 120 }, // HH
  { name: "tom4", prio: 2, ringMs: 65, ms: 400 }, // TOM
  { name: "rim", prio: 5, ringMs: 15, ms: 80 }, // RIM
];
export const RHYTHM_KIT = "presets/rx5/set.mmlisp";
// A sound's ring time as the :gate its layer's hits hold the line for.
export const ringGate = (s, bpm) => `:gate ${Math.max(1, Math.round((s.ringMs / 1000) * ((bpm ?? 120) / 60) * PPQN))}t`;
