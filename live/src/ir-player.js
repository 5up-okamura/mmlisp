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
  velToTlAtten,
  volToTlOffset,
  volToLinearGain,
  velToPsgAtten,
  volToPsgOffset,
  VOL_UNITY,
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

const YM2612_MASTER_CLOCK = 7670454;
const MMB_SECTION = {
  TRACK_TABLE: 0x0001,
  EVENT_STREAM: 0x0002,
  METADATA: 0x0003,
  SAMPLE_BANK: 0x0004,
};

const MMB_OPCODE_TO_CMD = {
  0x10: "NOTE_ON",
  0x11: "REST",
  0x12: "TIE",
  0x40: "LOOP_BEGIN",
  0x41: "LOOP_END",
  0x42: "MARKER",
  0x43: "JUMP",
  0x60: "PARAM_SET",
  0x61: "PARAM_SWEEP",
  0x80: "TEMPO_SET",
  0xc0: "PCM_NOTE_ON",
  0xc1: "PCM_NOTE_OFF",
};

const MMB_TARGET_ID_TO_NAME = {
  0x01: "NOTE_PITCH",
  0x02: "NOTE_VOLUME",
  0x03: "TEMPO_SCALE",
  0x04: "VOL",
  0x10: "FM_FB",
  0x15: "FM_ALG",
  0x11: "FM_TL1",
  0x12: "FM_TL2",
  0x13: "FM_TL3",
  0x14: "FM_TL4",
  0x16: "FM_AR1",
  0x17: "FM_AR2",
  0x18: "FM_AR3",
  0x19: "FM_AR4",
  0x1a: "FM_DR1",
  0x1b: "FM_DR2",
  0x1c: "FM_DR3",
  0x1d: "FM_DR4",
  0x1e: "FM_SR1",
  0x1f: "FM_SR2",
  0x20: "FM_SR3",
  0x21: "FM_SR4",
  0x22: "FM_RR1",
  0x23: "FM_RR2",
  0x24: "FM_RR3",
  0x25: "FM_RR4",
  0x26: "FM_SL1",
  0x27: "FM_SL2",
  0x28: "FM_SL3",
  0x29: "FM_SL4",
  0x2a: "FM_KS1",
  0x2b: "FM_KS2",
  0x2c: "FM_KS3",
  0x2d: "FM_KS4",
  0x2e: "FM_ML1",
  0x2f: "FM_ML2",
  0x30: "FM_ML3",
  0x31: "FM_ML4",
  0x32: "FM_DT1",
  0x33: "FM_DT2",
  0x34: "FM_DT3",
  0x35: "FM_DT4",
  0x36: "FM_SSG1",
  0x37: "FM_SSG2",
  0x38: "FM_SSG3",
  0x39: "FM_SSG4",
  0x3a: "FM_AMEN1",
  0x3b: "FM_AMEN2",
  0x3c: "FM_AMEN3",
  0x3d: "FM_AMEN4",
  0x3e: "FM_AMS",
  0x3f: "FM_FMS",
  0x41: "LFO_RATE",
};

const MMB_CHANNEL_ID_TO_NAME = {
  0: "fm1",
  1: "fm2",
  2: "fm3",
  3: "fm4",
  4: "fm5",
  5: "fm6",
  6: "psg1",
  7: "psg2",
  8: "psg3",
  9: "noise",
  16: "fm3op2",
  17: "fm3op3",
  18: "fm3op4",
  20: "pcm1",
  21: "pcm2",
  22: "pcm3",
};

const TEXT_DECODER = new TextDecoder();

// Control-flow and timing events do not represent a sounding position, so they
// must not move the editor playhead highlight. Without this, a zero-duration
// loop (e.g. `#loop (go loop)` with no notes) fires MARKER/JUMP at the
// scheduler's max rate and the highlight flickers on `go` / `#loop` / `score`.
const PLAYHEAD_SKIP_CMDS = new Set([
  "MARKER",
  "JUMP",
  "LOOP_BEGIN",
  "LOOP_END",
  "TEMPO_SET",
  "TEMPO_SWEEP",
]);

function readU16LE(view, offset) {
  return view.getUint16(offset, true);
}

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

function lcm(a, b) {
  a = Math.max(1, Math.round(a));
  b = Math.max(1, Math.round(b));
  const g = gcd(a, b);
  return g ? (a / g) * b : a;
}

function readI16LE(view, offset) {
  return view.getInt16(offset, true);
}

function readU32LE(view, offset) {
  return view.getUint32(offset, true);
}

