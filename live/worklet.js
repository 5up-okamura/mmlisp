import { bankedEngineImage } from "./src/engine-banked-images.js";
/**
 * AudioWorkletProcessor for YM2612 playback.
 *
 * Loaded by the browser with addModule(). Receives register-write messages
 * from the main thread and generates audio samples using the YM2612 emulator.
 *
 * Message protocol (from main thread via port.postMessage):
 *   { type: 'write', port: 0|1|2, addr: number, data: number, when?, preview? }
 *       — port 2 is the PSG; `when` (AudioContext seconds) schedules the
 *         write, without it the write applies at the next block; `preview`
 *         marks a key's audition write, which a hold does not swallow and
 *         the song's register shadow does not record
 *   { type: 'hold-ch', ch: 0-7, on: boolean }  — the keys hold an FM channel
 *       over a playing song (index.html previewTake)
 *   { type: 'pcm-set-bank', bank: Uint8Array|null, pcmVoices: 0-3, entryIds: {"name|midi": id} }
 *       — the score's baked sample bank (the one an export ships), which the
 *         IR preview plays through the driver's own engine model
 *   { type: 'pcm-ev', when, kind: 'on', voice, sample, midi, vel, vol, track }
 *   { type: 'pcm-ev', when, kind: 'off' | 'vol' | 'vel' | 'point' | 'master', … }
 *       — the IR's PCM events, applied in time order to the sequencer's voice
 *         model (src/pcm-voices.js) — see _applyPcmEvent
 *   { type: 'pcm-set-vol', track: number, gain: number }  — live UI mixer fader (separate from the score)
 *   { type: 'set-analog-lpf', on: boolean, cutoffHz?: number }
 *   { type: 'scope-enable', on: boolean }
 *   { type: 'scope-return', ch: [ArrayBuffer, ...] }  — recycle scope buffers
 *   { type: 'flush' }  — discard all pending timed writes (used before hot-swap)
 *   { type: 'set-machine', name: 'md'|'pc88'|'x68k'|'msx'|'pce' }  — the synth the
 *       writes play on (src/synth-md.js, src/synth-pc88.js, src/synth-x68k.js,
 *       src/synth-msx.js); a pc88's ports 0/1 are the YM2608's two address
 *       spaces, an x68k's port 0 the YM2151's one, an msx's the AY-3-8910's.
 *       Answered with { type: 'machine', name } once that synth plays (its
 *       core may still be loading)
 *   { type: 'adpcm-ram', image: Uint8Array|null }  — the YM2608's ADPCM-B RAM
 *   { type: 'pcm8-bank', bank }  — the X68000's PCM8 samples (src/chips/msm6258.js bakePcm8)
 *   { type: 'pcm8', when, kind: 'on' | 'gain' | 'step' | 'off' | 'cut', voice, … }
 *       — PCM8's events, mixed, encoded and decoded as the MSM6258 plays them
 *   { type: 'rhythm-rom', rom: Uint8Array|null }  — the YM2608's rhythm ROM
 *
 * Messages to the main thread include (while scope is enabled):
 *   { type: 'scope', sampleRate, time, freq: number[13], fm6IsDac: boolean,
 *     ch: [ArrayBuffer × 13] }  — SCOPE_FLUSH output-rate samples per channel
 *     (FM 1-6, PSG tone 1-3, noise, PCM voices 1-3), buffers transferred;
 *     post them back via 'scope-return' to avoid reallocation. freq[c] is
 *     the pitch latched from the channel's register writes (Hz, 0 =
 *     unknown/unpitched) as of `time`, the batch's end on the AudioContext
 *     clock (s).
 */

// The Mega Drive chip-synthesis DSP (FM resample, PSG decimate + DC block, mix,
// analog LPF) lives in the shared MegaDriveSynth core so this realtime worklet
// and the offline WAV renderer (src/export-wav.js) stay in lockstep.
// Path is relative to the worklet file's URL.
import {
  NUKED_NATIVE_SAMPLE_RATE,
  MD_LPF_DEFAULT_CUTOFF,
  SCOPE_CHANNELS,
  SCOPE_PCM_CHANNELS,
} from "./src/synth-md.js";
import { Pcm8Live } from "./src/synth-x68k.js";
// The machines' synth cores, by target name (src/synths.js). Everything a
// machine has of its own is its synth's (synth-md.js, the contract): this
// file names none. SCOPE_MAX sizes the pitch latches.
import { SYNTHS, SCOPE_MAX } from "./src/synths.js";

