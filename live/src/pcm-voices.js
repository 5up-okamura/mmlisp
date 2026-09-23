// The sequencer's side of the three PCM voices — the note model the driver's
// 68000 runs (drv/68k/mmlispseq.c pcm_*), in one place for every JS consumer:
//
//   drv-player.js   the reference driver, gated byte for byte against the C
//                   (npm run c-gate): its slots carry exactly these commands
//   ir-player.js    the browser's IR playback: the same commands, sent to the
//                   worklet's PcmLiveEngine, so a score previews with the
//                   driver's levels, loop rounding and loop-point moves (D0)
//
// It owns no timing and no bank: a caller resolves the note to its blob and
// says when. Everything it decides comes out as a slot-format PCM command
// (driver.md §6.2) through `emit`:
//
//   [PCM_START, v, shift, src u16, end u16, wrap u16]
//   [PCM_VOL, v, shift]           [PCM_RETARGET, v, end u16, wrap u16]
//   [PCM_MASTER, masterShift]
//
// `shift` is 0..4 or 8 (mute); the host folds the master into the page.
import {
  PCM_MAX_SHIFT,
  PCM_MASTER_MAX_SHIFT,
  PCM_TOTAL_MAX_SHIFT,
} from "./mmb.js";
import { PCM_START, PCM_VOL, PCM_RETARGET, PCM_MASTER, PCM_VOICES } from "./slot-builder.js";
import { pcmLoopPoints, pcmShotPoints, PCM_WINDOW } from "./pcm-model.js";


const u16le = (x) => [x & 0xff, (x >> 8) & 0xff];

export function newPcmVoice() {
  return {
    started: false, // a START has been sent since load: PCM_VOL is worth sending
    looping: false, // the running note loops; a note-off sends its release
    src: 0, // the note's blob, as a window address
    len: 0, // …and its length in bytes (whole blocks)
    velBase: 15, // score's sticky velocity; vel is the macro-driven live one
    vel: 15, // per-voice velocity 0-15 (raw); default = unattenuated
    vol: 31, // per-voice volume 0-31 (raw); 31 = unity, 0 = hard mute
    shift: 0, // composed attenuation 0..4 from vel+vol; master is folded in by the host
    muted: false, // vol==0, master==0, or shift+master past PCM_TOTAL_MAX_SHIFT
    _sentShift: 0xff,
    // THE LIVE LOOP, in baked bytes from the blob's start, unrounded — the
    // note's own points until a LOOP_START/LOOP_END/LOOP_LEN param moves
    // them. The length sits beside the end so that moving only the start
    // slides a loop of the same length through the sample; :loop-end pins
    // the end instead and sets endFixed.
    ls: 0, le: 0, llen: 0, endFixed: false,
    // The last END/WRAP sent, so a swept loop point only costs a RETARGET
    // when it actually leaves its 16-byte block.
    sentEnd: 0, sentWrap: 0, sentPts: false,
    // THE TRACK'S OWN LOOP WRITES, sticky like any other track parameter: a
    // loop note starts from the def's loop with these laid over it, so a
    // `:loop-start` written before the note is the note's. `oBound` is the
    // last of :loop-end / :loop-len written (oKind "END" | "LEN" | null).
    oHasLs: false, oLs: 0, oKind: null, oBound: 0,
  };
}

