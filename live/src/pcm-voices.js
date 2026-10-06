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
import { pcmNotePoints, PCM_WINDOW } from "./pcm-model.js";
import { velFine, VEL_FINE, VEL_FINE_MAX } from "./ir-utils.js";


const u16le = (x) => [x & 0xff, (x >> 8) & 0xff];

export function newPcmVoice() {
  return {
    started: false, // a START has been sent since load: PCM_VOL is worth sending
    looping: false, // the running note loops; a note-off sends its release
    keyed: false, // a note is on, up to its note-off: a macro's release waits for it
    retrig: false, // a :keyon step restarts the blob once the frame's levels are in
    src: 0, // the note's blob, as a window address
    len: 0, // …and its length in bytes (whole blocks)
    velBase: VEL_FINE_MAX, // score's sticky velocity; vel is the macro-driven live one
    vel: VEL_FINE_MAX, // per-voice velocity in eighths of a step (0-120); default = unattenuated
    volBase: 31, // score's fader; vol is the macro-driven live one
    vol: 31, // per-voice volume 0-31 (raw); 31 = unity, 0 = hard mute
    shift: 0, // composed attenuation 0..4 from vel+vol; master is folded in by the host
    muted: false, // vol==0, master==0, or shift+master past PCM_TOTAL_MAX_SHIFT
    _sentShift: 0xff,
    // THE NOTE'S FOUR POINTS (language.md §16), in baked bytes from the
    // blob's start, unrounded: the range a note plays and, inside it, the
    // loop a held loop note repeats. Each is a start plus a bound, `kind`
    // saying which the bound is: "END" pins the end, "LEN" keeps the length,
    // so moving only the start slides a range of the same length through the
    // sample. A loop start the def and the track never set follows the
    // range's start (lsSet false), a loop bound never set its end (lKind
    // null). pcm-model.js pcmNotePoints clamps them into each other.
    rs: 0, rKind: "LEN", rBound: 0,
    lsSet: false, ls: 0, lKind: null, lBound: 0,
    // The last END/WRAP sent, so a swept point only costs a RETARGET when it
    // actually leaves its 16-byte block.
    sentEnd: 0, sentWrap: 0, sentPts: false,
    // THE TRACK'S OWN WRITES, sticky like any other track parameter: a note
    // starts from the def's points with these laid over it, so a
    // `:pcm-start` written before the note is the note's.
    oHasRs: false, oRs: 0, oRKind: null, oRBound: 0,
    oHasLs: false, oLs: 0, oLKind: null, oLBound: 0,
  };
}

