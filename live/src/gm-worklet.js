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
//   { type: 'scope-enable', on }   each MIDI channel's sound for the oscilloscope:
//                                  { type: 'scope', sampleRate, time, freq, ch }
//                                  batches, as the chips' worklet posts them (lane
//                                  n MIDI channel n, the drums' 9), their buffers
//                                  handed back with 'scope-return'
//   { type: 'close' }              the node is done with: its bank let go and
//                                  process() false, so the processor is collected
//
// It says when the audio thread could not keep up — { type: 'late', count,
// worst }, at most every two seconds: quanta that took longer to render than
// they last, three or more of them or one four times over, which the
// device's output hears as clicks.
// ---------------------------------------------------------------------------

import { GmSynth } from "./gm-synth.js";

const now = () => globalThis.performance?.now?.() ?? Date.now();
const LATE_EVERY_SEC = 2;
const SCOPE_LANES = 16; // the MIDI channels
const SCOPE_FLUSH = 1024; // samples a batch, as worklet.js's (index.html's rings take it whole)
// A channel's dry sound (−1..1, the bank's level) into the chips' lane units,
// where a full channel is 1/16 of the mix (index.html SCOPE_DISPLAY_GAIN).
const SCOPE_SCALE = 1 / 4;

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
    this.scopeOn = false;
    this.scopeBufs = null; // the batch being filled, a lane each
    this.scopePos = 0;
    this.scopePool = []; // buffers handed back
    this.channels = null; // [[L, R] × 16] a quantum's
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
      case "scope-enable": this.scopeOn = !!msg.on; if (!this.scopeOn) this.scopeBufs = null; break;
      case "scope-return": for (const b of msg.ch ?? []) if (b instanceof ArrayBuffer && this.scopePool.length < 4 * SCOPE_LANES) this.scopePool.push(b); break;
      case "close": this.gm.close(); this.closed = true; break;
    }
  }

  process(_inputs, outputs) {
    if (this.closed) return false;
    const [L, R] = outputs[0];
    const n = L.length;
    const t0 = now();
    let channels;
    if (this.scopeOn) {
      if (this.channels?.[0][0].length !== n)
        this.channels = Array.from({ length: SCOPE_LANES }, () => [new Float32Array(n), new Float32Array(n)]);
      channels = this.channels;
      for (const [l, r] of channels) { l.fill(0); r.fill(0); }
    }
    this.gm.render(L, R, 0, n, currentTime, channels);
    if (channels) this.scopeTake(channels, n);
    const ms = now() - t0, budget = (1000 * n) / sampleRate;
    const late = this.late;
    if (ms > budget && currentTime >= late.graceUntil) { late.count++; late.worst = Math.max(late.worst, ms); }
    // A block over now and then is the output's buffer's to absorb; a run of
    // them, or one far over, is heard.
    if (currentTime - late.since >= LATE_EVERY_SEC) {
      if (late.count >= 3 || late.worst >= 4 * budget) this.port.postMessage({ type: "late", count: late.count, worst: late.worst, budget });
      late.count = 0; late.worst = 0;
      late.since = currentTime;
    }
    return true;
  }

  // A quantum's channels into the batch, each lane its channel's mid (L + R)
  // / 2; a full batch posted, its buffers transferred.
  scopeTake(channels, n) {
    let src = 0;
    while (src < n) {
      if (!this.scopeBufs) {
        this.scopeBufs = Array.from({ length: SCOPE_LANES }, () => {
          const b = this.scopePool.pop();
          return b?.byteLength === SCOPE_FLUSH * 4 ? new Float32Array(b) : new Float32Array(SCOPE_FLUSH);
        });
        this.scopePos = 0;
      }
      const take = Math.min(n - src, SCOPE_FLUSH - this.scopePos);
      for (let c = 0; c < SCOPE_LANES; c++) {
        const [l, r] = channels[c], out = this.scopeBufs[c];
        for (let i = 0; i < take; i++) out[this.scopePos + i] = (l[src + i] + r[src + i]) * (0.5 * SCOPE_SCALE);
      }
      this.scopePos += take;
      src += take;
      if (this.scopePos >= SCOPE_FLUSH) {
        const buffers = this.scopeBufs.map((b) => b.buffer);
        this.scopeBufs = null;
        this.port.postMessage({ type: "scope", sampleRate, time: currentTime + src / sampleRate, freq: this.gm.freqs(), ch: buffers }, buffers);
      }
    }
  }
}

registerProcessor("mmlisp-gm", GmProcessor);
