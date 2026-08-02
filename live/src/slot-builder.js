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
//   [u8 n_psg] [val × n_psg]           SN76489
//   [u8 n_fm0] [{reg,val} × n_fm0]     YM2612 port 0
//   [u8 n_fm1] [{reg,val} × n_fm1]     YM2612 port 1
//   [u8 n_pcm] [pcm command × n_pcm]   variable length, §6.3
//
// Length-prefixed runs so the Z80's consume loop needs no per-write dispatch.
// Bucketing by port loses cross-bucket ordering within a frame, which is safe
// by construction: the two YM ports address disjoint channels, the PSG is a
// different chip, and everything whose order carries meaning is port-0-local
// (the $28 key edges, the $22/$27/$2A/$2B globals, and the $A4→$A0 F-number
// pair whose shared latch driver.md §8 describes).

export const SLOT_SIZE = 256;

// Bounded by CYCLES, not bytes: the Z80's frame is shared with the PCM mixer,
// and 95 is what the settled mixer configuration leaves (driver.md §5.3.1,
// §6.2). A typical frame emits ~60 writes, so this binds only on voice changes
// and score heads.
export const SLOT_MAX_WRITES = 95;

export const PCM_START = 1;
export const PCM_STOP = 2;
export const PCM_VOL = 3;
export const PCM_LOOP = 4;

export class SlotBuilder {
  constructor({ maxWrites = SLOT_MAX_WRITES, slotSize = SLOT_SIZE } = {}) {
    this._maxWrites = maxWrites;
    this._slotSize = slotSize;
    this._queue = []; // writes not yet placed in a slot, in emission order
    this._pcm = [];
    this.spillPeak = 0; // deepest the queue ever got
    this.spillFrames = 0; // frames that could not carry everything
  }

  /** port 0/1 = YM2612 parts, port 2 = PSG (addr ignored, data = the byte). */
  write(port, addr, data) {
    this._queue.push({ port, addr: addr & 0xff, data: data & 0xff });
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
   * Excess writes stay queued IN ORDER and lead the next slot, so writes are
   * never dropped and never reordered — the chip state always converges, and
   * the only cost is that a key-on in a write-dense frame can land one frame
   * late. This is the runtime analogue of the armed frame (driver.md §4.2).
   */
  endFrame() {
    let take = Math.min(this._maxWrites, this._queue.length);
    let bytes;
    // The byte budget can bind before the write budget when PCM commands are
    // dense (three PCM_STARTs are 54 bytes), so shrink until it fits rather
    // than overflow the slot.
    for (;;) {
      bytes = this._encode(this._queue.slice(0, take));
      if (bytes.length <= this._slotSize || take === 0) break;
      take--;
    }
    if (bytes.length > this._slotSize) {
      throw new Error(
        `slot overflow: ${bytes.length} B of PCM commands alone exceed ${this._slotSize}`,
      );
    }
    this._queue = this._queue.slice(take);
    this._pcm = [];
    if (this._queue.length) {
      this.spillFrames++;
      this.spillPeak = Math.max(this.spillPeak, this._queue.length);
    }
    return bytes;
  }

  _encode(writes) {
    const psg = [];
    const fm0 = [];
    const fm1 = [];
    for (const w of writes) {
      if (w.port === 2) psg.push(w.data);
      else if (w.port === 1) fm1.push(w.addr, w.data);
      else fm0.push(w.addr, w.data);
    }
    const out = [psg.length, ...psg, fm0.length >> 1, ...fm0, fm1.length >> 1, ...fm1];
    out.push(this._pcm.length);
    for (const c of this._pcm) out.push(...c);
    return Uint8Array.from(out);
  }
}

/** Decode a slot back to its runs — used by the gates to state expectations. */
export function decodeSlot(bytes) {
  let i = 0;
  const psg = [];
  const fm0 = [];
  const fm1 = [];
  const pcm = [];
  for (let n = bytes[i++]; n > 0; n--) psg.push(bytes[i++]);
  for (let n = bytes[i++]; n > 0; n--) fm0.push([bytes[i++], bytes[i++]]);
  for (let n = bytes[i++]; n > 0; n--) fm1.push([bytes[i++], bytes[i++]]);
  const npcm = bytes[i++];
  const LEN = { [PCM_START]: 18, [PCM_STOP]: 2, [PCM_VOL]: 3, [PCM_LOOP]: 6 };
  for (let n = npcm; n > 0; n--) {
    const len = LEN[bytes[i]];
    if (!len) throw new Error(`unknown PCM opcode ${bytes[i]}`);
    pcm.push(Array.from(bytes.slice(i, i + len)));
    i += len;
  }
  return { psg, fm0, fm1, pcm };
}
