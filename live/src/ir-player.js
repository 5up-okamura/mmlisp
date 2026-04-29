/**
 * MMLisp IR player.
 *
 * Loads an IR JSON file, translates events into YM2612 register writes,
 * and schedules them via a write callback timed by the Web Audio clock.
 *
 * Usage:
 *   const player = new IRPlayer(writeCallback);
 *   await player.loadURL('path/to/demo1.ir.canonical.json');
 *   player.play();
 *   player.stop();
 *
 * writeCallback(port, addr, data) matches the YM2612 write() interface,
 * which in practice posts messages to the AudioWorklet.
 */

// ---------------------------------------------------------------------------
// Pitch → MIDI note
// ---------------------------------------------------------------------------
const NOTE_NAMES = [
  "c",
  "cs",
  "d",
  "ds",
  "e",
  "f",
  "fs",
  "g",
  "gs",
  "a",
  "as",
  "b",
];
// Aliases for accidentals used in MMLisp ("c+", "d-" etc.)
const NOTE_ALIASES = {
  "c+": "cs",
  "d-": "cs",
  "d+": "ds",
  "e-": "ds",
  "f+": "fs",
  "g-": "fs",
  "g+": "gs",
  "a-": "gs",
  "a+": "as",
  "b-": "as",
};

function pitchToMidi(pitchStr) {
  // Format: "c4", "e4", "f+3", "b-5" etc.
  const m = pitchStr.toLowerCase().match(/^([a-g][+\-]?)(\d)$/);
  if (!m) return 60; // fallback C4

  let name = m[1];
  const octave = parseInt(m[2], 10);

  name = NOTE_ALIASES[name] ?? name;
  const semitone = NOTE_NAMES.indexOf(name);
  if (semitone < 0) return 60;

  // MIDI: C4 = 60, C0 = 12
  return (octave + 1) * 12 + semitone;
}

// ---------------------------------------------------------------------------
// MIDI pitch → YM2612 F-number + block
// Calibrated for NTSC Mega Drive master clock 7670454 Hz.
// F_num table is computed for block=4 (covers C4-B4 well).
// For other octaves, the same F_nums are used with block = octave.
// ---------------------------------------------------------------------------

// F-number for each semitone in the 'reference octave' (matches block=4 / MIDI octave 4)
// Computed as: F_num = round(freq * 2^20 / (MASTER_CLOCK / 144 / 2^(block-1)))
//            = round(freq * 2^19 / (MASTER_CLOCK / 144))
//   where MASTER_CLOCK/144 = 53267 Hz
const FNUM_TABLE = [
  644, 682, 723, 766, 811, 860, 911, 966, 1023, 1082, 1146, 1214,
];

function midiToFnumBlock(midiNote) {
  const semitone = ((midiNote % 12) + 12) % 12;
  // MIDI C0=12 → octave=0, C4=60 → octave=4
  const octave = Math.floor(midiNote / 12) - 1;
  const block = Math.max(0, Math.min(7, octave));
  return { fnum: FNUM_TABLE[semitone], block };
}

// ---------------------------------------------------------------------------
// Parameter name → YM2612 register offset + encoding
// ---------------------------------------------------------------------------
//
// MMLisp param names (from IR) map to hardware registers.
// Channel-level params:
//   FM_FB      → 0xB0 bits 5-3 (feedback, 0-7)
//   FM_ALG     → 0xB0 bits 2-0 (algorithm, 0-7)
//   FM_AMS     → 0xB4 bits 5-4 (AM sensitivity, 0-3)
//   FM_FMS     → 0xB4 bits 2-0 (FM sensitivity, 0-7)
//   LFO_RATE   → 0x22 global (0=off, 1-8=rate index)
// Operator params (op1-op4):
//   FM_TL1..4  → 0x40 per op (total level, 0-127)
//   FM_AR1..4  → 0x50 per op (attack rate, 0-31)
//   FM_DR1..4  → 0x60 per op bits 4-0 (decay rate, 0-31)
//   FM_AMEN1..4 → 0x60 per op bit 7 (AM enable, 0-1)
//   FM_SR1..4  → 0x70 per op (sustain rate, 0-31)
//   FM_RR1..4  → 0x80 per op (release rate bits 3-0)
//   FM_SL1..4  → 0x80 per op (sustain level bits 7-4)
//   FM_ML1..4  → 0x30 per op (multiplier bits 3-0)
//   FM_DT1..4  → 0x30 per op (detune bits 6-4)

const OP_ADDR_OFFSET = [0, 8, 4, 12]; // op1,op2,op3,op4 in OPN2 register space

function buildChannelRegState(chIndex) {
  // Returns a mutable object representing all register state for a channel
  return {
    algorithm: 0,
    feedback: 0,
    stereoL: true,
    stereoR: true,
    ams: 0, // LFO AM sensitivity 0-3 (0xB4 bits 5-4)
    fms: 0, // LFO FM sensitivity 0-7 (0xB4 bits 2-0)
    ops: [
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
    ],
  };
}

// Encode B0 register (algorithm + feedback)
function encodeB0(regs) {
  return ((regs.feedback & 0x07) << 3) | (regs.algorithm & 0x07);
}

// Encode B4 register (stereo + AMS/FMS)
function encodeB4(regs) {
  return (
    ((regs.stereoL ? 1 : 0) << 7) |
    ((regs.stereoR ? 1 : 0) << 6) |
    ((regs.ams & 0x03) << 4) |
    (regs.fms & 0x07)
  );
}

// Encode 0x60 (AM enable + DR) for an operator
function encode60(op) {
  return ((op.amen & 0x01) << 7) | (op.dr & 0x1f);
}

// Encode 0x30 (DT1/MUL) for an operator
function encode30(op) {
  return ((op.dt & 0x07) << 4) | (op.mul & 0x0f);
}

