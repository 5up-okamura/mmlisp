/**
 * GMLisp IR player.
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
// Aliases for sharps/flats commonly seen in GMLisp ("c#", "db" etc.)
const NOTE_ALIASES = {
  "c#": "cs",
  db: "cs",
  "d#": "ds",
  eb: "ds",
  "f#": "fs",
  gb: "fs",
  "g#": "gs",
  ab: "gs",
  "a#": "as",
  bb: "as",
};

function pitchToMidi(pitchStr) {
  // Format: "c4", "e4", "g#3", "bb5" etc.
  const m = pitchStr.toLowerCase().match(/^([a-g][#b]?)(\d)$/);
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
// GMLisp param names (from IR) map to hardware registers.
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
        tl: 40,
        ar: 31,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 15,
        mul: 1,
        dt: 0,
        rs: 0,
        amen: 0,
      },
      {
        tl: 40,
        ar: 31,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 15,
        mul: 1,
        dt: 0,
        rs: 0,
        amen: 0,
      },
      {
        tl: 40,
        ar: 31,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 15,
        mul: 1,
        dt: 0,
        rs: 0,
        amen: 0,
      },
      {
        tl: 40,
        ar: 31,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 15,
        mul: 1,
        dt: 0,
        rs: 0,
        amen: 0,
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

// YM2612 channel name → 0-based channel index
const CH_NAME_TO_INDEX = {
  fm1: 0,
  fm2: 1,
  fm3: 2,
  fm4: 3,
  fm5: 4,
  fm6: 5,
};

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
    this._ppqn = 120;
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

    // Modulator tracks by channel index (built after _flattenTracks)
    this._modulatorsByCh = new Map();

    // Per-track scheduler state (set in play())
    this._tracks = [];
  }

  /**
   * Load an IR JSON from a URL.
   */
  async loadURL(url) {
    const res = await fetch(url);
    this._ir = await res.json();
    this._ppqn = this._ir.ppqn ?? 120;
    this._eventIndex = 0;
    this._currentTick = 0;
    this._loopCount.clear();

    // Assign channels: use IR track.channel name if present, else auto-increment by track index
    for (let i = 0; i < (this._ir.tracks?.length ?? 0); i++) {
      this._assignChannel(i, this._ir.tracks[i]);
    }

    return this;
  }

  /**
   * Load IR JSON directly from an object.
   */
  loadJSON(irObj) {
    this._ir = irObj;
    this._ppqn = irObj.ppqn ?? 120;
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
    // All notes off
    for (let ch = 0; ch < 6; ch++) {
      this._writeKeyOff(ch);
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
      ) {
        t.flatIndex++;
      }
    }
    this._scheduleLoop();
  }

  /** Toggle looping at any time. */
  setLoop(enabled) {
    this._loop = enabled;
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
    // If the track declares a channel name (e.g. "fm2"), use it.
    // Otherwise fall back to track index (auto-increment), capped at 5.
    const name = track?.channel;
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

    for (const track of this._tracks) {
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
            setTimeout(() => this._onLine(line), delay);
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
          track.flatIndex = 0;
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
      const chIndex = this._trackChannel.get(ti) ?? 0;
      const flatEvs = this._expandLoops(track.events ?? []);
      const events = flatEvs
        .map((ev) => ({ ...ev, _chIndex: chIndex, _trackIndex: ti }))
        .sort((a, b) => a.tick - b.tick);

      // Loop boundary = tick of the last JUMP event (phrase restart point).
      // Falls back to lastTick + 1 (one tick past last event) if no JUMP present.
      let jumpTick = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].cmd === "JUMP") {
          jumpTick = events[i].tick;
          break;
        }
      }
      const lastTick = events.length > 0 ? events[events.length - 1].tick : 0;
      const loopDuration = jumpTick >= 0 ? jumpTick : lastTick + 1;

      const role = track.route_hint?.role ?? "bgm";
      const carry = track.route_hint?.carry ?? false;
      return {
        events,
        loopDuration,
        flatIndex: 0,
        audioTimeAtTick0: 0,
        loopCount: 0,
        startAudioTime: 0,
        role,
        carry,
        carryState: carry,
        chIndex,
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

        // Write F-number high first (block + MSB), then low
        this._write(
          port,
          0xa4 + chOffset,
          ((block & 0x07) << 3) | ((fnum >> 8) & 0x07),
          when,
        );
        this._write(port, 0xa0 + chOffset, fnum & 0xff, when);
        // Key on: all 4 operators
        this._write(0, 0x28, 0xf0 | chKey, when);

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
        const lengthTicks = ev.args?.length ?? this._ppqn / 2;
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
      case "JUMP":
        // Handled structurally (loops expanded; markers/jumps not needed for linear playback)
        break;
    }
  }

  _applyParam(ch, port, chOffset, ev, when) {
    const regs = this._chRegs[ch];
    const target = (ev.args?.target ?? "").toUpperCase();
    const value = ev.args?.value ?? 0;
    const isAdd = ev.cmd === "PARAM_ADD";
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
      // Future: TEMPO_SCALE → timing multiplier (not a register write)

      case "VOL": {
        // vol 0-15 (15=max, 0=silent). Apply to carrier OPs based on algorithm.
        // TL = (15 - vol) * 8, clamped to 0-127.
        // ALG carrier map: which ops are carriers for each algorithm.
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
        const alg = regs.algorithm ?? 0;
        const carriers = CARRIER_OPS[alg] ?? [3];
        const vol = Math.max(
          0,
          Math.min(15, isAdd ? (regs.vol ?? 15) + value : value),
        );
        regs.vol = vol;
        const tl = Math.max(0, Math.min(127, (15 - vol) * 8));
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
      ops: r.ops.map((o) => ({ ...o })),
    };
  }

  _writeKeyOff(chIndex) {
    const port = chIndex >= 3 ? 1 : 0;
    const chOffset = chIndex % 3;
    const chKey = (port << 2) | chOffset;
    this._write(0, 0x28, chKey); // all operators off
  }

  _initDefaultVoices() {
    // Write a basic FM voice to all channels so notes are audible immediately.
    // This is a simple sine-like patch: alg=0, fb=0,
    // all ops: AR=31, TL carriers=0 / TL modulators=40, MUL=1.
    for (let ch = 0; ch < 6; ch++) {
      const port = ch >= 3 ? 1 : 0;
      const offset = ch % 3;
      const regs = this._chRegs[ch];

      // Algorithm 5 (all ops modulated from op1 output → op2,3,4 are carriers)
      // gives a richer sound for a default patch without FM programming.
      regs.algorithm = 5;
      regs.feedback = 2;
      this._write(port, 0xb0 + offset, encodeB0(regs));
      // Stereo: both
      this._write(port, 0xb4 + offset, 0xc0);

      const opConfigs = [
        { slot: 0, tl: 20, ar: 28, dr: 6, d2r: 0, sl: 0, rr: 7, mul: 1 }, // op1 (modulator)
        { slot: 1, tl: 0, ar: 31, dr: 4, d2r: 0, sl: 2, rr: 8, mul: 1 }, // op2
        { slot: 2, tl: 0, ar: 31, dr: 4, d2r: 0, sl: 2, rr: 8, mul: 1 }, // op3
        { slot: 3, tl: 0, ar: 31, dr: 4, d2r: 0, sl: 2, rr: 8, mul: 1 }, // op4
      ];

      for (const cfg of opConfigs) {
        const opOff = OP_ADDR_OFFSET[cfg.slot];
        regs.ops[cfg.slot] = {
          tl: cfg.tl,
          ar: cfg.ar,
          dr: cfg.dr,
          d2r: cfg.d2r,
          sl: cfg.sl,
          rr: cfg.rr,
          mul: cfg.mul,
          dt: 0,
        };
        this._write(port, 0x30 + opOff + offset, encode30(regs.ops[cfg.slot]));
        this._write(port, 0x40 + opOff + offset, cfg.tl);
        this._write(port, 0x50 + opOff + offset, 0x60 | cfg.ar); // RS=1
        this._write(port, 0x60 + opOff + offset, cfg.dr);
        this._write(port, 0x70 + opOff + offset, cfg.d2r);
        this._write(port, 0x80 + opOff + offset, encode80(regs.ops[cfg.slot]));
      }
    }
  }
}