export class PcmVoices {
  /** @param {(cmd: number[]) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.voices = Array.from({ length: PCM_VOICES }, newPcmVoice);
    // Master's own shift, and the last one sent. The engine boots at unity, so
    // 0 is what it already has: a score that merely restates `master 31` must
    // emit nothing.
    this.masterShift = 0;
    this.sentMaster = 0;
  }

  // MUTE (8) is the sequencer's: the host sends the silence page for it.
  shiftByte(v) {
    return v.muted ? 8 : v.shift;
  }

  // Compose a voice's attenuation from vel + vol (driver.md §14.1). Both ride
  // the FM/PSG 2 dB/step ladder; summing their "steps below unity" gives the
  // attenuation, quantized to the 6 dB grid:
  //   n = (15−vel) + (31−vol);  shift = min(PCM_MAX_SHIFT, round(n/3)).
  // MASTER IS NOT IN HERE — the host folds it into each voice's level page.
  // What master still decides here is the MUTE: `master 0`, `vol 0`, and a
  // total past PCM_TOTAL_MAX_SHIFT are the hard mutes; vel alone never mutes.
  composeShift(vi, master) {
    const v = this.voices[vi];
    const n = 15 - v.vel + (31 - v.vol);
    const shift = Math.floor((n + 1) / 3); // round(n/3)
    v.shift = shift > PCM_MAX_SHIFT ? PCM_MAX_SHIFT : shift;
    v.muted = v.vol === 0 || master === 0
      || v.shift + this.masterShift >= PCM_TOTAL_MAX_SHIFT;
    const byte = this.shiftByte(v);
    // A voice that has never started has no level to change: its START carries it.
    if (v.started && byte !== v._sentShift) {
      v._sentShift = byte;
      this.emit([PCM_VOL, vi, byte]);
    }
  }

  // Master's own shift, on the same 6 dB grid and its own deeper ceiling.
  // Emitted only when the SHIFT moves, not when master does.
  composeMaster(master) {
    const n = 31 - master;
    const shift = Math.floor((n + 1) / 3); // round(n/3)
    this.masterShift = shift > PCM_MASTER_MAX_SHIFT ? PCM_MASTER_MAX_SHIFT : shift;
    if (this.masterShift !== this.sentMaster) {
      this.sentMaster = this.masterShift;
      this.emit([PCM_MASTER, this.masterShift]);
    }
  }

  // A MASTER change: master rides the SUM, so the voices' shifts do not move —
  // but the master shift does, and it decides their mute, so both are
  // recomposed and in that order (the mute reads the new master shift).
  setMaster(master) {
    this.composeMaster(master);
    for (let vi = 0; vi < PCM_VOICES; vi++) this.composeShift(vi, master);
  }

  // Send END/WRAP, but only when they actually moved. A swept loop point is
  // recomputed every frame and mostly lands inside the same 16-byte block; an
  // unguarded RETARGET would spend six bytes of the slot on it sixty times a
  // second, starving the register writes it shares the slot with.
  retarget(vi, end, wrap) {
    const v = this.voices[vi];
    if (v.sentPts && end === v.sentEnd && wrap === v.sentWrap) return;
    this.emit([PCM_RETARGET, vi, ...u16le(end), ...u16le(wrap)]);
    v.sentEnd = end;
    v.sentWrap = wrap;
    v.sentPts = true;
  }

  // The live loop points → the engine's END/WRAP. A released voice is a shot
  // from here on, so its loop params stop having an effect — which is what a
  // release means.
  applyLoop(vi) {
    const v = this.voices[vi];
    if (!v.started) return;
    const pts = v.looping
      ? pcmLoopPoints(v.src, v.len, v.ls, v.le)
      : pcmShotPoints(v.src, v.len);
    this.retarget(vi, pts.end, pts.wrap);
  }

  /**
   * Start a note on voice `vi`. The caller has already restored the velocity
   * and composed the level (composeShift), exactly as the sequencer does.
   * @param entry {len, loopStart, loopEnd} — the note's bank entry; its loop is
   *              the def's, or the whole sample when the def has none
   * @param src   the blob's window address
   * @param loop  the NOTE loops (`:mode loop`, PCM_NOTE_ON's note bit 7); a
   *              shot plays once whatever the def says
   */
  start(vi, entry, src, loop) {
    const v = this.voices[vi];
    v.started = true;
    v.looping = !!loop;
    v.src = src;
    v.len = entry.len;
    // The def's loop, with the track's own writes laid over it in the same
    // terms a write during the note uses (loopParam).
    v.ls = v.oHasLs ? v.oLs : entry.loopStart;
    if (v.oKind === "END") {
      v.le = v.oBound;
      v.endFixed = true;
      v.llen = v.le > v.ls ? v.le - v.ls : 0;
    } else {
      v.llen = v.oKind === "LEN" ? v.oBound
        : entry.loopEnd > entry.loopStart ? entry.loopEnd - entry.loopStart : 0;
      v.le = v.ls + v.llen;
      v.endFixed = false;
    }
    const pts = v.looping
      ? pcmLoopPoints(v.src, entry.len, v.ls, v.le)
      : pcmShotPoints(v.src, entry.len);
    const byte = this.shiftByte(v);
    this.emit([PCM_START, vi, byte, ...u16le(v.src), ...u16le(pts.end), ...u16le(pts.wrap)]);
    v._sentShift = byte;
    v.sentEnd = pts.end;
    v.sentWrap = pts.wrap;
    v.sentPts = true;
  }

