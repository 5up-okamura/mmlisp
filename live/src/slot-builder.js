// The 68k → Z80 slot protocol (docs/driver.md §6.2).
//
// This is the single definition of the wire format, shared in spirit by
// drv-player.js (the port spec) and the 68k C that replaces it. Keeping the
// cap-and-spill queue here rather than inside either player is deliberate: the
// interface is part of the spec, not an implementation detail, and the §12.2
// gate compares slot streams.
//
// One slot is one frame:
//
//   [u8 n_writes]                      frame total
//   [u8 n_pcm] [pcm command × n_pcm]   variable length, §6.3, frame-level
//   { [u8 n_psg] [val × n_psg]         SN76489
//     [u8 n_fm0] [{reg,val} × n_fm0]   YM2612 port 0
//     [u8 n_fm1] [{reg,val} × n_fm1] } × SLOT_SUBS (= 1)
//
// The PCM commands are the frame's decisions, resolved to engine addresses by
// the sequencer; the host turns them into state-store pairs ahead of the
// frame's register writes (drv/68k/mmlpairs.c).
//
// Length-prefixed runs so a consumer needs no per-write dispatch. Bucketing by
// port loses cross-bucket ordering within a frame, which is safe by
// construction: the two YM ports address disjoint channels, the PSG is a
// different chip, and everything whose order carries meaning is port-0-local
// (the $28 key edges, the $22/$27/$2B globals, and the $A4→$A0 F-number pair
// whose shared latch driver.md §8 describes). Order within a port is kept, so
// the transport only ever DELAYS a write.

export const SLOT_SIZE = 256;

// Sub-ticks per frame: ONE — note onsets on the 60 Hz frame (driver.md §3.5,
// retired 2026-09-14: the pair engine sent a frame's writes together, so the
// sub-ticks were never heard, and they cost the 68000 ~6 points). Must equal
// MML_SLOT_SUBS in drv/68k/mmlispseq.h. At 1 the format is the single-block one.
export const SLOT_SUBS = 1;

// Bounded by CYCLES, not bytes: the Z80's frame is shared with the PCM mixer,
// and 95 is what the settled mixer configuration leaves (driver.md §5.3.1,
// §6.2). A typical frame emits ~60 writes, so this binds only on voice changes
// and score heads.
export const SLOT_MAX_WRITES = 95;

// PCM voices a slot's commands can name (pcm1-pcm3).
export const PCM_VOICES = 3;

// The PCM commands (driver.md §6.3). Every address is the engine's: a Z80
// window address the sequencer resolved, END and WRAP already rounded to whole
// blocks (live/src/pcm-model.js), so the host only turns them into pairs.
//   PCM_START     voice, shift (8 = mute), src u16, end u16, wrap u16
//   PCM_VOL       voice, shift
//   PCM_RETARGET  voice, end u16, wrap u16 — a loop point moved, or a release
//   PCM_MASTER    shift — voiceless: the host folds it into every voice's level
export const PCM_START = 1;
export const PCM_VOL = 3;
export const PCM_RETARGET = 4;
export const PCM_MASTER = 5;
/** Command lengths by opcode; 0 = not a command. */
export const PCM_LEN = [0, 9, 0, 3, 6, 2];

export class SlotBuilder {
  constructor({ maxWrites = SLOT_MAX_WRITES, slotSize = SLOT_SIZE, subs = SLOT_SUBS } = {}) {
    this._maxWrites = maxWrites;
    this._slotSize = slotSize;
    this._subs = subs;
    this._queue = []; // writes not yet placed in a slot, in emission order
    this._marks = []; // queue depth at each sub-tick boundary — the bucket ends
    this._pcm = [];
    this.spillPeak = 0; // deepest the queue ever got
    this.spillFrames = 0; // frames that could not carry everything
  }

  /** port 0/1 = YM2612 parts, port 2 = PSG (addr ignored, data = the byte). */
  write(port, addr, data) {
    this._queue.push({ port, addr: addr & 0xff, data: data & 0xff });
  }

  /**
   * Close one sub-tick. Everything queued since the last boundary belongs to
   * this sub-slot — including, at sub-tick 0, whatever the previous frame's cap
   * held back, which is why a spilled write leads the frame exactly as before.
   */
  endSub() {
    this._marks.push(this._queue.length);
  }

