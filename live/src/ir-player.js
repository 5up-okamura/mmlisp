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
import { DMC_RATES, dmcRate, dmcEncode } from "./chips/rp2a03.js";
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
const CORE_OF_KIND = { fm: "fm", tone: "psg", noise: "psg", wave: "psg", sample: "sample" };
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
};
// The song-wide LFO words: the OPN's rate, the OPM's own (chips/ym2151.js).
const LFO_TARGETS = new Set(["LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE"]);
// The song's LFO words a wave chip's encoder takes (chips/huc6280.js, fds.js).
const WAVE_LFO_WORDS = { LFO_FREQ: "lfoFreq", LFO_PMD: "lfoPmd", LFO_WAVE: "lfoTable" };
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

// The driver's order of FM3 key edges (IRPlayer._scheduleFm3OpKey): by frame,
// then the tracks' dispatch before the macros, then track (or operator), then
// time — where a key-off and a key-on at the same time go off first.
function fm3KeyOrder(a, b) {
  return (
    a.frame - b.frame ||
    a.phase - b.phase ||
    a.order - b.order ||
    (Math.abs(a.t - b.t) > 1e-6 ? a.t - b.t : a.on - b.on)
  );
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
    Object.defineProperty(this, "_write", {
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
    this._ir = null;
    this._playing = false;
    this._loopCount = new Map(); // loopId → iteration count
    this._eventIndex = 0;
    this._currentTick = 0;
    this._ppqn = 96; // the IR's own (ir.md §2)
    this._bpm = 120;
    this._tempoSweep = null;
    this._tempoOverride = false; // set once the tempo is dialled in live
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
    this._masterSweep = null; // a running :master sweep (its frames are scheduled up front)
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
    this._pitchSweepOnset = new Map(); // key → { when, offset }
    this._psgVol = new Array(PSG_LANES).fill(VOL_UNITY); // channel vol 0-31 per PSG ch
    this._psgLastVel = new Array(PSG_LANES).fill(15); // last note vel 0-15 per PSG ch (raw, for composition)
    this._psgLevelAhead = new Array(PSG_LANES).fill(false); // the current note's level macros took its :vol sets in
    this._psgVolSweep = new Array(PSG_LANES).fill(null); // active VOL sweep state per PSG ch
    this._psgKeyedUntil = new Array(PSG_LANES).fill(0); // when the current note keys off
    // Whether each PSG ch is currently sounding a note (att under its off). A PSG channel
    // drones whenever its attenuation is non-silent, regardless of frequency, so
    // master/vol recomputes must NOT re-write a non-silent att to an idle channel
    // (that would un-silence it into a tone). Updated on every _psgSetAtt.
    this._psgSounding = new Array(PSG_LANES).fill(false);
    this._laneWave = new Array(PSG_LANES).fill(null); // the def-wave each wave lane plays (by name)
    this._psgPan = new Array(PSG_LANES).fill(0); // each lane's pan as last written (a chip with a pan per channel: the PC Engine's)
    this._psgDuty = new Array(PSG_LANES).fill(8); // each lane's duty in sixteenths (the 2A03's pulses)
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
    this._fmVolSweep = new Array(FM_CHANNELS).fill(null);
    this._fmLevelLines = new Array(FM_CHANNELS).fill(null); // a note's :vel/:vol macro timelines
    this._fm3LevelLines = new Array(FM_OPS).fill(null); // ...an FM3 operator note's
    // Inline sweeps on the other FM params, per channel: target → sweep. The
    // sweep's frames are scheduled at once (leaving the shadow state at `to`),
    // so later events on the channel first re-sync their state to the sweep's
    // value at their own time (_syncParamSweeps).
    this._paramSweeps = Array.from({ length: FM_CHANNELS }, () => new Map());

    // Mute / solo state keyed by track index (a track == one sounding channel,
    // e.g. fm3-1, pcm1). Solo overrides mute: when any track is soloed, only
    // soloed tracks sound.
    this._mutedTracks = new Set();
    this._soloTracks = new Set();
    // The YM2608's sample voices as the mixer has them: the six rhythm sounds
    // ("bd" … "rim") and the ADPCM-B ("adpcm"), whichever track keys them.
    this._mutedVoices = new Set();
    this._soloVoices = new Set();
    this._voiceUiVol = new Map(); // voice → the mixer's vol 0-31

    // Channels holding a note until triggerKeyOff() (`:len 0` or `:gate 0`):
    // channel id → the track that keyed it.
    this._holdChannels = new Map();

    // FM3 independent-operator mode: each fm3-1..fm3-4 track keys a single
    // operator of channel 3 via the shared 0x28 key register (see
    // _scheduleFm3OpKey / _flushFm3Keys).
    this._resetFm3Keys();
    // FM3 independent-OP: each operator's own note, sticky :pitch offset
    // and level (index = op − 1) — what its F-number and TL are written
    // from (driver.md §13.4).
    this._fm3Op = Array.from({ length: FM_OPS }, () => ({
      midi: 60, offset: 0, vel: 15, velBase: 15, vol: VOL_UNITY,
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
    this._toneEnc = this._toneEncodersOf(target, this._psgChip);
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
    this._bpm = this._resolveInitialTempo(irObj);
    this._tempoSweep = null;
    this._tempoOverride = false; // a newly loaded score starts at its own tempo
    // Dynamic value slots (§8): name → current value, seeded from def-val inits.
    // The host (or live UI) mutates these via setVal(); scores read them with
    // $name and PARAM_FROM_VAL / PARAM_ADD / PARAM_MUL.
    this._vals = {};
    this._valUnits = {}; // slot → "frame" | "tick" (for dynamic :len/:step)
    this._valNames = []; // slot index → name, for the VALn write targets
    this._valSweeps = {}; // name → the score's running sweep of that slot
    for (const v of irObj.metadata?.vals ?? []) {
      this._vals[v.name] = toSlotValue(v.init) ?? 0;
      this._valUnits[v.name] = v.unit ?? "frame";
      this._valNames[v.slot] = v.name;
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
      midi: 60, offset: 0, vel: 15, velBase: 15, vol: VOL_UNITY,
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
    this._fm3TlQueue = [];
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
    // A sample track's range, loop and pan are its run's: a second run, or
    // the score reloaded, starts from the track's own again.
    this._pcm8State = this._ddaState = this._dpcmState = null;
    this._chRegs = Array.from({ length: FM_CHANNELS }, (_, i) => buildChannelRegState(i));
    this._pcmSample = [null, null, null];
    this._lfoRate = 0;
    this._opmLfo = { freq: 0, pmd: 0, amd: 0, wave: 0 };
    this._masterVol = VOL_UNITY;
    this._chipPcm = null; // the YM2608's sample voices' levels (_chipPcmFrames)
    this._laneExpr?.fill(null); // a wave expression is its run's (_waveExprFrames)
    this._psgPan?.fill(0);
    this._psgDuty?.fill(8);
    this._pcmVolNow = null; // each PCM voice's :vol, where a sweep starts from
    this._reg27 = 0; // FM3 special / CSM mode
    this._fm3Ops = false;
    this._csmHold = false; // a rate rest stopped Timer A (driver.md §9)
    this._psgCurrentMidi.fill(60);
    this._psgPitchOffset.fill(0);
    this._psgSnap.fill(0);
    this._pitchSweepOnset.clear();
    this._psgVol.fill(VOL_UNITY);
    this._psgLastVel.fill(15);
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
    this._fmVolSweep.fill(null);
    this._psgVolSweep.fill(null);
    this._psgKeyedUntil.fill(0);
    this._masterSweep = null;
    for (const m of this._paramSweeps) m.clear();
  }

  /** Returns true if playback is currently running. */
  isPlaying() {
    return this._playing;
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
    this.seek(audioContext, line == null ? { sec: 0 } : { line });
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
    const saved = { write: this._write, onLine: this._onLine, onSeq: this._onSeq, onTrig: this._onTrig, onHold: this._onHold };
    const held = [];
    this._onLine = this._onSeq = this._onTrig = this._onHold = null;
    this._write = (portOrMsg, addr, data, when) => {
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
      // tempo change put it); a tempo dialled in live stays.
      if (!this._tempoOverride) this._bpm = this._resolveInitialTempo(this._ir);
      this._tempoSweep = null;
      this._audioContext = clock;
      this._playing = true;
      this._startAudioTime = start;
      this._scheduledHorizon = 0; // the queue was flushed
      this._frameOrigin = start;
      this._initDefaultVoices();
      this._resetFm3Keys();
      this._fm3Op = Array.from({ length: FM_OPS }, () => ({
        midi: 60, offset: 0, vel: 15, velBase: 15, vol: VOL_UNITY,
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
      this._write = saved.write;
      this._onLine = saved.onLine;
      this._onSeq = saved.onSeq;
      this._onTrig = saved.onTrig;
      this._onHold = saved.onHold;
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

  setVoiceVol(voice, vol) {
    this._voiceUiVol.set(voice, Math.max(0, Math.min(31, Math.round(vol))));
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
      this._fm3KeyQueue = this._fm3KeyQueue.filter((e) => !(e.on && e.bit & fm3Off));
      this._fm3Held &= ~fm3Off;
      this._fm3Mask &= ~fm3Off;
      this._fm3KeyLast = Math.max(when, this._fm3KeyLast);
      this._fmKey(2, this._fm3Mask, this._fm3KeyLast);
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
    for (const [voice, hits] of this._chipPcm?.hits ?? []) {
      if (this._isVoiceAudible(voice)) continue;
      // A PCM8 voice is cut from the mix.
      const h = hits.at(-1);
      if (h?.pcm8 != null) { this._pcm8Ev(when, { kind: "cut", voice: h.pcm8 }); continue; }
      const writes = voice === "adpcm" ? adpcm.stop() : this._rhythmEnc.dump(voice, when);
      for (const [p, a, d] of writes) this._write(p, a, d, when);
    }
    // The 2A03's DMC: its track muted, the sample stops.
    const dmc = this._target?.chipFor?.("fc-dpcm")?.dmc;
    if (dmc) for (const [ti] of this._lanesOf("sample", "fc-dpcm"))
      if (!this._isVoiceTrackAudible(ti, "dpcm")) for (const [p, a, d] of dmc.stop()) this._write(p, a, d, when);
  }

  /**
   * Live mixer fader for a PSG channel. vol 0-31 (31=max, 0=silent). Sets the
   * sticky channel vol and re-applies attenuation immediately.
   * @param {number} psgCh 0-3 (0=sqr1 … 3=noise)
   * @param {number} vol   0-31
   */
  setPsgVol(psgCh, vol) {
    if (psgCh < 0 || psgCh >= PSG_LANES) return;
    const v = Math.max(0, Math.min(31, vol));
    this._psgVol[psgCh] = v;
    this._psgVolSweep[psgCh] = null;
    // Store the fader value; only push a live attenuation if the channel is
    // actually sounding. Otherwise the next note-on picks up the new vol — a
    // fader move must never un-silence an idle channel into a tone.
    if (!this._psgSounding[psgCh]) return;
    const when = this._audioContext?.currentTime ?? 0;
    const vel = this._psgLastVel[psgCh] ?? 15;
    const master = this._masterVol ?? VOL_UNITY;
    this._psgSetAtt(psgCh, this._composePsgAtt(psgCh, vel, v, master), when);
  }

  /**
   * Live mixer fader for a PCM track, keyed by track index. vol 0-31 → a linear
   * gain the worklet applies to the voice's samples before its rung — a
   * preview convenience the driver does not have.
   * @param {number} trackIndex
   * @param {number} vol 0-31
   */
  setPcmTrackVol(trackIndex, vol) {
    if (trackIndex == null) return;
    // pc88's pcm1 is the chip's ADPCM-B, not a voice of the worklet's engine.
    if (this._routes.get(trackIndex)?.part.name === "adpcm-b") return this.setVoiceVol("adpcm", vol);
    this._write({
      type: "pcm-set-vol",
      track: trackIndex,
      gain: levelGain({ faders: [vol] }),
    });
  }

  /** Current tempo in BPM (changes during playback via tempo events / sweeps). */
  getBpm() {
    return this._bpm;
  }

  /**
   * Live tempo override. Clears any active tempo sweep. While playing, applies at
   * the current position so timing stays continuous; otherwise sets the base tempo.
   * @param {number} bpm
   */
  setTempo(bpm) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    // Dialled in live: hold it against the score's own tempo events (including
    // the tick-0 one a loop replays) for the rest of this run. Loading an IR
    // clears the override, so a fresh score still starts at its written tempo.
    this._tempoOverride = true;
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
          this._fm3KeyQueue = this._fm3KeyQueue.filter((e) => !(e.on && e.bit & held));
          this._fm3Mask &= ~held;
          this._fm3KeyLast = Math.max(when, this._fm3KeyLast);
          this._fmKey(2, this._fm3Mask, this._fm3KeyLast);
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

  // Commit a pending swap: load the incoming IR and anchor its tracks so that
  // tick=boundaryTick lands exactly on boundaryTime, continuing the global
  // position. Called from _scheduleLoop once the boundary is within the horizon.
  _commitSwap() {
    const { irObj, boundaryTick, boundaryTime } = this._pendingSwap;
    this._pendingSwap = null;
    this._scheduleCapTime = Infinity;

    // Load new IR (does not touch callbacks, _playing, or _audioContext).
    this.loadJSON(irObj);

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
   * Register a callback fired when a `(trig N)` cue (IR TRIG) plays — the
   * moment a game polling the track's status byte would see it change.
   * @param {((trackIdx: number, code: number) => void) | null} fn
   */
  setOnTrig(fn) {
    this._onTrig = fn;
  }

  /**
   * Register a callback fired by play() once the run state is reset and before
   * the first event is scheduled: where a UI mixer (master, channel vol)
   * re-applies itself, since the reset returns those levels to unity.
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

    if (this._scheduleStep(now, horizon)) return;

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
    // A wave expression follows its slots to the horizon — and once the song
    // is done, to the end of its last note.
    this._waveExprFrames(done ? Math.max(horizon, this._songEndTime()) : horizon);
    // The SSG's mixer changes up to `horizon`, in time order (chips/ssg.js).
    this._flushEncoders(done ? Infinity : horizon);
    // Every hit up to `horizon` is known now: the chip's sample voices'
    // levels can be written up to it — and once the song is done, on to the
    // end of what still sounds.
    if (this._chipPcm) {
      let until = horizon;
      if (done)
        for (const hits of this._chipPcm.hits.values()) {
          const end = hits.at(-1)?.end;
          if (Number.isFinite(end)) until = Math.max(until, end);
        }
      this._chipPcmFrames(until);
      // A rhythm whose registers hold several sounds (the OPLL's) writes its
      // queue now, in time order (chips/ym2413.js).
      for (const [p, a, d, t] of this._rhythmEnc?.flush?.(until) ?? []) this._write(p, a, d, t);
    }
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
    const done =
      !willLoopAny &&
      this._tracks.every((t) => t.flatIndex >= t.events.length);
    // Every event up to the horizon is dispatched, so the frames before the
    // horizon's own have all their FM3 key edges.
    this._flushFm3Keys(done ? Infinity : this._eventFrame(horizon) - 1);
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
        this._dispatchEvent(ev, this._target.frameClock ? this._frameStart(evTime) : evTime);
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
      write: this._write,
      onLine: this._onLine,
      onSeq: this._onSeq,
      onTrig: this._onTrig,
      onHold: this._onHold,
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

    this._write = (portOrMsg, addr, data, when) => {
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
        midi: 60, offset: 0, vel: 15, velBase: 15, vol: VOL_UNITY,
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
      this._flushFm3Keys();
    } finally {
      this._write = saved.write;
      this._onLine = saved.onLine;
      this._onSeq = saved.onSeq;
      this._onTrig = saved.onTrig;
      this._onHold = saved.onHold;
      this._audioContext = saved.ctx;
      this._loop = saved.loop;
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
  // The operator's vol at `when`: a :vol sweep on an fm3-N track is stepped
  // per frame by the driver, so a note landing mid-sweep has to read the
  // instantaneous value here, exactly as a channel's does (_fmVolAtTime).
  _fm3OpVolAtTime(op, when) {
    const st = this._fm3Op[op - 1];
    return st.volSweep ? this._sweepVolAtTime(st.volSweep, when) : st.vol;
  }
  // `when` given: the operator's LIVE level then — its note's :vel/:vol macro
  // samples (_fm3LevelLines), else its velocity and fader. `over` pins any of
  // vel / vol / group / master for a caller that has its own value.
  _fm3OpTl(op, when, over = {}) {
    const st = this._fm3Op[op - 1];
    // CSM (driver.md §9): Timer A keys CH3, so an operator's key is its level —
    // outside its note it is held at TL 127, whatever else recomposes it.
    if (this._reg27 & 0x80 && when !== undefined && st.csmOn !== undefined
      && (when < st.csmOn - 1e-6 || when >= st.csmOff - 1e-6)) return 127;
    const regs = this._chRegs[2];
    const lines = when === undefined ? null : this._fm3LevelLines[op - 1];
    const vel = over.vel ?? this._lineAt(lines?.vel, when) ?? st.vel;
    const vol = over.vol ?? this._lineAt(lines?.vol, when)
      ?? (when === undefined ? st.vol : this._fm3OpVolAtTime(op, when));
    return levelSteps(this._fmLevel, {
      base: regs.ops[op - 1].voicedTl ?? 0, vel, k: velK(regs.ops[op - 1].velK, true),
      faders: [vol, over.group ?? regs.vol ?? VOL_UNITY, over.master ?? this._masterVol ?? VOL_UNITY],
    });
  }
  _writeFm3OpTl(op, when, over = {}) {
    const o = this._chRegs[2].ops[op - 1];
    o.tl = this._fm3OpTl(op, when, over);
    // Under CSM an operator's level is its key, and a rest on the rate track
    // dispatched after this note silences it through the rest (driver.md §9):
    // the write waits in a queue until no later dispatch can reach its frame
    // (_flushFm3Keys), where a rest spanning it turns it into 127.
    if (this._reg27 & 0x80 && this._fm3Ops && when !== undefined) {
      this._fm3TlQueue.push({ t: when, frame: this._eventFrame(when), seq: this._fm3TlSeq++, op, tl: o.tl });
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
  // `over` pins any of vel / vol / master for a caller that has its own value.
  // The one place a normal channel's level is composed (§7).
  _writeFmLevel(ch, when, over = {}) {
    const regs = this._chRegs[ch];
    const vel = over.vel ?? this._fmLiveVelAt(ch, when);
    const vol = over.vol ?? this._fmLiveVolAt(ch, when);
    const master = over.master ?? this._masterAt(when);
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
      this._fmLiveVelAt(ch, when),
      this._fmLiveVolAt(ch, when),
      this._masterVol ?? VOL_UNITY,
      carrier,
    );
  }

  // The cent offset a note starting at `when` sounds with: the first value of
  // a NOTE_PITCH sweep that began at that same instant (a glide), else the
  // channel's standing offset `fallback`.
  _onsetPitchOffset(key, when, fallback) {
    const onset = this._pitchSweepOnset.get(key);
    return onset && Math.abs(onset.when - when) < 1e-9 ? onset.offset : fallback;
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
  // no later dispatch can add to their frame (_flushFm3Keys), so the preview
  // writes the driver's mask sequence.
  _resetFm3Keys() {
    this._fm3TlQueue = []; // CSM operators' level writes, flushed with the key edges
    this._fm3TlSeq = 0;
    this._csmHoldSpans = []; // [start, end) in audio time: the rate track's rests
    this._fm3KeyQueue = [];
    this._fm3Mask = 0; // the operator bits $28 holds
    this._fm3Held = 0; // operators keyed by a hold (len 0) note
    this._fm3KeyLast = -Infinity; // the last $28 write's time
  }

  /**
   * Queue one FM3 operator note's key edges.
   * @param {number} opBit  operator key bit (0x10=OP1 … 0x80=OP4)
   * @param {number} onTime audio time of key-on
   * @param {number|null} offTime audio time of key-off, or null for a hold note
   * @param {{off: number, on: number}[]} retriggers :keyon re-attacks, in time order
   * @param {number} track  the note's track index (its dispatch order)
   */
  _scheduleFm3OpKey(opBit, onTime, offTime, retriggers, track) {
    const q = this._fm3KeyQueue;
    const edge = (t, frame, phase, order, on) =>
      q.push({ t, frame, phase, order, on, bit: opBit });
    edge(onTime, this._eventFrame(onTime), 0, track, true);
    // A full-gate note's key-off lands in the next note's dispatch, before its
    // key-on: same frame, same track, earlier in the sort (_fm3KeyOrder).
    if (offTime == null) this._fm3Held |= opBit;
    else edge(offTime, this._eventFrame(offTime), 0, track, false);
    const op = Math.log2(opBit) - 4;
    for (const r of retriggers) {
      if (offTime != null && r.on >= offTime) break;
      const frame = this._eventFrame(r.on);
      edge(r.off, frame, 1, op, false);
      edge(r.on, frame, 1, op, true);
    }
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

  // Write the queued FM3 key edges of every frame up to `uptoFrame`.
  _flushFm3Keys(uptoFrame = Infinity) {
    const q = this._fm3KeyQueue;
    if (q.length) {
      q.sort(fm3KeyOrder);
      let n = 0;
      for (; n < q.length && q[n].frame <= uptoFrame; n++) {
        const e = q[n];
        if (e.on) this._fm3Mask |= e.bit;
        else this._fm3Mask &= ~e.bit;
        // Never behind the previous write: the worklet applies them in time order.
        this._fm3KeyLast = Math.max(e.t, this._fm3KeyLast);
        this._fmKey(2, this._fm3Mask, this._fm3KeyLast);
      }
      q.splice(0, n);
    }
    // CSM operators' levels (_writeFm3OpTl): a rest on the rate track that
    // spans a write silences it.
    const tq = this._fm3TlQueue;
    if (tq.length) {
      tq.sort((a, b) => a.frame - b.frame || a.t - b.t || a.seq - b.seq);
      let n = 0;
      for (; n < tq.length && tq[n].frame <= uptoFrame; n++) {
        const e = tq[n];
        this._fmWrites(this._fmEnc.ch3Tl(e.op - 1, this._inCsmHold(e.t) ? 127 : e.tl), e.t);
      }
      tq.splice(0, n);
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
      // §9) — a span the queued level writes read (_flushFm3Keys), and an
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

  _dispatchEvent(ev, when) {
    this._syncMasterSweep(ev, when);
    if (this._dispatchGlobalEvent(ev, when)) return;
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
    const lfoLane = this._toneEnc.findIndex((l) => l?.enc.lfoFreq);
    const lfoWord = lfoLane >= 0 && /^PARAM_/.test(ev.cmd) ? WAVE_LFO_WORDS[ev.args?.target] : null;
    if (lfoWord && this._toneEnc[lfoLane].enc[lfoWord]) {
      const write = (v, t) => this._psgWrites(this._lane(lfoLane, (e) => e[lfoWord](v)), t);
      const cur = this._waveLfo[lfoWord] ?? 0;
      const a = ev.args ?? {};
      if (lfoWord === "lfoTable") { if (ev.cmd === "PARAM_SET") write(a.table ?? [], when); }
      else if (ev.cmd === "PARAM_SET" || ev.cmd === "PARAM_SWEEP")
        this._writeSongRate(ev, when, cur, (v, t) => write((this._waveLfo[lfoWord] = v), t));
      else {
        const v = ev.cmd === "PARAM_ADD" ? cur + Number(a.delta ?? 0)
          : ev.cmd === "PARAM_MUL" ? cur * Number(a.factor ?? 1)
          : ev.cmd === "PARAM_FROM_VAL" ? Number(this._resolveSrc(a.src, when) ?? cur) : null;
        if (v != null) write((this._waveLfo[lfoWord] = Math.round(v)), when);
      }
      return;
    }
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
    this._syncParamSweeps(ch, when);
    // A write to a swept target ends that sweep (the driver frees its slot).
    if (ev.cmd === "PARAM_SET" || ev.cmd === "PARAM_SWEEP_STOP")
      this._paramSweeps[ch].delete(
        this._paramSweepKey(ev, String(ev.args.target).toUpperCase()),
      );

    switch (ev.cmd) {
      case "NOTE_ON": {
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        const fm3Op = Number(ev.args?.fm3Op);
        const isFm3OpNote =
          ch === 2 && Number.isInteger(fm3Op) && fm3Op >= 1 && fm3Op <= 4;
        const centOffset = this._onsetPitchOffset(
          `fm:${ch}`,
          when,
          this._chRegs[ch]?.pitchOffset ?? 0,
        );
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
          this._fm3LevelLines[fm3Op - 1] = null;
          this._fm3Op[fm3Op - 1].vel = ev.args?.vel ?? 15;
          // The note's span, CSM's level key (_fm3OpTl); its end is set once
          // the gate is resolved below.
          this._fm3Op[fm3Op - 1].csmOn = when;
          this._fm3Op[fm3Op - 1].csmOff = Infinity;
          this._writeFm3OpTl(fm3Op, when);
        } else {
          this._fmLevelLines[ch] = null;
          regs.vel = ev.args?.vel ?? 15; // track sticky vel for later VOL/MASTER recalcs
          this._writeFmLevel(ch, when, { master: this._masterVol ?? VOL_UNITY });
          this._followMasterSweep(ch, when);
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
        const levelLines = this._levelMacroLines(ev.args ?? {}, when, gateTicks, macroLimit);
        if (isFm3OpNote) this._fm3LevelLines[fm3Op - 1] = levelLines;
        else this._fmLevelLines[ch] = levelLines;
        this._scheduleFmLevelMacros(ch, fm3Op, levelLines);
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
            const lines = this._fm3LevelLines[fm3Op - 1];
            const ends = [lines?.vel?.end, lines?.vol?.end].filter((e) => e != null);
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

      case "PARAM_SET": {
        this._applyParam(ch, ev, when);
        break;
      }

      // A `$slot` write (§8). Resolved at dispatch time; with the Web Audio
      // look-ahead this trails live setVal() by the scheduler window —
      // acceptable for the reference player (the driver reads the slot as the
      // event runs).
      case "PARAM_FROM_VAL": {
        const value = this._resolveSrc(ev.args?.src, when);
        this._applyParam(
          ch,
          { args: { target: ev.args?.target, value }, _trackIndex: ev._trackIndex },
          when,
        );
        break;
      }
      case "PARAM_ADD":
      case "PARAM_MUL": {
        const target = ev.args?.target;
        const cur = this._readParam(ch, target, this._fm3OpOf(ev));
        let value;
        if (ev.cmd === "PARAM_ADD") {
          value = cur + this._resolveOperand(ev.args?.delta, when);
        } else {
          // Unsigned 8.8, as the driver multiplies (opcodes.md PARAM_MUL /
          // PARAM_MUL_VAL): a literal factor is ×256 rounded, a slot IS the
          // 8.8 factor (256 = ×1, 128 = ×½ — the /256 a scaled macro's depth
          // slot reads too), and the product drops its fraction.
          const f = ev.args?.factor;
          const fixed = f && typeof f === "object" && "src" in f
            ? this._resolveSrc(f.src, when)
            : Math.round((Number(f) || 0) * 256);
          value = Math.floor((Math.round(cur) * Math.max(0, Math.min(0xffff, fixed))) / 256);
        }
        this._applyParam(ch, { args: { target, value }, _trackIndex: ev._trackIndex }, when);
        break;
      }

      case "PARAM_SWEEP": {
        this._applyParamSweep(ch, ev, when);
        break;
      }

      case "PARAM_SWEEP_STOP": {
        // Freeze a running inline sweep. The preceding sweep's frame writes are
        // already bounded to this tick by _resolveSweepEndTick, so most targets
        // simply hold their last written register value. VOL keeps persistent
        // sweep state, so freeze it explicitly at the current value.
        const target = (ev.args?.target ?? "").toUpperCase();
        if (target === "VOL") {
          this._chRegs[ch].vol = this._fmVolAtTime(ch, when);
          this._fmVolSweep[ch] = null;
        }
        break;
      }

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
        const offset = this._onsetPitchOffset(`op:${op}`, when, st.offset);
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
  _dispatchDacEvent(ev, when) {
    const voice = ev._chIndex ?? 0;
    switch (ev.cmd) {
      case "PCM_NOTE_ON":
        this._dispatchPcmNoteOn(ev, when);
        break;
      case "PCM_NOTE_OFF":
        this._pcmEv(when, { kind: ev.args?.mode === "gate" ? "cut" : "off", voice });
        break;
      case "PARAM_SET":
        this._applyPcmParam(voice, ev.args, when);
        break;
      case "PARAM_FROM_VAL": {
        const value = this._resolveSrc(ev.args?.src, when);
        this._applyPcmParam(voice, { target: ev.args?.target, value }, when);
        break;
      }
      case "PARAM_SWEEP": {
        const target = (ev.args?.target ?? "").toUpperCase();
        if (PCM_POINT_TARGETS.has(target)) this._schedulePcmLoopSweep(voice, ev, when);
        else if (target === "VOL") this._schedulePcmVolSweep(voice, ev, when);
        break;
      }
      default:
        break;
    }
  }

  _pcmEv(when, fields) {
    this._write({ type: "pcm-ev", when, ...fields });
  }

  // A point, from the IR's seconds to the engine's byte offset — the
  // same multiply and clamp the MMB exporter applies (export-mmb.js
  // targetValue), at the rate of the image the score names.
  _pcmLoopBytes(sec) {
    const rate = this._pcmBankRate ?? engineImage(Math.max(1, this._ir?.metadata?.pcmVoices ?? 1), this._ir?.metadata?.frameHz).rateHz;
    return Math.max(0, Math.min(PCM_LOOP_MAX, Math.round(Number(sec ?? 0) * rate)));
  }

  // A :vol sweep on a PCM voice: the fader stepped a frame at a time, as the
  // driver's sweep engine steps the voice's bank (driver.md §14), from where
  // it is unless the sweep names a :from, to the track's next :vol write.
  _schedulePcmVolSweep(voice, ev, when) {
    const a = ev.args ?? {};
    const df = this._curveFields(a, when);
    const from = Math.max(0, Math.min(31, Number(df.from ?? this._pcmVolNow?.[voice] ?? VOL_UNITY)));
    const baseFrames = a.lenFrames
      ? Math.max(1, Math.round(Number(a.frames ?? 1)))
      : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
    const sw = {
      from, to: Math.max(0, Math.min(31, Number(df.to ?? from))), curve: a.curve ?? "linear",
      params: df.params, baseFrames, loop: !!a.loop, startFrame: this._eventFrame(when), startWhen: when,
    };
    const budget = this._resolveSweepBudgetFrames(ev);
    let last = null;
    for (let f = 0; f < budget; f++) {
      const v = Math.round(this._sweepAt(sw, f));
      if (v !== last) this._pcmEv(this._sweepFrameTime(sw, f), { kind: "vol", voice, value: v });
      last = v;
      if (!sw.loop && f >= baseFrames - 1) break;
    }
    (this._pcmVolNow ??= [])[voice] = last;
  }

  _applyPcmParam(voice, args, when) {
    const target = (args?.target ?? "").toUpperCase();
    const value = args?.value ?? 0;
    if (target === "VOL") (this._pcmVolNow ??= [])[voice] = value;
    if (target === "VOL" || target === "VEL") {
      this._pcmEv(when, { kind: target === "VOL" ? "vol" : "vel", voice, value });
    } else if (target === "MASTER") {
      this._applyMasterChange(value, when);
    } else if (PCM_POINT_TARGETS.has(target)) {
      this._pcmEv(when, { kind: "point", voice, target, value: this._pcmLoopBytes(value) });
    }
    // everything else is FM/PSG-only
  }

  // The SSG's noise period (NOISE_RATE) and envelope rate (ENV_RATE),
  // song-wide like LFO_RATE: a value, or a sweep stepped a frame at a time as
  // the driver's sweeps are, written when it moves and running to the
  // track's next write of it (its budget, as every sweep's).
  // `scale`: the sweep's steps a whole value's fraction (ENV_RATE's Hz).
  _writeSongRate(ev, when, start, write, scale = 1) {
    if (ev.cmd === "PARAM_SET") write(Number(ev.args?.value ?? start), when);
    if (ev.cmd !== "PARAM_SWEEP") return;
    const a = ev.args ?? {};
    const df = this._curveFields(a, when);
    const from = Math.round(Number(df.from ?? start) * scale), to = Math.round(Number(df.to ?? from / scale) * scale);
    const len = a.lenFrames
      ? Math.max(1, Math.round(Number(a.frames ?? 1)))
      : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
    const loop = !!a.loop;
    const budget = this._resolveSweepBudgetFrames(ev);
    const id = curveId(a.curve);
    let last = null;
    for (let f = 0; f < budget; f++) {
      const v = sweepFrameValue(id, from, to, len, loop, f) / scale;
      if (v !== last) write(v, when + f / 60);
      last = v;
      if (!loop && f >= len - 1) break;
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

  // The YM2608's sample voices — the ADPCM-B and the six rhythm sounds — and
  // their levels, which move while they sound: a track's :vol (a value, a
  // sweep, a $slot), the note's :vel / :vol macros and :master. A track's
  // level lines and each voice's hits are kept here as they are dispatched;
  // _chipPcmFrames writes a sounding voice's level a frame at a time where
  // it moves. A voice belongs to the track that last keyed it. A rhythm
  // sound's IL stops 23 dB down, so one fading below it (or a :vol 0) is
  // dumped instead.
  _chipPcmState() {
    return (this._chipPcm ??= {
      vol: new Map(), // track → [{ t, v } | { t, sweep }]
      pitch: new Map(), // the same, in cents
      pan: new Map(), // track → pan
      hits: new Map(), // voice ("adpcm" or a rhythm sound) → [hit]
      master: [{ t: -Infinity, v: this._masterVol ?? VOL_UNITY }],
      doneUntil: -Infinity, // frames are written up to here
    });
  }

  // A pc88 sample track's :vol or :pitch event, onto its line: a value, or
  // a sweep from where it is (or its :from). :vol is 0-31, :pitch cents.
  _chipPcmParam(ev, when, key) {
    const lines = this._chipPcmState()[key];
    const ti = ev._trackIndex;
    if (!lines.has(ti)) lines.set(ti, []);
    const fit = CHIP_PCM_PARAM[key].fit;
    if (ev.cmd === "PARAM_SET" || ev.cmd === "PARAM_FROM_VAL") {
      const v = ev.cmd === "PARAM_SET" ? ev.args?.value : this._resolveSrc(ev.args?.src, when);
      insertLine(lines.get(ti), when, fit(Number(v ?? CHIP_PCM_PARAM[key].rest)));
    } else if (ev.cmd === "PARAM_SWEEP") {
      const df = this._curveFields(ev.args ?? {}, when);
      const from = fit(Number(df.from ?? this._chipPcmParamAt(ti, key, when)));
      const baseFrames = ev.args?.lenFrames
        ? Math.max(1, Math.round(Number(ev.args?.frames ?? 1)))
        : Math.max(1, Math.round(Number(ev.args?.frames ?? 1) * this._secsPerTick * 60));
      const sweep = {
        from, to: fit(Number(df.to ?? from)), curve: ev.args?.curve ?? "linear",
        params: df.params, baseFrames, loop: !!ev.args?.loop, startFrame: this._eventFrame(when),
      };
      const l = lines.get(ti);
      const at = l.findIndex((e) => e.t > when);
      l.splice(at < 0 ? l.length : at, 0, { t: when, sweep });
    }
  }

  _chipPcmParamAt(ti, key, when) {
    const e = lineEntryAt(this._chipPcm?.[key].get(ti), when);
    if (!e) return CHIP_PCM_PARAM[key].rest;
    return e.sweep ? CHIP_PCM_PARAM[key].fit(this._sweepAtFrame(e.sweep, this._eventFrame(when))) : e.v;
  }

  // A hit (or an ADPCM-B note) keyed on `voice`: its own :vel / :vol macros
  // run from it, to the track's next note, and each :keyon step re-keys the
  // voice — a hit of its own, the level envelopes starting over with it, as
  // on FM and PSG (a gate or loop note's only inside its gate). `key(t, hit)`
  // writes a key: the first, then each step's.
  _chipPcmHit(voice, ev, when, end, fields, key) {
    const st = this._chipPcmState();
    const { keyon, velMacro, vol: volMacro, pitchMacro, note_semi: semiMacro } = ev.args ?? {};
    const hit = { t: when, end, voice, ti: ev._trackIndex, vel: Number(ev.args?.vel ?? 15), velLine: null, volLine: null, ...fields };
    const gateTicks = this._resolveGateTicks(ev.args?.gate, ev.args?.length);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const { secs: nextNote } = this._nextNote(ev);
    const limit = Number.isFinite(nextNote) ? nextNote - KEY_OFF_LEAD_SECS : Infinity;
    const held = ev.args?.mode === "gate" || ev.args?.mode === "loop";
    const retrigs = (this._keyonRetrigTimes(keyon, when, gateTicks, limit) ?? []).filter((t) => !held || t < gateSecs);
    this._envRetrigs = retrigs;
    // A tuned hit's (the OPLL rhythm's) pitch runs its note's whole length:
    // the channel keeps moving through the sound's release.
    const slot = fields.tune ? this._resolveNoteFramesAndGate(when, ev.args?.length ?? gateTicks) : null;
    for (const [spec, k, target] of [[velMacro, "velLine", "VEL"], [volMacro, "volLine", "VOL"],
      [pitchMacro, "pitchLine", "NOTE_PITCH"], [semiMacro, "semiLine", "NOTE_SEMI"]]) {
      if (!spec) continue;
      const line = (hit[k] = []); // [value, time], as _lineAt reads
      const span = slot && (target === "NOTE_PITCH" || target === "NOTE_SEMI") ? slot : { noteFrames, gateSecs };
      this._scheduleMacro(spec, span.noteFrames, span.gateSecs, when,
        (v, t) => line.push([clampForTarget(target, v), t]), this._stepSecs(spec.step), limit);
    }
    this._envRetrigs = null;
    if (!st.hits.has(voice)) st.hits.set(voice, []);
    const hits = st.hits.get(voice);
    for (const h of [hit, ...retrigs.map((t) => ({ ...hit, t, end: end + (t - when) }))]) {
      let i = hits.length;
      while (i > 0 && hits[i - 1].t > h.t) i--;
      hits.splice(i, 0, h);
      key(h.t, h);
    }
    return hit;
  }

  // The hit that holds `voice` at `when`, if it is `ti`'s: a gate's end
  // stops only the track's own sound.
  _chipPcmOwnHit(voice, ti, when) {
    const hits = this._chipPcm?.hits.get(voice) ?? [];
    for (let i = hits.length - 1; i >= 0; i--)
      if (hits[i].t <= when + 1e-9) return hits[i].ti === ti ? hits[i] : null;
    return null;
  }

  // A hit's level at `when`: { vel, vol, master }.
  _chipPcmLevelAt(hit, when) {
    return {
      ui: this._voiceUiVol.get(hit.voice) ?? VOL_UNITY,
      vel: this._lineAt(hit.velLine, when) ?? hit.vel,
      vol: this._lineAt(hit.volLine, when) ?? this._chipPcmParamAt(hit.ti, "vol", when),
      master: lineEntryAt(this._chipPcm.master, when)?.v ?? VOL_UNITY,
    };
  }

  // Has the sound sharing `voice`'s channel (the kit's lane) been hit since
  // `hit`, by `t`?
  _pairHitSince(voice, hit, t) {
    const lanes = this._routes.get(hit.ti)?.part?.kitLane;
    if (!lanes) return false;
    for (const [v, hits] of this._chipPcm.hits)
      if (v !== voice && lanes[v] === lanes[voice] && hits.some((x) => x.t > hit.t && x.t <= t + 1e-9)) return true;
    return false;
  }

  // A hit's pitch move at `when`, in cents: the track's :pitch and the
  // note's :pitch / :semi macros.
  _hitCents(hit, when) {
    return this._chipPcmParamAt(hit.ti, "pitch", when) + (this._lineAt(hit.pitchLine, when) ?? 0) +
      100 * (this._lineAt(hit.semiLine, when) ?? 0);
  }

  // The ADPCM-B's Delta-N for a hit at `when`: its note and its pitch move
  // over the sample's rate.
  _adpcmDeltaN(hit, when) {
    const enc = this._target.chipFor("adpcm-b").adpcm;
    return enc.deltaN(hit.rate * 2 ** ((hit.midi - 60) / 12 + this._hitCents(hit, when) / 1200));
  }

  // A chip-own sample voice's level from vel + vol + master + its strip, on
  // its part's ladder (chips/parts.js `level`): the rhythm's IL attenuation
  // (unclamped — a sound falling past what the IL reaches is dumped), the
  // ADPCM-B's linear register, PCM8's gain.
  static _rhythmAtt(level, { vel, vol, master, ui }) {
    return levelOffset(level, { vel, faders: [vol, master, ui] });
  }
  static _pcm8Gain({ vel, vol, master, ui }) {
    return levelGain({ vel, faders: [vol, master, ui] });
  }
  static _adpcmLevel(level, { vel, vol, master, ui }) {
    return Math.round((level.steps - 1) * levelGain({ vel, faders: [vol, master, ui] }));
  }

  // Write each sounding voice's level, a frame at a time, up to `horizon`,
  // where it moved since the last write.
  _chipPcmFrames(horizon) {
    const st = this._chipPcm;
    const chip = this._target.chipFor("adpcm-b");
    const k0 = Math.max(Math.floor((st.doneUntil - this._frameOrigin) * 60) + 1, 0);
    const k1 = Math.floor((horizon - this._frameOrigin) * 60);
    st.doneUntil = Math.max(st.doneUntil, this._frameOrigin + k1 / 60);
    for (const [voice, hits] of st.hits) {
      for (let k = k0; k <= k1; k++) {
        const t = this._frameOrigin + k / 60;
        // The voice's owner: its last hit at or before this frame (a hit on
        // the frame wrote its own level with its key).
        let h = null;
        for (let i = hits.length - 1; i >= 0; i--) if (hits[i].t <= t + 1e-9) { h = hits[i]; break; }
        // An OPLL rhythm hit's pitch moves its channel while the sound rings
        // and on through its release, to the next hit on the channel: its
        // own or its pair's (SD with HH, TOM with the cymbal), which tunes it.
        if (h?.tune && !this._pairHitSince(voice, h, t)) {
          const midi = h.midi + this._hitCents(h, t) / 100;
          if (midi !== h.tuned) {
            h.tuned = midi;
            for (const [p, a, d] of this._rhythmEnc.tune(voice, midi, t)) this._write(p, a, d, t);
          }
        }
        // A DDA hit's samples of this frame, as far as the horizon (a note
        // another name starts at the horizon is not dispatched yet), and its end.
        if (h?.dda != null && !h.dumped) this._ddaFrame(h, Math.min(t + 1 / 60, horizon));
        if (!h || h.dumped || t >= h.end) continue;
        const lv = this._chipPcmLevelAt(h, t);
        if (h.dda != null) {
          const att = levelSteps(this._routes.get(h.ti).part.level, this._ddaLevel(h, t));
          if (att !== h.att) { h.att = att; for (const [p, a, d] of this._ddaEncoder().level(h.dda, att)) this._write(p, a, d, t); }
        } else if (h.pcm8 != null) {
          const gain = IRPlayer._pcm8Gain(lv);
          if (gain !== h.gain) { h.gain = gain; this._pcm8Ev(t, { kind: "gain", voice: h.pcm8, value: gain }); }
          const step = this._pcm8Step(h, t);
          if (step !== h.step) { h.step = step; this._pcm8Ev(t, { kind: "step", voice: h.pcm8, value: step }); }
        } else if (voice === "adpcm") {
          const level = IRPlayer._adpcmLevel(this._routes.get(h.ti).part.level, lv);
          if (level !== h.level) {
            h.level = level;
            for (const [p, a, d] of chip.adpcm.level(level)) this._write(p, a, d, t);
          }
          const deltaN = this._adpcmDeltaN(h, t);
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
          if (lv.vol <= 0 || lv.master <= 0 || lv.ui <= 0 || (att > top && falling)) {
            h.dumped = true;
            for (const [p, a, d] of this._rhythmEnc.dump(voice, t)) this._write(p, a, d, t);
            continue;
          }
          const il = top - Math.min(top, att);
          if (il === h.il) continue;
          h.il = il;
          for (const [p, a, d] of this._rhythmEnc.level(voice, il, h.pan, t)) this._write(p, a, d, t);
        }
      }
      // A hit is done with once a later one owns the voice.
      while (hits.length > 1 && hits[1].t <= st.doneUntil) hits.shift();
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
          const h = this._chipPcmOwnHit("adpcm", ti, when);
          if (!cp.hits.get("adpcm")?.length || h) out(enc.stop());
          if (h) h.end = Math.min(h.end, when);
        }
        break;
      case "PARAM_SET":
      case "PARAM_SWEEP":
      case "PARAM_FROM_VAL": {
        const target = (ev.args?.target ?? "").toUpperCase();
        if (target === "VOL") this._chipPcmParam(ev, when, "vol");
        else if (target === "NOTE_PITCH") this._chipPcmParam(ev, when, "pitch");
        if (ev.cmd !== "PARAM_SET") break;
        if (target === "PAN") st.pan = this._snapMacroOutput("PAN", ev.args?.value ?? 0);
        else if (target === "MASTER") this._applyMasterChange(ev.args?.value ?? VOL_UNITY, when);
        // The range the next notes play (seconds as heard); a loop is the
        // range itself on this chip (the compiler holds it to that).
        else if (target === "RANGE_START") (st.range ??= {}).start = Number(ev.args?.value);
        else if (target === "RANGE_END") { (st.range ??= {}).end = Number(ev.args?.value); st.range.len = null; }
        else if (target === "RANGE_LEN") { (st.range ??= {}).len = Number(ev.args?.value); st.range.end = null; }
        break;
      }
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
  _pcm8Step(hit, when) {
    const cents = this._chipPcmParamAt(hit.ti, "pitch", when) + (this._lineAt(hit.pitchLine, when) ?? 0) +
      100 * (this._lineAt(hit.semiLine, when) ?? 0);
    return (hit.rate * 2 ** ((hit.midi - 60) / 12 + cents / 1200)) / PCM8_RATE;
  }

  // The X68000's PCM8 (chips/msm6258.js): a note plays its sample from the
  // range's start at its pitch's step, its gain vel + vol + master moving
  // with them while it sounds (_chipPcmFrames); `shot` plays to the range's
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
        const h = this._chipPcmOwnHit(key, ti, when);
        if (!h) break;
        if (ev.args?.mode === "gate") { this._pcm8Ev(when, { kind: "cut", voice }); h.end = Math.min(h.end, when); }
        else if (ev.args?.mode === "loop") this._pcm8Ev(when, { kind: "off", voice });
        break;
      }
      case "PARAM_SET":
      case "PARAM_SWEEP":
      case "PARAM_FROM_VAL": {
        const target = (ev.args?.target ?? "").toUpperCase();
        if (target === "VOL") this._chipPcmParam(ev, when, "vol");
        else if (target === "NOTE_PITCH") this._chipPcmParam(ev, when, "pitch");
        if (ev.cmd !== "PARAM_SET") break;
        const v = Number(ev.args?.value);
        if (target === "MASTER") this._applyMasterChange(ev.args?.value ?? VOL_UNITY, when);
        else if (target === "RANGE_START") (st.range ??= {}).start = v;
        else if (target === "RANGE_END") { (st.range ??= {}).end = v; st.range.len = null; }
        else if (target === "RANGE_LEN") { (st.range ??= {}).len = v; st.range.end = null; }
        else if (target === "LOOP_START") (st.loop ??= {}).start = v;
        else if (target === "LOOP_END") { (st.loop ??= {}).end = v; st.loop.len = null; }
        else if (target === "LOOP_LEN") { (st.loop ??= {}).len = v; st.loop.end = null; }
        break;
      }
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
  // at a time with its level (_chipPcmFrames, _ddaFrame), then the channel
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
      case "PARAM_SET":
      case "PARAM_SWEEP":
      case "PARAM_FROM_VAL": {
        const target = (ev.args?.target ?? "").toUpperCase();
        if (target === "VOL") this._chipPcmParam(ev, when, "vol");
        if (ev.cmd !== "PARAM_SET") break;
        const v = Number(ev.args?.value);
        if (target === "MASTER") this._applyMasterChange(ev.args?.value ?? VOL_UNITY, when);
        else if (target === "PAN") st.pan = Math.max(-1, Math.min(1, v || 0));
        else if (target === "RANGE_START") (st.range ??= {}).start = v;
        else if (target === "RANGE_END") { (st.range ??= {}).end = v; st.range.len = null; }
        else if (target === "RANGE_LEN") { (st.range ??= {}).len = v; st.range.end = null; }
        else if (target === "LOOP_START") (st.loop ??= {}).start = v;
        else if (target === "LOOP_END") { (st.loop ??= {}).end = v; st.loop.len = null; }
        else if (target === "LOOP_LEN") { (st.loop ??= {}).len = v; st.loop.end = null; }
        break;
      }
      default:
        break;
    }
  }

  // The DMC's rate for each sample its notes play (chips/rp2a03.js
  // dmcRate): the highest at which the whole sample, at the lowest pitch a
  // note plays it, fits the DMC's 4081 bytes — one rate a def-pcm, as a
  // driver keeps one.
  _dmcRateOf(name) {
    if (!this._dmcRates) {
      this._dmcRates = new Map();
      const heads = new Set(this._target.headsOf("fc-dpcm"));
      const lowest = new Map();
      for (const t of this._ir?.tracks ?? []) {
        if (!heads.has(t.scoreChannel ?? t.channel)) continue;
        for (const e of t.events ?? [])
          if (e.cmd === "PCM_NOTE_ON" && e.args?.sample) {
            const midi = pitchToMidi(e.args.pitch ?? "c4");
            lowest.set(e.args.sample, Math.min(lowest.get(e.args.sample) ?? Infinity, midi));
          }
      }
      for (const [n, midi] of lowest) {
        const entry = this._frameBank?.entries?.[n];
        if (entry?.data.length) this._dmcRates.set(n, dmcRate(entry.data.length / (entry.rate * 2 ** ((midi - 60) / 12))));
      }
    }
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
        const lines = this._levelMacroLines(ev.args ?? {}, when, gateTicks, Infinity);
        const cp = this._chipPcmState();
        const gain = levelGain({
          vel: this._lineAt(lines.vel, when) ?? Number(ev.args?.vel ?? 15),
          faders: [this._lineAt(lines.vol, when) ?? this._chipPcmParamAt(ti, "vol", when),
            lineEntryAt(cp.master, when)?.v ?? VOL_UNITY, this._voiceUiVol.get("dpcm") ?? VOL_UNITY],
        });
        const rate = this._dmcRateOf(name);
        const step = perSec / DMC_RATES[rate]; // source frames a bit
        const levels = [];
        for (let pos = start; pos < end; pos += step) {
          const i = Math.floor(pos), f = pos - i;
          const x = entry.data[i] * (1 - f) + (entry.data[Math.min(i + 1, end - 1)] ?? 0) * f;
          levels.push(Math.max(-1, Math.min(1, x * gain)));
        }
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
      case "PARAM_SET":
      case "PARAM_SWEEP":
      case "PARAM_FROM_VAL": {
        const target = (ev.args?.target ?? "").toUpperCase();
        if (target === "VOL") this._chipPcmParam(ev, when, "vol");
        if (ev.cmd !== "PARAM_SET") break;
        const v = Number(ev.args?.value);
        if (target === "MASTER") this._applyMasterChange(ev.args?.value ?? VOL_UNITY, when);
        else if (target === "RANGE_START") (st.range ??= {}).start = v;
        else if (target === "RANGE_END") { (st.range ??= {}).end = v; st.range.len = null; }
        else if (target === "RANGE_LEN") { (st.range ??= {}).len = v; st.range.end = null; }
        break;
      }
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

  // A DDA hit's level terms: vel + vol + master + its strip (levelSteps).
  _ddaLevel(h, t) {
    const lv = this._chipPcmLevelAt(h, t);
    return { vel: lv.vel, faders: [lv.vol, lv.master, lv.ui] };
  }

  // A chip's ROM rhythm (the YM2608's, the OPLL's): a hit writes its sound's
  // level and pan, then keys it; vel + vol + master fold into the level as
  // an FM carrier's do, on the part's ladder (the YM2608's IL 0.75 dB a
  // step, the OPLL's volume 3 dB), and move it while the sound plays
  // (_chipPcmFrames), and `:mode gate` dumps it at the note's end. On the
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
          const silent = lv.vol <= 0 || lv.master <= 0 || lv.ui <= 0;
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
          const h = this._chipPcmOwnHit(sound, ti, when);
          if (h) {
            for (const [p, a, d] of enc.dump(sound, when)) this._write(p, a, d, when);
            h.end = Math.min(h.end, when);
          }
        }
        break;
      case "PARAM_SET":
      case "PARAM_SWEEP":
      case "PARAM_FROM_VAL": {
        const target = (ev.args?.target ?? "").toUpperCase();
        if (target === "VOL") this._chipPcmParam(ev, when, "vol");
        else if (target === "NOTE_PITCH" && enc.tune) this._chipPcmParam(ev, when, "pitch");
        if (ev.cmd !== "PARAM_SET") break;
        if (target === "PAN") st.pan = this._snapMacroOutput("PAN", ev.args?.value ?? 0);
        else if (target === "MASTER") this._applyMasterChange(ev.args?.value ?? VOL_UNITY, when);
        break;
      }
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
    const len = a.lenFrames
      ? Math.max(1, Math.round(Number(a.frames ?? 1)))
      : Math.max(1, Math.round(Number(a.frames ?? 1) * this._secsPerTick * 60));
    const loop = !!a.loop;
    const budget = this._resolveSweepBudgetFrames(ev);
    const id = curveId(a.curve);
    const step16 = sweepStep(len, loop);
    let phase16 = 0;
    for (let f = 0; f < budget; f++) {
      const last = !loop && f >= len - 1;
      const value = last ? to : sweepValue(from, to, curveUnit8(id, phase16 >> 8));
      phase16 = (phase16 + step16) & 0xffff;
      // + PCM_SWEEP_AFTER: the driver steps its sweeps AFTER the frame's
      // dispatch (driver.md §4 step 3), so a sweep that starts with a note
      // moves that note's loop, not the one before it.
      this._pcmEv(when + f / 60 + PCM_SWEEP_AFTER, { kind: "point", voice, target, value });
      if (last) break;
    }
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
    const levels = [];
    this._envRetrigs = this._keyonRetrigTimes(keyon, when, gateTicks, limit);
    for (const [spec, kind, target] of [[velMacro, "vel", "VEL"], [volMacro, "vol", "VOL"]]) {
      if (!spec) continue;
      this._scheduleMacro(
        spec, noteFrames, gateSecs, when,
        (v, t) => levels.push({ t, kind, value: clampForTarget(target, v) }),
        this._stepSecs(spec.step), limit,
      );
    }
    this._envRetrigs = null;
    // The note starts at its :vel macro's first sample, as the driver's
    // note-on composes it (a leading hold: the note's own vel).
    const firstVel = velMacro && !macroLeadsWithHold(velMacro)
      ? levels.find((x) => x.kind === "vel")?.value ?? noteVel
      : noteVel;
    // ...and at its :vol macro's first sample, else the fader (restore_level_base).
    const firstVol = volMacro && !macroLeadsWithHold(volMacro)
      ? levels.find((x) => x.kind === "vol")?.value ?? null
      : null;
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
    // A retrigger STARTs after its frame's level steps, so it carries them:
    // they ride its event instead of sending a level of their own.
    const retrigs = new Map();
    for (const t of this._keyonRetrigTimes(keyon, when, gateTicks, limit) ?? [])
      retrigs.set(this._eventFrame(t), { t, kind: "retrig", voice });
    for (const x of levels) {
      const r = retrigs.get(this._eventFrame(x.t));
      if (r) r[x.kind] = x.value;
      else this._pcmEv(x.t, { kind: x.kind, voice, value: x.value, macro: true });
    }
    for (const r of retrigs.values()) {
      const { t, ...fields } = r;
      this._pcmEv(t + PCM_SWEEP_AFTER, fields);
    }
  }

  _dispatchGlobalEvent(ev, when) {
    switch (ev.cmd) {
      case "TEMPO_SET": {
        // A live tempo (the panel) outranks the score until playback restarts.
        // A loop re-fires the score's tick-0 TEMPO_SET on every lap, which would
        // otherwise snap the dialled-in tempo back each time round.
        if (this._tempoOverride) return true;
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
        if (this._tempoOverride) return true;
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
          if (ev.cmd === "PARAM_SET") this._noiseRateBase = Number(ev.args?.value ?? 9);
          this._writeSongRate(ev, when, 9, (v, t) => this._psgWrites(this._psg((c) => c.noiseRate(v)), t));
          return true;
        }
        if (ev.args?.target === "ENV_RATE") {
          // 0 follows the writing track's notes (a tone lane's), from its
          // next; a rate is a cycle of the writing track's shape as it is now.
          const lane = ev._psgCh != null && ev._psgCh < 4 ? ev._psgCh : null;
          if (ev.cmd === "PARAM_SET" && !Number(ev.args?.value)) {
            this._envFollow = lane !== 3 ? lane : null;
            return true;
          }
          this._envFollow = null;
          // The writing lane's shape and moves, as they are now.
          const by = lane != null ? { shape: this._psgEnv[lane], semi: this._envSemi[lane], detune: this._envDetune[lane] } : {};
          this._writeSongRate(ev, when, 0, (v, t) => this._writeEnvPeriod(v, by, t), 64);
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
        this._vals[name] = i16(cur + this._resolveOperand(a.delta, when));
        break;
      case "PARAM_MUL": {
        const f = a.factor;
        const fixed = f && typeof f === "object" && "src" in f
          ? this._resolveSrc(f.src, when)
          : Math.round((Number(f) || 0) * 256);
        this._vals[name] = i16(Math.floor((cur * Math.max(0, Math.min(0xffff, fixed))) / 256));
        break;
      }
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
      case "VOL": return regs.vol ?? 0;
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
        if (op) {
          const st = this._fm3Op[op - 1];
          st.offset = value;
          this._writeFm3OpPitch(op, st.midi, value, when);
          break;
        }
        // Cent offset applied to the current note on this FM channel (100 cents = 1 semitone).
        regs.pitchOffset = value;
        this._writeFmNote(ch, regs.currentMidi ?? 60, value, when);
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
        const vol = Math.max(0, Math.min(31, value));
        const volOp = this._fm3OpOf(ev);
        if (volOp) {
          const st = this._fm3Op[volOp - 1];
          st.volSweep = null; // a PARAM_SET overrides a running sweep
          st.vol = vol;
          this._writeFm3OpTl(volOp, when);
          break;
        }
        if (ch === 2 && this._fm3Ops) {
          regs.vol = vol;
          this._recomposeFm3Ops(when);
          break;
        }
        this._fmVolSweep[ch] = null; // a PARAM_SET overrides a running sweep
        regs.vol = vol;
        this._writeFmLevel(ch, when, { vol, master: this._masterVol ?? VOL_UNITY });
        this._followMasterSweep(ch, when);
        break;
      }

      case "MASTER":
        this._applyMasterChange(value, when);
        break;

      default:
        break;
    }
  }

  // Global master volume 0-31 (31=full). Re-applies carrier TL on all FM
  // channels, PSG attenuation on all sounding PSG channels, and recomposes every
  // PCM soft-mix voice (the bit-shift attenuation rides master too). Reached from
  // a PARAM_SET MASTER on any track (FM/PSG/PCM), so all three stay in step.
  _applyMasterChange(value, when, F = this._eventFrame(when), ahead = false) {
    const master = Math.max(0, Math.min(31, Math.round(value)));
    this._masterVol = master;
    // FM channels: update carrier TL
    for (let ci = 0; ci < this._fmEnc.channels; ci++) {
      if (ci === 2 && this._fm3Ops) { this._recomposeFm3Ops(when); continue; }
      // a :vol macro's level then, else a running :vol sweep's at frame F
      const vol = this._lineAt(this._fmLevelLines[ci]?.vol, when) ?? this._fmVolAtFrame(ci, F);
      this._writeFmLevel(ci, when, { vol, master });
    }
    // PSG channels: recalculate attenuation from vel * vol * master, but only
    // for channels currently sounding — re-writing a non-silent att to an idle
    // channel (e.g. at play start, before any note) would drone a tone.
    for (let psgCh = 0; psgCh < PSG_LANES; psgCh++) {
      // Not keyed then, or silent now: a sweep's frames are written ahead, and
      // a held note's key-off (triggerKeyOff) is not known in advance.
      // (A held note has no known key-off: nothing is written ahead to it.)
      const until = this._psgKeyedUntil[psgCh];
      if (!this._psgSounding[psgCh] || F >= this._eventFrame(until) || (ahead && !Number.isFinite(until)))
        continue;
      const velLevel = this._psgLastVel[psgCh] ?? 15; // 0-15, raw vel
      const vol = this._psgVolAtFrame(psgCh, F); // 0-31
      const sounding = this._psgSounding[psgCh];
      this._psgSetAtt(psgCh, this._composePsgAtt(psgCh, velLevel, vol, master), when);
      this._psgSounding[psgCh] = sounding; // may be ahead of time (a sweep frame)
    }
    // PCM voices ride master too: the voice model recomposes every voice.
    this._pcmEv(when, { kind: "master", value: master });
    if (this._chipPcm) insertLine(this._chipPcm.master, when, master);
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
      if (!this._tempoOverride) {
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

  // The :vol sets a track makes while its note sounds (up to its next note):
  // frame → value. A PSG level macro's frames are written at the note's onset,
  // so they take these in then — the set, when it comes, cannot redo them.
  _volSetsAhead(ev) {
    const out = new Map();
    const track = ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
    if (!track) return out;
    const base = track.audioTimeAtTick0 + ev.tick * this._secsPerTick;
    for (let i = track.flatIndex + 1; i < track.events.length; i++) {
      const ne = track.events[i];
      if (ne.cmd === "NOTE_ON" || ne.cmd === "PCM_NOTE_ON") break;
      if (ne.cmd === "PARAM_SET" && String(ne.args?.target ?? "").toUpperCase() === "VOL") {
        const v = Math.max(0, Math.min(31, ne.args?.value ?? VOL_UNITY));
        out.set(this._eventFrame(this._timeAfterTicks(base, ne.tick - ev.tick)), v);
      }
    }
    return out;
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
  _glideCut(ev, endTick = this._resolveSweepEndTick(ev)) {
    return endTick < ev.tick + Math.max(1, ev.args?.frames ?? 1);
  }

  _resolveSweepEndTick(ev) {
    const trackIndex = ev._trackIndex;
    if (trackIndex == null) return ev.tick + Math.max(1, ev.args?.frames ?? 1);

    const track = this._tracks[trackIndex];
    if (!track) return ev.tick + Math.max(1, ev.args?.frames ?? 1);

    const target = (ev.args?.target ?? "").toUpperCase();
    // A bounded sweep (a glide) lasts its `frames` and then stops — unless the
    // next write to its target (the next note's glide, or the hold sweep of a
    // note that does not glide) ends it first, as on the driver.
    if (ev.args?.bounded)
      return Math.min(
        ev.tick + Math.max(1, ev.args?.frames ?? 1),
        this._nextTargetWriteTick(track, target),
      );
    const loopDuration = track.loopDuration ?? 1;
    const loopStartTick = track.loopStartTick ?? 0;
    const jumpTick = loopStartTick + loopDuration;
    const isLoopCurve = !!ev.args?.loop;

    // Default sweep horizon is one structural loop. If sweep starts in the intro
    // section (before loopStartTick), it must at least survive until first jump.
    // A track that does not loop has no structural loop to bound it: as on
    // the driver, a one-shot runs its length and a loop curve runs to the
    // song's end — and a song with a looping track has none, so there it
    // runs as far as a looping track's loop curve does (below): a note-less
    // (fm3-csm …) track's :rr sweep went quiet after the first pass.
    const songEndTick = (t) => (t.hasLoop
      ? (t.loopStartTick ?? 0) + (t.loopDuration ?? 1) + this._loopCurveSpanTicks(t)
      : t.endTick ?? 0);
    let endTick = !track.hasLoop
      ? isLoopCurve
        ? Math.max(ev.tick + 1, ...this._tracks.map(songEndTick))
        : Infinity
      : ev.tick < loopStartTick
        ? jumpTick
        : ev.tick + loopDuration;
    const nextWrite = this._nextTargetWriteTick(track, target);
    const hasExplicitStop = nextWrite !== Infinity;
    if (hasExplicitStop) endTick = nextWrite;

    // Looping curves (sin/triangle/square/saw/ramp) should not freeze at the
    // first loop boundary when there is no explicit overwrite. Keep them alive
    // for multiple loop iterations so channel-level LFO-style sweeps persist.
    if (!hasExplicitStop && isLoopCurve && track.hasLoop) {
      endTick = Math.max(endTick, jumpTick + this._loopCurveSpanTicks(track));
    }

    return endTick;
  }

  // How far past a track's first pass a loop curve is scheduled (its writes
  // go out ahead, so it needs an end): sixteen passes, or five minutes when
  // that is longer — a short loop's LFO-style sweep (a 1.6 s pass) went quiet
  // after half a minute of play.
  _loopCurveSpanTicks(track) {
    const pass = track.loopDuration ?? 1;
    const minutes = Math.ceil((300 / Math.max(1e-6, this._secsPerTick)) / pass) * pass;
    return Math.max(pass * 16, minutes);
  }

  // The tick of the next PARAM_SET / PARAM_SWEEP / PARAM_SWEEP_STOP on `target`
  // after the event being dispatched on `track`, or Infinity.
  _nextTargetWriteTick(track, target) {
    for (let i = track.flatIndex + 1; i < track.events.length; i++) {
      const nextEv = track.events[i];
      if ((nextEv.args?.target ?? "").toUpperCase() !== target) continue;
      if (
        nextEv.cmd === "PARAM_SET" ||
        nextEv.cmd === "PARAM_SWEEP" ||
        nextEv.cmd === "PARAM_SWEEP_STOP"
      )
        return nextEv.tick;
    }
    return Infinity;
  }

  // Frames a sweep runs. Given its start time, counted on the driver's frame
  // grid: every frame from the one it starts in up to the one its end falls in.
  _resolveSweepBudgetFrames(ev, when = null, endTick = this._resolveSweepEndTick(ev)) {
    const secsPerTick = this._secsPerTick;
    if (when != null) {
      const endWhen = when + Math.max(0, endTick - ev.tick) * secsPerTick;
      return Math.max(1, this._eventFrame(endWhen) - this._eventFrame(when));
    }
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
  //   endTick           – the sweep's end tick, resolved once for the dispatch
  _sweepFrameParams(ev, baseFrames, loop, when = null) {
    const secsPerTick = this._secsPerTick;
    const endTick = this._resolveSweepEndTick(ev);
    const budgetFrames = Math.min(
      this._resolveSweepBudgetFrames(ev, when, endTick),
      loop ? Infinity : Math.max(1, baseFrames), // an unbounded one-shot: its length
    );
    const track = ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
    const spansLoopBoundary =
      track != null && endTick >= ev.tick + (track.loopDuration ?? 0);
    const loopPhaseOffset =
      loop && spansLoopBoundary && track != null
        ? track.loopCount * budgetFrames
        : 0;
    const loopDurationFrames = track?.hasLoop
      ? Math.max(1, Math.floor((track.loopDuration ?? 1) * secsPerTick * 60))
      : budgetFrames;
    const loopCount = track?.loopCount ?? 0;
    const nonLoopStartFrame = !loop ? loopCount * loopDurationFrames : 0;
    const iterFrames = !loop
      ? Math.max(
          0,
          Math.min(loopDurationFrames, budgetFrames, baseFrames - nonLoopStartFrame),
        )
      : budgetFrames;
    return { budgetFrames, nonLoopStartFrame, iterFrames, loopPhaseOffset, endTick };
  }

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
    const run = (at, gate, lim) => {
      const w = [];
      const end = this._scheduleMacroImpl(
        spec,
        Math.max(1, noteFrames - Math.round((at - when) * 60)),
        gate, at, (v, t) => w.push([v, t]), stepSecs, lim,
      );
      return { w, end };
    };
    const flush = (seg, cut = Infinity) => {
      for (const [v, t] of seg.w) if (t < cut - 1e-9) writeFn(v, t);
    };
    const starts = [when, ...pre];
    let seg = null;
    for (let i = 0; i < starts.length; i++) {
      if (seg) flush(seg);
      seg = run(starts[i], gateSecs, Math.min(limitSecs, starts[i + 1] ?? Infinity));
    }
    flush(seg);
    let endTime = seg.end;
    if (spec?.src && this._onSeq) {
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
        if (stage.waitKeyOff) t = Math.max(t, offT);
        else if (stage.waitTicks != null)
          t = this._timeAfterTicks(t, Math.max(0, Number(stage.waitTicks)));
        else if (stage.waitFrames != null) t += stage.waitFrames / 60;
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
  _scheduleFmLevelMacros(ch, fm3Op, lines) {
    const times = [...(lines.vel ?? []), ...(lines.vol ?? [])].map(([, t]) => t);
    times.sort((a, b) => a - b);
    let last = null;
    for (const t of times) {
      if (last !== null && t - last < 1e-9) continue;
      last = t;
      if (fm3Op) this._writeFm3OpTl(fm3Op, t);
      else this._writeFmLevel(ch, t);
    }
  }

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
    return gaps;
  }

  _applyParamSweep(ch, ev, when) {
    const target = (ev.args?.target ?? "").toUpperCase();
    // Dynamic :from/:to/:rate ($name) resolved once at sweep start.
    const df = this._curveFields(ev.args ?? {}, when);
    // No :from: the sweep starts where the parameter is now (language.md §11).
    const from = df.from != null
      ? Number(df.from)
      : target === "VOL"
        ? this._fmVolAtTime(ch, when)
        : this._readParam(ch, target, this._fm3OpOf(ev));
    const to = Number(df.to ?? 0);
    const curve = ev.args?.curve ?? "linear";
    const params = df.params;
    const secsPerTick = this._secsPerTick;
    // ev.args.frames is ticks by default; an Nf `:len` sets lenFrames so it is
    // an absolute 60 Hz frame count (mirrors NOTE_ON macro curves via
    // _resolveLenFrames). Tempo is resolved at onset — a mid-sweep tempo change
    // drifts the wall-clock duration, matching the note-length Nf stance.
    // A slot-fed `:len` reads the slot at the sweep's start, by its :unit.
    const baseFrames = ev.args?.dyn?.len != null
      ? this._resolveLenFrames(ev.args, null, when)
      : ev.args?.lenFrames
        ? Math.max(1, Math.round(Number(ev.args?.frames ?? 1)))
        : Math.max(1, Math.round(Number(ev.args?.frames ?? 1) * secsPerTick * 60));
    const loop = !!ev.args?.loop;
    const { budgetFrames, nonLoopStartFrame, iterFrames, loopPhaseOffset, endTick } =
      this._sweepFrameParams(ev, baseFrames, loop, when);

    // NOTE_PITCH: must track future NOTE_ON base pitches so per-frame frequency
    // writes use the correct note at each point in time.
    if (target === "NOTE_PITCH") {
      const track =
        ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
      const framesPerTick = secsPerTick * 60;
      // On an fm3-N track the sweep bends that operator's F-number alone,
      // from the operator's own note (driver.md §13.4).
      const op = track?.fm3Op ?? 0;
      const opState = op ? this._fm3Op[op - 1] : null;
      let baseMidi = opState ? opState.midi : (this._chRegs[ch]?.currentMidi ?? 60);
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
          if (ne.cmd !== "NOTE_ON" || ne._route.core === "psg") continue;
          nextNoteTick = ne.tick;
          nextNoteMidi = pitchToMidi(ne.args?.pitch ?? "c4");
          return;
        }
        nextNoteTick = Infinity;
      };
      advance();
      const sw = {
        from, to, curve, params, baseFrames, loop,
        frameOffset: loopPhaseOffset, startWhen: when, startFrame: this._eventFrame(when),
      };
      for (let frame = 0; frame < budgetFrames; frame++) {
        const frameTick = ev.tick + frame / Math.max(1e-9, framesPerTick);
        while (frameTick >= nextNoteTick) {
          baseMidi = nextNoteMidi;
          advance();
        }
        const centOffset = Math.round(this._sweepAt(sw, loopPhaseOffset + frame));
        const frameWhen = this._sweepFrameTime(sw, frame);
        if (frame === 0)
          this._pitchSweepOnset.set(opState ? `op:${op}` : `fm:${ch}`, {
            when,
            offset: centOffset,
          });
        if (opState) {
          opState.offset = centOffset;
          this._writeFm3OpPitch(op, baseMidi, centOffset, frameWhen);
          continue;
        }
        this._chRegs[ch].pitchOffset = centOffset;
        this._writeFmNote(ch, baseMidi, centOffset, frameWhen);
      }
      // A bounded glide must land exactly on its target `to`. The frame loop can
      // stop a fraction short (budgetFrames is floored while the phase divides by
      // baseFrames), so a short glide ends mid-slope — leaving a residual pitch
      // offset that the note holds and every later NOTE_ON inherits (glide never
      // resets pitchOffset; `(glide none)` only stops future glides). Snap to the
      // final value so the note reaches true pitch and nothing leaks past it.
      if (ev.args?.bounded && !this._glideCut(ev, endTick)) {
        const endWhen = when + budgetFrames / 60;
        if (opState) {
          opState.offset = to;
          this._writeFm3OpPitch(op, baseMidi, to, endWhen);
          return;
        }
        this._chRegs[ch].pitchOffset = to;
        this._writeFmNote(ch, baseMidi, to, endWhen);
      }
      return;
    }

    // VOL: write TL directly per-frame (avoids mutating regs.vol mid-sweep which
    // would cause NOTE_ON to read the wrong vol).  Store sweep state so
    // _fmVolAtTime() returns the correct instantaneous vol at NOTE_ON time.
    const regs = this._chRegs[ch];
    if (target === "VOL") {
      // FM3 independent-OP: a :vol sweep on an fm3-N track fades THAT operator,
      // not the channel's carriers — which belong to the other operators too
      // (driver.md §13.4). On the shared (fm3 …) track it is the group fader
      // and moves all four.
      const volOp = this._fm3OpOf(ev);
      const groupSweep = !volOp && ch === 2 && this._fm3Ops;
      const sw = {
        from, to, curve, params, baseFrames, loop,
        frameOffset: loop ? loopPhaseOffset : nonLoopStartFrame,
        frames: iterFrames, startWhen: when, startFrame: this._eventFrame(when),
      };
      for (let i = 0; i < iterFrames; i++) {
        const vol = Math.max(0, Math.min(31, this._sweepAt(sw, sw.frameOffset + i)));
        const frameWhen = this._sweepFrameTime(sw, i);
        const master = this._masterAtFrame(sw.startFrame + i);
        if (volOp) {
          this._writeFm3OpTl(volOp, frameWhen, { vol, master });
          continue;
        }
        if (groupSweep) {
          for (let op = 1; op <= 4; op++) this._writeFm3OpTl(op, frameWhen, { group: vol, master });
          continue;
        }
        this._writeFmLevel(ch, frameWhen, { vol, master });
      }
      if (volOp) {
        const st = this._fm3Op[volOp - 1];
        st.volSweep = sw;
        st.vol = to; // final value, for a later MASTER/group recompose
        return;
      }
      if (groupSweep) {
        regs.vol = to;
        return;
      }
      this._fmVolSweep[ch] = sw;
      regs.vol = to;
      this._followMasterSweep(ch, when); // final value for MASTER recalc fallback
      return;
    }

    // MASTER: every channel's level, stepped frame by frame; later events
    // read it at their own time (_masterAt) and re-follow it (_followMasterSweep).
    if (target === "MASTER") {
      const ms = {
        from, to, curve, params, baseFrames, loop,
        frameOffset: loop ? loopPhaseOffset : nonLoopStartFrame,
        frames: iterFrames, startWhen: when, startFrame: this._eventFrame(when),
        prev: this._masterAt(when),
      };
      this._masterSweep = null;
      for (let i = 0; i < iterFrames; i++) {
        const t = this._sweepFrameTime(ms, i);
        this._applyMasterChange(this._sweepAt(ms, ms.frameOffset + i), t, ms.startFrame + i, i > 0);
      }
      this._masterSweep = iterFrames > 1 ? ms : null;
      this._masterVol = this._masterAt(when);
      return;
    }

    // All other FM parameters: route through _applyParam (handles register encoding).
    const sw = {
      target, from, to, curve, params, baseFrames, loop,
      frameOffset: loop ? loopPhaseOffset : nonLoopStartFrame,
      frames: iterFrames, startWhen: when, startFrame: this._eventFrame(when),
      trackIndex: ev._trackIndex,
    };
    for (let i = 0; i < iterFrames; i++) {
      this._applyParam(
        ch,
        { cmd: "PARAM_SET", args: { target, value: this._sweepAt(sw, sw.frameOffset + i) }, _trackIndex: ev._trackIndex },
        this._sweepFrameTime(sw, i),
      );
    }
    // The frames above leave the state at the last one; put it back to the
    // first so an event at this same time composes from what the chip holds.
    if (iterFrames > 1) {
      this._paramSweeps[ch].set(this._paramSweepKey(ev, target), sw);
      this._syncParamSweeps(ch, when);
    }
  }

  /**
   * External real-time parameter write.
   * target: e.g. 'FM_TL1', 'FM_FB', 'FM_ALG'
   * value: absolute value (always SET, not ADD)
   * chIndex: an FM channel (default 0)
   */
  setParam(target, value, chIndex = 0) {
    this._applyParam(chIndex, {
      cmd: "PARAM_SET",
      args: { target, value },
    });
    // An encoder that holds a voice change for the note's key-on (the
    // OPLL's) writes a live edit now.
    this._fmWrites(this._fmEnc.live?.(chIndex) ?? []);
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
  _toneEncodersOf(target, psg) {
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
        if (!waveEnc.has(chip)) waveEnc.set(chip, chip.toneEncoder());
        lanes[toneLaneOf(c)] = { enc: waveEnc.get(chip).lanes[c.voice], ch: c.voice, chip, part: c.part, queue: waveEnc.get(chip) };
        continue;
      }
      // A wave chip's channels, and its channels turned to noise (the PC
      // Engine's fifth and sixth, chips/huc6280.js): the encoder's noise
      // view, on a lane of the part's own.
      const asNoise = c.part.kind === "noise" && c.part.toneLane;
      if (c.part.kind !== "wave" && !asNoise) continue;
      if (!waveEnc.has(chip)) waveEnc.set(chip, chip.waveEncoder());
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
  // A PSG write on a target with no PSG (its encoder is null) is nothing.
  _psg(encode) {
    return this._psgChip ? encode(this._psgChip) : [];
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
      return [...l.chip.init, ...encode(l.enc, l.ch)];
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
    this._psgWrites(this._lane(psgCh, (e, ch) => e.pan?.(ch, this._psgPan[psgCh]) ?? []), when);
  }

  // A wave onto a lane's channel memory, where it is named — under a note
  // too (a chip that loads it with the channel off, the PC Engine's, turns it
  // back on in the same writes: the wave starts over from its first step).
  _writeLaneWave(lane, data, when) {
    this._psgWrites(this._lane(lane, (e, ch) => e.wave(ch, this._fitWave(lane, data))), when);
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
    if (hz > 0) this._psgWrites(this._psg((c) => c.envPeriod?.(hz * 2 ** (semi / 12), shape, detune) ?? []), when);
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
    const level = this._psgLevel[psgCh];
    if (!level || vol <= 0 || master <= 0) return this._psgOff(psgCh); // no such lane here: silent
    if (level.scale === "linear") // a linear volume (the SCC's), upside down
      return level.steps - 1 - Math.round(levelGain({ vel, faders: [vol, master] }) * (level.steps - 1));
    return levelSteps(level, { vel, faders: [vol, master] });
  }

  // Returns the current VOL (0-31) for a PSG channel at the given audio time,
  // sampling an active VOL sweep if present.
  _fmVolAtTime(ch, when) {
    return this._fmVolAtFrame(ch, this._eventFrame(when));
  }

  // A note's :vel and :vol macros are scheduled ahead, one after the other,
  // but on the driver each frame composes the LIVE values of both (driver.md
  // §7). So before either is written, the note-on samples both into timelines
  // — [value, time] pairs, nothing written — and each write reads the other's
  // value at its own time. Null where the note has no such macro.
  _levelMacroLines(noteArgs, when, gateTicks, limitSecs) {
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(when, gateTicks);
    const line = (spec, target) => {
      if (!spec) return null;
      const out = [];
      const onSeq = this._onSeq;
      this._onSeq = null; // a dry run: no UI callbacks
      try {
        // ...and when the level is done: after the last release write, else
        // at the gate (a CSM operator falls silent there, driver.md §9).
        out.end = this._scheduleMacro(spec, noteFrames, gateSecs, when,
          (v, t) => out.push([clampForTarget(target, v), t]),
          this._stepSecs(spec.step), limitSecs);
      } finally {
        this._onSeq = onSeq;
      }
      return out;
    };
    return { vel: line(noteArgs.velMacro, "VEL"), vol: line(noteArgs.vol, "VOL") };
  }

  // The latest sample at or before `t`, or null when the line has none yet.
  _lineAt(line, t) {
    if (t === undefined) return null; // no time: the standing values
    let v = null;
    for (const [value, at] of line ?? []) {
      if (at > t + 1e-9) break;
      v = value;
    }
    return v;
  }

  _fmLiveVelAt(ch, t) {
    return this._lineAt(this._fmLevelLines[ch]?.vel, t) ?? this._chRegs[ch].vel ?? 15;
  }

  _fmLiveVolAt(ch, t) {
    return this._lineAt(this._fmLevelLines[ch]?.vol, t) ?? this._fmVolAtTime(ch, t);
  }

  _fmVolAtFrame(ch, F) {
    const sweep = this._fmVolSweep?.[ch];
    return sweep ? this._sweepVolAtFrame(sweep, F) : (this._chRegs[ch].vol ?? VOL_UNITY);
  }

  _psgVolAtTime(psgCh, when) {
    return this._psgVolAtFrame(psgCh, this._eventFrame(when));
  }

  _psgVolAtFrame(psgCh, F) {
    const sweep = this._psgVolSweep?.[psgCh];
    return sweep ? this._sweepVolAtFrame(sweep, F) : (this._psgVol[psgCh] ?? VOL_UNITY);
  }

  _sweepVolAtFrame(sweep, F) {
    return Math.max(0, Math.min(31, this._sweepAtFrame(sweep, F)));
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

  // The sweep's value in driver frame F (held past a cut-short last frame),
  // and at an event's time.
  _sweepAtFrame(sw, F) {
    let f = Math.max(0, F - sw.startFrame);
    if (sw.frames != null) f = Math.min(f, sw.frames - 1);
    return this._sweepAt(sw, (sw.frameOffset ?? 0) + f);
  }

  _sweepAtTime(sw, when) {
    return this._sweepAtFrame(sw, this._eventFrame(when));
  }

  // Put each running inline sweep's shadow state back to its value at `when`
  // (its frames were all scheduled up front, leaving the state at `to`), so an
  // event composing from it — a NOTE_ON's carrier TL, a PARAM_ADD — reads what
  // the chip holds then. The re-write is the value that frame writes anyway.
  _syncParamSweeps(ch, when) {
    const sweeps = this._paramSweeps[ch];
    if (!sweeps?.size) return;
    for (const [key, sw] of sweeps) {
      // Past its last frame the state is that frame's value, and stays.
      const f = this._sweepFrameOf(sw, when);
      if (f >= sw.frames - 1) sweeps.delete(key);
      const frame = sw.frameOffset + Math.max(0, Math.min(sw.frames - 1, f));
      this._applyParam(
        ch, { args: { target: sw.target, value: this._sweepAt(sw, frame) }, _trackIndex: sw.trackIndex },
        when,
      );
    }
  }

  _paramSweepKey(ev, target) {
    return `${this._fm3OpOf(ev)}:${target}`;
  }

  // Set noise configuration (FB + NF bits) for PSG noise channel (ch 3).
  // modeVal: 0-7 encoding FB(1bit) + NF(2bits) → bits 5-3 of noise register
  _psgSetNoiseCfg(modeVal, when) {
    this._psgWrites(this._psg((c) => c.noise(modeVal, when)), when);
  }

  // Set tone period for a PSG tone channel (ch 0-2): the note through the
  // channel's `:snap` mask, the cents on top (as _writeFmNote).
  _psgSetPitch(psgCh, note, cents, when) {
    const hz = midiToHz(snapNote(note, this._psgSnap[psgCh] ?? 0) + cents / 100);
    this._psgWrites(this._lane(psgCh, (e, ch) => e.tone(ch, e.period(hz), when)), when);
    // `:env-rate note`: the envelope's period on this lane's pitch.
    this._psgHz[psgCh] = hz;
    if (this._envFollow === psgCh) this._writeEnvPeriod(hz, this._envBy(psgCh), when);
  }

  // Trigger the noise channel, re-asserting the current persistent noise mode.
  _psgTriggerNoise(when) {
    this._psgSetNoiseCfg(this._psgNoiseMode, when);
  }

  // Set PSG attenuation at note-on; schedule silence at note-off.
  // gateTicks === 0 = hold note (no auto-silence; triggerKeyOff() handles it).
  _schedulePsgEnvelope(psgCh, noteWhen, gateTicks, baseVel = 15, offWhen = null) {
    this._psgLastVel[psgCh] = Math.max(0, Math.min(15, baseVel));

    // Compose vel / vol / master → PSG attenuation (additive dB model).
    const vol = this._psgVolAtNoteOn(psgCh, noteWhen);
    const master = this._masterAtNoteOn(noteWhen);
    const att = this._composePsgAtt(psgCh, baseVel, vol, master);

    this._psgSetAtt(psgCh, att, noteWhen);
    // A running :vol sweep moves the level every frame the note is keyed.
    this._psgVolSweepWrites(psgCh, noteWhen, this._psgKeyedUntil[psgCh], baseVel);
    // Silence at the gate boundary; offWhen is null when the note holds or slurs
    // into the next (legato).
    if (offWhen != null) this._psgSetAtt(psgCh, this._psgOff(psgCh), offWhen);
  }

  // Write a PSG channel's :vol sweep frames in [fromWhen, untilWhen) — the
  // span its note is keyed, as the driver re-composes the attenuation on each
  // sweep frame of a keyed channel. The writes are ahead of time, so they
  // leave the channel's sounding flag as it was.
  _psgVolSweepWrites(psgCh, fromWhen, untilWhen, vel) {
    const vs = this._psgVolSweep[psgCh];
    const ms = this._masterSweep;
    // A held note's key-off comes live (triggerKeyOff), after these frames
    // would be queued: write none ahead rather than past its release.
    if ((!vs && !ms) || !Number.isFinite(untilWhen)) return;
    const end = Math.max(
      vs ? vs.startFrame + vs.frames : -Infinity,
      ms ? ms.startFrame + ms.frames : -Infinity,
    );
    // The frame the note keys off in is not keyed at its sweep step.
    const last = Math.min(end, this._eventFrame(untilWhen));
    const sounding = this._psgSounding[psgCh];
    for (let F = this._eventFrame(fromWhen); F < last; F++) {
      const t = Math.max(fromWhen, this._frameOrigin + F / 60);
      const att = this._composePsgAtt(psgCh, vel, this._psgVolAtFrame(psgCh, F), this._masterAtFrame(F));
      this._psgSetAtt(psgCh, att, t);
    }
    this._psgSounding[psgCh] = sounding;
  }

  // The level a PSG note-on composes. The driver runs a frame's notes before
  // its sweep step, so a note meets the level the sweep wrote the frame
  // before (the pre-sweep level on the sweep's own first frame), and that
  // frame's sweep step follows it (_psgVolSweepWrites from the note).
  // The master level at a time: a running :master sweep's value then.
  _masterAt(when) {
    return this._masterAtFrame(this._eventFrame(when));
  }

  _masterAtFrame(F) {
    const ms = this._masterSweep;
    if (!ms) return this._masterVol ?? VOL_UNITY;
    return Math.max(0, Math.min(31, Math.round(this._sweepAtFrame(ms, F))));
  }

  // The master a PSG note-on composes: as its :vol, the value the sweep wrote
  // the frame before (the driver steps sweeps after the frame's notes).
  _masterAtNoteOn(when) {
    const ms = this._masterSweep;
    if (!ms) return this._masterVol ?? VOL_UNITY;
    const f = this._sweepFrameOf(ms, when);
    if (f <= 0) return ms.prev;
    return Math.max(0, Math.min(31, Math.round(this._sweepAt(ms, ms.frameOffset + Math.min(f, ms.frames) - 1))));
  }

  // Before each event: the master state is the sweep's value at its time
  // (the sweep's frames were scheduled at once); a PARAM_SET MASTER ends it.
  _syncMasterSweep(ev, when) {
    const ms = this._masterSweep;
    if (!ms) return;
    this._masterVol = this._masterAt(when);
    const t = (ev.args?.target ?? "").toUpperCase();
    if (
      this._sweepFrameOf(ms, when) >= ms.frames - 1 ||
      (t === "MASTER" && (ev.cmd === "PARAM_SET" || ev.cmd === "PARAM_SWEEP_STOP"))
    )
      this._masterSweep = null;
  }

  // A channel whose level inputs just changed (a note's vel, its :vol) re-writes
  // its carriers over the rest of a running :master sweep — the sweep's own
  // frames were composed from the channel as it was when it started.
  _followMasterSweep(ch, when) {
    const ms = this._masterSweep;
    if (!ms || (ch === 2 && this._fm3Ops)) return;
    for (let k = Math.max(0, this._sweepFrameOf(ms, when) + 1); k < ms.frames; k++) {
      const t = this._sweepFrameTime(ms, k);
      const F = ms.startFrame + k;
      this._writeFmLevel(ch, t, { vol: this._fmVolAtFrame(ch, F), master: this._masterAtFrame(F) });
    }
  }

  _psgVolAtNoteOn(psgCh, when) {
    const sw = this._psgVolSweep[psgCh];
    if (!sw) return this._psgVol[psgCh] ?? VOL_UNITY;
    const f = this._sweepFrameOf(sw, when);
    if (f <= 0) return sw.prev;
    return Math.max(0, Math.min(31, this._sweepAt(sw, sw.frameOffset + Math.min(f, sw.frames) - 1)));
  }

  // A PSG note's level macros, :vel and :vol: each composes the attenuation
  // with the other's value at its time (and master), as the driver's writes
  // through the one level path do. A :vol macro is the channel's :vol, so its
  // last value stays for later notes.
  _schedulePsgLevelMacros(
    psgCh,
    velMacro,
    volMacro,
    noteWhen,
    gateTicks,
    baseVel = 15,
    limitSecs = Infinity,
    offWhen = null,
    velFirst = true, // bind order: which of the two steps first in a frame
    volAhead = new Map(), // frame → the :vol the track sets while the note sounds
  ) {
    this._psgLastVel[psgCh] = Math.max(0, Math.min(15, baseVel));
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(noteWhen, gateTicks);
    // Run each macro for its samples; the ends say when the level is done.
    const run = (spec, target) => {
      const out = [];
      if (!spec) return { out, end: null };
      const end = this._scheduleMacro(
        spec, noteFrames, gateSecs, noteWhen,
        (v, t) => out.push({ t, v: clampForTarget(target, v) }),
        this._stepSecs(spec.step), limitSecs,
      );
      return { out, end };
    };
    // The vel macro's output is the absolute velocity (0-15), matching FM and
    // the static-vel path; `:vel*` bakes any note-vel scaling in at compile
    // time, so the player must not scale again here.
    const vel = run(velMacro, "VEL");
    const vol = run(volMacro, "VOL");
    this._psgLevelAhead[psgCh] = !!(velMacro || volMacro);
    const at = (list, t, dflt) => {
      let v = dflt;
      for (const s of list) if (s.t <= t + 1e-9) v = s.v; else break;
      return v;
    };
    const velAt = (t) => at(vel.out, t, baseVel);
    const volAt = (t) => at(vol.out, t, null) ?? this._psgVolAtTime(psgCh, t);

    // The note-on composes from the macro's first :vel (a leading hold: the
    // note's own) and the :vol the channel holds; the macros' samples follow.
    const first = velMacro && !macroLeadsWithHold(velMacro) ? vel.out[0]?.v ?? baseVel : baseVel;
    // ...and the same for :vol: the note starts at its :vol macro's first
    // sample, else at the fader (driver.md §7.2, restore_level_base).
    const firstVol = volMacro && !macroLeadsWithHold(volMacro) && vol.out.length
      ? vol.out[0].v
      : this._psgVolAtNoteOn(psgCh, noteWhen);
    this._psgSetAtt(
      psgCh,
      this._composePsgAtt(psgCh, first, firstVol, this._masterAtNoteOn(noteWhen)),
      noteWhen,
    );
    // Frame by frame, in the driver's order: a running :vol or :master sweep
    // steps first (while keyed), composing with the note's vel as it stands,
    // then the macros' samples in bind order, each composing with the other's
    // value then. Every write that changes the level is an edge on the chip.
    const F0 = this._eventFrame(noteWhen);
    const frameOf = (list) => {
      const m = new Map();
      for (const x of list) m.set(this._eventFrame(x.t), x);
      return m;
    };
    const velF = frameOf(vel.out);
    const volF = frameOf(vol.out);
    const vs = this._psgVolSweep[psgCh];
    const ms = this._masterSweep;
    const keyEnd = this._eventFrame(this._psgKeyedUntil[psgCh]);
    const sweepEnd = Math.max(
      vs ? vs.startFrame + vs.frames : -Infinity,
      ms ? ms.startFrame + ms.frames : -Infinity,
    );
    const lastF = Math.max(
      ...[...velF.keys(), ...volF.keys()],
      ...[...volAhead.keys()].filter((F) => F < keyEnd),
      Math.min(Number.isFinite(keyEnd) ? keyEnd - 1 : F0, sweepEnd - 1),
      F0,
    );
    let velLive = first;
    let volNow = null; // the channel's :vol once a sweep step or the macro set it
    const volAtF = (F) => volNow ?? this._psgVolAtFrame(psgCh, F);
    const inSweep = (sw, F) => sw && F >= sw.startFrame && F < sw.startFrame + sw.frames;
    for (let F = F0; F <= lastF; F++) {
      const t = F === F0 ? noteWhen : Math.max(noteWhen, this._frameOrigin + F / 60);
      const master = this._masterAtFrame(F);
      const write = () => this._psgSetAtt(psgCh, this._composePsgAtt(psgCh, velLive, volAtF(F), master), t);
      if (F < keyEnd && volAhead.has(F)) {
        volNow = volAhead.get(F);
        write();
      }
      const vsOn = inSweep(vs, F);
      if (F < keyEnd && (vsOn || inSweep(ms, F))) {
        if (vsOn) volNow = Math.max(0, Math.min(31, this._sweepAtFrame(vs, F)));
        write();
      }
      const order = velFirst ? [[velF, "vel"], [volF, "vol"]] : [[volF, "vol"], [velF, "vel"]];
      for (const [m, which] of order) {
        const x = m.get(F);
        if (!x) continue;
        if (which === "vel") velLive = x.v;
        else volNow = x.v;
        write();
      }
    }
    // The :vol macro was this note's; the channel's fader stays the score's,
    // and the next note starts from it (driver.md §7.2).

    // Silence at the level's tail. offWhen is null when the note holds or slurs
    // into the next (legato) — leave the tone sounding for the next note. A
    // tail the next note cuts short (at its limit) leaves the level to that
    // note: no gap before it.
    const ends = [vel.end, vol.end].filter((e) => e !== null);
    const silenceAt = ends.length ? Math.max(...ends) : null;
    if (silenceAt !== null && offWhen != null && silenceAt < limitSecs - 1e-9) {
      this._psgSetAtt(psgCh, this._psgOff(psgCh), silenceAt);
    }
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
        this._psgSetNoiseCfg(this._snapMacroOutput("NOISE_MODE", v), t);
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
        // A note starting: a chip that keys something on it hears it (the
        // PC Engine's LFO restarts on channel 2's note, heard or at :vol 0).
        this._psgWrites(this._lane(psgCh, (e, ch) => e.keyOn?.(ch) ?? []), when);
        // A DDA note on this channel (another of its names) still sounding
        // ends here, its channel off a key-order lead before this key-on.
        if (this._toneEnc[psgCh]?.part?.sharePrio != null && this._ddaEncoder()) {
          const hits = this._chipPcm?.hits.get(`dda-${this._toneEnc[psgCh].ch}`);
          const h = hits?.findLast((x) => x.t < when - 1e-9 && x.end > when + 1e-9 && !x.dumped);
          if (h) { h.end = when; h.cut = true; }
        }

        // The PSG's noise lane — but for a noise whose note is its rate (the
        // 2A03's: `rateNote`), pitched as a tone, its mode re-asserted.
        const rateNote = psgCh === 3 && this._toneEnc[3]?.part?.rateNote;
        const isNoise = psgCh === 3 && !rateNote;
        const baseLengthTicks = ev.args.length;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const psgGateTicks = this._frameGate(when, this._resolveGateTicks(ev.args?.gate, lengthTicks), lengthTicks);
        // Monophonic priority: cut this note's macro tail a key-off lead before
        // the next note on this channel.
        const psgNextNote = this._nextNote(ev).secs;
        const psgMacroLimit = Number.isFinite(psgNextNote)
          ? psgNextNote - KEY_OFF_LEAD_SECS
          : Infinity;
        if (rateNote) {
          // Its mode re-asserted, and the note's :mode macro, as the PSG's
          // noise has them; its rate is the pitch below.
          this._psgTriggerNoise(when);
          this._envRetrigs = this._keyonRetrigTimes(ev.args?.keyon, when, psgGateTicks, psgMacroLimit);
          this._schedulePsgModeMacro(psgCh, ev.args?.noise_mode, when, psgGateTicks, psgMacroLimit);
          this._envRetrigs = null;
        }
        if (!isNoise) {
          const midi = pitchToMidi(ev.args?.pitch ?? "c4");
          this._psgCurrentMidi[psgCh] = midi;
          const psgCentOffset = this._onsetPitchOffset(
            `psg:${psgCh}`,
            when,
            this._psgPitchOffset[psgCh] ?? 0,
          );
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
          this._psgTriggerNoise(when);
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
          this._psgWrites(this._psg((c) => c.noiseRate?.(this._noiseRateBase) ?? []), when);
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
          (v, t) => this._psgWrites(this._psg((c) => c.noiseRate?.(v) ?? []), t));
        // A lane on the envelope starts it over at a key-on (a slur's goes on).
        const envShape = this._psgEnv[psgCh];
        if (envShape >= 0 && !ev.args?.legato)
          this._psgWrites(this._psg((c) => c.envShape?.(envShape) ?? []), when);
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
        if (velMacro || volMacro) {
          // A :keyon retrigger restarts the level envelopes (PSG has no
          // hardware one: this is the whole of the retrigger).
          this._envRetrigs = this._keyonRetrigTimes(ev.args?.keyon, when, psgGateTicks, psgMacroLimit);
          this._schedulePsgLevelMacros(
            psgCh,
            velMacro,
            volMacro,
            when,
            psgGateTicks,
            baseVel,
            psgMacroLimit,
            psgOffWhen,
            Object.keys(ev.args).indexOf("velMacro") < Object.keys(ev.args).indexOf("vol") ||
              !volMacro,
            this._volSetsAhead(ev),
          );
          this._envRetrigs = null;
        } else {
          this._psgLevelAhead[psgCh] = false;
          this._schedulePsgEnvelope(psgCh, when, psgGateTicks, baseVel, psgOffWhen);
        }
        break;
      }

      // A `$slot` write lands as the PARAM_SET of the slot's value (as the FM
      // path's does).
      case "PARAM_FROM_VAL":
        this._dispatchPsgEvent(
          { ...ev, cmd: "PARAM_SET", args: { target: ev.args?.target, value: this._resolveSrc(ev.args?.src, when) } },
          when,
        );
        break;

      case "PARAM_SET":
      case "PARAM_SWEEP": {
        const psgTarget = (ev.args?.target ?? "").toUpperCase();
        if (psgTarget === "SNAP") {
          // Sticky mask (language.md §5.3); the sounding note moves onto it.
          this._psgSnap[psgCh] = Math.max(0, Math.min(0xfff, Math.round(Number(ev.args?.value) || 0)));
          if (psgCh !== 3)
            this._psgSetPitch(psgCh, this._psgCurrentMidi[psgCh] ?? 60, this._psgPitchOffset[psgCh] ?? 0, when);
        } else if (psgTarget === "VOL") {
          if (ev.cmd === "PARAM_SET") {
            // Immediate vol: store, and update hardware only if a note is keyed
            // at `when` (otherwise it takes effect at the next NOTE_ON; writing
            // att to an idle channel would drone a tone). Keyed by time, not
            // by _psgSounding: a note's key-off is scheduled at its onset, so
            // that flag already reads silent during the note — a :vol before
            // a tie's `~` was lost.
            const vol = Math.max(0, Math.min(31, ev.args?.value ?? VOL_UNITY));
            this._psgVol[psgCh] = vol;
            this._psgVolSweep[psgCh] = null;
            const until = this._psgKeyedUntil[psgCh] ?? 0;
            if (when < until - 1e-6) {
              // A note with a level macro wrote this set in with its frames
              // at its onset (_volSetsAhead); one without composes it now.
              if (!this._psgLevelAhead[psgCh]) {
                const velLevel = this._psgLastVel[psgCh] ?? 15;
                const master = this._masterVol ?? VOL_UNITY;
                this._psgSetAtt(psgCh, this._composePsgAtt(psgCh, velLevel, vol, master), when);
              }
            }
          } else {
            // PARAM_SWEEP: store sweep state (same format as _fmVolSweep); a
            // note samples it at its onset and writes its frames while keyed.
            // No :from: the sweep starts where the level is now (§11).
            const df = this._curveFields(ev.args ?? {}, when);
            const prev = this._psgVolAtTime(psgCh, when);
            const from = Math.max(0, Math.min(31, Number(df.from ?? prev)));
            const to = Math.max(0, Math.min(31, Number(df.to ?? from)));
            const baseFrames = ev.args?.lenFrames
              ? Math.max(1, Math.round(Number(ev.args?.frames ?? 1)))
              : Math.max(1, Math.round(Number(ev.args?.frames ?? 1) * this._secsPerTick * 60));
            const loop = !!ev.args?.loop;
            const { budgetFrames, nonLoopStartFrame, loopPhaseOffset } =
              this._sweepFrameParams(ev, baseFrames, loop, when);
            this._psgVolSweep[psgCh] = {
              from, to, curve: ev.args?.curve ?? "linear", params: df.params,
              baseFrames, loop,
              frameOffset: loop ? loopPhaseOffset : nonLoopStartFrame,
              // One-shot: its last frame writes `to`, and the level holds.
              frames: loop
                ? budgetFrames
                : Math.min(budgetFrames, Math.max(1, baseFrames - nonLoopStartFrame)),
              startWhen: when,
              startFrame: this._eventFrame(when),
              prev,
            };
            this._psgVol[psgCh] = from; // initial value for MASTER recalc fallback
            if (this._psgKeyedUntil[psgCh] > when)
              this._psgVolSweepWrites(psgCh, when, this._psgKeyedUntil[psgCh], this._psgLastVel[psgCh] ?? 15);
          }
        } else if (psgTarget === "SSG_ENV") {
          // The lane's level on the envelope (a shape), or its own (-1): a
          // sounding note changes over now; the shape starts at its key-on.
          const shape = Math.round(Number(ev.args?.value ?? -1));
          this._psgEnv[psgCh] = shape < 0 ? -1 : Math.min(15, shape);
          if (this._psgSounding[psgCh] && when < (this._psgKeyedUntil[psgCh] ?? 0) - 1e-6) {
            const att = this._composePsgAtt(psgCh, this._psgLastVel[psgCh] ?? 15, this._psgVol[psgCh], this._masterVol ?? VOL_UNITY);
            this._psgSetAtt(psgCh, att, when);
          }
        } else if (psgTarget === "ENV_SEMI" || psgTarget === "ENV_DETUNE") {
          // The lane's moves on its envelope's period: a period following
          // its notes moves now, a rate it writes at its next write.
          const v = Math.round(Number(ev.args?.value ?? 0));
          (psgTarget === "ENV_SEMI" ? this._envSemi : this._envDetune)[psgCh] = v;
          if (this._envFollow === psgCh && this._psgHz[psgCh] > 0)
            this._writeEnvPeriod(this._psgHz[psgCh], this._envBy(psgCh), when);
        } else if (psgTarget === "SSG_MIX") {
          // The SSG channel's mixer: tone, noise or both (chips/ssg.js).
          this._ssgMixBase[psgCh] = Math.round(ev.args?.value ?? 0);
          this._psgWrites(this._lane(psgCh, (e, ch) => e.mix(ch, this._ssgMixBase[psgCh], when)), when);
        } else if (psgTarget === "FM_FMS") {
          // Channel 1 taking the wave chip's LFO (chips/huc6280.js).
          this._psgWrites(this._lane(psgCh, (e, ch) => e.lfo?.(ch, Number(ev.args?.value ?? 0)) ?? []), when);
        } else if (psgTarget === "DUTY") {
          // A pulse's duty in sixteenths, a value or a sweep a frame at a
          // time; the encoder takes the nearest the chip has.
          this._writeSongRate(ev, when, this._psgDuty[psgCh] ?? 8, (v, t) => this._psgSetDuty(psgCh, v, t));
        } else if (psgTarget === "PAN") {
          // A channel's own pan (the PC Engine's $05): a value, or a sweep a
          // frame at a time, on the encoder's fifteenths of a side.
          this._writeSongRate(ev, when, this._psgPan[psgCh], (v, t) => this._psgSetPan(psgCh, v, t), 15);
        } else if (psgTarget === "WAVE") {
          // A wave channel's def-wave (metadata.waves): its memory written
          // whole (chips/k051649.js — channels 4 and 5 share one). A wave
          // expression with a $slot (`expr`) is written now and again in
          // each frame its slots have moved (_waveExprFrames).
          this._laneExpr[psgCh] = null;
          if (ev.args?.expr) {
            this._laneWave[psgCh] = null;
            const slots = [...waveSlots(ev.args.expr)];
            const vals = slots.map((n) => this._resolveSrc(n, when));
            this._laneExpr[psgCh] = { tree: ev.args.expr, slots, vals, nextFrame: this._eventFrame(when) + 1 };
            this._writeWaveExpr(psgCh, when);
          }
          if (!ev.args?.expr) this._writeLaneWaveIndex(psgCh, ev.args?.value ?? -1, when);
        } else if (psgTarget === "NOISE_MODE") {
          // Update the persistent noise mode. Re-asserted on every noise NOTE_ON;
          // if the channel is currently sounding, take effect immediately.
          this._psgNoiseMode = this._snapMacroOutput(
            "NOISE_MODE",
            ev.args?.value ?? 0,
          );
          if (this._psgSounding[psgCh]) {
            this._psgSetNoiseCfg(this._psgNoiseMode, when);
          }
        } else if (psgTarget === "NOTE_PITCH") {
          const from = Number(ev.args?.from ?? ev.args?.value ?? this._psgPitchOffset[psgCh] ?? 0);
          const to = Number(ev.args?.to ?? from);
          const curve = ev.args?.curve ?? "linear";
          const secsPerTick = this._secsPerTick;
          // ev.args.frames is ticks, or frames when an Nf `:len` set
          // lenFrames — as on the FM path.
          const baseFrames = ev.args?.dyn?.len != null
            ? this._resolveLenFrames(ev.args, null, when)
            : ev.args?.lenFrames
              ? Math.max(1, Math.round(Number(ev.args?.frames ?? 1)))
              : Math.max(1, Math.round(Number(ev.args?.frames ?? 1) * secsPerTick * 60));
          const loop = !!ev.args?.loop;
          const framesPerTick = secsPerTick * 60;
          const { budgetFrames, loopPhaseOffset, endTick } =
            ev.cmd === "PARAM_SWEEP"
              ? this._sweepFrameParams(ev, baseFrames, loop, when)
              : { budgetFrames: 1, loopPhaseOffset: 0, endTick: undefined };
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
              if (ne.cmd !== "NOTE_ON" || ne._route.core !== "psg") continue;
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
          // Stepped as the FM path steps it: the driver's integer curve and
          // its frame grid (_sweepAt / _sweepFrameTime), so a PSG glide writes
          // the periods the driver writes, on its frames.
          const sw = {
            from, to, curve, params: ev.args?.params, baseFrames, loop,
            frameOffset: loopPhaseOffset, startWhen: when, startFrame: this._eventFrame(when),
          };
          for (let frame = 0; frame < budgetFrames; frame++) {
            const frameTick = ev.tick + frame / Math.max(1e-9, framesPerTick);
            while (frameTick >= nextNoteTick) {
              baseMidi = nextNoteMidi;
              advance();
            }
            const centOffset = ev.cmd === "PARAM_SWEEP"
              ? Math.round(this._sweepAt(sw, loopPhaseOffset + frame))
              : from;
            this._psgPitchOffset[psgCh] = centOffset;
            if (frame === 0)
              this._pitchSweepOnset.set(`psg:${psgCh}`, {
                when,
                offset: centOffset,
              });
            this._psgSetPitch(
              psgCh,
              baseMidi,
              centOffset,
              ev.cmd === "PARAM_SWEEP" ? this._sweepFrameTime(sw, frame) : when,
            );
          }
          // Bounded glide: snap to the exact target so a short glide that ends
          // mid-slope leaves no residual offset for later notes (see the FM path).
          if (ev.args?.bounded && !this._glideCut(ev, endTick)) {
            this._psgPitchOffset[psgCh] = to;
            this._psgSetPitch(psgCh, baseMidi, to, when + budgetFrames / 60);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  _writeKeyOff(chIndex) {
    this._fmKey(chIndex, 0); // all operators off
  }

  // Whether a note at `when` keys nothing: its channel's vol or the master
  // at 0 (a vol is volume, so 0 mutes; vel never does).
  _fmNoteSilent(ch, when) {
    const regs = this._chRegs[ch];
    return ((regs?.vol != null || this._fmVolSweep[ch] != null) && this._fmVolAtTime(ch, when) === 0)
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
      this._write(0, 0x2b, 0); // DAC off
    }
  }
}

// The pc88 sample voices' moving parameters: their range, and their value
// before the track writes one.
const CHIP_PCM_PARAM = {
  vol: { fit: (v) => Math.max(0, Math.min(31, v)), rest: VOL_UNITY },
  pitch: { fit: (v) => v, rest: 0 },
};

// A level line, [{ t, v }] by time: the entry in force at `t`.
function lineEntryAt(line, t) {
  if (!line) return undefined;
  let e;
  for (const x of line) {
    if (x.t > t + 1e-9) break;
    e = x;
  }
  return e;
}

function insertLine(line, t, v) {
  let i = line.length;
  while (i > 0 && line[i - 1].t > t) i--;
  line.splice(i, 0, { t, v });
}
