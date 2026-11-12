/**
 * MMLisp IR player.
 *
 * Loads an IR JSON file, translates events into the target's register writes
 * (its chips' encoders, chips/), and schedules them via a write callback
 * timed by the Web Audio clock.
 *
 * Usage:
 *   const player = new IRPlayer(writeCallback);
 *   await player.loadURL('path/to/score.ir.json');
 *   player.play();
 *   player.stop();
 *
 * writeCallback(port, addr, data) is the chip's write, which in practice
 * posts messages to the AudioWorklet.
 */

import { toSlotValue, snapNote, WAVE, waveEval, waveSlots, waveSteps } from "../ir/ranges.js";
import { midiToHz, pitchToMidi } from "../ir/pitch.js";
import { velK, levelSteps, levelGain, VOL_UNITY } from "../ir/levels.js";
import { sampleCurveUnit } from "../ir/curves.js";
import { buildChannelRegState, fmCarrierOpsForAlg } from "../machine/chips/opn-regs.js";
import { KEY_OFF_LEAD_SECS, KEY_ORDER_EPS_SECS, HOLD_FRAMES, expandLoops } from "../ir/timing.js";
import { toneLaneOf, targetProfile, notYet } from "../machine/targets.js";
import { curveId, sweepFrameValue, bpmToTickIncrement, tickIncrementToBpm } from "../driver/mmb.js";
import { PCM8_VOICES } from "../machine/chips/msm6258.js";
import { FM_OPS, fmInitVoice, fmOpWord } from "../ir/fm-words.js";
import { FM_CHANNELS, CORE_OF_KIND, PSG_LANES, FM_LFO_ROUTE, isSongWord, SAMPLE_HANDLERS, TIMED_CMDS, KEYED, FM3_KEYS, LFO_TARGETS, WAVE_LFO_WORDS, HAND_PARAMS, writesVol, handWordOf, LFO_RESET_GAP, OP_REG_FIELD, OP_MACRO_MAP, songOrEffectIr, drvBpm, PLAYHEAD_SKIP_CMDS, lcm, NO_FM, SWEEP, MACRO, SONG, FM3_TL } from "./ir-player-shared.js";
import { workMethods } from "./ir-player-work.js";
import { panelMethods } from "./ir-player-panel.js";
import { keyMethods } from "./ir-player-keys.js";
import { wordMethods } from "./ir-player-words.js";
import { macroMethods } from "./ir-player-macros.js";
import { levelMethods } from "./ir-player-levels.js";
import { sampleMethods } from "./ir-player-samples.js";

export { songOrEffectIr } from "./ir-player-shared.js";

export class IRPlayer {
  /**
   * @param {function(port:number, addr:number, data:number): void} writeCallback
   */
  constructor(writeCallback) {
    this._target = targetProfile(); // until a score says otherwise (_loadIR)
    this._fmChip = this._target.chipForKind("fm");
    this._fmEnc = this._fmChip?.fmEncoder() ?? NO_FM; // the FM's registers (chips/)
    this._rhythmEnc = this._rhythmEncOf(this._target);
    this._psgChip = this._psgChipOf(this._target); // null: a target with no PSG
    this._toneEnc = this._toneEncodersOf(this._target, this._psgChip);
    this._chipsStarted = new Set(); // the optional chips written to this run (_lane)
    this._waveLfo = {}; // a wave chip's LFO words as last written (_initDefaultVoices)
    // Each track's route (_assignChannel): { core, part, lane } — the core
    // that plays it, its part, and its lane in that core (the FM channel, the
    // PSG lane, the sample voice).
    this._routes = new Map();
    // Every chip write goes out through `_write`, whatever writer is set (a
    // capture, a seek set their own); on a target whose drivers run on the
    // video frame (`frameClock`, the MSX) a write's time is moved to the
    // frame it falls on, where the driver would make it (_frameTime). The
    // wrapper read is the writer's own, so one saved and set back (a capture
    // restoring the page's) is that writer again.
    let rawWrite = writeCallback;
    let framed = null;
    Object.defineProperty(this, "_sink", {
      get: () => {
        if (!this._target?.frameClock) return rawWrite;
        if (framed?.raw !== rawWrite) {
          const raw = rawWrite;
          framed = (port, addr, data, when) => raw(port, addr, data, this._frameTime(when));
          framed.raw = raw;
        }
        return framed;
      },
      set: (fn) => { rawWrite = fn?.raw ?? fn; },
      configurable: true,
    });
    // A write on a timer of the machine's own, not the video frame (the PC
    // Engine's DDA, a sample a CPU timer tick): the writer itself, unmoved.
    Object.defineProperty(this, "_writeTimer", { get: () => rawWrite, configurable: true });
    // The plain writes still ahead (_write), in time order: { t, write }.
    this._ahead = [];
    this._aheadHead = 0; // the first not yet sent
    // The work of the frames ahead (_at, _step), in the frame's order: { F, phase, t, run }.
    this._work = [];
    this._workHead = 0;
    this._workFinite = 0; // the items a run waits for (_workLeft)
    this._stampFrom = -Infinity; // a frame's work running: its own time, and how far
    this._stampShift = 0; // its writes move to follow the frame's events (_runWork)
    this._lastEvent = { F: -Infinity, t: -Infinity }; // the last event dispatched: its frame and time
    this._writeCursor = Infinity; // the time the run has reached; Infinity with no run
    this._ir = null;
    this._playing = false;
    this._loopCount = new Map(); // loopId → iteration count
    this._eventIndex = 0;
    this._currentTick = 0;
    this._ppqn = 96; // the IR's own (ir.md §2)
    this._bpm = 120;
    this._tempoSweep = null;
    this._hands = new Map(); // a control's id → { held }: the panel's value is its word's (hold)
    this._handCtl = new Map(); // a control's id → the control the panel held (hands)
    this._schedGen = 0; // bumped whenever a track's next event moves
    this._startAudioTime = 0;
    this._frameOrigin = 0; // audio time of frame 0 (the sweep frame grid)
    this._audioContext = null;
    this._schedulerTimer = null;
    this._schedulerLookahead = 0.2; // seconds
    this._schedulerInterval = 25; // ms
    this._scheduledHorizon = 0; // the furthest audio time the run has queued events to
    this._loop = true; // loop by default
    this._onLine = null; // (line: number) => void — called when an event fires
    this._onTrig = null; // (trackIdx, code) => void — a (trig N) cue plays
    this._onHold = null; // (trackIdx) => void — a track stops at a `:len 0` hold
    this._onPosition = null; // (record) => void — where a note's macro or sample will be (setOnPosition)
    this._noteOf = []; // per track: its note now (a macro's steps are that note's)
    this._noteScope = null;
    this._onRunStart = null; // () => void — after play()'s reset, before scheduling
    this._pendingUiTimers = new Set(); // timeout ids for delayed UI callbacks

    // Gapless swap (Build during playback): a swap requested by swapAtNextBar()
    // is deferred until the next bar boundary so already-scheduled audio plays
    // out untouched. While a swap is pending, old tracks stop scheduling at
    // _scheduleCapTime; after commit, _dispatchFloor suppresses any new write
    // before the boundary so the new IR starts exactly on the boundary.
    this._pendingSwap = null; // { irObj, boundaryTick, boundaryTime } | null
    this._chaseWatch = null; // seek(): { line, time } while a chase looks for a line
    this._scheduleCapTime = Infinity; // audio time; old tracks don't schedule past this
    this._dispatchFloor = -Infinity; // audio time; events before this are skipped (not dispatched)
    // Per-channel register state for param application
    this._chRegs = Array.from({ length: FM_CHANNELS }, (_, i) => buildChannelRegState(i));
    // The sample each PCM voice last played: a PCM part's voice, as _chRegs
    // holds an FM channel's (what the live keys play on a selected part).
    this._pcmSample = [null, null, null];

    // Global YM2612 state
    this._lfoRate = 0; // 0 = off, 1-8 = rate index
    this._opmLfo = { freq: 0, pmd: 0, amd: 0, wave: 0 }; // the OPM's own LFO, as last written
    this._masterVol = VOL_UNITY; // 0 = silent, 31 = full (additive TL offset applied to all channels)
    this._reg27 = 0;
    this._fm3Ops = false; // CH3's operators are tracks of their own (FM3_MODE op / csm-op)

    // PCM levels are composed where the driver composes them — in the voice
    // model the worklet runs (src/driver/pcm-voices.js) — so this side only forwards
    // the score's events, in time order.

    this._psgSnap = new Array(PSG_LANES).fill(0); // `:snap` mask per PSG ch
    // A NOTE_PITCH sweep is scheduled whole at dispatch, leaving the pitch
    // offsets above at its END value. A glide sweep is emitted just before its
    // note's NOTE_ON (same tick), so that note must start from the sweep's
    // FIRST value instead — else its onset write lands on the target pitch for
    // a frame before the slide begins. Keyed "fm:ch" / "psg:ch" / "op:n".
    this._levels = new Map(); // a voice's level, by its site ("fm:0", "fm3op:1", "psg:0" …): _lv
    this._pitches = new Map(); // a voice's pitch, by its site: _pt
    this._psgKeyedUntil = new Array(PSG_LANES).fill(0); // when the current note keys off
    // Whether each PSG ch is currently sounding a note (att under its off). A PSG channel
    // drones whenever its attenuation is non-silent, regardless of frequency, so
    // master/vol recomputes must NOT re-write a non-silent att to an idle channel
    // (that would un-silence it into a tone). Updated on every _psgSetAtt.
    this._psgSounding = new Array(PSG_LANES).fill(false);
    this._laneWave = new Array(PSG_LANES).fill(null); // the def-wave each wave lane plays (by name)
    this._psgPan = new Array(PSG_LANES).fill(0); // each lane's pan as last written (a chip with a pan per channel: the PC Engine's)
    this._psgDuty = new Array(PSG_LANES).fill(8); // each lane's duty in sixteenths (the 2A03's pulses)
    this._laneLfoSync = new Array(PSG_LANES).fill(false); // a lane's :lfo-sync (the PC Engine's, the FDS's)
    this._fmKeyMask = new Array(FM_CHANNELS).fill(0);
    this._laneExpr = new Array(PSG_LANES).fill(null); // a lane's wave expression with $slots: { tree, slots, vals }
    this._drawnWaves = new Map(); // def-wave name → the steps the editor drew over it (setWave)
    // Persistent PSG noise mode (FB+NF bits 0-7). A noise NOTE_ON re-asserts this
    // current value; PARAM_SET NOISE_MODE updates it; the mode macro is a
    // temporary override layered on top. Default white0 (0b1_00) matches the
    // compiler's tick-0 default emission.
    this._psgNoiseMode = 0b1_00;
    // The SSG's hardware envelope (chips/ssg.js): each lane's shape (-1: its
    // 4-bit level), and the lane whose notes the period the lanes share
    // follows (`:env-rate note`), or null.
    this._psgEnv = new Array(PSG_LANES).fill(-1);
    this._envFollow = null;
    this._envRate = 0; // the song's envelope rate (ENV_RATE; 0: following a lane's notes)
    // Each lane's moves on the period it gives (:env-semi semitones,
    // :env-detune steps), and the pitch it last wrote, which a following
    // envelope's period is rewritten from when they change.
    this._envSemi = new Array(PSG_LANES).fill(0);
    this._envDetune = new Array(PSG_LANES).fill(0);
    this._psgHz = new Array(PSG_LANES).fill(0);
    // The SSG's mixer each lane's :mode sets and the song's noise period,
    // which a note after one whose macro moved them writes back; and the
    // lanes whose last note's macro did.
    this._ssgMixBase = new Array(PSG_LANES).fill(null);
    this._noiseRateBase = null;
    this._ssgMacroed = new Array(PSG_LANES).fill(null); // { mix, rate }

    // FM vol sweep state (same approach as PSG: store state, sample at NOTE_ON time)

    // Mute / solo state keyed by track index (a track == one sounding channel,
    // e.g. fm3-1, pcm1). Solo overrides mute: when any track is soloed, only
    // soloed tracks sound.
    this._mutedTracks = new Set();
    this._soloTracks = new Set();
    // The YM2608's sample voices as the mixer has them: the six rhythm sounds
    // ("bd" … "rim") and the ADPCM-B ("adpcm"), whichever track keys them.
    this._mutedVoices = new Set();
    this._soloVoices = new Set();
    this._masterHand = null; // { v, held }: the panel's MASTER, laid over the score's (_handMaster)
    this._slots = new Map(); // a sweep's slot (_slotKey) → its sweep (_resetRunState)
    this._panelWrite = false; // the panel's own write, which no hand stops

    // Channels holding a note until triggerKeyOff() (`:len 0` or `:gate 0`):
    // channel id → the track that keyed it.

    // FM3 independent-operator mode: each fm3-1..fm3-4 track keys a single
    // operator of channel 3 via the shared 0x28 key register (see
    // _fm3Edge).
    this._resetFm3();

    // Per FM channel: a full-gate note has run up to the next note and left its
    // key-off for that note's dispatch to write (driver: `pendingOff`).
    this._open = []; // per track: its open note — its gate not yet closed (_openNote)

    // Key-on operator mask per channel (default 0xf0 = all 4 ops on)
    this._opMasks = new Array(FM_CHANNELS).fill(0xf0);

    // Per-track scheduler state (set in play())
    this._tracks = [];
  }

  /**
   * Load an IR JSON from a URL.
   */
  async loadURL(url) {
    const res = await fetch(url);
    this._loadIR(songOrEffectIr(await res.json(), null));
    return this;
  }

  /** Seconds per PPQN tick at the current tempo. */
  get _secsPerTick() {
    return 60 / (this._bpm * this._ppqn);
  }

  /**
   * Load IR JSON directly from an object.
   */
  /**
   * Load a compiled IR. The song plays its own tracks — an effect's parts
   * (def-se) are the game's to start, never the song's. `se` auditions one
   * effect alone instead: its parts, and nothing of the song.
   * @param {object} irObj
   * @param {{se?: number|null}} [opts]
   */
  loadJSON(irObj, { se = null } = {}) {
    this._loadIR(songOrEffectIr(irObj, se));
    this._irGiven = se == null ? irObj : null; // the IR as given (loadedIr), not its song's copy; an effect's run its own
    return this;
  }

  _resolveInitialTempo(irObj) {
    // Last tick-0 TEMPO_SET wins (track order), matching the last-writer-wins
    // resolution of mid-track tempo dispatch across parallel tracks.
    let bpm = 120;
    for (const track of irObj?.tracks ?? []) {
      for (const ev of track.events ?? []) {
        if (ev?.cmd !== "TEMPO_SET") continue;
        if ((ev.tick ?? 0) !== 0) continue;
        const v = Number(ev.args?.bpm);
        if (Number.isFinite(v) && v > 0) bpm = v;
      }
    }
    return drvBpm(bpm);
  }

  setPcmBankRate(rateHz) {
    this._pcmBankRate = Number.isFinite(rateHz) && rateHz > 0 ? rateHz : null;
  }

  // The rate the score's sample bank was baked at (setPcmBankRate), which the
  // loop-length conversion below speaks. It is NOT reset here: the bank is
  // synced around every load, including a gapless swap that commits later.
  _loadIR(irObj) {
    this._ir = irObj;
    // The machine the score is for (targets/): its chips' clocks and
    // encoders. A target whose chips have no encoder yet is refused here,
    // rather than written as the Mega Drive's.
    const target = targetProfile(irObj.metadata?.target);
    const why = notYet(target, "encode");
    if (why) throw new Error(why);
    this._target = target;
    this._fmChip = target.chipForKind("fm");
    this._fmEnc = this._fmChip?.fmEncoder() ?? NO_FM;
    this._rhythmEnc = this._rhythmEncOf(target);
    this._psgChip = this._psgChipOf(target); // one per score: it may keep state
    this._toneEnc = this._toneEncodersOf(target, this._psgChip, this._voicesOf(target, irObj));
    this._chipsStarted.clear();
    this._dmcRates = null; // the DMC's rates are this score's (_dmcRateOf)
    // The ports that write a chip's memory, not its registers (chips/ `ramBlock`).
    this._ramPorts = new Set(Object.values(target.chips).flatMap((c) =>
      Object.entries(c.vgm?.ports ?? {}).filter(([, p]) => p?.ramBlock).map(([port]) => Number(port))));
    this._laneWave.fill(null);
    this._laneExpr.fill(null);
    this._drawnWaves.clear();
    // The FM core's level ladder (chips/parts.js `level`): its TL — the
    // OPLL's, its channel volume, and op1's TL for a modulator (`modLevel`).
    // A part's narrower registers (`ranges`) clamp its writes.
    const fmPart = target.parts.find((p) => p.kind === "fm");
    this._fmLevel = fmPart?.level ?? null;
    this._fmModLevel = fmPart?.modLevel ?? this._fmLevel;
    this._fmRanges = fmPart?.ranges ?? null;
    // The fm3-csm voice: the track that turns CSM on. Timer A keys it, so the
    // mixer's mute has to hold the timer rather than key the channel off.
    this._csmTrack = (irObj.tracks ?? []).findIndex((t) =>
      (t.events ?? []).some((e) => e.cmd === "CSM_ON"));
    this._ppqn = irObj.ppqn;
    // An edit swapped in while the panel holds the tempo keeps the panel's.
    if (!this._hands?.has("tempo")) this._bpm = this._resolveInitialTempo(irObj);
    this._tempoSweep = null;
    // Dynamic value slots (§8): name → current value, seeded from def-val inits.
    // The host (or live UI) mutates these via setVal(); scores read them with
    // $name and PARAM_FROM_VAL / PARAM_ADD / PARAM_MUL.
    const kept = this._vals;
    this._vals = {};
    this._valUnits = {}; // slot → "frame" | "tick" (for dynamic :len/:step)
    this._valNames = []; // slot index → name, for the VALn write targets
    for (const v of irObj.metadata?.vals ?? []) {
      this._vals[v.name] = toSlotValue(v.init) ?? 0;
      this._valUnits[v.name] = v.unit ?? "frame";
      this._valNames[v.slot] = v.name;
      // An edit swapped in keeps a slot the panel has in hand.
      if (this._hands?.has(`val:${v.name}`) && kept && v.name in kept) this._vals[v.name] = kept[v.name];
    }
    this._eventIndex = 0;
    this._currentTick = 0;
    this._loopCount.clear();
    this._routes.clear();
    // Each PSG lane's level ladder: its part's, from the target's channel
    // table — every lane the machine has, not only the score's, since the
    // keys play any of them.
    this._psgLevel = new Array(PSG_LANES).fill(null);
    for (const c of Object.values(target.channels))
      if (CORE_OF_KIND[c.part.kind] === "psg") this._psgLevel[toneLaneOf(c)] = c.part.level;
    this._rhythmState = null; // per-track vol / pan of the chips' own PCM parts
    this._adpcmState = null;
    this._pcm8State = this._ddaState = this._dpcmState = null;
    for (let i = 0; i < (irObj.tracks?.length ?? 0); i++) {
      this._assignChannel(i, irObj.tracks[i]);
    }
  }

  /**
   * Start playback using the provided AudioContext for timing.
   * @param {AudioContext} audioContext
   * @param {{ loop?: boolean }} [options]
   */
  play(audioContext, options = {}) {
    if (!this._ir) throw new Error("No IR loaded");
    this._resetRunState();

    if (options.loop !== undefined) this._loop = options.loop;

    this._clearPendingUiTimers();
    this._audioContext = audioContext;
    this._playing = true;
    this._startAudioTime = audioContext.currentTime + 0.05; // small startup offset
    this._scheduledHorizon = 0;
    this._frameOrigin = this._startAudioTime;

    // Initialize all channels with default voices
    this._initDefaultVoices();

    this._resetFm3();
    this._open = [];

    // Build per-track scheduler state
    this._tracks = this._flattenTracks();
    for (const t of this._tracks) {
      t.audioTimeAtTick0 = this._startAudioTime;
      t.startAudioTime = this._startAudioTime;
      t.loopCount = 0;
      t.flatIndex = 0;
      this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
    }

    this._runs = (this._runs ?? 0) + 1; // runNumber
    this._onRunStart?.();
    this._scheduleLoop();
  }

