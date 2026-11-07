// ---------------------------------------------------------------------------
// The MIDI target's synth: silence, on synth-md.js's contract.
//
// `:target midi` has no sound of its own (chips/midi.js): while Live plays
// it the IR player keeps the clock and the sound is a MIDI output's
// (midi-output.js). The worklet still needs a synth to run, and this is one
// that writes nothing and renders a floor, not zeros.
//
// The floor: a constant a few 16-bit steps over zero (−78 dBFS), far under
// hearing. A phone's output here is a stream (index.html synthOutput: an
// <audio> playing the context, for playing in the background), and on an
// iPhone a stream of exact zeros came out as a low rumble; the chips never
// send one (the Mega Drive's DAC rests at a DC of 0.023).
// ---------------------------------------------------------------------------

import { pitchLatches } from "./scope-pitch.js";

export const SCOPE_LANES = 0;
const FLOOR = 1 / 8192;

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
      outL[i] = FLOOR;
      outR[i] = FLOOR;
    }
  }
}
