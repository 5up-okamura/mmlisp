// ---------------------------------------------------------------------------
// MMLispDRV reference player — MMB v0.2 decoder + Z80-constrained scheduler.
//
// This is the executable form of docs/driver.md: it consumes the MMB binary
// (docs/mmb.md, docs/opcodes.md) exactly as the Z80 driver will — 60 Hz
// frame-stepped, per-track 8.8 fixed-point tick accumulators, shadow register
// file with change-only writes — and emits YM2612/PSG register writes through
// the same write callback IRPlayer uses, so the two players can be A/B-diffed
// register-for-register (ab-compare.js) and the asm port can later be traced
// against the same logs.
//
// Z80 constraints, operationally:
// - Integer-only runtime. All float math happens once, in LUT construction
//   (buildLuts): note→F-number/block, note→PSG period, vel/vol→TL and PSG
//   attenuation offset tables. The tables are exported (getLuts) so the asm
//   port copies them verbatim.
// - One stepFrame() per vblank: mailbox → per-track dispatch → write flush.
//   The frame order is the normative main-loop order of driver.md §4.
// - M1 opcode coverage (opcodes.md §3): NOTE_ON(+EX gate), REST, TIE,
//   LOOP_BEGIN/END(+BREAK), MARKER, JUMP, PARAM_SET (all targets), TEMPO_SET,
//   END_OF_TRACK. Reserved opcodes are length-decoded and skipped with a
//   diagnostic (PCM_NOTE_ON still advances the clock so timelines stay
//   aligned).
//
// Gate rule (opcodes.md §3.1 + language.md §5 legato): key-off fires at
// dur×gate/8 ticks. With gate = 8 the key-off at dur expiry is *pending*: it
// is cancelled if the next timed event on the track is a NOTE_ON (slur) or a
// TIE (extension), and fires before a REST or END_OF_TRACK.
// ---------------------------------------------------------------------------

import {
  MAGIC,
  VERSION_MAJOR,
  VERSION_MINOR,
  SECTION_ID,
  TRACK_FLAG,
  OPCODE,
  OPCODE_NAME,
  TARGET_ID,
  TARGET_NAME,
  targetWidth,
  readDuration,
  bpmToTickIncrement,
  curveUnit8,
  sweepValue,
  sweepStep,
} from "./mmb.js";
import {
  midiToFnumBlock,
  velToTlAtten,
  volToTlOffset,
  velToPsgAtten,
  volToPsgOffset,
  VOL_UNITY,
  OP_ADDR_OFFSET,
  encodeB0,
  encodeB4,
  encode60,
  encode30,
  encode80,
  fmCarrierOpsForAlg,
  PSG_MASTER_CLOCK,
} from "./ir-utils.js";

const FRAMES_PER_SEC = 60;
const LOOP_STACK_DEPTH = 4; // driver.md §5.2

// ── LUT construction (float math lives here and only here) ────────────────
function buildLuts() {
  // note → (block << 11) | fnum, u16. The asm ships the A-rooted 12-entry
  // form (driver.md §8); the reference carries the expanded 128-entry table
  // generated from the same midiToFnumBlock math so they cannot disagree.
  const fnumBlock = new Uint16Array(128);
  for (let n = 0; n < 128; n++) {
    const { fnum, block } = midiToFnumBlock(n);
    fnumBlock[n] = ((block & 0x07) << 11) | (fnum & 0x7ff);
  }
  // note → SN76489 tone period (10 bit), u16.
  const psgPeriod = new Uint16Array(128);
  for (let n = 0; n < 128; n++) {
    const freq = 440 * Math.pow(2, (n - 69) / 12);
    psgPeriod[n] = Math.max(
      1,
      Math.min(1023, Math.round(PSG_MASTER_CLOCK / (32 * freq))),
    );
  }
  // Level offset tables (driver.md §7). Stored as float-exact step offsets;
  // composition sums them and rounds once (integer end result), matching the
  // player's float-sum-then-quantize within the documented ±2 TL band.
  // To keep the runtime integer-only the offsets are stored in 1/4 steps.
  const velTl4 = new Int16Array(16);
  for (let v = 0; v < 16; v++) velTl4[v] = Math.round(velToTlAtten(v) * 4);
  const volTl4 = new Int16Array(32);
  for (let v = 0; v < 32; v++) volTl4[v] = Math.round(volToTlOffset(v) * 4);
  const velPsg4 = new Int16Array(16);
  for (let v = 0; v < 16; v++) velPsg4[v] = Math.round(velToPsgAtten(v) * 4);
  const volPsg4 = new Int16Array(32);
  for (let v = 0; v < 32; v++) volPsg4[v] = Math.round(volToPsgOffset(v) * 4);
  return { fnumBlock, psgPeriod, velTl4, volTl4, velPsg4, volPsg4 };
}

// Little-endian readers over a Uint8Array.
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i8 = (v) => (v & 0x80 ? v - 0x100 : v);
const i16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

// Fresh per-FM-channel shadow state (voiced values; mirrors driver.md §5.1).
function freshFmChannel() {
  return {
    algorithm: 7,
    feedback: 0,
    ams: 0,
    fms: 0,
    pan: 0, // -1/0/+1; B4 defaults to both speakers
    vel: 15,
    vol: VOL_UNITY,
    gate: 8, // eighths of dur (opcodes.md §4)
    pitchCents: 0, // PARAM_SET NOTE_PITCH offset
    currentNote: 60,
    keyed: false,
    ops: Array.from({ length: 4 }, () => ({
      voicedTl: 0,
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
    })),
  };
}