// Encode 0x80 (SL/RR) for an operator
function encode80(op) {
  return ((op.sl & 0x0f) << 4) | (op.rr & 0x0f);
}

function fmCarrierOpsForAlg(alg) {
  const CARRIER_OPS = [
    [3], // alg 0: op4
    [3], // alg 1: op4
    [3], // alg 2: op4
    [3], // alg 3: op4
    [1, 3], // alg 4: op2, op4
    [1, 2, 3], // alg 5: op2, op3, op4
    [1, 2, 3], // alg 6: op2, op3, op4
    [0, 1, 2, 3], // alg 7: all
  ];
  return CARRIER_OPS[alg] ?? [3];
}

// YM2612 channel name → 0-based channel index
const CH_NAME_TO_INDEX = {
  fm1: 0,
  fm2: 1,
  fm3: 2,
  fm4: 3,
  fm5: 4,
  fm6: 5,
};

// SN76489 PSG channel name → 0-based PSG channel index (0-3)
const PSG_CH_NAME_TO_INDEX = {
  psg1: 0,
  psg2: 1,
  psg3: 2,
  noise: 3,
};

// PSG MASTER_CLOCK (NTSC Mega Drive)
const PSG_MASTER_CLOCK = 3579545;

// ---------------------------------------------------------------------------
// IRPlayer
// ---------------------------------------------------------------------------
export class IRPlayer {
  /**
   * @param {function(port:number, addr:number, data:number): void} writeCallback
   */
  constructor(writeCallback) {
    this._write = writeCallback;
    this._ir = null;
    this._playing = false;
    this._loopCount = new Map(); // loopId → iteration count
    this._eventIndex = 0;
    this._currentTick = 0;
    this._ppqn = 48;
    this._bpm = 120;
    this._startAudioTime = 0;
    this._audioContext = null;
    this._schedulerTimer = null;
    this._schedulerLookahead = 0.2; // seconds
    this._schedulerInterval = 25; // ms
    this._loop = true; // loop by default
    this._onLine = null; // (line: number) => void — called when an event fires
    this._onTick = null; // (tick, bpm, ppqn) => void — called each scheduler interval
    this._onParam = null; // (chIndex, target, value) => void — called when a param event plays

    // Per-channel register state (for incremental PARAM_ADD)
    this._chRegs = Array.from({ length: 6 }, (_, i) => buildChannelRegState(i));

    // Global YM2612 state
    this._lfoRate = 0; // 0 = off, 1-8 = rate index

    // Track → channel mapping (defaults to index 0 for demo)
    this._trackChannel = new Map(); // trackIndex → chIndex (0-5)

    // PSG channel routing
    this._psgTrackChannel = new Map(); // trackIndex → psgCh (0-3)
    this._psgChVoice = new Array(4).fill(null); // stored envelope per PSG ch
    this._psgMuted = new Array(4).fill(false); // mute state per PSG ch

    // Modulator tracks by channel index (built after _flattenTracks)
    this._modulatorsByCh = new Map();

    // Mute state per channel (index 0-5)
    this._mutedChannels = new Array(6).fill(false);

    // Key-on operator mask per channel (default 0xf0 = all 4 ops on)
    this._opMasks = new Array(6).fill(0xf0);

    // Per-track scheduler state (set in play())
    this._tracks = [];
  }

  /**
   * Load an IR JSON from a URL.
   */
  async loadURL(url) {
    const res = await fetch(url);
    this._ir = await res.json();
    this._ppqn = this._ir.ppqn ?? 48;
    this._eventIndex = 0;
    this._currentTick = 0;
    this._loopCount.clear();

    // Assign channels: use IR track.channel name if present, else auto-increment by track index
    for (let i = 0; i < (this._ir.tracks?.length ?? 0); i++) {
      this._assignChannel(i, this._ir.tracks[i]);
    }

    return this;
  }

  _resolveInitialTempo(irObj) {
    // Prefer an explicit tempo event at tick 0 so scheduling starts at the
    // intended BPM on the very first loop.
    for (const track of irObj?.tracks ?? []) {
      for (const ev of track.events ?? []) {
        if (ev?.cmd !== "TEMPO_SET") continue;
        if ((ev.tick ?? 0) !== 0) continue;
        const bpm = Number(ev.args?.bpm);
        if (Number.isFinite(bpm) && bpm > 0) return bpm;
      }
    }
    return 120;
  }

  /**
   * Load IR JSON directly from an object.
   */
  loadJSON(irObj) {
    this._ir = irObj;
    this._ppqn = irObj.ppqn ?? 48;
    this._bpm = this._resolveInitialTempo(irObj);
    this._eventIndex = 0;
    this._currentTick = 0;
    this._loopCount.clear();
    for (let i = 0; i < (irObj.tracks?.length ?? 0); i++) {
      this._assignChannel(i, irObj.tracks[i]);
    }
    return this;
  }

  /**
   * Start playback using the provided AudioContext for timing.
   * @param {AudioContext} audioContext
   * @param {{ loop?: boolean }} [options]
   */
  play(audioContext, options = {}) {
    if (!this._ir) throw new Error("No IR loaded");

    if (options.loop !== undefined) this._loop = options.loop;

    this._audioContext = audioContext;
    this._playing = true;
    this._startAudioTime = audioContext.currentTime + 0.05; // small startup offset

    // Initialize all channels with default voices
    this._initDefaultVoices();

    // Build per-track scheduler state
    this._tracks = this._flattenTracks();
    this._buildModulatorMap();
    for (const t of this._tracks) {
      t.audioTimeAtTick0 = this._startAudioTime;
      t.loopCount = 0;
      t.flatIndex = 0;
    }

    this._scheduleLoop();
  }