function readF64LE(view, offset) {
  return view.getFloat64(offset, true);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function midiToPitchString(midi) {
  const names = [
    "c",
    "c+",
    "d",
    "d+",
    "e",
    "f",
    "f+",
    "g",
    "g+",
    "a",
    "a+",
    "b",
  ];
  const note = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${names[note]}${octave}`;
}

function parseMetadataSection(bytes, section) {
  const metadata = {};
  if (!section) return metadata;
  const end = section.offset + section.size;
  let pos = section.offset;
  while (pos < end) {
    const keyLen = bytes[pos];
    if (!keyLen) break;
    pos += 1;
    if (pos + keyLen + 2 > end) break;
    const key = TEXT_DECODER.decode(bytes.subarray(pos, pos + keyLen));
    pos += keyLen;
    const valLen = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    if (pos + valLen > end) break;
    const value = TEXT_DECODER.decode(bytes.subarray(pos, pos + valLen));
    pos += valLen;
    metadata[key] = value;
  }
  return metadata;
}

function readSampleBankRecord(bytes, view, pos, sampleIndex, end) {
  if (pos + 2 > end) {
    throw new Error(`SAMPLE_BANK sample ${sampleIndex} truncated header`);
  }
  const sampleId = bytes[pos];
  const nameLen = bytes[pos + 1];
  pos += 2;
  if (sampleId === 0) {
    throw new Error(
      `SAMPLE_BANK sample ${sampleIndex} has invalid sample id 0`,
    );
  }
  if (pos + nameLen + 20 > end) {
    throw new Error(`SAMPLE_BANK sample ${sampleIndex} truncated record`);
  }

  const name = TEXT_DECODER.decode(bytes.subarray(pos, pos + nameLen));
  pos += nameLen;
  const sampleRate = readU32LE(view, pos);
  const frameCount = readU32LE(view, pos + 4);
  const loopStart = readU32LE(view, pos + 8);
  const loopEnd = readU32LE(view, pos + 12);
  const dataLen = readU32LE(view, pos + 16);
  pos += 20;

  if (sampleRate === 0) {
    throw new Error(
      `SAMPLE_BANK sample ${sampleIndex} has invalid sample rate`,
    );
  }
  if (loopEnd < loopStart || loopEnd > frameCount) {
    throw new Error(`SAMPLE_BANK sample ${sampleIndex} has invalid loop range`);
  }
  if (pos + dataLen > end) {
    throw new Error(`SAMPLE_BANK sample ${sampleIndex} truncated PCM data`);
  }
  if (dataLen !== frameCount) {
    throw new Error(`SAMPLE_BANK sample ${sampleIndex} frame count mismatch`);
  }

  return {
    sampleId,
    name,
    sampleRate,
    frameCount,
    loopStart,
    loopEnd,
    data: bytes.subarray(pos, pos + dataLen),
    nextPos: pos + dataLen,
  };
}

function parseSampleBankSection(bytes, view, section) {
  const samples = [];
  const sampleById = new Map();
  if (!section) return { samples, sampleById };

  const end = section.offset + section.size;
  if (end - section.offset < 2) {
    throw new Error("SAMPLE_BANK section too small");
  }

  const sampleCount = readU16LE(view, section.offset);
  let pos = section.offset + 2;
  for (let i = 0; i < sampleCount; i++) {
    const record = readSampleBankRecord(bytes, view, pos, i, end);
    pos = record.nextPos;
    sampleById.set(record.sampleId, record.name);
    samples.push({
      name: record.name,
      rate: record.sampleRate,
      loopStart: record.loopStart,
      loopEnd: record.loopEnd,
      compiled: {
        format: "pcm_s8",
        sourceSampleRate: record.sampleRate,
        frames: record.frameCount,
        dataBase64: bytesToBase64(record.data),
      },
    });
  }

  return { samples, sampleById };
}

function parseEventPayload(cmd, bytes, view, offset, sampleById) {
  switch (cmd) {
    case "NOTE_ON":
      return {
        pitch: midiToPitchString(bytes[0]),
        length: readU16LE(view, offset + 1),
      };
    case "REST":
    case "TIE":
      return { length: readU16LE(view, offset) };
    case "LOOP_BEGIN": {
      const id = `l${bytes[0]}`;
      return { id };
    }
    case "LOOP_END": {
      const id = `l${bytes[0]}`;
      return { id, repeat: bytes[1] };
    }
    case "MARKER": {
      const id = `m${bytes[0]}`;
      return { id };
    }
    case "JUMP":
      return { relOffset: readI16LE(view, offset) };
    case "PARAM_SET": {
      const target = MMB_TARGET_ID_TO_NAME[bytes[0]] ?? `TARGET_${bytes[0]}`;
      return { target, value: readI16LE(view, offset + 1) };
    }
    case "PARAM_SWEEP": {
      const target = MMB_TARGET_ID_TO_NAME[bytes[0]] ?? `TARGET_${bytes[0]}`;
      const flags = bytes[1];
      let rel = 2;
      const args = {
        target,
        loop: (flags & 0x01) !== 0,
      };
      if (flags & 0x02) {
        args.from = readI16LE(view, offset + rel);
        rel += 2;
      }
      args.to = readI16LE(view, offset + rel);
      rel += 2;
      args.frames = readU16LE(view, offset + rel);
      rel += 2;
      const curveLen = bytes[rel];
      rel += 1;
      args.curve = TEXT_DECODER.decode(bytes.subarray(rel, rel + curveLen));
      rel += curveLen;
      const paramsCount = bytes[rel];
      rel += 1;
      if (paramsCount > 0) {
        const params = {};
        for (let i = 0; i < paramsCount; i += 1) {
          const keyLen = bytes[rel];
          rel += 1;
          const key = TEXT_DECODER.decode(bytes.subarray(rel, rel + keyLen));
          rel += keyLen;
          params[key] = readF64LE(view, offset + rel);
          rel += 8;
        }
        args.params = params;
      }
      return args;
    }
    case "TEMPO_SET":
      return { bpm: readU16LE(view, offset) };
    case "PCM_NOTE_ON": {
      const sample = sampleById.get(bytes[0]) ?? `sample${bytes[0]}`;
      return {
        sample,
        rate: readU16LE(view, offset + 1) / 256,
        length: readU16LE(view, offset + 3),
        vel: bytes[5],
        mode: bytes[6] === 1 ? "loop" : "shot",
        baseRate: readU16LE(view, offset + 7),
      };
    }
    case "PCM_NOTE_OFF": {
      const sample = sampleById.get(bytes[0]) ?? `sample${bytes[0]}`;
      return { sample, mode: bytes[1] === 1 ? "loop" : "shot" };
    }
    default:
      throw new Error(`Unsupported MMB opcode: ${cmd}`);
  }
}

function parseMmbBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (bytes.length < 16) throw new Error("MMB file too small");
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "MMB0") {
    throw new Error("Bad MMB magic");
  }

  const sectionCount = readU16LE(view, 8);
  const headerSize = readU16LE(view, 10);
  if (headerSize !== 16)
    throw new Error(`Unexpected MMB header size ${headerSize}`);

  const sections = new Map();
  for (let i = 0; i < sectionCount; i += 1) {
    const off = 16 + i * 12;
    if (off + 12 > bytes.length)
      throw new Error("MMB section directory out of bounds");
    const id = readU16LE(view, off);
    const sectionOffset = readU32LE(view, off + 4);
    const sectionSize = readU32LE(view, off + 8);
    if (sectionOffset + sectionSize > bytes.length) {
      throw new Error(`MMB section ${id} out of bounds`);
    }
    sections.set(id, { offset: sectionOffset, size: sectionSize });
  }

  const { samples, sampleById } = parseSampleBankSection(
    bytes,
    view,
    sections.get(MMB_SECTION.SAMPLE_BANK),
  );
  const metadata = parseMetadataSection(
    bytes,
    sections.get(MMB_SECTION.METADATA),
  );
  if (samples.length > 0) {
    metadata.samples = samples;
  }

  const trackSection = sections.get(MMB_SECTION.TRACK_TABLE);
  const eventSection = sections.get(MMB_SECTION.EVENT_STREAM);
  if (!trackSection) throw new Error("missing TRACK_TABLE section");
  if (!eventSection) throw new Error("missing EVENT_STREAM section");

  const trackCount = readU16LE(view, trackSection.offset);
  const expectedSize = 4 + trackCount * 12;
  if (expectedSize > trackSection.size) {
    throw new Error("TRACK_TABLE size mismatch");
  }

  const tracks = [];
  let pos = trackSection.offset + 4;
  for (let i = 0; i < trackCount; i += 1) {
    const trackId = readU16LE(view, pos);
    const channelId = readU16LE(view, pos + 2);
    const eventOffset = readU32LE(view, pos + 4);
    const eventLength = readU32LE(view, pos + 8);
    pos += 12;

    const channel = MMB_CHANNEL_ID_TO_NAME[channelId] ?? `ch${channelId}`;
    const start = eventSection.offset + eventOffset;
    const end = start + eventLength;
    if (
      start > eventSection.offset + eventSection.size ||
      end > eventSection.offset + eventSection.size
    ) {
      throw new Error(
        `track ${trackId} event range out of EVENT_STREAM bounds`,
      );
    }

    const events = [];
    const markerByBytePos = new Map();
    const jumps = [];
    let eventPos = start;
    let tick = 0;
    while (eventPos < end) {
      if (eventPos + 5 > end)
        throw new Error(`track ${trackId} truncated event header`);
      const delta = readU16LE(view, eventPos);
      const opcode = bytes[eventPos + 2];
      const payloadLen = readU16LE(view, eventPos + 3);
      const cmd = MMB_OPCODE_TO_CMD[opcode];
      if (!cmd)
        throw new Error(
          `track ${trackId} unknown opcode 0x${opcode.toString(16)}`,
        );
      const payloadStart = eventPos + 5;
      const payloadEnd = payloadStart + payloadLen;
      if (payloadEnd > end)
        throw new Error(`track ${trackId} event payload exceeds track range`);

      const payloadBytes = bytes.subarray(payloadStart, payloadEnd);
      const args = parseEventPayload(
        cmd,
        payloadBytes,
        view,
        payloadStart,
        sampleById,
      );
      const relBytePos = eventPos - start;
      if (cmd === "MARKER") {
        markerByBytePos.set(relBytePos, args.id);
      }
      if (cmd === "JUMP") {
        jumps.push({ args, relBytePos });
      }
      events.push({ cmd, tick, args });
      tick += delta;
      eventPos = payloadEnd;
    }

    for (const j of jumps) {
      const targetPos = j.relBytePos + j.args.relOffset;
      const markerId = markerByBytePos.get(targetPos);
      if (markerId != null) {
        j.args.to = markerId;
      }
    }

    tracks.push({ id: trackId, channel, events });
  }

  return { ppqn: 48, metadata, tracks };
}

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
    this._tempoSweep = null;
    this._startAudioTime = 0;
    this._audioContext = null;
    this._schedulerTimer = null;
    this._schedulerLookahead = 0.2; // seconds
    this._schedulerInterval = 25; // ms
    this._loop = true; // loop by default
    this._onLine = null; // (line: number) => void — called when an event fires
    this._onParam = null; // (chIndex, target, value) => void — called when a param event plays
    this._pendingUiTimers = new Set(); // timeout ids for delayed UI callbacks

    // Gapless swap (Build during playback): a swap requested by swapAtNextBar()
    // is deferred until the next bar boundary so already-scheduled audio plays
    // out untouched. While a swap is pending, old tracks stop scheduling at
    // _scheduleCapTime; after commit, _dispatchFloor suppresses any new write
    // before the boundary so the new IR starts exactly on the boundary.
    this._pendingSwap = null; // { irObj, boundaryTick, boundaryTime } | null
    this._scheduleCapTime = Infinity; // audio time; old tracks don't schedule past this
    this._dispatchFloor = -Infinity; // audio time; events before this are skipped (not dispatched)

    // Per-channel register state for param application
    this._chRegs = Array.from({ length: 6 }, (_, i) => buildChannelRegState(i));

    // Global YM2612 state
    this._lfoRate = 0; // 0 = off, 1-8 = rate index
    this._masterVol = VOL_UNITY; // 0 = silent, 31 = full (additive TL offset applied to all channels)
    this._reg27 = 0;

    // Track → channel mapping (defaults to index 0 for demo)
    this._trackChannel = new Map(); // trackIndex → chIndex (0-5)

    // PSG channel routing
    this._psgTrackChannel = new Map(); // trackIndex → psgCh (0-3)
    this._psgCurrentMidi = new Array(4).fill(60); // last NOTE_ON midi per PSG ch
    this._psgPitchOffset = new Array(4).fill(0); // cents offset per PSG ch
    this._psgVol = new Array(4).fill(VOL_UNITY); // channel vol 0-31 per PSG ch
    this._psgLastVel = new Array(4).fill(15); // last note vel 0-15 per PSG ch (raw, for composition)
    this._psgVolSweep = new Array(4).fill(null); // active VOL sweep state per PSG ch
    // Whether each PSG ch is currently sounding a note (att < 15). A PSG channel
    // drones whenever its attenuation is non-silent, regardless of frequency, so
    // master/vol recomputes must NOT re-write a non-silent att to an idle channel
    // (that would un-silence it into a tone). Updated on every _psgSetAtt.
    this._psgSounding = new Array(4).fill(false);

    // FM vol sweep state (same approach as PSG: store state, sample at NOTE_ON time)
    this._fmVolSweep = new Array(6).fill(null);

    // Mute / solo state keyed by track index (a track == one sounding channel,
    // e.g. fm3-1, pcm1). Solo overrides mute: when any track is soloed, only
    // soloed tracks sound.
    this._mutedTracks = new Set();
    this._soloTracks = new Set();

    // Channels holding a len=0 note, waiting for triggerKeyOff()
    this._holdChannels = new Set();

    // FM3 independent-operator mode: each fm3-1..fm3-4 track keys a single
    // operator of channel 3 via the shared 0x28 key register. Because the
    // register holds the on/off state of all four operators at once, the
    // per-operator NOTE_ON events must be merged into a combined mask instead
    // of clobbering one another. We record each operator's [on, off) interval
    // and recompute the combined key writes at every affected boundary.
    // Entries: { opBit, on, off } where `off` is null for hold (len=0) notes.
    this._fm3OpIntervals = [];

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
    this._loadIR(await res.json());
    return this;
  }

  async loadMMB(source) {
    let arrayBuffer = source;
    if (typeof source === "string") {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
    }
    this._loadIR(parseMmbBuffer(arrayBuffer));
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
    this._loadIR(irObj);
    return this;
  }

  _resolveInitialTempo(irObj) {
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

  _loadIR(irObj) {
    this._ir = irObj;
    this._ppqn = irObj.ppqn ?? 48;
    this._bpm = this._resolveInitialTempo(irObj);
    this._tempoSweep = null;
    this._eventIndex = 0;
    this._currentTick = 0;
    this._loopCount.clear();
    this._trackChannel.clear();
    this._psgTrackChannel.clear();
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

    if (options.loop !== undefined) this._loop = options.loop;

    this._clearPendingUiTimers();
    this._audioContext = audioContext;
    this._playing = true;
    this._startAudioTime = audioContext.currentTime + 0.05; // small startup offset

    // Initialize all channels with default voices
    this._initDefaultVoices();

    // Reset FM3 operator key-merge state for a fresh run
    this._fm3OpIntervals = [];

    // Build per-track scheduler state
    this._tracks = this._flattenTracks();
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
    this._fm3OpIntervals = [];
    this._tracks = this._flattenTracks();
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
   * Mute or unmute a sounding channel by track index. Muted tracks suppress
   * NOTE_ON key-on writes.
   * @param {number} ti  track index (== track.id == position in ir.tracks)
   * @param {boolean} muted
   */
  muteTrack(ti, muted) {
    if (muted) this._mutedTracks.add(ti);
    else this._mutedTracks.delete(ti);
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
  }

  /** Clear all mute and solo state. */
  clearChannelStates() {
    this._mutedTracks.clear();
    this._soloTracks.clear();
    // No note is sounding on a freshly (re)configured player, so a subsequent
    // master/vol preamble must not re-write a non-silent att to any PSG channel.
    this._psgSounding.fill(false);
  }

  /** Whether a track currently sounds (solo overrides mute). */
  _isTrackAudible(ti) {
    if (this._soloTracks.size > 0) return this._soloTracks.has(ti);
    return !this._mutedTracks.has(ti);
  }

  /**
   * Live mixer fader for a PSG channel. vol 0-31 (31=max, 0=silent). Sets the
   * sticky channel vol and re-applies attenuation immediately.
   * @param {number} psgCh 0-3 (0=sqr1 … 3=noise)
   * @param {number} vol   0-31
   */
  setPsgVol(psgCh, vol) {
    if (psgCh < 0 || psgCh > 3) return;
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
    this._psgSetAtt(psgCh, this._composePsgAtt(vel, v, master), when);
  }

  /**
   * Live mixer fader for a software-mixed PCM channel, keyed by track index.
   * vol 0-31 → linear gain applied in the worklet to current and future voices.
   * @param {number} trackIndex
   * @param {number} vol 0-31
   */
  setPcmTrackVol(trackIndex, vol) {
    if (trackIndex == null) return;
    this._write({
      type: "pcm-set-vol",
      track: trackIndex,
      gain: volToLinearGain(vol),
    });
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
      if (ch === 2 && this._fm3OpIntervals.some((iv) => iv.off == null)) {
        // Release only the held FM3 operators; any timed operators stay keyed.
        this._fm3OpIntervals = this._fm3OpIntervals.filter(
          (iv) => iv.off != null,
        );
        this._write(0, 0x28, (this._fm3MaskAt(when) & 0xf0) | chKey, when);
      } else {
        this._write(0, 0x28, chKey, when);
      }
    }
  }

  /**
   * Set operator key-on mask for a channel.
   * @param {number} ch    0-5
   * @param {number} mask  0xf0 = all on; bit7=op4, bit6=op3, bit5=op2, bit4=op1
   */
  setOpMask(ch, mask) {
    if (!Number.isInteger(ch) || ch < 0 || ch > 5) {
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
    if (!Number.isInteger(ch) || ch < 0 || ch > 5) {
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
    // First bar boundary whose time is safely past the lookahead window, so the
    // outgoing tracks have not queued anything beyond it yet.
    const leadTicks = (this._schedulerLookahead + 0.03) / secsPerTick;
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
      // Resume at the boundary tick (loops fast-forward in _scheduleStep).
      while (
        t.flatIndex < t.events.length &&
        t.events[t.flatIndex].tick < boundaryTick
      ) {
        t.flatIndex++;
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
    // Once the boundary has passed, the post-swap dispatch floor is moot.
    if (this._dispatchFloor !== -Infinity && now >= this._dispatchFloor) {
      this._dispatchFloor = -Infinity;
    }

    this._updateTempoSweep(now);
    const secsPerTick = this._secsPerTick;

    for (const [tIdx, track] of this._tracks.entries()) {
      // Inner guard handles multiple loop-restarts within one lookahead window
      let guard = 0;
      while (guard++ < 16) {
        while (track.flatIndex < track.events.length) {
          const ev = track.events[track.flatIndex];
          const evTime = track.audioTimeAtTick0 + ev.tick * secsPerTick;
          if (evTime > horizon) break;
          // Pending swap: stop the outgoing tracks at the swap boundary so they
          // never emit past it (the incoming IR takes over there).
          if (evTime >= this._scheduleCapTime) break;

          // After a swap commit, _dispatchFloor suppresses the incoming IR's
          // loop catch-up so nothing is written before the boundary; advance
          // past those events without dispatching.
          if (evTime >= this._dispatchFloor) {
            this._dispatchEvent(ev, evTime);
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

    // Playback is complete when no track will loop further and all are exhausted.
    const willLoopAny = this._loop && this._tracks.some((t) => t.hasLoop);
    return (
      !willLoopAny &&
      this._tracks.every((t) => t.flatIndex >= t.events.length)
    );
  }

  /**
   * Render the loaded IR to a flat, time-ordered register-write log without
   * touching real audio. Drives the same scheduling logic as play() but with a
   * manually advanced clock and a capturing write callback, so the result is a
   * deterministic transcript of every YM2612/PSG write — the basis for VGM
   * export.
   *
   * Tracks loop independently (each `(goto …)` returns that track to its own
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

    const saved = {
      write: this._write,
      onLine: this._onLine,
      onParam: this._onParam,
      onSeq: this._onSeq,
      ctx: this._audioContext,
      loop: this._loop,
      playing: this._playing,
      bpm: this._bpm,
      tempoSweep: this._tempoSweep,
    };

    // Silence every UI callback so no real setTimeout fires during capture.
    this._onLine = null;
    this._onParam = null;
    this._onSeq = null;

    this._write = (portOrMsg, addr, data, when) => {
      if (portOrMsg && typeof portOrMsg === "object" && !Array.isArray(portOrMsg)) {
        pcmCount++; // DAC/PCM event — not encoded into VGM yet
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
      this._playing = true;
      this._bpm = this._resolveInitialTempo(this._ir);
      this._tempoSweep = null;

      this._initDefaultVoices(); // preamble register writes (when=undefined → sec 0)

      this._fm3OpIntervals = [];
      this._tracks = this._flattenTracks();
      for (const t of this._tracks) {
        t.audioTimeAtTick0 = BASE;
        t.startAudioTime = BASE;
        t.loopCount = 0;
        t.flatIndex = 0;
      }

      const looping = this._tracks.filter((t) => t.hasLoop);
      this._loop = looping.length > 0;

      // Global loop point = latest per-track loop start (every track is in its
      // body by then). `refTrack` owns that tick, so its live tick→time mapping
      // gives an exact loopStartSec even under a tempo set before the loop.
      // Loop length = LCM of the per-track loop durations.
      let refTrack = null;
      let loopPeriodTicks = 1;
      for (const t of looping) {
        if (refTrack === null || t.loopStartTick > refTrack.loopStartTick) {
          refTrack = t;
        }
        loopPeriodTicks = lcm(loopPeriodTicks, t.loopDuration);
      }

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
          loopStartSec === null &&
          refTrack &&
          refTrack.flatIndex > refTrack.loopStartIndex
        ) {
          const secsPerTick = this._secsPerTick;
          loopStartSec =
            refTrack.audioTimeAtTick0 +
            refTrack.loopStartTick * secsPerTick -
            BASE;
          endSec = loopStartSec + loopPeriodTicks * secsPerTick;
        }

        if (this._loop) {
          // Keep going until we have captured one full loop body past its end.
          if (loopStartSec !== null && now - BASE >= endSec) break;
        } else if (done) {
          break;
        }

        elapsed += stepSec;
      }
    } finally {
      this._write = saved.write;
      this._onLine = saved.onLine;
      this._onParam = saved.onParam;
      this._onSeq = saved.onSeq;
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
      return { writes: kept, pcmCount, loopStartSec, endSec };
    }

    return { writes, pcmCount, loopStartSec, endSec };
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
        chIndex,
        isPsg,
        psgCh,
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
    const newTick0 = audioTimeOfChange - changeTick * newSecsPerTick;

    for (const track of this._tracks) {
      track.audioTimeAtTick0 = newTick0;
      track.startAudioTime = newTick0;
    }
  }

  _startTempoSweep(args, changeTick, changeWhen) {
    const from = Number.isFinite(Number(args?.from))
      ? Number(args.from)
      : this._bpm;
    const to = Number.isFinite(Number(args?.to)) ? Number(args.to) : from;
    const len = Math.max(1, Math.round(Number(args?.len ?? 1)));
    const curve = args?.curve ?? "linear";

    if (!(from > 0) || !(to > 0)) return;

    this._setTempoAtTick(from, changeTick, changeWhen);
    this._tempoSweep = {
      from,
      to,
      len,
      curve,
      params: args?.params,
      startTick: changeTick,
    };
  }

  _updateTempoSweep(now) {
    if (!this._tempoSweep || this._tracks.length === 0) return;

    const t0 = this._tracks[0];
    const currentTick = Math.max(
      0,
      (now - t0.audioTimeAtTick0) / this._secsPerTick,
    );
    const elapsedTicks = currentTick - this._tempoSweep.startTick;
    const phase = Math.max(0, Math.min(1, elapsedTicks / this._tempoSweep.len));
    const unit = sampleCurveUnit(
      this._tempoSweep.curve,
      phase,
      this._tempoSweep.params,
    );
    const nextBpm =
      this._tempoSweep.from +
      (this._tempoSweep.to - this._tempoSweep.from) * unit;

    this._setTempoAtTick(nextBpm, currentTick, now);

    if (phase >= 1) {
      this._setTempoAtTick(this._tempoSweep.to, currentTick, now);
      this._tempoSweep = null;
    }
  }

  _timerAValueFromHz(hz) {
    const safeHz = Math.max(1, Number(hz) || 1);
    // YM2612 Timer A: hz ≈ master_clock / (144 * (1024 - TA)).
    const ta = Math.round(1024 - YM2612_MASTER_CLOCK / (144 * safeHz));
    return Math.max(0, Math.min(1023, ta));
  }

  _writeTimerAValue(ta, when) {
    const hi = (ta >> 2) & 0xff;
    const lo = ta & 0x03;
    this._write(0, 0x24, hi, when);
    this._write(0, 0x25, lo, when);
  }

  _setCsmRateHz(hz, when) {
    this._writeTimerAValue(this._timerAValueFromHz(hz), when);
  }

  _setReg27State({ csmEnabled, fm3SpecialMode }, when) {
    let next = this._reg27;
    if (csmEnabled !== undefined) {
      next = csmEnabled ? next | 0x80 : next & ~0x80;
    }
    if (fm3SpecialMode !== undefined) {
      next = fm3SpecialMode ? next | 0x40 : next & ~0x40;
    }
    if (next === this._reg27) return;
    this._reg27 = next;
    this._write(0, 0x27, this._reg27, when);
  }

  _writeFm3OpPitch(op, midiNote, when) {
    const { fnum, block } = midiToFnumBlock(midiNote);
    const high = ((block & 0x07) << 3) | ((fnum >> 8) & 0x07);
    const low = fnum & 0xff;

    if (op === 4) {
      // OP4 follows the channel-3 base FNUM path.
      this._write(0, 0xa4 + 2, high, when);
      this._write(0, 0xa0 + 2, low, when);
      return;
    }

    if (op >= 1 && op <= 3) {
      // OP1..3 use the FM3 special-mode FNUM registers A8-AA / AC-AE.
      // The register-to-operator order is NOT sequential: on real hardware
      // (and in Nuked-OPN2's fnum_3ch[] decode) OP1 reads A9/AD, OP2 reads
      // AA/AE, and OP3 reads A8/AC. Mapping op -> offset from the A8/AC base:
      //   OP1 -> 1, OP2 -> 2, OP3 -> 0.
      const idx = [1, 2, 0][op - 1];
      this._write(0, 0xac + idx, high, when);
      this._write(0, 0xa8 + idx, low, when);
    }
  }

  /**
   * Combined FM3 operator key mask active at `time` (post-transition), i.e.
   * the OR of every recorded operator interval whose [on, off) range contains
   * `time`. A key-off at exactly `iv.off` is treated as already released.
   */
  _fm3MaskAt(time) {
    let mask = 0;
    for (const iv of this._fm3OpIntervals) {
      if (time >= iv.on && (iv.off == null || time < iv.off)) {
        mask |= iv.opBit;
      }
    }
    return mask;
  }

  /**
   * Schedule a single FM3 operator's key-on/key-off, merging it with any other
   * operators of channel 3 that overlap in time. Adding an operator only
   * changes the combined mask during its own [on, off) span, so we recompute
   * and re-emit the 0x28 register at every boundary inside that span. Because
   * the worklet applies equal-time writes in insertion order (last wins),
   * re-emitting supersedes the stale values written when earlier operators were
   * scheduled, yielding the correct chord at each transition.
   *
   * @param {number} opBit  operator key bit (0x10=OP1 … 0x80=OP4)
   * @param {number} onTime audio time of key-on
   * @param {number|null} offTime audio time of key-off, or null for a hold note
   */
  _scheduleFm3OpKey(opBit, onTime, offTime) {
    const chKey = (0 << 2) | 2; // channel 3: port 0, channel offset 2

    // Drop intervals that have fully elapsed so the list stays bounded across
    // loops (keep a small margin so in-flight writes are not disturbed).
    const now = this._audioContext?.currentTime ?? 0;
    if (this._fm3OpIntervals.length > 0) {
      this._fm3OpIntervals = this._fm3OpIntervals.filter(
        (iv) => iv.off == null || iv.off >= now - 1,
      );
    }

    this._fm3OpIntervals.push({ opBit, on: onTime, off: offTime });

    // Collect every boundary affected by this note: its own endpoints plus any
    // other operator transition that falls within this note's active span.
    const within = (t) =>
      t > onTime && (offTime == null || t < offTime);
    const boundaries = new Set([onTime]);
    if (offTime != null) boundaries.add(offTime);
    for (const iv of this._fm3OpIntervals) {
      if (within(iv.on)) boundaries.add(iv.on);
      if (iv.off != null && within(iv.off)) boundaries.add(iv.off);
    }

    for (const t of boundaries) {
      this._write(0, 0x28, this._fm3MaskAt(t) | chKey, t);
    }
  }

  _applyCsmRate(ev, when) {
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
    for (let frame = 0; frame < frames; frame++) {
      const phase = frames <= 1 ? 1 : frame / (frames - 1);
      const unit = sampleCurveUnit(curve, phase, ev.args?.params);
      const hzAt = from + (to - from) * unit;
      this._setCsmRateHz(hzAt, when + frame / 60);
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

    // Returns { events, extra } where `extra` is how much longer the expanded
    // list is than the compressed input (the accumulated loop-expansion shift).
    // `extra` is what lets an OUTER loop offset its repetitions by the inner
    // body's *expanded* duration — without it, nested loops overlap.
    function expand(evList, depth) {
      if (depth > 8) return { events: [], extra: 0 }; // safety guard
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

          // Expand once; the EXPANDED body may be longer than bodyDuration when
          // it contains its own loops, so reps must advance by repDur, not by the
          // compressed bodyDuration (otherwise repetitions overlap → desync).
          const full = expand(loopBody, depth + 1);
          const repDur = bodyDuration + full.extra;
          const final =
            finalBreak != null
              ? expand(loopBody.slice(0, finalBreak.index), depth + 1)
              : full;
          const finalRepDur = finalBodyDuration + final.extra;

          for (let rep = 0; rep < count; rep++) {
            const body = rep === count - 1 ? final.events : full.events;
            for (const bodyEv of body) {
              out.push({
                ...bodyEv,
                tick: bodyEv.tick + tickOffset + rep * repDur,
              });
            }
          }

          // Shift following events by the loop's full expanded duration.
          const totalLoopDuration =
            count > 0 ? (count - 1) * repDur + finalRepDur : 0;
          tickOffset += totalLoopDuration - bodyDuration;
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
      return { events: out, extra: tickOffset };
    }

    return expand(events, 0).events;
  }

  _dispatchEvent(ev, when) {
    if (this._dispatchGlobalEvent(ev, when)) return;

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
        const fm3Op = Number(ev.args?.fm3Op);
        const isFm3OpNote =
          ch === 2 && Number.isInteger(fm3Op) && fm3Op >= 1 && fm3Op <= 4;
        const centOffset = this._chRegs[ch]?.pitchOffset ?? 0;
        const { fnum, block } = midiToFnumBlock(midi + centOffset / 100);
        const chKey = (port << 2) | chOffset; // 0x28 channel key
        const baseLengthTicks = ev.args?.length ?? this._ppqn / 2;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const gateTicks = this._resolveGateTicks(ev.args?.gate, lengthTicks);
        // Monophonic priority: macro tails (echo/retrigger/curve) are cut a
        // key-off lead before the next note on this channel, so they cannot
        // bleed onto it and the next note keeps its normal lead-in.
        const nextNote = this._nextNoteSecs(ev);
        const macroLimit = Number.isFinite(nextNote)
          ? nextNote - KEY_OFF_LEAD_SECS
          : Infinity;
        const regs = this._chRegs[ch];
        regs.currentMidi = midi;

        // Apply per-note velocity (and any vol/master) to carrier TL,
        // attenuating from each operator's voiced TL. Runs on every normal note
        // so static :vel works and a previously attenuated note is reset; vel 15
        // / vol 31 / master 31 restores the voiced level. FM3-op notes keep the
        // vol-gated path so the per-operator special mode is undisturbed.
        const hasVol = regs?.vol != null || this._fmVolSweep[ch] != null;
        if (hasVol || !isFm3OpNote) {
          const currentVol = hasVol ? this._fmVolAtTime(ch, when) : (regs.vol ?? VOL_UNITY);
          const noteVel = ev.args?.vel ?? 15;
          regs.vel = noteVel; // track sticky vel for later VOL/MASTER recalcs
          const master = this._masterVol ?? VOL_UNITY;
          const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
          for (const opIdx of carriers) {
            const tl = this._carrierTl(
              regs.ops[opIdx],
              noteVel,
              currentVol,
              master,
            );
            regs.ops[opIdx].tl = tl;
            const opAddr = 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset;
            this._write(port, opAddr, tl, when);
          }
        }

        // FM3 OP1..3 notes use dedicated A8/AC registers via FM3_OP_PITCH events.
        const writesBasePitch = !isFm3OpNote || fm3Op === 4;
        if (writesBasePitch) {
          // Write F-number high first (block + MSB), then low
          this._write(
            port,
            0xa4 + chOffset,
            ((block & 0x07) << 3) | ((fnum >> 8) & 0x07),
            when,
          );
          this._write(port, 0xa0 + chOffset, fnum & 0xff, when);
          const basePitchWrite = (centOffset, t) => {
            const { fnum, block } = midiToFnumBlock(midi + centOffset / 100);
            this._write(
              port,
              0xa4 + chOffset,
              ((block & 0x07) << 3) | ((fnum >> 8) & 0x07),
              t,
            );
            this._write(port, 0xa0 + chOffset, fnum & 0xff, t);
          };
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            gateTicks,
            basePitchWrite,
            macroLimit,
          );
          this._scheduleSemiMacro(
            ev.args?.note_semi,
            when,
            gateTicks,
            basePitchWrite,
            macroLimit,
          );
        } else {
          // FM3 OP1..3 notes use dedicated pitch registers; apply runtime pitch offset
          // and NOTE_PITCH macro updates through FM3 OP pitch writes.
          if (centOffset !== 0) {
            this._writeFm3OpPitch(fm3Op, midi + centOffset / 100, when);
          }
          const fm3PitchWrite = (noteCentOffset, t) => {
            this._writeFm3OpPitch(fm3Op, midi + noteCentOffset / 100, t);
          };
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            gateTicks,
            fm3PitchWrite,
            macroLimit,
          );
          this._scheduleSemiMacro(
            ev.args?.note_semi,
            when,
            gateTicks,
            fm3PitchWrite,
            macroLimit,
          );
        }
        this._scheduleFmVelMacro(
          ch,
          port,
          chOffset,
          ev.args?.velMacro,
          when,
          gateTicks,
          macroLimit,
        );
        this._scheduleFmOpMacros(
          ch,
          port,
          chOffset,
          ev.args ?? {},
          when,
          gateTicks,
          macroLimit,
        );
        // Key on: all 4 operators (unless muted or vol=0).
        // YM2612: TL=127 gives totalAttn=1016 < 1023 (not silent at sustain),
        // so when a volume control is 0 we skip key-on entirely to guarantee
        // silence. vol and master are "volume": 0 mutes. (vel never mutes — it
        // floors at its lowest ladder step.)
        const isFmSilent =
          ((regs?.vol != null || this._fmVolSweep[ch] != null) &&
            this._fmVolAtTime(ch, when) === 0) ||
          (this._masterVol ?? VOL_UNITY) === 0;
        const secsPerTick = this._secsPerTick;
        const offWhen =
          gateTicks > 0
            ? Math.max(
                when + 0.001,
                when + gateTicks * secsPerTick - KEY_OFF_LEAD_SECS,
              )
            : null;
        let keyonEnd = null;
        if (this._isTrackAudible(ev._trackIndex) && !isFmSilent) {
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
          if (isFm3OpNote) {
            // Merge this operator's key with the other FM3 operators sharing
            // channel 3's 0x28 register instead of overwriting them.
            this._scheduleFm3OpKey(keyMask & 0xf0, when, offWhen);
          } else {
            const keyOnByte = keyMask | chKey;
            this._write(0, 0x28, keyOnByte, when);
            // :keyon retrigger gate (drum roll / echo tail). FM3-op notes share
            // the 0x28 register so retrigger there is deferred. When active, the
            // keyon macro owns the channel's keying: its end time becomes the
            // final key-off (the note's own gate key-off is suppressed below so
            // it can't cancel the first retrigger that lands on the boundary).
            keyonEnd = this._scheduleKeyonMacro(
              ev.args?.keyon,
              keyMask,
              chKey,
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
            // (keyonEnd) instead of at the gate, so the final tap isn't cut and
            // the boundary collision is avoided. Otherwise key off at the gate.
            // keyonEnd is clamped to <= macroLimit (= next note - lead), so it
            // is always before the next note's key-on — no collision.
            this._write(0, 0x28, chKey, keyonEnd != null ? keyonEnd : offWhen);
          }
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
        const opMode = (ev.args?.mode ?? "") === "op";
        this._setReg27State({ fm3SpecialMode: opMode }, when);
        if (opMode) {
          // In CH3 special mode each operator takes its frequency from its own
          // F-number register. A score may drive only a subset of operators
          // (e.g. only fm3-1), leaving the others at F-number 0. Those operators
          // are never keyed, so they stay silent regardless — but we seed all
          // four with a valid pitch as defensive insurance so no operator is
          // left at an undefined frequency. Each fm3-N track's own FM3_OP_PITCH
          // (emitted after this event) overrides its operator's seed.
          for (let op = 1; op <= 4; op++) {
            this._writeFm3OpPitch(op, 60, when);
          }
        }
        break;
      }

      case "FM3_OP_PITCH": {
        const op = Number(ev.args?.op);
        if (!Number.isInteger(op) || op < 1 || op > 4) break;
        const midi = pitchToMidi(ev.args?.pitch ?? "c4");
        this._writeFm3OpPitch(op, midi, when);
        break;
      }

      case "PCM_NOTE_ON": {
        this._dispatchPcmNoteOn(ev, when);
        break;
      }

      case "PCM_NOTE_OFF": {
        this._dispatchPcmNoteOff(ev, when);
        break;
      }
    }
  }

  _dispatchPcmNoteOn(ev, when) {
    const sample = String(ev.args?.sample ?? "").trim();
    if (!sample) return;
    const rate = Number(ev.args?.rate);
    const baseRate = Number(ev.args?.baseRate);
    const vel = Number(ev.args?.vel ?? 15);
    const mode = ev.args?.mode === "loop" ? "loop" : "shot";
    this._write({
      type: "pcm-note-on",
      when,
      ch: ev._chIndex ?? null,
      track: ev._trackIndex ?? null,
      sample,
      rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
      baseRate: Number.isFinite(baseRate) && baseRate > 0 ? baseRate : null,
      vel: Number.isFinite(vel) ? vel : 15,
      mode,
    });
  }

  _dispatchPcmNoteOff(ev, when) {
    const sample = String(ev.args?.sample ?? "").trim();
    if (!sample) return;
    const mode = ev.args?.mode === "loop" ? "loop" : "shot";
    this._write({
      type: "pcm-note-off",
      when,
      ch: ev._chIndex ?? null,
      sample,
      mode,
    });
  }

  _dispatchGlobalEvent(ev, when) {
    switch (ev.cmd) {
      case "TEMPO_SET": {
        const bpm = Number(ev.args?.bpm);
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

      case "MARKER":
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

  _applyParam(ch, port, chOffset, ev, when) {
    const regs = this._chRegs[ch];
    const target = (ev.args?.target ?? "").toUpperCase();
    const value = ev.args?.value ?? 0;
    let nextValue = null;

    // Helper to round, clamp and apply. All hardware register targets are integers;
    // rounding here means curves routed through _applyParam never store floats.
    const set = (apply, min, max) => {
      const next = Math.max(min, Math.min(max, Math.round(value)));
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
            // Voiced (timbre) TL — the base level vel/vol/master attenuate from.
            regs.ops[opIdx].voicedTl = v;
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
        const pan = this._snapMacroOutput("PAN", value);
        regs.pan = pan;
        nextValue = pan;
        this._write(port, 0xb4 + chOffset, encodeB4(regs), when);
        break;
      }
      case "LFO_RATE": {
        const rate = Math.max(0, Math.min(8, Math.round(value)));
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
        const master = this._masterVol ?? VOL_UNITY;
        const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
        for (const opIdx of carriers) {
          const tl = this._carrierTl(regs.ops[opIdx], vel, vol, master);
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
          const cp = ci >= 3 ? 1 : 0;
          const co = ci % 3;
          const crs = fmCarrierOpsForAlg(cr.algorithm ?? 0);
          for (const opIdx of crs) {
            const tl = this._carrierTl(
              cr.ops[opIdx],
              cr.vel ?? 15,
              cr.vol ?? VOL_UNITY,
              master,
            );
            cr.ops[opIdx].tl = tl;
            this._write(cp, 0x40 + OP_ADDR_OFFSET[opIdx] + co, tl, when);
          }
        }
        // PSG channels: recalculate attenuation from vel * vol * master, but only
        // for channels currently sounding — re-writing a non-silent att to an idle
        // channel (e.g. at play start, before any note) would drone a tone.
        for (let psgCh = 0; psgCh < 4; psgCh++) {
          if (!this._psgSounding[psgCh]) continue;
          const velLevel = this._psgLastVel[psgCh] ?? 15; // 0-15, raw vel
          const vol = this._psgVolAtTime(psgCh, when); // 0-31
          this._psgSetAtt(psgCh, this._composePsgAtt(velLevel, vol, master), when);
        }
        nextValue = master;
        break;
      }

      case "NOISE_MODE": {
        // Noise mode (PSG noise control) — bits 5-3 (FB + NF)
        // Values 0-7 directly map to SN76489 noise register bits 5-3
        const mode = this._snapMacroOutput("NOISE_MODE", value);
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

  // Audio time of the next NOTE_ON on this event's track (the same channel), or
  // Infinity if none remain. Used as the monophonic-priority cutoff so a note's
  // macro tail (echo/retrigger) cannot bleed past the following note.
  _nextNoteSecs(ev) {
    const track = ev._trackIndex != null ? this._tracks[ev._trackIndex] : null;
    if (!track) return Infinity;
    const secsPerTick = this._secsPerTick;
    for (let i = track.flatIndex + 1; i < track.events.length; i++) {
      const ne = track.events[i];
      if (ne.cmd === "NOTE_ON") {
        return track.audioTimeAtTick0 + ne.tick * secsPerTick;
      }
    }
    // No more notes this iteration: if the track loops, the next note is the
    // first note of the next iteration (same time base as the loop restart at
    // _scheduleLoop), so the last note's tail is clipped at the loop seam.
    if (this._loop && track.hasLoop && track.loopDuration) {
      for (let i = track.loopStartIndex ?? 0; i < track.events.length; i++) {
        const ne = track.events[i];
        if (ne.cmd === "NOTE_ON") {
          return (
            track.audioTimeAtTick0 +
            (track.loopDuration + ne.tick) * secsPerTick
          );
        }
      }
    }
    return Infinity;
  }

  // Effective carrier TL = voiced (timbre) TL + velocity ladder + vol/master
  // attenuation, all as dB-domain offsets (preserving the patch's base level
  // and per-carrier balance).
  //
  // vel is musical velocity: a ~2 dB/step logarithmic ladder matching the
  // PMD / MDSDRV coarse volume convention. vel 15 = no attenuation (patch
  // level), vel 0 = a ~-30 dB floor — it never mutes. True silence is a rest,
  // or vol/master 0 (handled as a hard mute at key-on time).
  _carrierTl(op, vel, vol, master) {
    // Sum the signed dB offsets (float) on top of the voiced TL, then quantize
    // once. vel attenuates (floors, never mutes); vol/master are bipolar
    // (boost = negative offset, clamped at TL 0). Uniform across carriers, so
    // the patch's per-carrier balance is preserved.
    const offset =
      velToTlAtten(vel) + volToTlOffset(vol) + volToTlOffset(master);
    return Math.max(0, Math.min(127, Math.round((op.voicedTl ?? 0) + offset)));
  }

  // Snap curve/function outputs to discrete hardware lanes when needed.
  _snapMacroOutput(target, value) {
    const t = String(target || "").toUpperCase();
    if (t === "PAN") {
      // Tri-state pan lane: left(-1) / center(0) / right(+1)
      return Math.max(-1, Math.min(1, Math.round(Number(value) || 0)));
    }
    if (t === "NOISE_MODE") {
      // SN76489 mode is a 3-bit integer (0..7)
      return Math.max(0, Math.min(7, Math.round(Number(value) || 0)));
    }
    return value;
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
      if (
        nextEv.cmd === "PARAM_SET" ||
        nextEv.cmd === "PARAM_SWEEP" ||
        nextEv.cmd === "PARAM_SWEEP_STOP"
      ) {
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

  // Resolve a NOTE_ON `step` spec ({ unit, value }) to seconds per step.
  // Absent → 1/60 s (the pre-:step 60 Hz rate).
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
    const endTime = this._scheduleMacroImpl(
      spec,
      noteFrames,
      gateSecs,
      when,
      writeFn,
      stepSecs,
      limitSecs,
    );
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

    // :step is the macro sampling clock. Curve/stage macros sample (and hold)
    // every stepFrames; default 1f = 1 frame = 60 Hz (smooth, unchanged). A
    // coarser :step gives a stepped / sample-and-hold curve.
    const stepFrames = Math.max(1, Math.round(stepSecs * 60));

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
        if (stage.waitTicks != null) {
          t += Math.max(0, Number(stage.waitTicks)) * this._secsPerTick;
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
          params,
        } = stage;
        // :len is a length token (ticks); convert to 60 Hz frames like sweeps.
        const baseFrames = Math.max(
          1,
          Math.round(Number(rawFrames) * this._secsPerTick * 60),
        );
        // For looping stages, run until gate (or next key-off boundary)
        const budget = loop
          ? Math.max(0, Math.floor((gateSecs - t) * 60))
          : baseFrames;
        for (let frame = 0; frame < budget; frame += stepFrames) {
          const phase = loop
            ? (frame % baseFrames) / baseFrames
            : baseFrames <= 1
              ? 1
              : Math.min(1, frame / (baseFrames - 1));
          writeFn(
            from + (to - from) * sampleCurveUnit(curve, phase, params),
            t + frame / 60,
          );
        }
        t += budget / 60;
      }
      return Math.min(t, limitSecs);
    }

    if (spec.type === "curve") {
      const {
        from,
        to,
        frames: rawFrames = 1,
        loop,
        curve = "linear",
        params,
        waitTicks = null,
        waitKeyOff = false,
      } = spec;
      // :len is a length token (ticks); convert to 60 Hz frames like sweeps.
      const baseFrames = Math.max(
        1,
        Math.round(Number(rawFrames) * this._secsPerTick * 60),
      );
      const waitFrameOffset = waitKeyOff
        ? Math.max(0, Math.round((gateSecs - when) * 60))
        : Math.max(
            0,
            Math.round(Number(waitTicks ?? 0) * this._secsPerTick * 60),
          );
      const startWhen = waitKeyOff
        ? Math.max(when, gateSecs)
        : when + waitFrameOffset / 60;
      const remainingFrames = Math.max(0, noteFrames - waitFrameOffset);
      const activeFrames = waitKeyOff
        ? baseFrames
        : loop
          ? remainingFrames
          : Math.min(remainingFrames, baseFrames);
      for (let frame = 0; frame < activeFrames; frame += stepFrames) {
        const phase = loop
          ? (frame % baseFrames) / baseFrames
          : baseFrames <= 1
            ? 1
            : Math.min(1, frame / (baseFrames - 1));
        writeFn(
          from + (to - from) * sampleCurveUnit(curve, phase, params),
          startWhen + frame / 60,
        );
      }
      return Math.min(startWhen + activeFrames / 60, limitSecs);
    }

    if (spec.type === "steps") {
      const { steps, loopIndex, releaseIndex } = spec;
      if (!steps || steps.length === 0) return null;

      const sustainEnd = releaseIndex ?? steps.length;

      // Attack + sustain loop until gate, advancing one step per :step interval.
      // An empty sustain section (`[:off ...]`, releaseIndex 0) writes nothing
      // before key-off — the target keeps its current value until the release.
      let t = when;
      let idx = 0;
      while (sustainEnd > 0 && t < gateSecs) {
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
        t += stepSecs;
      }

      // Release phase after gate (steps after :off), spaced by :step too
      if (releaseIndex !== null && releaseIndex < steps.length) {
        t = gateSecs;
        for (let ri = releaseIndex; ri < steps.length; ri++) {
          if (steps[ri] !== null && steps[ri] !== undefined)
            writeFn(steps[ri], t);
          t += stepSecs;
        }
        return Math.min(t, limitSecs); // time after last release write
      }
      return Math.min(gateSecs, limitSecs); // time at gate-off
    }

    return null;
  }

  // Schedule PAN and FM operator param macros embedded in NOTE_ON args.
  // Keys: pan → PAN, fm_tl1 → FM_TL1, etc. (snake_case from makeNoteArgs)
  _scheduleFmOpMacros(
    ch,
    port,
    chOffset,
    noteArgs,
    when,
    gateTicks,
    limitSecs = Infinity,
  ) {
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
      this._scheduleMacro(
        spec,
        noteFrames,
        gateSecs,
        when,
        (v, when) => {
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
        },
        this._stepSecs(spec.step),
        limitSecs,
      );
    }
  }

  _scheduleFmVelMacro(
    ch,
    port,
    chOffset,
    velMacro,
    when,
    gateTicks,
    limitSecs = Infinity,
  ) {
    if (!velMacro) return;

    const regs = this._chRegs[ch];
    const baseVol = regs.vol ?? VOL_UNITY;
    const carriers = fmCarrierOpsForAlg(regs.algorithm ?? 0);
    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    // vel 15 = patch level, vel 0 = -30 dB floor. Float vel → finer TL than 16
    // steps (rounded once inside _carrierTl).
    const master = this._masterVol ?? VOL_UNITY;
    this._scheduleMacro(
      velMacro,
      noteFrames,
      gateSecs,
      when,
      (v, t) => {
        const vel = clampForTarget("VEL", v);
        for (const opIdx of carriers) {
          const tl = this._carrierTl(regs.ops[opIdx], vel, baseVol, master);
          regs.ops[opIdx].tl = tl;
          this._write(port, 0x40 + OP_ADDR_OFFSET[opIdx] + chOffset, tl, t);
        }
      },
      this._stepSecs(velMacro.step),
      limitSecs,
    );
  }

  // Schedule a pitch macro for any channel (FM or PSG).
  // writeFn(centOffset, t) performs the hardware write for the channel.
  _schedulePitchMacro(pitchMacro, when, gateTicks, writeFn, limitSecs = Infinity) {
    if (!pitchMacro) return;

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(
      pitchMacro,
      noteFrames,
      gateSecs,
      when,
      writeFn,
      this._stepSecs(pitchMacro.step),
      limitSecs,
    );
  }

  // Schedule a :semi macro (discrete semitone offsets) on the pitch write path.
  // Reuses the pitch writeFn; semitone values are ×100 to cents.
  _scheduleSemiMacro(semiMacro, when, gateTicks, writeFn, limitSecs = Infinity) {
    if (!semiMacro) return;

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      when,
      gateTicks,
    );
    this._scheduleMacro(
      semiMacro,
      noteFrames,
      gateSecs,
      when,
      (semi, t) => writeFn(semi * 100, t),
      this._stepSecs(semiMacro.step),
      limitSecs,
    );
  }

  // Schedule a :keyon retrigger gate. Sampled per :step; a value >= 0.5 fires a
  // key-off→key-on (restarting the envelope). The t=0 sample coincides with the
  // note's own NOTE_ON and is a no-op. keyMask/chKey target the 0x28 register.
  // Returns the audio time after the last step (used to place the final
  // key-off), or null if there was no keyon macro.
  _scheduleKeyonMacro(
    keyonSpec,
    keyMask,
    chKey,
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
    const keyOnByte = (keyMask & 0xf0) | chKey;
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
        this._write(0, 0x28, chKey, Math.max(when, t - gap)); // key off
        this._write(0, 0x28, keyOnByte, t); // key on
      },
      stepSecs,
      limitSecs,
    );
  }

  _applyParamSweep(ch, port, chOffset, ev, when) {
    const target = (ev.args?.target ?? "").toUpperCase();
    const from = Number(ev.args?.from ?? 0);
    const to = Number(ev.args?.to ?? 0);
    const curve = ev.args?.curve ?? "linear";
    const params = ev.args?.params;
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
          from + (to - from) * sampleCurveUnit(curve, phase, params),
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
          Math.min(
            31,
            from + (to - from) * sampleCurveUnit(curve, phase, params),
          ),
        );
        const vel = regs.vel ?? 15;
        const master = this._masterVol ?? VOL_UNITY;
        const frameWhen = when + i / 60;
        for (const opIdx of carriers) {
          const tl = this._carrierTl(regs.ops[opIdx], vel, vol, master);
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
        params,
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
        from + (to - from) * sampleCurveUnit(curve, phase, params),
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
    const att = attReg & 0x0f;
    // Track sounding state so master/vol recomputes don't un-silence idle channels.
    this._psgSounding[psgCh] = att < 15;
    // Latch byte: 1 | ch(2) | r=1(att) | att(4)
    const byte = 0x80 | ((psgCh & 0x03) << 5) | 0x10 | att;
    this._psgWriteByte(byte, when);
  }

  // Compose vel (0-15) / vol / master (0-31) into a PSG attenuation (0=loud,
  // 15=silent) via the same additive dB-offset model as FM, quantized once to
  // the 16-step attenuator. vol or master 0 is a hard mute.
  _composePsgAtt(vel, vol, master) {
    if (vol <= 0 || master <= 0) return 15;
    const att =
      velToPsgAtten(vel) + volToPsgOffset(vol) + volToPsgOffset(master);
    return Math.max(0, Math.min(15, Math.round(att)));
  }

  // Returns the current VOL (0-31) for a PSG channel at the given audio time,
  // sampling an active VOL sweep if present.
  _fmVolAtTime(ch, when) {
    const sweep = this._fmVolSweep?.[ch];
    return sweep ? sweepVolAtTime(sweep, when) : (this._chRegs[ch].vol ?? VOL_UNITY);
  }

  _psgVolAtTime(psgCh, when) {
    const sweep = this._psgVolSweep?.[psgCh];
    return sweep ? sweepVolAtTime(sweep, when) : (this._psgVol[psgCh] ?? VOL_UNITY);
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

    // Compose vel / vol / master → PSG attenuation (additive dB model).
    const vol = this._psgVolAtTime(psgCh, noteWhen);
    const master = this._masterVol ?? VOL_UNITY;
    const att = this._composePsgAtt(baseVel, vol, master);

    this._psgSetAtt(psgCh, att, noteWhen);
    if (!isHold) this._psgSetAtt(psgCh, 15, noteOffWhen);
  }

  _schedulePsgVelMacro(
    psgCh,
    velMacro,
    noteWhen,
    gateTicks,
    baseVel = 15,
    limitSecs = Infinity,
  ) {
    if (!velMacro) return;
    this._psgLastVel[psgCh] = Math.max(0, Math.min(15, baseVel));

    const { noteFrames, gateSecs } = this._resolveNoteFramesAndGate(
      noteWhen,
      gateTicks,
    );

    // vel macro scales the note's base vel (float), then → PSG att.
    const vol = this._psgVolAtTime(psgCh, noteWhen);
    const master = this._masterVol ?? VOL_UNITY;
    const velToAtt = (v) => {
      const velLevel = (clampForTarget("VEL", v) * baseVel) / 15;
      return this._composePsgAtt(velLevel, vol, master);
    };

    const silenceAt = this._scheduleMacro(
      velMacro,
      noteFrames,
      gateSecs,
      noteWhen,
      (v, t) => this._psgSetAtt(psgCh, velToAtt(v), t),
      this._stepSecs(velMacro.step),
      limitSecs,
    );
    // On hold notes (gateTicks === 0), silence is triggered by triggerKeyOff().
    // silenceAt is clamped to <= limitSecs (= next note - lead), so it is before
    // the next note — write it directly.
    if (silenceAt !== null && gateTicks !== 0) {
      this._psgSetAtt(psgCh, 15, silenceAt);
    }
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
        if (!this._isTrackAudible(ev._trackIndex)) break;

        const isNoise = psgCh === 3;
        const baseLengthTicks = ev.args?.length ?? this._ppqn / 2;
        const lengthTicks = this._resolveTiedLength(ev, baseLengthTicks);
        const psgGateTicks = this._resolveGateTicks(ev.args?.gate, lengthTicks);
        // Monophonic priority: cut this note's macro tail a key-off lead before
        // the next note on this channel.
        const psgNextNote = this._nextNoteSecs(ev);
        const psgMacroLimit = Number.isFinite(psgNextNote)
          ? psgNextNote - KEY_OFF_LEAD_SECS
          : Infinity;
        if (!isNoise) {
          const midi = pitchToMidi(ev.args?.pitch ?? "c4");
          this._psgCurrentMidi[psgCh] = midi;
          const psgCentOffset = this._psgPitchOffset[psgCh] ?? 0;
          this._psgSetPitch(psgCh, midi + psgCentOffset / 100, when);
          const psgPitchWrite = (centOffset, t) =>
            this._psgSetPitch(psgCh, midi + centOffset / 100, t);
          this._schedulePitchMacro(
            ev.args?.pitchMacro,
            when,
            psgGateTicks,
            psgPitchWrite,
            psgMacroLimit,
          );
          this._scheduleSemiMacro(
            ev.args?.note_semi,
            when,
            psgGateTicks,
            psgPitchWrite,
            psgMacroLimit,
          );
        } else {
          this._psgTriggerNoise(when);
          this._schedulePsgModeMacro(
            psgCh,
            ev.args?.noise_mode,
            when,
            psgGateTicks,
            psgMacroLimit,
          );
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
            psgMacroLimit,
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
            // Immediate vol: store, and update hardware only if the channel is
            // currently sounding (otherwise it takes effect at the next NOTE_ON;
            // writing att to an idle channel would drone a tone).
            const vol = Math.max(0, Math.min(31, ev.args?.value ?? VOL_UNITY));
            this._psgVol[psgCh] = vol;
            this._psgVolSweep[psgCh] = null;
            if (this._psgSounding[psgCh]) {
              const velLevel = this._psgLastVel[psgCh] ?? 15;
              const master = this._masterVol ?? VOL_UNITY;
              this._psgSetAtt(
                psgCh,
                this._composePsgAtt(velLevel, vol, master),
                when,
              );
            }
          } else {
            // PARAM_SWEEP: store sweep state (same format as _fmVolSweep).
            // Hardware writes happen lazily at each NOTE_ON via _psgVolAtTime().
            const from = Math.max(0, Math.min(31, Number(ev.args?.from ?? VOL_UNITY)));
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
              from +
              (to - from) * sampleCurveUnit(curve, phase, ev.args?.params);
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
    // No PSG note is sounding at the start of a run; clear the flags so the
    // master/vol preamble writes don't drone idle channels.
    this._psgSounding.fill(false);
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
