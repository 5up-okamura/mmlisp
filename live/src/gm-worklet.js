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
//   { type: 'reverb', gain }       the reverb's level, 0–1
//   { type: 'close' }              the node is done with: its bank let go and
//                                  process() false, so the processor is collected
//
// It says when the audio thread could not keep up — { type: 'late', count,
// worst }, at most every two seconds: quanta that took longer to render than
// they last, three or more of them or one twice over, which the device's
// output hears as clicks.
// ---------------------------------------------------------------------------

import { GmSynth } from "./gm-synth.js";

const now = () => globalThis.performance?.now?.() ?? Date.now();
const LATE_EVERY_SEC = 2;

class GmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gm = new GmSynth(sampleRate);
    this.ready = false;
    this.closed = false;
    // Not counted for a second after a bank's load or a preload: the first
    // quanta on a new bank or new samples run slow once (the JIT, the cache),
    // and are not what the device's load is.
    this.late = { count: 0, worst: 0, since: 0, graceUntil: 0 };
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
        return this.gm.load(msg.bytes).then((r) => { this.ready = true; this.late.graceUntil = currentTime + 1; this.port.postMessage({ type: "ready", ...r }); });
      case "midi": this.gm.schedule(msg.events); break;
      case "preload": this.port.postMessage({ type: "preloaded", ms: this.gm.preload(msg.voices) }); this.late.graceUntil = currentTime + 1; break;
      case "clear": this.gm.clear(); break;
      case "off": this.gm.off(); break;
      case "reverb": this.gm.setReverb(msg.gain); break;
      case "close": this.gm.close(); this.closed = true; break;
    }
  }

  process(_inputs, outputs) {
    if (this.closed) return false;
    const [L, R] = outputs[0];
    const t0 = now();
    this.gm.render(L, R, 0, L.length, currentTime);
    const ms = now() - t0, budget = (1000 * L.length) / sampleRate;
    const late = this.late;
    if (ms > budget && currentTime >= late.graceUntil) { late.count++; late.worst = Math.max(late.worst, ms); }
    // One block a little over is the output's buffer's to absorb; a run of
    // them, or one far over, is heard.
    if (currentTime - late.since >= LATE_EVERY_SEC) {
      if (late.count >= 3 || late.worst >= 2 * budget) this.port.postMessage({ type: "late", count: late.count, worst: late.worst, budget });
      late.count = 0; late.worst = 0;
      late.since = currentTime;
    }
    return true;
  }
}

registerProcessor("mmlisp-gm", GmProcessor);
