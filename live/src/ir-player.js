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

import {
  clampForTarget,
  toSlotValue,
  midiToHz,
  pitchToMidi,
  snapNote,
  velFine,
  velK,
  levelOffset,
  levelSteps,
  levelGain,
  VOL_UNITY,
  sampleSweepPhase,
  sampleCurveUnit,
  buildChannelRegState,
  fmCarrierOpsForAlg,
  KEY_OFF_LEAD_SECS,
  KEY_ORDER_EPS_SECS,
  HOLD_FRAMES,
  expandLoops,
  WAVE,
  waveEval,
  waveSlots,
  waveSteps,
} from "./ir-utils.js";
import { TARGETS, TONE_LANES, toneLaneOf, targetProfile, notYet } from "./targets.js";
import {
  curveId, curveUnit8, sweepValue, sweepStep, sweepFrameValue,
  bpmToTickIncrement, tickIncrementToBpm,
} from "./mmb.js";
import { engineImage } from "./engine-images.js";
import { ROM_SOUND_SEC } from "./chips/rhythm-rom.js";
import { PCM8_RATE, PCM8_VOICES } from "./chips/msm6258.js";
import { DDA_RATE, ddaStep } from "./chips/huc6280.js";
import { dmcRate, dmcRates, dmcLevels, dmcEncode } from "./chips/rp2a03.js";
// A held DDA note (:len 0) with no next note: how long its sample is written.
const DDA_HOLD_SEC = 30;
// The DMC's sample is loaded this far ahead of its key-on: before the
// frame's writes start it, after the previous hit has all but ended.
const DMC_LOAD_LEAD_SECS = 0.0005;
import { FM_CHANNEL_WORDS, FM_OP_WORDS, FM_OPS, opWords, fmInitVoice, fmOpWord } from "./chips/fm-words.js";
// The largest point a PCM point target can name: the bank's usable window
// (export-mmb.js PCM_LOOP_MAX — the same clamp the MMB exporter applies).
const PCM_LOOP_MAX = 0x7f00;
// The most FM channels a target has (targets/: the OPM's eight); a
// channel's shadow state and per-channel arrays are this long whatever the
// chip.
const FM_CHANNELS = Math.max(
  ...Object.values(TARGETS).map((t) => t.chipForKind("fm")?.fmEncoder().channels ?? 0));
