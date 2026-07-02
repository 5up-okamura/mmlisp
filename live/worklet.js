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
 *   { type: 'scope-enable', on: boolean }
 *   { type: 'scope-return', ch: [ArrayBuffer, ...] }  — recycle scope buffers
 *   { type: 'reset' }
 *   { type: 'flush' }  — discard all pending timed writes (used before hot-swap)
 *
 * Messages to the main thread include (while scope is enabled):
 *   { type: 'scope', sampleRate, freq: number[10], fm6IsDac: boolean,
 *     ch: [ArrayBuffer × 10] }  — SCOPE_FLUSH output-rate samples per channel
 *     (FM 1-6, PSG tone 1-3, noise), buffers transferred; post them back via
 *     'scope-return' to avoid reallocation. freq[c] is the pitch latched from
 *     the channel's register writes (Hz, 0 = unknown/unpitched).
 */

// The Mega Drive chip-synthesis DSP (FM resample, PSG decimate + DC block, mix,
// analog LPF) lives in the shared MegaDriveSynth core so this realtime worklet
// and the offline WAV renderer (src/export-wav.js) stay in lockstep.
// Path is relative to the worklet file's URL.
import {
  MegaDriveSynth,
  NUKED_NATIVE_SAMPLE_RATE,
  MD_LPF_DEFAULT_CUTOFF,
  SCOPE_CHANNELS,
} from "./src/synth-md.js";

const WORKLET_BLOCK = 128; // AudioWorklet block size
const SCOPE_FLUSH = 1024; // scope samples per batch posted to the main thread
const PSG_CLOCK = 3579545; // NTSC Z80 clock driving the PSG

