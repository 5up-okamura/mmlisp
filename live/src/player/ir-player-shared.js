// IRPlayer's shared constants and helpers (ir-player.js and its parts):
// the frame order's phases, the routes and words the dispatchers share.
import { TARGETS, TONE_LANES, toneLaneOf } from "../machine/targets.js";
import { bpmToTickIncrement, tickIncrementToBpm } from "../driver/mmb.js";
import { FM_CHANNEL_WORDS, FM_OP_WORDS, opWords } from "../machine/chips/fm-words.js";

// A held DDA note (:len 0) with no next note: how long its sample is written.
export const DDA_HOLD_SEC = 30;
// The DMC's sample is loaded this far ahead of its key-on: before the
// frame's writes start it, after the previous hit has all but ended.
export const DMC_LOAD_LEAD_SECS = 0.0005;
// The largest point a PCM point target can name: the bank's usable window
// (export-mmb.js PCM_LOOP_MAX — the same clamp the MMB exporter applies).
export const PCM_LOOP_MAX = 0x7f00;
// The most FM channels a target has (targets/: the OPM's eight); a
// channel's shadow state and per-channel arrays are this long whatever the
// chip.
export const FM_CHANNELS = Math.max(
  ...Object.values(TARGETS).map((t) => t.chipForKind("fm")?.fmEncoder().channels ?? 0));
