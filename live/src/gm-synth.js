// ---------------------------------------------------------------------------
// The GM output's synthesizer: a SoundFont (SF2 / SF3) played by
// spessasynth_core (vendor/spessasynth.js, Apache-2.0), fed MIDI bytes each
// stamped with the time it is due. One for the GM output's worklet
// (gm-worklet.js, the audio thread's clock) and one for a render
// (gm-render.js, the render's): the same voice, live and in a WAV.
//
// It holds what it is sent until the render quantum its time falls in, so a
// clear (a seek, a stop) drops what is not yet due.
// ---------------------------------------------------------------------------

import { SoundBankLoader, SpessaSynthProcessor, SpessaLog } from "../vendor/spessasynth.js";

SpessaLog.setLogLevel(false, false, false);

// Decoded samples kept (4 bytes a frame): past it, the least recently played
// drop their data and decode again when played. A song's programs are a small
// part of a bank's (FluidR3Mono: 26 MiB for every program once, 175 MiB for
// every sample).
const DECODED_BUDGET = 96 * 2 ** 20;

export class GmSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.synth = null;
    this.bank = null;
    this.queue = []; // [bytes, time], in time order (a tie keeps its order)
    this.reverb = 1; // the reverb's level, 0–1: each channel's send is its CC91
  }

  /** The reverb's level, 0 (none) to 1 (the bank's, as a channel's CC91 sends to it). */
  setReverb(gain) {
    this.reverb = Math.max(0, Math.min(1, Number(gain)));
    this.synth?.setSystemParameter("reverbGain", this.reverb);
  }

  /** A SoundFont's bytes loaded (the buffer is kept); resolves { presets }. */
  async load(bytes) {
    // The samples stay views into the file's buffer, which the bank keeps
    // anyway: copied, they would hold it twice (22.5 MiB more).
    const bank = SoundBankLoader.fromArrayBuffer(bytes, { copySampleData: false });
    const synth = new SpessaSynthProcessor(this.sampleRate, { eventsEnabled: false, decodedSampleBudget: DECODED_BUDGET });
    synth.soundBankManager.addSoundBank(bank, "main");
    this.queue = [];
    await synth.ready;
    this.synth?.destroy();
    this.synth = synth;
    this.bank = bank;
    synth.setSystemParameter("reverbGain", this.reverb);
    return { presets: bank.presets.length };
  }

  /** [[bytes, time], …], in the order sent. */
  schedule(events) {
    for (const ev of events) {
      // After every event due no later than it: a tie keeps its order.
      let lo = this.queue.length;
      while (lo > 0 && this.queue[lo - 1][1] > ev[1]) lo--;
      this.queue.splice(lo, 0, ev);
    }
  }

  /**
   * Those voices' samples decoded now — [{ program, bankMSB, bankLSB, drums,
   * lo, hi }] — not on a key's first note, where decoding stalls the thread
   * that renders. Returns the time it took (ms).
   */
  preload(voices) {
    if (!this.bank) return 0;
    const t = Date.now();
    for (const v of voices)
      this.bank.getPreset({ program: v.program, bankMSB: v.bankMSB, bankLSB: v.bankLSB, isGMGSDrum: v.drums }, "gs")?.preload(v.lo, v.hi);
    return Date.now() - t;
  }

  /** What is not yet due, dropped. */
  clear() {
    this.queue = [];
  }

  /** That, and every voice silenced. */
  off() {
    this.queue = [];
    this.synth?.stopAll(true);
  }

  /** Done with: the bank let go. */
  close() {
    this.queue = [];
    this.synth?.destroy();
    this.synth = this.bank = null;
  }

  /**
   * One quantum (at most 128 frames) into L / R from `at` (their offset),
   * starting at time `now`: what falls in it goes to the synth at its place.
   */
  render(L, R, at, count, now) {
    if (!this.synth) return;
    const end = now + count / this.sampleRate;
    let n = 0;
    for (; n < this.queue.length && this.queue[n][1] < end; n++) {
      const [bytes, when] = this.queue[n];
      this.synth.processMessage(bytes, 0, { time: this.synth.currentTime + Math.max(0, when - now) });
    }
    if (n) this.queue.splice(0, n);
    this.synth.process(L, R, at, count);
  }
}
