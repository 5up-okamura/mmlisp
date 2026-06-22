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
 *   { type: 'set-analog-lpf', on: boolean, cutoffHz?: number }
 *   { type: 'reset' }
 *   { type: 'flush' }  — discard all pending timed writes (used before hot-swap)
 */

// WorkletGlobalScope: import the emulators as modules.
// The paths are relative to the worklet file's URL.
import createNukedModule from "./nuked-opn2.js";
import createPsgModule from "./nuked-psg.js";

const WORKLET_BLOCK = 128; // AudioWorklet block size
const NUKED_NATIVE_SAMPLE_RATE = 7670454 / 144;
const PSG_NATIVE_SAMPLE_RATE = 3579545 / 16;
const nukedModulePromise = createNukedModule();
const psgModulePromise = createPsgModule();

// PSG output is a unipolar sum of up to 4 channels in [0, 4]. Scale it so a
// single full-volume channel lands near the old core's level, and DC-block it
// to remove the offset (and the thumps when notes change the offset).
const PSG_OUTPUT_GAIN = 0.5;
// One-pole DC blocker coefficient (~5 Hz high-pass at the output rate).
const PSG_DC_R = 0.9995;
// Mega Drive Model 1 analog low-pass default cutoff (Hz).
const MD_LPF_DEFAULT_CUTOFF = 3000;

