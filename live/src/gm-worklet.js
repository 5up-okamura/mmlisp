// ---------------------------------------------------------------------------
// The GM output's synthesizer (gm-output.js): a SoundFont played in an
// AudioWorklet of its own, beside the chips' (worklet.js), by
// spessasynth_core (vendor/spessasynth.js, Apache-2.0).
//
// It is a MIDI output inside the page: MidiOutRun (midi-output.js) sends it
// the MIDI export's bytes as it sends a port's, each stamped with the audio
// time it is due, and it holds them until the render quantum that time falls
// in, so a clear (a seek, a stop) drops what is not yet due.
//
//   { type: 'bank', bytes }        load a SoundFont (SF2 / SF3): 'ready' or 'error'
//   { type: 'midi', events }       [[bytes, audioTime], …], in the order sent
//   { type: 'preload', voices }    [{ program, bankMSB, bankLSB, drums, lo, hi }]:
//                                  those samples decoded now, not on a key's first
//                                  use, where decoding stalls the audio thread
//   { type: 'clear' }              drop what is not yet due
//   { type: 'off' }                drop it and silence every voice
// ---------------------------------------------------------------------------

import { SoundBankLoader, SpessaSynthProcessor, SpessaLog } from "../vendor/spessasynth.js";

SpessaLog.setLogLevel(false, false, false);

// Decoded samples kept (4 bytes a frame): past it, the least recently played
// drop their data and decode again when played. A song's programs are a small
// part of a bank's (FluidR3Mono: 26 MiB for every program once, 175 MiB for
// every sample).
const DECODED_BUDGET = 96 * 2 ** 20;

class GmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.synth = null;
    this.bank = null;
    this.queue = []; // [bytes, audioTime], in time order (a tie keeps its order)
    this.port.onmessage = ({ data }) => {
      try {
        this.receive(data);
      } catch (e) {
        this.port.postMessage({ type: "error", message: String(e?.message ?? e) });
      }
    };
  }

  receive(msg) {
    switch (msg.type) {
      case "bank": {
        const bank = SoundBankLoader.fromArrayBuffer(msg.bytes);
        const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false, decodedSampleBudget: DECODED_BUDGET });
        synth.soundBankManager.addSoundBank(bank, "main");
        this.queue = [];
        synth.ready.then(() => {
          this.synth?.destroy();
          this.synth = synth;
          this.bank = bank;
          this.port.postMessage({ type: "ready", presets: bank.presets.length });
        }, (e) => this.port.postMessage({ type: "error", message: String(e?.message ?? e) }));
        break;
      }
      case "midi":
        for (const ev of msg.events) {
          // After every event due no later than it: a tie keeps its order.
          let lo = this.queue.length;
          while (lo > 0 && this.queue[lo - 1][1] > ev[1]) lo--;
          this.queue.splice(lo, 0, ev);
        }
        break;
      case "preload": {
        if (!this.bank) break;
        const t = Date.now();
        for (const v of msg.voices) {
          const preset = this.bank.getPreset({ program: v.program, bankMSB: v.bankMSB, bankLSB: v.bankLSB, isGMGSDrum: v.drums }, "gs");
          preset?.preload(v.lo, v.hi);
        }
        this.port.postMessage({ type: "preloaded", ms: Date.now() - t });
        break;
      }
      case "clear":
        this.queue = [];
        break;
      case "off":
        this.queue = [];
        this.synth?.stopAll(true);
        break;
    }
  }

  process(_inputs, outputs) {
    const [L, R] = outputs[0];
    if (!this.synth) return true;
    // What falls in this quantum goes to the synth, at its place in it.
    const end = currentTime + L.length / sampleRate;
    let n = 0;
    for (; n < this.queue.length && this.queue[n][1] < end; n++) {
      const [bytes, at] = this.queue[n];
      this.synth.processMessage(bytes, 0, { time: this.synth.currentTime + Math.max(0, at - currentTime) });
    }
    if (n) this.queue.splice(0, n);
    this.synth.process(L, R, 0, L.length);
    return true;
  }
}

registerProcessor("mmlisp-gm", GmProcessor);