  stop() {
    this._playing = false;
    if (this._schedulerTimer !== null) {
      clearTimeout(this._schedulerTimer);
      this._schedulerTimer = null;
    }
    this._clearPendingUiTimers();
    this._dropAhead();
    this._writeCursor = Infinity;
    // All notes off (FM)
    for (let ch = 0; ch < this._fmEnc.channels; ch++) {
      this._fmKey(ch, 0);
    }
    // Silence all PSG channels
    for (let psgCh = 0; psgCh < PSG_LANES; psgCh++) {
      this._psgSetAtt(psgCh, this._psgOff(psgCh));
    }
    // CSM keys CH3 from Timer A, which no key-off reaches: clear the mode
    // and the timer, or a stopped CSM voice keeps buzzing. Its operators were
    // never keyed through $28 either, so a key-off starts no release for
    // them: with a slow RR (a held formant) they would ring on at their last
    // level — their key is their TL (driver.md §9), so that is what stops them.
    if (this._reg27 & 0x80)
      for (let op = 0; op < 4; op++) this._fmWrites(this._fmEnc.ch3Tl(op, 127));
    this._reg27 = 0;
    this._fm3Ops = false;
    if (this._fmEnc.csm) this._fmWrites(this._fmEnc.mode(0));
    this._silenceChipPcm();
  }

  // Every voice the chips' own sample parts sound — the ADPCM-B, the ROM
  // rhythm's six, PCM8's eight — stopped at `when` (now when absent): a run's
  // end and a seek's point, where nothing the song keyed may ring on.
  _silenceChipPcm(when) {
    const write = (writes) => { for (const [p, a, d] of writes) this._write(p, a, d, when); };
    const adpcm = this._target.chipFor("adpcm-b")?.adpcm;
    if (adpcm) write(adpcm.stop());
    const kit = this._target.parts.find((p) => p.kit)?.kit;
    if (this._rhythmEnc && kit) for (const sound of Object.values(kit)) write(this._rhythmEnc.dump(sound));
    for (const enc of this._queuedEncoders()) enc.drop?.(); // the SSG's queued mixer changes, the 2A03's levels
    const t = when ?? this._audioContext?.currentTime ?? 0;
    if (this._target.hasPart("pcm8")) for (let v = 0; v < PCM8_VOICES; v++) this._pcm8Ev(t, { kind: "cut", voice: v });
    // The PC Engine's DDA channels back off (a sample cut where it stands).
    const dda = this._ddaEncoder();
    if (dda) for (const [, ch] of this._lanesOf("sample", "pce-dda")) write(dda.off(ch));
    // The 2A03's DMC stops.
    const dmc = this._target.chipFor("fc-dpcm")?.dmc;
    if (dmc) write(dmc.stop());
  }

  // The chip and channel state belongs to one run. A run's sticky state (a
  // channel's :vol, :vel, pitch offset, the master level …) is where the
  // previous run left it, so a second play of the same score started from
  // there; sweeps and keyed spans are kept in audio time, so a previous run's
  // would read as running in this one.
  _resetRunState() {
    this._dropAhead();
    this._writeCursor = -Infinity; // a run: its writes wait for their time (_write)
    this._hands.clear(); // a run starts with the score's own values
    this._handCtl.clear();
    this._levels.clear();
    this._pitches.clear();
    this._trackPans = null; // a sample track's pan is its run's (_setPan)
    this._masterHand = null;
    // A sample track's range, loop and pan are its run's: a second run, or
    // the score reloaded, starts from the track's own again.
    this._pcm8State = this._ddaState = this._dpcmState = null;
    this._chRegs = Array.from({ length: FM_CHANNELS }, (_, i) => buildChannelRegState(i));
    this._pcmSample = [null, null, null];
    this._lfoRate = 0;
    this._opmLfo = { freq: 0, pmd: 0, amd: 0, wave: 0 };
    this._masterVol = VOL_UNITY;
    this._chipPcm = null; // the chips' own sample voices (_chipPcmState)
    this._laneExpr?.fill(null); // a wave expression is its run's (_waveExprFrame)
    this._psgPan?.fill(0);
    this._psgDuty?.fill(8);
    this._laneLfoSync?.fill(false);
    this._fmKeyMask = new Array(FM_CHANNELS).fill(0); // each FM channel's key bits as last written (_fmKey)
    this._pcmPointNow = null;
    this._reg27 = 0; // FM3 special / CSM mode
    this._fm3Ops = false;
    this._csmHold = false; // a rate rest stopped Timer A (driver.md §9)
    this._psgSnap.fill(0);
    this._psgNoiseMode = 0b1_00;
    this._psgEnv.fill(-1);
    this._envFollow = null;
    this._envRate = 0;
    this._envSemi.fill(0);
    this._envDetune.fill(0);
    this._psgHz.fill(0);
    this._ssgMixBase.fill(null);
    this._noiseRateBase = null;
    this._ssgMacroed.fill(null);
    this._loopCount.clear();
    this._psgKeyedUntil.fill(0);
    this._slots = new Map(); // a sweep's slot (_slotKey) → the sweep whose frames may still write
  }

  /** Returns true if playback is currently running. */
  isPlaying() {
    return this._playing;
  }

  /** Past a song's end, which `isPlaying` outlasts; a looping song has none. */
  ended() {
    return this._playing && !!this._allScheduled && this._audioContext?.currentTime >= this._songEndTime();
  }

  /**
   * Expanded event list for a track — counted `(x N …)` loops unrolled — for
   * visualizers. While playing returns the already-expanded scheduler events;
   * otherwise expands the IR on demand. Ticks align with trackClock().
   * @param {number} trackIndex index into ir.tracks
   */
  expandedTrackEvents(trackIndex) {
    const tr = this._tracks?.[trackIndex];
    if (tr) return tr.events;
    const evs = this._ir?.tracks?.[trackIndex]?.events;
    return evs ? this._expandLoops(evs) : [];
  }

  /**
   * Per-track playback clock for visualizers: the event tick the track plays
   * now (trackTickAt — wrapping round its loop), the loop length in ticks and
   * the tick the loop jumps back to, if the track loops. Returns null when not
   * playing.
   * @param {number} trackIndex index into ir.tracks (== flattened track index)
   */
  trackClock(trackIndex) {
    const tr = this._tracks?.[trackIndex];
    if (!this._playing || !tr || !this._audioContext) return null;
    const tick = Math.max(0, this.trackTickAt(trackIndex, this._audioContext.currentTime).tick);
    return {
      tick,
      loopTicks: tr.hasLoop ? tr.loopDuration : null,
      loopStartTick: tr.hasLoop ? tr.loopStartTick : null,
    };
  }

  /**
   * Where a track is at an AudioContext time: `tick`, the event tick it plays
   * then (wrapping round its loop), and `raw`, the ticks since its first pass
   * began, which keep counting across loop passes. Worked out from the first
   * pass's anchor (startAudioTime, kept through seeks, tempo changes and
   * holds), not audioTimeAtTick0: the scheduler, running ahead, re-anchors
   * the next pass a lookahead early, and a clock read from that sat at the
   * loop start — or a loop off — until the audio caught up. Returns null when
   * not playing.
   * @param {number} trackIndex index into ir.tracks (== flattened track index)
   * @param {number} audioTime seconds on the AudioContext clock
   */
  trackTickAt(trackIndex, audioTime) {
    const tr = this._tracks?.[trackIndex];
    if (!this._playing || !tr) return null;
    const raw = (audioTime - tr.startAudioTime) / this._secsPerTick;
    const jump = tr.loopStartTick + tr.loopDuration;
    const tick = tr.hasLoop && raw >= jump
      ? tr.loopStartTick + ((raw - tr.loopStartTick) % tr.loopDuration)
      : raw;
    return { raw, tick };
  }

