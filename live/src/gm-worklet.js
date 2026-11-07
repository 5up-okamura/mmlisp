// ---------------------------------------------------------------------------
// The GM output's worklet (gm-output.js): its synthesizer (gm-synth.js) in
// an AudioWorklet of its own, beside the chips' (worklet.js), on the audio
// thread's clock. It is a MIDI output inside the page: MidiOutRun
// (midi-output.js) sends it the MIDI export's bytes as it sends a port's,
// each stamped with the audio time it is due.
//
//   { type: 'bank', bytes }        load a SoundFont (SF2 / SF3): 'ready' or 'error'
//   { type: 'midi', events }       [[bytes, audioTime], …], in the order sent
//   { type: 'preload', voices }    [{ program, bankMSB, bankLSB, drums, lo, hi }]:
//                                  those samples decoded now: 'preloaded'
//   { type: 'clear' }              drop what is not yet due
//   { type: 'off' }                drop it and silence every voice
//   { type: 'close' }              the node is done with: its bank let go and
//                                  process() false, so the processor is collected
// ---------------------------------------------------------------------------

import { GmSynth } from "./gm-synth.js";

class GmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gm = new GmSynth(sampleRate);
    this.ready = false;
    this.closed = false;
    const say = (e) => this.port.postMessage({ type: "error", message: String(e?.message ?? e) });
    this.port.onmessage = ({ data }) => {
      try {
        this.receive(data)?.catch?.(say);
      } catch (e) {
        say(e);
      }
    };
  }

  receive(msg) {
    switch (msg.type) {
      case "bank":
        return this.gm.load(msg.bytes).then((r) => { this.ready = true; this.port.postMessage({ type: "ready", ...r }); });
      case "midi": this.gm.schedule(msg.events); break;
      case "preload": this.port.postMessage({ type: "preloaded", ms: this.gm.preload(msg.voices) }); break;
      case "clear": this.gm.clear(); break;
      case "off": this.gm.off(); break;
      case "close": this.gm.close(); this.closed = true; break;
    }
  }

  process(_inputs, outputs) {
    if (this.closed) return false;
    const [L, R] = outputs[0];
    this.gm.render(L, R, 0, L.length, currentTime);
    return true;
  }
}

registerProcessor("mmlisp-gm", GmProcessor);