export class DrvPlayer {
  /**
   * @param {function(port:number, addr:number, data:number, when?:number)} writeCallback
   *   Same signature as IRPlayer's: port 0/1 = YM2612 parts, port 2 = PSG
   *   (addr ignored, data = the SN76489 byte).
   */
  constructor(writeCallback) {
    this._writeCb = writeCallback ?? (() => {});
    this._luts = buildLuts();
    this._song = null;
    this._playing = false;
    this._timer = null;
    this._audioContext = null;
    this._startAudioTime = 0;
    this._diagnostics = [];
    this._skippedOpcodes = new Map(); // opcode → count (reserved, not executed)
  }

  // ── Container loading ────────────────────────────────────────────────────
  /** Parse an MMB v0.2 byte buffer. Throws on a malformed container. */
  loadMMB(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 12 || MAGIC.some((m, i) => b[i] !== m)) {
      throw new Error("not an MMB file (bad magic)");
    }
    if (b[4] !== VERSION_MAJOR || b[5] !== VERSION_MINOR) {
      throw new Error(`unsupported MMB version ${b[4]}.${b[5]}`);
    }
    const sectionCount = u16(b, 8);
    const headerSize = u16(b, 10);
    const sections = new Map();
    for (let i = 0; i < sectionCount; i++) {
      const at = headerSize + i * 12;
      const id = u16(b, at);
      const off = u32(b, at + 4);
      const size = u32(b, at + 8);
      if (off + size > b.length) throw new Error(`section ${id} out of bounds`);
      sections.set(id, b.subarray(off, off + size));
    }

    const trackTable = sections.get(SECTION_ID.TRACK_TABLE);
    const stream = sections.get(SECTION_ID.EVENT_STREAM);
    if (!trackTable || !stream) {
      throw new Error("MMB missing TRACK_TABLE or EVENT_STREAM");
    }
    const trackCount = u16(trackTable, 0);
    const tracks = [];
    for (let i = 0; i < trackCount; i++) {
      const at = 2 + i * 5;
      tracks.push({
        trackId: trackTable[at],
        channelId: trackTable[at + 1],
        flags: trackTable[at + 2],
        eventOffset: u16(trackTable, at + 3),
      });
    }

    const valInits = [];
    const valTable = sections.get(SECTION_ID.VAL_TABLE);
    if (valTable) {
      const n = u16(valTable, 0);
      for (let i = 0; i < n; i++) valInits.push(i16(u16(valTable, 2 + i * 2)));
    }