  stop() {
    this._playing = false;
    if (this._schedulerTimer !== null) {
      clearTimeout(this._schedulerTimer);
      this._schedulerTimer = null;
    }
    // All notes off (FM)
    for (let ch = 0; ch < 6; ch++) {
      this._writeKeyOff(ch);
    }
    // Silence all PSG channels
    for (let psgCh = 0; psgCh < 4; psgCh++) {
      this._psgSetAtt(psgCh, 15);
    }
  }

  /** Returns true if playback is currently running. */
  isPlaying() {
    return this._playing;
  }

  /**
   * Returns the current playback position in ticks (track-0 clock).
   * Returns 0 if not playing.
   */
  currentTick() {
    if (!this._playing || this._tracks.length === 0) return 0;
    const t0 = this._tracks[0];
    const now = this._audioContext.currentTime;
    const secsPerTick = 60 / (this._bpm * this._ppqn);
    return Math.max(0, Math.floor((now - t0.audioTimeAtTick0) / secsPerTick));
  }

  /**
   * Resume playback from an explicit tick position (pause/resume).
   * @param {AudioContext} audioContext
   * @param {number} fromTick  PPQN tick to resume from
   */
  playFromTick(audioContext, fromTick) {
    if (!this._ir) throw new Error("No IR loaded");
    this._audioContext = audioContext;
    this._playing = true;
    const now = audioContext.currentTime;
    const secsPerTick = 60 / (this._bpm * this._ppqn);
    const newTick0 = now + 0.025 - fromTick * secsPerTick;
    this._tracks = this._flattenTracks();
    this._buildModulatorMap();
    for (const t of this._tracks) {
      t.audioTimeAtTick0 = newTick0;
      t.startAudioTime = newTick0;
      t.loopCount = 0;
      t.flatIndex = 0;
      while (
        t.flatIndex < t.events.length &&
        t.events[t.flatIndex].tick < fromTick
      ) {
        t.flatIndex++;
      }
    }
    this._scheduleLoop();
  }

