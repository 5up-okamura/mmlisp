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

import { SoundBankLoader, SpessaSynthProcessor, SpessaLog } from "../../vendor/spessasynth.js";

SpessaLog.setLogLevel(false, false, false);

// Decoded samples kept (4 bytes a frame): past it, the least recently played
// drop their data and decode again when played. A song's programs are a small
// part of a bank's (FluidR3Mono: 26 MiB for every program once, 175 MiB for
// every sample).
const DECODED_BUDGET = 96 * 2 ** 20;

// The reverb at its fullest (level 1): eight times the bank's own return.
// FluidR3Mono's at GM's send (CC91 40) is 31 dB under the dry sound, where
// Off, Half and Full could not be told apart;
// eight times is 13 dB under, Half (four times) 19 dB.
const REVERB_FULL = 8;

export class GmSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.synth = null;
    this.bank = null;
    this.queue = []; // [bytes, time], in time order (a tie keeps its order)
    // Each channel's pitch for the oscilloscope: its latest key held (0 none),
    // its wheel (−8192..8191) over its bend range (semitones, RPN 0; 2 until
    // set), and the RPN its CC6 would set.
    this.keys = new Array(16).fill(0);
    this.wheel = new Array(16).fill(0);
    this.range = new Array(16).fill(2);
    this.rpn = new Array(16).fill(-1);
    // The reverb's level, 0–1 (each channel's send is its CC91), until the
    // caller says (gm-output.js GM_REVERB_DEFAULT).
    this.reverb = 0;
  }

  /** The reverb's level, 0 (none) to 1 (REVERB_FULL), as a channel's CC91 sends to it. */
  setReverb(level) {
    this.reverb = Math.max(0, Math.min(1, Number(level)));
    this.synth?.setSystemParameter("reverbGain", this.reverb * REVERB_FULL);
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
    synth.setSystemParameter("reverbGain", this.reverb * REVERB_FULL);
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

  /**
   * Each channel's pitch (Hz) — its latest key held, bent by its wheel — or 0
   * for none and for channel 10, whose keys are drums: the oscilloscope's
   * trigger and the piano roll's trace.
   */
  freqs() {
    return this.keys.map((k, ch) => (k && ch !== 9 ? 440 * 2 ** ((k - 69 + (this.range[ch] * this.wheel[ch]) / 8192) / 12) : 0));
  }

  /** What is not yet due, dropped. */
  clear() {
    this.queue = [];
  }

  /** That, and every voice silenced. */
  off() {
    this.queue = [];
    this.keys.fill(0);
    this.wheel.fill(0);
    this.synth?.stopAll(true);
  }

  /** Done with: the bank let go. */
  close() {
    this.queue = [];
    this.synth?.destroy();
    this.synth = this.bank = null;
  }

  // The pitch's state, from a message as it goes to the synth (freqs).
  follow(bytes) {
    const kind = bytes[0] & 0xf0, ch = bytes[0] & 0x0f, a = bytes[1], b = bytes[2];
    if (kind === 0x90 && b > 0) this.keys[ch] = a;
    else if ((kind === 0x80 || kind === 0x90) && this.keys[ch] === a) this.keys[ch] = 0;
    else if (kind === 0xe0) this.wheel[ch] = ((b << 7) | a) - 8192;
    else if (kind === 0xb0) {
      if (a === 101) this.rpn[ch] = b === 127 ? -1 : (b << 7) | (this.rpn[ch] & 127);
      else if (a === 100) this.rpn[ch] = b === 127 ? -1 : (this.rpn[ch] & ~127 & 0x3fff) | b;
      else if (a === 6 && this.rpn[ch] === 0) this.range[ch] = b;
      else if (a === 121) this.wheel[ch] = 0; // reset all controllers
      else if (a >= 123) this.keys[ch] = 0; // all notes / sound off
    }
  }

  /**
   * One quantum (at most 128 frames) into L / R from `at` (their offset),
   * starting at time `now`: what falls in it goes to the synth at its place.
   * `channels`, if given, [[L, R] × 16]: each MIDI channel's dry sound added
   * in too, for the oscilloscope.
   *
   * Each message is applied at its own sample, in the order sent: the
   * quantum is rendered up to it, then it goes to the synth at once (one due
   * already, a late one, at the quantum's start). Never through the synth's
   * own timed queue: it holds a message for its next block while one given
   * for now is applied at once, so a note's off that came late would land
   * before its on, still held there — and the note would sound on.
   */
  render(L, R, at, count, now, channels = undefined) {
    if (!this.synth) return;
    const end = now + count / this.sampleRate;
    let done = 0;
    while (this.queue.length && this.queue[0][1] < end) {
      const [bytes, when] = this.queue.shift();
      const k = Math.min(count, Math.max(done, Math.round((when - now) * this.sampleRate)));
      if (k > done) {
        this.synth.process(L, R, at + done, k - done, channels);
        done = k;
      }
      this.synth.processMessage(bytes, 0); // (no time: at once)
      this.follow(bytes);
    }
    if (done < count) this.synth.process(L, R, at + done, count - done, channels);
  }
}