/** A voice's four points, resolved: [rs, re, ls, le] in baked bytes, unclamped. */
export function pcmVoicePoints(v) {
  const re = v.rKind === "END" ? v.rBound : v.rs + v.rBound;
  const ls = v.lsSet ? v.ls : v.rs;
  const le = v.lKind === "END" ? v.lBound : v.lKind === "LEN" ? ls + v.lBound : re;
  return [v.rs, re, ls, le];
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
  // the FM/PSG 2 dB/step ladder; summing their "steps below unity" — in
  // eighths, as vel is held — gives the attenuation, rounded once to the
  // 6 dB grid:
  //   n = (120−vel) + 8(31−vol);  shift = min(PCM_MAX_SHIFT, round(n/24)).
  // MASTER IS NOT IN HERE — the host folds it into each voice's level page.
  // What master still decides here is the MUTE: `master 0`, `vol 0`, and a
  // total past PCM_TOTAL_MAX_SHIFT are the hard mutes; vel alone never mutes.
  composeShift(vi, master) {
    const v = this.voices[vi];
    const n = VEL_FINE_MAX - v.vel + VEL_FINE * (31 - v.vol);
    const shift = Math.floor((n + 12) / 24); // round(n/24)
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

  // The engine's START/END/WRAP for what the voice plays now: a held loop
  // note from the range's start into its loop; a shot, and a loop note once
  // released, the range once.
  points(v) {
    const [rs, re, ls, le] = pcmVoicePoints(v);
    return pcmNotePoints(v.src, v.len, rs, re, ls, le, v.looping);
  }

  // The live points → the engine's END/WRAP. The pointer is the engine's, so
  // a moved start reaches only the next START.
  applyLoop(vi) {
    const v = this.voices[vi];
    if (!v.started) return;
    const pts = this.points(v);
    this.retarget(vi, pts.end, pts.wrap);
  }

  /**
   * Start a note on voice `vi`. The caller has already restored the velocity
   * and composed the level (composeShift), exactly as the sequencer does.
   * @param entry the note's bank entry (parsePcmBank): its range is the
   *              def's, or the whole sample; its loop the def's, or the range
   * @param src   the blob's window address
   * @param loop  the NOTE loops (`:mode loop`, PCM_NOTE_ON's note bit 7); a
   *              shot plays the range once
   */
  start(vi, entry, src, loop) {
    const v = this.voices[vi];
    v.started = true;
    v.looping = !!loop;
    v.src = src;
    v.bank = Math.floor(entry.base / 0x8000);
    v.len = entry.len;
    // The def's points, with the track's own writes laid over them. A def's
    // bound is a length from the start it pairs with, so a track's start
    // slides it, as a write during the note would (pointParam).
    v.rs = v.oHasRs ? v.oRs : entry.rangeStart;
    if (v.oRKind) { v.rKind = v.oRKind; v.rBound = v.oRBound; }
    else { v.rKind = "LEN"; v.rBound = Math.max(0, entry.rangeEnd - entry.rangeStart); }
    v.lsSet = v.oHasLs || entry.loopStartSet;
    v.ls = v.oHasLs ? v.oLs : entry.loopStart;
    if (v.oLKind) { v.lKind = v.oLKind; v.lBound = v.oLBound; }
    else if (entry.loopEndSet) {
      v.lKind = "LEN";
      v.lBound = Math.max(0, entry.loopEnd - (entry.loopStartSet ? entry.loopStart : entry.rangeStart));
    } else v.lKind = null;
    this.restart(vi);
  }

  // START the voice at the level and points it holds now — a note, and a
  // :keyon retrigger, which after a loop's release plays the range once, as
  // the released note would.
  restart(vi) {
    const v = this.voices[vi];
    if (!v.started) return;
    const pts = this.points(v);
    const byte = this.shiftByte(v);
    this.emit([PCM_START, vi, byte, ...u16le(pts.start), ...u16le(pts.end), ...u16le(pts.wrap)]);
    v._sentShift = byte;
    v.sentEnd = pts.end;
    v.sentWrap = pts.wrap;
    v.sentPts = true;
  }

  // A shot plays to its end regardless (opcodes.md §6). A loop's release
  // moves END to the range's end and WRAP to silence: the tail plays out.
  release(vi) {
    const v = this.voices[vi];
    if (!v.started || !v.looping) return;
    v.looping = false;
    this.applyLoop(vi);
  }

  /**
   * A POINT, as a byte offset into the playing blob (opcodes.md §7).
   * `target` is RANGE_START / RANGE_END / RANGE_LEN (:pcm-*) or LOOP_START /
   * LOOP_END / LOOP_LEN (:loop-*). A …_LEN keeps the length when its start
   * moves; an …_END pins the end. The write is kept for the track's next
   * notes too, and moves the running note's points now.
   */
  pointParam(vi, target, value) {
    const v = this.voices[vi];
    const x = value < 0 ? 0 : value > PCM_WINDOW ? PCM_WINDOW : value;
    const kind = target.endsWith("_END") ? "END" : "LEN";
    if (target === "RANGE_START") { v.oHasRs = true; v.oRs = x; v.rs = x; }
    else if (target === "LOOP_START") { v.oHasLs = true; v.oLs = x; v.lsSet = true; v.ls = x; }
    else if (target.startsWith("RANGE_")) { v.oRKind = v.rKind = kind; v.oRBound = v.rBound = x; }
    else { v.oLKind = v.lKind = kind; v.oLBound = v.lBound = x; }
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
    this.seq = new PcmVoices(c => {
      if (bank.multibank && c[0] === PCM_START) {
        const b = this.seq.voices[c[1]].bank;
        c = [6, ...c.slice(1), b & 255, b >> 8];
      }
      emit(c);
    });
    this.bank = bank;
    this.master = 31;
    /** The track each voice last played, for the editor's per-track faders. */
    this.voiceTrack = new Array(PCM_VOICES).fill(null);
  }

  /** One event: {kind: on|off|retrig|vol|vel|master|point, voice, …}. vel is
   *  the score's, in steps; the voice holds it in eighths, as the driver. A
   *  retrig carries its frame's level steps as `vel` / `vol`. */
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
        // driver's note-on restores (restore_level_base).
        v.vel = v.velBase = velFine(ev.vel ?? 15) * VEL_FINE;
        // A note starts from its :vol macro's first sample, else the fader
        // (driver: restore_level_base).
        v.vol = ev.vol != null ? clamp(Number(ev.vol), 31) : v.volBase;
        v.started = false; // the START carries the level (driver: pcm_note_on)
        seq.composeShift(vi, this.master);
        this.voiceTrack[vi] = ev.track ?? null;
        seq.start(vi, entry, PCM_WINDOW + (entry.base & 0x7fff), ev.mode === "loop");
        return true;
      }
      case "off":
        if (v) seq.release(vi);
        break;
      case "retrig": { // a :keyon step: the blob again from its start
        if (!v) return false;
        // The frame's level steps ride along; the START carries them.
        const started = v.started;
        v.started = false;
        if (ev.vel != null) v.vel = velFine(ev.vel) * VEL_FINE;
        if (ev.vol != null) v.vol = clamp(Number(ev.vol), 31);
        seq.composeShift(vi, this.master);
        v.started = started;
        seq.restart(vi);
        break;
      }
      case "vol":
        if (!v) return false;
        v.vol = clamp(Number(ev.value), 31);
        if (!ev.macro) v.volBase = v.vol; // a macro moves only the live level
        seq.composeShift(vi, this.master);
        break;
      case "vel":
        if (!v) return false;
        v.vel = v.velBase = velFine(ev.value) * VEL_FINE;
        seq.composeShift(vi, this.master);
        break;
      case "master":
        this.master = clamp(Number(ev.value), 31);
        seq.setMaster(this.master);
        break;
      case "point":
        if (v) seq.pointParam(vi, ev.target, Number(ev.value));
        break;
    }
    return false;
  }
}