class YM2612Processor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._ymModule = null;
    this._ymBufferPtr = 0;
    this._ymReady = false;

    // Nuked-PSG (SEGA SN76489). port=2 writes feed raw latch/data bytes.
    this._psgModule = null;
    this._psgBufferPtr = 0;
    this._psgReady = false;
    this._psgNativeSR = PSG_NATIVE_SAMPLE_RATE;
    this._psgWriteQueue = []; // untimed PSG writes
    this._psgTimedQueue = []; // timed PSG writes: [{frame, data}]
    // Native -> output decimation state (box filter) + DC blocker.
    this._psgTickFrac = 0;
    this._psgDcX = 0;
    this._psgDcY = 0;

    // PCM voices feeding the YM2612 DAC (register 0x2a). The mix is summed and
    // quantized to one 8-bit stream per FM native sample, then written through
    // the real chip — exactly like the Z80 driver streaming the DAC.
    this._pcmTimedQueue = []; // timed PCM commands: [{frame, type, ...}]
    this._pcmVoices = [];
    this._pcmSamples = new Map();
    this._dacEnabled = false;

    // Switchable Mega Drive analog output low-pass (one-pole, per channel).
    this._lpfOn = false;
    this._lpfCutoff = MD_LPF_DEFAULT_CUTOFF;
    this._lpfA = 0;
    this._lpfYL = 0;
    this._lpfYR = 0;
    this._updateLpfCoeff();

    // Resampling state: we generate at NATIVE_SAMPLE_RATE and output at
    // the AudioContext sample rate (typically 44100 or 48000).
    this._nativeSR = NUKED_NATIVE_SAMPLE_RATE;
    this._outputSR = sampleRate; // AudioWorkletGlobalScope provides this
    this._resampleRatio = this._nativeSR / this._outputSR;
    this._ymFrac = 0;
    this._ymCurrent = [0, 0];
    this._ymNext = [0, 0];

    // Untimed write queue: applied immediately at the next block boundary
    this._writeQueue = [];
    // Timed write queue: [{frame, port, addr, data}] sorted ascending by target frame
    this._timedQueue = [];

    this._ymInitPromise = nukedModulePromise
      .then((instance) => {
        this._ymModule = instance;
        this._ymModule._nopn_init();
        this._ymBufferPtr = this._ymModule._nopn_get_buffer_ptr();
        this._nativeSR = this._ymModule._nopn_get_native_sample_rate();
        this._resampleRatio = this._nativeSR / this._outputSR;
        this._ymFrac = 0;
        this._ymCurrent = [0, 0];
        this._ymNext = this._renderYmOne();
        this._ymReady = true;
      })
      .catch((error) => {
        this.port.postMessage({
          type: "error",
          message: String(error?.message ?? error),
        });
      });

    this._psgInitPromise = psgModulePromise
      .then((instance) => {
        this._psgModule = instance;
        this._psgModule._psg_init();
        this._psgBufferPtr = this._psgModule._psg_get_buffer_ptr();
        this._psgNativeSR = this._psgModule._psg_get_native_sample_rate();
        this._psgReady = true;
      })
      .catch((error) => {
        this.port.postMessage({
          type: "error",
          message: String(error?.message ?? error),
        });
      });

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "write") {
        if (msg.port === 2) {
          // PSG write (port=2 is the PSG flag)
          if (msg.when != null) {
            this._insertTimed(
              this._psgTimedQueue,
              Math.round(msg.when * sampleRate),
              { data: msg.data & 0xff },
            );
          } else {
            this._psgWriteQueue.push(msg.data & 0xff);
          }
        } else if (msg.when != null) {
          // Insert into _timedQueue maintaining sorted order by target audio frame
          this._insertTimed(
            this._timedQueue,
            Math.round(msg.when * sampleRate),
            {
              port: msg.port ?? 0,
              addr: msg.addr,
              data: msg.data,
            },
          );
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
        this._insertTimed(this._pcmTimedQueue, targetFrame, msg);
      } else if (msg.type === "writes") {
        for (const op of msg.ops) {
          this._writeQueue.push(op);
        }
      } else if (msg.type === "set-analog-lpf") {
        this._lpfOn = !!msg.on;
        const c = Number(msg.cutoffHz);
        if (Number.isFinite(c) && c > 0) this._lpfCutoff = c;
        this._updateLpfCoeff();
      } else if (msg.type === "reset") {
        if (this._ymModule) {
          this._ymModule._nopn_reset();
        }
        this._ymFrac = 0;
        this._ymCurrent = [0, 0];
        this._ymNext = this._ymModule ? this._renderYmOne() : [0, 0];
        this._writeQueue = [];
        this._timedQueue = [];
        if (this._psgModule) {
          this._psgModule._psg_reset();
        }
        this._psgWriteQueue = [];
        this._psgTimedQueue = [];
        this._psgTickFrac = 0;
        this._psgDcX = 0;
        this._psgDcY = 0;
        this._pcmTimedQueue = [];
        this._pcmVoices = [];
        this._pcmSamples = new Map();
        this._setDacEnabled(false);
        this._lpfYL = 0;
        this._lpfYR = 0;
      } else if (msg.type === "flush") {
        // Discard pending scheduled writes (before hot-swap)
        this._timedQueue = [];
        this._psgTimedQueue = [];
        this._pcmTimedQueue = [];
        this._pcmVoices = [];
        this._setDacEnabled(false);
      }
    };
  }

  _insertTimed(queue, frame, payload) {
    let i = queue.length;
    while (i > 0 && queue[i - 1].frame > frame) i--;
    queue.splice(i, 0, { frame, ...payload });
  }

  _drainImmediateQueue(queue, consume) {
    while (queue.length > 0) {
      consume(queue.shift());
    }
  }

  _drainTimedQueue(queue, endFrame, consume) {
    while (queue.length > 0 && queue[0].frame < endFrame) {
      consume(queue.shift());
    }
  }

  _renderYmOne() {
    if (!this._ymModule) {
      return [0, 0];
    }
    // Stream one PCM/DAC sample (mixed from the active voices) into the real
    // YM2612 DAC right before advancing the chip one native sample.
    if (this._dacEnabled) {
      const f = this._mixDacSampleNative();
      const dac8 = Math.max(0, Math.min(255, Math.round(f * 127) + 128));
      this._ymModule._nopn_set_dac_sample(dac8);
    }
    this._ymModule._nopn_render(1);
    const base = this._ymBufferPtr >> 1;
    const heap = this._ymModule.HEAP16;
    return [heap[base] / 512, heap[base + 1] / 512];
  }

  _setDacEnabled(on) {
    const next = !!on;
    if (next === this._dacEnabled) return;
    this._dacEnabled = next;
    if (this._ymModule) {
      this._ymModule._nopn_set_dac_enabled(next ? 1 : 0);
    }
  }

  _updateLpfCoeff() {
    // One-pole low-pass: y += a * (x - y), a = 1 - exp(-2*pi*fc/fs).
    const fs = this._outputSR || sampleRate;
    const a = 1 - Math.exp((-2 * Math.PI * this._lpfCutoff) / fs);
    this._lpfA = Math.max(0, Math.min(1, a));
  }

  _drainImmediateYmWrites() {
    if (!this._ymModule) {
      return;
    }
    this._drainImmediateQueue(this._writeQueue, (op) => {
      this._ymModule._nopn_write_reg(
        op.port ?? 0,
        op.addr & 0xff,
        op.data & 0xff,
      );
    });
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
    const data = sampleEntry?.data;
    if (!data || data.length === 0) return; // missing sample: nothing to play
    const baseRateMsg = Number(msg.baseRate);
    const baseRate =
      Number.isFinite(baseRateMsg) && baseRateMsg > 0
        ? baseRateMsg
        : (sampleEntry?.sampleRate ?? this._nativeSR);
    // Voices advance at the FM native rate, since the DAC stream is written
    // once per native chip sample.
    const rawStep =
      (Number.isFinite(rate) ? rate : 1) * (baseRate / this._nativeSR);
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

  // Sum the active PCM voices into one signed float (~[-1, 1]) at the FM native
  // rate. The caller quantizes this to the 8-bit DAC. Runs once per native
  // chip sample (called from _renderYmOne).
  _mixDacSampleNative() {
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

  // Render `blockSize` output-rate PSG samples: box-filter decimate the Nuked
  // native stream (~223.7 kHz) down to the output rate, then DC-block and scale.
  // PSG is mono; returns a single Float32Array.
  _renderPsgBlock(blockSize) {
    const out =
      this._psgOut && this._psgOut.length === blockSize
        ? this._psgOut
        : (this._psgOut = new Float32Array(blockSize));
    if (!this._psgReady) {
      out.fill(0);
      return out;
    }
    const ratio = this._psgNativeSR / this._outputSR;
    const counts =
      this._psgCounts && this._psgCounts.length === blockSize
        ? this._psgCounts
        : (this._psgCounts = new Int32Array(blockSize));

    let frac = this._psgTickFrac;
    let total = 0;
    for (let i = 0; i < blockSize; i++) {
      let ticks = Math.round(frac + ratio);
      if (ticks < 1) ticks = 1;
      frac += ratio - ticks;
      counts[i] = ticks;
      total += ticks;
    }
    this._psgTickFrac = frac;

    this._psgModule._psg_render(total);
    const heap = this._psgModule.HEAPF32;
    let k = this._psgBufferPtr >> 2;
    let dcX = this._psgDcX;
    let dcY = this._psgDcY;
    for (let i = 0; i < blockSize; i++) {
      const n = counts[i];
      let acc = 0;
      for (let t = 0; t < n; t++) acc += heap[k++];
      const s = (acc / n) * PSG_OUTPUT_GAIN;
      // One-pole DC blocker: removes the unipolar offset and note-change thumps.
      const y = s - dcX + PSG_DC_R * dcY;
      dcX = s;
      dcY = y;
      out[i] = y;
    }
    this._psgDcX = dcX;
    this._psgDcY = dcY;
    return out;
  }

  process(_inputs, outputs, _parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outputs[0][0]; // mono fallback
    const blockSize = outL.length;
    const blockEnd = currentFrame + blockSize;

    // Drain untimed YM writes (voice init, resets, etc.)
    this._drainImmediateYmWrites();
    // Drain timed writes scheduled for this block
    this._drainTimedQueue(this._timedQueue, blockEnd, (op) => {
      if (this._ymModule) {
        this._ymModule._nopn_write_reg(op.port, op.addr & 0xff, op.data & 0xff);
      }
    });

    // Drain untimed PSG writes
    this._drainImmediateQueue(this._psgWriteQueue, (data) => {
      if (this._psgModule) this._psgModule._psg_write(data & 0xff);
    });
    // Drain timed PSG writes scheduled for this block
    this._drainTimedQueue(this._psgTimedQueue, blockEnd, (op) => {
      if (this._psgModule) this._psgModule._psg_write(op.data & 0xff);
    });

    // Drain timed PCM commands
    this._drainTimedQueue(this._pcmTimedQueue, blockEnd, (op) => {
      if (op.type === "pcm-note-on") {
        this._startPcmVoice(op);
      } else if (op.type === "pcm-note-off") {
        this._stopPcmVoice(op);
      }
    });

    // Enable the YM2612 DAC while any PCM voice is active (sacrifices FM6).
    this._setDacEnabled(this._pcmVoices.length > 0);

    // Generate the PSG block (Nuked native rate -> output rate, decimated).
    const psg = this._renderPsgBlock(blockSize);

    const lpfOn = this._lpfOn;
    const a = this._lpfA;
    let yL = this._lpfYL;
    let yR = this._lpfYR;

    for (let i = 0; i < blockSize; i++) {
      let ymL = 0;
      let ymR = 0;

      if (this._ymReady) {
        const t = this._ymFrac;
        ymL = this._ymCurrent[0] * (1 - t) + this._ymNext[0] * t;
        ymR = this._ymCurrent[1] * (1 - t) + this._ymNext[1] * t;
        this._ymFrac += this._resampleRatio;
        while (this._ymFrac >= 1) {
          this._ymFrac -= 1;
          this._ymCurrent = this._ymNext;
          this._ymNext = this._renderYmOne();
        }
      }

      // PCM now rides through ymL/ymR via the chip DAC; PSG sums alongside.
      let mixL = ymL + psg[i];
      let mixR = ymR + psg[i];

      if (lpfOn) {
        yL += a * (mixL - yL);
        yR += a * (mixR - yR);
        mixL = yL;
        mixR = yR;
      }

      outL[i] = mixL;
      outR[i] = mixR;
    }

    this._lpfYL = yL;
    this._lpfYR = yR;

    return true; // keep processor alive
  }
}

registerProcessor("ym2612-processor", YM2612Processor);