class YM2612Processor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    // The shared synth (both chips + DSP); null until the cores finish loading.
    this._synth = null;

    // FM native rate, used to advance PCM/DAC voices (the DAC stream is written
    // once per FM native sample). Constant; equals the core's reported rate.
    this._nativeSR = NUKED_NATIVE_SAMPLE_RATE;

    // PSG write queues (port=2). Drained block-quantized in process().
    this._psgWriteQueue = []; // untimed PSG writes
    this._psgTimedQueue = []; // timed PSG writes: [{frame, data}]

    // PCM voices feeding the YM2612 DAC (register 0x2a). The mix is summed and
    // quantized to one 8-bit stream per FM native sample, then written through
    // the real chip — exactly like the Z80 driver streaming the DAC.
    this._pcmTimedQueue = []; // timed PCM commands: [{frame, type, ...}]
    this._pcmVoices = [];
    this._pcmSamples = new Map();
    this._pcmTrackGain = new Map(); // trackIndex → live mixer gain (0..1); default 1

    // Desired analog-LPF config, applied to the synth when it becomes ready and
    // on every set-analog-lpf message. Buffered here so a toggle that arrives
    // before the cores load still takes effect.
    this._lpfOn = false;
    this._lpfCutoff = MD_LPF_DEFAULT_CUTOFF;

    // Oscilloscope: per-channel tap accumulation + per-channel pitch latches.
    // Enabled by 'scope-enable'; every SCOPE_FLUSH samples the batch is posted
    // with its buffers transferred, and the main thread recycles them back via
    // 'scope-return'. Pitch latches always run (they're a few compares per
    // register write) so a scope enabled mid-note shows the right period.
    this._scopeOn = false;
    this._scopeScratch = null; // SCOPE_CHANNELS per-block tap arrays
    this._scopeBufs = null; // SCOPE_CHANNELS flush-batch arrays (lazy)
    this._scopePos = 0;
    this._scopePool = []; // recycled ArrayBuffers from 'scope-return'
    this._scopeFreq = new Float64Array(SCOPE_CHANNELS); // Hz, 0 = unknown
    this._fmFnumHi = new Uint8Array(6); // latched 0xA4+c (block/fnum-hi)
    this._psgTone = new Uint16Array(3); // 10-bit tone periods
    this._psgLatch = 0; // last PSG latch byte

    // FM/PSG register write queues. Drained block-quantized in process().
    this._writeQueue = []; // untimed: [{port, addr, data}]
    this._timedQueue = []; // timed: [{frame, port, addr, data}]

    // DAC byte provider handed to the synth: mix the active PCM voices to a
    // signed float, quantize to the 8-bit DAC, once per FM native sample.
    this._getDacByte = () => {
      const f = this._mixDacSampleNative();
      return Math.max(0, Math.min(255, Math.round(f * 127) + 128));
    };

    MegaDriveSynth.create(sampleRate)
      .then((synth) => {
        synth.setLpf(this._lpfOn, this._lpfCutoff);
        this._synth = synth;
        // Signal the main thread that the WASM cores are live — lets it
        // distinguish "context never started" from "synth never initialized".
        this.port.postMessage({ type: "ready", sampleRate });
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
            sampleRate: Number.isFinite(sr) && sr > 0 ? sr : sampleRate,
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
      } else if (msg.type === "pcm-set-vol") {
        // Live per-PCM-channel mixer fader, keyed by track index (matches the
        // track sent on pcm-note-on). Applies to current and future voices.
        const track = Number(msg.track);
        const g = Math.max(0, Math.min(1, Number(msg.gain)));
        if (Number.isFinite(track) && Number.isFinite(g)) {
          this._pcmTrackGain.set(track, g);
          for (const v of this._pcmVoices) {
            if (v.track === track) v.gain = (v.velGain ?? v.gain) * g;
          }
        }
      } else if (msg.type === "writes") {
        for (const op of msg.ops) {
          this._writeQueue.push(op);
        }
      } else if (msg.type === "set-analog-lpf") {
        this._lpfOn = !!msg.on;
        const c = Number(msg.cutoffHz);
        if (Number.isFinite(c) && c > 0) this._lpfCutoff = c;
        this._synth?.setLpf(this._lpfOn, this._lpfCutoff);
      } else if (msg.type === "scope-enable") {
        this._scopeOn = !!msg.on;
        this._scopeBufs = null;
        this._scopePos = 0;
      } else if (msg.type === "scope-return") {
        for (const b of msg.ch || []) {
          // Cap the pool at a few in-flight batches so a disable can't leak.
          if (b instanceof ArrayBuffer && this._scopePool.length < 4 * SCOPE_CHANNELS) {
            this._scopePool.push(b);
          }
        }
      } else if (msg.type === "reset") {
        this._synth?.reset();
        this._writeQueue = [];
        this._timedQueue = [];
        this._psgWriteQueue = [];
        this._psgTimedQueue = [];
        this._pcmTimedQueue = [];
        this._pcmVoices = [];
        this._pcmSamples = new Map();
        this._pcmTrackGain = new Map();
        this._scopeFreq.fill(0);
        this._fmFnumHi.fill(0);
        this._psgTone.fill(0);
        this._psgLatch = 0;
      } else if (msg.type === "flush") {
        // Discard pending scheduled writes (before hot-swap)
        this._timedQueue = [];
        this._psgTimedQueue = [];
        this._pcmTimedQueue = [];
        this._pcmVoices = [];
        this._synth?.setDacEnabled(false);
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

  _drainImmediateYmWrites() {
    this._drainImmediateQueue(this._writeQueue, (op) => {
      this._applyYmWrite(op.port ?? 0, op.addr, op.data);
    });
  }

  // Apply a YM register write, latching per-channel pitch on the way in.
  _applyYmWrite(port, addr, data) {
    this._latchYmPitch(port ?? 0, addr & 0xff, data & 0xff);
    this._synth.writeYM(port ?? 0, addr, data);
  }

  // Apply a PSG byte, latching tone-channel pitch on the way in.
  _applyPsgWrite(data) {
    this._latchPsgPitch(data & 0xff);
    this._synth.writePSG(data);
  }

  // FM pitch latch: 0xA4+c holds block/fnum-hi until the 0xA0+c write applies
  // the pair (hardware latch order). Channel = port*3 + register offset.
  _latchYmPitch(port, addr, data) {
    if (addr >= 0xa4 && addr <= 0xa6) {
      this._fmFnumHi[(port ? 3 : 0) + (addr - 0xa4)] = data;
    } else if (addr >= 0xa0 && addr <= 0xa2) {
      const ch = (port ? 3 : 0) + (addr - 0xa0);
      const hi = this._fmFnumHi[ch];
      const fnum = ((hi & 7) << 8) | data;
      const block = (hi >> 3) & 7;
      // freq = fnum * 2^(block-1) * (chip clock / 144) / 2^20
      this._scopeFreq[ch] = fnum
        ? (fnum * Math.pow(2, block - 1) * NUKED_NATIVE_SAMPLE_RATE) / (1 << 20)
        : 0;
    }
  }

  // PSG pitch latch: SN76489 latch/data protocol. Tone period low nibble rides
  // the latch byte; a following data byte supplies the upper 6 bits.
  _latchPsgPitch(data) {
    if (data & 0x80) {
      this._psgLatch = data;
      const ch = (data >> 5) & 3;
      if (!(data & 0x10) && ch < 3) {
        this._psgTone[ch] = (this._psgTone[ch] & 0x3f0) | (data & 0x0f);
        this._updatePsgFreq(ch);
      }
    } else {
      const latch = this._psgLatch;
      const ch = (latch >> 5) & 3;
      if (!(latch & 0x10) && ch < 3) {
        this._psgTone[ch] = (this._psgTone[ch] & 0x00f) | ((data & 0x3f) << 4);
        this._updatePsgFreq(ch);
      }
    }
  }

  _updatePsgFreq(ch) {
    const n = this._psgTone[ch] || 0x400; // period 0 counts as 0x400
    this._scopeFreq[6 + ch] = PSG_CLOCK / (32 * n);
  }

  _startPcmVoice(msg) {
    const rate = Number(msg.rate);
    const vel = Number(msg.vel);
    const sample = String(msg.sample ?? "");
    if (!sample) return;
    const velGain = Math.max(
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
    const track = Number(msg.track);
    const trackGain = this._pcmTrackGain.get(track) ?? 1;
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
      track: Number.isFinite(track) ? track : null,
      sample,
      pos: 0,
      step,
      velGain,
      gain: velGain * trackGain,
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
  // rate. Quantized to the 8-bit DAC by _getDacByte, which the synth calls once
  // per FM native sample while the DAC is enabled.
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
  process(_inputs, outputs, _parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outputs[0][0]; // mono fallback
    const blockSize = outL.length;
    const blockEnd = currentFrame + blockSize;

    const synth = this._synth;
    if (!synth) {
      // Cores still loading: emit silence but keep the processor alive.
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    // Apply this block's register writes up front (block-quantized timing).
    this._drainImmediateYmWrites();
    this._drainTimedQueue(this._timedQueue, blockEnd, (op) => {
      this._applyYmWrite(op.port, op.addr, op.data);
    });
    this._drainImmediateQueue(this._psgWriteQueue, (data) => {
      this._applyPsgWrite(data);
    });
    this._drainTimedQueue(this._psgTimedQueue, blockEnd, (op) => {
      this._applyPsgWrite(op.data);
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
    synth.setDacEnabled(this._pcmVoices.length > 0);

    // All writes for the block are already applied, so the synth renders the
    // PSG block in one call (onFrame omitted); the DAC byte is mixed per FM
    // native sample via _getDacByte.
    const scope = this._scopeOn ? this._scopeScratchFor(blockSize) : null;
    synth.renderInto(outL, outR, blockSize, null, this._getDacByte, scope);
    if (scope) this._scopeAccumulate(scope, blockSize);

    return true; // keep processor alive
  }

  _scopeScratchFor(blockSize) {
    if (!this._scopeScratch || this._scopeScratch[0].length !== blockSize) {
      this._scopeScratch = Array.from(
        { length: SCOPE_CHANNELS },
        () => new Float32Array(blockSize),
      );
    }
    return this._scopeScratch;
  }

  // Append this block's taps to the flush batch; post (with buffer transfer)
  // whenever SCOPE_FLUSH samples are ready. Handles blocks that straddle a
  // flush boundary, so any render quantum size works.
  _scopeAccumulate(scope, blockSize) {
    let src = 0;
    while (src < blockSize) {
      if (!this._scopeBufs) {
        this._scopeBufs = [];
        for (let c = 0; c < SCOPE_CHANNELS; c++) {
          const recycled = this._scopePool.pop();
          this._scopeBufs.push(
            recycled && recycled.byteLength === SCOPE_FLUSH * 4
              ? new Float32Array(recycled)
              : new Float32Array(SCOPE_FLUSH),
          );
        }
        this._scopePos = 0;
      }
      const n = Math.min(blockSize - src, SCOPE_FLUSH - this._scopePos);
      for (let c = 0; c < SCOPE_CHANNELS; c++) {
        const chunk =
          src === 0 && n === blockSize ? scope[c] : scope[c].subarray(src, src + n);
        this._scopeBufs[c].set(chunk, this._scopePos);
      }
      this._scopePos += n;
      src += n;
      if (this._scopePos >= SCOPE_FLUSH) {
        const buffers = this._scopeBufs.map((b) => b.buffer);
        this._scopeBufs = null;
        this.port.postMessage(
          {
            type: "scope",
            sampleRate,
            freq: Array.from(this._scopeFreq),
            fm6IsDac: this._pcmVoices.length > 0,
            ch: buffers,
          },
          buffers,
        );
      }
    }
  }
}

registerProcessor("ym2612-processor", YM2612Processor);