// The player's cores, by a part's kind (chips/parts.js): the FM core, the PSG
// core and the sample core. The PSG core plays the tone lanes (targets.js
// toneLaneOf), each through its chip's encoder: the PSG's tones at 0-2 and
// its noise at 3 (chips/: psgEncoder), the wave channels from 4 (waveEncoder).
// A part of another kind has no core yet.
// A MIDI channel has no chip to write (chips/midi.js): the `none` core keeps
// its events on the clock and writes nothing.
const CORE_OF_KIND = { fm: "fm", tone: "psg", noise: "psg", wave: "psg", sample: "sample", midi: "none" };
const PSG_LANES = TONE_LANES; // the PSG core's
// The sample core's handler for each sample part: the chips' own voices (the
// YM2608's rhythm and ADPCM-B, the OPLL's rhythm), PCM8's mix, the Mega
// Drive driver's DAC mix.
// Where a PSG or sample track's song-wide LFO write goes: the FM core's
// channel 0, as the driver takes it from any track.
const FM_LFO_ROUTE = { core: "fm", part: null, lane: 0 };
const SAMPLE_HANDLERS = {
  rhythm: "_dispatchRhythmEvent",
  "opll-rhythm": "_dispatchRhythmEvent",
  "adpcm-b": "_dispatchAdpcmEvent",
  pcm8: "_dispatchPcm8Event",
  "pce-dda": "_dispatchDdaEvent",
  "fc-dpcm": "_dispatchDpcmEvent",
  dac: "_dispatchDacEvent",
  "midi-drums": "_dispatchNothing",
};
// A frame's order (driver.md §4): the places work takes in it (IRPlayer._at).
const KEYED = 0, SWEEP = 1, MACRO = 2, SONG = 3, AFTER = 4; // (AFTER: what follows a frame's steps — a PCM retrigger)
// Channel 3's shared $28 in FM3 mode, then its CSM operators' levels: the
// frame's edges once every write to them is known (_scheduleFm3OpKey), each
// at its own time.
const FM3_KEYS = 5, FM3_TL = 6;
// The chips' own sample voices (_chipPcmFrame): each frame's level, pitch
// and samples, once the frame's steps are done, at the frame's start.
const VOICES = 7;
// The phases whose writes keep their own time (_runWork).
const UNSHIFTED = new Set([KEYED, FM3_KEYS, FM3_TL, VOICES]);
// The words that are the song's, not a channel's: one slot each, stepped
// after every channel's in a frame (SONG).
const SONG_WORDS = new Set(["MASTER", "LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE", "NOISE_RATE", "ENV_RATE"]);
// The writes that free a sweep's slot (driver.md §4 step 3).
const SLOT_FREEING = new Set(["PARAM_SET", "PARAM_SWEEP", "PARAM_SWEEP_STOP"]);
// The song-wide LFO words: the OPN's rate, the OPM's own (chips/ym2151.js).
const LFO_TARGETS = new Set(["LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE"]);
// The song's LFO words a wave chip's encoder takes (chips/huc6280.js, fds.js).
const WAVE_LFO_WORDS = { LFO_FREQ: "lfoFreq", LFO_PMD: "lfoPmd", LFO_WAVE: "lfoTable" };
// The song-wide words the panel takes in hand by a gate (IRPlayer.hold): a
// score event's word, or null. (MASTER is a level: laid over, _handMaster.)
const HAND_PARAMS = new Set(LFO_TARGETS);
// A score event that writes a track's :vol: the word, or a note's :vol macro.
const writesVol = (ev) => (ev.cmd.startsWith("PARAM_") ? String(ev.args?.target ?? "").toUpperCase() === "VOL"
  : (ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") && ev.args?.vol != null);
function handWordOf(ev) {
  if (ev.cmd === "TEMPO_SET" || ev.cmd === "TEMPO_SWEEP") return "tempo";
  if (!ev.cmd.startsWith("PARAM_")) return null;
  const t = String(ev.args?.target ?? "").toUpperCase();
  return HAND_PARAMS.has(t) ? t : null;
}
// `:lfo-sync`'s reset is the LFO stopped and run again (chips/opn-fm.js,
// ym2151.js `lfoReset`): each write this far apart, the last this far ahead
// of the key, so the chip clocks between them — a write lands on an output
// sample (the synths' renderInto), and two on one would never reset it.
const LFO_RESET_GAP = 1e-4;
// Half a millisecond: late enough to sort after every event of its frame,
// far too early to hear.
const PCM_SWEEP_AFTER = 0.0005;
// A PCM note's points (language.md §16): its loop (:loop-*) and its range (:pcm-*).
const PCM_POINT_TARGETS = new Set(["LOOP_START", "LOOP_END", "LOOP_LEN",
  "RANGE_START", "RANGE_END", "RANGE_LEN"]);

// The curve names the driver computes as written (driver.md §8); a sweep on
// one of these previews the driver's integer steps (_sweepAt).
const DRIVER_SWEEP_CURVES = new Set([
  "linear", "ease-in", "ease-in-quad", "ease-out", "ease-out-quad",
  "ease-inout", "ease-inout-quad", "sin", "triangle", "square", "saw", "ramp",
]);

// The tracks a playback takes from the IR: the song's (every track but an
// effect's part), or one effect's parts alone — renumbered, since a track's
// index is its id here.
// The NOTE_ON macro args _scheduleFmOpMacros runs, keyed as makeNoteArgs
// writes them (fm_tl1 → FM_TL1). :vel and :vol are the note's level, scheduled
// with it (_scheduleFmLevelMacros); these are the channel's other targets.
const OP_MACRO_MAP = [
  ["pan", "PAN"],
  // The FM family's (chips/fm-words.js): a macro's key is its word lower-cased.
  ...[...FM_CHANNEL_WORDS, ...opWords(FM_OP_WORDS.filter((w) => !w.inline))].map((w) => [w.word.toLowerCase(), w.word]),
];

// An FM operator target's field in the shadow register file (_readParam):
// the table's, the TL's being the voiced level the composition starts from.
const OP_REG_FIELD = Object.fromEntries(
  FM_OP_WORDS.filter((w) => !w.inline).map((w) => [w.word.slice(3), w.word === "FM_TL" ? "voicedTl" : w.field]));

export function songOrEffectIr(ir, se) {
  const tracks = (ir?.tracks ?? []).filter((t) => (se == null ? !t.se : t.se?.index === se));
  if (tracks.length === (ir?.tracks ?? []).length) return ir;
  return { ...ir, tracks: tracks.map((t, i) => ({ ...t, id: i })) };
}

// Whether a macro's first step writes nothing: a leading wait, a hold step, or
// an empty attack/sustain (`[#rel …]`).
function macroLeadsWithHold(spec) {
  if (spec?.type === "steps") return spec.releaseIndex === 0 || spec.steps?.[0] == null;
  const first = spec?.type === "stages" ? spec.stages?.[0] : spec;
  if (!first) return false;
  return (
    (spec.type === "stages" && !first.curve) ||
    !!first.waitKeyOff || Number(first.waitFrames ?? 0) > 0 || Number(first.waitTicks ?? 0) > 0
  );
}

// A tempo as the driver runs it: its tick increment, read back (the driver
// has no fractional BPM — 120 is an increment of 819, 119.97 BPM).
function drvBpm(bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? tickIncrementToBpm(bpmToTickIncrement(bpm)) : bpm;
}

// Control-flow and timing events do not represent a sounding position, so they
// must not move the editor playhead highlight. Without this, a zero-duration
// loop (e.g. `#loop (go loop)` with no notes) fires MARKER/JUMP at the
// scheduler's max rate and the highlight flickers on `go` / `#loop`.
const PLAYHEAD_SKIP_CMDS = new Set([
  "MARKER",
  "TRIG",
  "JUMP",
  "LOOP_BEGIN",
  "LOOP_END",
  "TEMPO_SET",
  "TEMPO_SWEEP",
  // Implicit: CSM_ON rides the first note, and CSM_OFF closes the track with
  // the whole track form as its src — highlighting it boxes the entire track.
  "CSM_ON",
  "CSM_OFF",
]);
// Integer GCD/LCM, used to size the VGM loop window to the common period of
// independently-looping tracks. Guards against zero/garbage durations.
function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

// Scaled-macro sample (language.md §7.0): `(sample × depth) >> 8`, depth =
// slot low byte (0..255), toward zero. Kept byte-identical with drv-player's
// copy and the sequencer's scale_macro_sample so all three players agree.
function scaleMacroSample(sample, slotValue) {
  const depth = (slotValue & 0xff) >>> 0;
  const mag = (Math.abs(sample) * depth) >> 8;
  return sample < 0 ? -mag : mag;
}

function lcm(a, b) {
  a = Math.max(1, Math.round(a));
  b = Math.max(1, Math.round(b));
  const g = gcd(a, b);
  return g ? (a / g) * b : a;
}

// The FM encoder of a target with no FM (the MSX's PSG alone): no channels,
// so nothing reaches it but the run's globals.
const NO_FM = { channels: 0, csm: false, isKeyOn: () => false, lfo: () => [] };

// ---------------------------------------------------------------------------
// IRPlayer
// ---------------------------------------------------------------------------
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
    this._markStep = null; // (step, time) => void — _scheduleMacro's marks, while it asks
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
    // model the worklet runs (src/pcm-voices.js) — so this side only forwards
    // the score's events, in time order.

    this._psgCurrentMidi = new Array(PSG_LANES).fill(60); // last NOTE_ON midi per PSG ch
    this._psgPitchOffset = new Array(PSG_LANES).fill(0); // cents offset per PSG ch
    this._psgSnap = new Array(PSG_LANES).fill(0); // `:snap` mask per PSG ch
    // A NOTE_PITCH sweep is scheduled whole at dispatch, leaving the pitch
    // offsets above at its END value. A glide sweep is emitted just before its
    // note's NOTE_ON (same tick), so that note must start from the sweep's
    // FIRST value instead — else its onset write lands on the target pitch for
    // a frame before the slide begins. Keyed "fm:ch" / "psg:ch" / "op:n".
    this._levels = new Map(); // a voice's level, by its site ("fm:0", "fm3op:1", "psg:0" …): _lv
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
    this._laneExpr = new Array(PSG_LANES).fill(null); // a lane's wave expression with $slots: { tree, slots, vals, nextFrame }
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
    this._holdChannels = new Map();

    // FM3 independent-operator mode: each fm3-1..fm3-4 track keys a single
    // operator of channel 3 via the shared 0x28 key register (see
    // _scheduleFm3OpKey).
    this._resetFm3Keys();
    // FM3 independent-OP: each operator's own note, sticky :pitch offset
    // and level (index = op − 1) — what its F-number and TL are written
    // from (driver.md §13.4).
    this._fm3Op = Array.from({ length: FM_OPS }, () => ({
      midi: 60, offset: 0,
    }));

    // Per FM channel: a full-gate note has run up to the next note and left its
    // key-off for that note's dispatch to write (driver: `pendingOff`).
    this._pendingKeyOff = new Array(FM_CHANNELS).fill(false);

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
    this._valSweeps = {}; // name → the score's running sweep of that slot
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

    this._resetFm3Keys();
    // FM3 independent-OP: each operator's own note, sticky :pitch offset
    // and level (index = op − 1) — what its F-number and TL are written
    // from (driver.md §13.4).
    this._fm3Op = Array.from({ length: FM_OPS }, () => ({
      midi: 60, offset: 0,
    }));
    this._pendingKeyOff.fill(false);

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
      this._writeKeyOff(ch);
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
    this._levels.clear();
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
    this._laneExpr?.fill(null); // a wave expression is its run's (_waveExprFrames)
    this._psgPan?.fill(0);
    this._psgDuty?.fill(8);
    this._laneLfoSync?.fill(false);
    this._fmKeyMask = new Array(FM_CHANNELS).fill(0); // each FM channel's key bits as last written (_fmKey)
    this._pcmPointNow = null;
    this._reg27 = 0; // FM3 special / CSM mode
    this._fm3Ops = false;
    this._csmHold = false; // a rate rest stopped Timer A (driver.md §9)
    this._psgCurrentMidi.fill(60);
    this._psgPitchOffset.fill(0);
    this._psgSnap.fill(0);
    this._psgNoiseMode = 0b1_00;
    this._psgEnv.fill(-1);
    this._envFollow = null;
    this._envSemi.fill(0);
    this._envDetune.fill(0);
    this._psgHz.fill(0);
    this._ssgMixBase.fill(null);
    this._noiseRateBase = null;
    this._ssgMacroed.fill(null);
    this._holdChannels.clear();
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
  seek(audioContext, { sec = null, line = null } = {}) {
    if (!this._ir) throw new Error("No IR loaded");
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
    for (let ch = 0; ch < this._fmEnc.channels; ch++) this._writeKeyOff(ch);
    for (let psgCh = 0; psgCh < PSG_LANES; psgCh++) this._psgSetAtt(psgCh, this._psgOff(psgCh), at);
    for (let v = 0; v < pcmVoices; v++) this._pcmEv(at, { kind: "off", voice: v });
    this._silenceChipPcm(at);

    this._audioContext = audioContext;
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
      this._resetFm3Keys();
      this._fm3Op = Array.from({ length: FM_OPS }, () => ({
        midi: 60, offset: 0,
      }));
      this._pendingKeyOff.fill(false);
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
   * not playing (nothing is sounding yet).
   */
  _applyAudibility() {
    const ctx = this._audioContext;
    if (!ctx) return;
    const when = ctx.currentTime;
    // FM: key off an inaudible channel — unless another audible track shares it
    // (FM3 operator mode routes several tracks through channel 3's 0x28).
    const audibleFm = new Set();
    for (const [ti, ch] of this._lanesOf("fm")) {
      if (this._isTrackAudible(ti)) audibleFm.add(ch);
    }
    for (const [ti, ch] of this._lanesOf("fm")) {
      if (this._isTrackAudible(ti) || audibleFm.has(ch)) continue;
      this._fmKey(ch, 0, when);
    }
    // An FM3 operator track that went silent while channel 3 still sounds for
    // another: key off its operator alone, and drop its queued key-ons.
    let fm3Off = 0;
    this._ir?.tracks?.forEach((t, ti) => {
      const op = /^fm3-([1-4])$/.exec(t.scoreChannel ?? "")?.[1];
      if (op && !this._isTrackAudible(ti)) fm3Off |= 0x10 << (op - 1);
    });
    if (fm3Off && this._reg27 & 0x80) this._fm3CsmRelease(fm3Off, when);
    else if (fm3Off && this._fm3Mask & fm3Off) {
      this._fm3Held &= ~fm3Off;
      this._fm3KeysOff(fm3Off, when);
    }
    // PSG: force silent attenuation on an inaudible channel.
    for (const [ti, psgCh] of this._lanesOf("psg")) {
      if (!this._isTrackAudible(ti)) this._psgSetAtt(psgCh, this._psgOff(psgCh), when);
    }
    // The DAC mix has no key: release an inaudible track's voice (its loop ends).
    for (const [ti, voice] of this._lanesOf("sample", "dac")) {
      if (!this._isTrackAudible(ti)) this._pcmEv(when, { kind: "off", voice });
    }
    // CSM: Timer A keys CH3, so muting the CSM voice holds the timer instead.
    if (this._reg27 & 0x80) this._writeReg27(when);
    // The chips' own sample voices: dump a rhythm sound, stop the ADPCM-B.
    const adpcm = this._target?.chipFor?.("adpcm-b")?.adpcm;
    for (const [voice, h] of this._chipPcm?.owner ?? []) {
      if (this._isVoiceAudible(voice)) continue;
      // A PCM8 voice is cut from the mix.
      if (h?.pcm8 != null) { this._pcm8Ev(when, { kind: "cut", voice: h.pcm8 }); continue; }
      // A DDA channel stops, and its hit is fed no more frames.
      if (h?.dda != null) {
        h.dumped = true;
        for (const [p, a, d] of this._ddaEncoder()?.off(h.dda) ?? []) this._write(p, a, d, when);
        continue;
      }
      if (voice !== "adpcm" && !this._rhythmEnc) continue; // a sample voice this player cannot dump
      const writes = voice === "adpcm" ? adpcm.stop() : this._rhythmEnc.dump(voice, when);
      for (const [p, a, d] of writes) this._write(p, a, d, when);
    }
    // The 2A03's DMC: its track muted, the sample stops.
    const dmc = this._target?.chipFor?.("fc-dpcm")?.dmc;
    if (dmc) for (const [ti] of this._lanesOf("sample", "fc-dpcm"))
      if (!this._isVoiceTrackAudible(ti, "dpcm")) for (const [p, a, d] of dmc.stop()) this._write(p, a, d, when);
  }

  // ---- the panel's controls ----
  // A control is one thing the panel shows and can take in hand:
  //   { id: "tempo" | "MASTER" | "LFO_RATE" …, kind: "word", word }   a song-wide word
  //   { id: "vol:fm1", kind: "vol", strip }                            a strip's :vol
  //   { id: "reg:0:FM_TL1", kind: "reg", ch, word }                    an FM channel's register word
  //   { id: "val:cutoff", kind: "val", name }                          a value slot
  // The players answer three calls for any of them (DrvPlayer has the same):
  // hold — `value` sounds now and is the control's while it is held; release
  // — let go, it stays until the score next writes it; read — what it is
  // now. A run starts with the score's own values (play, seek).
  //
  // Two mechanisms carry a hand here. A level — a strip's :vol, MASTER — is
  // laid over: the score's own runs on unheard, and wherever a level is
  // composed the panel's value stands in (_handVol, _handMaster), so letting
  // go has the score's to come back to. A word, a register and a slot are
  // gated: the score's writes of one in hand are skipped (_scoreWrites), at
  // their own time — a sweep's and a macro's frames wait for it (_at) — and
  // the state is the panel's until the score takes it back.
  //
  // The player's state is the song at its cursor (the last horizon), and the
  // chip is behind it by the lookahead: what the run has already sent plays
  // out under a hand just taken. So the panel's write is made twice — now,
  // and again where the sent writes end (_writeCursor) — and a hand has the
  // chip to itself within the lookahead.

  /** The panel takes `c` in hand at `value`. */
  hold(c, value) {
    if (c.kind === "vol") return this._holdVol(c.strip, value);
    if (c.word === "MASTER") {
      this._masterHand = { v: Math.max(0, Math.min(31, Math.round(value))), held: true };
      this._levelsNow();
      return;
    }
    const h = this._hands.get(c.id);
    if (h) h.held = true;
    else this._hands.set(c.id, { held: true });
    this._panelWrite = true;
    try {
      if (c.kind === "val") this.setVal(c.name, value);
      else if (c.word === "tempo") this._setTempoNow(value);
      else {
        const ch = c.kind === "reg" ? c.ch : 0;
        this.setParam(c.word, value, ch);
        const sent = this._sentUntil();
        if (sent != null) this.setParam(c.word, value, ch, sent);
      }
    } finally {
      this._panelWrite = false;
    }
  }

  /** The panel lets go of `c`: its value stays until the score writes it. */
  release(c) {
    if (c.kind === "vol") return this._releaseVol(c.strip);
    const h = c.word === "MASTER" ? this._masterHand : this._hands.get(c.id);
    if (h) h.held = false;
  }

  /**
   * `c` now, as the panel shows it. `hand`: the panel's value is in force
   * (held, or let go and not yet written over); `score`, for a level (a
   * strip's :vol, MASTER), is the score's value under it.
   * @returns {{ v: number, hand: boolean, score?: number } | null}
   */
  read(c) {
    if (c.kind === "vol") return this._volOf(c.strip);
    const when = this._audioContext?.currentTime ?? 0;
    if (c.word === "MASTER") {
      const score = this._masterVol ?? VOL_UNITY;
      return { v: this._masterHand ? this._masterHand.v : score, hand: !!this._masterHand, score };
    }
    const hand = this._hands.has(c.id);
    if (c.kind === "val") {
      const v = this.getVal(c.name);
      return v == null ? null : { v, hand };
    }
    if (c.kind === "reg") return { v: this._readParam(c.ch, c.word), hand };
    switch (c.word) {
      case "tempo": return { v: this._bpm, hand };
      case "LFO_RATE": return { v: this._lfoRate ?? 0, hand };
      default: {
        // The machine's LFO words: a wave chip's own where it has one, else the OPM's.
        const wave = this._toneEnc.some((l) => l?.enc.lfoFreq) ? WAVE_LFO_WORDS[c.word] : null;
        const opm = { LFO_FREQ: "freq", LFO_PMD: "pmd", LFO_AMD: "amd", LFO_WAVE: "wave" }[c.word];
        if (wave && wave !== "lfoTable") return { v: this._waveLfo[wave] ?? 0, hand };
        return opm ? { v: this._opmLfo?.[opm] ?? 0, hand } : null;
      }
    }
  }

  // Where the writes the run has sent end, while it plays: the time the
  // panel's write is made again (hold), after the last of them.
  _sentUntil() {
    return this._playing && Number.isFinite(this._writeCursor) ? this._writeCursor : null;
  }

  // The panel's MASTER, or null: laid over the score's wherever a level is composed.
  _handMaster() {
    return this._masterHand ? this._masterHand.v : null;
  }

  // Every level recomposed, after the panel moved MASTER: now, and where the
  // sent writes end.
  _levelsNow() {
    const now = this._playing ? this._audioContext?.currentTime : undefined;
    for (const when of [now, this._sentUntil()]) if (when !== null) this._recomposeLevels(when);
  }

  /** The value slots whose value is the panel's now, name → value. */
  valsInHand() {
    const out = {};
    for (const id of this._hands.keys()) if (id.startsWith("val:")) out[id.slice(4)] = this.getVal(id.slice(4));
    return out;
  }

  // A score write of the control `id`: skipped while it is held; let go, the
  // score takes it back.
  _scoreWrites(id) {
    const h = this._hands.get(id);
    if (!h) return true;
    if (h.held) return false;
    this._hands.delete(id);
    return true;
  }

  // ---- a strip's :vol in the panel's hand ----
  // A strip is its channels (`heads`) and the tracks on them, and for a
  // chip's sound several tracks share (the YM2608's rhythm) that sound, its
  // `voice`. Its level's site comes from the channels, so a player with no
  // tracks (the keys' while stopped) takes the hand as well. Held, the strip's level is
  // composed with the panel's value wherever the score's :vol goes in — the
  // score's own :vol writes run on unheard, so letting go has them to come
  // back to; let go, the value stays until the score writes :vol (a value, a
  // sweep, a note's :vol macro) on one of the strip's tracks.

  // `value` (0-31) sounds now, the score's :vol unheard while held.
  // strip: { heads: string[], tracks: number[], voice?: string }
  _holdVol(strip, value) {
    const sites = this._volSites(strip);
    if (!sites.length) return;
    let hand = this._lv(sites[0]).hand;
    if (!hand) {
      hand = { tracks: new Set(strip.tracks), sites };
      for (const site of sites) this._lv(site).hand = hand;
    }
    // Strips that share a site (the fm3 parts on channel 3) share its hand.
    for (const ti of strip.tracks ?? []) hand.tracks.add(ti);
    hand.v = Math.max(0, Math.min(31, Math.round(value)));
    hand.held = true;
    const sent = this._sentUntil();
    for (const site of sites) {
      this._levelNow(site, this._playing ? this._audioContext?.currentTime : undefined);
      if (sent != null) this._levelNow(site, sent);
    }
  }

  // Let go: it stays until the score writes :vol there.
  _releaseVol(strip) {
    const site = this._volSites(strip)[0];
    const hand = site && this._lv(site).hand;
    if (hand) hand.held = false;
  }

  // A strip's :vol now: the panel's while in hand, else the score's, its
  // :vol macro's included — and the score's either way (`score`).
  _volOf(strip) {
    const site = this._volSites(strip)[0];
    if (!site) return null;
    const when = this._audioContext?.currentTime ?? 0;
    const [kind, at] = site.split(":");
    const n = Number(at);
    const score = Math.round(kind === "fm" || kind === "fm3op" || kind === "psg" || kind === "pcm" ? this._lvScoreVol(this._lv(site))
      : kind === "midi" ? this._lvScoreVol(this._lv(`mtrk:${strip.tracks[0]}`))
      : this._lv(`strk:${strip.tracks[0]}`).vol);
    const hand = this._lv(site).hand;
    return { v: hand ? hand.v : score, hand: !!hand, score };
  }

  // Where a strip's level is composed: an FM channel, a PSG lane, a Mega
  // Drive PCM voice, a chip's sample voice.
  _volSites(strip) {
    if (strip.voice != null) return [`voice:${strip.voice}`];
    const sites = new Set();
    for (const head of strip.heads ?? []) {
      // A MIDI channel's :vol, the drums' too, is its output's (midi-output.js),
      // which reads the hand.
      if (this._target?.name === "midi") {
        sites.add(`midi:${head}`);
        continue;
      }
      const c = this._target.channels[head];
      const core = c && CORE_OF_KIND[c.part.kind];
      // An fm3 part's :vol is its operator's own (driver.md §13.4).
      const op = /^fm3-([1-4])$/.exec(head);
      if (op) sites.add(`fm3op:${op[1]}`);
      else if (core === "fm") sites.add(`fm:${c.voice}`);
      else if (core === "psg") sites.add(`psg:${toneLaneOf(c)}`);
      else if (core === "sample") sites.add(c.part.mixVoice ? `voice:${c.part.mixVoice(c.voice)}` : `pcm:${c.voice}`);
    }
    return [...sites];
  }

  // The panel's :vol at a level's site, or null.
  _handVol(site) {
    return this._levels.get(site)?.hand?.v ?? null;
  }

  // A score write of :vol on track `ti` takes a strip the panel let go back.
  // A Mega Drive PCM voice keeps its fader in the engine's model, where the
  // panel's value went: it gets the score's back (a note's :vol macro would
  // not say it).
  _volTakeBack(ti, when) {
    for (const hand of new Set([...this._levels.values()].map((L) => L.hand))) {
      if (!hand || hand.held || !hand.tracks.has(ti)) continue;
      for (const site of hand.sites) {
        this._lv(site).hand = null;
        const [kind, n] = site.split(":");
        if (kind === "pcm") this._pcmEv(when, { kind: "vol", voice: Number(n), value: this._lv(site).vol });
      }
    }
  }

  // A level recomposed at `when` (now when absent), after the panel moved
  // it: an FM channel, a keyed PSG lane, a Mega Drive PCM voice; a chip's
  // sample voice its sounding hit's (_chipPcmWrite).
  _levelNow(site, when) {
    const [kind, at] = site.split(":");
    const n = Number(at);
    if (kind === "fm") {
      if (n === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(n, when);
    } else if (kind === "fm3op") {
      if (this._fm3Ops) this._writeFm3OpTl(n, when);
    } else if (kind === "psg") {
      // A fader move must never un-silence an idle lane into a tone. A run
      // knows a lane keyed at its cursor, not at the chip's now: its level
      // moves where the sent writes end. Stopped, the keys' lane is live.
      if (this._playing && !this._lv(site).key && !(when != null && when >= this._writeCursor - 1e-9)) return;
      if (this._psgKeyed(n, when)) this._psgRecompose(n, when);
    } else if (kind === "pcm") this._pcmEv(when ?? 0, { kind: "vol", voice: n, value: this._handVol(site) });
    else if (kind === "voice") this._chipPcmWrite(at, when ?? this._audioContext?.currentTime ?? 0, true);
  }

  // ---- the keys ----
  // Live's keys play the score's machine through this player: a channel of
  // the running song they take over, or, stopped, the panel's own player. A
  // key's level is a note's: its velocity composed with its lane's :vol and
  // the master as the panel shows them (the score's, or the panel's hand), so
  // a key sounds at what is shown. `when` is now when absent.

  /** The machine's name, and its FM encoder (chips/) for a key's own writes. */
  machine() {
    return this._target.name;
  }
  fmEncoder() {
    return this._fmEnc;
  }
  /** The machine's ROM rhythm encoder, for a key's hit; null without one. */
  rhythmEncoder() {
    return this._rhythmEnc ?? null;
  }
  /** The seconds a tick lasts at the tempo now. */
  secsPerTick() {
    return this._secsPerTick;
  }
  /** The chips' resting voices, written now (a player made for the keys). */
  initVoices() {
    this._initDefaultVoices();
  }

  /**
   * A tone lane keyed at `midi` (a noise lane triggered). At `vel` (0-15);
   * without one at the level the lane has — its last note's velocity — as an
   * FM key without one sounds at its channel's level.
   */
  keyTone(lane, midi, vel = null, when = this._keyNow()) {
    if (this._isNoiseLane(lane)) this._psgTriggerNoise(when, lane);
    else this._psgSetPitch(lane, midi, 0, when);
    const L = this._lv(`psg:${lane}`);
    this.keyToneLevel(lane, vel ?? L.liveVel ?? L.vel, when);
  }
  /** A keyed tone lane's level at `vel` — a wave role's envelope steps it. */
  keyToneLevel(lane, vel, when = this._keyNow()) {
    // The key has the lane's level until it is let go (_lvVel); the song's
    // note there stays the song's, and has the lane back then.
    this._lv(`psg:${lane}`).key = { vel: Math.max(0, Math.min(15, vel)) };
    this._psgRecompose(lane, when);
  }
  /** The velocity a key holds the lane at (keyTone), 15 with none held. */
  keyToneVel(lane) {
    return this._lv(`psg:${lane}`).key?.vel ?? 15;
  }
  keyToneOff(lane, when = this._keyNow()) {
    this._lv(`psg:${lane}`).key = null;
    this._psgSetAtt(lane, this._psgOff(lane), when);
  }

  /** An FM channel's carriers at a key's `vel`, composed as a note's are, until keyFmOff. */
  keyFmLevel(ch, vel, when = this._keyNow()) {
    this._lv(`fm:${ch}`).key = { vel };
    this._writeFmLevel(ch, when);
  }
  /** The key on the channel let go: its level is the song's note's again. */
  keyFmOff(ch) {
    this._lv(`fm:${ch}`).key = null;
  }
  /** An OPN's CH3 in its special mode: every operator at `midi`, as one voice. */
  keyFm3Unison(midi) {
    for (let op = 1; op <= 4; op++) this._writeFm3OpPitch(op, midi, 0);
  }
  /**
   * A patch for a channel the keys borrow from the song, as writes (the
   * song's shadow stays the song's): its carriers at `vel` composed as a
   * note's on that channel are — its :vol and the master as shown — or at
   * the voiced level without one; the channel's own pan.
   */
  keyPatchWrites(ch, regs, vel, when = this._keyNow()) {
    const fm = this._fmEnc;
    const carriers = this._carrierOps(regs);
    const vol = this._lvVol(this._lv(`fm:${ch}`));
    const ops = regs.ops.map((o, i) => {
      const voiced = o.voicedTl ?? o.tl ?? 0;
      const tl = vel != null && carriers.includes(i)
        ? this._carrierTl({ voicedTl: voiced, velK: o.velK }, vel, vol, this._handMaster() ?? this._masterVol ?? VOL_UNITY)
        : voiced;
      return { ...o, tl: tl & 0x7f, rs: o.rs ?? 0, ar: o.ar ?? 0, d2r: o.d2r ?? 0, ssg: o.ssg ?? 0 };
    });
    // The OPLL's encoder keeps the song's voice as timelines: a held
    // channel's patch goes past them (chips/ym2413.js `held`).
    if (fm.held) return fm.held.patch(ch, { ...regs, ops }, ops[carriers[0]]?.tl);
    const out = [];
    ops.forEach((op, i) => {
      for (const reg of ["dt-ml", "tl", "ks-ar", "am-dr", "sr", "sl-rr", "ssg-eg"]) out.push(...fm.op(ch, i, reg, op));
    });
    out.push(...fm.alg(ch, regs));
    out.push(...fm.pan(ch, { pan: this._chRegs[ch]?.pan ?? 0, ams: regs.ams ?? 0, fms: regs.fms ?? 0 }));
    return out;
  }

  _keyNow() {
    return this._audioContext?.currentTime;
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
    if (!this._holdChannels.has(key)) return;
    const tIdx = this._holdChannels.get(key);
    this._holdChannels.delete(key);
    const when = this._audioContext?.currentTime ?? 0;
    this._resumeHeldTrack(tIdx, when);
    const { core, part, lane: ch } = this._routes.get(tIdx);
    if (core === "sample") {
      // PCM: the key-off releases a `:len 0` loop; its tail plays out.
      if (part.name === "pcm8") this._pcm8Ev(when, { kind: "off", voice: ch });
      else this._pcmEv(when, { kind: "off", voice: ch });
    } else if (core === "psg") {
      // PSG channels: silence by setting attenuation to 15 (max att = silent)
      this._psgKeyedUntil[ch] = Math.min(this._psgKeyedUntil[ch], when);
      this._psgSetAtt(ch, this._psgOff(ch), when);
    } else {
      if (ch === 2 && this._fm3Held) {
        // Release only the held FM3 operators; any timed operators stay keyed.
        const held = this._fm3Held;
        this._fm3Held = 0;
        if (this._reg27 & 0x80) {
          this._fm3CsmRelease(held, when); // CSM: the key is the level (§9)
        } else {
          this._fm3KeysOff(held, when);
        }
      } else {
        this._fmKey(ch, 0, when);
      }
    }
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
  _commitSwap() {
    const { irObj, boundaryTick, boundaryTime } = this._pendingSwap;
    this._pendingSwap = null;
    this._scheduleCapTime = Infinity;

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
    for (const ch of [...this._holdChannels.keys()]) this.triggerKeyOff(ch);
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

  // The key a held note's channel is kept under in _holdChannels.
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
    // A wave expression follows its slots — and once the song is done, to
    // the end of its last note.
    this._waveExprFrames(done ? Math.max(horizon, this._songEndTime()) : settled);
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

  // ---- the frame's order ----
  // The driver renders a frame in a fixed order (driver.md §4): it dispatches
  // the frame's events, then steps each channel's engines — sweeps, then
  // macros — then the song's own sweeps. This player dispatches an event its
  // lookahead ahead of the chip, at the event's own time; what the event sets
  // going is work for later frames, and waits here (_at) keyed by its frame
  // and its place in that order:
  //
  //   KEYED  a timed part of a dispatch (a gate's key-off), at its time
  //   SWEEP  a channel's sweep step        MACRO  a macro's step
  //   SONG   a song-wide sweep's step (MASTER, the LFO)
  //
  // A frame's work runs once every event of that frame is dispatched, in that
  // order, and reads the player's state as it is then — the state is the
  // song's at its cursor, never a forecast. What it writes is stamped no
  // earlier than the frame's last event, so the chip takes the frame as the
  // driver makes it: dispatch, then engines.
  //
  // A plain write ahead of the run (_write) waits by its time and goes out
  // as the run reaches it, so nothing is with the chip's queue (the
  // worklet's) further ahead than the lookahead.

  /** A register write (port, addr, data) or a message ({ type, when, … }), at `when` — now when absent. */
  _write(portOrMsg, addr, data, when) {
    const msg = portOrMsg && typeof portOrMsg === "object" && !Array.isArray(portOrMsg);
    let t = msg ? portOrMsg.when : when;
    // Work of a frame writes after that frame's events (_runWork): what it
    // writes at its own time or ahead of it (a key-off's lead) moves with it.
    if (t != null && this._stampShift && t <= this._stampFrom + 1e-9) {
      t += this._stampShift;
      if (msg) portOrMsg = { ...portOrMsg, when: t };
      else when = t;
    }
    // On a frame-clocked target a write's time is its frame's (_sink).
    if (t != null && this._target?.frameClock) t = this._frameTime(t);
    if (t == null || t <= this._writeCursor) this._sink(portOrMsg, addr, data, when);
    else this._putAhead({ t, write: [portOrMsg, addr, data, when] });
  }

  // `run` at time `t`: now when the run has reached `t`, else as work of
  // `t`'s frame, in `phase`'s place in the frame's order.
  _at(t, run, phase = MACRO) {
    if (t == null || t <= this._writeCursor) run();
    else this._putWork(this._eventFrame(t), phase, t, run);
  }

  // `run` as work of frame `F`, whatever the time: a sweep's step waits for
  // its frame's events even in the frame it is dispatched in.
  // `endless`: one of a chain that ends only when something frees it (a
  // loop curve's steps) — a run does not wait for those to be done.
  _step(F, phase, t, run, ord = null, endless = false) {
    this._putWork(F, phase, t, run, ord, endless);
  }

  // Whether `when` is still ahead of the run: what composes a write from the
  // player's state (a level, a register word) waits for it then (_at), and
  // reads the state — and the panel's hand — as it is at that time.
  _isAhead(when) {
    return when != null && when > this._writeCursor;
  }

  // `ord`: within its frame and phase, the place the item takes — a list
  // compared in turn (FM3_KEYS: the driver's order, _scheduleFm3OpKey); a
  // dispatch's timed parts by time; the rest in the order they were made.
  _putWork(F, phase, t, run, ord = null, endless = false) {
    const q = this._work;
    const item = { F, phase, t, run, ord, endless };
    if (!endless) this._workFinite++;
    const after = (x) => {
      if (x.F !== F) return x.F > F;
      if (x.phase !== phase) return x.phase > phase;
      if (phase === KEYED) return x.t > t;
      if (!ord) return false;
      for (let i = 0; i < ord.length; i++) if (x.ord[i] !== ord[i]) return x.ord[i] > ord[i];
      return false;
    };
    const later = after;
    let lo = this._workHead, hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (later(q[mid])) hi = mid;
      else lo = mid + 1;
    }
    if (lo === q.length) q.push(item);
    else q.splice(lo, 0, item);
  }

  // The run reaches an event of frame `F` at time `t` (or a pass's horizon):
  // the work before it runs — every earlier frame's, and this frame's timed
  // parts up to `t` — then the plain writes up to `t` go out.
  _advance(F, t) {
    const q = this._work;
    while (this._workHead < q.length) {
      const item = q[this._workHead];
      if (!(item.F < F || (item.F === F && item.phase === KEYED && item.t <= t))) break;
      if (F === Infinity && !this._workFinite) break; // only endless chains are left
      this._workHead++;
      if (!item.endless) this._workFinite--;
      this._runWork(item);
    }
    if (this._workHead > 1024 && this._workHead * 2 > q.length) {
      q.splice(0, this._workHead);
      this._workHead = 0;
    }
    this._sendAhead(t);
  }

  _runWork(item) {
    // No earlier than its frame's last event: the driver's engines follow its dispatch.
    // (An event's time runs up to a frame past the frame's own, the driver
    // dispatching the ticks ahead of it: the work stays within half a frame
    // of its time, so the next frame's keeps its distance.)
    const ts = !UNSHIFTED.has(item.phase) && this._lastEvent.F === item.F
      ? Math.max(item.t, Math.min(this._lastEvent.t, item.t + 0.49 / 60)) : item.t;
    this._sendAhead(ts);
    const was = [this._stampFrom, this._stampShift];
    this._stampFrom = item.t;
    this._stampShift = ts - item.t;
    try {
      item.run();
    } finally {
      [this._stampFrom, this._stampShift] = was;
    }
  }

  // Work a run waits for: all but the endless chains.
  _workLeft() {
    return this._workFinite > 0;
  }

  // The time every call to the chip's encoders before it has been made by:
  // the horizon, or — with a frame's work still waiting — just before the
  // earliest time that work can carry (an event's frame begins up to a tick
  // ahead of its time, _eventFrame).
  _settled(horizon) {
    if (this._workHead >= this._work.length) return horizon;
    const F = this._work[this._workHead].F;
    return Math.min(horizon, this._frameOrigin + F / 60 - this._secsPerTick - 1e-6);
  }

  _putAhead(item) {
    const q = this._ahead;
    let lo = this._aheadHead, hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid].t <= item.t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === q.length) q.push(item);
    else q.splice(lo, 0, item);
  }

  // The run reaches time `until`: the plain writes up to it go out.
  _sendAhead(until) {
    const q = this._ahead;
    while (this._aheadHead < q.length && q[this._aheadHead].t <= until) {
      const item = q[this._aheadHead++];
      if (item.t > this._writeCursor) this._writeCursor = item.t;
      this._sink(...item.write);
    }
    if (until > this._writeCursor) this._writeCursor = until;
    if (this._aheadHead > 1024 && this._aheadHead * 2 > q.length) {
      q.splice(0, this._aheadHead);
      this._aheadHead = 0;
    }
  }

  _dropAhead() {
    this._ahead.length = 0;
    this._aheadHead = 0;
    this._work.length = 0;
    this._workHead = 0;
    this._workFinite = 0;
    this._stampFrom = -Infinity;
    this._stampShift = 0;
    this._lastEvent = { F: -Infinity, t: -Infinity };
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
      this._tracks.every((t) => t.flatIndex >= t.events.length);
    // ...and the work of the frames before the horizon's own (its events may
    // not all be dispatched yet; with none left to dispatch, its own too).
    this._advance(this._eventFrame(horizon) + (dispatched ? 1 : 0), horizon);
    const done = dispatched && !this._workLeft() && this._aheadHead >= this._ahead.length;
    if (done) this._writeCursor = Infinity; // the run is over: what follows (a key, the panel) is written at once
    // Every event up to the horizon is dispatched, so the frames before the
    // horizon's own have all their FM3 key edges.
    return done;
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

      this._resetFm3Keys();
      // FM3 independent-OP: each operator's own note, sticky :pitch offset
      // and level (index = op − 1) — what its F-number and TL are written
      // from (driver.md §13.4).
      this._fm3Op = Array.from({ length: FM_OPS }, () => ({
        midi: 60, offset: 0,
      }));
      this._pendingKeyOff.fill(false);
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
          oneShot.every((t) => t.flatIndex >= t.events.length)
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
      // One-shot: end just after the last write so final releases ring out.
      endSec = (writes.length ? writes[writes.length - 1].sec : 0) + 0.05;
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

  // ---- a sweep ----
  // A sweep holds its word's slot and takes one step a frame from the frame
  // it is dispatched in (driver.md §4 step 3): a one-shot for its length,
  // its last step on its target; a loop curve until the slot is freed. A
  // step is made when the one before it has run — nothing of a sweep is
  // known ahead, so a track's loop that writes the word again starts it
  // over, and one from before the loop runs on through it, as the driver's.
  // `write(value, t)` moves the word. sw.valueAt / sw.timeOf: a sweep with
  // its own steps (a song rate's integers, a PCM point's).
  _runSweep(slot, phase, sw, write) {
    sw.next = 0;
    this._slots.set(slot, sw);
    const len = sw.loop ? Infinity : sw.baseFrames;
    const step = (i) => {
      const t = sw.timeOf ? sw.timeOf(i) : this._sweepFrameTime(sw, i);
      this._step(sw.startFrame + i, phase, t, () => {
        if (this._slots.get(slot) !== sw) return; // freed: a value, a sweep, a stop
        sw.next = i + 1;
        write(sw.valueAt ? sw.valueAt(i) : this._sweepAt(sw, i), t);
        if (this._slots.get(slot) !== sw) return;
        if (i + 1 < len) step(i + 1);
        else this._slots.delete(slot);
      }, null, sw.loop);
    };
    step(0);
  }

  // A word's sweep from any track: from where the word is (`cur`) unless it
  // names a :from (language.md §11), its length in frames — ticks at the
  // tempo of its start, or frames as written, or a slot's (by its :unit).
  _sweepWord(ev, when, cur, write) {
    const a = ev.args ?? {};
    const target = String(a.target ?? "").toUpperCase();
    const df = this._curveFields(a, when);
    const from = df.from != null ? Number(df.from) : cur;
    const sw = {
      from, to: Number(df.to ?? from), curve: a.curve ?? "linear", params: df.params,
      baseFrames: this._sweepLen(a, when), loop: !!a.loop,
      startWhen: when, startFrame: this._eventFrame(when),
    };
    this._runSweep(this._slotKey(ev, target), SONG_WORDS.has(target) ? SONG : SWEEP, sw, write);
    return sw;
  }
  _sweepLen(a, when) {
    return a.dyn?.len != null
      ? this._resolveLenFrames(a, null, when)
      : a.lenFrames
        ? Math.max(1, Math.round(Number(a.frames ?? 1)))
        : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
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
  _resetFm3Keys() {
    this._csmHoldSpans = []; // [start, end) in audio time: the rate track's rests
    this._fm3Mask = 0; // the operator bits $28 holds
    this._fm3Held = 0; // operators keyed by a hold (len 0) note
    this._fm3KeyLast = -Infinity; // the last $28 write's time
    this._fm3KeyGen = [0, 0, 0, 0]; // per operator: bumped to drop its key-ons still waiting
  }

  /**
   * Queue one FM3 operator note's key edges as its frames' work (FM3_KEYS),
   * in the driver's order: dispatch before macros, then track (a :keyon
   * retrigger: operator), then time, a key-off before a key-on at one time.
   * @param {number} opBit  operator key bit (0x10=OP1 … 0x80=OP4)
   * @param {number} onTime audio time of key-on
   * @param {number|null} offTime audio time of key-off, or null for a hold note
   * @param {{off: number, on: number}[]} retriggers :keyon re-attacks, in time order
   * @param {number} track  the note's track index (its dispatch order)
   */
  _scheduleFm3OpKey(opBit, onTime, offTime, retriggers, track) {
    const op = Math.log2(opBit) - 4;
    const gen = this._fm3KeyGen[op];
    const edge = (t, frame, phase, order, on) => this._step(frame, FM3_KEYS, t, () => {
      if (on && this._fm3KeyGen[op] !== gen) return; // dropped: a mute, a hold let go
      if (on) this._fm3Mask |= opBit;
      else this._fm3Mask &= ~opBit;
      // Never behind the previous write: the worklet applies them in time order.
      this._fm3KeyLast = Math.max(t, this._fm3KeyLast);
      this._fmKey(2, this._fm3Mask, this._fm3KeyLast);
    }, [phase, order, Math.round(t * 1e6), on ? 1 : 0]);
    edge(onTime, this._eventFrame(onTime), 0, track, true);
    // A full-gate note's key-off lands in the next note's dispatch, before its
    // key-on: same frame, same track, earlier in the order.
    if (offTime == null) this._fm3Held |= opBit;
    else edge(offTime, this._eventFrame(offTime), 0, track, false);
    for (const r of retriggers) {
      if (offTime != null && r.on >= offTime) break;
      const frame = this._eventFrame(r.on);
      edge(r.off, frame, 1, op, false);
      edge(r.on, frame, 1, op, true);
    }
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

  _resolveTiedLength(ev, baseLength) {
    const trackIndex = ev._trackIndex;
    if (trackIndex == null) return baseLength;

    const track = this._tracks[trackIndex];
    if (!track) return baseLength;

    let totalLength = baseLength;
    let expectedTieTick = ev.tick + baseLength;

    // A note ending exactly at the loop's JUMP continues at the loop start —
    // a TIE there extends it too (the compiler ties a `~` across the jump), so
    // the scan wraps once.
    const jumpTick = track.hasLoop ? track.loopStartTick + track.loopDuration : null;
    let i = track.flatIndex + 1;
    for (let wrapped = false; ; ) {
      let stopped = false;
      for (; i < track.events.length; i++) {
        const nextEv = track.events[i];
        if (nextEv.tick > expectedTieTick) { stopped = true; break; }
        if (nextEv.tick !== expectedTieTick || nextEv.cmd !== "TIE") continue;

        const tieLength = nextEv.args?.length ?? 0;
        totalLength += tieLength;
        expectedTieTick += tieLength;
      }
      if (stopped || wrapped || expectedTieTick !== jumpTick) break;
      wrapped = true;
      expectedTieTick = track.loopStartTick;
      i = track.loopStartIndex ?? 0;
    }

    return totalLength;
  }

  _expandLoops(events) {
    return expandLoops(events);
  }

  // `:target midi`'s levels as the score writes them, for the panel: a
  // track's :vol (a value, a sweep, `+` `*` `$slot`), and a note's :vol
  // macro, which takes the fader's place until the next note (the output's
  // plan does the same, export-midi.js); the song's :master is every
  // machine's (_masterEvent).
  _midiLevel(ev, when) {
    const ti = ev._trackIndex;
    if (ti == null) return;
    const site = `mtrk:${ti}`;
    if (ev.cmd.startsWith("PARAM_") && String(ev.args?.target ?? "").toUpperCase() === "VOL")
      this._word(ev, when, { read: () => this._lv(site).vol, write: (v) => this._lvSetVol(site, v) });
    else if (ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") {
      this._lvNoteOn(site, Number(ev.args?.vel ?? 15));
      if (ev.args?.vol) this._lvMacros(site, { vol: ev.args.vol }, when, this._resolveGateTicks(ev.args?.gate, ev.args?.length), Infinity);
    }
  }

  // A sample note's place in its def's points (setOnPosition): a `gate` or
  // `loop` note is let go at its gate, every note stopped by the next.
  _reportSample(ev, when) {
    const mode = ev.args.mode ?? "shot";
    const gateTicks = this._resolveGateTicks(ev.args.gate, ev.args.length);
    const off = mode === "shot" || !(gateTicks > 0) ? Infinity : this._timeAfterTicks(when, gateTicks);
    this._onPosition({ kind: "sample", name: ev.args.sample, when, mode, off, cut: this._nextNote(ev).secs });
  }

  _dispatchEvent(ev, when) {
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
    // MASTER is the song's, written on any track: one handler, whatever the
    // track's kind.
    if (ev.cmd.startsWith("PARAM_") && String(ev.args?.target ?? "").toUpperCase() === "MASTER") {
      this._masterEvent(ev, when);
      return;
    }
    if (this._dispatchGlobalEvent(ev, when)) return;
    if (ev.cmd === "PCM_NOTE_ON" && this._onPosition && ev.args?.sample && this._isTrackAudible(ev._trackIndex))
      this._reportSample(ev, when);
    // The chip's LFO is the song's, written on any track (language.md §1):
    // a PSG or PCM track's write goes where an FM track's does, as the
    // driver takes it from any track.
    const core = ev._route.core;
    // A wave chip with an LFO of its own (the PC Engine's, the FDS's
    // modulation) takes the song's LFO words it has: a value, or a sweep a
    // frame at a time; the FDS's table whole. Through its lane, so an
    // optional chip (the FDS) is started before its first write.
    // `+`, `*` and a `$value` (PARAM_ADD / _MUL / _FROM_VAL) are a value
    // read off the word as last written.
    const waveLfo = /^PARAM_/.test(ev.cmd) ? this._waveLfoRoute(ev.args?.target) : null;
    if (waveLfo) {
      const { word: lfoWord, write } = waveLfo;
      const cur = this._waveLfo[lfoWord] ?? 0;
      const a = ev.args ?? {};
      if (lfoWord === "lfoTable") { if (ev.cmd === "PARAM_SET") write(a.table ?? [], when); }
      else this._word(ev, when, {
        read: () => this._waveLfo[lfoWord] ?? 0,
        write: (v, t) => write((this._waveLfo[lfoWord] = Math.round(v)), t),
        sweep: () => this._sweepUnits(ev, when, cur, (v, t) => {
          // A sweep's step is a score write of the word at its own time.
          if (this._scoreWrites(String(ev.args.target).toUpperCase())) write((this._waveLfo[lfoWord] = v), t);
        }),
      });
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
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const fm3Op = Number(ev.args?.fm3Op);
        const isFm3OpNote =
          ch === 2 && Number.isInteger(fm3Op) && fm3Op >= 1 && fm3Op <= 4;
        const centOffset = this._onsetPitchOffset(ev, this._chRegs[ch]?.pitchOffset ?? 0);
        const baseLengthTicks = ev.args.length;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const gateTicks = this._frameGate(when, this._resolveGateTicks(ev.args?.gate, lengthTicks), lengthTicks);
        // Monophonic priority: macro tails (echo/retrigger/curve) are cut a
        // key-off lead before the next note on this channel, so they cannot
        // bleed onto it and the next note keeps its normal lead-in.
        const { secs: nextNote, legato: nextIsSlur } = this._nextNote(ev);
        const macroLimit = Number.isFinite(nextNote)
          ? nextNote - KEY_OFF_LEAD_SECS
          : Infinity;
        const regs = this._chRegs[ch];
        regs.currentMidi = midi;

        // Apply per-note velocity (and any vol/master) to carrier TL,
        // attenuating from each operator's voiced TL. Runs on every note so
        // static :vel works and a previously attenuated note is reset; vel 15
        // / vol 31 / master 31 restores the voiced level.
        // The previous note's level macros are done: this note starts from
        // its own velocity and the fader (its macros are sampled below).
        if (isFm3OpNote) {
          // FM3 independent-OP: the note's velocity is THIS operator's, and it
          // composes into that operator's own TL — not the channel's carriers,
          // which belong to the other operators too (driver.md §13.4).
          this._lvNoteOn(`fm3op:${fm3Op}`, ev.args?.vel ?? 15);
          // The note's span, CSM's level key (_fm3OpTl); its end is set once
          // the gate is resolved below.
          this._fm3Op[fm3Op - 1].csmOn = when;
          this._fm3Op[fm3Op - 1].csmOff = Infinity;
          this._writeFm3OpTl(fm3Op, when);
        } else {
          this._lvNoteOn(`fm:${ch}`, ev.args?.vel ?? 15);
          this._writeFmLevel(ch, when);
        }

        // An encoder that reads whether a write is inside a note (the
        // OPLL's) hears of the key-on before the note's pitch and voice
        // macros go out, which are sent ahead of it (chips/ym2413.js).
        if (!isFm3OpNote && !ev.args?.legato && !this._csmKeysCh3(ch)
          && this._isTrackAudible(ev._trackIndex) && !this._fmNoteSilent(ch, when))
          this._fmWrites(this._fmEnc.noteOn?.(ch, when) ?? [], when);

        // FM3 operator notes had their F-number written by FM3_OP_PITCH.
        const writesBasePitch = !isFm3OpNote;
        if (writesBasePitch) {
          // The note's pitch macros go first: when one's first sample lands
          // on the note, that is the pitch it sounds from, and the plain one is
          // never written — as the driver's note-on (onset_pitch) does.
          let onsetWritten = false;
          const basePitchWrite = (centOffset, t, semi = 0) => {
            if (Math.abs(t - when) < 1e-9) onsetWritten = true;
            this._writeFmNote(ch, midi + semi, centOffset, t);
          };
          const fmOffset = () => this._chRegs[ch]?.pitchOffset ?? 0;
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            gateTicks,
            basePitchWrite,
            macroLimit,
            fmOffset,
          );
          this._scheduleSemiMacro(
            ev.args?.note_semi,
            when,
            gateTicks,
            basePitchWrite,
            macroLimit,
            fmOffset,
          );
          // Write F-number high first (block + MSB), then low
          if (!onsetWritten) this._writeFmNote(ch, midi, centOffset, when);
        } else {
          // FM3 operator note: FM3_OP_PITCH already wrote this operator's
          // F-number with its sticky :pitch offset; its pitch / semi macros
          // write that operator's registers alone (driver.md §13.4).
          const opState = this._fm3Op[fm3Op - 1];
          opState.midi = midi;
          const fm3PitchWrite = (noteCentOffset, t, semi = 0) => {
            this._writeFm3OpPitch(fm3Op, midi + semi, noteCentOffset, t);
          };
          const fm3Offset = () => opState.offset;
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            gateTicks,
            fm3PitchWrite,
            macroLimit,
            fm3Offset,
          );
          this._scheduleSemiMacro(
            ev.args?.note_semi,
            when,
            gateTicks,
            fm3PitchWrite,
            macroLimit,
            fm3Offset,
          );
        }
        // A :keyon retrigger restarts the note's envelopes — level and timbre
        // (driver.md §13.2) — while its :pitch / :semi (scheduled above) and
        // :pan run on.
        this._envRetrigs = this._keyonRetrigTimes(ev.args?.keyon, when, gateTicks, macroLimit);
        this._lvMacros(isFm3OpNote ? `fm3op:${fm3Op}` : `fm:${ch}`, ev.args ?? {}, when, gateTicks, macroLimit);
        this._scheduleFmOpMacros(
          ch,
          ev.args ?? {},
          when,
          gateTicks,
          macroLimit,
        );
        this._envRetrigs = null;
        // Key on: all 4 operators (unless muted or vol=0).
        // YM2612: TL=127 gives totalAttn=1016 < 1023 (not silent at sustain),
        // so when a volume control is 0 we skip key-on entirely to guarantee
        // silence. vol and master are "volume": 0 mutes. (vel never mutes — it
        // floors at its lowest ladder step.)
        const isFmSilent = this._fmNoteSilent(ch, when);
        const secsPerTick = this._secsPerTick;
        // Key off at the gate boundary, always — on FM the key transition IS
        // the attack, so a note that ran into the next one without keying off
        // would swallow it. The one exception is a slur (`~`, NOTE_ON_EX bit3)
        // reaching this note at full gate: there the envelope is meant to
        // carry over.
        const gateEndSecs = this._timeAfterTicks(when, gateTicks);
        // `nextNote` is this tempo's projection of a future tick, so a tempo
        // sweep between here and there moves the real note-on. It decides which
        // of the two key-off paths below is taken — never a written time.
        const abutsNext =
          Number.isFinite(nextNote) && gateEndSecs >= nextNote - 0.001;
        const slursIntoNext = nextIsSlur && abutsNext;
        let offAt = gateEndSecs;
        if (offAt < when + 0.001) offAt = when + 0.001; // never before its key-on
        const offWhen = gateTicks > 0 && !slursIntoNext ? offAt : null;
        // A note the next one lands on keys off from that note's dispatch
        // instead (below), where its real time is known.
        const deferOff = gateTicks > 0 && !slursIntoNext && abutsNext;
        let keyonEnd = null;
        const keys = this._isTrackAudible(ev._trackIndex) && !isFmSilent;
        // A note that keys nothing (muted / non-soloed track, or vol 0) keys
        // the channel off instead: the previous note may have left its key-off
        // to this one, and if it was queued before a mute or solo landed it
        // would ring on forever.
        if (!keys && !isFm3OpNote) {
          this._pendingKeyOff[ch] = false;
          if (!this._csmKeysCh3(ch)) this._fmKey(ch, 0, when);
        }
        if (keys) {
          const hasEventMask = ev.args?.opMask !== undefined;
          let keyMask = this.getOpMask(ch);
          if (hasEventMask) {
            const eventMask = Number(ev.args?.opMask);
            if (!Number.isFinite(eventMask)) {
              throw new Error(`Invalid NOTE_ON opMask: ${ev.args?.opMask}`);
            }
            keyMask = eventMask & 0xf0;
            if (keyMask === 0) {
              throw new Error(`Invalid NOTE_ON opMask nibble: ${eventMask}`);
            }
          }
          if (isFm3OpNote && this._reg27 & 0x80) {
            // CSM: Timer A keys CH3 (driver.md §9), so the operator's key is
            // its level — on at its note (written above), TL 127 at its gate
            // or, as a PSG note, after its level macros' release has played
            // (a tail the next note cuts leaves the level to that note); a
            // hold note is released by triggerKeyOff. A :keyon retrigger is
            // moot: every Timer A overflow is one.
            const ends = this._lv(`fm3op:${fm3Op}`).ends;
            const muteAt = offWhen == null ? null : Math.max(offWhen, ...ends);
            this._fm3Op[fm3Op - 1].csmOff = muteAt ?? Infinity;
            if (muteAt == null) this._fm3Held |= keyMask & 0xf0;
            else if (muteAt < macroLimit - 1e-9)
              this._fmWrites(this._fmEnc.ch3Tl(fm3Op - 1, 127), Math.max(when, muteAt - KEY_ORDER_EPS_SECS));
          } else if (isFm3OpNote) {
            // Merge this operator's key with the other FM3 operators sharing
            // channel 3's 0x28 register instead of overwriting them. A :keyon
            // retrigger re-attacks THIS operator only (driver.md §13.4).
            this._scheduleFm3OpKey(
              keyMask & 0xf0,
              when,
              offWhen,
              this._fm3KeyonGaps(ev.args?.keyon, when, gateTicks, macroLimit),
              ev._trackIndex ?? 0,
            );
          } else {
            // The previous note ran up to this one at full gate and left its
            // key-off to us (driver: `pendingOff`). Write it first, an ordering
            // margin ahead, so the envelope sees the transition this note's
            // attack needs — the chip re-attacks because every register write
            // costs 48 internal cycles, twice the 24-cycle round in which it
            // latches key state (the driver gets the same guarantee from its
            // pair transport, which spaces writes 139 µs at its closest). A
            // slur cancels it: there the envelope carries over.
            const csmKeys = this._csmKeysCh3(ch);
            if (this._pendingKeyOff[ch]) {
              this._pendingKeyOff[ch] = false;
              if (!ev.args?.legato && !csmKeys)
                this._fmKey(ch, 0, when - KEY_ORDER_EPS_SECS);
            }
            // Legato slur (NOTE_ON_EX bit3): the frequency already moved above;
            // do not re-key so the envelope carries over from the previous note.
            if (!ev.args?.legato && !csmKeys) this._fmKey(ch, keyMask, when);
            // :keyon retrigger gate (drum roll / echo tail). FM3-op notes share
            // the 0x28 register so retrigger there is deferred. When active, the
            // keyon macro owns the channel's keying: its end time becomes the
            // final key-off (the note's own gate key-off is suppressed below so
            // it can't cancel the first retrigger that lands on the boundary).
            keyonEnd = this._scheduleKeyonMacro(
              ev.args?.keyon,
              keyMask,
              ch,
              when,
              gateTicks,
              macroLimit,
            );
          }
        }

        // Key-off at gate boundary (5ms lead for FM envelope decay)
        // gateTicks === 0 means hold indefinitely (len=0 note; KEY-OFF via triggerKeyOff())
        // FM3 operator notes schedule their own key-off via _scheduleFm3OpKey
        // above so simultaneous operators are not silenced together.
        if (gateTicks > 0) {
          if (!isFm3OpNote) {
            // With a keyon retrigger active, key off after the last retrigger
            // (keyonEnd) instead of at the gate, so the final tap isn't cut —
            // and never deferred, since that time is the macro's, not the
            // note's. A note that slurs into the next keys nothing off — its
            // gate never closes, so neither does the macro's.
            const keyOffAt = slursIntoNext ? null : keyonEnd != null ? keyonEnd : offWhen;
            if (keyonEnd == null && deferOff) this._pendingKeyOff[ch] = true;
            else if (keyOffAt != null && !this._csmKeysCh3(ch))
              this._fmKey(ch, 0, keyOffAt);
          }
        } else {
          // Hold note: register the channel for runtime key-off
          this._holdChannels.set(this._holdKey(ev), ev._trackIndex);
        }
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
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const st = this._fm3Op[op - 1];
        st.midi = midi;
        const offset = this._onsetPitchOffset(ev, st.offset);
        this._writeFm3OpPitch(op, midi, offset, when);
        break;
      }
    }
  }

  // PCM track dispatch. The worklet runs the driver's own voice model and
  // engine on the score's baked bank (worklet.js _applyPcmEvent), so what goes
  // across is the score's events — note, release, level, master, loop point —
  // timed, in the order the driver's sequencer would act on them. Global
  // events (tempo/markers/loops) are handled by _dispatchGlobalEvent first.
  // A sample part whose sound is elsewhere (the MIDI drums): nothing to write.
  _dispatchNothing() {}

  _dispatchDacEvent(ev, when) {
    const voice = ev._chIndex ?? 0;
    switch (ev.cmd) {
      case "PCM_NOTE_ON":
        this._dispatchPcmNoteOn(ev, when);
        break;
      case "PCM_NOTE_OFF":
        this._pcmEv(when, { kind: ev.args?.mode === "gate" ? "cut" : "off", voice });
        break;
      // A word, every way it is written (_word).
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._pcmWord(voice, String(ev.args?.target ?? "").toUpperCase()));
        break;
      default:
        break;
    }
  }

  _pcmEv(when, fields) {
    // A strip in the panel's hand: its value is the voice's :vol.
    const hand = this._handVol(`pcm:${fields.voice}`);
    if (hand != null) {
      if (fields.kind === "vol") fields = { ...fields, value: hand };
      else if (fields.kind === "on" || fields.kind === "retrig") fields = { ...fields, vol: hand };
    }
    if (fields.kind === "master" && this._masterHand) fields = { ...fields, value: this._masterHand.v };
    this._write({ type: "pcm-ev", when, ...fields });
  }

  // A point, from the IR's seconds to the engine's byte offset — the
  // same multiply and clamp the MMB exporter applies (export-mmb.js
  // targetValue), at the rate of the image the score names.
  _pcmLoopBytes(sec) {
    const rate = this._pcmBankRate ?? engineImage(Math.max(1, this._ir?.metadata?.pcmVoices ?? 1), this._ir?.metadata?.frameHz).rateHz;
    return Math.max(0, Math.min(PCM_LOOP_MAX, Math.round(Number(sec ?? 0) * rate)));
  }

  // A PCM voice's word (the Mega Drive's): its fader — a sweep steps the
  // voice's bank a frame at a time, as the driver's sweep engine does
  // (driver.md §14), written where it moves — its :vel, and its sample's
  // points; null for the words only FM and PSG have.
  _pcmWord(voice, target) {
    if (target === "VOL" || target === "VEL") {
      // Its level's (_lv): the engine's model composes it, from these.
      const L = this._lv(`pcm:${voice}`);
      const kind = target === "VOL" ? "vol" : "vel";
      const fit = (v) => Math.max(0, Math.min(target === "VOL" ? 31 : 15, Math.round(v)));
      const read = () => L[kind];
      const write = (v, t) => this._pcmEv(t, { kind, voice, value: (L[kind] = fit(v)) });
      return {
        read, write,
        sweep: (ev, when) => this._sweepWord(ev, when, read(), (v, t) => { if (L[kind] !== fit(v)) write(v, t); }),
      };
    }
    if (PCM_POINT_TARGETS.has(target)) return {
      read: () => this._pcmPointNow?.[`${voice}:${target}`] ?? 0,
      write: (v, t) => {
        (this._pcmPointNow ??= {})[`${voice}:${target}`] = v;
        this._pcmEv(t, { kind: "point", voice, target, value: this._pcmLoopBytes(v) });
      },
      sweep: (ev, when) => this._schedulePcmLoopSweep(voice, ev, when),
    };
    return null;
  }

  // A sweep counted in a word's own units (the SSG's noise period and
  // envelope rate, a pulse's duty, a wave chip's LFO): the driver's integer
  // steps, the word written where it moves.
  // `scale`: the steps a whole value's fraction (ENV_RATE's Hz).
  _sweepUnits(ev, when, start, write, scale = 1) {
    const a = ev.args ?? {};
    const df = this._curveFields(a, when);
    const from = Math.round(Number(df.from ?? start) * scale), to = Math.round(Number(df.to ?? from / scale) * scale);
    const len = this._sweepLen(a, when), loop = !!a.loop, id = curveId(a.curve);
    const target = String(a.target ?? "").toUpperCase();
    let last = null;
    // The driver's integer steps; the word is written where it moves.
    this._runSweep(this._slotKey(ev, target), SONG_WORDS.has(target) ? SONG : SWEEP, {
      loop, baseFrames: len, startWhen: when, startFrame: this._eventFrame(when),
      valueAt: (f) => sweepFrameValue(id, from, to, len, loop, f) / scale,
      timeOf: (f) => when + f / 60,
    }, (v, t) => {
      if (v !== last) write(v, t);
      last = v;
    });
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

  // The chips' own sample voices — the YM2608's ADPCM-B and rhythm, PCM8,
  // the DDA, the OPLL's rhythm — and their levels, which move while they
  // sound: the track's :vol and :pitch (a value, a sweep, a $slot), the
  // note's :vel / :vol / :pitch / :semi macros, :master and the panel's
  // strip. A voice belongs to the hit that last keyed it (`owner`); each of
  // those moves writes the owner's level, pitch and tune as they are then,
  // where they moved (_chipPcmWrite), as an FM channel's and a tone lane's
  // are. A rhythm sound's IL stops 23 dB down, so one fading below it (or
  // a :vol 0) is dumped instead.
  _chipPcmState() {
    return (this._chipPcm ??= {
      cents: new Map(), // track → its :pitch, in cents (its :vol is _lv(`strk:…`)'s)
      owner: new Map(), // voice ("adpcm", a rhythm sound, "pcm8-0", "dda-0" …) → the hit sounding on it
      lane: new Map(), // a kit's channel → the hit that last keyed it (a pair's tune, _chipPcmWrite)
      frames: false, // a DDA frame is waiting (_chipPcmFrame)
    });
  }

  // A sample track's word: its fader and its pitch, which its sounding hits
  // follow, and the words of its part (`own`: { WORD: { read, write } }).
  _sampleWord(ev, own = {}) {
    const ti = ev._trackIndex;
    const target = String(ev.args?.target ?? "").toUpperCase();
    const st = this._chipPcmState();
    const moved = (t) => { for (const [voice, h] of st.owner) if (h.ti === ti) this._chipPcmWrite(voice, t); };
    if (target === "VOL" && !own.noVol) return {
      read: () => this._lv(`strk:${ti}`).vol,
      write: (v, t) => { this._lvSetVol(`strk:${ti}`, v); moved(t); },
    };
    if (target === "NOTE_PITCH" && own.pitch) return {
      read: () => st.cents.get(ti) ?? 0,
      write: (v, t) => { st.cents.set(ti, v); moved(t); },
    };
    return own[target] ?? null;
  }

  // A part's words that set where its next notes play: their range and
  // loop (seconds as heard), each a value of the track's state `st`.
  static _rangeWords(st, loop = true) {
    const w = (o, k, other) => ({
      read: () => st[o]?.[k] ?? 0,
      write: (v) => { (st[o] ??= {})[k] = Number(v); if (other) st[o][other] = null; },
    });
    return {
      RANGE_START: w("range", "start"), RANGE_END: w("range", "end", "len"), RANGE_LEN: w("range", "len", "end"),
      ...(loop ? { LOOP_START: w("loop", "start"), LOOP_END: w("loop", "end", "len"), LOOP_LEN: w("loop", "len", "end") } : {}),
    };
  }

  // A macro's first sample, on the note itself (`when`), or null: what a
  // key composes from, as the driver's note-on does (driver.md §7.2).
  _macroOnset(spec, when, gateTicks, target) {
    if (!spec) return null;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const mark = this._markStep;
    this._markStep = null;
    let v = null;
    try {
      this._scheduleMacroImpl(spec, noteFrames, gateSecs, when,
        (x, t) => { if (v === null && t <= when + 1e-9) v = clampForTarget(target, x); }, this._stepSecs(spec.step));
    } finally {
      this._markStep = mark;
    }
    return v;
  }

  // A hit (or an ADPCM-B note) keyed on `voice`: its own :vel / :vol /
  // :pitch / :semi macros run from it a step at a time, and each :keyon
  // step re-keys the voice — a hit of its own, its level envelopes starting
  // over with it, as on FM and PSG (a gate or loop note's only inside its
  // gate). `key(t, hit)` writes a key: the first, then each step's.
  _chipPcmHit(voice, ev, when, end, fields, key) {
    const st = this._chipPcmState();
    const { keyon, velMacro, vol: volMacro, pitchMacro, note_semi: semiMacro } = ev.args ?? {};
    const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const held = ev.args?.mode === "gate" || ev.args?.mode === "loop";
    const retrigs = (this._keyonRetrigTimes(keyon, when, gateTicks) ?? []).filter((t) => !held || t < gateSecs);
    // The note's macros as they are now, shared by its retriggers' hits.
    const macros = [[velMacro, "vel", "VEL"], [volMacro, "vol", "VOL"], [pitchMacro, "cents", "NOTE_PITCH"], [semiMacro, "semi", "NOTE_SEMI"]];
    const onset = {};
    for (const [spec, k, target] of macros) onset[k] = this._macroOnset(spec, when, gateTicks, target);
    const mac = { ...onset };
    // A note under a running :pitch sweep sounds from the sweep's value on
    // its frame, as an FM or tone note does (_onsetPitchOffset).
    const sw = this._slots.get(this._slotKey(ev, "NOTE_PITCH"));
    if (sw) st.cents.set(ev._trackIndex, this._sweepAt(sw, sw.next));
    const hit = { t: when, end, voice, ti: ev._trackIndex, vel: Number(ev.args?.vel ?? 15), mac, ...fields };
    // A tuned hit's (the OPLL rhythm's) pitch runs its note's whole length:
    // the channel keeps moving through the sound's release.
    const slot = fields.tune ? this._resolveNoteFramesAndGate(when, ev.args?.length ?? gateTicks) : null;
    this._envRetrigs = retrigs;
    for (const [spec, k, target] of macros) {
      if (!spec) continue;
      const span = slot && (k === "cents" || k === "semi") ? slot : { noteFrames, gateSecs };
      this._scheduleMacro(spec, span.noteFrames, span.gateSecs, when, (v, t) => {
        mac[k] = clampForTarget(target, v);
        if (st.owner.get(voice)?.mac === mac) this._chipPcmWrite(voice, t);
      }, this._stepSecs(spec.step));
    }
    this._envRetrigs = null;
    const keyHit = (h) => {
      st.owner.set(voice, h);
      const lane = this._routes.get(h.ti)?.part?.kitLane?.[voice];
      if (lane != null) st.lane.set(lane, h);
      key(h.t, h);
      if (h.dda != null && !st.frames) {
        st.frames = true;
        this._chipPcmNext(this._eventFrame(h.t));
      }
    };
    const fresh = { ...hit }; // a retrigger's hit starts as the note's did
    keyHit(hit);
    // A retrigger keys at its time, before its frame's steps: its level
    // envelopes start over there, from their first samples.
    const scope = this._noteScope;
    for (const t of retrigs)
      this._at(t, () => {
        if (scope && this._noteOf[scope.ti] !== scope.note) return; // the track's next note took over
        for (const k of ["vel", "vol"]) if (onset[k] != null) mac[k] = onset[k];
        keyHit({ ...fresh, t, end: end + (t - when) });
      }, KEYED);
    return hit;
  }

  // The hit that holds `voice` now, if it is `ti`'s: a gate's end stops
  // only the track's own sound.
  _chipPcmOwnHit(voice, ti) {
    const h = this._chipPcm?.owner.get(voice);
    return h?.ti === ti ? h : null;
  }

  // A hit's level now: { vel, vol, master }.
  _chipPcmLevelAt(hit) {
    return {
      vel: hit.mac.vel ?? hit.vel,
      vol: this._handVol(`voice:${hit.voice}`) ?? hit.mac.vol ?? this._lv(`strk:${hit.ti}`).vol,
      master: this._handMaster() ?? this._masterVol ?? VOL_UNITY,
    };
  }

  // A hit's pitch move now, in cents: the track's :pitch and the note's
  // :pitch / :semi macros.
  _hitCents(hit) {
    return (this._chipPcm.cents.get(hit.ti) ?? 0) + (hit.mac.cents ?? 0) + 100 * (hit.mac.semi ?? 0);
  }

  // The ADPCM-B's Delta-N for a hit now: its note and its pitch move over
  // the sample's rate.
  _adpcmDeltaN(hit) {
    const enc = this._target.chipFor("adpcm-b").adpcm;
    return enc.deltaN(hit.rate * 2 ** ((hit.midi - 60) / 12 + this._hitCents(hit) / 1200));
  }

  // A chip-own sample voice's level from vel + vol + master + its strip, on
  // its part's ladder (chips/parts.js `level`): the rhythm's IL attenuation
  // (unclamped — a sound falling past what the IL reaches is dumped), the
  // ADPCM-B's linear register, PCM8's gain.
  static _rhythmAtt(level, { vel, vol, master }) {
    return levelOffset(level, { vel, faders: [vol, master] });
  }
  static _pcm8Gain({ vel, vol, master }) {
    return levelGain({ vel, faders: [vol, master] });
  }
  static _adpcmLevel(level, { vel, vol, master }) {
    return Math.round((level.steps - 1) * levelGain({ vel, faders: [vol, master] }));
  }

  // The DDA's frame `k`, as work of the frame once its steps are done
  // (VOICES): each sounding hit's samples on the CPU's timer, and its end.
  // The frames go on while a hit has samples to write.
  _chipPcmNext(k) {
    const st = this._chipPcm;
    let more = false;
    for (const h of st.owner.values()) if (h.dda != null && !h.dumped) more = true;
    if (!more) { st.frames = false; return; }
    const t = this._frameOrigin + k / 60;
    this._step(k, VOICES, t, () => {
      if (this._chipPcm !== st) return;
      for (const h of st.owner.values()) if (h.dda != null && !h.dumped) this._ddaFrame(h, t + 1 / 60);
      this._chipPcmNext(k + 1);
    });
  }

  // `voice`'s sounding hit's level, pitch and tune at `t`, where they moved
  // since its last write (`force`: written whatever — the panel's move,
  // over what was sent ahead of it).
  _chipPcmWrite(voice, t, force = false) {
    const st = this._chipPcm;
    const h = st?.owner.get(voice);
    if (!h) return;
    // An OPLL rhythm hit's pitch moves its channel while the sound rings
    // and on through its release, to the next hit on the channel: its own
    // or its pair's (SD with HH, TOM with the cymbal), which tunes it.
    const lane = this._routes.get(h.ti)?.part?.kitLane?.[voice];
    if (h.tune && (lane == null || st.lane.get(lane) === h)) {
      const midi = h.midi + this._hitCents(h) / 100;
      if (midi !== h.tuned || force) {
        h.tuned = midi;
        for (const [p, a, d] of this._rhythmEnc.tune(voice, midi, t)) this._write(p, a, d, t);
      }
    }
    if (h.dumped || t >= h.end) return;
    const lv = this._chipPcmLevelAt(h);
    if (h.dda != null) {
      const att = levelSteps(this._routes.get(h.ti).part.level, { vel: lv.vel, faders: [lv.vol, lv.master] });
      if (att !== h.att || force) { h.att = att; for (const [p, a, d] of this._ddaEncoder().level(h.dda, att)) this._write(p, a, d, t); }
    } else if (h.pcm8 != null) {
      const gain = IRPlayer._pcm8Gain(lv);
      if (gain !== h.gain || force) { h.gain = gain; this._pcm8Ev(t, { kind: "gain", voice: h.pcm8, value: gain }); }
      const step = this._pcm8Step(h);
      if (step !== h.step) { h.step = step; this._pcm8Ev(t, { kind: "step", voice: h.pcm8, value: step }); }
    } else if (voice === "adpcm") {
      const chip = this._target.chipFor("adpcm-b");
      const level = IRPlayer._adpcmLevel(this._routes.get(h.ti).part.level, lv);
      if (level !== h.level || force) {
        h.level = level;
        for (const [p, a, d] of chip.adpcm.level(level)) this._write(p, a, d, t);
      }
      const deltaN = this._adpcmDeltaN(h);
      if (deltaN !== h.deltaN) {
        h.deltaN = deltaN;
        for (const [p, a, d] of chip.adpcm.pitch(deltaN)) this._write(p, a, d, t);
      }
    } else {
      const level = this._routes.get(h.ti).part.level;
      const top = level.steps - 1;
      const att = IRPlayer._rhythmAtt(level, lv);
      // Turned off, or falling below what the level reaches: the sound stops.
      const falling = att > (h.lastAtt ?? h.att);
      h.lastAtt = att;
      if (lv.vol <= 0 || lv.master <= 0 || (att > top && falling)) {
        h.dumped = true;
        for (const [p, a, d] of this._rhythmEnc.dump(voice, t)) this._write(p, a, d, t);
        return;
      }
      const il = top - Math.min(top, att);
      if (il === h.il && !force) return;
      h.il = il;
      for (const [p, a, d] of this._rhythmEnc.level(voice, il, h.pan, t)) this._write(p, a, d, t);
    }
  }

  // The YM2608's ADPCM-B: a note plays its sample's range at the Delta-N of
  // its pitch, its level vel + vol + master as one linear level (the chip's
  // $0B, moving with them while it sounds), its pan the track's; `shot`
  // plays to the range's end, `gate` stops at the note's end, `loop` repeats
  // the range until then. A range the track writes (:pcm-start …) is time as
  // heard (language.md §16), so it reaches into the sample by the note's
  // pitch; on the RAM it rounds to the 4-byte address unit, 8 frames.
  _dispatchAdpcmEvent(ev, when) {
    const ti = ev._trackIndex;
    const st = (this._adpcmState ??= new Map()).get(ti) ?? { pan: 0 };
    this._adpcmState.set(ti, st);
    const enc = this._target.chipFor("adpcm-b").adpcm;
    const out = (writes) => { for (const [p, a, d] of writes) this._write(p, a, d, when); };
    const cp = this._chipPcmState();
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._adpcmBank?.entries?.[ev.args?.sample];
        if (!entry || !this._isVoiceTrackAudible(ti, "adpcm")) break;
        const ratio = 2 ** ((pitchToMidi(ev.args?.pitch ?? "c4") - 60) / 12);
        const frames = (sec) => sec * entry.rate * ratio;
        const UNIT_FRAMES = 8;
        let { start, stop } = entry;
        const r = st.range ?? {};
        const a = r.start != null ? frames(r.start) : 0;
        const b = r.end != null ? frames(r.end) : r.len != null ? a + frames(r.len) : null;
        if (a > 0) start = Math.min(stop, entry.start + Math.floor(a / UNIT_FRAMES));
        if (b != null) stop = Math.max(start, Math.min(stop, entry.start + Math.ceil(b / UNIT_FRAMES) - 1));
        const mode = ev.args?.mode;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const playHz = (deltaN) => (deltaN / 65536) * (this._target.chipFor("adpcm-b").clock / 144);
        // A shot ends where its range does at the pitch it keys at.
        const shotLen = ((stop - start + 1) * UNIT_FRAMES) / playHz(enc.deltaN(entry.rate * ratio));
        this._chipPcmHit("adpcm", ev, when, mode === "shot" || !mode ? when + shotLen : Infinity, { rate: entry.rate, midi }, (t, h) => {
          h.level = IRPlayer._adpcmLevel(this._routes.get(h.ti).part.level, this._chipPcmLevelAt(h, t));
          h.deltaN = this._adpcmDeltaN(h, t);
          for (const [p, a, d] of enc.note({ start, stop }, h.deltaN, h.level, st.pan, mode === "loop")) this._write(p, a, d, t);
        });
        break;
      }
      case "PCM_NOTE_OFF":
        // Only the track that keyed the voice last stops it.
        if (ev.args?.mode === "gate" || ev.args?.mode === "loop") {
          const h = this._chipPcmOwnHit("adpcm", ti);
          if (!cp.owner.has("adpcm") || h) out(enc.stop());
          if (h) h.end = Math.min(h.end, when);
        }
        break;
      // A word, every way it is written (_word): the track's fader and
      // pitch, its pan, and the range the next notes play (seconds as
      // heard; a loop is the range itself on this chip, the compiler holds
      // it to that).
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, {
          pitch: true,
          PAN: { read: () => st.pan, write: (v) => { st.pan = this._snapMacroOutput("PAN", v); } },
          ...IRPlayer._rangeWords(st, false),
        }));
        break;
      default:
        break;
    }
  }

  _pcm8Ev(when, fields) {
    this._write({ type: "pcm8", when, ...fields });
  }

  // A PCM8 voice's step through its sample a mix sample: the note's pitch,
  // the track's :pitch and the note's :pitch / :semi macros, over the rate
  // the sample plays C4 at.
  _pcm8Step(hit) {
    const cents = this._hitCents(hit);
    return (hit.rate * 2 ** ((hit.midi - 60) / 12 + cents / 1200)) / PCM8_RATE;
  }

  // The X68000's PCM8 (chips/msm6258.js): a note plays its sample from the
  // range's start at its pitch's step, its gain vel + vol + master moving
  // with them while it sounds (_chipPcmWrite); `shot` plays to the range's
  // end, `gate` is cut at the note's end, `loop` repeats the loop until then
  // and plays the rest out. A point the track writes (:pcm-start …) is time
  // as heard, read at the key-on, so it reaches into the sample by the
  // note's pitch.
  _dispatchPcm8Event(ev, when) {
    const ti = ev._trackIndex;
    const voice = ev._chIndex ?? 0;
    const key = `pcm8-${voice}`;
    const st = (this._pcm8State ??= new Map()).get(ti) ?? {};
    this._pcm8State.set(ti, st);
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._frameBank?.entries?.[ev.args?.sample];
        if (!entry || !this._isVoiceTrackAudible(ti, key)) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // sample frames a second, as heard
        const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
        const r = st.range ?? {}, l = st.loop ?? {};
        const start = at(r.start) ?? 0;
        const end = r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : entry.data.length;
        const loopStart = l.start != null ? at(l.start) : undefined;
        const loopEnd = l.end != null ? at(l.end) : l.len != null ? (loopStart ?? entry.loopStart) + at(l.len) : undefined;
        const mode = ev.args?.mode;
        const shotEnd = when + Math.max(0, Math.min(end, entry.data.length) - start) / perSec;
        // A held note (:len 0) waits for triggerKeyOff, as the Mega Drive's does.
        if (this._resolveGateTicks(ev.args?.gate, ev.args?.length) === 0) this._holdChannels.set(this._holdKey(ev), ti);
        this._chipPcmHit(key, ev, when, mode === "shot" || !mode ? shotEnd : Infinity,
          { rate: entry.rate, midi, pcm8: voice }, (t, h) => {
            h.gain = IRPlayer._pcm8Gain(this._chipPcmLevelAt(h, t));
            h.step = this._pcm8Step(h, t);
            this._pcm8Ev(t, { kind: "on", voice, sample: ev.args.sample, gain: h.gain, step: h.step,
              start, end, loopStart, loopEnd, mode: mode ?? "shot" });
          });
        break;
      }
      case "PCM_NOTE_OFF": {
        // Only the track that keyed the voice last stops it.
        const h = this._chipPcmOwnHit(key, ti);
        if (!h) break;
        if (ev.args?.mode === "gate") { this._pcm8Ev(when, { kind: "cut", voice }); h.end = Math.min(h.end, when); }
        else if (ev.args?.mode === "loop") this._pcm8Ev(when, { kind: "off", voice });
        break;
      }
      // A word, every way it is written (_word): the track's fader and
      // pitch, the range and loop the next notes play.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, { pitch: true, ...IRPlayer._rangeWords(st) }));
        break;
      default:
        break;
    }
  }

  // The PC Engine's DDA encoder (chips/huc6280.js): its wave chip's, shared
  // with the wave lanes (it keeps the channels' state).
  _ddaEncoder() {
    return this._toneEnc?.find((l) => l?.enc.dda)?.enc.dda ?? null;
  }

  // The PC Engine's DDA (pcm1-pcm6): a note's sample baked at DDA_RATE at
  // its pitch — its range and loop read as PCM8's are — written a byte a
  // timer tick to the channel's $06 from its key-on to its end: the
  // sample's, the track's next note's, a gate's or loop's at its gate, or
  // the next note of any of the channel's names (wave5 under pcm5, which
  // ends it where it starts: _dispatchPsgEvent). The bytes go out a frame
  // at a time with its level (_chipPcmWrite, _ddaFrame), then the channel
  // off; its pan is written at its key-on.
  _dispatchDdaEvent(ev, when) {
    const ti = ev._trackIndex;
    const ch = ev._chIndex ?? 0;
    const key = `dda-${ch}`;
    const enc = this._ddaEncoder();
    const st = (this._ddaState ??= new Map()).get(ti) ?? { pan: 0 };
    this._ddaState.set(ti, st);
    const write = (writes, t) => { for (const [p, a, d] of writes) this._write(p, a, d, t); };
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const entry = this._frameBank?.entries?.[ev.args?.sample];
        if (!enc || !entry?.data.length || !this._isVoiceTrackAudible(ti, key)) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // source frames a second, as heard
        const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
        const r = st.range ?? {}, l = st.loop ?? {};
        const start = Math.min(at(r.start) ?? 0, entry.data.length);
        const end = Math.min(entry.data.length, r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : entry.data.length);
        const loopStart = Math.min(end, l.start != null ? at(l.start) : entry.loopStart ?? start);
        const loopEnd = Math.min(end, l.end != null ? at(l.end) : l.len != null ? loopStart + at(l.len) : entry.loopEnd ?? end);
        const mode = ev.args?.mode ?? "shot";
        // Where it stops: the next note on the track; a gate or loop note
        // also at its gate; a shot when its sample runs out.
        const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
        const { secs: nextNote } = this._nextNote(ev);
        // On the frame the next note starts on, as its writes are; the last
        // sample before it, so the channel is off before that note keys it.
        const onFrame = (t) => (this._target.frameClock ? this._frameStart(t) : t);
        let stop = Number.isFinite(nextNote) ? onFrame(nextNote) : Infinity;
        if (mode !== "shot" && gateTicks > 0) stop = Math.min(stop, onFrame(this._timeAfterTicks(when, gateTicks)));
        // A shot with nothing after it plays its sample out; a loop is held
        // for a while.
        const maxTicks = Number.isFinite(stop) ? Math.floor((stop - when) * DDA_RATE + 1e-9)
          : mode === "loop" ? Math.ceil(DDA_HOLD_SEC * DDA_RATE) : Infinity;
        const step = perSec / DDA_RATE; // source frames a timer tick
        const bytes = [];
        for (let pos = start; bytes.length < maxTicks; pos += step) {
          if (pos >= (mode === "loop" ? loopEnd : end)) {
            if (mode !== "loop" || loopEnd - loopStart < 1) break;
            pos = loopStart + ((pos - loopStart) % (loopEnd - loopStart));
          }
          const i = Math.floor(pos), f = pos - i;
          const x = entry.data[i] * (1 - f) + (entry.data[Math.min(i + 1, entry.data.length - 1)] ?? 0) * f;
          bytes.push(ddaStep(x));
        }
        if (!bytes.length) break;
        const off = when + bytes.length / DDA_RATE;
        this._chipPcmHit(key, ev, when, off, { dda: ch, bytes, sent: 0 }, (t, h) => {
          h.att = levelSteps(ev._route.part.level, this._ddaLevel(h, t));
          write([...enc.pan(ch, st.pan), ...enc.level(ch, h.att)], t);
        });
        break;
      }
      // A word, every way it is written (_word): the track's fader, its
      // pan, the range and loop the next notes play.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, {
          PAN: { read: () => st.pan, write: (v) => { st.pan = Math.max(-1, Math.min(1, Number(v) || 0)); } },
          ...IRPlayer._rangeWords(st),
        }));
        break;
      default:
        break;
    }
  }

  // The DMC's rate for each sample its notes play (chips/rp2a03.js dmcRates).
  _dmcRateOf(name) {
    this._dmcRates ??= dmcRates(this._ir, this._target.headsOf("fc-dpcm"), this._frameBank?.entries);
    return this._dmcRates.get(name) ?? dmcRate(Infinity);
  }

  // The 2A03's DMC (pcm1): a note's sample — its range as heard, read as
  // DDA's is — resampled to its pitch at its def-pcm's rate (_dmcRateOf),
  // its level (vel + vol + master at key-on) in it, and encoded to the
  // 1-bit delta (chips/rp2a03.js dmcEncode). Each hit loads its bytes into
  // the memory a hair ahead of its key-on, on the machine's own timing (the
  // load is not a frame's write), then starts the DMC; `loop` repeats the
  // range, and a loop or gate note stops at its gate. A shot plays out, or
  // until the next note starts over.
  _dispatchDpcmEvent(ev, when) {
    const ti = ev._trackIndex;
    const st = (this._dpcmState ??= new Map()).get(ti) ?? {};
    this._dpcmState.set(ti, st);
    const dmc = this._target.chipFor("fc-dpcm").dmc;
    const write = (writes, t) => { for (const [p, a, d] of writes) this._write(p, a, d, t); };
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        const name = ev.args?.sample;
        const entry = this._frameBank?.entries?.[name];
        if (!entry?.data.length || !this._isVoiceTrackAudible(ti, "dpcm")) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const perSec = entry.rate * 2 ** ((midi - 60) / 12); // source frames a second, as heard
        const at = (sec) => (sec == null ? null : Math.max(0, Math.round(sec * perSec)));
        const r = st.range ?? {};
        const start = Math.min(at(r.start) ?? 0, entry.data.length);
        const end = Math.min(entry.data.length, r.end != null ? at(r.end) : r.len != null ? start + at(r.len) : entry.data.length);
        if (end <= start) break;
        const mode = ev.args?.mode ?? "shot";
        // The level at key-on: the note's vel (or its macro's first step),
        // the track's :vol (or its macro's), the master, the strip.
        const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
        const gain = levelGain({
          vel: this._macroOnset(ev.args?.velMacro, when, gateTicks, "VEL") ?? Number(ev.args?.vel ?? 15),
          faders: [this._handVol("voice:dpcm") ?? this._macroOnset(ev.args?.vol, when, gateTicks, "VOL") ?? this._lv(`strk:${ti}`).vol,
            this._handMaster() ?? this._masterVol ?? VOL_UNITY],
        });
        const rate = this._dmcRateOf(name);
        const levels = dmcLevels(entry, perSec, rate, gain, start, end);
        const bytes = dmcEncode(levels, mode === "loop");
        const loadAt = (this._target.frameClock ? this._frameStart(when) : when) - DMC_LOAD_LEAD_SECS;
        // Live's worklet takes the load as one stream tick (thousands of
        // messages would stall the page); a capture, a write at a time.
        const load = dmc.load(bytes), timed = this._writeTimer;
        if (timed.stream) {
          const flat = new Uint8Array(2 * load.length);
          load.forEach(([, a, d], k) => { flat[2 * k] = a; flat[2 * k + 1] = d; });
          timed.stream({ when: loadAt, rate: 1, port: load[0][0], perTick: load.length, bytes: flat });
        } else for (const [p, a, d] of load) timed(p, a, d, loadAt);
        // The worklet writes timed writes at its block's start but a stream
        // at its sample: the start goes as a stream too, so it follows the
        // load it plays (a capture keeps the order by time).
        const go = dmc.start(bytes, rate, mode === "loop");
        if (timed.stream) {
          const flat = new Uint8Array(2 * go.length);
          go.forEach(([, a, d], k) => { flat[2 * k] = a; flat[2 * k + 1] = d; });
          const t = this._target.frameClock ? this._frameTime(when) : when;
          timed.stream({ when: t, rate: 1, port: go[0][0], perTick: go.length, bytes: flat });
        } else write(go, when);
        if (mode !== "shot" && gateTicks > 0) {
          const gate = this._timeAfterTicks(when, gateTicks);
          const { secs: nextNote } = this._nextNote(ev);
          if (gate < nextNote - 1e-6) write(dmc.stop(), gate);
        }
        break;
      }
      // A word, every way it is written (_word): the track's fader (read
      // at the next key-on), the range the next notes play.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, IRPlayer._rangeWords(st, false)));
        break;
      default:
        break;
    }
  }

  // A DDA hit's samples up to `until` (a frame's end), on the CPU's timer,
  // not the video frame — as one stream a frame where the writer takes one
  // (Live's worklet, a write a tick at its sample), else a write at a time
  // (a capture, the exports) — and, once its last is out or its end has
  // come, the channel off, a key-order lead before its end: past its last
  // sample, and before the key-on of a note of another of the channel's
  // names that starts there or ends it (`cut`).
  _ddaFrame(h, until) {
    const enc = this._ddaEncoder();
    const timed = this._writeTimer;
    const ch = h.dda;
    const last = Math.min(h.bytes.length, Math.ceil((h.end - h.t) * DDA_RATE - 1e-9));
    const to = Math.min(last, Math.ceil((until - h.t) * DDA_RATE - 1e-9));
    if (to > h.sent) {
      const from = h.sent;
      if (timed.stream) {
        const per = enc.sample(ch, 0);
        const flat = new Uint8Array((to - from) * per.length * 2);
        for (let k = from; k < to; k++)
          enc.sample(ch, h.bytes[k]).forEach(([, a, d], j) => { flat[2 * ((k - from) * per.length + j)] = a; flat[2 * ((k - from) * per.length + j) + 1] = d; });
        timed.stream({ when: h.t + from / DDA_RATE, rate: DDA_RATE, port: per[0][0], perTick: per.length, bytes: flat });
      } else for (let k = from; k < to; k++) for (const [p, a, d] of enc.sample(ch, h.bytes[k])) timed(p, a, d, h.t + k / DDA_RATE);
      h.sent = to;
    }
    // The off waits for the frame it falls in: a note starting on the
    // channel at the sample's very end is dispatched before that frame.
    const at = Math.min(h.end, h.t + last / DDA_RATE) - KEY_ORDER_EPS_SECS;
    if (h.sent >= last && until > at) {
      h.dumped = true;
      for (const [p, a, d] of enc.off(ch)) timed(p, a, d, at);
    }
  }

  // A DDA hit's level terms: vel + vol + master (levelSteps).
  _ddaLevel(h, t) {
    const lv = this._chipPcmLevelAt(h, t);
    return { vel: lv.vel, faders: [lv.vol, lv.master] };
  }

  // A chip's ROM rhythm (the YM2608's, the OPLL's): a hit writes its sound's
  // level and pan, then keys it; vel + vol + master fold into the level as
  // an FM carrier's do, on the part's ladder (the YM2608's IL 0.75 dB a
  // step, the OPLL's volume 3 dB), and move it while the sound plays
  // (_chipPcmWrite), and `:mode gate` dumps it at the note's end. On the
  // OPLL a hit's note tunes its channel.
  _dispatchRhythmEvent(ev, when) {
    const ti = ev._trackIndex;
    const st = (this._rhythmState ??= new Map()).get(ti) ?? { pan: 0 };
    this._rhythmState.set(ti, st);
    const enc = this._rhythmEnc;
    const part = ev._route.part;
    const sound = this._ir?.metadata?.samples?.find((s) => s.name === ev.args?.sample)?.rhythm;
    switch (ev.cmd) {
      case "PCM_NOTE_ON": {
        if (!sound || !this._isVoiceAudible(sound)) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const sec = part.soundSec?.[sound] ?? ROM_SOUND_SEC[sound];
        this._chipPcmHit(sound, ev, when, when + sec, { pan: st.pan, midi, tune: !!enc.tune }, (t, h) => {
          const lv = this._chipPcmLevelAt(h, t);
          // A hit at :vol 0 is silence: it takes the sound from an earlier one.
          const silent = lv.vol <= 0 || lv.master <= 0;
          const top = part.level.steps - 1;
          h.dumped = silent;
          h.att = IRPlayer._rhythmAtt(part.level, lv);
          h.il = top - Math.min(top, h.att);
          h.tuned = midi + this._hitCents(h, t) / 100;
          const writes = silent ? enc.dump(sound, t) : enc.hit(sound, h.il, st.pan, t, h.tuned);
          for (const [p, a, d] of writes) this._write(p, a, d, t);
        });
        break;
      }
      case "PCM_NOTE_OFF":
        // Only the track that keyed the sound last dumps it.
        if (sound && ev.args?.mode === "gate") {
          const h = this._chipPcmOwnHit(sound, ti);
          if (h) {
            for (const [p, a, d] of enc.dump(sound, when)) this._write(p, a, d, when);
            h.end = Math.min(h.end, when);
          }
        }
        break;
      // A word, every way it is written (_word): the track's fader, its
      // pitch where the rhythm tunes (the OPLL's), its pan.
      case "PARAM_SET":
      case "PARAM_FROM_VAL":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP":
        this._word(ev, when, this._sampleWord(ev, {
          pitch: !!enc.tune,
          PAN: { read: () => st.pan, write: (v) => { st.pan = this._snapMacroOutput("PAN", v); } },
        }));
        break;
      default:
        break;
    }
  }

  // A swept point, stepped the way the driver steps it: integer from/to
  // in bytes, the curve lowered to the driver's eight shapes, one value a
  // frame (mmlispseq.c process_sweep, drv-player _processSweep). The worklet's
  // voice model sends a RETARGET only when the rounded block moves.
  _schedulePcmLoopSweep(voice, ev, when) {
    const a = ev.args ?? {};
    const target = (a.target ?? "").toUpperCase();
    const df = this._curveFields(a, when);
    const from = this._pcmLoopBytes(df.from), to = this._pcmLoopBytes(df.to);
    const len = this._sweepLen(a, when), loop = !!a.loop, id = curveId(a.curve);
    const step16 = sweepStep(len, loop);
    this._runSweep(this._slotKey(ev, target), SWEEP, {
      loop, baseFrames: len, startWhen: when, startFrame: this._eventFrame(when),
      valueAt: (f) => (!loop && f >= len - 1 ? to : sweepValue(from, to, curveUnit8(id, ((f * step16) & 0xffff) >> 8))),
      // After its frame's dispatch: a sweep that starts with a note moves
      // that note's loop, not the one before it.
      timeOf: (f) => when + f / 60 + PCM_SWEEP_AFTER,
    }, (value, t) => this._pcmEv(t, { kind: "point", voice, target, value }));
  }

  _dispatchPcmNoteOn(ev, when) {
    // A muted PCM track must not sound. PCM owns no FM/PSG channel, so there is
    // no key-off to suppress it after the fact (as _applyAudibility does for
    // those) — the note has to be dropped here, like FM/PSG NOTE_ON do.
    // A voice started before a mute or solo landed is released here, where its
    // next note would have replaced it; a loop would otherwise run on.
    if (!this._isTrackAudible(ev._trackIndex)) {
      this._pcmEv(when, { kind: "off", voice: ev._chIndex ?? 0 });
      return;
    }
    const sample = String(ev.args?.sample ?? "").trim();
    if (!sample) return;
    const velRaw = Number(ev.args?.vel ?? 15);
    const noteVel = Number.isFinite(velRaw) ? velRaw : 15;
    const voice = ev._chIndex ?? 0;
    this._pcmSample[voice] = sample;
    // The bank baked one blob per (sample, note); the worklet finds it by the
    // same MIDI number the exporter keyed it with (export-mmb.js midiNote).
    const midi = Math.max(0, Math.min(127, Math.round(pitchToMidi(ev.args?.pitch ?? "c4"))));

    // The note's macros (driver.md §13): :vel and :vol are the voice's level,
    // a :keyon step plays the blob again from its start. Each runs to the
    // next note on the track, which re-instantiates them; a :keyon retrigger
    // restarts the level envelopes, as it does on FM and PSG.
    const { keyon, velMacro, vol: volMacro } = ev.args ?? {};
    const lengthTicks = ev.args.length;
    const gateTicks = this._resolveGateTicks(ev.args?.gate, lengthTicks);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const { secs: nextNote } = this._nextNote(ev);
    const limit = Number.isFinite(nextNote) ? nextNote - KEY_OFF_LEAD_SECS : Infinity;
    if (gateTicks === 0) this._holdChannels.set(this._holdKey(ev), ev._trackIndex); // waits for KEY_OFF
    // A :keyon retrigger STARTs after its frame's level steps, so it
    // carries them: they ride its event instead of sending a level of their
    // own. Each step is its frame's work (MACRO), each retrigger after them.
    const retrigTimes = this._keyonRetrigTimes(keyon, when, gateTicks, limit) ?? [];
    const retrigs = new Map(retrigTimes.map((t) => [this._eventFrame(t), { t }]));
    const first = []; // the samples on the note itself: its key-on composes from them
    let on = false;
    const level = (kind, value, t) => {
      const r = retrigs.get(this._eventFrame(t));
      if (r) r[kind] = value;
      else this._pcmEv(t, { kind, voice, value, macro: true });
    };
    this._envRetrigs = retrigTimes;
    for (const [spec, kind, target] of [[velMacro, "vel", "VEL"], [volMacro, "vol", "VOL"]]) {
      if (!spec) continue;
      this._scheduleMacro(
        spec, noteFrames, gateSecs, when,
        (v, t) => {
          const value = clampForTarget(target, v);
          if (on) level(kind, value, t);
          else first.push({ t, kind, value });
        },
        this._stepSecs(spec.step), limit,
      );
    }
    this._envRetrigs = null;
    // The note starts at its :vel macro's first sample, as the driver's
    // note-on composes it (a leading hold: the note's own vel).
    const firstVel = velMacro && !macroLeadsWithHold(velMacro)
      ? first.find((x) => x.kind === "vel")?.value ?? noteVel
      : noteVel;
    // ...and at its :vol macro's first sample, else the fader (restore_level_base).
    const firstVol = volMacro && !macroLeadsWithHold(volMacro)
      ? first.find((x) => x.kind === "vol")?.value ?? null
      : null;
    // A PCM note takes fm6 as the DAC: $2B on where it is off (its first
    // note, or after an fm6 note took it: _fmKey) — as the driver does.
    if (this._dacClaim && !this._dacOn) {
      this._dacOn = true;
      this._write(0, 0x2b, 0x80, when);
    }
    this._pcmEv(when, {
      kind: "on",
      voice,
      track: ev._trackIndex ?? null,
      sample,
      midi,
      mode: ev.args?.mode === "loop" ? "loop" : "shot",
      vel: firstVel,
      vol: firstVol,
    });
    on = true;
    for (const x of first) level(x.kind, x.value, x.t);
    for (const [F, r] of retrigs) {
      const t = r.t + PCM_SWEEP_AFTER;
      this._step(F, AFTER, t, () => {
        const { t: _at, ...carried } = r;
        this._pcmEv(t, { kind: "retrig", voice, ...carried });
      });
    }
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

      case "PARAM_SET":
      case "PARAM_ADD":
      case "PARAM_MUL":
      case "PARAM_FROM_VAL":
      case "PARAM_SWEEP":
      case "PARAM_SWEEP_STOP": {
        if (ev.args?.target === "NOISE_RATE") {
          const write = (v, t) => this._psgWrites(this._psg((c) => c.noiseRate(v), "noiseRate"), t);
          this._word(ev, when, {
            read: () => this._noiseRateBase ?? 9,
            write: (v, t) => write((this._noiseRateBase = v), t),
            sweep: () => this._sweepUnits(ev, when, 9, write),
          });
          return true;
        }
        if (ev.args?.target === "ENV_RATE") {
          // 0 follows the writing track's notes (a tone lane's), from its
          // next; a rate is a cycle of the writing track's shape as it is now.
          const lane = this._toneEnc[ev._psgCh]?.part?.songWords?.("ENV_RATE") ? ev._psgCh : null;
          // The writing lane's shape and moves, as they are now.
          const by = lane != null ? { shape: this._psgEnv[lane], semi: this._envSemi[lane], detune: this._envDetune[lane] } : {};
          this._word(ev, when, {
            read: () => this._envRate ?? 0,
            write: (v, t) => {
              this._envRate = v;
              this._envFollow = v ? null : this._toneEnc[lane]?.part?.kind !== "noise" ? lane : null;
              if (v) this._writeEnvPeriod(v, by, t);
            },
            sweep: () => {
              this._envFollow = null;
              this._sweepUnits(ev, when, 0, (v, t) => this._writeEnvPeriod((this._envRate = v), by, t), 64);
            },
          });
          return true;
        }
        const m = /^VAL(\d+)$/.exec(ev.args?.target ?? "");
        if (!m) return false;
        this._writeVal(ev, this._valNames[Number(m[1])], when);
        return true;
      }

      case "MARKER":
      case "TRIG":
      case "LOOP_BEGIN":
      case "LOOP_END":
      case "REST":
      case "TIE":
      case "JUMP":
        return true;

      default:
        return false;
    }
  }

  // Dynamic values — host API to set/read a value slot by name. A slot is an
  // i16, and that is the only bound: `def-val`'s :from/:to are the live
  // slider's endpoints, not a limit on what the host may write (language.md
  // §8). Bounds are applied where a value is *used*, per target, by the same
  // clamps the driver applies — so the preview and MMLispDRV agree on any
  // value a host writes. A non-finite write is ignored, exactly as
  // drv-player.js ignores it, leaving the slot at its previous value.
  setVal(name, value) {
    const v = toSlotValue(value);
    if (v === null || !this._vals) return;
    // The latest write wins: the host's ends the score's sweep of the slot.
    if (this._valSweeps) delete this._valSweeps[name];
    this._vals[name] = v;
  }

  // The score writing a value slot (`:name …`, language.md §8): a song-wide
  // target, so it is handled here whichever track carries it. A sweep runs in
  // the slot's own sweep slot, as on the driver — a write ends it only where
  // the driver's would (a SET, a STOP or a new sweep), and a read in a frame
  // sees what the sweep wrote the frame before (_resolveSrc).
  _writeVal(ev, name, when) {
    if (name == null) return;
    // A slot in the panel's hand: skipped while held, taken back once let go.
    if (!this._scoreWrites(`val:${name}`)) return;
    const a = ev.args ?? {};
    const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
    const cur = this._resolveSrc(name, when);
    // A one-shot past its last frame has left the slot, its endpoint in it.
    const sw = this._valSweeps[name];
    if (sw && !sw.loop && this._eventFrame(when) - sw.startFrame - 1 >= sw.baseFrames - 1) {
      delete this._valSweeps[name];
      this._vals[name] = cur;
    }
    switch (ev.cmd) {
      case "PARAM_SET":
        delete this._valSweeps[name];
        this._vals[name] = i16(a.value ?? 0);
        break;
      case "PARAM_SWEEP_STOP":
        delete this._valSweeps[name];
        this._vals[name] = cur;
        break;
      case "PARAM_FROM_VAL":
        this._vals[name] = i16(this._resolveSrc(a.src, when));
        break;
      case "PARAM_ADD":
      case "PARAM_MUL":
        this._vals[name] = i16(this._writeValue(ev, cur, when));
        break;
      case "PARAM_SWEEP": {
        const df = this._curveFields(a, when);
        const baseFrames = a.dyn?.len != null
          ? this._resolveLenFrames(a, null, when)
          : a.lenFrames
            ? Math.max(1, Math.round(Number(a.frames ?? 1)))
            : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
        this._valSweeps[name] = {
          from: df.from != null ? Number(df.from) : cur,
          to: Number(df.to ?? 0),
          curve: a.curve ?? "linear",
          params: df.params,
          baseFrames,
          loop: !!a.loop,
          startFrame: this._eventFrame(when),
          prev: cur,
        };
        break;
      }
    }
  }
  getVal(name) {
    return this._vals?.[name] ?? 0;
  }

  // Elapsed 60 Hz frames since playback start, at audio time `when`.
  _valTime(when) {
    return Math.max(0, Math.round((when - (this._startAudioTime ?? 0)) * 60));
  }

  // Resolve a value source id: "$time" (built-in) or a slot name. Slots are kept
  // finite at write time (setVal); the finite guard here is belt-and-braces
  // so no dynamic-value path can ever hand NaN to downstream math.
  _resolveSrc(src, when) {
    if (src === "$time") return this._valTime(when);
    const sw = this._valSweeps?.[src];
    if (sw) {
      // The driver steps a sweep after the frame's events, so an event reads
      // the value the frame before wrote — the slot as it was, in the sweep's
      // own first frame. A finished one-shot holds its endpoint (_sweepAt).
      const k = this._eventFrame(when) - sw.startFrame - 1;
      if (k < 0) return sw.prev;
      return Math.max(-32768, Math.min(32767, Math.round(this._sweepAt(sw, k))));
    }
    const v = this._vals?.[src];
    return Number.isFinite(v) ? v : 0;
  }

  // A write's value from its word's value now (`cur`): a SET's, a `$slot`'s,
  // a `+` or a `*`, in the driver's arithmetic (opcodes.md PARAM_ADD /
  // PARAM_MUL / PARAM_MUL_VAL: a factor is unsigned 8.8 — a literal ×256
  // rounded, a slot the 8.8 itself, 256 = ×1 — and the product drops its
  // fraction). Null for any other event. Every word's relative write reads
  // here, whatever kind of track writes it.
  _writeValue(ev, cur, when) {
    const a = ev.args ?? {};
    switch (ev.cmd) {
      case "PARAM_SET": return Number(a.value ?? 0);
      case "PARAM_FROM_VAL": return this._resolveSrc(a.src, when);
      case "PARAM_ADD": return cur + this._resolveOperand(a.delta, when);
      case "PARAM_MUL": {
        const f = a.factor;
        const fixed = f && typeof f === "object" && "src" in f ? this._resolveSrc(f.src, when) : Math.round((Number(f) || 0) * 256);
        return Math.floor((Math.round(cur) * Math.max(0, Math.min(0xffff, fixed))) / 256);
      }
      default: return null;
    }
  }

  // Resolve a PARAM_ADD/MUL operand: a literal number or a { src } reference.
  _resolveOperand(operand, when) {
    if (operand && typeof operand === "object" && "src" in operand)
      return this._resolveSrc(operand.src, when);
    return Number(operand) || 0;
  }

  // Dynamic macro params: resolve a curve spec's dynamic :from/:to/:rate
  // (spec.dyn = { from?, to?, rate? } slot names) to current slot values at
  // `when` (note-on) — one read per note, so the value is constant for the
  // note. Returns { from, to, params } with the dynamic fields overridden.
  _curveFields(spec, when) {
    const dyn = spec.dyn;
    let { from, to, params } = spec;
    if (dyn) {
      if (dyn.from != null) from = this._resolveSrc(dyn.from, when);
      if (dyn.to != null) to = this._resolveSrc(dyn.to, when);
      if (dyn.rate != null)
        params = { ...params, rate: this._resolveSrc(dyn.rate, when) };
    }
    return { from, to, params };
  }

  // Length of a curve/stage in 60 Hz frames. A dynamic :len (spec.dyn.len) reads
  // the slot at note-on and interprets it by the slot's unit (frame as-is / tick
  // → tempo-relative); otherwise the static frames field (ticks, or Nf frames).
  _resolveLenFrames(spec, rawFrames, when) {
    if (spec.dyn?.len != null) {
      const raw = this._resolveSrc(spec.dyn.len, when);
      const unit = this._valUnits?.[spec.dyn.len] ?? "frame";
      return unit === "tick"
        ? Math.max(1, Math.round(raw * this._secsPerTick * 60))
        : Math.max(1, Math.round(raw));
    }
    return spec.lenFrames
      ? Math.max(1, Math.round(Number(rawFrames)))
      : Math.max(1, Math.round(Number(rawFrames) * this._secsPerTick * 60));
  }

  // The FM3 operator an event's track drives (0 = not an operator track).
  _fm3OpOf(ev) {
    return ev?._trackIndex != null ? (this._tracks[ev._trackIndex]?.fm3Op ?? 0) : 0;
  }

  // Read a target's current stored value from chRegs (the shadow register file)
  // for read-modify-write PARAM_ADD / PARAM_MUL. FM_TL reads the voiced (timbre)
  // base so a relative TL op composes with vel/vol attenuation.
  _readParam(ch, target, fm3Op = 0) {
    const regs = this._chRegs[ch];
    if (!regs) return 0;
    const t = String(target || "").toUpperCase();
    if (fm3Op && t === "NOTE_PITCH") return this._fm3Op[fm3Op - 1].offset;
    // An fm3 operator's :vol is its own (driver.md §13.4).
    if (t === "VOL") return this._lv(fm3Op ? `fm3op:${fm3Op}` : `fm:${ch}`).vol;
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
      case "PAN": return regs.pan ?? 0;
      case "SNAP": return regs.snap ?? 0;
      // Inline `:pitch+ N` accumulates onto the running cent offset (else it
      // would read 0 and overwrite rather than add).
      case "NOTE_PITCH":
      case "NOTE_SEMI": return regs.pitchOffset ?? 0;
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
      case "PAN": {
        const pan = this._snapMacroOutput("PAN", value);
        regs.pan = pan;
        this._fmWrites(this._fmEnc.pan(ch, regs), when);
        break;
      }
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
      case "NOTE_PITCH": {
        // FM3 independent-OP: :pitch on an fm3-N track detunes that operator's
        // F-number alone (driver.md §13.4).
        const op = this._fm3OpOf(ev);
        const cents = Math.round(value);
        if (op) {
          const st = this._fm3Op[op - 1];
          st.offset = cents;
          this._writeFm3OpPitch(op, st.midi, cents, when);
          break;
        }
        // Cent offset applied to the current note on this FM channel (100 cents = 1 semitone).
        regs.pitchOffset = cents;
        this._writeFmNote(ch, regs.currentMidi ?? 60, cents, when);
        break;
      }
      case "SNAP": {
        // The mask is sticky channel state (language.md §5.3); the sounding
        // note moves onto it at once, as a NOTE_PITCH write would move it. On
        // an fm3-N track it is CH3's mask, and that operator's note moves.
        regs.snap = Math.max(0, Math.min(0xfff, Math.round(value)));
        const op = this._fm3OpOf(ev);
        if (op) {
          const st = this._fm3Op[op - 1];
          this._writeFm3OpPitch(op, st.midi ?? 60, st.offset ?? 0, when);
        } else {
          this._writeFmNote(ch, regs.currentMidi ?? 60, regs.pitchOffset ?? 0, when);
        }
        break;
      }

      case "VOL": {
        // The score's fader (a :vol macro is the note's level instead, §6).
        // FM3 independent-OP: :vol on an fm3-N track is THAT operator's fader;
        // on the shared (fm3 …) track it is the group fader over all four
        // (driver.md §13.4).
        const volOp = this._fm3OpOf(ev);
        const site = volOp ? `fm3op:${volOp}` : `fm:${ch}`;
        this._lvSetVol(site, value);
        this._lvWrite(site, when);
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

  // Clamp rawGate to [0, lengthTicks]. If rawGate is null/undefined, falls back to lengthTicks.
  _resolveGateTicks(rawGate, lengthTicks) {
    return rawGate != null ? Math.min(rawGate, lengthTicks) : lengthTicks;
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
      // resolution (ir-utils panSide: left / both / right).
      return Math.max(-1, Math.min(1, Number(value) || 0));
    }
    if (t === "NOISE_MODE") {
      // SN76489 mode is a 3-bit integer (0..7)
      return Math.max(0, Math.min(7, Math.round(Number(value) || 0)));
    }
    return value;
  }

  // A glide ended by its target's next write before it ran its length.
  // `endTick`: the sweep's end, when the dispatch has resolved it already.
  // Resolve a NOTE_ON `step` spec ({ unit, value }) to seconds per step.
  // Absent → one frame (1/60 s), the default :step.
  _stepSecs(stepSpec) {
    if (!stepSpec) return 1 / 60;
    if (stepSpec.unit === "tick")
      return Math.max(1, stepSpec.value) * this._secsPerTick;
    return Math.max(1, stepSpec.value) / 60; // frame
  }

  // Thin wrapper: run the macro, and if it carries a source span (step
  // sequences do), highlight that `[...]` literal for its sounding window.
  _scheduleMacro(
    spec,
    noteFrames,
    gateSecs,
    when,
    writeFn,
    stepSecs = 1 / 60,
    limitSecs = Infinity,
  ) {
    // Restarted by the note's :keyon retriggers (set around an envelope's
    // scheduling): one run per keyed segment, each cut at the next retrigger.
    // A retrigger after key-off (an echo tail) leaves the release playing: the
    // taps step through it.
    const pre = (this._envRetrigs ?? []).filter(
      (r) => r > when + 1e-6 && r < gateSecs && r < limitSecs,
    );
    const marks = spec?.src && this._onPosition ? [] : null;
    // Each step is work of its frame, after that frame's sweeps (MACRO) —
    // or, for a caller only reading the macro's values, handed over now.
    // A note's macros are its own until the track's next note, which takes
    // the lane over on its frame (the driver's dispatch runs before the
    // frame's macros): each step asks as it runs, so nothing is cut ahead.
    // (limitSecs is left to what is told ahead: a caller reading the values
    // now, and the end this returns.)
    const scope = this._macroDry ? null : this._noteScope;
    const endLimit = limitSecs;
    if (scope) limitSecs = Infinity;
    const step = this._macroDry ? writeFn
      : (v, t) => this._at(t, () => { if (!scope || this._noteOf[scope.ti] === scope.note) writeFn(v, t); }, MACRO);
    const run = (at, gate, lim) => {
      const w = [], m = [];
      const mark = this._markStep;
      this._markStep = marks && ((step, t) => { if (t < Math.min(lim, endLimit)) m.push([step, t]); });
      let end;
      try {
        end = this._scheduleMacroImpl(
          spec,
          Math.max(1, noteFrames - Math.round((at - when) * 60)),
          gate, at, (v, t) => w.push([v, t]), stepSecs, lim,
        );
      } finally {
        this._markStep = mark;
      }
      return { w, m, end };
    };
    const flush = (seg, cut = Infinity) => {
      for (const [v, t] of seg.w) if (t < cut - 1e-9) step(v, t);
      if (marks) for (const [k, t] of seg.m) if (t < cut - 1e-9) marks.push([k, t]);
    };
    const starts = [when, ...pre];
    let seg = null;
    for (let i = 0; i < starts.length; i++) {
      if (seg) flush(seg);
      seg = run(starts[i], gateSecs, Math.min(limitSecs, starts[i + 1] ?? Infinity));
    }
    flush(seg);
    let endTime = seg.end == null ? seg.end : Math.min(seg.end, endLimit);
    if (marks?.length)
      this._onPosition({ kind: "macro", src: spec.src, marks, end: Math.max(endTime ?? gateSecs, marks.at(-1)[1] + stepSecs) });
    // The source outlines a step vector while it sounds.
    if (spec?.src && spec.type === "steps" && this._onSeq) {
      const src = spec.src;
      const now = this._audioContext.currentTime;
      const hideAt = endTime ?? gateSecs;
      this._scheduleUiCallback(
        () => this._onSeq(true, src),
        Math.max(0, when - now) * 1000,
      );
      this._scheduleUiCallback(
        () => this._onSeq(false, src),
        Math.max(0, hideAt - now) * 1000,
      );
    }
    return endTime;
  }

  // Core macro scheduler shared by all targets and types.
  // stepSecs is the per-step duration for step-vector macros (the :step clock);
  // curve/stage sampling stays at 60 Hz.
  // Returns the audio time immediately after the last scheduled write (for
  // scheduling silence), or null if no writes were made (curve type or empty).
  _scheduleMacroImpl(
    spec,
    noteFrames,
    gateSecs,
    when,
    writeFn,
    stepSecs = 1 / 60,
    limitSecs = Infinity,
  ) {
    if (!spec) return null;
    // Each step's time, as the panel's vector editor counts the steps
    // (_scheduleMacro's marks; edit-tools.js vectorAt): set only when asked.
    const mark = this._markStep;

    // Monophonic priority: the next note-on (limitSecs) supersedes this note's
    // tail, so drop any write scheduled at/after it.
    if (limitSecs !== Infinity) {
      const inner = writeFn;
      writeFn = (v, t) => {
        if (t < limitSecs) inner(v, t);
      };
    }

    // Scaled macro (§7.0): a value slot is a per-frame depth knob.
    // Wrap every scheduled value with `(sample × slot) >> 8`, reading the slot
    // per step (the driver reads it live per frame). Applies to every target
    // uniformly, matching drv-player's pre-dispatch scale of the raw sample.
    if (spec.scale != null) {
      const inner = writeFn;
      const slotName = spec.scale;
      writeFn = (v, t) =>
        inner(scaleMacroSample(Math.round(v), this._resolveSrc(slotName, t)), t);
    }

    // :step is the macro sampling clock. Curve/stage macros sample (and hold)
    // every stepFrames; default 1f = 1 frame = 60 Hz (smooth, unchanged). A
    // coarser :step gives a stepped / sample-and-hold curve.
    const stepFrames = Math.max(1, Math.round(stepSecs * 60));
    // The clock's unit: a 60 Hz frame, or — a tick :step — a tick of the
    // note's track, the lengths then in ticks too (mmlisp2ir resolveMacroLen),
    // so the steps land on the beat (driver.md §13.2). Lengths, budgets and
    // steps below are counted in it.
    const tickClock = spec.step?.unit === "tick";
    const unitSecs = tickClock ? this._secsPerTick : 1 / 60;
    const perSec = 1 / unitSecs;
    const stepUnits = tickClock ? Math.max(1, Math.round(spec.step.value)) : stepFrames;
    // A time `u` units after `t0`: a tick clock counts through the tempo
    // changes known ahead, as the driver's does.
    const adv = (t0, u) => (tickClock ? this._timeAfterTicks(t0, u) : t0 + u * unitSecs);
    const lenUnits = (o, raw) =>
      !tickClock
        ? this._resolveLenFrames(o, raw, when)
        : o.dyn?.len != null
          ? this._resolveLenFrames(o, raw, when) / (60 * this._secsPerTick)
          : Math.max(1, Math.round(Number(raw)));

    if (spec.type === "stages") {
      const { stages } = spec;
      if (!stages || stages.length === 0) return null;

      // The release boundary, where export-mmb lowerStages puts it: the first
      // (wait key-off), else the first curve stage after a looping one. At
      // key-off the driver leaves attack/sustain for the release from wherever
      // it is, on the key-off's own frame; a macro with no release stops there.
      let rel = stages.length;
      for (let i = 0, afterLoop = false; i < stages.length; i++) {
        const st = stages[i];
        if (st.waitKeyOff || (st.curve && afterLoop)) {
          rel = i;
          break;
        }
        if (st.curve && st.loop) afterLoop = true;
      }
      const offT = this._keyOffFrameTime(when, gateSecs);
      // A sample in the key-off's frame is the release's: the driver leaves
      // for it before that frame's step.
      const offFrame = offT === Infinity ? Infinity : this._eventFrame(gateSecs + KEY_OFF_LEAD_SECS);

      // Where each stage's steps start in the vector shown: a curve its
      // steps (a looping one, one cycle), a wait its holds.
      const shown = !mark ? null : stages.map((st) => {
        if (st.waitKeyOff) return 0;
        if (!st.curve) {
          const frames = st.waitTicks != null ? Number(st.waitTicks) * this._secsPerTick * 60 : Number(st.waitFrames ?? 0);
          return Math.max(0, Math.ceil((tickClock ? frames / (60 * this._secsPerTick) : frames) / stepUnits));
        }
        const base = lenUnits(st, st.frames ?? 1);
        return Math.max(1, (st.loop ? Math.round : Math.ceil)(base / stepUnits));
      });
      const shownAt = shown?.map((_, i) => shown.slice(0, i).reduce((a, b) => a + b, 0));

      let t = when;
      let last = null; // the last value written: a release without :from starts there
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const keyed = i < rel;
        if (i === rel) {
          if (offT === Infinity) break;
          // A tick clock counts the release from the key-off's tick; its first
          // sample still lands on the key-off's frame.
          t = tickClock ? gateSecs + KEY_OFF_LEAD_SECS : offT;
        }
        // A :wait advances the time cursor. A pure wait stage (no curve) stops
        // here; a curve stage with :wait uses it as a pre-delay, then plays.
        const waitFrom = t;
        if (stage.waitKeyOff) t = Math.max(t, offT);
        else if (stage.waitTicks != null)
          t = this._timeAfterTicks(t, Math.max(0, Number(stage.waitTicks)));
        else if (stage.waitFrames != null) t += stage.waitFrames / 60;
        if (mark && !stage.curve)
          for (let k = 0; k < shown[i]; k++) {
            const at = waitFrom + ((t - waitFrom) * k) / shown[i];
            if (!keyed || at < offT) mark(shownAt[i] + k, at);
          }
        if (keyed && t >= offT - 1e-9) {
          i = rel - 1; // key-off during a wait: on to the release
          continue;
        }
        if (!stage.curve) continue; // pure wait stage
        // Regular curve stage (dynamic :from/:to/:rate resolved per note)
        const { curve = "linear", frames: rawFrames = 1, loop = false } = stage;
        const fields = this._curveFields(stage, when);
        const to = fields.to ?? 0, params = fields.params;
        const from = stage.fromNow ? last ?? to : fields.from ?? 0;
        // A release from where the level is moves by the driver's share of
        // the way, r of stage.fromNow (export-mmb.js), so the preview and the
        // driver agree.
        const one = stage.fromNow;
        const share = (u) => (one ? 1 - Math.max(0, Math.min(one - 1, Math.round((1 - u) * one))) / one : u);
        const baseFrames = lenUnits(stage, rawFrames);
        // A looping stage runs until key-off; a keyed one-shot is cut there.
        const untilOff =
          offT === Infinity ? Infinity : Math.max(0, Math.ceil((offT - t) * perSec) + stepUnits);
        const budget = !keyed
          ? loop ? 0 : baseFrames
          : loop
            ? untilOff === Infinity ? Math.max(0, Math.floor((gateSecs - t) * perSec)) : untilOff
            : Math.min(baseFrames, untilOff);
        let cut = false;
        for (let frame = 0; frame < budget; frame += stepUnits) {
          if (keyed && this._eventFrame(adv(t, frame)) >= offFrame) {
            cut = true;
            break;
          }
          const phase = loop
            ? (frame % baseFrames) / baseFrames
            : baseFrames <= 1
              ? 1
              : Math.min(1, frame / (baseFrames - 1));
          const v = from + (to - from) * share(sampleCurveUnit(curve, phase, params));
          if (keyed) last = v;
          writeFn(v, keyed ? adv(t, frame) : Math.max(offT, adv(t, frame)));
          mark?.(shownAt[i] + Math.min(shown[i] - 1, Math.floor((loop ? frame % baseFrames : frame) / stepUnits)),
            keyed ? adv(t, frame) : Math.max(offT, adv(t, frame)));
        }
        t = cut ? offT : adv(t, budget);
        if (keyed && (cut || t >= offT - 1e-9)) i = rel - 1; // key-off: on to the release
      }
      return Math.min(t, limitSecs);
    }

    if (spec.type === "curve") {
      const {
        frames: rawFrames = 1,
        loop,
        curve = "linear",
        waitTicks = null,
        waitFrames = null,
        waitKeyOff = false,
      } = spec;
      const { from, to, params } = this._curveFields(spec, when);
      // :len → 60 Hz frames (ticks by default, `Nf` as absolute frames, or a
      // dynamic slot resolved by its unit).
      const baseFrames = lenUnits(spec, rawFrames);
      const waitFrameOffset = waitKeyOff
        ? Math.max(0, Math.round((gateSecs - when) * perSec))
        : tickClock
          ? Math.max(0, Math.round(Number(waitTicks ?? 0)))
          : waitFrames != null
            ? Math.max(0, Math.round(Number(waitFrames)))
            : Math.max(
                0,
                Math.round(Number(waitTicks ?? 0) * this._secsPerTick * 60),
              );
      const startWhen = waitKeyOff
        ? Math.max(when, gateSecs)
        : adv(when, waitFrameOffset);
      const remainingFrames = Math.max(0, (noteFrames / 60) * perSec - waitFrameOffset);
      const activeFrames = waitKeyOff
        ? baseFrames
        : loop
          ? remainingFrames
          : Math.min(remainingFrames, baseFrames);
      for (let frame = 0; frame < activeFrames; frame += stepUnits) {
        const phase = loop
          ? (frame % baseFrames) / baseFrames
          : baseFrames <= 1
            ? 1
            : Math.min(1, frame / (baseFrames - 1));
        writeFn(
          from + (to - from) * sampleCurveUnit(curve, phase, params),
          adv(startWhen, frame),
        );
        mark?.(Math.floor((loop ? frame % baseFrames : frame) / stepUnits), adv(startWhen, frame));
      }
      return Math.min(adv(startWhen, activeFrames), limitSecs);
    }

    if (spec.type === "steps") {
      const { steps, loopIndex, releaseIndex } = spec;
      if (!steps || steps.length === 0) return null;

      const sustainEnd = releaseIndex ?? steps.length;

      // Attack + sustain loop until gate, advancing one step per :step interval.
      // An empty sustain section (`[#rel ...]`, releaseIndex 0) writes nothing
      // before key-off — the target keeps its current value until the release.
      // Key-off leaves attack/sustain for the release on its own frame, as the
      // driver does (see the stages form).
      const offT = this._keyOffFrameTime(when, gateSecs);
      const releaseAt = offT === Infinity ? gateSecs : offT;
      // A step in the key-off's frame is the release's (see the stages form).
      const offFrame = offT === Infinity ? Infinity : this._eventFrame(gateSecs + KEY_OFF_LEAD_SECS);
      let t = when;
      let idx = 0;
      while (
        sustainEnd > 0 &&
        (offFrame === Infinity ? t < releaseAt - 1e-9 : this._eventFrame(t) < offFrame)
      ) {
        if (steps[idx] !== null && steps[idx] !== undefined)
          writeFn(steps[idx], t);
        mark?.(idx, t);
        idx++;
        if (idx >= sustainEnd) {
          if (loopIndex !== null) {
            idx = loopIndex;
          } else {
            break; // one-shot: hold last attack step
          }
        }
        t = tickClock ? this._timeAfterTicks(t, stepUnits) : t + stepSecs;
      }

      // Release phase after gate (steps after :off), spaced by :step too
      if (releaseIndex !== null && releaseIndex < steps.length) {
        // A tick clock counts the release from the key-off's tick; its first
        // step still lands on the key-off's frame.
        const tick = spec.step?.unit === "tick" && offT !== Infinity;
        t = tick ? gateSecs + KEY_OFF_LEAD_SECS : releaseAt;
        for (let ri = releaseIndex; ri < steps.length; ri++) {
          if (steps[ri] !== null && steps[ri] !== undefined)
            writeFn(steps[ri], tick ? Math.max(releaseAt, t) : t);
          mark?.(ri, tick ? Math.max(releaseAt, t) : t);
          t = tickClock ? this._timeAfterTicks(t, stepUnits) : t + stepSecs;
        }
        return Math.min(t, limitSecs); // time after last release write
      }
      return Math.min(gateSecs, limitSecs); // time at gate-off
    }

    return null;
  }

  // The time of the driver frame a note's key-off lands in, for a macro that
  // started with the note at `when` (the macro steps on the note's frames).
  // Infinity for a held note.
  _keyOffFrameTime(when, gateSecs) {
    if (gateSecs > when + 1e8) return Infinity;
    const k = this._eventFrame(gateSecs + KEY_OFF_LEAD_SECS) - this._eventFrame(when);
    return when + Math.max(0, k) / 60;
  }

  // Schedule PAN and FM operator param macros embedded in NOTE_ON args.
  // Keys: pan → PAN, fm_tl1 → FM_TL1, etc. (snake_case from makeNoteArgs)
  _scheduleFmOpMacros(
    ch,
    noteArgs,
    when,
    gateTicks,
    limitSecs = Infinity,
  ) {
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    const retrigs = this._envRetrigs;
    for (const [key, target] of OP_MACRO_MAP) {
      const spec = noteArgs[key];
      if (!spec) continue;
      const t = target; // capture for closure
      // :pan is a place, not an envelope: it runs on through a :keyon
      // retrigger, as :pitch/:semi do (driver.md §14).
      this._envRetrigs = key === "pan" ? null : retrigs;
      this._scheduleMacro(
        spec,
        noteFrames,
        gateSecs,
        when,
        (v, when) => {
          this._applyParam(
            ch,
            {
              cmd: "PARAM_SET",
              args: { target: t, value: v },
            },
            when,
          );
        },
        this._stepSecs(spec.step),
        limitSecs,
      );
    }
    this._envRetrigs = retrigs;
  }

  // A note's :vel and :vol macros, as one level: at every sample time of
  // either, the note's level is recomposed from both lines' live values (the
  // driver composes both every frame, §7). An FM3 operator's note writes that
  // operator's TL; a channel's, its carriers.
  // Schedule a pitch macro for any channel (FM or PSG).
  // writeFn(centOffset, t) performs the hardware write for the channel.
  // `offsetGetter`: when the macro is additive (`:pitch+`/`:semi+`), each sample
  // is composed with the channel's live pitch offset (read fresh so it rides a
  // running pitch sweep). Override macros (`:pitch`/`:semi`) pass it unchanged.
  _schedulePitchMacro(
    pitchMacro,
    when,
    gateTicks,
    writeFn,
    limitSecs = Infinity,
    offsetGetter = null,
  ) {
    if (!pitchMacro) return;

    const wf =
      pitchMacro.add && offsetGetter
        ? (cents, t) => writeFn(cents + offsetGetter(), t)
        : writeFn;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(
      pitchMacro,
      noteFrames,
      gateSecs,
      when,
      wf,
      this._stepSecs(pitchMacro.step),
      limitSecs,
    );
  }

  // Schedule a :semi macro (discrete semitone offsets) on the pitch write path.
  // Reuses the pitch writeFn; semitone values are ×100 to cents.
  _scheduleSemiMacro(
    semiMacro,
    when,
    gateTicks,
    writeFn,
    limitSecs = Infinity,
    offsetGetter = null,
  ) {
    if (!semiMacro) return;

    // The semitones stay whole (writeFn's third argument) so the channel's
    // `:snap` mask sees note + semi, as the driver's write_note_semi does.
    const wf =
      semiMacro.add && offsetGetter
        ? (semi, t) => writeFn(offsetGetter(), t, semi)
        : (semi, t) => writeFn(0, t, semi);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(
      semiMacro,
      noteFrames,
      gateSecs,
      when,
      wf,
      this._stepSecs(semiMacro.step),
      limitSecs,
    );
  }

  // Schedule a :keyon retrigger gate. Sampled per :step; a value >= 0.5 fires a
  // key-off→key-on (restarting the envelope). The t=0 sample coincides with the
  // note's own NOTE_ON and is a no-op. keyMask is the operators keyed.
  // Returns the audio time after the last step (used to place the final
  // key-off), or null if there was no keyon macro.
  _scheduleKeyonMacro(
    keyonSpec,
    keyMask,
    ch,
    when,
    gateTicks,
    limitSecs = Infinity,
  ) {
    if (!keyonSpec) return null;

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    const stepSecs = this._stepSecs(keyonSpec.step);
    // Gap to register the key-off before re-keying; kept short so on-beat
    // timing stays accurate, capped below KEY_OFF_LEAD_SECS.
    const gap = Math.min(KEY_OFF_LEAD_SECS, Math.max(0.001, stepSecs * 0.4));
    return this._scheduleMacro(
      keyonSpec,
      noteFrames,
      gateSecs,
      when,
      (v, t) => {
        if (v < 0.5) return; // gate closed this step
        if (t <= when + 1e-6) return; // first sample = note's own key-on
        if (this._csmKeysCh3(ch)) return; // Timer A retriggers CH3 in CSM
        this._fmKey(ch, 0, Math.max(when, t - gap)); // key off
        this._fmKey(ch, keyMask, t); // key on
      },
      stepSecs,
      limitSecs,
    );
  }

  // The times a note's `:keyon` macro re-attacks it (every sample ≥ 0.5 but
  // the first, which is the note's own attack).
  _keyonRetrigTimes(keyonSpec, when, gateTicks, limitSecs = Infinity) {
    if (!keyonSpec) return null;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const times = [];
    this._scheduleMacroImpl(
      keyonSpec, noteFrames, gateSecs, when,
      (v, t) => { if (v >= 0.5 && t > when + 1e-6) times.push(t); },
      this._stepSecs(keyonSpec.step), limitSecs,
    );
    return times;
  }

  // The gaps an FM3 operator's `:keyon` macro punches in its key interval.
  // Sampled exactly like _scheduleKeyonMacro — same :step clock, same gap — but
  // the writes are left to _scheduleFm3OpKey, which has to merge them with the
  // other operators sharing $28 rather than write the register directly.
  _fm3KeyonGaps(keyonSpec, when, gateTicks, limitSecs = Infinity) {
    if (!keyonSpec) return [];
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    const stepSecs = this._stepSecs(keyonSpec.step);
    const gap = Math.min(KEY_OFF_LEAD_SECS, Math.max(0.001, stepSecs * 0.4));
    const gaps = [];
    this._macroDry = true; // the gaps are read now, written with the other operators' edges
    try {
      this._scheduleMacro(
        keyonSpec,
        noteFrames,
        gateSecs,
        when,
        (v, t) => {
          if (v < 0.5) return; // gate closed this step
          if (t <= when + 1e-6) return; // first sample = the note's own key-on
          gaps.push({ off: Math.max(when, t - gap), on: t });
        },
        stepSecs,
        limitSecs,
      );
    } finally {
      this._macroDry = false;
    }
    return gaps;
  }

  // A word's event, whatever track writes it and whatever the word: a value
  // or a `$slot` (written), a `+` or a `*` (from the word as it is now), a
  // sweep (from where it is unless it names a :from, a step a frame), a stop
  // (its slot is freed, _freeSlot: the word stays where the sweep left it).
  // `w` is the word on that track — { read(), write(v, t) }, and `sweep`
  // where its sweep counts in units of its own — or null where the track
  // has no such word.
  _word(ev, when, w) {
    if (!w || ev.cmd === "PARAM_SWEEP_STOP") return;
    if (ev.cmd === "PARAM_SWEEP")
      return void (w.sweep ? w.sweep(ev, when) : this._sweepWord(ev, when, w.read(), w.write));
    const v = this._writeValue(ev, w.read(), when);
    if (v != null && Number.isFinite(v)) w.write(v, when);
  }

  // An FM channel's word (an fm3-N track's: that operator's where it has
  // its own, driver.md §13.4): _readParam and _applyParam.
  _fmWord(ch, ev) {
    const target = String(ev.args?.target ?? "").toUpperCase();
    return {
      read: () => this._readParam(ch, target, this._fm3OpOf(ev)),
      write: (value, t) => this._applyParam(ch, { ...ev, cmd: "PARAM_SET", args: { target, value } }, t),
    };
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

  // A lane's pan, −1..1, on its chip's own resolution (chips/huc6280.js).
  _psgSetPan(psgCh, v, when) {
    this._psgPan[psgCh] = Math.max(-1, Math.min(1, Number(v) || 0));
    this._psgWrites(this._lane(psgCh, (e, ch) => e.pan?.(ch, this._psgPan[psgCh], when) ?? []), when);
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

  // Each wave expression's frames up to `horizon`: one whose slots moved
  // since the frame before (a host's setVal, a def-val sweep) is written in
  // that frame — at most once a frame, as the driver would.
  _waveExprFrames(horizon) {
    const last = this._eventFrame(horizon);
    this._laneExpr.forEach((x, lane) => {
      if (!x) return;
      for (let f = x.nextFrame; f <= last; f++) {
        const t = this._frameOrigin + f / 60;
        const vals = x.slots.map((n) => this._resolveSrc(n, t));
        if (vals.some((v, k) => v !== x.vals[k])) {
          x.vals = vals;
          this._writeWaveExpr(lane, t);
        }
      }
      x.nextFrame = Math.max(x.nextFrame, last + 1);
    });
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

  // A sweep's value on its `frame`-th frame (0 = the frame it starts). The
  // curves the driver computes (driver.md §8) step the driver's integers
  // exactly; the rest (the wider easing families, the stochastic curves, a
  // :phase/:rate) sample the float curve, which the driver lowers to a
  // nearest shape.
  _sweepAt(sw, frame) {
    const id = DRIVER_SWEEP_CURVES.has(sw.curve) ? curveId(sw.curve) : null;
    if (id != null && sw.params?.phase == null && sw.params?.rate == null)
      return sweepFrameValue(
        id, Math.round(sw.from), Math.round(sw.to), sw.baseFrames, !!sw.loop, frame,
      );
    const phase = sampleSweepPhase(frame, sw.baseFrames, !!sw.loop, 0);
    return sw.from + (sw.to - sw.from) * sampleCurveUnit(sw.curve, phase, sw.params);
  }

  // The driver frame (0 = the song's start) an event at audio time `when`
  // runs in. The driver takes a tick as the frame's tempo accumulator crosses
  // it, so an event runs in the frame its NEXT tick starts in, less one — not
  // simply the frame its time falls in. Sweeps step on these frames: a
  // sweep's k-th frame is its start frame + k, written at that frame's time.
  _eventFrame(when) {
    return Math.ceil((when - this._frameOrigin) * 60 + this._secsPerTick * 60 - 1e-6) - 1;
  }

  _sweepFrameOf(sw, when) {
    return this._eventFrame(when) - sw.startFrame;
  }

  _sweepFrameTime(sw, k) {
    return Math.max(sw.startWhen, this._frameOrigin + (sw.startFrame + k) / 60);
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

  // ---- a voice's level ----
  // One model for every voice whose level the player composes — an FM
  // channel ("fm:0"), an fm3 operator ("fm3op:1"), a tone lane ("psg:0") —
  // kept by the site its strip's :vol names (_volSites):
  //
  //   vel, vol          the score's: its note's velocity, its fader
  //   liveVel, liveVol  its note's :vel / :vol macro, where one has stepped
  //   note, ends        the note sounding, and when its macros' levels end
  //   key               a key of Live's holding the voice: { vel }
  //   hand              the panel's hand on its :vol: { v, held, tracks, sites }
  //
  // The level is composed from what these are, each time one moves — a
  // note's key-on, a macro's step, a :vol or :master write, a sweep's step,
  // the panel, a key — as the driver re-composes a keyed channel (driver.md
  // §7); only where the result is written differs by kind (_lvWrite). A
  // sample voice and a MIDI channel keep the score's level in models of their
  // own: here they have the panel's hand.
  _lv(site) {
    let L = this._levels.get(site);
    if (!L) this._levels.set(site, (L = { vel: 15, vol: VOL_UNITY, liveVel: null, liveVol: null, note: null, ends: [], key: null, hand: null }));
    return L;
  }
  // What a level is composed from now: a key's velocity over the note's, the
  // panel's :vol over the score's.
  _lvVel(L) {
    return L.key?.vel ?? L.liveVel ?? L.vel;
  }
  _lvVol(L) {
    return L.hand ? L.hand.v : this._lvScoreVol(L);
  }
  _lvScoreVol(L) {
    return L.liveVol ?? L.vol;
  }
  // The level written again from what it is.
  _lvWrite(site, when) {
    const [kind, at] = site.split(":");
    const n = Number(at);
    if (kind === "fm") {
      if (n === 2 && this._fm3Ops) this._recomposeFm3Ops(when);
      else this._writeFmLevel(n, when);
    } else if (kind === "fm3op") this._writeFm3OpTl(n, when);
    else if (kind === "psg") this._psgRecompose(n, when);
  }
  // A note begins on the voice: its velocity, the last note's macros gone.
  _lvNoteOn(site, vel) {
    const L = this._lv(site);
    L.vel = vel;
    L.liveVel = L.liveVol = null;
    L.note = {};
    L.ends = [];
    return L;
  }
  // The note's :vel and :vol macros: each step, in its frame (MACRO), moves
  // the note's live value and — while `live()` — the level is written from
  // both as they are then. In bind order: which of the two steps first in a
  // frame. L.ends: when each macro's level is done.
  _lvMacros(site, args, when, gateTicks, limitSecs, live = null) {
    const L = this._lv(site);
    const note = L.note;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const run = (spec, target, key) => !spec ? null : this._scheduleMacro(spec, noteFrames, gateSecs, when, (v, t) => {
      if (L.note !== note) return; // the voice's next note took it over
      L[key] = clampForTarget(target, v);
      if (!live || live()) this._lvWrite(site, t);
    }, this._stepSecs(spec.step), limitSecs);
    const keys = Object.keys(args);
    const pair = [[args.velMacro, "VEL", "liveVel"], [args.vol, "VOL", "liveVol"]];
    if (args.vol && args.velMacro && keys.indexOf("vol") < keys.indexOf("velMacro")) pair.reverse();
    L.ends = pair.map(([spec, target, key]) => run(spec, target, key)).filter((e) => e != null);
  }
  // The fader written (a value, a sweep's step): over a :vol macro's until its next step.
  _lvSetVol(site, vol) {
    const L = this._lv(site);
    L.vol = Math.max(0, Math.min(31, vol));
    L.liveVol = null;
    return L;
  }

  // ---- a tone lane's level ----
  // Its attenuation, from the lane's level as it is (_lv).
  _psgRecompose(lane, when) {
    const L = this._lv(`psg:${lane}`);
    if (!L.note && !L.key) return;
    this._psgSetAtt(lane, this._composePsgAtt(lane, this._lvVel(L), this._lvVol(L), this._masterVol ?? VOL_UNITY), when);
  }

  // Whether the lane's note is keyed at `t` (now when absent): a :vol, a
  // :master or a sweep moves a keyed lane's level only — written to an idle
  // lane, a level would drone a tone.
  _psgKeyed(lane, t) {
    const L = this._lv(`psg:${lane}`);
    if (L.key) return true; // a key of Live's holds it
    return L.note != null && (t ?? -Infinity) < (this._psgKeyedUntil[lane] ?? 0) - 1e-6;
  }

  // A note's level on its lane: its key-on's, then its :vel and :vol macros a
  // step at a time, and silence at its gate — or, with a macro, at the
  // level's tail. gateTicks === 0 is a held note (triggerKeyOff ends it);
  // offWhen is null when the note holds or slurs into the next.
  _psgNoteLevel(psgCh, args, noteWhen, gateTicks, baseVel, limitSecs, offWhen) {
    const site = `psg:${psgCh}`;
    const L = this._lvNoteOn(site, Math.max(0, Math.min(15, baseVel)));
    // A first sample on the note itself is what the key-on composes from
    // (driver.md §7.2): the macros' steps write once the key-on has.
    let keyed = false;
    this._lvMacros(site, args, noteWhen, gateTicks, limitSecs, () => keyed);
    this._psgRecompose(psgCh, noteWhen);
    keyed = true;
    // Silence at the gate, or with a macro at the level's tail; a tail the
    // next note cuts short (at its limit) leaves the level to that note.
    const off = args.velMacro || args.vol
      ? (L.ends.length && Math.max(...L.ends) < limitSecs - 1e-9 ? Math.max(...L.ends) : null)
      : offWhen;
    if (off != null && offWhen != null) this._psgSetAtt(psgCh, this._psgOff(psgCh), off);
  }

  // A score write of MASTER on any track: a value, a `$slot`, `+` / `*` from
  // the master now, a sweep (from the master now unless it names a :from),
  // a stop (its slot freed, the master stays where the sweep left it).
  _masterEvent(ev, when) {
    this._word(ev, when, {
      read: () => this._masterVol ?? VOL_UNITY,
      write: (v, t) => this._applyMasterChange(v, t),
    });
  }

  // A sweep holds a slot, as the driver's do (driver.md §4 step 3): a
  // song-wide word's (MASTER, LFO_RATE …) is the song's, any other its
  // channel's — an fm3 operator's its own. A value, a sweep or a stop of the
  // word from any track frees the slot (SLOT_FREEING), and the sweep's
  // frames still waiting for their time (_at) stop there; a `+`, a `*` or a
  // `$slot` moves the word and the sweep steps on.
  _slotKey(ev, target) {
    if (SONG_WORDS.has(target)) return `song:${target}`;
    const r = ev._route;
    // A chip's sample track keeps its words (_sampleWord), and so its slots.
    if (r?.core === "sample" && r.part?.name !== "dac") return `strk${ev._trackIndex}:${target}`;
    return `${r?.core}${r?.lane}:${this._fm3OpOf(ev)}:${target}`;
  }
  _freeSlot(ev) {
    if (!this._slots.size || !SLOT_FREEING.has(ev.cmd)) return;
    this._slots.delete(this._slotKey(ev, String(ev.args?.target ?? "").toUpperCase()));
  }

  // A PSG note's macro on a register word (the SSG's mixer, its noise
  // period): each step written as it comes, where it moved.
  _schedulePsgWordMacro(spec, noteWhen, gateTicks, limitSecs, write) {
    if (!spec) return;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(noteWhen, gateTicks);
    let last = null;
    this._scheduleMacro(spec, noteFrames, gateSecs, noteWhen, (v, t) => {
      const r = Math.round(v);
      if (r !== last) write(r, t);
      last = r;
    }, this._stepSecs(spec.step), limitSecs);
  }

  _schedulePsgModeMacro(
    psgCh,
    modeMacro,
    noteWhen,
    gateTicks,
    limitSecs = Infinity,
  ) {
    if (!modeMacro) return;
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      noteWhen,
      gateTicks,
    );
    this._scheduleMacro(
      modeMacro,
      noteFrames,
      gateSecs,
      noteWhen,
      (v, t) => {
        this._psgSetNoiseCfg(this._snapMacroOutput("NOISE_MODE", v), t, psgCh);
      },
      this._stepSecs(modeMacro.step),
      limitSecs,
    );
  }

  _dispatchPsgEvent(ev, when) {
    const psgCh = ev._psgCh ?? 0;

    switch (ev.cmd) {
      case "NOTE_ON": {
        if (!this._isTrackAudible(ev._trackIndex)) {
          // Silence the channel instead: the previous note's level (its tone
          // past the gate when it runs into this one, or a release macro's
          // tail) ends at this note-on, and if it was queued before a mute or
          // solo landed it would drone on.
          this._psgKeyedUntil[psgCh] = Math.min(this._psgKeyedUntil[psgCh], when);
          this._psgSetAtt(psgCh, this._psgOff(psgCh), when);
          break;
        }
        // A note starting: a chip that keys something on it hears it.
        this._psgWrites(this._lane(psgCh, (e, ch) => e.keyOn?.(ch, when, !!ev.args?.legato) ?? []), when);
        // A DDA note on this channel (another of its names) still sounding
        // ends here, its channel off a key-order lead before this key-on.
        if (this._toneEnc[psgCh]?.part?.sharePrio != null && this._ddaEncoder()) {
          const h = this._chipPcm?.owner.get(`dda-${this._toneEnc[psgCh].ch}`);
          if (h && h.t < when - 1e-9 && h.end > when + 1e-9 && !h.dumped) { h.end = when; h.cut = true; }
        }

        // The PSG's noise lane — but for a noise whose note is its rate (the
        // 2A03's: `rateNote`), pitched as a tone, its mode re-asserted.
        const rateNote = this._isNoiseLane(psgCh) && this._toneEnc[psgCh]?.part?.rateNote;
        const isNoise = this._isNoiseLane(psgCh) && !rateNote;
        const baseLengthTicks = ev.args.length;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const psgGateTicks = this._frameGate(when, this._resolveGateTicks(ev.args?.gate, lengthTicks), lengthTicks);
        // Monophonic priority: cut this note's macro tail a key-off lead before
        // the next note on this channel.
        const psgNextNote = this._nextNote(ev).secs;
        const psgMacroLimit = Number.isFinite(psgNextNote)
          ? psgNextNote - KEY_OFF_LEAD_SECS
          : Infinity;
        // :lfo-sync: the note's key-on, and each :keyon retrigger, start the
        // chip's LFO over (the PC Engine's $09 reset, the FDS's counter).
        if (this._laneLfoSync[psgCh] && !ev.args?.legato) {
          const retrigs = this._keyonRetrigTimes(ev.args?.keyon, when, psgGateTicks, psgMacroLimit) ?? [];
          for (const t of [when, ...retrigs.filter((r) => r > when + 1e-6)])
            this._psgWrites(this._lane(psgCh, (e, ch) => e.lfoReset?.(ch) ?? []), t);
        }
        if (rateNote) {
          // Its mode re-asserted, and the note's :mode macro, as the PSG's
          // noise has them; its rate is the pitch below.
          this._psgTriggerNoise(when, psgCh);
          this._envRetrigs = this._keyonRetrigTimes(ev.args?.keyon, when, psgGateTicks, psgMacroLimit);
          this._schedulePsgModeMacro(psgCh, ev.args?.noise_mode, when, psgGateTicks, psgMacroLimit);
          this._envRetrigs = null;
        }
        if (!isNoise) {
          const midi = pitchToMidi(ev.args?.pitch ?? "c4");
          this._psgCurrentMidi[psgCh] = midi;
          const psgCentOffset = this._onsetPitchOffset(ev, this._psgPitchOffset[psgCh] ?? 0);
          // Pitch macros first, as on FM: a first sample on the note is the
          // pitch it sounds from (the driver's onset_pitch).
          let onsetWritten = false;
          const psgPitchWrite = (centOffset, t, semi = 0) => {
            if (Math.abs(t - when) < 1e-9) onsetWritten = true;
            this._psgSetPitch(psgCh, midi + semi, centOffset, t);
          };
          const psgOffset = () => this._psgPitchOffset[psgCh] ?? 0;
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            psgGateTicks,
            psgPitchWrite,
            psgMacroLimit,
            psgOffset,
          );
          this._scheduleSemiMacro(
            ev.args?.note_semi,
            when,
            psgGateTicks,
            psgPitchWrite,
            psgMacroLimit,
            psgOffset,
          );
          if (!onsetWritten) this._psgSetPitch(psgCh, midi, psgCentOffset, when);
        } else {
          this._psgTriggerNoise(when, psgCh);
          this._envRetrigs = this._keyonRetrigTimes(ev.args?.keyon, when, psgGateTicks, psgMacroLimit);
          this._schedulePsgModeMacro(
            psgCh,
            ev.args?.noise_mode,
            when,
            psgGateTicks,
            psgMacroLimit,
          );
          this._envRetrigs = null;
        }
        if (psgGateTicks === 0) {
          // Hold note: register for runtime key-off (triggerKeyOff)
          this._holdChannels.set(this._holdKey(ev), ev._trackIndex);
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
        // A note's (macro :pan …), where the channel has a pan of its own.
        if (ev.args?.pan) {
          const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, psgGateTicks);
          this._scheduleMacro(ev.args.pan, noteFrames, gateSecs, when,
            (v, t) => this._psgSetPan(psgCh, v, t), this._stepSecs(ev.args.pan.step), psgMacroLimit);
        }
        // A note's (macro :wave …): its def-waves a step at a time.
        if (ev.args?.wave) {
          const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, psgGateTicks);
          this._laneExpr[psgCh] = null;
          this._scheduleMacro(ev.args.wave, noteFrames, gateSecs, when,
            (v, t) => this._writeLaneWaveIndex(psgCh, v, t, true), this._stepSecs(ev.args.wave.step), psgMacroLimit);
        }
        // A note's (macro :duty …), on a pulse (chips/rp2a03.js).
        if (ev.args?.duty) {
          const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, psgGateTicks);
          this._scheduleMacro(ev.args.duty, noteFrames, gateSecs, when,
            (v, t) => this._psgSetDuty(psgCh, v, t), this._stepSecs(ev.args.duty.step), psgMacroLimit);
        }
        this._schedulePsgWordMacro(mixMacro, when, psgGateTicks, psgMacroLimit,
          (v, t) => this._psgWrites(this._lane(psgCh, (e, ch) => e.mix?.(ch, Math.round(v), t) ?? []), t));
        this._schedulePsgWordMacro(rateMacro, when, psgGateTicks, psgMacroLimit,
          (v, t) => this._psgWrites(this._psg((c) => c.noiseRate?.(v) ?? [], "noiseRate"), t));
        // A lane on the envelope starts it over at a key-on (a slur's goes on).
        const envShape = this._psgEnv[psgCh];
        if (envShape >= 0 && !ev.args?.legato)
          this._psgWrites(this._psg((c) => c.envShape?.(envShape) ?? [], null, psgCh), when);
        const baseVel = ev.args?.vel ?? 15;
        const velMacro = ev.args?.velMacro ?? null;
        // Silence at the gate boundary; suppressed when the gate fills the note
        // and another note follows immediately. Unlike FM (whose key-off is what
        // the next note attacks from), a PSG note-on re-asserts its attenuation
        // and restarts its vel macro, so the attack is there either way and the
        // suppression only spares a needless gap; `~` holds the tone over.
        const psgGateEnd = this._timeAfterTicks(when, psgGateTicks);
        const psgOffWhen =
          psgGateTicks > 0 &&
          (ev.args?.gate != null || psgGateEnd < psgNextNote - 0.001)
            ? psgGateEnd
            : null;
        this._psgKeyedUntil[psgCh] = psgOffWhen ?? psgNextNote;
        const volMacro = ev.args?.vol ?? null;
        // A :keyon retrigger restarts the level envelopes (PSG has no
        // hardware one: this is the whole of the retrigger).
        this._envRetrigs = velMacro || volMacro ? this._keyonRetrigTimes(ev.args?.keyon, when, psgGateTicks, psgMacroLimit) : null;
        this._psgNoteLevel(psgCh, ev.args, when, psgGateTicks, baseVel, psgMacroLimit, psgOffWhen);
        this._envRetrigs = null;
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
        // in each frame its slots have moved (_waveExprFrames).
        if (ev.args?.expr && String(ev.args.target).toUpperCase() === "WAVE") {
          this._laneWave[psgCh] = null;
          const slots = [...waveSlots(ev.args.expr)];
          const vals = slots.map((n) => this._resolveSrc(n, when));
          this._laneExpr[psgCh] = { tree: ev.args.expr, slots, vals, nextFrame: this._eventFrame(when) + 1 };
          this._writeWaveExpr(psgCh, when);
          break;
        }
        this._word(ev, when, this._psgWord(psgCh, String(ev.args?.target ?? "").toUpperCase()));
        break;

      default:
        break;
    }
  }

  // A tone lane's word: where it is read and how it is written, or null
  // where the lane has none by that name.
  _psgWord(psgCh, target) {
    const int = (v) => Math.round(Number(v) || 0);
    switch (target) {
      // Sticky mask (language.md §5.3); the sounding note moves onto it.
      case "SNAP": return {
        read: () => this._psgSnap[psgCh] ?? 0,
        write: (v, t) => {
          this._psgSnap[psgCh] = Math.max(0, Math.min(0xfff, int(v)));
          if (!this._isNoiseLane(psgCh))
            this._psgSetPitch(psgCh, this._psgCurrentMidi[psgCh] ?? 60, this._psgPitchOffset[psgCh] ?? 0, t);
        },
      };
      // The fader: a keyed lane's level moves with it now (an idle one's
      // would drone a tone; its next note composes from it).
      case "VOL": return {
        read: () => this._lv(`psg:${psgCh}`).vol,
        write: (v, t) => {
          this._lvSetVol(`psg:${psgCh}`, v);
          if (this._psgKeyed(psgCh, t)) this._psgRecompose(psgCh, t);
        },
      };
      // The lane's level on the envelope (a shape), or its own (-1): a
      // sounding note changes over now; the shape starts at its key-on.
      case "SSG_ENV": return {
        read: () => this._psgEnv[psgCh] ?? -1,
        write: (v, t) => {
          const shape = Math.round(Number(v));
          this._psgEnv[psgCh] = !(shape >= 0) ? -1 : Math.min(15, shape);
          if (this._psgSounding[psgCh] && this._psgKeyed(psgCh, t)) this._psgRecompose(psgCh, t);
        },
      };
      // The lane's moves on its envelope's period: a period following its
      // notes moves now, a rate it writes at its next write.
      case "ENV_SEMI":
      case "ENV_DETUNE": {
        const of = target === "ENV_SEMI" ? this._envSemi : this._envDetune;
        return {
          read: () => of[psgCh] ?? 0,
          write: (v, t) => {
            of[psgCh] = int(v);
            if (this._envFollow === psgCh && this._psgHz[psgCh] > 0)
              this._writeEnvPeriod(this._psgHz[psgCh], this._envBy(psgCh), t);
          },
        };
      }
      // The SSG channel's mixer: tone, noise or both (chips/ssg.js).
      case "SSG_MIX": return {
        read: () => this._ssgMixBase[psgCh] ?? 0,
        write: (v, t) => {
          this._ssgMixBase[psgCh] = int(v);
          this._psgWrites(this._lane(psgCh, (e, ch) => e.mix(ch, this._ssgMixBase[psgCh], t)), t);
        },
      };
      // :lfo-sync: the lane's key-ons start the chip's LFO over.
      case "LFO_SYNC": return {
        read: () => (this._laneLfoSync[psgCh] ? 1 : 0),
        write: (v) => { this._laneLfoSync[psgCh] = Number(v) >= 0.5; },
      };
      // Channel 1 taking the wave chip's LFO (chips/huc6280.js).
      case "FM_FMS": return {
        read: () => this._laneFms?.[psgCh] ?? 0,
        write: (v, t) => {
          (this._laneFms ??= [])[psgCh] = Number(v);
          this._psgWrites(this._lane(psgCh, (e, ch) => e.lfo?.(ch, Number(v)) ?? []), t);
        },
      };
      // A pulse's duty in sixteenths; the encoder takes the nearest the
      // chip has. Its sweep steps in the driver's integers.
      case "DUTY": {
        const read = () => this._psgDuty[psgCh] ?? 8;
        const write = (v, t) => this._psgSetDuty(psgCh, v, t);
        return { read, write, sweep: (ev, when) => this._sweepUnits(ev, when, read(), write) };
      }
      // A channel's own pan (the PC Engine's $05), its sweep on the
      // encoder's fifteenths of a side.
      case "PAN": {
        const read = () => this._psgPan[psgCh];
        const write = (v, t) => this._psgSetPan(psgCh, v, t);
        return { read, write, sweep: (ev, when) => this._sweepUnits(ev, when, read(), write, 15) };
      }
      // A wave channel's def-wave (metadata.waves): its memory written
      // whole (chips/k051649.js — channels 4 and 5 share one).
      case "WAVE": return {
        read: () => this._laneWaveAt?.[psgCh] ?? -1,
        write: (v, t) => {
          this._laneExpr[psgCh] = null;
          (this._laneWaveAt ??= [])[psgCh] = v;
          this._writeLaneWaveIndex(psgCh, v, t);
        },
      };
      // The persistent noise mode, re-asserted on every noise NOTE_ON; a
      // sounding channel takes it now.
      case "NOISE_MODE": return {
        read: () => this._psgNoiseMode,
        write: (v, t) => {
          this._psgNoiseMode = this._snapMacroOutput("NOISE_MODE", v);
          if (this._psgSounding[psgCh]) this._psgSetNoiseCfg(this._psgNoiseMode, t, psgCh);
        },
      };
      // The lane's offset, on the note sounding then.
      case "NOTE_PITCH": return {
        read: () => this._psgPitchOffset[psgCh] ?? 0,
        write: (v, t) => {
          const cents = Math.round(v);
          this._psgPitchOffset[psgCh] = cents;
          this._psgSetPitch(psgCh, this._psgCurrentMidi[psgCh] ?? 60, cents, t);
        },
      };
      default: return null;
    }
  }

  _writeKeyOff(chIndex) {
    this._fmKey(chIndex, 0); // all operators off
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

