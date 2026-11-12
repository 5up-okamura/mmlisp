// ---------------------------------------------------------------------------
// The MIDI target's synth: silence, on synth-md.js's contract.
//
// `:target midi` has no sound of its own (chips/midi.js): while Live plays
// it the IR player keeps the clock and the sound is a MIDI output's
// (midi-output.js). The worklet still needs a synth to run, and this is one
// that writes nothing and renders zeros.
// ---------------------------------------------------------------------------

import { pitchLatches } from "./scope-pitch.js";

export const SCOPE_LANES = 0;

export class MidiSynth {
  static async create(outputSR) {
    return new MidiSynth(outputSR);
  }

  constructor() {
    this.pitch = pitchLatches();
    this.bus = null;
    this.scopeLanes = SCOPE_LANES;
    this.pcmTaps = null;
  }

  reset() {}
  writeYM() {}
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  renderInto(outL, outR, count, onFrame = null) {
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      outL[i] = 0;
      outR[i] = 0;
    }
  }
}