// PCM in the IR preview is THE DRIVER'S ENGINE (docs/driver.md §14.3 — the
// preview must sound like the driver): the same voice model the 68000
// runs, the same engine model the gates grade the Z80 against, the same baked
// bank an export ships — 8-bit, at the image's rate, with its 6 dB rungs, its
// 16-byte loop rounding and its loop-point moves.
import { PcmLiveEngine, parsePcmBank } from "./src/pcm-model.js";
import { PcmIrVoices } from "./src/pcm-voices.js";
import { engineImage } from "./src/engine-images.js";

const WORKLET_BLOCK = 128; // AudioWorklet block size
const SCOPE_FLUSH = 1024; // scope samples per batch posted to the main thread

// A synth with no FM (the MSX's) holds no channel: no write is one's.
const NO_BUS = { channelOf: () => -1, isKey: () => false, keyOn: () => false, replay: () => [] };

class YM2612Processor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    // The machine's synth (its chips + DSP); null until the cores finish
    // loading. The Mega Drive's at first; set-machine swaps, each kept once
    // made. The YM2608's two memories are kept here, for a pc88 synth made
    // after they arrive.
    this._synth = null;
    this._machine = "md";
    this._synths = {};
    this._adpcmRam = null;
    this._rhythmRom = null;

    // FM native rate, used to advance PCM/DAC voices (the DAC stream is written
    // once per FM native sample). Constant; equals the core's reported rate.
    this._nativeSR = NUKED_NATIVE_SAMPLE_RATE;

    // PSG write queues (port=2). Drained block-quantized in process().
    this._psgWriteQueue = []; // untimed PSG writes
    this._psgTimedQueue = []; // timed PSG writes: [{frame, data}]

    // PCM: the score's bank, the engine that plays it, and the sequencer's voice
    // model feeding the engine commands. Each engine byte is held for
    // nativeRate / engineRate FM native samples, the way the DAC holds a $2A
    // write until the next.
    this._pcmTimedQueue = []; // timed PCM events: [{frame, type: 'pcm-ev', ...}]
    this._pcm8TimedQueue = []; // the X68000's PCM8 events, applied at their sample
    this._pcm8Bank = null;
    this._pcmBank = null;     // {entries, entryIds, img}
    this._pcmLive = null;     // PcmLiveEngine
    this._pcmSeq = null;      // PcmIrVoices: the IR's events → engine commands
    this._pcmAcc = 0;
    this._pcmByte = 0x80;
    this._pcmTaps = new Int8Array(SCOPE_PCM_CHANNELS); // each voice's term of _pcmByte (the PCM scope taps)
    this._pcmClaimsDac = false; // the first note claims fm6, as on the driver
    this._pcmTrackGain = new Map(); // trackIndex → live mixer gain (0..1); default 1
    // Whether our own engine claimed the DAC, so we only release what we took —
    // a backend streaming 0x2a/0x2b (MMLispDRV) owns it on its own terms. As on
    // the driver, the first note claims fm6 for the rest of the song.
    this._dacFromVoices = false;

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
    this._scopeScratch = null; // the synth's scopeLanes per-block tap arrays
    this._scopeBufs = null; // the same, flush-batch arrays (lazy)
    this._scopePos = 0;
    this._scopePool = []; // recycled ArrayBuffers from 'scope-return'
    this._scopeFreq = new Float64Array(SCOPE_MAX); // Hz, 0 = unknown

    // FM/PSG register write queues. Drained block-quantized in process().
    this._writeQueue = []; // untimed: [{port, addr, data, preview}]
    this._timedQueue = []; // timed: [{frame, port, addr, data, preview}]

    // FM channels the keys hold over a playing song (index.html previewTake).
    // The song's writes to a held channel stay off the chip; every song write
    // is remembered in _songRegs, so when the keys let go the channel waits
    // for the song's next key-on — the preview's release rings until then —
    // and that key-on lands on the song's registers replayed first.
    // 0 = the song's, 1 = held, 2 = let go (the song's at its next key-on).
    this._chHold = new Uint8Array(8);
    this._songRegs = [new Int16Array(256).fill(-1), new Int16Array(256).fill(-1)];

    // DAC byte provider handed to the synth, once per FM native sample: the
    // engine's current byte, stepped at the image's own rate.
    this._getDacByte = () => {
      const img = this._pcmBank.img;
      this._pcmAcc += img.rateHz;
      while (this._pcmAcc >= this._nativeSR) {
        this._pcmAcc -= this._nativeSR;
        this._pcmByte = this._pcmLive.next();
        this._pcmTaps.set(this._pcmLive.voiceOut);
      }
      return this._pcmByte;
    };

    // Signal the main thread once the WASM cores are live — lets it
    // distinguish "context never started" from "synth never initialized".
    this._setMachine("md").then((ok) => { if (ok) this.port.postMessage({ type: "ready", sampleRate }); });

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "write") {
        if (msg.port === 2) {
          // PSG write (port=2 is the PSG flag)
          if (msg.when != null) {
            this._insertTimed(this._psgTimedQueue, msg.when, {
              data: msg.data & 0xff,
            });
          } else {
            this._psgWriteQueue.push(msg.data & 0xff);
          }
        } else if (msg.when != null) {
          // Kept in scheduled-time order (see _insertTimed).
          this._insertTimed(this._timedQueue, msg.when, {
            port: msg.port ?? 0,
            addr: msg.addr,
            data: msg.data,
            preview: !!msg.preview,
          });
        } else {
          this._writeQueue.push(msg);
        }
      } else if (msg.type === "hold-ch") {
        const ch = msg.ch | 0;
        if (ch >= 0 && ch < 8) this._chHold[ch] = msg.on ? 1 : this._chHold[ch] ? 2 : 0;
      } else if (msg.type === "pcm-set-bank") {
        this._setPcmBank(msg);
      } else if (msg.type === "pcm8") {
        const t = msg.when ?? (currentFrame + WORKLET_BLOCK) / sampleRate;
        this._insertTimed(this._pcm8TimedQueue, t, msg);
      } else if (msg.type === "pcm8-bank") {
        this._pcm8Bank = msg.bank ?? null;
        this._pcm8Restart();
      } else if (msg.type === "pcm-ev") {
        // Timed, and applied in time order: a note, a level and every step of
        // a loop-point sweep interleave exactly as the score orders them.
        const t = msg.when ?? (currentFrame + WORKLET_BLOCK) / sampleRate;
        this._insertTimed(this._pcmTimedQueue, t, msg);
      } else if (msg.type === "pcm-set-vol") {
        // Live per-PCM-track mixer fader: a gain on the voice's samples BEFORE
        // its rung, which the driver does not have (a UI-only control).
        const track = Number(msg.track);
        const g = Math.max(0, Math.min(1, Number(msg.gain)));
        if (Number.isFinite(track) && Number.isFinite(g)) {
          this._pcmTrackGain.set(track, g);
          this._pcmApplyUiGain();
        }
      } else if (msg.type === "set-analog-lpf") {
        this._lpfOn = !!msg.on;
        const c = Number(msg.cutoffHz);
        if (Number.isFinite(c) && c > 0) this._lpfCutoff = c;
        for (const synth of Object.values(this._synths)) synth.setLpf(this._lpfOn, this._lpfCutoff);
      } else if (msg.type === "scope-enable") {
        this._scopeOn = !!msg.on;
        this._scopeBufs = null;
        this._scopePos = 0;
      } else if (msg.type === "scope-return") {
        for (const b of msg.ch || []) {
          // Cap the pool at a few in-flight batches so a disable can't leak.
          if (b instanceof ArrayBuffer && this._scopePool.length < 4 * SCOPE_MAX) {
            this._scopePool.push(b);
          }
        }
      } else if (msg.type === "set-machine") {
        this._setMachine(msg.name);
      } else if (msg.type === "adpcm-ram") {
        this._adpcmRam = msg.image ?? null;
        for (const synth of Object.values(this._synths)) synth.setAdpcmRam?.(this._adpcmRam);
      } else if (msg.type === "rhythm-rom") {
        this._rhythmRom = msg.rom ?? null;
        for (const synth of Object.values(this._synths)) synth.setRhythmRom?.(this._rhythmRom);
      } else if (msg.type === "flush") {
        // Discard pending scheduled writes (before hot-swap); a new run plays
        // its channels from the top, held or not.
        this._chHold.fill(0);
        this._timedQueue = [];
        this._psgTimedQueue = [];
        this._pcmTimedQueue = [];
        this._pcmRestart();
        this._pcm8TimedQueue = [];
        this._pcm8Restart();
        this._synth?.setDacEnabled(false);
        this._dacFromVoices = false;
      }
    };
  }

  // Play the writes on `name`'s synth (SYNTHS), made the first time. Until
  // it is, process() plays silence and the queues wait — so the page waits
  // for the 'machine' answer before it starts a score, or the writes
  // scheduled meanwhile would all land in the block the core comes up in.
  // Resolves to whether that synth plays now.
  async _setMachine(name) {
    const key = SYNTHS[name] ? name : "md";
    this._machine = key;
    if (!this._synths[key]) {
      this._synth = null;
      try {
        const synth = await SYNTHS[key].create(sampleRate);
        synth.setLpf(this._lpfOn, this._lpfCutoff);
        synth.pcmTaps = this._pcmTaps;
        synth.setAdpcmRam?.(this._adpcmRam);
        synth.setRhythmRom?.(this._rhythmRom);
        this._synths[key] = synth;
        if ("pcm8" in synth) this._pcm8Restart();
      } catch (error) {
        this.port.postMessage({ type: "error", message: String(error?.message ?? error) });
        return false;
      }
    }
    if (this._machine !== key) return false;
    // Another synth's latches: the previous machine's pitches mean nothing here.
    if (this._synth !== this._synths[key]) this._scopeFreq.fill(0);
    this._synth = this._synths[key];
    this.port.postMessage({ type: "machine", name: key });
    return true;
  }

  // Queue a write for the instant it was scheduled for. The sort key is that
  // exact time, NOT the audio frame it rounds to: a player that puts a key-off
  // a microsecond before a key-on (ir-utils.js KEY_ORDER_EPS_SECS) is saying
  // which comes first, and a frame is ~21 µs, so rounding first would throw
  // that order away and leave arrival order to decide — which is how an FM3
  // operator's re-key key-off, computed while the LAST operator's note is
  // scheduled, used to land after every key-on and silence the chord. Arrival
  // order breaks only true ties. Rounding is monotonic, so a queue sorted by
  // time is also sorted by frame, which is all the drains read.
  _insertTimed(queue, t, payload) {
    const frame = Math.round(t * sampleRate);
    let i = queue.length;
    while (i > 0 && queue[i - 1].t > t) i--;
    queue.splice(i, 0, { ...payload, frame, t });
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
      this._applyYmWrite(op.port ?? 0, op.addr, op.data, op.preview);
    });
  }

  // Apply a YM register write, latching per-channel pitch on the way in.
  _applyYmWrite(port, addr, data, preview = false) {
    const p = port ?? 0;
    const a = addr & 0xff;
    const d = data & 0xff;
    // A register that is not the chip's own (the Mega Drive's DAC pair).
    if (this._synth.takeWrite?.(p, a, d)) return;
    if (!preview) {
      const bus = this._synth.bus ?? NO_BUS;
      if (!bus.isKey(a)) this._songRegs[p & 1][a] = d;
      const ch = bus.channelOf(p, a, d);
      if (ch >= 0 && this._chHold[ch] !== 0) {
        if (this._chHold[ch] === 1 || !bus.isKey(a) || !bus.keyOn(d)) return;
        this._chHold[ch] = 0;
        this._replaySongRegs(ch);
      }
    }
    this._latchYmPitch(p, a, d);
    this._synth.writeYM(p, a, d);
  }

  // A held channel going back to the song: every register of it the song has
  // written, as the song last left it (its synth's bus order).
  _replaySongRegs(ch) {
    for (const [p, a] of (this._synth.bus ?? NO_BUS).replay(ch)) {
      const v = this._songRegs[p][a];
      if (v < 0) continue;
      this._latchYmPitch(p, a, v);
      this._synth.writeYM(p, a, v);
    }
  }

  // True while a backend has DAC bytes queued for this block. Each is meant for
  // its own instant, so they must be applied per sample rather than collapsed
  // into the block's last value.
  _hasTimedDac(endFrame) {
    const q = this._timedQueue;
    for (let i = 0; i < q.length && q[i].frame < endFrame; i++) {
      if (this._synth.isDacWrite?.(q[i].port ?? 0, q[i].addr & 0xff)) return true;
    }
    return false;
  }

  // Apply a PSG byte, latching tone-channel pitch on the way in.
  _applyPsgWrite(data) {
    this._synth.pitch.write(2, 0, data & 0xff, this._scopeFreq);
    this._synth.writePSG(data);
  }

  // The scope's pitch, from the synth's chips' latches (src/scope-pitch.js).
  _latchYmPitch(port, addr, data) {
    this._synth.pitch.write(port, addr, data, this._scopeFreq);
  }

  // The score's bank (null = none). The engine and the voice model restart
  // with it; the fader gains survive.
  _setPcmBank(msg) {
    const bank = msg?.bank instanceof Uint8Array ? msg.bank : null;
    const voices = Number(msg?.pcmVoices) || 0;
    if (!bank || bank.length === 0 || voices < 1) {
      this._pcmBank = null;
      this._pcmLive = null;
      this._pcmSeq = null;
      return;
    }
    const window = new Uint8Array(0x8000);
    window.set(bank.subarray(0, 0x8000));
    const { entries, multibank } = parsePcmBank(bank);
    this._pcmBank = { window: multibank ? bank : window, entries, multibank, entryIds: msg.entryIds ?? {}, img: multibank ? bankedEngineImage(voices,msg.frameHz ?? 60) : engineImage(voices, msg.frameHz ?? 60) };
    this._pcmRestart();
  }

  // A fresh engine and voice model on the current bank: what a reset, a flush
  // (hot-swap) or a new bank starts from.
  // PCM8's mix from silence, on the synth that has it (the X68000's).
  _pcm8Restart() {
    for (const synth of Object.values(this._synths))
      if ("pcm8" in synth) synth.pcm8 = this._pcm8Bank ? new Pcm8Live(this._pcm8Bank) : null;
  }

  _pcmRestart() {
    this._pcmAcc = 0;
    this._pcmByte = 0x80;
    this._pcmTaps.fill(0);
    this._pcmClaimsDac = false;
    if (!this._pcmBank) {
      this._pcmLive = null;
      this._pcmSeq = null;
      return;
    }
    const live = new PcmLiveEngine(this._pcmBank.img, this._pcmBank.window);
    this._pcmLive = live;
    this._pcmSeq = new PcmIrVoices((c) => live.apply(c), this._pcmBank);
  }

  _pcmApplyUiGain() {
    if (!this._pcmLive) return;
    let any = false;
    const g = this._pcmSeq.voiceTrack.map((t) => {
      const x = t == null ? 1 : (this._pcmTrackGain.get(t) ?? 1);
      if (x !== 1) any = true;
      return x;
    });
    this._pcmLive.model.uiGain = any ? g : null;
  }

  // One IR PCM event, in time order (src/pcm-voices.js PcmIrVoices).
  _applyPcmEvent(ev) {
    if (!this._pcmSeq) return;
    if (this._pcmSeq.apply(ev)) {
      // A note started: it claims the DAC for good, and its voice now answers
      // to that track's fader.
      this._pcmClaimsDac = true;
      this._pcmApplyUiGain();
    }
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

    // Apply this block's register writes up front (block-quantized timing) —
    // unless a backend is streaming the DAC, whose bytes each need their own
    // instant (see the onFrame path below).
    const dacStreaming = this._hasTimedDac(blockEnd);
    this._drainImmediateYmWrites();
    if (!dacStreaming) {
      this._drainTimedQueue(this._timedQueue, blockEnd, (op) => {
        this._applyYmWrite(op.port, op.addr, op.data, op.preview);
      });
    }
    this._drainImmediateQueue(this._psgWriteQueue, (data) => {
      this._applyPsgWrite(data);
    });
    this._drainTimedQueue(this._psgTimedQueue, blockEnd, (op) => {
      this._applyPsgWrite(op.data);
    });

    // Drain timed PCM events (block-quantized, like the register writes).
    this._drainTimedQueue(this._pcmTimedQueue, blockEnd, (op) => {
      this._applyPcmEvent(op);
    });

    // The DAC belongs to whoever drives it. Our engine claims it from the
    // score's first PCM note on, as the driver does, and keeps it; a backend
    // streaming 0x2a/0x2b owns it instead, so only release what we claimed.
    const pcmActive = !!(this._pcmLive && this._pcmClaimsDac);
    if (pcmActive) {
      synth.setDacEnabled(true);
      this._dacFromVoices = true;
    } else if (this._dacFromVoices) {
      synth.setDacEnabled(false);
      this._dacFromVoices = false;
    }

    // With the DAC streamed as timed writes, drain them per sample so each byte
    // lands at its own instant; otherwise every write for the block is already
    // applied and the synth can render PSG (and batch FM) in one call.
    // getDacByte is ours to supply only when our voices own the DAC — passing it
    // while a backend streams would overwrite the backend's bytes with silence.
    // PCM8's events land at their own sample, as the export's mix takes them.
    const pcm8 = synth.pcm8 && this._pcm8TimedQueue[0]?.frame < blockEnd ? synth.pcm8 : null;
    if (!synth.pcm8) this._pcm8TimedQueue = [];
    const onFrame = dacStreaming || pcm8
      ? (i) => {
          if (dacStreaming)
            this._drainTimedQueue(this._timedQueue, currentFrame + i + 1, (op) => {
              this._applyYmWrite(op.port, op.addr, op.data, op.preview);
            });
          if (pcm8) this._drainTimedQueue(this._pcm8TimedQueue, currentFrame + i + 1, (op) => pcm8.apply(op));
        }
      : null;
    const getDacByte = pcmActive ? this._getDacByte : null;
    const scope = this._scopeOn ? this._scopeScratchFor(blockSize) : null;
    synth.renderInto(outL, outR, blockSize, onFrame, getDacByte, scope);
    if (scope) this._scopeAccumulate(scope, blockSize);

    return true; // keep processor alive
  }

  // One tap array per lane of the playing synth (its scopeLanes; the Mega
  // Drive's SCOPE_CHANNELS).
  _scopeScratchFor(blockSize) {
    const lanes = this._synth?.scopeLanes ?? SCOPE_CHANNELS;
    if (!this._scopeScratch || this._scopeScratch.length !== lanes || this._scopeScratch[0].length !== blockSize) {
      this._scopeScratch = Array.from({ length: lanes }, () => new Float32Array(blockSize));
    }
    return this._scopeScratch;
  }

  // Append this block's taps to the flush batch; post (with buffer transfer)
  // whenever SCOPE_FLUSH samples are ready. Handles blocks that straddle a
  // flush boundary, so any render quantum size works.
  _scopeAccumulate(scope, blockSize) {
    let src = 0;
    // Another machine's lanes start a fresh batch.
    if (this._scopeBufs && this._scopeBufs.length !== scope.length) this._scopeBufs = null;
    while (src < blockSize) {
      if (!this._scopeBufs) {
        this._scopeBufs = [];
        for (let c = 0; c < scope.length; c++) {
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
      for (let c = 0; c < scope.length; c++) {
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
            time: (currentFrame + src) / sampleRate,
            freq: Array.from(this._scopeFreq),
            fm6IsDac: this._dacFromVoices,
            ch: buffers,
          },
          buffers,
        );
      }
    }
  }
}

registerProcessor("ym2612-processor", YM2612Processor);