// The player's cores, by a part's kind (chips/parts.js): the FM core, the PSG
// core and the sample core. The PSG core plays the tone lanes (targets.js
// toneLaneOf), each through its chip's encoder: the PSG's tones at 0-2 and
// its noise at 3 (chips/: psgEncoder), the wave channels from 4 (waveEncoder).
// A part of another kind has no core yet.
// A MIDI channel has no chip to write (chips/midi.js): the `none` core keeps
// its events on the clock and writes nothing.
export const CORE_OF_KIND = { fm: "fm", tone: "psg", noise: "psg", wave: "psg", sample: "sample", midi: "none" };
export const PSG_LANES = TONE_LANES; // the PSG core's
// The sample core's handler for each sample part: the chips' own voices (the
// YM2608's rhythm and ADPCM-B, the OPLL's rhythm), PCM8's mix, the Mega
// Drive driver's DAC mix.
// Where a PSG or sample track's song-wide LFO write goes: the FM core's
// channel 0, as the driver takes it from any track.
export const FM_LFO_ROUTE = { core: "fm", part: null, lane: 0 };
export const SAMPLE_HANDLERS = {
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
// The events that take time on their track: a note, a rest, a tie.
export const TIMED_CMDS = new Set(["NOTE_ON", "PCM_NOTE_ON", "REST", "TIE"]);
export const KEYED = 0, SWEEP = 1, MACRO = 2, SONG = 3, AFTER = 4; // (AFTER: what follows a frame's steps — a PCM retrigger)
// A :keyon retrigger: after the frame's dispatch (a gate's close) and before
// its other macros' steps, as the driver steps its KEYON slots first.
export const KEYON = 1.5;
// Channel 3's shared $28 in FM3 mode, then its CSM operators' levels: the
// frame's edges once every write to them is known (_fm3Edge), each
// at its own time.
export const FM3_KEYS = 5, FM3_TL = 6;
// The DDA's sample stream (_chipPcmNext): each frame's samples, once the
// frame's steps are done, at the frame's start.
export const VOICES = 7;
// The phases whose writes keep their own time (_runWork).
export const UNSHIFTED = new Set([KEYED, FM3_KEYS, FM3_TL, VOICES]);
// The words that are the song's, not a channel's: one slot each, stepped
// after every channel's in a frame (SONG).
export const SONG_WORDS = new Set(["MASTER", "LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE", "NOISE_RATE", "ENV_RATE"]);
// A song-wide word: those, and the value slots (VAL0–15) — the driver's
// global sweeps (driver.md §4 step 4).
export const isSongWord = (target) => SONG_WORDS.has(target) || /^VAL\d+$/.test(target);
// The writes that free a sweep's slot (driver.md §4 step 3).
export const SLOT_FREEING = new Set(["PARAM_SET", "PARAM_SWEEP", "PARAM_SWEEP_STOP"]);
// The song-wide LFO words: the OPN's rate, the OPM's own (chips/ym2151.js).
export const LFO_TARGETS = new Set(["LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE"]);
// The song's LFO words a wave chip's encoder takes (chips/huc6280.js, fds.js).
export const WAVE_LFO_WORDS = { LFO_FREQ: "lfoFreq", LFO_PMD: "lfoPmd", LFO_WAVE: "lfoTable" };
// The song-wide words the panel takes in hand by a gate (IRPlayer.hold): a
// score event's word, or null. (MASTER is a level: laid over, _handMaster.)
export const HAND_PARAMS = new Set(LFO_TARGETS);
// A score event that writes a track's :vol: the word, or a note's :vol macro.
export const writesVol = (ev) => (ev.cmd.startsWith("PARAM_") ? String(ev.args?.target ?? "").toUpperCase() === "VOL"
  : (ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") && ev.args?.vol != null);
export function handWordOf(ev) {
  if (ev.cmd === "TEMPO_SET" || ev.cmd === "TEMPO_SWEEP") return "tempo";
  if (!ev.cmd.startsWith("PARAM_")) return null;
  const t = String(ev.args?.target ?? "").toUpperCase();
  return HAND_PARAMS.has(t) ? t : null;
}
// `:lfo-sync`'s reset is the LFO stopped and run again (chips/opn-fm.js,
// ym2151.js `lfoReset`): each write this far apart, the last this far ahead
// of the key, so the chip clocks between them — a write lands on an output
// sample (the synths' renderInto), and two on one would never reset it.
export const LFO_RESET_GAP = 1e-4;
// Half a millisecond: late enough to sort after every event of its frame,
// far too early to hear.
export const PCM_SWEEP_AFTER = 0.0005;
// A PCM note's points (language.md §16): its loop (:loop-*) and its range (:pcm-*).
export const PCM_POINT_TARGETS = new Set(["LOOP_START", "LOOP_END", "LOOP_LEN",
  "RANGE_START", "RANGE_END", "RANGE_LEN"]);

// The curve names the driver computes as written (driver.md §8); a sweep on
// one of these previews the driver's integer steps (_sweepAt).
export const DRIVER_SWEEP_CURVES = new Set([
  "linear", "ease-in", "ease-in-quad", "ease-out", "ease-out-quad",
  "ease-inout", "ease-inout-quad", "sin", "triangle", "square", "saw", "ramp",
]);

// The tracks a playback takes from the IR: the song's (every track but an
// effect's part), or one effect's parts alone — renumbered, since a track's
// index is its id here.
// The NOTE_ON macro args an FM note runs on its channel's words (_noteMacro),
// keyed as makeNoteArgs writes them (fm_tl1 → FM_TL1). :vel and :vol are the
// note's level (_lvMacros); these are the channel's other targets.
export const OP_MACRO_MAP = [
  ["pan", "PAN"],
  // The FM family's (chips/fm-words.js): a macro's key is its word lower-cased.
  ...[...FM_CHANNEL_WORDS, ...opWords(FM_OP_WORDS.filter((w) => !w.inline))].map((w) => [w.word.toLowerCase(), w.word]),
];

// An FM operator target's field in the shadow register file (_readParam):
// the table's, the TL's being the voiced level the composition starts from.
export const OP_REG_FIELD = Object.fromEntries(
  FM_OP_WORDS.filter((w) => !w.inline).map((w) => [w.word.slice(3), w.word === "FM_TL" ? "voicedTl" : w.field]));

export function songOrEffectIr(ir, se) {
  const tracks = (ir?.tracks ?? []).filter((t) => (se == null ? !t.se : t.se?.index === se));
  if (tracks.length === (ir?.tracks ?? []).length) return ir;
  return { ...ir, tracks: tracks.map((t, i) => ({ ...t, id: i })) };
}

// A tempo as the driver runs it: its tick increment, read back (the driver
// has no fractional BPM — 120 is an increment of 819, 119.97 BPM).
export function drvBpm(bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? tickIncrementToBpm(bpmToTickIncrement(bpm)) : bpm;
}

// Control-flow and timing events do not represent a sounding position, so they
// must not move the editor playhead highlight. Without this, a zero-duration
// loop (e.g. `#loop (go loop)` with no notes) fires MARKER/JUMP at the
// scheduler's max rate and the highlight flickers on `go` / `#loop`.
export const PLAYHEAD_SKIP_CMDS = new Set([
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
export function gcd(a, b) {
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
export function scaleMacroSample(sample, slotValue) {
  const depth = (slotValue & 0xff) >>> 0;
  const mag = (Math.abs(sample) * depth) >> 8;
  return sample < 0 ? -mag : mag;
}

export function lcm(a, b) {
  a = Math.max(1, Math.round(a));
  b = Math.max(1, Math.round(b));
  const g = gcd(a, b);
  return g ? (a / g) * b : a;
}

// The FM encoder of a target with no FM (the MSX's PSG alone): no channels,
// so nothing reaches it but the run's globals.
export const NO_FM = { channels: 0, csm: false, isKeyOn: () => false, lfo: () => [] };

// ---------------------------------------------------------------------------
// IRPlayer
// ---------------------------------------------------------------------------
