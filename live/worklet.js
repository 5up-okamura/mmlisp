/**
 * AudioWorkletProcessor for YM2612 playback.
 *
 * Loaded by the browser with addModule(). Receives register-write messages
 * from the main thread and generates audio samples using the YM2612 emulator.
 *
 * Message protocol (from main thread via port.postMessage):
 *   { type: 'write', port: 0|1, addr: number, data: number }
 *   { type: 'writes', ops: [{port, addr, data}, ...] }
 *   { type: 'pcm-set-samples', samples: [{name, data: Float32Array, sampleRate, loopStart?, loopEnd?}] }
 *   { type: 'pcm-note-on', when: number, sample: string, rate: number, baseRate?: number, vel: number, mode: 'shot'|'loop' }
 *   { type: 'pcm-note-off', when: number, sample: string }
 *   { type: 'reset' }
 *   { type: 'flush' }  — discard all pending timed writes (used before hot-swap)
 */

// WorkletGlobalScope: import the emulators as modules.
// The paths are relative to the worklet file's URL.
import { YM2612, NATIVE_SAMPLE_RATE } from "./src/ym2612.js";
import { SN76489 } from "./src/sn76489.js";

const WORKLET_BLOCK = 128; // AudioWorklet block size

class YM2612Processor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._chip = new YM2612();

    // SN76489 PSG (port=2 writes)
    this._psgChip = new SN76489();
    this._psgWriteQueue = []; // untimed PSG writes
    this._psgTimedQueue = []; // timed PSG writes: [{frame, data}]

    // Minimal software PCM voices (temporary until real sample bank loading lands)
    this._pcmTimedQueue = []; // timed PCM commands: [{frame, type, ...}]
    this._pcmVoices = [];
    this._pcmFallbackSample = this._buildFallbackSample();
    this._pcmSamples = new Map();

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
        if (msg.port === 2) {
          // PSG write (port=2 is the PSG flag)
          if (msg.when != null) {
            const targetFrame = Math.round(msg.when * sampleRate);
            const entry = { frame: targetFrame, data: msg.data & 0xff };
            let i = this._psgTimedQueue.length;
            while (i > 0 && this._psgTimedQueue[i - 1].frame > targetFrame) i--;
            this._psgTimedQueue.splice(i, 0, entry);
          } else {
            this._psgWriteQueue.push(msg.data & 0xff);
          }
        } else if (msg.when != null) {
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
      } else if (msg.type === "pcm-set-samples") {
        this._pcmSamples = new Map();
        for (const s of msg.samples || []) {
          const name = String(s?.name ?? "").trim();
          if (!name) continue;
          const data = s?.data instanceof Float32Array ? s.data : null;
          const sr = Number(s?.sampleRate);
          if (!data || data.length === 0) continue;
          this._pcmSamples.set(name, {
            data,
            sampleRate: Number.isFinite(sr) && sr > 0 ? sr : this._outputSR,
            loopStart: Number(s?.loopStart),
            loopEnd: Number(s?.loopEnd),
          });
        }
      } else if (msg.type === "pcm-note-on" || msg.type === "pcm-note-off") {
        const targetFrame =
          msg.when != null
            ? Math.round(msg.when * sampleRate)
            : currentFrame + WORKLET_BLOCK;
        const entry = { ...msg, frame: targetFrame };
        let i = this._pcmTimedQueue.length;
        while (i > 0 && this._pcmTimedQueue[i - 1].frame > targetFrame) i--;
        this._pcmTimedQueue.splice(i, 0, entry);
      } else if (msg.type === "writes") {
        for (const op of msg.ops) {
          this._writeQueue.push(op);
        }
      } else if (msg.type === "reset") {
        this._chip = new YM2612();
        this._writeQueue = [];
        this._timedQueue = [];
        this._psgChip = new SN76489();
        this._psgWriteQueue = [];
        this._psgTimedQueue = [];
        this._pcmTimedQueue = [];
        this._pcmVoices = [];
        this._pcmSamples = new Map();
      } else if (msg.type === "flush") {
        // Discard pending scheduled writes (before hot-swap)
        this._timedQueue = [];
        this._psgTimedQueue = [];
        this._pcmTimedQueue = [];
        this._pcmVoices = [];
      }
    };
  }

  _buildFallbackSample() {
    const length = 1024;
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = 1 - t;
      out[i] = Math.sin(2 * Math.PI * 4 * t) * env * 0.6;
    }
    return out;
  }

  _startPcmVoice(msg) {
    const rate = Number(msg.rate);
    const vel = Number(msg.vel);
    const sample = String(msg.sample ?? "");
    if (!sample) return;
    const gain = Math.max(
      0,
      Math.min(1, (Number.isFinite(vel) ? vel : 15) / 15),
    );
    const sampleEntry = this._pcmSamples.get(sample);
    const data = sampleEntry?.data ?? this._pcmFallbackSample;
    const baseRateMsg = Number(msg.baseRate);
    const baseRate =
      Number.isFinite(baseRateMsg) && baseRateMsg > 0
        ? baseRateMsg
        : (sampleEntry?.sampleRate ?? this._outputSR);
    const rawStep =
      (Number.isFinite(rate) ? rate : 1) * (baseRate / this._outputSR);
    const step = Math.max(0.01, rawStep);
    const mode = msg.mode === "loop" ? "loop" : "shot";
    const ch = Number(msg.ch);
    const loopStartRaw = Number(sampleEntry?.loopStart);
    const loopEndRaw = Number(sampleEntry?.loopEnd);
    const len = data.length;
    const loopStart =
      Number.isFinite(loopStartRaw) && loopStartRaw >= 0
        ? Math.min(len - 1, Math.floor(loopStartRaw))
        : 0;
    const loopEnd =
      Number.isFinite(loopEndRaw) && loopEndRaw > loopStart
        ? Math.min(len, Math.floor(loopEndRaw))
        : len;
    const voice = {
      ch: Number.isFinite(ch) ? ch : null,
      sample,
      pos: 0,
      step,
      gain,
      mode,
      released: false,
      loopStart,
      loopEnd,
      data,
    };
    if (mode === "loop") {
      this._pcmVoices = this._pcmVoices.filter((v) => {
        if (v.mode !== "loop") return true;
        if (v.sample !== sample) return true;
        if (!Number.isFinite(ch)) return false;
        return v.ch !== ch;
      });
    }
    this._pcmVoices.push(voice);
  }

  _stopPcmVoice(msg) {
    if (msg.mode === "shot") return;
    const sample = String(msg.sample ?? "");
    if (!sample) return;
    const ch = Number(msg.ch);
    const hasCh = Number.isFinite(ch);
    for (const v of this._pcmVoices) {
      if (v.mode !== "loop") continue;
      if (v.sample !== sample) continue;
      if (hasCh && v.ch !== ch) continue;
      v.released = true;
    }
  }

  _mixPcmSample() {
    let mixed = 0;
    const alive = [];
    for (const voice of this._pcmVoices) {
      const data = voice.data;
      if (!data || data.length === 0) continue;
      if (voice.mode === "loop" && !voice.released) {
        const ls = Math.max(0, Math.min(data.length - 1, voice.loopStart ?? 0));
        const le = Math.max(
          ls + 1,
          Math.min(data.length, voice.loopEnd ?? data.length),
        );
        const loopLen = le - ls;
        if (voice.pos >= le) {
          voice.pos = ls + ((voice.pos - ls) % loopLen);
        }
      }
      let idx = Math.floor(voice.pos);
      if (idx >= data.length) {
        if (voice.mode === "loop" && !voice.released) {
          voice.pos = voice.pos % data.length;
          idx = Math.floor(voice.pos);
        } else {
          continue;
        }
      }
      mixed += data[idx] * voice.gain;
      voice.pos += voice.step;
      if (
        (voice.mode === "loop" && !voice.released) ||
        voice.pos < data.length
      ) {
        alive.push(voice);
      }
    }
    this._pcmVoices = alive;
    return mixed;
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

    // Drain untimed PSG writes
    while (this._psgWriteQueue.length > 0) {
      this._psgChip.write(this._psgWriteQueue.shift());
    }
    // Drain timed PSG writes scheduled for this block
    while (
      this._psgTimedQueue.length > 0 &&
      this._psgTimedQueue[0].frame < blockEnd
    ) {
      this._psgChip.write(this._psgTimedQueue.shift().data);
    }

    // Drain timed PCM commands
    while (
      this._pcmTimedQueue.length > 0 &&
      this._pcmTimedQueue[0].frame < blockEnd
    ) {
      const op = this._pcmTimedQueue.shift();
      if (op.type === "pcm-note-on") {
        this._startPcmVoice(op);
      } else if (op.type === "pcm-note-off") {
        this._stopPcmVoice(op);
      }
    }

    // Generate PSG samples at output rate (built-in decimation)
    const blockSize = outL.length; // always 128
    const psgL = new Float32Array(blockSize);
    const psgR = new Float32Array(blockSize);
    this._psgChip.clockAt(psgL, psgR, blockSize, sampleRate);

    // Generate YM2612 samples (native rate → resample)
    const nativeNeeded = Math.ceil(blockSize * this._resampleRatio) + 2;
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
      const pcm = this._mixPcmSample();

      outL[i] =
        this._nativeL[idx] * (1 - frac) +
        this._nativeL[iNext] * frac +
        psgL[i] +
        pcm;
      outR[i] =
        this._nativeR[idx] * (1 - frac) +
        this._nativeR[iNext] * frac +
        psgR[i] +
        pcm;

      pos += this._resampleRatio;
    }

    // Carry over fractional position into next block
    this._nativePos = pos - Math.floor(pos);

    return true; // keep processor alive
  }
}

registerProcessor("ym2612-processor", YM2612Processor);