  /**
   * Seek to the nearest event at or before the given source line, then play.
   * @param {AudioContext} audioContext
   * @param {number} cursorLine  1-based source line number
   * @param {Array<{line:number,tick:number}>} sourceMap  from compileMMLisp()
   */
  playFromLine(audioContext, cursorLine, sourceMap) {
    let tick = 0;
    if (sourceMap && sourceMap.length > 0) {
      // Binary search: last entry with line <= cursorLine
      let lo = 0,
        hi = sourceMap.length - 1,
        found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sourceMap[mid].line <= cursorLine) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (found >= 0) tick = sourceMap[found].tick;
    }
    this._initDefaultVoices();
    this.playFromTick(audioContext, tick);
  }

  /** Toggle looping at any time. */
  setLoop(enabled) {
    this._loop = enabled;
  }

  /**
   * Mute or unmute a channel. Muted channels suppress NOTE_ON key-on writes.
   * @param {number} ch  0-5 = FM, 6-9 = PSG (6=psg1, 7=psg2, 8=psg3, 9=noise)
   * @param {boolean} muted
   */
  muteChannel(ch, muted) {
    if (ch >= 6 && ch <= 9) {
      this._psgMuted[ch - 6] = muted;
    } else {
      this._mutedChannels[ch] = muted;
    }
  }

  /**
   * Solo a channel — mutes all others.
   * @param {number} ch  0-5 FM / 6-9 PSG, or -1 to clear solo
   */
  soloChannel(ch) {
    if (ch >= 6 && ch <= 9) {
      // Solo a PSG channel: mute all FM and other PSG channels
      for (let i = 0; i < 6; i++) this._mutedChannels[i] = true;
      for (let i = 0; i < 4; i++) this._psgMuted[i] = i !== ch - 6;
    } else {
      for (let i = 0; i < 6; i++) this._mutedChannels[i] = ch >= 0 && i !== ch;
      for (let i = 0; i < 4; i++) this._psgMuted[i] = ch >= 0;
    }
  }

  /** Clear all mutes. */
  clearMute() {
    this._mutedChannels.fill(false);
    this._psgMuted.fill(false);
  }

  /**
   * Set operator key-on mask for a channel.
   * @param {number} ch    0-5
   * @param {number} mask  0xf0 = all on; bit7=op4, bit6=op3, bit5=op2, bit4=op1
   */
  setOpMask(ch, mask) {
    this._opMasks[ch] = mask & 0xf0;
  }

  /** Get current op mask for a channel. */
  getOpMask(ch) {
    return this._opMasks[ch] ?? 0xf0;
  }

  /**
   * Hot-swap the IR while playback is running.
   * The current playback position (in bars) is preserved where possible.
   *
   * Workflow:
   *   1. Compute current tick from track-0 clock.
   *   2. Flush worklet's timed queue (discard pre-scheduled writes).
   *   3. Load new IR, rebuild channel map.
   *   4. Re-enter _scheduleLoop starting from the bar-aligned tick.
   *
   * If playback is stopped, behaves like loadJSON().
   *
   * @param {object} irObj  Compiled IR object
   * @param {Function} [flushFn]  Called to flush worklet queue: () => void
   */
  hotSwap(irObj, flushFn) {
    // Snapshot current position before replacing state
    let resumeTick = 0;
    if (this._playing && this._tracks.length > 0) {
      const now = this._audioContext.currentTime;
      const secsPerTick = 60 / (this._bpm * this._ppqn);
      const t0 = this._tracks[0];
      const rawTick = (now - t0.audioTimeAtTick0) / secsPerTick;
      // Align to bar boundary (bar = ppqn * 4)
      const barTicks = this._ppqn * 4;
      resumeTick = Math.max(0, Math.floor(rawTick / barTicks) * barTicks);
    }

    // Stop current scheduler (don't send key-off — avoid click)
    this._playing = false;
    if (this._schedulerTimer !== null) {
      clearTimeout(this._schedulerTimer);
      this._schedulerTimer = null;
    }

    // Flush worklet's pre-scheduled writes
    if (flushFn) flushFn();

    // Load new IR
    this.loadJSON(irObj);

    if (!this._audioContext) return; // playback was never started

    // Restart from resume position
    this._playing = true;
    const now = this._audioContext.currentTime;
    const secsPerTick = 60 / (this._bpm * this._ppqn);
    // Set audioTimeAtTick0 so that tick=resumeTick corresponds to now+25ms
    const newTick0 = now + 0.025 - resumeTick * secsPerTick;
    this._tracks = this._flattenTracks();
    this._buildModulatorMap();
    for (const t of this._tracks) {
      t.startAudioTime = newTick0;
      t.audioTimeAtTick0 = newTick0;
      t.loopCount = 0;
      // Skip events before resumeTick
      t.flatIndex = 0;
      while (
        t.flatIndex < t.events.length &&
        t.events[t.flatIndex].tick < resumeTick
      ) {
        t.flatIndex++;
      }
    }
    this._scheduleLoop();
  }

  /**
   * Register a callback fired (approximately) when each event plays.
   * @param {((line: number) => void) | null} fn  1-based source line number
   */
  setOnLine(fn) {
    this._onLine = fn;
  }

  /** Register a callback fired each scheduler interval with the current playback position. */
  setOnTick(fn) {
    this._onTick = fn;
  }

  /** Register a callback fired (approximately) when each PARAM_SET/PARAM_ADD event plays. */
  setOnParam(fn) {
    this._onParam = fn;
  }

  _assignChannel(trackIndex, track) {
    // If the track declares a PSG channel name, store in _psgTrackChannel.
    const name = track?.channel;
    if (name != null && PSG_CH_NAME_TO_INDEX[name] != null) {
      this._psgTrackChannel.set(trackIndex, PSG_CH_NAME_TO_INDEX[name]);
      return;
    }
    // Otherwise treat as FM channel.
    // If the track declares a channel name (e.g. "fm2"), use it.
    // Otherwise fall back to track index (auto-increment), capped at 5.
    const chIndex =
      name != null && CH_NAME_TO_INDEX[name] != null
        ? CH_NAME_TO_INDEX[name]
        : Math.min(trackIndex, 5);
    this._trackChannel.set(trackIndex, chIndex);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _scheduleLoop() {
    if (!this._playing) return;

    // Resume if the AudioContext was suspended (e.g. tab switch / system interrupt)
    if (this._audioContext.state === "suspended") {
      this._audioContext.resume();
    }

    const now = this._audioContext.currentTime;
    const horizon = now + this._schedulerLookahead;
    const secsPerTick = 60 / (this._bpm * this._ppqn);

    // _onTick: use track 0 position for the Bar:Beat display
    if (this._onTick && this._tracks.length > 0) {
      const t0 = this._tracks[0];
      const currentTick = Math.max(
        0,
        (now - t0.audioTimeAtTick0) / secsPerTick,
      );
      this._onTick(currentTick, this._bpm, this._ppqn);
    }

    for (const [tIdx, track] of this._tracks.entries()) {
      // Inner guard handles multiple loop-restarts within one lookahead window
      let guard = 0;
      while (guard++ < 16) {
        while (track.flatIndex < track.events.length) {
          const ev = track.events[track.flatIndex];
          const evTime = track.audioTimeAtTick0 + ev.tick * secsPerTick;
          if (evTime > horizon) break;

          this._dispatchEvent(ev, evTime);
          if (this._onLine && ev.src?.line != null) {
            const line = ev.src.line;
            const delay = Math.max(0, evTime - now) * 1000;
            setTimeout(() => this._onLine(tIdx, line), delay);
          }
          track.flatIndex++;
        }

        // Per-track independent loop restart
        if (
          this._loop &&
          track.events.length > 0 &&
          track.flatIndex >= track.events.length
        ) {
          track.loopCount++;
          track.audioTimeAtTick0 =
            track.startAudioTime +
            track.loopCount * track.loopDuration * secsPerTick;
          track.flatIndex = track.loopStartIndex ?? 0;
          // Continue to schedule new-iteration events that fall within horizon
        } else {
          break;
        }
      }
    }

    // Stop scheduler only when all tracks exhausted in non-loop mode
    if (
      !this._loop &&
      this._tracks.every((t) => t.flatIndex >= t.events.length)
    ) {
      return;
    }

    this._schedulerTimer = setTimeout(
      () => this._scheduleLoop(),
      this._schedulerInterval,
    );
  }

  _flattenTracks() {
    if (!this._ir?.tracks) return [];

    return this._ir.tracks.map((track, ti) => {
      const isPsg = this._psgTrackChannel.has(ti);
      const psgCh = isPsg ? this._psgTrackChannel.get(ti) : null;
      const chIndex = isPsg ? 0 : (this._trackChannel.get(ti) ?? 0);
      const flatEvs = this._expandLoops(track.events ?? []);
      const events = flatEvs
        .map((ev) => ({
          ...ev,
          _chIndex: chIndex,
          _trackIndex: ti,
          _isPsg: isPsg,
          _psgCh: psgCh,
        }))
        .sort((a, b) => a.tick - b.tick);

      // For looped playback, restart from the last JUMP target marker in the
      // expanded track so pre-roll events before the marker are not replayed.
      let jumpTick = -1;
      let jumpTarget = null;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].cmd === "JUMP") {
          jumpTick = events[i].tick;
          jumpTarget = events[i].args?.to ?? null;
          break;
        }
      }

      let loopStartTick = 0;
      if (jumpTick >= 0 && jumpTarget) {
        for (let i = events.length - 1; i >= 0; i--) {
          if (
            events[i].tick <= jumpTick &&
            events[i].cmd === "MARKER" &&
            events[i].args?.id === jumpTarget
          ) {
            loopStartTick = events[i].tick;
            break;
          }
        }
      }

      let loopStartIndex = 0;
      for (let i = 0; i < events.length; i++) {
        if (events[i].tick >= loopStartTick) {
          loopStartIndex = i;
          break;
        }
      }

      const lastTick = events.length > 0 ? events[events.length - 1].tick : 0;
      const loopDuration =
        jumpTick >= 0
          ? Math.max(1, jumpTick - loopStartTick)
          : Math.max(1, lastTick + 1);

      const role = track.route_hint?.role ?? "bgm";
      const carry = track.route_hint?.carry ?? false;
      return {
        events,
        loopDuration,
        loopStartTick,
        loopStartIndex,
        flatIndex: 0,
        audioTimeAtTick0: 0,
        loopCount: 0,
        startAudioTime: 0,
        role,
        carry,
        carryState: carry,
        chIndex,
        isPsg,
        psgCh,
      };
    });
  }

  _buildModulatorMap() {
    this._modulatorsByCh = new Map();
    for (const t of this._tracks) {
      if (t.role === "modulator") {
        const arr = this._modulatorsByCh.get(t.chIndex) ?? [];
        arr.push(t);
        this._modulatorsByCh.set(t.chIndex, arr);
      }
    }
  }

  _resolveTiedLength(ev, baseLength) {
    const trackIndex = ev._trackIndex;
    if (trackIndex == null) return baseLength;

    const track = this._tracks[trackIndex];
    if (!track) return baseLength;

    let totalLength = baseLength;
    let expectedTieTick = ev.tick + baseLength;

    for (let i = track.flatIndex + 1; i < track.events.length; i++) {
      const nextEv = track.events[i];
      if (nextEv.tick > expectedTieTick) break;
      if (nextEv.tick !== expectedTieTick || nextEv.cmd !== "TIE") continue;

      const tieLength = nextEv.args?.length ?? 0;
      totalLength += tieLength;
      expectedTieTick += tieLength;
    }

    return totalLength;
  }

  _expandLoops(events) {
    // One-pass finite expansion with correct tick re-basing.
    // Events that follow a loop block are shifted forward by the full loop
    // duration (count * bodyDuration) so they play after all repetitions,
    // not interleaved with early repetitions.

    function expand(evList, depth) {
      if (depth > 8) return []; // safety guard
      const out = [];
      let j = 0;
      let tickOffset = 0; // accumulated tick shift from all loops processed so far

      while (j < evList.length) {
        const ev = evList[j];
        if (ev.cmd === "LOOP_BEGIN") {
          // Find matching LOOP_END (ignoring nested pairs)
          let k = j + 1;
          let depth2 = 0;
          while (k < evList.length) {
            if (evList[k].cmd === "LOOP_BEGIN") depth2++;
            if (evList[k].cmd === "LOOP_END") {
              if (depth2 === 0) break;
              depth2--;
            }
            k++;
          }
          const loopBody = evList.slice(j + 1, k);
          const count = evList[k]?.args?.repeat ?? evList[k]?.args?.count ?? 2;

          // Derive body duration from LOOP_BEGIN / LOOP_END ticks for accuracy.
          // Falls back to first/last body event ticks if LOOP_END tick is missing.
          const loopBeginTick = ev.tick;
          const loopEndTick =
            evList[k]?.tick ??
            (loopBody.length > 0
              ? loopBody[loopBody.length - 1].tick
              : loopBeginTick);
          const bodyDuration = loopEndTick - loopBeginTick;

          // Expand body once (recursive), then stamp each repetition
          const expandedBody = expand(loopBody, depth + 1);
          for (let rep = 0; rep < count; rep++) {
            for (const bodyEv of expandedBody) {
              out.push({
                ...bodyEv,
                tick: bodyEv.tick + tickOffset + rep * bodyDuration,
              });
            }
          }

          // All subsequent events shift past the added loop duration
          tickOffset += (count - 1) * bodyDuration;
          j = k + 1; // skip past LOOP_END
        } else {
          // Apply accumulated offset so post-loop events play after all reps
          out.push({ ...ev, tick: ev.tick + tickOffset });
          j++;
        }
      }
      return out;
    }

    return expand(events, 0);
  }

  _dispatchEvent(ev, when) {
    // Route PSG events to PSG handler
    if (ev._isPsg) {
      this._dispatchPsgEvent(ev, when);
      return;
    }

    const ch = ev._chIndex ?? 0;
    const port = ch >= 3 ? 1 : 0;
    const chOffset = ch % 3;

    switch (ev.cmd) {
      case "TEMPO_SET":
        this._bpm = ev.args?.bpm ?? this._bpm;
        break;

      case "NOTE_ON": {
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const { fnum, block } = midiToFnumBlock(midi);
        const chKey = (port << 2) | chOffset; // 0x28 channel key
        const baseLengthTicks = ev.args?.length ?? this._ppqn / 2;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const regs = this._chRegs[ch];

        if (regs?.vol != null) {
          const tl = Math.max(0, Math.min(127, (15 - regs.vol) * 8));
          const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
          for (const opIdx of carriers) {
            regs.ops[opIdx].tl = tl;
            const opAddr = 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset;
            this._write(port, opAddr, tl, when);
          }
        }

        // Write F-number high first (block + MSB), then low
        this._write(
          port,
          0xa4 + chOffset,
          ((block & 0x07) << 3) | ((fnum >> 8) & 0x07),
          when,
        );
        this._write(port, 0xa0 + chOffset, fnum & 0xff, when);
        // Key on: all 4 operators (unless muted or op mask applied)
        if (!this._mutedChannels[ch]) {
          const keyOnByte = (this._opMasks[ch] ?? 0xf0) | chKey;
          this._write(0, 0x28, keyOnByte, when);
        }

        // Reset non-carry modulator tracks on the same channel
        const modulators = this._modulatorsByCh.get(ch) ?? [];
        for (const modTrack of modulators) {
          const carry = modTrack.carryState ?? modTrack.carry ?? false;
          if (!carry) {
            modTrack.startAudioTime = when;
            modTrack.audioTimeAtTick0 = when;
            modTrack.loopCount = 0;
            modTrack.carryState = modTrack.carry ?? false;
            modTrack.flatIndex = 0;
          }
        }

        // Key-off scheduled at exact audio time (5ms before next note for envelope decay)
        const noteDurSecs = lengthTicks * (60 / (this._bpm * this._ppqn));
        const offWhen = when + noteDurSecs - 0.005;
        this._write(0, 0x28, chKey, Math.max(when + 0.001, offWhen));
        break;
      }

      case "PARAM_SET":
      case "PARAM_ADD": {
        this._applyParam(ch, port, chOffset, ev, when);
        break;
      }

      case "CARRY_SET": {
        const ti = ev._trackIndex;
        if (ti != null && this._tracks[ti]) {
          this._tracks[ti].carryState = ev.args?.carry ?? false;
        }
        break;
      }

      case "MARKER":
      case "LOOP_BEGIN":
      case "LOOP_END":
      case "REST":
      case "TIE":
      case "JUMP":
        // Handled structurally (loops expanded; markers/jumps not needed for linear playback)
        break;
    }
  }

  _applyParam(ch, port, chOffset, ev, when) {
    const regs = this._chRegs[ch];
    const target = (ev.args?.target ?? "").toUpperCase();
    const isAdd = ev.cmd === "PARAM_ADD";
    const value = isAdd ? (ev.args?.delta ?? 0) : (ev.args?.value ?? 0);
    let nextValue = null;

    // Helper to clamp and apply
    const set = (get, apply, min, max) => {
      const cur = get();
      const next = Math.max(min, Math.min(max, isAdd ? cur + value : value));
      apply(next);
      nextValue = next;
    };

    switch (target) {
      case "FM_FB":
        set(
          () => regs.feedback,
          (v) => {
            regs.feedback = v;
          },
          0,
          7,
        );
        this._write(port, 0xb0 + chOffset, encodeB0(regs), when);
        break;
      case "FM_ALG":
        set(
          () => regs.algorithm,
          (v) => {
            regs.algorithm = v;
          },
          0,
          7,
        );
        this._write(port, 0xb0 + chOffset, encodeB0(regs), when);
        break;
      case "FM_TL1":
      case "FM_TL2":
      case "FM_TL3":
      case "FM_TL4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].tl,
          (v) => {
            regs.ops[opIdx].tl = v;
          },
          0,
          127,
        );
        const opAddr = 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, regs.ops[opIdx].tl, when);
        break;
      }
      case "FM_AR1":
      case "FM_AR2":
      case "FM_AR3":
      case "FM_AR4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].ar,
          (v) => {
            regs.ops[opIdx].ar = v;
          },
          0,
          31,
        );
        const opAddr = 0x50 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(
          port,
          opAddr,
          (regs.ops[opIdx].rs << 6) | regs.ops[opIdx].ar,
          when,
        );
        break;
      }
      case "FM_DR1":
      case "FM_DR2":
      case "FM_DR3":
      case "FM_DR4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].dr,
          (v) => {
            regs.ops[opIdx].dr = v;
          },
          0,
          31,
        );
        const opAddr = 0x60 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, encode60(regs.ops[opIdx]), when);
        break;
      }
      case "FM_SR1":
      case "FM_SR2":
      case "FM_SR3":
      case "FM_SR4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].d2r,
          (v) => {
            regs.ops[opIdx].d2r = v;
          },
          0,
          31,
        );
        const opAddr = 0x70 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, regs.ops[opIdx].d2r & 0x1f, when);
        break;
      }
      case "FM_AMEN1":
      case "FM_AMEN2":
      case "FM_AMEN3":
      case "FM_AMEN4": {
        const opIdx = parseInt(target[7]) - 1;
        set(
          () => regs.ops[opIdx].amen,
          (v) => {
            regs.ops[opIdx].amen = v;
          },
          0,
          1,
        );
        const opAddr = 0x60 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, encode60(regs.ops[opIdx]), when);
        break;
      }
      case "FM_AMS":
        set(
          () => regs.ams,
          (v) => {
            regs.ams = v;
          },
          0,
          3,
        );
        this._write(port, 0xb4 + chOffset, encodeB4(regs), when);
        break;
      case "FM_FMS":
        set(
          () => regs.fms,
          (v) => {
            regs.fms = v;
          },
          0,
          7,
        );
        this._write(port, 0xb4 + chOffset, encodeB4(regs), when);
        break;
      case "LFO_RATE": {
        const rate = Math.max(
          0,
          Math.min(8, isAdd ? (this._lfoRate ?? 0) + value : value),
        );
        this._lfoRate = rate;
        // 0 = disable (0x00); 1-8 = enable + rate (0x08 | rate-1)
        const regVal = rate === 0 ? 0x00 : 0x08 | ((rate - 1) & 0x07);
        this._write(0, 0x22, regVal, when);
        nextValue = rate;
        break;
      }
      case "FM_RR1":
      case "FM_RR2":
      case "FM_RR3":
      case "FM_RR4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].rr,
          (v) => {
            regs.ops[opIdx].rr = v;
          },
          0,
          15,
        );
        const opAddr = 0x80 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, encode80(regs.ops[opIdx]), when);
        break;
      }
      case "FM_ML1":
      case "FM_ML2":
      case "FM_ML3":
      case "FM_ML4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].mul,
          (v) => {
            regs.ops[opIdx].mul = v;
          },
          0,
          15,
        );
        const opAddr = 0x30 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, encode30(regs.ops[opIdx]), when);
        break;
      }
      case "FM_SL1":
      case "FM_SL2":
      case "FM_SL3":
      case "FM_SL4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].sl,
          (v) => {
            regs.ops[opIdx].sl = v;
          },
          0,
          15,
        );
        const opAddr = 0x80 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, encode80(regs.ops[opIdx]), when);
        break;
      }
      case "FM_DT1":
      case "FM_DT2":
      case "FM_DT3":
      case "FM_DT4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].dt,
          (v) => {
            regs.ops[opIdx].dt = v;
          },
          0,
          7,
        );
        const opAddr = 0x30 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, encode30(regs.ops[opIdx]), when);
        break;
      }
      case "FM_KS1":
      case "FM_KS2":
      case "FM_KS3":
      case "FM_KS4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          () => regs.ops[opIdx].rs,
          (v) => {
            regs.ops[opIdx].rs = v;
          },
          0,
          3,
        );
        const opAddr = 0x50 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(
          port,
          opAddr,
          (regs.ops[opIdx].rs << 6) | regs.ops[opIdx].ar,
          when,
        );
        break;
      }
      case "FM_SSG1":
      case "FM_SSG2":
      case "FM_SSG3":
      case "FM_SSG4": {
        const opIdx = parseInt(target[6]) - 1;
        set(
          () => regs.ops[opIdx].ssg,
          (v) => {
            regs.ops[opIdx].ssg = v;
          },
          0,
          15,
        );
        const opAddr = 0x90 + OP_ADDR_OFFSET[opIdx] + chOffset;
        this._write(port, opAddr, regs.ops[opIdx].ssg & 0x0f, when);
        break;
      }
      // Future: TEMPO_SCALE → timing multiplier (not a register write)

      case "VOL": {
        // vol 0-15 (15=max, 0=silent). Apply to carrier operators so volume
        // changes preserve timbre similarly to classic FM driver behavior.
        // TL = (15 - vol) * 8, clamped to 0-127.
        const vol = Math.max(
          0,
          Math.min(15, isAdd ? (regs.vol ?? 15) + value : value),
        );
        regs.vol = vol;
        const tl = Math.max(0, Math.min(127, (15 - vol) * 8));
        const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
        for (const opIdx of carriers) {
          regs.ops[opIdx].tl = tl;
          const opAddr = 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset;
          this._write(port, opAddr, tl, when);
        }
        nextValue = vol;
        break;
      }

      default:
        break;
    }

    if (this._onParam && nextValue !== null) {
      const delay = Math.max(
        0,
        (when - (this._audioContext?.currentTime ?? 0)) * 1000,
      );
      const t = target,
        c = ch,
        v = nextValue;
      setTimeout(() => this._onParam(c, t, v), delay);
    }
  }

  /**
   * External real-time parameter write.
   * target: e.g. 'FM_TL1', 'FM_FB', 'FM_ALG'
   * value: absolute value (always SET, not ADD)
   * chIndex: 0-5 (default 0)
   */
  setParam(target, value, chIndex = 0) {
    const port = chIndex >= 3 ? 1 : 0;
    const chOffset = chIndex % 3;
    this._applyParam(chIndex, port, chOffset, {
      cmd: "PARAM_SET",
      args: { target, value },
    });
  }

  /**
   * Returns a shallow copy of register state for a channel (for UI display).
   */
  getChRegs(chIndex = 0) {
    const r = this._chRegs[chIndex];
    return {
      algorithm: r.algorithm,
      feedback: r.feedback,
      ams: r.ams,
      fms: r.fms,
      lfoRate: this._lfoRate,
      ops: r.ops.map((o) => ({ ...o })),
    };
  }

  // ---------------------------------------------------------------------------
  // PSG helpers (SN76489)
  // port=2 is the flag for PSG writes in the worklet protocol.
  // ---------------------------------------------------------------------------

  _psgWriteByte(byte, when) {
    this._write(2, 0, byte & 0xff, when);
  }

  // Write attenuation for a PSG channel.
  // attReg: 0=max volume, 15=silent (hardware convention).
  _psgSetAtt(psgCh, attReg, when) {
    // Latch byte: 1 | ch(2) | r=1(att) | att(4)
    const byte = 0x80 | ((psgCh & 0x03) << 5) | 0x10 | (attReg & 0x0f);
    this._psgWriteByte(byte, when);
  }

  // Set tone period for a PSG tone channel (ch 0-2).
  _psgSetPitch(psgCh, midi, when) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const period = Math.max(
      1,
      Math.min(1023, Math.round(PSG_MASTER_CLOCK / (32 * freq))),
    );
    // Latch byte: low 4 bits of period
    this._psgWriteByte(0x80 | ((psgCh & 0x03) << 5) | (period & 0x0f), when);
    // Data byte: high 6 bits of period
    this._psgWriteByte((period >> 4) & 0x3f, when);
  }

  // Trigger noise channel with white noise at medium rate.
  _psgTriggerNoise(when) {
    // 0xE5 = 1|11|0|0|1|0|1 → ch3, reg0(ctrl), FB=1(white), NF=01(medium/1024)
    this._psgWriteByte(0xe5, when);
  }

  // Schedule envelope writes for a PSG note.
  // env: PSG_VOICE envelope object (bare/seq/adsr), or null for no envelope.
  // noteWhen: audio time of note start.
  // lengthTicks: note duration in ticks.
  _schedulePsgEnvelope(psgCh, env, noteWhen, lengthTicks) {
    const secsPerTick = 60 / (this._bpm * this._ppqn);
    const noteDurSecs = lengthTicks * secsPerTick;
    const noteOffWhen = noteWhen + noteDurSecs - 0.005;

    if (!env || env.subtype === "hard" || env.subtype === "fn") {
      // No envelope: full volume for note duration then silence
      this._psgSetAtt(psgCh, 0, noteWhen);
      this._psgSetAtt(psgCh, 15, noteOffWhen);
      return;
    }

    if (env.subtype === "bare" || env.subtype === "seq") {
      const steps = env.steps ?? [];
      if (steps.length === 0) {
        this._psgSetAtt(psgCh, 0, noteWhen);
        this._psgSetAtt(psgCh, 15, noteOffWhen);
        return;
      }
      // Z80 driver: 1 step per V-INT = 60 Hz, independent of PPQN/BPM.
      const stepDurSecs = 1 / 60;
      const loopIndex = env.loopIndex ?? null;

      let t = noteWhen;
      let idx = 0;
      while (t < noteOffWhen) {
        const mmlispVol = Math.max(0, Math.min(15, steps[idx] ?? 0));
        // MMLisp: 15=max, 0=silent → hardware: 0=max, 15=silent
        this._psgSetAtt(psgCh, 15 - mmlispVol, t);
        idx++;
        if (idx >= steps.length) {
          if (loopIndex !== null) {
            idx = loopIndex;
          } else {
            break; // no loop — hold last step until note off
          }
        }
        t += stepDurSecs;
      }
      this._psgSetAtt(psgCh, 15, noteOffWhen);
      return;
    }

    if (env.subtype === "adsr") {
      const { ar, dr, sl, sr, rr } = env;
      const secsPerStep = secsPerTick; // 1 tick per step

      // Attack: att from 15 → 0
      let t = noteWhen;
      if (ar > 0) {
        for (let att = 15; att >= 0 && t < noteOffWhen; att--) {
          this._psgSetAtt(psgCh, att, t);
          t += ar * secsPerStep;
        }
      } else {
        this._psgSetAtt(psgCh, 0, t);
      }

      // Decay: att from 0 → (15 - sl)
      const susAtt = Math.max(0, Math.min(15, 15 - sl));
      if (dr > 0 && t < noteOffWhen) {
        for (let att = 0; att <= susAtt && t < noteOffWhen; att++) {
          this._psgSetAtt(psgCh, att, t);
          t += dr * secsPerStep;
        }
      }

      // Sustain: hold at susAtt (or slowly decay if sr > 0)
      if (t < noteOffWhen) {
        this._psgSetAtt(psgCh, susAtt, t);
        if (sr > 0) {
          let att = susAtt;
          while (t < noteOffWhen && att <= 15) {
            this._psgSetAtt(psgCh, att, t);
            att++;
            t += sr * secsPerStep;
          }
        }
      }

      // Release: from susAtt → 15 after note off
      let relT = noteOffWhen;
      if (rr > 0) {
        for (let att = susAtt; att <= 15; att++) {
          this._psgSetAtt(psgCh, att, relT);
          relT += rr * secsPerStep;
        }
      } else {
        this._psgSetAtt(psgCh, 15, relT);
      }
      return;
    }

    // Fallback
    this._psgSetAtt(psgCh, 0, noteWhen);
    this._psgSetAtt(psgCh, 15, noteOffWhen);
  }

  _dispatchPsgEvent(ev, when) {
    const psgCh = ev._psgCh ?? 0;

    switch (ev.cmd) {
      case "PSG_VOICE":
        // Store the envelope for this PSG channel; applied on next NOTE_ON
        this._psgChVoice[psgCh] = ev.args?.envelope ?? null;
        break;

      case "NOTE_ON": {
        if (this._psgMuted[psgCh]) break;

        const isNoise = psgCh === 3;
        if (!isNoise) {
          const midi = pitchToMidi(ev.args?.pitch ?? "c4");
          this._psgSetPitch(psgCh, midi, when);
        } else {
          this._psgTriggerNoise(when);
        }

        const env = this._psgChVoice[psgCh];
        const baseLengthTicks = ev.args?.length ?? this._ppqn / 2;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        this._schedulePsgEnvelope(psgCh, env, when, lengthTicks);
        break;
      }

      case "TEMPO_SET":
        this._bpm = ev.args?.bpm ?? this._bpm;
        break;

      case "MARKER":
      case "LOOP_BEGIN":
      case "LOOP_END":
      case "REST":
      case "TIE":
      case "JUMP":
        break;

      default:
        break;
    }
  }

  _writeKeyOff(chIndex) {
    const port = chIndex >= 3 ? 1 : 0;
    const chOffset = chIndex % 3;
    const chKey = (port << 2) | chOffset;
    this._write(0, 0x28, chKey); // all operators off
  }

  _initDefaultVoices() {
    // Neutral sine-like patch: ALG=7 (all 4 ops independent carriers), FB=0.
    // All ops: AR=31, DR=0, SL=0, RR=15, TL=0, MUL=1, DT=0.
    for (let ch = 0; ch < 6; ch++) {
      const port = ch >= 3 ? 1 : 0;
      const offset = ch % 3;
      const regs = this._chRegs[ch];

      regs.algorithm = 7;
      regs.feedback = 0;
      this._write(port, 0xb0 + offset, encodeB0(regs));
      // Stereo: both
      this._write(port, 0xb4 + offset, 0xc0);

      for (let slot = 0; slot < 4; slot++) {
        const opOff = OP_ADDR_OFFSET[slot];
        regs.ops[slot] = {
          tl: 0,
          ar: 31,
          dr: 0,
          d2r: 0,
          sl: 0,
          rr: 15,
          mul: 1,
          dt: 0,
          rs: 0,
          amen: 0,
          ssg: 0,
        };
        this._write(port, 0x30 + opOff + offset, encode30(regs.ops[slot])); // DT=0, MUL=1
        this._write(port, 0x40 + opOff + offset, 0); // TL=0
        this._write(port, 0x50 + opOff + offset, 31); // AR=31
        this._write(port, 0x60 + opOff + offset, 0); // DR=0
        this._write(port, 0x70 + opOff + offset, 0); // D2R=0
        this._write(port, 0x80 + opOff + offset, encode80(regs.ops[slot])); // SL=0, RR=15
      }
    }
  }
}
