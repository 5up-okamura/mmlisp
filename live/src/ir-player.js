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

import {
  clampForTarget,
  pitchToMidi,
  midiToFnumBlock,
  composeFmTl,
  composePsgAtt,
  sweepVolAtTime,
  sampleSweepPhase,
  sampleCurveUnit,
  OP_ADDR_OFFSET,
  buildChannelRegState,
  encodeB0,
  encodeB4,
  encode60,
  encode30,
  encode80,
  fmCarrierOpsForAlg,
  CH_NAME_TO_INDEX,
  PSG_CH_NAME_TO_INDEX,
  PSG_MASTER_CLOCK,
  KEY_OFF_LEAD_SECS,
  HOLD_FRAMES,
} from "./ir-utils.js";

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
    this._pendingUiTimers = new Set(); // timeout ids for delayed UI callbacks

    // Per-channel register state for param application
    this._chRegs = Array.from({ length: 6 }, (_, i) => buildChannelRegState(i));

    // Global YM2612 state
    this._lfoRate = 0; // 0 = off, 1-8 = rate index
    this._masterVol = 31; // 0 = silent, 31 = full (additive TL offset applied to all channels)

    // Track → channel mapping (defaults to index 0 for demo)
    this._trackChannel = new Map(); // trackIndex → chIndex (0-5)

    // PSG channel routing
    this._psgTrackChannel = new Map(); // trackIndex → psgCh (0-3)
    this._psgMuted = new Array(4).fill(false); // mute state per PSG ch
    this._psgCurrentMidi = new Array(4).fill(60); // last NOTE_ON midi per PSG ch
    this._psgPitchOffset = new Array(4).fill(0); // cents offset per PSG ch
    this._psgVol = new Array(4).fill(31); // channel vol 0-31 per PSG ch
    this._psgLastVel = new Array(4).fill(15); // last note vel 0-15 per PSG ch (raw, for composition)
    this._psgVolSweep = new Array(4).fill(null); // active VOL sweep state per PSG ch

    // FM vol sweep state (same approach as PSG: store state, sample at NOTE_ON time)
    this._fmVolSweep = new Array(6).fill(null);

    // Modulator tracks by channel index (built after _flattenTracks)
    this._modulatorsByCh = new Map();

    // Mute state per channel (index 0-5)
    this._mutedChannels = new Array(6).fill(false);

    // Channels holding a len=0 note, waiting for triggerKeyOff()
    this._holdChannels = new Set();

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
    this._bpm = 120;
    this._eventIndex = 0;
    this._currentTick = 0;
    this._loopCount.clear();

    // Assign channels: use IR track.channel name if present, else auto-increment by track index
    for (let i = 0; i < (this._ir.tracks?.length ?? 0); i++) {
      this._assignChannel(i, this._ir.tracks[i]);
    }

    return this;
  }

  /** Seconds per PPQN tick at the current tempo. */
  get _secsPerTick() {
    return 60 / (this._bpm * this._ppqn);
  }

  /**
   * Load IR JSON directly from an object.
   */
  loadJSON(irObj) {
    this._ir = irObj;
    this._ppqn = irObj.ppqn ?? 48;
    this._bpm = 120;
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

    this._clearPendingUiTimers();
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
      t.startAudioTime = this._startAudioTime;
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
    this._clearPendingUiTimers();
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
    const secsPerTick = this._secsPerTick;
    return Math.max(0, Math.floor((now - t0.audioTimeAtTick0) / secsPerTick));
  }

  /**
   * Resume playback from an explicit tick position (pause/resume).
   * @param {AudioContext} audioContext
   * @param {number} fromTick  PPQN tick to resume from
   */
  playFromTick(audioContext, fromTick) {
    if (!this._ir) throw new Error("No IR loaded");
    this._clearPendingUiTimers();
    this._audioContext = audioContext;
    this._playing = true;
    const now = audioContext.currentTime;
    const secsPerTick = this._secsPerTick;
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
   * @param {number} ch  0-5 = FM, 6-9 = PSG (6=sqr1, 7=sqr2, 8=sqr3, 9=noise)
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
   * Trigger KEY-OFF for a hold note (len=0) on the given FM channel.
   * @param {number} ch  0-5 FM channel index
   */
  triggerKeyOff(ch) {
    if (!this._holdChannels.has(ch)) return;
    this._holdChannels.delete(ch);
    const when = this._ctx?.currentTime ?? 0;
    if (ch >= 6) {
      // PSG channels: silence by setting attenuation to 15 (max att = silent)
      this._psgSetAtt(ch - 6, 15, when);
    } else {
      const port = ch >= 3 ? 1 : 0;
      const chOffset = ch % 3;
      const chKey = (port << 2) | chOffset;
      this._write(0, 0x28, chKey, when);
    }
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
      const secsPerTick = this._secsPerTick;
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
    this._clearPendingUiTimers();

    // Flush worklet's pre-scheduled writes
    if (flushFn) flushFn();

    // Load new IR
    this.loadJSON(irObj);

    if (!this._audioContext) return; // playback was never started

    // Restart from resume position
    this._playing = true;
    const now = this._audioContext.currentTime;
    const secsPerTick = this._secsPerTick;
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

  /** Register a callback fired (approximately) when each PARAM_SET event plays. */
  setOnParam(fn) {
    this._onParam = fn;
  }

  _scheduleUiCallback(fn, delayMs) {
    const timerId = setTimeout(() => {
      this._pendingUiTimers.delete(timerId);
      fn();
    }, delayMs);
    this._pendingUiTimers.add(timerId);
  }

  _clearPendingUiTimers() {
    for (const timerId of this._pendingUiTimers) {
      clearTimeout(timerId);
    }
    this._pendingUiTimers.clear();
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
    const secsPerTick = this._secsPerTick;

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
            this._scheduleUiCallback(() => this._onLine(tIdx, line), delay);
          }
          track.flatIndex++;
        }

        // Per-track independent loop restart (only if source defines a loop)
        if (
          this._loop &&
          track.hasLoop &&
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

    // Stop scheduler when no track will loop further and all are exhausted
    const willLoopAny = this._loop && this._tracks.some((t) => t.hasLoop);
    if (
      !willLoopAny &&
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

      // For looped playback, restart from the last backward JUMP target marker
      // (a backward jump is one whose target marker tick < the JUMP tick).
      // Forward jumps (e.g. event-recovery goto) are ignored for loop detection.
      let jumpTick = -1;
      let jumpTarget = null;

      // Build a quick label→tick map from MARKER events
      const markerTicks = new Map();
      for (const ev of events) {
        if (ev.cmd === "MARKER" && ev.args?.id) {
          markerTicks.set(ev.args.id, ev.tick);
        }
      }

      // Pick the backward JUMP with the smallest target tick (outermost / main loop).
      // Multiple backward JUMPs can exist (e.g. goto-calm + goto-recover); the one
      // that jumps furthest back defines the structural loop boundary.
      let bestTargetTick = Infinity;
      for (let i = 0; i < events.length; i++) {
        if (events[i].cmd === "JUMP") {
          const to = events[i].args?.to ?? null;
          const targetTick = to !== null ? (markerTicks.get(to) ?? -1) : -1;
          if (
            targetTick >= 0 &&
            targetTick <= events[i].tick &&
            targetTick < bestTargetTick
          ) {
            bestTargetTick = targetTick;
            jumpTick = events[i].tick;
            jumpTarget = to;
          }
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

      // Truncate events after the backward JUMP so post-loop branch sections
      // (e.g. event-recovery #recover) are not played in normal linear flow.
      const trimmedEvents =
        jumpTick >= 0 ? events.filter((ev) => ev.tick <= jumpTick) : events;

      let loopStartIndex = 0;
      for (let i = 0; i < trimmedEvents.length; i++) {
        if (trimmedEvents[i].tick >= loopStartTick) {
          loopStartIndex = i;
          break;
        }
      }

      const lastTick =
        trimmedEvents.length > 0
          ? trimmedEvents[trimmedEvents.length - 1].tick
          : 0;
      const loopDuration =
        jumpTick >= 0
          ? Math.max(1, jumpTick - loopStartTick)
          : Math.max(1, lastTick + 1);

      const role = track.route_hint?.role ?? "bgm";
      const carry = track.route_hint?.carry ?? false;
      return {
        events: trimmedEvents,
        loopDuration,
        loopStartTick,
        loopStartIndex,
        hasLoop: jumpTick >= 0,
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

    function findFinalPassBreak(loopBody, loopId) {
      let depth = 0;
      for (let i = 0; i < loopBody.length; i++) {
        const ev = loopBody[i];
        if (ev.cmd === "LOOP_BEGIN") {
          depth++;
          continue;
        }
        if (ev.cmd === "LOOP_END") {
          if (depth > 0) depth--;
          continue;
        }
        if (depth === 0 && ev.cmd === "LOOP_BREAK" && ev.args?.id === loopId) {
          return { index: i, tick: ev.tick };
        }
      }
      return null;
    }

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
          const loopId = ev.args?.id;

          // Derive body duration from LOOP_BEGIN / LOOP_END ticks for accuracy.
          // Falls back to first/last body event ticks if LOOP_END tick is missing.
          const loopBeginTick = ev.tick;
          const loopEndTick =
            evList[k]?.tick ??
            (loopBody.length > 0
              ? loopBody[loopBody.length - 1].tick
              : loopBeginTick);
          const bodyDuration = loopEndTick - loopBeginTick;
          const finalBreak = findFinalPassBreak(loopBody, loopId);
          const finalBodyDuration =
            finalBreak != null
              ? Math.max(0, finalBreak.tick - loopBeginTick)
              : bodyDuration;

          // Expand body once (recursive), then stamp each repetition
          for (let rep = 0; rep < count; rep++) {
            const isFinalRep = rep === count - 1;
            const repBody =
              isFinalRep && finalBreak != null
                ? loopBody.slice(0, finalBreak.index)
                : loopBody;
            const expandedBody = expand(repBody, depth + 1);
            for (const bodyEv of expandedBody) {
              out.push({
                ...bodyEv,
                tick: bodyEv.tick + tickOffset + rep * bodyDuration,
              });
            }
          }

          // Shift following events by the loop's effective repeated duration.
          // On final-pass break, the last iteration may be shorter than bodyDuration.
          const effectiveDuration =
            count > 0 ? (count - 1) * bodyDuration + finalBodyDuration : 0;
          tickOffset += effectiveDuration - bodyDuration;
          j = k + 1; // skip past LOOP_END
        } else if (ev.cmd === "LOOP_BREAK") {
          // LOOP_BREAK is structural; it is consumed during expansion.
          j++;
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
      case "NOTE_ON": {
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const centOffset = this._chRegs[ch]?.pitchOffset ?? 0;
        const { fnum, block } = midiToFnumBlock(midi + centOffset / 100);
        const chKey = (port << 2) | chOffset; // 0x28 channel key
        const baseLengthTicks = ev.args?.length ?? this._ppqn / 2;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const gateTicks = this._resolveGateTicks(ev.args?.gate, lengthTicks);
        const regs = this._chRegs[ch];
        regs.currentMidi = midi;

        if (regs?.vol != null || this._fmVolSweep[ch] != null) {
          const currentVol = this._fmVolAtTime(ch, when);
          const tl = composeFmTl(
            regs.vel ?? 15,
            currentVol,
            this._masterVol ?? 31,
          );
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
        this._schedulePitchMacro(
          ev.args?.pitchMacro,
          when,
          gateTicks,
          (centOffset, t) => {
            const { fnum, block } = midiToFnumBlock(midi + centOffset / 100);
            this._write(
              port,
              0xa4 + chOffset,
              ((block & 0x07) << 3) | ((fnum >> 8) & 0x07),
              t,
            );
            this._write(port, 0xa0 + chOffset, fnum & 0xff, t);
          },
        );
        this._scheduleFmVelMacro(
          ch,
          port,
          chOffset,
          ev.args?.velMacro,
          when,
          gateTicks,
        );
        this._scheduleFmOpMacros(
          ch,
          port,
          chOffset,
          ev.args ?? {},
          when,
          gateTicks,
        );
        // Key on: all 4 operators (unless muted or vol=0).
        // YM2612: TL=127 gives totalAttn=1016 < 1023 (not silent at sustain),
        // so when vol=0 we skip key-on entirely to guarantee silence.
        const isFmSilent =
          (regs?.vol != null || this._fmVolSweep[ch] != null) &&
          this._fmVolAtTime(ch, when) === 0;
        if (!this._mutedChannels[ch] && !isFmSilent) {
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

        // Key-off at gate boundary (5ms lead for FM envelope decay)
        // gateTicks === 0 means hold indefinitely (len=0 note; KEY-OFF via triggerKeyOff())
        const secsPerTick = this._secsPerTick;
        if (gateTicks > 0) {
          const offWhen = when + gateTicks * secsPerTick - KEY_OFF_LEAD_SECS;
          this._write(0, 0x28, chKey, Math.max(when + 0.001, offWhen));
        } else {
          // Hold note: register the channel for runtime key-off
          this._holdChannels.add(ch);
        }
        break;
      }

      case "PARAM_SET": {
        this._applyParam(ch, port, chOffset, ev, when);
        break;
      }

      case "PARAM_SWEEP": {
        this._applyParamSweep(ch, port, chOffset, ev, when);
        break;
      }

      case "CARRY_SET": {
        const ti = ev._trackIndex;
        if (ti != null && this._tracks[ti]) {
          this._tracks[ti].carryState = ev.args?.carry ?? false;
        }
        break;
      }

      case "TEMPO_SET": {
        const bpm = Number(ev.args?.bpm);
        if (Number.isFinite(bpm) && bpm > 0) this._bpm = bpm;
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
    const value = ev.args?.value ?? 0;
    let nextValue = null;

    // Helper to clamp and apply
    const set = (apply, min, max) => {
      const next = Math.max(min, Math.min(max, value));
      apply(next);
      nextValue = next;
    };

    switch (target) {
      case "FM_FB":
        set(
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
          (v) => {
            regs.fms = v;
          },
          0,
          7,
        );
        this._write(port, 0xb4 + chOffset, encodeB4(regs), when);
        break;
      case "PAN": {
        set(
          (v) => {
            regs.pan = v;
          },
          -1,
          1,
        );
        this._write(port, 0xb4 + chOffset, encodeB4(regs), when);
        break;
      }
      case "LFO_RATE": {
        const rate = Math.max(0, Math.min(8, value));
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
      case "NOTE_PITCH": {
        // Cent offset applied to the current note on this FM channel (100 cents = 1 semitone).
        const baseMidi = regs.currentMidi ?? 60;
        const centOffset = value;
        regs.pitchOffset = centOffset;
        const { fnum: pf, block: pb } = midiToFnumBlock(
          baseMidi + centOffset / 100,
        );
        this._write(
          port,
          0xa4 + chOffset,
          ((pb & 0x07) << 3) | ((pf >> 8) & 0x07),
          when,
        );
        this._write(port, 0xa0 + chOffset, pf & 0xff, when);
        nextValue = centOffset;
        break;
      }

      case "VOL": {
        // vol 0-31 (31=max, 0=silent). Apply to carrier operators.
        // Clear any active FM vol sweep (PARAM_SET overrides it).
        this._fmVolSweep[ch] = null;
        const vol = Math.max(0, Math.min(31, value));
        regs.vol = vol;
        const vel = regs.vel ?? 15;
        const tl = composeFmTl(vel, vol, this._masterVol ?? 31);
        const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
        for (const opIdx of carriers) {
          regs.ops[opIdx].tl = tl;
          const opAddr = 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset;
          this._write(port, opAddr, tl, when);
        }
        nextValue = vol;
        break;
      }

      case "MASTER": {
        // Global master volume 0-31 (31=full). Re-applies carrier TL on all FM channels
        // and PSG attenuation on all PSG channels.
        const master = Math.max(0, Math.min(31, value));
        this._masterVol = master;
        // FM channels: update carrier TL
        for (let ci = 0; ci < 6; ci++) {
          const cr = this._chRegs[ci];
          const tl = composeFmTl(cr.vel ?? 15, cr.vol ?? 31, master);
          const cp = ci >= 3 ? 1 : 0;
          const co = ci % 3;
          const crs = fmCarrierOpsForAlg(cr.algorithm ?? 0);
          for (const opIdx of crs) {
            cr.ops[opIdx].tl = tl;
            this._write(cp, 0x40 + OP_ADDR_OFFSET[opIdx] + co, tl, when);
          }
        }
        // PSG channels: recalculate attenuation from vel * vol * master
        for (let psgCh = 0; psgCh < 4; psgCh++) {
          const velLevel = this._psgLastVel[psgCh] ?? 15; // 0-15, raw vel
          const vol = this._psgVolAtTime(psgCh, when); // 0-31
          this._psgSetAtt(
            psgCh,
            composePsgAtt(velLevel, vol, master),
            when,
          );
        }
        nextValue = master;
        break;
      }

      case "NOISE_MODE": {
        // Noise mode (PSG noise control) — bits 5-3 (FB + NF)
        // Values 0-7 directly map to SN76489 noise register bits 5-3
        const mode = Math.max(0, Math.min(7, value));
        if (ch === 2) {
          // PSG noise channel
          this._psgSetNoiseCfg(mode, when);
        }
        nextValue = mode;
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
      this._scheduleUiCallback(() => this._onParam(c, t, v), delay);
    }
  }

  // Clamp rawGate to [0, lengthTicks]. If rawGate is null/undefined, falls back to lengthTicks.
  _resolveGateTicks(rawGate, lengthTicks) {
    return rawGate != null ? Math.min(rawGate, lengthTicks) : lengthTicks;
  }

  // Compute { noteFrames, gateSecs } for macro scheduling.
  // gateTicks === 0 = hold note (runs until triggerKeyOff).
  _resolveNoteFramesAndGate(when, gateTicks) {
    if (gateTicks === 0) {
      return { noteFrames: HOLD_FRAMES, gateSecs: when + 1e9 };
    }
    const secsPerTick = this._secsPerTick;
    return {
      noteFrames: Math.max(1, Math.floor(gateTicks * secsPerTick * 60)),
      gateSecs: when + gateTicks * secsPerTick - KEY_OFF_LEAD_SECS,
    };
  }

  _resolveSweepEndTick(ev) {
    const trackIndex = ev._trackIndex;
    if (trackIndex == null) return ev.tick + Math.max(1, ev.args?.frames ?? 1);

    const track = this._tracks[trackIndex];
    if (!track) return ev.tick + Math.max(1, ev.args?.frames ?? 1);

    const target = (ev.args?.target ?? "").toUpperCase();
    const loopDuration = track.loopDuration ?? 1;
    const loopStartTick = track.loopStartTick ?? 0;
    const jumpTick = loopStartTick + loopDuration;
    const isLoopCurve = !!ev.args?.loop;

    // Default sweep horizon is one structural loop. If sweep starts in the intro
    // section (before loopStartTick), it must at least survive until first jump.
    let endTick =
      track.hasLoop && ev.tick < loopStartTick
        ? jumpTick
        : ev.tick + loopDuration;
    let hasExplicitStop = false;

    for (let i = track.flatIndex + 1; i < track.events.length; i++) {
      const nextEv = track.events[i];
      if ((nextEv.args?.target ?? "").toUpperCase() !== target) continue;
      if (nextEv.cmd === "PARAM_SET" || nextEv.cmd === "PARAM_SWEEP") {
        endTick = nextEv.tick;
        hasExplicitStop = true;
        break;
      }
    }

    // Looping curves (sin/triangle/square/saw/ramp) should not freeze at the
    // first loop boundary when there is no explicit overwrite. Keep them alive
    // for multiple loop iterations so channel-level LFO-style sweeps persist.
    if (!hasExplicitStop && isLoopCurve && track.hasLoop) {
      endTick = Math.max(endTick, jumpTick + loopDuration * 16);
    }

    return endTick;
  }

  _resolveSweepBudgetFrames(ev) {
    const endTick = this._resolveSweepEndTick(ev);
    const secsPerTick = this._secsPerTick;
    return Math.max(
      1,
      Math.floor(Math.max(0, endTick - ev.tick) * secsPerTick * 60),
    );
  }

  // Compute sweep iteration parameters for the current loop:
  //   budgetFrames      – total frames to write this invocation
  //   nonLoopStartFrame – absolute frame index at start of this iteration
  //   iterFrames        – how many frames to actually write (capped to remaining sweep)
  //   loopPhaseOffset   – phase offset for looping curves (sin/tri/saw/…)
  _sweepFrameParams(ev, baseFrames, loop) {
    const secsPerTick = this._secsPerTick;
    const budgetFrames = this._resolveSweepBudgetFrames(ev);
    const endTick = this._resolveSweepEndTick(ev);
    const track = ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
    const spansLoopBoundary =
      track != null && endTick >= ev.tick + (track.loopDuration ?? 0);
    const loopPhaseOffset =
      loop && spansLoopBoundary && track != null
        ? track.loopCount * budgetFrames
        : 0;
    const loopDurationFrames = track
      ? Math.max(1, Math.floor((track.loopDuration ?? 1) * secsPerTick * 60))
      : budgetFrames;
    const loopCount = track?.loopCount ?? 0;
    const nonLoopStartFrame = !loop ? loopCount * loopDurationFrames : 0;
    const iterFrames = !loop
      ? Math.max(
          0,
          Math.min(loopDurationFrames, baseFrames - nonLoopStartFrame),
        )
      : budgetFrames;
    return { budgetFrames, nonLoopStartFrame, iterFrames, loopPhaseOffset };
  }

  // Core macro scheduler shared by all targets and types.
  // Returns the audio time immediately after the last scheduled write (for
  // scheduling silence), or null if no writes were made (curve type or empty).
  _scheduleMacro(spec, noteFrames, gateSecs, when, writeFn) {
    if (!spec) return null;

    if (spec.type === "stages") {
      const { stages } = spec;
      if (!stages || stages.length === 0) return null;

      let t = when;
      for (const stage of stages) {
        if (stage.waitKeyOff) {
          // Jump time cursor to gate boundary, then continue with next stage
          t = Math.max(t, gateSecs);
          continue;
        }
        if (stage.waitFrames != null) {
          t += stage.waitFrames / 60;
          continue;
        }
        // Regular curve stage
        const {
          curve = "linear",
          from = 0,
          to = 0,
          frames: rawFrames = 1,
          loop = false,
        } = stage;
        const baseFrames = Math.max(1, Number(rawFrames));
        // For looping stages, run until gate (or next key-off boundary)
        const budget = loop
          ? Math.max(0, Math.floor((gateSecs - t) * 60))
          : baseFrames;
        for (let frame = 0; frame < budget; frame++) {
          const phase = loop
            ? (frame % baseFrames) / baseFrames
            : baseFrames <= 1
              ? 1
              : Math.min(1, frame / (baseFrames - 1));
          writeFn(
            from + (to - from) * sampleCurveUnit(curve, phase),
            t + frame / 60,
          );
        }
        t += budget / 60;
      }
      return t;
    }

    if (spec.type === "curve") {
      const { from, to, frames: rawFrames = 1, loop, curve = "linear" } = spec;
      const baseFrames = Math.max(1, Number(rawFrames));
      const activeFrames = loop ? noteFrames : Math.min(noteFrames, baseFrames);
      for (let frame = 0; frame < activeFrames; frame++) {
        const phase = loop
          ? (frame % baseFrames) / baseFrames
          : baseFrames <= 1
            ? 1
            : Math.min(1, frame / (baseFrames - 1));
        writeFn(
          from + (to - from) * sampleCurveUnit(curve, phase),
          when + frame / 60,
        );
      }
      return when + activeFrames / 60;
    }

    if (spec.type === "steps") {
      const { steps, loopIndex, releaseIndex } = spec;
      if (!steps || steps.length === 0) return null;

      const sustainEnd = releaseIndex ?? steps.length;

      // Attack + sustain loop until gate
      let t = when;
      let idx = 0;
      while (t < gateSecs) {
        if (steps[idx] !== null && steps[idx] !== undefined)
          writeFn(steps[idx], t);
        idx++;
        if (idx >= sustainEnd) {
          if (loopIndex !== null) {
            idx = loopIndex;
          } else {
            break; // one-shot: hold last attack step
          }
        }
        t += 1 / 60;
      }

      // Release phase after gate
      if (releaseIndex !== null && releaseIndex < steps.length) {
        t = gateSecs;
        for (let ri = releaseIndex; ri < steps.length; ri++) {
          if (steps[ri] !== null && steps[ri] !== undefined)
            writeFn(steps[ri], t);
          t += 1 / 60;
        }
        return t; // time after last release write
      }
      return gateSecs; // time at gate-off
    }

    return null;
  }

  // Schedule PAN and FM operator param macros embedded in NOTE_ON args.
  // Keys: pan → PAN, fm_tl1 → FM_TL1, etc. (snake_case from makeNoteArgs)
  _scheduleFmOpMacros(ch, port, chOffset, noteArgs, when, gateTicks) {
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    const OP_MACRO_MAP = {
      pan: "PAN",
      ...Object.fromEntries(
        [1, 2, 3, 4].flatMap((op) => [
          [`fm_tl${op}`, `FM_TL${op}`],
          [`fm_ar${op}`, `FM_AR${op}`],
          [`fm_dr${op}`, `FM_DR${op}`],
          [`fm_sr${op}`, `FM_SR${op}`],
          [`fm_rr${op}`, `FM_RR${op}`],
          [`fm_sl${op}`, `FM_SL${op}`],
          [`fm_ml${op}`, `FM_ML${op}`],
          [`fm_dt${op}`, `FM_DT${op}`],
          [`fm_ks${op}`, `FM_KS${op}`],
          [`fm_amen${op}`, `FM_AMEN${op}`],
        ]),
      ),
    };
    for (const [key, target] of Object.entries(OP_MACRO_MAP)) {
      const spec = noteArgs[key];
      if (!spec) continue;
      const t = target; // capture for closure
      this._scheduleMacro(spec, noteFrames, gateSecs, when, (v, when) => {
        this._applyParam(
          ch,
          port,
          chOffset,
          {
            cmd: "PARAM_SET",
            args: { target: t, value: v },
          },
          when,
        );
      });
    }
  }

  _scheduleFmVelMacro(ch, port, chOffset, velMacro, when, gateTicks) {
    if (!velMacro) return;

    const regs = this._chRegs[ch];
    const baseVol = regs.vol ?? 31;
    const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    // vel 15 = full vol, vel 0 = silent. Use unified pipeline.
    const velToTl = (v) =>
      composeFmTl(
        clampForTarget("VEL", v),
        baseVol,
        this._masterVol ?? 31,
      );

    this._scheduleMacro(velMacro, noteFrames, gateSecs, when, (v, t) => {
      const tl = velToTl(Math.round(v));
      for (const opIdx of carriers) {
        this._write(port, 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset, tl, t);
      }
    });
  }

  // Schedule a pitch macro for any channel (FM or PSG).
  // writeFn(centOffset, t) performs the hardware write for the channel.
  _schedulePitchMacro(pitchMacro, when, gateTicks, writeFn) {
    if (!pitchMacro) return;

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(pitchMacro, noteFrames, gateSecs, when, writeFn);
  }

  _applyParamSweep(ch, port, chOffset, ev, when) {
    const target = (ev.args?.target ?? "").toUpperCase();
    const from = Number(ev.args?.from ?? 0);
    const to = Number(ev.args?.to ?? 0);
    const curve = ev.args?.curve ?? "linear";
    const secsPerTick = this._secsPerTick;
    // ev.args.frames is in ticks (from parseLengthToken); convert to 60 Hz frames.
    const baseFrames = Math.max(
      1,
      Math.round(Number(ev.args?.frames ?? 1) * secsPerTick * 60),
    );
    const loop = !!ev.args?.loop;
    const { budgetFrames, nonLoopStartFrame, iterFrames, loopPhaseOffset } =
      this._sweepFrameParams(ev, baseFrames, loop);

    // NOTE_PITCH: must track future NOTE_ON base pitches so per-frame frequency
    // writes use the correct note at each point in time.
    if (target === "NOTE_PITCH") {
      const track =
        ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
      const framesPerTick = secsPerTick * 60;
      let baseMidi = this._chRegs[ch]?.currentMidi ?? 60;
      let cursor = track ? track.flatIndex + 1 : 0;
      let nextNoteTick = Infinity;
      let nextNoteMidi = baseMidi;
      const advance = () => {
        if (!track) {
          nextNoteTick = Infinity;
          return;
        }
        while (cursor < track.events.length) {
          const ne = track.events[cursor++];
          if (ne.cmd !== "NOTE_ON" || ne._isPsg) continue;
          nextNoteTick = ne.tick;
          nextNoteMidi = pitchToMidi(ne.args?.pitch ?? "c4");
          return;
        }
        nextNoteTick = Infinity;
      };
      advance();
      for (let frame = 0; frame < budgetFrames; frame++) {
        const frameTick = ev.tick + frame / Math.max(1e-9, framesPerTick);
        while (frameTick >= nextNoteTick) {
          baseMidi = nextNoteMidi;
          advance();
        }
        const phase = sampleSweepPhase(
          frame,
          baseFrames,
          loop,
          loopPhaseOffset,
        );
        const centOffset = Math.round(
          from + (to - from) * sampleCurveUnit(curve, phase),
        );
        this._chRegs[ch].pitchOffset = centOffset;
        const { fnum: pf, block: pb } = midiToFnumBlock(
          baseMidi + centOffset / 100,
        );
        const frameWhen = when + frame / 60;
        this._write(
          port,
          0xa4 + chOffset,
          ((pb & 0x07) << 3) | ((pf >> 8) & 0x07),
          frameWhen,
        );
        this._write(port, 0xa0 + chOffset, pf & 0xff, frameWhen);
      }
      return;
    }

    // VOL: write TL directly per-frame (avoids mutating regs.vol mid-sweep which
    // would cause NOTE_ON to read the wrong vol).  Store sweep state so
    // _fmVolAtTime() returns the correct instantaneous vol at NOTE_ON time.
    const regs = this._chRegs[ch];
    if (target === "VOL") {
      const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
      for (let i = 0; i < iterFrames; i++) {
        const frame = !loop ? nonLoopStartFrame + i : i;
        const phase = sampleSweepPhase(
          frame,
          baseFrames,
          loop,
          loopPhaseOffset,
        );
        const vol = Math.max(
          0,
          Math.min(31, from + (to - from) * sampleCurveUnit(curve, phase)),
        );
        const tl = composeFmTl(
          regs.vel ?? 15,
          vol,
          this._masterVol ?? 31,
        );
        const frameWhen = when + i / 60;
        for (const opIdx of carriers) {
          this._write(
            port,
            0x40 + OP_ADDR_OFFSET[opIdx] + chOffset,
            tl,
            frameWhen,
          );
        }
      }
      this._fmVolSweep[ch] = {
        from,
        to,
        curve,
        baseFrames,
        nonLoopOffset: nonLoopStartFrame,
        startWhen: when,
      };
      regs.vol = to; // final value for MASTER recalc fallback
      return;
    }

    // All other FM parameters: route through _applyParam (handles register encoding).
    for (let i = 0; i < iterFrames; i++) {
      const frame = !loop ? nonLoopStartFrame + i : i;
      const phase = sampleSweepPhase(frame, baseFrames, loop, loopPhaseOffset);
      const value = Math.round(
        from + (to - from) * sampleCurveUnit(curve, phase),
      );
      this._applyParam(
        ch,
        port,
        chOffset,
        { cmd: "PARAM_SET", args: { target, value } },
        when + i / 60,
      );
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

  // Returns the current VOL (0-31) for a PSG channel at the given audio time,
  // sampling an active VOL sweep if present.
  _fmVolAtTime(ch, when) {
    const sweep = this._fmVolSweep?.[ch];
    return sweep ? sweepVolAtTime(sweep, when) : (this._chRegs[ch].vol ?? 31);
  }

  _psgVolAtTime(psgCh, when) {
    const sweep = this._psgVolSweep?.[psgCh];
    return sweep ? sweepVolAtTime(sweep, when) : (this._psgVol[psgCh] ?? 31);
  }

  // Set noise configuration (FB + NF bits) for PSG noise channel (ch 3).
  // modeVal: 0-7 encoding FB(1bit) + NF(2bits) → bits 5-3 of noise register
  _psgSetNoiseCfg(modeVal, when) {
    // Latch byte: 1 | ch=3(2) | r=0(noise) | FB+NF(3) | extra(1)
    // Format: 1 | 11 | 0 | NF(2) | FB(1) | X(1)
    // Shifts to: bits 5-3 in final register
    const byte = 0x80 | (0x03 << 5) | ((modeVal & 0x07) << 0);
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

  // Set PSG attenuation at note-on; schedule silence at note-off.
  // gateTicks === 0 = hold note (no auto-silence; triggerKeyOff() handles it).
  _schedulePsgEnvelope(psgCh, noteWhen, gateTicks, baseVel = 15) {
    this._psgLastVel[psgCh] = Math.max(0, Math.min(15, baseVel));
    const isHold = gateTicks === 0;
    const secsPerTick = this._secsPerTick;
    const noteOffWhen = noteWhen + gateTicks * secsPerTick - KEY_OFF_LEAD_SECS;

    // Compose vel * vol * master → PSG hardware attenuation.
    const vol = this._psgVolAtTime(psgCh, noteWhen);
    const master = this._masterVol ?? 31;
    const att = composePsgAtt(baseVel, vol, master);

    this._psgSetAtt(psgCh, att, noteWhen);
    if (!isHold) this._psgSetAtt(psgCh, 15, noteOffWhen);
  }

  _schedulePsgVelMacro(psgCh, velMacro, noteWhen, gateTicks, baseVel = 15) {
    if (!velMacro) return;
    this._psgLastVel[psgCh] = Math.max(0, Math.min(15, baseVel));

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      noteWhen,
      gateTicks,
    );

    // vel 0-15 → PSG att via shared composition helpers
    const vol = this._psgVolAtTime(psgCh, noteWhen);
    const master = this._masterVol ?? 31;
    const velToAtt = (v) => {
      const velLevel = Math.round((clampForTarget("VEL", v) * baseVel) / 15);
      return composePsgAtt(velLevel, vol, master);
    };

    const silenceAt = this._scheduleMacro(
      velMacro,
      noteFrames,
      gateSecs,
      noteWhen,
      (v, t) => this._psgSetAtt(psgCh, velToAtt(Math.round(v)), t),
    );
    // On hold notes (gateTicks === 0), silence is triggered by triggerKeyOff().
    if (silenceAt !== null && gateTicks !== 0) {
      this._psgSetAtt(psgCh, 15, silenceAt);
    }
  }

  _dispatchPsgEvent(ev, when) {
    const psgCh = ev._psgCh ?? 0;

    switch (ev.cmd) {
      case "NOTE_ON": {
        if (this._psgMuted[psgCh]) break;

        const isNoise = psgCh === 3;
        const baseLengthTicks = ev.args?.length ?? this._ppqn / 2;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const psgGateTicks = this._resolveGateTicks(ev.args?.gate, lengthTicks);
        if (!isNoise) {
          const midi = pitchToMidi(ev.args?.pitch ?? "c4");
          this._psgCurrentMidi[psgCh] = midi;
          const psgCentOffset = this._psgPitchOffset[psgCh] ?? 0;
          this._psgSetPitch(psgCh, midi + psgCentOffset / 100, when);
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            psgGateTicks,
            (centOffset, t) =>
              this._psgSetPitch(psgCh, midi + centOffset / 100, t),
          );
        } else {
          this._psgTriggerNoise(when);
        }
        if (psgGateTicks === 0) {
          // Hold note: register for runtime key-off via triggerKeyOff(psgCh + 6)
          this._holdChannels.add(psgCh + 6);
        }
        const baseVel = ev.args?.vel ?? 15;
        const velMacro = ev.args?.velMacro ?? null;
        if (velMacro) {
          this._schedulePsgVelMacro(
            psgCh,
            velMacro,
            when,
            psgGateTicks,
            baseVel,
          );
        } else {
          this._schedulePsgEnvelope(psgCh, when, psgGateTicks, baseVel);
        }
        break;
      }

      case "PARAM_SET":
      case "PARAM_SWEEP": {
        const psgTarget = (ev.args?.target ?? "").toUpperCase();
        if (psgTarget === "VOL") {
          if (ev.cmd === "PARAM_SET") {
            // Immediate vol: store and update hardware using last known vel.
            const vol = Math.max(0, Math.min(31, ev.args?.value ?? 31));
            this._psgVol[psgCh] = vol;
            this._psgVolSweep[psgCh] = null;
            const velLevel = this._psgLastVel[psgCh] ?? 15;
            const master = this._masterVol ?? 31;
            this._psgSetAtt(
              psgCh,
              composePsgAtt(velLevel, vol, master),
              when,
            );
          } else {
            // PARAM_SWEEP: store sweep state (same format as _fmVolSweep).
            // Hardware writes happen lazily at each NOTE_ON via _psgVolAtTime().
            const from = Math.max(0, Math.min(31, Number(ev.args?.from ?? 31)));
            const to = Math.max(0, Math.min(31, Number(ev.args?.to ?? from)));
            const curve = ev.args?.curve ?? "linear";
            const secsPerTick = this._secsPerTick;
            const baseFrames = Math.max(
              1,
              Math.round(Number(ev.args?.frames ?? 1) * secsPerTick * 60),
            );
            this._psgVolSweep[psgCh] = {
              from,
              to,
              curve,
              baseFrames,
              nonLoopOffset: 0,
              startWhen: when,
            };
            this._psgVol[psgCh] = from; // initial value for MASTER recalc fallback
          }
        } else if (psgTarget === "NOTE_PITCH") {
          const from = Number(ev.args?.from ?? ev.args?.value ?? 0);
          const to = Number(ev.args?.to ?? from);
          const curve = ev.args?.curve ?? "linear";
          const secsPerTick = this._secsPerTick;
          // ev.args.frames is ticks; convert to 60 Hz frames.
          const baseFrames = Math.max(
            1,
            Math.round(Number(ev.args?.frames ?? 1) * secsPerTick * 60),
          );
          const loop = !!ev.args?.loop;
          const framesPerTick = secsPerTick * 60;
          const { budgetFrames, loopPhaseOffset } =
            ev.cmd === "PARAM_SWEEP"
              ? this._sweepFrameParams(ev, baseFrames, loop)
              : { budgetFrames: 1, loopPhaseOffset: 0 };
          const track =
            ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
          let baseMidi = this._psgCurrentMidi[psgCh] ?? 60;
          let cursor = track ? track.flatIndex + 1 : 0;
          let nextNoteTick = Infinity;
          let nextNoteMidi = baseMidi;

          const advance = () => {
            if (!track) {
              nextNoteTick = Infinity;
              return;
            }
            while (cursor < track.events.length) {
              const ne = track.events[cursor++];
              if (ne.cmd !== "NOTE_ON" || !ne._isPsg) continue;
              if ((ne._psgCh ?? 0) !== psgCh) continue;
              nextNoteTick = ne.tick;
              nextNoteMidi = pitchToMidi(ne.args?.pitch ?? "c4");
              return;
            }
            nextNoteTick = Infinity;
          };
          advance();

          // Store final pitch offset (used when no active sweep)
          this._psgPitchOffset[psgCh] = ev.cmd === "PARAM_SET" ? from : to;
          for (let frame = 0; frame < budgetFrames; frame++) {
            const frameTick = ev.tick + frame / Math.max(1e-9, framesPerTick);
            while (frameTick >= nextNoteTick) {
              baseMidi = nextNoteMidi;
              advance();
            }
            const phase = sampleSweepPhase(
              frame,
              baseFrames,
              loop,
              loopPhaseOffset,
            );
            const centOffset =
              from + (to - from) * sampleCurveUnit(curve, phase);
            this._psgPitchOffset[psgCh] = centOffset;
            this._psgSetPitch(
              psgCh,
              baseMidi + centOffset / 100,
              when + frame / 60,
            );
          }
        }
        break;
      }

      case "TEMPO_SET": {
        const bpm = Number(ev.args?.bpm);
        if (Number.isFinite(bpm) && bpm > 0) this._bpm = bpm;
        break;
      }

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