  /** Append one PCM command (an array of bytes, §6.3). Never capped. */
  pcm(bytes) {
    this._pcm.push(bytes);
  }

  /** Writes still waiting for a slot. */
  get pending() {
    return this._queue.length;
  }

  /**
   * Close the frame and return its slot bytes.
   *
   * The cap is a FRAME total — it bounds the Z80's cycles per frame, not per
   * sub-slot — so the queue is walked once and the buckets fill in order.
   * Excess writes stay queued IN ORDER and lead the next slot, so writes are
   * never dropped and never reordered — the chip state always converges, and
   * the only cost is that a key-on in a write-dense frame can land one frame
   * late. This is the runtime analogue of the armed frame (driver.md §4.2).
   */
  endFrame() {
    // A frame nobody sub-divided (the post-song drain) puts everything it can
    // in sub-slot 0, which is where a spill belongs anyway.
    const marks = [];
    for (let j = 0; j < this._subs; j++) {
      marks.push(Math.min(this._marks[j] ?? this._queue.length, this._queue.length));
    }
    marks[this._subs - 1] = this._queue.length;
    let take = Math.min(this._maxWrites, this._queue.length);
    let bytes;
    // The byte budget can bind before the write budget when PCM commands are
    // dense, so shrink until it fits rather than overflow the slot.
    for (;;) {
      bytes = this._encode(this._queue.slice(0, take), marks);
      if (bytes.length <= this._slotSize || take === 0) break;
      take--;
    }
    if (bytes.length > this._slotSize) {
      throw new Error(
        `slot overflow: ${bytes.length} B of PCM commands alone exceed ${this._slotSize}`,
      );
    }
    this._queue = this._queue.slice(take);
    this._marks = [];
    this._pcm = [];
    if (this._queue.length) {
      this.spillFrames++;
      this.spillPeak = Math.max(this.spillPeak, this._queue.length);
    }
    return bytes;
  }

  _encode(writes, marks) {
    // n_writes leads: the engine charges its pacing pad for the frame's chip
    // writes and needs the total at the frame head, before sub-slots 1..K-1
    // exist on the chips. One byte here replaces the engine tallying every run
    // as it goes, which is why the count is a field and not a derivation.
    const out = [writes.length, this._pcm.length];
    for (const c of this._pcm) out.push(...c);
    let start = 0;
    for (let j = 0; j < this._subs; j++) {
      const end = Math.min(marks[j], writes.length);
      const psg = [];
      const fm0 = [];
      const fm1 = [];
      for (let i = start; i < end; i++) {
        const w = writes[i];
        if (w.port === 2) psg.push(w.data);
        else if (w.port === 1) fm1.push(w.addr, w.data);
        else fm0.push(w.addr, w.data);
      }
      out.push(psg.length, ...psg, fm0.length >> 1, ...fm0, fm1.length >> 1, ...fm1);
      if (end > start) start = end;
    }
    return Uint8Array.from(out);
  }
}

/** Decode a slot back to its runs — used by the gates to state expectations. */
export function decodeSlot(bytes, subs = SLOT_SUBS) {
  let i = 0;
  const nWrites = bytes[i++];
  const pcm = [];
  const npcm = bytes[i++];
  for (let n = npcm; n > 0; n--) {
    const len = PCM_LEN[bytes[i]] ?? 0;
    if (!len) throw new Error(`unknown PCM opcode ${bytes[i]}`);
    pcm.push(Array.from(bytes.slice(i, i + len)));
    i += len;
  }
  const subSlots = [];
  for (let j = 0; j < subs; j++) {
    const psg = [];
    const fm0 = [];
    const fm1 = [];
    for (let n = bytes[i++]; n > 0; n--) psg.push(bytes[i++]);
    for (let n = bytes[i++]; n > 0; n--) fm0.push([bytes[i++], bytes[i++]]);
    for (let n = bytes[i++]; n > 0; n--) fm1.push([bytes[i++], bytes[i++]]);
    subSlots.push({ psg, fm0, fm1 });
  }
  // `subs` is the per-sub-tick view; the flat runs are the frame's whole
  // traffic on each port, in order, for callers that only care about that.
  return {
    nWrites,
    subs: subSlots,
    psg: subSlots.flatMap((s) => s.psg),
    fm0: subSlots.flatMap((s) => s.fm0),
    fm1: subSlots.flatMap((s) => s.fm1),
    pcm,
  };
}
