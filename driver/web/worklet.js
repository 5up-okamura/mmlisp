/**
 * AudioWorkletProcessor for YM2612 playback.
 *
 * Loaded by the browser with addModule(). Receives register-write messages
 * from the main thread and generates audio samples using the YM2612 emulator.
 *
 * Message protocol (from main thread via port.postMessage):
 *   { type: 'write', port: 0|1, addr: number, data: number }
 *   { type: 'writes', ops: [{port, addr, data}, ...] }
 *   { type: 'reset' }
 *   { type: 'flush' }  — discard all pending timed writes (used before hot-swap)
 */

// WorkletGlobalScope: import the emulator as a module.
// The path is relative to the worklet file's URL.
import { YM2612, NATIVE_SAMPLE_RATE } from "./src/ym2612.js";

const WORKLET_BLOCK = 128; // AudioWorklet block size

class YM2612Processor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._chip = new YM2612();

    // Resampling state: we generate at NATIVE_SAMPLE_RATE and output at
    // the AudioContext sample rate (typically 44100 or 48000).
    this._nativeSR = NATIVE_SAMPLE_RATE;
    this._outputSR = sampleRate; // AudioWorkletGlobalScope provides this
    this._resampleRatio = this._nativeSR / this._outputSR;

    // Native sample ring buffer (stereo, pre-allocated)
    const bufSize = Math.ceil(WORKLET_BLOCK * this._resampleRatio) + 4;
    this._nativeL = new Float32Array(bufSize);
    this._nativeR = new Float32Array(bufSize);
    this._nativePos = 0; // fractional position in native buffer

    // Untimed write queue: applied immediately at the next block boundary
    this._writeQueue = [];
    // Timed write queue: [{frame, port, addr, data}] sorted ascending by target frame
    this._timedQueue = [];

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "write") {
        if (msg.when != null) {
          // Insert into _timedQueue maintaining sorted order by target audio frame
          const targetFrame = Math.round(msg.when * sampleRate);
          const entry = {
            frame: targetFrame,
            port: msg.port ?? 0,
            addr: msg.addr,
            data: msg.data,
          };
          let i = this._timedQueue.length;
          while (i > 0 && this._timedQueue[i - 1].frame > targetFrame) i--;
          this._timedQueue.splice(i, 0, entry);
        } else {
          this._writeQueue.push(msg);
        }
      } else if (msg.type === "writes") {
        for (const op of msg.ops) {
          this._writeQueue.push(op);
        }
      } else if (msg.type === "reset") {
        this._chip = new YM2612();
        this._writeQueue = [];
        this._timedQueue = [];
      } else if (msg.type === "flush") {
        // Discard pending scheduled writes (before hot-swap)
        this._timedQueue = [];
      }
    };
  }

  process(_inputs, outputs, _parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outputs[0][0]; // mono fallback

    // Drain untimed writes (voice init, resets, etc.)
    while (this._writeQueue.length > 0) {
      const op = this._writeQueue.shift();
      this._chip.write(op.port ?? 0, op.addr, op.data);
    }
    // Drain timed writes scheduled for this block
    const blockEnd = currentFrame + WORKLET_BLOCK;
    while (
      this._timedQueue.length > 0 &&
      this._timedQueue[0].frame < blockEnd
    ) {
      const op = this._timedQueue.shift();
      this._chip.write(op.port, op.addr, op.data);
    }

    const blockSize = outL.length; // always 128
    const nativeNeeded = Math.ceil(blockSize * this._resampleRatio) + 2;

    // Generate native-rate samples
    if (nativeNeeded > this._nativeL.length) {
      this._nativeL = new Float32Array(nativeNeeded + 4);
      this._nativeR = new Float32Array(nativeNeeded + 4);
    }
    this._chip.clock(this._nativeL, this._nativeR, nativeNeeded);

    // Linear interpolation resample to output rate
    let pos = this._nativePos;
    for (let i = 0; i < blockSize; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const iNext = Math.min(idx + 1, nativeNeeded - 1);

      outL[i] = this._nativeL[idx] * (1 - frac) + this._nativeL[iNext] * frac;
      outR[i] = this._nativeR[idx] * (1 - frac) + this._nativeR[iNext] * frac;

      pos += this._resampleRatio;
    }

    // Carry over fractional position into next block
    this._nativePos = pos - Math.floor(pos);

    return true; // keep processor alive
  }
}

registerProcessor("ym2612-processor", YM2612Processor);