  /**
   * Play from the first event of a source line — the nearest line at or above
   * it that has one; its first pass, a line in a loop body included — as
   * seek() does: chased, so the line sounds as it does when the song reaches
   * it.
   * @param {AudioContext} audioContext
   * @param {number} cursorLine  1-based source line number
   * @param {Array<{line:number,tick:number}>} sourceMap  from compileMMLisp()
   */
  playFromLine(audioContext, cursorLine, sourceMap) {
    let line = null;
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
      if (found >= 0) line = sourceMap[found].line;
    }
    return this.seek(audioContext, line == null ? { sec: 0 } : { line });
  }

  /**
   * Play from a point in the song — `sec` seconds from the top, or the first
   * time an event of source `line` plays — as if it had played up to there. The run
   * is CHASED: every event before the point is dispatched against a clock set
   * that far in the past, its register writes held back, so voices, params,
   * tempo, macros and sweeps stand exactly where playing from the top would
   * have left them. The chip then gets the held writes at once, without their key-ons,
   * and every channel keyed off — nothing sounds across the seek — and
   * playback goes on live. The UI callbacks stay silent through the chase.
   * The caller flushes writes the worklet already holds from the old run.
   * @param {AudioContext} audioContext
   * @param {{sec?: number, line?: number}} at
   * @returns {number} the point's time from the top, in seconds
   */
  // A seek reads the score: its values at the point. `hands`: the panel's
  // hands to carry over instead (hands()) — a pause's resume goes on as it
  // was, held or let go.
  seek(audioContext, { sec = null, line = null, hands = [] } = {}) {
    if (!this._ir) throw new Error("No IR loaded");
    const keep = hands;
    this.stop();
    // A line names no time until the song is run to it: find that first, and
    // stop just short of its event, so the event itself plays live.
    if (sec == null) {
      const found = this._chase(audioContext, 0, null, line).lineSec;
      sec = found == null ? 0 : Math.max(0, found - 0.005);
    }
    const at = audioContext.currentTime + 0.05;
    const { held } = this._chase(audioContext, at - Math.max(0, sec), at, null);

    // The held writes, in time order, as one burst at the seek point.
    held.sort((a, b) => (a.when ?? -Infinity) - (b.when ?? -Infinity));
    const pcmVoices = this._ir?.metadata?.pcmVoices ?? 0;
    for (const w of held) {
      if (w.when != null && w.when > at) continue; // past the point: the live run writes it
      if (w.msg) {
        // PCM: levels carry over; notes, their loop points and offs do not.
        const k = w.msg.kind;
        if (k === "vol" || k === "vel" || k === "master") this._write({ ...w.msg, when: at });
        continue;
      }
      if (this._fmEnc.isKeyOn(w.port, w.addr, w.data)) continue;
      // A chip's memory (the 2A03's DMC samples): each hit loads its own, and
      // one sounding across the point is stopped — not replayed by the byte.
      if (this._ramPorts.has(w.port)) continue;
      this._write(w.port, w.addr, w.data, at);
    }
    for (let ch = 0; ch < this._fmEnc.channels; ch++) this._fmKey(ch, 0);
    for (let psgCh = 0; psgCh < PSG_LANES; psgCh++) this._psgSetAtt(psgCh, this._psgOff(psgCh), at);
    for (let v = 0; v < pcmVoices; v++) this._pcmEv(at, { kind: "off", voice: v });
    this._silenceChipPcm(at);

    this._audioContext = audioContext;
    // The panel's hands, back over the score's values at the point.
    this._applyHands(keep, at);
    this._runs = (this._runs ?? 0) + 1; // runNumber
    this._onRunStart?.();
    this._scheduleLoop();
    return sec;
  }

  // Run the song from the top against a stand-in clock that starts at
  // `start`, with every write held instead of sent and the UI callbacks
  // silenced, until the clock reaches `until` or an event of source
  // `watchLine` is dispatched. The run's state is left as the chase leaves
  // it; the real write path and callbacks come back. Returns the held writes
  // and, when watching, that event's time from `start` (null if none plays).
  _chase(audioContext, start, until, watchLine) {
    const saved = { write: this._sink, onLine: this._onLine, onSeq: this._onSeq, onTrig: this._onTrig, onHold: this._onHold, onPosition: this._onPosition };
    const held = [];
    this._onLine = this._onSeq = this._onTrig = this._onHold = this._onPosition = null;
    this._sink = (portOrMsg, addr, data, when) => {
      if (portOrMsg && typeof portOrMsg === "object") held.push({ msg: portOrMsg, when: portOrMsg.when });
      else held.push({ port: portOrMsg | 0, addr: addr & 0xff, data: data & 0xff, when });
    };
    const clock = { currentTime: start, state: "running", resume() {} };
    const STEP = 0.01;
    const END = start + 1200; // the longest a capture runs (captureRegisterLog)
    let t = start;
    try {
      this._clearPendingUiTimers();
      this._resetRunState();
      this._pendingSwap = null;
      // The song's own tempo from the top (a run leaves _bpm where its last
      // tempo change put it).
      this._bpm = this._resolveInitialTempo(this._ir);
      this._tempoSweep = null;
      this._audioContext = clock;
      this._playing = true;
      this._startAudioTime = start;
      this._scheduledHorizon = 0; // the queue was flushed
      this._frameOrigin = start;
      this._initDefaultVoices();
      this._resetFm3();
      this._open = [];
      this._tracks = this._flattenTracks();
      for (const tr of this._tracks) {
        tr.audioTimeAtTick0 = start;
        tr.startAudioTime = start;
        tr.loopCount = 0;
        tr.flatIndex = 0;
        this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
      }
      this._chaseWatch = watchLine == null ? null : { line: watchLine, time: null };
      for (;;) {
        const h = until == null ? t + STEP : Math.min(t + STEP, until);
        clock.currentTime = t;
        const done = this._scheduleStep(t, h);
        t = h;
        if (until != null && t >= until) break;
        if (this._chaseWatch?.time != null) break;
        if (done || t >= END) break;
      }
    } finally {
      // What was still ahead of the chase's end is not the live run's to
      // write: the notes it belonged to are let go at the seek point.
      this._dropAhead();
      this._sink = saved.write;
      this._onLine = saved.onLine;
      this._onSeq = saved.onSeq;
      this._onTrig = saved.onTrig;
      this._onHold = saved.onHold;
      this._onPosition = saved.onPosition;
    }
    const watched = this._chaseWatch?.time;
    this._chaseWatch = null;
    return { held, lineSec: watched == null ? null : watched - start };
  }

  /**
   * Every track's clock (trackClock), by track index, at `sec` into the song:
   * a run chased from the top on a stand-in clock, as seek() finds its point.
   * What a visualizer shows for a point the song is not playing at — meant
   * for a probe player, whose run it leaves where the chase stopped.
   * @param {number} sec
   */
  clocksAtSec(sec) {
    if (!this._ir) return [];
    this._chase(null, 0, Math.max(0, sec), null);
    return this._tracks.map((_, i) => this.trackClock(i));
  }

  /** Seconds since the top of the song (seek() included); 0 when stopped. */
  positionSec() {
    if (!this._playing || !this._audioContext) return 0;
    return Math.max(0, this._audioContext.currentTime - this._startAudioTime);
  }

  /**
   * The IR the run plays, as it was given to loadJSON / swapAtNextBar (a
   * score with a def-se plays its song's tracks, the same indices), or null.
   */
  loadedIr() {
    return this._irGiven ?? this._ir ?? null;
  }

  /**
   * The IR the run plays: the song's tracks alone (a def-se's are not), or
   * an effect's own, as the strips, the TIME bar and the piano roll show
   * them; null before a load.
   */
  playedIr() {
    return this._ir ?? null;
  }

  /** Whether the run goes round its loop (setLoop), or stops at the jump. */
  loopEnabled() {
    return !!this._loop;
  }

  /** Counts play() and seek() calls: a run that began again (a seek while playing). */
  runNumber() {
    return this._runs ?? 0;
  }

  /** Whether track `ti` sounds now, as the mixer's mute and solo leave it. */
  isTrackAudible(ti) {
    return this._isTrackAudible(ti);
  }

  /**
   * The AudioContext time a hot-swap waiting for its bar takes over at
   * (swapAtNextBar), or null: what the outgoing tracks play stops there.
   */
  pendingSwapTime() {
    return this._pendingSwap?.boundaryTime ?? null;
  }

  /** How far ahead of the audible position the run queues, in seconds (setLookahead). */
  lookaheadSec() {
    return this._schedulerLookahead;
  }

  /** Toggle looping at any time. */
  setLoop(enabled) {
    this._loop = enabled;
  }

  /**
   * How far ahead of the audible position the run queues events, in seconds.
   * 0.2 s keeps an edit's hot-swap close; a hidden page, whose timers the
   * browser lets fire about once a second, needs several seconds so the
   * queue never runs dry. Takes effect at the next scheduler pass.
   */
  setLookahead(sec) {
    this._schedulerLookahead = Math.max(0.1, Number(sec) || 0.2);
  }

  /**
   * Mute or unmute a sounding channel by track index. Muted tracks suppress
   * NOTE_ON key-on writes.
   * @param {number} ti  track index (== track.id == position in ir.tracks)
   * @param {boolean} muted
   */
  muteTrack(ti, muted) {
    if (muted) this._mutedTracks.add(ti);
    else this._mutedTracks.delete(ti);
    this._applyAudibility();
  }

  /**
   * Solo or unsolo a track. Multiple tracks may be soloed at once; while any
   * track is soloed, only soloed tracks sound.
   * @param {number} ti  track index
   * @param {boolean} on
   */
  soloTrack(ti, on) {
    if (on) this._soloTracks.add(ti);
    else this._soloTracks.delete(ti);
    this._applyAudibility();
  }

  /**
   * Mute, solo or set the mixer level of one of the YM2608's sample voices
   * ("bd" "sd" "top" "hh" "tom" "rim", "adpcm"): the mixer's strip for a
   * rhythm sound is the sound, whichever pc88 track hits it.
   */
  muteVoice(voice, muted) {
    if (muted) this._mutedVoices.add(voice);
    else this._mutedVoices.delete(voice);
    this._applyAudibility();
  }

  soloVoice(voice, on) {
    if (on) this._soloVoices.add(voice);
    else this._soloVoices.delete(voice);
    this._applyAudibility();
  }

  /** Clear all mute and solo state. */
  clearChannelStates() {
    this._mutedTracks.clear();
    this._soloTracks.clear();
    this._mutedVoices.clear();
    this._soloVoices.clear();
    // No note is sounding on a freshly (re)configured player, so a subsequent
    // master/vol preamble must not re-write a non-silent att to any PSG channel.
    this._psgSounding.fill(false);
  }

  /** Whether a track currently sounds (solo overrides mute). */
  _isTrackAudible(ti) {
    if (this._soloTracks.size > 0 || this._soloVoices.size > 0) return this._soloTracks.has(ti);
    return !this._mutedTracks.has(ti);
  }

  /** Whether a chip sample voice (the YM2608's, PCM8's) sounds: its own strip's mute and solo. */
  _isVoiceAudible(voice) {
    if (this._soloTracks.size > 0 || this._soloVoices.size > 0) return this._soloVoices.has(voice);
    return !this._mutedVoices.has(voice);
  }

  /**
   * Whether track `ti` sounds on its sample voice: the voice's strip decides
   * the solo (a soloed voice is not a soloed track), a mute of either holds.
   */
  _isVoiceTrackAudible(ti, voice) {
    return !this._mutedTracks.has(ti) && this._isVoiceAudible(voice);
  }

  /**
   * Immediately silence any channel whose track just became inaudible, so a
   * held/sustained note stops at once instead of only gating the next note-on.
   * Audible channels are left alone and resume at their next note. No-op when
   * not playing (nothing is sounding yet). Each voice as a muted track's
   * note silences it (_silence).
   */
  _applyAudibility() {
    const ctx = this._audioContext;
    if (!ctx) return;
    const when = ctx.currentTime;
    // FM: an inaudible channel — unless another audible track shares it
    // (FM3 operator mode routes several tracks through channel 3's 0x28).
    const audibleFm = new Set();
    for (const [ti, ch] of this._lanesOf("fm")) if (this._isTrackAudible(ti)) audibleFm.add(ch);
    for (const [ti, ch] of this._lanesOf("fm")) if (!this._isTrackAudible(ti) && !audibleFm.has(ch)) this._silence(`fm:${ch}`, when);
    // An FM3 operator track that went silent while channel 3 still sounds
    // for another: its operator alone.
    this._ir?.tracks?.forEach((t, ti) => {
      const op = /^fm3-([1-4])$/.exec(t.scoreChannel ?? "")?.[1];
      if (op && !this._isTrackAudible(ti)) this._silence(`fm3op:${op}`, when);
    });
    for (const [ti, psgCh] of this._lanesOf("psg")) if (!this._isTrackAudible(ti)) this._silence(`psg:${psgCh}`, when);
    for (const [ti, voice] of this._lanesOf("sample", "dac")) if (!this._isTrackAudible(ti)) this._silence(`pcm:${voice}`, when);
    // CSM: Timer A keys CH3, so muting the CSM voice holds the timer instead.
    if (this._reg27 & 0x80) this._writeReg27(when);
    for (const voice of this._chipPcm?.owner.keys() ?? []) if (!this._isVoiceAudible(voice)) this._silence(`voice:${voice}`, when);
    for (const [ti] of this._lanesOf("sample", "fc-dpcm")) if (!this._isVoiceTrackAudible(ti, "dpcm")) this._silence("voice:dpcm", when);
  }

  // A voice silenced now — its track muted or not soloed (_applyAudibility),
  // or a note of such a track (_playNote) — as each chip silences it:
  //   fm      its key off (under CSM Timer A keys CH3: none)
  //   fm3op   its operator's key off, its key-ons waiting dropped; under
  //           CSM its level (TL 127 until its next note)
  //   psg     its attenuation off, the lane no longer keyed
  //   pcm     a Mega Drive PCM voice released (the DAC mix has no key)
  //   voice   a chip's sample voice: a rhythm sound dumped, the ADPCM-B
  //           stopped, a PCM8 voice cut from the mix, a DDA channel off and
  //           fed no more frames, the DMC stopped
  _silence(site, when) {
    this._onVoice(site, "silence", when);
  }

  /** Current tempo in BPM (changes during playback via tempo events / sweeps). */
  getBpm() {
    return this._bpm;
  }

  // The tempo, now: a running sweep ends. While playing, applied at the
  // current position so timing stays continuous; otherwise the base tempo.
  _setTempoNow(bpm) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this._tempoSweep = null;
    if (this._playing && this._tracks.length > 0 && this._audioContext) {
      const now = this._audioContext.currentTime;
      const t0 = this._tracks[0];
      const currentTick = Math.max(
        0,
        (now - t0.audioTimeAtTick0) / this._secsPerTick,
      );
      this._setTempoAtTick(bpm, currentTick, now);
    } else {
      this._bpm = bpm;
    }
  }

  /**
   * Trigger KEY-OFF for a hold note (len=0) on the given channel.
   * @param {string} key  the held channel (_holdKey): "fm:2", "psg:3", "sample:0"
   */
  triggerKeyOff(key) {
    const tIdx = this._open.findIndex((o) => o?.gate.hold && o.key === key);
    if (tIdx < 0) return;
    const when = this._audioContext?.currentTime ?? 0;
    this._resumeHeldTrack(tIdx, when);
    // The hold closes as any open note does, on its voice (_closeNote).
    this._closeNote(tIdx, when, { host: true });
  }


  /**
   * Set operator key-on mask for a channel.
   * @param {number} ch    an FM channel
   * @param {number} mask  0xf0 = all on; bit7=op4, bit6=op3, bit5=op2, bit4=op1
   */
  setOpMask(ch, mask) {
    if (!Number.isInteger(ch) || ch < 0 || ch >= this._fmEnc.channels) {
      throw new Error(`Invalid channel index for setOpMask: ${ch}`);
    }
    const keyMask = Number(mask) & 0xf0;
    if (keyMask === 0) {
      throw new Error(`Invalid op mask for setOpMask: ${mask}`);
    }
    this._opMasks[ch] = keyMask;
  }

  /** Get current op mask for a channel. */
  getOpMask(ch) {
    if (!Number.isInteger(ch) || ch < 0 || ch >= this._fmEnc.channels) {
      throw new Error(`Invalid channel index for getOpMask: ${ch}`);
    }
    return this._opMasks[ch] ?? 0xf0;
  }

  /**
   * Swap the IR gaplessly at the next bar boundary while playback runs.
   *
   * Unlike a flush-and-restart, this leaves all already-scheduled audio intact:
   * the outgoing IR plays out to the next bar boundary, then the incoming IR
   * takes over from that boundary — keeping the global position (Strudel-style).
   * No worklet flush is sent, so there is no dropout or click.
   *
   * The boundary is chosen past the scheduler lookahead, so no outgoing event
   * beyond it has been queued yet; until the boundary, outgoing tracks are
   * capped (see _scheduleCapTime) and the actual swap happens in _commitSwap().
   *
   * If playback is stopped, behaves like loadJSON().
   *
   * @param {object} irObj  Compiled IR object
   */
  swapAtNextBar(irObj) {
    if (!this._playing || this._tracks.length === 0 || !this._audioContext) {
      // Not playing — just load; the next play() picks it up.
      this.loadJSON(irObj);
      return;
    }

    const now = this._audioContext.currentTime;
    const secsPerTick = this._secsPerTick;
    const t0 = this._tracks[0];
    // Local tick within track 0's current (loop-advanced) frame.
    const localTick = Math.max(0, (now - t0.audioTimeAtTick0) / secsPerTick);
    const barTicks = this._ppqn * 4;
    // First bar boundary whose time is safely past what the outgoing tracks
    // have queued — the lookahead, or further when a deeper one (a hidden page)
    // queued ahead and the page has just come back.
    const queued = Math.max(this._schedulerLookahead, this._scheduledHorizon - now);
    const leadTicks = (queued + 0.03) / secsPerTick;
    const boundaryTick =
      Math.ceil((localTick + leadTicks) / barTicks) * barTicks;
    const boundaryTime = t0.audioTimeAtTick0 + boundaryTick * secsPerTick;

    this._pendingSwap = { irObj, boundaryTick, boundaryTime };
    this._scheduleCapTime = boundaryTime;
  }

  // The channels the score's parts take from each other in turn
  // (language.md §16, §19 msx), as the loaded IR has them — at a run's
  // start, and again at a swap. An FM chip whose rhythm shares its channels
  // (the OPLL's): whether the score plays it. A sample part that takes an
  // FM channel while its notes sound (the Mega Drive's PCM, fm6's DAC) in a
  // score that plays that channel too: each PCM note turns the DAC on
  // ($2B), each note of the channel turns it off (_fmKey), at their times —
  // the worklet and the VGM follow the writes. A swap to a score without
  // the PCM turns the DAC off where a PCM note left it on.
  _sharedChannels(when = null) {
    const heads = (this._ir?.tracks ?? []).map((t) => this._target.channels[t.scoreChannel ?? t.channel]);
    this._fmEnc.rhythmTracks?.(heads.some((c) => c?.part.sharesTaken && c.part.kit));
    const dac = this._target.parts.find((p) => p.claims && p.sharesTaken);
    const pcm = !!dac && heads.some((c) => c?.part === dac);
    this._dacClaim = pcm;
    this._dacShareCh = pcm && heads.some((c) => c?.part.kind === dac.claims.kind && c.voice === dac.claims.voice)
      ? dac.claims.voice : null;
    if (when != null && !pcm && this._dacOn) {
      this._dacOn = false;
      this._write(0, 0x2b, 0x00, when);
    }
  }

  // Commit a pending swap: load the incoming IR and anchor its tracks so that
  // tick=boundaryTick lands exactly on boundaryTime, continuing the global
  // position. Called from _scheduleLoop once the boundary is within the horizon.
  // The outgoing score's full-gate notes, whose tracks stop at the swap:
  // each keys off at its own gate's end (the boundary at the earliest),
  // unless an incoming note has taken its channel by then.
  _settlePending(boundary) {
    // The notes still held — a hold, a full gate — take their release.
    for (const o of this._open) if (o) this._letGo(o, boundary);
    this._open.forEach((o, ti) => {
      if (!o || !Number.isFinite(o.at)) return;
      const t = Math.max(boundary, o.at);
      this._at(t + 1e-9, () => { if (this._open[ti] === o) this._closeNote(ti, t); }, KEYED);
    });
  }


  _commitSwap() {
    const { irObj, boundaryTick, boundaryTime } = this._pendingSwap;
    this._pendingSwap = null;
    this._scheduleCapTime = Infinity;

    this._settlePending(boundaryTime);
    // Load new IR (does not touch callbacks, _playing, or _audioContext).
    this.loadJSON(irObj);
    this._sharedChannels(boundaryTime);

    const secsPerTick = this._secsPerTick;
    const newTick0 = boundaryTime - boundaryTick * secsPerTick;
    this._tracks = this._flattenTracks();
    for (const t of this._tracks) {
      t.startAudioTime = newTick0;
      t.audioTimeAtTick0 = newTick0;
      t.loopCount = 0;
      t.flatIndex = 0;
      this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
      // Resume at the boundary tick (loops fast-forward in _scheduleStep).
      while (
        t.flatIndex < t.events.length &&
        t.events[t.flatIndex].tick < boundaryTick
      ) {
        t.flatIndex++;
        this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
      }
    }
    // Suppress any incoming write before the boundary (loop catch-up) so the new
    // IR starts exactly on the boundary, overlapping the outgoing tail cleanly.
    this._dispatchFloor = boundaryTime;
  }

  /**
   * Register a callback fired (approximately) when each event plays.
   * @param {((trackIdx: number, src: { line, column, endLine, endColumn }) => void) | null} fn
   *   src is the 1-based source span of the token that produced the event.
   */
  setOnLine(fn) {
    this._onLine = fn;
  }

  /**
   * Register a callback fired when a step-sequence macro starts/stops sounding.
   * @param {((show: boolean, src: { line, column, endLine, endColumn }) => void) | null} fn
   *   show=true at the sequence's start time, show=false at its end time.
   */
  setOnSeq(fn) {
    this._onSeq = fn;
  }

  /**
   * Release every hold (Tools > Release holds): what the host's KEY_OFF does
   * to each channel holding a `:len 0` / `:gate 0` note.
   */
  releaseHolds() {
    for (const o of this._open.filter((o) => o?.gate.hold)) this.triggerKeyOff(o.key);
  }

  /** The tracks stopped at a `:len 0` note, waiting for their key-off. */
  heldTracks() {
    return this._tracks.map((t, i) => (t.held ? i : -1)).filter((i) => i >= 0);
  }

  // A `:len 0` note stops its track (driver.md §2.4): the key-off starts it
  // again, its next event at the key-off's time — the track's clock moved on
  // by however long it was held. Never earlier than the held note itself,
  // which the lookahead may have scheduled ahead of now.
  _resumeHeldTrack(tIdx, when) {
    const track = this._tracks?.[tIdx];
    const h = track?.held;
    if (!h) return;
    track.held = null;
    const at = Math.max(when + 0.02, h.when);
    const anchor = at - h.tick * this._secsPerTick;
    track.startAudioTime += anchor - track.audioTimeAtTick0;
    track.audioTimeAtTick0 = anchor;
    if (this._playing && this._schedulerTimer === null) this._scheduleLoop();
  }

  /**
   * Register a callback fired when a track stops at a `:len 0` hold, so the
   * UI can say why it went quiet. @param {((trackIdx: number) => void) | null} fn
   */
  setOnHold(fn) {
    this._onHold = fn;
  }

  /**
   * Register a callback told, as a note is scheduled (ahead of its audio
   * time), where its macros and its sample will be — what the panel's
   * editors mark while it plays:
   *   { kind: "macro", src, marks: [[step, time], …], end }  a macro of
   *     source span `src`: each step of the vector the editor shows (a
   *     curve's steps at its :step, a stage vector's run end to end), from
   *     its time on, until `end`
   *   { kind: "sample", name, when, mode, off, cut }  a def-pcm keyed at
   *     `when` (heard time runs through its points from :pcm-start), let go
   *     at `off` (Infinity: never), stopped by the next note at `cut`
   * Times are the audio context's. @param {((record: object) => void) | null} fn
   */
  setOnPosition(fn) {
    this._onPosition = fn;
  }

  /**
   * Register a callback fired when a `(trig N)` cue (IR TRIG) plays — the
   * moment a game polling the track's status byte would see it change.
   * @param {((trackIdx: number, code: number) => void) | null} fn
   */
  setOnTrig(fn) {
    this._onTrig = fn;
  }

  /**
   * Register a callback fired by play() once the run state is reset and before
   * the first event is scheduled: where the UI's mute and solo go back on
   * (the reset clears them, and the panel's hands: a run starts with the
   * score's own levels).
   * @param {(() => void) | null} fn
   */
  setOnRunStart(fn) {
    this._onRunStart = fn;
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

  // A track's route: the target's channel table (targets/) gives its part
  // and the voice index in it; the part's kind, the core that plays it
  // (CORE_OF_KIND). A sample track owns no FM channel — on the Mega Drive its
  // voice is summed to fm6's DAC, which mutes fm6 only while the DAC is on —
  // so it never reaches the FM key-off path. A PSG core track's lane is its
  // tone lane (targets.js toneLaneOf).
  _assignChannel(trackIndex, track) {
    const c = this._target.channels[track?.channel];
    if (!c) {
      // A track with no channel name: an FM channel by its index, capped.
      this._routes.set(trackIndex, { core: "fm", part: null, lane: Math.min(trackIndex, this._fmEnc.channels - 1) });
      return;
    }
    const core = CORE_OF_KIND[c.part.kind];
    if (!core) throw new Error(`the IR player cannot play ${track.channel} yet (${c.part.label})`);
    if (core === "sample" && !SAMPLE_HANDLERS[c.part.name])
      throw new Error(`the IR player cannot play ${track.channel} yet (${c.part.label})`);
    const lane = core === "psg" ? toneLaneOf(c) : c.voice;
    this._routes.set(trackIndex, { core, part: c.part, lane });
  }

  // [trackIndex, lane] of every track the `core` plays (a sample core's: of
  // the part named `partName` alone, when given).
  *_lanesOf(core, partName = null) {
    for (const [ti, r] of this._routes)
      if (r.core === core && (!partName || r.part?.name === partName)) yield [ti, r.lane];
  }

  // The key a held note's channel is let go by (triggerKeyOff).
  _holdKey(ev) {
    const r = ev._route;
    return `${r.core}:${r.lane}`;
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
    if (horizon > this._scheduledHorizon) this._scheduledHorizon = horizon;

    // Commit a pending gapless swap once the scheduler reaches the boundary.
    // All outgoing events before the boundary are already queued in the worklet
    // (and capped from going past it), so the incoming IR can take over with no
    // flush and no gap.
    if (this._pendingSwap && horizon >= this._pendingSwap.boundaryTime) {
      // Schedule the outgoing tracks right up to the boundary first (capped at
      // it), so no tail events are dropped, then hand over to the incoming IR.
      this._scheduleStep(now, this._pendingSwap.boundaryTime);
      this._commitSwap();
    }

    this._allScheduled = !!this._scheduleStep(now, horizon);
    if (this._allScheduled) return;

    this._schedulerTimer = setTimeout(
      () => this._scheduleLoop(),
      this._schedulerInterval,
    );
  }

  // Schedule every track's events up to `horizon`, dispatching register writes
  // and handling per-track loop restarts. Returns true when playback is
  // complete (no track will loop further and all events are exhausted). The
  // scheduling decisions depend only on `now`/`horizon`, so an offline capture
  // (captureRegisterLog) can drive this with a manually advanced clock instead
  // of the real audio timer.
  _scheduleStep(now, horizon) {
    const done = this._scheduleEvents(now, horizon);
    // What every call up to a time is known by (_settled): the encoders and
    // models that order a chip's writes by their time write up to it.
    const settled = this._settled(horizon);
    // The SSG's mixer changes, in time order (chips/ssg.js).
    this._flushEncoders(done ? Infinity : settled);
    // Every hit up to there is known now: the chip's sample voices' levels
    // can be written up to it — and once the song is done, on to the end of
    // what still sounds.
    // A rhythm whose registers hold several sounds (the OPLL's) writes its
    // queue up to there, in time order (chips/ym2413.js).
    if (this._chipPcm)
      for (const [p, a, d, t] of this._rhythmEnc?.flush?.(done ? Infinity : settled) ?? []) this._write(p, a, d, t);
    return done;
  }

  _scheduleEvents(now, horizon) {
    // Once the boundary has passed, the post-swap dispatch floor is moot.
    if (this._dispatchFloor !== -Infinity && now >= this._dispatchFloor) {
      this._dispatchFloor = -Infinity;
    }

    // Tempo changes land inside the window — a sweep's frame steps, a track's
    // TEMPO_SET/SWEEP: schedule up to each one, apply it, and go on, so every
    // event (and every length measured from it) is placed under the tempo of
    // its own time, whichever track the change is on.
    for (let guard = 0; guard < 100000; guard++) {
      const step = this._tempoSweep?.steps[0]?.when ?? Infinity;
      const next = Math.min(step, this._nextTempoEventTime());
      const cut = next < horizon ? next : horizon;
      this._scheduleTracks(now, cut);
      if (cut === horizon) break;
      this._applyTempoSteps(cut);
    }

    // Playback is complete when no track will loop further and all are exhausted.
    const willLoopAny = this._loop && this._tracks.some((t) => t.hasLoop);
    const dispatched =
      !willLoopAny &&
      this._tracks.every((t) => this._trackDone(t));
    // ...and the work of the frames before the horizon's own (its events may
    // not all be dispatched yet; with none left to dispatch, its own too).
    this._advance(this._eventFrame(horizon) + (dispatched ? 1 : 0), horizon);
    const done = dispatched && !this._workLeft() && this._aheadHead >= this._ahead.length;
    if (done) this._writeCursor = Infinity; // the run is over: what follows (a key, the panel) is written at once
    // Every event up to the horizon is dispatched, so the frames before the
    // horizon's own have all their FM3 key edges.
    return done;
  }

  // A track with nothing left to dispatch — or held at its last note, its
  // end (TRACK_END) waiting with nothing to resolve: a hold keys off at its
  // release.
  _trackDone(t) {
    return t.flatIndex >= t.events.length
      || (!!t.held && t.flatIndex === t.events.length - 1 && t.events[t.flatIndex].cmd === "TRACK_END");
  }

  // Dispatch every track's events up to `horizon` in time order across the
  // tracks (ties by track order). A track at a time is not enough: an event
  // with a global effect — a :master sweep, a tempo change — must find the
  // other tracks' earlier events already dispatched and their later ones not.
  _scheduleTracks(now, horizon) {
    const restarts = new Array(this._tracks.length).fill(0);
    // A track's next event time, restarting its loop when it runs out (at
    // most 16 laps a call, for a zero-length loop); Infinity when it is done
    // or held at the swap boundary.
    const nextTime = (track, tIdx) => {
      if (track.held) return Infinity;
      for (;;) {
        if (track.flatIndex < track.events.length) {
          const ev = track.events[track.flatIndex];
          // Read secsPerTick live: a TEMPO_SET dispatched earlier in this very
          // pass re-anchors audioTimeAtTick0 for the NEW tempo.
          const evTime = track.audioTimeAtTick0 + ev.tick * this._secsPerTick;
          // Pending swap: stop the outgoing tracks at the swap boundary so they
          // never emit past it (the incoming IR takes over there).
          return evTime >= this._scheduleCapTime ? Infinity : evTime;
        }
        // Per-track independent loop restart (only if source defines a loop)
        if (
          this._loop &&
          track.hasLoop &&
          track.events.length > 0 &&
          restarts[tIdx]++ < 16
        ) {
          track.loopCount++;
          track.audioTimeAtTick0 =
            track.startAudioTime +
            track.loopCount * track.loopDuration * this._secsPerTick;
          track.flatIndex = track.loopStartIndex ?? 0;
          this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
          continue;
        }
        return Infinity;
      }
    };
    for (;;) {
      let tIdx = -1;
      let evTime = Infinity;
      for (let i = 0; i < this._tracks.length; i++) {
        const t = nextTime(this._tracks[i], i);
        if (t < evTime) {
          evTime = t;
          tIdx = i;
        }
      }
      if (tIdx < 0 || evTime > horizon) break;
      const track = this._tracks[tIdx];
      const ev = track.events[track.flatIndex];
      // When each pass of a loop starts (captureRegisterLog's loop region).
      if (track.hasLoop && track.flatIndex === track.loopStartIndex) (track.passStarts ??= [])[track.loopCount] = evTime;
      // After a swap commit, _dispatchFloor suppresses the incoming IR's
      // loop catch-up so nothing is written before the boundary; advance
      // past those events without dispatching.
      if (evTime >= this._dispatchFloor) {
        // seek() to a line: note when the line first plays (see _chase) — a
        // label's line (#top) counts, so it plays from the label.
        const w = this._chaseWatch;
        if (w && w.time == null && ev.src?.line === w.line) w.time = evTime;
        // On a frame-clocked target an event happens on the frame its time
        // falls in, so a note's key-on and its macros' steps count from one
        // frame (_frameTime).
        const when = this._target.frameClock ? this._frameStart(evTime) : evTime;
        // The work of the frames before this event's runs first.
        const F = this._eventFrame(when);
        this._advance(F, when);
        this._lastEvent = { F, t: when };
        const isNote = ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON";
        if (isNote) this._noteScope = { ti: tIdx, note: (this._noteOf[tIdx] = {}) };
        try {
          this._dispatchEvent(ev, when);
        } finally {
          this._noteScope = null;
        }
        // `:len 0`: the track waits here for its key-off (_resumeHeldTrack).
        if ((ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") && ev.args?.length === 0) {
          track.held = { tick: ev.tick, when: evTime };
          if (this._onHold) {
            const delay = Math.max(0, evTime - now) * 1000;
            this._scheduleUiCallback(() => this._onHold(tIdx), delay);
          }
        }
        if (this._onTrig && ev.cmd === "TRIG") {
          const code = ev.args?.code;
          const delay = Math.max(0, evTime - now) * 1000;
          this._scheduleUiCallback(() => this._onTrig(tIdx, code), delay);
        }
        if (
          this._onLine &&
          ev.src?.line != null &&
          !PLAYHEAD_SKIP_CMDS.has(ev.cmd)
        ) {
          const src = ev.src;
          const delay = Math.max(0, evTime - now) * 1000;
          this._scheduleUiCallback(() => this._onLine(tIdx, src), delay);
        }
      }
      track.flatIndex++;
      this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
    }
  }

  /**
   * Render the loaded IR to a flat, time-ordered register-write log without
   * touching real audio. Drives the same scheduling logic as play() but with a
   * manually advanced clock and a capturing write callback, so the result is a
   * deterministic transcript of every YM2612/PSG write — the basis for VGM
   * export.
   *
   * Tracks loop independently (each `(go …)` returns that track to its own
   * label), and a track may have an intro before its label — so loop-start
   * ticks differ per track. The single VGM loop point must be where *every*
   * track has entered its repeating body, i.e. the LATEST loop-start tick among
   * looping tracks; anything earlier would replay another track's intro on each
   * pass. The loop length is the LCM of the per-track loop durations. To fill
   * that window for every track (a track with an earlier/shorter body must keep
   * repeating through it), capture runs with looping ENABLED and stops once the
   * clock passes the loop end. `loopStartSec`/`endSec` bound the region the VGM
   * player repeats; the intro before `loopStartSec` plays once.
   *
   * Object-form (DAC/PCM) writes are counted in `pcmCount` but not recorded —
   * VGM export covers FM + PSG only for now.
   *
   * @returns {{ writes: Array<{sec:number,port:number,addr:number,data:number}>,
   *             pcmCount: number, loopStartSec: number|null, endSec: number }}
   */
  captureRegisterLog({ stepSec = 0.01, maxSec = 1200 } = {}) {
    if (!this._ir) throw new Error("No IR loaded");

    // A non-zero base time so that init writes (emitted with when=undefined)
    // map cleanly to sec 0 ahead of the first scheduled event.
    const BASE = 1.0;

    const writes = [];
    let pcmCount = 0;
    // The PCM events the worklet would get (pcm-ev), for drv/tools/pcm-ab-gate.mjs,
    // and the X68000's PCM8 events, which the VGM and the WAV mix (chips/msm6258.js).
    const pcmEvents = [];
    const pcm8Events = [];

    const saved = {
      write: this._sink,
      onLine: this._onLine,
      onSeq: this._onSeq,
      onTrig: this._onTrig,
      onHold: this._onHold,
      onPosition: this._onPosition,
      ctx: this._audioContext,
      loop: this._loop,
      playing: this._playing,
      bpm: this._bpm,
      tempoSweep: this._tempoSweep,
    };

    // Silence every UI callback so no real setTimeout fires during capture.
    this._onLine = null;
    this._onSeq = null;
    this._onTrig = null;
    this._onHold = null;
    this._onPosition = null;

    this._sink = (portOrMsg, addr, data, when) => {
      if (portOrMsg && typeof portOrMsg === "object" && !Array.isArray(portOrMsg)) {
        pcmCount++; // DAC/PCM event — not encoded into VGM yet
        if (portOrMsg.type === "pcm-ev")
          pcmEvents.push({ ...portOrMsg, sec: (portOrMsg.when == null ? BASE : portOrMsg.when) - BASE });
        if (portOrMsg.type === "pcm8") {
          pcmCount--; // the VGM carries it
          pcm8Events.push({ ...portOrMsg, sec: (portOrMsg.when == null ? BASE : portOrMsg.when) - BASE });
        }
        return;
      }
      const sec = (when == null ? BASE : when) - BASE;
      writes.push({
        sec,
        port: portOrMsg | 0,
        addr: addr & 0xff,
        data: data & 0xff,
      });
    };

    let loopStartSec = null;
    let endSec = 0;

    try {
      this._audioContext = { currentTime: BASE, state: "running", resume() {} };
      this._frameOrigin = BASE;
      this._resetRunState();
      this._playing = true;
      this._bpm = this._resolveInitialTempo(this._ir);
      this._tempoSweep = null;

      this._initDefaultVoices(); // preamble register writes (when=undefined → sec 0)

      this._resetFm3();
      this._open = [];
      this._songEndAt = null;
      this._tracks = this._flattenTracks();
      // Every track starts at BASE, as the driver's start their first frame
      // (driver.md §4.2). The preamble above writes at BASE too and was pushed
      // first; the sort below is stable, so each track's head still follows the
      // neutral patch it overrides.
      for (const t of this._tracks) {
        t.audioTimeAtTick0 = BASE;
        t.startAudioTime = BASE;
        t.loopCount = 0;
        t.flatIndex = 0;
        t.passStarts = null;
        this._schedGen++; // the tempo changes ahead move (_tempoChangesAhead)
      }

      const looping = this._tracks.filter((t) => t.hasLoop);
      this._loop = looping.length > 0;

      // Global loop point = the latest per-track loop start (every looping
      // track is in its body by then), or later, the end of the last one-shot
      // track: a part that plays once must be over, or its tail would be in
      // the first pass and not the next. `refTrack` owns the loop-start tick,
      // so its live tick→time mapping gives an exact time even under a tempo
      // set before the loop; a one-shot track's end is read off its own
      // mapping when it runs out. From any point past both, the song repeats
      // every LCM of the per-track loop durations.
      let refTrack = null;
      let loopPeriodTicks = 1;
      for (const t of looping) {
        if (refTrack === null || t.loopStartTick > refTrack.loopStartTick) {
          refTrack = t;
        }
        loopPeriodTicks = lcm(loopPeriodTicks, t.loopDuration);
      }
      const oneShot = this._tracks.filter((t) => !t.hasLoop);
      const endTickOf = (t) => t.events.reduce((m, e) => Math.max(m, e.tick + (e.args?.length ?? 0)), 0);
      let oneShotEndSec = null; // known once every one-shot track has run out
      let refPeriod = null; // measuring the loop's length (below)

      // Drive a fake clock forward. One-shot pieces stop when fully scheduled;
      // looping pieces never report "done", so we stop once the clock has
      // passed the loop end (endSec, known once the loop start is reached).
      let elapsed = 0;
      let done = false;
      while (elapsed <= maxSec) {
        const now = BASE + elapsed;
        this._audioContext.currentTime = now;
        done = this._scheduleStep(now, now + this._schedulerLookahead);

        // Capture the loop region the moment refTrack reaches its loop start,
        // so secsPerTick reflects the tempo active there. refTrack has not
        // looped yet at this point (its jump is later), so audioTimeAtTick0 is
        // still its iteration-1 base.
        if (
          oneShotEndSec === null &&
          oneShot.every((t) => this._trackDone(t))
        ) {
          oneShotEndSec = oneShot.reduce(
            (m, t) => Math.max(m, t.audioTimeAtTick0 + endTickOf(t) * this._secsPerTick - BASE),
            0,
          );
        }
        // refTrack's passes start where the scheduler dispatched them
        // (passStarts): a tempo change re-anchors a track, so its tick 0
        // and the current tempo no longer give an earlier tick's time.
        const passes = refTrack?.passStarts;
        if (loopStartSec === null && passes?.[0] != null && oneShotEndSec !== null) {
          loopStartSec = Math.max(passes[0] - BASE, oneShotEndSec);
          // The period's length is measured, not read off one tempo: the
          // tempo may move inside the loop. It is the time refTrack takes
          // for the passes making up the LCM — the ones captured, which the
          // VGM repeats. An LCM past maxSec keeps the one-tempo reading.
          refPeriod = loopPeriodTicks / refTrack.loopDuration;
          endSec = loopStartSec + loopPeriodTicks * this._secsPerTick;
        }
        if (refPeriod && passes[refPeriod] != null) {
          // Where it is the one-tempo reading but for rounding, that stands:
          // a write on the boundary is the next pass's.
          const measured = loopStartSec + passes[refPeriod] - passes[0];
          if (Math.abs(measured - endSec) > 1e-9) endSec = measured;
          refPeriod = null;
        }

        if (this._loop) {
          // Keep going until we have captured one full loop body past its end.
          if (loopStartSec !== null && !refPeriod && now - BASE >= endSec) break;
        } else if (done) {
          break;
        }

        elapsed += stepSec;
      }
      this._advance(Infinity, Infinity);
    } finally {
      this._sink = saved.write;
      this._onLine = saved.onLine;
      this._onSeq = saved.onSeq;
      this._onTrig = saved.onTrig;
      this._onHold = saved.onHold;
      this._onPosition = saved.onPosition;
      this._audioContext = saved.ctx;
      this._loop = saved.loop;
      // The capture's run is over: nothing of it waits, and a write is made at once again.
      this._dropAhead();
      this._writeCursor = Infinity;
      this._playing = saved.playing;
      this._bpm = saved.bpm;
      this._tempoSweep = saved.tempoSweep;
    }

    writes.sort((a, b) => a.sec - b.sec);

    if (loopStartSec === null) {
      // One-shot: end just after the last write so final releases ring out
      // — and not before the song's end, whichever of its tracks sound.
      const songEnd = this._songEndAt != null ? this._songEndAt - BASE : 0;
      endSec = Math.max(writes.length ? writes[writes.length - 1].sec : 0, songEnd) + 0.05;
    } else {
      // Looping: keep only [0, endSec). The clock ran slightly past the loop
      // end to fully populate the window; those overflow writes belong to the
      // next iteration and are dropped (the VGM player replays them via loop).
      const kept = writes.filter((w) => w.sec < endSec);
      const pcm8 = pcm8Events.filter((e) => e.sec < endSec);
      return { writes: kept, pcmCount, pcmEvents, ...(pcm8.length ? { pcm8Events: pcm8 } : {}), loopStartSec, endSec };
    }

    return { writes, pcmCount, pcmEvents, ...(pcm8Events.length ? { pcm8Events } : {}), loopStartSec, endSec };
  }

  _flattenTracks() {
    if (!this._ir?.tracks) return [];

    return this._ir.tracks.map((track, ti) => {
      const route = this._routes.get(ti);
      // fm3-1..4: the FM3 operator this track drives (0 = not an operator
      // track). Its :pitch, glide and pitch macros bend that operator alone.
      const fm3Op = Number(/^fm3-([1-4])$/.exec(track.scoreChannel ?? "")?.[1] ?? 0);
      // Every event carries its track's route, and its lane as _chIndex (the
      // FM channel; a sample voice, which the worklet keys loop-voice
      // replacement on) or _psgCh.
      const isPsg = route.core === "psg";
      const flatEvs = this._expandLoops(track.events ?? []);
      const events = flatEvs
        .map((ev) => ({
          ...ev,
          _route: route,
          _chIndex: isPsg ? 0 : route.lane,
          _trackIndex: ti,
          _psgCh: isPsg ? route.lane : null,
        }))
        .sort((a, b) => a.tick - b.tick);
      // Where the track's time is not a note's, a rest's or a tie's (a
      // layered `:prio` track's gaps), a rest — as the driver's stream has
      // one there (export-mmb.js syncClock) — and the track's end, where a
      // full gate's key-off is resolved if it does not loop (END_OF_TRACK).
      const own = { _route: route, _chIndex: isPsg ? 0 : route.lane, _trackIndex: ti, _psgCh: isPsg ? route.lane : null };
      let clock = 0;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.tick > clock) {
          events.splice(i++, 0, { tick: clock, cmd: "REST", args: { length: e.tick - clock }, ...own });
          clock = e.tick;
        }
        if (TIMED_CMDS.has(e.cmd)) clock = Math.max(clock, e.tick + (e.args?.length ?? 0));
      }
      if (events.length) events.push({ tick: clock, cmd: "TRACK_END", ...own });

      // For looped playback, restart from the last backward JUMP target marker
      // (a backward jump is one whose target marker tick < the JUMP tick).
      // Forward jumps (a `(go …)` to a later label) are ignored for loop detection.
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
      // Multiple backward JUMPs can exist (two `(go …)` to different labels);
      // the one that jumps furthest back defines the structural loop boundary.
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

      // Truncate events after the backward JUMP so sections past it (reached
      // only by a jump to their label) are not played in normal linear flow.
      const trimmedEvents =
        jumpTick >= 0 ? events.filter((ev) => ev.tick <= jumpTick) : events;

      // The loop resumes AT the label: what is written before it on the same
      // tick — a leading :tempo, :lfo-rate, voice or level — ran once and is
      // not replayed, as the driver resumes at the label's stream offset
      // (export-mmb MARKER). Without a label (no backward jump) nothing loops.
      let loopStartIndex = 0;
      for (let i = 0; i < trimmedEvents.length; i++) {
        const e = trimmedEvents[i];
        if (e.tick > loopStartTick || (e.cmd === "MARKER" && e.args?.id === jumpTarget)) {
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

      return {
        events: trimmedEvents,
        // Where the track's last note or rest runs out.
        endTick: trimmedEvents.reduce((m, e) => Math.max(m, e.tick + (Number(e.args?.length) || 0)), 0),
        // Where its tempo changes sit, for lengths spanning one (_timeAfterTicks).
        tempoIdx: trimmedEvents.flatMap((e, i) => (e.cmd === "TEMPO_SET" && e.tick > 0 ? [i] : [])),
        tempoCut: trimmedEvents.flatMap((e, i) =>
          (e.cmd === "TEMPO_SET" || e.cmd === "TEMPO_SWEEP") && e.tick > 0 ? [i] : []),
        loopDuration,
        loopStartTick,
        loopStartIndex,
        hasLoop: jumpTick >= 0,
        flatIndex: 0,
        audioTimeAtTick0: 0,
        loopCount: 0,
        startAudioTime: 0,
        route,
        fm3Op,
      };
    });
  }

  _setTempoAtTick(bpm, changeTick, changeWhen) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    if (this._tracks.length === 0) {
      this._bpm = bpm;
      return;
    }

    const oldSecsPerTick = this._secsPerTick;
    const t0 = this._tracks[0];
    const audioTimeOfChange =
      changeWhen ?? t0.audioTimeAtTick0 + changeTick * oldSecsPerTick;

    this._bpm = bpm;
    const newSecsPerTick = this._secsPerTick;

    for (const track of this._tracks) {
      // Re-anchor each track on its *own* clock. Tracks stop sharing an anchor as
      // soon as they loop (loops may differ in length), so pinning them all to
      // track 0's tick would fling the rest off their timeline.
      const localTick = Math.max(
        0,
        (audioTimeOfChange - track.audioTimeAtTick0) / oldSecsPerTick,
      );
      track.audioTimeAtTick0 = audioTimeOfChange - localTick * newSecsPerTick;
      // startAudioTime is the *iteration-0* anchor: the loop restart recomputes
      // audioTimeAtTick0 as startAudioTime + loopCount·loopDuration·secsPerTick.
      // Writing the current anchor into it while loopCount stays put would add
      // the iterations already played a second time on the next restart, firing
      // the track's events a few loops into the future — i.e. silence.
      track.startAudioTime =
        track.audioTimeAtTick0 -
        (track.loopCount ?? 0) * (track.loopDuration ?? 0) * newSecsPerTick;
    }
  }

  // A tempo sweep steps the way the driver's does: the score's tempos as
  // tick increments, the length as frames at the average tempo (export-mmb),
  // one integer increment a frame — the sweep's k-th value is the tempo of the
  // (k+1)-th frame after the one it dispatched in. The steps are laid out here
  // and _scheduleStep applies each at its frame before scheduling past it.
  _startTempoSweep(args, changeTick, changeWhen) {
    const from = Number.isFinite(Number(args?.from)) ? Number(args.from) : this._bpm;
    const to = Number.isFinite(Number(args?.to)) ? Number(args.to) : from;
    if (!(from > 0) || !(to > 0)) return;
    const f = bpmToTickIncrement(from), t = bpmToTickIncrement(to);
    const len = Math.max(1, Math.min(0xffff, Math.max(1, Math.round(
      (Number(args?.len ?? 1) * 60 * 60) / (Math.max(1, (from + to) / 2) * this._ppqn)))));
    const id = curveId(args?.curve ?? "linear");
    const f0 = this._eventFrame(changeWhen);
    const steps = [];
    for (let k = 0; k < len; k++)
      steps.push({
        when: this._frameOrigin + (f0 + 1 + k) / 60,
        bpm: tickIncrementToBpm(sweepFrameValue(id, f, t, len, false, k)),
      });
    this._tempoSweep = { steps };
  }

  // The time of the next TEMPO_SET / TEMPO_SWEEP any track will dispatch.
  _nextTempoEventTime() {
    let best = Infinity;
    for (const track of this._tracks) {
      if (track.held) continue;
      for (const i of track.tempoCut ?? []) {
        if (i < track.flatIndex) continue;
        best = Math.min(best, track.audioTimeAtTick0 + track.events[i].tick * this._secsPerTick);
        break;
      }
    }
    return best;
  }

  // Apply the tempo sweep's steps due by `until`: each re-anchors the tracks
  // at its own time.
  _applyTempoSteps(until) {
    const sw = this._tempoSweep;
    while (sw?.steps.length && sw.steps[0].when <= until) {
      const st = sw.steps.shift();
      if (st.bpm !== this._bpm) this._setTempoAtTick(st.bpm, null, st.when);
    }
    if (sw && !sw.steps.length) this._tempoSweep = null;
  }

  _setCsmRateHz(hz, when) {
    this._fmWrites(this._fmEnc.timerA(this._fmEnc.timerAOf(hz)), when);
  }

  // In CSM, Timer A keys CH3: its overflow forces a key-on for one sample and
  // falls back to $28. A note that held CH3 on through $28 would leave the
  // operators no edge to see and lose every retrigger, so while CSM is on a
  // note keys nothing on CH3 — on or off. The driver's key_on returns early
  // there and never marks the channel keyed, so it writes neither.
  _csmKeysCh3(ch) {
    return ch === 2 && (this._reg27 & 0x80) !== 0;
  }

  _setReg27State({ csmEnabled, fm3SpecialMode }, when) {
    let next = this._reg27;
    if (csmEnabled !== undefined) {
      next = csmEnabled ? next | 0x80 : next & ~0x80;
    }
    if (fm3SpecialMode !== undefined) {
      next = fm3SpecialMode ? next | 0x40 : next & ~0x40;
    }
    // Timer A runs exactly while CSM is on: LOAD A (bit 0) makes the counter
    // count, and the CSM key-on is its overflow (the driver's set_reg27) —
    // unless a rate rest holds it stopped; leaving CSM ends the hold.
    if (!(next & 0x80)) this._csmHold = false;
    next = (next & ~0x01) | (next & 0x80 && !this._csmHold ? 0x01 : 0);
    if (next === this._reg27) return;
    // Leaving CSM with the operators as tracks silences them: their key was
    // their level, and no key-off reaches an operator Timer A keyed — with a
    // slow RR it would ring on at its last level (driver.md §9).
    if (this._reg27 & 0x80 && !(next & 0x80) && this._fm3Ops) {
      for (let op = 0; op < 4; op++) {
        this._fm3Op[op].csmOff = Math.min(this._fm3Op[op].csmOff ?? Infinity, when);
        this._fmWrites(this._fmEnc.ch3Tl(op, 127), when);
      }
    }
    this._reg27 = next;
    this._writeReg27(when);
  }

  // The $27 the chip gets: the score's value, except that a muted CSM voice
  // holds Timer A (LOAD A clear). A key-off cannot silence a channel the timer
  // keys, and mute is the preview's own mixer — the driver has none.
  _writeReg27(when) {
    const muted = (this._reg27 & 0x80) !== 0 && this._csmTrack >= 0
      && !this._isTrackAudible(this._csmTrack);
    this._fmWrites(this._fmEnc.mode(muted ? this._reg27 & ~0x01 : this._reg27), when);
  }

  // An FM3 operator's TL in special mode: its OWN vel and vol, the shared
  // CH3's vol (the group fader the note-less `(fm3 …)` track writes) and the
  // global master, on the one dB ladder. Whether the operator is a carrier
  // under the current algorithm is not consulted: on alg 7 — four independent
  // voices, the reason the mode exists — this is its volume, and on a
  // modulator it is its modulation depth, which is a level too (§13.4).
  // The operator's level as it is: its note's :vel / :vol macro where one
  // has stepped, else its velocity and fader (_lv).
  _fm3OpTl(op, when) {
    const st = this._fm3Op[op - 1];
    // CSM (driver.md §9): Timer A keys CH3, so an operator's key is its level —
    // outside its note it is held at TL 127, whatever else recomposes it.
    if (this._reg27 & 0x80 && when !== undefined && st.csmOn !== undefined
      && (when < st.csmOn - 1e-6 || when >= st.csmOff - 1e-6)) return 127;
    const regs = this._chRegs[2];
    const L = this._lv(`fm3op:${op}`);
    return levelSteps(this._fmLevel, {
      base: regs.ops[op - 1].voicedTl ?? 0, vel: this._lvVel(L), k: velK(regs.ops[op - 1].velK, true),
      faders: [this._lvVol(L), this._lvVol(this._lv("fm:2")), this._handMaster() ?? this._masterVol ?? VOL_UNITY],
    });
  }
  _writeFm3OpTl(op, when) {
    const o = this._chRegs[2].ops[op - 1];
    o.tl = this._fm3OpTl(op, when);
    // Under CSM an operator's level is its key, and a rest on the rate track
    // dispatched after this note silences it through the rest (driver.md §9):
    // the write waits for its frame's dispatch (FM3_TL), where a rest
    // spanning it turns it into 127.
    if (this._reg27 & 0x80 && this._fm3Ops && when !== undefined) {
      const tl = o.tl;
      this._step(this._eventFrame(when), FM3_TL, when, () =>
        this._fmWrites(this._fmEnc.ch3Tl(op - 1, this._inCsmHold(when) ? 127 : tl), when), [Math.round(when * 1e6)]);
      return;
    }
    this._fmWrites(this._fmEnc.ch3Tl(op - 1, o.tl), when);
  }
  _inCsmHold(t) {
    return this._csmHoldSpans.some(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);
  }

  // A channel's levels at `when`, from the LIVE vel / vol (its note's level
  // macros, else the note's velocity and the fader or its sweep) and master:
  // its carriers, and a modulator its voice makes velocity-sensitive (`:vel2`).
  // The one place a normal channel's level is composed (§7), from its level
  // as it is (_lv).
  _writeFmLevel(ch, when) {
    const regs = this._chRegs[ch];
    const L = this._lv(`fm:${ch}`);
    const vel = this._lvVel(L), vol = this._lvVol(L);
    const master = this._handMaster() ?? this._masterVol ?? VOL_UNITY;
    const carriers = this._carrierOps(regs);
    for (let opIdx = 0; opIdx < 4; opIdx++) {
      const carrier = carriers.includes(opIdx);
      if (!carrier && !velK(regs.ops[opIdx].velK, false)) continue;
      const tl = this._carrierTl(regs.ops[opIdx], vel, vol, master, carrier);
      regs.ops[opIdx].tl = tl;
      this._fmOp(ch, opIdx, "tl", when);
    }
  }
  _recomposeFm3Ops(when) {
    for (let op = 1; op <= 4; op++) this._writeFm3OpTl(op, when);
  }

  // An operator's $40 value under the channel's CURRENT level rule (§7). A :tl
  // is a VOICED level, not a register value — what reaches the chip is that
  // level plus vel/vol/master — so a mid-song :tl composes here, or it silently
  // discards the level the channel is playing at until the next note-on
  // recomposes it. On a sustaining note there is no next note-on, so it never
  // comes back. CH3's operators in special mode each carry their own level; a
  // normal channel composes its carriers and leaves its modulators raw, where
  // the level is modulation depth, not volume.
  _opLevel(ch, opIdx, when) {
    if (ch === 2 && this._fm3Ops) return this._fm3OpTl(opIdx + 1, when);
    const regs = this._chRegs[ch];
    const op = regs.ops[opIdx];
    const carrier = this._carrierOps(regs).includes(opIdx);
    if (!carrier && !velK(op.velK, false)) return op.voicedTl ?? 0;
    return this._carrierTl(
      op,
      this._lvVel(this._lv(`fm:${ch}`)),
      this._lvVol(this._lv(`fm:${ch}`)),
      this._handMaster() ?? this._masterVol ?? VOL_UNITY,
      carrier,
    );
  }

  // The cent offset a note of `ev`'s track starts with: where a pitch sweep
  // running in its slot is about to step to — the driver's onset_pitch, so a
  // glide's note starts on the glide's first value — else the standing
  // offset `fallback`.
  _onsetPitchOffset(ev, fallback) {
    const sw = this._slots.get(this._slotKey(ev, "NOTE_PITCH"));
    return sw ? Math.round(this._sweepAt(sw, sw.next)) : fallback;
  }

  // Every pitch write passes its whole-semitone note through the channel's
  // `:snap` mask first; the cents ride on the snapped note (driver.md §8). An
  // FM3 operator's note snaps on CH3's mask.
  _writeFm3OpPitch(op, note, cents, when) {
    this._fmWrites(this._fmEnc.ch3OpPitch(op, snapNote(note, this._chRegs[2]?.snap ?? 0) + cents / 100), when);
  }

  // A channel's pitch. In CSM (driver.md §9) CH3's operators 1-3 read their
  // own F-numbers ($A8-$AE) and only op4 the channel's, so the note that sets
  // the channel's pitch sets all four — each operator rings at the note times
  // its own multiple, the formant the voice defines. The driver's
  // write_fm_pitch does the same.
  _writeFmNote(ch, note, cents, when) {
    const midi = snapNote(note, this._chRegs[ch]?.snap ?? 0) + cents / 100;
    if (ch === 2 && this._reg27 & 0x80) {
      for (let op = 1; op <= 4; op++) this._fmWrites(this._fmEnc.ch3OpPitch(op, midi), when);
      return;
    }
    this._fmWrites(this._fmEnc.pitch(ch, midi, when), when);
  }

  // FM3 operator keys share one register: $28 holds all four operators' bits,
  // so every edge rewrites the whole mask. The driver keeps that mask and
  // writes it on every edge (_fm3KeyOp), in its frame order: the tracks in
  // ascending index — each tick's gate key-off, then its dispatch (a full-gate
  // note's pending key-off, then the key-on) — and after them the macros, in
  // ascending operator, where a :keyon retrigger is the operator's off and on
  // (driver.md §13.4). The edges are queued with that order and written once
  // no later dispatch can add to their frame (FM3_TL), so the preview
  // writes the driver's mask sequence.
  // (and each operator's CSM span, csmOn / csmOff, _fm3OpTl; its note and
  // :pitch are its pitch's, _pt `fm3op:N`, its level its _lv)
  _resetFm3() {
    this._fm3Op = Array.from({ length: FM_OPS }, () => ({}));
    for (let op = 1; op <= FM_OPS; op++) this._pitches?.delete(`fm3op:${op}`);
    this._csmHoldSpans = []; // [start, end) in audio time: the rate track's rests
    this._fm3Mask = 0; // the operator bits $28 holds
    this._fm3KeyLast = -Infinity; // the last $28 write's time
    this._fm3KeyGen = [0, 0, 0, 0]; // per operator: bumped to drop its key-ons still waiting
  }

  // An fm3 operator's key edge, as work of its frame once every write to
  // $28 there is known (FM3_KEYS), in the driver's order; a key-on dropped
  // when the operator was let go since (`gen`: a mute, a hold let go).
  _fm3Edge(opBit, t, frame, phase, order, on, gen) {
    const op = Math.log2(opBit) - 4;
    this._step(frame, FM3_KEYS, t, () => {
      if (on && this._fm3KeyGen[op] !== gen) return;
      if (on) this._fm3Mask |= opBit;
      else this._fm3Mask &= ~opBit;
      // Never behind the previous write: the worklet applies them in time order.
      this._fm3KeyLast = Math.max(t, this._fm3KeyLast);
      this._fmKey(2, this._fm3Mask, this._fm3KeyLast);
    }, [phase, order, Math.round(t * 1e6), on ? 1 : 0]);
  }

  // A CSM operator's key-off is its level: TL 127 at `off`, or after its
  // level macros' release has played — while its note is still the track's.
  _csmMute(op, off, noteWhen, ti) {
    this._lvEnded(`fm3op:${op}`, (end) => {
      const muteAt = Math.max(off, end ?? -Infinity);
      this._fm3Op[op - 1].csmOff = muteAt;
      const at = Math.max(noteWhen, muteAt - KEY_ORDER_EPS_SECS);
      this._whileNote(ti, at, () => this._fmWrites(this._fmEnc.ch3Tl(op - 1, 127), at));
    });
  }

  // `run` at `t` while the track's note then is still its note now: the
  // track's next note takes the channel over, as the driver's dispatch does.
  // (Just after an event at `t` itself: a note there takes over first.)
  _whileNote(ti, t, run, phase = KEYED) {
    const note = this._noteOf[ti];
    this._at(t + 1e-9, () => { if (this._noteOf[ti] === note) run(); }, phase);
  }

  // The operators of `bits` keyed off now, their key-ons still waiting dropped.
  _fm3KeysOff(bits, when) {
    for (let op = 0; op < 4; op++) if (bits & (0x10 << op)) this._fm3KeyGen[op]++;
    this._fm3Mask &= ~bits;
    this._fm3KeyLast = Math.max(when, this._fm3KeyLast);
    this._fmKey(2, this._fm3Mask, this._fm3KeyLast);
  }

  // CSM (driver.md §9): Timer A keys CH3, so releasing an operator — a hold
  // note's key-off, a muted track — is its level: TL 127 until its next note.
  _fm3CsmRelease(bits, when) {
    for (let op = 1; op <= 4; op++) {
      if (!(bits & (0x10 << (op - 1)))) continue;
      this._fm3Op[op - 1].csmOff = Math.min(this._fm3Op[op - 1].csmOff ?? Infinity, when);
      this._fmWrites(this._fmEnc.ch3Tl(op - 1, 127), when);
    }
  }

  _applyCsmRate(ev, when) {
    // A rate rest stops Timer A (CSM stays on); a rate, or the gate's run
    // form, starts it again at the period it has (driver.md §9).
    const run = ev.args?.run;
    if (run !== undefined || this._csmHold) {
      const held = this._csmHold;
      this._csmHold = run === false;
      // With the operators as tracks the rest is the voice's breath: the
      // formants fall silent with Timer A and come back with it (driver.md
      // §9) — a span the queued level writes read (FM3_TL), and an
      // edge of their own here.
      if (this._fm3Ops && this._csmHold !== held) {
        if (this._csmHold) this._csmHoldSpans.push([when, Infinity]);
        else if (this._csmHoldSpans.length) this._csmHoldSpans[this._csmHoldSpans.length - 1][1] = when;
        for (let op = 1; op <= 4; op++) this._writeFm3OpTl(op, when);
      }
      this._setReg27State({}, when);
      if (run !== undefined) return;
    }
    const hz = Number(ev.args?.hz);
    if (Number.isFinite(hz) && hz > 0) {
      this._setCsmRateHz(hz, when);
      return;
    }

    const from = Number(ev.args?.from);
    const to = Number(ev.args?.to);
    const lenTicks = Number(ev.args?.len);
    if (!(Number.isFinite(from) && from > 0)) return;
    if (!(Number.isFinite(to) && to > 0)) return;
    if (!(Number.isFinite(lenTicks) && lenTicks > 0)) return;

    const curve = ev.args?.curve ?? "linear";
    const frames = Math.max(1, Math.round(lenTicks * this._secsPerTick * 60));
    // Swept in Timer A's period between the two rounded ends, as the driver
    // sweeps it (a linear sweep in Hz would bow away from it mid-way).
    const taFrom = this._fmEnc.timerAOf(from);
    const taTo = this._fmEnc.timerAOf(to);
    // The track's next rate ends the sweep, as on the driver: a glide longer
    // than its rate note is cut by the next one.
    let runFrames = frames;
    const track = ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
    let next = null;
    for (let i = (track?.flatIndex ?? 0) + 1; track && i < track.events.length; i++) {
      const e = track.events[i];
      if (e.cmd === "CSM_RATE" && e.args?.run === undefined) { next = e; break; }
    }
    if (next && next.tick < ev.tick + lenTicks) {
      const nextWhen = when + (next.tick - ev.tick) * this._secsPerTick;
      runFrames = Math.max(1, this._eventFrame(nextWhen) - this._eventFrame(when));
    }
    for (let frame = 0; frame < runFrames; frame++) {
      const phase = frames <= 1 ? 1 : frame / (frames - 1);
      const unit = sampleCurveUnit(curve, phase, ev.args?.params);
      this._fmWrites(this._fmEnc.timerA(Math.round(taFrom + (taTo - taFrom) * unit)), when + frame / 60);
    }
  }

  _expandLoops(events) {
    return expandLoops(events);
  }

  // `:target midi`'s levels as the score writes them, for the panel: a
  // track's :vol (a value, a sweep, `+` `*` `$slot`), and a note's :vol
  // macro, which takes the fader's place until the next note (the output's
  // plan does the same, midi-plan.js); the song's :master is every
  // machine's (_songWord).
  _midiLevel(ev, when) {
    const ti = ev._trackIndex;
    if (ti == null) return;
    const site = `mtrk:${ti}`;
    if (ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") {
      // (its note's path every voice's, _playNote: the output's plan plays
      // its :vel, the level here is the panel's reading of its :vol)
      this._playNote(ev, when, { level: site, vel: Number(ev.args?.vel ?? 15), levelArgs: ev.args?.vol ? { vol: ev.args.vol } : {} });
    }
  }

  // A sample note's place in its def's points (setOnPosition): a `gate` or
  // `loop` note is let go at its gate, every note stopped by the next.
  _reportSample(ev, when) {
    const mode = ev.args.mode ?? "shot";
    const gate = this._gateOf(ev._trackIndex) ?? this._noteGate(ev, when);
    const off = mode === "shot" || gate.hold ? Infinity : gate.end;
    this._onPosition({ kind: "sample", name: ev.args.sample, when, mode, off, cut: this._nextNote(ev).secs });
  }

  _dispatchEvent(ev, when) {
    // A note closes its track's open note first, on that note's voice — the
    // one close path every voice shares (_closeNote).
    // Then the note opens, its gate decided by the one rule (_noteGate);
    // its voice says what closing does on it (_noteCloses).
    if ((ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") && ev._trackIndex != null) {
      this._closeNote(ev._trackIndex, when, { next: true, legato: !!ev.args?.legato, keys: this._isTrackAudible(ev._trackIndex) });
      this._openNote(ev._trackIndex, ev, when);
    }
    // A pcm note's gate is an event too, in its track's order among the
    // tick's (the driver's): it closes the note there, unless its gate's end
    // came first (a frame-clocked machine's whole frames, _openNote).
    if (ev.cmd === "PCM_NOTE_OFF" && ev._trackIndex != null) this._closeNote(ev._trackIndex, when, { gate: true });
    const hand = handWordOf(ev);
    if (hand && !this._scoreWrites(hand)) return;
    // A score write of MASTER takes it back from a hand let go; under one
    // held it runs on, unheard.
    if (this._masterHand && !this._masterHand.held && ev.cmd.startsWith("PARAM_")
      && String(ev.args?.target ?? "").toUpperCase() === "MASTER") this._masterHand = null;
    if (ev._trackIndex != null && writesVol(ev)) this._volTakeBack(ev._trackIndex, when);
    this._freeSlot(ev);
    // `:target midi`: its sound is the output's, which the plan writes; what
    // the panel shows of its levels is the score's, kept here (the output
    // reads the panel's hand beside it: read's `score`).
    if (this._target?.name === "midi") this._midiLevel(ev, when);
    // A song-wide word is the song's, written on any track: one table,
    // whatever the track's kind (_songWord) — MASTER, a value slot, the
    // SSG's noise period and envelope rate, a wave chip's own LFO words.
    // The language's LFO is the song's too (language.md §1): on a machine
    // whose LFO is the FM's, a PSG or PCM track's write goes where an FM
    // track's does, as the driver takes it from any track (below).
    if (ev.cmd.startsWith("PARAM_")) {
      const target = String(ev.args?.target ?? "").toUpperCase();
      const song = isSongWord(target) ? this._songWord(ev, target) : null;
      if (song || /^VAL\d+$/.test(target)) return void this._word(ev, when, song);
    }
    // :vol is every track's fader, one word whatever the track's kind
    // (_volWord): its voice's level written again; :pan every track's pan
    // that has one (_panWord); :pitch and :snap every pitched track's
    // (_pitchWord, _snapWord).
    // (A MIDI channel's :pan and :pitch are its output's.)
    const word = ev.cmd.startsWith("PARAM_") ? String(ev.args?.target ?? "").toUpperCase() : null;
    const SHARED = { VOL: "_volWord", PAN: "_panWord", NOTE_PITCH: "_pitchWord", SNAP: "_snapWord" };
    if (SHARED[word] && (word === "VOL" || this._target?.name !== "midi")) {
      this._word(ev, when, this[SHARED[word]](ev));
      return;
    }
    if (this._dispatchGlobalEvent(ev, when)) return;
    if (ev.cmd === "PCM_NOTE_ON" && this._onPosition && ev.args?.sample && this._isTrackAudible(ev._trackIndex))
      this._reportSample(ev, when);
    const core = ev._route.core;
    // A wave chip's LFO table (LFO_WAVE) is written whole.
    if (ev.cmd === "PARAM_SET" && this._waveLfoRoute(ev.args?.target)?.word === "lfoTable") {
      this._waveLfoRoute(ev.args.target).write(ev.args.table ?? [], when);
      return;
    }
    if (core === "none") return; // a MIDI channel's: its sound is the MIDI output's
    if (core !== "fm" && LFO_TARGETS.has(ev.args?.target) && /^PARAM_/.test(ev.cmd))
      ev = { ...ev, _route: FM_LFO_ROUTE, _chIndex: 0 };

    // The PSG core.
    if (ev._route.core === "psg") {
      this._dispatchPsgEvent(ev, when);
      return;
    }

    // The sample core, by the track's part (SAMPLE_HANDLERS). A sample
    // track's _chIndex is its voice, which collides with FM channel indices —
    // its PARAM_SETs must NOT fall through to the FM path (they would corrupt
    // FM ch 1-3's TL).
    if (ev._route.core === "sample") {
      this[SAMPLE_HANDLERS[ev._route.part.name]](ev, when);
      return;
    }

    const ch = ev._chIndex ?? 0;

    switch (ev.cmd) {
      case "NOTE_ON": {
        // The note's path is every voice's (_playNote); an fm3 operator's
        // level and pitch are its own (driver.md §13.4), its note set by its
        // FM3_OP_PITCH.
        const fm3Op = Number(ev.args?.fm3Op);
        const op = ch === 2 && Number.isInteger(fm3Op) && fm3Op >= 1 && fm3Op <= 4 ? fm3Op : 0;
        const site = op ? `fm3op:${op}` : `fm:${ch}`;
        this._playNote(ev, when, { level: site, pitch: site, pitchOn: !op, key: (n) => this._fmNoteKey(ev, when, ch, op, n) });
        break;
      }

      // A word, every way it is written (_word).
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._fmWord(ch, ev));
        break;

      case "CSM_RATE": {
        this._applyCsmRate(ev, when);
        break;
      }

      case "CSM_ON": {
        this._setReg27State({ csmEnabled: true }, when);
        break;
      }

      case "CSM_OFF": {
        this._setReg27State({ csmEnabled: false }, when);
        break;
      }

      case "FM3_MODE": {
        // In CH3 special mode each operator takes its frequency from its own
        // F-number register. An operator no fm3-N track drives keeps whatever
        // it holds: it is never keyed, so it stays silent — and the driver
        // writes nothing for it either (FM3_MODE is $27 alone).
        // "csm-op" is CSM with the operators as tracks (driver.md §9): $27
        // carries CSM alone — the chip keys CSM in that mode only — and the
        // operators' own levels and keys come from this flag, not from bit 6.
        const mode = ev.args?.mode ?? "";
        this._fm3Ops = mode === "op" || mode === "csm-op";
        this._setReg27State(
          { fm3SpecialMode: mode === "op", csmEnabled: mode === "csm-op" ? true : undefined },
          when,
        );
        break;
      }

      case "FM3_OP_PITCH": {
        const op = Number(ev.args?.op);
        if (!Number.isInteger(op) || op < 1 || op > 4) break;
        const site = `fm3op:${op}`;
        this._ptNoteOn(site, pitchToMidi(ev.args?.pitch ?? "c4"), this._onsetPitchOffset(ev, this._pt(site).offset));
        this._ptWrite(site, when);
        break;
      }
    }
  }

  // The ADPCM-B's RAM (chips/adpcm-b.js bakeAdpcmB): which range each sample
  // is, and the rate it plays C4 at. Without it a note writes nothing.
  setAdpcmBank(bank) {
    this._adpcmBank = bank ?? null;
  }

  // The samples as frames (chips/msm6258.js bakePcm8) for a part that plays
  // them so (`frames`: the X68000's PCM8, the PC Engine's DDA): each one's
  // frames and the rate it plays C4 at. Without it a note writes nothing.
  setFrameBank(bank) {
    this._frameBank = bank ?? null;
    this._dmcRates = null; // the DMC's rate a sample, from the bank and the score
  }

  _dispatchGlobalEvent(ev, when) {
    switch (ev.cmd) {
      case "TEMPO_SET": {
        const bpm = drvBpm(Number(ev.args?.bpm));
        if (Number.isFinite(bpm) && bpm > 0) {
          this._tempoSweep = null;
          if (bpm !== this._bpm) {
            this._setTempoAtTick(bpm, ev.tick ?? 0, when);
          }
        }
        return true;
      }

      case "TEMPO_SWEEP": {
        this._startTempoSweep(ev.args ?? {}, ev.tick ?? 0, when);
        return true;
      }

      // A rest closes the track's open note (_closeNote); so does the end
      // of a track that does not loop.
      case "REST":
        this._closeNote(ev._trackIndex, when);
        return true;
      case "TRACK_END":
        this._songEndAt = Math.max(this._songEndAt ?? -Infinity, when); // the capture's end (captureRegisterLog)
        if (!(this._loop && this._tracks[ev._trackIndex]?.hasLoop)) this._closeNote(ev._trackIndex, when);
        return true;

      case "MARKER":
      case "TRIG":
      case "LOOP_BEGIN":
      case "LOOP_END":
      case "TIE":
      case "JUMP":
        return true;

      default:
        return false;
    }
  }

  // The FM3 operator an event's track drives (0 = not an operator track).
  _fm3OpOf(ev) {
    return ev?._trackIndex != null ? (this._tracks[ev._trackIndex]?.fm3Op ?? 0) : 0;
  }

  // Read a target's current stored value from chRegs (the shadow register file)
  // for read-modify-write PARAM_ADD / PARAM_MUL. FM_TL reads the voiced (timbre)
  // base so a relative TL op composes with vel/vol attenuation.
  _readParam(ch, target) {
    const regs = this._chRegs[ch];
    if (!regs) return 0;
    const t = String(target || "").toUpperCase();
    const m = t.match(/^FM_([A-Z]+(?:2_)?)([1-4])$/);
    if (m) {
      const f = OP_REG_FIELD[m[1]];
      return f ? (regs.ops[+m[2] - 1]?.[f] ?? 0) : 0;
    }
    switch (t) {
      case "FM_FB": return regs.feedback ?? 0;
      case "FM_ALG": return regs.algorithm ?? 0;
      case "FM_AMS": return regs.ams ?? 0;
      case "FM_FMS": return regs.fms ?? 0;
      // The song's LFO, as last written (the OPM's own words its reading).
      case "LFO_RATE": return this._lfoRate ?? 0;
      case "LFO_FREQ": return this._opmLfo.freq ?? 0;
      case "LFO_PMD": return this._opmLfo.pmd ?? 0;
      case "LFO_AMD": return this._opmLfo.amd ?? 0;
      case "LFO_WAVE": return this._opmLfo.wave ?? 0;
      default: return 0;
    }
  }

  _applyParam(ch, ev, when) {
    const regs = this._chRegs[ch];
    const target = (ev.args?.target ?? "").toUpperCase();
    // A register in the panel's hand: the score's write waits while it is
    // held, and takes it back once let go.
    if (this._hands.size && !this._panelWrite
      && !this._scoreWrites(HAND_PARAMS.has(target) ? target : `reg:${ch}:${target}`)) return;
    const value = ev.args?.value ?? 0;

    // Helper to round, clamp and apply. All hardware register targets are integers;
    // rounding here means curves routed through _applyParam never store floats.
    const range = this._fmRanges?.[target.replace(/\d+$/, "")];
    const set = (apply, min, max) => {
      const [lo, hi] = range ?? [min, max];
      const next = Math.max(lo, Math.min(hi, Math.round(value)));
      apply(next);
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
        this._fmWrites(this._fmEnc.alg(ch, regs, when), when);
        break;
      case "FM_ALG":
        set(
          (v) => {
            regs.algorithm = v;
          },
          0,
          7,
        );
        this._fmWrites(this._fmEnc.alg(ch, regs, when), when);
        break;
      case "FM_TL1":
      case "FM_TL2":
      case "FM_TL3":
      case "FM_TL4": {
        const opIdx = parseInt(target[5]) - 1;
        set(
          (v) => {
            // Voiced (timbre) TL — the base level vel/vol/master attenuate from.
            regs.ops[opIdx].voicedTl = v;
            regs.ops[opIdx].tl = this._opLevel(ch, opIdx, when);
          },
          0,
          127,
        );
        this._fmOp(ch, opIdx, "tl", when);
        break;
      }
      case "FM_VEL1":
      case "FM_VEL2":
      case "FM_VEL3":
      case "FM_VEL4": {
        // Velocity sensitivity (sixteenths, -1 = the role's own): no register
        // of its own, it re-composes the operator's level.
        const opIdx = parseInt(target[6]) - 1;
        const v = Math.round(value);
        regs.ops[opIdx].velK = v >= 0 && v <= 16 ? v : undefined;
        regs.ops[opIdx].tl = this._opLevel(ch, opIdx, when);
        this._fmOp(ch, opIdx, "tl", when);
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
        this._fmOp(ch, opIdx, "ks-ar", when);
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
        this._fmOp(ch, opIdx, "am-dr", when);
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
        this._fmOp(ch, opIdx, "sr", when);
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
        this._fmOp(ch, opIdx, "am-dr", when);
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
        this._fmWrites(this._fmEnc.pan(ch, regs), when);
        break;
      case "FM_FMS":
        set(
          (v) => {
            regs.fms = v;
          },
          0,
          7,
        );
        this._fmWrites(this._fmEnc.pan(ch, regs), when);
        break;
      case "PAN": // (a note's pan macro: the one pan, _setPan)
        this._setPan(`fm:${ch}`, value, when);
        break;
      // :lfo-sync: the channel's key-ons start the song's LFO over (_fmKey).
      case "LFO_SYNC":
        regs.lfoSync = value >= 0.5;
        break;
      case "LFO_RATE": {
        const rate = Math.max(0, Math.min(8, Math.round(value)));
        this._lfoRate = rate;
        // On the OPM it is a reading of its own LFO, which the panel shows.
        Object.assign(this._opmLfo, this._fmEnc.lfoReading?.(rate) ?? {});
        this._fmWrites(this._fmEnc.lfo(rate), when);
        break;
      }
      // The OPM's own LFO (chips/ym2151.js).
      // The OPM's own LFO (chips/ym2151.js), kept for the panel.
      case "LFO_FREQ":
        this._opmLfo.freq = Math.round(value);
        this._fmWrites(this._fmEnc.lfoFreq?.(Math.round(value)) ?? [], when);
        break;
      case "LFO_PMD":
        this._opmLfo.pmd = Math.round(value);
        this._fmWrites(this._fmEnc.lfoPmd?.(Math.round(value)) ?? [], when);
        break;
      case "LFO_AMD":
        this._opmLfo.amd = Math.round(value);
        this._fmWrites(this._fmEnc.lfoAmd?.(Math.round(value)) ?? [], when);
        break;
      case "LFO_WAVE":
        this._opmLfo.wave = Math.round(value);
        this._fmWrites(this._fmEnc.lfoWave?.(Math.round(value)) ?? [], when);
        break;
      // fm8's :mode on the OPM: its fourth operator the noise, or a sine.
      case "FM_NOISE":
        this._fmWrites(this._fmEnc.noise?.(Math.round(value) === 1) ?? [], when);
        break;
      case "FM_DT2_1":
      case "FM_DT2_2":
      case "FM_DT2_3":
      case "FM_DT2_4": {
        // The OPM's second detune, beside the operator's SR.
        const opIdx = parseInt(target[7]) - 1;
        set((v) => { regs.ops[opIdx].dt2 = v; }, 0, 3);
        this._fmOp(ch, opIdx, "sr", when);
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
        this._fmOp(ch, opIdx, "sl-rr", when);
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
        this._fmOp(ch, opIdx, "dt-ml", when);
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
        this._fmOp(ch, opIdx, "sl-rr", when);
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
          -3,
          3,
        );
        this._fmOp(ch, opIdx, "dt-ml", when);
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
        this._fmOp(ch, opIdx, "ks-ar", when);
        break;
      }
      // The OPLL's (chips/ym2413.js): the waveform, the envelope type, the
      // level's key scale and the vibrato, each a bit (KSL two) of its voice.
      case "FM_WS1":
      case "FM_WS2":
      case "FM_EG1":
      case "FM_EG2":
      case "FM_KSL1":
      case "FM_KSL2":
      case "FM_VIB1":
      case "FM_VIB2": {
        const opIdx = Number(target.slice(-1)) - 1;
        const field = { WS: "ws", EG: "eg", KSL: "ksl", VIB: "vib" }[target.slice(3, -1)];
        set((v) => { regs.ops[opIdx][field] = v; }, 0, field === "ksl" ? 3 : 1);
        this._fmOp(ch, opIdx, "voice", when);
        break;
      }
      // The OPLL's sustain: a keyed-off note releases at RR 5.
      case "FM_SUS":
        set((v) => { regs.sus = v; }, 0, 1);
        this._fmWrites(this._fmEnc.sus?.(ch, regs.sus, when) ?? [], when);
        break;
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
        this._fmOp(ch, opIdx, "ssg-eg", when);
        break;
      }

      default:
        break;
    }
  }

  // Global master volume 0-31 (31=full). Re-applies carrier TL on all FM
  // channels, PSG attenuation on all sounding PSG channels, and recomposes every
  // PCM soft-mix voice (the bit-shift attenuation rides master too). Reached from
  // a PARAM_SET MASTER on any track (FM/PSG/PCM), so all three stay in step.
  _applyMasterChange(value, when) {
    this._masterVol = Math.max(0, Math.min(31, Math.round(value)));
    this._recomposeLevels(when);
  }

  // Every level composed again from what it is now, after the master moved
  // (the score's _masterVol, or the panel's hand over it, _handMaster): each
  // FM channel, each keyed tone lane, the PCM voices.
  _recomposeLevels(when) {
    for (let ci = 0; ci < this._fmEnc.channels; ci++) {
      if (ci === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(ci, when);
    }
    // (A lane the level has silenced stays so until its note's own level
    // moves: the driver re-applies the master to sounding lanes.)
    for (let lane = 0; lane < PSG_LANES; lane++) if (this._psgSounding[lane]) this._psgRecompose(lane, when);
    // PCM voices ride master too: the voice model recomposes every voice;
    // the chips' own sample voices, each sounding hit.
    this._pcmEv(when, { kind: "master", value: this._masterVol });
    for (const voice of this._chipPcm?.owner.keys() ?? []) this._chipPcmWrite(voice, when);
  }

  // A note's gate on a frame-clocked target (the MSX, `frameClock`): in the
  // note's own frames as its driver counts them — it starts on its key-on's
  // frame (_frameOf) and keys off whole frames later, its share
  // of the frames to its end rounded down, one at least (held to MGSDRV on
  // libkss: q6 of a 15-frame note is 11). Returned in ticks; a held or
  // full-length gate is as it was.
  _frameGate(when, gateTicks, lengthTicks) {
    if (!this._target?.frameClock || !(gateTicks > 0) || !(gateTicks < lengthTicks)) return gateTicks;
    const f0 = this._frameOf(when), f1 = this._frameOf(this._timeAfterTicks(when, lengthTicks));
    const g = Math.max(1, Math.floor(((f1 - f0) * gateTicks) / lengthTicks + 1e-6));
    const off = this._frameOrigin + (f0 + g) / 60;
    return Math.min(lengthTicks, Math.max(0, (off - when) / this._secsPerTick));
  }

  // Compute { noteFrames, gateSecs } for macro scheduling.
  // gateTicks === 0 = hold note (runs until triggerKeyOff).
  _resolveNoteFramesAndGate(when, gateTicks) {
    if (gateTicks === 0) {
      return { noteFrames: HOLD_FRAMES, gateSecs: when + 1e9 };
    }
    const gateEnd = this._timeAfterTicks(when, gateTicks);
    return {
      noteFrames: Math.max(1, Math.floor((gateEnd - when) * 60 + 1e-6)),
      gateSecs: gateEnd - KEY_OFF_LEAD_SECS,
    };
  }

  // Audio time of the next NOTE_ON on this event's track (the same channel), or
  // Infinity if none remain. Used as the monophonic-priority cutoff so a note's
  // macro tail (echo/retrigger) cannot bleed past the following note.
  // The audio time `ticks` ticks after `when`, through the tempo changes
  // known ahead of it: a running sweep's remaining steps and the TEMPO_SETs
  // the tracks have yet to dispatch. A length in ticks (a gate, a tick-clocked
  // macro's steps) that spans a change is then as long as the driver plays it
  // — the driver counts ticks under whatever tempo each frame has.
  _timeAfterTicks(when, ticks) {
    if (!(ticks > 0)) return when;
    let t = when;
    let spt = this._secsPerTick; // the tempo now; a change before `when` rules there
    let left = ticks;
    for (const c of this._tempoChangesAhead()) {
      if (c.when > t + 1e-9) {
        const span = (c.when - t) / spt;
        if (span >= left) break;
        left -= span;
        t = c.when;
      }
      spt = 60 / (c.bpm * this._ppqn);
    }
    // On a frame-clocked target a time the ticks reach is a frame's: a gate's
    // end and the next note's key-on fall on one frame, in the order written.
    return this._target?.frameClock ? this._frameStart(t + left * spt) : t + left * spt;
  }

  // The tempo changes still to come that are already known: the sweep's
  // steps, and each track's next TEMPO_SETs at their projected times, in time
  // order. Cached per scheduler state (a change dispatched moves them).
  _tempoChangesAhead() {
    const key = `${this._bpm}|${this._tempoSweep?.steps.length ?? 0}|${this._schedGen}`;
    if (this._tempoAheadKey !== key) {
      const list = [...(this._tempoSweep?.steps ?? [])];
      if (!this._hands.get("tempo")?.held) {
        for (const track of this._tracks) {
          for (const i of track.tempoIdx ?? []) {
            if (i < track.flatIndex) continue; // flatIndex: the next to dispatch
            const ev = track.events[i];
            const bpm = drvBpm(Number(ev.args?.bpm));
            if (bpm > 0) list.push({ when: track.audioTimeAtTick0 + ev.tick * this._secsPerTick, bpm });
          }
        }
      }
      list.sort((a, b) => a.when - b.when);
      this._tempoAhead = list;
      this._tempoAheadKey = key;
    }
    return this._tempoAhead;
  }

  // The next NOTE_ON on this track: when it lands, and whether it slurs into
  // this note (NOTE_ON_EX bit3). Both are needed at note-on — the time bounds
  // macro tails, the flag decides whether this note keys off before it.
  _nextNote(ev) {
    const track = ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
    if (!track) return { secs: Infinity, legato: false };
    const secsPerTick = this._secsPerTick;
    const base = track.audioTimeAtTick0 + ev.tick * secsPerTick;
    for (let i = track.flatIndex + 1; i < track.events.length; i++) {
      const ne = track.events[i];
      if (ne.cmd === "NOTE_ON" || ne.cmd === "PCM_NOTE_ON") {
        return {
          secs: this._timeAfterTicks(base, ne.tick - ev.tick),
          legato: !!ne.args?.legato,
        };
      }
    }
    // No more notes this iteration: if the track loops, the next note is the
    // first note of the next iteration (same time base as the loop restart at
    // _scheduleLoop), so the last note's tail is clipped at the loop seam.
    if (this._loop && track.hasLoop && track.loopDuration) {
      for (let i = track.loopStartIndex ?? 0; i < track.events.length; i++) {
        const ne = track.events[i];
        if (ne.cmd === "NOTE_ON" || ne.cmd === "PCM_NOTE_ON") {
          return {
            secs:
              track.audioTimeAtTick0 +
              (track.loopDuration + ne.tick) * secsPerTick,
            legato: !!ne.args?.legato,
          };
        }
      }
    }
    return { secs: Infinity, legato: false };
  }

  // Effective carrier TL = voiced (timbre) TL + velocity ladder + vol/master
  // attenuation, all as dB-domain offsets (preserving the patch's base level
  // and per-carrier balance).
  //
  // vel is musical velocity: a ~2 dB/step logarithmic ladder matching the
  // PMD / MDSDRV coarse volume convention. vel 15 = no attenuation (patch
  // level), vel 0 = a ~-30 dB floor — it never mutes. True silence is a rest,
  // or vol/master 0 (handled as a hard mute at key-on time).
  //
  // The vel offset is scaled by the operator's sensitivity (`:vel1`–`:vel4`,
  // sixteenths). vol and master are the mix's faders, so they reach a carrier
  // only: a velocity-sensitive modulator (`carrier` false) takes its scaled
  // vel and nothing else — a fader that moved a modulator would move the
  // timbre.
  _carrierTl(op, vel, vol, master, carrier = true) {
    // Sum the signed dB offsets on top of the voiced TL, then quantize once —
    // in the driver's quarter steps, vel on its eighth grid. vel attenuates
    // (floors, never mutes); vol/master are bipolar (boost = negative offset,
    // clamped at TL 0). Uniform across carriers, so the patch's per-carrier
    // balance is preserved.
    return levelSteps(carrier ? this._fmLevel : this._fmModLevel, {
      base: op.voicedTl ?? 0, vel, k: velK(op.velK, carrier), faders: carrier ? [vol, master] : [],
    });
  }

  // Snap curve/function outputs to discrete hardware lanes when needed.
  _snapMacroOutput(target, value) {
    const t = String(target || "").toUpperCase();
    if (t === "PAN") {
      // -1 (left) .. +1 (right); the encoder reads it at its chip's
      // resolution (opn-regs.js panSide: left / both / right).
      return Math.max(-1, Math.min(1, Number(value) || 0));
    }
    if (t === "NOISE_MODE") {
      // SN76489 mode is a 3-bit integer (0..7)
      return Math.max(0, Math.min(7, Math.round(Number(value) || 0)));
    }
    return value;
  }

  // A song LFO word's route into a wave chip with an LFO of its own: the
  // encoder's word and its write, or null when the chip has neither.
  _waveLfoRoute(target) {
    const word = WAVE_LFO_WORDS[target];
    if (!word) return null;
    const lane = this._toneEnc.findIndex((l) => l?.enc.lfoFreq);
    if (lane < 0 || !this._toneEnc[lane].enc[word]) return null;
    return { word, write: (v, t) => this._psgWrites(this._lane(lane, (e) => e[word](v)), t) };
  }

  /**
   * External real-time parameter write.
   * target: e.g. 'FM_TL1', 'FM_FB', 'FM_ALG'
   * value: absolute value (always SET, not ADD)
   * chIndex: an FM channel (default 0)
   * when: its time (now when absent)
   */
  setParam(target, value, chIndex = 0, when = undefined) {
    // Wave chips' song-wide LFO words use their own encoder, as score writes do.
    const waveLfo = this._waveLfoRoute(target);
    if (waveLfo && waveLfo.word !== "lfoTable") {
      waveLfo.write((this._waveLfo[waveLfo.word] = Math.round(value)), when);
      return;
    }
    this._applyParam(chIndex, {
      cmd: "PARAM_SET",
      args: { target, value },
    }, when);
    // An encoder that holds a voice change for the note's key-on (the
    // OPLL's) writes a live edit now.
    this._fmWrites(this._fmEnc.live?.(chIndex) ?? [], when);
  }

  /** The sample a PCM voice (0-2) last played, or null. */
  pcmSampleOf(voice) {
    return this._pcmSample[voice] ?? null;
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
      opmLfo: { ...this._opmLfo },
      waveLfo: this._toneEnc.some((l) => l?.enc.lfoFreq) ? { ...this._waveLfo } : null,
      ops: r.ops.map((o) => ({ ...o })),
    };
  }

  // ---------------------------------------------------------------------------
  // PSG helpers. The target's PSG chip (chips/) encodes each operation as
  // [port, addr, data] writes — the SN76489's bytes on port 2, the worklet
  // protocol's PSG.
  // ---------------------------------------------------------------------------

  _psgWrites(writes, when) {
    for (const [port, addr, data] of writes) this._write(port, addr, data & 0xff, when);
    // Off the scheduler (a key, a live edit while stopped) nothing would
    // flush an encoder's queue (chips/rp2a03.js, ssg.js): it is written now.
    if (!this._playing) this._flushEncoders(Infinity);
  }
  // The target's PSG encoder: its tone chip's, or a noise alone (the OPM's,
  // chips/ym2151.js), or null.
  _psgChipOf(target) {
    // The FM encoder goes along: a chip whose noise is an FM register (the
    // OPM's $0F) shares it.
    return (target.chipForKind("tone") ?? target.chipForKind("noise"))?.psgEncoder?.(this._fmEnc) ?? null;
  }
  // Each tone lane's { enc, ch, chip, part }: the PSG encoder `psg`'s lanes
  // 0-3 (its own numbering; a chip whose lanes differ — the 2A03's pulses,
  // triangle and noise, each its own period — hands a view a lane, `lanes`),
  // a wave chip's encoder for its channels. A lane the target lacks is null.
  // `used`: each chip's voices the score plays (_voicesOf), which an encoder
  // may lay the chip out by (the N163's channel count, chips/n163.js).
  _toneEncodersOf(target, psg, used = new Map()) {
    const lanes = new Array(PSG_LANES).fill(null);
    if (psg)
      for (let l = 0; l < 4; l++) {
        const c = Object.values(target.channels).find((c) => CORE_OF_KIND[c.part.kind] === "psg" && !c.part.toneLane && toneLaneOf(c) === l);
        lanes[l] = { enc: psg.lanes?.[l] ?? psg, ch: l, chip: null, part: c?.part };
      }
    const waveEnc = new Map();
    for (const c of Object.values(target.channels)) {
      const chip = target.chips[c.chip];
      // A tone chip of its own beside the PSG (a cartridge's, the VRC6's,
      // chips/vrc6.js): its encoder's view for the channel, on the part's lane.
      if (chip.toneEncoder && c.part.toneLane) {
        if (!waveEnc.has(chip)) waveEnc.set(chip, chip.toneEncoder(used.get(chip) ?? new Set()));
        lanes[toneLaneOf(c)] = { enc: waveEnc.get(chip).lanes[c.voice], ch: c.voice, chip, part: c.part, queue: waveEnc.get(chip) };
        continue;
      }
      // A wave channel of the PSG's own chip (the Game Boy's): that encoder's lane.
      if (c.part.kind === "wave" && chip.psgEncoder) {
        lanes[toneLaneOf(c)] = { enc: psg.lanes[toneLaneOf(c)], ch: c.voice, chip: null, part: c.part };
        continue;
      }
      // A wave chip's channels, and its channels turned to noise (the PC
      // Engine's fifth and sixth, chips/huc6280.js): the encoder's noise
      // view, on a lane of the part's own.
      const asNoise = c.part.kind === "noise" && c.part.toneLane;
      if (c.part.kind !== "wave" && !asNoise) continue;
      if (!waveEnc.has(chip)) waveEnc.set(chip, chip.waveEncoder(used.get(chip) ?? new Set()));
      const enc = waveEnc.get(chip);
      lanes[toneLaneOf(c)] = { enc: asNoise ? enc.noise : enc, ch: c.voice, chip, part: c.part };
    }
    return lanes;
  }
  // The encoders that queue timed writes for flush(horizon) (chips/rp2a03.js,
  // ssg.js, vrc6.js): the PSG's and a tone chip's beside it.
  _queuedEncoders() {
    const extra = new Set(this._toneEnc.map((l) => l?.queue).filter(Boolean));
    return [this._psgChip, ...extra].filter(Boolean);
  }
  _flushEncoders(horizon) {
    for (const enc of this._queuedEncoders()) for (const [p, a, d, t] of enc.flush?.(horizon) ?? []) this._write(p, a, d, t);
  }
  // A PSG write: on `lane`'s chip where a lane is named (a tone chip's
  // beside the PSG, the 5B's, has its own noise and envelope), else on the
  // PSG — or, where the PSG has no `method` (the 2A03 has no noise period
  // or envelope), the first tone chip that has. Nothing where none is.
  _psg(encode, method = null, lane = null) {
    const enc = lane != null ? this._toneEnc[lane]?.queue ?? this._psgChip
      : !method || this._psgChip?.[method] ? this._psgChip
      : this._queuedEncoders().find((e) => e[method]) ?? null;
    if (!enc) return [];
    // A cartridge's chip not yet started is started first, as _lane does.
    const l = enc === this._psgChip ? null : this._toneEnc.find((x) => x?.queue === enc);
    if (l?.chip.optional && !this._chipsStarted.has(l.chip)) {
      this._chipsStarted.add(l.chip);
      return [...this._startOf(l), ...encode(enc)];
    }
    return encode(enc);
  }
  // A noise lane the PSG core plays as one (its mode, no pitch): the PSG's,
  // lane 3, or a tone chip's beside it (the 5B's, chips/sunsoft-5b.js) — not
  // a wave chip's channel turned to noise (the PC Engine's), pitched as a tone.
  _isNoiseLane(psgCh) {
    const l = this._toneEnc[psgCh];
    return psgCh === 3 || (l?.part?.kind === "noise" && !!l.queue);
  }
  // A cartridge's start: its encoder's for the score where it lays the chip
  // out by it (`start`, the N163's), else the chip's.
  _startOf(l) {
    return (l.queue ?? l.enc).start?.() ?? l.chip.init;
  }
  // Each chip's voices the score's tracks play: chip → Set.
  _voicesOf(target, ir) {
    const used = new Map();
    for (const t of ir?.tracks ?? []) {
      const c = target.channels[t.scoreChannel ?? t.channel];
      if (!c) continue;
      const chip = target.chips[c.chip];
      if (!used.has(chip)) used.set(chip, new Set());
      used.get(chip).add(c.voice);
    }
    return used;
  }
  // A tone lane's writes, `encode(enc, ch)` on its chip's encoder; nothing on
  // a lane the target lacks. An optional chip (the SCC cartridge) is started
  // with its first write of the run — unless that write is a silence, which
  // a chip never started already is: a score that plays none has none.
  _lane(psgCh, encode, silence = false) {
    const l = this._toneEnc[psgCh];
    if (!l) return [];
    if (l.chip?.optional && !this._chipsStarted.has(l.chip)) {
      if (silence) return [];
      this._chipsStarted.add(l.chip);
      return [...this._startOf(l), ...encode(l.enc, l.ch)];
    }
    return encode(l.enc, l.ch);
  }

  /**
   * The def-wave `name`'s steps are now `data` (the editor drawing it): the
   * loaded score plays them from here — until the next load, which has them
   * in its IR — and every lane playing it hears them at once.
   */
  setWave(name, data) {
    this._drawnWaves.set(name, [...data]);
    const when = this._audioContext?.currentTime ?? 0;
    this._laneWave.forEach((n, lane) => {
      if (n === name) this._writeLaneWave(lane, data, when);
    });
  }

  /** Put `data` on wave lane `lane` for the keys, as the def-wave `name` (null: none). */
  previewWave(lane, data, name = null) {
    this._laneWave[lane] = name;
    this._psgWrites(this._lane(lane, (e, ch) => e.wave?.(ch, this._fitWave(lane, data)) ?? []), this._audioContext?.currentTime ?? 0);
  }

  // The frame a time falls on, on a frame-clocked target: the nearest, a
  // half up (MGSDRV's count c starts on frame round(c · W / 192), W the
  // whole note's floor(14400 / t) frames — held to it on libkss), with a
  // hair over for the tempo's rounded tick (drvBpm).
  _frameOf(when) {
    return Math.floor((when - this._frameOrigin) * 60 + 0.5 + 0.01);
  }
  // A write's time on a frame-clocked target (`_write`): its frame's start,
  // the writes in it kept in their order (1e-4 of a frame between the
  // first and the last). None (now) stays none.
  _frameTime(when) {
    if (when === undefined || when === null || typeof when !== "number") return when;
    const f = (when - this._frameOrigin) * 60;
    const F = this._frameOf(when);
    return this._frameOrigin + (F + (f - F + 0.51) * 1e-4) / 60;
  }
  // The frame boundary a time's event happens on.
  _frameStart(when) {
    return this._frameOrigin + this._frameOf(when) / 60;
  }

  // When the last of the tracks' notes ends, on their own clocks.
  _songEndTime() {
    let end = 0;
    for (const t of this._tracks ?? []) {
      const ticks = t.events.reduce((m, e) => Math.max(m, e.tick + (e.args?.length ?? 0)), 0);
      end = Math.max(end, t.audioTimeAtTick0 + ticks * this._secsPerTick);
    }
    return end;
  }

  // A lane's duty, in sixteenths (chips/rp2a03.js).
  _psgSetDuty(psgCh, v, when) {
    this._psgDuty[psgCh] = Math.max(0, Math.min(16, Number(v) || 0));
    this._psgWrites(this._lane(psgCh, (e, ch) => e.duty?.(ch, this._psgDuty[psgCh], when) ?? []), when);
  }


  // A wave onto a lane's channel memory, where it is named — under a note
  // too (a chip that loads it with the channel off, the PC Engine's, turns it
  // back on in the same writes: the wave starts over from its first step).
  _writeLaneWave(lane, data, when) {
    this._psgWrites(this._lane(lane, (e, ch) => e.wave(ch, this._fitWave(lane, data), when)), when);
  }
  // A wave longer than the lane's memory (a 64-step def-wave on a 32-step
  // chip): every other step (the compiler says so, W_TARGET).
  _fitWave(lane, data) {
    const len = this._toneEnc[lane]?.part?.waveLen ?? WAVE.len;
    return data.length > len ? data.filter((_, i) => i % (data.length / len) === 0) : data;
  }

  // A def-wave (metadata.waves) by its index: the lane plays it from `when`.
  // A macro's step naming the wave the lane already plays writes nothing, so
  // a held step does not start the wave over every frame.
  _writeLaneWaveIndex(lane, index, when, step = false) {
    const wave = this._ir?.metadata?.waves?.[Math.round(index)];
    if (!wave || (step && this._laneWave[lane] === wave.name)) return;
    this._laneWave[lane] = wave.name;
    this._writeLaneWave(lane, this._drawnWaves.get(wave.name) ?? wave.data, when);
  }

  // A lane's wave expression, evaluated with its slots as they are at `when`.
  _writeWaveExpr(lane, when) {
    const x = this._laneExpr[lane];
    const v = waveEval(x.tree, (name) => this._resolveSrc(name, when));
    const data = waveSteps(Array.isArray(v) ? v : new Array(WAVE.len).fill(v));
    this._writeLaneWave(lane, data, when);
  }

  // A wave expression's frame `f`, as work at the frame's head (before its
  // events: its slots as the frame before left them): written where one
  // moved since (a host's setVal, a def-val sweep) — at most once a frame,
  // as the driver would. The frames go on while the expression is the
  // lane's, never keeping a run alive.
  _waveExprFrame(lane, x, f) {
    const t = this._frameOrigin + f / 60;
    this._step(f, KEYED, t, () => {
      if (this._laneExpr[lane] !== x) return;
      const vals = x.slots.map((n) => this._resolveSrc(n, t));
      if (vals.some((v, k) => v !== x.vals[k])) {
        x.vals = vals;
        this._writeWaveExpr(lane, t);
      }
      this._waveExprFrame(lane, x, f + 1);
    }, null, true);
  }

  /** The def-wave lane `lane` last played, or null. */
  laneWave(lane) {
    return this._laneWave[lane] ?? null;
  }

  // Write attenuation for a PSG channel.
  // attReg: 0=max volume, 15=silent (hardware convention). A sounding SSG
  // lane on the envelope (:env) has the envelope for its level.
  // The lane's silence: the last step of its part's ladder (the PSG's 15,
  // the PC Engine's 31), which `_psgSetAtt` takes as the key-off.
  _psgOff(psgCh) {
    return (this._psgLevel[psgCh]?.steps ?? 16) - 1;
  }
  _psgSetAtt(psgCh, attReg, when) {
    // A level ahead (a gate's end) is its time's to write: the lane's
    // sounding flag and its encoder see the song in order.
    if (this._isAhead(when)) return void this._at(when, () => this._psgSetAtt(psgCh, attReg, when), KEYED);
    const off = this._psgOff(psgCh);
    const att = Math.max(0, Math.min(off, attReg | 0));
    // Track sounding state so master/vol recomputes don't un-silence idle channels.
    this._psgSounding[psgCh] = att < off;
    const env = att < off && this._psgEnv[psgCh] >= 0;
    this._psgWrites(this._lane(psgCh, (e, ch) => (env ? e.envLevel(ch) : e.att(ch, att, when)), att === off), when);
  }

  // The SSG envelope's period for a cycle of `shape` at `hz`, moved `semi`
  // semitones and `detune` register steps.
  _writeEnvPeriod(hz, { shape = -1, semi = 0, detune = 0 }, when) {
    if (hz > 0) this._psgWrites(this._psg((c) => c.envPeriod?.(hz * 2 ** (semi / 12), shape, detune) ?? [], "envPeriod"), when);
  }
  // A lane's own envelope moves, for the period it writes.
  _envBy(lane) {
    return { shape: this._psgEnv[lane], semi: this._envSemi[lane], detune: this._envDetune[lane] };
  }

  // Compose vel (0-15) / vol / master (0-31) into a PSG attenuation (0=loud,
  // 15=silent) via the same additive dB-offset model as FM, quantized once to
  // the 16-step attenuator as the driver does. vol or master 0 is a hard mute.
  // A PSG lane's attenuation, 0 loud .. 15 off, on its part's level ladder.
  _composePsgAtt(psgCh, vel, vol, master) {
    master = this._handMaster() ?? master;
    const level = this._psgLevel[psgCh];
    if (!level || vol <= 0 || master <= 0) return this._psgOff(psgCh); // no such lane here: silent
    if (level.scale === "linear") // a linear volume (the SCC's), upside down
      return level.steps - 1 - Math.round(levelGain({ vel, faders: [vol, master] }) * (level.steps - 1));
    return levelSteps(level, { vel, faders: [vol, master] });
  }

  // The driver frame (0 = the song's start) an event at audio time `when`
  // runs in. The driver takes a tick as the frame's tempo accumulator crosses
  // it, so an event runs in the frame its NEXT tick starts in, less one — not
  // simply the frame its time falls in. Sweeps step on these frames: a
  // sweep's k-th frame is its start frame + k, written at that frame's time.
  _eventFrame(when) {
    return Math.ceil((when - this._frameOrigin) * 60 + this._secsPerTick * 60 - 1e-6) - 1;
  }

  // Set noise configuration (FB + NF bits) for PSG noise channel (ch 3).
  // modeVal: 0-7 encoding FB(1bit) + NF(2bits) → bits 5-3 of noise register
  _psgSetNoiseCfg(modeVal, when, lane) {
    this._psgWrites(this._psg((c) => c.noise(modeVal, when), null, lane), when);
  }

  // Set tone period for a PSG tone channel (ch 0-2): the note through the
  // channel's `:snap` mask, the cents on top (as _writeFmNote).
  _psgSetPitch(psgCh, note, cents, when) {
    const hz = midiToHz(snapNote(note, this._psgSnap[psgCh] ?? 0) + cents / 100);
    const midi = snapNote(note, this._psgSnap[psgCh] ?? 0) + cents / 100;
    // A chip the driver plays has its rule (pitchPeriod); the rest, the pitch's own.
    this._psgWrites(this._lane(psgCh, (e, ch) => e.tone(ch, e.pitchPeriod ? e.pitchPeriod(midi) : e.period(hz), when)), when);
    // `:env-rate note`: the envelope's period on this lane's pitch.
    this._psgHz[psgCh] = hz;
    if (this._envFollow === psgCh) this._writeEnvPeriod(hz, this._envBy(psgCh), when);
  }

  // Trigger the noise channel, re-asserting the current persistent noise mode.
  _psgTriggerNoise(when, lane) {
    this._psgSetNoiseCfg(this._psgNoiseMode, when, lane);
  }

  _dispatchPsgEvent(ev, when) {
    const psgCh = ev._psgCh ?? 0;

    switch (ev.cmd) {
      case "NOTE_ON": {
        // The note's path is every voice's (_playNote).
        // The PSG's noise lane is unpitched — but for a noise whose note is
        // its rate (the 2A03's: `rateNote`), pitched as a tone.
        const rateNote = this._isNoiseLane(psgCh) && this._toneEnc[psgCh]?.part?.rateNote;
        const isNoise = this._isNoiseLane(psgCh) && !rateNote;
        const site = `psg:${psgCh}`;
        this._playNote(ev, when, {
          level: site, vel: Math.max(0, Math.min(15, ev.args?.vel ?? 15)), pitch: isNoise ? null : site,
          key: (n) => this._psgNoteKey(ev, when, psgCh, isNoise, rateNote, n),
        });
        break;
      }

      // A word, every way it is written (_word).
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        // A wave expression with a $slot (`expr`) is written now and again
        // in each frame its slots have moved (_waveExprFrame).
        if (ev.args?.expr && String(ev.args.target).toUpperCase() === "WAVE") {
          this._laneWave[psgCh] = null;
          const slots = [...waveSlots(ev.args.expr)];
          const vals = slots.map((n) => this._resolveSrc(n, when));
          const x = (this._laneExpr[psgCh] = { tree: ev.args.expr, slots, vals });
          this._writeWaveExpr(psgCh, when);
          this._waveExprFrame(psgCh, x, this._eventFrame(when) + 1);
          break;
        }
        this._word(ev, when, this._psgWord(psgCh, String(ev.args?.target ?? "").toUpperCase()));
        break;

      default:
        break;
    }
  }

  // An FM note's key-on (_playNote's adapter): its level and pitch written
  // from their onset — an fm3 operator's level its own TL, its pitch written
  // by its FM3_OP_PITCH unless its macros' first steps moved it — its
  // timbre's envelopes, and its key; returning what closing is on it and
  // what a :keyon retrigger is.
  // Velocity, vol and master compose into the carriers' TL from each
  // operator's voiced TL (vel 15 / vol 31 / master 31 the voiced level);
  // vol or master 0 keys nothing (TL 127 is not silent at sustain), vel
  // never mutes — it floors at its lowest ladder step.
  _fmNoteKey(ev, when, ch, fm3Op, n) {
    const { ti, gate } = n;
    const isFm3OpNote = fm3Op > 0;
    if (isFm3OpNote) {
      // The note's span, CSM's level key (_fm3OpTl); its end is its close's.
      this._fm3Op[fm3Op - 1].csmOn = when;
      this._fm3Op[fm3Op - 1].csmOff = Infinity;
      this._writeFm3OpTl(fm3Op, when);
    } else this._writeFmLevel(ch, when);

    // An encoder that reads whether a write is inside a note (the OPLL's)
    // hears of the key-on before the note's pitch and voice macros go out,
    // which are sent ahead of it (chips/ym2413.js).
    if (!isFm3OpNote && !ev.args?.legato && !this._csmKeysCh3(ch) && !this._fmNoteSilent(ch, when))
      this._fmWrites(this._fmEnc.noteOn?.(ch, when) ?? [], when);

    // The pitch it sounds from, written once (the driver's onset_pitch).
    if (!isFm3OpNote || n.pitchMoved()) this._ptWrite(isFm3OpNote ? `fm3op:${fm3Op}` : `fm:${ch}`, when);
    // Its macros on its channel's words (_noteMacro): its pan, its timbre's
    // envelopes (fm_tl1 → FM_TL1 …, chips/fm-words.js).
    for (const [key, target] of OP_MACRO_MAP) {
      this._noteMacro(ev.args?.[key], n, when, target === "PAN" ? (v, t) => this._setPan(`fm:${ch}`, v, t)
        : (v, t) => this._applyParam(ch, { cmd: "PARAM_SET", args: { target, value: v } }, t), { runsOn: target === "PAN" });
    }

    // A note at vol or master 0 keys nothing: it keys the channel off
    // instead, the previous note may have left its key-off to this one (a
    // muted track's note does as much, _playNote's _silence).
    const keys = !this._fmNoteSilent(ch, when);
    if (!keys && !isFm3OpNote && !this._csmKeysCh3(ch)) this._fmKey(ch, 0, when);
    // What closing the note is on its voice (_closeNote): at its gate's end,
    // a rest, the track's end, the host's key-off — and at the track's next
    // note, which a slur, or a hold, carries over into.
    const opBit = isFm3OpNote ? 0x10 << (fm3Op - 1) : 0, csmOn = this._csmKeysCh3(ch);
    const carries = (how) => how.next && (gate.hold || (how.legato && how.keys));
    const close = !isFm3OpNote ? (t, how) => {
      // (Under CSM, Timer A keys CH3: a note keys nothing to key off.)
      if (!keys || csmOn || carries(how)) return;
      // The next note's key-off goes an ordering margin ahead of its key-on,
      // so the envelope sees the transition it attacks from.
      if (how.next) return void this._fmKey(ch, 0, t - KEY_ORDER_EPS_SECS);
      this._fmKey(ch, 0, Math.max(t, when + 0.001)); // never before its key-on
    } : (t, how) => {
      if (!keys || carries(how)) return;
      if (this._reg27 & 0x80) {
        // CSM: the key is the level — the host's key-off releases it; at the
        // next note TL 127 there, before its own level; else after its level
        // macros' release.
        if (how.host) return void this._fm3CsmRelease(opBit, t);
        if (!how.next) return void this._csmMute(fm3Op, t, when, ti);
        this._fm3Op[fm3Op - 1].csmOff = t;
        return void this._fmWrites(this._fmEnc.ch3Tl(fm3Op - 1, 127), t);
      }
      // The host's key-off drops its key-ons still waiting; a gate's close
      // is an edge in the frame's order (_fm3Edge).
      if (how.host) return void this._fm3KeysOff(opBit, t);
      this._fm3Edge(opBit, t, this._eventFrame(t), 0, ti, false, null);
    };
    if (!keys) return { close };
    let keyMask = this.getOpMask(ch);
    if (ev.args?.opMask !== undefined) {
      const eventMask = Number(ev.args?.opMask);
      if (!Number.isFinite(eventMask)) throw new Error(`Invalid NOTE_ON opMask: ${ev.args?.opMask}`);
      keyMask = eventMask & 0xf0;
      if (keyMask === 0) throw new Error(`Invalid NOTE_ON opMask nibble: ${eventMask}`);
    }
    const gap = this._retrigGap(n.retrigs);
    if (isFm3OpNote && this._reg27 & 0x80) {
      // CSM: Timer A keys CH3 (driver.md §9), so the operator's key is its
      // level — on at its note (written above), TL 127 at its close. A
      // :keyon retrigger is moot: every Timer A overflow is one.
      this._fm3Op[fm3Op - 1].csmOff = Infinity;
      return { close };
    }
    if (isFm3OpNote) {
      // This operator's key merged with the other FM3 operators sharing
      // channel 3's $28 (_fm3Edge); a :keyon retrigger re-attacks it alone.
      const bit = keyMask & 0xf0, op = Math.log2(bit) - 4, gen = this._fm3KeyGen[op];
      this._fm3Edge(bit, when, this._eventFrame(when), 0, ti, true, gen);
      return {
        close,
        retrigger: (t) => {
          const F = this._eventFrame(t);
          this._fm3Edge(bit, Math.max(when, t - gap), F, 1, op, false, gen);
          this._fm3Edge(bit, t, F, 1, op, true, gen);
        },
        tailOff: (t) => this._fm3Edge(bit, t, this._eventFrame(t), 0, ti, false, null),
      };
    }
    // The previous note's key-off came first (_closeNote, at this note's
    // dispatch); a slur cancelled it, so the envelope carries over: it keys
    // nothing. Under CSM Timer A keys CH3, and its retriggers.
    const csmKeys = this._csmKeysCh3(ch);
    if (!ev.args?.legato && !csmKeys) this._fmKey(ch, keyMask, when);
    if (csmKeys) return { close };
    return {
      close,
      // a drum roll, an echo tail: each keys the channel off and on again
      retrigger: (t) => {
        if (this._csmKeysCh3(ch)) return;
        this._fmKey(ch, 0, Math.max(when, t - gap));
        this._fmKey(ch, keyMask, t);
      },
      tailOff: (t) => { if (!this._csmKeysCh3(ch)) this._fmKey(ch, 0, t); },
    };
  }

  // A tone lane's note's key-on (_playNote's adapter): the chip's key, the
  // lane's LFO and envelope started over, its noise mode, its pitch from its
  // onset, its register macros (pan, wave, duty, the SSG's mixer and noise
  // period), its level from its onset; returning what closing is on it and
  // what a :keyon retrigger is (the LFO's reset). `isNoise`: the PSG's noise
  // lane, unpitched; `rateNote`: a noise whose note is its rate (the 2A03's),
  // pitched as a tone, its mode re-asserted.
  _psgNoteKey(ev, when, psgCh, isNoise, rateNote, n) {
    // A note starting: a chip that keys something on it hears it.
    this._psgWrites(this._lane(psgCh, (e, ch) => e.keyOn?.(ch, when, !!ev.args?.legato) ?? []), when);
    // A DDA note on this channel (another of its names) still sounding
    // ends here, its channel off a key-order lead before this key-on.
    if (this._toneEnc[psgCh]?.part?.sharePrio != null && this._ddaEncoder()) {
      const h = this._chipPcm?.owner.get(`dda-${this._toneEnc[psgCh].ch}`);
      if (h && h.t < when - 1e-9 && h.end > when + 1e-9 && !h.dumped) { h.end = when; h.cut = true; }
    }

    const { ti, gate } = n;
    // A :keyon retrigger restarts the note's envelopes (_envRetrigs: PSG has
    // no hardware one, that is the whole of it) — and with :lfo-sync, as the
    // note's key-on does, starts the chip's LFO over (the PC Engine's $09
    // reset, the FDS's counter).
    const sync = this._laneLfoSync[psgCh] && !ev.args?.legato;
    const resetLfo = (t) => this._psgWrites(this._lane(psgCh, (e, ch) => e.lfoReset?.(ch) ?? []), t);
    if (sync) resetLfo(when);
    const retrigger = (t) => { if (sync) resetLfo(t); };
    // Its macros on the lane's words (_noteMacro).
    const mode = (v, t) => this._psgSetNoiseCfg(this._snapMacroOutput("NOISE_MODE", v), t, psgCh);
    if (rateNote) {
      // Its mode re-asserted, and the note's :mode macro, as the PSG's
      // noise has them; its rate is the pitch below.
      this._psgTriggerNoise(when, psgCh);
      this._noteMacro(ev.args?.noise_mode, n, when, mode);
    }
    // Its pitch as on FM (_pt): from its onset, written once.
    if (!isNoise) this._ptWrite(`psg:${psgCh}`, when);
    else {
      this._psgTriggerNoise(when, psgCh);
      this._noteMacro(ev.args?.noise_mode, n, when, mode);
    }
    // The SSG's mixer and its (song-wide) noise period stepped by the
    // note's `:mode` / `:noise-rate` macros, frame by frame. A macro is
    // its note's: after one, a note without it has the track's :mode and
    // the song's :noise-rate back.
    const mixMacro = ev.args?.ssg_mix, rateMacro = ev.args?.noise_rate;
    const was = this._ssgMacroed[psgCh];
    if (was?.mix && !mixMacro && this._ssgMixBase[psgCh] != null)
      this._psgWrites(this._lane(psgCh, (e, ch) => e.mix?.(ch, this._ssgMixBase[psgCh], when) ?? []), when);
    if (was?.rate && !rateMacro && this._noiseRateBase != null)
      this._psgWrites(this._psg((c) => c.noiseRate?.(this._noiseRateBase) ?? [], "noiseRate"), when);
    this._ssgMacroed[psgCh] = mixMacro || rateMacro ? { mix: !!mixMacro, rate: !!rateMacro } : null;
    // A note's (macro :pan …) where the channel has a pan of its own; its
    // def-waves a step at a time; a pulse's duty (chips/rp2a03.js); the SSG's
    // mixer and noise period, written where they move.
    this._noteMacro(ev.args?.pan, n, when, (v, t) => this._setPan(`psg:${psgCh}`, v, t), { runsOn: true });
    if (ev.args?.wave) this._laneExpr[psgCh] = null;
    this._noteMacro(ev.args?.wave, n, when, (v, t) => this._writeLaneWaveIndex(psgCh, v, t, true));
    this._noteMacro(ev.args?.duty, n, when, (v, t) => this._psgSetDuty(psgCh, v, t));
    this._noteMacro(mixMacro, n, when, (v, t) => this._psgWrites(this._lane(psgCh, (e, ch) => e.mix?.(ch, v, t) ?? []), t), { moved: true });
    this._noteMacro(rateMacro, n, when, (v, t) => this._psgWrites(this._psg((c) => c.noiseRate?.(v) ?? [], "noiseRate"), t), { moved: true });
    // A lane on the envelope starts it over at a key-on (a slur's goes on).
    const envShape = this._psgEnv[psgCh];
    if (envShape >= 0 && !ev.args?.legato)
      this._psgWrites(this._psg((c) => c.envShape?.(envShape) ?? [], null, psgCh), when);
    const velMacro = ev.args?.velMacro ?? null;
    // What closing the note is on its lane (_closeNote): silence —
    // after its level macros' release where it has them (its soft
    // envelope) — at its gate's end, a rest, the track's end, the host's
    // key-off; nothing at the track's next note, whose key-on restarts
    // the level (`~` holds the tone over). Until then the lane is keyed.
    const macros = !!(velMacro || ev.args?.vol);
    const close = (t, how) => {
      if (how.next) return;
      this._psgKeyedUntil[psgCh] = Math.min(this._psgKeyedUntil[psgCh], t);
      this._psgSilence(psgCh, ti, macros, t);
    };
    this._psgKeyedUntil[psgCh] = gate.timed ? gate.end : Infinity;
    // Its level from its onset (_playNote).
    this._psgRecompose(psgCh, when);
    return { close, retrigger };
  }

  // Whether a note at `when` keys nothing: its channel's vol or the master
  // at 0 (a vol is volume, so 0 mutes; vel never does).
  _fmNoteSilent(ch, when) {
    const regs = this._chRegs[ch];
    return Math.round(this._lv(`fm:${ch}`).vol) === 0
      || (this._masterVol ?? VOL_UNITY) === 0;
  }

  // The ROM rhythm's encoder (hit, level, dump; chips/ym2608.js): the FM
  // encoder's own where the rhythm shares its chip's state (the OPLL's),
  // else the chip's.
  _rhythmEncOf(target) {
    const part = target.parts.find((p) => p.kit);
    if (!part) return null;
    const chip = target.chipFor(part.name);
    return (chip === this._fmChip ? this._fmEnc.rhythm : null) ?? chip?.rhythm ?? null;
  }

  // The operators a channel's level is: its algorithm's carriers, or the
  // encoder's where the chip has one algorithm (the OPLL's op2).
  _carrierOps(regs) {
    return this._fmEnc.carriers ?? fmCarrierOpsForAlg(regs.algorithm ?? 0);
  }

  // FM writes, through the target's FM encoder (chips/). An encoder that
  // keeps state is told each write's time too — the player sends a note's
  // key-off as the note starts, ahead of the writes between — and may hand
  // back a write of an earlier time, as its fourth element (chips/ym2413.js).
  _fmWrites(writes, when) {
    for (const [port, addr, data, at] of writes) this._write(port, addr, data, at ?? when);
  }
  _fmKey(ch, mask, when) {
    // A key ahead (a gate's key-off, a retrigger) is its time's to write.
    if (this._isAhead(when)) return void this._at(when, () => this._fmKey(ch, mask, when), KEYED);
    // A key-on under :lfo-sync — an operator keyed that was not: a note, a
    // :keyon retrigger, an fm3-N operator — starts the LFO over just ahead.
    const rising = mask & ~(this._fmKeyMask[ch] ?? 0) & 0xf0;
    this._fmKeyMask[ch] = mask;
    // The channel the DAC shares (fm6): its key-on takes it back from PCM.
    // At the note's own time, not ahead of it: a PCM note at the same time
    // dispatched before it (an earlier track) writes there too, and the later
    // write takes the DAC, as in the driver's frame.
    if (rising && ch === this._dacShareCh && this._dacOn && when != null) {
      this._dacOn = false;
      this._write(0, 0x2b, 0, when);
    }
    if (rising && this._chRegs[ch]?.lfoSync && when != null) {
      const writes = this._fmEnc.lfoReset?.(this._lfoRate) ?? [];
      writes.forEach(([p, a, d], i) => this._write(p, a, d, when - (writes.length - i) * LFO_RESET_GAP));
    }
    this._fmWrites(this._fmEnc.key(ch, mask, when), when);
  }
  // One operator register, from the channel's shadow state.
  _fmOp(ch, opIdx, reg, when) {
    this._fmWrites(this._fmEnc.op(ch, opIdx, reg, this._chRegs[ch].ops[opIdx], when), when);
  }

  _initDefaultVoices() {
    // No PSG note is sounding at the start of a run; clear the flags so the
    // master/vol preamble writes don't drone idle channels.
    this._psgSounding.fill(false);
    // A chip's own start (chips/: the YM2608's $29, its rhythm and SSG),
    // before any voice is written; an optional chip's, at its first write
    // (_lane).
    this._chipsStarted.clear();
    for (const chip of Object.values(this._target.chips))
      if (!chip.optional) for (const [p, a, d] of chip.init ?? []) this._write(p, a, d);
    this._fmEnc.reset?.(); // an encoder that keeps the chip's state starts over
    this._sharedChannels();
    for (const enc of this._queuedEncoders()) enc.reset?.();
    this._waveLfo = {}; // a wave chip's LFO words as last written (a sweep with no :from starts there)
    // Every channel starts on `init-fm`, the part's sine (chips/fm-words.js
    // fmInitVoice): the OPN's ALG 7, FB 0, all four operators AR 31, DR 0,
    // SL 0, RR 15, TL 0, MUL 1, DT 0 — the driver's boot patch (driver.md
    // §5.4) — or the OPLL's.
    const init = fmInitVoice(this._target.parts.find((p) => p.kind === "fm"));
    for (let ch = 0; ch < this._fmEnc.channels; ch++) {
      const regs = this._chRegs[ch];

      regs.algorithm = init.get("FM_ALG") ?? 7;
      regs.feedback = init.get("FM_FB") ?? 0;
      this._fmWrites(this._fmEnc.alg(ch, regs));
      // Stereo: both, the LFO sensitivities 0
      this._fmWrites(this._fmEnc.pan(ch, { pan: 0, ams: 0, fms: 0 }));

      for (let slot = 0; slot < 4; slot++) {
        const o = { tl: 0, ar: 31, dr: 0, d2r: 0, sl: 0, rr: 15, mul: 1, dt: 0, rs: 0, amen: 0, ssg: 0, dt2: 0 };
        for (const [word, v] of init) {
          const m = /^(FM_[A-Z]+?_?)(\d)$/.exec(word);
          if (!m || Number(m[2]) !== slot + 1) continue;
          const field = fmOpWord(m[1])?.field;
          if (field && field !== "velK") o[field] = v;
        }
        regs.ops[slot] = o;
        for (const reg of ["dt-ml", "tl", "ks-ar", "am-dr", "sr", "sl-rr", "ssg-eg", "voice"]) this._fmOp(ch, slot, reg);
      }
    }
    // Globals, matching the driver's boot patch (driver.md §5.4).
    this._fmWrites(this._fmEnc.lfo(0)); // LFO off
    if (this._fmEnc.csm) this._fmWrites(this._fmEnc.mode(0)); // CH3 normal mode, timers off
    if (this._target.hasPart("dac")) {
      this._write(0, 0x2a, 0); // DAC data 0 — the DAC is off; the engine feeds it
      this._write(0, 0x2b, 0); // DAC off: fm6 is FM until a PCM note claims it
      this._dacOn = false;
    }
  }
}

// The player's parts, each a module of its own (see each file's head): their
// methods are IRPlayer's, as a class body's are — not enumerable.
for (const part of [workMethods, panelMethods, keyMethods, wordMethods, macroMethods, levelMethods, sampleMethods])
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(part)))
    Object.defineProperty(IRPlayer.prototype, name, { ...d, enumerable: false });