  // A shot plays to its end regardless (opcodes.md §6). A loop's release
  // moves END to the sample's end and WRAP to silence: the tail plays out.
  release(vi) {
    const v = this.voices[vi];
    if (!v.started || !v.looping) return;
    v.looping = false;
    this.applyLoop(vi);
  }

  /**
   * THE LOOP POINTS, as byte offsets into the playing blob (opcodes.md §7).
   * `which` is "START" | "END" | "LEN". :loop-len keeps the length when the
   * start moves; :loop-end pins the end. The write is kept for the track's
   * next notes too, and moves the running note's loop now.
   */
  loopParam(vi, which, value) {
    const v = this.voices[vi];
    const x = value < 0 ? 0 : value > PCM_WINDOW ? PCM_WINDOW : value;
    if (which === "START") { v.oHasLs = true; v.oLs = x; } else { v.oKind = which; v.oBound = x; }
    if (which === "START") {
      v.ls = x;
      if (!v.endFixed) v.le = v.ls + v.llen;
    } else if (which === "END") {
      v.le = x;
      v.endFixed = true;
      v.llen = v.le > v.ls ? v.le - v.ls : 0;
    } else {
      v.llen = x;
      v.endFixed = false;
      v.le = v.ls + v.llen;
    }
    this.applyLoop(vi);
  }
}

// ── The IR preview's side ─────────────────────────────────────────────────
// The browser's IR playback sends the score's PCM events (ir-player.js
// _dispatchPcmEvent) to the worklet, which applies them here, in time order,
// against the bank an export would ship: the same calls drv-player makes for
// the MMB's opcodes. drv/tools/pcm-ab-gate.mjs runs this very class against
// drv-player's own command stream.
export class PcmIrVoices {
  /**
   * @param emit  (cmd: number[]) => void — the engine's command input
   * @param bank  {entries, entryIds}: parsePcmBank(bank).entries and the
   *              exporter's `${sample}|${midi}` → entry id map
   */
  constructor(emit, bank) {
    this.seq = new PcmVoices(emit);
    this.bank = bank;
    this.master = 31;
    /** The track each voice last played, for the editor's per-track faders. */
    this.voiceTrack = new Array(PCM_VOICES).fill(null);
  }

  /** One event: {kind: on|off|vol|vel|master|loop, voice, …}. */
  apply(ev) {
    const seq = this.seq;
    const vi = Number(ev.voice);
    const v = seq.voices[vi];
    const clamp = (x, hi) => (x < 0 ? 0 : x > hi ? hi : Math.round(x));
    switch (ev.kind) {
      case "on": {
        if (!v) return false;
        const id = this.bank.entryIds[`${ev.sample}|${ev.midi}`];
        const entry = id == null ? null : this.bank.entries[id];
        if (!entry || entry.len === 0) return false;
        // vel rides the note: the exporter sends it as the sticky VEL the
        // driver's note-on restores (restore_vel_base).
        v.vel = v.velBase = clamp(Number(ev.vel ?? 15), 15);
        seq.composeShift(vi, this.master);
        this.voiceTrack[vi] = ev.track ?? null;
        seq.start(vi, entry, PCM_WINDOW + (entry.base & 0x7fff), ev.mode === "loop");
        return true;
      }
      case "off":
        if (v) seq.release(vi);
        break;
      case "vol":
        if (!v) return false;
        v.vol = clamp(Number(ev.value), 31);
        seq.composeShift(vi, this.master);
        break;
      case "vel":
        if (!v) return false;
        v.vel = v.velBase = clamp(Number(ev.value), 15);
        seq.composeShift(vi, this.master);
        break;
      case "master":
        this.master = clamp(Number(ev.value), 31);
        seq.setMaster(this.master);
        break;
      case "loop":
        if (v) seq.loopParam(vi, ev.which, Number(ev.value));
        break;
    }
    return false;
  }
}