    this._song = { stream, tracks, valInits };
    return this;
  }

  // ── Playback state reset (driver "power-on + START_TRACK all") ──────────
  _reset() {
    const song = this._song;
    this._frame = 0;
    this._increment = bpmToTickIncrement(120); // song increment; TEMPO_SET replaces
    this._diagnostics = [];
    this._skippedOpcodes = new Map();
    this._master = VOL_UNITY;
    this._lfoRate = null;
    this._noiseMode = 4; // white0 — compiler emits an explicit tick-0 set anyway
    this._fm = Array.from({ length: 6 }, freshFmChannel);
    this._psg = Array.from({ length: 4 }, () => ({
      vel: 15,
      vol: VOL_UNITY,
      gate: 8,
      pitchCents: 0,
      currentNote: 60,
      sounding: false,
    }));
    // Hardware shadow for change-only suppression (driver.md §5.4). Key ($28)
    // and raw PSG bytes are edges, not state — they bypass the shadow.
    this._shadow = [new Map(), new Map()]; // per YM port: addr → data
    this._opMasks = new Array(6).fill(0xf0); // UI op-enable mask per channel

    // M2 sweep engine (driver.md §4 step 3). Two concurrent sweep slots per
    // channel (e.g. a pitch glide and a volume fade at once) + one global tempo
    // sweep. Slot: { target, curveId, loop, from, to, len, frame, phase16, step16 }.
    this._sweeps = Array.from({ length: 10 }, () => [null, null]);
    this._tempoSweep = null;

    this._trk = (song?.tracks ?? []).map((t) => ({
      channelId: t.channelId,
      flags: t.flags,
      pc: t.eventOffset,
      acc: 0, // 8.8 fractional accumulator (low byte only is fractional)
      wait: 0, // ticks until the next timed event resumes
      gateLeft: -1, // >0: ticks until scheduled key-off; -1: none
      pendingOff: false, // full-gate key-off awaiting the slur test
      running: true,
      held: false, // len=0 hold: dispatcher suspended
      loops: [], // {resumePc, remaining}
      unsupported: t.channelId >= 16, // fm3-op / pcm tracks: M1 keeps time only
    }));
    for (const t of this._trk) {
      if (t.unsupported) {
        this._diag(
          "W_DRV_CHANNEL_UNSUPPORTED",
          `channel id ${t.channelId} is M2/M3; track keeps time but stays silent`,
        );
      }
    }
    this._emitInitWrites();
  }

  _diag(code, message) {
    this._diagnostics.push({ severity: "warning", code, message });
  }

  // ── Write paths ──────────────────────────────────────────────────────────
  _when() {
    return this._audioContext
      ? this._startAudioTime + this._frame / FRAMES_PER_SEC
      : undefined;
  }
  // YM parameter write, change-only via the shadow file.
  _ym(port, addr, data) {
    const d = data & 0xff;
    if (this._shadow[port].get(addr) === d) return;
    this._shadow[port].set(addr, d);
    this._writeCb(port, addr, d, this._when());
  }
  // YM key register — an edge, always written.
  _ymKey(data) {
    this._writeCb(0, 0x28, data & 0xff, this._when());
  }
  // PSG byte — the SN76489 has no readable state; bytes always go out.
  _psgByte(byte) {
    this._writeCb(2, 0, byte & 0xff, this._when());
  }

  // Neutral power-on patch — the same preamble IRPlayer emits, so tick-0 voice
  // PARAM_SET bursts land on identical baseline state in both players.
  _emitInitWrites() {
    for (let ch = 0; ch < 6; ch++) {
      const port = ch >= 3 ? 1 : 0;
      const off = ch % 3;
      const regs = this._fm[ch];
      this._ym(port, 0xb0 + off, encodeB0(regs));
      this._ym(port, 0xb4 + off, 0xc0);
      for (let slot = 0; slot < 4; slot++) {
        const opOff = OP_ADDR_OFFSET[slot];
        const op = regs.ops[slot];
        this._ym(port, 0x30 + opOff + off, encode30(op));
        this._ym(port, 0x40 + opOff + off, 0);
        this._ym(port, 0x50 + opOff + off, 31);
        this._ym(port, 0x60 + opOff + off, 0);
        this._ym(port, 0x70 + opOff + off, 0);
        this._ym(port, 0x80 + opOff + off, encode80(op));
      }
    }
  }

  // ── Level composition (driver.md §7; integer end-to-end) ────────────────
  _carrierTl(voicedTl, vel, vol) {
    const { velTl4, volTl4 } = this._luts;
    const off4 = velTl4[vel] + volTl4[vol] + volTl4[this._master];
    const tl = voicedTl + ((off4 + (off4 >= 0 ? 2 : -2)) >> 2); // round(off/4)
    return tl < 0 ? 0 : tl > 127 ? 127 : tl;
  }
  _psgAtt(vel, vol) {
    if (vol <= 0 || this._master <= 0) return 15;
    const { velPsg4, volPsg4 } = this._luts;
    const off4 = velPsg4[vel] + volPsg4[vol] + volPsg4[this._master];
    const att = (off4 + (off4 >= 0 ? 2 : -2)) >> 2;
    return att < 0 ? 0 : att > 15 ? 15 : att;
  }

  // ── Pitch (integer LUT + cent interpolation) ─────────────────────────────
  // Returns (block << 11) | fnum for note + cents, interpolating between the
  // two neighbouring semitone entries in (fnum << block) space.
  _fnumBlockFor(note, cents) {
    const { fnumBlock } = this._luts;
    let n = note;
    let c = cents | 0;
    // Fold whole semitones out of the cent offset.
    n += Math.trunc(c / 100);
    c -= Math.trunc(c / 100) * 100;
    if (c < 0) {
      n -= 1;
      c += 100;
    }
    n = n < 0 ? 0 : n > 126 ? 126 : n;
    if (c === 0) return fnumBlock[n];
    const e0 = fnumBlock[n];
    const e1 = fnumBlock[n + 1];
    const v0 = (e0 & 0x7ff) << (e0 >> 11);
    const v1 = (e1 & 0x7ff) << (e1 >> 11);
    const v = v0 + Math.round(((v1 - v0) * c) / 100);
    let block = e0 >> 11;
    let fnum = v >> block;
    while (fnum > 1023 && block < 7) {
      block++;
      fnum = v >> block;
    }
    return ((block & 0x07) << 11) | (fnum & 0x7ff);
  }
  _psgPeriodFor(note, cents) {
    const { psgPeriod } = this._luts;
    let n = note;
    let c = cents | 0;
    n += Math.trunc(c / 100);
    c -= Math.trunc(c / 100) * 100;
    if (c < 0) {
      n -= 1;
      c += 100;
    }
    n = n < 0 ? 0 : n > 126 ? 126 : n;
    if (c === 0) return psgPeriod[n];
    const p = psgPeriod[n] + Math.round(((psgPeriod[n + 1] - psgPeriod[n]) * c) / 100);
    return p < 1 ? 1 : p > 1023 ? 1023 : p;
  }

  _writeFmPitch(ch, note, cents) {
    const port = ch >= 3 ? 1 : 0;
    const off = ch % 3;
    const fb = this._fnumBlockFor(note, cents);
    const block = fb >> 11;
    const fnum = fb & 0x7ff;
    this._ym(port, 0xa4 + off, ((block & 0x07) << 3) | ((fnum >> 8) & 0x07));
    this._ym(port, 0xa0 + off, fnum & 0xff);
  }
  _writePsgPitch(psgCh, note, cents) {
    const period = this._psgPeriodFor(note, cents);
    this._psgByte(0x80 | ((psgCh & 0x03) << 5) | (period & 0x0f));
    this._psgByte((period >> 4) & 0x3f);
  }
  _writePsgAtt(psgCh, att) {
    this._psg[psgCh].sounding = (att & 0x0f) < 15;
    this._psgByte(0x80 | ((psgCh & 0x03) << 5) | 0x10 | (att & 0x0f));
  }
  _writeNoiseCfg() {
    this._psgByte(0x80 | (0x03 << 5) | (this._noiseMode & 0x07));
  }

  // ── Key handling ─────────────────────────────────────────────────────────
  _keyOn(ch) {
    const regs = this._fm[ch];
    const port = ch >= 3 ? 1 : 0;
    const chKey = (port << 2) | (ch % 3);
    // vol/master 0 = hard mute: skip key-on entirely (language.md §6).
    if (regs.vol === 0 || this._master === 0) return;
    regs.keyed = true;
    this._ymKey((this._opMasks?.[ch] ?? 0xf0) | chKey);
  }
  _keyOff(ch) {
    const regs = this._fm[ch];
    const port = ch >= 3 ? 1 : 0;
    const chKey = (port << 2) | (ch % 3);
    if (!regs.keyed) return;
    regs.keyed = false;
    this._ymKey(chKey);
  }
  _channelOff(channelId) {
    if (channelId < 6) this._keyOff(channelId);
    else if (channelId < 10) {
      if (this._psg[channelId - 6].sounding) this._writePsgAtt(channelId - 6, 15);
    }
  }

  // ── NOTE_ON execution ────────────────────────────────────────────────────
  _noteOn(trk, note, dur, exGate) {
    const ch = trk.channelId;
    if (trk.unsupported) return; // fm3-op / pcm: timeline only in M1
    // A new note cancels loop sweeps on this channel (opcodes.md §6: loop
    // sweeps "run until PARAM_SWEEP_STOP / next note"). One-shot sweeps
    // (fades, glide) survive.
    this._cancelLoopSweeps(ch);
    if (ch < 6) {
      const regs = this._fm[ch];
      regs.currentNote = note;
      // Carrier TL from voiced levels + vel/vol/master (every note, so a
      // level change always lands; matches the IR player).
      const port = ch >= 3 ? 1 : 0;
      const off = ch % 3;
      const carriers = fmCarrierOpsForAlg(regs.algorithm);
      for (const opIdx of carriers) {
        const tl = this._carrierTl(regs.ops[opIdx].voicedTl, regs.vel, regs.vol);
        regs.ops[opIdx].tl = tl;
        this._ym(port, 0x40 + OP_ADDR_OFFSET[opIdx] + off, tl);
      }
      this._writeFmPitch(ch, note, regs.pitchCents);
      this._keyOn(ch);
    } else if (ch < 10) {
      const psgCh = ch - 6;
      const st = this._psg[psgCh];
      st.currentNote = note;
      if (psgCh === 3) this._writeNoiseCfg();
      else this._writePsgPitch(psgCh, note, st.pitchCents);
      this._writePsgAtt(psgCh, this._psgAtt(st.vel, st.vol));
    }

    // Gate scheduling (opcodes.md §3.1). exGate: absolute ticks (NOTE_ON_EX);
    // 0 = hold until the host keys off.
    const gate = ch < 6 ? this._fm[ch].gate : ch < 10 ? this._psg[ch - 6].gate : 8;
    if (dur === 0 || exGate === 0) {
      trk.held = true;
      trk.gateLeft = -1;
      return;
    }
    trk.wait = dur;
    if (exGate != null) {
      trk.gateLeft = exGate < dur ? exGate : dur;
      trk.pendingOff = false;
    } else if (gate < 8) {
      trk.gateLeft = Math.max(1, (dur * gate) >> 3);
      trk.pendingOff = false;
    } else {
      // Full gate: key-off at expiry is pending on the slur test.
      trk.gateLeft = -1;
      trk.pendingOff = true;
    }
  }

  // ── Event dispatch: run stream events until a timed event loads `wait` ───
  _dispatch(trk) {
    const s = this._song.stream;
    let guard = 0;
    while (trk.running && !trk.held && guard++ < 4096) {
      const op = s[trk.pc];
      switch (op) {
        case OPCODE.END_OF_TRACK: {
          trk.pendingOff = false;
          this._channelOff(trk.channelId);
          trk.running = false;
          return;
        }
        case OPCODE.NOTE_ON: {
          const note = s[trk.pc + 1];
          const dur = readDuration(s, trk.pc + 2);
          trk.pendingOff = false; // slur: incoming note cancels the key-off
          this._noteOn(trk, note, dur.ticks, null);
          trk.pc = dur.next;
          if (dur.ticks === 0) return; // held
          trk.wait = dur.ticks;
          return;
        }
        case OPCODE.NOTE_ON_EX: {
          let pc = trk.pc + 1;
          const flags = s[pc++];
          const note = s[pc++];
          let exVel = null;
          if (flags & 0b01) exVel = s[pc++];
          const dur = readDuration(s, pc);
          pc = dur.next;
          let exGate = null;
          if (flags & 0b10) {
            const g = readDuration(s, pc);
            exGate = g.ticks;
            pc = g.next;
          }
          trk.pendingOff = false; // slur
          if (exVel != null) this._setLevel(trk.channelId, "vel", exVel);
          this._noteOn(trk, note, dur.ticks, exGate);
          trk.pc = pc;
          if (dur.ticks === 0 || exGate === 0) return; // held
          trk.wait = dur.ticks;
          return;
        }
        case OPCODE.REST: {
          trk.pendingOff = false;
          this._channelOff(trk.channelId);
          const dur = readDuration(s, trk.pc + 1);
          trk.pc = dur.next;
          trk.wait = dur.ticks === 0 ? 1 : dur.ticks; // defensive: no 0 rests
          return;
        }
        case OPCODE.TIE: {
          trk.pendingOff = false; // extension, no retrigger
          const dur = readDuration(s, trk.pc + 1);
          trk.pc = dur.next;
          trk.wait = dur.ticks === 0 ? 1 : dur.ticks;
          return;
        }
        case OPCODE.LOOP_BEGIN: {
          const count = s[trk.pc + 1];
          trk.pc += 2;
          if (trk.loops.length >= LOOP_STACK_DEPTH) {
            this._diag("W_DRV_LOOP_DEPTH", "loop stack overflow; loop ignored");
            break;
          }
          trk.loops.push({ resumePc: trk.pc, remaining: count - 1 });
          break;
        }
        case OPCODE.LOOP_END: {
          const top = trk.loops[trk.loops.length - 1];
          trk.pc += 1;
          if (!top) break;
          if (top.remaining > 0) {
            top.remaining--;
            trk.pc = top.resumePc;
          } else {
            trk.loops.pop();
          }
          break;
        }
        case OPCODE.LOOP_BREAK: {
          const skip = u16(s, trk.pc + 1);
          trk.pc += 3;
          const top = trk.loops[trk.loops.length - 1];
          // Final pass: jump past the LOOP_END and leave the loop.
          if (top && top.remaining === 0) {
            trk.pc += skip;
            trk.loops.pop();
          }
          break;
        }
        case OPCODE.MARKER: {
          trk.pc += 2; // id → mailbox status byte; no register effect
          break;
        }
        case OPCODE.JUMP: {
          // dest is a byte offset relative to the EVENT_STREAM payload start.
          trk.pc = u16(s, trk.pc + 1);
          trk.looped = true;
          break;
        }
        case OPCODE.PARAM_SET: {
          const target = s[trk.pc + 1];
          const w = targetWidth(target);
          const raw = w === 2 ? i16(u16(s, trk.pc + 2)) : i8(s[trk.pc + 2]);
          trk.pc += 2 + w;
          this._paramSet(trk.channelId, target, raw);
          break;
        }
        case OPCODE.TEMPO_SET: {
          this._increment = u16(s, trk.pc + 1);
          trk.pc += 3;
          break;
        }
        // ── M2 motion: sweeps, param-add, tempo sweep ─────────────────────
        case OPCODE.PARAM_SWEEP: {
          const target = s[trk.pc + 1];
          const curve = s[trk.pc + 2];
          const flags = s[trk.pc + 3];
          const from = i16(u16(s, trk.pc + 4));
          const to = i16(u16(s, trk.pc + 6));
          const len = u16(s, trk.pc + 8);
          trk.pc += 10;
          this._startSweep(trk.channelId, target, curve, flags & 1, from, to, len);
          break;
        }
        case OPCODE.PARAM_SWEEP_STOP: {
          const target = s[trk.pc + 1];
          trk.pc += 2;
          this._stopSweep(trk.channelId, target);
          break;
        }
        case OPCODE.PARAM_ADD: {
          const target = s[trk.pc + 1];
          const w = targetWidth(target);
          const delta = w === 2 ? i16(u16(s, trk.pc + 2)) : i8(s[trk.pc + 2]);
          trk.pc += 2 + w;
          this._paramSet(trk.channelId, target, this._readParam(trk.channelId, target) + delta);
          break;
        }
        case OPCODE.TEMPO_SWEEP: {
          const from = u16(s, trk.pc + 1);
          const to = u16(s, trk.pc + 3);
          const len = u16(s, trk.pc + 5);
          const curve = s[trk.pc + 7];
          trk.pc += 8;
          this._tempoSweep = {
            curveId: curve,
            from,
            to,
            len: Math.max(1, len),
            frame: 0,
            phase16: 0,
            step16: sweepStep(len, false),
          };
          break;
        }
        // ── Reserved opcodes: length-decode and skip (M2/M3) ──────────────
        case OPCODE.PARAM_MUL:
          this._skip(trk, op, 4);
          break;
        case OPCODE.PARAM_FROM_VAL:
        case OPCODE.PARAM_ADD_VAL:
        case OPCODE.PARAM_MUL_VAL:
          this._skip(trk, op, 3);
          break;
        case OPCODE.CSM_ON:
        case OPCODE.CSM_OFF:
          this._skip(trk, op, 1);
          break;
        case OPCODE.CSM_RATE:
          this._skip(trk, op, s[trk.pc + 1] === 0 ? 4 : 9);
          break;
        case OPCODE.FM3_MODE:
          this._skip(trk, op, 2);
          break;
        case OPCODE.FM3_OP_PITCH:
          this._skip(trk, op, 3);
          break;
        case OPCODE.PCM_NOTE_ON: {
          // Timed even when skipped: keep the track clock aligned.
          const dur = readDuration(s, trk.pc + 3);
          this._noteSkip(op);
          trk.pc = dur.next;
          trk.wait = dur.ticks === 0 ? 1 : dur.ticks;
          return;
        }
        case OPCODE.PCM_NOTE_OFF:
          this._skip(trk, op, 1);
          break;
        case OPCODE.VOICE_SET:
          this._skip(trk, op, 2);
          break;
        default: {
          this._diag(
            "W_DRV_UNKNOWN_OPCODE",
            `unknown opcode 0x${(op ?? 0).toString(16)} at ${trk.pc}; track stopped`,
          );
          trk.running = false;
          return;
        }
      }
    }
  }

  _skip(trk, op, bytes) {
    trk.pc += bytes;
    this._noteSkip(op);
  }
  _noteSkip(op) {
    this._skippedOpcodes.set(op, (this._skippedOpcodes.get(op) ?? 0) + 1);
  }

  _setLevel(channelId, key, value) {
    if (channelId < 6) this._fm[channelId][key] = value;
    else if (channelId < 10) this._psg[channelId - 6][key] = value;
  }

  // ── PARAM_SET execution (opcodes.md §7 target table) ─────────────────────
  _paramSet(channelId, target, value) {
    const name = TARGET_NAME[target];
    if (!name) {
      this._diag("W_DRV_UNKNOWN_TARGET", `PARAM_SET target 0x${target.toString(16)}`);
      return;
    }
    // Global targets first.
    if (target === TARGET_ID.MASTER) {
      this._master = value < 0 ? 0 : value > 31 ? 31 : value;
      // Re-apply carrier TL on all FM channels; PSG att on sounding channels.
      for (let ch = 0; ch < 6; ch++) {
        const regs = this._fm[ch];
        const port = ch >= 3 ? 1 : 0;
        const off = ch % 3;
        for (const opIdx of fmCarrierOpsForAlg(regs.algorithm)) {
          const tl = this._carrierTl(regs.ops[opIdx].voicedTl, regs.vel, regs.vol);
          regs.ops[opIdx].tl = tl;
          this._ym(port, 0x40 + OP_ADDR_OFFSET[opIdx] + off, tl);
        }
      }
      for (let p = 0; p < 4; p++) {
        if (!this._psg[p].sounding) continue;
        this._writePsgAtt(p, this._psgAtt(this._psg[p].vel, this._psg[p].vol));
      }
      return;
    }
    if (target === TARGET_ID.LFO_RATE) {
      const rate = value < 0 ? 0 : value > 8 ? 8 : value;
      this._lfoRate = rate;
      this._ym(0, 0x22, rate === 0 ? 0x00 : 0x08 | ((rate - 1) & 0x07));
      return;
    }
    if (target === TARGET_ID.NOISE_MODE) {
      this._noiseMode = value & 0x07;
      if (this._psg[3].sounding) this._writeNoiseCfg();
      return;
    }
    if (target === TARGET_ID.VEL) {
      this._setLevel(channelId, "vel", value < 0 ? 0 : value > 15 ? 15 : value);
      return;
    }
    if (target === TARGET_ID.GATE) {
      this._setLevel(channelId, "gate", value < 0 ? 0 : value > 8 ? 8 : value);
      return;
    }

    // PSG-channel targets.
    if (channelId >= 6 && channelId < 10) {
      const psgCh = channelId - 6;
      const st = this._psg[psgCh];
      if (target === TARGET_ID.VOL) {
        st.vol = value < 0 ? 0 : value > 31 ? 31 : value;
        if (st.sounding) this._writePsgAtt(psgCh, this._psgAtt(st.vel, st.vol));
      } else if (target === TARGET_ID.NOTE_PITCH) {
        st.pitchCents = value;
        if (psgCh < 3) this._writePsgPitch(psgCh, st.currentNote, value);
      }
      return;
    }
    if (channelId >= 6) return; // fm3-op/pcm ids: no M1 param path

    // FM-channel targets.
    const ch = channelId;
    const regs = this._fm[ch];
    const port = ch >= 3 ? 1 : 0;
    const off = ch % 3;
    const opFor = (base) => {
      const idx = target - base; // 0..3 → op index
      return { idx, op: regs.ops[idx] };
    };
    switch (true) {
      case target === TARGET_ID.NOTE_PITCH:
        regs.pitchCents = value;
        this._writeFmPitch(ch, regs.currentNote, value);
        return;
      case target === TARGET_ID.VOL: {
        regs.vol = value < 0 ? 0 : value > 31 ? 31 : value;
        for (const opIdx of fmCarrierOpsForAlg(regs.algorithm)) {
          const tl = this._carrierTl(regs.ops[opIdx].voicedTl, regs.vel, regs.vol);
          regs.ops[opIdx].tl = tl;
          this._ym(port, 0x40 + OP_ADDR_OFFSET[opIdx] + off, tl);
        }
        return;
      }
      case target === TARGET_ID.FM_FB:
        regs.feedback = value & 0x07;
        this._ym(port, 0xb0 + off, encodeB0(regs));
        return;
      case target === TARGET_ID.FM_ALG:
        regs.algorithm = value & 0x07;
        this._ym(port, 0xb0 + off, encodeB0(regs));
        return;
      case target === TARGET_ID.FM_AMS:
        regs.ams = value & 0x03;
        this._ym(port, 0xb4 + off, encodeB4(regs));
        return;
      case target === TARGET_ID.FM_FMS:
        regs.fms = value & 0x07;
        this._ym(port, 0xb4 + off, encodeB4(regs));
        return;
      case target === TARGET_ID.PAN:
        regs.pan = value < -1 ? -1 : value > 1 ? 1 : value;
        this._ym(port, 0xb4 + off, encodeB4(regs));
        return;
      case target >= TARGET_ID.FM_TL1 && target <= TARGET_ID.FM_TL4: {
        const { idx, op } = opFor(TARGET_ID.FM_TL1);
        op.voicedTl = value < 0 ? 0 : value > 127 ? 127 : value;
        op.tl = op.voicedTl;
        this._ym(port, 0x40 + OP_ADDR_OFFSET[idx] + off, op.tl);
        return;
      }
      case target >= TARGET_ID.FM_AR1 && target <= TARGET_ID.FM_AR4: {
        const { idx, op } = opFor(TARGET_ID.FM_AR1);
        op.ar = value & 0x1f;
        this._ym(port, 0x50 + OP_ADDR_OFFSET[idx] + off, (op.rs << 6) | op.ar);
        return;
      }
      case target >= TARGET_ID.FM_DR1 && target <= TARGET_ID.FM_DR4: {
        const { idx, op } = opFor(TARGET_ID.FM_DR1);
        op.dr = value & 0x1f;
        this._ym(port, 0x60 + OP_ADDR_OFFSET[idx] + off, encode60(op));
        return;
      }
      case target >= TARGET_ID.FM_SR1 && target <= TARGET_ID.FM_SR4: {
        const { idx, op } = opFor(TARGET_ID.FM_SR1);
        op.d2r = value & 0x1f;
        this._ym(port, 0x70 + OP_ADDR_OFFSET[idx] + off, op.d2r & 0x1f);
        return;
      }
      case target >= TARGET_ID.FM_RR1 && target <= TARGET_ID.FM_RR4: {
        const { idx, op } = opFor(TARGET_ID.FM_RR1);
        op.rr = value & 0x0f;
        this._ym(port, 0x80 + OP_ADDR_OFFSET[idx] + off, encode80(op));
        return;
      }
      case target >= TARGET_ID.FM_SL1 && target <= TARGET_ID.FM_SL4: {
        const { idx, op } = opFor(TARGET_ID.FM_SL1);
        op.sl = value & 0x0f;
        this._ym(port, 0x80 + OP_ADDR_OFFSET[idx] + off, encode80(op));
        return;
      }
      case target >= TARGET_ID.FM_KS1 && target <= TARGET_ID.FM_KS4: {
        const { idx, op } = opFor(TARGET_ID.FM_KS1);
        op.rs = value & 0x03;
        this._ym(port, 0x50 + OP_ADDR_OFFSET[idx] + off, (op.rs << 6) | op.ar);
        return;
      }
      case target >= TARGET_ID.FM_ML1 && target <= TARGET_ID.FM_ML4: {
        const { idx, op } = opFor(TARGET_ID.FM_ML1);
        op.mul = value & 0x0f;
        this._ym(port, 0x30 + OP_ADDR_OFFSET[idx] + off, encode30(op));
        return;
      }
      case target >= TARGET_ID.FM_DT1 && target <= TARGET_ID.FM_DT4: {
        const { idx, op } = opFor(TARGET_ID.FM_DT1);
        op.dt = value; // encode30 handles the sign→register mapping
        this._ym(port, 0x30 + OP_ADDR_OFFSET[idx] + off, encode30(op));
        return;
      }
      case target >= TARGET_ID.FM_SSG1 && target <= TARGET_ID.FM_SSG4: {
        const { idx, op } = opFor(TARGET_ID.FM_SSG1);
        op.ssg = value & 0x0f;
        this._ym(port, 0x90 + OP_ADDR_OFFSET[idx] + off, op.ssg);
        return;
      }
      case target >= TARGET_ID.FM_AMEN1 && target <= TARGET_ID.FM_AMEN4: {
        const { idx, op } = opFor(TARGET_ID.FM_AMEN1);
        op.amen = value & 0x01;
        this._ym(port, 0x60 + OP_ADDR_OFFSET[idx] + off, encode60(op));
        return;
      }
      default:
        // NOTE_SEMI/KEYON/TEMPO_SCALE etc: no M1 register effect.
        this._noteSkip(OPCODE.PARAM_SET);
        return;
    }
  }

  // ── M2 sweep engine (driver.md §4 step 3) ────────────────────────────────
  _startSweep(ch, target, curveId, loop, from, to, len) {
    if (ch >= 10) return; // fm3-op / pcm: no sweep engine in M2 core
    const slots = this._sweeps[ch];
    const slot = {
      target,
      curveId,
      loop: !!loop,
      from,
      to,
      len: Math.max(1, len),
      frame: 0,
      phase16: 0,
      step16: sweepStep(len, loop),
    };
    let idx = slots.findIndex((x) => x && x.target === target);
    if (idx < 0) idx = slots.findIndex((x) => x === null);
    if (idx < 0) {
      idx = 0;
      this._diag("W_DRV_SWEEP_SLOTS", `sweep slot overflow on ch ${ch}; evicted slot 0`);
    }
    slots[idx] = slot;
  }

  _stopSweep(ch, target) {
    if (ch >= 10) return;
    const slots = this._sweeps[ch];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].target === target) slots[i] = null;
    }
  }

  _cancelLoopSweeps(ch) {
    const slots = this._sweeps[ch];
    if (!slots) return;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].loop) slots[i] = null;
    }
  }

  // One sweep slot, one frame. Returns true when a one-shot sweep completes
  // (caller frees the slot). Loop sweeps never complete on their own.
  _processSweep(ch, slot) {
    if (!slot.loop && slot.frame >= slot.len - 1) {
      this._paramSet(ch, slot.target, slot.to); // exact endpoint
      return true;
    }
    const unit = curveUnit8(slot.curveId, slot.phase16 >> 8);
    this._paramSet(ch, slot.target, sweepValue(slot.from, slot.to, unit));
    slot.phase16 = (slot.phase16 + slot.step16) & 0xffff;
    if (!slot.loop) slot.frame++;
    return false;
  }

  _processTempoSweep() {
    const ts = this._tempoSweep;
    if (ts.frame >= ts.len - 1) {
      this._increment = ts.to;
      return true;
    }
    const unit = curveUnit8(ts.curveId, ts.phase16 >> 8);
    this._increment = sweepValue(ts.from, ts.to, unit);
    ts.phase16 = (ts.phase16 + ts.step16) & 0xffff;
    ts.frame++;
    return false;
  }

  // Logical current value of a target, for PARAM_ADD read-modify-write.
  _readParam(ch, target) {
    if (target === TARGET_ID.MASTER) return this._master;
    if (target === TARGET_ID.VOL)
      return ch < 6 ? this._fm[ch].vol : ch < 10 ? this._psg[ch - 6].vol : 31;
    if (target === TARGET_ID.VEL)
      return ch < 6 ? this._fm[ch].vel : ch < 10 ? this._psg[ch - 6].vel : 15;
    if (target === TARGET_ID.GATE)
      return ch < 6 ? this._fm[ch].gate : ch < 10 ? this._psg[ch - 6].gate : 8;
    if (ch < 6) {
      const regs = this._fm[ch];
      if (target === TARGET_ID.NOTE_PITCH) return regs.pitchCents;
      if (target === TARGET_ID.FM_FB) return regs.feedback;
      if (target === TARGET_ID.FM_ALG) return regs.algorithm;
      if (target >= TARGET_ID.FM_TL1 && target <= TARGET_ID.FM_TL4)
        return regs.ops[target - TARGET_ID.FM_TL1].voicedTl;
    } else if (ch < 10 && target === TARGET_ID.NOTE_PITCH) {
      return this._psg[ch - 6].pitchCents;
    }
    return 0;
  }

  // ── The vblank step (driver.md §4, normative order) ──────────────────────
  stepFrame() {
    // 1. Mailbox drain — stub in the reference (all tracks auto-started).
    // 2. Per track, ascending index: accumulate and dispatch.
    for (const trk of this._trk) {
      if (!trk.running || trk.held) continue;
      trk.acc += this._increment;
      while (trk.acc >= 0x100) {
        trk.acc -= 0x100;
        // One tick: gate countdown, then wait countdown / dispatch.
        if (trk.gateLeft > 0) {
          trk.gateLeft--;
          if (trk.gateLeft === 0) {
            this._channelOff(trk.channelId);
            trk.gateLeft = -1;
          }
        }
        if (trk.wait > 0) trk.wait--;
        if (trk.wait === 0) {
          this._dispatch(trk);
          if (!trk.running || trk.held) break;
        }
      }
    }
    // 3. Sweep engines (driver.md §4 step 3): ascending channel, ascending
    //    slot, then the global tempo sweep. Each writes into the shadow.
    for (let ch = 0; ch < 10; ch++) {
      const slots = this._sweeps[ch];
      for (let si = 0; si < slots.length; si++) {
        if (slots[si] && this._processSweep(ch, slots[si])) slots[si] = null;
      }
    }
    if (this._tempoSweep && this._processTempoSweep()) this._tempoSweep = null;
    // 4. Write flush — in this reference, writes go out inline through the
    //    shadow (change-only) in dispatch order, which preserves the same
    //    per-frame final state the batched Z80 flush produces.
    this._frame++;
  }

  // ── Public API (mirrors IRPlayer where the live page touches it) ─────────
  isPlaying() {
    return this._playing;
  }

  play(audioContext) {
    if (!this._song) throw new Error("No MMB loaded");
    this.stop();
    this._audioContext = audioContext ?? null;
    // Anchor the frame clock before _reset so the init writes carry the real
    // start time instead of a stale anchor from a previous run.
    this._startAudioTime = audioContext ? audioContext.currentTime + 0.05 : 0;
    this._reset();
    this._playing = true;
    if (!audioContext) return;
    const LOOKAHEAD = 0.2;
    const tick = () => {
      if (!this._playing) return;
      const now = audioContext.currentTime;
      while (
        this._startAudioTime + this._frame / FRAMES_PER_SEC <
        now + LOOKAHEAD
      ) {
        this.stepFrame();
        if (this._done()) {
          this._playing = false;
          return;
        }
      }
    };
    tick();
    this._timer = setInterval(tick, 25);
  }

  stop() {
    this._playing = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (!this._fm) return; // never reset — nothing was ever written
    // Silence with IMMEDIATE (untimed) writes, every channel unconditionally.
    // Two reasons this must not go through the normal timed path: the driver
    // clock runs up to a lookahead ahead of the audible position, so
    // frame-stamped key-offs would land in the future — and the page flushes
    // the worklet's timed queues right after stop(), which would discard them
    // (the untimed queue survives a flush). Mirrors IRPlayer.stop().
    for (let ch = 0; ch < 6; ch++) {
      const chKey = ((ch >= 3 ? 1 : 0) << 2) | (ch % 3);
      this._writeCb(0, 0x28, chKey);
      this._fm[ch].keyed = false;
    }
    for (let p = 0; p < 4; p++) {
      this._writeCb(2, 0, 0x80 | ((p & 0x03) << 5) | 0x10 | 0x0f);
      if (this._psg?.[p]) this._psg[p].sounding = false;
    }
  }

  _done() {
    return this._trk.every((t) => !t.running || t.held);
  }

  /**
   * Deterministic offline run: step `maxFrames` vblanks (or until every track
   * ends/holds), capturing every write as { frame, port, addr, data }.
   * The same manual-clock idea as IRPlayer.captureRegisterLog, so the two
   * logs can be diffed by ab-compare.js.
   */
  captureRegisterLog({ maxFrames = 36000 } = {}) {
    if (!this._song) throw new Error("No MMB loaded");
    const writes = [];
    const saved = this._writeCb;
    this._writeCb = (port, addr, data) => {
      writes.push({ frame: this._frame, port, addr: addr & 0xff, data: data & 0xff });
    };
    try {
      this._audioContext = null;
      this._reset();
      let frames = 0;
      while (frames < maxFrames) {
        this.stepFrame();
        frames++;
        if (this._done()) break;
      }
      return {
        writes,
        frames,
        ended: this._done(),
        diagnostics: this._diagnostics.slice(),
        skippedOpcodes: Object.fromEntries(
          [...this._skippedOpcodes].map(([op, n]) => [OPCODE_NAME[op] ?? op, n]),
        ),
      };
    } finally {
      this._writeCb = saved;
    }
  }

  /** The constant tables the asm port ships verbatim (driver.md §12). */
  getLuts() {
    return this._luts;
  }

  // ── Live-monitor surface (read-only views of driver state for the UI) ────
  /** Current tempo, for the transport display. Derived from the 8.8 increment. */
  getBpm() {
    return ((this._increment ?? bpmToTickIncrement(120)) * 75) / 512;
  }
  /** FM channel shadow state; same field shape as IRPlayer's chRegs. */
  getChRegs(ch) {
    return this._fm?.[ch] ?? freshFmChannel();
  }
  getOpMask(ch) {
    return this._opMasks?.[ch] ?? 0xf0;
  }
  /** UI op-enable checkboxes; applied at the next key-on. */
  setOpMask(ch, mask) {
    if (this._opMasks && ch >= 0 && ch < 6) this._opMasks[ch] = mask & 0xf0;
  }
}
