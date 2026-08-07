// The 68k → Z80 slot protocol (docs/driver.md §6.2).
//
// This is the single definition of the wire format, shared in spirit by
// drv-player.js (the port spec) and the 68k C that replaces it. Keeping the
// cap-and-spill queue here rather than inside either player is deliberate: the
// interface is part of the spec, not an implementation detail, and the §12.2
// gate compares slot streams.
//
// One slot is one frame, subdivided into SLOT_SUBS sub-slots:
//
//   [u8 n_writes]                      frame total, for the engine's pacing debt
//   [u8 n_pcm] [pcm command × n_pcm]   variable length, §6.3, frame-level
//   { [u8 n_seg] [ticks × n_seg] } × 3 the frame's SEGMENT PLAN, one run per
//                                      PCM voice, §6.3.1
//   { [u8 n_psg] [val × n_psg]         SN76489
//     [u8 n_fm0] [{reg,val} × n_fm0]   YM2612 port 0
//     [u8 n_fm1] [{reg,val} × n_fm1] } × SLOT_SUBS
//
// The frame-level fields lead, and that ordering is load-bearing: the engine
// needs both of them at the frame head — the PCM commands before it mixes, the
// write count before it sizes the frame's pad (driver.md §5.1) — while sub-slots
// 1..K-1 are not consumed until a third and two thirds of the way in. Putting
// them last would make the engine walk past every sub-slot to reach them, and
// tally the runs itself, which measured ~1,700 cycles a frame.
//
// The segment plan is the sequencer telling the engine where each voice's mix
// has to break this frame. The sequencer already advances every voice's
// position tick by tick (it needs that for its own decisions), so the boundary
// list is a by-product of work already done — while on the Z80 deriving it cost
// a 16-bit min, a shift loop and, near a boundary, a tick-by-tick walk, at a
// cost that varied by an order of magnitude frame to frame. That VARIANCE was
// the problem: the pacing pad is sized from an estimate of the frame's
// overhead (§5.1), and an overhead that moves is a feed that stutters.
//
// A run is the ticks from one LOGICAL boundary to the next — a loop wrap or the
// end of a sample. ROM window crossings are not in it: they are the engine's
// own business (it owns the bank) and they do not consume a run. The last entry
// of a still-sounding voice is the frame's whole mix chunk, meaning "no further
// boundary in it"; a voice that ends needs no such sentinel, and a silent
// voice's run is empty.
//
// Length-prefixed runs so the Z80's consume loop needs no per-write dispatch.
// Bucketing by port loses cross-bucket ordering within a frame, which is safe
// by construction: the two YM ports address disjoint channels, the PSG is a
// different chip, and everything whose order carries meaning is port-0-local
// (the $28 key edges, the $22/$27/$2A/$2B globals, and the $A4→$A0 F-number
// pair whose shared latch driver.md §8 describes).
//
// The sub-slots are the frame's SUB-TICKS (driver.md §3.5): the engine puts
// sub-slot 0 out at the frame head and the rest at the mixer's voice-pass
// boundaries, which already sit at 1/3 and 2/3 of a paced frame. Order within
// a port is preserved across the whole frame — the buckets are filled in
// emission order — so the transport still only ever DELAYS a write.

export const SLOT_SIZE = 256;

// Sub-ticks per frame. A build constant, and it must equal the engine's
// PACE_PASSES: the boundaries the Z80 consumes on are the mixer's voice-pass
// boundaries, and there are exactly PCM_VOICES of those. SLOT_SUBS = 1 collapses
// the format back to the single-block one and is byte-identical to it.
export const SLOT_SUBS = 2;

// Bounded by CYCLES, not bytes: the Z80's frame is shared with the PCM mixer,
// and 95 is what the settled mixer configuration leaves (driver.md §5.3.1,
// §6.2). A typical frame emits ~60 writes, so this binds only on voice changes
// and score heads.
export const SLOT_MAX_WRITES = 95;

// PCM voices, and therefore segment-plan runs per slot. A build constant on
// both sides (the engine's PCM_VOICES).
export const PCM_VOICES = 2;

export const PCM_START = 1;
export const PCM_STOP = 2;
export const PCM_VOL = 3;
export const PCM_LOOP = 4;

export class SlotBuilder {
  constructor({ maxWrites = SLOT_MAX_WRITES, slotSize = SLOT_SIZE, subs = SLOT_SUBS } = {}) {
    this._maxWrites = maxWrites;
    this._slotSize = slotSize;
    this._subs = subs;
    this._queue = []; // writes not yet placed in a slot, in emission order
    this._marks = []; // queue depth at each sub-tick boundary — the bucket ends
    this._pcm = [];
    this._plan = null;
    this._chunk = 0;   // samples the engine mixes this frame; 0 = a prime frame
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

  /**
   * The frame's segment plan (§6.3.1): PCM_VOICES count-prefixed runs, already
   * flattened. A frame that never calls this — no PCM in the score, or a frame
   * the mixer skipped entirely — encodes empty runs, which is what a slot with
   * nothing sounding says anyway.
   */
  plan(bytes) {
    this._plan = bytes;
  }

  /**
   * How many samples the engine mixes this frame (§5.1.2). The plan's tick
   * distances are measured against it, so the engine cannot derive it — it has
   * to be told, or a starved frame would desync the two.
   *
   * 0 means a PRIME frame: mix PCM_RING_TARGET and feed nothing. That encoding
   * is what keeps the field one byte, since the lead does not fit in one.
   */
  chunk(samples) {
    this._chunk = samples;
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
    // dense (three PCM_STARTs are 54 bytes), so shrink until it fits rather
    // than overflow the slot.
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
    this._plan = null;
    this._chunk = 0;
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
    const out = [writes.length, this._chunk ?? 0, this._pcm.length];
    for (const c of this._pcm) out.push(...c);
    // The plan rides the head with the PCM commands: the engine wants both
    // before it mixes, and the plan is per-voice-pass, so it is read the moment
    // a pass starts.
    out.push(...(this._plan ?? new Array(PCM_VOICES).fill(0)));
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
  const chunk = bytes[i++];
  const pcm = [];
  const npcm = bytes[i++];
  const LEN = { [PCM_START]: 18, [PCM_STOP]: 2, [PCM_VOL]: 3, [PCM_LOOP]: 6 };
  for (let n = npcm; n > 0; n--) {
    const len = LEN[bytes[i]];
    if (!len) throw new Error(`unknown PCM opcode ${bytes[i]}`);
    pcm.push(Array.from(bytes.slice(i, i + len)));
    i += len;
  }
  const plan = [];
  for (let v = 0; v < PCM_VOICES; v++) {
    const n = bytes[i++];
    plan.push(Array.from(bytes.slice(i, i + n)));
    i += n;
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
    chunk,
    subs: subSlots,
    psg: subSlots.flatMap((s) => s.psg),
    fm0: subSlots.flatMap((s) => s.fm0),
    fm1: subSlots.flatMap((s) => s.fm1),
    pcm,
    plan,
  };
}
